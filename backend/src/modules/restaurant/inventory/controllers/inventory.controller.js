const inventoryService = require("../services/inventory.service");
// The one list of why stock is thrown away, owned by Waste & reorder (and
// matched by the database's CHECK on stock_transactions.waste_reason).
const { REASONS: WASTE_REASONS } = require("../services/inventoryInsight.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { readDate, readMoment } = require("../../../../utils/calendarDate");

const todayText = () => new Date().toLocaleDateString("en-CA");

// A blind count keeps the expected figures from the people counting. Whoever
// can post the sheet (and so correct stock) sees them — on the sheet, and on
// every other screen that shows the stock of an item being counted.
const canSeeExpected = (req) => (req.user.permissions || []).includes("inventory.manage");

// The outlet a person is tied to (resolveOutlet), or null for owners and
// managers who are not. A pinned person works with that outlet's stock only;
// the service refuses another store and narrows every list to theirs.
const pinnedOutlet = (req) => (req.outletPinned ? req.outletId : null);

// A list of short texts from the query string ("Dairy,Vegetables") or a body
// array. An empty entry means "not set" (no category, no storage area).
const readTextList = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  const list = Array.isArray(value) ? value : String(value).split(",");

  return list.map((entry) => {
    if (typeof entry !== "string") {
      throw new AppError(400, `${field} must be a list of names`);
    }

    const text = entry.trim();

    if (text.length > 50) {
      throw new AppError(400, `${field} entries must be 50 characters or less`);
    }

    return text;
  });
};

// --- Units ---

const readUnitBody = (body = {}) => ({
  name: v.requiredString(body.name, "Unit name", 50),
  shortName: v.requiredString(body.shortName, "Short name", 10),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

const listUnits = async (req, res) => {
  res.json({ success: true, data: await inventoryService.listUnits(req.user.restaurantId) });
};

const createUnit = async (req, res) => {
  const unit = await inventoryService.createUnit(
    req.user.restaurantId,
    readUnitBody(req.body),
    req.user.id
  );

  logAction(req, "create", "unit", { id: unit.id, label: unit.name });

  res.status(201).json({ success: true, message: "Unit created", data: unit });
};

const updateUnit = async (req, res) => {
  const id = v.requiredId(req.params.id, "Unit id");
  const unit = await inventoryService.updateUnit(
    req.user.restaurantId,
    id,
    readUnitBody(req.body),
    req.user.id
  );

  logAction(req, "update", "unit", { id: unit.id, label: unit.name });

  res.json({ success: true, message: "Unit updated", data: unit });
};

const removeUnit = async (req, res) => {
  const id = v.requiredId(req.params.id, "Unit id");

  await inventoryService.removeUnit(req.user.restaurantId, id);

  logAction(req, "delete", "unit", { id });

  res.json({ success: true, message: "Unit deleted" });
};

// --- Items ---

const readPacks = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  return v.requiredArray(value, "Packs").map((pack) => ({
    id: v.optionalNumber(pack?.id, "Pack", { min: 1 }),
    name: v.requiredString(pack?.name, "Pack name", 40),
    size: v.requiredNumber(pack?.size, "Pack size", { min: 0.0001, max: 9999999 }),
  }));
};

const readSupplier = (value) =>
  value === undefined ? undefined : value === null || value === "" ? null : v.requiredId(value, "Preferred supplier");

const readItemBody = (body = {}) => ({
  name: v.requiredString(body.name, "Item name", 150),
  code: body.code ? v.requiredString(body.code, "Code", 30).toUpperCase() : null,
  unitId: v.requiredId(body.unitId, "Unit"),
  category: v.optionalString(body.category, "Category", 50),
  storageArea: v.optionalString(body.storageArea, "Storage area", 50),
  itemType: v.optionalEnum(body.itemType, "Item type", ["raw", "prepared"], "raw"),
  reorderLevel: v.optionalNumber(body.reorderLevel, "Reorder level", { min: 0, max: 9999999 }) ?? 0,
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
  packs: readPacks(body.packs),
  // Left out: unchanged on an edit, none on a new item. null clears it.
  preferredSupplierId: readSupplier(body.preferredSupplierId),
});

const listItems = async (req, res) => {
  const filters = {
    // `q` is the same search under the name pickers use.
    search: v.optionalString(req.query.search ?? req.query.q, "Search", 100),
    lowOnly: req.query.lowOnly === "true",
    // A type-ahead picker asks for the first few matches only; without it,
    // every item (the stock list pages and counts them itself).
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 200 }),
    category: v.optionalString(req.query.category, "Category", 50),
    storageArea: v.optionalString(req.query.storageArea, "Storage area", 50),
  };

  res.json({
    success: true,
    data: await inventoryService.listItems(req.user.restaurantId, filters, {
      canSeeBlind: canSeeExpected(req),
      pinnedOutletId: pinnedOutlet(req),
    }),
  });
};

