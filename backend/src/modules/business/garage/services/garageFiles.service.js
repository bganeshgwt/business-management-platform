const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const config = require('../../../../config/env');
const AppError = require('../../../../utils/AppError');
const c = require('./garageCommon');
const jobs = require('./garageJobCards.service');

// A job card's inspection and photos (module "garage", garages).
//
//   inspection items  each area checked when the vehicle came in (Front
//                     bumper, Tyres) and what was found; added while the job
//                     card is open, taken off only while it has no photo.
//   photos            of an inspection item, or of the work (a mechanic's
//                     photo with a caption): JPG, PNG or WebP up to 5 MB, the
//                     bytes checked (a renamed file is refused), kept in
//                     garage/<business>/ of the private uploads folder
//                     (PRIVATE_UPLOADS_DIR) under a generated name, and sent
//                     only through the API. Never changed or deleted.
// Who adds and sees them is who works on and sees the job card: the desk
// (garage.view), and a mechanic on the job cards assigned to them.

const { fail, id } = c;
const ROOT = path.join(config.privateUploadsDir, 'garage');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 60;
const MAX_ITEMS = 40;
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

// The job card's inspection items and photos (for its page).
async function ofJob(db, business, jobId) {
  const items = await repo.all(db, `SELECT i.id,i.area,i.finding,i.created_at,u.name AS created_by_name FROM garage_inspection_items i JOIN users u ON u.id=i.created_by
    WHERE i.business_id=$1 AND i.job_card_id=$2 ORDER BY i.id`, [business.id, jobId]);
  const photos = await repo.all(db, `SELECT p.id,p.inspection_item_id,p.caption,p.file_name,p.mime_type,p.size_bytes,p.created_at,u.name AS created_by_name
    FROM garage_job_card_photos p JOIN users u ON u.id=p.created_by WHERE p.business_id=$1 AND p.job_card_id=$2 ORDER BY p.id`, [business.id, jobId]);
  return { items, photos };
}

// body: { area, finding? }
async function addItem(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  const area = c.optionalText(body.area, 'Area', 80);
  if (!area) fail('Name the area checked, like Front bumper');
  const finding = c.optionalText(body.finding, 'What was found', 300);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    const count = await repo.one(db, 'SELECT count(*)::int AS n FROM garage_inspection_items WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]);
    if (count.n >= MAX_ITEMS) fail(`A job card's inspection has up to ${MAX_ITEMS} items`, 409);
    const row = await repo.one(db, 'INSERT INTO garage_inspection_items(business_id,job_card_id,area,finding,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [business.id, job.id, area, finding, user.id]);
    await repo.audit(db, business.id, user.id, 'job_card.inspection_added', job.id, { jobNo: job.job_no, area, ...(finding ? { finding } : {}) });
    return { id: Number(row.id), ...(await ofJob(db, business, job.id)) };
  });
}

async function removeItem(business, user, jobId, itemId) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    const item = await repo.one(db, 'SELECT * FROM garage_inspection_items WHERE business_id=$1 AND job_card_id=$2 AND id=$3', [business.id, job.id, id(itemId, 'Inspection item')]);
    if (!item) fail('Inspection item not found', 404);
    const photo = await repo.one(db, 'SELECT 1 FROM garage_job_card_photos WHERE business_id=$1 AND inspection_item_id=$2 LIMIT 1', [business.id, item.id]);
    if (photo) fail(`${item.area} has photos: it stays on the job card`, 409);
    await db.query('DELETE FROM garage_inspection_items WHERE business_id=$1 AND id=$2', [business.id, item.id]);
    await repo.audit(db, business.id, user.id, 'job_card.inspection_removed', job.id, { jobNo: job.job_no, area: item.area });
    return ofJob(db, business, job.id);
  });
}

// fields: { jobCardId, inspectionItemId?, caption? }
async function addPhoto(business, user, fields, file) {
  c.requireGarage(business);
  await access.require(business, 'garage.edit');
  const jobId = id(fields?.jobCardId, 'Job card');
  const itemId = c.given(fields?.inspectionItemId) ? id(fields.inspectionItemId, 'Inspection item') : null;
  const caption = c.optionalText(fields?.caption, 'Caption', 200);
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
      const job = await jobs.lockJob(db, business, jobId);
      jobs.requireOpen(job);
      if (itemId) {
        const item = await repo.one(db, 'SELECT id FROM garage_inspection_items WHERE business_id=$1 AND job_card_id=$2 AND id=$3', [business.id, job.id, itemId]);
        if (!item) fail('Inspection item not found on this job card', 404);
      }
      const count = await repo.one(db, 'SELECT count(*)::int AS n FROM garage_job_card_photos WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]);
      if (count.n >= MAX_PHOTOS) fail(`A job card keeps up to ${MAX_PHOTOS} photos`, 409);
      const fileName = String(file.originalname || `photo.${found.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 150) || `photo.${found.ext}`;
      const row = await repo.one(db, `INSERT INTO garage_job_card_photos(business_id,job_card_id,inspection_item_id,caption,stored_name,file_name,mime_type,size_bytes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,inspection_item_id,caption,file_name,mime_type,size_bytes,created_at`,
      [business.id, job.id, itemId, caption, storedName, fileName, found.mime, file.size, user.id]);
      // A mechanic's photo of the work is a note in the job card's history too.
      await jobs.history(db, business, user, job, job.status, job.status, `Photo added${caption ? `: ${caption}` : ''}`);
      await repo.audit(db, business.id, user.id, 'job_card.photo_added', job.id, { jobNo: job.job_no, file: fileName, ...(itemId ? { inspectionItemId: itemId } : {}) });
      return row;
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

// The photo itself, to someone who sees its job card.
async function open(business, photoId) {
  c.requireGarage(business);
  await access.requireAny(business, ['garage.view', 'garage.edit']);
  const photo = await repo.one(repo.pool, 'SELECT * FROM garage_job_card_photos WHERE business_id=$1 AND id=$2', [business.id, id(photoId, 'Photo')]);
  if (!photo) fail('Photo not found', 404);
  // The job card's own check: a mechanic sees only the ones assigned to them.
  await jobs.load(repo.pool, business, photo.job_card_id);
  const full = path.join(dirOf(business.id), photo.stored_name);
  if (!fs.existsSync(full)) fail('The photo is missing from the server', 404);
  return { photo, full };
}

module.exports = { uploadOne, ofJob, addItem, removeItem, addPhoto, open };
