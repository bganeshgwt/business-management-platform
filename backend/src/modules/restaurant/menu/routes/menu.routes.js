const sellingRules = require("../controllers/sellingRules.controller");
const express = require("express");
const menuController = require("../controllers/menu.controller");
const menuExtrasController = require("../controllers/menuExtras.controller");
const recipeController = require("../controllers/recipe.controller");
const taxRateController = require("../../setup/controllers/taxRate.controller");
const menuImportController = require("../controllers/menuImport.controller");
const comboController = require("../controllers/combo.controller");
const priceWindowController = require("../controllers/priceWindow.controller");
const authenticate = require("../../../../middlewares/authenticate");
const authorize = require("../../../../middlewares/authorize");
const requireFeature = require("../../../../middlewares/requireFeature");
const { productImageUpload } = require("../../../../middlewares/upload");

const router = express.Router();

router.use(authenticate);
router.get('/products/:productId/service-options', authorize('menu.view'), require('../controllers/menuServiceOptions.controller').get);
router.put('/products/:productId/service-options', authorize('menu.manage'), require('../controllers/menuServiceOptions.controller').save);
router.get('/products/:productId/addon-groups', authorize('menu.view'), require('../controllers/addonGroups.controller').get);
router.put('/products/:productId/addon-groups', authorize('menu.manage'), require('../controllers/addonGroups.controller').save);

// Happy hour and other timed prices. Like tax rates, they live under the menu
// because that is where they are applied.
router.get("/price-windows", authorize("menu.view"), priceWindowController.list);
router.post("/price-windows", authorize("menu.manage"), priceWindowController.create);
router.get("/price-windows/:id", authorize("menu.view"), priceWindowController.getById);
router.put("/price-windows/:id", authorize("menu.manage"), priceWindowController.update);
router.put("/price-windows/:id/items", authorize("menu.manage"), priceWindowController.setItems);
router.delete("/price-windows/:id", authorize("menu.manage"), priceWindowController.remove);

// Tax rates carry the HSN/SAC code a GST return asks for. They live under the
// menu because that is where they are applied, and they share its permissions.
router.get("/tax-rates", authorize("menu.view"), taxRateController.list);
router.post("/tax-rates", authorize("menu.manage"), taxRateController.create);
router.put("/tax-rates/:id", authorize("menu.manage"), taxRateController.update);
router.delete("/tax-rates/:id", authorize("menu.manage"), taxRateController.remove);

// Modifiers come before "/products/:id" style routes that could shadow them.
router.get("/modifiers", authorize("menu.view"), menuExtrasController.listModifiers);
router.post("/modifiers", authorize("menu.manage"), menuExtrasController.createModifier);
router.put("/modifiers/:id", authorize("menu.manage"), menuExtrasController.updateModifier);
router.delete("/modifiers/:id", authorize("menu.manage"), menuExtrasController.removeModifier);
router.get("/modifiers/:id/recipe", requireFeature("stock_recipes"), authorize("menu.view"), require("../../inventory/controllers/advancedInventory.controller").getModifier);
router.put("/modifiers/:id/recipe", requireFeature("stock_recipes"), authorize("menu.manage"), require("../../inventory/controllers/advancedInventory.controller").saveModifier);

// Variants belong to one product
router.get(
  "/products/:productId/variants",
  authorize("menu.view"),
  menuExtrasController.listVariants
);
router.post(
  "/products/:productId/variants",
  authorize("menu.manage"),
  menuExtrasController.createVariant
);
router.put("/variants/:id", authorize("menu.manage"), menuExtrasController.updateVariant);
router.delete("/variants/:id", authorize("menu.manage"), menuExtrasController.removeVariant);

// Recipe: which raw materials one plate of this dish uses
router.get("/products/:productId/combo", authorize("menu.view"), comboController.getForProduct);
router.put("/products/:productId/combo", authorize("menu.manage"), comboController.setForProduct);
router.delete(
  "/products/:productId/combo",
  authorize("menu.manage"),
  comboController.clearForProduct
);

// Recipes for many dishes from a spreadsheet, one row per ingredient.
const sheetImport = require("../../imports/controllers/sheetImport.controller");
router.get("/recipes/import-guide", requireFeature("stock_recipes"), authorize("menu.manage"), sheetImport.recipeGuide);
router.post("/recipes/import", requireFeature("stock_recipes"), authorize("menu.manage"), sheetImport.importRecipes);