const createItem = async (req, res) => {
  const data = {
    ...readItemBody(req.body),
    openingStock: v.optionalNumber(req.body?.openingStock, "Opening stock", {
      min: 0,
      max: 9999999,
    }) ?? 0,
    openingCost: v.optionalNumber(req.body?.openingCost, "Cost per unit", { min: 0, max: 9999999 }),
  };

  const item = await inventoryService.createItem(req.user.restaurantId, data, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "create", "inventory_item", { id: item.id, label: item.name });

  res.status(201).json({ success: true, message: "Item created", data: item });
};

const updateItem = async (req, res) => {
  const id = v.requiredId(req.params.id, "Item id");
  const body = req.body || {};

  // Only the preferred supplier (Reorder: "Choose supplier"), without the
  // rest of the item: the item is otherwise left exactly as it is.
  if (body.name === undefined && body.unitId === undefined && body.preferredSupplierId !== undefined) {
    const item = await inventoryService.setPreferredSupplier(
      req.user.restaurantId,
      id,
      readSupplier(body.preferredSupplierId),
      req.user.id
    );

    logAction(req, "update", "inventory_item", {
      id: item.id,
      label: item.name,
      details: { preferredSupplier: item.preferredSupplierName || "none" },
    });

    return res.json({
      success: true,
      message: item.preferredSupplierName
        ? `${item.name} will be ordered from ${item.preferredSupplierName}`
        : `${item.name} has no preferred supplier now`,
      data: item,
    });
  }

  const item = await inventoryService.updateItem(
    req.user.restaurantId,
    id,
    readItemBody(req.body),
    req.user.id
  );

  logAction(req, "update", "inventory_item", { id: item.id, label: item.name });

  res.json({ success: true, message: "Item updated", data: item });
};

const replacePacks = async (req, res) => {
  const id = v.requiredId(req.params.id, "Item id");
  const item = await inventoryService.replacePacks(
    req.user.restaurantId,
    id,
    readPacks(req.body?.packs) || [],
    req.user.id
  );

  logAction(req, "update", "inventory_item", {
    id: item.id,
    label: item.name,
    details: { packs: item.packs.map((pack) => `${pack.name} = ${pack.size} ${item.unitShortName}`) },
  });

  res.json({ success: true, message: "Packs saved", data: item });
};

const removeItem = async (req, res) => {
  const id = v.requiredId(req.params.id, "Item id");

  await inventoryService.removeItem(req.user.restaurantId, id);

  logAction(req, "delete", "inventory_item", { id });

  res.json({ success: true, message: "Item deleted" });
};

// --- Stores ---

const listStores = async (req, res) => {
  res.json({
    success: true,
    data: await inventoryService.listStores(req.user.restaurantId, {
      canSeeBlind: canSeeExpected(req),
      pinnedOutletId: pinnedOutlet(req),
    }),
  });
};

