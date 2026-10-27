const repo = require('../../business/core/repositories/business.repository');
const access = require('../../business/core/services/businessAccess.service');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const rules = require('./gstThresholdsRules');
const read = require('./gstTurnover');
const kept = require('./standingCache');
const taxChangesMenu = require('../../tax-changes/services/taxChangesMenu');

// An owner's GST thresholds, for every business and the restaurant.
//
// A PAN group is one owner's businesses under one PAN: each business's PAN is
// read from its GSTINs, or is the one its owner recorded while it has none,
// and is never guessed. A group's turnover for the financial year is the sum
// of each business's own sales less returns, on its own dates and clock
// (gstTurnover.js). It is measured against the figures the platform keeps
// (platform_gst_thresholds), with the owner's own warning level: a figure
// passed last year applies now, one passed this year so far from the next
// 1 April (gstThresholdsRules.js standing).
//
// Who sees what: the owner sees their groups in full (the owner's view); the
// bell of each business under a PAN warns everyone there who may see the
// business's money (reports.view, or the Owner role), with the PAN masked
// for all but the business's owners and the sums only for someone who may
// see the money of every business they add up. A business's owners each have
// their group; its bell shows the most serious of them, kept for five minutes
// for everyone (standingCache.js) and shaped for each person afterwards.
// Nothing here files or makes an e-invoice.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const DEFAULT_WARN = 80;
const OWNER_VIEW = '/business-admin/gst-thresholds';

// The items a shop has to give a longer HSN / SAC code once the rule applies:
// active items billed under their own code (not a kit, nor an item kept for
// use in services) whose code is shorter than the rule in force on the
// business's date asks (no code is shorter too). Searchable by name, code and HSN.
repo.addLists({
  'gst-hsn-items': {
    sql: `SELECT s.*, p.name AS product_name, p.kind, p.category_id, t.name AS tax_rate_name, COALESCE(length(s.hsn_code), 0) AS hsn_length,
      COALESCE((SELECT json_agg(json_build_object('id',x.id,'unit_code',x.unit_code,'quantity_in_base',x.quantity_in_base) ORDER BY x.quantity_in_base)
        FROM catalog_sku_units x WHERE x.business_id=s.business_id AND x.sku_id=s.id AND x.active),'[]') AS pack_sizes
      FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
      LEFT JOIN business_tax_rates t ON t.business_id = s.business_id AND t.id = s.tax_rate_id
      WHERE s.business_id = $1 AND s.active AND NOT s.is_kit AND NOT s.internal_use
        AND COALESCE(length(s.hsn_code), 0) < COALESCE((SELECT g.hsn_digits FROM platform_gst_thresholds g WHERE g.hsn_digits IS NOT NULL
          AND (g.applies_from IS NULL OR g.applies_from <= business_tax_change_today($1)) ORDER BY g.applies_from DESC NULLS LAST LIMIT 1), 0)`,
    search: ['label', 'code', 'product_name', 'hsn_code'],
    order: 'label, id',
  },
});

// --- Working it out ----------------------------------------------------------------------

const identityOf = (row) => rules.panSource({ gstins: row.gstins || [], recorded: row.recorded_pan });

// A dish prints the code of the tax rate it is charged at: a GST rate change
// due today moves it first, as the menu's own screens do (a shop's items were
// moved when its request opened the business).
const menuGate = (rows) => Promise.all([...new Set(rows.filter((row) => row.legacy_restaurant_id).map((row) => row.legacy_restaurant_id))]
  .map((restaurantId) => taxChangesMenu.onMenu(restaurantId)));

