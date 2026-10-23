const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const clinic = require('./businessClinic.service');
const h = require('./healthCommon');

// The clinic's front desk:
//
//   Doctors     each doctor's consultation fee (a service on the bill), the
//               reduced or free follow-up within N days of a paid visit, the
//               length of an appointment slot and their share of the fees;
//               OPD sessions by weekday (mornings and evenings) and leave.
//               Booking an appointment outside a doctor's sessions, or on
//               leave, is refused once the doctor has sessions set.
//   Tokens      the day's queue: a number per doctor per day on arrival,
//               called in turn (priority first), the consultation started from
//               the token, and done when the visit is completed. A session may
//               cap its tokens (max patients).

const { fail, id, optionalId, text } = h;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function readTime(value, name) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(`${name} must be a time (HH:MM)`);
  return value;
}

async function lockDoctor(db, business, resourceId) {
  const row = await repo.one(db, 'SELECT * FROM business_resources WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(resourceId, 'Doctor')]);
  if (!row) fail('Doctor not found', 404);
  access.requireLocation(business, row.location_id);
  return row;
}

async function serviceSku(db, business, value, name) {
  const skuId = optionalId(value, name);
  if (!skuId) return null;
  const sku = await repo.one(db, `SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.id=$2 AND p.kind='service'`, [business.id, skuId]);
  if (!sku) fail(`${name} must be one of your services`, 404);
  return sku.id;
}

// --- Doctors: fees, sessions, leave -----------------------------------------------------

const DOCTOR_SQL = `SELECT r.id,r.name,r.role_label,r.location_id,r.active,l.name AS location_name,
    g.id AS signatory_id,g.name AS signed_name,g.qualification,g.registration_no,
    (g.id IS NOT NULL OR p.resource_id IS NOT NULL) AS is_doctor,
    p.speciality,p.consultation_sku_id,p.follow_up_sku_id,COALESCE(p.follow_up_days,0) AS follow_up_days,COALESCE(p.slot_minutes,10) AS slot_minutes,
    COALESCE(p.share_percent,0) AS share_percent,cs.label AS consultation_label,cs.price AS consultation_price,fs.label AS follow_up_label,fs.price AS follow_up_price,
    COALESCE((SELECT json_agg(json_build_object('id',s.id,'dow',s.dow,'starts',to_char(s.starts,'HH24:MI'),'ends',to_char(s.ends,'HH24:MI'),'max_patients',s.max_patients)
      ORDER BY s.dow,s.starts) FROM health_doctor_sessions s WHERE s.business_id=r.business_id AND s.resource_id=r.id),'[]') AS sessions,
    COALESCE((SELECT json_agg(json_build_object('id',lv.id,'from_date',lv.from_date::text,'to_date',lv.to_date::text,'reason',lv.reason) ORDER BY lv.from_date)
      FROM health_doctor_leave lv JOIN businesses b ON b.id=lv.business_id WHERE lv.business_id=r.business_id AND lv.resource_id=r.id AND lv.cancelled_at IS NULL
      AND lv.to_date >= (now() AT TIME ZONE b.timezone)::date),'[]') AS leave
  FROM business_resources r JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
  LEFT JOIN health_signatories g ON g.business_id=r.business_id AND g.resource_id=r.id AND g.kind='doctor' AND g.active
  LEFT JOIN health_doctor_profiles p ON p.business_id=r.business_id AND p.resource_id=r.id
  LEFT JOIN catalog_skus cs ON cs.business_id=p.business_id AND cs.id=p.consultation_sku_id
  LEFT JOIN catalog_skus fs ON fs.business_id=p.business_id AND fs.id=p.follow_up_sku_id
  WHERE r.business_id=$1`;

// Doctors (and rooms) at the branch in view, with their fees, OPD and leave.
async function doctors(business, query = {}) {
  clinic.requireClinic(business);
  await access.require(business, 'appointments.view');
  const location = optionalId(query.location, 'Location');
  return repo.all(repo.pool, `${DOCTOR_SQL} AND ($2::bigint IS NULL OR r.location_id=$2) ORDER BY r.active DESC,(g.id IS NOT NULL OR p.resource_id IS NOT NULL) DESC,r.name`,
    [business.id, location]);
}

// body: { speciality, consultationSkuId, followUpSkuId, followUpDays, slotMinutes, sharePercent,
//         sessions: [{ dow, starts: 'HH:MM', ends: 'HH:MM', maxPatients }] }
async function saveDoctor(business, user, resourceId, body) {
  clinic.requireClinic(business);
  await access.require(business, 'settings.edit');
  const followUpDays = v.requiredNumber(Number(body.followUpDays ?? 0), 'Follow-up days', { min: 0, max: 90 });
  const slotMinutes = v.requiredNumber(Number(body.slotMinutes ?? 10), 'Slot length', { min: 5, max: 120 });
  if (!Number.isInteger(followUpDays) || !Number.isInteger(slotMinutes)) fail('Follow-up days and slot length are whole numbers');
  const share = core.decimal(body.sharePercent ?? 0, "Doctor's share", 2, 0, 100);
  const sessions = body.sessions === undefined ? null : v.requiredArray(body.sessions, 'OPD sessions').map((s, i) => {
    const dow = Number(s?.dow);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) fail(`Session ${i + 1}: choose the day`);
    const starts = readTime(s.starts, `Session ${i + 1} start`), ends = readTime(s.ends, `Session ${i + 1} end`);
    if (ends <= starts) fail(`${DAYS[dow]} ${starts}: the session ends before it starts`);
    const max = s.maxPatients === undefined || s.maxPatients === null || s.maxPatients === '' ? null : v.requiredNumber(Number(s.maxPatients), 'Max patients', { min: 1, max: 500 });
    return { dow, starts, ends, max };
  });
  if (sessions && sessions.length > 28) fail('At most 28 OPD sessions a week');
  if (sessions) {
    for (const a of sessions) for (const b of sessions) {
      if (a !== b && a.dow === b.dow && a.starts < b.ends && b.starts < a.ends) fail(`${DAYS[a.dow]}: the sessions ${a.starts}–${a.ends} and ${b.starts}–${b.ends} overlap`);
    }
  }
  return repo.transaction(async (db) => {
    const doctor = await lockDoctor(db, business, resourceId);
    const consultation = await serviceSku(db, business, body.consultationSkuId, 'Consultation fee');
    const followUp = await serviceSku(db, business, body.followUpSkuId, 'Follow-up fee');
    if (followUp && !consultation) fail('Choose the consultation fee before the follow-up fee');
    await db.query(`INSERT INTO health_doctor_profiles(business_id,resource_id,speciality,consultation_sku_id,follow_up_sku_id,follow_up_days,slot_minutes,share_percent,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
      ON CONFLICT (business_id,resource_id) DO UPDATE SET speciality=EXCLUDED.speciality,consultation_sku_id=EXCLUDED.consultation_sku_id,follow_up_sku_id=EXCLUDED.follow_up_sku_id,
        follow_up_days=EXCLUDED.follow_up_days,slot_minutes=EXCLUDED.slot_minutes,share_percent=EXCLUDED.share_percent,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, doctor.id, text(body.speciality, 'Speciality', 80), consultation, followUp, followUpDays, slotMinutes, share.toFixed(2), user.id]);
    if (sessions) {
      await db.query('DELETE FROM health_doctor_sessions WHERE business_id=$1 AND resource_id=$2', [business.id, doctor.id]);
      for (const s of sessions) {
        await db.query('INSERT INTO health_doctor_sessions(business_id,resource_id,dow,starts,ends,max_patients) VALUES($1,$2,$3,$4,$5,$6)',
          [business.id, doctor.id, s.dow, s.starts, s.ends, s.max]);
      }
    }
    await repo.audit(db, business.id, user.id, 'doctor.saved', doctor.id, { name: doctor.name, consultation, followUp, followUpDays, slotMinutes, share, sessions: sessions?.length ?? null });
    return repo.one(db, `${DOCTOR_SQL} AND r.id=$2`, [business.id, doctor.id]);
  });
}

async function addLeave(business, user, resourceId, body) {
  clinic.requireClinic(business);
  await access.require(business, 'appointments.edit');
  const from = h.dateOnly(body.fromDate, 'From'), to = h.dateOnly(body.toDate || body.fromDate, 'To');
  if (to < from) fail('The leave ends before it starts');
  return repo.transaction(async (db) => {
    const doctor = await lockDoctor(db, business, resourceId);
    const row = await repo.one(db, `INSERT INTO health_doctor_leave(business_id,resource_id,from_date,to_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [business.id, doctor.id, from, to, text(body.reason, 'Reason', 200), user.id]);
    // Patients already booked on those days are for the desk to call and move.
    const booked = await repo.one(db, `SELECT count(*)::int AS n FROM business_appointments a JOIN businesses b ON b.id=a.business_id
      WHERE a.business_id=$1 AND a.resource_id=$2 AND a.status='booked' AND (a.starts_at AT TIME ZONE b.timezone)::date BETWEEN $3::date AND $4::date`, [business.id, doctor.id, from, to]);
    await repo.audit(db, business.id, user.id, 'doctor.leave_added', doctor.id, { name: doctor.name, from, to, booked: booked.n });
    return { ...row, from_date: from, to_date: to, booked: booked.n };
  });
}

async function cancelLeave(business, user, leaveId) {
  clinic.requireClinic(business);
  await access.require(business, 'appointments.edit');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, 'SELECT * FROM health_doctor_leave WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(leaveId, 'Leave')]);
    if (!row) fail('Leave not found', 404);
    await lockDoctor(db, business, row.resource_id);
    if (row.cancelled_at) return row;
    const done = await repo.one(db, 'UPDATE health_doctor_leave SET cancelled_at=now(),cancelled_by=$3 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, row.id, user.id]);
    await repo.audit(db, business.id, user.id, 'doctor.leave_cancelled', row.resource_id, { leaveId: row.id });
    return done;
  });
}

