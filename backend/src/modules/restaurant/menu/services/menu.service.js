const categoryRepository = require("../repositories/category.repository");
const productRepository = require("../repositories/product.repository");
const taxRateRepository = require("../../setup/repositories/taxRate.repository");
const comboRepository = require("../repositories/combo.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const menuExtrasRepository = require("../repositories/menuExtras.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { saveProductImage, removeUpload } = require("../../../../middlewares/upload");
const { rupees, translateMenuRule } = require("./menuCommon");

const DUPLICATE = "23505";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toCategory = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  sortOrder: row.sort_order,
  status: row.status,
  productCount: row.product_count,
});

// price and tax arrive from PostgreSQL as strings (NUMERIC keeps exact decimals),
// so they are converted once here for the frontend.
const toProduct = (row) => ({
  id: row.id,
  categoryId: row.category_id,
  categoryName: row.category_name,
  name: row.name,
  // SW-A-12: what the KOT and the kitchen screen may print instead (null: none).
  kitchenName: row.kitchen_name || null,
  // "weight": the price is per kg and a line's quantity is its weight in kg.
  soldBy: row.sold_by || "unit",
  code: row.code,
  description: row.description,
  price: Number(row.price),
  taxPercentage: Number(row.tax_percentage),
  taxRateId: row.tax_rate_id,
  taxRateName: row.tax_rate_name,
  taxMode: row.tax_mode || "default",
  mrp: row.mrp === null || row.mrp === undefined ? null : Number(row.mrp),
  hsnCode: row.hsn_code,
  isCombo: row.is_combo,
  addonGroups: row.addon_groups || [],
  availabilitySchedule: row.availability_schedule || [],
  comboChoiceGroups: row.combo_choice_groups || [],
  imagePath: row.image_path,
  // Set only when a timed price is running right now, so the POS can show it.
  offerPrice: row.offer_price === null || row.offer_price === undefined
    ? null
    : Number(row.offer_price),
  offerName: row.offer_name || null,
  foodType: row.food_type,
  isAvailable: row.is_available,
  sortOrder: row.sort_order,
  status: row.status,
  // Only on the list: a combo's parts that cannot be made right now, each with
  // why ({ name, size, reason: sold_out | archived | size_off }). soldOutParts
  // is the same list as plain dish names, which older screens read.
  ...(row.unavailable_parts !== undefined
    ? {
        unavailableParts: row.unavailable_parts || [],
        soldOutParts: (row.unavailable_parts || []).map((part) => part.name),
      }
    : {}),
});

// --- Categories ---

const listCategories = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await categoryRepository.findAll(restaurantId);
  return rows.map(toCategory);
};

const createCategory = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    const row = await categoryRepository.create(restaurantId, data, userId);
    return toCategory(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A category named "${data.name}" already exists`);
    }

    throw error;
  }
};

// Returns the category before and after, so the controller can log what
// changed (switching a category off takes every dish in it off the menu).
const updateCategory = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await categoryRepository.findById(restaurantId, id);

  if (!before) {
    throw new AppError(404, "Category not found");
  }

  try {
    const row = await categoryRepository.update(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Category not found");
    }

    return { before: toCategory(before), category: toCategory(row) };
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A category named "${data.name}" already exists`);
    }

    throw error;
  }
};

// A category holding products is never deleted: the products would lose their group.
const removeCategory = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const category = await categoryRepository.findById(restaurantId, id);

  if (!category) {
    throw new AppError(404, "Category not found");
  }

  const productCount = await categoryRepository.countProducts(id);

  if (productCount > 0) {
    throw new AppError(
      409,
      `This category has ${productCount} product(s). Move or delete them first, or set the category to inactive.`
    );
  }

  await categoryRepository.remove(restaurantId, id);

  return toCategory(category);
};

// --- Products ---

const listProducts = async (restaurantId, filters = {}) => {
  requireRestaurantId(restaurantId);

  // Looking up the live happy-hour price costs an extra join per dish, so the
  // POS asks for it and the admin list does not.
  const timezone = filters.withOffers
    ? (await restaurantRepository.findSettings(restaurantId)).timezone
    : null;

  const rows = await productRepository.findAll(restaurantId, { ...filters, timezone });

  if (!filters.withCost) {
    return rows.map(toProduct);
  }

  // withCost (the products screen): hasRecipe for everyone who may see the
  // menu; what a plate costs only for those who may see recipe costs.
  return rows.map((row) => {
    const product = toProduct(row);
    const hasRecipe = product.isCombo ? null : Boolean(row.has_recipe);
    const cost = row.plate_cost === null || row.plate_cost === undefined ? null : Number(row.plate_cost);
    const price = Number(row.plate_price);
    const costing =
      filters.showCosts && hasRecipe && cost !== null
        ? { plateCost: round2(cost), foodCostPercent: price > 0 ? round2((cost / price) * 100) : null }
        : { plateCost: null, foodCostPercent: null };

    return { ...product, hasRecipe, ...costing };
  });
};

