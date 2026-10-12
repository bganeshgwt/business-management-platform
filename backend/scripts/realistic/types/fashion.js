// Rangoli Silks & Fashions, T. Nagar, Chennai: menswear, womenswear and kids'
// wear in sizes and colours, silk and cotton sarees, and dress fabric. Ready-
// made garments pay 5 % GST up to ₹2,500 a piece and 18 % above (the shop's
// price-slab rule); sarees and fabric are textiles at 5 %. The Aadi sale
// (17 Jul–16 Aug) and the Independence Day weekend are the big weeks; the
// fortnight of Mahalaya (Pitru Paksha) is quiet; Deepavali shopping starts.
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const fashion = require('../../../src/modules/business/fashion-electronics/services/businessFashion.service');
const fashionPro = require('../../../src/modules/business/fashion-electronics/services/businessFashionPro.service');
const exchanges = require('../../../src/modules/business/fashion-electronics/services/businessExchanges.service');
const service = require('../../../src/modules/business/core/services/business.service');
const { volume, items, regulars, supplier, gstin } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');
const machine = require('../machine');

const STYLES = [
  { name: 'Formal cotton shirt', brand: 'Kaveri Mills', category: 'Men · Shirts', codePrefix: 'MFS', price: 1299, sizePrices: { XXL: 1399 }, sizes: ['S', 'M', 'L', 'XL', 'XXL'], colors: ['White', 'Sky blue', 'Grey check'], sup: 'tiruppur', w: 5 },
  { name: 'Casual printed shirt', brand: 'Kaveri Mills', category: 'Men · Shirts', codePrefix: 'MCS', price: 999, sizes: ['S', 'M', 'L', 'XL'], colors: ['Navy floral', 'Olive', 'Maroon'], sup: 'tiruppur', w: 4 },
  { name: 'Slim fit chinos', brand: 'Kaveri Mills', category: 'Men · Trousers', codePrefix: 'MCH', price: 1699, sizes: ['30', '32', '34', '36'], colors: ['Khaki', 'Navy', 'Black'], sup: 'tiruppur', w: 3 },
  { name: 'Cotton veshti with zari border', brand: 'Rangoli', category: 'Men · Ethnic', codePrefix: 'MVS', price: 650, sizes: ['Free size'], colors: ['Gold border', 'Silver border'], sup: 'erode', w: 2 },
  { name: 'Anarkali kurti', brand: 'Rangoli Prints', category: 'Women · Kurtis', codePrefix: 'WAK', price: 1499, sizePrices: { XXL: 1599 }, sizes: ['S', 'M', 'L', 'XL', 'XXL'], colors: ['Maroon', 'Mustard', 'Teal'], sup: 'erode', w: 5 },
  { name: 'Cotton straight kurti', brand: 'Rangoli Prints', category: 'Women · Kurtis', codePrefix: 'WSK', price: 799, sizes: ['S', 'M', 'L', 'XL'], colors: ['Indigo', 'Peach', 'Bottle green'], sup: 'erode', w: 6 },
  { name: 'Leggings (cotton lycra)', brand: 'Rangoli', category: 'Women · Bottoms', codePrefix: 'WLG', price: 399, sizes: ['M', 'L', 'XL', 'XXL'], colors: ['Black', 'White', 'Maroon', 'Navy'], sup: 'tiruppur', w: 4 },
  { name: 'Designer lehenga set', brand: 'Rangoli Couture', category: 'Women · Ethnic', codePrefix: 'WLH', price: 4999, sizes: ['S', 'M', 'L'], colors: ['Red', 'Rani pink'], sup: 'surat', w: 0.6 },
  { name: 'Kids kurta pyjama set', brand: 'Little Rangoli', category: 'Kids', codePrefix: 'KKP', price: 899, sizes: ['2-3 Y', '4-5 Y', '6-7 Y', '8-9 Y'], colors: ['Cream', 'Yellow'], sup: 'erode', w: 2.4 },
  { name: 'Girls pattu pavadai', brand: 'Little Rangoli', category: 'Kids', codePrefix: 'KPP', price: 1199, sizes: ['2-3 Y', '4-5 Y', '6-7 Y', '8-9 Y'], colors: ['Green-pink', 'Blue-orange'], sup: 'kanchi', w: 1.6 },
];
// Middle sizes sell most.
const SIZE_SHARE = { S: 0.6, M: 1.3, L: 1.3, XL: 0.9, XXL: 0.5, 30: 0.7, 32: 1.3, 34: 1.2, 36: 0.6, 'Free size': 1, '2-3 Y': 0.8, '4-5 Y': 1.2, '6-7 Y': 1.1, '8-9 Y': 0.8 };

