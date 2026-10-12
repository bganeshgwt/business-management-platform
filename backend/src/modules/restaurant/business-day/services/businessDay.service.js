const pool = require("../../../../config/database");
const queryAll = require("../../../../utils/queryAll");
const businessDayRepository = require("../repositories/businessDay.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const expenseRepository = require("../../expenses/repositories/expense.repository");
const cashDrawerRepository = require("../repositories/cashDrawer.repository");
const loyaltyService = require("../../crm/services/loyalty.service");
const tradingDay = require("./tradingDay");
const outletRepository = require("../../setup/repositories/outlet.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

const DUPLICATE = "23505";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const n = (value) => Number(value || 0);

const rupees = (value, currency = "₹") =>
  `${value < 0 ? "-" : ""}${currency}${Math.abs(n(value)).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

// business_date arrives as plain "YYYY-MM-DD" text (see config/database.js).
const toDay = (row) =>
  row && {
    id: row.id,
    businessDate: row.business_date,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openingCash: Number(row.opening_cash),
    // The cash the day accounts for (the figure the day-end sheet compares):
    // the count, plus cash dropped to the safe, less cash put in from it.
    closingCash: row.closing_cash === null ? null : Number(row.closing_cash),
    // What was in the drawer itself when it was counted.
    countedCash: row.counted_cash === null || row.counted_cash === undefined ? null : Number(row.counted_cash),
    countMethod: row.count_method || null,
    denominations: row.count_denominations || null,
    blindCount: Boolean(row.blind_count),
    firstCount: row.first_count === null || row.first_count === undefined ? null : Number(row.first_count),
    expectedCash: row.expected_cash === null || row.expected_cash === undefined ? null : Number(row.expected_cash),
    cashDropped: n(row.cash_dropped),
    cashPaidIn: n(row.cash_paid_in),
    variance: row.cash_variance === null || row.cash_variance === undefined ? null : Number(row.cash_variance),
    varianceReason: row.variance_reason || null,
    methodChecks: row.method_checks || null,
    reopenedCount: Number(row.reopened_count || 0),
    notes: row.notes,
    // Kept apart (SW-B-07): what the opener wrote, and what the closer wrote.
    // Who and when are the day's own opened/closed by and at.
    openingNotes: row.opening_notes || null,
    closingNotes: row.closing_notes || null,
    dayStatus: row.day_status,
    openedByName: row.opened_by_name || null,
    closedByName: row.closed_by_name || null,
    outletId: row.outlet_id || null,
  };

const toRules = (settings) => ({
  cutoffHour: Number(settings.day_cutoff_hour ?? 5),
  varianceThreshold: n(settings.cash_variance_threshold ?? 100),
  blindCount: Boolean(settings.cash_blind_count),
});

const may = (user, permission) => Boolean(user && Array.isArray(user.permissions) && user.permissions.includes(permission));

// A blind count hides what the drawer should hold from whoever counts it,
// unless they may close the day themselves (the manager signing it off).
const seesExpected = (settings, user) => !settings.cash_blind_count || may(user, "business_day.close");

// --- Opening --------------------------------------------------------------------

// The dates a day may be opened for at this till now, which of them is taken,
// and the one the screen should offer.
const openingWindow = async (restaurantId, outletId, settings) => {
  const window = tradingDay.openableDates(settings);
  const taken = [];

  for (const date of window.dates) {
    const day = await businessDayRepository.findByDate(restaurantId, date, outletId || null);

    if (day) {
      taken.push({ date, id: day.id, dayStatus: day.day_status });
    }
  }

  const free = window.dates.filter((date) => !taken.some((row) => row.date === date));
  // Before the cut-off with last night never opened, last night is what is
  // being traded; otherwise today.
  const suggested = free.length ? free[0] : null;

  return { ...window, taken, suggested };
};

const getStatus = async (restaurantId, outletId, user) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const [current, history, window] = await Promise.all([
    businessDayRepository.findOpen(restaurantId, outletId),
    businessDayRepository.findRecent(restaurantId, 30, outletId),
    openingWindow(restaurantId, outletId, settings),
  ]);
  const canSee = seesExpected(settings, user);
  // Which till this is: the main counter (no outlet) or an outlet's own.
  const counterOutletId = current ? current.outlet_id || null : outletId || null;
  let counterName = "Main counter";

  if (counterOutletId) {
    const outlet = await outletRepository.findById(restaurantId, counterOutletId).catch(() => null);
    counterName = outlet ? outlet.name : "This outlet";
  }

  // A day left open from an earlier date (older than last night's, which may
  // still be trading before the morning cut-off): every entry since has gone
  // on that old date. The screens say so in red and offer to close it.
  const currentDate = current ? String(current.business_date).slice(0, 10) : null;
  const staleDays =
    currentDate && currentDate < window.dates[0]
      ? Math.round((Date.parse(`${window.today}T00:00:00Z`) - Date.parse(`${currentDate}T00:00:00Z`)) / 86400000)
      : 0;

  return {
    counter: { outletId: counterOutletId, name: counterName },
    stale: staleDays > 0 ? { days: staleDays, businessDate: currentDate, today: window.today } : null,
    current: toDay(current) || null,
    history: history.map(toDay).map((day) => (canSee ? day : { ...day, expectedCash: null })),
    rules: toRules(settings),
    opening: {
      today: window.today,
      dates: window.dates,
      cutoffHour: window.cutoff,
      taken: window.taken,
      suggested: window.suggested,
    },
    blind: !canSee,
  };
};

// Past days between two dates, a page at a time: "26–50 of 90". What the
// drawer should have held is left out for a blind counter, as on the status.
const listDays = async (restaurantId, outletId, user, { from, to, page, pageSize }) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const canSee = seesExpected(settings, user);
  const { rows, total } = await businessDayRepository.findPage(restaurantId, {
    from,
    to,
    outletId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    items: rows.map(toDay).map((day) => (canSee ? day : { ...day, expectedCash: null })),
    total,
    page,
    pageSize,
  };
};

// Only one day can be open at a time; the database enforces this too.
//
// The date, for a person opening the day at the till ({ atTill: true }, as
// the API does): today's, or (until the cut-off hour of the morning)
// yesterday's, on the restaurant's own clock. A business day for next January
// or for four months ago was accepted before, and every report of that date
// then counted takings that never happened on it. The demo seed scripts call
// this directly to lay down past days, which is what they are for.
const openDay = async (restaurantId, data, userId, { atTill = false } = {}) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const window = await openingWindow(restaurantId, data.outletId, settings);
  const businessDate = data.businessDate || window.suggested || window.today;

  if (atTill && !window.dates.includes(businessDate)) {
    const later = businessDate > window.today;
    const yesterday = window.dates.length > 1 ? window.dates[0] : null;

    throw new AppError(
      400,
      later
        ? `A business day cannot be opened for ${tradingDay.sayDate(businessDate)}: that date has not come yet. Open today's day (${tradingDay.sayDate(window.today)}).`
        : `Only today's business day can be opened${yesterday ? `, or last night's (${tradingDay.sayDate(yesterday)}) until ${window.cutoff}:00 in the morning` : ` (before ${window.cutoff}:00 in the morning, last night's too)`}. ${tradingDay.sayDate(businessDate)} is past.`,
      { reason: "date_not_allowed", today: window.today, dates: window.dates, cutoffHour: window.cutoff }
    );
  }

  const alreadyOpen = await businessDayRepository.findOpen(restaurantId, data.outletId);

  if (alreadyOpen) {
    throw new AppError(
      409,
      `Business day ${alreadyOpen.business_date} is still open. Close it first.`
    );
  }

  const existing = await businessDayRepository.findByDate(restaurantId, businessDate, data.outletId);

  if (existing) {
    throw new AppError(
      409,
      `Business day ${businessDate} has already been closed. If it was closed by mistake, reopen it from Recent days.`,
      { reason: "date_closed", businessDayId: existing.id }
    );
  }

  let day;

  try {
    const id = await businessDayRepository.open(restaurantId, { ...data, businessDate }, userId);
    day = toDay(await businessDayRepository.findById(restaurantId, id));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "A business day is already open");
    }

    throw error;
  }

  // Points that ran out overnight are written off as the day starts, so the
  // till and the guest book show what guests really hold. In the background:
  // opening the day never waits for it, or fails because of it.
  loyaltyService.sweepRestaurant(restaurantId).catch(() => undefined);

  return day;
};

