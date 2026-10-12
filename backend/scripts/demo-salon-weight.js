// Salon & spa and weight-based shop sample data (Phase 2, T4), added by
// setup-business-demos.js --sample-data. Safe to run again on a demo in any
// state: it finds or creates what it builds on (the base catalogue, its
// categories, the sample supplier and clients), finds services, stylists,
// plans and yield templates by code or name, and posts each bill, booking,
// cutting batch and wastage entry once (request keys; see demo-common.js).
// A salon's settings, service times and stylist skills are set only where
// none are set yet, so a tester's own changes stay. Everything goes through
// the same services as the API (number series, stock ledger, events, audit,
// deposits as collections). People, phone numbers and figures are fictional.
const repo = require('../src/modules/business/core/repositories/business.repository');
const service = require('../src/modules/business/core/services/business.service');
const salon = require('../src/modules/business/salon-weight/services/businessSalon.service');
const weight = require('../src/modules/business/salon-weight/services/businessWeight.service');
const retail = require('../src/modules/business/retail/services/businessRetail.service');
const common = require('./demo-common');

const { once } = common;
const pick = (list, n) => list[n % list.length];

// A wall-clock time in the business's own time zone, `days` from today.
async function at(db, business, days, hhmm) {
  const row = await repo.one(db, `SELECT (((now() AT TIME ZONE $1)::date + $2::int)::text || ' ' || $3)::timestamp AT TIME ZONE $1 AS t`, [business.timezone, days, hhmm]);
  return new Date(row.t).toISOString();
}
async function item(business, user, { name, code, unit, price, categoryName, kind = 'goods', tracking = 'quantity', taxRate = 0, reorderLevel = '0' }) {
  const existing = await common.skuByCode(business, code);
  if (existing) return existing;
  const slab = await repo.one(repo.pool, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=$2 AND active ORDER BY id LIMIT 1', [business.id, taxRate]);
  return service.createCatalog(business, user, { name, code, kind, unit, tracking: kind === 'service' ? 'none' : tracking, price: String(price), taxRateId: slab?.id,
    categoryId: (await common.category(business, user, categoryName)).id, reorderLevel });
}
// Moves the given documents (made by this run) back in time, oldest first.
async function backdate(db, business, ids, hoursApart) {
  if (!ids.length) return;
  await db.query(`UPDATE business_documents d SET created_at = now() - ((x.n) * $3::int * interval '1 hour')
    FROM (SELECT id, row_number() OVER (ORDER BY id DESC) AS n FROM business_documents WHERE business_id=$1 AND id = ANY($2::bigint[])) x
    WHERE d.business_id=$1 AND d.id=x.id`, [business.id, ids, hoursApart]);
  await db.query(`UPDATE salon_line_staff ls SET created_at=d.created_at FROM business_documents d
    WHERE d.business_id=ls.business_id AND d.id=ls.document_id AND ls.business_id=$1 AND ls.document_id = ANY($2::bigint[])`, [business.id, ids]);
}

// --- Salon & spa ----------------------------------------------------------------------------

async function sampleSalon(business, user) {
  if (business.business_type !== 'salon' || !business.modules.includes('appointments')) return;
  const db = repo.pool;
  await common.baseCatalogue(business, user);
  const location = await common.firstLocation(business);
  const exists = async (sql, values = []) => Boolean(await repo.one(db, sql, [business.id, ...values]));

  if (!await exists('SELECT 1 FROM salon_settings WHERE business_id=$1')) {
    await salon.saveSettings(business, user, { depositPercent: '20', freeCancelHours: 4, lateCancelFeePercent: '50', noShowFeePercent: '100', opensAt: '09:00', closesAt: '21:00' });
  }

  // Services with their times; a few more than the base sample.
  const services = [
    { name: 'Haircut', code: 'SV-CUT', price: 350, categoryName: 'Hair', minutes: 45, buffer: 15 },
    { name: 'Hair spa', code: 'SV-SPA', price: 1200, categoryName: 'Hair', minutes: 60, buffer: 10 },
    { name: 'Classic facial', code: 'SV-FAC', price: 1500, categoryName: 'Skin', minutes: 60, buffer: 15, room: true },
    { name: 'Global hair colour', code: 'SV-CLR', price: 2800, categoryName: 'Hair', minutes: 120, buffer: 15 },
    { name: 'Beard trim', code: 'SV-BRD', price: 150, categoryName: 'Hair', minutes: 20, buffer: 10 },
    { name: 'Manicure', code: 'SV-MAN', price: 500, categoryName: 'Hands & feet', minutes: 40, buffer: 10 },
    { name: 'Pedicure', code: 'SV-PED', price: 700, categoryName: 'Hands & feet', minutes: 50, buffer: 10 },
  ];
  const sku = {};
  for (const s of services) {
    sku[s.code] = await item(business, user, { ...s, unit: 'service', kind: 'service', taxRate: 18 });
    if (!await exists('SELECT 1 FROM salon_services WHERE business_id=$1 AND sku_id=$2', [sku[s.code].id])) {
      await salon.saveService(business, user, sku[s.code].id, { durationMinutes: s.minutes, bufferMinutes: s.buffer, needsRoom: Boolean(s.room) });
    }
  }
  const shampoo = await item(business, user, { name: 'Keratin shampoo 250 ml', code: 'RT-SHA', unit: 'each', price: 550, categoryName: 'Retail products', taxRate: 18, reorderLevel: '4' });
  const oil = await common.skuByCode(business, 'RT-OIL');
  const supplier = await common.contact(business, user, 'supplier', 'Glow Beauty Distributors', '98300 33333', { creditDays: 15 });
  if (!await common.legacy(business, 'business_documents', "notes='Retail shelf top-up (sample)'")) {
    await once(business, 'business_documents', 'salon-shelf', (requestKey) => service.document(business, user, { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey,
      notes: 'Retail shelf top-up (sample)', lines: [{ skuId: shampoo.id, quantity: '24', unitPrice: '330' }, ...(oil ? [{ skuId: oil.id, quantity: '12', unitPrice: '420' }] : [])] }));
  }

  // Stylists and rooms, found by name; their skills set only where none are set.
  const make = async (name, roleLabel) => await repo.one(db, 'SELECT * FROM business_resources WHERE business_id=$1 AND name=$2 ORDER BY id LIMIT 1', [business.id, name])
    || service.resource(business, user, { name, roleLabel, locationId: location.id });
  const priya = await make('Priya', 'Senior stylist');
  const arjun = await make('Arjun', 'Stylist');
  const neha = await make('Neha', 'Beauty therapist');
  const room1 = await make('Spa room 1', 'Room');
  const room2 = await make('Spa room 2', 'Room');
  const profile = async (who, body) => {
    if (!await exists('SELECT 1 FROM salon_resource_profiles WHERE business_id=$1 AND resource_id=$2', [who.id])) await salon.saveStaff(business, user, who.id, body);
  };
  await profile(priya, { kind: 'staff', skuIds: ['SV-CUT', 'SV-SPA', 'SV-CLR', 'SV-FAC'].map((c) => sku[c].id) });
  await profile(arjun, { kind: 'staff', skuIds: ['SV-CUT', 'SV-BRD', 'SV-SPA'].map((c) => sku[c].id) });
  await profile(neha, { kind: 'staff', skuIds: ['SV-FAC', 'SV-MAN', 'SV-PED'].map((c) => sku[c].id) });
  await profile(room1, { kind: 'room', skuIds: [] });
  await profile(room2, { kind: 'room', skuIds: [] });

  // Commission rules: everyone 10% on services and 5% on products; Priya 15%;
  // Neha 12% on facials. Added only when the salon has none.
  if (business.modules.includes('commissions') && !await exists('SELECT 1 FROM salon_commission_rules WHERE business_id=$1')) {
    await salon.createRule(business, user, { appliesTo: 'service', percent: '10' });
    await salon.createRule(business, user, { appliesTo: 'goods', percent: '5' });
    await salon.createRule(business, user, { resourceId: priya.id, appliesTo: 'service', percent: '15' });
    await salon.createRule(business, user, { resourceId: neha.id, appliesTo: 'service', skuId: sku['SV-FAC'].id, percent: '12' });
  }

  const clients = [];
  for (const [name, phone] of [['Ananya Sharma', '98860 11001'], ['Kavya Reddy', '98860 11002'], ['Rohan Mehta', '98860 11003'], ['Lakshmi Iyer', '98200 55555'],
    ['Sunita Deshpande', '98200 33333'], ['Mohammed Irfan', '98200 44444'], ['Divya Nair', '98860 11004']]) clients.push(await common.contact(business, user, 'customer', name, phone));
  const staffFor = (code) => (['SV-FAC', 'SV-MAN', 'SV-PED'].includes(code) ? neha : code === 'SV-BRD' ? arjun : code === 'SV-CLR' ? priya : null);
  const billOnce = (step, contact, lines, payment, extra = {}) => once(business, 'business_documents', step, async (requestKey) => {
    const quote = await salon.quote(business, user, { locationId: location.id, contactId: contact?.id || null, lines, ...extra });
    const paid = await salon.bill(business, user, { locationId: location.id, contactId: contact?.id || null, requestKey, lines, ...extra,
      payment: { amount: payment(quote), method: extra.method || 'upi' } });
    return paid.document;
  });

  // Older bills over the last three weeks: services by their stylists, some products.
  const older = [];
  const mixes = [['SV-CUT'], ['SV-SPA', 'RT-SHA'], ['SV-FAC'], ['SV-CLR'], ['SV-CUT', 'SV-BRD'], ['SV-MAN', 'SV-PED'], ['SV-CUT', 'RT-OIL'], ['SV-SPA'], ['SV-FAC', 'SV-MAN'], ['SV-CUT']];
  const oldBills = await common.legacy(business, 'business_documents', "kind='sale' AND id IN (SELECT document_id FROM salon_line_staff ls WHERE ls.business_id=business_documents.business_id)");
  for (let n = 0; n < 16 && !oldBills; n += 1) {
    const codes = pick(mixes, n).filter((c) => sku[c] || c === 'RT-SHA' || (c === 'RT-OIL' && oil));
    const lines = codes.map((code) => {
      if (code === 'RT-SHA') return { skuId: shampoo.id, quantity: '1', staffId: pick([priya, arjun], n).id };
      if (code === 'RT-OIL') return { skuId: oil.id, quantity: '1', staffId: arjun.id };
      return { skuId: sku[code].id, quantity: '1', staffId: (staffFor(code) || pick([priya, arjun], n)).id };
    });
    const client = n % 4 === 3 ? null : pick(clients.slice(4), n);
    try {
      const bill = await billOnce(`salon-bill-${n}`, client, lines, (q) => q.total, { method: pick(['upi', 'card', 'cash'], n) });
      if (bill.created) older.push(bill.row.id);
    } catch (error) {
      if (!/stock/i.test(error.message)) throw error;
    }
  }
  await backdate(db, business, older, 30);

  // Plans, found by name.
  const createPlan = async (body) => (await repo.one(db, 'SELECT * FROM salon_plans WHERE business_id=$1 AND name=$2', [business.id, body.name]))
    || salon.createPlan(business, user, body);
  const hairSpa5 = await createPlan({ kind: 'package', name: 'Hair spa × 5', price: '5000', validityDays: 180,
    description: 'Five hair spa sessions, six months', services: [{ skuId: sku['SV-SPA'].id, sessions: 5 }] });
  const bridal = await createPlan({ kind: 'package', name: 'Bridal glow', price: '6500', validityDays: 90,
    description: 'Three facials, manicures and pedicures before the big day',
    services: [{ skuId: sku['SV-FAC'].id, sessions: 3 }, { skuId: sku['SV-MAN'].id, sessions: 3 }, { skuId: sku['SV-PED'].id, sessions: 3 }] });
  const gold = await createPlan({ kind: 'membership', name: 'Gold membership', price: '2000', validityDays: 365,
    serviceDiscountPercent: '15', productDiscountPercent: '10', description: '15% off services, 10% off products for a year' });
  await createPlan({ kind: 'membership', name: 'Silver membership', price: '1000', validityDays: 180,
    serviceDiscountPercent: '10', productDiscountPercent: '5', description: '10% off services, 5% off products for six months' });
  const planSku = async (plan) => (await repo.one(db, 'SELECT sku_id FROM salon_plans WHERE business_id=$1 AND id=$2', [business.id, plan.id])).sku_id;
  const [ananya, kavya, rohan, lakshmi] = clients;
  // Today: plans sold, then used.
  if (!await common.legacy(business, 'business_documents', "kind='sale' AND id IN (SELECT document_id FROM salon_client_plans cp WHERE cp.business_id=business_documents.business_id)")) {
    const full = (q) => q.total;
    await billOnce('salon-plan-0', ananya, [{ skuId: await planSku(hairSpa5), quantity: '1', staffId: priya.id }], full, { method: 'upi' });
    await billOnce('salon-plan-1', kavya, [{ skuId: await planSku(bridal), quantity: '1', staffId: neha.id }], full, { method: 'card' });
    await billOnce('salon-plan-2', lakshmi, [{ skuId: await planSku(gold), quantity: '1' }], full, { method: 'cash' });
    const pkgOf = async (contact) => repo.one(db, "SELECT id FROM salon_client_plans WHERE business_id=$1 AND contact_id=$2 AND kind='package' ORDER BY id DESC LIMIT 1", [business.id, contact.id]);
    const ananyaPkg = await pkgOf(ananya);
    if (ananyaPkg) await billOnce('salon-plan-use-0', ananya, [{ skuId: sku['SV-SPA'].id, quantity: '1', staffId: priya.id, clientPlanId: ananyaPkg.id }, { skuId: shampoo.id, quantity: '1', staffId: priya.id }], full, { method: 'upi' });
    const kavyaPkg = await pkgOf(kavya);
    if (kavyaPkg) await billOnce('salon-plan-use-1', kavya, [{ skuId: sku['SV-FAC'].id, quantity: '1', staffId: neha.id, clientPlanId: kavyaPkg.id }, { skuId: sku['SV-MAN'].id, quantity: '1', staffId: neha.id, clientPlanId: kavyaPkg.id }], full, { method: 'card' });
    await billOnce('salon-plan-use-2', lakshmi, [{ skuId: sku['SV-CLR'].id, quantity: '1', staffId: priya.id }, { skuId: shampoo.id, quantity: '1', staffId: priya.id }], full, { method: 'card' });
  }

  // Bookings: today and the next days, some with deposits. Each is booked once
  // (its request key); what happens to it (no-show, cancelled, billed) only
  // when it is booked now.
  if (await common.legacy(business, 'salon_appointment_details')) {
    console.log(`  ${business.name}: salon sample — bookings were made earlier`);
    return;
  }
  // A slot already taken (by the tester, or a booking made on an earlier day) is skipped.
  const book = async (step, contact, code, staff, startsAt, extra = {}, { strict = false } = {}) => {
    try {
      return await once(business, 'salon_appointment_details', step, (requestKey) => salon.book(business, user,
        { contactId: contact.id, skuId: sku[code].id, resourceId: staff.id, startsAt, requestKey, ...extra }));
    } catch (error) {
      if (strict || !/already (has an appointment|booked)|has already passed/i.test(error.message)) throw error;
      return null;
    }
  };
  const appointmentId = (result) => (result.created ? result.row.id : result.row.appointment_id);
  const deposit = (amount, method = 'upi') => ({ deposit: { amount, method } });
  const done = await book('salon-book-done', rohan, 'SV-CUT', arjun, await at(db, business, 0, '10:00'), deposit('100'));
  await book('salon-book-2', clients[6], 'SV-FAC', neha, await at(db, business, 0, '12:00'), { roomId: room1.id, ...deposit('300', 'cash') });
  await book('salon-book-3', clients[4], 'SV-CUT', priya, await at(db, business, 0, '15:00'));
  await book('salon-book-4', ananya, 'SV-SPA', priya, await at(db, business, 0, '17:30'));
  await book('salon-book-5', kavya, 'SV-PED', neha, await at(db, business, 0, '16:00'));
  await book('salon-book-6', lakshmi, 'SV-FAC', neha, await at(db, business, 1, '11:00'), { roomId: room2.id, ...deposit('300') });
  await book('salon-book-7', rohan, 'SV-BRD', arjun, await at(db, business, 1, '18:00'));
  await book('salon-book-8', clients[6], 'SV-MAN', neha, await at(db, business, 2, '10:30'));
  const lateCancel = await book('salon-book-late-cancel', clients[4], 'SV-CLR', priya, await at(db, business, 0, '18:45'), deposit('500', 'card'));
  await book('salon-book-10', kavya, 'SV-FAC', neha, await at(db, business, 3, '11:00'), { roomId: room1.id });
  // The no-show: a booking whose time has already passed (today if the day has
  // begun, else late yesterday), so marking it no-show is allowed. Booked last,
  // in the first free slot.
  const noShow = await bookPast(db, business, (startsAt) => book('salon-book-no-show', clients[5], 'SV-SPA', priya, startsAt, deposit('300'), { strict: true }));
  if (noShow?.created) await salon.setStatus(business, user, noShow.row.id, { status: 'no_show', requestKey: common.stableKey(business.id, 'salon-no-show') });
  if (lateCancel?.created) await salon.setStatus(business, user, lateCancel.row.id, { status: 'cancelled', requestKey: common.stableKey(business.id, 'salon-late-cancel') });
  // Rohan's haircut done: billed with his deposit put against it.
  const doneId = done && appointmentId(done);
  const billed = doneId && await repo.one(db, 'SELECT bill_document_id FROM salon_appointment_details WHERE business_id=$1 AND appointment_id=$2', [business.id, doneId]);
  if (doneId && !billed?.bill_document_id) {
    const lines = [{ skuId: sku['SV-CUT'].id, quantity: '1', staffId: arjun.id, appointmentId: doneId }];
    await billOnce('salon-bill-done', rohan, lines, (q) => (Number(q.total) - 100).toFixed(2), { appointmentIds: [doneId], useAdvance: true, method: 'cash' });
  }
  console.log(`  ${business.name}: ${services.length} timed services, 3 stylists and 2 rooms, 4 plans, ${older.length} new older bills, 11 bookings`);
}
// Books at the latest slot that has already started: today from 09:00 if the
// day has begun, else yesterday evening (bookings up to a day back are allowed).
async function bookPast(db, business, tryBook) {
  const now = await repo.one(db, `SELECT to_char(now() AT TIME ZONE $1,'HH24')::int AS h`, [business.timezone]);
  const slots = [];
  for (let h = Math.min(19, now.h - 1); h >= 9; h -= 1) slots.push([0, `${String(h).padStart(2, '0')}:00`]);
  slots.push([-1, '19:00'], [-1, '18:00']);
  for (const [days, time] of slots) {
    try {
      return await tryBook(await at(db, business, days, time));
    } catch (error) {
      if (!/already|passed|books from/i.test(error.message)) throw error;
    }
  }
  return null;
}

// --- Meat, seafood and other weight-based shops --------------------------------------------------

const WEIGHT_PLANS = {
  meat: {
    items: [
      { name: 'Whole chicken (dressed)', code: 'CH-WHL', price: 210, categoryName: 'Chicken', tracking: 'batch', cost: '150', receive: '60' },
      { name: 'Chicken liver & gizzard', code: 'CH-LVR', price: 180, categoryName: 'Chicken', tracking: 'batch' },
      { name: 'Chicken curry cut', code: 'CH-CUR', price: 260, categoryName: 'Chicken', tracking: 'batch' },
      { name: 'Boneless chicken', code: 'CH-BNL', price: 380, categoryName: 'Chicken', tracking: 'batch' },
      { name: 'Whole Rohu (uncleaned)', code: 'FS-RWH', price: 200, categoryName: 'Fish', tracking: 'batch', cost: '140', receive: '25' },
      { name: 'Rohu fish', code: 'FS-ROH', price: 240, categoryName: 'Fish', tracking: 'batch' },
    ],
    templates: [
      { name: 'Dressed chicken → curry cut', input: 'CH-WHL', outputs: [['CH-CUR', '85'], ['CH-LVR', '5']] },
      { name: 'Dressed chicken → boneless', input: 'CH-WHL', outputs: [['CH-BNL', '58'], ['CH-LVR', '5']] },
      { name: 'Rohu → cleaned cut pieces', input: 'FS-RWH', outputs: [['FS-ROH', '72']] },
    ],
    // [template index, input kg, [[cut, kg]…]]
    batches: [[0, '12', [['CH-CUR', '10.150'], ['CH-LVR', '0.640']]], [1, '8', [['CH-BNL', '4.480'], ['CH-LVR', '0.410']]],
      [2, '9', [['FS-ROH', '6.390']]], [0, '10', [['CH-CUR', '8.400'], ['CH-LVR', '0.520']]], [1, '6', [['CH-BNL', '3.420'], ['CH-LVR', '0.300']]]],
    sales: [['CH-CUR', '1.000'], ['CH-CUR', '0.750'], ['CH-BNL', '0.500'], ['FS-ROH', '1.250'], ['CH-CUR', '2.000'], ['CH-LVR', '0.250'], ['CH-BNL', '1.000'], ['FS-ROH', '0.800']],
    wastage: [['CH-CUR', '0.350', 'unsold'], ['FS-ROH', '0.400', 'spoiled'], ['CH-BNL', '0.120', 'trimming'], ['CH-WHL', '0.600', 'drip_loss'], ['CH-LVR', '0.150', 'spoiled']],
  },
  weight_retail: {
    items: [
      { name: 'Almonds (bulk, unsorted)', code: 'DF-ALB', price: 760, categoryName: 'Dry fruits', tracking: 'batch', cost: '610', receive: '30' },
      { name: 'Almond broken pieces', code: 'DF-ALP', price: 520, categoryName: 'Dry fruits', tracking: 'batch' },
      { name: 'Almonds', code: 'DF-ALM', price: 820, categoryName: 'Dry fruits', tracking: 'batch' },
      { name: 'Raisins', code: 'DF-RAI', price: 360, categoryName: 'Dry fruits', tracking: 'batch', cost: '240', receive: '20' },
    ],
    templates: [{ name: 'Bulk almonds → sorted', input: 'DF-ALB', outputs: [['DF-ALM', '90'], ['DF-ALP', '7']] }],
    batches: [[0, '10', [['DF-ALM', '9.050'], ['DF-ALP', '0.680']]], [0, '8', [['DF-ALM', '7.150'], ['DF-ALP', '0.600']]]],
    sales: [['DF-ALM', '0.500'], ['DF-ALM', '0.250'], ['DF-ALP', '1.000'], ['DF-RAI', '0.500'], ['DF-ALM', '1.000'], ['DF-RAI', '0.250']],
    wastage: [['DF-RAI', '0.300', 'spoiled'], ['DF-ALP', '0.080', 'damaged'], ['DF-ALM', '0.050', 'other', 'Sample tasting at the counter']],
  },
};

async function sampleWeight(business, user) {
  const plan = WEIGHT_PLANS[business.business_type];
  if (!plan || !business.modules.includes('processing') || !business.modules.includes('wastage')) return;
  const db = repo.pool;
  await common.baseCatalogue(business, user);
  const location = await common.firstLocation(business);
  const sku = {};
  for (const entry of plan.items) sku[entry.code] = await item(business, user, { ...entry, unit: 'kg', reorderLevel: '3' });
  // Pro pass F-24: weighing-scale codes (PLU 101, 102…) so a scale label scans at Quick bill.
  for (const [n, entry] of plan.items.entries()) {
    if (!await repo.one(db, 'SELECT 1 FROM retail_scale_items WHERE business_id=$1 AND sku_id=$2', [business.id, sku[entry.code].id])) {
      await retail.setScaleCode(business, user, sku[entry.code].id, { pluCode: String(101 + n) }).catch(() => null);
    }
  }
  const supplier = await common.contact(business, user, 'supplier', 'Fresh Farms Wholesale', '98300 44444', { creditDays: 7 });
  const expiry = await repo.one(db, `SELECT ((now() AT TIME ZONE $1)::date + $2::int)::text AS d`, [business.timezone, business.business_type === 'meat' ? 3 : 120]);
  const received = plan.items.filter((i) => i.receive);
  if (!await common.legacy(business, 'business_documents', "notes='Morning arrival (sample)'")) {
    await once(business, 'business_documents', 'weight-arrival', (requestKey) => service.document(business, user, { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey,
      notes: 'Morning arrival (sample)', lines: received.map((i) => ({ skuId: sku[i.code].id, quantity: i.receive, unitPrice: i.cost, lotCode: common.batchCode('IN', i.code), expiresOn: expiry.d })) }));
  }
  const templates = [];
  for (const t of plan.templates) {
    templates.push(await repo.one(db, 'SELECT * FROM weight_yield_templates WHERE business_id=$1 AND name=$2', [business.id, t.name]) || await weight.createTemplate(business, user, { name: t.name, inputSkuId: sku[t.input].id,
      outputs: t.outputs.map(([code, percent]) => ({ skuId: sku[code].id, expectedPercent: percent })) }));
  }
  // Cutting batches, counter sales and wastage: each group left as it is when
  // an earlier version of this script (or the tester) already made it.
  const made = { batches: [], sales: [], wastage: [] };
  if (!await common.legacy(business, 'weight_processing_batches')) {
    for (const [n, [templateIndex, inputKg, outputs]] of plan.batches.entries()) {
      const template = templates[templateIndex];
      const result = await once(business, 'weight_processing_batches', `weight-batch-${n}`, async (requestKey) => {
        const lot = await repo.one(db, 'SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND quantity>=$4 ORDER BY id LIMIT 1', [business.id, template.input_sku_id, location.id, inputKg]);
        if (!lot) return null;
        return weight.processBatch(business, user, { inputLotId: lot.id, inputQuantity: inputKg, templateId: template.id, requestKey,
          outputs: outputs.map(([code, kg]) => ({ skuId: sku[code].id, quantity: kg })), notes: 'Morning cutting (sample)' });
      });
      if (result.created && result.row) made.batches.push(result.row.id);
    }
  }
  // Counter sales of the cuts, by weight, to the sample customers.
  const customers = await common.sampleCustomers(business, user);
  if (!await common.legacy(business, 'business_documents', "kind='sale'")) {
    for (const [n, [code, kg]] of plan.sales.entries()) {
      const sale = await once(business, 'business_documents', `weight-sale-${n}`, async (requestKey) => {
        const lot = await repo.one(db, 'SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND location_id=$3 AND quantity>=$4 ORDER BY expires_on NULLS LAST,id LIMIT 1', [business.id, sku[code].id, location.id, kg]);
        if (!lot) return null;
        // Every third sale is typed in grams, as a scale shows it.
        const line = n % 3 === 1 ? { skuId: sku[code].id, quantity: String(Math.round(Number(kg) * 1000)), unit: 'g', lotCode: lot.lot_code } : { skuId: sku[code].id, quantity: kg, lotCode: lot.lot_code };
        const contactId = n % 2 ? pick(customers, n)?.id || null : null;
        return service.document(business, user, { kind: 'sale', locationId: location.id, contactId, requestKey, lines: [line], ...common.walkInPays(contactId, pick(['cash', 'upi'], n)) });
      });
      if (!sale.row) continue;
      await common.pay(business, user, sale.row, `weight-sale-${n}-paid`, { amount: sale.row.total, method: pick(['cash', 'upi'], n) });
      if (sale.created) made.sales.push(sale.row.id);
    }
  }
  if (!await common.legacy(business, 'weight_wastage_entries')) {
    for (const [n, [code, quantity, reason, note]] of plan.wastage.entries()) {
      const entry = await once(business, 'weight_wastage_entries', `weight-wastage-${n}`, async (requestKey) => {
        const lot = await repo.one(db, 'SELECT * FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 AND quantity>=$3 ORDER BY id LIMIT 1', [business.id, sku[code].id, quantity]);
        if (!lot) return null;
        return weight.recordWastage(business, user, { lotId: lot.id, quantity, reason, note, requestKey });
      });
      if (entry.created && entry.row) made.wastage.push(entry.row.id);
    }
  }
  // Spread what this run made over the last few days (the newest stays today).
  const spread = (table, ids, hours) => (ids.length ? db.query(`UPDATE ${table} t SET created_at = now() - ((x.n - 1) * interval '${hours} hours')
    FROM (SELECT id, row_number() OVER (ORDER BY id DESC) AS n FROM ${table} WHERE business_id=$1 AND id = ANY($2::bigint[])) x
    WHERE t.business_id=$1 AND t.id=x.id`, [business.id, ids]) : null);
  await spread('weight_processing_batches', made.batches, 19);
  await db.query(`UPDATE weight_processing_outputs o SET created_at=b.created_at FROM weight_processing_batches b WHERE b.business_id=o.business_id AND b.id=o.batch_id
    AND o.business_id=$1 AND b.id = ANY($2::bigint[])`, [business.id, made.batches]);
  await spread('weight_wastage_entries', made.wastage, 23);
  await spread('business_documents', made.sales, 11);
  console.log(`  ${business.name}: ${templates.length} yield templates, ${made.batches.length} new cutting batches, ${made.sales.length} new weighed sales, ${made.wastage.length} new wastage entries`);
}

module.exports = { sampleSalon, sampleWeight };
