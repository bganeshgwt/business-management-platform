// The staff side of table requests: the inbox a captain works from on the
// floor. Every query is scoped by the restaurant on the caller's token, and
// by the outlet they are working in (req.outletId, set by resolveOutlet): a
// captain tied to one branch neither sees nor answers another branch's tables.
const tableRequestService = require("../services/tableRequest.service");
const restaurantFeatures = require("../../setup/services/restaurantFeatures.service");
const AppError = require("../../../../utils/AppError");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const { maskMobile } = require("../../../../utils/phone");

// pending and today are the live inbox (today only); history is "Earlier
// days", a date range; all is every request (API only).
const VIEWS = ["pending", "today", "history", "all"];
// online: orders from the restaurant's own ordering page (SW-A-22).
const TYPES = ["order", "service", "online"];

const CALL_NAMES = {
  call_waiter: "call for a waiter",
  bill: "request for the bill",
  water: "request for water",
  other: "request",
};

const SERVICE_NAMES = { takeaway: "takeaway", delivery: "delivery" };

// "Online delivery order from Priya" — a website order has no table.
const label = (request) => {
  if (request.channel === "website") {
    return `Online ${SERVICE_NAMES[request.serviceType]} order from ${request.guestName || "a guest"}`;
  }

  return request.type === "order"
    ? `QR order from table ${request.tableNo}`
    : `${CALL_NAMES[request.type]} from table ${request.tableNo}`;
};

const acceptedMessage = (result) => {
  if (result.request.channel === "website") {
    return `Accepted — ${result.order.orderNumber} opened for ${result.request.guestName || "the guest"}'s online ${
      result.request.serviceType === "delivery" ? "delivery" : "takeaway"
    }`;
  }

  return result.action === "created"
    ? `Accepted — ${result.order.orderNumber} opened for table ${result.request.tableNo}`
    : `Accepted — added to ${result.order.orderNumber} on table ${result.request.tableNo}`;
};

// The request id in the address. Anything that cannot be an id — 1.5, 1e20,
// a number past what the column holds — is a request that does not exist,
// said before it reaches the database rather than as a server error.
const readId = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  const number = /^\d{1,16}$/.test(text) ? Number(text) : NaN;

  if (!Number.isSafeInteger(number) || number < 1) {
    throw new AppError(404, "Request not found");
  }

  return number;
};

// How many cards to send: a whole number, so "1.5" is refused as such.
const readLimit = (value) => {
  if (value === undefined || value === null || value === "") {
    return 200;
  }

  const number = typeof value === "string" && /^\d{1,4}$/.test(value.trim()) ? Number(value) : NaN;

  if (!Number.isInteger(number) || number < 1 || number > 500) {
    throw new AppError(400, "Limit must be a whole number from 1 to 500");
  }

  return number;
};

// Where a page of the list starts: a whole number, 0 for the first page.
const readOffset = (value) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const number = typeof value === "string" && /^\d{1,7}$/.test(value.trim()) ? Number(value) : NaN;

  if (!Number.isInteger(number) || number < 0) {
    throw new AppError(400, "Offset must be a whole number, 0 or more");
  }

  return number;
};

// A calendar date, "2026-10-01". Rebuilt from its parts and compared, so a
// day that does not exist (30 February) is refused rather than rolled on.
const readDate = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
  const [year, month, day] = match ? match.slice(1).map(Number) : [];
  const rebuilt = match ? new Date(Date.UTC(year, month - 1, day)) : null;

  if (
    !rebuilt ||
    year < 2000 ||
    year > 2100 ||
    rebuilt.getUTCMonth() !== month - 1 ||
    rebuilt.getUTCDate() !== day
  ) {
    throw new AppError(400, `${field} must be a date like 2026-10-01`);
  }

  return match[0];
};

// Text a person types. A number or a list where words belong is refused as
// what it is, not as "required".
const readText = (value, field, maxLength, required) => {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new AppError(400, `${field} must be text`);
  }

  return required
    ? v.requiredString(value, field, maxLength)
    : v.optionalString(value, field, maxLength);
};

const outletOf = (req) => req.outletId || null;

const can = (req, permission) => (req.user.permissions || []).includes(permission);

// A guest's mobile is guest-book detail. Staff who may see guests' full
// contact details (customers.contact) get it whole; everyone else working
// the inbox sees the last four digits, which is enough to say "the order
// from the guest ending 4823". Walking to the table needs no number.
const forViewer = (req) => {
  if (can(req, "customers.contact")) {
    return (request) => request;
  }

  return (request) =>
    request && request.guestMobile ? { ...request, guestMobile: maskMobile(request.guestMobile) } : request;
};

// The inboxes switched on (Settings -> Features): a table's QR code and the
// online ordering page each bring requests here.
const channelsOf = (req) => [
  ...(restaurantFeatures.has(req.user, "qr_ordering") ? ["qr"] : []),
  ...(restaurantFeatures.has(req.user, "online_ordering") ? ["website"] : []),
];

