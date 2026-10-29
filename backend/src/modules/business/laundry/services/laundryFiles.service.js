const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const v = require('../../../../utils/validate');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const config = require('../../../../config/env');
const AppError = require('../../../../utils/AppError');
const c = require('./laundryCommon');

// Photos of garments and the customer's signature (module "laundry"): a photo
// of a garment at intake (while it is received; taken with the order) or at
// its quality check (in the work, at QC, packed or ready), and the signature
// the customer draws on the screen at intake, beside the tick and the printed
// receipt. Each is a picture (JPG, PNG or WebP, up to 5 MB) kept in
// laundry/<business>/ of the private uploads folder (PRIVATE_UPLOADS_DIR;
// config/env.js) under a generated name, and only ever sent through the API to
// someone who sees the order. The bytes are checked: a renamed file is
// refused. A picture is never changed or deleted (the database refuses it).

const { fail, id } = c;
const ROOT = path.join(config.privateUploadsDir, 'laundry');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 6;
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], also: [0x57, 0x45, 0x42, 0x50] },
];
const sniff = (buffer) => SIGNATURES.find((s) => buffer.length >= 12 && s.bytes.every((b, i) => buffer[i] === b) && (!s.also || s.also.every((b, i) => buffer[8 + i] === b))) || null;
const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));

const uploadOne = (req, res, next) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 6 } }).single('file')(req, res, (error) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') return next(new AppError(400, 'That picture is larger than 5 MB. Take it again at a lower size.'));
    if (error && error.code && String(error.code).startsWith('LIMIT_')) return next(new AppError(400, 'Add one picture at a time.'));
    return next(error);
  });

// fields: { orderId, kind: photo | signature, itemId (a photo), stage: intake | qc (a photo; a signature is at intake) }
async function add(business, user, fields, file) {
  c.requireLaundry(business);
  const orderId = id(fields?.orderId, 'Garment order');
  const kind = v.requiredEnum(fields?.kind, 'A photo or a signature', ['photo', 'signature']);
  const stage = kind === 'signature' ? 'intake' : v.requiredEnum(fields?.stage, 'Taken at', ['intake', 'qc']);
  const itemId = kind === 'photo' ? id(fields?.itemId, 'Garment') : null;
  // At intake, the counter that takes the order in; at the quality check, the work's.
  await access.require(business, stage === 'intake' ? 'laundry.create' : 'laundry.edit');
  if (!file) fail(kind === 'signature' ? 'Draw the signature' : 'Choose a photo');
  const found = sniff(file.buffer);
  if (!found) fail('Only a picture (JPG, PNG or WebP) can be added');
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${found.ext}`;
  const dir = dirOf(business.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, storedName);
  fs.writeFileSync(full, file.buffer, { flag: 'wx' });
  try {
    return await repo.transaction(async (db) => {
      await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
      const order = await repo.one(db, 'SELECT id,order_no,location_id,contact_id FROM laundry_orders WHERE business_id=$1 AND id=$2', [business.id, orderId]);
      if (!order) fail('Garment order not found', 404);
      access.requireLocation(business, order.location_id);
      let item = null;
      if (itemId) {
        item = await repo.one(db, 'SELECT id,tag_no,status FROM laundry_order_items WHERE business_id=$1 AND order_id=$2 AND id=$3', [business.id, order.id, itemId]);
        if (!item) fail(`That garment is not on order ${order.order_no}`, 404);
        if (stage === 'intake' && item.status !== 'received') fail(`Garment ${item.tag_no} is ${c.STATUS_WORDS[item.status]}: a photo at intake is taken while it is received`, 409);
        if (stage === 'qc' && !['in_process', 'qc', 'packed', 'ready'].includes(item.status)) {
          fail(`Garment ${item.tag_no} is ${c.STATUS_WORDS[item.status]}: a photo at its quality check is taken while it is in the work or ready`, 409);
        }
        const count = await repo.one(db, "SELECT count(*)::int AS n FROM laundry_files WHERE business_id=$1 AND item_id=$2 AND stage=$3 AND kind='photo'", [business.id, item.id, stage]);
        if (count.n >= MAX_PHOTOS) fail(`Garment ${item.tag_no} has its ${MAX_PHOTOS} photos ${stage === 'intake' ? 'from intake' : 'from its quality check'}`, 409);
      } else if (await repo.one(db, "SELECT 1 FROM laundry_files WHERE business_id=$1 AND order_id=$2 AND kind='signature'", [business.id, order.id])) {
        fail(`The customer has signed for order ${order.order_no} already`, 409);
      }
      const fileName = String(file.originalname || `${kind}.${found.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 150) || `${kind}.${found.ext}`;
      const row = await repo.one(db, `INSERT INTO laundry_files(business_id,order_id,item_id,contact_id,stage,kind,stored_name,file_name,mime_type,size_bytes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,order_id,item_id,stage,kind,file_name,mime_type,size_bytes,created_at`,
      [business.id, order.id, item?.id || null, order.contact_id, stage, kind, storedName, fileName, found.mime, file.size, user.id]);
      await db.query('INSERT INTO laundry_order_events(business_id,order_id,item_id,note,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, order.id, item?.id || null,
        kind === 'signature' ? 'The customer signed on the screen' : `Photo ${stage === 'intake' ? 'at intake' : 'at its quality check'}`, user.id]);
      await repo.audit(db, business.id, user.id, kind === 'signature' ? 'laundry_order.signed' : 'laundry_order.photo_added', order.id,
        { orderNo: order.order_no, stage, ...(item ? { tag: item.tag_no } : {}), file: fileName });
      return row;
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

// The picture itself, to someone who sees the order.
async function open(business, fileId) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  const file = await repo.one(repo.pool, `SELECT f.*,o.location_id FROM laundry_files f JOIN laundry_orders o ON o.business_id=f.business_id AND o.id=f.order_id
    WHERE f.business_id=$1 AND f.id=$2`, [business.id, id(fileId, 'File')]);
  if (!file) fail('File not found', 404);
  access.requireLocation(business, file.location_id);
  const full = path.join(dirOf(business.id), file.stored_name);
  if (!fs.existsSync(full)) fail('The file is missing from the server', 404);
  return { file, full };
}

module.exports = { uploadOne, add, open };
