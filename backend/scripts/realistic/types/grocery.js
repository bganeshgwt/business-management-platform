// Kirana (grocery) and supermarket. GST as revised on 22 Sep 2025 (GST 2.0):
// packaged staples, oils, ghee, tea, biscuits, soaps, toothpaste and hair oil
// 5 %; loose unbranded grains, salt, milk, eggs, bread and paneer nil;
// detergents and cleaners 18 %; aerated drinks 40 %. Shelf prices include GST
// and never exceed the printed MRP.
const { volume, items, regulars, supplier, gstin } = require('./common');

const HYD_FESTIVALS = { '2026-07-19': 1.25, '2026-07-26': 1.25, '2026-08-02': 1.2, '2026-08-09': 1.2, '2026-08-15': 1.1, '2026-08-20': 1.3, '2026-08-21': 1.35,
  '2026-08-27': 1.2, '2026-08-28': 1.15, '2026-09-03': 1.15, '2026-09-12': 1.3, '2026-09-13': 1.6, '2026-09-14': 1.25, '2026-10-02': 1.1 };

// --- Sri Lakshmi Kirana & General Stores, KPHB Colony, Hyderabad -------------------------------

const kiranaItems = items([
  // Rice, atta & flours
  ['Sona Masoori raw rice (loose)', 'RICE-SM-L', 'kg', 58, 0, 'Rice', 9, 'rice', { loose: true, hsn: '1006', q: [1, 5], reorder: 60, target: 220 }],
  ['Sona Masoori rice 25 kg bag', 'RICE-SM-25', 'each', 1650, 5, 'Rice', 1.2, 'rice', { hsn: '1006', q: [1, 1], reorder: 4, target: 14, margin: 0.06 }],
  ['Basmati rice 1 kg', 'RICE-BAS-1', 'each', 165, 5, 'Rice', 1.4, 'rice', { hsn: '1006', reorder: 8, target: 30 }],
  ['Idli rava 1 kg', 'RAVA-IDLI', 'each', 62, 5, 'Atta & flours', 2, 'rice', { hsn: '1103', reorder: 8, target: 30 }],
  ['Chakki fresh atta 5 kg', 'ATTA-5', 'each', 285, 5, 'Atta & flours', 3, 'fmcg', { hsn: '1101', reorder: 8, target: 30 }],
  ['Maida 1 kg', 'MAIDA-1', 'each', 52, 5, 'Atta & flours', 1.2, 'rice', { hsn: '1101', reorder: 6, target: 24 }],
  ['Besan 500 g', 'BESAN-500', 'each', 68, 5, 'Atta & flours', 1.4, 'rice', { hsn: '1106', reorder: 6, target: 24 }],
  // Dal & pulses
  ['Toor dal (loose)', 'DAL-TOOR-L', 'kg', 148, 0, 'Dal & pulses', 5, 'rice', { loose: true, hsn: '0713', q: [0.5, 2], reorder: 20, target: 70 }],
  ['Moong dal (loose)', 'DAL-MOONG-L', 'kg', 128, 0, 'Dal & pulses', 2, 'rice', { loose: true, hsn: '0713', q: [0.25, 1], reorder: 10, target: 35 }],
  ['Chana dal (loose)', 'DAL-CHANA-L', 'kg', 92, 0, 'Dal & pulses', 2, 'rice', { loose: true, hsn: '0713', q: [0.25, 1], reorder: 10, target: 35 }],
  ['Urad dal (loose)', 'DAL-URAD-L', 'kg', 135, 0, 'Dal & pulses', 2.2, 'rice', { loose: true, hsn: '0713', q: [0.5, 1], reorder: 10, target: 35 }],
  ['Rajma 500 g', 'RAJMA-500', 'each', 95, 5, 'Dal & pulses', 0.6, 'rice', { hsn: '0713', reorder: 4, target: 15 }],
  // Oil & ghee
  ['Refined sunflower oil 1 L pouch', 'OIL-SUN-1', 'each', 165, 5, 'Oil & ghee', 6, 'oil', { hsn: '1512', q: [1, 2], reorder: 30, target: 110, pack: ['box', 10], margin: 0.07 }],
  ['Refined sunflower oil 5 L can', 'OIL-SUN-5', 'each', 799, 5, 'Oil & ghee', 1.2, 'oil', { hsn: '1512', q: [1, 1], reorder: 4, target: 14, margin: 0.06 }],
  ['Groundnut oil 1 L', 'OIL-GN-1', 'each', 210, 5, 'Oil & ghee', 1.6, 'oil', { hsn: '1508', reorder: 8, target: 30 }],
  ['Cow ghee 500 ml', 'GHEE-500', 'each', 345, 5, 'Oil & ghee', 1.3, 'oil', { hsn: '0405', reorder: 5, target: 20 }],
  // Sugar, salt & jaggery
  ['Sugar (loose)', 'SUGAR-L', 'kg', 46, 5, 'Sugar, salt & jaggery', 5, 'rice', { loose: true, hsn: '1701', q: [1, 3], reorder: 30, target: 110 }],
  ['Iodised salt 1 kg', 'SALT-1', 'each', 28, 0, 'Sugar, salt & jaggery', 3, 'fmcg', { hsn: '2501', reorder: 15, target: 60 }],
  ['Jaggery 1 kg', 'JAGGERY-1', 'each', 75, 0, 'Sugar, salt & jaggery', 1.2, 'rice', { hsn: '1701', reorder: 5, target: 20 }],
  // Masala & spices
  ['Turmeric powder 100 g', 'SP-TURMERIC', 'each', 36, 5, 'Masala & spices', 2.2, 'masala', { hsn: '0910', reorder: 10, target: 40 }],
  ['Red chilli powder 200 g', 'SP-CHILLI', 'each', 92, 5, 'Masala & spices', 2, 'masala', { hsn: '0904', reorder: 8, target: 30 }],
  ['Coriander powder 200 g', 'SP-DHANIA', 'each', 64, 5, 'Masala & spices', 1.4, 'masala', { hsn: '0909', reorder: 6, target: 24 }],
  ['Garam masala 50 g', 'SP-GARAM', 'each', 58, 5, 'Masala & spices', 1.2, 'masala', { hsn: '0910', reorder: 6, target: 24 }],
  ['Mustard seeds 100 g', 'SP-MUSTARD', 'each', 22, 5, 'Masala & spices', 1.6, 'masala', { hsn: '1207', reorder: 8, target: 30 }],
  ['Jeera 100 g', 'SP-JEERA', 'each', 65, 5, 'Masala & spices', 1.6, 'masala', { hsn: '0909', reorder: 8, target: 30 }],
  ['Tamarind 500 g', 'SP-TAMARIND', 'each', 90, 5, 'Masala & spices', 1.2, 'masala', { hsn: '0813', reorder: 5, target: 20 }],
  // Tea & coffee
  ['Tea powder 250 g', 'TEA-250', 'each', 145, 5, 'Tea & coffee', 3.5, 'fmcg', { hsn: '0902', reorder: 10, target: 40 }],
  ['Filter coffee powder 200 g', 'COFFEE-F200', 'each', 160, 5, 'Tea & coffee', 1.2, 'fmcg', { hsn: '0901', reorder: 5, target: 20 }],
  ['Instant coffee 50 g jar', 'COFFEE-I50', 'each', 185, 5, 'Tea & coffee', 0.8, 'fmcg', { hsn: '2101', reorder: 4, target: 15 }],
  // Biscuits & snacks
  ['Glucose biscuits 75 g', 'BIS-GLU', 'each', 10, 5, 'Biscuits & snacks', 7, 'fmcg', { hsn: '1905', q: [1, 4], reorder: 48, target: 192, pack: ['box', 48], margin: 0.1 }],
  ['Cream biscuits 120 g', 'BIS-CREAM', 'each', 30, 5, 'Biscuits & snacks', 3, 'fmcg', { hsn: '1905', q: [1, 3], reorder: 24, target: 96, pack: ['box', 24] }],
  ['Salted potato chips 52 g', 'SNK-CHIPS', 'each', 20, 5, 'Biscuits & snacks', 4, 'fmcg', { hsn: '2005', q: [1, 3], reorder: 24, target: 96, pack: ['box', 24] }],
  ['Mixture namkeen 200 g', 'SNK-MIX', 'each', 55, 5, 'Biscuits & snacks', 2, 'fmcg', { hsn: '2106', reorder: 10, target: 40 }],
  ['Milk rusk 300 g', 'SNK-RUSK', 'each', 60, 5, 'Biscuits & snacks', 1.6, 'fmcg', { hsn: '1905', reorder: 8, target: 30 }],
  // Breakfast & noodles
  ['Instant noodles 70 g', 'NOOD-70', 'each', 15, 5, 'Breakfast & noodles', 4, 'fmcg', { hsn: '1902', q: [1, 4], reorder: 48, target: 192, pack: ['box', 48], margin: 0.1 }],
  ['Poha (thick) 500 g', 'POHA-500', 'each', 48, 5, 'Breakfast & noodles', 1.4, 'rice', { hsn: '1904', reorder: 6, target: 24 }],
  ['Roasted vermicelli 400 g', 'VERMI-400', 'each', 55, 5, 'Breakfast & noodles', 1, 'fmcg', { hsn: '1902', reorder: 6, target: 24 }],
  ['Corn flakes 475 g', 'CORN-475', 'each', 199, 5, 'Breakfast & noodles', 0.6, 'fmcg', { hsn: '1904', reorder: 3, target: 12 }],
  // Dairy, bread & eggs
  ['Toned milk 500 ml', 'MILK-500', 'each', 28, 0, 'Dairy, bread & eggs', 14, 'dairy', { hsn: '0401', q: [1, 3], reorder: 40, target: 120, margin: 0.06 }],
  ['Curd 400 g cup', 'CURD-400', 'each', 40, 5, 'Dairy, bread & eggs', 4, 'dairy', { hsn: '0403', q: [1, 2], reorder: 15, target: 40 }],
  ['Fresh paneer 200 g', 'PANEER-200', 'each', 90, 0, 'Dairy, bread & eggs', 1.4, 'dairy', { hsn: '0406', reorder: 5, target: 15 }],
  ['Milk bread 400 g', 'BREAD-400', 'each', 45, 0, 'Dairy, bread & eggs', 5, 'dairy', { hsn: '1905', reorder: 12, target: 36 }],
  ['Eggs (tray of 30)', 'EGG-30', 'each', 195, 0, 'Dairy, bread & eggs', 1.6, 'dairy', { loose: true, hsn: '0407', q: [1, 1], reorder: 5, target: 15 }],
  ['Eggs (each)', 'EGG-1', 'each', 7, 0, 'Dairy, bread & eggs', 5, 'dairy', { loose: true, hsn: '0407', q: [4, 12], reorder: 60, target: 210 }],
  // Soaps & personal care
  ['Bathing soap 100 g (pack of 4)', 'SOAP-4', 'each', 180, 5, 'Soaps & personal care', 2, 'fmcg', { hsn: '3401', reorder: 8, target: 30 }],
  ['Toothpaste 150 g', 'TP-150', 'each', 105, 5, 'Soaps & personal care', 2, 'fmcg', { hsn: '3306', reorder: 8, target: 30 }],
  ['Coconut hair oil 200 ml', 'HOIL-200', 'each', 110, 5, 'Soaps & personal care', 1.6, 'fmcg', { hsn: '3305', reorder: 6, target: 24 }],
  ['Shampoo sachets (strip of 16)', 'SHAMPOO-STRIP', 'each', 32, 5, 'Soaps & personal care', 2, 'fmcg', { hsn: '3305', reorder: 10, target: 40 }],
  // Household & cleaning
  ['Detergent powder 1 kg', 'DET-1', 'each', 125, 18, 'Household & cleaning', 2.4, 'fmcg', { hsn: '3402', reorder: 10, target: 40 }],
  ['Dishwash bar 200 g', 'DISH-BAR', 'each', 20, 18, 'Household & cleaning', 3, 'fmcg', { hsn: '3402', q: [1, 3], reorder: 20, target: 72 }],
  ['Floor cleaner 500 ml', 'FLOOR-500', 'each', 105, 18, 'Household & cleaning', 1, 'fmcg', { hsn: '3402', reorder: 4, target: 15 }],
  ['Mosquito coil (pack of 10)', 'COIL-10', 'each', 45, 18, 'Household & cleaning', 1.2, 'fmcg', { hsn: '3808', reorder: 6, target: 24 }],
  ['Safety matches (pack of 10)', 'MATCH-10', 'each', 20, 5, 'Household & cleaning', 1.6, 'masala', { hsn: '3605', reorder: 8, target: 30 }],
  // Pooja items
  ['Agarbatti 100 g', 'POOJA-AGAR', 'each', 60, 5, 'Pooja items', 1.6, 'masala', { hsn: '3307', reorder: 6, target: 24 }],
  ['Camphor tablets 50 g', 'POOJA-CAMPHOR', 'each', 70, 5, 'Pooja items', 1, 'masala', { hsn: '2914', reorder: 5, target: 20 }],
  ['Deepam oil 1 L', 'POOJA-OIL', 'each', 180, 5, 'Pooja items', 1, 'oil', { hsn: '1515', reorder: 5, target: 20 }],
  // Water & cold drinks
  ['Packaged drinking water 1 L', 'WATER-1', 'each', 20, 5, 'Water & cold drinks', 3, 'fmcg', { hsn: '2201', q: [1, 2], reorder: 24, target: 96, pack: ['box', 12] }],
  ['Cola 750 ml', 'COLA-750', 'each', 40, 40, 'Water & cold drinks', 1.6, 'fmcg', { hsn: '2202', reorder: 12, target: 48, pack: ['box', 24] }],
]);

