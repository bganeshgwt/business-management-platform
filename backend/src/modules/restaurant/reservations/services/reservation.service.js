const crypto = require("crypto");
const pool = require("../../../../config/database");
const reservationRepository = require("../repositories/reservation.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const crmRepository = require("../../crm/repositories/crm.repository");
// Seating opens the table's dine-in order through the order service's
// openTable — an order with nothing on it yet, under every check a till's
// order gets (a usable table on an open floor and section, the outlet's own
// table and business day, a real customer). The POS then fills it like any
// other running order.
const tableRepository = require("../../tables/repositories/table.repository");
const orderService = require("../../orders/services/order.service");
const AppError = require("../../../../utils/AppError");
const ruleSettings = require("../../setup/services/ruleSettings.service");

const DUPLICATE = "23505";
// Order numbers come from a counter row locked until the order commits, so a
// clash should not happen; should a number ever be taken anyway (one typed in
// by an import), the seating simply draws again.
const ORDER_NUMBER_TAKEN = "orders_restaurant_id_order_number_key";
const ORDER_NUMBER_ATTEMPTS = 6;

// A booking typed in at 7:05 for "7:00" is the host catching up, not a
// booking in the past.
const PAST_GRACE_MINUTES = 15;
// Late enough that the table should be chased or given away, and how long
// before closing the last table is seated (kitchens stop seating before they
// stop cooking). Each restaurant sets its own (Settings -> Alerts and
// timings); these are what it starts at.
const LATE_AFTER_MINUTES = ruleSettings.DEFAULTS.reservationLateMinutes;
const LAST_SEATING_BEFORE_CLOSE = ruleSettings.DEFAULTS.reservationLastSeatingMinutes;
const MAX_DAYS_AHEAD = 365;

const SEATABLE = ["booked", "confirmed", "no_show"];

// What the controller hands over when an edit sends back the masked mobile
// it was shown ("XXXXXX4823"): the guest's number is unchanged. Staff who see
// numbers masked can then edit a booking without having to know the number.
const KEEP_MOBILE = Symbol("keep the guest's mobile");

const STATUS_LABELS = {
  requested: "an online request still waiting for an answer",
  declined: "a declined online request",
  booked: "booked",
  confirmed: "confirmed",
  seated: "already seated",
  completed: "completed",
  cancelled: "cancelled",
  no_show: "marked a no-show",
};

const OCCASION_LABELS = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  business: "Business",
  date_night: "Date night",
  other: "Occasion",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// --- Clock and time helpers ------------------------------------------------
//
// Bookings are wall-clock times in the restaurant's own timezone, so "now"
// has to be worked out there too — never from the server's clock, which may
// sit in UTC while the dining room is in Kolkata.

const localClock = (timezone, at = new Date()) => {
  let parts;

  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    return localClock("Asia/Kolkata", at);
  }

  const get = (type) => parts.find((part) => part.type === type).value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));

  return { date, minutes, timezone, stamp: `${date} ${get("hour")}:${get("minute")}:00` };
};

const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
};

