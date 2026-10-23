const kitchenRepository = require("../repositories/kitchen.repository");
const kitchenSlipRepository = require("../repositories/kitchenSlip.repository");
const AppError = require("../../../../utils/AppError");

const DUPLICATE = "23505";

// Food plated and waiting to be picked up this long is going cold. The
// restaurant sets its own beside the kitchen timers (kitchen_settings
// .pass_minutes); this is what it starts at.
const PASS_MINUTES = 8;

const STATION_COLORS = ["orange", "red", "amber", "green", "teal", "blue", "violet", "pink", "slate"];

const STATUS_WORDS = {
  new: "new",
  cooking: "cooking",
  ready: "ready",
  served: "served",
  cancelled: "cancelled",
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// KOT-007: three digits because a busy day runs into the hundreds, and a
// fixed width keeps a column of ticket numbers lined up.
const kotLabel = (number) => `KOT-${String(number).padStart(3, "0")}`;

const toItem = (row) => {
  const quantity = Number(row.quantity);
  const cancelledQuantity = Number(row.cancelled_quantity);

  return {
    id: row.id,
    name: row.item_name,
    variant: row.variant_name,
    // Names in the kitchen's language, as the ticket was cut (null:
    // none set). modifierKitchenNames runs parallel to modifiers.
    kitchenName: row.kitchen_name || null,
    variantKitchenName: row.variant_kitchen_name || null,
    modifierKitchenNames: row.modifier_kitchen_names || [],
    quantity,
    cancelledQuantity,
    liveQuantity: Math.round((quantity - cancelledQuantity) * 100) / 100,
    modifiers: row.modifiers || [],
    components: row.components || [],
    notes: row.notes,
    foodType: row.food_type,
    isDone: row.is_done,
    doneAt: row.done_at,
  };
};

// A guest's own order from the QR code on their table. Accepting it at the
// inbox is what creates the order, so its creator is the person who said yes.
const isQrOrder = (row) => row.source === "qr" || row.order_type === "qr";

// The line the board and the printed KOT carry, so the pass knows whose table
// to call when the food is up: "Taken by Ravi", or "QR · accepted by Ravi".
// Nothing when nobody is on record (an order from before users were tracked).
const takenByLabel = (row) => {
  if (!row.taken_by_name) {
    return null;
  }

  return isQrOrder(row) ? `QR · accepted by ${row.taken_by_name}` : `Taken by ${row.taken_by_name}`;
};

// Who sent this round, when it is worth saying: a later round added by
// someone other than the person who opened the order, or a held course fired
// by someone else. The first round is the order itself, and "Taken by"
// already names who sent it.
const sentByLabel = (row) => {
  if (!row.sent_by_name || row.sent_by_name === row.taken_by_name || Number(row.round) <= 1) {
    return null;
  }

  return `Sent by ${row.sent_by_name}`;
};

const toTicket = (row) => ({
  id: row.id,
  kotNumber: row.kot_number,
  kotNo: kotLabel(row.kot_number),
  status: row.kot_status,
  stationId: row.station_id,
  stationName: row.station_name,
  stationColor: row.station_color,
  orderId: row.order_id,
  orderNumber: row.order_number,
  orderType: row.order_type,
  source: row.source,
  orderStatus: row.order_status,
  tableNo: row.table_no,
  guestCount: row.guest_count,
  customerName: row.customer_name,
  orderNotes: row.order_notes,
  brandName: row.brand_name || null,
  // The parcel's daily token, printed large so the counter can call it.
  tokenNo: row.token_no === null || row.token_no === undefined ? null : Number(row.token_no),
  round: row.round,
  createdAt: row.created_at,
  startedAt: row.started_at,
  readyAt: row.ready_at,
  servedAt: row.served_at,
  cancelledAt: row.cancelled_at,
  recalledAt: row.recalled_at,
  recallCount: row.recall_count,
  printCount: row.print_count,
  lastPrintedAt: row.last_printed_at,
  clearedReason: row.cleared_reason || null,
  servedByName: row.served_by_name,
  takenBy: row.taken_by_name || null,
  takenByLabel: takenByLabel(row),
  sentBy: row.sent_by_name || null,
  sentByLabel: sentByLabel(row),
  // "menu", "kitchen" or "both" — which name the KOT prints.
  nameMode: row.kitchen_name_mode || "both",
  items: (row.items || []).map(toItem),
  // Only on the board: the same order's tickets at other stations.
  ...(row.siblings
    ? {
        siblings: row.siblings.map((sibling) => ({
          id: sibling.id,
          kotNo: kotLabel(sibling.kot_number),
          stationId: sibling.station_id,
          stationName: sibling.station_name,
          stationColor: sibling.station_color,
          status: sibling.kot_status,
        })),
      }
    : {}),
});

const toStation = (row) => ({
  id: row.id,
  name: row.name,
  color: row.color,
  sortOrder: row.sort_order,
  isDefault: row.is_default,
  status: row.status,
  openCount: row.open_count ?? 0,
  lateCount: row.late_count ?? 0,
  categoryCount: row.category_count ?? 0,
  productCount: row.product_count ?? 0,
});

const toSettings = (row) => ({
  warnMinutes: row.warn_minutes,
  lateMinutes: row.late_minutes,
  passMinutes: row.pass_minutes ?? PASS_MINUTES,
  liveSince: row.live_since,
  kitchenNameMode: row.kitchen_name_mode || "both",
});

// ---------------------------------------------------------------- the board

// Everything a kitchen screen needs in one request, so a wall TV on shaky
// wifi makes one call every ten seconds rather than five. Reading the board
// is also what cuts new tickets: whatever the tills sent since the last look
// becomes a KOT before the board is read back.
const board = async (restaurantId, { stationId, outletId, includeEarlier = false }) => {
  requireRestaurantId(restaurantId);

  const sync = await kitchenRepository.sync(restaurantId);
  const settings = await kitchenRepository.findSettings(restaurantId);
  const day = await kitchenRepository.findTodayDayIds(restaurantId, outletId || null);

  // One station's tickets and figures only if it is this restaurant's; an id
  // that is not (removed, mistyped, someone else's) gives the whole kitchen's,
  // and the screen says so.
  const station = stationId ? await kitchenRepository.findStationById(restaurantId, stationId) : null;
  const shownStationId = station ? station.id : null;

  const [tickets, recent, stations, stats, print, slips, earlier] = await Promise.all([
    kitchenRepository.findOpenTickets(restaurantId, outletId, shownStationId, { includeEarlier }),
    // The recall list follows the station on screen, so the tandoor's tablet
    // offers the tandoor's last tickets rather than whatever the bar bumped.
    kitchenRepository.findRecentlyServed(restaurantId, outletId, shownStationId),
    kitchenRepository.findStations(restaurantId, outletId, settings.late_minutes, { todayOnly: !includeEarlier }),
    day.ids.length > 0
      ? kitchenRepository.findStats(restaurantId, {
          dayIds: day.ids,
          stationId: shownStationId,
          outletId,
          lateMinutes: settings.late_minutes,
        })
      : null,
    kitchenRepository.findPrintSettings(restaurantId),
    // The day's change slips: the screen offers to print any nobody has.
    kitchenSlipRepository.findRecent(restaurantId, { outletId, limit: 40 }),
    kitchenRepository.findEarlierOpen(restaurantId, outletId, shownStationId),
  ]);

  return {
    serverTime: new Date().toISOString(),
    businessDay: { date: day.businessDate, isOpen: day.isOpen },
    settings: toSettings(settings),
    // What the tickets below are: one station, or the whole kitchen.
    stationId: shownStationId,
    stations: stations.map(toStation),
    tickets: tickets.map(toTicket),
    // Tickets still open from an earlier trading day. Not on the board (unless
    // ?older=1 asked for them): counted, with how many each "Clear old
    // tickets" age would take off.
    earlierOpen: {
      count: earlier.count,
      oldestAt: earlier.oldest_at,
      shown: Boolean(includeEarlier),
      olderThan: { 60: earlier.over_60, 120: earlier.over_120, 240: earlier.over_240 },
    },
    recentServed: recent.map(toTicket),
    newTicketIds: sync.created.map((ticket) => ticket.id),
    stats: stats
      ? {
          openCount: stats.open_count,
          newCount: stats.new_count,
          cookingCount: stats.cooking_count,
          readyCount: stats.ready_count,
          oldestWaitingAt: stats.oldest_waiting_at,
          avgReadySeconds: stats.avg_ready_seconds,
          timedCount: stats.timed_count,
          lateCount: stats.late_count,
          servedCount: stats.served_count,
          clearedCount: stats.cleared_count,
          totalCount: stats.total_count,
        }
      : null,
    print: {
      restaurantName: print.restaurant_name,
      paperWidth: print.print_paper_width || "80mm",
    },
    // Only this station's, when the screen shows one station.
    changeSlips: shownStationId ? slips.filter((slip) => slip.stationId === shownStationId) : slips,
  };
};

const syncNow = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const result = await kitchenRepository.sync(restaurantId);

  return {
    created: result.created.map((ticket) => ({ ...ticket, kotNo: kotLabel(ticket.kotNumber) })),
    cleared: result.cleared,
    ordersChecked: result.orderIds.length,
  };
};

