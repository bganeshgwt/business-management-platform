const fs = require("fs");
const path = require("path");
const AppError = require("../utils/AppError");

// Every permission code something checks, so the role editor can flag one
// that nothing checks yet: giving or taking it away would change nothing,
// and an owner trimming a role should know that.
//
// Two sources. Routes register what they pass to authorize() and
// authorizeOrApprove() as the app loads. Some modules check a permission
// inside a handler instead (req.user.permissions.includes("...")), so the
// backend's own code is also read once for quoted permission codes. Files
// that only NAME permissions (the approval prompt's wording, the role editor
// itself) are left out of that read.
const enforced = new Set();
const NAMES_ONLY = new Set(["approval.service.js", "role.service.js", "authorize.js"]);
// Read at any depth: each module keeps its routes, controllers, services and
// repositories under modules/<module>/ (and a split file's parts in a folder
// next to it, e.g. services/report/).
const SOURCE_DIRS = ["routes", "middlewares", "modules"];
let mentioned = null;

const readSource = () => {
  const found = new Set();
  const root = path.join(__dirname, "..");

  const read = (dir) => {
    let entries = [];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        read(full);
        continue;
      }

      if (!entry.name.endsWith(".js") || NAMES_ONLY.has(entry.name)) {
        continue;
      }

      const text = fs.readFileSync(full, "utf8");

      for (const match of text.matchAll(/["'`]([a-z_]+(?:\.[a-z_]+){1,2})["'`]/g)) {
        found.add(match[1]);
      }
    }
  };

  for (const dir of SOURCE_DIRS) {
    read(path.join(root, dir));
  }

  return found;
};

// Use after authenticate. The user must have every listed permission.
// Example: router.get("/users", authenticate, authorize("users.view"), controller.list)
const authorize = (...requiredPermissions) => {
  requiredPermissions.forEach((permission) => enforced.add(permission));

  return (req, res, next) => {
    const granted = req.user?.permissions || [];
    const allowed = requiredPermissions.every((permission) => granted.includes(permission));

    if (!allowed) {
      throw new AppError(403, "You do not have permission to perform this action");
    }

    next();
  };
};

// The user must have at least one of the listed permissions. Example: punch
// photos are for whoever reads the staff records or manages them.
authorize.any = (...permissions) => {
  permissions.forEach((permission) => enforced.add(permission));

  return (req, res, next) => {
    const granted = req.user?.permissions || [];

    if (!permissions.some((permission) => granted.includes(permission))) {
      throw new AppError(403, "You do not have permission to perform this action");
    }

    next();
  };
};

// For a permission checked inside a controller or service rather than on the
// route (for example "may see salaries", which only hides fields).
authorize.noteEnforced = (...permissions) => permissions.forEach((permission) => enforced.add(permission));

authorize.isEnforced = (permission) => {
  if (enforced.has(permission)) {
    return true;
  }

  if (!mentioned) {
    mentioned = readSource();
  }

  return mentioned.has(permission);
};

module.exports = authorize;
