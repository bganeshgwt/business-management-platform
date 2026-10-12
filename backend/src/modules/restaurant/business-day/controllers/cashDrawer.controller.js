const cashDrawerService = require("../services/cashDrawer.service");
const restaurantFeatures = require("../../setup/services/restaurantFeatures.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const outletOf = (req) => req.outletId || null;

// The drawers of the day this till is trading, with cash in and out.
const list = async (req, res) => {
  const data = await cashDrawerService.listDrawers(req.user.restaurantId, outletOf(req), req.user);

  // Cash drawers switched off (Settings -> Features): the day is one till.
  // Cash in and out of it still shows; no drawer does.
  if (!restaurantFeatures.has(req.user, "cash_drawers")) {
    Object.assign(data, { drawers: [], myDrawerId: null, byCashier: [], drawersOff: true });
  }

  res.json({ success: true, data });
};

// A shift starts: the cashier counts the float into their drawer.
const start = async (req, res) => {
  const body = req.body || {};
  const data = {
    cashierId: body.cashierId === undefined || body.cashierId === null || body.cashierId === "" ? null : v.requiredId(body.cashierId, "Cashier"),
    openingFloat: v.requiredNumber(body.openingFloat, "Float counted into the drawer", { min: 0, max: 99999999 }),
    label: v.optionalString(body.label, "Drawer name", 60),
    notes: v.optionalString(body.notes, "Notes", 500),
  };
  const drawer = await cashDrawerService.startDrawer(req.user.restaurantId, outletOf(req), data, req.user);

  logAction(req, "open", "cash_drawer", {
    id: drawer.id,
    label: `${drawer.cashierName}'s drawer`,
    details: { openingFloat: drawer.openingFloat, businessDate: drawer.businessDate, label: drawer.label },
  });

  res.status(201).json({ success: true, message: `${drawer.cashierName}'s drawer is open`, data: drawer });
};

const readCount = (body = {}) => {
  const value = body.closingCash;

  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    throw new AppError(400, "Enter the cash counted in the drawer");
  }

  const denominations = body.denominations;

  if (denominations !== undefined && denominations !== null && (typeof denominations !== "object" || Array.isArray(denominations))) {
    throw new AppError(400, "The notes counted could not be read. Count again.");
  }

  return {
    closingCash: v.requiredNumber(value, "Cash counted", { min: 0, max: 99999999 }),
    countMethod: v.optionalEnum(body.countMethod, "How the cash was counted", ["notes", "total"], "total"),
    denominations: denominations || null,
    varianceReason: v.optionalString(body.varianceReason, "Reason for the difference", 300),
    notes: v.optionalString(body.notes, "Notes", 500),
  };
};

// A shift ends: the drawer is counted. Over or short beyond the threshold
// needs a reason, and is its own line in the activity log.
const close = async (req, res) => {
  const id = v.requiredId(req.params.id, "Drawer id");
  const data = readCount(req.body);
  const { drawer, variance, threshold } = await cashDrawerService.closeDrawer(req.user.restaurantId, outletOf(req), id, data, req.user);

  logAction(req, "close", "cash_drawer", {
    id: drawer.id,
    label: `${drawer.cashierName}'s drawer`,
    details: {
      countedCash: drawer.countedCash,
      expectedCash: drawer.expectedAtClose,
      variance,
      varianceReason: drawer.varianceReason,
      blindCount: drawer.blindCount,
      firstCount: drawer.firstCount,
    },
  });

  if (Math.abs(variance) > threshold + 0.004) {
    logAction(req, variance < 0 ? "cash_short" : "cash_over", "cash_drawer", {
      id: drawer.id,
      label: `${drawer.cashierName}'s drawer`,
      details: { variance, expectedCash: drawer.expectedAtClose, countedCash: drawer.countedCash, reason: drawer.varianceReason, threshold },
    });
  }

  res.json({ success: true, message: `${drawer.cashierName}'s drawer is closed`, data: drawer });
};

