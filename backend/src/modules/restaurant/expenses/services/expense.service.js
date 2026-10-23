const expenseRepository = require("../repositories/expense.repository");
const supplierRepository = require("../../purchasing/repositories/supplier.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const tradingDay = require("../../business-day/services/tradingDay");
const AppError = require("../../../../utils/AppError");

const DUPLICATE = "23505";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toCategory = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  expenseCount: row.expense_count,
});

const toExpense = (row) => ({
  id: row.id,
  outletId: row.outlet_id || null,
  outletName: row.outlet_name || null,
  expenseCategoryId: row.expense_category_id,
  categoryName: row.category_name,
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  expenseDate: row.expense_date,
  amount: Number(row.amount),
  paymentMode: row.payment_mode,
  referenceNo: row.reference_no,
  notes: row.notes,
  expenseStatus: row.expense_status,
  approvedByName: row.approved_by_name,
  approvedAt: row.approved_at,
  createdByName: row.created_by_name,
  // The business day whose drawer this money came out of (by outlet and
  // date), and whether that drawer is already closed and counted.
  businessDayId: row.drawer_day_id || null,
  drawerClosed: row.drawer_day_status === "closed",
  // Petty cash paid from a drawer: changed or cancelled there, not here.
  fromDrawer: Boolean(row.movement_id),
  // Photos or PDFs of the paper bill: the paperclip on the list.
  attachmentCount: Number(row.attachment_count || 0),
});

// --- Which business day an expense belongs to ---------------------------------
//
// An expense belongs to the business day it was paid in. A day open past
// midnight is still that day: cash paid from the till at 00:40 comes out of
// the drawer counted at close, so it is dated the business day, not the
// calendar. Rules, said to whoever breaks them:
//   - no date given: the open business day of this till (else today);
//   - never after today;
//   - cash, never after the till's open business day (that cash came out of
//     this drawer, not a day that has not started);
//   - cash, never into a drawer that is already closed and counted (it would
//     change a signed count); record it today, or as paid outside the till.

// The date an expense recorded now is given when none was typed, and what the
// screen should say about it.
const defaults = async (restaurantId, outletId) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const today = tradingDay.todayOf(settings);
  const open = await tradingDay.openDayOf(restaurantId, outletId || null);

  return {
    expenseDate: open ? open.business_date : today,
    today,
    businessDay: open
      ? { id: open.id, businessDate: open.business_date, outletId: open.outlet_id || null, pastMidnight: open.business_date < today }
      : null,
  };
};

const checkDating = async (restaurantId, data, { open, today }) => {
  if (data.expenseDate > today) {
    throw new AppError(400, `An expense cannot be dated after today (${tradingDay.sayDate(today)}).`);
  }

  if (data.paymentMode !== "cash") {
    return;
  }

  if (open && data.expenseDate > open.business_date) {
    throw new AppError(
      400,
      `The till is still on business day ${tradingDay.sayDate(open.business_date)}. Cash paid from the till now comes out of that day's drawer: date it ${open.business_date}, or close that day first.`,
      { reason: "after_open_day", businessDate: open.business_date }
    );
  }

  const drawer = await expenseRepository.findDrawerDay(restaurantId, data.outletId, data.expenseDate);

  if (drawer && drawer.day_status === "closed") {
    throw new AppError(
      400,
      `The drawer of ${tradingDay.sayDate(drawer.business_date)} is closed and its cash counted, so cash can no longer come out of it. Record it on ${open ? `the open business day (${open.business_date})` : "the day it is paid"}, or choose how it was paid outside the till (bank, UPI or other).`,
      { reason: "drawer_closed", businessDate: drawer.business_date }
    );
  }
};

const datingContext = async (restaurantId, outletId) => {
  const settings = await restaurantRepository.findSettings(restaurantId);

  return {
    today: tradingDay.todayOf(settings),
    open: await tradingDay.openDayOf(restaurantId, outletId || null),
  };
};

// A cash expense whose drawer is closed and counted cannot start or stop
// counting in it (approved is what counts).
const lockedDrawer = (row) => row.payment_mode === "cash" && row.drawer_day_status === "closed";

// --- Categories ---

