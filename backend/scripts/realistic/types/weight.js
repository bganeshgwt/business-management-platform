// Meat & seafood and a dry-fruits shop: goods bought whole and cut, sorted or
// cleaned in the shop (yield templates and cutting batches), sold by weight,
// with daily wastage. Fresh meat, fish and eggs carry nil GST; dry fruits 5 %
// (GST 2.0).
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const weight = require('../../../src/modules/business/salon-weight/services/businessWeight.service');
const weightPro = require('../../../src/modules/business/salon-weight/services/businessWeightPro.service');
const retail = require('../../../src/modules/business/retail/services/businessRetail.service');
const { volume, items, regulars, supplier, gstin } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');
const machine = require('../machine');

const round3 = (n) => Math.round(n * 1000) / 1000;

async function templates(sim) {
  sim.extra.templates = {};
  const byCode = (code) => sim.items.find((i) => i.code === code);
  for (const t of sim.def.templates) {
    const found = await repo.one(base.db, 'SELECT * FROM weight_yield_templates WHERE business_id=$1 AND name=$2', [sim.business.id, t.name]);
    sim.extra.templates[t.key] = found || await machine.at(sim.business.id, clock.at(clock.addDays(sim.realToday, -sim.def.days - 1), '12:00'), () => weight.createTemplate(sim.business, sim.owner, {
      name: t.name, inputSkuId: byCode(t.input).id, outputs: t.outputs.map(([code, percent]) => ({ skuId: byCode(code).id, expectedPercent: String(percent) })) }), { keepDates: true });
  }
  // Weighing-scale codes (PLU) so a scale label scans at the counter.
  for (const [n, item] of sim.items.filter((i) => i.unit === 'kg').entries()) {
    if (await repo.one(base.db, 'SELECT 1 FROM retail_scale_items WHERE business_id=$1 AND sku_id=$2', [sim.business.id, item.id])) continue;
    await retail.setScaleCode(sim.business, sim.owner, item.id, { pluCode: String(101 + n) }).catch(() => null);
  }
}

// A cutting batch: the input from its batch, the cuts by the template's yield (± a little).
async function cut(sim, day, minutes, templateKey, inputKg, step, { lotCode = null, factor = 1 } = {}) {
  const t = sim.def.templates.find((x) => x.key === templateKey);
  const input = sim.items.find((i) => i.code === t.input);
  const lots = shop.usableLots(sim, input, day).filter((l) => !lotCode || l.code === lotCode);
  const lot = lots.find((l) => l.qty >= inputKg - 0.0005) || lots[0];
  if (!lot) return;
  const qty = round3(Math.min(inputKg, lot.qty));
  if (qty < 1) return;
  const r = clock.rng(`${sim.code}|cut|${step}`);
  const outputs = t.outputs.map(([code, percent]) => ({ item: sim.items.find((i) => i.code === code), kg: round3(qty * (percent / 100) * factor * (1 + (r.next() - 0.5) * 0.04)) }));
  const who = shop.actor(sim, 'stock_keeper', 'manager');
  const template = sim.extra.templates[templateKey];
  const result = await shop.post(sim, 'weight_processing_batches', step, clock.at(day, minutes), (requestKey) => weight.processBatch(who.business, who.user, {
    inputLotId: lot.id, inputQuantity: qty.toFixed(3), templateId: template.id, requestKey, cutBy: who.user.name,
    outputs: outputs.map((o) => ({ skuId: o.item.id, quantity: o.kg.toFixed(3) })), notes: t.note }));
  if (!result.created) return;
  lot.qty = round3(lot.qty - qty);
  // The cuts went onto the shelf (loose, or as a batch named after the cutting batch).
  for (const o of outputs) await shop.reloadSku(sim, o.item.id);
}

