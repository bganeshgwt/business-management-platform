// Wastage log and reorder suggestions.
const express = require("express");
const inventoryInsightController = require("../controllers/inventoryInsight.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const AppError = require("../../../../utils/AppError");
const writeoffApproval = require("../../../../middlewares/writeoffApproval");

const router = express.Router();

router.use(authenticate);
router.use(requireFeature("stock_recipes"));
// Which outlet the request works in, from the user or the switcher: waste is
// taken off that outlet's own shelf when it keeps one.
router.use(resolveOutlet);

// Either permission will do. inventory.manage could already write waste off
// through Stock out; inventory.waste lets the kitchen log it without being able
// to change stock any other way.
const canLogWaste = (req, res, next) => {
  const granted = req.user?.permissions || [];

  if (!granted.includes("inventory.waste") && !granted.includes("inventory.manage")) {
    throw new AppError(403, "You do not have permission to perform this action");
  }

  next();
};

// The figures a dashboard shows from this module.
router.get("/summary", authorize("inventory.view"), inventoryInsightController.summary);

// Wastage. Over the write-off limit (Stock → Stock & purchasing settings) an entry
// needs "Approve large write-offs" or a manager's PIN; every check is made
// before the PIN is asked for. The screens use the item's own address, which
// ties a manager's approval to that item as well as to the quantity and value.
const wasteApproval = writeoffApproval(inventoryInsightController.prepareWastage);
router.get("/wastage", authorize("inventory.view"), inventoryInsightController.wastage);
router.get("/wastage/entries", authorize("inventory.view"), inventoryInsightController.wastageEntries);
router.post("/wastage", canLogWaste, wasteApproval, inventoryInsightController.logWastage);
router.post("/items/:itemId/wastage", canLogWaste, wasteApproval, inventoryInsightController.logWastage);
// Undoing an entry puts stock back, which is a stock adjustment: managers only.
router.post(
  "/wastage/:id/reverse",
  authorize("inventory.manage"),
  inventoryInsightController.reverseWastage
);

// Dish wasted: a finished dish written off by its recipe (dropped, remade,
// spoiled, a quality complaint). The same people who log waste log a dish,
// under the same write-off limit; undoing one is a manager's.
const dishWaste = require("../controllers/dishWaste.controller");
router.get("/dish-waste/options", authorize("inventory.view"), dishWaste.pickable);
router.get("/dish-waste", authorize("inventory.view"), dishWaste.list);
router.post("/dish-waste", canLogWaste, writeoffApproval(dishWaste.prepare), dishWaste.log);
router.get("/dish-waste/:id", authorize("inventory.view"), dishWaste.get);
router.post("/dish-waste/:id/reverse", authorize("inventory.manage"), dishWaste.reverse);

// Write-offs and approvals by person: the stock side of theft control.
router.get("/control", authorize("audit.view"), async (req, res) => {
  const inventoryService = require("../services/inventory.service");
  const writeoffControl = require("../services/writeoffControl.service");
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const from = req.query.from && DATE.test(req.query.from) ? req.query.from : null;
  const to = req.query.to && DATE.test(req.query.to) ? req.query.to : null;

  if ((req.query.from && !from) || (req.query.to && !to)) {
    throw new AppError(400, "Dates must look like 2026-10-02");
  }

  // The outlet the request works in (tied to it or picked in the switcher):
  // its own store's waste only, or the main store's when it sells from it.
  const store = req.outletId ? await inventoryService.pinnedStore(req.user.restaurantId, req.outletId) : null;

  res.json({ success: true, data: await writeoffControl.control(req.user.restaurantId, { from, to }, { store }) });
});

// Reorder suggestions, and turning them into a draft purchase order.
router.get("/reorder", authorize("inventory.view"), inventoryInsightController.reorder);
router.post(
  "/reorder/draft-orders",
  authorize("inventory.view", "purchasing.manage"),
  inventoryInsightController.createDraftOrder
);

module.exports = router;
