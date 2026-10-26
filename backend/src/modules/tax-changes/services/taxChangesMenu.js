const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const changes = require('./taxChanges.service');
const money = require('./taxChangesMoney');

// GST rate changes for a restaurant's dishes: a dish moves to another of the
// restaurant's tax rates on the restaurant's own date, its trading day
// (business-day/services/tradingDay.js). See taxChanges.service.js for the
// flows. The routes check menu.view and menu.manage.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };

// --- Taking effect ----------------------------------------------------------------------

// Changes due on `day` (null: the restaurant's trading day) take effect (the
// database's business_tax_change_apply_menu, under the menu's lock). Returns
// the dishes moved now.
async function applyDue(db, restaurantId, day = null) {
  const row = await repo.one(db, 'SELECT business_tax_change_apply_menu($1,$2::date) AS applied', [restaurantId, day]);
  return (row?.applied || []).map(Number);
}

// Before the menu screens (the POS reads the menu there too) and the guests'
// menus: the dishes show the rate and price of the trading day. A failure here
// never stops the request: an order applies due changes again.
async function onMenu(restaurantId) {
  if (!restaurantId) return;
  try {
    await applyDue(repo.pool, restaurantId);
  } catch (error) {
    console.error(`GST rate changes of restaurant ${restaurantId} could not be applied before this request: ${error.message}`);
  }
}

// Before an order's dishes are priced (orders/services/order.service.js
// priceLines), on its own connection: changes due on the order's business day
// take effect, and a dish whose change took effect for a later day (an outlet
// still on last night's day while another has opened today's) is priced as it
// was before it. Returns, by dish, what it was: { rate, hsn, price, sizes }.
async function forOrderDay(db, restaurantId, productIds, { day = null, businessDayId = null } = {}) {
  const when = await repo.one(db, `SELECT COALESCE($2::date,(SELECT business_date FROM business_days WHERE restaurant_id=$1 AND id=$3),
    restaurant_trading_date($1))::text AS day`, [restaurantId, day, businessDayId]);
  await applyDue(db, restaurantId, when.day);
  if (!productIds.length) return new Map();
  const rows = await repo.all(db, `SELECT DISTINCT ON (i.product_id) i.product_id,i.from_rate,t.hsn_code,i.price_before,i.sizes
    FROM business_tax_change_items i JOIN businesses b ON b.id=i.business_id AND b.legacy_restaurant_id=$1
    LEFT JOIN tax_rates t ON t.id=i.from_restaurant_tax_rate_id
    WHERE i.status='applied' AND i.product_id=ANY($2::bigint[]) AND i.starts_on>$3::date
    ORDER BY i.product_id,i.starts_on,i.id`, [restaurantId, productIds, when.day]);
  return new Map(rows.map((row) => [Number(row.product_id), {
    rate: row.from_rate, hsn: row.hsn_code || null, price: row.price_before,
    sizes: new Map((row.sizes || []).map((size) => [Number(size.id), size.before])),
  }]));
}

// The first GST rate change that names a dish, or null. Such a dish is kept,
// archived rather than deleted: its GST history needs it.
async function namedIn(productId) {
  const row = await repo.one(repo.pool, 'SELECT min(starts_on)::text AS starts_on FROM business_tax_change_items WHERE product_id=$1', [productId]);
  return row?.starts_on ? { startsOn: row.starts_on, words: money.dateWords(row.starts_on) } : null;
}

// --- The restaurant's dishes --------------------------------------------------------------

const SCHEDULED = `COALESCE((SELECT json_agg(json_build_object('changeId',i.change_id,'startsOn',i.starts_on::text,'rate',xt.percentage,'name',xt.name,'keeps',x.keeps)
    ORDER BY i.starts_on) FROM business_tax_change_items i
    JOIN business_tax_changes x ON x.business_id=i.business_id AND x.id=i.change_id
    JOIN tax_rates xt ON xt.id=x.restaurant_tax_rate_id
    WHERE i.product_id=p.id AND i.status='scheduled'),'[]')`;