// Evening: what could not be sold or kept is written off with its reason.
async function wastage(sim, day, entries) {
  for (const [n, [item, kg, reason, note]] of entries.entries()) {
    const lot = shop.usableLots(sim, item, day)[0] || shop.lotsOf(sim, item.id).find((l) => l.qty > 0);
    if (!lot || lot.qty < 0.05) continue;
    const qty = round3(Math.min(kg, lot.qty));
    if (qty < 0.05) continue;
    const who = shop.actor(sim, 'stock_keeper', 'manager');
    const result = await shop.post(sim, 'weight_wastage_entries', `waste-${day}-${n}`, clock.at(day, sim.def.close - 10), (requestKey) => weight.recordWastage(who.business, who.user,
      { lotId: lot.id, quantity: qty.toFixed(3), reason, note, requestKey }));
    if (result.created) lot.qty = round3(lot.qty - qty);
  }
}

// Sales by weight: a third typed in grams, as the scale shows it.
function weighBasket(sim, r, regular) {
  const pool = regular?.prefers ? regular.prefers.map((code) => sim.items.find((i) => i.code === code)).filter(Boolean) : sim.items.filter((i) => (i.meta.w ?? 0) > 0);
  const lines = [];
  const size = regular?.bulk ? r.int(1, 3) : r.int(1, 2);
  for (let n = 0; n < size * 3 && lines.length < size; n += 1) {
    const item = regular?.prefers ? r.pick(pool) : r.weighted(pool, (x) => x.meta.w);
    if (lines.some((l) => l.item === item)) continue;
    let qty;
    if (item.unit === 'kg') qty = regular?.bulk ? r.pick(regular.bulk) : r.pick(item.meta.q || [0.5, 0.75, 1, 1, 1.5, 2]);
    else qty = r.int(...(item.meta.qn || [1, 2]));
    lines.push({ item, qty });
  }
  return lines;
}
function gramsLines(lines, r) {
  for (const l of lines) {
    if (l.item.unit === 'kg' && l.qty < 1 && r.chance(0.4)) l.line = { ...l.line, quantity: String(Math.round(l.qty * 1000)), unit: 'g' };
  }
  return lines;
}

// Round 2 (R2-SVC): a trial lot of birds from a second farm this morning, cut
// like the others, so Yield & wastage › By supplier compares the two farms.
// Added once to any load (constant keys).
async function hatcheryTrial(sim, today) {
  const farm = sim.suppliers.find((x) => x.key === 'hatchery');
  const bird = sim.items.find((i) => i.code === 'CH-LIVE');
  const at = Math.max(5 * 60, Math.min(clock.minutesNow() - 40, sim.def.open - 35));
  const lotCode = `VHK-${today.slice(2, 4)}${today.slice(5, 7)}${today.slice(8, 10)}`;
  await shop.receive(sim, today, at, farm, [{ item: bird, qty: 60, cost: 101, lotCode }], 'r2-hatchery-purchase', { billSuffix: '-T' });
  await cut(sim, today, at + 10, 'curry', 40, 'r2-hatchery-cut-curry', { lotCode, factor: 0.93 });
  await cut(sim, today, at + 15, 'boneless', 18, 'r2-hatchery-cut-boneless', { lotCode, factor: 0.95 });
}

// --- Al-Noor Fresh Chicken, Mutton & Seafood, Tolichowki, Hyderabad ---------------------------

