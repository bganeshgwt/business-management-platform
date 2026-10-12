const inventoryInsightService = require("../services/inventoryInsight.service");
const inventoryService = require("../services/inventory.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const missing = (value) => value === undefined || value === null || value === "";

// The outlet a person is tied to (resolveOutlet), or null: a pinned person's
// waste and reorder figures are their own store's only.
const pinnedOutlet = (req) => (req.outletPinned ? req.outletId : null);

// The store the waste and reorder figures are for: the store of the outlet
// the request works in, whether the person is tied to it or picked it in the
// switcher — its own store when it keeps one, else the main store it sells
// from. "All outlets" is every store. Picking an outlet that sells from the
// main store used to change nothing, so the figures still counted the other
// branches' own stores (MV-6); now they are the main store's, the shelf that
// outlet's kitchen actually uses, and the screen says so.
const viewStore = async (req) => {
  if (!req.outletId) {
    return null;
  }

  return inventoryService.pinnedStore(req.user.restaurantId, req.outletId);
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// A real calendar date. Date.parse takes "2026-02-30" and quietly rolls it on
// to 2 March, which Postgres then refuses with a server error, so the date is
// rebuilt from its parts and must come back unchanged. The years are bounded
// because the report also reads the period before the range, and "0000" has no
// period before it.
const optionalDate = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parts = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  const [year, month, day] = parts ? parts.slice(1).map(Number) : [];
  const rebuilt = parts ? new Date(Date.UTC(year, month - 1, day)) : null;

  if (
    !rebuilt ||
    year < 1900 ||
    year > 2999 ||
    rebuilt.getUTCFullYear() !== year ||
    rebuilt.getUTCMonth() !== month - 1 ||
    rebuilt.getUTCDate() !== day
  ) {
    throw new AppError(400, `${field} must be a date like 2026-09-18`);
  }

  return value;
};

// A database id: a whole number the database can hold. 1.5 or 1e20 pass a
// plain "is it a number" check and then fail inside Postgres as a server
// error, so anything else is answered here — as not found, which is what it is.
const readId = (value) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
};

// The list's page size: a whole number, since it becomes a LIMIT.
const readLimit = (value) => {
  if (value === undefined || value === null || value === "") {
    return 100;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError(400, "Limit must be a whole number from 1 to 500");
  }

  return limit;
};

// The most lines one draft may carry: a supplier card holds a few dozen at
// most, and a bigger list is a mistake or a script.
const MAX_DRAFT_LINES = 200;

// Whole days only: "cover for 7.5 days" is not a plan anyone makes.
const readHorizon = (value) => {
  if (value === undefined || value === null || value === "") {
    return inventoryInsightService.DEFAULT_HORIZON;
  }

  const horizon = Number(value);

  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 30) {
    throw new AppError(400, "Days to cover must be a whole number from 1 to 30");
  }

  return horizon;
};

// --- Wastage ---

const wastage = async (req, res) => {
  const itemId = missing(req.query.itemId) ? null : readId(req.query.itemId);

  if (!missing(req.query.itemId) && itemId === null) {
    throw new AppError(400, "The item filter must be an item's id, a whole number");
  }

  const filters = {
    from: optionalDate(req.query.from, "From"),
    to: optionalDate(req.query.to, "To"),
    reason: req.query.reason
      ? v.requiredEnum(req.query.reason, "Reason", [...inventoryInsightService.REASON_KEYS, "unspecified"])
      : null,
    itemId,
    limit: readLimit(req.query.limit),
  };

  res.json({
    success: true,
    data: await inventoryInsightService.wastageReport(req.user.restaurantId, filters, {
      store: await viewStore(req),
    }),
  });
};

// One page of the wastage log (the screen's grid pages through it).
const wastageEntries = async (req, res) => {
  const itemId = missing(req.query.itemId) ? null : readId(req.query.itemId);

  if (!missing(req.query.itemId) && itemId === null) {
    throw new AppError(400, "The item filter must be an item's id, a whole number");
  }

  const offset = missing(req.query.offset) ? 0 : Number(req.query.offset);

  if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) {
    throw new AppError(400, "Offset must be a whole number, 0 or more");
  }

  const filters = {
    from: optionalDate(req.query.from, "From"),
    to: optionalDate(req.query.to, "To"),
    reason: req.query.reason
      ? v.requiredEnum(req.query.reason, "Reason", [...inventoryInsightService.REASON_KEYS, "unspecified"])
      : null,
    itemId,
    limit: readLimit(req.query.limit),
    offset,
  };

  res.json({
    success: true,
    data: await inventoryInsightService.wastageEntries(req.user.restaurantId, filters, {
      store: await viewStore(req),
    }),
  });
};

// Worded for the person at the pass, not for a developer: "Item must be a
// number" tells a cook nothing when what happened is they forgot to pick one.
const readWastage = (body) => {
  if (missing(body.inventoryItemId)) {
    throw new AppError(400, "Pick the item that was thrown away");
  }

  const inventoryItemId = readId(body.inventoryItemId);

  if (inventoryItemId === null) {
    throw new AppError(400, "Selected item does not exist");
  }

  if (missing(body.quantity)) {
    throw new AppError(400, "Enter how much was thrown away");
  }

  const quantity = v.requiredNumber(body.quantity, "Quantity");

  if (quantity <= 0) {
    throw new AppError(400, "The quantity thrown away must be more than zero");
  }

  if (quantity > 99999) {
    throw new AppError(400, "That quantity is too large — check the unit");
  }

  if (!inventoryInsightService.REASON_KEYS.includes(body.reason)) {
    throw new AppError(
      400,
      `Pick why it was thrown away: ${inventoryInsightService.REASONS.map((reason) => reason.label.toLowerCase()).join(", ")}`
    );
  }

  return {
    inventoryItemId,
    // Stock is held to three decimals. Rounded here, and the service refuses
    // anything that rounds away to nothing, naming the item's unit — so 0.0001
    // is a sentence for the cook, not a zero-quantity row the ledger rejects.
    quantity: Math.round(quantity * 1000) / 1000,
    reason: body.reason,
    note: v.optionalString(body.note, "Note", 300),
  };
};

