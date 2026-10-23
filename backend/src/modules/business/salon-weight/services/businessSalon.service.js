const crypto = require('node:crypto');
// The manager-PIN check, loaded when first needed.
const pins = () => require('./businessManagerPin');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const numbering = require('../../core/services/businessNumbering');
const core = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const { USED_SQL } = require('./businessSalonSales');

// Salon & spa: service times and stylist skills, the
// appointment calendar by stylist and room with deposits and the
// no-show / late-cancellation rule, the salon bill (services + products,
// packages, memberships, deposits), package and membership plans, and staff
// commissions. See "Salon & spa" in docs/BUSINESS_PLATFORM_DATA_MODEL.md.
//
// Money is integer paise; bills are ordinary sales posted by the core
// (number series, stock, GST, events, audit); a deposit is a shared
// receivables collection kept as the client's advance until it is used.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
// A request key derived from another, so repeating a request never repeats its parts.
const derivedKey = (base, part) => {
  const hex = crypto.createHash('sha256').update(`${base}:${part}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const METHODS = ['cash', 'card', 'upi', 'bank', 'cheque'];
const requireSalon = (business) => {
  if (business.business_type !== 'salon') fail('This screen belongs to salon & spa businesses', 404);
};
const requireModule = (business, code, name) => {
  if (!business.modules.includes(code)) fail(`${name} is not switched on for this business. An owner can turn it on in Settings › Business tools.`, 403);
};
const TODAY = '(now() AT TIME ZONE b.timezone)::date';
// A deposit held for a booking still to come is kept for that booking: it is
// not put against other bills (so a later no-show can still be charged from
// it) unless that booking is on the bill. `keep`: the bill's booking ids.
// A deposit moved to the client's wallet (salon_deposit_releases) is no longer held.
const notHeldSql = (alias, keep) => `NOT EXISTS (SELECT 1 FROM salon_appointment_details sd JOIN business_appointments sa ON sa.business_id=sd.business_id AND sa.id=sd.appointment_id
  WHERE sd.business_id=${alias}.business_id AND sd.deposit_collection_id=${alias}.id AND sa.status='booked' AND sa.starts_at > now() AND NOT (sa.id = ANY(${keep}::bigint[]))
  AND NOT EXISTS (SELECT 1 FROM salon_deposit_releases dr WHERE dr.business_id=sd.business_id AND dr.collection_id=sd.deposit_collection_id))`;
// What is left of a receipt: less what went on bills and what was refunded.
const freeSql = (alias) => `${alias}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${alias}.business_id AND p.collection_id=${alias}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${alias}.business_id AND f.collection_id=${alias}.id),0)`;
// A deposit moved to the wallet is no longer the booking's: no charge comes out of it.
const releasedSql = (alias) => `EXISTS (SELECT 1 FROM salon_deposit_releases dr WHERE dr.business_id=${alias}.business_id AND dr.collection_id=${alias}.id)`;

// --- Lists ---------------------------------------------------------------------------

const planSkuFilter = `NOT EXISTS (SELECT 1 FROM salon_plans x WHERE x.business_id=s.business_id AND x.sku_id=s.id)
  AND NOT EXISTS (SELECT 1 FROM salon_settings y WHERE y.business_id=s.business_id AND y.fee_sku_id=s.id)`;
const returnedSql = (line) => `COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=${line}.business_id AND rl.line_id=${line}.id),0)`;

repo.addLists({
  'salon-services': {
    sql: `SELECT s.id,s.code,s.label,s.price,s.tax_rate,s.active,p.name AS product_name,COALESCE(c.name,p.category) AS category,
      ss.duration_minutes,ss.buffer_minutes,COALESCE(ss.needs_room,false) AS needs_room,(ss.sku_id IS NOT NULL) AS timed,
      (SELECT count(*)::int FROM salon_staff_skills k WHERE k.business_id=s.business_id AND k.sku_id=s.id) AS stylist_count,
      (SELECT count(*)::int FROM salon_service_products bp WHERE bp.business_id=s.business_id AND bp.service_sku_id=s.id) AS backbar_products
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      LEFT JOIN catalog_categories c ON c.business_id=p.business_id AND c.id=p.category_id
      LEFT JOIN salon_services ss ON ss.business_id=s.business_id AND ss.sku_id=s.id
      WHERE s.business_id=$1 AND p.kind='service' AND ${planSkuFilter}`,
    search: ['label', 'code', 'category'], filters: { active: 'active' }, order: 'active DESC,category NULLS LAST,label',
  },
  'salon-staff': {
    sql: `SELECT r.*,l.name AS location_name,COALESCE(pr.kind,'staff') AS kind,
      COALESCE((SELECT json_agg(json_build_object('sku_id',k.sku_id,'label',s.label) ORDER BY s.label) FROM salon_staff_skills k
        JOIN catalog_skus s ON s.business_id=k.business_id AND s.id=k.sku_id WHERE k.business_id=r.business_id AND k.resource_id=r.id),'[]') AS skills,
      (SELECT count(*)::int FROM business_appointments a JOIN businesses b ON b.id=a.business_id WHERE a.business_id=r.business_id AND a.resource_id=r.id
        AND a.status='booked' AND (a.starts_at AT TIME ZONE b.timezone)::date = ${TODAY}) AS booked_today,
      COALESCE(pr.weekly_off,'{}') AS weekly_off,pr.works_from,pr.works_to,
      COALESCE((SELECT json_agg(json_build_object('dow',w.dow,'off',w.off,'works_from',w.works_from,'works_to',w.works_to) ORDER BY w.dow) FROM salon_staff_week w
        WHERE w.business_id=r.business_id AND w.resource_id=r.id),'[]') AS week,
      COALESCE((SELECT json_agg(json_build_object('id',lv.id,'from_date',lv.from_date,'to_date',lv.to_date,'reason',lv.reason) ORDER BY lv.from_date)
        FROM salon_staff_leave lv JOIN businesses b ON b.id=lv.business_id WHERE lv.business_id=r.business_id AND lv.resource_id=r.id AND lv.cancelled_at IS NULL
        AND lv.to_date >= ${TODAY}),'[]') AS leave
      FROM business_resources r JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
      LEFT JOIN salon_resource_profiles pr ON pr.business_id=r.business_id AND pr.resource_id=r.id WHERE r.business_id=$1`,
    search: ['name', 'role_label', 'location_name', 'kind'], filters: { kind: 'kind', active: 'active', location: 'location_id' }, order: 'active DESC,kind DESC,name',
  },
  'salon-plans': {
    sql: `SELECT pl.*,s.code AS sku_code,s.price,s.tax_rate,s.tax_rate_id,
      COALESCE((SELECT json_agg(json_build_object('sku_id',ps.sku_id,'label',x.label,'sessions',ps.sessions,'price',x.price) ORDER BY x.label) FROM salon_plan_services ps
        JOIN catalog_skus x ON x.business_id=ps.business_id AND x.id=ps.sku_id WHERE ps.business_id=pl.business_id AND ps.plan_id=pl.id),'[]') AS services,
      (SELECT count(*)::int FROM salon_client_plans cp WHERE cp.business_id=pl.business_id AND cp.plan_id=pl.id) AS sold,
      (SELECT count(*)::int FROM salon_client_plans cp JOIN businesses b ON b.id=cp.business_id WHERE cp.business_id=pl.business_id AND cp.plan_id=pl.id
        AND cp.status='active' AND cp.ends_on >= ${TODAY}) AS holders
      FROM salon_plans pl JOIN catalog_skus s ON s.business_id=pl.business_id AND s.id=pl.sku_id WHERE pl.business_id=$1`,
    search: ['name', 'description', 'sku_code'], filters: { kind: 'kind', active: 'active' }, order: 'active DESC,kind,name',
  },
  'salon-client-plans': {
    sql: `SELECT cp.*,c.name AS contact_name,c.phone AS contact_phone,d.document_no,
      CASE WHEN cp.status='cancelled' THEN 'cancelled' WHEN cp.ends_on < ${TODAY} THEN 'expired'
        WHEN cp.starts_on > ${TODAY} THEN 'upcoming'
        WHEN cp.kind='package' AND NOT EXISTS (SELECT 1 FROM salon_client_plan_services s WHERE s.business_id=cp.business_id AND s.client_plan_id=cp.id AND s.sessions > ${USED_SQL}) THEN 'used_up'
        ELSE 'active' END AS state,
      (cp.ends_on - ${TODAY}) AS days_left,
      COALESCE((SELECT json_agg(json_build_object('sku_id',s.sku_id,'label',s.label,'sessions',s.sessions,'used',${USED_SQL}) ORDER BY s.label)
        FROM salon_client_plan_services s WHERE s.business_id=cp.business_id AND s.client_plan_id=cp.id),'[]') AS services,
      COALESCE((SELECT sum(s.sessions) FROM salon_client_plan_services s WHERE s.business_id=cp.business_id AND s.client_plan_id=cp.id),0)::int AS sessions_total,
      COALESCE((SELECT sum(${USED_SQL}) FROM salon_client_plan_services s WHERE s.business_id=cp.business_id AND s.client_plan_id=cp.id),0)::int AS sessions_used,
      COALESCE((SELECT sum(u.amount) FROM salon_membership_uses u WHERE u.business_id=cp.business_id AND u.client_plan_id=cp.id),0) AS saved
      FROM salon_client_plans cp JOIN businesses b ON b.id=cp.business_id
      JOIN business_contacts c ON c.business_id=cp.business_id AND c.id=cp.contact_id
      JOIN business_documents d ON d.business_id=cp.business_id AND d.id=cp.document_id WHERE cp.business_id=$1`,
    search: ['contact_name', 'contact_phone', 'name', 'document_no'], date: 'created_at',
    filters: { kind: 'kind', state: 'state', contact: 'contact_id', plan: 'plan_id' }, order: 'id DESC',
  },
  'salon-commission-rules': {
    sql: `SELECT cr.*,r.name AS resource_name,s.label AS sku_label FROM salon_commission_rules cr
      LEFT JOIN business_resources r ON r.business_id=cr.business_id AND r.id=cr.resource_id
      LEFT JOIN catalog_skus s ON s.business_id=cr.business_id AND s.id=cr.sku_id WHERE cr.business_id=$1`,
    search: ['resource_name', 'sku_label', 'applies_to'], filters: { active: 'active', staff: 'resource_id' }, order: 'active DESC,resource_id NULLS FIRST,applies_to,sku_id NULLS FIRST',
  },
  'salon-commission-lines': {
    sql: `SELECT ls.line_id,ls.document_id,ls.resource_id,ls.appointment_id,ls.rule_id,ls.item_kind,ls.commission_percent,ls.commission_base,ls.commission_amount,
      d.document_no,d.created_at,d.contact_name,d.location_id,l.label,l.quantity,l.net,r.name AS resource_name,
      ${returnedSql('l')} AS returned_quantity,
      round(ls.commission_amount*(l.quantity-${returnedSql('l')})/l.quantity,2) AS commission_after_returns
      FROM salon_line_staff ls JOIN business_document_lines l ON l.business_id=ls.business_id AND l.id=ls.line_id
      JOIN business_documents d ON d.business_id=ls.business_id AND d.id=ls.document_id
      JOIN business_resources r ON r.business_id=ls.business_id AND r.id=ls.resource_id WHERE ls.business_id=$1`,
    search: ['document_no', 'label', 'resource_name', 'contact_name'], date: 'created_at', filters: { staff: 'resource_id', kind: 'item_kind', location: 'location_id' }, order: 'created_at DESC,line_id DESC',
  },
});

// --- Booking rules -----------------------------------------------------------------------

async function settingsRow(db, businessId) {
  return (await repo.one(db, 'SELECT * FROM salon_settings WHERE business_id=$1', [businessId]))
    || { business_id: businessId, deposit_percent: '0', free_cancel_hours: 4, late_cancel_fee_percent: '50', no_show_fee_percent: '100', opens_at: '09:00:00', closes_at: '21:00:00', fee_sku_id: null,
      session_commission_basis: 'package_price' };
}
async function getSettings(business) {
  requireSalon(business);
  await access.requireAny(business, ['appointments.view', 'settings.view']);
  return settingsRow(repo.pool, business.id);
}
function timeText(value, name) {
  const text = String(value ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(text)) fail(`${name} must be a time like 09:30`);
  return text.slice(0, 5);
}
async function saveSettings(business, user, body) {
  requireSalon(business);
  await access.require(business, 'settings.edit');
  const f = {
    deposit: core.decimal(body.depositPercent ?? 0, 'Deposit %', 2, 0, 100),
    hours: core.decimal(body.freeCancelHours ?? 4, 'Free cancellation hours', 0, 0, 168),
    late: core.decimal(body.lateCancelFeePercent ?? 0, 'Late cancellation fee %', 2, 0, 100),
    noShow: core.decimal(body.noShowFeePercent ?? 0, 'No-show fee %', 2, 0, 100),
    opens: timeText(body.opensAt ?? '09:00', 'Opens at'), closes: timeText(body.closesAt ?? '21:00', 'Closes at'),
    basis: v.requiredEnum(body.sessionCommissionBasis ?? 'package_price', 'Commission on package sessions', ['package_price', 'list_price']),
  };
  if (f.closes <= f.opens) fail('Closing time must be after opening time');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `INSERT INTO salon_settings(business_id,deposit_percent,free_cancel_hours,late_cancel_fee_percent,no_show_fee_percent,opens_at,closes_at,updated_by,session_commission_basis)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(business_id) DO UPDATE SET deposit_percent=EXCLUDED.deposit_percent,free_cancel_hours=EXCLUDED.free_cancel_hours,
      late_cancel_fee_percent=EXCLUDED.late_cancel_fee_percent,no_show_fee_percent=EXCLUDED.no_show_fee_percent,opens_at=EXCLUDED.opens_at,closes_at=EXCLUDED.closes_at,
      session_commission_basis=EXCLUDED.session_commission_basis,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, f.deposit, f.hours, f.late, f.noShow, f.opens, f.closes, user.id, f.basis]);
    await repo.audit(db, business.id, user.id, 'salon.rules_updated', business.id, f);
    return row;
  });
}

