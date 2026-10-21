// Glow & Grace Unisex Salon & Spa, Indiranagar, Bengaluru: stylists and
// therapists with their own skills, timed services, two spa rooms, regular
// clients with packages and memberships, commission on every service, tips,
// and the calendar for today. Salon and beauty services pay 5 % GST without
// input credit (GST 2.0); hair-care products 5 %; colour and serums 18 %.
const repo = require('../../../src/modules/business/core/repositories/business.repository');
const service = require('../../../src/modules/business/core/services/business.service');
const salon = require('../../../src/modules/business/salon-weight/services/businessSalon.service');
const salonPro = require('../../../src/modules/business/salon-weight/services/businessSalonPro.service');
const salonR2 = require('../../../src/modules/business/salon-weight/services/businessSalonRound2.service');
const refunds = require('../../../src/modules/business/salon-weight/services/businessAdvanceRefunds');
const { volume, items, regulars, supplier, gstin } = require('./common');
const clock = require('../clock');
const base = require('../base');
const shop = require('../shop');
const machine = require('../machine');

// [label, code, price (before GST), minutes, clean-up, category, weight, who: f|m|any, room]
const SERVICES = [
  ['Haircut & styling (women)', 'SV-CUT-W', 650, 45, 15, 'Hair', 6, 'f'], ['Haircut (men)', 'SV-CUT-M', 350, 30, 10, 'Hair', 8, 'm'], ['Kids haircut', 'SV-CUT-K', 250, 20, 10, 'Hair', 2, 'any'],
  ['Beard trim & shape', 'SV-BEARD', 150, 15, 5, 'Hair', 5, 'm'], ['Global hair colour', 'SV-COLOUR', 2800, 120, 15, 'Hair', 1.4, 'f'], ['Root touch-up', 'SV-ROOT', 1400, 60, 15, 'Hair', 2, 'any'],
  ['Highlights (per streak set)', 'SV-HIGHLIGHT', 3500, 120, 15, 'Hair', 0.6, 'f'], ['Keratin treatment', 'SV-KERATIN', 6500, 150, 15, 'Hair', 0.4, 'f'], ['Hair spa', 'SV-HAIRSPA', 1200, 60, 10, 'Hair', 2.4, 'any'],
  ['Head massage (20 min)', 'SV-HEADMSG', 400, 20, 5, 'Hair', 2, 'any'], ['Clean-up', 'SV-CLEANUP', 900, 40, 10, 'Skin', 2, 'f', true], ['Classic facial', 'SV-FACIAL', 1500, 60, 15, 'Skin', 1.6, 'f', true],
  ['Gold facial', 'SV-GOLDFACIAL', 2500, 75, 15, 'Skin', 0.8, 'f', true], ['Eyebrow threading', 'SV-THREAD', 60, 10, 5, 'Skin', 6, 'f'], ['Upper lip threading', 'SV-LIP', 40, 5, 5, 'Skin', 3, 'f'],
  ['Waxing: full arms', 'SV-WAX-ARMS', 450, 30, 10, 'Skin', 2, 'f'], ['Waxing: full legs', 'SV-WAX-LEGS', 700, 45, 10, 'Skin', 1.4, 'f'], ['Manicure', 'SV-MANI', 600, 40, 10, 'Hands & feet', 1.6, 'any'],
  ['Pedicure', 'SV-PEDI', 800, 50, 10, 'Hands & feet', 1.6, 'any'], ['Party make-up', 'SV-PARTYMU', 3500, 90, 15, 'Make-up', 0.3, 'f'], ['Bridal make-up', 'SV-BRIDAL', 18000, 180, 30, 'Make-up', 0.05, 'f'],
  // The rest of a full unisex salon & spa menu (16 Oct 2026).
  ['Hair wash & blow-dry', 'SV-BLOWDRY', 450, 30, 10, 'Hair', 3, 'f'], ['Hair ironing (straightening)', 'SV-IRONING', 700, 40, 10, 'Hair', 1.5, 'f'],
  ['Smoothening', 'SV-SMOOTH', 5500, 150, 15, 'Hair', 0.3, 'f'], ['Dandruff treatment', 'SV-DANDRUFF', 1500, 45, 10, 'Hair', 0.8, 'any'],
  ['Hair colour (men)', 'SV-COLOUR-M', 900, 40, 10, 'Hair', 1.2, 'm'], ['Clean shave', 'SV-SHAVE', 150, 15, 5, 'Hair', 3, 'm'],
  ['De-tan pack', 'SV-DTAN', 700, 30, 10, 'Skin', 1.6, 'any'], ['Face bleach', 'SV-BLEACH', 500, 25, 10, 'Skin', 1.2, 'f'],
  ['Full face threading', 'SV-FACETHREAD', 250, 20, 5, 'Skin', 1.5, 'f'], ['Waxing: underarms', 'SV-WAX-UA', 200, 15, 5, 'Skin', 2, 'f'],
  ["Men's facial", 'SV-FACIAL-M', 1200, 50, 10, 'Skin', 0.8, 'm', true], ['Gel nail polish', 'SV-GELNAIL', 900, 45, 10, 'Hands & feet', 1, 'f'],
  ['Spa pedicure', 'SV-SPAPEDI', 1300, 60, 10, 'Hands & feet', 0.8, 'any'], ['Saree draping', 'SV-SAREE', 600, 20, 5, 'Make-up', 0.6, 'f'],
  ['Engagement make-up', 'SV-ENGAGE', 9000, 150, 20, 'Make-up', 0.08, 'f'], ['Full body massage (60 min)', 'SV-BODYMSG', 2200, 60, 15, 'Spa', 0.6, 'any', true],
  ['Foot reflexology (30 min)', 'SV-FOOTMSG', 800, 30, 10, 'Spa', 0.8, 'any'],
];
const STAFF = [
  ['Priya Nair', 'Senior stylist', ['SV-CUT-W', 'SV-CUT-K', 'SV-COLOUR', 'SV-ROOT', 'SV-HIGHLIGHT', 'SV-KERATIN', 'SV-HAIRSPA', 'SV-PARTYMU', 'SV-BRIDAL', 'SV-SMOOTH', 'SV-BLOWDRY', 'SV-ENGAGE', 'SV-SAREE']],
  ['Arjun Shetty', 'Stylist', ['SV-CUT-M', 'SV-CUT-K', 'SV-BEARD', 'SV-ROOT', 'SV-HAIRSPA', 'SV-HEADMSG', 'SV-SHAVE', 'SV-COLOUR-M', 'SV-DANDRUFF']],
  ['Faizal Ahmed', 'Stylist', ['SV-CUT-M', 'SV-CUT-W', 'SV-BEARD', 'SV-COLOUR', 'SV-ROOT', 'SV-HEADMSG', 'SV-KERATIN', 'SV-SHAVE', 'SV-COLOUR-M', 'SV-IRONING', 'SV-BLOWDRY', 'SV-FACIAL-M']],
  ['Neha Hegde', 'Beauty therapist', ['SV-CLEANUP', 'SV-FACIAL', 'SV-GOLDFACIAL', 'SV-THREAD', 'SV-LIP', 'SV-WAX-ARMS', 'SV-WAX-LEGS', 'SV-PARTYMU', 'SV-BRIDAL', 'SV-DTAN', 'SV-BLEACH', 'SV-FACETHREAD', 'SV-FACIAL-M', 'SV-BODYMSG', 'SV-ENGAGE']],
  ['Lakshmi Gowda', 'Beauty therapist', ['SV-THREAD', 'SV-LIP', 'SV-WAX-ARMS', 'SV-WAX-LEGS', 'SV-MANI', 'SV-PEDI', 'SV-CLEANUP', 'SV-HEADMSG', 'SV-WAX-UA', 'SV-GELNAIL', 'SV-SPAPEDI', 'SV-FOOTMSG', 'SV-DTAN', 'SV-SAREE']],
];
const ROOMS = ['Spa room 1', 'Spa room 2'];

