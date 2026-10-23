const express = require("express");
const inventoryController = require("../controllers/inventory.controller");
const recipeController = require("../../menu/controllers/recipe.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const writeoffApproval = require("../../../../middlewares/writeoffApproval");
const stockSettingsController = require("../controllers/stockSettings.controller");

const router = express.Router();

// Any one of these: the screens that act on the limits read them.
// Any one of these permissions will do (authorize.any also tells the role
// editor that each of them is checked).
const anyOf = (...codes) => authorize.any(...codes);

// Stock out over the write-off limit needs "Approve large write-offs" or a
// manager's PIN, asked for only after every other check has passed.
const stockOutApproval = writeoffApproval(inventoryController.prepareStockOut);

router.use(authenticate);
router.use(requireFeature("stock_recipes"));
// Settles which outlet this request works in, from the user or the switcher.
router.use(resolveOutlet);
router.get("/batches", authorize("inventory.view"), require("../controllers/batch.controller").list);

// Stock → Stock & purchasing settings: approval limits and how transfers are received.
router.get(
  "/settings",
  anyOf("inventory.view", "purchasing.view", "restaurant.settings.view"),
  stockSettingsController.get
);
router.put("/settings", authorize("restaurant.settings.manage"), stockSettingsController.save);
router.get("/production", authorize("inventory.view"), require("../controllers/advancedInventory.controller").listProduction);
router.post("/production", authorize("inventory.manage"), require("../controllers/advancedInventory.controller").produce);
router.post("/production/:id/void", authorize("inventory.manage"), require("../controllers/advancedInventory.controller").voidProduction);

// Units (kg, litre, piece)
router.get("/units", authorize("inventory.view"), inventoryController.listUnits);
router.post("/units", authorize("inventory.manage"), inventoryController.createUnit);
router.put("/units/:id", authorize("inventory.manage"), inventoryController.updateUnit);
router.delete("/units/:id", authorize("inventory.manage"), inventoryController.removeUnit);

// Stores: the main store and the outlets that keep their own stock
router.get("/stores", authorize("inventory.view"), inventoryController.listStores);
router.put("/stores/:outletId", authorize("inventory.manage"), inventoryController.setOwnStore);

// Stock movements ("/movements" is listed before "/items/:id" style paths)
router.get("/movements", authorize("inventory.view"), inventoryController.listMovements);
router.post("/movements/in", authorize("inventory.manage"), inventoryController.stockIn);
router.post("/movements/out", authorize("inventory.manage"), stockOutApproval, inventoryController.stockOut);
router.post("/movements/transfer", authorize("inventory.manage"), inventoryController.transfer);

// Transfer notes between stores (many items on one numbered challan), and
// indents: an outlet asking the main store for stock. Sending, receiving and
// calling a note back change stock; asking for stock is everyday kitchen work.
const transfers = require("../controllers/stockTransfer.controller");
router.get("/transfers", authorize("inventory.view"), transfers.listTransfers);
router.post("/transfers", authorize("inventory.manage"), transfers.dispatch);
router.get("/transfers/:id", authorize("inventory.view"), transfers.getTransfer);
router.post("/transfers/:id/receive", authorize("inventory.manage"), transfers.receive);
router.post("/transfers/:id/cancel", authorize("inventory.manage"), transfers.cancel);
router.get("/indents", authorize("inventory.view"), transfers.listIndents);
router.post("/indents", authorize("inventory.view"), anyOf("inventory.indent", "inventory.manage"), transfers.createIndent);
router.get("/indents/:id", authorize("inventory.view"), transfers.getIndent);
router.post("/indents/:id/fulfil", authorize("inventory.manage"), transfers.fulfilIndent);
router.post("/indents/:id/close", authorize("inventory.manage"), transfers.closeIndent("closed"));
router.post(
  "/indents/:id/cancel",
  authorize("inventory.view"),
  anyOf("inventory.indent", "inventory.manage"),
  transfers.closeIndent("cancelled")
);

// Closing stock on a date, for the accountant
router.get("/valuation", authorize("inventory.view"), inventoryController.valuation);

// Stock counts: anyone who counts can fill a sheet; posting the differences
// changes stock, so it needs the right to manage stock — and, when what it
// finds missing is worth more than the write-off limit, "Approve large
// write-offs" or a manager's PIN, like any other write-off.
router.get("/counts", authorize("inventory.view"), inventoryController.listCounts);
router.post("/counts", authorize("inventory.count"), inventoryController.createCount);
router.get("/counts/variance", authorize("inventory.view"), inventoryController.varianceReport);
router.get("/counts/:id", authorize("inventory.view"), inventoryController.getCount);
router.put("/counts/:id/lines", authorize("inventory.count"), inventoryController.saveCountLines);
router.post(
  "/counts/:id/post",
  authorize("inventory.manage"),
  writeoffApproval(inventoryController.prepareCountPost),
  inventoryController.postCount
);
router.post("/counts/:id/cancel", authorize("inventory.manage"), inventoryController.cancelCount);

// Items. The spreadsheet import comes first, so "/items/import" is never read
// as an item whose id is "import".
const sheetImport = require("../../imports/controllers/sheetImport.controller");
router.get("/items/import-guide", authorize("inventory.manage"), sheetImport.stockGuide);
router.post("/items/import", authorize("inventory.manage"), sheetImport.importStockItems);
router.get("/items", authorize("inventory.view"), inventoryController.listItems);
router.post("/items", authorize("inventory.manage"), inventoryController.createItem);
router.put("/items/:id", authorize("inventory.manage"), inventoryController.updateItem);
router.put("/items/:id/packs", authorize("inventory.manage"), inventoryController.replacePacks);
// Stock out of one item, by its own address: a manager's approval for a large
// one is then tied to this item as well as its quantity and value.
router.post("/items/:id/stock-out", authorize("inventory.manage"), stockOutApproval, inventoryController.stockOut);
router.get("/items/:id/recipe", authorize("inventory.view"), require("../controllers/advancedInventory.controller").getItem);
router.put("/items/:id/recipe", authorize("inventory.manage"), require("../controllers/advancedInventory.controller").saveItem);
router.get("/items/:id/balances", authorize("inventory.view"), inventoryController.listBalances);
router.delete("/items/:id", authorize("inventory.manage"), inventoryController.removeItem);

// How much of the dish recipe a size uses (Half = 0.5). It sits with stock
// because it decides what a sale takes off the shelf; the recipe lines
// themselves are under /menu.
router.put("/recipe-sizes/:variantId", authorize("menu.manage"), recipeController.setSizeFactor);

module.exports = router;
