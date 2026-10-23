const pool = require("../../../../config/database");
const queryAll = require("../../../../utils/queryAll");
const cashDrawerRepository = require("../repositories/cashDrawer.repository");
const businessDayRepository = require("../repositories/businessDay.repository");
const expenseRepository = require("../../expenses/repositories/expense.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const businessDayService = require("./businessDay.service");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// A cash drawer per shift: the cashier answerable for the cash, the float
// they started with, what they took and gave back, cash put in or taken out,
// and their count at the end — with the X report a manager prints mid-shift.
//
// Every record belongs to a till: the main counter (no outlet chosen) or an
// outlet with a business day of its own. A record of another till reads as
// not found, the same as one of another restaurant.

const n = (value) => Number(value || 0);

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const MOVEMENT_WORDS = { paid_in: "Cash in (float top-up)", petty_cash: "Petty cash paid out", drop: "Cash drop to the safe" };

const toMovement = (row) => ({
  id: row.id,
  businessDayId: row.business_day_id,
  drawerId: row.drawer_id || null,
  drawerCashierName: row.drawer_cashier_name || null,
  type: row.movement_type,
  typeLabel: MOVEMENT_WORDS[row.movement_type] || row.movement_type,
  amount: n(row.amount),
  reason: row.reason,
  expenseId: row.expense_id || null,
  categoryName: row.category_name || null,
  status: row.movement_status,
  createdAt: row.created_at,
  createdByName: row.created_by_name || null,
  approvedByName: row.approved_by_name || null,
  cancelledAt: row.cancelled_at || null,
  cancelledByName: row.cancelled_by_name || null,
  cancelReason: row.cancel_reason || null,
});

// The open day of the till this request works at, or a refusal that says so.
const tillDay = async (restaurantId, outletId) => {
  const day = await businessDayRepository.findOpen(restaurantId, outletId || null);

  if (!day) {
    throw new AppError(409, "Open the business day first: cash is counted against the day's drawer.", { reason: "no_day" });
  }

  return day;
};

const sameTill = (row, outletId) => (row.outlet_id || null) === (outletId || null);

// Runs work(client, day) in a transaction that holds the business day (see
// cashDrawerRepository.lockDay): cash in or out, a drawer's count and a
// cancelled entry of one day happen one after another, each checked against
// what the ones before it left. Everything inside reads through the client.
const holdingDay = async (restaurantId, dayId, work) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const held = await cashDrawerRepository.lockDay(client, restaurantId, dayId);

    if (!held) {
      throw new AppError(404, "Business day not found");
    }

    const result = await work(client, held);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

// What one drawer took, gave back and had moved in or out, and what it should
// hold. `canSee` false (a blind count) leaves the cash it should hold out.
// db: the pool, or the client of a transaction that holds the day.
const drawerFigures = async (restaurantId, drawer, canSee, db = pool) => {
  const [takings, moves, payouts] = await queryAll(db, [
    () => cashDrawerRepository.drawerTakings(restaurantId, drawer, db),
    () => cashDrawerRepository.movementTotals(restaurantId, drawer.business_day_id, drawer.id, db),
    () => cashDrawerRepository.drawerPayouts(restaurantId, drawer, db),
  ]);
  const amountOf = (rows, method) => n((rows.find((row) => row.method === method) || {}).amount);
  const cashTaken = round2(amountOf(takings.payments, "cash"));
  const cashBack = round2(amountOf(takings.refunds, "cash"));
  const pettyCash = n(moves.petty_cash);
  const dropped = n(moves.dropped);
  const paidIn = n(moves.paid_in);
  const supplierCash = n(payouts.supplier_cash);
  const otherExpenses = n(payouts.expenses);
  // Cash tips stay in the drawer until they are shared out; a rider's cash
  // short never reached it; an owed shortfall handed over did.
  const cashTips = round2(n((takings.payments.find((row) => row.method === "cash") || {}).tips));
  const riderShortfall = round2(n(takings.riders && takings.riders.shortfall));
  const riderRepaid = round2(n(takings.riders && takings.riders.repaid));
  const cashAdvances = round2(n(takings.advances && takings.advances.taken));
  const cashAdvancesReturned = round2(n(takings.advances && takings.advances.returned));
  const expected = round2(
    n(drawer.opening_float) +
      cashTaken +
      cashTips -
      cashBack -
      pettyCash -
      dropped +
      paidIn -
      supplierCash -
      otherExpenses -
      riderShortfall +
      riderRepaid +
      cashAdvances -
      cashAdvancesReturned
  );
  const methods = [...new Set([...takings.payments, ...takings.refunds].map((row) => row.method))].map((method) => ({
    method,
    taken: round2(amountOf(takings.payments, method)),
    payments: (takings.payments.find((row) => row.method === method) || {}).count || 0,
    refunded: round2(amountOf(takings.refunds, method)),
    net: round2(amountOf(takings.payments, method) - amountOf(takings.refunds, method)),
  }));

  return {
    openingFloat: n(drawer.opening_float),
    cashTaken: canSee ? cashTaken : null,
    cashRefunded: cashBack,
    pettyCash,
    dropped,
    paidIn,
    // Paid out of the till by others while this was the only drawer open.
    supplierCash,
    otherExpenses,
    cashTips: canSee ? cashTips : null,
    // Tips by how they were given (cash, card, UPI).
    tips: takings.payments
      .filter((row) => n(row.tips) > 0 && (canSee || row.method !== "cash"))
      .map((row) => ({ method: row.method, amount: round2(n(row.tips)) })),
    riderShortfall,
    riderRepaid,
    cashAdvances,
    cashAdvancesReturned,
    expectedCash: canSee ? expected : null,
    methods: canSee ? methods : methods.filter((row) => row.method !== "cash"),
    bills: {
      count: takings.bills.bill_count,
      sales: canSee ? round2(n(takings.bills.sales)) : null,
      discounts: round2(n(takings.bills.discounts)),
      voids: takings.bills.void_count,
    },
    // Kept for the close, whatever the screen may show.
    _expected: expected,
  };
};

const toDrawer = (row, figures) => {
  // What the screen may show (the expected cash kept for the close is not).
  const shown = figures ? Object.fromEntries(Object.entries(figures).filter(([key]) => key !== "_expected")) : null;
  const closed = row.drawer_status === "closed";

  return {
    id: row.id,
    businessDayId: row.business_day_id,
    businessDate: row.business_date,
    outletId: row.outlet_id || null,
    outletName: row.outlet_name || null,
    cashierId: row.cashier_id,
    cashierName: row.cashier_name,
    label: row.label || null,
    status: row.drawer_status,
    openingFloat: n(row.opening_float),
    openedAt: row.opened_at,
    openedByName: row.opened_by_name || null,
    closedAt: row.closed_at || null,
    closedByName: row.closed_by_name || null,
    countedCash: closed ? n(row.counted_cash) : null,
    countMethod: row.count_method || null,
    denominations: row.count_denominations || null,
    blindCount: Boolean(row.blind_count),
    firstCount: row.first_count === null || row.first_count === undefined ? null : n(row.first_count),
    expectedAtClose: closed && row.expected_cash !== null ? n(row.expected_cash) : null,
    variance: closed && row.cash_variance !== null ? n(row.cash_variance) : null,
    varianceReason: row.variance_reason || null,
    notes: row.notes || null,
    figures: shown,
  };
};

// --- The drawers screen ------------------------------------------------------------

const listDrawers = async (restaurantId, outletId, user) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const day = await businessDayRepository.findOpen(restaurantId, outletId || null);
  const canSee = businessDayService.seesExpected(settings, user);
  const rules = businessDayService.toRules(settings);

  if (!day) {
    return { day: null, rules, blind: !canSee, drawers: [], movements: [], byCashier: [], totals: null, suggestedFloat: null };
  }

  const [rows, movements, byCashier, totals] = await Promise.all([
    cashDrawerRepository.listDrawers(restaurantId, day.id),
    cashDrawerRepository.listMovements(restaurantId, day.id),
    businessDayService.may(user, "sales.view") ? cashDrawerRepository.dayByCashier(restaurantId, day.id) : [],
    cashDrawerRepository.movementTotals(restaurantId, day.id),
  ]);

  const drawers = [];

  for (const row of rows) {
    // A closed drawer's figures are history; an open one's are live, and
    // with blind counting only whoever may close the day sees what an open
    // drawer should hold.
    drawers.push(toDrawer(row, await drawerFigures(restaurantId, row, canSee || row.drawer_status === "closed")));
  }

  // The float a new shift starts with: the day's opening cash for the first,
  // else what the last shift handed over (its count).
  const lastClosed = [...rows].reverse().find((row) => row.drawer_status === "closed");
  const suggestedFloat = rows.length === 0 ? n(day.opening_cash) : lastClosed && !rows.some((row) => row.drawer_status === "open") ? n(lastClosed.counted_cash) : null;

  // Takings by who took them (for a cashier's own X report when no shifts
  // are kept), grouped per person.
  const people = new Map();

  for (const row of byCashier) {
    // A blind counter is not told the cash anyone took: with the float and
    // the cash in and out, that is what the drawer should hold.
    if (!canSee && row.method === "cash") {
      continue;
    }

    const key = String(row.user_id);
    const person = people.get(key) || { userId: row.user_id, name: row.user_name || "Someone removed", total: 0, methods: [] };
    person.methods.push({ method: row.method, amount: round2(n(row.amount)), payments: row.count });
    person.total = round2(person.total + n(row.amount));
    people.set(key, person);
  }

  return {
    day: businessDayService.toDay(day),
    rules,
    blind: !canSee,
    drawers,
    myDrawerId: (rows.find((row) => Number(row.cashier_id) === Number(user.id) && row.drawer_status === "open") || {}).id || null,
    movements: movements.map(toMovement),
    totals: { paidIn: n(totals.paid_in), dropped: n(totals.dropped), pettyCash: n(totals.petty_cash) },
    byCashier: [...people.values()],
    suggestedFloat,
  };
};

