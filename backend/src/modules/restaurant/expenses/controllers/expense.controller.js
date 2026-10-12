const expenseService = require("../services/expense.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { readDate } = require("../../../../utils/calendarDate");

// --- Categories ---

const readCategoryBody = (body = {}) => ({
  name: v.requiredString(body.name, "Category name", 100),
  description: v.optionalString(body.description, "Description", 500),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

const listCategories = async (req, res) => {
  res.json({ success: true, data: await expenseService.listCategories(req.user.restaurantId) });
};

const createCategory = async (req, res) => {
  const category = await expenseService.createCategory(
    req.user.restaurantId,
    readCategoryBody(req.body),
    req.user.id
  );

  res.status(201).json({ success: true, message: "Category created", data: category });
};

const updateCategory = async (req, res) => {
  const id = v.requiredId(req.params.id, "Category id");
  const category = await expenseService.updateCategory(
    req.user.restaurantId,
    id,
    readCategoryBody(req.body),
    req.user.id
  );

  res.json({ success: true, message: "Category updated", data: category });
};

const removeCategory = async (req, res) => {
  await expenseService.removeCategory(
    req.user.restaurantId,
    v.requiredId(req.params.id, "Category id")
  );

  res.json({ success: true, message: "Category deleted" });
};

// --- Expenses ---

// The date may be left out: the service then dates it the business day the
// till is on (an expense paid at 00:40 belongs to the night before), not the
// server's calendar.
const readBody = (body = {}) => ({
  expenseCategoryId: v.requiredId(body.expenseCategoryId, "Category"),
  supplierId: v.optionalNumber(body.supplierId, "Supplier", { min: 1 }),
  expenseDate: readDate(body.expenseDate, "Expense date", null),
  amount: v.requiredNumber(body.amount, "Amount", { min: 0.01, max: 99999999 }),
  paymentMode: v.optionalEnum(
    body.paymentMode,
    "Payment mode",
    ["cash", "card", "upi", "bank", "other"],
    "cash"
  ),
  referenceNo: v.optionalString(body.referenceNo, "Reference number", 50),
  notes: v.optionalString(body.notes, "Notes", 500),
});

const list = async (req, res) => {
  const filters = {
    outletId: req.outletId || null,
    status: req.query.status
      ? v.requiredEnum(req.query.status, "Status", ["pending", "approved", "rejected"])
      : null,
    categoryId: v.optionalNumber(req.query.categoryId, "Category", { min: 1 }),
    from: readDate(req.query.from, "From date"),
    to: readDate(req.query.to, "To date"),
    // Paging: ?page=2&pageSize=25 (25, 50 or 100 to a page). Left out, the
    // list is the 300 most recent, as before.
    pageSize: req.query.pageSize
      ? Number(v.requiredEnum(String(req.query.pageSize), "Page size", ["25", "50", "100"]))
      : null,
    page: req.query.page ? v.requiredId(req.query.page, "Page") : null,
  };

  if (filters.page && !filters.pageSize) {
    filters.pageSize = 25;
  }

  if (filters.from && filters.to && filters.to < filters.from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  res.json({ success: true, data: await expenseService.list(req.user.restaurantId, filters) });
};

// What the form fills in: the date the till is trading on.
const defaults = async (req, res) => {
  res.json({ success: true, data: await expenseService.defaults(req.user.restaurantId, req.outletId || null) });
};

// Every create, edit, approval and delete goes in the activity log with the
// money and the date: an expense edited from ₹200 to ₹20 and then deleted is
// exactly what the owner looks for there.
const facts = (expense) => ({
  amount: expense.amount,
  expenseDate: expense.expenseDate,
  paymentMode: expense.paymentMode,
  category: expense.categoryName,
  outlet: expense.outletName || null,
});

const create = async (req, res) => {
  const expense = await expenseService.create(
    req.user.restaurantId,
    { ...readBody(req.body), outletId: req.outletId || null },
    req.user.id,
    { atTill: true }
  );

  logAction(req, "create", "expense", { id: expense.id, label: expense.categoryName, details: facts(expense) });

  res.status(201).json({ success: true, message: "Expense recorded", data: expense });
};

const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Expense id");
  const { before, after } = await expenseService.update(
    req.user.restaurantId,
    id,
    readBody(req.body),
    req.user.id
  );

  logAction(req, "update", "expense", {
    id: after.id,
    label: after.categoryName,
    details: {
      changes: diff(before, after, [
        "amount",
        "expenseDate",
        "paymentMode",
        "categoryName",
        "supplierName",
        "referenceNo",
        "notes",
      ]),
    },
  });

  res.json({ success: true, message: "Expense updated", data: after });
};

// Approve or reject: separate from editing, because it is what puts the amount
// into the accounts.
const setStatus = async (req, res) => {
  const id = v.requiredId(req.params.id, "Expense id");
  const status = v.requiredEnum(req.body?.status, "Status", ["pending", "approved", "rejected"]);

  const { before, after: expense } = await expenseService.setStatus(req.user.restaurantId, id, status, req.user.id);

  logAction(req, status, "expense", {
    id: expense.id,
    label: expense.categoryName,
    details: { ...facts(expense), from: before.expenseStatus },
  });

  res.json({ success: true, message: `Expense ${status}`, data: expense });
};

// "Approve selected": several waiting expenses at once (one transaction, all
// or none). Same permission as approving one (the route); every expense gets
// its own activity-log line, as if approved one by one.
const approveMany = async (req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    throw new AppError(400, "Choose the expenses to approve");
  }

  if (body.ids.length > 200) {
    throw new AppError(400, "Approve at most 200 expenses at a time");
  }

  const { before, after } = await expenseService.approveMany(
    req.user.restaurantId,
    body.ids.map((id) => v.requiredId(id, "Expense id")),
    req.user.id,
    {
      outletId: req.outletId || null,
      expectedTotal: v.optionalNumber(body.expectedTotal, "Total", { min: 0, max: 9999999999 }),
    }
  );

  const was = new Map(before.map((expense) => [expense.id, expense]));

  for (const expense of after) {
    logAction(req, "approved", "expense", {
      id: expense.id,
      label: expense.categoryName,
      details: { ...facts(expense), from: was.get(expense.id)?.expenseStatus || "pending", approvedWithOthers: after.length },
    });
  }

  const total = after.reduce((sum, expense) => sum + Math.round(Number(expense.amount) * 100), 0) / 100;

  res.json({
    success: true,
    message: `${after.length} ${after.length === 1 ? "expense" : "expenses"} approved`,
    data: { count: after.length, total, expenses: after },
  });
};

const remove = async (req, res) => {
  const removed = await expenseService.remove(req.user.restaurantId, v.requiredId(req.params.id, "Expense id"));

  logAction(req, "delete", "expense", { id: removed.id, label: removed.categoryName, details: facts(removed) });

  res.json({ success: true, message: "Expense deleted" });
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
