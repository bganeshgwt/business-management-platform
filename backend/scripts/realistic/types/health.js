// Pharmacy and clinic. Medicines 5 % GST (GST 2.0; insulin 0 %), sanitiser and
// wipes 18 %, consultations and tests exempt. Round 2 (R2-HEALTH) adds the
// specialist rules through health-rules.js: the drug master (salt, schedule,
// pack), prescription sales with the H1 and Schedule X registers, expiry
// returns and a recall; patients with consent, consultations and the lab.
const service = require('../../../src/modules/business/core/services/business.service');
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const { volume, items, regulars, supplier, gstin, people, mobile } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');
const machine = require('../machine');
const rules = require('./health-rules');

// --- Sri Sai Medicals, Velachery, Chennai ---------------------------------------------------

const med = (label, code, unit, mrp, gst, category, w, sup, extra = {}) => [label, code, unit, mrp, gst, category, w, sup,
  { tracking: 'batch', shelf: extra.shelf || 540, lotPrefix: extra.lot || code.slice(0, 3), reorder: extra.reorder ?? 10, target: extra.target ?? 40, margin: extra.margin ?? 0.2, hsn: extra.hsn || '3004', ...extra }];
const pharmacyItems = items([
  med('Paracetamol 650 mg tablets (strip of 15)', 'PCM-650', 'strip', 32, 5, 'Fever & pain', 9, 'mk', { drug: ['Paracetamol', '650 mg', 'tablet', 'Micro Labs', 'none', 15], q: [1, 2], reorder: 40, target: 160, lot: 'PC' }),
  med('Ibuprofen 400 mg tablets (strip of 15)', 'IBU-400', 'strip', 35, 5, 'Fever & pain', 2, 'mk', { drug: ['Ibuprofen', '400 mg', 'tablet', 'Abbott India', 'H', 15], lot: 'IB' }),
  med('Cetirizine 10 mg tablets (strip of 10)', 'CTZ-10', 'strip', 22, 5, 'Allergy & cold', 4, 'mk', { drug: ['Cetirizine', '10 mg', 'tablet', 'Dr. Reddy\'s Laboratories', 'none', 10], q: [1, 2], reorder: 20, target: 80, lot: 'CZ' }),
  med('Cough syrup 100 ml', 'CS-100', 'bottle', 118, 5, 'Allergy & cold', 3, 'mk', { drug: ['Dextromethorphan + Chlorpheniramine', '10 mg + 2 mg per 5 ml', 'syrup', 'Glenmark', 'none', null], reorder: 12, target: 40, lot: 'CS', shelf: 450 }),
  med('Paediatric paracetamol syrup 60 ml', 'PCM-SYR', 'bottle', 45, 5, 'Fever & pain', 2.4, 'mk', { drug: ['Paracetamol', '250 mg / 5 ml', 'syrup', 'GSK', 'none', null], reorder: 12, target: 40, lot: 'PS', shelf: 420 }),
  med('Pantoprazole 40 mg tablets (strip of 15)', 'PAN-40', 'strip', 155, 5, 'Stomach care', 3, 'mk', { drug: ['Pantoprazole', '40 mg', 'tablet', 'Alkem Laboratories', 'H', 15], q: [1, 2], lot: 'PN' }),
  med('Antacid suspension 170 ml', 'ANT-170', 'bottle', 140, 5, 'Stomach care', 1.6, 'mk', { drug: ['Aluminium hydroxide + Magnesium hydroxide + Simethicone', '170 ml', 'suspension', 'Abbott India', 'none', null], lot: 'AN', shelf: 420 }),
  med('ORS sachet (orange) 21 g', 'ORS-21', 'each', 22, 5, 'Stomach care', 2.4, 'mk', { q: [2, 6], reorder: 30, target: 120, lot: 'OR' }),
  med('Metformin 500 mg SR tablets (strip of 15)', 'MET-500', 'strip', 38, 5, 'Diabetes care', 4, 'ap', { drug: ['Metformin', '500 mg SR', 'tablet', 'USV', 'H', 15], q: [2, 4], reorder: 30, target: 120, lot: 'MF' }),
  med('Glucometer test strips (pack of 50)', 'GLU-STRIP', 'each', 950, 5, 'Diabetes care', 0.8, 'ap', { reorder: 4, target: 15, lot: 'GS', hsn: '3822', margin: 0.25 }),
  med('Amlodipine 5 mg tablets (strip of 15)', 'AML-5', 'strip', 45, 5, 'Heart & BP', 3, 'ap', { drug: ['Amlodipine', '5 mg', 'tablet', 'Cipla', 'H', 15], q: [2, 4], reorder: 30, target: 100, lot: 'AM' }),
  med('Telmisartan 40 mg tablets (strip of 15)', 'TEL-40', 'strip', 98, 5, 'Heart & BP', 2.4, 'ap', { drug: ['Telmisartan', '40 mg', 'tablet', 'Glenmark', 'H', 15], q: [2, 4], reorder: 20, target: 80, lot: 'TL' }),
  med('Atorvastatin 10 mg tablets (strip of 15)', 'ATV-10', 'strip', 110, 5, 'Heart & BP', 2, 'ap', { drug: ['Atorvastatin', '10 mg', 'tablet', 'Sun Pharma', 'H', 15], q: [1, 2], lot: 'AT' }),
  med('Thyroxine 50 mcg tablets (bottle of 100)', 'THY-50', 'bottle', 180, 5, 'Thyroid', 1.4, 'ap', { drug: ['Thyroxine sodium', '50 mcg', 'tablet', 'Abbott India', 'H', null], reorder: 6, target: 24, lot: 'TH' }),
  med('Azithromycin 500 mg tablets (strip of 3)', 'AZI-500', 'strip', 72, 5, 'Antibiotics', 2, 'mk', { drug: ['Azithromycin', '500 mg', 'tablet', 'Alembic', 'H', 3], reorder: 10, target: 40, lot: 'AZ' }),
  med('Amoxicillin + clavulanic acid 625 mg (strip of 10)', 'AMC-625', 'strip', 205, 5, 'Antibiotics', 1.6, 'mk', { drug: ['Amoxicillin + Clavulanic acid', '500 mg + 125 mg', 'tablet', 'GSK', 'H', 10], reorder: 8, target: 30, lot: 'AC' }),
  med('Vitamin D3 60,000 IU capsules (strip of 4)', 'VD3-60K', 'strip', 120, 5, 'Vitamins', 2, 'ap', { drug: ['Cholecalciferol', '60000 IU', 'capsule', 'Mankind', 'none', 4], reorder: 10, target: 40, lot: 'VD', hsn: '2106' }),
  med('Multivitamin capsules (strip of 15)', 'MULTI-15', 'strip', 140, 5, 'Vitamins', 1.6, 'ap', { drug: ['Multivitamin + multimineral', '', 'capsule', 'Pfizer', 'none', 15], reorder: 8, target: 30, lot: 'MV', hsn: '2106' }),
  med('Calcium + vitamin D3 tablets (strip of 15)', 'CAL-D3', 'strip', 125, 5, 'Vitamins', 1.6, 'ap', { drug: ['Calcium carbonate + Vitamin D3', '500 mg + 250 IU', 'tablet', 'Torrent', 'none', 15], reorder: 8, target: 30, lot: 'CD', hsn: '2106' }),
  med('Povidone-iodine ointment 15 g', 'PVI-15', 'each', 95, 5, 'First aid', 1.2, 'mk', { drug: ['Povidone-iodine', '5% w/w', 'ointment', 'Win-Medicare', 'none', null], reorder: 6, target: 24, lot: 'PV' }),
  med('Pain relief gel 30 g', 'GEL-30', 'each', 160, 5, 'First aid', 1.6, 'mk', { drug: ['Diclofenac + Linseed oil + Methyl salicylate + Menthol', '30 g', 'gel', 'Dr. Reddy\'s Laboratories', 'none', null], reorder: 6, target: 24, lot: 'PG' }),
  med('Antiseptic liquid 500 ml', 'ASL-500', 'bottle', 245, 18, 'First aid', 1, 'sg', { reorder: 6, target: 24, lot: 'AS', hsn: '3808' }),
  med('Crepe bandage 10 cm', 'CRP-10', 'each', 120, 5, 'First aid', 0.8, 'sg', { reorder: 5, target: 20, lot: 'CB', hsn: '3005', shelf: 1400 }),
  med('Adhesive bandages (pack of 100)', 'ADH-100', 'each', 140, 5, 'First aid', 0.8, 'sg', { reorder: 5, target: 20, lot: 'AB', hsn: '3005', shelf: 1400 }),
  med('Hand sanitiser 500 ml', 'SAN-500', 'bottle', 250, 18, 'Personal care', 0.8, 'sg', { reorder: 5, target: 20, lot: 'HS', hsn: '3808' }),
  med('Digital thermometer', 'THERMO', 'each', 250, 5, 'Devices', 0.6, 'sg', { reorder: 4, target: 15, lot: 'DT', hsn: '9025', shelf: 1800 }),
  med('Digital BP monitor', 'BPM', 'each', 1899, 5, 'Devices', 0.2, 'sg', { reorder: 2, target: 6, lot: 'BP', hsn: '9018', shelf: 1800, margin: 0.22 }),
  med('Adult diapers M (pack of 10)', 'ADL-DIAP', 'each', 520, 5, 'Personal care', 0.6, 'sg', { reorder: 4, target: 15, lot: 'AD', hsn: '9619', shelf: 1000 }),
  med('Baby wipes (pack of 72)', 'WIPES-72', 'each', 199, 18, 'Personal care', 0.8, 'sg', { reorder: 5, target: 20, lot: 'BW', hsn: '3401', shelf: 700 }),
  med('N95 masks (pack of 5)', 'N95-5', 'each', 150, 5, 'Personal care', 0.6, 'sg', { reorder: 5, target: 20, lot: 'NM', hsn: '6307', shelf: 1400 }),
  // Round 2: prescription medicines stocked by the tablet (sold by the strip, some loose), a
  // cheaper generic of paracetamol (a substitute) and a cold-chain insulin pen.
  med('Cefixime 200 mg tablets', 'CFX-200', 'tablet', 11, 5, 'Antibiotics', 0, 'mk', { pack: ['strip', 10], lot: 'CF', reorder: 0, target: 0, noOpening: true, noReorder: true,
    drug: ['Cefixime', '200 mg', 'tablet', 'Alkem Laboratories', 'H1', 10, { loose: true }], rulesStock: 300, shortBatch: 40, shortDays: 28 }),
  med('Alprazolam 0.25 mg tablets', 'ALP-025', 'tablet', 2.4, 5, 'Mind & sleep', 0, 'ap', { pack: ['strip', 15], lot: 'AP', reorder: 0, target: 0, noOpening: true, noReorder: true,
    drug: ['Alprazolam', '0.25 mg', 'tablet', 'Intas Pharmaceuticals', 'H1', 15], rulesStock: 300, shortBatch: 45, shortDays: 60 }),
  med('Pregabalin 75 mg capsules', 'PGB-75', 'tablet', 14, 5, 'Mind & sleep', 0, 'ap', { pack: ['strip', 10], lot: 'PG', reorder: 0, target: 0, noOpening: true, noReorder: true,
    drug: ['Pregabalin', '75 mg', 'capsule', 'Sun Pharma', 'H1', 10, { loose: true }], rulesStock: 200 }),
  med('Methylphenidate 10 mg tablets', 'MPH-10', 'tablet', 6.5, 5, 'Mind & sleep', 0, 'mk', { pack: ['strip', 10], lot: 'MP', reorder: 0, target: 0, noOpening: true, noReorder: true,
    drug: ['Methylphenidate', '10 mg', 'tablet', 'Novartis India', 'X', 10, { loose: true }], rulesStock: 100 }),
  med('Paracetamol 650 mg tablets, generic (strip of 15)', 'PCM-650G', 'strip', 18, 5, 'Fever & pain', 0, 'mk', { lot: 'PJ', reorder: 0, target: 0, noOpening: true, noReorder: true,
    drug: ['Paracetamol', '650 mg', 'tablet', 'BPPI (Jan Aushadhi)', 'none', 15], rulesStock: 60 }),
  med('Insulin glargine 100 IU/ml pen (3 ml)', 'INS-GLA', 'each', 640, 0, 'Diabetes care', 0, 'ap', { lot: 'IG', reorder: 0, target: 0, noOpening: true, noReorder: true, shelf: 300,
    drug: ['Insulin glargine', '100 IU/ml', 'injection', 'Biocon', 'H', null, { cold: true }], rulesStock: 12 }),
]);

