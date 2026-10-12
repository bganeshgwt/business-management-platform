const taxRateRepository = require("../repositories/taxRate.repository");
const AppError = require("../../../../utils/AppError");

const DUPLICATE = "23505";
const IN_USE = "23503";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toTaxRate = (row) => ({
  id: row.id,
  name: row.name,
  percentage: Number(row.percentage),
  hsnCode: row.hsn_code,
  cessPercentage: Number(row.cess_percentage),
  isDefault: row.is_default,
  status: row.status,
  productCount: row.product_count,
  repricedProducts: row.repriced_products,
  movedProducts: row.moved_products,
});

const list = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  const rows = await taxRateRepository.findAll(restaurantId, filters);
  return rows.map(toTaxRate);
};

const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  // The rate new dishes start on has to be one that is charged.
  if (data.status === "inactive" && data.isDefault) {
    throw new AppError(400, "The default rate has to be on");
  }

  try {
    return toTaxRate(await taxRateRepository.create(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A tax rate with this name already exists");
    }

    throw error;
  }
};

// A rate that is switched off is charged on nothing new. Switching one off
// used to leave its dishes selling at it anyway, so now a rate cannot go off
// while any dish still uses it: the screen is told which dishes, and moves
// them to another rate in the same step (moveProductsTo). The default rate —
// what a new dish starts on — cannot go off at all.
const update = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await taxRateRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Tax rate not found");
  }

  if (data.moveProductsTo) {
    if (Number(data.moveProductsTo) === Number(id)) {
      throw new AppError(400, "Pick a different rate to move the dishes to");
    }

    const target = await taxRateRepository.findById(restaurantId, data.moveProductsTo);

    if (!target) {
      throw new AppError(400, "The rate to move the dishes to does not exist");
    }

    if (target.status !== "active") {
      throw new AppError(400, `"${target.name}" is switched off too. Move the dishes to a rate that is on.`);
    }
  }

  if (data.status === "inactive") {
    if (data.isDefault || existing.is_default) {
      throw new AppError(
        400,
        `"${existing.name}" is the default rate new dishes start on. Make another rate the default before switching this one off.`
      );
    }

    const { rows, total } = await taxRateRepository.findProducts(restaurantId, id);

    if (total > 0 && !data.moveProductsTo) {
      const names = rows.map((row) => row.name);
      const more = total > names.length ? ` and ${total - names.length} more` : "";

      throw new AppError(
        409,
        `${total} dish${total === 1 ? " still uses" : "es still use"} "${existing.name}" (${names.join(", ")}${more}). ` +
          "A rate that is off is not charged on new sales, so choose the rate to move them to, then switch it off.",
        {
          reason: "rate_in_use",
          dishCount: total,
          dishes: rows.map((row) => ({ id: row.id, name: row.name, status: row.status })),
        }
      );
    }
  }

  try {
    const row = await taxRateRepository.update(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Tax rate not found");
    }

    return toTaxRate(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A tax rate with this name already exists");
    }

    throw error;
  }
};

// A rate in use is never deleted: old bills reference the percentage it set, and
// the dishes would be left with no rate at all.
const remove = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const inUse = await taxRateRepository.countProducts(restaurantId, id);

  if (inUse > 0) {
    throw new AppError(
      409,
      `${inUse} dish${inUse === 1 ? " uses" : "es use"} this rate. Switch it off instead and move its dishes to another rate in the same step.`
    );
  }

  try {
    const removed = await taxRateRepository.remove(restaurantId, id);

    if (!removed) {
      throw new AppError(404, "Tax rate not found");
    }
  } catch (error) {
    if (error.code === IN_USE) {
      throw new AppError(409, "This tax rate is still in use");
    }

    throw error;
  }
};

module.exports = { list, create, update, remove };