// One order's tickets, cut first if the kitchen has not seen it yet — so a
// till can print "KOT-014, KOT-015" the moment the order is saved.
// A kitchen working in one outlet (the user is tied to it, or the switcher
// is on it) sees that outlet's tickets on the board, and may open or move
// only those: another outlet's ticket is "not found", exactly as on the
// board. `outletId` null means the whole restaurant.
const TICKET_NOT_FOUND = "Ticket not found in this outlet";

const inOutlet = (row, outletId) => !outletId || Number(row.outlet_id) === Number(outletId);

const requireTicket = async (restaurantId, id, outletId) => {
  const row = await kitchenRepository.findTicketById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Ticket not found");
  }

  if (!inOutlet(row, outletId)) {
    throw new AppError(404, TICKET_NOT_FOUND);
  }

  return row;
};

const orderTickets = async (restaurantId, orderId, outletId = null) => {
  requireRestaurantId(restaurantId);

  if (!(await kitchenRepository.orderExists(restaurantId, orderId, outletId))) {
    throw new AppError(404, outletId ? "Order not found in this outlet" : "Order not found");
  }

  await kitchenRepository.sync(restaurantId, { orderIds: [orderId] });

  return (await kitchenRepository.findTicketsForOrder(restaurantId, orderId)).map(toTicket);
};