const pharmacy = {
  key: 'pharmacy', type: 'pharmacy', name: 'Sri Sai Medicals', location: 'Velachery Main Road shop',
  legalName: 'Sri Sai Medicals (Prop. K. Senthil Kumar)', gstin: gstin('33', 'pharmacy-shop', 'P', 'K'),
  address: ['No. 52, Velachery Main Road', 'Opp. Vijayanagar bus stand, Velachery'], city: 'Chennai', pin: '600042', phone: '044-2243 6612', email: 'srisaimedicals.velachery@gmail.com',
  receiptFooter: 'Medicines once sold are taken back only within 7 days with the bill and an unbroken strip. Get well soon!',
  days: 90, open: 8 * 60 + 30, close: 22 * 60 + 30, margin: 0.2, regularShare: 0.3, returnRate: 0.004,
  curve: [[8, 3], [9, 6], [10, 7], [11, 7], [12, 5], [13, 3], [14, 3], [15, 3], [16, 4], [17, 6], [18, 8], [19, 9], [20, 9], [21, 6], [22, 2]],
  volume: volume(38, { weekdays: [0.75, 1.1, 1, 1, 1, 1, 1.05], festivals: { '2026-08-15': 0.8, '2026-09-14': 0.8 }, ranges: [['2026-08-01', '2026-09-15', 1.12]], growth: 0.0005 }),
  basketSize: (r, regular) => (regular ? r.int(2, 5) : r.int(1, 3)),
  pay: { upi: 0.5, cash: 0.42, card: 0.08 },
  returnReasons: ['Doctor changed the prescription', 'Bought twice by mistake', 'Customer changed mind'],
  staff: [{ name: 'Revathi Krishnan', login: 'revathi', role: 'manager' }, { name: 'Vignesh Raman', login: 'vignesh', role: 'cashier' }, { name: 'Dinesh Kumar', login: 'dinesh', role: 'stock_keeper' },
    { name: 'Priya Natarajan', login: 'priya', role: 'pharmacist' }],
  suppliers: [
    supplier('mk', 'Murugan Medical Agencies', '33', 'p-mk', { prefix: 'MMA', creditDays: 21, days: [1, 3, 5], address: 'Mint Street, Sowcarpet, Chennai' }),
    supplier('ap', 'Apex Pharma Distributors', '33', 'p-ap', { prefix: 'APD', creditDays: 30, days: [2, 4, 6], late: 5, holder: 'C', address: 'Anna Salai, Chennai' }),
    supplier('sg', 'Surgicare Healthcare Supplies', '33', 'p-sg', { prefix: 'SHS', creditDays: 30, days: [4], address: 'Guindy Industrial Estate, Chennai' }),
  ],
  regulars: regulars('tamil', 36, 'pharmacy', {
    udhaar: ['ontime', 'ontime', null, 'ontime', 'late', null, 'ontime', null, 'ontime'], limit: () => 5000, days: () => 30, visits: (i) => (i < 9 ? 2 : 1),
  }),
  categories: [['Fever & pain'], ['Allergy & cold'], ['Stomach care'], ['Diabetes care'], ['Heart & BP'], ['Thyroid'], ['Antibiotics'], ['Mind & sleep'], ['Vitamins'], ['First aid'], ['Personal care'], ['Devices']],
  items: pharmacyItems,
  modules: [],
  hooks: {
    // Prescription medicines are sold at the pharmacy counter with the prescription (rules.pharmacyRules).
    basket: (sim, r, regular) => rules.otcBasket(sim, r, regular),
    today: (sim) => rules.pharmacyRules(sim),
    // A few strips near their expiry (bought cheaply on a scheme): the near-expiry screen has something.
    async firstDay(sim, day) {
      const near = ['CS-100', 'VD3-60K', 'ANT-170'].map((code) => sim.items.find((i) => i.code === code)).filter(Boolean);
      const supplierRow = sim.suppliers[0];
      await shop.receive(sim, day, sim.def.open + 10, supplierRow, near.map((item, n) => ({ item, qty: 10, expires: clock.addDays(sim.realToday, 25 + n * 12), lotCode: `${item.meta.lotPrefix}SCH${n + 1}` })),
        'purchase-scheme-stock', { billSuffix: '-SCH', notes: 'Scheme stock, short expiry' });
    },
  },
};

