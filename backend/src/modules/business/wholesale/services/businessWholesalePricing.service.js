const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');

// Wholesale price groups and schemes (pro pass D-11).
//
//   Price group   retailer / wholesaler / modern trade / HoReCa: each trade
//                 customer belongs to at most one. A group price applies
//                 from a date (to a date, or open); changing it ends the old
//                 row the day before the new one starts, so the history of
//                 every price stays.
//   Scheme        buy N (cases or pieces) get M free, and/or a discount %,
//                 for a period, for everyone or one group. Applied by the
//                 server when an order is taken and shown on the invoice.
//
// Which price a line gets: the customer's own price (Price lists) first, then
// their group's price, then a slab for all customers, then the list price.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const today = async (db, business) => (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
const dayBefore = (text) => new Date(Date.parse(`${text}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

repo.addLists({
  'price-groups': { sql: `SELECT g.*,
      (SELECT count(*)::int FROM wholesale_customer_profiles p WHERE p.business_id=g.business_id AND p.price_group_id=g.id) AS customer_count,
      (SELECT count(*)::int FROM wholesale_group_prices x JOIN businesses b ON b.id=x.business_id WHERE x.business_id=g.business_id AND x.group_id=g.id
        AND x.valid_from<=(now() AT TIME ZONE b.timezone)::date AND (x.valid_to IS NULL OR x.valid_to>=(now() AT TIME ZONE b.timezone)::date)) AS price_count
      FROM wholesale_price_groups g WHERE g.business_id=$1`, search: ['name', 'notes'], filters: { active: 'active' }, order: 'active DESC,name' },
  // state: current / upcoming / ended (by today's date in the business's zone).
  'group-prices': { sql: `SELECT x.*,g.name AS group_name,s.label,s.code AS sku_code,s.unit,s.price AS list_price,u.name AS created_by_name,
      CASE WHEN x.valid_from>(now() AT TIME ZONE b.timezone)::date THEN 'upcoming'
        WHEN x.valid_to IS NOT NULL AND x.valid_to<(now() AT TIME ZONE b.timezone)::date THEN 'ended' ELSE 'current' END AS state
      FROM wholesale_group_prices x JOIN businesses b ON b.id=x.business_id
      JOIN wholesale_price_groups g ON g.business_id=x.business_id AND g.id=x.group_id
      JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id JOIN users u ON u.id=x.created_by WHERE x.business_id=$1`,
  search: ['label', 'sku_code', 'group_name'], filters: { group: 'group_id', sku: 'sku_id', state: 'state' }, order: 'group_name,label,unit_code NULLS FIRST,minimum_quantity,valid_from DESC' },
  schemes: { sql: `SELECT x.*,s.label,s.code AS sku_code,s.unit,g.name AS group_name,fs.label AS free_label,fs.unit AS free_stock_unit,
      CASE WHEN NOT x.active THEN 'off' WHEN x.valid_from>(now() AT TIME ZONE b.timezone)::date THEN 'upcoming'
        WHEN x.valid_to IS NOT NULL AND x.valid_to<(now() AT TIME ZONE b.timezone)::date THEN 'ended' ELSE 'current' END AS state,
      (SELECT count(*)::int FROM wholesale_order_lines l WHERE l.business_id=x.business_id AND l.scheme_id=x.id AND l.free_of_line_id IS NULL) AS times_used
      FROM wholesale_schemes x JOIN businesses b ON b.id=x.business_id JOIN catalog_skus s ON s.business_id=x.business_id AND s.id=x.sku_id
      LEFT JOIN catalog_skus fs ON fs.business_id=x.business_id AND fs.id=x.free_sku_id
      LEFT JOIN wholesale_price_groups g ON g.business_id=x.business_id AND g.id=x.group_id WHERE x.business_id=$1`,
  search: ['name', 'label', 'sku_code', 'group_name', 'free_label'], filters: { state: 'state', sku: 'sku_id', group: 'group_id', free_sku: 'free_sku_id' }, order: 'active DESC,valid_from DESC,id DESC' },
});

// --- Price groups ------------------------------------------------------------------

async function saveGroup(business, user, groupId, body) {
  await access.require(business, 'wholesale.edit');
  const name = v.requiredString(body.name, 'Group name', 100);
  const notes = v.optionalString(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    let row;
    if (!groupId) {
      row = await repo.one(db, 'INSERT INTO wholesale_price_groups(business_id,name,notes,created_by) VALUES($1,$2,$3,$4) RETURNING *', [business.id, name, notes, user.id]);
    } else {
      row = await repo.one(db, 'UPDATE wholesale_price_groups SET name=$3,notes=$4,active=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
        [business.id, id(groupId), name, notes, v.requiredBoolean(body.active, 'Active', true)]);
      if (!row) fail('Price group not found', 404);
    }
    await repo.audit(db, business.id, user.id, groupId ? 'price_group.updated' : 'price_group.created', row.id, { name });
    return row;
  });
}

async function readGroupPrice(db, business, body) {
  const group = await repo.one(db, 'SELECT * FROM wholesale_price_groups WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.groupId, 'Price group')]);
  if (!group) fail('Price group not found', 404);
  const sku = await repo.one(db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.skuId, 'Item')]);
  if (!sku) fail('Item not found', 404);
  let unitCode = null;
  if (body.unitCode !== undefined && body.unitCode !== null && body.unitCode !== '' && body.unitCode !== sku.unit) {
    const pack = await repo.one(db, 'SELECT unit_code FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3 AND active', [business.id, sku.id, String(body.unitCode)]);
    if (!pack) fail('This item has no such pack size. Add it under Settings › Units & pack sizes first.', 404);
    unitCode = pack.unit_code;
  }
  const minimum = body.minimumQuantity === undefined || body.minimumQuantity === null || body.minimumQuantity === '' ? 1 : core.decimal(body.minimumQuantity, 'From quantity', 3, 0.001, 100000);
  if (unitCode && !Number.isInteger(minimum)) fail('A pack price starts at a whole number of packs');
  const unitPrice = core.decimal(body.unitPrice, 'Price', 2, 0, 10000000);
  return { group, sku, unitCode, minimum, unitPrice };
}

// A group price from a date. If the same price line (group, item, pack,
// from-quantity) already has a price running on that date, it ends the day
// before; one that would start later is refused (edit that one instead).
async function setGroupPrice(business, user, body) {
  await access.require(business, 'wholesale.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const p = await readGroupPrice(db, business, body);
    const now = await today(db, business);
    const from = body.validFrom ? core.dateText(body.validFrom, 'Valid from') : now;
    const to = body.validTo ? core.dateText(body.validTo, 'Valid to') : null;
    if (to && to < from) fail('The end date is before the start date');
    if (from < now) fail('A price starts today or later; earlier invoices keep the price they were raised at');
    const same = await repo.all(db, `SELECT * FROM wholesale_group_prices WHERE business_id=$1 AND group_id=$2 AND sku_id=$3 AND COALESCE(unit_code,'')=COALESCE($4,'')
      AND minimum_quantity=$5 AND (valid_to IS NULL OR valid_to>=$6) ORDER BY valid_from FOR UPDATE`, [business.id, p.group.id, p.sku.id, p.unitCode, p.minimum, from]);
    for (const row of same) {
      if (row.valid_from >= from) fail(`A price for this line already starts on ${row.valid_from}. Change that one, or start this one later.`, 409);
      await db.query('UPDATE wholesale_group_prices SET valid_to=$3,ended_by=$4 WHERE business_id=$1 AND id=$2', [business.id, row.id, dayBefore(from), user.id]);
    }
    const saved = await repo.one(db, `INSERT INTO wholesale_group_prices(business_id,group_id,sku_id,unit_code,minimum_quantity,unit_price,valid_from,valid_to,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [business.id, p.group.id, p.sku.id, p.unitCode, p.minimum, p.unitPrice.toFixed(2), from, to, user.id]);
    await repo.audit(db, business.id, user.id, 'group_price.set', saved.id, { group: p.group.name, item: p.sku.label, unit: p.unitCode || p.sku.unit,
      price: saved.unit_price, from, to, replaced: same.map((r) => ({ id: r.id, price: r.unit_price })) });
    return saved;
  });
}