const meatItems = items([
  ['Broiler chicken (live weight)', 'CH-LIVE', 'kg', 0, 0, 'Chicken', 0, 'broiler', { tracking: 'batch', shelf: 1, loose: true, price: 150, cost: 112, hsn: '0105', noOpening: true, noReorder: true }],
  ['Chicken curry cut (skinless)', 'CH-CURRY', 'kg', 0, 0, 'Chicken', 10, null, { loose: true, price: 260, hsn: '0207', q: [0.5, 0.75, 1, 1, 1, 1.5, 2, 2], noOpening: true, noReorder: true }],
  ['Chicken boneless', 'CH-BONELESS', 'kg', 0, 0, 'Chicken', 4, null, { loose: true, price: 390, hsn: '0207', q: [0.25, 0.5, 0.5, 1], noOpening: true, noReorder: true }],
  ['Chicken drumsticks', 'CH-DRUM', 'kg', 0, 0, 'Chicken', 1.6, null, { loose: true, price: 320, hsn: '0207', q: [0.5, 1], noOpening: true, noReorder: true }],
  ['Chicken liver & gizzard', 'CH-LIVER', 'kg', 0, 0, 'Chicken', 1.2, null, { loose: true, price: 180, hsn: '0207', q: [0.25, 0.5], noOpening: true, noReorder: true }],
  ['Goat (whole carcass)', 'MT-CARCASS', 'kg', 0, 0, 'Mutton', 0, 'goat', { tracking: 'batch', shelf: 2, loose: true, price: 700, cost: 640, hsn: '0204', noOpening: true, noReorder: true }],
  ['Mutton curry cut', 'MT-CURRY', 'kg', 0, 0, 'Mutton', 4, null, { loose: true, price: 880, hsn: '0204', q: [0.5, 0.5, 1, 1, 1.5], noOpening: true, noReorder: true }],
  ['Mutton keema', 'MT-KEEMA', 'kg', 0, 0, 'Mutton', 1.6, null, { loose: true, price: 920, hsn: '0204', q: [0.25, 0.5, 1], noOpening: true, noReorder: true }],
  ['Mutton paya (set of 4)', 'MT-PAYA', 'each', 0, 0, 'Mutton', 0.8, null, { loose: true, price: 240, hsn: '0206', qn: [1, 1], noOpening: true, noReorder: true }],
  ['Rohu (whole, uncleaned)', 'FS-ROHU-W', 'kg', 0, 0, 'Fish & prawns', 0, 'fish', { tracking: 'batch', shelf: 1, loose: true, price: 200, cost: 150, hsn: '0302', noOpening: true, noReorder: true }],
  ['Rohu cleaned cut pieces', 'FS-ROHU', 'kg', 0, 0, 'Fish & prawns', 2.4, null, { loose: true, price: 280, hsn: '0302', q: [0.5, 1, 1, 1.5], noOpening: true, noReorder: true }],
  ['Seer fish (vanjaram) steaks', 'FS-SEER', 'kg', 0, 0, 'Fish & prawns', 1, 'fish', { loose: true, price: 1100, cost: 860, hsn: '0302', q: [0.5, 0.5, 1], reorder: 3, target: 8 }],
  ['Prawns medium (cleaned)', 'FS-PRAWN', 'kg', 0, 0, 'Fish & prawns', 1.2, 'fish', { loose: true, price: 650, cost: 500, hsn: '0306', q: [0.25, 0.5, 1], reorder: 3, target: 9 }],
  ['Country eggs (tray of 30)', 'EGG-TRAY', 'each', 0, 0, 'Eggs', 1.6, 'eggs', { loose: true, price: 195, cost: 168, hsn: '0407', qn: [1, 1], reorder: 10, target: 40 }],
]).map((i) => ({ ...i, mrp: null }));

