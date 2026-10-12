// Sri Venkateswara Mobiles & Electronics, Dilsukhnagar, Hyderabad: handsets
// and TVs tracked by IMEI / serial number with the maker's warranty
// registered at the sale, accessories, and a repair desk with jobs in every
// state. Phones, TVs and accessories 18 % GST (TVs moved to 18 % in GST 2.0).
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const service = require('../../../src/modules/business/core/services/business.service');
const electronics = require('../../../src/modules/business/fashion-electronics/services/businessElectronics.service');
const repairs = require('../../../src/modules/business/fashion-electronics/services/businessRepairs.service');
const refunds = require('../../../src/modules/business/salon-weight/services/businessAdvanceRefunds');
const { volume, items, regulars, supplier, gstin, people, mobile } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');
const machine = require('../machine');

// A valid 15-digit IMEI from a 14-digit body (Luhn check digit).
function imei(body14) {
  const total = [...body14].reduce((sum, c, i) => { let d = Number(c); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } return sum + d; }, 0);
  return body14 + ((10 - (total % 10)) % 10);
}

const MODELS = [
  // [label, code, MRP, price, cost (ex-GST), TAC (8 digits), stock target, weight, warranty months]
  ['Nova 5G (8 GB / 128 GB), Midnight black', 'PH-NOVA5G-BK', 23999, 21999, 17150, '35881324', 6, 3, 12],
  ['Nova 5G (8 GB / 128 GB), Ocean blue', 'PH-NOVA5G-BL', 23999, 21999, 17150, '35881325', 4, 2, 12],
  ['Zenix A15 (4 GB / 64 GB)', 'PH-ZENIX-A15', 10999, 9499, 7420, '86402105', 8, 4, 12],
  ['Orbit Pro (12 GB / 256 GB)', 'PH-ORBIT-PRO', 38999, 34999, 27600, '35672418', 3, 1, 12],
  ['Kite 4G keypad phone', 'PH-KITE-4G', 1799, 1499, 1090, '35490633', 8, 2.4, 12],
];
const TVS = [['Smart LED TV 43 inch (4K)', 'TV-43-4K', 32999, 27999, 21700, 'LD43K', 3, 0.8, 24], ['Smart LED TV 32 inch', 'TV-32', 15999, 13499, 10450, 'LD32H', 3, 0.8, 24]];

