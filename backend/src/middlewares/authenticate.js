const authService = require("../services/auth.service");
const AppError = require("../utils/AppError");

// Requires "Authorization: Bearer <token>" and sets req.user, including
// req.user.restaurantId which every tenant-scoped query must filter by.
const authenticate = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new AppError(401, "Authentication required");
  }

  req.user = await authService.getUserFromToken(token);
  next();
};

module.exports = authenticate;
