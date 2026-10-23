const deliveryRepository = require("../repositories/delivery.repository");
const salesChannelRepository = require("../repositories/salesChannel.repository");
const orderRepository = require("../../orders/repositories/order.repository");
const outletRepository = require("../../setup/repositories/outlet.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const tradingDay = require("../../business-day/services/tradingDay");
const AppError = require("../../../../utils/AppError");
const guestAddressRepository = require("../../online/repositories/guestAddress.repository");
const { round2 } = require("../../../../utils/money");
const { maskMobile } = require("../../../../utils/phone");
const ruleSettings = require("../../setup/services/ruleSettings.service");

const DUPLICATE = "23505";

// One rider, one bag: more than this in one run is a mistake, not a plan.
const MAX_RUN = 12;

const STATUS_LABELS = {
  pending: "new",
  preparing: "being prepared",
  ready: "ready at the pass",
  out_for_delivery: "out for delivery",
  delivered: "delivered",
  cancelled: "cancelled",
};

const PRE_DISPATCH = ["pending", "preparing", "ready"];

const ORDER_TYPE_LABELS = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  qr: "QR table orders",
  online: "Online (other)",
  delivery: "Delivery",
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const minutesBetween = (from, to) =>
  from && to ? Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000)) : null;

const average = (values) =>
  values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

const toChannelRef = (row) =>
  row.channel_id
    ? {
        id: row.channel_id,
        name: row.channel_name,
        type: row.channel_type,
        color: row.channel_color,
        status: row.channel_status,
      }
    : null;

// One delivery order as the board and the edit form see it.
const toDelivery = (row) => {
  const status = row.effective_status;
  const billed = row.bill_count > 0;
  const amount = billed ? Number(row.bill_total) : Number(row.order_total);
  const paid = billed ? Number(row.paid_total) : 0;
  const due = Math.max(0, round2(amount - paid));
  const reachedReady = ["ready", "out_for_delivery", "delivered"].includes(status);
  const placedAt = new Date(row.placed_at);

  let paymentState = "to_collect";

  if (!billed) {
    paymentState = "not_billed";
  } else if (due <= 0) {
    paymentState = "paid";
  } else if (paid > 0) {
    paymentState = "part_paid";
  }

  return {
    id: row.id,
    orderNumber: row.order_number,
    orderType: row.order_type,
    orderStatus: row.order_status,
    kitchenStatus: row.kitchen_status,
    // Tickets the kitchen display still shows as new or cooking.
    kitchenOpenTickets: Number(row.kitchen_open_tickets || 0),
    source: row.source,
    businessDayId: row.business_day_id,
    status,
    storedStatus: row.delivery_status,
    customerId: row.customer_id,
    customerName: row.customer_name || row.linked_customer_name || null,
    customerMobile: row.customer_mobile,
    address: row.delivery_address,
    landmark: row.delivery_landmark,
    notes: row.notes,
    channel: toChannelRef(row),
    commissionPercent:
      row.channel_commission_percent !== null && row.channel_commission_percent !== undefined
        ? Number(row.channel_commission_percent)
        : row.channel_current_percent !== null && row.channel_current_percent !== undefined
          ? Number(row.channel_current_percent)
          : null,
    rider: row.rider_employee_id
      ? { id: row.rider_employee_id, name: row.rider_name, mobile: row.rider_mobile }
      : null,
    partnerRiderName: row.partner_rider_name,
    externalRef: row.external_order_ref,
    etaMinutes: row.delivery_eta_minutes,
    promisedBy: row.delivery_eta_minutes
      ? new Date(placedAt.getTime() + row.delivery_eta_minutes * 60000).toISOString()
      : null,
    placedAt: row.placed_at,
    preparingAt: row.delivery_preparing_at || row.kitchen_started_at || null,
    readyAt: reachedReady ? row.delivery_ready_at || row.kitchen_ready_at || null : null,
    dispatchedAt: ["out_for_delivery", "delivered"].includes(status) ? row.dispatched_at : null,
    deliveredAt: status === "delivered" ? row.delivered_at : null,
    cancelledAt: status === "cancelled" ? row.delivery_cancelled_at || null : null,
    cancelReason:
      status === "cancelled" ? row.delivery_cancel_reason || row.cancel_reason || null : null,
    doorMinutes: status === "delivered" ? minutesBetween(row.placed_at, row.delivered_at) : null,
    rideMinutes: status === "delivered" ? minutesBetween(row.dispatched_at, row.delivered_at) : null,
    itemCount: Number(row.item_count || 0),
    items: (row.items || []).map((item) => ({
      name: item.name,
      variant: item.variant,
      quantity: Number(item.quantity),
      notes: item.notes,
    })),
    amount,
    billed,
    billId: row.first_bill_id || null,
    billNumbers: row.bill_numbers || null,
    paidAmount: paid,
    dueAmount: due,
    paymentState,
    paymentMethods: row.payment_methods ? row.payment_methods.split(",") : [],
    // Taken on an earlier trading day and still on the live board (a run or
    // an order nobody closed).
    earlierDay: row.earlier_day === true,
  };
};

const toChannel = (row) => ({
  id: row.id,
  name: row.name,
  type: row.channel_type,
  commissionPercent: Number(row.commission_percent),
  deliveryCharge: Number(row.delivery_charge || 0),
  deliveryFreeAbove: row.delivery_free_above === null || row.delivery_free_above === undefined ? null : Number(row.delivery_free_above),
  color: row.color,
  sortOrder: row.sort_order,
  status: row.status,
  ordersTotal: row.orders_total || 0,
  ordersToday: row.orders_today || 0,
  orders30d: row.orders_30d || 0,
  gross30d: Number(row.gross_30d || 0),
});

// ---------------------------------------------------------------- the board

// Riders are worked out from the board's own orders, so the panel and the
// columns can never disagree about who is carrying what.
// A run out longer than this was never closed (3 hours).
const RUN_NOT_CLOSED_MINUTES = 180;

