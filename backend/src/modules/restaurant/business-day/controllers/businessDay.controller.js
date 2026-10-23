const businessDayService = require("../services/businessDay.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const { isCalendarDate } = require("../../../../utils/calendarDate");

const getStatus = async (req, res) => {
  res.json({ success: true, data: await businessDayService.getStatus(req.user.restaurantId, req.outletId, req.user) });
};

// Past days, for the screen's date filter: ?from=&to=&page=&pageSize=.
const listDays = async (req, res) => {
  const from = req.query.from ? String(req.query.from) : null;
  const to = req.query.to ? String(req.query.to) : null;

  for (const [value, name] of [
    [from, "From date"],
    [to, "To date"],
  ]) {
    if (value !== null && !isCalendarDate(value)) {
      throw new AppError(400, `${name} must be a real date like 2026-09-18`);
    }
  }

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  const pageSize = req.query.pageSize
    ? Number(v.requiredEnum(String(req.query.pageSize), "Page size", ["25", "50", "100"]))
    : 25;
  const page = req.query.page ? v.requiredId(req.query.page, "Page") : 1;

  res.json({
    success: true,
    data: await businessDayService.listDays(req.user.restaurantId, req.outletId, req.user, { from, to, page, pageSize }),
  });
};

const open = async (req, res) => {
  const body = req.body || {};
  // Left out, the service picks the date the till is trading on: today on
  // the restaurant's own clock (or last night, before the morning cut-off).
  // Given, it must be a real date — and one the service allows.
  const businessDate = body.businessDate ?? null;

  if (businessDate !== null && !isCalendarDate(businessDate)) {
    throw new AppError(400, "Business date must be a real date like 2026-09-18");
  }

  const data = {
    businessDate,
    openingCash: v.optionalNumber(body.openingCash, "Opening cash", { min: 0, max: 99999999 }) ?? 0,
    notes: v.optionalString(body.notes, "Notes", 500),
    outletId: req.outletId || null,
  };

  const day = await businessDayService.openDay(req.user.restaurantId, data, req.user.id, { atTill: true });

  logAction(req, "open", "business_day", {
    id: day.id,
    label: day.businessDate,
    details: { openingCash: day.openingCash },
  });

  res.status(201).json({ success: true, message: "Business day opened", data: day });
};

const readClosingCash = (value) => {
  if (value === undefined || value === null ||
      (typeof value === "string" && value.trim() === "")) {
    throw new AppError(400, "Enter the cash counted before closing the business day");
  }
  return v.requiredNumber(value, "Closing cash", { min: 0, max: 99999999 });
};

// A count: the total typed, or the notes and coins it was counted from.
const readDenominations = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "The notes counted could not be read. Count again.");
  }

  return value;
};

// The close as the closing screen sends it. Older screens send only the
// cash counted (and the carry-over choice); the rest is optional.
const readClose = (req) => {
  const body = req.body || {};

  return {
    closingCash: readClosingCash(body.closingCash),
    countMethod: v.optionalEnum(body.countMethod, "How the cash was counted", ["notes", "total"], "total"),
    denominations: readDenominations(body.denominations),
    varianceReason: v.optionalString(body.varianceReason, "Reason for the difference", 300),
    methodChecks: body.methodChecks === undefined || body.methodChecks === null ? null : v.requiredArray(body.methodChecks, "Card and UPI checks"),
    notes: v.optionalString(body.notes, "Notes", 500),
    // The manager's explicit say-so to carry unpaid bills over as dues. Open
    // orders can never be carried: they must be billed or cancelled.
    carryUnpaid: body.carryUnpaid === true,
    outletId: req.outletId || null,
  };
};

// Refuse an incomplete cash count before redeeming a manager's approval.
const validateClose = (req, res, next) => {
  readClosingCash(req.body?.closingCash);
  next();
};

// Everything else that would refuse the close (open tables, unpaid bills,
// expenses waiting, a drawer still open, a difference with no reason),
// checked before a manager's approval is spent on it.
const precheckClose = async (req, res, next) => {
  try {
    await businessDayService.evaluateClose(req.user.restaurantId, readClose(req), req.user, null, { atTill: true });
    next();
  } catch (error) {
    next(error);
  }
};

