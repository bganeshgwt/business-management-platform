const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const returns = require('../../core/services/businessReturns.service');
const setup = require('./fuelSetup.service');
const c = require('./fuelCommon');
const money = require('./fuelMoney');

// Shifts (module "fuel", fuel stations): what each attendant's nozzles gave
// out and what the attendant handed in. Every reading is typed in from the
// totalisers; nothing here talks to a dispenser.
//
//   open      an attendant (DSM) takes nozzles that are on no open shift,
//             each from its totaliser as it last read (a shift opens where
//             the last one closed), at the prices in force at the outlet.
//             An attendant opens their own shift; someone who may keep any
//             attendant's shift (fuel.edit) opens it for them.
//   close     each nozzle's closing reading and its test quantity (the
//             5-litre test, pumped back: not a sale); the credit slips of
//             fleet customers' vehicles; the UPI, card and fleet-card takings
//             and the cash counted. The meters' litres at the price in force
//             when the shift opened are the expected money, exact to the
//             paisa; the attendant is short or in excess against the walk-in
//             sales. The close posts the sales through the core: one walk-in
//             fuel bill (a line for each fuel, paid by the other takings and
//             then the cash, a short left due on it) and a fuel bill to each
//             fleet customer (a line for each slip, with its vehicle); no
//             round-off. A fill over a vehicle's fill limit, or credit taking a
//             customer over their credit limit, is allowed by a manager.
//   reopen    a closed shift never changes: a manager reopens it with a
//             reason, before another shift opens on its nozzles. Its bills are
//             credited (the litres back in stock until it closes again), the
//             walk-in bill's takings handed back, and its nozzles read again
//             from the shift's opening.
// Someone who does not see sales sees and closes their own shifts only.

const { fail, id } = c;
const MAX_NOZZLES = 24;
const MAX_SLIPS = 200;
const MAX_TAKINGS = 20;
// A sale over ₹2,00,000 records the buyer's PAN: on a fleet bill, each credit fill is its own sale.
const PAN_ABOVE_PAISE = 20000000;

// --- Lists ----------------------------------------------------------------------------------------

const SHIFTS_SQL = `SELECT s.id,s.shift_no,s.location_id,l.name AS location_name,s.attendant_id,s.attendant_name,s.status,s.opened_at,s.notes,s.created_at,s.updated_at,
    (s.opened_at AT TIME ZONE b.timezone)::date::text AS day,
    k.id AS close_id,k.seq,k.closed_at,k.expected,k.credit,k.walk_in,k.cash,k.other,k.difference,k.document_id,d.document_no,
    (SELECT string_agg(n.nozzle_no,', ' ORDER BY n.nozzle_no) FROM fuel_shift_nozzles n WHERE n.business_id=s.business_id AND n.shift_id=s.id) AS nozzle_list,
    (SELECT string_agg(sk.label || ' ' || trim(to_char(p.litres,'FM999999999990.000')) || ' ' || sk.unit,' · ' ORDER BY f.sort_order,sk.label)
      FROM fuel_close_products p JOIN fuel_products f ON f.business_id=p.business_id AND f.id=p.product_id JOIN catalog_skus sk ON sk.business_id=f.business_id AND sk.id=f.sku_id
      WHERE p.business_id=k.business_id AND p.close_id=k.id AND p.litres>0) AS sold,
    (SELECT count(*)::int FROM fuel_shift_closes x WHERE x.business_id=s.business_id AND x.shift_id=s.id AND x.reopened_at IS NOT NULL) AS reopened
  FROM fuel_shifts s JOIN businesses b ON b.id=s.business_id JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id
  LEFT JOIN fuel_shift_closes k ON k.business_id=s.business_id AND k.shift_id=s.id AND k.reopened_at IS NULL
  LEFT JOIN business_documents d ON d.business_id=k.business_id AND d.id=k.document_id
  WHERE s.business_id=$1`;

repo.addLists({
  // Every shift, newest first, with what it sold and its settlement (the close in force).
  'fuel-shifts': { sql: SHIFTS_SQL, search: ['shift_no', 'attendant_name', 'nozzle_list', 'document_no', 'sold'], date: 'opened_at',
    filters: { status: 'status', location: 'location_id', attendant: 'attendant_id', day: 'day' }, order: 'opened_at DESC,id DESC' },
});

const MONEY = ['expected', 'credit', 'walk_in', 'cash', 'other', 'difference'];
// Money of another attendant's shift is for those who see sales.
const showsMoney = (business, user, shift) => c.seesMoney(business) || String(shift.attendant_id) === String(user.id);
const withoutMoney = (row) => ({ ...row, ...Object.fromEntries(MONEY.map((k) => [k, null])) });

// The shifts list: everyone's for those who see sales, one's own otherwise.
async function list(business, user, query) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const limit = query.limit === undefined ? 25 : v.requiredId(query.limit, 'Page size');
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) fail('Invalid pagination');
  const filters = {};
  for (const name of repo.listFilters('fuel-shifts')) if (query[name] !== undefined && query[name] !== '') filters[name] = String(query[name]).slice(0, 60);
  if (!c.seesMoney(business)) filters.attendant = String(user.id);
  const search = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : null;
  const from = query.from ? core.dateText(query.from, 'From date') : null, to = query.to ? core.dateText(query.to, 'To date') : null;
  if (from && to && to < from) fail('The end date is before the start date');
  return repo.page(business.id, 'fuel-shifts', limit, offset, { search, from, to, timezone: business.timezone, filters });
}

// --- Who may be an attendant ------------------------------------------------------------------

async function attendants(business, user) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  if (!access.can(business, 'fuel.edit')) return [{ id: Number(user.id), name: user.name }];
  return repo.all(repo.pool, `SELECT u.id,u.name,r.name AS role_name,m.location_id FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id WHERE m.business_id=$1 AND m.active ORDER BY u.name`, [business.id]);
}

// --- The day's board -------------------------------------------------------------------------

// An outlet's nozzles with the shift each is on, its unit's stamping and the price of its fuel.
async function nozzlesAt(db, business, locationId) {
  return repo.all(db, `SELECT n.id,n.nozzle_no,n.reading,n.active,n.product_id,n.tank_id,s.label AS product_name,f.family,s.unit,t.tank_no,d.id AS dispenser_id,d.unit_no,
      d.status AS unit_status,d.stamping_due::text AS stamping_due,(d.stamping_due - (now() AT TIME ZONE b.timezone)::date) AS days_to_due,
      fuel_price_at(n.business_id,n.location_id,n.product_id,now()) AS price,o.shift_id AS open_shift_id,o.shift_no AS open_shift_no,o.attendant_name AS open_attendant
    FROM fuel_nozzles n JOIN businesses b ON b.id=n.business_id JOIN fuel_dispensers d ON d.business_id=n.business_id AND d.id=n.dispenser_id
    JOIN fuel_products f ON f.business_id=n.business_id AND f.id=n.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    LEFT JOIN fuel_tanks t ON t.business_id=n.business_id AND t.id=n.tank_id
    LEFT JOIN LATERAL fuel_nozzle_open_shift(n.business_id,n.id) o ON TRUE
    WHERE n.business_id=$1 AND n.location_id=$2 AND n.active AND d.status<>'retired' ORDER BY d.sort_order,d.unit_no,n.sort_order,n.nozzle_no`, [business.id, locationId]);
}

