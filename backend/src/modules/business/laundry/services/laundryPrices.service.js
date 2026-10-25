const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./laundryCommon');

// The price list (module "laundry", laundries and dry cleaners).
//
//   services   each service the shop offers, billed as a service item of the
//              catalogue: an existing one chosen, or one made with the service
//              (its name, GST slab and SAC typed with it). Its name on the
//              bill, its GST slab and its SAC come from the item: laundry, dry
//              cleaning, pressing and dyeing are in SAC group 99971, at 18%
//              with input tax credit. Switched off, never deleted.
//   garments   each kind of garment taken in, counted as a piece, a pair (two
//              pieces) or a set of pieces. Switched off, never deleted.
//   prices     a garment and a service at a price for each one (as the
//              garment is counted) or by the kilo. A price changes in place;
//              the activity log keeps every change, and an order keeps the
//              prices it was taken in at.
//   settings   when an order is billed, what a handover of part of an order
//              needs paid, the express surcharge, the days to the promised day
//              and until a ready order is unclaimed, and the shop's terms
//              printed on every receipt.

const { fail, id } = c;
const MAX_PRICE = 1000000;
const MAX_TERMS = 2000;

const whole = (value, name, min, max) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return Number(text);
};

// --- Reading the price list ------------------------------------------------------------------------

const SERVICES_SQL = `SELECT ls.id,ls.sku_id,ls.sort_order,ls.active,s.label AS name,s.code AS item_code,s.tax_rate,s.tax_rate_id,s.hsn_code,s.unit,
    (s.active AND p.active) AS item_active,
    (SELECT count(*)::int FROM laundry_prices lp WHERE lp.business_id=ls.business_id AND lp.service_id=ls.id) AS prices
  FROM laundry_services ls JOIN catalog_skus s ON s.business_id=ls.business_id AND s.id=ls.sku_id
  JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  WHERE ls.business_id=$1 ORDER BY ls.active DESC,ls.sort_order,lower(s.label),ls.id`;
const GARMENTS_SQL = `SELECT g.id,g.name,g.counted_as,g.pieces,g.sort_order,g.active,
    (SELECT count(*)::int FROM laundry_prices lp WHERE lp.business_id=g.business_id AND lp.garment_type_id=g.id) AS prices
  FROM laundry_garment_types g WHERE g.business_id=$1 ORDER BY g.active DESC,g.sort_order,lower(g.name),g.id`;

async function load(db, business) {
  const services = await repo.all(db, SERVICES_SQL, [business.id]);
  const garments = await repo.all(db, GARMENTS_SQL, [business.id]);
  const prices = await repo.all(db, `SELECT p.garment_type_id,p.service_id,p.per,p.price,p.updated_at,u.name AS updated_by_name FROM laundry_prices p JOIN users u ON u.id=p.updated_by
    WHERE p.business_id=$1 ORDER BY p.garment_type_id,p.service_id`, [business.id]);
  const settings = await c.settingsOf(db, business.id);
  return { services, garments, prices, settings: settingsShape(settings) };
}

async function priceList(business) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  return load(repo.pool, business);
}

// --- Services --------------------------------------------------------------------------------------

// A free item code for a new service's item: LND-01, LND-02 ….
async function freeCode(db, businessId) {
  const count = await repo.one(db, 'SELECT count(*)::int AS n FROM laundry_services WHERE business_id=$1', [businessId]);
  for (let n = count.n + 1; ; n += 1) {
    const code = `LND-${String(n).padStart(2, '0')}`;
    if (!await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [businessId, code])) return code;
  }
}