// data: { cashierId (default: the person), openingFloat, label, notes }
const startDrawer = async (restaurantId, outletId, data, user) => {
  requireRestaurantId(restaurantId);

  const day = await tillDay(restaurantId, outletId);
  const cashierId = data.cashierId || user.id;

  if (Number(cashierId) !== Number(user.id) && !businessDayService.may(user, "business_day.close")) {
    throw new AppError(403, "Only a manager can open a drawer for someone else. Open your own.");
  }

  const cashier = await cashDrawerRepository.findCashier(restaurantId, cashierId);

  if (!cashier) {
    throw new AppError(404, "That person was not found");
  }

  if (cashier.status !== "active") {
    throw new AppError(400, `${cashier.name}'s login is not active, so they cannot hold a drawer`);
  }

  if (cashier.outlet_id && Number(cashier.outlet_id) !== Number(day.outlet_id || 0)) {
    throw new AppError(400, `${cashier.name} works at another outlet, so cannot hold this till's drawer`);
  }

  const open = await cashDrawerRepository.findOpenDrawerOf(restaurantId, day.id, cashierId);

  if (open) {
    throw new AppError(409, `${cashier.name} already has a drawer open on this day. End that shift (count it) first.`);
  }

  let id;

  try {
    id = await cashDrawerRepository.createDrawer(
      restaurantId,
      {
        businessDayId: day.id,
        outletId: day.outlet_id || null,
        cashierId,
        label: data.label,
        openingFloat: data.openingFloat,
        notes: data.notes,
      },
      user.id
    );
  } catch (error) {
    if (error.code === "23505") {
      throw new AppError(409, `${cashier.name} already has a drawer open on this day`);
    }

    throw error;
  }

  const row = await cashDrawerRepository.findDrawer(restaurantId, id);
  return toDrawer(row, await drawerFigures(restaurantId, row, true));
};

