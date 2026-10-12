const express = require("express");
const supplierController = require("../controllers/supplier.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");

const router = express.Router();

router.use(authenticate);
router.use(requireFeature("stock_recipes"));

// A list of suppliers from a spreadsheet: checked first, then imported whole.
const sheetImport = require("../../imports/controllers/sheetImport.controller");
router.get("/import-guide", authorize("suppliers.manage"), sheetImport.supplierGuide);
router.post("/import", authorize("suppliers.manage"), sheetImport.importSuppliers);

// The supplier list. Someone who orders or receives goods (purchasing.view,
// purchasing.manage, purchasing.receive) without "View suppliers" gets the
// short list the order and bill forms pick from — name, GSTIN, credit days —
// and not contacts, terms or bill history. A store keeper's "New order" was
// greyed out with a 403 behind it.
router.get(
  "/",
  authorize.any("suppliers.view", "purchasing.view", "purchasing.manage", "purchasing.receive"),
  supplierController.list
);
router.post("/", authorize("suppliers.manage"), supplierController.create);
router.put("/:id", authorize("suppliers.manage"), supplierController.update);
router.delete("/:id", authorize("suppliers.manage"), supplierController.remove);

module.exports = router;
