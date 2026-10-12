const availabilityRepository = require("../repositories/availability.repository");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const AppError = require("../../../../utils/AppError");

// The quick sold-out switch ("86 a dish"): what cannot be sold tonight, set
// from the POS or the kitchen in two taps, by staff who may not change the
// menu itself. It lasts for the business day it was set in.

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const dishLabel = (productName, variantName) =>
  variantName ? `${productName} (${variantName})` : productName;

const toSoldOut = (row) => ({
  id: row.id,
  productId: row.product_id,
  productVariantId: row.product_variant_id || null,
  productName: row.product_name,
  productCode: row.product_code || null,
  variantName: row.variant_name || null,
  label: dishLabel(row.product_name, row.variant_name),
  categoryName: row.category_name,
  note: row.note || null,
  soldOutAt: row.created_at,
  markedByName: row.marked_by_name || null,
});

// The whole picture for one screen: the day's list, the dishes switched off
// on the menu, and what came back on earlier today.
const list = async (restaurantId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const day = await businessDayRepository.findOpen(restaurantId, outletId);
  const [soldOut, switchedOff, restored] = await Promise.all([
    availabilityRepository.findSoldOut(restaurantId, outletId),
    availabilityRepository.findSwitchedOff(restaurantId),
    availabilityRepository.findRestoredToday(restaurantId, 20, outletId),
  ]);

  return {
    businessDay: day ? { id: day.id, businessDate: day.business_date } : null,
    items: soldOut.map(toSoldOut),
    switchedOff: switchedOff.map((row) => ({
      productId: row.product_id,
      productName: row.product_name,
      productCode: row.product_code || null,
      categoryName: row.category_name,
    })),
    backOnToday: restored.map((row) => ({
      id: row.id,
      productId: row.product_id,
      productVariantId: row.product_variant_id || null,
      label: dishLabel(row.product_name, row.variant_name),
      soldOutAt: row.created_at,
      backOnAt: row.restored_at,
      markedByName: row.marked_by_name || null,
      backOnByName: row.restored_by_name || null,
    })),
  };
};

// Marks a dish, or one of its sizes, sold out for the day, or puts it back.
//   input = { productId, productVariantId, soldOut, note }
// Returns { changed, label, businessDate, list }.
const setSoldOut = async (restaurantId, input, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const product = await availabilityRepository.findProduct(restaurantId, input.productId);

  if (!product) {
    throw new AppError(404, "That dish is not on this restaurant's menu");
  }

  let variant = null;

  if (input.productVariantId) {
    variant = await availabilityRepository.findVariant(restaurantId, product.id, input.productVariantId);

    if (!variant) {
      throw new AppError(400, `That size does not belong to "${product.name}"`);
    }
  }

  const label = dishLabel(product.name, variant ? variant.name : null);
  const day = await businessDayRepository.findOpen(restaurantId, outletId);

  // Sold out "for today" needs a today. With no day open nothing can be
  // ordered anyway, and a mark made now would belong to no day at all.
  if (!day) {
    throw new AppError(
      409,
      `No business day is open, so "${label}" cannot be marked for today. Open the day first.`
    );
  }

  const where = {
    businessDayId: day.id,
    productId: product.id,
    variantId: variant ? variant.id : null,
  };

  let changed;

  if (input.soldOut) {
    ({ created: changed } = await availabilityRepository.markSoldOut(
      restaurantId,
      { ...where, note: input.note },
      userId
    ));
  } else {
    ({ restored: changed } = await availabilityRepository.restore(restaurantId, where, userId));
  }

  let message;

  if (input.soldOut) {
    message = changed
      ? `${label} is sold out for today. It comes back on sale by itself when the next business day opens.`
      : `${label} was already marked sold out for today.`;
  } else if (changed) {
    message = `${label} is back on sale.`;
  } else {
    message = product.is_available
      ? `${label} was not marked sold out today.`
      : `${label} was not marked sold out today. It is switched off on the menu itself: switch it on under Menu → Products.`;
  }

  return {
    changed,
    label,
    product: { id: product.id, name: product.name },
    variant: variant ? { id: variant.id, name: variant.name } : null,
    businessDate: day.business_date,
    message,
    list: await list(restaurantId, outletId),
  };
};

// The dishes the kitchen can mark, for its search box.
const dishes = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  return (await availabilityRepository.findDishes(restaurantId)).map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code || null,
    foodType: row.food_type,
    isAvailable: row.is_available,
    categoryName: row.category_name,
    variants: (row.variants || []).map((variant) => ({ id: variant.id, name: variant.name, status: variant.status })),
  }));
};

module.exports = {
  dishes,
  list,
  setSoldOut,
};
