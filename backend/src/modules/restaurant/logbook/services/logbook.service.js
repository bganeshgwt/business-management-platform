const logbookRepository = require("../repositories/logbook.repository");
const outletRepository = require("../../setup/repositories/outlet.repository");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const timeclockRepository = require("../../staff/repositories/timeclock.repository");
const { localDate, safeZone } = require("../../staff/services/timeclock.service");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const tradingDay = require("../../business-day/services/tradingDay");
const AppError = require("../../../../utils/AppError");

// The shift log book: what one shift hands over to the next.
//
// Each entry says what, which kind (maintenance, guest, stock, staff, other),
// optionally the table and the outlet, and is stamped with who wrote it, when,
// the business day and the shift. "Needs follow-up" keeps it at the top of
// the log (and in the bell) until someone closes it. Reading is tracked per
// person, so a manager coming on shift sees what they have not read yet, and
// every entry shows who has.

const CATEGORIES = ["maintenance", "guest", "stock", "staff", "other"];

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const seenByOf = (user) => ({ userId: user.id, outletId: user.outletId || null });

const toEntry = (row, user) => ({
  id: row.id,
  body: row.body,
  category: row.category,
  outletId: row.outlet_id,
  outletName: row.outlet_name || null,
  tableId: row.table_id,
  tableLabel: row.table_label || null,
  shiftLabel: row.shift_label,
  businessDate: row.business_date,
  needsFollowUp: Boolean(row.needs_follow_up),
  open: Boolean(row.needs_follow_up && !row.closed_at),
  closedAt: row.closed_at,
  closedByName: row.closed_by_name || null,
  closeNote: row.close_note || null,
  createdAt: row.created_at,
  createdByName: row.created_by_name,
  mine: Number(row.created_by) === Number(user.id),
  readByMe: Boolean(row.read_by_me) || Number(row.created_by) === Number(user.id),
  readBy: (row.read_by || []).map((read) => ({ userId: read.userId, name: read.name, readAt: read.readAt })),
});

const timezoneOf = async (restaurantId) => safeZone(await timeclockRepository.findTimezone(restaurantId));

// "17:00" from "17:00:00".
const hm = (time) => String(time || "").slice(0, 5);

const covers = (shift, minuteOfDay) => {
  const [sh, sm] = hm(shift.start_time).split(":").map(Number);
  const [eh, em] = hm(shift.end_time).split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;

  return end > start ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
};

const partOfDay = (hour) =>
  hour < 5 ? "Late night" : hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : hour < 22 ? "Evening" : "Late night";

// The shift an entry is written on: the writer's rostered shift that day,
// else the restaurant's shift running now, else the part of the day.
const shiftLabelFor = async (restaurantId, user, businessDate, now, timezone) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(now)
    .split(":")
    .map(Number);
  const minuteOfDay = parts[0] * 60 + parts[1];
  const rostered = await logbookRepository.findRosterShift(restaurantId, user.id, businessDate);

  if (rostered) {
    return `${rostered.name} (${hm(rostered.start_time)}–${hm(rostered.end_time)})`;
  }

  const running = (await logbookRepository.findActiveShifts(restaurantId)).find((shift) => covers(shift, minuteOfDay));

  if (running) {
    return `${running.name} (${hm(running.start_time)}–${hm(running.end_time)})`;
  }

  return partOfDay(parts[0]);
};

// The log book's "today": the open business day (of the outlet, where there
// is one), else the restaurant's calendar date — or last night's until the
// cut-off hour, when that day was just closed (the closing notes are that
// night's). A kitchen still serving at 00:30 is writing on the day it opened.
const todayOf = async (restaurantId, outletId = null, now = new Date(), timezone = null) => {
  const open = await businessDayRepository.findOpen(restaurantId, outletId || undefined);

  if (open) {
    return String(open.business_date).slice(0, 10);
  }

  const zone = timezone || (await timezoneOf(restaurantId));
  const settings = (await restaurantRepository.findSettings(restaurantId)) || {};

  try {
    return await tradingDay.dateWithNoDayOpenAt(restaurantId, outletId || undefined, { ...settings, timezone: zone }, now);
  } catch {
    return localDate(now, zone);
  }
};

