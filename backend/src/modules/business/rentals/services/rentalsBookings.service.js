const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./rentalsCommon');
const money = require('./rentalsMoney');
// Handing money back and a manager's PIN (shared with the salon, repairs, opticians, garages and laundries).
const refunds = () => require('../../salon-weight/services/businessAdvanceRefunds');
const pins = () => require('../../salon-weight/services/businessManagerPin');

// Quotes and bookings (module "rentals", rental and hire businesses).
//
//   book      a hirer (one of the customers, or a new one typed at the
//             counter), when it goes out and when it is due back (at most 90
//             days), and what is hired: a unit of an item hired one by one, or
//             how many from a pool. Each line is priced at the cheapest mix of
//             its item's rates for the hours charged, with GST at its item's
//             slab, and keeps the rates and rules it was booked at. A quote
//             holds nothing; a reserved booking holds its units and pieces (the
//             database refuses a unit held twice, or a pool held over). An
//             advance may be taken (a collection receipt: money on account for
//             the hire, never more than the hire).
//   change    a quote or a reserved booking: its times, lines and notes, priced
//             again (lines kept keep their booked rates); one handed over: its
//             due back time (an extension, priced again) and notes.
//   money     advances and refundable deposits taken for a booking, each a
//             collection receipt in the hirer's name. A deposit is not a
//             payment for the hire until the shop applies it to the bill; what
//             is left of it after the bill goes back, with a manager's PIN.
//   kits      a kit books its parts (each a line of its own from its pool,
//             as many as the kit has of each, checked for what is free like
//             any line); it is billed as its own line or by its parts, as the
//             kit is set when booked.
//   discount  a percent off the hire of every line, with its reason: within
//             the business's most bill discount (the owner, any) and by the
//             discount permission; kept on the booking and billed.
//   cancel    a quote or a reserved booking, with a reason; a cancellation
//             charge is billed with its GST (each at its item's slab) and paid
//             from the advance and the deposit first; what is left goes back.
//             With the shop's cancellation slabs set, the charge of a reserved
//             booking is worked out from the hours left before its out time
//             (a share of each line's hire), not typed; a manager may waive
//             it, with the reason (kept and audited).
// The handover and the return have a file of their own. Money is integer
// paise; someone who does not see sales sees bookings without money.

const { fail, id } = c;
// The most a booking may come to (₹100 crore, the core's limit for a bill).
const MAX_TOTAL = 100000000000;
const MONEY_FIELDS = ['total', 'subtotal', 'tax', 'round_off', 'deposit_due', 'deposit_collected', 'deposit_held', 'advance', 'advance_left', 'bill_due'];
const LINE_MONEY = ['rate_hour', 'rate_day', 'rate_week', 'rate_month', 'late_rate', 'deposit_each', 'price', 'amount', 'net', 'tax', 'late_fee_now', 'discount', 'late_cap', 'late_slabs',
  'extra_km_rate', 'fuel_rate'];

// --- Lists -----------------------------------------------------------------------------------------

// Every booking with its lines in words, where it stands (its stage, worked out
// from its status, its times on the business's clock and its money), what is
// held for it (advances and deposits) and what is still due on its bill.
const BOOKINGS_SQL = `SELECT y.*,
    CASE WHEN y.status='quote' THEN 'quote' WHEN y.status='reserved' THEN 'reserved'
      WHEN y.status='out' AND y.due_at<now() THEN 'overdue' WHEN y.status='out' AND y.due_day=y.today THEN 'due_today' WHEN y.status='out' THEN 'out'
      WHEN y.bill_due>0 OR y.deposit_held>0 OR y.advance_left>0 THEN 'to_settle' WHEN y.status='cancelled' THEN 'cancelled' ELSE 'closed' END AS stage,
    (y.status='out' AND y.due_at<now()) AS overdue,
    (y.status='out' AND y.due_day=y.today) AS due_today,
    (y.status='reserved' AND y.out_day=y.today) AS pickup_today,
    (y.status='reserved' AND y.out_at<now()) AS late_pickup,
    (y.status='out') AS out_now,
    (y.status IN ('quote','reserved','out') OR y.bill_due>0 OR y.deposit_held>0 OR y.advance_left>0) AS open
  FROM (
  SELECT b.id,b.booking_no,b.location_id,l.name AS location_name,b.contact_id,b.customer_name,b.customer_phone,b.status,b.out_at,b.due_at,b.checked_out_at,b.returned_at,
    b.cancelled_at,b.total,b.deposit_due,b.document_id,d.document_no,b.notes,b.created_at,b.updated_at,
    (now() AT TIME ZONE z.timezone)::date AS today,(b.out_at AT TIME ZONE z.timezone)::date AS out_day,(b.due_at AT TIME ZONE z.timezone)::date AS due_day,
    g.lines,g.pieces,g.items,
    COALESCE(m.deposit_collected,0) AS deposit_collected,COALESCE(m.deposit_held,0) AS deposit_held,COALESCE(m.advance,0) AS advance,COALESCE(m.advance_left,0) AS advance_left,
    CASE WHEN d.id IS NULL THEN 0 ELSE GREATEST(0,${c.DUE_SQL('d')}) END AS bill_due
  FROM rental_bookings b JOIN businesses z ON z.id=b.business_id
  JOIN business_locations l ON l.business_id=b.business_id AND l.id=b.location_id
  LEFT JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id
  CROSS JOIN LATERAL (SELECT count(*)::int AS lines,COALESCE(sum(x.quantity),0)::int AS pieces,
      string_agg(CASE WHEN x.unit_id IS NULL THEN x.quantity||' × '||x.item_name ELSE x.unit_label||COALESCE(' ('||x.serial_no||')','') END,', ' ORDER BY x.seq) AS items
    FROM rental_booking_lines x WHERE x.business_id=b.business_id AND x.booking_id=b.id AND x.kit_line_id IS NULL) g
  LEFT JOIN LATERAL (SELECT sum(k.amount) FILTER (WHERE r.purpose='deposit') AS deposit_collected,sum(${c.FREE_SQL('k')}) FILTER (WHERE r.purpose='deposit') AS deposit_held,
      sum(k.amount) FILTER (WHERE r.purpose='advance') AS advance,sum(${c.FREE_SQL('k')}) FILTER (WHERE r.purpose='advance') AS advance_left
    FROM rental_receipts r JOIN business_collections k ON k.business_id=r.business_id AND k.id=r.collection_id WHERE r.business_id=b.business_id AND r.booking_id=b.id) m ON TRUE
  WHERE b.business_id=$1) y`;
const BOOKING_LIST = {
  sql: BOOKINGS_SQL,
  search: ['booking_no', 'customer_name', 'customer_phone', 'items', 'document_no', 'notes'], date: 'out_at',
  filters: { stage: 'stage', status: 'status', location: 'location_id', contact: 'contact_id', overdue: 'overdue', due_today: 'due_today', pickup_today: 'pickup_today',
    late_pickup: 'late_pickup', out_now: 'out_now', open: 'open' },
};
// The board's order: by stage, then what is due back or goes out first.
const BOARD_ORDER = `CASE stage WHEN 'overdue' THEN 0 WHEN 'due_today' THEN 1 WHEN 'out' THEN 2 WHEN 'reserved' THEN 3 WHEN 'quote' THEN 4 ELSE 5 END,
  CASE WHEN status='out' THEN due_at ELSE out_at END,id`;

repo.addLists({
  // Every booking, by when it goes out (newest first, with dates); the open ones in the board's order.
  'rental-bookings': { ...BOOKING_LIST, order: 'out_at DESC,id DESC' },
  'rental-bookings-open': { ...BOOKING_LIST, sql: `SELECT * FROM (${BOOKINGS_SQL}) z WHERE z.open`, order: BOARD_ORDER },
});

// What someone who does not see sales sees of a booking: no money.
function withoutMoney(row) {
  const out = { ...row };
  for (const key of MONEY_FIELDS) if (key in out) out[key] = null;
  if (Array.isArray(out.lines)) out.lines = out.lines.map((l) => Object.fromEntries(Object.entries(l).map(([k, value]) => [k, LINE_MONEY.includes(k) ? null : value])));
  for (const key of ['receipts', 'charges', 'refunds']) if (Array.isArray(out[key])) out[key] = [];
  if (Array.isArray(out.returns)) out.returns = out.returns.map((r) => ({ ...r, lines: (r.lines || []).map((x) => ({ ...x, late_fee: null, km_fee: null, fuel_fee: null })) }));
  out.bill = null; out.deposit = null; out.advance_summary = null; out.pending = null; out.cancellation = out.cancellation ? { ...out.cancellation, worked_out: null, charged: null } : null;
  return out;
}
const shape = (business, booking) => (c.seesMoney(business) ? { ...booking, money: true } : { ...withoutMoney(booking), money: false });
const listShape = (business, page) => (c.seesMoney(business) ? page : { ...page, items: page.items.map(withoutMoney) });

// --- Reading a request -----------------------------------------------------------------------------