const kiranaRegulars = regulars('telugu', 34, 'kirana', {
  udhaar: ['ontime', 'late', 'ontime', 'ontime', 'chronic', 'ontime', 'late', 'ontime', null, 'ontime', null, 'late', 'ontime', null, 'chronic', 'ontime'],
  limit: (i, kind) => (kind === 'chronic' ? 12000 : kind === 'late' ? 8000 : 6000), days: (i, kind) => (kind === 'ontime' ? 15 : 30),
  visits: (i) => (i < 16 ? 3 : 1.5),
  extra: (i) => (i === 4 ? { openingBalance: '3450', openingBalanceOn: '2026-06-30', address: 'Flat 302, Sai Residency, KPHB 5th Phase' }
    : i === 1 ? { openingBalance: '1280', openingBalanceOn: '2026-07-05', address: 'Plot 77, KPHB 4th Phase' } : i === 0 ? { address: 'H.No. 15-31, Road No. 2, KPHB Colony' } : {}),
}).concat(regulars('hyderabadi', 6, 'kirana-h').map((c, i) => ({ ...c, key: `h${i + 1}` })));

const kirana = {
  key: 'kirana', type: 'grocery', name: 'Sri Lakshmi Kirana & General Stores', location: 'KPHB Colony store',
  legalName: 'Sri Lakshmi Kirana & General Stores (Prop. K. Srinivas Rao)', gstin: gstin('36', 'kirana-shop', 'P', 'R'),
  address: ['Shop No. 4, Plot 112, Road No. 3', 'KPHB Colony, Kukatpally'], city: 'Hyderabad', pin: '500072', phone: '040-2305 4417', email: 'srilakshmikirana.kphb@gmail.com',
  receiptFooter: 'Home delivery above ₹500 in KPHB. UPI accepted. Thank you!',
  days: 90, open: 7 * 60, close: 22 * 60, margin: 0.12, regularShare: 0.38,
  curve: [[7, 6], [8, 9], [9, 8], [10, 6], [11, 4], [12, 3], [13, 2], [14, 2], [15, 2], [16, 4], [17, 7], [18, 9], [19, 10], [20, 8], [21, 4]],
  volume: volume(42, { weekdays: [1.3, 0.95, 0.95, 0.95, 1, 1.05, 1.15], monthStart: 1.15, festivals: HYD_FESTIVALS, ranges: [['2026-10-01', '2026-10-07', 1.12]], growth: 0.001 }),
  basketSize: (r, regular) => (regular && r.chance(0.25) ? r.int(8, 16) : r.int(1, 4)),
  pay: { upi: 0.56, cash: 0.38, card: 0.06 },
  // Round 2 (R2-CORE): till PINs and bills paid several ways.
  hooks: { async today(sim, today) { await round2.tillPins(sim); await round2.splitBills(sim, today); } },
  staff: [{ name: 'Lakshmi Prasanna', login: 'lakshmi', role: 'manager' }, { name: 'Ramesh Goud', login: 'ramesh', role: 'cashier' }, { name: 'Anil Kumar', login: 'anil', role: 'stock_keeper' }],
  suppliers: [
    supplier('rice', 'Venkateshwara Rice & Dal Traders', '36', 'k-rice', { prefix: 'VRT', creditDays: 15, days: [1, 4], address: '21-1-512, Begum Bazaar, Hyderabad' }),
    supplier('fmcg', 'Sri Balaji FMCG Agencies', '36', 'k-fmcg', { prefix: 'SBA', creditDays: 7, days: [2, 5], address: 'Plot 9, Balanagar Industrial Area, Hyderabad' }),
    supplier('oil', 'Laxmi Oil & Ghee Depot', '36', 'k-oil', { prefix: 'LOG', creditDays: 10, days: [6], late: 4, address: 'Siddiamber Bazaar, Hyderabad' }),
    supplier('dairy', 'Sri Krishna Milk & Dairy Agency', '36', 'k-dairy', { prefix: 'SKD', creditDays: 1, method: 'cash', holder: 'P', address: 'KPHB 6th Phase, Hyderabad' }),
    supplier('masala', 'Ganesh Masala & Pooja Stores', '36', 'k-masala', { prefix: 'GMP', creditDays: 30, days: [3], late: 7, address: 'Osmangunj, Hyderabad' }),
  ],
  regulars: kiranaRegulars,
  categories: [['Rice'], ['Atta & flours'], ['Dal & pulses'], ['Oil & ghee'], ['Sugar, salt & jaggery'], ['Masala & spices'], ['Tea & coffee'], ['Biscuits & snacks'],
    ['Breakfast & noodles'], ['Dairy, bread & eggs'], ['Soaps & personal care'], ['Household & cleaning'], ['Pooja items'], ['Water & cold drinks']],
  items: kiranaItems,
  offers: (ids, cats, rel) => [
    { name: 'Monthly ration: ₹50 off on ₹2,500 and above', kind: 'bill_amount', value: '50', minBillAmount: '2500', startsOn: rel(-85) },
    { name: 'Salt: buy 2 get 1 free', kind: 'buy_x_get_y', skuId: ids['SALT-1'], buyQuantity: '2', getQuantity: '1', value: '100', startsOn: rel(-60), endsOn: rel(-30) },
    { name: 'Navratri: ghee ₹25 off', kind: 'item_amount', skuId: ids['GHEE-500'], value: '25', startsOn: rel(0), endsOn: rel(13) },
  ],
  loyalty: null,
  modules: ['offers'],
};

