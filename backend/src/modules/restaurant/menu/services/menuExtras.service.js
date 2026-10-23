const menuExtrasRepository = require("../repositories/menuExtras.repository");
const productRepository = require("../repositories/product.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { rupees, translateMenuRule } = require("./menuCommon");

const DUPLICATE = "23505";
const STILL_REFERENCED = "23503";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toVariant = (row) => ({
  id: row.id,
  productId: row.product_id,
  name: row.name,
  priceDelta: Number(row.price_delta),
  isDefault: row.is_default,
  sortOrder: row.sort_order,
  status: row.status,
  // The size's name on the KOT ("हाफ"), null when none is set.
  kitchenName: row.kitchen_name || null,
  // How many order lines carried this size: one sold is kept (switched off),
  // never deleted, so the screen offers "Switch off" instead of "Remove".
  ...(row.times_sold !== undefined ? { timesSold: row.times_sold } : {}),
  // The combos built with this exact size ("Lassi Meal" uses the Small): it
  // cannot be removed while they do, so the screen says so instead.
  ...(row.combos !== undefined ? { combos: row.combos || [] } : {}),
});

// A size sent as what the guest pays is stored as its difference from the
// dish price as it is now.
const withDelta = (product, data) => {
  if (data.price === undefined) {
    return data;
  }

  const { price, ...rest } = data;

  return { ...rest, priceDelta: round2(price - Number(product.price)) };
};

const toModifier = (row) => ({
  id: row.id,
  name: row.name,
  price: Number(row.price),
  status: row.status,
  // The add-on's name on the KOT, null when none is set.
  kitchenName: row.kitchen_name || null,
  productCount: row.product_count,
  ...(row.times_sold !== undefined ? { timesSold: row.times_sold } : {}),
});

const requireOwnProduct = async (restaurantId, productId) => {
  const product = await productRepository.findById(restaurantId, productId);

  if (!product) {
    throw new AppError(404, "Product not found");
  }

  return product;
};

// A size that is on sale may never cost less than zero: the till cannot ring
// up a negative line. A switched-off size cannot be sold, so it is checked
// again when it is switched back on.
const requireSizePriced = (product, data) => {
  const final = round2(Number(product.price) + data.priceDelta);

  if (data.status === "active" && final < 0) {
    throw new AppError(
      400,
      `At the dish price of ${rupees(product.price)}, "${data.name}" would cost ${rupees(final)}. ` +
        "A size can't cost less than zero: make the difference smaller."
    );
  }
};

// --- Variants ---

const listVariants = async (restaurantId, productId) => {
  requireRestaurantId(restaurantId);
  await requireOwnProduct(restaurantId, productId);

  const rows = await menuExtrasRepository.findVariants(restaurantId, productId);
  return rows.map(toVariant);
};

// Returns the size and the dish it belongs to (for the activity log).
const createVariant = async (restaurantId, productId, input, userId) => {
  requireRestaurantId(restaurantId);
  const product = await requireOwnProduct(restaurantId, productId);
  const data = withDelta(product, input);

  requireSizePriced(product, data);

  try {
    const row = await menuExtrasRepository.createVariant(
      restaurantId,
      { ...data, productId },
      userId
    );

    return { variant: toVariant(row), product };
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `This product already has a variant named "${data.name}"`);
    }

    throw translateMenuRule(error);
  }
};

// Returns the size before and after, and its dish, so the log can say
// "Half: ₹150 -> ₹140". Only the fields the edit gives are written; the rest
// keep what the size has (and the price check uses those).
const updateVariant = async (restaurantId, id, input, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await menuExtrasRepository.findVariantById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Variant not found");
  }

  const product = await requireOwnProduct(restaurantId, existing.product_id);
  const changes = withDelta(product, input);
  const keep = (value, current) => (value === undefined ? current : value);

  requireSizePriced(product, {
    name: keep(changes.name, existing.name),
    priceDelta: keep(changes.priceDelta, Number(existing.price_delta)),
    status: keep(changes.status, existing.status),
  });

  try {
    const row = await menuExtrasRepository.updateVariant(
      restaurantId,
      id,
      existing.product_id,
      changes,
      userId
    );

    if (!row) {
      throw new AppError(404, "Variant not found");
    }

    return { before: toVariant(existing), variant: toVariant(row), product };
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `This product already has a variant named "${changes.name}"`);
    }

    throw translateMenuRule(error);
  }
};

