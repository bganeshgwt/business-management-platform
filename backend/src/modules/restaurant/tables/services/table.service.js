const crypto = require("crypto");

const tableRepository = require("../repositories/table.repository");
const outletRepository = require("../../setup/repositories/outlet.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const serviceSettingsRepository = require("../../setup/repositories/serviceSettings.repository");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

const DUPLICATE = "23505";
const FOREIGN_KEY = "23503";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// Random, unguessable text placed inside each table's QR code.
const newQrToken = () => crypto.randomBytes(16).toString("hex");

const toFloor = (row) => ({
  id: row.id,
  name: row.name,
  sortOrder: row.sort_order,
  status: row.status,
  areaCount: row.area_count,
  tableCount: row.table_count,
});

const toArea = (row) => ({
  id: row.id,
  floorId: row.floor_id,
  floorName: row.floor_name,
  name: row.name,
  sortOrder: row.sort_order,
  status: row.status,
  tableCount: row.table_count,
});

// A bill with less than a paisa left on it has nothing left to collect.
const PAISA = 0.009;

// Why a table cannot be seated, or null when it can. The table's own switch
// is named first because it is the one a manager is most likely to have
// flipped; a closed floor or area closes every table on it.
const outOfServiceReason = (row) => {
  if (row.status !== "active") {
    return "table";
  }

  if (row.floor_status && row.floor_status !== "active") {
    return "floor";
  }

  if (row.area_status && row.area_status !== "active") {
    return "area";
  }

  return null;
};

const toLive = (row) => {
  if (!row.order_id && row.joined_order_id) {
    // Joined to another table's party: running with them (their order is on
    // `joinedTo`); billed once their order has its bill.
    return {
      orderId: row.joined_order_id,
      orderNumber: row.joined_order_number,
      placedAt: row.joined_placed_at,
      guestCount: row.joined_guest_count,
      orderTotal: Number(row.joined_order_total || 0),
      billId: null,
      billStatus: null,
      billNumber: null,
      billTotal: null,
      billDue: null,
      unbilledQuantity: 0,
      fullyPaid: false,
      joinedTo: row.joined_main_table_no || null,
      billed: row.joined_order_status === "billed",
      earlierDay: row.earlier_day === true,
    };
  }

  if (!row.order_id) {
    return null;
  }

  const billTotal = row.bill_id ? Number(row.bill_total || 0) : null;
  const billDue = row.bill_id ? Math.max(0, round2(billTotal - Number(row.bill_paid || 0))) : null;
  // Dishes on the order that no bill covers yet: a table billed for the
  // starters only is still running, whatever that first bill says.
  const unbilled = Math.max(0, round2(Number(row.unbilled_quantity || 0)));

  return {
    orderId: row.order_id,
    orderNumber: row.order_number,
    placedAt: row.placed_at,
    guestCount: row.guest_count,
    orderTotal: Number(row.order_total || 0),
    billId: row.bill_id || null,
    billStatus: row.bill_status || null,
    billNumber: row.bill_number || null,
    billTotal,
    billDue,
    unbilledQuantity: unbilled,
    // Worked out from the bills' own money rather than a status word: a bill
    // covered entirely by loyalty points has nothing left to collect even
    // while it still says unpaid, and its guests are still at the table.
    // Every live bill must be settled (an order billed in parts), and no dish
    // may be left unbilled.
    fullyPaid:
      Boolean(row.bill_id) &&
      unbilled <= 0 &&
      (row.bills_settled === true || billDue <= PAISA),
    // Taken on an earlier trading day and still open: the floor plan, the
    // POS and the dashboard flag it ("left open since 24 Sep") with Bill and
    // Cancel, instead of counting it as tonight's party.
    earlierDay: row.earlier_day === true,
  };
};

// The last party paid within the cleaning window and nobody has said the
// table is ready since. Only while nobody new has sat down: a new order on
// the table means it was ready enough to seat.
const toTurn = (row) =>
  row.settled_order_id && !row.order_id
    ? {
        orderId: row.settled_order_id,
        orderNumber: row.settled_order_number,
        settledAt: row.settled_at,
        guestCount: row.settled_guests,
        endsAt: row.turn_ends_at,
        minutesLeft: Math.max(0, Number(row.turn_minutes_left || 0)),
      }
    : null;

// What the floor plan should call the table, in the order a host needs it:
// guests at the table first (whatever else is true, somebody is eating), then
// whether it can be used at all, then whether it is being reset, then held.
const floorStateOf = ({ live, inService, turn, booking, tableStatus }) => {
  if (live && live.joinedTo) {
    return live.billed ? "printed" : "running";
  }

  if (live) {
    if (live.fullyPaid) {
      return "paid";
    }

    // Billed for part of the order and still eating the rest: running, not
    // waiting on a printed bill.
    return live.billId && live.unbilledQuantity <= 0 ? "printed" : "running";
  }

  if (!inService) {
    return "out_of_service";
  }

  if (turn) {
    return "cleaning";
  }

  if (booking || tableStatus === "reserved") {
    return "reserved";
  }

  if (tableStatus === "cleaning") {
    return "cleaning";
  }

  return "free";
};

const toTable = (row) => {
  const reason = outOfServiceReason(row);
  const live = toLive(row);
  const turn = toTurn(row);
  // The next party this table is being held for, from the reservations book:
  // due within the hour or running up to half an hour late. Always present
  // on the list (null when nothing is due), like `live`.
  const booking = row.booking_id
    ? {
        id: row.booking_id,
        reference: row.booking_reference,
        guestName: row.booking_guest,
        partySize: row.booking_party,
        date: row.booking_date,
        startTime: row.booking_time,
        status: row.booking_status,
      }
    : null;

  return {
    id: row.id,
    floorId: row.floor_id,
    floorName: row.floor_name,
    areaId: row.area_id,
    areaName: row.area_name,
    outletId: row.outlet_id,
    tableNo: row.table_no,
    capacity: row.capacity,
    qrToken: row.qr_token,
    tableStatus: row.table_status,
    status: row.status,
    // What is happening on the table right now: the running order and its bill.
    live,
    booking,
    // Whether a party may be seated here at all. `status` is only the table's
    // own switch; this also says no when its floor or area is closed.
    inService: reason === null,
    outOfServiceReason: reason,
    turn,
    readyAt: row.ready_at || null,
    floorState: floorStateOf({
      live,
      inService: reason === null,
      turn,
      booking,
      tableStatus: row.table_status,
    }),
  };
};

// One table in exactly the shape the floor plan lists it, so a table that
// was just edited or marked ready drops back into the list unchanged.
const readTable = async (restaurantId, id) => {
  const rows = await tableRepository.findTables(restaurantId, { tableId: id });

  return rows[0] ? toTable(rows[0]) : null;
};

// --- Working in one outlet -----------------------------------------------------
//
// `scope` = { outletId, pinned }: the outlet the person works in (tied to it,
// or the switcher on it) and whether they are tied to it. Empty for the whole
// restaurant ("All outlets"), and for the server's own callers, which set up
// anything as before.
//
// Working in one outlet, the floor plan shows that outlet's tables and the
// tables shared by every outlet, and the setup follows the same line:
//   - another outlet's table is not found, for every change;
//   - only that outlet's own tables are set up (edited, given a new QR code,
//     deleted), and a new table is that outlet's. A table cannot be given to
//     another outlet, or to every outlet, from inside one;
//   - a table shared by every outlet, and a floor or area that also holds
//     tables that are not this outlet's, are set up for the whole restaurant
//     (All outlets), because a change there changes another outlet's floor;
//   - marking a table ready after a party is floor work, done on any table
//     the outlet may seat: its own and the shared ones.
// Before this, a manager tied to one branch could edit, re-assign, re-QR and
// delete another branch's tables, or detach one so it showed in every outlet.
const scopeOf = (scope = {}) => ({
  outletId: scope.outletId ? Number(scope.outletId) : null,
  pinned: Boolean(scope.pinned),
});

const outletName = async (restaurantId, outletId) => {
  const outlet = await outletRepository.findById(restaurantId, outletId);

  return outlet ? outlet.name : "this outlet";
};

// How someone working in one outlet gets a whole-restaurant change made.
const wholeRestaurantWay = (pinned) =>
  pinned
    ? "Ask the owner, or a manager who works across outlets, to change it."
    : "Switch the top bar to All outlets to change it.";

// The table as the person working in `scope` may change it. `sharedAllowed`:
// a table shared by every outlet may be used (marked ready) but not set up.
const requireOwnTable = async (restaurantId, id, scope, { sharedAllowed = false } = {}) => {
  const table = await tableRepository.findTableById(restaurantId, id);

  if (!table) {
    throw new AppError(404, "Table not found");
  }

  const { outletId, pinned } = scopeOf(scope);

  if (!outletId) {
    return table;
  }

  if (table.outlet_id && Number(table.outlet_id) !== outletId) {
    throw new AppError(404, "Table not found in this outlet");
  }

  if (!table.outlet_id && !sharedAllowed) {
    throw new AppError(
      403,
      `Table ${table.table_no} is shared by every outlet, so it is set up for the whole restaurant. ${wholeRestaurantWay(pinned)}`,
      { reason: "table_shared" }
    );
  }

  return table;
};

// The outlet a table being saved belongs to. Working in one outlet it is that
// outlet: a table sent with no outlet is the outlet's own, and one sent for
// another outlet is refused rather than quietly moved. For the whole
// restaurant, an edit that does not name an outlet keeps the table's own
// (`current`), and one that names none makes it shared.
const outletForSave = async (restaurantId, data, scope, current = null) => {
  const { outletId, pinned } = scopeOf(scope);

  if (!outletId) {
    if (data.outletId === undefined) {
      return current ? current.outlet_id || null : null;
    }

    return data.outletId || null;
  }

  if (data.outletId && Number(data.outletId) !== outletId) {
    const here = await outletName(restaurantId, outletId);

    throw new AppError(
      403,
      pinned
        ? `You are set up to work at ${here} only, so you set up the tables of ${here} and of no other outlet. Ask the owner to set up the other outlet's tables.`
        : `You are working in ${here}. To set up another outlet's tables, switch the top bar to that outlet or to All outlets.`,
      { reason: "table_other_outlet" }
    );
  }

  return outletId;
};

// A floor or area may be changed from inside one outlet only when every
// table on it is that outlet's own: closing the Ground floor would otherwise
// close another branch's tables, or the shared ones, with it.
const requireOwnRoom = async (restaurantId, where, label, scope) => {
  const { outletId, pinned } = scopeOf(scope);

  if (!outletId) {
    return;
  }

  const { shared, other } = await tableRepository.countOthersTables(restaurantId, where, outletId);

  if (shared + other === 0) {
    return;
  }

  const parts = [
    other > 0 ? `${other} ${other === 1 ? "table" : "tables"} of other outlets` : null,
    shared > 0 ? `${shared} ${shared === 1 ? "table" : "tables"} shared by every outlet` : null,
  ].filter(Boolean);

  throw new AppError(
    403,
    `${label} also has ${parts.join(" and ")}, so it is changed for the whole restaurant. ${wholeRestaurantWay(pinned)}`,
    { reason: "room_shared" }
  );
};

// --- Floors ---

const listFloors = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await tableRepository.findFloors(restaurantId);
  return rows.map(toFloor);
};

