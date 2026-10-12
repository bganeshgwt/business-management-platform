const express = require("express");
const tableController = require("../controllers/table.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const AppError = require("../../../../utils/AppError");

const router = express.Router();

// The caller needs at least ONE of these permissions. Resetting a table is
// floor work: a manager can do it, and so can the captain or cashier who has
// just cleared it (orders.create), without being given the table setup.
const authorizeAny = (...permissions) => {
  authorize.noteEnforced(...permissions);

  return (req, res, next) => {
    const granted = req.user?.permissions || [];

    if (!permissions.some((permission) => granted.includes(permission))) {
      throw new AppError(403, "You do not have permission to perform this action");
    }

    next();
  };
};

router.use(authenticate);

const captainSectionController = require("../controllers/captainSection.controller");

// Every change to the floor knows which outlet the person works in
// (resolveOutlet): staff tied to one outlet, or with the switcher on one, set
// up that outlet's tables only (table.service, "Working in one outlet").

// Floors
router.get("/floors", authorize("tables.view"), tableController.listFloors);
router.post("/floors", authorize("tables.manage"), resolveOutlet, tableController.createFloor);
router.put("/floors/:id", authorize("tables.manage"), resolveOutlet, tableController.updateFloor);
router.delete("/floors/:id", authorize("tables.manage"), resolveOutlet, tableController.removeFloor);

// Dining areas
router.get("/areas", authorize("tables.view"), tableController.listAreas);
router.post("/areas", authorize("tables.manage"), resolveOutlet, tableController.createArea);
router.put("/areas/:id", authorize("tables.manage"), resolveOutlet, tableController.updateArea);
router.delete("/areas/:id", authorize("tables.manage"), resolveOutlet, tableController.removeArea);

// Floor settings (before "/:id", which would otherwise take "settings" as an id)
router.get("/settings", authorize("tables.view"), tableController.getSettings);
// What a printed QR code carries: the guest pages' web address, and the
// restaurant's name and logo for the card (SW-A-14).
router.get("/qr-settings", requireFeature("qr_ordering"), authorize("tables.view"), tableController.qrSettings);
router.put("/settings", authorize("tables.manage"), resolveOutlet, tableController.updateSettings);

// Tables
// The floor plan follows the outlet the person works in (resolveOutlet).
// Captain sections (SW-A-20): who has which floor, section or table on a
// business date. Everyone on the floor reads the plan; managers make it.
router.get("/sections", requireFeature("captain_sections"), authorize("tables.view"), resolveOutlet, captainSectionController.plan);
router.put("/sections", requireFeature("captain_sections"), authorize("tables.manage"), resolveOutlet, captainSectionController.save);
router.post("/sections/copy", requireFeature("captain_sections"), authorize("tables.manage"), resolveOutlet, captainSectionController.copy);

router.get("/", authorize("tables.view"), resolveOutlet, tableController.listTables);
router.post("/", authorize("tables.manage"), resolveOutlet, tableController.createTable);
router.put("/:id", authorize("tables.manage"), resolveOutlet, tableController.updateTable);
router.patch("/:id/qr", authorize("tables.manage"), resolveOutlet, tableController.regenerateQr);
// Seeing the floor is needed to reset a table on it; then either permission.
router.patch(
  "/:id/ready",
  authorize("tables.view"),
  authorizeAny("tables.manage", "orders.create"),
  resolveOutlet,
  tableController.markReady
);
router.delete("/:id", authorize("tables.manage"), resolveOutlet, tableController.removeTable);

module.exports = router;
