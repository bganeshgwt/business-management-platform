// Captain sections (sweep SW-A-20): which captain has which floor, section
// or table on a business date. Read by the floor plan and the POS ("My
// tables") and the QR inbox (a table's call goes first to its captain).
const AppError = require("../../../../utils/AppError");
const pool = require("../../../../config/database");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const captainSectionRepository = require("../repositories/captainSection.repository");
const tradingDay = require("../../business-day/services/tradingDay");

// The business date a plan is for when none is named. One plan covers the
// whole floor, so it follows the main counter's open day (a branch whose day
// started on another date still reads tonight's plan), else the outlet's
// own open day, else the calendar date.
const currentDate = async (restaurantId, outletId = null) => {
  const day =
    (await businessDayRepository.findOpen(restaurantId, null)) ||
    (outletId ? await businessDayRepository.findOpen(restaurantId, outletId) : null);

  if (day) {
    return day.business_date;
  }

  // None open: today, or last night's until the cut-off hour when the main
  // counter's day was just closed.
  return tradingDay.dateWithNoDayOpenAt(restaurantId, null, await restaurantRepository.findSettings(restaurantId));
};

const toAssignment = (row) => ({
  id: row.id,
  userId: Number(row.user_id),
  userName: row.user_name,
  kind: row.table_id ? "table" : row.area_id ? "area" : "floor",
  floorId: row.floor_id ? Number(row.floor_id) : null,
  areaId: row.area_id ? Number(row.area_id) : null,
  tableId: row.table_id ? Number(row.table_id) : null,
  label: row.table_id ? `Table ${row.table_no}` : row.area_id ? row.area_name : row.floor_name,
});

const plan = async (restaurantId, date, outletId) => {
  const on = date || (await currentDate(restaurantId, outletId));
  const [rows, captains] = await Promise.all([
    captainSectionRepository.findForDate(restaurantId, on),
    captainSectionRepository.findCaptains(restaurantId),
  ]);

  return {
    date: on,
    assignments: rows.map(toAssignment),
    captains: captains.map((row) => ({ id: Number(row.id), name: row.name, outletId: row.outlet_id || null })),
  };
};

// Every id must be this restaurant's: a floor, section, table or captain of
// another restaurant is refused as if it did not exist.
const checkOwn = async (restaurantId, rows) => {
  const ids = (key) => [...new Set(rows.map((row) => row[key]).filter(Boolean))];
  const count = async (sql, list) =>
    list.length === 0 ? 0 : Number((await pool.query(sql, [restaurantId, list])).rows[0].n);
  const checks = [
    ["userId", "SELECT COUNT(*) AS n FROM users WHERE restaurant_id = $1 AND id = ANY($2::bigint[]) AND status = 'active'", "Captain"],
    ["floorId", "SELECT COUNT(*) AS n FROM floors WHERE restaurant_id = $1 AND id = ANY($2::bigint[])", "Floor"],
    ["areaId", "SELECT COUNT(*) AS n FROM dining_areas WHERE restaurant_id = $1 AND id = ANY($2::bigint[])", "Section"],
    ["tableId", "SELECT COUNT(*) AS n FROM dining_tables WHERE restaurant_id = $1 AND id = ANY($2::bigint[])", "Table"],
  ];

  for (const [key, sql, word] of checks) {
    const list = ids(key);

    if ((await count(sql, list)) !== list.length) {
      throw new AppError(400, `${word} does not exist`);
    }
  }
};

const save = async (restaurantId, date, rows, userId) => {
  const seen = new Set();

  for (const row of rows) {
    const key = row.tableId ? `t${row.tableId}` : row.areaId ? `a${row.areaId}` : `f${row.floorId}`;

    if (seen.has(key)) {
      throw new AppError(400, "A floor, section or table can have one captain at a time. Each is listed once.");
    }

    seen.add(key);
  }

  await checkOwn(restaurantId, rows);
  await captainSectionRepository.replaceForDate(restaurantId, date, rows, userId);

  return plan(restaurantId, date);
};

// Yesterday's plan (or any day's) as this day's: nothing is copied over a
// plan someone already made for the day.
const copy = async (restaurantId, from, to, userId) => {
  if (from === to) {
    throw new AppError(400, "Pick a different day to copy from");
  }

  const [source, target] = await Promise.all([
    captainSectionRepository.findForDate(restaurantId, from),
    captainSectionRepository.findForDate(restaurantId, to),
  ]);

  if (source.length === 0) {
    throw new AppError(404, `No captain plan was made for ${from}, so there is nothing to copy.`);
  }

  if (target.length > 0) {
    throw new AppError(409, `${to} already has a plan. Clear it first, or change it by hand.`);
  }

  await captainSectionRepository.replaceForDate(
    restaurantId,
    to,
    source.map((row) => ({ userId: row.user_id, floorId: row.floor_id, areaId: row.area_id, tableId: row.table_id })),
    userId
  );

  return plan(restaurantId, to);
};

// Each table's captain today ({ tableId → { userId, userName } }).
const captainsToday = async (restaurantId, outletId = null) =>
  captainSectionRepository.captainsByTable(restaurantId, await currentDate(restaurantId, outletId));

module.exports = { currentDate, plan, save, copy, captainsToday };