const list = async (restaurantId, user, filters) => {
  requireRestaurantId(restaurantId);

  const rows = await logbookRepository.findEntries(restaurantId, seenByOf(user), filters);

  return {
    items: rows.map((row) => toEntry(row, user)),
    total: rows.length ? Number(rows[0].total) : 0,
    limit: filters.limit,
    offset: filters.offset,
  };
};

const create = async (restaurantId, user, data, switcherOutletId = null) => {
  requireRestaurantId(restaurantId);

  // Someone tied to one outlet writes for that outlet. Anyone else names an
  // outlet (or the one the switcher is on), or none: the whole restaurant.
  let outletId = user.outletId || data.outletId || switcherOutletId || null;

  if (user.outletId && data.outletId && Number(data.outletId) !== Number(user.outletId)) {
    throw new AppError(403, "You are set up to work at one outlet only, so your entries are for that outlet");
  }

  if (outletId && !user.outletId) {
    const outlet = await outletRepository.findById(restaurantId, outletId);

    if (!outlet) {
      throw new AppError(400, "That outlet does not belong to this restaurant");
    }
  }

  let table = null;

  if (data.tableId) {
    table = await logbookRepository.findTable(restaurantId, data.tableId);

    if (!table) {
      throw new AppError(400, "That table does not belong to this restaurant");
    }

    if (user.outletId && table.outlet_id && Number(table.outlet_id) !== Number(user.outletId)) {
      throw new AppError(400, "That table is at another outlet");
    }

    // A table's outlet is where the entry belongs.
    outletId = outletId || table.outlet_id || null;
  }

  const timezone = await timezoneOf(restaurantId);
  const now = new Date();
  const businessDate = await todayOf(restaurantId, outletId, now, timezone);

  const id = await logbookRepository.createEntry(
    restaurantId,
    {
      outletId: outletId ? Number(outletId) : null,
      category: data.category,
      body: data.body,
      tableId: table ? table.id : null,
      tableLabel: table ? String(table.table_no) : null,
      shiftLabel: await shiftLabelFor(restaurantId, user, businessDate, now, timezone),
      businessDate,
      needsFollowUp: Boolean(data.needsFollowUp),
    },
    user.id
  );

  return toEntry(await logbookRepository.findEntryById(restaurantId, seenByOf(user), id), user);
};

const getEntry = async (restaurantId, user, id) => {
  const row = await logbookRepository.findEntryById(restaurantId, seenByOf(user), id);

  if (!row) {
    throw new AppError(404, "Log book entry not found");
  }

  return toEntry(row, user);
};

const close = async (restaurantId, user, id, note) => {
  requireRestaurantId(restaurantId);

  const entry = await getEntry(restaurantId, user, id);

  if (!entry.needsFollowUp) {
    throw new AppError(409, "This entry did not need a follow-up");
  }

  if (!entry.open) {
    throw new AppError(409, `${entry.closedByName || "Someone"} already closed this follow-up`);
  }

  if (!(await logbookRepository.closeEntry(restaurantId, id, note, user.id))) {
    throw new AppError(409, "Someone closed this follow-up just now");
  }

  return getEntry(restaurantId, user, id);
};

const markRead = async (restaurantId, user, ids) => {
  requireRestaurantId(restaurantId);

  const marked = await logbookRepository.markRead(restaurantId, seenByOf(user), ids);
  return { marked };
};

// What a manager coming on shift needs: entries they have not read (from the
// last week, written by others) and the follow-ups still open.
const handover = async (restaurantId, user) => {
  requireRestaurantId(restaurantId);

  const [unread, open, today] = await Promise.all([
    logbookRepository.findUnread(restaurantId, seenByOf(user)),
    logbookRepository.findOpenFollowUps(restaurantId, seenByOf(user)),
    todayOf(restaurantId, user.outletId || null),
  ]);

  return {
    // The day new entries are stamped with (the open business day), which
    // the log opens on; older days are a date filter away.
    today,
    unread: unread.map((row) => toEntry(row, user)),
    openFollowUps: open.map((row) => toEntry(row, user)),
    openCount: open.length ? Number(open[0].total) : 0,
  };
};

module.exports = {
  CATEGORIES,
  list,
  create,
  getEntry,
  close,
  markRead,
  handover,
};
