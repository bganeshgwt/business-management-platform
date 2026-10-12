const customerAccountService = require("../services/customerAccount.service");
const { logAction } = require("../../../../utils/audit");
const { readDate } = require("../../../../utils/calendarDate");
const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");

const PAYMENT_METHODS = ["cash", "card", "upi", "online", "wallet", "other"];

// Staff pinned to one outlet see and collect that outlet's bills only; full
// mobiles are for customers.contact.
const ctxOf = (req) => ({
  outletId: req.outletId || null,
  outletPinned: Boolean(req.outletPinned),
  reveal: (req.user.permissions || []).includes("customers.contact"),
});

const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

// Every account and what it owes, aged; and the unpaid bills on no account.
const dues = async (req, res) => {
  res.json({ success: true, data: await customerAccountService.dues(req.user.restaurantId, ctxOf(req)) });
};

// Opens a guest's or company's account, or changes its limit, terms or hold.
const saveAccount = async (req, res) => {
  const customerId = v.requiredId(req.params.customerId, "Guest");
  const body = req.body || {};
  const data = {
    creditLimit: v.requiredNumber(body.creditLimit, "Credit limit", { min: 0, max: 99999999 }),
    creditDays: v.optionalNumber(body.creditDays, "Days to pay", { min: 0, max: 365 }),
    status: v.optionalEnum(body.status, "Status", ["active", "on_hold"], undefined),
    notes: body.notes === undefined ? undefined : v.optionalString(body.notes, "Notes", 300),
  };

  if (data.creditDays !== null && data.creditDays !== undefined && !Number.isInteger(data.creditDays)) {
    throw new AppError(400, "Days to pay must be a whole number of days");
  }

  const { before, account } = await customerAccountService.saveAccount(
    req.user.restaurantId,
    customerId,
    data,
    req.user.id
  );

  await logAction(req, before ? "update" : "create", "customer_account", {
    id: account.customerId,
    label: account.name,
    details: before
      ? {
          creditLimit: { before: before.creditLimit, after: account.creditLimit },
          creditDays: { before: before.creditDays, after: account.creditDays },
          status: { before: before.status, after: account.status },
        }
      : { creditLimit: account.creditLimit, creditDays: account.creditDays },
  });

  res.json({
    success: true,
    message: before
      ? `${account.name}'s account updated · limit ${money(account.creditLimit)}`
      : `Account opened for ${account.name} · limit ${money(account.creditLimit)}`,
    data: account,
  });
};

const statement = async (req, res) => {
  const customerId = v.requiredId(req.params.customerId, "Guest");
  const from = readDate(req.query.from, "From");
  const to = readDate(req.query.to, "To");

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  res.json({
    success: true,
    data: await customerAccountService.statement(req.user.restaurantId, customerId, { from, to }, ctxOf(req)),
  });
};

const openBills = async (req, res) => {
  const customerId = v.requiredId(req.params.customerId, "Guest");

  res.json({ success: true, data: await customerAccountService.openBills(req.user.restaurantId, customerId, ctxOf(req)) });
};

// Money received against an account.
const collect = async (req, res) => {
  const customerId = v.requiredId(req.params.customerId, "Guest");
  const body = req.body || {};
  const data = {
    amount: v.requiredNumber(body.amount, "Amount", { min: 0.01, max: 99999999 }),
    paymentMethod: v.requiredEnum(body.paymentMethod, "Payment method", PAYMENT_METHODS),
    transactionRef: v.optionalString(body.transactionRef, "Reference", 100),
    billIds:
      body.billIds === undefined || body.billIds === null
        ? null
        : v.requiredArray(body.billIds, "Bills").map((id) => v.requiredId(id, "Bill")),
  };

  const result = await customerAccountService.collect(req.user.restaurantId, customerId, data, req.user.id, ctxOf(req));

  // One line per bill it went onto, so each bill's history reads whole.
  for (const part of result.allocations) {
    await logAction(req, "payment", "bill", {
      id: part.billId,
      label: part.billNumber,
      details: {
        method: data.paymentMethod,
        amount: part.amount,
        onAccount: result.customerName,
        reference: data.transactionRef,
        till: result.till,
      },
    });
  }

  res.status(201).json({
    success: true,
    message: `${money(data.amount)} received from ${result.customerName} by ${result.method}, into ${result.till}'s business day`,
    data: result,
  });
};

module.exports = { dues, saveAccount, statement, openBills, collect };
