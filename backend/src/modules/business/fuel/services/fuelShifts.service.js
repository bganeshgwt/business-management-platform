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
//             then the cash, a short paid from the attendant's account) and a fuel bill to each
//             fleet customer (a line for each slip, with its vehicle); no
//             round-off. A fill over a vehicle's fill limit, or credit taking a
//             customer over their credit limit, is allowed by a manager.
//             The close also bills the attendant's other sales (lubricants,
//             additives, shop items) as GST invoices at their slabs, to no one
//             by name or to a customer on credit, never on the fuel bills; a
//             walk-in buyer's fill of ₹2,00,000 or more on a bill of its own,
//             with the buyer's PAN or declaration and the cash limit; and a
//             fleet customer billed by the month gets no bill: the fill is held
//             on its slip for the month's invoice. A customer with slip books
//             gives each fill's slip serial, used once. The cash is the count
//             (by notes and coins) and the cash dropped during the shift. The
//             takings pay the walk-in fuel bill, what is left of them the other
//             sales' bill; the cash pays the rest of the two; a short is paid
//             on them from the attendant's account (due from the attendant), an
//             excess is held on it until a manager takes it to income.
//   drops     cash handed over during the shift: how much, when, to whom; a
//             manager cancels one typed wrongly while the shift is open.
//   reopen    a closed shift never changes: a manager reopens it with a
//             reason, before another shift opens on its nozzles. Its bills are
//             credited (the litres back in stock until it closes again), the
//             walk-in bills' takings handed back, the attendant's short or
//             excess reversed, and its nozzles read again from the shift's
//             opening. Not once its fleet fills are on a month's invoice.
// Someone who does not see sales sees and closes their own shifts only.

