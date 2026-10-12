// Fashion and electronics sample data for the demo businesses (Phase 2, T3).
// Called by setup-business-demos.js --sample-data. Safe to run again on a demo
// in any state: it finds or creates what it builds on (the base catalogue,
// categories, the sample supplier and customers), finds styles by name and
// items by code, and posts each purchase, sale, exchange, warranty and repair
// job once (request keys; see demo-common.js). Everything goes through the
// same services as the API (number series, the stock ledger, events, audit).
// Names, numbers and figures are fictional.
const service = require('../src/modules/business/core/services/business.service');
const stock = require('../src/modules/business/core/services/businessStock.service');
const fashion = require('../src/modules/business/fashion-electronics/services/businessFashion.service');
const exchanges = require('../src/modules/business/fashion-electronics/services/businessExchanges.service');
const electronics = require('../src/modules/business/fashion-electronics/services/businessElectronics.service');
const repairs = require('../src/modules/business/fashion-electronics/services/businessRepairs.service');
const repo = require('../src/modules/business/core/repositories/business.repository');
const common = require('./demo-common');

const { once } = common;
const pick = (list, n) => list[n % list.length];

async function basics(business, user) {
  const db = repo.pool;
  // What the extras build on, found or created: the base catalogue, the sample
  // supplier and customers (never a tester's own).
  await common.baseCatalogue(business, user);
  const locations = await repo.all(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND active ORDER BY id', [business.id]);
  const slabs = await repo.all(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active', [business.id]);
  const slab = (rate) => slabs.find((s) => Number(s.rate) === rate)?.id;
  const supplier = await common.sampleSupplier(business, user);
  const customers = await common.sampleCustomers(business, user);
  const category = async (name) => Number((await common.category(business, user, name)).id);
  return { db, locations, slab, supplier, customers, category };
}

// --- Fashion ------------------------------------------------------------------------------

const STYLES = [
  { name: 'Oxford cotton shirt', brand: 'Kaveri Mills', category: 'Shirts', codePrefix: 'OXF', price: '1199', sizePrices: { XXL: '1299' },
    sizes: ['S', 'M', 'L', 'XL', 'XXL'], colors: ['Sky blue', 'White', 'Navy'], cost: '610' },
  { name: 'Slim fit chinos', brand: 'Kaveri Mills', category: 'Trousers', codePrefix: 'CHN', price: '1599',
    sizes: ['30', '32', '34', '36'], colors: ['Khaki', 'Olive', 'Black'], cost: '820' },
  { name: 'Anarkali kurti', brand: 'Rangoli Prints', category: 'Kurtis', codePrefix: 'ANK', price: '1399', sizePrices: { XL: '1499' },
    sizes: ['S', 'M', 'L', 'XL'], colors: ['Maroon', 'Mustard', 'Teal'], fabrics: ['Cotton', 'Rayon'], cost: '700' },
];
// How many of each size arrive: the middle sizes sell most.
const ARRIVAL = { S: 4, M: 8, L: 8, XL: 5, XXL: 3, 30: 4, 32: 7, 34: 7, 36: 4 };

async function sampleFashion(business, user) {
  if (business.business_type !== 'fashion' || !business.modules.includes('variants')) return;
  const ctx = await basics(business, user);
  const location = ctx.locations[0];
  const variants = [];
  for (const [index, style] of STYLES.entries()) {
    // A style is found by its name (its matrix is made with it, all or nothing).
    const existing = await repo.one(ctx.db, 'SELECT id FROM catalog_products WHERE business_id=$1 AND name=$2 ORDER BY id LIMIT 1', [business.id, style.name]);
    const productId = existing?.id || (await fashion.createProduct(business, user, { ...style, taxRateId: ctx.slab(5), categoryId: await ctx.category(style.category), reorderLevel: '2' })).product.id;
    const matrix = await fashion.matrix(business, productId);
    if (!await common.legacy(business, 'business_documents', `notes='${style.name}: new season (sample)'`)) {
      await once(business, 'business_documents', `fashion-arrival-${index}`, (requestKey) => service.document(business, user, { kind: 'purchase', locationId: location.id,
        contactId: ctx.supplier.id, requestKey, notes: `${style.name}: new season (sample)`,
        lines: matrix.variants.map((v) => ({ skuId: v.sku_id, quantity: String(Math.max(1, (ARRIVAL[v.size] || 4) - (v.fabric === 'Rayon' ? 2 : 0))), unitPrice: style.cost })) }));
    }
    variants.push(...matrix.variants.map((v) => ({ ...v, product: style.name })));
  }
  // Sales spread over recent days, mostly M and L. Sales of an earlier version
  // of this script (or the tester's own) are left as they are.
  const popular = variants.filter((v) => ['M', 'L', '32', '34'].includes(v.size));
  const sales = [];
  const made = [];
  const oldSales = await common.legacy(business, 'business_documents', "kind='sale'");
  for (let n = 0; n < 16 && !oldSales; n += 1) {
    const lines = [pick(popular, n * 5 + 1), ...(n % 3 === 0 ? [pick(variants, n * 7 + 3)] : [])]
      .filter((v, i, all) => all.findIndex((x) => x.sku_id === v.sku_id) === i).map((v) => ({ skuId: v.sku_id, quantity: '1' }));
    const customer = n % 2 === 0 ? pick(ctx.customers, n) : null;
    try {
      const sale = await once(business, 'business_documents', `fashion-sale-${n}`, (requestKey) => service.document(business, user,
        { kind: 'sale', locationId: location.id, contactId: customer?.id || null, requestKey, lines, ...common.walkInPays(customer?.id, pick(['upi', 'cash', 'card'], n)) }));
      await common.pay(business, user, sale.row, `fashion-sale-${n}-paid`, { amount: sale.row.total, method: pick(['upi', 'cash', 'card'], n) });
      sales.push(sale.row);
      if (sale.created) made.push(sale.row.id);
    } catch (error) {
      if (!/stock|credit/i.test(error.message)) throw error;
    }
  }
  // Spread the sales made now over the last few days (never before this month).
  await common.backdate(business, made, `UPDATE business_documents d SET created_at = GREATEST(date_trunc('month', now()) + interval '10 hours', now() - (x.n * interval '9 hours'))
    FROM (SELECT id, row_number() OVER (ORDER BY id DESC) AS n FROM business_documents WHERE business_id=$1 AND id = ANY($2::bigint[])) x
    WHERE d.business_id=$1 AND d.id=x.id`);
  // Exchanges: a size swap, a dearer replacement (difference collected), a cheaper one (difference refunded).
  if (await common.legacy(business, 'business_exchanges')) return finish(business, variants, sales);
  const onHand = new Map((await repo.all(ctx.db, 'SELECT sku_id,sum(quantity) AS q FROM business_stock_lots WHERE business_id=$1 GROUP BY sku_id', [business.id])).map((r) => [String(r.sku_id), Number(r.q)]));
  for (const v of variants) v.stock = onHand.get(String(v.sku_id)) || 0;
  const swap = async (n, sale, reason, choose, settlement) => {
    const detail = await service.detail(business, sale.id);
    const line = detail.lines[0];
    const sold = variants.find((v) => String(v.sku_id) === String(line.sku_id));
    const target = sold && variants.find((v) => v.sku_id !== sold.sku_id && choose(v, sold) && Number(v.stock) > 0);
    if (!target) return;
    try {
      await once(business, 'business_exchanges', `fashion-exchange-${n}`, (requestKey) => exchanges.create(business, user, { documentId: sale.id, reason, requestKey,
        returnLines: [{ lineId: line.id, quantity: '1', restock: true }], newLines: [{ skuId: target.sku_id, quantity: '1' }], ...(settlement ? { settlement } : {}) }));
    } catch (error) {
      if (!/stock|credit|days|returned/i.test(error.message)) throw error;
    }
  };
  if (sales[0]) await swap(0, sales[0], 'Size too small', (v, s) => v.product === s.product && v.color === s.color && v.size !== s.size && v.size !== 'XXL' && v.size !== 'XL');
  if (sales[1]) await swap(1, sales[1], 'Wanted the larger size', (v, s) => Number(v.price) > Number(s.price), { method: 'upi', reference: 'UPI-EXCH-01' });
  if (sales[2]) await swap(2, sales[2], 'Prefers a shirt instead', (v, s) => v.product !== s.product && Number(v.price) < Number(s.price), { method: 'cash' });
  return finish(business, variants, sales);
}
function finish(business, variants, sales) {
  console.log(`  ${business.name}: ${variants.length} variants in ${STYLES.length} styles, ${sales.length} sample sales, sample exchanges`);
}

// --- Electronics --------------------------------------------------------------------------

// A valid 15-digit IMEI from a 14-digit body (Luhn check digit).
function imei(body14) {
  const total = [...body14].reduce((sum, c, i) => { let d = Number(c); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } return sum + d; }, 0);
  return body14 + ((10 - (total % 10)) % 10);
}

async function sampleElectronics(business, user) {
  if (business.business_type !== 'electronics' || !business.modules.includes('repairs')) return;
  const ctx = await basics(business, user);
  const [main, centre] = ctx.locations;
  const mobiles = await ctx.category('Mobiles'), tvs = await ctx.category('Televisions'), spares = await ctx.category('Spare parts'), service_ = await ctx.category('Service');
  const item = async (name, code, extra) => (await common.skuByCode(business, code))
    || service.createCatalog(business, user, { name, code, unit: extra.kind === 'service' ? 'service' : 'each', kind: extra.kind || 'goods', tracking: extra.kind === 'service' ? 'none' : extra.tracking || 'quantity',
      price: extra.price, taxRateId: ctx.slab(18), categoryId: extra.category, reorderLevel: extra.kind === 'service' ? '0' : '2' });
  const phone = await item('Nova 5G phone 8/128 GB (demo)', 'PH-NOVA5G', { tracking: 'serial', price: '21999', category: mobiles });
  const tv = await item('Smart LED TV 43 inch (demo)', 'TV-43', { tracking: 'serial', price: '27999', category: tvs });
  const display = await item('Display assembly, Nova 5G', 'SP-DISP', { price: '3200', category: spares });
  const battery = await item('Battery, 5000 mAh', 'SP-BATT', { price: '900', category: spares });
  const port = await item('Charging port board', 'SP-PORT', { price: '450', category: spares });
  const labour = await item('Repair labour', 'SV-LAB', { kind: 'service', price: '300', category: service_ });
  const diagnosis = await item('Diagnosis charge', 'SV-DIAG', { kind: 'service', price: '150', category: service_ });
  await electronics.saveModel(business, user, phone.id, { modelNumber: 'NV5G-8128', serialKind: 'imei', warrantyMonths: 12,
    warrantyTerms: 'One year on manufacturing defects. Physical and liquid damage are not covered. Bring the bill and this card.' });
  await electronics.saveModel(business, user, tv.id, { modelNumber: 'LED43-SM', serialKind: 'serial', warrantyMonths: 24, warrantyTerms: 'Two years on the panel, one year on other parts. Installation by the shop.' });
  const legacyPhone = await common.skuByCode(business, 'PH-128');
  // A phone's numbers are IMEIs, checked when received (pro pass E-23); an
  // older demo whose units carry made-up numbers keeps plain serials.
  const madeUp = legacyPhone ? await repo.one(repo.pool, "SELECT 1 FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code !~ '^[0-9]{15}$' LIMIT 1", [business.id, legacyPhone.id]) : null;
  if (legacyPhone) await electronics.saveModel(business, user, legacyPhone.id, { modelNumber: 'Demo X2', serialKind: madeUp ? 'serial' : 'imei', warrantyMonths: 12, warrantyTerms: 'One year on manufacturing defects.' });

  const stamp = String(business.id).padStart(4, '0').slice(-4);
  const imeis = Array.from({ length: 8 }, (_, i) => imei(`3567${stamp}${String(100 + i).padStart(6, '0')}`));
  const tvSerials = ['LED43SM24A0711', 'LED43SM24A0712', 'LED43SM24A0713'];
  // The handsets and TVs of an earlier version of this script are left as they are, with everything after them.
  if (await common.legacy(business, 'business_documents', "notes='Handsets, TVs and spares (sample)'")) {
    console.log(`  ${business.name}: electronics sample was added earlier`);
    return;
  }
  await once(business, 'business_documents', 'electronics-stock', (requestKey) => service.document(business, user, { kind: 'purchase', locationId: main.id, contactId: ctx.supplier.id, requestKey,
    notes: 'Handsets, TVs and spares (sample)',
    lines: [...imeis.map((code) => ({ skuId: phone.id, quantity: '1', unitPrice: '17200', lotCode: code })),
      ...tvSerials.map((code) => ({ skuId: tv.id, quantity: '1', unitPrice: '22100', lotCode: code })),
      { skuId: display.id, quantity: '4', unitPrice: '2300' }, { skuId: battery.id, quantity: '10', unitPrice: '520' }, { skuId: port.id, quantity: '6', unitPrice: '260' }] }));
  await electronics.saveSerialDetails(business, user, { skuId: phone.id, serial: imeis[0], imei2: imei(`3567${stamp}${String(900).padStart(6, '0')}`), note: 'Dual SIM' });
  // Two handsets to the service centre: one arrived, one still on the way.
  if (centre) {
    const lotOf = async (code) => (await repo.one(ctx.db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3 AND location_id=$4 AND quantity>0', [business.id, phone.id, code, main.id]))?.id;
    const first = await lotOf(imeis[6]);
    if (first) {
      const arrived = await once(business, 'business_stock_transfers', 'electronics-transfer-1', (requestKey) => stock.createTransfer(business, user,
        { fromLocationId: main.id, toLocationId: centre.id, requestKey, notes: 'Demo units for the service centre (sample)', lines: [{ lotId: first, quantity: '1' }] }));
      if (arrived.created) await stock.receiveTransfer(business, user, arrived.row.id);
    }
    const second = await lotOf(imeis[7]);
    if (second) await once(business, 'business_stock_transfers', 'electronics-transfer-2', (requestKey) => stock.createTransfer(business, user,
      { fromLocationId: main.id, toLocationId: centre.id, requestKey, notes: 'Replacement handset (sample)', lines: [{ lotId: second, quantity: '1' }] }));
  }
  // Sales with warranties.
  const buyers = [
    { contact: ctx.customers[2], lines: [{ skuId: phone.id, quantity: '1', lotCode: imeis[0] }] },
    { contact: ctx.customers[3], lines: [{ skuId: phone.id, quantity: '1', lotCode: imeis[1] }, { skuId: battery.id, quantity: '1' }] },
    { contact: null, walkIn: ['Arvind Menon', '99001 23456'], lines: [{ skuId: phone.id, quantity: '1', lotCode: imeis[2] }] },
    { contact: ctx.customers[4], lines: [{ skuId: tv.id, quantity: '1', lotCode: tvSerials[0] }] },
  ];
  const sold = [];
  for (const [n, buyer] of buyers.entries()) {
    const sale = await once(business, 'business_documents', `electronics-sale-${n}`, (requestKey) => service.document(business, user,
      { kind: 'sale', locationId: main.id, contactId: buyer.contact?.id || null, requestKey, lines: buyer.lines,
        payment: buyer.contact ? { amount: '0', method: 'cash' } : { amount: 'full', method: pick(['upi', 'card', 'cash', 'bank'], n) } }));
    await common.pay(business, user, sale.row, `electronics-sale-${n}-paid`, { amount: sale.row.total, method: pick(['upi', 'card', 'cash', 'bank'], n) });
    if (n === 0 && sale.created) await ctx.db.query(`UPDATE business_documents SET created_at = now() - interval '6 days' WHERE business_id=$1 AND id=$2`, [business.id, sale.row.id]);
    sold.push({ sale: sale.row, buyer, n });
  }
  let warranties = 0;
  for (const { sale, buyer, n } of sold) {
    const detail = await service.detail(business, sale.id);
    const line = detail.lines.find((l) => l.lot_code);
    // A walk-in buyer gives a name and phone for the warranty; customers on file
    // without a phone number get one recorded here.
    // A customer on file with a phone had the warranty registered with the sale.
    if (await repo.one(ctx.db, "SELECT 1 FROM electronics_warranties WHERE business_id=$1 AND line_id=$2 AND status='active'", [business.id, line.id])) { warranties += 1; continue; }
    const phone_ = buyer.walkIn?.[1] || buyer.contact?.phone || '90000 00000';
    await once(business, 'electronics_warranties', `electronics-warranty-${n}`, (requestKey) => electronics.register(business, user,
      { lineId: line.id, requestKey, customerName: buyer.walkIn?.[0] || undefined, customerPhone: phone_ }));
    warranties += 1;
  }
  // Repair jobs at different stages (each job's later steps only when the job is new).
  const job = (n, body) => once(business, 'electronics_repair_jobs', `electronics-repair-${n}`, (requestKey) => repairs.intake(business, user, { locationId: main.id, requestKey, ...body }));
  const underWarranty = await job(0, { contactId: ctx.customers[2]?.id, customerPhone: ctx.customers[2]?.phone || '98200 33333', skuId: phone.id, serial: imeis[0],
    problem: 'Display flickers and touch stops responding after a few minutes', accessories: 'Back cover', conditionNotes: 'No scratches', estimate: '0', technician: 'Imran' });
  if (underWarranty.created) {
    const id = underWarranty.row.id;
    await repairs.setStatus(business, user, id, { status: 'diagnosing', note: 'Display connector loose, display needs replacing' });
    await repairs.addLine(business, user, id, { kind: 'part', skuId: display.id, quantity: '1' });
    await repairs.setStatus(business, user, id, { status: 'in_repair' });
  }
  const battery_ = await job(1, { customerName: 'Farida Sheikh', customerPhone: '98450 66221', device: 'Redmi Note 10, grey (customer\'s own)', serial: '864213052211904',
    problem: 'Battery drains within half a day', accessories: 'None', estimate: '1400', technician: 'Imran' });
  if (battery_.created) {
    const id = battery_.row.id;
    await repairs.setStatus(business, user, id, { status: 'in_repair' });
    await repairs.addLine(business, user, id, { kind: 'part', skuId: battery.id, quantity: '1' });
    await repairs.addLine(business, user, id, { kind: 'labour', skuId: labour.id, quantity: '1' });
    await repairs.setStatus(business, user, id, { status: 'ready', note: 'Battery replaced, tested 2 hours' });
  }
  const port_ = await job(2, { customerName: 'Venkatesh Rao', customerPhone: '97400 88123', device: 'Vivo Y20, blue', problem: 'Not charging', accessories: 'Charger', estimate: '800', technician: 'Suresh' });
  if (port_.created) {
    const id = port_.row.id;
    await repairs.setStatus(business, user, id, { status: 'diagnosing' });
    await repairs.addLine(business, user, id, { kind: 'labour', skuId: diagnosis.id, quantity: '1' });
    await repairs.addLine(business, user, id, { kind: 'part', skuId: port.id, quantity: '1' });
    await repairs.addLine(business, user, id, { kind: 'labour', skuId: labour.id, quantity: '1', unitPrice: '250' });
    // Over the estimate: the job waited for the customer's OK (pro pass E-19).
    if ((await repairs.detail(business, id)).status === 'awaiting_approval') await repairs.approval(business, user, id, { decision: 'approved', note: 'Approved by phone' });
    await repairs.setStatus(business, user, id, { status: 'ready' });
    const delivered = await repairs.deliver(business, user, id, { requestKey: common.stableKey(business.id, 'electronics-repair-2-delivered'), payment: { amount: '0', method: 'cash' } });
    const bill = await service.detail(business, delivered.document_id);
    await common.pay(business, user, bill, 'electronics-repair-2-paid', { amount: bill.total, method: 'upi', reference: 'UPI-RPR-01' });
  }
  const dropped = await job(3, { customerName: 'Kavitha Pillai', customerPhone: '94470 55012', device: 'Old tablet, 7 inch', problem: 'Does not switch on', technician: 'Suresh' });
  if (dropped.created) await repairs.cancelJob(business, user, dropped.row.id, { reason: 'Board damaged; repair would cost more than the tablet. Returned to the customer.' });
  await job(4, { customerName: 'Joseph Mathew', customerPhone: '98950 31770', device: 'Smart LED TV 43 inch', serial: tvSerials[0], problem: 'No picture, sound works',
    promisedOn: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) });
  console.log(`  ${business.name}: ${imeis.length} handsets and ${tvSerials.length} TVs received, ${sold.length} sales, ${warranties} warranties, 5 repair jobs`);
}

module.exports = { sampleFashion, sampleElectronics, imei };