const getProduct = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const row = await productRepository.findById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Product not found");
  }

  return toProduct(row);
};

// The category must belong to the same restaurant, otherwise a product could be
// attached to another restaurant's category.
const requireOwnCategory = async (restaurantId, categoryId) => {
  const category = await categoryRepository.findById(restaurantId, categoryId);

  if (!category) {
    throw new AppError(400, "Selected category does not exist");
  }
};

// The percentage a dish charges always comes from its tax rate, so the two can
// never drift apart. Without a rate the request's own percentage is used, which
// is what a CSV import and the older API do.
//
// A rate that has been switched off cannot be given to a dish, but a dish
// already on it can still be edited (a price change, a new photo) without
// first being moved to another rate. It keeps charging that rate, which is
// right: switching a rate off must never make dishes tax-free.
const resolveTax = async (restaurantId, data, currentRateId = null) => {
  if (!data.taxRateId) {
    return { ...data, taxRateId: null, taxPercentage: data.taxPercentage ?? 0 };
  }

  const rate = await taxRateRepository.findById(restaurantId, data.taxRateId);

  if (!rate) {
    throw new AppError(400, "That tax rate does not exist");
  }

  if (rate.status !== "active" && Number(rate.id) !== Number(currentRateId)) {
    throw new AppError(400, `The tax rate "${rate.name}" is switched off`);
  }

  return { ...data, taxPercentage: Number(rate.percentage) };
};

// A size is stored as a difference from the dish price, so cutting the dish
// price can push a size below zero, which the till then cannot sell. Refused
// here with the size named and the lowest price that works. Switched-off
// sizes cannot be sold and do not count (switching one back on is checked).
const requireSizesStayPriced = async (restaurantId, productId, price) => {
  const variants = await menuExtrasRepository.findVariants(restaurantId, productId);
  const below = variants
    .filter((row) => row.status === "active" && round2(price + Number(row.price_delta)) < 0)
    .sort((a, b) => Number(a.price_delta) - Number(b.price_delta));

  if (below.length === 0) {
    return;
  }

  const worst = below[0];
  const lowest = round2(-Number(worst.price_delta));
  const names = below.map((row) => `"${row.name}"`).join(" and ");

  throw new AppError(
    400,
    `At ${rupees(price)} the size ${names} would cost less than zero ` +
      `(${worst.name}: ${rupees(price + Number(worst.price_delta))}). ` +
      `Change the size's price first under Sizes & add-ons, or keep the dish at ${rupees(lowest)} or more.`
  );
};

// A new dish that says nothing about GST — no rate, no percentage, and no
// "No tax" chosen — is charged the restaurant's default rate, exactly as the
// menu import does. It used to be created at 0%, and every bill for it went
// out without GST until someone noticed. With no default rate set there is no
// safe guess, so the dish is refused with what to do.
const withDefaultTax = async (restaurantId, data) => {
  const said = data.taxChosen || data.taxRateId || (data.taxPercentage !== null && data.taxPercentage !== undefined);

  if (said) {
    return data;
  }

  const rate = await taxRateRepository.findDefault(restaurantId);

  if (!rate) {
    throw new AppError(
      400,
      `Choose a GST rate for "${data.name}": the restaurant has no default rate yet. Mark one as the default under Menu → Tax rates, or choose No tax for an item that carries no GST.`
    );
  }

  return { ...data, taxRateId: Number(rate.id), taxPercentage: Number(rate.percentage) };
};

const createProduct = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  await requireOwnCategory(restaurantId, data.categoryId);

  const priced = await resolveTax(restaurantId, await withDefaultTax(restaurantId, data));

  try {
    const row = await productRepository.create(restaurantId, priced, userId);
    return toProduct(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A product with this name or code already exists");
    }

    throw error;
  }
};

