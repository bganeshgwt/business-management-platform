const deliveryService = require("../services/delivery.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CHANNEL_TYPES = ["own", "aggregator", "phone", "website"];
const COLORS = ["orange", "red", "amber", "green", "teal", "blue", "violet", "pink", "slate"];
const STATUSES = ["preparing", "ready", "out_for_delivery", "delivered", "cancelled"];

// A channel's colour when none is picked: the one people already associate
// with that kind of partner.
const DEFAULT_COLOR = { own: "green", aggregator: "orange", phone: "blue", website: "violet" };

// An order, rider or channel number. "1.5" or twenty digits is somebody's
// typo, and must come back as one rather than as a database error.
const wholeId = (value, field) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new AppError(400, `${field} must be a whole number, like 42`);
  }

  return number;
};

const optionalWholeId = (value, field) =>
  value === undefined || value === null || value === "" ? null : wholeId(value, field);

// Free text. Blank means "none"; a number or a list where words belong is
// refused as what it is, not as "is required".
const text = (value, field, maxLength) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, `${field} must be text`);
  }

  return value.trim() === "" ? null : v.requiredString(value, field, maxLength);
};

// A real day on the calendar: 2026-02-30 and 2026-13-01 have the right shape
// and are still not dates.
const optionalDate = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const match = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;

  if (!parsed || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError(400, `${field} must be a real date, like 2026-09-18`);
  }

  return value;
};

// Digits, spaces, dashes, brackets and a leading +. Enough for "98480 12345",
// "+91 98480-12345" and a landline, and nothing a rider cannot dial.
const optionalMobile = (value) => {
  const mobile = text(value, "Customer mobile", 20);

  if (mobile && !/^\+?[0-9][0-9\s\-()]{5,19}$/.test(mobile)) {
    throw new AppError(400, "Customer mobile should be a phone number, like 98480 12345");
  }

  return mobile;
};

const wholeMinutes = (value) => {
  const minutes = v.optionalNumber(value, "Promised time (minutes)", { min: 5, max: 240 });

  if (minutes !== null && !Number.isInteger(minutes)) {
    throw new AppError(400, "Promised time must be a whole number of minutes");
  }

  return minutes;
};

const isObject = (body) => body !== null && typeof body === "object" && !Array.isArray(body);

// Only the fields present in the body are read, so "clear the landmark" (null)
// and "leave the landmark alone" (not sent) are different requests.
const readDetails = (raw) => {
  const body = isObject(raw) ? raw : {};
  const data = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  if (has("address")) data.address = text(body.address, "Delivery address", 500);
  // One of the guest's saved addresses, by id: the server copies
  // its full text onto the delivery, also for staff who see it masked.
  if (has("savedAddressId")) data.savedAddressId = optionalWholeId(body.savedAddressId, "Saved address");
  // The label a new address is kept under on the guest: Home, Office…
  if (has("addressLabel")) data.addressLabel = text(body.addressLabel, "Address label", 30);
  if (has("landmark")) data.landmark = text(body.landmark, "Landmark", 200);
  if (has("channelId")) data.channelId = optionalWholeId(body.channelId, "Channel");
  if (has("riderId")) data.riderId = optionalWholeId(body.riderId, "Rider");
  if (has("partnerRiderName")) {
    data.partnerRiderName = text(body.partnerRiderName, "Partner rider name", 100);
  }
  if (has("externalRef")) data.externalRef = text(body.externalRef, "Partner order ID", 60);
  if (has("etaMinutes")) data.etaMinutes = wholeMinutes(body.etaMinutes);
  if (has("customerName")) data.customerName = text(body.customerName, "Customer name", 150);
  if (has("customerMobile")) data.customerMobile = optionalMobile(body.customerMobile);

  return data;
};

const readRider = (body) => ({
  riderId: optionalWholeId(body.riderId, "Rider"),
  partnerRiderName: text(body.partnerRiderName, "Partner rider name", 100),
});

