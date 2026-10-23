const inventoryInsightRepository = require("../repositories/inventoryInsight.repository");
const purchaseService = require("../../purchasing/services/purchase.service");
// The one store a person tied to an outlet works with (the same rule Items &
// stock follows): their waste, their stock and their reorder plan only.
const { pinnedStore } = require("./inventory.service");
const tradingDay = require("../../business-day/services/tradingDay");
const AppError = require("../../../../utils/AppError");
const ruleSettings = require("../../setup/services/ruleSettings.service");
const { round2 } = require("../../../../utils/money");

// Why stock was thrown away. A fixed list, because the point of recording it is
// to add it up: "spoiled" is a storage problem, "over-prepped" a forecasting
// one, "returned" a quality one, and each has a different fix.
const REASONS = [
  { key: "spoiled", label: "Spoiled" },
  { key: "expired", label: "Expired" },
  { key: "overcooked", label: "Overcooked / burnt" },
  { key: "dropped", label: "Dropped / spilled" },
  { key: "returned", label: "Returned by guest" },
  { key: "over_prepped", label: "Over-prepped" },
  // A finished dish thrown away because it was made twice and billed once,
  // or sent back over its quality (Dish wasted).
  { key: "remade", label: "Remade dish" },
  { key: "quality", label: "Quality complaint" },
  // A bakery's breads and cakes left at closing and not kept for tomorrow.
  { key: "unsold", label: "Unsold at day end" },
  { key: "other", label: "Other" },
];

// Wastage written before reasons existed, or through Stock out on the items
// screen, has none. It is shown as such rather than guessed.
const UNSPECIFIED = { key: "unspecified", label: "Not given" };

const REASON_KEYS = REASONS.map((reason) => reason.key);
const reasonLabel = (key) =>
  (REASONS.find((reason) => reason.key === key) || UNSPECIFIED).label;

// Reorder maths. Kept as named numbers so the helper line on the screen and
// the calculation can never disagree. The look-back and the safety cushion
// are the restaurant's own (Settings -> Alerts and timings, read per plan);
// these are what it starts at.
const USAGE_DAYS = ruleSettings.DEFAULTS.reorderLookbackDays; // how far back "how fast does it go" looks
const SAFETY_DAYS = ruleSettings.DEFAULTS.reorderSafetyDays; // cushion on top of the horizon, for a late delivery
const CRITICAL_DAYS = 2; // under this much cover left, it is urgent

// A mistaken entry can be undone for a week. After that the stock has been
// counted since, and a correction belongs in a stock adjustment.
const REVERSE_WINDOW_DAYS = 7;

// Stock quantities are NUMERIC to three places: a gram of a kilo item.
const MIN_QUANTITY = 0.001;

const DAY = 86400000;

// Bumped whenever this module changes what the reorder plan would say — waste
// logged or undone, a draft order made — so anything holding a copy of the
// plan (the bell caches one for a couple of minutes) knows to work it out
// again rather than show the old one.
const planVersions = new Map();

const planVersion = (restaurantId) => planVersions.get(Number(restaurantId)) || 0;

const planChanged = (restaurantId) => {
  planVersions.set(Number(restaurantId), planVersion(restaurantId) + 1);
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// --- dates ---

const localDate = (now, timezone) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

const addDays = (isoDate, days) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY);

// "4:10pm" on the restaurant's clock.
const clockTime = (at, timezone) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(new Date(at))
    .replace(/\s?([ap])\.?m\.?$/i, (_, half) => `${half.toLowerCase()}m`);

// "Today" is the open business day, which is not the calendar date once a
// kitchen runs past midnight. With none open, today on the restaurant's
// clock — or, before the cut-off hour after last night's day was closed,
// still last night (tradingDay.dateWithNoDayOpen, as the dashboard reads it).
const getContext = async (restaurantId, now = new Date()) => {
  const row = await inventoryInsightRepository.findContext(restaurantId);
  const timezone = (row && row.timezone) || "Asia/Kolkata";
  const noDayOpen = () => {
    try {
      return tradingDay.dateWithNoDayOpen(
        { timezone, day_cutoff_hour: row ? row.day_cutoff_hour : null },
        row ? row.last_business_date : null,
        now
      );
    } catch {
      return localDate(now, timezone);
    }
  };

  return {
    timezone,
    currency: (row && row.currency_symbol) || "₹",
    businessDate: (row && row.open_business_date) || noDayOpen(),
    // The calendar date on the restaurant's clock. The wastage range ends on
    // it by default: a business day left open since 23 Sep must not keep the
    // chart on that week.
    calendarDate: localDate(now, timezone),
  };
};

