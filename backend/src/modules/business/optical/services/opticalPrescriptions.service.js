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
//             registration number), the powers per eye and vision, the PD,
//             notes and the day it is valid until (a year after the test
//             unless changed)
//   correct   while no spectacle order uses it, every field can be put right
//             (its customer too); once one does, it never changes (the database
//             refuses too) and a correction is a new prescription
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
    'prism',r.prism,'prism_base',r.prism_base,'acuity',r.acuity)
    ORDER BY CASE r.eye WHEN 'right' THEN 0 ELSE 1 END, CASE r.zone WHEN 'distance' THEN 0 WHEN 'intermediate' THEN 1 ELSE 2 END)
  FROM optical_prescription_rows r WHERE r.business_id=${p}.business_id AND r.prescription_id=${p}.id),'[]')`;

repo.addLists({
  // Every prescription with its customer, its powers, whether an order uses it
  // and whether it is the customer's latest.
  'optical-prescriptions': {
    sql: `SELECT p.id,p.contact_id,k.name AS customer_name,k.phone AS customer_phone,p.examined_on,p.examiner_kind,p.examiner_user_id,p.examiner_name,
        p.registration_no,p.pd_binocular,p.pd_right,p.pd_left,p.valid_until,p.notes,p.created_at,p.updated_at,
        (p.valid_until < (now() AT TIME ZONE b.timezone)::date) AS lapsed,
        ${ROWS_SQL('p')} AS rows,
        (SELECT count(*)::int FROM optical_orders o WHERE o.business_id=p.business_id AND o.prescription_id=p.id) AS orders,
        (p.id = (SELECT x.id FROM optical_prescriptions x WHERE x.business_id=p.business_id AND x.contact_id=p.contact_id ORDER BY x.examined_on DESC,x.id DESC LIMIT 1)) AS latest
      FROM optical_prescriptions p JOIN businesses b ON b.id=p.business_id
      JOIN business_contacts k ON k.business_id=p.business_id AND k.id=p.contact_id WHERE p.business_id=$1`,
    search: ['customer_name', 'customer_phone', 'examiner_name', 'registration_no', 'notes'], date: 'created_at',
    filters: { contact: 'contact_id', examiner: 'examiner_kind', latest: 'latest', lapsed: 'lapsed' },
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

// The powers as written: [{ eye, zone, sph, cyl, axis, add, prism, prismBase, acuity }].
// Rows left empty are skipped; each eye and vision is given once.
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
    const prism = readPrism(raw.prism, label('prism'));
    const acuity = c.optionalText(raw.acuity, label('visual acuity'), 20);
    if ([sph, cyl, axis, add, prism, acuity].every((x) => x === null) && !c.given(raw.prismBase)) continue;
    if (cyl !== null && sph === null) fail(`${label('SPH')}: give it with the CYL (0.00 for plano)`);
    if (cyl !== null && Number(cyl) !== 0 && axis === null) fail(`${label('AXIS')} is needed with a CYL of ${cyl}`);
    if (axis !== null && (cyl === null || Number(cyl) === 0)) fail(`${label('AXIS')} goes with a CYL: leave it empty without one`);
    if (add !== null && zone === 'distance') fail(`${label('ADD')} goes on the near or intermediate row`);
    if (prism !== null && !c.given(raw.prismBase)) fail(`${label('prism')}: say which way its base points (in, out, up or down)`);
    if (prism === null && c.given(raw.prismBase)) fail(`${label('prism base')} goes with a prism`);
    const prismBase = prism === null ? null : v.requiredEnum(raw.prismBase, label('prism base'), c.PRISM_BASES);
    const key = `${eye}:${zone}`;
    if (seen.has(key)) fail(`${where} is given twice`);
    seen.add(key);
    rows.push({ eye, zone, sph, cyl, axis, add, prism, prismBase, acuity });
  }
  if (!rows.length) fail('Give the powers of at least one eye');
  return rows.sort((a, b) => ORDER[a.eye] - ORDER[b.eye] || ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone]);
}

// Pupillary distance: both eyes together, or each eye, or none.
function readPd(body) {
  const binocular = c.readMillimetres(body.pdBinocular, 'PD (both eyes)', 40, 85);
  const right = c.readMillimetres(body.pdRight, 'PD of the right eye', 20, 45);
  const left = c.readMillimetres(body.pdLeft, 'PD of the left eye', 20, 45);
  if (binocular !== null && (right !== null || left !== null)) fail('Give the PD of both eyes together or of each eye, not both');
  if ((right === null) !== (left === null)) fail('Give the PD of each eye, or the PD of both eyes together');
  return { binocular, right, left };
}

async function readCustomer(db, business, contactId) {
  const contact = await repo.one(db, "SELECT id,name,phone FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, id(contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  return contact;
}

// Who examined: a member of the business (the person recording, unless
// another is chosen), or an outside prescriber with their registration number.
async function readExaminer(db, business, user, body) {
  const kind = v.optionalEnum(body.examinerKind, 'Examined by', ['staff', 'outside'], 'staff');
  const registrationNo = c.optionalText(body.registrationNo, 'Registration number', 60);
  if (kind === 'outside') {
    const name = v.requiredString(typeof body.examinerName === 'string' ? body.examinerName : '', 'The prescriber\'s name', 150);
    if (!registrationNo) fail('Give the outside prescriber\'s registration number, as on their prescription');
    return { kind, userId: null, name, registrationNo };
  }
  const userId = c.given(body.examinerUserId) ? id(body.examinerUserId, 'Examined by') : Number(user.id);
  const member = await repo.one(db, `SELECT u.id,u.name FROM business_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.business_id=$1 AND m.user_id=$2 AND m.active`, [business.id, userId]);
  if (!member) fail('The examiner is a member of this business: for anyone else, choose an outside prescriber', 404);
  return { kind, userId: Number(member.id), name: member.name, registrationNo };
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

async function insertRows(db, business, prescriptionId, rows) {
  for (const r of rows) {
    await db.query(`INSERT INTO optical_prescription_rows(business_id,prescription_id,eye,zone,sph,cyl,axis,add_power,prism,prism_base,acuity)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, prescriptionId, r.eye, r.zone, r.sph, r.cyl, r.axis, r.add, r.prism, r.prismBase, r.acuity]);
  }
}

