const billService = require("../services/bill.service");
const restaurantFeatures = require("../../setup/services/restaurantFeatures.service");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");
const approvalService = require("../../../access/services/approval.service");
const customerAccountService = require("../services/customerAccount.service");
const { readBuyerPan } = require("../services/cashAndPan");
const { logAction } = require("../../../../utils/audit");
const { readDate } = require("../../../../utils/calendarDate");
const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");

const PAYMENT_METHODS = ["cash", "card", "upi", "online", "wallet", "other"];
// A payment may also come from an advance the guest gave earlier, and money
// given back on such a bill may go back onto it.
const BILL_PAYMENT_METHODS = [...PAYMENT_METHODS, "advance"];

// Staff pinned to one outlet see and act on that outlet's bills only
// (resolveOutlet sets req.outletPinned); full mobiles are for customers.contact.
const ctxOf = (req) => ({
  outletId: req.outletId || null,
  outletPinned: Boolean(req.outletPinned),
  reveal: (req.user.permissions || []).includes("customers.contact"),
  // Bills as the guest sees them, today's only: someone who may neither see
  // takings (sales.view) nor take payments (payments.manage) — a captain.
  limited: !["sales.view", "payments.manage"].some((code) => (req.user.permissions || []).includes(code)),
});

const has = (req, permission) => (req.user.permissions || []).includes(permission);

// Money actions write their activity-log row before answering (logAction never
// throws), so the next screen — the theft report, the bill's own history —
// already sees who did it and who approved it.

// Someone who holds bills.discount but is capped below this discount is
// refused, with who can give it.
const withinOwnCap = async (req, { permission, percent }) => {
  const restaurantId = req.user.restaurantId;
  const cap = await restaurantRepository.findDiscountCapOfUser(restaurantId, req.user.id);

  if (cap !== null && percent > cap + 0.001) {
    const people = await restaurantRepository.findDiscountApprovers(restaurantId, percent, req.user.id);
    throw new AppError(
      403,
      `Your limit is ${cap}% off a bill. ${percent}% has to be given by someone allowed more${
        people.length ? ` (${people.map((row) => row.name).join(", ")})` : ""
      }.`,
      { reason: "discount_limit", limit: cap, percent, permission }
    );
  }
};

// The permission an action needs, or a manager's approval for it — decided
// here rather than on the route because what a change needs depends on the
// change (a 10% discount, a bill already printed, a no-charge bill).
//
// A till discount has a cap per role on top: someone who holds
// bills.discount but is capped below what they are giving is refused with who
// can do it; a manager approving for someone else must be allowed that much
// themselves (the PIN prompt only offers those who are, approval.service).
const gate = async (req, res, need) => {
  if (!need) {
    return;
  }

  const { permission, scope, percent } = need;
  const restaurantId = req.user.restaurantId;
  const capped = permission === "bills.discount" && percent !== undefined;

  const namesFor = async (exceptUserId) => {
    const people = await restaurantRepository.findDiscountApprovers(restaurantId, percent, exceptUserId);
    return people.length ? ` (${people.map((row) => row.name).join(", ")})` : "";
  };

  if (capped && has(req, permission)) {
    await withinOwnCap(req, need);
    return;
  }

  // Straight through with the permission; otherwise a manager's one-time
  // approval for exactly these facts, or 403 approval_required.
  await authorizeOrApprove(permission, { scope: () => scope })(req, res, () => undefined);

  if (capped && req.approval) {
    const cap = await restaurantRepository.findDiscountCapOfUser(restaurantId, req.approval.approverId);

    if (cap !== null && percent > cap + 0.001) {
      throw new AppError(
        403,
        `${req.approval.approverName} can approve up to ${cap}% off. ${percent}% needs someone allowed more${await namesFor(req.user.id)}.`,
        { reason: "discount_limit", limit: cap, percent, permission }
      );
    }
  }
};

