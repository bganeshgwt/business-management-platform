// Pharmacy and clinic / lab rules for the realistic demo (round 2, R2-HEALTH):
// the drug master, prescription sales with the H1 and Schedule X registers,
// expiry returns to distributors, a batch recall; patients with consent,
// consultations, the lab's test catalogue and orders in every state with some
// results out of range. Everything goes through the app's own services and is
// found again by a stable key, so a rerun adds what is missing and nothing twice.
const crypto = require('node:crypto');
const fs = require('node:fs');
const bcrypt = require('bcrypt');
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const service = require('../../../src/modules/business/core/services/business.service');
const users = require('../../../src/modules/access/repositories/user.repository');
const h = require('../../../src/modules/business/health/services/healthCommon');
const pharmacy = require('../../../src/modules/business/health/services/businessPharmacy.service');
const clinicSvc = require('../../../src/modules/business/health/services/businessClinic.service');
const lab = require('../../../src/modules/business/health/services/businessLab.service');
const desk = require('../../../src/modules/business/health/services/businessClinicDesk.service');
const quality = require('../../../src/modules/business/health/services/businessLabQuality.service');
const { people } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');
const machine = require('../machine');

const db = repo.pool;
const SCHEDULED = ['H', 'H1', 'X', 'narcotic'];
const at = (businessId, when, work, options) => machine.at(businessId, when, work, options);

// A PIN the demo signs with, saved next to the staff password (local only).
async function ensurePin(person) {
  const file = require('node:path').resolve(__dirname, '../../../.local/realistic-demo-logins.json');
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).accounts || []; } catch { saved = []; }
  const email = (await repo.one(db, 'SELECT email,pin_hash FROM users WHERE id=$1', [person.user.id]));
  const entry = saved.find((a) => a.email === email.email);
  // The logins file is shared by every database seeded from this folder (the
  // owner's and the test one): use the saved PIN only if it is this
  // database's PIN for the person, else set a new one.
  if (email.pin_hash && entry?.pin && await bcrypt.compare(String(entry.pin), email.pin_hash)) return entry.pin;
  const pin = String(crypto.randomInt(1000, 9999));
  await users.setPin(person.user.id, await bcrypt.hash(pin, 10), person.user.id);
  base.writeLogins([{ ...(entry || { business: null, name: person.name, role: person.role, email: email.email }), pin }]);
  return pin;
}

