// The guest side of online table booking (SW-A-21). Nobody here is signed
// in: a request carries the restaurant's booking-link token, or a guest's own
// status token, and nothing else. Every answer is about times and the
// guest's own booking — never a table, another guest or a count of covers.
//
// How a time is offered. The day's opening hours (every service period, so a
// lunch and a dinner are two lists) give the times, every half hour up to the
// last seating. A time is free when the guests already expected in that
// window — live bookings and requests still waiting for an answer — plus this
// party fit inside the share of the room's seats the manager opened to online
// guests. Requests count because the host may say yes to every one of them.
const crypto = require("crypto");
const restaurantFeatures = require("../../setup/services/restaurantFeatures.service");
const pool = require("../../../../config/database");
const reservationRepository = require("../repositories/reservation.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const reservationService = require("./reservation.service");
const { logFor } = require("../../../../utils/audit");
const { maskMobile } = require("../../../../utils/phone");
const AppError = require("../../../../utils/AppError");

const {
  localClock,
  stampAt,
  addDays,
  weekdayOf,
  dateLabel,
  timeLabel,
  toMinutes,
  hhmm,
  WEEKDAYS,
  LAST_SEATING_BEFORE_CLOSE,
} = reservationService;

const SLOT_MINUTES = 30;
const LINK_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const GUEST_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const DUPLICATE = "23505";

const LINK_GONE = "This booking link is not in use any more. Please contact the restaurant to book a table.";
const STATUS_GONE = "We couldn't find that booking. Please check the link, or contact the restaurant.";

const OPEN_STATES = ["requested", "booked", "confirmed"];

// What a guest reads for each state of their booking.
const GUEST_STATUS = {
  requested: { label: "Request received", tone: "waiting" },
  booked: { label: "Confirmed", tone: "confirmed" },
  confirmed: { label: "Confirmed", tone: "confirmed" },
  seated: { label: "Enjoy your meal", tone: "confirmed" },
  completed: { label: "Thank you for visiting", tone: "done" },
  declined: { label: "Not available", tone: "declined" },
  cancelled: { label: "Cancelled", tone: "declined" },
  no_show: { label: "Missed", tone: "declined" },
};

// --- The place behind a link ---------------------------------------------------

const placeName = (link) => (link.outlet_name ? `${link.restaurant_name} · ${link.outlet_name}` : link.restaurant_name);
const contactOf = (link) => link.outlet_contact || link.restaurant_contact || null;
const callUs = (link) => (contactOf(link) ? `call us on ${contactOf(link)}` : "call the restaurant");

const resolveLink = async (token) => {
  if (typeof token !== "string" || !LINK_PATTERN.test(token)) {
    throw new AppError(404, LINK_GONE);
  }

  const link = await reservationRepository.findOnlineLink(token);

  // A restaurant or an outlet that has stopped trading takes no bookings,
  // whatever its link says.
  if (!link || link.restaurant_status !== "active" || (link.outlet_id && link.outlet_status !== "active")) {
    throw new AppError(404, LINK_GONE);
  }

  // Reservations switched off (Settings -> Features): no bookings online.
  await restaurantFeatures.assertRestaurantHas(
    link.restaurant_id,
    "reservations",
    `${placeName(link)} is not taking bookings online at the moment. Please ${callUs(link)}.`
  );

  return link;
};

const requireOpen = (link) => {
  if (!link.is_enabled) {
    throw new AppError(
      409,
      `${placeName(link)} is not taking bookings online right now. Please ${callUs(link)} to book a table.`,
      { reason: "booking_off" }
    );
  }
};

// --- Days and times ---------------------------------------------------------------

// A day's service periods as minutes from midnight: [{ open, close }], a close
// past midnight counted on (23:30 -> 01:00 is 1410 -> 1500).
const periodsOf = (row) => {
  if (!row || !row.is_open) {
    return [];
  }

  const listed = Array.isArray(row.periods) && row.periods.length > 0
    ? row.periods
    : [{ openTime: String(row.open_time).slice(0, 5), closeTime: String(row.close_time).slice(0, 5) }];

  return listed
    .filter((period) => period && period.openTime && period.closeTime)
    .map((period) => {
      const open = toMinutes(period.openTime);
      let close = toMinutes(period.closeTime);

      if (close <= open) {
        close += 1440;
      }

      return { open, close };
    })
    .sort((a, b) => a.open - b.open);
};

const mealName = (minutes) => {
  const hour = Math.floor((minutes % 1440) / 60);

  if (hour < 11) return "Breakfast";
  if (hour < 16) return "Lunch";
  return "Dinner";
};

// Why a date cannot be booked online, in words a guest can act on, or null.
const dayProblem = (link, hours, clock, date) => {
  if (date < clock.date) {
    return "That date has passed. Please pick another day.";
  }

  if (date > addDays(clock.date, link.days_ahead)) {
    return `Online bookings open ${link.days_ahead} days ahead. Please pick an earlier date, or ${callUs(link)}.`;
  }

  if ((link.blocked_dates || []).includes(date)) {
    return `We are not taking online bookings on ${dateLabel(date)}. Please pick another day, or ${callUs(link)}.`;
  }

  // No hours set means no times to offer (the link cannot be switched on
  // without them, but they can be cleared afterwards).
  if (hours.length === 0) {
    return `Online booking is not available just now. Please ${callUs(link)}.`;
  }

  const weekday = weekdayOf(date);
  const row = hours.find((day) => Number(day.day_of_week) === weekday);

  if (!row || periodsOf(row).length === 0) {
    return `We are closed on ${WEEKDAYS[weekday]}s. Please pick another day.`;
  }

  return null;
};

// Covers expected in [start, end) on a date, from the load rows.
const coversIn = (load, date, start, end) => {
  const from = stampAt(date, start);
  const to = stampAt(date, end);

  return load
    .filter((row) => row.starts_at < to && row.ends_at > from)
    .reduce((sum, row) => sum + Number(row.party_size), 0);
};

// Every time on a date with whether this party can have it. `db` lets the
// final check run inside the booking's own transaction.
const timesFor = async (link, hours, clock, date, partySize, db = pool) => {
  const periods = periodsOf(hours.find((day) => Number(day.day_of_week) === weekdayOf(date)));
  const room = await reservationRepository.seatsInPlace(link.restaurant_id, link.outlet_id, db);
  const capacity = Math.floor((room.seats * link.seat_share_percent) / 100);
  const earliest = date === clock.date ? clock.minutes + link.min_notice_minutes : -Infinity;
  const duration = link.duration_minutes;

  const starts = [];

  for (const period of periods) {
    const last = Math.max(period.open, period.close - LAST_SEATING_BEFORE_CLOSE);

    for (let minutes = period.open; minutes <= last; minutes += SLOT_MINUTES) {
      starts.push({ minutes, meal: mealName(minutes) });
    }
  }

  if (starts.length === 0) {
    return { capacity, slots: [] };
  }

  const load = await reservationRepository.findPlaceLoad(
    db,
    link.restaurant_id,
    link.outlet_id,
    stampAt(date, starts[0].minutes),
    stampAt(date, starts[starts.length - 1].minutes + duration)
  );

  const slots = starts.map(({ minutes, meal }) => {
    let state = "free";

    if (minutes < earliest) {
      state = "too_soon";
    } else if (partySize > capacity || coversIn(load, date, minutes, minutes + duration) + partySize > capacity) {
      state = "full";
    }

    return { time: hhmm(minutes), minutes, label: timeLabel(minutes), meal, state };
  });

  return { capacity, slots };
};

// --- What a guest's phone reads -----------------------------------------------------

const placeOf = (link) => ({
  name: link.restaurant_name,
  outletName: link.outlet_name || null,
  contact: contactOf(link),
  address: link.outlet_address || link.restaurant_address || null,
});

const info = async (token) => {
  const link = await resolveLink(token);
  const clock = localClock(link.timezone);
  const hours = await restaurantRepository.findBusinessHours(link.restaurant_id);

  const days = Array.from({ length: link.days_ahead + 1 }, (_, index) => {
    const date = addDays(clock.date, index);
    const problem = dayProblem(link, hours, clock, date);

    return { date, open: problem === null, reason: problem };
  });

  return {
    place: placeOf(link),
    enabled: link.is_enabled,
    message: link.is_enabled
      ? null
      : `${placeName(link)} is not taking bookings online right now. Please ${callUs(link)} to book a table.`,
    guestNote: link.guest_note || null,
    maxPartySize: link.max_party_size,
    minNoticeMinutes: link.min_notice_minutes,
    daysAhead: link.days_ahead,
    durationMinutes: link.duration_minutes,
    today: clock.date,
    days,
  };
};

const times = async (token, date, partySize) => {
  const link = await resolveLink(token);
  requireOpen(link);

  if (partySize > link.max_party_size) {
    throw new AppError(
      400,
      `Online bookings are for up to ${link.max_party_size} guests. For a bigger group, please ${callUs(link)} so we can plan your table.`,
      { reason: "party_too_big" }
    );
  }

  const clock = localClock(link.timezone);
  const hours = await restaurantRepository.findBusinessHours(link.restaurant_id);
  const problem = dayProblem(link, hours, clock, date);

  if (problem) {
    return { date, partySize, open: false, reason: problem, slots: [] };
  }

  const { slots: all } = await timesFor(link, hours, clock, date, partySize);
  // Times already gone (or inside the notice) are left out rather than shown
  // struck through: a guest at 7 pm does not need the whole lunch service.
  const slots = all.filter((slot) => slot.state !== "too_soon");
  const free = slots.filter((slot) => slot.state === "free");

  return {
    date,
    partySize,
    open: true,
    // Said when nothing at all is left, so the guest is not left reading a
    // wall of greyed-out times wondering why.
    reason:
      free.length > 0
        ? null
        : slots.length === 0
          ? `It is too late to book online for today. Please pick another day, or ${callUs(link)}.`
          : `We are fully booked online for ${partySize} on ${dateLabel(date)}. Please try another day, or ${callUs(link)}.`,
    slots: slots.map(({ time, label, meal, state }) => ({ time, label, meal, available: state === "free", state })),
  };
};

// --- Asking for a table ---------------------------------------------------------------

const newGuestToken = () => crypto.randomBytes(24).toString("base64url");

const request = async (token, input) => {
  const link = await resolveLink(token);
  requireOpen(link);

  if (input.partySize > link.max_party_size) {
    throw new AppError(
      400,
      `Online bookings are for up to ${link.max_party_size} guests. For a bigger group, please ${callUs(link)} so we can plan your table.`,
      { reason: "party_too_big" }
    );
  }

  const clock = localClock(link.timezone);
  const hours = await restaurantRepository.findBusinessHours(link.restaurant_id);
  const problem = dayProblem(link, hours, clock, input.date);

  if (problem) {
    throw new AppError(400, problem, { reason: "day_closed" });
  }

  const client = await pool.connect();
  let id;
  let guestToken;

  try {
    await client.query("BEGIN");
    // One booking at a time per restaurant (the same lock that numbers
    // bookings R0001, R0002…): two guests reaching for the last seats at 8 pm
    // are answered one after the other, so only one of them gets them.
    await reservationRepository.lockReferences(client, link.restaurant_id);

    const { slots } = await timesFor(link, hours, clock, input.date, input.partySize, client);
    const slot = slots.find((item) => item.time === input.startTime);

    if (!slot) {
      throw new AppError(
        400,
        `${timeLabel(toMinutes(input.startTime))} is not a booking time on ${dateLabel(input.date)}. Please pick one of the times shown.`,
        { reason: "not_a_time" }
      );
    }

    if (slot.state === "too_soon") {
      throw new AppError(
        409,
        `${slot.label} is too soon to book online — we need ${link.min_notice_minutes} minutes' notice. Please pick a later time, or ${callUs(link)}.`,
        { reason: "too_soon" }
      );
    }

    if (slot.state === "full") {
      throw new AppError(
        409,
        `Sorry, ${slot.label} on ${dateLabel(input.date)} has just filled up for ${input.partySize}. Please pick another time.`,
        { reason: "full" }
      );
    }

    const open = await reservationRepository.countOpenForMobile(client, link.restaurant_id, input.guestMobile, clock.date);

    if (open >= link.max_open_per_mobile) {
      throw new AppError(
        409,
        `This mobile number already has ${open} ${open === 1 ? "booking" : "bookings"} or requests coming up with us. ` +
          `Cancel one from its link before asking for another, or ${callUs(link)}.`,
        { reason: "mobile_limit" }
      );
    }

    guestToken = newGuestToken();
    id = await reservationRepository.insertRequest(client, link.restaurant_id, {
      ...input,
      outletId: link.outlet_id,
      durationMinutes: link.duration_minutes,
      guestToken,
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === DUPLICATE) {
      throw new AppError(409, "Several bookings arrived at the same moment. Please press Request again.");
    }

    throw error;
  } finally {
    client.release();
  }

  const booking = await reservationRepository.findByGuestToken(guestToken);

  logFor({ restaurantId: link.restaurant_id, userId: null, userName: "Guest (online)" }, "request", "reservation", {
    id,
    label: `${booking.reference_no} · ${booking.guest_name}`,
    details: { date: input.date, time: input.startTime, partySize: input.partySize, source: "online" },
  });

  return { ...toGuestView(booking, localClock(booking.timezone)), guestToken };
};

// --- The guest's own link --------------------------------------------------------------

const startedBy = (row, clock) =>
  row.reservation_date < clock.date ||
  (row.reservation_date === clock.date && toMinutes(row.start_time) <= clock.minutes);

const toGuestView = (row, clock) => {
  const shown = GUEST_STATUS[row.status] || { label: row.status, tone: "done" };

  return {
    reference: row.reference_no,
    status: row.status,
    statusLabel: shown.label,
    tone: shown.tone,
    guestName: row.guest_name,
    guestMobile: maskMobile(row.guest_mobile),
    partySize: row.party_size,
    date: row.reservation_date,
    dateLabel: dateLabel(row.reservation_date),
    startTime: row.start_time,
    timeLabel: timeLabel(toMinutes(row.start_time)),
    occasion: row.occasion,
    notes: row.special_requests,
    // Why it is not going ahead: the host's words to a declined request, or
    // the reason a booking was called off.
    reason: ["declined", "cancelled"].includes(row.status) ? row.cancel_reason : null,
    requestedAt: row.created_at,
    answeredAt: row.confirmed_at || row.declined_at || null,
    canCancel: OPEN_STATES.includes(row.status) && !startedBy(row, clock),
    // Where to book again, while the restaurant still takes online bookings.
    bookAgain: row.link_enabled && row.link_token ? row.link_token : null,
    place: placeOf({
      restaurant_name: row.restaurant_name,
      outlet_name: row.outlet_name,
      outlet_contact: row.outlet_contact,
      restaurant_contact: row.restaurant_contact,
      outlet_address: row.outlet_address,
      restaurant_address: row.restaurant_address,
    }),
  };
};

const findOwn = async (guestToken) => {
  if (typeof guestToken !== "string" || !GUEST_PATTERN.test(guestToken)) {
    throw new AppError(404, STATUS_GONE);
  }

  let row = await reservationRepository.findByGuestToken(guestToken);

  if (!row) {
    throw new AppError(404, STATUS_GONE);
  }

  // A request nobody answered before its time is told so, not left waiting.
  if (row.status === "requested") {
    await reservationRepository.expireRequests(row.restaurant_id, localClock(row.timezone).stamp);
    row = await reservationRepository.findByGuestToken(guestToken);
  }

  return row;
};

const status = async (guestToken) => {
  const row = await findOwn(guestToken);
  const view = toGuestView(row, localClock(row.timezone));

  return { ...view, guestToken };
};

const GUEST_CANCEL_REASON = "Cancelled by the guest from their booking link";

const cancel = async (guestToken) => {
  const row = await findOwn(guestToken);
  const clock = localClock(row.timezone);

  if (!OPEN_STATES.includes(row.status)) {
    throw new AppError(409, `This booking is already ${(GUEST_STATUS[row.status]?.label || row.status).toLowerCase()}.`);
  }

  if (startedBy(row, clock)) {
    throw new AppError(
      409,
      `Your booking time has already started, so it can't be cancelled online. Please ${
        row.outlet_contact || row.restaurant_contact ? `call us on ${row.outlet_contact || row.restaurant_contact}` : "call the restaurant"
      }.`
    );
  }

  const moved = await reservationRepository.transition(row.restaurant_id, row.id, {
    from: OPEN_STATES,
    to: "cancelled",
    stamp: "cancelled_at",
    cancelReason: GUEST_CANCEL_REASON,
    userId: null,
  });

  if (!moved) {
    throw new AppError(409, "This booking has just changed. Please refresh the page.");
  }

  logFor({ restaurantId: row.restaurant_id, userId: null, userName: "Guest (online)" }, "cancel", "reservation", {
    id: row.id,
    label: `${row.reference_no} · ${row.guest_name}`,
    details: { reason: GUEST_CANCEL_REASON },
  });

  return status(guestToken);
};

module.exports = { info, times, request, status, cancel };
