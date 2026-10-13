// Branches of the realistic demo businesses (12 Oct 2026): a second shop for
// the businesses a real owner would run in more than one place, each with its
// own address (and, for a branch in another state, its own GSTIN), its own
// manager and cashier tied to it, stock moved from the main store, and its own
// ninety days of trade made by the same simulator as the main store (shop.js),
// at a share of the main store's volume. A pharmacy branch holds its own drug
// licences and sells over-the-counter medicines; an electronics branch sells
// accessories (phones stay serial-tracked at the main showroom); a wholesale
// depot holds stock and makes no counter sales.
//
// Safe to run again: a branch's postings carry its own step prefix and its
// history its own marker, exactly as the main store's do.
const crypto = require('crypto');
const repo = require('../../src/modules/business/core/repositories/business.repository');
const service = require('../../src/modules/business/core/services/business.service');
const access = require('../../src/modules/business/core/services/businessAccess.service');
const stock = require('../../src/modules/business/core/services/businessStock.service');
const healthCommon = require('../../src/modules/business/health/services/healthCommon');
const setup = require('../../src/modules/business/core/services/businessSetup.service');
const { gstinCheckCharacter } = require('../../src/utils/gstin');
const base = require('./base');
const shop = require('./shop');
const clock = require('./clock');
const machine = require('./machine');

const db = repo.pool;
// The same PAN registered in another state: its state code, the PAN and entity
// number (the first 14 characters), and a fresh check character.
const otherState = (gstin, state) => (gstin ? `${state}${gstin.slice(2, 14)}` : null);
const withCheck = (first14) => (first14 ? first14 + gstinCheckCharacter(first14) : null);

const BRANCHES = {
  supermarket: [{ code: 'JNR', name: 'JP Nagar branch', address: ['14, 24th Main Road, JP Nagar 2nd Phase', 'Opp. Ragigudda temple'], city: 'Bengaluru', pin: '560078', phone: '080 2659 3318',
    share: 0.45, staff: [{ login: 'prakash', name: 'Prakash Rao', role: 'manager' }], tie: ['kavya'] }],
  fashion: [{ code: 'BLR', name: 'Commercial Street showroom, Bengaluru', address: ['42, Commercial Street', 'Tasker Town, Shivajinagar'], city: 'Bengaluru', pin: '560001', phone: '080 2559 7720',
    state: '29', ownGstin: true, share: 0.5, staff: [{ login: 'divya', name: 'Divya Ramesh', role: 'manager' }, { login: 'arun', name: 'Arun Kumar', role: 'cashier' }] }],
  electronics: [{ code: 'KKP', name: 'Kukatpally accessories store', address: ['Plot 23, KPHB Road No. 1', 'Near JNTU metro station'], city: 'Hyderabad', pin: '500072', phone: '040 2305 6611',
    share: 0.6, only: (item) => item.tracking !== 'serial', staff: [{ login: 'naveen', name: 'Naveen Reddy', role: 'manager' }, { login: 'sravani', name: 'Sravani K', role: 'cashier' }] }],
  meat: [{ code: 'MDP', key: 'MDP2', name: 'Mehdipatnam shop', address: ['10-3-152, Rethibowli', 'Mehdipatnam'], city: 'Hyderabad', pin: '500028', phone: '040 2351 4490',
    share: 0.35, staff: [] },
  { code: 'MDP', name: 'Mehdipatnam shop', address: ['10-3-152, Rethibowli', 'Mehdipatnam'], city: 'Hyderabad', pin: '500028', phone: '040 2351 4490',
    share: 0.5, staff: [{ login: 'irfan', name: 'Mohammed Irfan', role: 'manager' }, { login: 'sameer', name: 'Sameer Khan', role: 'cashier' }] }],
  dryfruits: [{ code: 'CCK', name: 'Chandni Chowk shop', address: ['1872, Khari Baoli', 'Chandni Chowk'], city: 'New Delhi', pin: '110006', phone: '011 2392 4471',
    share: 0.6, staff: [{ login: 'rohit', name: 'Rohit Aggarwal', role: 'manager' }, { login: 'pooja', name: 'Pooja Sharma', role: 'cashier' }] }],
  pharmacy: [{ code: 'ADY', name: 'Adyar shop', address: ['22, LB Road', 'Adyar'], city: 'Chennai', pin: '600020', phone: '044 2441 8836',
    share: 0.55, licences: { drugLicence20: 'TN-02-20-118842', drugLicence21: 'TN-02-21-118843' },
    staff: [{ login: 'lakshmin', name: 'Lakshmi Narayanan', role: 'manager' }, { login: 'karthik', name: 'Karthik S', role: 'cashier' }] }],
  wholesale: [{ code: 'BGM', name: 'Belagavi depot', address: ['Plot 61, Udyambag Industrial Area', 'Khanapur Road'], city: 'Belagavi', pin: '590008', phone: '0831 244 9012',
    state: '29', ownGstin: true, share: 0, staff: [{ login: 'basavaraj', name: 'Basavaraj Patil', role: 'stock_keeper' }] }],
};

