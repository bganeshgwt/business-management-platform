const roleRepository = require("../repositories/role.repository");
const authorize = require("../../../middlewares/authorize");
const AppError = require("../../../utils/AppError");

const DUPLICATE = "23505";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toRole = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  isSystem: row.is_system,
  status: row.status,
  permissions: row.permissions,
  userCount: row.user_count,
});

const list = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await roleRepository.findAll(restaurantId);
  return rows.map(toRole);
};

const getById = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const row = await roleRepository.findById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Role not found");
  }

  return toRole(row);
};

// Each permission says whether anything checks it yet. A permission no route
// checks changes nothing when given or taken away, and the role editor says
// so rather than let an owner believe a trimmed role is safer than it is.
// A restaurant is never shown the platform owner's own permissions: it could
// not grant them anyway.
const listPermissions = async (restaurantId = null) =>
  (await roleRepository.findAllPermissions())
    .filter((row) => !restaurantId || !row.code.startsWith("platform."))
    .map((row) => ({
      ...row,
      enforced: authorize.isEnforced(row.code),
    }));

// Permission codes are checked against the permissions table, so a typo
// cannot silently create a role that grants nothing.
const validatePermissions = async (permissions) => {
  if (permissions.length === 0) {
    throw new AppError(400, "Select at least one permission");
  }

  const all = await roleRepository.findAllPermissions();
  const known = new Set(all.map((permission) => permission.code));
  const unknown = permissions.filter((code) => !known.has(code));

  if (unknown.length > 0) {
    throw new AppError(400, `Unknown permission(s): ${unknown.join(", ")}`);
  }

  if (permissions.includes("platform.restaurants.manage")) {
    throw new AppError(400, "That permission belongs to the platform owner only");
  }

  return all;
};

// Nobody can hand out a power they do not have themselves. Without this,
// anyone allowed to manage roles could build a role with every permission and
// give it to themselves.
const assertWithinOwn = (permissions, caller, all) => {
  const mine = new Set(caller.permissions || []);
  const beyond = permissions.filter((code) => !mine.has(code));

  if (beyond.length > 0) {
    const names = beyond
      .map((code) => (all.find((row) => row.code === code) || { name: code }).name)
      .slice(0, 4)
      .join("; ");

    throw new AppError(
      403,
      `A role can only include permissions you have yourself. You do not have: ${names}${
        beyond.length > 4 ? ` and ${beyond.length - 4} more` : ""
      }.`
    );
  }
};

const assertCanWeaken = async (restaurantId, role, caller, all) => {
  const mine = new Set(caller.permissions || []);
  const beyondRole = role.permissions.filter((code) => !mine.has(code));

  if (beyondRole.length > 0) {
    const names = beyondRole
      .map((code) => (all.find((row) => row.code === code) || { name: code }).name)
      .slice(0, 3)
      .join("; ");

    throw new AppError(
      403,
      `"${role.name}" includes access you do not have (${names}${
        beyondRole.length > 3 ? ` and ${beyondRole.length - 3} more` : ""
      }), so only someone with at least that access can take anything away from it.`
    );
  }

  const holders = await roleRepository.findHolders(restaurantId, role.id);
  const stronger = holders.filter(
    (holder) =>
      Number(holder.id) !== Number(caller.id) && holder.permissions.some((code) => !mine.has(code))
  );

  if (stronger.length > 0) {
    throw new AppError(
      403,
      `${stronger
        .slice(0, 2)
        .map((holder) => holder.name)
        .join(" and ")}${stronger.length > 2 ? ` and ${stronger.length - 2} more` : ""} ${
        stronger.length === 1 ? "has" : "have"
      } this role and access you do not have, so only someone with at least the same access can take anything away from it.`
    );
  }
};

// The restaurant must always keep someone who can manage users and roles,
// or nobody inside it can ever fix access again.
const keepAnAdmin = (restaurantId) => async (client) => {
  const admins = await roleRepository.countAdmins(client, restaurantId);

  if (admins === 0) {
    throw new AppError(
      409,
      "This change would leave the restaurant with nobody who can manage users and roles. Keep those two permissions on at least one active person's role."
    );
  }
};

const toCode = (text) =>
  String(text || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);

