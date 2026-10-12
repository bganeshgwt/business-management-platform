const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { logAction } = require("../../../../utils/audit");
const riderSettlementService = require("../services/riderSettlement.service");

const PAGE_SIZES = [25, 50, 100];

const readSettle = (raw) => {
  const body = raw && typeof raw === "object" ? raw : {};
  const picks = v.requiredArray(body.bills, "Bills");

  if (picks.length === 0) {
    throw new AppError(400, "Pick at least one bill to settle");
  }

  if (picks.length > 200) {
    throw new AppError(400, "Settle at most 200 bills at a time");
  }

  const seen = new Set();
  const bills = picks.map((pick) => {
    const billId = v.requiredId(pick && pick.billId, "Bill");

    if (seen.has(billId)) {
      throw new AppError(400, "A bill is listed twice. Pick each bill once.");
    }

    seen.add(billId);

    return {
      billId,
      method: v.requiredEnum(pick.method, "How the guest paid", ["cash", "upi"]),
      upiRef: v.optionalString(pick.upiRef, "UPI reference", 60) || null,
    };
  });

  return {
    bills,
    cashHanded: v.requiredNumber(body.cashHanded, "Cash handed in", { min: 0, max: 10000000 }),
    shortfallReason: v.optionalString(body.shortfallReason, "Reason for the shortfall", 200) || null,
  };
};

const riderOf = (req) => v.requiredId(req.params.riderId, "Rider");

const preview = async (req, res) => {
  res.json({
    success: true,
    data: await riderSettlementService.preview(req.user.restaurantId, riderOf(req), req.outletId || null),
  });
};

// The write-off a manager approves, by amount (worked out from the bills).
const writeOffScope = async (req) => ({
  amount: await riderSettlementService.writeOffAmount(req.user.restaurantId, riderOf(req), req.outletId || null, readSettle(req.body)),
});

const settleWith = (writeOff) => async (req, res) => {
  const riderId = riderOf(req);
  const input = readSettle(req.body);
  const { rider, settlement } = await riderSettlementService.settle(req.user.restaurantId, riderId, input, {
    outletId: req.outletId || null,
    userId: req.user.id,
    writeOff,
    approverId: req.approval ? req.approval.approverId : null,
  });

  logAction(req, "settle_rider", "rider_settlement", {
    id: settlement.id,
    label: rider.name,
    details: {
      bills: settlement.billCount,
      cashExpected: settlement.cashExpected,
      cashHanded: settlement.cashHanded,
      upi: settlement.upiAmount,
      shortfall: settlement.shortfall,
      shortfallAction: settlement.shortfallAction,
      reason: settlement.shortfallReason,
    },
  });

  const shortText =
    settlement.shortfall > 0
      ? ` · short by ${settlement.shortfall.toFixed(2)}, ${settlement.shortfallAction === "owed" ? "owed by the rider" : "written off"}`
      : "";

  res.status(201).json({
    success: true,
    message: `${rider.name} settled: ${settlement.billCount} ${settlement.billCount === 1 ? "bill" : "bills"} paid${shortText}`,
    data: settlement,
  });
};

const report = async (req, res) => {
  const date = req.query.date ? v.requiredString(req.query.date, "Date", 10) : null;

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError(400, "Date must be a date like 2026-10-06");
  }

  const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 25;

  if (!PAGE_SIZES.includes(pageSize)) {
    throw new AppError(400, "Rows per page must be 25, 50 or 100");
  }

  const page = req.query.page ? Number(req.query.page) : 1;

  if (!Number.isInteger(page) || page < 1 || page > 100000) {
    throw new AppError(400, "Page must be a whole number from 1");
  }

  res.json({
    success: true,
    data: await riderSettlementService.report(req.user.restaurantId, { date, outletId: req.outletId || null, page, pageSize }),
  });
};

const markRepaid = async (req, res) => {
  const id = v.requiredId(req.params.id, "Settlement");
  const settlement = await riderSettlementService.markRepaid(req.user.restaurantId, id, req.outletId || null, req.user.id);

  logAction(req, "rider_repaid", "rider_settlement", {
    id,
    label: settlement.riderName,
    details: { amount: settlement.shortfall },
  });

  res.json({ success: true, message: `${settlement.riderName} handed over the ${settlement.shortfall.toFixed(2)} owed`, data: settlement });
};

module.exports = { preview, writeOffScope, settle: settleWith(false), settleWriteOff: settleWith(true), report, markRepaid };
