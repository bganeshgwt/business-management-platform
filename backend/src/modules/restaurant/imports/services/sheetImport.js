const crypto = require("crypto");
const AppError = require("../../../../utils/AppError");

// What every spreadsheet import shares (stock items, suppliers, recipes, the
// guest book), with the same safety the menu import has:
//
//   * The browser reads the file and posts plain rows (heading -> cell).
//     Headings are matched ignoring case, spaces and punctuation, so
//     "Item Name", "item_name" and "ITEM NAME" are one column; a heading
//     nobody knows is listed as ignored, never guessed at.
//   * A check first (a dry run): every row planned, every problem listed by
//     row and column. Nothing is written while any problem is left.
//   * Only what the file says changes: a column left out, or an empty cell,
//     keeps what the record has.
//   * The whole file goes in or none of it does, and what goes in is what
//     was previewed: the preview's fingerprint is checked again on import,
//     and if the records moved in between, the import stops and asks for a
//     fresh check.
//   * Running the same file again changes nothing: matched records with the
//     same values are "unchanged", and one-off things (opening stock, opening
//     points) are only ever written once.

const MAX_ROWS = 2000;

// "Item Name" -> "itemname".
const normalise = (heading) => String(heading || "").toLowerCase().replace(/[^a-z0-9%]/g, "");

// Which column each heading of the file is, from the import's COLUMNS list:
// [{ key, aliases, need, help, example }]. Returns { byKey: heading for each
// key used, used: keys, ignored: headings }.
const resolveColumns = (rows, columns) => {
  const headings = new Set();

  for (const row of rows) {
    for (const heading of Object.keys(row || {})) {
      headings.add(heading);
    }
  }

  const byKey = {};
  const ignored = [];

  for (const heading of headings) {
    const key = normalise(heading);
    const column = columns.find((entry) => entry.aliases.includes(key));

    if (column && !byKey[column.key]) {
      byKey[column.key] = heading;
    } else if (!column && String(heading).trim()) {
      ignored.push(heading);
    }
  }

  return { byKey, used: Object.keys(byKey), ignored };
};

// The cells of one row by column key, trimmed; "" for a cell not given.
const cellsOf = (row, byKey) => {
  const cells = {};

  for (const [key, heading] of Object.entries(byKey)) {
    const value = row[heading];
    cells[key] = value === undefined || value === null ? "" : String(value).trim();
  }

  return cells;
};

// 1,200 / ₹1,200.50 / Rs. 250 / 12.5 -> a number, or an error sentence.
const parseNumber = (text, { min = 0, max = 9999999, integer = false, what = "a number" } = {}) => {
  const cleaned = String(text).replace(/₹|rs\.?|inr/gi, "").replace(/,/g, "").trim();

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { error: `"${text}" is not ${what}` };
  }

  const value = Number(cleaned);

  if (integer && !Number.isInteger(value)) {
    return { error: `"${text}" must be a whole number` };
  }

  if (value < min || value > max) {
    return { error: `"${text}" must be between ${min} and ${max.toLocaleString("en-IN")}` };
  }

  return { value };
};

const YES = ["yes", "y", "true", "1", "on", "active", "opted in", "optedin"];
const NO = ["no", "n", "false", "0", "off", "inactive", "opted out", "optedout"];

const parseYesNo = (text) => {
  const value = String(text).trim().toLowerCase();

  if (YES.includes(value)) {
    return { value: true };
  }

  if (NO.includes(value)) {
    return { value: false };
  }

  return { error: `"${text}" should be yes or no` };
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// A date as people type it in India: 25-12-1990, 25/12/1990, 25 Dec 1990,
// 1990-12-25. Day first — an Indian spreadsheet never means 12/25.
const parseDate = (text, { minYear = 1900, maxYear = 2100 } = {}) => {
  const value = String(text).trim();
  let year;
  let month;
  let day;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);

  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(value))) {
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[\s-]+([a-z]{3,9})[\s-,]+(\d{2,4})$/i.exec(value))) {
    day = Number(match[1]);
    month = MONTHS[match[2].toLowerCase().slice(0, match[2].toLowerCase() === "sept" ? 4 : 3)];
    year = Number(match[3]);
  } else {
    return { error: `"${text}" is not a date (write it like 25-12-1990)` };
  }

  if (year < 100) {
    year += year > 30 ? 1900 : 2000;
  }

  const at = new Date(Date.UTC(year, (month || 0) - 1, day));

  if (!month || at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return { error: `"${text}" is not a real date` };
  }

  if (year < minYear || year > maxYear) {
    return { error: `"${text}" is outside the dates this column takes` };
  }

  return { value: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
};

// The same plan always gives the same fingerprint; a record that changed in
// between gives another.
const fingerprintOf = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

const staleError = () =>
  new AppError(
    409,
    "Something in these records changed since the file was checked. Check the file again to see what it would do now. Nothing was imported.",
    { reason: "stale_preview" }
  );

const checkRows = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new AppError(400, "The file has no rows");
  }

  if (rows.length > MAX_ROWS) {
    throw new AppError(400, `That is more than ${MAX_ROWS.toLocaleString("en-IN")} rows. Split the file and import it in parts.`);
  }

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new AppError(400, "Each row must be a set of columns");
    }
  }
};

// The answer every import gives, from its planned rows:
// { ok, problems, rows, created, updated, unchanged, columns, fingerprint }
const summarise = (plan, columns) => {
  const created = plan.rows.filter((row) => row.action === "create").length;
  const updated = plan.rows.filter((row) => row.action === "update").length;

  return {
    ok: plan.problems.length === 0,
    problems: plan.problems,
    rows: plan.rows.map(({ write, ...shown }) => shown),
    created,
    updated,
    unchanged: plan.rows.filter((row) => row.action === "unchanged").length,
    columns: { used: columns.used, ignored: columns.ignored, headings: columns.byKey },
    fingerprint: fingerprintOf(plan.rows.map((row) => [row.line, row.action, row.key, row.changes, row.state || null])),
    ...(plan.extra || {}),
  };
};

// The sample sheet and column guide an import screen offers.
const guideOf = (columns, sample) => ({
  maxRows: MAX_ROWS,
  columns: columns.map(({ key, label, need, help, example }) => ({ key, label: label || key, need, help, example })),
  sample,
});

module.exports = {
  MAX_ROWS,
  normalise,
  resolveColumns,
  cellsOf,
  parseNumber,
  parseYesNo,
  parseDate,
  fingerprintOf,
  staleError,
  checkRows,
  summarise,
  guideOf,
};