const buildRiders = (riderRows, orders, isToday, now) =>
  riderRows.map((row) => {
    const mine = orders.filter((order) => order.rider && order.rider.id === row.id);
    const out = mine.filter((order) => order.status === "out_for_delivery");
    const waiting = mine.filter((order) => PRE_DISPATCH.includes(order.status));
    const delivered = mine.filter((order) => order.status === "delivered" && isToday(order));
    const handIn = mine.filter((order) => order.status === "delivered" && order.paymentState !== "paid");
    // Compared as instants: pg hands back Date objects, whose default sort
    // is by their text ("Thu…" before "Wed…"), not by time.
    const earliest = (dates) =>
      dates.filter(Boolean).reduce((min, date) => (!min || new Date(date) < new Date(min) ? date : min), null);
    const latest = (dates) =>
      dates.filter(Boolean).reduce((max, date) => (!max || new Date(date) > new Date(max) ? date : max), null);

    const runStartedAt = earliest(out.map((order) => order.dispatchedAt));
    const lastBack = latest(delivered.map((order) => order.deliveredAt));

    return {
      id: row.id,
      name: row.name,
      mobile: row.mobile,
      code: row.employee_code,
      designation: row.designation,
      active: row.status === "active",
      clockedInAt: row.check_in || null,
      clockedOutAt: row.check_out || null,
      state: out.length > 0 ? "on_run" : "free",
      runStartedAt,
      runMinutes: runStartedAt ? minutesBetween(runStartedAt, now) : null,
      // Out longer than any real run: almost surely delivered (or brought
      // back) without anyone marking it. The desk is asked to close it.
      runNotClosed: Boolean(runStartedAt && minutesBetween(runStartedAt, now) > RUN_NOT_CLOSED_MINUTES),
      outNow: out.map((order) => ({ id: order.id, orderNumber: order.orderNumber })),
      assigned: waiting.map((order) => ({ id: order.id, orderNumber: order.orderNumber })),
      deliveredToday: delivered.length,
      avgRideMinutes: average(
        delivered.map((order) => order.rideMinutes).filter((value) => value !== null)
      ),
      lastDeliveredAt: lastBack,
      cashToCollect: round2(
        out.reduce((sum, order) => sum + (order.paymentState === "paid" ? 0 : order.dueAmount), 0)
      ),
      // Back from the door, not yet paid in: what "Settle cash" takes.
      // Earlier days' are in the settle dialog too.
      deliveredUnpaid: handIn.length,
      cashToHandIn: round2(handIn.reduce((sum, order) => sum + order.dueAmount, 0)),
    };
  });

// withMoney: sales and cash figures only for someone who may read reports.
// The counts and clocks are the same for everyone at the desk.
const buildStats = (orders, isToday, now, withMoney, rules = ruleSettings.DEFAULTS) => {
  const sla = rules.deliverySlaMinutes;
  const today = orders.filter(isToday);
  const pre = orders.filter((order) => PRE_DISPATCH.includes(order.status));
  const out = orders.filter((order) => order.status === "out_for_delivery");
  const delivered = today.filter((order) => order.status === "delivered");
  const timed = delivered.filter((order) => order.doorMinutes !== null);
  const onTime = timed.filter((order) => order.doorMinutes <= sla);
  const live = [...pre, ...out];
  // Late is tonight's problem: an order left on the board from an earlier
  // day is counted apart (earlierInPlay), not as "running late".
  const tonight = (order) => !order.earlierDay;
  const unpaidDelivered = delivered.filter((order) => order.paymentState !== "paid");

  return {
    // Tonight's only: one left on the board from an earlier day is in
    // earlierInPlay (and toDispatchEarlier), not in tonight's count.
    toDispatch: pre.filter(tonight).length,
    toDispatchEarlier: pre.filter((order) => !tonight(order)).length,
    pending: pre.filter((order) => order.status === "pending").length,
    preparing: pre.filter((order) => order.status === "preparing").length,
    ready: pre.filter((order) => order.status === "ready").length,
    readyTooLong: pre.filter(
      (order) =>
        order.status === "ready" &&
        order.readyAt &&
        minutesBetween(order.readyAt, now) > rules.deliveryReadyWaitMinutes
    ).length,
    withoutRider: pre.filter((order) => !order.rider && !order.partnerRiderName).length,
    outNow: out.length,
    ridersOut: new Set(out.filter((order) => order.rider).map((order) => order.rider.id)).size,
    partnerOut: out.filter((order) => !order.rider).length,
    deliveredToday: delivered.length,
    cancelledToday: today.filter((order) => order.status === "cancelled").length,
    avgDoorMinutes: average(timed.map((order) => order.doorMinutes)),
    timedCount: timed.length,
    onTimeCount: onTime.length,
    onTimeRate: timed.length ? Math.round((onTime.length / timed.length) * 100) : null,
    lateNow: live.filter((order) => tonight(order) && minutesBetween(order.placedAt, now) > sla).length,
    lateOut: out.filter((order) => tonight(order) && minutesBetween(order.placedAt, now) > sla).length,
    lateWaiting: pre.filter((order) => tonight(order) && minutesBetween(order.placedAt, now) > sla).length,
    earlierInPlay: live.filter((order) => !tonight(order)).length,
    cashWithRiders: withMoney
      ? round2(out.reduce((sum, order) => sum + (order.paymentState === "paid" ? 0 : order.dueAmount), 0))
      : null,
    deliveredUnsettled: withMoney
      ? round2(unpaidDelivered.reduce((sum, order) => sum + order.dueAmount, 0))
      : null,
    deliveredUnsettledCount: unpaidDelivered.length,
    salesToday: withMoney
      ? round2(
          today
            .filter((order) => order.status !== "cancelled")
            .reduce((sum, order) => sum + order.amount, 0)
        )
      : null,
    ordersToday: today.filter((order) => order.status !== "cancelled").length,
  };
};

