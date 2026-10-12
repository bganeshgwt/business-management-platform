// Realistic demo businesses, one of every type, with about ninety days of
// coherent trading history ending today and a live "today":
//
//   npm run seed:realistic -- --user-id <owner id> [--only kirana,salon] [--days 90]
//
// Each business is owned by the given user (Owner role), has Indian details
// (address, GSTIN, phone), staff with their own logins and roles, suppliers,
// customers and a catalogue at GST-correct prices that never exceed the MRP.
// The history is made through the app's own services (the same functions the
// API calls), so totals, stock, ledgers, number series, events and the
// activity log agree; the time machine (realistic/machine.js) then dates each
// posting to its moment in the story. Tasks, issues and a Diwali project come
// from realistic/tasks.js.
//
// Safe to run again: everything is found by a stable key (business code,
// names, item codes, request keys), the history is made once (marker
// "demo.history_seeded"), and a rerun only tops up today's trade up to the
// current time. Staff passwords go to backend/.local/realistic-demo-logins.json
// and are never printed. The old "Demo · …" businesses of this user are
// marked inactive (kept, not deleted).
require('dotenv').config({ quiet: true });
const repo = require('../src/modules/business/core/repositories/business.repository');
const service = require('../src/modules/business/core/services/business.service');
const users = require('../src/modules/access/repositories/user.repository');
const offersService = require('../src/modules/business/retail/services/businessRetailOffers.service');
const retailCustomers = require('../src/modules/business/retail/services/businessRetailCustomers.service');
const base = require('./realistic/base');
const shop = require('./realistic/shop');
const clock = require('./realistic/clock');
const machine = require('./realistic/machine');
const tasks = require('./realistic/tasks');

const db = repo.pool;
const DEFINITIONS = () => {
  const grocery = require('./realistic/types/grocery');
  return [grocery.kirana, grocery.supermarket, ...require('./realistic/types/others').all];
};

async function prepare(owner, def, logins) {
  const row = await base.ensureBusiness(owner, def);
  let business = await base.load(owner, row.id);
  // Set-up is dated to the day before the history starts (dates are given as meant).
  const started = clock.at(clock.addDays(clock.today(), -def.days - 1), '10:00');
  return machine.at(business.id, started, async () => {
    await base.ensureModules(business, owner, def.modules);
    business = await base.load(owner, business.id);
    await base.ensureSettings(business, owner, def);
    await base.ensureUnits(business, owner, def.units);
    const location = await base.ensureLocation(business, owner, def.location, 'MAIN');
    for (const [name, code] of def.extraLocations || []) await base.ensureLocation(business, owner, name, code);
    const staff = await base.ensureStaff(business, owner, def, logins);
    const suppliers = [];
    for (const s of def.suppliers || []) suppliers.push({ ...s, contact: await base.contact(business, owner, 'supplier', s) });
    const regulars = [];
    for (const c of def.regulars || []) regulars.push({ ...c, contact: await base.contact(business, owner, 'customer', c) });
    const catalogue = await base.ensureCatalogue(business, owner, def);
    if (def.barcodes !== false && business.modules.includes('offers')) await base.barcodes(business, owner);
    const ids = Object.fromEntries(catalogue.skus.map((s) => [s.code, s.id]));
    const rel = (n) => clock.addDays(clock.today(), n);
    for (const offer of def.offers ? def.offers(ids, catalogue.categoryIds, rel) : []) {
      if (await repo.one(db, 'SELECT 1 FROM retail_offers WHERE business_id=$1 AND name=$2', [business.id, offer.name])) continue;
      await offersService.createOffer(business, owner, offer);
    }
    if (def.loyalty && !await repo.one(db, 'SELECT 1 FROM retail_loyalty_settings WHERE business_id=$1', [business.id])) {
      await retailCustomers.saveLoyaltyRules(business, owner, def.loyalty);
    }
    return { business, location, staff, suppliers, regulars, catalogue };
  }, { keepDates: true });
}

