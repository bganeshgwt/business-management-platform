const reservationService = require("../services/reservation.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { normaliseMobile, mobileProblem, maskMobile } = require("../../../../utils/phone");

const OCCASIONS = ["birthday", "anniversary", "business", "date_night", "other"];
const SOURCES = ["phone", "walk_in", "online", "app", "other"];
const STATUSES = ["requested", "booked", "confirmed", "seated", "completed", "cancelled", "no_show", "declined"];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:00)?$/;
// Wide enough for any real booking or history, narrow enough that the week
// around a date never runs off the end of PostgreSQL's calendar.
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

// "2026-02-30" matches the pattern and is still not a day anyone can book.
const requiredDate = (value, field) => {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new AppError(400, `${field} must be a date like 2026-09-24`);
  }

  const [year, month, day] = value.split("-").map(Number);

  // Checked first: JavaScript reads years 0-99 as 1900-1999, so the calendar
  // check below would call 0001-01-01 "not a real date".
  if (year < FIRST_YEAR || year > LAST_YEAR) {
    throw new AppError(400, `${field} must be between ${FIRST_YEAR} and ${LAST_YEAR}`);
  }

  const check = new Date(Date.UTC(year, month - 1, day));

  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new AppError(400, `${field} ${value} is not a real date`);
  }

  return value;
};

// Ids are whole numbers a database id can hold. "1.5", "1e20" or a number
// past JavaScript's safe range are refused here, as a sentence, rather than
// reaching PostgreSQL and coming back as a server error.
const requiredId = (value, field) => {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const number = /^\d{1,16}$/.test(text) ? Number(text) : NaN;

  if (!Number.isSafeInteger(number) || number < 1) {
    throw new AppError(400, `${field} must be a whole number id, like 42`);
  }

  return number;
};

const optionalId = (value, field) =>
  value === undefined || value === null || value === "" ? null : requiredId(value, field);

const optionalDate = (value, field) =>
  value === undefined || value === null || value === "" ? null : requiredDate(value, field);

const requiredTime = (value, field) => {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new AppError(400, `${field} must be a time like 19:30`);
  }

  return value.slice(0, 5);
};

// A masked number as the screens show it to staff who may not see guests'
// full numbers: "XXXXXX4823", or "+XXXXXXXX0123" for one from abroad.
const MASKED = /^\+?X{3,}\d{4}$/;

// Stored in the guest book's one form (utils/phone): an Indian mobile as its
// 10 digits, one from abroad as "+" and digits. "+91 94990 64824", "094990
// 64824" and "9499064824" are the same guest at the host stand, the till and
// in the guest book. The masked number a screen was shown means "unchanged"
// (reservationService.KEEP_MOBILE).
const optionalMobile = (value, field = "Mobile") => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, `${field} must be text`);
  }

  if (MASKED.test(value.trim())) {
    return reservationService.KEEP_MOBILE;
  }

  const mobile = normaliseMobile(value);

  if (!mobile) {
    throw new AppError(400, `${field} ${mobileProblem(value) || "is not a mobile number"}`);
  }

  return mobile;
};

// A number typed to look a guest up: read the same way, but a masked or
// unreadable one is simply "no number".
const lookupMobile = (value) => {
  if (typeof value !== "string" || value.trim() === "" || MASKED.test(value.trim())) {
    return null;
  }

  return normaliseMobile(value);
};

const wholeNumber = (value, field, range) => {
  const number = v.requiredNumber(value, field, range);

  if (!Number.isInteger(number)) {
    throw new AppError(400, `${field} must be a whole number`);
  }

  return number;
};

// Linking a booking to a guest from the guest book needs Guests on.
const guestLink = (req, body = {}) => {
  if (body.customerId && !(req.user.features || []).includes("guests")) {
    throw require("../../setup/services/restaurantFeatures.service").offError("Guests & CRM", "guests");
  }
};