// A size that has been sold stays (past bills name it) and is switched off
// instead; one a combo is built from must come out of the combo first.
const removeVariant = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await menuExtrasRepository.findVariantById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Variant not found");
  }

  const product = await requireOwnProduct(restaurantId, existing.product_id);
  const combos = await menuExtrasRepository.findCombosUsingVariant(restaurantId, id);

  if (combos.length > 0) {
    throw new AppError(
      409,
      `"${existing.name}" is used in the combo ${combos.map((row) => `"${row.name}"`).join(", ")}. Take it out of the combo first.`,
      { reason: "in_combo", combos: combos.map((row) => ({ id: row.id, name: row.name })) }
    );
  }

  const timesSold = await menuExtrasRepository.countVariantOrderLines(restaurantId, id);

  if (timesSold > 0) {
    throw new AppError(
      409,
      `"${existing.name}" has already been sold (on ${timesSold} order${timesSold === 1 ? "" : "s"}), so it can't be deleted: past bills need it. ` +
        "Switch it off instead. It disappears from the POS and the QR menu, and its history stays.",
      { reason: "has_sales", timesSold, canArchive: true }
    );
  }

  try {
    await menuExtrasRepository.removeVariant(restaurantId, id);
  } catch (error) {
    if (error.code === STILL_REFERENCED) {
      throw new AppError(409, `"${existing.name}" is still used elsewhere. Switch it off instead.`, {
        reason: "in_use",
        canArchive: true,
      });
    }

    throw error;
  }

  return { variant: toVariant(existing), product };
};

// --- Modifiers ---

const listModifiers = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await menuExtrasRepository.findModifiers(restaurantId);
  return rows.map(toModifier);
};

const createModifier = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    return toModifier(await menuExtrasRepository.createModifier(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A modifier named "${data.name}" already exists`);
    }

    throw error;
  }
};

// Returns the add-on before and after, for the activity log.
const updateModifier = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await menuExtrasRepository.findModifierById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Modifier not found");
  }

  try {
    const row = await menuExtrasRepository.updateModifier(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Modifier not found");
    }

    return { before: toModifier(existing), modifier: toModifier(row) };
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A modifier named "${data.name || existing.name}" already exists`);
    }

    throw error;
  }
};

// An add-on that has been sold stays (past bills name it) and is switched off
// instead. One never sold goes, and its links to dishes with it.
const removeModifier = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const modifier = await menuExtrasRepository.findModifierById(restaurantId, id);

  if (!modifier) {
    throw new AppError(404, "Modifier not found");
  }

  const timesSold = await menuExtrasRepository.countModifierSales(restaurantId, id);

  if (timesSold > 0) {
    throw new AppError(
      409,
      `"${modifier.name}" has been sold ${timesSold} time${timesSold === 1 ? "" : "s"}, so it can't be deleted: past bills need it. ` +
        "Switch it off instead. It stops being offered on every dish, and its history stays.",
      { reason: "has_sales", timesSold, canArchive: true }
    );
  }

  try {
    // The link rows disappear with it (ON DELETE CASCADE), which is intended here.
    await menuExtrasRepository.removeModifier(restaurantId, id);
  } catch (error) {
    if (error.code === STILL_REFERENCED) {
      throw new AppError(409, `"${modifier.name}" is still used elsewhere. Switch it off instead.`, {
        reason: "in_use",
        canArchive: true,
      });
    }

    throw error;
  }

  return toModifier(modifier);
};

// --- Product ↔ modifier links ---

const listProductModifiers = async (restaurantId, productId) => {
  requireRestaurantId(restaurantId);
  await requireOwnProduct(restaurantId, productId);

  return menuExtrasRepository.findProductModifierIds(productId);
};

const modifierNames = (all, ids) =>
  all
    .filter((row) => ids.includes(row.id))
    .map((row) => row.name)
    .sort();

// Returns the ids now linked plus the names before and after, for the log.
const setProductModifiers = async (restaurantId, productId, modifierIds, userId) => {
  requireRestaurantId(restaurantId);
  const product = await requireOwnProduct(restaurantId, productId);

  if (modifierIds.length > 0) {
    const allowed = await menuExtrasRepository.findModifierIdsForRestaurant(
      restaurantId,
      modifierIds
    );

    if (allowed.length !== modifierIds.length) {
      throw new AppError(400, "One or more modifiers do not exist");
    }
  }

  const [all, beforeIds] = await Promise.all([
    menuExtrasRepository.findModifiers(restaurantId),
    menuExtrasRepository.findProductModifierIds(productId),
  ]);
  const saved = await menuExtrasRepository.replaceProductModifiers(productId, modifierIds, userId);

  return {
    ids: saved,
    product,
    before: modifierNames(all, beforeIds),
    after: modifierNames(all, saved),
  };
};

module.exports = {
  listVariants,
  createVariant,
  updateVariant,
  removeVariant,
  listModifiers,
  createModifier,
  updateModifier,
  removeModifier,
  listProductModifiers,
  setProductModifiers,
};