const listCategories = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await expenseRepository.findCategories(restaurantId);
  return rows.map(toCategory);
};

const createCategory = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    return toCategory(await expenseRepository.createCategory(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A category named "${data.name}" already exists`);
    }

    throw error;
  }
};

const updateCategory = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    const row = await expenseRepository.updateCategory(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Category not found");
    }

    return toCategory(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A category named "${data.name}" already exists`);
    }

    throw error;
  }
};

const removeCategory = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const category = await expenseRepository.findCategoryById(restaurantId, id);

  if (!category) {
    throw new AppError(404, "Category not found");
  }

  const count = await expenseRepository.countCategoryExpenses(id);

  if (count > 0) {
    throw new AppError(409, `This category has ${count} expense(s). Set it to inactive instead.`);
  }

  await expenseRepository.removeCategory(restaurantId, id);
};

// --- Expenses ---

const list = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  const [rows, summary, total] = await Promise.all([
    expenseRepository.findAll(restaurantId, filters),
    expenseRepository.summary(restaurantId, filters),
    expenseRepository.countAll(restaurantId, filters),
  ]);

  return {
    summary: {
      approvedTotal: Number(summary.approved_total),
      pendingTotal: Number(summary.pending_total),
      pendingCount: summary.pending_count,
      // Waiting for approval on any day, whatever the dates picked.
      waitingCount: summary.waiting_count,
      waitingTotal: Number(summary.waiting_total),
    },
    items: rows.map(toExpense),
    // How many match in all, and the page shown: "26–50 of 312".
    total,
    page: filters.pageSize ? filters.page || 1 : 1,
    pageSize: filters.pageSize || null,
  };
};

const validateLinks = async (restaurantId, data) => {
  const category = await expenseRepository.findCategoryById(restaurantId, data.expenseCategoryId);

  if (!category) {
    throw new AppError(400, "Selected category does not exist");
  }

  if (data.supplierId) {
    const supplier = await supplierRepository.findById(restaurantId, data.supplierId);

    if (!supplier) {
      throw new AppError(400, "Selected supplier does not exist");
    }
  }
};

// atTill: recorded by a person through the API, so the dating rules above
// apply. Server code that calls this directly may lay down past spending.
const create = async (restaurantId, data, userId, { atTill = false } = {}) => {
  requireRestaurantId(restaurantId);
  await validateLinks(restaurantId, data);

  const context = await datingContext(restaurantId, data.outletId);
  const dated = { ...data, expenseDate: data.expenseDate || (context.open ? context.open.business_date : context.today) };

  if (atTill) {
    await checkDating(restaurantId, dated, context);
  }

  return toExpense(await expenseRepository.create(restaurantId, dated, userId));
};

// Returns { before, after } so the activity log can say what changed.
const update = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);
  await validateLinks(restaurantId, data);

  const existing = await expenseRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Expense not found");
  }

  if (existing.expense_status !== "pending") {
    throw new AppError(409, "Only pending expenses can be edited");
  }

  // The expense keeps its outlet; a date left out keeps its date.
  const changed = { ...data, outletId: existing.outlet_id || null, expenseDate: data.expenseDate || existing.expense_date };

  await checkDating(restaurantId, changed, await datingContext(restaurantId, changed.outletId));

  const updated = await expenseRepository.update(restaurantId, id, changed, userId);
  if (!updated) throw new AppError(409, 'This expense changed while you were editing. Reload the list.');
  return { before: toExpense(existing), after: toExpense(updated) };
};

// Approving is what puts an expense into the accounts, so it is a separate
// action from editing and is recorded with who approved it and when.
const setStatus = async (restaurantId, id, status, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await expenseRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Expense not found");
  }

  if (existing.expense_status === status) {
    throw new AppError(409, `This expense is already ${status}`);
  }

  if (existing.movement_id) {
    throw new AppError(
      409,
      "This is petty cash paid from a drawer. If it was recorded by mistake, cancel it under Business day → Drawers & cash, so the drawer and the expenses stay the same."
    );
  }

  // Approving is what makes a cash expense come out of its drawer: once that
  // drawer is closed and counted, the count would change under the signature.
  if (lockedDrawer(existing) && (status === "approved" || existing.expense_status === "approved")) {
    throw new AppError(
      409,
      `This cash expense belongs to the drawer of ${tradingDay.sayDate(existing.expense_date)}, which is closed and counted, so it can no longer be approved or taken back out of that count. Record any correction on today's business day.`,
      { reason: "drawer_closed" }
    );
  }

  return {
    before: toExpense(existing),
    after: toExpense(await expenseRepository.setStatus(restaurantId, id, status, userId)),
  };
};

