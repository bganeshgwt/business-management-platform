const repo = require('../../business/core/repositories/business.repository');
const access = require('../../business/core/services/businessAccess.service');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const changes = require('./taxChanges.service');

// GST rate changes for the shared core's catalogue items (every business type
// but the restaurant): an item moves to another of the business's GST slabs
// on the business's own date. See taxChanges.service.js for the flows.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };

// --- Taking effect ----------------------------------------------------------------------

// Changes whose date has come take effect (the database's
// business_tax_change_apply, under the business's lock). Returns the items moved now.
async function applyDue(db, business) {
  const row = await repo.one(db, 'SELECT business_tax_change_apply($1) AS applied', [business.id]);
  return (row?.applied || []).map(Number);
}

// As a request opens a business (businessAccess.open): the statement that
// loaded the membership said whether a change is due; it takes effect before
// anything reads a slab. A failure here never stops the request: every
// posting applies due changes again under its own lock.
async function onOpen(business) {
  if (!business.tax_changes_due) return;
  try {
    await repo.transaction((db) => applyDue(db, business));
  } catch (error) {
    console.error(`GST rate changes of business ${business.id} could not be applied before this request: ${error.message}`);
  }
}

// Inside a posting (business.service.js postDocument), right after the
// business is locked: due changes take effect, so the bill reads the slab in
// force on its own date. Around midnight a posting can meet a change halfway:
// the fixed prices of a line were worked out by its type's own service before
// the change took effect here, or the posting began on the day before a
// change that another request has just applied. It is refused, to be sent
// again, rather than billed at the other day's rate.
async function onPosting(db, business, inputLines, fixed) {
  const row = await repo.one(db, `SELECT business_tax_change_apply($1) AS applied,
    EXISTS (SELECT 1 FROM business_tax_change_items WHERE business_id=$1 AND status='applied' AND sku_id IS NOT NULL
      AND settled_at > now() AND starts_on > (now() AT TIME ZONE $2)::date) AS ahead`, [business.id, business.timezone]);
  const moved = new Set((row.applied || []).map(Number));
  const fixedMoved = Array.isArray(fixed) && inputLines.some((line, index) => fixed[index] && moved.has(Number(line?.skuId)));
  if (row.ahead || fixedMoved) {
    fail('GST rates changed a moment ago: a scheduled GST rate change took effect as the day began. Send this again, and it is worked out at the rates in force now.',
      409, { reason: 'gst_rates_changed' });
  }
}

// --- The shop's items ---------------------------------------------------------------------

const SCHEDULED = `COALESCE((SELECT json_agg(json_build_object('changeId',i.change_id,'startsOn',i.starts_on::text,'rate',x.rate,'name',xt.name,'keeps',x.keeps)
    ORDER BY i.starts_on) FROM business_tax_change_items i
    JOIN business_tax_changes x ON x.business_id=i.business_id AND x.id=i.change_id
    JOIN business_tax_rates xt ON xt.business_id=x.business_id AND xt.id=x.tax_rate_id
    WHERE i.business_id=s.business_id AND i.sku_id=s.id AND i.status='scheduled'),'[]')`;

// Items to look at for a change: the ones named, or the ones a filter finds
// (by slab, category with its sub-categories, HSN / SAC code, a search). A
// kit is never one: its GST is its parts'.
async function candidates(db, business, { ids = null, filters = null, limit = changes.MAX_ITEMS }) {
  const f = filters || {};
  // A person tied to a department changes that department's items only.
  const department = business.member_department_id || null;
  const rows = await repo.all(db, `SELECT s.id,s.code,s.label,s.unit,s.price,s.mrp,s.tax_rate,s.tax_rate_id,s.hsn_code,(s.active AND p.active) AS active,
      t.name AS slab_name,COALESCE(cat.name,p.category) AS category,cat.department_id,
      EXISTS (SELECT 1 FROM fuel_products x WHERE x.business_id=s.business_id AND x.sku_id=s.id) AS fuel,
      EXISTS (SELECT 1 FROM jewellery_items x WHERE x.business_id=s.business_id AND x.sku_id=s.id) AS jewellery,
      EXISTS (SELECT 1 FROM lodging_room_types x WHERE x.business_id=s.business_id AND x.sku_id=s.id) AS room_type,
      ${SCHEDULED} AS scheduled
    FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    LEFT JOIN catalog_categories cat ON cat.business_id=p.business_id AND cat.id=p.category_id
    LEFT JOIN business_tax_rates t ON t.business_id=s.business_id AND t.id=s.tax_rate_id
    WHERE s.business_id=$1 AND NOT s.is_kit
      AND ($2::bigint[] IS NULL OR s.id=ANY($2::bigint[]))
      AND ($3::bigint IS NULL OR s.tax_rate_id=$3)
      AND ($4::bigint IS NULL OR p.category_id IN (WITH RECURSIVE tree AS (
        SELECT id FROM catalog_categories WHERE business_id=$1 AND id=$4
        UNION ALL SELECT c.id FROM catalog_categories c JOIN tree ON c.parent_id=tree.id WHERE c.business_id=$1) SELECT id FROM tree))
      AND ($5::text IS NULL OR s.hsn_code LIKE $5 || '%')
      AND ($6::text IS NULL OR concat_ws(' ',s.label,s.code,s.barcode,p.name,p.brand) ILIKE $6)
      AND ($7::boolean OR $2::bigint[] IS NOT NULL OR (s.active AND p.active))
      AND ($8::bigint IS NULL OR $2::bigint[] IS NOT NULL OR cat.department_id=$8)
    ORDER BY lower(s.label),s.id LIMIT $9`,
  [business.id, ids, f.taxRateId ?? null, f.categoryId ?? null, f.hsn ?? null, f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
    Boolean(f.inactive), department, limit]);
  if (ids && department) {
    const outside = rows.find((row) => String(row.department_id ?? '') !== String(department));
    if (outside) fail(`You work in ${business.member_department_name || 'one department'}: ${outside.label} is outside it`, 403);
  }
  return rows;
}