const setOwnStore = async (req, res) => {
  const outletId = v.requiredId(req.params.outletId, "Outlet id");
  const ownStore = v.requiredBoolean(req.body?.ownStore, "Keeps its own stock");

  if (ownStore === undefined) {
    throw new AppError(400, "Say whether this outlet keeps its own stock");
  }

  const store = await inventoryService.setOwnStore(req.user.restaurantId, outletId, ownStore, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "update", "outlet", {
    id: outletId,
    label: store.name,
    details: { ownStore },
  });

  res.json({
    success: true,
    message: ownStore
      ? `${store.name} now keeps its own stock`
      : `${store.name} now sells from the main store`,
    data: store,
  });
};

// --- Stock movements ---

const MOVEMENT_TYPES = [
  "purchase",
  "adjustment",
  "wastage",
  "consumption",
  "transfer",
  "opening",
  "return",
];

const listMovements = async (req, res) => {
  const filters = {
    itemId: v.optionalNumber(req.query.itemId, "Item", { min: 1 }),
    type: req.query.type ? v.requiredEnum(req.query.type, "Type", MOVEMENT_TYPES) : null,
    from: readDate(req.query.from, "From"),
    to: readDate(req.query.to, "To"),
    // What the dates mean: when the goods were really on (or off) the shelf,
    // which is what "what came in on the 22nd" asks; or when the entry was
    // typed, for checking what was keyed in on a day. They differ only for a
    // bill entered days after the goods arrived.
    dateBasis: v.optionalEnum(req.query.dateBasis, "Dates", ["arrived", "entered"], "arrived"),
    store: req.query.store || null,
    search: v.optionalString(req.query.search, "Search", 60),
    // Up to 5,000 for an export; the screen asks for a page at a time.
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 5000 }) ?? 100,
    offset: v.optionalNumber(req.query.offset, "Offset", { min: 0, max: 10000000 }) ?? 0,
  };

  res.json({
    success: true,
    data: await inventoryService.listMovements(req.user.restaurantId, filters, {
      canSeeBlind: canSeeExpected(req),
      pinnedOutletId: pinnedOutlet(req),
    }),
  });
};

// Where a hand-entered movement happens: the store the person picked, or else
// the outlet they are working in (the switcher), which resolves to that
// outlet's own store or the main store.
const movementOutlet = (req, body) => {
  if (body.outletId !== undefined) {
    return {
      outletId: v.optionalNumber(body.outletId, "Store", { min: 1 }),
      outletChosen: true,
    };
  }

  return { outletId: req.outletId || null, outletChosen: false };
};

// Stock in: a positive quantity, for anything that is not a supplier's bill
// (stock found, stock returned by the kitchen). Deliveries go in as a
// purchase bill, so the supplier is owed for them.
const stockIn = async (req, res) => {
  const body = req.body || {};

  const item = await inventoryService.recordMovement(
    req.user.restaurantId,
    {
      inventoryItemId: v.requiredId(body.inventoryItemId, "Item"),
      transactionType: "adjustment",
      batchNumber: v.optionalString(body.batchNumber, "Batch number", 100),
      expiryDate: readDate(body.expiryDate, "Expiry date"),
      quantity: v.requiredNumber(body.quantity, "Quantity", { min: 0.001, max: 9999999 }),
      unitCost: v.optionalNumber(body.unitCost, "Cost per unit", { min: 0, max: 9999999 }),
      reason: v.optionalString(body.reason, "Reason", 150) || "Stock added",
      notes: v.optionalString(body.notes, "Notes", 500),
      ...movementOutlet(req, body),
    },
    req.user.id,
    { pinnedOutletId: pinnedOutlet(req) }
  );

  logAction(req, "stock_in", "inventory_item", { id: item.id, label: item.name });

  res.status(201).json({ success: true, message: "Stock added", data: item });
};

// Why wastage was thrown away, from the same list the Waste & reorder page
// uses, so waste written off here adds up by reason there. Optional on the
// API (an older caller that sends only free text still works, and shows as
// "Not given"); the Items & stock screen always asks for it.
const readWasteReason = (body, type) => {
  if (body.wasteReason === undefined || body.wasteReason === null || body.wasteReason === "") {
    return null;
  }

  if (type !== "wastage") {
    throw new AppError(400, "A reason for waste only goes with a wastage entry. Choose Wastage as the type, or leave the reason out.");
  }

  const found = WASTE_REASONS.find((reason) => reason.key === body.wasteReason);

  if (!found) {
    throw new AppError(
      400,
      `Pick why it was thrown away: ${WASTE_REASONS.map((reason) => reason.label.toLowerCase()).join(", ")}`
    );
  }

  return found;
};