// ?page=&pageSize= as a limit and an offset; nothing when the request does
// not page.
const pageOf = (query) => {
  if (!query.page && !query.pageSize) {
    return {};
  }

  const pageSize = query.pageSize ? Number(v.requiredEnum(String(query.pageSize), "Page size", ["25", "50", "100"])) : 25;
  const page = query.page ? v.requiredId(query.page, "Page") : 1;

  return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
};

// "4,1596,1597" -> [4, 1596, 1597]: whole numbers only, at most 200 of them.
const readDayIds = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parts = String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 200 || !parts.every((part) => /^\d{1,18}$/.test(part) && Number(part) > 0)) {
    throw new AppError(400, "Business days must be a list of business day ids");
  }

  return [...new Set(parts.map(Number))];
};

const list = async (req, res) => {
  const from = readDate(req.query.from, "From");
  const to = readDate(req.query.to, "To");

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  const filters = {
    // A list, so "money still to collect" — unpaid and part-paid together —
    // can be asked for in one request, which is what the dashboard links to.
    status: v.enumList(req.query.status, "Status", ["unpaid", "partial", "paid", "void"]),
    businessDayId: v.optionalNumber(req.query.businessDayId, "Business day", { min: 1 }),
    // Several days at once, "4,1596" (the dashboard's open days).
    businessDayIds: readDayIds(req.query.businessDays),
    // One outlet's bills only, for someone who may see every outlet's (the
    // dashboard with an outlet chosen). Staff tied to an outlet always get
    // their own, whatever is asked.
    outletId: v.optionalNumber(req.query.outletId, "Outlet", { min: 1 }),
    // "none": bills not on a guest's or company's account; "only": just those.
    account: v.optionalEnum(req.query.account, "Account", ["none", "only"], null),
    orderId: req.query.orderId ? v.requiredId(req.query.orderId, "Order") : null,
    search: v.optionalString(req.query.search, "Search", 60),
    complimentaryOnly: req.query.complimentary === "true",
    from,
    to,
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 500 }) ?? 100,
    // Paging: ?page=2&pageSize=25 (25, 50 or 100 to a page) — the Bills
    // screen's grid; without them, the first `limit` (older callers).
    ...pageOf(req.query),
  };

  res.json({ success: true, data: await billService.list(req.user.restaurantId, filters, ctxOf(req)) });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "Bill id");

  res.json({ success: true, data: await billService.getById(req.user.restaurantId, id, ctxOf(req)) });
};

// Reasons, and the cap of the person at the till, for the discount prompts.
const tillOptions = async (req, res) => {
  res.json({
    success: true,
    data: await billService.tillOptions(req.user.restaurantId, req.user.id, req.user.permissions || []),
  });
};

// Checks the bill exists for this person (their restaurant, and their outlet
// when they are pinned to one) before anything else runs — including a
// manager's approval, which must never be asked for a bill that is not theirs.
const billInScope = async (req, res, next) => {
  const id = v.requiredId(req.params.id, "Bill id");
  req.bill = await billService.findInScope(req.user.restaurantId, id, ctxOf(req));
  next();
};

const serviceChargeInput = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object") {
    throw new AppError(400, "Service charge must say whether to take it off");
  }

  const waive = v.requiredBoolean(value.waive, "Take off service charge", false);

  return { waive, reason: waive ? v.optionalString(value.reason, "Reason for taking off service charge", 200) : null };
};

const discountInput = (value, field) => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "object") {
    throw new AppError(400, `${field} must be a percentage or an amount`);
  }

  const type = v.requiredEnum(value.type, `${field} type`, ["percentage", "amount"]);
  const amount = v.requiredNumber(value.value, field, {
    min: 0.01,
    max: type === "percentage" ? 100 : 9999999,
  });

  return { type, value: amount };
};

// Amounts are worked out by the server from the order; the request only names
// the order and what the till asked for.
// A coupon needs Coupons & offers, points need Loyalty points (Settings ->
// Features). A manager's own discount at the till is core and always works.
const checkBillFeatures = async (req, input) => {
  if (input.discountCode) {
    await restaurantFeatures.assertOn(req.user, "coupons");
  }

  if (input.loyaltyPoints) {
    await restaurantFeatures.assertOn(req.user, "guest_loyalty");
  }
};