// By evening most of the board is finished orders, and the whole board goes
// out every 15 seconds. A finished card needs only what it shows and what the
// search box looks through; its item list, kitchen state and the rest come
// with the order itself (GET /:orderId) when someone opens or prints it.
const FINISHED = ["delivered", "cancelled"];

const SUMMARY_FIELDS = [
  "id",
  "orderNumber",
  "orderStatus",
  "status",
  "channel",
  "customerName",
  "customerMobile",
  "address",
  "landmark",
  "externalRef",
  "rider",
  "partnerRiderName",
  "placedAt",
  "itemCount",
  "amount",
  "billed",
  "dueAmount",
  "paymentState",
  "paymentMethods",
];

// `revealContacts`: whether the person may see guests' full numbers
// (customers.contact). Without it every card on the board shows the last four
// digits ("XXXXXX0491"), deliveries still on the way included: a day's board
// is otherwise a list of every customer's number, read by anyone at the desk.
// The number is still there for the one delivery that needs a call — the
// gate is locked, the address is wrong: opening that delivery (getOne, the
// card's Call button and the printed slip) gives it in full, the same rule
// as opening one order or one booking.
const toSummary = (order, revealContacts = true) => {
  const summary = { summary: true, items: [] };

  for (const key of SUMMARY_FIELDS) {
    summary[key] = order[key];
  }

  if (!revealContacts && summary.customerMobile) {
    summary.customerMobile = maskMobile(summary.customerMobile);
  }

  if (order.status === "delivered") {
    Object.assign(summary, {
      dispatchedAt: order.dispatchedAt,
      deliveredAt: order.deliveredAt,
      doorMinutes: order.doorMinutes,
      rideMinutes: order.rideMinutes,
    });
  } else {
    Object.assign(summary, { cancelledAt: order.cancelledAt, cancelReason: order.cancelReason });
  }

  return summary;
};

// `date` (YYYY-MM-DD): the board of an earlier business date instead of the
// live one — every delivery filed on that date's days, whatever became of it,
// so one never marked delivered can still be closed. Without it, the board is
// today's: the open business day(s) only.
const board = async (restaurantId, { outletId, withMoney = false, revealContacts = true, date = null } = {}) => {
  requireRestaurantId(restaurantId);
  await salesChannelRepository.ensureDefaults(restaurantId);

  const openDays = await deliveryRepository.findOpenDays(restaurantId, outletId);
  const days = date ? await deliveryRepository.findDaysOn(restaurantId, date, outletId) : openDays;
  const dayIds = days.map((day) => day.id);
  const found = await deliveryRepository.findBoard(restaurantId, { outletId, dayIds, todayOnly: !date });
  // Read back oldest first, the order every column and figure below expects.
  const orders = found.rows
    .map(toDelivery)
    .sort((a, b) => new Date(a.placedAt) - new Date(b.placedAt));
  const riderIds = [...new Set(orders.filter((order) => order.rider).map((order) => order.rider.id))];

  const [riderRows, channelRows, locale, rules] = await Promise.all([
    deliveryRepository.findRiders(restaurantId, { outletId, includeIds: riderIds }),
    salesChannelRepository.findAll(restaurantId),
    deliveryRepository.findLocale(restaurantId),
    ruleSettings.load(restaurantId),
  ]);

  const now = new Date();
  // The live board's "today" is this trading day: an order of the open day
  // taken on an earlier date (a day left open) is not tonight's.
  const isToday = (order) => dayIds.includes(order.businessDayId) && (Boolean(date) || !order.earlierDay);
  const channels = channelRows.map(toChannel);

  return {
    businessDate: date || (days[0] ? days[0].business_date : null),
    dayOpen: openDays.length > 0,
    // The open day's date, for the date picker's "Today".
    todayDate: openDays[0] ? openDays[0].business_date : null,
    // An earlier date picked: history, not the live board.
    viewingDate: date || null,
    timezone: locale.timezone,
    currency: locale.currency,
    serverTime: now.toISOString(),
    // The restaurant's own timings (Settings -> Alerts and timings). The
    // promise is door to door, from the order placed to the guest's hands
    // (45 minutes is what the aggregators hold a restaurant to). Amber: still
    // on time, but only if it leaves now. Packed food waiting longer for a
    // rider is going cold. A run out past the warning: call the rider.
    slaMinutes: rules.deliverySlaMinutes,
    warnMinutes: rules.deliveryWarnMinutes,
    readyWaitMinutes: rules.deliveryReadyWaitMinutes,
    outWarnMinutes: rules.deliveryOutWarnMinutes,
    outCriticalMinutes: rules.deliveryOutCriticalMinutes,
    showsMoney: withMoney,
    orders: orders.map((order) => {
      if (FINISHED.includes(order.status)) {
        return toSummary(order, revealContacts);
      }

      return revealContacts || !order.customerMobile
        ? order
        : { ...order, customerMobile: maskMobile(order.customerMobile) };
    }),
    totalOrders: found.total,
    shownOrders: orders.length,
    truncated: found.total > orders.length,
    riders: buildRiders(riderRows, orders, isToday, now),
    channels: channels.map((channel) => ({
      ...channel,
      boardCount: orders.filter((order) => order.channel && order.channel.id === channel.id).length,
    })),
    untaggedCount: orders.filter((order) => !order.channel).length,
    stats: buildStats(orders, isToday, now, withMoney, rules),
  };
};