// The turnover of these businesses (rows of read.ownedBusinesses, a business
// perhaps once for each of its owners) for one financial year: the year of
// the latest of their own dates, each business summed on its own clock.
async function figuresOf(rows) {
  const businesses = [...new Map(rows.map((row) => [row.id, row])).values()];
  const today = businesses.length ? businesses.reduce((latest, b) => (b.today > latest ? b.today : latest), businesses[0].today) : await read.indiaToday();
  const year = rules.financialYear(today);
  const lastYear = rules.yearBefore(year);
  const sums = businesses.length ? await read.turnover(businesses, year, lastYear) : new Map();
  const each = new Map(businesses.map((b) => {
    const sum = sums.get(b.id) || { thisYear: 0, lastYear: 0 };
    return [b.id, { ...sum, projected: rules.projection(sum.thisYear, { year, today: b.today, startedOn: b.started_on }) }];
  }));
  return { today, year, lastYear, each };
}

// A group's sums and where they stand against each step of the figures.
function groupStanding(members, figures, steps, warnPercent) {
  const ids = [...new Set(members.map((row) => row.id))];
  const total = (key) => ids.reduce((sum, id) => sum + figures.each.get(id)[key], 0);
  const sums = { thisYear: total('thisYear'), lastYear: total('lastYear'), projected: total('projected') };
  return { ...sums, businesses: ids.length, ids, warnPercent, steps: rules.standing(steps, { ...sums, warnPercent, year: figures.year }) };
}
// The higher figures weigh more: past ₹10 crore is more serious than past ₹5 crore and near ₹10 crore.
const seriousness = (group) => group.steps.reduce((score, step, index) => score + rules.level(step) * 4 ** index, 0);

// The standing of one business's PAN: the most serious of its owners' groups.
// { linked: false, reason } when it has no PAN (or no owner); else { linked,
// pan, source, figures, steps, group } where group is that owner's group. The
// same for whoever asks, so kept for five minutes (standingCache.js): read it,
// never change it.
const standingOf = (businessId) => kept.remember(String(businessId), () => readStanding(businessId));

async function readStanding(businessId) {
  const ownerIds = await read.owners(businessId);
  if (!ownerIds.length) return { linked: false, reason: 'no_owner' };
  // Its own row first: a business with no PAN needs nothing more.
  const own = (await read.ownedBusinesses(ownerIds, businessId))[0];
  if (!own) return { linked: false, reason: 'no_owner' };
  const identity = identityOf(own);
  if (!identity.pan) return { linked: false, reason: identity.reason };
  const [rows, levels, figureRows] = await Promise.all([read.ownedBusinesses(ownerIds), read.warnLevels(ownerIds), read.thresholds()]);
  const related = rows.filter((row) => identityOf(row).pan === identity.pan);
  const figures = await figuresOf(related);
  const steps = rules.stepsOn(figureRows, figures.today);
  let chosen = null;
  for (const ownerId of ownerIds) {
    const members = related.filter((row) => row.owner_id === ownerId);
    if (!members.length) continue;
    const group = groupStanding(members, figures, steps, levels.get(ownerId) ?? DEFAULT_WARN);
    if (!chosen || seriousness(group) > seriousness(chosen) || (seriousness(group) === seriousness(chosen) && group.thisYear > chosen.thisYear)) chosen = group;
  }
  return { linked: true, pan: identity.pan, source: identity.source, figures, steps: chosen.steps, group: chosen };
}

// --- Shapes ----------------------------------------------------------------------------------

const ruleShape = (row) => ({ code: row.code, name: row.name, applies: row.applies, turnover: row.turnover, comparison: row.comparison,
  hsnDigits: row.hsn_digits, reportWithinDays: row.report_within_days, appliesFrom: row.applies_from, source: row.source });
const stepShape = (step, figures) => ({ turnover: rules.rupees(step.figure), comparison: step.comparison, state: step.state, by: step.by,
  appliesFrom: step.appliesFrom, share: step.share, warnAt: rules.rupees(step.warnAt), onPace: step.onPace, words: rules.stepWords(step, figures),
  rules: step.rules.map(ruleShape) });
