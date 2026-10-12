const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');

// Salon & spa on a bill (Phase 2, T4), called by the core posting
// (business.service.js › postDocument) right after retail offers, so the
// Bills screen, the salon's New bill, a quote and any later POS get the same
// result:
//
//  1. A line that sells a package or membership plan (its own service item)
//     needs the client; one per line. The client's package / membership is
//     created when the bill is posted (recordSale).
//  2. A service line marked "use package" (clientPlanId) is paid by one of
//     the client's package sessions: the whole line comes off as a
//     'package' discount. The package must be the client's, active, inside
//     its dates, hold that service, and have enough sessions left (sessions
//     given back by returned lines count as left).
//  3. Every other line of a client with an active membership gets the
//     membership's discount — services and products have their own % — on
//     what is left after any offer. The best active membership wins.
//  4. A line may name the stylist who did it (staffId) and the booking
//     (appointmentId). With staff commissions on, the commission is worked
//     out from the most specific active rule on the line's taxable value and
//     kept as a snapshot.
// Discounts go into the shared retail_sale_discounts snapshot (sources
// 'membership' and 'package'), so they reduce the taxable value exactly like
// offers. Lines with fixed prices (a fee bill) take nothing.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const paise = (number) => Math.round(Number(number) * 100);
const money = (value) => (value / 100).toFixed(2);
const divide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const percentOf = (amount, percent) => divide(BigInt(amount) * BigInt(paise(percent)), 10000n);
const id = (value, name) => v.requiredId(value, name);

const TODAY = '(now() AT TIME ZONE b.timezone)::date';
// Sessions of each service a client's package has used, net of returned lines.
const USED_SQL = `COALESCE((SELECT sum(r.quantity - COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl
    WHERE rl.business_id=r.business_id AND rl.line_id=r.line_id),0)) FROM salon_package_redemptions r
    WHERE r.business_id=s.business_id AND r.client_plan_id=s.client_plan_id AND r.sku_id=s.sku_id),0)::int`;

const enabled = (business, code) => (business.capabilities || []).includes(code);

