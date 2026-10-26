const userService = require("../services/user.service");
const activityLogService = require("../services/activityLog.service");
const { logAction, diff } = require("../../../utils/audit");
const v = require("../../../utils/validate");
const AppError = require("../../../utils/AppError");

const readBody = (body = {}) => ({
  name: v.requiredString(body.name, "Name", 150),
  // Optional: a login can be a mobile number alone (most floor staff have no email).
  email: body.email ? v.requiredEmail(body.email) : null,
  mobile: v.optionalString(body.mobile, "Mobile", 20),
  outletId: v.optionalNumber(body.outletId, "Outlet", { min: 1 }),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive", "locked"], "active"),
  roleIds: [...new Set(v.requiredArray(body.roleIds, "Roles").map((id) => v.requiredId(id, "Role id")))],
});

const readPin = (value) => {
  if (typeof value !== "string" || !/^\d{4,6}$/.test(value)) {
    throw new AppError(400, "The PIN must be 4 to 6 digits");
  }

  return value;
};

const list = async (req, res) => {
  const users = await userService.list(req.user.restaurantId);

  res.json({ success: true, data: users });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");
  const user = await userService.getById(req.user.restaurantId, id);

  res.json({ success: true, data: user });
};

const create = async (req, res) => {
  const data = {
    ...readBody(req.body),
    password: v.requiredPassword(req.body?.password),
  };

  const user = await userService.create(req.user.restaurantId, data, req.user);

  logAction(req, "create", "user", {
    id: user.id,
    label: user.name,
    details: { roles: user.roleNames, email: user.email, mobile: user.mobile, outlet: user.outletName },
  });

  res.status(201).json({ success: true, message: "User created", data: user });
};

// The password is not part of an edit: it has its own endpoint below.
const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");
  const { before, after } = await userService.update(req.user.restaurantId, id, readBody(req.body), req.user);

  // Exactly what changed — roles, status, outlet, contact — before and after.
  logAction(req, "update", "user", {
    id: after.id,
    label: after.name,
    details: { changes: diff(before, after, ["name", "email", "mobile", "status", "outletName", "roleNames"]) },
  });

  res.json({ success: true, message: "User updated", data: after });
};

const resetPassword = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");
  const password = v.requiredPassword(req.body?.password, "New password");

  const target = await userService.resetPassword(req.user.restaurantId, id, password, req.user);

  logAction(req, "reset_password", "user", {
    id,
    label: target.name,
    details: { otherSessionsEnded: true },
  });

  res.json({
    success: true,
    message: `Password updated. ${target.name} was signed out everywhere and chooses their own password at the next sign-in.`,
  });
};

const setPin = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");
  const pin = readPin(req.body?.pin);

  if (req.body?.confirmPin !== undefined && req.body.confirmPin !== pin) {
    throw new AppError(400, "The two PINs do not match");
  }

  const { user, hadPin } = await userService.setPin(req.user.restaurantId, id, pin, req.user);

  logAction(req, hadPin ? "reset" : "create", "user_pin", { id, label: user.name });

  res.json({ success: true, message: `PIN ${hadPin ? "changed" : "set"} for ${user.name}`, data: user });
};

const clearPin = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");
  const user = await userService.clearPin(req.user.restaurantId, id, req.user);

  logAction(req, "delete", "user_pin", { id, label: user.name });

  res.json({ success: true, message: `PIN removed for ${user.name}`, data: user });
};

const signOut = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");
  const user = await userService.signOut(req.user.restaurantId, id, req.user);

  logAction(req, "sign_out_everywhere", "user", { id, label: user.name });

  res.json({ success: true, message: `${user.name} was signed out on every device`, data: user });
};

const unlock = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");
  const user = await userService.unlock(req.user.restaurantId, id, req.user);

  logAction(req, "unlock", "user", { id, label: user.name });

  res.json({ success: true, message: `${user.name} can sign in again`, data: user });
};

const signIns = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");

  res.json({ success: true, data: await userService.signIns(req.user.restaurantId, id) });
};

// An admin switching off someone's two-step sign-in (a lost phone). They are
// signed out everywhere too.
const resetTwoFactor = async (req, res) => {
  const id = v.requiredId(req.params.id, "User id");
  const user = await userService.resetTwoFactor(req.user.restaurantId, id, req.user);

  logAction(req, "reset", "two_factor", {
    id,
    label: user.name,
    details: { otherSessionsEnded: true, requiredByRole: user.twoFactorRequired },
  });

  res.json({
    success: true,
    message: `Two-step sign-in reset for ${user.name}. They were signed out everywhere${
      user.twoFactorRequired ? " and will set it up again at their next sign-in" : ""
    }.`,
    data: user,
  });
};