const readChannel = (raw) => {
  const body = isObject(raw) ? raw : {};
  const channelType = v.requiredEnum(body.type ?? body.channelType, "Channel type", CHANNEL_TYPES);
  const commission = v.optionalNumber(body.commissionPercent, "Commission %", { min: 0, max: 50 });
  const sortOrder = v.optionalNumber(body.sortOrder, "Display order", { min: 0, max: 9999 });

  if (sortOrder !== null && !Number.isInteger(sortOrder)) {
    throw new AppError(400, "Display order must be a whole number");
  }

  return {
    name: v.requiredString(body.name, "Channel name", 60),
    channelType,
    // Stored to two places, so what is shown is what is charged.
    commissionPercent: commission === null ? 0 : round2(commission),
    color: v.optionalEnum(body.color, "Colour", COLORS, DEFAULT_COLOR[channelType]),
    sortOrder,
    status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
    // The trip charge on this channel's deliveries and the order
    // size from which it is free. Left out of a request = left as it is.
    ...readDeliveryCharge(body),
  };
};

const readDeliveryCharge = (body) => {
  const out = {};

  if (body.deliveryCharge !== undefined) {
    const charge = v.optionalNumber(body.deliveryCharge, "Delivery charge", { min: 0, max: 10000 });
    out.deliveryCharge = charge === null ? 0 : round2(charge);
  }

  if (body.deliveryFreeAbove !== undefined) {
    const above = v.optionalNumber(body.deliveryFreeAbove, "Free delivery above", { min: 0, max: 10000000 });

    if (above !== null && above <= 0) {
      throw new AppError(400, "Free delivery above must be more than 0, or left empty to always charge");
    }

    out.deliveryFreeAbove = above === null ? null : round2(above);
  }

  return out;
};

// Sales and the cash out on the road are the restaurant's takings: only for
// people whose role lets them see sales figures (sales.view), as on the
// dashboard. A captain who watches the board to answer "where is table 12's
// parcel?" does not need them, and nor does a stock clerk who may read the
// stock reports.
const seesMoney = (req) => (req.user.permissions || []).includes("sales.view");

// ---------------------------------------------------------------- board

// Full numbers on the board only for customers.contact; everyone else sees
// the last four digits and opens one delivery to call it (see toSummary).
const seesContacts = (req) => (req.user.permissions || []).includes("customers.contact");

// ?date=YYYY-MM-DD: an earlier business date's deliveries. Rebuilt from its
// parts and compared, so 30 February is refused rather than rolled on.
const readBoardDate = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
  const [year, month, day] = match ? match.slice(1).map(Number) : [];
  const rebuilt = match ? new Date(Date.UTC(year, month - 1, day)) : null;

  if (!rebuilt || year < 2000 || year > 2100 || rebuilt.getUTCMonth() !== month - 1 || rebuilt.getUTCDate() !== day) {
    throw new AppError(400, "Date must be a date like 2026-10-01");
  }

  return match[0];
};

const board = async (req, res) => {
  const data = await deliveryService.board(req.user.restaurantId, {
    outletId: req.outletId,
    withMoney: seesMoney(req),
    revealContacts: seesContacts(req),
    date: readBoardDate(req.query.date),
  });

  res.json({ success: true, data });
};

const summary = async (req, res) => {
  const data = await deliveryService.summary(req.user.restaurantId, {
    outletId: req.outletId,
    withMoney: seesMoney(req),
  });

  res.json({ success: true, data });
};

const getOne = async (req, res) => {
  const id = wholeId(req.params.orderId, "Order id");

  res.json({ success: true, data: await deliveryService.getOne(req.user.restaurantId, id) });
};

const updateDetails = async (req, res) => {
  const id = wholeId(req.params.orderId, "Order id");
  const data = readDetails(req.body);
  const result = await deliveryService.updateDetails(req.user.restaurantId, id, data, req.user.id);

  logAction(req, "update", "delivery", {
    id,
    label: result.orderNumber,
    details: { fields: Object.keys(data), ...result.notes },
  });

  res.json({ success: true, message: `${result.orderNumber} updated`, data: result.delivery });
};

const MESSAGES = {
  preparing: (d) => `${d.orderNumber} accepted — the kitchen is on it`,
  ready: (d) => `${d.orderNumber} is packed and ready at the pass`,
  out_for_delivery: (d) =>
    `${d.orderNumber} is out with ${d.rider ? d.rider.name : d.partnerRiderName || "the rider"}`,
  delivered: (d) => `${d.orderNumber} delivered`,
};