const createFloor = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  try {
    return toFloor(await tableRepository.createFloor(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A floor named "${data.name}" already exists`);
    }

    throw error;
  }
};

const updateFloor = async (restaurantId, id, data, userId, scope = {}) => {
  requireRestaurantId(restaurantId);

  const floor = await tableRepository.findFloorById(restaurantId, id);

  if (!floor) {
    throw new AppError(404, "Floor not found");
  }

  await requireOwnRoom(restaurantId, { floorId: id }, `The ${floor.name} floor`, scope);

  try {
    const row = await tableRepository.updateFloor(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Floor not found");
    }

    return toFloor(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A floor named "${data.name}" already exists`);
    }

    throw error;
  }
};

// A floor is never removed while areas or tables still point at it.
const removeFloor = async (restaurantId, id, scope = {}) => {
  requireRestaurantId(restaurantId);

  const floor = await tableRepository.findFloorById(restaurantId, id);

  if (!floor) {
    throw new AppError(404, "Floor not found");
  }

  await requireOwnRoom(restaurantId, { floorId: id }, `The ${floor.name} floor`, scope);

  const children = await tableRepository.countFloorChildren(id);

  if (children.areas > 0 || children.tables > 0) {
    throw new AppError(
      409,
      `This floor has ${children.areas} area(s) and ${children.tables} table(s). Remove them first.`
    );
  }

  await tableRepository.removeFloor(restaurantId, id);
};

