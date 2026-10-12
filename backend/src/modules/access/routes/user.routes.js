const express = require("express");
const userController = require("../controllers/user.controller");
const authenticate = require("../../../middlewares/authenticate");
const authorize = require("../../../middlewares/authorize");
const platformRoutes = require("../../platform/routes/platform.routes");

const router = express.Router();

router.use(authenticate);

// The platform console: every restaurant on the platform, for the platform's
// own super admin (see platform.routes.js).
router.use("/platform", platformRoutes);

// Fixed paths come before "/:id" so they are not read as user ids.

// Who did what: the activity log an owner (or a manager with audit.view)
// reads for voids, refunds, price changes and approvals.
router.get("/activity-log", authorize("audit.view"), userController.activityLog);
router.get("/activity-log/facets", authorize("audit.view"), userController.activityFacets);
// The "Staff member" picker's search (?q=ravi).
router.get("/activity-log/people", authorize("audit.view"), userController.activityPeople);
// Export CSV: every row the filters match, page by page (never cut short).
router.get("/activity-log/export", authorize("audit.view"), userController.activityLogExport);

// How a shared till behaves: lock after this many idle minutes.
router.get("/access-settings", authorize("users.view"), userController.getAccessSettings);
router.put("/access-settings", authorize("users.manage"), userController.saveAccessSettings);
// Which roles must use two-step sign-in.
router.put("/two-factor-roles", authorize("users.manage"), userController.saveTwoFactorRoles);

router.get("/", authorize("users.view"), userController.list);
router.get("/:id", authorize("users.view"), userController.getById);
router.get("/:id/sign-ins", authorize("users.view"), userController.signIns);
router.post("/", authorize("users.manage"), userController.create);
router.put("/:id", authorize("users.manage"), userController.update);
router.patch("/:id/password", authorize("users.manage"), userController.resetPassword);
router.put("/:id/pin", authorize("users.manage"), userController.setPin);
router.delete("/:id/pin", authorize("users.manage"), userController.clearPin);
router.post("/:id/sign-out", authorize("users.manage"), userController.signOut);
router.post("/:id/unlock", authorize("users.manage"), userController.unlock);
router.post("/:id/two-factor/reset", authorize("users.manage"), userController.resetTwoFactor);

module.exports = router;