// Ends a group price (its last day is today, or the given date). One that
// has not started yet was never used, so it is simply taken off.
async function endGroupPrice(business, user, priceId, body = {}) {
  await access.require(business, 'wholesale.edit');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, 'SELECT * FROM wholesale_group_prices WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(priceId)]);
    if (!row) fail('Price not found', 404);
    const now = await today(db, business);
    if (row.valid_from > now) {
      await db.query('DELETE FROM wholesale_group_prices WHERE business_id=$1 AND id=$2', [business.id, row.id]);
      await repo.audit(db, business.id, user.id, 'group_price.withdrawn', row.id, { price: row.unit_price, from: row.valid_from });
      return { ...row, withdrawn: true };
    }
    const end = body.validTo ? core.dateText(body.validTo, 'Last day') : now;
    if (end < now) fail('A price can be ended today or later');
    if (row.valid_to && row.valid_to <= end) fail('This price has already ended by then', 409);
    const saved = await repo.one(db, 'UPDATE wholesale_group_prices SET valid_to=$3,ended_by=$4 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, row.id, end, user.id]);
    await repo.audit(db, business.id, user.id, 'group_price.ended', row.id, { lastDay: end });
    return saved;
  });
}

// Revise prices: every price running in a group (or all groups) on the date
// for the items chosen (or all), by a percentage, from that date.
async function reviseGroupPrices(business, user, body) {
  await access.require(business, 'wholesale.edit');
  const percent = Number(body.percent);
  if (!Number.isFinite(percent) || percent < -90 || percent > 500 || Math.round(percent * 100) !== percent * 100) fail('Change must be a percentage between -90 and 500, at most two decimal places');
  if (percent === 0) fail('Enter the change in per cent');
  const skuIds = body.skuIds === undefined || body.skuIds === null ? null : v.requiredArray(body.skuIds, 'Items').map((x) => id(x, 'Item'));
  if (skuIds && (!skuIds.length || skuIds.length > 500)) fail('Choose between 1 and 500 items');
  const groupId = optionalId(body.groupId, 'Price group');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const now = await today(db, business);
    const from = body.validFrom ? core.dateText(body.validFrom, 'Valid from') : now;
    if (from < now) fail('Revised prices start today or later');
    const running = await repo.all(db, `SELECT x.* FROM wholesale_group_prices x JOIN wholesale_price_groups g ON g.business_id=x.business_id AND g.id=x.group_id AND g.active
      WHERE x.business_id=$1 AND ($2::bigint IS NULL OR x.group_id=$2) AND ($3::bigint[] IS NULL OR x.sku_id=ANY($3))
      AND x.valid_from<=$4 AND (x.valid_to IS NULL OR x.valid_to>=$4) ORDER BY x.id FOR UPDATE OF x`, [business.id, groupId, skuIds, from]);
    if (!running.length) fail('No group prices are running on that date for the items chosen', 404);
    const made = [];
    for (const row of running) {
      if (row.valid_from === from) fail('Some of these prices start on that very date; revise from a later date or change them one by one', 409);
      const price = roundedDivide(BigInt(paise(row.unit_price)) * BigInt(Math.round((100 + percent) * 100)), 10000n);
      await db.query('UPDATE wholesale_group_prices SET valid_to=$3,ended_by=$4 WHERE business_id=$1 AND id=$2', [business.id, row.id, dayBefore(from), user.id]);
      made.push(await repo.one(db, `INSERT INTO wholesale_group_prices(business_id,group_id,sku_id,unit_code,minimum_quantity,unit_price,valid_from,valid_to,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [business.id, row.group_id, row.sku_id, row.unit_code, row.minimum_quantity, (price / 100).toFixed(2), from, row.valid_to && row.valid_to >= from ? row.valid_to : null, user.id]));
    }
    await repo.audit(db, business.id, user.id, 'group_price.revised', groupId, { percent, from, prices: made.length });
    return { revised: made.length, from, percent };
  });
}

// --- Schemes ---------------------------------------------------------------------------

async function saveScheme(business, user, schemeId, body) {
  await access.require(business, 'wholesale.edit');
  return repo.transaction(async (db) => {
    if (schemeId) {
      // A scheme already used on orders keeps its terms; only switch it off or end it.
      const row = await repo.one(db, 'SELECT * FROM wholesale_schemes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(schemeId)]);
      if (!row) fail('Scheme not found', 404);
      const active = v.requiredBoolean(body.active, 'Active', row.active);
      const validTo = body.validTo === undefined ? row.valid_to : body.validTo ? core.dateText(body.validTo, 'Valid to') : null;
      if (validTo && validTo < row.valid_from) fail('The end date is before the start date');
      const saved = await repo.one(db, 'UPDATE wholesale_schemes SET active=$3,valid_to=$4 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, row.id, active, validTo]);
      await repo.audit(db, business.id, user.id, 'scheme.updated', row.id, { active, validTo });
      return saved;
    }
    const name = v.requiredString(body.name, 'Scheme name', 120);
    const sku = await repo.one(db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.skuId, 'Item')]);
    if (!sku) fail('Item not found', 404);
    let unitCode = null;
    if (body.unitCode && body.unitCode !== sku.unit) {
      const pack = await repo.one(db, 'SELECT unit_code FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3 AND active', [business.id, sku.id, String(body.unitCode)]);
      if (!pack) fail('This item has no such pack size', 404);
      unitCode = pack.unit_code;
    }
    const buy = core.decimal(body.buyQuantity, 'Buy quantity', 3, 0.001, 100000);
    const free = body.freeQuantity === undefined || body.freeQuantity === '' || body.freeQuantity === null ? 0 : core.decimal(body.freeQuantity, 'Free quantity', 3, 0, 100000);
    const discount = body.discountPercent === undefined || body.discountPercent === '' || body.discountPercent === null ? 0 : core.decimal(body.discountPercent, 'Discount %', 2, 0, 99.99);
    if (!free && !discount) fail('A scheme gives free goods, a discount, or both');
    // The free goods may be another item: "buy 5 cases of A, get 1 of B" (round 2).
    let freeSku = null, freeUnit = null;
    const freeSkuId = optionalId(body.freeSkuId, 'Free item');
    if (freeSkuId && freeSkuId !== sku.id) {
      if (!free) fail('Say how much of the free item is given');
      freeSku = await repo.one(db, `SELECT s.* FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.kind='goods'`, [business.id, freeSkuId]);
      if (!freeSku) fail('Free item not found', 404);
      if (body.freeUnitCode && body.freeUnitCode !== freeSku.unit) {
        const pack = await repo.one(db, 'SELECT unit_code FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3 AND active', [business.id, freeSku.id, String(body.freeUnitCode)]);
        if (!pack) fail(`${freeSku.label} has no such pack size`, 404);
        freeUnit = pack.unit_code;
      }
    }
    // "Don't combine with slab price": when it applies, the line is priced without quantity slabs.
    const noSlab = v.requiredBoolean(body.noSlab, 'Do not combine with slab price', false);
    const groupId = optionalId(body.groupId, 'Price group');
    if (groupId && !(await repo.one(db, 'SELECT id FROM wholesale_price_groups WHERE business_id=$1 AND id=$2', [business.id, groupId]))) fail('Price group not found', 404);
    const now = await today(db, business);
    const from = body.validFrom ? core.dateText(body.validFrom, 'Valid from') : now;
    const to = body.validTo ? core.dateText(body.validTo, 'Valid to') : null;
    if (to && to < from) fail('The end date is before the start date');
    const saved = await repo.one(db, `INSERT INTO wholesale_schemes(business_id,name,sku_id,unit_code,buy_quantity,free_quantity,discount_percent,group_id,valid_from,valid_to,created_by,
      free_sku_id,free_unit_code,no_slab) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [business.id, name, sku.id, unitCode, buy, free, discount, groupId, from, to, user.id, freeSku?.id || null, freeUnit, noSlab]);
    await repo.audit(db, business.id, user.id, 'scheme.created', saved.id, { name, item: sku.label, buy, free, discount, from, to, freeItem: freeSku?.label || null, freeUnit, noSlab });
    return saved;
  });
}