async function insertService(db, business, user, skuId, sortOrder) {
  const taken = await repo.one(db, 'SELECT 1 FROM laundry_services WHERE business_id=$1 AND sku_id=$2', [business.id, skuId]);
  if (taken) fail('That item is already one of the laundry\'s services', 409);
  const row = await repo.one(db, 'INSERT INTO laundry_services(business_id,sku_id,sort_order,created_by,updated_by) VALUES($1,$2,$3,$4,$4) RETURNING *',
    [business.id, skuId, sortOrder, user.id]);
  const sku = await repo.one(db, 'SELECT label,tax_rate,hsn_code FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, skuId]);
  await repo.audit(db, business.id, user.id, 'laundry_service.created', row.id, { name: sku.label, skuId, taxRate: sku.tax_rate, sac: sku.hsn_code });
  return row;
}

// body: { skuId } an existing service item, or { item: { name, taxRateId, hsnCode? } }
// for a new one; sortOrder?
async function createService(business, user, body) {
  c.requireLaundry(business);
  await access.require(business, 'catalog.edit');
  const sortOrder = c.given(body.sortOrder) ? whole(body.sortOrder, 'Order on the list', 0, 999) : 0;
  if (c.given(body.skuId)) {
    return repo.transaction(async (db) => {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.is_kit,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(body.skuId, 'Service item')]);
      if (!sku) fail('Service item not found', 404);
      if (sku.kind !== 'service' || sku.is_kit) fail(`${sku.label} is not a service: a laundry service is billed as a service item`);
      await insertService(db, business, user, sku.id, sortOrder);
      return load(db, business);
    });
  }
  const item = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? body.item : null;
  if (!item) fail('Give the service\'s item: a new one with its name and GST slab, or an existing service item');
  const name = v.requiredString(typeof item.name === 'string' ? item.name : '', 'Service name', 150);
  // A new service item: priced on the price list, so its own price is nil; its
  // GST slab is the one chosen, or the business's default slab (18% for a laundry).
  const code = await freeCode(repo.pool, business.id);
  const slab = c.given(item.taxRateId) ? id(item.taxRateId, 'GST slab')
    : (await repo.one(repo.pool, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND is_default AND active', [business.id]))?.id;
  if (!slab) fail('Choose the service\'s GST slab');
  await core.createCatalog(business, user, { kind: 'service', unit: 'service', name, label: name, code, price: '0', taxRateId: slab, hsnCode: item.hsnCode },
    async (db, sku) => { await insertService(db, business, user, sku.id, sortOrder); });
  return load(repo.pool, business);
}

// body: { active?, sortOrder? }
async function updateService(business, user, serviceId, body) {
  c.requireLaundry(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM laundry_services WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(serviceId, 'Service')]);
    if (!current) fail('Service not found', 404);
    const active = v.requiredBoolean(body.active, 'Offered', current.active);
    const sortOrder = c.given(body.sortOrder) ? whole(body.sortOrder, 'Order on the list', 0, 999) : current.sort_order;
    await db.query('UPDATE laundry_services SET active=$3,sort_order=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, current.id, active, sortOrder, user.id]);
    const changed = Object.entries({ active: [current.active, active], sortOrder: [current.sort_order, sortOrder] }).filter(([, [from, to]]) => from !== to);
    if (changed.length) await repo.audit(db, business.id, user.id, 'laundry_service.updated', current.id, Object.fromEntries(changed.map(([k, [from, to]]) => [k, { from, to }])));
    return load(db, business);
  });
}

// --- Garments ----------------------------------------------------------------------------------------

// { name, countedAs: piece | pair | set, pieces (a set's pieces), sortOrder? }
function readGarment(body, current = null) {
  const name = body.name === undefined && current ? current.name : v.requiredString(typeof body.name === 'string' ? body.name : '', 'Garment', 80);
  const countedAs = body.countedAs === undefined && current ? current.counted_as : v.requiredEnum(body.countedAs ?? 'piece', 'Counted as', c.COUNTED_AS);
  let pieces = 1;
  if (countedAs === 'pair') pieces = 2;
  if (countedAs === 'set') pieces = body.pieces === undefined && current?.counted_as === 'set' ? current.pieces : whole(body.pieces, 'Pieces in the set', 2, 20);
  const sortOrder = c.given(body.sortOrder) ? whole(body.sortOrder, 'Order on the list', 0, 999) : current ? current.sort_order : 0;
  return { name, countedAs, pieces, sortOrder };
}
async function nameFree(db, businessId, name, exceptId = null) {
  const same = await repo.one(db, 'SELECT id FROM laundry_garment_types WHERE business_id=$1 AND lower(name)=lower($2) AND ($3::bigint IS NULL OR id<>$3)', [businessId, name, exceptId]);
  if (same) fail(`${name} is already on the price list`, 409);
}