const accessoryItems = items([
  ['Tempered glass screen guard', 'AC-GLASS', 'each', 299, 18, 'Accessories', 8, 'acc', { price: 199, hsn: '3919', margin: 0.7, reorder: 30, target: 120 }],
  ['Back cover (silicone)', 'AC-COVER', 'each', 349, 18, 'Accessories', 6, 'acc', { price: 249, hsn: '3926', margin: 0.65, reorder: 25, target: 100 }],
  ['Fast charger 25 W (USB-C)', 'AC-CHG25', 'each', 1199, 18, 'Accessories', 3, 'acc', { price: 899, hsn: '8504', margin: 0.4, reorder: 10, target: 40 }],
  ['USB-C cable 1 m', 'AC-CABLE', 'each', 399, 18, 'Accessories', 4, 'acc', { price: 299, hsn: '8544', margin: 0.55, reorder: 15, target: 60, pack: ['box', 20] }],
  ['Bluetooth earbuds', 'AC-EARBUDS', 'each', 2499, 18, 'Audio', 2.4, 'acc', { price: 1499, hsn: '8518', margin: 0.38, reorder: 8, target: 30 }],
  ['Wireless neckband', 'AC-NECKBAND', 'each', 1499, 18, 'Audio', 1.6, 'acc', { price: 999, hsn: '8518', margin: 0.4, reorder: 6, target: 24 }],
  ['Power bank 10,000 mAh', 'AC-POWERBANK', 'each', 1799, 18, 'Accessories', 1.6, 'acc', { price: 1299, hsn: '8507', margin: 0.35, reorder: 6, target: 24 }],
  ['Memory card 64 GB', 'AC-SD64', 'each', 999, 18, 'Accessories', 1.2, 'acc', { price: 699, hsn: '8523', margin: 0.35, reorder: 6, target: 24 }],
  ['Smartwatch (fitness)', 'AC-WATCH', 'each', 3999, 18, 'Wearables', 1, 'acc', { price: 2499, hsn: '8517', margin: 0.35, reorder: 4, target: 15 }],
  ['Display assembly, Nova 5G', 'SP-DISP-NOVA', 'each', 4200, 18, 'Spare parts', 0, 'parts', { price: 3200, hsn: '8517', margin: 0.3, reorder: 2, target: 6 }],
  ['Display assembly, Zenix A15', 'SP-DISP-ZENIX', 'each', 2400, 18, 'Spare parts', 0, 'parts', { price: 1800, hsn: '8517', margin: 0.3, reorder: 2, target: 6 }],
  ['Battery 5000 mAh (universal fit)', 'SP-BATT', 'each', 1400, 18, 'Spare parts', 0, 'parts', { price: 950, hsn: '8507', margin: 0.4, reorder: 4, target: 12 }],
  ['Charging port board', 'SP-PORT', 'each', 650, 18, 'Spare parts', 0, 'parts', { price: 450, hsn: '8517', margin: 0.45, reorder: 4, target: 12 }],
  ['Loudspeaker module', 'SP-SPEAKER', 'each', 550, 18, 'Spare parts', 0, 'parts', { price: 380, hsn: '8518', margin: 0.45, reorder: 3, target: 10 }],
  ['Repair labour', 'SV-LABOUR', 'service', 0, 18, 'Service', 0, null, { kind: 'service', price: 300, hsn: '9987', mrpPrinted: false }],
  ['Diagnosis charge', 'SV-DIAG', 'service', 0, 18, 'Service', 0, null, { kind: 'service', price: 150, hsn: '9987', mrpPrinted: false }],
  ['Software update & data backup', 'SV-SOFTWARE', 'service', 0, 18, 'Service', 0, null, { kind: 'service', price: 350, hsn: '9987', mrpPrinted: false }],
]);
const serialItems = [...MODELS.map(([label, code, mrp, price, cost, tac, target, w, months]) => [label, code, 'each', mrp, 18, 'Mobiles', 0, 'phones', { price, cost, tac, phoneTarget: target, sellW: w, months, hsn: '8517', tracking: 'serial' }]),
  ...TVS.map(([label, code, mrp, price, cost, tac, target, w, months]) => [label, code, 'each', mrp, 18, 'Televisions', 0, 'tv', { price, cost, tac, phoneTarget: target, sellW: w, months, hsn: '8528', tracking: 'serial' }])];

// Handsets and TVs come in by the piece, each with its own number.
let serialCounter = 0;
function serialFor(sim, item, day, n) {
  serialCounter += 1;
  const stamp = `${day.slice(5, 7)}${day.slice(8, 10)}${String(n).padStart(2, '0')}`;
  if (item.code.startsWith('TV-')) return `${item.meta.tac}${day.slice(2, 4)}${stamp}`;
  return imei(`${item.meta.tac}${stamp}`);
}
async function restockSerials(sim, day, first = false) {
  // Handsets arrive twice a week; TVs on Saturdays.
  const wd = clock.weekday(day);
  for (const kind of ['phones', 'tv']) {
    if (!first && kind === 'phones' && ![1, 4].includes(wd)) continue;
    if (!first && kind === 'tv' && wd !== 6) continue;
    const supplierRow = sim.suppliers.find((s) => s.key === kind);
    const lines = [];
    for (const item of sim.items.filter((i) => i.tracking === 'serial' && i.supplier?.key === kind)) {
      const have = shop.lotsOf(sim, item.id).filter((l) => l.qty > 0).length;
      const want = item.meta.phoneTarget - have;
      for (let n = 0; n < want; n += 1) lines.push({ item, qty: 1, lotCode: serialFor(sim, item, day, n + 1), cost: item.meta.cost });
    }
    if (lines.length) await shop.receive(sim, day, sim.def.open + 30, supplierRow, lines, `purchase-${kind}-${day}`);
  }
}

