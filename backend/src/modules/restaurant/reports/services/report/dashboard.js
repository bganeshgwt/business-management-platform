// The owner's dashboard and the live kitchen block.
// Part of report.service.js, which re-exports these for its callers.

const reportRepository = require("../../repositories/report.repository");
const restaurantRepository = require("../../../setup/repositories/restaurant.repository");
const outletRepository = require("../../../setup/repositories/outlet.repository");
const kitchenRepository = require("../../../kitchen/repositories/kitchen.repository");
const { round2 } = require("../../../../../utils/money");
const { coverFigures, num, requireRestaurantId } = require("./common");
const { daysOut, tradingDays, zoneOf } = require("./scope");
const { drawerOut } = require("./dayEnd");
const tradingDayRules = require("../../../business-day/services/tradingDay");

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// What should be in the drawer now, by the same arithmetic as the day-end
// sheet (one definition, drawers() in repositories/report/drawers.js). With
// an outlet chosen: its own day's drawer when it trades a day of its own;
// otherwise only the cash its bills took on the main counter's day (the float
// is not its own). For the whole restaurant: every drawer of the day added up.
const dashboardCash = (data, outlet) => {
  if (!data.cashDays || data.cashDays.length === 0) {
    return null;
  }

  const drawers = data.drawers.map(drawerOut);
  const total = (list, key) => round2(list.reduce((sum, drawer) => sum + (drawer[key] || 0), 0));
  const whole = (list) => ({
    outletOnly: false,
    drawerCount: list.length,
    openingCash: total(list, "openingCash"),
    cashSales: total(list, "cashSales"),
    cashRefunds: total(list, "cashRefunds"),
    cashExpenses: total(list, "cashExpenses"),
    supplierCash: total(list, "supplierCash"),
    expected: total(list, "expectedCash"),
  });

  if (!outlet) {
    return whole(drawers);
  }

  const own = drawers.filter((drawer) => Number(drawer.outletId) === Number(outlet.id));

  if (own.length > 0) {
    return whole(own.slice(0, 1));
  }

  const main = data.cashDays.find((day) => !day.outlet_id);

  return main
    ? {
        outletOnly: true,
        drawerCount: 0,
        openingCash: null,
        cashSales: num(main.outlet_cash_sales),
        cashRefunds: num(main.outlet_cash_refunds),
        cashExpenses: num(main.outlet_cash_expenses),
        supplierCash: 0,
        expected: null,
      }
    : null;
};