// "YYYY-MM-DD HH:MM:00" for a date plus a number of minutes, rolling into the
// next day when a late booking runs past midnight. Done in UTC arithmetic
// purely as a calendar: no timezone is involved.
const stampAt = (date, minutes) => {
  const [year, month, day] = date.split("-").map(Number);
  const iso = new Date(Date.UTC(year, month - 1, day) + minutes * 60000).toISOString();

  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}:00`;
};

const weekdayOf = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

const addDays = (date, days) => stampAt(date, days * 1440).slice(0, 10);

const timeLabel = (minutes) => {
  const within = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(within / 60);
  const mins = within % 60;
  const suffix = hours < 12 ? "am" : "pm";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return `${twelve}:${String(mins).padStart(2, "0")} ${suffix}`;
};

const dateLabel = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return `${WEEKDAYS[weekdayOf(date)].slice(0, 3)} ${day} ${MONTHS[month - 1]} ${year}`;
};

const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const settingsFor = async (restaurantId) => {
  const settings = await restaurantRepository.findSettings(restaurantId);
  return { ...settings, timezone: settings.timezone || "Asia/Kolkata" };
};

// --- Shaping ------------------------------------------------------------------

const toBooking = (row) => ({
  id: row.id,
  reference: row.reference_no,
  customerId: row.customer_id,
  customerName: row.customer_name || null,
  customerPoints: row.customer_points ?? null,
  guestName: row.guest_name,
  guestMobile: row.guest_mobile,
  partySize: row.party_size,
  date: row.reservation_date,
  startTime: row.start_time,
  endTime: row.end_time,
  durationMinutes: row.duration_minutes,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  tableId: row.table_id,
  tableNo: row.table_no || null,
  tableCapacity: row.table_capacity ?? null,
  floorName: row.floor_name || null,
  areaName: row.area_name || null,
  // Why the booking's table cannot take the party now ("table": switched
  // off, "floor" or "area": closed), or null. Set after the booking was
  // taken; the booking keeps the table until the host moves it.
  tableOutOfService: !row.table_id
    ? null
    : row.table_switch && row.table_switch !== "active"
      ? "table"
      : closedReason(row),
  capacityOverride: row.capacity_override,
  capacityOverrideReason: row.capacity_override_reason || null,
  // The other tables a large party holds ({ id, tableNo, capacity }), and
  // every held table with the main one first: the party's order opens on
  // the main table, the others are joined to it.
  extraTables: (row.extra_tables || []).map((table) => ({
    id: Number(table.id),
    tableNo: table.tableNo,
    capacity: Number(table.capacity),
  })),
  tables: row.table_id
    ? [
        { id: row.table_id, tableNo: row.table_no || null, capacity: row.table_capacity ?? null },
        ...(row.extra_tables || []).map((table) => ({
          id: Number(table.id),
          tableNo: table.tableNo,
          capacity: Number(table.capacity),
        })),
      ]
    : [],
  occasion: row.occasion,
  specialRequests: row.special_requests,
  source: row.source,
  internalNotes: row.internal_notes,
  status: row.status,
  cancelReason: row.cancel_reason,
  outletId: row.outlet_id,
  orderId: row.order_id,
  orderNumber: row.order_number || null,
  orderStatus: row.order_status || null,
  orderTotal: row.order_total === null || row.order_total === undefined ? null : Number(row.order_total),
  billTotal: row.bill_total === null || row.bill_total === undefined ? null : Number(row.bill_total),
  confirmedAt: row.confirmed_at,
  seatedAt: row.seated_at,
  completedAt: row.completed_at,
  cancelledAt: row.cancelled_at,
  noShowAt: row.no_show_at,
  declinedAt: row.declined_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdByName: row.created_by_name || null,
});

const toWaitlist = (row) => ({
  id: row.id,
  customerId: row.customer_id,
  customerName: row.customer_name || null,
  guestName: row.guest_name,
  guestMobile: row.guest_mobile,
  partySize: row.party_size,
  quotedMinutes: row.quoted_minutes,
  notes: row.notes,
  status: row.status,
  joinedAt: row.joined_at,
  notifiedAt: row.notified_at,
  resolvedAt: row.resolved_at,
  tableId: row.table_id,
  tableNo: row.table_no || null,
  orderId: row.order_id,
  orderNumber: row.order_number || null,
});

// Why a table cannot take a party at all, or null: the same reasons, in the
// same order, as the floor plan's "out of service".
const closedReason = (row) => {
  if (row.floor_status && row.floor_status !== "active") {
    return "floor";
  }

  if (row.area_status && row.area_status !== "active") {
    return "area";
  }

  return null;
};

const CLOSED_WORDS = {
  floor: "is on a floor that is closed right now",
  area: "is in a section that is closed right now",
};

const toTable = (row) => ({
  id: row.id,
  tableNo: row.table_no,
  capacity: row.capacity,
  tableStatus: row.table_status,
  floorId: row.floor_id,
  floorName: row.floor_name,
  areaId: row.area_id,
  areaName: row.area_name,
  outletId: row.outlet_id || null,
  // Whether a party may be booked or seated here at all: a closed floor or
  // section closes its tables.
  inService: closedReason(row) === null,
  outOfServiceReason: closedReason(row),
  // Still being cleaned after the last party (the floor plan's "Cleaning"),
  // with how long it has left; null when it is ready.
  cleaning: row.cleaning_ends_at
    ? { endsAt: row.cleaning_ends_at, minutesLeft: Number(row.cleaning_minutes_left || 1) }
    : null,
  live: row.order_id
    ? {
        orderId: row.order_id,
        orderNumber: row.order_number,
        placedAt: row.placed_at,
        guestCount: row.guest_count,
        customerName: row.live_customer || null,
      }
    : null,
});

// lastSeating: minutes before closing the last booking may start (the
// restaurant's setting; its settings row carries it).
const toHours = (row, lastSeating = LAST_SEATING_BEFORE_CLOSE) => {
  if (!row) {
    return null;
  }

  if (!row.is_open) {
    return { dayOfWeek: row.day_of_week, isOpen: false, open: null, close: null, lastBooking: null };
  }

  const open = toMinutes(row.open_time);
  let close = toMinutes(row.close_time);

  if (close <= open) {
    close += 1440;
  }

  return {
    dayOfWeek: row.day_of_week,
    isOpen: true,
    open: hhmm(open),
    close: hhmm(close),
    // Minutes from midnight, so a close past midnight still sorts after open.
    openMinutes: open,
    closeMinutes: close,
    lastBooking: hhmm(Math.max(open, close - lastSeating)),
    lastBookingMinutes: Math.max(open, close - lastSeating),
  };
};

// --- Rules ----------------------------------------------------------------------

const refuseStatus = (row, action) => {
  throw new AppError(409, `This booking is ${STATUS_LABELS[row.status]}, so it cannot be ${action}.`);
};

const checkDate = (data, clock) => {
  if (data.date < clock.date || (data.date === clock.date && toMinutes(data.startTime) < clock.minutes - PAST_GRACE_MINUTES)) {
    throw new AppError(
      400,
      `That time has already passed — it is ${timeLabel(clock.minutes)} on ${dateLabel(clock.date)} now. ` +
        "Pick a later time, or add guests who are already here to the waitlist."
    );
  }

  if (data.date > addDays(clock.date, MAX_DAYS_AHEAD)) {
    throw new AppError(400, "Bookings can be taken up to a year ahead. Pick an earlier date.");
  }
};

// Only enforced when the restaurant has set its hours; a place that has not
// told us when it opens has not asked us to police it.
const checkHours = async (restaurantId, date, startTime, settings = null) => {
  const hours = await restaurantRepository.findBusinessHours(restaurantId);
  const lastSeating = ruleSettings.fromRow(settings).reservationLastSeatingMinutes;

  if (hours.length === 0) {
    return;
  }

  const weekday = weekdayOf(date);
  const day = toHours(hours.find((row) => Number(row.day_of_week) === weekday), lastSeating);

  if (!day) {
    return;
  }

  if (!day.isOpen) {
    throw new AppError(400, `The restaurant is closed on ${WEEKDAYS[weekday]}s. Pick another day.`);
  }

  let start = toMinutes(startTime);

  // A late night that closes after midnight: 00:30 belongs to the evening.
  if (day.closeMinutes > 1440 && start < day.openMinutes) {
    start += 1440;
  }

  if (start < day.openMinutes || start > day.lastBookingMinutes) {
    throw new AppError(
      400,
      `On ${WEEKDAYS[weekday]}s the restaurant is open ${timeLabel(day.openMinutes)} – ` +
        `${timeLabel(day.closeMinutes)}, so the last booking is ${timeLabel(day.lastBookingMinutes)}. ` +
        "Pick a time in that window."
    );
  }
};

const checkCapacity = (table, partySize, override) => {
  if (partySize > table.capacity && !override) {
    throw new AppError(
      400,
      `Table ${table.table_no} seats ${table.capacity}, and this party is ${partySize}. ` +
        "Pick a bigger table, or tick \"Over capacity is fine\" if you are adding chairs."
    );
  }
};

// Several tables for one party: their seats together must cover it, unless
// the host says why the party still fits ("two high chairs at the end").
const tablesText = (tables) => tables.map((table) => table.table_no).join(" + ");

const checkCombinedCapacity = (tables, partySize, override, reason) => {
  const seats = tables.reduce((sum, table) => sum + Number(table.capacity), 0);

  if (partySize <= seats) {
    return;
  }

  if (!override) {
    throw new AppError(
      400,
      `Tables ${tablesText(tables)} seat ${seats} together, and this party is ${partySize}. ` +
        "Add another table, or tick \"Over capacity is fine\" and say how they will fit.",
      { reason: "capacity" }
    );
  }

  if (!reason) {
    throw new AppError(
      400,
      `Tables ${tablesText(tables)} seat ${seats} together, and this party is ${partySize}. ` +
        "Say how the party will fit (extra chairs, children on laps…) to keep it over capacity.",
      { reason: "capacity_reason_required" }
    );
  }
};

const clashMessage = (table, clash) =>
  `Table ${table.table_no} is already booked ${timeLabel(toMinutes(clash.start_time))} – ` +
  `${timeLabel(toMinutes(clash.end_time))} for ${clash.guest_name} (${clash.party_size}), ` +
  `booking ${clash.reference_no}. Pick another table or time.`;

const requireCustomer = async (restaurantId, customerId) => {
  if (!customerId) {
    return null;
  }

  const customer = await crmRepository.findCustomerById(restaurantId, customerId);

  if (!customer) {
    throw new AppError(400, "Selected guest is not in the guest book");
  }

  return customer;
};

// A table on a closed floor or in a closed section takes no booking and
// seats nobody: the POS refuses an order there, so the party would stand at
// a table nobody can serve.
const refuseClosed = (table, hint) => {
  const reason = closedReason(table);

  if (reason) {
    throw new AppError(400, `Table ${table.table_no} ${CLOSED_WORDS[reason]}. ${hint}`, {
      reason: "table_closed",
    });
  }
};

// --- Bookings -----------------------------------------------------------------

// Writes a booking inside a transaction that holds the table's row, so the
// clash check and the insert cannot be split by someone else's booking. A new
// booking also queues for its reference number first (always in that order:
// reference, then table, so two writes can never wait on each other).
//
// Nothing inside the transaction asks the pool for a second connection: a
// booking holding its connection while it waited for another was how twelve
// refused bookings at the same moment froze the whole API, sign-in included.
// Whether the table is another outlet's (which reads the outlet's name for
// the refusal) is settled first, before any connection is held.
//
// `keptTableId`: an edit that leaves the booking on the table it already has.
// A table that has gone out of service since (its floor or section closed for
// the evening, or the table switched off) still holds that booking, so a name
// or a phone number can be corrected; only placing a booking on such a table
// is refused. The host sees it flagged and moves it.
//
// `accept`: the edit is staff saying yes to an online request, which turns it
// into a confirmed booking on these tables in the same statement.
const writeBooking = async (
  restaurantId,
  data,
  userId,
  existingId,
  keptTableId = null,
  keptExtraIds = [],
  { accept = false } = {}
) => {
  const keepsTable = Boolean(existingId && data.tableId && Number(keptTableId) === Number(data.tableId));
  // The other tables a large party holds: never the main table again, each
  // once, and only with a main table to join them to.
  const extraIds = [...new Set((data.extraTableIds || []).map(Number))].filter(
    (id) => id !== Number(data.tableId)
  );

  if (extraIds.length > 0 && !data.tableId) {
    throw new AppError(400, "Pick the main table first; the other tables are joined to it when the party sits down.");
  }

  for (const id of data.tableId ? [data.tableId, ...extraIds] : []) {
    const table = await tableRepository.findTableById(restaurantId, id);

    if (table) {
      await orderService.refuseOtherOutletTable(restaurantId, table, data.outletId);
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (!existingId) {
      await reservationRepository.lockReferences(client, restaurantId);
    }

    let lockedTable = null;

    if (data.tableId) {
      const table = await reservationRepository.lockTable(client, restaurantId, data.tableId);
      lockedTable = table;

      if (!table) {
        throw new AppError(400, "Selected table does not exist");
      }

      if (!keepsTable) {
        if (table.status !== "active") {
          throw new AppError(400, `Table ${table.table_no} is not in use`);
        }

        refuseClosed(table, "Pick another table, or leave the table blank and give them one on the day.");
      }

      const startMinutes = toMinutes(data.startTime);
      const window = {
        startsAt: stampAt(data.date, startMinutes),
        endsAt: stampAt(data.date, startMinutes + data.durationMinutes),
        excludeId: existingId,
      };

      if (extraIds.length === 0) {
        checkCapacity(table, data.partySize, data.overrideCapacity);
      }

      const clash = await reservationRepository.findClash(client, restaurantId, { tableId: data.tableId, ...window });

      if (clash) {
        throw new AppError(409, clashMessage(table, clash));
      }

      // Every other table the party holds: in use, open, and free for the
      // whole booking — none of them can be booked twice either.
      if (extraIds.length > 0) {
        const others = await reservationRepository.lockTables(client, restaurantId, extraIds);

        for (const id of extraIds) {
          const other = others.find((row) => Number(row.id) === id);

          if (!other) {
            throw new AppError(400, "One of the tables picked does not exist. Refresh the tables and pick again.");
          }

          if (!keptExtraIds.map(Number).includes(id)) {
            if (other.status !== "active") {
              throw new AppError(400, `Table ${other.table_no} is not in use`);
            }

            refuseClosed(other, "Pick another table for the party.");
          }

          const otherClash = await reservationRepository.findClash(client, restaurantId, { tableId: id, ...window });

          if (otherClash) {
            throw new AppError(409, clashMessage(other, otherClash));
          }
        }

        checkCombinedCapacity(
          [table, ...extraIds.map((id) => others.find((row) => Number(row.id) === id))],
          data.partySize,
          data.overrideCapacity,
          data.capacityOverrideReason
        );
      }
    }

    let id = existingId;

    if (existingId) {
      const updated = await reservationRepository.update(client, restaurantId, existingId, data, userId, { accept });

      if (!updated) {
        throw new AppError(
          409,
          accept
            ? "Someone else has just answered this request. Refresh to see what they decided."
            : "This booking was changed by someone else. Refresh and try again."
        );
      }
    } else {
      // A booking taken with "All outlets" for an outlet's table is that
      // outlet's booking.
      id = await reservationRepository.insert(
        client,
        restaurantId,
        { ...data, outletId: data.outletId || (lockedTable && lockedTable.outlet_id) || null },
        userId
      );
    }

    // The booking holds exactly these other tables from now on: a table
    // taken off the booking is free again at once.
    await reservationRepository.setExtraTables(client, restaurantId, id, data.tableId ? extraIds : [], userId);

    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === DUPLICATE) {
      const clash = new AppError(409, "Two bookings were saved at the same moment. Please save again.");
      clash.duplicate = true;
      throw clash;
    }

    throw error;
  } finally {
    client.release();
  }
};

// `outletId`, here and below, is the outlet the host stand is working in (null
// for the whole restaurant): another outlet's booking is not found.
const getById = async (restaurantId, id, outletId = null) => {
  requireRestaurantId(restaurantId);

  const row = await reservationRepository.findById(restaurantId, id, outletId);

  if (!row) {
    throw new AppError(404, "Booking not found");
  }

  return toBooking(row);
};

// The booking with who touched it and how this guest has treated the book.
const getDetail = async (restaurantId, id, outletId = null) => {
  const booking = await getById(restaurantId, id, outletId);
  const [history, record] = await Promise.all([
    reservationRepository.findHistory(restaurantId, id),
    booking.guestMobile
      ? reservationRepository.findGuestRecord(restaurantId, booking.guestMobile.replace(/\D/g, ""), id)
      : null,
  ]);

  return {
    ...booking,
    history: history.map((row) => ({
      id: row.id,
      action: row.action,
      userName: row.user_name,
      details: row.details,
      at: row.created_at,
    })),
    guestRecord: record
      ? {
          bookings: record.bookings,
          completed: record.completed,
          noShows: record.no_shows,
          cancelled: record.cancelled,
          lastVisit: record.last_visit,
        }
      : null,
  };
};

const list = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);
  await reservationRepository.completeSettled(restaurantId);

  // "Upcoming" is judged on the restaurant's calendar, not the server's.
  const settings = await settingsFor(restaurantId);
  const { rows, total } = await reservationRepository.findAll(restaurantId, {
    ...filters,
    today: localClock(settings.timezone).date,
  });

  return { items: rows.map(toBooking), total, limit: filters.limit || 50 };
};

const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  if (data.guestMobile === KEEP_MOBILE) {
    throw new AppError(400, "Type the guest's whole mobile number");
  }

  const settings = await settingsFor(restaurantId);
  const clock = localClock(settings.timezone);

  checkDate(data, clock);
  await checkHours(restaurantId, data.date, data.startTime, settings);
  await requireCustomer(restaurantId, data.customerId);

  // References are drawn one booking at a time (lockReferences), so the
  // unique index should never refuse one; if it does, the save tries again.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const id = await writeBooking(restaurantId, data, userId, null);
      return getById(restaurantId, id);
    } catch (error) {
      if (!(error instanceof AppError && error.statusCode === 409 && error.duplicate) || attempt >= 3) {
        throw error;
      }
    }
  }
};

const FIELD_LABELS = {
  guestName: "name",
  guestMobile: "mobile",
  partySize: "party size",
  date: "date",
  startTime: "time",
  durationMinutes: "duration",
  tableId: "table",
  occasion: "occasion",
  specialRequests: "special requests",
  source: "source",
  internalNotes: "internal notes",
  customerId: "linked guest",
};

// Returns what changed as well, so the audit trail can say "moved from 7:30
// to 8:00" rather than only "edited".
const update = async (restaurantId, id, data, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const existing = await getById(restaurantId, id, outletId);

  // The screen sent back the masked number it was shown: the guest's number
  // has not changed.
  if (data.guestMobile === KEEP_MOBILE) {
    data = { ...data, guestMobile: existing.guestMobile };
  }

  data = { ...data, outletId: outletId || existing.outletId };

  if (!["requested", "booked", "confirmed"].includes(existing.status)) {
    refuseStatus(existing, "changed");
  }

  // A request holds no table until someone says yes to it (Accept, where the
  // table is picked): a table on an unanswered request would be held from
  // nobody, since clash checks look at live bookings only.
  if (existing.status === "requested" && (data.tableId || (data.extraTableIds || []).length > 0)) {
    throw new AppError(
      400,
      "This is an online request still waiting for an answer. Accept it to give it a table — a request holds no table until you say yes."
    );
  }

  const settings = await settingsFor(restaurantId);
  const clock = localClock(settings.timezone);
  const moved = existing.date !== data.date || existing.startTime !== data.startTime;

  // An evening booking edited at 8 pm to fix a spelling is not "in the past".
  if (moved) {
    checkDate(data, clock);
    await checkHours(restaurantId, data.date, data.startTime, settings);
  }

  if (data.customerId !== existing.customerId) {
    await requireCustomer(restaurantId, data.customerId);
  }

  // An edit that does not say which other tables the party holds keeps the
  // ones it has (a screen from before large-party bookings, say).
  if (data.extraTableIds === undefined) {
    data = { ...data, extraTableIds: existing.extraTables.map((table) => table.id) };
  }

  await writeBooking(
    restaurantId,
    data,
    userId,
    id,
    existing.tableId,
    existing.extraTables.map((table) => table.id)
  );

  const booking = await getById(restaurantId, id, outletId);
  const changes = {};
  const heldText = (one) => one.tables.map((table) => table.tableNo).join(" + ") || null;

  if (heldText(existing) !== heldText(booking) && existing.tableNo === booking.tableNo) {
    changes.tables = { from: heldText(existing), to: heldText(booking) };
  }

  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const before = field === "tableId" ? existing.tableNo : existing[field];
    const after = field === "tableId" ? booking.tableNo : booking[field];

    if ((before ?? null) !== (after ?? null)) {
      changes[label] = { from: before ?? null, to: after ?? null };
    }
  }

  return { booking, changes };
};

const confirm = async (restaurantId, id, userId, outletId = null) => {
  const existing = await getById(restaurantId, id, outletId);

  if (existing.status !== "booked") {
    refuseStatus(existing, "confirmed");
  }

  const moved = await reservationRepository.transition(restaurantId, id, {
    from: ["booked"],
    to: "confirmed",
    stamp: "confirmed_at",
    userId,
  });

  if (!moved) {
    throw new AppError(409, "This booking was changed by someone else. Refresh and try again.");
  }

  return getById(restaurantId, id);
};

const cancel = async (restaurantId, id, reason, userId, outletId = null) => {
  const existing = await getById(restaurantId, id, outletId);

  if (!["booked", "confirmed"].includes(existing.status)) {
    refuseStatus(existing, "cancelled");
  }

  const moved = await reservationRepository.transition(restaurantId, id, {
    from: ["booked", "confirmed"],
    to: "cancelled",
    stamp: "cancelled_at",
    cancelReason: reason,
    userId,
  });

  if (!moved) {
    throw new AppError(409, "This booking was changed by someone else. Refresh and try again.");
  }

  return getById(restaurantId, id);
};

// --- Online requests (SW-A-21) ---------------------------------------------
//
// A guest's online booking arrives as a request. Saying yes makes it a
// confirmed booking — on a table if the host picks one now, or with no table
// yet, like a phone booking the host will place later. Saying no needs a
// reason, because the guest reads it on their link.

const accept = async (restaurantId, id, options, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const existing = await getById(restaurantId, id, outletId);

  if (existing.status !== "requested") {
    refuseStatus(existing, "accepted");
  }

  const settings = await settingsFor(restaurantId);
  const clock = localClock(settings.timezone);

  if (
    existing.date < clock.date ||
    (existing.date === clock.date && toMinutes(existing.startTime) < clock.minutes - PAST_GRACE_MINUTES)
  ) {
    throw new AppError(
      409,
      `This request was for ${timeLabel(toMinutes(existing.startTime))} on ${dateLabel(existing.date)}, which has passed. ` +
        "Decline it so the guest is told."
    );
  }

  const extraTableIds = options.extraTableIds || [];

  if (!options.tableId) {
    if (extraTableIds.length > 0) {
      throw new AppError(400, "Pick the main table first; the other tables are joined to it when the party sits down.");
    }

    const moved = await reservationRepository.transition(restaurantId, id, {
      from: ["requested"],
      to: "confirmed",
      stamp: "confirmed_at",
      userId,
    });

    if (!moved) {
      throw new AppError(409, "Someone else has just answered this request. Refresh to see what they decided.");
    }

    return getById(restaurantId, id);
  }

  // Accepting on a table goes through the same checks as any booking on it:
  // in use, open, free for the whole slot, and big enough (or agreed not to be).
  await writeBooking(
    restaurantId,
    {
      guestName: existing.guestName,
      guestMobile: existing.guestMobile,
      customerId: existing.customerId,
      partySize: existing.partySize,
      date: existing.date,
      startTime: existing.startTime,
      durationMinutes: existing.durationMinutes,
      tableId: options.tableId,
      extraTableIds,
      overrideCapacity: Boolean(options.overrideCapacity),
      capacityOverrideReason: options.capacityOverrideReason || null,
      occasion: existing.occasion,
      specialRequests: existing.specialRequests,
      source: existing.source,
      internalNotes: existing.internalNotes,
      outletId: existing.outletId || outletId,
    },
    userId,
    id,
    null,
    [],
    { accept: true }
  );

  return getById(restaurantId, id);
};

const decline = async (restaurantId, id, reason, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const existing = await getById(restaurantId, id, outletId);

  if (existing.status !== "requested") {
    refuseStatus(existing, "declined");
  }

  const moved = await reservationRepository.transition(restaurantId, id, {
    from: ["requested"],
    to: "declined",
    stamp: "declined_at",
    cancelReason: reason,
    userId,
  });

  if (!moved) {
    throw new AppError(409, "Someone else has just answered this request. Refresh to see what they decided.");
  }

  return getById(restaurantId, id);
};

// --- The booking link --------------------------------------------------------

// 128 random bits, as hex: the same strength as a table's QR token. Nobody
// can find a restaurant's link by trying links.
const newLinkToken = () => crypto.randomBytes(16).toString("hex");

const toOnlineSettings = (row, room, hours) => ({
  outletId: row.outlet_id,
  // Null for the main counter (the restaurant's own floor).
  placeName: row.outlet_name || null,
  token: row.token,
  path: `/book/${row.token}`,
  // The public address guests' pages live at (Service settings), shared with
  // the table QR codes; empty means "the guest site's own address".
  guestWebAddress: row.guest_web_address || null,
  isEnabled: row.is_enabled,
  maxPartySize: row.max_party_size,
  seatSharePercent: row.seat_share_percent,
  minNoticeMinutes: row.min_notice_minutes,
  daysAhead: row.days_ahead,
  durationMinutes: row.duration_minutes,
  maxOpenPerMobile: row.max_open_per_mobile,
  blockedDates: row.blocked_dates || [],
  guestNote: row.guest_note || null,
  updatedAt: row.updated_at,
  room: {
    tables: room.tables,
    seats: room.seats,
    largest: room.largest,
    // Seats online guests may fill at any one time.
    onlineSeats: Math.floor((room.seats * row.seat_share_percent) / 100),
  },
  hoursSet: hours.some((day) => day.is_open),
});

const getOnlineSettings = async (restaurantId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const row = await reservationRepository.findOnlineSettings(restaurantId, outletId, newLinkToken());
  const [room, hours] = await Promise.all([
    reservationRepository.seatsInPlace(restaurantId, outletId),
    restaurantRepository.findBusinessHours(restaurantId),
  ]);

  return toOnlineSettings(row, room, hours);
};

const ONLINE_FIELDS = {
  isEnabled: "online booking",
  maxPartySize: "largest party",
  seatSharePercent: "share of seats",
  minNoticeMinutes: "notice",
  daysAhead: "days ahead",
  durationMinutes: "table time",
  maxOpenPerMobile: "bookings per mobile",
  guestNote: "note for guests",
};

const updateOnlineSettings = async (restaurantId, outletId, data, userId) => {
  const before = await getOnlineSettings(restaurantId, outletId);

  // A link switched on must have something to offer: times come from the
  // opening hours, capacity from the tables.
  if (data.isEnabled) {
    if (!before.hoursSet) {
      throw new AppError(
        400,
        "Set your opening hours first (Settings → Business hours). Guests are offered times inside them."
      );
    }

    if (before.room.tables === 0) {
      throw new AppError(
        400,
        `${before.placeName || "The main counter"} has no tables in use on an open floor. ` +
          "Add tables (Tables) before taking bookings online."
      );
    }
  }

  await reservationRepository.updateOnlineSettings(restaurantId, outletId, data, userId);

  const after = await getOnlineSettings(restaurantId, outletId);
  const changes = {};

  for (const [field, label] of Object.entries(ONLINE_FIELDS)) {
    if ((before[field] ?? null) !== (after[field] ?? null)) {
      changes[label] = { from: before[field] ?? null, to: after[field] ?? null };
    }
  }

  if (before.blockedDates.join(",") !== after.blockedDates.join(",")) {
    changes["closed to online bookings"] = {
      from: before.blockedDates.join(", ") || null,
      to: after.blockedDates.join(", ") || null,
    };
  }

  return { settings: after, changes };
};

// A new link: every copy of the old one stops working at once (shared in the
// wrong group, printed on a card with a typo). Bookings already made keep
// their own status links.
const replaceOnlineLink = async (restaurantId, outletId, userId) => {
  await getOnlineSettings(restaurantId, outletId);
  await reservationRepository.replaceOnlineToken(restaurantId, outletId, newLinkToken(), userId);

  return getOnlineSettings(restaurantId, outletId);
};

const pendingRequests = async (restaurantId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const settings = await settingsFor(restaurantId);
  await reservationRepository.expireRequests(restaurantId, localClock(settings.timezone).stamp);

  const rows = await reservationRepository.findPendingRequests(restaurantId, outletId);
  return { items: rows.map(toBooking), total: rows.length };
};

// Nobody is a no-show before their time. Marking one early would give the
// table away while the guest is still on their way.
const markNoShow = async (restaurantId, id, userId, outletId = null) => {
  const existing = await getById(restaurantId, id, outletId);

  if (!["booked", "confirmed"].includes(existing.status)) {
    refuseStatus(existing, "marked a no-show");
  }

  const settings = await settingsFor(restaurantId);
  const clock = localClock(settings.timezone);

  if (existing.date > clock.date || (existing.date === clock.date && toMinutes(existing.startTime) > clock.minutes)) {
    throw new AppError(
      409,
      `It is not ${timeLabel(toMinutes(existing.startTime))} on ${dateLabel(existing.date)} yet. ` +
        "A guest can only be a no-show once their booking time has passed."
    );
  }

  const moved = await reservationRepository.transition(restaurantId, id, {
    from: ["booked", "confirmed"],
    to: "no_show",
    stamp: "no_show_at",
    userId,
  });

  if (!moved) {
    throw new AppError(409, "This booking was changed by someone else. Refresh and try again.");
  }

  return getById(restaurantId, id);
};

// The bill settles the booking by itself; this is for the table that left
// without one — the order was cancelled, or the party moved to the bar.
const complete = async (restaurantId, id, userId, outletId = null) => {
  const existing = await getById(restaurantId, id, outletId);

  if (existing.status !== "seated") {
    refuseStatus(existing, "completed");
  }

  if (existing.orderId && ["open", "billed"].includes(existing.orderStatus)) {
    throw new AppError(
      409,
      `Order ${existing.orderNumber} on table ${existing.tableNo} is still open. ` +
        "Settle its bill and the booking completes by itself."
    );
  }

  const moved = await reservationRepository.transition(restaurantId, id, {
    from: ["seated"],
    to: "completed",
    stamp: "completed_at",
    userId,
  });

  if (!moved) {
    throw new AppError(409, "This booking was changed by someone else. Refresh and try again.");
  }

  return getById(restaurantId, id);
};

// --- Seating (bookings and walk-ins take the same path) ----------------------
//
// Seating has to be safe against two hosts pressing Seat on the same table at
// the same moment. Everything that decides "can this party sit here now" is
// read inside one short transaction holding the table's row lock; the same
// transaction claims the booking or walk-in and marks the table occupied.
// The order is opened only after that commits. A second host arriving a few
// milliseconds later waits on the lock, then finds the table occupied and is
// told so — they never both open an order on it.
//
// The lock is released before the order is written because the order
// repository opens its own transaction and marks the same table occupied,
// which would otherwise queue behind us.

// Everything about the table that can be settled before anything is
// claimed: it exists, is in service (its floor and section open), belongs to
// the outlet the host is working in, and that outlet's business day is open.
// Returns the outlet the party's order will go on.
const checkSeatingTable = async (restaurantId, tableId, outletId) => {
  const table = await tableRepository.findTableById(restaurantId, tableId);

  if (!table) {
    throw new AppError(400, "Selected table does not exist");
  }

  if (table.status !== "active") {
    throw new AppError(400, `Table ${table.table_no} is not in use`);
  }

  refuseClosed(table, "Seat the party at another table.");
  await orderService.refuseOtherOutletTable(restaurantId, table, outletId);

  const orderOutletId = outletId || table.outlet_id || null;

  if (!(await businessDayRepository.findOpen(restaurantId, orderOutletId))) {
    throw new AppError(409, "No business day is open. Open the day before seating guests.");
  }

  return orderOutletId;
};

// The booking or walk-in was seated (or cancelled) by someone else while this
// host waited on its row. Thrown inside the seating transaction, and put into
// words only once that transaction has given its connection back: reading
// the booking from the pool while still holding the table's connection is
// the hold-and-wait that let twelve Seat presses for one party freeze the
// whole API, sign-in included.
class ClaimLost extends Error {}

// Checks the table under its lock, runs `claim` on the same client (it must
// throw ClaimLost if the booking or walk-in is no longer free to seat, and
// must read nothing through the pool), and takes the table. Returns the table
// as it was before, so a failed order can give it back exactly as it was.
const claimTable = async (restaurantId, options, clock, claim) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const table = await reservationRepository.lockTable(client, restaurantId, options.tableId);

    if (!table) {
      throw new AppError(400, "Selected table does not exist");
    }

    if (table.status !== "active") {
      throw new AppError(400, `Table ${table.table_no} is not in use`);
    }

    refuseClosed(table, "Seat the party at another table.");

    const running = await reservationRepository.findOpenOrderOnTable(restaurantId, table.id, client);

    if (running) {
      throw new AppError(
        409,
        `Table ${table.table_no} already has an open order (${running.order_number}). ` +
          "Settle it or pick another table."
      );
    }

    if (table.table_status === "occupied") {
      throw new AppError(
        409,
        `Table ${table.table_no} has just been taken by another party. Pick another table.`
      );
    }

    // The last party has paid but the table has not been cleared and laid
    // again: the floor plan shows it as Cleaning, and so must the host stand.
    const turn = await reservationRepository.findCleaningTurn(client, restaurantId, table.id);

    if (turn || table.table_status === "cleaning") {
      throw new AppError(
        409,
        `Table ${table.table_no} is still being cleaned after the last party` +
          (turn ? ` (about ${turn.minutes_left} min left)` : "") +
          ". Mark it ready on the floor plan once it is laid, then seat them — or pick another table.",
        { reason: "table_cleaning", minutesLeft: turn ? turn.minutes_left : null }
      );
    }

    const extraIds = options.extraTableIds || [];

    if (extraIds.length === 0) {
      checkCapacity(table, options.partySize, options.overrideCapacity);
    }

    // A large party's other tables, under the same lock: each must be free
    // to sit at now, exactly like the main one.
    const others = extraIds.length > 0 ? await reservationRepository.lockTables(client, restaurantId, extraIds) : [];

    for (const id of extraIds) {
      const other = others.find((row) => Number(row.id) === Number(id));

      if (!other || other.status !== "active") {
        throw new AppError(409, `A table held for this party is no longer in use. Edit the booking's tables, then seat them.`);
      }

      refuseClosed(other, "Edit the booking's tables, then seat them.");

      const busy = await reservationRepository.findOpenOrderOnTable(restaurantId, other.id, client);

      if (busy || other.table_status === "occupied") {
        throw new AppError(
          409,
          `Table ${other.table_no}, held for this party, still has ${busy ? busy.order_number : "guests"} on it. ` +
            "Seat them once it is free, or take that table off the booking.",
          { reason: "held_table_busy", tableNo: other.table_no }
        );
      }

      const otherClash = await reservationRepository.findClash(client, restaurantId, {
        tableId: other.id,
        startsAt: stampAt(clock.date, clock.minutes),
        endsAt: stampAt(clock.date, clock.minutes + options.durationMinutes),
        excludeId: options.excludeReservationId,
      });

      if (otherClash && !options.overrideClash) {
        throw new AppError(
          409,
          `Table ${other.table_no} is booked for ${otherClash.guest_name} (${otherClash.party_size}) at ` +
            `${timeLabel(toMinutes(otherClash.start_time))}. Seat them anyway if they will be finished by then.`
        );
      }
    }

    if (extraIds.length > 0) {
      checkCombinedCapacity([table, ...others], options.partySize, true, "kept from the booking");
    }

    const clash = await reservationRepository.findClash(client, restaurantId, {
      tableId: table.id,
      startsAt: stampAt(clock.date, clock.minutes),
      endsAt: stampAt(clock.date, clock.minutes + options.durationMinutes),
      excludeId: options.excludeReservationId,
    });

    if (clash && !options.overrideClash) {
      throw new AppError(
        409,
        `Table ${table.table_no} is booked for ${clash.guest_name} (${clash.party_size}) at ` +
          `${timeLabel(toMinutes(clash.start_time))}. Seat them elsewhere, or seat anyway if ` +
          "they will be finished by then."
      );
    }

    await claim(client);
    await reservationRepository.occupyTable(client, restaurantId, table.id);
    await client.query("COMMIT");

    return table;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An empty dine-in order on the table: the table turns Running on the floor