const create = async (req, res) => {
  const body = req.body || {};

  const data = {
    orderId: v.requiredId(body.orderId, "Order"),
    discountCode: v.optionalString(body.discountCode, "Discount code", 30),
    loyaltyPoints: v.optionalNumber(body.loyaltyPoints, "Points to redeem", {
      min: 1,
      max: 1000000,
    }),
    serviceCharge: serviceChargeInput(body.serviceCharge),
    // No items means "bill everything still unbilled". Sending a subset splits
    // the order across more than one bill.
    items: (body.items || []).map((item) => ({
      orderItemId: v.requiredId(item.orderItemId, "Order item"),
      quantity: v.requiredNumber(item.quantity, "Quantity", { min: 0.01, max: 9999 }),
    })),
    // { pan } or { panDeclaration: true }: what a bill over ₹2,00,000 needs
    // before its first payment, given before it is raised.
    buyer: readBuyerPan(body.buyer),
  };

  await checkBillFeatures(req, data);

  if (data.serviceCharge && data.serviceCharge.waive && !data.serviceCharge.reason) {
    throw new AppError(400, "Say why the service charge is taken off (the guest's reason)");
  }

  const bill = await billService.createForOrder(req.user.restaurantId, data, req.user.id, ctxOf(req));

  if (data.buyer) {
    await logAction(req, "buyer_pan", "bill", {
      id: bill.id,
      label: bill.billNumber,
      details: { changes: panChanges({ pan: null, declaration: false }, data.buyer) },
    });
  }

  if (bill.serviceChargeWaived) {
    await logAction(req, "service_charge_waived", "bill", {
      id: bill.id,
      label: bill.billNumber,
      details: { reason: bill.serviceChargeWaiveReason },
    });
  }

  res.status(201).json({ success: true, message: "Bill created", data: bill });
};

// A change to a bill not yet settled: coupon, points, a till discount (on the
// bill or on dishes), service charge declined, or no-charge. The bill keeps
// its number; nothing is voided and raised again.
const readAdjust = (body = {}) => {
  const input = {};

  if (body.discountCode !== undefined) {
    input.discountCode = v.optionalString(body.discountCode, "Coupon code", 30);
  }

  if (body.loyaltyPoints !== undefined) {
    input.loyaltyPoints = v.optionalNumber(body.loyaltyPoints, "Points to use", { min: 0, max: 1000000 }) ?? 0;
  }

  if (body.manualDiscount !== undefined) {
    input.manualDiscount = discountInput(body.manualDiscount, "Discount");
  }

  if (body.itemDiscounts !== undefined) {
    const seen = new Set();

    input.itemDiscounts = v.requiredArray(body.itemDiscounts, "Dish discounts").map((row) => {
      const orderItemId = v.requiredId(row && row.orderItemId, "Dish");

      if (seen.has(orderItemId)) {
        throw new AppError(400, "A dish can carry one discount");
      }

      seen.add(orderItemId);

      return { orderItemId, ...discountInput(row, "Dish discount") };
    });
  }

  if (body.discountReason !== undefined) {
    input.discountReason = v.optionalString(body.discountReason, "Discount reason", 30);
    input.discountNote = v.optionalString(body.discountNote, "Discount note", 200);
  } else if (body.discountNote !== undefined) {
    input.discountNote = v.optionalString(body.discountNote, "Discount note", 200);
  }

  if (body.serviceCharge !== undefined) {
    input.serviceCharge = serviceChargeInput(body.serviceCharge);
  }

  if (body.deliveryCharge !== undefined && body.deliveryCharge !== null) {
    if (typeof body.deliveryCharge !== "object") {
      throw new AppError(400, "Delivery charge must say whether to take it off");
    }

    const waive = v.requiredBoolean(body.deliveryCharge.waive, "Take off delivery charge", false);

    input.deliveryCharge = {
      waive,
      reason: waive ? v.optionalString(body.deliveryCharge.reason, "Reason for taking off the delivery charge", 200) : null,
    };
  }

  if (body.complimentary !== undefined && body.complimentary !== null) {
    if (typeof body.complimentary !== "object") {
      throw new AppError(400, "Say why the bill is no-charge");
    }

    input.complimentary = {
      reason: v.optionalString(body.complimentary.reason, "No-charge reason", 30),
      note: v.optionalString(body.complimentary.note, "No-charge note", 200),
    };
  }

  if (Object.keys(input).length === 0) {
    throw new AppError(400, "Nothing to change on the bill");
  }

  return input;
};