function readLine(raw, index) {
  const name = `Line ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  return { itemId: id(raw.itemId, `${name}: item`), unitId: c.given(raw.unitId) ? id(raw.unitId, `${name}: unit`) : null,
    quantity: c.given(raw.quantity) ? c.whole(raw.quantity, `${name}: how many`, 1, 1000000) : null };
}
function readLines(value) {
  const lines = v.requiredArray(value, 'What is hired');
  if (!lines.length) fail('Add what is hired out');
  if (lines.length > c.MAX_LINES) fail(`A booking takes at most ${c.MAX_LINES} lines`);
  return lines.map(readLine);
}

// A discount on the hire as typed: { percent, reason }, or none (null); `{}` or a nil percent takes it off.
function readDiscount(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !c.given(value.percent) || Number(value.percent) === 0) return null;
  return { percent: core.decimal(value.percent, 'Discount (percent)', 2, 0.01, 100), reason: v.requiredString(typeof value.reason === 'string' ? value.reason : '', 'Reason for the discount', 300) };
}

// A discount given: by the discount permission, within the business's most bill discount (the owner, any).
async function checkDiscount(db, business, discount) {
  if (!discount) return;
  await access.require(business, 'sales.discount');
  const limit = await repo.one(db, 'SELECT max_bill_discount_percent FROM business_settings WHERE business_id=$1', [business.id]);
  const most = Number(limit?.max_bill_discount_percent ?? 10);
  if (!business.full_access && discount.percent > most) {
    fail(`At most ${most}% of a bill can be taken off. The owner can change this in Business settings.`, 409);
  }
}

// The booking as asked: what the preview prices and a booking keeps.
function readBooking(body) {
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Hirer') : null;
  const newCustomer = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer) && c.given(body.customer.name)
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone, consents: body.customer.consents } : null;
  return {
    locationId: id(body.locationId, 'Location'), contactId, newCustomer, status: v.requiredEnum(body.status ?? 'reserved', 'Booking', ['quote', 'reserved']),
    outAt: body.outAt, dueAt: body.dueAt, notes: c.optionalText(body.notes, 'Notes', 500), lines: readLines(body.lines), discount: readDiscount(body.discount) ?? null,
  };
}

// When it goes out and is due back: to the minute on the business's clock, at most 90 days, today or later.
async function readTimes(db, business, { outAt, dueAt }, existing = null) {
  const out = await c.readInstant(db, business, outAt, 'Out from');
  const due = await c.readInstant(db, business, dueAt, 'Due back by');
  if (due <= out) fail('The due back time is after the out time');
  if (due - out > c.MAX_DAYS * 86400000) fail(`A booking runs at most ${c.MAX_DAYS} days`);
  const start = await repo.one(db, `SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS at`, [business.timezone || 'Asia/Kolkata']);
  if (out < start.at && !(existing && +out === +existing.out_at)) fail('A booking starts today or later');
  return { outAt: out, dueAt: due, minutes: Math.round((due - out) / 60000) };
}

// --- Pricing ---------------------------------------------------------------------------------------

const ratePaise = (value) => (value === null || value === undefined ? null : money.paise(value));
// The late rate a line keeps: the item's own, or its hour rate (by the hour, or the multiples of slabs) or day rate.
const lateRateOf = (r) => (r.late_per === 'none' ? null : r.late_rate ?? (r.late_per === 'day' ? r.rate_day : r.rate_hour));
// An item's rates and rules now (its class's late slabs and cap when it has none of its own).
const termsOf = (item) => {
  const slabs = item.late_per === 'slabs' ? item.late_slabs || item.class_slabs || null : null;
  if (item.late_per === 'slabs' && !slabs) fail(`${item.name}'s late fee is by slabs, and neither it nor its class has them: set them under Rental items`, 409);
  return { hour: item.rate_hour, day: item.rate_day, week: item.rate_week, month: item.rate_month, minHours: item.min_hours, buffer: item.buffer_minutes, grace: item.grace_minutes,
    latePer: item.late_per, lateRate: lateRateOf(item), deposit: item.deposit, lateSlabs: slabs, lateCap: item.late_per === 'none' ? null : item.late_cap ?? item.class_cap ?? null,
    kmAllowance: item.km_allowance, kmPer: item.km_per, extraKmRate: item.extra_km_rate, fuelPer: item.fuel_per, fuelRate: item.fuel_rate, tankLitres: item.tank_litres };
};
// A line's rates and rules as booked.
const termsKept = (row) => ({ hour: row.rate_hour, day: row.rate_day, week: row.rate_week, month: row.rate_month, minHours: row.min_hours, buffer: row.buffer_minutes,
  grace: row.grace_minutes, latePer: row.late_per, lateRate: row.late_rate, deposit: row.deposit_each, lateSlabs: row.late_slabs, lateCap: row.late_cap, kmAllowance: row.km_allowance,
  kmPer: row.km_per, extraKmRate: row.extra_km_rate, fuelPer: row.fuel_per, fuelRate: row.fuel_rate, tankLitres: row.tank_litres });

// Each line priced as a bill of the hire would be now: the unit or how many,
// the rates and rules it is booked at (a line kept on a change keeps its own;
// a new line takes its item's), the hours charged, the cheapest mix, the line
// at it less the booking's discount, and GST at its item's slab now; the
// deposit for each one hired. A kit's parts are lines of their own: a kit kept
// on a change keeps the parts it was booked with, a new one takes its parts
// now; the kit's line is billed when the kit is billed as itself, the parts'
// lines when it is billed by its parts.
async function priceBooking(db, business, input, times, existing = null, discount = null) {
  const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const taxMode = existing ? existing.tax_mode : settings?.tax_mode || 'exclusive';
  const before = existing ? await repo.all(db, 'SELECT * FROM rental_booking_lines WHERE business_id=$1 AND booking_id=$2 ORDER BY seq', [business.id, existing.id]) : [];
  const asked = [...new Set(input.lines.map((l) => l.itemId))];
  const recipes = await repo.all(db, 'SELECT kit_id,part_id,quantity FROM rental_kit_parts WHERE business_id=$1 AND kit_id=ANY($2::bigint[])', [business.id, asked]);
  const ids = [...new Set([...asked, ...recipes.map((r) => Number(r.part_id)), ...before.map((b) => Number(b.item_id))])];
  const items = await repo.all(db, `SELECT i.*,s.label AS name,s.tax_rate,(s.active AND p.active) AS sku_active,s.internal_use,k.late_slabs AS class_slabs,k.late_cap AS class_cap
    FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN rental_classes k ON k.business_id=i.business_id AND k.id=i.class_id WHERE i.business_id=$1 AND i.id=ANY($2::bigint[])`, [business.id, ids]);
  const units = await repo.all(db, 'SELECT * FROM rental_units WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, input.lines.map((l) => l.unitId).filter(Boolean)]);
  const itemOf = (itemId) => items.find((i) => Number(i.id) === Number(itemId));
  const priceOf = (item, terms, quantity, billed) => {
    const hours = money.chargedHours(times.minutes, terms.minHours);
    if (!billed) return { hours, best: { months: 0, weeks: 0, days: 0, hours: 0, price: 0 }, amount: 0, discount: 0, net: 0, tax: 0 };
    const best = money.bestPrice({ hour: ratePaise(terms.hour), day: ratePaise(terms.day), week: ratePaise(terms.week), month: ratePaise(terms.month) }, hours);
    const amount = best.price * quantity;
    if (!Number.isSafeInteger(amount) || amount > MAX_TOTAL) fail(`${item.name} would come to more than a bill can hold: book fewer, or for less time`);
    const off = discount ? money.percentOf(amount, discount.percent) : 0;
    return { hours, best, amount, discount: off, ...money.split(amount - off, item.tax_rate, taxMode) };
  };
  const seen = new Set();
  const lines = input.lines.map((line, index) => {
    const item = itemOf(line.itemId);
    if (!item) fail('Rental item not found', 404);
    if (!item.active) fail(`${item.name} is switched off: switch it on to book it`, 409);
    if (!item.sku_active) fail(`${item.name}, the service it is billed as, is switched off in the catalogue`, 409);
    if (item.internal_use) fail(`${item.name} is kept for use in services only and is not billed`, 409);
    let unit = null, quantity;
    if (item.kind === 'unit') {
      if (!line.unitId) fail(`${item.name} is hired one by one: choose the unit`);
      unit = units.find((u) => Number(u.id) === line.unitId && Number(u.item_id) === Number(item.id));
      if (!unit) fail(`That unit is not one of ${item.name}'s`, 404);
      if (unit.status === 'retired') fail(`${unit.label} is retired and is not booked`, 409);
      if (line.quantity !== null && line.quantity !== 1) fail(`${unit.label} is one unit: a line books one`);
      quantity = 1;
      if (seen.has(`u${unit.id}`)) fail(`${unit.label} is on the booking twice`);
      seen.add(`u${unit.id}`);
    } else {
      if (line.unitId) fail(item.kind === 'kit' ? `${item.name} is a kit: give how many kits, not a unit` : `${item.name} is hired from a pool: give how many, not a unit`);
      if (!line.quantity) fail(`Give how many ${item.name} are hired`);
      quantity = line.quantity;
      if (item.kind === 'pool' && quantity > Number(item.pool_quantity)) fail(`The shop has ${item.pool_quantity} of ${item.name}`, 409);
      if (seen.has(`p${item.id}`)) fail(`${item.name} is on the booking twice: give the total once`);
      seen.add(`p${item.id}`);
    }
    const kept = before.find((b) => !b.kit_line_id && Number(b.item_id) === Number(item.id) && (item.kind !== 'unit' || Number(b.unit_id) === Number(unit.id))) || null;
    const terms = kept ? termsKept(kept) : termsOf(item);
    const billed = item.kind === 'kit' ? (kept ? kept.billed : item.kit_billing === 'kit') : true;
    const entry = { index, item, unit, quantity, terms, kept, billed, ...priceOf(item, terms, quantity, billed), taxRate: Number(item.tax_rate), deposit: money.paise(terms.deposit) * quantity,
      parts: [] };
    if (item.kind === 'kit') {
      const keptParts = kept ? before.filter((b) => Number(b.kit_line_id) === Number(kept.id)) : null;
      const recipe = keptParts ? keptParts.map((b) => ({ partId: Number(b.item_id), each: Number(b.part_quantity), row: b }))
        : recipes.filter((r) => Number(r.kit_id) === Number(item.id)).map((r) => ({ partId: Number(r.part_id), each: Number(r.quantity), row: null }));
      if (!recipe.length) fail(`${item.name} has no parts: add them under Rental items`, 409);
      for (const r of recipe) {
        const part = itemOf(r.partId);
        if (!part.active) fail(`${part.name}, a part of ${item.name}, is switched off: switch it on to book the kit`, 409);
        const partQuantity = quantity * r.each;
        if (partQuantity > Number(part.pool_quantity)) fail(`The shop has ${part.pool_quantity} of ${part.name}: ${quantity} × ${item.name} take ${partQuantity}`, 409);
        const partTerms = r.row ? termsKept(r.row) : { ...termsOf(part), deposit: 0 };
        entry.parts.push({ item: part, unit: null, quantity: partQuantity, each: r.each, terms: partTerms, kept: r.row, billed: !billed,
          ...priceOf(part, partTerms, partQuantity, !billed), taxRate: Number(part.tax_rate), deposit: 0 });
      }
    }
    return entry;
  });
  const flat = lines.flatMap((l) => [l, ...l.parts]);
  if (flat.length > c.MAX_LINES) fail(`A booking takes at most ${c.MAX_LINES} lines, a kit's parts counted: split it into more than one booking`);
  const figures = money.billFigures(flat, settings?.rounding);
  if (figures.total > MAX_TOTAL) fail('The booking would come to more than a bill can hold: split it into more than one booking');
  return { taxMode, rounding: settings?.rounding || 'none', lines, flat, figures, deposit: lines.reduce((s, l) => s + l.deposit, 0), discount };
}

const lineText = (p) => ({ itemId: p.item.id, itemName: p.item.name, kind: p.item.kind, unitId: p.unit?.id || null, unitLabel: p.unit?.label || null, serialNo: p.unit?.serial_no || null,
  quantity: p.quantity, hours: p.hours, period: money.periodWords(p.best), price: money.rupees(p.best.price), amount: money.rupees(p.amount), discount: money.rupees(p.discount),
  taxRate: p.taxRate.toFixed(2), net: money.rupees(p.net), tax: money.rupees(p.tax), deposit: money.rupees(p.deposit), billed: p.billed, kept: Boolean(p.kept), latePer: p.terms.latePer,
  lateRate: p.terms.lateRate === null || p.terms.lateRate === undefined ? null : Number(p.terms.lateRate).toFixed(2), graceMinutes: Number(p.terms.grace),
  bufferMinutes: Number(p.terms.buffer) });
const pricedText = (p, timezone) => ({ index: p.index, ...lineText(p), kitBilling: p.item.kind === 'kit' ? (p.billed ? 'kit' : 'parts') : null,
  parts: p.parts.map((x) => ({ ...lineText(x), each: x.each })), timezone });

// Whether each line's unit or pieces are free at the booking's location over
// its time (with its turnaround time), leaving out a booking being changed: { free, words }.
// A kit is free when each of its parts is; the pieces of one pool on several lines are counted together.
async function availability(db, business, priced, times, exceptBooking = null, locationId = null) {
  const place = locationId ? await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId]) : null;
  const several = Number((await repo.one(db, 'SELECT count(*)::int AS n FROM business_locations WHERE business_id=$1 AND active', [business.id])).n) > 1;
  const need = {};
  for (const p of priced.flat) if (!p.unit && p.item.kind === 'pool') need[p.item.id] = (need[p.item.id] || 0) + p.quantity;
  const check = async (p) => {
    const until = new Date(+times.dueAt + Number(p.terms.buffer) * 60000);
    if (p.unit) {
      if (place && Number(p.unit.location_id) !== Number(place.id)) {
        const at = await repo.one(db, 'SELECT name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, p.unit.location_id]);
        return { free: false, words: `${p.unit.label} is kept at ${at.name}: book it there, or move it to ${place.name} first` };
      }
      const clash = await repo.one(db, 'SELECT * FROM rental_unit_clash($1,$2,$3,$4,$5,$6,NULL)', [business.id, p.item.id, p.unit.id, times.outAt, until, exceptBooking]);
      return { free: !clash, words: clash ? clashWords(p.unit.label, clash, business.timezone) : null };
    }
    const count = place ? Number((await repo.one(db, 'SELECT quantity FROM rental_pool_counts WHERE business_id=$1 AND item_id=$2 AND location_id=$3',
      [business.id, p.item.id, place.id]))?.quantity || 0) : Number(p.item.pool_quantity);
    const peak = place ? (await repo.one(db, 'SELECT rental_location_peak($1,$2,$3,$4,$5,$6,NULL) AS n', [business.id, p.item.id, place.id, times.outAt, until, exceptBooking])).n
      : (await repo.one(db, 'SELECT rental_pool_peak($1,$2,$3,$4,$5,NULL) AS n', [business.id, p.item.id, times.outAt, until, exceptBooking])).n;
    const left = Math.max(0, count - peak);
    const wanted = need[p.item.id] || p.quantity;
    return { free: wanted <= left, left, words: wanted <= left ? null : `Only ${left} of the ${count} ${p.item.name} are free then${several && place ? ` at ${place.name}` : ''}: ${peak} are booked` };
  };
  const out = [];
  for (const p of priced.lines) {
    if (p.item.kind === 'kit') {
      const parts = [];
      for (const part of p.parts) parts.push(await check(part));
      const blocked = parts.find((x) => !x.free);
      out.push({ index: p.index, free: !blocked, words: blocked ? `${p.item.name}: ${blocked.words}` : null, parts });
    } else {
      out.push({ index: p.index, ...await check(p) });
    }
  }
  return out;
}
const clashWords = (label, clash, timezone) => (clash.part === 'downtime'
  ? `${label} is booked for maintenance (${clash.customer_name}) from ${c.timeWords(clash.starts_at, timezone)} to ${c.timeWords(clash.ends_at, timezone)}`
  : clash.part === 'out'
    ? `${label} is out on ${clash.booking_no} with ${clash.customer_name}, due back ${c.timeWords(clash.due_at, timezone)}`
    : `${label} is booked on ${clash.booking_no} for ${clash.customer_name} from ${c.timeWords(clash.starts_at, timezone)} until it is free again at ${c.timeWords(clash.ends_at, timezone)}`);