// plan, shows in the POS, and the waiter adds dishes to it from there. Opened
// by the order service, exactly as a till opens a table: the table, floor and
// section are checked again, and the order goes on its outlet's own business
// day with its outlet's settings.
const openTableOrder = async (restaurantId, outletId, table, party, userId) => {
  const input = {
    outletId,
    source: "pos",
    tableId: table.id,
    customerId: party.customerId || null,
    customerName: party.guestName,
    customerMobile: party.guestMobile || null,
    guestCount: party.partySize,
    notes: party.notes ? party.notes.slice(0, 500) : null,
  };

  for (let attempt = 1; ; attempt += 1) {
    try {
      const opened = await orderService.openTable(restaurantId, input, userId);
      return await orderService.getById(restaurantId, opened.id);
    } catch (error) {
      if (!(error.code === DUPLICATE && error.constraint === ORDER_NUMBER_TAKEN)) {
        throw error;
      }

      if (attempt >= ORDER_NUMBER_ATTEMPTS) {
        throw new AppError(
          409,
          "Several orders were opened at the same moment, so this one could not get a number. " +
            "Press Seat again."
        );
      }

      // Spread the retries out so orders that collided do not collide again.
      await pause(20 * attempt + Math.floor(Math.random() * 30));
    }
  }
};