// A sale: a handset (with its IMEI) and the usual add-ons, or accessories alone.
function electronicsBasket(sim, r) {
  const wanted = [];
  if (r.chance(0.38)) {
    const serial = sim.items.filter((i) => i.tracking === 'serial');
    const item = r.weighted(serial, (x) => x.meta.sellW);
    const lot = shop.lotsOf(sim, item.id).filter((l) => l.qty > 0).sort((a, b) => String(a.code).localeCompare(String(b.code)))[0];
    if (lot) {
      wanted.push({ item, qty: 1, lot, serial: true });
      if (item.code.startsWith('PH-') && !item.code.includes('KITE')) {
        if (r.chance(0.7)) wanted.push({ item: sim.items.find((i) => i.code === 'AC-GLASS'), qty: 1 });
        if (r.chance(0.55)) wanted.push({ item: sim.items.find((i) => i.code === 'AC-COVER'), qty: 1 });
        if (r.chance(0.15)) wanted.push({ item: sim.items.find((i) => i.code === 'AC-EARBUDS'), qty: 1 });
      }
      return wanted;
    }
  }
  const pool = sim.items.filter((i) => i.kind === 'goods' && i.tracking !== 'serial' && (i.meta.w ?? 0) > 0);
  for (let n = 0; n < r.int(1, 2); n += 1) wanted.push({ item: r.weighted(pool, (x) => x.meta.w), qty: 1 });
  return wanted;
}
async function electronicsSale(sim, day, p, step) {
  const wanted = electronicsBasket(sim, p.r);
  const serialLine = wanted.find((w) => w.serial);
  const lines = shop.fill(sim, wanted.filter((w) => !w.serial).filter((w, i, a) => a.findIndex((x) => x.item === w.item) === i), day);
  if (serialLine) lines.unshift({ item: serialLine.item, qty: 1, lot: serialLine.lot, line: { skuId: serialLine.item.id, quantity: '1', lotCode: serialLine.lot.code } });
  if (!lines.length) return;
  // Every handset buyer leaves a name and number for the warranty.
  const buyer = serialLine && !p.regular ? (() => { const person = people('telugu', 1, `buyer|${step}`)[0]; return { name: person.name, phone: mobile(`buyer|${step}`) }; })() : null;
  const method = serialLine && serialLine.item.price > 10000 ? p.r.weighted([['card', 4], ['upi', 4], ['bank', 1], ['cash', 1]], (x) => x[1])[0] : shop.methodOf(sim, p.r);
  await shop.bill(sim, day, { step, minutes: p.minutes, customer: p.regular, lines, udhaar: false, method, extra: buyer ? { buyer } : {} });
}

// --- The repair desk ----------------------------------------------------------------------------

const DEVICES = [['Nova 5G, black', 'PH-NOVA5G-BK'], ['Zenix A15', 'PH-ZENIX-A15'], ['Redmi Note 11, grey (customer’s own)', null], ['Vivo Y21, blue (customer’s own)', null],
  ['Samsung Galaxy M31 (customer’s own)', null], ['Realme 9, white (customer’s own)', null], ['Smart LED TV 32 inch', 'TV-32']];
