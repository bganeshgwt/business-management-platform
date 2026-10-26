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

// Requires "Authorization: Bearer <token>" and sets req.user, including
// req.user.restaurantId which every tenant-scoped query must filter by.
//
// Someone whose password was set by someone else (a new login, a reset) is
// refused here with 403 password_change_required until they choose their
// own, so no route can forget it. Only the routes that choosing it needs take
// authenticate.duringPasswordChange instead: who am I, and changing the
// password. Signing out needs no request: the screen forgets its token.
const authenticate = async (req, res, next) => {
  req.user = await signedIn(req);

  if (req.user.passwordChangeRequired) {
    throw new AppError(
      403,
      "Choose a password of your own before you carry on. The one you signed in with was set by someone else.",
      { reason: "password_change_required" }
    );
  }

  next();
};

authenticate.duringPasswordChange = async (req, res, next) => {
  req.user = await signedIn(req);
  next();
};

module.exports = authenticate;
