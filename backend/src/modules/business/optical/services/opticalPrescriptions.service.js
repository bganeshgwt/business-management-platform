const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./opticalCommon');

// Prescriptions (module "optical", optical shops).
//
//   record    a customer's eye test: the day, who examined (a member of the
//             business, or an outside ophthalmologist or optometrist with their
//             registration number; with its council and how long it is valid,
//             warned of when it ran out before the test), the customer's age,
//             the doctor who referred them, the eye-test booking it came from,
//             notes and the day it is valid until (a year after the test
//             unless changed), and either
//             - for spectacles: the powers per eye and vision, the prism
//               horizontal (base in or out) and vertical (base up or down),
//               the vertex distance and the PD; or
//             - for contact lenses: each eye's lens (base curve, diameter,
//               power, CYL and AXIS, ADD, colour, brand, how often it is
//               replaced and the wearing schedule)
//   correct   while no spectacle order uses it, every field but its kind can be
//             put right (its customer too); once one does, it never changes
//             (the database refuses too) and a correction is a new prescription
//   history   a customer's prescriptions, newest first, for the screen that
//             shows the powers side by side, with their orders and when they
//             are due for the next test
// A prescription is never deleted.

const { fail } = c;
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const ORDER = { right: 0, left: 1 };
const ZONE_ORDER = { distance: 0, intermediate: 1, near: 2 };
// How long a prescription may be marked valid for.
const MAX_VALID_MONTHS = 60;

// The rows as the list and the screens read them: right eye first; distance, intermediate, near.
const ROWS_SQL = (p) => `COALESCE((SELECT json_agg(json_build_object('eye',r.eye,'zone',r.zone,'sph',r.sph,'cyl',r.cyl,'axis',r.axis,'add',r.add_power,
    'prism',r.prism,'prism_base',r.prism_base,'prism_vertical',r.prism_vertical,'prism_vertical_base',r.prism_vertical_base,'acuity',r.acuity)
    ORDER BY CASE r.eye WHEN 'right' THEN 0 ELSE 1 END, CASE r.zone WHEN 'distance' THEN 0 WHEN 'intermediate' THEN 1 ELSE 2 END)
  FROM optical_prescription_rows r WHERE r.business_id=${p}.business_id AND r.prescription_id=${p}.id),'[]')`;
// A contact-lens prescription's lens for each eye, right eye first.
const LENSES_SQL = (p) => `COALESCE((SELECT json_agg(json_build_object('eye',r.eye,'base_curve',r.base_curve,'diameter',r.diameter,'power',r.power,'cyl',r.cyl,'axis',r.axis,
    'add',r.add_power,'colour',r.colour,'brand',r.brand,'modality',r.modality,'wearing_schedule',r.wearing_schedule) ORDER BY CASE r.eye WHEN 'right' THEN 0 ELSE 1 END)
  FROM optical_contact_lens_rows r WHERE r.business_id=${p}.business_id AND r.prescription_id=${p}.id),'[]')`;
// The examiner's registration had run out by the day of the test.
const LAPSED_SQL = (p) => `(${p}.registration_valid_until IS NOT NULL AND ${p}.registration_valid_until < ${p}.examined_on)`;

repo.addLists({
  // Every prescription with its customer, its powers or lenses, whether an
  // order uses it and whether it is the customer's latest of its kind.
  'optical-prescriptions': {
    sql: `SELECT p.id,p.kind,p.contact_id,k.name AS customer_name,k.phone AS customer_phone,p.examined_on,p.examiner_kind,p.examiner_user_id,p.examiner_name,
        p.registration_no,p.registration_council,p.registration_valid_until,${LAPSED_SQL('p')} AS registration_lapsed,
        p.pd_binocular,p.pd_right,p.pd_left,p.vertex_distance,p.age_years,p.referred_by,p.appointment_id,p.valid_until,p.notes,p.created_at,p.updated_at,
        (p.valid_until < (now() AT TIME ZONE b.timezone)::date) AS lapsed,
        ${ROWS_SQL('p')} AS rows,${LENSES_SQL('p')} AS lenses,
        (SELECT count(*)::int FROM optical_orders o WHERE o.business_id=p.business_id AND o.prescription_id=p.id) AS orders,
        (p.id = (SELECT x.id FROM optical_prescriptions x WHERE x.business_id=p.business_id AND x.contact_id=p.contact_id AND x.kind=p.kind
          ORDER BY x.examined_on DESC,x.id DESC LIMIT 1)) AS latest
      FROM optical_prescriptions p JOIN businesses b ON b.id=p.business_id
      JOIN business_contacts k ON k.business_id=p.business_id AND k.id=p.contact_id WHERE p.business_id=$1`,
    search: ['customer_name', 'customer_phone', 'examiner_name', 'registration_no', 'referred_by', 'notes'], date: 'created_at',
    filters: { contact: 'contact_id', examiner: 'examiner_kind', latest: 'latest', lapsed: 'lapsed', kind: 'kind', registration_lapsed: 'registration_lapsed' },
    order: 'examined_on DESC,id DESC',
  },
});