// "Approve selected": the same rules as approving one at a time, checked on
// every row inside one transaction (all approved, or none):
//  - each id is this restaurant's (and this outlet's, when the request is
//    scoped to one) and still waiting;
//  - petty cash paid from a drawer is not approved here;
//  - a cash expense of a closed, counted drawer cannot be approved;
//  - `expectedTotal` is the total the screen showed: if any amount changed
//    since, nothing is approved and the screen reloads.
// Returns every expense before and after, for the activity log.
const approveMany = async (restaurantId, ids, userId, { outletId = null, expectedTotal = null } = {}) => {
  requireRestaurantId(restaurantId);

  const unique = [...new Set(ids.map(Number))];

  const { before, after } = await expenseRepository.approveMany(restaurantId, unique, userId, (rows) => {
    const found = new Map(rows.map((row) => [Number(row.id), row]));
    const missing = unique.filter((id) => !found.has(id) || (outletId && Number(found.get(id).outlet_id) !== Number(outletId)));

    if (missing.length > 0) {
      throw new AppError(404, `${missing.length === 1 ? "One of the expenses" : `${missing.length} of the expenses`} chosen could not be found here. Nothing was approved.`, {
        reason: "not_found",
        ids: missing,
      });
    }

    const notWaiting = rows.filter((row) => row.expense_status !== "pending");

    if (notWaiting.length > 0) {
      throw new AppError(
        409,
        `${notWaiting.length === 1 ? "One of them is" : `${notWaiting.length} of them are`} no longer waiting (someone else decided on ${notWaiting.length === 1 ? "it" : "them"}). Nothing was approved. Reload and choose again.`,
        { reason: "not_pending", ids: notWaiting.map((row) => Number(row.id)) }
      );
    }

    const fromDrawer = rows.filter((row) => row.movement_id);

    if (fromDrawer.length > 0) {
      throw new AppError(
        409,
        "Petty cash paid from a drawer is approved under Business day → Drawers & cash, not here. Nothing was approved.",
        { reason: "drawer_petty_cash", ids: fromDrawer.map((row) => Number(row.id)) }
      );
    }

    const locked = rows.filter(lockedDrawer);

    if (locked.length > 0) {
      throw new AppError(
        409,
        `${locked.length === 1 ? "A cash expense" : `${locked.length} cash expenses`} chosen belong${locked.length === 1 ? "s" : ""} to a drawer that is closed and counted (${tradingDay.sayDate(locked[0].expense_date)}), so ${locked.length === 1 ? "it" : "they"} can no longer be approved. Nothing was approved. Leave ${locked.length === 1 ? "it" : "them"} out and try again.`,
        { reason: "drawer_closed", ids: locked.map((row) => Number(row.id)) }
      );
    }

    const total = rows.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0) / 100;

    if (expectedTotal !== null && expectedTotal !== undefined && Math.abs(total - expectedTotal) >= 0.01) {
      throw new AppError(
        409,
        `The amounts changed after the list was opened: these now come to ₹${total.toFixed(2)}. Nothing was approved. Reload and check them again.`,
        { reason: "total_changed", total }
      );
    }
  });

  return { before: before.map(toExpense), after: after.map(toExpense) };
};

// Returns the expense as it was, for the activity log.
const remove = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await expenseRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Expense not found");
  }

  if (existing.expense_status !== "pending") {
    throw new AppError(409, "Only pending expenses can be deleted");
  }

  await expenseRepository.remove(restaurantId, id);
  return toExpense(existing);
};

module.exports = {
  listCategories,
  createCategory,
  updateCategory,
  removeCategory,
  list,
  defaults,
  create,
  update,
  setStatus,
  approveMany,
  remove,
};