// query: { date?, locationId? } — the outlet's prices in force, its nozzles
// (free or on a shift), the shifts open, and the shifts of the day (opened or
// closed on it), each with its settlement.
async function day(business, user, query = {}) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  const db = repo.pool;
  const location = await c.boardOutlet(db, business, query.locationId || query.location);
  const today = await c.today(db, business);
  const date = query.date ? c.readDate(query.date, 'Date') : today;
  const sees = c.seesMoney(business);
  const [prices, nozzles, settings] = [await setup.pricesOf(db, business, location.id), await nozzlesAt(db, business, location.id), await c.settingsOf(db, business.id)];
  const shifts = await repo.all(db, `SELECT * FROM (${SHIFTS_SQL}) x WHERE x.location_id=$2 AND (x.status='open' OR x.day=$3
      OR (x.closed_at AT TIME ZONE $4)::date=$3::date) AND ($5::bigint IS NULL OR x.attendant_id=$5) ORDER BY x.status='open' DESC,x.opened_at DESC`,
  [business.id, location.id, date, business.timezone, sees ? null : user.id]);
  const open = shifts.filter((s) => s.status === 'open');
  const takings = await repo.all(db, `SELECT n.shift_id,n.nozzle_id,n.nozzle_no,n.opening,s.label AS product_name,s.unit FROM fuel_shift_nozzles n
    JOIN fuel_products f ON f.business_id=n.business_id AND f.id=n.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    WHERE n.business_id=$1 AND n.shift_id=ANY($2::bigint[]) ORDER BY n.nozzle_no`, [business.id, open.map((s) => s.id)]);
  for (const s of open) s.nozzles = takings.filter((t) => String(t.shift_id) === String(s.id));
  return { date, today, location, prices, nozzles, settings: { testLitres: settings.test_litres, stampingWarnDays: Number(settings.stamping_warn_days) },
    open, closed: shifts.filter((s) => s.status === 'closed').map((s) => (showsMoney(business, user, s) ? s : withoutMoney(s))) };
}

// --- Reading a shift ---------------------------------------------------------------------------

async function shiftRow(db, business, shiftId, { lock = false } = {}) {
  const shift = await repo.one(db, `SELECT * FROM fuel_shifts WHERE business_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [business.id, id(shiftId, 'Shift')]);
  if (!shift) fail('Shift not found', 404);
  access.requireLocation(business, shift.location_id);
  return shift;
}
// Someone who does not see sales works with their own shifts only.
function requireOwn(business, user, shift) {
  if (!c.seesMoney(business) && String(shift.attendant_id) !== String(user.id)) fail('Shift not found', 404);
}
// Someone keeps their own shift (fuel.create); another attendant's needs fuel.edit.
async function requireKeeper(business, user, shift) {
  requireOwn(business, user, shift);
  if (String(shift.attendant_id) !== String(user.id)) await access.require(business, 'fuel.edit');
}

const DUE_SQL = (d) => `(${d}.total
  -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
  -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
  +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;

// A close with its readings, sales, credit fills, takings and bills.
async function closeDetail(db, business, close) {
  const readings = await repo.all(db, `SELECT r.*,n.nozzle_no,s.label AS product_name,s.unit,t.tank_no FROM fuel_close_readings r
    JOIN fuel_shift_nozzles n ON n.business_id=r.business_id AND n.shift_id=r.shift_id AND n.nozzle_id=r.nozzle_id
    JOIN fuel_products f ON f.business_id=r.business_id AND f.id=r.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    LEFT JOIN fuel_tanks t ON t.business_id=r.business_id AND t.id=r.tank_id WHERE r.business_id=$1 AND r.close_id=$2 ORDER BY n.nozzle_no`, [business.id, close.id]);
  const products = await repo.all(db, `SELECT p.*,s.label AS product_name,s.unit,f.family FROM fuel_close_products p JOIN fuel_products f ON f.business_id=p.business_id AND f.id=p.product_id
    JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id WHERE p.business_id=$1 AND p.close_id=$2 ORDER BY f.sort_order,s.label`, [business.id, close.id]);
  const slips = await repo.all(db, `SELECT k.*,ct.name AS customer_name,s.label AS product_name,s.unit,d.document_no FROM fuel_credit_slips k
    JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id JOIN fuel_products f ON f.business_id=k.business_id AND f.id=k.product_id
    JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id JOIN business_documents d ON d.business_id=k.business_id AND d.id=k.document_id
    WHERE k.business_id=$1 AND k.close_id=$2 ORDER BY k.seq`, [business.id, close.id]);
  const takings = await repo.all(db, 'SELECT * FROM fuel_close_payments WHERE business_id=$1 AND close_id=$2 ORDER BY seq', [business.id, close.id]);
  const documentIds = [...new Set([close.document_id, ...slips.map((s) => s.document_id)].filter(Boolean).map(String))];
  const bills = documentIds.length ? await repo.all(db, `SELECT d.id,d.document_no,d.contact_id,d.contact_name,d.total,d.due_on::text AS due_on,d.created_at,
      COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0) AS paid,
      COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned,
      ${DUE_SQL('d')} AS due FROM business_documents d WHERE d.business_id=$1 AND d.id=ANY($2::bigint[]) ORDER BY d.id`, [business.id, documentIds]) : [];
  const names = await repo.all(db, 'SELECT id,name FROM users WHERE id=ANY($1::bigint[])', [[close.closed_by, close.reopened_by, close.approved_by].filter(Boolean)]);
  const nameOf = (userId) => names.find((u) => String(u.id) === String(userId))?.name || null;
  return { ...close, readings, products, slips, takings, bills, cash_paid: money.rupees(Math.max(0, Math.min(money.paise(close.cash), money.paise(close.walk_in) - money.paise(close.other)))),
    closed_by_name: nameOf(close.closed_by), reopened_by_name: nameOf(close.reopened_by), approved_by_name: nameOf(close.approved_by) };
}

async function load(db, business, user, shiftId) {
  const shift = await repo.one(db, `SELECT s.*,l.name AS location_name,u.name AS opened_by_name,(s.opened_at AT TIME ZONE b.timezone)::date::text AS day
    FROM fuel_shifts s JOIN businesses b ON b.id=s.business_id JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id JOIN users u ON u.id=s.created_by
    WHERE s.business_id=$1 AND s.id=$2`, [business.id, shiftId]);
  if (!shift) fail('Shift not found', 404);
  access.requireLocation(business, shift.location_id);
  requireOwn(business, user, shift);
  const nozzles = await repo.all(db, `SELECT n.*,s.label AS product_name,f.family,s.unit,t.tank_no,z.reading AS reading_now,d.unit_no,d.stamping_due::text AS stamping_due,
      fuel_price_at(n.business_id,$4,n.product_id,$3) AS price
    FROM fuel_shift_nozzles n JOIN fuel_nozzles z ON z.business_id=n.business_id AND z.id=n.nozzle_id JOIN fuel_dispensers d ON d.business_id=z.business_id AND d.id=z.dispenser_id
    JOIN fuel_products f ON f.business_id=n.business_id AND f.id=n.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    LEFT JOIN fuel_tanks t ON t.business_id=n.business_id AND t.id=n.tank_id WHERE n.business_id=$1 AND n.shift_id=$2 ORDER BY n.nozzle_no`, [business.id, shift.id, shift.opened_at, shift.location_id]);
  const closes = await repo.all(db, 'SELECT * FROM fuel_shift_closes WHERE business_id=$1 AND shift_id=$2 ORDER BY seq', [business.id, shift.id]);
  const detailed = [];
  for (const close of closes) detailed.push(await closeDetail(db, business, close));
  const current = detailed.find((x) => !x.reopened_at) || null;
  // Reopenable while no other shift has opened on its nozzles since it closed.
  const next = current ? await repo.one(db, `SELECT s.shift_no,n2.nozzle_no FROM fuel_shift_nozzles n1
      JOIN fuel_shift_nozzles n2 ON n2.business_id=n1.business_id AND n2.nozzle_id=n1.nozzle_id AND n2.shift_id<>n1.shift_id
      JOIN fuel_shifts s ON s.business_id=n2.business_id AND s.id=n2.shift_id WHERE n1.business_id=$1 AND n1.shift_id=$2 AND s.created_at>$3 ORDER BY s.created_at LIMIT 1`,
  [business.id, shift.id, current.created_at]) : null;
  const sees = showsMoney(business, user, shift);
  const hide = (close) => (sees ? close : { ...withoutMoney(close), products: close.products.map((p) => ({ ...p, price: null, credit_amount: null, walk_in_amount: null, amount: null })),
    slips: close.slips.map((s) => ({ ...s, price: null, amount: null })), takings: [], bills: [], cash_paid: null });
  const { request_hash: _hash, ...rest } = shift;
  return { ...rest, nozzles, close: current ? hide(current) : null, history: detailed.filter((x) => x.reopened_at).map(hide), money: sees,
    reopenable: Boolean(current) && !next, next_shift: next || null, test_litres: (await c.settingsOf(db, business.id)).test_litres };
}

async function detail(business, user, shiftId) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  return load(repo.pool, business, user, id(shiftId, 'Shift'));
}

// --- Opening a shift ---------------------------------------------------------------------------

function readTakeOn(raw, index) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { nozzleId: id(raw.nozzleId, `Nozzle ${index + 1}`), opening: c.given(raw.opening) ? c.readReading(raw.opening, `Nozzle ${index + 1}: opening reading`) : null };
  }
  return { nozzleId: id(raw, `Nozzle ${index + 1}`), opening: null };
}