// --- quantities ---

const round3 = (value) => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;

const COUNTED = /^(pc|pcs|piece|pieces|nos|no|pkt|packet|packets|box|boxes|btl|bottle|bottles|can|cans|tin|tins|tray|trays|bag|bags|jar|jars|roll|rolls|dozen|dz|ea|each|unit|units)$/i;
const SMALL = /^(g|gm|gms|gram|grams|ml|millilitre|milliliter)$/i;

// What a sensible order quantity looks like for this unit: nobody orders
// 7.37 kg of onions or 43 bottles of water. Rounded UP, so rounding never
// leaves the kitchen short.
const orderStep = (quantity, unit) => {
  if (COUNTED.test(unit || "")) {
    return quantity < 20 ? 1 : quantity < 100 ? 5 : 10;
  }

  if (SMALL.test(unit || "")) {
    return quantity < 500 ? 50 : quantity < 2000 ? 100 : 500;
  }

  // kg, litres, and anything else measured.
  return quantity < 5 ? 0.5 : quantity < 20 ? 1 : quantity < 100 ? 5 : 10;
};

const roundOrder = (quantity, unit) => {
  if (quantity <= 0) {
    return 0;
  }

  const step = orderStep(quantity, unit);
  return round3(Math.ceil(quantity / step - 1e-9) * step);
};

// --- wastage ---

const toEntry = (row, context) => {
  const reversed = row.reversal_id !== null && row.reversal_id !== undefined;
  const logged = new Date(row.created_at);
  const loggedDate = localDate(logged, context.timezone);
  const quantity = Math.abs(Number(row.quantity));
  const unitCost = row.unit_cost === null || row.unit_cost === undefined ? null : Number(row.unit_cost);

  return {
    id: row.id,
    date: row.waste_date,
    loggedAt: row.created_at,
    // The time is only worth showing when it was logged on the day (or the
    // night after) — an entry typed in days later would otherwise read as if
    // the waste happened at that hour.
    loggedTime:
      loggedDate === row.waste_date || loggedDate === addDays(row.waste_date, 1)
        ? clockTime(logged, context.timezone)
        : null,
    inventoryItemId: row.inventory_item_id,
    itemName: row.item_name,
    category: row.category || null,
    unit: row.unit,
    quantity,
    unitCost,
    value: Number(row.value),
    reason: row.waste_reason || UNSPECIFIED.key,
    reasonLabel: reasonLabel(row.waste_reason),
    // A reasoned entry keeps the label in `reason` and the cook's words in
    // `notes`. Older entries only ever had the free text.
    note: row.waste_reason
      ? row.notes || null
      : [row.reason, row.notes].filter(Boolean).join(" — ") || null,
    loggedBy: row.logged_by || null,
    // The outlet store it came off; null is the main store.
    store: row.store_name || null,
    reversed,
    reversedAt: reversed ? row.reversed_at : null,
    reversedBy: reversed ? row.reversed_by || null : null,
    reversalNote: reversed ? row.reversal_note || null : null,
    // An ingredient of a dish written off (Dish wasted): undone with its dish,
    // never on its own, so the dish entry and its rows always agree.
    dishWasteId: row.reference_type === "dish_waste" && row.reference_id ? Number(row.reference_id) : null,
    reversible:
      !reversed && row.reference_type !== "dish_waste" && row.waste_date >= addDays(context.businessDate, -REVERSE_WINDOW_DAYS),
  };
};

