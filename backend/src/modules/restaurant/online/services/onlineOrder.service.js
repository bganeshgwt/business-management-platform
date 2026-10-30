// The restaurant's own online ordering page.
//
// A guest opens a public link — one per selling point: the main counter
// (outlet null) and each outlet — and orders a takeaway or a delivery. Like a
// QR order from a table, what they send is a REQUEST in the staff inbox:
// nothing reaches the kitchen until someone accepts it, and acceptance
// (tableRequest.service acceptOnline) creates the order through the order
// service on the Website channel, at the link's own selling point.
//
// Why per selling point, like a QR table belongs to its outlet: each place
// has its own kitchen, business day, riders and delivery area, and a guest in
// Jubilee Hills ordering from the Banjara Hills kitchen is a cold biryani.
// The main counter is a selling point of its own and gets its own link.
const tableRequestService = require("../../orders/services/tableRequest.service");
const restaurantFeatures = require("../../setup/services/restaurantFeatures.service");
const orderService = require("../../orders/services/order.service");
const onlineOrderRepository = require("../repositories/onlineOrder.repository");
const tableRequestRepository = require("../../orders/repositories/tableRequest.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const salesChannelRepository = require("../../deliveries/repositories/salesChannel.repository");
const planGuard = require("../../../../middlewares/planGuard");
const { effectiveStatusSql } = require("../../deliveries/repositories/delivery.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const personalData = require("../../../personal-data/services/personalData.service");
const pool = require("../../../../config/database");

// The notice a guest's consents were given on: one of this restaurant's (the
// page may have loaded the version before the newest). null when they gave none.
const shownNotice = async (restaurantId, input) => {
  if (!(input.privacyConsents || []).length) {
    return null;
  }

  const result = await pool.query(
    `SELECT n.id FROM business_privacy_notices n JOIN businesses b ON b.id = n.business_id AND b.legacy_restaurant_id = $1 WHERE n.id = $2`,
    [restaurantId, input.privacyNoticeId]
  );

  if (!result.rows[0]) {
    throw new AppError(400, "The privacy notice on the page has changed: reload the page and choose again");
  }

  return result.rows[0].id;
};

// Links are 48 or 64 hex characters (see the repository). Anything else is
// turned away before it costs a database read.
const TOKEN_PATTERN = /^[a-f0-9]{32,64}$/;

const LINK_NOT_FOUND =
  "We couldn't find this ordering page. The link may have changed — please ask the restaurant for its current link.";
const ORDER_NOT_FOUND = "We couldn't find that order on this page.";

const SERVICES = ["takeaway", "delivery"];

const PAYMENT_FOR = { takeaway: "pay_at_pickup", delivery: "cash_on_delivery" };

// Said on the page, so nobody looks for a "Pay now" button that does nothing.
const ONLINE_PAYMENT_NOTE =
  "Paying online (UPI, cards) will be offered once the restaurant connects a payment gateway. For now you pay when you collect, or cash on delivery.";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// ---------------------------------------------------------------- the link behind a public address

// An unknown token, a replaced link, a suspended restaurant and a closed
// outlet all look the same to the public: this link does not work.
const resolveLink = async (token) => {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new AppError(404, LINK_NOT_FOUND);
  }

  const link = await onlineOrderRepository.findLinkByToken(token);

  if (
    !link ||
    link.restaurant_status !== "active" ||
    (link.outlet_id && link.outlet_status !== "active")
  ) {
    throw new AppError(404, LINK_NOT_FOUND);
  }

  // Online ordering switched off (Settings -> Features): the page takes no
  // orders. With Deliveries off it offers takeaway only.
  const features = await restaurantFeatures.assertRestaurantHas(
    link.restaurant_id,
    "online_ordering",
    "This restaurant is not taking orders online at the moment. Please call the restaurant."
  );

  if (!features.includes("deliveries")) {
    link.delivery_enabled = false;
  }

  return link;
};

// ---------------------------------------------------------------- serving hours

// The restaurant's clock: weekday (0 = Sunday) and "HH:MM".
const localClock = (timezone, at = new Date()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );

  return {
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
    clock: `${parts.hour}:${parts.minute}`,
  };
};

