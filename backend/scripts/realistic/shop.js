// The counter of a shop, day by day: deliveries from suppliers in the morning,
// bills through the day (walk-ins and regulars, offers and points applied by
// the server, udhaar for regulars who keep an account), collections of udhaar,
// the odd return, supplier payments, and in the evening the reorder for the
// next delivery. Every posting goes through the app's services and is dated
// by the time machine to the moment it happens in the story.
//
// A business type adds its own steps through hooks (see the types/ folder).
const repo = require('../../src/modules/business/core/repositories/business.repository');
const service = require('../../src/modules/business/core/services/business.service');
const returns = require('../../src/modules/business/core/services/businessReturns.service');
const payables = require('../../src/modules/business/core/services/businessPayables.service');
const receivables = require('../../src/modules/business/wholesale/services/businessReceivables.service');
const customers = require('../../src/modules/business/retail/services/businessRetailCustomers.service');
const offers = require('../../src/modules/business/retail/services/businessOffers');
const clock = require('./clock');
const machine = require('./machine');
const base = require('./base');

const db = repo.pool;
const round3 = (n) => Math.round(n * 1000) / 1000;
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const qtyText = (n, decimals) => (decimals ? round3(n).toFixed(3) : String(Math.round(n)));

// --- The simulation's view of the shop -------------------------------------------------------

async function loadStock(sim) {
  sim.stock = new Map();
  const lots = await repo.all(db, `SELECT id,sku_id,lot_code,expires_on,quantity FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND quantity>0`,
    [sim.business.id, sim.location.id]);
  for (const lot of lots) lotsOf(sim, lot.sku_id).push({ id: lot.id, code: lot.lot_code, qty: Number(lot.quantity), expires: lot.expires_on, trueExpiry: lot.expires_on });
}
// One item's batches as they are now in the database.
async function reloadSku(sim, skuId) {
  const known = new Map(lotsOf(sim, skuId).map((l) => [Number(l.id), l]));
  const rows = await repo.all(db, 'SELECT id,lot_code,expires_on,quantity FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND quantity>0',
    [sim.business.id, sim.location.id, skuId]);
  sim.stock.set(Number(skuId), rows.map((lot) => ({ id: lot.id, code: lot.lot_code, qty: Number(lot.quantity), expires: lot.expires_on,
    trueExpiry: known.get(Number(lot.id))?.trueExpiry || lot.expires_on })));
}
function lotsOf(sim, skuId) {
  const k = Number(skuId);
  if (!sim.stock.has(k)) sim.stock.set(k, []);
  return sim.stock.get(k);
}
const onHand = (sim, skuId) => lotsOf(sim, skuId).reduce((s, l) => s + l.qty, 0);
// Batches that can be sold on the day (first to expire first).
function usableLots(sim, item, day) {
  return lotsOf(sim, item.id).filter((l) => l.qty > 0.0005 && (!l.trueExpiry || l.trueExpiry >= day) && (!l.expires || l.expires >= sim.realToday))
    .sort((a, b) => String(a.trueExpiry || '9999').localeCompare(String(b.trueExpiry || '9999')) || String(a.code).localeCompare(String(b.code)));
}

// Who does what at the counter: the cashier bills, the manager handles returns
// and the money, the stock keeper receives goods; the owner fills in.
function actor(sim, ...roles) {
  for (const role of roles) {
    const people = sim.staff.filter((s) => s.role === role);
    if (people.length) return people[sim.turn++ % people.length];
  }
  return { user: sim.owner, business: sim.business };
}

// Runs a posting once, dated `when`.
async function post(sim, table, step, when, run, options) {
  return base.once(sim.business.id, table, step, (requestKey) => machine.at(sim.business.id, when, () => run(requestKey), options));
}

// --- Purchases --------------------------------------------------------------------------------

