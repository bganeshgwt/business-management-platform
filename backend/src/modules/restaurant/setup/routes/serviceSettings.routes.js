// The service desk's settings, under /api/orders/service-settings (mounted by
// the orders router, which has already signed the user in). Reading them is
// for anyone at the front of house; each part is changed with the permission
// of the work it belongs to.
const express = require("express");
const controller = require("../controllers/serviceSettings.controller");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");

const router = express.Router();

router.get("/", authorize("orders.view"), controller.get);
// Token numbers and the collection screen: how the counter runs.
router.put("/tokens", authorize("orders.manage"), controller.updateTokens);
// The web address table QR codes open: part of setting up the tables.
router.put("/guest-web-address", authorize("tables.manage"), controller.updateWebAddress);
// The restaurant's own online ordering page (SW-A-22): one link per selling
// point. Anyone at the front of house may see and copy a link; opening a
// public channel, its limits and replacing its address is a manager's call,
// as switching QR ordering is (orders.manage).
router.get("/online-ordering", requireFeature("online_ordering"), authorize("orders.view"), controller.listOnlineLinks);
router.put("/online-ordering/:id", requireFeature("online_ordering"), authorize("orders.manage"), controller.updateOnlineLink);
router.post("/online-ordering/:id/new-link", requireFeature("online_ordering"), authorize("orders.manage"), controller.replaceOnlineLink);

module.exports = router;