// A week by default — today and the six days before it — because a kitchen
// reviews waste week on week, and a week has a week before it to compare with.
const resolveRange = (context, from, to) => {
  // Whichever is later, so a day opened ahead of the calendar still shows.
  const latest =
    context.calendarDate && context.calendarDate > context.businessDate ? context.calendarDate : context.businessDate;
  const end = to || latest;
  // A business day left open from an earlier date files today's waste on
  // that date: the default week then reaches back to it, so what was just
  // logged is on the list (the screen says the day is an old one).
  const weekStart = addDays(end, -6);
  const start = from || (!to && context.businessDate && context.businessDate < weekStart ? context.businessDate : weekStart);

  if (start > end) {
    throw new AppError(400, "The start date cannot be after the end date");
  }

  if (daysBetween(start, end) > 366) {
    throw new AppError(400, "Pick a range of a year or less");
  }

  return { from: start, to: end };
};

// options.store (from pinnedStore) names the store outright; otherwise a
// pinned person's outlet decides it.
const wastageReport = async (restaurantId, filters, { pinnedOutletId = null, store: given } = {}) => {
  requireRestaurantId(restaurantId);

  const store = given !== undefined ? given : await pinnedStore(restaurantId, pinnedOutletId);
  const context = await getContext(restaurantId);
  const range = resolveRange(context, filters.from, filters.to);
  const days = daysBetween(range.from, range.to) + 1;
  // The same number of days immediately before, so a week is compared with
  // the week before it and a month with the month before.
  const previous = { from: addDays(range.from, -days), to: addDays(range.from, -1) };

  const [totals, byReason, byDay, byItem, list] = await Promise.all([
    inventoryInsightRepository.wastageTotals(restaurantId, range, previous, store),
    inventoryInsightRepository.wastageByReason(restaurantId, range.from, range.to, store),
    inventoryInsightRepository.wastageByDay(restaurantId, range.from, range.to, store),
    inventoryInsightRepository.wastageByItem(restaurantId, range.from, range.to, 8, store),
    inventoryInsightRepository.findWastage(restaurantId, {
      ...range,
      reason: filters.reason,
      itemId: filters.itemId,
      limit: filters.limit,
      store,
    }),
  ]);

  const value = round2(totals.value);
  const previousValue = round2(totals.previous_value);

  const reasons = byReason.map((row) => ({
    reason: row.reason,
    label: reasonLabel(row.reason === UNSPECIFIED.key ? null : row.reason),
    value: Number(row.value),
    entries: row.entries,
    share: value > 0 ? Math.round((Number(row.value) / value) * 1000) / 10 : 0,
  }));

  // Every day in the range, including the ones with nothing thrown away —
  // leaving them out would draw a good day as if it never happened.
  const found = new Map(byDay.map((row) => [row.date, row]));
  const daily = [];

  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    const row = found.get(date);
    daily.push({
      date,
      value: row ? Number(row.value) : 0,
      entries: row ? row.entries : 0,
      inProgress: date === context.businessDate || date === context.calendarDate,
    });
  }

  const items = byItem.map((row) => ({
    inventoryItemId: row.inventory_item_id,
    name: row.item_name,
    unit: row.unit,
    quantity: round3(row.quantity),
    value: Number(row.value),
    entries: row.entries,
    usualReason: row.usual_reason,
    usualReasonLabel: reasonLabel(row.usual_reason === UNSPECIFIED.key ? null : row.usual_reason),
  }));

  return {
    from: range.from,
    to: range.to,
    days,
    // The store these figures are for, when they are one store's only.
    store: store ? { outletId: store.outletId, name: store.name, via: store.via || null } : null,
    businessDate: context.businessDate,
    today: context.calendarDate,
    currency: context.currency,
    reasons: REASONS,
    reverseWindowDays: REVERSE_WINDOW_DAYS,
    summary: {
      value,
      entries: totals.entries,
      items: totals.items,
      perDay: round2(value / days),
      previous: { ...previous, value: previousValue, entries: totals.previous_entries },
      // Null rather than +100% or infinity when there was nothing before:
      // "up from nothing" is not a percentage.
      change: previousValue > 0 ? Math.round(((value - previousValue) / previousValue) * 1000) / 10 : null,
      topReason: reasons[0] || null,
      topItem: items[0] || null,
    },
    byReason: reasons,
    daily,
    topItems: items,
    entries: {
      items: list.rows.map((row) => toEntry(row, context)),
      // Reversed entries stay on the log, struck through, but leave every
      // total — so the log says how many of its rows those are, and the
      // headline count matches the tiles.
      total: list.total,
      reversed: list.reversed,
      limit: filters.limit,
    },
  };
};