const readBooking = (body = {}) => ({
  guestName: v.requiredString(body.guestName, "Guest name", 150),
  guestMobile: optionalMobile(body.guestMobile),
  customerId: optionalId(body.customerId, "Linked guest"),
  partySize: wholeNumber(body.partySize, "Party size", { min: 1, max: 50 }),
  date: requiredDate(body.date, "Date"),
  startTime: requiredTime(body.startTime, "Time"),
  durationMinutes:
    body.durationMinutes === undefined || body.durationMinutes === null || body.durationMinutes === ""
      ? 90
      : wholeNumber(body.durationMinutes, "Duration in minutes", { min: 30, max: 360 }),
  tableId: optionalId(body.tableId, "Table"),
  // A large party's other tables (the main one is tableId). Left out, an
  // edit keeps the ones the booking has.
  extraTableIds:
    body.extraTableIds === undefined || body.extraTableIds === null
      ? undefined
      : (() => {
          const ids = v.requiredArray(body.extraTableIds, "Other tables").map((id) => v.requiredId(id, "Table"));

          if (ids.length > 8) {
            throw new AppError(400, "A booking can hold at most nine tables. Seat a bigger group in a section of its own.");
          }

          return ids;
        })(),
  overrideCapacity: v.requiredBoolean(body.overrideCapacity, "Over capacity", false),
  capacityOverrideReason: v.optionalString(body.capacityOverrideReason, "Why the party fits", 200),
  occasion: v.optionalEnum(body.occasion, "Occasion", OCCASIONS, null),
  specialRequests: v.optionalString(body.specialRequests, "Special requests", 500),
  source: v.optionalEnum(body.source, "Source", SOURCES, "phone"),
  internalNotes: v.optionalString(body.internalNotes, "Internal notes", 500),
});

const readSeat = (body = {}) => ({
  tableId: optionalId(body.tableId, "Table"),
  overrideCapacity: v.requiredBoolean(body.overrideCapacity, "Over capacity", false),
  overrideClash: v.requiredBoolean(body.overrideClash, "Seat anyway", false),
});

const readWaitlist = (body = {}) => ({
  guestName: v.requiredString(body.guestName, "Guest name", 150),
  guestMobile: optionalMobile(body.guestMobile),
  customerId: optionalId(body.customerId, "Linked guest"),
  partySize: wholeNumber(body.partySize, "Party size", { min: 1, max: 50 }),
  quotedMinutes:
    body.quotedMinutes === undefined || body.quotedMinutes === null || body.quotedMinutes === ""
      ? 15
      : wholeNumber(body.quotedMinutes, "Quoted wait in minutes", { min: 0, max: 240 }),
  notes: v.optionalString(body.notes, "Notes", 300),
});

const label = (booking) => `${booking.reference} · ${booking.guestName}`;

// A linked guest's loyalty points are guest-book detail: shown at the host
// stand only to people who may open the guest book. Everyone who can see the
// book still sees that the booking is linked, and to whom.
// The guest book is the Guests feature too (Settings -> Features): with it off
// a booking is found by its own name and mobile only.
const canSeeGuestBook = (req) =>
  (req.user.permissions || []).includes("customers.view") && (req.user.features || []).includes("guests");

// A guest's full mobile is for staff who may see guests' contact details
// (customers.contact). On the day board and in lists everyone else sees the
// last four digits: a list of bookings is a list of numbers, and a captain
// does not need forty of them. Opening one booking (GET /:id) still gives
// the host who manages bookings the number to call that one guest.
const canSeeContacts = (req) => (req.user.permissions || []).includes("customers.contact");
const canCallGuest = (req) =>
  canSeeContacts(req) || (req.user.permissions || []).includes("reservations.manage");

const masked = (mobile) => (mobile ? maskMobile(mobile) : mobile);

const forViewer = (req, { oneBooking = false } = {}) => {
  const allowed = canSeeGuestBook(req);
  const fullMobile = oneBooking ? canCallGuest(req) : canSeeContacts(req);

  return (booking) => {
    if (!booking) {
      return booking;
    }

    let shown = allowed ? booking : { ...booking, customerPoints: null };

    if (!fullMobile && shown.guestMobile) {
      shown = { ...shown, guestMobile: masked(shown.guestMobile) };
    }

    return shown;
  };
};

