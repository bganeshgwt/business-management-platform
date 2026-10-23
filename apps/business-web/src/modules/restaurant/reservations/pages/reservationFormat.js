import { durationMinutes } from "@bmp/shared/format";
// Words, times and live state shared by the reservation screens.

import { MONTH_NAMES, dayMonth } from "@bmp/shared/dates";

// ---------------------------------------------------------------- vocabulary

export const STATUS = {
  // An online request: holds no table until someone says yes.
  requested: { label: "Requested · online", hint: "waiting for your answer" },
  booked: { label: "Booked", hint: "not confirmed yet" },
  confirmed: { label: "Confirmed", hint: "guest said yes" },
  seated: { label: "Seated", hint: "at the table" },
  completed: { label: "Completed", hint: "paid and left" },
  no_show: { label: "No-show", hint: "never arrived" },
  cancelled: { label: "Cancelled", hint: "called off" },
  declined: { label: "Declined", hint: "online request turned down" },
};

export const OCCASIONS = [
  { value: "birthday", label: "Birthday" },
  { value: "anniversary", label: "Anniversary" },
  { value: "business", label: "Business" },
  { value: "date_night", label: "Date night" },
  { value: "other", label: "Celebration" },
];

export const SOURCES = [
  { value: "phone", label: "Phone" },
  { value: "walk_in", label: "Walk-in" },
  { value: "online", label: "Online" },
  { value: "app", label: "App" },
  { value: "other", label: "Other" },
];

export const DURATIONS = [60, 75, 90, 105, 120, 150, 180];

export const QUOTES = [5, 10, 15, 20, 30, 45, 60];

export const CANCEL_REASONS = [
  "Guest cancelled",
  "Change of plans",
  "Guest unwell",
  "Booked twice by mistake",
  "Moved to another date",
];

export const LEGEND = [
  { tone: "requested", label: "Requested online", hint: "no table held yet" },
  { tone: "booked", label: "Booked", hint: "awaiting confirmation" },
  { tone: "confirmed", label: "Confirmed" },
  { tone: "seated", label: "Seated" },
  { tone: "late", label: "Late" },
  { tone: "missed", label: "Slot over, not seated" },
  { tone: "completed", label: "Completed" },
  { tone: "no_show", label: "No-show" },
  { tone: "walkin", label: "In use, no booking" },
];

export const occasionLabel = (value) => OCCASIONS.find((item) => item.value === value)?.label || null;

export const sourceLabel = (value) => SOURCES.find((item) => item.value === value)?.label || value;

// ---------------------------------------------------------------- time
//
// Bookings are the restaurant's wall-clock times. "Now" is therefore read in
// the restaurant's timezone, which the board sends, not the browser's — a
// manager checking the book from another city must still see the room's time.

export const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
};