function simulation(owner, def, prepared) {
  const { business, location, staff, suppliers, regulars, catalogue } = prepared;
  const items = catalogue.skus.map((sku) => {
    const meta = sku.meta;
    const supplier = suppliers.find((s) => s.key === meta.supplier) || suppliers[0] || null;
    return { ...sku, id: Number(sku.id), meta, kind: sku.kind || meta.kind || 'goods', tracking: sku.tracking, price: Number(sku.price), supplier,
      reorder: Number(meta.reorder ?? 0), target: Number(meta.target ?? (meta.reorder ? meta.reorder * 3 : 0)) };
  });
  const sim = {
    def, code: business.code, owner, business, location, staff, suppliers, regulars, items, hooks: def.hooks || {},
    realToday: clock.today(), orders: new Map(), recent: [], expiryFixes: [], turn: 0, taxMode: def.taxMode || 'inclusive', extra: {},
  };
  // Units' decimal places (kg 3, each 0).
  sim.decimalsReady = repo.all(db, 'SELECT code,decimals FROM business_units WHERE business_id=$1', [business.id]).then((units) => {
    for (const item of items) item.decimals = Number(units.find((u) => u.code === item.unit)?.decimals ?? 0);
  });
  // Three everyday items the supplier was short of this week: today's low-stock list.
  const r = clock.rng(`${business.code}|short`);
  const candidates = items.filter((i) => i.kind === 'goods' && i.tracking === 'quantity' && i.reorder > 0 && (i.meta.w ?? 1) >= 1 && (i.meta.w ?? 1) <= 3);
  sim.shortItems = new Set();
  for (let n = 0; n < Math.min(3, candidates.length); n += 1) sim.shortItems.add(candidates.splice(r.int(0, candidates.length - 1), 1)[0].id);
  return sim;
}

async function oldDemosInactive(owner) {
  // The provisioned "Demo · …" set of this user (codes DEMO-<user>-<type>): kept, switched off.
  const rows = await repo.all(db, `SELECT id,name FROM businesses WHERE is_demo AND created_by=$1 AND code LIKE $2 AND status='active'`, [owner.id, `DEMO-${owner.id}-%`]);
  for (const row of rows) {
    await repo.transaction(async (tx) => {
      await tx.query("UPDATE businesses SET status='inactive',updated_at=now() WHERE id=$1", [row.id]);
      await repo.audit(tx, row.id, owner.id, 'business.demo.retired', row.id, { reason: 'Replaced by the realistic demo businesses' });
    });
  }
  return rows.length;
}

async function main() {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
  const userId = Number(arg('--user-id'));
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Usage: npm run seed:realistic -- --user-id <owner id> [--only kirana,salon] [--days 90]');
  if (!service.devEnabled()) throw new Error('Set MULTI_BUSINESS_DEVELOPMENT=true in a development environment first');
  if (process.env.NODE_ENV === 'production') throw new Error('Demo data is not for a live database');
  const profile = await users.findProfileById(userId);
  if (!profile || profile.status !== 'active') throw new Error('Active user not found');
  const owner = { ...profile, id: Number(profile.id), restaurantId: profile.restaurant_id ? Number(profile.restaurant_id) : null };
  const only = arg('--only') ? arg('--only').split(',') : null;
  const days = arg('--days') ? Number(arg('--days')) : null;
  const logins = [];
  const lines = [];
  for (const def of DEFINITIONS()) {
    if (only && !only.includes(def.key)) continue;
    if (days) def.days = days;
    const started = Date.now();
    const prepared = await prepare(owner, def, logins);
    const sim = simulation(owner, def, prepared);
    await sim.decimalsReady;
    if (sim.hooks.setup) await sim.hooks.setup(sim);
    const stats = await shop.run(sim);
    const work = await tasks.seed(sim);
    const today = await repo.one(db, `SELECT count(*)::int AS bills, COALESCE(sum(total),0) AS sales FROM business_documents
      WHERE business_id=$1 AND kind='sale' AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date`, [sim.business.id, sim.realToday]);
    lines.push(`  ${def.name}: ${stats.bills} new bills (today ${today.bills}, ₹${Math.round(Number(today.sales)).toLocaleString('en-IN')})${work ? `, ${work}` : ''} [${Math.round((Date.now() - started) / 1000)}s]`);
    console.log(lines[lines.length - 1]);
  }
  const retired = only ? 0 : await oldDemosInactive(owner);
  const file = base.writeLogins(logins);
  console.log(`Realistic demos ready for user ${userId}.${retired ? ` ${retired} old demo businesses marked inactive.` : ''}`);
  if (file) console.log(`New staff logins: ${file}`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => repo.pool.end());
}
module.exports = { main };