// --- Areas ---

const requireOwnFloor = async (restaurantId, floorId) => {
  const floor = await tableRepository.findFloorById(restaurantId, floorId);

  if (!floor) {
    throw new AppError(400, "Selected floor does not exist");
  }
};

const listAreas = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await tableRepository.findAreas(restaurantId);
  return rows.map(toArea);
};

const createArea = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  await requireOwnFloor(restaurantId, data.floorId);

  try {
    return toArea(await tableRepository.createArea(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `That floor already has an area named "${data.name}"`);
    }

    throw error;
  }
};

const updateArea = async (restaurantId, id, data, userId, scope = {}) => {
  requireRestaurantId(restaurantId);
  await requireOwnFloor(restaurantId, data.floorId);

  const area = await tableRepository.findAreaById(restaurantId, id);

  if (!area) {
    throw new AppError(404, "Area not found");
  }

  await requireOwnRoom(restaurantId, { areaId: id }, `The ${area.name} area`, scope);

  try {
    const row = await tableRepository.updateArea(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Area not found");
    }

    return toArea(row);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `That floor already has an area named "${data.name}"`);
    }

    throw error;
  }
};

const removeArea = async (restaurantId, id, scope = {}) => {
  requireRestaurantId(restaurantId);

  const area = await tableRepository.findAreaById(restaurantId, id);

  if (!area) {
    throw new AppError(404, "Area not found");
  }

  await requireOwnRoom(restaurantId, { areaId: id }, `The ${area.name} area`, scope);

  const tableCount = await tableRepository.countAreaTables(id);

  if (tableCount > 0) {
    throw new AppError(409, `This area has ${tableCount} table(s). Move them first.`);
  }

  await tableRepository.removeArea(restaurantId, id);
};

