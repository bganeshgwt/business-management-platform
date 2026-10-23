// Money, counts, dates and durations on screen — one place, so every screen
// says ₹6,15,657, "6 Oct" and "1h 40m" the same way. The API always sends
// plain numbers and ISO dates, so formatting is a presentation decision and
// lives here rather than in each page.

import { MONTH_NAMES } from "./dates.js";

const GROUPED = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const EXACT = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const MINUS = "−";

// A headline figure: no paise unless there are some. ₹9,556 reads instantly;
// ₹9556.00 makes the eye do work for nothing.
export const money = (value, currency = "₹") => {
  const number = Number(value || 0);
  const whole = Math.round(number * 100) % 100 === 0;

  return `${currency}${whole ? GROUPED.format(number) : EXACT.format(number)}`;
};

// A figure that has to tie out to the paisa — a bill line, a payment, a tax
// total. Always two decimals, so columns line up and nothing looks rounded.
export const moneyExact = (value, currency = "₹") => `${currency}${EXACT.format(Number(value || 0))}`;

// Plain counts: 1,240 rather than 1240.
export const count = (value) => GROUPED.format(Number(value || 0));

// A headline tile: whole rupees, always (₹14,27,790), so a row of tiles never
// mixes ₹1,083.75 with ₹8,545. Exact paise belong in tables, bills and reports.
// A negative reads "−₹1,906" (a real minus, before the sign).
export const moneyWhole = (value, currency = "₹") => {
  const rounded = Math.round(Number(value || 0));
  return `${rounded < 0 ? MINUS : ""}${currency}${GROUPED.format(Math.abs(rounded))}`;
};

// A big figure in the words an Indian owner uses: ₹1.18 Cr, ₹14.3 L; under a
// lakh it is the whole-rupee figure. For tiles on a phone, with the exact
// figure in the tile's title (StatTile `exact`).
export const moneyShort = (value, currency = "₹") => {
  const number = Number(value || 0);
  const size = Math.abs(number);
  const sign = number < 0 ? MINUS : "";
  const trim = (n, digits) => n.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

  if (size >= 1e7) {
    return `${sign}${currency}${trim(size / 1e7, 2)} Cr`;
  }

  if (size >= 1e5) {
    return `${sign}${currency}${trim(size / 1e5, 1)} L`;
  }

  return moneyWhole(number, currency);
};

// A customer or supplier balance said as words, never a bare minus:
// "Owes ₹2,000.00", "Advance ₹1,905.55", "Settled". `owes` / `advance` change
// the words (a supplier: { owes: "We owe" }).
export const balanceText = (value, { owes = "Owes", advance = "Advance", settled = "Settled", exact = true } = {}) => {
  const number = Number(value || 0);
  const format = exact ? moneyExact : moneyWhole;

  if (Math.abs(number) < 0.005) {
    return settled;
  }

  return number > 0 ? `${owes} ${format(number)}` : `${advance} ${format(Math.abs(number))}`;
};

// --- Amount in words (Indian system), for tax invoices ----------------------

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

const belowHundred = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`);

const belowThousand = (n) => {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
};

const wholeInWords = (n) => {
  if (n === 0) {
    return "Zero";
  }

  const parts = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1000);
  const rest = n % 1000;

  if (crore) parts.push(`${wholeInWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));

  return parts.join(" ");
};

// 1,23,456.50 -> "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty
// Six and Fifty Paise Only".
export const amountInWords = (value) => {
  const paiseTotal = Math.round(Math.abs(Number(value || 0)) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;

  return `Rupees ${wholeInWords(rupees)}${paise ? ` and ${belowHundred(paise)} Paise` : ""} Only`;
};

// --- Dates -------------------------------------------------------------------
//
// Every date helper takes a Date, a timestamp, an ISO moment or a plain
// "2026-10-06" (read as that calendar day, not midnight UTC) and returns ""
// for anything empty or unreadable. The year is added only when it is not
// this year (or always with { year: true }).

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const toDate = (value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00`) : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
};

const yearPart = (date, year, now) =>
  year === true || (year !== false && date.getFullYear() !== new Date(now).getFullYear()) ? ` ${date.getFullYear()}` : "";

// "8:29 pm"
export const timeOnly = (value) => {
  const date = toDate(value);
  return date ? date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "";
};

// "6 Oct" (this year) or "6 Oct 2025"
export const dateShort = (value, { year, now = Date.now() } = {}) => {
  const date = toDate(value);
  return date ? `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}${yearPart(date, year, now)}` : "";
};

// "Fri, 2 Oct 2026" — always with the year.
export const dateLong = (value) => {
  const date = toDate(value);
  return date ? `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}` : "";
};

// "6 Oct, 8:29 pm" (this year) or "6 Oct 2025, 8:29 pm"
export const dateTime = (value, options = {}) => {
  const date = toDate(value);
  return date ? `${dateShort(date, options)}, ${timeOnly(date)}` : "";
};

// How long something has been going on, from minutes:
//   40 -> "40m", 100 -> "1h 40m", 120 -> "2h", 3 days+ -> "3 days".
// { long: true } spells it for sentences: "40 min", "1 h 40 min", "3 days".
// `hours: true` keeps counting in hours past a day — "26h 10m" — for totals
// (time worked, hours booked) where "1 day" would hide the figure.
export const durationMinutes = (minutes, { long = false, hours: inHours = false } = {}) => {
  const total = Math.max(0, Math.round(Number(minutes) || 0));

  if (total < 60) {
    return long ? `${total} min` : `${total}m`;
  }

  if (total < 24 * 60 || inHours) {
    const hours = Math.floor(total / 60);
    const rest = total % 60;

    if (long) {
      return rest ? `${hours} h ${rest} min` : `${hours} h`;
    }

    return rest ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${hours}h`;
  }

  const days = Math.floor(total / (24 * 60));
  return days === 1 ? "1 day" : `${days} days`;
};

// The same, from a start moment: duration(order.created_at) -> "1h 40m".
export const duration = (since, { now = Date.now(), long = false, hours = false } = {}) => {
  const date = toDate(since);
  return date ? durationMinutes((now - date.getTime()) / 60000, { long, hours }) : "";
};

// "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago", then "6 Sep".
export const relative = (value, { now = Date.now() } = {}) => {
  const date = toDate(value);

  if (!date) {
    return "";
  }

  const minutes = Math.floor((now - date.getTime()) / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;

  return dateShort(date, { now });
};