// Pharmacy branches sell only what needs no prescription.
async function overTheCounter(businessId) {
  const rows = await repo.all(db, "SELECT sku_id FROM pharmacy_drugs WHERE business_id=$1 AND schedule IN ('H','H1','X','narcotic')", [businessId]);
  const scheduled = new Set(rows.map((r) => Number(r.sku_id)));
  return (item) => !scheduled.has(Number(item.id));
}

async function ensureBranch(sim, b) {
  const { business, owner, def } = sim;
  const gstin = b.ownGstin ? withCheck(otherState(def.gstin, b.state)) : null;
  const fields = { addressLine1: b.address[0], addressLine2: b.address[1], city: b.city, postalCode: b.pin, phone: b.phone,
    stateCode: b.state || (def.gstin ? def.gstin.slice(0, 2) : null), gstin };
  let location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND code=$2', [business.id, b.code]);
  if (!location) location = await service.createLocation(business, owner, { name: b.name, code: b.code, ...fields });
  else location = await service.updateLocation(business, owner, location.id, { name: b.name, active: true, ...fields });
  if (b.licences) await healthCommon.saveLocationLicences(business, owner, location.id, b.licences);
  return location;
}

// The branch's people: its own manager and cashier, tied to it.
async function branchStaff(sim, b, location, logins) {
  const { business, owner, def } = sim;
  // Branch logins carry the branch code (never the main store's login); one
  // already working at this branch under its plain login keeps it.
  const own = [];
  for (const p of b.staff) {
    const plain = await repo.one(db, `SELECT 1 FROM users u JOIN business_memberships m ON m.user_id=u.id AND m.business_id=$1 AND m.location_id=$2
      WHERE lower(u.email)=lower($3)`, [business.id, location.id, `${p.login}@${def.key}.demo.test`]);
    own.push(plain ? p : { ...p, login: `${b.code.toLowerCase()}.${p.login}` });
  }
  const made = await base.ensureStaff(business, owner, { key: def.key, name: def.name, staff: own }, logins);
  const tied = [...made];
  for (const login of b.tie || []) {
    const person = sim.staff.find((s) => s.login === login);
    if (person) tied.push(person);
  }
  for (const person of tied) {
    const member = await repo.one(db, 'SELECT role_id,location_id FROM business_memberships WHERE business_id=$1 AND user_id=$2', [business.id, person.user.id]);
    if (Number(member.location_id) !== Number(location.id)) {
      await access.setMember(business, owner, { userId: person.user.id, roleId: member.role_id, workLocationId: location.id, active: true });
    }
    person.business = await access.load(person.user, business.id);
  }
  // Everyone else already working at the branch (a second pass of its trade).
  const others = await repo.all(db, 'SELECT user_id FROM business_memberships WHERE business_id=$1 AND location_id=$2 AND active', [business.id, location.id]);
  for (const row of others) {
    if (tied.some((p) => Number(p.user.id) === Number(row.user_id))) continue;
    const user = await repo.one(db, 'SELECT id,name FROM users WHERE id=$1', [row.user_id]);
    const self = { id: Number(user.id), name: user.name, restaurantId: owner.restaurantId };
    const role = await repo.one(db, 'SELECT r.template_code FROM business_memberships m JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id WHERE m.business_id=$1 AND m.user_id=$2', [business.id, user.id]);
    tied.push({ login: null, name: user.name, role: role?.template_code || 'cashier', user: self, business: await access.load(self, business.id) });
  }
  // Those now tied to the branch no longer work the main store's till.
  sim.staff = sim.staff.filter((s) => !(b.tie || []).includes(s.login));
  return tied;
}

