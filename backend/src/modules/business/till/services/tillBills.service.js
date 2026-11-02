const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const pricing = require('../../core/services/businessPricing');
const { GOODS_TYPES } = require('../../core/services/businessTypes');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const devices = require('./tillDevices.service');
const rules = require('./tillRules');

// A bill an offline till made with no network, arriving when the network is
// back (docs/ARCHITECTURE.md › How an offline bill is posted). It was handed
// to a customer, so it is posted as it was made, through the core's posting
// (postDocument's `offline` option), never around it:
//   - its number from the till's own series (T1/2627/00042), its time, the
//     cashier who made it (the session that sends it is recorded as its
//     sender), its prices and GST rates, its payments at that time (so the
//     shift, the day, the cash limit and the GST month follow the real time);
//   - what the till could not know is flagged for the manager, never refused:
//     a price or GST rate not the one in force then, a customer over their
//     limit, stock short (taken as far as it goes; business_till_shortfalls),
//     a time outside the window, a bill with no PIN where every bill asks for
//     one, a discount over today's limit, cash from one customer that day
//     over the limit, a B2B bill once e-invoicing applies, a maker no longer
//     billing here;
//   - only faults are refused ("needs attention" on the till): an unknown or
//     retired till, a number not its own or already used by another bill, a
//     sum more than ₹1 from the receipt's, an item or customer switched off
//     since (switch it on and send it again).
// A void keeps its number and moves nothing. Numbers that should have come
// before one that arrives and have not are recorded as gaps for the manager.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const paise = (value) => Math.round(Number(value) * 100);
const money = (value) => (value / 100).toFixed(2);

function readTime(value, name) {
  const t = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(t)) fail(`${name} must be a time`);
  return new Date(t).toISOString();
}

