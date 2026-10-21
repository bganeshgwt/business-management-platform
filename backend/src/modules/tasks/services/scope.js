const access = require("../../business/core/services/businessAccess.service");
const restaurantFeatures = require("../../restaurant/setup/services/restaurantFeatures.service");
const AppError = require("../../../utils/AppError");
const repo = require("../repositories/tasks.repository");

// One module, two front doors. Both build the same `scope` and every service
// works only from it:
//
//   restaurant  /api/tasks/…                      the signed-in restaurant's business
//                                                  (businesses.legacy_restaurant_id),
//                                                  restaurant permissions and features
//   business    /api/businesses/:businessId/tasks/…   membership → capability → permission
//
// scope = { world, businessId, businessType, businessName, restaurantId, userId, userName,
//           timezone, outletScope, employeeIds, roleIds, businessRoleId,
//           has(module), can(permission), require(permission), requireModule(module) }

const MODULE_NAMES = { tasks: "Tasks & checklists", issues: "Issues", projects: "Projects" };

const safeZone = (zone) => {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return "Asia/Kolkata";
  }
};

async function forRestaurant(req) {
  const user = req.user;
  if (!user.restaurantId) throw new AppError(403, "Tasks belong to a restaurant or business. This account has none.");
  const info = await repo.one(repo.pool,
    `SELECT restaurant_business_id($1) AS business_id,
            (SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1) AS timezone,
            (SELECT name FROM restaurants WHERE id = $1) AS name,
            COALESCE((SELECT array_agg(id) FROM employees WHERE restaurant_id = $1 AND user_id = $2 AND status = 'active'), '{}') AS employee_ids,
            COALESCE((SELECT array_agg(role_id) FROM user_roles WHERE user_id = $2), '{}') AS role_ids`,
    [user.restaurantId, user.id]);
  const permissions = new Set(user.permissions || []);
  const features = new Set(user.features || []);
  const scope = {
    world: "restaurant",
    businessId: Number(info.business_id),
    businessType: "restaurant",
    businessName: info.name,
    restaurantId: Number(user.restaurantId),
    userId: Number(user.id),
    userName: user.name,
    timezone: safeZone(info.timezone || "Asia/Kolkata"),
    // A login tied to one outlet sees that outlet's records (and whole-restaurant ones).
    outletScope: user.outletId ? Number(user.outletId) : null,
    employeeIds: (info.employee_ids || []).map(Number),
    roleIds: (info.role_ids || []).map(Number),
    businessRoleId: null,
    base: "/tasks",
    has: (module) => features.has(module),
    can: (permission) => features.has(permission.split(".")[0]) && permissions.has(permission),
  };
  scope.requireModule = async (module) => {
    if (!features.has(module)) await restaurantFeatures.assertOn(user, module);
  };
  scope.require = async (permission) => {
    await scope.requireModule(permission.split(".")[0]);
    if (!permissions.has(permission)) throw new AppError(403, "You do not have permission to do this");
  };
  return scope;
}

async function forBusiness(req) {
  const business = await access.load(req.user, req.params.businessId);
  const scope = {
    world: "business",
    businessId: Number(business.id),
    businessType: business.business_type,
    businessName: business.name,
    restaurantId: null,
    userId: Number(req.user.id),
    userName: req.user.name,
    timezone: safeZone(business.timezone || "Asia/Kolkata"),
    // Memberships are not tied to a location today: every location.
    outletScope: null,
    employeeIds: [],
    roleIds: [],
    businessRoleId: Number(business.role_id),
    base: `/business-admin/${business.id}/tasks`,
    has: (module) => business.modules.includes(module),
    can: (permission) => access.can(business, permission),
    business,
  };
  scope.requireModule = async (module) => {
    if (!business.modules.includes(module)) {
      throw new AppError(403, `${MODULE_NAMES[module] || module} is not switched on for this business. An owner can turn it on in Settings › Business tools.`);
    }
  };
  scope.require = (permission) => access.require(business, permission);
  return scope;
}

// Express middleware: req.scope for the rest of the request; the module named
// must be switched on.
const restaurantScope = (module = "tasks") => async (req, res, next) => {
  req.scope = await forRestaurant(req);
  await req.scope.requireModule(module);
  next();
};
const businessScope = (module = "tasks") => async (req, res, next) => {
  req.scope = await forBusiness(req);
  await req.scope.requireModule(module);
  next();
};

module.exports = { forRestaurant, forBusiness, restaurantScope, businessScope, MODULE_NAMES };
