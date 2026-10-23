const bcrypt = require("bcrypt");

const userRepository = require("../repositories/user.repository");
const twoFactorRepository = require("../repositories/twoFactor.repository");
const twoFactorService = require("./twoFactor.service");
const roleRepository = require("../repositories/role.repository");
const outletRepository = require("../../restaurant/setup/repositories/outlet.repository");
const authService = require("./auth.service");
const AppError = require("../../../utils/AppError");

const DUPLICATE = "23505";
const ADMIN_PERMISSIONS = ["users.manage", "roles.manage"];

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const isFuture = (value) => Boolean(value && new Date(value) > new Date());

const toUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  mobile: row.mobile,
  status: row.status,
  outletId: row.outlet_id,
  outletName: row.outlet_name,
  roleIds: row.role_ids,
  roles: row.roles,
  roleNames: row.role_names || row.roles,
  roleList: row.role_list || [],
  employeeId: row.employee_id || null,
  employeeName: row.employee_name || null,
  employeeCode: row.employee_code || null,
  hasPin: Boolean(row.pin_set_at),
  pinSetAt: row.pin_set_at || null,
  pinLockedUntil: isFuture(row.pin_locked_until) ? row.pin_locked_until : null,
  loginLockedUntil: isFuture(row.login_locked_until) ? row.login_locked_until : null,
  // Two-step sign-in: on or off, and whether one of their roles requires it.
  twoFactorEnabled: Boolean(row.two_factor_enabled_at),
  twoFactorRequired: Boolean(row.two_factor_required),
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

// Roles must belong to this restaurant (or be shared system roles), and
// SUPER_ADMIN can never be handed out from inside a restaurant.
const validateRoles = async (restaurantId, roleIds) => {
  if (roleIds.length === 0) {
    throw new AppError(400, "Select at least one role");
  }

  const allowed = await roleRepository.findAssignableIds(restaurantId, roleIds);

  if (allowed.length !== roleIds.length) {
    throw new AppError(400, "One or more selected roles are not available");
  }
};

const validateOutlet = async (restaurantId, outletId) => {
  if (outletId === null) {
    return;
  }

  const outlet = await outletRepository.findById(restaurantId, outletId);

  if (!outlet) {
    throw new AppError(400, "Selected outlet does not exist");
  }
};

// A login needs something to sign in with: an email, or a mobile number.
// Mobiles are stored as their ten digits, so the same phone typed two ways
// cannot become two logins. A number is unique inside one restaurant only:
// someone who works at two restaurants on the platform can use the same
// phone at both (sign-in then asks for the restaurant code), and another
// restaurant's staff are never named here.
const normaliseContact = async (data, excludingUserId, restaurantId) => {
  let mobile = null;

  if (data.mobile) {
    mobile = authService.mobileDigits(data.mobile);

    if (!mobile) {
      throw new AppError(400, "Enter the mobile as a 10-digit number");
    }

    const clash = await userRepository.findMobileClash(mobile, excludingUserId, restaurantId);

    if (clash) {
      throw new AppError(409, `The mobile number is already used by ${clash.name}'s login`);
    }
  }

  if (!data.email && !mobile) {
    throw new AppError(400, "Give an email or a mobile number — staff sign in with either");
  }

  return { ...data, mobile };
};

// --- Who may change whom ----------------------------------------------------
//
// Managing users is a delegated power, and it must never be a way up. So:
//   * you can only give roles whose permissions you hold yourself;
//   * you can only change, reset, lock out or sign out someone whose access is
//     no greater than yours (an assistant manager cannot take over the owner);
//   * you cannot take away your own right to manage users;
//   * the restaurant always keeps at least one active admin.

const permissionNames = async (codes) => {
  const all = await roleRepository.findAllPermissions();
  return codes.map((code) => (all.find((row) => row.code === code) || { name: code }).name);
};

const assertCanGrant = async (roleIds, caller) => {
  const granted = await userRepository.findPermissionsOfRoles(roleIds);
  const mine = new Set(caller.permissions || []);
  const beyond = granted.filter((code) => !mine.has(code));

  if (beyond.length > 0) {
    const names = await permissionNames(beyond.slice(0, 4));

    throw new AppError(
      403,
      `You can only give roles whose permissions you have yourself. The selected roles include: ${names.join(
        "; "
      )}${beyond.length > 4 ? ` and ${beyond.length - 4} more` : ""}.`
    );
  }

  return granted;
};

