// The guest side of QR ordering. Nobody here is signed in: the only thing a
// request carries is the table's QR token, and every read and write is scoped
// by the table it resolves to. Input is checked strictly — more strictly than
// for staff — because anyone on the internet can send anything to these URLs.
const tableRequestService = require("../services/tableRequest.service");
const onlineOrderService = require("../../online/services/onlineOrder.service");
const { normaliseMobile } = require("../../../../utils/phone");
const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");

const MAX_LINES = 30;
const MAX_ADDONS = 10;
const CLIENT_KEY = /^[A-Za-z0-9-]{8,64}$/;
const CALL_TYPES = ["call_waiter", "bill", "water", "other"];

// Nothing a guest reads may be cached by a browser or a proxy on the way: a
// status screen showing "Sent" after the kitchen accepted it is worse than none.
const noStore = (res) => res.set("Cache-Control", "no-store");

const REQUEST_NOT_FOUND = "We couldn't find that request for this table.";
const REFRESH = "Please refresh the page and try again.";

// A database id: a whole number from 1 up to what JavaScript counts exactly.
// Everything else — 1.5, 1e20, "12abc", a list, a huge number that would
// overflow the column — is refused here with the given status and message,
// instead of reaching the database and coming back as a server error.
const readId = (value, status, message) => {
  let number = NaN;

  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string" && /^\d{1,16}$/.test(value.trim())) {
    number = Number(value.trim());
  }

  if (!Number.isSafeInteger(number) || number < 1) {
    throw new AppError(status, message);
  }

  return number;
};

// Free text from a guest. A number, a list or an object where words belong
// is refused as what it is, not as "required".
const readText = (value, field, maxLength, { required = false } = {}) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new AppError(400, `${field} is required`);
    }

    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, `${field} must be text`);
  }

  const text = value.trim();

  if (!text) {
    if (required) {
      throw new AppError(400, `${field} is required`);
    }

    return null;
  }

  if (text.length > maxLength) {
    throw new AppError(400, `${field} must be ${maxLength} characters or less`);
  }

  return text;
};

// The phone makes this key itself; a bad one means a broken or stale page,
// which is nothing a guest can fix but a reload.
const readClientKey = (value, required) => {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new AppError(400, `This order is missing its id. ${REFRESH}`);
    }

    return null;
  }

  if (typeof value !== "string" || !CLIENT_KEY.test(value)) {
    throw new AppError(400, `Something went wrong sending this. ${REFRESH}`);
  }

  return value;
};

// Indian mobiles are ten digits; a country code or spaces are fine to type.
const readMobile = (value) => {
  const text = readText(value, "Mobile number", 20);

  if (text === null) {
    return null;
  }

  const compact = text.replace(/[\s-]/g, "");

  if (!/^\+?\d{10,13}$/.test(compact)) {
    throw new AppError(400, "Mobile number should be 10 digits, like 98200 11201");
  }

  return compact;
};

const readWholeNumber = (value, field, min, max) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppError(400, `${field} must be a whole number from ${min} to ${max}`);
  }

  return number;
};

const readLine = (item, index) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new AppError(400, `Dish ${index + 1} in the order is not valid`);
  }

  const addOns = item.modifierIds === undefined || item.modifierIds === null ? [] : item.modifierIds;

  if (!Array.isArray(addOns)) {
    throw new AppError(400, "Add-ons must be a list");
  }

  if (addOns.length > MAX_ADDONS) {
    throw new AppError(400, `A dish can have up to ${MAX_ADDONS} add-ons`);
  }

  const size = item.variantId ?? item.productVariantId;

  // Only ids, a quantity and a note are read. A price, a total or a discount
  // sent by the phone is never looked at — the menu decides what things cost.
  // An id that cannot be one gets the same answer as a dish or add-on the
  // menu does not have.
  return {
    productId: readId(
      item.productId,
      400,
      "One of the dishes in your order is no longer on the menu. Please refresh the menu and try again."
    ),
    variantId:
      size === undefined || size === null || size === ""
        ? null
        : readId(size, 400, "A size you chose isn't available. Please refresh the menu and try again."),
    modifierIds: addOns.map((id) =>
      readId(id, 400, "One of the add-ons you chose isn't available. Please refresh the menu and try again.")
    ),
    quantity: readWholeNumber(item.quantity, "Quantity", 1, 20),
    comboSelections: require('../../menu/services/menuServiceOptions.service').readSelections(item.comboSelections),
    notes: readText(item.notes, "Note for the chef", 200),
  };
};