// A prism in prism dioptres, in steps of 0.25 up to 20.
function readPrism(value, name) {
  if (!c.given(value)) return null;
  const text = String(value).trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text) || Number(text) <= 0 || Number(text) > 20) fail(`${name} must be from 0.25 to 20 prism dioptres`);
  if (Math.round(Number(text) * 100) % 25 !== 0) fail(`${name} goes in steps of 0.25`);
  return Number(text).toFixed(2);
}

// The powers as written: [{ eye, zone, sph, cyl, axis, add, prism, prismBase (in, out),
// prismVertical, prismVerticalBase (up, down), acuity }]. Rows left empty are
// skipped; each eye and vision is given once.
function readRows(value) {
  const list = v.requiredArray(value, 'Powers');
  if (list.length > 6) fail('A prescription has at most six rows: distance, intermediate and near for each eye');
  const seen = new Set();
  const rows = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each row of powers must be an object');
    const eye = v.requiredEnum(raw.eye, 'Eye', c.EYES);
    const zone = v.requiredEnum(raw.zone, 'Vision', c.ZONES);
    const where = capital(`${c.EYE_WORDS[eye]}, ${c.ZONE_WORDS[zone]}`);
    const label = (field) => `${where}: ${field}`;
    const sph = c.readPower(raw.sph, label('SPH'), { plano: true });
    const cyl = c.readPower(raw.cyl, label('CYL'));
    const axis = c.readAxis(raw.axis, label('AXIS'));
    const add = c.readPower(raw.add, label('ADD'), { min: 0.25, max: 4 });
    const prism = readPrism(raw.prism, label('horizontal prism'));
    const vertical = readPrism(raw.prismVertical, label('vertical prism'));
    const acuity = c.optionalText(raw.acuity, label('visual acuity'), 20);
    if ([sph, cyl, axis, add, prism, vertical, acuity].every((x) => x === null) && !c.given(raw.prismBase) && !c.given(raw.prismVerticalBase)) continue;
    if (cyl !== null && sph === null) fail(`${label('SPH')}: give it with the CYL (0.00 for plano)`);
    if (cyl !== null && Number(cyl) !== 0 && axis === null) fail(`${label('AXIS')} is needed with a CYL of ${cyl}`);
    if (axis !== null && (cyl === null || Number(cyl) === 0)) fail(`${label('AXIS')} goes with a CYL: leave it empty without one`);
    if (add !== null && zone === 'distance') fail(`${label('ADD')} goes on the near or intermediate row`);
    if (prism !== null && !c.given(raw.prismBase)) fail(`${label('horizontal prism')}: say which way its base points (in or out)`);
    if (prism === null && c.given(raw.prismBase)) fail(`${label('prism base')} goes with a horizontal prism`);
    const prismBase = prism === null ? null : v.requiredEnum(raw.prismBase, label('horizontal prism base'), c.PRISM_BASES);
    if (vertical !== null && !c.given(raw.prismVerticalBase)) fail(`${label('vertical prism')}: say which way its base points (up or down)`);
    if (vertical === null && c.given(raw.prismVerticalBase)) fail(`${label('vertical prism base')} goes with a vertical prism`);
    const verticalBase = vertical === null ? null : v.requiredEnum(raw.prismVerticalBase, label('vertical prism base'), c.VERTICAL_BASES);
    const key = `${eye}:${zone}`;
    if (seen.has(key)) fail(`${where} is given twice`);
    seen.add(key);
    rows.push({ eye, zone, sph, cyl, axis, add, prism, prismBase, prismVertical: vertical, prismVerticalBase: verticalBase, acuity });
  }
  if (!rows.length) fail('Give the powers of at least one eye');
  return rows.sort((a, b) => ORDER[a.eye] - ORDER[b.eye] || ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone]);
}

