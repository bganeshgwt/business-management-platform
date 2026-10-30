const bcrypt = require('bcrypt');
const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const { readGstin, STATES } = require('../../../../utils/gstin');
const { readMobile } = require('../../../../utils/phone');
const { logFor } = require('../../../../utils/audit');

// The paid plans' services and the restaurant's own set-up, loaded when first
// needed.
const subscriptions = () => require('../../../platform/services/subscriptions.service');
const planSettings = () => require('../../../platform/services/planSettings.service');
const platformService = () => require('../../../platform/services/platform.service');
const restaurantFormats = () => require('../../../restaurant/setup/services/restaurantFormat.service');

// Creating businesses: any business type, its legal details, its first
// location and its owner's login.
//   * the platform's super admin creates one for a customer (Platform ›
//     Businesses), the owner being a new login or an existing one, with its
//     plan and how long it may be used; a restaurant made there runs the
//     restaurant's own set-up, with an owner login of its own;
//   * an owner adds another business of their own ("Add a business" on the
//     business list) and becomes its owner;
//   * an owner (or anyone with access.edit) gives their staff a login of
//     their own from Staff & access, with no restaurant behind it.
// The provisioning trigger gives every new business its roles, settings, GST
// slabs, units and its type's default modules (migration 1791300000005), and
// businesses_start_plan its default plan and its free trial (migration
// paid-plans).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const BCRYPT_ROUNDS = 12;
const isPlatformUser = (user) => !user.restaurantId && user.permissions.includes('platform.restaurants.manage');

// ISO 4217 currency and an IANA time zone this server knows.
function readCurrency(value, fallback = 'INR') {
  if (value === undefined || value === null || value === '') return fallback;
  const code = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) fail('Currency must be a three-letter code such as INR');
  try { new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(1); } catch { fail(`${code} is not a currency this system knows`); }
  return code;
}
function readTimezone(value, fallback = 'Asia/Kolkata') {
  if (value === undefined || value === null || value === '') return fallback;
  const zone = String(value).trim();
  if (zone.length > 60) fail('Time zone is too long');
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(new Date()); } catch { fail(`${zone} is not a time zone this system knows (for example Asia/Kolkata)`); }
  return zone;
}
function readCode(value, field = 'Business code') {
  const code = v.requiredString(value, field, 40).toUpperCase().replace(/\s+/g, '-');
  if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(code)) fail(`${field} may use letters, digits and dashes (2 to 40)`);
  return code;
}

// Who will own it: an existing login (by email) or a new one.
async function readOwner(db, body) {
  const owner = body.owner && typeof body.owner === 'object' ? body.owner : {};
  const email = v.requiredEmail(owner.email, "Owner's email");
  const existing = await repo.one(db, 'SELECT id,name,status FROM users WHERE lower(email)=$1', [email]);
  if (existing) {
    if (existing.status !== 'active') fail('That login is not active', 409);
    return { id: Number(existing.id), name: existing.name, created: false };
  }
  const name = v.requiredString(owner.name, "Owner's name", 150);
  const password = v.requiredPassword(owner.password, "Owner's password");
  const mobile = readMobile(owner.mobile, "Owner's mobile");
  if (mobile && await repo.one(db, 'SELECT 1 FROM users WHERE mobile=$1', [mobile])) fail('That mobile number already has a login', 409);
  const row = await repo.one(db, `INSERT INTO users(name,email,mobile,password_hash) VALUES($1,$2,$3,$4) RETURNING id,name`,
    [name, email, mobile, await bcrypt.hash(password, BCRYPT_ROUNDS)]);
  return { id: Number(row.id), name: row.name, created: true };
}

