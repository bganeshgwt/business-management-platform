const dishWasteRepository = require("../repositories/dishWaste.repository");
const inventoryRepository = require("../repositories/inventory.repository");
const inventoryInsightService = require("./inventoryInsight.service");
const { pinnedStore } = require("./inventory.service");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// A finished dish written off by its recipe (sweep SW-B-22).
//
// "2 × Paneer Butter Masala, remade" takes the dish's recipe for that size —
// a combo through its dishes, the add-ons chosen through theirs, sub-recipes
// as the prepared items they are — out of the outlet's store at cost, as
// ordinary wastage rows. So it is counted on Waste & reorder, in the stock
// consumption report, in P&L wastage and in Theft control, with who logged
// it. A manager can undo it within the week, like any other wastage.

const REASONS = [
  { key: "dropped", label: "Dropped at the pass" },
  { key: "remade", label: "Remade (made twice, billed once)" },
  { key: "spoiled", label: "Spoiled / left over" },
  { key: "quality", label: "Quality complaint" },
];
const REASON_KEYS = REASONS.map((reason) => reason.key);
const reasonLabel = (key) => (REASONS.find((reason) => reason.key === key) || { label: key }).label;

const MAX_PLATES = 500;
const REVERSE_WINDOW_DAYS = 7;

const round3 = (value) => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;

const addDays = (isoDate, days) => {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10);
};

// Every check, made before anything is written — and before a manager is
// asked for a PIN when the dish is worth more than the write-off limit, so an
// approval is never spent on an entry that is then refused. Returns the dish,
// what it takes from stock and what that is worth.
const prepare = async (restaurantId, data) => {
  const found = await dishWasteRepository.findDish(restaurantId, data.productId);

  if (!found) {
    throw new AppError(400, "Pick the dish that was thrown away");
  }

  const { product } = found;
  let variant = null;

  if (data.variantId) {
    const withSize = await dishWasteRepository.findDish(restaurantId, data.productId, data.variantId);

    if (!withSize.variant) {
      throw new AppError(400, `That size is not one of ${product.name}'s sizes`);
    }

    variant = withSize.variant;
  }

  if (!Number.isInteger(data.quantity) || data.quantity < 1 || data.quantity > MAX_PLATES) {
    throw new AppError(400, `Enter how many plates, from 1 to ${MAX_PLATES}`);
  }

  if (!REASON_KEYS.includes(data.reason)) {
    throw new AppError(400, "Pick why the dish was thrown away: dropped, remade, spoiled or a quality complaint");
  }

  const modifierIds = [...new Set(data.modifierIds || [])];
  const modifiers = await dishWasteRepository.findModifiers(restaurantId, modifierIds);

  if (modifiers.length !== modifierIds.length) {
    throw new AppError(400, "One of the add-ons picked does not exist");
  }

  const storeId = await inventoryRepository.storeFor(inventoryRepository.pool, restaurantId, data.outletId || null);
  const ingredients = await dishWasteRepository.findIngredients(
    restaurantId,
    {
      productId: product.id,
      variantId: variant ? variant.id : null,
      isCombo: product.is_combo,
      modifierIds,
      quantity: data.quantity,
    },
    storeId
  );

  const itemName = variant ? `${product.name} (${variant.name})` : product.name;

  if (ingredients.length === 0) {
    throw new AppError(
      400,
      `${itemName} has no recipe, so there is nothing to take out of stock. Add its recipe under Menu → Products, or log the ingredients one by one.`
    );
  }

  const value = round2(ingredients.reduce((sum, line) => sum + round2(line.quantity * line.unitCost), 0));

  return {
    product,
    variant,
    modifiers,
    itemName,
    storeId,
    ingredients,
    value,
    // For the manager's PIN: an approval is tied to the dish, the plates and
    // the value it was given for.
    quantity: data.quantity,
    productId: Number(product.id),
  };
};

const toEntry = (row, today) => ({
  id: Number(row.id),
  date: row.waste_date,
  loggedAt: row.created_at,
  productId: Number(row.product_id),
  variantId: row.product_variant_id === null ? null : Number(row.product_variant_id),
  itemName: row.item_name,
  quantity: Number(row.quantity),
  reason: row.reason,
  reasonLabel: reasonLabel(row.reason),
  note: row.note,
  addons: row.addons || [],
  value: Number(row.value),
  ingredientLines: Number(row.ingredient_lines),
  loggedBy: row.logged_by || null,
  store: row.store_name,
  reversed: Boolean(row.reversed_at),
  reversedAt: row.reversed_at || null,
  reversedBy: row.reversed_by || null,
  reversalNote: row.reversal_note || null,
  reversible: !row.reversed_at && Boolean(today) && row.waste_date >= addDays(today, -REVERSE_WINDOW_DAYS),
});

