const stockTransferService = require("../services/stockTransfer.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { readDate } = require("../../../../utils/calendarDate");

// Transfer notes and indents. The outlet a person is tied to
// comes from resolveOutlet; such a person works with their own store only.
const pinnedOutlet = (req) => (req.outletPinned ? req.outletId : null);

const readStore = (value, field) =>
  value === undefined || value === null || value === "" || value === "main" ? null : v.requiredId(value, field);

const readLines = (value, { indent = false } = {}) =>
  v.requiredArray(value, "Items").map((line) => ({
    inventoryItemId: v.requiredId(line?.inventoryItemId, "Item"),
    quantity: v.requiredNumber(line?.quantity ?? 0, "Quantity", { min: 0, max: 9999999 }),
    ...(indent ? { note: v.optionalString(line?.note, "Note", 200) } : {}),
  }));

const STATUSES = ["in_transit", "received", "cancelled"];

// The dates and page a list asks for: ?from=&to= (both optional) and ?offset=.
const readPage = (query) => {
  const from = readDate(query.from, "From");
  const to = readDate(query.to, "To");

  if (from && to && from > to) {
    throw new AppError(400, "The start date must be on or before the end date");
  }

  return { from, to, offset: v.optionalNumber(query.offset, "Offset", { min: 0, max: 1000000 }) ?? 0 };
};

const listTransfers = async (req, res) => {
  const filters = {
    status: v.enumList(req.query.status, "Status", STATUSES),
    direction: v.optionalEnum(req.query.direction, "Direction", ["in", "out"], null),
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 500 }) ?? 100,
    ...readPage(req.query),
  };

  res.json({
    success: true,
    data: await stockTransferService.listTransfers(req.user.restaurantId, filters, { pinnedOutletId: pinnedOutlet(req) }),
  });
};

const getTransfer = async (req, res) => {
  const id = v.requiredId(req.params.id, "Transfer id");

  res.json({
    success: true,
    data: await stockTransferService.getTransfer(req.user.restaurantId, id, { pinnedOutletId: pinnedOutlet(req) }),
  });
};

const dispatch = async (req, res) => {
  const body = req.body || {};
  const data = {
    fromOutletId: readStore(body.fromOutletId, "From"),
    toOutletId: readStore(body.toOutletId, "To"),
    lines: readLines(body.lines),
    vehicle: v.optionalString(body.vehicle, "Vehicle or driver", 60),
    notes: v.optionalString(body.notes, "Notes", 500),
  };

  const transfer = await stockTransferService.dispatch(req.user.restaurantId, data, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "dispatch", "stock_transfer", {
    id: transfer.id,
    label: transfer.transferNumber,
    details: {
      from: transfer.fromName,
      to: transfer.toName,
      lines: transfer.lines.length,
      value: transfer.sentValue,
      inTransit: transfer.status === "in_transit",
    },
  });

  res.status(201).json({
    success: true,
    message:
      transfer.status === "in_transit"
        ? `${transfer.transferNumber} sent to ${transfer.toName} — in transit until ${transfer.toName} confirms what arrived`
        : `${transfer.transferNumber}: stock moved to ${transfer.toName}`,
    data: transfer,
  });
};

const receive = async (req, res) => {
  const id = v.requiredId(req.params.id, "Transfer id");
  const body = req.body || {};
  const data = {
    lines: v.requiredArray(body.lines, "Lines").map((line) => ({
      lineId: v.requiredId(line?.lineId, "Line"),
      receivedQuantity: v.requiredNumber(line?.receivedQuantity, "Quantity received", { min: 0, max: 9999999 }),
      shortfallReason: v.optionalEnum(line?.shortfallReason, "Why it was short", stockTransferService.REASONS, null),
      shortfallNote: v.optionalString(line?.shortfallNote, "Note", 200),
    })),
    note: v.optionalString(body.note, "Note", 500),
  };

  const transfer = await stockTransferService.receive(req.user.restaurantId, id, data, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "receive", "stock_transfer", {
    id: transfer.id,
    label: transfer.transferNumber,
    details: {
      from: transfer.fromName,
      to: transfer.toName,
      received: transfer.receivedValue,
      shortfall: transfer.shortfallValue,
      ...(transfer.shortfallValue > 0
        ? {
            short: transfer.lines
              .filter((line) => line.shortfallQuantity > 0)
              .map((line) => `${line.itemName}: ${line.shortfallQuantity} ${line.unit} ${line.shortfallReason}`),
          }
        : {}),
    },
  });

  res.json({
    success: true,
    message:
      transfer.shortfallValue > 0
        ? `${transfer.transferNumber} received. What was short or damaged is written off at ${transfer.toName}.`
        : `${transfer.transferNumber} received in full`,
    data: transfer,
  });
};

