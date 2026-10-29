const repo = require('../../business/core/repositories/business.repository');
const access = require('../../business/core/services/businessAccess.service');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const changes = require('./taxChanges.service');
const settingChanges = require('./taxChangesSettings');
const imports = require('./taxChangesImport');
const money = require('./taxChangesMoney');

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
    (EXISTS (SELECT 1 FROM business_tax_change_items WHERE business_id=$1 AND status='applied' AND sku_id IS NOT NULL
      AND settled_at > now() AND starts_on > (now() AT TIME ZONE $2)::date)
    OR EXISTS (SELECT 1 FROM business_tax_setting_changes WHERE business_id=$1 AND status='applied'
      AND settled_at > now() AND starts_on > (now() AT TIME ZONE $2)::date)) AS ahead`, [business.id, business.timezone]);
  const moved = new Set((row.applied || []).map(Number));
  // A kit's line (a quotation's) names its parts' prices: a part that moved counts.
  const fixedMoved = Array.isArray(fixed) && inputLines.some((line, index) => fixed[index]
    && (moved.has(Number(line?.skuId)) || (fixed[index].kitParts || []).some((part) => moved.has(Number(part.skuId)))));
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
// (by slab, category with its sub-categories, HSN / SAC code, a search, or a
// notification's list of codes). A kit is never one: its GST is its parts'.
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
      AND ($10::text[] IS NULL OR s.hsn_code LIKE ANY ($10::text[]))
    ORDER BY lower(s.label),s.id LIMIT $9`,
  [business.id, ids, f.taxRateId ?? null, f.categoryId ?? null, f.hsn ?? null, f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
    Boolean(f.inactive), department, limit, f.codes ? f.codes.map((code) => `${code}%`) : null]);
  if (ids && department) {
    const outside = rows.find((row) => String(row.department_id ?? '') !== String(department));
    if (outside) fail(`You work in ${business.member_department_name || 'one department'}: ${outside.label} is outside it`, 403);
  }
  return rows;
}

// The open quotations and sales orders that hold these items (a kit's parts
// too), with something left on them: until the change's date each says what moves.
async function documents(db, business, skuIds) {
  if (!skuIds.length) return [];
  const quotations = await repo.all(db, `SELECT q.id,q.quotation_no AS number,q.customer_name AS customer,q.valid_until::text AS valid_until,
      array_agg(DISTINCT x.label ORDER BY x.label) AS items
    FROM business_quotations q JOIN business_quotation_lines x ON x.business_id=q.business_id AND x.quotation_id=q.id
    WHERE q.business_id=$1 AND q.status='open'
      AND (x.sku_id=ANY($2::bigint[]) OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(x.kit_parts,'[]'::jsonb)) part WHERE (part->>'skuId')::bigint=ANY($2::bigint[])))
      AND x.quantity>COALESCE((SELECT sum(b.quantity) FROM business_quotation_billed b WHERE b.business_id=x.business_id AND b.line_id=x.id),0)
    GROUP BY q.id ORDER BY q.valid_until,q.id LIMIT 200`, [business.id, skuIds]);
  const orders = await repo.all(db, `SELECT o.id,o.order_no AS number,o.contact_name AS customer,o.expected_on::text AS expected_on,
      array_agg(DISTINCT x.label ORDER BY x.label) AS items
    FROM wholesale_orders o JOIN wholesale_order_lines x ON x.business_id=o.business_id AND x.order_id=o.id
    WHERE o.business_id=$1 AND o.status IN ('open','part_dispatched') AND x.sku_id=ANY($2::bigint[])
      AND x.quantity-x.dispatched_quantity-x.closed_quantity>0
    GROUP BY o.id ORDER BY o.id LIMIT 200`, [business.id, skuIds]);
  return [...quotations.map((q) => ({ kind: 'quotation', ...q })), ...orders.map((o) => ({ kind: 'sales_order', ...o }))];
}

