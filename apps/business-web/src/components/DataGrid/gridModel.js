// The arithmetic behind DataGrid: what a column is, how a value reads, sorts,
// filters, totals and exports. No React and no DOM here, so every list in the
// app sorts a date, a rupee amount or "Table 10" against "Table 9" the same way.

import { money, moneyExact } from "@bmp/shared/format";
import { MONTH_NAMES } from "@bmp/shared/dates";

const TYPES = ["text", "number", "money", "percent", "date", "datetime", "status", "actions"];
const NUMERIC = new Set(["number", "money", "percent"]);
const DATES = new Set(["date", "datetime"]);

export const isNumeric = (column) => NUMERIC.has(column.type);

// "Table 9" before "Table 10", the way a person counts, in the app's locale.
const COLLATOR = new Intl.Collator("en-IN", { numeric: true });
const NUMBER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const WHOLE = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
// The same words dates.js's dayMonth writes ("23 Sep", "23 Sep 2025",
// "23 Sep, 4:10 pm"), with the clock formatter made once: dayMonth builds a
// new one per call, which on a 2,000-row list was most of a sort's time.
const CLOCK = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
let thisYear = new Date().getFullYear();
let yearCheckedAt = Date.now();

const currentYear = () => {
  if (Date.now() - yearCheckedAt > 60_000) {
    thisYear = new Date().getFullYear();
    yearCheckedAt = Date.now();
  }

  return thisYear;
};

export const isEmpty = (value) =>
  value === null || value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value));

// "partly_paid" → "Partly paid": a status as a word, not a code.
export const humanise = (value) => {
  const text = String(value ?? "").replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
};