// A base curve or diameter in mm, up to two decimals.
function readLensMm(value, name, min, max) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be from ${min} to ${max} mm, with at most two decimal places`);
  return Number(text).toFixed(2);
}
// A contact-lens prescription's lenses as written: [{ eye, baseCurve, diameter,
// power, cyl?, axis?, add?, colour?, brand?, modality?, wearingSchedule? }],
// one for each eye given (an eye left empty is skipped).
function readLensRows(value) {
  const list = v.requiredArray(value, 'Contact lenses');
  if (list.length > 2) fail('A contact-lens prescription has a lens for each eye');
  const fields = ['baseCurve', 'diameter', 'power', 'cyl', 'axis', 'add', 'colour', 'brand', 'modality', 'wearingSchedule'];
  const seen = new Set();
  const rows = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each contact lens must be an object');
    const eye = v.requiredEnum(raw.eye, 'Eye', c.EYES);
    const where = capital(`${c.EYE_WORDS[eye]} lens`);
    const label = (field) => `${where}: ${field}`;
    if (fields.every((f) => !c.given(raw[f]))) continue;
    if (seen.has(eye)) fail(`${where} is given twice`);
    seen.add(eye);
    const power = c.readPower(raw.power, label('power'), { plano: true });
    if (power === null) fail(`${label('power')} is needed (0.00 for plano)`);
    const cyl = c.readPower(raw.cyl, label('CYL'));
    const axis = c.readAxis(raw.axis, label('AXIS'));
    if (cyl !== null && Number(cyl) === 0) fail(`${label('CYL')}: leave it empty for a lens that is not toric`);
    if (cyl !== null && axis === null) fail(`${label('AXIS')} is needed with a CYL of ${cyl}`);
    if (axis !== null && cyl === null) fail(`${label('AXIS')} goes with a CYL: leave it empty without one`);
    rows.push({
      eye, baseCurve: readLensMm(raw.baseCurve, label('base curve'), 6, 10), diameter: readLensMm(raw.diameter, label('diameter'), 8, 25), power, cyl, axis,
      add: c.readPower(raw.add, label('ADD'), { min: 0.25, max: 4 }), colour: c.optionalText(raw.colour, label('colour'), 40), brand: c.optionalText(raw.brand, label('brand'), 100),
      modality: v.optionalEnum(raw.modality, label('replaced'), c.MODALITIES, null), wearingSchedule: c.optionalText(raw.wearingSchedule, label('wearing schedule'), 150),
    });
  }
  if (!rows.length) fail('Give the contact lens of at least one eye');
  return rows.sort((a, b) => ORDER[a.eye] - ORDER[b.eye]);
}
const readPowers = (kind, body) => (kind === 'contact_lens' ? readLensRows(body.lenses) : readRows(body.rows));

// Pupillary distance: both eyes together, or each eye, or none.
function readPd(body) {
  const binocular = c.readMillimetres(body.pdBinocular, 'PD (both eyes)', 40, 85);
  const right = c.readMillimetres(body.pdRight, 'PD of the right eye', 20, 45);
  const left = c.readMillimetres(body.pdLeft, 'PD of the left eye', 20, 45);
  if (binocular !== null && (right !== null || left !== null)) fail('Give the PD of both eyes together or of each eye, not both');
  if ((right === null) !== (left === null)) fail('Give the PD of each eye, or the PD of both eyes together');
  return { binocular, right, left };
}

// The rest of the header: the vertex distance (a spectacle prescription's),
// the customer's age at the test and the doctor who referred them.
function readDetails(body, kind) {
  const vertex = c.readMillimetres(body.vertexDistance, 'Vertex distance', 5, 25);
  if (kind !== 'spectacles' && vertex !== null) fail('The vertex distance goes with a spectacle prescription');
  if (kind !== 'spectacles' && (c.given(body.pdBinocular) || c.given(body.pdRight) || c.given(body.pdLeft))) fail('The PD goes with a spectacle prescription');
  let age = null;
  if (c.given(body.ageYears)) {
    const text = String(body.ageYears).trim();
    if (!/^\d{1,3}$/.test(text) || Number(text) > 120) fail('Age must be a whole number of years from 0 to 120');
    age = Number(text);
  }
  return { vertex, age, referredBy: c.optionalText(body.referredBy, 'Referred by', 150) };
}

async function readCustomer(db, business, contactId) {
  const contact = await repo.one(db, "SELECT id,name,phone FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, id(contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  return contact;
}

// Who examined: a member of the business (the person recording, unless
// another is chosen), or an outside prescriber with their registration number;
// a registration may name its council and the day it is valid until.
async function readExaminer(db, business, user, body) {
  const kind = v.optionalEnum(body.examinerKind, 'Examined by', ['staff', 'outside'], 'staff');
  const registrationNo = c.optionalText(body.registrationNo, 'Registration number', 60);
  const council = c.optionalText(body.registrationCouncil, 'Registered with (council)', 150);
  const validUntil = c.given(body.registrationValidUntil) ? c.readDate(body.registrationValidUntil, 'Registration valid until') : null;
  if ((council || validUntil) && !registrationNo) fail('Give the registration number with its council and the day it is valid until');
  const registration = { registrationNo, council, validUntil };
  if (kind === 'outside') {
    const name = v.requiredString(typeof body.examinerName === 'string' ? body.examinerName : '', 'The prescriber\'s name', 150);
    if (!registrationNo) fail('Give the outside prescriber\'s registration number, as on their prescription');
    return { kind, userId: null, name, ...registration };
  }
  const userId = c.given(body.examinerUserId) ? id(body.examinerUserId, 'Examined by') : Number(user.id);
  const member = await repo.one(db, `SELECT u.id,u.name FROM business_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.business_id=$1 AND m.user_id=$2 AND m.active`, [business.id, userId]);
  if (!member) fail('The examiner is a member of this business: for anyone else, choose an outside prescriber', 404);
  return { kind, userId: Number(member.id), name: member.name, ...registration };
}

// The day of the test (today unless given; never a day still to come) and the
// day it is valid until (a year later unless given).
function readDates(body, today) {
  const examinedOn = c.given(body.examinedOn) ? c.readDate(body.examinedOn, 'Day of the eye test') : today;
  if (examinedOn > today) fail('The eye test cannot be on a day still to come');
  const validUntil = c.given(body.validUntil) ? c.readDate(body.validUntil, 'Valid until') : c.addMonths(examinedOn, 12);
  if (validUntil < examinedOn) fail('A prescription cannot run out before the day of the test');
  if (validUntil > c.addMonths(examinedOn, MAX_VALID_MONTHS)) fail('A prescription can be valid for at most five years');
  return { examinedOn, validUntil };
}

// The eye-test booking it is recorded from: done, the customer's, and not
// recorded already for this kind of prescription.
async function readBooking(db, business, value, contactId, kind) {
  if (!c.given(value)) return null;
  const booking = await repo.one(db, `SELECT a.id,a.contact_id,a.status,(a.starts_at AT TIME ZONE b.timezone)::date::text AS day FROM business_appointments a
    JOIN businesses b ON b.id=a.business_id WHERE a.business_id=$1 AND a.id=$2`, [business.id, id(value, 'Eye-test booking')]);
  if (!booking) fail('Eye-test booking not found', 404);
  if (Number(booking.contact_id) !== Number(contactId)) fail('That eye-test booking is another customer\'s', 409);
  if (booking.status !== 'completed') fail('Mark the eye-test booking done first, then record its prescription', 409);
  const done = await repo.one(db, 'SELECT id FROM optical_prescriptions WHERE business_id=$1 AND appointment_id=$2 AND kind=$3', [business.id, booking.id, kind]);
  if (done) fail(`The eye test of ${c.dateWords(booking.day)} already has its ${kind === 'contact_lens' ? 'contact-lens' : 'spectacle'} prescription: correct that one instead`, 409);
  return booking;
}

async function insertRows(db, business, prescriptionId, kind, rows) {
  for (const r of rows) {
    if (kind === 'contact_lens') {
      await db.query(`INSERT INTO optical_contact_lens_rows(business_id,prescription_id,eye,base_curve,diameter,power,cyl,axis,add_power,colour,brand,modality,wearing_schedule)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [business.id, prescriptionId, r.eye, r.baseCurve, r.diameter, r.power, r.cyl, r.axis, r.add, r.colour,
        r.brand, r.modality, r.wearingSchedule]);
    } else {
      await db.query(`INSERT INTO optical_prescription_rows(business_id,prescription_id,eye,zone,sph,cyl,axis,add_power,prism,prism_base,prism_vertical,prism_vertical_base,acuity)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [business.id, prescriptionId, r.eye, r.zone, r.sph, r.cyl, r.axis, r.add, r.prism, r.prismBase,
        r.prismVertical, r.prismVerticalBase, r.acuity]);
    }
  }
}

// The powers in a line, for the activity log: "R distance -2.25 -0.75 x 180 · L near ADD +2.00",
// or a contact lens's: "R -2.50 BC 8.40 DIA 14.00".
const sign = (x) => (Number(x) > 0 ? `+${Number(x).toFixed(2)}` : Number(x).toFixed(2));
function powersText(rows) {
  return rows.map((r) => {
    if (r.baseCurve !== undefined) {
      const lens = [sign(r.power), r.cyl !== null ? `${sign(r.cyl)} x ${r.axis}` : null, r.add !== null ? `ADD ${sign(r.add)}` : null,
        `BC ${Number(r.baseCurve).toFixed(2)}`, `DIA ${Number(r.diameter).toFixed(2)}`, r.colour, r.brand].filter(Boolean);
      return `${r.eye === 'right' ? 'R' : 'L'} ${lens.join(' ')}`;
    }
    const parts = [r.sph !== null ? sign(r.sph) : null, r.cyl !== null ? sign(r.cyl) : null, r.axis !== null ? `x ${r.axis}` : null,
      r.add !== null ? `ADD ${sign(r.add)}` : null, r.prism !== null ? `${Number(r.prism)} ${r.prismBase}` : null,
      r.prismVertical !== null && r.prismVertical !== undefined ? `${Number(r.prismVertical)} ${r.prismVerticalBase}` : null].filter(Boolean);
    return `${r.eye === 'right' ? 'R' : 'L'} ${r.zone}${parts.length ? ` ${parts.join(' ')}` : ''}`;
  }).join(' · ');
}
// The rows as stored, in the shape readRows or readLensRows gives.
const asRows = (list) => list.map((r) => ({ eye: r.eye, zone: r.zone, sph: r.sph, cyl: r.cyl, axis: r.axis, add: r.add_power, prism: r.prism, prismBase: r.prism_base,
  prismVertical: r.prism_vertical, prismVerticalBase: r.prism_vertical_base, acuity: r.acuity }));
const asLenses = (list) => list.map((r) => ({ eye: r.eye, baseCurve: r.base_curve, diameter: r.diameter, power: r.power, cyl: r.cyl, axis: r.axis, add: r.add_power,
  colour: r.colour, brand: r.brand, modality: r.modality, wearingSchedule: r.wearing_schedule }));
// One query at a time: `db` may be a transaction's own client.
async function storedPowers(db, business, p) {
  if (p.kind === 'contact_lens') {
    return asLenses(await repo.all(db, `SELECT * FROM optical_contact_lens_rows WHERE business_id=$1 AND prescription_id=$2 ORDER BY CASE eye WHEN 'right' THEN 0 ELSE 1 END`,
      [business.id, p.id]));
  }
  return asRows(await repo.all(db, `SELECT eye,zone,sph,cyl,axis,add_power,prism,prism_base,prism_vertical,prism_vertical_base,acuity FROM optical_prescription_rows
    WHERE business_id=$1 AND prescription_id=$2 ORDER BY CASE eye WHEN 'right' THEN 0 ELSE 1 END, CASE zone WHEN 'distance' THEN 0 WHEN 'intermediate' THEN 1 ELSE 2 END`,
  [business.id, p.id]));
}

// A registration that had run out by the day of the test, in words: a
// warning (the prescription is kept as written).
function warningsOf(p) {
  const validUntil = p.registration_valid_until ? String(p.registration_valid_until).slice(0, 10) : null;
  if (!validUntil || validUntil >= String(p.examined_on).slice(0, 10)) return [];
  return [`${p.examiner_name}'s registration ${p.registration_no}${p.registration_council ? ` with ${p.registration_council}` : ''} ran out on ${c.dateWords(validUntil)}, `
    + 'before this eye test: renew it, or name the examiner whose registration is in force.'];
}
const withWarnings = (p) => {
  const warnings = warningsOf(p);
  return warnings.length ? { ...p, warnings } : p;
};