const bookingNotes = (booking) =>
  [
    `Booking ${booking.reference}`,
    booking.occasion ? OCCASION_LABELS[booking.occasion] : null,
    booking.specialRequests,
  ]
    .filter(Boolean)
    .join(" · ");

const seat = async (restaurantId, id, options, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const existing = await getById(restaurantId, id, outletId);

  if (!SEATABLE.includes(existing.status)) {
    refuseStatus(existing, "seated");
  }

  const settings = await settingsFor(restaurantId);
  const clock = localClock(settings.timezone);

  if (existing.date !== clock.date) {
    throw new AppError(
      409,
      `This booking is for ${dateLabel(existing.date)}. Only today's bookings can be seated — ` +
        "change its date first if the guests are here now."
    );
  }

  const tableId = options.tableId || existing.tableId;

  if (!tableId) {
    throw new AppError(400, "Choose a table to seat this party");
  }

  // A large party on the tables it booked sits at all of them: the order
  // opens on the main table and the others are joined to it. Seated at
  // another table instead, the party gives the others back.
  const onBookedTables = Number(tableId) === Number(existing.tableId);
  const extraIds = onBookedTables ? existing.extraTables.map((table) => table.id) : [];

  const orderOutletId = await checkSeatingTable(restaurantId, tableId, existing.outletId || outletId);

  let table;

  try {
    table = await claimTable(
      restaurantId,
      {
        tableId,
        partySize: existing.partySize,
        durationMinutes: existing.durationMinutes,
        // An override already agreed for this table when it was booked stands.
        overrideCapacity:
          options.overrideCapacity || (existing.capacityOverride && tableId === existing.tableId),
        overrideClash: options.overrideClash,
        excludeReservationId: id,
        extraTableIds: extraIds,
      },
      clock,
      async (client) => {
        const claimed = await reservationRepository.claimSeat(
          restaurantId,
          id,
          { from: SEATABLE, tableId, overrideCapacity: Boolean(options.overrideCapacity), userId },
          client
        );

        if (!claimed) {
          throw new ClaimLost();
        }

        if (!onBookedTables && existing.extraTables.length > 0) {
          await reservationRepository.setExtraTables(client, restaurantId, id, [], userId);
        }
      }
    );
  } catch (error) {
    if (error instanceof ClaimLost) {
      const now = await getById(restaurantId, id);

      if (!SEATABLE.includes(now.status)) {
        refuseStatus(now, "seated");
      }

      throw new AppError(409, "This booking was changed by someone else. Refresh and try again.");
    }

    throw error;
  }

  let order;

  try {
    order = await openTableOrder(
      restaurantId,
      orderOutletId,
      table,
      { ...existing, notes: bookingNotes(existing) },
      userId
    );
  } catch (error) {
    await reservationRepository.releaseSeat(restaurantId, id, {
      status: existing.status,
      table_id: existing.tableId,
      capacity_override: existing.capacityOverride,
    });
    await reservationRepository.releaseTable(restaurantId, table.id, table.table_status);
    throw error;
  }

  await reservationRepository.attachOrder(restaurantId, id, order.id);

  // The other tables, joined to the party's order one by one (the same join
  // a captain does on the floor plan: one bill, one set of KOTs). Each was
  // free under the seating lock a moment ago; one taken since is reported,
  // not lost.
  const joined = [];
  const notJoined = [];

  for (const extra of existing.extraTables.filter((table) => extraIds.includes(table.id))) {
    try {
      await orderService.joinTable(restaurantId, order.id, { tableId: extra.id, overrideHold: true }, userId);
      joined.push(extra.tableNo);
    } catch (error) {
      notJoined.push({ tableNo: extra.tableNo, message: error.message });
    }
  }

  return {
    booking: await getById(restaurantId, id, outletId),
    order: joined.length > 0 ? await orderService.getById(restaurantId, order.id) : order,
    joinedTables: joined,
    notJoined,
  };
};

