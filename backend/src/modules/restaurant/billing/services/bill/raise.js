// Listing, raising and adjusting bills, and registering a print.
// Part of bill.service.js, which re-exports these for its callers.

const billRepository = require("../../repositories/bill.repository");
const orderRepository = require("../../../orders/repositories/order.repository");
const restaurantRepository = require("../../../setup/repositories/restaurant.repository");
const businessDayRepository = require("../../../business-day/repositories/businessDay.repository");
const loyaltyService = require("../../../crm/services/loyalty.service");
const { numberSeries } = require("../../../setup/repositories/restaurant.repository");
const { priceBill } = require("../billPricing");
const AppError = require("../../../../../utils/AppError");
const { round2 } = require("../../../../../utils/money");
const { COMPLIMENTARY_REASONS, DISCOUNT_REASONS, n, requireRestaurantId, toBill, withoutPayments } = require("./shape");
const { couponForPricing, resolveCoupon, resolveLoyalty } = require("./offers");
const { billedLine, businessDateOf, outletOf, overLimitError, requireAccountRoom, serviceChargeTypes } = require("./rules");

// ------------------------------------------------------------------ reads

const list = async (restaurantId, filters, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);

  // { items, total } rather than a bare array. `total` is how many match the
  // filter, which may be more than were sent, so the screen can say so.
  // Without sales.view or payments.manage: today's bills only (bills of a
  // business day open now), whatever dates were asked for.
  const limited = Boolean(ctx.limited);
  const { rows, total } = await billRepository.findAll(restaurantId, {
    ...filters,
    ...(limited ? { from: null, to: null, businessDayId: filters.businessDayId || null, openDayOnly: true } : {}),
    outletId: outletOf(ctx) || filters.outletId || null,
    timezone: settings.timezone,
  });

  return {
    items: rows.map((row) => (limited ? withoutPayments(toBill(row, ctx)) : toBill(row, ctx))),
    todayOnly: limited,
    total,
    limit: filters.limit || 100,
    page: filters.page || 1,
    pageSize: filters.pageSize || null,
  };
};

const getById = async (restaurantId, id, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const row = await billRepository.findById(restaurantId, id, outletOf(ctx));

  if (!row) {
    throw new AppError(404, "Bill not found");
  }

  // Without sales.view or payments.manage: a bill of a day open now (the
  // table's bill to print or show the guest), never an older one.
  if (ctx.limited) {
    const day = row.business_day_id ? await businessDayRepository.findById(restaurantId, row.business_day_id) : null;

    if (!day || day.day_status !== "open") {
      throw new AppError(404, "Bill not found. Your role sees only today's bills.");
    }
  }

  // The guest's points on this bill, for the receipt: earned, and the
  // balance they had right after it.
  const points = row.customer_id
    ? await loyaltyService.billPoints(restaurantId, row.id)
    : { pointsEarned: 0, pointsTakenBack: 0, pointsBalance: null };

  const bill = { ...toBill(row, ctx), ...points };

  return ctx.limited ? withoutPayments(bill) : bill;
};

// The bill header, for the routes that check a bill before acting on it.
const findInScope = async (restaurantId, id, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const row = await billRepository.findHeader(restaurantId, id, outletOf(ctx));

  if (!row) {
    throw new AppError(404, "Bill not found");
  }

  return row;
};

const findOrderInScope = async (restaurantId, orderId, ctx) => {
  const order = await orderRepository.findById(restaurantId, orderId);
  const pinned = outletOf(ctx);

  if (!order || (pinned && Number(order.outlet_id) !== Number(pinned))) {
    throw new AppError(404, "Order not found");
  }

  return order;
};

// What is still unbilled on an order.
const billableItems = async (restaurantId, orderId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const order = await findOrderInScope(restaurantId, orderId, ctx);
  const rows = await billRepository.findBillableItems(null, restaurantId, orderId);

  return {
    orderId: order.id,
    orderNumber: order.order_number,
    orderStatus: order.order_status,
    items: rows.map((row) => ({
      orderItemId: row.id,
      itemName: row.item_name,
      variantName: row.variant_name,
      quantity: Number(row.quantity),
      billedQuantity: Number(row.billed_quantity),
      remainingQuantity: round2(row.remaining_quantity),
      unitPrice: Number(row.unit_price),
      lineTotal: Number(row.line_total),
    })),
  };
};