// --- Order-line pricing (used by sales orders) ------------------------------------------------

// The group price that beats the slab for all customers, if any:
// { unitPrice (rupees), perPack } or null.
// baseOnly (a scheme that does not stack on slabs): only the group's price
// from one unit or one pack, never a quantity slab.
async function groupPrice(db, businessId, groupId, sku, quantity, entered, day, baseOnly = false) {
  if (!groupId) return null;
  return repo.one(db, `SELECT * FROM wholesale_group_prices WHERE business_id=$1 AND group_id=$2 AND sku_id=$3
    AND valid_from<=$4 AND (valid_to IS NULL OR valid_to>=$4)
    AND ((unit_code IS NULL AND minimum_quantity<=$5) OR (unit_code IS NOT NULL AND unit_code=$6 AND minimum_quantity<=$7))
    AND (NOT $8::boolean OR minimum_quantity<=1)
    ORDER BY (unit_code IS NOT NULL) DESC,minimum_quantity DESC LIMIT 1`, [businessId, groupId, sku.id, day, quantity, entered?.unit || null, entered?.quantity ?? 0, baseOnly]);
}

// The scheme a line qualifies for (the biggest one it reaches), with the free
// goods it earns in the stock unit: { scheme, freeMilli, freeEntered } or null.
async function schemeFor(db, businessId, groupId, sku, quantityMilli, entered, day) {
  const schemes = await repo.all(db, `SELECT x.*,u.quantity_in_base,fu.quantity_in_base AS free_in_base FROM wholesale_schemes x
    LEFT JOIN catalog_sku_units u ON u.business_id=x.business_id AND u.sku_id=x.sku_id AND u.unit_code=x.unit_code
    LEFT JOIN catalog_sku_units fu ON fu.business_id=x.business_id AND fu.sku_id=x.free_sku_id AND fu.unit_code=x.free_unit_code
    WHERE x.business_id=$1 AND x.sku_id=$2 AND x.active AND x.valid_from<=$3 AND (x.valid_to IS NULL OR x.valid_to>=$3)
    AND (x.group_id IS NULL OR x.group_id=$4) ORDER BY x.buy_quantity DESC,x.id`, [businessId, sku.id, day, groupId]);
  for (const scheme of schemes) {
    // The line in the scheme's unit: packs when the scheme counts packs.
    const factorMicro = scheme.unit_code ? Math.round(Number(scheme.quantity_in_base) * 1e6) : 1000000;
    if (!factorMicro) continue;
    const inUnitMilli = Math.floor((quantityMilli * 1000000) / factorMicro);
    const times = Math.floor(inUnitMilli / milli(scheme.buy_quantity));
    if (times < 1) continue;
    const freeInUnitMilli = times * milli(scheme.free_quantity);
    if (scheme.free_sku_id && Number(scheme.free_sku_id) !== Number(sku.id)) {
      // Another item free: counted in its own pack (or its stock unit).
      const freeFactor = scheme.free_unit_code ? Math.round(Number(scheme.free_in_base) * 1e6) : 1000000;
      const freeMilli = Number((BigInt(freeInUnitMilli) * BigInt(freeFactor)) / 1000000n);
      return { scheme, freeMilli, freeSkuId: Number(scheme.free_sku_id), discount: Number(scheme.discount_percent), noSlab: scheme.no_slab,
        freeEntered: scheme.free_unit_code && freeInUnitMilli ? { unit: scheme.free_unit_code, quantity: freeInUnitMilli / 1000, factorMicro: freeFactor } : null };
    }
    const freeMilli = Number((BigInt(freeInUnitMilli) * BigInt(factorMicro)) / 1000000n);
    return { scheme, freeMilli, freeEntered: scheme.unit_code && freeInUnitMilli ? { unit: scheme.unit_code, quantity: freeInUnitMilli / 1000, factorMicro } : null,
      discount: Number(scheme.discount_percent), noSlab: scheme.no_slab };
  }
  return null;
}