// The figures of a booking being typed, nothing saved: each line priced, whether it is free, the deposit and the total.
// body: { locationId, outAt, dueAt, lines, discount?: { percent, reason }, bookingId? (a booking being changed: its own holds left out) }
async function preview(business, user, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  const lines = readLines(body.lines);
  const discount = readDiscount(body.discount) ?? null;
  return repo.transaction(async (db) => {
    const existing = c.given(body.bookingId) ? await repo.one(db, 'SELECT * FROM rental_bookings WHERE business_id=$1 AND id=$2', [business.id, id(body.bookingId, 'Booking')]) : null;
    if (c.given(body.bookingId) && !existing) fail('Booking not found', 404);
    const times = await readTimes(db, business, { outAt: body.outAt, dueAt: body.dueAt }, existing);
    const priced = await priceBooking(db, business, { lines }, times, existing, discount);
    const locationId = existing ? existing.location_id : c.given(body.locationId) ? id(body.locationId, 'Location') : null;
    const free = await availability(db, business, priced, times, existing?.id || null, locationId);
    return { taxMode: priced.taxMode, outAt: times.outAt, dueAt: times.dueAt, minutes: times.minutes,
      lines: priced.lines.map((p) => {
        const f = free.find((x) => x.index === p.index);
        const text = pricedText(p, business.timezone);
        return { ...text, ...f, parts: text.parts.map((x, i) => ({ ...x, ...(f.parts?.[i] || {}) })) };
      }),
      ...money.figuresText(priced.figures), discount: money.rupees(priced.flat.reduce((s, p) => s + p.discount, 0)), discountPercent: discount ? discount.percent.toFixed(2) : null,
      deposit: money.rupees(priced.deposit), free: free.every((f) => f.free) };
  });
}

// --- Saving lines ---------------------------------------------------------------------------------

async function insertLine(db, business, booking, p, seq, kitLineId = null) {
  return repo.one(db, `INSERT INTO rental_booking_lines(business_id,booking_id,seq,item_id,unit_id,sku_id,item_name,unit_label,serial_no,quantity,rate_hour,rate_day,rate_week,rate_month,
      min_hours,buffer_minutes,grace_minutes,late_per,late_rate,deposit_each,charged_hours,months,weeks,days,hours,price,amount,tax_rate,net,tax,kit_line_id,part_quantity,billed,
      discount,late_slabs,late_cap,km_allowance,km_per,extra_km_rate,fuel_per,fuel_rate,tank_litres)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42) RETURNING id`,
  [business.id, booking.id, seq, p.item.id, p.unit?.id || null, p.item.sku_id, p.item.name, p.unit?.label || null, p.unit?.serial_no || null, p.quantity,
    p.terms.hour, p.terms.day, p.terms.week, p.terms.month, p.terms.minHours, p.terms.buffer, p.terms.grace, p.terms.latePer, p.terms.lateRate, Number(p.terms.deposit).toFixed(2),
    p.hours, p.best.months, p.best.weeks, p.best.days, p.best.hours, money.rupees(p.best.price), money.rupees(p.amount), p.taxRate.toFixed(2), money.rupees(p.net), money.rupees(p.tax),
    kitLineId, kitLineId ? p.each : null, p.billed, money.rupees(p.discount), p.terms.lateSlabs ? JSON.stringify(p.terms.lateSlabs) : null, p.terms.lateCap ?? null,
    p.terms.kmAllowance ?? null, p.terms.kmPer ?? null, p.terms.extraKmRate ?? null, p.terms.fuelPer ?? null, p.terms.fuelRate ?? null, p.terms.tankLitres ?? null]);
}

async function insertLines(db, business, booking, priced) {
  let seq = 0;
  for (const p of priced.lines) {
    seq += 1;
    const row = await insertLine(db, business, booking, p, seq);
    for (const part of p.parts) {
      seq += 1;
      await insertLine(db, business, booking, part, seq, row.id);
    }
  }
}

// --- Money taken for a booking ---------------------------------------------------------------------

// An advance or a deposit: a numbered collection receipt in the hirer's name
// (cash, card, UPI or bank), kept with the booking. Inside the caller's transaction.
async function takeReceipt(db, business, user, booking, { purpose, amount, method, methodName, reference, requestKey, hash }) {
  const receipt = await numbering.nextNumber(db, business.id, booking.location_id, 'collection', user.id);
  const words = purpose === 'deposit' ? `Refundable deposit for booking ${booking.booking_no}` : `Advance on booking ${booking.booking_no}`;
  const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, booking.location_id, receipt.number, receipt.seriesId, booking.contact_id, booking.customer_name,
    money.rupees(amount), method, reference || null, words, requestKey, hash, user.id, methodName || null]);
  await db.query('INSERT INTO rental_receipts(business_id,collection_id,booking_id,purpose,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, collection.id, booking.id, purpose, user.id]);
  await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, rentalBooking: booking.booking_no, purpose });
  await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
    collectionNo: collection.collection_no, contactId: booking.contact_id, amount: collection.amount, method: collection.method, rentalBookingId: booking.id, purpose });
  await history(db, business, user, booking, null, null, `${purpose === 'deposit' ? 'Deposit' : 'Advance'} taken (${collection.collection_no})`);
  return collection;
}

