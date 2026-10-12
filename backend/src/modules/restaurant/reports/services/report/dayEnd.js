// Day-end (Z) report and the cash-drawer figures it shares with the dashboard.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const businessDayRepository = require("../../../business-day/repositories/businessDay.repository");
const restaurantRepository = require("../../../setup/repositories/restaurant.repository");
const outletRepository = require("../../../setup/repositories/outlet.repository");
const AppError = require("../../../../../utils/AppError");
const { round2 } = require("../../../../../utils/money");
const gst = require("../../../billing/services/gstBreakdown");
const { coverFigures, num, requireRestaurantId } = require("./common");
const { tradingDays, zoneOf } = require("./scope");
const { breakdownsFor, cgstOf, taxableLines } = require("./gstData");
const tradingDayRules = require("../../../business-day/services/tradingDay");

// Asked for a date nobody traded on (a holiday, a typo): not an error. The
// screen says so and offers the nearest days that were traded.
const noDayOn = async (restaurantId, date, outlet, message) => ({
  noDay: true,
  businessDate: date,
  outletId: outlet ? outlet.id : null,
  outletName: outlet ? outlet.name : null,
  message,
  nearestDates: await reportRepository.nearestDays(restaurantId, date, outlet ? outlet.id : undefined),
});

// ---------------------------------------------------------------------------
// Day end (and the Z report printed from it)
// ---------------------------------------------------------------------------

// CGST, SGST and cess for a day's bills, the way the GST pack files them: the
// bills' own GST, rate by rate, with cess apart. Halving the day's total
// instead gave a signed Z report a few paise off the return filed for the
// same day, and folding cess into CGST/SGST overstated both.
const dayTaxHalves = async (restaurantId, billIds) => {
  if (billIds.length === 0) {
    return { cgst: 0, sgst: 0, cess: 0, tax: 0 };
  }

  const bills = await reportRepository.billsForBreakdown(restaurantId, billIds);
  const breakdownOf = await breakdownsFor(restaurantId, bills);
  let gstPaise = 0;
  let cgst = 0;
  let cess = 0;

  for (const bill of bills) {
    const breakdown = breakdownOf(bill);
    gstPaise += breakdown.gst;
    cess += breakdown.cess;
    cgst += cgstOf(taxableLines(breakdown));
  }

  return { cgst, sgst: gstPaise - cgst, cess, tax: gstPaise + cess };
};

// One drawer on the sheet: what it should hold and what was counted.
const drawerOut = (row) => {
  const openingCash = num(row.opening_cash);
  const cashSales = num(row.cash_sales);
  const cashRefunds = num(row.cash_refunds);
  const cashExpenses = num(row.cash_expenses);
  const supplierCash = num(row.supplier_cash);
  const cashTips = num(row.cash_tips);
  const riderShortfall = num(row.rider_shortfall);
  const riderRepaid = num(row.rider_repaid);
  const cashAdvances = num(row.cash_advances);
  const cashAdvancesReturned = num(row.cash_advances_returned);
  const expectedCash = round2(
    openingCash +
      cashSales +
      cashTips -
      cashRefunds -
      cashExpenses -
      supplierCash -
      riderShortfall +
      riderRepaid +
      cashAdvances -
      cashAdvancesReturned
  );
  const closingCash = row.closing_cash === null || row.closing_cash === undefined ? null : num(row.closing_cash);

  return {
    businessDayId: row.id,
    // Each drawer's own date: added up for All outlets, the main counter's
    // day and a branch's can be on different dates.
    businessDate: row.business_date || null,
    outletId: row.outlet_id || null,
    outletName: row.outlet_name || null,
    label: row.outlet_name || "Main counter",
    dayStatus: row.day_status,
    openedByName: row.opened_by_name || null,
    closedByName: row.closed_by_name || null,
    openingCash,
    cashSales,
    cashRefunds,
    cashExpenses,
    supplierCash,
    // Tips given in cash: in the drawer, never in sales.
    cashTips,
    // Riders' cash: handed in on settlement (inside cash sales already), what
    // they did not hand in (off the drawer), and an owed shortfall repaid.
    riderCash: num(row.rider_cash),
    riderShortfall,
    riderRepaid,
    // Advances and deposits taken in cash, and unused ones handed back.
    cashAdvances,
    cashAdvancesReturned,
    expectedCash,
    closingCash,
    // Positive: the drawer held more than expected; negative: short.
    variance: closingCash === null ? null : round2(closingCash - expectedCash),
    totalExpenses: num(row.total_expenses),
  };
};