const assertCanManage = async (target, caller) => {
  if (Number(target.id) === Number(caller.id)) {
    return;
  }

  const theirs = await userRepository.findPermissionsOfUser(target.id);
  const mine = new Set(caller.permissions || []);
  const beyond = theirs.filter((code) => !mine.has(code));

  if (beyond.length > 0) {
    throw new AppError(
      403,
      `${target.name} has access you do not have, so only someone with at least the same access can change their account.`
    );
  }
};

const isAdminSet = (permissions) => ADMIN_PERMISSIONS.every((code) => permissions.includes(code));

const findTarget = async (restaurantId, id) => {
  const row = await userRepository.findByIdForRestaurant(restaurantId, id);

  if (!row) {
    throw new AppError(404, "User not found");
  }

  return row;
};

const list = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await userRepository.findAll(restaurantId);
  return rows.map(toUser);
};

const getById = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  return toUser(await findTarget(restaurantId, id));
};

const create = async (restaurantId, input, caller) => {
  requireRestaurantId(restaurantId);
  await validateRoles(restaurantId, input.roleIds);
  await validateOutlet(restaurantId, input.outletId);
  await assertCanGrant(input.roleIds, caller);

  const data = await normaliseContact(input, null, restaurantId);
  const passwordHash = await bcrypt.hash(data.password, authService.BCRYPT_ROUNDS);

  try {
    const row = await userRepository.create(restaurantId, { ...data, passwordHash }, caller.id);
    return toUser(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A user with this email or mobile already exists");
    }

    throw error;
  }
};

const update = async (restaurantId, id, input, caller) => {
  requireRestaurantId(restaurantId);
  await validateRoles(restaurantId, input.roleIds);
  await validateOutlet(restaurantId, input.outletId);

  const existing = await findTarget(restaurantId, id);
  await assertCanManage(existing, caller);

  const self = Number(id) === Number(caller.id);

  // Locking yourself out of the system is always a mistake, so it is blocked.
  if (self && input.status !== "active") {
    throw new AppError(400, "You cannot deactivate your own account");
  }

  const rolesChanged =
    [...existing.role_ids].map(Number).sort().join(",") !== [...input.roleIds].map(Number).sort().join(",");
  const newPermissions = rolesChanged
    ? await assertCanGrant(input.roleIds, caller)
    : await userRepository.findPermissionsOfRoles(input.roleIds);

  if (self && rolesChanged && !newPermissions.includes("users.manage")) {
    throw new AppError(
      400,
      "You cannot take away your own permission to manage users. Ask another admin to change your roles."
    );
  }

  // The last person who can run the restaurant's access stays that way.
  const wasAdmin = existing.status === "active" && isAdminSet(await userRepository.findPermissionsOfUser(id));
  const staysAdmin = input.status === "active" && isAdminSet(newPermissions);

  if (wasAdmin && !staysAdmin && (await userRepository.countOtherAdmins(restaurantId, id)) === 0) {
    throw new AppError(
      409,
      `${existing.name} is the restaurant's only admin. Make someone else an admin first, so the restaurant is never left without one.`
    );
  }

  const data = await normaliseContact(input, id, restaurantId);

  // Checked again inside the write, under a lock, so two admins demoting each
  // other at the same moment cannot both pass the check above.
  const keepAnAdmin = async (client) => {
    if ((await roleRepository.countAdmins(client, restaurantId)) === 0) {
      throw new AppError(
        409,
        `This change would leave the restaurant with nobody who can manage users and roles. Make someone else an admin first.`
      );
    }
  };

  try {
    const row = await userRepository.update(restaurantId, id, data, caller.id, keepAnAdmin);

    if (!row) {
      throw new AppError(404, "User not found");
    }

    return { before: toUser(existing), after: toUser(row) };
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A user with this email or mobile already exists");
    }

    throw error;
  }
};

// Resetting someone's password also signs them out everywhere, so whoever was
// using the old one is cut off at once.
const resetPassword = async (restaurantId, id, password, caller) => {
  requireRestaurantId(restaurantId);

  const target = await findTarget(restaurantId, id);
  await assertCanManage(target, caller);

  const passwordHash = await bcrypt.hash(password, authService.BCRYPT_ROUNDS);
  const updated = await userRepository.updatePassword(restaurantId, id, passwordHash, caller.id);

  if (!updated) {
    throw new AppError(404, "User not found");
  }

  // Their devices trusted for 30 days ask for the code again.
  await twoFactorRepository.endDeviceTrust(id);

  return toUser(target);
};

