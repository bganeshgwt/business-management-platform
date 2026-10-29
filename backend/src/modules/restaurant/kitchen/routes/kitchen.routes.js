// Kitchen display (KDS) and KOTs.
const express = require("express");
const kitchenController = require("../controllers/kitchen.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const AppError = require("../../../../utils/AppError");

const router = express.Router();

// Any one of the listed permissions will do. authorize() needs all of them,
// which is right for most screens but not here: a captain printing a KOT from
// the till has kot.manage and no kitchen screen, and a wall display that only
// watches has kds.view and no buttons.
const authorizeAny = (...permissions) => (req, res, next) => {
  const granted = req.user?.permissions || [];

  if (!permissions.some((permission) => granted.includes(permission))) {
    throw new AppError(403, "You do not have permission to perform this action");
  }

  next();
};

router.use(authenticate);
// A kitchen in one outlet sees that outlet's tickets.
router.use(resolveOutlet);

// The board. Reading it also cuts any tickets the tills have sent since.
router.get("/board", requireFeature("kitchen_display"), authorize("kds.view"), kitchenController.board);
// The food at the pass, for the waiters who carry it out (the captain app):
// whoever may read an order's tickets, as below. Nothing is cut or cleared.
router.get("/pass", requireFeature("kitchen_display"), authorizeAny("kds.view", "kot.manage"), kitchenController.pass);
router.post("/sync", requireFeature("kitchen_display"), authorizeAny("kds.view", "kot.manage"), kitchenController.sync);
// An earlier day's tickets and their times, read only (the dashboard's
// kitchen panel): the kitchen display's own permission. Nothing is cut.
router.get("/day", requireFeature("kitchen_display"), authorize("kds.view"), kitchenController.day);
router.get(
  "/orders/:orderId/kots",
  authorizeAny("kds.view", "kot.manage"),
  kitchenController.orderTickets
);

// Tickets. "Recall" before "/kots/:id" style routes so it is never read as an id.
router.post("/recall", requireFeature("kitchen_display"), authorize("kot.manage"), kitchenController.recallLast);
// Clearing the board's old tickets in one go is a manager's call: it takes
// the ticket permission and the one for managing orders, which the kitchen
// role does not have.
router.post("/clear-old", requireFeature("kitchen_display"), authorize("kot.manage", "orders.manage"), kitchenController.clearOld);
router.get("/kots/:id", requireFeature("kitchen_display"), authorize("kds.view"), kitchenController.getTicket);
router.patch("/kots/:id/status", requireFeature("kitchen_display"), authorize("kot.manage"), kitchenController.setStatus);
router.patch("/kots/:id/items/:itemId", requireFeature("kitchen_display"), authorize("kot.manage"), kitchenController.setItemDone);
// A dish ticked done, served from the floor on its own: as serving a ticket.
router.post("/kots/:id/items/:itemId/serve", requireFeature("kitchen_display"), authorize("kot.manage"), kitchenController.serveItem);
router.post("/kots/:id/recall", requireFeature("kitchen_display"), authorize("kot.manage"), kitchenController.recallTicket);
router.post("/kots/:id/print", authorizeAny("kds.view", "kot.manage"), kitchenController.recordPrint);

// Change slips (CANCEL / TABLE CHANGED). Whoever changes an order prints its
// slips: the till that saved it (anyone who takes orders), or the kitchen.
router.post(
  "/slips/claim",
  authorizeAny("kds.view", "kot.manage", "orders.create"),
  kitchenController.claimSlips
);
router.get("/slips", authorizeAny("kds.view", "kot.manage", "orders.create"), kitchenController.listSlips);
router.post(
  "/slips/:id/print",
  authorizeAny("kds.view", "kot.manage", "orders.create"),
  kitchenController.printSlip
);

// Stations and routing. Changing where dishes are cooked is a menu decision,
// so it takes the menu permission; reading the setup does not.
router.get("/stations", authorizeAny("kds.view", "menu.manage"), kitchenController.stationSetup);
router.post("/stations", authorize("menu.manage"), kitchenController.createStation);
router.put("/stations/:id", authorize("menu.manage"), kitchenController.updateStation);
router.post("/stations/:id/default", authorize("menu.manage"), kitchenController.makeDefault);
router.put(
  "/category-stations/:categoryId",
  authorize("menu.manage"),
  kitchenController.setCategoryStation
);
router.put(
  "/product-stations/:productId",
  authorize("menu.manage"),
  kitchenController.setProductStation
);
router.get("/products", authorize("menu.manage"), kitchenController.searchProducts);
router.get("/settings", authorizeAny("kds.view", "menu.manage"), kitchenController.getSettings);
router.put("/settings", authorize("menu.manage"), kitchenController.updateSettings);

module.exports = router;