const changeStatus = async (req, res) => {
  const id = wholeId(req.params.orderId, "Order id");
  const body = isObject(req.body) ? req.body : {};
  const status = v.requiredEnum(body.status, "Status", STATUSES);
  const input = {
    status,
    ...readRider(body),
    reason: text(body.reason, "Reason", 200),
    // "Yes, the food really is at the pass" — only asked for when the kitchen
    // display still shows the order cooking.
    confirmPacked: v.requiredBoolean(body.confirmPacked, "confirmPacked", false),
  };

  const result = await deliveryService.changeStatus(req.user.restaurantId, id, input, req.user.id);
  const delivery = result.delivery;

  let message = MESSAGES[status] ? MESSAGES[status](delivery) : `${delivery.orderNumber} updated`;

  if (result.undo) {
    message = `${delivery.orderNumber} is back on the road — not delivered yet`;
  } else if (result.recalled) {
    message = `${delivery.orderNumber} is back at the restaurant, ready to go again`;
  } else if (status === "cancelled") {
    message = result.billStillLive
      ? `${delivery.orderNumber} delivery cancelled. Its bill ${delivery.billNumbers} is still live — void it in Bills if the money must go back.`
      : `${delivery.orderNumber} cancelled`;
  }

  if (["out_for_delivery", "delivered", "cancelled"].includes(status) || result.undo || result.recalled) {
    logAction(req, result.undo ? "undo_delivered" : result.recalled ? "recall" : status, "delivery", {
      id,
      label: delivery.orderNumber,
      details: {
        rider: delivery.rider ? delivery.rider.name : delivery.partnerRiderName,
        channel: delivery.channel ? delivery.channel.name : null,
        reason: input.reason || undefined,
      },
    });
  }

  res.json({
    success: true,
    message,
    data: { ...delivery, billStillLive: Boolean(result.billStillLive) },
  });
};

const dispatchRun = async (req, res) => {
  const body = isObject(req.body) ? req.body : {};
  const input = {
    orderIds: v.requiredArray(body.orderIds, "Orders").map((id) => wholeId(id, "Order id")),
    ...readRider(body),
  };

  const result = await deliveryService.dispatchRun(req.user.restaurantId, input, req.user.id, req.outletId);

  for (const order of result.orders) {
    logAction(req, "out_for_delivery", "delivery", {
      id: order.id,
      label: order.orderNumber,
      details: { rider: result.riderName, run: result.orders.map((one) => one.orderNumber) },
    });
  }

  res.json({
    success: true,
    message:
      result.orders.length === 1
        ? `${result.orders[0].orderNumber} is out with ${result.riderName}`
        : `${result.orders.length} orders out with ${result.riderName}`,
    data: result,
  });
};

// ---------------------------------------------------------------- channels

const listChannels = async (req, res) => {
  res.json({ success: true, data: await deliveryService.listChannels(req.user.restaurantId) });
};

const createChannel = async (req, res) => {
  const channel = await deliveryService.createChannel(
    req.user.restaurantId,
    readChannel(req.body),
    req.user.id
  );

  logAction(req, "create", "sales_channel", {
    id: channel.id,
    label: channel.name,
    details: { type: channel.type, commissionPercent: channel.commissionPercent },
  });

  res.status(201).json({ success: true, message: `${channel.name} added`, data: channel });
};

const updateChannel = async (req, res) => {
  const id = wholeId(req.params.id, "Channel id");
  const channel = await deliveryService.updateChannel(
    req.user.restaurantId,
    id,
    readChannel(req.body),
    req.user.id
  );

  logAction(req, "update", "sales_channel", {
    id,
    label: channel.name,
    details: { commissionPercent: channel.commissionPercent, status: channel.status },
  });

  res.json({ success: true, message: `${channel.name} saved`, data: channel });
};

const removeChannel = async (req, res) => {
  const id = wholeId(req.params.id, "Channel id");
  const channel = await deliveryService.removeChannel(req.user.restaurantId, id);

  logAction(req, "delete", "sales_channel", { id, label: channel.name });

  res.json({ success: true, message: `${channel.name} deleted` });
};

// ---------------------------------------------------------------- report

const report = async (req, res) => {
  const data = await deliveryService.report(req.user.restaurantId, {
    from: optionalDate(req.query.from, "From"),
    to: optionalDate(req.query.to, "To"),
    outletId: req.outletId || null,
  });

  res.json({ success: true, data });
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
