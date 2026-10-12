const dishWasteService = require("../services/dishWaste.service");
const inventoryService = require("../services/inventory.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

// Waste & reorder → Dish wasted (sweep SW-B-22). Kitchen staff who can log
// waste can log a dish; undoing one puts stock back, so it is a manager's.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const readBody = (req) => {
  const body = req.body || {};

  if (body.productId === undefined || body.productId === null || body.productId === "") {
    throw new AppError(400, "Pick the dish that was thrown away");
  }

  const quantity = Number(body.quantity);

  return {
    productId: v.requiredId(body.productId, "Dish"),
    variantId: v.optionalNumber(body.variantId, "Size", { min: 1 }),
    quantity: Number.isFinite(quantity) ? quantity : NaN,
    reason: v.optionalString(body.reason, "Reason", 20),
    note: v.optionalString(body.note, "Note", 300),
    modifierIds: Array.isArray(body.modifierIds)
      ? body.modifierIds.slice(0, 20).map((id) => v.requiredId(id, "Add-on"))
      : [],
    // Where it was thrown away: the outlet the cook is working in.
    outletId: req.outletId || null,
  };
};

// Run by the write-off limit before any PIN is asked for.
const prepare = async (req) => {
  const data = readBody(req);
  const prepared = await dishWasteService.prepare(req.user.restaurantId, data);
  req.dishWaste = { data, prepared };

  return { quantity: prepared.quantity, value: prepared.value, productId: prepared.productId };
};

const log = async (req, res) => {
  const { data, prepared } = req.dishWaste || { data: readBody(req), prepared: null };
  const entry = await dishWasteService.log(req.user.restaurantId, data, req.user.id, prepared);

  logAction(req, "dish_wasted", "product", {
    id: entry.productId,
    label: `${entry.quantity} × ${entry.itemName}`,
    details: {
      entryId: entry.id,
      reason: entry.reason,
      value: entry.value,
      store: entry.store,
      ingredients: entry.ingredients.length,
      note: entry.note || undefined,
      ...(req.writeoff ? { overLimit: req.writeoff.limit } : {}),
    },
  });

  res.status(201).json({
    success: true,
    message: `${entry.quantity} × ${entry.itemName} written off: ${entry.ingredients.length} ingredients taken out of stock`,
    data: entry,
  });
};

const list = async (req, res) => {
  const from = req.query.from && DATE.test(req.query.from) ? req.query.from : null;
  const to = req.query.to && DATE.test(req.query.to) ? req.query.to : null;

  if ((req.query.from && !from) || (req.query.to && !to)) {
    throw new AppError(400, "Dates must look like 2026-10-02");
  }

  if (from && to && from > to) {
    throw new AppError(400, "The start date must be on or before the end date");
  }

  // The same store as the rest of Waste & reorder.
  let store = null;

  // Tied to an outlet or picked in the switcher alike (MV-6): that outlet's
  // own store, or the main store it sells from.
  if (req.outletId) {
    store = await inventoryService.pinnedStore(req.user.restaurantId, req.outletId);
  }

  res.json({
    success: true,
    data: await dishWasteService.list(
      req.user.restaurantId,
      { from, to, limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 500 }) || 100 },
      { store }
    ),
  });
};

const get = async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(404, "Dish write-off not found");
  }

  res.json({ success: true, data: await dishWasteService.get(req.user.restaurantId, id) });
};

const reverse = async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(404, "Dish write-off not found");
  }

  const note = v.optionalString(req.body?.note, "Note", 300);
  const entry = await dishWasteService.reverse(req.user.restaurantId, id, note, req.user.id, {
    pinnedOutletId: req.outletPinned ? req.outletId : null,
  });

  logAction(req, "dish_waste_reversed", "product", {
    id: entry.productId,
    label: `${entry.quantity} × ${entry.itemName}`,
    details: { entryId: entry.id, value: entry.value, note: note || undefined },
  });

  res.json({
    success: true,
    message: `Undone: ${entry.quantity} × ${entry.itemName} put back in stock`,
    data: entry,
  });
};

const pickable = async (req, res) => {
  res.json({ success: true, data: await dishWasteService.pickable(req.user.restaurantId) });
};

module.exports = { prepare, log, list, get, reverse, pickable };
