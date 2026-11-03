// The offline till's rules, kept free of React and the browser so the unit
// tests run them as they are (tests/till.test.js), and the backend's copy
// (backend/src/modules/business/till/services/tillRules.js) is checked
// against them (backend/tests/till-rules.test.js): the till's bill numbers, the financial year a moment falls
// in, the business date of a moment, the GST rate in force on a day, and how
// long the till may still bill offline.

// "2026" -> "2627": the year as Indian invoices print it.
export const fiscalLabel = (year) => `${String(year % 100).padStart(2, "0")}${String((year + 1) % 100).padStart(2, "0")}`;

// The financial year (by the year it starts in) of a business date, with the
// business's year starting in `startMonth` (4: April).
export function fiscalYearOf(day, startMonth = 4) {
  const [year, month] = String(day).split("-").map(Number);
  return month >= Number(startMonth || 4) ? year : year - 1;
}

export const PADDING = 5;
// A till's bill number: its code, the year and five digits, "T2/2627/00001".
export const billNumber = (code, year, seq) => `${code}/${fiscalLabel(year)}/${String(seq).padStart(PADDING, "0")}`;

// The business's date (YYYY-MM-DD) at a moment, in its own time zone.
export const dayOf = (instant, timezone = "Asia/Kolkata") => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(instant));

// The GST rate of an item on a day: the rate the latest change dated by then
// moves it to, else its rate now (the till's snapshot holds the changes still
// to come; those already made are in its rate).
export function rateOn(current, changes, day) {
  const dated = (changes || []).filter((change) => String(change.startsOn) <= day)
    .sort((a, b) => String(a.startsOn).localeCompare(String(b.startsOn)));
  return dated.length ? Number(dated[dated.length - 1].rate) : Number(current);
}

const HOUR = 3_600_000;

// How long the till may still bill offline: { state: "ok" | "warn" | "stop",
// reason, hoursLeft, words }. Offline for `warnHours` it warns; at
// `stopHours`, or with `cap` bills waiting, it stops making new ones until
// the waiting bills are sent. `offlineSince`: when the till last reached the
// server (null while online).
export function limitState({ offlineSince = null, now = Date.now(), waiting = 0, warnHours = 12, stopHours = 72, cap = 2000 } = {}) {
  if (waiting >= cap) {
    return { state: "stop", reason: "cap", hoursLeft: 0, words: `${cap.toLocaleString("en-IN")} bills are waiting on this till: connect it and send them before billing offline again.` };
  }

  if (!offlineSince) {
    return { state: "ok", reason: null, hoursLeft: stopHours, words: "" };
  }

  const hours = (now - offlineSince) / HOUR;

  if (hours >= stopHours) {
    return { state: "stop", reason: "hours", hoursLeft: 0, words: `This till has been offline for more than ${stopHours} hours, the business's limit. Connect it and send the waiting bills before billing offline again.` };
  }

  const left = Math.max(0, stopHours - hours);

  if (hours >= warnHours) {
    return { state: "warn", reason: "hours", hoursLeft: left,
      words: `Offline for ${Math.floor(hours)} hours: this till stops billing offline in ${left < 1 ? "less than an hour" : `${Math.floor(left)} hour${Math.floor(left) === 1 ? "" : "s"}`}. Connect it to send the waiting bills.` };
  }

  return { state: "ok", reason: null, hoursLeft: left, words: "" };
}

// The till's own clock, set by the server's: a moment on the till is the
// device's clock plus the difference the last answer from the server showed.
export const clockOffset = (serverTime, before, after = before) => Date.parse(serverTime) - Math.round((before + after) / 2);
