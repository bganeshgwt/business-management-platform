const recipeRepository = require("../repositories/recipe.repository");
const productRepository = require("../repositories/product.repository");
const inventoryRepository = require("../../inventory/repositories/inventory.repository");
const menuExtrasRepository = require("../repositories/menuExtras.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

const DUPLICATE = "23505";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toLine = (row) => ({
  id: row.id,
  productVariantId: row.product_variant_id,
  variantName: row.variant_name,
  inventoryItemId: row.inventory_item_id,
  itemName: row.item_name,
  unitShortName: row.unit_short_name,
  quantity: Number(row.quantity),
  lastCost: row.last_cost === null ? null : Number(row.last_cost),
  lineCost: round2(Number(row.quantity) * Number(row.last_cost || 0)),
});

const costing = (cost, price) => ({
  foodCost: round2(cost),
  margin: round2(price - cost),
  // Food cost percentage is the number restaurants watch; under ~35% is healthy.
  foodCostPercentage: price > 0 ? round2((cost / price) * 100) : 0,
});

// Purchase prices and margins are management figures. Floor staff read a
// recipe for what is in a dish (allergies, "no onion?"), not what it costs,
// so for them every cost figure is left out rather than zeroed.
const hideCosts = (recipe) => ({
  ...recipe,
  costsVisible: false,
  foodCost: null,
  margin: null,
  foodCostPercentage: null,
  lines: recipe.lines.map((line) => ({ ...line, lastCost: null, lineCost: null })),
  sizes: recipe.sizes.map((size) => ({
    ...size,
    foodCost: null,
    margin: null,
    foodCostPercentage: null,
  })),
});

// The recipe, plus what the dish costs to make and what that leaves as margin
// — for the dish and for every size it is sold in, saying which recipe each
// size actually uses when it is billed.
const listForProduct = async (restaurantId, productId, { showCosts = true } = {}) => {
  requireRestaurantId(restaurantId);

  const product = await productRepository.findById(restaurantId, productId);

  if (!product) {
    throw new AppError(404, "Product not found");
  }

  const rows = await recipeRepository.findByProduct(restaurantId, productId);
  const variants = await recipeRepository.findVariants(restaurantId, productId);
  const lines = rows.map(toLine);
  const dishLines = lines.filter((line) => line.productVariantId === null);
  const baseCost = dishLines.reduce((sum, line) => sum + line.lineCost, 0);
  const price = Number(product.price);

  const sizes = variants.map((variant) => {
    const own = lines.filter((line) => Number(line.productVariantId) === Number(variant.id));
    const factor = variant.recipe_factor === null ? null : Number(variant.recipe_factor);
    const source = own.length > 0 ? "own" : factor !== null ? "factor" : "dish";
    const cost =
      source === "own"
        ? own.reduce((sum, line) => sum + line.lineCost, 0)
        : baseCost * (factor ?? 1);
    const sizePrice = round2(price + Number(variant.price_delta));

    return {
      id: variant.id,
      name: variant.name,
      price: sizePrice,
      isDefault: variant.is_default,
      status: variant.status,
      recipeFactor: factor,
      // own: its own recipe · factor: the dish recipe × factor ·
      // dish: the dish recipe at full quantity (worth a second look).
      source,
      lineCount: own.length,
      ...costing(cost, sizePrice),
    };
  });

  const recipe = {
    productId: product.id,
    productName: product.name,
    price,
    lines,
    sizes,
    dishLineCount: dishLines.length,
    costsVisible: true,
    ...costing(baseCost, price),
  };

  return showCosts ? recipe : hideCosts(recipe);
};

const requireOwnVariant = async (restaurantId, productId, variantId) => {
  const variant = await menuExtrasRepository.findVariantById(restaurantId, variantId);

  if (!variant || Number(variant.product_id) !== Number(productId)) {
    throw new AppError(400, "That size does not belong to this product");
  }

  return variant;
};

const addLine = async (restaurantId, productId, data, userId) => {
  requireRestaurantId(restaurantId);

  const product = await productRepository.findById(restaurantId, productId);

  if (!product) {
    throw new AppError(404, "Product not found");
  }

  const item = await inventoryRepository.findItemById(restaurantId, data.inventoryItemId);

  if (!item) {
    throw new AppError(400, "Selected inventory item does not exist");
  }

  if (data.productVariantId) {
    await requireOwnVariant(restaurantId, productId, data.productVariantId);
  }

  try {
    await recipeRepository.create(restaurantId, { ...data, productId }, userId);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `"${item.name}" is already in this recipe`);
    }

    throw error;
  }

  return listForProduct(restaurantId, productId);
};

// Gives a size its own recipe, starting from the dish's scaled by `factor`.
const copyDishToSize = async (restaurantId, productId, variantId, factor, userId) => {
  requireRestaurantId(restaurantId);

  const product = await productRepository.findById(restaurantId, productId);

  if (!product) {
    throw new AppError(404, "Product not found");
  }

  await requireOwnVariant(restaurantId, productId, variantId);

  const copied = await recipeRepository.copyDishToSize(restaurantId, productId, variantId, factor, userId);

  if (copied === 0) {
    const recipe = await listForProduct(restaurantId, productId);

    if (recipe.dishLineCount === 0) {
      throw new AppError(400, "The dish has no recipe to copy yet. Add its ingredients first.");
    }
  }

  return listForProduct(restaurantId, productId);
};

const updateLine = async (restaurantId, id, quantity, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await recipeRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Recipe line not found");
  }

  await recipeRepository.update(restaurantId, id, quantity, userId);
  return listForProduct(restaurantId, existing.product_id);
};

const removeLine = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await recipeRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Recipe line not found");
  }

  await recipeRepository.remove(restaurantId, id);
  return listForProduct(restaurantId, existing.product_id);
};

// How much of the dish recipe a size without its own recipe uses. Cleared
// (null), the size uses the dish recipe at full quantity.
const setSizeFactor = async (restaurantId, variantId, factor, userId) => {
  requireRestaurantId(restaurantId);

  const variant = await recipeRepository.findVariantById(restaurantId, variantId);

  if (!variant) {
    throw new AppError(404, "Size not found");
  }

  await recipeRepository.setVariantFactor(restaurantId, variantId, factor, userId);

  return { variant, recipe: await listForProduct(restaurantId, variant.product_id) };
};

module.exports = {
  listForProduct,
  addLine,
  copyDishToSize,
  updateLine,
  removeLine,
  setSizeFactor,
};
