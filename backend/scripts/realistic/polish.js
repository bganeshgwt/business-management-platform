// The finishing touches of a realistic demo business (12 Oct 2026): the
// payment methods its counter really names (PhonePe, Google Pay, Paytm, the
// bank's card machine), the names on the money it has taken over the story,
// and the house rules an owner of that kind of shop would set (Business
// settings › Rules). Safe to run again.
const repo = require('../../src/modules/business/core/repositories/business.repository');
const methods = require('../../src/modules/business/core/services/businessPaymentMethods.service');

const db = repo.pool;

// What each shop calls its ways to pay. Default methods are renamed; the
// others are added. UPI money is spread over the apps in these shares.
const UPI_APPS = [['PhonePe', 3], ['Google Pay', 3], ['Paytm', 1]];
const EXTRA = {
  supermarket: [{ name: 'Pluxee meal card', kind: 'card' }],
  salon: [{ name: 'Razorpay payment link', kind: 'upi' }],
  wholesale: [{ name: 'RTGS (Bank of Maharashtra)', kind: 'bank' }],
};
const RENAME = { UPI: 'Google Pay', 'Card (HDFC machine)': 'Card', 'Bank transfer': 'Bank transfer (NEFT / IMPS)' };

// House rules per kind of shop; anything not named keeps the default.
const RULES = {
  kirana: { receipt_width_mm: 58, weight_buttons_grams: [100, 250, 500, 1000] },
  supermarket: { near_expiry_days: 15 },
  wholesale: { ageing_days: [15, 30, 45] },
  fashion: { voucher_valid_days: 60 },
  meat: { weight_buttons_grams: [250, 500, 750, 1000, 1500, 2000], near_expiry_days: 2, receipt_width_mm: 58 },
  dryfruits: { weight_buttons_grams: [100, 250, 500, 1000] },
  pharmacy: { near_expiry_days: 90 },
  books: { voucher_valid_days: 180 },
};

async function paymentMethods(sim) {
  const { business, owner, def } = sim;
  const current = await methods.list(business, { all: true });
  for (const m of current) {
    const name = RENAME[m.name];
    if (name && !current.some((x) => x.name === name)) await methods.update(business, owner, m.id, { name });
  }
  const now = await methods.list(business, { all: true });
  const wanted = [...UPI_APPS.filter(([name]) => name !== 'Google Pay').map(([name]) => ({ name, kind: 'upi' })), ...(EXTRA[def.key] || [])];
  for (const m of wanted) if (!now.some((x) => x.name === m.name)) await methods.create(business, owner, m);
}

// Each payment of the story gets the name of the method it was taken by.
async function namePayments(sim) {
  const id = sim.business.id;
  const list = await methods.list(sim.business, {});
  const named = (kind) => list.filter((m) => m.kind === kind).map((m) => m.name);
  const upi = UPI_APPS.filter(([name]) => named('upi').includes(name)).flatMap(([name, share]) => Array(share).fill(name));
  const choices = { upi: upi.length ? upi : named('upi'), card: named('card').filter((n) => !/meal/i.test(n)), bank: named('bank').slice(0, 1), cash: named('cash').slice(0, 1), cheque: named('cheque').slice(0, 1) };
  // A meal card pays a share of a supermarket's card bills.
  if (sim.def.key === 'supermarket' && named('card').some((n) => /meal/i.test(n))) choices.card = [...choices.card, ...choices.card, ...choices.card, ...named('card').filter((n) => /meal/i.test(n))];
  const cases = Object.entries(choices).filter(([, names]) => names.length)
    .map(([kind, names]) => `WHEN '${kind}' THEN (ARRAY[${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')}])[1 + (id % ${names.length})]`).join(' ');
  if (!cases) return 0;
  let total = 0;
  for (const table of ['business_payments', 'business_refunds', 'business_collections', 'business_supplier_payments', 'business_collection_refunds']) {
    try {
      const result = await db.query(`UPDATE ${table} SET method_name = CASE method ${cases} ELSE method_name END WHERE business_id=$1 AND method_name IS NULL`, [id]);
      total += result.rowCount;
    } catch {
      // A table whose posted rows may not change keeps its rows as they are.
    }
  }
  return total;
}

