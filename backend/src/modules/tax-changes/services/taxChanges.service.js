const crypto = require('node:crypto');
const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const money = require('./taxChangesMoney');

// GST rate changes: one model for both engines, as tasks are (ARCHITECTURE
// §4.3). A change moves items to another GST rate from a date; it is entered
// ahead, cancelled before its date if need be, and kept for good once its
// date comes (the database applies it then: the migration
// 1791973000000_gst-rates-by-date says how).
//
// Everything here works from a `world` (taxChangesShop.js, taxChangesMenu.js):
//   kind                 'shop' (catalogue items, slabs) or 'menu' (dishes, tax rates)
//   words                { item, items, rate } and how to change an item from today
//   businessId(db, make) the business the changes belong to (a restaurant's is made when first needed)
//   requireView() / requireEdit()
//   lock(db)             the lock a change takes (a shop's postings, a menu's imports)
//   applyDue(db)         changes whose date has come take effect first
//   today(db)            the business's or restaurant's own date
//   target(db, id)       the rate items move to: { id, name, rate }
//   candidates(db, { ids, filters })  items with label, code, category, hsn, unit, price, mrp,
//                        tax_rate, tax_rate_id, slab_name, active and `scheduled` (their changes still to come)
//   inclusive(row)       whether the item's price includes GST
//   typeProblem(row, target)  why a type keeps this item where it is, or null
//   documents(db, ids)   open quotations and sales orders holding these items (a shop's), or []
//   audit(db, action, entityId, details)

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const MAX_ITEMS = 2000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const readKeeps = (value) => (value === undefined || value === null || value === '' ? 'total' : v.requiredEnum(value, 'What a price that includes GST keeps', ['total', 'net']));
function readIds(value, words) {
  const list = v.requiredArray(value, `The ${words.items}`);
  if (!list.length) fail(`Choose the ${words.items} that move`);
  if (list.length > MAX_ITEMS) fail(`A change moves at most ${MAX_ITEMS} ${words.items}: make two changes`);
  const ids = list.map((item) => v.requiredId(item, words.Item));
  if (new Set(ids).size !== ids.length) fail(`A ${words.item} is chosen twice`);
  return ids;
}
// What to look at: the items named, or those a filter finds.
function readFilters(body) {
  const f = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters) ? body.filters : {};
  const idOrNull = (value, name) => (value === undefined || value === null || value === '' ? null : v.requiredId(value, name));
  const hsn = v.optionalString(f.hsn, 'HSN / SAC code', 8);
  if (hsn && !/^\d{2,8}$/.test(hsn)) fail('Search by the first digits of an HSN or SAC code (2 to 8 digits)');
  return {
    taxRateId: idOrNull(f.taxRateId, 'Current GST rate'), categoryId: idOrNull(f.categoryId, 'Category'), hsn: hsn || null,
    q: v.optionalString(f.q, 'Search', 100) || null, inactive: v.requiredBoolean(f.inactive, 'Switched-off items too', false),
  };
}

// --- What each item would become ------------------------------------------------------

// One item at a change: its rate and price on the day before (its own now,
// moved by any change it has on an earlier day), and on the day.
function previewOf(world, row, target, startsOn, keeps) {
  const inclusive = world.inclusive(row);
  let rate = Number(row.tax_rate), price = money.paise(row.price), slab = row.slab_name || money.rateWords(rate);
  const scheduled = Array.isArray(row.scheduled) ? row.scheduled : [];
  for (const earlier of scheduled.filter((s) => s.startsOn < startsOn)) {
    price = money.priceAfter(price, rate, earlier.rate, { inclusive, keeps: earlier.keeps });
    rate = Number(earlier.rate);
    slab = earlier.name;
  }
  const same = money.basis(rate) === money.basis(target.rate);
  const after = money.priceAfter(price, rate, target.rate, { inclusive, keeps });
  const before = money.unitFigures(price, rate, inclusive);
  const then = money.unitFigures(after, target.rate, inclusive);
  let problem = world.typeProblem(row, target);
  const sameDay = scheduled.find((s) => s.startsOn === startsOn);
  if (!problem && sameDay) problem = `${row.label} already moves to ${sameDay.name} on ${money.dateWords(startsOn)} (another GST rate change)`;
  if (!problem && !same && row.mrp !== null && row.mrp !== undefined && then.total > money.paise(row.mrp)) {
    problem = `${row.label} would sell at ${money.rupees(then.total)}${inclusive ? '' : ' with GST'}, above its MRP of ${money.rupees(money.paise(row.mrp))}`;
  }
  return {
    id: Number(row.id), code: row.code || null, label: row.label, category: row.category || null, hsn: row.hsn_code || null, unit: row.unit || null,
    active: row.active !== false, pricesIncludeGst: inclusive,
    from: { rate: Number(rate).toFixed(2), name: slab }, to: { rate: Number(target.rate).toFixed(2), name: target.name },
    price: { before: money.rupees(price), after: money.rupees(after) },
    gst: { before: money.rupees(before.tax), after: money.rupees(then.tax) },
    total: { before: money.rupees(before.total), after: money.rupees(then.total) },
    mrp: row.mrp === null || row.mrp === undefined ? null : Number(row.mrp).toFixed(2),
    same, problem,
  };
}