// Stock out: the quantity is stored as a negative number, so the ledger sums
// to the current stock without any special cases.
//
// The request as the stock out it describes, checked in full: writeoffApproval
// runs this before deciding whether a manager must approve (over the write-off
// limit), so a PIN is never spent on a stock out that is then refused. The
// item comes from the address on /items/:id/stock-out (which ties a manager's
// approval to that item) and from the body otherwise.
const prepareStockOut = async (req) => {
  const body = { ...(req.body || {}) };

  if (req.params.id !== undefined) {
    const fromAddress = v.requiredId(req.params.id, "Item id");

    if (body.inventoryItemId !== undefined && body.inventoryItemId !== null && Number(body.inventoryItemId) !== fromAddress) {
      throw new AppError(400, "The item in the request does not match the item in its address");
    }

    body.inventoryItemId = fromAddress;
  }

  const quantity = v.requiredNumber(body.quantity, "Quantity", { min: 0.001, max: 9999999 });
  const type = v.optionalEnum(
    body.transactionType,
    "Type",
    ["adjustment", "wastage", "consumption", "transfer"],
    "adjustment"
  );
  const wasteReason = readWasteReason(body, type);
  const typed = v.optionalString(body.reason, "Reason", 150);
  const notes = v.optionalString(body.notes, "Notes", 500);

  if (wasteReason && wasteReason.key === "other" && !typed && !notes) {
    throw new AppError(400, "Say what happened when the reason is Other, so it can be followed up");
  }

  const data = {
    inventoryItemId: v.requiredId(body.inventoryItemId, "Item"),
    transactionType: type,
    quantity: -quantity,
    batchId: body.batchId ? v.requiredId(body.batchId, "Batch") : null,
    // A reasoned wastage entry reads like one from Waste & reorder: the
    // reason's name, with the person's own words as the note.
    reason: wasteReason ? wasteReason.label : typed || (type === "wastage" ? "Wastage" : "Stock removed"),
    notes: wasteReason ? [typed, notes].filter(Boolean).join(" — ") || null : notes,
    wasteReason: wasteReason ? wasteReason.key : null,
    ...movementOutlet(req, body),
  };

  const checked = await inventoryService.checkStockOut(req.user.restaurantId, data, {
    pinnedOutletId: pinnedOutlet(req),
  });

  return { data, quantity, value: checked.value, wasteReason };
};

const stockOut = async (req, res) => {
  const prepared = req.prepared || (await prepareStockOut(req));
  const { data, quantity, wasteReason } = prepared;

  const item = await inventoryService.recordMovement(req.user.restaurantId, data, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "stock_out", "inventory_item", {
    id: item.id,
    label: item.name,
    details: {
      type: data.transactionType,
      quantity,
      ...(wasteReason ? { reason: wasteReason.key } : {}),
      value: prepared.value,
      ...(req.writeoff ? { overLimit: req.writeoff.limit } : {}),
    },
  });

  res.status(201).json({ success: true, message: "Stock removed", data: item });
};

// Stock moved from one store to another.
const transfer = async (req, res) => {
  const body = req.body || {};

  const item = await inventoryService.transfer(
    req.user.restaurantId,
    {
      inventoryItemId: v.requiredId(body.inventoryItemId, "Item"),
      fromOutletId: v.optionalNumber(body.fromOutletId, "From", { min: 1 }),
      toOutletId: v.optionalNumber(body.toOutletId, "To", { min: 1 }),
      quantity: v.requiredNumber(body.quantity, "Quantity", { min: 0.001, max: 9999999 }),
      reason: v.optionalString(body.reason, "Reason", 150),
      notes: v.optionalString(body.notes, "Notes", 500),
    },
    req.user.id,
    { pinnedOutletId: pinnedOutlet(req) }
  );

  logAction(req, "transfer", "inventory_item", { id: item.id, label: item.name });

  res.status(201).json({ success: true, message: "Stock transferred", data: item });
};