async function rules(sim) {
  const wanted = RULES[sim.def.key];
  if (!wanted) return;
  const keys = Object.keys(wanted);
  const current = await repo.one(db, `SELECT ${keys.join(',')} FROM business_settings WHERE business_id=$1`, [sim.business.id]);
  if (keys.every((k) => JSON.stringify(current[k]) === JSON.stringify(wanted[k]))) return;
  await repo.transaction(async (tx) => {
    await tx.query(`UPDATE business_settings SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE business_id=$1`, [sim.business.id, ...keys.map((k) => wanted[k])]);
    await repo.audit(tx, sim.business.id, sim.owner.id, 'settings.rules_updated', sim.business.id, wanted);
  });
}

// Opening hours of each shop, by trade (a day left out is closed).
const week = (open, close, days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) => Object.fromEntries(days.map((d) => [d, { open, close }]));
const HOURS = {
  kirana: week('07:00', '22:00'), supermarket: week('08:00', '22:00'), wholesale: week('09:00', '19:00', ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
  fashion: week('10:30', '21:30'), electronics: week('10:00', '21:00'), salon: week('09:00', '21:00'), meat: week('06:00', '14:00'),
  dryfruits: week('09:30', '21:00'), books: week('09:30', '20:30', ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']), pharmacy: week('08:00', '23:00'), clinic: week('09:00', '20:00', ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
};
async function openingHours(sim) {
  const hours = HOURS[sim.def.key];
  if (!hours) return;
  await db.query('UPDATE business_locations SET opening_hours=$2 WHERE business_id=$1 AND opening_hours IS NULL', [sim.business.id, JSON.stringify(hours)]);
}

// The supermarket's shelf places, member prices on staples and a welcome coupon.
const SHELVES = [[/rice|atta|dal|oil|sugar|salt/i, 'Aisle 1 · Staples'], [/milk|curd|butter|paneer|cheese|bread/i, 'Dairy chiller'], [/biscuit|chips|noodle|snack/i, 'Aisle 4 · Snacks'],
  [/soap|shampoo|paste|detergent|cleaner/i, 'Aisle 6 · Home & care'], [/frozen|peas|ice/i, 'Freezer 2']];
async function supermarketExtras(sim) {
  if (sim.def.key !== 'supermarket') return;
  const items = await repo.all(db, 'SELECT id,label,price,shelf_location,member_price FROM catalog_skus WHERE business_id=$1 AND active', [sim.business.id]);
  for (const item of items) {
    const shelf = !item.shelf_location && SHELVES.find(([pattern]) => pattern.test(item.label))?.[1];
    // Members pay about 3% less on staples, rounded down to the rupee.
    const member = !item.member_price && /rice|atta|dal|oil|sugar/i.test(item.label) && Number(item.price) >= 50 ? Math.floor(Number(item.price) * 0.97) : null;
    if (shelf || member) await db.query('UPDATE catalog_skus SET shelf_location=COALESCE($3,shelf_location),member_price=COALESCE($4,member_price) WHERE business_id=$1 AND id=$2', [sim.business.id, item.id, shelf || null, member]);
  }
  if (!sim.business.modules.includes('offers')) return;
  if (await repo.one(db, "SELECT 1 FROM retail_offers WHERE business_id=$1 AND coupon_code='WELCOME50'", [sim.business.id])) return;
  await require('../../src/modules/business/retail/services/businessRetailOffers.service').createOffer(sim.business, sim.owner,
    { name: 'Welcome coupon: Rs 50 off a first big shop', kind: 'bill_amount', value: '50', minBillAmount: '500', startsOn: '2026-01-01', couponCode: 'WELCOME50', perCustomerLimit: 1 });
}

// A salon's back-bar products ("(salon use)") are used in services, never sold.
async function salonUse(sim) {
  if (sim.def.key !== 'salon') return;
  await db.query("UPDATE catalog_skus SET internal_use=TRUE WHERE business_id=$1 AND label ILIKE '%(salon use)%' AND NOT internal_use", [sim.business.id]);
}

async function run(sim) {
  await paymentMethods(sim);
  await salonUse(sim);
  await rules(sim);
  await openingHours(sim);
  await supermarketExtras(sim);
  const named = await namePayments(sim);
  return named ? `${named} payments named` : '';
}

module.exports = { run };
