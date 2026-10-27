const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const { applyAdjustment, lockLot } = require('../../core/services/businessReturns.service');
const weight = require('./businessWeight.service');
// Handing money back and a manager's PIN (shared with the salon, repairs, opticians, garages and laundries).
const refunds = () => require('./businessAdvanceRefunds');
const pins = () => require('./businessManagerPin');

// Meat, fish and other weight shops, day to day: the daily
// rate board (bulk change, history), stock by weight for today (opening,
// received, cut, sold, wasted), the end-of-day weigh-up, wastage for many
// items in one go, cutting to order at the counter, orders for pickup, and
// today's figures for the overview. Quantities are thousandths, money paise.
//
// An order for pickup may take an advance: a numbered collection receipt in
// its customer's name, held for the order's bill (the receivables' "apply
// advance" leaves it alone while the order is open). The bill that closes the
// order is made at Quick bill (POST /documents with pickupOrderId): the
// advance pays it first, through the core. What is left of it once the order
// is cancelled (or billed for less) goes back with a manager's PIN.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const milli = (value) => Math.round(Number(value) * 1000);
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const qty = (m) => (m / 1000).toFixed(3);
const weighs = (business) => {
  if (!business.modules.includes('weight')) fail('Sold by weight is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
};
const TODAY_START = `(date_trunc('day', now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone)`;
// What is left of a receipt: less the bills it paid and what was handed back.
const LEFT_SQL = (k) => `${k}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${k}.business_id AND p.collection_id=${k}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${k}.business_id AND f.collection_id=${k}.id),0)`;
// How an advance is paid (no cheques: the order is picked up within days).
const ADVANCE_KINDS = ['cash', 'card', 'upi', 'bank'];

repo.addLists({
  'weight-rate-history': {
    sql: `SELECT h.*,s.label,s.code,s.unit,u.name AS changed_by_name FROM weight_rate_history h
      JOIN catalog_skus s ON s.business_id=h.business_id AND s.id=h.sku_id JOIN users u ON u.id=h.changed_by WHERE h.business_id=$1`,
    search: ['label', 'code', 'changed_by_name'], date: 'changed_at', filters: { sku: 'sku_id' }, order: 'changed_at DESC,id DESC',
  },
  // The advance: its receipt, what was taken, what is left of it, and whether
  // it waits to be handed back (the order closed with some of it left).
  'weight-pickup-orders': {
    sql: `SELECT o.*,loc.name AS location_name,d.document_no,d.total AS bill_total,u.name AS created_by_name,
      (o.pickup_at AT TIME ZONE b.timezone)::date::text AS pickup_day,
      ((o.pickup_at AT TIME ZONE b.timezone)::date = (now() AT TIME ZONE b.timezone)::date) AS today,
      (o.status IN ('open','ready') AND o.pickup_at < now()) AS late,(o.status IN ('open','ready')) AS active,
      k.collection_no AS advance_no,k.amount AS advance,CASE WHEN k.id IS NULL THEN NULL ELSE ${LEFT_SQL('k')} END AS advance_left,
      (k.id IS NOT NULL AND o.status IN ('collected','cancelled') AND ${LEFT_SQL('k')} > 0) AS advance_to_hand_back,
      COALESCE((SELECT json_agg(json_build_object('id',l.id,'sku_id',l.sku_id,'label',l.label,'unit',l.unit,'quantity',l.quantity,'amount',l.amount,'note',l.note,
        'code',s.code) ORDER BY l.id) FROM weight_pickup_order_lines l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
        WHERE l.business_id=o.business_id AND l.order_id=o.id),'[]') AS lines
      FROM weight_pickup_orders o JOIN businesses b ON b.id=o.business_id JOIN business_locations loc ON loc.business_id=o.business_id AND loc.id=o.location_id
      JOIN users u ON u.id=o.created_by LEFT JOIN business_documents d ON d.business_id=o.business_id AND d.id=o.document_id
      LEFT JOIN business_collections k ON k.business_id=o.business_id AND k.id=o.advance_collection_id WHERE o.business_id=$1`,
    search: ['customer_name', 'phone', 'notes', 'document_no'], date: 'pickup_at', filters: { status: 'status', id: 'id', today: 'today', active: 'active', location: 'location_id' }, order: 'pickup_at,id',
  },
  'weight-day-closes': {
    sql: `SELECT c.*,loc.name AS location_name,u.name AS created_by_name FROM weight_day_closes c
      JOIN business_locations loc ON loc.business_id=c.business_id AND loc.id=c.location_id JOIN users u ON u.id=c.created_by WHERE c.business_id=$1`,
    search: ['location_name', 'created_by_name'], date: 'created_at', filters: { location: 'location_id' }, order: 'created_at DESC,id DESC',
  },
});

// --- Today's rates ---------------------------------------------------------------------------

// One row per item sold by weight: the rate now, the rate at the start of
// the day (before today's changes), the cost per unit of what is in stock and
// the margin, and how many customers have their own rate.
async function rates(business) {
  weighs(business);
  await access.require(business, 'catalog.view');
  const rows = await repo.all(repo.pool, `SELECT s.id,s.code,s.label,s.unit,s.price,s.mrp,s.tax_rate,COALESCE(c.name,p.category) AS category,
    COALESCE((SELECT h.old_price FROM weight_rate_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id AND h.changed_at >= ${TODAY_START} ORDER BY h.id LIMIT 1),s.price) AS opening_price,
    (SELECT max(h.changed_at) FROM weight_rate_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id) AS changed_at,
    EXISTS (SELECT 1 FROM weight_rate_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id AND h.changed_at >= ${TODAY_START}) AS changed_today,
    (SELECT CASE WHEN sum(l.quantity)>0 THEN round(sum(l.quantity*l.unit_cost)/sum(l.quantity),2) END FROM business_stock_lots l
      WHERE l.business_id=s.business_id AND l.sku_id=s.id AND l.quantity>0) AS cost,
    (SELECT COALESCE(sum(l.quantity),0) FROM business_stock_lots l WHERE l.business_id=s.business_id AND l.sku_id=s.id) AS on_hand,
    (SELECT count(*)::int FROM business_price_rules r WHERE r.business_id=s.business_id AND r.sku_id=s.id AND r.active AND r.contact_id IS NOT NULL) AS customer_rates
    FROM catalog_skus s JOIN businesses b ON b.id=s.business_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
    WHERE s.business_id=$1 AND s.active AND p.active AND p.kind='goods' AND u.kind='weight'
    ORDER BY COALESCE(c.name,p.category) NULLS LAST,s.label`, [business.id]);
  const settings = await repo.one(repo.pool, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  return { rows, taxMode: settings?.tax_mode || 'exclusive', customerRates: business.capabilities.includes('wholesale') };
}

// body: { rates: [{ skuId, price }] } — the new rate of each item (unchanged ones may be left out).
async function saveRates(business, user, body) {
  weighs(business);
  await access.require(business, 'catalog.edit');
  const list = v.requiredArray(body.rates, 'Rates');
  if (!list.length || list.length > 500) fail('Change between 1 and 500 rates at once');
  const wanted = list.map((r) => ({ skuId: id(r?.skuId, 'Item'), price: core.decimal(r?.price, 'Rate', 2, 0, 10000000) }));
  if (new Set(wanted.map((r) => r.skuId)).size !== wanted.length) fail('Each item may appear once');
  return repo.transaction(async (db) => {
    const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
    const changed = [];
    for (const r of wanted) {
      const sku = await repo.one(db, `SELECT s.* FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.id=$2 AND p.kind='goods' AND u.kind='weight' FOR UPDATE OF s`,
      [business.id, r.skuId]);
      if (!sku) fail('Choose items sold by weight', 404);
      if (paise(sku.price) === paise(r.price)) continue;
      core.checkMrp(sku.label, r.price, sku.tax_rate, settings?.tax_mode || 'exclusive', sku.mrp);
      await db.query('UPDATE catalog_skus SET price=$3 WHERE business_id=$1 AND id=$2', [business.id, sku.id, r.price.toFixed(2)]);
      await db.query('INSERT INTO weight_rate_history(business_id,sku_id,old_price,new_price,changed_by) VALUES($1,$2,$3,$4,$5)', [business.id, sku.id, sku.price, r.price.toFixed(2), user.id]);
      await repo.audit(db, business.id, user.id, 'catalog.price_changed', sku.id, { label: sku.label, from: sku.price, to: r.price.toFixed(2), source: 'rate_board' });
      changed.push({ skuId: Number(sku.id), label: sku.label, from: sku.price, to: r.price.toFixed(2) });
    }
    if (changed.length) await repo.event(db, business.id, user.id, 'rates.changed', 'business', business.id, { rates: changed });
    return { changed };
  });
}

// --- Stock by weight, today --------------------------------------------------------------------

// Per item and location: what the day opened with, what came in, was cut,
// sold and wasted since, and what should be on the counter now.
async function stockToday(business, query) {
  weighs(business);
  await access.require(business, 'inventory.view');
  const location = optionalId(query.location, 'Location');
  const rows = await repo.all(repo.pool, `WITH b AS (SELECT id,timezone FROM businesses WHERE id=$1),
    mv AS (
      SELECT l.sku_id,l.location_id,m.quantity,
        CASE WHEN d.kind='sale' THEN 'sold' WHEN d.kind='purchase' THEN 'received' WHEN m.return_id IS NOT NULL THEN 'returned'
          WHEN po.id IS NOT NULL THEN 'cut_in' WHEN pb.id IS NOT NULL THEN 'cut_out' WHEN w.id IS NOT NULL THEN 'wasted'
          WHEN m.transfer_id IS NOT NULL THEN 'moved' ELSE 'corrected' END AS kind
      FROM business_stock_movements m CROSS JOIN b JOIN business_stock_lots l ON l.business_id=m.business_id AND l.id=m.lot_id
      LEFT JOIN business_documents d ON d.business_id=m.business_id AND d.id=m.document_id
      LEFT JOIN weight_processing_outputs po ON po.business_id=m.business_id AND po.adjustment_id=m.adjustment_id
      LEFT JOIN weight_processing_batches pb ON pb.business_id=m.business_id AND pb.input_adjustment_id=m.adjustment_id
      LEFT JOIN weight_wastage_entries w ON w.business_id=m.business_id AND w.adjustment_id=m.adjustment_id
      WHERE m.business_id=$1 AND m.created_at >= ${TODAY_START}),
    today AS (SELECT sku_id,location_id,
      sum(quantity) AS net,
      sum(quantity) FILTER (WHERE kind='received') AS received,
      sum(quantity) FILTER (WHERE kind='cut_in') AS cut_in,
      -sum(quantity) FILTER (WHERE kind='cut_out') AS cut_out,
      -sum(quantity) FILTER (WHERE kind='sold') AS sold,
      sum(quantity) FILTER (WHERE kind='returned') AS returned,
      -sum(quantity) FILTER (WHERE kind='wasted') AS wasted,
      sum(quantity) FILTER (WHERE kind IN ('moved','corrected')) AS corrected
      FROM mv GROUP BY sku_id,location_id)
    SELECT s.id AS sku_id,s.id||'-'||loc.id AS id,loc.id AS location_id,loc.name AS location_name,s.code,s.label,s.unit,s.price,s.reorder_level,
      COALESCE(c.name,p.category) AS category,u.factor_to_base AS kg_factor,
      COALESCE(sum(l.quantity),0) AS on_hand,
      COALESCE(sum(l.quantity),0) - COALESCE(max(t.net),0) AS opening,
      COALESCE(max(t.received),0) AS received,COALESCE(max(t.cut_in),0) AS cut_in,COALESCE(max(t.cut_out),0) AS cut_out,
      COALESCE(max(t.sold),0) - COALESCE(max(t.returned),0) AS sold,COALESCE(max(t.wasted),0) AS wasted,COALESCE(max(t.corrected),0) AS corrected,
      COALESCE(sum(l.quantity*l.unit_cost),0)::numeric(16,2) AS value,
      CASE WHEN COALESCE(sum(l.quantity),0)>0 THEN (sum(l.quantity*l.unit_cost)/sum(l.quantity))::numeric(14,2) END AS average_cost,
      min(l.expires_on) FILTER (WHERE l.quantity>0) AS next_expiry,
      COALESCE(sum(l.quantity) FILTER (WHERE l.quantity>0 AND l.expires_on <= (now() AT TIME ZONE b.timezone)::date + 1),0) AS use_soon,
      (COALESCE(sum(l.quantity),0) <= s.reorder_level AND s.reorder_level > 0) AS low
    FROM catalog_skus s CROSS JOIN b JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
    JOIN business_locations loc ON loc.business_id=s.business_id AND loc.active
    LEFT JOIN business_stock_lots l ON l.business_id=s.business_id AND l.sku_id=s.id AND l.location_id=loc.id
    LEFT JOIN today t ON t.sku_id=s.id AND t.location_id=loc.id
    WHERE s.business_id=$1 AND p.kind='goods' AND s.active AND u.kind='weight' AND ($2::bigint IS NULL OR loc.id=$2)
    GROUP BY s.id,loc.id,loc.name,p.category,c.name,u.factor_to_base,b.timezone
    ORDER BY COALESCE(c.name,p.category) NULLS LAST,s.label,loc.id`, [business.id, location]);
  return { rows };
}

// --- Wastage in one go and the end-of-day weigh-up ----------------------------------------------

// Takes `quantityMilli` of an item out of its batches at a location, oldest
// use-by first, as wastage entries (each its own reasoned correction).
async function wasteItem(db, business, user, { skuId, locationId, quantityMilli, reason, note, requestKey, part }) {
  const sku = await repo.one(db, weight.SKU_SQL, [business.id, skuId]);
  if (!sku || sku.kind !== 'goods' || sku.tracking === 'serial') fail('Choose loose goods or items sold by weight', 404);
  const lots = await repo.all(db, `SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND quantity>0
    ORDER BY expires_on NULLS LAST,id`, [business.id, sku.id, locationId]);
  let left = quantityMilli;
  const entries = [];
  for (const [n, row] of lots.entries()) {
    if (left <= 0) break;
    const lot = await lockLot(db, business.id, row.id);
    const take = Math.min(left, milli(lot.quantity));
    if (take <= 0) continue;
    const key = weight.derivedKey(requestKey, `${part}-${n}`);
    entries.push(await weight.wasteFromLot(db, business, user, { lot, sku, quantityMilli: take, reason, note, requestKey: key, hash: weight.hashOf({ key }) }));
    left -= take;
  }
  if (left > 0) fail(`Only ${qty(quantityMilli - left)} ${sku.unit} of ${sku.label} is in stock here`, 409);
  return entries;
}

// body: { locationId, entries: [{ skuId, quantity, reason, note? }], requestKey }
async function wastageBatch(business, user, body) {
  weight.requireModule(business, 'wastage', 'Daily wastage');
  await access.require(business, 'wastage.create');
  const requestKey = core.uuid(body.requestKey);
  const list = v.requiredArray(body.entries, 'Wastage');
  if (!list.length || list.length > 100) fail('Write off between 1 and 100 items at once');
  const reasons = Object.keys(weight.REASONS);
  const entries = list.map((e) => {
    const reason = v.requiredEnum(e?.reason ?? 'unsold', 'Reason', reasons);
    const note = v.optionalString(e?.note, 'Note', 300);
    if (reason === 'other' && !note) fail('Say what happened when the reason is "Other"');
    return { skuId: id(e?.skuId, 'Item'), quantity: e?.quantity, reason, note };
  });
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const first = await repo.one(db, 'SELECT * FROM weight_wastage_entries WHERE business_id=$1 AND request_key=$2', [business.id, weight.derivedKey(weight.derivedKey(requestKey, 'w0'), '0-0')]);
    if (first) return { repeated: true, entries: [] };
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    const saved = [];
    for (const [n, e] of entries.entries()) {
      const sku = await repo.one(db, weight.SKU_SQL, [business.id, e.skuId]);
      if (!sku) fail('Item not found', 404);
      const quantityMilli = weight.readQuantity(e.quantity, `Wasted ${sku.label}`, sku);
      saved.push(...await wasteItem(db, business, user, { skuId: sku.id, locationId: location.id, quantityMilli, reason: e.reason, note: e.note,
        requestKey: weight.derivedKey(requestKey, `w${n}`), part: '0' }));
    }
    return { entries: saved, value: rupees(saved.reduce((s, w) => s + paise(w.value), 0)), kg: qty(saved.reduce((s, w) => s + milli(w.kg || 0), 0)) };
  });
}