// --- Services and stylists ------------------------------------------------------------------

async function saveService(business, user, skuId, body) {
  requireSalon(business);
  await access.require(business, 'catalog.edit');
  const duration = core.decimal(body.durationMinutes, 'Duration (minutes)', 0, 5, 600);
  const buffer = core.decimal(body.bufferMinutes ?? 0, 'Clean-up time (minutes)', 0, 0, 120);
  const needsRoom = v.requiredBoolean(body.needsRoom, 'Needs a room', false);
  return repo.transaction(async (db) => {
    const sku = await repo.one(db, `SELECT s.id FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2 AND p.kind='service'`, [business.id, id(skuId, 'Service')]);
    if (!sku) fail('Service not found', 404);
    const row = await repo.one(db, `INSERT INTO salon_services(business_id,sku_id,duration_minutes,buffer_minutes,needs_room,updated_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(business_id,sku_id) DO UPDATE SET duration_minutes=EXCLUDED.duration_minutes,buffer_minutes=EXCLUDED.buffer_minutes,needs_room=EXCLUDED.needs_room,
      updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [business.id, sku.id, duration, buffer, needsRoom, user.id]);
    await repo.audit(db, business.id, user.id, 'salon.service_timed', sku.id, { duration, buffer, needsRoom });
    return row;
  });
}

// kind: staff (stylist) or room; skuIds: the services a stylist does (empty = every service).
async function saveStaff(business, user, resourceId, body) {
  requireSalon(business);
  await access.require(business, 'appointments.create');
  const kind = v.requiredEnum(body.kind ?? 'staff', 'Stylist or room', ['staff', 'room']);
  const skuIds = [...new Set(v.requiredArray(body.skuIds ?? [], 'Services').map((x) => id(x, 'Service')))];
  if (kind === 'room' && skuIds.length) fail('A room has no skills; give services to a stylist');
  // Working hours and the weekly day off (optional; kept when not sent).
  const schedule = readSchedule(body);
  return repo.transaction(async (db) => {
    const resource = await repo.one(db, 'SELECT * FROM business_resources WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(resourceId, 'Stylist or room')]);
    if (!resource) fail('Stylist or room not found', 404);
    if (kind === 'room') {
      const booked = await repo.one(db, `SELECT count(*)::int AS n FROM business_appointments WHERE business_id=$1 AND resource_id=$2 AND status='booked' AND ends_at>now()`, [business.id, resource.id]);
      if (booked.n) fail(`${resource.name} has ${booked.n} upcoming booking${booked.n === 1 ? '' : 's'} as a stylist; move them before making it a room`, 409);
    }
    // Rename, change the role, or switch off (not with bookings to come).
    const name = body.name === undefined ? resource.name : v.requiredString(body.name, 'Name', 150);
    const roleLabel = body.roleLabel === undefined ? resource.role_label : v.optionalString(body.roleLabel, 'Role', 100);
    const active = v.requiredBoolean(body.active, 'Active', resource.active);
    if (!active && resource.active) {
      const coming = await repo.one(db, `SELECT count(*)::int AS n FROM business_appointments a LEFT JOIN salon_appointment_details d ON d.business_id=a.business_id AND d.appointment_id=a.id
        WHERE a.business_id=$1 AND (a.resource_id=$2 OR d.room_id=$2) AND a.status='booked' AND a.ends_at>now()`, [business.id, resource.id]);
      if (coming.n) fail(`${resource.name} has ${coming.n} booking${coming.n === 1 ? '' : 's'} to come; move ${coming.n === 1 ? 'it' : 'them'} first`, 409);
    }
    if (name !== resource.name || roleLabel !== resource.role_label || active !== resource.active) {
      await db.query('UPDATE business_resources SET name=$3,role_label=$4,active=$5 WHERE business_id=$1 AND id=$2', [business.id, resource.id, name, roleLabel, active]);
      Object.assign(resource, { name, role_label: roleLabel, active });
    }
    await db.query(`INSERT INTO salon_resource_profiles(business_id,resource_id,kind) VALUES($1,$2,$3)
      ON CONFLICT(business_id,resource_id) DO UPDATE SET kind=EXCLUDED.kind`, [business.id, resource.id, kind]);
    if (schedule || kind === 'room') {
      const plan = kind === 'room' ? { weeklyOff: [], from: null, to: null } : schedule;
      await db.query('UPDATE salon_resource_profiles SET weekly_off=$3,works_from=$4,works_to=$5 WHERE business_id=$1 AND resource_id=$2',
        [business.id, resource.id, plan.weeklyOff, plan.from, plan.to]);
    }
    if (body.skuIds !== undefined || kind === 'room') await db.query('DELETE FROM salon_staff_skills WHERE business_id=$1 AND resource_id=$2', [business.id, resource.id]);
    if (skuIds.length) {
      await db.query('INSERT INTO salon_staff_skills(business_id,resource_id,sku_id) SELECT $1,$2,unnest($3::bigint[])', [business.id, resource.id, skuIds]);
    }
    await repo.audit(db, business.id, user.id, 'salon.staff_updated', resource.id, { kind, skuIds, ...(schedule ? { schedule } : {}) });
    return { ...resource, kind, skuIds };
  });
}

function readSchedule(body) {
  if (body.weeklyOff === undefined && body.worksFrom === undefined && body.worksTo === undefined) return null;
  const weeklyOff = [...new Set(v.requiredArray(body.weeklyOff ?? [], 'Weekly off').map((d) => {
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 6) fail('Weekly off days are 0 (Sunday) to 6 (Saturday)');
    return n;
  }))].sort();
  if (weeklyOff.length > 6) fail('Leave at least one working day in the week');
  const has = (x) => x !== undefined && x !== null && x !== '';
  if (has(body.worksFrom) !== has(body.worksTo)) fail('Give both the start and the end of the working hours, or neither');
  const from = has(body.worksFrom) ? timeText(body.worksFrom, 'Works from') : null;
  const to = has(body.worksTo) ? timeText(body.worksTo, 'Works till') : null;
  if (from && to <= from) fail('Working hours must end after they start');
  return { weeklyOff, from, to };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// A stylist is booked only on a working day, inside their hours for that
// weekday (the weekly schedule), not on leave and not on a salon
// holiday. Returns what is wrong, or null.
async function availabilityProblem(db, business, staff, starts, ends) {
  const row = await repo.one(db, `SELECT COALESCE(p.weekly_off,'{}') AS weekly_off,p.works_from,p.works_to,
    w.off AS day_off,w.works_from AS day_from,w.works_to AS day_to,(w.dow IS NOT NULL) AS has_day,
    extract(dow FROM ($2::timestamptz AT TIME ZONE b.timezone))::int AS dow,
    ($2::timestamptz AT TIME ZONE b.timezone)::time AS starts,($3::timestamptz AT TIME ZONE b.timezone)::time AS ends,
    (SELECT lv.reason FROM salon_staff_leave lv WHERE lv.business_id=b.id AND lv.resource_id=$4 AND lv.cancelled_at IS NULL
      AND ($2::timestamptz AT TIME ZONE b.timezone)::date BETWEEN lv.from_date AND lv.to_date ORDER BY lv.id LIMIT 1) AS leave_reason,
    EXISTS (SELECT 1 FROM salon_staff_leave lv WHERE lv.business_id=b.id AND lv.resource_id=$4 AND lv.cancelled_at IS NULL
      AND ($2::timestamptz AT TIME ZONE b.timezone)::date BETWEEN lv.from_date AND lv.to_date) AS on_leave,
    (SELECT h.name FROM salon_holidays h WHERE h.business_id=b.id AND h.cancelled_at IS NULL AND (h.location_id IS NULL OR h.location_id=$5)
      AND h.day=($2::timestamptz AT TIME ZONE b.timezone)::date ORDER BY h.location_id NULLS LAST LIMIT 1) AS holiday
    FROM businesses b LEFT JOIN salon_resource_profiles p ON p.business_id=b.id AND p.resource_id=$4
    LEFT JOIN salon_staff_week w ON w.business_id=b.id AND w.resource_id=$4 AND w.dow=extract(dow FROM ($2::timestamptz AT TIME ZONE b.timezone))::int
    WHERE b.id=$1`, [business.id, starts, ends, staff.id, staff.location_id]);
  if (row.holiday) return `The salon is closed that day (${row.holiday}).`;
  if (row.on_leave) return `${staff.name} is on leave that day${row.leave_reason ? ` (${row.leave_reason})` : ''}.`;
  const off = row.has_day ? row.day_off : (row.weekly_off || []).map(Number).includes(Number(row.dow));
  if (off) return `${staff.name} has ${DAY_NAMES[row.dow]} off.`;
  const from = row.has_day && row.day_from ? row.day_from : row.works_from;
  const to = row.has_day && row.day_from ? row.day_to : row.works_to;
  if (from && (row.starts < from || row.ends > to)) return `${staff.name} works from ${String(from).slice(0, 5)} to ${String(to).slice(0, 5)} on ${DAY_NAMES[row.dow]}s.`;
  return null;
}
// Refuses (409, reason outside_hours) unless a manager let it through
// (`override`, read by businessManagerPin.readApproval); returns the rule
// that was broken when it was let through, so the caller can keep it.
async function staffAvailable(db, business, staff, starts, ends, override = null) {
  const problem = await availabilityProblem(db, business, staff, starts, ends);
  if (!problem) return null;
  if (!override) fail(`${problem} Choose another stylist or time, or ask a manager to let it through.`, 409, { reason: 'outside_hours', rule: problem });
  return problem;
}
// Kept with the booking: who let it through, why, and what rule it broke.
async function recordOverride(db, business, user, appointmentId, action, rule, override) {
  await db.query(`INSERT INTO salon_booking_overrides(business_id,appointment_id,action,rule_broken,reason,approved_by,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [business.id, appointmentId, action, rule.slice(0, 300), override.reason, override.approver.id, user.id]);
  await repo.audit(db, business.id, override.approver.id, 'appointment.override', appointmentId, { action, rule, reason: override.reason, requestedBy: user.id });
}

// --- Calendar ----------------------------------------------------------------------------------

async function calendar(business, query) {
  requireSalon(business);
  await access.require(business, 'appointments.view');
  const day = core.dateText(query.date, 'Date');
  const locationId = optionalId(query.location, 'Location');
  // A week (or a few days) at once.
  const days = query.days === undefined || query.days === '' ? 1 : Number(query.days);
  if (!Number.isInteger(days) || days < 1 || days > 7) fail('Show 1 to 7 days at a time');
  const db = repo.pool;
  const [settings, resources, appointments, services, holidays] = await Promise.all([
    settingsRow(db, business.id),
    repo.all(db, `SELECT r.id,r.name,r.role_label,r.location_id,r.active,COALESCE(p.kind,'staff') AS kind,
      COALESCE(p.weekly_off,'{}') AS weekly_off,p.works_from,p.works_to,
      COALESCE((SELECT json_agg(json_build_object('dow',w.dow,'off',w.off,'works_from',w.works_from,'works_to',w.works_to) ORDER BY w.dow) FROM salon_staff_week w
        WHERE w.business_id=r.business_id AND w.resource_id=r.id),'[]') AS week,
      COALESCE((SELECT json_agg(json_build_object('from_date',lv.from_date,'to_date',lv.to_date,'reason',lv.reason)) FROM salon_staff_leave lv
        WHERE lv.business_id=r.business_id AND lv.resource_id=r.id AND lv.cancelled_at IS NULL AND lv.to_date >= $3::date AND lv.from_date <= $3::date + ($4::int - 1)),'[]') AS leave,
      COALESCE((SELECT json_agg(k.sku_id) FROM salon_staff_skills k WHERE k.business_id=r.business_id AND k.resource_id=r.id),'[]') AS skills
      FROM business_resources r LEFT JOIN salon_resource_profiles p ON p.business_id=r.business_id AND p.resource_id=r.id
      WHERE r.business_id=$1 AND r.active AND ($2::bigint IS NULL OR r.location_id=$2) ORDER BY COALESCE(p.kind,'staff') DESC,r.id`, [business.id, locationId, day, days]),
    repo.all(db, `SELECT a.*,c.name AS contact_name,c.phone AS contact_phone,s.label AS service_name,r.name AS resource_name,
      d.room_id,rm.name AS room_name,d.price_at_booking,d.notes,d.deposit_collection_id,k.collection_no AS deposit_no,k.amount AS deposit_amount,k.method AS deposit_method,
      CASE WHEN k.id IS NULL THEN NULL ELSE ${freeSql('k')} END AS deposit_unused,
      d.fee_document_id,fd.document_no AS fee_no,fd.total AS fee_total,d.bill_document_id,bd.document_no AS bill_no,bd.total AS bill_total,
      d.arrived_at,d.confirmation_sent_at,d.reminder_sent_at,COALESCE(d.walk_in,false) AS walk_in,COALESCE(d.moved_count,0) AS moved_count,
      (a.starts_at AT TIME ZONE b.timezone)::date::text AS day,
      (a.status='booked' AND a.starts_at < now() AND d.arrived_at IS NULL) AS late,
      (SELECT count(*)::int FROM business_appointments x WHERE x.business_id=a.business_id AND x.contact_id=a.contact_id AND x.status='no_show') AS client_no_shows,
      EXISTS (SELECT 1 FROM salon_client_plans cp WHERE cp.business_id=a.business_id AND cp.contact_id=a.contact_id AND cp.kind='membership' AND cp.status='active'
        AND cp.ends_on >= (now() AT TIME ZONE b.timezone)::date) AS member,
      NOT EXISTS (SELECT 1 FROM business_documents x WHERE x.business_id=a.business_id AND x.contact_id=a.contact_id AND x.kind='sale') AS first_visit,
      COALESCE(cat.name,sp.category) AS category
      FROM business_appointments a JOIN businesses b ON b.id=a.business_id
      JOIN business_contacts c ON c.business_id=a.business_id AND c.id=a.contact_id
      JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
      JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
      LEFT JOIN salon_appointment_details d ON d.business_id=a.business_id AND d.appointment_id=a.id
      LEFT JOIN business_resources rm ON rm.business_id=d.business_id AND rm.id=d.room_id
      LEFT JOIN business_collections k ON k.business_id=d.business_id AND k.id=d.deposit_collection_id
      LEFT JOIN business_documents fd ON fd.business_id=d.business_id AND fd.id=d.fee_document_id
      LEFT JOIN business_documents bd ON bd.business_id=d.business_id AND bd.id=d.bill_document_id
      JOIN catalog_products sp ON sp.business_id=s.business_id AND sp.id=s.product_id
      LEFT JOIN catalog_categories cat ON cat.business_id=sp.business_id AND cat.id=sp.category_id
      WHERE a.business_id=$1 AND (a.starts_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $2::date + ($4::int - 1) AND ($3::bigint IS NULL OR r.location_id=$3)
      ORDER BY a.starts_at,a.id`, [business.id, day, locationId, days]),
    repo.all(db, `SELECT s.id,s.label,s.price,COALESCE(ss.duration_minutes,60) AS duration_minutes,COALESCE(ss.buffer_minutes,0) AS buffer_minutes,
      COALESCE(ss.needs_room,false) AS needs_room FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      LEFT JOIN salon_services ss ON ss.business_id=s.business_id AND ss.sku_id=s.id
      WHERE s.business_id=$1 AND s.active AND p.active AND p.kind='service' AND ${planSkuFilter} ORDER BY s.label`, [business.id]),
    // Salon holidays in the days shown.
    repo.all(db, `SELECT id,location_id,day::text AS day,name FROM salon_holidays WHERE business_id=$1 AND cancelled_at IS NULL
      AND day BETWEEN $2::date AND $2::date + ($3::int - 1) AND ($4::bigint IS NULL OR location_id IS NULL OR location_id=$4) ORDER BY day`, [business.id, day, days, locationId]),
  ]);
  const totals = appointments.reduce((t, a) => {
    t[a.status] = (t[a.status] || 0) + 1;
    return t;
  }, {});
  totals.arrived = appointments.filter((a) => a.status === 'booked' && a.arrived_at).length;
  return { date: day, days, timezone: business.timezone, settings, resources, appointments, services, totals, holidays,
    canOverride: access.can(business, 'appointments.approve') };
}

// --- Booking -----------------------------------------------------------------------------------

async function lockResource(db, business, resourceId, kind, label) {
  const row = await repo.one(db, `SELECT r.*,COALESCE(p.kind,'staff') AS kind FROM business_resources r
    LEFT JOIN salon_resource_profiles p ON p.business_id=r.business_id AND p.resource_id=r.id
    WHERE r.business_id=$1 AND r.id=$2 AND r.active FOR UPDATE OF r`, [business.id, resourceId]);
  if (!row || row.kind !== kind) fail(`${label} not found`, 404);
  access.requireLocation(business, row.location_id);
  return row;
}
async function clash(db, business, column, resourceId, starts, ends) {
  const join = column === 'room' ? 'JOIN salon_appointment_details d ON d.business_id=a.business_id AND d.appointment_id=a.id AND d.room_id=$2' : '';
  return repo.one(db, `SELECT a.id,a.starts_at FROM business_appointments a ${join} WHERE a.business_id=$1 ${column === 'room' ? '' : 'AND a.resource_id=$2'}
    AND a.status='booked' AND a.starts_at<$4 AND a.ends_at>$3 LIMIT 1`, [business.id, resourceId, starts, ends]);
}

// A client's money taken in advance: a shared receivables collection with
// nothing put against bills yet (the client's advance).
async function takeDeposit(db, business, user, { location, contact, amount, method, methodName = null, reference, requestKey, note }) {
  const key = derivedKey(requestKey, 'deposit');
  const number = await numbering.nextNumber(db, business.id, location.id, 'collection', user.id);
  const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, rupees(amount), method, reference, note.slice(0, 500), key, hashOf({ key, amount, method }), user.id, methodName]);
  await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { collectionNo: collection.collection_no, amount: collection.amount, allocated: '0.00', deposit: true });
  await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
    collectionNo: collection.collection_no, contactId: contact.id, amount: collection.amount, method, allocations: [], unallocated: collection.amount, purpose: 'deposit',
  });
  return collection;
}