const costOf = (sim, item) => {
  if (item.meta.cost) return Number(item.meta.cost);
  const exGst = sim.taxMode === 'inclusive' ? Number(item.price) / (1 + Number(item.tax_rate) / 100) : Number(item.price);
  return Math.round(exGst * (1 - (item.meta.margin ?? sim.def.margin ?? 0.15)) * 100) / 100;
};
const batchCode = (item, day, suffix = '') => `${item.meta.lotPrefix || item.code}-${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}${suffix}`;
const shelfLife = (item) => item.meta.shelf || 365;

// A supplier's delivery: lines [{ item, qty, lotCode?, expires? }].
async function receive(sim, day, minutes, supplier, lines, step, extra = {}) {
  if (!lines.length) return null;
  const who = actor(sim, 'stock_keeper', 'manager');
  const billNo = `${supplier.billPrefix}/${day.slice(5, 7)}${day.slice(8, 10)}${extra.billSuffix || ''}`;
  const input = lines.map((l) => {
    const line = { skuId: l.item.id, unitPrice: money(l.cost ?? costOf(sim, l.item)) };
    const pack = l.item.meta.pack;
    if (pack && !l.item.meta.loosePurchase && l.qty % pack[1] === 0 && l.qty >= pack[1] && l.item.tracking !== 'serial') {
      line.unit = pack[0]; line.quantity = String(l.qty / pack[1]); line.unitPrice = money((l.cost ?? costOf(sim, l.item)) * pack[1]);
    } else line.quantity = qtyText(l.qty, l.item.decimals);
    if (l.item.tracking === 'batch' || l.item.tracking === 'serial') line.lotCode = l.lotCode || batchCode(l.item, day);
    if (l.item.tracking === 'batch') {
      l.trueExpiry = l.expires || clock.addDays(day, shelfLife(l.item));
      // A batch already past its date today is received with today's date and
      // given its real one once the story has caught up (see fixExpiries).
      line.expiresOn = l.trueExpiry < sim.realToday ? sim.realToday : l.trueExpiry;
    }
    return { line, l };
  });
  const result = await post(sim, 'business_documents', step, clock.at(day, minutes), (requestKey) => service.document(who.business, who.user, {
    kind: 'purchase', locationId: sim.location.id, contactId: supplier.contact.id, requestKey, lines: input.map((x) => x.line),
    supplierBillNo: billNo, supplierBillDate: sim.realToday, notes: extra.notes,
  }));
  if (result.created) {
    for (const { line, l } of input) {
      const lots = lotsOf(sim, l.item.id);
      const code = line.lotCode || '';
      const existing = lots.find((x) => x.code === code);
      const lot = await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND sku_id=$3 AND lot_code=$4', [sim.business.id, sim.location.id, l.item.id, code]);
      if (existing) existing.qty += l.qty;
      else lots.push({ id: lot.id, code, qty: l.qty, expires: line.expiresOn || null, trueExpiry: l.trueExpiry || null });
      if (l.trueExpiry && l.trueExpiry < sim.realToday) sim.expiryFixes.push({ lotId: lot.id, expires: l.trueExpiry });
    }
  }
  return result.row;
}

// Opening stock on the first day: every item to its target level.
async function openingStock(sim, day) {
  for (const supplier of sim.suppliers) {
    const lines = sim.items.filter((i) => i.kind === 'goods' && i.supplier === supplier && i.tracking !== 'serial' && !i.meta.noOpening)
      .map((item) => ({ item, qty: item.target }));
    await receive(sim, day, sim.def.open - 60, supplier, lines, `opening-${supplier.key}`, { notes: 'Stock in hand when the books started', billSuffix: '-OPN' });
  }
}