// --- Availability ------------------------------------------------------------

// Every table for a time and party size: free, clashing with a booking, too
// small, or (when seating now) still occupied. The host picks from this, so
// the answer to "what can I give them?" is on screen before they ask.
const availability = async (restaurantId, query) => {
  requireRestaurantId(restaurantId);

  const settings = await settingsFor(restaurantId);
  const clock = localClock(settings.timezone);
  const now = query.now === true;
  const date = now ? clock.date : query.date;
  const start = now ? clock.minutes : toMinutes(query.startTime);
  const duration = query.durationMinutes || 90;
  const isToday = date === clock.date;

  const [tables, window] = await Promise.all([
    reservationRepository.findTables(restaurantId, query.outletId || null),
    reservationRepository.findWindowBookings(restaurantId, {
      startsAt: stampAt(date, start),
      endsAt: stampAt(date, start + duration),
      excludeId: query.excludeId,
    }),
  ]);

  const rows = tables.map((row) => {
    const table = toTable(row);
    const clash = window.find((booking) => Number(booking.table_id) === Number(table.id));
    // Someone sitting there now only matters if the new party would arrive
    // before they could reasonably have left.
    const inUse = Boolean(table.live) && isToday && start - clock.minutes < 60;
    let fit = "free";

    // A closed floor or section takes nobody, now or later. A table still
    // being cleaned matters only when seating now: by a later booking's time
    // it will long have been laid again.
    if (!table.inService) {
      fit = "closed";
    } else if (now && (table.live || table.tableStatus === "occupied")) {
      fit = "occupied";
    } else if (now && (table.cleaning || table.tableStatus === "cleaning")) {
      fit = "cleaning";
    } else if (clash) {
      fit = "clash";
    } else if (query.partySize && table.capacity < query.partySize) {
      fit = "small";
    }

    return {
      ...table,
      fit,
      inUse,
      clash: clash
        ? {
            id: clash.id,
            reference: clash.reference_no,
            guestName: clash.guest_name,
            partySize: clash.party_size,
            status: clash.status,
            startTime: clash.start_time,
            endTime: clash.end_time,
          }
        : null,
    };
  });

  // The smallest free table that fits, so a two-top does not go to a
  // six-seater that a family will want at eight.
  const suggested = rows
    .filter((row) => row.fit === "free" && !row.inUse && (!query.partySize || row.capacity >= query.partySize))
    .sort((a, b) => a.capacity - b.capacity)[0];

  return {
    date,
    startTime: hhmm(start),
    endTime: hhmm(start + duration),
    durationMinutes: duration,
    partySize: query.partySize || null,
    suggestedTableId: suggested ? suggested.id : null,
    tables: rows,
  };
};