// { amount, method | methodId, reference? } as typed, for an advance or a deposit (sales.edit). null when none.
async function readMoney(db, business, value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an amount and how it was paid`);
  const amount = core.decimal(value.amount ?? 0, label, 2, 0, 10000000);
  if (amount <= 0) return null;
  await access.require(business, 'sales.edit');
  return { amount: money.paise(amount), ...await paymentMethods.pick(db, business.id, value, `${label} paid by`, c.RECEIPT_KINDS), reference: c.optionalText(value.reference, 'Reference', 100) };
}

// The receipts of a booking with what is left of each (locked when asked): advances first, then deposits, oldest first.
async function receiptsOf(db, business, bookingId, { lock = false } = {}) {
  return repo.all(db, `SELECT r.purpose,k.id,k.collection_no,k.amount,k.method,k.method_name,k.reference,k.created_at,${c.FREE_SQL('k')} AS free
    FROM rental_receipts r JOIN business_collections k ON k.business_id=r.business_id AND k.id=r.collection_id
    WHERE r.business_id=$1 AND r.booking_id=$2 ORDER BY r.purpose='deposit',k.id${lock ? ' FOR UPDATE OF k' : ''}`, [business.id, bookingId]);
}

// The booking's advances, then its deposits, paid on its bill (each a payment from its receipt), up to what is due.
// Returns what each paid (paise). Inside the caller's transaction, the bill locked.
async function applyReceipts(db, business, user, booking, document, key) {
  const used = { advance: 0, deposit: 0 };
  const owed = await repo.one(db, `SELECT ${c.DUE_SQL('d')} AS due FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, document.id]);
  let left = Math.max(0, money.paise(owed.due));
  for (const receipt of await receiptsOf(db, business, booking.id, { lock: true })) {
    const take = Math.min(left, Math.max(0, money.paise(receipt.free)));
    if (take <= 0) continue;
    await core.recordPayment(db, business, user, document, { amount: money.rupees(take), method: receipt.method, reference: receipt.collection_no,
      key: c.derivedKey(key, `receipt:${receipt.id}`), collectionId: receipt.id });
    used[receipt.purpose] += take;
    left -= take;
  }
  return used;
}

// What is left of the booking's receipts handed back (deposits first, then
// advances), each a numbered refund of its receipt with the manager who
// approved it. `amount` null: all that is left. Asked again with the same
// key, the refunds already made are the answer. Returns the refunds
// (`repeated` on those made before).
async function refundLeft(db, business, user, booking, { purposes, amount = null, how, approval, key }) {
  const made = [];
  let left = amount;
  const receipts = (await receiptsOf(db, business, booking.id, { lock: true })).filter((r) => purposes.includes(r.purpose))
    .sort((a, b) => (a.purpose === b.purpose ? Number(a.id) - Number(b.id) : a.purpose === 'deposit' ? -1 : 1));
  for (const receipt of receipts) {
    const requestKey = c.derivedKey(key, `refund:${receipt.id}`);
    const before = await repo.one(db, 'SELECT * FROM business_collection_refunds WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (before) {
      made.push({ ...before, collection_no: receipt.collection_no, purpose: receipt.purpose, repeated: true });
      if (left !== null) left -= Math.min(left, money.paise(before.amount));
      continue;
    }
    const free = Math.max(0, money.paise(receipt.free));
    const take = left === null ? free : Math.min(left, free);
    if (take <= 0) continue;
    const input = { amount: take, method: how.method, methodId: how.methodId, reference: how.reference, requestKey };
    const { refund } = await refunds().refundCollection(db, business, user, { collectionId: receipt.id, contactId: booking.contact_id, input, approval, source: 'rentals',
      label: booking.booking_no });
    made.push({ ...refund, purpose: receipt.purpose, repeated: false });
    if (left !== null) left -= take;
  }
  if (left !== null && left > 0) fail(`Only ${money.rupees(amount - left)} is held for booking ${booking.booking_no}`, 409);
  return made;
}

// How money goes back: { method | methodId, reference? } — cash, UPI or bank (a reference for UPI and bank).
function readBack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Say how the money goes back');
  const { method, methodId } = paymentMethods.readChoice(value, 'Handed back by', ['cash', 'upi', 'bank'], 'cash');
  const reference = c.optionalText(value.reference, 'Reference', 100);
  if (method && method !== 'cash' && !reference) fail(`Enter the ${method === 'upi' ? 'UPI' : 'bank'} reference of the money handed back`);
  return { method, methodId, reference };
}

// --- History ---------------------------------------------------------------------------------------

async function history(db, business, user, booking, from, to, note) {
  await db.query('INSERT INTO rental_booking_events(business_id,booking_id,from_status,to_status,note,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [business.id, booking.id, from, to, note ? String(note).slice(0, 500) : null, user.id]);
}

// --- Booking ---------------------------------------------------------------------------------------

async function lockBooking(db, business, bookingId) {
  // Same lock order as every posting: the business, then the record.
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const booking = await repo.one(db, 'SELECT * FROM rental_bookings WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(bookingId, 'Booking')]);
  if (!booking) fail('Booking not found', 404);
  access.requireLocation(business, booking.location_id);
  return booking;
}

const periodOf = (booking, timezone) => `${c.timeWords(booking.out_at, timezone)} to ${c.timeWords(booking.due_at, timezone)}`;

// body: { requestKey, locationId, contactId | customer: { name, phone? }, status?: quote | reserved (reserved), outAt, dueAt,
//   lines: [{ itemId, unitId? (one by one), quantity? (a pool or a kit) }], discount?: { percent, reason }, notes?,
//   advance?: { amount, method | methodId, reference? } (reserved) }
async function create(business, user, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const input = readBooking(body);
  if (!input.contactId && !input.newCustomer) fail('Choose the hirer, or type the new hirer\'s name');
  if (input.contactId && input.newCustomer) fail('Choose the hirer or type a new one, not both');
  if (input.newCustomer) await access.require(business, 'contacts.create');
  access.requireLocation(business, input.locationId);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM rental_bookings WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, old.id));
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, input.locationId]);
    if (!location) fail('Location not found', 404);
    let contact;
    if (input.contactId) {
      contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, input.contactId]);
      if (!contact) fail('Hirer not found', 404);
      if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
    } else {
      contact = await core.createContact(business, user, input.newCustomer, db);
    }
    const times = await readTimes(db, business, input);
    await checkDiscount(db, business, input.discount);
    const priced = await priceBooking(db, business, input, times, null, input.discount);
    const advance = await readMoney(db, business, body.advance, 'Advance');
    if (advance && input.status !== 'reserved') fail('An advance is taken on a booking, not a quote: reserve it first');
    if (advance && advance.amount > priced.figures.total) fail(`The advance is part of the hire: at most ${money.rupees(priced.figures.total)}`);
    const number = await numbering.nextNumber(db, business.id, location.id, 'rental', user.id);
    const f = priced.figures;
    const booking = await repo.one(db, `INSERT INTO rental_bookings(business_id,location_id,booking_no,series_id,contact_id,customer_name,customer_phone,status,out_at,due_at,tax_mode,
        subtotal,tax,round_off,total,deposit_due,notes,request_key,request_hash,created_by,updated_by,discount_percent,discount_reason,discount_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20,$21,$22,$23) RETURNING *`,
    [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, contact.phone || null, input.status, times.outAt, times.dueAt, priced.taxMode,
      money.rupees(f.subtotal), money.rupees(f.tax), money.rupees(f.roundOff), money.rupees(f.total), money.rupees(priced.deposit), input.notes, requestKey, hash, user.id,
      input.discount ? input.discount.percent.toFixed(2) : '0', input.discount?.reason || null, input.discount ? user.id : null]);
    await insertLines(db, business, booking, priced);
    // A reserved booking holds what it books: checked now (and again by the database when saved).
    if (booking.status === 'reserved') await db.query('SELECT rental_check_booking($1,$2)', [business.id, booking.id]);
    await history(db, business, user, booking, null, booking.status, `${booking.status === 'quote' ? 'Quoted' : 'Booked'}: ${c.plural(priced.lines.length, 'line')} · ${periodOf(booking, business.timezone)}`);
    if (advance) await takeReceipt(db, business, user, booking, { purpose: 'advance', ...advance, requestKey: c.derivedKey(requestKey, 'advance'), hash });
    const details = { bookingNo: booking.booking_no, status: booking.status, customer: contact.name, outAt: booking.out_at, dueAt: booking.due_at, total: booking.total, depositDue: booking.deposit_due,
      ...(input.discount ? { discount: { percent: input.discount.percent, reason: input.discount.reason } } : {}) };
    await repo.audit(db, business.id, user.id, 'rental_booking.created', booking.id, details);
    await repo.event(db, business.id, user.id, 'rental_booking.created', 'rental_booking', booking.id, { ...details, locationId: location.id, contactId: contact.id,
      lines: priced.flat.map((p) => ({ itemId: p.item.id, unitId: p.unit?.id || null, quantity: p.quantity })) });
    return shape(business, await load(db, business, booking.id));
  });
}