// One page of the wastage log, newest first, for the screen's grid: the
// figures above it come from wastageReport once, and paging through the
// entries does not add them up again.
const wastageEntries = async (restaurantId, filters = {}, { store = null } = {}) => {
  requireRestaurantId(restaurantId);

  const context = await getContext(restaurantId);
  const range = resolveRange(context, filters.from, filters.to);
  const list = await inventoryInsightRepository.findWastage(restaurantId, {
    ...range,
    reason: filters.reason,
    itemId: filters.itemId,
    limit: filters.limit,
    offset: filters.offset || 0,
    store,
  });

  return {
    from: range.from,
    to: range.to,
    items: list.rows.map((row) => toEntry(row, context)),
    total: list.total,
    reversed: list.reversed,
    limit: filters.limit,
    offset: filters.offset || 0,
  };
};

// Every check a wastage entry must pass, made before anything is written —
// and before a manager is asked for a PIN when the entry is over the
// write-off limit, so an approval is never spent on an entry that is then
// refused. Returns the item, the shelf it comes off and what it is worth at
// the price the entry will be valued at (the item's last cost, as the log
// stamps it).
const checkWastage = async (restaurantId, data) => {
  requireRestaurantId(restaurantId);

  const item = await inventoryInsightRepository.findItem(restaurantId, data.inventoryItemId);

  if (!item) {
    throw new AppError(400, "Selected item does not exist");
  }

  if (!(data.quantity >= MIN_QUANTITY)) {
    throw new AppError(
      400,
      `The smallest amount that can be logged is ${MIN_QUANTITY} ${item.unit}. Check the quantity for ${item.name}.`
    );
  }

  if (data.reason === "other" && !data.note) {
    throw new AppError(400, "Say what happened when the reason is Other, so it can be followed up");
  }

  const stock = Number(item.current_stock);

  if (stock <= 0) {
    throw new AppError(
      400,
      `${item.name} shows no stock (${round3(stock)} ${item.unit}), so there is nothing to write off. Count it and correct the stock first.`
    );
  }

  const store = await inventoryInsightRepository.findStoreStock(restaurantId, item.id, data.outletId);
  const available = Math.min(stock, store.quantity);
  const where = store.storeId
    ? ` at ${store.storeName}`
    : round3(store.quantity) !== round3(stock)
      ? " at the main store"
      : "";

  if (available <= 0) {
    throw new AppError(
      400,
      `No ${item.name} is in stock${where} — the ${round3(stock)} ${item.unit} on hand is held at another store. Log the waste from the outlet where it was thrown away.`
    );
  }

  if (data.quantity > available) {
    throw new AppError(
      400,
      `Only ${round3(available)} ${item.unit} of ${item.name} is in stock${where}. Check the quantity — or count the shelf, the figure may be wrong.`
    );
  }

  const cost = item.last_cost === null || item.last_cost === undefined ? 0 : Number(item.last_cost);

  return { item, store, where, value: round2(data.quantity * cost) };
};

