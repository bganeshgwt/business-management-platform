// Sahyadri FMCG Distributors, Market Yard, Pune: a distributor serving kirana
// shops on salesmen's beats. Salesmen book orders on their beat days, the
// godown dispatches the next morning (in part when an item is short), the
// retailers pay on their credit terms (some late, two on credit hold), and
// today's collections include cheques: one cleared, one post-dated, one
// bounced. Prices are trade prices before GST (B2B tax invoices), well under
// the printed MRP.
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const service = require('../../../src/modules/business/core/services/business.service');
const returns = require('../../../src/modules/business/core/services/businessReturns.service');
const wholesale = require('../../../src/modules/business/wholesale/services/businessWholesale.service');
const receivables = require('../../../src/modules/business/wholesale/services/businessReceivables.service');
const credit = require('../../../src/modules/business/wholesale/services/businessWholesaleCredit.service');
const prices = require('../../../src/modules/business/wholesale/services/businessWholesalePricing.service');
const purchases = require('../../../src/modules/business/wholesale/services/businessWholesalePurchase.service');
const { items, supplier, gstin, people, mobile } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');
const machine = require('../machine');

const trade = (mrp, gst, factor = 0.8) => Math.round((mrp / (1 + gst / 100)) * factor * 100) / 100;
// [label, code, MRP, GST, case size, category, weight, supplier, extra]
const ROWS = [
  ['Glucose biscuits 75 g', 'WS-BIS-GLU', 10, 5, 120, 'Biscuits & snacks', 9, 'hul', { tracking: 'batch', shelf: 240 }],
  ['Cream biscuits 120 g', 'WS-BIS-CRM', 30, 5, 48, 'Biscuits & snacks', 5, 'hul', { tracking: 'batch', shelf: 240 }],
  ['Salted potato chips 52 g', 'WS-CHIPS', 20, 5, 60, 'Biscuits & snacks', 5, 'snk', {}],
  ['Instant noodles 70 g', 'WS-NOOD', 15, 5, 96, 'Packaged food', 8, 'snk', { tracking: 'batch', shelf: 270 }],
  ['Tea powder 250 g', 'WS-TEA-250', 145, 5, 40, 'Beverages', 6, 'bev', {}],
  ['Instant coffee 50 g jar', 'WS-COFFEE-50', 185, 5, 24, 'Beverages', 3, 'bev', {}],
  ['Mango drink 200 ml', 'WS-MANGO', 20, 5, 30, 'Beverages', 4, 'bev', { tracking: 'batch', shelf: 180 }],
  ['Cola 750 ml', 'WS-COLA', 40, 40, 24, 'Beverages', 4, 'bev', {}],
  ['Packaged drinking water 1 L', 'WS-WATER', 20, 5, 12, 'Beverages', 5, 'bev', {}],
  ['Refined sunflower oil 1 L pouch', 'WS-OIL-1', 165, 5, 10, 'Edible oil & staples', 7, 'oil', { factor: 0.9 }],
  ['Refined sunflower oil 15 L tin', 'WS-OIL-15', 2450, 5, 0, 'Edible oil & staples', 2, 'oil', { factor: 0.9 }],
  ['Chakki atta 10 kg', 'WS-ATTA-10', 480, 5, 0, 'Edible oil & staples', 3, 'oil', { factor: 0.88 }],
  ['Bathing soap 100 g', 'WS-SOAP', 45, 5, 72, 'Soaps & detergents', 7, 'hul', {}],
  ['Detergent powder 1 kg', 'WS-DET-1', 125, 18, 24, 'Soaps & detergents', 5, 'hul', {}],
  ['Detergent bar 250 g', 'WS-DET-BAR', 25, 18, 100, 'Soaps & detergents', 5, 'hul', {}],
  ['Toothpaste 150 g', 'WS-TP-150', 105, 5, 48, 'Personal care', 4, 'hul', {}],
  ['Shampoo sachets (strip of 16)', 'WS-SHAMPOO', 32, 5, 50, 'Personal care', 4, 'hul', {}],
  ['Agarbatti 100 g', 'WS-AGAR', 60, 5, 60, 'Pooja & household', 3, 'snk', {}],
  ['Safety matches (pack of 10)', 'WS-MATCH', 20, 5, 50, 'Pooja & household', 3, 'snk', {}],
];
const wsItems = items(ROWS.map(([label, code, mrp, gst, perCase, category, w, sup, extra]) => [label, code, 'each', mrp, gst, category, w, sup, {
  price: trade(mrp, gst, extra.factor || 0.8), cost: Math.round(trade(mrp, gst, extra.factor || 0.8) * 0.93 * 100) / 100, perCase,
  pack: perCase ? ['case', perCase] : undefined, reorder: (perCase || 1) * (perCase ? 15 : 20), target: (perCase || 1) * (perCase ? 60 : 80), lotPrefix: code.replace('WS-', ''), ...extra }]));

