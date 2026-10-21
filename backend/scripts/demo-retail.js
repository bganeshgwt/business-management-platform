// Retail demo extras (grocery / kirana, supermarket, books & stationery), added
// by setup-business-demos.js --sample-data. Safe to run again on a demo in any
// state: each step finds or creates what it needs (base catalogue, categories,
// sample supplier) and skips what it already added (offers by name, books by
// code or ISBN, postings by request key; see demo-common.js). Every record goes through the same
// services the API uses (offers applied by the server, points, udhaar
// collections, stock). All people, shops, phone numbers and ISBNs are fictional.
const repo = require('../src/modules/business/core/repositories/business.repository');
const access = require('../src/modules/business/core/services/businessAccess.service');
const service = require('../src/modules/business/core/services/business.service');
const setup = require('../src/modules/business/core/services/businessSetup.service');
const retail = require('../src/modules/business/retail/services/businessRetail.service');
const customers = require('../src/modules/business/retail/services/businessRetailCustomers.service');
const offers = require('../src/modules/business/retail/services/businessRetailOffers.service');
const receivables = require('../src/modules/business/wholesale/services/businessReceivables.service');
const retailPro = require('../src/modules/business/retail/services/businessRetailPro.service');
const common = require('./demo-common');

const RETAIL = ['grocery', 'supermarket', 'books'];
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// GST 2.0 (22 Sep 2025): items the first demos made at the old slab move to
// the new one (only these sample codes; a tester's own items are untouched).
const GST_2025 = { 'BIS-GLU': 5, 'PC-TP150': 5, 'PC-SOAP4': 5, 'PF-NOOD': 5, 'PF-CORN': 5, 'ST-NB200': 0 };

// A valid ISBN-13 from a 12-digit body (fictional 978-93 Indian prefix).
const isbn = (body) => body + retail.eanCheck(body);