const log = async (restaurantId, data, userId, prepared = null) => {
  const ready = prepared || (await prepare(restaurantId, data));
  const context = await inventoryInsightService.getContext(restaurantId);

  const { id } = await dishWasteRepository.create(
    restaurantId,
    {
      outletId: data.outletId || null,
      productId: ready.product.id,
      variantId: ready.variant ? ready.variant.id : null,
      itemName: ready.itemName,
      quantity: data.quantity,
      reason: data.reason,
      reasonLabel: reasonLabel(data.reason),
      note: data.note || null,
      addons: ready.modifiers.map((modifier) => ({ modifierId: Number(modifier.id), name: modifier.name })),
      wasteDate: context.businessDate,
    },
    ready.ingredients,
    userId
  );

  inventoryInsightService.planChanged(restaurantId);

  return get(restaurantId, id);
};

const get = async (restaurantId, id) => {
  const row = await dishWasteRepository.findById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Dish write-off not found");
  }

  const [context, lines] = await Promise.all([
    inventoryInsightService.getContext(restaurantId),
    dishWasteRepository.findLines(restaurantId, id),
  ]);

  return {
    ...toEntry(row, context.businessDate),
    ingredients: lines.map((line) => ({
      inventoryItemId: Number(line.inventory_item_id),
      name: line.name,
      unit: line.unit,
      quantity: round3(line.quantity),
      value: Number(line.value),
    })),
  };
};

const list = async (restaurantId, { from, to, limit = 100 }, { store = null } = {}) => {
  const context = await inventoryInsightService.getContext(restaurantId);
  const end = to || context.businessDate;
  const start = from || addDays(end, -6);
  const { rows, total } = await dishWasteRepository.findAll(restaurantId, { from: start, to: end, store, limit });
  const items = rows.map((row) => toEntry(row, context.businessDate));
  const standing = items.filter((entry) => !entry.reversed);

  return {
    from: start,
    to: end,
    reasons: REASONS,
    reverseWindowDays: REVERSE_WINDOW_DAYS,
    summary: {
      entries: standing.length,
      plates: standing.reduce((sum, entry) => sum + entry.quantity, 0),
      value: round2(standing.reduce((sum, entry) => sum + entry.value, 0)),
    },
    items,
    total,
  };
};

// Someone tied to one outlet undoes only their own store's entries.
const reverse = async (restaurantId, id, note, userId, { pinnedOutletId = null } = {}) => {
  const row = await dishWasteRepository.findById(restaurantId, id);
  const store = await pinnedStore(restaurantId, pinnedOutletId);

  if (!row || (store && (row.store_id === null ? null : Number(row.store_id)) !== store.storeId)) {
    throw new AppError(404, "Dish write-off not found");
  }

  if (row.reversed_at) {
    throw new AppError(409, `This write-off was already undone${row.reversed_by ? ` by ${row.reversed_by}` : ""}`);
  }

  const context = await inventoryInsightService.getContext(restaurantId);

  if (row.waste_date < addDays(context.businessDate, -REVERSE_WINDOW_DAYS)) {
    throw new AppError(
      409,
      `Write-offs older than ${REVERSE_WINDOW_DAYS} days cannot be undone — the stock has been counted since. Correct it with Stock in on Items & stock.`
    );
  }

  const result = await dishWasteRepository.reverse(restaurantId, id, note, userId);

  if (result.error === "ALREADY") {
    throw new AppError(409, "This write-off was already undone");
  }

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Dish write-off not found");
  }

  inventoryInsightService.planChanged(restaurantId);

  return get(restaurantId, id);
};

const pickable = async (restaurantId) => {
  const { dishes, addOns } = await dishWasteRepository.findPickable(restaurantId);

  return {
    reasons: REASONS,
    dishes: dishes.map((row) => ({
      id: Number(row.id),
      name: row.name,
      code: row.code,
      category: row.category,
      foodType: row.food_type,
      isCombo: row.is_combo,
      sizes: (row.sizes || []).map((size) => ({ id: Number(size.id), name: size.name })),
      hasRecipe: row.has_recipe,
    })),
    addOns: addOns.map((row) => ({ id: Number(row.id), name: row.name })),
  };
};

module.exports = {
  REASONS,
  REASON_KEYS,
  prepare,
  log,
  get,
  list,
  reverse,
  pickable,
};