const listBalances = async (req, res) => {
  const itemId = v.requiredId(req.params.id, "Item id");

  res.json({
    success: true,
    data: await inventoryService.listBalances(req.user.restaurantId, itemId, {
      canSeeBlind: canSeeExpected(req),
      pinnedOutletId: pinnedOutlet(req),
    }),
  });
};

// --- Closing stock ---

const valuation = async (req, res) => {
  const date = readDate(req.query.date, "Date", todayText());

  res.json({
    success: true,
    data: await inventoryService.valuation(
      req.user.restaurantId,
      { date, store: req.query.store || null },
      { canSeeBlind: canSeeExpected(req), pinnedOutletId: pinnedOutlet(req) }
    ),
  });
};

// --- Stock counts ---

const COUNT_REASON_CODES = Object.keys(inventoryService.COUNT_REASONS);

const listCounts = async (req, res) => {
  const filters = {
    status: v.optionalEnum(req.query.status, "Status", ["draft", "posted", "cancelled"], null),
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 200 }) ?? 100,
  };

  res.json({
    success: true,
    data: await inventoryService.listCounts(req.user.restaurantId, filters, { pinnedOutletId: pinnedOutlet(req) }),
  });
};

const getCount = async (req, res) => {
  const id = v.requiredId(req.params.id, "Count id");

  res.json({
    success: true,
    data: await inventoryService.getCount(req.user.restaurantId, id, {
      canSeeExpected: canSeeExpected(req),
      pinnedOutletId: pinnedOutlet(req),
    }),
  });
};

const readCountedAt = (value) => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  const at = readMoment(value, "Counted at");

  if (at.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new AppError(400, "Counted at cannot be in the future");
  }

  return at.toISOString();
};