const findDrawerOr404 = async (restaurantId, outletId, id) => {
  const row = await cashDrawerRepository.findDrawer(restaurantId, id);

  if (!row || !sameTill(row, outletId)) {
    throw new AppError(404, "Drawer not found");
  }

  return row;
};

// Ends a shift with its count. Over or short by more than the threshold
// needs a reason, like the day's own close.
//
// data: { closingCash (the count), countMethod, denominations, varianceReason, notes }
const closeDrawer = async (restaurantId, outletId, id, data, user) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const row = await findDrawerOr404(restaurantId, outletId, id);

  if (Number(row.cashier_id) !== Number(user.id) && !businessDayService.may(user, "business_day.close")) {
    throw new AppError(403, `Only ${row.cashier_name} or a manager can end this drawer`);
  }

  if (row.drawer_status !== "open") {
    throw new AppError(409, "This drawer is already closed");
  }

  businessDayService.checkCount({
    counted: data.closingCash,
    countMethod: data.countMethod,
    denominations: data.denominations,
    notes: businessDayService.toRules(settings).denominations,
  });

  const figures = await drawerFigures(restaurantId, row, true);
  const variance = round2(data.closingCash - figures._expected);
  const threshold = n(settings.cash_variance_threshold ?? 100);
  const blind = !businessDayService.seesExpected(settings, user);

  // The first figure counted is kept before any difference is said (always,
  // for a blind counter, who learns the difference from the refusal).
  if (blind || (Math.abs(variance) > threshold + 0.004 && !data.varianceReason)) {
    await cashDrawerRepository.keepDrawerFirstCount(restaurantId, row.id, data.closingCash);
  }

  businessDayService.requireReason(
    variance,
    threshold,
    data.varianceReason,
    settings.currency_symbol || "₹",
    blind ? { counted: data.closingCash } : { expectedCash: figures._expected, counted: data.closingCash }
  );

  // Written with the day held, from figures read again under the hold: cash
  // dropped from this drawer while the count was being typed is in the
  // figure the count is signed against, never left out of it.
  const written = await holdingDay(restaurantId, row.business_day_id, async (client) => {
    const fresh = await cashDrawerRepository.findDrawer(restaurantId, row.id, client);

    if (!fresh || fresh.drawer_status !== "open") {
      throw new AppError(409, "This drawer was closed a moment ago");
    }

    const now = await drawerFigures(restaurantId, fresh, true, client);
    const varianceNow = round2(data.closingCash - now._expected);

    if (Math.abs(varianceNow - variance) > 0.004) {
      businessDayService.requireReason(
        varianceNow,
        threshold,
        data.varianceReason,
        settings.currency_symbol || "₹",
        blind ? { counted: data.closingCash } : { expectedCash: now._expected, counted: data.closingCash }
      );
    }

    const closed = await cashDrawerRepository.closeDrawer(
      restaurantId,
      row.id,
      {
        countedCash: data.closingCash,
        countMethod: data.countMethod,
        denominations: data.countMethod === "notes" ? data.denominations : null,
        blindCount: blind,
        expectedCash: now._expected,
        variance: varianceNow,
        varianceReason: data.varianceReason || null,
        notes: data.notes || null,
      },
      user.id,
      client
    );

    if (!closed) {
      throw new AppError(409, "This drawer was closed a moment ago");
    }

    return varianceNow;
  });

  const after = await cashDrawerRepository.findDrawer(restaurantId, row.id);
  return { drawer: toDrawer(after, await drawerFigures(restaurantId, after, true)), variance: written, threshold };
};

