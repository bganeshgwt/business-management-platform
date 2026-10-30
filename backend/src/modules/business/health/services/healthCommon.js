const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const multer = require('multer');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const config = require('../../../../config/env');
const access = require('../../core/services/businessAccess.service');
const userRepository = require('../../../access/repositories/user.repository');

// What the pharmacy, clinic and lab services share: running numbers, the
// settings row, the people who sign (pharmacist, doctor, pathologist) and
// their PIN check, and prescription scans kept in the private uploads folder.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const text = (value, name, max) => v.optionalString(value === null ? undefined : value, name, max);
function requestKey(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) fail('A valid request key is required');
  return value;
}
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
function dateOnly(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) fail(`${name} must be a date (YYYY-MM-DD)`);
  return value;
}
const optionalDate = (value, name) => (value === undefined || value === null || value === '' ? null : dateOnly(value, name));
const today = async (db, business) => (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;

// The business must be of this type (a grocery has no Schedule H register).
function requireType(business, types, what) {
  if (!types.includes(business.business_type)) fail(`${what} belong to ${types.includes('pharmacy') ? 'a pharmacy' : 'a clinic or lab'}`, 404);
}

// Next running number of a kind, inside the caller's transaction.
const PREFIX = { patient: 'P', visit: 'OP', lab_order: 'LAB', sample: 'S', debit_note: 'DN' };
async function nextNumber(db, businessId, kind, width = 5) {
  const row = await repo.one(db, `INSERT INTO health_counters(business_id,kind,next_number) VALUES($1,$2,2)
    ON CONFLICT (business_id,kind) DO UPDATE SET next_number=health_counters.next_number+1 RETURNING next_number-1 AS n`, [businessId, kind]);
  return `${PREFIX[kind]}${String(row.n).padStart(width, '0')}`;
}

// --- Settings -------------------------------------------------------------------------------

const SETTING_DEFAULTS = {
  drug_licence_20: null, drug_licence_21: null, drug_licence_20b: null, drug_licence_21b: null, drug_licence_20f: null,
  h1_retention_years: 3, x_retention_years: 2, prescription_retention_years: 2, rx_scan_required: true, near_expiry_days: 90,
  lab_name: null, lab_registration: null, report_footer: null, clinical_retention_years: 3, consent_version: 'v1', consent_notice: null,
  referral_commission_enabled: false, referral_commission_percent: '0.00',
};
async function settings(db, businessId) {
  const row = await repo.one(db, 'SELECT * FROM health_settings WHERE business_id=$1', [businessId]);
  if (row) return row;
  // The notice text is the column default until the business saves its own.
  const notice = await repo.one(db, `SELECT column_default FROM information_schema.columns WHERE table_name='health_settings' AND column_name='consent_notice'`);
  const fallback = notice?.column_default ? notice.column_default.replace(/^'|'::text$/g, '').replace(/''/g, "'") : '';
  return { business_id: businessId, ...SETTING_DEFAULTS, consent_notice: fallback };
}

async function getSettings(business) {
  await access.requireAny(business, ['pharmacy.view', 'patients.view', 'lab.view', 'settings.view']);
  const [row, signatories, seller, locationLicences] = await Promise.all([
    settings(repo.pool, business.id),
    signatoryList(repo.pool, business.id),
    repo.one(repo.pool, 'SELECT display_name,legal_name,gstin,address_line1,address_line2,city,postal_code,phone,email FROM business_settings WHERE business_id=$1', [business.id]),
    repo.all(repo.pool, `SELECT l.id AS location_id,l.name AS location_name,l.active,p.drug_licence_20,p.drug_licence_21,p.drug_licence_20b,p.drug_licence_21b,p.drug_licence_20f
      FROM business_locations l LEFT JOIN pharmacy_location_licences p ON p.business_id=l.business_id AND p.location_id=l.id
      WHERE l.business_id=$1 AND ($2::bigint IS NULL OR l.id=$2) ORDER BY l.id`, [business.id, business.location_tied ? business.location_scope : null]),
  ]);
  return { ...row, signatories, seller, locationLicences };
}

// A pharmacy branch's own drug licences (each premises is licensed on its
// own). All five empty: the branch uses the business-wide numbers above.
const LICENCE_FIELDS = [['drug_licence_20', 'drugLicence20', 'Form 20'], ['drug_licence_21', 'drugLicence21', 'Form 21'],
  ['drug_licence_20b', 'drugLicence20b', 'Form 20B'], ['drug_licence_21b', 'drugLicence21b', 'Form 21B'], ['drug_licence_20f', 'drugLicence20f', 'Form 20F']];
async function saveLocationLicences(business, user, locationId, body) {
  await access.requireAny(business, ['pharmacy.edit', 'settings.edit']);
  const location = id(locationId, 'Location');
  access.requireLocation(business, location);
  const values = LICENCE_FIELDS.map(([, key, form]) => text(body[key], `Drug licence (${form})`, 60) || null);
  return repo.transaction(async (db) => {
    const found = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, location]);
    if (!found) fail('Location not found', 404);
    let row = null;
    if (values.some(Boolean)) {
      const columns = LICENCE_FIELDS.map(([column]) => column);
      row = await repo.one(db, `INSERT INTO pharmacy_location_licences(business_id,location_id,${columns.join(',')},updated_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT (business_id,location_id) DO UPDATE SET ${columns.map((c) => `${c}=EXCLUDED.${c}`).join(',')},
        updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [business.id, location, ...values, user.id]);
    } else {
      await db.query('DELETE FROM pharmacy_location_licences WHERE business_id=$1 AND location_id=$2', [business.id, location]);
    }
    await repo.audit(db, business.id, user.id, 'pharmacy.location_licences_saved', location, { location: found.name, own: Boolean(row) });
    return { location_id: location, location_name: found.name, ...(row || Object.fromEntries(LICENCE_FIELDS.map(([column]) => [column, null]))) };
  });
}

const years = (value, name, fallback) => (value === undefined ? fallback : v.requiredNumber(Number(value), name, { min: 1, max: 30 }));
async function saveSettings(business, user, body) {
  await access.requireAny(business, ['pharmacy.edit', 'settings.edit']);
  return repo.transaction(async (db) => {
    const current = await settings(db, business.id);
    const pick = (key, name, max) => (body[key] === undefined ? current[key] : text(body[key], name, max) || null);
    const licence = (key, name) => pick(key, name, 60);
    const percent = body.referralCommissionPercent === undefined ? Number(current.referral_commission_percent)
      : v.requiredNumber(Number(body.referralCommissionPercent), 'Referral commission %', { min: 0, max: 50 });
    const notice = body.consentNotice === undefined ? current.consent_notice : v.requiredString(body.consentNotice, 'Consent notice', 4000);
    if (notice.length < 50) fail('The consent notice must say what is collected, why, and how to withdraw (at least 50 characters)');
    // A changed notice is a new version: consents name the version they were given on.
    const version = notice !== current.consent_notice && body.consentNotice !== undefined
      ? `v${(Number(String(current.consent_version).replace(/\D/g, '')) || 1) + 1}` : current.consent_version;
    const values = {
      drug_licence_20: licence('drugLicence20', 'Drug licence (Form 20)'), drug_licence_21: licence('drugLicence21', 'Drug licence (Form 21)'),
      drug_licence_20b: licence('drugLicence20b', 'Drug licence (Form 20B)'), drug_licence_21b: licence('drugLicence21b', 'Drug licence (Form 21B)'),
      drug_licence_20f: licence('drugLicence20f', 'Drug licence (Form 20F)'),
      h1_retention_years: years(body.h1RetentionYears, 'H1 register kept for (years)', current.h1_retention_years),
      x_retention_years: years(body.xRetentionYears, 'Schedule X register kept for (years)', current.x_retention_years),
      prescription_retention_years: years(body.prescriptionRetentionYears, 'Prescriptions kept for (years)', current.prescription_retention_years),
      rx_scan_required: v.requiredBoolean(body.rxScanRequired, 'Prescription scan required', current.rx_scan_required),
      near_expiry_days: body.nearExpiryDays === undefined ? current.near_expiry_days : v.requiredNumber(Number(body.nearExpiryDays), 'Near expiry (days)', { min: 7, max: 365 }),
      lab_name: pick('labName', 'Lab name', 150), lab_registration: pick('labRegistration', 'Lab registration', 120), report_footer: pick('reportFooter', 'Report footer', 500),
      clinical_retention_years: years(body.clinicalRetentionYears, 'Clinical records kept for (years)', current.clinical_retention_years),
      consent_notice: notice, consent_version: version,
      referral_commission_enabled: v.requiredBoolean(body.referralCommissionEnabled, 'Referral commission', current.referral_commission_enabled),
      referral_commission_percent: percent.toFixed(2),
    };
    if (values.referral_commission_enabled !== current.referral_commission_enabled) await access.require(business, 'settings.edit');
    const keys = Object.keys(values);
    const row = await repo.one(db, `INSERT INTO health_settings(business_id,${keys.join(',')},updated_by,updated_at)
      VALUES($1,${keys.map((_, i) => `$${i + 2}`).join(',')},$${keys.length + 2},now())
      ON CONFLICT (business_id) DO UPDATE SET ${keys.map((k) => `${k}=EXCLUDED.${k}`).join(',')},updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, ...keys.map((k) => values[k]), user.id]);
    await repo.audit(db, business.id, user.id, 'health.settings_saved', business.id, {
      changed: keys.filter((k) => String(values[k] ?? '') !== String(current[k] ?? '')),
    });
    return row;
  });
}