// Stock moved from the main store on the branch's second day, and one
// transfer still on its way today.
async function transfers(sim, b, location, start) {
  const { business, owner } = sim;
  const send = async (step, day, minutes, count, receive) => {
    const lots = await repo.all(db, `SELECT l.id,l.sku_id,l.quantity FROM business_stock_lots l JOIN catalog_skus s ON s.business_id=l.business_id AND s.id=l.sku_id
      WHERE l.business_id=$1 AND l.location_id=$2 AND l.quantity>=10 AND s.tracking<>'serial' ORDER BY l.quantity DESC, l.id LIMIT $3`, [business.id, sim.location.id, count]);
    if (!lots.length) return;
    const result = await shop.post(sim, 'business_stock_transfers', step, clock.at(day, minutes), (requestKey) => stock.createTransfer(business, owner, {
      requestKey, fromLocationId: sim.location.id, toLocationId: location.id, notes: receive ? `Stock for ${b.name}` : `Weekly top-up for ${b.name}`,
      lines: lots.map((l) => ({ lotId: l.id, skuId: l.sku_id, quantity: String(Math.max(1, Math.floor(Number(l.quantity) / 8))) })),
    }));
    if (receive && result.created && result.row.status === 'in_transit') {
      await machine.at(business.id, clock.at(day, minutes + 120), () => stock.receiveTransfer(business, owner, result.row.id), { touch: [['business_stock_transfers', 'id', result.row.id]] });
    }
  };
  await send(`branch-${b.code}-transfer-open`, clock.addDays(start, 1), sim.def.open - 30, 8, true);
  await send(`branch-${b.code}-transfer-today`, sim.realToday, Math.min(clock.minutesNow() - 30, sim.def.open + 60), 4, false);
}

async function run(sim, logins) {
  const plans = BRANCHES[sim.def.key] || [];
  const lines = [];
  for (const b of plans) {
    const start = clock.addDays(sim.realToday, -sim.def.days);
    const location = await machine.at(sim.business.id, clock.at(clock.addDays(start, -1), '11:00'), () => ensureBranch(sim, b), { keepDates: true });
    const staff = await branchStaff(sim, b, location, logins);
    const only = sim.def.key === 'pharmacy' ? await overTheCounter(sim.business.id) : b.only || (() => true);
    const items = sim.items.filter((i) => only(i) && i.kind === 'goods' && i.supplier && i.target > 0 && !i.meta.noOpening);
    const branchSim = {
      ...sim,
      code: `${sim.code}|${b.key || b.code}`, stepPrefix: `branch-${b.key || b.code}-`, billSuffix: `-${b.key || b.code}`,
      markerKey: `demo.branch_history:${b.key || b.code}`, morningKey: `demo.branch_morning:${b.key || b.code}`,
      location, staff, items, hooks: {}, orders: new Map(), recent: [], expiryFixes: [], extra: {}, turn: 0, shortItems: new Set(),
      regulars: [],
      def: { ...sim.def, udhaar: false, volume: (day, r, s) => (b.share ? (sim.def.volume(day, r, s) || 0) * b.share : 0) },
    };
    await shop.loadStock(branchSim);
    const stats = b.share ? await shop.run(branchSim) : { bills: 0 };
    if (!b.share) {
      // A depot: its opening stock, bought in like any location's.
      const marked = await base.marker(sim.business.id, branchSim.markerKey);
      if (!marked) await shop.openingStockAt(branchSim, start);
      if (!marked) await base.setMarker(sim.business.id, sim.owner.id, branchSim.markerKey, { through: clock.addDays(sim.realToday, -1) });
    }
    // A business with two branches moves stock between them: Stock transfers on
    // (where its type offers it).
    if (!sim.business.modules.includes('stock_transfers')) {
      try {
        await setup.setModule(sim.business, sim.owner, 'stock_transfers', { enabled: true });
        sim.business = await access.load(sim.owner, sim.business.id);
      } catch { /* not offered for this type: no transfers */ }
    }
    if (sim.business.modules.includes('stock_transfers') && !b.key) await transfers(sim, b, location, start);
    lines.push(`${b.name} (${stats.bills} new bills)`);
  }
  return lines.length ? `branches: ${lines.join(', ')}` : '';
}

module.exports = { run, BRANCHES };
// Kept for a one-off key in the future (not used for postings).
module.exports.key = () => crypto.randomUUID();