// --- X report ----------------------------------------------------------------------

// A mid-shift reading of one drawer, or of one cashier's whole day when no
// shifts are kept. It changes nothing.
const xReport = async (restaurantId, outletId, { drawerId = null, cashierId = null }, user) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const canSee = businessDayService.seesExpected(settings, user);

  if (drawerId) {
    const row = await findDrawerOr404(restaurantId, outletId, drawerId);
    const visible = canSee || row.drawer_status === "closed";
    const movements = (await cashDrawerRepository.listMovements(restaurantId, row.business_day_id)).filter(
      (move) => Number(move.drawer_id) === Number(row.id)
    );

    return {
      kind: "drawer",
      printedAt: new Date().toISOString(),
      timezone: settings.timezone || "Asia/Kolkata",
      currency: settings.currency_symbol || "₹",
      blind: !visible,
      drawer: toDrawer(row, await drawerFigures(restaurantId, row, visible)),
      movements: movements.map(toMovement),
    };
  }

  const day = await tillDay(restaurantId, outletId);
  const who = cashierId || user.id;
  const person = await cashDrawerRepository.findCashier(restaurantId, who);

  if (!person) {
    throw new AppError(404, "That person was not found");
  }

  const takings = await cashDrawerRepository.cashierDay(restaurantId, day.id, who);
  const amountOf = (rows, method) => n((rows.find((row) => row.method === method) || {}).amount);
  // With blind counting the cash taken is left out, as on the drawers screen.
  const methods = [...new Set([...takings.payments, ...takings.refunds].map((row) => row.method))]
    .filter((method) => canSee || method !== "cash")
    .map((method) => ({
      method,
      taken: round2(amountOf(takings.payments, method)),
      payments: (takings.payments.find((row) => row.method === method) || {}).count || 0,
      refunded: round2(amountOf(takings.refunds, method)),
      net: round2(amountOf(takings.payments, method) - amountOf(takings.refunds, method)),
    }));
  // Tips this cashier took, by method (on top of the payments).
  const tips = takings.payments
    .filter((row) => n(row.tips) > 0 && (canSee || row.method !== "cash"))
    .map((row) => ({ method: row.method, amount: round2(n(row.tips)) }));

  return {
    kind: "cashier",
    tips,
    printedAt: new Date().toISOString(),
    timezone: settings.timezone || "Asia/Kolkata",
    currency: settings.currency_symbol || "₹",
    blind: !canSee,
    day: businessDayService.toDay(day),
    cashier: { id: person.id, name: person.name },
    methods,
    bills: {
      count: takings.bills.bill_count,
      sales: canSee ? round2(n(takings.bills.sales)) : null,
      discounts: round2(n(takings.bills.discounts)),
      voids: takings.bills.void_count,
    },
  };
};