async function priceSale(db, business, { contact, lines, body, pricing }) {
  const inputs = Array.isArray(body.lines) ? body.lines : [];
  const packages = enabled(business, 'packages');
  const wantsSalon = inputs.some((l) => l && (l.clientPlanId || l.staffId || l.appointmentId));
  const skuIds = lines.map((line) => Number(line.sku.id));
  // A plan's item sells only as a plan: with the module off it would be a
  // plain service and the client would get no package or membership.
  const plans = business.business_type === 'salon' ? await repo.all(db, 'SELECT * FROM salon_plans WHERE business_id=$1 AND sku_id=ANY($2::bigint[])', [business.id, skuIds]) : [];
  if (plans.length && !packages) {
    fail(`${plans[0].name} is a ${plans[0].kind}; Packages & memberships is switched off, so it cannot be sold. An owner can turn it on in Settings › Modules.`, 409);
  }
  if (!packages && !enabled(business, 'commissions') && !wantsSalon) return;
  const salon = { redemptions: [], memberships: [], plansSold: [], staff: [] };
  pricing.salon = salon;
  const open = (line) => !line.preset;
  const left = (index) => lines[index].amount - (pricing.perLine[index] || 0);
  const add = (index, source, label, amount) => {
    if (amount <= 0) return;
    pricing.perLine[index] += amount;
    pricing.rows.push({ index, source, offerId: null, label: label.slice(0, 150), amount });
  };

  // 1. Plans sold on this bill.
  const planOf = new Map(plans.map((p) => [Number(p.sku_id), p]));
  lines.forEach((line, index) => {
    const plan = planOf.get(Number(line.sku.id));
    if (!plan || !open(line)) return;
    if (!plan.active) fail(`${plan.name} is no longer sold`, 409);
    if (!contact) fail(`Choose the client the ${plan.kind} "${plan.name}" is for`);
    if (Number(line.quantity) !== 1) fail(`Sell one ${plan.kind} per line (${plan.name})`);
    salon.plansSold.push({ index, plan });
  });

  // 2. Package sessions used.
  const planned = new Map();
  for (const [index, input] of inputs.entries()) {
    if (!input || input.clientPlanId === undefined || input.clientPlanId === null || input.clientPlanId === '') continue;
    const line = lines[index];
    if (!line) continue;
    if (!packages) fail('Packages & memberships are not switched on for this business. An owner can turn it on in Settings › Modules.', 403);
    if (!contact) fail('Choose the client whose package is being used');
    if (!open(line)) fail('This line cannot be paid from a package');
    if (!Number.isInteger(Number(line.quantity))) fail('Package sessions are whole numbers');
    const clientPlanId = id(input.clientPlanId, 'Package');
    const held = await repo.one(db, `SELECT cp.*,(cp.starts_on <= ${TODAY} AND cp.ends_on >= ${TODAY}) AS current
      FROM salon_client_plans cp JOIN businesses b ON b.id=cp.business_id
      WHERE cp.business_id=$1 AND cp.id=$2 AND cp.contact_id=$3 AND cp.kind='package' FOR UPDATE OF cp`, [business.id, clientPlanId, contact.id]);
    if (!held) fail(`That package is not one of ${contact.name}'s`, 404);
    if (held.status !== 'active') fail(`${held.name} was cancelled`, 409);
    if (!held.current) fail(`${held.name} ran from ${String(held.starts_on).slice(0, 10)} to ${String(held.ends_on).slice(0, 10)}; it cannot be used today`, 409);
    const service = await repo.one(db, `SELECT s.*,${USED_SQL} AS used FROM salon_client_plan_services s
      WHERE s.business_id=$1 AND s.client_plan_id=$2 AND s.sku_id=$3`, [business.id, held.id, line.sku.id]);
    if (!service) fail(`${line.sku.label} is not part of ${held.name}`, 409);
    const keyOf = `${held.id}:${line.sku.id}`;
    const already = planned.get(keyOf) || 0;
    const remaining = Number(service.sessions) - Number(service.used) - already;
    if (Number(line.quantity) > remaining) fail(`${held.name} has ${Math.max(0, remaining)} ${line.sku.label} session${remaining === 1 ? '' : 's'} left`, 409);
    planned.set(keyOf, already + Number(line.quantity));
    add(index, 'package', `Package: ${held.name}`, left(index));
    salon.redemptions.push({ index, clientPlanId: held.id, skuId: Number(line.sku.id), quantity: Number(line.quantity) });
  }

  // 3. Membership discount on everything else.
  if (packages && contact) {
    const memberships = await repo.all(db, `SELECT cp.* FROM salon_client_plans cp JOIN businesses b ON b.id=cp.business_id
      WHERE cp.business_id=$1 AND cp.contact_id=$2 AND cp.kind='membership' AND cp.status='active'
      AND cp.starts_on <= ${TODAY} AND cp.ends_on >= ${TODAY} ORDER BY cp.id`, [business.id, contact.id]);
    if (memberships.length) {
      const redeemed = new Set(salon.redemptions.map((r) => r.index));
      lines.forEach((line, index) => {
        if (!open(line) || redeemed.has(index) || planOf.has(Number(line.sku.id))) return;
        const field = line.sku.kind === 'service' ? 'service_discount_percent' : 'product_discount_percent';
        const best = memberships.reduce((top, m) => (Number(m[field]) > Number(top?.[field] || 0) ? m : top), null);
        if (!best || Number(best[field]) <= 0) return;
        const amount = percentOf(left(index), best[field]);
        if (amount <= 0) return;
        add(index, 'membership', `Membership: ${best.name} (${Number(best[field])}%)`, amount);
        salon.memberships.push({ index, clientPlanId: best.id, percent: Number(best[field]), amount });
      });
    }
  }

  // 4. Who did each line. One booking is one visit: it goes on one line of one bill.
  const bookingsOnBill = new Set();
  for (const [index, input] of inputs.entries()) {
    if (!input || !lines[index]) continue;
    const hasStaff = input.staffId !== undefined && input.staffId !== null && input.staffId !== '';
    const hasBooking = input.appointmentId !== undefined && input.appointmentId !== null && input.appointmentId !== '';
    if (!hasStaff && !hasBooking) continue;
    let appointment = null;
    if (hasBooking) {
      appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2', [business.id, id(input.appointmentId, 'Appointment')]);
      if (!appointment || (contact && Number(appointment.contact_id) !== Number(contact.id))) fail('That appointment is not this client\'s', 404);
      if (bookingsOnBill.has(Number(appointment.id))) fail('That booking is already on this bill. Each booking goes on one line.', 409);
      bookingsOnBill.add(Number(appointment.id));
      const billed = await repo.one(db, 'SELECT bill_document_id FROM salon_appointment_details WHERE business_id=$1 AND appointment_id=$2', [business.id, appointment.id]);
      if (billed?.bill_document_id) fail('That booking has already been billed', 409);
    }
    const resourceId = hasStaff ? id(input.staffId, 'Stylist') : appointment.resource_id;
    const staff = await repo.one(db, `SELECT r.* FROM business_resources r LEFT JOIN salon_resource_profiles p ON p.business_id=r.business_id AND p.resource_id=r.id
      WHERE r.business_id=$1 AND r.id=$2 AND COALESCE(p.kind,'staff')='staff'`, [business.id, resourceId]);
    if (!staff) fail('Choose a stylist of this business for each service', 404);
    salon.staff.push({ index, resourceId: Number(staff.id), appointmentId: appointment ? Number(appointment.id) : null });
  }
}

