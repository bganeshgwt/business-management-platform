const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const config = require('../../../../config/env');
const AppError = require('../../../../utils/AppError');
const c = require('./jewelleryCommon');

// A jeweller's files (module "jewellery"): a piece's photo, a custom order's
// design, photos of old gold as it came in, and the copy of a customer's KYC
// document: a photo (JPG, PNG or WebP, up to 5 MB; a KYC copy may be a PDF)
// kept in jewellery/<business>/ of the private uploads folder
// (PRIVATE_UPLOADS_DIR; config/env.js) under a generated name, and only ever
// sent through the API to someone who may see it (a KYC copy: to those who
// may see KYC). The bytes are checked: a renamed file is refused. A piece has
// one photo and a KYC document one copy (a new one takes the old one off); a
// voucher of old gold keeps up to ten photos. A file taken off is kept, never
// deleted.

const { fail, id } = c;
const ROOT = path.join(config.privateUploadsDir, 'jewellery');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_OLD_GOLD_PHOTOS = 10;
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], also: [0x57, 0x45, 0x42, 0x50] },
  { mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];
const sniff = (buffer) => SIGNATURES.find((s) => buffer.length >= 12 && s.bytes.every((b, i) => buffer[i] === b) && (!s.also || s.also.every((b, i) => buffer[8 + i] === b))) || null;
const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));
// Who may add, open and take off each kind of file.
const RULES = {
  photo: { add: 'jewellery.edit', open: 'jewellery.view', label: 'Piece' },
  design: { add: 'jewellery.create', open: 'jewellery.view', label: 'Custom order' },
  old_gold: { add: 'jewellery.create', open: 'jewellery.view', money: true, label: 'Old gold voucher' },
  kyc: { add: 'jewellery.create', open: 'jewellery.manage', remove: 'jewellery.manage', label: 'KYC document' },
};

const uploadOne = (req, res, next) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('file')(req, res, (error) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') return next(new AppError(400, 'That file is larger than 5 MB. Take the photo again at a lower size.'));
    if (error && error.code && String(error.code).startsWith('LIMIT_')) return next(new AppError(400, 'Add one file at a time.'));
    return next(error);
  });

// The record a file is added to, as the fields name it: { pieceId } (the piece's photo), { orderId } (the order's design),
// { oldGoldId } (a photo of old gold taken in), { kycId } (a KYC document's copy).
function readOwner(fields) {
  const named = [['photo', 'pieceId'], ['design', 'orderId'], ['old_gold', 'oldGoldId'], ['kyc', 'kycId']].filter(([, key]) => c.given(fields?.[key]));
  if (named.length !== 1) fail('Add the file to a piece, a custom order, an old gold voucher or a KYC document');
  const [kind, key] = named[0];
  return { kind, recordId: id(fields[key], RULES[kind].label) };
}

