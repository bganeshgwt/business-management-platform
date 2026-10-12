// Round 2 (R2-CORE) demo data, added once to any load (constant keys):
//   - shop counters (kirana, supermarket, electronics): bills paid several
//     ways (cash + UPI, UPI + card, cash + UPI with the rest on udhaar);
//   - every counter cashier and manager has a till PIN (written to the local
//     logins file next to their password, never printed);
//   - the supermarket: a bill paid partly with points, half of it returned,
//     the spent points given back in proportion;
//   - electronics: two kits (phone + cover + guard, an accessory starter
//     pack) and their sales; EMI sales with Bajaj Finserv, HDFC Bank and TVS
//     Credit, one payout received net of the subvention, one case waiting
//     over 15 days.
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const service = require('../../../src/modules/business/core/services/business.service');
const returns = require('../../../src/modules/business/core/services/businessReturns.service');
const kits = require('../../../src/modules/business/core/services/businessKits.service');
const finance = require('../../../src/modules/business/fashion-electronics/services/businessFinance.service');
const retail = require('../../../src/modules/business/retail/services/businessRetail.service');
const retailCustomers = require('../../../src/modules/business/retail/services/businessRetailCustomers.service');
const auth = require('../../../src/modules/access/services/auth.service');
const users = require('../../../src/modules/access/repositories/user.repository');
const { people, mobile } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');
const machine = require('../machine');

const LOGINS_FILE = path.resolve(__dirname, '../../../.local/realistic-demo-logins.json');

