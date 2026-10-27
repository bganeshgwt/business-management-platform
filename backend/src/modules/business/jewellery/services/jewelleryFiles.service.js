const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const config = require('../../../../config/env');
const AppError = require('../../../../utils/AppError');
const c = require('./jewelleryCommon');

// A piece's photo and a custom order's design (module "jewellery"): a photo
// (JPG, PNG or WebP, up to 5 MB) kept in jewellery/<business>/ of the private
// uploads folder (PRIVATE_UPLOADS_DIR; config/env.js) under a generated name,
// and only ever sent through the API to someone who may see the pieces. The
// bytes are checked: a renamed file is refused. A piece has one photo: a new
// one takes the old one off (kept, never deleted).

const { fail, id } = c;
const ROOT = path.join(config.privateUploadsDir, 'jewellery');
const MAX_BYTES = 5 * 1024 * 1024;
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], also: [0x57, 0x45, 0x42, 0x50] },
];
const sniff = (buffer) => SIGNATURES.find((s) => buffer.length >= 12 && s.bytes.every((b, i) => buffer[i] === b) && (!s.also || s.also.every((b, i) => buffer[8 + i] === b))) || null;
const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));

const uploadOne = (req, res, next) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('file')(req, res, (error) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') return next(new AppError(400, 'That photo is larger than 5 MB. Take it again at a lower size.'));
    if (error && error.code && String(error.code).startsWith('LIMIT_')) return next(new AppError(400, 'Add one photo at a time.'));
    return next(error);
  });

// fields: { pieceId } (the piece's photo, with jewellery.edit) or { orderId } (the order's design, with jewellery.create).
async function add(business, user, fields, file) {
  c.requireJewellery(business);
  const pieceId = c.given(fields?.pieceId) ? id(fields.pieceId, 'Piece') : null;
  const orderId = c.given(fields?.orderId) ? id(fields.orderId, 'Custom order') : null;
  if (Boolean(pieceId) === Boolean(orderId)) fail('Add the photo to a piece or to a custom order');
  await access.require(business, pieceId ? 'jewellery.edit' : 'jewellery.create');
  if (!file) fail('Choose a photo');
  const found = sniff(file.buffer);
  if (!found) fail('Only a photo (JPG, PNG or WebP) can be added');
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${found.ext}`;
  const dir = dirOf(business.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, storedName);
  fs.writeFileSync(full, file.buffer, { flag: 'wx' });
  try {
    return await repo.transaction(async (db) => {
      await c.lockBusiness(db, business);
      if (pieceId) {
        const piece = await repo.one(db, 'SELECT id,tag_no,status FROM jewellery_pieces WHERE business_id=$1 AND id=$2', [business.id, pieceId]);
        if (!piece) fail('Piece not found', 404);
        if (!['in_stock', 'on_approval', 'at_karigar', 'at_centre'].includes(piece.status)) fail(`Piece ${piece.tag_no} has left the shop and keeps what it was`, 409);
      } else {
        const order = await repo.one(db, 'SELECT id,order_no,status,location_id FROM jewellery_orders WHERE business_id=$1 AND id=$2', [business.id, orderId]);
        if (!order) fail('Custom order not found', 404);
        access.requireLocation(business, order.location_id);
        if (['delivered', 'cancelled'].includes(order.status)) fail(`Order ${order.order_no} is ${order.status} and keeps what it was`, 409);
      }
      const fileName = String(file.originalname || `photo.${found.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 150) || `photo.${found.ext}`;
      // One photo a piece (and one design an order): a new one takes the old one off.
      await db.query(`UPDATE jewellery_files SET removed_at=now(),removed_by=$4 WHERE business_id=$1 AND removed_at IS NULL AND (piece_id=$2 OR order_id=$3)`,
        [business.id, pieceId, orderId, user.id]);
      const row = await repo.one(db, `INSERT INTO jewellery_files(business_id,kind,piece_id,order_id,stored_name,file_name,mime_type,size_bytes,uploaded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,kind,piece_id,order_id,file_name,mime_type,size_bytes,created_at`,
      [business.id, pieceId ? 'photo' : 'design', pieceId, orderId, storedName, fileName, found.mime, file.size, user.id]);
      await repo.audit(db, business.id, user.id, pieceId ? 'jewellery_piece.photo_added' : 'jewellery_order.design_added', pieceId || orderId, { file: fileName });
      return row;
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

// The photo itself, to someone who may see the pieces.
async function open(business, fileId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  const file = await repo.one(repo.pool, 'SELECT * FROM jewellery_files WHERE business_id=$1 AND id=$2', [business.id, id(fileId, 'Photo')]);
  if (!file) fail('Photo not found', 404);
  const full = path.join(dirOf(business.id), file.stored_name);
  if (!fs.existsSync(full)) fail('The photo is missing from the server', 404);
  return { file, full };
}

// Takes a photo off its piece or order (it is kept).
async function remove(business, user, fileId) {
  c.requireJewellery(business);
  return repo.transaction(async (db) => {
    const file = await repo.one(db, 'SELECT * FROM jewellery_files WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(fileId, 'Photo')]);
    if (!file) fail('Photo not found', 404);
    await access.require(business, file.piece_id ? 'jewellery.edit' : 'jewellery.create');
    if (file.removed_at) return { id: file.id, removed: true };
    await db.query('UPDATE jewellery_files SET removed_at=now(),removed_by=$3 WHERE business_id=$1 AND id=$2', [business.id, file.id, user.id]);
    await repo.audit(db, business.id, user.id, file.piece_id ? 'jewellery_piece.photo_removed' : 'jewellery_order.design_removed', file.piece_id || file.order_id, { file: file.file_name });
    return { id: file.id, removed: true };
  });
}

module.exports = { uploadOne, add, open, remove };