async function add(business, user, fields, file) {
  c.requireJewellery(business);
  const { kind, recordId } = readOwner(fields);
  await access.require(business, RULES[kind].add);
  if (RULES[kind].money) await c.requireMoney(business);
  if (!file) fail(kind === 'kyc' ? 'Choose the copy (a photo or PDF)' : 'Choose a photo');
  const found = sniff(file.buffer);
  if (!found || (found.mime === 'application/pdf' && kind !== 'kyc')) fail(kind === 'kyc' ? 'Only a photo (JPG, PNG or WebP) or a PDF can be added' : 'Only a photo (JPG, PNG or WebP) can be added');
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${found.ext}`;
  const dir = dirOf(business.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, storedName);
  fs.writeFileSync(full, file.buffer, { flag: 'wx' });
  try {
    return await repo.transaction(async (db) => {
      await c.lockBusiness(db, business);
      if (kind === 'photo') {
        const piece = await repo.one(db, 'SELECT id,tag_no,status FROM jewellery_pieces WHERE business_id=$1 AND id=$2', [business.id, recordId]);
        if (!piece) fail('Piece not found', 404);
        if (!['in_stock', 'on_approval', 'at_karigar', 'at_centre'].includes(piece.status)) fail(`Piece ${piece.tag_no} has left the shop and keeps what it was`, 409);
      } else if (kind === 'design') {
        const order = await repo.one(db, 'SELECT id,order_no,status,location_id FROM jewellery_orders WHERE business_id=$1 AND id=$2', [business.id, recordId]);
        if (!order) fail('Custom order not found', 404);
        access.requireLocation(business, order.location_id);
        if (['delivered', 'cancelled'].includes(order.status)) fail(`Order ${order.order_no} is ${order.status} and keeps what it was`, 409);
      } else if (kind === 'old_gold') {
        const voucher = await repo.one(db, 'SELECT id,voucher_no,location_id,cancelled_at FROM jewellery_old_gold WHERE business_id=$1 AND id=$2', [business.id, recordId]);
        if (!voucher) fail('Old gold voucher not found', 404);
        access.requireLocation(business, voucher.location_id);
        if (voucher.cancelled_at) fail(`Old gold ${voucher.voucher_no} is cancelled`, 409);
        const count = await repo.one(db, 'SELECT count(*)::int AS n FROM jewellery_files WHERE business_id=$1 AND old_gold_id=$2 AND removed_at IS NULL', [business.id, voucher.id]);
        if (count.n >= MAX_OLD_GOLD_PHOTOS) fail(`Old gold ${voucher.voucher_no} has its ${MAX_OLD_GOLD_PHOTOS} photos: take one off first`, 409);
      } else {
        const doc = await repo.one(db, 'SELECT id,removed_at FROM jewellery_kyc_documents WHERE business_id=$1 AND id=$2', [business.id, recordId]);
        if (!doc) fail('KYC document not found', 404);
        if (doc.removed_at) fail('That KYC document was set aside', 409);
      }
      const fileName = String(file.originalname || `file.${found.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 150) || `file.${found.ext}`;
      const column = { photo: 'piece_id', design: 'order_id', old_gold: 'old_gold_id', kyc: 'kyc_id' }[kind];
      // One photo a piece, one design an order and one copy a KYC document: a new one takes the old one off.
      if (kind !== 'old_gold') {
        await db.query(`UPDATE jewellery_files SET removed_at=now(),removed_by=$3 WHERE business_id=$1 AND removed_at IS NULL AND ${column}=$2`, [business.id, recordId, user.id]);
      }
      const row = await repo.one(db, `INSERT INTO jewellery_files(business_id,kind,${column},stored_name,file_name,mime_type,size_bytes,uploaded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,kind,piece_id,order_id,old_gold_id,kyc_id,file_name,mime_type,size_bytes,created_at`,
      [business.id, kind, recordId, storedName, fileName, found.mime, file.size, user.id]);
      const action = { photo: 'jewellery_piece.photo_added', design: 'jewellery_order.design_added', old_gold: 'jewellery_old_gold.photo_added', kyc: 'jewellery_kyc.copy_added' }[kind];
      await repo.audit(db, business.id, user.id, action, recordId, { file: fileName });
      return row;
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

const kindOf = (file) => (file.piece_id ? 'photo' : file.order_id ? 'design' : file.old_gold_id ? 'old_gold' : 'kyc');

// The file itself, to someone who may see it.
async function open(business, fileId) {
  c.requireJewellery(business);
  const file = await repo.one(repo.pool, 'SELECT * FROM jewellery_files WHERE business_id=$1 AND id=$2', [business.id, id(fileId, 'File')]);
  if (!file) fail('File not found', 404);
  const rule = RULES[kindOf(file)];
  await access.require(business, rule.open);
  if (rule.money) await c.requireMoney(business);
  const full = path.join(dirOf(business.id), file.stored_name);
  if (!fs.existsSync(full)) fail('The file is missing from the server', 404);
  return { file, full };
}

// Takes a file off its record (it is kept).
async function remove(business, user, fileId) {
  c.requireJewellery(business);
  return repo.transaction(async (db) => {
    const file = await repo.one(db, 'SELECT * FROM jewellery_files WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(fileId, 'File')]);
    if (!file) fail('File not found', 404);
    const kind = kindOf(file);
    await access.require(business, RULES[kind].remove || RULES[kind].add);
    if (file.removed_at) return { id: file.id, removed: true };
    await db.query('UPDATE jewellery_files SET removed_at=now(),removed_by=$3 WHERE business_id=$1 AND id=$2', [business.id, file.id, user.id]);
    const action = { photo: 'jewellery_piece.photo_removed', design: 'jewellery_order.design_removed', old_gold: 'jewellery_old_gold.photo_removed', kyc: 'jewellery_kyc.copy_removed' }[kind];
    await repo.audit(db, business.id, user.id, action, file.piece_id || file.order_id || file.old_gold_id || file.kyc_id, { file: file.file_name });
    return { id: file.id, removed: true };
  });
}

module.exports = { uploadOne, add, open, remove };
