const repo = require('../repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const access = require('./businessAccess.service');

// Payment methods the owner manages (Settings › Payment methods). Each one
// has a name the shop chose ("PhonePe", "Sodexo") and one of five fixed
// kinds. Everything that counts money (day close, the drawer, the cheque
// register, change given back) works on the kind; the name is recorded next
// to it on each payment so the day close can show it.
//
// A request names a method by `methodId`. Older screens send only `method`
// (the kind): that keeps working exactly as before, with no name recorded.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const KINDS = ['cash', 'upi', 'card', 'bank', 'cheque'];
const KIND_NAMES = { cash: 'cash', upi: 'UPI', card: 'card', bank: 'bank transfer', cheque: 'cheque' };
const isGiven = (value) => value !== undefined && value !== null && value !== '';
const kindList = (kinds) => kinds.map((k) => KIND_NAMES[k] || k).join(', ').replace(/, ([^,]*)$/, ' or $1');

async function list(business, query = {}) {
  // Every member sees the methods switched on (the counter needs them);
  // switched-off ones are for those who look after the settings.
  const all = query.all === true || query.all === 'true';
  if (all) await access.require(business, 'settings.view');
  return repo.all(repo.pool, `SELECT id,name,kind,active,sort_order,created_at,updated_at FROM business_payment_methods
    WHERE business_id=$1 ${all ? '' : 'AND active'} ORDER BY sort_order,id`, [business.id]);
}

const readName = (value) => v.requiredString(value, 'Name', 60).replace(/\s+/g, ' ');
function readSort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = v.requiredNumber(value, 'Order', { min: 0, max: 10000 });
  if (!Number.isInteger(n)) fail('Order must be a whole number');
  return n;
}
async function nameFree(db, businessId, name, exceptId = null) {
  const same = await repo.one(db, 'SELECT name FROM business_payment_methods WHERE business_id=$1 AND lower(name)=lower($2) AND id IS DISTINCT FROM $3',
    [businessId, name, exceptId]);
  if (same) fail(`There is already a payment method called ${same.name}`, 409);
}
// One change at a time per business: the name check and the "last one
// switched on" rule then hold under concurrent edits.
const lockMethods = (db, businessId) => db.query('SELECT id FROM business_payment_methods WHERE business_id=$1 ORDER BY id FOR UPDATE', [businessId]);

async function create(business, user, body) {
  await access.require(business, 'settings.edit');
  const name = readName(body.name);
  const kind = v.requiredEnum(body.kind, 'Kind', KINDS);
  const active = v.requiredBoolean(body.active, 'Active', true);
  return repo.transaction(async (db) => {
    await lockMethods(db, business.id);
    await nameFree(db, business.id, name);
    // A new method goes to the end of the list unless an order is given.
    const last = await repo.one(db, 'SELECT COALESCE(max(sort_order),0) AS n FROM business_payment_methods WHERE business_id=$1', [business.id]);
    const sortOrder = readSort(body.sortOrder, Math.min(Number(last.n) + 10, 10000));
    const row = await repo.one(db, `INSERT INTO business_payment_methods(business_id,name,kind,active,sort_order,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id,name,kind,active,sort_order,created_at,updated_at`, [business.id, name, kind, active, sortOrder, user.id]);
    await repo.audit(db, business.id, user.id, 'payment_method.created', row.id, { name, kind, active, sortOrder });
    return row;
  });
}