const create = async (restaurantId, data, caller) => {
  requireRestaurantId(restaurantId);
  const all = await validatePermissions(data.permissions);
  assertWithinOwn(data.permissions, caller, all);

  try {
    const row = await roleRepository.create(restaurantId, data, caller.id);
    return toRole(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A role with code "${data.code}" already exists`);
    }

    throw error;
  }
};

// System roles are shared by every restaurant, so they can never be edited
// here — copy one instead (see copy below).
const update = async (restaurantId, id, data, caller) => {
  requireRestaurantId(restaurantId);
  const all = await validatePermissions(data.permissions);

  const existing = await roleRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Role not found");
  }

  if (existing.is_system) {
    throw new AppError(
      403,
      "Built-in roles are shared by every restaurant and cannot be changed. Use Copy role to make your own version, then change that."
    );
  }

  // What is being ADDED must be within your own permissions.
  const added = data.permissions.filter((code) => !existing.permissions.includes(code));
  assertWithinOwn(added, caller, all);

  // Taking something away (a permission, or the whole role by switching it
  // off) changes every holder's access, so it is the same power as editing
  // those people directly: you may only do it to a role no stronger than you,
  // held only by people no stronger than you. Otherwise someone trusted with
  // "manage roles" could trim the owner's role down to nothing and then reset
  // the owner's password.
  const removed = existing.permissions.filter((code) => !data.permissions.includes(code));
  const switchedOff = existing.status === "active" && data.status !== "active";

  if (removed.length > 0 || switchedOff) {
    await assertCanWeaken(restaurantId, existing, caller, all);
  }

  const row = await roleRepository.update(restaurantId, id, data, caller.id, keepAnAdmin(restaurantId));

  if (!row) {
    throw new AppError(404, "Role not found");
  }

  return { before: toRole(existing), after: toRole(row) };
};

// Built-in roles cannot be trimmed because every restaurant shares them. A
// copy is this restaurant's own role with the same permissions, which can then
// be changed freely; `moveUsers` puts this restaurant's people who hold the
// original onto the copy in the same step.
const copy = async (restaurantId, id, data, caller) => {
  requireRestaurantId(restaurantId);

  const source = await roleRepository.findById(restaurantId, id);

  if (!source) {
    throw new AppError(404, "Role not found");
  }

  if (source.code === "SUPER_ADMIN") {
    throw new AppError(400, "The platform owner's role cannot be copied");
  }

  const permissions = source.permissions.filter((code) => code !== "platform.restaurants.manage");
  const all = await validatePermissions(permissions);
  assertWithinOwn(permissions, caller, all);

  const name = data.name || `${source.name} (copy)`;
  const baseCode = toCode(data.code || name) || "CUSTOM_ROLE";
  let row = null;

  // A readable code from the name; if it is taken, the next free number.
  for (let attempt = 1; attempt <= 20 && !row; attempt += 1) {
    const code = attempt === 1 ? baseCode : `${baseCode.slice(0, 46)}_${attempt}`;

    try {
      row = await roleRepository.create(
        restaurantId,
        {
          code,
          name,
          description: data.description ?? source.description ?? `Copied from ${source.name}`,
          permissions,
        },
        caller.id
      );
    } catch (error) {
      if (error.code !== DUPLICATE || data.code) {
        if (error.code === DUPLICATE) {
          throw new AppError(409, `A role with code "${code}" already exists`);
        }

        throw error;
      }
    }
  }

  if (!row) {
    throw new AppError(409, "Could not find a free code for the copy. Give it a code yourself.");
  }

  let moved = [];

  if (data.moveUsers) {
    if (!(caller.permissions || []).includes("users.manage")) {
      throw new AppError(403, "Moving people onto the copy needs permission to manage users");
    }

    moved = await roleRepository.moveUsers(restaurantId, source.id, row.id, caller.id);
  }

  return {
    role: toRole(await roleRepository.findById(restaurantId, row.id)),
    source: toRole(source),
    movedUserIds: moved,
  };
};

const remove = async (restaurantId, id, caller) => {
  requireRestaurantId(restaurantId);

  const existing = await roleRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Role not found");
  }

  if (existing.is_system) {
    throw new AppError(403, "System roles cannot be deleted");
  }

  if (caller) {
    await assertCanWeaken(restaurantId, existing, caller, await roleRepository.findAllPermissions());
  }

  const userCount = await roleRepository.countUsers(id, restaurantId);

  if (userCount > 0) {
    throw new AppError(409, `This role is assigned to ${userCount} user(s). Remove it from them first.`);
  }

  await roleRepository.remove(restaurantId, id);

  return toRole(existing);
};

module.exports = {
  list,
  getById,
  listPermissions,
  create,
  update,
  copy,
  remove,
};