// Why a doctor cannot see a patient then (null: they can). A doctor with no
// OPD sessions set is bookable at any time, as before.
async function availabilityProblem(db, business, resourceId, starts, ends) {
  const row = await repo.one(db, `WITH t AS (SELECT ($3::timestamptz AT TIME ZONE b.timezone) AS s,($4::timestamptz AT TIME ZONE b.timezone) AS e FROM businesses b WHERE b.id=$1)
    SELECT EXISTS (SELECT 1 FROM health_doctor_sessions WHERE business_id=$1 AND resource_id=$2) AS scheduled,
      EXISTS (SELECT 1 FROM health_doctor_sessions x, t WHERE x.business_id=$1 AND x.resource_id=$2 AND x.dow=extract(dow FROM t.s)
        AND t.s::date=t.e::date AND x.starts<=t.s::time AND x.ends>=t.e::time) AS in_session,
      (SELECT COALESCE(lv.reason,'on leave') FROM health_doctor_leave lv, t WHERE lv.business_id=$1 AND lv.resource_id=$2 AND lv.cancelled_at IS NULL
        AND t.s::date BETWEEN lv.from_date AND lv.to_date LIMIT 1) AS leave,
      (SELECT string_agg(to_char(x.starts,'HH24:MI')||'–'||to_char(x.ends,'HH24:MI'),', ' ORDER BY x.starts) FROM health_doctor_sessions x, t
        WHERE x.business_id=$1 AND x.resource_id=$2 AND x.dow=extract(dow FROM t.s)) AS that_day,
      (SELECT name FROM business_resources WHERE business_id=$1 AND id=$2) AS name`, [business.id, resourceId, starts, ends]);
  if (row.leave) return `${row.name} is on leave that day (${row.leave})`;
  if (row.scheduled && !row.in_session) return row.that_day ? `${row.name} sees patients ${row.that_day} that day` : `${row.name} has no OPD that day`;
  return null;
}

