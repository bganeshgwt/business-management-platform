const tableService = require("../services/table.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

// An optional id (an area, an outlet) that must still be a whole number when
// given: 1.5 would otherwise reach Postgres and come back as a 500.
const optionalId = (value, field) =>
  value === undefined || value === null || value === "" ? null : v.requiredId(value, field);

// Seats and display positions are counted in whole numbers. A fraction would
// otherwise pass the range check and reach Postgres, which refuses it for an
// integer column with a 500.
const optionalWhole = (value, field, range, fallback) => {
  const number = v.optionalNumber(value, field, range);

  if (number === null || number === undefined) {
    return fallback;
  }

  if (!Number.isInteger(number)) {
    throw new AppError(400, `${field} must be a whole number, like ${fallback || 1}`);
  }

  return number;
};

// The outlet the person is working in, for the setup rules in
// table.service (scopeOf): another outlet's tables are not found, and a
// table or floor that is not only this outlet's is set up for the whole
// restaurant.
const scopeOf = (req) => ({ outletId: req.outletId || null, pinned: Boolean(req.outletPinned) });

// --- Floors ---

const readFloorBody = (body = {}) => ({
  name: v.requiredString(body.name, "Floor name", 100),
  sortOrder: optionalWhole(body.sortOrder, "Sort order", { min: 0, max: 9999 }, 0),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

const listFloors = async (req, res) => {
  res.json({ success: true, data: await tableService.listFloors(req.user.restaurantId) });
};

const createFloor = async (req, res) => {
  const floor = await tableService.createFloor(
    req.user.restaurantId,
    readFloorBody(req.body),
    req.user.id
  );

  logAction(req, "create", "floor", { id: floor.id, label: floor.name });

  res.status(201).json({ success: true, message: "Floor created", data: floor });
};

const updateFloor = async (req, res) => {
  const id = v.requiredId(req.params.id, "Floor id");
  const floor = await tableService.updateFloor(
    req.user.restaurantId,
    id,
    readFloorBody(req.body),
    req.user.id,
    scopeOf(req)
  );

  logAction(req, "update", "floor", { id: floor.id, label: floor.name });

  res.json({ success: true, message: "Floor updated", data: floor });
};

const removeFloor = async (req, res) => {
  const id = v.requiredId(req.params.id, "Floor id");

  await tableService.removeFloor(req.user.restaurantId, id, scopeOf(req));

  logAction(req, "delete", "floor", { id });

  res.json({ success: true, message: "Floor deleted" });
};

// --- Areas ---

const readAreaBody = (body = {}) => ({
  floorId: v.requiredId(body.floorId, "Floor"),
  name: v.requiredString(body.name, "Area name", 100),
  sortOrder: optionalWhole(body.sortOrder, "Sort order", { min: 0, max: 9999 }, 0),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

const listAreas = async (req, res) => {
  res.json({ success: true, data: await tableService.listAreas(req.user.restaurantId) });
};

const createArea = async (req, res) => {
  const area = await tableService.createArea(
    req.user.restaurantId,
    readAreaBody(req.body),
    req.user.id
  );

  logAction(req, "create", "dining_area", { id: area.id, label: area.name });

  res.status(201).json({ success: true, message: "Area created", data: area });
};

const updateArea = async (req, res) => {
  const id = v.requiredId(req.params.id, "Area id");
  const area = await tableService.updateArea(
    req.user.restaurantId,
    id,
    readAreaBody(req.body),
    req.user.id,
    scopeOf(req)
  );

  logAction(req, "update", "dining_area", { id: area.id, label: area.name });

  res.json({ success: true, message: "Area updated", data: area });
};

const removeArea = async (req, res) => {
  const id = v.requiredId(req.params.id, "Area id");

  await tableService.removeArea(req.user.restaurantId, id, scopeOf(req));

  logAction(req, "delete", "dining_area", { id });

  res.json({ success: true, message: "Area deleted" });
};

// --- Tables ---

const readTableBody = (body = {}) => ({
  floorId: v.requiredId(body.floorId, "Floor"),
  areaId: optionalId(body.areaId, "Area"),
  // Left out, an edit keeps the outlet the table already has; sent empty, the
  // table is shared by every outlet. Before, leaving it out quietly detached
  // the table from its outlet, and it then showed on every outlet's floor.
  outletId: Object.prototype.hasOwnProperty.call(body, "outletId") ? optionalId(body.outletId, "Outlet") : undefined,
  tableNo: v.requiredString(body.tableNo, "Table number", 20),
  capacity: optionalWhole(body.capacity, "Capacity", { min: 1, max: 100 }, 4),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

// Staff working in one outlet (tied to it, or with the switcher on it) see
// that outlet's tables and the tables that belong to no outlet; another
// outlet's tables are not theirs to seat or ring up.
const listTables = async (req, res) => {
  const filters = { floorId: optionalId(req.query.floorId, "Floor"), outletId: req.outletId || null };

  res.json({ success: true, data: await tableService.listTables(req.user.restaurantId, filters) });
};

const createTable = async (req, res) => {
  const table = await tableService.createTable(
    req.user.restaurantId,
    readTableBody(req.body),
    req.user.id,
    scopeOf(req)
  );

  logAction(req, "create", "dining_table", { id: table.id, label: table.tableNo });

  res.status(201).json({ success: true, message: "Table created", data: table });
};

const updateTable = async (req, res) => {
  const id = v.requiredId(req.params.id, "Table id");
  const table = await tableService.updateTable(
    req.user.restaurantId,
    id,
    readTableBody(req.body),
    req.user.id,
    scopeOf(req)
  );

  logAction(req, "update", "dining_table", { id: table.id, label: table.tableNo });

  res.json({ success: true, message: "Table updated", data: table });
};

// Used when a printed QR code is lost or must be invalidated.
const regenerateQr = async (req, res) => {
  const id = v.requiredId(req.params.id, "Table id");
  const table = await tableService.regenerateQr(req.user.restaurantId, id, req.user.id, scopeOf(req));

  logAction(req, "regenerate_qr", "dining_table", { id: table.id, label: table.tableNo });

  res.json({ success: true, message: "QR code regenerated", data: table });
};

// The table has been cleared and laid again after the last party.
const markReady = async (req, res) => {
  const id = v.requiredId(req.params.id, "Table id");
  const table = await tableService.markReady(req.user.restaurantId, id, req.user.id, scopeOf(req));

  logAction(req, "mark_ready", "dining_table", { id: table.id, label: table.tableNo });

  res.json({
    success: true,
    message: `Table ${table.tableNo} is ready to seat`,
    data: table,
  });
};

// --- Floor settings ---

const getSettings = async (req, res) => {
  res.json({ success: true, data: await tableService.getSettings(req.user.restaurantId) });
};

const updateSettings = async (req, res) => {
  const body = req.body || {};
  const cleaningMinutes = v.requiredNumber(body.cleaningMinutes, "Cleaning time", { min: 0, max: 120 });

  if (!Number.isInteger(cleaningMinutes)) {
    throw new AppError(400, "Cleaning time must be a whole number of minutes, from 0 to 120");
  }

  const settings = await tableService.updateSettings(
    req.user.restaurantId,
    { cleaningMinutes },
    req.user.id,
    scopeOf(req)
  );

  logAction(req, "update", "floor_settings", {
    label: "Table turnover",
    details: { cleaningMinutes },
  });

  res.json({ success: true, message: "Floor settings saved", data: settings });
};

const removeTable = async (req, res) => {
  const id = v.requiredId(req.params.id, "Table id");

  await tableService.removeTable(req.user.restaurantId, id, scopeOf(req));

  logAction(req, "delete", "dining_table", { id });

  res.json({ success: true, message: "Table deleted" });
};

// The web address QR codes open, and the name and logo printed on the cards.
const qrSettings = async (req, res) => {
  res.json({ success: true, data: await tableService.qrSettings(req.user.restaurantId) });
};

module.exports = {
  qrSettings,
  listFloors,
  createFloor,
  updateFloor,
  removeFloor,
  listAreas,
  createArea,
  updateArea,
  removeArea,
  listTables,
  createTable,
  updateTable,
  regenerateQr,
  removeTable,
  markReady,
  getSettings,
  updateSettings,
};