// What a change would need, worked out and checked without changing
// anything, so the till asks for the manager's PIN up front when one is
// needed — rather than sending the change, being refused (a 403 in the
// browser's console) and asking afterwards. Reasons, the coupon, points and
// what the bill would come to are all checked here first, as in adjust.
//
// { approval: null } — the person may do it themselves.
// { approval: { permission, scope, action } } — a manager's approval, tied
// to exactly these facts, is needed.
// { refused: { message, reason, status } } — the change would be refused (no
// reason given, over the account's credit limit, past the person's own
// discount cap…). A check that has found its answer is not a failed request:
// the till shows the sentence and sends nothing, and the browser has no
// failed request to log. The change itself (PATCH adjust) still refuses it.
const checkAdjust = async (req, res) => {
  const input = readAdjust(req.body || {});
  await checkBillFeatures(req, input);
  let plan;
  let approval = null;

  try {
    plan = await billService.planAdjust(req.user.restaurantId, req.bill.id, input, ctxOf(req));
    const need = plan.needs;

    if (need && has(req, need.permission)) {
      if (need.permission === "bills.discount" && need.percent !== undefined) {
        await withinOwnCap(req, need);
      }
    } else if (need) {
      approval = {
        permission: need.permission,
        action: approvalService.actionLabel(need.permission),
        scope: approvalService.normaliseScope(need.scope),
      };
    }
  } catch (error) {
    if (!(error instanceof AppError) || ![400, 403, 409].includes(error.statusCode)) {
      throw error;
    }

    res.json({
      success: true,
      data: {
        approval: null,
        refused: { message: error.message, status: error.statusCode, ...(error.details || {}) },
      },
    });
    return;
  }

  res.json({
    success: true,
    data: { approval, refused: null, totalAmount: plan.priced.totalAmount, tillAmount: plan.priced.tillAmount },
  });
};

const adjust = async (req, res) => {
  const input = readAdjust(req.body || {});
  await checkBillFeatures(req, input);
  const ctx = ctxOf(req);
  // Everything is checked (reasons, coupon, points, what it would come to)
  // before a manager is asked for anything.
  const plan = await billService.planAdjust(req.user.restaurantId, req.bill.id, input, ctx);

  await gate(req, res, plan.needs);

  const { before, plan: applied, bill } = await billService.adjust(
    req.user.restaurantId,
    req.bill.id,
    input,
    { userId: req.user.id, approverId: req.approval ? req.approval.approverId : null },
    ctx
  );

  const common = {
    before: Number(before.total_amount),
    after: bill.totalAmount,
    printedBefore: Number(before.print_count) > 0,
  };

  if (applied.changes.complimentary && !before.is_complimentary) {
    await logAction(req, "complimentary", "bill", {
      id: bill.id,
      label: bill.billNumber,
      details: { ...common, reason: bill.complimentaryReason, note: bill.complimentaryNote, value: bill.subtotal },
    });
  } else {
    if (
      input.discountCode !== undefined ||
      input.loyaltyPoints !== undefined ||
      input.manualDiscount !== undefined ||
      input.itemDiscounts !== undefined
    ) {
      await logAction(req, "discount", "bill", {
        id: bill.id,
        label: bill.billNumber,
        details: {
          ...common,
          coupon: bill.discountCode,
          couponDiscount: bill.couponDiscount,
          tillDiscount: bill.manualDiscount ? bill.manualDiscount.amount : 0,
          dishDiscounts: bill.itemDiscountAmount,
          points: bill.loyaltyPointsUsed,
          reason: bill.discountReasonLabel,
          note: bill.discountNote,
        },
      });
    }

    if (input.serviceCharge !== undefined && Boolean(before.service_charge_waived) !== bill.serviceChargeWaived) {
      await logAction(req, bill.serviceChargeWaived ? "service_charge_waived" : "service_charge_restored", "bill", {
        id: bill.id,
        label: bill.billNumber,
        details: { ...common, reason: bill.serviceChargeWaiveReason },
      });
    }

    if (input.deliveryCharge !== undefined && Boolean(before.delivery_charge_waived) !== bill.deliveryChargeWaived) {
      await logAction(req, bill.deliveryChargeWaived ? "waive_delivery_charge" : "restore_delivery_charge", "bill", {
        id: bill.id,
        label: bill.billNumber,
        details: {
          ...common,
          amount: applied.changes.deliveryChargeFull,
          reason: bill.deliveryChargeWaiveReason,
        },
      });
    }
  }

  res.json({ success: true, message: "Bill updated", data: bill });
};

