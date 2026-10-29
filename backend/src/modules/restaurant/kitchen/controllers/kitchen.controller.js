const kitchenService = require("../services/kitchen.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { isCalendarDate } = require("../../../../utils/calendarDate");

const TICKET_STATUSES = ["new", "cooking", "ready", "served"];

const isBlank = (value) => value === undefined || value === null || value === "";

// Ids are whole numbers. Checked here rather than left to the database, so
// "1.5" or a twenty-digit id is a 400 that says what is wrong, not a 500
// from Postgres failing to read it as a bigint.
const readId = (value, field) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  if (typeof number !== "number" || Number.isNaN(number)) {
    throw new AppError(400, `${field} must be a number`);
  }

  if (!Number.isInteger(number) || number < 1) {
    throw new AppError(400, `${field} must be a whole number above zero`);
  }

  if (!Number.isSafeInteger(number)) {
    throw new AppError(400, `${field} is too large to be a real id`);
  }

  return number;
};

const optionalId = (value, field) => (isBlank(value) ? null : readId(value, field));

// A whole number within a range, for counts and minutes.
const readWhole = (value, field, { min, max }) => {
  const number = v.requiredNumber(value, field, { min, max });

  if (!Number.isInteger(number)) {
    throw new AppError(400, `${field} must be a whole number`);
  }

  return number;
};

// ?station=3 narrows the board to one station; empty means the whole kitchen.
const readStationFilter = (source = {}) =>
  optionalId(isBlank(source.stationId) ? source.station : source.stationId, "Station");

