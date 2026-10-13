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
const RENAME = { UPI: 'Google Pay', Card: 'Card (HDFC machine)', 'Bank transfer': 'Bank transfer (NEFT / IMPS)' };

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

async function run(sim) {
  await paymentMethods(sim);
  await rules(sim);
  const named = await namePayments(sim);
  return named ? `${named} payments named` : '';
}

module.exports = { run };