const PLAN = {
  grocery: {
    modules: ['offers', 'loyalty'],
    loyalty: { earnPerAmount: '100', earnPoints: 1, pointValue: '1', minRedeemPoints: 50, maxRedeemPercent: '20', active: true },
    customers: [['Sharma ji (Flat 302, Shanti Apts)', '98450 10101', { creditLimit: '8000', creditDays: 15, openingBalance: '1450', openingBalanceOn: day(-85) }],
      ['Pooja Kulkarni', '98450 20202', { creditLimit: '5000', creditDays: 7 }], ['Raju Auto Garage', '98450 30303', { creditLimit: '15000', creditDays: 30, openingBalance: '3200', openingBalanceOn: day(-95) }],
      ['Anita Desai', '98450 40404', { creditDays: 10 }], ['Venkatesh Rao', '98450 50505', { creditLimit: '6000', creditDays: 15 }]],
    scale: [['RICE-SM', '101'], ['RICE-BAS', '102'], ['DAL-TOOR', '103']],
    offers: (ids, cats) => [
      { name: 'Ghee ₹20 off', kind: 'item_amount', skuId: ids['GHEE-500'], value: '20' },
      { name: 'Salt: buy 2 get 1 free', kind: 'buy_x_get_y', skuId: ids['SALT-1'], buyQuantity: '2', getQuantity: '1', value: '100' },
      { name: 'Sunday staples 5% off', kind: 'category_percent', categoryId: cats.Staples, value: '5', daysOfWeek: [7] },
      { name: '₹30 off on ₹1,500 and above', kind: 'bill_amount', value: '30', minBillAmount: '1500' },
    ],
  },
  supermarket: {
    modules: [],
    loyalty: { earnPerAmount: '100', earnPoints: 2, pointValue: '0.5', minRedeemPoints: 100, maxRedeemPercent: '25', active: true },
    customers: [['Neha Joshi', '99000 61616', {}], ['Arvind Menon', '99000 62626', {}], ['Farah Sheikh', '99000 63636', {}], ['Gurpreet Singh', '99000 64646', {}]],
    loose: [['Onions (loose)', 'VEG-ONI', 'kg', 38, 0, '104'], ['Toor dal (loose)', 'DAL-LSE', 'kg', 152, 5, '105']],
    // Fresh and dated goods tracked by batch and expiry (pro pass C-14):
    // [name, code, price, GST %, [[expires in days, quantity], …]]. One curd
    // batch is already past its date, for the near-expiry screen.
    batchItems: [['Fresh paneer 200 g', 'DY-PAN', 95, 5, [[3, 10], [11, 14]]], ['Curd 400 g', 'DY-CURD', 45, 5, [[-1, 4], [5, 18]]],
      ['Milk bread 400 g', 'BR-BRD', 40, 0, [[2, 12], [4, 15]]], ['Butter 100 g', 'DY-BUT', 58, 5, [[24, 16], [80, 24]]],
      ['Fruit yoghurt 100 g', 'DY-YOG', 30, 5, [[7, 30]]]],
    offers: (ids, cats) => [
      { name: '10% off personal care', kind: 'category_percent', categoryId: cats['Personal care'], value: '10' },
      { name: 'Noodles: buy 4 get 1 free', kind: 'buy_x_get_y', skuId: ids['PF-NOOD'], buyQuantity: '4', getQuantity: '1', value: '100' },
      { name: 'Happy hours 4–7 pm: 5% off the bill', kind: 'bill_percent', value: '5', startsTime: '16:00', endsTime: '19:00', maxDiscount: '150' },
      { name: '₹100 off on ₹2,000 and above', kind: 'bill_amount', value: '100', minBillAmount: '2000' },
      { name: 'Weekend detergent ₹15 off', kind: 'item_amount', skuId: ids['HC-DET1'], value: '15', daysOfWeek: [6, 7] },
      { name: 'Festive corn flakes 20% off', kind: 'item_percent', skuId: ids['PF-CORN'], value: '20', startsOn: day(5), endsOn: day(20) },
      { name: 'Monsoon tea sale', kind: 'item_percent', skuId: ids['PF-TEA'], value: '15', startsOn: day(-40), endsOn: day(-10) },
    ],
  },
  books: {
    modules: ['offers', 'receivables'],
    customers: [['St. Xavier\'s School library', '97400 71717', { creditLimit: '50000', creditDays: 30 }], ['Meera Pillai', '97400 72727', {}], ['Rohan Bhat', '97400 73737', {}]],
    books: {
      'BK-MON': { isbn: isbn('978935000001'), author: 'Anjali Varma', publisher: 'Monsoon Leaf Press', edition: '2nd', language: 'English', publishedYear: 2021 },
      'BK-M10': { isbn: isbn('978935000002'), author: 'R. K. Sethi', publisher: 'Pragati Educational', edition: '2026–27', language: 'English', publishedYear: 2026 },
    },
    newBooks: [['Godaan (Hindi classic, paperback)', 'BK-GOD', 175, 'Fiction', { isbn: isbn('978935000003'), author: 'Premchand', publisher: 'Saraswati Prakashan', edition: 'Reprint 2024', language: 'Hindi', publishedYear: 2024 }],
      ['Malgudi Mornings (stories)', 'BK-MAL', 299, 'Fiction', { isbn: isbn('978935000004'), author: 'S. Narayanaswamy', publisher: 'Monsoon Leaf Press', edition: '1st', language: 'English', publishedYear: 2023 }],
      ['Class 12 physics practice papers', 'BK-P12', 395, 'Exam guides', { isbn: isbn('978935000005'), author: 'Dr. Kavita Rao', publisher: 'Pragati Educational', edition: '2026–27', language: 'English', publishedYear: 2026 }],
      ['Panchatantra for children (illustrated)', 'BK-PAN', 250, 'Fiction', { isbn: isbn('978935000006'), author: 'Retold by Uma Iyer', publisher: 'Little Lamp Books', edition: '3rd', language: 'English', publishedYear: 2022 }]],
    // School booklists (pro pass C-24): scanned at the counter to bill the whole set.
    sets: [["St. Xavier's School — Class 10 (2026–27)", 'SXS-C10', "St. Xavier's School", 'Class 10', [['BK-M10', 1], ['ST-NB200', 6], ['ST-GEL', 4]]],
      ["St. Xavier's School — Class 5 (2026–27)", 'SXS-C5', "St. Xavier's School", 'Class 5', [['BK-PAN', 1], ['ST-NB200', 4], ['ST-GEL', 2]]]],
    // Customer orders for books not on the shelf: one with an advance on account, one arrived.
    orders: [['book-order-0', 'Meera Pillai', 'The Silent Banyan (hardback)', 'Leela Menon', '200', 'ordered', 6],
      ['book-order-1', null, 'Atlas of Indian Rivers (school edition)', 'Dr. Ravi Kulkarni', '0', 'arrived', 2]],
    offers: (ids, cats) => [
      { name: 'School season: 15% off stationery', kind: 'category_percent', categoryId: cats.Stationery, value: '15' },
      { name: 'Notebooks: buy 3 get 1 free', kind: 'buy_x_get_y', skuId: ids['ST-NB200'], buyQuantity: '3', getQuantity: '1', value: '100' },
      { name: '₹50 off on ₹1,000 and above', kind: 'bill_amount', value: '50', minBillAmount: '1000' },
    ],
  },
};