// --- What the drawer should hold ---------------------------------------------------

const METHOD_ORDER = ["cash", "card", "upi", "online", "wallet", "other"];

// The day's cash by its parts — the day-end sheet's own definitions
// (report.repository DRAWER_PARTS) for cash taken, given back and spent, and
// supplier cash paid from this till by the till rule (tillRules: an outlet
// with a day of its own pays out of its own drawer) — plus cash put in or
// taken out of the drawer during the day.
//
// cashOfDay works the two totals out of a cashDrawerRepository.dayCash row:
// what the day's trading should have left (the day-end sheet's expected),
// and what the drawer itself should hold now (less what went to the safe,
// plus what came from it). The cash-in-and-out check uses it too, inside the
// transaction that holds the day.
const cashOfDay = (row) => {
  // Cash tips are in the drawer until they are shared out; a rider's
  // shortfall never reached it, and an owed one repaid today did
  // (report.repository DRAWER_PARTS).
  const dayExpected = round2(
    n(row.opening_cash) +
      n(row.cash_sales) +
      n(row.cash_tips) -
      n(row.cash_refunds) -
      n(row.cash_expenses) -
      n(row.supplier_cash) -
      n(row.rider_shortfall) +
      n(row.rider_repaid) +
      n(row.cash_advances) -
      n(row.cash_advances_returned)
  );

  return { dayExpected, inDrawer: round2(dayExpected - n(row.dropped) + n(row.paid_in)) };
};