// A nozzle taken onto an open shift: free, in use, priced, from its reading now.
async function takeNozzle(db, business, user, shift, wanted, openedAt) {
  const nozzle = await repo.one(db, `SELECT n.*,d.status AS unit_status,d.unit_no,s.label AS product_name,
      fuel_price_at(n.business_id,n.location_id,n.product_id,$3) AS price FROM fuel_nozzles n
    JOIN fuel_dispensers d ON d.business_id=n.business_id AND d.id=n.dispenser_id JOIN fuel_products f ON f.business_id=n.business_id AND f.id=n.product_id
    JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id WHERE n.business_id=$1 AND n.id=$2 FOR UPDATE OF n`, [business.id, wanted.nozzleId, openedAt]);
  if (!nozzle || String(nozzle.location_id) !== String(shift.location_id)) fail('Nozzle not found at this outlet', 404);
  if (!nozzle.active) fail(`Nozzle ${nozzle.nozzle_no} is switched off`, 409);
  if (nozzle.unit_status !== 'in_use') fail(`Dispensing unit ${nozzle.unit_no} is ${nozzle.unit_status}: its nozzles are not used until it is back in use`, 409);
  const busy = await repo.one(db, 'SELECT * FROM fuel_nozzle_open_shift($1,$2)', [business.id, nozzle.id]);
  if (busy && String(busy.shift_id) !== String(shift.id)) fail(`Nozzle ${nozzle.nozzle_no} is on shift ${busy.shift_no} (${busy.attendant_name}), still open`, 409);
  if (busy) fail(`Nozzle ${nozzle.nozzle_no} is on this shift already`, 409);
  if (nozzle.price === null) fail(`${nozzle.product_name} has no price at this outlet from the shift's opening: set the price first (Settings › Pumps & nozzles)`, 409);
  if (wanted.opening !== null && wanted.opening !== nozzle.reading) {
    fail(`Nozzle ${nozzle.nozzle_no}'s totaliser reads ${nozzle.reading} from its last close: a shift opens from there. If the meter was replaced or reset, a manager records the meter change first.`, 409);
  }
  await db.query(`INSERT INTO fuel_shift_nozzles(business_id,shift_id,nozzle_id,nozzle_no,product_id,tank_id,opening,added_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [business.id, shift.id, nozzle.id, nozzle.nozzle_no, nozzle.product_id, nozzle.tank_id, nozzle.reading, user.id]);
  return nozzle;
}

// body: { requestKey, locationId, attendantId? (oneself when left out), openedAt? (now), nozzles: [nozzleId | { nozzleId, opening? }], notes? }
async function open(business, user, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const attendantId = c.given(body.attendantId) ? id(body.attendantId, 'Attendant') : Number(user.id);
  if (String(attendantId) !== String(user.id)) await access.require(business, 'fuel.edit');
  const wanted = v.requiredArray(body.nozzles, 'Nozzles').map(readTakeOn);
  if (!wanted.length) fail('Choose the nozzles the attendant runs');
  if (wanted.length > MAX_NOZZLES) fail(`A shift runs at most ${MAX_NOZZLES} nozzles`);
  if (new Set(wanted.map((w) => w.nozzleId)).size !== wanted.length) fail('Each nozzle is taken once');
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM fuel_shifts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return load(db, business, user, old.id);
    }
    const location = await c.locationOf(db, business, body.locationId);
    const member = await repo.one(db, `SELECT u.id,u.name,m.location_id FROM business_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.business_id=$1 AND m.user_id=$2 AND m.active`, [business.id, attendantId]);
    if (!member) fail('The attendant is not on this business\'s staff', 404);
    if (member.location_id && String(member.location_id) !== String(location.id)) fail(`${member.name} works at another outlet`, 409);
    const already = await repo.one(db, "SELECT shift_no FROM fuel_shifts WHERE business_id=$1 AND location_id=$2 AND attendant_id=$3 AND status='open'", [business.id, location.id, attendantId]);
    if (already) fail(`${member.name}'s shift ${already.shift_no} is still open: close it before opening another`, 409);
    const typed = await c.readWhen(db, business, body.openedAt, 'Readings taken at');
    const openedAt = typed || (await repo.one(db, 'SELECT now() AS at')).at;
    const number = await numbering.nextNumber(db, business.id, location.id, 'fuel_shift', user.id);
    const shift = await repo.one(db, `INSERT INTO fuel_shifts(business_id,location_id,shift_no,series_id,attendant_id,attendant_name,opened_at,notes,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`, [business.id, location.id, number.number, number.seriesId, attendantId, member.name, openedAt, notes, requestKey, hash, user.id]);
    const taken = [];
    for (const w of wanted) taken.push(await takeNozzle(db, business, user, shift, w, openedAt));
    await repo.audit(db, business.id, user.id, 'fuel_shift.opened', shift.id, { shiftNo: shift.shift_no, attendant: member.name, location: location.name,
      nozzles: taken.map((n) => ({ nozzleNo: n.nozzle_no, opening: n.reading, price: n.price })) });
    await repo.event(db, business.id, user.id, 'fuel_shift.opened', 'fuel_shift', shift.id, { shiftNo: shift.shift_no, locationId: location.id, attendantId,
      openedAt: shift.opened_at, nozzles: taken.map((n) => ({ nozzleId: n.id, opening: n.reading })) });
    return load(db, business, user, shift.id);
  });
}

