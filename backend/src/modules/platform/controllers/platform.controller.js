const platformService = require("../services/platform.service");
const { logFor } = require("../../../utils/audit");
const v = require("../../../utils/validate");

// Every platform action is written to the activity log of the restaurant it
// was done to, under the platform owner's name, so the restaurant's own owner
// can see "switched off by the platform" or "admin password reset".
const logPlatform = (req, restaurantId, action, entityType, entity) =>
  logFor({ restaurantId, userId: req.user.id, userName: `${req.user.name} (platform)` }, action, entityType, entity);

const list = async (req, res) => {
  const q = req.query;

  res.json({
    success: true,
    data: await platformService.list(req.user, {
      status: q.status ? v.requiredEnum(q.status, "Status", ["active", "inactive"]) : null,
      search: v.optionalString(q.search, "Search", 100),
      limit: v.optionalNumber(q.limit, "Limit", { min: 1, max: 200 }) ?? 50,
      offset: v.optionalNumber(q.offset, "Offset", { min: 0, max: 10000000 }) ?? 0,
    }),
  });
};

const create = async (req, res) => {
  const body = req.body || {};
  const admin = body.admin || {};

  const created = await platformService.create(req.user, {
    name: v.requiredString(body.name, "Restaurant name", 150),
    code: v.requiredString(body.code, "Restaurant code", 30),
    contact: v.optionalString(body.contact, "Phone", 20),
    email: body.email ? v.requiredEmail(body.email, "Restaurant email") : null,
    address: v.optionalString(body.address, "Address", 500),
    timezone: v.optionalString(body.timezone, "Time zone", 60) || "Asia/Kolkata",
    invoicePrefix: v.optionalString(body.invoicePrefix, "Bill prefix", 10) || "INV",
    orderPrefix: v.optionalString(body.orderPrefix, "Order prefix", 10) || "ORD",
    admin: {
      name: v.requiredString(admin.name, "Admin's name", 150),
      email: v.requiredEmail(admin.email, "Admin's email"),
      mobile: v.optionalString(admin.mobile, "Admin's mobile", 20),
      password: v.requiredPassword(admin.password, "Admin's password"),
    },
  });

  logPlatform(req, created.id, "create", "restaurant", {
    id: created.id,
    label: created.name,
    details: { code: created.code, firstAdmin: String(admin.email).trim().toLowerCase(), defaults: created.defaults },
  });

  res.status(201).json({
    success: true,
    message: `${created.name} is set up. Its admin can sign in now with ${String(admin.email).trim().toLowerCase()}.`,
    data: created,
  });
};

const setStatus = async (req, res) => {
  const id = v.requiredId(req.params.id, "Restaurant id");
  const status = v.requiredEnum((req.body || {}).status, "Status", ["active", "inactive"]);
  const { before, after } = await platformService.setStatus(req.user, id, status);

  logPlatform(req, id, status === "active" ? "switch_on" : "switch_off", "restaurant", {
    id,
    label: after.name,
    details: { changes: { status: [before.status, after.status] } },
  });

  res.json({
    success: true,
    message:
      status === "active"
        ? `${after.name} is on again. Its staff can sign in.`
        : `${after.name} is switched off. Its staff are told their restaurant is not active.`,
    data: after,
  });
};

const admins = async (req, res) => {
  res.json({ success: true, data: await platformService.admins(req.user, v.requiredId(req.params.id, "Restaurant id")) });
};

const resetAdminPassword = async (req, res) => {
  const id = v.requiredId(req.params.id, "Restaurant id");
  const body = req.body || {};
  const { restaurant, admin } = await platformService.resetAdminPassword(
    req.user,
    id,
    v.requiredId(body.userId, "Admin"),
    v.requiredPassword(body.password, "New password")
  );

  logPlatform(req, id, "reset_password", "user", {
    id: admin.id,
    label: admin.name,
    details: { by: "platform", otherSessionsEnded: true },
  });

  res.json({
    success: true,
    message: `New password set for ${admin.name} at ${restaurant.name}. They were signed out everywhere.`,
    data: { id: admin.id, name: admin.name },
  });
};

module.exports = {
  list,
  create,
  setStatus,
  admins,
  resetAdminPassword,
};
