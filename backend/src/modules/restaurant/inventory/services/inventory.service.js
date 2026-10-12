const inventoryRepository = require("../repositories/inventory.repository");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { rupees, checkStockValue } = require("../../../../utils/amountLimit");

const DUPLICATE = "23505";

// Why a count came out different, in the words a manager would use. Kept as a
// fixed list so a month of counts can be added up by reason.
const COUNT_REASONS = {
  unexplained: "Not explained",
  wastage_not_logged: "Spoiled or wasted, not logged",
  staff_meals: "Staff meals not recorded",
  over_portioning: "Over-portioning",
  theft: "Suspected theft",
  delivery_not_entered: "Delivery not entered",
  count_error: "Earlier count was wrong",
  other: "Other",
};

const round3 = (value) => Math.round(Number(value) * 1000) / 1000;
const round8 = (value) => Math.round(Number(value) * 1e8) / 1e8;

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toUnit = (row) => ({
  id: row.id,
  name: row.name,
  shortName: row.short_name,
  status: row.status,
  itemCount: row.item_count,
});

const toPack = (pack) => ({ id: Number(pack.id), name: pack.name, size: Number(pack.size) });

const toItem = (row) => ({
  id: row.id,
  name: row.name,
  code: row.code,
  unitId: row.unit_id,
  unitName: row.unit_name,
  unitShortName: row.unit_short_name,
  category: row.category,
  storageArea: row.storage_area ?? null,
  currentStock: Number(row.current_stock),
  reorderLevel: Number(row.reorder_level),
  lastCost: row.last_cost === null ? null : Number(row.last_cost),
  averageCost: row.average_cost === null ? null : Number(row.average_cost),
  itemType: row.item_type || "raw",
  isLow: row.is_low,
  status: row.status,
  // The supplier it is normally ordered from, chosen by hand (null: none).
  preferredSupplierId: row.preferred_supplier_id === null || row.preferred_supplier_id === undefined ? null : Number(row.preferred_supplier_id),
  preferredSupplierName: row.preferred_supplier_name ?? null,
  packs: (row.packs || []).map(toPack),
  // Only on a list for one store (someone tied to one outlet): whether that
  // store keeps the item at all, so one it has never stocked is not shown
  // as "out of stock" there.
  ...(row.kept_here === null || row.kept_here === undefined ? {} : { keptHere: row.kept_here }),
});

const REFERENCE_WORDS = {
  waste_log: "Wastage log",
  waste_reversal: "Wastage reversed",
  transfer: "Transfer",
  transfer_note: "Transfer note",
  cancelled_dish: "Cancelled after KOT",
  dish_waste: "Dish wasted",
  stock_import: "Opening stock (import)",
};

const toMovement = (row) => ({
  id: row.id,
  inventoryItemId: row.inventory_item_id,
  itemName: row.item_name,
  category: row.category,
  unitShortName: row.unit_short_name,
  transactionType: row.transaction_type,
  quantity: Number(row.quantity),
  unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
  balanceAfter: Number(row.balance_after),
  reason: row.reason,
  referenceType: row.reference_type,
  referenceId: row.reference_id,
  // What staff search for — PO-0004, GRN-0012 · Bill 4521, INV-1042, SC-0003 —
  // rather than the database id the screen used to show.
  referenceLabel: row.reference_label || REFERENCE_WORDS[row.reference_type] || null,
  notes: row.notes,
  // How much of a sale came from batches already past their expiry date: the
  // bill went through (a bill is never refused for stock), and this says so.
  expiredQuantity: row.expired_quantity === null || row.expired_quantity === undefined ? null : Number(row.expired_quantity),
  outletId: row.outlet_id,
  storeName: row.outlet_id ? row.outlet_name : "Main store",
  createdAt: row.created_at,
  // When the goods were really on the shelf: earlier than createdAt for a
  // delivery typed in after the day it arrived.
  effectiveAt: row.effective_at || row.created_at,
  createdByName: row.created_by_name,
});

// Items whose stock the person must not see right now: those on an open
// blind count, for anyone who cannot post counts (the cooks doing the
// counting). A blind count that can be read off the Items list is not blind.
const hiddenItems = async (restaurantId, canSeeBlind) =>
  canSeeBlind ? new Set() : inventoryRepository.findBlindItemIds(restaurantId);

const hideStock = (item) => ({ ...item, currentStock: null, isLow: null, stockHidden: true });

// --- Units ---

const listUnits = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await inventoryRepository.findUnits(restaurantId);
  return rows.map(toUnit);
};

const createUnit = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    return toUnit(await inventoryRepository.createUnit(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A unit named "${data.name}" already exists`);
    }

    throw error;
  }
};

const updateUnit = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    const row = await inventoryRepository.updateUnit(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Unit not found");
    }

    return toUnit(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A unit named "${data.name}" already exists`);
    }

    throw error;
  }
};

const removeUnit = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const unit = await inventoryRepository.findUnitById(restaurantId, id);

  if (!unit) {
    throw new AppError(404, "Unit not found");
  }

  const itemCount = await inventoryRepository.countUnitItems(id);

  if (itemCount > 0) {
    throw new AppError(409, `This unit is used by ${itemCount} item(s).`);
  }

  await inventoryRepository.removeUnit(restaurantId, id);
};

// --- Items ---

