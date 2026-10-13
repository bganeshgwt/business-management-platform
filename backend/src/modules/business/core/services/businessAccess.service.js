const repo = require('../repositories/business.repository');
const config = require('../../../../config/env');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');

// Who may do what in a business. Two separate questions, both answered here
// on every request:
//   capability — is the module switched on for this business?
//   permission — does this person's role in this business allow the action?
// A membership is the only way into a business; a business ID in the URL
// grants nothing by itself.

const devEnabled = () => !config.isLive && process.env.MULTI_BUSINESS_DEVELOPMENT === 'true';
const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

async function load(user, businessId) {
  const business = await repo.access(id(businessId, 'Business'), user.id);
  // A business you are not a member of looks exactly like one that does not exist.
  if (!business || (business.is_demo && !devEnabled())) fail('Business not found', 404);
  const catalogue = await repo.platformCatalogue();
  const core = catalogue.modules.filter((m) => m.kind === 'core').map((m) => m.code);
  business.modules = [...core, ...business.capabilities];
  // Who is asking (tasks: "assigned to me" in the bell).
  business.member_user_id = Number(user.id);
  return business;
}

// The module a permission belongs to must be on, and the role must hold it.
function check(business, permission, catalogue) {
  const moduleCode = permission.slice(0, permission.indexOf('.'));
  if (!business.modules.includes(moduleCode)) {
    const name = catalogue.modules.find((m) => m.code === moduleCode)?.name || moduleCode;
    fail(`${name} is not switched on for this business. An owner can turn it on in Settings › Modules.`, 403);
  }
  if (!business.permissions.includes(permission)) {
    const name = catalogue.permissions.find((p) => p.code === permission)?.name || permission;
    fail(`Your role (${business.role_name}) does not allow this: ${name.charAt(0).toLowerCase()}${name.slice(1)}.`, 403);
  }
}
const can = (business, permission) => {
  const moduleCode = permission.slice(0, permission.indexOf('.'));
  return business.modules.includes(moduleCode) && business.permissions.includes(permission);
};
async function require_(business, permission) { check(business, permission, await repo.platformCatalogue()); }
// One of several permissions (e.g. a document list that holds sales and purchases).
async function requireAny(business, permissions) {
  if (!permissions.some((p) => can(business, p))) await require_(business, permissions[0]);
}

async function access(user, businessId, permission) {
  const business = await load(user, businessId);
  if (permission) await require_(business, permission);
  return business;
}

// --- Locations: who works where ----------------------------------------------
//
// A person tied to one location (business_memberships.location_id) works
// there only: a location they name must be theirs, and a request that names
// none is answered for their location. Everyone else may pick a location in
// the top bar (X-Business-Location); that only fills in the location a
// request leaves out, so lists, reports and the counter open on that branch.
// Request parameters that carry a location:
const QUERY_LOCATION_KEYS = ['location', 'locationId'];
const BODY_LOCATION_KEYS = ['locationId', 'fromLocationId'];
const isGiven = (value) => value !== undefined && value !== null && value !== '';

function locationMismatch(business) {
  fail(`You work at ${business.member_location_name || 'one location'} only. Ask a manager who works across every location.`, 403);
}

// Throws when a person tied to a location acts on another one's record.
function requireLocation(business, locationId) {
  if (business.member_location_id && isGiven(locationId) && String(locationId) !== String(business.member_location_id)) locationMismatch(business);
}

function scope(req, business) {
  const tied = business.member_location_id ? String(business.member_location_id) : null;
  let chosen = null;
  if (!tied) {
    const header = req.get('x-business-location');
    if (header && /^\d{1,18}$/.test(header) && business.active_location_ids.map(String).includes(header)) chosen = header;
  }
  const effective = tied || chosen;
  business.location_scope = effective ? Number(effective) : null;
  business.location_tied = Boolean(tied);
  if (!effective) return;
  const query = { ...req.query };
  req.locationFilledIn = [];
  for (const key of QUERY_LOCATION_KEYS) {
    if (!isGiven(query[key])) { query[key] = effective; req.locationFilledIn.push(key); }
    else if (tied && String(query[key]) !== tied) locationMismatch(business);
  }
  // Express 5 makes req.query a getter: replace it for the rest of this request.
  Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
  if (tied && req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const key of BODY_LOCATION_KEYS) if (isGiven(req.body[key])) requireLocation(business, req.body[key]);
    if (req.body.opening && typeof req.body.opening === 'object') requireLocation(business, req.body.opening.locationId);
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !isGiven(req.body.locationId)) req.body.locationId = Number(tied);
  }
}

