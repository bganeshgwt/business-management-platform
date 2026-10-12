const roleService = require("../services/role.service");
const { logAction } = require("../../../utils/audit");
const v = require("../../../utils/validate");

const readPermissions = (body = {}) => [
  ...new Set(
    v.requiredArray(body.permissions, "Permissions").map((code) =>
      v.requiredString(code, "Permission code", 100)
    )
  ),
];

const list = async (req, res) => {
  const roles = await roleService.list(req.user.restaurantId);

  res.json({ success: true, data: roles });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "Role id");
  const role = await roleService.getById(req.user.restaurantId, id);

  res.json({ success: true, data: role });
};

const listPermissions = async (req, res) => {
  const permissions = await roleService.listPermissions(req.user.restaurantId);

  res.json({ success: true, data: permissions });
};

const create = async (req, res) => {
  const body = req.body || {};

  const data = {
    code: v.requiredString(body.code, "Role code", 50).toUpperCase().replace(/\s+/g, "_"),
    name: v.requiredString(body.name, "Role name", 100),
    description: v.optionalString(body.description, "Description", 500),
    permissions: readPermissions(body),
  };

  const role = await roleService.create(req.user.restaurantId, data, req.user);

  logAction(req, "create", "role", {
    id: role.id,
    label: role.name,
    details: { permissions: role.permissions },
  });

  res.status(201).json({ success: true, message: "Role created", data: role });
};

// The code is fixed after creation, because permission checks may refer to it.
const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Role id");
  const body = req.body || {};

  const data = {
    name: v.requiredString(body.name, "Role name", 100),
    description: v.optionalString(body.description, "Description", 500),
    status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
    permissions: readPermissions(body),
  };

  const { before, after } = await roleService.update(req.user.restaurantId, id, data, req.user);

  // What a role can do is the whole point of it, so the log says exactly which
  // permissions were added and taken away.
  logAction(req, "update", "role", {
    id: after.id,
    label: after.name,
    details: {
      added: after.permissions.filter((code) => !before.permissions.includes(code)),
      removed: before.permissions.filter((code) => !after.permissions.includes(code)),
      ...(before.status !== after.status ? { status: [before.status, after.status] } : {}),
      ...(before.name !== after.name ? { name: [before.name, after.name] } : {}),
    },
  });

  res.json({ success: true, message: "Role updated", data: after });
};

// Copy a role — usually a built-in one — into this restaurant's own roles.
const copy = async (req, res) => {
  const id = v.requiredId(req.params.id, "Role id");
  const body = req.body || {};

  const result = await roleService.copy(
    req.user.restaurantId,
    id,
    {
      name: v.optionalString(body.name, "Role name", 100),
      code: body.code ? v.requiredString(body.code, "Role code", 50).toUpperCase().replace(/\s+/g, "_") : null,
      description: v.optionalString(body.description, "Description", 500),
      moveUsers: v.requiredBoolean(body.moveUsers, "Move users", false),
    },
    req.user
  );

  logAction(req, "copy", "role", {
    id: result.role.id,
    label: result.role.name,
    details: {
      copiedFrom: result.source.name,
      permissions: result.role.permissions.length,
      movedUsers: result.movedUserIds.length,
    },
  });

  res.status(201).json({
    success: true,
    message:
      result.movedUserIds.length > 0
        ? `Role copied, and ${result.movedUserIds.length} ${result.movedUserIds.length === 1 ? "person was" : "people were"} moved onto it`
        : "Role copied",
    data: { ...result.role, movedUsers: result.movedUserIds.length },
  });
};

const remove = async (req, res) => {
  const id = v.requiredId(req.params.id, "Role id");
  const removed = await roleService.remove(req.user.restaurantId, id, req.user);

  logAction(req, "delete", "role", { id, label: removed.name });

  res.json({ success: true, message: "Role deleted" });
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