const { fail, id } = c;
const MAX_NOZZLES = 24;
const MAX_SLIPS = 200;
const MAX_TAKINGS = 20;
const MAX_GOODS = 50;
const MAX_BIG = 10;
// A sale over ₹2,00,000 records the buyer's PAN: on a fleet bill, each credit fill is its own sale.
const PAN_ABOVE_PAISE = 20000000;
// No ₹2,00,000 or more in cash for one bill, or from one person in a day (Income-tax Act 2025, section 186).
const CASH_LIMIT_PAISE = 20000000;
// The attendant's account, as the walk-in bills name its payment.
const ATTENDANT_ACCOUNT = 'Attendant account';

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
  const slips = await repo.all(db, `SELECT k.*,ct.name AS customer_name,s.label AS product_name,s.unit,d.document_no,ib.book_no FROM fuel_credit_slips k
    JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id JOIN fuel_products f ON f.business_id=k.business_id AND f.id=k.product_id
    JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id LEFT JOIN business_documents d ON d.business_id=k.business_id AND d.id=k.document_id
    LEFT JOIN fuel_indent_books ib ON ib.business_id=k.business_id AND ib.id=k.book_id
    WHERE k.business_id=$1 AND k.close_id=$2 ORDER BY k.seq`, [business.id, close.id]);
  const takings = await repo.all(db, 'SELECT * FROM fuel_close_payments WHERE business_id=$1 AND close_id=$2 ORDER BY seq', [business.id, close.id]);
  const bigFills = await repo.all(db, `SELECT g.*,s.label AS product_name,s.unit,d.document_no,d.buyer_pan,d.pan_declaration FROM fuel_close_big_fills g
    JOIN fuel_products f ON f.business_id=g.business_id AND f.id=g.product_id JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
    JOIN business_documents d ON d.business_id=g.business_id AND d.id=g.document_id WHERE g.business_id=$1 AND g.close_id=$2 ORDER BY g.seq`, [business.id, close.id]);
  const goodsBills = await repo.all(db, 'SELECT document_id,walk_in FROM fuel_close_goods_bills WHERE business_id=$1 AND close_id=$2', [business.id, close.id]);
  const counts = await repo.all(db, 'SELECT denomination,pieces FROM fuel_close_counts WHERE business_id=$1 AND close_id=$2 ORDER BY denomination DESC', [business.id, close.id]);
  const account = await repo.all(db, 'SELECT kind,amount,created_at FROM fuel_attendant_entries WHERE business_id=$1 AND close_id=$2 ORDER BY id', [business.id, close.id]);
  const documentIds = [...new Set([close.document_id, ...slips.map((s) => s.document_id), ...bigFills.map((g) => g.document_id), ...goodsBills.map((g) => g.document_id)]
    .filter(Boolean).map(String))];
  const bills = documentIds.length ? await repo.all(db, `SELECT d.id,d.document_no,d.contact_id,d.contact_name,d.total,d.tax,d.due_on::text AS due_on,d.created_at,
      COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0) AS paid,
      COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id AND p.method='credit_note'),0) AS from_account,
      COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned,
      ${DUE_SQL('d')} AS due FROM business_documents d WHERE d.business_id=$1 AND d.id=ANY($2::bigint[]) ORDER BY d.id`, [business.id, documentIds]) : [];
  // What each bill is: the walk-in fuel bill, a fleet customer's fuel bill, a big fill, or other sales (GST).
  for (const b of bills) {
    b.part = String(b.id) === String(close.document_id) ? 'walk_in' : bigFills.some((g) => String(g.document_id) === String(b.id)) ? 'big_fill'
      : goodsBills.some((g) => String(g.document_id) === String(b.id)) ? 'goods' : 'credit';
  }
  const names = await repo.all(db, 'SELECT id,name FROM users WHERE id=ANY($1::bigint[])', [[close.closed_by, close.reopened_by, close.approved_by].filter(Boolean)]);
  const nameOf = (userId) => names.find((u) => String(u.id) === String(userId))?.name || null;
  const available = money.paise(close.cash) + money.paise(close.dropped) - money.paise(close.big_cash);
  const cashPaid = Math.max(0, Math.min(available, money.paise(close.walk_in) - money.paise(close.other)));
  return { ...close, readings, products, slips, takings, bills, counts, account,
    big_fills: bigFills.map(({ buyer_pan: pan, ...g }) => ({ ...g, buyer_pan: pan ? `••••••${String(pan).slice(-4)}` : null })),
    cash_paid: money.rupees(cashPaid), cash_goods: money.rupees(Math.max(0, Math.min(available - cashPaid, money.paise(close.goods_walk_in) - money.paise(close.goods_other)))),
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
  const hide = (close) => (sees ? close : { ...withoutMoney(close), products: close.products.map((p) => ({ ...p, price: null, credit_amount: null, walk_in_amount: null, big_amount: null, amount: null })),
    slips: close.slips.map((s) => ({ ...s, price: null, amount: null })), big_fills: close.big_fills.map((g) => ({ ...g, price: null, amount: null })), takings: [], bills: [], counts: [],
    account: [], cash_paid: null, cash_goods: null, dropped: null, big: null, big_cash: null, goods_walk_in: null, goods_other: null, goods_credit: null });
  // The cash handed over during the shift, and (while it is open) who it may be handed to.
  const drops = await repo.all(db, `SELECT x.id,x.amount,x.dropped_at,x.received_by,x.received_by_name,x.note,x.created_at,x.cancelled_at,x.cancel_reason,cu.name AS cancelled_by_name
    FROM fuel_cash_drops x LEFT JOIN users cu ON cu.id=x.cancelled_by WHERE x.business_id=$1 AND x.shift_id=$2 ORDER BY x.dropped_at,x.id`, [business.id, shift.id]);
  const receivers = shift.status === 'open' ? await repo.all(db, `SELECT u.id,u.name FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    WHERE m.business_id=$1 AND m.active AND m.user_id<>$2 ORDER BY u.name`, [business.id, shift.attendant_id]) : [];
  const settings = await c.settingsOf(db, business.id);
  // What the attendant may sell besides fuel while the shift is open: the business's items that are not fuels (no batches, serials or kits).
  const goodsItems = shift.status === 'open' ? await repo.all(db, `SELECT s.id,s.label,s.unit,s.price FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND s.active AND p.active AND NOT s.is_kit AND NOT s.internal_use AND s.tracking IN ('none','quantity')
      AND NOT EXISTS (SELECT 1 FROM fuel_products f WHERE f.business_id=s.business_id AND f.sku_id=s.id) ORDER BY lower(s.label) LIMIT 500`, [business.id]) : [];
  const { request_hash: _hash, ...rest } = shift;
  return { ...rest, nozzles, close: current ? hide(current) : null, history: detailed.filter((x) => x.reopened_at).map(hide), money: sees,
    reopenable: Boolean(current) && !next, next_shift: next || null, test_litres: settings.test_litres, denominations: settings.denominations.map(Number),
    drops: sees ? drops : drops.map((d) => ({ ...d, amount: null })), dropped: sees ? money.rupees(drops.filter((d) => !d.cancelled_at).reduce((s, d) => s + money.paise(d.amount), 0)) : null,
    receivers, goods_items: goodsItems };
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

// --- Cash drops ----------------------------------------------------------------------------------

// body: { requestKey, amount, receivedBy (a member of the staff, not the attendant), droppedAt? (now), note? }
// — cash an attendant hands over during an open shift; counted with the cash at its close.
async function addDrop(business, user, shiftId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const amount = c.readMoney(body.amount, 'Cash dropped', { min: 0, minExclusive: true, max: 9999999.99 });
  const receivedBy = id(body.receivedBy, 'Handed to');
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT shift_id,request_hash FROM fuel_cash_drops WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return load(db, business, user, old.shift_id);
    }
    const shift = await shiftRow(db, business, shiftId, { lock: true });
    await requireKeeper(business, user, shift);
    if (shift.status !== 'open') fail(`Shift ${shift.shift_no} is closed: a cash drop is made while a shift is open`, 409);
    const receiver = await repo.one(db, `SELECT u.id,u.name FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
      WHERE m.business_id=$1 AND m.user_id=$2 AND m.active`, [business.id, receivedBy]);
    if (!receiver) fail('That person is not on this business\'s staff', 404);
    if (String(receiver.id) === String(shift.attendant_id)) fail('A cash drop is handed to someone other than the shift\'s attendant', 409);
    const typed = await c.readWhen(db, business, body.droppedAt, 'Dropped at');
    if (typed && (new Date(typed) < new Date(shift.opened_at) || new Date(typed) > new Date())) fail(`A cash drop of shift ${shift.shift_no} is made after it opened, not later than now`);
    const row = await repo.one(db, `INSERT INTO fuel_cash_drops(business_id,shift_id,amount,dropped_at,received_by,received_by_name,note,request_key,request_hash,created_by)
      VALUES($1,$2,$3,COALESCE($4,now()),$5,$6,$7,$8,$9,$10) RETURNING *`, [business.id, shift.id, amount, typed, receiver.id, receiver.name, note, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'fuel_drop.made', row.id, { shiftNo: shift.shift_no, attendant: shift.attendant_name, amount: row.amount, to: receiver.name });
    await repo.event(db, business.id, user.id, 'fuel_drop.made', 'fuel_cash_drop', row.id, { shiftId: shift.id, locationId: shift.location_id, amount: row.amount, receivedBy: receiver.id });
    return load(db, business, user, shift.id);
  });
}

// body: { reason } — a drop typed wrongly, cancelled by a manager while its shift is open.
async function cancelDrop(business, user, shiftId, dropId, body) {
  c.requireFuel(business);
  await access.require(business, 'fuel.approve');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why the drop is cancelled', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const shift = await shiftRow(db, business, shiftId, { lock: true });
    const drop = await repo.one(db, 'SELECT * FROM fuel_cash_drops WHERE business_id=$1 AND shift_id=$2 AND id=$3 FOR UPDATE', [business.id, shift.id, id(dropId, 'Cash drop')]);
    if (!drop) fail('Cash drop not found', 404);
    if (drop.cancelled_at) fail('That cash drop is cancelled already', 409);
    if (shift.status !== 'open') fail(`Shift ${shift.shift_no} is closed: its cash drops are kept as they were closed`, 409);
    await db.query('UPDATE fuel_cash_drops SET cancelled_at=now(),cancelled_by=$3,cancel_reason=$4 WHERE business_id=$1 AND id=$2', [business.id, drop.id, user.id, reason]);
    await repo.audit(db, business.id, user.id, 'fuel_drop.cancelled', drop.id, { shiftNo: shift.shift_no, amount: drop.amount, to: drop.received_by_name, reason });
    return load(db, business, user, shift.id);
  });
}

// --- Closing a shift ---------------------------------------------------------------------------

