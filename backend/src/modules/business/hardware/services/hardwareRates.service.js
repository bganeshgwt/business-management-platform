const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');

// Today's rates (module "hardware_rates"): the items whose price moves every
// day (cement, steel, pipes, cable) on one board. Today's prices are saved
// together, each through the core catalogue update (so the MRP check, the
// member price and the audit are those of any price change); a trigger on
// catalog_skus stamps each board item's price before and when it changed,
// whichever screen changed it.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const given = (value) => value !== undefined && value !== null && value !== '';
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
// The most items on one board.
const MOST = 300;

function requireRates(business) {
  if (business.business_type !== 'hardware') fail('Today\'s rates belong to hardware shops', 404);
  if (!business.modules.includes('hardware_rates')) fail('Today\'s rates is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

// The board: each item with today's price, the price before the last change and when it changed.
async function board(business) {
  requireRates(business);
  await access.require(business, 'catalog.view');
  const items = await repo.all(repo.pool, `SELECT s.id,s.code,s.label,s.unit,COALESCE(u.name,s.unit) AS unit_name,s.price,s.mrp,s.tax_rate,s.active,
      c.name AS category_name,r.previous_price,r.price_changed_at,r.added_at
    FROM hardware_rate_items r JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id
    JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
    LEFT JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit
    WHERE r.business_id=$1 ORDER BY c.name NULLS LAST,s.label`, [business.id]);
  const settings = await repo.one(repo.pool, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  return { items, taxMode: settings?.tax_mode || 'exclusive', most: MOST };
}

// body: { skuIds: [id…] } — items already on the board stay as they are.
async function add(business, user, body) {
  requireRates(business);
  await access.require(business, 'catalog.edit');
  const ids = v.requiredArray(body.skuIds, 'Items').map((value) => id(value, 'Item'));
  if (!ids.length || ids.length > 100) fail('Put between 1 and 100 items on the board at once');
  if (new Set(ids).size !== ids.length) fail('Each item may appear once');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const items = await repo.all(db, 'SELECT id,label,active FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, ids]);
    if (items.length !== ids.length) fail('Item not found', 404);
    const off = items.find((s) => !s.active);
    if (off) fail(`${off.label} is switched off: switch it on under Products before putting it on the board`, 409);
    const others = (await repo.one(db, 'SELECT count(*)::int AS n FROM hardware_rate_items WHERE business_id=$1 AND NOT (sku_id=ANY($2::bigint[]))', [business.id, ids])).n;
    if (others + ids.length > MOST) fail(`The board holds up to ${MOST} items`, 409);
    const added = await repo.all(db, `INSERT INTO hardware_rate_items(business_id,sku_id,added_by) SELECT $1,x,$3 FROM unnest($2::bigint[]) x
      ON CONFLICT DO NOTHING RETURNING sku_id`, [business.id, ids, user.id]);
    for (const row of added) {
      await repo.audit(db, business.id, user.id, 'rates.item_added', row.sku_id, { label: items.find((s) => String(s.id) === String(row.sku_id)).label });
    }
    return { added: added.length };
  });
}

// Takes an item off the board; the item and its price stay as they are.
async function remove(business, user, skuId) {
  requireRates(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `DELETE FROM hardware_rate_items r USING catalog_skus s WHERE r.business_id=$1 AND r.sku_id=$2
      AND s.business_id=r.business_id AND s.id=r.sku_id RETURNING s.id,s.label`, [business.id, id(skuId, 'Item')]);
    if (!row) fail('That item is not on the board', 404);
    await repo.audit(db, business.id, user.id, 'rates.item_removed', row.id, { label: row.label });
    return { removed: Number(row.id) };
  });
}

// body: { rates: [{ skuId, price, was? }] } — `was`: the rate the person saw;
// a change made since by someone else is refused rather than overwritten. A
// rate equal to today's changes nothing, so saving twice is harmless.
async function save(business, user, body) {
  requireRates(business);
  await access.require(business, 'catalog.edit');
  const list = v.requiredArray(body.rates, 'Rates');
  if (!list.length || list.length > MOST) fail(`Change between 1 and ${MOST} rates at once`);
  const wanted = list.map((r) => ({ skuId: id(r?.skuId, 'Item'), price: core.decimal(r?.price, 'Rate', 2, 0.01, 10000000),
    was: given(r?.was) ? core.decimal(r.was, 'Rate before', 2, 0, 10000000) : null }));
  if (new Set(wanted.map((r) => r.skuId)).size !== wanted.length) fail('Each item may appear once');
  return repo.transaction(async (db) => {
    const changed = [];
    for (const r of wanted) {
      const sku = await repo.one(db, `SELECT s.*,t.active AS slab_active FROM hardware_rate_items h JOIN catalog_skus s ON s.business_id=h.business_id AND s.id=h.sku_id
        LEFT JOIN business_tax_rates t ON t.business_id=s.business_id AND t.id=s.tax_rate_id WHERE h.business_id=$1 AND h.sku_id=$2 FOR UPDATE OF s`, [business.id, r.skuId]);
      if (!sku) fail('That item is not on the board', 404);
      if (r.was !== null && paise(sku.price) !== paise(r.was)) {
        fail(`The rate of ${sku.label} was changed to ${Number(sku.price).toFixed(2)} since you opened the board. Open it again to see today's rates.`, 409);
      }
      if (paise(sku.price) === paise(r.price)) continue;
      // Only the price changes: the item keeps its name, GST slab, MRP and everything else.
      await core.updateCatalog(business, user, sku.id, { label: sku.label, price: r.price.toFixed(2), active: sku.active,
        ...(sku.tax_rate_id && sku.slab_active ? { taxRateId: sku.tax_rate_id } : { taxRate: sku.tax_rate }) }, db);
      changed.push({ skuId: Number(sku.id), label: sku.label, from: sku.price, to: r.price.toFixed(2) });
    }
    if (changed.length) await repo.event(db, business.id, user.id, 'rates.changed', 'business', business.id, { rates: changed });
    return { changed };
  });
}

// An item's rate changes, newest first, as the activity log keeps every
// price change from any screen: the day and time, the rate before and after,
// who changed it, and the receipt that set it (a purchase's new selling price).
// query: { limit? } (up to 200).
async function history(business, skuId, query = {}) {
  requireRates(business);
  await access.require(business, 'catalog.view');
  const limit = query.limit === undefined ? 50 : Math.min(200, id(query.limit, 'How many'));
  const item = await repo.one(repo.pool, `SELECT s.id,s.label,s.unit,s.price,s.mrp,(r.sku_id IS NOT NULL) AS on_board FROM catalog_skus s
    LEFT JOIN hardware_rate_items r ON r.business_id=s.business_id AND r.sku_id=s.id WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(skuId, 'Item')]);
  if (!item) fail('Item not found', 404);
  const changes = await repo.all(repo.pool, `SELECT a.id,a.created_at AS changed_at,u.name AS changed_by_name,a.details->>'from' AS from_price,a.details->>'to' AS to_price,
      a.details->>'documentNo' AS document_no
    FROM business_audit a JOIN users u ON u.id=a.actor_id
    WHERE a.business_id=$1 AND a.entity_id=$2 AND a.action='catalog.price_changed' AND (a.details->>'from')::numeric IS DISTINCT FROM (a.details->>'to')::numeric
    ORDER BY a.id DESC LIMIT $3`, [business.id, item.id, limit]);
  return { item, changes };
}

module.exports = { requireRates, board, add, remove, save, history };
