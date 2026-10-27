const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const config = require('../../../../config/env');
const access = require('../../core/services/businessAccess.service');
const licences = require('./businessLicences.service');

// A licence's scanned copies: a PDF or a photo of the licence, each renewal's
// copy added beside the earlier ones and kept with the dates the licence had
// then. Kept as the platform keeps its private files (a prescription scan, a
// task's photo): in licences/<business>/ of the private uploads folder
// (PRIVATE_UPLOADS_DIR; config/env.js), under a generated name, up to 5 MB,
// the bytes checked (a renamed file is refused), and sent only through the
// API to someone who may see licences. Never changed or deleted.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const ROOT = path.join(config.privateUploadsDir, 'licences');
const MAX_BYTES = 5 * 1024 * 1024;
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], also: [0x57, 0x45, 0x42, 0x50] },
  { mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];
const sniff = (buffer) => SIGNATURES.find((s) => buffer.length >= 12 && s.bytes.every((b, i) => buffer[i] === b) && (!s.also || s.also.every((b, i) => buffer[8 + i] === b))) || null;
const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));
// The most copies one licence keeps.
const MOST = 40;

const uploadOne = (req, res, next) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('file')(req, res, (error) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') return next(new AppError(400, 'That file is larger than 5 MB. Scan the licence again at a lower size.'));
    if (error && error.code && String(error.code).startsWith('LIMIT_')) return next(new AppError(400, 'Attach one file at a time.'));
    return next(error);
  });

// The file kept with the licence, with the licence's dates now.
async function add(business, user, licenceId, file) {
  licences.requireLicences(business);
  await access.require(business, 'licences.edit');
  const target = v.requiredId(licenceId, 'Licence');
  if (!file) fail('Choose the scanned copy of the licence');
  const found = sniff(file.buffer);
  if (!found) fail('Only a PDF or a photo (JPG, PNG, WebP) of the licence can be kept');
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${found.ext}`;
  const dir = dirOf(business.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, storedName);
  fs.writeFileSync(full, file.buffer, { flag: 'wx' });
  try {
    return await repo.transaction(async (db) => {
      const licence = await licences.load(db, business, target, { lock: true });
      const count = await repo.one(db, 'SELECT count(*)::int AS n FROM business_licence_files WHERE business_id=$1 AND licence_id=$2', [business.id, licence.id]);
      if (count.n >= MOST) fail(`${licence.name} already keeps ${MOST} copies`, 409);
      const fileName = String(file.originalname || `licence.${found.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 150) || `licence.${found.ext}`;
      const row = await repo.one(db, `INSERT INTO business_licence_files(business_id,licence_id,stored_name,file_name,mime_type,size_bytes,valid_from,valid_until,uploaded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,file_name,mime_type,size_bytes,valid_from,valid_until,created_at`,
      [business.id, licence.id, storedName, fileName, found.mime, file.size, licence.valid_from, licence.valid_until, user.id]);
      await repo.audit(db, business.id, user.id, 'licence.copy_added', licence.id, { name: licence.name, licenceNo: licence.licence_no, file: fileName,
        validFrom: licence.valid_from, validUntil: licence.valid_until });
      return row;
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

// The file itself, to someone who may see the licences (and the licence's location).
async function open(business, licenceId, fileId) {
  licences.requireLicences(business);
  await access.require(business, 'licences.view');
  const licence = await licences.load(repo.pool, business, licenceId);
  const file = await repo.one(repo.pool, 'SELECT * FROM business_licence_files WHERE business_id=$1 AND licence_id=$2 AND id=$3', [business.id, licence.id, v.requiredId(fileId, 'File')]);
  if (!file) fail('File not found', 404);
  const full = path.join(dirOf(business.id), file.stored_name);
  if (!fs.existsSync(full)) fail('The file is missing from the server', 404);
  return { file, full };
}

module.exports = { uploadOne, add, open };