const waitlistForViewer = (req) => {
  if (canSeeContacts(req)) {
    return (entry) => entry;
  }

  return (entry) => (entry && entry.guestMobile ? { ...entry, guestMobile: masked(entry.guestMobile) } : entry);
};

// --- Reads ------------------------------------------------------------------

const board = async (req, res) => {
  const date = optionalDate(req.query.date, "Date");
  const data = await reservationService.board(req.user.restaurantId, date, req.outletId);
  const entry = waitlistForViewer(req);

  res.json({
    success: true,
    data: {
      ...data,
      bookings: data.bookings.map(forViewer(req)),
      requests: data.requests.map(forViewer(req)),
      waitlist: {
        ...data.waitlist,
        waiting: data.waitlist.waiting.map(entry),
        recent: data.waitlist.recent.map(entry),
        unclosed: data.waitlist.unclosed.map(entry),
      },
    },
  });
};

const list = async (req, res) => {
  const filters = {
    search: v.optionalString(req.query.search, "Search", 100),
    from: optionalDate(req.query.from, "From"),
    to: optionalDate(req.query.to, "To"),
    statuses: v.enumList(req.query.status, "Status", STATUSES),
    limit:
      req.query.limit === undefined || req.query.limit === ""
        ? 50
        : wholeNumber(req.query.limit, "Limit", { min: 1, max: 200 }),
    outletId: req.outletId,
  };
  const result = await reservationService.list(req.user.restaurantId, filters);
  const shown = forViewer(req);

  res.json({ success: true, data: { ...result, items: result.items.map(shown) } });
};

const getById = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const booking = await reservationService.getDetail(req.user.restaurantId, id, req.outletId);

  res.json({ success: true, data: forViewer(req, { oneBooking: true })(booking) });
};

const availability = async (req, res) => {
  const now = req.query.now === "true";
  const query = {
    now,
    date: now ? null : requiredDate(req.query.date, "Date"),
    startTime: now ? null : requiredTime(req.query.time, "Time"),
    durationMinutes: req.query.duration
      ? wholeNumber(req.query.duration, "Duration in minutes", { min: 30, max: 360 })
      : 90,
    partySize: req.query.partySize
      ? wholeNumber(req.query.partySize, "Party size", { min: 1, max: 50 })
      : null,
    excludeId: optionalId(req.query.excludeId, "Booking"),
    outletId: req.outletId,
  };

  res.json({
    success: true,
    data: await reservationService.availability(req.user.restaurantId, query),
  });
};

const lookupGuest = async (req, res) => {
  const mobile = lookupMobile(req.query.mobile);

  if (!mobile) {
    throw new AppError(400, "Type the guest's whole mobile number, like 98765 43210");
  }

  const data = await reservationService.lookupGuest(req.user.restaurantId, mobile, {
    excludeId: optionalId(req.query.excludeId, "Booking"),
    canSeeGuestBook: canSeeGuestBook(req),
  });

  res.json({ success: true, data });
};

// --- Booking writes ------------------------------------------------------------

const create = async (req, res) => {
  guestLink(req, req.body);
  const data = { ...readBooking(req.body), outletId: req.outletId };
  const booking = await reservationService.create(req.user.restaurantId, data, req.user.id);

  logAction(req, "create", "reservation", {
    id: booking.id,
    label: label(booking),
    details: {
      date: booking.date,
      time: booking.startTime,
      partySize: booking.partySize,
      table: booking.tableNo,
      source: booking.source,
      overCapacity: booking.capacityOverride || undefined,
    },
  });

  res.status(201).json({
    success: true,
    message: `Booking ${booking.reference} saved`,
    data: forViewer(req, { oneBooking: true })(booking),
  });
};

