const menuService = require("../services/menu.service");
const menuPriceRevisionService = require("../services/menuPriceRevision.service");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { logAction, diff } = require("../../../../utils/audit");
const { PRODUCT_AUDIT_FIELDS, productAuditView } = require("../services/menuCommon");

// Every change to a dish that touches money or what can be sold is written to
// the activity log with the value before and after: "who changed the price of
// Paneer Tikka, and when?" must always have an answer, and so must "who put it
// back". A save that changed nothing writes nothing.

// --- Categories ---

// forUpdate: a field the edit leaves out (undefined) keeps what the category
// has and is not written. Before, an edit that sent only a new name switched
// a switched-off category back on, moved it to the top and wiped its
// description.
const readCategoryBody = (body = {}, forUpdate = false) => {
  const unlessLeftOut = (key, read) => (forUpdate && body[key] === undefined ? undefined : read());
  const data = {
    name: unlessLeftOut("name", () => v.requiredString(body.name, "Category name", 100)),
    description: unlessLeftOut("description", () => v.optionalString(body.description, "Description", 500)),
    sortOrder: unlessLeftOut(
      "sortOrder",
      () => v.optionalNumber(body.sortOrder, "Sort order", { min: 0, max: 9999 }) ?? 0
    ),
    status: unlessLeftOut("status", () => v.optionalEnum(body.status, "Status", ["active", "inactive"], "active")),
  };

  if (forUpdate && Object.values(data).every((value) => value === undefined)) {
    throw new AppError(400, "Nothing to change: send the category's name, description, order or status");
  }

  return data;
};

const categoryAuditView = (category) => ({
  name: category.name,
  description: category.description || null,
  displayOrder: category.sortOrder,
  status: category.status === "active" ? "On the menu" : "Switched off",
});

const listCategories = async (req, res) => {
  const categories = await menuService.listCategories(req.user.restaurantId);

  res.json({ success: true, data: categories });
};

const createCategory = async (req, res) => {
  const category = await menuService.createCategory(
    req.user.restaurantId,
    readCategoryBody(req.body),
    req.user.id
  );

  logAction(req, "create", "category", {
    id: category.id,
    label: category.name,
    details: categoryAuditView(category),
  });

  res.status(201).json({ success: true, message: "Category created", data: category });
};

const updateCategory = async (req, res) => {
  const id = v.requiredId(req.params.id, "Category id");
  const { before, category } = await menuService.updateCategory(
    req.user.restaurantId,
    id,
    readCategoryBody(req.body, true),
    req.user.id
  );

  const changes = diff(categoryAuditView(before), categoryAuditView(category), [
    "name",
    "description",
    "displayOrder",
    "status",
  ]);

  if (Object.keys(changes).length > 0) {
    logAction(req, "update", "category", { id, label: category.name, details: { changes } });
  }

  res.json({ success: true, message: "Category updated", data: category });
};

const removeCategory = async (req, res) => {
  const id = v.requiredId(req.params.id, "Category id");
  const category = await menuService.removeCategory(req.user.restaurantId, id);

  logAction(req, "delete", "category", { id, label: category.name });

  res.json({ success: true, message: "Category deleted" });
};

// --- Products ---