// Where 6-digit codes stand for a group: { applies, from, digits }, `from` the
// day they apply from while it is still to come (null when they apply now).
const hsnShape = (hsn) => (hsn ? { applies: true, from: hsn.from, digits: hsn.rule.hsn_digits } : { applies: false, from: null, digits: null });
function businessShape(row, identity, figures) {
  const sums = figures.each.get(row.id) || { thisYear: 0, lastYear: 0, projected: 0 };
  return {
    id: Number(row.id), name: row.name, code: row.code, businessType: row.business_type, typeName: row.type_name, restaurant: Boolean(row.legacy_restaurant_id),
    source: identity.source, gstins: row.gstins || [], recordedPan: row.recorded_pan || null, recordedAt: row.recorded_at || null,
    today: row.today, startedOn: row.started_on,
    thisYear: rules.rupees(sums.thisYear), lastYear: rules.rupees(sums.lastYear), projected: rules.rupees(sums.projected), hsnToFix: null,
  };
}

// --- The owner's view -----------------------------------------------------------------------

// Every business this person owns, grouped by PAN, with each group's turnover
// this year so far, the year before and the projection to 31 March, where it
// stands against each figure, and the HSN / SAC codes to fix where 6-digit
// codes apply, now or from the next 1 April; the businesses with no PAN, and
// why; the figures themselves.
async function ownerView(user) {
  const [rows, levels, figureRows] = await Promise.all([read.ownedBusinesses([user.id]), read.warnLevels([user.id]), read.thresholds()]);
  const warnPercent = levels.get(String(user.id)) ?? DEFAULT_WARN;
  const figures = await figuresOf(rows);
  const thresholds = figureRows.map((row) => ({ ...ruleShape(row), inForce: !row.applies_from || row.applies_from <= figures.today }));
  const answer = { owner: rows.length > 0, warnPercent, today: figures.today, year: figures.year, lastYear: figures.lastYear, thresholds, groups: [], notLinked: [] };
  const steps = rules.stepsOn(figureRows, figures.today);
  const groups = new Map();
  for (const row of rows) {
    const identity = identityOf(row);
    const business = businessShape(row, identity, figures);
    if (!identity.pan) {
      answer.notLinked.push({ ...business, reason: identity.reason, pans: identity.pans });
      continue;
    }
    if (!groups.has(identity.pan)) groups.set(identity.pan, { pan: identity.pan, rows: [], businesses: [] });
    groups.get(identity.pan).rows.push(row);
    groups.get(identity.pan).businesses.push(business);
  }
  for (const group of groups.values()) {
    const standing = groupStanding(group.rows, figures, steps, warnPercent);
    const hsn = rules.applying(standing.steps, 'hsn_digits');
    if (hsn) {
      await menuGate(group.rows);
      const counts = await read.hsnShort(group.rows, hsn.rule.hsn_digits);
      for (const business of group.businesses) business.hsnToFix = counts.get(String(business.id)) ?? 0;
    }
    answer.groups.push({
      pan: group.pan, thisYear: rules.rupees(standing.thisYear), lastYear: rules.rupees(standing.lastYear), projected: rules.rupees(standing.projected),
      steps: standing.steps.map((step) => stepShape(step, figures)), hsn: hsnShape(hsn), businesses: group.businesses,
    });
  }
  answer.groups.sort((a, b) => rules.toPaise(b.thisYear) - rules.toPaise(a.thisYear) || a.pan.localeCompare(b.pan));
  return answer;
}

// The owner's own warning level: a whole percent of a threshold from which
// their view and their businesses' bells say the turnover is nearing it.
async function setWarnLevel(user, body) {
  if (!(await read.ownedBusinesses([user.id])).length) fail('Only the owner of a business sets the warning level of its GST thresholds', 403);
  const level = body.warnPercent === undefined || body.warnPercent === null || body.warnPercent === '' ? NaN : Number(body.warnPercent);
  if (!Number.isInteger(level) || level < 50 || level > 99) fail('Warning level must be a whole percent from 50 to 99');
  const row = await repo.one(repo.pool, `INSERT INTO owner_gst_settings (user_id, warn_percent) VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET warn_percent = EXCLUDED.warn_percent, updated_at = now() RETURNING warn_percent`, [user.id, level]);
  // Saved: no bell may answer from the level before.
  kept.clear();
  return { warnPercent: Number(row.warn_percent) };
}