// --- Cash in and out -----------------------------------------------------------------

// What the cash being taken out may be at most: what the drawer it comes out
// of should hold. Typing ₹10,000 for a ₹1,000 drop is refused in words.
const cashAvailable = async (restaurantId, day, drawer, db = pool) => {
  if (drawer) {
    return (await drawerFigures(restaurantId, drawer, true, db))._expected;
  }

  return businessDayService.cashOfDay(await cashDrawerRepository.dayCash(restaurantId, day.id, db)).inDrawer;
};

// "More than the drawer holds", in words. A blind counter is not told what
// the drawer should hold. doing: what was refused, when it is not cash
// coming out (taking back a cash-in).
const moreThanDrawer = (settings, user, drawer, amount, available, doing = null) => {
  const currency = settings.currency_symbol || "₹";
  const whose = drawer ? `${drawer.cashier_name}'s drawer` : "drawer";

  if (!businessDayService.seesExpected(settings, user)) {
    return new AppError(
      400,
      doing
        ? `The ${whose} does not hold enough for that: ${doing}. Check the entries made after it first.`
        : `${currency}${amount.toLocaleString("en-IN")} is more than the ${whose} should hold. Check the amount.`,
      { reason: "more_than_drawer" }
    );
  }

  const holds = `The ${whose} should hold only ${currency}${round2(Math.max(0, available)).toLocaleString("en-IN")}`;

  return new AppError(
    400,
    doing
      ? `${holds}, so ${doing}. Check the entries made after it first.`
      : `${holds}, so ${currency}${amount.toLocaleString("en-IN")} cannot come out of it. Check the amount.`,
    { reason: "more_than_drawer", available: round2(available) }
  );
};

