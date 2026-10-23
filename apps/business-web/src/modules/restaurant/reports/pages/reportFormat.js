// Dates and ranges as the report screens say them. Kept apart from the pages
// so the same words appear on screen, on paper and in every export.
import { today } from "@bmp/shared/dates";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const parts = (value) => String(value).slice(0, 10).split("-").map(Number);

const weekdayOf = (value) => {
  const [year, month, day] = parts(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

// "19 Sep" — chart labels. Built by hand: some browsers spell it "Sept".
export const shortDate = (value) => {
  const [, month, day] = parts(value);
  return `${day} ${MONTHS[month - 1]}`;
};

// "Sat 19 Sep". The weekday earns its place: a restaurant wanting to know its
// best day usually means the day of the week, not the date.
export const dayAndDate = (value) => `${WEEKDAYS[weekdayOf(value)]} ${shortDate(value)}`;

// "19 Sep 2026"
export const fullDate = (value) => {
  const [year] = parts(value);
  return `${shortDate(value)} ${year}`;
};

// "23-Sep-2026": how the GST portal's offline tool writes an invoice date.
export const gstDate = (value) => {
  const [year, month, day] = parts(value);
  return `${String(day).padStart(2, "0")}-${MONTHS[month - 1]}-${year}`;
};

// The period a report covers, in words: "Wednesday 23 September 2026",
// "1 – 30 September 2026", "28 Aug – 3 Sep 2026".
export const periodLabel = (from, to) => {
  if (!from || !to) {
    return "";
  }

  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);

  if (from === to) {
    return `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekdayOf(from)]} ${fd} ${LONG_MONTHS[fm - 1]} ${fy}`;
  }

  if (fy === ty && fm === tm) {
    return `${fd} – ${td} ${LONG_MONTHS[fm - 1]} ${fy}`;
  }

  if (fy === ty) {
    return `${fd} ${MONTHS[fm - 1]} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  }

  return `${fullDate(from)} – ${fullDate(to)}`;
};

// A date moved by whole days or months, on the calendar (no clock involved).
const shift = (value, { days = 0, months = 0 } = {}) => {
  const [year, month, day] = parts(value);
  const date = new Date(Date.UTC(year, month - 1 + months, day + days));
  return date.toISOString().slice(0, 10);
};

const monthStartOf = (value) => `${String(value).slice(0, 7)}-01`;

const monthEndOf = (value) => shift(shift(monthStartOf(value), { months: 1 }), { days: -1 });

// The ranges worth one click on the reports. "Yesterday" is what a manager
// reads first thing in the morning; "Last month" is what the accountant files
// GST for. Everything counts from the business day the restaurant is trading
// on (anchor), not the calendar.
export const REPORT_RANGES = [
  { key: "today", label: "Today", range: (anchor) => ({ from: today(anchor), to: today(anchor) }) },
  {
    key: "yesterday",
    label: "Yesterday",
    range: (anchor) => {
      const day = shift(today(anchor), { days: -1 });
      return { from: day, to: day };
    },
  },
  { key: "7d", label: "Last 7 days", range: (anchor) => ({ from: shift(today(anchor), { days: -6 }), to: today(anchor) }) },
  { key: "30d", label: "Last 30 days", range: (anchor) => ({ from: shift(today(anchor), { days: -29 }), to: today(anchor) }) },
  { key: "month", label: "This month", range: (anchor) => ({ from: monthStartOf(today(anchor)), to: today(anchor) }) },
  {
    key: "lastMonth",
    label: "Last month",
    range: (anchor) => {
      const start = shift(monthStartOf(today(anchor)), { months: -1 });
      return { from: start, to: monthEndOf(start) };
    },
  },
];

export const matchingReportRange = (from, to, anchor) => {
  const found = REPORT_RANGES.find((option) => {
    const range = option.range(anchor);
    return range.from === from && range.to === to;
  });

  return found ? found.key : null;
};

// A moment on the restaurant's own clock: "24 Sep, 4:41 am". Every report
// says which timezone it was read in (Settings); a laptop in another city —
// or a browser left on the wrong zone — must not move a 4:41 am void to
// 5:41, beside a "busiest hours" chart that says 4am.
const clockFormats = new Map();

const clockFormat = (timeZone) => {
  const key = timeZone || "";

  if (!clockFormats.has(key)) {
    const options = { day: "numeric", month: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h12" };
    let format;

    try {
      format = new Intl.DateTimeFormat("en-GB", timeZone ? { ...options, timeZone } : options);
    } catch {
      format = new Intl.DateTimeFormat("en-GB", options);
    }

    clockFormats.set(key, format);
  }

  return clockFormats.get(key);
};

// Put together by hand from the parts, like shortDate: "25 Sep, 5:51 am",
// never the "Sept" some browsers write.
export const clockTime = (value, timeZone) => {
  if (!value) {
    return "—";
  }

  const parts = Object.fromEntries(
    clockFormat(timeZone)
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value])
  );
  const period = String(parts.dayPeriod || "").toLowerCase().includes("p") ? "pm" : "am";

  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]}, ${Number(parts.hour)}:${parts.minute} ${period}`;
};

// "25 Sep 2026, 10:14 am" for a printout's "Printed …" line, on the same clock.
export const printedAt = (timeZone) => {
  const now = new Date();
  const [date, time] = clockTime(now, timeZone).split(", ");
  let year;

  try {
    year = new Intl.DateTimeFormat("en-GB", timeZone ? { year: "numeric", timeZone } : { year: "numeric" }).format(now);
  } catch {
    year = String(now.getFullYear());
  }

  return `${date} ${year}, ${time}`;
};

// A plain number for a CSV cell: two decimals for money, so Excel sums it.
export const csvMoney = (value) => Number(Number(value || 0).toFixed(2));

// The lines every exported file starts with, so a sheet opened next month
// still says what it is.
export const csvHeader = (title, { from, to, outletName }) => [
  [title],
  ["Period", periodLabel(from, to), from, to],
  ["Outlet", outletName || "All outlets"],
  [],
];

// "1 bill", "12 bills", with the Indian grouping for big numbers.
export const plural = (number, one, many) =>
  `${Number(number || 0).toLocaleString("en-IN")} ${Number(number) === 1 ? one : many}`;

// Rates as the GST tables write them: 5 -> "5", 2.5 -> "2.5".
export const ratePercent = (value) => `${Number(value)}%`;

// A figure that can go either way (a round off, a variance): "−₹1.39", the
// sign before the rupee, never "₹-1.39". `format` is the page's own money
// helper (money or moneyExact), passed in so this file stays free of it.
export const signed = (value, format) => {
  const number = Number(value || 0);
  return number < 0 ? `−${format(-number)}` : format(number);
};