// A field the edit left out (undefined) keeps what the dish has. Tax is one
// answer in two fields: both left out keeps the dish's rate; a percentage on
// its own is the older "bare percentage" form; a rate of null is No tax.
const keepLeftOut = (data, existing) => {
  const keep = (value, current) => (value === undefined ? current : value);
  const filled = {
    ...data,
    code: keep(data.code, existing.code),
    description: keep(data.description, existing.description),
    foodType: keep(data.foodType, existing.food_type),
    isAvailable: keep(data.isAvailable, existing.is_available),
    sortOrder: keep(data.sortOrder, existing.sort_order),
    status: keep(data.status, existing.status),
    kitchenName: keep(data.kitchenName, existing.kitchen_name),
    soldBy: keep(data.soldBy, existing.sold_by),
  };

  if (data.taxRateId === undefined && data.taxPercentage === undefined) {
    filled.taxRateId = existing.tax_rate_id;
    filled.taxPercentage = Number(existing.tax_percentage);
  } else if (data.taxRateId === undefined) {
    filled.taxRateId = null;
  }

  return filled;
};

// The column each edited field is stored in. Tax is written as a pair
// (tax_rate_id and tax_percentage) and handled on its own.
const FIELD_COLUMNS = {
  categoryId: "category_id",
  name: "name",
  code: "code",
  description: "description",
  price: "price",
  taxMode: "tax_mode",
  mrp: "mrp",
  foodType: "food_type",
  isAvailable: "is_available",
  sortOrder: "sort_order",
  status: "status",
  kitchenName: "kitchen_name",
  soldBy: "sold_by",
};

// { column: value } for the given fields, plus the tax pair when tax is one
// of them.
const columnsFor = (data, keys, withTax) => {
  const fields = {};

  for (const key of keys) {
    if (FIELD_COLUMNS[key]) {
      fields[FIELD_COLUMNS[key]] = data[key];
    }
  }

  if (withTax) {
    fields.tax_rate_id = data.taxRateId;
    fields.tax_percentage = data.taxPercentage;
  }

  return fields;
};

// Every dish edit writes only the columns the change names, on the dish
// locked for that instant. Nothing the change leaves out is written, so the
// kitchen's sold-out tap, a price revision or anybody else's edit to another
// field is never undone — not by an old form, and not by a save landing in
// the same instant (it waits for the lock, then applies on top).
//
// `prepare(existing)` runs first and does the checks that read other tables
// (category, tax rate, sizes); it returns `plan(locked)`, which only looks at
// the locked dish and returns the columns to write. The checks stay outside
// the lock on purpose: a connection held while waiting for another from the
// pool would let a burst of saves use up the pool and stall each other. The
// database's own rule (no size below zero) is checked again at commit.
// Returns the dish before and after, for the activity log.
const saveEdit = async (restaurantId, id, userId, prepare) => {
  requireRestaurantId(restaurantId);

  const existing = await productRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Product not found");
  }

  const plan = await prepare(existing);
  const client = await productRepository.connect();

  try {
    await client.query("BEGIN");

    const locked = await productRepository.lockById(client, restaurantId, id);

    if (!locked) {
      throw new AppError(404, "Product not found");
    }

    const fields = plan(locked);

    if (Object.keys(fields).length > 0) {
      await productRepository.updateColumns(client, restaurantId, id, fields, userId);
    }

    const after = await productRepository.lockById(client, restaurantId, id);

    // The database checks its menu rules (no size below zero) here.
    await client.query("COMMIT");

    return { before: toProduct(locked), product: toProduct(after) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);

    if (error.code === DUPLICATE) {
      throw new AppError(409, "A product with this name or code already exists");
    }

    throw translateMenuRule(error);
  } finally {
    client.release();
  }
};

// The full edit (PUT). A field the request leaves out keeps what the dish has
// and is not written at all.
const editProduct = async (restaurantId, id, input, userId) =>
  saveEdit(restaurantId, id, userId, async (existing) => {
    const data = keepLeftOut(input, existing);

    await requireOwnCategory(restaurantId, data.categoryId);

    const priced = await resolveTax(restaurantId, data, existing.tax_rate_id);

    await requireSizesStayPriced(restaurantId, id, priced.price);

    const given = Object.keys(FIELD_COLUMNS).filter((key) => input[key] !== undefined);
    const taxGiven = input.taxRateId !== undefined || input.taxPercentage !== undefined;
    const fields = columnsFor(priced, given, taxGiven);

    return () => fields;
  });