// The business, its settings, its first location and its owner, in one go.
async function createBusiness(db, actor, body, ownerId) {
  const type = v.requiredString(body.businessType, 'Business type', 40);
  const known = await repo.one(db, 'SELECT code,name FROM business_types WHERE code=$1', [type]);
  if (!known) fail('Unknown business type');
  if (type === 'restaurant') fail('A restaurant is set up from Platform › Restaurants (it has its own menu, tables and kitchen set-up).');
  const name = v.requiredString(body.name, 'Business name', 150);
  const code = readCode(body.code);
  if (await repo.one(db, 'SELECT 1 FROM businesses WHERE upper(code)=$1', [code])) fail(`The business code ${code} is already taken`, 409);
  const gstin = readGstin(body.gstin);
  const stateText = v.optionalString(body.stateCode, 'State code', 2);
  if (stateText && !/^\d{2}$/.test(stateText)) fail('State code must be the two-digit GST state code');
  const stateCode = stateText || (gstin ? gstin.slice(0, 2) : null);
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) fail('The state code must match the first two digits of the GSTIN');
  const postal = v.optionalString(body.postalCode, 'PIN code', 10);
  if (postal && !/^\d{6}$/.test(postal)) fail('PIN code must be six digits');
  const business = await repo.one(db, `INSERT INTO businesses(name,code,business_type,currency,timezone,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, code, type, readCurrency(body.currency), readTimezone(body.timezone), actor.id]);
  await db.query(`UPDATE business_settings SET legal_name=$2,gstin=$3,address_line1=$4,address_line2=$5,city=$6,state_code=$7,postal_code=$8,phone=$9,email=$10,
      updated_by=$11,updated_at=now() WHERE business_id=$1`,
  [business.id, v.optionalString(body.legalName, 'Legal name', 200), gstin, v.optionalString(body.addressLine1, 'Address line 1', 200),
    v.optionalString(body.addressLine2, 'Address line 2', 200), v.optionalString(body.city, 'City', 100), stateCode, postal,
    v.optionalString(body.phone, 'Phone', 30), body.email ? v.requiredEmail(body.email, 'Business email') : null, actor.id]);
  const locationName = v.optionalString(body.locationName, 'First location', 150) || 'Main store';
  const locationCode = body.locationCode ? readCode(body.locationCode, 'Location code').slice(0, 30) : 'MAIN';
  await db.query('INSERT INTO business_locations(business_id,name,code) VALUES($1,$2,$3)', [business.id, locationName, locationCode]);
  await db.query(`INSERT INTO business_memberships(business_id,user_id,role_id,created_by,updated_by)
    SELECT $1,$2,id,$3,$3 FROM business_roles WHERE business_id=$1 AND full_access`, [business.id, ownerId, actor.id]);
  await repo.audit(db, business.id, actor.id, 'business.created', business.id, { name, code, type, ownerId });
  return business;
}

// --- Platform › Businesses ---------------------------------------------------

function requirePlatform(user) {
  if (!isPlatformUser(user)) fail('The platform console is for the platform\'s own accounts', 403);
}

const PLAN_STATES = ['unmanaged', 'off', 'trial', 'paid', 'given', 'grace', 'checking', 'ended'];

// Every business, restaurants included, newest first: the state of its plan
// and the day its time ends, its plan and add-ons for the next order, its
// owners (a restaurant's admins), and the last time one of its people signed
// in or opened it. Filters: a search, the type, on or off, the plan's state,
// the plan, and time that ends within so many days of the business's today.
async function platformList(user, query = {}) {
  requirePlatform(user);
  const q = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const type = typeof query.type === 'string' && query.type ? query.type.slice(0, 40) : null;
  const status = ['active', 'inactive'].includes(query.status) ? query.status : null;
  const state = query.state ? v.requiredEnum(String(query.state), 'State', PLAN_STATES) : null;
  const plan = typeof query.plan === 'string' && query.plan ? query.plan.slice(0, 40) : null;
  const within = query.endsWithin === undefined || query.endsWithin === '' ? null : v.requiredNumber(query.endsWithin, 'Ends within', { min: 0, max: 3650 });
  if (within !== null && !Number.isInteger(within)) fail('Ends within is a number of whole days');
  const items = await repo.all(repo.pool, `SELECT b.id,b.name,b.code,b.business_type,t.name AS type_name,b.status,b.currency,b.timezone,b.created_at,
      b.legacy_restaurant_id AS restaurant_id,r.format,s.gstin,s.city,s.state_code,
      ps.state,ps.access_ends_on,ps.trial_ends_on,ps.grace_ends_on,ps.period_kind,ps.everything,
      sub.plan_code,pl.name AS plan_name,sub.billing_period,(SELECT count(*)::int FROM business_subscription_addons a WHERE a.business_id=b.id) AS addons,
      CASE WHEN r.id IS NULL THEN (SELECT count(*)::int FROM business_locations l WHERE l.business_id=b.id AND l.active)
        ELSE (SELECT count(*)::int FROM outlets o WHERE o.restaurant_id=r.id AND o.status='active') END AS locations,
      CASE WHEN r.id IS NULL THEN (SELECT count(*)::int FROM business_memberships m WHERE m.business_id=b.id AND m.active)
        ELSE (SELECT count(*)::int FROM users u WHERE u.restaurant_id=r.id AND u.status='active') END AS people,
      CASE WHEN r.id IS NULL THEN (SELECT json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email) ORDER BY u.name) FROM business_memberships m
          JOIN business_roles br ON br.business_id=m.business_id AND br.id=m.role_id AND br.full_access JOIN users u ON u.id=m.user_id
          WHERE m.business_id=b.id AND m.active)
        ELSE (SELECT json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email) ORDER BY u.name) FROM users u
          WHERE u.restaurant_id=r.id AND u.status='active' AND (SELECT count(DISTINCT p.code) FROM user_roles ur JOIN roles ro ON ro.id=ur.role_id AND ro.status='active'
            JOIN role_permissions rp ON rp.role_id=ro.id JOIN permissions p ON p.id=rp.permission_id
            WHERE ur.user_id=u.id AND p.code IN ('users.manage','roles.manage'))=2) END AS owners,
      GREATEST((SELECT max(m.last_opened_at) FROM business_memberships m WHERE m.business_id=b.id AND m.active),
        (SELECT max(u.last_login_at) FROM business_memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=b.id AND m.active),
        (SELECT max(u.last_login_at) FROM users u WHERE u.restaurant_id=r.id)) AS last_active_at
    FROM businesses b JOIN business_types t ON t.code=b.business_type LEFT JOIN restaurants r ON r.id=b.legacy_restaurant_id
    LEFT JOIN business_settings s ON s.business_id=b.id LEFT JOIN business_subscriptions sub ON sub.business_id=b.id
    LEFT JOIN platform_plans pl ON pl.code=sub.plan_code CROSS JOIN LATERAL business_plan_state(b.id) ps
    WHERE ($1::text IS NULL OR concat_ws(' ',b.name,b.code,s.city,s.gstin) ILIKE $1)
      AND ($2::text IS NULL OR b.business_type=$2) AND ($3::text IS NULL OR b.status=$3)
      AND ($4::text IS NULL OR ps.state=$4) AND ($5::text IS NULL OR sub.plan_code=$5)
      AND ($6::int IS NULL OR ps.access_ends_on BETWEEN business_local_today(b.id) AND business_local_today(b.id)+$6::int)
    ORDER BY b.created_at DESC LIMIT 500`, [q, type, status, state, plan, within]);
  const types = await repo.all(repo.pool, 'SELECT code,name FROM business_types ORDER BY name');
  const plans = await repo.all(repo.pool, 'SELECT code,name,business_type AS "businessType",active FROM platform_plans ORDER BY business_type,sort_order,name');
  return { items: items.map((row) => ({ ...row, state_name: STATES[row.state_code] || null })), types, plans };
}

// --- What the platform gives a business it makes ----------------------------

const ACCESS_KINDS = ['until', 'no_end', 'trial'];
const localToday = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());

function readDay(value, name) {
  const text = v.requiredString(value, name, 10);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) fail(`${name} must be a date (YYYY-MM-DD)`);
  return text;
}

// The selection for its next order and how long it may be used, read before
// anything is made, so a mistake in them leaves nothing behind. The selection
// gets the checks the subscriptions service makes when it is saved: a plan of
// the type still on offer, add-ons the type can use, each with every module it
// needs. Access is time given until a date or with no end, each with a reason
// (it replaces the free trial every new business starts with), or the trial
// kept; without either, the business keeps its trial and its type's default
// plan.
async function readPlanChoice(type, body, zone) {
  let selection = null;
  if (body.selection !== undefined && body.selection !== null) {
    const chosen = body.selection;
    if (typeof chosen !== 'object' || Array.isArray(chosen)) fail('The selection is a plan, monthly or yearly, and its add-ons');
    selection = {
      planCode: v.requiredString(chosen.planCode, 'Plan', 40), billingPeriod: v.requiredEnum(chosen.billingPeriod, 'Billing period', ['month', 'year']),
      addons: [...new Set(v.requiredArray(chosen.addons ?? [], 'Add-ons').map((code) => String(code)))],
    };
  }
  let access = null;
  if (body.access !== undefined && body.access !== null) {
    const given = body.access;
    if (typeof given !== 'object' || Array.isArray(given)) fail('Access is how long the business may be used');
    access = { kind: v.requiredEnum(given.kind, 'Access', ACCESS_KINDS) };
    if (access.kind !== 'trial') {
      access.reason = v.requiredString(given.reason, 'Reason', 300);
      access.everything = v.requiredBoolean(given.everything, 'Everything', false);
      if (access.kind === 'until') {
        access.endsOn = readDay(given.endsOn, 'Given until');
        if (access.endsOn < localToday(zone)) fail('The given time must end today or later, and not before it starts');
      }
    }
  }
  if (selection) {
    const plan = await repo.one(repo.pool, 'SELECT code,name,active FROM platform_plans WHERE code=$1 AND business_type=$2', [selection.planCode, type]);
    if (!plan) fail('That plan is not offered for this type of business');
    if (!plan.active) fail(`${plan.name} is no longer offered. Choose another plan.`);
    const included = (await repo.all(repo.pool, 'SELECT module_code FROM platform_plan_modules WHERE plan_code=$1', [plan.code])).map((r) => r.module_code);
    const addons = selection.addons.filter((code) => !included.includes(code));
    const offered = (await repo.all(repo.pool, `SELECT m.code FROM platform_module_business_types t JOIN platform_modules m ON m.code=t.module_code AND m.kind='optional'
      JOIN platform_module_prices pr ON pr.module_code=m.code WHERE t.business_type=$1 AND m.code<>'restaurant'`, [type])).map((r) => r.code);
    const unknown = addons.find((code) => !offered.includes(code));
    if (unknown) fail(`${unknown} cannot be added to this type of business`);
    const have = new Set([...included, ...addons]);
    const needs = await repo.all(repo.pool, `SELECT d.requires_module_code,m.name,n.name AS needed FROM platform_module_dependencies d
      JOIN platform_modules m ON m.code=d.module_code JOIN platform_modules n ON n.code=d.requires_module_code
      WHERE d.module_code=ANY($1::text[]) AND d.requires_module_code<>'restaurant' ORDER BY d.module_code,d.requires_module_code`, [addons]);
    const missing = needs.find((need) => !have.has(need.requires_module_code));
    if (missing) fail(`${missing.name} needs ${missing.needed}. Add ${missing.needed} too.`);
  } else if (access && access.kind !== 'trial' && !access.everything
    && !await repo.one(repo.pool, 'SELECT 1 FROM platform_plans WHERE business_type=$1 AND is_default', [type])) {
    fail('Choose the plan the given time unlocks, or let it unlock everything');
  }
  if (access && access.kind === 'trial' && !(await planSettings().get()).trial_days) {
    fail('The free trial is set to 0 days in Platform › Settings, so give time until a date instead', 409);
  }
  return { selection, access };
}

// The selection and the time, through the subscriptions service (audited
// there): given time replaces the trial from the day the trial began.
async function applyPlanChoice(user, businessId, { selection, access }) {
  const plans = subscriptions();
  if (selection) await plans.setSelection({ id: businessId }, user, selection, { by: 'platform' });
  if (!access || access.kind === 'trial') return;
  const { plan_code: planCode } = await repo.one(repo.pool, 'SELECT plan_code FROM business_subscriptions WHERE business_id=$1', [businessId]);
  await plans.giveTime(user, businessId, {
    ...(access.kind === 'no_end' ? { noEnd: true } : { endsOn: access.endsOn }), everything: access.everything, reason: access.reason, replaceTrial: true,
    planCode, modules: selection ? selection.addons : [],
  });
}

const RESTAURANT_CODE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;
const OWN_LOGIN = 'A restaurant needs a login of its own. Use another email and mobile number.';

// A restaurant made from Platform › Businesses: the restaurant's own set-up
// (its GST rates, settings, channels, kitchen station and first admin, and
// the business it appears as), then its state for GST and its address on that
// business. Its format's set-up waits for its time (platformCreate). Its owner
// is always a new login: a restaurant's people belong to it alone, and its
// screens rely on that.
async function createRestaurantBusiness(user, body, zone) {
  const owner = body.owner && typeof body.owner === 'object' ? body.owner : {};
  const email = v.requiredEmail(owner.email, "Owner's email");
  const ownerName = v.requiredString(owner.name, "Owner's name", 150);
  const password = v.requiredPassword(owner.password, "Owner's password");
  const mobile = readMobile(owner.mobile, "Owner's mobile");
  const format = v.optionalEnum(body.format, 'Format', restaurantFormats().FORMAT_CODES, 'restaurant');
  const name = v.requiredString(body.name, 'Business name', 150);
  const code = v.requiredString(body.code, 'Business code', 30).toUpperCase();
  if (!RESTAURANT_CODE.test(code)) fail("A restaurant's code is 2 to 30 letters or digits (and - or _), like SPR001");
  const stateCode = v.optionalString(body.stateCode, 'State code', 2);
  if (stateCode && !STATES[stateCode]) fail('State code must be the two-digit GST state code, like 29 for Karnataka');
  const postal = v.optionalString(body.postalCode, 'PIN code', 10);
  if (postal && !/^\d{6}$/.test(postal)) fail('PIN code must be six digits');
  const line1 = v.optionalString(body.addressLine1, 'Address line 1', 200);
  const line2 = v.optionalString(body.addressLine2, 'Address line 2', 200);
  const city = v.optionalString(body.city, 'City', 100);
  const phone = v.optionalString(body.phone, 'Phone', 20);
  const businessEmail = body.email ? v.requiredEmail(body.email, 'Business email') : null;
  if (await repo.one(repo.pool, 'SELECT 1 FROM users WHERE lower(email)=$1 OR ($2::text IS NOT NULL AND mobile=$2)', [email, mobile])) fail(OWN_LOGIN, 409);
  const made = await platformService().create(user, {
    name, code, contact: phone, email: businessEmail, address: [line1, line2, city, postal].filter(Boolean).join(', ') || null, timezone: zone, format: 'restaurant',
    admin: { name: ownerName, email, mobile, password },
  });
  const business = await repo.transaction(async (db) => {
    const row = await repo.one(db, 'SELECT * FROM businesses WHERE legacy_restaurant_id=$1 FOR UPDATE', [made.id]);
    await db.query(`UPDATE business_settings SET state_code=COALESCE($2,state_code),address_line1=COALESCE($3,address_line1),address_line2=COALESCE($4,address_line2),
        city=COALESCE($5,city),postal_code=COALESCE($6,postal_code),phone=COALESCE($7,phone),email=COALESCE($8,email),updated_by=$9,updated_at=now() WHERE business_id=$1`,
    [row.id, stateCode, line1, line2, city, postal, phone, businessEmail, user.id]);
    await repo.audit(db, row.id, user.id, 'business.created', row.id, { name, code, type: 'restaurant', format, restaurantId: made.id, ownerId: made.adminId });
    return row;
  });
  // The restaurant's own activity log says the platform made it, as Platform › Restaurants does.
  logFor({ restaurantId: made.id, userId: user.id, userName: `${user.name} (platform)` }, 'create', 'restaurant',
    { id: made.id, label: name, details: { code, format, firstAdmin: email, defaults: made.defaults } }).catch(() => {});
  return { business, owner: { id: made.adminId, name: ownerName, created: true }, restaurant: { id: made.id, code: made.code, format } };
}

// A new business made in Platform › Businesses: any type, with its owner, its
// selection and its time (readPlanChoice). Returns the business, its owner,
// a restaurant's own record, and the plan's state.
async function platformCreate(user, body) {
  requirePlatform(user);
  const type = v.requiredString(body.businessType, 'Business type', 40);
  if (!await repo.one(repo.pool, 'SELECT 1 FROM business_types WHERE code=$1', [type])) fail('Unknown business type');
  const zone = readTimezone(body.timezone);
  const choice = await readPlanChoice(type, body, zone);
  const made = type === 'restaurant' ? await createRestaurantBusiness(user, body, zone) : await repo.transaction(async (db) => {
    const owner = await readOwner(db, body);
    const business = await createBusiness(db, user, body, owner.id);
    return { business, owner };
  });
  await applyPlanChoice(user, made.business.id, choice);
  if (made.restaurant) {
    // A café's, bakery's or cloud kitchen's own set-up comes once its time is
    // settled, so its features are switched on under the plan it was given
    // (with no free trial, nothing is unlocked before that); those its plan
    // leaves out are named, not switched on.
    made.restaurant.skipped = made.restaurant.format === 'restaurant' ? []
      : (await restaurantFormats().apply(made.restaurant.id, made.restaurant.format, { id: user.id, name: user.name })).skipped;
  }
  return { ...made, plan: await subscriptions().planOf(made.business.id) };
}

async function platformSetStatus(user, businessId, body) {
  requirePlatform(user);
  const status = v.requiredEnum(body.status, 'Status', ['active', 'inactive']);
  return repo.transaction(async (db) => {
    const found = await repo.one(db, 'SELECT id,legacy_restaurant_id FROM businesses WHERE id=$1 FOR UPDATE', [v.requiredId(businessId, 'Business')]);
    if (!found) fail('Business not found', 404);
    // A restaurant's business follows its restaurant (trigger
    // restaurants_business_status): switched off here alone, its tills would
    // go on working while its guests were turned away.
    if (found.legacy_restaurant_id) fail("A restaurant's business is switched off and on with the restaurant, in Platform › Restaurants", 409);
    const row = await repo.one(db, 'UPDATE businesses SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,name,status', [found.id, status]);
    await repo.audit(db, row.id, user.id, status === 'active' ? 'business.reactivated' : 'business.switched_off', row.id);
    return row;
  });
}

// A new password for one of the business's owners (the owner locked out).
async function platformResetOwnerPassword(user, businessId, body) {
  requirePlatform(user);
  const password = v.requiredPassword(body.password, 'New password');
  return repo.transaction(async (db) => {
    const owner = await repo.one(db, `SELECT u.id,u.name FROM business_memberships m JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.full_access
      JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND u.id=$2`, [v.requiredId(businessId, 'Business'), v.requiredId(body.userId, 'Owner')]);
    if (!owner) fail('That person is not an owner of this business', 404);
    await db.query(`UPDATE users SET password_hash=$2,token_version=token_version+1,failed_login_count=0,first_failed_login_at=NULL,login_locked_until=NULL,updated_by=$3,updated_at=now() WHERE id=$1`,
      [owner.id, await bcrypt.hash(password, BCRYPT_ROUNDS), user.id]);
    await repo.audit(db, v.requiredId(businessId, 'Business'), user.id, 'business.owner_password_reset', owner.id, { owner: owner.name });
    return { id: owner.id, name: owner.name };
  });
}

// --- An owner adds another business of their own ---------------------------

async function ownerCreate(user, body) {
  // Owners of a business (or a restaurant's admin) may start another one.
  const owns = await repo.one(repo.pool, `SELECT 1 FROM business_memberships m JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.full_access
    JOIN businesses b ON b.id=m.business_id WHERE m.user_id=$1 AND m.active AND b.status='active' LIMIT 1`, [user.id]);
  if (!owns && !user.roles?.includes('RESTAURANT_ADMIN') && !isPlatformUser(user)) fail('Only the owner of a business can add another business', 403);
  return repo.transaction(async (db) => createBusiness(db, user, body, user.id));
}

// --- Staff logins made from Staff & access ----------------------------------

async function createStaffAccount(business, user, body) {
  await access.require(business, 'access.edit');
  const name = v.requiredString(body.name, 'Name', 150);
  const email = v.requiredEmail(body.email, 'Email');
  const password = v.requiredPassword(body.password, 'Password');
  const mobile = readMobile(body.mobile, 'Mobile');
  const created = await repo.transaction(async (db) => {
    if (await repo.one(db, 'SELECT 1 FROM users WHERE lower(email)=$1', [email])) {
      fail('That email already has a login. Give that person access with "Give access" instead.', 409);
    }
    if (mobile && await repo.one(db, 'SELECT 1 FROM users WHERE mobile=$1', [mobile])) fail('That mobile number already has a login', 409);
    // Staff of a restaurant's business stay with that restaurant (its till and staff list).
    const row = await repo.one(db, 'INSERT INTO users(restaurant_id,name,email,mobile,password_hash,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email',
      [business.legacy_restaurant_id || null, name, email, mobile, await bcrypt.hash(password, BCRYPT_ROUNDS), user.id]);
    await repo.audit(db, business.id, user.id, 'staff_account.created', row.id, { name, email });
    return row;
  });
  // Their role, location and department go through the same checks as any
  // other access (someone tied to a department makes logins in it only).
  try {
    const member = await access.setMember(business, user,
      { userId: created.id, roleId: body.roleId, workLocationId: body.workLocationId, workDepartmentId: body.workDepartmentId, active: true }, { newLogin: true });
    return { ...member, name: created.name, email: created.email };
  } catch (error) {
    // No login is left behind without access: the person is created again with valid choices.
    await repo.pool.query('DELETE FROM business_audit WHERE business_id=$1 AND action=$2 AND entity_id=$3', [business.id, 'staff_account.created', created.id]).catch(() => {});
    await repo.pool.query('DELETE FROM users WHERE id=$1 AND last_login_at IS NULL', [created.id]).catch(() => {});
    throw error;
  }
}

// A new password for one of this business's staff: not an owner, and only
// someone the caller manages, by the same checks as Give access (their
// location, their department, and a role that does no more than the
// caller's), since whoever sets the password can sign in as them.
async function resetStaffPassword(business, user, staffId, body) {
  await access.require(business, 'access.edit');
  const password = v.requiredPassword(body.password, 'New password');
  return repo.transaction(async (db) => {
    const member = await repo.one(db, `SELECT m.*,r.full_access,u.name,u.restaurant_id FROM business_memberships m JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
      JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND m.user_id=$2`, [business.id, v.requiredId(staffId, 'Staff account')]);
    if (!member) fail('That person has no access to this business', 404);
    if (member.full_access) fail("An owner's password is changed by the owner (My profile) or by the platform", 403);
    if (Number(member.user_id) === Number(user.id)) fail('Change your own password from My profile', 400);
    await access.requireManages(db, business, member);
    // A login shared with other businesses or a restaurant is not this business's to reset.
    const elsewhere = await repo.one(db, 'SELECT count(*)::int AS n FROM business_memberships WHERE user_id=$1 AND business_id<>$2 AND active', [member.user_id, business.id]);
    if (elsewhere.n || (member.restaurant_id && Number(member.restaurant_id) !== Number(business.legacy_restaurant_id))) {
      fail('This login is also used in another business. Its password is changed there or by the person themselves.', 409);
    }
    await db.query('UPDATE users SET password_hash=$2,token_version=token_version+1,failed_login_count=0,first_failed_login_at=NULL,login_locked_until=NULL,updated_by=$3,updated_at=now() WHERE id=$1',
      [member.user_id, await bcrypt.hash(password, BCRYPT_ROUNDS), user.id]);
    await repo.audit(db, business.id, user.id, 'staff_account.password_reset', member.user_id, { name: member.name });
    return { id: Number(member.user_id), name: member.name };
  });
}

module.exports = { readCurrency, readTimezone, createBusiness, platformList, platformCreate, platformSetStatus, platformResetOwnerPassword, ownerCreate, createStaffAccount, resetStaffPassword };