// For someone tied to one outlet the stock on each item is their own store's
// (the item list itself is the restaurant's: every outlet buys from it).
const listItems = async (restaurantId, filters, { canSeeBlind = true, pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const mine = await pinnedStore(restaurantId, pinnedOutletId);
  const [rows, hidden] = await Promise.all([
    inventoryRepository.findItems(restaurantId, { ...filters, store: mine ? { storeId: mine.storeId } : null }),
    hiddenItems(restaurantId, canSeeBlind),
  ]);

  return (
    rows
      // "Low stock only" is itself a reading of the stock: an item being
      // counted blind appearing (or not) on it says whether it is below its
      // reorder level. It is left off that list for the people counting.
      .filter((row) => !(filters.lowOnly && hidden.has(Number(row.id))))
      .map((row) => (hidden.has(Number(row.id)) ? hideStock(toItem(row)) : toItem(row)))
  );
};

const requireOwnUnit = async (restaurantId, unitId) => {
  const unit = await inventoryRepository.findUnitById(restaurantId, unitId);

  if (!unit) {
    throw new AppError(400, "Selected unit does not exist");
  }

  return unit;
};

// Two packs with the same name would be impossible to tell apart on a bill.
const checkPacks = (packs) => {
  const seen = new Set();

  for (const pack of packs) {
    const key = pack.name.toLowerCase();

    if (seen.has(key)) {
      throw new AppError(400, `The pack "${pack.name}" is listed twice`);
    }

    seen.add(key);
  }
};

// options.pinnedOutletId: for someone tied to one outlet, the opening stock is
// what they found on their own shelf, so it goes into their outlet's store
// (or the main store, for an outlet that sells from it) — never the main
// store of an outlet that keeps its own, where their counts and closing
// stock would never see it.
// A preferred supplier must be one of this restaurant's suppliers, and an
// active one when it is newly chosen.
const requireOwnSupplier = async (restaurantId, supplierId, current = null) => {
  if (supplierId === null || supplierId === undefined) {
    return;
  }

  const supplier = await inventoryRepository.findSupplierById(restaurantId, supplierId);

  if (!supplier) {
    throw new AppError(400, "That supplier does not belong to your restaurant");
  }

  if (supplier.status !== "active" && Number(current) !== Number(supplierId)) {
    throw new AppError(400, `${supplier.name} is switched off. Switch the supplier back on first, or pick another.`);
  }
};

// Reorder's "Choose supplier": sets only the item's preferred supplier.
const setPreferredSupplier = async (restaurantId, id, supplierId, userId) => {
  requireRestaurantId(restaurantId);
  const existing = await inventoryRepository.findItemById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Item not found");
  }

  await requireOwnSupplier(restaurantId, supplierId, existing.preferred_supplier_id);
  return toItem(await inventoryRepository.setPreferredSupplier(restaurantId, id, supplierId, userId));
};

const createItem = async (restaurantId, data, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);
  const unit = await requireOwnUnit(restaurantId, data.unitId);
  await requireOwnSupplier(restaurantId, data.preferredSupplierId);

  if (data.packs) {
    checkPacks(data.packs);
  }

  // Checked before the item is written, so a refused opening stock does not
  // leave an item behind with none.
  if (data.openingStock > 0) {
    checkStockValue(0, data.openingStock, data.openingCost, data.name, unit.short_name);
  }

  try {
    const item = await inventoryRepository.createItem(restaurantId, data, userId);

    if (data.packs && data.packs.length > 0) {
      await inventoryRepository.replacePacks(restaurantId, item.id, data.packs, userId);
    }

    // Opening stock is recorded as a movement, so the ledger explains every unit.
    if (data.openingStock > 0) {
      await inventoryRepository.createMovement(
        restaurantId,
        {
          inventoryItemId: item.id,
          ...(pinnedOutletId ? { outletId: Number(pinnedOutletId) } : {}),
          transactionType: "opening",
          quantity: data.openingStock,
          unitCost: data.openingCost ?? null,
          reason: "Opening stock",
        },
        userId
      );
    }

    return toItem(await inventoryRepository.findItemById(restaurantId, item.id));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "An item with this name or code already exists");
    }

    throw error;
  }
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const updateItem = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);
  const unit = await requireOwnUnit(restaurantId, data.unitId);

  const existing = await inventoryRepository.findItemById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Item not found");
  }

  await requireOwnSupplier(restaurantId, data.preferredSupplierId, existing.preferred_supplier_id);

  // Every receipt, count and recipe for this item was written in its unit.
  // Changing kg to litres would quietly change what all of them mean, with
  // no conversion — 20 kg of chicken would become 20 litres. The unit is
  // fixed once anything has been measured in it.
  if (Number(existing.unit_id) !== Number(data.unitId)) {
    const usage = await inventoryRepository.countItemUsage(restaurantId, id);
    const uses = [
      usage.movements ? plural(usage.movements, "stock movement") : null,
      usage.recipes ? plural(usage.recipes, "recipe line") : null,
      usage.order_lines ? plural(usage.order_lines, "purchase order line") : null,
    ].filter(Boolean);

    if (uses.length > 0) {
      throw new AppError(
        409,
        `${existing.name} is measured in ${existing.unit_short_name} in ${uses.join(", ")}, so its unit cannot change to ${unit.short_name}. Add a pack instead (for example 1 tin = 15 ${existing.unit_short_name}), or set this item inactive and create a new one in ${unit.short_name}.`
      );
    }
  }

  try {
    const row = await inventoryRepository.updateItem(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Item not found");
    }

    if (data.packs) {
      return replacePacks(restaurantId, id, data.packs, userId);
    }

    return toItem(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "An item with this name or code already exists");
    }

    throw error;
  }
};

const replacePacks = async (restaurantId, itemId, packs, userId) => {
  requireRestaurantId(restaurantId);
  checkPacks(packs);

  const item = await inventoryRepository.findItemById(restaurantId, itemId);

  if (!item) {
    throw new AppError(404, "Item not found");
  }

  try {
    const result = await inventoryRepository.replacePacks(restaurantId, itemId, packs, userId);

    if (result.error) {
      throw new AppError(400, "One of those packs does not belong to this item");
    }

    return toItem(result.item);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, "Two packs have the same name");
    }

    throw error;
  }
};

