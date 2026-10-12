// Shared building blocks for the demo sample data (setup-business-demos.js
// and the type extras demo-*.js). Every step finds what is already there by
// its natural key before creating anything, so the setup can be run again on
// a demo in any state — empty, holding the old one-item placeholder
// ("DEMO-001"), half-written by a run that stopped, or complete — and never
// makes a second copy:
//   - categories, contacts, locations, staff and plans by name; items by code
//     (books by ISBN, which is also their barcode); pack sizes by unit; price
//     slabs by item, unit and quantity;
//   - every posting (purchase, sale, payment, return, collection, order,
//     booking, batch…) by a request key derived from the business and the
//     step's name, so a posting that exists is found and skipped.
// The sample uses only records it made (sample customers and suppliers by
// their fictional names); a tester's own records are never changed or used.
const crypto = require('node:crypto');
const service = require('../src/modules/business/core/services/business.service');
const setup = require('../src/modules/business/core/services/businessSetup.service');
const repo = require('../src/modules/business/core/repositories/business.repository');

// The same step of the same business always gets the same request key. The
// keys start with SAMPLE_PREFIX, so the sample's own postings can be told
// from any other.
const SAMPLE_PREFIX = 'de30de30';
function stableKey(businessId, step) {
  const h = crypto.createHash('sha256').update(`business-demo|${businessId}|${step}`).digest('hex');
  return `${SAMPLE_PREFIX}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// True when `table` holds rows matching `filter` that this sample did not post
// with its keys, and none that it did: that group was made by an earlier
// version of this script (random keys) or by the tester. The group is then
// left out, so nothing is posted twice and nothing is mixed in. (Postings the
// services derive from a sample posting, such as an exchange's new bill, do
// not carry the prefix; once the sample has its own rows in the group, those
// do not count.)
async function legacy(business, table, filter = 'TRUE') {
  if (!KEYED.has(table)) throw new Error(`Not a keyed table: ${table}`);
  const row = await repo.one(repo.pool, `SELECT
    bool_or(request_key IS NULL OR request_key::text NOT LIKE '${SAMPLE_PREFIX}-%') AS other,
    bool_or(request_key::text LIKE '${SAMPLE_PREFIX}-%') AS ours
    FROM ${table} WHERE business_id=$1 AND (${filter})`, [business.id]);
  return Boolean(row?.other) && !row?.ours;
}
// Tables whose rows carry the request key they were posted with.
const KEYED = new Set(['business_documents', 'business_payments', 'business_returns', 'business_collections', 'business_exchanges', 'business_stock_transfers',
  'business_stock_counts', 'electronics_repair_jobs', 'electronics_warranties', 'retail_loyalty_entries', 'salon_appointment_details', 'weight_processing_batches',
  'weight_wastage_entries', 'wholesale_dispatches', 'wholesale_orders']);
// Runs a posting once: returns { row, created }. `row` is the stored row when
// it already existed, else whatever `run(requestKey)` returned.
async function once(business, table, step, run) {
  if (!KEYED.has(table)) throw new Error(`Not a keyed table: ${table}`);
  const requestKey = stableKey(business.id, step);
  const old = await repo.one(repo.pool, `SELECT * FROM ${table} WHERE business_id=$1 AND request_key=$2`, [business.id, requestKey]);
  if (old) return { row: old, created: false };
  return { row: await run(requestKey), created: true };
}

const firstLocation = async (business) => repo.one(repo.pool, 'SELECT * FROM business_locations WHERE business_id=$1 AND active ORDER BY id LIMIT 1', [business.id]);
async function location(business, user, name, code) {
  return (await repo.one(repo.pool, 'SELECT * FROM business_locations WHERE business_id=$1 AND code=$2', [business.id, code]))
    || service.createLocation(business, user, { name, code });
}
async function category(business, user, name, parentId = null) {
  return (await repo.one(repo.pool, 'SELECT * FROM catalog_categories WHERE business_id=$1 AND lower(name)=lower($2) ORDER BY id LIMIT 1', [business.id, name]))
    || setup.createCategory(business, user, { name, ...(parentId ? { parentId } : {}) });
}
async function contact(business, user, kind, name, phone, extra = {}) {
  return (await repo.one(repo.pool, 'SELECT * FROM business_contacts WHERE business_id=$1 AND kind=$2 AND name=$3 ORDER BY id LIMIT 1', [business.id, kind, name]))
    || service.createContact(business, user, { kind, name, phone, ...extra });
}
const skuByCode = async (business, code) => repo.one(repo.pool, `SELECT s.*,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  WHERE s.business_id=$1 AND s.code=$2`, [business.id, code]);
async function packSize(business, user, skuId, unitCode, quantityInBase) {
  if (await repo.one(repo.pool, 'SELECT 1 FROM catalog_sku_units WHERE business_id=$1 AND sku_id=$2 AND unit_code=$3', [business.id, skuId, unitCode])) return;
  await setup.createPackSize(business, user, { skuId, unitCode, quantityInBase: String(quantityInBase) });
}
async function priceRule(business, user, { skuId, unitCode = null, minimumQuantity, unitPrice }) {
  if (await repo.one(repo.pool, `SELECT 1 FROM business_price_rules WHERE business_id=$1 AND sku_id=$2 AND contact_id IS NULL AND unit_code IS NOT DISTINCT FROM $3
    AND minimum_quantity=$4`, [business.id, skuId, unitCode, minimumQuantity])) return;
  await service.createPriceRule(business, user, { skuId, ...(unitCode ? { unitCode } : {}), minimumQuantity: String(minimumQuantity), unitPrice: String(unitPrice) });
}
// Payment of a posted document, once.
// A bill already paid in full at the sale (a walk-in pays it all) is left as it is.
async function pay(business, user, doc, step, body) {
  const due = await repo.one(repo.pool, `SELECT d.total-COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
    -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS due
    FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, doc.id]);
  const old = await repo.one(repo.pool, 'SELECT * FROM business_payments WHERE business_id=$1 AND request_key=$2', [business.id, stableKey(business.id, step)]);
  if (!old && Math.round(Number(due?.due || 0) * 100) <= 0) return { row: null, created: false };
  return once(business, 'business_payments', step, (requestKey) => service.payment(business, user, doc.id, { ...body, requestKey }));
}
// A walk-in pays the whole bill at the sale (pro pass: no udhaar without a customer).
const walkInPays = (contactId, method = 'cash') => (contactId ? {} : { payment: { amount: 'full', method } });
// Moves documents this run created back in time (never a tester's own).
async function backdate(business, ids, sql, extra = []) {
  if (!ids.length) return;
  await repo.pool.query(sql, [business.id, ids, ...extra]);
}
const yymm = () => { const d = new Date(); return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`; };
// A readable batch code with the item's whole code, e.g. B2610-CH-CUR.
const batchCode = (prefix, code) => `${prefix}${yymm()}-${code}`;

// --- The base catalogue of each type ---------------------------------------------------------

// [name, code, unit, price, category, extra]
// GST slabs as revised from 22 Sep 2025 (GST 2.0): biscuits, noodles, corn
// flakes, toothpaste and soap 5 %; exercise books and notebooks nil.
const CATALOGUES = {
  grocery: { categories: [['Staples', ['Rice', 'Atta & flour', 'Dal & pulses']], ['Oils & ghee'], ['Snacks & biscuits'], ['Spices']],
    items: [['Sona Masoori rice', 'RICE-SM', 'kg', 62, 'Rice', { tracking: 'batch', taxRate: 5 }], ['Basmati rice (loose)', 'RICE-BAS', 'kg', 118, 'Rice', { tracking: 'batch', taxRate: 5 }],
      ['Whole wheat atta 5 kg', 'ATTA-5', 'each', 245, 'Atta & flour', { taxRate: 5 }], ['Toor dal', 'DAL-TOOR', 'kg', 148, 'Dal & pulses', { taxRate: 5 }],
      ['Sunflower oil 1 L', 'OIL-SUN1', 'each', 155, 'Oils & ghee', { taxRate: 5, pack: ['box', 12] }], ['Cow ghee 500 ml', 'GHEE-500', 'each', 330, 'Oils & ghee', { taxRate: 5 }],
      ['Glucose biscuits', 'BIS-GLU', 'each', 10, 'Snacks & biscuits', { taxRate: 5, pack: ['box', 24] }], ['Salted peanuts 200 g', 'NUT-PEA', 'each', 45, 'Snacks & biscuits', { taxRate: 5 }],
      ['Turmeric powder 100 g', 'SP-TUR', 'each', 32, 'Spices', { taxRate: 5 }], ['Iodised salt 1 kg', 'SALT-1', 'each', 28, 'Spices', { taxRate: 0 }]] },
  supermarket: { categories: [['Home care'], ['Personal care'], ['Packaged food']], secondLocation: ['Central warehouse', 'WH'],
    items: [['Detergent powder 1 kg', 'HC-DET1', 'each', 180, 'Home care', { taxRate: 18, pack: ['case', 12] }], ['Dishwash bar', 'HC-DISH', 'each', 25, 'Home care', { taxRate: 18 }],
      ['Toothpaste 150 g', 'PC-TP150', 'each', 99, 'Personal care', { taxRate: 5 }], ['Bathing soap (pack of 4)', 'PC-SOAP4', 'each', 160, 'Personal care', { taxRate: 5 }],
      ['Instant noodles', 'PF-NOOD', 'each', 14, 'Packaged food', { taxRate: 5, pack: ['box', 48] }], ['Corn flakes 500 g', 'PF-CORN', 'each', 210, 'Packaged food', { taxRate: 5 }],
      ['Tomato ketchup 1 kg', 'PF-KET', 'each', 135, 'Packaged food', { taxRate: 5 }], ['Green tea (25 bags)', 'PF-TEA', 'each', 175, 'Packaged food', { taxRate: 5 }]] },
  wholesale: { categories: [['Soaps & detergents'], ['Beverages']], secondLocation: ['Godown 2', 'G2'],
    items: [['Bathing soap 100 g', 'WS-SOAP', 'each', 32, 'Soaps & detergents', { taxRate: 18, pack: ['case', 72], rule: [144, 29] }], ['Detergent bar 250 g', 'WS-DBAR', 'each', 22, 'Soaps & detergents', { taxRate: 18, pack: ['case', 100], rule: [200, 19.5] }],
      ['Tea dust 1 kg', 'WS-TEA', 'each', 420, 'Beverages', { taxRate: 5, rule: [20, 395] }], ['Instant coffee 200 g', 'WS-COF', 'each', 510, 'Beverages', { taxRate: 18 }]] },
  fashion: { categories: [['Men', ['Shirts', 'Trousers']], ['Women', ['Kurtis']]],
    items: [['Cotton shirt', 'SH-BL-M', 'each', 899, 'Shirts', { taxRate: 5, label: 'Cotton shirt · Blue / M', attributes: { size: 'M', color: 'Blue', fabric: 'Cotton' } }],
      ['Linen trousers', 'TR-BG-32', 'each', 1499, 'Trousers', { taxRate: 5, label: 'Linen trousers · Beige / 32', attributes: { size: '32', color: 'Beige', fabric: 'Linen' } }],
      ['Printed kurti', 'KU-MAR-L', 'each', 1199, 'Kurtis', { taxRate: 5, label: 'Printed kurti · Maroon / L', attributes: { size: 'L', color: 'Maroon', fabric: 'Rayon' } }],
      ['Cotton fabric (by metre)', 'FAB-COT', 'metre', 180, 'Women', { taxRate: 5 }]] },
  electronics: { categories: [['Mobiles'], ['Accessories']], secondLocation: ['Service centre', 'SC'],
    items: [['Smartphone 128 GB', 'PH-128', 'each', 18999, 'Mobiles', { taxRate: 18, tracking: 'serial', attributes: { model: 'Demo X2', warrantyMonths: '12' } }],
      ['Bluetooth earbuds', 'AC-EAR', 'each', 1999, 'Accessories', { taxRate: 18 }], ['Fast charger 25 W', 'AC-CHG', 'each', 899, 'Accessories', { taxRate: 18 }],
      ['USB-C cable 1 m', 'AC-CAB', 'each', 299, 'Accessories', { taxRate: 18, pack: ['box', 20] }]] },
  pharmacy: { categories: [['Tablets'], ['Syrups'], ['First aid']], secondLocation: ['Branch — Station Road', 'STN'],
    items: [['Paracetamol 500 mg (demo)', 'PCM-500', 'tablet', 2, 'Tablets', { taxRate: 5, tracking: 'batch', pack: ['strip', 10], attributes: { manufacturer: 'Fictional Pharma' } }],
      ['Cough syrup 100 ml (demo)', 'CS-100', 'bottle', 115, 'Syrups', { taxRate: 5, tracking: 'batch' }], ['Antiseptic liquid 500 ml', 'FA-ANT', 'bottle', 245, 'First aid', { taxRate: 18, tracking: 'batch' }],
      ['Bandage roll', 'FA-BAN', 'each', 40, 'First aid', { taxRate: 5, tracking: 'batch' }]] },
  books: { categories: [['Books', ['Fiction', 'Exam guides']], ['Stationery']],
    items: [['The Monsoon Letters (novel)', 'BK-MON', 'each', 399, 'Fiction', { taxRate: 0, attributes: { isbn: '978-0-00-000001-1', author: 'A. Fictional', publisher: 'Demo Press' } }],
      ['Class 10 mathematics guide', 'BK-M10', 'each', 450, 'Exam guides', { taxRate: 0, attributes: { isbn: '978-0-00-000002-8', publisher: 'Demo Press' } }],
      ['Ruled notebook 200 pages', 'ST-NB200', 'each', 60, 'Stationery', { taxRate: 0, pack: ['dozen', 12] }], ['Gel pen (blue)', 'ST-GEL', 'each', 15, 'Stationery', { taxRate: 18, pack: ['box', 10] }]] },
  salon: { categories: [['Hair'], ['Skin'], ['Retail products']], resources: [['Priya', 'Senior stylist'], ['Arjun', 'Stylist'], ['Spa room 1', 'Room']],
    items: [['Haircut', 'SV-CUT', 'service', 350, 'Hair', { kind: 'service', taxRate: 18 }], ['Hair spa', 'SV-SPA', 'service', 1200, 'Hair', { kind: 'service', taxRate: 18 }],
      ['Classic facial', 'SV-FAC', 'service', 1500, 'Skin', { kind: 'service', taxRate: 18 }], ['Argan hair oil 100 ml', 'RT-OIL', 'each', 650, 'Retail products', { taxRate: 18 }]] },
  healthcare: { categories: [['Consultations'], ['Lab tests']], resources: [['Dr. Meera Rao', 'General physician'], ['Dr. Karan Shah', 'Paediatrician'], ['Sample room', 'Room']],
    items: [['General consultation', 'CN-GEN', 'service', 500, 'Consultations', { kind: 'service', taxRate: 0 }], ['Follow-up visit', 'CN-FUP', 'service', 300, 'Consultations', { kind: 'service', taxRate: 0 }],
      ['Complete blood count', 'LB-CBC', 'service', 350, 'Lab tests', { kind: 'service', taxRate: 0 }], ['Fasting blood sugar', 'LB-FBS', 'service', 120, 'Lab tests', { kind: 'service', taxRate: 0 }]] },
  meat: { categories: [['Chicken'], ['Mutton'], ['Fish']],
    items: [['Chicken curry cut', 'CH-CUR', 'kg', 260, 'Chicken', { taxRate: 0, tracking: 'batch' }], ['Boneless chicken', 'CH-BNL', 'kg', 380, 'Chicken', { taxRate: 0, tracking: 'batch' }],
      ['Mutton curry cut', 'MT-CUR', 'kg', 780, 'Mutton', { taxRate: 0, tracking: 'batch' }], ['Rohu fish', 'FS-ROH', 'kg', 240, 'Fish', { taxRate: 0, tracking: 'batch' }]] },
  weight_retail: { categories: [['Dry fruits'], ['Spices (loose)']],
    items: [['Almonds', 'DF-ALM', 'kg', 820, 'Dry fruits', { taxRate: 5, tracking: 'batch' }], ['Cashews W240', 'DF-CAS', 'kg', 980, 'Dry fruits', { taxRate: 5, tracking: 'batch' }],
      ['Raisins', 'DF-RAI', 'kg', 360, 'Dry fruits', { taxRate: 5, tracking: 'batch' }], ['Black pepper', 'SP-PEP', 'kg', 720, 'Spices (loose)', { taxRate: 5, tracking: 'batch' }]] },
};
const CUSTOMERS = [['Ramesh Kirana Stores', '98200 11111', { creditLimit: '25000', creditDays: 15 }], ['Hotel Annapurna', '98200 22222', { gstin: '27AAPFU0939F1ZV', creditDays: 30 }],
  ['Sunita Deshpande', '98200 33333', {}], ['Mohammed Irfan', '98200 44444', {}], ['Lakshmi Iyer', '98200 55555', {}]];
const SUPPLIERS = [['Agarwal Traders', '98300 11111', { creditDays: 21 }], ['Shree Ganesh Distributors', '98300 22222', { creditDays: 15 }]];

// The type's base categories and items (with pack sizes and price slabs):
// found or created. Returns { categoryIds: {name: id}, skus: [...] }.
async function baseCatalogue(business, user) {
  const plan = CATALOGUES[business.business_type];
  if (!plan) return { categoryIds: {}, skus: [] };
  const categoryIds = {};
  for (const [name, children = []] of plan.categories) {
    const parent = await category(business, user, name);
    categoryIds[name] = Number(parent.id);
    for (const child of children) categoryIds[child] = Number((await category(business, user, child, parent.id)).id);
  }
  const slabs = await repo.all(repo.pool, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active ORDER BY id', [business.id]);
  const skus = [];
  for (const [name, code, unit, price, categoryName, extra] of plan.items) {
    const kind = extra.kind || 'goods';
    let sku = await skuByCode(business, code);
    if (!sku) {
      const slab = slabs.find((s) => Number(s.rate) === Number(extra.taxRate ?? 0));
      sku = await service.createCatalog(business, user, { name, label: extra.label, code, kind, unit, tracking: kind === 'service' ? 'none' : extra.tracking || 'quantity',
        price: String(price), taxRateId: slab?.id, categoryId: categoryIds[categoryName], attributes: extra.attributes, reorderLevel: kind === 'goods' ? (unit === 'kg' ? '5' : '10') : '0' });
    }
    if (extra.pack) await packSize(business, user, sku.id, extra.pack[0], extra.pack[1]);
    if (extra.rule) await priceRule(business, user, { skuId: sku.id, minimumQuantity: extra.rule[0], unitPrice: extra.rule[1] });
    skus.push({ ...sku, kind, extra });
  }
  return { categoryIds, skus };
}
// The sample customers and suppliers, found or created by name.
async function sampleCustomers(business, user) {
  const list = [];
  for (const [name, phone, extra] of CUSTOMERS) list.push(await contact(business, user, 'customer', name, phone, extra));
  return list;
}
async function sampleSupplier(business, user, index = 0) {
  const [name, phone, extra] = SUPPLIERS[index];
  return contact(business, user, 'supplier', name, phone, extra);
}

module.exports = { stableKey, legacy, once, pay, walkInPays, backdate, batchCode, firstLocation, location, category, contact, skuByCode, packSize, priceRule,
  CATALOGUES, CUSTOMERS, SUPPLIERS, baseCatalogue, sampleCustomers, sampleSupplier };