// Which roles must use two-step sign-in in this restaurant.
const saveTwoFactorRoles = async (req, res) => {
  const body = req.body || {};
  const roleIds = v.requiredArray(body.roleIds, "Roles").map((id) => v.requiredId(id, "Role"));
  const { before, after } = await userService.saveTwoFactorRoles(req.user.restaurantId, roleIds, req.user.id);

  logAction(req, "update", "access_settings", {
    label: "Two-step sign-in",
    details: {
      changes: {
        rolesThatNeedTwoStep: [before.map((role) => role.name).join(", ") || "none", after.map((role) => role.name).join(", ") || "none"],
      },
    },
  });

  res.json({
    success: true,
    message: after.length
      ? `Saved. ${after.map((role) => role.name).join(", ")} must use two-step sign-in from their next sign-in.`
      : "Saved. No role has to use two-step sign-in; anyone can still turn it on for themselves.",
    data: after,
  });
};

const getAccessSettings = async (req, res) => {
  res.json({ success: true, data: await userService.getAccessSettings(req.user.restaurantId) });
};

const saveAccessSettings = async (req, res) => {
  const body = req.body || {};
  const { before, after } = await userService.saveAccessSettings(
    req.user.restaurantId,
    { idleLockMinutes: v.requiredNumber(body.idleLockMinutes, "Lock after (minutes)", { min: 0, max: 240 }) },
    req.user.id
  );

  logAction(req, "update", "access_settings", {
    label: "Till lock",
    details: { changes: diff(before, after, ["idleLockMinutes"]) },
  });

  res.json({ success: true, message: "Saved", data: after });
};

// --- Activity log ---

// The activity log's filters, the same for the page and the export.
// The staff filter holds someone picked from the list; anything else is not
// a person, said as such rather than "between 1 and Infinity".
const readStaffFilter = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const id = Number(value);

  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AppError(400, "Pick the staff member from the list");
  }

  return id;
};

const readActivityFilters = (req) => {
  const q = req.query;

  return {
    from: v.optionalString(q.from, "From", 10),
    to: v.optionalString(q.to, "To", 10),
    userId: readStaffFilter(q.userId),
    entityType: v.optionalString(q.entityType, "Area", 50),
    action: v.optionalString(q.action, "Action", 50),
    sensitive: q.sensitive === "1" || q.sensitive === "true",
    search: v.optionalString(q.search, "Search", 100),
    // Salary changes and payroll money only for those who may see salaries.
    seesSalaries: (req.user.permissions || []).includes("staff.salaries"),
  };
};

const activityLog = async (req, res) => {
  const filters = {
    ...readActivityFilters(req),
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 5000 }) ?? 100,
    offset: v.optionalNumber(req.query.offset, "Offset", { min: 0, max: 10000000 }) ?? 0,
  };

  res.json({ success: true, data: await activityLogService.search(req.user.restaurantId, filters) });
};

// Everything the filters match, a page at a time, for Export CSV: the first
// call (no cursor) also gives the total, then each page names the next.
//
// The cursor is the export's own page marker, handed back by the page before.
// Nobody types it, so one that cannot be read means the export was cut short
// or the address was edited: the message says to start again, instead of the
// generic "Cursor must be between 1 and Infinity".
const readCursor = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const cursor = Number(value);

  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new AppError(
      400,
      "That part of the export could not be found. Close it and press Export CSV again to start from the beginning."
    );
  }

  return cursor;
};

const activityLogExport = async (req, res) => {
  const filters = {
    ...readActivityFilters(req),
    cursor: readCursor(req.query.cursor),
  };

  res.json({ success: true, data: await activityLogService.exportPage(req.user.restaurantId, filters) });
};

// GET /users/activity-log/people?q=ravi: the "Staff member" picker searches
// here instead of loading everyone who ever signed in.
const activityPeople = async (req, res) => {
  const q = v.optionalString(req.query.q, "Search", 100);
  const limit = v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 50 }) ?? 20;

  res.json({ success: true, data: await activityLogService.people(req.user.restaurantId, q ? q.trim() : null, limit) });
};

const activityFacets = async (req, res) => {
  res.json({ success: true, data: await activityLogService.facets(req.user.restaurantId) });
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
  activityLog,
  activityLogExport,
  activityFacets,
  activityPeople,
};