// The end-of-day weigh-up. body: { locationId, lines: [{ skuId, counted, reason? }], requestKey }
// Less than expected is written off as wastage (drip loss unless another
// reason is given); more than expected is put back as a correction. The close
// is kept with what was expected, weighed and the difference in kg and rupees.
async function closeDay(business, user, body) {
  weighs(business);
  await access.require(business, 'inventory.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = weight.hashOf(body);
  const list = v.requiredArray(body.lines, 'Weighed items');
  if (!list.length || list.length > 300) fail('Weigh between 1 and 300 items');
  const reasons = Object.keys(weight.REASONS);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM weight_day_closes WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const location = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    const lines = [];
    let shortKg = 0, overKg = 0, shortValue = 0;
    for (const [n, entry] of list.entries()) {
      const sku = await repo.one(db, weight.SKU_SQL, [business.id, id(entry?.skuId, 'Item')]);
      if (!sku || sku.kind !== 'goods' || sku.unit_kind !== 'weight') fail('Weigh items sold by weight only', 404);
      if (lines.some((l) => l.skuId === Number(sku.id))) fail(`${sku.label} is listed twice`);
      const counted = entry?.counted === '' || entry?.counted === undefined || entry?.counted === null ? null : core.decimal(entry.counted, `Weighed ${sku.label}`, 3, 0, 100000);
      if (counted === null) continue;
      const stock = await repo.one(db, 'SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [business.id, sku.id, location.id]);
      const expected = milli(stock.q);
      const diff = milli(counted) - expected;
      const factor = weight.kgFactor(sku);
      const line = { skuId: Number(sku.id), label: sku.label, unit: sku.unit, expected: qty(expected), counted: qty(milli(counted)), difference: qty(diff), value: '0.00' };
      if (diff < 0) {
        const reason = v.requiredEnum(entry.reason ?? 'drip_loss', 'Reason', reasons);
        if (reason === 'other') fail('Choose a reason other than "Other" for the weigh-up, or record it under Wastage with a note');
        const wasted = await wasteItem(db, business, user, { skuId: sku.id, locationId: location.id, quantityMilli: -diff, reason, note: 'End-of-day weigh-up',
          requestKey: weight.derivedKey(requestKey, `close-${n}`), part: 'short' });
        const value = wasted.reduce((s, w) => s + paise(w.value), 0);
        line.value = rupees(-value);
        line.reason = reason;
        shortValue += value;
        shortKg += Math.round(-diff * factor);
      } else if (diff > 0) {
        // Put back on the newest batch (or the loose stock) at its cost.
        let target = await repo.one(db, `SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3
          ORDER BY expires_on DESC NULLS FIRST,id DESC LIMIT 1`, [business.id, sku.id, location.id]);
        if (!target) {
          target = await repo.one(db, `INSERT INTO business_stock_lots(business_id,location_id,sku_id,lot_code,expires_on,quantity,unit_cost) VALUES($1,$2,$3,'',NULL,0,0) RETURNING id`,
            [business.id, location.id, sku.id]);
        }
        const lot = await lockLot(db, business.id, target.id);
        await applyAdjustment(db, business, user, lot, diff / 1000, `End-of-day weigh-up: ${qty(diff)} ${sku.unit} more than expected`, weight.derivedKey(requestKey, `over-${n}`));
        line.value = rupees(Math.round((diff / 1000) * paise(lot.unit_cost)));
        overKg += Math.round(diff * factor);
      }
      lines.push(line);
    }
    if (!lines.length) fail('Enter what was weighed for at least one item');
    const day = await repo.one(db, 'SELECT (now() AT TIME ZONE timezone)::date AS day FROM businesses WHERE id=$1', [business.id]);
    const row = await repo.one(db, `INSERT INTO weight_day_closes(business_id,location_id,day,lines,short_kg,short_value,over_kg,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [business.id, location.id, day.day, JSON.stringify(lines), qty(shortKg), rupees(shortValue), qty(overKg), requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'weight.day_closed', row.id, { location: location.name, items: lines.length, shortKg: row.short_kg, shortValue: row.short_value, overKg: row.over_kg });
    await repo.event(db, business.id, user.id, 'weight.day_closed', 'weight_day_close', row.id, { locationId: location.id, lines });
    return row;
  });
}

// --- Orders for pickup ---------------------------------------------------------------------------

function readPickupLines(body) {
  const list = v.requiredArray(body.lines, 'Items');
  if (!list.length || list.length > 30) fail('An order has between 1 and 30 items');
  return list.map((l) => {
    const quantity = l?.quantity === undefined || l?.quantity === null || l?.quantity === '' ? null : core.decimal(l.quantity, 'Quantity', 3, 0.001, 100000);
    const amount = l?.amount === undefined || l?.amount === null || l?.amount === '' ? null : core.decimal(l.amount, 'Amount', 2, 1, 1000000);
    if (quantity === null && amount === null) fail('Give each item a weight or an amount ("₹200 worth")');
    return { skuId: id(l?.skuId, 'Item'), quantity, amount, note: v.optionalString(l?.note, 'Note', 150) };
  });
}

// The advance as typed: { amount, method | methodId, reference? } (sales.edit). null when none.
async function readAdvance(db, business, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('The advance must be an amount and how it was paid');
  const amount = paise(core.decimal(value.amount ?? 0, 'Advance', 2, 0, 10000000));
  if (amount <= 0) return null;
  await access.require(business, 'sales.edit');
  return { amount, ...await paymentMethods.pick(db, business.id, value, 'Advance paid by', ADVANCE_KINDS), reference: v.optionalString(value.reference, 'Reference', 100) };
}

// What an order comes to at today's rates (paise), the most its advance may
// be: each weight at the item's shelf price (GST included), each "₹ worth" as
// it is. The bill weighs it again at pickup.
async function orderValue(db, business, orderId) {
  const row = await repo.one(db, `SELECT COALESCE(sum(CASE WHEN l.amount IS NOT NULL THEN l.amount
      WHEN st.tax_mode='inclusive' THEN l.quantity*s.price ELSE l.quantity*s.price*(1+s.tax_rate/100) END),0) AS value
    FROM weight_pickup_order_lines l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
    JOIN business_settings st ON st.business_id=l.business_id WHERE l.business_id=$1 AND l.order_id=$2`, [business.id, orderId]);
  return Math.ceil(Number(row.value) - 1e-9) * 100;
}

// An open order's advance: a numbered receipt in its customer's name, kept
// with the order. Inside the caller's transaction (the business row locked).
async function takeAdvance(db, business, user, order, advance, { requestKey, hash }) {
  if (!['open', 'ready'].includes(order.status)) fail(`This order is already ${order.status}`, 409);
  if (order.advance_collection_id) fail(`${order.customer_name}'s order already has its advance`, 409);
  if (!order.contact_id) fail('An advance is taken in a saved customer\'s name: choose the customer on the order (or add them) to take one', 409);
  const most = await orderValue(db, business, order.id);
  if (advance.amount > most) fail(`The advance is part of the order: at most ${rupees(most)} at today's rates`);
  const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, order.contact_id]);
  const receipt = await numbering.nextNumber(db, business.id, order.location_id, 'collection', user.id);
  const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, order.location_id, receipt.number, receipt.seriesId, contact.id, contact.name,
    rupees(advance.amount), advance.method, advance.reference, `Advance on order for pickup #${order.id}`, requestKey, hash, user.id, advance.methodName || null]);
  const row = await repo.one(db, 'UPDATE weight_pickup_orders SET advance_collection_id=$3,updated_by=$4 WHERE business_id=$1 AND id=$2 RETURNING *',
    [business.id, order.id, collection.id, user.id]);
  await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, pickupOrderId: order.id });
  await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
    collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method: collection.method, pickupOrderId: order.id });
  return row;
}