// The board's figures without the cards, for a dashboard tile or a POS
// badge that only needs "3 to dispatch, 2 on the road, 1 late".
const summary = async (restaurantId, { outletId, withMoney = false } = {}) => {
  const full = await board(restaurantId, { outletId, withMoney });

  return {
    businessDate: full.businessDate,
    dayOpen: full.dayOpen,
    currency: full.currency,
    slaMinutes: full.slaMinutes,
    stats: full.stats,
    ridersFree: full.riders.filter((rider) => rider.active && rider.state === "free").length,
    ridersOnRun: full.riders.filter((rider) => rider.state === "on_run").length,
    channels: full.channels
      .filter((channel) => channel.boardCount > 0)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        color: channel.color,
        orders: channel.boardCount,
      })),
  };
};

const getOne = async (restaurantId, orderId) => {
  requireRestaurantId(restaurantId);

  const row = await deliveryRepository.findById(restaurantId, orderId);

  if (!row) {
    throw new AppError(404, "Order not found");
  }

  if (row.order_type !== "delivery") {
    throw new AppError(
      409,
      `${row.order_number} is a ${(ORDER_TYPE_LABELS[row.order_type] || row.order_type).toLowerCase()} order, not a delivery`
    );
  }

  return toDelivery(row);
};

// ---------------------------------------------------------------- checks

const requireDelivery = (row) => {
  if (!row) {
    throw new AppError(404, "Order not found");
  }

  if (row.order_type !== "delivery") {
    throw new AppError(
      409,
      `${row.order_number} is a ${(ORDER_TYPE_LABELS[row.order_type] || row.order_type).toLowerCase()} order, not a delivery`
    );
  }
};

// Anyone we send out must be one of ours, in the delivery team, and working.
const requireRider = async (restaurantId, riderId, db) => {
  const rider = await deliveryRepository.findEmployee(restaurantId, riderId, db);

  if (!rider) {
    throw new AppError(400, "That rider is not on your staff list");
  }

  if (rider.department !== "delivery") {
    throw new AppError(
      400,
      `${rider.name} is not in the delivery team. Move them to the delivery department in Staff first.`
    );
  }

  if (rider.status !== "active") {
    throw new AppError(400, `${rider.name} is marked inactive and cannot take deliveries`);
  }

  return rider;
};

const requireChannel = async (restaurantId, channelId, currentId, db) => {
  const channel = await deliveryRepository.findChannel(restaurantId, channelId, db);

  if (!channel) {
    throw new AppError(400, "That channel does not exist");
  }

  // An order already on a channel that was later switched off keeps it.
  if (channel.status !== "active" && channel.id !== currentId) {
    throw new AppError(
      400,
      `${channel.name} is switched off. Switch it back on in Channels, or pick another channel.`
    );
  }

  return channel;
};

const riderLabel = (row) => row.rider_name || row.partner_rider_name || "the rider";

// Why an order cannot go where it was asked to, in words the desk can use.
const refuse = (row, target) => {
  const current = row.effective_status;
  const number = row.order_number;

  if (current === "cancelled") {
    const reason = row.delivery_cancel_reason || row.cancel_reason;
    return new AppError(409, `${number} was cancelled${reason ? ` (${reason})` : ""} and cannot move on`);
  }

  if (target === current) {
    return new AppError(
      409,
      current === "out_for_delivery"
        ? `${number} is already out with ${riderLabel(row)}`
        : `${number} is already ${STATUS_LABELS[current]}`
    );
  }

  if (target === "delivered") {
    return new AppError(409, `${number} has not left the restaurant yet. Dispatch it with a rider first.`);
  }

  if (target === "cancelled" && current === "delivered") {
    return new AppError(
      409,
      `${number} was already delivered, so it cannot be cancelled. Refund it from Bills if the guest complained.`
    );
  }

  if (current === "delivered") {
    return new AppError(
      409,
      `${number} is already delivered. Mark it "not delivered" first if the food came back.`
    );
  }

  return new AppError(409, `${number} is already ${STATUS_LABELS[current]}`);
};

// ---------------------------------------------------------------- moving on

// Once packed food has left the building, the kitchen display bumps any
// tickets still open for it (the same path "served" from the orders screen
// takes), so the line does not cook a second biryani for a bag already on a
// bike. Only ever called for orders that reached "ready" before they left —
// the kitchen said so, or the desk confirmed it — never for food still new
// or cooking, which cannot be dispatched at all.
const clearKitchen = async (restaurantId, rows, userId) => {
  for (const row of rows) {
    if (row.effective_status === "ready" && row.kitchen_status !== "served" && row.order_status !== "cancelled") {
      await orderRepository.setKitchenStatus(restaurantId, row.id, "served", userId);
    }
  }
};

const plural = (count, one, many) => (count === 1 ? one : many);