// --- People who sign --------------------------------------------------------------------------

const signatoryList = (db, businessId) => repo.all(db, `SELECT g.*,u.name AS user_name,(u.pin_hash IS NOT NULL) AS has_pin,r.name AS resource_name
  FROM health_signatories g JOIN users u ON u.id=g.user_id LEFT JOIN business_resources r ON r.business_id=g.business_id AND r.id=g.resource_id
  WHERE g.business_id=$1 ORDER BY g.active DESC,g.kind,g.name`, [businessId]);

async function signatories(business, kind) {
  await access.requireAny(business, ['pharmacy.view', 'patients.view', 'lab.view', 'settings.view']);
  const rows = await signatoryList(repo.pool, business.id);
  return kind ? rows.filter((r) => r.kind === kind && r.active) : rows;
}

async function saveSignatory(business, user, body) {
  const kind = v.requiredEnum(body.kind, 'Kind', ['pharmacist', 'doctor', 'pathologist']);
  await access.require(business, kind === 'pharmacist' ? 'pharmacy.edit' : 'settings.edit');
  const userId = id(body.userId, 'Staff member');
  return repo.transaction(async (db) => {
    const member = await repo.one(db, `SELECT u.id,u.name FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
      WHERE m.business_id=$1 AND m.user_id=$2 AND m.active`, [business.id, userId]);
    if (!member) fail('That person is not on this business\'s staff', 404);
    let resourceId = optionalId(body.resourceId, 'Doctor\'s calendar');
    if (resourceId) {
      if (kind !== 'doctor') fail('Only a doctor has an appointment calendar');
      if (!await repo.one(db, 'SELECT 1 FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, resourceId])) fail('Doctor\'s calendar not found', 404);
      const taken = await repo.one(db, "SELECT name FROM health_signatories WHERE business_id=$1 AND resource_id=$2 AND active AND NOT (kind='doctor' AND user_id=$3)", [business.id, resourceId, member.id]);
      if (taken) fail(`That calendar is already linked to ${taken.name}`, 409);
    } else resourceId = null;
    const row = await repo.one(db, `INSERT INTO health_signatories(business_id,user_id,kind,name,qualification,registration_no,council,resource_id,active,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
      ON CONFLICT (business_id,kind,user_id) DO UPDATE SET name=EXCLUDED.name,qualification=EXCLUDED.qualification,registration_no=EXCLUDED.registration_no,
        council=EXCLUDED.council,resource_id=EXCLUDED.resource_id,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, member.id, kind, v.requiredString(body.name || member.name, 'Name as registered', 150), text(body.qualification, 'Qualification', 120),
      v.requiredString(body.registrationNo, 'Registration number', 60), text(body.council, 'Council', 150), resourceId, v.requiredBoolean(body.active, 'Active', true), user.id]);
    await repo.audit(db, business.id, user.id, 'health.signatory_saved', row.id, { kind, name: row.name, registrationNo: row.registration_no, active: row.active });
    return row;
  });
}

// The registered person signs with their own PIN (My profile › Personal PIN), checked
// before the posting's transaction so a PIN check holds no locks. Returns the
// signatory row.
async function verifySignature(business, kind, body, what) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(`${what} needs the ${kind}'s PIN`, 409, { reason: `${kind}_signoff` });
  const signatoryId = id(body.signatoryId, kind === 'pharmacist' ? 'Pharmacist' : kind === 'pathologist' ? 'Pathologist' : 'Doctor');
  const pin = typeof body.pin === 'string' ? body.pin : '';
  if (!/^\d{4,8}$/.test(pin)) fail(`Enter the ${kind}'s PIN (4 to 8 digits)`);
  const signer = await repo.one(repo.pool, 'SELECT * FROM health_signatories WHERE business_id=$1 AND id=$2 AND kind=$3 AND active', [business.id, signatoryId, kind]);
  if (!signer) fail(`That person is not a registered ${kind} of this business`, 403, { reason: 'not_a_signatory' });
  // Still a member with access to the business.
  try { await access.load({ id: signer.user_id }, business.id); } catch { fail(`${signer.name} no longer has access to this business`, 403, { reason: 'not_a_signatory' }); }
  const person = await repo.one(repo.pool, "SELECT id,name,pin_hash,pin_must_change FROM users WHERE id=$1 AND status='active'", [signer.user_id]);
  if (!person?.pin_hash) fail(`${signer.name} has not set a PIN yet (My profile › Personal PIN).`, 409, { reason: 'no_pin' });
  // A PIN someone else set signs nothing until its person chooses their own.
  require('../../../access/services/auth.service').assertOwnPin({ ...person, name: signer.name }, { what: 'sign anything' });
  const slot = await userRepository.reservePinAttempt(person.id, config.accountLock);
  if (!slot.allowed) fail(`${signer.name}'s PIN is locked after too many wrong tries. Try again later.`, 423, { reason: 'pin_locked' });
  if (!(await bcrypt.compare(pin, person.pin_hash))) {
    const miss = await userRepository.recordPinMiss(person.id, slot.place, config.accountLock);
    fail(miss.justLocked ? `${signer.name}'s PIN is now locked after too many wrong tries.` : `That PIN is not right. ${miss.attemptsLeft} tr${miss.attemptsLeft === 1 ? 'y' : 'ies'} left.`,
      miss.justLocked ? 423 : 400, { reason: miss.justLocked ? 'pin_locked' : 'wrong_pin' });
  }
  await userRepository.recordPinHit(person.id);
  return signer;
}

// --- Prescription scans (private) --------------------------------------------------------------

// In health/<business>/ of the private uploads folder (PRIVATE_UPLOADS_DIR; config/env.js).
const ROOT = path.join(config.privateUploadsDir, 'health');
const MAX_BYTES = 5 * 1024 * 1024;
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], also: [0x57, 0x45, 0x42, 0x50] },
  { mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];
const sniff = (buffer) => SIGNATURES.find((s) => buffer.length >= 12 && s.bytes.every((b, i) => buffer[i] === b) && (!s.also || s.also.every((b, i) => buffer[8 + i] === b))) || null;
const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));