// ------------------------------------------------------------------ raising a bill

// Turns an open order into a bill. Every figure is worked out here from the
// order's own lines (services/billPricing), never taken from the request.
const createForOrder = async (restaurantId, data, userId, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const order = await findOrderInScope(restaurantId, data.orderId, ctx);

  if (order.order_status !== "open") {
    throw new AppError(409, `A ${order.order_status} order cannot be billed`);
  }

  if (order.items.filter((item) => item.item_status !== "cancelled").length === 0) {
    throw new AppError(400, "This order has no items");
  }

  // Either bill everything that is left, or only the lines chosen for a split.
  const billable = await billRepository.findBillableItems(null, restaurantId, order.id);
  const wanted = data.items && data.items.length > 0 ? data.items : null;
  const lines = [];

  for (const row of billable) {
    const remaining = round2(row.remaining_quantity);

    if (remaining <= 0) {
      continue;
    }

    const chosen = wanted ? wanted.find((item) => Number(item.orderItemId) === Number(row.id)) : null;

    if (wanted && !chosen) {
      continue;
    }

    const quantity = chosen ? round2(chosen.quantity) : remaining;

    if (quantity <= 0) {
      continue;
    }

    if (quantity > remaining + 0.0001) {
      throw new AppError(400, `Only ${remaining} of "${row.item_name}" is left to bill`);
    }

    lines.push(billedLine(row, quantity));
  }

  if (lines.length === 0) {
    throw new AppError(400, "Nothing is left to bill on this order");
  }

  const outletId = order.outlet_id || ctx.outletId || null;
  const settings = await restaurantRepository.findSettings(restaurantId, outletId);
  const day = order.business_day_id
    ? await businessDayRepository.findById(restaurantId, order.business_day_id)
    : await businessDayRepository.findOpen(restaurantId, outletId);
  const date = day ? day.business_date : (await businessDateOf(restaurantId, settings)).date;
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineSubtotal, 0));
  const coupon = await resolveCoupon(restaurantId, data.discountCode, {
    subtotal,
    orderType: order.order_type,
    businessDate: date,
    lines,
    customerId: order.customer_id,
    timezone: settings.timezone,
  });
  const loyalty = await resolveLoyalty(restaurantId, order.customer_id, settings, data.loyaltyPoints);

  // Own delivery's trip charge, worked out on the order (the sales channel's
  // charge and its "free above"), goes on the order's first bill only: a
  // delivery split over two bills is one trip.
  const deliveryCharge =
    order.order_type === "delivery" && !(await billRepository.deliveryChargedElsewhere(restaurantId, order.id))
      ? n(order.delivery_charge)
      : 0;

  const waived = Boolean(data.serviceCharge && data.serviceCharge.waive);
  const scApplies = serviceChargeTypes(settings).includes(order.order_type);

  if (waived && (!scApplies || Number(settings.service_charge_percentage) <= 0)) {
    throw new AppError(400, "This bill carries no service charge to take off");
  }

  const priced = priceBill({
    lines,
    coupon: couponForPricing(coupon),
    loyalty,
    serviceChargePercentage: scApplies && !waived ? Number(settings.service_charge_percentage) : 0,
    deliveryCharge,
  });

  // The most points one bill may use (Discounts & offers → Loyalty points).
  loyaltyService.assertRedeemAllowed(settings, priced, loyalty ? loyalty.points : 0);

  const isSplit = Boolean(wanted) || lines.length < billable.filter((row) => row.remaining_quantity > 0).length;
  // The bill belongs to the outlet the order was placed at, whichever outlet
  // the person billing has chosen on their screen.
  const outletGstin = outletId ? await restaurantRepository.findOutletGstin(restaurantId, outletId) : null;
  // INV-0042, or with numbers that restart each financial year INV/26-27/0042
  // (by the business date, so a night past midnight on 31 March is still the
  // old year).
  const series = numberSeries(settings.invoice_prefix, settings, date);

  const result = await billRepository.create(
    restaurantId,
    {
      orderId: order.id,
      outletId,
      businessDayId: order.business_day_id || (day && day.id) || null,
      invoicePrefix: series.prefix,
      invoiceSeparator: series.separator,
      sellerGstin: outletGstin || settings.gst_number || null,
      // The outlet's own FSSAI licence where it has one, else the
      // restaurant's (findSettings with the outlet), kept on the bill.
      sellerFssai: settings.fssai_number || null,
      taxMode: settings.tax_mode,
      receiptSettings: {
        documentType: settings.document_type || 'auto',
        receiptLogoPath: settings.receipt_logo_path || null,
        compositionNote: settings.composition_note || null,
        // "Print the table's ordering QR", as it was when the bill was raised:
        // a reprint follows the bill, not today's switch.
        printShowQr: Boolean(settings.print_show_qr),
      },
      discountId: coupon ? coupon.id : null,
      discountCode: coupon ? coupon.code : null,
      priced,
      lines,
      serviceChargeWaived: waived,
      waiveReason: waived ? data.serviceCharge.reason : null,
      consumeStock: settings.auto_consume_stock,
      customerId: order.customer_id,
      tableId: order.table_id,
      isSplit,
    },
    userId
  );

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Order not found");
  }

  if (result.error === "NOT_OPEN") {
    throw new AppError(409, `A ${result.status} order cannot be billed`);
  }

  if (result.error === "NOTHING_LEFT") {
    throw new AppError(409, "Part of this order was billed a moment ago. Open the order again and bill what is left.");
  }

  if (result.error === "COUPON_LIMIT") {
    throw new AppError(400, "That offer has reached its usage limit");
  }

  return getById(restaurantId, result.billId, ctx);
};