// body: { outAt?, dueAt?, lines?, discount?: { percent, reason } | null, notes? } — a quote or a reserved booking changes its times, lines, discount
// and notes; one handed over its due back time (an extension), discount and notes. Priced again; what is left out stays.
async function update(business, user, bookingId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  return repo.transaction(async (db) => {
    const booking = await lockBooking(db, business, bookingId);
    if (['returned', 'cancelled'].includes(booking.status)) fail(`Booking ${booking.booking_no} is ${booking.status} and no longer changes`, 409);
    const out = booking.status === 'out';
    if (out && (body.outAt !== undefined || body.lines !== undefined)) fail(`Booking ${booking.booking_no} is out: only when it is due back and its notes change`, 409);
    const notes = body.notes === undefined ? booking.notes : c.optionalText(body.notes, 'Notes', 500);
    const before = await repo.all(db, 'SELECT * FROM rental_booking_lines WHERE business_id=$1 AND booking_id=$2 ORDER BY seq', [business.id, booking.id]);
    const asked = readDiscount(body.discount);
    const discount = asked === undefined ? (Number(booking.discount_percent) ? { percent: Number(booking.discount_percent), reason: booking.discount_reason } : null) : asked;
    const discountChanged = asked !== undefined && (Number(asked?.percent || 0) !== Number(booking.discount_percent) || (asked?.reason || null) !== booking.discount_reason);
    if (discountChanged) await checkDiscount(db, business, asked);
    if (body.outAt === undefined && body.dueAt === undefined && body.lines === undefined && !discountChanged) {
      if (notes !== booking.notes) {
        await db.query('UPDATE rental_bookings SET notes=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, booking.id, notes, user.id]);
        await history(db, business, user, booking, null, null, 'Notes changed');
        await repo.audit(db, business.id, user.id, 'rental_booking.changed', booking.id, { bookingNo: booking.booking_no, notes: { from: booking.notes, to: notes } });
      }
      return shape(business, await load(db, business, booking.id));
    }
    const lines = body.lines === undefined ? before.filter((l) => !l.kit_line_id).map((l) => ({ itemId: Number(l.item_id), unitId: l.unit_id ? Number(l.unit_id) : null, quantity: Number(l.quantity) }))
      : readLines(body.lines);
    const times = await readTimes(db, business, { outAt: body.outAt ?? booking.out_at.toISOString(), dueAt: body.dueAt ?? booking.due_at.toISOString() }, booking);
    if (out && body.dueAt !== undefined && times.dueAt <= new Date()) fail(`Booking ${booking.booking_no} is out: it is due back at a time still to come`);
    const priced = await priceBooking(db, business, { lines }, times, booking, discount);
    const advance = (await receiptsOf(db, business, booking.id)).filter((r) => r.purpose === 'advance').reduce((s, r) => s + money.paise(r.amount), 0);
    if (advance > priced.figures.total) fail(`${money.rupees(advance)} was taken as an advance: the hire cannot come to less than that`, 409);
    if (out) {
      // Every line (a kit's parts too) is the one booked: priced again at its booked rates.
      for (const p of priced.flat) {
        await db.query(`UPDATE rental_booking_lines SET charged_hours=$3,months=$4,weeks=$5,days=$6,hours=$7,price=$8,amount=$9,tax_rate=$10,net=$11,tax=$12,discount=$13
          WHERE business_id=$1 AND id=$2`, [business.id, p.kept.id, p.hours, p.best.months, p.best.weeks, p.best.days, p.best.hours, money.rupees(p.best.price), money.rupees(p.amount),
          p.taxRate.toFixed(2), money.rupees(p.net), money.rupees(p.tax), money.rupees(p.discount)]);
      }
    } else {
      await db.query('DELETE FROM rental_booking_lines WHERE business_id=$1 AND booking_id=$2', [business.id, booking.id]);
      await insertLines(db, business, booking, priced);
    }
    const f = priced.figures;
    await db.query(`UPDATE rental_bookings SET out_at=$3,due_at=$4,subtotal=$5,tax=$6,round_off=$7,total=$8,deposit_due=$9,notes=$10,updated_by=$11,updated_at=now(),
        discount_percent=$12,discount_reason=$13,discount_by=$14 WHERE business_id=$1 AND id=$2`,
      [business.id, booking.id, times.outAt, times.dueAt, money.rupees(f.subtotal), money.rupees(f.tax), money.rupees(f.roundOff), money.rupees(f.total), money.rupees(priced.deposit), notes, user.id,
        discount ? discount.percent.toFixed(2) : '0', discount?.reason || null, discount ? (discountChanged ? user.id : booking.discount_by) : null]);
    if (['reserved', 'out'].includes(booking.status)) await db.query('SELECT rental_check_booking($1,$2)', [business.id, booking.id]);
    const said = [+times.outAt !== +booking.out_at ? `out from ${c.timeWords(times.outAt, business.timezone)}` : null,
      +times.dueAt !== +booking.due_at ? `due back ${c.timeWords(times.dueAt, business.timezone)}` : null, body.lines !== undefined ? 'what is hired changed' : null,
      discountChanged ? (discount ? `${discount.percent}% off the hire: ${discount.reason}` : 'discount taken off') : null, notes !== booking.notes ? 'notes changed' : null].filter(Boolean);
    await history(db, business, user, booking, null, null, `${out && +times.dueAt > +booking.due_at ? 'Extended' : 'Changed'}: ${c.listWords(said) || 'priced again'}`);
    const details = { bookingNo: booking.booking_no, outAt: { from: booking.out_at, to: times.outAt }, dueAt: { from: booking.due_at, to: times.dueAt },
      total: { from: booking.total, to: money.rupees(f.total) }, depositDue: { from: booking.deposit_due, to: money.rupees(priced.deposit) }, linesChanged: body.lines !== undefined,
      ...(discountChanged ? { discount: { from: { percent: booking.discount_percent, reason: booking.discount_reason }, to: discount } } : {}) };
    await repo.audit(db, business.id, user.id, 'rental_booking.changed', booking.id, details);
    await repo.event(db, business.id, user.id, 'rental_booking.changed', 'rental_booking', booking.id, details);
    return shape(business, await load(db, business, booking.id));
  });
}

// A quote reserved: it holds what it books from now on (refused when something is not free).
async function confirm(business, user, bookingId) {
  c.requireRentals(business);
  await access.require(business, 'rentals.create');
  return repo.transaction(async (db) => {
    const booking = await lockBooking(db, business, bookingId);
    if (booking.status === 'reserved') return shape(business, await load(db, business, booking.id));
    if (booking.status !== 'quote') fail(`Booking ${booking.booking_no} is ${booking.status}: only a quote is reserved`, 409);
    const start = await repo.one(db, `SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS at`, [business.timezone || 'Asia/Kolkata']);
    if (booking.out_at < start.at) fail(`Quote ${booking.booking_no} was to go out on a day that has passed: change its times first`, 409);
    await db.query("UPDATE rental_bookings SET status='reserved',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, booking.id, user.id]);
    await db.query('SELECT rental_check_booking($1,$2)', [business.id, booking.id]);
    await history(db, business, user, booking, 'quote', 'reserved', 'Reserved from the quote');
    await repo.audit(db, business.id, user.id, 'rental_booking.reserved', booking.id, { bookingNo: booking.booking_no });
    await repo.event(db, business.id, user.id, 'rental_booking.reserved', 'rental_booking', booking.id, { bookingNo: booking.booking_no, outAt: booking.out_at, dueAt: booking.due_at });
    return shape(business, await load(db, business, booking.id));
  });
}

// body: { requestKey, purpose: advance | deposit, amount, method | methodId, reference? } — while the booking is reserved or out.
async function receive(business, user, bookingId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  await access.require(business, 'sales.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, bookingId: String(bookingId) });
  const purpose = v.requiredEnum(body.purpose, 'Taken as', ['advance', 'deposit']);
  return repo.transaction(async (db) => {
    const booking = await lockBooking(db, business, bookingId);
    const old = await repo.one(db, 'SELECT id,request_hash FROM business_collections WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, booking.id));
    }
    if (!['reserved', 'out'].includes(booking.status)) fail(`Booking ${booking.booking_no} is ${booking.status}: money is taken for it while it is reserved or out`, 409);
    const taken = await readMoney(db, business, { amount: body.amount, method: body.method, methodId: body.methodId, reference: body.reference }, purpose === 'deposit' ? 'Deposit' : 'Advance');
    if (!taken) fail('Give the amount taken');
    if (purpose === 'advance') {
      const advances = (await receiptsOf(db, business, booking.id)).filter((r) => r.purpose === 'advance').reduce((s, r) => s + money.paise(r.amount), 0);
      if (advances + taken.amount > money.paise(booking.total)) fail(`The advance is part of the hire: at most ${money.rupees(Math.max(0, money.paise(booking.total) - advances))} more`);
    }
    await takeReceipt(db, business, user, booking, { purpose, ...taken, requestKey, hash });
    return shape(business, await load(db, business, booking.id));
  });
}

// A value of the booking's bill: so many of a line's item's hire service at a
// value (paise, in the booking's price terms) with GST at the item's rate now,
// and its words for the bill.
function billValue(booking, line, { amount, quantity = 1, words }) {
  const unit = line.unit_label ? (line.serial_no ? `${line.unit_label} (${line.serial_no})` : line.unit_label) : null;
  const what = unit ? `${line.item_name} · ${unit}` : quantity === 1 ? line.item_name : `${quantity} × ${line.item_name}`;
  return { skuId: line.sku_id, quantity, ...money.today(amount, line.tax_rate_now, booking.tax_mode), label: [words, what].filter(Boolean).join(' · ') };
}

// What the bill of these values asks to be paid now, after what is held for
// the booking: the parts as typed ("full": all that is left), or refused when
// they come to more. `figures` are the bill's.
function partsAfterHeld(parts, figures, held) {
  const due = Math.max(0, figures.total - held);
  const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((s, p) => s + money.paise(p.amount), 0);
  if (fixedPaid > due) fail(`Only ${money.rupees(due)} is left to pay on this bill${held ? ' after the money held for the booking' : ''}`);
  return parts.map((p) => (p.amount === 'full' ? { ...p, amount: Number(money.rupees(due - fixedPaid)) } : p)).filter((p) => money.paise(p.amount) > 0);
}

// The booking's bill (a core sale) of these values, one line each, at their
// fixed prices: paid by what is taken now, then by the booking's advances and
// deposits (a deposit becomes part of the payment when it pays the bill).
// Inside the caller's transaction. Returns { document, used, lineIds (in the
// order of the values), figures }.
async function postBill(db, business, user, booking, { values, parts, buyer, key, hash }) {
  const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const billLines = money.billLines(values, settings?.tax_mode || 'exclusive');
  const figures = money.billFigures(values, settings?.rounding);
  const held = (await receiptsOf(db, business, booking.id)).reduce((s, r) => s + Math.max(0, money.paise(r.free)), 0);
  const paidNow = partsAfterHeld(parts, figures, held);
  const documentBody = { kind: 'sale', locationId: booking.location_id, contactId: booking.contact_id, lines: billLines.map((l) => l.input),
    notes: `Rental ${booking.booking_no} · ${periodOf(booking, business.timezone)}`.slice(0, 500), buyer: { pan: buyer?.pan, panDeclaration: buyer?.panDeclaration } };
  const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(key, 'bill'), hash, lines: documentBody.lines, paidNow,
    fixed: billLines.map((l) => l.fixed), rental: true });
  if (money.paise(document.total) !== figures.total) fail(`The bill would come to ${document.total}, not the ${money.rupees(figures.total)} worked out for the booking. Try again.`, 409);
  const lineIds = (await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id])).map((r) => r.id);
  if (lineIds.length !== billLines.length) fail('The bill does not have a line for each charge. Try again.', 409);
  const locked = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, document.id]);
  const used = await applyReceipts(db, business, user, booking, locked, key);
  return { document, used, lineIds, figures };
}

// The cancellation charge of a reserved booking worked out from the shop's
// slabs: the hours left before its out time (less than nothing once it has
// passed: a no-show), the slab they fall in (the one with the most hours that
// they reach; a no-show at the no-show percent, or the slab from 0 hours), and
// that share of each billed line's hire as booked (less its discount), in the
// booking's price terms. null when the shop has no slabs, or for a quote.
async function workOut(db, business, booking, lines, settings) {
  if (booking.status !== 'reserved' || !settings.cancel_slabs) return null;
  const now = (await repo.one(db, 'SELECT now() AS now')).now;
  const left = booking.out_at - now;
  const hoursBefore = Math.round(left / 36000) / 100;
  const slabs = [...settings.cancel_slabs].sort((a, b) => Number(b.hours) - Number(a.hours));
  const reached = slabs.find((s) => left >= Number(s.hours) * 3600000) || null;
  const zero = slabs.find((s) => Number(s.hours) === 0) || null;
  const noShow = left < 0;
  const percent = noShow ? Number(settings.no_show_percent ?? zero?.percent ?? 0) : Number(reached?.percent ?? 0);
  const charges = lines.filter((l) => l.billed).map((l) => ({ lineId: Number(l.id), amount: money.percentOf(money.paise(l.amount) - money.paise(l.discount), percent),
    note: `${percent}% of the hire`, line: l })).filter((x) => x.amount > 0);
  return { hoursBefore, percent, noShow, slab: noShow ? null : reached, charges, total: charges.reduce((s, x) => s + x.amount, 0) };
}