// `canSeeSales` false (no sales.view): the takings, the month, the drawer and
// money owed are left out of the answer altogether — not sent and hidden, not
// sent at all. What is left is what a floor needs: what is running, what is
// selling (in plates), what is out of stock.
//
// "Today" is the business day being traded (tradingDays): an outlet's own,
// or — for All outlets — every open day added up, each on its own date.
const dashboard = async (restaurantId, { outletId = null, canSeeSales = true, outletPinned = false } = {}) => {
  requireRestaurantId(restaurantId);

  const settings = (await restaurantRepository.findSettings(restaurantId)) || {};
  const timezone = zoneOf(settings);
  const outlet = outletId ? await outletRepository.findById(restaurantId, outletId) : null;
  const trading = await tradingDays(restaurantId, outlet, timezone, settings);
  const { businessDate } = trading;
  const data = await reportRepository.dashboard(restaurantId, businessDate, timezone, {
    outletId: outlet ? outlet.id : null,
    withSales: canSeeSales,
    dayIds: trading.dayIds,
    dates: [...new Set(trading.days.map((day) => day.business_date))],
  });

  const coverInfo = coverFigures(data.covers);

  const common = {
    businessDate,
    dayOpen: trading.dayOpen,
    // The business days these figures are: one for an outlet, every open day
    // for All outlets (on their own dates, added up).
    openDays: daysOut(trading.days),
    // The outlet has no day of its own open and trades on the main
    // counter's: its own bills in that day, and no drawer of its own.
    sharesMainDay: trading.sharesMainDay,
    timezone,
    outletId: outlet ? outlet.id : null,
    outletName: outlet ? outlet.name : null,
    // A closed outlet left in the switcher of another device: its history is
    // shown, and the screen offers the way back to all outlets. Someone
    // pinned to that outlet cannot switch away — the screen tells them to
    // ask their manager instead.
    outletClosed: Boolean(outlet && outlet.status !== "active"),
    outletPinned: Boolean(outletPinned),
    salesHidden: !canSeeSales,
    openOrders: data.openOrders.count,
    // Running orders taken on an earlier trading day and never closed (a
    // table "eating" since last week): Needs attention lists them.
    openOrdersEarlier: {
      count: data.openOrders.earlier || 0,
      tables: data.openOrders.earlier_tables || 0,
      oldestAt: data.openOrders.earlier_oldest || null,
      ...(canSeeSales ? { value: round2(num(data.openOrders.earlier_value)) } : {}),
    },
    // Today's trading date by the clock (the cut-off hour included). An open
    // day dated before it was left open: the screen asks for it to be closed.
    tradingToday: tradingDayRules.openableDates({ ...settings, timezone }).dates[0],
    tablesTotal: data.tables.total,
    tablesOccupied: data.tables.occupied,
    lowStockCount: data.lowStock,
    openComplaints: data.openComplaints,
    // Counts of what is waiting; the money behind unpaid bills is below.
    unpaid: { count: data.waiting.unpaid },
    // Bills on a guest's or company's account: owed by arrangement, counted
    // apart from the bills still to collect at the till.
    onAccount: { count: data.waiting.on_account },
    expensesAwaitingApproval: data.waiting.expenses_pending,
    poAwaitingDelivery: data.waiting.po_awaiting,
    // The best five and the worst five of what actually sold today. They are
    // the same dishes when fewer than ten sold at all, so the count comes with
    // them and the screen can say so instead of showing one list twice.
    topItems: data.dayItems
      .filter((row) => row.best <= 5)
      .map((row) => ({
        itemName: row.item_name,
        quantity: num(row.quantity),
        ...(canSeeSales ? { grossSales: round2(num(row.gross_sales)) } : {}),
      })),
    lowItems: data.dayItems
      .filter((row) => row.worst <= 5)
      .sort((a, b) => Number(a.worst) - Number(b.worst))
      .map((row) => ({
        itemName: row.item_name,
        quantity: num(row.quantity),
        ...(canSeeSales ? { grossSales: round2(num(row.gross_sales)) } : {}),
      })),
    // How many distinct dishes sold at all, so "the slowest five" can admit
    // when it is simply the whole list read backwards.
    soldLines: data.dayItems.length ? num(data.dayItems[0].sold_lines) : 0,
    unsoldToday: data.unsoldToday,
    covers: {
      orders: data.orderMix.order_count,
      dineIn: data.orderMix.dine_in,
      takeaway: data.orderMix.takeaway,
      delivery: data.orderMix.delivery,
      // Guests served today (billed dine-in tables) and guests at tables now.
      guests: coverInfo.covers,
      seatedNow: data.openOrders.seated,
      ...(canSeeSales
        ? {
            perHead: coverInfo.perHead,
            dineInWithoutGuests: coverInfo.dineInWithoutGuests,
          }
        : {}),
    },
  };

  if (!canSeeSales) {
    return common;
  }

  const salesOf = (type) => round2(num((data.byType.find((row) => row.order_type === type) || {}).net_sales));

  return {
    ...common,
    billCount: data.today.bill_count,
    netSales: num(data.today.net_sales),
    averageBill: round2(num(data.today.average_bill)),
    discounts: num(data.today.discounts),
    openOrderValue: num(data.openOrders.value),
    covers: {
      ...common.covers,
      // By the bill's day and order type, so the three add up to the day's
      // sales exactly.
      dineInSales: salesOf("dine_in"),
      takeawaySales: salesOf("takeaway"),
      deliverySales: salesOf("delivery"),
    },
    // Seven days ending today, every one of them: a day with no sales is a
    // zero on the chart, not a gap the line jumps over.
    trend: data.trend.map((row) => ({
      businessDate: row.business_date,
      netSales: round2(num(row.net_sales)),
      billCount: row.bill_count,
    })),

    // How today is going compared with days worth comparing it to. A quiet
    // Monday only means something next to other Mondays.
    compare: {
      yesterday: num(data.compare.yesterday),
      sameDayLastWeek: num(data.compare.same_day_last_week),
      // The like-for-like figure the percentage on screen is built from.
      sameDayLastWeekToTime: num(data.compare.same_day_last_week_to_time),
    },

    // Every open day with what it adds to today's figures: with All outlets
    // a counter still on an older date is part of "Sales today", and the
    // screen says so (its bills are not in the 7-day chart's "today").
    openDays: common.openDays.map((day) => {
      const row = data.byDay.find((entry) => Number(entry.business_day_id) === day.businessDayId) || {};

      return { ...day, billCount: row.bill_count || 0, netSales: round2(num(row.net_sales)) };
    }),

    // The money collected in the day, as the drawer, the day-end sheet and
    // the Bills screen count it: dues from earlier days' bills collected
    // today included, and said apart (duesCollected).
    byMethod: data.byMethod.map((row) => ({
      paymentMethod: row.payment_method,
      amount: num(row.amount),
    })),
    duesCollected: round2(data.byMethod.reduce((sum, row) => sum + num(row.dues), 0)),

    // What should be in the drawer, by the same arithmetic the day-end report
    // uses, so the two screens can never disagree. With one outlet chosen,
    // only that outlet's cash: the float belongs to the whole restaurant.
    cash: dashboardCash(data, outlet),

    unpaid: { count: data.unpaid.count, due: num(data.unpaid.due) },
    onAccount: { count: data.unpaid.account_count, due: round2(num(data.unpaid.account_due)) },
    refunds: num(data.returns.refunds),
    voids: data.returns.voids,
    expensesToday: num(data.spending.today),

    month: data.month
      ? {
          sales: num(data.month.sales),
          bills: data.month.bills,
          daysTraded: data.month.days_traded,
          previousSales: num(data.month.previous_sales),
          previousDaysTraded: data.month.previous_days_traded,
          averageDay: data.month.days_traded ? round2(num(data.month.sales) / data.month.days_traded) : 0,
          // Whether the two spans are worth comparing at all. A restaurant
          // that opened on the 22nd of last month has ONE day of takings in
          // that window, and "1214% up" is arithmetic rather than information.
          // Two thirds is the line: a closed week still compares, a month that
          // barely happened does not.
          comparable:
            num(data.month.previous_sales) > 0 &&
            data.month.previous_days_traded >= Math.ceil(data.month.days_traded * 0.66),
        }
      : {
          sales: 0,
          bills: 0,
          daysTraded: 0,
          previousSales: 0,
          previousDaysTraded: 0,
          averageDay: 0,
          comparable: false,
        },

    byHour: data.byHour.map((row) => ({ hour: row.hour, netSales: num(row.net_sales) })),
  };
};