const logWastage = async (restaurantId, data, userId) => {
  // Billing can take stock below zero rather than refuse a guest, so a
  // negative or zero figure means the count is already wrong and writing
  // more off would only bury the problem. Waste comes off the shelf it was
  // on: the outlet's own store when the outlet the cook is working in keeps
  // one, else the main store — the same test recordMovement applies, made
  // first so the refusal can say where (checkWastage).
  const { item, where } = await checkWastage(restaurantId, data);

  let result;

  try {
    result = await inventoryInsightRepository.insertWastage(
      restaurantId,
      {
        inventoryItemId: item.id,
        outletId: data.outletId || null,
        quantity: data.quantity,
        reason: data.reason,
        reasonLabel: reasonLabel(data.reason),
        note: data.note,
      },
      userId
    );
  } catch (error) {
    // Someone else took stock out between the check above and this write.
    if (error.code === "NEGATIVE_STOCK") {
      throw new AppError(
        400,
        `Only ${round3(error.currentStock)} ${item.unit} of ${item.name} is in stock${where} now`
      );
    }

    throw error;
  }

  if (!result) {
    throw new AppError(400, "Selected item does not exist");
  }

  planChanged(restaurantId);

  const context = await getContext(restaurantId);
  const row = await inventoryInsightRepository.findWastageById(restaurantId, result.id);

  return {
    entry: toEntry(row, context),
    item: {
      id: item.id,
      name: item.name,
      unit: item.unit,
      currentStock: round3(result.balance),
    },
  };
};

const reverseWastage = async (restaurantId, id, note, userId, { pinnedOutletId = null } = {}) => {
  requireRestaurantId(restaurantId);

  const row = await inventoryInsightRepository.findWastageById(restaurantId, id);
  const store = await pinnedStore(restaurantId, pinnedOutletId);
  const rowStore = row && row.outlet_id !== null ? Number(row.outlet_id) : null;

  // Anything that is not one of this restaurant's wastage rows — another
  // tenant's, a purchase, a bill's consumption — is simply not found. So is
  // another store's entry, for someone tied to one outlet.
  if (!row || row.transaction_type !== "wastage" || (store && rowStore !== store.storeId)) {
    throw new AppError(404, "Wastage entry not found");
  }

  if (row.reference_type === "dish_waste") {
    throw new AppError(
      409,
      "This was taken out with a dish written off. Undo the dish under Dish wasted, and all its ingredients go back together."
    );
  }

  const context = await getContext(restaurantId);

  if (row.reversal_id) {
    throw new AppError(409, `This entry was already reversed${row.reversed_by ? ` by ${row.reversed_by}` : ""}`);
  }

  if (row.waste_date < addDays(context.businessDate, -REVERSE_WINDOW_DAYS)) {
    throw new AppError(
      409,
      `Entries older than ${REVERSE_WINDOW_DAYS} days cannot be undone — the stock has been counted since. Correct it with Stock in on Items & stock.`
    );
  }

  const result = await inventoryInsightRepository.reverseWastage(restaurantId, row, note, userId);

  if (result.error === "ALREADY") {
    throw new AppError(409, "This entry was already reversed");
  }

  planChanged(restaurantId);

  const updated = await inventoryInsightRepository.findWastageById(restaurantId, id);

  return {
    entry: toEntry(updated, context),
    item: { id: row.inventory_item_id, name: row.item_name, unit: row.unit, currentStock: round3(result.balance) },
  };
};

// --- reorder ---

// "Low" uses the same yardstick as the suggestion — the horizon plus the
// safety days. Measured against the horizon alone, an item with 8 days left on
// a 7-day plan read "OK" while the card beside it said "order 9 L", and nobody
// could tell why an OK item was being bought.
const statusOf = (stock, reorderLevel, cover, horizon, safetyDays = SAFETY_DAYS) => {
  if (stock <= 0) {
    return "out";
  }

  if (cover !== null && cover < CRITICAL_DAYS) {
    return "critical";
  }

  if ((reorderLevel > 0 && stock <= reorderLevel) || (cover !== null && cover < horizon + safetyDays)) {
    return "low";
  }

  return "ok";
};

const URGENCY = { out: 0, critical: 1, low: 2, ok: 3 };

// A price worth quoting, or null. Nothing is ever bought for ₹0: a zero is a
// line nobody priced (an item with no cost yet, a draft typed without one), so
// it is treated as no price — and flagged — rather than quoted as free.
const knownPrice = (value) =>
  value !== null && value !== undefined && Number(value) > 0 ? Number(value) : null;