const periodsOf = (row) => {
  if (!row || !row.is_open) {
    return [];
  }

  const periods = Array.isArray(row.periods) && row.periods.length > 0
    ? row.periods
    : [{ openTime: row.open_time, closeTime: row.close_time }];

  return periods
    .filter((period) => period && period.openTime && period.closeTime)
    .map((period) => ({ opensAt: String(period.openTime).slice(0, 5), closesAt: String(period.closeTime).slice(0, 5) }));
};

// Today's serving hours, whether the kitchen is serving now, and when it next
// opens today. No hours set at all: nothing to say, and nothing refused (the
// business day decides).
const servingHours = (rows, timezone, at = new Date()) => {
  if (rows.length === 0) {
    return { known: false, today: [], openNow: true, nextOpensAt: null, closedToday: false };
  }

  const { day, clock } = localClock(timezone, at);
  const byDay = new Map(rows.map((row) => [Number(row.day_of_week), row]));
  const today = periodsOf(byDay.get(day));
  const yesterday = periodsOf(byDay.get((day + 6) % 7));

  const openNow =
    today.some((period) =>
      period.opensAt < period.closesAt
        ? clock >= period.opensAt && clock < period.closesAt
        : clock >= period.opensAt
    ) ||
    // A dinner service that runs past midnight is still yesterday's.
    yesterday.some((period) => period.opensAt >= period.closesAt && clock < period.closesAt);

  const next = today.map((period) => period.opensAt).filter((opens) => opens > clock).sort()[0] || null;

  return { known: true, today, openNow, nextOpensAt: next, closedToday: today.length === 0 };
};

// "7:00 pm" from "19:00".
const twelveHour = (clock) => {
  const [hours, minutes] = clock.split(":").map(Number);
  const suffix = hours >= 12 ? "pm" : "am";

  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
};

// ---------------------------------------------------------------- whether orders are taken now

const orderingState = (link, channel, day, hours) => {
  const call = link.outlet_phone || link.restaurant_phone;
  const callLine = call ? ` Please call us on ${call}.` : "";

  if (!link.is_enabled || !channel) {
    return { enabled: false, reason: `We're not taking online orders right now.${callLine}` };
  }

  if (!hours.openNow) {
    return {
      enabled: false,
      reason: hours.nextOpensAt
        ? `We're closed right now. Online orders open again at ${twelveHour(hours.nextOpensAt)}.`
        : hours.closedToday
          ? "We're closed today. Please come back tomorrow."
          : "We've closed for the day. Please come back tomorrow.",
    };
  }

  if (!day.business_day_id) {
    return {
      enabled: false,
      reason: "The kitchen hasn't opened for the day yet. Please try again in a little while.",
    };
  }

  return { enabled: true, reason: null };
};

const servicesOf = (link) => SERVICES.filter((service) => link[`${service}_enabled`]);

const deliveryTerms = (channel) => ({
  charge: channel ? Number(channel.delivery_charge || 0) : 0,
  freeAbove:
    channel && channel.delivery_free_above !== null && channel.delivery_free_above !== undefined
      ? Number(channel.delivery_free_above)
      : null,
});

// The charge the order will carry, by the deliveries module's rule
// (deliveryCharge.repository): the Website channel's charge, nothing once
// the food comes to its "free above" amount.
const chargeFor = (terms, foodTotal) =>
  terms.charge > 0 && !(terms.freeAbove !== null && foodTotal >= terms.freeAbove) ? terms.charge : 0;

// Everything that decides whether, and how, the link takes an order now.
const loadContext = async (link) => {
  const restaurantId = link.restaurant_id;
  const timezone = link.timezone || "Asia/Kolkata";
  const [channel, day, hourRows] = await Promise.all([
    onlineOrderRepository.findWebsiteChannel(restaurantId),
    tableRequestRepository.findDayWindow(restaurantId, link.outlet_id || null),
    onlineOrderRepository.findHours(restaurantId, link.outlet_id || null),
  ]);
  const hours = servingHours(hourRows, timezone);

  return { restaurantId, timezone, channel, day, hours, state: orderingState(link, channel, day, hours) };
};

// ---------------------------------------------------------------- the guest's menu