// The powers in a line, for the activity log: "R -2.25 -0.75 x 180 · L ADD +2.00".
const sign = (x) => (Number(x) > 0 ? `+${Number(x).toFixed(2)}` : Number(x).toFixed(2));
function powersText(rows) {
  return rows.map((r) => {
    const parts = [r.sph !== null ? sign(r.sph) : null, r.cyl !== null ? sign(r.cyl) : null, r.axis !== null ? `x ${r.axis}` : null,
      r.add !== null ? `ADD ${sign(r.add)}` : null, r.prism !== null ? `${Number(r.prism)} ${r.prismBase}` : null].filter(Boolean);
    return `${r.eye === 'right' ? 'R' : 'L'} ${r.zone}${parts.length ? ` ${parts.join(' ')}` : ''}`;
  }).join(' · ');
}
// The rows as stored, in the shape readRows gives.
const asRows = (list) => list.map((r) => ({ eye: r.eye, zone: r.zone, sph: r.sph, cyl: r.cyl, axis: r.axis, add: r.add_power, prism: r.prism, prismBase: r.prism_base, acuity: r.acuity }));

// One prescription with its powers, its customer and the orders made on it.
async function load(db, business, prescriptionId) {
  const p = await repo.one(db, `SELECT p.*,k.name AS customer_name,k.phone AS customer_phone,cu.name AS created_by_name,uu.name AS updated_by_name,
      (p.valid_until < (now() AT TIME ZONE b.timezone)::date) AS lapsed,${ROWS_SQL('p')} AS rows
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

// body: { requestKey, contactId, examinedOn?, examinerKind?: staff | outside, examinerUserId? | examinerName,
//   registrationNo?, rows: [{ eye, zone, sph?, cyl?, axis?, add?, prism?, prismBase?, acuity? }],
//   pdBinocular? | pdRight + pdLeft, notes?, validUntil? }
async function create(business, user, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const rows = readRows(body.rows);
  const pd = readPd(body);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM optical_prescriptions WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return load(db, business, old.id);
    }
    const contact = await readCustomer(db, business, body.contactId);
    const examiner = await readExaminer(db, business, user, body);
    const { examinedOn, validUntil } = readDates(body, await c.today(db, business));
    const saved = await repo.one(db, `INSERT INTO optical_prescriptions(business_id,contact_id,examined_on,examiner_kind,examiner_user_id,examiner_name,registration_no,
        pd_binocular,pd_right,pd_left,notes,valid_until,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id`,
    [business.id, contact.id, examinedOn, examiner.kind, examiner.userId, examiner.name, examiner.registrationNo, pd.binocular, pd.right, pd.left, notes, validUntil,
      requestKey, hash, user.id]);
    await insertRows(db, business, saved.id, rows);
    await repo.audit(db, business.id, user.id, 'prescription.recorded', saved.id, { customer: contact.name, examinedOn, examiner: examiner.name,
      ...(examiner.registrationNo ? { registrationNo: examiner.registrationNo } : {}), powers: powersText(rows) });
    return load(db, business, saved.id);
  });
}

// The same fields as a new prescription. Refused once an order uses it.
async function update(business, user, prescriptionId, body) {
  c.requireOptical(business);
  await access.require(business, 'optical.create');
  const rows = readRows(body.rows);
  const pd = readPd(body);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, 'SELECT * FROM optical_prescriptions WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(prescriptionId, 'Prescription')]);
    if (!current) fail('Prescription not found', 404);
    const used = await repo.one(db, 'SELECT order_no FROM optical_orders WHERE business_id=$1 AND prescription_id=$2 ORDER BY id LIMIT 1', [business.id, current.id]);
    if (used) fail(`This prescription is on spectacle order ${used.order_no} and no longer changes: record a new prescription to correct it`, 409);
    const contact = await readCustomer(db, business, c.given(body.contactId) ? body.contactId : current.contact_id);
    const examiner = await readExaminer(db, business, user, body);
    const { examinedOn, validUntil } = readDates(body, await c.today(db, business));
    const before = asRows(await repo.all(db, `SELECT eye,zone,sph,cyl,axis,add_power,prism,prism_base,acuity FROM optical_prescription_rows
      WHERE business_id=$1 AND prescription_id=$2 ORDER BY CASE eye WHEN 'right' THEN 0 ELSE 1 END, CASE zone WHEN 'distance' THEN 0 WHEN 'intermediate' THEN 1 ELSE 2 END`, [business.id, current.id]));
    await db.query(`UPDATE optical_prescriptions SET contact_id=$3,examined_on=$4,examiner_kind=$5,examiner_user_id=$6,examiner_name=$7,registration_no=$8,
      pd_binocular=$9,pd_right=$10,pd_left=$11,notes=$12,valid_until=$13,updated_by=$14,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, current.id, contact.id, examinedOn, examiner.kind, examiner.userId, examiner.name, examiner.registrationNo, pd.binocular, pd.right, pd.left,
      notes, validUntil, user.id]);
    await db.query('DELETE FROM optical_prescription_rows WHERE business_id=$1 AND prescription_id=$2', [business.id, current.id]);
    await insertRows(db, business, current.id, rows);
    // What changed, from and to, in the activity log.
    const text = (x) => (x === null || x === undefined ? null : String(x));
    const was = { contactId: String(current.contact_id), examinedOn: text(current.examined_on), examiner: current.examiner_name, registrationNo: current.registration_no,
      pd: [text(current.pd_binocular), text(current.pd_right), text(current.pd_left)].join('/'), notes: current.notes, validUntil: text(current.valid_until), powers: powersText(before) };
    const now = { contactId: String(contact.id), examinedOn, examiner: examiner.name, registrationNo: examiner.registrationNo,
      pd: [pd.binocular, pd.right, pd.left].map(text).join('/'), notes, validUntil, powers: powersText(rows) };
    const changed = Object.keys(now).filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'prescription.corrected', current.id, { customer: contact.name,
        from: Object.fromEntries(changed.map((key) => [key, was[key]])), to: Object.fromEntries(changed.map((key) => [key, now[key]])) });
    }
    return load(db, business, current.id);
  });
}