const toReorderLine = (row, { horizon, now, windowStart, usageDays = USAGE_DAYS, safetyDays = SAFETY_DAYS }) => {
  const stock = Number(row.current_stock);
  const reorderLevel = Number(row.reorder_level);
  const sold = Math.max(0, Number(row.sold));
  const wasted = Math.max(0, Number(row.wasted));
  const onOrder = Math.max(0, Number(row.on_order));
  const inDraft = Math.max(0, Number(row.in_draft));

  // Averaged over the part of the fortnight the item has actually been in
  // use, so an ingredient added four days ago is not read as a quarter as busy
  // as it really is. At least a day, so one early sale cannot look like a flood.
  const starts = [new Date(row.created_at).getTime()];

  if (row.first_sold_at) {
    starts.push(new Date(row.first_sold_at).getTime());
  }

  if (row.first_waste_date) {
    starts.push(Date.parse(`${row.first_waste_date}T00:00:00Z`));
  }

  const since = Math.max(windowStart.getTime(), Math.min(...starts));
  const days = Math.min(usageDays, Math.max(1, (now.getTime() - since) / DAY));

  const soldPerDay = sold / days;
  const wastedPerDay = wasted / days;
  const dailyUsage = soldPerDay + wastedPerDay;

  const cover = dailyUsage > 0 ? Math.max(0, stock) / dailyUsage : null;
  const status = statusOf(stock, reorderLevel, cover, horizon, safetyDays);

  // Enough to last the horizon plus a safety cushion — and never less than
  // twice the reorder level, so an item the kitchen sets a floor for is topped
  // up to comfortably above it rather than back onto it.
  const covered = stock + onOrder + inDraft;
  const target = Math.max(dailyUsage * (horizon + safetyDays), reorderLevel * 2);
  const needsOrder =
    covered <= reorderLevel || (dailyUsage > 0 && covered < dailyUsage * (horizon + safetyDays));
  const suggested = needsOrder ? roundOrder(target - covered, row.unit) : 0;

  const price = knownPrice(row.last_price) ?? knownPrice(row.last_cost);

  const supplierActive = row.last_supplier_id && row.last_supplier_status === "active";

  return {
    id: row.id,
    name: row.name,
    code: row.code,
    category: row.category,
    unit: row.unit,
    currentStock: round3(stock),
    reorderLevel: round3(reorderLevel),
    onOrder: round3(onOrder),
    inDraft: round3(inDraft),
    orders: (row.orders || []).map((order) => ({ ...order, quantity: round3(order.quantity) })),
    soldPerDay: round3(soldPerDay),
    wastedPerDay: round3(wastedPerDay),
    dailyUsage: round3(dailyUsage),
    usageDays: Math.round(days * 10) / 10,
    daysOfCover: cover === null ? null : Math.round(cover * 10) / 10,
    status,
    suggestedQuantity: suggested,
    unitPrice: price,
    suggestedValue: price === null ? null : round2(suggested * price),
    supplier: supplierActive
      ? {
          id: row.last_supplier_id,
          name: row.last_supplier_name,
          mobile: row.last_supplier_mobile,
          // Chosen by hand as the item's supplier, rather than read off the
          // last order or bill.
          chosen: Boolean(row.supplier_chosen),
        }
      : null,
    // Bought before from a supplier since switched off: worth saying, so
    // nobody wonders why the usual name is missing.
    previousSupplier:
      row.last_supplier_id && !supplierActive ? row.last_supplier_name || null : null,
    lastOrderDate: row.last_order_date || null,
  };
};

