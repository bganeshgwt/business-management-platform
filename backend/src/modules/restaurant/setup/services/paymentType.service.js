const paymentTypeRepository = require("../repositories/paymentType.repository");
const AppError = require("../../../../utils/AppError");

// Owner-named payment types under a method (sweep SW-B-18). The method still
// decides where the money is (cash in the drawer, the rest at the bank); the
// type says exactly what it was — a Pluxee meal card, a cheque — so its
// settlement can be totalled.

const METHOD_WORDS = {
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  online: "Online",
  wallet: "Wallet",
  other: "Other",
};

const toType = (row) => ({
  id: row.id,
  paymentMethod: row.payment_method,
  methodLabel: METHOD_WORDS[row.payment_method] || row.payment_method,
  name: row.name,
  needsReference: row.needs_reference,
  status: row.status,
  sortOrder: row.sort_order,
  usedCount: row.used_count === undefined ? undefined : Number(row.used_count),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const list = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  return (await paymentTypeRepository.findAll(restaurantId)).map(toType);
};

const assertNameFree = async (restaurantId, method, name, exceptId = null) => {
  if (await paymentTypeRepository.findByName(restaurantId, method, name, exceptId)) {
    throw new AppError(409, `"${name}" already exists under ${METHOD_WORDS[method] || method}`);
  }
};

const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  await assertNameFree(restaurantId, data.paymentMethod, data.name);

  return toType(await paymentTypeRepository.create(restaurantId, data, userId));
};

const update = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const current = await paymentTypeRepository.findById(restaurantId, id);

  if (!current) {
    throw new AppError(404, "Payment type not found");
  }

  await assertNameFree(restaurantId, current.payment_method, data.name, id);

  return { before: toType(current), after: toType(await paymentTypeRepository.update(restaurantId, id, data, userId)) };
};

// A type that was ever used is switched off instead: the payments taken with
// it keep its name in every report.
const remove = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const current = await paymentTypeRepository.findById(restaurantId, id);

  if (!current) {
    throw new AppError(404, "Payment type not found");
  }

  const uses = await paymentTypeRepository.countUses(restaurantId, id);

  if (uses > 0) {
    throw new AppError(
      409,
      `"${current.name}" has been used ${uses} time${uses === 1 ? "" : "s"}, so it cannot be deleted. Switch it off instead; its history stays.`
    );
  }

  await paymentTypeRepository.remove(restaurantId, id);

  return toType(current);
};

// The type a payment (or a refund, or an advance) names, checked: it is this
// restaurant's, it sits under the method being used, and it is switched on.
// A type that needs a reference (a cheque number) refuses a payment without
// one. Returns the type, or null when none was named.
const forPayment = async (restaurantId, method, typeId, reference, { db, requireReference = true } = {}) => {
  if (!typeId) {
    return null;
  }

  const type = await paymentTypeRepository.findById(restaurantId, typeId, db);

  if (!type) {
    throw new AppError(400, "That payment type was not found. Pick it again.");
  }

  if (type.payment_method !== method) {
    throw new AppError(
      400,
      `${type.name} is a ${METHOD_WORDS[type.payment_method] || type.payment_method} type, not ${METHOD_WORDS[method] || method}`
    );
  }

  if (type.status !== "active") {
    throw new AppError(400, `${type.name} is switched off in Settings → Payment types`);
  }

  if (requireReference && type.needs_reference && !(reference && String(reference).trim())) {
    throw new AppError(400, `Write the ${type.name} reference (slip or cheque number) before saving`);
  }

  return toType(type);
};

module.exports = { METHOD_WORDS, list, create, update, remove, forPayment };