// The entry as the request describes it, checked in full (writeoffApproval
// runs this before deciding whether a manager must approve). The item comes
// from the address on /items/:itemId/wastage — that is what ties a manager's
// approval to the item — and from the body otherwise. The outlet comes from
// resolveOutlet (the one the cook is tied to, or the one picked in the
// switcher), never from the body.
const prepareWastage = async (req) => {
  const body = { ...(req.body || {}) };

  if (req.params.itemId !== undefined) {
    const fromAddress = readId(req.params.itemId);

    if (fromAddress === null) {
      throw new AppError(404, "Item not found");
    }

    if (!missing(body.inventoryItemId) && readId(body.inventoryItemId) !== fromAddress) {
      throw new AppError(400, "The item in the request does not match the item in its address");
    }

    body.inventoryItemId = fromAddress;
  }

  const data = { ...readWastage(body), outletId: req.outletId || null };
  const checked = await inventoryInsightService.checkWastage(req.user.restaurantId, data);

  return { data, quantity: data.quantity, value: checked.value };
};

const logWastage = async (req, res) => {
  const data = (req.prepared && req.prepared.data) || (await prepareWastage(req)).data;

  const result = await inventoryInsightService.logWastage(req.user.restaurantId, data, req.user.id);

  logAction(req, "wastage", "inventory_item", {
    id: result.item.id,
    label: result.item.name,
    details: {
      quantity: data.quantity,
      unit: result.item.unit,
      reason: data.reason,
      value: result.entry.value,
      entryId: result.entry.id,
      store: result.entry.store || "Main store",
      // Over the write-off limit: the limit it was over (the approving
      // manager is written on the row by logAction).
      ...(req.writeoff ? { overLimit: req.writeoff.limit } : {}),
    },
  });

  res.status(201).json({
    success: true,
    message: `${data.quantity} ${result.item.unit} of ${result.item.name} written off`,
    data: result,
  });
};

const reverseWastage = async (req, res) => {
  const id = readId(req.params.id);

  // "/wastage/1.5/reverse" names no entry at all — the same answer as an id
  // that belongs to nobody, or to another restaurant.
  if (id === null) {
    throw new AppError(404, "Wastage entry not found");
  }

  const note = v.optionalString(req.body?.note, "Note", 300);

  const result = await inventoryInsightService.reverseWastage(req.user.restaurantId, id, note, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "wastage_reversed", "inventory_item", {
    id: result.item.id,
    label: result.item.name,
    details: { entryId: id, quantity: result.entry.quantity, note },
  });

  res.json({
    success: true,
    message: `Put ${result.entry.quantity} ${result.item.unit} of ${result.item.name} back in stock`,
    data: result,
  });
};

// --- Reorder ---

const reorder = async (req, res) => {
  res.json({
    success: true,
    data: await inventoryInsightService.reorder(req.user.restaurantId, {
      horizon: readHorizon(req.query.horizon),
      store: await viewStore(req),
    }),
  });
};

const createDraftOrder = async (req, res) => {
  const body = req.body || {};

  if (missing(body.supplierId)) {
    throw new AppError(400, "Pick the supplier to send this order to");
  }

  const supplierId = readId(body.supplierId);

  if (supplierId === null) {
    throw new AppError(400, "Selected supplier does not exist");
  }

  const lines = v.requiredArray(body.lines, "Lines");

  if (lines.length > MAX_DRAFT_LINES) {
    throw new AppError(400, `A draft can hold up to ${MAX_DRAFT_LINES} items — split the order in two`);
  }

  // Only the item and how much. There is deliberately no price here: the
  // draft is priced from the supplier's own history on the server.
  const data = {
    supplierId,
    // Someone tied to one outlet plans for its store; the order is theirs.
    // A plan made for an outlet's own store is delivered there too.
    outletId: pinnedOutlet(req) || ((await viewStore(req)) || {}).outletId || null,
    horizon: readHorizon(body.horizon),
    lines: lines.map((line) => {
      const inventoryItemId = readId(line?.inventoryItemId);

      if (inventoryItemId === null) {
        throw new AppError(400, "One of the selected items does not exist");
      }

      if (missing(line.quantity)) {
        throw new AppError(400, "Enter a quantity for every item, or 0 to leave it off");
      }

      return {
        inventoryItemId,
        quantity: v.requiredNumber(line.quantity, "Quantity", { min: 0, max: 9999999 }),
      };
    }),
  };

  const { order, unpriced } = await inventoryInsightService.createDraftOrder(
    req.user.restaurantId,
    data,
    req.user.id
  );

  logAction(req, "create", "purchase_order", {
    id: order.id,
    label: order.poNumber,
    details: { source: "reorder_suggestions", horizon: data.horizon, lines: order.items.length },
  });

  res.status(201).json({
    success: true,
    message: `Draft ${order.poNumber} created for ${order.supplierName}`,
    data: { order, unpriced },
  });
};

const summary = async (req, res) => {
  res.json({
    success: true,
    data: await inventoryInsightService.summary(req.user.restaurantId, new Date(), {
      store: await viewStore(req),
    }),
  });
};

module.exports = {
  wastage,
  wastageEntries,
  prepareWastage,
  logWastage,
  reverseWastage,
  reorder,
  createDraftOrder,
  summary,
};