async function createGarment(business, user, body) {
  c.requireLaundry(business);
  await access.require(business, 'catalog.edit');
  const garment = readGarment(body);
  return repo.transaction(async (db) => {
    await nameFree(db, business.id, garment.name);
    const row = await repo.one(db, `INSERT INTO laundry_garment_types(business_id,name,counted_as,pieces,sort_order,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [business.id, garment.name, garment.countedAs, garment.pieces, garment.sortOrder, user.id]);
    await repo.audit(db, business.id, user.id, 'laundry_garment.created', row.id, { name: row.name, countedAs: row.counted_as, pieces: row.pieces });
    return load(db, business);
  });
}

// body: { name?, countedAs?, pieces?, sortOrder?, active? } — orders keep the garment as it was taken in.
async function updateGarment(business, user, garmentId, body) {
  c.requireLaundry(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM laundry_garment_types WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(garmentId, 'Garment')]);
    if (!current) fail('Garment not found', 404);
    const garment = readGarment(body, current);
    const active = v.requiredBoolean(body.active, 'Taken in', current.active);
    if (garment.name.toLowerCase() !== current.name.toLowerCase()) await nameFree(db, business.id, garment.name, current.id);
    await db.query(`UPDATE laundry_garment_types SET name=$3,counted_as=$4,pieces=$5,sort_order=$6,active=$7,updated_by=$8,updated_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, current.id, garment.name, garment.countedAs, garment.pieces, garment.sortOrder, active, user.id]);
    const changed = Object.entries({ name: [current.name, garment.name], countedAs: [current.counted_as, garment.countedAs], pieces: [current.pieces, garment.pieces],
      sortOrder: [current.sort_order, garment.sortOrder], active: [current.active, active] }).filter(([, [from, to]]) => String(from) !== String(to));
    if (changed.length) await repo.audit(db, business.id, user.id, 'laundry_garment.updated', current.id, { name: garment.name, ...Object.fromEntries(changed.map(([k, [from, to]]) => [k, { from, to }])) });
    return load(db, business);
  });
}

// --- Prices ------------------------------------------------------------------------------------------