const list = async (req, res) => {
  const filters = {
    channels: channelsOf(req),
    view: v.optionalEnum(req.query.view, "View", VIEWS, "pending"),
    type: v.optionalEnum(req.query.type, "Type", TYPES, null),
    limit: readLimit(req.query.limit),
    offset: readOffset(req.query.offset),
    from: readDate(req.query.from, "From"),
    to: readDate(req.query.to, "To"),
    outletId: outletOf(req),
  };

  if (filters.from && filters.to && filters.from > filters.to) {
    throw new AppError(400, "The From date must be on or before the To date");
  }

  const data = await tableRequestService.list(req.user.restaurantId, filters);

  res.json({ success: true, data: { ...data, items: data.items.map(forViewer(req)) } });
};

// The rupee value of the QR orders accepted today is takings: only for
// people whose role lets them see sales figures (sales.view).
const summary = async (req, res) => {
  const data = await tableRequestService.getSummary(req.user.restaurantId, outletOf(req), channelsOf(req));

  if (!can(req, "sales.view")) {
    delete data.acceptedValueToday;
  }

  res.json({ success: true, data });
};

const getById = async (req, res) => {
  const id = readId(req.params.id);

  res.json({
    success: true,
    data: forViewer(req)(await tableRequestService.getById(req.user.restaurantId, id, outletOf(req))),
  });
};

const accept = async (req, res) => {
  const id = readId(req.params.id);

  const result = await tableRequestService.accept(
    req.user.restaurantId,
    id,
    req.user.id,
    outletOf(req)
  );

  logAction(req, "accept", "table_request", {
    id,
    label: label(result.request),
    details: {
      orderId: result.order.id,
      orderNumber: result.order.orderNumber,
      action: result.action,
      estimatedTotal: result.request.estimatedTotal,
    },
  });

  res.json({
    success: true,
    message: acceptedMessage(result),
    data: { ...result, request: forViewer(req)(result.request) },
  });
};

const reject = async (req, res) => {
  const id = readId(req.params.id);
  const reason = readText(req.body?.reason, "Reason for the guest", 200, true);

  const request = await tableRequestService.reject(
    req.user.restaurantId,
    id,
    reason,
    req.user.id,
    outletOf(req)
  );

  logAction(req, "reject", "table_request", {
    id,
    label: label(request),
    details: { reason, estimatedTotal: request.estimatedTotal },
  });

  res.json({ success: true, message: "Rejected — the guest will see your reason", data: forViewer(req)(request) });
};

const acknowledge = async (req, res) => {
  const id = readId(req.params.id);

  const request = await tableRequestService.acknowledge(
    req.user.restaurantId,
    id,
    req.user.id,
    outletOf(req)
  );

  res.json({
    success: true,
    message: `On it — table ${request.tableNo} can see someone is coming`,
    data: forViewer(req)(request),
  });
};

// POST /close-earlier { reason }: every QR order an earlier day left waiting
// rejected with the reason, every call from then marked done.
const closeEarlier = async (req, res) => {
  const reason = readText(req.body?.reason, "Reason for the guest", 200, false) || "Not taken: sent on an earlier day";
  const result = await tableRequestService.closeEarlier(
    req.user.restaurantId,
    reason,
    req.user.id,
    outletOf(req),
    channelsOf(req)
  );

  logAction(req, "close_earlier", "table_request", { details: { reason, ...result } });

  const parts = [
    result.rejected > 0 ? `${result.rejected} ${result.rejected === 1 ? "order" : "orders"} rejected` : null,
    result.done > 0 ? `${result.done} ${result.done === 1 ? "call" : "calls"} closed` : null,
  ].filter(Boolean);

  res.json({
    success: true,
    message: parts.length > 0 ? `${parts.join(" and ")} from earlier days.` : "Nothing from earlier days was waiting.",
    data: result,
  });
};

const done = async (req, res) => {
  const id = readId(req.params.id);

  const request = await tableRequestService.markDone(
    req.user.restaurantId,
    id,
    req.user.id,
    outletOf(req)
  );

  res.json({ success: true, message: `Done — table ${request.tableNo}`, data: forViewer(req)(request) });
};

const getSettings = async (req, res) => {
  res.json({ success: true, data: await tableRequestService.getSettings(req.user.restaurantId) });
};

const updateSettings = async (req, res) => {
  const body = req.body || {};

  const data = {
    orderingEnabled: v.requiredBoolean(body.orderingEnabled, "Guests can order", true),
    callsEnabled: v.requiredBoolean(body.callsEnabled, "Guests can call staff", true),
    guestNote: readText(body.guestNote, "Note for guests", 200, false),
  };

  const settings = await tableRequestService.updateSettings(req.user.restaurantId, data, req.user.id);

  logAction(req, "update", "table_request_settings", {
    label: "QR ordering settings",
    details: data,
  });

  res.json({ success: true, message: "QR ordering settings saved", data: settings });
};

module.exports = {
  closeEarlier,
  list,
  summary,
  getById,
  accept,
  reject,
  acknowledge,
  done,
  getSettings,
  updateSettings,
};