// forUpdate: a field the body leaves out comes back undefined, and the edit
// keeps what the dish has (menu.service editProduct). Before, a left-out field
// took the new-dish default: an edit that sent only name and price turned a
// non-veg dish veg, dropped its GST to 0% and put it back on sale — the same
// harm the import had (menu audit B1), through the API instead of a file.
// null is still an answer: it clears a code or description, or means No tax.
const readProductBody = (body = {}, forUpdate = false) => {
  const unlessLeftOut = (key, read) => (forUpdate && body[key] === undefined ? undefined : read());

  return {
    categoryId: v.requiredId(body.categoryId, "Category"),
    name: v.requiredString(body.name, "Product name", 150),
    code: unlessLeftOut("code", () => v.optionalString(body.code, "Product code", 30)),
    description: unlessLeftOut("description", () => v.optionalString(body.description, "Description", 500)),
    price: v.requiredNumber(body.price, "Price", { min: 0, max: 9999999 }),
    // A dish normally points at a named tax rate, which carries the HSN code.
    // A bare percentage is still accepted, for imports and older clients.
    taxRateId: unlessLeftOut("taxRateId", () => v.optionalNumber(body.taxRateId, "Tax rate", { min: 1 })),
    taxPercentage: unlessLeftOut("taxPercentage", () =>
      v.optionalNumber(body.taxPercentage, "Tax %", { min: 0, max: 100 })
    ),
    taxMode: unlessLeftOut("taxMode", () =>
      v.optionalEnum(body.taxMode, "Price tax mode", ["default", "inclusive", "exclusive"], "default")
    ),
    mrp: unlessLeftOut("mrp", () => v.optionalNumber(body.mrp, "MRP", { min: 0, max: 9999999 })),
    foodType: unlessLeftOut("foodType", () =>
      v.optionalEnum(body.foodType, "Food type", ["veg", "non_veg", "egg"], "veg")
    ),
    isAvailable: unlessLeftOut("isAvailable", () => v.requiredBoolean(body.isAvailable, "Availability", true)),
    sortOrder: unlessLeftOut(
      "sortOrder",
      () => v.optionalNumber(body.sortOrder, "Sort order", { min: 0, max: 9999 }) ?? 0
    ),
    status: unlessLeftOut("status", () => v.optionalEnum(body.status, "Status", ["active", "inactive"], "active")),
    // SW-A-12: the dish's name for the kitchen, in any script; empty clears it.
    kitchenName: unlessLeftOut("kitchenName", () => v.optionalString(body.kitchenName, "Kitchen name", 150)),
  };
};

// The fields the edit form can change one at a time (PATCH), each checked on
// its own with the same rules as the full edit. A field that is sent must say
// something: null is only an answer where it means "none" (no code, no
// description, No tax).
const strictBoolean = (value, field) => {
  if (typeof value !== "boolean") {
    throw new AppError(400, `${field} must be true or false`);
  }

  return value;
};

const PATCH_READERS = {
  categoryId: (value) => v.requiredId(value, "Category"),
  name: (value) => v.requiredString(value, "Product name", 150),
  code: (value) => v.optionalString(value, "Product code", 30),
  description: (value) => v.optionalString(value, "Description", 500),
  price: (value) => v.requiredNumber(value, "Price", { min: 0, max: 9999999 }),
  taxRateId: (value) => (value === null || value === "" ? null : v.requiredId(value, "Tax rate")),
  taxMode: (value) => v.requiredEnum(value, "Price tax mode", ["default", "inclusive", "exclusive"]),
  mrp: (value) => (value === null || value === "" ? null : v.requiredNumber(value, "MRP", { min: 0, max: 9999999 })),
  foodType: (value) => v.requiredEnum(value, "Food type", ["veg", "non_veg", "egg"]),
  isAvailable: (value) => strictBoolean(value, "Availability"),
  sortOrder: (value) => v.requiredNumber(value, "Display order", { min: 0, max: 9999 }),
  status: (value) => v.requiredEnum(value, "Status", ["active", "inactive"]),
  kitchenName: (value) => v.optionalString(value, "Kitchen name", 150),
};

const PATCHABLE = Object.keys(PATCH_READERS);

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const listProducts = async (req, res) => {
  const filters = {
    categoryId: v.optionalNumber(req.query.categoryId, "Category", { min: 1 }),
    search: v.optionalString(req.query.search, "Search", 100),
    status: req.query.status
      ? v.requiredEnum(req.query.status, "Status", ["active", "inactive"])
      : null,
    // The POS passes this so the grid shows the price being charged right now.
    withOffers: req.query.withOffers === "true",
    // The products screen: whether each dish has a recipe and, for those who
    // may see recipe costs, what a plate costs.
    withCost: req.query.withCost === "true",
    showCosts: (req.user.permissions || []).some((code) => code === "menu.manage" || code === "inventory.view"),
  };

  const products = await menuService.listProducts(req.user.restaurantId, filters);

  res.json({ success: true, data: products });
};

const getProduct = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");
  const product = await menuService.getProduct(req.user.restaurantId, id);

  res.json({ success: true, data: product });
};