// Evening: what each supplier brings on its next visit.
function planReorders(sim, day) {
  const r = clock.rng(`${sim.code}|reorder|${day}`);
  for (const supplier of sim.suppliers) {
    if (sim.orders.has(supplier.key)) continue;
    const next = clock.addDays(day, supplier.lead || 1);
    if (supplier.days && !supplier.days.includes(clock.weekday(next))) continue;
    const lines = [];
    for (const item of sim.items) {
      if (item.supplier !== supplier || item.kind !== 'goods' || item.tracking === 'serial' || item.meta.noReorder) continue;
      // A few items run low in the last days (the supplier was short): today's low-stock list.
      if (sim.shortItems.has(item.id) && clock.daysBetween(day, sim.realToday) <= 5) continue;
      const have = onHand(sim, item.id);
      if (have > item.reorder) continue;
      let qty = item.target - have;
      const pack = item.meta.pack;
      if (pack) qty = Math.max(pack[1], Math.ceil(qty / pack[1]) * pack[1]);
      qty = item.decimals ? round3(Math.max(qty, 1)) : Math.max(1, Math.round(qty));
      lines.push({ item, qty: qty * (r.chance(0.15) ? 1.2 : 1) });
    }
    for (const l of lines) l.qty = l.item.decimals ? round3(l.qty) : Math.round(l.qty);
    if (lines.length) sim.orders.set(supplier.key, { arrive: next, lines });
  }
}
async function deliveries(sim, day) {
  for (const [keyName, order] of [...sim.orders]) {
    if (order.arrive !== day) continue;
    const supplier = sim.suppliers.find((s) => s.key === keyName);
    const r = clock.rng(`${sim.code}|delivery|${keyName}|${day}`);
    await receive(sim, day, sim.def.open + r.int(30, 150), supplier, order.lines, `purchase-${keyName}-${day}`);
    sim.orders.delete(keyName);
  }
}

// Money against a customer's or supplier's open documents, oldest first, as
// payments on each document (back-dated history). Receipts and supplier
// payment vouchers are append-only, so they are used for today only.
async function payOldest(sim, day, minutes, contactId, kind, amount, method, step, reference) {
  const open = await repo.all(db, `SELECT d.id,d.total
      -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
      -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
      +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS due
    FROM business_documents d WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind=$3 ORDER BY d.created_at,d.id`, [sim.business.id, contactId, kind]);
  let left = Math.round(amount * 100);
  const who = kind === 'purchase' ? actor(sim, 'accountant', 'manager') : actor(sim, 'cashier', 'manager');
  for (const doc of open) {
    const due = Math.round(Number(doc.due) * 100);
    if (due <= 0 || left <= 0) continue;
    const pay = Math.min(due, left);
    await post(sim, 'business_payments', `${step}-${doc.id}`, clock.at(day, minutes), (requestKey) => service.payment(who.business, who.user, doc.id,
      { amount: money(pay / 100), method, reference: reference || null, requestKey }));
    left -= pay;
  }
}

// Supplier bills are paid when due (one supplier usually a week late).
async function paySuppliers(sim, day) {
  for (const supplier of sim.suppliers) {
    const late = supplier.late || 0;
    const row = await repo.one(db, `SELECT COALESCE(sum(GREATEST(0,d.total
        -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)
        -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0))),0) AS due
      FROM business_documents d WHERE d.business_id=$1 AND d.kind='purchase' AND d.contact_id=$2 AND d.due_on <= $3::date`, [sim.business.id, supplier.contact.id, clock.addDays(day, -late)]);
    const due = Number(row.due);
    if (due < 1) continue;
    const r = clock.rng(`${sim.code}|supplier-pay|${supplier.key}|${day}`);
    // Small suppliers are paid on the spot in cash; the rest by bank transfer or cheque.
    const method = supplier.method || r.pick(['bank', 'bank', 'upi', 'cheque']);
    const reference = method === 'cheque' ? `CHQ ${r.int(100000, 999999)}` : method === 'cash' ? null : `UTR${r.int(10000000, 99999999)}`;
    const minutes = sim.def.open + r.int(60, 240);
    if (day < sim.realToday) {
      await payOldest(sim, day, minutes, supplier.contact.id, 'purchase', due, method, `supplier-pay-${supplier.key}-${day}`, reference);
      continue;
    }
    if (minutes > clock.minutesNow()) continue;
    const who = actor(sim, 'accountant', 'manager');
    await post(sim, 'business_supplier_payments', `supplier-pay-${supplier.key}-${day}`, clock.at(day, minutes), (requestKey) => payables.pay(who.business, who.user,
      supplier.contact.id, { locationId: sim.location.id, amount: money(due), method, reference, requestKey }));
  }
}

