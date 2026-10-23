import { durationMinutes } from "@bmp/shared/format";

// Small, React-free helpers for the live dashboard: how times, waits and
// the floor are put into words. Kept apart from the components so the rules
// can be read (and tested) on their own.

// The business date, written the way a person would say it.
export const longDate = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

// 14 -> "2pm". Hours are the axis of a trading day, so the labels stay short.
export const hourLabel = (hour) => {
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;

  return `${twelve}${suffix}`;
};

// How stale the figures on screen are. A live dashboard has to say when it
// last looked, or a stopped clock is indistinguishable from a quiet hour.
export const agoLabel = (updatedAt, now) => {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));

  if (seconds < 15) {
    return "just now";
  }

  if (seconds < 90) {
    return `${seconds}s ago`;
  }

  return `${Math.round(seconds / 60)} min ago`;
};

// "Good evening, Ravi" — the first word of the name, by the clock of the
// device in the manager's hand.
export const greeting = (name, at = new Date()) => {
  const hour = at.getHours();
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = String(name || "").trim().split(/\s+/)[0];

  return first ? `${part}, ${first}` : part;
};

// A wait in whole minutes, the way a floor manager says it: "8 min",
// "1 h 20 min", and "2 days" for something nobody closed.
export const waitText = (minutes) => durationMinutes(minutes, { long: true });

// Minutes from `since` to `now` (both ISO strings or Dates); never negative,
// so a clock a few seconds ahead of the server does not read "−0 min".
export const minutesFrom = (since, now = Date.now()) =>
  Math.max(0, (new Date(now).getTime() - new Date(since).getTime()) / 60000);

// A duration the server worked out in seconds: "45 s", "9 min", "1 h 5 min".
// Below zero means the record is wrong (a ticket marked ready before it was
// cut), and a dash says "no honest figure" where "−3 min" would be nonsense.
export const secondsText = (seconds) => {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds)) || Number(seconds) < 0) {
    return "—";
  }

  const value = Number(seconds);

  if (value < 60) {
    return `${Math.round(value)} s`;
  }

  return waitText(value / 60);
};

// "5:30 pm" on the restaurant's clock.
export const clockTime = (at, timeZone) => {
  try {
    return new Date(at).toLocaleTimeString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
  }
};

// "19:30" -> minutes since midnight.
export const toMinutes = (hhmm) => {
  const [hours, minutes] = String(hhmm || "").split(":").map(Number);

  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
};

// The floor in the same states the floor plan draws (GET /tables floorState).
// A table that is out of service — switched off, or on a floor or section
// that is closed — is not capacity: it can take no party, so it is counted
// apart rather than as "free". With an outlet chosen, only its tables count.
export const floorCounts = (tables, outletId) => {
  const mine = outletId ? tables.filter((table) => table.outletId === outletId) : tables;
  const counts = { running: 0, printed: 0, paid: 0, reserved: 0, cleaning: 0, free: 0, off: 0 };
  let seats = 0;
  let seatsBusy = 0;
  let guests = 0;

  for (const table of mine) {
    const state = table.floorState || "free";

    if (state === "out_of_service") {
      counts.off += 1;
      continue;
    }

    counts[state] = (counts[state] || 0) + 1;
    seats += Number(table.capacity || 0);

    if (state === "running" || state === "printed" || state === "paid") {
      seatsBusy += Number(table.capacity || 0);
      guests += Number((table.live && table.live.guestCount) || 0);
    }
  }

  const busy = counts.running + counts.printed + counts.paid;

  return {
    ...counts,
    busy,
    inService: mine.length - counts.off,
    total: mine.length,
    seats,
    seatsBusy,
    guests,
  };
};

// Bookings due from now to an hour from now that have not arrived yet.
export const arrivingSoon = (board, withinMinutes = 60) => {
  if (!board || !board.isToday) {
    return { parties: 0, covers: 0 };
  }

  const soon = board.bookings.filter((booking) => {
    if (!["booked", "confirmed"].includes(booking.status)) {
      return false;
    }

    const start = toMinutes(booking.startTime);

    return start !== null && start >= board.nowMinutes && start - board.nowMinutes <= withinMinutes;
  });

  return {
    parties: soon.length,
    covers: soon.reduce((sum, booking) => sum + Number(booking.partySize || 0), 0),
  };
};

// "19:30" -> "7:30 pm": a booking's time the way the rest of the app says it.
export const clock12 = (hhmm) => {
  const minutes = toMinutes(hhmm);

  if (minutes === null) {
    return String(hhmm || "");
  }

  const hours = Math.floor(minutes / 60) % 24;
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return `${twelve}:${String(minutes % 60).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
};