// A doctor's appointment slots for one day, each free or taken.
async function slots(business, query) {
  clinic.requireClinic(business);
  await access.require(business, 'appointments.view');
  const day = h.dateOnly(query.day, 'Day');
  const doctor = await repo.one(repo.pool, `${DOCTOR_SQL} AND r.id=$2`, [business.id, id(query.doctor, 'Doctor')]);
  if (!doctor) fail('Doctor not found', 404);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const sessions = doctor.sessions.filter((s) => s.dow === dow);
  const leave = doctor.leave.find((l) => l.from_date <= day && day <= l.to_date) || null;
  const rows = sessions.length && !leave ? await repo.all(repo.pool, `
    SELECT g AS starts_at, g + make_interval(mins => $4) AS ends_at, g < now() AS past,
      EXISTS (SELECT 1 FROM business_appointments a WHERE a.business_id=$1 AND a.resource_id=$2 AND a.status='booked'
        AND a.starts_at < g + make_interval(mins => $4) AND a.ends_at > g) AS taken
    FROM businesses b, LATERAL unnest($5::text[], $6::text[]) AS s(starts, ends),
      LATERAL generate_series(($3::date + s.starts::time) AT TIME ZONE b.timezone, ($3::date + s.ends::time) AT TIME ZONE b.timezone - make_interval(mins => $4), make_interval(mins => $4)) g
    WHERE b.id=$1 ORDER BY g`, [business.id, doctor.id, day, Number(doctor.slot_minutes), sessions.map((s) => s.starts), sessions.map((s) => s.ends)]) : [];
  return { doctor: { id: doctor.id, name: doctor.name, slot_minutes: doctor.slot_minutes, consultation_sku_id: doctor.consultation_sku_id, consultation_label: doctor.consultation_label,
    consultation_price: doctor.consultation_price },
    day, sessions, leave, scheduled: doctor.sessions.length > 0, slots: rows };
}

