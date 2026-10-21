const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');

// A branch's own selling price for an item (business_sku_location_prices).
// The counter, quotes and posting read it through businessPricing.salePrice;
// a branch with no row sells at the item's own price. An offer, a member
// price or a customer rule still applies on top, as for any price.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const core = () => require('./business.service');

async function itemOf(db, business, skuId) {
  const sku = await repo.one(db, 'SELECT id,label,price,tax_rate,mrp FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, v.requiredId(skuId, 'Item')]);
  if (!sku) fail('Item not found', 404);
  return sku;
}

// Every active branch with its price for this item (null: the item's own).
async function forItem(business, skuId) {
  await access.require(business, 'catalog.view');
  const sku = await itemOf(repo.pool, business, skuId);
  const rows = await repo.all(repo.pool, `SELECT l.id AS location_id,l.name AS location_name,p.price,p.updated_at
    FROM business_locations l LEFT JOIN business_sku_location_prices p ON p.business_id=l.business_id AND p.location_id=l.id AND p.sku_id=$2
    WHERE l.business_id=$1 AND l.active ORDER BY l.id`, [business.id, sku.id]);
  return { sku_id: sku.id, price: sku.price, branches: rows };
}

// One branch's own prices, for its counter shelf.
async function forLocation(business, query) {
  await access.requireAny(business, ['sales.create', 'catalog.view']);
  const locationId = v.requiredId(query.location, 'Location');
  access.requireLocation(business, locationId);
  return repo.all(repo.pool, 'SELECT sku_id,price FROM business_sku_location_prices WHERE business_id=$1 AND location_id=$2 ORDER BY sku_id', [business.id, locationId]);
}

// body.prices: [{ locationId, price }] — a price sets the branch's own; an
// empty price goes back to the item's price. Branches not named keep theirs.
async function save(business, user, skuId, body) {
  await access.require(business, 'catalog.edit');
  const list = v.requiredArray(body.prices, 'Prices');
  if (!list.length || list.length > 200) fail('Give between 1 and 200 branch prices');
  return repo.transaction(async (db) => {
    const sku = await itemOf(db, business, skuId);
    await db.query('SELECT id FROM catalog_skus WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, sku.id]);
    const taxMode = (await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]))?.tax_mode || 'exclusive';
    const seen = new Set();
    const changes = [];
    for (const entry of list) {
      const locationId = v.requiredId(entry?.locationId, 'Branch');
      if (seen.has(String(locationId))) fail('A branch appears twice');
      seen.add(String(locationId));
      // A manager tied to one branch sets that branch's prices only.
      access.requireLocation(business, locationId);
      const location = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
      if (!location) fail('Branch not found or closed', 404);
      const before = await repo.one(db, 'SELECT price FROM business_sku_location_prices WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [business.id, sku.id, location.id]);
      const empty = entry.price === undefined || entry.price === null || String(entry.price).trim() === '';
      if (empty) {
        if (!before) continue;
        await db.query('DELETE FROM business_sku_location_prices WHERE business_id=$1 AND sku_id=$2 AND location_id=$3', [business.id, sku.id, location.id]);
        changes.push({ locationId: location.id, branch: location.name, from: before.price, to: null });
        continue;
      }
      const price = core().decimal(entry.price, `Price at ${location.name}`);
      if (price <= 0) fail(`The price at ${location.name} must be more than zero`);
      core().checkMrp(`${sku.label} at ${location.name}`, price, sku.tax_rate, taxMode, sku.mrp);
      if (before && Number(before.price) === price) continue;
      await db.query(`INSERT INTO business_sku_location_prices(business_id,sku_id,location_id,price,updated_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(business_id,sku_id,location_id) DO UPDATE SET price=EXCLUDED.price,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [business.id, sku.id, location.id, price.toFixed(2), user.id]);
      changes.push({ locationId: location.id, branch: location.name, from: before?.price || null, to: price.toFixed(2) });
    }
    if (changes.length) await repo.audit(db, business.id, user.id, 'catalog.branch_price_changed', sku.id, { label: sku.label, changes });
    return { changed: changes.length, ...(await forItemIn(db, business, sku)) };
  });
}
async function forItemIn(db, business, sku) {
  const branches = await repo.all(db, `SELECT l.id AS location_id,l.name AS location_name,p.price,p.updated_at
    FROM business_locations l LEFT JOIN business_sku_location_prices p ON p.business_id=l.business_id AND p.location_id=l.id AND p.sku_id=$2
    WHERE l.business_id=$1 AND l.active ORDER BY l.id`, [business.id, sku.id]);
  return { sku_id: sku.id, price: sku.price, branches };
}

module.exports = { forItem, forLocation, save };
