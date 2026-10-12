// Wholesale / FMCG sample data for the demo wholesale business (Phase 2, T2).
// Called by setup-business-demos.js --sample-data. Safe to run again on a demo
// in any state: it finds or creates what it builds on (the base catalogue, a
// location, the sample supplier), finds salespeople, routes and beats by name,
// and posts each order, dispatch and collection once (request keys; see
// demo-common.js). Everything goes through the same services as the API:
// prices, credit limits, number series, the stock ledger, events and audit.
// Names, phone numbers and figures are fictional.
const service = require('../src/modules/business/core/services/business.service');
const wholesale = require('../src/modules/business/wholesale/services/businessWholesale.service');
const repo = require('../src/modules/business/core/repositories/business.repository');
const common = require('./demo-common');
const prices = require('../src/modules/business/wholesale/services/businessWholesalePricing.service');
const credit = require('../src/modules/business/wholesale/services/businessWholesaleCredit.service');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// [name, code, price, gst, pack, perPack, packSlab: [fromPacks, pricePerPack]]
const FMCG = [
  ['Glucose biscuits 100 g', 'WS-BISC', 10, 18, 'case', 60, [5, 540]],
  ['Mango drink 200 ml', 'WS-MANGO', 20, 18, 'case', 30, [4, 525]],
  ['Instant noodles 70 g', 'WS-NOOD', 14, 18, 'case', 96, [3, 1250]],
];
const RETAILERS = [
  ['Shree Balaji Kirana', '98220 41001', { creditLimit: '60000', creditDays: 15, openingBalance: '4200', openingBalanceOn: day(-120) }],
  ['Annapurna Provision Stores', '98220 41002', { creditLimit: '40000', creditDays: 21 }],
  ['Om Sai Super Mart', '98220 41003', { creditLimit: '100000', creditDays: 30, openingBalance: '12850', openingBalanceOn: day(-95) }],
  ['Gupta General Stores', '98220 41004', { creditLimit: '25000', creditDays: 7 }],
  ['Mahalakshmi Traders', '98220 41005', { creditDays: 30 }],
];

