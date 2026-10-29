const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const v = require('../../../../utils/validate');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const config = require('../../../../config/env');
const AppError = require('../../../../utils/AppError');
const c = require('./memberCommon');

// The member's acceptance of the refund policy (module "member_plans"): a
// signature drawn on the screen by the member (or the member using a seat),
// kept with the version of the policy the membership was sold with, as an
// option beside the printed slip. Each is a picture (PNG, JPG or WebP, up to
// 1 MB) kept in memberships/<business>/ of the private uploads folder
// (PRIVATE_UPLOADS_DIR; config/env.js) under a generated name, and only ever
// sent through the API to someone who sees memberships. The bytes are
// checked: a renamed file is refused. A signature is never changed or deleted.

const { fail, id } = c;
const ROOT = path.join(config.privateUploadsDir, 'memberships');
const MAX_BYTES = 1024 * 1024;
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], also: [0x57, 0x45, 0x42, 0x50] },
];
const sniff = (buffer) => SIGNATURES.find((s) => buffer.length >= 12 && s.bytes.every((b, i) => buffer[i] === b) && (!s.also || s.also.every((b, i) => buffer[8 + i] === b))) || null;
const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));

const uploadOne = (req, res, next) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 4 } }).single('file')(req, res, (error) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') return next(new AppError(400, 'That signature is larger than 1 MB. Draw it again.'));
    if (error && error.code && String(error.code).startsWith('LIMIT_')) return next(new AppError(400, 'Add one signature at a time.'));
    return next(error);
  });

// fields: { membershipId, contactId? (a seat's member; the holder by default), signedBy? (the name written under it) }
async function add(business, user, fields, file) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  const membershipId = id(fields?.membershipId, 'Membership');
  if (!file) fail('Draw the member\'s signature');
  const found = sniff(file.buffer);
  if (!found) fail('Only a picture (PNG, JPG or WebP) can be kept');
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${found.ext}`;
  const dir = dirOf(business.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, storedName);
  fs.writeFileSync(full, file.buffer, { flag: 'wx' });
  try {
    return await repo.transaction(async (db) => {
      const m = await repo.one(db, `SELECT m.id,m.membership_no,m.contact_id,m.location_id,m.policy_version,ct.name FROM member_memberships m
        JOIN business_contacts ct ON ct.business_id=m.business_id AND ct.id=m.contact_id WHERE m.business_id=$1 AND m.id=$2`, [business.id, membershipId]);
      if (!m) fail('Membership not found', 404);
      access.requireLocation(business, m.location_id);
      let contactId = m.contact_id, name = m.name;
      if (c.given(fields.contactId) && Number(fields.contactId) !== Number(m.contact_id)) {
        const seat = await repo.one(db, `SELECT s.contact_id,ct.name FROM member_seats s JOIN business_contacts ct ON ct.business_id=s.business_id AND ct.id=s.contact_id
          WHERE s.business_id=$1 AND s.membership_id=$2 AND s.contact_id=$3`, [business.id, m.id, id(fields.contactId, 'Member')]);
        if (!seat) fail(`That member has no seat on ${m.membership_no}`, 404);
        ({ contact_id: contactId, name } = seat);
      }
      const signedBy = v.optionalString(fields.signedBy, 'Signed by', 150) || name;
      const row = await repo.one(db, `INSERT INTO member_acceptances(business_id,membership_id,contact_id,policy_version,signed_by_name,stored_name,mime_type,size_bytes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,membership_id,policy_version,signed_by_name,created_at`,
      [business.id, m.id, contactId, m.policy_version, signedBy, storedName, found.mime, file.size, user.id]);
      await db.query('INSERT INTO member_events(business_id,membership_id,kind,note,details,created_by) VALUES($1,$2,$3,$4,$5,$6)',
        [business.id, m.id, 'accepted', `${signedBy} signed the refund policy (version ${m.policy_version})`, JSON.stringify({ acceptanceId: row.id, policyVersion: m.policy_version }), user.id]);
      await repo.audit(db, business.id, user.id, 'membership.policy_signed', m.id, { membershipNo: m.membership_no, signedBy, policyVersion: m.policy_version });
      return row;
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

// The signature itself, to someone who sees memberships.
async function open(business, acceptanceId) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  const file = await repo.one(repo.pool, `SELECT a.*,m.location_id FROM member_acceptances a JOIN member_memberships m ON m.business_id=a.business_id AND m.id=a.membership_id
    WHERE a.business_id=$1 AND a.id=$2`, [business.id, id(acceptanceId, 'Signature')]);
  if (!file) fail('Signature not found', 404);
  access.requireLocation(business, file.location_id);
  const full = path.join(dirOf(business.id), file.stored_name);
  if (!fs.existsSync(full)) fail('The file is missing from the server', 404);
  return { file, full };
}

module.exports = { uploadOne, add, open };