const cancelLines = (db, business, booking) => repo.all(db, `SELECT l.*,s.tax_rate AS tax_rate_now FROM rental_booking_lines l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
  WHERE l.business_id=$1 AND l.booking_id=$2 ORDER BY l.seq`, [business.id, booking.id]);

// What cancelling a booking now would charge, nothing saved: the charge worked out from the slabs (each line's share, and the bill
// with its GST), and what is held for the booking that pays it first.
async function cancelPreview(business, bookingId) {
  c.requireRentals(business);
  await access.require(business, 'rentals.cancel');
  const db = repo.pool;
  const booking = await repo.one(db, 'SELECT * FROM rental_bookings WHERE business_id=$1 AND id=$2', [business.id, id(bookingId, 'Booking')]);
  if (!booking) fail('Booking not found', 404);
  access.requireLocation(business, booking.location_id);
  if (!['quote', 'reserved'].includes(booking.status)) fail(`Booking ${booking.booking_no} is ${booking.status}: only a quote or a reserved booking is cancelled`, 409);
  const settings = await c.settingsOf(db, business.id);
  const worked = await workOut(db, business, booking, await cancelLines(db, business, booking), settings);
  const held = (await receiptsOf(db, business, booking.id)).reduce((s, r) => s + Math.max(0, money.paise(r.free)), 0);
  if (!worked) return { slabs: Boolean(settings.cancel_slabs), worked: false, held: money.rupees(held) };
  const values = worked.charges.map((x) => billValue(booking, x.line, { amount: x.amount, words: c.CHARGE_WORDS.cancellation }));
  const store = await repo.one(db, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const figures = money.billFigures(values, store?.rounding);
  const text = { slabs: true, worked: true, hoursBefore: worked.hoursBefore, percent: worked.percent.toFixed(2), noShow: worked.noShow,
    lines: worked.charges.map((x) => ({ lineId: x.lineId, itemName: x.line.item_name, unitLabel: x.line.unit_label, amount: money.rupees(x.amount) })),
    charge: money.rupees(worked.total), ...money.figuresText(figures), held: money.rupees(held), toPay: money.rupees(Math.max(0, figures.total - held)),
    back: money.rupees(Math.max(0, held - figures.total)) };
  return c.seesMoney(business) ? text : { slabs: true, worked: true, hoursBefore: text.hoursBefore, percent: text.percent, noShow: text.noShow };
}

// body: { requestKey, reason, charges?: [{ lineId, amount, note? }] (a cancellation charge typed, when the shop has no slabs), waive?: { reason, approverId?, pin? }
//   (a manager waives the charge worked out from the slabs), payment? | payments? (the rest of that bill), refund?: { method | methodId, reference? } (what is left of the
//   advance and deposit, handed back), approval?: { approverId?, pin? } (with a refund), buyer? }
async function cancel(business, user, bookingId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.cancel');
  const requestKey = core.uuid(body.requestKey);
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  const list = body.charges === undefined || body.charges === null ? [] : v.requiredArray(body.charges, 'Cancellation charges');
  const typed = list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Charge ${index + 1} must be an object`);
    const amount = core.decimal(raw.amount ?? 0, `Charge ${index + 1}`, 2, 0, 10000000);
    return { lineId: id(raw.lineId, `Charge ${index + 1}: line`), amount: money.paise(amount), note: c.optionalText(raw.note, `Charge ${index + 1}: note`, 300) };
  }).filter((x) => x.amount > 0);
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const how = body.refund ? readBack(body.refund) : null;
  if (how) await access.require(business, 'rentals.refund');
  // A manager's PIN is checked before the transaction (a PIN check holds no locks).
  const approval = how ? await pins().readApproval(business, user, { ...(body.approval || {}), reason: `Booking cancelled: ${reason}`.slice(0, 300) }, 'rentals.refund', { reasonLabel: 'Reason' }) : null;
  const waiver = body.waive && c.given(body.waive.reason)
    ? await pins().readApproval(business, user, body.waive, 'rentals.approve', { reasonLabel: 'Why the cancellation charge is waived', selfWithoutPin: true }) : null;
  const hash = c.hashOf({ ...body, approval: undefined, waive: body.waive ? { reason: body.waive.reason, approverId: body.waive.approverId } : undefined, bookingId: String(bookingId) });
  return repo.transaction(async (db) => {
    const booking = await lockBooking(db, business, bookingId);
    if (booking.cancel_key) {
      if (booking.cancel_key !== requestKey || booking.cancel_hash !== hash) fail(`Booking ${booking.booking_no} is cancelled already`, 409);
      return shape(business, await load(db, business, booking.id));
    }
    if (!['quote', 'reserved'].includes(booking.status)) fail(`Booking ${booking.booking_no} is ${booking.status}: ${booking.status === 'out' ? 'what is out comes back first' : 'it no longer changes'}`, 409);
    const lines = await cancelLines(db, business, booking);
    // With the shop's slabs, the charge of a reserved booking is worked out, never typed; a manager may waive it.
    const worked = await workOut(db, business, booking, lines, await c.settingsOf(db, business.id));
    if (worked && typed.length) fail('The cancellation charge is worked out from the shop\'s cancellation slabs: it is not typed. A manager may waive it.', 409);
    if (waiver && !worked?.total) fail('There is no cancellation charge worked out to waive', 409);
    const charges = worked ? (waiver ? [] : worked.charges) : typed;
    if (charges.length) await access.require(business, 'sales.create');
    for (const charge of charges) if (!lines.some((l) => Number(l.id) === charge.lineId)) fail(`That line is not on booking ${booking.booking_no}`, 404);
    if (parts.length && !charges.length) fail('A payment goes with a cancellation charge: there is nothing else to pay');
    // What the shop keeps is billed with its GST, each charge at its line's item's slab; the advance and deposit pay it first.
    const values = charges.map((charge) => billValue(booking, lines.find((l) => Number(l.id) === charge.lineId),
      { amount: charge.amount, words: [c.CHARGE_WORDS.cancellation, charge.note].filter(Boolean).join(' · ') }));
    const bill = values.length ? await postBill(db, business, user, booking, { values, parts, buyer: body.buyer, key: requestKey, hash }) : null;
    for (const [index, charge] of charges.entries()) {
      await db.query("INSERT INTO rental_charges(business_id,booking_id,booking_line_id,kind,amount,note,line_id,created_by) VALUES($1,$2,$3,'cancellation',$4,$5,$6,$7)",
        [business.id, booking.id, charge.lineId, money.rupees(charge.amount), charge.note, bill.lineIds[index], user.id]);
    }
    await db.query(`UPDATE rental_bookings SET status='cancelled',cancelled_at=now(),cancelled_by=$3,cancel_reason=$4,cancel_key=$5,cancel_hash=$6,document_id=$7,updated_by=$3,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, booking.id, user.id, reason, requestKey, hash, bill?.document.id || null]);
    if (worked) {
      await db.query(`INSERT INTO rental_cancellations(business_id,booking_id,hours_before,percent,worked_out,charged,waived_by,waiver,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [business.id, booking.id, worked.hoursBefore.toFixed(2), worked.percent.toFixed(2), money.rupees(worked.total), money.rupees(waiver ? 0 : worked.total),
          waiver ? waiver.approver.id : null, waiver ? waiver.reason : null, user.id]);
    }
    const back = how ? await refundLeft(db, business, user, booking, { purposes: ['deposit', 'advance'], how, approval, key: requestKey }) : [];
    const slabWords = worked ? `${worked.noShow ? 'a no-show' : `${worked.hoursBefore} hours before the out time`}: ${worked.percent}% of the hire, ${money.rupees(worked.total)}` : null;
    await history(db, business, user, booking, booking.status, 'cancelled', [reason, slabWords, waiver ? `the charge waived by ${waiver.approver.name}: ${waiver.reason}` : null,
      bill ? `cancellation charge billed (${bill.document.document_no})` : null,
      back.length ? `${money.rupees(back.reduce((s, r) => s + money.paise(r.amount), 0))} handed back (${back.map((r) => r.refund_no).join(', ')})` : null].filter(Boolean).join(' · '));
    const details = { bookingNo: booking.booking_no, reason, documentNo: bill?.document.document_no || null, charged: bill ? bill.document.total : null,
      refunded: back.map((r) => ({ refundNo: r.refund_no, amount: r.amount, purpose: r.purpose })), ...(approval ? { approvedBy: approval.approver.name } : {}),
      ...(worked ? { workedOut: { hoursBefore: worked.hoursBefore, percent: worked.percent, amount: money.rupees(worked.total), noShow: worked.noShow } } : {}) };
    await repo.audit(db, business.id, approval?.approver.id || user.id, 'rental_booking.cancelled', booking.id, details);
    if (waiver) {
      await repo.audit(db, business.id, waiver.approver.id, 'rental_booking.cancellation_waived', booking.id, { bookingNo: booking.booking_no, amount: money.rupees(worked.total),
        percent: worked.percent, reason: waiver.reason, by: user.id });
    }
    await repo.event(db, business.id, user.id, 'rental_booking.cancelled', 'rental_booking', booking.id, { ...details, documentId: bill?.document.id || null });
    return shape(business, await load(db, business, booking.id));
  });
}

// What is left of the advances and deposits of a booking that is back or
// cancelled, handed back (deposits first) by cash, UPI or bank, with a reason
// and a manager's PIN (rentals.refund): a numbered refund of each receipt.
// body: { requestKey, amount? (all that is left), method | methodId, reference?, reason, approverId?, pin? }
async function refundHeld(business, user, bookingId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.refund');
  const requestKey = core.uuid(body.requestKey);
  const amount = c.given(body.amount) ? money.paise(core.decimal(body.amount, 'Amount to hand back', 2, 0.01, 10000000)) : null;
  const how = readBack(body);
  const approval = await pins().readApproval(business, user, body, 'rentals.refund', { reasonLabel: 'Reason for handing it back' });
  return repo.transaction(async (db) => {
    const booking = await lockBooking(db, business, bookingId);
    if (!['returned', 'cancelled'].includes(booking.status)) {
      fail(`Booking ${booking.booking_no} is ${booking.status}: its deposit and advance are held until it is back (or cancelled), and then pay its bill first`, 409);
    }
    const made = await refundLeft(db, business, user, booking, { purposes: ['deposit', 'advance'], amount, how, approval, key: requestKey });
    if (!made.length) fail(`Nothing is held for booking ${booking.booking_no} to hand back`, 409);
    const fresh = made.filter((r) => !r.repeated);
    if (fresh.length) {
      await history(db, business, user, booking, null, null, `${money.rupees(fresh.reduce((s, r) => s + money.paise(r.amount), 0))} handed back (${fresh.map((r) => r.refund_no).join(', ')}) — ${approval.reason}`);
    }
    return { refunds: made, repeated: !fresh.length, booking: shape(business, await load(db, business, booking.id)) };
  });
}

// --- Reading a booking -----------------------------------------------------------------------------

async function load(db, business, bookingId) {
  const b = await repo.one(db, `SELECT b.*,l.name AS location_name,to_jsonb(l) AS location,cu.name AS created_by_name,co.name AS checked_out_by_name,
      dw.name AS deposit_waived_by_name,ca.name AS cancelled_by_name,dg.name AS discount_by_name,d.document_no,ct.credit_days,ct.credit_limit,ct.address AS contact_address,
      (now() AT TIME ZONE z.timezone)::date::text AS today,(b.status='out' AND b.due_at<now()) AS overdue,
      GREATEST(0,floor(EXTRACT(EPOCH FROM (now()-b.due_at))/60))::int AS late_minutes
    FROM rental_bookings b JOIN businesses z ON z.id=b.business_id JOIN business_locations l ON l.business_id=b.business_id AND l.id=b.location_id
    JOIN users cu ON cu.id=b.created_by LEFT JOIN users co ON co.id=b.checked_out_by LEFT JOIN users dw ON dw.id=b.deposit_waived_by LEFT JOIN users ca ON ca.id=b.cancelled_by
    LEFT JOIN users dg ON dg.id=b.discount_by
    LEFT JOIN business_documents d ON d.business_id=b.business_id AND d.id=b.document_id JOIN business_contacts ct ON ct.business_id=b.business_id AND ct.id=b.contact_id
    WHERE b.business_id=$1 AND b.id=$2`, [business.id, bookingId]);
  if (!b) fail('Booking not found', 404);
  access.requireLocation(business, b.location_id);
  // One query at a time: `db` may be a transaction's own client.
  const lines = await repo.all(db, `SELECT l.*,i.kind,i.vehicle,i.with_driver,i.meter,i.kit_billing,u.status AS unit_status,u.status_note AS unit_status_note,u.meter_reading AS unit_meter,
      u.vehicle_class,u.location_id AS unit_location_id,u.rc_valid_until,u.permit_valid_until,u.insurance_valid_until,u.puc_valid_until,u.fitness_valid_until,
      COALESCE(k.checklist,'{}') AS checklist,k.name AS class_name,
      s.tax_rate AS tax_rate_now,COALESCE(x.back,0)::int AS back,COALESCE(x.missing,0)::int AS missing,dl.document_id AS line_document_id
    FROM rental_booking_lines l JOIN rental_items i ON i.business_id=l.business_id AND i.id=l.item_id JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    LEFT JOIN rental_classes k ON k.business_id=i.business_id AND k.id=i.class_id
    LEFT JOIN rental_units u ON u.business_id=l.business_id AND u.id=l.unit_id LEFT JOIN business_document_lines dl ON dl.business_id=l.business_id AND dl.id=l.line_id
    LEFT JOIN LATERAL (SELECT sum(rl.quantity) AS back,sum(rl.missing) AS missing FROM rental_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id) x ON TRUE
    WHERE l.business_id=$1 AND l.booking_id=$2 ORDER BY l.seq`, [business.id, b.id]);
  const returns = await repo.all(db, `SELECT r.id,r.final,r.document_id,r.note,r.created_at,u.name AS by_name,
      COALESCE((SELECT json_agg(json_build_object('line_id',rl.line_id,'item_name',l.item_name,'unit_label',l.unit_label,'quantity',rl.quantity,'missing',rl.missing,'note',rl.note,
        'meter_in',rl.meter_in::text,'fuel_in',rl.fuel_in,'late_minutes',rl.late_minutes,'late_units',rl.late_units,'late_fee',rl.late_fee::text,'maintenance',rl.maintenance,
        'extra_km',rl.extra_km,'km_fee',rl.km_fee::text,'fuel_short',rl.fuel_short,'fuel_fee',rl.fuel_fee::text) ORDER BY l.seq)
        FROM rental_return_lines rl JOIN rental_booking_lines l ON l.business_id=rl.business_id AND l.id=rl.line_id WHERE rl.business_id=r.business_id AND rl.return_id=r.id),'[]') AS lines
    FROM rental_returns r JOIN users u ON u.id=r.created_by WHERE r.business_id=$1 AND r.booking_id=$2 ORDER BY r.id`, [business.id, b.id]);
  const charges = await repo.all(db, `SELECT ch.id,ch.return_id,ch.booking_line_id,ch.kind,ch.amount,ch.note,ch.line_id,ch.created_at,l.item_name,l.unit_label,u.name AS by_name
    FROM rental_charges ch JOIN rental_booking_lines l ON l.business_id=ch.business_id AND l.id=ch.booking_line_id JOIN users u ON u.id=ch.created_by
    WHERE ch.business_id=$1 AND ch.booking_id=$2 ORDER BY ch.id`, [business.id, b.id]);
  const receipts = await repo.all(db, `SELECT r.purpose,k.id,k.collection_no,k.amount,k.method,k.method_name,k.reference,k.created_at,${c.FREE_SQL('k')} AS free,
      COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0) AS used,
      COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),0) AS refunded,
      COALESCE((SELECT json_agg(json_build_object('id',f.id,'refund_no',f.refund_no,'amount',f.amount::text,'method',f.method,'method_name',f.method_name,'reference',f.reference,
        'reason',f.reason,'created_at',f.created_at,'approved_by_name',a.name) ORDER BY f.id) FROM business_collection_refunds f JOIN users a ON a.id=f.approved_by
        WHERE f.business_id=k.business_id AND f.collection_id=k.id),'[]') AS refunds
    FROM rental_receipts r JOIN business_collections k ON k.business_id=r.business_id AND k.id=r.collection_id WHERE r.business_id=$1 AND r.booking_id=$2 ORDER BY k.id`, [business.id, b.id]);
  const events = await repo.all(db, `SELECT e.id,e.from_status,e.to_status,e.note,e.created_at,u.name AS by_name FROM rental_booking_events e JOIN users u ON u.id=e.created_by
    WHERE e.business_id=$1 AND e.booking_id=$2 ORDER BY e.id`, [business.id, b.id]);
  const bill = b.document_id ? await repo.one(db, `SELECT d.id,d.document_no,d.total,d.created_at,
      COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned,
      COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0) AS paid,
      COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS refunded,${c.DUE_SQL('d')} AS due
    FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, b.document_id]) : null;
  const hirer = await repo.one(db, `SELECT h.*,rb.name AS original_returned_by_name FROM rental_hirers h LEFT JOIN users rb ON rb.id=h.original_returned_by
    WHERE h.business_id=$1 AND h.booking_id=$2`, [business.id, b.id]);
  const conditions = await repo.all(db, `SELECT x.id,x.line_id,x.stage,x.return_id,x.checks,x.created_at,u.name AS by_name FROM rental_conditions x JOIN users u ON u.id=x.created_by
    WHERE x.business_id=$1 AND x.booking_id=$2 ORDER BY x.id`, [business.id, b.id]);
  const files = await repo.all(db, `SELECT f.id,f.line_id,f.stage,f.kind,f.signer,f.file_name,f.mime_type,f.created_at,u.name AS by_name FROM rental_files f JOIN users u ON u.id=f.created_by
    WHERE f.business_id=$1 AND f.booking_id=$2 ORDER BY f.id`, [business.id, b.id]);
  const cancellation = await repo.one(db, `SELECT x.hours_before,x.percent,x.worked_out,x.charged,x.waiver,x.created_at,w.name AS waived_by_name FROM rental_cancellations x
    LEFT JOIN users w ON w.id=x.waived_by WHERE x.business_id=$1 AND x.booking_id=$2`, [business.id, b.id]);
  const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const rental = await c.settingsOf(db, business.id);
  const sum = (list, key) => list.reduce((s, x) => s + money.paise(x[key]), 0);
  const of = (purpose) => receipts.filter((r) => r.purpose === purpose);
  const deposit = { collected: money.rupees(sum(of('deposit'), 'amount')), applied: money.rupees(sum(of('deposit'), 'used')), refunded: money.rupees(sum(of('deposit'), 'refunded')),
    held: money.rupees(sum(of('deposit'), 'free')), due: b.deposit_due };
  const advance = { taken: money.rupees(sum(of('advance'), 'amount')), applied: money.rupees(sum(of('advance'), 'used')), refunded: money.rupees(sum(of('advance'), 'refunded')),
    left: money.rupees(sum(of('advance'), 'free')) };
  // While it is out: the late fee so far on what is still out, and what the bill would come to if it all came back now
  // (kilometres and fuel are counted when they come back).
  let pending = null;
  if (b.status === 'out') {
    const values = [];
    let late = 0;
    for (const line of lines) {
      values.push({ ...money.today(money.paise(line.amount) - money.paise(line.discount), line.tax_rate_now, b.tax_mode) });
      const left = Number(line.quantity) - Number(line.back) - Number(line.missing);
      const fee = line.kind === 'kit' ? { units: 0, fee: 0 } : money.lateFee({ minutes: Number(b.late_minutes), grace: line.grace_minutes, per: line.late_per, rate: line.late_rate,
        quantity: left, slabs: line.late_slabs, cap: line.late_cap });
      line.late_fee_now = money.rupees(fee.fee);
      line.late_units_now = fee.units;
      late += fee.fee;
      if (fee.fee) values.push({ ...money.today(fee.fee, line.tax_rate_now, b.tax_mode) });
    }
    for (const rl of returns.flatMap((r) => r.lines)) {
      const line = lines.find((l) => Number(l.id) === Number(rl.line_id));
      for (const key of ['late_fee', 'km_fee', 'fuel_fee']) if (money.paise(rl[key]) > 0) values.push({ ...money.today(money.paise(rl[key]), line.tax_rate_now, b.tax_mode) });
    }
    for (const charge of charges) {
      const line = lines.find((l) => Number(l.id) === Number(charge.booking_line_id));
      values.push({ ...money.today(money.paise(charge.amount), line.tax_rate_now, b.tax_mode) });
    }
    const figures = money.billFigures(values, settings?.rounding);
    const held = sum(receipts, 'free');
    pending = { ...money.figuresText(figures), late_fee: money.rupees(late), held: money.rupees(held), to_pay: money.rupees(Math.max(0, figures.total - held)),
      back: money.rupees(Math.max(0, held - figures.total)) };
  }
  const paperState = (until) => (!until ? null : { until: String(until instanceof Date ? until.toISOString() : until).slice(0, 10),
    lapsed: String(until instanceof Date ? until.toISOString() : until).slice(0, 10) < b.today });
  const { request_hash: _hash, checkout_hash: _checkout, cancel_hash: _cancel, location, ...rest } = b;
  return {
    ...rest, period: periodOf(b, business.timezone),
    lines: lines.map((l) => ({ ...l, period: money.periodWords(l), left: l.kind === 'kit' ? 0 : Number(l.quantity) - Number(l.back) - Number(l.missing),
      papers: l.vehicle ? Object.fromEntries(Object.entries(c.PAPERS).map(([k, words]) => [k, paperState(l[k]) && { ...paperState(l[k]), words }]).filter(([, x]) => x)) : null })),
    returns, charges, receipts, deposit, advance_summary: advance, bill, events, pending, terms: rental.terms, id_required: rental.id_required, papers_lapsed: rental.papers_lapsed,
    hirer: hirer ? (({ business_id: _b, ...h }) => h)(hirer) : null, conditions, files, cancellation: cancellation || null, seller: core.branchSeller(settings, location),
    timezone: business.timezone,
  };
}