async function preview(world, body) {
  await world.requireEdit();
  const startsOn = readDate(body.startsOn, 'Start date');
  const keeps = readKeeps(body.keeps);
  const targetId = v.requiredId(body.taxRateId, 'New GST rate');
  const ids = body.items === undefined || body.items === null ? null : readIds(body.items, world.words);
  const filters = ids ? null : readFilters(body);
  return repo.transaction(async (db) => {
    await world.applyDue(db);
    const today = await world.today(db);
    const target = await world.target(db, targetId);
    const rows = await world.candidates(db, { ids, filters, limit: MAX_ITEMS + 1 });
    const items = rows.slice(0, MAX_ITEMS).map((row) => previewOf(world, row, target, startsOn, keeps));
    // The open quotations and sales orders that hold an item that moves: each says so until its date.
    const documents = await world.documents(db, items.filter((i) => !i.same && !i.problem).map((i) => i.id));
    return { startsOn, today, keeps, target: { id: target.id, name: target.name, rate: Number(target.rate).toFixed(2) },
      dateProblem: money.startProblem(startsOn, today, world.words.fromToday), items, more: rows.length > MAX_ITEMS,
      moving: items.filter((i) => !i.same && !i.problem).length, documents };
  });
}

// --- Scheduling ---------------------------------------------------------------------