const removeItem = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const item = await inventoryRepository.findItemById(restaurantId, id);

  if (!item) {
    throw new AppError(404, "Item not found");
  }

  const movements = await inventoryRepository.countItemTransactions(id);

  if (movements > 0) {
    throw new AppError(
      409,
      `This item has ${movements} stock movement(s) in its history. Set it to inactive instead.`
    );
  }

  const usage = await inventoryRepository.countItemUsage(restaurantId, id);

  if (usage.recipes > 0 || usage.order_lines > 0) {
    throw new AppError(
      409,
      `This item is used in ${plural(usage.recipes, "recipe line")} and ${plural(usage.order_lines, "purchase order line")}. Set it to inactive instead.`
    );
  }

  await inventoryRepository.removeItem(restaurantId, id);
};

// --- Stores ---

// The places stock is held: the main store, plus every outlet that keeps its
// own. An outlet without its own store sells from the main store.
// For the people counting blind, the items being counted are left out of each
// store's figures: a store's value less every item they can see, divided by
// the one item they cannot, is that item's stock.
const listStores = async (restaurantId, { canSeeBlind = true, pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const hidden = await hiddenItems(restaurantId, canSeeBlind);
  const { main, outlets } = await inventoryRepository.findStores(restaurantId, [...hidden]);
  const blind = hidden.size > 0 ? { stockHidden: true, hiddenCount: hidden.size } : {};
  const mine = await pinnedStore(restaurantId, pinnedOutletId);

  // Someone tied to one outlet sees the one store they work with.
  if (mine) {
    const own = mine.storeId ? outlets.find((row) => Number(row.id) === mine.storeId) : null;

    return [
      own
        ? {
            outletId: own.id,
            name: own.name,
            code: own.code,
            ownStore: own.own_store,
            status: own.status,
            itemsHeld: Number(own.items_held),
            stockValue: round2(Number(own.stock_value)),
            ...blind,
          }
        : {
            outletId: null,
            name: "Main store",
            ownStore: true,
            status: "active",
            itemsHeld: Number(main.items_held),
            stockValue: round2(Number(main.stock_value)),
            ...blind,
          },
    ];
  }

  return [
    {
      outletId: null,
      name: "Main store",
      ownStore: true,
      status: "active",
      itemsHeld: Number(main.items_held),
      stockValue: round2(Number(main.stock_value)),
      ...blind,
    },
    ...outlets.map((row) => ({
      outletId: row.id,
      name: row.name,
      code: row.code,
      ownStore: row.own_store,
      status: row.status,
      itemsHeld: Number(row.items_held),
      stockValue: round2(Number(row.stock_value)),
      ...blind,
    })),
  ];
};

const setOwnStore = async (restaurantId, outletId, ownStore, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  // How another outlet keeps its stock is not for someone tied to one outlet.
  if (pinnedOutletId && Number(pinnedOutletId) !== Number(outletId)) {
    throw new AppError(403, ONE_OUTLET);
  }

  const outlet = await inventoryRepository.findOutlet(restaurantId, outletId);

  if (!outlet) {
    throw new AppError(404, "Outlet not found");
  }

  // A closed outlet sells nothing; a shelf of its own would only be somewhere
  // for stock to get stuck.
  if (ownStore && !outlet.own_store && outlet.status !== "active") {
    throw new AppError(400, `${outlet.name} is not active. Set the outlet active before giving it a store of its own.`);
  }

  // Switching off with stock on the shelf would leave it stranded: nothing
  // would sell from it and nothing could be counted there.
  if (!ownStore && outlet.own_store) {
    const held = await inventoryRepository.countOutletHoldings(restaurantId, outletId);

    if (held > 0) {
      throw new AppError(
        409,
        `${outlet.name} still holds ${plural(held, "item")}. Transfer them back to the main store first.`
      );
    }
  }

  const row = await inventoryRepository.setOwnStore(restaurantId, outletId, ownStore, userId);

  return { outletId: row.id, name: row.name, ownStore: row.own_store };
};

// --- A person tied to one outlet ---
//
// Staff pinned to an outlet (resolveOutlet sets req.outletPinned) work with
// that outlet's stock and no other: its own store when it keeps one, else the
// main store it sells from. Another outlet's shelf is refused when they name
// it, and left out of every list and figure they read — the same rule orders
// and bills already follow. Owners and unpinned managers are not affected.

const ONE_OUTLET =
  "You are set up to work at one outlet only, so you can only see and change its stock. Ask your manager if you need another store.";

// The store a pinned person works with, or null for someone not pinned.
// { mode, outletId, storeId, name } — storeId null means the main store.
const pinnedStore = async (restaurantId, pinnedOutletId) => {
  if (!pinnedOutletId) {
    return null;
  }

  const outlet = await inventoryRepository.findOutlet(restaurantId, pinnedOutletId);

  if (!outlet) {
    throw new AppError(403, "Your outlet no longer exists. Ask your manager to move you to an open outlet.");
  }

  return outlet.own_store
    ? { mode: "outlet", outletId: Number(outlet.id), storeId: Number(outlet.id), name: outlet.name }
    : { mode: "main", outletId: null, storeId: null, name: "Main store", via: outlet.name };
};

// A store a pinned person named (by its outlet; nothing is the main store)
// must be the one they work with. Outlets that sell from the main store all
// mean the main store's shelf.
const requirePinnedStore = async (restaurantId, pinnedOutletId, chosenOutletId) => {
  const mine = await pinnedStore(restaurantId, pinnedOutletId);

  if (!mine) {
    return null;
  }

  const asked = await inventoryRepository.storeFor(inventoryRepository.pool, restaurantId, chosenOutletId || null);

  if ((asked ?? null) !== mine.storeId) {
    throw new AppError(403, ONE_OUTLET);
  }

  return mine;
};

// The same check for a record that already sits at a store (a supplier bill,
// a return): its store id, null for the main store.
const requirePinnedStoreId = async (restaurantId, pinnedOutletId, storeId) => {
  const mine = await pinnedStore(restaurantId, pinnedOutletId);

  if (mine && (storeId === null || storeId === undefined ? null : Number(storeId)) !== mine.storeId) {
    throw new AppError(403, ONE_OUTLET);
  }

  return mine;
};

// Which store a request means. Nothing named is the whole restaurant (for
// reports) or the main store (for a movement); an outlet must be this
// restaurant's own. For a pinned person it is always their own store: asking
// for nothing (or "all") reads theirs, and naming another is refused.
const resolveStoreFilter = async (restaurantId, value, pinnedOutletId = null) => {
  const mine = await pinnedStore(restaurantId, pinnedOutletId);

  if (mine) {
    if (value === null || value === undefined || value === "" || value === "all") {
      return mine;
    }

    if (value === "main") {
      if (mine.mode === "main") {
        return mine;
      }

      throw new AppError(403, ONE_OUTLET);
    }

    const asked = Number(value);

    if (!Number.isInteger(asked) || asked < 1) {
      throw new AppError(400, "Store must be main, all or an outlet id");
    }

    if (asked === Number(pinnedOutletId) || asked === mine.storeId) {
      return mine;
    }

    throw new AppError(403, ONE_OUTLET);
  }

  if (value === null || value === undefined || value === "" || value === "all") {
    return null;
  }

  if (value === "main") {
    return { mode: "main", name: "Main store" };
  }

  const id = Number(value);

  if (!Number.isInteger(id) || id < 1) {
    throw new AppError(400, "Store must be main, all or an outlet id");
  }

  const outlet = await inventoryRepository.findOutlet(restaurantId, id);

  if (!outlet) {
    throw new AppError(404, "That outlet was not found");
  }

  return { mode: "outlet", outletId: id, name: outlet.name };
};

// --- Stock movements ---

const listMovements = async (restaurantId, filters, { canSeeBlind = true, pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  if (filters.from && filters.to && filters.from > filters.to) {
    throw new AppError(400, "The start date is after the end date");
  }

  const store = await resolveStoreFilter(restaurantId, filters.store, pinnedOutletId);

  // { items, total } rather than a bare array, matching what expenses and
  // feedback already return. `total` is how many match the filter, which may
  // be more than were sent, so the screen can say so instead of quietly
  // showing a page and calling it the answer.
  const [{ rows, total, summary }, hidden] = await Promise.all([
    inventoryRepository.findMovements(restaurantId, { ...filters, store }),
    hiddenItems(restaurantId, canSeeBlind),
  ]);

  // For an item being counted blind, the running balance is its stock figure,
  // and the quantities in and out add up to it just the same (+12, +2, +5 is
  // 19 kg on the shelf). Both are left out for the people counting, with the
  // cost that would turn a value back into a quantity. The rows stay, so they
  // can still see that something happened and what it was.
  // A list of one store's movements shows that store's running balance (its
  // own total just after each row), not the whole restaurant's.
  const items = rows.map((row) => {
    const own = row.store_balance !== null && row.store_balance !== undefined;
    const movement = {
      ...toMovement(row),
      ...(own ? { balanceAfter: Number(row.store_balance) } : {}),
      balanceScope: own ? "store" : "restaurant",
    };
    return hidden.has(Number(row.inventory_item_id))
      ? { ...movement, quantity: null, unitCost: null, balanceAfter: null, expiredQuantity: null, stockHidden: true }
      : movement;
  });

  // In and out as quantities only for one item (kilos of different things
  // do not add up), and never for an item on a blind count.
  const quantities = Boolean(filters.itemId) && !hidden.has(Number(filters.itemId));

  return {
    items,
    total,
    limit: filters.limit || 100,
    offset: filters.offset || 0,
    summary: {
      in: summary.in,
      out: summary.out,
      waste: summary.waste,
      inQuantity: quantities ? summary.inQuantity : null,
      outQuantity: quantities ? summary.outQuantity : null,
    },
  };
};

// Stock may only be sent to an outlet that is open. A closed outlet takes no
// bills, so stock moved there sits where nothing can sell or use it (the
// verifier found 3 kg parked at a closed outlet this way).
const requireActiveDestination = (outlet) => {
  if (outlet && outlet.status !== "active") {
    throw new AppError(
      400,
      `${outlet.name} is not active, so stock cannot be sent there. Set the outlet active first, or keep the stock at the main store.`
    );
  }
};

const requireOwnOutlet = async (restaurantId, outletId) => {
  if (!outletId) {
    return null;
  }

  const outlet = await inventoryRepository.findOutlet(restaurantId, outletId);

  if (!outlet) {
    throw new AppError(400, "That outlet does not belong to your restaurant");
  }

  return outlet;
};

// One entry point for stock in, stock out and wastage: the sign of the quantity
// decides the direction, and a manual stock-out can never take the store it
// comes from below zero.
const recordMovement = async (restaurantId, data, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  // A pinned person's stock moves on their own store's shelf only. With no
  // store named, the movement is at their outlet (resolveOutlet set it).
  if (pinnedOutletId) {
    await requirePinnedStore(restaurantId, pinnedOutletId, data.outletChosen ? data.outletId : pinnedOutletId);
  }

  const item = await inventoryRepository.findItemById(restaurantId, data.inventoryItemId);

  if (!item) {
    throw new AppError(400, "Selected item does not exist");
  }

  // The outlet a person picked is checked here; the one the switcher set was
  // already checked by resolveOutlet.
  if (data.outletId && data.outletChosen) {
    const outlet = await requireOwnOutlet(restaurantId, data.outletId);

    // Stock can still be taken off a closed outlet's shelf (thrown away, or
    // counted out), but nothing new is put on it.
    if (Number(data.quantity) > 0) {
      requireActiveDestination(outlet);
    }
  }

  // Stock coming in is valued at its own cost, or at the item's cost when
  // none is given; the item's whole stock must stay a believable figure.
  if (Number(data.quantity) > 0) {
    checkStockValue(
      item.current_stock,
      data.quantity,
      data.unitCost ?? (item.last_cost === null ? null : Number(item.last_cost)),
      item.name,
      item.unit_short_name
    );
  }

  try {
    const updated = await inventoryRepository.createMovement(restaurantId, data, userId);

    if (!updated) {
      throw new AppError(404, "Item not found");
    }

    return toItem(updated);
  } catch (error) {
    if (error.code === "NEGATIVE_STOCK") {
      const where = error.storeId
        ? ` at ${(await inventoryRepository.findOutlet(restaurantId, error.storeId))?.name || "that outlet"}`
        : data.outletId
          ? " at the main store"
          : "";

      throw new AppError(
        400,
        `Only ${round3(error.currentStock)} ${item.unit_short_name} of ${item.name} is in stock${where}`
      );
    }

    throw error;
  }
};

// Everything a hand-entered stock out must pass, checked before it is written
// — and before a manager is asked for a PIN when it is over the write-off
// limit: the store is theirs to touch, the item exists, and the shelf it
// comes off holds enough (a manual stock out never takes a store below zero;
// recordMovement checks again with the item locked). Returns the item and
// what the stock out is worth at the item's average cost, which is what the
// ledger will value it at.
const checkStockOut = async (restaurantId, data, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  if (pinnedOutletId) {
    await requirePinnedStore(restaurantId, pinnedOutletId, data.outletChosen ? data.outletId : pinnedOutletId);
  }

  const item = await inventoryRepository.findItemById(restaurantId, data.inventoryItemId);

  if (!item) {
    throw new AppError(400, "Selected item does not exist");
  }

  if (data.outletId && data.outletChosen) {
    await requireOwnOutlet(restaurantId, data.outletId);
  }

  const storeId = await inventoryRepository.storeFor(inventoryRepository.pool, restaurantId, data.outletId || null);
  const held = (await inventoryRepository.findBalances(restaurantId, item.id)).find(
    (row) => (row.outlet_id === null ? null : Number(row.outlet_id)) === storeId
  );
  const available = held ? Number(held.quantity) : 0;
  const quantity = Math.abs(Number(data.quantity));

  if (quantity > available + 0.0000001) {
    const where = storeId
      ? ` at ${(await inventoryRepository.findOutlet(restaurantId, storeId))?.name || "that outlet"}`
      : data.outletId
        ? " at the main store"
        : "";

    throw new AppError(400, `Only ${round3(available)} ${item.unit_short_name} of ${item.name} is in stock${where}`);
  }

  // Waste taken from one chosen batch: that batch must hold it, on that shelf.
  if (data.batchId) {
    if (data.transactionType !== "wastage") {
      throw new AppError(400, "Specific batches can be selected when recording wastage");
    }

    const batch = await inventoryRepository.pool.query(
      `SELECT bb.quantity FROM inventory_batch_balances bb
       JOIN inventory_batches b ON b.id = bb.batch_id
       WHERE b.restaurant_id = $1 AND b.inventory_item_id = $2 AND b.id = $3 AND bb.outlet_id IS NOT DISTINCT FROM $4`,
      [restaurantId, item.id, data.batchId, storeId]
    );

    if (!batch.rows.length || Number(batch.rows[0].quantity) < quantity - 0.0000001) {
      throw new AppError(409, "That batch no longer has enough stock in this store");
    }
  }

  const cost = item.average_cost ?? item.last_cost;

  return { item, value: round2(quantity * Number(cost || 0)) };
};

// Moves stock between stores. Both sides are written together, so the total
// across the restaurant never changes. A null outlet means the main store.
const transfer = async (restaurantId, data, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  if (Number(data.fromOutletId || 0) === Number(data.toOutletId || 0)) {
    throw new AppError(400, "Choose two different places to move stock between");
  }

  // Someone tied to one outlet can send their own stock elsewhere, but not
  // take another store's.
  if (pinnedOutletId) {
    await requirePinnedStore(restaurantId, pinnedOutletId, data.fromOutletId);
  }

  // Both ends must be this restaurant's own outlets. Without this an id from
  // another restaurant would be accepted and stock would leave the tenant.
  const from = await requireOwnOutlet(restaurantId, data.fromOutletId);
  const to = await requireOwnOutlet(restaurantId, data.toOutletId);

  // Out of a closed outlet is how its stock is brought back; into one is not.
  requireActiveDestination(to);

  const item = await inventoryRepository.findItemById(restaurantId, data.inventoryItemId);

  if (!item) {
    throw new AppError(400, "Selected item does not exist");
  }

  if (from && !from.own_store) {
    throw new AppError(
      400,
      `${from.name} does not keep its own stock — its sales come from the main store. Move stock from the main store instead.`
    );
  }

  const balances = await inventoryRepository.findBalances(restaurantId, data.inventoryItemId);
  const source = balances.find(
    (row) => Number(row.outlet_id || 0) === Number(data.fromOutletId || 0)
  );
  const available = source ? Number(source.quantity) : 0;

  if (data.quantity > available) {
    throw new AppError(
      400,
      `Only ${round3(available)} ${item.unit_short_name} is held at ${from ? from.name : "the main store"}`
    );
  }

  let updated;

  try {
    updated = await inventoryRepository.transferStock(restaurantId, data, userId);
  } catch (error) {
    // Someone else took from the same shelf between the check above and the
    // move (the check is repeated with the item locked).
    if (error.code === "NEGATIVE_STOCK") {
      throw new AppError(
        400,
        `Only ${round3(error.currentStock)} ${item.unit_short_name} of ${item.name} is held at ${from ? from.name : "the main store"}`
      );
    }

    throw error;
  }

  if (!updated) {
    throw new AppError(404, "Item not found");
  }

  return toItem(updated);
};

// Where an item's stock is sitting. Someone tied to one outlet sees their own
// store's figure only.
const listBalances = async (restaurantId, itemId, { canSeeBlind = true, pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const item = await inventoryRepository.findItemById(restaurantId, itemId);

  if (!item) {
    throw new AppError(404, "Item not found");
  }

  const [rows, hidden, mine] = await Promise.all([
    inventoryRepository.findBalances(restaurantId, itemId),
    hiddenItems(restaurantId, canSeeBlind),
    pinnedStore(restaurantId, pinnedOutletId),
  ]);
  const hide = hidden.has(Number(itemId));
  const shown = mine ? rows.filter((row) => (row.outlet_id === null ? null : Number(row.outlet_id)) === mine.storeId) : rows;

  return shown.map((row) => ({
    outletId: row.outlet_id,
    outletName: row.outlet_name || "Main store",
    ownStore: row.outlet_id ? row.own_store : true,
    quantity: hide ? null : Number(row.quantity),
    ...(hide ? { stockHidden: true } : {}),
  }));
};

// --- Closing stock on a date ---

const valuation = async (restaurantId, { date, store: storeValue }, { canSeeBlind = true, pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const store = await resolveStoreFilter(restaurantId, storeValue, pinnedOutletId);
  const [rows, hidden, travelling] = await Promise.all([
    inventoryRepository.findValuation(restaurantId, { date, store }),
    hiddenItems(restaurantId, canSeeBlind),
    // Stock on the road between stores that night (sent, not yet received):
    // in no store's figure, so it is counted on a line of its own — for one
    // store, what was on its way to it.
    require("../repositories/stockTransfer.repository").findInTransit(restaurantId, {
      date,
      storeOnly: Boolean(store),
      toStoreId: store ? (store.mode === "outlet" ? store.outletId : null) : null,
    }),
  ]);

  // Items being counted blind are left out for the people counting them,
  // and the screen says how many.
  const items = rows
    .filter((row) => !hidden.has(Number(row.id)))
    .filter((row) => Number(row.quantity) !== 0)
    .map((row) => {
      const quantity = round3(row.quantity);
      const known = row.cost_then !== null;
      const unitCost = known ? Number(row.cost_then) : row.last_cost === null ? null : Number(row.last_cost);

      return {
        id: row.id,
        name: row.name,
        code: row.code,
        category: row.category,
        storageArea: row.storage_area,
        status: row.status,
        unitShortName: row.unit_short_name,
        quantity,
        unitCost: unitCost === null ? null : round8(unitCost),
        value: round2(quantity * (unitCost || 0)),
        // No price on record by that date: valued at today's cost instead.
        costEstimated: !known,
        negative: quantity < 0,
      };
    });

  // Stock below zero is a recording error, not stock: it is listed so it gets
  // fixed, and left out of the closing figure.
  const counted = items.filter((row) => !row.negative);
  const byCategory = new Map();

  for (const row of counted) {
    const key = row.category || "Uncategorised";
    const entry = byCategory.get(key) || { category: key, itemCount: 0, value: 0 };

    entry.itemCount += 1;
    entry.value = round2(entry.value + row.value);
    byCategory.set(key, entry);
  }

  const inTransit = travelling
    .filter((row) => !hidden.has(Number(row.inventory_item_id)))
    .map((row) => ({
      id: Number(row.inventory_item_id),
      name: row.name,
      unitShortName: row.unit,
      to: row.to_name,
      quantity: round3(row.quantity),
      value: round2(Number(row.value)),
    }));
  const inTransitValue = round2(inTransit.reduce((sum, row) => sum + row.value, 0));
  const shelves = round2(counted.reduce((sum, row) => sum + row.value, 0));

  return {
    date,
    store: store ? { mode: store.mode, outletId: store.outletId || null, name: store.name } : null,
    items,
    byCategory: [...byCategory.values()].sort((a, b) => b.value - a.value),
    inTransit,
    totals: {
      value: shelves,
      inTransitValue,
      valueWithTransit: round2(shelves + inTransitValue),
      itemCount: counted.length,
      negativeCount: items.length - counted.length,
      estimatedCount: items.filter((row) => row.costEstimated).length,
      hiddenCount: rows.filter((row) => hidden.has(Number(row.id))).length,
    },
  };
};

// --- Stock counts ---

const countStoreFor = async (restaurantId, outletId) => {
  if (!outletId) {
    return { outletId: null, name: "Main store" };
  }

  const outlet = await inventoryRepository.findOutlet(restaurantId, outletId);

  if (!outlet) {
    throw new AppError(400, "That outlet does not belong to your restaurant");
  }

  // An outlet without its own shelf has nothing of its own to count: its
  // stock is the main store's.
  if (!outlet.own_store) {
    return { outletId: null, name: "Main store", via: outlet.name };
  }

  return { outletId: outlet.id, name: outlet.name };
};

const toCountSummary = (row) => ({
  id: row.id,
  countNumber: row.count_number,
  outletId: row.outlet_id,
  storeName: row.outlet_id ? row.outlet_name : "Main store",
  countedAt: row.counted_at,
  businessDate: row.business_date,
  scope: row.scope || {},
  blind: row.blind,
  status: row.count_status,
  notes: row.notes,
  lineCount: row.line_count,
  countedCount: row.counted_count,
  varianceCount: row.variance_count,
  shortageValue: Number(row.shortage_value),
  excessValue: Number(row.excess_value),
  netValue: round2(Number(row.excess_value) - Number(row.shortage_value)),
  postedAt: row.posted_at,
  postedByName: row.posted_by_name,
  createdAt: row.created_at,
  createdByName: row.created_by_name,
});

const listCounts = async (restaurantId, filters, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const store = await pinnedStore(restaurantId, pinnedOutletId);
  const { rows, total } = await inventoryRepository.findCounts(restaurantId, { ...filters, store });

  return { items: rows.map(toCountSummary), total, limit: filters.limit || 100 };
};

// Another store's sheet is, for someone tied to one outlet, a sheet that does
// not exist — the same answer as an id from another restaurant.
const requireCountInStore = async (restaurantId, id, pinnedOutletId) => {
  const mine = await pinnedStore(restaurantId, pinnedOutletId);

  if (!mine) {
    return;
  }

  const storeId = await inventoryRepository.findCountStore(restaurantId, id);

  if (storeId === undefined || storeId !== mine.storeId) {
    throw new AppError(404, "Stock count not found");
  }
};

// The sheet with its lines. `canSeeExpected` is false for a person doing a
// blind count: they see what to count, never what the system expects.
const getCount = async (restaurantId, id, { canSeeExpected = true, pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  await requireCountInStore(restaurantId, id, pinnedOutletId);

  const row = await inventoryRepository.findCountById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Stock count not found");
  }

  const posted = row.count_status === "posted";
  // An item being counted blind on another sheet (another store's, say) is
  // hidden on this one too: its expected figure there is still its stock.
  const blindElsewhere = posted ? new Set() : await hiddenItems(restaurantId, canSeeExpected);
  const hideLine = (line) =>
    !canSeeExpected && !posted && (row.blind || blindElsewhere.has(Number(line.inventory_item_id)));
  const hide = row.lines.some(hideLine) || (row.blind && !canSeeExpected && !posted);

  const lines = row.lines.map((line) => {
    const hideThis = hideLine(line);
    const counted = line.counted_quantity === null ? null : Number(line.counted_quantity);
    const system = posted && line.frozen_system !== null ? Number(line.frozen_system) : round3(line.live_system);
    const cost = posted && line.frozen_cost !== null ? Number(line.frozen_cost) : line.last_cost === null ? null : Number(line.last_cost);
    const variance = counted === null ? null : posted && line.variance_quantity !== null ? Number(line.variance_quantity) : round3(counted - system);
    const value = variance === null ? null : posted && line.variance_value !== null ? Number(line.variance_value) : round2(variance * (cost || 0));

    return {
      id: line.id,
      inventoryItemId: line.inventory_item_id,
      itemName: line.item_name,
      code: line.code,
      category: line.category,
      storageArea: line.storage_area,
      unitShortName: line.unit_short_name,
      packs: (line.packs || []).map(toPack),
      countedQuantity: counted,
      enteredAt: line.entered_at,
      enteredByName: line.entered_by_name,
      systemQuantity: hideThis ? null : system,
      varianceQuantity: hideThis ? null : variance,
      unitCost: hideThis ? null : cost,
      varianceValue: hideThis ? null : value,
      ...(hideThis ? { expectedHidden: true } : {}),
      reason: line.reason,
      reasonLabel: line.reason ? COUNT_REASONS[line.reason] : null,
      note: line.note,
    };
  });

  const withVariance = lines.filter((line) => line.varianceQuantity !== null && line.varianceQuantity !== 0);
  const shortage = withVariance.filter((line) => line.varianceValue < 0).reduce((s, l) => s - l.varianceValue, 0);
  const excess = withVariance.filter((line) => line.varianceValue > 0).reduce((s, l) => s + l.varianceValue, 0);

  return {
    ...toCountSummary({
      ...row,
      line_count: lines.length,
      counted_count: lines.filter((line) => line.countedQuantity !== null).length,
      variance_count: withVariance.length,
    }),
    expectedHidden: hide,
    lines,
    totals: hide
      ? null
      : {
          shortageValue: round2(shortage),
          excessValue: round2(excess),
          netValue: round2(excess - shortage),
          needReason: withVariance.filter((line) => !line.reason).length,
        },
    reasons: Object.entries(COUNT_REASONS).map(([value, label]) => ({ value, label })),
  };
};

const createCount = async (restaurantId, data, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  // Someone tied to one outlet counts their own store's shelf, nobody else's.
  if (options.pinnedOutletId) {
    await requirePinnedStore(restaurantId, options.pinnedOutletId, data.outletId);
  }

  const store = await countStoreFor(restaurantId, data.outletId);
  const day = await businessDayRepository.findOpen(restaurantId);

  // Someone counting blind cannot open a second, open-book sheet for the same
  // items (at another store, say) and read the figures off that. A sheet they
  // start over items already being counted blind is blind too.
  const blindItemIds = options.canSeeExpected === false ? [...(await inventoryRepository.findBlindItemIds(restaurantId))] : [];

  const result = await inventoryRepository.createCount(
    restaurantId,
    { ...data, outletId: store.outletId, businessDate: day ? day.business_date : null, blindItemIds },
    userId
  );

  if (result.error === "NO_ITEMS") {
    throw new AppError(
      400,
      data.scope === "low"
        ? "No active item in that store is at or below its reorder level"
        : data.scope === "high_value"
          ? "No active item in that store has stock with a cost to count"
          : data.itemIds && data.itemIds.length
            ? "Those items are not active items of your restaurant"
            : "No active items match those categories and storage areas"
    );
  }

  if (result.error === "ALL_ON_OPEN_SHEETS") {
    throw new AppError(
      409,
      `Every matching item is already on an open count at ${store.name}. Finish or cancel that count first.`
    );
  }

  const count = await getCount(restaurantId, result.id, options);

  return { ...count, skipped: result.skipped, madeBlind: Boolean(result.madeBlind) };
};

const saveCountLines = async (restaurantId, id, data, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  await requireCountInStore(restaurantId, id, pinnedOutletId);

  const result = await inventoryRepository.saveCountLines(restaurantId, id, data, userId);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Stock count not found");
  }

  if (result.error === "NOT_DRAFT") {
    throw new AppError(409, `This count is already ${result.status} and cannot be changed`);
  }

  if (result.error === "LINE_NOT_FOUND") {
    throw new AppError(400, "One of those lines is not on this count sheet");
  }
};

const postCount = async (restaurantId, id, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  await requireCountInStore(restaurantId, id, pinnedOutletId);

  const result = await inventoryRepository.postCount(restaurantId, id, userId, COUNT_REASONS);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Stock count not found");
  }

  if (result.error === "NOT_DRAFT") {
    throw new AppError(409, `This count is already ${result.status}`);
  }

  if (result.error === "NOTHING_COUNTED") {
    throw new AppError(400, "Nothing has been counted on this sheet yet");
  }

  if (result.error === "TOO_LARGE") {
    throw new AppError(
      400,
      `The difference on ${result.itemName} comes to ${rupees(result.value)}, far more than any real count. Check the figure counted for it.`
    );
  }

  if (result.error === "NEED_REASON") {
    const names = result.items.slice(0, 5).join(", ");
    const more = result.items.length > 5 ? ` and ${result.items.length - 5} more` : "";

    throw new AppError(
      400,
      `Give a reason for every difference before posting: ${names}${more}`
    );
  }

  return getCount(restaurantId, id);
};

const cancelCount = async (restaurantId, id, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  await requireCountInStore(restaurantId, id, pinnedOutletId);

  const existing = await inventoryRepository.findCountById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Stock count not found");
  }

  const row = await inventoryRepository.cancelCount(restaurantId, id, userId);

  if (!row) {
    throw new AppError(409, `This count is already ${existing.count_status}`);
  }

  return getCount(restaurantId, id);
};

const varianceReport = async (restaurantId, { from, to, store: storeValue }, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  if (from > to) {
    throw new AppError(400, "The start date is after the end date");
  }

  const store = await resolveStoreFilter(restaurantId, storeValue, pinnedOutletId);
  const rows = await inventoryRepository.findVariance(restaurantId, { from, to, store });

  const byItem = new Map();
  const byReason = new Map();
  const counts = new Set();

  for (const row of rows) {
    counts.add(row.count_id);

    const variance = Number(row.variance_quantity || 0);
    const value = Number(row.variance_value || 0);
    const item = byItem.get(row.inventory_item_id) || {
      inventoryItemId: row.inventory_item_id,
      itemName: row.item_name,
      category: row.category,
      unitShortName: row.unit_short_name,
      timesCounted: 0,
      shortageQuantity: 0,
      shortageValue: 0,
      excessQuantity: 0,
      excessValue: 0,
    };

    item.timesCounted += 1;

    if (variance < 0) {
      item.shortageQuantity = round3(item.shortageQuantity - variance);
      item.shortageValue = round2(item.shortageValue - value);
    } else if (variance > 0) {
      item.excessQuantity = round3(item.excessQuantity + variance);
      item.excessValue = round2(item.excessValue + value);
    }

    byItem.set(row.inventory_item_id, item);

    if (variance !== 0) {
      const key = row.reason || "unexplained";
      const entry = byReason.get(key) || { reason: key, label: COUNT_REASONS[key], lines: 0, value: 0 };

      entry.lines += 1;
      entry.value = round2(entry.value + value);
      byReason.set(key, entry);
    }
  }

  const items = [...byItem.values()]
    .map((item) => ({
      ...item,
      netQuantity: round3(item.excessQuantity - item.shortageQuantity),
      netValue: round2(item.excessValue - item.shortageValue),
    }))
    // The worst losses first: that is the list a manager acts on.
    .sort((a, b) => a.netValue - b.netValue);

  const shortageValue = round2(items.reduce((sum, item) => sum + item.shortageValue, 0));
  const excessValue = round2(items.reduce((sum, item) => sum + item.excessValue, 0));

  return {
    from,
    to,
    store: store ? { mode: store.mode, outletId: store.outletId || null, name: store.name } : null,
    countCount: counts.size,
    items,
    byReason: [...byReason.values()].sort((a, b) => a.value - b.value),
    totals: {
      shortageValue,
      excessValue,
      netValue: round2(excessValue - shortageValue),
      linesCounted: rows.length,
      linesWithVariance: rows.filter((row) => Number(row.variance_quantity || 0) !== 0).length,
    },
  };
};

module.exports = {
  setPreferredSupplier,
  COUNT_REASONS,
  ONE_OUTLET,
  pinnedStore,
  requirePinnedStore,
  requirePinnedStoreId,
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
  recordMovement,
  checkStockOut,
  transfer,
  listBalances,
  valuation,
  listCounts,
  getCount,
  createCount,
  saveCountLines,
  postCount,
  cancelCount,
  varianceReport,
};