// Checks a movement against the day and its drawer — before any manager is
// asked for a PIN (the route runs this first), and again when it is written.
//
// data: { type, amount, reason, drawerId, expenseCategoryId }
const planMovement = async (restaurantId, outletId, data, user) => {
  const day = await tillDay(restaurantId, outletId);
  let drawer = null;

  if (data.drawerId) {
    drawer = await findDrawerOr404(restaurantId, outletId, data.drawerId);

    if (Number(drawer.business_day_id) !== Number(day.id) || drawer.drawer_status !== "open") {
      throw new AppError(409, "That drawer is closed. Cash goes in or out of an open drawer.");
    }
  } else {
    // Into the person's own open drawer when they have one; else, when one
    // cashier is on the till, theirs (the manager taking a drop from it);
    // else the day's drawer as a whole.
    drawer = await cashDrawerRepository.findOpenDrawerOf(restaurantId, day.id, user.id);

    if (!drawer) {
      const open = (await cashDrawerRepository.listDrawers(restaurantId, day.id)).filter((row) => row.drawer_status === "open");
      drawer = open.length === 1 ? open[0] : null;
    }
  }

  if (data.type !== "paid_in") {
    const available = await cashAvailable(restaurantId, day, drawer);

    if (data.amount > available + 0.004) {
      throw moreThanDrawer(await restaurantRepository.findSettings(restaurantId), user, drawer, data.amount, available);
    }
  }

  if (data.type === "petty_cash" && data.expenseCategoryId) {
    const category = await expenseRepository.findCategoryById(restaurantId, data.expenseCategoryId);

    if (!category) {
      throw new AppError(400, "Selected expense category does not exist");
    }
  }

  return { day, drawer };
};

const recordMovement = async (restaurantId, outletId, data, user, approval = null) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const { day, drawer } = await planMovement(restaurantId, outletId, data, user);

  // Checked again with the day held: five drops sent at the same moment each
  // see the ones before them, so together they can never take out more than
  // the drawer holds.
  const id = await holdingDay(restaurantId, day.id, async (client, held) => {
    if (held.day_status !== "open") {
      throw new AppError(409, "The day was closed a moment ago, so no more cash can go in or out of its drawer.");
    }

    let current = null;

    if (drawer) {
      current = await cashDrawerRepository.findDrawer(restaurantId, drawer.id, client);

      if (!current || current.drawer_status !== "open") {
        throw new AppError(409, `${drawer.cashier_name}'s drawer was counted a moment ago. Cash goes in or out of an open drawer.`);
      }
    }

    if (data.type !== "paid_in") {
      const available = await cashAvailable(restaurantId, day, current, client);

      if (data.amount > available + 0.004) {
        throw moreThanDrawer(settings, user, current, data.amount, available);
      }
    }

    let expenseId = null;

    // Petty cash is an expense of the day as well, approved at once: the
    // cash is gone, and moving cash needed the permission or a manager's PIN.
    if (data.type === "petty_cash") {
      const categoryId = data.expenseCategoryId || (await expenseRepository.findOrCreatePettyCategory(client, restaurantId, user.id));

      expenseId = await expenseRepository.createApproved(
        client,
        restaurantId,
        {
          expenseCategoryId: categoryId,
          expenseDate: day.business_date,
          amount: data.amount,
          notes: `Petty cash from the drawer: ${data.reason}`,
          outletId: day.outlet_id || null,
        },
        user.id,
        approval ? approval.approverId : null
      );
    }

    return cashDrawerRepository.createMovement(
      client,
      restaurantId,
      {
        businessDayId: day.id,
        outletId: day.outlet_id || null,
        drawerId: drawer ? drawer.id : null,
        type: data.type,
        amount: data.amount,
        reason: data.reason,
        expenseId,
        approvedBy: approval ? approval.approverId : null,
      },
      user.id
    );
  });

  return toMovement(await cashDrawerRepository.findMovement(restaurantId, id));
};