// Prices before GST (the salon quotes GST on top), so with GST they stay within the MRP.
const exGst = (mrp, gst) => Math.floor((mrp / (1 + gst / 100)) * 100) / 100;
const productItems = items([
  ['Keratin shampoo 250 ml', 'RT-SHAMPOO', 'each', 690, 5, 'Hair care', 2, 'beauty', { price: exGst(690, 5), hsn: '3305', margin: 0.38, reorder: 4, target: 16 }],
  ['Hair conditioner 250 ml', 'RT-COND', 'each', 650, 5, 'Hair care', 1.2, 'beauty', { price: exGst(650, 5), hsn: '3305', margin: 0.38, reorder: 4, target: 12 }],
  ['Argan hair serum 100 ml', 'RT-SERUM', 'each', 899, 18, 'Hair care', 1.2, 'beauty', { price: exGst(899, 18), hsn: '3305', margin: 0.4, reorder: 3, target: 10 }],
  ['Onion hair oil 200 ml', 'RT-OIL', 'each', 449, 5, 'Hair care', 1.2, 'beauty', { price: exGst(449, 5), hsn: '3305', margin: 0.4, reorder: 4, target: 12 }],
  ['Vitamin C face wash 100 ml', 'RT-FACEWASH', 'each', 399, 18, 'Skin care', 1, 'beauty', { price: exGst(399, 18), hsn: '3304', margin: 0.4, reorder: 4, target: 12 }],
  ['Sunscreen SPF 50, 80 g', 'RT-SUNSCREEN', 'each', 599, 18, 'Skin care', 0.8, 'beauty', { price: exGst(599, 18), hsn: '3304', margin: 0.4, reorder: 3, target: 10 }],
  // A fuller take-home shelf (16 Oct 2026): hair, skin, men's grooming and tools.
  ['Anti-dandruff shampoo 340 ml', 'RT-ADSHAMPOO', 'each', 499, 5, 'Hair care', 1.4, 'beauty', { price: exGst(499, 5), hsn: '3305', margin: 0.38, reorder: 4, target: 14 }],
  ['Keratin hair mask 200 g', 'RT-MASK', 'each', 799, 18, 'Hair care', 0.8, 'beauty', { price: exGst(799, 18), hsn: '3305', margin: 0.4, reorder: 3, target: 10 }],
  ['Heat protect hair spray 200 ml', 'RT-SPRAY', 'each', 549, 18, 'Hair care', 0.6, 'beauty', { price: exGst(549, 18), hsn: '3305', margin: 0.4, reorder: 2, target: 8 }],
  ['Hair colour, natural black (box)', 'RT-COLOURBOX', 'each', 245, 18, 'Hair care', 1, 'beauty', { price: exGst(245, 18), hsn: '3305', margin: 0.3, reorder: 4, target: 12 }],
  ['Daily moisturiser 100 ml', 'RT-MOIST', 'each', 449, 18, 'Skin care', 1.2, 'beauty', { price: exGst(449, 18), hsn: '3304', margin: 0.4, reorder: 4, target: 12 }],
  ['Aloe vera gel 150 g', 'RT-ALOE', 'each', 299, 18, 'Skin care', 1.2, 'beauty', { price: exGst(299, 18), hsn: '3304', margin: 0.42, reorder: 4, target: 12 }],
  ['Night repair cream 50 g', 'RT-NIGHT', 'each', 699, 18, 'Skin care', 0.6, 'beauty', { price: exGst(699, 18), hsn: '3304', margin: 0.42, reorder: 2, target: 8 }],
  ['Face scrub 100 g', 'RT-SCRUB', 'each', 349, 18, 'Skin care', 0.8, 'beauty', { price: exGst(349, 18), hsn: '3304', margin: 0.42, reorder: 3, target: 10 }],
  ['Body lotion 400 ml', 'RT-LOTION', 'each', 499, 18, 'Skin care', 0.8, 'beauty', { price: exGst(499, 18), hsn: '3304', margin: 0.38, reorder: 3, target: 10 }],
  ['Lip balm 4.5 g', 'RT-LIPBALM', 'each', 149, 18, 'Skin care', 1.4, 'beauty', { price: exGst(149, 18), hsn: '3304', margin: 0.45, reorder: 5, target: 16 }],
  ['Kajal (smudge-proof)', 'RT-KAJAL', 'each', 199, 18, 'Make-up & nails', 1, 'beauty', { price: exGst(199, 18), hsn: '3304', margin: 0.45, reorder: 4, target: 12 }],
  ['Nail polish remover 100 ml', 'RT-REMOVER', 'each', 179, 18, 'Make-up & nails', 0.8, 'beauty', { price: exGst(179, 18), hsn: '3304', margin: 0.45, reorder: 3, target: 10 }],
  ['Beard oil 30 ml', 'RT-BEARDOIL', 'each', 399, 18, "Men's grooming", 1, 'beauty', { price: exGst(399, 18), hsn: '3305', margin: 0.42, reorder: 3, target: 10 }],
  ['Beard wash 100 ml', 'RT-BEARDWASH', 'each', 299, 18, "Men's grooming", 0.8, 'beauty', { price: exGst(299, 18), hsn: '3305', margin: 0.42, reorder: 3, target: 10 }],
  ['Paddle hair brush', 'RT-BRUSH', 'each', 399, 18, 'Tools', 0.6, 'beauty', { price: exGst(399, 18), hsn: '9603', margin: 0.45, reorder: 2, target: 6 }],
  ['Wide-tooth comb', 'RT-COMB', 'each', 149, 18, 'Tools', 0.8, 'beauty', { price: exGst(149, 18), hsn: '9615', margin: 0.5, reorder: 3, target: 10 }],
]);
const serviceItems = SERVICES.map(([label, code, price, minutes, buffer, category, w, who, room]) => ({ name: label, label, code, unit: 'service', kind: 'service', price, gst: 5, category,
  w, who, minutes, buffer, room: Boolean(room), hsn: '9997', mrpPrinted: false }));

