// Deliveries, riders and sales channels.
//
// Reading the board is part of taking orders, so it needs orders.view; moving
// food along (accept, ready, dispatch, delivered, cancel) and editing the
// address or rider need orders.manage, the same permission that cancels an
// order. What a channel costs is a business decision (restaurant settings),
// and the money report is a report.
const express = require("express");
const deliveryController = require("../controllers/delivery.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");
const riderSettlementController = require("../controllers/riderSettlement.controller");
const AppError = require("../../../../utils/AppError");
const deliveryRepository = require("../repositories/delivery.repository");

const router = express.Router();

router.use(authenticate);
// A dispatch desk in one outlet sees that outlet's deliveries and riders.
router.use(resolveOutlet);

// ...and may open or move only those. Another outlet's delivery is "not
// found in this outlet", exactly as another outlet's order is (order.routes).
router.param("orderId", async (req, res, next, id) => {
  try {
    if (req.outletId && /^\d{1,16}$/.test(String(id))) {
      const row = await deliveryRepository.findById(req.user.restaurantId, Number(id));

      if (!row || Number(row.outlet_id) !== Number(req.outletId)) {
        throw new AppError(404, "Order not found in this outlet");
      }
    }

    next();
  } catch (error) {
    next(error);
  }
});

// Named routes first, so none of them is ever read as an order id.
// Everything here is the Deliveries feature except the sales channels
// (Swiggy, Zomato, own website), which also price dine-in and takeaway menus.
router.use((req, res, next) => (req.path.startsWith("/channels") ? next() : requireFeature("deliveries")(req, res, next)));

router.get("/board", authorize("orders.view"), deliveryController.board);
// Just the figures, for the dashboard.
router.get("/summary", authorize("orders.view"), deliveryController.summary);
router.post("/dispatch", authorize("orders.manage"), deliveryController.dispatchRun);
// The channel money report (gross, commission, net) is takings: it needs
// sales.view as well as reports.view.
router.get("/report", authorize("reports.view", "sales.view"), deliveryController.report);

// Rider cash settlement: a rider's delivered, unpaid bills paid in
// one step by whoever takes payments; a shortfall written off needs a
// manager (or their PIN). The day's settlements and riders' dues.
router.get(
  "/riders/:riderId/settlement",
  authorize("orders.manage"),
  authorize("payments.manage"),
  riderSettlementController.preview
);
router.post(
  "/riders/:riderId/settle",
  authorize("orders.manage"),
  authorize("payments.manage"),
  riderSettlementController.settle
);
router.post(
  "/riders/:riderId/settle-write-off",
  authorize("orders.manage"),
  authorize("payments.manage"),
  authorizeOrApprove("deliveries.write_off_shortfall", { scope: riderSettlementController.writeOffScope }),
  riderSettlementController.settleWriteOff
);
router.get("/rider-settlements", authorize("payments.manage"), riderSettlementController.report);
router.post("/rider-settlements/:id/repaid", authorize("payments.manage"), riderSettlementController.markRepaid);

router.get("/channels", authorize("orders.view"), deliveryController.listChannels);
router.post("/channels", authorize("restaurant.settings.manage"), deliveryController.createChannel);
router.put("/channels/:id", authorize("restaurant.settings.manage"), deliveryController.updateChannel);
router.delete(
  "/channels/:id",
  authorize("restaurant.settings.manage"),
  deliveryController.removeChannel
);

// One delivery order. PATCH takes any of address, landmark, channelId,
// riderId, partnerRiderName, externalRef, etaMinutes, customerName and
// customerMobile — the POS sends whichever it knows after placing the order.
router.get("/:orderId", authorize("orders.view"), deliveryController.getOne);
router.patch("/:orderId", authorize("orders.manage"), deliveryController.updateDetails);
router.patch("/:orderId/status", authorize("orders.manage"), deliveryController.changeStatus);

module.exports = router;