const update = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const { booking, changes } = await reservationService.update(
    req.user.restaurantId,
    id,
    readBooking(req.body),
    req.user.id,
    req.outletId
  );

  logAction(req, "update", "reservation", { id, label: label(booking), details: changes });

  res.json({ success: true, message: "Booking updated", data: forViewer(req, { oneBooking: true })(booking) });
};

const confirm = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const booking = await reservationService.confirm(req.user.restaurantId, id, req.user.id, req.outletId);

  logAction(req, "confirm", "reservation", { id, label: label(booking) });

  res.json({
    success: true,
    message: `${booking.guestName}'s booking is confirmed`,
    data: forViewer(req)(booking),
  });
};

const cancel = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const reason = v.requiredString(req.body?.reason, "Reason for cancelling", 200);
  const booking = await reservationService.cancel(req.user.restaurantId, id, reason, req.user.id, req.outletId);

  logAction(req, "cancel", "reservation", { id, label: label(booking), details: { reason } });

  res.json({ success: true, message: "Booking cancelled", data: forViewer(req)(booking) });
};

const markNoShow = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const booking = await reservationService.markNoShow(req.user.restaurantId, id, req.user.id, req.outletId);

  logAction(req, "no_show", "reservation", {
    id,
    label: label(booking),
    details: { partySize: booking.partySize, table: booking.tableNo },
  });

  res.json({
    success: true,
    message: `${booking.guestName} marked as a no-show`,
    data: forViewer(req)(booking),
  });
};

const complete = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const booking = await reservationService.complete(req.user.restaurantId, id, req.user.id, req.outletId);

  logAction(req, "complete", "reservation", { id, label: label(booking) });

  res.json({ success: true, message: "Booking completed", data: forViewer(req)(booking) });
};

const seat = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const options = readSeat(req.body);
  const { booking, order, joinedTables = [], notJoined = [] } = await reservationService.seat(
    req.user.restaurantId,
    id,
    options,
    req.user.id,
    req.outletId
  );

  logAction(req, "seat", "reservation", {
    id,
    label: label(booking),
    details: {
      table: booking.tableNo,
      joined: joinedTables.length > 0 ? joinedTables : undefined,
      notJoined: notJoined.length > 0 ? notJoined.map((row) => row.tableNo) : undefined,
      order: order.orderNumber,
      guests: booking.partySize,
      overCapacity: options.overrideCapacity || undefined,
      seatedDespiteBooking: options.overrideClash || undefined,
    },
  });

  // "Mehta seated at T5 with T6, T7 · order ORD-0412 opened", and any table
  // that could not be joined, in words the host can act on.
  const withTables = joinedTables.length > 0 ? ` with ${joinedTables.join(", ")}` : "";
  const problems = notJoined.map((row) => ` Table ${row.tableNo} could not be joined: ${row.message}`).join("");

  res.json({
    success: true,
    message: `${booking.guestName} seated at ${booking.tableNo}${withTables} · order ${order.orderNumber} opened.${problems}`,
    data: { booking: forViewer(req)(booking), order, joinedTables, notJoined },
  });
};

// --- Online requests and the booking link ------------------------------------

const requests = async (req, res) => {
  const result = await reservationService.pendingRequests(req.user.restaurantId, req.outletId);

  res.json({ success: true, data: { ...result, items: result.items.map(forViewer(req)) } });
};

const readAccept = (body = {}) => ({
  tableId: optionalId(body.tableId, "Table"),
  extraTableIds:
    body.extraTableIds === undefined || body.extraTableIds === null
      ? []
      : (() => {
          const ids = v.requiredArray(body.extraTableIds, "Other tables").map((id) => v.requiredId(id, "Table"));

          if (ids.length > 8) {
            throw new AppError(400, "A booking can hold at most nine tables. Seat a bigger group in a section of its own.");
          }

          return ids;
        })(),
  overrideCapacity: v.requiredBoolean(body.overrideCapacity, "Over capacity", false),
  capacityOverrideReason: v.optionalString(body.capacityOverrideReason, "Why the party fits", 200),
});