async function context(business) {
  const catalogue = await repo.platformCatalogue();
  const settings = await repo.one(repo.pool, `SELECT display_name,legal_name,gstin,state_code,tax_mode,rounding,fiscal_year_start_month,date_format,logo_path,max_bill_discount_percent,walk_in_credit,counter_pin_every_bill,
    voucher_valid_days,ageing_days,near_expiry_days,weight_buttons_grams,receipt_width_mm,day_cutoff_hour
    FROM business_settings WHERE business_id=$1`, [business.id]);
  const allLocations = await repo.all(repo.pool, `SELECT id,name,code,active,sells_at_counter,address_line1,address_line2,city,postal_code,state_code,gstin,phone
    FROM business_locations WHERE business_id=$1 ORDER BY id`, [business.id]);
  // Every location picker on the screens is built from `locations`: a person
  // tied to a location (or who picked one in the top bar) sees that one only.
  // `allLocations` is for what names other locations (a transfer's destination).
  const locations = business.location_scope ? allLocations.filter((l) => Number(l.id) === business.location_scope) : allLocations;
  const { permissions, capabilities, modules } = business;
  return {
    business: { id: business.id, name: business.name, code: business.code, business_type: business.business_type, type_name: business.type_name,
      legacy_restaurant_id: business.legacy_restaurant_id, is_demo: business.is_demo, currency: business.currency, timezone: business.timezone },
    role: { id: business.role_id, name: business.role_name, full_access: business.full_access },
    member: { location_id: business.member_location_id || null, location_name: business.member_location_name || null },
    currentLocationId: business.location_scope || null,
    permissions, capabilities, modules,
    moduleCatalogue: catalogue.modules, settings, locations, allLocations,
  };
}

// --- Roles ---------------------------------------------------------------

async function permissionCatalogue(business) {
  const catalogue = await repo.platformCatalogue();
  const applicable = new Set((await repo.all(repo.pool, 'SELECT module_code FROM platform_module_business_types WHERE business_type=$1', [business.business_type])).map((r) => r.module_code));
  return {
    modules: catalogue.modules.filter((m) => m.kind === 'core' || applicable.has(m.code)),
    permissions: catalogue.permissions.filter((p) => catalogue.modules.find((m) => m.code === p.module_code)?.kind === 'core' || applicable.has(p.module_code)),
    templates: catalogue.templates,
  };
}

// The actor must hold every permission of a role they act on (and so of its
// holders): otherwise they could demote or lock out someone above them.
async function requireCovers(db, business, roleId, who) {
  if (business.full_access) return;
  const role = await repo.one(db, 'SELECT full_access FROM business_roles WHERE business_id=$1 AND id=$2', [business.id, roleId]);
  if (role?.full_access) fail(`${who} has full access, which you do not have`, 403);
  const held = (await repo.all(db, 'SELECT permission_code FROM business_role_permissions WHERE business_id=$1 AND role_id=$2', [business.id, roleId])).map((r) => r.permission_code);
  const beyond = held.filter((code) => !business.permissions.includes(code));
  if (beyond.length) fail(`${who} can do things you cannot (${beyond.slice(0, 3).join(', ')}), so you cannot change it`, 403);
}

// A person can only hand out what they hold themselves: a manager with
// access.edit cannot create a role with refunds they cannot do.
async function readPermissions(business, value) {
  const catalogue = await repo.platformCatalogue();
  const list = v.requiredArray(value, 'Permissions');
  const known = new Set(catalogue.permissions.map((p) => p.code));
  const unique = [...new Set(list)];
  for (const code of unique) {
    if (typeof code !== 'string' || !known.has(code)) fail(`Unknown permission: ${String(code).slice(0, 60)}`);
    if (!business.full_access && !business.permissions.includes(code)) fail(`You cannot give a permission you do not have yourself (${code})`, 403);
  }
  return unique;
}