// --- Sai Annapurna Super Bazaar, Jayanagar, Bengaluru -------------------------------------------------

const BLR_FESTIVALS = { '2026-08-15': 1.15, '2026-08-20': 1.3, '2026-08-21': 1.4, '2026-08-27': 1.15, '2026-09-03': 1.15, '2026-09-12': 1.3, '2026-09-13': 1.55, '2026-09-14': 1.2 };
const off = (mrp, pct) => Math.floor(mrp * (1 - pct / 100));
const superItems = items([
  ['Sona Masoori rice 5 kg', 'S-RICE-5', 'each', 385, 5, 'Staples', 3, 'staples', { hsn: '1006', price: off(385, 6), reorder: 15, target: 60 }],
  ['Basmati rice 1 kg', 'S-BAS-1', 'each', 175, 5, 'Staples', 2, 'staples', { hsn: '1006', price: off(175, 8), reorder: 10, target: 40 }],
  ['Whole wheat atta 5 kg', 'S-ATTA-5', 'each', 289, 5, 'Staples', 3, 'staples', { hsn: '1101', price: off(289, 7), reorder: 15, target: 60 }],
  ['Toor dal 1 kg', 'S-TOOR-1', 'each', 172, 5, 'Staples', 3, 'staples', { hsn: '0713', price: off(172, 5), reorder: 15, target: 60 }],
  ['Moong dal 500 g', 'S-MOONG-500', 'each', 82, 5, 'Staples', 1.5, 'staples', { hsn: '0713', reorder: 10, target: 40 }],
  ['Sugar 1 kg', 'S-SUGAR-1', 'each', 52, 5, 'Staples', 3, 'staples', { hsn: '1701', price: 49, reorder: 20, target: 80 }],
  ['Sunflower oil 1 L', 'S-OIL-1', 'each', 165, 5, 'Staples', 4, 'staples', { hsn: '1512', price: off(165, 6), reorder: 20, target: 90, pack: ['case', 12] }],
  ['Cow ghee 1 L', 'S-GHEE-1', 'each', 675, 5, 'Staples', 1, 'staples', { hsn: '0405', price: off(675, 5), reorder: 5, target: 20 }],
  ['Onion', 'S-ONION', 'kg', 38, 0, 'Fruits & vegetables', 5, 'veg', { loose: true, hsn: '0703', q: [0.5, 2], reorder: 25, target: 90, shelfless: true }],
  ['Tomato', 'S-TOMATO', 'kg', 32, 0, 'Fruits & vegetables', 5, 'veg', { loose: true, hsn: '0702', q: [0.5, 2], reorder: 20, target: 70 }],
  ['Potato', 'S-POTATO', 'kg', 34, 0, 'Fruits & vegetables', 4, 'veg', { loose: true, hsn: '0701', q: [0.5, 2], reorder: 20, target: 70 }],
  ['Banana (robusta)', 'S-BANANA', 'kg', 48, 0, 'Fruits & vegetables', 3, 'veg', { loose: true, hsn: '0803', q: [0.5, 1.5], reorder: 10, target: 35 }],
  ['Apple (Shimla)', 'S-APPLE', 'kg', 180, 0, 'Fruits & vegetables', 1.5, 'veg', { loose: true, hsn: '0808', q: [0.5, 1], reorder: 8, target: 25 }],
  ['Fresh paneer 200 g', 'S-PANEER', 'each', 95, 0, 'Dairy & bakery', 2, 'dairy', { hsn: '0406', tracking: 'batch', shelf: 7, reorder: 10, target: 30 }],
  ['Curd 400 g', 'S-CURD', 'each', 42, 5, 'Dairy & bakery', 3, 'dairy', { hsn: '0403', tracking: 'batch', shelf: 5, reorder: 15, target: 45 }],
  ['Butter 100 g', 'S-BUTTER', 'each', 58, 5, 'Dairy & bakery', 1.6, 'dairy', { hsn: '0405', tracking: 'batch', shelf: 90, reorder: 10, target: 40 }],
  ['Cheese slices 200 g', 'S-CHEESE', 'each', 155, 5, 'Dairy & bakery', 0.8, 'dairy', { hsn: '0406', tracking: 'batch', shelf: 120, reorder: 6, target: 24 }],
  ['Milk bread 400 g', 'S-BREAD', 'each', 45, 0, 'Dairy & bakery', 3, 'dairy', { hsn: '1905', tracking: 'batch', shelf: 4, reorder: 12, target: 36 }],
  ['Fruit yoghurt 100 g', 'S-YOG', 'each', 30, 5, 'Dairy & bakery', 1.2, 'dairy', { hsn: '0403', tracking: 'batch', shelf: 15, reorder: 12, target: 40 }],
  ['Frozen green peas 500 g', 'S-PEAS', 'each', 120, 5, 'Frozen', 0.8, 'dairy', { hsn: '0710', price: off(120, 8), reorder: 6, target: 24 }],
  ['Glucose biscuits 250 g', 'S-BIS-GLU', 'each', 30, 5, 'Snacks & biscuits', 3, 'fmcg', { hsn: '1905', reorder: 24, target: 96 }],
  ['Digestive biscuits 250 g', 'S-BIS-DIG', 'each', 65, 5, 'Snacks & biscuits', 1.5, 'fmcg', { hsn: '1905', reorder: 12, target: 48 }],
  ['Potato chips 90 g', 'S-CHIPS', 'each', 50, 5, 'Snacks & biscuits', 2.5, 'fmcg', { hsn: '2005', reorder: 24, target: 72 }],
  ['Dark chocolate 80 g', 'S-CHOCO', 'each', 110, 5, 'Snacks & biscuits', 1.5, 'fmcg', { hsn: '1806', reorder: 12, target: 40 }],
  ['Instant noodles (pack of 4)', 'S-NOOD-4', 'each', 60, 5, 'Packaged food', 3, 'fmcg', { hsn: '1902', q: [1, 5], reorder: 24, target: 96, pack: ['case', 24] }],
  ['Corn flakes 500 g', 'S-CORN', 'each', 210, 5, 'Packaged food', 1, 'fmcg', { hsn: '1904', price: off(210, 10), reorder: 8, target: 30 }],
  ['Tomato ketchup 1 kg', 'S-KETCHUP', 'each', 135, 5, 'Packaged food', 1.2, 'fmcg', { hsn: '2103', reorder: 8, target: 30 }],
  ['Mixed fruit jam 500 g', 'S-JAM', 'each', 175, 5, 'Packaged food', 0.8, 'fmcg', { hsn: '2007', reorder: 6, target: 24 }],
  ['Rolled oats 1 kg', 'S-OATS', 'each', 199, 5, 'Packaged food', 1, 'fmcg', { hsn: '1104', price: off(199, 10), reorder: 6, target: 24 }],
  ['Green tea (25 bags)', 'S-GTEA', 'each', 175, 5, 'Beverages', 0.8, 'fmcg', { hsn: '0902', reorder: 6, target: 24 }],
  ['Tea 500 g', 'S-TEA-500', 'each', 285, 5, 'Beverages', 2, 'fmcg', { hsn: '0902', price: off(285, 5), reorder: 10, target: 40 }],
  ['Filter coffee 500 g', 'S-COFFEE-500', 'each', 320, 5, 'Beverages', 1.6, 'fmcg', { hsn: '0901', reorder: 8, target: 30 }],
  ['Mango drink 1.2 L', 'S-MANGO', 'each', 72, 5, 'Beverages', 1.2, 'fmcg', { hsn: '2202', reorder: 12, target: 48 }],
  ['Cola 2 L', 'S-COLA-2', 'each', 99, 40, 'Beverages', 1.2, 'fmcg', { hsn: '2202', reorder: 12, target: 48 }],
  ['Bathing soap (pack of 4)', 'S-SOAP-4', 'each', 180, 5, 'Personal care', 2, 'hpc', { hsn: '3401', price: off(180, 10), reorder: 12, target: 48 }],
  ['Toothpaste 150 g', 'S-TP-150', 'each', 105, 5, 'Personal care', 2, 'hpc', { hsn: '3306', reorder: 12, target: 48 }],
  ['Anti-dandruff shampoo 340 ml', 'S-SHAMPOO', 'each', 385, 5, 'Personal care', 1, 'hpc', { hsn: '3305', price: off(385, 12), reorder: 6, target: 24 }],
  ['Hand wash refill 750 ml', 'S-HANDWASH', 'each', 145, 18, 'Personal care', 1, 'hpc', { hsn: '3401', reorder: 6, target: 24 }],
  ['Baby diapers M (pack of 42)', 'S-DIAPER-M', 'each', 899, 5, 'Baby care', 0.6, 'hpc', { hsn: '9619', price: off(899, 15), reorder: 4, target: 16 }],
  ['Detergent powder 1 kg', 'S-DET-1', 'each', 180, 18, 'Home care', 2, 'hpc', { hsn: '3402', price: off(180, 5), reorder: 12, target: 48, pack: ['case', 12] }],
  ['Liquid detergent 2 L', 'S-LIQDET-2', 'each', 449, 18, 'Home care', 1, 'hpc', { hsn: '3402', price: off(449, 15), reorder: 6, target: 24 }],
  ['Dishwash gel 750 ml', 'S-DISHGEL', 'each', 199, 18, 'Home care', 1.4, 'hpc', { hsn: '3402', reorder: 8, target: 30 }],
  ['Toilet cleaner 1 L', 'S-TOILET', 'each', 215, 18, 'Home care', 1, 'hpc', { hsn: '3402', reorder: 6, target: 24 }],
  ['Garbage bags medium (30)', 'S-GARBAGE', 'each', 99, 18, 'Home care', 1, 'hpc', { hsn: '3923', reorder: 6, target: 24 }],
  ['Agarbatti (pack of 3)', 'S-AGAR', 'each', 99, 5, 'Pooja needs', 1, 'hpc', { hsn: '3307', reorder: 6, target: 24 }],
]);

