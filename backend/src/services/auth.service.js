const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const config = require("../config/env");
const userRepository = require("../repositories/user.repository");
const AppError = require("../utils/AppError");

// Compared against when the email is unknown, so a missing user takes as long
// as a wrong password and response time does not reveal which emails exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("dummy-password-for-timing", 12);

const toProfile = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  mobile: user.mobile,
  restaurantId: user.restaurant_id,
  restaurantName: user.restaurant_name,
  outletId: user.outlet_id,
  roles: user.roles,
  permissions: user.permissions,
});

// Throws if the user, or the restaurant they belong to, may not use the system.
const assertUserCanAccess = (user) => {
  if (user.status !== "active") {
    throw new AppError(403, "Your account is not active");
  }

  if (user.restaurant_id && user.restaurant_status !== "active") {
    throw new AppError(403, "Your restaurant is not active");
  }
};

const login = async (email, password) => {
  const user = await userRepository.findByEmail(email);
  const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);

  if (!user || !passwordMatches) {
    throw new AppError(401, "Invalid email or password");
  }

  assertUserCanAccess(user);

  const token = jwt.sign(
    { restaurantId: user.restaurant_id },
    config.jwt.secret,
    { subject: String(user.id), expiresIn: config.jwt.expiresIn }
  );

  await userRepository.updateLastLogin(user.id);
  const profile = await userRepository.findProfileById(user.id);

  return { token, user: toProfile(profile) };
};

// Called on every protected request: the token only proves who the user is,
// while status, roles and permissions are always read fresh from the database.
const getUserFromToken = async (token) => {
  let payload;

  try {
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ["HS256"] });
  } catch {
    throw new AppError(401, "Invalid or expired token");
  }

  const user = await userRepository.findProfileById(payload.sub);

  if (!user) {
    throw new AppError(401, "Invalid or expired token");
  }

  assertUserCanAccess(user);

  return toProfile(user);
};

module.exports = {
  login,
  getUserFromToken,
};