// The close as typed: { closedAt?, readings: [{ nozzleId, closing, test? }],
// cash, count?: [{ denomination, pieces }], payments?: [{ methodId, amount,
// reference? }], slips?: [{ contactId, vehicleId, productId?, litres, slipNo? }],
// goods?: [{ skuId, quantity, unit?, lotCode?, contactId? }], bigFills?:
// [{ productId, litres, registration?, buyerName?, pan? | panDeclaration,
// payments: [{ method: 'cash' or methodId, amount, reference? }] }], note?, approve? }
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
  const goods = body.goods === undefined || body.goods === null ? [] : v.requiredArray(body.goods, 'Other sales');
  if (goods.length > MAX_GOODS) fail(`A shift's other sales take at most ${MAX_GOODS} lines`);
  const bigFills = body.bigFills === undefined || body.bigFills === null ? [] : v.requiredArray(body.bigFills, 'Fills of ₹2,00,000 or more');
  if (bigFills.length > MAX_BIG) fail(`A shift takes at most ${MAX_BIG} fills of ₹2,00,000 or more`);
  // The cash counted by notes and coins: the count is the cash.
  const count = body.count === undefined || body.count === null ? null : v.requiredArray(body.count, 'Notes and coins counted').map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`Count ${i + 1} must be an object`);
    return { denomination: c.whole(x.denomination, `Count ${i + 1}: note or coin (₹)`, 1, 2000), pieces: c.whole(x.pieces, `Count ${i + 1}: how many`, 0, 1000000) };
  }).filter((x) => x.pieces > 0);
  if (count && new Set(count.map((x) => x.denomination)).size !== count.length) fail('Each note or coin is counted once');
  let cash = c.readMoney(c.given(body.cash) ? body.cash : '0', 'Cash counted');
  if (count) {
    const counted = money.rupees(money.countOf(count));
    if (c.given(body.cash) && money.paise(cash) !== money.paise(counted)) fail(`The cash counted is ₹${cash}, but the notes and coins come to ₹${counted}`);
    cash = counted;
  }
  return {
    readings,
    cash,
    count,
    goods: goods.map((g, i) => {
      if (!g || typeof g !== 'object' || Array.isArray(g)) fail(`Other sale ${i + 1} must be an object`);
      const quantity = String(g.quantity ?? '').trim();
      core.decimal(quantity, `Other sale ${i + 1}: quantity`, 3, 0.001, 100000);
      return { skuId: id(g.skuId, `Other sale ${i + 1}: item`), quantity, unit: c.optionalText(g.unit, `Other sale ${i + 1}: unit`, 20),
        lotCode: c.optionalText(g.lotCode, `Other sale ${i + 1}: batch`, 100), contactId: c.given(g.contactId) ? id(g.contactId, `Other sale ${i + 1}: customer`) : null };
    }),
    bigFills: bigFills.map((b, i) => {
      const label = `Fill ${i + 1} of ₹2,00,000 or more`;
      if (!b || typeof b !== 'object' || Array.isArray(b)) fail(`${label} must be an object`);
      const pan = core.readPan(b.pan, `${label}: the buyer's PAN`);
      const panDeclaration = v.requiredBoolean(b.panDeclaration, `${label}: the buyer's declaration`, false);
      if (pan && panDeclaration) fail(`${label}: give the buyer's PAN or record their declaration, not both`);
      if (!pan && !panDeclaration) fail(`${label}: give the buyer's PAN, or record their declaration (Form 97) that they have none`);
      const paidBy = v.requiredArray(b.payments, `${label}: how it was paid`);
      if (!paidBy.length || paidBy.length > 5) fail(`${label}: give how it was paid, in 1 to 5 parts`);
      return { productId: id(b.productId, `${label}: fuel`), litres: c.readLitres(b.litres, `${label}: litres`, { min: 0, minExclusive: true }),
        registration: c.given(b.registration) ? c.readPlate(b.registration, `${label}: vehicle`) : null, buyerName: c.optionalText(b.buyerName, `${label}: buyer`, 150),
        pan, panDeclaration, payments: paidBy.map((p, j) => {
          if (!p || typeof p !== 'object' || Array.isArray(p)) fail(`${label}: payment ${j + 1} must be an object`);
          const cashPart = p.method === 'cash';
          return { method: cashPart ? 'cash' : null, methodId: cashPart ? null : id(p.methodId, `${label}: payment ${j + 1}: how it was paid`),
            amount: c.readMoney(p.amount, `${label}: payment ${j + 1}: amount`, { min: 0, minExclusive: true }), reference: c.optionalText(p.reference, `${label}: payment ${j + 1}: reference`, 100) };
        }) };
    }),
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
    // A customer with slip books: the slip's serial, in one of their books in use, used once.
    const books = await repo.all(db, 'SELECT * FROM fuel_indent_books WHERE business_id=$1 AND contact_id=$2 AND active ORDER BY first_serial', [business.id, s.contactId]);
    let book = null, serial = null;
    if (books.length) {
      if (!s.slipNo || !/^\d{1,9}$/.test(s.slipNo)) fail(`${label}: ${vehicle.customer_name}'s fills are on the slips of their books: give the slip's number`);
      serial = Number(s.slipNo);
      book = books.find((b) => serial >= b.first_serial && serial <= b.last_serial) || null;
      if (!book) fail(`${label}: slip ${serial} is not in any of ${vehicle.customer_name}'s slip books in use`, 409);
      const used = await repo.one(db, `SELECT s.shift_no FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
        JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id WHERE k.business_id=$1 AND k.book_id=$2 AND k.serial=$3 LIMIT 1`, [business.id, book.id, serial]);
      const twice = input.slips.some((other, j) => j !== index && String(other.contactId) === String(s.contactId) && /^\d{1,9}$/.test(other.slipNo || '') && Number(other.slipNo) === serial);
      if (used || twice) fail(`${label}: slip ${serial} of book ${book.book_no} was used already${used ? `, on shift ${used.shift_no}` : ''}`, 409);
    } else if (s.slipNo) {
      const dup = await repo.one(db, `SELECT s.shift_no FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
        JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id WHERE k.business_id=$1 AND k.contact_id=$2 AND lower(k.slip_no)=lower($3) LIMIT 1`, [business.id, s.contactId, s.slipNo]);
      if (dup || input.slips.some((other, j) => j !== index && other.slipNo && String(other.contactId) === String(s.contactId) && other.slipNo.toLowerCase() === s.slipNo.toLowerCase())) {
        fail(`${label}: slip ${s.slipNo} of ${vehicle.customer_name} is entered already${dup ? ` (shift ${dup.shift_no})` : ''}`, 409);
      }
    }
    // A customer billed by the month: the fill is held on its slip for the month's invoice.
    const terms = await repo.one(db, 'SELECT billing FROM fuel_fleet_terms WHERE business_id=$1 AND contact_id=$2', [business.id, s.contactId]);
    slips.push({ ...s, slipNo: book ? String(serial) : s.slipNo, bookId: book?.id || null, bookNo: book?.book_no || null, serial, held: terms?.billing === 'month',
      productId, vehicle, overFill: vehicle.fill_limit !== null && money.milli(s.litres) > money.milli(vehicle.fill_limit) });
  }
  // Fills of ₹2,00,000 or more to walk-in buyers: a fuel of this shift, paid by cash or a method of the business.
  const bigFills = [];
  for (const [index, b] of input.bigFills.entries()) {
    const label = `Fill ${index + 1} of ₹2,00,000 or more`;
    if (!fuels[String(b.productId)]) fail(`${label}: no nozzle of this shift sells that fuel`, 409);
    const paidBy = [];
    for (const p of b.payments) {
      if (p.method === 'cash') { paidBy.push({ ...p, methodName: null }); continue; }
      const method = await paymentMethods.settle(db, business.id, { methodId: p.methodId, method: null }, `${label}: how it was paid`, c.TAKING_KINDS);
      paidBy.push({ ...p, method: method.method, methodName: method.methodName });
    }
    bigFills.push({ ...b, productId: String(b.productId), payments: paidBy, cashPaise: paidBy.filter((p) => p.method === 'cash').reduce((sum, p) => sum + money.paise(p.amount), 0) });
  }
  // The other sales: goods and services of the business that are not fuel, priced as a sale prices them, one GST invoice per buyer.
  const goodsBills = [];
  if (input.goods.length) {
    const fuelItem = await repo.one(db, `SELECT s.label FROM fuel_products f JOIN catalog_skus s ON s.business_id=f.business_id AND s.id=f.sku_id
      WHERE f.business_id=$1 AND f.sku_id=ANY($2::bigint[]) LIMIT 1`, [business.id, input.goods.map((g) => g.skuId)]);
    if (fuelItem) fail(`${fuelItem.label} is sold by the meters: it is not one of the shift's other sales`, 409);
    const buyers = [...new Set(input.goods.map((g) => (g.contactId ? String(g.contactId) : '')))];
    for (const buyer of buyers) {
      const lines = input.goods.filter((g) => (g.contactId ? String(g.contactId) : '') === buyer)
        .map((g) => ({ skuId: g.skuId, quantity: g.quantity, ...(g.unit ? { unit: g.unit } : {}), ...(g.lotCode ? { lotCode: g.lotCode } : {}) }));
      const documentBody = { kind: 'sale', locationId: shift.location_id, ...(buyer ? { contactId: Number(buyer) } : {}), lines };
      const quote = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(shift.id, `goods-quote-${buyer}`), hash: '', lines, paidNow: [], quote: true });
      const customer = buyer ? await repo.one(db, 'SELECT name FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, buyer]) : null;
      goodsBills.push({ contactId: buyer || null, customer: customer?.name || null, body: documentBody, lines: quote.lines, total: money.paise(quote.total), tax: money.paise(quote.tax) });
    }
  }
  const goodsWalkIn = goodsBills.find((g) => !g.contactId)?.total || 0;
  const goodsCredit = goodsBills.filter((g) => g.contactId).reduce((sum, g) => sum + g.total, 0);
  // The cash dropped during the shift, and the count's notes and coins against the station's list.
  const dropped = money.paise((await repo.one(db, 'SELECT COALESCE(sum(amount),0) AS amount FROM fuel_cash_drops WHERE business_id=$1 AND shift_id=$2 AND cancelled_at IS NULL',
    [business.id, shift.id])).amount);
  const settings = await c.settingsOf(db, business.id);
  const strange = (input.count || []).find((x) => !settings.denominations.map(Number).includes(x.denomination));
  if (strange) fail(`₹${strange.denomination} is not one of the notes and coins the cash is counted in (Settings › Pumps & nozzles)`);
  // The other takings: UPI, cards and fleet cards, each a payment method of the business.
  const takings = [];
  for (const [index, p] of input.payments.entries()) {
    const method = await paymentMethods.settle(db, business.id, { methodId: p.methodId, method: null }, `Taking ${index + 1}`, c.TAKING_KINDS);
    takings.push({ ...p, method: method.method, methodName: method.methodName });
  }
  const bigCash = bigFills.reduce((sum, b) => sum + b.cashPaise, 0);
  const figures = money.shiftFigures({ readings, prices, slips, bigFills, cash: input.cash, payments: takings, dropped, bigCash, goodsWalkIn });
  for (const p of figures.products) {
    if (p.walkInLitres < 0) {
      const f = fuels[p.productId];
      fail(`The credit slips${p.bigLitres ? ' and the fills of ₹2,00,000 or more' : ''} for ${f.name} come to ${money.litres(p.creditLitres + p.bigLitres)} ${f.unit === 'kg' ? 'kg' : 'litres'}, more than the ${money.litres(p.litres)} its nozzles gave out on this shift`, 409);
    }
  }
  const takingsTotal = figures.other + figures.goodsOther;
  if (takingsTotal > figures.walkIn + goodsWalkIn) {
    fail(`The UPI, card and fleet-card takings come to ₹${money.rupees(takingsTotal)}, more than the ₹${money.rupees(figures.walkIn)} of walk-in sales${goodsWalkIn ? ` and the ₹${money.rupees(goodsWalkIn)} of other sales` : ''}: check them against the credit slips`, 409);
  }
  // Each fill of ₹2,00,000 or more: its own bill, paid in full, less than ₹2,00,000 of it in cash, nor from the buyer's PAN today.
  for (const [index, b] of figures.bigFills.entries()) {
    const label = `Fill ${index + 1} of ₹2,00,000 or more`;
    if (b.amount < CASH_LIMIT_PAISE) fail(`${label} comes to ₹${money.rupees(b.amount)}: a fill under ₹2,00,000 goes on the walk-in fuel bill`, 409);
    const paid = b.payments.reduce((sum, p) => sum + money.paise(p.amount), 0);
    if (paid !== b.amount) fail(`${label} comes to ₹${money.rupees(b.amount)} (${money.litres(b.thousandths)} litres at ₹${money.rupees(b.price)}): it is paid ₹${money.rupees(paid)}`);
    if (b.cashPaise >= CASH_LIMIT_PAISE) {
      fail(`Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): ${label.toLowerCase()} would take ₹${money.rupees(b.cashPaise)} in cash. Take the rest by UPI, card, bank transfer or cheque.`, 409);
    }
    if (b.pan && b.cashPaise > 0) {
      const today = await repo.one(db, `SELECT
          COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN business_documents d ON d.business_id=p.business_id AND d.id=p.document_id
            WHERE p.business_id=$1 AND p.method='cash' AND d.kind='sale' AND d.buyer_pan=$2 AND (p.created_at AT TIME ZONE $3)::date=(now() AT TIME ZONE $3)::date),0)
          - COALESCE((SELECT sum(f.amount) FROM business_refunds f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
            WHERE f.business_id=$1 AND f.method='cash' AND d.kind='sale' AND d.buyer_pan=$2 AND (f.created_at AT TIME ZONE $3)::date=(now() AT TIME ZONE $3)::date),0) AS cash`,
      [business.id, b.pan, zone]);
      const earlier = figures.bigFills.slice(0, index).filter((x) => x.pan === b.pan).reduce((sum, x) => sum + x.cashPaise, 0);
      const from = money.paise(today.cash) + earlier + b.cashPaise;
      if (from >= CASH_LIMIT_PAISE) {
        fail(`Cash of ₹2,00,000 or more cannot be taken from one person in a day (Income-tax Act 2025, section 186): today's cash from PAN ${b.pan.slice(0, 2)}••••${b.pan.slice(-4)} would reach ₹${money.rupees(from)}. Take the rest by UPI, card, bank transfer or cheque.`, 409);
      }
    }
  }
  if (figures.available < 0) {
    fail(`The cash counted and dropped comes to ₹${money.rupees(figures.cash + figures.dropped)}, less than the ₹${money.rupees(bigCash)} the fills of ₹2,00,000 or more were paid in cash`, 409);
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
    // What they owe on their bills, and their fills held for the month's invoice.
    const owed = await repo.one(db, `SELECT c.name,c.credit_limit,${repo.contactBalanceSql('c')} + ${HELD_SQL('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`,
      [business.id, contactId]);
    if (owed.credit_limit !== null && money.paise(owed.balance) + amount > money.paise(owed.credit_limit)) {
      limits.push({ kind: 'credit', customer: owed.name, owed: owed.balance, after: money.rupees(money.paise(owed.balance) + amount), limit: owed.credit_limit, contactId });
    }
  }
  const overLimit = (s) => s.overFill || limits.some((l) => l.kind === 'credit' && String(l.contactId) === String(s.contactId));
  // What the core holds of each fuel at the outlet, less the fills held for a month's invoice: the meters cannot sell more than came in.
  const stock = [];
  for (const p of figures.products) {
    if (p.litres <= 0) continue;
    const f = fuels[p.productId];
    const lot = await repo.one(db, `SELECT COALESCE((SELECT sum(quantity) FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=''),0)
        - (SELECT COALESCE(sum(k.litres),0) FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
           JOIN fuel_shifts s ON s.business_id=x.business_id AND s.id=x.shift_id JOIN fuel_products fp ON fp.business_id=k.business_id AND fp.id=k.product_id
           WHERE k.business_id=$1 AND k.held AND s.location_id=$2 AND fp.sku_id=$3
             AND NOT EXISTS (SELECT 1 FROM fuel_month_invoice_fills b WHERE b.business_id=k.business_id AND b.slip_id=k.id)) AS quantity`,
    [business.id, shift.location_id, f.skuId]);
    if (money.milli(lot.quantity) < p.litres) stock.push({ name: f.name, unit: f.unit, family: f.family, sold: money.litres(p.litres), stock: lot.quantity });
  }
  return { readings, prices, fuels, slips: figures.slips.map((s) => ({ ...s, overLimit: overLimit(s) })), takings, figures, limits, stock, closedAt, typedAt: closedAtTyped,
    bigFills: figures.bigFills, goodsBills, goodsWalkIn, goodsCredit, dropped, count: input.count };
}