export const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export const timeLabel = (minutes) => {
  const within = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(within / 60);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return `${twelve}:${String(within % 60).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
};

export const hourLabel = (minutes) => {
  const hours = Math.floor((((minutes % 1440) + 1440) % 1440) / 60);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return `${twelve} ${hours < 12 ? "am" : "pm"}`;
};

const asUtc = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

export const addDays = (date, days) => new Date(asUtc(date).getTime() + days * 86400000).toISOString().slice(0, 10);

const daysBetween = (from, to) => Math.round((asUtc(to) - asUtc(from)) / 86400000);

export const longDate = (date) =>
  asUtc(date).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

// "Wed, 30 Sep": the app's own month names. The browser's en-IN short month
// spells September "Sept", which no other screen, bill or KOT does.
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const shortDate = (date) => {
  const day = asUtc(date);

  return `${SHORT_WEEKDAYS[day.getUTCDay()]}, ${day.getUTCDate()} ${MONTH_NAMES[day.getUTCMonth()]}`;
};

// Why a booking's table cannot take the party now, said on its card. The
// booking keeps the table (a closed terrace may reopen by then); the host
// moves it when they know.
export const tableOffWords = (booking) =>
  booking.tableOutOfService === "floor"
    ? `${booking.floorName || "its floor"} closed`
    : booking.tableOutOfService === "area"
      ? `${booking.areaName || "its section"} closed`
      : booking.tableOutOfService === "table"
        ? "table switched off"
        : null;

// The same, as part of a sentence: "the Terrace is closed".
export const tableOffSentence = (booking) =>
  booking.tableOutOfService === "floor"
    ? `the ${booking.floorName || "floor"} is closed`
    : booking.tableOutOfService === "area"
      ? `the ${booking.areaName || "section"} is closed`
      : "the table is switched off";

export const tableOffNow = (booking) =>
  Boolean(booking.tableOutOfService) && ["booked", "confirmed"].includes(booking.status);

// A large party holds its main table and the others pushed together with it:
// "T11 + T12 + T13". The main table always comes first.
export const tablesLabel = (booking) =>
  booking.tableNo
    ? [booking.tableNo, ...(booking.extraTables || []).map((table) => table.tableNo)].join(" + ")
    : null;

export const heldSeats = (booking) =>
  (booking.tableCapacity || 0) + (booking.extraTables || []).reduce((sum, table) => sum + (table.capacity || 0), 0);

// Whether a booking holds this table, as its main table or one of the others.
export const holdsTable = (booking, tableId) =>
  booking.tableId === tableId || (booking.extraTables || []).some((table) => table.id === tableId);

export const relativeDay = (date, today) => {
  const offset = daysBetween(today, date);

  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";

  return offset > 0 ? `In ${offset} days` : `${-offset} days ago`;
};

export const clockIn = (timezone, at = Date.now()) => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const get = (type) => parts.find((part) => part.type === type).value;

    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      minutes: Number(get("hour")) * 60 + Number(get("minute")),
    };
  } catch {
    const local = new Date(at);
    return { date: local.toLocaleDateString("en-CA"), minutes: local.getHours() * 60 + local.getMinutes() };
  }
};

export const minutesSince = (iso, now) => Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));

export const waitText = (minutes) =>
  minutes < 60 ? `${minutes} min` : durationMinutes(minutes);

export const digitsOf = (text) => String(text || "").replace(/\D/g, "");

// "Ishita B." for a block too narrow for a whole name.
export const shortName = (name) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
};

// Where a booking stands against the clock right now. Only today's unseated
// bookings have one: they are the ones the host has to act on.
//
// "Late" is still inside the slot they booked, so there is a table to give
// them. Once the whole slot has gone by nobody is "running late" any more:
// the booking is missed, and the next step is marking the no-show.
export const liveState = (booking, clock, isToday, lateAfter = 15) => {
  if (!isToday || !["booked", "confirmed"].includes(booking.status)) {
    return null;
  }

  const behind = clock.minutes - toMinutes(booking.startTime);

  if (behind >= booking.durationMinutes) return { key: "missed", label: `No-show? ${waitText(behind)} late` };
  if (behind >= lateAfter) return { key: "late", label: `${behind} min late` };
  if (behind >= 0) return { key: "due", label: "Due now" };
  if (-behind <= 30) return { key: "soon", label: `In ${-behind} min` };

  return null;
};

// A booking's colour on the timeline and its card: its status, or amber when
// it is running late, or red once its slot is over with nobody seated.
export const toneOf = (booking, live) =>
  live?.key === "late" ? "late" : live?.key === "missed" ? "missed" : booking.status;

// How long a booking really holds its table. A seated party whose bill is
// still open is at the table until they pay, however long they booked for,
// so the block runs on to now instead of leaving the row looking free.
export const heldUntil = (booking, clock, isToday) => {
  const booked = toMinutes(booking.startTime) + booking.durationMinutes;
  const eating = isToday && booking.status === "seated" && ["open", "billed"].includes(booking.orderStatus);

  return eating ? Math.max(booked, clock.minutes) : booked;
};

// The actions a booking offers depend on where it is in its life and on the
// clock: nobody is a no-show before their time, and only today's bookings
// can be seated.
export const bookingActions = (booking, { clock, canManage, canSeat }) => {
  const open = ["booked", "confirmed"].includes(booking.status);
  const isToday = booking.date === clock.date;
  const started =
    booking.date < clock.date || (isToday && toMinutes(booking.startTime) <= clock.minutes);

  return {
    confirm: canManage && booking.status === "booked" && booking.date >= clock.date,
    seat: canSeat && isToday && (open || booking.status === "no_show"),
    noShow: canManage && open && started,
    cancel: canManage && open,
    edit: canManage && (open || booking.status === "requested"),
    // An online request is answered, not cancelled: yes (with or without a
    // table) or no with a reason the guest reads on their link.
    accept: canManage && booking.status === "requested" && booking.date >= clock.date,
    decline: canManage && booking.status === "requested",
    // A table still eating is completed by settling its bill, not by hand.
    complete:
      canManage && booking.status === "seated" && !["open", "billed"].includes(booking.orderStatus),
  };
};

// "30 Sep, 7:42 pm", with the app's own month names (see shortDate).
export const at = (iso) => dayMonth(iso, { time: true });