// db: the pool, or the client of the transaction holding the day (closeDay).
const dayFigures = async (restaurantId, day, db = undefined) => {
  const [drawer, byMethod] = await queryAll(db, [
    () => cashDrawerRepository.dayCash(restaurantId, day.id, db),
    () => cashDrawerRepository.dayByMethod(restaurantId, day.id, db),
  ]);

  const openingCash = n(drawer.opening_cash);
  const cashSales = n(drawer.cash_sales);
  const cashRefunds = n(drawer.cash_refunds);
  const cashExpenses = n(drawer.cash_expenses);
  const supplierCash = n(drawer.supplier_cash);
  const paidIn = n(drawer.paid_in);
  const dropped = n(drawer.dropped);
  const { dayExpected, inDrawer } = cashOfDay(drawer);

  const find = (rows, method) => rows.find((row) => row.method === method) || { amount: 0, count: 0 };
  const methods = [...new Set([...byMethod.payments, ...byMethod.refunds].map((row) => row.method))]
    .sort((a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b))
    .map((method) => {
      const taken = find(byMethod.payments, method);
      const back = find(byMethod.refunds, method);
      const dues = find(byMethod.dues, method);

      return {
        method,
        taken: round2(n(taken.amount)),
        payments: taken.count,
        refunded: round2(n(back.amount)),
        net: round2(n(taken.amount) - n(back.amount)),
        duesCollected: round2(n(dues.amount)),
      };
    });

  return {
    openingCash,
    cashSales,
    duesCollectedCash: round2(n(find(byMethod.dues, "cash").amount)),
    cashRefunds,
    cashExpenses,
    pettyCash: round2(n(drawer.petty_cash)),
    supplierCash,
    cashTips: round2(n(drawer.cash_tips)),
    riderShortfall: round2(n(drawer.rider_shortfall)),
    riderRepaid: round2(n(drawer.rider_repaid)),
    // Advances and deposits taken in cash, and unused ones handed back.
    cashAdvances: round2(n(drawer.cash_advances)),
    cashAdvancesReturned: round2(n(drawer.cash_advances_returned)),
    paidIn,
    dropped,
    dayExpected,
    inDrawer,
    methods,
  };
};

// The count, as the closer gave it: notes and coins add up to the total.
//
// count: { counted, countMethod: 'notes' | 'total', denominations }
const DENOMINATIONS = ["2000", "500", "200", "100", "50", "20", "10", "coins"];