const createProduct = async (req, res) => {
  const body = req.body || {};
  const product = await menuService.createProduct(
    req.user.restaurantId,
    {
      ...readProductBody(body),
      // "No tax" picked on the form arrives as taxRateId: null. Leaving both
      // tax fields out is different: the dish takes the default GST rate.
      taxChosen: body.taxRateId !== undefined || body.taxPercentage !== undefined,
    },
    req.user.id
  );

  const view = productAuditView(product);

  logAction(req, "create", "product", {
    id: product.id,
    label: product.name,
    details: {
      price: view.price,
      category: view.category,
      foodType: view.foodType,
      taxRate: view.taxRate,
      available: view.available,
    },
  });

  res.status(201).json({ success: true, message: "Product created", data: product });
};

const logProductEdit = (req, id, before, product) => {
  const changes = diff(productAuditView(before), productAuditView(product), PRODUCT_AUDIT_FIELDS);

  if (Object.keys(changes).length > 0) {
    logAction(req, "update", "product", { id, label: product.name, details: { changes } });
  }
};

const updateProduct = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");
  const { before, product } = await menuService.editProduct(
    req.user.restaurantId,
    id,
    readProductBody(req.body, true),
    req.user.id
  );

  logProductEdit(req, id, before, product);

  res.json({ success: true, message: "Product updated", data: product });
};

// How the edit form saves: { changes: { price: 220 }, original: { price: 200 } }
// — only what the manager changed, and what each of those fields said when
// the form was opened. A field the manager did not touch is never sent, so
// the form cannot undo someone else's change to it (the kitchen marking the
// dish sold out while the form was open). A field the manager did change,
// that someone else also changed meanwhile, is refused (409) with what it
// says now, instead of one of the two changes silently winning.
const patchProduct = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");
  const body = req.body || {};

  if (!isPlainObject(body.changes)) {
    throw new AppError(400, "Send the fields to change as changes, for example { changes: { price: 220 } }");
  }

  const keys = Object.keys(body.changes);
  const unknown = keys.filter((key) => !PATCHABLE.includes(key));

  if (unknown.length > 0) {
    throw new AppError(400, `"${unknown[0]}" cannot be changed here`);
  }

  if (keys.length === 0) {
    throw new AppError(400, "Nothing to change");
  }

  const changes = Object.fromEntries(keys.map((key) => [key, PATCH_READERS[key](body.changes[key])]));
  const original = isPlainObject(body.original) ? body.original : {};
  const { before, product } = await menuService.patchProduct(
    req.user.restaurantId,
    id,
    changes,
    original,
    req.user.id
  );

  logProductEdit(req, id, before, product);

  res.json({ success: true, message: "Product updated", data: product });
};

// Separate from the full edit, so the list screen (and the kitchen and the
// floor, with menu.availability) can switch a dish off in one tap without
// being able to change its price. The combos the dish is part of come back
// with it: a thali cannot be served once its dal is gone.
const setProductAvailability = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");
  const isAvailable = v.requiredBoolean(req.body?.isAvailable, "Availability", true);

  const { before, product, combos } = await menuService.changeAvailability(
    req.user.restaurantId,
    id,
    isAvailable,
    req.user.id
  );

  if (before.isAvailable !== product.isAvailable) {
    logAction(req, "availability", "product", {
      id,
      label: product.name,
      details: { changes: { available: [before.isAvailable, product.isAvailable] } },
    });
  }

  res.json({
    success: true,
    message: isAvailable ? "Back on sale" : "Marked sold out",
    data: { ...product, combos },
  });
};

// Archive a dish (it leaves the POS and the QR menu, its history stays) or
// bring it back. This is what a dish with sales history gets instead of a delete.
const setProductStatus = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");
  const status = v.requiredEnum(req.body?.status, "Status", ["active", "inactive"]);

  const { before, product } = await menuService.setProductStatus(
    req.user.restaurantId,
    id,
    status,
    req.user.id
  );

  const changes = diff(productAuditView(before), productAuditView(product), ["status"]);

  if (Object.keys(changes).length > 0) {
    logAction(req, "update", "product", { id, label: product.name, details: { changes } });
  }

  res.json({
    success: true,
    message: status === "active" ? `"${product.name}" is back on the menu` : `"${product.name}" archived`,
    data: product,
  });
};

const removeProduct = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");
  const product = await menuService.removeProduct(req.user.restaurantId, id);
  const view = productAuditView(product);

  logAction(req, "delete", "product", {
    id,
    label: product.name,
    details: { price: view.price, category: view.category, foodType: view.foodType },
  });

  res.json({ success: true, message: "Product deleted" });
};

