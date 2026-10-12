const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const h = require('./healthCommon');

// Clinic (round 2, R2-HEALTH): patients, consent and consultations.
//
//   Patient       a customer contact with a patient ID (P00001), age or date of
//                 birth, sex, guardian and emergency phone. Registration
//                 records consent for treatment and record keeping (DPDP:
//                 purpose, the notice version, how and by whom it was given);
//                 more purposes (reports on WhatsApp, reminders) are optional.
//                 A withdrawal is recorded once and stops new visits and lab
//                 orders for that purpose; the record itself is kept for the
//                 retention period the law asks for.
//   Clinical      vitals, complaints, examination, diagnosis (+ ICD-10),
//   record        advice, prescription and follow-up: only for patients.view_
//                 clinical (read) and patients.edit_clinical (write). Every
//                 read of clinical data writes 'patient.clinical_viewed' to
//                 business_audit with what was seen.
//   Visit         may start from an appointment (one visit per appointment;
//                 the appointment is marked completed when the visit is), and
//                 is billed through the core sale (consultation + tests).

const { fail, id, optionalId, text } = h;
const requireClinic = (business) => {
  h.requireType(business, ['healthcare'], 'Patient records');
  if (!business.modules.includes('patients')) fail('Patient records are not switched on for this business. An owner can turn them on in Settings › Modules.', 403);
};
const PURPOSES = ['treatment', 'reports_digital', 'reminders'];
const canClinical = (business) => access.can(business, 'patients.view_clinical');
// A clinical read leaves a trace (who, which patient, what), in its own small transaction.
async function logClinicalView(business, contactId, what, extra = {}) {
  await repo.transaction((db) => repo.audit(db, business.id, business.member_user_id, 'patient.clinical_viewed', contactId, { what, ...extra }));
}

repo.addLists({
  patients: {
    sql: `SELECT p.contact_id AS id,p.contact_id,p.patient_no,p.date_of_birth,p.age_years,p.sex,p.guardian_name,p.emergency_phone,p.created_at,
      c.name,c.phone,c.email,c.address,c.active,
      CASE WHEN p.date_of_birth IS NOT NULL THEN date_part('year', age((now() AT TIME ZONE b.timezone)::date, p.date_of_birth))::int
        ELSE p.age_years + floor(extract(epoch FROM now()-p.created_at)/31557600)::int END AS age,
      EXISTS (SELECT 1 FROM health_consents k WHERE k.business_id=p.business_id AND k.contact_id=p.contact_id AND k.purpose='treatment' AND k.withdrawn_at IS NULL) AS consent_active,
      (SELECT max(v.created_at) FROM health_visits v WHERE v.business_id=p.business_id AND v.contact_id=p.contact_id) AS last_visit_at,
      (SELECT count(*)::int FROM health_visits v WHERE v.business_id=p.business_id AND v.contact_id=p.contact_id) AS visits
      FROM health_patients p JOIN businesses b ON b.id=p.business_id JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id WHERE p.business_id=$1`,
    search: ['name', 'phone', 'patient_no', 'email'], filters: { sex: 'sex', consent: 'consent_active' }, order: 'last_visit_at DESC NULLS LAST,id DESC',
  },
  // Visits as the front desk sees them: who, when, which doctor, billed, and
  // whether the lab report is ready. No clinical fields.
  'health-visits': {
    sql: `SELECT v.id,v.visit_no,v.contact_id,v.appointment_id,v.resource_id,v.status,v.created_at,v.completed_at,v.follow_up_on,v.document_id,
      c.name AS patient_name,c.phone AS patient_phone,p.patient_no,r.name AS doctor_name,d.document_no,d.total AS bill_total,
      (SELECT CASE WHEN count(*)=0 THEN 'none' WHEN bool_and(o.status IN ('approved','cancelled')) THEN 'ready' ELSE 'pending' END
        FROM lab_orders o WHERE o.business_id=v.business_id AND o.visit_id=v.id AND o.status<>'cancelled') AS lab_status
      FROM health_visits v JOIN business_contacts c ON c.business_id=v.business_id AND c.id=v.contact_id
      JOIN health_patients p ON p.business_id=v.business_id AND p.contact_id=v.contact_id
      LEFT JOIN business_resources r ON r.business_id=v.business_id AND r.id=v.resource_id
      LEFT JOIN business_documents d ON d.business_id=v.business_id AND d.id=v.document_id WHERE v.business_id=$1`,
    search: ['patient_name', 'patient_phone', 'patient_no', 'visit_no', 'doctor_name', 'document_no'], date: 'created_at',
    filters: { status: 'status', doctor: 'resource_id', patient: 'contact_id', lab: 'lab_status' }, order: 'created_at DESC,id DESC',
  },
  // Follow-ups due (date filter on the follow-up day).
  'health-follow-ups': {
    sql: `SELECT v.id,v.visit_no,v.contact_id,v.follow_up_on,(v.follow_up_on::timestamp AT TIME ZONE b.timezone) AS follow_up_at,c.name AS patient_name,c.phone AS patient_phone,p.patient_no,r.name AS doctor_name,
      EXISTS (SELECT 1 FROM health_visits n WHERE n.business_id=v.business_id AND n.contact_id=v.contact_id AND n.id<>v.id AND n.created_at>v.created_at AND n.created_at::date>=v.follow_up_on - 2) AS came_back
      FROM health_visits v JOIN businesses b ON b.id=v.business_id JOIN business_contacts c ON c.business_id=v.business_id AND c.id=v.contact_id
      JOIN health_patients p ON p.business_id=v.business_id AND p.contact_id=v.contact_id
      LEFT JOIN business_resources r ON r.business_id=v.business_id AND r.id=v.resource_id WHERE v.business_id=$1 AND v.follow_up_on IS NOT NULL`,
    search: ['patient_name', 'patient_phone', 'patient_no', 'doctor_name'], date: 'follow_up_at', filters: { came_back: 'came_back' }, order: 'follow_up_on,id',
  },
});