// What a fleet customer owes on fills held for a month's invoice and not yet billed.
const HELD_SQL = (c) => `(SELECT COALESCE(sum(k.amount),0) FROM fuel_credit_slips k JOIN fuel_shift_closes x ON x.business_id=k.business_id AND x.id=k.close_id AND x.reopened_at IS NULL
  WHERE k.business_id=${c}.business_id AND k.contact_id=${c}.id AND k.held AND NOT EXISTS (SELECT 1 FROM fuel_month_invoice_fills b WHERE b.business_id=k.business_id AND b.slip_id=k.id))`;

// The figures as the screen shows them.
function previewShape(shift, prepared, input) {
  const f = prepared.figures;
  const unitOf = (productId) => (prepared.fuels[productId]?.unit === 'kg' ? 'kg' : 'litres');
  return {
    shiftNo: shift.shift_no, closedAt: prepared.closedAt,
    nozzles: f.nozzles.map((n) => ({ nozzleId: n.nozzleId, nozzleNo: n.nozzle.nozzle_no, productName: n.nozzle.product_name, unit: unitOf(n.productId), opening: n.opening, closing: n.closing,
      test: money.litres(n.test), gross: money.litres(n.gross), litres: money.litres(n.litres) })),
    products: f.products.map((p) => ({ productId: p.productId, name: prepared.fuels[p.productId].name, unit: unitOf(p.productId), price: money.rupees(p.price), litres: money.litres(p.litres),
      creditLitres: money.litres(p.creditLitres), bigLitres: money.litres(p.bigLitres), walkInLitres: money.litres(p.walkInLitres), creditAmount: money.rupees(p.creditAmount),
      bigAmount: money.rupees(p.bigAmount), walkInAmount: money.rupees(p.walkInAmount), amount: money.rupees(p.amount) })),
    slips: prepared.slips.map((s) => ({ contactId: s.contactId, customer: s.vehicle.customer_name, vehicleId: s.vehicleId, registration: s.vehicle.registration,
      productId: s.productId, name: prepared.fuels[s.productId].name, litres: s.litres, price: money.rupees(s.price), amount: money.rupees(s.amount), slipNo: s.slipNo, overLimit: s.overLimit,
      held: s.held, bookNo: s.bookNo })),
    bigFills: prepared.bigFills.map((b) => ({ productId: b.productId, name: prepared.fuels[b.productId].name, litres: b.litres, price: money.rupees(b.price), amount: money.rupees(b.amount),
      cash: money.rupees(b.cashPaise), registration: b.registration })),
    goods: prepared.goodsBills.map((g) => ({ contactId: g.contactId, customer: g.customer, total: money.rupees(g.total), tax: money.rupees(g.tax),
      lines: g.lines.map((l) => ({ skuId: l.skuId, label: l.label, quantity: l.quantity, unit: l.unit, net: l.net, tax: l.tax, taxRate: l.taxRate })) })),
    takings: prepared.takings.map((p, i) => ({ methodId: p.methodId, method: p.method, methodName: p.methodName, amount: p.amount, reference: p.reference,
      onFuel: money.rupees(f.fuelParts[i]), onGoods: money.rupees(f.goodsParts[i]) })),
    expected: money.rupees(f.expected), credit: money.rupees(f.credit), walkIn: money.rupees(f.walkIn), big: money.rupees(f.big), bigCash: money.rupees(f.bigCash),
    goodsWalkIn: money.rupees(prepared.goodsWalkIn), goodsCredit: money.rupees(prepared.goodsCredit), goodsOther: money.rupees(f.goodsOther), cashGoods: money.rupees(f.cashGoods),
    other: money.rupees(f.other), cash: money.rupees(f.cash), dropped: money.rupees(f.dropped), cashPaid: money.rupees(f.cashPaid),
    difference: money.rupees(f.difference), short: money.rupees(f.short), excess: money.rupees(f.excess),
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
        request_key,request_hash,closed_by,dropped,big,big_cash,goods_walk_in,goods_other,goods_credit)
      VALUES($1,$2,$3,COALESCE($4,now()),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [business.id, shift.id, seq, prepared.typedAt, money.rupees(f.expected), money.rupees(f.credit), money.rupees(f.walkIn), money.rupees(f.cash), money.rupees(f.other),
      money.rupees(f.difference), input.note, walkInKey, approvedBy, requestKey, hash, user.id, money.rupees(f.dropped), money.rupees(f.big), money.rupees(f.bigCash),
      money.rupees(prepared.goodsWalkIn), money.rupees(f.goodsOther), money.rupees(prepared.goodsCredit)]);
    for (const x of prepared.count || []) {
      await db.query('INSERT INTO fuel_close_counts(business_id,close_id,denomination,pieces) VALUES($1,$2,$3,$4)', [business.id, closeRow.id, x.denomination, x.pieces]);
    }
    // What is still short on a walk-in bill is paid from the attendant's account (due from them).
    const fromAccount = (amount, part) => (amount > 0 ? [{ amount, methodName: ATTENDANT_ACCOUNT, reference: `${shift.shift_no} · ${shift.attendant_name}`.slice(0, 100),
      key: c.derivedKey(requestKey, `account-${part}`) }] : []);
    // The walk-in fuel bill: a line for each fuel, paid by the takings, then the cash, then the attendant's account.
    const walkInProducts = f.products.filter((p) => p.walkInLitres > 0);
    let walkInDoc = null, walkInLines = [], paymentIds = [];
    const onFuel = prepared.takings.map((p, i) => ({ ...p, part: f.fuelParts[i] })).filter((p) => p.part > 0);
    if (walkInProducts.length) {
      const lines = walkInProducts.map((p) => fuelLine(prepared.fuels[p.productId].skuId, p.walkInLitres, p.price, p.walkInAmount, `${prepared.fuels[p.productId].name} · ${VAT_WORDS}`));
      const parts = onFuel.map((p) => ({ amount: Number(money.rupees(p.part)), method: p.method, methodId: p.methodId, reference: p.reference, tendered: null }));
      if (f.cashPaid > 0) parts.push({ amount: Number(money.rupees(f.cashPaid)), method: 'cash', methodId: null, reference: null, tendered: null });
      const documentBody = { kind: 'sale', locationId: shift.location_id, lines: lines.map((l) => l.input), notes: `Walk-in fuel sales of shift ${shift.shift_no} (${shift.attendant_name})` };
      walkInDoc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: walkInKey, hash: c.hashOf(documentBody), lines: documentBody.lines,
        paidNow: parts, fixed: lines.map((l) => l.fixed), fuel: true, tenders: fromAccount(f.shortFuel, 'fuel') });
      if (money.paise(walkInDoc.total) !== f.walkIn) fail(`The walk-in fuel bill would come to ${walkInDoc.total}, not the ${money.rupees(f.walkIn)} the meters sold. Try again.`, 409);
      walkInLines = await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, walkInDoc.id]);
      paymentIds = (await repo.all(db, 'SELECT id,method FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, walkInDoc.id]))
        .filter((p) => p.method !== 'cash' && p.method !== 'credit_note').map((p) => p.id);
      if (walkInLines.length !== walkInProducts.length || paymentIds.length !== onFuel.length) fail('The walk-in fuel bill does not match the shift. Try again.', 409);
      await db.query('UPDATE fuel_shift_closes SET document_id=$3 WHERE business_id=$1 AND id=$2', [business.id, closeRow.id, walkInDoc.id]);
    }
    // The other sales: a GST invoice to walk-in buyers (paid what is left of the takings, then of the cash, then the attendant's account), and one to each customer on credit.
    const goodsDocs = [];
    for (const g of prepared.goodsBills) {
      const walkIn = !g.contactId;
      const parts = walkIn ? prepared.takings.map((p, i) => ({ amount: Number(money.rupees(f.goodsParts[i])), method: p.method, methodId: p.methodId, reference: p.reference, tendered: null }))
        .filter((p) => p.amount > 0) : [];
      if (walkIn && f.cashGoods > 0) parts.push({ amount: Number(money.rupees(f.cashGoods)), method: 'cash', methodId: null, reference: null, tendered: null });
      const documentBody = { ...g.body, notes: `Other sales of shift ${shift.shift_no} (${shift.attendant_name})` };
      const doc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, `goods-${g.contactId || 'walk-in'}`), hash: c.hashOf(documentBody),
        lines: documentBody.lines, paidNow: parts, tenders: walkIn ? fromAccount(f.shortGoods, 'goods') : [] });
      if (money.paise(doc.total) !== g.total) fail(`The other sales' bill would come to ${doc.total}, not ${money.rupees(g.total)}. Try again.`, 409);
      goodsDocs.push({ doc, walkIn });
    }
    // Each fill of ₹2,00,000 or more: a fuel bill of its own to its buyer, with their PAN or declaration, paid as they paid.
    const bigDocs = [];
    for (const [index, b] of prepared.bigFills.entries()) {
      const fuel = prepared.fuels[b.productId];
      const line = fuelLine(fuel.skuId, b.thousandths, b.price, b.amount, `${fuel.name}${b.registration ? ` · ${b.registration}` : ''} · ${VAT_WORDS}`);
      const documentBody = { kind: 'sale', locationId: shift.location_id, lines: [line.input], buyer: { ...(b.pan ? { pan: b.pan } : { panDeclaration: true }) },
        notes: `Fill of shift ${shift.shift_no}${b.buyerName ? ` to ${b.buyerName}` : ''}${b.registration ? `, vehicle ${b.registration}` : ''}`.slice(0, 500) };
      const doc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, `big-${index + 1}`), hash: c.hashOf(documentBody),
        lines: documentBody.lines, paidNow: b.payments.map((p) => ({ amount: Number(p.amount), method: p.method, methodId: p.methodId, reference: p.reference, tendered: null })),
        fixed: [line.fixed], fuel: true });
      if (money.paise(doc.total) !== b.amount) fail(`The fill's bill would come to ${doc.total}, not ${money.rupees(b.amount)}. Try again.`, 409);
      const docLine = await repo.one(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2', [business.id, doc.id]);
      bigDocs.push({ fill: b, doc, lineId: docLine.id });
    }
    // A fuel bill to each fleet customer billed per shift: a line for each credit slip, with its vehicle.
    // A customer billed by the month gets none: the fill is held for the month's invoice.
    const credit = prepared.slips.filter((s) => s.held).map((slip) => ({ slip, documentId: null, lineId: null }));
    const customers = [...new Set(prepared.slips.filter((s) => !s.held).map((s) => String(s.contactId)))];
    for (const contactId of customers) {
      const mine = prepared.slips.filter((s) => !s.held && String(s.contactId) === contactId);
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
      await db.query(`INSERT INTO fuel_close_products(business_id,close_id,shift_id,product_id,price,litres,credit_litres,walk_in_litres,credit_amount,walk_in_amount,amount,line_id,
          big_litres,big_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [business.id, closeRow.id, shift.id, p.productId, money.rupees(p.price), money.litres(p.litres),
        money.litres(p.creditLitres), money.litres(p.walkInLitres), money.rupees(p.creditAmount), money.rupees(p.walkInAmount), money.rupees(p.amount),
        lineIndex >= 0 ? walkInLines[lineIndex].id : null, money.litres(p.bigLitres), money.rupees(p.bigAmount)]);
    }
    for (const [index, { slip, documentId, lineId }] of credit.entries()) {
      await db.query(`INSERT INTO fuel_credit_slips(business_id,close_id,shift_id,seq,contact_id,vehicle_id,registration,product_id,litres,price,amount,slip_no,over_limit,document_id,line_id,
          held,book_id,serial) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [business.id, closeRow.id, shift.id, index + 1, slip.contactId, slip.vehicleId,
        slip.vehicle.registration, slip.productId, money.litres(slip.thousandths), money.rupees(slip.price), money.rupees(slip.amount), slip.slipNo, slip.overLimit, documentId, lineId,
        slip.held, slip.bookId, slip.serial]);
    }
    for (const [index, p] of onFuel.entries()) {
      await db.query('INSERT INTO fuel_close_payments(business_id,close_id,seq,method,method_name,amount,reference,payment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [business.id, closeRow.id, index + 1, p.method, p.methodName, money.rupees(p.part), p.reference, paymentIds[index]]);
    }
    for (const { doc, walkIn } of goodsDocs) {
      await db.query('INSERT INTO fuel_close_goods_bills(business_id,close_id,document_id,walk_in) VALUES($1,$2,$3,$4)', [business.id, closeRow.id, doc.id, walkIn]);
    }
    for (const [index, { fill, doc, lineId }] of bigDocs.entries()) {
      await db.query(`INSERT INTO fuel_close_big_fills(business_id,close_id,shift_id,seq,product_id,litres,price,amount,registration,document_id,line_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, closeRow.id, shift.id, index + 1, fill.productId, money.litres(fill.thousandths), money.rupees(fill.price),
        money.rupees(fill.amount), fill.registration, doc.id, lineId]);
    }
    // The attendant's short is due from them; an excess is held on their account.
    if (f.difference !== 0) {
      await db.query(`INSERT INTO fuel_attendant_entries(business_id,location_id,attendant_id,attendant_name,kind,amount,close_id,request_key,request_hash,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [business.id, shift.location_id, shift.attendant_id, shift.attendant_name, f.difference < 0 ? 'short' : 'excess',
        money.rupees(Math.abs(f.difference)), closeRow.id, c.derivedKey(requestKey, 'attendant'), hash, user.id]);
    }
    // Each nozzle now reads its closing reading: the next shift on it opens from there.
    for (const r of prepared.readings) {
      if (r.closing !== r.opening) await db.query('UPDATE fuel_nozzles SET reading=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, r.nozzleId, r.closing]);
    }
    await db.query("UPDATE fuel_shifts SET status='closed',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, shift.id, user.id]);
    const words = { shiftNo: shift.shift_no, attendant: shift.attendant_name, seq, expected: closeRow.expected, credit: closeRow.credit, walkIn: closeRow.walk_in, cash: closeRow.cash,
      other: closeRow.other, difference: closeRow.difference, ...(walkInDoc ? { walkInBill: walkInDoc.document_no } : {}), ...(approvedBy ? { creditAllowedOverLimit: prepared.limits } : {}),
      ...(f.dropped ? { dropped: closeRow.dropped } : {}), ...(goodsDocs.length ? { otherSales: goodsDocs.map((g) => g.doc.document_no) } : {}),
      ...(bigDocs.length ? { bigFills: bigDocs.map((g) => g.doc.document_no) } : {}), ...(credit.some((x) => x.slip.held) ? { heldForTheMonth: credit.filter((x) => x.slip.held).length } : {}),
      ...(f.difference < 0 ? { dueFromAttendant: money.rupees(-f.difference) } : f.difference > 0 ? { heldForAttendant: money.rupees(f.difference) } : {}) };
    await repo.audit(db, business.id, user.id, 'fuel_shift.closed', shift.id, words);
    await repo.event(db, business.id, user.id, 'fuel_shift.closed', 'fuel_shift', shift.id, { ...words, locationId: shift.location_id, closeId: closeRow.id,
      documentIds: [walkInDoc?.id, ...new Set(credit.map((x) => x.documentId)), ...goodsDocs.map((g) => g.doc.id), ...bigDocs.map((g) => g.doc.id)].filter(Boolean),
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
    // Fleet fills already on a month's invoice stay billed: the shift is no longer reopened.
    const invoiced = await repo.one(db, `SELECT d.document_no FROM fuel_credit_slips k JOIN fuel_month_invoice_fills b ON b.business_id=k.business_id AND b.slip_id=k.id
      JOIN fuel_month_invoices i ON i.business_id=b.business_id AND i.id=b.invoice_id JOIN business_documents d ON d.business_id=i.business_id AND d.id=i.document_id
      WHERE k.business_id=$1 AND k.close_id=$2 LIMIT 1`, [business.id, current.id]);
    if (invoiced) fail(`This shift's fleet fills are billed on the month's invoice ${invoiced.document_no}: it is no longer reopened`, 409);
    // The attendant's short or excess goes back off their account; an excess that went to income since stays there.
    const account = await repo.all(db, "SELECT kind,amount FROM fuel_attendant_entries WHERE business_id=$1 AND close_id=$2 AND kind IN ('short','excess')", [business.id, current.id]);
    const excess = account.filter((e) => e.kind === 'excess').reduce((sum, e) => sum + money.paise(e.amount), 0);
    if (excess) {
      const balance = await repo.one(db, 'SELECT held FROM fuel_attendant_balance($1,$2)', [business.id, shift.attendant_id]);
      if (money.paise(balance.held) < excess) {
        fail(`${shift.attendant_name}'s ₹${money.rupees(excess)} excess of this shift was taken to income since: the shift is no longer reopened`, 409);
      }
    }
    await db.query('UPDATE fuel_shift_closes SET reopened_at=now(),reopened_by=$3,reopen_reason=$4,reopen_key=$5,reopen_hash=$6 WHERE business_id=$1 AND id=$2',
      [business.id, current.id, user.id, reason, requestKey, hash]);
    for (const e of account) {
      await db.query(`INSERT INTO fuel_attendant_entries(business_id,location_id,attendant_id,attendant_name,kind,amount,close_id,note,request_key,request_hash,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, shift.location_id, shift.attendant_id, shift.attendant_name, `${e.kind}_reversed`, e.amount, current.id,
        `Shift ${shift.shift_no} reopened: ${reason}`.slice(0, 300), c.derivedKey(requestKey, `account-${e.kind}`), hash, user.id]);
    }
    // Its bills credited in full (the litres and goods back in stock); the walk-in bills' takings, and a big fill's money, handed back the way they came.
    const documentIds = [...new Set([current.document_id, ...(await repo.all(db, `SELECT document_id FROM fuel_credit_slips WHERE business_id=$1 AND close_id=$2
      UNION ALL SELECT document_id FROM fuel_close_big_fills WHERE business_id=$1 AND close_id=$2 UNION ALL SELECT document_id FROM fuel_close_goods_bills WHERE business_id=$1 AND close_id=$2`,
    [business.id, current.id])).map((r) => r.document_id)].filter(Boolean).map(String))];
    const credited = [];
    const words = `Shift ${shift.shift_no} reopened: ${reason}`.slice(0, 300);
    for (const documentId of documentIds) {
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, documentId]);
      // What is left of each line (other sales may have come back on their own since).
      const lines = (await repo.all(db, `SELECT l.id,(l.quantity-COALESCE((SELECT sum(r.quantity) FROM business_return_lines r WHERE r.business_id=l.business_id AND r.line_id=l.id),0))::text AS left
        FROM business_document_lines l WHERE l.business_id=$1 AND l.document_id=$2 ORDER BY l.id`, [business.id, doc.id])).filter((l) => money.milli(l.left) > 0);
      if (lines.length) {
        const input = { reason: words, requestKey: c.derivedKey(requestKey, `return-${doc.id}`), hash: c.hashOf({ reopen: requestKey, document: doc.id }),
          lines: lines.map((l) => ({ lineId: l.id, quantity: l.left, restock: true })) };
        const returned = await returns.postReturn(db, business, user, doc, input);
        credited.push({ documentNo: doc.document_no, returnNo: returned.return_no, total: returned.total });
      }
      if (!doc.contact_id) {
        // A walk-in bill credited in full: what was paid on it goes back (the takings, the cash, the attendant's account), less what was handed back already.
        const paid = await repo.all(db, 'SELECT * FROM business_payments WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]);
        const refunded = await repo.one(db, 'SELECT COALESCE(sum(amount),0) AS amount FROM business_refunds WHERE business_id=$1 AND document_id=$2', [business.id, doc.id]);
        let left = paid.reduce((sum, p) => sum + money.paise(p.amount), 0) - money.paise(refunded.amount);
        for (const p of paid) {
          const amount = Math.min(money.paise(p.amount), left);
          if (amount <= 0) break;
          left -= amount;
          await returns.postRefund(db, business, user, doc, { amount: Number(money.rupees(amount)), choice: await refundChoice(db, business, p), reason: words,
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
    await repo.audit(db, business.id, user.id, 'fuel_shift.reopened', shift.id, { shiftNo: shift.shift_no, reason, credited,
      ...(account.length ? { attendantAccount: account.map((e) => ({ reversed: e.kind, amount: e.amount })) } : {}) });
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

module.exports = { SHIFTS_SQL, HELD_SQL, ATTENDANT_ACCOUNT, list, attendants, day, detail, load, open, addNozzle, removeNozzle, updateNotes, addDrop, cancelDrop, readClose, preview, close,
  reopen };