// The day-end sheet a manager signs: what each drawer should hold, whether
// the count matched, and everything the printed Z report carries.
//
// Which days it covers:
//   - an outlet picked: that outlet's own business day for the date, with its
//     own drawer. (An outlet that traded on the main counter's day, before
//     outlets had days of their own: its bills within that day, no drawer.)
//   - All outlets: every business day of the date — the main counter's and
//     each outlet's — with every drawer listed and added up.
//   - a business day by id: that day.
// With no date, the days being traded (tradingDays): the outlet's own, else
// its share of the main counter's; for All outlets every day open now — the
// main counter's and each outlet's own, on whatever date each is — added up.
// With none open, the latest day.
const dayEnd = async (
  restaurantId,
  { businessDayId = null, businessDate = null, outletId = null, canSeeLogbook = false } = {}
) => {
  requireRestaurantId(restaurantId);

  const settings = (await restaurantRepository.findSettings(restaurantId)) || {};
  const timezone = zoneOf(settings);
  const outlet = outletId ? await outletRepository.findById(restaurantId, outletId) : null;
  const trading = !businessDayId && !businessDate ? await tradingDays(restaurantId, outlet, timezone, settings) : null;
  let dayIds = [];
  let billOutletId = null;

  if (businessDayId) {
    const day = await businessDayRepository.findById(restaurantId, businessDayId);

    // Another outlet's day is not this outlet's to read.
    if (!day || (outlet && day.outlet_id && Number(day.outlet_id) !== Number(outlet.id))) {
      throw new AppError(404, "Business day not found");
    }

    dayIds = [day.id];
    billOutletId = outlet && !day.outlet_id ? outlet.id : null;
  } else if (trading && trading.dayOpen) {
    dayIds = trading.dayIds;
    billOutletId = outlet && trading.sharesMainDay ? outlet.id : null;
  } else {
    let date = businessDate;

    if (!date) {
      // No day is being traded here: a branch's latest day of its own (the
      // one it just closed, whose Z report is wanted), else the main
      // counter's open day for an outlet that never kept days of its own.
      const latestOwn = outlet ? (await businessDayRepository.findRecent(restaurantId, 1, outlet.id))[0] : null;
      const open = latestOwn || (await businessDayRepository.findOpen(restaurantId, outlet ? null : undefined));

      if (open) {
        date = open.business_date;
      } else {
        const recent = await businessDayRepository.findRecent(restaurantId, 1, outlet ? outlet.id : undefined);
        const latest = recent.length ? recent : await businessDayRepository.findRecent(restaurantId, 1);

        if (latest.length === 0) {
          throw new AppError(404, "No business day has been opened yet");
        }

        date = latest[0].business_date;
      }
    }

    if (outlet) {
      const own = await reportRepository.daysOfDate(restaurantId, date, outlet.id);

      if (own.length > 0) {
        dayIds = [own[0].id];
      } else {
        const main = await reportRepository.daysOfDate(restaurantId, date, null);

        if (main.length === 0) {
          return noDayOn(restaurantId, date, outlet, `No business day was opened on ${tradingDayRules.sayDate(date)} at ${outlet.name}.`);
        }

        dayIds = [main[0].id];
        billOutletId = outlet.id;
      }
    } else {
      dayIds = (await reportRepository.daysOfDate(restaurantId, date)).map((day) => day.id);

      if (dayIds.length === 0) {
        // Asked for by date: the day either was opened or it was not, and
        // saying so beats quietly showing a different day's takings.
        return noDayOn(restaurantId, date, null, `No business day was opened on ${tradingDayRules.sayDate(date)}.`);
      }
    }
  }

  const [data, logbook, owed] = await Promise.all([
    reportRepository.dayEndReport(restaurantId, dayIds, { billOutletId, timezone }),
    canSeeLogbook ? reportRepository.dayLogbook(restaurantId, dayIds) : Promise.resolve(null),
    // Riders' owed shortfalls still outstanding: the outlet's own (an outlet
    // picked), else the whole restaurant's.
    reportRepository.ridersOwed(restaurantId, { all: !outlet, outletId: outlet ? outlet.id : null }),
  ]);

  if (data.drawers.length === 0) {
    throw new AppError(404, "Business day not found");
  }

  const drawers = data.drawers.map((row) => {
    const own = (data.perDay || []).find((day) => Number(day.business_day_id) === Number(row.id)) || {};

    return {
      ...drawerOut(row),
      billCount: own.bill_count || 0,
      netSales: num(own.net_sales),
      firstBill: own.first_bill || null,
      lastBill: own.last_bill || null,
    };
  });
  const head = drawers[0];
  const split = Boolean(settings.gst_split);
  const taxHalves = await dayTaxHalves(restaurantId, data.billIds);
  const coverInfo = coverFigures(data.covers);
  // The sheet covers whole drawers unless it is one outlet's share of the
  // main counter's day; then the cash shown is that outlet's alone.
  const wholeDrawer = billOutletId === null;
  const sum = (key) => round2(drawers.reduce((total, drawer) => total + (drawer[key] || 0), 0));
  const counted = drawers.every((drawer) => drawer.closingCash !== null);
  const outletCash = data.outletCash || {};
  const cashFromMethods = num((data.byMethod.find((row) => row.payment_method === "cash") || {}).amount);
  const expectedCash = wholeDrawer ? sum("expectedCash") : null;
  const closingCash = wholeDrawer && counted ? sum("closingCash") : null;
  // The dates of the days on the sheet, oldest first. More than one only for
  // All outlets while a day is still open on an older date (a main counter
  // left open since 23 Sep beside branches trading on 1 Oct).
  const businessDates = [...new Set(data.drawers.map((row) => row.business_date))].sort();

  return {
    businessDayId: head.businessDayId,
    businessDayIds: drawers.map((drawer) => drawer.businessDayId),
    businessDate: businessDates[businessDates.length - 1],
    businessDates,
    // Still trading while any of its drawers is.
    dayStatus: drawers.some((drawer) => drawer.dayStatus === "open") ? "open" : "closed",
    openedAt: data.drawers[0].opened_at,
    closedAt: drawers.some((drawer) => drawer.dayStatus === "open")
      ? null
      : data.drawers.reduce((latest, row) => (!latest || row.closed_at > latest ? row.closed_at : latest), null),
    openedByName: head.openedByName,
    closedByName: drawers.length === 1 ? head.closedByName : null,
    outletId: outlet ? outlet.id : null,
    outletName: outlet ? outlet.name : null,
    outletClosed: Boolean(outlet && outlet.status !== "active"),
    // The GSTIN the printed Z report carries: an outlet registered on its own
    // prints its own, never the restaurant's.
    gstNumber: (outlet && outlet.gst_number) || settings.gst_number || null,
    // The times on the sheet (opened, closed) are read on the restaurant's
    // own clock, not the browser's.
    timezone,
    billCount: data.sales.bill_count,
    // First to last invoice number: of one series only. Several counters
    // number their own series; each drawer below carries its own.
    firstBill: drawers.length > 1 ? null : data.sales.first_bill,
    lastBill: drawers.length > 1 ? null : data.sales.last_bill,
    grossSales: num(data.sales.gross_sales),
    netSales: num(data.sales.net_sales),
    discounts: num(data.sales.discounts),
    tax: num(data.sales.tax),
    cgst: split ? gst.rupees(taxHalves.cgst) : 0,
    sgst: split ? gst.rupees(taxHalves.sgst) : 0,
    cess: gst.rupees(taxHalves.cess),
    gstSplit: split,
    serviceCharge: num(data.sales.service_charge),
    roundOff: num(data.sales.round_off),
    byMethod: data.byMethod.map((row) => ({
      paymentMethod: row.payment_method,
      amount: num(row.amount),
      paymentCount: row.payment_count,
      tips: round2(num(row.tips)),
    })),
    byOrderType: data.byType.map((row) => ({
      orderType: row.order_type,
      billCount: row.bill_count,
      netSales: num(row.net_sales),
    })),
    voidCount: data.voids.void_count,
    voidValue: num(data.voids.void_value),
    cancelledOrders: data.cancelled.cancelled_count,
    cancelledValue: num(data.cancelled.cancelled_value),
    covers: coverInfo.covers,
    perHead: coverInfo.perHead,
    wholeDrawer,
    // Every drawer of the sheet, each with its own count. One for an
    // outlet's day; the main counter's and each outlet's for All outlets.
    drawers: wholeDrawer ? drawers : [],
    openingCash: wholeDrawer ? sum("openingCash") : null,
    cashSales: wholeDrawer ? sum("cashSales") : cashFromMethods,
    cashRefunds: wholeDrawer ? sum("cashRefunds") : num(data.refunds.cash_refunds),
    cashExpenses: wholeDrawer ? sum("cashExpenses") : num(outletCash.cash_expenses),
    // Cash paid to suppliers out of the till.
    supplierCash: wholeDrawer ? sum("supplierCash") : 0,
    expectedCash,
    closingCash,
    // Positive means the drawers held more than expected, negative means short.
    variance: closingCash === null ? null : round2(closingCash - expectedCash),
    totalRefunds: num(data.refunds.total_refunds),
    refundCount: data.refunds.refund_count,
    totalExpenses: wholeDrawer ? sum("totalExpenses") : num(outletCash.total_expenses),

    // Tips collected, by how they were given (REQ-ACCESS-DAYEND-TIPS). On top
    // of the payments: never in the sales, GST or the P&L. Cash tips are in
    // the drawer's expected cash until they are shared out.
    tips: {
      total: round2(data.byMethod.reduce((total, row) => total + num(row.tips), 0)),
      count: data.byMethod.reduce((total, row) => total + (row.tip_count || 0), 0),
      byMethod: data.byMethod
        .filter((row) => num(row.tips) > 0)
        .map((row) => ({ paymentMethod: row.payment_method, amount: round2(num(row.tips)), count: row.tip_count })),
    },
    cashTips: wholeDrawer ? sum("cashTips") : round2(num((data.byMethod.find((row) => row.payment_method === "cash") || {}).tips)),

    // Riders' cash (SW-X-RIDER-DRAWER): handed in on settlement (inside the
    // cash taken), short and off the drawer, and owed shortfalls repaid.
    riderCash: wholeDrawer ? sum("riderCash") : 0,
    riderShortfall: wholeDrawer ? sum("riderShortfall") : 0,
    riderRepaid: wholeDrawer ? sum("riderRepaid") : 0,
    // Advances and deposits in cash (R4-DRAWER-ADVANCES): in, and handed back.
    cashAdvances: wholeDrawer ? sum("cashAdvances") : 0,
    cashAdvancesReturned: wholeDrawer ? sum("cashAdvancesReturned") : 0,
    // Still owed by riders from settlements so far (any day), as of now.
    ridersOwe: { count: owed.count, riders: owed.riders, amount: round2(num(owed.amount)) },

    // The day's notes, kept apart (SW-B-07): each counter's opening and
    // closing note with who wrote it, and the shift log book's entries for
    // the day (only for someone who may read the log book).
    notes: drawers
      .map((drawer, index) => {
        const row = data.drawers[index];

        return {
          businessDayId: drawer.businessDayId,
          label: drawer.label,
          openingNotes: row.opening_notes || null,
          openedByName: drawer.openedByName,
          openedAt: row.opened_at,
          closingNotes: row.closing_notes || null,
          closedByName: drawer.closedByName,
          closedAt: row.closed_at,
        };
      })
      .filter((note) => note.openingNotes || note.closingNotes),
    logbook: logbook
      ? logbook.map((row) => ({
          id: row.id,
          category: row.category,
          body: row.body,
          shiftLabel: row.shift_label,
          at: row.created_at,
          byName: row.created_by_name || null,
          outletName: row.outlet_name || null,
          followUp: Boolean(row.needs_follow_up),
          closed: Boolean(row.closed_at),
        }))
      : null,
  };
};

module.exports = {
  drawerOut,
  dayEnd,
};
