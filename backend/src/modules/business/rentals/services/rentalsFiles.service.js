const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const v = require('../../../../utils/validate');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const config = require('../../../../config/env');
const AppError = require('../../../../utils/AppError');
const c = require('./rentalsCommon');

// Photos and signatures of a handover and a return (module "rentals"): a
// photo of what was handed over or came back (of a line, or of the booking),
// and a signature drawn on the screen by the hirer or by the shop's person, at
// the handover (stage out) and at a return (stage in). Each is a picture (JPG,
// PNG or WebP, up to 5 MB) kept in rentals/<business>/ of the private uploads
// folder (PRIVATE_UPLOADS_DIR; config/env.js) under a generated name, and only
// ever sent through the API to someone who sees the booking. The bytes are
// checked: a renamed file is refused. A file is never changed or deleted. No
// copy of an ID document is kept: a photo is of what is hired.

const { fail, id } = c;
const ROOT = path.join(config.privateUploadsDir, 'rentals');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 20;
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

// fields: { bookingId, stage: out | in, kind: photo | signature, signer?: hirer | shop (a signature), lineId? (a photo of a line) }
async function add(business, user, fields, file) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  const bookingId = id(fields?.bookingId, 'Booking');
  const stage = v.requiredEnum(fields?.stage, 'Taken at', ['out', 'in']);
  const kind = v.requiredEnum(fields?.kind, 'A photo or a signature', ['photo', 'signature']);
  const signer = kind === 'signature' ? v.requiredEnum(fields?.signer, 'Signed by', ['hirer', 'shop']) : null;
  const lineId = kind === 'photo' && c.given(fields?.lineId) ? id(fields.lineId, 'Line') : null;
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
      const booking = await repo.one(db, 'SELECT id,booking_no,status,location_id,contact_id FROM rental_bookings WHERE business_id=$1 AND id=$2', [business.id, bookingId]);
      if (!booking) fail('Booking not found', 404);
      access.requireLocation(business, booking.location_id);
      if (lineId && !await repo.one(db, 'SELECT 1 FROM rental_booking_lines WHERE business_id=$1 AND booking_id=$2 AND id=$3', [business.id, booking.id, lineId])) {
        fail(`That line is not on booking ${booking.booking_no}`, 404);
      }
      if (kind === 'photo') {
        const count = await repo.one(db, "SELECT count(*)::int AS n FROM rental_files WHERE business_id=$1 AND booking_id=$2 AND stage=$3 AND kind='photo'", [business.id, booking.id, stage]);
        if (count.n >= MAX_PHOTOS) fail(`Booking ${booking.booking_no} has its ${MAX_PHOTOS} photos ${stage === 'out' ? 'of the handover' : 'of its returns'}`, 409);
      }
      const fileName = String(file.originalname || `${kind}.${found.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 150) || `${kind}.${found.ext}`;
      const row = await repo.one(db, `INSERT INTO rental_files(business_id,booking_id,contact_id,line_id,stage,kind,signer,stored_name,file_name,mime_type,size_bytes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,booking_id,line_id,stage,kind,signer,file_name,mime_type,size_bytes,created_at`,
      [business.id, booking.id, booking.contact_id, lineId, stage, kind, signer, storedName, fileName, found.mime, file.size, user.id]);
      await repo.audit(db, business.id, user.id, kind === 'signature' ? 'rental_booking.signed' : 'rental_booking.photo_added', booking.id,
        { bookingNo: booking.booking_no, stage, ...(signer ? { signer } : {}), ...(lineId ? { lineId } : {}), file: fileName });
      return row;
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

// The picture itself, to someone who sees the booking.
async function open(business, fileId) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  const file = await repo.one(repo.pool, `SELECT f.*,b.location_id FROM rental_files f JOIN rental_bookings b ON b.business_id=f.business_id AND b.id=f.booking_id
    WHERE f.business_id=$1 AND f.id=$2`, [business.id, id(fileId, 'File')]);
  if (!file) fail('File not found', 404);
  access.requireLocation(business, file.location_id);
  const full = path.join(dirOf(business.id), file.stored_name);
  if (!fs.existsSync(full)) fail('The file is missing from the server', 404);
  return { file, full };
}

module.exports = { uploadOne, add, open };