// One prescription with its powers or lenses, its customer and the orders made on it.
async function load(db, business, prescriptionId) {
  const p = await repo.one(db, `SELECT p.*,k.name AS customer_name,k.phone AS customer_phone,cu.name AS created_by_name,uu.name AS updated_by_name,
      (p.valid_until < (now() AT TIME ZONE b.timezone)::date) AS lapsed,${LAPSED_SQL('p')} AS registration_lapsed,${ROWS_SQL('p')} AS rows,${LENSES_SQL('p')} AS lenses
    FROM optical_prescriptions p JOIN businesses b ON b.id=p.business_id
    JOIN business_contacts k ON k.business_id=p.business_id AND k.id=p.contact_id
    JOIN users cu ON cu.id=p.created_by LEFT JOIN users uu ON uu.id=p.updated_by
    WHERE p.business_id=$1 AND p.id=$2`, [business.id, prescriptionId]);
  if (!p) fail('Prescription not found', 404);
  const orders = await repo.all(db, `SELECT id,order_no,status,created_at FROM optical_orders WHERE business_id=$1 AND prescription_id=$2 ORDER BY id`, [business.id, p.id]);
  const { request_hash: _hash, ...rest } = p;
  return { ...rest, orders, locked: orders.length > 0 };
}

async function detail(business, prescriptionId) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  return load(repo.pool, business, id(prescriptionId, 'Prescription'));
}