// A date the way dates.js reads one: "2026-09-23" is that calendar day here,
// not midnight in Greenwich.
const toDate = (value) => {
  if (isEmpty(value)) {
    return null;
  }

  const text = String(value);
  const date =
    value instanceof Date ? value : /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00`) : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
};

const pad = (number) => String(number).padStart(2, "0");

// The calendar date in the browser's own clock, as a spreadsheet wants it.
const isoDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// One column definition, with every default filled in. Converters write only
// what differs from the usual; the grid reads only the finished shape.
const normalise = (column, currency) => {
  const type = TYPES.includes(column.type) ? column.type : "text";
  const actions = type === "actions";
  const key = String(column.key);

  return {
    ...column,
    key,
    type,
    // The words for the column menu, the phone card and the CSV heading
    // when the header itself is an icon or empty.
    label: column.label ?? (typeof column.header === "string" && column.header ? column.header : actions ? "Actions" : key),
    value: typeof column.value === "function" ? column.value : actions ? () => undefined : (row) => row?.[key],
    align: column.align || (NUMERIC.has(type) || actions ? "right" : "left"),
    sortable: !actions && column.sortable !== false,
    filter: column.filter === "text" || column.filter === "select" ? column.filter : "none",
    total: column.total === "sum" || column.total === "count" ? column.total : "none",
    searchable: column.searchable ?? (type === "text" || type === "status"),
    // The restaurant's own symbol: the column's, else the grid's, else ₹.
    currency: column.currency ?? currency,
  };
};

// The columns in the order they are drawn. A pinned column has to sit at the
// left edge to stay put while the rest scroll, so pinned ones move to the
// front. When no column says anything about pinning, the one that names the
// row (its phone-card title, else the first) is pinned: that is the column a
// reader needs while scrolling across a wide report.
export const normaliseColumns = (columns, { currency } = {}) => {
  const list = (columns || []).filter(Boolean).map((column) => normalise(column, currency));
  const named = list.find((column) => column.mobile === "title") || list.find((column) => column.type !== "actions");
  const anyPinSaid = list.some((column) => column.pin !== undefined);

  // Columns keep the order the page gave them. A pinned column has to sit at
  // the left edge to stay put, so instead of moving it there, every column
  // before it is pinned with it: a narrow "#" or date before a pinned name
  // stays first. (Moving the pinned one forward made the title jump ahead of
  // a narrow first column.) Without any pin, the first column is pinned —
  // and the title column with it when it comes second.
  const first = list.findIndex((column) => column.type !== "actions");
  const titleAt = list.indexOf(named);
  const lastPin = anyPinSaid
    ? list.reduce((at, column, index) => (column.pin === true ? index : at), -1)
    : first < 0
      ? -1
      : titleAt >= 0 && titleAt <= first + 1
        ? titleAt
        : first;

  // The row's actions (type "actions") stay at the RIGHT edge of a wide
  // table, so Edit / Collect / ⋯ never scroll out of reach. The last column
  // only, and not when the page says pin: false.
  const lastIndex = list.length - 1;
  const rightPin = lastIndex >= 0 && list[lastIndex].type === "actions" && list[lastIndex].pin !== false;

  list.forEach((column, index) => {
    const explicit = column.pin === true;
    column.pinRight = rightPin && index === lastIndex;
    column.pin = index <= lastPin && column.type !== "actions";
    column.isTitle = column === named;
    column.hideable = column.type !== "actions" && !explicit && !column.isTitle && column.hideable !== false;
  });

  return list;
};

// What a phone card shows: a heading, the lines under it, and the actions.
export const cardLayout = (columns) => {
  const content = columns.filter((column) => column.type !== "actions" && column.mobile !== "hide");
  const title = content.find((column) => column.mobile === "title") || content[0] || null;
  const subtitles = content.filter((column) => column !== title && column.mobile === "subtitle");
  const chosen = content.filter((column) => column !== title && column.mobile === "show");
  const show = chosen.length
    ? chosen
    : content.filter((column) => column !== title && !subtitles.includes(column)).slice(0, 4);
  const actions = columns.filter((column) => column.type === "actions" && column.mobile !== "hide");

  return { title, subtitles, show, actions };
};

// The text a value shows when the column has no render of its own.
export const formatValue = (column, value) => {
  if (isEmpty(value)) {
    return "";
  }

  switch (column.type) {
    case "money": {
      const number = Number(value);

      if (!Number.isFinite(number)) {
        return String(value);
      }

      const write = column.exact ? moneyExact : money;

      // A deduction reads "−₹3,868.40", the way an accountant writes it,
      // rather than "₹-3,868.40". (money() falls back to ₹ when the column
      // has no currency.)
      return number < 0 ? `−${write(-number, column.currency)}` : write(number, column.currency);
    }
    case "number": {
      const number = Number(value);
      return Number.isFinite(number) ? NUMBER.format(number) : String(value);
    }
    case "percent": {
      const number = Number(value);
      return Number.isFinite(number) ? `${NUMBER.format(number)}%` : String(value);
    }
    case "date":
    case "datetime": {
      const date = toDate(value);

      if (!date) {
        return String(value);
      }

      // The year only when it is not this one: "23 Sep" on a running list,
      // "23 Sep 2025" when it is last year's.
      const year = date.getFullYear() !== currentYear() ? ` ${date.getFullYear()}` : "";
      const day = `${date.getDate()} ${MONTH_NAMES[date.getMonth()]}${year}`;

      return column.type === "datetime" ? `${day}, ${CLOCK.format(date)}` : day;
    }
    case "status":
      return humanise(value);
    default:
      return String(value);
  }
};

// Sort keys: numbers as numbers, dates as moments, words as words. Blank is
// null, and blank always sorts last in either direction — an unpaid bill with
// no payment date should not lead a "newest first" list.
const sortKey = (column, value) => {
  if (isEmpty(value)) {
    return null;
  }

  if (NUMERIC.has(column.type)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  if (DATES.has(column.type)) {
    const date = toDate(value);
    return date ? date.getTime() : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return Number(value);
  }

  return String(value);
};

const compareKeys = (a, b) =>
  typeof a === "number" && typeof b === "number" ? a - b : COLLATOR.compare(String(a), String(b));

// Sorts prepared rows on one column. Keys are worked out once per row rather
// than inside the comparison, so two thousand rows sort in a few milliseconds.
export const sortPrepared = (prepared, column, index, direction) => {
  const flip = direction === "desc" ? -1 : 1;
  const keyed = prepared.map((item, order) => ({ item, order, key: sortKey(column, item.values[index]) }));

  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) {
      return a.key === b.key ? a.order - b.order : a.key === null ? 1 : -1;
    }

    return compareKeys(a.key, b.key) * flip || a.order - b.order;
  });

  return keyed.map((entry) => entry.item);
};

// The next sort after a click on a header: ascending, then descending, then
// back to the list's own order.
export const nextSort = (current, key) => {
  if (!current || current.key !== key) {
    return { key, direction: "asc" };
  }

  return current.direction === "asc" ? { key, direction: "desc" } : null;
};

// How the two directions read in the phone's "Sort by" list.
export const directionWords = (column, direction) => {
  if (NUMERIC.has(column.type)) {
    return direction === "asc" ? "low to high" : "high to low";
  }

  if (DATES.has(column.type)) {
    return direction === "asc" ? "oldest first" : "newest first";
  }

  return direction === "asc" ? "A to Z" : "Z to A";
};

// What a text filter or the search box looks through for one value: the raw
// value and the way it reads, so "120" and "₹120" both find ₹120.
export const searchText = (column, value) => {
  if (isEmpty(value)) {
    return "";
  }

  const shown = formatValue(column, value);
  const raw = String(value);

  return (shown === raw ? raw : `${raw} ${shown}`).toLowerCase();
};

// The choices for a select filter: the column's own list, or every value
// present, in reading order.
export const filterOptions = (column, index, prepared) => {
  if (Array.isArray(column.filterOptions)) {
    return column.filterOptions.map((option) =>
      typeof option === "object" && option !== null
        ? { value: String(option.value), label: String(option.label ?? option.value) }
        : { value: String(option), label: column.type === "status" ? humanise(option) : String(option) }
    );
  }

  const seen = new Map();

  for (const item of prepared) {
    const value = item.values[index];

    if (!isEmpty(value) && !seen.has(String(value))) {
      seen.set(String(value), formatValue(column, value));

      if (seen.size >= 200) {
        break;
      }
    }
  }

  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => COLLATOR.compare(a.label, b.label));
};

// Totals over every row that passed the filters, not only the page on show.
// Money is added in paise and quantities in ten-thousandths, so a column of
// ₹0.10s adds up to what the bill says rather than 0.30000000000000004.
export const computeTotals = (columns, prepared) => {
  const totals = {};

  columns.forEach((column, index) => {
    if (column.total === "none") {
      return;
    }

    if (column.total === "count") {
      totals[column.key] = prepared.reduce((sum, item) => sum + (isEmpty(item.values[index]) ? 0 : 1), 0);
      return;
    }

    const scale = column.type === "money" ? 100 : 10000;
    let sum = 0;

    for (const item of prepared) {
      const number = Number(item.values[index]);

      if (!isEmpty(item.values[index]) && Number.isFinite(number)) {
        sum += Math.round(number * scale);
      }
    }

    totals[column.key] = sum / scale;
  });

  return totals;
};

export const formatTotal = (column, total) => {
  if (total === undefined || total === null) {
    return "";
  }

  if (column.total === "count") {
    return WHOLE.format(total);
  }

  return column.type === "percent" ? `${NUMBER.format(total)}%` : formatValue(column, total);
};

// One CSV cell: money and quantities as plain numbers Excel can add up,
// dates as YYYY-MM-DD (and times as YYYY-MM-DD HH:MM), statuses as words.
export const csvValue = (column, value, row) => {
  if (typeof column.csv === "function") {
    return column.csv(row);
  }

  if (isEmpty(value)) {
    return "";
  }

  if (column.type === "money") {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : String(value);
  }

  if (column.type === "number" || column.type === "percent") {
    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
  }

  if (DATES.has(column.type)) {
    const date = toDate(value);

    if (!date) {
      return String(value);
    }

    return column.type === "date" ? isoDate(date) : `${isoDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  if (column.type === "status") {
    return humanise(value);
  }

  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

// A value function that throws on one odd row (a missing supplier, say)
// should cost that cell, not the whole screen.
export const readValue = (column, row) => {
  try {
    return column.value(row);
  } catch {
    return undefined;
  }
};

// Rows with every column's value worked out once, so sorting, filtering,
// totals and the export all read the same numbers.
export const prepareRows = (rows, columns, keyOf) =>
  (rows || []).map((row, index) => ({
    row,
    index,
    key: keyOf(row, index),
    values: columns.map((column) => (column.type === "actions" ? undefined : readValue(column, row))),
  }));
