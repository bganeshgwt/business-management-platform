const authService = require("../modules/access/services/auth.service");
const AppError = require("../utils/AppError");

// The person the "Authorization: Bearer <token>" header names, read fresh
// from the database.
const signedIn = async (req) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new AppError(401, "Authentication required");
  }

  return authService.getUserFromToken(token);
};

const passwordRefused = () =>
  new AppError(
    403,
    "Choose a password of your own before you carry on. The one you signed in with was set by someone else.",
    { reason: "password_change_required" }
  );

const pinRefused = () =>
  new AppError(
    403,
    "Choose a PIN of your own before you carry on. The PIN this till was switched with was set by someone else.",
    { reason: "pin_change_required" }
  );

// Requires "Authorization: Bearer <token>" and sets req.user, including
// req.user.restaurantId which every tenant-scoped query must filter by.
//
// Someone whose password was set by someone else (a new login, a reset) is
// refused here with 403 password_change_required until they choose their
// own, so no route can forget it. Only the routes that choosing it needs take
// authenticate.duringPasswordChange instead: who am I, and changing the
// password. Signing out needs no request: the screen forgets its token.
//
// A session a shared till opened with a PIN someone else set is refused the
// same way (403 pin_change_required) until the person chooses their own PIN:
// authenticate.duringPinChange lets through only what that needs (setting it,
// and the till's own lock screen), and who am I.
const authenticate = async (req, res, next) => {
  req.user = await signedIn(req);

  if (req.user.passwordChangeRequired) {
    throw passwordRefused();
  }

  if (req.user.pinChangeRequired) {
    throw pinRefused();
  }

  next();
};

authenticate.duringPasswordChange = async (req, res, next) => {
  req.user = await signedIn(req);
  next();
};

authenticate.duringPinChange = async (req, res, next) => {
  req.user = await signedIn(req);

  if (req.user.passwordChangeRequired) {
    throw passwordRefused();
  }

  next();
};

module.exports = authenticate;