const addPayment = async (req, res) => {
  const body = req.body || {};

  const data = {
    paymentMethod: v.requiredEnum(body.paymentMethod, "Payment method", BILL_PAYMENT_METHODS),
    amount: v.requiredNumber(body.amount, "Amount", { min: 0.01, max: 99999999 }),
    tenderedAmount: v.optionalNumber(body.tenderedAmount, "Cash given", { min: 0, max: 99999999 }),
    transactionRef: v.optionalString(body.transactionRef, "Reference", 100),
    // On top of the amount, for the staff.
    tipAmount: v.optionalNumber(body.tipAmount, "Tip", { min: 0, max: 999999 }) ?? 0,
    paymentTypeId: body.paymentTypeId ? v.requiredId(body.paymentTypeId, "Payment type") : null,
    advanceId: body.advanceId ? v.requiredId(body.advanceId, "Advance") : null,
    // The buyer's PAN, or their Form 97 declaration, typed on the payment
    // screen: written on the bill with the payment.
    buyer: readBuyerPan(body.buyer),
  };

  // A tip needs Tips; paying from a guest's advance needs Advances & deposits.
  if (data.tipAmount > 0) {
    await restaurantFeatures.assertOn(req.user, "tips");
  }

  if (data.paymentMethod === "advance" || data.advanceId) {
    await restaurantFeatures.assertOn(req.user, "advances");
  }

  const bill = await billService.addPayment(req.user.restaurantId, req.bill.id, data, req.user.id, ctxOf(req));
  const taken = bill.payments[bill.payments.length - 1] || null;
  const panChanged = data.buyer ? panChanges({ pan: req.bill.buyer_pan, declaration: req.bill.pan_declaration }, data.buyer) : null;

  if (panChanged) {
    await logAction(req, "buyer_pan", "bill", { id: bill.id, label: bill.billNumber, details: { changes: panChanged } });
  }

  await logAction(req, "payment", "bill", {
    id: bill.id,
    label: bill.billNumber,
    details: {
      method: data.paymentMethod,
      amount: data.amount,
      tip: data.tipAmount || undefined,
      type: taken && taken.paymentTypeName ? taken.paymentTypeName : undefined,
      advance: taken && taken.advanceReceiptNumber ? taken.advanceReceiptNumber : undefined,
    },
  });

  res.status(201).json({ success: true, message: "Payment recorded", data: bill });
};

// --- The buyer's PAN ---------------------------------------------------------------

