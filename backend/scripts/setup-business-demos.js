// Explicit local setup for an existing administrator. No new credentials and
// no changes to existing restaurant transactions.
//
//   npm run business:demos -- --user-id <existing-admin-id> [--sample-data]
//
// Creates (or finds) one demo business of each type for this person, named
// after them ("Demo · Grocery & kirana — Owner"). With --sample-data it fills
// each of THEIR demos with fictional sample records.
//
// Safe to run again, on a demo in any state: empty, holding the one-item
// placeholder ("DEMO-001") made by an earlier version, half-written by a run
// that stopped, or complete. Every step finds what is already there by its
// natural key (name, code, ISBN, or the request key of a posting — see
// demo-common.js) and creates only what is missing; nothing is made twice.
// Only demos this person created are touched, and the sample never changes or
// uses a tester's own records.
//
// Every record goes through the same services the API uses (permissions,
// number series, stock ledger, events), so the demos look exactly like real
// use. All names, GSTINs and phone numbers are fictional.
require('dotenv').config({ quiet: true });
const service = require('../src/modules/business/core/services/business.service');
const access = require('../src/modules/business/core/services/businessAccess.service');
const returns = require('../src/modules/business/core/services/businessReturns.service');
const stock = require('../src/modules/business/core/services/businessStock.service');
const users = require('../src/modules/access/repositories/user.repository');
const repo = require('../src/modules/business/core/repositories/business.repository');
const common = require('./demo-common');
// 14 digits + the Luhn check digit (what an IMEI is checked against).
function imei(body) {
  const total = [...body].reduce((sum, c, i) => { let d = Number(c); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } return sum + d; }, 0);
  return body + ((10 - (total % 10)) % 10);
}

const { once, pay, CATALOGUES } = common;

