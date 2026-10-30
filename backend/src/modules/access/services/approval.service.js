const crypto = require("crypto");
const bcrypt = require("bcrypt");

const config = require("../../../config/env");
const approvalRepository = require("../repositories/approval.repository");
const userRepository = require("../repositories/user.repository");
const restaurantRepository = require("../../restaurant/setup/repositories/restaurant.repository");
const roleRepository = require("../repositories/role.repository");
const auditRepository = require("../repositories/audit.repository");
const timeclockRepository = require("../../restaurant/staff/repositories/timeclock.repository");
const { safeZone } = require("../../restaurant/staff/services/timeclock.service");
const AppError = require("../../../utils/AppError");
const { round2 } = require("../../../utils/money");

// The PIN rules (auth.service), on first use.
const authService = () => require("./auth.service");

// What each permission lets someone do, as the approval prompt says it:
// "A manager's approval is needed to void a bill".
const ACTION_LABELS = {
  "orders.cancel_after_kot": "take off a dish the kitchen already has",
  "bills.void": "void a bill",
  "bills.refund": "give a refund",
  "bills.reprint": "reprint a bill",
  "bills.discount": "give a discount",
  "bills.complimentary": "make a bill complimentary",
  "business_day.close": "close the business day",
  "sales.view": "see the day's sales",
  "staff.salaries": "see salaries",
  "menu.availability": "mark a dish sold out",
  "loyalty.adjust": "add or remove points by hand",
  "audit.view": "read the activity log",
  "customers.credit": "put a bill on a guest's account",
  "bills.payment_correct": "correct how a payment was taken",
  "advances.refund": "hand back an advance",
  "orders.waive_delivery_charge": "take off the delivery charge",
  // Cash put into or taken out of a drawer (a float top-up, petty cash, a
  // drop to the safe), or such an entry cancelled. The prompt's summary says
  // which way and how much (describeScope).
  "cash.movements": "put cash into or take cash out of the drawer",
};

// Which way a cash entry moves money, for the PIN prompt: the scope's
// cashMove is the entry's type, or "cancel_" and the type for cancelling one.
const CASH_MOVES = {
  paid_in: (amount) => `Put ${amount} into the drawer (cash in, a float top-up)`,
  petty_cash: (amount) => `Take ${amount} out of the drawer for petty cash`,
  drop: (amount) => `Take ${amount} out of the drawer to the safe (cash drop)`,
  cancel_paid_in: (amount) => `Cancel a cash in of ${amount}: it comes back out of the drawer`,
  cancel_petty_cash: (amount) => `Cancel petty cash of ${amount}: it goes back into the drawer`,
  cancel_drop: (amount) => `Cancel a cash drop of ${amount}: it goes back into the drawer`,
};

const CASH_MOVE_WORDS = {
  paid_in: "Cash in",
  petty_cash: "Cash out (petty cash)",
  drop: "Cash out (drop to the safe)",
  cancel_paid_in: "Cancel a cash in",
  cancel_petty_cash: "Cancel petty cash",
  cancel_drop: "Cancel a cash drop",
};

// Approving someone into running the restaurant's access, or the platform, is
// never a till-side decision.
const NEVER_APPROVABLE = new Set(["platform.restaurants.manage", "users.manage", "roles.manage"]);

const actionLabel = (permission) => ACTION_LABELS[permission] || "do this";

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

// "PATCH /api/bills/42/void?x=1" and "PATCH /bills/42/void" are the same
// request: the API prefix, any query string and a trailing slash are dropped.
const normaliseTarget = (method, url) => {
  if (!method || !url) {
    return null;
  }

  const path = String(url)
    .split("?")[0]
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/api(?=\/)/, "")
    .replace(/\/+$/, "");

  return `${String(method).toUpperCase()} ${path || "/"}`.slice(0, 200);
};