// One line as the till sold it.
function readLine(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Line ${index + 1} must be an object`);
  const priceKind = raw.priceKind ? v.requiredEnum(raw.priceKind, 'Price kind', ['list', 'branch', 'member', 'rule']) : 'list';
  const packPrice = raw.packPrice === undefined || raw.packPrice === null ? null : core.decimal(raw.packPrice, 'Pack price', 2, 0, 100000000);
  return {
    skuId: id(raw.skuId, 'Item'),
    quantity: String(core.decimal(raw.quantity, 'Quantity', 3, 0.001, 100000)),
    unit: raw.unit ? v.requiredString(raw.unit, 'Unit', 20) : undefined,
    unitPrice: core.decimal(raw.unitPrice, 'Price', 4, 0, 100000000),
    packPrice: packPrice === null ? null : paise(packPrice),
    priceKind,
    taxRate: core.decimal(raw.taxRate, 'GST rate', 2, 0, 100),
    label: v.optionalString(raw.label, 'Label', 200),
  };
}

// The till's own answer for a bill or void it sent (also for a repeat).
async function answer(db, business, row) {
  const flags = await repo.all(db, 'SELECT kind FROM business_till_flags WHERE business_id=$1 AND till_bill_id=$2 ORDER BY id', [business.id, row.id]);
  const doc = row.document_id ? await repo.one(db, 'SELECT id,document_no,total FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, row.document_id]) : null;
  const short = await repo.one(db, 'SELECT count(*)::int AS n FROM business_till_shortfalls WHERE business_id=$1 AND till_bill_id=$2', [business.id, row.id]);
  return { id: row.id, kind: row.kind, billNo: row.bill_no, documentId: doc?.id || null, documentNo: doc?.document_no || null, total: doc?.total || row.total,
    flags: flags.map((f) => f.kind), shortfalls: short.n, receivedAt: row.received_at };
}

// The person who made the bill: a member of the business (now, or once).
async function makerOf(db, business, userId) {
  const row = await repo.one(db, `SELECT u.id,u.name,u.status,m.active,m.location_id,r.active AS role_active,r.full_access,
      (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code='sales.create')) AS bills,
      (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code='sales.discount')) AS discounts
    FROM business_memberships m JOIN users u ON u.id=m.user_id JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
    WHERE m.business_id=$1 AND m.user_id=$2`, [business.id, userId]);
  if (!row) fail('The bill names as its maker someone who has never worked at this business. It cannot be posted as theirs: show the till to the manager.', 409, { reason: 'maker_unknown' });
  return row;
}

// The price an item was walk-in priced at, at a moment: this branch's price
// then, else its list price then (business_price_history), else as it is now.
async function priceThen(db, business, skuId, locationId, at) {
  // A branch row with no price is the branch going back to the item's own.
  const row = await repo.one(db, `SELECT
      (SELECT price FROM business_price_history WHERE business_id=$1 AND sku_id=$2 AND location_id IS NULL AND changed_at<=$4 ORDER BY changed_at DESC,id DESC LIMIT 1) AS list,
      (SELECT price FROM business_price_history WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND changed_at<=$4 ORDER BY changed_at DESC,id DESC LIMIT 1) AS branch`,
  [business.id, skuId, locationId, at]);
  return { list: row.list === null ? null : Number(row.list), branch: row.branch === null ? null : Number(row.branch) };
}

// What the server says each line should have been sold at then, and at what
// GST rate on its day: the lines that differ are flagged (the billed price stands).
async function differences(db, business, { lines, contact, locationId, madeAt, day, slab }) {
  const prices = [], rates = [];
  for (const line of lines) {
    const sku = await repo.one(db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, line.skuId]);
    let entered = null, quantity = Number(line.quantity);
    if (line.unit && line.unit !== sku.unit) {
      const unit = await core.readUnit(db, business.id, line.unit);
      const factorMicro = await core.conversion(db, business.id, sku, unit);
      entered = { unit: unit.code, quantity: Number(line.quantity), factorMicro };
      quantity = Number((BigInt(Math.round(Number(line.quantity) * 1000)) * BigInt(factorMicro) / 1000000n)) / 1000;
    }
    const member = Boolean(contact) && business.capabilities.includes('loyalty');
    const now = await pricing.salePrice(db, business, sku, contact?.id || null, quantity, entered, { locationId, member });
    let expected = now.stockPrice, expectedPack = now.priceKind === 'rule' && now.rule?.unit_code && entered ? now.enteredPrice : null;
    if (now.priceKind !== 'rule') {
      const then = await priceThen(db, business, sku.id, locationId, madeAt);
      expected = then.branch ?? then.list ?? Number(sku.price);
      if (member && sku.member_price !== null && Number(sku.member_price) < expected) expected = Number(sku.member_price);
    }
    const billed = line.packPrice !== null && expectedPack !== null ? line.packPrice : paise(line.unitPrice);
    const should = expectedPack !== null && line.packPrice !== null ? expectedPack : paise(expected);
    if (billed !== should) prices.push({ skuId: sku.id, label: sku.label, billed: money(billed), inForce: money(should), per: expectedPack !== null && line.packPrice !== null ? line.unit : sku.unit });
    // GST: the rate in force on the bill's day (a clothes shop's GST by price: one of its two rates then).
    if (slab && slab.covers.has(Number(sku.id))) {
      const rule = slab.on(day);
      if (![Number(rule.rateLow), Number(rule.rateHigh)].includes(Number(line.taxRate))) rates.push({ skuId: sku.id, label: sku.label, billed: Number(line.taxRate).toFixed(2), inForce: `${Number(rule.rateLow)} or ${Number(rule.rateHigh)}` });
      continue;
    }
    const changes = await repo.all(db, `SELECT i.starts_on::text AS "startsOn",x.rate,i.from_rate AS "fromRate" FROM business_tax_change_items i
      JOIN business_tax_changes x ON x.business_id=i.business_id AND x.id=i.change_id
      WHERE i.business_id=$1 AND i.sku_id=$2 AND i.status IN ('scheduled','applied')`, [business.id, sku.id]);
    const inForce = rules.rateOn(sku.tax_rate, changes, day);
    if (Math.round(inForce * 100) !== Math.round(Number(line.taxRate) * 100)) rates.push({ skuId: sku.id, label: sku.label, billed: Number(line.taxRate).toFixed(2), inForce: inForce.toFixed(2) });
  }
  return { prices, rates };
}

// A clothes shop's GST by price as it stood on a day: the rule, or a change of it dated by then.
async function slabRule(db, business) {
  if (business.business_type !== 'fashion') return null;
  const rule = await repo.one(db, 'SELECT * FROM fashion_gst_price_slabs WHERE business_id=$1 AND active', [business.id]);
  if (!rule) return null;
  const changes = await repo.all(db, `SELECT starts_on::text AS starts_on,rate_low,rate_high,status,before FROM business_tax_setting_changes
    WHERE business_id=$1 AND setting='fashion_price' AND status IN ('scheduled','applied') ORDER BY starts_on`, [business.id]);
  const covers = new Set((await repo.all(db, `WITH RECURSIVE up AS (
      SELECT s.id AS sku_id,p.category_id,1 AS depth FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND p.category_id IS NOT NULL
      UNION ALL SELECT up.sku_id,c.parent_id,up.depth+1 FROM up JOIN catalog_categories c ON c.business_id=$1 AND c.id=up.category_id
      WHERE c.parent_id IS NOT NULL AND up.depth<6)
    SELECT sku_id FROM up WHERE category_id=ANY($2::bigint[]) UNION SELECT sku_id FROM fashion_variants WHERE business_id=$1`, [business.id, rule.category_ids])).map((r) => Number(r.sku_id)));
  const on = (day) => {
    const dated = changes.filter((c) => c.starts_on <= day);
    if (dated.length) { const c = dated[dated.length - 1]; return { rateLow: c.rate_low, rateHigh: c.rate_high }; }
    const later = changes.find((c) => c.status === 'applied' && c.before);
    return later ? { rateLow: later.before.rateLow, rateHigh: later.before.rateHigh } : { rateLow: rule.rate_low, rateHigh: rule.rate_high };
  };
  return { covers, on };
}

async function addFlag(db, business, tillBillId, kind, details) {
  await db.query('INSERT INTO business_till_flags(business_id,till_bill_id,kind,details) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [business.id, tillBillId, kind, JSON.stringify(details)]);
}

// The series moves past a number that arrived; numbers it skipped are gaps,
// and a gap that arrives late is marked so.
async function account(db, business, device, series, seq, before) {
  await numbering.useTillNumber(db, business.id, series.id, seq);
  if (seq > before + 1) {
    await db.query(`INSERT INTO business_till_gaps(business_id,device_id,series_id,seq,bill_no)
      SELECT $1,$2,$3,g,$4||lpad(g::text,$6,'0') FROM generate_series($5::int,$7::int) g
      WHERE NOT EXISTS (SELECT 1 FROM business_till_bills b WHERE b.business_id=$1 AND b.series_id=$3 AND b.seq=g)
      ON CONFLICT DO NOTHING`, [business.id, device.id, series.id, series.prefix, before + 1, series.padding, seq - 1]);
  }
  await db.query("UPDATE business_till_gaps SET state='arrived',arrived_at=now() WHERE business_id=$1 AND series_id=$2 AND seq=$3 AND state<>'arrived'",
    [business.id, series.id, seq]);
  await db.query('UPDATE business_devices SET last_sync_at=now(),last_seen_at=now() WHERE business_id=$1 AND id=$2', [business.id, device.id]);
}

async function receive(business, user, body, token) {
  await access.require(business, 'sales.create');
  devices.requireModule(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = sha256(JSON.stringify(body));
  const kind = v.requiredEnum(body.kind, 'Kind', ['bill', 'void']);
  const number = v.requiredString(body.number, 'Bill number', 16);
  const parsed = rules.readBillNumber(number);
  if (!parsed) fail(`${number} is not an offline till's bill number`);
  const madeAt = readTime(body.madeAt, 'Made at');
  const madeBy = id(body.madeBy, 'Made by');
  const offlineSince = body.offlineSince ? readTime(body.offlineSince, 'Offline since') : null;
  const total = paise(core.decimal(body.total, 'Total', 2, 0, 1000000000));
  const pinRule = v.requiredBoolean(body.pinRule, 'PIN for every bill', false);
  const contactId = body.contactId === undefined || body.contactId === null || body.contactId === '' ? null : id(body.contactId, 'Customer');
  const rawLines = v.requiredArray(body.lines, 'Lines');
  if (!rawLines.length || rawLines.length > 100) fail('A bill has between 1 and 100 lines');
  const lines = rawLines.map(readLine);
  if (body.coupon || body.loyalty || body.voucher || body.finance || body.pickupOrderId) fail('Offers, coupons, points, vouchers and EMI are taken online only');
  const voidReason = kind === 'void' ? v.requiredString(body.void?.reason, 'Why it was voided', 300).trim() : null;
  if (kind === 'void' && !voidReason) fail('Say why the bill was voided');
  const parts = kind === 'bill' ? core.readPayments({ payments: body.payments ?? [] }) : [];
  if (parts.some((part) => part.amount === 'full')) fail('An offline bill names each payment\'s amount');

  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const device = await devices.fromToken(db, business, token);
    const old = await repo.one(db, 'SELECT * FROM business_till_bills WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return answer(db, business, old);
    }
    if (body.locationId !== undefined && body.locationId !== null && String(body.locationId) !== String(device.location_id)) {
      fail(`Till ${device.code} bills at its own location only`, 409, { reason: 'till_location' });
    }
    if (parsed.code !== device.code) fail(`${number} is not a number of till ${device.code}'s series`, 409, { reason: 'number_not_till' });
    const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
    const day = rules.dayOf(madeAt, business.timezone);
    const year = rules.fiscalYearOf(day, settings?.fiscal_year_start_month || 4);
    if (parsed.label !== rules.fiscalLabel(year)) {
      fail(`${number} is numbered for another financial year than the one it was made in (${day}): the till's clock or its year was wrong.`, 409, { reason: 'number_year' });
    }
    const used = await repo.one(db, `SELECT b.made_at,b.kind,u.name FROM business_till_bills b JOIN users u ON u.id=b.made_by WHERE b.business_id=$1 AND b.bill_no=$2`, [business.id, number]);
    if (used) {
      fail(`${number} was already used by another ${used.kind === 'void' ? 'voided bill' : 'bill'} (made by ${used.name}). This bill cannot take its number: keep its receipt and show it to the manager.`,
        409, { reason: 'number_used' });
    }
    const series = await numbering.tillSeries(db, business.id, device, year, user.id);
    const before = Number((await repo.one(db, 'SELECT COALESCE(max(seq),0) AS n FROM business_till_bills WHERE business_id=$1 AND series_id=$2', [business.id, series.id])).n);
    const maker = await makerOf(db, business, madeBy);
    const makerUser = { id: Number(maker.id), name: maker.name };
    const flags = [];
    if (!maker.active || maker.status !== 'active' || !maker.role_active || !maker.bills) flags.push(['maker', { name: maker.name }]);
    const tillSettings = await devices.settings(db, business.id);
    const late = rules.timeProblem({ madeAt, receivedAt: new Date().toISOString(), registeredAt: device.registered_at, offlineSince, stopHours: Number(tillSettings.stop_hours) });
    if (late) flags.push(['time', { why: late.why, words: late.words, madeAt, offlineSince }]);
    if (pinRule || settings?.counter_pin_every_bill) flags.push(['no_pin', {}]);
    const contact = contactId ? await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, contactId]) : null;
    if (contactId && (!contact || contact.kind !== 'customer')) fail('The customer on this bill is not a customer of this business', 409, { reason: 'customer_unknown' });

    if (kind === 'void') {
      const voidLines = lines.map((line) => ({ skuId: line.skuId, label: line.label, quantity: line.quantity, unit: line.unit || null, unitPrice: line.unitPrice }));
      const row = await repo.one(db, `INSERT INTO business_till_bills(business_id,device_id,location_id,series_id,seq,bill_no,kind,contact_id,made_at,made_by,sent_by,total,
          void_reason,void_lines,pin_rule,offline_since,request_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,'void',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [business.id, device.id, device.location_id, series.id, parsed.seq, number, contact?.id || null, madeAt, maker.id, user.id, money(total),
        voidReason, JSON.stringify(voidLines), pinRule, offlineSince, requestKey, hash]);
      await account(db, business, device, series, parsed.seq, before);
      await repo.audit(db, business.id, user.id, 'till_bill.voided', row.id, { billNo: number, madeBy: maker.id, madeAt, total: money(total), reason: voidReason });
      return answer(db, business, row);
    }

    // Faults the manager can put right: an item or customer switched off since.
    for (const line of lines) {
      const sku = await repo.one(db, `SELECT s.label,s.active AND p.active AS active,s.internal_use,s.tracking,s.is_kit,p.kind FROM catalog_skus s
        JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id WHERE s.business_id=$1 AND s.id=$2`, [business.id, line.skuId]);
      if (!sku) fail(`An item on ${number} is not in this business's catalogue`, 409, { reason: 'item_unknown' });
      if (!sku.active) fail(`${sku.label} on ${number} was switched off after the bill was made. Switch it on in Products & services, then send the bill again.`, 409, { reason: 'item_off' });
      if (sku.internal_use) fail(`${sku.label} on ${number} was set "for use in services only" after the bill was made. Untick it on the item, then send the bill again.`, 409, { reason: 'item_off' });
      if (sku.tracking === 'serial' || sku.is_kit || sku.kind !== 'goods') fail(`${sku.label} on ${number} is sold online only (a serial-numbered item, a kit or a service)`, 409, { reason: 'item_online_only' });
    }
    if (contact && (!contact.active || contact.erased_at)) {
      fail(`${contact.erased_at ? 'The customer' : contact.name} on ${number} was switched off after the bill was made. Switch them on under Customers, then send the bill again.`, 409, { reason: 'customer_off' });
    }
    // A payment method switched off since still took the money: it is recorded by its kind and name.
    const methods = await repo.all(db, 'SELECT id,name,kind,active FROM business_payment_methods WHERE business_id=$1', [business.id]);
    const paid = parts.map((part) => {
      if (!part.methodId) return part;
      const method = methods.find((m) => Number(m.id) === Number(part.methodId));
      if (!method) fail(`A payment on ${number} names a payment method this business does not have`, 409, { reason: 'method_unknown' });
      return method.active ? part : { ...part, methodId: undefined, method: method.kind, methodName: method.name };
    });
    const slab = await slabRule(db, business);
    const found = await differences(db, business, { lines, contact, locationId: device.location_id, madeAt, day, slab });

    const documentBody = {
      kind: 'sale', locationId: device.location_id, contactId: contact?.id || null, notes: `Made offline on till ${device.code}`,
      lines: lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity, ...(line.unit ? { unit: line.unit } : {}) })),
      ...(body.discount ? { discount: body.discount } : {}),
      ...(body.buyer ? { buyer: body.buyer } : {}),
    };
    const saved = await core.postDocument(db, business, makerUser, documentBody, {
      kind: 'sale', requestKey, hash, lines: documentBody.lines, paidNow: paid, walkInPays: GOODS_TYPES.includes(business.business_type),
      offline: { number, seriesId: series.id, madeAt, day, total, lines: lines.map((line) => ({ unitPrice: line.unitPrice, packPrice: line.packPrice, priceKind: line.priceKind, taxRate: line.taxRate })) },
    });
    const notes = saved.offline || { prices: [], credit: null, shortfalls: [], total: null };
    const row = await repo.one(db, `INSERT INTO business_till_bills(business_id,device_id,location_id,series_id,seq,bill_no,kind,document_id,made_at,made_by,sent_by,total,
        pin_rule,offline_since,request_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,'bill',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [business.id, device.id, device.location_id, series.id, parsed.seq, number, saved.id, madeAt, maker.id, user.id, money(total), pinRule, offlineSince, requestKey, hash]);

    // What the manager looks at.
    const prices = [...found.prices, ...notes.prices.map((p) => ({ skuId: p.skuId, label: p.label, aboveMrp: p.mrp }))];
    if (prices.length) flags.push(['price', { lines: prices }]);
    if (found.rates.length) flags.push(['rate', { lines: found.rates, day }]);
    if (notes.credit) flags.push(['credit', notes.credit]);
    if (notes.total) flags.push(['total', notes.total]);
    for (const short of notes.shortfalls) {
      await db.query(`INSERT INTO business_till_shortfalls(business_id,location_id,sku_id,document_id,line_id,till_bill_id,quantity)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [business.id, device.location_id, short.skuId, saved.id, short.lineId, row.id, short.quantity.toFixed(3)]);
    }
    if (notes.shortfalls.length) flags.push(['stock', { lines: notes.shortfalls.map((s) => ({ skuId: s.skuId, label: s.label, unit: s.unit, quantity: s.quantity.toFixed(3) })) }]);
    if (body.discount) {
      // The counter discount as the customer saw it (with GST), against today's limit on the bill before it.
      const shares = await repo.all(db, `SELECT x.amount,l.tax_rate FROM retail_sale_discounts x JOIN business_document_lines l ON l.business_id=x.business_id AND l.id=x.line_id
        WHERE x.business_id=$1 AND x.document_id=$2 AND x.source='manual'`, [business.id, saved.id]);
      const inclusive = saved.tax_mode === 'inclusive';
      const value = shares.reduce((sum, s) => sum + paise(s.amount) + (inclusive ? 0 : Math.round((paise(s.amount) * paise(s.tax_rate)) / 10000)), 0);
      const before = paise(saved.subtotal) + paise(saved.tax) + value;
      const cap = Math.floor((before * paise(settings?.max_bill_discount_percent ?? 10)) / 10000);
      if (value > 0 && ((!maker.full_access && value > cap + lines.length) || !maker.discounts)) {
        flags.push(['discount', { amount: money(value), limit: money(cap), reason: body.discount.reason || null, allowed: Boolean(maker.discounts) }]);
      }
    }
    if (contact) {
      const cash = paid.filter((part) => part.method === 'cash').reduce((sum, part) => sum + paise(part.amount), 0);
      if (cash > 0) {
        const day_ = await repo.one(db, 'SELECT business_cash_from_customer($1,$2,$3,$4::date) AS cash', [business.id, contact.id, business.timezone, day]);
        if (paise(day_.cash) >= 20000000) flags.push(['cash_limit', { cash: money(paise(day_.cash)), day }]);
      }
      if (contact.gstin && await require('./tillSnapshot.service').einvoicing(business)) flags.push(['einvoice', { gstin: contact.gstin }]);
    }
    for (const [flag, details] of flags) await addFlag(db, business, row.id, flag, details);
    await account(db, business, device, series, parsed.seq, before);
    await repo.audit(db, business.id, user.id, 'till_bill.received', row.id, { billNo: number, documentId: saved.id, madeBy: maker.id, madeAt, total: saved.total,
      ...(flags.length ? { flags: flags.map(([flag]) => flag) } : {}) });
    return answer(db, business, row);
  });
}