// An admin setting someone's PIN (a new captain on day one). The person can
// change it themselves afterwards under My profile.
const setPin = async (restaurantId, id, pin, caller) => {
  requireRestaurantId(restaurantId);

  const target = await findTarget(restaurantId, id);
  await assertCanManage(target, caller);

  if (target.status !== "active") {
    throw new AppError(409, `${target.name}'s login is not active. Make it active before setting a PIN.`);
  }

  authService.assertGoodPin(pin, target.mobile);
  await userRepository.setPin(id, await authService.hashPin(pin), caller.id);

  return { user: toUser(await findTarget(restaurantId, id)), hadPin: Boolean(target.pin_set_at) };
};

const clearPin = async (restaurantId, id, caller) => {
  requireRestaurantId(restaurantId);

  const target = await findTarget(restaurantId, id);
  await assertCanManage(target, caller);
  await userRepository.clearPin(id, caller.id);

  return toUser(await findTarget(restaurantId, id));
};

// "Sign this person out everywhere": a lost phone, a staff member who left
// mid-shift with the till signed in.
const signOut = async (restaurantId, id, caller) => {
  requireRestaurantId(restaurantId);

  const target = await findTarget(restaurantId, id);
  await assertCanManage(target, caller);
  await userRepository.bumpTokenVersion(id);
  await twoFactorRepository.endDeviceTrust(id);

  return toUser(target);
};

// A lost phone with no recovery codes left: an admin switches the person's
// two-step off. It also signs them out everywhere, so whoever has the phone
// cannot carry on in a session they already had. If their role requires
// two-step, they set it up again at their next sign-in.
const resetTwoFactor = async (restaurantId, id, caller) => {
  requireRestaurantId(restaurantId);

  const target = await findTarget(restaurantId, id);
  await assertCanManage(target, caller);

  if (Number(id) === Number(caller.id)) {
    throw new AppError(
      400,
      "Turn your own two-step sign-in off under My profile (with your password and a code), or ask another admin to reset it."
    );
  }

  if (!target.two_factor_enabled_at) {
    throw new AppError(409, `${target.name} does not use two-step sign-in`);
  }

  await twoFactorRepository.disable(id, { endSessions: true });

  return toUser(await findTarget(restaurantId, id));
};

// Lifts a password or PIN lockout before its fifteen minutes are up.
const unlock = async (restaurantId, id, caller) => {
  requireRestaurantId(restaurantId);

  const target = await findTarget(restaurantId, id);
  await assertCanManage(target, caller);
  await userRepository.clearLoginFailures(id);
  await userRepository.clearDeviceFailures(id);
  await userRepository.clearPinFailures(id);

  return toUser(await findTarget(restaurantId, id));
};

const signIns = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const target = await findTarget(restaurantId, id);
  const rows = await userRepository.findSignIns(id, 100);

  return {
    user: { id: target.id, name: target.name },
    items: rows.map((row) => ({
      id: row.id,
      method: row.method,
      outcome: row.outcome,
      identifier: row.identifier,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      trustedDevice: Boolean(row.trusted_device),
      twoFactor: row.two_factor || null,
      createdAt: row.created_at,
    })),
  };
};

const getAccessSettings = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const [row, roles] = await Promise.all([
    userRepository.findAccessSettings(restaurantId),
    twoFactorService.requiredRoles(restaurantId),
  ]);

  return {
    idleLockMinutes: Number(row.idle_lock_minutes),
    updatedAt: row.updated_at,
    // The roles whose holders must use two-step sign-in.
    twoFactorRoles: roles,
  };
};

const saveTwoFactorRoles = async (restaurantId, roleIds, userId) => {
  requireRestaurantId(restaurantId);
  return twoFactorService.saveRequiredRoles(restaurantId, roleIds, userId);
};

const saveAccessSettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await getAccessSettings(restaurantId);
  const row = await userRepository.saveAccessSettings(restaurantId, data, userId);

  return {
    before,
    after: { idleLockMinutes: Number(row.idle_lock_minutes), updatedAt: row.updated_at, twoFactorRoles: before.twoFactorRoles },
  };
};

module.exports = {
  list,
  getById,
  create,
  update,
  resetPassword,
  setPin,
  clearPin,
  signOut,
  unlock,
  signIns,
  getAccessSettings,
  saveAccessSettings,
  resetTwoFactor,
  saveTwoFactorRoles,
};