// `store` (from pinnedStore): one store's plan, for someone tied to an outlet.
// `horizon` left out: the restaurant's own default.
const reorder = async (restaurantId, { horizon: asked = null, store = null } = {}, now = new Date()) => {
  requireRestaurantId(restaurantId);

  const [context, rules] = await Promise.all([getContext(restaurantId, now), ruleSettings.load(restaurantId)]);
  const horizon = asked || rules.reorderHorizonDays;
  const usageDays = rules.reorderLookbackDays;
  const safetyDays = rules.reorderSafetyDays;
  const windowStart = new Date(now.getTime() - usageDays * DAY);
  const windowStartDate = addDays(context.businessDate, -(usageDays - 1));

  const rows = await inventoryInsightRepository.findReorderRows(
    restaurantId,
    windowStart.toISOString(),
    windowStartDate,
    store
  );

  const lines = rows
    .map((row) => toReorderLine(row, { horizon, now, windowStart, usageDays, safetyDays }))
    .sort(
      (a, b) =>
        URGENCY[a.status] - URGENCY[b.status] ||
        (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) ||
        a.name.localeCompare(b.name)
    );

  // One card per supplier: the one chosen for the item, else the one it was
  // last bought from — so the
  // draft order it makes is one the supplier will recognise.
  const groups = new Map();

  for (const line of lines.filter((row) => row.suggestedQuantity > 0)) {
    const key = line.supplier ? line.supplier.id : "unassigned";

    if (!groups.has(key)) {
      groups.set(key, {
        supplierId: line.supplier ? line.supplier.id : null,
        supplierName: line.supplier ? line.supplier.name : null,
        supplierMobile: line.supplier ? line.supplier.mobile : null,
        lines: [],
      });
    }

    groups.get(key).lines.push(line);
  }

  const supplierGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      value: round2(group.lines.reduce((sum, line) => sum + (line.suggestedValue || 0), 0)),
      urgent: group.lines.filter((line) => line.status === "out" || line.status === "critical").length,
      unpriced: group.lines.filter((line) => line.unitPrice === null).length,
    }))
    // The most urgent supplier first; the pile with no supplier last, because
    // it needs a decision before it can become an order.
    .sort(
      (a, b) =>
        (a.supplierId === null) - (b.supplierId === null) ||
        b.urgent - a.urgent ||
        b.value - a.value
    );

  const count = (status) => lines.filter((line) => line.status === status).length;
  const toOrder = lines.filter((line) => line.suggestedQuantity > 0);

  return {
    businessDate: context.businessDate,
    currency: context.currency,
    store: store ? { outletId: store.outletId, name: store.name, via: store.via || null } : null,
    horizon,
    // The restaurant's own default, so a screen can mark it among its choices.
    defaultHorizon: rules.reorderHorizonDays,
    safetyDays,
    usageDays,
    criticalDays: CRITICAL_DAYS,
    summary: {
      items: lines.length,
      out: count("out"),
      critical: count("critical"),
      low: count("low"),
      ok: count("ok"),
      toOrder: toOrder.length,
      toOrderValue: round2(toOrder.reduce((sum, line) => sum + (line.suggestedValue || 0), 0)),
      suppliers: supplierGroups.filter((group) => group.supplierId !== null).length,
      unassigned: groups.has("unassigned") ? groups.get("unassigned").lines.length : 0,
      onOrderItems: lines.filter((line) => line.onOrder > 0).length,
      draftItems: lines.filter((line) => line.inDraft > 0).length,
    },
    groups: supplierGroups,
    items: lines,
  };
};