function typeProblem(row, target) {
  const rate = Number(target.rate);
  if (row.fuel && rate !== 0) return `${row.label} is a fuel, outside GST: it stays on the GST nil slab, its price including the state's VAT`;
  if (row.jewellery && rate !== 3) return `${row.label} is a jewellery item: jewellery is billed at 3% GST`;
  if (row.room_type) return `${row.label} is a room type: its nights are billed at the slab their value decides, under Settings › Room types & rates`;
  return null;
}

// The world of a shop, for taxChanges.service.js.
function world(business, user) {
  let inclusive = null;
  return {
    kind: 'shop', itemColumn: 'sku_id', targetColumn: 'tax_rate_id',
    words: { item: 'item', Item: 'Item', items: 'items', fromToday: 'To change an item\'s GST from today, change its slab on the item itself.' },
    businessId: async () => business.id,
    requireView: () => access.require(business, 'catalog.view'),
    requireEdit: () => access.require(business, 'catalog.edit'),
    // The lock every posting takes first.
    lock: (db) => db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]),
    applyDue: (db) => applyDue(db, business),
    today: async (db) => (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day,
    target: async (db, id) => {
      const slab = await repo.one(db, 'SELECT id,name,rate FROM business_tax_rates WHERE business_id=$1 AND id=$2 AND active', [business.id, id]);
      if (!slab) fail('GST slab not found, or switched off', 404);
      return slab;
    },
    candidates: async (db, options) => {
      inclusive = (await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]))?.tax_mode === 'inclusive';
      return candidates(db, business, options);
    },
    inclusive: () => Boolean(inclusive),
    typeProblem,
    audit: (db, action, entityId, details) => repo.audit(db, business.id, user.id, action, entityId, details),
    item: async (db, skuId) => {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.code,s.tax_rate,s.tax_rate_id,t.name AS slab_name,s.price,(s.active AND p.active) AS active
        FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        LEFT JOIN business_tax_rates t ON t.business_id=s.business_id AND t.id=s.tax_rate_id WHERE s.business_id=$1 AND s.id=$2`, [business.id, v.requiredId(skuId, 'Item')]);
      if (!sku) fail('Item not found', 404);
      return sku;
    },
    // Each time its slab was changed on the item itself.
    edits: (db, sku) => repo.all(db, `SELECT a.id,a.created_at,a.details,u.name AS actor_name FROM business_audit a JOIN users u ON u.id=a.actor_id
      WHERE a.business_id=$1 AND a.action='catalog.slab_changed' AND a.entity_id=$2 ORDER BY a.id DESC LIMIT 100`, [business.id, sku.id]),
  };
}

const preview = (business, user, body) => changes.preview(world(business, user), body);
const schedule = (business, user, body) => changes.schedule(world(business, user), user, body);
const detail = (business, user, changeId) => changes.detail(world(business, user), changeId);
const history = (business, user, skuId) => changes.history(world(business, user), skuId);
const cancel = (business, user, changeId, body) => changes.cancel(world(business, user), user, changeId, body);
const cancelItem = (business, user, changeId, itemId, body) => changes.cancel(world(business, user), user, changeId, body, itemId);

module.exports = { applyDue, onOpen, onPosting, preview, schedule, detail, history, cancel, cancelItem };