// --- Bills --------------------------------------------------------------------------------------

// When the bills of a day fall: a curve over the opening hours.
function billTimes(sim, day, count, r) {
  const curve = sim.def.curve; // [[hour, weight], …]
  const times = [];
  for (let n = 0; n < count; n += 1) {
    const [hour] = r.weighted(curve, (x) => x[1]);
    times.push(Math.min(sim.def.close - 5, Math.max(sim.def.open + 5, hour * 60 + r.int(0, 59))));
  }
  return times.sort((a, b) => a - b);
}

// A basket: a few items by popularity, each in a believable quantity.
function basket(sim, r, size) {
  const picks = [];
  const pool = sim.items.filter((i) => i.kind === 'goods' || sim.def.sellsServices);
  for (let n = 0; n < size * 3 && picks.length < size; n += 1) {
    const item = r.weighted(pool, (x) => x.meta.w ?? 1);
    if (!picks.includes(item)) picks.push(item);
  }
  return picks.map((item) => ({ item, qty: quantity(item, r) }));
}
function quantity(item, r) {
  const q = item.meta.q || (item.decimals ? [0.5, 2] : [1, 2]);
  if (Array.isArray(q[0]) || (typeof q[0] === 'number' && q.length > 2)) return r.pick(q);
  if (item.decimals) {
    const steps = r.pick([0.25, 0.5, 0.5, 1, 1, 1.5, 2]);
    return round3(Math.min(q[1], Math.max(q[0], steps * (q[1] / 2))));
  }
  return r.int(q[0], q[1]);
}

// Lines that the shelf can fill: batch items from the first batch to expire.
function fill(sim, wanted, day) {
  const lines = [];
  for (const { item, qty } of wanted) {
    if (item.kind === 'service') { lines.push({ item, qty, line: { skuId: item.id, quantity: String(qty) } }); continue; }
    if (item.tracking === 'serial') continue;
    if (item.tracking === 'batch') {
      const lots = usableLots(sim, item, day);
      const lot = lots.find((l) => l.qty >= qty) || lots[0];
      if (!lot) continue;
      const take = item.decimals ? round3(Math.min(qty, lot.qty)) : Math.min(qty, Math.floor(lot.qty));
      if (take <= 0) continue;
      lines.push({ item, qty: take, lot, line: { skuId: item.id, quantity: qtyText(take, item.decimals), lotCode: lot.code } });
    } else {
      const lot = lotsOf(sim, item.id).find((l) => l.code === '');
      const have = lot ? lot.qty : 0;
      const take = item.decimals ? round3(Math.min(qty, have)) : Math.min(qty, Math.floor(have));
      if (take <= 0) continue;
      lines.push({ item, qty: take, lot, line: { skuId: item.id, quantity: qtyText(take, item.decimals) } });
    }
  }
  return lines;
}
function takeStock(lines) {
  for (const l of lines) if (l.lot) l.lot.qty = round3(l.lot.qty - l.qty);
}
const methodOf = (sim, r) => r.weighted(Object.entries(sim.def.pay), (x) => x[1])[0];