const checkCount = (count) => {
  if (count.countMethod !== "notes") {
    return;
  }

  const notes = count.denominations || {};
  let paise = 0;

  for (const key of DENOMINATIONS) {
    const value = notes[key];

    if (value === undefined || value === null || value === "") {
      continue;
    }

    const number = Number(value);

    if (!Number.isFinite(number) || number < 0 || (key !== "coins" && !Number.isInteger(number))) {
      throw new AppError(400, key === "coins" ? "Coins must be an amount of 0 or more" : `The number of ₹${key} notes must be a whole number`);
    }

    paise += key === "coins" ? Math.round(number * 100) : Number(key) * 100 * number;
  }

  if (paise !== Math.round(count.counted * 100)) {
    throw new AppError(
      400,
      `The notes and coins counted come to ${rupees(paise / 100)}, not ${rupees(count.counted)}. Count again, or type the total instead.`,
      { reason: "count_mismatch", fromNotes: paise / 100 }
    );
  }
};

// A day or a drawer counted more than the threshold over or short needs a
// reason. The difference is said at once — the count is in, so a blind count
// has done its job — and the first figure typed is kept.
const requireReason = (variance, threshold, reason, currency, extra = {}) => {
  if (Math.abs(variance) > threshold + 0.004 && !reason) {
    throw new AppError(
      400,
      `The drawer is ${rupees(Math.abs(variance), currency)} ${variance < 0 ? "short" : "over"}. More than ${rupees(threshold, currency)} needs a reason before it can be closed.`,
      { reason: "variance_reason_required", variance, threshold, ...extra }
    );
  }
};

// Card and UPI totals ticked against the card machine's settlement and the
// bank app. Each non-cash way the day was paid needs a tick, or the figure
// the machine shows with a note when it differs.
const checkMethods = (methodChecks, figures) => {
  if (!Array.isArray(methodChecks)) {
    return null;
  }

  const due = figures.methods.filter((row) => row.method !== "cash" && Math.abs(row.net) > 0.004);
  const checked = [];

  for (const row of due) {
    const given = methodChecks.find((item) => item && item.method === row.method);

    if (!given || (given.matched !== true && (given.reported === undefined || given.reported === null || given.reported === ""))) {
      throw new AppError(
        400,
        `Tick ${row.method === "upi" ? "UPI" : row.method} (${rupees(row.net)}) against the ${row.method === "card" ? "card machine's settlement" : row.method === "upi" ? "UPI app" : "statement"}, or type what it shows.`,
        { reason: "method_check_required", method: row.method }
      );
    }

    const reported = given.matched === true ? row.net : Number(given.reported);

    if (!Number.isFinite(reported) || reported < 0) {
      throw new AppError(400, `What the ${row.method} statement shows must be an amount`, { reason: "method_check_required", method: row.method });
    }

    const differs = Math.abs(reported - row.net) > 0.004;
    const note = typeof given.note === "string" ? given.note.trim().slice(0, 200) : "";

    if (differs && !note) {
      throw new AppError(
        400,
        `${row.method === "upi" ? "UPI" : row.method.charAt(0).toUpperCase() + row.method.slice(1)} shows ${rupees(reported)} but the bills say ${rupees(row.net)}. Write a note saying why.`,
        { reason: "method_note_required", method: row.method }
      );
    }

    checked.push({ method: row.method, system: row.net, reported: round2(reported), matched: !differs, note: note || null });
  }

  return checked;
};