// ------------------------------------------------------------------ changing a bill

const sameDiscount = (a, b) =>
  (!a && !b) || (a && b && a.type === b.type && Math.abs(Number(a.value) - Number(b.value)) < 0.001);

const itemDiscountMap = (list) =>
  new Map((list || []).map((row) => [Number(row.orderItemId), { type: row.type, value: Number(row.value) }]));

const sameItemDiscounts = (a, b) =>
  a.size === b.size && [...a.entries()].every(([id, value]) => sameDiscount(value, b.get(id)));

// Works out what a change to an unsettled bill would make it, and what it
// needs to be allowed — without changing anything. The controller asks for
// the approval this names before `adjust` writes it.
//
// input (every key optional; a key left out keeps what the bill has):
//   discountCode      a coupon, or null to take it off
//   loyaltyPoints     points to use, 0 or null for none
//   manualDiscount    { type: "percentage" | "amount", value } or null
//   itemDiscounts     [{ orderItemId, type, value }] — the whole set
//   discountReason, discountNote
//   serviceCharge     { waive: true, reason } or { waive: false }
//   deliveryCharge    { waive: true, reason } or { waive: false } — own
//                     delivery's trip charge taken off (or put back); on its
//                     own, since it needs its own permission
//   complimentary     { reason, note } — the bill becomes no-charge
//
// tx: { client, settings } when run inside the transaction that holds the
// bill (adjust): every read goes through that client, and the settings were
// read before it began (reading them upserts their row, which must not be
// held locked for the rest of the transaction).
const planAdjust = async (restaurantId, billId, input, ctx = {}, db = null, locked = null, tx = null) => {
  const conn = tx ? tx.client : undefined;
  const bill = locked || (await findInScope(restaurantId, billId, ctx));

  if (bill.bill_status === "void") {
    throw new AppError(409, "This bill has been voided");
  }

  if (bill.bill_status === "paid") {
    throw new AppError(
      409,
      bill.is_complimentary
        ? "This bill is complimentary and settled; it cannot be changed"
        : "This bill is settled. Give money back with a refund instead."
    );
  }

  const settings = tx && tx.settings ? tx.settings : await restaurantRepository.findSettings(restaurantId);
  const { date } = await businessDateOf(restaurantId, settings, conn);
  const rows = db ? await db(bill) : await billRepository.findLinesForPricing(bill.id);
  const lines = rows.map((row) => billedLine(row, n(row.quantity)));
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineSubtotal, 0));
  const held = round2(n(bill.paid_amount) - n(bill.refunded_amount));
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);

  // What the bill has now, and what it would have.
  const currentManual = bill.manual_discount_type
    ? { type: bill.manual_discount_type, value: n(bill.manual_discount_value) }
    : null;
  const currentItems = new Map(
    rows
      .filter((row) => row.item_discount_type)
      .map((row) => [Number(row.order_item_id), { type: row.item_discount_type, value: n(row.item_discount_value) }])
  );

  const complimentary = has("complimentary") ? Boolean(input.complimentary) : Boolean(bill.is_complimentary);
  const manual = complimentary ? null : has("manualDiscount") ? input.manualDiscount : currentManual;
  const itemDiscounts = complimentary ? new Map() : has("itemDiscounts") ? itemDiscountMap(input.itemDiscounts) : currentItems;

  for (const id of itemDiscounts.keys()) {
    if (!lines.some((line) => line.orderItemId === id)) {
      throw new AppError(400, "A dish discount names a dish that is not on this bill");
    }
  }

  const code = complimentary ? null : has("discountCode") ? input.discountCode || null : bill.discount_code;
  const coupon = await resolveCoupon(restaurantId, code, {
    subtotal,
    orderType: bill.order_type,
    businessDate: date,
    alreadyOnBill: bill.discount_id,
    lines,
    customerId: bill.customer_id,
    billId: bill.id,
    timezone: settings.timezone,
    db: conn,
  });

  // The delivery charge: what the bill carries, taken off, or put back (the
  // order's own charge, on the bill that carries the order's trip).
  const dcWaived = has("deliveryCharge") ? Boolean(input.deliveryCharge && input.deliveryCharge.waive) : Boolean(bill.delivery_charge_waived);
  const dcFull = bill.delivery_charge_waived ? n(bill.order_delivery_charge) : n(bill.delivery_charge);
  let dcReason = bill.delivery_charge_waive_reason || null;

  if (has("deliveryCharge")) {
    if (Object.keys(input).length > 1) {
      throw new AppError(400, "Take off (or put back) the delivery charge on its own, then make the other change");
    }

    if (bill.order_type !== "delivery" || (dcFull <= 0 && !bill.delivery_charge_waived)) {
      throw new AppError(400, "This bill carries no delivery charge");
    }

    if (dcWaived === Boolean(bill.delivery_charge_waived)) {
      throw new AppError(409, dcWaived ? "The delivery charge is already off this bill" : "The delivery charge is already on this bill");
    }

    if (!dcWaived && (await billRepository.deliveryChargedElsewhere(restaurantId, bill.order_id, bill.id, conn))) {
      throw new AppError(409, "Another bill of this order already carries its delivery charge");
    }

    dcReason = dcWaived ? String((input.deliveryCharge && input.deliveryCharge.reason) || "").trim() || null : null;

    if (dcWaived && !dcReason) {
      throw new AppError(400, "Say why the delivery charge is taken off (a regular, a late delivery…)");
    }
  }

  const deliveryCharge = complimentary || dcWaived ? 0 : dcFull;
  const points = complimentary ? 0 : has("loyaltyPoints") ? Number(input.loyaltyPoints || 0) : n(bill.loyalty_points_used);
  const loyalty =
    points > 0 ? await resolveLoyalty(restaurantId, bill.customer_id, settings, points, n(bill.loyalty_points_used), conn) : null;

  const waived = has("serviceCharge") ? Boolean(input.serviceCharge && input.serviceCharge.waive) : Boolean(bill.service_charge_waived);
  const scApplies = serviceChargeTypes(settings).includes(bill.order_type);
  // A bill keeps the rate it was raised with; one that had none (declined,
  // or put back on) takes today's setting.
  const scPercent = n(bill.service_charge_percentage) > 0 ? n(bill.service_charge_percentage) : scApplies ? n(settings.service_charge_percentage) : 0;

  if (has("serviceCharge") && waived && scPercent <= 0) {
    throw new AppError(400, "This bill carries no service charge to take off");
  }

  const priced = priceBill({
    lines,
    itemDiscounts,
    coupon: couponForPricing(coupon),
    manualDiscount: manual,
    loyalty,
    serviceChargePercentage: waived ? 0 : scPercent,
    deliveryCharge,
    complimentary,
  });

  // The most points one bill may use, checked on the bill as it would be
  // (another discount can shrink what a share of it allows).
  loyaltyService.assertRedeemAllowed(settings, priced, loyalty ? loyalty.points : 0);

  // Reasons: asked for (and checked) before anyone is asked for a PIN.
  const tillChanged = !complimentary && (!sameDiscount(manual, currentManual) || !sameItemDiscounts(itemDiscounts, currentItems));
  let reason = bill.discount_reason || null;
  let note = bill.discount_note || null;

  if (priced.tillAmount <= 0) {
    reason = null;
    note = null;
  } else if (tillChanged || has("discountReason")) {
    reason = input.discountReason || null;
    note = input.discountNote || null;

    if (!reason) {
      throw new AppError(400, "Pick a reason for the discount");
    }

    if (!DISCOUNT_REASONS[reason]) {
      throw new AppError(400, `"${reason}" is not one of the discount reasons`);
    }

    if (reason === "other" && !note) {
      throw new AppError(400, "Write a note saying why, when the reason is Other");
    }
  }

  const compReason = complimentary && !bill.is_complimentary ? (input.complimentary || {}).reason || null : bill.complimentary_reason;
  const compNote = complimentary && !bill.is_complimentary ? (input.complimentary || {}).note || null : bill.complimentary_note;

  if (complimentary && !bill.is_complimentary) {
    if (!compReason) {
      throw new AppError(400, "Pick a reason for making the bill no-charge");
    }

    if (!COMPLIMENTARY_REASONS[compReason]) {
      throw new AppError(400, `"${compReason}" is not one of the no-charge reasons`);
    }

    if (compReason === "other" && !compNote) {
      throw new AppError(400, "Write a note saying why, when the reason is Other");
    }

    if (held > 0.009) {
      throw new AppError(409, `${held} is already paid on this bill. Give it back first, then make it no-charge.`);
    }
  }

  const waiveReason = has("serviceCharge") ? (waived ? (input.serviceCharge.reason || "").trim() || null : null) : bill.service_charge_waive_reason;

  if (waived && !waiveReason) {
    throw new AppError(400, "Say why the service charge is taken off (the guest's reason)");
  }

  if (priced.totalAmount + 0.009 < held) {
    throw new AppError(
      409,
      `${held} is already paid on this bill, so it cannot come to ${priced.totalAmount}. Give the difference back first.`
    );
  }

  // A bill on a guest's or company's account may not come to owe more than
  // the account's limit allows — a discount taken off is credit given too.
  await requireAccountRoom(restaurantId, bill, billRepository.dueAt(bill, priced.totalAmount), "This change", conn || null);

  // What it needs, in the facts a manager's approval is tied to.
  let needs = null;

  if (complimentary && !bill.is_complimentary) {
    needs = { permission: "bills.complimentary", scope: { billId: bill.id, amount: subtotal } };
  } else if (has("deliveryCharge") && dcWaived) {
    // Its own right (the order screens use the same one): a manager, or a
    // manager's PIN tied to this bill and this much.
    needs = { permission: "orders.waive_delivery_charge", scope: { billId: bill.id, amount: dcFull } };
  } else if (tillChanged && priced.tillAmount > 0) {
    needs = {
      permission: "bills.discount",
      scope: { billId: bill.id, percent: priced.tillPercent, amount: priced.tillAmount },
      percent: priced.tillPercent,
    };
  } else if (n(bill.print_count) > 0 && priced.totalAmount < n(bill.total_amount) - 0.005) {
    // The guest already holds this bill on paper. Lowering it now is the
    // classic till theft (print, take the cash, discount, pocket the
    // difference), so it takes the discount permission or a manager.
    needs = {
      permission: "bills.discount",
      scope: { billId: bill.id, amount: round2(n(bill.total_amount) - priced.totalAmount) },
    };
  }

  return {
    bill,
    lines: rows,
    priced,
    coupon,
    needs,
    tillChanged,
    changes: {
      complimentary,
      complimentaryReason: compReason,
      complimentaryNote: compNote,
      manualDiscountType: manual && priced.manualDiscountAmount > 0 ? manual.type : null,
      manualDiscountValue: manual && priced.manualDiscountAmount > 0 ? Number(manual.value) : null,
      discountReason: reason,
      discountNote: note,
      serviceChargeWaived: waived && scPercent > 0,
      waiveReason,
      deliveryChargeWaived: dcWaived,
      deliveryWaiveReason: dcWaived ? dcReason : null,
      deliveryChargeTouched: has("deliveryCharge"),
      deliveryChargeFull: dcFull,
    },
  };
};

