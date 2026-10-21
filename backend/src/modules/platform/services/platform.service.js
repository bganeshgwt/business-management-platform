const bcrypt = require("bcrypt");

const platformRepository = require("../repositories/platform.repository");
const restaurantService = require("../../restaurant/setup/services/restaurant.service");
const twoFactorRepository = require("../../access/repositories/twoFactor.repository");
const { BCRYPT_ROUNDS } = require("../../access/services/auth.service");
const AppError = require("../../../utils/AppError");

// The platform console, for the platform's own super admin: every restaurant
// on the platform, adding one (with everything a new restaurant starts with
// and its first admin), switching one off and on again, and giving a
// restaurant's admin a new password when they are locked out of their own
// restaurant. Nothing here shows a restaurant's bills, guests or sales.

const STATUS_WORDS = { active: "Active", inactive: "Switched off" };

// Only the platform's own accounts: a restaurant's user never runs the
// platform, whatever role they are given.
const requirePlatformUser = (user) => {
  if (user.restaurantId) {
    throw new AppError(403, "The platform console is for the platform's own accounts, not a restaurant's");
  }
};

const toRestaurant = (row) => ({
  id: row.id,
  name: row.name,
  code: row.code,
  status: row.status,
  statusLabel: STATUS_WORDS[row.status] || row.status,
  contact: row.contact || null,
  email: row.email || null,
  outlets: Number(row.outlets || 0),
  users: Number(row.users || 0),
  activeUsers: Number(row.active_users || 0),
  lastActivity: row.last_activity || null,
  createdAt: row.created_at,
});

const list = async (user, filters) => {
  requirePlatformUser(user);

  const [rows, counts] = await Promise.all([platformRepository.findRestaurants(filters), platformRepository.countByStatus()]);

  return {
    items: rows.map(toRestaurant),
    total: rows.length ? Number(rows[0].total) : 0,
    limit: filters.limit,
    offset: filters.offset,
    counts,
  };
};

// A new restaurant, set up the supported way: GST rates, settings, delivery
// channels, the kitchen's catch-all station and its first Restaurant Admin,
// in one transaction (restaurant.service createRestaurant).
const create = async (user, data) => {
  requirePlatformUser(user);
  const { format = "restaurant", ...rest } = data;
  const created = await restaurantService.createRestaurant(rest);

  // A café, bakery or cloud kitchen starts with its format's setup.
  if (format !== "restaurant") {
    await require("../../restaurant/setup/services/restaurantFormat.service").apply(created.id, format, { id: user.id, name: user.name });
  }

  return { ...created, format };
};

const findRestaurant = async (id) => {
  const restaurant = await platformRepository.findRestaurant(id);

  if (!restaurant) {
    throw new AppError(404, "Restaurant not found");
  }

  return restaurant;
};

// Switched off, every login of that restaurant is refused with "Your
// restaurant is not active" (open screens on their next request).
const setStatus = async (user, id, status) => {
  requirePlatformUser(user);

  const before = await findRestaurant(id);

  if (before.status === status) {
    throw new AppError(409, `${before.name} is already ${status === "active" ? "on" : "switched off"}`);
  }

  return { before, after: await platformRepository.setStatus(id, status, user.id) };
};

const admins = async (user, id) => {
  requirePlatformUser(user);

  const restaurant = await findRestaurant(id);
  const rows = await platformRepository.findAdmins(id);

  return {
    restaurant,
    admins: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      mobile: row.mobile,
      status: row.status,
      lastLoginAt: row.last_login_at,
      locked: Boolean(row.login_locked_until && new Date(row.login_locked_until) > new Date()),
    })),
  };
};

// A new password for one of the restaurant's admins (the owner who forgot
// theirs). Their sessions end, a lockout is lifted, and their 30-day
// two-step trust ends; two-step itself stays on.
const resetAdminPassword = async (user, id, adminId, password) => {
  requirePlatformUser(user);

  const restaurant = await findRestaurant(id);
  const list = await platformRepository.findAdmins(id);
  const admin = list.find((row) => Number(row.id) === Number(adminId));

  if (!admin) {
    throw new AppError(404, `That person is not an admin of ${restaurant.name}`);
  }

  const updated = await platformRepository.resetPassword(id, admin.id, await bcrypt.hash(password, BCRYPT_ROUNDS), user.id);
  await twoFactorRepository.endDeviceTrust(admin.id);

  return { restaurant, admin: updated };
};

module.exports = {
  list,
  create,
  setStatus,
  admins,
  resetAdminPassword,
};