// The PAN an owner records for one of their businesses that has no GSTIN; an
// empty one clears it. A business with a GSTIN takes its PAN from it, so
// none is recorded for it. The same PAN again changes nothing.
async function recordPan(business, user, body) {
  const ownerOnly = 'Only an owner of this business records the PAN it trades under';
  if (!business.full_access) fail(ownerOnly, 403);
  const pan = rules.readPan(body.pan);
  const own = (await read.ownedBusinesses([user.id], business.id))[0];
  if (!own) fail(ownerOnly, 403);
  const fromGstins = rules.panSource({ gstins: own.gstins || [] });
  if (fromGstins.pans.length === 1) fail(`This business takes its PAN from its GSTIN: ${fromGstins.pans[0]}. To change it, change the GSTIN in its settings.`, 409);
  if (fromGstins.pans.length > 1) fail(`This business's GSTINs carry different PANs (${fromGstins.pans.join(' and ')}). Correct the one that is wrong in its settings.`, 409);
  const result = await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id = $1 FOR UPDATE', [business.id]);
    const before = (await repo.one(db, 'SELECT pan FROM business_gst_pans WHERE business_id = $1', [business.id]))?.pan || null;
    if (before !== pan) {
      if (pan) {
        await db.query(`INSERT INTO business_gst_pans (business_id, pan, recorded_by) VALUES ($1, $2, $3)
          ON CONFLICT (business_id) DO UPDATE SET pan = EXCLUDED.pan, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`, [business.id, pan, user.id]);
      } else {
        await db.query('DELETE FROM business_gst_pans WHERE business_id = $1', [business.id]);
      }
      // The activity log keeps the change with the PAN masked: managers read it too.
      const details = { pan: rules.maskPan(pan), before: rules.maskPan(before) };
      const action = pan ? 'gst_pan.recorded' : 'gst_pan.cleared';
      if (business.legacy_restaurant_id) {
        await db.query(`INSERT INTO audit_logs (restaurant_id, user_id, user_name, action, entity_type, entity_id, entity_label, details)
          VALUES ($1, $2, $3, $4, 'restaurant', $1, $5, $6)`,
        [business.legacy_restaurant_id, user.id, user.name || null, pan ? 'gst_pan_recorded' : 'gst_pan_cleared', business.name, JSON.stringify(details)]);
      } else {
        await repo.audit(db, business.id, user.id, action, business.id, details);
      }
    }
    const now = await repo.one(db, 'SELECT pan, recorded_at FROM business_gst_pans WHERE business_id = $1', [business.id]);
    return { businessId: Number(business.id), pan: now?.pan || null, recordedAt: now?.recorded_at || null, changed: before !== pan };
  });
  // Committed: the groups have changed, so no bell may answer from before.
  if (result.changed) kept.clear();
  return result;
}

// --- A business's screens ---------------------------------------------------------------------

// Whether codes of a set length apply to this business's invoices (its PAN past
// the figure of the HSN rule): now, or from the next 1 April (`from`), when
// they are listed all the same, to prepare; and how many of its items print a
// shorter one. No sums: whoever looks after the catalogue sees what to fix,
// not the turnover.
async function hsnSummary(business) {
  const standing = await standingOf(business.id);
  const hsn = standing.linked ? rules.applying(standing.steps, 'hsn_digits') : null;
  if (!hsn) return { applies: false, from: null, digits: null, count: 0, rule: null };
  const counts = await read.hsnShort([{ id: String(business.id), legacy_restaurant_id: business.legacy_restaurant_id }], hsn.rule.hsn_digits);
  return { applies: true, from: hsn.from, digits: hsn.rule.hsn_digits, count: counts.get(String(business.id)) ?? 0, rule: ruleShape(hsn.rule) };
}