const createCount = async (req, res) => {
  const body = req.body || {};

  const data = {
    outletId:
      body.outletId === undefined
        ? req.outletId || null
        : v.optionalNumber(body.outletId, "Store", { min: 1 }),
    categories: readTextList(body.categories, "Categories"),
    storageAreas: readTextList(body.storageAreas, "Storage areas"),
    // A spot check rather than the whole store: the 20 items worth the most
    // on the shelf, or those at or below their reorder level. Left out, the
    // sheet covers every matching item, as it always has.
    scope: v.optionalEnum(body.scope, "What to count", ["all", "high_value", "low"], "all"),
    // Or exactly these items ("Below zero — count it" on the reorder list).
    itemIds:
      body.itemIds === undefined || body.itemIds === null
        ? []
        : v.requiredArray(body.itemIds, "Items").slice(0, 500).map((id) => v.requiredId(id, "Item")),
    countedAt: readCountedAt(body.countedAt) ?? null,
    blind: v.requiredBoolean(body.blind, "Blind count", false),
    notes: v.optionalString(body.notes, "Notes", 500),
  };

  const count = await inventoryService.createCount(req.user.restaurantId, data, req.user.id, {
    canSeeExpected: canSeeExpected(req),
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "create", "stock_count", {
    id: count.id,
    label: count.countNumber,
    details: { store: count.storeName, lines: count.lineCount },
  });

  res.status(201).json({
    success: true,
    message: count.madeBlind
      ? `Count sheet ${count.countNumber} started with ${count.lineCount} items. It is a blind count, because some of these items are already being counted blind.`
      : `Count sheet ${count.countNumber} started with ${count.lineCount} items`,
    data: count,
  });
};

const saveCountLines = async (req, res) => {
  const id = v.requiredId(req.params.id, "Count id");
  const body = req.body || {};

  const data = {
    lines: v.requiredArray(body.lines, "Lines").map((line) => ({
      id: v.requiredId(line?.id, "Line"),
      countedQuantity: v.optionalNumber(line?.countedQuantity, "Counted quantity", {
        min: 0,
        max: 9999999,
      }),
      reason: v.optionalEnum(line?.reason, "Reason", COUNT_REASON_CODES, null),
      note: v.optionalString(line?.note, "Note", 200),
    })),
    countedAt: readCountedAt(body.countedAt),
    notes: body.notes === undefined ? undefined : v.optionalString(body.notes, "Notes", 500),
  };

  await inventoryService.saveCountLines(req.user.restaurantId, id, data, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  res.json({
    success: true,
    message: "Count saved",
    data: await inventoryService.getCount(req.user.restaurantId, id, {
      canSeeExpected: canSeeExpected(req),
    }),
  });
};

// A count that finds stock missing writes it off when it is posted, so it is
// held to the same write-off limit as wastage and stock outs: without this, a
// storekeeper could post a count "finding" ₹8,000 of ghee gone with no PIN,
// while writing off ₹600 of paneer needed one. What is missing is valued at
// cost; a surplus on another item does not cancel it out (a surplus of cheap
// onions must not hide missing ghee). Every check the post itself makes comes
// first, so a manager is never asked for a PIN for a count that is then
// refused.
const prepareCountPost = async (req) => {
  const id = v.requiredId(req.params.id, "Count id");
  const count = await inventoryService.getCount(req.user.restaurantId, id, {
    canSeeExpected: true,
    pinnedOutletId: pinnedOutlet(req),
  });

  if (count.status !== "draft") {
    throw new AppError(409, `This count is already ${count.status}`);
  }

  if (!count.countedCount) {
    throw new AppError(400, "Nothing has been counted on this sheet yet");
  }

  const unexplained = count.lines.filter((line) => line.varianceQuantity && !line.reason).map((line) => line.itemName);

  if (unexplained.length > 0) {
    const more = unexplained.length > 5 ? ` and ${unexplained.length - 5} more` : "";
    throw new AppError(400, `Give a reason for every difference before posting: ${unexplained.slice(0, 5).join(", ")}${more}`);
  }

  return { stockCountId: id, value: count.totals ? count.totals.shortageValue : 0 };
};

const postCount = async (req, res) => {
  const id = v.requiredId(req.params.id, "Count id");
  const count = await inventoryService.postCount(req.user.restaurantId, id, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "post", "stock_count", {
    id: count.id,
    label: count.countNumber,
    details: {
      store: count.storeName,
      counted: count.countedCount,
      shortage: count.shortageValue,
      excess: count.excessValue,
      ...(req.writeoff ? { overLimit: req.writeoff.limit } : {}),
    },
  });

  res.json({ success: true, message: `${count.countNumber} posted and stock corrected`, data: count });
};

const cancelCount = async (req, res) => {
  const id = v.requiredId(req.params.id, "Count id");
  const count = await inventoryService.cancelCount(req.user.restaurantId, id, req.user.id, {
    pinnedOutletId: pinnedOutlet(req),
  });

  logAction(req, "cancel", "stock_count", { id: count.id, label: count.countNumber });

  res.json({ success: true, message: `${count.countNumber} cancelled`, data: count });
};

const varianceReport = async (req, res) => {
  const to = readDate(req.query.to, "To", todayText());
  const from = readDate(req.query.from, "From", to);

  res.json({
    success: true,
    data: await inventoryService.varianceReport(
      req.user.restaurantId,
      { from, to, store: req.query.store || null },
      { pinnedOutletId: pinnedOutlet(req) }
    ),
  });
};

module.exports = {
  listUnits,
  createUnit,
  updateUnit,
  removeUnit,
  listItems,
  createItem,
  updateItem,
  replacePacks,
  removeItem,
  listStores,
  setOwnStore,
  listMovements,
  stockIn,
  prepareStockOut,
  stockOut,
  transfer,
  listBalances,
  valuation,
  listCounts,
  getCount,
  createCount,
  saveCountLines,
  postCount,
  prepareCountPost,
  cancelCount,
  varianceReport,
};
