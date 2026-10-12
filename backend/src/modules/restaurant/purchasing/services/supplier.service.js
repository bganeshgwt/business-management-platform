const supplierRepository = require("../repositories/supplier.repository");
const AppError = require("../../../../utils/AppError");

const DUPLICATE = "23505";
const FOREIGN_KEY = "23503";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toSupplier = (row) => ({
  id: row.id,
  name: row.name,
  code: row.code,
  contactPerson: row.contact_person,
  mobile: row.mobile,
  email: row.email,
  address: row.address,
  gstNumber: row.gst_number,
  paymentTerms: row.payment_terms,
  creditDays: row.credit_days ?? null,
  status: row.status,
  orderCount: row.order_count,
  billCount: row.bill_count ?? 0,
  lastBillDate: row.last_bill_date ?? null,
});

const list = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await supplierRepository.findAll(restaurantId);
  return rows.map(toSupplier);
};

const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    return toSupplier(await supplierRepository.create(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A supplier with this name or code already exists");
    }

    throw error;
  }
};

const update = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    const row = await supplierRepository.update(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Supplier not found");
    }

    return toSupplier(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A supplier with this name or code already exists");
    }

    throw error;
  }
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Purchase history must stay intact, so a supplier with any orders, bills,
// returns, payments or expenses is deactivated rather than deleted.
const remove = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const supplier = await supplierRepository.findById(restaurantId, id);

  if (!supplier) {
    throw new AppError(404, "Supplier not found");
  }

  const history = await supplierRepository.countHistory(restaurantId, id);
  const held = [
    history.orders ? plural(history.orders, "purchase order") : null,
    history.bills ? plural(history.bills, "purchase bill") : null,
    history.returns ? plural(history.returns, "return") : null,
    history.payments ? plural(history.payments, "payment") : null,
    history.expenses ? plural(history.expenses, "expense") : null,
  ].filter(Boolean);

  if (held.length > 0) {
    throw new AppError(
      409,
      `${supplier.name} has ${held.join(", ")} on record. Set the supplier to inactive instead.`
    );
  }

  try {
    await supplierRepository.remove(restaurantId, id);
  } catch (error) {
    // Anything else that points at the supplier, added later.
    if (error.code === FOREIGN_KEY) {
      throw new AppError(409, `${supplier.name} has history on record. Set the supplier to inactive instead.`);
    }

    throw error;
  }
};

module.exports = {
  list,
  create,
  update,
  remove,
};
