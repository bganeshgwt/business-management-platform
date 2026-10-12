// The platform console, mounted at /api/users/platform (see user.routes.js).
//
// For the platform's own super admin only: platform.restaurants.manage, held
// by the Super Admin role, which no restaurant can hand out. A restaurant's
// users get 403 here, and the service refuses anyone tied to a restaurant.
const express = require("express");
const platformController = require("../controllers/platform.controller");
const authorize = require("../../../middlewares/authorize");

const router = express.Router();

router.use(authorize("platform.restaurants.manage"));

router.get("/restaurants", platformController.list);
router.post("/restaurants", platformController.create);
router.put("/restaurants/:id/status", platformController.setStatus);
router.get("/restaurants/:id/admins", platformController.admins);
router.post("/restaurants/:id/admin-password", platformController.resetAdminPassword);

module.exports = router;