async function detail(business, bookingId) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  return shape(business, await load(repo.pool, business, id(bookingId, 'Booking')));
}

// --- The board, the day's picture and the bell -------------------------------------------------------

async function board(business) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  const counts = await repo.one(repo.pool, `SELECT count(*) FILTER (WHERE stage='quote')::int AS quote,count(*) FILTER (WHERE stage='reserved')::int AS reserved,
      count(*) FILTER (WHERE stage='out')::int AS out,count(*) FILTER (WHERE stage='due_today')::int AS due_today,count(*) FILTER (WHERE stage='overdue')::int AS overdue,
      count(*) FILTER (WHERE stage='to_settle')::int AS to_settle,count(*) FILTER (WHERE pickup_today)::int AS pickup_today,count(*) FILTER (WHERE late_pickup)::int AS late_pickup,
      count(*) FILTER (WHERE out_now)::int AS out_now,COALESCE(sum(deposit_held),0) AS deposits_held
    FROM (${BOOKINGS_SQL}) x WHERE ($2::bigint IS NULL OR x.location_id=$2)`, [business.id, business.location_scope || null]);
  const items = await repo.all(repo.pool, `SELECT * FROM (${BOOKINGS_SQL}) x WHERE x.open AND ($2::bigint IS NULL OR x.location_id=$2) ORDER BY ${BOARD_ORDER} LIMIT 300`,
    [business.id, business.location_scope || null]);
  return c.seesMoney(business) ? { counts, items } : { counts: { ...counts, deposits_held: null }, items: items.map(withoutMoney) };
}