const getTicket = async (restaurantId, id, outletId = null) => {
  requireRestaurantId(restaurantId);

  return toTicket(await requireTicket(restaurantId, id, outletId));
};

// ---------------------------------------------------------------- ticket actions

const transitionMessage = (from, to) => {
  if (from === "cancelled") {
    return "This ticket was cancelled at the till, so there is nothing left to cook.";
  }

  if (from === "served") {
    return "This ticket has already gone out. Recall it to bring it back to the pass.";
  }

  if (from === "ready" && to === "new") {
    return "A ready ticket can go back to cooking, not all the way to new.";
  }

  return `A ${STATUS_WORDS[from]} ticket cannot be moved to ${STATUS_WORDS[to]}.`;
};

const setStatus = async (restaurantId, id, status, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  if (outletId) {
    await requireTicket(restaurantId, id, outletId);
  }

  const result = await kitchenRepository.setStatus(restaurantId, id, status, userId);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Ticket not found");
  }

  if (result.error === "BAD_TRANSITION") {
    throw new AppError(409, transitionMessage(result.from, result.to));
  }

  if (result.error === "NOTHING_LEFT") {
    throw new AppError(
      409,
      "Everything on this ticket was cancelled at the till, so there is nothing to recall."
    );
  }

  return { ticket: toTicket(result.ticket), changed: result.changed, from: result.from };
};

// Brings a served ticket back to the pass. Only a served ticket can be
// recalled; anything else is already on the board.
const recallTicket = async (restaurantId, id, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const current = await requireTicket(restaurantId, id, outletId);

  if (current.kot_status !== "served") {
    throw new AppError(409, `${kotLabel(current.kot_number)} is still on the board — nothing to recall.`);
  }

  return setStatus(restaurantId, id, "ready", userId);
};