const updateProduct = async (restaurantId, id, data, userId) =>
  (await editProduct(restaurantId, id, data, userId)).product;

// 200, "200" and 200.00 are the same price; "" and null the same empty code.
const sameValue = (a, b) => {
  const x = a === undefined || a === "" ? null : a;
  const y = b === undefined || b === "" ? null : b;

  if (x === null || y === null || typeof x === "boolean" || typeof y === "boolean") {
    return x === y;
  }

  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    return Number(x) === Number(y);
  }

  return String(x) === String(y);
};

// What someone else's change looks like now, in the words of the form.
const describeNow = (key, current) => {
  switch (key) {
    case "price":
      return `the price is now ${rupees(current.price)}`;
    case "isAvailable":
      return current.isAvailable ? "it is back on sale" : "it has been marked sold out";
    case "status":
      return current.status === "active" ? "it is back on the menu" : "it has been archived";
    case "name":
      return `it has been renamed "${current.name}"`;
    case "categoryId":
      return `it has moved to ${current.categoryName}`;
    case "taxRateId":
      return `its GST is now ${current.taxRateName || `${current.taxPercentage}%`}`;
    case "foodType":
      return `it is now marked ${{ veg: "Veg", non_veg: "Non-veg", egg: "Egg" }[current.foodType]}`;
    case "code":
      return `its short code is now ${current.code || "empty"}`;
    case "sortOrder":
      return `its display order is now ${current.sortOrder}`;
    case "kitchenName":
      return `its kitchen name is now ${current.kitchenName || "empty"}`;
    case "soldBy":
      return current.soldBy === "weight" ? "it is now sold by weight (price per kg)" : "it is now sold by the piece";
    default:
      return "its description was changed";
  }
};

// The edit form's save (PATCH): only the fields the manager changed, checked
// and written against the dish as it is at this instant (locked), so nobody
// else's change to another field is undone. `original` holds what each
// changed field said when the form was opened; if someone has changed one of
// those since (to something else), the save is refused with the dish as it is
// now — the manager decides, not the clock. `changes` arrive validated.
const patchProduct = async (restaurantId, id, changes, original, userId) =>
  saveEdit(restaurantId, id, userId, async (existing) => {
    const has = (key) => Object.prototype.hasOwnProperty.call(changes, key);

    if (has("categoryId")) {
      await requireOwnCategory(restaurantId, changes.categoryId);
    }

    if (has("price")) {
      await requireSizesStayPriced(restaurantId, id, changes.price);
    }

    // Choosing another rate charges that rate's percentage; choosing No tax
    // is 0%, not whatever the old rate charged.
    const tax = has("taxRateId")
      ? await resolveTax(
          restaurantId,
          { taxRateId: changes.taxRateId, taxPercentage: changes.taxRateId ? null : 0 },
          existing.tax_rate_id
        )
      : null;
    const fields = columnsFor({ ...changes, ...(tax || {}) }, Object.keys(changes), Boolean(tax));

    // The clash check is made on the locked dish, so what it compares is
    // exactly what the write lands on.
    return (locked) => {
      const current = toProduct(locked);
      const clashes = Object.keys(changes).filter(
        (key) =>
          Object.prototype.hasOwnProperty.call(original, key) &&
          !sameValue(current[key], original[key]) &&
          !sameValue(current[key], changes[key])
      );

      if (clashes.length > 0) {
        throw new AppError(
          409,
          `Someone changed "${current.name}" while you were editing it: ${clashes.map((key) => describeNow(key, current)).join(", ")}. ` +
            "Your change was not saved. Check the dish and save again.",
          { reason: "changed_meanwhile", fields: clashes, current }
        );
      }

      return fields;
    };
  });

const setProductAvailability = async (restaurantId, id, isAvailable, userId) => {
  requireRestaurantId(restaurantId);

  const row = await productRepository.setAvailability(restaurantId, id, isAvailable, userId);

  if (!row) {
    throw new AppError(404, "Product not found");
  }

  return toProduct(row);
};

// The sold-out switch as the menu screen uses it: the dish before and after
// (for the activity log), and the combos it is part of. A thali cannot be
// served once its dal is gone, so the screen offers to switch those off too.
const changeAvailability = async (restaurantId, id, isAvailable, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await productRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Product not found");
  }

  const product = await setProductAvailability(restaurantId, id, isAvailable, userId);
  const combos = await comboRepository.findCombosContaining(restaurantId, id);

  return {
    before: toProduct(existing),
    product,
    combos: combos.map((row) => ({
      id: row.id,
      name: row.name,
      isAvailable: row.is_available,
      status: row.status,
    })),
  };
};