// --- What an approval is for ---------------------------------------------------
//
// An approval is tied to what the manager was shown: this bill, this much,
// this dish. The route says how to read those facts off the request
// (authorizeOrApprove's `scope` option), the screen sends the same facts when
// it asks for the approval, the token keeps them, and a request whose facts
// differ is refused. Money and quantities may come in lower than approved,
// never higher: a manager who OKs a ₹500 refund has not objected to ₹450.
//
//   id     a record in this restaurant; must be the same one
//   upTo   an amount or count; the request may be this much or less
//   money  a figure the manager vouches for (cash counted); must be the same
//   flag   a yes/no choice (carry unpaid bills as dues); must be the same
const SCOPE_FIELDS = {
  billId: { kind: "id", word: "bill" },
  orderId: { kind: "id", word: "order" },
  orderItemId: { kind: "id", word: "dish" },
  businessDayId: { kind: "id", word: "business day" },
  customerId: { kind: "id", word: "guest" },
  productId: { kind: "id", word: "dish" },
  // Back office: a write-off is tied to the stock item it takes
  // out, a purchase-order approval to that order, a count's write-off to
  // that count sheet. Without them a PIN given for 2 kg paneer wrote off
  // ghee, and one given for one order approved another of the same size.
  inventoryItemId: { kind: "id", word: "stock item" },
  purchaseOrderId: { kind: "id", word: "purchase order" },
  stockCountId: { kind: "id", word: "stock count" },
  amount: { kind: "upTo", word: "amount", money: true },
  quantity: { kind: "upTo", word: "quantity" },
  // Points by hand: adding and taking away are approved apart, so a PIN
  // given for "add 20 points" can never take 20 away (or the other way).
  points: { kind: "upTo", word: "points to add" },
  pointsOff: { kind: "upTo", word: "points to take away" },
  percent: { kind: "upTo", word: "percentage" },
  closingCash: { kind: "money", word: "cash counted" },
  carryUnpaid: { kind: "flag", word: "choice to carry unpaid bills" },
  // Correcting how a payment was taken: this payment, from this
  // method to that one — a PIN given for "cash to UPI" cannot turn a card
  // payment into cash.
  paymentId: { kind: "id", word: "payment" },
  fromMethod: { kind: "text", word: "method it was taken by" },
  toMethod: { kind: "text", word: "method it is changed to" },
  // A cash entry's direction (paid_in, petty_cash, drop, or cancel_ and one
  // of them): a PIN given for ₹1,000 in cannot take ₹1,000 out.
  cashMove: { kind: "text", word: "cash in or out" },
  // An advance handed back.
  advanceId: { kind: "id", word: "advance" },
};

const capital = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");

// Checks and tidies a scope, whether a screen sent it or a route read it off
// its request: ids as numbers, money to the paisa, keys in one order. Empty
// values are left out; null when nothing is left.
const normaliseScope = (raw) => {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "What is being approved could not be read. Close the prompt and try again.");
  }

  const scope = {};

  for (const key of Object.keys(raw).sort()) {
    const field = SCOPE_FIELDS[key];
    const value = raw[key];

    if (!field) {
      throw new AppError(400, `"${key}" cannot be part of a manager's approval`);
    }

    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (field.kind === "id") {
      const id = Number(value);

      if (!Number.isInteger(id) || id < 1) {
        throw new AppError(400, `The ${field.word} to approve is not valid`);
      }

      scope[key] = id;
    } else if (field.kind === "flag") {
      if (typeof value !== "boolean") {
        throw new AppError(400, `${capital(field.word)} must be true or false`);
      }

      scope[key] = value;
    } else if (field.kind === "text") {
      // A word from a short fixed list (a payment method): must be the same.
      const text = String(value).trim().toLowerCase();

      if (!/^[a-z_]{1,20}$/.test(text)) {
        throw new AppError(400, `The ${field.word} to approve is not valid`);
      }

      scope[key] = text;
    } else {
      const number = Number(value);

      if (typeof value === "boolean" || !Number.isFinite(number) || number < 0) {
        throw new AppError(400, `${capital(field.word)} must be a number`);
      }

      scope[key] = round2(number);
    }
  }

  return Object.keys(scope).length > 0 ? scope : null;
};