async function schedule(world, user, body) {
  await world.requireEdit();
  if (!UUID.test(String(body.requestKey || ''))) fail('A valid request key is required');
  const hash = sha256(body);
  const startsOn = readDate(body.startsOn, 'Start date');
  const keeps = readKeeps(body.keeps);
  const targetId = v.requiredId(body.taxRateId, 'New GST rate');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  const ids = readIds(body.items, world.words);
  return repo.transaction(async (db) => {
    const businessId = await world.businessId(db, true);
    await world.lock(db);
    const old = await repo.one(db, 'SELECT id,request_hash FROM business_tax_changes WHERE business_id=$1 AND request_key=$2', [businessId, body.requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return detailIn(db, world, businessId, old.id);
    }
    await world.applyDue(db);
    const problem = money.startProblem(startsOn, await world.today(db), world.words.fromToday);
    if (problem) fail(problem);
    const target = await world.target(db, targetId);
    const rows = await world.candidates(db, { ids, limit: MAX_ITEMS });
    if (rows.length !== ids.length) fail(`${world.words.Item} not found`, 404);
    const items = rows.map((row) => previewOf(world, row, target, startsOn, keeps));
    const refused = items.filter((item) => item.problem);
    if (refused.length) {
      const more = refused.length > 3 ? ` (and ${refused.length - 3} more)` : '';
      fail(`${refused.slice(0, 3).map((item) => item.problem).join('; ')}${more}. Leave ${refused.length === 1 ? 'it' : 'them'} out of the change, or put ${refused.length === 1 ? 'it' : 'them'} right first.`, 409,
        { reason: 'items_refused', items: refused.map((item) => ({ id: item.id, label: item.label, problem: item.problem })) });
    }
    const same = items.filter((item) => item.same);
    if (same.length) {
      fail(`${same[0].label}${same.length > 1 ? ` and ${same.length - 1} more` : ''} ${same.length === 1 ? 'is' : 'are'} at ${target.name} on ${money.dateWords(startsOn)} already: leave ${same.length === 1 ? 'it' : 'them'} out of the change`, 409,
        { reason: 'already_at_rate', items: same.map((item) => ({ id: item.id, label: item.label })) });
    }
    const change = await repo.one(db, `INSERT INTO business_tax_changes(business_id,starts_on,${world.targetColumn},rate,keeps,reason,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [businessId, startsOn, target.id, Number(target.rate).toFixed(2), keeps, reason, body.requestKey, hash, user.id]);
    await db.query(`INSERT INTO business_tax_change_items(business_id,change_id,starts_on,${world.itemColumn})
      SELECT $1,$2,$3,unnest($4::bigint[])`, [businessId, change.id, startsOn, ids]);
    await world.audit(db, 'tax_change.scheduled', change.id, { startsOn, to: target.name, rate: Number(target.rate).toFixed(2), keeps, reason, [world.words.items]: ids.length });
    return detailIn(db, world, businessId, change.id);
  });
}

// --- Reading -------------------------------------------------------------------------

const ITEM_JOINS = `LEFT JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
  LEFT JOIN products p ON p.id=i.product_id
  LEFT JOIN business_tax_rates f ON f.business_id=i.business_id AND f.id=i.from_tax_rate_id
  LEFT JOIN tax_rates rf ON rf.id=i.from_restaurant_tax_rate_id
  LEFT JOIN users cu ON cu.id=i.cancelled_by`;
const ITEM_COLUMNS = `i.id,i.change_id,i.starts_on::text AS starts_on,i.sku_id,i.product_id,i.status,i.from_rate,i.to_rate,i.price_before,i.price_after,i.sizes,
  i.settled_at,i.note,i.cancelled_at,i.cancel_reason,cu.name AS cancelled_by_name,COALESCE(s.label,p.name) AS label,COALESCE(s.code,p.code) AS code,
  COALESCE(f.name,rf.name) AS from_name`;
const CHANGE_SELECT = `SELECT c.id,c.starts_on::text AS starts_on,c.rate,c.keeps,c.reason,c.created_at,c.created_by,u.name AS created_by_name,
    c.tax_rate_id,c.restaurant_tax_rate_id,COALESCE(t.name,rt.name) AS rate_name,
    count(i.id)::int AS items,count(i.id) FILTER (WHERE i.status='scheduled')::int AS scheduled,
    count(i.id) FILTER (WHERE i.status='applied')::int AS applied,count(i.id) FILTER (WHERE i.status='cancelled')::int AS cancelled,
    count(i.id) FILTER (WHERE i.status='refused')::int AS refused,
    CASE WHEN count(i.id) FILTER (WHERE i.status='scheduled')>0 THEN 'scheduled'
      WHEN count(i.id) FILTER (WHERE i.status='applied')>0 THEN 'in_force'
      WHEN count(i.id) FILTER (WHERE i.status='refused')>0 THEN 'refused' ELSE 'cancelled' END AS state
  FROM business_tax_changes c JOIN users u ON u.id=c.created_by
  LEFT JOIN business_tax_rates t ON t.business_id=c.business_id AND t.id=c.tax_rate_id
  LEFT JOIN tax_rates rt ON rt.id=c.restaurant_tax_rate_id
  JOIN business_tax_change_items i ON i.business_id=c.business_id AND i.change_id=c.id`;
const CHANGE_GROUP = 'GROUP BY c.id,u.name,t.name,rt.name';

// A shop's changes, a page at a time (Business Admin's lists, business.repository page()).
repo.addLists({
  'tax-changes': { sql: `${CHANGE_SELECT} WHERE c.business_id=$1 ${CHANGE_GROUP}`,
    search: ['reason', 'rate_name', 'created_by_name'], filters: { state: 'state' }, order: "state='scheduled' DESC,starts_on DESC,id DESC" },
});

async function detailIn(db, world, businessId, changeId) {
  const change = await repo.one(db, `${CHANGE_SELECT} WHERE c.business_id=$1 AND c.id=$2 ${CHANGE_GROUP}`, [businessId, v.requiredId(changeId, 'GST rate change')]);
  if (!change) fail('GST rate change not found', 404);
  const items = await repo.all(db, `SELECT ${ITEM_COLUMNS} FROM business_tax_change_items i ${ITEM_JOINS}
    WHERE i.business_id=$1 AND i.change_id=$2 ORDER BY lower(COALESCE(s.label,p.name)),i.id`, [businessId, change.id]);
  // While items are still to move: the open quotations and sales orders holding them.
  const waiting = items.filter((i) => i.status === 'scheduled').map((i) => Number(i.sku_id || i.product_id));
  const documents = waiting.length ? await world.documents(db, waiting) : [];
  return { ...change, items, documents };
}
async function detail(world, changeId) {
  await world.requireView();
  const businessId = await world.businessId(repo.pool, false);
  if (!businessId) fail('GST rate change not found', 404);
  return detailIn(repo.pool, world, businessId, changeId);
}
// Every change, those to come first (a restaurant's: they are few), with the
// restaurant's own date, from which a new change may start the day after.
async function listAll(world) {
  await world.requireView();
  const businessId = await world.businessId(repo.pool, false);
  const today = await world.today(repo.pool);
  const changes = businessId ? await repo.all(repo.pool, `SELECT * FROM (${CHANGE_SELECT} WHERE c.business_id=$1 ${CHANGE_GROUP}) x
    ORDER BY state='scheduled' DESC,starts_on DESC,id DESC`, [businessId]) : [];
  return { today, changes };
}

// An item's GST history: each change that moved it or is to move it, with
// who entered it and why, and (a shop) each time its slab was changed on the item.
async function history(world, itemId) {
  await world.requireView();
  const item = await world.item(repo.pool, itemId);
  const businessId = await world.businessId(repo.pool, false);
  const changes = businessId ? await repo.all(repo.pool, `SELECT ${ITEM_COLUMNS},c.reason,c.keeps,c.created_at,u.name AS created_by_name,COALESCE(t.name,rt.name) AS to_name,c.rate
      FROM business_tax_change_items i JOIN business_tax_changes c ON c.business_id=i.business_id AND c.id=i.change_id
      JOIN users u ON u.id=c.created_by
      LEFT JOIN business_tax_rates t ON t.business_id=c.business_id AND t.id=c.tax_rate_id
      LEFT JOIN tax_rates rt ON rt.id=c.restaurant_tax_rate_id ${ITEM_JOINS}
      WHERE i.business_id=$1 AND i.${world.itemColumn}=$2 ORDER BY i.starts_on DESC,i.id DESC`, [businessId, item.id]) : [];
  const edits = await world.edits(repo.pool, item);
  return { item, changes, edits };
}

// --- Cancelling ------------------------------------------------------------------------

// Before its date only (the database refuses it from then on); asking again is
// the same cancellation.
async function cancel(world, user, changeId, body, itemId = null) {
  await world.requireEdit();
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const businessId = await world.businessId(db, false);
    if (!businessId) fail('GST rate change not found', 404);
    await world.lock(db);
    // A change whose date has come takes effect, rather than being cancelled.
    await world.applyDue(db);
    const change = await repo.one(db, 'SELECT id,starts_on::text AS starts_on FROM business_tax_changes WHERE business_id=$1 AND id=$2', [businessId, v.requiredId(changeId, 'GST rate change')]);
    if (!change) fail('GST rate change not found', 404);
    const items = await repo.all(db, `SELECT i.id,i.status,COALESCE(s.label,p.name) AS label FROM business_tax_change_items i
      LEFT JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id LEFT JOIN products p ON p.id=i.product_id
      WHERE i.business_id=$1 AND i.change_id=$2 AND ($3::bigint IS NULL OR i.id=$3) FOR UPDATE OF i`, [businessId, change.id, itemId === null ? null : v.requiredId(itemId, world.words.Item)]);
    if (!items.length) fail(`${world.words.Item} not found in this change`, 404);
    const open = items.filter((item) => item.status === 'scheduled');
    if (!open.length) {
      if (items.every((item) => item.status === 'cancelled')) return detailIn(db, world, businessId, change.id);
      fail(`This GST rate change started on ${money.dateWords(change.starts_on)} and is in force: it is kept for good. Enter another change to move ${itemId ? 'the item' : 'the items'} again.`, 409);
    }
    await db.query(`UPDATE business_tax_change_items SET status='cancelled',cancelled_by=$3,cancelled_at=now(),cancel_reason=$4
      WHERE business_id=$1 AND id=ANY($2::bigint[])`, [businessId, open.map((item) => item.id), user.id, reason]);
    await world.audit(db, itemId ? 'tax_change.item_cancelled' : 'tax_change.cancelled', change.id,
      { startsOn: change.starts_on, reason, ...(itemId ? { item: open[0].label } : { [world.words.items]: open.length }) });
    return detailIn(db, world, businessId, change.id);
  });
}

module.exports = { preview, schedule, detail, detailIn, listAll, history, cancel, previewOf, MAX_ITEMS };