async function update(business, user, methodId, body) {
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    await lockMethods(db, business.id);
    const current = await repo.one(db, 'SELECT * FROM business_payment_methods WHERE business_id=$1 AND id=$2', [business.id, v.requiredId(methodId, 'Payment method')]);
    if (!current) fail('Payment method not found', 404);
    // The kind decides how the money is counted; changing it would move past
    // payments between cash and bank in the books. Add a new method instead.
    if (isGiven(body.kind) && body.kind !== current.kind) fail('A payment method\'s kind cannot change. Add a new method with the right kind and switch this one off.', 409);
    const name = body.name === undefined ? current.name : readName(body.name);
    const active = body.active === undefined ? current.active : v.requiredBoolean(body.active, 'Active');
    const sortOrder = readSort(body.sortOrder, current.sort_order);
    if (name.toLowerCase() !== current.name.toLowerCase()) await nameFree(db, business.id, name, current.id);
    if (current.active && !active) {
      const others = await repo.one(db, 'SELECT count(*)::int AS n FROM business_payment_methods WHERE business_id=$1 AND active AND id<>$2', [business.id, current.id]);
      if (!others.n) fail('This is the last payment method switched on. Add or switch on another one first.', 409);
    }
    const row = await repo.one(db, `UPDATE business_payment_methods SET name=$3,active=$4,sort_order=$5,updated_by=$6,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING id,name,kind,active,sort_order,created_at,updated_at`, [business.id, current.id, name, active, sortOrder, user.id]);
    const changes = {};
    if (name !== current.name) Object.assign(changes, { nameFrom: current.name, nameTo: name });
    if (active !== current.active) changes.active = active;
    if (sortOrder !== current.sort_order) changes.sortOrder = sortOrder;
    if (Object.keys(changes).length) await repo.audit(db, business.id, user.id, 'payment_method.updated', row.id, { name, kind: row.kind, ...changes });
    return row;
  });
}

// --- Taking money by a method --------------------------------------------------

// Reads which method a payment names, without the database: `methodId` (a
// method this business set up; `method`, when also sent, must be its kind)
// or the kind alone from older screens. `kinds`: the kinds this payment may
// use (a refund cannot go out by cheque, for instance).
function readChoice(source, label = 'Payment method', kinds = KINDS, fallback = undefined) {
  const input = source || {};
  if (isGiven(input.methodId)) {
    return { methodId: v.requiredId(input.methodId, label), method: isGiven(input.method) ? v.requiredEnum(input.method, label, KINDS) : null };
  }
  return { methodId: null, method: v.requiredEnum(input.method ?? fallback, label, kinds) };
}

// The kind and name a chosen method records: { method, methodName }. Only an
// active method of this business is accepted.
async function settle(db, businessId, choice, label = 'Payment method', kinds = KINDS) {
  if (!choice.methodId) return { method: choice.method, methodName: null };
  const row = await repo.one(db, 'SELECT name,kind,active FROM business_payment_methods WHERE business_id=$1 AND id=$2', [businessId, choice.methodId]);
  if (!row) fail(`${label}: that payment method was not found`, 404);
  if (!row.active) fail(`${row.name} is switched off. Choose another payment method.`, 409);
  if (choice.method && choice.method !== row.kind) fail(`${row.name} is a ${KIND_NAMES[row.kind]} method, not ${KIND_NAMES[choice.method] || choice.method}`);
  if (!kinds.includes(row.kind)) fail(`${row.name} (${KIND_NAMES[row.kind]}) cannot be used here. Choose ${kindList(kinds)}.`);
  return { method: row.kind, methodName: row.name };
}

// Both steps at once, where the request is read with the database at hand.
const pick = (db, businessId, source, label, kinds = KINDS, fallback = undefined) => settle(db, businessId, readChoice(source, label, kinds, fallback), label, kinds);

// The parts of a bill's payment (read by readPaymentPart): each part that
// names a method takes that method's kind and name. Only cash may be
// over-tendered, so that is checked again once the kind is known.
async function settleParts(db, businessId, parts) {
  const settled = [];
  for (const part of parts) {
    if (!part.methodId) { settled.push({ ...part, methodName: part.methodName ?? null }); continue; }
    const { method, methodName } = await settle(db, businessId, { methodId: part.methodId, method: part.method }, 'Payment method', part.kinds || KINDS);
    if (part.tendered !== null && part.tendered !== undefined && method !== 'cash') fail('Only cash is handed over in notes: change is given back from cash only');
    settled.push({ ...part, method, methodName });
  }
  return settled;
}

// Day close and payment lists: payments from older screens (no name) show
// under the kind's own default name.
const DEFAULT_NAMES = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank transfer', cheque: 'Cheque' };
const displayName = (method, methodName) => methodName || DEFAULT_NAMES[method] || method;

module.exports = { list, create, update, readChoice, settle, pick, settleParts, displayName };