const PROBLEMS = [
  ['Screen cracked after a fall, touch not working', 'display'], ['Battery drains within half a day', 'battery'], ['Not charging, port loose', 'port'],
  ['No sound on calls, speaker crackles', 'speaker'], ['Phone hangs and restarts by itself', 'software'], ['No picture, sound works', 'tvboard'],
];
// Intake on the day; each later step on its own day (most delivered within a week).
async function repairDesk(sim, day, limit) {
  const r = clock.rng(`${sim.code}|repairs|${day}`);
  const wd = clock.weekday(day);
  const count = wd === 0 ? r.int(1, 2) : r.int(2, 4);
  for (let n = 0; n < count; n += 1) {
    const minutes = sim.def.open + 30 + r.int(0, 600);
    if (minutes > limit) continue;
    const step = `repair-${day}-${n}`;
    const rr = clock.rng(`${sim.code}|${step}`);
    const [device] = rr.pick(DEVICES);
    const [problem, fault] = device.includes('TV') ? PROBLEMS[5] : rr.pick(PROBLEMS.slice(0, 5));
    const person = people(rr.chance(0.3) ? 'hyderabadi' : 'telugu', 1, step)[0];
    const estimate = { display: 4200, battery: 1500, port: 900, speaker: 800, software: 400, tvboard: 3500 }[fault];
    const promised = clock.addDays(sim.realToday, fault === 'software' ? 1 : fault === 'display' || fault === 'tvboard' ? 4 : 2);
    const who = shop.actor(sim, 'cashier', 'manager');
    const job = await shop.post(sim, 'electronics_repair_jobs', step, clock.at(day, minutes), (requestKey) => repairs.intake(who.business, who.user, {
      locationId: sim.location.id, requestKey, customerName: person.name, customerPhone: mobile(step), device, problem, accessories: rr.pick(['Back cover', 'None', 'Charger and cable', 'SIM tray']),
      conditionNotes: rr.pick(['Minor scratches on the back', 'Screen protector cracked', 'Good condition', 'Dent on one corner']), estimate: String(estimate), promisedOn: promised,
      technician: rr.pick(['Imran', 'Suresh', 'Imran']) }));
    if (!job.created) continue;
    sim.extra.repairs.push({ id: job.row.id, start: day, fault, estimate, plan: repairPlan(rr, day, fault) });
  }
  // Steps of earlier jobs that fall today.
  for (const job of sim.extra.repairs) {
    for (const stepPlan of job.plan.filter((s) => s.day === day && !s.done)) {
      const minutes = sim.def.open + 60 + stepPlan.offset;
      if (minutes > limit) continue;
      stepPlan.done = true;
      await repairStep(sim, day, minutes, job, stepPlan);
    }
  }
}
function repairPlan(r, day, fault) {
  const plan = [{ day, offset: 120, action: 'diagnosing' }];
  const parts = { display: 'SP-DISP', battery: 'SP-BATT', port: 'SP-PORT', speaker: 'SP-SPEAKER', tvboard: null, software: null }[fault];
  let d = day;
  const next = (n) => { d = clock.addDays(d, n); return d; };
  if (r.chance(0.06)) return [...plan, { day: next(1), offset: 60, action: 'cancel' }];
  if (fault === 'display' && r.chance(0.35)) plan.push({ day: next(1), offset: 30, action: 'waiting_parts' });
  plan.push({ day: next(r.int(0, 1)), offset: 200, action: 'in_repair', parts, fault });
  if (fault === 'tvboard') plan.push({ day: next(1), offset: 60, action: 'approval' });
  plan.push({ day: next(r.int(1, 2)), offset: 300, action: 'ready' });
  if (r.chance(0.97)) plan.push({ day: next(r.int(0, 3)), offset: 420, action: 'deliver' });
  return plan;
}
async function repairStep(sim, day, minutes, job, s) {
  const who = shop.actor(sim, 'manager', 'cashier');
  const when = clock.at(day, minutes);
  const item = (code) => sim.items.find((i) => i.code === code);
  try {
    if (s.action === 'cancel') {
      await machine.at(sim.business.id, when, () => repairs.cancelJob(who.business, who.user, job.id, { reason: 'Customer did not approve; returned unrepaired' }));
    } else if (s.action === 'diagnosing' || s.action === 'waiting_parts') {
      await machine.at(sim.business.id, when, () => repairs.setStatus(who.business, who.user, job.id, { status: s.action, note: s.action === 'waiting_parts' ? 'Display ordered from the distributor' : 'Checked; fault confirmed' }));
    } else if (s.action === 'in_repair') {
      await machine.at(sim.business.id, when, async () => {
        await repairs.setStatus(who.business, who.user, job.id, { status: 'in_repair' });
        const code = s.fault === 'display' ? (job.id % 2 ? 'SP-DISP-NOVA' : 'SP-DISP-ZENIX') : s.parts;
        const part = code && item(code);
        if (part && shop.onHand(sim, part.id) >= 1) {
          await repairs.addLine(who.business, who.user, job.id, { kind: 'part', skuId: part.id, quantity: '1' });
          const lot = shop.lotsOf(sim, part.id).find((l) => l.code === '');
          if (lot) lot.qty -= 1;
        }
        await repairs.addLine(who.business, who.user, job.id, { kind: 'labour', skuId: item(s.fault === 'software' ? 'SV-SOFTWARE' : 'SV-LABOUR').id, quantity: '1' });
        if (s.fault === 'tvboard') await repairs.addLine(who.business, who.user, job.id, { kind: 'labour', skuId: item('SV-LABOUR').id, quantity: '1', unitPrice: '3400' });
      });
    } else if (s.action === 'approval') {
      const detail = await repairs.detail(sim.business, job.id);
      if (detail.status === 'awaiting_approval') await machine.at(sim.business.id, when, () => repairs.approval(who.business, who.user, job.id, { decision: 'approved', note: 'Customer approved on the phone' }));
    } else if (s.action === 'ready') {
      await machine.at(sim.business.id, when, () => repairs.setStatus(who.business, who.user, job.id, { status: 'ready', note: 'Tested for an hour; customer called' }));
    } else if (s.action === 'deliver') {
      const r = clock.rng(`${sim.code}|deliver|${job.id}`);
      await machine.at(sim.business.id, when, async () => {
        const delivered = await repairs.deliver(who.business, who.user, job.id, { requestKey: base.key(sim.business.id, `deliver-${job.id}`), payment: { amount: '0', method: 'cash' } });
        if (delivered.document_id) {
          const bill = await service.detail(sim.business, delivered.document_id);
          const due = Number(bill.total) - bill.payments.reduce((t, p) => t + Number(p.amount), 0);
          if (due > 0) await service.payment(who.business, who.user, bill.id, { amount: due.toFixed(2), method: r.pick(['upi', 'cash', 'upi']), requestKey: base.key(sim.business.id, `deliver-paid-${job.id}`) });
        }
      });
    }
  } catch (error) {
    if (!/status|cannot|already|approval|estimate|stock|not/i.test(error.message)) throw error;
  }
}

