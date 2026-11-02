// The rules of online booking that need no database (tests/online-booking-rules.test.js):
// the business's clock, the days a guest sees, which times are free and with
// whom, how long a request waits, and what a guest reads about their booking.
//
// A day is worked in the business's own minutes from midnight (its time zone),
// and every booked time is compared as an instant (milliseconds), so a server
// on UTC never puts a booking on the wrong day.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUTE = 60000;

// --- The business's clock --------------------------------------------------------------------------

// One formatter per time zone (making one is slow; a day's times read it often).
const formatters = new Map();
function formatterOf(timeZone) {
  if (!formatters.has(timeZone)) {
    let zone = timeZone;
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone }).format(0);
    } catch {
      zone = 'Asia/Kolkata';
    }
    formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  return formatters.get(timeZone);
}

// The wall clock in a time zone at an instant: { date: 'YYYY-MM-DD', minutes }.
function wallClock(timeZone, at) {
  const parts = Object.fromEntries(formatterOf(timeZone).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), seconds: Number(parts.second) };
}

// Now on the business's clock: { date, minutes, nowMs }.
function clockOf(timeZone, at = Date.now()) {
  const wall = wallClock(timeZone, at);
  return { date: wall.date, minutes: wall.minutes, nowMs: Number(at) };
}

const dayUtc = (date) => {
  const [year, month, day] = String(date).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
};

// The instant of a business-clock day and minute (the minute may run past
// midnight into the next day).
function instantOf(date, minutes, timeZone) {
  const wanted = dayUtc(date) + minutes * MINUTE;
  let guess = wanted;
  for (let i = 0; i < 3; i += 1) {
    const wall = wallClock(timeZone, guess);
    const shown = dayUtc(wall.date) + wall.minutes * MINUTE + wall.seconds * 1000;
    const off = shown - wanted;
    if (off === 0) break;
    guess -= off;
  }
  return guess;
}

// A day's minutes as instants: from its midnight, unless the clocks change that day.
function dayClock(date, timeZone) {
  const start = instantOf(date, 0, timeZone);
  const end = instantOf(date, 1440, timeZone);
  return end - start === 1440 * MINUTE ? (minutes) => start + minutes * MINUTE : (minutes) => instantOf(date, minutes, timeZone);
}

const addDays = (date, days) => new Date(dayUtc(date) + days * 86400000).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(dayUtc(date)).getUTCDay();
const daysBetween = (from, to) => Math.round((dayUtc(to) - dayUtc(from)) / 86400000);