async function lotFor(db, business, locationId, skuId, quantity) {
  const lot = await repo.one(db, `SELECT lot_code FROM business_stock_lots l JOIN businesses b ON b.id=l.business_id WHERE l.business_id=$1 AND l.location_id=$2 AND l.sku_id=$3
    AND l.quantity>=$4 AND (l.expires_on IS NULL OR l.expires_on>=(now() AT TIME ZONE b.timezone)::date) ORDER BY l.expires_on NULLS LAST,l.id LIMIT 1`, [business.id, locationId, skuId, quantity]);
  return lot?.lot_code;
}

// Reminders for the sample customers who still owe, one promise already broken.
// Each sample customer is reminded once (a re-run adds none).
async function reminderSample(business, user, plan) {
  if (!business.modules.includes('receivables')) return;
  const names = plan.customers.map(([name]) => name);
  const owing = (await repo.all(repo.pool, `SELECT c.id,c.name FROM business_contacts c WHERE c.business_id=$1 AND c.kind='customer' AND c.name=ANY($2)
    AND ${repo.contactBalanceSql('c')}>0 ORDER BY c.id`, [business.id, names]));
  const reminders = [['whatsapp', 3, 'Will pay after salary'], ['call', null, 'Out of town this week'], ['visit', 5, 'Promised to clear half']];
  for (const [index, [channel, promise, note]] of reminders.entries()) {
    const person = owing[index];
    if (!person) continue;
    if (await repo.one(repo.pool, 'SELECT 1 FROM retail_credit_reminders WHERE business_id=$1 AND contact_id=$2 LIMIT 1', [business.id, person.id])) continue;
    const saved = await customers.remind(business, user, person.id, { channel, note, promisedOn: promise === null ? undefined : day(promise) });
    if (index === 0) await repo.pool.query(`UPDATE retail_credit_reminders SET created_at=now()-interval '9 days',promised_on=$3 WHERE business_id=$1 AND id=$2`, [business.id, saved.id, day(-4)]);
  }
}