// Sends one or more orders out with one rider, inside the caller's lock.
const dispatchLocked = async (client, restaurantId, rows, input, userId) => {
  if (input.riderId && input.partnerRiderName) {
    throw new AppError(400, "Choose one of your riders or type a partner rider's name, not both");
  }

  const rider = input.riderId ? await requireRider(restaurantId, input.riderId, client) : null;

  for (const row of rows) {
    if (!PRE_DISPATCH.includes(row.effective_status)) {
      throw refuse(row, "out_for_delivery");
    }
  }

  // Only packed food leaves. A bag sent out while the kitchen is still
  // cooking it either goes without the food or makes the kitchen cook it
  // twice; the desk marks it packed first (and is asked to be sure when the
  // kitchen display still shows it cooking).
  const notPacked = rows.filter((row) => row.effective_status !== "ready");

  if (notPacked.length > 0) {
    const list = notPacked
      .map((row) => `${row.order_number} (${row.effective_status === "preparing" ? "still cooking" : "not started"})`)
      .join(", ");

    throw new AppError(
      409,
      `Only packed food can go out. ${list} ${plural(notPacked.length, "is", "are")} not packed yet — mark ${plural(
        notPacked.length,
        "it",
        "them"
      )} packed when the bag is at the pass.`
    );
  }

  const unassigned = rows.filter(
    (row) => !rider && !input.partnerRiderName && !row.rider_employee_id && !row.partner_rider_name
  );

  if (unassigned.length > 0) {
    throw new AppError(
      400,
      `Choose a rider for ${unassigned.map((row) => row.order_number).join(", ")} — one of your delivery team, or the partner rider's name for a Swiggy or Zomato pickup`
    );
  }

  // Our own rider needs somewhere to go. A partner rider has the address in
  // their own app, so theirs is not required here.
  const noAddress = rows.filter((row) => {
    const ownRider = rider || (!input.partnerRiderName && row.rider_employee_id);
    return ownRider && !row.delivery_address;
  });

  if (noAddress.length > 0) {
    throw new AppError(
      400,
      `Add the delivery address to ${noAddress.map((row) => row.order_number).join(", ")} before ${
        rider ? rider.name : "the rider"
      } sets off`
    );
  }

  for (const row of rows) {
    // The steps before this one are filled from the kitchen's clock where it
    // has one (the kitchen display said ready, the desk never pressed
    // anything), and left empty where nobody knows — never invented.
    const fields = {
      deliveryStatus: "out_for_delivery",
      dispatchedAt: "now",
      deliveredAt: null,
    };

    if (!row.delivery_ready_at && row.kitchen_ready_at) {
      fields.readyAt = row.kitchen_ready_at;
    }

    if (!row.delivery_preparing_at && row.kitchen_started_at) {
      fields.preparingAt = row.kitchen_started_at;
    }

    if (rider) {
      fields.riderId = rider.id;
      fields.partnerRiderName = null;
    } else if (input.partnerRiderName) {
      fields.partnerRiderName = input.partnerRiderName;
      fields.riderId = null;
    }

    await deliveryRepository.update(restaurantId, row.id, fields, userId, client);
  }

  return rider;
};

// `outletId`: the outlet the desk works in. Another outlet's order is "not
// found", the same as it is on that desk's board.
const dispatchRun = async (restaurantId, input, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const ids = [...new Set(input.orderIds)];

  if (ids.length === 0) {
    throw new AppError(400, "Pick at least one order to send out");
  }

  if (ids.length > MAX_RUN) {
    throw new AppError(400, `One rider can take at most ${MAX_RUN} orders in a run`);
  }

  const result = await deliveryRepository.withLockedOrders(restaurantId, ids, async (client, rows) => {
    if (
      rows.length !== ids.length ||
      (outletId && rows.some((row) => Number(row.outlet_id) !== Number(outletId)))
    ) {
      throw new AppError(404, "One of those orders was not found");
    }

    rows.forEach(requireDelivery);

    const rider = await dispatchLocked(client, restaurantId, rows, input, userId);
    return { rows, rider };
  });

  await clearKitchen(restaurantId, result.rows, userId);

  const fresh = await deliveryRepository.findByIds(restaurantId, ids);

  return {
    orders: fresh.map(toDelivery),
    riderName: result.rider ? result.rider.name : input.partnerRiderName || riderLabel(fresh[0] || {}),
  };
};

const cancelDelivery = async (restaurantId, orderId, reason, userId) => {
  if (!reason) {
    throw new AppError(
      400,
      "Say why the delivery is cancelled — the guest cancelled, the partner cancelled, the address could not be found…"
    );
  }

  // Under the same row lock as every other move, so "Delivered" and "Cancel"
  // pressed together cannot both win: the second one reads what the first did
  // and is refused in words.
  await deliveryRepository.withLockedOrders(restaurantId, [orderId], async (client, rows) => {
    const row = rows[0];
    requireDelivery(row);

    if (["delivered", "cancelled"].includes(row.effective_status)) {
      throw refuse(row, "cancelled");
    }

    // An order with no bill yet is cancelled outright, so the list of open
    // orders and the kitchen both drop it. One that is billed keeps its bill:
    // voiding money is the cashier's call.
    if (row.order_status === "open") {
      await deliveryRepository.cancelOrder(client, restaurantId, row, reason, userId);
    }

    await deliveryRepository.update(
      restaurantId,
      row.id,
      { deliveryStatus: "cancelled", cancelledAt: "now", cancelReason: reason },
      userId,
      client
    );
  });

  const fresh = toDelivery(await deliveryRepository.findById(restaurantId, orderId));

  return {
    delivery: fresh,
    billStillLive: fresh.billed,
  };
};