const ROUTES = [['Kothrud–Karve Nagar route', [['Kothrud depot side', 1, 0], ['Karve Nagar', 4, 0]]], ['Hadapsar–Magarpatta route', [['Hadapsar gaon', 2, 1], ['Magarpatta & Mundhwa', 5, 1]]],
  ['Pimpri–Chinchwad route', [['Pimpri market', 3, 2], ['Chinchwad station', 6, 2]]], ['Peth area (city) route', [['Shukrawar & Budhwar Peth', 1, 2], ['Sadashiv & Narayan Peth', 4, 1]]]];
const SALESMEN = [['Ravi Jadhav', '98500 10001'], ['Imran Shaikh', '98500 10002'], ['Suresh Patil', '98500 10003']];
const SHOPS = ['Shree Balaji Kirana', 'Annapurna Provision Stores', 'Om Sai Super Mart', 'Gupta General Stores', 'Mahalaxmi Traders', 'Jai Bhavani Kirana', 'Ganesh Provision & General',
  'Shivneri Super Shoppe', 'Siddhivinayak Stores', 'Vaishnavi Kirana', 'New Sagar Provisions', 'Morya Mart', 'Kesari General Stores', 'Tulja Bhavani Traders', 'Datta Kirana Stores',
  'Swami Samarth Provisions', 'Sai Krupa Mart', 'Royal Daily Needs', 'Patil Kirana & Dairy', 'Laxmi Narayan Stores', 'Om Shanti Provision', 'Khandoba Traders', 'City Fresh Mart',
  'Gajanan General Stores', 'Pawar Bandhu Kirana', 'Hanuman Provision', 'Navkar Super Market', 'Anand Bazaar', 'Rajlaxmi Kirana', 'Mauli Daily Needs', 'Saraswati Traders', 'Kalpataru Stores',
  'Shree Ram Provision', 'Ambika Kirana', 'Jagdamba Traders', 'Vighnaharta Mart', 'Bhairavnath Stores', 'Sant Tukaram Kirana', 'Modern Provision Store', 'Nandan Daily Needs',
  'Shubham General Stores', 'Prabhat Kirana', 'Yashwant Traders', 'Krishna Super Shoppe', 'Matoshree Kirana', 'Sahyadri Provision', 'Ekvira Stores', 'Sai Darshan Mart'];