// Dishes to look at for a change: the ones named, or the ones a filter finds
// (by tax rate, category, HSN / SAC code, a search).
function candidates(db, restaurantId, { ids = null, filters = null, limit = changes.MAX_ITEMS }) {
  const f = filters || {};
  return repo.all(db, `SELECT p.id,p.code,p.name AS label,p.price,p.mrp,p.tax_percentage AS tax_rate,p.tax_rate_id,p.tax_mode,(p.status='active') AS active,
      t.name AS slab_name,t.hsn_code,c.name AS category,COALESCE(st.tax_mode,'exclusive')='inclusive' AS restaurant_inclusive,
      ${SCHEDULED} AS scheduled
    FROM products p JOIN categories c ON c.id=p.category_id
    LEFT JOIN tax_rates t ON t.id=p.tax_rate_id
    LEFT JOIN restaurant_settings st ON st.restaurant_id=p.restaurant_id
    WHERE p.restaurant_id=$1
      AND ($2::bigint[] IS NULL OR p.id=ANY($2::bigint[]))
      AND ($3::bigint IS NULL OR p.tax_rate_id=$3)
      AND ($4::bigint IS NULL OR p.category_id=$4)
      AND ($5::text IS NULL OR t.hsn_code LIKE $5 || '%')
      AND ($6::text IS NULL OR concat_ws(' ',p.name,p.code,p.kitchen_name) ILIKE $6)
      AND ($7::boolean OR $2::bigint[] IS NOT NULL OR p.status='active')
    ORDER BY lower(p.name),p.id LIMIT $8`,
  [restaurantId, ids, f.taxRateId ?? null, f.categoryId ?? null, f.hsn ?? null, f.q ? `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null,
    Boolean(f.inactive), limit]);
}

// The world of a restaurant, for taxChanges.service.js. `user` is the signed-in
// restaurant user (req.user).
function world(user) {
  const restaurantId = user.restaurantId;
  if (!restaurantId) fail('This account is not linked to a restaurant', 400);
  return {
    kind: 'menu', itemColumn: 'product_id', targetColumn: 'restaurant_tax_rate_id',
    words: { item: 'dish', Item: 'Dish', items: 'dishes', fromToday: 'To change a dish\'s GST from today, change its tax rate on the dish itself.' },
    // The restaurant's business row holds its changes; it is made when the first change is.
    businessId: async (db, make) => (make
      ? (await repo.one(db, 'SELECT restaurant_business_id($1) AS id', [restaurantId])).id
      : (await repo.one(db, 'SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [restaurantId]))?.id || null),
    requireView: async () => {},
    requireEdit: async () => {},
    // The lock the menu's imports and price revisions take.
    lock: (db) => db.query('SELECT pg_advisory_xact_lock(915001,$1::int)', [restaurantId]),
    applyDue: (db) => applyDue(db, restaurantId),
    today: async (db) => (await repo.one(db, 'SELECT restaurant_trading_date($1)::text AS day', [restaurantId])).day,
    target: async (db, id) => {
      const rate = await repo.one(db, "SELECT id,name,percentage AS rate FROM tax_rates WHERE restaurant_id=$1 AND id=$2 AND status='active'", [restaurantId, id]);
      if (!rate) fail('Tax rate not found, or switched off', 404);
      return rate;
    },
    candidates: (db, options) => candidates(db, restaurantId, options),
    // A dish's own price mode, or the restaurant's.
    inclusive: (row) => row.tax_mode === 'inclusive' || (row.tax_mode === 'default' && row.restaurant_inclusive),
    typeProblem: () => null,
    audit: (db, action, entityId, details) => db.query(`INSERT INTO audit_logs(restaurant_id,user_id,user_name,action,entity_type,entity_id,entity_label,details)
      VALUES($1,$2,$3,$4,'tax_change',$5,$6,$7)`, [restaurantId, user.id, user.name || null, action.replace('tax_change.', ''), entityId,
      `GST rate change of ${money.dateWords(details.startsOn)}`, JSON.stringify(details)]),
    item: async (db, productId) => {
      const dish = await repo.one(db, `SELECT p.id,p.name AS label,p.code,p.tax_percentage AS tax_rate,p.tax_rate_id,t.name AS slab_name,p.price,(p.status='active') AS active
        FROM products p LEFT JOIN tax_rates t ON t.id=p.tax_rate_id WHERE p.restaurant_id=$1 AND p.id=$2`, [restaurantId, v.requiredId(productId, 'Product id')]);
      if (!dish) fail('Product not found', 404);
      return dish;
    },
    // Each time its tax rate was changed on the dish itself, or by an import.
    edits: (db, dish) => repo.all(db, `SELECT a.id,a.created_at,a.details,a.user_name AS actor_name FROM audit_logs a
      WHERE a.restaurant_id=$1 AND a.entity_type='product' AND a.entity_id=$2 AND a.details->'changes' ? 'taxRate'
        AND COALESCE(a.details->>'via','') NOT LIKE 'GST rate change of %' ORDER BY a.id DESC LIMIT 100`, [restaurantId, dish.id]),
  };
}

const list = (user) => changes.listAll(world(user));
const preview = (user, body) => changes.preview(world(user), body);
const schedule = (user, body) => changes.schedule(world(user), user, body);
const detail = (user, changeId) => changes.detail(world(user), changeId);
const history = (user, productId) => changes.history(world(user), productId);
const cancel = (user, changeId, body) => changes.cancel(world(user), user, changeId, body);
const cancelItem = (user, changeId, itemId, body) => changes.cancel(world(user), user, changeId, body, itemId);

module.exports = { applyDue, onMenu, forOrderDay, namedIn, list, preview, schedule, detail, history, cancel, cancelItem };