// body: { contactId, skuId, resourceId, roomId?, startsAt, notes?, requestKey,
//   deposit?: { amount, method, reference? } }
// The booking blocks the stylist (and the room) for the service's time plus
// its clean-up time.
async function book(business, user, body) {
  requireSalon(business);
  await access.require(business, 'appointments.create');
  const input = await readBooking(business, body, user);
  return repo.transaction(async (db) => bookIn(db, business, user, body, input));
}
// A manager's override of the stylist's hours / leave / a holiday:
// body.override = { reason, approverId?, pin? }. Read before the transaction.
async function readOverride(business, user, body) {
  if (body.override === undefined || body.override === null) return null;
  return pins().readApproval(business, user, body.override, 'appointments.approve', { reasonLabel: 'Reason for booking outside the hours', selfWithoutPin: true });
}
// The request's hash leaves out the PIN (it is never kept, not even hashed).
const bookingHash = (body) => hashOf(body.override ? { ...body, override: { reason: body.override.reason, approverId: body.override.approverId ?? null } } : body);
async function readBooking(business, body, user) {
  const requestKey = core.uuid(body.requestKey);
  const hash = bookingHash(body);
  const override = user ? await readOverride(business, user, body) : null;
  const starts = new Date(body.startsAt);
  if (typeof body.startsAt !== 'string' || !Number.isFinite(starts.getTime())) fail('Choose when the appointment starts');
  let deposit = null;
  if (body.deposit !== undefined && body.deposit !== null) {
    if (typeof body.deposit !== 'object' || Array.isArray(body.deposit)) fail('Deposit must be an object');
    const amount = paise(core.decimal(body.deposit.amount, 'Deposit', 2, 0, 1000000));
    if (amount > 0) {
      await access.require(business, 'sales.edit');
      // `methodId`: one of the business's own payment methods.
      const { method, methodName } = await paymentMethods.pick(repo.pool, business.id, body.deposit, 'Deposit paid by', METHODS);
      const reference = v.optionalString(body.deposit.reference, 'Reference', 100);
      if (method === 'cheque' && !reference) fail('Enter the cheque number as the reference');
      deposit = { amount, method, methodName, reference };
    }
  }
  const notes = v.optionalString(body.notes, 'Notes', 300);
  return { requestKey, hash, starts, deposit, notes, override };
}
// Inside the caller's transaction. options.walkIn: seated from the waiting
// list now, so the client is marked arrived.
async function bookIn(db, business, user, body, { requestKey, hash, starts, deposit, notes, override = null }, options = {}) {
  {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM salon_appointment_details WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2', [business.id, old.appointment_id]);
    }
    const staff = await lockResource(db, business, id(body.resourceId, 'Stylist'), 'staff', 'Stylist');
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active FOR UPDATE", [business.id, id(body.contactId, 'Client')]);
    if (!contact) fail('Client not found', 404);
    const service = await repo.one(db, `SELECT s.*,COALESCE(ss.duration_minutes,60) AS duration_minutes,COALESCE(ss.buffer_minutes,0) AS buffer_minutes,COALESCE(ss.needs_room,false) AS needs_room
      FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      LEFT JOIN salon_services ss ON ss.business_id=s.business_id AND ss.sku_id=s.id
      WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active AND p.kind='service'`, [business.id, id(body.skuId, 'Service')]);
    if (!service) fail('Service not found', 404);
    const skills = await repo.all(db, 'SELECT sku_id FROM salon_staff_skills WHERE business_id=$1 AND resource_id=$2', [business.id, staff.id]);
    if (skills.length && !skills.some((k) => Number(k.sku_id) === Number(service.id))) fail(`${staff.name} does not do ${service.label}. Choose another stylist or add the skill under Service times & skills.`, 409);
    const ends = new Date(starts.getTime() + (Number(service.duration_minutes) + Number(service.buffer_minutes)) * 60000);
    const settings = await settingsRow(db, business.id);
    const hours = await repo.one(db, `SELECT ($2::timestamptz AT TIME ZONE b.timezone)::time AS starts,($3::timestamptz AT TIME ZONE b.timezone)::time AS ends,
      ($2::timestamptz AT TIME ZONE b.timezone)::date = ($3::timestamptz AT TIME ZONE b.timezone)::date AS same_day,
      $2::timestamptz < now() - interval '1 day' AS long_past FROM businesses b WHERE b.id=$1`, [business.id, starts, ends]);
    if (hours.long_past) fail('That time has already passed');
    if (!hours.same_day) fail(`${service.label} takes ${Number(service.duration_minutes) + Number(service.buffer_minutes)} minutes with clean-up; it must end the same day`);
    let broken = null;
    if (hours.starts < settings.opens_at || hours.ends > settings.closes_at) {
      broken = `The salon books from ${String(settings.opens_at).slice(0, 5)} to ${String(settings.closes_at).slice(0, 5)}; ${service.label} takes ${Number(service.duration_minutes) + Number(service.buffer_minutes)} minutes with clean-up.`;
      if (!override) fail(broken, 400, { reason: 'outside_hours', rule: broken });
    }
    let room = null;
    const roomId = optionalId(body.roomId, 'Room');
    if (roomId) room = await lockResource(db, business, roomId, 'room', 'Room');
    if (service.needs_room && !room) fail(`${service.label} needs a room. Choose one.`);
    if (room && Number(room.location_id) !== Number(staff.location_id)) fail(`${room.name} is at another location than ${staff.name}`);
    const away = await staffAvailable(db, business, staff, starts, ends, override);
    broken = [broken, away].filter(Boolean).join(' ') || null;
    if (await clash(db, business, 'staff', staff.id, starts, ends)) fail(`${staff.name} already has an appointment at that time`, 409);
    if (room && await clash(db, business, 'room', room.id, starts, ends)) fail(`${room.name} is already booked at that time`, 409);
    const appointment = await repo.one(db, `INSERT INTO business_appointments(business_id,resource_id,contact_id,sku_id,starts_at,ends_at,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [business.id, staff.id, contact.id, service.id, starts, ends, user.id]);
    let collection = null;
    if (deposit) {
      const location = await repo.one(db, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, staff.location_id]);
      collection = await takeDeposit(db, business, user, { location, contact, ...deposit, requestKey,
        note: `Deposit for ${service.label} on ${starts.toISOString().slice(0, 10)}` });
    }
    await db.query(`INSERT INTO salon_appointment_details(business_id,appointment_id,room_id,price_at_booking,deposit_collection_id,notes,request_key,request_hash,walk_in,arrived_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9 THEN now() END)`, [business.id, appointment.id, room?.id || null, service.price, collection?.id || null, notes, requestKey, hash,
      Boolean(options.walkIn)]);
    if (broken) await recordOverride(db, business, user, appointment.id, 'booked', broken, override);
    await repo.audit(db, business.id, user.id, 'appointment.booked', appointment.id, { roomId: room?.id || null, deposit: collection ? collection.amount : null, ...(broken ? { override: override.reason } : {}) });
    await repo.event(db, business.id, user.id, 'appointment.booked', 'appointment', appointment.id, {
      resourceId: staff.id, roomId: room?.id || null, contactId: contact.id, skuId: service.id, startsAt: appointment.starts_at, endsAt: appointment.ends_at,
      depositCollectionId: collection?.id || null, deposit: collection?.amount || null,
    });
    return { ...appointment, room_id: room?.id || null, deposit_collection_id: collection?.id || null, deposit_no: collection?.collection_no || null };
  }
}

// The item fee bills are raised on, created the first time a fee is charged.
async function feeSku(db, business, user, settings) {
  if (settings.fee_sku_id) return repo.one(db, 'SELECT * FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, settings.fee_sku_id]);
  const slab = await repo.one(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active AND rate=18 ORDER BY id LIMIT 1', [business.id])
    || await repo.one(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active ORDER BY is_default DESC,id LIMIT 1', [business.id]);
  const product = await repo.one(db, "INSERT INTO catalog_products(business_id,name,kind) VALUES($1,'Cancellation and no-show charges','service') RETURNING *", [business.id]);
  let code = 'SALON-FEE';
  for (let n = 2; await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [business.id, code]); n += 1) code = `SALON-FEE-${n}`;
  const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,label,unit,price,tax_rate,tax_rate_id,tracking)
    VALUES($1,$2,$3,'Cancellation / no-show charge','service',0,$4,$5,'none') RETURNING *`, [business.id, product.id, code, slab?.rate ?? 0, slab?.id || null]);
  await db.query(`INSERT INTO salon_settings(business_id,fee_sku_id,updated_by) VALUES($1,$2,$3)
    ON CONFLICT(business_id) DO UPDATE SET fee_sku_id=EXCLUDED.fee_sku_id`, [business.id, sku.id, user.id]);
  return sku;
}