// What recording the buyer's PAN changed on a bill, for the activity log:
// { pan: [before, after] } and { panDeclaration: [before, after] } where they
// moved, or null when nothing did.
const panChanges = (before, buyer) => {
  const changes = {};

  if ((before.pan || null) !== (buyer.pan || null)) {
    changes.pan = [before.pan || null, buyer.pan || null];
  }

  if (Boolean(before.declaration) !== Boolean(buyer.declaration)) {
    changes.panDeclaration = [Boolean(before.declaration), Boolean(buyer.declaration)];
  }

  return Object.keys(changes).length > 0 ? changes : null;
};

// The buyer's PAN on a bill not yet settled, or their declaration that they
// have none (Form 97): { pan } or { panDeclaration: true }. A bill over
// ₹2,00,000 takes no payment until one is on it.
const setBuyerPan = async (req, res) => {
  const buyer = readBuyerPan(req.body || {});

  if (!buyer) {
    throw new AppError(400, "Type the buyer's PAN, or record their declaration that they have none (Form 97)");
  }

  const { before, bill } = await billService.setBuyerPan(req.user.restaurantId, req.bill.id, buyer, req.user.id, ctxOf(req));
  const changes = panChanges(before, buyer);

  if (changes) {
    await logAction(req, "buyer_pan", "bill", { id: bill.id, label: bill.billNumber, details: { changes } });
  }

  res.json({
    success: true,
    message: buyer.pan
      ? `${bill.billNumber} records the buyer's PAN ${buyer.pan}`
      : `${bill.billNumber} records the buyer's declaration that they have no PAN (Form 97)`,
    data: bill,
  });
};

// --- Correcting how a payment was taken ----------------------------------------

const METHOD_WORDS = { cash: "cash", card: "card", upi: "UPI", online: "online", wallet: "wallet", other: "other" };

const readCorrection = (req) => {
  const body = req.body || {};

  return {
    paymentId: v.requiredId(req.params.paymentId, "Payment"),
    method: v.requiredEnum(body.paymentMethod, "Paid by", PAYMENT_METHODS),
    paymentTypeId: body.paymentTypeId ? v.requiredId(body.paymentTypeId, "Payment type") : null,
    reference: v.optionalString(body.transactionRef, "Reference", 100),
    reason: v.requiredString(body.reason, "Reason", 200),
  };
};

// Runs before the manager is asked: the payment is checked against the bill
// and its day first, and what it found is what the approval is tied to —
// this bill, this payment, this amount, and from which method to which.
const checkCorrection = async (req, res, next) => {
  req.correctionCheck = await billService.checkCorrection(req.user.restaurantId, req.bill, readCorrection(req));
  next();
};

const correctionScope = (req) => req.correctionCheck.scope;

const correctPayment = async (req, res) => {
  const data = readCorrection(req);
  const { result, bill } = await billService.correctPayment(
    req.user.restaurantId,
    req.bill.id,
    data,
    { userId: req.user.id, approverId: req.approval ? req.approval.approverId : null },
    ctxOf(req)
  );
  const fixed = bill.payments.find((row) => Number(row.id) === Number(data.paymentId));

  await logAction(req, "payment_corrected", "bill", {
    id: bill.id,
    label: bill.billNumber,
    details: {
      paymentId: data.paymentId,
      amount: result.amount,
      tip: result.tip || undefined,
      from: result.oldMethod,
      to: data.method,
      type: fixed ? fixed.paymentTypeName || undefined : undefined,
      oldReference: result.oldReference || undefined,
      reference: data.reference || undefined,
      reason: data.reason,
    },
  });

  res.json({
    success: true,
    message: `The ${result.amount.toLocaleString("en-IN")} payment is now recorded as ${METHOD_WORDS[data.method]}`,
    data: bill,
  });
};

// --- A bill on a guest's or company's account ---------------------------------

const readAccount = (body = {}) => ({
  customerId: body.customerId === null ? null : v.requiredId(body.customerId, "Guest or company"),
  note: v.optionalString(body.note, "Note", 200),
});