// --- Till PINs -------------------------------------------------------------------------------
async function tillPins(sim) {
  const given = {};
  for (const person of sim.staff.filter((s) => ['cashier', 'manager'].includes(s.role))) {
    const row = await users.findPinById(person.user.id);
    if (!row || row.pin_hash) continue;
    let pin;
    for (;;) {
      pin = String(crypto.randomInt(1000, 1000000)).padStart(4, '0').slice(0, crypto.randomInt(4, 7));
      try { auth.assertGoodPin(pin, row.mobile); break; } catch { /* weak: another */ }
    }
    await users.setPin(person.user.id, await auth.hashPin(pin), sim.owner.id);
    given[`${person.login}@${sim.def.key}.demo.test`] = pin;
  }
  if (!Object.keys(given).length) return;
  try {
    const saved = JSON.parse(fs.readFileSync(LOGINS_FILE, 'utf8'));
    for (const account of saved.accounts) if (given[account.email]) account.tillPin = given[account.email];
    fs.writeFileSync(LOGINS_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  } catch { /* no logins file (staff made elsewhere): the PINs stay unknown; an admin resets them under Users */ }
}

// --- Split payment ---------------------------------------------------------------------------
const pick = (sim, r, n) => {
  const pool = sim.items.filter((i) => i.kind === 'goods' && i.tracking === 'quantity' && (i.meta.w ?? 0) > 0 && i.price >= 40);
  const out = [];
  while (out.length < n && pool.length) out.push({ item: pool.splice(r.int(0, pool.length - 1), 1)[0], qty: r.int(1, 2) });
  return out;
};
async function splitBills(sim, today) {
  const now = clock.minutesNow();
  const udhaarRegular = sim.regulars.find((c) => c.udhaar) || sim.regulars[0];
  const plans = [
    { key: 'r2-split-cash-upi', day: clock.addDays(today, -1), at: sim.def.open + 190, parts: ['cash', 'upi'], size: 5 },
    { key: 'r2-split-upi-card', day: clock.addDays(today, -1), at: sim.def.open + 560, parts: ['upi', 'card'], size: 6 },
    { key: 'r2-split-today', day: today, at: sim.def.open + 70, parts: ['cash', 'upi', 'card'], size: 7 },
    { key: 'r2-split-udhaar', day: today, at: sim.def.open + 140, parts: ['cash', 'upi'], size: 6, customer: udhaarRegular, leave: 0.3 },
  ];
  for (const plan of plans) {
    if (plan.day === today && plan.at > now) continue;
    if (await repo.one(base.db, 'SELECT 1 FROM business_documents WHERE business_id=$1 AND request_key=$2', [sim.business.id, base.key(sim.business.id, plan.key)])) continue;
    const r = clock.rng(`${sim.code}|${plan.key}`);
    const lines = shop.fill(sim, pick(sim, r, plan.size), plan.day);
    if (lines.length < 2) continue;
    const who = shop.actor(sim, 'cashier', 'manager');
    const quote = await retail.quote(who.business, who.user, { locationId: sim.location.id, contactId: plan.customer?.contact.id || null, lines: lines.map((l) => l.line) });
    const total = Math.round(Number(quote.total) * 100);
    const covered = Math.round(total * (1 - (plan.leave || 0)));
    const first = Math.round(covered * 0.4 / 1000) * 1000; // a round ₹10 note amount
    const payments = plan.parts.map((method, i) => ({ method, amount: i === 0 ? (first / 100).toFixed(2) : null }));
    let left = covered - first;
    for (let i = 1; i < payments.length; i += 1) {
      const part = i === payments.length - 1 ? left : Math.round(left / 2);
      payments[i].amount = (part / 100).toFixed(2); left -= part;
      if (payments[i].method === 'upi') payments[i].reference = `UPI ${r.int(100000000, 999999999)}`;
    }
    // The customer hands over the next ₹100 note above the cash part.
    if (payments[0].method === 'cash') payments[0].tendered = (Math.ceil(first / 10000) * 100).toFixed(2);
    if (payments.some((p) => Number(p.amount) <= 0)) continue;
    await shop.bill(sim, plan.day, { step: plan.key, minutes: plan.at, customer: plan.customer || null, lines, udhaar: Boolean(plan.leave), method: 'cash', payments, actor: who });
  }
}

// --- Points spent, back on a return (supermarket) -----------------------------------------------
async function pointsReturn(sim, today) {
  if (!sim.def.loyalty) return;
  const now = clock.minutesNow();
  const day = clock.addDays(today, -1);
  const key = 'r2-points-return-sale';
  const regular = sim.regulars[3] || sim.regulars[0];
  const balance = Number((await repo.one(base.db, 'SELECT COALESCE(sum(points),0)::int AS b FROM retail_loyalty_entries WHERE business_id=$1 AND contact_id=$2', [sim.business.id, regular.contact.id])).b);
  const already = await repo.one(base.db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [sim.business.id, base.key(sim.business.id, key)]);
  if (!already && balance < sim.def.loyalty.minRedeemPoints) {
    const who = shop.actor(sim, 'manager');
    await machine.at(sim.business.id, clock.at(day, sim.def.open + 30), () => retailCustomers.adjustPoints(who.business, who.user, regular.contact.id,
      { points: sim.def.loyalty.minRedeemPoints * 2, reason: 'Festival bonus points', requestKey: base.key(sim.business.id, 'r2-points-bonus') }));
  }
  const r = clock.rng(`${sim.code}|${key}`);
  const lines = shop.fill(sim, pick(sim, r, 4), day);
  if (!already && lines.length >= 2) {
    await shop.bill(sim, day, { step: key, minutes: sim.def.open + 600, customer: regular, lines, udhaar: false, method: 'upi', extra: { loyalty: { redeemPoints: String(sim.def.loyalty.minRedeemPoints) } } });
  }
  const doc = await repo.one(base.db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [sim.business.id, base.key(sim.business.id, key)]);
  if (!doc || sim.def.open + 90 > now) return;
  const line = await repo.one(base.db, 'SELECT * FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY quantity DESC,id LIMIT 1', [sim.business.id, doc.id]);
  const back = String(Math.max(1, Math.floor(Number(line.quantity) / 2)));
  await shop.post(sim, 'business_returns', 'r2-points-return', clock.at(today, sim.def.open + 80), (requestKey) => returns.createReturn(sim.business, sim.owner, doc.id, {
    requestKey, reason: 'Pack seal broken; customer brought it back', lines: [{ lineId: line.id, quantity: back, restock: false }] }));
}

// --- Electronics: kits and EMI ---------------------------------------------------------------------
const KITS = [
  { code: 'KIT-NOVA5G-BK', name: 'Nova 5G combo: phone + back cover + screen guard', parts: [['PH-NOVA5G-BK', 1], ['AC-COVER', 1], ['AC-GLASS', 1]], price: 22299, barcode: '2009000000017' },
  { code: 'KIT-STARTER', name: 'Accessory starter pack: screen guard + cover + USB-C cable', parts: [['AC-GLASS', 1], ['AC-COVER', 1], ['AC-CABLE', 1]], price: 599, barcode: '2009000000024' },
];
async function ensureKits(sim) {
  const item = (code) => sim.items.find((i) => i.code === code);
  const made = {};
  for (const kit of KITS) {
    let row = await repo.one(base.db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND code=$2', [sim.business.id, kit.code]);
    if (!row) {
      const parts = kit.parts.map(([code, quantity]) => ({ skuId: item(code).id, quantity }));
      const mrp = kit.parts.reduce((s, [code, q]) => s + Number(item(code).meta.mrp ?? item(code).mrp ?? item(code).price) * q, 0);
      row = await machine.at(sim.business.id, clock.at(clock.addDays(sim.realToday, -12), sim.def.open + 20), () => kits.create(sim.business, sim.owner,
        { name: kit.name, code: kit.code, barcode: kit.barcode, price: String(kit.price), mrp: String(Math.max(mrp, kit.price)), components: parts }));
    }
    made[kit.code] = row;
  }
  return made;
}
function serialLot(sim, code) {
  const item = sim.items.find((i) => i.code === code);
  return shop.lotsOf(sim, item.id).filter((l) => l.qty > 0).sort((a, b) => String(a.code).localeCompare(String(b.code)))[0] || null;
}
async function kitSales(sim, today, made) {
  const now = clock.minutesNow();
  const item = (code) => sim.items.find((i) => i.code === code);
  const plans = [
    { key: 'r2-kit-nova-1', day: clock.addDays(today, -6), at: sim.def.open + 420, kit: 'KIT-NOVA5G-BK', method: 'card' },
    { key: 'r2-kit-starter-1', day: clock.addDays(today, -2), at: sim.def.open + 300, kit: 'KIT-STARTER', method: 'upi' },
    { key: 'r2-kit-starter-2', day: today, at: sim.def.open + 50, kit: 'KIT-STARTER', method: 'cash' },
  ];
  for (const plan of plans) {
    if (plan.day === today && plan.at > now) continue;
    if (await repo.one(base.db, 'SELECT 1 FROM business_documents WHERE business_id=$1 AND request_key=$2', [sim.business.id, base.key(sim.business.id, plan.key)])) continue;
    const kit = made[plan.kit];
    const def = KITS.find((k) => k.code === plan.kit);
    const taken = [];
    const components = [];
    let ok = true;
    for (const [code] of def.parts) {
      const part = item(code);
      if (part.tracking === 'serial') {
        const lot = serialLot(sim, code);
        if (!lot) { ok = false; break; }
        components.push({ skuId: part.id, lotCode: lot.code });
        taken.push({ item: part, qty: 1, lot });
      } else {
        const lot = shop.usableLots(sim, part, plan.day).find((l) => l.qty >= 1);
        if (!lot) { ok = false; break; }
        taken.push({ item: part, qty: 1, lot });
      }
    }
    if (!ok) continue;
    const person = people('telugu', 1, `kit|${plan.key}`)[0];
    const who = shop.actor(sim, 'cashier', 'manager');
    const result = await shop.post(sim, 'business_documents', plan.key, clock.at(plan.day, plan.at), (requestKey) => service.document(who.business, who.user, {
      kind: 'sale', requestKey, locationId: sim.location.id, lines: [{ skuId: kit.id, quantity: '1', ...(components.length ? { components } : {}) }],
      ...(components.length ? { buyer: { name: person.name, phone: mobile(`kit|${plan.key}`) } } : {}), payment: { amount: 'full', method: plan.method } }));
    if (result.created) shop.takeStock(taken);
  }
}

const EMI = [
  // [key, days ago, phone code, financier, loan no, DO no, months, down payment parts]
  ['r2-emi-1', 18, 'PH-ORBIT-PRO', 'HDFC Bank', 'HDFCCD2609183341', 'DO-HD-77120', 9, [['card', 4999]]],
  ['r2-emi-2', 9, 'PH-ZENIX-A15', 'Bajaj Finserv', 'BFL-4410982216', 'DO-BF-55018', 12, [['cash', 3000], ['upi', 2999]]],
  ['r2-emi-3', 6, 'PH-NOVA5G-BL', 'Bajaj Finserv', 'BFL-4411027789', 'DO-BF-55102', 6, [['upi', 3999]]],
  ['r2-emi-4', 1, 'PH-NOVA5G-BK', 'TVS Credit', 'TVSC-883301245', null, 8, [['cash', 2000], ['card', 1999]]],
  ['r2-emi-5', 0, 'PH-NOVA5G-BL', 'Bajaj Finserv', 'BFL-4411260045', 'DO-BF-55240', 6, [['upi', 4999]]],
];
async function emiSales(sim, today) {
  const now = clock.minutesNow();
  const owner = { business: sim.business, user: sim.owner };
  // The shop's financiers: the usual four (made with the business) and TVS
  // Credit; each one's dealer subvention on its zero-cost schemes.
  const list = (await finance.financiers(sim.business)).items;
  const subvention = { 'Bajaj Finserv': '1.5', 'HDFC Bank': '2', 'ICICI Bank': '1.75', 'Home Credit': '1' };
  for (const f of list) if (subvention[f.name] && Number(f.subvention_percent) === 0) await finance.updateFinancier(sim.business, sim.owner, f.id, { subventionPercent: subvention[f.name] });
  if (!list.some((f) => f.name === 'TVS Credit')) await finance.createFinancier(sim.business, sim.owner, { name: 'TVS Credit', subventionPercent: '1' });
  const financiers = (await finance.financiers(sim.business)).items;
  for (const [key, ago, code, financierName, loanNo, doNo, months, down] of EMI) {
    const day = clock.addDays(today, -ago);
    const at = sim.def.open + 360 + ago * 7;
    if (day === today && at > now) continue;
    if (await repo.one(base.db, 'SELECT 1 FROM business_documents WHERE business_id=$1 AND request_key=$2', [sim.business.id, base.key(sim.business.id, key)])) continue;
    const phone = sim.items.find((i) => i.code === code);
    const lot = serialLot(sim, code);
    if (!phone || !lot) continue;
    const person = people('telugu', 1, `emi|${key}`)[0];
    const who = shop.actor(sim, 'cashier', 'manager');
    const financier = financiers.find((f) => f.name === financierName);
    const result = await shop.post(sim, 'business_documents', key, clock.at(day, at), (requestKey) => service.document(who.business, who.user, {
      kind: 'sale', requestKey, locationId: sim.location.id, lines: [{ skuId: phone.id, quantity: '1', lotCode: lot.code }],
      buyer: { name: person.name, phone: mobile(`emi|${key}`) },
      payments: down.map(([method, amount]) => ({ method, amount: amount.toFixed(2), ...(method === 'cash' ? { tendered: (Math.ceil(amount / 500) * 500).toFixed(2) } : {}) })),
      finance: { financierId: financier.id, loanNo, ...(doNo ? { doNo } : {}), tenureMonths: months, amount: 'rest' } }));
    if (result.created) shop.takeStock([{ item: phone, qty: 1, lot }]);
  }
  // Bajaj's payout for the phone sold nine days ago came in this morning (NEFT).
  if (sim.def.open + 45 > now) return;
  const bajaj = financiers.find((f) => f.name === 'Bajaj Finserv');
  const tv = await repo.one(base.db, `SELECT c.* FROM electronics_finance_cases c WHERE c.business_id=$1 AND c.financier_id=$2 AND c.loan_no=$3`, [sim.business.id, bajaj.id, 'BFL-4410982216']);
  if (!tv || tv.status !== 'pending') return;
  const subventionPaise = Math.round(Math.round(Number(tv.financed_amount) * 100) * Number(bajaj.subvention_percent || 1.5) / 100);
  const received = (Math.round(Number(tv.financed_amount) * 100) - subventionPaise) / 100;
  await finance.settle(owner.business, owner.user, { requestKey: base.key(sim.business.id, 'r2-emi-payout-1'), financierId: bajaj.id, locationId: sim.location.id,
    receivedOn: today, method: 'bank', reference: `UTR BFL${String(tv.id).padStart(6, '0')}2610`, cases: [{ caseId: tv.id, subvention: (subventionPaise / 100).toFixed(2) }],
    amountReceived: received.toFixed(2), notes: 'Payout advice by email' });
}

async function electronicsToday(sim, today) {
  const made = await ensureKits(sim);
  await kitSales(sim, today, made);
  await emiSales(sim, today);
}

module.exports = { tillPins, splitBills, pointsReturn, electronicsToday };