// --- Tables ---

const validateTableLinks = async (restaurantId, data) => {
  await requireOwnFloor(restaurantId, data.floorId);

  if (data.areaId) {
    const area = await tableRepository.findAreaById(restaurantId, data.areaId);

    if (!area) {
      throw new AppError(400, "Selected area does not exist");
    }

    if (Number(area.floor_id) !== Number(data.floorId)) {
      throw new AppError(400, "That area belongs to a different floor");
    }
  }

  if (data.outletId) {
    const outlet = await outletRepository.findById(restaurantId, data.outletId);

    if (!outlet) {
      throw new AppError(400, "Selected outlet does not exist");
    }
  }
};

const listTables = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  const [rows, captains] = await Promise.all([
    tableRepository.findTables(restaurantId, filters),
    // Today's captain of each table, for "My tables".
    require("./captainSection.service").captainsToday(restaurantId, filters.outletId || null),
  ]);

  return rows.map((row) => ({ ...toTable(row), captain: captains.get(Number(row.id)) || null }));
};

const createTable = async (restaurantId, data, userId, scope = {}) => {
  requireRestaurantId(restaurantId);
  data = { ...data, outletId: await outletForSave(restaurantId, data, scope) };
  await validateTableLinks(restaurantId, data);

  try {
    const row = await tableRepository.createTable(
      restaurantId,
      { ...data, qrToken: newQrToken() },
      userId
    );

    return readTable(restaurantId, row.id);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `Table number "${data.tableNo}" already exists`);
    }

    throw error;
  }
};

const updateTable = async (restaurantId, id, data, userId, scope = {}) => {
  requireRestaurantId(restaurantId);
  const current = await requireOwnTable(restaurantId, id, scope);
  data = { ...data, outletId: await outletForSave(restaurantId, data, scope, current) };
  await validateTableLinks(restaurantId, data);

  try {
    const row = await tableRepository.updateTable(restaurantId, id, data, userId);

    if (!row) {
      throw new AppError(404, "Table not found");
    }

    return readTable(restaurantId, id);
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `Table number "${data.tableNo}" already exists`);
    }

    throw error;
  }
};