// The rule (docs): cancelling at least `free_cancel_hours` before the start is
// free; later, or not turning up, costs the fee % of the price booked — but
// only ever out of the deposit (never more than what is left of it), as a
// numbered bill paid from the deposit. Whatever is left of the deposit stays
// the client's advance for their next bill.
function feeFor(settings, appointment, status, details, depositFree) {
  if (!details || status === 'completed' || depositFree <= 0) return { percent: 0, amount: 0 };
  let percent = 0;
  if (status === 'no_show') percent = Number(settings.no_show_fee_percent);
  if (status === 'cancelled') {
    const hoursBefore = (new Date(appointment.starts_at).getTime() - Date.now()) / 3600000;
    if (hoursBefore < Number(settings.free_cancel_hours)) percent = Number(settings.late_cancel_fee_percent);
  }
  const wanted = Math.round((paise(details.price_at_booking) * percent) / 10000) * 100;
  const amount = Math.min(wanted, Math.floor(depositFree / 100) * 100);
  return { percent, amount: Math.max(0, amount) };
}

async function preview(business, appointmentId, status) {
  requireSalon(business);
  await access.require(business, 'appointments.view');
  const db = repo.pool;
  const appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2', [business.id, id(appointmentId, 'Appointment')]);
  await access.requireAppointmentLocation(db, business, appointment);
  if (!appointment) fail('Appointment not found', 404);
  const details = await repo.one(db, 'SELECT * FROM salon_appointment_details WHERE business_id=$1 AND appointment_id=$2', [business.id, appointment.id]);
  const free = details?.deposit_collection_id ? paise((await repo.one(db, `SELECT CASE WHEN ${releasedSql('k')} THEN 0 ELSE ${freeSql('k')} END AS free FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, details.deposit_collection_id])).free) : 0;
  const settings = await settingsRow(db, business.id);
  const fee = feeFor(settings, appointment, v.requiredEnum(status, 'Status', ['completed', 'cancelled', 'no_show']), details, free);
  return { percent: fee.percent, fee: rupees(fee.amount), depositUnused: rupees(free), freeCancelHours: settings.free_cancel_hours };
}

// body: { status: completed | cancelled | no_show, requestKey }
async function setStatus(business, user, appointmentId, body) {
  requireSalon(business);
  const status = v.requiredEnum(body.status, 'Status', ['completed', 'cancelled', 'no_show']);
  await access.require(business, status === 'cancelled' ? 'appointments.cancel' : 'appointments.edit');
  const requestKey = core.uuid(body.requestKey);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(appointmentId, 'Appointment')]);
    await access.requireAppointmentLocation(db, business, appointment);
    if (!appointment) fail('Appointment not found', 404);
    if (appointment.status !== 'booked') {
      if (appointment.status === status) return { appointment, fee: null, repeated: true };
      fail('Appointment is not booked any more', 409);
    }
    await core.statusAllowed(db, business, appointment, status);
    const details = await repo.one(db, 'SELECT * FROM salon_appointment_details WHERE business_id=$1 AND appointment_id=$2 FOR UPDATE', [business.id, appointment.id]);
    const collection = details?.deposit_collection_id ? await repo.one(db, `SELECT k.*,CASE WHEN ${releasedSql('k')} THEN 0 ELSE ${freeSql('k')} END AS free FROM business_collections k WHERE k.business_id=$1 AND k.id=$2`, [business.id, details.deposit_collection_id]) : null;
    const settings = await settingsRow(db, business.id);
    const fee = feeFor(settings, appointment, status, details, collection ? paise(collection.free) : 0);
    const updated = await repo.one(db, 'UPDATE business_appointments SET status=$3 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, appointment.id, status]);
    let feeDoc = null;
    if (fee.amount > 0) {
      if (!access.can(business, 'sales.create')) await access.require(business, 'sales.create');
      const sku = await feeSku(db, business, user, settings);
      const rate = Number(sku.tax_rate);
      const net = core.inclusiveNet(fee.amount, rate);
      const service = await repo.one(db, 'SELECT label FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, appointment.sku_id]);
      const staff = await repo.one(db, 'SELECT location_id FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, appointment.resource_id]);
      const feeBody = { kind: 'sale', locationId: staff.location_id, contactId: appointment.contact_id, lines: [{ skuId: sku.id, quantity: '1' }],
        notes: `${status === 'no_show' ? 'No-show' : 'Late cancellation'} charge (${fee.percent}%) — ${service.label}, ${new Date(appointment.starts_at).toISOString().slice(0, 10)}` };
      feeDoc = await core.postDocument(db, business, user, feeBody, { kind: 'sale', requestKey: derivedKey(requestKey, 'fee'), hash: hashOf(feeBody), lines: feeBody.lines, paidNow: null,
        fixed: [{ price: net / 100, net, tax: fee.amount - net, enteredPrice: null, priceRuleId: null }] });
      const pay = Math.min(paise(feeDoc.total), paise(collection.free));
      if (pay > 0) {
        await core.recordPayment(db, business, user, feeDoc, { amount: rupees(pay), method: collection.method, reference: collection.collection_no, key: derivedKey(requestKey, 'fee-paid'), collectionId: collection.id });
      }
      await db.query('UPDATE salon_appointment_details SET fee_document_id=$3 WHERE business_id=$1 AND appointment_id=$2', [business.id, appointment.id, feeDoc.id]);
    }
    await repo.audit(db, business.id, user.id, `appointment.${status}`, appointment.id, fee.amount ? { fee: rupees(fee.amount), feeDocumentNo: feeDoc.document_no } : {});
    await repo.event(db, business.id, user.id, `appointment.${status}`, 'appointment', appointment.id, { status, fee: rupees(fee.amount), feeDocumentId: feeDoc?.id || null });
    return { appointment: updated, fee: feeDoc ? { documentId: feeDoc.id, documentNo: feeDoc.document_no, total: feeDoc.total, percent: fee.percent } : null };
  });
}

// --- A client at the counter ------------------------------------------------------------------

async function clientSummary(db, business, contactId) {
  const contact = await repo.one(db, "SELECT id,name,phone,email FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
  if (!contact) fail('Client not found', 404);
  const [plans, deposits, upcoming, bills] = await Promise.all([
    business.modules.includes('packages') ? repo.page(business.id, 'salon-client-plans', 50, 0, { filters: { contact: String(contact.id) } }) : { items: [] },
    repo.all(db, `SELECT k.id,k.collection_no,k.amount,k.method,k.created_at,k.notes,${freeSql('k')} AS unused,NOT ${notHeldSql('k', "'{}'")} AS held,${releasedSql('k')} AS released,
      (SELECT sd.appointment_id FROM salon_appointment_details sd WHERE sd.business_id=k.business_id AND sd.deposit_collection_id=k.id LIMIT 1) AS appointment_id
      FROM business_collections k WHERE k.business_id=$1 AND k.contact_id=$2 AND ${freeSql('k')} > 0
      AND NOT EXISTS (SELECT 1 FROM business_collection_cheques q WHERE q.business_id=k.business_id AND q.collection_id=k.id AND q.status='bounced') ORDER BY k.id`, [business.id, contact.id]),
    repo.all(db, `SELECT a.id,a.starts_at,a.ends_at,a.status,a.resource_id,a.sku_id,s.label AS service_name,s.price,r.name AS resource_name,d.bill_document_id
      FROM business_appointments a JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
      JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
      LEFT JOIN salon_appointment_details d ON d.business_id=a.business_id AND d.appointment_id=a.id
      WHERE a.business_id=$1 AND a.contact_id=$2 AND (a.status='booked' OR (a.status='completed' AND d.bill_document_id IS NULL AND a.starts_at > now() - interval '7 days'))
      ORDER BY a.starts_at LIMIT 10`, [business.id, contact.id]),
    repo.all(db, `SELECT id,document_no,total,created_at FROM business_documents WHERE business_id=$1 AND contact_id=$2 AND kind='sale' ORDER BY id DESC LIMIT 5`, [business.id, contact.id]),
  ]);
  // The client card — profile, notes and formulas, visits, totals.
  const [profile, notes, visits, stats, refunds] = await Promise.all([
    repo.one(db, `SELECT p.*,r.name AS preferred_resource_name FROM salon_client_profiles p
      LEFT JOIN business_resources r ON r.business_id=p.business_id AND r.id=p.preferred_resource_id WHERE p.business_id=$1 AND p.contact_id=$2`, [business.id, contact.id]),
    repo.all(db, `SELECT n.id,n.kind,n.body,n.created_at,u.name AS created_by_name FROM salon_client_notes n JOIN users u ON u.id=n.created_by
      WHERE n.business_id=$1 AND n.contact_id=$2 ORDER BY n.created_at DESC,n.id DESC LIMIT 30`, [business.id, contact.id]),
    repo.all(db, `SELECT d.id AS document_id,d.document_no,d.created_at,l.label,l.quantity,l.net,ls.item_kind,r.name AS resource_name
      FROM business_documents d JOIN business_document_lines l ON l.business_id=d.business_id AND l.document_id=d.id
      LEFT JOIN salon_line_staff ls ON ls.business_id=l.business_id AND ls.line_id=l.id
      LEFT JOIN business_resources r ON r.business_id=ls.business_id AND r.id=ls.resource_id
      WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale' ORDER BY d.created_at DESC,l.id LIMIT 40`, [business.id, contact.id]),
    repo.one(db, `SELECT (SELECT count(*)::int FROM business_documents d WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale') AS visits,
      (SELECT COALESCE(sum(d.total),0) FROM business_documents d WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale') AS spent,
      (SELECT max(d.created_at) FROM business_documents d WHERE d.business_id=$1 AND d.contact_id=$2 AND d.kind='sale') AS last_visit,
      (SELECT count(*)::int FROM business_appointments a WHERE a.business_id=$1 AND a.contact_id=$2 AND a.status='no_show') AS no_shows,
      (SELECT r.name FROM salon_line_staff ls JOIN business_documents d ON d.business_id=ls.business_id AND d.id=ls.document_id
        JOIN business_resources r ON r.business_id=ls.business_id AND r.id=ls.resource_id WHERE ls.business_id=$1 AND d.contact_id=$2
        GROUP BY r.id,r.name ORDER BY count(*) DESC,max(ls.created_at) DESC LIMIT 1) AS usual_stylist`, [business.id, contact.id]),
    // Advances handed back (cash / UPI / bank), for the receipt.
    repo.all(db, `SELECT f.id,f.refund_no,f.amount,f.method,f.reference,f.reason,f.created_at,k.collection_no,a.name AS approved_by_name,u.name AS created_by_name
      FROM business_collection_refunds f JOIN business_collections k ON k.business_id=f.business_id AND k.id=f.collection_id
      JOIN users a ON a.id=f.approved_by JOIN users u ON u.id=f.created_by WHERE f.business_id=$1 AND f.contact_id=$2 ORDER BY f.id DESC LIMIT 20`, [business.id, contact.id]),
  ]);
  const usable = plans.items.filter((p) => p.state === 'active');
  return {
    profile, notes, visits, stats, refunds,
    contact,
    memberships: usable.filter((p) => p.kind === 'membership'),
    packages: usable.filter((p) => p.kind === 'package'),
    otherPlans: plans.items.filter((p) => p.state !== 'active'),
    // Usable now; deposits held for bookings still to come are listed apart.
    advance: rupees(deposits.filter((d) => !d.held).reduce((s, d) => s + paise(d.unused), 0)),
    held: rupees(deposits.filter((d) => d.held).reduce((s, d) => s + paise(d.unused), 0)),
    deposits, upcoming, bills,
  };
}
async function client(business, contactId) {
  requireSalon(business);
  await access.requireAny(business, ['sales.create', 'appointments.view']);
  return clientSummary(repo.pool, business, id(contactId, 'Client'));
}

function readBill(body) {
  const lines = v.requiredArray(body.lines, 'Lines');
  if (!lines.length || lines.length > 100) fail('Add between 1 and 100 lines');
  return lines;
}
// The bill as posting would make it (memberships, packages, GST, round-off),
// plus the client's unused advance. Nothing is saved.
async function quote(business, user, body) {
  requireSalon(business);
  await access.require(business, 'sales.create');
  const lines = readBill(body);
  const request = { ...body, kind: 'sale', payment: undefined };
  return repo.transaction(async (db) => {
    const bill = await core.postDocument(db, business, user, request, { kind: 'sale', requestKey: crypto.randomUUID(), hash: '', lines, paidNow: null, quote: true });
    let advance = '0.00';
    if (body.contactId) {
      const keep = Array.isArray(body.appointmentIds) ? body.appointmentIds.map((x) => id(x, 'Appointment')) : [];
      const row = await repo.one(db, `SELECT COALESCE(sum(${freeSql('k')}),0) AS free FROM business_collections k WHERE k.business_id=$1 AND k.contact_id=$2 AND ${notHeldSql('k', '$3')}`,
        [business.id, id(body.contactId, 'Client'), keep]);
      advance = rupees(paise(row.free));
    }
    const usable = Math.min(paise(advance), paise(bill.total));
    return { ...bill, advance, advanceUsable: rupees(usable), toPay: rupees(paise(bill.total) - (body.useAdvance ? usable : 0)) };
  });
}

// body: { locationId, contactId?, lines: [{ skuId, quantity, staffId?, clientPlanId?, appointmentId?, lotCode? }],
//   appointmentIds?: [], useAdvance?: bool, payment?: { amount, method, reference? }, notes?, requestKey }
// One transaction: the sale (core), the client's advance / deposits put
// against it (oldest first), and the appointments marked done and billed.
async function bill(business, user, body) {
  requireSalon(business);
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const lines = readBill(body);
  const useAdvance = v.requiredBoolean(body.useAdvance, 'Use advance', false);
  // Up to three payments on one bill (UPI and the rest in
  // cash) — mixed tender, not a split bill. `payment` (one) still works.
  const payments = readPayments(body);
  const tips = readTips(body);
  if (payments.length || useAdvance || tips.length) await access.require(business, 'sales.edit');
  const appointmentIds = [...new Set(v.requiredArray(body.appointmentIds ?? [], 'Appointments').map((x) => id(x, 'Appointment')))];
  if (appointmentIds.length > 10) fail('Bill at most 10 appointments at once');
  if ((useAdvance || appointmentIds.length) && !body.contactId) fail('Choose the client');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      // The advance put on it in that same posting (same transaction time).
      const first = await repo.one(db, `SELECT COALESCE(sum(amount),0) AS applied FROM business_payments WHERE business_id=$1 AND document_id=$2
        AND collection_id IS NOT NULL AND created_at=(SELECT created_at FROM business_documents WHERE business_id=$1 AND id=$2)`, [business.id, old.id]);
      return { document: old, advanceApplied: rupees(paise(first.applied)), repeated: true };
    }
    // Pay now what is left after the advance: the advance goes on first.
    const doc = await core.postDocument(db, business, user, { ...body, kind: 'sale' }, { kind: 'sale', requestKey, hash, lines, paidNow: null });
    let applied = 0;
    if (useAdvance) {
      const receipts = await repo.all(db, `SELECT k.*,${freeSql('k')} AS free FROM business_collections k WHERE k.business_id=$1 AND k.contact_id=$2
        AND ${notHeldSql('k', '$3')} ORDER BY k.id FOR UPDATE OF k`, [business.id, doc.contact_id, appointmentIds]);
      let due = paise(doc.total);
      let n = 0;
      for (const receipt of receipts) {
        const take = Math.min(due, paise(receipt.free));
        if (take <= 0) continue;
        await core.recordPayment(db, business, user, doc, { amount: rupees(take), method: receipt.method, reference: receipt.collection_no, key: derivedKey(requestKey, `advance-${n}`), collectionId: receipt.id });
        n += 1; due -= take; applied += take;
        if (due <= 0) break;
      }
      if (applied) {
        await repo.event(db, business.id, user.id, 'collection.applied', 'contact', doc.contact_id, { applied: rupees(applied), documentId: doc.id, documentNo: doc.document_no });
      }
    }
    const paying = payments.reduce((s, p) => s + paise(p.amount), 0);
    if (paying + applied > paise(doc.total)) fail(`Only ${rupees(paise(doc.total) - applied)} is left to pay on this bill`, 409);
    for (const [n, p] of payments.entries()) {
      // A payment naming one of the business's methods takes its kind and name.
      const { method, methodName } = await paymentMethods.settle(db, business.id, p, 'Payment method', METHODS);
      if (method === 'cheque' && !p.reference) fail('Enter the cheque number as the reference');
      await core.recordPayment(db, business, user, doc, { amount: p.amount, reference: p.reference, method, methodName, key: derivedKey(requestKey, n === 0 ? 'paid' : `paid-${n}`) });
    }
    for (const tip of tips) {
      const staff = await repo.one(db, `SELECT r.id,r.name FROM business_resources r LEFT JOIN salon_resource_profiles p ON p.business_id=r.business_id AND p.resource_id=r.id
        WHERE r.business_id=$1 AND r.id=$2 AND COALESCE(p.kind,'staff')='staff'`, [business.id, tip.staffId]);
      if (!staff) fail('Choose a stylist of this business for the tip', 404);
      const row = await repo.one(db, 'INSERT INTO salon_tips(business_id,document_id,resource_id,amount,method,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [business.id, doc.id, staff.id, tip.amount, tip.method, user.id]);
      await repo.audit(db, business.id, user.id, 'tip.recorded', row.id, { documentNo: doc.document_no, staff: staff.name, amount: tip.amount, method: tip.method });
      await repo.event(db, business.id, user.id, 'tip.recorded', 'document', doc.id, { resourceId: staff.id, amount: tip.amount, method: tip.method });
    }
    for (const appointmentId of appointmentIds) {
      const appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2 AND contact_id=$3 FOR UPDATE', [business.id, appointmentId, doc.contact_id]);
      if (!appointment) fail('That appointment is not this client\'s', 404);
      if (!['booked', 'completed'].includes(appointment.status)) fail('A cancelled or no-show appointment cannot be billed', 409);
      if (appointment.status === 'booked') await core.statusAllowed(db, business, appointment, 'completed');
      const details = await repo.one(db, 'SELECT * FROM salon_appointment_details WHERE business_id=$1 AND appointment_id=$2 FOR UPDATE', [business.id, appointment.id]);
      if (details?.bill_document_id) fail('That appointment has already been billed', 409);
      if (details) {
        await db.query('UPDATE salon_appointment_details SET bill_document_id=$3 WHERE business_id=$1 AND appointment_id=$2', [business.id, appointment.id, doc.id]);
      } else {
        const sku = await repo.one(db, 'SELECT price FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, appointment.sku_id]);
        const key = derivedKey(requestKey, `appointment-${appointment.id}`);
        await db.query(`INSERT INTO salon_appointment_details(business_id,appointment_id,price_at_booking,bill_document_id,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6)`,
          [business.id, appointment.id, sku.price, doc.id, key, hashOf({ key })]);
      }
      if (appointment.status === 'booked') {
        await db.query("UPDATE business_appointments SET status='completed' WHERE business_id=$1 AND id=$2", [business.id, appointment.id]);
        await repo.audit(db, business.id, user.id, 'appointment.completed', appointment.id, { billed: doc.document_no });
        await repo.event(db, business.id, user.id, 'appointment.completed', 'appointment', appointment.id, { status: 'completed', documentId: doc.id });
      }
    }
    return { document: doc, advanceApplied: rupees(applied) };
  });
}