const accept = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const options = readAccept(req.body);
  const booking = await reservationService.accept(req.user.restaurantId, id, options, req.user.id, req.outletId);

  logAction(req, "accept", "reservation", {
    id,
    label: label(booking),
    details: {
      date: booking.date,
      time: booking.startTime,
      partySize: booking.partySize,
      table: booking.tables.length > 0 ? booking.tables.map((table) => table.tableNo).join(" + ") : undefined,
    },
  });

  res.json({
    success: true,
    message: booking.tableNo
      ? `${booking.guestName}'s request accepted on ${booking.tables.map((table) => table.tableNo).join(" + ")} — the guest sees it confirmed on their link`
      : `${booking.guestName}'s request accepted — the guest sees it confirmed on their link. Give it a table before they arrive.`,
    data: forViewer(req, { oneBooking: true })(booking),
  });
};

const decline = async (req, res) => {
  const id = requiredId(req.params.id, "Booking id");
  const reason = v.requiredString(req.body?.reason, "Reason the guest will read", 200);
  const booking = await reservationService.decline(req.user.restaurantId, id, reason, req.user.id, req.outletId);

  logAction(req, "decline", "reservation", { id, label: label(booking), details: { reason } });

  res.json({
    success: true,
    message: `${booking.guestName}'s request declined — the guest sees your reason on their link`,
    data: forViewer(req)(booking),
  });
};

const onlineSettings = async (req, res) => {
  res.json({ success: true, data: await reservationService.getOnlineSettings(req.user.restaurantId, req.outletId) });
};

// One date as YYYY-MM-DD, at most a year of them, each once and in order.
const readBlockedDates = (value) => {
  if (value === undefined || value === null) {
    return [];
  }

  const dates = v.requiredArray(value, "Dates closed to online bookings").map((date) => requiredDate(date, "Closed date"));

  if (dates.length > 60) {
    throw new AppError(400, "Close at most 60 dates to online bookings. Turn online booking off for longer breaks.");
  }

  return [...new Set(dates)].sort();
};

const whole = (value, field, range) => wholeNumber(value, field, range);

const updateOnlineSettings = async (req, res) => {
  const body = req.body || {};
  const data = {
    isEnabled: v.requiredBoolean(body.isEnabled, "Online booking on", false),
    maxPartySize: whole(body.maxPartySize, "Largest party online", { min: 1, max: 50 }),
    seatSharePercent: whole(body.seatSharePercent, "Share of seats for online bookings", { min: 10, max: 100 }),
    minNoticeMinutes: whole(body.minNoticeMinutes, "Notice needed in minutes", { min: 0, max: 1440 }),
    daysAhead: whole(body.daysAhead, "Days ahead", { min: 1, max: 180 }),
    durationMinutes: whole(body.durationMinutes, "Table time in minutes", { min: 30, max: 360 }),
    maxOpenPerMobile: whole(body.maxOpenPerMobile, "Open bookings per mobile", { min: 1, max: 10 }),
    blockedDates: readBlockedDates(body.blockedDates),
    guestNote: v.optionalString(body.guestNote, "Note for guests", 300),
  };

  const { settings, changes } = await reservationService.updateOnlineSettings(
    req.user.restaurantId,
    req.outletId,
    data,
    req.user.id
  );

  logAction(req, "update", "online_booking", {
    id: null,
    label: settings.placeName ? `Online booking · ${settings.placeName}` : "Online booking · Main counter",
    details: changes,
  });

  res.json({
    success: true,
    message: settings.isEnabled ? "Online booking is on — guests can book from the link" : "Online booking settings saved",
    data: settings,
  });
};

const replaceOnlineLink = async (req, res) => {
  const settings = await reservationService.replaceOnlineLink(req.user.restaurantId, req.outletId, req.user.id);

  logAction(req, "new_link", "online_booking", {
    id: null,
    label: settings.placeName ? `Online booking · ${settings.placeName}` : "Online booking · Main counter",
  });

  res.json({
    success: true,
    message: "New booking link made. The old link no longer works — share the new one.",
    data: settings,
  });
};