const meat = {
  key: 'meat', type: 'meat', name: 'Al-Noor Fresh Chicken, Mutton & Seafood', location: 'Tolichowki shop',
  legalName: 'Al-Noor Meat Centre (Prop. Mohammed Rafi)', gstin: gstin('36', 'meat-shop', 'P', 'R'),
  address: ['Shop 7, Salarjung Colony Road', 'Tolichowki'], city: 'Hyderabad', pin: '500008', phone: '040-2356 9921', email: 'alnoormeat.tolichowki@gmail.com',
  receiptFooter: 'Halal. Cut fresh every morning. Orders on WhatsApp for home delivery.',
  days: 90, open: 6 * 60 + 30, close: 21 * 60, margin: 0.25, regularShare: 0.2, returnRate: 0, udhaarShare: 0.9,
  curve: [[6, 5], [7, 9], [8, 10], [9, 9], [10, 7], [11, 6], [12, 4], [13, 3], [14, 2], [15, 2], [16, 3], [17, 5], [18, 6], [19, 6], [20, 3]],
  // Sundays and Bonalu Sundays are the big days; Shravan is quieter; Gandhi Jayanti is a dry day (shops shut).
  volume: volume(52, { weekdays: [1.85, 0.9, 0.85, 0.95, 0.95, 1.15, 1.1], festivals: { '2026-07-19': 1.5, '2026-07-26': 1.5, '2026-08-02': 1.45, '2026-08-09': 1.45, '2026-08-15': 1.2,
    '2026-09-04': 0.7, '2026-09-14': 0.6 }, ranges: [['2026-08-13', '2026-09-11', 0.85]], growth: 0.0005 }),
  closedOn: (day) => day === '2026-10-02',
  pay: { upi: 0.55, cash: 0.42, card: 0.03 },
  staff: [{ name: 'Mohammed Imran', login: 'imran', role: 'manager' }, { name: 'Shaik Sameer', login: 'sameer', role: 'cashier' }, { name: 'Abdul Khader', login: 'khader', role: 'stock_keeper' }],
  suppliers: [
    supplier('broiler', 'Srinivasa Broiler Farms & Traders', '36', 'm-broiler', { prefix: 'SBF', creditDays: 3, address: 'Shamshabad, Ranga Reddy district', holder: 'F' }),
    // Round 2: a second farm on trial (its birds dress out lighter; see Yield by supplier).
    supplier('hatchery', 'Venkateswara Hatcheries (Kothur)', '36', 'm-hatchery', { prefix: 'VHK', creditDays: 3, days: [], address: 'Kothur, Ranga Reddy district', holder: 'F' }),
    supplier('goat', 'Chengicherla Livestock Agent (Syed Ameen)', '36', 'm-goat', { prefix: 'CLA', creditDays: 2, method: 'cash', holder: 'P', address: 'Chengicherla, Hyderabad' }),
    supplier('fish', 'Ram Nagar Fish Market Commission Agent', '36', 'm-fish', { prefix: 'RFM', creditDays: 1, method: 'cash', holder: 'P', address: 'Ram Nagar fish market, Hyderabad' }),
    supplier('eggs', 'Deccan Egg Traders', '36', 'm-eggs', { prefix: 'DET', creditDays: 7, days: [1, 4], address: 'Gudimalkapur, Hyderabad' }),
  ],
  regulars: [
    { key: 'r1', name: "Nawab's Kitchen Family Restaurant", phone: '040-2351 4410', gstin: gstin('36', 'meat-r1', 'F', 'N'), udhaar: 'ontime', udhaarShare: 1, creditLimit: '60000', creditDays: 7, visits: 6, bulk: [8, 10, 12, 15], prefers: ['CH-CURRY', 'CH-CURRY', 'CH-BONELESS', 'MT-CURRY'], address: 'Shaikpet, Hyderabad' },
    { key: 'r2', name: 'Royal Spice Biryani Point', phone: '98490 22715', gstin: gstin('36', 'meat-r2', 'F', 'R'), udhaar: 'late', udhaarShare: 1, creditLimit: '80000', creditDays: 7, visits: 5, bulk: [10, 12, 15, 18], prefers: ['CH-CURRY', 'CH-CURRY', 'MT-CURRY'], address: 'Mehdipatnam, Hyderabad' },
    { key: 'r3', name: 'Hotel Madina Darbar (tiffin & meals)', phone: '99490 31877', udhaar: 'chronic', udhaarShare: 1, creditLimit: '40000', creditDays: 10, visits: 3, bulk: [5, 6, 8], prefers: ['CH-CURRY', 'MT-KEEMA', 'CH-LIVER'], address: 'Langar Houz, Hyderabad', openingBalance: '14200', openingBalanceOn: '2026-07-01' },
    ...regulars('hyderabadi', 30, 'meat', { udhaar: [null, 'ontime', null, null, 'ontime'], limit: () => 4000, days: () => 7, visits: () => 1 }),
  ],
  categories: [['Chicken'], ['Mutton'], ['Fish & prawns'], ['Eggs']],
  items: meatItems,
  templates: [
    { key: 'curry', name: 'Live broiler → curry cut', input: 'CH-LIVE', outputs: [['CH-CURRY', 66], ['CH-LIVER', 5]], note: 'Morning cutting' },
    { key: 'boneless', name: 'Live broiler → boneless & drumsticks', input: 'CH-LIVE', outputs: [['CH-BONELESS', 38], ['CH-DRUM', 16], ['CH-LIVER', 5]], note: 'Boneless and drumsticks' },
    { key: 'mutton', name: 'Goat carcass → curry cut, keema & paya', input: 'MT-CARCASS', outputs: [['MT-CURRY', 70], ['MT-KEEMA', 18]], note: 'Mutton cutting' },
    { key: 'rohu', name: 'Whole rohu → cleaned pieces', input: 'FS-ROHU-W', outputs: [['FS-ROHU', 72]], note: 'Fish cleaning' },
  ],
  units: [],
  modules: [],
  basketSize: () => 1,
  hooks: {
    setup: templates,
    basket: (sim, r, regular) => weighBasket(sim, r, regular),
    lines: gramsLines,
    // Morning: today's birds, goat and fish arrive and are cut before opening.
    async morning(sim, day, closed) {
      if (closed) return;
      const r = clock.rng(`${sim.code}|arrival|${day}`);
      const busy = sim.def.volume(day, clock.rng(`${sim.code}|bills|${day}`), sim) / 52;
      const birds = Math.round(110 * busy * (0.9 + r.next() * 0.2));
      const goat = Math.round((clock.weekday(day) === 0 ? 34 : 18) * (0.9 + r.next() * 0.2) * Math.max(0.6, busy * 0.8));
      const rohu = Math.round(20 * Math.max(0.6, busy) * (0.9 + r.next() * 0.2));
      const item = (code) => sim.items.find((i) => i.code === code);
      const sup = (key) => sim.suppliers.find((s) => s.key === key);
      await shop.receive(sim, day, sim.def.open - 50, sup('broiler'), [{ item: item('CH-LIVE'), qty: birds, cost: 104 + r.int(0, 18) }], `purchase-broiler-${day}`, { billSuffix: '-M' });
      await shop.receive(sim, day, sim.def.open - 45, sup('goat'), [{ item: item('MT-CARCASS'), qty: goat, cost: 620 + r.int(0, 40) }], `purchase-goat-${day}`, { billSuffix: '-M' });
      await shop.receive(sim, day, sim.def.open - 40, sup('fish'), [{ item: item('FS-ROHU-W'), qty: rohu, cost: 140 + r.int(0, 20) }], `purchase-rohu-${day}`, { billSuffix: '-M' });
      await cut(sim, day, sim.def.open - 30, 'curry', round3(birds * 0.68), `cut-curry-${day}`);
      await cut(sim, day, sim.def.open - 20, 'boneless', round3(birds * 0.32), `cut-boneless-${day}`);
      await cut(sim, day, sim.def.open - 15, 'mutton', goat, `cut-mutton-${day}`);
      await cut(sim, day, sim.def.open - 10, 'rohu', rohu, `cut-rohu-${day}`);
    },
    // Evening: drip loss on every cut, unsold fish and anything left from yesterday written off.
    async evening(sim, day, closed) {
      if (closed) return;
      const r = clock.rng(`${sim.code}|waste|${day}`);
      const have = (code) => shop.onHand(sim, sim.items.find((i) => i.code === code).id);
      const entries = [];
      for (const code of ['CH-CURRY', 'CH-BONELESS', 'MT-CURRY']) if (have(code) > 1) entries.push([sim.items.find((i) => i.code === code), round3(have(code) * (0.015 + r.next() * 0.01)), 'drip_loss', null]);
      if (have('FS-ROHU') > 0.5) entries.push([sim.items.find((i) => i.code === 'FS-ROHU'), round3(have('FS-ROHU') * 0.5), 'unsold', 'Fish kept only one day']);
      if (have('CH-CURRY') > 18) entries.push([sim.items.find((i) => i.code === 'CH-CURRY'), round3((have('CH-CURRY') - 18) * 0.6), 'unsold', 'Over-cut on a slow day']);
      if (r.chance(0.08)) entries.push([sim.items.find((i) => i.code === 'CH-LIVER'), 0.4, 'spoiled', null]);
      await wastage(sim, day, entries);
    },
    // Today's rates on the board (chicken moves every morning with the farm rate).
    async today(sim, today) {
      await hatcheryTrial(sim, today);
      if (await repo.one(base.db, `SELECT 1 FROM weight_rate_history h WHERE h.business_id=$1 AND (h.changed_at AT TIME ZONE 'Asia/Kolkata')::date=$2::date`, [sim.business.id, today])) return;
      const rates = [['CH-CURRY', 270], ['CH-BONELESS', 400], ['CH-DRUM', 330], ['FS-PRAWN', 680]];
      await weightPro.saveRates(sim.business, sim.owner, { rates: rates.map(([code, price]) => ({ skuId: sim.items.find((i) => i.code === code).id, price: String(price) })) });
    },
  },
};