// body: { prices: [{ garmentTypeId, serviceId, per: item | kg, price }] }; a price
// that is empty (null or "") takes the garment and service off the price list.
async function setPrices(business, user, body) {
  c.requireLaundry(business);
  await access.require(business, 'catalog.edit');
  const list = v.requiredArray(body.prices, 'Prices');
  if (!list.length || list.length > 500) fail('Give from 1 to 500 prices at a time');
  const read = list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`Price ${index + 1} must be an object`);
    const removing = entry.price === null || entry.price === '';
    return {
      garmentTypeId: id(entry.garmentTypeId, 'Garment'), serviceId: id(entry.serviceId, 'Service'),
      per: removing ? null : v.requiredEnum(entry.per ?? 'item', 'Priced', ['item', 'kg']),
      price: removing ? null : core.decimal(entry.price, 'Price', 2, 0.01, MAX_PRICE),
    };
  });
  const pairs = read.map((p) => `${p.garmentTypeId}:${p.serviceId}`);
  if (new Set(pairs).size !== pairs.length) fail('Each garment and service is priced once');
  return repo.transaction(async (db) => {
    const garments = await repo.all(db, 'SELECT id,name FROM laundry_garment_types WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, [...new Set(read.map((p) => p.garmentTypeId))]]);
    const services = await repo.all(db, `SELECT ls.id,s.label AS name FROM laundry_services ls JOIN catalog_skus s ON s.business_id=ls.business_id AND s.id=ls.sku_id
      WHERE ls.business_id=$1 AND ls.id=ANY($2::bigint[])`, [business.id, [...new Set(read.map((p) => p.serviceId))]]);
    for (const p of read) {
      const garment = garments.find((g) => Number(g.id) === p.garmentTypeId);
      const service = services.find((s) => Number(s.id) === p.serviceId);
      if (!garment) fail('Garment not found', 404);
      if (!service) fail('Service not found', 404);
      const before = await repo.one(db, 'SELECT per,price FROM laundry_prices WHERE business_id=$1 AND garment_type_id=$2 AND service_id=$3 FOR UPDATE', [business.id, p.garmentTypeId, p.serviceId]);
      if (p.price === null) {
        if (!before) continue;
        await db.query('DELETE FROM laundry_prices WHERE business_id=$1 AND garment_type_id=$2 AND service_id=$3', [business.id, p.garmentTypeId, p.serviceId]);
      } else {
        if (before && before.per === p.per && Number(before.price) === p.price) continue;
        await db.query(`INSERT INTO laundry_prices(business_id,garment_type_id,service_id,per,price,updated_by) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT (business_id,garment_type_id,service_id) DO UPDATE SET per=EXCLUDED.per,price=EXCLUDED.price,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [business.id, p.garmentTypeId, p.serviceId, p.per, p.price.toFixed(2), user.id]);
      }
      await repo.audit(db, business.id, user.id, 'laundry_price.changed', p.garmentTypeId, { garment: garment.name, service: service.name,
        from: before ? { per: before.per, price: before.price } : null, to: p.price === null ? null : { per: p.per, price: p.price.toFixed(2) } });
    }
    return load(db, business);
  });
}

// --- Settings ----------------------------------------------------------------------------------------

const settingsShape = (s) => ({ billAt: s.bill_at, partDelivery: s.part_delivery, expressPercent: Number(s.express_percent).toFixed(2), readyDays: Number(s.ready_days),
  expressDays: Number(s.express_days), unclaimedDays: Number(s.unclaimed_days), receiptTerms: s.receipt_terms, updatedAt: s.updated_at });

async function settings(business) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  return settingsShape(await c.settingsOf(repo.pool, business.id));
}

// body: { billAt?, partDelivery?, expressPercent?, readyDays?, expressDays?, unclaimedDays?, receiptTerms? } — what is left out stays.
// Orders keep the rules they were taken in under.
async function saveSettings(business, user, body) {
  c.requireLaundry(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    const before = await c.settingsOf(db, business.id);
    const next = {
      bill_at: body.billAt === undefined ? before.bill_at : v.requiredEnum(body.billAt, 'Billed', ['delivery', 'intake']),
      part_delivery: body.partDelivery === undefined ? before.part_delivery : v.requiredEnum(body.partDelivery, 'Part of an order handed over', ['whole_order', 'garments']),
      express_percent: body.expressPercent === undefined ? Number(before.express_percent) : core.decimal(body.expressPercent, 'Express surcharge', 2, 0, 200),
      ready_days: body.readyDays === undefined ? before.ready_days : whole(body.readyDays, 'Days to the promised day', 0, 60),
      express_days: body.expressDays === undefined ? before.express_days : whole(body.expressDays, 'Days to the promised day for express', 0, 60),
      unclaimed_days: body.unclaimedDays === undefined ? before.unclaimed_days : whole(body.unclaimedDays, 'Days until unclaimed', 1, 365),
      receipt_terms: body.receiptTerms === undefined ? before.receipt_terms : c.optionalText(body.receiptTerms, 'Terms on the receipt', MAX_TERMS),
    };
    if (next.express_days > next.ready_days) fail('An express order is promised no later than an ordinary one: its days are at most the days to the promised day');
    await db.query(`INSERT INTO laundry_settings(business_id,bill_at,part_delivery,express_percent,ready_days,express_days,unclaimed_days,receipt_terms,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (business_id) DO UPDATE SET bill_at=EXCLUDED.bill_at,part_delivery=EXCLUDED.part_delivery,
      express_percent=EXCLUDED.express_percent,ready_days=EXCLUDED.ready_days,express_days=EXCLUDED.express_days,unclaimed_days=EXCLUDED.unclaimed_days,
      receipt_terms=EXCLUDED.receipt_terms,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, next.bill_at, next.part_delivery, next.express_percent.toFixed(2), next.ready_days, next.express_days, next.unclaimed_days, next.receipt_terms, user.id]);
    const was = { ...before, express_percent: Number(before.express_percent) };
    const changed = Object.keys(next).filter((k) => String(was[k] ?? '') !== String(next[k] ?? ''));
    if (changed.length) await repo.audit(db, business.id, user.id, 'laundry_settings.updated', null, Object.fromEntries(changed.map((k) => [k, { from: was[k], to: next[k] }])));
    return settingsShape(await c.settingsOf(db, business.id));
  });
}

module.exports = { priceList, createService, updateService, createGarment, updateGarment, setPrices, settings, saveSettings };