// Runs before the manager is asked: the account exists, is not on hold, and
// has room for this bill under its limit. What it found (the amount due) is
// what the approval is tied to.
const checkAccount = async (req, res, next) => {
  const data = readAccount(req.body || {});

  // A new bill on a guest's account picks the guest from the guest book.
  if (data.customerId) {
    await restaurantFeatures.assertOn(req.user, "guests");
  }

  req.accountCheck = await customerAccountService.checkPutOnAccount(req.user.restaurantId, req.bill, data.customerId);
  next();
};

const putOnAccount = async (req, res) => {
  const data = readAccount(req.body || {});
  const result = await customerAccountService.putOnAccount(
    req.user.restaurantId,
    req.bill.id,
    data,
    { userId: req.user.id, approverId: req.approval ? req.approval.approverId : null },
    ctxOf(req)
  );
  const bill = await billService.getById(req.user.restaurantId, req.bill.id, ctxOf(req));

  await logAction(req, data.customerId ? "on_account" : "off_account", "bill", {
    id: bill.id,
    label: bill.billNumber,
    details: data.customerId
      ? { account: bill.accountName, amount: result.due, owedNow: result.outstanding, limit: result.limit, note: data.note }
      : { amount: result.due },
  });

  res.json({
    success: true,
    message: data.customerId
      ? `${bill.billNumber} is on ${bill.accountName}'s account · ₹${result.due.toLocaleString("en-IN")} due`
      : `${bill.billNumber} is off the account; it is due at the till again`,
    data: bill,
  });
};

const readRefund = (body = {}) => ({
  amount: v.requiredNumber(body.amount, "Amount", { min: 0.01, max: 99999999 }),
  // Left out: the way the bill was paid, when it was paid one way only.
  // "advance": back onto the guest's advance the bill was paid from.
  refundMethod: v.optionalEnum(body.refundMethod, "Refund method", BILL_PAYMENT_METHODS, null),
  paymentTypeId: body.paymentTypeId ? v.requiredId(body.paymentTypeId, "Payment type") : null,
  reason: v.requiredString(body.reason, "Reason", 200),
  reversePoints: body.reversePoints === undefined ? true : v.requiredBoolean(body.reversePoints, "Take back points", true),
  items: (body.items || []).map((item) => ({
    orderItemId: v.requiredId(item && item.orderItemId, "Dish returned"),
    quantity: v.requiredNumber(item && item.quantity, "Quantity returned", { min: 0.01, max: 9999 }),
  })),
});

// Runs before the manager is asked: a refund the bill would refuse is refused
// now, so no approval is spent on it.
const checkRefund = async (req, res, next) => {
  await billService.checkRefund(req.bill, readRefund(req.body || {}), req.user.restaurantId);
  next();
};

const addRefund = async (req, res) => {
  const data = readRefund(req.body || {});
  const { bill, result } = await billService.addRefund(req.user.restaurantId, req.bill.id, data, req.user.id, ctxOf(req));

  await logAction(req, "refund", "bill", {
    id: bill.id,
    label: bill.billNumber,
    details: {
      amount: data.amount,
      method: result.method,
      reason: data.reason,
      kind: result.kind,
      creditNote: result.creditNoteNumber,
      items: data.items.length ? data.items : undefined,
    },
  });

  res.status(201).json({
    success: true,
    message: result.creditNoteNumber ? `Refund recorded · credit note ${result.creditNoteNumber}` : "Payment handed back",
    data: bill,
  });
};

// Runs before the manager is asked, like checkRefund: the reason and the
// bill's state are checked first, so no approval is spent on a void the bill
// would refuse.
const checkVoid = async (req, res, next) => {
  v.requiredString(req.body?.reason, "Reason", 200);
  billService.checkVoid(req.bill);
  next();
};

const voidBill = async (req, res) => {
  const reason = v.requiredString(req.body?.reason, "Reason", 200);
  const bill = await billService.voidBill(req.user.restaurantId, req.bill.id, reason, req.user.id, ctxOf(req));

  await logAction(req, "void", "bill", {
    id: bill.id,
    label: bill.billNumber,
    details: { reason, amount: bill.totalAmount },
  });

  res.json({ success: true, message: "Bill voided and the order reopened", data: bill });
};

