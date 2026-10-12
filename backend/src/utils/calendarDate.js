const AppError = require("./AppError");

// Dates typed as YYYY-MM-DD for the stock and purchasing screens.
//
// The shape alone is not enough: JavaScript quietly turns 2026-02-30 into
// 2 March, and PostgreSQL refuses it with "date/time field value out of
// range", which reached people as "Internal server error". A date here must
// be one that is really on the calendar.
const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const isCalendarDate = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  const match = PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(Date.UTC(year, month - 1, day));

  // Any year a restaurant's books could hold; 0001 or 9999 is a typing slip.
  return (
    year >= 2000 &&
    year <= 2100 &&
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day
  );
};

// A date from a query string or body: missing gives the fallback, anything
// else must be a real calendar date.
const readDate = (value, field, fallback = null) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (!isCalendarDate(value)) {
    throw new AppError(400, `${field} must be a real date like 2026-09-24`);
  }

  return value;
};

// A moment (ISO date and time). The date part, when written out, must be a
// real calendar date for the same reason as above.
const readMoment = (value, field) => {
  const text = typeof value === "string" ? value : "";
  const at = new Date(text);

  if (!text || Number.isNaN(at.getTime()) || (PATTERN.test(text.slice(0, 10)) && !isCalendarDate(text.slice(0, 10)))) {
    throw new AppError(400, `${field} must be a date and time`);
  }

  return at;
};

module.exports = { isCalendarDate, readDate, readMoment };