// A movement typed wrong is cancelled, never deleted: the drawer stops
// counting it and (petty cash) its expense is rejected.
const findMovementOr404 = async (restaurantId, outletId, id) => {
  const row = await cashDrawerRepository.findMovement(restaurantId, id);

  if (!row || !sameTill(row, outletId)) {
    throw new AppError(404, "That cash entry was not found");
  }

  return row;
};

// Why this entry can no longer be cancelled, or null. A drawer counted at the
// end of a shift was signed against its entries: cancelling one afterwards
// would change what it should have held under a count already made (the
// drawer card would then say "should hold ₹1,489, counted ₹1,289, short
// ₹150"). A correction goes on an open drawer instead, as with expenses.
const cancelRefusal = (row) => {
  if (row.movement_status !== "recorded") {
    return new AppError(409, "This cash entry is already cancelled");
  }

  if (row.day_status !== "open") {
    return new AppError(409, "That day is closed and its cash counted, so its entries can no longer change");
  }

  if (row.drawer_id && row.drawer_status !== "open") {
    return new AppError(
      409,
      `${row.drawer_cashier_name ? `${row.drawer_cashier_name}'s` : "That"} drawer was counted at the end of the shift, so its cash entries can no longer change. Record the correction on an open drawer instead.`,
      { reason: "drawer_counted" }
    );
  }

  return null;
};

// Taking back cash put in takes it out of the drawer again: not when the
// drawer no longer holds it (it was dropped to the safe or paid out since).
const checkTakeBack = async (restaurantId, row, user, db = pool, settings = null) => {
  if (row.movement_type !== "paid_in") {
    return;
  }

  const drawer = row.drawer_id ? await cashDrawerRepository.findDrawer(restaurantId, row.drawer_id, db) : null;
  const available = await cashAvailable(restaurantId, { id: row.business_day_id }, drawer, db);
  const amount = Number(row.amount);

  if (amount > available + 0.004) {
    const rules = settings || (await restaurantRepository.findSettings(restaurantId));
    const currency = rules.currency_symbol || "₹";

    throw moreThanDrawer(
      rules,
      user,
      drawer,
      amount,
      available,
      `taking back this ${currency}${amount.toLocaleString("en-IN")} cash-in would leave it below nothing`
    );
  }
};

const checkCancel = async (restaurantId, outletId, id, user = null) => {
  const row = await findMovementOr404(restaurantId, outletId, id);
  const refusal = cancelRefusal(row);

  if (refusal) {
    throw refusal;
  }

  await checkTakeBack(restaurantId, row, user);

  return row;
};

const cancelMovement = async (restaurantId, outletId, id, reason, user) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const row = await checkCancel(restaurantId, outletId, id, user);

  // Checked again with the day held: the drawer may have been counted, or
  // the cash dropped, since the check above.
  await holdingDay(restaurantId, row.business_day_id, async (client) => {
    const fresh = await cashDrawerRepository.findMovement(restaurantId, row.id, client);
    const refusal = cancelRefusal(fresh);

    if (refusal) {
      throw fresh.movement_status !== "recorded" ? new AppError(409, "This cash entry was cancelled a moment ago") : refusal;
    }

    await checkTakeBack(restaurantId, fresh, user, client, settings);

    const done = await cashDrawerRepository.cancelMovement(client, restaurantId, row.id, reason, user.id);

    if (!done) {
      throw new AppError(409, "This cash entry was cancelled a moment ago");
    }

    if (done.expense_id) {
      await expenseRepository.rejectInTransaction(client, restaurantId, done.expense_id, user.id);
    }
  });

  return toMovement(await cashDrawerRepository.findMovement(restaurantId, row.id));
};

module.exports = {
  listDrawers,
  startDrawer,
  closeDrawer,
  xReport,
  planMovement,
  recordMovement,
  checkCancel,
  cancelMovement,
};