// ---------------------------------------------------------------------------
// The kitchen, live, for the dashboard
// ---------------------------------------------------------------------------

// What a manager glancing at the dashboard needs from the kitchen: tickets at
// each stage now, how many are late, how long the oldest has waited, and how
// long a ticket has taken today on average. The day's figures are the kitchen
// display's own (kitchenRepository.findStats), so "average ticket time" is the
// same number on both screens.
//
// `avgReadySeconds` is passed on as the database worked it out. A ticket
// marked ready before it was cut would make it negative; the screen shows a
// dash for that rather than "-3 min", and the figure is left as it is here so
// the fault stays visible instead of being rounded away.
//
// The day is the outlet's own (tradingDays), as on the rest of the dashboard:
// read from whichever day of the restaurant happened to be open, a branch on
// 1 Oct showed the main counter's 23 Sep. With no day open, the last one.
const kitchenLive = async (restaurantId, { outletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const settings = (await restaurantRepository.findSettings(restaurantId)) || {};
  const outlet = outletId ? await outletRepository.findById(restaurantId, outletId) : null;
  const [now, trading] = await Promise.all([
    reportRepository.kitchenNow(restaurantId, { outletId }),
    tradingDays(restaurantId, outlet, zoneOf(settings), settings),
  ]);
  const day = trading.dayOpen
    ? { ids: trading.dayIds, businessDate: trading.businessDate, isOpen: true }
    : await kitchenRepository.findTodayDayIds(restaurantId);

  const today =
    day.ids.length > 0
      ? await kitchenRepository.findStats(restaurantId, {
          dayIds: day.ids,
          stationId: null,
          outletId,
          lateMinutes: now.lateMinutes,
        })
      : null;

  return {
    serverTime: now.server_time,
    businessDate: day.businessDate,
    dayOpen: day.isOpen,
    warnMinutes: now.warnMinutes,
    lateMinutes: now.lateMinutes,
    // On the board right now, whatever day the ticket was cut.
    newCount: now.new_count,
    cookingCount: now.cooking_count,
    readyCount: now.ready_count,
    openCount: now.new_count + now.cooking_count + now.ready_count,
    lateNow: now.late_count,
    // Tickets left open from an earlier trading day (not on the board).
    earlierOpen: now.earlier_count || 0,
    oldestWaitingAt: now.oldest_waiting_at,
    // Across the business day (or the last one, once it is closed).
    avgReadySeconds: today ? today.avg_ready_seconds : null,
    timedToday: today ? today.timed_count : 0,
    lateToday: today ? today.late_count : 0,
    servedToday: today ? today.served_count : 0,
  };
};

module.exports = {
  dashboard,
  kitchenLive,
};