const PLANS = [
  { kind: 'package', name: 'Hair spa × 5', price: '5000', validityDays: 180, description: 'Five hair spa sessions in six months', services: [['SV-HAIRSPA', 5]] },
  { kind: 'package', name: 'Glow facial × 4', price: '5200', validityDays: 120, description: 'Four classic facials in four months', services: [['SV-FACIAL', 4]] },
  { kind: 'package', name: "Men's grooming × 6", price: '2700', validityDays: 120, description: 'Six haircuts with beard trim', services: [['SV-CUT-M', 6], ['SV-BEARD', 6]] },
  { kind: 'membership', name: 'Gold membership', price: '2500', validityDays: 365, serviceDiscountPercent: '15', productDiscountPercent: '10', description: '15% off services, 10% off products for a year' },
  { kind: 'membership', name: 'Silver membership', price: '1200', validityDays: 180, serviceDiscountPercent: '10', productDiscountPercent: '5', description: '10% off services, 5% off products for six months' },
];

async function setup(sim) {
  const when = clock.at(clock.addDays(sim.realToday, -sim.def.days - 1), '12:30');
  const ex = sim.extra;
  ex.staff = []; ex.rooms = []; ex.plans = {};
  const code = (c) => sim.items.find((i) => i.code === c);
  await machine.at(sim.business.id, when, async () => {
    if (!await repo.one(base.db, 'SELECT 1 FROM salon_settings WHERE business_id=$1 AND opens_at IS NOT NULL', [sim.business.id])) {
      await salon.saveSettings(sim.business, sim.owner, { depositPercent: '20', freeCancelHours: 4, lateCancelFeePercent: '50', noShowFeePercent: '100', opensAt: '10:00', closesAt: '21:00' });
    }
    for (const s of serviceItems) {
      const item = code(s.code);
      if (!await repo.one(base.db, 'SELECT 1 FROM salon_services WHERE business_id=$1 AND sku_id=$2', [sim.business.id, item.id])) {
        await salon.saveService(sim.business, sim.owner, item.id, { durationMinutes: s.minutes, bufferMinutes: s.buffer, needsRoom: s.room });
      }
    }
    for (const [name, role, skills] of STAFF) {
      const row = await repo.one(base.db, 'SELECT * FROM business_resources WHERE business_id=$1 AND name=$2', [sim.business.id, name])
        || await service.resource(sim.business, sim.owner, { name, roleLabel: role, locationId: sim.location.id });
      const profile = await repo.one(base.db, 'SELECT 1 FROM salon_resource_profiles WHERE business_id=$1 AND resource_id=$2', [sim.business.id, row.id]);
      // A stylist who has learnt new services since (a fuller menu) gets them added.
      const known = profile ? (await repo.all(base.db, 'SELECT sku_id FROM salon_staff_skills WHERE business_id=$1 AND resource_id=$2', [sim.business.id, row.id])).map((r) => String(r.sku_id)) : [];
      if (!profile || skills.some((c) => !known.includes(String(code(c).id)))) {
        await salon.saveStaff(sim.business, sim.owner, row.id, { kind: 'staff', skuIds: [...new Set([...known, ...skills.map((c) => String(code(c).id))])] });
      }
      ex.staff.push({ ...row, skills: new Set(skills) });
    }
    for (const name of ROOMS) {
      const row = await repo.one(base.db, 'SELECT * FROM business_resources WHERE business_id=$1 AND name=$2', [sim.business.id, name])
        || await service.resource(sim.business, sim.owner, { name, roleLabel: 'Room', locationId: sim.location.id });
      if (!await repo.one(base.db, 'SELECT 1 FROM salon_resource_profiles WHERE business_id=$1 AND resource_id=$2', [sim.business.id, row.id])) {
        await salon.saveStaff(sim.business, sim.owner, row.id, { kind: 'room', skuIds: [] });
      }
      ex.rooms.push(row);
    }
    if (!await repo.one(base.db, 'SELECT 1 FROM salon_commission_rules WHERE business_id=$1', [sim.business.id])) {
      await salon.createRule(sim.business, sim.owner, { appliesTo: 'service', percent: '10' });
      await salon.createRule(sim.business, sim.owner, { appliesTo: 'goods', percent: '5' });
      await salon.createRule(sim.business, sim.owner, { resourceId: ex.staff[0].id, appliesTo: 'service', percent: '15' });
      await salon.createRule(sim.business, sim.owner, { resourceId: ex.staff[3].id, appliesTo: 'service', skuId: code('SV-FACIAL').id, percent: '12' });
    }
    const five = await repo.one(base.db, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=5 AND active ORDER BY id LIMIT 1', [sim.business.id]);
    for (const p of PLANS) {
      ex.plans[p.name] = await repo.one(base.db, 'SELECT * FROM salon_plans WHERE business_id=$1 AND name=$2', [sim.business.id, p.name])
        || await salon.createPlan(sim.business, sim.owner, { ...p, taxRateId: five.id, services: (p.services || []).map(([c, sessions]) => ({ skuId: code(c).id, sessions })) });
    }
  }, { keepDates: true });
  for (const p of Object.values(ex.plans)) p.skuId = (await repo.one(base.db, 'SELECT sku_id FROM salon_plans WHERE business_id=$1 AND id=$2', [sim.business.id, p.id])).sku_id;
  // Clients split by who they are (the services they usually take).
  for (const [i, c] of sim.regulars.entries()) c.gender = c.gender || (i % 5 < 3 ? 'f' : 'm');
}

// A visit: one to three services by the stylists who do them, maybe a product, maybe a tip.
function visitLines(sim, r, client) {
  const gender = client?.gender || (r.chance(0.55) ? 'f' : 'm');
  const services = sim.items.filter((i) => i.kind === 'service' && i.meta.who && (i.meta.who === 'any' || i.meta.who === gender));
  const count = r.weighted([[1, 6], [2, 3], [3, 1]], (x) => x[1])[0];
  const chosen = [];
  for (let n = 0; n < count * 3 && chosen.length < count; n += 1) {
    const s = r.weighted(services, (x) => x.meta.w);
    if (!chosen.includes(s)) chosen.push(s);
  }
  const lines = chosen.map((s) => {
    const able = sim.extra.staff.filter((st) => st.skills.has(s.code));
    return { item: s, staff: r.pick(able) };
  });
  if (r.chance(0.12)) {
    const product = r.weighted(sim.items.filter((i) => i.kind === 'goods'), (x) => x.meta.w);
    if (shop.onHand(sim, product.id) >= 1) lines.push({ item: product, staff: lines[0]?.staff || sim.extra.staff[0], product: true });
  }
  return lines;
}
async function salonBill(sim, day, minutes, step, client, lines, { appointmentIds = [], useAdvance = false, tipChance = 0.2, r } = {}) {
  const who = shop.actor(sim, 'cashier', 'manager');
  const body = { locationId: sim.location.id, contactId: client?.contact.id || null, lines: lines.map((l) => ({ skuId: l.item.id, quantity: '1', staffId: l.staff.id,
    ...(l.clientPlanId ? { clientPlanId: l.clientPlanId } : {}), ...(l.appointmentId ? { appointmentId: l.appointmentId } : {}) })), appointmentIds, useAdvance };
  const method = shop.methodOf(sim, r);
  const result = await shop.post(sim, 'business_documents', step, clock.at(day, minutes), async (requestKey) => {
    const quote = await salon.quote(who.business, who.user, body);
    const toPay = Number(quote.toPay ?? quote.total);
    const tip = r.chance(tipChance) && lines[0] ? [{ staffId: lines[0].staff.id, amount: String(r.pick([50, 100, 100, 200])), method: method === 'card' ? 'card' : method === 'cash' ? 'cash' : 'upi' }] : undefined;
    const bill = await salon.bill(who.business, who.user, { ...body, requestKey, payment: toPay > 0 ? { amount: toPay.toFixed(2), method } : undefined, ...(tip ? { tips: tip } : {}) });
    return bill.document;
  }, { children: ['salon_line_staff', 'salon_appointment_details'] });
  if (result.created) for (const l of lines.filter((x) => x.product)) { const lot = shop.lotsOf(sim, l.item.id).find((x) => x.code === ''); if (lot) lot.qty -= 1; }
  return result;
}
// Active packages of a client with sessions left for a service.
async function packageFor(sim, client, skuId) {
  return repo.one(base.db, `SELECT cp.id FROM salon_client_plans cp JOIN salon_client_plan_services ps ON ps.business_id=cp.business_id AND ps.client_plan_id=cp.id
    WHERE cp.business_id=$1 AND cp.contact_id=$2 AND cp.status='active' AND cp.kind='package' AND ps.sku_id=$3
      AND ps.sessions > COALESCE((SELECT sum(r.quantity) FROM salon_package_redemptions r WHERE r.business_id=cp.business_id AND r.client_plan_id=cp.id AND r.sku_id=ps.sku_id),0)
      AND (cp.ends_on IS NULL OR cp.ends_on >= $4::date)
    ORDER BY cp.id LIMIT 1`, [sim.business.id, client.contact.id, skuId, sim.realToday]);
}

async function salonSale(sim, day, p, step) {
  const r = p.r;
  const client = p.regular;
  // Now and then a regular buys a package or a membership.
  if (client && !client.boughtPlan && r.chance(0.035)) {
    const plan = client.gender === 'm' ? r.pick([sim.extra.plans["Men's grooming × 6"], sim.extra.plans['Silver membership']])
      : r.pick([sim.extra.plans['Hair spa × 5'], sim.extra.plans['Glow facial × 4'], sim.extra.plans['Gold membership'], sim.extra.plans['Silver membership']]);
    client.boughtPlan = true;
    await salonBill(sim, day, p.minutes, `${step}-plan`, client, [{ item: { id: plan.skuId }, staff: sim.extra.staff[0] }], { r, tipChance: 0 });
    return;
  }
  const lines = visitLines(sim, r, client);
  if (!lines.length) return;
  if (client) for (const l of lines) {
    if (l.product) continue;
    const pkg = await packageFor(sim, client, l.item.id);
    if (pkg) l.clientPlanId = pkg.id;
  }
  await salonBill(sim, day, p.minutes, step, client, lines, { r });
}

// Commission paid on the 1st for the month before.
async function payCommissions(sim, day) {
  if (day.slice(8, 10) !== '01') return;
  const from = `${clock.addDays(day, -1).slice(0, 8)}01`, to = clock.addDays(day, -1);
  const report = await salon.commissionReport(sim.business, { from, to }).catch(() => null);
  const rows = Array.isArray(report) ? report : report?.rows || report?.items || [];
  for (const row of rows) {
    const due = Number(row.commission || 0) + Number(row.tips || 0);
    if (due < 1) continue;
    await shop.post(sim, 'salon_commission_payouts', `commission-${row.resource_id}-${from}`, clock.at(day, 11 * 60), (requestKey) => salon.payCommission(sim.business, sim.owner,
      { resourceId: row.resource_id, from, to, amount: due.toFixed(2), method: 'bank', reference: `NEFT ${from.slice(0, 7)}`, note: 'Commission and tips', requestKey })).catch(() => null);
  }
}

// The calendar: yesterday evening's and today's bookings (done ones billed), a
// no-show and a late cancellation, the rest of today and the next three days.
async function calendar(sim, today) {
  await round2(sim, today);
  const ex = sim.extra;
  const at = (day, hhmm) => clock.at(day, hhmm).toISOString();
  const code = (c) => sim.items.find((i) => i.code === c);
  const staff = (name) => ex.staff.find((s) => s.name.startsWith(name));
  const regular = (n) => sim.regulars[n % sim.regulars.length];
  const nowMinutes = clock.minutesNow();
  const plan = [
    // [day offset, time, client, service, stylist, room?, deposit?]
    [0, '10:30', 2, 'SV-CUT-W', 'Priya'], [0, '11:00', 5, 'SV-CUT-M', 'Arjun'], [0, '11:30', 8, 'SV-FACIAL', 'Neha', 0, 300], [0, '12:00', 11, 'SV-PEDI', 'Lakshmi'],
    [0, '13:00', 14, 'SV-COLOUR', 'Priya', null, 560], [0, '15:00', 17, 'SV-BEARD', 'Faizal'], [0, '16:00', 20, 'SV-HAIRSPA', 'Arjun'], [0, '16:30', 23, 'SV-THREAD', 'Lakshmi'],
    [0, '17:30', 26, 'SV-CUT-W', 'Faizal'], [0, '18:00', 29, 'SV-GOLDFACIAL', 'Neha', 1, 500], [0, '18:30', 32, 'SV-CUT-M', 'Arjun'], [0, '19:00', 35, 'SV-KERATIN', 'Priya', null, 1300],
    [0, '19:30', 38, 'SV-MANI', 'Lakshmi'], [0, '20:00', 41, 'SV-CUT-M', 'Faizal'],
    [1, '11:00', 44, 'SV-FACIAL', 'Neha', 0, 300], [1, '12:00', 47, 'SV-CUT-W', 'Priya'], [1, '17:00', 50, 'SV-HAIRSPA', 'Arjun'], [1, '18:30', 53, 'SV-PARTYMU', 'Neha', null, 700],
    [2, '10:30', 56, 'SV-COLOUR', 'Priya', null, 560], [2, '16:00', 59, 'SV-PEDI', 'Lakshmi'], [3, '11:00', 62, 'SV-BRIDAL', 'Priya', null, 3600], [3, '15:00', 65, 'SV-CUT-M', 'Arjun'],
  ];
  for (const [n, [offset, time, clientIndex, svc, who, room, deposit]] of plan.entries()) {
    const day = clock.addDays(today, offset);
    const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const client = regular(clientIndex);
    const step = `book-${day}-${n}`;
    // Booked a day or two ahead; today's earlier slots were booked yesterday.
    try {
      const booked = await base.once(sim.business.id, 'salon_appointment_details', step, (requestKey) => salon.book(sim.business, sim.owner, {
        contactId: client.contact.id, skuId: code(svc).id, resourceId: staff(who).id, startsAt: at(day, time), requestKey,
        ...(room !== undefined && room !== null ? { roomId: ex.rooms[room].id } : {}), ...(deposit ? { deposit: { amount: String(deposit), method: 'upi', reference: `UPI ${400000000 + n}` } } : {}) }));
      const appointmentId = booked.created ? booked.row.id : booked.row.appointment_id;
      if (offset !== 0 || minutes > nowMinutes) continue;
      const length = (code(svc).meta.minutes || 45);
      // Earlier today: done and billed (the deposit put against the bill); one did not turn up.
      const status = await repo.one(base.db, 'SELECT status FROM business_appointments WHERE business_id=$1 AND id=$2', [sim.business.id, appointmentId]);
      if (status.status !== 'booked') continue;
      // One client did not turn up; the one in the chair now is marked arrived; finished ones are billed.
      if (n === 3) {
        if (minutes + 20 <= nowMinutes) await salon.setStatus(sim.business, sim.owner, appointmentId, { status: 'no_show', requestKey: base.key(sim.business.id, `${step}-noshow`) });
        continue;
      }
      if (minutes + length > nowMinutes) {
        await salonPro.arrive(sim.business, sim.owner, appointmentId).catch(() => null);
        continue;
      }
      await salonBill(sim, today, Math.min(nowMinutes - 1, minutes + length + 5), `${step}-bill`, client, [{ item: code(svc), staff: staff(who), appointmentId }],
        { appointmentIds: [appointmentId], useAdvance: Boolean(deposit), r: clock.rng(step) });
    } catch (error) {
      if (!/already|passed|books from|not free|leave|working|works from|off\.|closed that day/i.test(error.message)) throw error;
    }
  }
}

// --- Round 2 (R2-SVC): weeks, a holiday, back-bar products, a target plan, a refund ---------
// Added once to any load (every step is found by its key); dated this morning.
const BACKBAR = [
  // [label, code, unit, cost per unit before GST, quantity bought]
  ['Professional hair colour (salon use)', 'BB-COLOUR', 'ml', 3.2, 2400], ['Developer cream 20 vol (salon use)', 'BB-DEV', 'ml', 0.45, 4000],
  ['Keratin smoothing cream (salon use)', 'BB-KERATIN', 'ml', 9, 1000], ['Hair spa cream (salon use)', 'BB-SPA', 'g', 1.1, 3000],
  ['Facial kit gel & pack (salon use)', 'BB-FACIAL', 'g', 2.4, 2000],
];
const RECIPES = {
  'SV-COLOUR': [['BB-COLOUR', 60], ['BB-DEV', 90]], 'SV-ROOT': [['BB-COLOUR', 30], ['BB-DEV', 45]], 'SV-HIGHLIGHT': [['BB-COLOUR', 40], ['BB-DEV', 60]],
  'SV-KERATIN': [['BB-KERATIN', 80]], 'SV-HAIRSPA': [['BB-SPA', 50]], 'SV-FACIAL': [['BB-FACIAL', 30]], 'SV-GOLDFACIAL': [['BB-FACIAL', 40]],
};
async function round2(sim, today) {
  const db = base.db;
  const id = sim.business.id;
  const code = (c) => sim.items.find((i) => i.code === c);
  const staff = (name) => sim.extra.staff.find((x) => x.name.startsWith(name));
  const morning = Math.max(9 * 60, Math.min(clock.minutesNow() - 30, 9 * 60 + 30));
  const eighteen = await repo.one(db, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=18 AND active ORDER BY id LIMIT 1', [id]);
  // Back-bar products: kept in ml / g, bought once, used by the services' recipes.
  const products = {};
  for (const [label, c, unit, cost] of BACKBAR) {
    products[c] = await repo.one(db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND code=$2', [id, c])
      || await machine.at(id, clock.at(today, morning - 5), () => service.createCatalog(sim.business, sim.owner, { name: label, code: c, kind: 'goods', unit, tracking: 'quantity',
        price: (cost * 1.6).toFixed(2), taxRateId: eighteen?.id, category: 'Back-bar (salon use)', hsn: '3305' }));
  }
  const beauty = sim.suppliers.find((x) => x.key === 'beauty');
  await shop.receive(sim, today, morning, beauty, BACKBAR.map(([, c, , cost, qty]) => ({ item: { ...products[c], meta: {}, decimals: 3 }, qty, cost })), 'r2-backbar-stock', { billSuffix: '-BB' });
  for (const [service_, uses] of Object.entries(RECIPES)) {
    if (await repo.one(db, 'SELECT 1 FROM salon_service_products WHERE business_id=$1 AND service_sku_id=$2', [id, code(service_).id])) continue;
    await salonR2.saveRecipe(sim.business, sim.owner, code(service_).id, { products: uses.map(([c, quantity]) => ({ skuId: products[c].id, quantity: String(quantity) })) });
  }
  // Weekly schedules: Priya works shorter on Sundays, Neha is off on Tuesdays, Arjun starts late on Saturdays.
  const weeks = [['Priya', [{ dow: 0, off: false, worksFrom: '11:00', worksTo: '18:00' }]], ['Neha', [{ dow: 2, off: true }]], ['Arjun', [{ dow: 6, off: false, worksFrom: '12:00', worksTo: '21:00' }]]];
  for (const [name, days] of weeks) {
    if (await repo.one(db, 'SELECT 1 FROM salon_staff_week WHERE business_id=$1 AND resource_id=$2', [id, staff(name).id])) continue;
    await salonR2.saveWeek(sim.business, sim.owner, staff(name).id, { days });
  }
  // Diwali: the salon is closed (when it is still ahead and nothing is booked then).
  if (today < '2026-11-08' && !await repo.one(db, "SELECT 1 FROM salon_holidays WHERE business_id=$1 AND day='2026-11-08'", [id])) {
    await salonR2.addHoliday(sim.business, sim.owner, { day: '2026-11-08', name: 'Diwali (Lakshmi Puja)' }).catch(() => null);
  }
  // A monthly target for the senior stylist, from this month.
  let plan = await repo.one(db, "SELECT * FROM salon_commission_plans WHERE business_id=$1 AND name='Senior stylist target'", [id]);
  if (!plan) {
    plan = await salonR2.createCommissionPlan(sim.business, sim.owner, { name: 'Senior stylist target', mode: 'stepped',
      slabs: [{ fromAmount: '0', percent: '10' }, { fromAmount: '60000', percent: '12' }, { fromAmount: '120000', percent: '15' }] });
    await salonR2.createCommissionPlan(sim.business, sim.owner, { name: 'Stylist target (whole month)', mode: 'whole', slabs: [{ fromAmount: '0', percent: '8' }, { fromAmount: '40000', percent: '10' }] });
  }
  if (!await repo.one(db, 'SELECT 1 FROM salon_commission_schemes WHERE business_id=$1', [id])) {
    await salonR2.setScheme(sim.business, sim.owner, staff('Priya').id, { planId: plan.id, fromMonth: today.slice(0, 7) });
  }
  // A client cancelled a booking well ahead and asked for the deposit back: refunded in cash, approved by the manager.
  const client = sim.regulars[70 % sim.regulars.length];
  const ahead = clock.addDays(today, 6);
  const booked = await base.once(id, 'salon_appointment_details', 'r2-refund-booking', (requestKey) => machine.at(id, clock.at(today, morning + 10), () => salon.book(sim.business, sim.owner, {
    contactId: client.contact.id, skuId: code('SV-MANI').id, resourceId: staff('Lakshmi').id, startsAt: clock.at(ahead, '12:00').toISOString(), requestKey,
    deposit: { amount: '300', method: 'upi', reference: 'UPI 408812345' } }))).catch((error) => { if (/works|off\.|leave|closed|already/i.test(error.message)) return null; throw error; });
  if (!booked) return;
  const appointmentId = booked.created ? booked.row.id : booked.row.appointment_id;
  const appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2', [id, appointmentId]);
  if (appointment.status === 'booked') await machine.at(id, clock.at(today, morning + 20), () => salon.setStatus(sim.business, sim.owner, appointmentId, { status: 'cancelled', requestKey: base.key(id, 'r2-refund-cancel') }));
  const deposit = await repo.one(db, 'SELECT deposit_collection_id FROM salon_appointment_details WHERE business_id=$1 AND appointment_id=$2', [id, appointmentId]);
  const manager = shop.actor(sim, 'manager');
  await machine.at(id, clock.at(today, morning + 25), () => repo.transaction(async (tx) => {
    await tx.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [id]);
    return refunds.refundCollection(tx, sim.business, sim.owner, { collectionId: deposit.deposit_collection_id, contactId: client.contact.id,
      input: { amount: 30000, method: 'cash', reference: null, requestKey: base.key(id, 'r2-refund-cash') },
      approval: { reason: 'Moving to Mysuru next week; asked for the deposit back', approver: { id: manager.user.id, name: manager.user.name } }, source: 'salon', label: client.contact.name });
  }));
}

const salonDef = {
  key: 'salon', type: 'salon', name: 'Glow & Grace Unisex Salon & Spa', location: 'Indiranagar studio',
  legalName: 'Glow & Grace Wellness LLP', gstin: gstin('29', 'salon-shop', 'F', 'G'),
  address: ['No. 1124, 12th Main Road, HAL 2nd Stage', 'Indiranagar'], city: 'Bengaluru', pin: '560038', phone: '080-4123 8877', email: 'hello@glowandgrace.in',
  receiptFooter: 'Prices exclusive of GST (5%). Book on WhatsApp. Cancel 4 hours ahead to keep your deposit.',
  taxMode: 'exclusive', rounding: 'none',
  days: 90, open: 10 * 60, close: 21 * 60, margin: 0.38, regularShare: 0.55, udhaar: false, returnRate: 0, sellsServices: true,
  curve: [[10, 3], [11, 6], [12, 6], [13, 4], [14, 4], [15, 5], [16, 7], [17, 9], [18, 10], [19, 9], [20, 4]],
  // Weekends and the run-up to Varalakshmi, Raksha Bandhan and Ganesh Chaturthi are busy; Tuesdays slow.
  volume: volume(22, { weekdays: [1.55, 0.95, 0.75, 0.9, 0.95, 1.1, 1.5], festivals: { '2026-08-20': 1.5, '2026-08-27': 1.4, '2026-09-12': 1.5, '2026-09-13': 1.6 },
    ranges: [['2026-09-27', '2026-10-10', 0.85], ['2026-10-03', '2026-10-31', 1.2]], growth: 0.0015 }),
  pay: { upi: 0.55, card: 0.3, cash: 0.15 },
  staff: [{ name: 'Deepa Kamath', login: 'deepa', role: 'manager' }, { name: 'Spoorthi Rao', login: 'spoorthi', role: 'cashier' }],
  suppliers: [supplier('beauty', 'Bengaluru Salon Supplies & Cosmetics', '29', 'sl-beauty', { prefix: 'BSS', creditDays: 15, days: [3], address: 'Commercial Street, Bengaluru' })],
  regulars: [...regulars('kannada', 60, 'salon', { udhaar: [] }), ...regulars('north', 25, 'salon-n', { udhaar: [] }).map((c, i) => ({ ...c, key: `n${i + 1}` }))],
  categories: [['Hair'], ['Skin'], ['Hands & feet'], ['Make-up'], ['Spa'], ['Retail products', ['Hair care', 'Skin care', 'Make-up & nails', "Men's grooming", 'Tools']]],
  items: [...serviceItems, ...productItems],
  modules: [],
  hooks: {
    setup,
    sale: salonSale,
    async morning(sim, day) { await payCommissions(sim, day); },
    today: calendar,
  },
};

module.exports = { salon: salonDef };
