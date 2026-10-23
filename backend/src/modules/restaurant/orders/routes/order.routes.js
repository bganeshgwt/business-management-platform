const express = require("express");
const orderController = require("../controllers/order.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");

const router = express.Router();

router.use(authenticate);
// Settles which outlet this request works in, from the user or the switcher.
router.use(resolveOutlet);
router.param('id',async(req,res,next,id)=>{
  try {
    require('../../../../utils/validate').requiredId(id, 'Order id');
    if(req.outletId){
      const order=await require('../repositories/order.repository').findById(req.user.restaurantId,id);
      if(!order || Number(order.outlet_id)!==Number(req.outletId))throw new (require('../../../../utils/AppError'))(404,'Order not found in this outlet');
    }
    next();
  }catch(error){next(error);}
});

router.get("/", authorize("orders.view"), orderController.list);
// Named paths before "/:id", which would otherwise read them as an order id.
// The happy-hour prices running now at this till's outlet, for the POS.
router.get("/offers", authorize("orders.view"), orderController.offers);
// Whether a business day is open, for everyone who takes orders.
router.get("/day", authorize("orders.view"), orderController.serviceDay);
// The open outlets by name, for the till's "which outlet is this sale for?"
// — asked of everyone who takes orders, not only those who may open Outlets.
router.get("/outlets", authorize("orders.create"), orderController.saleOutlets);
// Dishes taken off after the kitchen had them: the owner's theft report. It
// names who took what off, so it is read like the activity log (audit.view:
// owners and managers), not like the sales reports a cashier may see.
router.get("/cancellations", authorize("audit.view"), orderController.cancellations);
// The guest behind a mobile typed at the till: name, visits, points. Anyone
// taking orders may ask, captains included; only a whole, valid number is
// looked up, never part of one.
router.get("/guest", requireFeature("guests"), authorize("orders.create"), orderController.lookupGuest);
// Tables joined to a party still here (order open, or billed and unpaid),
// so the till draws them as that party's, not as free.
router.get("/joined-tables", authorize("orders.view"), orderController.joinedTables);
// The collection screen by the counter: token numbers being made and ready.
// A TV signs in with the Collection display role, which has only this.
router.get("/collection", authorize("orders.collection"), orderController.collectionBoard);
// The service desk's settings (token numbers and the others kept with them).
router.use("/service-settings", require("../../setup/routes/serviceSettings.routes"));
router.get("/:id", authorize("orders.view"), orderController.getById);
// Where an order has moved: tables changed, tables joined, dishes moved.
router.get("/:id/moves", authorize("orders.view"), orderController.moves);
router.post("/", authorize("orders.create"), orderController.create);
// Guests moving on the floor. Everyone who takes orders does this (captains
// most of all); every move is in the activity log and the order's history,
// and no move changes what anything costs.
router.post("/:id/move-table", authorize("orders.create"), orderController.moveTable);
router.post("/:id/join-table", authorize("orders.create"), orderController.joinTable);
router.post("/:id/unjoin-table", authorize("orders.create"), orderController.unjoinTable);
router.post("/:id/move-dishes", authorize("orders.create"), orderController.moveDishes);
// Saving a change from the POS. Taking off a dish the kitchen already has
// also needs orders.cancel_after_kot or a manager's PIN, checked inside.
router.put("/:id/items", authorize("orders.create"), orderController.updateItems);
router.post("/:id/courses/:courseNo/fire", authorize("orders.create"), orderController.fireCourse);
router.patch("/:id/items/:itemId/cancel", authorize("orders.manage"), orderController.cancelItem);
router.patch("/:id/kitchen-status", authorize("kot.manage"), orderController.setKitchenStatus);
router.patch("/:id/cancel", authorize("orders.manage"), orderController.cancel);
// A delivery's trip charge: waiving it takes a manager (or their
// PIN) and a reason; charging it again is anyone's who takes orders.
router.post(
  "/:id/delivery-charge/waive",
  authorize("orders.create"),
  authorizeOrApprove("orders.waive_delivery_charge", { scope: orderController.waiveScope }),
  orderController.waiveDeliveryCharge
);
router.post("/:id/delivery-charge/restore", authorize("orders.create"), orderController.restoreDeliveryCharge);
// A parcel with a token handed over at the counter: it leaves the screen.
router.post("/:id/collected", authorize("orders.create"), orderController.markCollected);

module.exports = router;
