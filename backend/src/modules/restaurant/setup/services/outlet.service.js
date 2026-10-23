const outletRepository = require("../repositories/outlet.repository");
const restaurantRepository = require("../repositories/restaurant.repository");
const AppError = require("../../../../utils/AppError");

// PostgreSQL error codes turned into messages a user can act on.
const DUPLICATE = "23505";
const STILL_REFERENCED = "23503";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// With numbers that restart each financial year an outlet's own prefix must
// leave room for the year inside GST's 16 characters (INV/26-27/00001).
const checkPrefix = async (restaurantId, prefix) => {
  if (!prefix) {
    return;
  }

  const settings = await restaurantRepository.findSettings(restaurantId);
  const max = restaurantRepository.seriesMaxOf(settings);

  if (prefix.length > max) {
    throw new AppError(
      400,
      settings.invoice_numbering === "financial_year"
        ? `Bills here are numbered by financial year (like ${prefix.slice(0, max)}/26-27/0001), so an outlet's prefix can be at most ${max} characters`
        : `An invoice prefix can be at most ${max} characters`
    );
  }
};

// "a, b and c"
const andList = (words) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0]);

// "1,204 bills, 3 tables and 2 floors"
const listWords = (items) => andList(items.map((item) => `${item.count.toLocaleString("en-IN")} ${item.label}`));

// Open pre-orders (booked, in production or ready) are baked from their
// outlet's bake list and handed over there. A closed outlet's list is on no
// till, and a deleted outlet's pre-orders would fall to the main counter's,
// so the outlet stays until they are handed over or cancelled.
// doing: "closed" or "deleted".
const refuseOpenPreorders = async (restaurantId, outlet, doing) => {
  const numbers = await outletRepository.openPreorders(restaurantId, outlet.id);

  if (numbers.length === 0) {
    return;
  }

  const one = numbers.length === 1;
  const named = andList(numbers.length > 4 ? [...numbers.slice(0, 3), `${numbers.length - 3} more`] : numbers);

  throw new AppError(
    409,
    `"${outlet.name}" still has ${numbers.length.toLocaleString("en-IN")} open ${one ? "pre-order" : "pre-orders"} to bake and hand over (${named}), so it cannot be ${doing} yet. Hand ${one ? "it" : "them"} over or cancel ${one ? "it" : "them"} first, in Pre-orders & cakes.`,
    { reason: "outlet_has_open_preorders", preorders: numbers }
  );
};

const list = async (restaurantId) => {
  requireRestaurantId(restaurantId);
  return outletRepository.findAll(restaurantId);
};

const getById = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const outlet = await outletRepository.findById(restaurantId, id);

  if (!outlet) {
    throw new AppError(404, "Outlet not found");
  }

  return outlet;
};

const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  await checkPrefix(restaurantId, data.invoicePrefix);

  try {
    return await outletRepository.create(restaurantId, data, userId);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `An outlet with code "${data.code}" already exists`);
    }

    throw error;
  }
};

const update = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);
  await checkPrefix(restaurantId, data.invoicePrefix);

  // Closing an open outlet (setting it inactive) waits for its open
  // pre-orders. One closed already is saved as usual.
  if (data.status === "inactive") {
    const outlet = await outletRepository.findById(restaurantId, id);

    if (outlet && outlet.status === "active") {
      await refuseOpenPreorders(restaurantId, outlet, "closed");
    }
  }

  try {
    const updated = await outletRepository.update(restaurantId, id, data, userId);

    if (!updated) {
      throw new AppError(404, "Outlet not found");
    }

    return updated;
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `An outlet with code "${data.code}" already exists`);
    }

    throw error;
  }
};

// What is recorded at an outlet, so the screen can say before anyone presses
// Delete whether the outlet can go or should be closed instead.
const usage = async (restaurantId, id) => {
  await getById(restaurantId, id);

  const found = await outletRepository.usage(restaurantId, id);

  return {
    ...found,
    canDelete: found.history.length === 0 && found.setup.length === 0,
    // Anything already sold, bought or counted there has to stay for the
    // accounts; closing the outlet is the way to stop using it.
    mustDeactivate: found.history.length > 0,
  };
};

// An outlet with history is never deleted: its bills, stock and days are
// part of the books and the GST return. It is set inactive instead, which
// stops it taking orders and takes it off the outlet switcher. An outlet
// with only people or tables arranged there can go once they are moved.
// Open pre-orders are checked first: the other two refusals suggest setting
// the outlet inactive instead, and that waits for them too.
const remove = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const outlet = await outletRepository.findById(restaurantId, id);

  if (!outlet) {
    throw new AppError(404, "Outlet not found");
  }

  await refuseOpenPreorders(restaurantId, outlet, "deleted");

  const found = await outletRepository.usage(restaurantId, id);

  if (found.history.length > 0) {
    throw new AppError(
      409,
      `"${outlet.name}" has ${listWords(found.history)} on record, which must stay for your accounts, so it cannot be deleted. Set it to Inactive instead: it stops taking orders and leaves the outlet list.`,
      { reason: "outlet_has_history", history: found.history }
    );
  }

  if (found.setup.length > 0) {
    throw new AppError(
      409,
      `"${outlet.name}" still has ${listWords(found.setup)} assigned to it. Move them to another outlet first, or set the outlet to Inactive.`,
      { reason: "outlet_in_use", setup: found.setup }
    );
  }

  let removed;

  try {
    removed = await outletRepository.remove(restaurantId, id);
  } catch (error) {
    // Something recorded there that the check above does not know about yet
    // (a module added later): still a sentence, never "Internal server error".
    if (error.code === STILL_REFERENCED) {
      throw new AppError(
        409,
        `"${outlet.name}" still has records attached to it, so it cannot be deleted. Set it to Inactive instead.`,
        { reason: "outlet_has_history" }
      );
    }

    throw error;
  }

  // Two people pressing Delete at the same moment both pass the checks above;
  // only one of them actually deletes it. The other is told it is already
  // gone, and no second "deleted" line is written to the activity log.
  if (!removed) {
    throw new AppError(404, `"${outlet.name}" has already been deleted`);
  }

  return outlet;
};

module.exports = {
  list,
  getById,
  create,
  update,
  usage,
  remove,
};