// Everything that decides whether the day may close with this count, worked
// out without writing anything — for the check before a manager's PIN, and
// again for the close itself.
//
// data: { outletId, closingCash (the count in the drawer), countMethod,
//         denominations, varianceReason,
//         methodChecks, carryUnpaid }
//
// atTill: a person closing at the till (every close through the API). Then
// cash expenses still waiting for approval stop the close, and a difference
// beyond the threshold needs a reason. The demo seed scripts close past days
// directly without them.
const evaluateClose = async (restaurantId, data, user, settings = null, { atTill = true } = {}) => {
  requireRestaurantId(restaurantId);

  const rules = settings || (await restaurantRepository.findSettings(restaurantId));
  const currency = rules.currency_symbol || "₹";
  const current = await businessDayRepository.findOpen(restaurantId, data.outletId);

  if (!current) {
    throw new AppError(409, "No business day is open");
  }

  // A day is not over while tables are still eating or bills are unpaid.
  //
  // Nothing used to check. The day simply closed, the open orders stayed open
  // against a day that no longer existed, and the POS went on showing those
  // tables as "running" for two and three days afterwards.
  const unsettled = await businessDayRepository.findUnsettled(restaurantId, current.id, data.outletId);

  const openOrders = unsettled.orders.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    orderType: row.order_type,
    tableNo: row.table_no,
    total: Number(row.total_amount),
    placedAt: row.placed_at,
    businessDate: row.business_date,
  }));

  const unpaidBills = unsettled.bills.map((row) => ({
    id: row.id,
    billNumber: row.bill_number,
    orderNumber: row.order_number,
    tableNo: row.table_no,
    total: Number(row.total_amount),
    due: round2(Number(row.due_amount)),
  }));

  // Open orders are a hard stop: each must be billed or cancelled with a
  // reason. There is no override, because closing over them is exactly how a
  // table ends up "open" for three days.
  if (openOrders.length > 0) {
    throw new AppError(
      409,
      openOrders.length === 1
        ? "1 order is still open. Bill it or cancel it before closing the day."
        : `${openOrders.length} orders are still open. Bill or cancel them before closing the day.`,
      { reason: "open_orders", openOrders, unpaidBills }
    );
  }

  // Unpaid bills are different: a regular who settles next week is a real
  // thing. So they stop the close by default, and can be carried over as dues
  // only when the manager says so — which is written onto the day.
  // The amount is said in the restaurant's own currency, because this sentence
  // is shown to the manager and written onto the day as it stands.
  let dueText = "";

  if (unpaidBills.length > 0) {
    const due = round2(unpaidBills.reduce((sum, bill) => sum + bill.due, 0));

    dueText = `${currency}${due.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  }

  if (unpaidBills.length > 0 && !data.carryUnpaid) {
    throw new AppError(
      409,
      unpaidBills.length === 1
        ? `1 bill is unpaid (${dueText} due). Collect it, or close anyway and carry it as a due.`
        : `${unpaidBills.length} bills are unpaid (${dueText} due). Collect them, or close anyway and carry them as dues.`,
      { reason: "unpaid_bills", openOrders: [], unpaidBills }
    );
  }

  // Cash paid out for an expense that is still waiting for approval has left
  // the drawer, but the drawer does not count it until it is approved — the
  // count would come out short by it. Each is approved or rejected first.
  const pendingExpenses = atTill ? await expenseRepository.findPendingCashOfDay(restaurantId, current) : [];

  if (pendingExpenses.length > 0) {
    const total = round2(pendingExpenses.reduce((sum, row) => sum + n(row.amount), 0));

    throw new AppError(
      409,
      `${pendingExpenses.length} cash ${pendingExpenses.length === 1 ? "expense is" : "expenses are"} waiting for approval (${rupees(total, currency)}). Approve or reject ${pendingExpenses.length === 1 ? "it" : "them"} under Expenses first: the cash has already left the drawer.`,
      {
        reason: "pending_expenses",
        openOrders: [],
        unpaidBills,
        pendingExpenses: pendingExpenses.map((row) => ({ id: row.id, amount: n(row.amount), category: row.category_name, notes: row.notes })),
      }
    );
  }

  // Each cashier's drawer is counted and handed over before the day's own count.
  const drawers = await cashDrawerRepository.listDrawers(restaurantId, current.id);
  const openDrawers = drawers.filter((row) => row.drawer_status === "open");

  if (openDrawers.length > 0) {
    throw new AppError(
      409,
      `${openDrawers.map((row) => `${row.cashier_name}'s`).join(", ")} drawer ${openDrawers.length === 1 ? "is" : "are"} still open. End ${openDrawers.length === 1 ? "that shift" : "those shifts"} (count the drawer) under Drawers & cash first.`,
      {
        reason: "open_drawers",
        openOrders: [],
        unpaidBills,
        openDrawers: openDrawers.map((row) => ({ id: row.id, cashierName: row.cashier_name, openedAt: row.opened_at })),
      }
    );
  }

  checkCount({ counted: data.closingCash, countMethod: data.countMethod, denominations: data.denominations });

  const figures = await dayFigures(restaurantId, current);
  const variance = round2(data.closingCash - figures.inDrawer);
  const threshold = n(rules.cash_variance_threshold ?? 100);
  const blind = !seesExpected(rules, user);

  // The count is in: its first figure is kept before any difference is
  // shown. A blind counter learns the difference from the check, so their
  // first figure is kept whatever it was: a recount made to match stays
  // visible beside it.
  if (atTill && (blind || (Math.abs(variance) > threshold + 0.004 && !data.varianceReason))) {
    await businessDayRepository.keepFirstCount(restaurantId, current.id, data.closingCash);
  }

  if (atTill) {
    requireReason(
      variance,
      threshold,
      data.varianceReason,
      currency,
      blind ? { counted: data.closingCash } : { expectedCash: figures.inDrawer, counted: data.closingCash }
    );
  }

  const methodChecks = checkMethods(data.methodChecks, figures);

  return {
    current,
    figures,
    variance,
    threshold,
    blind,
    methodChecks,
    unpaidBills,
    dueText,
    currency,
  };
};

// The trading date of a moment: its date on the restaurant's clock less the
// morning cut-off (an order at 1:30 am belongs to last night).
const tradingDateOf = (settings, at) => {
  const cutoff = Number(settings && settings.day_cutoff_hour !== undefined && settings.day_cutoff_hour !== null ? settings.day_cutoff_hour : 5);

  return tradingDay.todayOf(settings, new Date(new Date(at).getTime() - cutoff * 3600000));
};

const earlierOrdersOf = (orders, settings) => {
  const today = tradingDateOf(settings, new Date());
  const earlier = orders.filter((row) => row.placed_at && tradingDateOf(settings, row.placed_at) < today);

  if (earlier.length === 0) {
    return { count: 0, value: 0, oldest: null };
  }

  const oldest = earlier.reduce((first, row) => (new Date(row.placed_at) < new Date(first.placed_at) ? row : first));

  return {
    count: earlier.length,
    value: round2(earlier.reduce((sum, row) => sum + n(row.total_amount), 0)),
    oldest: tradingDateOf(settings, oldest.placed_at),
    today,
  };
};

// What the close dialog shows before the count: what the drawer should hold
// (hidden from a blind counter), the card and UPI totals to tick, and what is
// in the way of closing.
const closePreview = async (restaurantId, outletId, user) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const current = await businessDayRepository.findOpen(restaurantId, outletId);

  if (!current) {
    throw new AppError(409, "No business day is open");
  }

  const [figures, unsettled, pendingExpenses, drawers] = await Promise.all([
    dayFigures(restaurantId, current),
    businessDayRepository.findUnsettled(restaurantId, current.id, outletId),
    expenseRepository.findPendingCashOfDay(restaurantId, current),
    cashDrawerRepository.listDrawers(restaurantId, current.id),
  ]);
  const canSee = seesExpected(settings, user);
  const hidden = canSee
    ? figures
    : {
        // A blind counter sees what they need to tick the card machine and
        // the UPI app, not what the cash should come to.
        methods: figures.methods.filter((row) => row.method !== "cash"),
        paidIn: figures.paidIn,
        dropped: figures.dropped,
      };

  return {
    day: toDay(current),
    rules: toRules(settings),
    blind: !canSee,
    figures: hidden,
    blockers: {
      openOrders: unsettled.orders.length,
      unpaidBills: unsettled.bills.map((row) => ({
        id: row.id,
        billNumber: row.bill_number,
        orderNumber: row.order_number,
        tableNo: row.table_no,
        due: round2(n(row.due_amount)),
      })),
      // One line for the dialog however many there are: how many, what they
      // come to, and the five largest to name.
      unpaidSummary: {
        count: unsettled.bills.length,
        due: round2(unsettled.bills.reduce((sum, row) => sum + n(row.due_amount), 0)),
        largest: [...unsettled.bills]
          .sort((a, b) => n(b.due_amount) - n(a.due_amount))
          .slice(0, 5)
          .map((row) => ({ id: row.id, billNumber: row.bill_number, tableNo: row.table_no, due: round2(n(row.due_amount)) })),
      },
      openOrdersValue: round2(unsettled.orders.reduce((sum, row) => sum + n(row.total_amount), 0)),
      // Orders taken on an earlier trading day and never billed or
      // cancelled (a table "eating" for twelve days): said apart, oldest
      // first, so they are dealt with before the close.
      earlierOrders: earlierOrdersOf(unsettled.orders, settings),
      pendingExpenses: pendingExpenses.map((row) => ({ id: row.id, amount: n(row.amount), category: row.category_name })),
      openDrawers: drawers
        .filter((row) => row.drawer_status === "open")
        .map((row) => ({ id: row.id, cashierName: row.cashier_name, openedAt: row.opened_at })),
    },
  };
};

// The check a closing screen makes before asking a manager for a PIN: what
// the close would do, or why it would be refused — in a 200, so a refusal
// is shown, not logged as a failed request. Nothing is written except the
// first figure of a count that came out beyond the threshold.
const checkClose = async (restaurantId, data, user) => {
  try {
    const result = await evaluateClose(restaurantId, data, user, null, { atTill: true });

    return {
      refused: null,
      businessDayId: result.current.id,
      variance: result.variance,
      // A blind counter is told how far out the count is, not the figure.
      expectedCash: result.blind ? null : result.figures.inDrawer,
      threshold: result.threshold,
      approval: may(user, "business_day.close")
        ? null
        : {
            permission: "business_day.close",
            scope: { businessDayId: result.current.id, closingCash: data.closingCash, carryUnpaid: Boolean(data.carryUnpaid) },
          },
    };
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }

    return {
      refused: { message: error.message, status: error.statusCode, ...(error.details || {}) },
    };
  }
};

// who: the person closing (the API passes the signed-in user; the seed
// scripts pass a user id).
const closeDay = async (restaurantId, data, who, { atTill = false } = {}) => {
  requireRestaurantId(restaurantId);

  const user = who && typeof who === "object" ? who : { id: who, permissions: [] };
  const settings = await restaurantRepository.findSettings(restaurantId);
  const result = await evaluateClose(
    restaurantId,
    { ...data, closingCash: Number(data.closingCash), outletId: data.outletId || null },
    user,
    settings,
    { atTill }
  );
  const { current, figures, variance, unpaidBills, dueText } = result;
  let notes = data.notes || null;

  if (unpaidBills.length > 0) {
    const carried = `Closed with ${unpaidBills.length} unpaid ${
      unpaidBills.length === 1 ? "bill" : "bills"
    } carried as dues (${dueText}). They are listed under Bills, unpaid, for ${tradingDay.sayDate(current.business_date)}.`;

    notes = notes ? `${notes}\n${carried}` : carried;
  }

  // Written with the day held (cashDrawerRepository.lockDay, the hold cash in
  // and out takes): a cash drop sent while the count was being typed either
  // went in before — and is then caught below — or waits until the day is
  // closed and is refused. Without the hold, a drop landing between the
  // check and the write was left out of the figures the close was signed on.
  const client = await pool.connect();
  let closed;

  try {
    await client.query("BEGIN");
    await cashDrawerRepository.lockDay(client, restaurantId, current.id);

    const now = await dayFigures(restaurantId, current, client);

    if (
      Math.abs(now.inDrawer - figures.inDrawer) > 0.004 ||
      Math.abs(now.dropped - figures.dropped) > 0.004 ||
      Math.abs(now.paidIn - figures.paidIn) > 0.004
    ) {
      throw new AppError(
        409,
        "Cash went into or out of the drawer while the count was being entered. Check the drawer and count again.",
        { reason: "drawer_changed" }
      );
    }

    closed = await businessDayRepository.close(
      restaurantId,
      current.id,
      {
        // The cash the day accounts for: what the day-end sheet compares with
        // the day's expected cash, so its over/short is this one.
        closingCash: round2(Number(data.closingCash) + figures.dropped - figures.paidIn),
        countedCash: Number(data.closingCash),
        countMethod: data.countMethod,
        denominations: data.countMethod === "notes" ? data.denominations : null,
        blindCount: result.blind,
        expectedCash: figures.inDrawer,
        cashDropped: figures.dropped,
        cashPaidIn: figures.paidIn,
        variance,
        varianceReason: data.varianceReason || null,
        methodChecks: result.methodChecks,
        notes,
      },
      user.id,
      client
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (!closed) {
    throw new AppError(409, "No business day is open");
  }

  return { day: toDay(await businessDayRepository.findById(restaurantId, current.id)), result };
};

// --- Reopening -------------------------------------------------------------------

// A day closed by mistake (at lunch, instead of the shift) is opened again,
// with a reason. Only the till's latest day, only while it is still that
// day's date (or last night's before the cut-off) — a day of last week stays
// as it was signed.
const reopenDay = async (restaurantId, outletId, dayId, reason, user) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const day = await businessDayRepository.findById(restaurantId, dayId);

  if (!day || (day.outlet_id || null) !== (outletId || null)) {
    throw new AppError(404, "Business day not found");
  }

  if (day.day_status !== "closed") {
    throw new AppError(409, "This business day is open already");
  }

  const latest = await businessDayRepository.findLatest(restaurantId, day.outlet_id || null);

  if (!latest || Number(latest.id) !== Number(day.id)) {
    throw new AppError(409, "Only the latest business day can be reopened");
  }

  const window = tradingDay.openableDates(settings);

  if (!window.dates.includes(day.business_date)) {
    throw new AppError(
      409,
      `${tradingDay.sayDate(day.business_date)} is past, so its day stays as it was closed and counted. Open today's day instead.`
    );
  }

  const open = await businessDayRepository.findOpen(restaurantId, day.outlet_id || null);

  if (open) {
    throw new AppError(409, `Business day ${open.business_date} is open. Close it first.`);
  }

  const counted = day.counted_cash !== null ? n(day.counted_cash) : day.closing_cash !== null ? n(day.closing_cash) : null;
  const time = new Date().toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tradingDay.zoneOf(settings),
  });
  const note = `Reopened at ${time} by ${user.name || "a manager"}: it was closed${
    counted !== null ? ` with ${rupees(counted, settings.currency_symbol || "₹")} counted` : ""
  }${day.cash_variance !== null && day.cash_variance !== undefined && n(day.cash_variance) !== 0
    ? ` (${rupees(Math.abs(n(day.cash_variance)), settings.currency_symbol || "₹")} ${n(day.cash_variance) < 0 ? "short" : "over"})`
    : ""}. Reason: ${reason}`;

  try {
    const done = await businessDayRepository.reopen(restaurantId, day.id, note);

    if (!done) {
      throw new AppError(409, "This business day changed a moment ago. Reload and try again.");
    }
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "Another business day was opened a moment ago. Close it first.");
    }

    throw error;
  }

  return { day: toDay(await businessDayRepository.findById(restaurantId, day.id)), was: toDay(day) };
};

// --- Rules ----------------------------------------------------------------------------

const getRules = async (restaurantId) => {
  requireRestaurantId(restaurantId);
  return toRules(await restaurantRepository.findSettings(restaurantId));
};

const updateRules = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = toRules(await restaurantRepository.findSettings(restaurantId));
  await businessDayRepository.updateCashRules(restaurantId, data, userId);
  const after = toRules(await restaurantRepository.findSettings(restaurantId));

  return { before, after };
};

module.exports = {
  toDay,
  toRules,
  seesExpected,
  may,
  getStatus,
  listDays,
  openDay,
  dayFigures,
  cashOfDay,
  checkCount,
  requireReason,
  evaluateClose,
  closePreview,
  checkClose,
  closeDay,
  reopenDay,
  getRules,
  updateRules,
};