// --- Fees ------------------------------------------------------------------------------------

// What a visit's consultation is charged: the doctor's fee, the follow-up fee
// (or nothing) within the follow-up days of their last paid consultation.
// null: the doctor has no fee set (the booked service is billed, as before).
async function feeFor(db, business, visit) {
  if (!visit.resource_id) return null;
  const p = await repo.one(db, `SELECT p.*,cs.label AS consultation_label,cs.price AS consultation_price,fs.label AS follow_up_label,fs.price AS follow_up_price
    FROM health_doctor_profiles p LEFT JOIN catalog_skus cs ON cs.business_id=p.business_id AND cs.id=p.consultation_sku_id
    LEFT JOIN catalog_skus fs ON fs.business_id=p.business_id AND fs.id=p.follow_up_sku_id WHERE p.business_id=$1 AND p.resource_id=$2`, [business.id, visit.resource_id]);
  if (!p?.consultation_sku_id) return null;
  const last = p.follow_up_days > 0 ? await repo.one(db, `SELECT v.id,v.visit_no,(v.created_at AT TIME ZONE b.timezone)::date::text AS day
    FROM health_visits v JOIN businesses b ON b.id=v.business_id
    WHERE v.business_id=$1 AND v.contact_id=$2 AND v.resource_id=$3 AND v.id<>$4 AND v.fee_kind='consultation' AND v.created_at < $5
      AND (v.created_at AT TIME ZONE b.timezone)::date >= ($5::timestamptz AT TIME ZONE b.timezone)::date - $6::int ORDER BY v.created_at DESC LIMIT 1`,
  [business.id, visit.contact_id, visit.resource_id, visit.id, visit.created_at, p.follow_up_days]) : null;
  const window = { follow_up_days: p.follow_up_days, last_consultation: last };
  if (last && p.follow_up_sku_id) return { kind: 'follow_up', skuId: p.follow_up_sku_id, label: p.follow_up_label, price: p.follow_up_price, ...window };
  if (last) return { kind: 'free_follow_up', skuId: null, label: 'Free follow-up', price: '0.00', ...window };
  return { kind: 'consultation', skuId: p.consultation_sku_id, label: p.consultation_label, price: p.consultation_price, ...window };
}