// Archive (inactive) or bring back. A dish with sales history leaves the menu
// this way: it disappears from the POS and the QR menu, and its history stays.
const setProductStatus = async (restaurantId, id, status, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await productRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Product not found");
  }

  const row = await productRepository.setStatus(restaurantId, id, status, userId);

  return { before: toProduct(existing), product: toProduct(row) };
};

// Every change the activity log holds for this dish and its sizes, newest first.
const productHistory = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const product = await productRepository.findById(restaurantId, id);

  if (!product) {
    throw new AppError(404, "Product not found");
  }

  const rows = await productRepository.findHistory(restaurantId, id, product.name);

  return {
    productId: product.id,
    productName: product.name,
    items: rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityLabel: row.entity_label,
      userName: row.user_name,
      approverName: row.approver_name,
      details: row.details,
      createdAt: row.created_at,
    })),
  };
};

// Saving a photo replaces whatever was there and deletes the old file, so the
// uploads folder holds exactly one image per dish. A null buffer removes it.
const setProductImage = async (restaurantId, id, buffer, userId) => {
  requireRestaurantId(restaurantId);

  const product = await productRepository.findById(restaurantId, id);

  if (!product) {
    throw new AppError(404, "Product not found");
  }

  const imagePath = buffer ? saveProductImage(restaurantId, buffer) : null;

  try {
    const row = await productRepository.setImagePath(restaurantId, id, imagePath, userId);

    // Only once the row points at the new file is the old one safe to delete.
    await removeUpload(product.image_path);

    return toProduct(row);
  } catch (error) {
    // The row was not updated, so the file just written is an orphan.
    await removeUpload(imagePath);
    throw error;
  }
};

// Why a dish cannot be deleted, or null when it can. Deleting a dish a combo
// is built from would leave the combo selling something it cannot make; and
// past bills, kitchen tickets and sales reports point at a dish that has ever
// been ordered, so that one stays and is archived instead.
const deleteBlock = async (restaurantId, existing) => {
  const combos = await comboRepository.findCombosContaining(restaurantId, existing.id);

  if (combos.length > 0) {
    return {
      message: `This dish is part of ${combos.map((row) => `"${row.name}"`).join(", ")}. Take it out of the combo first.`,
      details: { reason: "in_combo", combos: combos.map((row) => ({ id: row.id, name: row.name })) },
    };
  }

  const timesSold = await productRepository.countOrderLines(restaurantId, existing.id);

  if (timesSold > 0) {
    return {
      message:
        `"${existing.name}" has already been sold (on ${timesSold} order${timesSold === 1 ? "" : "s"}), so it can't be deleted: ` +
        "past bills and sales reports need it. Archive it instead. It leaves the POS and the QR menu, and its history stays.",
      details: { reason: "has_sales", timesSold, canArchive: true },
    };
  }

  return null;
};

// Asked before the delete dialog opens, so the screen can offer "archive
// instead" straight away rather than after a refused delete.
const productUsage = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await productRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Product not found");
  }

  const block = await deleteBlock(restaurantId, existing);

  return {
    productId: existing.id,
    canDelete: !block,
    message: block ? block.message : null,
    ...(block ? block.details : { reason: null, canArchive: false }),
  };
};

// Returns the dish as it was, for the activity log.
const removeProduct = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await productRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Product not found");
  }

  const block = await deleteBlock(restaurantId, existing);

  if (block) {
    throw new AppError(409, block.message, block.details);
  }

  try {
    const removed = await productRepository.remove(restaurantId, id);

    if (!removed) {
      throw new AppError(404, "Product not found");
    }
  } catch (error) {
    // Something else still points at the dish (an order placed a moment ago).
    if (error.code === "23503") {
      throw new AppError(
        409,
        `"${existing.name}" is still used elsewhere, so it can't be deleted. Archive it instead.`,
        { reason: "in_use", canArchive: true }
      );
    }

    throw error;
  }

  return toProduct(existing);
};

module.exports = {
  setProductImage,
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  editProduct,
  patchProduct,
  setProductAvailability,
  changeAvailability,
  setProductStatus,
  productHistory,
  productUsage,
  removeProduct,
};