// The repair board today: one just taken in, one waiting for a display and past its
// promised date, a TV waiting for the customer's OK on a higher estimate, one ready.
async function liveRepairs(sim, today) {
  const now = clock.minutesNow();
  const item = (code) => sim.items.find((i) => i.code === code);
  const who = shop.actor(sim, 'manager', 'cashier');
  const jobs = [
    { key: 'live-received', day: today, at: sim.def.open + 25, name: 'Pavani Reddy', phone: '93910 44782', device: 'Vivo Y21, blue (customer’s own)', problem: 'Not charging, port loose', estimate: '900', promise: 1, steps: [] },
    { key: 'live-parts', day: clock.addDays(today, -3), at: sim.def.open + 90, name: 'Mohd. Nawaz', phone: '98488 27311', device: 'Nova 5G, black', problem: 'Screen cracked after a fall, touch not working', estimate: '4200', promise: -1,
      steps: [['diagnosing', 0, 'Display and touch both gone'], ['waiting_parts', 1, 'Display ordered from Hyderabad Mobile Spares; supplier short this week']] },
    { key: 'live-approval', day: clock.addDays(today, -1), at: sim.def.open + 200, name: 'Ramesh Chowdary', phone: '99633 51820', device: 'Smart LED TV 43 inch (4K)', problem: 'No picture, sound works', estimate: '2500', promise: 2,
      steps: [['diagnosing', 0, 'Backlight strip and power board'], ['in_repair', 0, null, [['SV-LABOUR', '1', '3400']]]] },
    { key: 'live-ready', day: clock.addDays(today, -1), at: sim.def.open + 120, name: 'Keerthi Varma', phone: '90002 61154', device: 'Zenix A15', problem: 'Battery drains within half a day', estimate: '1500', promise: 0,
      steps: [['in_repair', 0, null, [['SP-BATT', '1'], ['SV-LABOUR', '1']]], ['ready', 0, 'Battery replaced; customer called']] },
  ];
  for (const j of jobs) {
    if (j.day === today && j.at > now) continue;
    const job = await shop.post(sim, 'electronics_repair_jobs', j.key, clock.at(j.day, j.at), (requestKey) => repairs.intake(who.business, who.user, {
      locationId: sim.location.id, requestKey, customerName: j.name, customerPhone: j.phone, device: j.device, problem: j.problem, accessories: 'None',
      estimate: j.estimate, promisedOn: clock.addDays(sim.realToday, j.promise + clock.daysBetween(j.day, today)), technician: 'Imran' }));
    if (!job.created) continue;
    for (const [n, [status, offset, note, lines]] of j.steps.entries()) {
      const when = clock.at(clock.addDays(j.day, offset), Math.min(j.at + 60 * (n + 1), now - 5 + 24 * 60 * clock.daysBetween(clock.addDays(j.day, offset), today)));
      await machine.at(sim.business.id, when, async () => {
        await repairs.setStatus(who.business, who.user, job.row.id, { status, ...(note ? { note } : {}) });
        for (const [code, quantity, unitPrice] of lines || []) {
          await repairs.addLine(who.business, who.user, job.row.id, { kind: code.startsWith('SV-') ? 'labour' : 'part', skuId: item(code).id, quantity, ...(unitPrice ? { unitPrice } : {}) });
        }
      }).catch((error) => { if (!/status|approval|estimate/i.test(error.message)) throw error; });
    }
  }
}