const readIds = (value) => {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (typeof value !== "string") {
    throw new AppError(400, `We couldn't read which requests to show. ${REFRESH}`);
  }

  const parts = value.split(",").filter(Boolean);

  if (parts.length > 20) {
    throw new AppError(400, "Ask for up to 20 requests at a time");
  }

  return [
    ...new Set(
      parts.map((part) => readId(part, 400, `We couldn't read which requests to show. ${REFRESH}`))
    ),
  ];
};

// A request id in the address. One that cannot exist is simply not found.
const readRequestId = (value) => readId(value, 404, REQUEST_NOT_FOUND);

const menu = async (req, res) => {
  noStore(res);
  res.json({ success: true, data: await tableRequestService.getMenu(req.params.token) });
};

const placeOrder = async (req, res) => {
  const body = req.body || {};
  const items = v.requiredArray(body.items, "Items");

  if (items.length === 0) {
    throw new AppError(400, "Add at least one dish to your order");
  }

  if (items.length > MAX_LINES) {
    throw new AppError(
      400,
      `An order can have up to ${MAX_LINES} different dishes. Please send the rest as a second order.`
    );
  }

  const input = {
    clientKey: readClientKey(body.clientKey, true),
    items: items.map(readLine),
    notes: readText(body.notes, "Note for the staff", 200),
    guestName: readText(body.guestName, "Your name", 80),
    guestMobile: readMobile(body.guestMobile),
  };

  const { request, duplicate } = await tableRequestService.placeOrder(req.params.token, input);

  noStore(res);
  // The same key twice is the same order: 200 and the request it made, not a
  // second 201.
  res.status(duplicate ? 200 : 201).json({
    success: true,
    message: "Your order has been sent to the staff",
    data: request,
  });
};

const requests = async (req, res) => {
  noStore(res);
  res.json({
    success: true,
    data: await tableRequestService.getRequests(req.params.token, readIds(req.query.ids)),
  });
};

const request = async (req, res) => {
  const id = readRequestId(req.params.id);

  noStore(res);
  res.json({ success: true, data: await tableRequestService.getRequest(req.params.token, id) });
};

const cancel = async (req, res) => {
  const id = readRequestId(req.params.id);

  noStore(res);
  res.json({
    success: true,
    message: "Cancelled",
    data: await tableRequestService.cancelRequest(req.params.token, id),
  });
};

const call = async (req, res) => {
  const body = req.body || {};
  if (!CALL_TYPES.includes(body.type)) {
    throw new AppError(400, `We couldn't tell what you'd like from the staff. ${REFRESH}`);
  }

  const type = body.type;

  const input = {
    type,
    clientKey: readClientKey(body.clientKey, false),
    message:
      type === "other"
        ? readText(body.message, "What you need", 120, { required: true })
        : readText(body.message, "Message", 120),
  };

  const result = await tableRequestService.callStaff(req.params.token, input);

  noStore(res);
  res.status(result.repeated || result.duplicate ? 200 : 201).json({
    success: true,
    message: result.message,
    data: { ...result.request, repeated: result.repeated },
  });
};

const feedback = async (req, res) => {
  const body = req.body || {};

  const input = {
    rating: readWholeNumber(body.rating, "Rating", 1, 5),
    comment: readText(body.comment, "Comment", 500),
    name: readText(body.name, "Your name", 80),
    mobile: readMobile(body.mobile),
  };

  const result = await tableRequestService.leaveFeedback(req.params.token, input);

  noStore(res);
  res.status(result.duplicate ? 200 : 201).json({
    success: true,
    message: "Thank you for your feedback",
    data: { id: result.id },
  });
};

// ---------------------------------------------------------------- the online ordering page

const PAYMENT_MODES = ["pay_at_pickup", "cash_on_delivery", "online"];