// One bill. plan: { minutes, customer?, lines (filled), udhaar, method, step }.
async function bill(sim, day, plan) {
  const who = plan.actor || actor(sim, 'cashier', 'manager');
  const r = clock.rng(`${sim.code}|bill-pay|${plan.step}`);
  const body = { kind: 'sale', locationId: sim.location.id, contactId: plan.customer?.contact.id || null, lines: plan.lines.map((l) => l.line), ...plan.extra };
  // Round 2: a bill paid several ways (cash + UPI + card) brings its own parts.
  if (plan.payments) body.payments = plan.payments;
  else if (!plan.udhaar) body.payment = { amount: 'full', method: plan.method, ...(plan.method === 'upi' ? { reference: `UPI ${r.int(100000000, 999999999)}` } : {}) };
  else if (plan.partial) body.payment = { amount: money(plan.partial), method: plan.method };
  let result;
  try {
    result = await post(sim, 'business_documents', plan.step, clock.at(day, plan.minutes), (requestKey) => service.document(who.business, who.user, { ...body, requestKey }));
  } catch (error) {
    // Over the credit limit, or points no longer there: the customer pays in full instead.
    if (!/credit limit|points|redeem/i.test(error.message)) throw error;
    const { loyalty: _points, payments: _parts, ...rest } = body;
    result = await post(sim, 'business_documents', `${plan.step}-paid`, clock.at(day, plan.minutes), (requestKey) => service.document(who.business, who.user,
      { ...rest, payment: { amount: 'full', method: plan.method }, requestKey }));
  }
  if (result.created) {
    takeStock(plan.lines);
    sim.recent.push({ day, doc: result.row, plan });
    if (sim.recent.length > 400) sim.recent.shift();
  }
  return result;
}

// The day's bills, planned once per day (the same plan on a rerun).
function dayPlan(sim, day) {
  const r = clock.rng(`${sim.code}|bills|${day}`);
  const count = Math.round(sim.def.volume(day, r, sim) || 0);
  const times = billTimes(sim, day, count, r);
  return times.map((minutes, n) => {
    const rr = clock.rng(`${sim.code}|bill|${day}|${n}`);
    const regular = sim.regulars.length && rr.chance(sim.def.regularShare ?? 0.3) ? rr.weighted(sim.regulars, (c) => c.visits || 1) : null;
    return { n, minutes, regular, r: rr };
  });
}

async function sellDay(sim, day, limit) {
  const plan = dayPlan(sim, day);
  // Today, a shop that has been open a while has made a few bills already,
  // even when the day's curve puts most of them later.
  if (day === sim.realToday && limit > sim.def.open + 25) {
    const want = Math.min(3, plan.length);
    const before = plan.filter((p) => p.minutes <= limit).length;
    if (before < want) {
      const span = limit - 5 - (sim.def.open + 10);
      plan.slice(0, want).forEach((p, i) => { p.minutes = Math.round(sim.def.open + 10 + (span * (i + 1)) / (want + 1)); });
    }
  }
  for (const p of plan) {
    if (p.minutes > limit) break;
    const step = `sale-${day}-${p.n}`;
    if (sim.hooks.sale) { await sim.hooks.sale(sim, day, p, step); continue; }
    const size = sim.def.basketSize ? sim.def.basketSize(p.r, p.regular) : p.r.int(1, 4);
    const wanted = sim.hooks.basket ? sim.hooks.basket(sim, p.r, p.regular, day) : basket(sim, p.r, p.regular ? size + 2 : size);
    const lines = fill(sim, wanted, day);
    if (!lines.length) continue;
    if (sim.hooks.lines) sim.hooks.lines(lines, p.r);
    const method = methodOf(sim, p.r);
    const udhaar = Boolean(p.regular?.udhaar) && p.r.chance(p.regular.udhaarShare ?? 0.7);
    const extra = {};
    if (sim.def.loyalty && p.regular && p.r.chance(0.08)) {
      const balance = await offers.pointsBalance(db, sim.business.id, p.regular.contact.id);
      if (balance >= sim.def.loyalty.minRedeemPoints) extra.loyalty = { redeemPoints: String(Math.min(balance, sim.def.loyalty.minRedeemPoints * p.r.int(1, 2))) };
    }
    await bill(sim, day, { step, minutes: p.minutes, customer: p.regular, lines, udhaar, method: udhaar ? p.r.pick(['cash', 'upi']) : method, extra });
  }
}