// --- Guest lookup ------------------------------------------------------------

// Looked up by the exact number only — a host confirming who is on the phone,
// not a way to browse the guest book.
//
// Anyone at the host stand may learn that the caller is in the guest book and
// link them (their id and name). Visits, points and last visit are guest-book
// details, shown only to people allowed to open the guest book
// (customers.view); a captain taking a booking does not get them. The guest
// book's private notes are never sent from here.
//
// `excludeId` leaves out the booking being edited, so "booked 3 times before"
// does not count the booking on screen.
const lookupGuest = async (restaurantId, mobile, { excludeId = null, canSeeGuestBook = false } = {}) => {
  requireRestaurantId(restaurantId);

  const digits = mobile.replace(/\D/g, "");
  const [customer, record] = await Promise.all([
    reservationRepository.findCustomerByMobile(restaurantId, digits),
    reservationRepository.findGuestRecord(restaurantId, digits, excludeId),
  ]);

  let shownCustomer = null;

  if (customer) {
    shownCustomer = canSeeGuestBook
      ? {
          id: customer.id,
          name: customer.name,
          mobile: customer.mobile,
          loyaltyPoints: customer.loyalty_points,
          visits: customer.visits,
          lastVisit: customer.last_visit,
        }
      : { id: customer.id, name: customer.name };
  }

  return {
    mobile,
    customer: shownCustomer,
    record: {
      bookings: record.bookings,
      completed: record.completed,
      noShows: record.no_shows,
      cancelled: record.cancelled,
      lastVisit: record.last_visit,
    },
  };
};

