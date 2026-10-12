const priceWindowRepository = require("../repositories/priceWindow.repository");
const productRepository = require("../repositories/product.repository");
const menuExtrasRepository = require("../repositories/menuExtras.repository");
const outletRepository = require("../../setup/repositories/outlet.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

const DUPLICATE = "23505";
const IN_USE = "23503";

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
  price: Number(row.price),
  normalPrice: round2(Number(row.normal_price) + Number(row.price_delta || 0)),
  // The dish's own menu price, before any size.
  basePrice: Number(row.normal_price),
});

const toWindow = (row) => ({
  id: row.id,
  outletId: row.outlet_id,
  outletName: row.outlet_name,
  name: row.name,
  daysOfWeek: row.days_of_week,
  // TIME comes back as "16:00:00"; the form only ever shows hours and minutes.
  startTime: String(row.start_time).slice(0, 5),
  endTime: String(row.end_time).slice(0, 5),
  validFrom: row.valid_from,
  validTo: row.valid_to,
  priority: row.priority,
  status: row.status,
  itemCount: row.item_count,
  items: row.items ? row.items.map(toItem) : undefined,
});

const list = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  return (await priceWindowRepository.findAll(restaurantId, filters)).map(toWindow);
};

const getById = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const row = await priceWindowRepository.findById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Price window not found");
  }

  return toWindow(row);
};

// A window tied to an outlet applies there and nowhere else, so the outlet
// must be one of this restaurant's own. Another restaurant's outlet id is
// treated exactly like one that does not exist.
const requireOwnOutlet = async (restaurantId, outletId) => {
  if (!outletId) {
    return;
  }

  const outlet = await outletRepository.findById(restaurantId, outletId);

  if (!outlet) {
    throw new AppError(400, "That outlet does not exist");
  }
};

const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  await requireOwnOutlet(restaurantId, data.outletId);

  try {
    return toWindow(await priceWindowRepository.create(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A price window with this name already exists");
    }

    throw error;
  }
};

const update = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);
  await requireOwnOutlet(restaurantId, data.outletId);

  try {
    const row = await priceWindowRepository.update(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Price window not found");
    }

    return toWindow(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A price window with this name already exists");
    }

    throw error;
  }
};

const remove = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  try {
    const removed = await priceWindowRepository.remove(restaurantId, id);

    if (!removed) {
      throw new AppError(404, "Price window not found");
    }
  } catch (error) {
    // Orders record the window that priced them, so one that has already been
    // used is kept: deleting it would erase why a dish went out cheaper.
    if (error.code === IN_USE) {
      throw new AppError(
        409,
        "Orders were priced by this window, so it cannot be deleted. Switch it off instead."
      );
    }

    throw error;
  }
};

const setItems = async (restaurantId, id, items, userId) => {
  requireRestaurantId(restaurantId);

  await getById(restaurantId, id);

  const seen = new Set();

  for (const item of items) {
    const product = await productRepository.findById(restaurantId, item.productId);

    if (!product) {
      throw new AppError(400, "One of the chosen dishes does not exist");
    }

    if (item.productVariantId) {
      const variant = await menuExtrasRepository.findVariantById(
        restaurantId,
        item.productVariantId
      );

      if (!variant || Number(variant.product_id) !== Number(product.id)) {
        throw new AppError(400, `That size does not belong to "${product.name}"`);
      }
    }

    const key = `${item.productId}:${item.productVariantId || ""}`;

    if (seen.has(key)) {
      throw new AppError(400, `"${product.name}" is listed twice in this window`);
    }

    seen.add(key);
  }

  return toWindow(await priceWindowRepository.replaceItems(restaurantId, id, items, userId));
};

module.exports = { list, getById, create, update, remove, setItems };