async function visitFee(business, visitId) {
  clinic.requireClinic(business);
  await access.requireAny(business, ['sales.create', 'patients.view']);
  const visit = await repo.one(repo.pool, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2', [business.id, id(visitId, 'Visit')]);
  if (!visit) fail('Visit not found', 404);
  const fee = await feeFor(repo.pool, business, visit);
  if (fee) return fee;
  // No fee set for the doctor: the booked service, if any.
  const booked = visit.appointment_id ? await repo.one(repo.pool, `SELECT s.id,s.label,s.price FROM business_appointments a JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
    WHERE a.business_id=$1 AND a.id=$2`, [business.id, visit.appointment_id]) : null;
  return booked ? { kind: 'booked_service', skuId: booked.id, label: booked.label, price: booked.price } : { kind: 'none', skuId: null };
}

// Each doctor's patients and fees in a period, and their share of the fees.
async function doctorEarnings(business, query) {
  clinic.requireClinic(business);
  await access.require(business, 'reports.view');
  const from = h.dateOnly(query.from, 'From'), to = h.dateOnly(query.to, 'To');
  if (to < from) fail('The end date is before the start date');
  const location = optionalId(query.location, 'Location');
  const rows = await repo.all(repo.pool, `SELECT r.id AS resource_id,r.name,COALESCE(p.share_percent,0) AS share_percent,
      count(v.id)::int AS visits,
      count(v.id) FILTER (WHERE v.fee_kind='consultation')::int AS consultations,
      count(v.id) FILTER (WHERE v.fee_kind='follow_up')::int AS follow_ups,
      count(v.id) FILTER (WHERE v.fee_kind='free_follow_up')::int AS free_follow_ups,
      count(v.id) FILTER (WHERE v.document_id IS NULL AND v.fee_kind IS NULL)::int AS not_billed,
      COALESCE(sum(fee.net),0)::numeric(14,2) AS fees
    FROM health_visits v JOIN businesses b ON b.id=v.business_id
    JOIN business_resources r ON r.business_id=v.business_id AND r.id=v.resource_id
    LEFT JOIN health_doctor_profiles p ON p.business_id=v.business_id AND p.resource_id=v.resource_id
    LEFT JOIN LATERAL (SELECT sum(l.net) AS net FROM business_document_lines l WHERE l.business_id=v.business_id AND l.document_id=v.document_id
      AND l.sku_id=v.fee_sku_id) fee ON TRUE
    WHERE v.business_id=$1 AND (v.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR v.location_id=$4)
    GROUP BY r.id,r.name,p.share_percent ORDER BY fees DESC,r.name`, [business.id, from, to, location]);
  for (const row of rows) row.share = (Math.round(Number(row.fees) * Number(row.share_percent)) / 100).toFixed(2);
  const totals = rows.reduce((t, r) => ({ visits: t.visits + r.visits, fees: t.fees + Number(r.fees), share: t.share + Number(r.share) }), { visits: 0, fees: 0, share: 0 });
  return { from, to, doctors: rows, totals: { visits: totals.visits, fees: totals.fees.toFixed(2), share: totals.share.toFixed(2) } };
}

// --- Token queue -------------------------------------------------------------------------------

const TOKEN_SQL = `SELECT t.*,c.name AS patient_name,c.phone AS patient_phone,p.patient_no,r.name AS doctor_name,v.visit_no,v.status AS visit_status,
    a.starts_at AS appointment_at
  FROM health_tokens t JOIN business_contacts c ON c.business_id=t.business_id AND c.id=t.contact_id
  JOIN health_patients p ON p.business_id=t.business_id AND p.contact_id=t.contact_id
  LEFT JOIN business_resources r ON r.business_id=t.business_id AND r.id=t.resource_id
  LEFT JOIN health_visits v ON v.business_id=t.business_id AND v.id=t.visit_id
  LEFT JOIN business_appointments a ON a.business_id=t.business_id AND a.id=t.appointment_id
  WHERE t.business_id=$1`;
const tokenRow = (db, business, tokenId) => repo.one(db, `${TOKEN_SQL} AND t.id=$2`, [business.id, tokenId]);

// body: { appointmentId } or { contactId, resourceId? }, priority?, note?, locationId?
async function issueToken(business, user, body) {
  clinic.requireClinic(business);
  await access.require(business, 'patients.create');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const day = await h.today(db, business);
    let contactId = optionalId(body.contactId, 'Patient');
    let resourceId = optionalId(body.resourceId, 'Doctor');
    let appointment = null;
    if (body.appointmentId) {
      appointment = await repo.one(db, `SELECT a.*,(a.starts_at AT TIME ZONE b.timezone)::date::text AS day FROM business_appointments a JOIN businesses b ON b.id=a.business_id
        WHERE a.business_id=$1 AND a.id=$2`, [business.id, id(body.appointmentId, 'Appointment')]);
      if (!appointment) fail('Appointment not found', 404);
      if (appointment.status !== 'booked') fail('This appointment is not open', 409);
      if (appointment.day !== day) fail('A token is given on the day of the appointment', 409);
      const existing = await repo.one(db, "SELECT id FROM health_tokens WHERE business_id=$1 AND appointment_id=$2 AND status<>'cancelled'", [business.id, appointment.id]);
      if (existing) return tokenRow(db, business, existing.id);
      contactId = appointment.contact_id; resourceId = appointment.resource_id;
    }
    if (!contactId) fail('Choose the patient or the appointment');
    if (!await repo.one(db, 'SELECT 1 FROM health_patients WHERE business_id=$1 AND contact_id=$2', [business.id, contactId])) {
      fail('Register this person as a patient (with consent) first', 409, { reason: 'not_a_patient' });
    }
    await clinic.requireConsent(db, business, contactId);
    let locationId;
    if (resourceId) {
      const doctor = await repo.one(db, 'SELECT * FROM business_resources WHERE business_id=$1 AND id=$2 AND active', [business.id, resourceId]);
      if (!doctor) fail('Doctor not found', 404);
      locationId = doctor.location_id;
      const now = new Date().toISOString();
      const problem = await availabilityProblem(db, business, resourceId, now, now);
      // On leave is a stop; outside the session is fine (patients come early).
      if (problem && problem.includes('on leave')) fail(problem, 409);
      // The day's cap: the sum of today's sessions' max patients (any open session: no cap).
      const cap = await repo.one(db, `SELECT CASE WHEN count(*)=0 OR bool_or(max_patients IS NULL) THEN NULL ELSE sum(max_patients) END AS cap
        FROM health_doctor_sessions WHERE business_id=$1 AND resource_id=$2 AND dow=extract(dow FROM $3::date)`, [business.id, resourceId, day]);
      if (cap.cap !== null) {
        const used = await repo.one(db, "SELECT count(*)::int AS n FROM health_tokens WHERE business_id=$1 AND resource_id=$2 AND day=$3 AND status<>'cancelled'", [business.id, resourceId, day]);
        if (used.n >= Number(cap.cap)) fail(`${doctor.name}'s OPD is full today (${cap.cap} patients)`, 409, { reason: 'opd_full' });
      }
    } else {
      locationId = optionalId(body.locationId, 'Location') || business.location_scope
        || (await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND active ORDER BY id LIMIT 1', [business.id]))?.id;
    }
    access.requireLocation(business, locationId);
    const waiting = await repo.one(db, `SELECT token_no FROM health_tokens WHERE business_id=$1 AND contact_id=$2 AND COALESCE(resource_id,0)=COALESCE($3::bigint,0) AND day=$4
      AND status IN ('waiting','called','in_consultation')`, [business.id, contactId, resourceId, day]);
    if (waiting) fail(`This patient already holds token ${waiting.token_no} for today`, 409);
    const next = await repo.one(db, `SELECT COALESCE(max(token_no),0)+1 AS n FROM health_tokens WHERE business_id=$1 AND location_id=$2 AND COALESCE(resource_id,0)=COALESCE($3::bigint,0) AND day=$4`,
      [business.id, locationId, resourceId, day]);
    const row = await repo.one(db, `INSERT INTO health_tokens(business_id,location_id,resource_id,day,token_no,contact_id,appointment_id,priority,note,issued_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [business.id, locationId, resourceId, day, next.n, contactId, appointment?.id || null, body.priority === true, text(body.note, 'Note', 200), user.id]);
    await repo.audit(db, business.id, user.id, 'token.issued', row.id, { tokenNo: next.n, contactId, resourceId, day });
    return tokenRow(db, business, row.id);
  });
}

// The day's queue at a branch: every token, and per doctor who is being seen
// now, how many wait and the next few.
async function queue(business, query = {}) {
  clinic.requireClinic(business);
  await access.require(business, 'patients.view');
  const day = query.day ? h.dateOnly(query.day, 'Day') : await h.today(repo.pool, business);
  const location = optionalId(query.location, 'Location');
  const doctor = optionalId(query.doctor, 'Doctor');
  const tokens = await repo.all(repo.pool, `${TOKEN_SQL} AND t.day=$2 AND ($3::bigint IS NULL OR t.location_id=$3) AND ($4::bigint IS NULL OR t.resource_id=$4)
    ORDER BY t.resource_id NULLS LAST,(t.status IN ('waiting','called')) DESC,t.priority DESC,t.token_no`, [business.id, day, location, doctor]);
  const byDoctor = new Map();
  for (const t of tokens) {
    const key = String(t.resource_id || 0);
    if (!byDoctor.has(key)) byDoctor.set(key, { resource_id: t.resource_id, name: t.doctor_name || 'Clinic (no doctor yet)', serving: null, called: null, waiting: 0, done: 0, next: [] });
    const d = byDoctor.get(key);
    if (t.status === 'in_consultation') d.serving = t;
    if (t.status === 'called' && (!d.called || t.called_at > d.called.called_at)) d.called = t;
    if (t.status === 'waiting') { d.waiting += 1; if (d.next.length < 3) d.next.push({ id: t.id, token_no: t.token_no, priority: t.priority }); }
    if (t.status === 'done') d.done += 1;
  }
  return { day, doctors: [...byDoctor.values()], tokens };
}

const TRANSITIONS = {
  call: { from: ['waiting', 'skipped', 'called'], to: 'called' },
  start: { from: ['waiting', 'called', 'skipped'], to: 'in_consultation' },
  done: { from: ['called', 'in_consultation'], to: 'done' },
  skip: { from: ['waiting', 'called'], to: 'skipped' },
  cancel: { from: ['waiting', 'called', 'skipped'], to: 'cancelled' },
};

// body: { action: call | start | done | skip | cancel }. Start opens the
// patient's consultation (from the appointment, if any) and links it.
async function tokenAction(business, user, tokenId, body) {
  clinic.requireClinic(business);
  const action = v.requiredEnum(body.action, 'Action', Object.keys(TRANSITIONS));
  await access.requireAny(business, ['patients.create', 'patients.edit_clinical']);
  const token = await repo.one(repo.pool, 'SELECT * FROM health_tokens WHERE business_id=$1 AND id=$2', [business.id, id(tokenId, 'Token')]);
  if (!token) fail('Token not found', 404);
  access.requireLocation(business, token.location_id);
  const rule = TRANSITIONS[action];
  if (token.status === rule.to && action !== 'call') return tokenRow(repo.pool, business, token.id);
  if (!rule.from.includes(token.status)) fail(`Token ${token.token_no} is ${token.status.replace('_', ' ')}`, 409);
  let visitId = token.visit_id;
  if (action === 'start' && !visitId) {
    const visit = await clinic.openVisit(business, user, token.appointment_id ? { appointmentId: token.appointment_id }
      : { contactId: token.contact_id, resourceId: token.resource_id, locationId: token.location_id });
    visitId = visit.id;
  }
  return repo.transaction(async (db) => {
    const locked = await repo.one(db, 'SELECT * FROM health_tokens WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, token.id]);
    if (!rule.from.includes(locked.status) && !(locked.status === 'in_consultation' && action === 'start')) fail(`Token ${locked.token_no} is ${locked.status.replace('_', ' ')}`, 409);
    await db.query(`UPDATE health_tokens SET status=$3,visit_id=COALESCE($4,visit_id),
        called_at=CASE WHEN $3='called' THEN now() ELSE called_at END,called_count=called_count+CASE WHEN $3='called' THEN 1 ELSE 0 END,
        started_at=CASE WHEN $3='in_consultation' THEN COALESCE(started_at,now()) ELSE started_at END,
        done_at=CASE WHEN $3='done' THEN now() ELSE done_at END
      WHERE business_id=$1 AND id=$2`, [business.id, token.id, rule.to, visitId]);
    await repo.audit(db, business.id, user.id, `token.${action}`, token.id, { tokenNo: token.token_no, visitId });
    return tokenRow(db, business, token.id);
  });
}

// "Next patient" for a doctor: whoever was being seen is done, whoever was
// called and did not come in is skipped, and the next waiting token (priority
// first) is called.
async function callNext(business, user, body) {
  clinic.requireClinic(business);
  await access.requireAny(business, ['patients.create', 'patients.edit_clinical']);
  const resourceId = optionalId(body.resourceId, 'Doctor');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const day = await h.today(db, business);
    let locationId = optionalId(body.locationId, 'Location') || business.location_scope;
    if (resourceId) {
      const doctor = await repo.one(db, 'SELECT location_id FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, resourceId]);
      if (!doctor) fail('Doctor not found', 404);
      locationId = doctor.location_id;
    }
    if (!locationId) locationId = (await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND active ORDER BY id LIMIT 1', [business.id]))?.id;
    access.requireLocation(business, locationId);
    const mine = 'business_id=$1 AND location_id=$2 AND COALESCE(resource_id,0)=COALESCE($3::bigint,0) AND day=$4';
    await db.query(`UPDATE health_tokens SET status='done',done_at=now() WHERE ${mine} AND status='in_consultation'`, [business.id, locationId, resourceId, day]);
    await db.query(`UPDATE health_tokens SET status='skipped' WHERE ${mine} AND status='called'`, [business.id, locationId, resourceId, day]);
    const next = await repo.one(db, `SELECT id,token_no FROM health_tokens WHERE ${mine} AND status='waiting' ORDER BY priority DESC,token_no LIMIT 1 FOR UPDATE`,
      [business.id, locationId, resourceId, day]);
    if (!next) return { called: null, message: 'No one is waiting' };
    await db.query("UPDATE health_tokens SET status='called',called_at=now(),called_count=called_count+1 WHERE business_id=$1 AND id=$2", [business.id, next.id]);
    await repo.audit(db, business.id, user.id, 'token.call', next.id, { tokenNo: next.token_no, next: true });
    return { called: await tokenRow(db, business, next.id) };
  });
}

module.exports = { doctors, saveDoctor, addLeave, cancelLeave, availabilityProblem, slots, feeFor, visitFee, doctorEarnings, issueToken, queue, tokenAction, callNext };