// --- Patients ----------------------------------------------------------------------------------

function patientFields(body, todayDay) {
  const dob = h.optionalDate(body.dateOfBirth, 'Date of birth');
  if (dob && dob > todayDay) fail('The date of birth cannot be in the future');
  const age = body.ageYears === undefined || body.ageYears === null || body.ageYears === '' ? null : Number(body.ageYears);
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) fail('Age must be a whole number of years (0 to 130)');
  if (!dob && age === null) fail('Enter the date of birth or the age');
  return {
    dob, age: dob ? null : age, sex: v.requiredEnum(body.sex, 'Sex', ['female', 'male', 'other']),
    guardian: text(body.guardianName, 'Guardian', 150), emergency: text(body.emergencyPhone, 'Emergency phone', 30),
  };
}
function consentInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Record the patient\'s consent for treatment and record keeping', 409, { reason: 'consent_required' });
  const purposes = [...new Set(v.requiredArray(body.purposes ?? ['treatment'], 'Consent purposes'))];
  for (const p of purposes) v.requiredEnum(p, 'Consent purpose', PURPOSES);
  if (!purposes.includes('treatment')) fail('Consent for treatment and record keeping is needed to register a patient', 409, { reason: 'consent_required' });
  return { purposes, method: v.requiredEnum(body.method, 'How consent was given', ['signed_form', 'verbal', 'digital']), givenBy: v.requiredString(body.givenBy, 'Consent given by', 150) };
}
async function addConsents(db, business, user, contactId, consent) {
  const settings = await h.settings(db, business.id);
  const rows = [];
  for (const purpose of consent.purposes) {
    const active = await repo.one(db, 'SELECT * FROM health_consents WHERE business_id=$1 AND contact_id=$2 AND purpose=$3 AND withdrawn_at IS NULL', [business.id, contactId, purpose]);
    if (active) { rows.push(active); continue; }
    const row = await repo.one(db, `INSERT INTO health_consents(business_id,contact_id,purpose,notice_version,method,given_by,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [business.id, contactId, purpose, settings.consent_version, consent.method, consent.givenBy, user.id]);
    await repo.audit(db, business.id, user.id, 'patient.consent_given', contactId, { purpose, version: settings.consent_version, method: consent.method, givenBy: consent.givenBy });
    rows.push(row);
  }
  return rows;
}

// Registers a patient: a new customer contact (or an existing one) plus the
// patient row and consent, in one transaction.
async function register(business, user, body) {
  requireClinic(business);
  await access.require(business, 'patients.create');
  const consent = consentInput(body.consent);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const f = patientFields(body, await h.today(db, business));
    let contact;
    if (body.contactId) {
      contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(body.contactId, 'Customer')]);
      if (!contact) fail('Customer not found', 404);
      if (await repo.one(db, 'SELECT 1 FROM health_patients WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id])) fail(`${contact.name} is already registered as a patient`, 409);
    } else {
      const phone = text(body.phone, 'Phone', 30);
      const name = v.requiredString(body.name, 'Patient name', 150);
      contact = await repo.one(db, `INSERT INTO business_contacts(business_id,kind,name,phone,email,address) VALUES($1,'customer',$2,$3,$4,$5) RETURNING *`,
        [business.id, name, phone, text(body.email, 'Email', 150), text(body.address, 'Address', 300)]);
      await repo.audit(db, business.id, user.id, 'contact.created', contact.id);
    }
    const patientNo = await h.nextNumber(db, business.id, 'patient');
    const patient = await repo.one(db, `INSERT INTO health_patients(business_id,contact_id,patient_no,date_of_birth,age_years,sex,guardian_name,emergency_phone,registered_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [business.id, contact.id, patientNo, f.dob, f.age, f.sex, f.guardian, f.emergency, user.id]);
    await repo.audit(db, business.id, user.id, 'patient.registered', contact.id, { patientNo, name: contact.name });
    const consents = await addConsents(db, business, user, contact.id, consent);
    return { ...patient, name: contact.name, phone: contact.phone, consents };
  });
}