// --- Sanjeevani Family Clinic & Diagnostics, Madhapur, Hyderabad ------------------------------

const clinicItems = items([
  ['General consultation', 'CN-GP', 'service', 500, 0, 'Consultations', 10, null, { kind: 'service', hsn: '9993', doctor: 'gp' }],
  ['Follow-up visit (within 7 days)', 'CN-FUP', 'service', 250, 0, 'Consultations', 5, null, { kind: 'service', hsn: '9993', doctor: 'gp' }],
  ['Paediatric consultation', 'CN-PAED', 'service', 600, 0, 'Consultations', 4, null, { kind: 'service', hsn: '9993', doctor: 'paed' }],
  ['Diabetes & thyroid consultation', 'CN-DIAB', 'service', 700, 0, 'Consultations', 3, null, { kind: 'service', hsn: '9993', doctor: 'diab' }],
  ['Complete blood count (CBC)', 'LB-CBC', 'service', 350, 0, 'Lab tests', 4, null, { kind: 'service', hsn: '9993', test: true }],
  ['Fasting blood sugar', 'LB-FBS', 'service', 120, 0, 'Lab tests', 4, null, { kind: 'service', hsn: '9993', test: true }],
  ['HbA1c', 'LB-HBA1C', 'service', 500, 0, 'Lab tests', 2.4, null, { kind: 'service', hsn: '9993', test: true }],
  ['Lipid profile', 'LB-LIPID', 'service', 650, 0, 'Lab tests', 1.6, null, { kind: 'service', hsn: '9993', test: true }],
  ['Thyroid profile (T3, T4, TSH)', 'LB-THY', 'service', 550, 0, 'Lab tests', 1.6, null, { kind: 'service', hsn: '9993', test: true }],
  ['Dengue NS1 antigen', 'LB-NS1', 'service', 600, 0, 'Lab tests', 1.2, null, { kind: 'service', hsn: '9993', test: true, monsoon: true }],
  ['ECG', 'PR-ECG', 'service', 300, 0, 'Procedures', 1, null, { kind: 'service', hsn: '9993', test: true }],
  ['Wound dressing', 'PR-DRESS', 'service', 200, 0, 'Procedures', 0.8, null, { kind: 'service', hsn: '9993' }],
  ['Injection (administration)', 'PR-INJ', 'service', 100, 0, 'Procedures', 1.2, null, { kind: 'service', hsn: '9993' }],
  // Round 2: the liver test and a health check-up package (a lab profile).
  ['Liver function test (LFT)', 'LB-LFT', 'service', 600, 0, 'Lab tests', 1.2, null, { kind: 'service', hsn: '9993', test: true }],
  ['Master health check-up', 'PK-MHC', 'service', 1999, 0, 'Lab tests', 0.4, null, { kind: 'service', hsn: '9993', test: true }],
]);