const onlineMenu = async (req, res) => {
  const service = onlineOrderService.SERVICES.includes(req.query.service) ? req.query.service : null;

  noStore(res);
  res.json({ success: true, data: await onlineOrderService.getMenu(req.params.token, service) });
};

// A guest ordering from home is someone the restaurant has to call back and
// a rider has to find: a name, a reachable Indian mobile and, for a delivery,
// an address are required — not optional as at a table.
const readGuestMobile = (value) => {
  const text = readText(value, "Mobile number", 20, { required: true });
  const mobile = normaliseMobile(text);

  if (!mobile || mobile.startsWith("+")) {
    throw new AppError(400, "Mobile number should be a 10-digit Indian mobile, like 98200 11201");
  }

  return mobile;
};

// What the guest agreed to on the page (bills on WhatsApp, offers), with the
// notice it showed them; recorded once the restaurant accepts the order.
const GUEST_CONSENTS = ["bills_digital", "offers"];
const readGuestConsents = (body) => {
  const list = body.consents === undefined || body.consents === null ? [] : v.requiredArray(body.consents, "Consents");
  const consents = [...new Set(list)];

  for (const purpose of consents) {
    v.requiredEnum(purpose, "Consent", GUEST_CONSENTS);
  }

  if (!consents.length) {
    return { privacyConsents: [], privacyNoticeId: null };
  }

  return { privacyConsents: consents, privacyNoticeId: v.requiredId(body.privacyNoticeId, "The privacy notice shown") };
};

const placeOnlineOrder = async (req, res) => {
  const body = req.body || {};
  const items = v.requiredArray(body.items, "Items");

  if (items.length === 0) {
    throw new AppError(400, "Add at least one dish to your order");
  }

  if (items.length > MAX_LINES) {
    throw new AppError(400, `An order can have up to ${MAX_LINES} different dishes. Please call us for a bigger order.`);
  }

  if (!onlineOrderService.SERVICES.includes(body.service)) {
    throw new AppError(400, "Choose takeaway or delivery");
  }

  if (!PAYMENT_MODES.includes(body.paymentMode)) {
    throw new AppError(400, "Choose how you'll pay");
  }

  if (body.paymentMode === "online") {
    throw new AppError(
      400,
      "Online payment isn't available yet — the restaurant hasn't connected a payment gateway. Please choose to pay on collection or cash on delivery."
    );
  }

  const guestName = readText(body.guestName, "Your name", 80, { required: true });

  if (guestName.length < 2) {
    throw new AppError(400, "Please give your name, so the restaurant knows whose order it is");
  }

  const input = {
    clientKey: readClientKey(body.clientKey, true),
    service: body.service,
    paymentMode: body.paymentMode,
    items: items.map(readLine),
    notes: readText(body.notes, "Note for the restaurant", 200),
    guestName,
    guestMobile: readGuestMobile(body.guestMobile),
    address: body.service === "delivery" ? readText(body.address, "Delivery address", 500) : null,
    landmark: body.service === "delivery" ? readText(body.landmark, "Landmark", 200) : null,
    ...readGuestConsents(body),
  };

  if (input.address && input.address.length < 10) {
    throw new AppError(400, "Please give the full delivery address: house or flat, street and area.");
  }

  const result = await onlineOrderService.placeOrder(req.params.token, input);

  noStore(res);
  res.status(result.duplicate ? 200 : 201).json({
    success: true,
    message: "Your order has been sent to the restaurant",
    data: { guestToken: result.guestToken, order: result.order },
  });
};

const onlineOrder = async (req, res) => {
  noStore(res);
  res.json({ success: true, data: await onlineOrderService.getOrder(req.params.guestToken) });
};

const cancelOnlineOrder = async (req, res) => {
  noStore(res);
  res.json({
    success: true,
    message: "Your order has been cancelled",
    data: await onlineOrderService.cancelOrder(req.params.guestToken),
  });
};

module.exports = {
  onlineMenu,
  placeOnlineOrder,
  onlineOrder,
  cancelOnlineOrder,
  menu,
  placeOrder,
  requests,
  request,
  cancel,
  call,
  feedback,
};