async function createRole(business, user, body) {
  await require_(business, 'access.edit');
  const name = v.requiredString(body.name, 'Role name', 80);
  const description = v.optionalString(body.description, 'Description', 300);
  const permissions = await readPermissions(business, body.permissions);
  return repo.transaction(async (db) => {
    const role = await repo.one(db, `INSERT INTO business_roles(business_id,name,description,created_by,updated_by) VALUES($1,$2,$3,$4,$4) RETURNING *`,
      [business.id, name, description, user.id]);
    if (permissions.length) {
      await db.query('INSERT INTO business_role_permissions(business_id,role_id,permission_code) SELECT $1,$2,unnest($3::text[])', [business.id, role.id, permissions]);
    }
    await repo.audit(db, business.id, user.id, 'role.created', role.id, { name, permissions });
    return { ...role, permissions };
  });
}

async function updateRole(business, user, roleId, body) {
  await require_(business, 'access.edit');
  const name = v.requiredString(body.name, 'Role name', 80);
  const description = v.optionalString(body.description, 'Description', 300);
  const active = v.requiredBoolean(body.active, 'Active', true);
  const permissions = await readPermissions(business, body.permissions);
  return repo.transaction(async (db) => {
    const role = await repo.one(db, 'SELECT * FROM business_roles WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(roleId)]);
    if (!role) fail('Role not found', 404);
    if (role.full_access) fail('The Owner role always has every permission and cannot be changed', 409);
    // A role that can do things this person cannot is out of their reach
    // altogether: they may not edit, reduce or switch it off.
    await requireCovers(db, business, role.id, `The ${role.name} role`);
    if (!active) {
      const used = await repo.one(db, 'SELECT count(*)::int AS n FROM business_memberships WHERE business_id=$1 AND role_id=$2 AND active', [business.id, role.id]);
      if (used.n) fail(`${used.n} ${used.n === 1 ? 'person has' : 'people have'} this role. Give them another role before switching it off.`, 409);
    }
    const saved = await repo.one(db, `UPDATE business_roles SET name=$3,description=$4,active=$5,updated_by=$6,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, role.id, name, description, active, user.id]);
    await db.query('DELETE FROM business_role_permissions WHERE business_id=$1 AND role_id=$2', [business.id, role.id]);
    if (permissions.length) {
      await db.query('INSERT INTO business_role_permissions(business_id,role_id,permission_code) SELECT $1,$2,unnest($3::text[])', [business.id, role.id, permissions]);
    }
    await repo.audit(db, business.id, user.id, 'role.updated', role.id, { name, active, permissions });
    return { ...saved, permissions };
  });
}

// --- Memberships -----------------------------------------------------------

async function memberCandidates(business, user) {
  await require_(business, 'access.edit');
  // Staff accounts of the caller's own restaurant only: no directory of every
  // user on the platform. Inviting people from elsewhere is Phase 2.
  // People already on this business's staff list (with access on or off) are
  // managed there, so they are not offered again.
  // Also people who work in another business this person owns and whose login
  // was made in Business Admin (no restaurant behind it). Another restaurant's
  // people are never offered.
  return repo.all(repo.pool, `SELECT u.id,u.name,u.email FROM users u WHERE u.status='active'
    AND (u.restaurant_id=$1 OR u.restaurant_id IS NULL AND EXISTS (SELECT 1 FROM business_memberships o JOIN business_roles r ON r.business_id=o.business_id AND r.id=o.role_id AND r.full_access
      JOIN business_memberships x ON x.business_id=o.business_id AND x.user_id=u.id WHERE o.user_id=$3 AND o.active))
    AND NOT EXISTS (SELECT 1 FROM business_memberships m WHERE m.business_id=$2 AND m.user_id=u.id) ORDER BY u.name`, [user.restaurantId || null, business.id, user.id]);
}

// options.newLogin: the person's login was just made for this business
// (Staff & access › New staff login), so they are eligible by definition.
async function setMember(business, user, body, options = {}) {
  await require_(business, 'access.edit');
  const targetId = id(body.userId, 'Staff account');
  const active = v.requiredBoolean(body.active, 'Active', true);
  // Where they work: one location, or every location (empty). Older clients
  // send nothing and the person keeps what they have.
  const locationGiven = body.workLocationId !== undefined;
  const workLocationId = locationGiven && isGiven(body.workLocationId) ? id(body.workLocationId, 'Location') : null;
  // A manager tied to a location can only give access at that location.
  if (business.member_location_id && (!locationGiven || String(workLocationId) !== String(business.member_location_id))) {
    fail(`You work at ${business.member_location_name || 'one location'}, so you can only give access there.`, 403);
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const candidate = await repo.one(db, `SELECT id FROM users u WHERE id=$1 AND status='active' AND (restaurant_id=$2
      OR restaurant_id IS NULL AND EXISTS (SELECT 1 FROM business_memberships o JOIN business_roles r ON r.business_id=o.business_id AND r.id=o.role_id AND r.full_access
        JOIN business_memberships x ON x.business_id=o.business_id AND x.user_id=u.id WHERE o.user_id=$3 AND o.active))`, [targetId, user.restaurantId || null, user.id]);
    const existing = await repo.one(db, `SELECT m.*,r.full_access FROM business_memberships m JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
      WHERE m.business_id=$1 AND m.user_id=$2`, [business.id, targetId]);
    if (!candidate && !existing && !options.newLogin) fail('Eligible staff member not found', 404);
    if (existing?.full_access) fail('The owner\'s access cannot be changed here', 409);
    if (targetId === user.id) fail('You cannot change your own access. Ask another person with access rights.', 403);
    // Nobody may change, demote or switch off someone who can do more than they can.
    if (existing) await requireCovers(db, business, existing.role_id, 'This person');
    // The role is either named, or (for an older client) one of the three template words.
    let role;
    if (body.roleId !== undefined && body.roleId !== null && body.roleId !== '') {
      role = await repo.one(db, 'SELECT * FROM business_roles WHERE business_id=$1 AND id=$2 AND active', [business.id, id(body.roleId, 'Role')]);
    } else {
      const template = v.requiredEnum(body.role, 'Role', ['manager', 'viewer', 'cashier', 'stock_keeper', 'accountant']);
      role = await repo.one(db, 'SELECT * FROM business_roles WHERE business_id=$1 AND template_code=$2 AND active', [business.id, template]);
    }
    if (!role) fail('Role not found', 404);
    if (role.full_access) fail('The Owner role is given when a business is created and cannot be handed out here', 409);
    if (!business.full_access) {
      const rolePermissions = (await repo.all(db, 'SELECT permission_code FROM business_role_permissions WHERE business_id=$1 AND role_id=$2', [business.id, role.id])).map((r) => r.permission_code);
      const beyond = rolePermissions.filter((code) => !business.permissions.includes(code));
      if (beyond.length) fail(`The ${role.name} role can do things you cannot (${beyond.slice(0, 3).join(', ')}), so you cannot give it out`, 403);
    }
    // A manager tied to a location manages that location's people only.
    if (existing && business.member_location_id && String(existing.location_id) !== String(business.member_location_id)) {
      fail('This person does not work at your location', 403);
    }
    if (workLocationId) {
      const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, workLocationId]);
      if (!location) fail('Location not found or closed', 404);
    }
    const member = await repo.one(db, `INSERT INTO business_memberships(business_id,user_id,role_id,active,created_by,updated_by,location_id) VALUES($1,$2,$3,$4,$5,$5,$6)
      ON CONFLICT(business_id,user_id) DO UPDATE SET role_id=EXCLUDED.role_id,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=now(),
      location_id=CASE WHEN $7 THEN EXCLUDED.location_id ELSE business_memberships.location_id END RETURNING *`,
    [business.id, targetId, role.id, active, user.id, workLocationId, locationGiven]);
    await repo.audit(db, business.id, user.id, 'membership.updated', targetId, { roleId: role.id, role: role.name, active, locationId: member.location_id });
    return { ...member, role_name: role.name };
  });
}

module.exports = { devEnabled, access, load, scope, requireLocation, can, require: require_, requireAny, context, permissionCatalogue, createRole, updateRole, memberCandidates, setMember };
