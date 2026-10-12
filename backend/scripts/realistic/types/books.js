// Vidya Book House & Stationers, Deccan Gymkhana, Pune: school textbooks and
// guides, exam books, Marathi and English reading, and the stationery
// counter. Books, exercise books, pencils, crayons and erasers carry nil GST
// (GST 2.0); pens, geometry boxes, bags, glue and diaries 18 %. The school
// season tails off through July; half-yearly exams lift the guides in
// September; diaries for 2027 arrive in October.
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const retail = require('../../../src/modules/business/retail/services/businessRetail.service');
const retailPro = require('../../../src/modules/business/retail/services/businessRetailPro.service');
const { volume, items, regulars, supplier, gstin } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');

const isbn = (body) => body + retail.eanCheck(body);
const book = (label, code, mrp, category, w, sup, isbnBody, author, publisher, extra = {}) => [label, code, 'each', mrp, 0, category, w, sup,
  { attributes: { isbn: isbn(isbnBody), author, publisher }, barcode: isbn(isbnBody), reorder: extra.reorder ?? 3, target: extra.target ?? 12, margin: 0.25, ...extra }];

const bookItems = items([
  book('Std 10 Mathematics Part I (state board)', 'TB-10-MATH1', 96, 'School textbooks', 3, 'board', '978810000101', 'State Board of Textbooks', 'State Textbook Bureau', { reorder: 10, target: 40, margin: 0.15 }),
  book('Std 10 Science & Technology Part I (state board)', 'TB-10-SCI1', 112, 'School textbooks', 2.6, 'board', '978810000102', 'State Board of Textbooks', 'State Textbook Bureau', { reorder: 10, target: 40, margin: 0.15 }),
  book('Std 9 English reader (state board)', 'TB-9-ENG', 78, 'School textbooks', 2, 'board', '978810000103', 'State Board of Textbooks', 'State Textbook Bureau', { reorder: 8, target: 30, margin: 0.15 }),
  book('Std 8 History & Civics (state board)', 'TB-8-HIST', 64, 'School textbooks', 1.4, 'board', '978810000104', 'State Board of Textbooks', 'State Textbook Bureau', { reorder: 6, target: 25, margin: 0.15 }),
  book('Std 10 question bank: Mathematics', 'GD-10-MATH', 265, 'Guides & question banks', 3, 'guides', '978935000201', 'R. K. Sethi', 'Pragati Educational', { reorder: 8, target: 30 }),
  book('Std 10 question bank: Science', 'GD-10-SCI', 255, 'Guides & question banks', 2.4, 'guides', '978935000202', 'Dr. Kavita Rao', 'Pragati Educational', { reorder: 8, target: 30 }),
  book('Std 12 Physics practice papers', 'GD-12-PHY', 395, 'Guides & question banks', 1.6, 'guides', '978935000203', 'Dr. Kavita Rao', 'Pragati Educational', { reorder: 5, target: 20 }),
  book('Std 12 Chemistry practice papers', 'GD-12-CHEM', 395, 'Guides & question banks', 1.4, 'guides', '978935000204', 'S. V. Kulkarni', 'Pragati Educational', { reorder: 5, target: 20 }),
  book('State civil services prelims: complete guide', 'CE-STATE-PRE', 650, 'Competitive exams', 1.2, 'guides', '978935000301', 'A. P. Deshmukh', 'Sahyadri Academic Press', { reorder: 4, target: 15 }),
  book('Bank & SSC exams: quantitative aptitude', 'CE-QUANT', 475, 'Competitive exams', 1.4, 'guides', '978935000302', 'N. Gaikwad', 'Sahyadri Academic Press', { reorder: 4, target: 15 }),
  book('General knowledge yearbook 2027', 'CE-GK-2027', 299, 'Competitive exams', 1.2, 'guides', '978935000303', 'Editorial team', 'Sahyadri Academic Press', { reorder: 5, target: 20, noOpening: false }),
  book('Shyamchi Aai (Sane Guruji, Marathi)', 'MR-SHYAMCHI', 150, 'Marathi books', 1.4, 'trade', '978935000401', 'Sane Guruji', 'Varada Prakashan', {}),
  book('Godaan (Premchand, Hindi)', 'HI-GODAAN', 175, 'Fiction', 0.8, 'trade', '978935000402', 'Premchand', 'Saraswati Prakashan', {}),
  book('Gitanjali (Tagore, English translation)', 'EN-GITANJALI', 199, 'Fiction', 0.8, 'trade', '978935000403', 'Rabindranath Tagore', 'Monsoon Leaf Press', {}),
  book('The Monsoon Letters (novel)', 'EN-MONSOON', 399, 'Fiction', 1, 'trade', '978935000404', 'Anjali Varma', 'Monsoon Leaf Press', {}),
  book('Deccan Evenings (short stories)', 'EN-DECCAN', 299, 'Fiction', 0.8, 'trade', '978935000405', 'S. Narayanaswamy', 'Monsoon Leaf Press', {}),
  book('Panchatantra stories (illustrated)', 'CH-PANCHA', 250, "Children's books", 1.4, 'trade', '978935000501', 'Retold by Uma Iyer', 'Little Lamp Books', {}),
  book('Akbar–Birbal tales', 'CH-AKBAR', 120, "Children's books", 1.2, 'trade', '978935000502', 'Retold by R. Bhosale', 'Little Lamp Books', {}),
  book("Children's atlas of India", 'CH-ATLAS', 225, "Children's books", 1, 'trade', '978935000503', 'Dr. Ravi Kulkarni', 'Little Lamp Books', {}),
  book('Student English–Marathi dictionary', 'RF-DICT-EM', 180, 'Dictionaries', 1, 'trade', '978935000601', 'Editorial team', 'Varada Prakashan', {}),
  // Stationery
  ['Long notebook 172 pages (single line)', 'ST-NB-LONG', 'each', 60, 0, 'Notebooks', 9, 'stationery', { hsn: '4820', q: [2, 8], reorder: 60, target: 240, pack: ['dozen', 12] }],
  ['Short notebook 100 pages', 'ST-NB-SHORT', 'each', 30, 0, 'Notebooks', 5, 'stationery', { hsn: '4820', q: [2, 6], reorder: 48, target: 180, pack: ['dozen', 12] }],
  ['A4 spiral notebook 300 pages', 'ST-NB-SPIRAL', 'each', 160, 0, 'Notebooks', 2, 'stationery', { hsn: '4820', reorder: 12, target: 40 }],
  ['Drawing book A4 (36 sheets)', 'ST-DRAW-A4', 'each', 45, 0, 'Art & craft', 2, 'stationery', { hsn: '4820', reorder: 12, target: 48 }],
  ['Gel pen (blue)', 'ST-GEL-BLUE', 'each', 10, 18, 'Writing instruments', 7, 'stationery', { hsn: '9608', q: [1, 5], reorder: 60, target: 240, pack: ['box', 10] }],
  ['Ball pens (pack of 5)', 'ST-BALL-5', 'each', 50, 18, 'Writing instruments', 3, 'stationery', { hsn: '9608', reorder: 20, target: 72 }],
  ['HB pencils (pack of 10)', 'ST-PENCIL-10', 'each', 60, 0, 'Writing instruments', 3, 'stationery', { hsn: '9609', reorder: 20, target: 72 }],
  ['Eraser & sharpener set', 'ST-ERASER', 'each', 20, 0, 'Writing instruments', 3, 'stationery', { hsn: '4016', reorder: 24, target: 96 }],
  ['Geometry box', 'ST-GEOMETRY', 'each', 120, 18, 'Writing instruments', 1.6, 'stationery', { hsn: '9017', reorder: 8, target: 30 }],
  ['Wax crayons (24 shades)', 'ST-CRAYON-24', 'each', 70, 0, 'Art & craft', 1.6, 'stationery', { hsn: '9609', reorder: 10, target: 36 }],
  ['Colour pencils (24 shades)', 'ST-COLPEN-24', 'each', 160, 0, 'Art & craft', 1.2, 'stationery', { hsn: '9609', reorder: 8, target: 30 }],
  ['Sketch pens (12 shades)', 'ST-SKETCH-12', 'each', 50, 18, 'Art & craft', 2, 'stationery', { hsn: '9608', reorder: 12, target: 48 }],
  ['Watercolour cakes (12)', 'ST-WATERCOL', 'each', 90, 18, 'Art & craft', 0.8, 'stationery', { hsn: '3213', reorder: 6, target: 24 }],
  ['Chart paper (each)', 'ST-CHART', 'each', 10, 18, 'Art & craft', 2.4, 'stationery', { hsn: '4802', q: [1, 4], reorder: 40, target: 150 }],
  ['Glue stick 15 g', 'ST-GLUE', 'each', 35, 18, 'Art & craft', 1.6, 'stationery', { hsn: '3506', reorder: 12, target: 48 }],
  ['School bag (medium, 25 L)', 'ST-BAG-M', 'each', 899, 18, 'School bags & files', 0.5, 'bags', { hsn: '4202', reorder: 3, target: 12 }],
  ['Exam pad (clipboard)', 'ST-EXAMPAD', 'each', 99, 18, 'School bags & files', 1.2, 'stationery', { hsn: '3926', reorder: 8, target: 30 }],
  ['Document file (pack of 5)', 'ST-FILE-5', 'each', 75, 18, 'School bags & files', 1, 'stationery', { hsn: '3926', reorder: 8, target: 30 }],
  ['Desk diary 2027', 'ST-DIARY-2027', 'each', 350, 18, 'Diaries', 0.2, 'stationery', { hsn: '4820', reorder: 6, target: 30, noOpening: true, noReorder: true }],
  ['Fountain pen gift set', 'ST-FPEN-GIFT', 'each', 450, 18, 'Writing instruments', 0.4, 'stationery', { hsn: '9608', reorder: 3, target: 12 }],
]);