const pad = (n) => String(n).padStart(2, '0');
// 600 → "10:00"
const timeText = (minutes) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
// "10:00" or "10:00:00" → 600; null for anything else.
function minutesOf(text) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(:00)?$/.exec(String(text ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
// 990 → "4:30 pm", the way Indian shops write it.
function timeLabel(minutes) {
  const within = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(within / 60);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${pad(within % 60)} ${hours < 12 ? 'am' : 'pm'}`;
}
// "2026-11-07" → "Sat, 7 Nov"
function dateLabel(date) {
  const at = new Date(dayUtc(date));
  return `${WEEKDAYS[at.getUTCDay()]}, ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}
// Morning before noon, afternoon before five, evening after.
const partOfDay = (minutes) => (minutes < 720 ? 'Morning' : minutes < 1020 ? 'Afternoon' : 'Evening');

// The days a guest sees: today and the days after it, `daysAhead` in all.
const windowDays = (today, daysAhead) => Array.from({ length: daysAhead }, (_, n) => addDays(today, n));

// --- Opening hours and people's windows --------------------------------------------------------------

// A location's hours on a date (business_locations.opening_hours: { mon: { open, close } }),
// as [from, to] minutes, or null when it is closed. A close at or before the
// open (open past midnight) books until midnight.
function locationWindow(hours, date) {
  const slot = hours && typeof hours === 'object' ? hours[DAY_KEYS[weekdayOf(date)]] : null;
  const open = slot ? minutesOf(slot.open) : null;
  const close = slot ? minutesOf(slot.close) : null;
  if (open === null || close === null || open === close) return null;
  return [open, close > open ? close : 1440];
}

// A salon stylist's working window on a date, the way the salon books them
// (businessSalon.service.js availabilityProblem): none on a holiday, on leave,
// on the weekly day off or the day's own "off"; the day's own hours, else the
// usual hours, else the salon's; always inside the salon's hours.
//   stylist: { weeklyOff: [0..6], worksFrom, worksTo, week: [{ dow, off, worksFrom, worksTo }], leave: [{ from, to }] }
//   salon:   { opens, closes } (minutes), holidays: Set of dates
function stylistWindow(stylist, date, salon) {
  if (salon.holidays && salon.holidays.has(date)) return null;
  if ((stylist.leave || []).some((l) => l.from <= date && date <= l.to)) return null;
  const dow = weekdayOf(date);
  const day = (stylist.week || []).find((w) => Number(w.dow) === dow);
  const off = day ? Boolean(day.off) : (stylist.weeklyOff || []).map(Number).includes(dow);
  if (off) return null;
  const from = day && day.worksFrom ? minutesOf(day.worksFrom) : minutesOf(stylist.worksFrom);
  const to = day && day.worksFrom ? minutesOf(day.worksTo) : minutesOf(stylist.worksTo);
  const start = Math.max(salon.opens, from ?? salon.opens);
  const end = Math.min(salon.closes, to ?? salon.closes);
  return end > start ? [start, end] : null;
}

// --- Free times ------------------------------------------------------------------------------------

const overlaps = (busy, start, end) => (busy || []).some(([from, to]) => from < end && to > start);

// The starts that are free on one day, and with whom.
//   candidates  start minutes to try, in order
//   plan        the services back to back: [{ minutes, room }] (room: needs a room)
//   people      [{ id, window: [from, to] | null (or windows: [[from, to], …]), busy: [[ms, ms]], load }]
//   rooms       [{ id, busy }] the rooms a service needing one may take (first free one)
//   toMs        minutes of that day → instant
//   earliestMs  nothing starts before this (now and the notice)
//   accept      optional (person, start) → false to leave a start out (a clinic session's online share)
// Returns [{ minutes, startsMs, endsMs, people: [{ id, rooms: [roomId per service, or null] }] }].
function freeTimes({ candidates, plan, people, rooms = [], toMs, earliestMs = -Infinity, accept = null }) {
  const total = plan.reduce((sum, step) => sum + step.minutes, 0);
  const times = [];
  for (const start of candidates) {
    const startsMs = toMs(start);
    if (startsMs < earliestMs) continue;
    const endsMs = toMs(start + total);
    const free = [];
    for (const person of people) {
      const windows = person.windows || (person.window ? [person.window] : []);
      if (!windows.some(([from, to]) => from <= start && start + total <= to)) continue;
      if (overlaps(person.busy, startsMs, endsMs)) continue;
      if (accept && !accept(person, start)) continue;
      // A room for each service that needs one, for that service's own minutes.
      let at = start;
      const taken = [];
      let roomed = true;
      for (const step of plan) {
        if (step.room) {
          const from = toMs(at), to = toMs(at + step.minutes);
          const room = rooms.find((r) => !overlaps(r.busy, from, to) && !taken.some((t) => t && t.id === r.id && t.from < to && t.to > from));
          if (!room) { roomed = false; break; }
          taken.push({ id: room.id, from, to });
        } else {
          taken.push(null);
        }
        at += step.minutes;
      }
      if (!roomed) continue;
      free.push({ id: person.id, rooms: taken.map((t) => (t ? t.id : null)) });
    }
    if (free.length) times.push({ minutes: start, startsMs, endsMs, people: free });
  }
  return times;
}

// "Any stylist": of those free at a time, the one with the fewest bookings
// that day; on a tie, the one listed first.
function pickAny(free, people) {
  const load = new Map(people.map((p) => [String(p.id), Number(p.load || 0)]));
  return [...free].sort((a, b) => (load.get(String(a.id)) ?? 0) - (load.get(String(b.id)) ?? 0))[0] || null;
}

// The grid of starts from an opening minute to the last start that still fits.
function grid(from, to, step, total) {
  const starts = [];
  for (let m = from; m + total <= to; m += step) starts.push(m);
  return starts;
}

// --- Requests ----------------------------------------------------------------------------------------

// When a request stops holding its time: the link's hours after it was made,
// never past its start.
const expiryOf = (madeMs, startsMs, hours) => Math.min(madeMs + hours * 3600000, startsMs);

// The booking as one status, from its appointments' (a salon's services back
// to back): the first of these that any of them has.
const ORDER = ['requested', 'booked', 'completed', 'no_show', 'declined', 'expired', 'cancelled'];
const overallStatus = (statuses) => ORDER.find((status) => statuses.includes(status)) || statuses[0] || null;

// What a guest reads for each state of their booking.
const GUEST_WORDS = {
  requested: { label: 'Requested', tone: 'waiting' },
  booked: { label: 'Booked', tone: 'confirmed' },
  completed: { label: 'Done', tone: 'done' },
  no_show: { label: 'Missed', tone: 'stopped' },
  declined: { label: 'Not accepted', tone: 'stopped' },
  expired: { label: 'Not confirmed in time', tone: 'stopped' },
  cancelled: { label: 'Cancelled', tone: 'stopped' },
};

// A guest may cancel or change online until the link's cut-off before the
// start; a request may be withdrawn until its start.
function guestMay({ status, startsMs, nowMs, cancelHours, changes, maxChanges, deposit }) {
  const open = status === 'requested' || status === 'booked';
  const beforeCutOff = startsMs - nowMs >= cancelHours * 3600000;
  const started = startsMs <= nowMs;
  return {
    cancel: open && !started && !deposit && (status === 'requested' || beforeCutOff),
    change: open && !started && !deposit && beforeCutOff && changes < maxChanges,
    cutOffPassed: open && !started && !beforeCutOff,
  };
}

// --- An .ics file for the guest's calendar -----------------------------------------------------------

const icsText = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Lines longer than 75 octets fold onto the next line (RFC 5545 3.1).
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest, 'utf8') > 75) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > 74) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}
function icsFile({ uid, startsMs, endsMs, title, location, description, url, stampMs = Date.now() }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Business Management Platform//Online booking//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsStamp(stampMs)}`, `DTSTART:${icsStamp(startsMs)}`, `DTEND:${icsStamp(endsMs)}`,
    `SUMMARY:${icsText(title)}`, location ? `LOCATION:${icsText(location)}` : null, description ? `DESCRIPTION:${icsText(description)}` : null,
    url ? `URL:${url}` : null,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'TRIGGER:-PT2H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter((line) => line !== null).map(fold).join('\r\n');
}

module.exports = {
  DAY_KEYS, WEEKDAYS, LONG_WEEKDAYS, MONTHS, clockOf, instantOf, dayClock, addDays, weekdayOf, daysBetween, timeText, minutesOf, timeLabel, dateLabel, partOfDay,
  windowDays, locationWindow, stylistWindow, freeTimes, pickAny, grid, overlaps, expiryOf, overallStatus, GUEST_WORDS, guestMay, icsFile,
};
