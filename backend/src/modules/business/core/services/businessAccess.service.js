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

async function context(business) {
  const catalogue = await repo.platformCatalogue();
  const settings = await repo.one(repo.pool, `SELECT display_name,legal_name,gstin,state_code,tax_mode,rounding,fiscal_year_start_month,date_format,logo_path,max_bill_discount_percent,walk_in_credit,counter_pin_every_bill
    FROM business_settings WHERE business_id=$1`, [business.id]);
  const locations = await repo.all(repo.pool, 'SELECT id,name,code,active,sells_at_counter FROM business_locations WHERE business_id=$1 ORDER BY id', [business.id]);
  const { permissions, capabilities, modules } = business;
  return {
    business: { id: business.id, name: business.name, code: business.code, business_type: business.business_type, type_name: business.type_name,
      legacy_restaurant_id: business.legacy_restaurant_id, is_demo: business.is_demo, currency: business.currency, timezone: business.timezone },
    role: { id: business.role_id, name: business.role_name, full_access: business.full_access },
    permissions, capabilities, modules,
    moduleCatalogue: catalogue.modules, settings, locations,
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
  return repo.all(repo.pool, `SELECT u.id,u.name,u.email FROM users u WHERE u.restaurant_id=$1 AND u.status='active'
    AND NOT EXISTS (SELECT 1 FROM business_memberships m WHERE m.business_id=$2 AND m.user_id=u.id) ORDER BY u.name`, [user.restaurantId, business.id]);
}

async function setMember(business, user, body) {
  await require_(business, 'access.edit');
  const targetId = id(body.userId, 'Staff account');
  const active = v.requiredBoolean(body.active, 'Active', true);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const candidate = await repo.one(db, "SELECT id FROM users WHERE id=$1 AND restaurant_id=$2 AND status='active'", [targetId, user.restaurantId]);
    const existing = await repo.one(db, `SELECT m.*,r.full_access FROM business_memberships m JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id
      WHERE m.business_id=$1 AND m.user_id=$2`, [business.id, targetId]);
    if (!candidate && !existing) fail('Eligible staff member not found', 404);
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
    const member = await repo.one(db, `INSERT INTO business_memberships(business_id,user_id,role_id,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)
      ON CONFLICT(business_id,user_id) DO UPDATE SET role_id=EXCLUDED.role_id,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, targetId, role.id, active, user.id]);
    await repo.audit(db, business.id, user.id, 'membership.updated', targetId, { roleId: role.id, role: role.name, active });
    return { ...member, role_name: role.name };
  });
}

module.exports = { devEnabled, access, load, can, require: require_, requireAny, context, permissionCatalogue, createRole, updateRole, memberCandidates, setMember };