// The Recall button: the last ticket bumped at this station (or anywhere).
// A station that is not this restaurant's means the whole kitchen, the same
// as on the board, so a screen opened from an old link still recalls what it
// shows.
const recallLast = async (restaurantId, { stationId, outletId }, userId) => {
  requireRestaurantId(restaurantId);

  const station = stationId ? await kitchenRepository.findStationById(restaurantId, stationId) : null;
  const id = await kitchenRepository.findLastServedId(restaurantId, {
    stationId: station ? station.id : null,
    outletId,
  });

  if (!id) {
    throw new AppError(404, "Nothing has been served in the last three hours to recall.");
  }

  return setStatus(restaurantId, id, "ready", userId);
};

const setItemDone = async (restaurantId, kotId, itemId, done, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  if (outletId) {
    await requireTicket(restaurantId, kotId, outletId);
  }

  const result = await kitchenRepository.setItemDone(restaurantId, kotId, itemId, done, userId);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Ticket not found");
  }

  if (result.error === "ITEM_NOT_FOUND") {
    throw new AppError(404, "That dish is not on this ticket");
  }

  if (result.error === "TICKET_CLOSED") {
    throw new AppError(
      409,
      result.status === "cancelled"
        ? "This ticket was cancelled at the till."
        : "This ticket has already gone out. Recall it first to change its dishes."
    );
  }

  if (result.error === "ITEM_CANCELLED") {
    throw new AppError(409, "That dish was cancelled at the till, so it cannot be marked done.");
  }

  return toTicket(result.ticket);
};

// "Clear old tickets": open tickets older than this leave the board as
// cleared. For the end of a rush when the line cooked everything and nobody
// pressed Served, so the board, the oldest-waiting figure and the bell stop
// shouting about food that went out hours ago.
const clearOld = async (restaurantId, { olderThanMinutes, stationId, outletId }, userId) => {
  requireRestaurantId(restaurantId);

  if (stationId && !(await kitchenRepository.findStationById(restaurantId, stationId))) {
    throw new AppError(400, "That station does not exist");
  }

  const result = await kitchenRepository.clearOld(
    restaurantId,
    { olderThanMinutes, stationId, outletId },
    userId
  );

  return { ...result, olderThanMinutes };
};

const recordPrint = async (restaurantId, id, outletId = null) => {
  requireRestaurantId(restaurantId);

  if (outletId) {
    await requireTicket(restaurantId, id, outletId);
  }

  const row = await kitchenRepository.recordPrint(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Ticket not found");
  }

  return toTicket(row);
};

// ---------------------------------------------------------------- change slips
//
// The paper that follows a paper KOT (kitchenSlip.repository): a CANCEL slip
// when dishes the kitchen holds on paper are taken off, a TABLE CHANGED slip
// when they now cook for another table.

// The slips of these orders nobody has printed yet, handed to this till to
// print now and counted as printed (so no other till prints them too). The
// orders are synced first: a slip is written when the kitchen's tickets catch
// up with the change, and the till asks right after saving it.
const claimSlips = async (restaurantId, orderIds, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const ids = [...new Set(orderIds.map(Number))];

  await kitchenRepository.sync(restaurantId, { orderIds: ids });

  return kitchenSlipRepository.claimUnprinted(restaurantId, ids, userId, outletId);
};

// The day's slips (open business days), newest first, or one order's.
const listSlips = async (restaurantId, { outletId = null, orderId = null } = {}) => {
  requireRestaurantId(restaurantId);

  return kitchenSlipRepository.findRecent(restaurantId, { outletId, orderId });
};

// Printing a slip from the list: the first print of one nobody printed, or a
// reprint, which the paper says ("REPRINT").
const printSlip = async (restaurantId, id, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const slip = await kitchenSlipRepository.recordPrint(restaurantId, id, userId, outletId);

  if (!slip) {
    throw new AppError(404, outletId ? "Change slip not found in this outlet" : "Change slip not found");
  }

  return slip;
};

// ---------------------------------------------------------------- stations

const stationSetup = async (restaurantId, outletId) => {
  requireRestaurantId(restaurantId);

  const settings = await kitchenRepository.findSettings(restaurantId);
  const [stations, categories, exceptions] = await Promise.all([
    kitchenRepository.findStations(restaurantId, outletId, settings.late_minutes),
    kitchenRepository.findCategoriesWithStations(restaurantId),
    kitchenRepository.findProductExceptions(restaurantId),
  ]);

  return {
    stations: stations.map(toStation),
    categories: categories.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      productCount: row.product_count,
      stationId: row.station_id,
    })),
    exceptions: exceptions.map((row) => ({
      productId: row.product_id,
      productName: row.name,
      foodType: row.food_type,
      productStatus: row.status,
      categoryId: row.category_id,
      categoryName: row.category_name,
      stationId: row.station_id,
    })),
    settings: toSettings(settings),
  };
};