async function sample(business, user) {
  const plan = CATALOGUES[business.business_type];
  if (!plan) return;
  const db = repo.pool;
  const { skus } = await common.baseCatalogue(business, user);
  const location = await common.firstLocation(business);
  const second = plan.secondLocation ? await common.location(business, user, plan.secondLocation[0], plan.secondLocation[1]) : null;
  const customers = await common.sampleCustomers(business, user);
  const suppliers = [];
  if (business.capabilities.includes('purchasing')) for (const index of common.SUPPLIERS.keys()) suppliers.push(await common.sampleSupplier(business, user, index));
  const created = [];

  // Receive stock, then sell some of it, spread over this month.
  const goods = skus.filter((s) => s.kind === 'goods');
  const lots = {};
  // A group made earlier without this script's keys (older version) is left as it is.
  const oldStock = await common.legacy(business, 'business_documents', "kind='purchase' AND notes='Opening stock (sample)'");
  const oldSales = await common.legacy(business, 'business_documents', "kind='sale'");
  if (goods.length && suppliers.length) {
    for (const [index, supplier] of oldStock ? [] : suppliers.entries()) {
      const mine = goods.filter((_, i) => i % suppliers.length === index);
      const lines = mine.map((s) => {
        const serial = s.tracking === 'serial';
        // A real-looking IMEI: 35 + the business + a unit number + its check digit.
        const lotCode = serial ? imei(`35${String(business.id).padStart(8, '0')}${index}00`) : s.tracking === 'batch' ? common.batchCode('B', s.code) : '';
        return { skuId: s.id, quantity: serial ? '1' : s.unit === 'kg' ? '60' : s.unit === 'tablet' ? '2000' : '80', unitPrice: (Number(s.price) * 0.68).toFixed(2),
          ...(lotCode ? { lotCode } : {}), ...(s.tracking === 'batch' ? { expiresOn: business.business_type === 'meat' ? addDays(6) : addDays(300) } : {}) };
      });
      // Serials go one per line: add a few more handsets with their own numbers.
      const serialLines = lines.filter((l) => l.lotCode && /^35\d{13}$/.test(l.lotCode));
      for (let n = 1; n < 4 && serialLines.length; n += 1) lines.push({ ...serialLines[0], lotCode: imei(`${serialLines[0].lotCode.slice(0, 12)}0${n}`) });
      if (!lines.length) continue;
      const receipt = await once(business, 'business_documents', `base-purchase-${index}`, (requestKey) => service.document(business, user,
        { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey, lines, notes: 'Opening stock (sample)' }));
      if (receipt.created) created.push(receipt.row.id);
      if (index === 0) await pay(business, user, receipt.row, 'base-purchase-0-paid', { amount: (Number(receipt.row.total) / 2).toFixed(2), method: 'bank', reference: 'NEFT-SAMPLE' });
    }
    // The batch each sample item was received in (whatever its code).
    for (const s of goods.filter((x) => x.tracking === 'batch')) {
      const lot = await repo.one(db, 'SELECT lot_code FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND quantity>0 ORDER BY expires_on NULLS LAST,id LIMIT 1', [business.id, s.id, location.id]);
      if (lot) lots[s.id] = lot.lot_code;
    }
  }
  const sellable = skus.filter((s) => s.kind === 'service' || (s.tracking !== 'serial'));
  let saleCount = 0;
  for (let n = 0; n < 14 && sellable.length && !oldSales; n += 1) {
    const pick = [sellable[n % sellable.length], sellable[(n * 3 + 1) % sellable.length]].filter((s, i, a) => a.indexOf(s) === i);
    const lines = pick.map((s) => ({ skuId: s.id, quantity: s.unit === 'kg' ? ((n % 4) + 1 + 0.25).toFixed(3) : s.unit === 'metre' ? '2.5' : s.unit === 'tablet' ? '10' : String((n % 3) + 1), ...(lots[s.id] ? { lotCode: lots[s.id] } : {}) }));
    if (lines.some((l, i) => pick[i].tracking === 'batch' && !l.lotCode)) continue;
    const customer = n % 3 === 2 ? null : customers[n % customers.length];
    try {
      const sale = await once(business, 'business_documents', `base-sale-${n}`, (requestKey) => service.document(business, user,
        { kind: 'sale', locationId: location.id, contactId: customer?.id || null, requestKey, lines }));
      if (sale.created) created.push(sale.row.id);
      if (n % 4 !== 1) await pay(business, user, sale.row, `base-sale-${n}-paid`, { amount: sale.row.total, method: ['cash', 'upi', 'card'][n % 3] });
      saleCount += 1;
      if (n === 5) {
        const detail = await service.detail(business, sale.row.id);
        await once(business, 'business_returns', 'base-return-5', (requestKey) => returns.createReturn(business, user, sale.row.id,
          { reason: 'Customer changed mind', requestKey, lines: [{ lineId: detail.lines[0].id, quantity: detail.lines[0].unit === 'kg' ? '0.250' : '1', restock: true }] }));
      }
    } catch (error) {
      if (!/stock|credit/i.test(error.message)) throw error;
    }
  }
  // Spread the sample bills this run made over the last few days (oldest
  // first) so lists, the overview and reports look lived-in; never before the
  // start of the month. A tester's own documents are never moved.
  await common.backdate(business, created, `UPDATE business_documents d SET created_at = GREATEST(date_trunc('month', now()) + interval '9 hours',
      now() - ((x.last - d.id) * interval '7 hours'))
    FROM (SELECT max(id) AS last FROM business_documents WHERE business_id=$1 AND id = ANY($2::bigint[])) x WHERE d.business_id=$1 AND d.id = ANY($2::bigint[])`);
  if (second && goods.length && business.capabilities.includes('stock_transfers') && !await common.legacy(business, 'business_stock_transfers', "notes LIKE '%(sample)'")) {
    const movable = (await repo.all(db, `SELECT l.id,l.quantity FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      WHERE l.business_id=$1 AND l.location_id=$2 AND l.quantity>=7 AND s.tracking<>'serial' AND s.id = ANY($3::bigint[]) ORDER BY l.id LIMIT 2`, [business.id, location.id, goods.map((g) => g.id)]));
    if (movable.length) {
      const transfer = await once(business, 'business_stock_transfers', 'base-transfer-1', (requestKey) => stock.createTransfer(business, user,
        { fromLocationId: location.id, toLocationId: second.id, requestKey, notes: 'Weekly top-up (sample)', lines: movable.map((l) => ({ lotId: l.id, quantity: '5' })) }));
      if (transfer.created) await stock.receiveTransfer(business, user, transfer.row.id);
      await once(business, 'business_stock_transfers', 'base-transfer-2', (requestKey) => stock.createTransfer(business, user,
        { fromLocationId: location.id, toLocationId: second.id, requestKey, notes: 'In the van now (sample)', lines: [{ lotId: movable[0].id, quantity: '2' }] }));
    }
  }
  if (goods.length && business.capabilities.includes('stock_counts') && !await common.legacy(business, 'business_stock_counts', "notes='Shelf check (sample)'")) {
    const count = await once(business, 'business_stock_counts', 'base-count', (requestKey) => stock.createCount(business, user, { locationId: location.id, requestKey, notes: 'Shelf check (sample)' }));
    if (count.created) {
      const sheet = await stock.countDetail(business, count.row.id);
      await stock.enterCounts(business, user, count.row.id, { lines: sheet.lines.slice(0, Math.max(1, sheet.lines.length - 2)).map((l, i) => ({
        lineId: l.id, countedQuantity: i === 0 && Number(l.current_quantity) >= 1 ? String(Number(l.current_quantity) - 1) : String(Number(l.current_quantity)), reason: i === 0 ? 'Damaged packet' : null })) });
    }
  }
  // A salon's stylists, rooms and bookings come from demo-salon-weight.js, which
  // books through the salon rules (skills, rooms, hours, deposits).
  if (plan.resources && business.capabilities.includes('appointments') && business.business_type !== 'salon') {
    const people = [];
    for (const [name, roleLabel] of plan.resources) {
      people.push(await repo.one(db, 'SELECT * FROM business_resources WHERE business_id=$1 AND name=$2 ORDER BY id LIMIT 1', [business.id, name])
        || await service.resource(business, user, { name, roleLabel, locationId: location.id }));
    }
    const services = skus.filter((s) => s.kind === 'service');
    // Bookings have no request key here: added once, while the sample staff have none.
    const booked = await repo.one(db, 'SELECT 1 FROM business_appointments WHERE business_id=$1 AND resource_id = ANY($2::bigint[]) LIMIT 1', [business.id, people.map((p) => p.id)]);
    if (!booked && services.length) {
      const base = new Date();
      base.setMinutes(0, 0, 0);
      for (let n = 0; n < 8; n += 1) {
        const starts = new Date(base.getTime() + (n - 2) * 60 * 60000 + Math.floor(n / 3) * 86400000);
        try {
          const booking = await service.appointment(business, user, { contactId: customers[n % customers.length].id, skuId: services[n % services.length].id,
            resourceId: people[n % 2].id, startsAt: starts.toISOString(), endsAt: new Date(starts.getTime() + 45 * 60000).toISOString() });
          if (n < 2) await service.appointmentStatus(business, user, booking.id, { status: 'completed' });
        } catch (error) {
          if (!/already has/.test(error.message)) throw error;
        }
      }
    }
  }
  console.log(`  ${business.name}: ${skus.length} sample items, ${customers.length} customers, ${saleCount} sample sales (${created.length} documents new this run)`);
}
function addDays(days) {
  const date = new Date(Date.now() + days * 86400000);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const userId = Number(process.argv[process.argv.indexOf('--user-id') + 1]);
  if (!process.argv.includes('--user-id') || !Number.isSafeInteger(userId) || userId <= 0) throw new Error('Usage: npm run business:demos -- --user-id <existing-admin-id> [--sample-data]');
  if (!service.devEnabled()) throw new Error('Set MULTI_BUSINESS_DEVELOPMENT=true in a development environment first');
  const profile = await users.findProfileById(userId);
  if (!profile || profile.status !== 'active' || (profile.restaurant_id && profile.restaurant_status !== 'active')) throw new Error('Active administrator not found');
  const user = { ...profile, restaurantId: profile.restaurant_id };
  if (user.roles.includes('RESTAURANT_ADMIN')) await service.linkRestaurant(user);
  const result = await service.provision(user);
  if (process.argv.includes('--sample-data')) {
    // Only this person's own demos (a demo someone else shared with them is theirs, not ours).
    const mine = (await repo.all(repo.pool, 'SELECT id,business_type FROM businesses WHERE is_demo AND created_by=$1 AND code LIKE $2 AND status=\'active\' ORDER BY id',
      [userId, `DEMO-${userId}-%`]));
    const load = (row) => access.load(user, row.id);
    const ofType = (types) => mine.filter((b) => types.includes(b.business_type));
    for (const row of mine) await sample(await load(row), user);
    // Type extras: each finds or creates what it depends on and skips what it already added.
    for (const row of ofType(['wholesale'])) await require('./demo-wholesale').sampleWholesale(await load(row), user);
    for (const row of ofType(['grocery', 'supermarket', 'books'])) await require('./demo-retail').sampleRetail(await load(row), user);
    for (const row of ofType(['fashion', 'electronics'])) {
      const extras = require('./demo-fashion-electronics');
      const business = await load(row);
      await (business.business_type === 'fashion' ? extras.sampleFashion : extras.sampleElectronics)(business, user);
    }
    for (const row of ofType(['salon', 'meat', 'weight_retail'])) {
      const extras = require('./demo-salon-weight');
      const business = await load(row);
      await (business.business_type === 'salon' ? extras.sampleSalon : extras.sampleWeight)(business, user);
    }
  }
  console.log(`Business demos ready for administrator ${userId}: ${result.businesses.length} businesses. Restaurant records preserved.`);
}
if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => repo.pool.end());
}
module.exports = { sample, main };