// Moves one order along the line. Returns the order as it now stands.
const changeStatus = async (restaurantId, orderId, input, userId) => {
  requireRestaurantId(restaurantId);

  if (input.status === "cancelled") {
    return cancelDelivery(restaurantId, orderId, input.reason, userId);
  }

  const outcome = await deliveryRepository.withLockedOrders(
    restaurantId,
    [orderId],
    async (client, rows) => {
      const row = rows[0];
      requireDelivery(row);

      const current = row.effective_status;
      const target = input.status;

      if (target === "out_for_delivery") {
        // Marked delivered by mistake: the food is still on the road, so
        // somebody must be holding it, and it must have a time it left.
        if (current === "delivered") {
          if (input.riderId && input.partnerRiderName) {
            throw new AppError(400, "Choose one of your riders or type a partner rider's name, not both");
          }

          const fields = { deliveryStatus: "out_for_delivery", deliveredAt: null };

          if (input.riderId) {
            fields.riderId = (await requireRider(restaurantId, input.riderId, client)).id;
            fields.partnerRiderName = null;
          } else if (input.partnerRiderName) {
            fields.partnerRiderName = input.partnerRiderName;
            fields.riderId = null;
          } else if (!row.rider_employee_id && !row.partner_rider_name) {
            throw new AppError(
              409,
              `No rider is on record for ${row.order_number}. Pick the rider who has it, then mark it not delivered.`
            );
          }

          if (!row.dispatched_at) {
            throw new AppError(
              409,
              `${row.order_number} has no time on record for when it left — it was closed out without one — so it cannot be put back on the road. Cancel it or leave it delivered.`
            );
          }

          await deliveryRepository.update(restaurantId, row.id, fields, userId, client);
          return { row, undo: true };
        }

        await dispatchLocked(client, restaurantId, [row], input, userId);
        return { row, dispatched: true };
      }

      if (target === "preparing") {
        if (current !== "pending") {
          throw refuse(row, target);
        }

        await deliveryRepository.update(
          restaurantId,
          row.id,
          { deliveryStatus: "preparing", preparingAt: row.delivery_preparing_at || "now" },
          userId,
          client
        );
        return { row };
      }

      if (target === "ready") {
        // Back from the road — the rider never left, or the guest could not
        // be reached and the food came back. The rider stays assigned.
        if (current === "out_for_delivery") {
          await deliveryRepository.update(
            restaurantId,
            row.id,
            { deliveryStatus: "ready", dispatchedAt: null },
            userId,
            client
          );
          return { row, recalled: true };
        }

        if (!["pending", "preparing"].includes(current)) {
          throw refuse(row, target);
        }

        // The kitchen display still has this order on the line. The desk may
        // know better (the cook forgot to bump it), but has to say so: once
        // it is packed it can be dispatched, and dispatching clears those
        // tickets from the kitchen's screen.
        const openTickets = Number(row.kitchen_open_tickets || 0);

        if (openTickets > 0 && !input.confirmPacked) {
          throw new AppError(
            409,
            `The kitchen display still shows ${row.order_number} as ${
              row.kitchen_status === "preparing" ? "cooking" : "not started"
            } (${openTickets} open ${plural(openTickets, "ticket", "tickets")}). Mark it packed only if the bag really is at the pass.`,
            { needsConfirmation: "confirmPacked", openTickets }
          );
        }

        const fields = { deliveryStatus: "ready", readyAt: "now" };

        if (!row.delivery_preparing_at && row.kitchen_started_at) {
          fields.preparingAt = row.kitchen_started_at;
        }

        await deliveryRepository.update(restaurantId, row.id, fields, userId, client);
        return { row };
      }

      // delivered
      if (current !== "out_for_delivery") {
        throw refuse(row, target);
      }

      await deliveryRepository.update(
        restaurantId,
        row.id,
        { deliveryStatus: "delivered", deliveredAt: "now" },
        userId,
        client
      );
      return { row };
    }
  );

  if (outcome.dispatched) {
    await clearKitchen(restaurantId, [outcome.row], userId);
  }

  const fresh = toDelivery(await deliveryRepository.findById(restaurantId, orderId));

  return { delivery: fresh, undo: Boolean(outcome.undo), recalled: Boolean(outcome.recalled) };
};

// Address, landmark, channel, rider, partner reference and promised time —
// everything about a delivery that is not its food or its money. Only the
// fields sent are changed, so the POS can send just what it knows.
const updateDetails = async (restaurantId, orderId, data, userId) => {
  requireRestaurantId(restaurantId);

  if (Object.keys(data).length === 0) {
    throw new AppError(
      400,
      "Nothing to change. Send at least one of: address, landmark, channel, rider, partner order ID or promised time."
    );
  }

  if (data.riderId && data.partnerRiderName) {
    throw new AppError(400, "Choose one of your riders or type a partner rider's name, not both");
  }

  const changes = await deliveryRepository.withLockedOrders(
    restaurantId,
    [orderId],
    async (client, rows) => {
      const row = rows[0];
      requireDelivery(row);

      // A cancelled delivery is a closed record: what it was, where it was
      // going and why it was called off stay as they were.
      if (row.effective_status === "cancelled") {
        const reason = row.delivery_cancel_reason || row.cancel_reason;
        throw new AppError(
          409,
          `${row.order_number} was cancelled${reason ? ` (${reason})` : ""}, so its delivery details can no longer change.`
        );
      }

      const fields = {};
      const notes = {};

      for (const key of ["address", "landmark", "externalRef", "etaMinutes", "customerName", "customerMobile"]) {
        if (key in data) {
          fields[key] = data[key];
        }
      }

      // A saved address picked at the till: its full text goes on
      // the delivery. It must be this order's guest's own.
      let savedAddress = null;

      if (data.savedAddressId) {
        savedAddress = row.customer_id
          ? await guestAddressRepository.findOne(restaurantId, row.customer_id, data.savedAddressId, client)
          : null;

        if (!savedAddress) {
          throw new AppError(
            400,
            "That saved address is not this guest's. Pick one of the guest's own addresses, or type the address."
          );
        }

        fields.address = savedAddress.address;
        fields.landmark = savedAddress.landmark;
        notes.savedAddress = savedAddress.label;
      }

      if ("channelId" in data) {
        if (data.channelId === null) {
          fields.channelId = null;
          fields.channelCommissionPercent = null;
        } else {
          const channel = await requireChannel(restaurantId, data.channelId, row.channel_id, client);

          fields.channelId = channel.id;

          // Re-tagging to a new channel takes that channel's rate today;
          // leaving it where it was keeps the rate it was taken at.
          if (channel.id !== row.channel_id || row.channel_commission_percent === null) {
            fields.channelCommissionPercent = Number(channel.commission_percent);
          }

          notes.channel = channel.name;
        }
      }

      if ("riderId" in data) {
        if (data.riderId === null) {
          fields.riderId = null;
        } else {
          const rider = await requireRider(restaurantId, data.riderId, client);
          fields.riderId = rider.id;
          fields.partnerRiderName = null;
          notes.rider = rider.name;
        }
      }

      if ("partnerRiderName" in data) {
        fields.partnerRiderName = data.partnerRiderName;

        if (data.partnerRiderName) {
          fields.riderId = null;
          notes.rider = data.partnerRiderName;
        }
      }

      // Food on the road is in somebody's hands.
      const riderAfter = "riderId" in fields ? fields.riderId : row.rider_employee_id;
      const partnerAfter = "partnerRiderName" in fields ? fields.partnerRiderName : row.partner_rider_name;

      if (row.effective_status === "out_for_delivery" && !riderAfter && !partnerAfter) {
        throw new AppError(
          409,
          `${row.order_number} is out for delivery, so someone is holding it. Pick the rider who has it.`
        );
      }

      // A delivery that happened was made by somebody; the rider report and
      // "not delivered — undo" both need to know who.
      const hadRider = Boolean(row.rider_employee_id || row.partner_rider_name);

      if (row.effective_status === "delivered" && hadRider && !riderAfter && !partnerAfter) {
        throw new AppError(
          409,
          `${row.order_number} was delivered by ${riderLabel(row)}, and the rider stays on record. Pick the right rider if the wrong one was named.`
        );
      }

      // Our own rider on the road is following this address; it can be
      // corrected, not taken away from him — and a rider of ours sent to an
      // order with no address has nowhere to go.
      const addressAfter = "address" in fields ? fields.address : row.delivery_address;
      const touchesAddress = "address" in fields || ("riderId" in fields && fields.riderId);

      if (row.effective_status === "out_for_delivery" && touchesAddress && riderAfter && !addressAfter) {
        const name = riderAfter === row.rider_employee_id ? row.rider_name : notes.rider;
        throw new AppError(
          409,
          `${row.order_number} is out with ${name || "your rider"}, who needs the address. ${
            "address" in fields ? "Correct it rather than clearing it." : "Add the address first."
          }`
        );
      }

      await deliveryRepository.update(restaurantId, row.id, fields, userId, client);

      // The guest's address book: a saved one moves to the top; a new one
      // used for this delivery is kept on the guest (up to five).
      // Only when the address changes: saving the order again is not another
      // delivery to it.
      const newAddress = Boolean(fields.address) && String(fields.address).trim() !== String(row.delivery_address || "").trim();

      if (savedAddress && newAddress) {
        await guestAddressRepository.markUsed(client, restaurantId, savedAddress.id);
      } else if (!savedAddress && newAddress && row.customer_id) {
        const kept = await guestAddressRepository.remember(
          client,
          restaurantId,
          row.customer_id,
          { label: data.addressLabel || null, address: fields.address, landmark: fields.landmark ?? row.delivery_landmark },
          userId
        );

        if (kept) {
          notes.addressSaved = data.addressLabel || "Home";
        }
      }

      return { orderNumber: row.order_number, notes };
    }
  );

  return {
    delivery: toDelivery(await deliveryRepository.findById(restaurantId, orderId)),
    ...changes,
  };
};