const plainItems = items([
  ['Kanchipuram silk saree (pure zari)', 'SR-KANCHI', 'each', 14500, 5, 'Sarees', 0.5, 'kanchi', { hsn: '5007', margin: 0.32, reorder: 3, target: 10, q: [1, 1] }],
  ['Soft silk saree', 'SR-SOFTSILK', 'each', 4800, 5, 'Sarees', 1.2, 'kanchi', { hsn: '5007', margin: 0.35, reorder: 4, target: 14, q: [1, 1] }],
  ['Chettinad cotton saree', 'SR-CHETTINAD', 'each', 1650, 5, 'Sarees', 2, 'erode', { hsn: '5208', margin: 0.38, reorder: 6, target: 20, q: [1, 2] }],
  ['Printed cotton saree (daily wear)', 'SR-PRINTED', 'each', 650, 5, 'Sarees', 2.4, 'surat', { hsn: '5208', margin: 0.4, reorder: 8, target: 30, q: [1, 2] }],
  ['Cotton dress material (per metre)', 'FB-COTTON', 'metre', 180, 5, 'Fabric', 1.2, 'erode', { hsn: '5208', margin: 0.4, reorder: 20, target: 80, q: [2, 2.5, 3] }],
  ['Blouse lining cloth (per metre)', 'FB-LINING', 'metre', 90, 5, 'Fabric', 0.8, 'erode', { hsn: '5208', margin: 0.45, reorder: 20, target: 60, q: [1, 1.5] }],
]);