const uploadOne = (req, res, next) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5 } }).single('file')(req, res, (error) => {
    if (error && error.code === 'LIMIT_FILE_SIZE') return next(new AppError(400, 'That file is larger than 5 MB. Take the photo again at a lower size.'));
    if (error && error.code && String(error.code).startsWith('LIMIT_')) return next(new AppError(400, 'Attach one file at a time.'));
    return next(error);
  });

async function addPrescriptionFile(business, user, file) {
  await access.require(business, 'pharmacy.create');
  if (!file) fail('Choose a photo or scan of the prescription');
  const found = sniff(file.buffer);
  if (!found) fail('Only a photo (JPG, PNG, WebP) or a PDF of the prescription can be attached');
  const storedName = `${crypto.randomBytes(16).toString('hex')}.${found.ext}`;
  const dir = dirOf(business.id);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, storedName);
  fs.writeFileSync(full, file.buffer, { flag: 'wx' });
  try {
    return await repo.transaction(async (db) => {
      const fileName = String(file.originalname || `prescription.${found.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 150) || `prescription.${found.ext}`;
      const row = await repo.one(db, `INSERT INTO health_files(business_id,kind,stored_name,file_name,mime_type,size_bytes,uploaded_by)
        VALUES($1,'prescription',$2,$3,$4,$5,$6) RETURNING id,file_name,mime_type,size_bytes,created_at`, [business.id, storedName, fileName, found.mime, file.size, user.id]);
      await repo.audit(db, business.id, user.id, 'pharmacy.prescription_file_added', row.id, { file: fileName });
      return row;
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

// The file itself, to someone who may see the prescriptions. The look is logged.
async function openFile(business, user, fileId) {
  await access.require(business, 'pharmacy.view');
  const file = await repo.one(repo.pool, 'SELECT * FROM health_files WHERE business_id=$1 AND id=$2', [business.id, id(fileId, 'File')]);
  if (!file) fail('File not found', 404);
  const full = path.join(dirOf(business.id), file.stored_name);
  if (!fs.existsSync(full)) fail('The file is missing from the server', 404);
  await repo.transaction((db) => repo.audit(db, business.id, user.id, 'pharmacy.prescription_file_viewed', file.id, { file: file.file_name }));
  return { file, full };
}

// Age in whole years on a day, from a date of birth or an age given then.
function ageOn(patient, on) {
  const day = new Date(`${on}T00:00:00Z`);
  if (patient.date_of_birth) {
    const dob = new Date(`${String(patient.date_of_birth).slice(0, 10)}T00:00:00Z`);
    let age = day.getUTCFullYear() - dob.getUTCFullYear();
    if (day.getUTCMonth() < dob.getUTCMonth() || (day.getUTCMonth() === dob.getUTCMonth() && day.getUTCDate() < dob.getUTCDate())) age -= 1;
    return { years: Math.max(0, age), days: Math.max(0, Math.round((day - dob) / 86400000)) };
  }
  const registered = new Date(patient.created_at);
  const extra = Math.max(0, Math.floor((day - registered) / (365.25 * 86400000)));
  const yearsOld = Number(patient.age_years) + extra;
  return { years: yearsOld, days: Math.round(yearsOld * 365.25) };
}

module.exports = { fail, id, optionalId, text, requestKey, hashOf, dateOnly, optionalDate, today, requireType, nextNumber, settings, getSettings, saveSettings, saveLocationLicences,
  signatories, saveSignatory, verifySignature, uploadOne, addPrescriptionFile, openFile, ageOn };
