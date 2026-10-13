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

// Every other business type: create one for a customer (with its owner's
// login), switch it off and on, and reset its owner's password.
const onboarding = require("../../business/core/services/businessOnboarding.service");
const send = (res, data, status = 200) => res.status(status).json({ success: true, data });
router.get("/businesses", async (req, res) => send(res, await onboarding.platformList(req.user, req.query)));
router.post("/businesses", async (req, res) => send(res, await onboarding.platformCreate(req.user, req.body || {}), 201));
router.put("/businesses/:id/status", async (req, res) => send(res, await onboarding.platformSetStatus(req.user, req.params.id, req.body || {})));
router.post("/businesses/:id/owner-password", async (req, res) => send(res, await onboarding.platformResetOwnerPassword(req.user, req.params.id, req.body || {})));

module.exports = router;