// ---------------------------------------------------------------- channels

const listChannels = async (restaurantId) => {
  requireRestaurantId(restaurantId);
  await salesChannelRepository.ensureDefaults(restaurantId);

  const rows = await salesChannelRepository.findAll(restaurantId);
  return rows.map(toChannel);
};

const duplicateName = (error, name) => {
  if (error.code === DUPLICATE) {
    return new AppError(409, `A channel called "${name}" already exists`);
  }

  return error;
};

const createChannel = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    return toChannel(await salesChannelRepository.create(restaurantId, data, userId));
  } catch (error) {
    throw duplicateName(error, data.name);
  }
};

// A new rate applies to orders tagged from now on; orders already taken keep
// the rate they were taken at, which the report reads off each order.
const updateChannel = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  let row;

  try {
    row = await salesChannelRepository.update(restaurantId, id, data, userId);
  } catch (error) {
    throw duplicateName(error, data.name);
  }

  if (!row) {
    throw new AppError(404, "Channel not found");
  }

  return toChannel(row);
};

const removeChannel = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await salesChannelRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Channel not found");
  }

  if (existing.orders_total > 0) {
    throw new AppError(
      409,
      `${existing.name} is on ${existing.orders_total} order(s). Switch it off instead — its history stays in the report.`
    );
  }

  if ((await salesChannelRepository.count(restaurantId)) <= 1) {
    throw new AppError(409, "Keep at least one channel. Switch it off instead of deleting it.");
  }

  await salesChannelRepository.remove(restaurantId, id);
  return toChannel(existing);
};

// ---------------------------------------------------------------- report

const DAY = 86400000;

const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

const toPerformance = (row) =>
  row
    ? {
        orders: row.orders,
        delivered: row.delivered,
        cancelled: row.cancelled,
        timed: row.timed,
        avgDoorMinutes: row.avg_door_minutes === null ? null : Math.round(Number(row.avg_door_minutes)),
        avgRideMinutes: row.avg_ride_minutes === null ? null : Math.round(Number(row.avg_ride_minutes)),
        onTime: row.on_time,
        onTimeRate: row.timed > 0 ? Math.round((row.on_time / row.timed) * 100) : null,
      }
    : null;