// body: { nozzleId, opening? } — another nozzle taken onto an open shift, from its reading now.
async function addNozzle(business, user, shiftId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const wanted = readTakeOn(body, 0);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const shift = await shiftRow(db, business, shiftId, { lock: true });
    await requireKeeper(business, user, shift);
    if (shift.status !== 'open') fail(`Shift ${shift.shift_no} is closed`, 409);
    const nozzle = await takeNozzle(db, business, user, shift, wanted, shift.opened_at);
    await repo.audit(db, business.id, user.id, 'fuel_shift.nozzle_added', shift.id, { shiftNo: shift.shift_no, nozzleNo: nozzle.nozzle_no, opening: nozzle.reading });
    return load(db, business, user, shift.id);
  });
}

// A nozzle taken off an open shift before any close of it (taken by mistake).
async function removeNozzle(business, user, shiftId, nozzleId) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const shift = await shiftRow(db, business, shiftId, { lock: true });
    await requireKeeper(business, user, shift);
    if (shift.status !== 'open') fail(`Shift ${shift.shift_no} is closed`, 409);
    const taken = await repo.one(db, 'SELECT * FROM fuel_shift_nozzles WHERE business_id=$1 AND shift_id=$2 AND nozzle_id=$3', [business.id, shift.id, id(nozzleId, 'Nozzle')]);
    if (!taken) fail('That nozzle is not on this shift', 404);
    const count = await repo.one(db, 'SELECT count(*)::int AS n FROM fuel_shift_nozzles WHERE business_id=$1 AND shift_id=$2', [business.id, shift.id]);
    if (count.n < 2) fail('A shift runs one nozzle at least: close it instead', 409);
    await db.query('DELETE FROM fuel_shift_nozzles WHERE business_id=$1 AND shift_id=$2 AND nozzle_id=$3', [business.id, shift.id, taken.nozzle_id]);
    await repo.audit(db, business.id, user.id, 'fuel_shift.nozzle_removed', shift.id, { shiftNo: shift.shift_no, nozzleNo: taken.nozzle_no });
    return load(db, business, user, shift.id);
  });
}

// body: { notes } — an open shift's notes.
async function updateNotes(business, user, shiftId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const notes = c.optionalText(body.notes, 'Notes', 500);
  return repo.transaction(async (db) => {
    const shift = await shiftRow(db, business, shiftId, { lock: true });
    await requireKeeper(business, user, shift);
    if (shift.status !== 'open') fail(`Shift ${shift.shift_no} is closed and no longer changes`, 409);
    await db.query('UPDATE fuel_shifts SET notes=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, shift.id, notes, user.id]);
    return load(db, business, user, shift.id);
  });
}

// --- Closing a shift ---------------------------------------------------------------------------

// The close as typed: { closedAt?, readings: [{ nozzleId, closing, test? }],
// cash, payments?: [{ methodId, amount, reference? }], slips?: [{ contactId,
// vehicleId, productId?, litres, slipNo? }], note?, approve? }
function readClose(body) {
  const readings = v.requiredArray(body.readings, 'Closing readings').map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail(`Reading ${i + 1} must be an object`);
    return { nozzleId: id(r.nozzleId, `Reading ${i + 1}: nozzle`), closing: c.readReading(r.closing, `Reading ${i + 1}: closing reading`),
      test: c.given(r.test) ? c.readLitres(r.test, `Reading ${i + 1}: test pumped back`, { max: 1000 }) : '0.000' };
  });
  if (new Set(readings.map((r) => r.nozzleId)).size !== readings.length) fail('Each nozzle is read once');
  const payments = body.payments === undefined || body.payments === null ? [] : v.requiredArray(body.payments, 'Takings');
  if (payments.length > MAX_TAKINGS) fail(`At most ${MAX_TAKINGS} takings other than cash`);
  const slips = body.slips === undefined || body.slips === null ? [] : v.requiredArray(body.slips, 'Credit slips');
  if (slips.length > MAX_SLIPS) fail(`A shift takes at most ${MAX_SLIPS} credit slips`);
  return {
    readings,
    cash: c.readMoney(c.given(body.cash) ? body.cash : '0', 'Cash counted'),
    payments: payments.map((p, i) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) fail(`Taking ${i + 1} must be an object`);
      return { methodId: id(p.methodId, `Taking ${i + 1}: how it was paid`), amount: c.readMoney(p.amount, `Taking ${i + 1}: amount`, { min: 0, minExclusive: true }),
        reference: c.optionalText(p.reference, `Taking ${i + 1}: reference`, 100) };
    }),
    slips: slips.map((s, i) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) fail(`Credit slip ${i + 1} must be an object`);
      return { contactId: id(s.contactId, `Credit slip ${i + 1}: customer`), vehicleId: id(s.vehicleId, `Credit slip ${i + 1}: vehicle`),
        productId: c.given(s.productId) ? id(s.productId, `Credit slip ${i + 1}: fuel`) : null,
        litres: c.readLitres(s.litres, `Credit slip ${i + 1}: litres`, { min: 0, minExclusive: true }), slipNo: c.optionalText(s.slipNo, `Credit slip ${i + 1}: slip number`, 30) };
    }),
    note: c.optionalText(body.note, 'Note', 300),
    approve: v.requiredBoolean(body.approve, 'Allow credit over a limit', false),
  };
}