// Round 2 (R2-SVC): repair advances. One job taken in today with an advance
// (printed on its job card, taken off the bill at delivery); one from
// yesterday returned unrepaired, its advance refunded with the manager's
// approval. Added once to any load (constant keys).
async function repairAdvances(sim, today) {
  const now = clock.minutesNow();
  const who = shop.actor(sim, 'cashier', 'manager');
  const manager = shop.actor(sim, 'manager');
  const jobs = [
    { key: 'r2-advance-open', day: today, at: sim.def.open + 40, name: 'Srilatha Goud', phone: '94401 77215', device: 'Galaxy M14, mint green', problem: 'Display flickering, lines on screen',
      estimate: '3800', advance: '1000' },
    // Today too: a receipt is never re-dated by the time machine, so the story keeps advances to today.
    { key: 'r2-advance-cancelled', day: today, at: sim.def.open + 15, name: 'Venu Madhav', phone: '98851 40327', device: 'Redmi 12C, grey', problem: 'Dead after water exposure',
      estimate: '2600', advance: '500', cancel: 'Board damaged beyond repair; customer took the phone back' },
  ];
  for (const j of jobs) {
    if (j.day === today && j.at > now) continue;
    const job = await shop.post(sim, 'electronics_repair_jobs', j.key, clock.at(j.day, j.at), (requestKey) => repairs.intake(who.business, who.user, {
      locationId: sim.location.id, requestKey, customerName: j.name, customerPhone: j.phone, device: j.device, problem: j.problem, accessories: 'None',
      estimate: j.estimate, promisedOn: clock.addDays(today, 3), technician: 'Imran', advance: { amount: j.advance, method: 'cash' } }));
    if (!j.cancel) continue;
    const row = await repo.one(base.db, 'SELECT * FROM electronics_repair_jobs WHERE business_id=$1 AND id=$2', [sim.business.id, job.row.id]);
    const when = clock.at(j.day, Math.max(j.at + 1, Math.min(j.at + 120, now - 10)));
    if (row.status !== 'cancelled') await machine.at(sim.business.id, when, () => repairs.cancelJob(manager.business, manager.user, row.id, { reason: j.cancel }));
    await machine.at(sim.business.id, clock.at(j.day, Math.max(j.at + 2, Math.min(j.at + 130, now - 5))), () => repo.transaction(async (tx) => {
      await tx.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [sim.business.id]);
      return refunds.refundCollection(tx, sim.business, who.user, { collectionId: row.advance_collection_id, contactId: row.contact_id,
        input: { amount: null, method: 'cash', reference: null, requestKey: base.key(sim.business.id, 'r2-advance-refund') },
        approval: { reason: 'Returned unrepaired; advance handed back', approver: { id: manager.user.id, name: manager.user.name } }, source: 'repair', repairJobId: row.id, label: row.job_no });
    }));
  }
}

async function setup(sim) {
  const when = clock.at(clock.addDays(sim.realToday, -sim.def.days - 1), '12:00');
  await machine.at(sim.business.id, when, async () => {
    for (const item of sim.items.filter((i) => i.tracking === 'serial')) {
      const model = await repo.one(base.db, 'SELECT 1 FROM electronics_models WHERE business_id=$1 AND sku_id=$2', [sim.business.id, item.id]);
      if (model) continue;
      await electronics.saveModel(sim.business, sim.owner, item.id, { modelNumber: item.code.replace('PH-', '').replace('TV-', 'LED'), serialKind: item.code.startsWith('TV-') ? 'serial' : 'imei',
        warrantyMonths: item.meta.months, warrantyTerms: item.code.startsWith('TV-') ? 'Two years on the panel, one year on other parts. Installation by the shop.'
          : 'One year on manufacturing defects. Physical and liquid damage are not covered. Bring the bill.' });
    }
  }, { keepDates: true });
  sim.extra.repairs = [];
}