// The value of package sessions used on a line (paise, before GST): the
// package's own price per session, or the service's list price.
async function sessionValue(db, business, redemption, line, basis) {
  if (basis.basis === 'list_price') {
    const gross = paise(line.sku.price) * Number(redemption.quantity);
    if (basis.tax_mode !== 'inclusive') return gross;
    return Math.round(gross / (1 + Number(line.sku.tax_rate) / 100));
  }
  const row = await repo.one(db, `SELECT l.net,(SELECT COALESCE(sum(s.sessions),0) FROM salon_client_plan_services s WHERE s.business_id=cp.business_id AND s.client_plan_id=cp.id)::int AS sessions
    FROM salon_client_plans cp JOIN business_document_lines l ON l.business_id=cp.business_id AND l.id=cp.line_id WHERE cp.business_id=$1 AND cp.id=$2`, [business.id, redemption.clientPlanId]);
  if (!row || !row.sessions) return 0;
  return divide(BigInt(paise(row.net)) * BigInt(redemption.quantity), BigInt(row.sessions));
}

// After the bill and its lines are saved (same transaction).
async function recordSale(db, business, user, saved, lines, pricing) {
  // Round 2: the back-bar products each service line used leave stock.
  if (business.business_type === 'salon') await require('./businessSalonRound2.service').consumeBackbar(db, business, user, saved, lines);
  const salon = pricing?.salon;
  if (!salon) return;
  for (const r of salon.redemptions) {
    const row = await repo.one(db, `INSERT INTO salon_package_redemptions(business_id,client_plan_id,sku_id,quantity,document_id,line_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [business.id, r.clientPlanId, r.skuId, r.quantity, saved.id, lines[r.index].id, user.id]);
    await repo.event(db, business.id, user.id, 'package.redeemed', 'package_redemption', row.id,
      { clientPlanId: r.clientPlanId, skuId: r.skuId, quantity: r.quantity, documentId: saved.id, documentNo: saved.document_no });
  }
  for (const m of salon.memberships) {
    await db.query(`INSERT INTO salon_membership_uses(business_id,client_plan_id,document_id,line_id,percent,amount) VALUES($1,$2,$3,$4,$5,$6)`,
      [business.id, m.clientPlanId, saved.id, lines[m.index].id, m.percent, money(m.amount)]);
  }
  for (const { index, plan } of salon.plansSold) {
    const line = lines[index];
    const dates = await repo.one(db, `SELECT ${TODAY} AS starts_on,(${TODAY} + $2::int - 1) AS ends_on FROM businesses b WHERE b.id=$1`, [business.id, plan.validity_days]);
    const held = await repo.one(db, `INSERT INTO salon_client_plans(business_id,plan_id,contact_id,kind,name,document_id,line_id,price,starts_on,ends_on,
      service_discount_percent,product_discount_percent,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [business.id, plan.id, saved.contact_id, plan.kind, plan.name, saved.id, line.id, money(line.net + line.tax), dates.starts_on, dates.ends_on,
      plan.service_discount_percent, plan.product_discount_percent, user.id]);
    if (plan.kind === 'package') {
      await db.query(`INSERT INTO salon_client_plan_services(business_id,client_plan_id,sku_id,label,sessions)
        SELECT ps.business_id,$2,ps.sku_id,s.label,ps.sessions FROM salon_plan_services ps JOIN catalog_skus s ON s.business_id=ps.business_id AND s.id=ps.sku_id
        WHERE ps.business_id=$1 AND ps.plan_id=$3`, [business.id, held.id, plan.id]);
    }
    await repo.audit(db, business.id, user.id, `${plan.kind}.sold`, held.id, { planId: plan.id, contactId: saved.contact_id, documentNo: saved.document_no });
    await repo.event(db, business.id, user.id, `${plan.kind}.sold`, 'client_plan', held.id,
      { planId: plan.id, contactId: saved.contact_id, documentId: saved.id, startsOn: held.starts_on, endsOn: held.ends_on });
  }
  const commissions = enabled(business, 'commissions');
  // Pro pass F-08: a package or membership sold is its own kind ('plan', with
  // its own rule); a service paid from a package ('session') earns on the
  // session's value — the package's price per session, or the service's list
  // price (salon settings) — by the service rules. A rule may be a flat amount
  // per item instead of a percentage.
  const soldPlan = new Set(salon.plansSold.map((p) => p.index));
  const redeemedAt = new Map(salon.redemptions.map((r) => [r.index, r]));
  let basis = null;
  for (const s of salon.staff) {
    const line = lines[s.index];
    let kind = line.sku.kind === 'service' ? 'service' : 'goods';
    let base = line.net;
    if (soldPlan.has(s.index)) kind = 'plan';
    else if (redeemedAt.has(s.index)) {
      kind = 'session';
      if (!basis) {
        basis = await repo.one(db, `SELECT COALESCE(ss.session_commission_basis,'package_price') AS basis,COALESCE(bs.tax_mode,'exclusive') AS tax_mode
          FROM businesses b LEFT JOIN salon_settings ss ON ss.business_id=b.id LEFT JOIN business_settings bs ON bs.business_id=b.id WHERE b.id=$1`, [business.id]);
      }
      base = await sessionValue(db, business, redeemedAt.get(s.index), line, basis);
    }
    const appliesTo = kind === 'session' ? 'service' : kind;
    const rule = commissions ? await repo.one(db, `SELECT * FROM salon_commission_rules WHERE business_id=$1 AND active AND applies_to=$2
      AND (resource_id=$3 OR resource_id IS NULL) AND (sku_id=$4 OR sku_id IS NULL)
      ORDER BY (resource_id IS NOT NULL) DESC,(sku_id IS NOT NULL) DESC LIMIT 1`, [business.id, appliesTo, s.resourceId, line.sku.id]) : null;
    const flat = rule && rule.flat_amount !== null && rule.flat_amount !== undefined;
    const percent = rule && !flat ? Number(rule.percent) : 0;
    const amount = flat ? divide(BigInt(paise(rule.flat_amount)) * BigInt(Math.round(Number(line.quantity) * 1000)), 1000n) : percentOf(base, percent);
    await db.query(`INSERT INTO salon_line_staff(business_id,line_id,document_id,resource_id,appointment_id,rule_id,item_kind,commission_percent,commission_base,commission_amount)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [business.id, line.id, saved.id, s.resourceId, s.appointmentId, rule?.id || null, kind, percent, money(base), money(amount)]);
  }
  if (salon.staff.length && commissions) {
    await repo.event(db, business.id, user.id, 'commission.earned', 'document', saved.id, {
      documentNo: saved.document_no, lines: salon.staff.map((s) => ({ lineId: lines[s.index].id, resourceId: s.resourceId })),
    });
  }
}

module.exports = { priceSale, recordSale, USED_SQL, percentOf };