const getMenu = async (token, requestedService) => {
  const link = await resolveLink(token);
  const context = await loadContext(link);
  const offered = servicesOf(link);
  const service = offered.includes(requestedService) ? requestedService : offered[0];

  const menu = await tableRequestService.menuFor(context.restaurantId, {
    outletId: link.outlet_id || null,
    orderType: service,
    channelId: context.channel ? context.channel.id : null,
    timezone: context.timezone,
  });

  return {
    restaurant: {
      name: link.restaurant_name,
      currencySymbol: link.currency_symbol || "₹",
      taxMode: link.tax_mode || "exclusive",
    },
    place: {
      // The outlet's own name, or the restaurant's for the main counter.
      name: link.outlet_id ? link.outlet_name : null,
      address: link.outlet_id ? link.outlet_address : link.restaurant_address,
      phone: link.outlet_phone || link.restaurant_phone || null,
    },
    ordering: {
      ...context.state,
      services: offered,
      service,
      note: link.guest_note,
      pickupMinutes: link.pickup_minutes,
      deliveryMinutes: link.delivery_minutes,
      minDeliveryOrder: Number(link.min_delivery_order),
      deliveryArea: link.delivery_area,
      maxOpenPerMobile: link.max_open_per_mobile,
      maxLines: 30,
      maxQuantity: 20,
      paymentModes: [PAYMENT_FOR[service]],
      onlinePayment: { available: false, note: ONLINE_PAYMENT_NOTE },
    },
    delivery: deliveryTerms(context.channel),
    hours: {
      known: context.hours.known,
      today: context.hours.today,
      openNow: context.hours.openNow,
      nextOpensAt: context.hours.nextOpensAt,
    },
    offers: menu.offers,
    // The restaurant's privacy notice, shown where the guest gives their details (null: none published).
    privacy: await personalData.publicNotice(link.restaurant_id),
    categories: menu.categories,
  };
};

// ---------------------------------------------------------------- what the guest sees back

const STEPS = {
  delivery: [
    { key: "sent", label: "Sent" },
    { key: "accepted", label: "Accepted" },
    { key: "ready", label: "Ready" },
    { key: "out", label: "Out for delivery" },
    { key: "delivered", label: "Delivered" },
  ],
  takeaway: [
    { key: "sent", label: "Sent" },
    { key: "accepted", label: "Accepted" },
    { key: "ready", label: "Ready for pickup" },
    { key: "collected", label: "Collected" },
  ],
};

const clockAt = (date, timezone) =>
  new Date(date).toLocaleTimeString("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit" });

const stageOf = (row, link, timezone, amountLine) => {
  if (row.status === "pending" || row.status === "processing") {
    return {
      stage: "sent",
      label: "Sent — waiting for the restaurant to confirm",
      detail: "This page updates by itself the moment they accept it.",
    };
  }

  if (row.status === "rejected") {
    return { stage: "rejected", label: "The restaurant couldn't accept this order", detail: row.reject_reason };
  }

  if (row.status === "cancelled") {
    return { stage: "cancelled", label: "Cancelled", detail: "You cancelled this order." };
  }

  if (row.order_status === "cancelled" || row.delivery_state === "cancelled") {
    return {
      stage: "rejected",
      label: "Cancelled by the restaurant",
      detail: "Please call the restaurant if you have any questions.",
    };
  }

  const placed = row.placed_at || row.resolved_at || row.created_at;

  if (row.service_type === "delivery") {
    const minutes = row.delivery_eta_minutes || link.delivery_minutes;
    const expected = clockAt(new Date(new Date(placed).getTime() + minutes * 60000), timezone);

    switch (row.delivery_state) {
      case "delivered":
        return { stage: "delivered", label: "Delivered — enjoy your meal", detail: null };
      case "out_for_delivery":
        return {
          stage: "out",
          label: "Out for delivery",
          detail: `Your food is on its way, expected by about ${expected}.${amountLine}`,
        };
      case "ready":
        return {
          stage: "ready",
          label: "Ready — packed and waiting for the rider",
          detail: `Expected by about ${expected}.`,
        };
      default:
        return {
          stage: "accepted",
          label: "Accepted — being prepared",
          detail: `Expected by about ${expected}.`,
        };
    }
  }

  const reference = `${row.order_number}${row.token_no ? ` (token ${row.token_no})` : ""}`;

  if (row.order_status === "completed") {
    return { stage: "collected", label: "Collected — enjoy your meal", detail: null };
  }

  if (["ready", "served"].includes(row.kitchen_status)) {
    return {
      stage: "ready",
      label: "Ready for pickup",
      detail: `Show order ${reference} at the counter.${amountLine}`,
    };
  }

  const readyBy = clockAt(new Date(new Date(placed).getTime() + link.pickup_minutes * 60000), timezone);

  return {
    stage: "accepted",
    label: "Accepted — being prepared",
    detail: `Ready to collect at about ${readyBy}. Your order is ${reference}.`,
  };
};