async function updatePatient(business, user, contactId, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM health_patients WHERE business_id=$1 AND contact_id=$2 FOR UPDATE', [business.id, id(contactId, 'Patient')]);
    if (!current) fail('Patient not found', 404);
    const f = patientFields({ dateOfBirth: current.date_of_birth ? String(current.date_of_birth).slice(0, 10) : null, ageYears: current.age_years, sex: current.sex,
      guardianName: current.guardian_name, emergencyPhone: current.emergency_phone, ...body }, await h.today(db, business));
    const row = await repo.one(db, `UPDATE health_patients SET date_of_birth=$3,age_years=$4,sex=$5,guardian_name=$6,emergency_phone=$7,updated_by=$8,updated_at=now()
      WHERE business_id=$1 AND contact_id=$2 RETURNING *`, [business.id, current.contact_id, f.dob, f.age, f.sex, f.guardian, f.emergency, user.id]);
    if (body.name !== undefined || body.phone !== undefined || body.address !== undefined || body.email !== undefined) {
      const contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, current.contact_id]);
      await db.query('UPDATE business_contacts SET name=$3,phone=$4,email=$5,address=$6,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, current.contact_id,
        body.name === undefined ? contact.name : v.requiredString(body.name, 'Patient name', 150),
        body.phone === undefined ? contact.phone : text(body.phone, 'Phone', 30),
        body.email === undefined ? contact.email : text(body.email, 'Email', 150),
        body.address === undefined ? contact.address : text(body.address, 'Address', 300)]);
    }
    await repo.audit(db, business.id, user.id, 'patient.updated', current.contact_id, {});
    return row;
  });
}

// The patient as anyone with patients.view sees them; the clinical part only
// for clinical roles (and that read is logged).
async function patient(business, contactId) {
  requireClinic(business);
  await access.require(business, 'patients.view');
  const contact = id(contactId, 'Patient');
  const row = await repo.one(repo.pool, `SELECT p.*,c.name,c.phone,c.email,c.address,c.active FROM health_patients p
    JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id WHERE p.business_id=$1 AND p.contact_id=$2`, [business.id, contact]);
  if (!row) fail('Patient not found', 404);
  const day = await h.today(repo.pool, business);
  const [consents, visits, appointments, labOrders] = await Promise.all([
    repo.all(repo.pool, `SELECT k.*,u.name AS recorded_by_name,w.name AS withdrawn_by_name FROM health_consents k JOIN users u ON u.id=k.recorded_by
      LEFT JOIN users w ON w.id=k.withdrawn_by WHERE k.business_id=$1 AND k.contact_id=$2 ORDER BY k.created_at DESC,k.id DESC`, [business.id, contact]),
    repo.all(repo.pool, `SELECT v.id,v.visit_no,v.status,v.created_at,v.completed_at,v.follow_up_on,v.document_id,r.name AS doctor_name,d.document_no FROM health_visits v
      LEFT JOIN business_resources r ON r.business_id=v.business_id AND r.id=v.resource_id LEFT JOIN business_documents d ON d.business_id=v.business_id AND d.id=v.document_id
      WHERE v.business_id=$1 AND v.contact_id=$2 ORDER BY v.created_at DESC LIMIT 50`, [business.id, contact]),
    access.can(business, 'appointments.view') ? repo.all(repo.pool, `SELECT a.id,a.starts_at,a.status,r.name AS resource_name,s.label AS service_name FROM business_appointments a
      JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
      WHERE a.business_id=$1 AND a.contact_id=$2 ORDER BY a.starts_at DESC LIMIT 20`, [business.id, contact]) : [],
    business.modules.includes('lab') && access.can(business, 'lab.view') ? repo.all(repo.pool, `SELECT id,order_no,status,created_at,approved_at,visit_id FROM lab_orders
      WHERE business_id=$1 AND contact_id=$2 ORDER BY created_at DESC LIMIT 30`, [business.id, contact]) : [],
  ]);
  let clinical = null;
  if (canClinical(business)) {
    clinical = await repo.one(repo.pool, 'SELECT * FROM health_patient_clinical WHERE business_id=$1 AND contact_id=$2', [business.id, contact]) || {};
    await logClinicalView(business, contact, 'patient summary', { patientNo: row.patient_no });
  }
  return { ...row, age: h.ageOn(row, day).years, consents, visits, appointments, lab_orders: labOrders, clinical, clinical_access: canClinical(business),
    consent_active: consents.some((k) => k.purpose === 'treatment' && !k.withdrawn_at) };
}

