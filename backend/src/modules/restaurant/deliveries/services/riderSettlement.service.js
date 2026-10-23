// Rider cash settlement in one step.
//
// A rider back from a run hands in the cash for the bills he delivered. The
// cashier sees those bills with what each still owes, ticks the ones the
// guest paid by UPI at the door, types the cash counted, and every bill is
// paid in one transaction — in the business day open now, into the cashier's
// drawer, like any payment at that till (bill.repository applyPayment).
//
// The cash counted can be less than expected, never more (more means a bill
// was ticked wrong or the count is off: count again). A shortfall is never
// quietly absorbed: it is kept as owed by the rider (handed over later and
// marked repaid), or written off by a manager (deliveries.write_off_shortfall,
// or their PIN), with a reason either way.
//
// Two cashiers settling the same rider at the same moment: the bills are
// locked while they are paid, and a bill settled once cannot be settled again
// (unique bill in rider_settlement_bills). The second is told to open Settle
// again.
const AppError = require("../../../../utils/AppError");
const pool = require("../../../../config/database");
const { round2 } = require("../../../../utils/money");
const billRepository = require("../../billing/repositories/bill.repository");
const deliveryRepository = require("../repositories/delivery.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const riderSettlementRepository = require("../repositories/riderSettlement.repository");
const cashDrawerRepository = require("../../business-day/repositories/cashDrawer.repository");
const tradingDay = require("../../business-day/services/tradingDay");
const loyaltyService = require("../../crm/services/loyalty.service");

const paise = (value) => Math.round(Number(value) * 100);
const due = (bill) => round2(billRepository.dueOf(bill));

const requireRider = async (restaurantId, riderId) => {
  const rider = await deliveryRepository.findEmployee(restaurantId, riderId);

  if (!rider) {
    throw new AppError(404, "Rider not found");
  }

  return rider;
};

const toOpenBill = (row) => ({
  billId: row.id,
  billNumber: row.bill_number,
  orderId: row.order_id,
  orderNumber: row.order_number,
  customerName: row.customer_name || null,
  deliveredAt: row.delivered_at,
  businessDate: row.business_date,
  total: Number(row.total_amount),
  paid: round2(Number(row.paid_amount) - Number(row.refunded_amount)),
  due: due(row),
});

// What the rider should hand in: the bills, and the deliveries not billed yet.
const preview = async (restaurantId, riderId, outletId) => {
  const rider = await requireRider(restaurantId, riderId);
  const [bills, unbilled] = await Promise.all([
    riderSettlementRepository.findOpenBills(pool, restaurantId, riderId, outletId),
    riderSettlementRepository.findUnbilled(restaurantId, riderId, outletId),
  ]);
  const open = bills.map(toOpenBill).filter((bill) => bill.due > 0);

  return {
    rider: { id: rider.id, name: rider.name, mobile: rider.mobile },
    bills: open,
    cashExpected: round2(open.reduce((sum, bill) => sum + bill.due, 0)),
    unbilled: unbilled.map((row) => ({
      orderId: row.id,
      orderNumber: row.order_number,
      amount: Number(row.total_amount),
      deliveredAt: row.delivered_at,
    })),
  };
};

// Checks a settlement against the bills as they are (`rows`), before any
// money moves: every bill chosen is still waiting, the cash counted is not
// more than expected, and a shortfall says what happens to it and why.
const plan = (rows, input, { writeOff }) => {
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const chosen = [];

  for (const pick of input.bills) {
    const row = byId.get(Number(pick.billId));

    if (!row || due(row) <= 0) {
      throw new AppError(
        409,
        "One of these bills is no longer waiting for this rider (paid at another till a moment ago?). Open Settle again."
      );
    }

    chosen.push({ row, method: pick.method, amount: due(row), upiRef: pick.upiRef || null });
  }

  const cashExpected = chosen.filter((bill) => bill.method === "cash").reduce((sum, bill) => sum + paise(bill.amount), 0);
  const upiAmount = chosen.filter((bill) => bill.method === "upi").reduce((sum, bill) => sum + paise(bill.amount), 0);
  const handed = paise(input.cashHanded);

  if (handed > cashExpected) {
    throw new AppError(
      400,
      `The cash counted (${handed / 100}) is more than the ${cashExpected / 100} the cash bills come to. ` +
        "Count again, or check which bills were paid by UPI."
    );
  }

  const shortfall = cashExpected - handed;
  let action = "none";

  if (writeOff && shortfall <= 0) {
    throw new AppError(400, "Nothing is short, so there is nothing to write off. Settle without a write-off.");
  }

  if (shortfall > 0) {
    if (!input.shortfallReason) {
      throw new AppError(400, `The rider is ${shortfall / 100} short. Say why before settling.`);
    }

    action = writeOff ? "written_off" : "owed";
  }

  return {
    chosen,
    cashExpected: cashExpected / 100,
    upiAmount: upiAmount / 100,
    cashHanded: handed / 100,
    shortfall: shortfall / 100,
    shortfallAction: action,
  };
};

// The amount a manager is asked to write off, worked out from the bills as
// they are now; every check runs first, so nobody is asked for a PIN for a
// settlement that would be refused anyway.
const writeOffAmount = async (restaurantId, riderId, outletId, input) => {
  await requireRider(restaurantId, riderId);

  const rows = await riderSettlementRepository.findOpenBills(pool, restaurantId, riderId, outletId);

  return plan(rows, input, { writeOff: true }).shortfall;
};

const settle = async (restaurantId, riderId, input, { outletId, userId, writeOff = false, approverId = null }) => {
  const rider = await requireRider(restaurantId, riderId);
  const settings = await restaurantRepository.findSettings(restaurantId);
  const client = await pool.connect();
  let id;
  let planned;

  try {
    await client.query("BEGIN");

    const rows = await riderSettlementRepository.findOpenBills(client, restaurantId, riderId, outletId, { lock: true });

    planned = plan(rows, input, { writeOff });

    let dayId = null;

    for (const bill of planned.chosen) {
      const applied = await billRepository.applyPayment(
        client,
        restaurantId,
        bill.row,
        {
          paymentMethod: bill.method,
          amount: bill.amount,
          tenderedAmount: null,
          changeAmount: 0,
          transactionRef: bill.upiRef,
          customerId: bill.row.customer_id,
          earnPoints: bill.row.customer_id ? loyaltyService.pointsForBill(settings, bill.row) : 0,
        },
        userId
      );

      if (applied.error === "NO_DAY") {
        throw new AppError(409, "Open the business day first. The rider's cash goes into the day's drawer, and no day is open.");
      }

      if (applied.error) {
        throw new AppError(409, `${bill.row.bill_number} could not be paid (${applied.error}). Open Settle again.`);
      }

      dayId = dayId || applied.dayId;
    }

    id = await riderSettlementRepository.insert(
      client,
      restaurantId,
      {
        outletId,
        businessDayId: dayId,
        riderId,
        bills: planned.chosen.map((bill) => ({
          billId: bill.row.id,
          orderId: bill.row.order_id,
          amount: bill.amount,
          method: bill.method,
        })),
        cashExpected: planned.cashExpected,
        cashHanded: planned.cashHanded,
        upiAmount: planned.upiAmount,
        shortfall: planned.shortfall,
        shortfallAction: planned.shortfallAction,
        shortfallReason: planned.shortfall > 0 ? input.shortfallReason : null,
        approvedBy: planned.shortfallAction === "written_off" ? approverId || userId : null,
      },
      userId
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      throw new AppError(409, "These bills were settled at another till a moment ago. Open Settle again.");
    }

    throw error;
  } finally {
    client.release();
  }

  return { rider, settlement: toSettlement(await riderSettlementRepository.findById(restaurantId, id)) };
};

const toSettlement = (row) => ({
  id: row.id,
  outletId: row.outlet_id || null,
  outletName: row.outlet_name || null,
  businessDate: row.business_date || null,
  riderId: row.rider_employee_id,
  riderName: row.rider_name,
  billCount: row.bill_count,
  cashExpected: Number(row.cash_expected),
  cashHanded: Number(row.cash_handed),
  upiAmount: Number(row.upi_amount),
  shortfall: Number(row.shortfall),
  shortfallAction: row.shortfall_action,
  shortfallReason: row.shortfall_reason || null,
  settledAt: row.settled_at,
  settledByName: row.settled_by_name || null,
  approvedByName: row.approved_by_name || null,
  repaidAt: row.repaid_at || null,
  repaidByName: row.repaid_by_name || null,
  bills: (row.bills || []).map((bill) => ({ ...bill, amount: Number(bill.amount) })),
});

// The day's rider settlements (the owner's report), on the open business
// day unless a date is asked for; and every shortfall riders still owe.
const report = async (restaurantId, { date, outletId, page, pageSize }) => {
  let on = date;

  if (!on) {
    const day = await businessDayRepository.findOpen(restaurantId, outletId || null);
    const settings = await restaurantRepository.findSettings(restaurantId);
    // No day open: today, or last night's until the cut-off hour when that
    // day was just closed (tradingDay.dateWithNoDayOpen).
    on = day ? day.business_date : await tradingDay.dateWithNoDayOpenAt(restaurantId, outletId || null, settings);
  }

  const [{ rows, totals }, owed] = await Promise.all([
    riderSettlementRepository.findForDate(restaurantId, { date: on, outletId, limit: pageSize, offset: (page - 1) * pageSize }),
    riderSettlementRepository.findOwed(restaurantId, outletId),
  ]);

  return {
    date: on,
    page,
    pageSize,
    total: totals.count,
    totals: {
      settlements: totals.count,
      bills: totals.bills,
      cashExpected: Number(totals.cash_expected),
      cashHanded: Number(totals.cash_handed),
      upiAmount: Number(totals.upi_amount),
      shortfall: Number(totals.shortfall),
    },
    items: rows.map(toSettlement),
    owed: owed.map(toSettlement),
  };
};

// A shortfall the rider hands over later is cash into a drawer: the drawer
// of the business day open now at the till the settlement was made at (the
// outlet's own day, else the main counter's — the same rule the database
// uses). With no day open there, or with drawers in use on that day and the
// person taking the cash having none open, the cash would land in no drawer,
// so it is refused with what to do instead.
const markRepaid = async (restaurantId, id, outletId, userId) => {
  const existing = await riderSettlementRepository.findById(restaurantId, id);

  if (!existing || (outletId && Number(existing.outlet_id) !== Number(outletId))) {
    throw new AppError(404, "Settlement not found");
  }

  if (existing.shortfall_action !== "owed" || Number(existing.shortfall) <= 0) {
    throw new AppError(409, "Nothing on this settlement is owed by the rider.");
  }

  if (existing.repaid_at) {
    throw new AppError(409, "This shortfall was already marked as handed over.");
  }

  const till = existing.outlet_name || "the main counter";
  const day = await tradingDay.openDayOf(restaurantId, existing.outlet_id || null);

  if (!day) {
    throw new AppError(
      409,
      `No business day is open at ${till}. Open the day first: the rider's cash goes into that day's drawer.`,
      { reason: "no_day" }
    );
  }

  const drawers = await cashDrawerRepository.listDrawers(restaurantId, day.id);

  if (drawers.length > 0) {
    const mine = drawers.find((row) => Number(row.cashier_id) === Number(userId) && row.drawer_status === "open");

    if (!mine) {
      throw new AppError(
        409,
        "Your cash drawer is closed. Open your drawer first (Cash drawers), or let the cashier holding an open drawer take the rider's cash.",
        { reason: "no_drawer" }
      );
    }
  }

  const row = await riderSettlementRepository.markRepaid(restaurantId, id, outletId, userId, day.id);

  if (!row) {
    const now = await riderSettlementRepository.findById(restaurantId, id);

    throw new AppError(
      409,
      now && now.repaid_at
        ? "This shortfall was already marked as handed over."
        : `The business day at ${till} was closed a moment ago. Open the day, then mark the cash handed over.`
    );
  }

  return toSettlement(await riderSettlementRepository.findById(restaurantId, id));
};

module.exports = { preview, writeOffAmount, settle, report, markRepaid };