// An X report: one drawer (?drawerId=) or one cashier's day (?cashierId=,
// yourself when left out). Reading it changes nothing.
const xReport = async (req, res) => {
  const drawerId = req.query.drawerId ? v.requiredId(req.query.drawerId, "Drawer id") : null;
  const cashierId = req.query.cashierId ? v.requiredId(req.query.cashierId, "Cashier") : null;

  // The day's X report is core; one drawer's or one cashier's is Cash drawers.
  if (drawerId || cashierId) {
    await restaurantFeatures.assertOn(req.user, "cash_drawers");
  }

  res.json({
    success: true,
    data: await cashDrawerService.xReport(req.user.restaurantId, outletOf(req), { drawerId, cashierId }, req.user),
  });
};

// --- Cash in and out --------------------------------------------------------------

const readMovement = (body = {}) => ({
  type: v.requiredEnum(body.type, "Kind of cash entry", ["paid_in", "petty_cash", "drop"]),
  amount: Math.round(v.requiredNumber(body.amount, "Amount", { min: 0.01, max: 99999999 }) * 100) / 100,
  reason: v.requiredString(body.reason, "What it was for", 300),
  drawerId: body.drawerId === undefined || body.drawerId === null || body.drawerId === "" ? null : v.requiredId(body.drawerId, "Drawer"),
  expenseCategoryId:
    body.expenseCategoryId === undefined || body.expenseCategoryId === null || body.expenseCategoryId === ""
      ? null
      : v.requiredId(body.expenseCategoryId, "Expense category"),
});

// Checked in full before a manager is asked for a PIN: the day is open, the
// drawer is, and the cash taken out is not more than the drawer holds.
const validateMovement = async (req, res, next) => {
  try {
    req.movement = readMovement(req.body);

    // Cash into or out of one cashier's drawer is the Cash drawers feature;
    // with it off, cash moves in and out of the day's one till.
    if (req.movement.drawerId) {
      await restaurantFeatures.assertOn(req.user, "cash_drawers");
    }

    const { day } = await cashDrawerService.planMovement(req.user.restaurantId, outletOf(req), req.movement, req.user);
    req.movementDay = day;
    next();
  } catch (error) {
    next(error);
  }
};

// What a manager's PIN for cash in or out is tied to: this day, this much.
// The approval is tied to the day, the amount and which way the cash goes.
const movementScope = (req) => ({ businessDayId: req.movementDay.id, amount: req.movement.amount, cashMove: req.movement.type });

const record = async (req, res) => {
  const movement = await cashDrawerService.recordMovement(
    req.user.restaurantId,
    outletOf(req),
    req.movement,
    req.user,
    req.approval || null
  );

  logAction(req, movement.type, "cash_movement", {
    id: movement.id,
    label: movement.typeLabel,
    details: {
      amount: movement.amount,
      reason: movement.reason,
      drawer: movement.drawerCashierName ? `${movement.drawerCashierName}'s drawer` : "The day's drawer",
      expenseId: movement.expenseId,
    },
  });

  res.status(201).json({ success: true, message: `${movement.typeLabel} recorded`, data: movement });
};

const validateCancel = async (req, res, next) => {
  try {
    req.cancelReason = v.requiredString(req.body?.reason, "Why it is cancelled", 300);
    req.cancelRow = await cashDrawerService.checkCancel(
      req.user.restaurantId,
      outletOf(req),
      v.requiredId(req.params.id, "Cash entry id"),
      req.user
    );
    next();
  } catch (error) {
    next(error);
  }
};

const cancelScope = (req) => ({
  businessDayId: req.cancelRow.business_day_id,
  amount: Number(req.cancelRow.amount),
  cashMove: `cancel_${req.cancelRow.movement_type}`,
});

const cancel = async (req, res) => {
  const movement = await cashDrawerService.cancelMovement(
    req.user.restaurantId,
    outletOf(req),
    req.cancelRow.id,
    req.cancelReason,
    req.user
  );

  logAction(req, "cancel", "cash_movement", {
    id: movement.id,
    label: movement.typeLabel,
    details: { amount: movement.amount, reason: movement.reason, cancelReason: movement.cancelReason },
  });

  res.json({ success: true, message: `${movement.typeLabel} cancelled`, data: movement });
};

module.exports = {
  list,
  start,
  close,
  xReport,
  validateMovement,
  movementScope,
  record,
  validateCancel,
  cancelScope,
  cancel,
};