async function setup(sim) {
  const when = clock.at(clock.addDays(sim.realToday, -sim.def.days - 1), '11:30');
  const slab = await repo.one(base.db, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=5 AND active ORDER BY id LIMIT 1', [sim.business.id]);
  const categories = {};
  await machine.at(sim.business.id, when, async () => {
    for (const style of STYLES) {
      const [parent, child] = style.category.split(' · ');
      const top = await base.category(sim.business, sim.owner, parent);
      categories[style.category] = child ? await base.category(sim.business, sim.owner, child, top.id) : top;
      if (await repo.one(base.db, 'SELECT 1 FROM catalog_products WHERE business_id=$1 AND name=$2', [sim.business.id, style.name])) continue;
      await fashion.createProduct(sim.business, sim.owner, { name: style.name, brand: style.brand, codePrefix: style.codePrefix, price: String(style.price),
        sizePrices: Object.fromEntries(Object.entries(style.sizePrices || {}).map(([k, v]) => [k, String(v)])), sizes: style.sizes, colors: style.colors,
        taxRateId: slab.id, categoryId: categories[style.category].id, reorderLevel: '1' });
    }
    // Ready-made garments: 5 % up to ₹2,500 a piece, 18 % above. Sarees and fabric stay at 5 %.
    const rule = await repo.one(base.db, 'SELECT active FROM fashion_gst_price_slabs WHERE business_id=$1', [sim.business.id]);
    if (!rule?.active) {
      const garmentCats = await repo.all(base.db, "SELECT id FROM catalog_categories WHERE business_id=$1 AND name IN ('Men','Women','Kids')", [sim.business.id]);
      await fashionPro.saveGstRule(sim.business, sim.owner, { active: true, threshold: '2500', rateLow: '5', rateHigh: '18', categoryIds: garmentCats.map((c) => c.id) });
    }
  }, { keepDates: true });
  // The variants join the shelf: each a sellable item with its size's popularity.
  const supplierOf = (key) => sim.suppliers.find((s) => s.key === key);
  for (const style of STYLES) {
    const product = await repo.one(base.db, 'SELECT id FROM catalog_products WHERE business_id=$1 AND name=$2', [sim.business.id, style.name]);
    const matrix = await fashion.matrix(sim.business, product.id);
    for (const v of matrix.variants) {
      const sku = await repo.one(base.db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND id=$2', [sim.business.id, v.sku_id]);
      const share = SIZE_SHARE[v.size] ?? 1;
      sim.items.push({ ...sku, id: Number(sku.id), kind: 'goods', tracking: 'quantity', price: Number(sku.price), decimals: 0, supplier: supplierOf(style.sup),
        meta: { w: (style.w * share) / style.colors.length, q: [1, 1], margin: 0.5, style: style.name, size: v.size, color: v.color },
        reorder: Math.max(1, Math.round(share * 1.5)), target: Math.max(2, Math.round(share * (style.price > 3000 ? 3 : 7))) });
    }
  }
}

// Exchanges: a size swap (same price), a dearer piece (difference paid), a cheaper one (difference refunded).
async function exchangeSome(sim, day, limit) {
  const r = clock.rng(`${sim.code}|exchange|${day}`);
  if (!r.chance(0.35)) return;
  const minutes = sim.def.open + r.int(60, 240);
  if (minutes > limit) return;
  const candidates = sim.recent.filter((x) => x.day < day && clock.daysBetween(x.day, day) <= 6 && x.plan.lines.some((l) => l.item.meta.style));
  if (!candidates.length) return;
  const sale = r.pick(candidates);
  const detail = await service.detail(sim.business, sale.doc.id);
  const line = detail.lines.find((l) => Number(l.returned_quantity) === 0 && sim.items.find((i) => i.id === Number(l.sku_id))?.meta.style);
  if (!line) return;
  const sold = sim.items.find((i) => i.id === Number(line.sku_id));
  const kind = r.pick(['size', 'size', 'size', 'dearer', 'cheaper']);
  const target = sim.items.filter((i) => i.meta.style && i.id !== sold.id && shop.onHand(sim, i.id) > 0).find((i) => (kind === 'size' ? i.meta.style === sold.meta.style && i.meta.color === sold.meta.color
    : kind === 'dearer' ? i.price > sold.price && i.price - sold.price <= 1200 : i.price < sold.price));
  if (!target) return;
  const reason = kind === 'size' ? r.pick(['Size too small', 'Size too big', 'Fit not right at the shoulders']) : kind === 'dearer' ? 'Liked another design' : 'Wanted a simpler piece';
  const who = shop.actor(sim, 'manager');
  const settlement = target.price === sold.price ? undefined : { method: r.pick(['upi', 'cash']), ...(kind === 'dearer' ? {} : {}) };
  try {
    const result = await shop.post(sim, 'business_exchanges', `exchange-${sale.doc.id}`, clock.at(day, minutes), (requestKey) => exchanges.create(who.business, who.user, {
      documentId: sale.doc.id, reason, requestKey, returnLines: [{ lineId: line.id, quantity: '1', restock: true }], newLines: [{ skuId: target.id, quantity: '1' }],
      ...(settlement ? { settlement } : {}) }));
    if (result.created) {
      const back = shop.lotsOf(sim, sold.id).find((l) => l.code === '');
      if (back) back.qty += 1;
      const out = shop.lotsOf(sim, target.id).find((l) => l.code === '');
      if (out) out.qty -= 1;
    }
  } catch (error) {
    if (!/stock|days|returned|voucher|settle|refund|credit/i.test(error.message)) throw error;
  }
}

const fashionDef = {
  key: 'fashion', type: 'fashion', name: 'Rangoli Silks & Fashions', location: 'T. Nagar showroom',
  legalName: 'Rangoli Silks & Fashions LLP', gstin: gstin('33', 'fashion-shop', 'F', 'R'),
  address: ['No. 41, Ranganathan Street', 'T. Nagar'], city: 'Chennai', pin: '600017', phone: '044-2434 7751', email: 'care@rangolisilks.in',
  receiptFooter: 'Exchange within 7 days with the bill and tags intact. No exchange on sarees cut for blouse.',
  days: 90, open: 10 * 60, close: 21 * 60 + 30, margin: 0.45, regularShare: 0.25, returnRate: 0.002,
  curve: [[10, 3], [11, 5], [12, 6], [13, 5], [14, 4], [15, 4], [16, 6], [17, 8], [18, 10], [19, 10], [20, 8], [21, 3]],
  volume: volume(22, { weekdays: [1.7, 0.8, 0.8, 0.85, 0.9, 1, 1.45], festivals: { '2026-08-14': 1.4, '2026-08-15': 1.8, '2026-08-16': 1.5, '2026-08-21': 1.4, '2026-09-13': 1.3 },
    ranges: [['2026-07-17', '2026-08-16', 1.6], ['2026-09-27', '2026-10-10', 0.55], ['2026-10-04', '2026-10-31', 1.25]], growth: 0.001 }),
  basketSize: (r) => r.weighted([[1, 6], [2, 3], [3, 1]], (x) => x[1])[0],
  pay: { upi: 0.45, card: 0.35, cash: 0.2 },
  staff: [{ name: 'Meenakshi Sundaram', login: 'meenakshi', role: 'manager' }, { name: 'Karthik Raman', login: 'karthik', role: 'cashier' }, { name: 'Janani Pillai', login: 'janani', role: 'cashier' },
    { name: 'Murugan', login: 'murugan', role: 'stock_keeper' }],
  suppliers: [
    supplier('tiruppur', 'Tiruppur Knit Garments', '33', 'f-tiruppur', { prefix: 'TKG', creditDays: 45, days: [2], late: 8, address: 'Avinashi Road, Tiruppur' }),
    supplier('erode', 'Erode Handloom & Textiles', '33', 'f-erode', { prefix: 'EHT', creditDays: 30, days: [4], address: 'Brough Road, Erode' }),
    supplier('kanchi', 'Kanchi Murugan Silk Weavers Co-operative', '33', 'f-kanchi', { prefix: 'KMS', creditDays: 30, days: [5], holder: 'A', address: 'Gandhi Road, Kanchipuram' }),
    supplier('surat', 'Surat Saree & Lehenga House', '24', 'f-surat', { prefix: 'SSL', creditDays: 30, days: [1], lead: 3, address: 'Ring Road, Surat' }),
  ],
  regulars: regulars('tamil', 50, 'fashion', { udhaar: [], visits: (i) => (i < 15 ? 2 : 1) }),
  categories: [['Men'], ['Women'], ['Kids'], ['Sarees'], ['Fabric']],
  items: plainItems,
  modules: [],
  hooks: { setup, afternoon: exchangeSome },
};

module.exports = { fashion: fashionDef };
