const customerAccountRepository = require("../repositories/customerAccount.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const billRepository = require("../repositories/bill.repository");
const outletRepository = require("../../setup/repositories/outlet.repository");
const customerAdvanceRepository = require("../repositories/customerAdvance.repository");
const AppError = require("../../../../utils/AppError");
const { round2, toPaise, fromPaise } = require("../../../../utils/money");
const { formatMobile, maskMobile } = require("../../../../utils/phone");

// Guest and company accounts (dues). See customerAccount.repository for how
// the money is kept: what an account owes is what is still due on the bills
// put on it.

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const n = (value) => (value === null || value === undefined ? 0 : Number(value));

// Staff pinned to an outlet see and collect that outlet's bills only.
const outletOf = (ctx) => (ctx && ctx.outletPinned ? ctx.outletId : null);

const zoneOf = (settings) => {
  try {
    const zone = (settings && settings.timezone) || "Asia/Kolkata";
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return "Asia/Kolkata";
  }
};

const todayIn = (timezone) => new Date().toLocaleDateString("en-CA", { timeZone: timezone });

const displayName = (row) => (row.company_name && String(row.company_name).trim()) || row.name;

const toAccount = (row, ctx = {}) => {
  const limit = row.credit_limit === null || row.credit_limit === undefined ? null : n(row.credit_limit);
  const outstanding = round2(n(row.outstanding));

  return {
    customerId: row.customer_id,
    name: displayName(row),
    guestName: row.name,
    companyName: row.company_name || null,
    gstin: row.gstin || null,
    mobile: row.mobile ? (ctx.reveal ? formatMobile(row.mobile) : maskMobile(row.mobile)) : null,
    hasAccount: Boolean(row.account_id),
    status: row.account_status || null,
    creditLimit: limit,
    creditDays: row.credit_days === null || row.credit_days === undefined ? null : n(row.credit_days),
    notes: row.notes || null,
    outstanding,
    // What can still go on the account before the limit stops it.
    available: limit === null ? 0 : round2(Math.max(0, limit - outstanding)),
    openBills: n(row.open_bills),
    ageing: {
      current: round2(n(row.age_current)),
      days31to60: round2(n(row.age_31_60)),
      days61to90: round2(n(row.age_61_90)),
      over90: round2(n(row.age_over_90)),
    },
    oldestDue: row.oldest_due || null,
    lastBillAt: row.last_bill_at || null,
    lastPaidAt: row.last_paid_at || null,
  };
};

const findCustomerOr404 = async (restaurantId, customerId) => {
  const row = await customerAccountRepository.findCustomer(restaurantId, customerId);

  if (!row) {
    throw new AppError(404, "Guest not found");
  }

  return row;
};

// Opens a guest's or company's account, or changes its limit and terms.
const saveAccount = async (restaurantId, customerId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await findCustomerOr404(restaurantId, customerId);

  if (before.customer_status && before.customer_status !== "active") {
    throw new AppError(400, `${displayName(before)} is not an active guest`);
  }

  await customerAccountRepository.saveAccount(
    restaurantId,
    customerId,
    {
      creditLimit: data.creditLimit,
      creditDays: data.creditDays ?? (before.credit_days === null || before.credit_days === undefined ? 30 : n(before.credit_days)),
      status: data.status || before.account_status || "active",
      notes: data.notes === undefined ? before.notes || null : data.notes,
    },
    userId
  );

  const after = await findCustomerOr404(restaurantId, customerId);

  return { before: before.account_id ? toAccount(before) : null, account: toAccount(after) };
};

// Every account and what it owes, aged, plus the unpaid bills that are on
// nobody's account — everything owed to the restaurant on one screen.
const dues = async (restaurantId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const timezone = zoneOf(settings);
  const asOf = todayIn(timezone);
  const outletId = outletOf(ctx);
  const [accounts, loose, held] = await Promise.all([
    customerAccountRepository.findAccounts(restaurantId, { outletId, timezone, asOf }),
    customerAccountRepository.findLooseDues(restaurantId, { outletId, timezone, asOf }),
    customerAdvanceRepository.findHeldByCustomer(restaurantId),
  ]);
  // Advances the guest has paid ahead and not used yet: money held for
  // them, shown beside what they owe.
  const heldOf = new Map(held.map((row) => [Number(row.customer_id), round2(n(row.held))]));
  const rows = accounts.map((row) => ({ ...toAccount(row, ctx), advanceHeld: heldOf.get(Number(row.customer_id)) || 0 }));
  const sum = (list, pick) => fromPaise(list.reduce((total, row) => total + toPaise(pick(row)), 0));
  const overdue = rows.filter((row) => row.outstanding > 0 && row.creditDays !== null && row.oldestDue
    && (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${row.oldestDue}T00:00:00Z`)) / 86400000 > row.creditDays);

  return {
    asOf,
    accounts: rows,
    totals: {
      accounts: rows.filter((row) => row.hasAccount).length,
      owing: rows.filter((row) => row.outstanding > 0).length,
      outstanding: sum(rows, (row) => row.outstanding),
      current: sum(rows, (row) => row.ageing.current),
      days31to60: sum(rows, (row) => row.ageing.days31to60),
      days61to90: sum(rows, (row) => row.ageing.days61to90),
      over90: sum(rows, (row) => row.ageing.over90),
      overdueAccounts: overdue.length,
      advanceHeld: sum(held, (row) => row.held),
    },
    // Bills left unpaid that are on nobody's account.
    loose: {
      count: loose.length ? n(loose[0].total_count) : 0,
      due: loose.length ? round2(n(loose[0].total_due)) : 0,
      bills: loose.map((row) => ({
        billId: row.id,
        billNumber: row.bill_number,
        orderNumber: row.order_number,
        orderType: row.order_type,
        guestName: row.guest_name || null,
        tableNo: row.table_no || null,
        outletName: row.outlet_name || null,
        businessDate: row.business_date,
        ageDays: n(row.age_days),
        totalAmount: n(row.total_amount),
        due: round2(n(row.due)),
        billStatus: row.bill_status,
      })),
    },
  };
};

// Checks a bill can go on an account before anyone is asked for a PIN: the
// guest has an account, it is not on hold, and the bill fits in what is left
// of the limit. Returns what the approval is tied to.
const checkPutOnAccount = async (restaurantId, bill, customerId) => {
  requireRestaurantId(restaurantId);

  if (bill.bill_status === "void") {
    throw new AppError(409, "This bill has been voided");
  }

  const due = round2(billRepository.dueOf(bill));

  if (!customerId) {
    if (!bill.account_customer_id) {
      throw new AppError(400, "This bill is not on anyone's account");
    }

    if (bill.bill_status === "paid") {
      throw new AppError(409, "This bill is settled; there is nothing on the account to take off");
    }

    return { due };
  }

  if (bill.bill_status === "paid" || due <= 0.009) {
    throw new AppError(409, "This bill is settled; there is nothing left to put on an account");
  }

  const guest = await findCustomerOr404(restaurantId, customerId);
  const name = displayName(guest);

  if (!guest.account_id) {
    throw new AppError(
      400,
      `${name} has no account. Open one under Dues & accounts (with a credit limit) before putting bills on it.`
    );
  }

  if (guest.account_status !== "active") {
    throw new AppError(400, `${name}'s account is on hold. Collect what is owed, or take the hold off under Dues & accounts.`);
  }

  if (Number(bill.account_customer_id) === Number(customerId)) {
    throw new AppError(409, `This bill is already on ${name}'s account`);
  }

  const owed = round2(await customerAccountRepository.findOutstanding(restaurantId, customerId));
  const limit = n(guest.credit_limit);

  if (owed + due > limit + 0.009) {
    throw new AppError(
      400,
      `${name} already owes ₹${owed.toLocaleString("en-IN")} of a ₹${limit.toLocaleString("en-IN")} limit; this bill (₹${due.toLocaleString(
        "en-IN"
      )}) would take it over. Collect some of it, or raise the limit under Dues & accounts.`,
      { reason: "credit_limit", outstanding: owed, limit, due }
    );
  }

  return { due, name };
};

const ACCOUNT_ERRORS = {
  NOT_FOUND: [404, "Bill not found"],
  VOID: [409, "This bill has been voided"],
  SETTLED: [409, "This bill is settled; there is nothing left to put on an account"],
  NOT_ON_ACCOUNT: [400, "This bill is not on anyone's account"],
  NO_ACCOUNT: [400, "That guest has no account. Open one under Dues & accounts first."],
  ON_HOLD: [400, "That account is on hold"],
};

// Puts the bill on the account (or takes it off, customerId null), with the
// bill and the account locked.
const putOnAccount = async (restaurantId, billId, { customerId, note }, who, ctx = {}) => {
  const result = await customerAccountRepository.setBillAccount(
    restaurantId,
    billId,
    outletOf(ctx),
    { customerId, note },
    who
  );

  if (result.error === "OVER_LIMIT") {
    throw new AppError(
      400,
      `That would take the account to ₹${round2(result.outstanding + result.due).toLocaleString("en-IN")}, over its ₹${result.limit.toLocaleString(
        "en-IN"
      )} limit. Another bill went on it a moment ago.`,
      { reason: "credit_limit" }
    );
  }

  if (result.error) {
    const [status, message] = ACCOUNT_ERRORS[result.error] || [400, "The bill could not be put on the account"];
    throw new AppError(status, message);
  }

  return result;
};

const PAYMENT_WORDS = { cash: "cash", card: "card", upi: "UPI", online: "online", wallet: "wallet", other: "other" };

// The till a request is taking money at: the outlet the person works at or
// has chosen in the top bar, or the main counter (null).
const tillOf = (ctx) => (ctx && ctx.outletId ? ctx.outletId : null);

const tillName = async (restaurantId, outletId) => {
  if (!outletId) {
    return "the main counter";
  }

  const outlet = await outletRepository.findById(restaurantId, outletId);
  return outlet ? outlet.name : "that outlet";
};

// Money received against an account: paid onto its bills oldest first, all
// of it into today's business day of the till taking it.
const collect = async (restaurantId, customerId, data, userId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const guest = await findCustomerOr404(restaurantId, customerId);
  const settings = await restaurantRepository.findSettings(restaurantId);
  const earnAmount = n(settings.loyalty_earn_amount);
  const result = await customerAccountRepository.collect(
    restaurantId,
    customerId,
    outletOf(ctx),
    {
      amount: data.amount,
      paymentMethod: data.paymentMethod,
      transactionRef: data.transactionRef || null,
      billIds: data.billIds || null,
      tillOutletId: tillOf(ctx),
      // Points are earned on a bill once it is paid in full, as at the till.
      earnFor: (bill) =>
        settings.loyalty_enabled && bill.customer_id && earnAmount > 0 ? Math.floor(n(bill.total_amount) / earnAmount) : 0,
    },
    userId
  );

  if (result.error === "NOTHING_DUE") {
    throw new AppError(400, `${displayName(guest)} owes nothing on account${data.billIds ? " on those bills" : ""}`);
  }

  if (result.error === "TOO_MUCH") {
    throw new AppError(400, `${displayName(guest)} owes ₹${result.owed.toLocaleString("en-IN")}. Collect that much at most.`);
  }

  if (result.error === "NO_DAY") {
    const where = await tillName(restaurantId, result.tillOutletId);

    throw new AppError(
      409,
      result.tillOutletId
        ? `No business day is open at ${where}. The money goes into the drawer of the till taking it: open ${where}'s day first, or pick the outlet you are at in the top bar.`
        : "The main counter's business day is not open. The money goes into the drawer of the till taking it: open the main counter's day, or pick the outlet you are at in the top bar.",
      { reason: "no_day", outletId: result.tillOutletId || null }
    );
  }

  if (result.error) {
    throw new AppError(400, "That payment could not be recorded");
  }

  return {
    customerName: displayName(guest),
    method: PAYMENT_WORDS[data.paymentMethod] || data.paymentMethod,
    businessDayId: result.dayId,
    till: await tillName(restaurantId, tillOf(ctx)),
    allocations: result.allocations,
  };
};

// An account's statement for a period: what it owed when the period began,
// every bill, payment, refund and credit note in it, and what it owes at the
// end — each line with the running balance.
const statement = async (restaurantId, customerId, { from = null, to = null } = {}, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const guest = await findCustomerOr404(restaurantId, customerId);
  const settings = await restaurantRepository.findSettings(restaurantId);
  const timezone = zoneOf(settings);
  const raw = await customerAccountRepository.findStatementEntries(restaurantId, customerId, {
    outletId: outletOf(ctx),
    timezone,
  });

  const entries = [
    ...raw.bills.map((row) => ({
      date: row.entry_date,
      at: row.billed_at,
      kind: "bill",
      reference: row.bill_number,
      description: [
        `Bill ${row.bill_number}`,
        row.table_no ? `table ${row.table_no}` : null,
        row.outlet_name,
        row.account_note,
      ]
        .filter(Boolean)
        .join(" · "),
      debit: n(row.total_amount),
      credit: 0,
    })),
    ...raw.payments.map((row) => ({
      date: row.entry_date,
      at: row.paid_at,
      kind: "payment",
      reference: row.bill_number,
      description: `Paid by ${PAYMENT_WORDS[row.payment_method] || row.payment_method}${row.transaction_ref ? ` · ${row.transaction_ref}` : ""} on ${row.bill_number}`,
      debit: 0,
      credit: n(row.amount),
    })),
    ...raw.refunds.map((row) => ({
      date: row.entry_date,
      at: row.refunded_at,
      kind: "refund",
      reference: row.bill_number,
      description: `Money given back by ${PAYMENT_WORDS[row.refund_method] || row.refund_method} on ${row.bill_number}${row.reason ? ` · ${row.reason}` : ""}`,
      debit: n(row.amount),
      credit: 0,
    })),
    ...raw.notes.map((row) => ({
      date: row.entry_date,
      at: row.issued_at,
      kind: "credit_note",
      reference: row.credit_note_number,
      description: `Credit note ${row.credit_note_number} on ${row.bill_number}${row.reason ? ` · ${row.reason}` : ""}`,
      debit: 0,
      credit: n(row.total_amount),
    })),
  ].sort(
    (a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      new Date(a.at) - new Date(b.at) ||
      (a.kind === "bill" ? -1 : b.kind === "bill" ? 1 : 0)
  );

  let opening = 0;
  let balance = 0;
  const inPeriod = [];

  for (const entry of entries) {
    const move = toPaise(entry.debit) - toPaise(entry.credit);

    if (from && entry.date < from) {
      opening += move;
      balance += move;
      continue;
    }

    if (to && entry.date > to) {
      continue;
    }

    balance += move;
    inPeriod.push({ ...entry, balance: fromPaise(balance) });
  }

  const totals = inPeriod.reduce(
    (sum, entry) => ({ debit: sum.debit + toPaise(entry.debit), credit: sum.credit + toPaise(entry.credit) }),
    { debit: 0, credit: 0 }
  );

  // Money the guest paid ahead (advances and deposits), held for them apart
  // from what they owe: it is used on a bill, or handed back.
  const advances = await customerAdvanceRepository.findAll(restaurantId, {
    customerId,
    status: "all",
    outletId: outletOf(ctx),
    timezone,
    limit: 100,
  });

  return {
    customerId: guest.customer_id,
    name: displayName(guest),
    guestName: guest.name,
    gstin: guest.gstin || null,
    hasAccount: Boolean(guest.account_id),
    creditLimit: guest.credit_limit === null ? null : n(guest.credit_limit),
    creditDays: guest.credit_days === null ? null : n(guest.credit_days),
    status: guest.account_status || null,
    from,
    to,
    openingBalance: fromPaise(opening),
    entries: inPeriod,
    totals: { debit: fromPaise(totals.debit), credit: fromPaise(totals.credit) },
    closingBalance: fromPaise(balance),
    advances: {
      held: n(advances.totals.held),
      items: advances.rows.map((row) => ({
        id: row.id,
        receiptNumber: row.receipt_number,
        businessDate: row.business_date,
        amount: n(row.amount),
        used: n(row.used_amount),
        refunded: n(row.refunded_amount),
        held: n(row.held),
        purpose: row.purpose || null,
        paymentMethod: row.payment_method,
      })),
    },
  };
};

// The bills an account still owes on, for choosing what a payment settles.
const openBills = async (restaurantId, customerId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  await findCustomerOr404(restaurantId, customerId);
  const settings = await restaurantRepository.findSettings(restaurantId);
  const rows = await customerAccountRepository.findOpenBills(restaurantId, customerId, {
    outletId: outletOf(ctx),
    timezone: zoneOf(settings),
  });

  return rows.map((row) => ({
    billId: row.id,
    billNumber: row.bill_number,
    totalAmount: n(row.total_amount),
    due: round2(n(row.due)),
    businessDate: row.business_date,
    outletName: row.outlet_name || null,
  }));
};

module.exports = {
  saveAccount,
  dues,
  checkPutOnAccount,
  putOnAccount,
  collect,
  statement,
  openBills,
};