// body: { locationId, contactId? | customerName, phone?, pickupAt, notes?, lines: [{ skuId, quantity? | amount?, note? }],
//   advance?: { amount, method | methodId, reference? } (a saved customer's order only), requestKey }
async function createPickup(business, user, body) {
  weighs(business);
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = weight.hashOf(body);
  const pickupAt = new Date(body.pickupAt);
  if (typeof body.pickupAt !== 'string' || !Number.isFinite(pickupAt.getTime())) fail('Choose when the order will be picked up');
  if (pickupAt.getTime() < Date.now() - 3600000) fail('The pickup time has already passed');
  const lines = readPickupLines(body);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM weight_pickup_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const advance = await readAdvance(db, business, body.advance);
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.locationId, 'Location')]);
    if (!location) fail('Location not found', 404);
    let contact = null;
    if (body.contactId) {
      contact = await repo.one(db, "SELECT id,name,phone FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, id(body.contactId, 'Customer')]);
      if (!contact) fail('Customer not found', 404);
    }
    const name = contact?.name || v.requiredString(body.customerName, 'Customer name', 150);
    const phone = v.optionalString(body.phone, 'Phone', 30) || contact?.phone || null;
    let order = await repo.one(db, `INSERT INTO weight_pickup_orders(business_id,location_id,contact_id,customer_name,phone,pickup_at,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [business.id, location.id, contact?.id || null, name, phone, pickupAt, notes, requestKey, hash, user.id]);
    for (const l of lines) {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.unit FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.kind='goods'`, [business.id, l.skuId]);
      if (!sku) fail('Item not found', 404);
      await db.query('INSERT INTO weight_pickup_order_lines(business_id,order_id,sku_id,label,unit,quantity,amount,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [business.id, order.id, sku.id, sku.label, sku.unit, l.quantity, l.amount, l.note]);
    }
    if (advance) order = await takeAdvance(db, business, user, order, advance, { requestKey: weight.derivedKey(requestKey, 'advance'), hash });
    await repo.audit(db, business.id, user.id, 'pickup_order.created', order.id, { customer: name, pickupAt, items: lines.length,
      ...(advance ? { advance: rupees(advance.amount) } : {}) });
    await repo.event(db, business.id, user.id, 'pickup_order.created', 'pickup_order', order.id, { contactId: contact?.id || null, pickupAt, lines,
      advanceCollectionId: order.advance_collection_id || null });
    return order;
  });
}