router.get("/products/:productId/recipe", requireFeature("stock_recipes"), authorize("menu.view"), recipeController.getForProduct);
router.post("/products/:productId/recipe", requireFeature("stock_recipes"), authorize("menu.manage"), recipeController.addLine);
router.put("/recipe/:id", requireFeature("stock_recipes"), authorize("menu.manage"), recipeController.updateLine);
router.delete("/recipe/:id", requireFeature("stock_recipes"), authorize("menu.manage"), recipeController.removeLine);

// Which add-ons a product offers
router.get(
  "/products/:productId/modifiers",
  authorize("menu.view"),
  menuExtrasController.listProductModifiers
);
router.put(
  "/products/:productId/modifiers",
  authorize("menu.manage"),
  menuExtrasController.setProductModifiers
);

// Context-specific menu prices and availability.
router.get("/selling-options", authorize("menu.view"), sellingRules.options);
router.get("/products/:productId/selling-rules", authorize("menu.view"), sellingRules.list);
router.put("/products/:productId/selling-rules", authorize("menu.manage"), sellingRules.save);
router.delete("/selling-rules/:id", authorize("menu.manage"), sellingRules.remove);

// The printed menu card: one outlet's menu for one service, at its prices.
router.get("/menu-card", authorize("menu.view"), require("../controllers/menuCard.controller").card);

// Categories
// Brands (feature "brands"): one kitchen, several names.
router.get("/brands", requireFeature("brands"), authorize("orders.view"), require("../controllers/brand.controller").list);
router.post("/brands", requireFeature("brands"), authorize("menu.manage"), require("../controllers/brand.controller").create);
router.put("/brands/:id", requireFeature("brands"), authorize("menu.manage"), require("../controllers/brand.controller").update);
router.get("/brands/report", requireFeature("brands"), authorize("reports.view"), require("../controllers/brand.controller").report);
router.get("/categories", authorize("menu.view"), menuController.listCategories);
router.post("/categories", authorize("menu.manage"), menuController.createCategory);
router.put("/categories/:id", authorize("menu.manage"), menuController.updateCategory);
router.delete("/categories/:id", authorize("menu.manage"), menuController.removeCategory);

// Products. Import, export and the bulk tools come first: "/products/export"
// must not be read as a product whose id is "export".
router.get("/products/export", authorize("menu.view"), menuImportController.exportProducts);
router.get("/products/import-guide", authorize("menu.manage"), menuImportController.importGuide);
router.post("/products/import", authorize("menu.manage"), menuImportController.importProducts);
router.post("/products/price-revision", authorize("menu.manage"), menuController.revisePrices);
router.get("/products", authorize("menu.view"), menuController.listProducts);
router.get("/products/:id", authorize("menu.view"), menuController.getProduct);
router.post("/products", authorize("menu.manage"), menuController.createProduct);
router.put("/products/:id", authorize("menu.manage"), menuController.updateProduct);
// The edit form: only the fields the manager changed, checked against what
// they said when the form was opened.
router.patch("/products/:id", authorize("menu.manage"), menuController.patchProduct);
// Marking a dish sold out is its own permission (menu.availability): the
// kitchen and captains hold it so they can say "paneer is finished" during
// service, without being able to change a price. Managers hold it too.
router.patch(
  "/products/:id/availability",
  authorize("menu.availability"),
  menuController.setProductAvailability
);
// Archive a dish or bring it back (a dish with sales history cannot be deleted).
router.patch("/products/:id/status", authorize("menu.manage"), menuController.setProductStatus);
// Can it be deleted? (Not once sold, nor while a combo uses it.)
router.get("/products/:id/usage", authorize("menu.view"), menuController.productUsage);
// Who changed this dish's price, sizes or availability, and when.
router.get("/products/:id/history", authorize("audit.view"), menuController.productHistory);
router.post(
  "/products/:id/image",
  authorize("menu.manage"),
  productImageUpload,
  menuController.uploadProductImage
);
router.delete(
  "/products/:id/image",
  authorize("menu.manage"),
  menuController.removeProductImage
);
router.delete("/products/:id", authorize("menu.manage"), menuController.removeProduct);

module.exports = router;