// A till retired as lost: the numbers it said it used and that never arrived
// are gaps to note (inside the retiring transaction). Returns how many.
async function markLost(db, business, device) {
  if (!device.last_year || !device.last_seq) return 0;
  const series = await repo.one(db, `SELECT * FROM business_number_series WHERE business_id=$1 AND device_id=$2 AND fiscal_year=$3`, [business.id, device.id, device.last_year]);
  const prefix = series?.prefix || numbering.tillPrefix(device.code, Number(device.last_year));
  const target = series || await numbering.tillSeries(db, business.id, device, Number(device.last_year), device.registered_by);
  const before = Number((await repo.one(db, 'SELECT COALESCE(max(seq),0) AS n FROM business_till_bills WHERE business_id=$1 AND series_id=$2', [business.id, target.id])).n);
  if (Number(device.last_seq) <= before) return 0;
  const inserted = await db.query(`INSERT INTO business_till_gaps(business_id,device_id,series_id,seq,bill_no)
    SELECT $1,$2,$3,g,$4||lpad(g::text,5,'0') FROM generate_series($5::int,$6::int) g
    WHERE NOT EXISTS (SELECT 1 FROM business_till_bills b WHERE b.business_id=$1 AND b.series_id=$3 AND b.seq=g)
    ON CONFLICT DO NOTHING`, [business.id, device.id, target.id, prefix, before + 1, Number(device.last_seq)]);
  await numbering.useTillNumber(db, business.id, target.id, Number(device.last_seq));
  return inserted.rowCount;
}

module.exports = { receive, markLost };