// The items to fix, a page at a time; refused while the rule does not apply, now or from the next 1 April.
async function hsnItems(business, query) {
  if (!(await hsnSummary(business)).applies) fail('HSN / SAC codes of a set length are not asked of this business\'s invoices yet: nothing to fix', 409);
  const limit = query.limit === undefined ? 25 : v.requiredId(query.limit, 'Page size');
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) fail('Invalid pagination');
  const search = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : null;
  return repo.page(business.id, 'gst-hsn-items', limit, offset, { search });
}

// The bell of a business on the shared core: a line for each figure its PAN is
// near or past, for someone who may see the business's money (the route asks
// nothing; this checks). A restaurant's lines are on its own bell.
async function bell(business, base) {
  if (business.business_type === 'restaurant' || !access.can(business, 'reports.view')) return [];
  const standing = await standingOf(business.id);
  if (!standing.linked) return [];
  const seen = await read.moneySeen(business.member_user_id, standing.group.ids);
  const sums = standing.group.ids.every((id) => seen.has(id));
  const fixesCatalogue = access.can(business, 'catalog.view');
  return rules.alerts({
    steps: standing.steps, year: standing.figures.year, lastYear: standing.figures.lastYear, today: standing.figures.today, prefix: 'gst-threshold',
    pan: business.full_access ? standing.pan : rules.maskPan(standing.pan),
    figures: sums ? { thisYear: standing.group.thisYear, lastYear: standing.group.lastYear, businesses: standing.group.businesses } : null,
    link: (step) => (business.full_access ? OWNER_VIEW
      : step.state === 'crossed' && step.rules.some((rule) => rule.code === 'hsn_digits') && fixesCatalogue ? `${base}/products` : null),
  });
}

// --- A restaurant ------------------------------------------------------------------------------

const restaurantBusiness = async (restaurantId) => (restaurantId
  ? repo.one(repo.pool, "SELECT id, legacy_restaurant_id FROM businesses WHERE legacy_restaurant_id = $1 AND status = 'active'", [restaurantId]) : null);

// The restaurant's bell (providers/gstThresholds.js, for reports.view): the
// same lines, one answer for everyone there, so the PAN is masked and no sums.
async function restaurantBell(restaurantId) {
  const row = await restaurantBusiness(restaurantId);
  if (!row) return [];
  const standing = await standingOf(row.id);
  if (!standing.linked) return [];
  return rules.alerts({
    steps: standing.steps, year: standing.figures.year, lastYear: standing.figures.lastYear, today: standing.figures.today, prefix: 'gstThresholds',
    pan: rules.maskPan(standing.pan), figures: null,
    link: (step) => (step.state === 'crossed' && step.rules.some((rule) => rule.code === 'hsn_digits') ? '/menu/tax-rates' : OWNER_VIEW),
  });
}

// The restaurant's tax rates whose HSN / SAC code is shorter than the rule
// asks, with the dishes charged at each, once the rule applies to its PAN:
// now, or from the next 1 April (`from`).
async function restaurantHsn(user) {
  const row = await restaurantBusiness(user.restaurantId);
  const standing = row ? await standingOf(row.id) : { linked: false };
  const hsn = standing.linked ? rules.applying(standing.steps, 'hsn_digits') : null;
  if (!hsn) return { applies: false, from: null, digits: null, rule: null, rates: [] };
  await taxChangesMenu.onMenu(user.restaurantId);
  return { applies: true, from: hsn.from, digits: hsn.rule.hsn_digits, rule: ruleShape(hsn.rule), rates: await read.menuRatesShort(user.restaurantId, hsn.rule.hsn_digits) };
}

module.exports = { ownerView, setWarnLevel, recordPan, hsnSummary, hsnItems, bell, restaurantBell, restaurantHsn, standingOf };