// --- Gupta Dry Fruits & Mewa Bhandar, Karol Bagh, Delhi -----------------------------------------

const df = (label, code, mrp, category, w, sup, extra = {}) => [label, code, 'kg', mrp, 5, category, w, sup,
  { tracking: 'batch', shelf: extra.shelf || 300, loose: true, hsn: extra.hsn || '0802', q: extra.q || [0.1, 0.25, 0.25, 0.25, 0.5, 0.5, 1], reorder: extra.reorder ?? 5, target: extra.target ?? 20, margin: 0.2, lotPrefix: code.replace('DF-', ''), ...extra }];
const dryItems = items([
  df('Almonds, California (bulk, unsorted)', 'DF-ALM-BULK', 720, 'Almonds', 0, 'kb', { noOpening: false, reorder: 15, target: 50, cost: 610, w: 0 }),
  df('Almonds, California (sorted)', 'DF-ALM', 880, 'Almonds', 8, null, { noOpening: true, noReorder: true }),
  df('Almonds, broken', 'DF-ALM-BRK', 560, 'Almonds', 1, null, { noOpening: true, noReorder: true }),
  df('Mamra almonds (Afghan)', 'DF-MAMRA', 2600, 'Almonds', 0.8, 'kb', { q: [0.1, 0.25], reorder: 2, target: 6 }),
  df('Cashew W240', 'DF-CASHEW240', 1120, 'Cashews', 6, 'kb', { hsn: '0801', reorder: 8, target: 30 }),
  df('Cashew W320', 'DF-CASHEW320', 960, 'Cashews', 4, 'kb', { hsn: '0801', reorder: 8, target: 25 }),
  df('Cashew splits (JH)', 'DF-CASHEW-SPL', 760, 'Cashews', 1.6, 'kb', { hsn: '0801', reorder: 4, target: 12 }),
  df('Pistachios, roasted & salted', 'DF-PISTA', 1450, 'Pistachios & walnuts', 3, 'ir', { reorder: 4, target: 15 }),
  df('Walnut kernels (light halves)', 'DF-WALNUT', 1350, 'Pistachios & walnuts', 2.4, 'kw', { reorder: 4, target: 15, shelf: 240 }),
  df('Raisins, green (Indian)', 'DF-RAISIN', 420, 'Raisins & dates', 4, 'kb', { hsn: '0806', reorder: 6, target: 25 }),
  df('Raisins, black seedless', 'DF-RAISIN-BLK', 560, 'Raisins & dates', 1.4, 'ir', { hsn: '0806', reorder: 3, target: 10 }),
  df('Dates, Kimia (Iran)', 'DF-DATES', 480, 'Raisins & dates', 2.4, 'ir', { hsn: '0804', reorder: 5, target: 20, shelf: 240 }),
  df('Figs (anjeer), dried', 'DF-ANJEER', 1400, 'Raisins & dates', 1.4, 'ir', { hsn: '0804', reorder: 3, target: 10 }),
  df('Apricots, dried (Turkish)', 'DF-APRICOT', 980, 'Raisins & dates', 1, 'ir', { hsn: '0813', reorder: 2, target: 8 }),
  df('Makhana (fox nuts), 4-suta', 'DF-MAKHANA', 1250, 'Makhana & seeds', 2, 'kb', { hsn: '0801', q: [0.1, 0.25, 0.5], reorder: 3, target: 10, shelf: 240 }),
  df('Green cardamom 8 mm', 'SP-ELAICHI', 3200, 'Whole spices', 1.6, 'kw', { hsn: '0908', q: [0.05, 0.1, 0.1, 0.25], reorder: 1.5, target: 5 }),
  df('Black pepper, bold', 'SP-PEPPER', 980, 'Whole spices', 1, 'kw', { hsn: '0904', q: [0.1, 0.25], reorder: 2, target: 6 }),
  df('Cloves', 'SP-CLOVE', 1500, 'Whole spices', 0.6, 'kw', { hsn: '0907', q: [0.05, 0.1], reorder: 1, target: 4 }),
  ['Kashmiri saffron 1 g', 'SP-SAFFRON-1G', 'each', 450, 5, 'Whole spices', 0.8, 'kw', { tracking: 'batch', shelf: 720, hsn: '0910', reorder: 10, target: 40, lotPrefix: 'SAF', qn: [1, 2] }],
  ['Dry fruit gift box 500 g (assorted)', 'GB-500', 'each', 1199, 5, 'Gift boxes', 0.6, 'pack', { tracking: 'batch', shelf: 180, hsn: '0813', reorder: 10, target: 40, lotPrefix: 'GB5', qn: [1, 2] }],
  ['Dry fruit gift box 1 kg (premium)', 'GB-1000', 'each', 2399, 5, 'Gift boxes', 0.3, 'pack', { tracking: 'batch', shelf: 180, hsn: '0813', reorder: 5, target: 20, lotPrefix: 'GB1', qn: [1, 1] }],
]);