function readPayments(body) {
  let list = [];
  if (body.payments !== undefined && body.payments !== null) list = v.requiredArray(body.payments, 'Payments');
  else if (body.payment !== undefined && body.payment !== null) {
    if (typeof body.payment !== 'object' || Array.isArray(body.payment)) fail('Payment must be an object');
    list = [body.payment];
  }
  if (list.length > 3) fail('Take at most three payments on one bill');
  return list.map((p, n) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail('Each payment must be an object');
    const label = list.length > 1 ? `Payment ${n + 1}` : 'Amount paid now';
    const amount = core.decimal(p.amount, label, 2, 0, 100000000);
    const { method, methodId } = paymentMethods.readChoice(p, 'Payment method', METHODS);
    const reference = v.optionalString(p.reference, 'Payment reference', 100);
    if (method === 'cheque' && !reference) fail('Enter the cheque number as the reference');
    return { amount, method, methodId, reference };
  }).filter((p) => p.amount > 0);
}
// A tip for the stylist, taken with the bill but not part of it (no GST).
function readTips(body) {
  if (body.tips === undefined || body.tips === null) return [];
  const list = v.requiredArray(body.tips, 'Tips');
  if (list.length > 5) fail('At most five tips on one bill');
  const tips = list.map((t) => ({
    staffId: id(t?.staffId, 'Stylist for the tip'),
    amount: core.decimal(t?.amount, 'Tip', 2, 0, 100000),
    method: v.requiredEnum(t?.method ?? 'cash', 'Tip paid by', METHODS),
  })).filter((t) => t.amount > 0);
  if (new Set(tips.map((t) => t.staffId)).size !== tips.length) fail('One tip per stylist on a bill');
  return tips;
}