// The months after a test that a customer is due for another (Recall list).
async function recallMonths(db, business) {
  return Number((await repo.one(db, 'SELECT recall_months FROM optical_settings WHERE business_id=$1', [business.id]))?.recall_months || 12);
}

// A customer's prescriptions (newest first) and spectacle orders, and when
// they are due for their next eye test. Money on the orders only for someone
// who sees sales.
async function customerHistory(business, contactId) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  const contact = await repo.one(repo.pool, "SELECT id,name,phone,active FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Customer')]);
  if (!contact) fail('Customer not found', 404);
  const prescriptions = await repo.all(repo.pool, `SELECT p.id,p.examined_on,p.examiner_kind,p.examiner_name,p.registration_no,p.pd_binocular,p.pd_right,p.pd_left,
      p.notes,p.valid_until,p.created_at,(p.valid_until < (now() AT TIME ZONE b.timezone)::date) AS lapsed,${ROWS_SQL('p')} AS rows,
      (SELECT count(*)::int FROM optical_orders o WHERE o.business_id=p.business_id AND o.prescription_id=p.id) AS orders
    FROM optical_prescriptions p JOIN businesses b ON b.id=p.business_id WHERE p.business_id=$1 AND p.contact_id=$2 ORDER BY p.examined_on DESC,p.id DESC`, [business.id, contact.id]);
  const money = access.can(business, 'sales.view');
  const orders = await repo.all(repo.pool, `SELECT id,order_no,status,prescription_id,promised_on,created_at,delivered_at,remake_of,total FROM optical_orders
    WHERE business_id=$1 AND contact_id=$2 ORDER BY id DESC`, [business.id, contact.id]);
  const months = await recallMonths(repo.pool, business);
  const reminded = await repo.one(repo.pool, 'SELECT max(created_at) AS at FROM optical_recall_reminders WHERE business_id=$1 AND contact_id=$2', [business.id, contact.id]);
  return {
    customer: contact,
    prescriptions,
    orders: orders.map((o) => ({ ...o, total: money ? o.total : null })),
    recall: { months, due_on: prescriptions[0] ? c.addMonths(String(prescriptions[0].examined_on).slice(0, 10), months) : null, reminded_at: reminded?.at || null },
  };
}

// Who may be named as examiner: the members whose role records prescriptions
// (each with the registration number on their latest prescription), and the
// outside prescribers named before, for the form to offer.
async function examiners(business) {
  c.requireOptical(business);
  await access.require(business, 'optical.view');
  const staff = await repo.all(repo.pool, `SELECT u.id,u.name,
      (SELECT p.registration_no FROM optical_prescriptions p WHERE p.business_id=m.business_id AND p.examiner_user_id=u.id AND p.registration_no IS NOT NULL ORDER BY p.id DESC LIMIT 1) AS registration_no
    FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions x WHERE x.business_id=r.business_id AND x.role_id=r.id AND x.permission_code='optical.create'))
    ORDER BY u.name`, [business.id]);
  const outside = await repo.all(repo.pool, `SELECT DISTINCT ON (lower(examiner_name)) examiner_name AS name,registration_no FROM optical_prescriptions
    WHERE business_id=$1 AND examiner_kind='outside' ORDER BY lower(examiner_name),id DESC LIMIT 50`, [business.id]);
  return { staff, outside };
}

module.exports = { readRows, readPd, powersText, recallMonths, ROWS_SQL, detail, create, update, customerHistory, examiners };