const close = async (req, res) => {
  const data = readClose(req);
  const closed = await businessDayService.closeDay(req.user.restaurantId, data, req.user, { atTill: true });
  const day = closed.day || closed;
  const result = closed.result || null;

  logAction(req, "close", "business_day", {
    id: day.id,
    label: day.businessDate,
    details: {
      closingCash: day.closingCash,
      countedCash: day.countedCash ?? data.closingCash,
      expectedCash: day.expectedCash ?? null,
      variance: day.variance ?? null,
      varianceReason: day.varianceReason ?? null,
      blindCount: day.blindCount ?? false,
      cashDropped: day.cashDropped ?? 0,
      cashPaidIn: day.cashPaidIn ?? 0,
      methodChecks: day.methodChecks ?? null,
    },
  });

  // Over or short beyond the threshold is its own line in the activity log,
  // so the owner can find every one of them.
  if (result && Math.abs(result.variance) > result.threshold + 0.004) {
    logAction(req, result.variance < 0 ? "cash_short" : "cash_over", "business_day", {
      id: day.id,
      label: day.businessDate,
      details: {
        variance: result.variance,
        expectedCash: day.expectedCash,
        countedCash: day.countedCash,
        reason: day.varianceReason,
        threshold: result.threshold,
      },
    });
  }

  res.json({ success: true, message: "Business day closed", data: day });
};

// What the close dialog shows before the count.
const closePreview = async (req, res) => {
  res.json({
    success: true,
    data: await businessDayService.closePreview(req.user.restaurantId, req.outletId || null, req.user),
  });
};

// The close checked before a manager's PIN: a refusal comes back in a 200,
// with the reason, so the screen shows it instead of a failed request.
const checkClose = async (req, res) => {
  let data;

  try {
    data = readClose(req);
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }

    res.json({ success: true, data: { refused: { message: error.message, status: error.statusCode, reason: "invalid" } } });
    return;
  }

  res.json({ success: true, data: await businessDayService.checkClose(req.user.restaurantId, data, req.user) });
};

const reopen = async (req, res) => {
  const id = v.requiredId(req.params.id, "Business day id");
  const reason = v.requiredString(req.body?.reason, "Reason for reopening", 300);
  const { day, was } = await businessDayService.reopenDay(req.user.restaurantId, req.outletId || null, id, reason, req.user);

  logAction(req, "reopen", "business_day", {
    id: day.id,
    label: day.businessDate,
    details: {
      reason,
      wasClosedAt: was.closedAt,
      wasClosedBy: was.closedByName,
      closingCash: was.closingCash,
      countedCash: was.countedCash,
      variance: was.variance,
    },
  });

  res.json({ success: true, message: "Business day reopened", data: day });
};

const getRules = async (req, res) => {
  res.json({ success: true, data: await businessDayService.getRules(req.user.restaurantId) });
};

const updateRules = async (req, res) => {
  const body = req.body || {};
  const data = {
    cutoffHour: Math.round(v.requiredNumber(body.cutoffHour, "Last night's day may be opened until (hour)", { min: 0, max: 12 })),
    varianceThreshold: v.requiredNumber(body.varianceThreshold, "Over or short needing a reason", { min: 0, max: 100000 }),
    blindCount: v.requiredBoolean(body.blindCount, "Blind count", false),
  };
  const { before, after } = await businessDayService.updateRules(req.user.restaurantId, data, req.user.id);

  logAction(req, "update", "cash_rules", {
    label: "Cash count rules",
    details: { changes: diff(before, after, ["cutoffHour", "varianceThreshold", "blindCount"]) },
  });

  res.json({ success: true, message: "Cash rules saved", data: after });
};

module.exports = {
  getStatus,
  listDays,
  open,
  close,
  validateClose,
  precheckClose,
  closePreview,
  checkClose,
  reopen,
  getRules,
  updateRules,
};