// The GST rate changes still to come that move these items (a quotation's or
// a sales order's): [{ startsOn, from, to, toName, items: [label] }], each item
// from the rate it has the day before.
async function notices(db, business, skuIds) {
  const ids = [...new Set(skuIds.map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await repo.all(db, `SELECT i.starts_on::text AS starts_on,i.sku_id,s.label,s.tax_rate,c.rate AS to_rate,t.name AS to_name
    FROM business_tax_change_items i JOIN business_tax_changes c ON c.business_id=i.business_id AND c.id=i.change_id
    JOIN business_tax_rates t ON t.business_id=c.business_id AND t.id=c.tax_rate_id
    JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    WHERE i.business_id=$1 AND i.status='scheduled' AND i.sku_id=ANY($2::bigint[]) AND i.starts_on>(now() AT TIME ZONE $3)::date
    ORDER BY i.starts_on,lower(s.label),i.id`, [business.id, ids, business.timezone]);
  const rateNow = new Map();
  const out = [];
  for (const row of rows) {
    const from = rateNow.get(Number(row.sku_id)) ?? Number(row.tax_rate);
    rateNow.set(Number(row.sku_id), Number(row.to_rate));
    let notice = out.find((n) => n.startsOn === row.starts_on && n.from === from && n.to === Number(row.to_rate));
    if (!notice) out.push(notice = { startsOn: row.starts_on, from, to: Number(row.to_rate), toName: row.to_name, items: [] });
    notice.items.push(row.label);
  }
  return out;
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
    words: { item: 'item', Item: 'Item', items: 'items', rate: 'GST slab', fromToday: 'To change an item\'s GST from today, change its slab on the item itself.' },
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
    documents: (db, skuIds) => documents(db, business, skuIds),
    // The slabs a notification's list may move items to, and where one is added.
    targets: (db) => repo.all(db, 'SELECT id,name,rate FROM business_tax_rates WHERE business_id=$1 AND active ORDER BY is_default DESC,id', [business.id]),
    rateWhere: 'Settings › Tax rates',
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

// --- Rates kept in its settings ------------------------------------------------------------

// A fashion shop's GST by price and a lodge's room-night slabs, changed by
// date (taxChangesSettings.js): everyone who sees the catalogue sees them,
// and whoever may change the business's settings enters them.
function settingsWorld(business, user) {
  const setting = business.business_type === 'fashion' ? 'fashion_price'
    : business.business_type === 'lodging' && business.modules.includes('lodging') ? 'lodging_slabs' : null;
  const shop = world(business, user);
  return {
    setting,
    businessId: async () => business.id,
    requireView: () => access.require(business, 'catalog.view'),
    requireEdit: () => access.require(business, 'settings.edit'),
    lock: shop.lock, applyDue: shop.applyDue, today: shop.today, audit: shop.audit,
    current: async (db) => {
      if (setting === 'fashion_price') {
        const row = await repo.one(db, 'SELECT threshold,rate_low,rate_high,active FROM fashion_gst_price_slabs WHERE business_id=$1', [business.id]);
        return row && { threshold: Number(row.threshold).toFixed(2), rateLow: Number(row.rate_low).toFixed(2), rateHigh: Number(row.rate_high).toFixed(2), active: row.active };
      }
      const row = await repo.one(db, `SELECT s.low_tax_rate_id,s.high_tax_rate_id,s.slab_limit,lo.name AS low_name,lo.rate AS low_rate,hi.name AS high_name,hi.rate AS high_rate
        FROM lodging_settings s LEFT JOIN business_tax_rates lo ON lo.business_id=s.business_id AND lo.id=s.low_tax_rate_id
        LEFT JOIN business_tax_rates hi ON hi.business_id=s.business_id AND hi.id=s.high_tax_rate_id WHERE s.business_id=$1`, [business.id]);
      return row?.low_tax_rate_id ? { lowTaxRateId: Number(row.low_tax_rate_id), highTaxRateId: Number(row.high_tax_rate_id), slabLimit: Number(row.slab_limit).toFixed(2),
        lowName: row.low_name, lowRate: Number(row.low_rate).toFixed(2), highName: row.high_name, highRate: Number(row.high_rate).toFixed(2) } : null;
    },
    slab: async (db, id) => {
      const slab = await repo.one(db, 'SELECT id,name,rate FROM business_tax_rates WHERE business_id=$1 AND id=$2 AND active', [business.id, id]);
      if (!slab) fail('GST slab not found, or switched off', 404);
      return slab;
    },
  };
}

// --- The bell ---------------------------------------------------------------------------------

// The GST rate changes due within 7 days, for those who manage GST rates
// (catalog.edit): shown 7 days before the date and again the day before
// (a new id, so it is new again), with what moves and how many items.
async function bell(business, base) {
  const today = (await repo.one(repo.pool, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone])).day;
  const rows = await repo.all(repo.pool, `SELECT c.id,c.starts_on::text AS starts_on,c.reason,t.name AS to_name,(c.starts_on-$2::date) AS days,count(i.id)::int AS items,
      (SELECT json_agg(json_build_object('name',x.name,'n',x.n) ORDER BY x.n DESC,x.name) FROM (SELECT COALESCE(f.name,s.tax_rate::text || '%') AS name,count(*)::int AS n
        FROM business_tax_change_items ii JOIN catalog_skus s ON s.business_id=ii.business_id AND s.id=ii.sku_id
        LEFT JOIN business_tax_rates f ON f.business_id=s.business_id AND f.id=s.tax_rate_id
        WHERE ii.business_id=c.business_id AND ii.change_id=c.id AND ii.status='scheduled' GROUP BY 1) x) AS sources
    FROM business_tax_changes c JOIN business_tax_rates t ON t.business_id=c.business_id AND t.id=c.tax_rate_id
    JOIN business_tax_change_items i ON i.business_id=c.business_id AND i.change_id=c.id AND i.status='scheduled'
    WHERE c.business_id=$1 AND c.starts_on>$2::date AND c.starts_on<=$2::date+7
    GROUP BY c.id,t.name ORDER BY c.starts_on,c.id`, [business.id, today]);
  const when = (days) => (days === 1 ? 'tomorrow' : `in ${days} days`);
  const items = rows.map((row) => {
    const days = Number(row.days);
    return { id: `tax_change:${row.id}:${days <= 1 ? '1' : '7'}`, severity: days <= 1 ? 'warning' : 'info', category: 'GST rates',
      title: `${row.items} ${row.items === 1 ? 'item moves' : 'items move'} to ${row.to_name} ${when(days)}`,
      detail: `From ${money.dateWords(row.starts_on)} · now at ${(row.sources || []).map((x) => `${x.name} (${x.n})`).join(', ')} · ${row.reason}`,
      at: `${row.starts_on}T00:00:00.000Z`, link: `${base}/tax-changes` };
  });
  if (settingsWorld(business, { id: business.member_user_id }).setting) {
    for (const change of await settingChanges.upcoming(repo.pool, business.id, today, 7)) {
      const days = (Date.parse(`${change.startsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
      items.push({ id: `tax_change:setting:${change.id}:${days <= 1 ? '1' : '7'}`, severity: days <= 1 ? 'warning' : 'info', category: 'GST rates',
        title: `${change.name} changes ${when(days)}`, detail: `From ${money.dateWords(change.startsOn)}: ${change.words} · ${change.reason}`,
        at: `${change.startsOn}T00:00:00.000Z`, link: `${base}/tax-changes` });
    }
  }
  return items;
}

const preview = (business, user, body) => changes.preview(world(business, user), body);
const schedule = (business, user, body) => changes.schedule(world(business, user), user, body);
const detail = (business, user, changeId) => changes.detail(world(business, user), changeId);
const history = (business, user, skuId) => changes.history(world(business, user), skuId);
const cancel = (business, user, changeId, body) => changes.cancel(world(business, user), user, changeId, body);
const cancelItem = (business, user, changeId, itemId, body) => changes.cancel(world(business, user), user, changeId, body, itemId);

const importPreview = (business, user, body) => imports.preview(world(business, user), body);
const importSchedule = (business, user, body) => imports.schedule(world(business, user), user, body);
const settings = (business, user) => settingChanges.read(settingsWorld(business, user));
const scheduleSetting = (business, user, body) => settingChanges.schedule(settingsWorld(business, user), user, body);
const cancelSetting = (business, user, changeId, body) => settingChanges.cancel(settingsWorld(business, user), user, changeId, body);

module.exports = { applyDue, onOpen, onPosting, preview, schedule, detail, history, cancel, cancelItem, importPreview, importSchedule,
  settings, scheduleSetting, cancelSetting, documents, notices, bell };