// A real draft purchase order, made by the purchasing service exactly as the
// Purchase orders screen would make one. Prices come from what THIS supplier
// last charged for each item, then the item's last cost — never from the
// browser.
const createDraftOrder = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const supplier = await inventoryInsightRepository.findSupplier(restaurantId, data.supplierId);

  if (!supplier) {
    throw new AppError(400, "Selected supplier does not exist");
  }

  if (supplier.status !== "active") {
    throw new AppError(
      400,
      `${supplier.name} is marked inactive. Pick another supplier, or reactivate them under Suppliers.`
    );
  }

  // Rounded to the gram before anything else, so a line that rounds to nothing
  // is dropped here rather than landing on the order as a zero.
  const lines = data.lines
    .map((line) => ({ ...line, quantity: round3(line.quantity) }))
    .filter((line) => line.quantity > 0);

  if (lines.length === 0) {
    throw new AppError(400, "Add at least one item with a quantity above zero");
  }

  const ids = lines.map((line) => line.inventoryItemId);

  if (new Set(ids).size !== ids.length) {
    throw new AppError(400, "The same item is listed twice");
  }

  const [items, prices, context, rules] = await Promise.all([
    inventoryInsightRepository.findItemsByIds(restaurantId, ids),
    inventoryInsightRepository.findSupplierPrices(restaurantId, supplier.id, ids),
    getContext(restaurantId),
    ruleSettings.load(restaurantId),
  ]);

  const itemById = new Map(items.map((item) => [Number(item.id), item]));
  const priceById = new Map(prices.map((row) => [Number(row.inventory_item_id), Number(row.unit_price)]));

  for (const line of lines) {
    const item = itemById.get(Number(line.inventoryItemId));

    if (!item) {
      throw new AppError(400, "One of the selected items does not exist");
    }

    if (item.status !== "active") {
      throw new AppError(400, `${item.name} is inactive. Reactivate it before ordering more.`);
    }
  }

  const unpriced = [];
  const orderItems = lines.map((line) => {
    const item = itemById.get(Number(line.inventoryItemId));
    // A zero from anywhere is "nobody priced it", not a price — so the line
    // stays flagged and the draft's note keeps asking for one.
    const known = knownPrice(priceById.get(Number(item.id))) ?? knownPrice(item.last_cost);

    if (known === null) {
      unpriced.push(item.name);
    }

    return {
      inventoryItemId: Number(item.id),
      quantity: line.quantity,
      unitPrice: known === null ? 0 : known,
    };
  });

  const horizonText = `${data.horizon || rules.reorderHorizonDays}-day`;
  const notes = [
    `Drafted from Waste & reorder: ${horizonText} cover plus ${rules.reorderSafetyDays} days' safety.`,
    unpriced.length
      ? `No price on record for ${unpriced.join(", ")} — agree one with the supplier before sending.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  let order;

  try {
    order = await purchaseService.create(
      restaurantId,
      {
        supplierId: supplier.id,
        orderDate: context.businessDate,
        expectedDate: null,
        poStatus: "draft",
        notes,
        items: orderItems,
        // A plan made for one outlet's store is delivered there.
        outletId: data.outletId || null,
      },
      userId
    );
  } catch (error) {
    // Purchase order numbers are counted, not stored in a sequence, so once
    // an older draft has been deleted the next number can already be taken.
    // Say so plainly rather than failing with a server error.
    if (error.code === "23505") {
      throw new AppError(
        409,
        "The next purchase order number is already in use — an older draft was probably deleted. Delete the newest draft on Purchase orders and try again."
      );
    }

    throw error;
  }

  planChanged(restaurantId);

  return { order, unpriced };
};

// The handful of figures a dashboard wants from this module, in one call.
const summary = async (restaurantId, now = new Date(), { pinnedOutletId = null, store: given } = {}) => {
  requireRestaurantId(restaurantId);

  const store = given !== undefined ? given : await pinnedStore(restaurantId, pinnedOutletId);
  const context = await getContext(restaurantId, now);
  const weekFrom = addDays(context.businessDate, -6);

  const [today, week, plan] = await Promise.all([
    inventoryInsightRepository.wastageTotals(
      restaurantId,
      { from: context.businessDate, to: context.businessDate },
      { from: context.businessDate, to: context.businessDate },
      store
    ),
    inventoryInsightRepository.wastageTotals(
      restaurantId,
      { from: weekFrom, to: context.businessDate },
      { from: addDays(weekFrom, -7), to: addDays(weekFrom, -1) },
      store
    ),
    reorder(restaurantId, { store }, now),
  ]);

  return {
    businessDate: context.businessDate,
    store: store ? { outletId: store.outletId, name: store.name, via: store.via || null } : null,
    currency: context.currency,
    wasteToday: { value: round2(today.value), entries: today.entries },
    wasteLast7Days: {
      value: round2(week.value),
      entries: week.entries,
      previousValue: round2(week.previous_value),
    },
    stock: {
      out: plan.summary.out,
      critical: plan.summary.critical,
      low: plan.summary.low,
      toOrder: plan.summary.toOrder,
      toOrderValue: plan.summary.toOrderValue,
    },
  };
};

module.exports = {
  REASONS,
  REASON_KEYS,
  USAGE_DAYS,
  planVersion,
  planChanged,
  getContext,
  wastageReport,
  wastageEntries,
  checkWastage,
  logWastage,
  reverseWastage,
  reorder,
  createDraftOrder,
  summary,
};