async function sampleWholesale(business, user) {
  if (business.business_type !== 'wholesale' || !business.capabilities.includes('sales_orders')) return;
  const db = repo.pool;
  const { once } = common;
  // What this builds on, found or created: the base catalogue, a location, a supplier.
  await common.baseCatalogue(business, user);
  const location = await common.firstLocation(business);
  const slabs = await repo.all(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active', [business.id]);
  const category = await common.category(business, user, 'Packaged food');

  // Batch-tracked FMCG lines with cases and per-case slabs.
  const items = [];
  for (const [name, code, price, gst, pack, perPack, slab] of FMCG) {
    const sku = await common.skuByCode(business, code) || await service.createCatalog(business, user, { name, code, kind: 'goods', unit: 'each', tracking: 'batch', price: String(price),
      taxRateId: slabs.find((s) => Number(s.rate) === gst)?.id, categoryId: category.id, reorderLevel: String(perPack * 2) });
    await common.packSize(business, user, sku.id, pack, perPack);
    await common.priceRule(business, user, { skuId: sku.id, unitCode: pack, minimumQuantity: slab[0], unitPrice: slab[1] });
    items.push({ sku, pack, perPack });
  }
  // The soap and detergent lines get a per-case slab too.
  for (const [code, fromCases, perCase] of [['WS-SOAP', 5, 2016], ['WS-DBAR', 3, 1850]]) {
    const sku = await common.skuByCode(business, code);
    const hasPack = sku && await repo.one(db, "SELECT 1 FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code='case'", [business.id, sku.id]);
    if (hasPack) await common.priceRule(business, user, { skuId: sku.id, unitCode: 'case', minimumQuantity: fromCases, unitPrice: perCase });
  }

  // Stock: two batches each, the first expiring soon (oldest goes out first).
  const supplier = await common.sampleSupplier(business, user);
  // A group made earlier without this script's keys (older version) is left as it is.
  if (!await common.legacy(business, 'business_documents', "notes='FMCG stock (sample)'")) await once(business, 'business_documents', 'wholesale-fmcg-stock', (requestKey) => service.document(business, user, { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey,
    notes: 'FMCG stock (sample)', lines: items.flatMap(({ sku, perPack }, i) => [
      { skuId: sku.id, quantity: String(perPack * 12), unitPrice: (Number(sku.price) * 0.78).toFixed(2), lotCode: common.batchCode('B', `${sku.code}-A`), expiresOn: day(25 + i * 5) },
      { skuId: sku.id, quantity: String(perPack * 40), unitPrice: (Number(sku.price) * 0.8).toFixed(2), lotCode: common.batchCode('B', `${sku.code}-B`), expiresOn: day(200 + i * 20) },
    ]) }));
  const soap = await common.skuByCode(business, 'WS-SOAP');
  const tea = await common.skuByCode(business, 'WS-TEA');
  const topUp = [soap && { skuId: soap.id, quantity: '2160', unitPrice: '21.50' }, tea && { skuId: tea.id, quantity: '120', unitPrice: '300' }].filter(Boolean);
  if (topUp.length && !await common.legacy(business, 'business_documents', "notes='Monthly top-up (sample)'")) await once(business, 'business_documents', 'wholesale-top-up', (requestKey) => service.document(business, user,
    { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey, notes: 'Monthly top-up (sample)', lines: topUp }));

  // Field sales set-up, found by name.
  const named = (table, name, extra = '', values = []) => repo.one(db, `SELECT * FROM ${table} WHERE business_id=$1 AND name=$2 ${extra} ORDER BY id LIMIT 1`, [business.id, name, ...values]);
  const people = [];
  for (const [name, phone] of [['Ravi Kumar', '98500 10001'], ['Imran Shaikh', '98500 10002'], ['Suresh Patil', '98500 10003']]) {
    people.push(await named('wholesale_salespeople', name) || await wholesale.saveSalesperson(business, user, null, { name, phone }));
  }
  const route = async (name) => await named('wholesale_routes', name) || wholesale.saveRoute(business, user, null, { name, locationId: location.id });
  const kothrud = await route('Kothrud route');
  const hadapsar = await route('Hadapsar route');
  const beat = async (routeId, name, visitDay, salespersonId) => await named('wholesale_beats', name, 'AND route_id=$3', [routeId])
    || wholesale.saveBeat(business, user, null, { routeId, name, visitDay, salespersonId });
  const beats = [
    await beat(kothrud.id, 'Kothrud depot side', 1, people[0].id),
    await beat(kothrud.id, 'Karve Nagar', 4, people[0].id),
    await beat(hadapsar.id, 'Hadapsar gaon', 2, people[1].id),
    await beat(hadapsar.id, 'Magarpatta', 5, people[2].id),
  ];
  const customers = [];
  for (const [index, [name, phone, extra]] of RETAILERS.entries()) {
    const customer = await common.contact(business, user, 'customer', name, phone, extra);
    if (!await repo.one(db, 'SELECT 1 FROM wholesale_customer_beats WHERE business_id=$1 AND contact_id=$2', [business.id, customer.id])) {
      await wholesale.setCustomerBeat(business, user, customer.id, { beatId: beats[index % beats.length].id });
    }
    customers.push(customer);
  }
  // Two of the base sample's customers go on beats too (never a tester's own).
  for (const [i, [name]] of common.CUSTOMERS.slice(0, 2).entries()) {
    const c = await repo.one(db, "SELECT id FROM business_contacts WHERE business_id=$1 AND kind='customer' AND name=$2 ORDER BY id LIMIT 1", [business.id, name]);
    if (c && !await repo.one(db, 'SELECT 1 FROM wholesale_customer_beats WHERE business_id=$1 AND contact_id=$2', [business.id, c.id])) {
      await wholesale.setCustomerBeat(business, user, c.id, { beatId: beats[(i + 2) % beats.length].id });
    }
  }

  // Orders: some sent in full, some in part (back-orders), one closed short, one cancelled.
  const line = (item, cases) => ({ skuId: item.sku.id, unit: item.pack, quantity: String(cases) });
  const plans = [
    { c: 0, lines: [line(items[0], 6), line(items[1], 4)], send: 'all', age: 110 },
    { c: 2, lines: [line(items[2], 5), soap && { skuId: soap.id, unit: 'case', quantity: '5' }].filter(Boolean), send: 'all', age: 75 },
    { c: 1, lines: [line(items[0], 3), tea && { skuId: tea.id, quantity: '12' }].filter(Boolean), send: 'all', age: 40 },
    { c: 2, lines: [line(items[1], 8), line(items[0], 10)], send: 'all', age: 12 },
    { c: 3, lines: [line(items[2], 4), line(items[1], 2)], send: 'part', age: 3 },
    { c: 0, lines: [line(items[0], 5), line(items[2], 3)], send: 'part', age: 1 },
    { c: 4, lines: [line(items[1], 6)], send: 'none', age: 0 },
    { c: 1, lines: [line(items[2], 2)], send: 'short', age: 2 },
    { c: 3, lines: [line(items[0], 1)], send: 'cancel', age: 0 },
  ];
  let newOrders = 0;
  const oldOrders = await common.legacy(business, 'wholesale_orders');
  for (const [n, plan] of oldOrders ? [] : plans.entries()) {
    const order = await once(business, 'wholesale_orders', `wholesale-order-${n}`, (requestKey) => wholesale.createOrder(business, user, { locationId: location.id, contactId: customers[plan.c].id,
      requestKey, expectedOn: day(2), notes: plan.send === 'none' ? 'Deliver with next van' : undefined, lines: plan.lines }));
    if (order.created) newOrders += 1;
    const detail = await wholesale.orderDetail(business, order.row.id);
    const documentIds = [];
    if (plan.send === 'all' || plan.send === 'part' || plan.send === 'short') {
      const sendLines = (plan.send === 'all' ? detail.lines : detail.lines.slice(0, 1)).map((l) => {
        const whole = plan.send === 'all';
        if (l.entered_unit) return { orderLineId: l.id, unit: l.entered_unit, quantity: whole ? String(Number(l.entered_quantity)) : '1' };
        return { orderLineId: l.id, quantity: whole ? String(Number(l.quantity)) : '1' };
      });
      const sent = await once(business, 'wholesale_dispatches', `wholesale-dispatch-${n}`, (requestKey) => wholesale.dispatch(business, user, order.row.id,
        { requestKey, vehicleNo: 'MH12 KT 4521', lines: sendLines }));
      if (sent.created) documentIds.push(sent.row.document.id);
    }
    const status = (await repo.one(db, 'SELECT status FROM wholesale_orders WHERE business_id=$1 AND id=$2', [business.id, order.row.id])).status;
    const stillOpen = ['open', 'part_dispatched'].includes(status);
    if (plan.send === 'short' && stillOpen) await wholesale.closeOrder(business, user, order.row.id, { reason: 'Item short at the depot this week' });
    if (plan.send === 'cancel' && stillOpen) await wholesale.closeOrder(business, user, order.row.id, { reason: 'Shop owner cancelled on the phone' });
    // Age the older orders and their invoices made now, so the ageing buckets have figures.
    if (!plan.age) continue;
    if (order.created) await db.query(`UPDATE wholesale_orders SET created_at=now()-($2::int*interval '1 day')-interval '3 hours' WHERE business_id=$1 AND id=$3`, [business.id, plan.age, order.row.id]);
    for (const documentId of documentIds) {
      await db.query(`UPDATE business_documents d SET created_at=now()-($2::int*interval '1 day'),
        due_on=((now()-($2::int*interval '1 day')) AT TIME ZONE 'Asia/Kolkata')::date + COALESCE((SELECT credit_days FROM business_contacts c WHERE c.business_id=d.business_id AND c.id=d.contact_id),0)
        WHERE d.business_id=$1 AND d.id=$3`, [business.id, plan.age, documentId]);
      await db.query(`UPDATE wholesale_dispatches SET created_at=now()-($2::int*interval '1 day') WHERE business_id=$1 AND document_id=$3`, [business.id, plan.age, documentId]);
    }
  }
  // Collections: by salespeople on their routes, oldest bills first; one advance.
  const collect = (n, c, amount, method, who, routeId, extra = {}) => once(business, 'business_collections', `wholesale-collection-${n}`, (requestKey) => wholesale.collect(business, user,
    { locationId: location.id, contactId: customers[c].id, amount: String(amount), method, requestKey, salespersonId: who.id, routeId, ...extra }));
  await proPassSample(business, user, customers, items);
  if (await common.legacy(business, 'business_collections')) {
    console.log(`  ${business.name}: wholesale sample — ${newOrders} new orders; collections were made earlier`);
    return;
  }
  await collect(0, 0, 6000, 'cash', people[0], kothrud.id);
  await collect(1, 2, 15000, 'cheque', people[1], hadapsar.id, { reference: 'CHQ 004512', bank: 'HDFC Bank, Hadapsar' });
  await collect(2, 1, 2500, 'upi', people[0], kothrud.id, { reference: 'UPI 61834012' });
  await collect(3, 4, 3000, 'bank', people[2], hadapsar.id, { reference: 'NEFT DEMO1', allocations: [], notes: 'Advance for the next order' });
  console.log(`  ${business.name}: wholesale sample — ${plans.length} orders (${newOrders} new), ${people.length} salespeople, 2 routes, 4 collections`);
}

// Pro pass D (7 Oct 2026): the seller's details for a proper tax invoice
// (only where none are set), a retailers' price group with dated case
// prices, a scheme, trade details for the retailers (walk-ins kept apart)
// and a 60-day credit hold. Found or created, so it is safe to run again.
async function proPassSample(business, user, customers, items) {
  const db = repo.pool;
  await db.query(`UPDATE business_settings SET legal_name=COALESCE(legal_name,'Sahyadri FMCG Distributors (sample)'),
    address_line1=COALESCE(address_line1,'Gala 14, Market Yard'),city=COALESCE(city,'Pune'),postal_code=COALESCE(postal_code,'411037'),
    state_code=COALESCE(state_code,'27'),rounding='nearest_rupee' WHERE business_id=$1 AND gstin IS NULL`, [business.id]);
  let group = await repo.one(db, "SELECT * FROM wholesale_price_groups WHERE business_id=$1 AND lower(name)='retailers'", [business.id]);
  if (!group) group = await prices.saveGroup(business, user, null, { name: 'Retailers', notes: 'Kirana and general stores' });
  const noodles = items.find((i) => i.sku.code === 'WS-NOOD');
  const biscuits = items.find((i) => i.sku.code === 'WS-BISC');
  for (const [item, price] of [[noodles, '1290'], [biscuits, '565']]) {
    if (item && !await repo.one(db, 'SELECT 1 FROM wholesale_group_prices WHERE business_id=$1 AND group_id=$2 AND sku_id=$3', [business.id, group.id, item.sku.id])) {
      await prices.setGroupPrice(business, user, { groupId: group.id, skuId: item.sku.id, unitCode: item.pack, minimumQuantity: '1', unitPrice: price });
    }
  }
  if (noodles && !await repo.one(db, 'SELECT 1 FROM wholesale_schemes WHERE business_id=$1 AND sku_id=$2', [business.id, noodles.sku.id])) {
    await prices.saveScheme(business, user, null, { name: 'Noodles 10 + 1 free', skuId: noodles.sku.id, unitCode: noodles.pack, buyQuantity: '10', freeQuantity: '1' });
  }
  for (const customer of customers) {
    if (!await repo.one(db, 'SELECT 1 FROM wholesale_customer_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, customer.id])) {
      await credit.saveProfile(business, user, customer.id, { priceGroupId: group.id, stateCode: '27', tradeType: 'trade' });
    }
  }
  // The base sample's counter customers who are not on a beat are walk-ins.
  await db.query(`INSERT INTO wholesale_customer_profiles(business_id,contact_id,trade_type,updated_by)
    SELECT c.business_id,c.id,'walk_in',$2 FROM business_contacts c WHERE c.business_id=$1 AND c.kind='customer'
    AND NOT EXISTS (SELECT 1 FROM wholesale_customer_beats cb WHERE cb.business_id=c.business_id AND cb.contact_id=c.id)
    AND c.name=ANY($3::text[]) ON CONFLICT DO NOTHING`, [business.id, user.id, common.CUSTOMERS.map(([name]) => name)]);
  if (!await repo.one(db, 'SELECT 1 FROM wholesale_settings WHERE business_id=$1', [business.id])) await credit.saveSettings(business, user, { holdOverdueDays: 60 });
}

module.exports = { sampleWholesale };