// An advance on an order already taken (the customer paid on the phone later).
// body: { amount, method | methodId, reference?, requestKey }
async function pickupAdvance(business, user, orderId, body) {
  weighs(business);
  await access.require(business, 'sales.create');
  await access.require(business, 'sales.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = weight.hashOf({ ...body, orderId: String(orderId) });
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const order = await repo.one(db, 'SELECT * FROM weight_pickup_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Order')]);
    if (!order) fail('Order not found', 404);
    // Asking again gives the same receipt; the same key with other data is refused.
    const old = await repo.one(db, 'SELECT id,request_hash FROM business_collections WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || String(old.id) !== String(order.advance_collection_id)) fail('This request key was already used for different data', 409);
      return order;
    }
    const advance = await readAdvance(db, business, body);
    if (!advance) fail('Enter the amount of the advance');
    return takeAdvance(db, business, user, order, advance, { requestKey, hash });
  });
}

// body: { status: ready | open | cancelled, reason? } or { status: collected, documentId }
async function setPickupStatus(business, user, orderId, body) {
  weighs(business);
  const status = v.requiredEnum(body.status, 'Status', ['open', 'ready', 'collected', 'cancelled']);
  await access.require(business, 'sales.create');
  return repo.transaction(async (db) => {
    const order = await repo.one(db, 'SELECT * FROM weight_pickup_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Order')]);
    if (!order) fail('Order not found', 404);
    if (order.status === status) return order;
    if (['collected', 'cancelled'].includes(order.status)) fail(`This order is already ${order.status}`, 409);
    let row;
    if (status === 'collected') {
      // An advance comes off the order's own bill, made with the order on it.
      if (order.advance_collection_id) fail(`${order.customer_name}'s order has an advance: bill it from Quick bill with the order on the bill (Bill on the order), and the advance comes off that bill`, 409);
      const doc = await repo.one(db, "SELECT id,document_no,created_at,contact_id FROM business_documents WHERE business_id=$1 AND id=$2 AND kind='sale'", [business.id, id(body.documentId, 'Bill')]);
      if (!doc) fail('Bill not found', 404);
      if (new Date(doc.created_at) < new Date(order.created_at)) fail('That bill is older than the order', 409);
      const used = await repo.one(db, 'SELECT id FROM weight_pickup_orders WHERE business_id=$1 AND document_id=$2', [business.id, doc.id]);
      if (used) fail('That bill is already on another order', 409);
      row = await repo.one(db, `UPDATE weight_pickup_orders SET status='collected',document_id=$3,closed_at=now(),updated_by=$4 WHERE business_id=$1 AND id=$2 RETURNING *`,
        [business.id, order.id, doc.id, user.id]);
    } else if (status === 'cancelled') {
      const reason = v.requiredString(body.reason, 'Reason', 300);
      row = await repo.one(db, `UPDATE weight_pickup_orders SET status='cancelled',cancel_reason=$3,closed_at=now(),updated_by=$4 WHERE business_id=$1 AND id=$2 RETURNING *`,
        [business.id, order.id, reason, user.id]);
    } else {
      row = await repo.one(db, `UPDATE weight_pickup_orders SET status=$3,ready_at=CASE WHEN $3='ready' THEN now() END,updated_by=$4 WHERE business_id=$1 AND id=$2 RETURNING *`,
        [business.id, order.id, status, user.id]);
    }
    await repo.audit(db, business.id, user.id, `pickup_order.${status}`, order.id, status === 'collected' ? { documentId: row.document_id } : {});
    await repo.event(db, business.id, user.id, `pickup_order.${status}`, 'pickup_order', order.id, { status, documentId: row.document_id || null });
    return row;
  });
}