// Applies a change planned (and allowed) above. It is worked out again with
// the bill locked, so two tills changing one bill at once cannot mix.
//
// who: { userId, approverId } — who made the change and who approved it.
const adjust = async (restaurantId, billId, input, who, ctx = {}) => {
  requireRestaurantId(restaurantId);

  let plan = null;
  // Read before the bill is locked (see planAdjust's tx).
  const settings = await restaurantRepository.findSettings(restaurantId);

  const result = await billRepository.reprice(
    restaurantId,
    billId,
    outletOf(ctx),
    async (client, locked) => {
      plan = await planAdjust(
        restaurantId,
        billId,
        input,
        ctx,
        () => billRepository.findLinesForPricing(locked.id, client),
        locked,
        { client, settings }
      );

      const discountTouched = plan.tillChanged;

      return {
        priced: plan.priced,
        discountId: plan.coupon ? plan.coupon.id : null,
        discountCode: plan.coupon ? plan.coupon.code : null,
        changes: {
          ...plan.changes,
          discountGivenBy: plan.priced.tillAmount > 0 ? (discountTouched ? who.userId : locked.discount_given_by) : null,
          discountApprovedBy:
            plan.priced.tillAmount > 0 ? (discountTouched ? who.approverId || null : locked.discount_approved_by) : null,
          complimentaryBy: plan.changes.complimentary ? (locked.is_complimentary ? locked.complimentary_by : who.userId) : null,
          complimentaryApprovedBy: plan.changes.complimentary
            ? locked.is_complimentary
              ? locked.complimentary_approved_by
              : who.approverId || null
            : null,
          deliveryWaivedBy: plan.changes.deliveryChargeWaived
            ? plan.changes.deliveryChargeTouched
              ? who.userId
              : locked.delivery_charge_waived_by
            : null,
          deliveryApprovedBy: plan.changes.deliveryChargeWaived
            ? plan.changes.deliveryChargeTouched
              ? who.approverId || null
              : locked.delivery_charge_approved_by
            : null,
        },
      };
    },
    who.userId
  );

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Bill not found");
  }

  if (result.error === "COUPON_LIMIT") {
    throw new AppError(400, "That offer has reached its usage limit");
  }

  if (result.error === "NOT_ENOUGH_POINTS") {
    throw new AppError(400, `The guest has only ${result.balance} points left`);
  }

  if (result.error === "OVER_LIMIT") {
    throw overLimitError(result, "This change");
  }

  if (result.error === "BUSY") {
    throw new AppError(409, "This bill was changed at another till a moment ago. Open it again and retry.");
  }

  return { before: result.before, plan, bill: await getById(restaurantId, billId, ctx) };
};

// Every print is counted. `firstOnly`: count it only if it is the first.
const registerPrint = async (restaurantId, billId, { firstOnly = false } = {}, ctx = {}) => {
  requireRestaurantId(restaurantId);

  const printed = await billRepository.recordPrint(restaurantId, billId, outletOf(ctx), firstOnly);

  if (!printed) {
    return null;
  }

  const bill = await getById(restaurantId, billId, ctx);

  return { ...bill, copy: bill.printCount > 1 ? "duplicate" : "original" };
};

module.exports = {
  list,
  getById,
  findInScope,
  billableItems,
  createForOrder,
  planAdjust,
  adjust,
  registerPrint,
};