const readStation = (body = {}) => ({
  name: v.requiredString(body.name, "Station name", 60),
  color: v.optionalEnum(body.color, "Colour", kitchenService.STATION_COLORS, "orange"),
  sortOrder: isBlank(body.sortOrder)
    ? 0
    : readWhole(body.sortOrder, "Display order", { min: 0, max: 999 }),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

// null clears the mapping, so the category or dish falls back to the default.
const readStationId = (body = {}) => optionalId(body.stationId, "Station");

// ---------------------------------------------------------------- the board

const board = async (req, res) => {
  const data = await kitchenService.board(req.user.restaurantId, {
    stationId: readStationFilter(req.query),
    outletId: req.outletId,
    // ?older=1: also the tickets left open from earlier days.
    includeEarlier: req.query.older === "1" || req.query.older === "true",
  });

  res.json({ success: true, data });
};

// The food at the pass, for the floor (the captain app): the outlet the
// person works in, or the whole restaurant.
const pass = async (req, res) => {
  res.json({ success: true, data: await kitchenService.pass(req.user.restaurantId, req.outletId) });
};

const sync = async (req, res) => {
  const data = await kitchenService.syncNow(req.user.restaurantId);

  res.json({
    success: true,
    message:
      data.created.length === 0
        ? "Nothing new for the kitchen"
        : `${data.created.length} new ${data.created.length === 1 ? "ticket" : "tickets"} sent to the kitchen`,
    data,
  });
};

const orderTickets = async (req, res) => {
  const orderId = readId(req.params.orderId, "Order id");

  res.json({
    success: true,
    data: await kitchenService.orderTickets(req.user.restaurantId, orderId, req.outletId),
  });
};

const getTicket = async (req, res) => {
  const id = readId(req.params.id, "Ticket id");

  res.json({ success: true, data: await kitchenService.getTicket(req.user.restaurantId, id, req.outletId) });
};

const MOVED = {
  new: "back to new",
  cooking: "cooking",
  ready: "ready at the pass",
  served: "served",
};

const setStatus = async (req, res) => {
  const id = readId(req.params.id, "Ticket id");
  const status = v.requiredEnum(req.body?.status, "Status", TICKET_STATUSES);

  const result = await kitchenService.setStatus(
    req.user.restaurantId,
    id,
    status,
    req.user.id,
    req.outletId
  );

  // Bringing a served ticket back is the one move worth a line in the audit
  // log: done often, it means plates are going out wrong.
  if (result.changed && result.from === "served") {
    logAction(req, "recall", "kot", { id, label: result.ticket.kotNo });
  }

  res.json({
    success: true,
    message: result.changed
      ? `${result.ticket.kotNo} is ${MOVED[status]}`
      : `${result.ticket.kotNo} was already ${MOVED[status]}`,
    data: result.ticket,
  });
};

const recallTicket = async (req, res) => {
  const id = readId(req.params.id, "Ticket id");
  const result = await kitchenService.recallTicket(req.user.restaurantId, id, req.user.id, req.outletId);

  logAction(req, "recall", "kot", { id, label: result.ticket.kotNo });

  res.json({ success: true, message: `${result.ticket.kotNo} is back on the pass`, data: result.ticket });
};

const recallLast = async (req, res) => {
  const result = await kitchenService.recallLast(
    req.user.restaurantId,
    { stationId: readStationFilter(req.body || {}), outletId: req.outletId },
    req.user.id
  );

  logAction(req, "recall", "kot", { id: result.ticket.id, label: result.ticket.kotNo });

  res.json({ success: true, message: `${result.ticket.kotNo} is back on the pass`, data: result.ticket });
};

const setItemDone = async (req, res) => {
  const kotId = readId(req.params.id, "Ticket id");
  const itemId = readId(req.params.itemId, "Item id");

  if (req.body?.done === undefined || req.body?.done === null) {
    throw new AppError(400, "Say whether the dish is done: send done as true or false");
  }

  const done = v.requiredBoolean(req.body.done, "Done");
  const ticket = await kitchenService.setItemDone(
    req.user.restaurantId,
    kotId,
    itemId,
    done,
    req.user.id,
    req.outletId
  );

  res.json({ success: true, data: ticket });
};

// One dish carried out from the pass on its own (the captain app), with the
// same permission as serving a whole ticket.
const serveItem = async (req, res) => {
  const kotId = readId(req.params.id, "Ticket id");
  const itemId = readId(req.params.itemId, "Item id");
  const result = await kitchenService.serveItem(req.user.restaurantId, kotId, itemId, req.user.id, req.outletId);
  const dish = result.ticket.items.find((item) => Number(item.id) === itemId);
  const name = dish ? dish.name : "The dish";

  res.json({
    success: true,
    message: !result.changed
      ? `${name} was already served`
      : result.ticketServed
        ? `${name} is served, and with it the whole of ${result.ticket.kotNo}`
        : `${name} is served`,
    data: result.ticket,
  });
};

// An earlier day's tickets, read only: ?date=YYYY-MM-DD on the restaurant's
// calendar.
const day = async (req, res) => {
  const date = v.requiredString(req.query.date, "Date", 10);

  if (!isCalendarDate(date)) {
    throw new AppError(400, "Date must be a real date like 2026-10-28");
  }

  res.json({ success: true, data: await kitchenService.day(req.user.restaurantId, date, req.outletId) });
};

// Chosen from 1, 2 or 4 hours on the board; anything from an hour to a day
// is accepted. Under an hour a ticket may still be on the stove.
const clearOld = async (req, res) => {
  const body = req.body || {};
  const olderThanMinutes = isBlank(body.olderThanMinutes)
    ? 120
    : readWhole(body.olderThanMinutes, "Older than (minutes)", { min: 60, max: 1440 });
  const stationId = readStationFilter(body);

  const result = await kitchenService.clearOld(
    req.user.restaurantId,
    { olderThanMinutes, stationId, outletId: req.outletId },
    req.user.id
  );

  if (result.cleared > 0) {
    logAction(req, "clear_old", "kot", {
      label: `${result.cleared} ${result.cleared === 1 ? "ticket" : "tickets"}`,
      details: { olderThanMinutes, stationId, cleared: result.cleared },
    });
  }

  const age = olderThanMinutes % 60 === 0 ? `${olderThanMinutes / 60} h` : `${olderThanMinutes} min`;

  res.json({
    success: true,
    message:
      result.cleared === 0
        ? `No open ticket is older than ${age}`
        : `Cleared ${result.cleared} ${result.cleared === 1 ? "ticket" : "tickets"} older than ${age}`,
    data: result,
  });
};

const recordPrint = async (req, res) => {
  const id = readId(req.params.id, "Ticket id");

  res.json({ success: true, data: await kitchenService.recordPrint(req.user.restaurantId, id, req.outletId) });
};

// ---------------------------------------------------------------- change slips

// The till, right after a save or a move: the orders it just changed (at most
// a few: an order, and the one its dishes went to).
const claimSlips = async (req, res) => {
  const body = req.body || {};
  const orderIds = v.requiredArray(body.orderIds, "Orders").map((id) => readId(id, "Order id"));

  if (orderIds.length === 0 || orderIds.length > 10) {
    throw new AppError(400, "Name between one and ten orders whose change slips to print");
  }

  const slips = await kitchenService.claimSlips(req.user.restaurantId, orderIds, req.user.id, req.outletId);

  res.json({ success: true, data: slips });
};

const listSlips = async (req, res) => {
  const orderId = optionalId(req.query.orderId, "Order id");

  res.json({
    success: true,
    data: await kitchenService.listSlips(req.user.restaurantId, { outletId: req.outletId, orderId }),
  });
};

// A print from the list. A second print of the same slip is a reprint, which
// the paper says; it goes in the activity log, like a KOT cancelled after the
// kitchen had it.
const printSlip = async (req, res) => {
  const id = readId(req.params.id, "Change slip id");
  const slip = await kitchenService.printSlip(req.user.restaurantId, id, req.user.id, req.outletId);

  if (slip.printCount > 1) {
    logAction(req, "reprint", "kitchen_change_slip", {
      id: slip.id,
      label: `${slip.kind === "table_changed" ? "Table changed" : "Cancel"} slip, ${slip.orderNumber} (${slip.stationName})`,
      details: { printCount: slip.printCount, kots: slip.kotNos },
    });
  }

  res.json({ success: true, data: slip });
};

// ---------------------------------------------------------------- stations

const stationSetup = async (req, res) => {
  res.json({
    success: true,
    data: await kitchenService.stationSetup(req.user.restaurantId, req.outletId),
  });
};

const createStation = async (req, res) => {
  const station = await kitchenService.createStation(
    req.user.restaurantId,
    readStation(req.body),
    req.user.id
  );

  logAction(req, "create", "kitchen_station", { id: station.id, label: station.name });

  res.status(201).json({ success: true, message: `${station.name} added`, data: station });
};

const updateStation = async (req, res) => {
  const id = readId(req.params.id, "Station id");
  const station = await kitchenService.updateStation(
    req.user.restaurantId,
    id,
    readStation(req.body),
    req.user.id
  );

  logAction(req, "update", "kitchen_station", {
    id,
    label: station.name,
    details: { status: station.status, color: station.color },
  });

  res.json({ success: true, message: `${station.name} saved`, data: station });
};

const makeDefault = async (req, res) => {
  const id = readId(req.params.id, "Station id");
  const station = await kitchenService.makeDefault(req.user.restaurantId, id, req.user.id);

  logAction(req, "set_default", "kitchen_station", { id, label: station.name });

  res.json({
    success: true,
    message: `${station.name} now takes every dish no other station does`,
    data: station,
  });
};

const setCategoryStation = async (req, res) => {
  const categoryId = readId(req.params.categoryId, "Category id");
  const stationId = readStationId(req.body);

  await kitchenService.setCategoryStation(req.user.restaurantId, categoryId, stationId, req.user.id);

  logAction(req, "route", "category", {
    id: categoryId,
    details: { stationId },
  });

  res.json({ success: true, message: "Routing saved" });
};

const setProductStation = async (req, res) => {
  const productId = readId(req.params.productId, "Dish id");
  const stationId = readStationId(req.body);

  const product = await kitchenService.setProductStation(
    req.user.restaurantId,
    productId,
    stationId,
    req.user.id
  );

  logAction(req, "route", "product", {
    id: productId,
    label: product.name,
    details: { stationId },
  });

  res.json({
    success: true,
    message: stationId
      ? `${product.name} will go to its own station`
      : `${product.name} follows its category again`,
  });
};

const searchProducts = async (req, res) => {
  const search = v.optionalString(req.query.search, "Search", 100);

  res.json({ success: true, data: await kitchenService.searchProducts(req.user.restaurantId, search) });
};

const getSettings = async (req, res) => {
  res.json({ success: true, data: await kitchenService.getSettings(req.user.restaurantId) });
};

// What KOTs, the kitchen screen and change slips call a dish.
const NAME_MODES = ["menu", "kitchen", "both"];

// The timers (both marks together, and the pass time) and the kitchen-name
// choice are saved from separate cards; either may be sent alone.
const updateSettings = async (req, res) => {
  const body = req.body || {};
  const timers = body.warnMinutes !== undefined || body.lateMinutes !== undefined;
  const data = {};

  if (timers) {
    data.warnMinutes = v.requiredNumber(body.warnMinutes, "Warning after (minutes)", { min: 1, max: 120 });
    data.lateMinutes = v.requiredNumber(body.lateMinutes, "Late after (minutes)", { min: 2, max: 180 });

    if (!Number.isInteger(data.warnMinutes) || !Number.isInteger(data.lateMinutes)) {
      throw new AppError(400, "Use whole minutes for the kitchen timers");
    }
  }

  // How long plated food may wait at the pass before the bell says so.
  if (body.passMinutes !== undefined && body.passMinutes !== null) {
    data.passMinutes = v.requiredNumber(body.passMinutes, "Waiting at the pass (minutes)", { min: 1, max: 60 });

    if (!Number.isInteger(data.passMinutes)) {
      throw new AppError(400, "Use whole minutes for the time at the pass");
    }
  }

  if (body.kitchenNameMode !== undefined) {
    data.kitchenNameMode = v.requiredEnum(body.kitchenNameMode, "Names on KOTs", NAME_MODES);
  }

  if (!timers && data.passMinutes === undefined && data.kitchenNameMode === undefined) {
    throw new AppError(400, "Nothing to save: send the kitchen timers or which names the KOT prints");
  }

  const settings = await kitchenService.updateSettings(req.user.restaurantId, data, req.user.id);

  logAction(req, "update", "kitchen_settings", { details: data });

  res.json({
    success: true,
    message: timers || data.passMinutes !== undefined ? "Kitchen timers saved" : "Names on KOTs saved",
    data: settings,
  });
};

module.exports = {
  claimSlips,
  listSlips,
  printSlip,
  board,
  pass,
  sync,
  orderTickets,
  getTicket,
  setStatus,
  recallTicket,
  recallLast,
  setItemDone,
  serveItem,
  day,
  clearOld,
  recordPrint,
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