// The bell: bookings out past their due time, and bookings that were to go out and are not handed over.
async function bell(business, base, limit) {
  const late = await repo.all(repo.pool, `SELECT id,booking_no,customer_name,due_at,updated_at FROM (${BOOKINGS_SQL}) x WHERE x.overdue AND ($3::bigint IS NULL OR x.location_id=$3)
    ORDER BY x.due_at,x.id LIMIT $2`, [business.id, limit, business.location_scope || null]);
  const items = late.map((b) => ({ id: `rental:${b.id}:late:${new Date(b.due_at).toISOString()}`, severity: 'warning', category: 'Bookings', title: `${b.booking_no} is past its due back time`,
    detail: `${b.customer_name} · due back ${c.timeWords(b.due_at, business.timezone)}`, at: new Date(b.due_at).toISOString(), link: `${base}/rental-bookings/${b.id}` }));
  const waiting = await repo.one(repo.pool, `SELECT count(*)::int AS n,min(out_at) AS first FROM (${BOOKINGS_SQL}) x WHERE x.late_pickup AND ($2::bigint IS NULL OR x.location_id=$2)`,
    [business.id, business.location_scope || null]);
  if (waiting.n > 0) {
    items.push({ id: `rental:pickup:${waiting.n}:${new Date(waiting.first).toISOString()}`, severity: 'info', category: 'Bookings',
      title: `${c.plural(waiting.n, 'booking')} past its out time and not handed over`, detail: 'Hand it over, change its times, or cancel it, on Bookings',
      at: new Date(waiting.first).toISOString(), link: `${base}/rental-bookings` });
  }
  // The fleet: papers running out and services due.
  items.push(...await require('./rentalsYard.service').bell(business, base, limit));
  return items;
}

// A unit's barcode or serial as scanned (a keyboard-wedge scanner types it and Enter): the unit's line on the booking.
// stage out: a line of the booking; in: a line still out. A unit not on the booking is refused.
const scanCode = (value) => String(value ?? '').toUpperCase().replace(/\s+/g, '');
// Codes are compared in letters and digits only ("gs 101" is GS-101).
const bare = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function findScan(booking, lines, code, stage) {
  const plain = bare(code);
  const line = lines.find((l) => l.unit_id && plain && (bare(l.serial_no) === plain || bare(l.unit_label) === plain));
  if (!line) fail(`${code} is not on booking ${booking.booking_no}: put it aside`, 409);
  if (stage === 'in' && Number(line.quantity) - Number(line.back || 0) - Number(line.missing || 0) <= 0) fail(`${line.unit_label} is back already on booking ${booking.booking_no}`, 409);
  return line;
}
async function scanLines(db, business, booking) {
  return repo.all(db, `SELECT l.*,COALESCE((SELECT sum(rl.quantity) FROM rental_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0)::int AS back,
      COALESCE((SELECT sum(rl.missing) FROM rental_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0)::int AS missing
    FROM rental_booking_lines l WHERE l.business_id=$1 AND l.booking_id=$2 ORDER BY l.seq`, [business.id, booking.id]);
}
// Codes scanned with a handover or a return, checked: each a unit on the booking (still out, for a return). Returns the codes, or [].
async function checkScans(db, business, booking, value, stage) {
  if (value === undefined || value === null) return [];
  const codes = [...new Set(v.requiredArray(value, 'Scanned').map(scanCode).filter(Boolean))];
  if (codes.length > 200) fail('Scan at most 200 units at once');
  const lines = await scanLines(db, business, booking);
  for (const code of codes) findScan(booking, lines, code, stage);
  return codes;
}

// body: { code, stage?: out | in } — which line of the booking a scanned unit is (rentals.edit).
async function scan(business, bookingId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  const code = scanCode(body.code);
  if (!code) fail('Scan the unit\'s barcode, or type its number');
  const stage = body.stage === undefined ? 'out' : v.requiredEnum(body.stage, 'Scanned at', ['out', 'in']);
  const booking = await repo.one(repo.pool, 'SELECT * FROM rental_bookings WHERE business_id=$1 AND id=$2', [business.id, id(bookingId, 'Booking')]);
  if (!booking) fail('Booking not found', 404);
  access.requireLocation(business, booking.location_id);
  const line = findScan(booking, await scanLines(repo.pool, business, booking), code, stage);
  return { code, lineId: line.id, itemName: line.item_name, unitLabel: line.unit_label, serialNo: line.serial_no };
}

// The original document held at the handover, handed back to the hirer (rentals.edit): once.
async function originalBack(business, user, bookingId) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  return repo.transaction(async (db) => {
    const booking = await lockBooking(db, business, bookingId);
    const hirer = await repo.one(db, 'SELECT * FROM rental_hirers WHERE business_id=$1 AND booking_id=$2 FOR UPDATE', [business.id, booking.id]);
    if (!hirer?.original_held) fail(`No original document was held for booking ${booking.booking_no}`, 409);
    if (!hirer.original_returned_at) {
      await db.query('UPDATE rental_hirers SET original_returned_at=now(),original_returned_by=$3 WHERE business_id=$1 AND booking_id=$2', [business.id, booking.id, user.id]);
      await history(db, business, user, booking, null, null, `Original ${hirer.original_held} handed back to the hirer`);
      await repo.audit(db, business.id, user.id, 'rental_booking.original_returned', booking.id, { bookingNo: booking.booking_no, document: hirer.original_held });
    }
    return shape(business, await load(db, business, booking.id));
  });
}

// The receipts a hirer's bookings hold (advances and deposits): they pay only
// their booking's bill, and what is left goes back from the booking, so
// "apply advance" in the customer's dues leaves them alone.
async function heldReceipts(db, business, contactId) {
  const rows = await repo.all(db, `SELECT r.collection_id FROM rental_receipts r JOIN business_collections k ON k.business_id=r.business_id AND k.id=r.collection_id
    WHERE r.business_id=$1 AND k.contact_id=$2`, [business.id, contactId]);
  return new Set(rows.map((r) => Number(r.collection_id)));
}

// Who may approve: a deposit taken below the one asked (rentals.approve), money
// handed back (rentals.refund). Members whose role holds it, with whether they have a PIN
// and whether someone else set it (pin_given: it approves nothing until they choose their own).
const APPROVALS = ['rentals.approve', 'rentals.refund'];
async function approvers(business, query = {}) {
  c.requireRentals(business);
  const permission = query.permission === undefined ? 'rentals.refund' : String(query.permission);
  if (!APPROVALS.includes(permission)) fail('Unknown approval');
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin,u.pin_must_change AS pin_given FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code=$2))
    ORDER BY u.name`, [business.id, permission]);
}

module.exports = { BOOKINGS_SQL, shape, listShape, withoutMoney, readLines, readTimes, priceBooking, availability, clashWords, preview, create, update, confirm, receive, cancel,
  cancelPreview, workOut, scan, checkScans, scanLines, scanCode, originalBack,
  refundHeld, load, detail, lockBooking, history, receiptsOf, applyReceipts, refundLeft, readBack, readMoney, takeReceipt, billValue, partsAfterHeld, postBill, periodOf, board, bell,
  heldReceipts, approvers };