// How each retailer pays: most on time, a few late, two far behind (on credit hold).
const PATTERN = ['ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'ontime', 'late', 'ontime',
  'ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'chronic', 'ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'ontime',
  'late', 'ontime', 'ontime', 'chronic', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime', 'ontime', 'late', 'ontime', 'ontime', 'ontime'];
const retailers = SHOPS.map((name, i) => {
  const owner = people('marathi', 1, `ws-owner-${i}`)[0];
  return { key: `rt${i + 1}`, name, phone: mobile(`ws-${i}`), udhaar: PATTERN[i], creditDays: [15, 21, 30][i % 3], creditLimit: String([90000, 120000, 160000, 100000][i % 4]),
    gstin: i % 5 === 4 ? undefined : gstin('27', `ws-retailer-${i}`, 'P', owner.name.split(' ').pop()[0] || 'K'), address: `${name}, Pune (prop. ${owner.name})`, beat: i % 8,
    size: [1, 1.4, 0.8, 1.2][i % 4], ...(i === 24 ? { openingBalance: '38450', openingBalanceOn: '2026-06-20' } : i === 35 ? { openingBalance: '22900', openingBalanceOn: '2026-06-25' } : {}) };
});

async function setup(sim) {
  const when = clock.at(clock.addDays(sim.realToday, -sim.def.days - 1), '13:00');
  const ex = sim.extra;
  await machine.at(sim.business.id, when, async () => {
    const named = (table, name, extra = '', values = []) => repo.one(base.db, `SELECT * FROM ${table} WHERE business_id=$1 AND name=$2 ${extra} ORDER BY id LIMIT 1`, [sim.business.id, name, ...values]);
    ex.salesmen = [];
    for (const [name, phone] of SALESMEN) ex.salesmen.push(await named('wholesale_salespeople', name) || await wholesale.saveSalesperson(sim.business, sim.owner, null, { name, phone }));
    ex.beats = [];
    for (const [routeName, beats] of ROUTES) {
      const route = await named('wholesale_routes', routeName) || await wholesale.saveRoute(sim.business, sim.owner, null, { name: routeName, locationId: sim.location.id });
      for (const [beatName, visitDay, man] of beats) {
        const beat = await named('wholesale_beats', beatName, 'AND route_id=$3', [route.id])
          || await wholesale.saveBeat(sim.business, sim.owner, null, { routeId: route.id, name: beatName, visitDay, salespersonId: ex.salesmen[man].id });
        ex.beats.push({ ...beat, route, visitDay, man: ex.salesmen[man] });
      }
    }
    for (const c of sim.regulars) {
      c.beatRow = ex.beats[c.beat];
      if (!await repo.one(base.db, 'SELECT 1 FROM wholesale_customer_beats WHERE business_id=$1 AND contact_id=$2', [sim.business.id, c.contact.id])) {
        await wholesale.setCustomerBeat(sim.business, sim.owner, c.contact.id, { beatId: c.beatRow.id });
      }
    }
    // Retailers' price group, a scheme and the 60-day credit hold.
    let group = await repo.one(base.db, "SELECT * FROM wholesale_price_groups WHERE business_id=$1 AND lower(name)='retailers'", [sim.business.id]);
    if (!group) group = await prices.saveGroup(sim.business, sim.owner, null, { name: 'Retailers', notes: 'Kirana and general stores on the beats' });
    for (const c of sim.regulars) {
      if (!await repo.one(base.db, 'SELECT 1 FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [sim.business.id, c.contact.id])) {
        await credit.saveProfile(sim.business, sim.owner, c.contact.id, { priceGroupId: group.id, stateCode: '27', tradeType: 'trade' });
      }
    }
    const noodles = sim.items.find((i) => i.code === 'WS-NOOD');
    if (!await repo.one(base.db, 'SELECT 1 FROM wholesale_schemes WHERE business_id=$1 AND sku_id=$2', [sim.business.id, noodles.id])) {
      await prices.saveScheme(sim.business, sim.owner, null, { name: 'Noodles 10 + 1 case free', skuId: noodles.id, unitCode: 'case', buyQuantity: '10', freeQuantity: '1' });
    }
    // Round 2: "buy 5 cases of soap, get 1 case of detergent bar", not on top of the soap's case slab.
    const soap = sim.items.find((i) => i.code === 'WS-SOAP');
    const bar = sim.items.find((i) => i.code === 'WS-DET-BAR');
    if (!await repo.one(base.db, 'SELECT 1 FROM wholesale_schemes WHERE business_id=$1 AND sku_id=$2 AND free_sku_id=$3', [sim.business.id, soap.id, bar.id])) {
      await prices.saveScheme(sim.business, sim.owner, null, { name: 'Soap 5 cases + 1 case detergent bar', skuId: soap.id, unitCode: 'case', buyQuantity: '5',
        freeQuantity: '1', freeSkuId: bar.id, freeUnitCode: 'case', noSlab: true });
    }
    for (const [code, fromCases, factor] of [['WS-SOAP', 5, 0.97], ['WS-DET-BAR', 5, 0.97], ['WS-BIS-GLU', 10, 0.98]]) {
      const item = sim.items.find((i) => i.code === code);
      if (await repo.one(base.db, "SELECT 1 FROM business_price_rules WHERE business_id=$1 AND sku_id=$2 AND unit_code='case'", [sim.business.id, item.id])) continue;
      await service.createPriceRule(sim.business, sim.owner, { skuId: item.id, unitCode: 'case', minimumQuantity: String(fromCases), unitPrice: (item.price * item.meta.perCase * factor).toFixed(2) });
    }
    if (!await repo.one(base.db, 'SELECT 1 FROM wholesale_settings WHERE business_id=$1', [sim.business.id])) await credit.saveSettings(sim.business, sim.owner, { holdOverdueDays: 60 });
  }, { keepDates: true });
  ex.pending = []; // orders booked, to dispatch next morning
}

const factorOf = (day) => {
  let f = 1;
  if (clock.between(day, '2026-09-01', '2026-09-12')) f *= 1.3; // Ganeshotsav stocking
  if (clock.between(day, '2026-09-25', '2026-10-31')) f *= 1.35; // pre-Diwali push
  if (clock.between(day, '2026-07-10', '2026-07-31')) f *= 0.9; // monsoon lull
  return f;
};

// The salesmen's beats of the day: each shop orders a few cases.
async function bookOrders(sim, day, limit) {
  const wd = clock.weekday(day) || 7;
  const beats = sim.extra.beats.filter((b) => Number(b.visitDay) === wd);
  for (const c of sim.regulars) {
    const beat = c.beatRow;
    if (!beat) continue;
    {
      const r = clock.rng(`${sim.code}|order|${day}|${c.key}`);
      // On the beat day most shops order; on other days a few phone the salesman.
      const onBeat = beats.some((b) => b.id === beat.id);
      if (!r.chance(onBeat ? 0.85 : 0.12)) continue;
      const minutes = 10 * 60 + r.int(0, 420);
      if (minutes > limit) continue;
      const count = r.int(3, 7);
      const lines = [];
      for (let n = 0; n < count * 2 && lines.length < count; n += 1) {
        const item = r.weighted(sim.items, (x) => x.meta.w);
        if (lines.some((l) => l.skuId === item.id)) continue;
        const qty = Math.max(1, Math.round(r.int(1, 4) * c.size * factorOf(day)));
        lines.push(item.meta.perCase ? { skuId: item.id, unit: 'case', quantity: String(qty) } : { skuId: item.id, quantity: String(qty * 2) });
      }
      try {
        const order = await shop.post(sim, 'wholesale_orders', `order-${day}-${c.key}`, clock.at(day, minutes), (requestKey) => wholesale.createOrder(sim.business, sim.owner, {
          locationId: sim.location.id, contactId: c.contact.id, requestKey, expectedOn: clock.addDays(sim.realToday, 1), lines, notes: onBeat ? `Booked by ${beat.man.name} on the ${beat.name} beat` : `Phone order taken by ${beat.man.name}` }));
        if (order.created) sim.extra.pending.push({ id: order.row.id, day, customer: c });
      } catch (error) {
        // Over the credit limit, or on credit hold for bills overdue: the order is not booked.
        if (!/credit|hold|overdue|limit/i.test(error.message)) throw error;
      }
    }
  }
}

// Next morning the godown sends yesterday's orders; what is short goes later.
async function dispatchOrders(sim, day) {
  const due = sim.extra.pending.filter((o) => o.day < day);
  sim.extra.pending = sim.extra.pending.filter((o) => o.day >= day);
  for (const [n, o] of due.entries()) {
    const detail = await wholesale.orderDetail(sim.business, o.id);
    if (!['open', 'part_dispatched'].includes(detail.status)) continue;
    const lines = [];
    for (const l of detail.lines) {
      const item = sim.items.find((i) => i.id === Number(l.sku_id));
      const remaining = Number(l.remaining);
      if (!(remaining > 0) || l.removed_by_edit) continue;
      if (shop.onHand(sim, item.id) < remaining) continue; // short: stays on back-order
      const packs = l.entered_unit ? remaining / Number(l.unit_factor) : null;
      if (packs && Number.isInteger(Math.round(packs * 1000) / 1000)) lines.push({ orderLineId: l.id, unit: l.entered_unit, quantity: String(Math.round(packs)) });
      else lines.push({ orderLineId: l.id, quantity: String(remaining) });
    }
    if (!lines.length) continue;
    const who = shop.actor(sim, 'stock_keeper', 'manager');
    const minutes = 8 * 60 + 30 + n * 4;
    try {
      const sent = await shop.post(sim, 'wholesale_dispatches', `dispatch-${o.id}-${day}`, clock.at(day, minutes), (requestKey) => wholesale.dispatch(who.business, who.user, o.id,
        { requestKey, vehicleNo: ['MH12 KT 4521', 'MH12 RN 0987', 'MH14 GH 3310'][n % 3], lines }), { touch: [['wholesale_orders', 'id', o.id]] });
      if (sent.created) await shop.loadStock(sim);
    } catch (error) {
      if (!/stock|enough|credit|hold/i.test(error.message)) throw error;
    }
  }
}

// Retailers pay on the salesman's next visit: on time, late, or a little at a time.
async function collectDues(sim, day, limit) {
  const wd = clock.weekday(day) || 7;
  for (const c of sim.regulars) {
    if (Number(c.beatRow?.visitDay) !== wd) continue;
    const r = clock.rng(`${sim.code}|dues|${day}|${c.key}`);
    const row = await repo.one(base.db, `SELECT ${repo.contactBalanceSql('c')} AS balance,
      (SELECT min(d.due_on)::text FROM business_documents d WHERE d.business_id=c.business_id AND d.contact_id=c.id AND d.kind='sale'
        AND d.total > COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
          + COALESCE((SELECT sum(x.total) FROM business_returns x WHERE x.business_id=d.business_id AND x.document_id=d.id),0)) AS oldest_due
      FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [sim.business.id, c.contact.id]);
    const balance = Number(row.balance);
    if (balance < 100 || !row.oldest_due) continue;
    const overdue = clock.daysBetween(row.oldest_due, day);
    const dueNow = await repo.one(base.db, `SELECT COALESCE(sum(d.total - COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
      - COALESCE((SELECT sum(x.total) FROM business_returns x WHERE x.business_id=d.business_id AND x.document_id=d.id),0)),0) AS due
      FROM business_documents d WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale' AND d.due_on <= $3::date`, [sim.business.id, c.contact.id, clock.addDays(day, 3)]);
    let amount = 0;
    if (c.udhaar === 'ontime' && overdue >= -3) amount = Number(dueNow.due);
    else if (c.udhaar === 'late' && overdue >= 10 && r.chance(0.6)) amount = Number(dueNow.due) * r.pick([0.5, 0.7, 1]);
    else if (c.udhaar === 'chronic' && overdue >= 30 && r.chance(0.25)) amount = Math.min(balance, r.pick([3000, 5000, 8000]));
    // A full settlement is to the paisa; part payments are round hundreds.
    amount = c.udhaar === 'ontime' ? Math.round(amount * 100) / 100 : Math.floor(amount / 100) * 100;
    if (amount < 100) continue;
    const minutes = 11 * 60 + r.int(0, 360);
    if (minutes > limit) continue;
    const method = r.weighted([['cash', 3], ['upi', 3], ['cheque', 2], ['bank', 2]], (x) => x[1])[0];
    const reference = method === 'cheque' ? `CHQ ${r.int(100000, 999999)} (${r.pick(['SBI', 'Bank of Maharashtra', 'HDFC Bank', 'Cosmos Bank'])})` : method === 'upi' ? `UPI ${r.int(100000000, 999999999)}`
      : method === 'bank' ? `NEFT ${r.int(10000000, 99999999)}` : `Collected by ${c.beatRow.man.name}`;
    if (day < sim.realToday) {
      await shop.payOldest(sim, day, minutes, c.contact.id, 'sale', amount, method, `dues-${c.key}-${day}`, reference);
      continue;
    }
    const chequeBits = method === 'cheque' ? { bank: reference.match(/\((.*)\)/)[1], chequeDate: day } : {};
    await shop.post(sim, 'business_collections', `dues-${c.key}-${day}`, clock.at(day, minutes), (requestKey) => wholesale.collect(sim.business, sim.owner, {
      locationId: sim.location.id, contactId: c.contact.id, amount: amount.toFixed(2), method, reference: method === 'cheque' ? reference.split(' (')[0] : reference, requestKey,
      salespersonId: c.beatRow.man.id, routeId: c.beatRow.route.id, ...chequeBits }));
  }
}

// Damaged cases sent back now and then (a credit note on the invoice).
async function damagedReturns(sim, day, limit) {
  const r = clock.rng(`${sim.code}|damaged|${day}`);
  if (!r.chance(0.12) || 14 * 60 > limit) return;
  const invoice = await repo.one(base.db, `SELECT d.id FROM business_documents d WHERE d.business_id=$1 AND d.kind='sale' AND d.contact_id IS NOT NULL
    AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
    AND NOT EXISTS (SELECT 1 FROM business_returns x WHERE x.business_id=d.business_id AND x.document_id=d.id) ORDER BY d.id DESC LIMIT 1`, [sim.business.id, clock.addDays(day, -4), clock.addDays(day, -1)]);
  if (!invoice) return;
  const detail = await service.detail(sim.business, invoice.id);
  const line = detail.lines.find((l) => Number(l.quantity) >= 24);
  if (!line) return;
  const who = shop.actor(sim, 'manager');
  await shop.post(sim, 'business_returns', `damaged-${invoice.id}`, clock.at(day, 14 * 60), (requestKey) => returns.createReturn(who.business, who.user, invoice.id,
    { reason: r.pick(['Cases crushed in the van', 'Leaking pouches in the case', 'Short-dated stock refused by the shop']), requestKey,
      lines: [{ lineId: line.id, quantity: String(Math.min(12, Number(line.quantity))), restock: false }] }));
}

// Today: the salesmen's cheques — one cleared, one post-dated, one bounced.
async function chequesToday(sim, today) {
  const owner = { business: sim.business, user: sim.owner };
  const pick = (n) => sim.regulars[n];
  const story = [
    { n: 2, amount: '18500', date: clock.addDays(today, -3), bank: 'Bank of Maharashtra', no: '004512', action: 'bounce' },
    { n: 5, amount: '24200', date: clock.addDays(today, -2), bank: 'SBI', no: '118734', action: 'clear' },
    { n: 11, amount: '15750', date: clock.addDays(today, 12), bank: 'Cosmos Bank', no: '702219', action: null },
    // Round 2: the same shop's second bounce in 90 days puts it on credit hold
    // (the bank charge is the business's setting, Rs 500).
    { n: 2, amount: '9600', date: clock.addDays(today, -1), bank: 'Bank of Maharashtra', no: '004533', action: 'bounce', charge: null },
  ];
  if (clock.minutesNow() < 11 * 60) return;
  for (const s of story) {
    const c = pick(s.n);
    const owes = await repo.one(base.db, `SELECT ${repo.contactBalanceSql('c')} AS balance FROM business_contacts c WHERE c.business_id=$1 AND c.id=$2`, [sim.business.id, c.contact.id]);
    if (Number(owes.balance) < 1000) continue;
    const amount = Math.min(Number(s.amount), Math.floor(Number(owes.balance))).toFixed(2);
    const receipt = await base.once(sim.business.id, 'business_collections', `cheque-${s.no}`, (requestKey) => wholesale.collect(owner.business, owner.user, {
      locationId: sim.location.id, contactId: c.contact.id, amount, method: 'cheque', reference: `CHQ ${s.no}`, bank: s.bank, chequeDate: s.date, requestKey,
      salespersonId: c.beatRow.man.id, routeId: c.beatRow.route.id, notes: s.action === null ? 'Post-dated cheque for the next fortnight' : undefined }));
    const cheque = await repo.one(base.db, 'SELECT status FROM business_collection_cheques WHERE business_id=$1 AND collection_id=$2', [sim.business.id, receipt.row.id]);
    if (!s.action || !cheque || cheque.status !== 'received') continue;
    await receivables.chequeAction(owner.business, owner.user, receipt.row.id, { action: 'deposit', depositedInto: 'HDFC Bank current account' });
    if (s.action === 'clear') await receivables.chequeAction(owner.business, owner.user, receipt.row.id, { action: 'clear' });
    else await receivables.chequeAction(owner.business, owner.user, receipt.row.id, { action: 'bounce', reason: 'Funds insufficient (bank return memo)', ...(s.charge === null ? {} : { charge: '500' }) });
  }
}

// Round 2: a few retailers stock up for Diwali on today's beat and earn the
// schemes (noodles 10 + 1, soap 5 cases + a case of detergent bar), sent out
// this morning: the scheme report per retailer has something to show.
async function schemeOrdersToday(sim, today) {
  if (clock.minutesNow() < 11 * 60) return;
  const owner = { business: sim.business, user: sim.owner };
  const noodles = sim.items.find((i) => i.code === 'WS-NOOD');
  const soap = sim.items.find((i) => i.code === 'WS-SOAP');
  const plan = [[4, [[noodles, 10], [soap, 5]]], [7, [[noodles, 12]]], [9, [[soap, 10]]], [13, [[noodles, 10], [soap, 6]]]];
  for (const [n, lines] of plan) {
    const c = sim.regulars[n];
    if (!c?.contact) continue;
    try {
      const order = await base.once(sim.business.id, 'wholesale_orders', `diwali-scheme-${c.key}`, (requestKey) => wholesale.createOrder(owner.business, owner.user, {
        locationId: sim.location.id, contactId: c.contact.id, requestKey, notes: 'Diwali stocking on the scheme',
        lines: lines.map(([item, cases]) => ({ skuId: item.id, unit: 'case', quantity: String(cases) })) }));
      const detail = await wholesale.orderDetail(owner.business, order.row.id);
      if (detail.status !== 'open') continue;
      const send = detail.lines.filter((l) => Number(l.remaining) > 0 && Number(l.available) >= Number(l.remaining))
        .map((l) => (l.entered_unit ? { orderLineId: l.id, unit: l.entered_unit, quantity: String(Number(l.remaining) / Number(l.unit_factor)) } : { orderLineId: l.id, quantity: String(l.remaining) }));
      if (!send.length) continue;
      await base.once(sim.business.id, 'wholesale_dispatches', `diwali-scheme-send-${c.key}`, (requestKey) => wholesale.dispatch(owner.business, owner.user, order.row.id, {
        requestKey, vehicleNo: 'MH12 RN 0987', transporterName: 'Own vehicle', lrNo: `LR-${order.row.id}`, lines: send }));
    } catch (error) {
      // A shop on credit hold, or over its limit, is not booked.
      if (!/credit|hold|overdue|limit|stock/i.test(error.message)) throw error;
    }
  }
}

// Round 2: purchase orders to the companies. From the reorder suggestions:
// one sent four days ago and part received two days ago, one sent and now
// late, and today's draft. Each is raised once (by its request key); the
// receipt is posted once (the order's receipts are counted first).
async function purchaseOrders(sim, today) {
  if (clock.minutesNow() < 10 * 60) return;
  const owner = { business: sim.business, user: sim.owner };
  const suggested = (await purchases.suggestions(owner.business, { location: sim.location.id })).items;
  const plans = [
    { step: 'po-snk', supplier: 'snk', days: -4, sent: 'whatsapp', expected: -1, receive: -2 },
    { step: 'po-bev', supplier: 'bev', days: -3, sent: 'email', expected: -1 },
    { step: 'po-oil', supplier: 'oil', days: 0 },
  ];
  for (const plan of plans) {
    const supplier = sim.suppliers.find((x) => x.key === plan.supplier);
    let lines = suggested.filter((i) => Number(i.supplier_id) === Number(supplier.contact.id)).slice(0, 4);
    if (!lines.length) lines = sim.items.filter((i) => (i.supplier?.key || i.supplier) === plan.supplier).slice(0, 3).map((i) => ({ sku_id: i.id, unit: i.unit,
      suggested_unit: i.meta.perCase ? 'case' : i.unit, suggested_quantity: '10', reason: 'reorder' }));
    if (!lines.length) continue;
    const at = clock.at(clock.addDays(today, plan.days), '09:40');
    const po = await shop.post(sim, 'wholesale_purchase_orders', plan.step, at, (requestKey) => purchases.create(owner.business, owner.user, {
      requestKey, contactId: supplier.contact.id, locationId: sim.location.id, // The time machine moves calendar dates with the order's day: give them from the real today.
      expectedOn: clock.addDays(today, (plan.expected ?? 3) - plan.days),
      notes: 'Batches with at least 60% shelf life; deliver before noon.',
      lines: lines.map((i) => ({ skuId: i.sku_id, quantity: String(i.suggested_quantity), ...(i.suggested_unit !== i.unit ? { unit: i.suggested_unit } : {}), source: i.reason })) }));
    if (!po.created) continue;
    if (plan.sent) await machine.at(sim.business.id, clock.at(clock.addDays(today, plan.days), '10:05'), () => purchases.markSent(owner.business, owner.user, po.row.id, { via: plan.sent }),
      { touch: [['wholesale_purchase_orders', 'id', po.row.id]] });
    if (plan.receive === undefined) continue;
    const detail = await purchases.detail(owner.business, po.row.id);
    if (detail.receipts.length) continue;
    // The company sends the first line in full and half of the rest.
    const got = detail.lines.map((l, n) => {
      const packs = l.entered_unit ? Number(l.entered_quantity) : null;
      const quantity = n === 0 ? (packs ?? Number(l.quantity)) : Math.max(1, Math.floor((packs ?? Number(l.quantity)) / 2));
      const item = sim.items.find((i) => i.id === Number(l.sku_id));
      return { poLineId: l.id, quantity: String(quantity), ...(l.entered_unit ? { unit: l.entered_unit } : {}),
        ...(l.tracking === 'batch' ? { lotCode: `${item.meta.lotPrefix}-${today.slice(2, 4)}${today.slice(5, 7)}PO`, expiresOn: clock.addDays(today, item.meta.shelf || 240) } : {}) };
    });
    await machine.at(sim.business.id, clock.at(clock.addDays(today, plan.receive), '11:20'), () => purchases.receive(owner.business, owner.user, po.row.id, {
      requestKey: base.key(sim.business.id, `${plan.step}-receipt`), supplierBillNo: `${supplier.billPrefix}/PO${po.row.id}`, supplierBillDate: today, lines: got,
    }), { touch: [['wholesale_purchase_orders', 'id', po.row.id]] });
  }
}

const wholesaleDef = {
  key: 'wholesale', type: 'wholesale', name: 'Sahyadri FMCG Distributors', location: 'Market Yard godown',
  legalName: 'Sahyadri FMCG Distributors Pvt Ltd', gstin: gstin('27', 'wholesale-shop', 'C', 'S'),
  address: ['Gala 14–16, Gultekdi Market Yard', 'Gultekdi'], city: 'Pune', pin: '411037', phone: '020-2426 1180', email: 'orders@sahyadrifmcg.in',
  invoiceFooter: 'Goods once dispatched are not taken back except for transit damage reported within 48 hours. Interest at 18% p.a. on bills overdue beyond the credit period.',
  taxMode: 'exclusive', rounding: 'nearest_rupee',
  days: 90, open: 9 * 60, close: 19 * 60, margin: 0.07, udhaar: false, regularShare: 0,
  curve: [[9, 2], [10, 4], [11, 5], [12, 4], [13, 3], [14, 3], [15, 3], [16, 3], [17, 2], [18, 1]],
  volume: (day, r) => (clock.weekday(day) === 0 ? 0 : r.int(2, 5)),
  basketSize: (r) => r.int(1, 3),
  pay: { cash: 0.7, upi: 0.3 },
  staff: [{ name: 'Prashant Deshmukh', login: 'prashant', role: 'manager' }, { name: 'Nitin Gaikwad', login: 'nitin', role: 'stock_keeper' }, { name: 'Ashwini Kulkarni', login: 'ashwini', role: 'accountant' },
    { name: 'Sagar More', login: 'sagar', role: 'cashier' }],
  suppliers: [
    supplier('hul', 'Western India Consumer Products (super stockist)', '27', 'w-hul', { prefix: 'WIC', creditDays: 21, days: [1, 4], holder: 'C', address: 'Bhosari MIDC, Pune' }),
    supplier('snk', 'Deccan Snacks & Foods Pvt Ltd', '27', 'w-snk', { prefix: 'DSF', creditDays: 30, days: [2], holder: 'C', address: 'Chakan MIDC, Pune' }),
    supplier('bev', 'Sahyadri Beverages Agency', '27', 'w-bev', { prefix: 'SBA', creditDays: 15, days: [3, 6], address: 'Hadapsar Industrial Estate, Pune' }),
    supplier('oil', 'Maharashtra Edible Oils & Staples', '27', 'w-oil', { prefix: 'MEO', creditDays: 15, days: [5], late: 4, holder: 'C', address: 'Market Yard, Pune' }),
  ],
  regulars: retailers,
  categories: [['Biscuits & snacks'], ['Packaged food'], ['Beverages'], ['Edible oil & staples'], ['Soaps & detergents'], ['Personal care'], ['Pooja & household']],
  items: wsItems,
  modules: [],
  hooks: {
    setup,
    // Cash-and-carry at the godown counter: small shops buying a case or two.
    basket: (sim, r) => [{ item: r.weighted(sim.items, (x) => x.meta.w), qty: 0 }].map((w) => ({ item: w.item, qty: (w.item.meta.perCase || 2) * r.int(1, 2) })),
    async morning(sim, day, closed) { if (!closed) await dispatchOrders(sim, day); },
    async afternoon(sim, day, limit) {
      await bookOrders(sim, day, limit);
      await collectDues(sim, day, limit);
      await damagedReturns(sim, day, limit);
    },
    async today(sim, today) {
      await chequesToday(sim, today);
      await purchaseOrders(sim, today);
      await schemeOrdersToday(sim, today);
    },
  },
  closedOn: (day) => clock.weekday(day) === 0,
};

module.exports = { wholesale: wholesaleDef };