const electronicsDef = {
  key: 'electronics', type: 'electronics', name: 'Sri Venkateswara Mobiles & Electronics', location: 'Dilsukhnagar showroom',
  legalName: 'Sri Venkateswara Mobiles & Electronics (Prop. P. Naresh)', gstin: gstin('36', 'electronics-shop', 'P', 'N'),
  address: ['16-11-740/3, Main Road', 'Dilsukhnagar'], city: 'Hyderabad', pin: '500060', phone: '040-2414 6650', email: 'svmobiles.dsnr@gmail.com',
  receiptFooter: 'Manufacturer warranty from the date of this bill. Repairs: 30-day service warranty on replaced parts.',
  days: 90, open: 10 * 60, close: 21 * 60 + 30, margin: 0.3, regularShare: 0.1, udhaar: false, returnRate: 0.004,
  curve: [[10, 3], [11, 5], [12, 6], [13, 5], [14, 4], [15, 4], [16, 5], [17, 7], [18, 9], [19, 9], [20, 7], [21, 3]],
  volume: volume(15, { weekdays: [1.5, 0.85, 0.85, 0.9, 0.9, 1, 1.3], festivals: { '2026-08-15': 1.8, '2026-08-14': 1.4, '2026-09-13': 1.4, '2026-09-14': 1.2 },
    ranges: [['2026-09-27', '2026-10-10', 0.65], ['2026-10-03', '2026-10-31', 1.2]], growth: 0.0015 }),
  pay: { upi: 0.5, card: 0.3, cash: 0.2 },
  returnReasons: ['Earbuds not pairing, customer changed mind', 'Wrong cover model given', 'Charger not fast-charging with the phone'],
  staff: [{ name: 'Naresh Prasad', login: 'naresh', role: 'manager' }, { name: 'Sai Kumar', login: 'saikumar', role: 'cashier' }, { name: 'Imran Shaik', login: 'imran', role: 'stock_keeper' }],
  suppliers: [
    supplier('phones', 'Sri Sai Telecom Distributors', '36', 'e-phones', { prefix: 'SST', creditDays: 7, days: [1, 4], address: 'Koti, Hyderabad' }),
    supplier('tv', 'Deccan Consumer Electronics (TV division)', '36', 'e-tv', { prefix: 'DCE', creditDays: 15, days: [6], holder: 'C', address: 'Begumpet, Hyderabad' }),
    supplier('acc', 'Gupta Mobile Accessories Wholesale', '36', 'e-acc', { prefix: 'GMA', creditDays: 15, days: [3], late: 5, address: 'Jagdish Market, Abids, Hyderabad' }),
    supplier('parts', 'Hyderabad Mobile Spares', '36', 'e-parts', { prefix: 'HMS', creditDays: 7, days: [2, 5], address: 'Chenoy Trade Centre, Secunderabad' }),
  ],
  regulars: regulars('telugu', 24, 'electronics', { udhaar: [] }),
  categories: [['Mobiles'], ['Televisions'], ['Accessories'], ['Audio'], ['Wearables'], ['Spare parts'], ['Service']],
  items: [...accessoryItems, ...items(serialItems)],
  modules: [],
  hooks: {
    setup,
    firstDay: (sim, day) => restockSerials(sim, day, true),
    async morning(sim, day, closed) { if (!closed && day !== clock.addDays(sim.realToday, -sim.def.days)) await restockSerials(sim, day); },
    sale: electronicsSale,
    afternoon: repairDesk,
    async today(sim, today) {
      await liveRepairs(sim, today); await repairAdvances(sim, today);
      // Round 2 (R2-CORE): till PINs, kits and EMI sales with a financier payout.
      const round2 = require('./round2core');
      await round2.tillPins(sim); await round2.electronicsToday(sim, today);
    },
  },
};

module.exports = { electronics: electronicsDef, imei };