// --- Plans -------------------------------------------------------------------------------------

function readPlan(body, kind) {
  const plan = {
    name: v.requiredString(body.name, 'Name', 150),
    description: v.optionalString(body.description, 'Description', 300),
    price: core.decimal(body.price, 'Price', 2, 0, 10000000),
    validity: core.decimal(body.validityDays, 'Valid for (days)', 0, 1, 3650),
    service: null, product: null, services: [],
  };
  if (kind === 'membership') {
    plan.service = core.decimal(body.serviceDiscountPercent ?? 0, 'Discount on services %', 2, 0, 100);
    plan.product = core.decimal(body.productDiscountPercent ?? 0, 'Discount on products %', 2, 0, 100);
    if (!plan.service && !plan.product) fail('A membership needs a discount on services or products');
  } else {
    const list = v.requiredArray(body.services, 'Services in the package');
    if (!list.length || list.length > 20) fail('A package holds between 1 and 20 services');
    plan.services = list.map((s) => ({ skuId: id(s?.skuId, 'Service'), sessions: core.decimal(s?.sessions, 'Sessions', 0, 1, 100) }));
    if (new Set(plan.services.map((s) => s.skuId)).size !== plan.services.length) fail('A service may only appear once in a package');
  }
  return plan;
}
async function createPlan(business, user, body) {
  requireSalon(business);
  requireModule(business, 'packages', 'Packages & memberships');
  await access.require(business, 'packages.create');
  const kind = v.requiredEnum(body.kind, 'Package or membership', ['package', 'membership']);
  const plan = readPlan(body, kind);
  return repo.transaction(async (db) => {
    const slab = body.taxRateId ? await repo.one(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.taxRateId, 'Tax rate')])
      : await repo.one(db, 'SELECT id,rate FROM business_tax_rates WHERE business_id=$1 AND active AND rate=18 ORDER BY id LIMIT 1', [business.id]);
    if (body.taxRateId && !slab) fail('Tax rate not found', 404);
    for (const s of plan.services) {
      const ok = await repo.one(db, `SELECT 1 FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND p.kind='service' AND s.active AND ${planSkuFilter}`, [business.id, s.skuId]);
      if (!ok) fail('Choose services of this business for the package', 404);
    }
    const product = await repo.one(db, 'INSERT INTO catalog_products(business_id,name,kind) VALUES($1,$2,\'service\') RETURNING *', [business.id, plan.name]);
    const prefix = kind === 'package' ? 'PKG' : 'MEM';
    const count = await repo.one(db, 'SELECT count(*)::int AS n FROM salon_plans WHERE business_id=$1 AND kind=$2', [business.id, kind]);
    let code = `${prefix}-${String(count.n + 1).padStart(3, '0')}`;
    for (let n = count.n + 2; await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [business.id, code]); n += 1) code = `${prefix}-${String(n).padStart(3, '0')}`;
    const sku = await repo.one(db, `INSERT INTO catalog_skus(business_id,product_id,code,label,unit,price,tax_rate,tax_rate_id,tracking)
      VALUES($1,$2,$3,$4,'service',$5,$6,$7,'none') RETURNING *`, [business.id, product.id, code, plan.name, plan.price, slab?.rate ?? 0, slab?.id || null]);
    const row = await repo.one(db, `INSERT INTO salon_plans(business_id,kind,sku_id,name,validity_days,service_discount_percent,product_discount_percent,description,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`, [business.id, kind, sku.id, plan.name, plan.validity, plan.service, plan.product, plan.description, user.id]);
    for (const s of plan.services) await db.query('INSERT INTO salon_plan_services(business_id,plan_id,sku_id,sessions) VALUES($1,$2,$3,$4)', [business.id, row.id, s.skuId, s.sessions]);
    await repo.audit(db, business.id, user.id, `${kind}_plan.created`, row.id, { name: plan.name, price: plan.price, skuCode: code });
    return { ...row, sku_code: code, price: sku.price };
  });
}
// Changes apply to future sales only: what clients bought is a snapshot.
async function updatePlan(business, user, planId, body) {
  requireSalon(business);
  requireModule(business, 'packages', 'Packages & memberships');
  await access.require(business, 'packages.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM salon_plans WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(planId, 'Plan')]);
    if (!current) fail('Plan not found', 404);
    const onlyActive = Object.keys(body).length === 1 && body.active !== undefined;
    const active = v.requiredBoolean(body.active, 'Sold', current.active);
    if (onlyActive) {
      const row = await repo.one(db, 'UPDATE salon_plans SET active=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, current.id, active, user.id]);
      await db.query('UPDATE catalog_skus SET active=$3 WHERE business_id=$1 AND id=$2', [business.id, current.sku_id, active]);
      await repo.audit(db, business.id, user.id, `${current.kind}_plan.updated`, current.id, { active });
      return row;
    }
    const plan = readPlan(body, current.kind);
    const row = await repo.one(db, `UPDATE salon_plans SET name=$3,description=$4,validity_days=$5,service_discount_percent=$6,product_discount_percent=$7,active=$8,updated_by=$9,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, current.id, plan.name, plan.description, plan.validity, plan.service, plan.product, active, user.id]);
    await db.query('UPDATE catalog_skus SET label=$3,price=$4,active=$5 WHERE business_id=$1 AND id=$2', [business.id, current.sku_id, plan.name, plan.price, active]);
    if (current.kind === 'package') {
      await db.query('DELETE FROM salon_plan_services WHERE business_id=$1 AND plan_id=$2', [business.id, current.id]);
      for (const s of plan.services) await db.query('INSERT INTO salon_plan_services(business_id,plan_id,sku_id,sessions) VALUES($1,$2,$3,$4)', [business.id, current.id, s.skuId, s.sessions]);
    }
    await repo.audit(db, business.id, user.id, `${current.kind}_plan.updated`, current.id, { name: plan.name, price: plan.price, active });
    return row;
  });
}
// A client's package or membership can be cancelled only while unused; the
// bill line that sold it can then be returned (credit note, refund).
async function cancelClientPlan(business, user, clientPlanId, body) {
  requireSalon(business);
  requireModule(business, 'packages', 'Packages & memberships');
  await access.require(business, 'packages.edit');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const held = await repo.one(db, 'SELECT * FROM salon_client_plans WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(clientPlanId, 'Package or membership')]);
    if (!held) fail('Package or membership not found', 404);
    if (held.status === 'cancelled') fail('It is already cancelled', 409);
    const used = await repo.one(db, `SELECT
      (SELECT count(*)::int FROM salon_package_redemptions WHERE business_id=$1 AND client_plan_id=$2) AS sessions,
      (SELECT count(*)::int FROM salon_membership_uses WHERE business_id=$1 AND client_plan_id=$2) AS discounts`, [business.id, held.id]);
    if (used.sessions || used.discounts) fail(`${held.name} has already been used on ${used.sessions + used.discounts} bill line${used.sessions + used.discounts === 1 ? '' : 's'}, so it cannot be cancelled`, 409);
    const row = await repo.one(db, `UPDATE salon_client_plans SET status='cancelled',cancelled_by=$3,cancelled_at=now(),cancel_reason=$4 WHERE business_id=$1 AND id=$2 RETURNING *`,
      [business.id, held.id, user.id, reason]);
    await repo.audit(db, business.id, user.id, `${held.kind}.cancelled`, held.id, { reason });
    await repo.event(db, business.id, user.id, `${held.kind}.cancelled`, 'client_plan', held.id, { contactId: held.contact_id, documentId: held.document_id, reason });
    return row;
  });
}

// --- Commissions -------------------------------------------------------------------------------

// appliesTo: service | goods | plan (selling a package or membership).
// A rule pays a percent of the line's value, or a flat amount per item.
function readRule(body) {
  const flat = body.flatAmount === undefined || body.flatAmount === null || body.flatAmount === '' ? null : core.decimal(body.flatAmount, 'Flat amount per item', 2, 0, 100000);
  return {
    resourceId: optionalId(body.resourceId, 'Stylist'),
    appliesTo: v.requiredEnum(body.appliesTo, 'Applies to', ['service', 'goods', 'plan']),
    skuId: optionalId(body.skuId, 'Item'),
    percent: flat === null ? core.decimal(body.percent, 'Commission %', 2, 0, 100) : 0,
    flat,
  };
}
async function createRule(business, user, body) {
  requireSalon(business);
  await access.require(business, 'commissions.edit');
  const rule = readRule(body);
  return repo.transaction(async (db) => {
    if (rule.resourceId && !await repo.one(db, `SELECT 1 FROM business_resources r LEFT JOIN salon_resource_profiles p ON p.business_id=r.business_id AND p.resource_id=r.id
      WHERE r.business_id=$1 AND r.id=$2 AND COALESCE(p.kind,'staff')='staff'`, [business.id, rule.resourceId])) fail('Stylist not found', 404);
    const clashRow = await repo.one(db, `SELECT id FROM salon_commission_rules WHERE business_id=$1 AND active AND COALESCE(resource_id,0)=COALESCE($2::bigint,0)
      AND applies_to=$3 AND COALESCE(sku_id,0)=COALESCE($4::bigint,0)`, [business.id, rule.resourceId, rule.appliesTo, rule.skuId]);
    if (clashRow) fail('There is already an active rule for exactly this; change that one instead', 409);
    const row = await repo.one(db, `INSERT INTO salon_commission_rules(business_id,resource_id,applies_to,sku_id,percent,flat_amount,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
      [business.id, rule.resourceId, rule.appliesTo, rule.skuId, rule.percent, rule.flat, user.id]);
    await repo.audit(db, business.id, user.id, 'commission_rule.created', row.id, rule);
    return row;
  });
}
async function updateRule(business, user, ruleId, body) {
  requireSalon(business);
  await access.require(business, 'commissions.edit');
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM salon_commission_rules WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(ruleId, 'Rule')]);
    if (!current) fail('Rule not found', 404);
    let flat = current.flat_amount === null ? null : Number(current.flat_amount);
    if (body.flatAmount !== undefined) flat = body.flatAmount === null || body.flatAmount === '' ? null : core.decimal(body.flatAmount, 'Flat amount per item', 2, 0, 100000);
    let percent = body.percent === undefined ? Number(current.percent) : core.decimal(body.percent, 'Commission %', 2, 0, 100);
    if (flat !== null) percent = 0;
    const active = v.requiredBoolean(body.active, 'Active', current.active);
    const row = await repo.one(db, 'UPDATE salon_commission_rules SET percent=$3,active=$4,flat_amount=$6,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, current.id, percent, active, user.id, flat]);
    await repo.audit(db, business.id, user.id, 'commission_rule.updated', row.id, { percent, flat, active });
    return row;
  });
}
// Commission per stylist for a period (bill dates), after returns.
async function commissionReport(business, query) {
  requireSalon(business);
  await access.require(business, 'commissions.view');
  const from = core.dateText(query.from, 'From date'), to = core.dateText(query.to, 'To date');
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  const rows = await repo.all(repo.pool, `WITH lines AS (
      SELECT ls.resource_id,ls.item_kind,ls.commission_amount,ls.commission_base,l.quantity,l.net,
        COALESCE((SELECT sum(rl.quantity) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0) AS returned_q,
        COALESCE((SELECT sum(rl.net) FROM business_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id),0) AS returned_net,
        d.id AS document_id
      FROM salon_line_staff ls JOIN business_document_lines l ON l.business_id=ls.business_id AND l.id=ls.line_id
      JOIN business_documents d ON d.business_id=ls.business_id AND d.id=ls.document_id JOIN businesses b ON b.id=d.business_id
      WHERE ls.business_id=$1 AND (d.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date)
    SELECT r.id AS resource_id,r.name,r.role_label,
      count(*) FILTER (WHERE x.item_kind='service')::int AS service_lines,
      COALESCE(sum(x.quantity-x.returned_q) FILTER (WHERE x.item_kind IN ('service','session')),0) AS services_done,
      COALESCE(sum(x.quantity-x.returned_q) FILTER (WHERE x.item_kind='session'),0) AS sessions_done,
      COALESCE(sum(x.net-x.returned_net) FILTER (WHERE x.item_kind='service'),0) AS service_sales,
      COALESCE(sum(round(x.commission_base*(x.quantity-x.returned_q)/x.quantity,2)) FILTER (WHERE x.item_kind='session'),0) AS session_value,
      COALESCE(sum(x.net-x.returned_net) FILTER (WHERE x.item_kind='plan'),0) AS plan_sales,
      COALESCE(sum(x.net-x.returned_net) FILTER (WHERE x.item_kind='goods'),0) AS product_sales,
      count(DISTINCT x.document_id)::int AS bills,
      COALESCE(sum(round(x.commission_amount*(x.quantity-x.returned_q)/x.quantity,2)),0) AS commission
    FROM lines x JOIN business_resources r ON r.business_id=$1 AND r.id=x.resource_id
    GROUP BY r.id,r.name,r.role_label ORDER BY commission DESC,r.name`, [business.id, from, to]);
  // Tips and what has been paid out, so Earned · Paid · Due line up.
  const [tips, paid] = await Promise.all([
    repo.all(repo.pool, `SELECT t.resource_id,r.name,r.role_label,sum(t.amount) AS tips FROM salon_tips t JOIN businesses b ON b.id=t.business_id
      JOIN business_resources r ON r.business_id=t.business_id AND r.id=t.resource_id
      WHERE t.business_id=$1 AND (t.created_at AT TIME ZONE b.timezone)::date BETWEEN $2::date AND $3::date GROUP BY t.resource_id,r.name,r.role_label`, [business.id, from, to]),
    repo.all(repo.pool, `SELECT p.resource_id,r.name,r.role_label,sum(p.amount) AS paid,max(p.period_to) AS paid_to FROM salon_commission_payouts p
      JOIN business_resources r ON r.business_id=p.business_id AND r.id=p.resource_id
      WHERE p.business_id=$1 AND p.period_from >= $2::date AND p.period_to <= $3::date GROUP BY p.resource_id,r.name,r.role_label`, [business.id, from, to]),
  ]);
  const byId = new Map(rows.map((r) => [Number(r.resource_id), r]));
  const blank = (x) => ({ resource_id: x.resource_id, name: x.name, role_label: x.role_label, service_lines: 0, services_done: '0', sessions_done: '0', service_sales: '0',
    session_value: '0', plan_sales: '0', product_sales: '0', bills: 0, commission: '0' });
  for (const t of tips) {
    if (!byId.has(Number(t.resource_id))) { const row = blank(t); rows.push(row); byId.set(Number(t.resource_id), row); }
    byId.get(Number(t.resource_id)).tips = t.tips;
  }
  for (const p of paid) {
    if (!byId.has(Number(p.resource_id))) { const row = blank(p); rows.push(row); byId.set(Number(p.resource_id), row); }
    Object.assign(byId.get(Number(p.resource_id)), { paid: p.paid, paid_to: p.paid_to });
  }
  // Stylists on a monthly target (slab) plan earn the slab on their
  // services instead of the flat rules' per-line amounts.
  const slabs = await require('./businessSalonBackOffice.service').slabAdjustments(repo.pool, business, from, to);
  for (const [resourceId, entry] of slabs) {
    let row = byId.get(resourceId);
    if (!row) {
      const who = await repo.one(repo.pool, 'SELECT id AS resource_id,name,role_label FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, resourceId]);
      row = blank(who); rows.push(row); byId.set(resourceId, row);
    }
    row.commission = rupees(paise(row.commission) - entry.replaced + entry.slab);
    row.slab_commission = rupees(entry.slab);
    row.slab_months = entry.months;
    row.scheme = entry.months.map((m) => m.plan).filter((x, i, all) => all.indexOf(x) === i).join(', ');
  }
  for (const r of rows) {
    r.tips = r.tips || '0.00';
    r.paid = r.paid || '0.00';
    r.scheme = r.scheme || null;
    r.due = rupees(paise(r.commission) + paise(r.tips) - paise(r.paid));
  }
  return { from, to, rows };
}

// Pay a stylist what they earned (commission and tips) for a period; the
// payout is kept as it was and prints as a commission slip.
async function payCommission(business, user, body) {
  requireSalon(business);
  await access.require(business, 'commissions.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf(body);
  const from = core.dateText(body.from, 'From date'), to = core.dateText(body.to, 'To date');
  if (to < from) fail('The end date is before the start date');
  const resourceId = id(body.resourceId, 'Stylist');
  const amount = paise(core.decimal(body.amount, 'Amount paid', 2, 0.01, 10000000));
  const method = v.requiredEnum(body.method, 'Paid by', ['cash', 'upi', 'bank', 'cheque']);
  const reference = v.optionalString(body.reference, 'Reference', 100);
  if (method === 'cheque' && !reference) fail('Enter the cheque number as the reference');
  const note = v.optionalString(body.note, 'Note', 300);
  const report = await commissionReport(business, { from, to });
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT * FROM salon_commission_payouts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old;
    }
    const staff = await repo.one(db, 'SELECT id,name FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, resourceId]);
    if (!staff) fail('Stylist not found', 404);
    const row = report.rows.find((r) => Number(r.resource_id) === resourceId);
    // What is still due, counting payouts saved since the report was read.
    const since = await repo.one(db, `SELECT COALESCE(sum(amount),0) AS paid FROM salon_commission_payouts WHERE business_id=$1 AND resource_id=$2
      AND period_from >= $3::date AND period_to <= $4::date`, [business.id, resourceId, from, to]);
    const earned = row ? paise(row.commission) + paise(row.tips) : 0;
    const due = earned - paise(since.paid);
    if (amount > due) fail(`${staff.name} has ${rupees(Math.max(0, due))} due for these dates`, 409);
    const payout = await repo.one(db, `INSERT INTO salon_commission_payouts(business_id,resource_id,period_from,period_to,commission,tips,amount,method,reference,note,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [business.id, staff.id, from, to, row ? row.commission : '0.00', row ? row.tips : '0.00', rupees(amount), method, reference, note, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'commission.paid', payout.id, { staff: staff.name, from, to, amount: payout.amount, method });
    await repo.event(db, business.id, user.id, 'commission.paid', 'commission_payout', payout.id, { resourceId: staff.id, from, to, amount: payout.amount, method });
    return { ...payout, resource_name: staff.name };
  });
}

module.exports = {
  getSettings, saveSettings, saveService, saveStaff, calendar, book, preview, setStatus, client, quote, bill,
  createPlan, updatePlan, cancelClientPlan, createRule, updateRule, commissionReport, payCommission, requireSalon,
  // Used by businessSalonDesk.service.js.
  bookIn, readBooking, readOverride, staffAvailable, availabilityProblem, recordOverride, freeSql, notHeldSql, lockResource, settingsRow, derivedKey, timeText,
};
