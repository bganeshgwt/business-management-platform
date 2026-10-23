const comboRepository = require("../repositories/combo.repository");
const productRepository = require("../repositories/product.repository");
const menuExtrasRepository = require("../repositories/menuExtras.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { translateMenuRule } = require("./menuCommon");

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toItem = (row) => ({
  id: row.id,
  productId: row.product_id,
  productName: row.product_name,
  productVariantId: row.product_variant_id,
  variantName: row.variant_name,
  quantity: Number(row.quantity),
  // What the parts would cost if bought separately, so the saving is visible.
  partPrice: round2(
    (Number(row.product_price) + Number(row.price_delta || 0)) * Number(row.quantity)
  ),
  // Whether the kitchen can make this part right now. A thali whose dal is
  // sold out cannot be served, and the editor says so.
  isAvailable:
    row.is_available !== false &&
    row.product_status === "active" &&
    (row.variant_status === null || row.variant_status === undefined || row.variant_status === "active"),
  soldOut: row.is_available === false,
  archived: row.product_status !== undefined && row.product_status !== "active",
  sizeOff: row.variant_status === "inactive",
});

const getForProduct = async (restaurantId, comboProductId) => {
  requireRestaurantId(restaurantId);

  const product = await productRepository.findById(restaurantId, comboProductId);

  if (!product) {
    throw new AppError(404, "Product not found");
  }

  const [rows, partOf] = await Promise.all([
    comboRepository.findItems(restaurantId, comboProductId),
    comboRepository.findCombosContaining(restaurantId, comboProductId),
  ]);
  const items = rows.map(toItem);
  const partsTotal = round2(items.reduce((sum, item) => sum + item.partPrice, 0));

  return {
    productId: product.id,
    productName: product.name,
    price: Number(product.price),
    isCombo: product.is_combo,
    isAvailable: product.is_available,
    items,
    partsTotal,
    // Negative means the combo costs more than its parts, which is usually a
    // mistake worth showing rather than hiding.
    saving: round2(partsTotal - Number(product.price)),
    // Parts that are sold out, archived or whose size is switched off.
    unavailableParts: items.filter((item) => !item.isAvailable).map((item) => item.productName),
    // The combos this dish is itself part of. Such a dish cannot become a
    // combo: combos are one level deep, or stock would stop being taken for
    // the inner parts.
    partOf: partOf.map((row) => ({ id: row.id, name: row.name })),
  };
};

// Returns the combo before and after (for the activity log).
const setForProduct = async (restaurantId, comboProductId, items, userId) => {
  requireRestaurantId(restaurantId);

  const combo = await productRepository.findById(restaurantId, comboProductId);

  if (!combo) {
    throw new AppError(404, "Product not found");
  }

  // Emptying a combo is always allowed; filling one is not when the dish is
  // itself inside another combo.
  if (items.length > 0) {
    const partOf = await comboRepository.findCombosContaining(restaurantId, comboProductId);

    if (partOf.length > 0) {
      const names = partOf.map((row) => `"${row.name}"`).join(", ");

      throw new AppError(
        400,
        `"${combo.name}" is part of the combo ${names}, so it cannot become a combo itself. Take it out of ${names} first.`
      );
    }
  }

  const seen = new Set();

  for (const item of items) {
    if (Number(item.productId) === Number(comboProductId)) {
      throw new AppError(400, "A combo cannot contain itself");
    }

    const part = await productRepository.findById(restaurantId, item.productId);

    if (!part) {
      throw new AppError(400, "One of the chosen dishes does not exist");
    }

    // One level only. Nested combos would make stock consumption recursive and
    // the saving impossible to read on screen.
    if (part.is_combo) {
      throw new AppError(400, `"${part.name}" is itself a combo, so it cannot go inside one`);
    }

    if (item.productVariantId) {
      const variant = await menuExtrasRepository.findVariantById(
        restaurantId,
        item.productVariantId
      );

      if (!variant || Number(variant.product_id) !== Number(part.id)) {
        throw new AppError(400, `That size does not belong to "${part.name}"`);
      }
    }

    const key = `${item.productId}:${item.productVariantId || ""}`;

    if (seen.has(key)) {
      throw new AppError(400, `"${part.name}" is listed twice. Change its quantity instead.`);
    }

    seen.add(key);
  }

  const before = await getForProduct(restaurantId, comboProductId);

  // The checks above read the menu before the save's transaction began, so
  // another editor may have changed it since ("put this dish inside a thali"
  // at the same moment). They are asked again under the combo lock, where
  // nothing else can change combos until this save is done.
  const verify = async (client) => {
    if (items.length === 0) {
      return;
    }

    const { combosAsParts, heldBy } = await comboRepository.findNestingConflicts(
      client,
      restaurantId,
      comboProductId,
      items.map((item) => item.productId)
    );

    if (heldBy.length > 0) {
      const names = heldBy.map((row) => `"${row.name}"`).join(", ");

      throw new AppError(
        400,
        `"${combo.name}" was just put inside the combo ${names}, so it cannot become a combo itself. Take it out of ${names} first.`
      );
    }

    if (combosAsParts.length > 0) {
      throw new AppError(
        400,
        `"${combosAsParts[0].name}" was just made a combo itself, so it cannot go inside one`
      );
    }
  };

  try {
    await comboRepository.replaceItems(restaurantId, comboProductId, items, userId, verify);
  } catch (error) {
    throw translateMenuRule(error);
  }

  return { before, combo: await getForProduct(restaurantId, comboProductId) };
};

module.exports = { getForProduct, setForProduct };