const cancel = async (req, res) => {
  const id = v.requiredId(req.params.id, "Transfer id");
  const reason = v.requiredString(req.body?.reason, "Reason", 200);
  const transfer = await stockTransferService.cancel(req.user.restaurantId, id, reason, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "cancel", "stock_transfer", {
    id: transfer.id,
    label: transfer.transferNumber,
    details: { reason, from: transfer.fromName, to: transfer.toName, value: transfer.sentValue },
  });

  res.json({ success: true, message: `${transfer.transferNumber} cancelled — the stock is back at ${transfer.fromName}`, data: transfer });
};

// --- Indents ---

const INDENT_STATUSES = ["requested", "part_sent", "sent", "closed", "cancelled"];

const listIndents = async (req, res) => {
  const filters = {
    status: v.enumList(req.query.status, "Status", INDENT_STATUSES),
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 500 }) ?? 100,
    ...readPage(req.query),
  };

  res.json({
    success: true,
    data: await stockTransferService.listIndents(req.user.restaurantId, filters, { pinnedOutletId: pinnedOutlet(req) }),
  });
};

const getIndent = async (req, res) => {
  const id = v.requiredId(req.params.id, "Indent id");

  res.json({
    success: true,
    data: await stockTransferService.getIndent(req.user.restaurantId, id, { pinnedOutletId: pinnedOutlet(req) }),
  });
};

const createIndent = async (req, res) => {
  const body = req.body || {};
  const data = {
    outletId: body.outletId === undefined ? req.outletId || null : readStore(body.outletId, "Outlet"),
    supplyOutletId: readStore(body.supplyOutletId, "Store to ask"),
    neededBy: readDate(body.neededBy, "Needed by"),
    notes: v.optionalString(body.notes, "Notes", 500),
    lines: readLines(body.lines, { indent: true }),
  };

  const indent = await stockTransferService.createIndent(req.user.restaurantId, data, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "create", "stock_indent", {
    id: indent.id,
    label: indent.indentNumber,
    details: { outlet: indent.outletName, from: indent.supplyName, lines: indent.lines.length },
  });

  res.status(201).json({
    success: true,
    message: `${indent.indentNumber} sent to ${indent.supplyName}`,
    data: indent,
  });
};

const fulfilIndent = async (req, res) => {
  const id = v.requiredId(req.params.id, "Indent id");
  const body = req.body || {};
  const data = {
    lines: readLines(body.lines),
    vehicle: v.optionalString(body.vehicle, "Vehicle or driver", 60),
    notes: v.optionalString(body.notes, "Notes", 500),
  };

  const transfer = await stockTransferService.fulfilIndent(req.user.restaurantId, id, data, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "dispatch", "stock_transfer", {
    id: transfer.id,
    label: transfer.transferNumber,
    details: { indent: transfer.indentNumber, from: transfer.fromName, to: transfer.toName, value: transfer.sentValue },
  });

  res.status(201).json({
    success: true,
    message: `${transfer.transferNumber} sent against ${transfer.indentNumber}`,
    data: transfer,
  });
};

const closeIndent = (kind) => async (req, res) => {
  const id = v.requiredId(req.params.id, "Indent id");
  const reason =
    kind === "closed" ? v.requiredString(req.body?.reason, "Why the rest is not coming", 200) : v.optionalString(req.body?.reason, "Reason", 200);

  if (kind !== "closed" && kind !== "cancelled") {
    throw new AppError(400, "Unknown step");
  }

  const indent = await stockTransferService.closeIndent(req.user.restaurantId, id, kind, reason, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, kind === "closed" ? "close" : "cancel", "stock_indent", {
    id: indent.id,
    label: indent.indentNumber,
    details: { reason },
  });

  res.json({
    success: true,
    message: kind === "closed" ? `${indent.indentNumber} closed — the rest will not be sent` : `${indent.indentNumber} withdrawn`,
    data: indent,
  });
};

module.exports = {
  listTransfers,
  getTransfer,
  dispatch,
  receive,
  cancel,
  listIndents,
  getIndent,
  createIndent,
  fulfilIndent,
  closeIndent,
};