const dryfruits = {
  key: 'dryfruits', type: 'weight_retail', name: 'Gupta Dry Fruits & Mewa Bhandar', location: 'Karol Bagh shop',
  legalName: 'Gupta Dry Fruits & Mewa Bhandar (Prop. Rajesh Gupta)', gstin: gstin('07', 'dryfruit-shop', 'P', 'G'),
  address: ['2716/12, Beadon Pura, Gaffar Market Road', 'Karol Bagh'], city: 'New Delhi', pin: '110005', phone: '011-2575 4408', email: 'guptamewabhandar@gmail.com',
  receiptFooter: 'Fresh stock every week from Khari Baoli. Corporate Diwali gifting orders taken.',
  days: 90, open: 10 * 60, close: 21 * 60, margin: 0.2, regularShare: 0.2, returnRate: 0.002,
  curve: [[10, 3], [11, 5], [12, 6], [13, 5], [14, 4], [15, 4], [16, 5], [17, 7], [18, 8], [19, 8], [20, 5]],
  // Raksha Bandhan and the Diwali run-up are the seasons; Pitru Paksha is quiet for gifting.
  volume: volume(18, { weekdays: [1.4, 0.75, 0.95, 0.95, 1, 1, 1.25], festivals: { '2026-08-25': 1.8, '2026-08-26': 2.2, '2026-08-27': 2.8, '2026-08-28': 1.6, '2026-08-15': 1.2,
    '2026-09-03': 1.4, '2026-09-13': 1.3 }, ranges: [['2026-09-27', '2026-10-10', 0.95], ['2026-10-01', '2026-10-31', 1.35]], growth: 0.001 }),
  pay: { upi: 0.58, cash: 0.27, card: 0.15 },
  staff: [{ name: 'Ankit Gupta', login: 'ankit', role: 'manager' }, { name: 'Sumit Verma', login: 'sumit', role: 'cashier' }, { name: 'Pankaj Singh', login: 'pankaj', role: 'stock_keeper' }],
  suppliers: [
    supplier('kb', 'Khari Baoli Mewa Traders', '07', 'd-kb', { prefix: 'KBM', creditDays: 15, days: [2], address: '6402, Khari Baoli, Delhi' }),
    supplier('ir', 'Bansal Imports (Iran & Afghanistan dry fruits)', '07', 'd-ir', { prefix: 'BIM', creditDays: 30, days: [4], late: 6, holder: 'C', address: 'Naya Bazar, Delhi' }),
    supplier('kw', 'Kashmir Valley Spices & Walnuts', '01', 'd-kw', { prefix: 'KVS', creditDays: 21, days: [5], address: 'Lal Chowk, Srinagar' }),
    supplier('pack', 'Shubh Gifting & Packaging Co.', '07', 'd-pack', { prefix: 'SGP', creditDays: 30, days: [1], address: 'Chawri Bazar, Delhi' }),
  ],
  regulars: [
    { key: 'b1', name: 'Mehra Infotech Pvt Ltd (staff Diwali gifts)', phone: '011-4105 7720', gstin: gstin('07', 'df-b1', 'C', 'M'), udhaar: 'ontime', creditLimit: '250000', creditDays: 30, visits: 0.05, address: 'Netaji Subhash Place, Delhi' },
    { key: 'b2', name: 'Agarwal Sweets & Caterers', phone: '98110 52360', gstin: gstin('07', 'df-b2', 'F', 'A'), udhaar: 'late', udhaarShare: 1, creditLimit: '120000', creditDays: 15, visits: 1.2, bulk: [2, 3, 5], prefers: ['DF-CASHEW320', 'DF-ALM', 'DF-RAISIN', 'DF-CASHEW-SPL', 'DF-PISTA'], address: 'Patel Nagar, Delhi' },
    ...regulars('north', 40, 'dryfruits', { udhaar: [null, null, 'ontime'], limit: () => 10000, days: () => 15, visits: () => 1 }),
  ],
  categories: [['Almonds'], ['Cashews'], ['Pistachios & walnuts'], ['Raisins & dates'], ['Makhana & seeds'], ['Whole spices'], ['Gift boxes']],
  items: dryItems,
  templates: [{ key: 'almonds', name: 'Bulk almonds → sorted and broken', input: 'DF-ALM-BULK', outputs: [['DF-ALM', 91], ['DF-ALM-BRK', 6]], note: 'Sorting and grading' }],
  modules: [],
  hooks: {
    setup: templates,
    basket: (sim, r, regular) => weighBasket(sim, r, regular),
    lines: gramsLines,
    async morning(sim, day) {
      // Almonds are sorted twice a week from the bulk sacks.
      if ([1, 4].includes(clock.weekday(day))) {
        const bulk = sim.items.find((i) => i.code === 'DF-ALM-BULK');
        await cut(sim, day, sim.def.open - 30, 'almonds', Math.min(20, shop.onHand(sim, bulk.id)), `cut-almonds-${day}`);
      }
      // Corporate Diwali gifting: the order is billed on account in the first week of October.
      if (day === '2026-10-05') {
        const company = sim.regulars.find((c) => c.key === 'b1');
        const box = sim.items.find((i) => i.code === 'GB-500');
        const lots = shop.usableLots(sim, box, day);
        const lot = lots.find((l) => l.qty >= 25);
        if (company && lot) {
          await shop.bill(sim, day, { step: `corporate-${day}`, minutes: sim.def.open + 90, customer: company, udhaar: true, method: 'bank',
            lines: [{ item: box, qty: 25, lot, line: { skuId: box.id, quantity: '25', lotCode: lot.code } }], actor: shop.actor(sim, 'manager') });
        }
      }
    },
    async evening(sim, day) {
      if (clock.weekday(day) !== 6) return;
      const r = clock.rng(`${sim.code}|dfwaste|${day}`);
      const pick = (code) => sim.items.find((i) => i.code === code);
      await wastage(sim, day, [[pick('DF-RAISIN'), round3(0.1 + r.next() * 0.2), 'drip_loss', 'Moisture'], [pick('DF-ALM-BRK'), 0.08, 'damaged', null],
        ...(r.chance(0.5) ? [[pick('DF-DATES'), 0.15, 'spoiled', 'Sticky, not fit to sell']] : []), [pick('DF-CASHEW240'), 0.05, 'other', 'Tasting samples at the counter']]);
    },
  },
};

module.exports = { meat, dryfruits, gramsLines };