// The bill that closes an order (POST /documents with pickupOrderId), inside
// its transaction and before it is posted: the order, locked after the
// business, and its advance to pay the bill first ({ collectionId, free
// (paise), method, reference, key }), or none. The same bill asked again finds
// its order closed with it (repeated).
async function forBill(db, business, orderId, requestKey, contactId) {
  weighs(business);
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const order = await repo.one(db, 'SELECT * FROM weight_pickup_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, orderId]);
  if (!order) fail('Order for pickup not found', 404);
  if (order.status === 'collected') {
    const same = await repo.one(db, 'SELECT id FROM business_documents WHERE business_id=$1 AND id=$2 AND request_key=$3', [business.id, order.document_id, requestKey]);
    if (same) return { order, advance: null, repeated: true };
  }
  if (!['open', 'ready'].includes(order.status)) fail(`This order is already ${order.status}`, 409);
  if (!order.advance_collection_id) return { order, advance: null, repeated: false };
  if (String(contactId || '') !== String(order.contact_id)) {
    fail(`${order.customer_name}'s advance pays only a bill in their name: choose ${order.customer_name} as the customer on this bill`, 409);
  }
  const receipt = await repo.one(db, `SELECT k.id,k.collection_no,k.method,${LEFT_SQL('k')} AS free FROM business_collections k
    WHERE k.business_id=$1 AND k.id=$2 FOR UPDATE OF k`, [business.id, order.advance_collection_id]);
  const free = Math.max(0, paise(receipt.free));
  return { order, repeated: false, advance: free > 0 ? { collectionId: receipt.id, free, method: receipt.method, reference: receipt.collection_no, key: weight.derivedKey(requestKey, 'advance') } : null };
}

// Closes the order with the bill just posted (forBill's answer).
async function closeWithBill(db, business, user, pickup, doc) {
  if (pickup.repeated) return;
  const { order } = pickup;
  await db.query(`UPDATE weight_pickup_orders SET status='collected',document_id=$3,closed_at=now(),updated_by=$4 WHERE business_id=$1 AND id=$2`,
    [business.id, order.id, doc.id, user.id]);
  const used = pickup.advance ? await repo.one(db, 'SELECT COALESCE(sum(amount),0) AS amount FROM business_payments WHERE business_id=$1 AND document_id=$2 AND collection_id=$3',
    [business.id, doc.id, pickup.advance.collectionId]) : null;
  await repo.audit(db, business.id, user.id, 'pickup_order.collected', order.id, { documentId: doc.id, ...(used ? { advanceUsed: used.amount } : {}) });
  await repo.event(db, business.id, user.id, 'pickup_order.collected', 'pickup_order', order.id, { status: 'collected', documentId: doc.id,
    advanceUsed: used ? used.amount : null });
}

// A customer's receipts held for their open orders: the receivables' "apply
// advance" leaves them for the orders' own bills.
async function heldReceipts(db, business, contactId) {
  const rows = await repo.all(db, `SELECT advance_collection_id FROM weight_pickup_orders WHERE business_id=$1 AND contact_id=$2
    AND advance_collection_id IS NOT NULL AND status IN ('open','ready')`, [business.id, contactId]);
  return new Set(rows.map((r) => Number(r.advance_collection_id)));
}

// What is left of a closed order's advance (cancelled, or billed for less),
// handed back by cash, UPI or bank with a reason and a manager's PIN
// (sales.refund): a numbered refund of its receipt.
// body: { amount? (all that is left), method | methodId, reference?, reason, approverId?, pin?, requestKey }
async function refundPickupAdvance(business, user, orderId, body) {
  weighs(business);
  await access.require(business, 'sales.view');
  await access.require(business, 'sales.edit');
  const input = refunds().readRefund(body);
  const approval = await pins().readApproval(business, user, body, 'sales.refund', { reasonLabel: 'Reason for the refund' });
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const order = await repo.one(db, 'SELECT * FROM weight_pickup_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Order')]);
    if (!order) fail('Order not found', 404);
    if (!order.advance_collection_id) fail(`${order.customer_name}'s order has no advance`, 409);
    if (['open', 'ready'].includes(order.status)) {
      fail(`${order.customer_name}'s order is still open: its advance comes off its bill at pickup. Cancel the order first to hand the advance back.`, 409);
    }
    const { refund, repeated } = await refunds().refundCollection(db, business, user, { collectionId: order.advance_collection_id, contactId: order.contact_id, input, approval,
      source: 'pickup', label: `Order for pickup #${order.id}` });
    return { ...refund, order_id: order.id, repeated };
  });
}