// --- Udhaar ----------------------------------------------------------------------------------

// Regulars with an account pay in their own way: on time, late, or only bits
// now and then (the overdue ones on the reminder list).
async function collect(sim, day, limit) {
  const r = clock.rng(`${sim.code}|collect|${day}`);
  for (const c of sim.regulars.filter((x) => x.udhaar)) {
    const minutes = sim.def.open + 60 + r.int(0, Math.max(60, sim.def.close - sim.def.open - 120));
    if (minutes > limit) continue;
    const row = await repo.one(db, `SELECT ${repo.contactBalanceSql('c')} AS balance,
      (SELECT min(d.due_on)::text FROM business_documents d WHERE d.business_id=c.business_id AND d.contact_id=c.id AND d.kind='sale'
        AND d.total > COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
          + COALESCE((SELECT sum(x.total) FROM business_returns x WHERE x.business_id=d.business_id AND x.document_id=d.id),0)) AS oldest_due
      FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [sim.business.id, c.contact.id]);
    const balance = Number(row.balance);
    if (balance < 50 || !row.oldest_due) continue;
    const overdue = clock.daysBetween(row.oldest_due, day);
    let amount = 0;
    if (c.udhaar === 'ontime' && overdue >= -2 && r.chance(0.5)) amount = balance;
    else if (c.udhaar === 'late' && overdue >= 12 && r.chance(0.25)) amount = balance * r.pick([0.5, 0.6, 1]);
    else if (c.udhaar === 'chronic' && overdue >= 20 && r.chance(0.06)) amount = Math.min(balance, r.pick([500, 1000, 1500]));
    amount = amount >= balance - 0.005 ? Math.round(balance * 100) / 100 : Math.floor(amount / 10) * 10;
    if (amount < 10) continue;
    const method = r.pick(['cash', 'upi', 'upi']);
    if (day < sim.realToday) {
      await payOldest(sim, day, minutes, c.contact.id, 'sale', Math.min(amount, balance), method, `collect-${c.key}-${day}`, method === 'upi' ? `UPI ${r.int(100000000, 999999999)}` : null);
      continue;
    }
    const who = actor(sim, 'cashier', 'manager');
    await post(sim, 'business_collections', `collect-${c.key}-${day}`, clock.at(day, minutes), (requestKey) => receivables.createCollection(who.business, who.user, {
      locationId: sim.location.id, contactId: c.contact.id, amount: money(amount), method, requestKey,
      ...(method === 'upi' ? { reference: `UPI ${r.int(100000000, 999999999)}` } : {}), notes: amount < balance ? 'Part payment of the account' : 'Account settled' }));
  }
}

// Reminders for the late payers (WhatsApp, a call, a visit), with promises — some kept, some not.
async function remind(sim, day, limit) {
  if (!sim.business.modules.includes('receivables')) return;
  const r = clock.rng(`${sim.code}|remind|${day}`);
  for (const c of sim.regulars.filter((x) => x.udhaar === 'late' || x.udhaar === 'chronic')) {
    if (!r.chance(c.udhaar === 'chronic' ? 0.07 : 0.05)) continue;
    const minutes = sim.def.open + 120;
    if (minutes > limit) continue;
    const owes = await repo.one(db, `SELECT ${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [sim.business.id, c.contact.id]);
    if (Number(owes.balance) < 100) continue;
    // One reminder per customer per day (found again on a rerun by its day).
    if (await repo.one(db, `SELECT 1 FROM retail_credit_reminders WHERE business_id=$1 AND contact_id=$2 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=$3::date`,
      [sim.business.id, c.contact.id, day])) continue;
    const who = actor(sim, 'manager', 'cashier');
    const channel = r.pick(['whatsapp', 'whatsapp', 'call', 'visit']);
    const note = r.pick(['Said he will pay after salary on the 1st', 'Will clear half this week', 'Out of town, back on Monday', 'Promised to pay by UPI tonight', 'Asked for the statement on WhatsApp']);
    await machine.at(sim.business.id, clock.at(day, minutes), () => customers.remind(who.business, who.user, c.contact.id,
      { channel, note, promisedOn: clock.addDays(sim.realToday, r.int(2, 6)) }));
  }
}

// --- Returns -----------------------------------------------------------------------------------

// About one bill in a hundred and fifty comes back within three days.
async function returnsOf(sim, day, limit) {
  const r = clock.rng(`${sim.code}|returns|${day}`);
  const candidates = sim.recent.filter((x) => x.day < day && clock.daysBetween(x.day, day) <= 3 && x.plan.lines.some((l) => l.item.kind === 'goods' && !l.item.meta.noReturn));
  const count = Math.round(candidates.length * (sim.def.returnRate ?? 0.006));
  for (let n = 0; n < count && candidates.length; n += 1) {
    const sale = candidates.splice(r.int(0, candidates.length - 1), 1)[0];
    const minutes = sim.def.open + r.int(60, 300);
    if (minutes > limit) continue;
    const detail = await service.detail(sim.business, sale.doc.id);
    const line = detail.lines.find((l) => Number(l.returned_quantity) === 0 && sale.plan.lines.some((p) => Number(p.item.id) === Number(l.sku_id) && p.item.kind === 'goods'));
    if (!line) continue;
    const who = actor(sim, 'manager');
    const reason = r.pick(sim.def.returnReasons || ['Damaged packet', 'Wrong item given', 'Customer changed mind', 'Past best-before date']);
    const quantity = line.unit === 'kg' ? String(Number(line.quantity)) : '1';
    const ret = await post(sim, 'business_returns', `return-${sale.doc.id}`, clock.at(day, minutes), (requestKey) => returns.createReturn(who.business, who.user, sale.doc.id,
      { reason, requestKey, lines: [{ lineId: line.id, quantity, restock: !/damaged|expired|best-before/i.test(reason) }] }));
    if (!ret.created) continue;
    const item = sim.items.find((i) => Number(i.id) === Number(line.sku_id));
    if (!/damaged|expired|best-before/i.test(reason)) {
      const lot = lotsOf(sim, item.id).find((l) => l.code === (line.lot_code || ''));
      if (lot) lot.qty = round3(lot.qty + Number(quantity));
    }
    // A bill that was paid gets the money back the same way.
    const fresh = await service.detail(sim.business, sale.doc.id);
    const paid = fresh.payments.reduce((s, p) => s + Number(p.amount), 0) - fresh.refunds.reduce((s, p) => s + Number(p.amount), 0);
    const owed = Number(fresh.total) - fresh.returns.reduce((s, x) => s + Number(x.total), 0);
    if (paid - owed >= 0.01) {
      const method = fresh.payments[0]?.method === 'card' ? 'card' : fresh.payments[0]?.method === 'upi' ? 'upi' : 'cash';
      await post(sim, 'business_refunds', `refund-${sale.doc.id}`, clock.at(day, minutes + 2), (requestKey) => returns.refund(who.business, who.user, sale.doc.id,
        { amount: money(paid - owed), method, reason: `Refund for return: ${reason.toLowerCase()}`, requestKey }));
    }
  }
}

// Fresh goods past their date come off the shelf (with the reason in the ledger).
async function expiredOff(sim, day, limit) {
  const minutes = sim.def.close - 20;
  if (minutes > limit) return;
  for (const item of sim.items.filter((i) => i.tracking === 'batch' && i.meta.shelf && i.meta.shelf <= 30)) {
    for (const lot of lotsOf(sim, item.id)) {
      if (lot.qty <= 0.0005 || !lot.trueExpiry || lot.trueExpiry >= clock.addDays(day, 1)) continue;
      const who = actor(sim, 'stock_keeper', 'manager');
      const qty = lot.qty;
      const result = await post(sim, 'business_stock_adjustments', `expired-${lot.id}`, clock.at(day, minutes), (requestKey) => returns.adjust(who.business, who.user, lot.id,
        { quantity: `-${qtyText(qty, item.decimals)}`, reason: 'Expired: removed from the shelf', requestKey }));
      if (result.created) lot.qty = 0;
    }
  }
}

// The real expiry dates of batches that were received before today.
async function fixExpiries(sim) {
  for (const { lotId, expires } of sim.expiryFixes) {
    await db.query('UPDATE business_stock_lots SET expires_on=$3 WHERE business_id=$1 AND id=$2', [sim.business.id, lotId, expires]);
    for (const lots of sim.stock.values()) for (const l of lots) if (Number(l.id) === Number(lotId)) l.expires = expires;
  }
  sim.expiryFixes = [];
}

// --- The run ------------------------------------------------------------------------------------

async function run(sim) {
  const today = sim.realToday;
  const start = clock.addDays(today, -sim.def.days);
  const history = await base.marker(sim.business.id, 'demo.history_seeded');
  const through = history?.details?.through || null;
  await loadStock(sim);
  const stats = { days: 0, bills: 0 };
  const before = await repo.one(db, "SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND kind='sale'", [sim.business.id]);
  for (let day = start; day <= today; day = clock.addDays(day, 1)) {
    if (through && day <= through) continue;
    const isToday = day === today;
    const limit = isToday ? clock.minutesNow() : 24 * 60;
    const closed = sim.def.closedOn ? sim.def.closedOn(day) : false;
    const morningDone = isToday && (await base.marker(sim.business.id, 'demo.morning'))?.details?.day === day;
    if (!morningDone) {
      if (day === start) await openingStock(sim, day);
      if (sim.hooks.firstDay && day === start) await sim.hooks.firstDay(sim, day);
      if (!closed) await deliveries(sim, day);
      if (sim.hooks.morning) await sim.hooks.morning(sim, day, closed);
      if (!closed && day !== start) await paySuppliers(sim, day);
      if (isToday) await base.setMarker(sim.business.id, sim.owner.id, 'demo.morning', { day });
    }
    if (!closed) {
      await sellDay(sim, day, limit);
      if (sim.def.udhaar !== false) await collect(sim, day, limit);
      await remind(sim, day, limit);
      await returnsOf(sim, day, limit);
      if (sim.hooks.afternoon) await sim.hooks.afternoon(sim, day, limit);
    }
    if (!isToday) {
      await expiredOff(sim, day, limit);
      if (sim.hooks.evening) await sim.hooks.evening(sim, day, closed);
      planReorders(sim, day);
      if (day === clock.addDays(today, -1)) await fixExpiries(sim);
    }
    stats.days += 1;
  }
  await fixExpiries(sim);
  if (!through || through < clock.addDays(today, -1)) await base.setMarker(sim.business.id, sim.owner.id, 'demo.history_seeded', { through: clock.addDays(today, -1) });
  if (sim.hooks.today) await sim.hooks.today(sim, today);
  const after = await repo.one(db, "SELECT count(*)::int AS n FROM business_documents WHERE business_id=$1 AND kind='sale'", [sim.business.id]);
  stats.bills = after.n - before.n;
  return stats;
}

module.exports = { reloadSku, payOldest, run, receive, bill, fill, basket, quantity, post, actor, onHand, lotsOf, usableLots, takeStock, costOf, batchCode, money, round3, qtyText, methodOf, loadStock, collect };