// --- Waitlist ---------------------------------------------------------------

const waitlistLabel = (entry) => `${entry.guestName} (${entry.partySize})`;

const addToWaitlist = async (req, res) => {
  guestLink(req, req.body);
  const data = { ...readWaitlist(req.body), outletId: req.outletId };
  const entry = await reservationService.addToWaitlist(req.user.restaurantId, data, req.user.id);

  logAction(req, "create", "waitlist_entry", {
    id: entry.id,
    label: waitlistLabel(entry),
    details: { quotedMinutes: entry.quotedMinutes },
  });

  res.status(201).json({
    success: true,
    message: `${entry.guestName} added to the waitlist`,
    data: waitlistForViewer(req)(entry),
  });
};

const updateWaitlist = async (req, res) => {
  const id = requiredId(req.params.id, "Waitlist entry id");
  const entry = await reservationService.updateWaitlistEntry(
    req.user.restaurantId,
    id,
    readWaitlist(req.body),
    req.user.id,
    req.outletId
  );

  logAction(req, "update", "waitlist_entry", {
    id,
    label: waitlistLabel(entry),
    details: { quotedMinutes: entry.quotedMinutes, partySize: entry.partySize },
  });

  res.json({ success: true, message: "Waitlist entry updated", data: waitlistForViewer(req)(entry) });
};

const notifyWaitlist = async (req, res) => {
  const id = requiredId(req.params.id, "Waitlist entry id");
  const entry = await reservationService.notifyWaitlist(req.user.restaurantId, id, req.user.id, req.outletId);

  logAction(req, "notify", "waitlist_entry", { id, label: waitlistLabel(entry) });

  res.json({
    success: true,
    message: `${entry.guestName} told their table is ready`,
    data: waitlistForViewer(req)(entry),
  });
};

const resolveWaitlist = (status, action, message) => async (req, res) => {
  const id = requiredId(req.params.id, "Waitlist entry id");
  const entry = await reservationService.resolveWaitlist(
    req.user.restaurantId,
    id,
    status,
    req.user.id,
    req.outletId
  );

  logAction(req, action, "waitlist_entry", { id, label: waitlistLabel(entry) });

  res.json({ success: true, message: message(entry), data: waitlistForViewer(req)(entry) });
};

const markLeft = resolveWaitlist("left", "left", (entry) => `${entry.guestName} left without a table`);
const removeFromWaitlist = resolveWaitlist(
  "removed",
  "remove",
  (entry) => `${entry.guestName} removed from the waitlist`
);

const seatWaitlist = async (req, res) => {
  const id = requiredId(req.params.id, "Waitlist entry id");
  const options = readSeat(req.body);
  const { entry, order } = await reservationService.seatWaitlist(
    req.user.restaurantId,
    id,
    options,
    req.user.id,
    req.outletId
  );

  logAction(req, "seat", "waitlist_entry", {
    id,
    label: waitlistLabel(entry),
    details: {
      table: entry.tableNo,
      order: order.orderNumber,
      overCapacity: options.overrideCapacity || undefined,
      seatedDespiteBooking: options.overrideClash || undefined,
    },
  });

  res.json({
    success: true,
    message: `${entry.guestName} seated at ${entry.tableNo} · order ${order.orderNumber} opened`,
    data: { entry: waitlistForViewer(req)(entry), order },
  });
};

module.exports = {
  board,
  list,
  getById,
  availability,
  lookupGuest,
  create,
  update,
  confirm,
  cancel,
  markNoShow,
  complete,
  seat,
  requests,
  accept,
  decline,
  onlineSettings,
  updateOnlineSettings,
  replaceOnlineLink,
  addToWaitlist,
  updateWaitlist,
  notifyWaitlist,
  markLeft,
  removeFromWaitlist,
  seatWaitlist,
};