const regenerateQr = async (restaurantId, id, userId, scope = {}) => {
  requireRestaurantId(restaurantId);
  await requireOwnTable(restaurantId, id, scope);

  const row = await tableRepository.regenerateQrToken(restaurantId, id, newQrToken(), userId);

  if (!row) {
    throw new AppError(404, "Table not found");
  }

  return readTable(restaurantId, id);
};

// Occupied tables are never deleted: an order may be running on them. Nor
// is a table with any order history: those bills and reports point at it for
// good. Switching it off keeps the history and takes it off the floor.
const removeTable = async (restaurantId, id, scope = {}) => {
  requireRestaurantId(restaurantId);

  const table = await requireOwnTable(restaurantId, id, scope);

  if (table.table_status === "occupied") {
    throw new AppError(409, "This table is occupied right now");
  }

  const switchOff =
    `Table ${table.table_no} has past orders on it, so it cannot be deleted. ` +
    "Edit it and set Status to Inactive instead: it will show as out of service and never be offered for seating.";

  if (await tableRepository.hasOrderHistory(restaurantId, id)) {
    throw new AppError(409, switchOff);
  }

  try {
    await tableRepository.removeTable(restaurantId, id);
  } catch (error) {
    // An order written between the check above and the delete.
    if (error.code === FOREIGN_KEY) {
      throw new AppError(409, switchOff);
    }

    throw error;
  }
};

// --- The turn between parties ---

const SERVICE_WORDS = {
  table: "it is switched off",
  floor: "its floor is closed",
  area: "its area is closed",
};

// "Mark ready": whoever reset the table says so, and it goes back to Free (or
// Reserved, when a booking is due) straight away instead of waiting out the
// cleaning window.
const markReady = async (restaurantId, id, userId, scope = {}) => {
  requireRestaurantId(restaurantId);

  const table = await requireOwnTable(restaurantId, id, scope, { sharedAllowed: true });

  const reason = outOfServiceReason(table);

  if (reason) {
    throw new AppError(
      409,
      `Table ${table.table_no} is out of service (${SERVICE_WORDS[reason]}). ` +
        "Switch it back on before seating anyone there."
    );
  }

  const live = await tableRepository.findLiveOrder(restaurantId, id);

  if (live) {
    throw new AppError(
      409,
      `Table ${table.table_no} still has order ${live.order_number} running. ` +
        "Mark it ready once that bill is settled and the guests have left."
    );
  }

  await tableRepository.markReady(restaurantId, id, userId);

  return readTable(restaurantId, id);
};

// --- Floor settings ---

const toSettings = (row) => ({
  cleaningMinutes: Number(row.cleaning_minutes),
  updatedAt: row.updated_at || null,
});

const getSettings = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  return toSettings(await tableRepository.findSettings(restaurantId));
};

// The cleaning time is one rule for every outlet's floor, so it is changed
// for the whole restaurant, not from inside one outlet.
const updateSettings = async (restaurantId, data, userId, scope = {}) => {
  requireRestaurantId(restaurantId);

  const { outletId, pinned } = scopeOf(scope);

  if (outletId) {
    throw new AppError(
      403,
      `The cleaning time is the same for every outlet's floor, so it is set for the whole restaurant. ${wholeRestaurantWay(pinned)}`,
      { reason: "room_shared" }
    );
  }

  return toSettings(await tableRepository.saveSettings(restaurantId, data, userId));
};

// What a printed table QR code needs: the address guests' phones open (null:
// the guests' site's own), and the restaurant's name and logo for the card.
const qrSettings = async (restaurantId) => {
  const [service, restaurant, settings] = await Promise.all([
    serviceSettingsRepository.find(restaurantId),
    restaurantRepository.findById(restaurantId),
    restaurantRepository.findSettings(restaurantId),
  ]);

  return {
    guestWebAddress: service.guest_web_address || null,
    restaurantName: restaurant ? restaurant.name : null,
    logoPath: settings.receipt_logo_path || null,
  };
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