async function saveClinical(business, user, contactId, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit_clinical');
  return repo.transaction(async (db) => {
    const p = await repo.one(db, 'SELECT contact_id FROM health_patients WHERE business_id=$1 AND contact_id=$2', [business.id, id(contactId, 'Patient')]);
    if (!p) fail('Patient not found', 404);
    const blood = body.bloodGroup === undefined || body.bloodGroup === null || body.bloodGroup === '' ? null
      : v.requiredEnum(body.bloodGroup, 'Blood group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
    const row = await repo.one(db, `INSERT INTO health_patient_clinical(business_id,contact_id,blood_group,allergies,conditions,current_medicines,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (business_id,contact_id) DO UPDATE SET blood_group=EXCLUDED.blood_group,allergies=EXCLUDED.allergies,conditions=EXCLUDED.conditions,
        current_medicines=EXCLUDED.current_medicines,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, p.contact_id, blood, text(body.allergies, 'Allergies', 500), text(body.conditions, 'Long-term conditions', 500), text(body.currentMedicines, 'Current medicines', 500), user.id]);
    await repo.audit(db, business.id, user.id, 'patient.clinical_updated', p.contact_id, { fields: ['blood group', 'allergies', 'conditions', 'current medicines'] });
    return row;
  });
}

async function giveConsent(business, user, contactId, body) {
  requireClinic(business);
  await access.require(business, 'patients.create');
  const consent = consentInput({ ...body, purposes: body.purposes });
  return repo.transaction(async (db) => {
    const p = await repo.one(db, 'SELECT contact_id FROM health_patients WHERE business_id=$1 AND contact_id=$2', [business.id, id(contactId, 'Patient')]);
    if (!p) fail('Patient not found', 404);
    return addConsents(db, business, user, p.contact_id, consent);
  });
}
// Optional purposes may be added without re-taking treatment consent.
async function addConsent(business, user, contactId, body) {
  requireClinic(business);
  await access.require(business, 'patients.create');
  const purpose = v.requiredEnum(body.purpose, 'Consent purpose', PURPOSES);
  const method = v.requiredEnum(body.method, 'How consent was given', ['signed_form', 'verbal', 'digital']);
  const givenBy = v.requiredString(body.givenBy, 'Consent given by', 150);
  return repo.transaction(async (db) => {
    const p = await repo.one(db, 'SELECT contact_id FROM health_patients WHERE business_id=$1 AND contact_id=$2', [business.id, id(contactId, 'Patient')]);
    if (!p) fail('Patient not found', 404);
    return (await addConsents(db, business, user, p.contact_id, { purposes: [purpose], method, givenBy }))[0];
  });
}
async function withdrawConsent(business, user, consentId, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit');
  const reason = v.requiredString(body.reason, 'Reason (as the patient gave it)', 300);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, 'SELECT * FROM health_consents WHERE business_id=$1 AND id=$2 AND withdrawn_at IS NULL FOR UPDATE', [business.id, id(consentId, 'Consent')]);
    if (!row) fail('This consent is not active', 409);
    const saved = await repo.one(db, 'UPDATE health_consents SET withdrawn_at=now(),withdrawn_by=$3,withdrawal_reason=$4 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, row.id, user.id, reason]);
    await repo.audit(db, business.id, user.id, 'patient.consent_withdrawn', row.contact_id, { purpose: row.purpose, reason });
    return saved;
  });
}
async function requireConsent(db, business, contactId) {
  const ok = await repo.one(db, "SELECT 1 FROM health_consents WHERE business_id=$1 AND contact_id=$2 AND purpose='treatment' AND withdrawn_at IS NULL", [business.id, contactId]);
  if (!ok) fail('This patient has no active consent for treatment. Record their consent first (or they withdrew it).', 409, { reason: 'consent_required' });
}

// --- Visits (consultations) ------------------------------------------------------------------

const VITALS = [['bpSystolic', 'bp_systolic', 'BP systolic', 40, 300, 0], ['bpDiastolic', 'bp_diastolic', 'BP diastolic', 20, 200, 0], ['pulse', 'pulse', 'Pulse', 20, 250, 0],
  ['temperatureC', 'temperature_c', 'Temperature (°C)', 30, 45, 1], ['spo2', 'spo2', 'SpO2', 50, 100, 0], ['respRate', 'resp_rate', 'Breathing rate', 4, 80, 0],
  ['weightKg', 'weight_kg', 'Weight (kg)', 0.5, 400, 1], ['heightCm', 'height_cm', 'Height (cm)', 20, 250, 1]];
const CLINICAL_TEXT = [['complaints', 'complaints', 'Complaints', 2000], ['examination', 'examination', 'Examination', 2000], ['diagnosis', 'diagnosis', 'Diagnosis', 1000],
  ['advice', 'advice', 'Advice', 2000]];

// Opens a visit: from an appointment (the doctor and patient come from it) or for a walk-in patient.
async function openVisit(business, user, body) {
  requireClinic(business);
  await access.requireAny(business, ['patients.edit_clinical', 'patients.create']);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    let contactId = optionalId(body.contactId, 'Patient');
    let resourceId = optionalId(body.resourceId, 'Doctor');
    let appointment = null;
    if (body.appointmentId) {
      appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(body.appointmentId, 'Appointment')]);
      if (!appointment) fail('Appointment not found', 404);
      const existing = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND appointment_id=$2', [business.id, appointment.id]);
      if (existing) return existing;
      if (appointment.status === 'cancelled' || appointment.status === 'no_show') fail('This appointment was cancelled or missed', 409);
      contactId = appointment.contact_id; resourceId = appointment.resource_id;
    }
    if (!contactId) fail('Choose the patient or the appointment');
    const p = await repo.one(db, 'SELECT * FROM health_patients WHERE business_id=$1 AND contact_id=$2', [business.id, contactId]);
    if (!p) fail('Register this person as a patient (with consent) before the visit', 409, { reason: 'not_a_patient' });
    await requireConsent(db, business, contactId);
    if (resourceId && !await repo.one(db, 'SELECT 1 FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, resourceId])) fail('Doctor not found', 404);
    const doctor = resourceId ? await repo.one(db, "SELECT id FROM health_signatories WHERE business_id=$1 AND resource_id=$2 AND kind='doctor' AND active", [business.id, resourceId]) : null;
    const visitNo = await h.nextNumber(db, business.id, 'visit');
    const row = await repo.one(db, `INSERT INTO health_visits(business_id,visit_no,contact_id,appointment_id,resource_id,doctor_signatory_id,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [business.id, visitNo, contactId, appointment?.id || null, resourceId, doctor?.id || null, user.id]);
    await repo.audit(db, business.id, user.id, 'visit.opened', row.id, { visitNo, patientNo: p.patient_no, appointmentId: appointment?.id || null });
    await repo.event(db, business.id, user.id, 'visit.opened', 'visit', row.id, { contactId, resourceId, appointmentId: appointment?.id || null });
    return row;
  });
}

function readItems(value) {
  const items = v.requiredArray(value, 'Prescription');
  if (items.length > 30) fail('A prescription has at most 30 medicines');
  return items.map((item, index) => ({
    drugName: v.requiredString(item?.drugName, `Medicine ${index + 1}`, 150), strength: text(item.strength, 'Strength', 60), dose: text(item.dose, 'Dose', 60),
    frequency: text(item.frequency, 'How often', 60), duration: text(item.duration, 'For how long', 60), instructions: text(item.instructions, 'Instructions', 200),
  }));
}

// Saves the consultation (vitals, notes, diagnosis, prescription, follow-up);
// `complete: true` closes it and marks its appointment completed.
async function saveVisit(business, user, visitId, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit_clinical');
  return repo.transaction(async (db) => {
    const visit = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(visitId, 'Visit')]);
    if (!visit) fail('Visit not found', 404);
    if (visit.status === 'completed') fail('This consultation is completed; add a note to correct it', 409);
    const sets = {};
    for (const [key, column, name, min, max, places] of VITALS) {
      if (body[key] === undefined) continue;
      if (body[key] === null || body[key] === '') { sets[column] = null; continue; }
      const n = v.requiredNumber(Number(body[key]), name, { min, max });
      if (!places && !Number.isInteger(n)) fail(`${name} is a whole number`);
      sets[column] = places ? n.toFixed(places) : n;
    }
    for (const [key, column, name, max] of CLINICAL_TEXT) if (body[key] !== undefined) sets[column] = text(body[key], name, max);
    if (body.icd10Code !== undefined) {
      const code = text(body.icd10Code, 'ICD-10 code', 10)?.toUpperCase() || null;
      if (code && !/^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/.test(code)) fail('An ICD-10 code looks like J06.9 or E11');
      sets.icd10_code = code;
    }
    if (body.followUpOn !== undefined) {
      const f = h.optionalDate(body.followUpOn, 'Follow-up date');
      const visitDay = (await repo.one(db, 'SELECT (created_at AT TIME ZONE $2)::date::text AS day FROM health_visits WHERE business_id=$1 AND id=$3', [business.id, business.timezone, visit.id])).day;
      if (f && f < visitDay) fail('The follow-up date is before the visit');
      sets.follow_up_on = f;
    }
    if (body.resourceId !== undefined) {
      const resourceId = optionalId(body.resourceId, 'Doctor');
      if (resourceId && !await repo.one(db, 'SELECT 1 FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, resourceId])) fail('Doctor not found', 404);
      sets.resource_id = resourceId;
      sets.doctor_signatory_id = resourceId ? (await repo.one(db, "SELECT id FROM health_signatories WHERE business_id=$1 AND resource_id=$2 AND kind='doctor' AND active", [business.id, resourceId]))?.id || null : null;
    }
    const keys = Object.keys(sets);
    if (keys.length) {
      await db.query(`UPDATE health_visits SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(',')},updated_by=$${keys.length + 3},updated_at=now() WHERE business_id=$1 AND id=$2`,
        [business.id, visit.id, ...keys.map((k) => sets[k]), user.id]);
    }
    if (body.prescription !== undefined) {
      const items = readItems(body.prescription);
      await db.query('DELETE FROM health_prescription_items WHERE business_id=$1 AND visit_id=$2', [business.id, visit.id]);
      for (const [index, item] of items.entries()) {
        await db.query(`INSERT INTO health_prescription_items(business_id,visit_id,drug_name,strength,dose,frequency,duration,instructions,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [business.id, visit.id, item.drugName, item.strength, item.dose, item.frequency, item.duration, item.instructions, index]);
      }
    }
    if (body.complete === true) {
      const now = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2', [business.id, visit.id]);
      if (!now.complaints && !now.diagnosis) fail('Write the complaints or the diagnosis before completing the consultation');
      await db.query("UPDATE health_visits SET status='completed',completed_by=$3,completed_at=now(),updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, visit.id, user.id]);
      if (visit.appointment_id) {
        const a = await repo.one(db, "UPDATE business_appointments SET status='completed' WHERE business_id=$1 AND id=$2 AND status='booked' RETURNING id", [business.id, visit.appointment_id]);
        if (a) {
          await repo.audit(db, business.id, user.id, 'appointment.completed', a.id);
          await repo.event(db, business.id, user.id, 'appointment.completed', 'appointment', a.id, { status: 'completed', visitId: visit.id });
        }
      }
      await repo.event(db, business.id, user.id, 'visit.completed', 'visit', visit.id, { contactId: visit.contact_id, followUpOn: now.follow_up_on });
    }
    await repo.audit(db, business.id, user.id, body.complete === true ? 'visit.completed' : 'visit.updated', visit.id, { visitNo: visit.visit_no, fields: keys, prescription: body.prescription !== undefined });
    return repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2', [business.id, visit.id]);
  });
}

async function addVisitNote(business, user, visitId, body) {
  requireClinic(business);
  await access.require(business, 'patients.edit_clinical');
  return repo.transaction(async (db) => {
    const visit = await repo.one(db, 'SELECT id,visit_no FROM health_visits WHERE business_id=$1 AND id=$2', [business.id, id(visitId, 'Visit')]);
    if (!visit) fail('Visit not found', 404);
    const row = await repo.one(db, 'INSERT INTO health_visit_notes(business_id,visit_id,body,created_by) VALUES($1,$2,$3,$4) RETURNING *', [business.id, visit.id,
      v.requiredString(body.body, 'Note', 2000), user.id]);
    await repo.audit(db, business.id, user.id, 'visit.note_added', visit.id, { visitNo: visit.visit_no });
    return row;
  });
}

// A visit: its front-desk facts for anyone with patients.view; the clinical
// record (vitals, notes, prescription, lab results) only for clinical roles.
async function visit(business, visitId) {
  requireClinic(business);
  await access.require(business, 'patients.view');
  const row = await repo.one(repo.pool, `SELECT v.*,c.name AS patient_name,c.phone AS patient_phone,c.address AS patient_address,p.patient_no,p.sex,p.date_of_birth,p.age_years,p.created_at AS registered_at,
      r.name AS doctor_name,g.name AS doctor_signed_name,g.qualification AS doctor_qualification,g.registration_no AS doctor_reg_no,g.council AS doctor_council,
      d.document_no,d.total AS bill_total,a.starts_at AS appointment_at
    FROM health_visits v JOIN business_contacts c ON c.business_id=v.business_id AND c.id=v.contact_id JOIN health_patients p ON p.business_id=v.business_id AND p.contact_id=v.contact_id
    LEFT JOIN business_resources r ON r.business_id=v.business_id AND r.id=v.resource_id LEFT JOIN health_signatories g ON g.business_id=v.business_id AND g.id=v.doctor_signatory_id
    LEFT JOIN business_documents d ON d.business_id=v.business_id AND d.id=v.document_id LEFT JOIN business_appointments a ON a.business_id=v.business_id AND a.id=v.appointment_id
    WHERE v.business_id=$1 AND v.id=$2`, [business.id, id(visitId, 'Visit')]);
  if (!row) fail('Visit not found', 404);
  const orders = business.modules.includes('lab') ? await repo.all(repo.pool, `SELECT id,order_no,status,approved_at FROM lab_orders WHERE business_id=$1 AND visit_id=$2 ORDER BY id`, [business.id, row.id]) : [];
  const age = h.ageOn({ date_of_birth: row.date_of_birth, age_years: row.age_years, created_at: row.registered_at }, String(new Date(row.created_at).toISOString()).slice(0, 10)).years;
  const front = {
    id: row.id, visit_no: row.visit_no, contact_id: row.contact_id, patient_name: row.patient_name, patient_phone: row.patient_phone, patient_no: row.patient_no, sex: row.sex, age,
    appointment_id: row.appointment_id, appointment_at: row.appointment_at, resource_id: row.resource_id, doctor_name: row.doctor_name, status: row.status,
    created_at: row.created_at, completed_at: row.completed_at, follow_up_on: row.follow_up_on, document_id: row.document_id, document_no: row.document_no, bill_total: row.bill_total,
    lab_orders: orders, lab_status: !orders.filter((o) => o.status !== 'cancelled').length ? 'none' : orders.every((o) => ['approved', 'cancelled'].includes(o.status)) ? 'ready' : 'pending',
    clinical_access: canClinical(business),
  };
  if (!canClinical(business)) return front;
  const [items, notes, results] = await Promise.all([
    repo.all(repo.pool, 'SELECT * FROM health_prescription_items WHERE business_id=$1 AND visit_id=$2 ORDER BY sort_order,id', [business.id, row.id]),
    repo.all(repo.pool, 'SELECT n.*,u.name AS created_by_name FROM health_visit_notes n JOIN users u ON u.id=n.created_by WHERE n.business_id=$1 AND n.visit_id=$2 ORDER BY n.id', [business.id, row.id]),
    orders.length ? repo.all(repo.pool, `SELECT o.order_no,o.status,t.name AS test_name,pm.name AS parameter,r.value_numeric,r.value_text,r.unit,r.range_text,r.flag FROM lab_results r
      JOIN lab_orders o ON o.business_id=r.business_id AND o.id=r.order_id JOIN lab_order_tests ot ON ot.business_id=r.business_id AND ot.id=r.order_test_id
      JOIN lab_tests t ON t.business_id=ot.business_id AND t.id=ot.test_id JOIN lab_parameters pm ON pm.business_id=r.business_id AND pm.id=r.parameter_id
      WHERE r.business_id=$1 AND o.visit_id=$2 AND o.status='approved' ORDER BY o.id,t.name,pm.sort_order`, [business.id, row.id]) : [],
  ]);
  const clinical = await repo.one(repo.pool, 'SELECT * FROM health_patient_clinical WHERE business_id=$1 AND contact_id=$2', [business.id, row.contact_id]);
  await logClinicalView(business, row.contact_id, 'consultation', { visitNo: row.visit_no });
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));
  return { ...front, ...pick(['bp_systolic', 'bp_diastolic', 'pulse', 'temperature_c', 'spo2', 'resp_rate', 'weight_kg', 'height_cm', 'complaints', 'examination', 'diagnosis',
    'icd10_code', 'advice', 'doctor_signed_name', 'doctor_qualification', 'doctor_reg_no', 'doctor_council', 'patient_address']),
  prescription: items, notes, lab_results: results, patient_clinical: clinical || {} };
}

// Bills a visit: the appointment's service (the consultation) and any extra
// lines, posted as a normal sale; the visit keeps the bill.
async function billVisit(business, user, visitId, body) {
  requireClinic(business);
  await access.require(business, 'sales.create');
  const key = body.documentId ? null : h.requestKey(body.requestKey);
  const extra = body.lines === undefined ? [] : v.requiredArray(body.lines, 'Lines');
  let paidNow = null;
  if (body.payment) {
    await access.require(business, 'sales.edit');
    const amount = body.payment.amount === 'full' ? 'full' : core.decimal(body.payment.amount, 'Amount paid now', 2, 0, 100000000);
    paidNow = amount === 'full' || amount > 0 ? { amount, method: v.requiredEnum(body.payment.method, 'Payment method', ['cash', 'card', 'upi', 'bank', 'cheque']), reference: text(body.payment.reference, 'Payment reference', 100) } : null;
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const visitRow = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(visitId, 'Visit')]);
    if (!visitRow) fail('Visit not found', 404);
    if (visitRow.document_id) {
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, visitRow.document_id]);
      if (doc.request_key === key || Number(doc.id) === Number(body.documentId)) return { visit: visitRow, document: doc, repeated: true };
      fail(`This visit is already billed (${doc.document_no})`, 409);
    }
    // The bill raised at the front desk before the consultation is linked, not raised again.
    if (body.documentId) {
      const doc = await repo.one(db, "SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 AND kind='sale'", [business.id, id(body.documentId, 'Bill')]);
      if (!doc || Number(doc.contact_id) !== Number(visitRow.contact_id)) fail('That bill is not this patient\'s', 409);
      if (await repo.one(db, 'SELECT 1 FROM health_visits WHERE business_id=$1 AND document_id=$2', [business.id, doc.id])) fail(`${doc.document_no} is already linked to a visit`, 409);
      await db.query('UPDATE health_visits SET document_id=$3 WHERE business_id=$1 AND id=$2', [business.id, visitRow.id, doc.id]);
      await repo.audit(db, business.id, user.id, 'visit.billed', visitRow.id, { visitNo: visitRow.visit_no, documentNo: doc.document_no, linked: true });
      return { visit: { ...visitRow, document_id: doc.id }, document: doc, linked: true };
    }
    const lines = [];
    if (visitRow.appointment_id && body.includeConsultation !== false) {
      const a = await repo.one(db, 'SELECT sku_id FROM business_appointments WHERE business_id=$1 AND id=$2', [business.id, visitRow.appointment_id]);
      lines.push({ skuId: a.sku_id, quantity: '1' });
    }
    for (const line of extra) lines.push({ skuId: id(line?.skuId, 'Item'), quantity: String(line.quantity ?? '1') });
    if (!lines.length) fail('Add the consultation or a service to bill');
    const input = { kind: 'sale', locationId: id(body.locationId, 'Location'), contactId: visitRow.contact_id, lines, payment: body.payment, notes: `Visit ${visitRow.visit_no}` };
    const document = await core.postDocument(db, business, user, input, { kind: 'sale', requestKey: key, hash: h.hashOf({ visitId: visitRow.id, ...input }), lines, paidNow });
    // The time stamp alone is written by the database (a completed visit is otherwise fixed).
    await db.query('UPDATE health_visits SET document_id=$3 WHERE business_id=$1 AND id=$2', [business.id, visitRow.id, document.id]);
    await repo.audit(db, business.id, user.id, 'visit.billed', visitRow.id, { visitNo: visitRow.visit_no, documentNo: document.document_no });
    return { visit: { ...visitRow, document_id: document.id }, document };
  });
}

// Today's patients for the doctor and the front desk: the appointments of the
// day with their visit (if opened) and its state. No clinical fields.
async function today(business, query) {
  requireClinic(business);
  await access.require(business, 'patients.view');
  const day = query.day ? h.dateOnly(query.day, 'Day') : await h.today(repo.pool, business);
  const resource = optionalId(query.doctor, 'Doctor');
  const rows = await repo.all(repo.pool, `SELECT a.id AS appointment_id,a.starts_at,a.ends_at,a.status AS appointment_status,a.contact_id,a.resource_id,c.name AS patient_name,c.phone AS patient_phone,
      p.patient_no,(p.contact_id IS NOT NULL) AS registered,r.name AS doctor_name,s.label AS service_name,v.id AS visit_id,v.visit_no,v.status AS visit_status,v.document_id,
      EXISTS (SELECT 1 FROM health_consents k WHERE k.business_id=a.business_id AND k.contact_id=a.contact_id AND k.purpose='treatment' AND k.withdrawn_at IS NULL) AS consent_active,
      (SELECT CASE WHEN count(*)=0 THEN 'none' WHEN bool_and(o.status='approved') THEN 'ready' ELSE 'pending' END FROM lab_orders o
        WHERE o.business_id=v.business_id AND o.visit_id=v.id AND o.status<>'cancelled') AS lab_status
    FROM business_appointments a JOIN businesses b ON b.id=a.business_id
    JOIN business_contacts c ON c.business_id=a.business_id AND c.id=a.contact_id JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
    JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
    LEFT JOIN health_patients p ON p.business_id=a.business_id AND p.contact_id=a.contact_id
    LEFT JOIN health_visits v ON v.business_id=a.business_id AND v.appointment_id=a.id
    WHERE a.business_id=$1 AND (a.starts_at AT TIME ZONE b.timezone)::date=$2::date AND ($3::bigint IS NULL OR a.resource_id=$3)
    ORDER BY a.starts_at,a.id`, [business.id, day, resource]);
  const walkIns = await repo.all(repo.pool, `SELECT v.id AS visit_id,v.visit_no,v.status AS visit_status,v.contact_id,v.created_at,c.name AS patient_name,p.patient_no,r.name AS doctor_name,v.document_id
    FROM health_visits v JOIN businesses b ON b.id=v.business_id JOIN business_contacts c ON c.business_id=v.business_id AND c.id=v.contact_id
    JOIN health_patients p ON p.business_id=v.business_id AND p.contact_id=v.contact_id LEFT JOIN business_resources r ON r.business_id=v.business_id AND r.id=v.resource_id
    WHERE v.business_id=$1 AND v.appointment_id IS NULL AND (v.created_at AT TIME ZONE b.timezone)::date=$2::date AND ($3::bigint IS NULL OR v.resource_id=$3) ORDER BY v.created_at`,
  [business.id, day, resource]);
  return { day, appointments: rows, walk_ins: walkIns };
}

module.exports = { requireClinic, register, updatePatient, patient, saveClinical, giveConsent, addConsent, withdrawConsent, requireConsent, openVisit, saveVisit, addVisitNote,
  visit, billVisit, today, logClinicalView };