// --- Scheme report per retailer (round 2) --------------------------------------------------------

// For orders taken in the period: per retailer and scheme, how many orders
// earned it, what was bought on the scheme and sent, the free goods sent and
// their value at the list price, and the discount given on those lines (at
// the order's prices; with prices including GST the GST is inside).
// query: { from, to, contact?, scheme? }
async function schemeReport(business, query) {
  await access.require(business, 'reports.view');
  await access.require(business, 'sales_orders.view');
  const from = core.dateText(query.from, 'From date'), to = core.dateText(query.to, 'To date');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  const contactId = optionalId(query.contact, 'Customer');
  const schemeId = optionalId(query.scheme, 'Scheme');
  const rows = await repo.all(repo.pool, `WITH lines AS (
      SELECT o.contact_id,o.contact_name,x.scheme_id,x.order_id,x.free_of_line_id,x.sku_id,x.unit,x.quantity,x.dispatched_quantity,x.net,x.tax,o.tax_mode,
        COALESCE(x.list_unit_price,0) AS list_unit_price,x.discount_percent
      FROM wholesale_order_lines x JOIN wholesale_orders o ON o.business_id=x.business_id AND o.id=x.order_id
      WHERE x.business_id=$1 AND x.scheme_id IS NOT NULL AND o.status<>'cancelled'
        AND (o.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        AND ($5::bigint IS NULL OR o.contact_id=$5) AND ($6::bigint IS NULL OR x.scheme_id=$6))
    SELECT l.contact_id,l.contact_name,l.scheme_id,sc.name AS scheme_name,s.label AS item,s.unit,fs.label AS free_item,COALESCE(fs.unit,s.unit) AS free_unit,
      (SELECT json_build_object('unit',u.unit_code,'factor',u.quantity_in_base) FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=s.id AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS pack,
      (SELECT json_build_object('unit',u.unit_code,'factor',u.quantity_in_base) FROM catalog_sku_units u WHERE u.business_id=s.business_id AND u.sku_id=COALESCE(fs.id,s.id) AND u.active ORDER BY u.quantity_in_base DESC LIMIT 1) AS free_pack,
      count(DISTINCT l.order_id) FILTER (WHERE l.free_of_line_id IS NULL)::int AS orders,
      COALESCE(sum(l.quantity) FILTER (WHERE l.free_of_line_id IS NULL),0) AS ordered,
      COALESCE(sum(l.dispatched_quantity) FILTER (WHERE l.free_of_line_id IS NULL),0) AS bought,
      COALESCE(sum(l.quantity) FILTER (WHERE l.free_of_line_id IS NOT NULL),0) AS free_ordered,
      COALESCE(sum(l.dispatched_quantity) FILTER (WHERE l.free_of_line_id IS NOT NULL),0) AS free_sent,
      COALESCE(sum(round(l.list_unit_price*l.dispatched_quantity,2)) FILTER (WHERE l.free_of_line_id IS NOT NULL),0) AS free_value,
      COALESCE(sum(GREATEST(0,round(l.list_unit_price*l.dispatched_quantity
        -(l.net+CASE WHEN l.tax_mode='inclusive' THEN l.tax ELSE 0 END)*l.dispatched_quantity/l.quantity,2))) FILTER (WHERE l.free_of_line_id IS NULL AND l.discount_percent>0),0) AS discount_value
    FROM lines l JOIN wholesale_schemes sc ON sc.business_id=$1 AND sc.id=l.scheme_id
    JOIN catalog_skus s ON s.business_id=sc.business_id AND s.id=sc.sku_id
    LEFT JOIN catalog_skus fs ON fs.business_id=sc.business_id AND fs.id=sc.free_sku_id
    GROUP BY l.contact_id,l.contact_name,l.scheme_id,sc.name,s.business_id,s.id,s.label,s.unit,fs.id,fs.label,fs.unit
    ORDER BY (COALESCE(sum(round(l.list_unit_price*l.dispatched_quantity,2)) FILTER (WHERE l.free_of_line_id IS NOT NULL),0)) DESC,l.contact_name,sc.name`,
  [business.id, from, to, business.timezone, contactId, schemeId]);
  const sum = (key) => rupeesOf(rows.reduce((t, r) => t + paise(r[key]), 0));
  return { from, to, rows, totals: { orders: rows.reduce((t, r) => t + r.orders, 0), free_value: sum('free_value'), discount_value: sum('discount_value'),
    retailers: new Set(rows.map((r) => r.contact_id)).size } };
}
const rupeesOf = (p) => (p / 100).toFixed(2);

module.exports = { saveGroup, setGroupPrice, endGroupPrice, reviseGroupPrices, saveScheme, groupPrice, schemeFor, today, schemeReport };