// Everything a close needs, worked out and checked, nothing saved: the
// readings against the nozzles' openings, the price in force, each slip's
// vehicle and limits, the takings' methods, and the figures to the paisa.
async function prepareClose(db, business, user, shift, input, closedAtTyped) {
  const zone = business.timezone || 'Asia/Kolkata';
  const taken = await repo.all(db, `SELECT n.*,s.label AS product_name,s.unit,f.sku_id,f.family FROM fuel_shift_nozzles n
    JOIN fuel_products f ON f.business_id=n.business_id AND f.id=n.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    WHERE n.business_id=$1 AND n.shift_id=$2 ORDER BY n.nozzle_no`, [business.id, shift.id]);
  const missing = taken.find((n) => !input.readings.some((r) => String(r.nozzleId) === String(n.nozzle_id)));
  if (missing) fail(`Give nozzle ${missing.nozzle_no}'s closing reading`);
  const stray = input.readings.find((r) => !taken.some((n) => String(n.nozzle_id) === String(r.nozzleId)));
  if (stray) fail('A reading is for a nozzle that is not on this shift', 404);
  const readings = taken.map((n) => {
    const r = input.readings.find((x) => String(x.nozzleId) === String(n.nozzle_id));
    const figures = money.nozzleFigures({ opening: n.opening, closing: r.closing, test: r.test });
    if (figures.gross < 0) fail(`Nozzle ${n.nozzle_no} opened the shift at ${n.opening}: its closing reading is not less than that`);
    if (figures.litres < 0) fail(`Nozzle ${n.nozzle_no} moved ${money.litres(figures.gross)} ${n.unit === 'kg' ? 'kg' : 'litres'}: the test pumped back is no more than that`);
    if (figures.gross > money.milli(c.MAX_LITRES)) fail(`Nozzle ${n.nozzle_no} cannot have given out more than ${c.MAX_LITRES} litres on one shift: check the reading`);
    return { nozzle: n, nozzleId: n.nozzle_id, productId: n.product_id, tankId: n.tank_id, opening: n.opening, closing: r.closing, test: r.test };
  });
  const now = (await repo.one(db, 'SELECT now() AS at')).at;
  const closedAt = closedAtTyped || now;
  if (new Date(closedAt) < new Date(shift.opened_at)) fail(`Shift ${shift.shift_no} opened at ${c.timeWords(shift.opened_at, zone)}: its closing readings are taken after that`);
  if (new Date(closedAt) > new Date(now)) fail('The closing readings are taken now or earlier');
  // The price in force when the shift opened, for each fuel; none may change while it is open.
  const productIds = [...new Set(taken.map((n) => String(n.product_id)))];
  const prices = {};
  const fuels = {};
  for (const productId of productIds) {
    const n = taken.find((x) => String(x.product_id) === productId);
    fuels[productId] = { name: n.product_name, unit: n.unit, skuId: n.sku_id, family: n.family };
    const row = await repo.one(db, `SELECT fuel_price_at($1,$2,$3,$4) AS price,
        (SELECT min(effective_from) FROM fuel_prices x WHERE x.business_id=$1 AND x.location_id=$2 AND x.product_id=$3 AND x.effective_from>$4 AND x.effective_from<$5) AS changed_at`,
    [business.id, shift.location_id, productId, shift.opened_at, closedAt]);
    if (row.price === null) fail(`${n.product_name} had no price at this outlet when the shift opened: set it first (Settings › Pumps & nozzles)`, 409);
    if (row.changed_at) {
      fail(`The price of ${n.product_name} changed at ${c.timeWords(row.changed_at, zone)}, while this shift was open: close it with the readings taken then (type that time), and open the next shift at the new price`, 409);
    }
    prices[productId] = row.price;
  }
  // Each credit slip: a vehicle of the customer in use, the fuel it takes, sold on this shift.
  const slips = [];
  for (const [index, s] of input.slips.entries()) {
    const label = `Credit slip ${index + 1}`;
    const vehicle = await repo.one(db, `SELECT v.*,ct.name AS customer_name,ct.kind,ct.active AS customer_active FROM fuel_vehicles v
      JOIN business_contacts ct ON ct.business_id=v.business_id AND ct.id=v.contact_id WHERE v.business_id=$1 AND v.id=$2`, [business.id, s.vehicleId]);
    if (!vehicle || String(vehicle.contact_id) !== String(s.contactId)) fail(`${label}: that vehicle is not one of the customer's`, 404);
    if (!vehicle.active) fail(`${label}: vehicle ${vehicle.registration} is switched off`, 409);
    if (!vehicle.customer_active) fail(`${label}: ${vehicle.customer_name} is switched off`, 409);
    const productId = String(s.productId || vehicle.product_id || '');
    if (!productId) fail(`${label}: choose the fuel ${vehicle.registration} took`);
    if (vehicle.product_id && String(vehicle.product_id) !== productId) fail(`${label}: ${vehicle.registration} takes ${(await nameOf(db, business, vehicle.product_id))} on credit`, 409);
    if (!fuels[productId]) fail(`${label}: no nozzle of this shift sells that fuel`, 409);
    if (s.slipNo) {
      const dup = await repo.one(db, `SELECT s.shift_no FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
        JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id WHERE k.business_id=$1 AND k.contact_id=$2 AND lower(k.slip_no)=lower($3) LIMIT 1`, [business.id, s.contactId, s.slipNo]);
      if (dup || input.slips.some((other, j) => j !== index && other.slipNo && String(other.contactId) === String(s.contactId) && other.slipNo.toLowerCase() === s.slipNo.toLowerCase())) {
        fail(`${label}: slip ${s.slipNo} of ${vehicle.customer_name} is entered already${dup ? ` (shift ${dup.shift_no})` : ''}`, 409);
      }
    }
    slips.push({ ...s, productId, vehicle, overFill: vehicle.fill_limit !== null && money.milli(s.litres) > money.milli(vehicle.fill_limit) });
  }
  // The other takings: UPI, cards and fleet cards, each a payment method of the business.
  const takings = [];
  for (const [index, p] of input.payments.entries()) {
    const method = await paymentMethods.settle(db, business.id, { methodId: p.methodId, method: null }, `Taking ${index + 1}`, c.TAKING_KINDS);
    takings.push({ ...p, method: method.method, methodName: method.methodName });
  }
  const figures = money.shiftFigures({ readings, prices, slips, cash: input.cash, payments: takings });
  for (const p of figures.products) {
    if (p.walkInLitres < 0) {
      const f = fuels[p.productId];
      fail(`The credit slips for ${f.name} come to ${money.litres(p.creditLitres)} ${f.unit === 'kg' ? 'kg' : 'litres'}, more than the ${money.litres(p.litres)} its nozzles gave out on this shift`, 409);
    }
  }
  if (figures.other > figures.walkIn) {
    fail(`The UPI, card and fleet-card takings come to ₹${money.rupees(figures.other)}, more than the ₹${money.rupees(figures.walkIn)} of walk-in sales: check them against the credit slips`, 409);
  }
  // Limits: a fill over its vehicle's fill limit; credit taking a customer over their credit limit.
  const limits = [];
  for (const s of figures.slips) {
    if (s.overFill) limits.push({ kind: 'fill', registration: s.vehicle.registration, litres: s.litres, limit: s.vehicle.fill_limit, customer: s.vehicle.customer_name });
    if (s.amount > PAN_ABOVE_PAISE) {
      const contact = await repo.one(db, 'SELECT pan,gstin FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, s.contactId]);
      if (!contact.pan && !(contact.gstin && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(contact.gstin).slice(2, 12)))) {
        fail(`The fill of ${s.vehicle.registration} comes to ₹${money.rupees(s.amount)}, over ₹2,00,000: keep ${s.vehicle.customer_name}'s PAN (or GSTIN) with the customer first`, 409);
      }
    }
  }
  const byCustomer = new Map();
  for (const s of figures.slips) byCustomer.set(String(s.contactId), (byCustomer.get(String(s.contactId)) || 0) + s.amount);
  for (const [contactId, amount] of byCustomer) {
    const owed = await repo.one(db, `SELECT c.name,c.credit_limit,${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [business.id, contactId]);
    if (owed.credit_limit !== null && money.paise(owed.balance) + amount > money.paise(owed.credit_limit)) {
      limits.push({ kind: 'credit', customer: owed.name, owed: owed.balance, after: money.rupees(money.paise(owed.balance) + amount), limit: owed.credit_limit, contactId });
    }
  }
  const overLimit = (s) => s.overFill || limits.some((l) => l.kind === 'credit' && String(l.contactId) === String(s.contactId));
  // What the core holds of each fuel at the outlet: the meters cannot sell more than came in.
  const stock = [];
  for (const p of figures.products) {
    if (p.litres <= 0) continue;
    const f = fuels[p.productId];
    const lot = await repo.one(db, `SELECT COALESCE(sum(quantity),0) AS quantity FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=''`,
      [business.id, shift.location_id, f.skuId]);
    if (money.milli(lot.quantity) < p.litres) stock.push({ name: f.name, unit: f.unit, family: f.family, sold: money.litres(p.litres), stock: lot.quantity });
  }
  return { readings, prices, fuels, slips: figures.slips.map((s) => ({ ...s, overLimit: overLimit(s) })), takings, figures, limits, stock, closedAt, typedAt: closedAtTyped };
}

// The figures as the screen shows them.
function previewShape(shift, prepared, input) {
  const f = prepared.figures;
  const unitOf = (productId) => (prepared.fuels[productId]?.unit === 'kg' ? 'kg' : 'litres');
  return {
    shiftNo: shift.shift_no, closedAt: prepared.closedAt,
    nozzles: f.nozzles.map((n) => ({ nozzleId: n.nozzleId, nozzleNo: n.nozzle.nozzle_no, productName: n.nozzle.product_name, unit: unitOf(n.productId), opening: n.opening, closing: n.closing,
      test: money.litres(n.test), gross: money.litres(n.gross), litres: money.litres(n.litres) })),
    products: f.products.map((p) => ({ productId: p.productId, name: prepared.fuels[p.productId].name, unit: unitOf(p.productId), price: money.rupees(p.price), litres: money.litres(p.litres),
      creditLitres: money.litres(p.creditLitres), walkInLitres: money.litres(p.walkInLitres), creditAmount: money.rupees(p.creditAmount), walkInAmount: money.rupees(p.walkInAmount),
      amount: money.rupees(p.amount) })),
    slips: prepared.slips.map((s) => ({ contactId: s.contactId, customer: s.vehicle.customer_name, vehicleId: s.vehicleId, registration: s.vehicle.registration,
      productId: s.productId, name: prepared.fuels[s.productId].name, litres: s.litres, price: money.rupees(s.price), amount: money.rupees(s.amount), slipNo: s.slipNo, overLimit: s.overLimit })),
    takings: prepared.takings.map((p) => ({ methodId: p.methodId, method: p.method, methodName: p.methodName, amount: p.amount, reference: p.reference })),
    expected: money.rupees(f.expected), credit: money.rupees(f.credit), walkIn: money.rupees(f.walkIn), other: money.rupees(f.other), cash: money.rupees(f.cash),
    cashPaid: money.rupees(f.cashPaid), difference: money.rupees(f.difference), short: money.rupees(Math.max(0, -f.difference)), excess: money.rupees(Math.max(0, f.difference)),
    limits: prepared.limits, approvalNeeded: prepared.limits.length > 0, stock: prepared.stock, note: input.note,
  };
}

// POST …/close/preview: the close's figures, nothing saved.
async function preview(business, user, shiftId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const input = readClose(body);
  return repo.transaction(async (db) => {
    const shift = await shiftRow(db, business, shiftId);
    await requireKeeper(business, user, shift);
    if (shift.status !== 'open') fail(`Shift ${shift.shift_no} is closed`, 409);
    const typed = await c.readWhen(db, business, body.closedAt, 'Closing readings taken at');
    const prepared = await prepareClose(db, business, user, shift, input, typed);
    return previewShape(shift, prepared, input);
  });
}

// The fixed prices of a fuel bill's line: its own litres at the price, no GST.
const fuelLine = (skuId, thousandths, price, net, label) => ({
  input: { skuId, quantity: money.litres(thousandths) },
  fixed: { price: Number(money.rupees(price)), net, tax: 0, priceRuleId: null, enteredPrice: null, label: label.slice(0, 150) },
});
const VAT_WORDS = 'price includes state VAT';

// body: the close as typed (readClose) with { requestKey }.
async function close(business, user, shiftId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const input = readClose(body);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT shift_id,request_hash FROM fuel_shift_closes WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return load(db, business, user, old.shift_id);
    }
    const shift = await shiftRow(db, business, shiftId, { lock: true });
    await requireKeeper(business, user, shift);
    if (shift.status !== 'open') fail(`Shift ${shift.shift_no} is closed already`, 409);
    const typed = await c.readWhen(db, business, body.closedAt, 'Closing readings taken at');
    const prepared = await prepareClose(db, business, user, shift, input, typed);
    const f = prepared.figures;
    let approvedBy = null;
    if (prepared.limits.length) {
      if (!input.approve || !access.can(business, 'fuel.approve')) {
        const words = prepared.limits.map((l) => (l.kind === 'fill' ? `${l.registration} took ${l.litres} litres, over its fill limit of ${l.limit}`
          : `${l.customer} would owe ₹${l.after}, over their credit limit of ₹${Number(l.limit).toFixed(2)}`));
        fail(`${c.listWords(words)}: a manager allows the credit when closing the shift`, 409, { reason: 'approval_needed', limits: prepared.limits });
      }
      approvedBy = user.id;
    }
    if (prepared.stock.length) {
      const s = prepared.stock[0];
      fail(`${s.name}: the meters gave out ${s.sold} ${s.unit === 'kg' ? 'kg' : 'litres'} on this shift, but the stock at this outlet is ${s.stock}. Record what came in first (${s.family === 'cng' ? 'a purchase of CNG' : 'Tanker receipts'}), then close the shift.`, 409);
    }
    const seq = 1 + (await repo.one(db, 'SELECT count(*)::int AS n FROM fuel_shift_closes WHERE business_id=$1 AND shift_id=$2', [business.id, shift.id])).n;
    const walkInKey = c.derivedKey(requestKey, 'walk-in');
    const closeRow = await repo.one(db, `INSERT INTO fuel_shift_closes(business_id,shift_id,seq,closed_at,expected,credit,walk_in,cash,other,difference,note,walk_in_key,approved_by,
        request_key,request_hash,closed_by) VALUES($1,$2,$3,COALESCE($4,now()),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [business.id, shift.id, seq, prepared.typedAt, money.rupees(f.expected), money.rupees(f.credit), money.rupees(f.walkIn), money.rupees(f.cash), money.rupees(f.other),
      money.rupees(f.difference), input.note, walkInKey, approvedBy, requestKey, hash, user.id]);
    // The walk-in fuel bill: a line for each fuel, paid by the other takings and then the cash.
    const walkInProducts = f.products.filter((p) => p.walkInLitres > 0);
    let walkInDoc = null, walkInLines = [], paymentIds = [];
    if (walkInProducts.length) {
      const lines = walkInProducts.map((p) => fuelLine(prepared.fuels[p.productId].skuId, p.walkInLitres, p.price, p.walkInAmount, `${prepared.fuels[p.productId].name} · ${VAT_WORDS}`));
      const parts = prepared.takings.map((p) => ({ amount: Number(p.amount), method: p.method, methodId: p.methodId, reference: p.reference, tendered: null }));
      if (f.cashPaid > 0) parts.push({ amount: Number(money.rupees(f.cashPaid)), method: 'cash', methodId: null, reference: null, tendered: null });
      const documentBody = { kind: 'sale', locationId: shift.location_id, lines: lines.map((l) => l.input), notes: `Walk-in fuel sales of shift ${shift.shift_no} (${shift.attendant_name})` };
      walkInDoc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: walkInKey, hash: c.hashOf(documentBody), lines: documentBody.lines,
        paidNow: parts, fixed: lines.map((l) => l.fixed), fuel: true });
      if (money.paise(walkInDoc.total) !== f.walkIn) fail(`The walk-in fuel bill would come to ${walkInDoc.total}, not the ${money.rupees(f.walkIn)} the meters sold. Try again.`, 409);
      walkInLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, walkInDoc.id]);
      paymentIds = (await repo.all(db, 'SELECT id,method FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, walkInDoc.id]))
        .filter((p) => p.method !== 'cash').map((p) => p.id);
      if (walkInLines.length !== walkInProducts.length || paymentIds.length !== prepared.takings.length) fail('The walk-in fuel bill does not match the shift. Try again.', 409);
      await db.query('UPDATE fuel_shift_closes SET document_id=$3 WHERE business_id=$1 AND id=$2', [business.id, closeRow.id, walkInDoc.id]);
    }
    // A fuel bill to each fleet customer: a line for each credit slip, with its vehicle.
    const credit = [];
    const customers = [...new Set(prepared.slips.map((s) => String(s.contactId)))];
    for (const contactId of customers) {
      const mine = prepared.slips.filter((s) => String(s.contactId) === contactId);
      const lines = mine.map((s) => fuelLine(prepared.fuels[s.productId].skuId, s.thousandths, s.price, s.amount,
        `${prepared.fuels[s.productId].name} · ${s.vehicle.registration}${s.slipNo ? ` · slip ${s.slipNo}` : ''} · ${VAT_WORDS}`));
      const documentBody = { kind: 'sale', locationId: shift.location_id, contactId: Number(contactId), lines: lines.map((l) => l.input), notes: `Fuel on credit, shift ${shift.shift_no}` };
      const doc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, `credit-${contactId}`), hash: c.hashOf(documentBody),
        lines: documentBody.lines, paidNow: [], fixed: lines.map((l) => l.fixed), fuel: true });
      const total = mine.reduce((sum, s) => sum + s.amount, 0);
      if (money.paise(doc.total) !== total) fail(`The fuel bill to ${mine[0].vehicle.customer_name} would come to ${doc.total}, not ${money.rupees(total)}. Try again.`, 409);
      const docLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]);
      mine.forEach((s, i) => credit.push({ slip: s, documentId: doc.id, lineId: docLines[i].id }));
    }
    // The readings, the fuels, the credit fills and the takings, as closed.
    for (const r of prepared.readings) {
      const n = money.nozzleFigures(r);
      await db.query(`INSERT INTO fuel_close_readings(business_id,close_id,shift_id,nozzle_id,product_id,tank_id,opening,closing,test,litres) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [business.id, closeRow.id, shift.id, r.nozzleId, r.productId, r.tankId, r.opening, r.closing, money.litres(n.test), money.litres(n.litres)]);
    }
    for (const p of f.products) {
      const lineIndex = walkInProducts.indexOf(p);
      await db.query(`INSERT INTO fuel_close_products(business_id,close_id,shift_id,product_id,price,litres,credit_litres,walk_in_litres,credit_amount,walk_in_amount,amount,line_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [business.id, closeRow.id, shift.id, p.productId, money.rupees(p.price), money.litres(p.litres), money.litres(p.creditLitres),
        money.litres(p.walkInLitres), money.rupees(p.creditAmount), money.rupees(p.walkInAmount), money.rupees(p.amount), lineIndex >= 0 ? walkInLines[lineIndex].id : null]);
    }
    for (const [index, { slip, documentId, lineId }] of credit.entries()) {
      await db.query(`INSERT INTO fuel_credit_slips(business_id,close_id,shift_id,seq,contact_id,vehicle_id,registration,product_id,litres,price,amount,slip_no,over_limit,document_id,line_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [business.id, closeRow.id, shift.id, index + 1, slip.contactId, slip.vehicleId, slip.vehicle.registration, slip.productId,
        money.litres(slip.thousandths), money.rupees(slip.price), money.rupees(slip.amount), slip.slipNo, slip.overLimit, documentId, lineId]);
    }
    for (const [index, p] of prepared.takings.entries()) {
      await db.query('INSERT INTO fuel_close_payments(business_id,close_id,seq,method,method_name,amount,reference,payment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [business.id, closeRow.id, index + 1, p.method, p.methodName, p.amount, p.reference, paymentIds[index]]);
    }
    // Each nozzle now reads its closing reading: the next shift on it opens from there.
    for (const r of prepared.readings) {
      if (r.closing !== r.opening) await db.query('UPDATE fuel_nozzles SET reading=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, r.nozzleId, r.closing]);
    }
    await db.query("UPDATE fuel_shifts SET status='closed',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, shift.id, user.id]);
    const words = { shiftNo: shift.shift_no, attendant: shift.attendant_name, seq, expected: closeRow.expected, credit: closeRow.credit, walkIn: closeRow.walk_in, cash: closeRow.cash,
      other: closeRow.other, difference: closeRow.difference, ...(walkInDoc ? { walkInBill: walkInDoc.document_no } : {}), ...(approvedBy ? { creditAllowedOverLimit: prepared.limits } : {}) };
    await repo.audit(db, business.id, user.id, 'fuel_shift.closed', shift.id, words);
    await repo.event(db, business.id, user.id, 'fuel_shift.closed', 'fuel_shift', shift.id, { ...words, locationId: shift.location_id, closeId: closeRow.id,
      documentIds: [walkInDoc?.id, ...new Set(credit.map((x) => x.documentId))].filter(Boolean),
      products: f.products.map((p) => ({ productId: p.productId, litres: money.litres(p.litres), price: money.rupees(p.price) })) });
    return load(db, business, user, shift.id);
  });
}

// --- A manager's reopening -------------------------------------------------------------------

// The method a payment was made by, to hand it back the same way (by its name when the method is still in use).
async function refundChoice(db, business, payment) {
  if (payment.method_name) {
    const method = await repo.one(db, 'SELECT id FROM business_payment_methods WHERE business_id=$1 AND name=$2 AND kind=$3 AND active', [business.id, payment.method_name, payment.method]);
    if (method) return { methodId: method.id, method: payment.method };
  }
  return { methodId: null, method: payment.method };
}

// body: { requestKey, reason } — a closed shift opened again by a manager, before
// another shift opens on its nozzles: its bills credited (the litres back in
// stock), the walk-in bill's takings handed back, its nozzles read again from
// the shift's opening. It is then closed again with the corrected readings.
async function reopen(business, user, shiftId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.approve');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why the shift is reopened', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const done = await repo.one(db, 'SELECT shift_id,reopen_hash FROM fuel_shift_closes WHERE business_id=$1 AND reopen_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.reopen_hash !== hash) fail('This request key was already used for different data', 409);
      return load(db, business, user, done.shift_id);
    }
    const shift = await shiftRow(db, business, shiftId, { lock: true });
    if (shift.status !== 'closed') fail(`Shift ${shift.shift_no} is open: close it instead`, 409);
    const current = await repo.one(db, 'SELECT * FROM fuel_shift_closes WHERE business_id=$1 AND shift_id=$2 AND reopened_at IS NULL FOR UPDATE', [business.id, shift.id]);
    const next = await repo.one(db, `SELECT s.shift_no,n2.nozzle_no FROM fuel_shift_nozzles n1
        JOIN fuel_shift_nozzles n2 ON n2.business_id=n1.business_id AND n2.nozzle_id=n1.nozzle_id AND n2.shift_id<>n1.shift_id
        JOIN fuel_shifts s ON s.business_id=n2.business_id AND s.id=n2.shift_id WHERE n1.business_id=$1 AND n1.shift_id=$2 AND s.created_at>$3 ORDER BY s.created_at LIMIT 1`,
    [business.id, shift.id, current.created_at]);
    if (next) fail(`Shift ${next.shift_no} has opened on nozzle ${next.nozzle_no} since: a shift is reopened only before the next one starts`, 409);
    await db.query('UPDATE fuel_shift_closes SET reopened_at=now(),reopened_by=$3,reopen_reason=$4,reopen_key=$5,reopen_hash=$6 WHERE business_id=$1 AND id=$2',
      [business.id, current.id, user.id, reason, requestKey, hash]);
    // Its bills credited in full (the litres back in stock); the walk-in bill's takings handed back the way they came.
    const documentIds = [...new Set([current.document_id, ...(await repo.all(db, 'SELECT document_id FROM fuel_credit_slips WHERE business_id=$1 AND close_id=$2',
      [business.id, current.id])).map((r) => r.document_id)].filter(Boolean).map(String))];
    const credited = [];
    const words = `Shift ${shift.shift_no} reopened: ${reason}`.slice(0, 300);
    for (const documentId of documentIds) {
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, documentId]);
      const lines = await repo.all(db, 'SELECT id,quantity FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]);
      const input = { reason: words, requestKey: c.derivedKey(requestKey, `return-${doc.id}`), hash: c.hashOf({ reopen: requestKey, document: doc.id }),
        lines: lines.map((l) => ({ lineId: l.id, quantity: l.quantity, restock: true })) };
      const returned = await returns.postReturn(db, business, user, doc, input);
      credited.push({ documentNo: doc.document_no, returnNo: returned.return_no, total: returned.total });
      if (String(doc.id) === String(current.document_id)) {
        // Credited in full, every payment on it goes back (the shift's takings, and any short paid on it since).
        const paid = await repo.all(db, 'SELECT * FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]);
        for (const p of paid) {
          await returns.postRefund(db, business, user, doc, { amount: Number(p.amount), choice: await refundChoice(db, business, p), reason: words,
            requestKey: c.derivedKey(requestKey, `refund-${p.id}`) });
        }
      }
    }
    // Its nozzles read again from the shift's opening.
    const taken = await repo.all(db, `SELECT n.nozzle_id,n.opening,z.reading FROM fuel_shift_nozzles n JOIN fuel_nozzles z ON z.business_id=n.business_id AND z.id=n.nozzle_id
      WHERE n.business_id=$1 AND n.shift_id=$2`, [business.id, shift.id]);
    for (const t of taken) {
      if (t.reading !== t.opening) await db.query('UPDATE fuel_nozzles SET reading=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, t.nozzle_id, t.opening]);
    }
    await db.query("UPDATE fuel_shifts SET status='open',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, shift.id, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_shift.reopened', shift.id, { shiftNo: shift.shift_no, reason, credited });
    await repo.event(db, business.id, user.id, 'fuel_shift.reopened', 'fuel_shift', shift.id, { shiftNo: shift.shift_no, locationId: shift.location_id, closeId: current.id, reason,
      documentIds: documentIds.map(Number) });
    return load(db, business, user, shift.id);
  });
}

// A fuel's name, for a sentence.
async function nameOf(db, business, productId) {
  return (await repo.one(db, `SELECT s.label FROM fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id WHERE f.business_id=$1 AND f.id=$2`,
    [business.id, productId]))?.label || 'another fuel';
}

module.exports = { SHIFTS_SQL, list, attendants, day, detail, load, open, addNozzle, removeNozzle, updateNotes, readClose, preview, close, reopen };
