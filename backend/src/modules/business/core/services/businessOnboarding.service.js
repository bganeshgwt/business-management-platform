const bcrypt = require('bcrypt');
const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const { readGstin } = require('../../../../utils/gstin');
const { readMobile } = require('../../../../utils/phone');

// Creating businesses: any business type (a restaurant is created from
// Platform › Restaurants, with its own restaurant set-up), its legal details,
// its first location and its owner's login.
//   * the platform's super admin creates one for a customer (Platform ›
//     Businesses), the owner being a new login or an existing one;
//   * an owner adds another business of their own ("Add a business" on the
//     business list) and becomes its owner;
//   * an owner (or anyone with access.edit) gives their staff a login of
//     their own from Staff & access, with no restaurant behind it.
// The provisioning trigger gives every new business its roles, settings, GST
// slabs, units and its type's default modules (migration 1791300000005).

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

async function platformList(user, query = {}) {
  requirePlatform(user);
  const q = typeof query.q === 'string' && query.q.trim() ? `%${query.q.trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const type = typeof query.type === 'string' && query.type ? query.type.slice(0, 40) : null;
  const status = ['active', 'inactive'].includes(query.status) ? query.status : null;
  const items = await repo.all(repo.pool, `SELECT b.id,b.name,b.code,b.business_type,t.name AS type_name,b.status,b.currency,b.timezone,b.created_at,
      s.gstin,s.city,
      (SELECT count(*)::int FROM business_locations l WHERE l.business_id=b.id AND l.active) AS locations,
      (SELECT count(*)::int FROM business_memberships m WHERE m.business_id=b.id AND m.active) AS people,
      (SELECT json_agg(json_build_object('id',u.id,'name',u.name,'email',u.email) ORDER BY u.name) FROM business_memberships m
        JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.full_access JOIN users u ON u.id=m.user_id
        WHERE m.business_id=b.id AND m.active) AS owners
    FROM businesses b JOIN business_types t ON t.code=b.business_type LEFT JOIN business_settings s ON s.business_id=b.id
    WHERE ($1::text IS NULL OR concat_ws(' ',b.name,b.code,s.city,s.gstin) ILIKE $1)
      AND ($2::text IS NULL OR b.business_type=$2) AND ($3::text IS NULL OR b.status=$3)
    ORDER BY b.created_at DESC LIMIT 500`, [q, type, status]);
  const types = await repo.all(repo.pool, 'SELECT code,name FROM business_types ORDER BY name');
  return { items, types };
}

async function platformCreate(user, body) {
  requirePlatform(user);
  return repo.transaction(async (db) => {
    const owner = await readOwner(db, body);
    const business = await createBusiness(db, user, body, owner.id);
    return { business, owner };
  });
}

async function platformSetStatus(user, businessId, body) {
  requirePlatform(user);
  const status = v.requiredEnum(body.status, 'Status', ['active', 'inactive']);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, 'UPDATE businesses SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,name,status', [v.requiredId(businessId, 'Business'), status]);
    if (!row) fail('Business not found', 404);
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

// A new password for one of this business's staff (not an owner, and only
// someone the caller can manage: the role checks of setMember apply).
async function resetStaffPassword(business, user, staffId, body) {
  await access.require(business, 'access.edit');
  const password = v.requiredPassword(body.password, 'New password');
  return repo.transaction(async (db) => {
    const member = await repo.one(db, `SELECT m.*,r.full_access,u.name,u.restaurant_id FROM business_memberships m JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
      JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND m.user_id=$2`, [business.id, v.requiredId(staffId, 'Staff account')]);
    if (!member) fail('That person has no access to this business', 404);
    if (member.full_access) fail("An owner's password is changed by the owner (My profile) or by the platform", 403);
    if (Number(member.user_id) === Number(user.id)) fail('Change your own password from My profile', 400);
    access.requireLocation(business, member.location_id);
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

module.exports = { readCurrency, readTimezone, platformList, platformCreate, platformSetStatus, platformResetOwnerPassword, ownerCreate, createStaffAccount, resetStaffPassword };