const moneyText = (value, currency = "₹") =>
  `${currency}${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const figureText = (key, value, currency) => {
  if (key === "amount" || key === "closingCash") {
    return moneyText(value, currency);
  }

  if (key === "points" || key === "pointsOff") {
    return `${value} points`;
  }

  if (key === "percent") {
    return `${value}%`;
  }

  return String(value);
};

// Why a request is not what the manager approved, or null when it is.
// Every fact the route reads off the request must be in the approval;
// extra facts in the approval (shown for context) are not checked.
const scopeMismatch = (approved, requested, currency) => {
  for (const [key, value] of Object.entries(requested || {})) {
    const field = SCOPE_FIELDS[key];

    if (!approved || approved[key] === undefined || approved[key] === null) {
      return `That approval did not cover the ${field.word}.`;
    }

    const allowed = approved[key];

    if (field.kind === "upTo") {
      if (Number(value) > Number(allowed) + 0.001) {
        return `That approval was for ${figureText(key, allowed, currency)}, not ${figureText(key, value, currency)}.`;
      }
    } else if (field.kind === "money") {
      if (Math.abs(Number(value) - Number(allowed)) >= 0.005) {
        return `That approval was for ${figureText(key, allowed, currency)} ${field.word}, not ${figureText(key, value, currency)}.`;
      }
    } else if (allowed !== value) {
      return `That approval was for a different ${field.word}.`;
    }
  }

  return null;
};

const dateText = (value) =>
  new Date(`${String(value).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

// What the prompt says the manager is approving, built on the server from the
// same facts the token is tied to, so the words and the numbers on the screen
// are exactly what the approval allows. Throws 404 for a record that is not
// in this restaurant.
//
//   { summary: "Refund ₹50.00 on bill INV-0042",
//     facts: [{ label: "Bill", value: "INV-0042" }, { label: "Refund, at most", value: "₹50.00" }, ...] }
const describeScope = async (restaurantId, permission, scope) => {
  const found = await approvalRepository.findScopeFacts(restaurantId, scope);
  const { currency } = found;

  for (const [key, record] of [
    ["billId", found.bill],
    ["orderId", found.order],
    ["orderItemId", found.orderItem],
    ["businessDayId", found.businessDay],
    ["customerId", found.customer],
    ["productId", found.product],
    ["inventoryItemId", found.inventoryItem],
    ["purchaseOrderId", found.purchaseOrder],
    ["stockCountId", found.stockCount],
    ["paymentId", found.payment],
    ["advanceId", found.advance],
  ]) {
    if (scope[key] && !record) {
      throw new AppError(404, `That ${SCOPE_FIELDS[key].word} was not found`);
    }
  }

  if (found.orderItem && scope.orderId && Number(found.orderItem.order_id) !== scope.orderId) {
    throw new AppError(400, "That dish is not on that order");
  }

  if (found.payment && scope.billId && Number(found.payment.bill_id) !== scope.billId) {
    throw new AppError(400, "That payment is not on that bill");
  }

  const bill = found.bill ? found.bill.bill_number : null;
  const order = found.order ? found.order.order_number : null;
  const dish = found.orderItem
    ? `${found.orderItem.item_name}${found.orderItem.variant_name ? ` (${found.orderItem.variant_name})` : ""}`
    : found.product
      ? found.product.name
      : null;
  const facts = [];

  if (bill) {
    facts.push({ label: "Bill", value: bill });
  }

  if (order) {
    facts.push({ label: "Order", value: order });
  }

  if (dish) {
    facts.push({ label: "Dish", value: dish });
  }

  if (found.customer) {
    facts.push({ label: "Guest", value: found.customer.name });
  }

  if (found.inventoryItem) {
    facts.push({ label: "Stock item", value: found.inventoryItem.name });
  }

  if (found.purchaseOrder) {
    facts.push({ label: "Purchase order", value: found.purchaseOrder.po_number });
  }

  if (found.stockCount) {
    facts.push({ label: "Stock count", value: found.stockCount.count_number });
  }

  if (found.businessDay) {
    facts.push({ label: "Business day", value: dateText(found.businessDay.business_date) });
  }

  let summary;
  const METHOD = { cash: "Cash", card: "Card", upi: "UPI", online: "Online", wallet: "Wallet", other: "Other", advance: "Advance" };
  const methodText = (method) => METHOD[method] || method;

  if (permission === "bills.payment_correct" && found.bill && scope.fromMethod && scope.toMethod) {
    // "Change ₹1,240.00 from Cash to UPI on bill INV-0042": the bill, the
    // payment, its amount and both methods are what the manager approves.
    const worth = scope.amount !== undefined ? `${moneyText(scope.amount, currency)} ` : "";

    summary = `Change ${worth}from ${methodText(scope.fromMethod)} to ${methodText(scope.toMethod)} on bill ${bill}`;
    facts.push({ label: "Taken as", value: methodText(scope.fromMethod) });
    facts.push({ label: "Really paid by", value: methodText(scope.toMethod) });

    if (scope.amount !== undefined) {
      facts.push({ label: "Payment, at most", value: moneyText(scope.amount, currency) });
    }
  } else if (permission === "cash.movements" && scope.amount !== undefined) {
    const amount = moneyText(scope.amount, currency);
    const say = CASH_MOVES[scope.cashMove];

    summary = say ? say(amount) : `Put ${amount} into or take it out of the drawer`;

    if (scope.cashMove) {
      facts.push({ label: "Cash in or out", value: CASH_MOVE_WORDS[scope.cashMove] || scope.cashMove });
    }

    facts.push({ label: "Amount, at most", value: amount });
  } else if (permission === "advances.refund" && found.advance) {
    const worth = scope.amount !== undefined ? `${moneyText(scope.amount, currency)} ` : "";

    summary = `Hand back ${worth}of advance ${found.advance.receipt_number} to ${found.advance.customer_name}`;
    facts.push({ label: "Advance", value: found.advance.receipt_number });
    facts.push({ label: "Guest", value: found.advance.customer_name });
    facts.push({ label: "Still held", value: moneyText(found.advance.held, currency) });

    if (scope.amount !== undefined) {
      facts.push({ label: "Hand back, at most", value: moneyText(scope.amount, currency) });
    }
  } else if (permission === "orders.waive_delivery_charge" && found.bill) {
    summary = `Take off the ${scope.amount !== undefined ? `${moneyText(scope.amount, currency)} ` : ""}delivery charge on bill ${bill}`;

    if (scope.amount !== undefined) {
      facts.push({ label: "Delivery charge, at most", value: moneyText(scope.amount, currency) });
    }
  } else if (permission === "bills.refund" && found.bill) {
    summary = `Refund ${scope.amount !== undefined ? `${moneyText(scope.amount, currency)} ` : ""}on bill ${bill}`;

    if (scope.amount !== undefined) {
      facts.push({ label: "Refund, at most", value: moneyText(scope.amount, currency) });
    }

    facts.push({ label: "Paid on the bill", value: moneyText(found.bill.paid_amount, currency) });
  } else if (permission === "bills.void" && found.bill) {
    summary = `Void bill ${bill} (${moneyText(found.bill.total_amount, currency)})`;
    facts.push({ label: "Bill total", value: moneyText(found.bill.total_amount, currency) });
  } else if (permission === "business_day.close" && found.businessDay) {
    summary = `Close business day ${dateText(found.businessDay.business_date)}`;

    if (scope.closingCash !== undefined) {
      summary += ` with ${moneyText(scope.closingCash, currency)} counted`;
      facts.push({ label: "Cash counted", value: moneyText(scope.closingCash, currency) });
    }

    if (scope.carryUnpaid) {
      summary += ", unpaid bills carried as dues";
      facts.push({ label: "Unpaid bills", value: "Carried over as dues" });
    }
  } else if (permission === "orders.cancel_after_kot" && (dish || order)) {
    // What comes off the bill, in rupees, beside the plates: the manager
    // standing at the till weighs a ₹40 chai and a ₹1,200 platter
    // differently, and the approval is tied to this value (no more).
    const worth = scope.amount !== undefined ? ` (${moneyText(scope.amount, currency)})` : "";

    summary = dish
      ? `Take off ${scope.quantity !== undefined ? `${scope.quantity} × ` : ""}${dish}${worth}${order ? ` on ${order}` : ""}`
      : `Cancel ${order}${worth}, which the kitchen already has`;

    if (scope.quantity !== undefined) {
      facts.push({ label: "Quantity, at most", value: String(scope.quantity) });
    }

    if (scope.amount !== undefined) {
      facts.push({ label: "Value taken off, at most", value: moneyText(scope.amount, currency) });
    }
  } else if (permission === "loyalty.adjust" && found.customer && (scope.points !== undefined || scope.pointsOff !== undefined)) {
    // Said the way the manager will read it at the till: which way the
    // points go, how many, and whose.
    summary =
      scope.pointsOff !== undefined
        ? `Take ${scope.pointsOff} points away from ${found.customer.name}`
        : `Add ${scope.points} points to ${found.customer.name}`;
    facts.push(
      scope.pointsOff !== undefined
        ? { label: "Points to take away, at most", value: String(scope.pointsOff) }
        : { label: "Points to add, at most", value: String(scope.points) }
    );
  } else {
    const figures = ["amount", "quantity", "points", "pointsOff", "percent", "closingCash"]
      .filter((key) => scope[key] !== undefined)
      .map((key) => {
        const text = figureText(key, scope[key], currency);
        facts.push({
          label: `${capital(SCOPE_FIELDS[key].word)}${SCOPE_FIELDS[key].kind === "upTo" ? ", at most" : ""}`,
          value: text,
        });
        return text;
      });
    const on = [
      bill && `bill ${bill}`,
      order && `order ${order}`,
      dish,
      found.customer && found.customer.name,
      found.inventoryItem && found.inventoryItem.name,
      found.purchaseOrder && `purchase order ${found.purchaseOrder.po_number}`,
      found.stockCount && `stock count ${found.stockCount.count_number}`,
    ]
      .filter(Boolean)
      .join(", ");

    summary = `${capital(actionLabel(permission))}${figures.length ? ` of ${figures.join(", ")}` : ""}${on ? ` on ${on}` : ""}`;
  }

  return { summary: summary.slice(0, 200), facts };
};

const isLocked = (row, now = new Date()) =>
  Boolean(row.pin_locked_until && new Date(row.pin_locked_until) > now);

// The time on the restaurant's own clock, whatever clock the server keeps.
const lockedMessage = async (name, until, restaurantId, db = undefined) =>
  `${name}'s PIN is locked after too many wrong tries. Try again after ${new Date(until).toLocaleTimeString(
    "en-IN",
    {
      hour: "numeric",
      minute: "2-digit",
      timeZone: safeZone(await timeclockRepository.findTimezone(restaurantId, db)),
    }
  )}, or ask an admin to unlock it under Users.`;

const validatePermission = async (permission) => {
  if (NEVER_APPROVABLE.has(permission)) {
    throw new AppError(400, "That cannot be approved at the till");
  }

  const known = await roleRepository.findAllPermissions();

  if (!known.some((row) => row.code === permission)) {
    throw new AppError(400, "Unknown permission");
  }
};

// A till discount has a cap per role (Settings → Discounts at the till), and
// a manager may approve only as deep a discount as they could give
// themselves. Those capped below this discount are not offered: listing them
// let a 10%-capped manager type their PIN for a 15% discount, and the till
// then refused it with the approval already spent.
const withinDiscountCap = async (restaurantId, permission, scope, rows, db = undefined) => {
  if (permission !== "bills.discount" || !scope || scope.percent === undefined) {
    return { allowed: rows, capped: [] };
  }

  const allowed = [];
  const capped = [];

  for (const row of rows) {
    const cap = await restaurantRepository.findDiscountCapOfUser(restaurantId, row.id, db);

    if (cap === null || Number(scope.percent) <= Number(cap) + 0.001) {
      allowed.push(row);
    } else {
      capped.push({ ...row, cap: Number(cap) });
    }
  }

  return { allowed, capped };
};

// Who in this restaurant could approve it right now. Names only: the screen
// shows them as buttons so the manager standing there taps their own name.
// With a scope, also the words and figures the prompt shows ("Refund ₹50.00
// on bill INV-0042"): the same ones the approval will be tied to.
const listApprovers = async (requester, permission, rawScope = null) => {
  if (!requester.restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  await validatePermission(permission);

  const scope = normaliseScope(rawScope);
  const described = scope ? await describeScope(requester.restaurantId, permission, scope) : null;
  const rows = (await userRepository.findApprovers(requester.restaurantId, permission)).filter(
    (row) => Number(row.id) !== Number(requester.id)
  );
  const { allowed, capped } = await withinDiscountCap(requester.restaurantId, permission, scope, rows);

  return {
    permission,
    action: actionLabel(permission),
    scope,
    summary: described ? described.summary : null,
    facts: described ? described.facts : [],
    approvers: allowed.map((row) => ({
      id: row.id,
      name: row.name,
      lockedUntil: isLocked(row) ? new Date(row.pin_locked_until).toISOString() : null,
      // Their PIN was set by someone else: it approves nothing until they
      // choose their own, so the prompt shows them but does not take it.
      pinGiven: Boolean(row.pin_must_change),
    })),
    // People who could approve a smaller discount, for the prompt to say why
    // they are not offered: "Kiran (up to 10%)".
    notAllowed: capped.map((row) => ({ id: row.id, name: row.name, limit: row.cap })),
  };
};

// A wrong PIN is written to the activity log against the person who asked,
// which is also how the till-level limit below counts them.
const recordDenial = (requester, permission, entity, db = undefined) =>
  auditRepository.record(
    {
      restaurantId: requester.restaurantId,
      userId: requester.id,
      userName: requester.name,
      action: "approval_denied",
      entityType: "approval",
      entityLabel: entity.label || actionLabel(permission),
      details: { permission, approverId: entity.approverId || null, approverName: entity.approverName || null },
    },
    db
  );

const tooManyAtOnce = (name) =>
  new AppError(429, `Too many PIN tries for ${name} at once. Wait a minute and try again.`, {
    reason: "too_many_attempts",
  });

// Finds who is approving and checks their PIN. Runs under the requester's
// lock (see approve). A named manager's try is counted against their own PIN
// BEFORE it is compared, so however many prompts are sent at once, at most
// five are ever checked before that PIN locks.
//
// db: the client holding the requester's lock — every read and write here
// goes through it.
const findApprover = async (requester, permission, pin, input, db) => {
  const { attempts, windowMinutes } = config.accountLock;
  const denials = await approvalRepository.countRecentDenials(
    requester.restaurantId,
    requester.id,
    windowMinutes,
    db
  );

  // Five wrong PINs from one person's session in fifteen minutes, whoever they
  // were typed for, stops the prompt for a while: nobody can sit at the till
  // trying every manager's PIN in turn.
  if (denials >= attempts) {
    throw new AppError(
      429,
      `Too many wrong PINs at this till. Wait ${windowMinutes} minutes, or ask the manager to do it from their own login.`,
      { reason: "too_many_attempts" }
    );
  }

  const everyone = (await userRepository.findApprovers(requester.restaurantId, permission, db)).filter(
    (row) => Number(row.id) !== Number(requester.id)
  );
  const { allowed: candidates, capped } = await withinDiscountCap(
    requester.restaurantId,
    permission,
    input.scope || null,
    everyone,
    db
  );

  // A manager capped below this discount is told so before their PIN is
  // even read: no PIN try is spent, and no approval is issued that the till
  // would then refuse.
  const cappedChoice = input.approverId ? capped.find((row) => Number(row.id) === Number(input.approverId)) : null;

  if (cappedChoice) {
    const others = candidates.map((row) => row.name).slice(0, 3);
    throw new AppError(
      403,
      `${cappedChoice.name} can approve up to ${cappedChoice.cap}% off. ${input.scope.percent}% needs someone allowed more${
        others.length ? ` (${others.join(", ")})` : ""
      }.`,
      { reason: "discount_limit", limit: cappedChoice.cap, percent: input.scope.percent, permission }
    );
  }

  if (candidates.length === 0) {
    throw new AppError(
      409,
      capped.length > 0
        ? `Nobody allowed to approve ${input.scope.percent}% off has set a PIN yet. The owner can give it from their own login.`
        : `Nobody who can ${actionLabel(permission)} has set a PIN yet. A manager can do it from their own login, or set a PIN under My profile.`,
      { reason: "no_approvers" }
    );
  }

  if (input.approverId) {
    const chosen = candidates.find((row) => Number(row.id) === Number(input.approverId));

    if (!chosen) {
      throw new AppError(400, `That person cannot ${actionLabel(permission)}. Ask a manager who can.`, {
        reason: "not_an_approver",
      });
    }

    // A PIN someone else set approves nothing as its person: refused before
    // it is read, so no try is spent on it.
    authService().assertOwnPin(chosen);

    const slot = await userRepository.reservePinAttempt(chosen.id, config.accountLock, db);

    if (!slot.allowed) {
      if (slot.lockedUntil) {
        throw new AppError(423, await lockedMessage(chosen.name, slot.lockedUntil, requester.restaurantId, db), {
          reason: "pin_locked",
          lockedUntil: new Date(slot.lockedUntil).toISOString(),
        });
      }

      throw tooManyAtOnce(chosen.name);
    }

    if (await bcrypt.compare(pin, chosen.pin_hash)) {
      await userRepository.recordPinHit(chosen.id, db);
      return chosen;
    }

    const miss = await userRepository.recordPinMiss(chosen.id, slot.place, config.accountLock, db);
    await recordDenial(
      requester,
      permission,
      {
        label: input.label,
        approverId: chosen.id,
        approverName: chosen.name,
      },
      db
    );

    if (miss.justLocked) {
      await auditRepository.record(
        {
          restaurantId: requester.restaurantId,
          userId: requester.id,
          userName: requester.name,
          action: "lock",
          entityType: "user_pin",
          entityId: chosen.id,
          entityLabel: chosen.name,
          details: { reason: "Too many wrong PINs at the approval prompt", lockedUntil: miss.lockedUntil },
        },
        db
      );

      throw new AppError(423, await lockedMessage(chosen.name, miss.lockedUntil, requester.restaurantId, db), {
        reason: "pin_locked",
        lockedUntil: new Date(miss.lockedUntil).toISOString(),
      });
    }

    throw new AppError(
      400,
      `That PIN is not right. ${miss.attemptsLeft} tr${miss.attemptsLeft === 1 ? "y" : "ies"} left before ${chosen.name}'s PIN locks.`,
      { reason: "wrong_pin", attemptsLeft: miss.attemptsLeft }
    );
  }

  // No name given (the API allows a PIN on its own): the PIN is tried against
  // everyone who could approve with a PIN of their own. The till-wide limit
  // above caps these tries.
  for (const row of candidates.filter((candidate) => !isLocked(candidate) && !candidate.pin_must_change)) {
    if (await bcrypt.compare(pin, row.pin_hash)) {
      return row;
    }
  }

  await recordDenial(requester, permission, { label: input.label }, db);
  throw new AppError(400, "That PIN does not belong to anyone who can approve this", {
    reason: "wrong_pin",
    attemptsLeft: Math.max(0, attempts - denials - 1),
  });
};

// A manager standing at the till approves one action for the person signed in.
//
//   approverId  the manager who tapped their name (the screen always sends it)
//   pin         their personal PIN
//   target      the one request it is for ("PATCH /bills/42/void"), optional
//   scope       what it is for, as facts: { billId: 42, amount: 50 }. Routes
//               that bind their approvals (refund, void, day close) refuse a
//               token without one, or one whose facts differ.
//   label       what the screen said it was for ("Void bill INV-0042"). With
//               a scope, the server's own words replace it, so the log says
//               exactly what the token allowed.
//
// Without approverId the PIN is tried against everyone who could approve,
// which is slower and why the screen names the approver.
const approve = async (requester, input, meta = {}) => {
  if (!requester.restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  const { permission, pin } = input;
  await validatePermission(permission);

  if ((requester.permissions || []).includes(permission)) {
    throw new AppError(400, `You can already ${actionLabel(permission)} yourself`);
  }

  // Checked before the PIN, so a scope naming another restaurant's bill (or
  // a typo) costs the manager no PIN try.
  const scope = normaliseScope(input.scope);
  const described = scope ? await describeScope(requester.restaurantId, permission, scope) : null;

  // One check at a time for each person asking. The till-wide limit below
  // counts wrong PINs already recorded; checks racing each other would all
  // read the same count and all be tried. A second prompt sent while one is
  // being checked is simply asked to wait.
  const checked = await approvalRepository.withRequesterLock(requester.id, (client) =>
    findApprover(requester, permission, pin, { ...input, scope }, client)
  );

  if (checked.busy) {
    throw new AppError(429, "An approval is already being checked at this till. Wait a moment and try again.", {
      reason: "approval_busy",
    });
  }

  const approver = checked.value;

  const token = crypto.randomBytes(32).toString("base64url");
  const target = normaliseTarget(input.method, input.url) || input.target || null;
  const label = described ? described.summary : input.label ? String(input.label).slice(0, 200) : null;
  const note = input.note ? String(input.note).slice(0, 200) : null;

  const saved = await approvalRepository.create({
    restaurantId: requester.restaurantId,
    permission,
    tokenHash: hashToken(token),
    requestedBy: requester.id,
    approvedBy: approver.id,
    target,
    label,
    note,
    scope,
    ttlSeconds: config.approvalTtlSeconds,
  });

  auditRepository.record({
    restaurantId: requester.restaurantId,
    userId: requester.id,
    userName: requester.name,
    action: "approval_granted",
    entityType: "approval",
    entityId: saved.id,
    entityLabel: label || actionLabel(permission),
    details: { permission, action: actionLabel(permission), note, ip: meta.ip || null },
    approvedBy: approver.id,
    approverName: approver.name,
  });

  return {
    approvalToken: token,
    approver: { id: approver.id, name: approver.name },
    permission,
    scope,
    approvedFor: label,
    expiresInSeconds: config.approvalTtlSeconds,
    expiresAt: new Date(saved.expires_at).toISOString(),
  };
};

const invalidApproval = (why, permission, scope) =>
  new AppError(403, `${why} Ask the manager to approve again.`, {
    reason: "approval_invalid",
    permission,
    action: actionLabel(permission),
    // What this request would do, so the prompt that opens again shows the
    // real figures and ties the new approval to them.
    scope: scope || null,
  });

// Spends a token for one request, for good, before the action runs. Throws
// 403 with a reason the screen can act on (ask again) when it is not good for
// this person, permission or request, or has already been used.
//
// `scope` is what this request would do, read off it by the route; with
// `scopeRequired` (the route binds its approvals) a token must carry facts,
// and every one the request has must match: the same bill, and an amount no
// higher than approved. That check runs inside the claim, on the row being
// claimed, so it can never be skipped: however many requests race with one
// token, exactly one is let through, and only if it is what the manager
// approved. A request that does not match leaves the token unused.
const redeem = async ({ token, restaurantId, userId, permission, method, url, scope = null, scopeRequired = false }) => {
  const tokenHash = hashToken(token);
  const target = normaliseTarget(method, url);
  // For the figures in a mismatch message; read before the row is held.
  const currency = scope ? (await approvalRepository.findScopeFacts(restaurantId, {})).currency : "₹";

  const { claimed, problem } = await approvalRepository.spend(
    { tokenHash, restaurantId, requestedBy: userId, permission, target },
    (row) => {
      if (!row.scope) {
        return scopeRequired ? "That approval did not say exactly what it was for (which bill, how much)." : null;
      }

      return scope ? scopeMismatch(row.scope, scope, currency) : null;
    }
  );

  if (problem) {
    throw invalidApproval(problem, permission, scope);
  }

  if (claimed) {
    return claimed;
  }

  const found = await approvalRepository.findByHash(tokenHash);
  let why = "That approval is not valid here.";

  if (found && Number(found.restaurant_id) === Number(restaurantId) && Number(found.requested_by) === Number(userId)) {
    if (found.used_at) {
      why = "That approval has already been used.";
    } else if (found.expired) {
      why = "That approval has expired.";
    } else if (found.permission !== permission) {
      why = "That approval was for something else.";
    } else if (found.target && found.target !== target) {
      why = "That approval was for a different bill or order.";
    }
  }

  throw invalidApproval(why, permission, scope);
};

module.exports = {
  ACTION_LABELS,
  actionLabel,
  normaliseScope,
  listApprovers,
  approve,
  redeem,
};