// A one-page PDF "scan" of a prescription (Helvetica text), so the demo's
// prescription log opens a believable file.
function prescriptionPdf(lines) {
  const esc = (t) => String(t).replace(/[\\()]/g, (c) => `\\${c}`);
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 14 : 11} Tf 50 ${780 - i * 22} Td (${esc(l)}) Tj ET`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// --- Pharmacy ---------------------------------------------------------------------------------

const CHENNAI_DOCTORS = [['Dr. R. Venkataraman', 'TNMC 48213', 'Kamakshi Clinic, Velachery'], ['Dr. S. Meenakshi', 'TNMC 61877', 'Sri Ram Nursing Home, Adambakkam'],
  ['Dr. K. Prakash', 'TNMC 55290', 'Prakash Child Clinic, Madipakkam'], ['Dr. A. Fathima', 'TNMC 70412', 'Velachery Diabetes Centre'], ['Dr. J. Senthilnathan', 'TNMC 39954', 'Government Hospital, Velachery']];

// Shelf items that are scheduled are sold only on a prescription: the
// counter simulation leaves them to the prescription sales below.
function otcBasket(sim, r, regular) {
  const size = sim.def.basketSize ? sim.def.basketSize(r, regular) : r.int(1, 4);
  return shop.basket({ ...sim, items: sim.items.filter((i) => !SCHEDULED.includes(i.meta.drug?.[4])) }, r, regular ? size + 2 : size);
}

async function pharmacyRules(sim) {
  const biz = sim.business, owner = sim.owner, today = sim.realToday;
  await h.saveSettings(biz, owner, { drugLicence20: 'TN/CHN/20/2019/4417', drugLicence21: 'TN/CHN/21/2019/4418', drugLicence20f: 'TN/CHN/20F/2021/0093', nearExpiryDays: 90 });
  const pharmacist = sim.staff.find((s) => s.role === 'pharmacist');
  const pin = await ensurePin(pharmacist);
  let signer = await repo.one(db, "SELECT * FROM health_signatories WHERE business_id=$1 AND kind='pharmacist' AND user_id=$2", [biz.id, pharmacist.user.id]);
  if (!signer) signer = await h.saveSignatory(biz, owner, { kind: 'pharmacist', userId: pharmacist.user.id, name: pharmacist.name, qualification: 'B.Pharm', registrationNo: 'TNPC 30418', council: 'Tamil Nadu Pharmacy Council' });
  // The drug master of every medicine.
  for (const item of sim.items.filter((i) => i.meta.drug)) {
    if (await repo.one(db, 'SELECT 1 FROM pharmacy_drugs WHERE business_id=$1 AND sku_id=$2', [biz.id, item.id])) continue;
    const [composition, strength, form, maker, schedule, perStrip, extra = {}] = item.meta.drug;
    await pharmacy.saveDrug(biz, owner, item.id, { composition, strength, form, manufacturer: maker, schedule, unitsPerStrip: perStrip || null, stripsPerBox: extra.box || null,
      looseSale: Boolean(extra.loose), coldChain: Boolean(extra.cold), storage: extra.storage || (extra.cold ? 'Store at 2–8 °C. Do not freeze.' : 'Store below 30 °C, away from light') });
  }
  // Stock of the prescription medicines added with the rules (and a short-dated batch or two).
  const supplierOf = (item) => sim.suppliers.find((s) => s.key === item.meta.supplier) || sim.suppliers[0];
  const start = clock.addDays(today, -35);
  for (const item of sim.items.filter((i) => i.meta.rulesStock)) {
    const supplier = supplierOf(item);
    await shop.receive(sim, start, sim.def.open + 40, supplier, [{ item, qty: item.meta.rulesStock, lotCode: `${item.meta.lotPrefix}R1`, expires: clock.addDays(today, 420) }], `rules-stock-${item.code}`,
      { billSuffix: `-${item.code}`, notes: 'Prescription medicines stocked with the pharmacy rules' });
    if (item.meta.shortBatch) {
      await shop.receive(sim, clock.addDays(today, -10), sim.def.open + 50, supplier, [{ item, qty: item.meta.shortBatch, lotCode: `${item.meta.lotPrefix}S1`, expires: clock.addDays(today, item.meta.shortDays || 40) }],
        `rules-short-${item.code}`, { billSuffix: `-S-${item.code}`, notes: 'Short-dated stock on a scheme' });
    }
  }
  await shop.loadStock(sim);
  // Prescription sales over the last month (the registers fill in as they are made).
  const scheduled = sim.items.filter((i) => SCHEDULED.includes(i.meta.drug?.[4]));
  const counter = sim.staff.filter((s) => ['cashier', 'pharmacist'].includes(s.role));
  for (let back = 30; back >= 0; back -= 1) {
    const day = clock.addDays(today, -back);
    const r = clock.rng(`${sim.code}|rx|${day}`);
    const count = r.int(2, 4);
    // About once a week a Schedule X medicine, signed off by the pharmacist.
    const xDay = back % 6 === 0;
    for (let n = 0; n < count + (xDay ? 1 : 0); n += 1) {
      const minutes = sim.def.open + 60 + r.int(0, sim.def.close - sim.def.open - 120);
      if (back === 0 && minutes > clock.minutesNow() - 5) continue;
      const forcedX = xDay && n === count;
      const item = forcedX ? scheduled.find((x) => x.meta.drug[4] === 'X') : r.weighted(scheduled, (x) => (x.meta.drug[4] === 'X' ? 0.4 : x.meta.drug[4] === 'H1' ? 1.2 : 1.6));
      if (!item) continue;
      const schedule = item.meta.drug[4];
      const perStrip = item.meta.drug[5];
      const loose = item.meta.drug[6]?.loose && r.chance(0.35);
      const line = item.unit === 'tablet' && !loose ? { skuId: item.id, quantity: String(r.int(1, 2)), unit: 'strip' } : { skuId: item.id, quantity: String(item.unit === 'tablet' ? r.int(3, 8) : r.int(1, 2)) };
      if (item.unit === 'tablet' && loose && perStrip) line.quantity = String(Math.min(perStrip - 1, Number(line.quantity)));
      const regular = r.chance(0.55) ? r.pick(sim.regulars) : null;
      const walkIn = people('tamil', 1, `rx|${day}|${n}`)[0].name;
      const [doctorName, doctorRegNo, doctorAddress] = r.pick(CHENNAI_DOCTORS);
      const prescribedOn = clock.addDays(day, -r.int(0, 3));
      const who = schedule === 'X' ? pharmacist : r.pick(counter);
      const when = clock.at(day, minutes);
      const patientName = regular?.name || walkIn;
      // The shelf has run out of it: the customer is sent elsewhere (no scan is kept).
      const need = Number(line.quantity) * (line.unit === 'strip' ? (perStrip || 1) : 1);
      const usable = await repo.one(db, `SELECT COALESCE(sum(quantity),0) AS q FROM business_stock_lots l WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND quantity>0
        AND (expires_on IS NULL OR expires_on>=$4::date) AND NOT EXISTS (SELECT 1 FROM pharmacy_recalls x WHERE x.business_id=l.business_id AND x.sku_id=l.sku_id AND x.lot_code=l.lot_code AND x.blocked)`,
      [biz.id, item.id, sim.location.id, today]);
      const done = await repo.one(db, 'SELECT 1 FROM business_documents WHERE business_id=$1 AND request_key=$2', [biz.id, base.key(biz.id, forcedX ? `rx-x-sale-${day}` : `rx-sale-${day}-${n}`)]);
      if (!done && Number(usable.q) < need) continue;
      try {
        await base.once(biz.id, 'business_documents', forcedX ? `rx-x-sale-${day}` : `rx-sale-${day}-${n}`, (requestKey) => at(biz.id, when, async () => {
          const pdf = prescriptionPdf([doctorName, `Reg. No. ${doctorRegNo}`, doctorAddress, `Date: ${prescribedOn}`, `Patient: ${patientName}`, 'Rx',
            `${item.meta.drug[0]} ${item.meta.drug[1]}`, `Sig: as directed, ${r.int(3, 10)} days`]);
          const file = await h.addPrescriptionFile(who.business, who.user, { buffer: pdf, size: pdf.length, originalname: `prescription-${day}-${n + 1}.pdf` });
          return pharmacy.sell(who.business, who.user, {
            requestKey, locationId: sim.location.id, contactId: regular?.contact.id || null, lines: [line], payment: { amount: 'full', method: r.pick(['cash', 'upi', 'upi']) },
            prescription: { patientName, patientPhone: regular?.phone || null, patientAge: r.int(19, 76), patientAddress: regular ? 'Velachery, Chennai' : r.pick(['Taramani, Chennai', 'Pallikaranai, Chennai', 'Madipakkam, Chennai']),
              doctorName, doctorRegNo, doctorAddress, prescribedOn, fileId: file.id },
            ...(schedule === 'X' || schedule === 'narcotic' ? { signoff: { signatoryId: signer.id, pin } } : {}),
          });
        }, { skip: ['prescribed_on', 'retain_until', 'expires_on'] }));
      } catch (error) {
        // The shelf ran out of that medicine on the day: the customer is sent elsewhere.
        if (!/Not enough usable stock|whole strip/.test(error.message)) throw error;
      }
    }
  }
  // Expiry returns to the distributors: one credited, one waiting for the credit note.
  // [item, reason, days ago, credited?, batch: the short-dated one or the oldest in stock]
  const returns = [['CFX-200', 'near_expiry', 3, true, 'short'], ['ALP-025', 'near_expiry', 1, false, 'short'], ['CS-100', 'breakage', 2, false, 'oldest']];
  for (const [code, reason, back, credit, which] of returns) {
    const item = sim.items.find((i) => i.code === code);
    if (!item) continue;
    const supplier = supplierOf(item);
    const lot = which === 'short'
      ? await repo.one(db, 'SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND lot_code=$3', [biz.id, item.id, `${item.meta.lotPrefix}S1`])
      : await repo.one(db, 'SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND quantity>=1 ORDER BY expires_on,id LIMIT 1', [biz.id, item.id]);
    if (!lot) continue;
    const existing = await repo.one(db, 'SELECT * FROM pharmacy_debit_notes WHERE business_id=$1 AND request_key=$2', [biz.id, base.key(biz.id, `rules-return-${code}`)]);
    let note = existing;
    if (!note && Number(lot.quantity) > 0) {
      note = await at(biz.id, clock.at(clock.addDays(today, -back), sim.def.open + 120), () => pharmacy.createDebitNote(biz, owner, {
        requestKey: base.key(biz.id, `rules-return-${code}`), contactId: supplier.contact.id, reason, notes: 'Short-dated scheme stock: returned before expiry for credit',
        lines: [{ lotId: lot.id, quantity: String(reason === 'breakage' ? 1 : Math.max(1, Math.floor(Number(lot.quantity) * 0.8))) }],
        ...(reason === 'breakage' ? { notes: 'Bottle broken in the carton on delivery' } : {}) }), { skip: ['expires_on', 'credit_note_date'] });
    }
    if (note && credit && note.status === 'sent') {
      const day = clock.addDays(today, -back + 2);
      await at(biz.id, clock.at(day, sim.def.open + 90), () => pharmacy.creditDebitNote(biz, owner, note.id, {
        creditNoteNo: `${supplier.billPrefix}/CN/${day.slice(5, 7)}${day.slice(8, 10)}`, creditNoteDate: day,
        amount: (Math.round(Number(note.claimed) * 0.98 * 100) / 100).toFixed(2) }), { touch: [['pharmacy_debit_notes', 'id', note.id]] });
    }
  }
  // A recall of a Cetirizine batch already sold out: every buyer is found, the batch blocked.
  const ctz = sim.items.find((i) => i.code === 'CTZ-10');
  if (ctz && !await repo.one(db, 'SELECT 1 FROM pharmacy_recalls WHERE business_id=$1 AND sku_id=$2', [biz.id, ctz.id])) {
    const lot = await repo.one(db, `SELECT l.lot_code FROM business_stock_lots l WHERE l.business_id=$1 AND l.sku_id=$2 AND l.quantity=0
      AND EXISTS (SELECT 1 FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id AND d.kind='sale' AND d.contact_id IS NOT NULL
        WHERE dl.business_id=l.business_id AND dl.sku_id=l.sku_id AND dl.lot_code=l.lot_code) ORDER BY l.id DESC LIMIT 1`, [biz.id, ctz.id]);
    if (lot) {
      await at(biz.id, clock.at(clock.addDays(today, -2), sim.def.open + 75), () => pharmacy.createRecall(biz, owner, {
        skuId: ctz.id, lotCode: lot.lot_code, reason: 'Drug alert: batch declared not of standard quality (dissolution)', reference: 'CDSCO NSQ alert, Sep 2026', block: true }));
    }
  }
}

// --- Clinic and lab ----------------------------------------------------------------------------

// [code, name, sample, container, sku code, parameters: [name, unit, decimals, ranges, type?]]
// ranges: [sex, ageFrom, ageTo, low, high, criticalLow, criticalHigh] or { text }.
const R = (low, high, cl = null, ch = null, sex = 'any', from = 0, to = 150) => ({ sex, ageFrom: from, ageTo: to, low, high, criticalLow: cl, criticalHigh: ch });
const LAB_TESTS = [
  ['CBC', 'Complete blood count (CBC)', 'blood', 'EDTA (purple top)', 'LB-CBC', [
    ['Haemoglobin', 'g/dL', 1, [R(12, 15.5, 7, 20, 'female', 13), R(13.5, 17.5, 7, 20, 'male', 13), R(11.5, 15.5, 7, 20, 'any', 1, 13)]],
    ['Total WBC count', 'cells/µL', 0, [R(4000, 11000, 2000, 30000)]],
    ['Neutrophils', '%', 0, [R(40, 75)]], ['Lymphocytes', '%', 0, [R(20, 45)]],
    ['Platelet count', 'lakh/µL', 2, [R(1.5, 4.5, 0.5, 10)]],
    ['RBC count', 'million/µL', 2, [R(3.8, 4.8, null, null, 'female', 13), R(4.5, 5.5, null, null, 'male', 13), R(4.0, 5.2, null, null, 'any', 1, 13)]],
    ['PCV (haematocrit)', '%', 1, [R(36, 46, null, null, 'female', 13), R(40, 50, null, null, 'male', 13), R(35, 45, null, null, 'any', 1, 13)]],
    ['MCV', 'fL', 1, [R(83, 101)]]]],
  ['FBS', 'Fasting blood sugar', 'plasma', 'Fluoride (grey top)', 'LB-FBS', [['Glucose, fasting', 'mg/dL', 0, [R(70, 100, 50, 400)]]]],
  ['HBA1C', 'HbA1c (glycated haemoglobin)', 'blood', 'EDTA (purple top)', 'LB-HBA1C', [['HbA1c', '%', 1, [R(4, 5.6)]]]],
  ['LIPID', 'Lipid profile', 'serum', 'Plain (red top)', 'LB-LIPID', [['Total cholesterol', 'mg/dL', 0, [R(null, 200)]], ['Triglycerides', 'mg/dL', 0, [R(null, 150, null, 1000)]],
    ['HDL cholesterol', 'mg/dL', 0, [R(50, null, null, null, 'female'), R(40, null, null, null, 'male')]], ['LDL cholesterol', 'mg/dL', 0, [R(null, 100)]], ['VLDL cholesterol', 'mg/dL', 0, [R(5, 40)]]]],
  ['THY', 'Thyroid profile (T3, T4, TSH)', 'serum', 'Plain (red top)', 'LB-THY', [['T3, total', 'ng/dL', 0, [R(80, 200)]], ['T4, total', 'µg/dL', 1, [R(5.1, 14.1)]], ['TSH', 'µIU/mL', 2, [R(0.27, 4.2, null, 50)]]]],
  ['LFT', 'Liver function test (LFT)', 'serum', 'Plain (red top)', 'LB-LFT', [['Bilirubin, total', 'mg/dL', 2, [R(0.3, 1.2, null, 15)]], ['Bilirubin, direct', 'mg/dL', 2, [R(null, 0.3)]],
    ['SGOT (AST)', 'U/L', 0, [R(null, 40)]], ['SGPT (ALT)', 'U/L', 0, [R(null, 41)]], ['Alkaline phosphatase', 'U/L', 0, [R(44, 147)]], ['Total protein', 'g/dL', 1, [R(6.4, 8.3)]], ['Albumin', 'g/dL', 1, [R(3.5, 5.2)]]]],
  ['NS1', 'Dengue NS1 antigen', 'serum', 'Plain (red top)', 'LB-NS1', [['Dengue NS1 antigen', null, 0, [{ text: 'Negative' }], 'text']]],
];
const PROFILES = [['MHC', 'Master health check-up', 'PK-MHC', ['CBC', 'FBS', 'LIPID', 'LFT', 'THY']]];

const CONSULTS = {
  gp: [['Fever with sore throat and body ache for 2 days', 'Acute upper respiratory infection', 'J06.9', [['Paracetamol', '650 mg', '1 tab', '1-1-1', '3 days', 'After food, if fever'], ['Cetirizine', '10 mg', '1 tab', '0-0-1', '5 days', 'At night']]],
    ['Burning in the upper abdomen after meals for a week', 'Gastritis', 'K29.7', [['Pantoprazole', '40 mg', '1 tab', '1-0-0', '14 days', 'Before breakfast'], ['Antacid suspension', '', '10 ml', '1-1-1', '7 days', 'After food']]],
    ['Headache and giddiness; high BP at the pharmacy', 'Essential (primary) hypertension', 'I10', [['Amlodipine', '5 mg', '1 tab', '1-0-0', '30 days', 'Same time daily']]],
    ['Low back pain after lifting, no radiation', 'Low back pain', 'M54.5', [['Ibuprofen', '400 mg', '1 tab', '1-0-1', '5 days', 'After food'], ['Diclofenac gel', '', 'Local application', '1-0-1', '7 days', '']]],
    ['High fever with chills and joint pain for 3 days', 'Viral fever, dengue to be ruled out', 'B34.9', [['Paracetamol', '650 mg', '1 tab', '1-1-1', '5 days', 'Avoid NSAIDs; plenty of fluids'], ['ORS', '', '1 sachet in 1 L water', 'Sips through the day', '3 days', '']]]],
  paed: [['Cough and running nose for 3 days, no breathlessness', 'Acute upper respiratory infection', 'J06.9', [['Paracetamol syrup', '250 mg/5 ml', '5 ml', 'SOS', '3 days', 'If temperature above 100 °F'], ['Saline nasal drops', '0.65%', '2 drops each nostril', '1-1-1', '5 days', '']]],
    ['Loose stools 4 times since yesterday, taking feeds', 'Acute gastroenteritis', 'A09', [['ORS', '', '50–100 ml after each loose stool', 'SOS', '3 days', ''], ['Zinc syrup', '20 mg/5 ml', '5 ml', '1-0-0', '14 days', '']]],
    ['Ear pain since last night, fever', 'Otitis media', 'H66.9', [['Amoxicillin + clavulanic acid syrup', '228.5 mg/5 ml', '5 ml', '1-0-1', '5 days', 'Complete the course']]]],
  diab: [['Review of diabetes; tiredness, more thirst', 'Type 2 diabetes mellitus without complications', 'E11.9', [['Metformin', '500 mg SR', '1 tab', '1-0-1', '30 days', 'After food'], ['Glimepiride', '1 mg', '1 tab', '1-0-0', '30 days', 'Before breakfast']]],
    ['Weight gain, feeling cold, hair fall', 'Hypothyroidism', 'E03.9', [['Thyroxine', '50 mcg', '1 tab', '1-0-0', '60 days', 'Empty stomach, 30 min before breakfast']]],
    ['Diabetes review with high BP readings at home', 'Type 2 diabetes with hypertension', 'E11.9', [['Metformin', '500 mg SR', '1 tab', '1-0-1', '30 days', 'After food'], ['Telmisartan', '40 mg', '1 tab', '1-0-0', '30 days', '']]]],
};

// A value for one parameter: inside the patient's range, or (when `odd`) out of it.
function valueFor(param, range, r, odd) {
  if (!range) return null;
  if (param.result_type === 'text') return odd ? 'Positive' : range.normal_text || 'Negative';
  const low = range.low === null ? null : Number(range.low), high = range.high === null ? null : Number(range.high);
  let value;
  if (!odd) {
    if (low !== null && high !== null) value = low + (high - low) * (0.15 + r.next() * 0.7);
    else if (high !== null) value = high * (0.55 + r.next() * 0.4);
    else value = low * (1.1 + r.next() * 0.5);
  } else if (high !== null && (low === null || r.chance(0.7))) value = high * (1.08 + r.next() * 0.5);
  else value = low * (0.6 + r.next() * 0.3);
  return Number(value.toFixed(param.decimals));
}

async function ensureLabCatalogue(sim) {
  const biz = sim.business, owner = sim.owner;
  const skuOf = (code) => sim.items.find((i) => i.code === code)?.id || null;
  const ids = {};
  for (const [code, name, sample, container, skuCode, params] of LAB_TESTS) {
    const found = await repo.one(db, 'SELECT id FROM lab_tests WHERE business_id=$1 AND code=$2', [biz.id, code]);
    if (found) { ids[code] = found.id; continue; }
    const test = await lab.saveTest(biz, owner, null, { code, name, sampleType: sample, container, skuId: skuOf(skuCode), method: sample === 'blood' && code === 'CBC' ? 'Automated cell counter' : undefined,
      turnaroundHours: code === 'HBA1C' || code === 'THY' ? 24 : 6,
      parameters: params.map(([pname, unit, decimals, ranges, type]) => ({ name: pname, unit, decimals, resultType: type || 'numeric',
        ranges: ranges.map((x) => (x.text ? { normalText: x.text } : x)) })) });
    ids[code] = test.id;
  }
  for (const [code, name, skuCode, members] of PROFILES) {
    if (await repo.one(db, 'SELECT 1 FROM lab_tests WHERE business_id=$1 AND code=$2', [biz.id, code])) continue;
    await lab.saveTest(biz, owner, null, { code, name, kind: 'profile', skuId: skuOf(skuCode), testIds: members.map((m) => ids[m]) });
  }
}

const genderOf = new Map();
for (const [region, n, seed] of [['telugu', 120, 'clinic'], ['hyderabadi', 40, 'clinic-h'], ['north', 30, 'clinic-n']]) {
  for (const p of people(region, n, seed)) genderOf.set(p.name, p.gender === 'f' ? 'female' : 'male');
}

async function clinicRules(sim) {
  const biz = sim.business, owner = sim.owner, today = sim.realToday;
  await h.saveSettings(biz, owner, { labName: 'Sanjeevani Diagnostics', labRegistration: 'Telangana CE Reg. No. TS/HYD/CE/2024/0187',
    reportFooter: 'Results relate only to the sample tested. Please correlate clinically. Reports are also sent on WhatsApp to patients who agreed to it.' });
  // Doctors sign with their council registration; the pathologist approves reports by PIN.
  const DOCTOR_STAFF = [['ravi', 'gp', 'MBBS, MD (General Medicine)', 'TSMC 31248'], ['swathi', 'paed', 'MBBS, DCH', 'TSMC 45791'], ['faisal', 'diab', 'MBBS, MD, Fellowship in Diabetology', 'TSMC 52063']];
  for (const [login, key, qualification, reg] of DOCTOR_STAFF) {
    const person = sim.staff.find((s) => s.login === login);
    if (!person || await repo.one(db, "SELECT 1 FROM health_signatories WHERE business_id=$1 AND kind='doctor' AND user_id=$2", [biz.id, person.user.id])) continue;
    await h.saveSignatory(biz, owner, { kind: 'doctor', userId: person.user.id, name: sim.extra.doctors[key].name, qualification, registrationNo: reg, council: 'Telangana State Medical Council', resourceId: sim.extra.doctors[key].id });
  }
  const pathologist = sim.staff.find((s) => s.role === 'pathologist');
  const pin = await ensurePin(pathologist);
  let signer = await repo.one(db, "SELECT * FROM health_signatories WHERE business_id=$1 AND kind='pathologist' AND user_id=$2", [biz.id, pathologist.user.id]);
  if (!signer) signer = await h.saveSignatory(biz, owner, { kind: 'pathologist', userId: pathologist.user.id, name: pathologist.name, qualification: 'MBBS, MD (Pathology)', registrationNo: 'TSMC 40266', council: 'Telangana State Medical Council' });
  await ensureLabCatalogue(sim);
  await doctorProfiles(sim);
  const desk = sim.staff.find((s) => s.role === 'cashier');
  const tech = sim.staff.find((s) => s.role === 'lab_technician');
  const doctorFor = (resourceId) => {
    const key = Object.keys(sim.extra.doctors).find((k) => String(sim.extra.doctors[k].id) === String(resourceId));
    const login = { gp: 'ravi', paed: 'swathi', diab: 'faisal' }[key];
    return { key, person: sim.staff.find((s) => s.login === login) };
  };
  // Every person who came in is a registered patient, with consent taken at the first visit.
  const firsts = await repo.all(db, `SELECT a.contact_id,min(a.starts_at) AS first_at,bool_or(s.code='CN-PAED') AS child,bool_or(s.code='CN-DIAB') AS diabetic
    FROM business_appointments a JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
    WHERE a.business_id=$1 AND a.status IN ('completed','booked') GROUP BY a.contact_id`, [biz.id]);
  const patientInfo = new Map();
  for (const f of firsts) {
    const contact = await repo.one(db, 'SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2', [biz.id, f.contact_id]);
    const r = clock.rng(`${sim.code}|patient|${contact.name}`);
    patientInfo.set(String(contact.id), { child: f.child, diabetic: f.diabetic });
    if (await repo.one(db, 'SELECT 1 FROM health_patients WHERE business_id=$1 AND contact_id=$2', [biz.id, contact.id])) continue;
    const when = new Date(Math.min(Date.now() - 60000, new Date(f.first_at).getTime() - 10 * 60000));
    const age = f.child ? r.int(1, 12) : f.diabetic ? r.int(38, 72) : r.int(18, 68);
    const purposes = ['treatment', ...(r.chance(0.65) ? ['reports_digital'] : []), ...(r.chance(0.3) ? ['reminders'] : [])];
    await at(biz.id, when, () => clinicSvc.register(desk.business, desk.user, { contactId: contact.id, sex: genderOf.get(contact.name) || r.pick(['female', 'male']),
      ageYears: age, guardianName: f.child ? `${r.pick(['Srinivas', 'Lakshmi', 'Mohd. Imran', 'Ayesha Begum', 'Rajesh'])} (parent)` : null,
      consent: { purposes, method: r.chance(0.8) ? 'signed_form' : 'verbal', givenBy: f.child ? 'Parent' : 'Self' } }));
    await db.query('UPDATE health_patients SET created_at=$3,updated_at=$3 WHERE business_id=$1 AND contact_id=$2', [biz.id, contact.id, when]);
  }
  // Two patients later withdrew their consent for reminders (kept as given, withdrawal recorded).
  const reminders = await repo.all(db, "SELECT id,contact_id FROM health_consents WHERE business_id=$1 AND purpose='reminders' ORDER BY id LIMIT 2", [biz.id]);
  for (const k of reminders) {
    const row = await repo.one(db, 'SELECT withdrawn_at FROM health_consents WHERE business_id=$1 AND id=$2', [biz.id, k.id]);
    if (row.withdrawn_at) continue;
    await at(biz.id, clock.at(clock.addDays(today, -6), '11:30'), () => clinicSvc.withdrawConsent(desk.business, desk.user, k.id, { reason: 'Does not want SMS / WhatsApp reminders' }),
      { touch: [['health_consents', 'id', k.id]] });
  }
  // Consultations of the last ten days, linked to their appointment and bill, with lab orders.
  const testIdOf = new Map((await repo.all(db, 'SELECT id,sku_id,code,kind FROM lab_tests WHERE business_id=$1 AND sku_id IS NOT NULL', [biz.id])).map((t) => [String(t.sku_id), t]));
  const appointments = await repo.all(db, `SELECT a.* FROM business_appointments a WHERE a.business_id=$1 AND a.status='completed' AND a.starts_at >= $2 AND a.starts_at < now()
    ORDER BY a.starts_at`, [biz.id, clock.at(clock.addDays(today, -10), '00:00')]);
  const todays = appointments.filter((a) => clock.at(today, '00:00') <= new Date(a.starts_at));
  for (const a of appointments) {
    const r = clock.rng(`${sim.code}|visit|${a.id}`);
    const { key: doctorKey, person: doctor } = doctorFor(a.resource_id);
    if (!doctor) continue;
    const info = patientInfo.get(String(a.contact_id)) || {};
    const startsAt = new Date(a.starts_at);
    const leaveOpen = todays.length && (a.id === todays[todays.length - 1]?.id);
    let visit = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND appointment_id=$2', [biz.id, a.id]);
    if (!visit) {
      visit = await at(biz.id, new Date(startsAt.getTime() - 5 * 60000), () => clinicSvc.openVisit(desk.business, desk.user, { appointmentId: a.id }));
    }
    if (visit.status === 'open' && !visit.complaints) {
      const [complaints, diagnosis, icd, items] = r.pick(CONSULTS[doctorKey] || CONSULTS.gp);
      const child = doctorKey === 'paed' || info.child;
      const visitDay = startsAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const followUp = ['I10', 'E11.9', 'E03.9'].includes(icd) || r.chance(0.2) ? clock.addDays(visitDay, r.pick([7, 14, 30])) : null;
      await at(biz.id, new Date(startsAt.getTime() + 6 * 60000), () => clinicSvc.saveVisit(doctor.business, doctor.user, visit.id, {
        bpSystolic: child ? null : icd === 'I10' ? r.int(146, 168) : r.int(112, 136), bpDiastolic: child ? null : icd === 'I10' ? r.int(92, 104) : r.int(72, 86),
        pulse: r.int(68, 104), temperatureC: /fever|Fever/.test(complaints) ? (37.8 + r.next() * 1.4).toFixed(1) : (36.5 + r.next() * 0.6).toFixed(1), spo2: r.int(95, 99),
        weightKg: child ? (8 + r.next() * 20).toFixed(1) : (52 + r.next() * 34).toFixed(1), heightCm: child ? null : (152 + r.next() * 28).toFixed(1),
        complaints, diagnosis, icd10Code: icd, examination: r.pick(['General condition fair, no pallor or icterus', 'Chest clear, abdomen soft', 'Throat congested, chest clear', 'Mild epigastric tenderness']),
        advice: r.pick(['Plenty of fluids and rest', 'Low-salt diet, walk 30 minutes daily', 'Avoid oily and spicy food', 'Review with reports']),
        prescription: items.map(([drugName, strength, dose, frequency, duration, instructions]) => ({ drugName, strength, dose, frequency, duration, instructions })),
        followUpOn: followUp }), { touch: [['health_visits', 'id', visit.id]] });
      visit = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2', [biz.id, visit.id]);
    }
    // The doctor is still writing up today's last patient.
    if (visit.status === 'open' && !leaveOpen) {
      await at(biz.id, new Date(startsAt.getTime() + 9 * 60000), () => clinicSvc.saveVisit(doctor.business, doctor.user, visit.id, { complete: true }), { touch: [['health_visits', 'id', visit.id]] });
      visit = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2', [biz.id, visit.id]);
    }
    // The bill raised at the desk for this appointment.
    if (!visit.document_id) {
      const doc = await repo.one(db, `SELECT id FROM business_documents WHERE business_id=$1 AND kind='sale' AND contact_id=$2 AND created_at BETWEEN $3 AND $4
        AND NOT EXISTS (SELECT 1 FROM health_visits v WHERE v.business_id=$1 AND v.document_id=business_documents.id) ORDER BY created_at LIMIT 1`,
      [biz.id, a.contact_id, startsAt, new Date(startsAt.getTime() + 40 * 60000)]);
      if (doc) await clinicSvc.billVisit(desk.business, desk.user, visit.id, { documentId: doc.id });
      visit = await repo.one(db, 'SELECT * FROM health_visits WHERE business_id=$1 AND id=$2', [biz.id, visit.id]);
    }
    if (!visit.document_id) continue;
    // Tests on that bill become a lab order.
    const testLines = (await repo.all(db, 'SELECT sku_id FROM business_document_lines WHERE business_id=$1 AND document_id=$2', [biz.id, visit.document_id]))
      .map((l) => testIdOf.get(String(l.sku_id))).filter(Boolean);
    if (!testLines.length) continue;
    const step = `lab-order-${visit.id}`;
    const ordered = await base.once(biz.id, 'lab_orders', step, (requestKey) => at(biz.id, new Date(startsAt.getTime() + 15 * 60000), () => lab.createOrder(desk.business, desk.user, {
      requestKey, locationId: sim.location.id, visitId: visit.id, documentId: visit.document_id, testIds: testLines.map((t) => t.id), referredBy: doctor.name,
      priority: testLines.some((t) => t.code === 'NS1') ? 'urgent' : 'routine' })));
    await labProgress(sim, ordered.row.id, startsAt, { tech, pathologist, signer, pin, diabetic: info.diabetic || doctorKey === 'diab' });
  }
  // Patients who come only for tests (no consultation): billed at the desk, sample taken at once.
  const walkIns = await repo.all(db, `SELECT p.contact_id FROM health_patients p WHERE p.business_id=$1
    AND EXISTS (SELECT 1 FROM health_consents k WHERE k.business_id=p.business_id AND k.contact_id=p.contact_id AND k.purpose='treatment' AND k.withdrawn_at IS NULL)
    ORDER BY p.patient_no LIMIT 60`, [biz.id]);
  const labOnly = (await repo.all(db, "SELECT id,code FROM lab_tests WHERE business_id=$1 AND sku_id IS NOT NULL AND active ORDER BY code", [biz.id]));
  for (let back = 3; back >= 0; back -= 1) {
    const day = clock.addDays(today, -back);
    if (clock.weekday(day) === 0) continue;
    const r = clock.rng(`${sim.code}|lab-walk-in|${day}`);
    for (let n = 0; n < 4; n += 1) {
      const minutes = 8 * 60 + 30 + n * 75 + r.int(0, 30);
      if (back === 0 && minutes > clock.minutesNow() - 20) continue;
      const patient = r.pick(walkIns);
      const tests = [r.pick(labOnly), ...(r.chance(0.4) ? [r.pick(labOnly)] : [])];
      const when = clock.at(day, minutes);
      const ordered = await base.once(biz.id, 'lab_orders', `lab-walk-in-${day}-${n}`, (requestKey) => at(biz.id, when, () => lab.createOrder(desk.business, desk.user, {
        requestKey, locationId: sim.location.id, contactId: patient.contact_id, testIds: [...new Set(tests.map((t) => t.id))], bill: true,
        payment: { amount: 'full', method: r.pick(['upi', 'cash', 'card']) }, referredBy: r.pick(['Self', 'Dr. P. Srinivas (outside)', 'Dr. N. Lavanya (outside)']) })));
      await labProgress(sim, ordered.row.id, when, { tech, pathologist, signer, pin, diabetic: tests.some((t) => t.code === 'HBA1C') });
    }
  }
}

// How far an order has got: everything older than yesterday is reported; a
// few of yesterday's wait for the pathologist; today's are spread over every
// stage (and the odd one cancelled), as a lab's day looks. Seeded by the order,
// so a rerun only ever moves an order forward.
const STAGES = ['ordered', 'collected', 'received', 'in_process', 'resulted', 'approved'];
async function stopFor(sim, order) {
  const day = new Date(order.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  if (day < clock.addDays(sim.realToday, -1)) return 'approved';
  const r = clock.rng(`${sim.code}|lab-stage|${order.id}`);
  if (day < sim.realToday) return r.pick(['approved', 'approved', 'resulted']);
  // Today: the earlier an order came in, the further it has got (counted from
  // the morning, so an order keeps its place as more arrive).
  const earlier = (await repo.one(db, `SELECT count(*)::int AS n FROM lab_orders WHERE business_id=$1 AND id<$2
    AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=$3::date`, [sim.business.id, order.id, day])).n;
  if (earlier % 7 === 6) return 'cancelled';
  return STAGES[STAGES.length - 1 - (earlier % 7)];
}

async function labProgress(sim, orderId, startsAt, { tech, pathologist, signer, pin, diabetic }) {
  const biz = sim.business;
  // Its own seeded numbers, so a rerun makes the same choices for this order.
  const r = clock.rng(`${sim.code}|lab|${orderId}`);
  const order = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2', [biz.id, orderId]);
  if (['approved', 'cancelled'].includes(order.status)) return;
  const stop = await stopFor(sim, order);
  const time = (minutes) => {
    const t = new Date(startsAt.getTime() + minutes * 60000);
    return t.getTime() > Date.now() - 60000 ? new Date(Date.now() - 60000) : t;
  };
  if (stop === 'cancelled') {
    if (order.status !== 'ordered') return;
    await at(biz.id, time(25), () => lab.cancelOrder(tech.business, tech.user, order.id, { reason: 'Patient could not stay for the sample; will come tomorrow fasting' }), { touch: [['lab_orders', 'id', order.id]] });
    return;
  }
  const samples = await repo.all(db, 'SELECT * FROM lab_samples WHERE business_id=$1 AND order_id=$2 ORDER BY id', [biz.id, order.id]);
  const upTo = (s) => STAGES.indexOf(stop) >= STAGES.indexOf(s);
  const statusOf = async (sampleId) => (await repo.one(db, 'SELECT status FROM lab_samples WHERE business_id=$1 AND id=$2', [biz.id, sampleId])).status;
  for (const s of samples) {
    if (upTo('collected') && await statusOf(s.id) === 'awaited') {
      await at(biz.id, time(20), () => lab.sampleAction(tech.business, tech.user, s.id, { action: 'collect' }), { touch: [['lab_samples', 'id', s.id], ['lab_orders', 'id', order.id]] });
    }
    if (upTo('received') && await statusOf(s.id) === 'collected') {
      await at(biz.id, time(45), () => lab.sampleAction(tech.business, tech.user, s.id, { action: 'receive' }), { touch: [['lab_samples', 'id', s.id], ['lab_orders', 'id', order.id]] });
    }
  }
  // A dengue test some days goes to the outside reference lab.
  const codes = (await repo.all(db, `SELECT t.code FROM lab_order_tests ot JOIN lab_tests t ON t.business_id=ot.business_id AND t.id=ot.test_id
    WHERE ot.business_id=$1 AND ot.order_id=$2`, [biz.id, order.id])).map((t) => t.code);
  if (!order.outside_lab && codes.includes('NS1') && r.chance(0.5)) {
    await at(biz.id, time(50), () => lab.refer(tech.business, tech.user, order.id, { outsideLab: 'Deccan Reference Laboratory, Ameerpet', referenceNo: `DRL-${String(order.id).padStart(6, '0')}`, outsideCharge: '420' }),
      { touch: [['lab_orders', 'id', order.id]] });
  }
  if (!upTo('in_process')) return;
  const full = await repo.one(db, 'SELECT * FROM lab_orders WHERE business_id=$1 AND id=$2', [biz.id, order.id]);
  if (full.status === 'approved') return;
  const patient = await repo.one(db, 'SELECT * FROM health_patients WHERE business_id=$1 AND contact_id=$2', [biz.id, order.contact_id]);
  const ageDays = h.ageOn(patient, sim.realToday).days;
  const results = [];
  const params = await repo.all(db, `SELECT ot.id AS "orderTestId",t.code,p.id AS parameter_id,p.name,p.result_type,p.decimals,r.id AS result_id
    FROM lab_order_tests ot JOIN lab_tests t ON t.business_id=ot.business_id AND t.id=ot.test_id
    JOIN lab_parameters p ON p.business_id=ot.business_id AND p.test_id=ot.test_id AND p.active
    LEFT JOIN lab_results r ON r.business_id=ot.business_id AND r.order_test_id=ot.id AND r.parameter_id=p.id
    WHERE ot.business_id=$1 AND ot.order_id=$2 ORDER BY ot.id,p.sort_order,p.id`, [biz.id, order.id]);
  const partial = stop === 'in_process';
  for (const [index, p] of params.entries()) {
    if (p.result_id) continue;
    if (partial && index >= Math.ceil(params.length / 2)) break;
    const ranges = await repo.all(db, 'SELECT * FROM lab_reference_ranges WHERE business_id=$1 AND parameter_id=$2', [biz.id, p.parameter_id]);
    const range = lab.rangeFor(ranges, patient.sex, ageDays);
    const glucose = /Glucose|HbA1c/.test(p.name) && diabetic;
    const odd = glucose ? r.chance(0.75) : r.chance(p.code === 'NS1' ? 0.2 : 0.12);
    const value = valueFor({ result_type: p.result_type, decimals: p.decimals }, range, r, odd);
    if (value !== null) results.push({ orderTestId: p.orderTestId, parameterId: p.parameter_id, value: String(value) });
  }
  if (results.length) {
    await at(biz.id, time(180), () => lab.enterResults(tech.business, tech.user, order.id, { results }), { touch: [['lab_orders', 'id', order.id]] });
  }
  if (!upTo('approved')) return;
  const now = await repo.one(db, 'SELECT status FROM lab_orders WHERE business_id=$1 AND id=$2', [biz.id, order.id]);
  if (now.status === 'resulted') {
    await at(biz.id, time(240), () => lab.approve(pathologist.business, pathologist.user, order.id, { signoff: { signatoryId: signer.id, pin } }),
      { touch: [['lab_orders', 'id', order.id]] });
  }
}

// Round 3: each doctor's fee, follow-up rule and OPD (the clinic is open
// 9 to 9, Monday to Saturday: a morning and an evening session each).
const DOCTOR_FEES = { gp: ['CN-GP', 'CN-FUP', 7, 60, 'General physician'], paed: ['CN-PAED', null, 5, 65, 'Paediatrician'], diab: ['CN-DIAB', 'CN-FUP', 10, 70, 'Diabetologist'] };
async function doctorProfiles(sim) {
  const biz = sim.business, owner = sim.owner;
  const skuOf = async (code) => (code ? (await repo.one(db, 'SELECT id FROM catalog_skus WHERE business_id=$1 AND code=$2', [biz.id, code]))?.id : null);
  for (const [key, [consult, followUp, days, share, speciality]] of Object.entries(DOCTOR_FEES)) {
    const doctor = sim.extra.doctors[key];
    if (!doctor) continue;
    const sessions = [1, 2, 3, 4, 5, 6].flatMap((dow) => [{ dow, starts: '09:00', ends: '14:00', maxPatients: 40 }, { dow, starts: '14:00', ends: '21:00', maxPatients: 50 }]);
    await desk.saveDoctor(biz, owner, doctor.id, { speciality, consultationSkuId: await skuOf(consult), followUpSkuId: await skuOf(followUp), followUpDays: days, slotMinutes: 10,
      sharePercent: share, sessions });
  }
  // Visits billed before the fees were set up: how they were charged, read
  // from their bill (as linking a desk bill does), for the earnings report.
  await db.query(`UPDATE health_visits v SET fee_kind=x.kind,fee_sku_id=x.sku_id FROM (
      SELECT DISTINCT ON (v2.id) v2.id,l.sku_id,CASE WHEN l.sku_id=p.follow_up_sku_id THEN 'follow_up' ELSE 'consultation' END AS kind
      FROM health_visits v2 JOIN health_doctor_profiles p ON p.business_id=v2.business_id AND p.resource_id=v2.resource_id
      JOIN business_document_lines l ON l.business_id=v2.business_id AND l.document_id=v2.document_id AND l.sku_id IN (p.consultation_sku_id,p.follow_up_sku_id)
      WHERE v2.business_id=$1 AND v2.fee_kind IS NULL ORDER BY v2.id,l.id) x WHERE v.business_id=$1 AND v.id=x.id`, [biz.id]);
}

// Today's queue: the patients booked in the next hours have arrived and hold
// a token; each doctor is seeing the first of them.
async function todaysTokens(sim) {
  const biz = sim.business;
  const front = sim.staff.find((s) => s.role === 'cashier');
  const coming = await repo.all(db, `SELECT a.id,a.resource_id FROM business_appointments a JOIN health_patients p ON p.business_id=a.business_id AND p.contact_id=a.contact_id
    JOIN businesses b ON b.id=a.business_id
    WHERE a.business_id=$1 AND a.status='booked' AND (a.starts_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date
      AND a.starts_at BETWEEN now() - interval '30 minutes' AND now() + interval '150 minutes'
      AND EXISTS (SELECT 1 FROM health_consents k WHERE k.business_id=a.business_id AND k.contact_id=a.contact_id AND k.purpose='treatment' AND k.withdrawn_at IS NULL)
    ORDER BY a.starts_at`, [biz.id]);
  const issued = [];
  for (const a of coming) {
    try { issued.push(await desk.issueToken(front.business, front.user, { appointmentId: a.id })); } catch { /* already in the queue */ }
  }
  // Most patients walk in: during OPD hours each doctor has a few waiting.
  const minutes = clock.minutesNow();
  if (clock.weekday(sim.realToday) !== 0 && minutes >= 9 * 60 && minutes < 20 * 60 + 30) {
    const r = clock.rng(`${sim.code}|tokens|${sim.realToday}`);
    const patients = await repo.all(db, `SELECT p.contact_id FROM health_patients p WHERE p.business_id=$1
      AND EXISTS (SELECT 1 FROM health_consents k WHERE k.business_id=p.business_id AND k.contact_id=p.contact_id AND k.purpose='treatment' AND k.withdrawn_at IS NULL)
      ORDER BY p.contact_id`, [biz.id]);
    for (const key of ['gp', 'paed', 'diab']) {
      const doctor = sim.extra.doctors?.[key];
      if (!doctor) continue;
      for (let n = 0; n < (key === 'gp' ? 5 : 3); n += 1) {
        const patient = r.pick(patients);
        try {
          issued.push(await desk.issueToken(front.business, front.user, { contactId: patient.contact_id, resourceId: doctor.id, priority: r.chance(0.12),
            note: r.chance(0.3) ? r.pick(['Fever since 2 days', 'Review with reports', 'BP check', 'Child: cough and cold', 'Sugar review']) : undefined }));
        } catch { /* already waiting today */ }
      }
    }
  }
  // Each doctor is seeing their first patient.
  const logins = { gp: 'ravi', paed: 'swathi', diab: 'faisal' };
  for (const [key, login] of Object.entries(logins)) {
    const doctor = sim.extra.doctors?.[key];
    const person = sim.staff.find((s) => s.login === login);
    if (!doctor || !person) continue;
    const busy = await repo.one(db, `SELECT 1 FROM health_tokens t JOIN businesses b ON b.id=t.business_id WHERE t.business_id=$1 AND t.resource_id=$2
      AND t.day=(now() AT TIME ZONE b.timezone)::date AND t.status IN ('called','in_consultation')`, [biz.id, doctor.id]);
    const first = issued.filter((t) => String(t.resource_id) === String(doctor.id) && t.status === 'waiting').sort((a, b) => a.token_no - b.token_no)[0];
    if (busy || !first) continue;
    try { await desk.tokenAction(person.business, person.user, first.id, { action: 'start' }); } catch { /* left waiting */ }
  }
}

// QC: two control levels for haemoglobin and fasting glucose, run every
// morning for the last three weeks (one failed run and its re-run), and today.
const QC_CONTROLS = [['CBC', 'Haemoglobin', 'Bio-Rad Lyphochek Haematology', 'HM-24071', 'Level 1', 8.2, 0.25], ['CBC', 'Haemoglobin', 'Bio-Rad Lyphochek Haematology', 'HM-24071', 'Level 2', 13.6, 0.35],
  ['FBS', 'Glucose, fasting', 'Bio-Rad Lyphochek Assayed Chemistry', 'CH-26114', 'Level 1', 92, 3.2], ['FBS', 'Glucose, fasting', 'Bio-Rad Lyphochek Assayed Chemistry', 'CH-26114', 'Level 2', 268, 8.5]];
async function qualityControl(sim) {
  const biz = sim.business, today = sim.realToday;
  const tech = sim.staff.find((s) => s.role === 'lab_technician');
  for (const [code, parameterName, name, lot, level, mean, sd] of QC_CONTROLS) {
    const parameter = await repo.one(db, `SELECT p.id FROM lab_parameters p JOIN lab_tests t ON t.business_id=p.business_id AND t.id=p.test_id WHERE p.business_id=$1 AND t.code=$2 AND p.name=$3`,
      [biz.id, code, parameterName]);
    if (!parameter) continue;
    let material = await repo.one(db, 'SELECT * FROM lab_qc_materials WHERE business_id=$1 AND parameter_id=$2 AND lot_no=$3 AND level=$4', [biz.id, parameter.id, lot, level]);
    if (!material) material = await quality.saveMaterial(biz, sim.owner, null, { parameterId: parameter.id, name, lotNo: lot, level, mean, sd, expiresOn: clock.addDays(today, 150) });
    const r = clock.rng(`${sim.code}|qc|${material.id}`);
    // The history (each run judged by the same Westgard rules as at the bench).
    if (!await repo.one(db, 'SELECT 1 FROM lab_qc_runs WHERE business_id=$1 AND material_id=$2', [biz.id, material.id])) {
      const zs = [];
      for (let back = 21; back >= 1; back -= 1) {
        const day = clock.addDays(today, -back);
        if (clock.weekday(day) === 0) continue;
        let z = (r.next() + r.next() + r.next() - 1.5) * 1.3;
        if (back === 12 && level === 'Level 2' && code === 'FBS') z = 3.4;
        z = Math.round(z * 1000) / 1000;
        const judged = quality.westgard(z, [...zs].reverse(), []);
        const when = clock.at(day, 8 * 60 + r.int(0, 25));
        await db.query(`INSERT INTO lab_qc_runs(business_id,material_id,parameter_id,value,z,rules,outcome,note,corrective_action,run_at,entered_by,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10)`, [biz.id, material.id, parameter.id, (mean + z * sd).toFixed(4), z, judged.rules, judged.outcome,
          judged.outcome === 'rejected' ? 'Control out on the morning run' : null, null, when, tech.user.id]);
        zs.push(z);
        if (judged.outcome === 'rejected') {
          const fixed = Math.round((r.next() - 0.5) * 1000) / 1000;
          await db.query(`INSERT INTO lab_qc_runs(business_id,material_id,parameter_id,value,z,rules,outcome,note,corrective_action,run_at,entered_by,created_at)
            VALUES($1,$2,$3,$4,$5,'{}','accepted',NULL,$6,$7,$8,$7)`, [biz.id, material.id, parameter.id, (mean + fixed * sd).toFixed(4), fixed,
            'Recalibrated the analyser and opened a fresh control vial', new Date(when.getTime() + 40 * 60000), tech.user.id]);
          zs.push(fixed);
        }
      }
    }
    // This morning's run, at the bench.
    const ran = await repo.one(db, `SELECT 1 FROM lab_qc_runs r JOIN businesses b ON b.id=r.business_id WHERE r.business_id=$1 AND r.material_id=$2
      AND (r.run_at AT TIME ZONE b.timezone)::date=(now() AT TIME ZONE b.timezone)::date`, [biz.id, material.id]);
    if (!ran && clock.weekday(today) !== 0) {
      const z = level === 'Level 1' && code === 'CBC' ? 2.3 : (r.next() - 0.5) * 1.6;
      await quality.recordRun(tech.business, tech.user, { materialId: material.id, value: (mean + z * sd).toFixed(3) }).catch(() => {});
    }
  }
}

async function clinicDesk(sim) {
  await todaysTokens(sim);
  await qualityControl(sim);
}

module.exports = { pharmacyRules, clinicRules, clinicDesk, otcBasket, LAB_TESTS };