// --- Cut to order at the counter ---------------------------------------------------------------

// A whole bird or fish cut in front of the customer: the cutting batch is
// posted at once (the whole item leaves stock, the cut comes in) and the
// counter then bills the cut's weight. body as POST /weight/processing.
async function cutToOrder(business, user, body) {
  weight.requireModule(business, 'processing', 'Cutting & yield');
  await access.require(business, 'processing.create');
  await access.require(business, 'sales.create');
  return weight.processBatch(business, user, { ...body, cutToOrder: true });
}

// --- Today, for the overview ---------------------------------------------------------------------

async function today(business) {
  weighs(business);
  await access.require(business, 'inventory.view');
  const db = repo.pool;
  const can = (p) => access.can(business, p);
  const [sold, cut, wasted, useSoon, rateRow, pickups] = await Promise.all([
    repo.one(db, `SELECT COALESCE(sum(dl.quantity*COALESCE(u.factor_to_base,1)) FILTER (WHERE u.kind='weight'),0) AS kg,count(DISTINCT d.id)::int AS bills
      FROM business_documents d JOIN businesses b ON b.id=d.business_id JOIN business_document_lines dl ON dl.business_id=d.business_id AND dl.document_id=d.id
      JOIN business_units u ON u.business_id=dl.business_id AND u.code=dl.unit WHERE d.business_id=$1 AND d.kind='sale' AND d.created_at >= ${TODAY_START}`, [business.id]),
    business.modules.includes('processing') ? repo.one(db, `SELECT count(*)::int AS batches,COALESCE(sum(pb.input_kg),0) AS input_kg,COALESCE(sum(pb.output_kg),0) AS output_kg,
      round(100*sum(pb.output_kg)/NULLIF(sum(pb.input_kg),0),2) AS yield_percent,
      round(sum(pb.input_kg*t.expected)/NULLIF(sum(pb.input_kg) FILTER (WHERE t.expected IS NOT NULL),0),2) AS expected_percent
      FROM weight_processing_batches pb JOIN businesses b ON b.id=pb.business_id
      LEFT JOIN LATERAL (SELECT sum(o.expected_percent) AS expected FROM weight_yield_template_outputs o WHERE o.business_id=pb.business_id AND o.template_id=pb.template_id) t ON true
      WHERE pb.business_id=$1 AND pb.created_at >= ${TODAY_START}`, [business.id]) : null,
    business.modules.includes('wastage') ? repo.one(db, `SELECT count(w.id)::int AS entries,COALESCE(sum(w.kg),0) AS kg,COALESCE(sum(w.value),0) AS value
      FROM weight_wastage_entries w JOIN businesses b ON b.id=w.business_id WHERE w.business_id=$1 AND w.created_at >= ${TODAY_START}`, [business.id]) : null,
    repo.one(db, `SELECT COALESCE(sum(l.quantity*COALESCE(u.factor_to_base,1)) FILTER (WHERE l.expires_on <= (now() AT TIME ZONE b.timezone)::date),0) AS today_kg,
      COALESCE(sum(l.quantity*COALESCE(u.factor_to_base,1)) FILTER (WHERE l.expires_on = (now() AT TIME ZONE b.timezone)::date + 1),0) AS tomorrow_kg
      FROM business_stock_lots l JOIN businesses b ON b.id=l.business_id JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit AND u.kind='weight' WHERE l.business_id=$1 AND l.quantity>0`, [business.id]),
    repo.one(db, `SELECT count(*)::int AS items,count(*) FILTER (WHERE EXISTS (SELECT 1 FROM weight_rate_history h WHERE h.business_id=s.business_id AND h.sku_id=s.id
      AND h.changed_at >= ${TODAY_START}))::int AS changed_today FROM catalog_skus s JOIN businesses b ON b.id=s.business_id
      JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
      WHERE s.business_id=$1 AND s.active AND p.kind='goods' AND u.kind='weight'`, [business.id]),
    can('sales.view') ? repo.page(business.id, 'weight-pickup-orders', 5, 0, { filters: { status: ['open', 'ready'], today: 'true' } }) : null,
  ]);
  return { sold, cut, wasted, useSoon, rates: rateRow, pickups: pickups ? { total: pickups.total, items: pickups.items } : null };
}

module.exports = {
  rates, saveRates, stockToday, wastageBatch, closeDay, createPickup, pickupAdvance, setPickupStatus, refundPickupAdvance, cutToOrder, today,
  // Used by the core's bill (business.service.js document) and the receivables' "apply advance".
  forBill, closeWithBill, heldReceipts,
};
