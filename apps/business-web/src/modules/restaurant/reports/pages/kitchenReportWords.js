// How the kitchen-station report says its times and hours, on screen and in
// its CSV. Kept free of React, so the words can be tested on their own.

// Seconds as a kitchen reads them: "45 s", "12 min", "1 h 05 min"; a dash
// when no ticket was timed.
export const durationText = (seconds) => {
  if (seconds === null || seconds === undefined) {
    return "—";
  }

  const whole = Math.max(0, Math.round(Number(seconds)));

  if (whole < 60) {
    return `${whole} s`;
  }

  const minutes = Math.round(whole / 60);

  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
};

// The hour a ticket was sent in, as a span on the clock: "19:00–20:00".
export const hourRange = (hour) => `${String(hour).padStart(2, "0")}:00–${String((Number(hour) + 1) % 24).padStart(2, "0")}:00`;

// A station's busiest hours, busiest first: "19:00–20:00 (2), 18:00–19:00 (1)".
export const hoursText = (hours) =>
  (hours || []).length === 0 ? "—" : hours.map((row) => `${hourRange(row.hour)} (${row.tickets})`).join(", ");