// --- Waitlist ----------------------------------------------------------------

const getWaitlistEntry = async (restaurantId, id, outletId = null) => {
  requireRestaurantId(restaurantId);

  const row = await reservationRepository.findWaitlistById(restaurantId, id, outletId);

  if (!row) {
    throw new AppError(404, "Waitlist entry not found");
  }

  return toWaitlist(row);
};

const refuseWaitlist = (entry) => {
  const said = { seated: "already seated", left: "marked as left", removed: "removed" }[entry.status];
  throw new AppError(409, `${entry.guestName} is ${said}. Refresh the waitlist.`);
};

const addToWaitlist = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  if (data.guestMobile === KEEP_MOBILE) {
    throw new AppError(400, "Type the guest's whole mobile number");
  }

  await requireCustomer(restaurantId, data.customerId);

  if (data.guestMobile) {
    const waiting = await reservationRepository.findWaiting(restaurantId, data.outletId || null);
    const key = data.guestMobile.replace(/\D/g, "").slice(-10);
    const already = waiting.find(
      (row) => row.guest_mobile && row.guest_mobile.replace(/\D/g, "").slice(-10) === key
    );

    if (already) {
      throw new AppError(409, `${already.guest_name} is already on the waitlist with that mobile number.`);
    }
  }

  const id = await reservationRepository.insertWaitlist(restaurantId, data, userId);
  return getWaitlistEntry(restaurantId, id);
};

const updateWaitlistEntry = async (restaurantId, id, data, userId, outletId = null) => {
  const existing = await getWaitlistEntry(restaurantId, id, outletId);

  if (data.guestMobile === KEEP_MOBILE) {
    data = { ...data, guestMobile: existing.guestMobile };
  }

  if (existing.status !== "waiting") {
    refuseWaitlist(existing);
  }

  if (data.customerId !== existing.customerId) {
    await requireCustomer(restaurantId, data.customerId);
  }

  const updated = await reservationRepository.updateWaitlist(restaurantId, id, data, userId);

  if (!updated) {
    throw new AppError(409, "This guest has just left the waitlist. Refresh and try again.");
  }

  return getWaitlistEntry(restaurantId, id);
};

const notifyWaitlist = async (restaurantId, id, userId, outletId = null) => {
  const existing = await getWaitlistEntry(restaurantId, id, outletId);

  if (existing.status !== "waiting") {
    refuseWaitlist(existing);
  }

  await reservationRepository.markNotified(restaurantId, id, userId);
  return getWaitlistEntry(restaurantId, id);
};