const duplicateName = (error, name) => {
  if (error.code === DUPLICATE) {
    return new AppError(409, `A station called "${name}" already exists`);
  }

  return error;
};

const createStation = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  // The catch-all exists before anything else, so the first station a
  // restaurant adds is never mistaken for it.
  await kitchenRepository.ensureDefault(restaurantId);

  try {
    return toStation(await kitchenRepository.createStation(restaurantId, data, userId));
  } catch (error) {
    throw duplicateName(error, data.name);
  }
};

const updateStation = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await kitchenRepository.findStationById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Station not found");
  }

  if (existing.is_default && data.status === "inactive") {
    throw new AppError(
      409,
      `"${existing.name}" is the default station. Make another station the default before switching this one off.`
    );
  }

  try {
    return toStation(await kitchenRepository.updateStation(restaurantId, id, data, userId));
  } catch (error) {
    throw duplicateName(error, data.name);
  }
};

const makeDefault = async (restaurantId, id, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await kitchenRepository.findStationById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Station not found");
  }

  if (existing.status !== "active") {
    throw new AppError(400, `Switch "${existing.name}" on before making it the default station.`);
  }

  return toStation(await kitchenRepository.makeDefault(restaurantId, id, userId));
};

// A station id from the browser is checked the same way as any other id: it
// must be this restaurant's, and able to take tickets.
const requireActiveStation = async (restaurantId, stationId) => {
  const station = await kitchenRepository.findStationById(restaurantId, stationId);

  if (!station) {
    throw new AppError(400, "That station does not exist");
  }

  if (station.status !== "active") {
    throw new AppError(400, `"${station.name}" is switched off. Choose an active station.`);
  }

  return station;
};

const setCategoryStation = async (restaurantId, categoryId, stationId, userId) => {
  requireRestaurantId(restaurantId);

  if (!(await kitchenRepository.categoryExists(restaurantId, categoryId))) {
    throw new AppError(404, "Category not found");
  }

  if (stationId) {
    await requireActiveStation(restaurantId, stationId);
  }

  await kitchenRepository.setCategoryStation(restaurantId, categoryId, stationId, userId);
};

const setProductStation = async (restaurantId, productId, stationId, userId) => {
  requireRestaurantId(restaurantId);

  const product = await kitchenRepository.findProduct(restaurantId, productId);

  if (!product) {
    throw new AppError(404, "Dish not found");
  }

  if (stationId) {
    await requireActiveStation(restaurantId, stationId);
  }

  await kitchenRepository.setProductStation(restaurantId, productId, stationId, userId);

  return product;
};

const searchProducts = async (restaurantId, search) => {
  requireRestaurantId(restaurantId);

  const rows = await kitchenRepository.searchProducts(restaurantId, search);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    foodType: row.food_type,
    categoryName: row.category_name,
    exceptionStationId: row.exception_station_id,
    categoryStationId: row.category_station_id,
  }));
};

const getSettings = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  return toSettings(await kitchenRepository.findSettings(restaurantId));
};

const updateSettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  // The pass time (or the names on KOTs) alone: nothing to compare.
  if (data.warnMinutes === undefined) {
    return toSettings(await kitchenRepository.updateSettings(restaurantId, data, userId));
  }

  if (data.lateMinutes <= data.warnMinutes) {
    throw new AppError(
      400,
      "The late mark must come after the warning mark — for example warn at 10 minutes, late at 20."
    );
  }

  return toSettings(await kitchenRepository.updateSettings(restaurantId, data, userId));
};

module.exports = {
  STATION_COLORS,
  board,
  syncNow,
  orderTickets,
  getTicket,
  setStatus,
  recallTicket,
  recallLast,
  setItemDone,
  clearOld,
  recordPrint,
  claimSlips,
  listSlips,
  printSlip,
  stationSetup,
  createStation,
  updateStation,
  makeDefault,
  setCategoryStation,
  setProductStation,
  searchProducts,
  getSettings,
  updateSettings,
};