async function sampleRetail(input, user) {
  if (!RETAIL.includes(input.business_type)) return;
  const plan = PLAN[input.business_type];
  const db = repo.pool;
  for (const code of plan.modules) if (!input.modules.includes(code)) await setup.setModule(input, user, code, { enabled: true });
  let business = await access.load(user, input.id);
  // What the extras build on, found or created: the base catalogue and its
  // categories, the sample supplier.
  const base = await common.baseCatalogue(business, user);
  const location = await common.firstLocation(business);
  const ids = Object.fromEntries(base.skus.map((s) => [s.code, s.id]));
  const cats = { ...base.categoryIds };
  const needCategory = async (name) => { cats[name] = cats[name] || Number((await common.category(business, user, name)).id); return cats[name]; };
  const slabs = await repo.all(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active', [business.id]);
  const slab = (rate) => slabs.find((s) => Number(s.rate) === Number(rate))?.id;

  // Items: loose (weighed) goods, books with full details.
  for (const [name, code, unit, price, rate, plu] of plan.loose || []) {
    const sku = await common.skuByCode(business, code) || await service.createCatalog(business, user, { name, code, kind: 'goods', unit, tracking: 'quantity', price: String(price),
      taxRateId: slab(rate), reorderLevel: '10', categoryId: await needCategory('Packaged food') });
    ids[code] = sku.id;
    if (business.modules.includes('weight')) await retail.setScaleCode(business, user, sku.id, { pluCode: plu });
  }
  if (business.modules.includes('weight')) for (const [code, plu] of plan.scale || []) if (ids[code]) await retail.setScaleCode(business, user, ids[code], { pluCode: plu });
  for (const [code, details] of Object.entries(plan.books || {})) if (ids[code]) await retail.updateBook(business, user, ids[code], details);
  for (const [name, code, price, categoryName, details] of plan.newBooks || []) {
    // A book is found by its code, or by its ISBN (which is also its barcode).
    const sku = await common.skuByCode(business, code)
      || await repo.one(db, 'SELECT s.* FROM books_titles t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id WHERE t.business_id=$1 AND t.isbn=$2', [business.id, details.isbn])
      || await repo.one(db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND barcode=$2', [business.id, details.isbn])
      || await retail.createBook(business, user, { name, code, price: String(price), taxRateId: slab(0), categoryId: await needCategory(categoryName), ...details });
    ids[code] = sku.id;
  }
  for (const [code, rate] of Object.entries(GST_2025)) {
    const sku = ids[code] ? await common.skuByCode(business, code) : null;
    if (!sku || Number(sku.tax_rate) === rate || !slab(rate)) continue;
    await service.updateCatalog(business, user, sku.id, { label: sku.label, price: String(sku.price), taxRateId: slab(rate), active: sku.active });
  }
  const batchIds = [];
  for (const [name, code, price, rate] of plan.batchItems || []) {
    if (!business.modules.includes('batches')) break;
    const sku = await common.skuByCode(business, code) || await service.createCatalog(business, user, { name, code, kind: 'goods', unit: 'each', tracking: 'batch',
      price: String(price), taxRateId: slab(rate), reorderLevel: '6', categoryId: await needCategory('Dairy & bakery') });
    ids[code] = sku.id;
    batchIds.push(sku.id);
  }

  // Every sample item gets a scannable barcode (books keep their ISBN).
  const unlabelled = (await repo.all(db, 'SELECT id FROM catalog_skus WHERE business_id=$1 AND barcode IS NULL AND id = ANY($2::bigint[])', [business.id, Object.values(ids)])).map((s) => s.id);
  if (unlabelled.length) await retail.assignBarcodes(business, user, { skuIds: unlabelled });

  // Top up the shelf so the sample sales below never run short.
  const supplier = await common.sampleSupplier(business, user);
  const goods = await repo.all(db, `SELECT s.* FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
    WHERE s.business_id=$1 AND p.kind='goods' AND s.active AND s.tracking<>'serial' AND s.id = ANY($2::bigint[]) ORDER BY s.id`, [business.id, Object.values(ids)]);
  const restockable = goods.filter((s) => !batchIds.includes(s.id));
  if (restockable.length && !await common.legacy(business, 'business_documents', "kind='purchase' AND notes='Weekly restock (sample)'")) {
    const restock = await common.once(business, 'business_documents', 'retail-restock', (requestKey) => service.document(business, user, { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey,
      notes: 'Weekly restock (sample)', lines: restockable.map((s) => ({ skuId: s.id, quantity: s.unit === 'kg' ? '80' : '120', unitPrice: (Number(s.price) * 0.72).toFixed(2),
        ...(s.tracking === 'batch' ? { lotCode: common.batchCode('RS', s.code), expiresOn: day(240) } : {}) })) }));
    // The restock came before the ten weeks of sample bills, so the stock
    // ledger reads in time order (pro pass C-27).
    if (restock.created) {
      await db.query(`UPDATE business_documents SET created_at=now()-interval '72 days' WHERE business_id=$1 AND id=$2`, [business.id, restock.row.id]);
      await db.query(`UPDATE business_stock_movements SET created_at=now()-interval '72 days' WHERE business_id=$1 AND document_id=$2`, [business.id, restock.row.id]);
    }
  }
  // Fresh goods: one receipt with two batches per item, dated so some are
  // close to (or past) their date.
  const fresh = (plan.batchItems || []).filter(([, code]) => ids[code] && batchIds.includes(ids[code]));
  if (fresh.length) {
    const received = await common.once(business, 'business_documents', 'retail-fresh-batches', (requestKey) => service.document(business, user, {
      kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey, notes: 'Dairy and bakery (sample)',
      lines: fresh.flatMap(([, code, price, , batches]) => batches.map(([offset, quantity], i) => ({ skuId: ids[code], quantity: String(quantity),
        unitPrice: (Number(price) * 0.78).toFixed(2), lotCode: common.batchCode(i ? 'FB' : 'FA', code), expiresOn: day(Math.max(offset, 1)) }))) }));
    // A batch received earlier that is now past its date (a receipt cannot carry a past date).
    if (received.created) {
      for (const [, code, , , batches] of fresh) {
        for (const [i, [offset]] of batches.entries()) {
          if (offset < 1) await db.query('UPDATE business_stock_lots SET expires_on=$4 WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [business.id, ids[code], common.batchCode(i ? 'FB' : 'FA', code), day(offset)]);
        }
      }
    }
  }

  // Offers (each once, by name; an offer whose item is missing is left out) and loyalty rules.
  for (const offer of plan.offers(ids, cats)) {
    if ((offer.kind.startsWith('item') || offer.kind === 'buy_x_get_y') && !offer.skuId) continue;
    if (offer.kind.startsWith('category') && !offer.categoryId) continue;
    if (await repo.one(db, 'SELECT 1 FROM retail_offers WHERE business_id=$1 AND name=$2', [business.id, offer.name])) continue;
    await offers.createOffer(business, user, { startsOn: day(-80), ...offer });
  }
  if (plan.loyalty && !await repo.one(db, 'SELECT 1 FROM retail_loyalty_settings WHERE business_id=$1', [business.id])) await customers.saveLoyaltyRules(business, user, plan.loyalty);
  business = await access.load(user, business.id);

  // Regular customers.
  const people = [];
  for (const [name, phone, extra] of plan.customers) people.push(await common.contact(business, user, 'customer', name, phone, extra));
  if (business.modules.includes('loyalty') && !await common.legacy(business, 'retail_loyalty_entries', "reason LIKE 'Welcome bonus%'")) {
    for (const [i, person] of people.slice(0, 2).entries()) {
      await common.once(business, 'retail_loyalty_entries', `retail-welcome-${i}`, (requestKey) => customers.adjustPoints(business, user, person.id,
        { points: '150', reason: 'Welcome bonus for joining (sample)', requestKey }));
    }
  }

  // Sales over the last ten weeks: some paid, some on udhaar, some with points.
  const posted = [];
  // Sales of an earlier version of this script (or the tester's own) are left as they are.
  const oldSales = await common.legacy(business, 'business_documents', "kind='sale'");
  for (let n = 0; n < 24 && goods.length && !oldSales; n += 1) {
    const step = `retail-sale-${n}`;
    const picks = [goods[(n * 5) % goods.length], goods[(n * 3 + 2) % goods.length], goods[(n * 7 + 1) % goods.length]].filter((s, i, a) => a.indexOf(s) === i);
    const person = n % 4 === 3 ? null : people[n % people.length];
    const sale = await common.once(business, 'business_documents', step, async (requestKey) => {
      const lines = [];
      for (const s of picks) {
        const quantity = s.unit === 'kg' ? ((n % 3) + 1 + 0.5).toFixed(3) : String((n % 4) + (s.code.startsWith('PF-NOOD') || s.code.startsWith('ST-NB') || s.code.startsWith('SALT') ? 4 : 1));
        const lotCode = s.tracking === 'batch' ? await lotFor(db, business, location.id, s.id, quantity) : undefined;
        if (s.tracking === 'batch' && !lotCode) continue;
        lines.push({ skuId: s.id, quantity, ...(lotCode ? { lotCode } : {}) });
      }
      if (!lines.length) return null;
      const redeem = plan.loyalty && business.modules.includes('loyalty') && person && n % 6 === 1 ? { loyalty: { redeemPoints: String(plan.loyalty.minRedeemPoints) } } : {};
      try {
        return await service.document(business, user, { kind: 'sale', locationId: location.id, contactId: person?.id || null, requestKey, lines, ...common.walkInPays(person?.id, ['cash', 'upi', 'card'][n % 3]), ...redeem });
      } catch (error) {
        if (!/points|stock|credit|redeem/i.test(error.message)) throw error;
        return service.document(business, user, { kind: 'sale', locationId: location.id, contactId: person?.id || null, requestKey, lines, ...common.walkInPays(person?.id, ['cash', 'upi', 'card'][n % 3]) });
      }
    });
    if (!sale.row) continue;
    // Walk-ins and most bills are paid; regulars leave some on udhaar.
    const udhaar = Boolean(person) && business.modules.includes('receivables') && n % 3 !== 0;
    if (!udhaar) await common.pay(business, user, sale.row, `${step}-paid`, { amount: sale.row.total, method: ['cash', 'upi', 'card'][n % 3] });
    if (sale.created) posted.push({ sale: sale.row, person, udhaar, age: 68 - n * 3 });
  }
  // Spread the sample bills made now over the last ten weeks (oldest first),
  // with due dates from each customer's credit days, so ageing and reports have depth.
  for (const { sale, person, age } of posted) {
    const days = Math.max(0, age);
    await db.query(`UPDATE business_documents SET created_at=now()-($3::int * interval '1 day')-interval '3 hours',
      due_on=((now()-($3::int * interval '1 day')) AT TIME ZONE $4)::date+$5::int WHERE business_id=$1 AND id=$2`,
    [business.id, sale.id, days, business.timezone, Number(person?.credit_days || 0)]);
    for (const table of ['retail_sale_discounts', 'retail_loyalty_entries', 'business_stock_movements', 'business_payments']) {
      await db.query(`UPDATE ${table} SET created_at=now()-($3::int * interval '1 day')-interval '3 hours' WHERE business_id=$1 AND document_id=$2`, [business.id, sale.id, days]);
    }
  }

  // Udhaar: a part payment from two sample customers who owe, then reminders.
  if (business.modules.includes('receivables')) {
    const owing = await repo.all(db, `SELECT c.* FROM business_contacts c WHERE c.business_id=$1 AND c.kind='customer' AND c.id = ANY($2::bigint[])
      AND ${repo.contactBalanceSql('c')}>0 ORDER BY c.id`, [business.id, people.map((p) => p.id)]);
    const oldCollections = await common.legacy(business, 'business_collections');
    for (const [index, person] of oldCollections ? [] : owing.slice(0, 2).entries()) {
      await common.once(business, 'business_collections', `retail-collection-${index}`, (requestKey) => receivables.createCollection(business, user,
        { locationId: location.id, contactId: person.id, amount: index === 0 ? '500' : '300', method: index === 0 ? 'cash' : 'upi', requestKey, notes: 'Part payment (sample)' }));
    }
    await reminderSample(business, user, plan);
  }
  // Bookshops: school sets and customer orders.
  if (business.modules.includes('books')) {
    for (const [name, code, school, className, items] of plan.sets || []) {
      if (await repo.one(db, 'SELECT 1 FROM books_sets WHERE business_id=$1 AND code=$2', [business.id, code])) continue;
      const lines = items.filter(([sku]) => ids[sku]).map(([sku, quantity]) => ({ skuId: ids[sku], quantity: String(quantity) }));
      if (lines.length) await retailPro.createSet(business, user, { name, code, school, className, items: lines });
    }
    for (const [step, personName, title, author, advance, status, promise] of plan.orders || []) {
      const requestKey = common.stableKey(business.id, step);
      if (await repo.one(db, 'SELECT 1 FROM books_customer_orders WHERE business_id=$1 AND request_key=$2', [business.id, requestKey])) continue;
      const person = personName ? people.find((p) => p.name === personName) : null;
      if (Number(advance) > 0 && !(person && business.modules.includes('receivables'))) continue;
      const order = await retailPro.createOrder(business, user, { locationId: location.id, requestKey, title, author, quantity: 1, promisedOn: day(promise),
        ...(person ? { contactId: person.id } : { customerName: 'Arjun Nair', phone: '97400 74747' }), ...(Number(advance) > 0 ? { advance, method: 'cash' } : {}) });
      if (status !== 'ordered') await retailPro.setOrderStatus(business, user, order.id, { status });
    }
  }

  const summary = await repo.one(db, `SELECT (SELECT count(*) FROM retail_offers WHERE business_id=$1)::int AS offers,
    (SELECT count(*) FROM retail_sale_discounts WHERE business_id=$1)::int AS discounts,(SELECT count(*) FROM retail_loyalty_entries WHERE business_id=$1)::int AS points`, [business.id]);
  console.log(`  ${business.name}: retail extras — ${posted.length} new bills, ${summary.offers} offers (${summary.discounts} discount lines), ${summary.points} points entries`);
}

module.exports = { sampleRetail };