// What is still unbilled on an order.
const billableItems = async (req, res) => {
  const orderId = v.requiredId(req.params.orderId, "Order id");

  res.json({ success: true, data: await billService.billableItems(req.user.restaurantId, orderId, ctxOf(req)) });
};

// Every print is counted, from any screen. The first is the original; every
// later one prints DUPLICATE and needs bills.reprint (a cashier has it) or a
// manager's approval — a captain printing a second copy of a paid bill is how
// one bill gets collected twice.
const registerPrint = async (req, res) => {
  const bill = req.bill;
  const reprintNeed = { permission: "bills.reprint", scope: { billId: bill.id } };
  let firstOnly = false;

  if (Number(bill.print_count) > 0) {
    await gate(req, res, reprintNeed);
  } else {
    // Someone without the reprint right may print the first copy only: if
    // another till printed it a moment ago, this one is a reprint after all.
    firstOnly = !has(req, "bills.reprint");
  }

  let printed = await billService.registerPrint(req.user.restaurantId, bill.id, { firstOnly }, ctxOf(req));

  if (!printed) {
    await gate(req, res, reprintNeed);
    printed = await billService.registerPrint(req.user.restaurantId, bill.id, { firstOnly: false }, ctxOf(req));
  }

  if (!printed) {
    throw new AppError(404, "Bill not found");
  }

  if (printed.printCount > 1) {
    await logAction(req, "reprint", "bill", {
      id: printed.id,
      label: printed.billNumber,
      details: { printCount: printed.printCount },
    });
  }

  res.json({
    success: true,
    message: printed.copy === "duplicate" ? `Duplicate copy ${printed.printCount - 1} recorded` : "Print recorded",
    data: printed,
  });
};

// scope "restaurant" (the default): with All outlets chosen, every business
// day open in the restaurant added up — the Bills screen. scope "counter":
// the one day the Business day screen opens and closes (the outlet's own, or
// the main counter's). With an outlet chosen both are that outlet's day.
const daySummary = async (req, res) => {
  const businessDayId = req.query.businessDayId ? v.requiredId(req.query.businessDayId, "Business day") : null;
  const scope = v.optionalEnum(req.query.scope, "Scope", ["restaurant", "counter"], "restaurant");

  res.json({
    success: true,
    data: await billService.daySummary(req.user.restaurantId, businessDayId, ctxOf(req), { scope }),
  });
};

// Payments whose method was corrected: ?from=&to=&page=&pageSize= (25/50/100).
const corrections = async (req, res) => {
  const from = readDate(req.query.from, "From");
  const to = readDate(req.query.to, "To");

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  res.json({
    success: true,
    data: await billService.listCorrections(
      req.user.restaurantId,
      {
        from,
        to,
        page: req.query.page ? v.requiredId(req.query.page, "Page") : 1,
        pageSize: req.query.pageSize ? Number(v.requiredEnum(String(req.query.pageSize), "Page size", ["25", "50", "100"])) : 25,
      },
      ctxOf(req)
    ),
  });
};

const creditNotes = async (req, res) => {
  const from = readDate(req.query.from, "From");
  const to = readDate(req.query.to, "To");

  res.json({
    success: true,
    data: await billService.listCreditNotes(
      req.user.restaurantId,
      { from, to, limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 500 }) ?? 200, ...pageOf(req.query) },
      ctxOf(req)
    ),
  });
};

module.exports = {
  list,
  getById,
  tillOptions,
  billInScope,
  billableItems,
  create,
  checkAdjust,
  adjust,
  addPayment,
  setBuyerPan,
  checkCorrection,
  correctionScope,
  correctPayment,
  checkAccount,
  putOnAccount,
  checkRefund,
  addRefund,
  checkVoid,
  voidBill,
  registerPrint,
  daySummary,
  creditNotes,
  corrections,
};