const supermarketRegulars = regulars('kannada', 60, 'super', {
  udhaar: [], visits: (i) => (i < 20 ? 2 : 1),
});

const supermarket = {
  key: 'supermarket', type: 'supermarket', name: 'Sai Annapurna Super Bazaar', location: 'Jayanagar 4th Block store',
  legalName: 'Sai Annapurna Retail LLP', gstin: gstin('29', 'super-shop', 'F', 'S'),
  address: ['No. 418, 11th Main Road', 'Jayanagar 4th Block'], city: 'Bengaluru', pin: '560011', phone: '080-2663 1840', email: 'accounts@saiannapurnabazaar.in',
  receiptFooter: 'Exchange within 7 days with the bill. Fresh produce is not exchanged.',
  days: 90, open: 8 * 60, close: 22 * 60, margin: 0.16, regularShare: 0.42, udhaar: false,
  curve: [[8, 3], [9, 5], [10, 7], [11, 7], [12, 5], [13, 4], [14, 3], [15, 3], [16, 5], [17, 8], [18, 10], [19, 11], [20, 9], [21, 5]],
  volume: volume(52, { weekdays: [1.45, 0.9, 0.9, 0.92, 0.95, 1.05, 1.35], monthStart: 1.12, festivals: BLR_FESTIVALS, ranges: [['2026-10-01', '2026-10-07', 1.1]], growth: 0.0012 }),
  basketSize: (r, regular) => (regular ? r.int(4, 11) : r.int(2, 6)),
  pay: { upi: 0.58, card: 0.24, cash: 0.18 },
  loyalty: { earnPerAmount: '100', earnPoints: 2, pointValue: '0.50', minRedeemPoints: 200, maxRedeemPercent: '20', active: true },
  // Round 2 (R2-CORE): till PINs, split payment, spent points back on a return.
  hooks: { async today(sim, today) { await round2.tillPins(sim); await round2.splitBills(sim, today); await round2.pointsReturn(sim, today); } },
  staff: [{ name: 'Manjunath Gowda', login: 'manjunath', role: 'manager' }, { name: 'Shwetha R', login: 'shwetha', role: 'cashier' }, { name: 'Kavya Shetty', login: 'kavya', role: 'cashier' },
    { name: 'Raghu Naik', login: 'raghu', role: 'stock_keeper' }, { name: 'Sowmya Hegde', login: 'sowmya', role: 'accountant' }],
  suppliers: [
    supplier('staples', 'Karnataka Agro Staples Pvt Ltd', '29', 's-staples', { prefix: 'KAS', creditDays: 21, days: [1, 4], holder: 'C', address: 'APMC Yard, Yeshwanthpur, Bengaluru' }),
    supplier('veg', 'R. Lokesh Vegetable Commission Agent', '29', 's-veg', { prefix: 'RLV', creditDays: 2, lead: 1, method: 'cash', holder: 'P', address: 'K.R. Market, Bengaluru' }),
    supplier('dairy', 'Nandi Dairy & Bakery Distributors', '29', 's-dairy', { prefix: 'NDB', creditDays: 7, lead: 1, address: 'Banashankari 2nd Stage, Bengaluru' }),
    supplier('fmcg', 'Sri Venkateshwara FMCG Distributors', '29', 's-fmcg', { prefix: 'SVF', creditDays: 15, days: [2, 5], address: 'Peenya Industrial Area, Bengaluru' }),
    supplier('hpc', 'Mysore Road Home & Personal Care Agencies', '29', 's-hpc', { prefix: 'MHP', creditDays: 30, days: [3], late: 6, address: 'Mysore Road, Bengaluru' }),
  ],
  regulars: supermarketRegulars,
  categories: [['Staples'], ['Fruits & vegetables'], ['Dairy & bakery'], ['Frozen'], ['Snacks & biscuits'], ['Packaged food'], ['Beverages'], ['Personal care'], ['Baby care'],
    ['Home care'], ['Pooja needs']],
  items: superItems,
  offers: (ids, cats, rel) => [
    { name: '10% off personal care', kind: 'category_percent', categoryId: cats['Personal care'], value: '10', startsOn: rel(-80) },
    { name: 'Noodles: buy 4 get 1 free', kind: 'buy_x_get_y', skuId: ids['S-NOOD-4'], buyQuantity: '4', getQuantity: '1', value: '100', startsOn: rel(-80) },
    { name: 'Happy hours 4–7 pm: 5% off the bill', kind: 'bill_percent', value: '5', startsTime: '16:00', endsTime: '19:00', maxDiscount: '150', daysOfWeek: [1, 2, 3, 4], startsOn: rel(-70) },
    { name: '₹100 off on ₹2,000 and above', kind: 'bill_amount', value: '100', minBillAmount: '2000', startsOn: rel(-80) },
    { name: 'Weekend detergent ₹15 off', kind: 'item_amount', skuId: ids['S-DET-1'], value: '15', daysOfWeek: [6, 7], startsOn: rel(-60) },
    { name: 'Ganesh Chaturthi: ghee 8% off', kind: 'item_percent', skuId: ids['S-GHEE-1'], value: '8', startsOn: rel(-30), endsOn: rel(-23) },
    { name: 'Navratri festive: 5% off staples', kind: 'category_percent', categoryId: cats.Staples, value: '5', startsOn: rel(3), endsOn: rel(13) },
  ],
  modules: ['offers', 'loyalty'],
};

module.exports = { kirana, supermarket };
// Loaded last: it needs the shared demo pieces.
const round2 = require('./round2core');