const resolveWaitlist = async (restaurantId, id, status, userId, outletId = null) => {
  const existing = await getWaitlistEntry(restaurantId, id, outletId);

  if (existing.status !== "waiting") {
    refuseWaitlist(existing);
  }

  const resolved = await reservationRepository.resolveWaitlist(restaurantId, id, { status, userId });

  if (!resolved) {
    refuseWaitlist(await getWaitlistEntry(restaurantId, id));
  }

  return getWaitlistEntry(restaurantId, id);
};

const seatWaitlist = async (restaurantId, id, options, userId, outletId = null) => {
  const existing = await getWaitlistEntry(restaurantId, id, outletId);

  if (existing.status !== "waiting") {
    refuseWaitlist(existing);
  }

  if (!options.tableId) {
    throw new AppError(400, "Choose a table to seat this party");
  }

  const settings = await settingsFor(restaurantId);
  const clock = localClock(settings.timezone);
  const orderOutletId = await checkSeatingTable(restaurantId, options.tableId, outletId);

  let table;

  try {
    table = await claimTable(
      restaurantId,
      {
        tableId: options.tableId,
        partySize: existing.partySize,
        durationMinutes: options.durationMinutes || 90,
        overrideCapacity: options.overrideCapacity,
        overrideClash: options.overrideClash,
      },
      clock,
      async (client) => {
        const claimed = await reservationRepository.resolveWaitlist(
          restaurantId,
          id,
          { status: "seated", tableId: options.tableId, userId },
          client
        );

        if (!claimed) {
          throw new ClaimLost();
        }
      }
    );
  } catch (error) {
    if (error instanceof ClaimLost) {
      const now = await getWaitlistEntry(restaurantId, id);

      if (now.status !== "waiting") {
        refuseWaitlist(now);
      }

      throw new AppError(409, `${now.guestName} was changed by someone else. Refresh the waitlist.`);
    }

    throw error;
  }

  let order;

  try {
    order = await openTableOrder(
      restaurantId,
      orderOutletId,
      table,
      { ...existing, notes: ["Walk-in", existing.notes].filter(Boolean).join(" · ") },
      userId
    );
  } catch (error) {
    await reservationRepository.reopenWaitlist(restaurantId, id);
    await reservationRepository.releaseTable(restaurantId, table.id, table.table_status);
    throw error;
  }

  await reservationRepository.attachWaitlistOrder(restaurantId, id, order.id);

  return { entry: await getWaitlistEntry(restaurantId, id, outletId), order };
};

// --- The day ------------------------------------------------------------------

// One read for the whole host stand: the book for a date, the room, the
// queue and the numbers, so the page refreshes as one consistent picture.
const board = async (restaurantId, date, outletId = null) => {
  requireRestaurantId(restaurantId);

  const settings = await settingsFor(restaurantId);
  const rules = ruleSettings.fromRow(settings);
  const clock = localClock(settings.timezone);
  const day = date || clock.date;

  await reservationRepository.completeSettled(restaurantId);
  await reservationRepository.expireRequests(restaurantId, clock.stamp);

  const outlookFrom = addDays(day, -3);
  const outlookTo = addDays(day, 3);

  const [rows, tables, summary, hours, waiting, recent, unclosed, stats, perDay, requests] = await Promise.all([
    reservationRepository.findByDate(restaurantId, day, outletId),
    reservationRepository.findTables(restaurantId, outletId),
    reservationRepository.summarise(restaurantId, day, outletId),
    restaurantRepository.findBusinessHours(restaurantId),
    reservationRepository.findWaiting(restaurantId, outletId),
    reservationRepository.findResolvedOn(restaurantId, clock.date, settings.timezone, outletId),
    reservationRepository.findUnclosedOn(restaurantId, clock.date, settings.timezone, outletId),
    reservationRepository.waitStats(restaurantId, clock.date, settings.timezone, outletId),
    reservationRepository.countByDay(restaurantId, outlookFrom, outlookTo, outletId),
    reservationRepository.findPendingRequests(restaurantId, outletId),
  ]);

  const bookings = rows.map(toBooking);
  const isToday = day === clock.date;
  // Late: past their time and still inside the slot they booked, so there is
  // still a table to give them. Missed: the whole slot has gone by and nobody
  // marked them — they belong on the no-show list, not in "running late".
  const behind = isToday
    ? bookings
        .filter((booking) => ["booked", "confirmed"].includes(booking.status))
        .map((booking) => ({ booking, minutes: clock.minutes - toMinutes(booking.startTime) }))
        .filter((item) => item.minutes >= rules.reservationLateMinutes)
    : [];
  const missed = behind.filter((item) => item.minutes >= item.booking.durationMinutes).length;
  const late = behind.length - missed;
  const week = hours.map((row) => toHours(row, rules.reservationLastSeatingMinutes));

  return {
    date: day,
    today: clock.date,
    isToday,
    timezone: settings.timezone,
    now: clock.stamp,
    nowMinutes: clock.minutes,
    lateAfterMinutes: rules.reservationLateMinutes,
    hours: week.find((row) => row && row.dayOfWeek === weekdayOf(day)) || null,
    week,
    outlook: Array.from({ length: 7 }, (_, index) => {
      const date = addDays(outlookFrom, index);
      const counted = perDay.find((row) => row.date === date);
      const open = week.find((row) => row && row.dayOfWeek === weekdayOf(date));

      return {
        date,
        bookings: counted ? counted.bookings : 0,
        covers: counted ? counted.covers : 0,
        requested: counted ? counted.requested : 0,
        isOpen: open ? open.isOpen : true,
      };
    }),
    bookings,
    // Online requests waiting for an answer, for every date: the inbox.
    requests: requests.map(toBooking),
    tables: tables.map(toTable),
    summary: {
      bookings: summary.bookings,
      cancelled: summary.cancelled,
      requested: summary.requested,
      requestedCovers: summary.requested_covers,
      expectedCovers: summary.expected_covers,
      seated: summary.seated,
      seatedCovers: summary.seated_covers,
      seatedNow: summary.seated_now,
      noShows: summary.no_shows,
      noShowCovers: summary.no_show_covers,
      toArrive: summary.to_arrive,
      confirmed: summary.confirmed,
      unassigned: summary.unassigned,
      late,
      missed,
    },
    waitlist: {
      waiting: waiting.map(toWaitlist),
      recent: recent.map(toWaitlist),
      // Still marked waiting, but far past their quote: nobody closed them.
      unclosed: unclosed.map(toWaitlist),
      graceMinutes: reservationRepository.WAITLIST_GRACE_MINUTES,
      stats: {
        waitingNow: stats.waiting_now,
        waitingCovers: stats.waiting_covers,
        longestMinutes: stats.longest_minutes,
        seatedToday: stats.seated_today,
        averageWaitMinutes: stats.average_wait,
        leftToday: stats.left_today,
        unclosedToday: stats.unclosed_today,
      },
    },
  };
};

module.exports = {
  board,
  list,
  getById,
  getDetail,
  create,
  update,
  confirm,
  cancel,
  markNoShow,
  complete,
  seat,
  accept,
  decline,
  pendingRequests,
  getOnlineSettings,
  updateOnlineSettings,
  replaceOnlineLink,
  availability,
  lookupGuest,
  addToWaitlist,
  updateWaitlistEntry,
  notifyWaitlist,
  resolveWaitlist,
  seatWaitlist,
  KEEP_MOBILE,
  // Shared with the notification provider and the seed, so every part of
  // the module agrees on what "now" and "late" mean.
  localClock,
  stampAt,
  addDays,
  weekdayOf,
  dateLabel,
  hhmm,
  WEEKDAYS,
  LAST_SEATING_BEFORE_CLOSE,
  timeLabel,
  toMinutes,
  LATE_AFTER_MINUTES,
};