const FINAL = ["rejected", "cancelled", "delivered", "collected"];

const toGuestOrder = (row, link) => {
  const timezone = link.timezone || "Asia/Kolkata";
  const currency = link.currency_symbol || "₹";
  const items = (row.items || []).map((item) => ({
    name: item.name,
    variant: item.variant,
    modifiers: (item.modifiers || []).map((modifier) => modifier.name),
    quantity: Number(item.quantity),
    notes: item.notes,
    foodType: item.foodType,
    lineTotal: Number(item.lineTotal),
  }));
  const accepted = row.status === "accepted" && row.order_number;
  // Once accepted, the order's own figures: the food as the order priced it
  // and the delivery charge it carries (waived, or free above, included).
  const itemsTotal = accepted ? Number(row.order_total) : round2(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const deliveryCharge = accepted ? Number(row.order_delivery_charge || 0) : Number(row.delivery_charge || 0);
  const total = round2(itemsTotal + deliveryCharge);
  const amount = `${currency}${total.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const amountLine =
    row.payment_mode === "cash_on_delivery"
      ? ` Please keep about ${amount} ready (cash on delivery).`
      : ` Please pay about ${amount} when you collect.`;
  const stage = stageOf(row, link, timezone, amountLine);

  return {
    // Who to call about it: the status page may be opened on its own, from
    // a link the guest saved, without the menu.
    restaurant: {
      name: link.restaurant_name,
      placeName: link.outlet_id ? link.outlet_name : null,
      phone: link.outlet_phone || link.restaurant_phone || null,
      currencySymbol: currency,
    },
    status: row.status,
    ...stage,
    final: FINAL.includes(stage.stage),
    serviceType: row.service_type,
    steps: STEPS[row.service_type],
    paymentMode: row.payment_mode,
    orderNumber: accepted ? row.order_number : null,
    tokenNo: accepted ? row.token_no : null,
    guestName: row.guest_name,
    address: row.delivery_address,
    landmark: row.delivery_landmark,
    notes: row.notes,
    items,
    itemCount: row.item_count,
    itemsTotal,
    deliveryCharge,
    total,
    createdAt: row.created_at,
    canCancel: row.status === "pending",
  };
};

// Found by the guest's own token alone (see the repository); the link it
// was sent from gives the clock, the currency and the promised times.
const readBack = async (guestToken) => {
  const row = await onlineOrderRepository.findForGuest(guestToken, effectiveStatusSql);
  const link = row && row.online_link_id ? await onlineOrderRepository.findLinkById(row.online_link_id) : null;

  if (!row || !link) {
    throw new AppError(404, ORDER_NOT_FOUND);
  }

  return toGuestOrder(row, link);
};

// ---------------------------------------------------------------- placing an order

const placeOrder = async (token, input) => {
  const link = await resolveLink(token);
  // A restaurant whose plan has ended (or is switched off) takes no orders online.
  await planGuard.assertTakingOrders(link.restaurant_id);
  const context = await loadContext(link);

  if (!context.state.enabled) {
    throw new AppError(409, context.state.reason);
  }

  if (!servicesOf(link).includes(input.service)) {
    throw new AppError(
      400,
      input.service === "delivery"
        ? "We're only taking takeaway orders online right now. Please choose takeaway."
        : "We're only taking delivery orders online right now. Please choose delivery."
    );
  }

  if (input.service === "delivery" && !input.address) {
    throw new AppError(400, "Please give the delivery address: house or flat, street and area.");
  }

  if (input.paymentMode !== PAYMENT_FOR[input.service]) {
    throw new AppError(
      400,
      input.service === "delivery"
        ? "Delivery orders are paid in cash on delivery. Online payment isn't available yet."
        : "Takeaway orders are paid when you collect them. Online payment isn't available yet."
    );
  }

  const lines = tableRequestService.mergeLines(input.items);

  if (lines.reduce((sum, line) => sum + line.quantity, 0) > 60) {
    throw new AppError(400, "That's a very large order — please call the restaurant to place it.");
  }

  const restaurantId = context.restaurantId;

  await tableRequestService.checkCart(restaurantId, lines);

  // Priced by the order service, from the menu, now, for this service on the
  // Website channel at this selling point — packaging included. Whatever
  // price the phone may have sent is never read.
  const pricing = await restaurantRepository.findSettings(restaurantId);
  const { lines: priced, totals } = await orderService.priceLines(
    restaurantId,
    lines.map((line) => ({
      productId: line.productId,
      productVariantId: line.variantId || null,
      modifierIds: line.modifierIds,
      comboSelections: line.comboSelections || [],
      quantity: line.quantity,
      notes: line.notes,
    })),
    pricing.tax_mode,
    pricing.timezone,
    {
      outletId: link.outlet_id || null,
      orderType: input.service,
      channelId: context.channel.id,
      billOfSupply: pricing.document_type === "bill_of_supply",
    }
  );

  const items = lines.map((line, index) => {
    const price = priced[index];

    return {
      productId: line.productId,
      productVariantId: line.variantId || null,
      modifierIds: line.modifierIds,
      comboSelections: line.comboSelections || [],
      itemName: price.itemName,
      variantName: price.variantName,
      modifiers: price.modifiers,
      foodType: line.product.food_type,
      quantity: line.quantity,
      notes: line.notes,
      unitPrice: price.unitPrice,
      lineTotal: round2(price.lineTotal),
    };
  });

  const foodTotal = totals.totalAmount;
  const minimum = Number(link.min_delivery_order);

  if (input.service === "delivery" && minimum > 0 && foodTotal < minimum) {
    const currency = link.currency_symbol || "₹";
    throw new AppError(
      400,
      `The minimum for delivery is ${currency}${minimum}. Add ${currency}${round2(minimum - foodTotal)} more, or choose takeaway.`
    );
  }

  const deliveryCharge =
    input.service === "delivery" ? chargeFor(deliveryTerms(context.channel), foodTotal) : 0;

  const result = await onlineOrderRepository.createOrderRequest(
    {
      restaurantId,
      outletId: link.outlet_id || null,
      linkId: link.id,
      businessDayId: context.day.business_day_id,
      clientKey: input.clientKey,
      guestName: input.guestName,
      guestMobile: input.guestMobile,
      notes: input.notes,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      estimatedTotal: foodTotal,
      serviceType: input.service,
      address: input.service === "delivery" ? input.address : null,
      landmark: input.service === "delivery" ? input.landmark : null,
      paymentMode: input.paymentMode,
      deliveryCharge,
      privacyConsents: input.privacyConsents || [],
      privacyNoticeId: await shownNotice(restaurantId, input),
    },
    items,
    link.max_open_per_mobile
  );

  if (result.error === "TOO_MANY_OPEN") {
    throw new AppError(
      409,
      `This mobile number already has ${result.open} ${result.open === 1 ? "order" : "orders"} in progress with us. ` +
        "Please wait until they're with you, or call the restaurant."
    );
  }

  return {
    guestToken: result.guestToken,
    duplicate: result.duplicate,
    order: await readBack(result.guestToken),
  };
};

// ---------------------------------------------------------------- following up

const TRACK_TOKEN = /^[a-f0-9]{48}$/;

const requireGuestToken = (guestToken) => {
  if (typeof guestToken !== "string" || !TRACK_TOKEN.test(guestToken)) {
    throw new AppError(404, ORDER_NOT_FOUND);
  }
};

// The link in the address is not checked: the guest's token is what finds
// the order, and a replaced link must not lose a guest their order.
const getOrder = async (guestToken) => {
  requireGuestToken(guestToken);

  return readBack(guestToken);
};

const cancelOrder = async (guestToken) => {
  requireGuestToken(guestToken);
  const cancelled = await onlineOrderRepository.cancelForGuest(guestToken);

  if (!cancelled) {
    // Not found (readBack says so), or the restaurant got to it first.
    const current = await readBack(guestToken);

    throw new AppError(
      409,
      current.stage === "cancelled"
        ? "This order is already cancelled."
        : "The restaurant has already picked this up, so it can't be cancelled from here. Please call them."
    );
  }

  return readBack(guestToken);
};

// ---------------------------------------------------------------- the staff's settings

const toLink = (row, counts, channel) => {
  const count = counts.get(Number(row.id)) || {};

  return {
    id: row.id,
    outletId: row.outlet_id || null,
    // null = the main counter.
    outletName: row.outlet_id ? row.outlet_name : null,
    outletActive: !row.outlet_id || row.outlet_status === "active",
    token: row.token,
    enabled: row.is_enabled,
    // Switched on but taking nothing: the Website channel is off.
    live: Boolean(row.is_enabled && channel),
    takeawayEnabled: row.takeaway_enabled,
    deliveryEnabled: row.delivery_enabled,
    minDeliveryOrder: Number(row.min_delivery_order),
    pickupMinutes: row.pickup_minutes,
    deliveryMinutes: row.delivery_minutes,
    maxOpenPerMobile: row.max_open_per_mobile,
    deliveryArea: row.delivery_area,
    guestNote: row.guest_note,
    waiting: count.waiting || 0,
    lastDay: count.last_day || 0,
    acceptedLastDay: count.accepted_last_day || 0,
    updatedAt: row.updated_at,
  };
};

const listLinks = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  await Promise.all([
    onlineOrderRepository.ensureLinks(restaurantId),
    salesChannelRepository.ensureDefaults(restaurantId),
  ]);

  const [rows, countRows, channel] = await Promise.all([
    onlineOrderRepository.findLinks(restaurantId),
    onlineOrderRepository.findLinkCounts(restaurantId),
    onlineOrderRepository.findWebsiteChannel(restaurantId),
  ]);
  const counts = new Map(countRows.map((row) => [Number(row.online_link_id), row]));

  return {
    links: rows.map((row) => toLink(row, counts, channel)),
    websiteChannel: channel
      ? { id: channel.id, name: channel.name, ...deliveryTerms(channel) }
      : null,
    onlinePaymentNote: ONLINE_PAYMENT_NOTE,
  };
};

const COLUMNS = {
  enabled: "is_enabled",
  takeawayEnabled: "takeaway_enabled",
  deliveryEnabled: "delivery_enabled",
  minDeliveryOrder: "min_delivery_order",
  pickupMinutes: "pickup_minutes",
  deliveryMinutes: "delivery_minutes",
  maxOpenPerMobile: "max_open_per_mobile",
  deliveryArea: "delivery_area",
  guestNote: "guest_note",
};

const requireLink = async (restaurantId, id) => {
  const row = await onlineOrderRepository.findLink(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Ordering link not found");
  }

  return row;
};

const placeName = (row) => (row.outlet_id ? row.outlet_name : "the main counter");

// Only the fields sent change.
const updateLink = async (restaurantId, id, input, userId) => {
  requireRestaurantId(restaurantId);

  const row = await requireLink(restaurantId, id);
  const columns = {};

  for (const [key, column] of Object.entries(COLUMNS)) {
    if (input[key] !== undefined) {
      columns[column] = input[key];
    }
  }

  const takeaway = input.takeawayEnabled ?? row.takeaway_enabled;
  const delivery = input.deliveryEnabled ?? row.delivery_enabled;

  if (!takeaway && !delivery) {
    throw new AppError(400, "Offer takeaway, delivery or both — or switch online ordering off.");
  }

  if (input.enabled === true && !row.is_enabled) {
    if (row.outlet_id && row.outlet_status !== "active") {
      throw new AppError(409, `${row.outlet_name} is closed, so its ordering link cannot be switched on.`);
    }

    if (!(await onlineOrderRepository.findWebsiteChannel(restaurantId))) {
      throw new AppError(
        409,
        "Switch the Website sales channel on first (Deliveries → Channels): online orders are tagged with it, and its delivery charge applies."
      );
    }
  }

  if (Object.keys(columns).length > 0) {
    await onlineOrderRepository.updateLink(restaurantId, id, columns, userId);
  }

  const data = await listLinks(restaurantId);

  return { link: data.links.find((link) => Number(link.id) === Number(id)), place: placeName(row) };
};

// A new address for the link: every copy of the old one stops working (shared
// in the wrong group, printed with a typo). Orders already sent keep their
// status pages: those are found by the guest's own token.
const replaceLinkToken = async (restaurantId, id, userId) => {
  requireRestaurantId(restaurantId);

  const row = await requireLink(restaurantId, id);

  await onlineOrderRepository.replaceToken(restaurantId, id, userId);

  const data = await listLinks(restaurantId);

  return { link: data.links.find((link) => Number(link.id) === Number(id)), place: placeName(row) };
};

module.exports = {
  SERVICES,
  getMenu,
  placeOrder,
  getOrder,
  cancelOrder,
  listLinks,
  updateLink,
  replaceLinkToken,
};