const DOCTORS = [['gp', 'Dr. Ravi Kumar Reddy', 'General physician'], ['paed', 'Dr. Swathi Rao', 'Paediatrician'], ['diab', 'Dr. Mohd. Faisal Khan', 'Diabetologist'],
  ['lab', 'Sample collection room', 'Room']];

async function clinicSetup(sim) {
  sim.extra.doctors = {};
  for (const [key, name, role] of DOCTORS) {
    sim.extra.doctors[key] = await repo.one(base.db, 'SELECT * FROM business_resources WHERE business_id=$1 AND name=$2', [sim.business.id, name])
      || await machine.at(sim.business.id, clock.at(clock.addDays(sim.realToday, -sim.def.days - 1), '11:00'),
        () => service.resource(sim.business, sim.owner, { name, roleLabel: role, locationId: sim.location.id }), { keepDates: true });
  }
}
// One patient visit: booked, seen, billed (consultation and any tests).
async function clinicVisit(sim, day, p, step, { future = false } = {}) {
  const r = p.r;
  const patient = r.pick(sim.regulars);
  const consult = r.weighted(sim.items.filter((i) => i.meta.doctor), (x) => x.meta.w);
  const doctor = sim.extra.doctors[consult.meta.doctor];
  const slot = Math.round(p.minutes / 10) * 10;
  const starts = clock.at(day, slot), ends = new Date(starts.getTime() + 10 * 60000);
  const who = shop.actor(sim, 'cashier', 'manager');
  // The appointment (found again by its patient, doctor and time on a rerun).
  let appointment = await repo.one(base.db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND resource_id=$2 AND starts_at=$3', [sim.business.id, doctor.id, starts]);
  if (!appointment) {
    try {
      const bookedAt = Math.min(Date.now(), starts.getTime() - r.int(30, 600) * 60000);
      appointment = await machine.at(sim.business.id, new Date(bookedAt),
        () => service.appointment(who.business, who.user, { contactId: patient.contact.id, skuId: consult.id, resourceId: doctor.id, startsAt: starts.toISOString(), endsAt: ends.toISOString() }),
        { skip: ['starts_at', 'ends_at'] });
    } catch (error) {
      if (/already has an appointment/.test(error.message)) return;
      throw error;
    }
  }
  if (future || appointment.status !== 'booked') return;
  if (r.chance(0.04)) {
    await machine.at(sim.business.id, new Date(starts.getTime() + 30 * 60000), () => service.appointmentStatus(who.business, who.user, appointment.id, { status: 'no_show' }));
    return;
  }
  await machine.at(sim.business.id, ends, () => service.appointmentStatus(who.business, who.user, appointment.id, { status: 'completed' }));
  const tests = sim.items.filter((i) => i.meta.test && (!i.meta.monsoon || clock.between(day, '2026-07-15', '2026-09-30')));
  const lines = [{ skuId: consult.id, quantity: '1' }];
  if (r.chance(consult.meta.doctor === 'diab' ? 0.7 : 0.3)) for (const t of [r.weighted(tests, (x) => x.meta.w), ...(r.chance(0.3) ? [r.weighted(tests, (x) => x.meta.w)] : [])]) {
    if (!lines.some((l) => l.skuId === t.id)) lines.push({ skuId: t.id, quantity: '1' });
  }
  const method = shop.methodOf(sim, r);
  await shop.post(sim, 'business_documents', step, new Date(ends.getTime() + 3 * 60000), (requestKey) => service.document(who.business, who.user,
    { kind: 'sale', locationId: sim.location.id, contactId: patient.contact.id, requestKey, lines, payment: { amount: 'full', method } }));
}

const clinic = {
  key: 'clinic', type: 'healthcare', name: 'Sanjeevani Family Clinic & Diagnostics', location: 'Madhapur clinic',
  legalName: 'Sanjeevani Healthcare (Dr. Ravi Kumar Reddy)', gstin: null, state: '36',
  address: ['Plot 23, Ayyappa Society Main Road', 'Madhapur'], city: 'Hyderabad', pin: '500081', phone: '040-4852 7710', email: 'frontdesk@sanjeevaniclinic.in',
  receiptFooter: 'Consultations and diagnostic tests are exempt from GST. Reports on WhatsApp the same evening.',
  taxMode: 'exclusive', rounding: 'none',
  days: 90, open: 9 * 60, close: 21 * 60, udhaar: false, regularShare: 1, barcodes: false,
  curve: [[9, 6], [10, 9], [11, 9], [12, 7], [13, 3], [17, 7], [18, 9], [19, 9], [20, 6]],
  closedOn: (day) => clock.weekday(day) === 0,
  volume: volume(30, { weekdays: [0, 1.15, 1, 1, 1, 1, 1.1], ranges: [['2026-07-20', '2026-09-20', 1.2]], festivals: { '2026-08-15': 0.4, '2026-09-14': 0.5, '2026-10-02': 0.6 } }),
  pay: { upi: 0.55, cash: 0.3, card: 0.15 },
  staff: [{ name: 'Sravani Goud', login: 'sravani', role: 'cashier' }, { name: 'Kiran Varma', login: 'kiran', role: 'manager' },
    // Round 2: the doctors (clinical notes), the lab technician and the pathologist who approves reports.
    { name: 'Dr. Ravi Kumar Reddy', login: 'ravi', role: 'doctor' }, { name: 'Dr. Swathi Rao', login: 'swathi', role: 'doctor' },
    { name: 'Dr. Mohd. Faisal Khan', login: 'faisal', role: 'doctor' }, { name: 'Naveen Kumar', login: 'naveen', role: 'lab_technician' },
    { name: 'Dr. Anitha Varma', login: 'anitha', role: 'pathologist' }],
  suppliers: [],
  regulars: [...people('telugu', 120, 'clinic'), ...people('hyderabadi', 40, 'clinic-h'), ...people('north', 30, 'clinic-n')].map((p, i) => ({ key: `p${i + 1}`, name: p.name, phone: mobile(`clinic|${i}`) })),
  categories: [['Consultations'], ['Lab tests'], ['Procedures']],
  items: clinicItems,
  modules: [],
  sellsServices: true,
  hooks: {
    setup: clinicSetup,
    sale: (sim, day, p, step) => clinicVisit(sim, day, p, step),
    // The rest of today's and tomorrow's appointments are booked but not seen yet.
    async today(sim, today) {
      const limit = clock.minutesNow();
      for (const [day, from] of [[today, limit + 15], [clock.addDays(today, 1), 0]]) {
        if (clock.weekday(day) === 0) continue;
        const r = clock.rng(`${sim.code}|ahead|${day}`);
        const count = day === today ? r.int(6, 10) : r.int(8, 12);
        for (let n = 0; n < count; n += 1) {
          const [hour] = r.weighted(sim.def.curve, (x) => x[1]);
          const minutes = hour * 60 + r.int(0, 5) * 10;
          if (minutes < from || minutes >= sim.def.close) continue;
          await clinicVisit(sim, day, { minutes, r: clock.rng(`${sim.code}|ahead|${day}|${n}`) }, `ahead-${day}-${n}`, { future: true });
        }
      }
      // Then patients, consultations and the lab (rules.clinicRules).
      await rules.clinicRules(sim);
    },
  },
};

module.exports = { pharmacy, clinic };
