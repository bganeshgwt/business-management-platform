const AppError = require("../utils/AppError");

// Use after authenticate. The user must have every listed permission.
// Example: router.get("/users", authenticate, authorize("users.view"), controller.list)
const authorize = (...requiredPermissions) => (req, res, next) => {
  const granted = req.user?.permissions || [];
  const allowed = requiredPermissions.every((permission) => granted.includes(permission));

  if (!allowed) {
    throw new AppError(403, "You do not have permission to perform this action");
  }

  next();
};

module.exports = authorize;