const SCHOOL = [['2026-07-01', '2026-07-15', 1.7], ['2026-07-16', '2026-07-31', 1.25], ['2026-09-01', '2026-09-20', 1.15], ['2026-09-14', '2026-09-24', 0.85], ['2026-10-01', '2026-10-10', 1.1]];

const books = {
  key: 'books', type: 'books', name: 'Vidya Book House & Stationers', location: 'Deccan Gymkhana shop',
  legalName: 'Vidya Book House & Stationers (Prop. Sachin Kulkarni)', gstin: gstin('27', 'books-shop', 'P', 'K'),
  address: ['Shop 3, Shrinath Plaza, Fergusson College Road', 'Deccan Gymkhana'], city: 'Pune', pin: '411004', phone: '020-2565 3318', email: 'vidyabookhouse.pune@gmail.com',
  receiptFooter: 'School sets ready on order. Exchange within 7 days, unmarked books only.',
  days: 90, open: 9 * 60 + 30, close: 21 * 60, margin: 0.28, regularShare: 0.22, returnRate: 0.01,
  curve: [[9, 3], [10, 6], [11, 7], [12, 6], [13, 4], [14, 3], [15, 3], [16, 5], [17, 8], [18, 9], [19, 8], [20, 4]],
  volume: volume(30, { weekdays: [0.55, 1, 0.95, 0.95, 1, 1.05, 1.25], festivals: { '2026-08-15': 0.6, '2026-09-14': 0.5 }, ranges: SCHOOL, growth: 0 }),
  basketSize: (r) => r.int(1, 4),
  pay: { upi: 0.55, cash: 0.35, card: 0.1 },
  returnReasons: ['Wrong edition bought', 'Duplicate copy (gift)', 'Pages missing in the book', 'Customer changed mind'],
  staff: [{ name: 'Sneha Joshi', login: 'sneha', role: 'manager' }, { name: 'Omkar Pawar', login: 'omkar', role: 'cashier' }, { name: 'Tushar More', login: 'tushar', role: 'stock_keeper' }],
  suppliers: [
    supplier('board', 'State Textbook Bureau Depot (Pune)', '27', 'b-board', { prefix: 'STB', creditDays: 0, method: 'bank', days: [1], holder: 'G', address: 'Senapati Bapat Road, Pune' }),
    supplier('guides', 'Pragati Educational Distributors', '27', 'b-guides', { prefix: 'PED', creditDays: 30, days: [2, 5], late: 5, address: 'Appa Balwant Chowk, Pune' }),
    supplier('trade', 'Monsoon Leaf Book Distributors', '27', 'b-trade', { prefix: 'MLB', creditDays: 45, days: [4], address: 'Narayan Peth, Pune' }),
    supplier('stationery', 'Shree Ganesh Stationery Wholesale', '27', 'b-stat', { prefix: 'SGS', creditDays: 15, days: [1, 4], address: 'Raviwar Peth, Pune' }),
    supplier('bags', 'Deccan Bags & Luggage Agencies', '27', 'b-bags', { prefix: 'DBL', creditDays: 30, days: [3], address: 'Laxmi Road, Pune' }),
  ],
  regulars: [
    { key: 's1', name: "Jnana Prabodhini Vidyalaya (library)", phone: '020-2447 1180', udhaar: 'ontime', creditLimit: '60000', creditDays: 30, visits: 0.6, address: 'Sadashiv Peth, Pune' },
    { key: 's2', name: 'Abhinav English Medium School', phone: '020-2543 7721', udhaar: 'late', creditLimit: '50000', creditDays: 30, visits: 0.5, openingBalance: '8640', openingBalanceOn: '2026-06-28', address: 'Kothrud, Pune' },
    { key: 's3', name: 'Success Point Coaching Classes', phone: '98220 61540', udhaar: 'chronic', creditLimit: '30000', creditDays: 15, visits: 0.6, address: 'Karve Road, Pune' },
    ...regulars('marathi', 30, 'books', { udhaar: [null, 'ontime', null, null, 'ontime'], limit: () => 3000, days: () => 15, visits: () => 1 }),
  ],
  categories: [['School textbooks'], ['Guides & question banks'], ['Competitive exams'], ['Fiction'], ['Marathi books'], ["Children's books"], ['Dictionaries'],
    ['Notebooks'], ['Writing instruments'], ['Art & craft'], ['School bags & files'], ['Diaries']],
  items: bookItems,
  offers: (ids, cats, rel) => [
    { name: 'School season: 10% off notebooks', kind: 'category_percent', categoryId: cats.Notebooks, value: '10', startsOn: rel(-90), endsOn: rel(-60) },
    { name: 'Notebooks: buy 6 get 1 free', kind: 'buy_x_get_y', skuId: ids['ST-NB-LONG'], buyQuantity: '6', getQuantity: '1', value: '100', startsOn: rel(-59) },
    { name: '₹50 off on ₹1,000 and above', kind: 'bill_amount', value: '50', minBillAmount: '1000', startsOn: rel(-90) },
  ],
  modules: ['offers', 'receivables'],
  hooks: {
    // School booklists and customer orders for books not on the shelf.
    async setup(sim) {
      const ids = Object.fromEntries(sim.items.map((i) => [i.code, i.id]));
      for (const [name, code, school, className, list] of [
        ['Jnana Prabodhini — Std 10 (2026–27)', 'JPV-STD10', 'Jnana Prabodhini Vidyalaya', 'Std 10', [['TB-10-MATH1', 1], ['TB-10-SCI1', 1], ['GD-10-MATH', 1], ['ST-NB-LONG', 8], ['ST-GEL-BLUE', 5], ['ST-GEOMETRY', 1]]],
        ['Abhinav School — Std 5 (2026–27)', 'AEMS-STD5', 'Abhinav English Medium School', 'Std 5', [['CH-PANCHA', 1], ['ST-NB-SHORT', 6], ['ST-PENCIL-10', 1], ['ST-CRAYON-24', 1], ['ST-ERASER', 2]]],
      ]) {
        if (await repo.one(base.db, 'SELECT 1 FROM books_sets WHERE business_id=$1 AND code=$2', [sim.business.id, code])) continue;
        await retailPro.createSet(sim.business, sim.owner, { name, code, school, className, items: list.map(([c, q]) => ({ skuId: ids[c], quantity: String(q) })) });
      }
    },
    // Diaries for 2027 arrive at the start of October.
    async morning(sim, day) {
      if (day !== '2026-10-01') return;
      const diary = sim.items.find((i) => i.code === 'ST-DIARY-2027');
      const supplierRow = sim.suppliers.find((s) => s.key === 'stationery');
      if (diary) await shop.receive(sim, day, sim.def.open + 30, supplierRow, [{ item: diary, qty: 40 }], `purchase-diaries-${day}`, { billSuffix: '-DRY' });
    },
    // Today: two customer orders for books not in stock (one with an advance).
    async today(sim, today) {
      const meera = sim.regulars.find((c) => c.key === 'c2') || sim.regulars[3];
      for (const [step, contact, title, author, advance, promise] of [
        ['order-1', meera, 'Marathi Vishwakosh (student edition), vol. 3', 'Editorial board', '200', 6],
        ['order-2', null, 'Atlas of world history (school edition)', 'Dr. Ravi Kulkarni', '0', 3]]) {
        const requestKey = base.key(sim.business.id, step);
        if (await repo.one(base.db, 'SELECT 1 FROM books_customer_orders WHERE business_id=$1 AND request_key=$2', [sim.business.id, requestKey])) continue;
        if (clock.minutesNow() < sim.def.open + 60) continue;
        await retailPro.createOrder(sim.business, sim.owner, { locationId: sim.location.id, requestKey, title, author, quantity: 1, promisedOn: clock.addDays(today, promise),
          ...(contact ? { contactId: contact.contact.id } : { customerName: 'Aniket Shinde', phone: '98901 22417' }), ...(Number(advance) > 0 ? { advance, method: 'upi' } : {}) });
      }
    },
  },
};

module.exports = { books };