// Money by channel for a date range, and how the deliveries went.
//
// Gross is the bill totals, void bills left out, dated exactly as the sales
// report dates them — so the rows always add up to the sales report's total,
// which the reconciliation line proves on every run.
const report = async (restaurantId, { from, to, outletId = null }) => {
  requireRestaurantId(restaurantId);
  await salesChannelRepository.ensureDefaults(restaurantId);

  const [days, locale, outlet, rules] = await Promise.all([
    deliveryRepository.findOpenDays(restaurantId, outletId),
    deliveryRepository.findLocale(restaurantId),
    outletId ? outletRepository.findById(restaurantId, outletId) : Promise.resolve(null),
    ruleSettings.load(restaurantId),
  ]);

  // "Today" is the open business day, which is not the calendar date once
  // service runs past midnight; with none open, today — or last night's until
  // the cut-off hour, when that day was just closed.
  const businessDate = days[0]
    ? days[0].business_date
    : await tradingDay.dateWithNoDayOpenAt(restaurantId, outletId || undefined, {
        ...((await restaurantRepository.findSettings(restaurantId)) || {}),
        timezone: locale.timezone,
      });

  const end = to || businessDate;
  let start = from;

  if (!start) {
    start = addDays(end, -6);
  }

  if (start > end) {
    throw new AppError(400, "The start date cannot be after the end date");
  }

  if ((Date.parse(end) - Date.parse(start)) / DAY > 366) {
    throw new AppError(400, "Pick a range of a year or less");
  }

  const [sales, bills, performance, channelRows] = await Promise.all([
    deliveryRepository.channelSales(restaurantId, start, end, outletId),
    deliveryRepository.billTotals(restaurantId, start, end, outletId),
    deliveryRepository.deliveryPerformance(restaurantId, start, end, rules.deliverySlaMinutes, outletId),
    salesChannelRepository.findAll(restaurantId),
  ]);

  const makeRow = (base, sale, perf) => {
    const gross = sale ? Number(sale.gross) : 0;
    const commission = sale ? Number(sale.commission) : 0;
    const orders = sale ? sale.orders : 0;

    return {
      ...base,
      orders,
      bills: sale ? sale.bills : 0,
      gross: round2(gross),
      commission: round2(commission),
      net: round2(gross - commission),
      averageOrderValue: orders > 0 ? round2(gross / orders) : 0,
      effectiveRate: gross > 0 ? Math.round((commission / gross) * 1000) / 10 : null,
      delivery: toPerformance(perf),
    };
  };

  const rows = [];

  for (const channel of channelRows) {
    const sale = sales.find((row) => row.kind === "channel" && row.channel_id === channel.id);
    const perf = performance.byChannel.find((row) => row.channel_id === channel.id);

    if (!sale && !perf && channel.status !== "active") {
      continue;
    }

    rows.push(
      makeRow(
        {
          key: `channel-${channel.id}`,
          kind: "channel",
          channelId: channel.id,
          label: channel.name,
          channelType: channel.channel_type,
          color: channel.color,
          ratePercent: Number(channel.commission_percent),
          active: channel.status === "active",
        },
        sale,
        perf
      )
    );
  }

  const untaggedSale = sales.find((row) => row.kind === "untagged");
  const untaggedPerf = performance.byChannel.find((row) => row.channel_id === null);

  if (untaggedSale || untaggedPerf) {
    rows.push(
      makeRow(
        {
          key: "untagged",
          kind: "untagged",
          channelId: null,
          label: "Delivery, channel not set",
          channelType: null,
          color: "slate",
          ratePercent: 0,
          active: true,
        },
        untaggedSale,
        untaggedPerf
      )
    );
  }

  for (const sale of sales.filter((row) => row.kind === "type")) {
    rows.push(
      makeRow(
        {
          key: `type-${sale.order_type}`,
          kind: "order_type",
          channelId: null,
          label: ORDER_TYPE_LABELS[sale.order_type] || sale.order_type,
          channelType: null,
          color: "slate",
          ratePercent: 0,
          active: true,
        },
        sale,
        null
      )
    );
  }

  const totals = rows.reduce(
    (sum, row) => ({
      orders: sum.orders + row.orders,
      bills: sum.bills + row.bills,
      gross: round2(sum.gross + row.gross),
      commission: round2(sum.commission + row.commission),
    }),
    { orders: 0, bills: 0, gross: 0, commission: 0 }
  );

  totals.net = round2(totals.gross - totals.commission);
  totals.averageOrderValue = totals.orders > 0 ? round2(totals.gross / totals.orders) : 0;

  for (const row of rows) {
    row.share = totals.gross > 0 ? Math.round((row.gross / totals.gross) * 1000) / 10 : 0;
  }

  // Heaviest first, with the order-type rows after the channels they are not.
  rows.sort(
    (a, b) =>
      (a.kind === "order_type") - (b.kind === "order_type") ||
      b.gross - a.gross ||
      a.label.localeCompare(b.label)
  );

  const billGross = round2(Number(bills.gross));
  const deliveryRows = performance.byChannel.map(toPerformance);
  const timed = deliveryRows.reduce((sum, row) => sum + row.timed, 0);
  const doorSum = performance.byChannel.reduce(
    (sum, row) => sum + (row.avg_door_minutes === null ? 0 : Number(row.avg_door_minutes) * row.timed),
    0
  );
  const onTime = deliveryRows.reduce((sum, row) => sum + row.onTime, 0);

  return {
    from: start,
    to: end,
    businessDate,
    // Which outlet the figures are for (null: every outlet, "All outlets"),
    // so a printout or export says whose they are.
    outletId: outletId || null,
    outletName: outlet ? outlet.name : null,
    currency: locale.currency,
    slaMinutes: rules.deliverySlaMinutes,
    rows,
    totals,
    reconciliation: {
      bills: bills.bills,
      gross: billGross,
      difference: round2(totals.gross - billGross),
      matches: Math.abs(totals.gross - billGross) < 0.005 && totals.bills === bills.bills,
    },
    delivery: {
      orders: deliveryRows.reduce((sum, row) => sum + row.orders, 0),
      delivered: deliveryRows.reduce((sum, row) => sum + row.delivered, 0),
      cancelled: deliveryRows.reduce((sum, row) => sum + row.cancelled, 0),
      timed,
      avgDoorMinutes: timed > 0 ? Math.round(doorSum / timed) : null,
      onTime,
      onTimeRate: timed > 0 ? Math.round((onTime / timed) * 100) : null,
    },
    riders: performance.byRider
      .map((row) => ({
        riderId: row.rider_employee_id,
        name: row.rider_name || "Partner riders",
        partner: !row.rider_employee_id,
        ...toPerformance(row),
      }))
      .sort((a, b) => a.partner - b.partner || b.delivered - a.delivered),
  };
};

module.exports = {
  board,
  summary,
  getOne,
  updateDetails,
  changeStatus,
  dispatchRun,
  listChannels,
  createChannel,
  updateChannel,
  removeChannel,
  report,
};