// body: { requestKey, kind?: spectacles (the default) | contact_lens, contactId, examinedOn?,
//   examinerKind?: staff | outside, examinerUserId? | examinerName, registrationNo?, registrationCouncil?, registrationValidUntil?,
//   rows (spectacles): [{ eye, zone, sph?, cyl?, axis?, add?, prism?, prismBase?, prismVertical?, prismVerticalBase?, acuity? }],
//   lenses (contact lenses): [{ eye, baseCurve, diameter, power, cyl?, axis?, add?, colour?, brand?, modality?, wearingSchedule? }],
//   pdBinocular? | pdRight + pdLeft, vertexDistance?, ageYears?, referredBy?, appointmentId?, notes?, validUntil? }
// Answers the prescription, with `warnings` when the examiner's registration had run out.
async function create(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const kind = v.optionalEnum(body.kind, 'Prescription for', c.KINDS, 'spectacles');
  const rows = readPowers(kind, body);
  const pd = readPd(body);
  const details = readDetails(body, kind);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM optical_prescriptions WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return withWarnings(await load(db, business, old.id));
    }
    const contact = await readCustomer(db, business, body.contactId);
    const examiner = await readExaminer(db, business, user, body);
    const { examinedOn, validUntil } = readDates(body, await c.today(db, business));
    const booking = await readBooking(db, business, body.appointmentId, contact.id, kind);
    const saved = await repo.one(db, `INSERT INTO optical_prescriptions(business_id,contact_id,examined_on,examiner_kind,examiner_user_id,examiner_name,registration_no,
        pd_binocular,pd_right,pd_left,notes,valid_until,request_key,request_hash,created_by,updated_by,kind,registration_council,registration_valid_until,vertex_distance,
        age_years,referred_by,appointment_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [business.id, contact.id, examinedOn, examiner.kind, examiner.userId, examiner.name, examiner.registrationNo, pd.binocular, pd.right, pd.left, notes, validUntil,
      requestKey, hash, user.id, kind, examiner.council, examiner.validUntil, details.vertex, details.age, details.referredBy, booking?.id || null]);
    await insertRows(db, business, saved.id, kind, rows);
    await repo.audit(db, business.id, user.id, 'prescription.recorded', saved.id, { kind, customer: contact.name, examinedOn, examiner: examiner.name,
      ...(examiner.registrationNo ? { registrationNo: examiner.registrationNo } : {}), ...(examiner.council ? { council: examiner.council } : {}),
      ...(details.referredBy ? { referredBy: details.referredBy } : {}), ...(booking ? { appointmentId: Number(booking.id) } : {}), powers: powersText(rows) });
    return withWarnings(await load(db, business, saved.id));
  });
}

// The same fields as a new prescription (its kind and booking stay). Refused once an order uses it.
async function update(business, user, prescriptionId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.create');
  const pd = readPd(body);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, 'SELECT * FROM optical_prescriptions WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(prescriptionId, 'Prescription')]);
    if (!current) fail('Prescription not found', 404);
    const used = await repo.one(db, 'SELECT order_no FROM optical_orders WHERE business_id=$1 AND prescription_id=$2 ORDER BY id LIMIT 1', [business.id, current.id]);
    if (used) fail(`This prescription is on spectacle order ${used.order_no} and no longer changes: record a new prescription to correct it`, 409);
    if (c.given(body.kind) && body.kind !== current.kind) fail('A prescription keeps its kind: record a new one for spectacles or for contact lenses');
    const rows = readPowers(current.kind, body);
    const details = readDetails(body, current.kind);
    const contact = await readCustomer(db, business, c.given(body.contactId) ? body.contactId : current.contact_id);
    if (current.appointment_id && Number(contact.id) !== Number(current.contact_id)) fail('This prescription is of an eye-test booking: it stays with that booking\'s customer');
    const examiner = await readExaminer(db, business, user, body);
    const { examinedOn, validUntil } = readDates(body, await c.today(db, business));
    const before = await storedPowers(db, business, current);
    await db.query(`UPDATE optical_prescriptions SET contact_id=$3,examined_on=$4,examiner_kind=$5,examiner_user_id=$6,examiner_name=$7,registration_no=$8,
      pd_binocular=$9,pd_right=$10,pd_left=$11,notes=$12,valid_until=$13,updated_by=$14,updated_at=now(),registration_council=$15,registration_valid_until=$16,
      vertex_distance=$17,age_years=$18,referred_by=$19 WHERE business_id=$1 AND id=$2`,
    [business.id, current.id, contact.id, examinedOn, examiner.kind, examiner.userId, examiner.name, examiner.registrationNo, pd.binocular, pd.right, pd.left,
      notes, validUntil, user.id, examiner.council, examiner.validUntil, details.vertex, details.age, details.referredBy]);
    await db.query(`DELETE FROM ${current.kind === 'contact_lens' ? 'optical_contact_lens_rows' : 'optical_prescription_rows'} WHERE business_id=$1 AND prescription_id=$2`,
      [business.id, current.id]);
    await insertRows(db, business, current.id, current.kind, rows);
    // What changed, from and to, in the activity log.
    const text = (x) => (x === null || x === undefined ? null : String(x));
    const was = { contactId: String(current.contact_id), examinedOn: text(current.examined_on), examiner: current.examiner_name, registrationNo: current.registration_no,
      council: current.registration_council, registrationValidUntil: text(current.registration_valid_until),
      pd: [text(current.pd_binocular), text(current.pd_right), text(current.pd_left)].join('/'), vertexDistance: text(current.vertex_distance), age: text(current.age_years),
      referredBy: current.referred_by, notes: current.notes, validUntil: text(current.valid_until), powers: powersText(before) };
    const now = { contactId: String(contact.id), examinedOn, examiner: examiner.name, registrationNo: examiner.registrationNo,
      council: examiner.council, registrationValidUntil: examiner.validUntil,
      pd: [pd.binocular, pd.right, pd.left].map(text).join('/'), vertexDistance: details.vertex, age: text(details.age), referredBy: details.referredBy,
      notes, validUntil, powers: powersText(rows) };
    const changed = Object.keys(now).filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'prescription.corrected', current.id, { customer: contact.name,
        from: Object.fromEntries(changed.map((key) => [key, was[key]])), to: Object.fromEntries(changed.map((key) => [key, now[key]])) });
    }
    return withWarnings(await load(db, business, current.id));
  });
}

// The recall list's reckoning (the months by the customer's groups), required when first needed.
const recall = () => require('./opticalRecall.service');

// A customer's prescriptions (newest first) and spectacle orders, and when
// they are due for their next eye test. Money on the orders only for someone
// who sees sales.
async function customerHistory(business, contactId) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  const contact = await repo.one(repo.pool, "SELECT id,name,phone,active FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  const prescriptions = await repo.all(repo.pool, `SELECT p.id,p.kind,p.examined_on,p.examiner_kind,p.examiner_name,p.registration_no,p.registration_council,
      p.registration_valid_until,${LAPSED_SQL('p')} AS registration_lapsed,p.pd_binocular,p.pd_right,p.pd_left,p.vertex_distance,p.age_years,p.referred_by,p.appointment_id,
      p.notes,p.valid_until,p.created_at,(p.valid_until < (now() AT TIME ZONE b.timezone)::date) AS lapsed,${ROWS_SQL('p')} AS rows,${LENSES_SQL('p')} AS lenses,
      (SELECT count(*)::int FROM optical_orders o WHERE o.business_id=p.business_id AND o.prescription_id=p.id) AS orders
    FROM optical_prescriptions p JOIN businesses b ON b.id=p.business_id WHERE p.business_id=$1 AND p.contact_id=$2 ORDER BY p.examined_on DESC,p.id DESC`, [business.id, contact.id]);
  const money = access.can(business, 'sales.view');
  const orders = await repo.all(repo.pool, `SELECT id,order_no,status,prescription_id,promised_on,created_at,delivered_at,remake_of,total FROM optical_orders
    WHERE business_id=$1 AND contact_id=$2 ORDER BY id DESC`, [business.id, contact.id]);
  const due = await recall().recallOf(repo.pool, business, contact.id);
  const months = due ? Number(due.months) : (await recall().readSettings(repo.pool, business)).recall_months;
  const reminded = await repo.one(repo.pool, "SELECT max(created_at) AS at FROM optical_recall_reminders WHERE business_id=$1 AND contact_id=$2 AND kind='eye_test'", [business.id, contact.id]);
  return {
    customer: contact,
    prescriptions,
    orders: orders.map((o) => ({ ...o, total: money ? o.total : null })),
    recall: { months, due_on: due ? String(due.due_on).slice(0, 10) : null, groups: due ? recall().groupsOf(due) : [], reminded_at: reminded?.at || null },
  };
}

// Who may be named as examiner: the members whose role records prescriptions
// (each with the registration on their latest prescription that names one:
// its number, council and validity), the outside prescribers named before,
// and the doctors who referred customers before, for the form to offer.
async function examiners(business) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  const staff = await repo.all(repo.pool, `SELECT u.id,u.name,g.registration_no,g.registration_council,g.registration_valid_until
    FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    LEFT JOIN LATERAL (SELECT p.registration_no,p.registration_council,p.registration_valid_until FROM optical_prescriptions p WHERE p.business_id=m.business_id
      AND p.examiner_user_id=u.id AND p.registration_no IS NOT NULL ORDER BY p.id DESC LIMIT 1) g ON TRUE
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions x WHERE x.business_id=r.business_id AND x.role_id=r.id AND x.permission_code='optical.create'))
    ORDER BY u.name`, [business.id]);
  const outside = await repo.all(repo.pool, `SELECT DISTINCT ON (lower(examiner_name)) examiner_name AS name,registration_no,registration_council,registration_valid_until
    FROM optical_prescriptions WHERE business_id=$1 AND examiner_kind='outside' ORDER BY lower(examiner_name),id DESC LIMIT 50`, [business.id]);
  const referrers = (await repo.all(repo.pool, `SELECT DISTINCT ON (lower(referred_by)) referred_by AS name FROM optical_prescriptions
    WHERE business_id=$1 AND referred_by IS NOT NULL ORDER BY lower(referred_by),id DESC LIMIT 50`, [business.id])).map((r) => r.name);
  return { staff, outside, referrers };
}

module.exports = { readRows, readLensRows, readPd, powersText, ROWS_SQL, LENSES_SQL, detail, create, update, customerHistory, examiners };