// Whether the dish can be deleted, and if not why (sold before, or part of
// a combo), so the screen can offer archiving before anyone presses Delete.
const productUsage = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");

  res.json({ success: true, data: await menuService.productUsage(req.user.restaurantId, id) });
};

const productHistory = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");

  res.json({ success: true, data: await menuService.productHistory(req.user.restaurantId, id) });
};

// --- Bulk price revision ---

// "+8% on Starters and Mains, rounded to the nearest ₹5." Checked first
// (dryRun) and applied only as previewed: the preview's fingerprint must still
// match when it is applied.
const revisePrices = async (req, res) => {
  const body = req.body || {};
  const mode = v.requiredEnum(body.mode, "Change by", ["percent", "amount"]);
  const input = {
    categoryIds: body.categoryIds === undefined || body.categoryIds === null
      ? []
      : [...new Set(v.requiredArray(body.categoryIds, "Categories").map((id) => v.requiredId(id, "Category")))],
    mode,
    value: v.requiredNumber(
      body.value,
      mode === "percent" ? "Percentage" : "Amount",
      mode === "percent" ? { min: -90, max: 300 } : { min: -100000, max: 100000 }
    ),
    roundTo: Number(v.optionalEnum(
      body.roundTo === undefined || body.roundTo === null ? undefined : String(body.roundTo),
      "Round to",
      ["0", "1", "5", "10"],
      "0"
    )),
    direction: v.optionalEnum(body.direction, "Rounding", ["nearest", "up", "down"], "nearest"),
    includeSizes: v.requiredBoolean(body.includeSizes, "Include sizes", true),
    dryRun: v.requiredBoolean(body.dryRun, "Dry run", false),
    fingerprint: v.optionalString(body.fingerprint, "Preview check", 100),
  };

  if (input.value === 0) {
    throw new AppError(400, "A change of 0 would leave every price as it is. Enter the change you want.");
  }

  const result = await menuPriceRevisionService.revise(req.user.restaurantId, input, req.user.id);

  // A preview that finds problems is still a preview that worked: it answers
  // 200 with the problems. Applying a rule with problems is refused (400).
  if (!result.ok) {
    return res.status(input.dryRun ? 200 : 400).json({
      success: input.dryRun,
      message: result.problems[0].message,
      data: result,
    });
  }

  if (!input.dryRun) {
    for (const dish of result.dishes) {
      const changes = { price: [dish.from, dish.to] };

      for (const size of dish.sizes) {
        if (size.from !== size.to) {
          changes[`${size.name} price`] = [size.from, size.to];
        }
      }

      logAction(req, "update", "product", {
        id: dish.productId,
        label: dish.name,
        details: { via: `Price revision: ${result.rule}`, changes },
      });
    }

    logAction(req, "price_revision", "product", {
      id: null,
      label: `Price revision · ${result.changed} dish${result.changed === 1 ? "" : "es"}`,
      details: { rule: result.rule, dishes: result.changed },
    });
  }

  res.json({
    success: true,
    message: input.dryRun
      ? `${result.changed} price${result.changed === 1 ? "" : "s"} would change`
      : `${result.changed} price${result.changed === 1 ? "" : "s"} changed`,
    data: result,
  });
};

// The image arrives as multipart, so multer has already put the bytes on
// req.file by the time this runs.
const uploadProductImage = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");

  if (!req.file) {
    throw new AppError(400, "Choose an image to upload");
  }

  const product = await menuService.setProductImage(
    req.user.restaurantId,
    id,
    req.file.buffer,
    req.user.id
  );

  logAction(req, "update", "product_image", { id, label: product.name });

  res.json({ success: true, message: "Photo saved", data: product });
};

const removeProductImage = async (req, res) => {
  const id = v.requiredId(req.params.id, "Product id");

  const product = await menuService.setProductImage(req.user.restaurantId, id, null, req.user.id);

  logAction(req, "delete", "product_image", { id, label: product.name });

  res.json({ success: true, message: "Photo removed", data: product });
};

module.exports = {
  uploadProductImage,
  removeProductImage,
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  patchProduct,
  setProductAvailability,
  setProductStatus,
  removeProduct,
  productHistory,
  productUsage,
  revisePrices,
};
