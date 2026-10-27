const AppError = require("./AppError");

// Small input checks shared by controllers. Each one throws AppError(400)
// with a message naming the field, so the frontend can show it directly.

const requiredString = (value, field, maxLength = 255) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(400, `${field} is required`);
  }

  const trimmed = value.trim();

  if (trimmed.length > maxLength) {
    throw new AppError(400, `${field} must be ${maxLength} characters or less`);
  }

  return trimmed;
};

// A box left blank, spaces and all, is not given: an optional phone typed as
// a space is no phone, never "Phone is required".
const optionalString = (value, field, maxLength = 255) => {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return null;
  }

  return requiredString(value, field, maxLength);
};

const requiredNumber = (value, field, { min = -Infinity, max = Infinity } = {}) => {
  const number = typeof value === "string" ? Number(value) : value;

  if (typeof number !== "number" || Number.isNaN(number)) {
    throw new AppError(400, `${field} must be a number`);
  }

  if (number < min || number > max) {
    // One-sided ranges read as a person would say them, never "and Infinity".
    const range =
      Number.isFinite(min) && Number.isFinite(max)
        ? `between ${min} and ${max}`
        : Number.isFinite(min)
          ? `${min} or more`
          : `${max} or less`;

    throw new AppError(400, `${field} must be ${range}`);
  }

  return number;
};

const optionalNumber = (value, field, options) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return requiredNumber(value, field, options);
};

// An id is a whole number the database can hold. 1.5 or 1e20 used to pass the
// number check and reach Postgres, which answered with a 500 in every module.
const requiredId = (value, field) => {
  const number = requiredNumber(value, field, { min: 1 });

  if (!Number.isSafeInteger(number)) {
    throw new AppError(400, `${field} must be a whole number`);
  }

  return number;
};

const requiredEnum = (value, field, allowed) => {
  if (!allowed.includes(value)) {
    throw new AppError(400, `${field} must be one of: ${allowed.join(", ")}`);
  }

  return value;
};

const optionalEnum = (value, field, allowed, fallback) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return requiredEnum(value, field, allowed);
};

const requiredBoolean = (value, field, fallback) => {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new AppError(400, `${field} must be true or false`);
  }

  return value;
};

const requiredEmail = (value, field = "Email") => {
  const email = requiredString(value, field, 150).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError(400, `${field} is not a valid email address`);
  }

  return email;
};

const requiredPassword = (value, field = "Password") => {
  if (typeof value !== "string" || value.length < 8 || value.length > 72) {
    throw new AppError(400, `${field} must be between 8 and 72 characters`);
  }

  return value;
};

// A query string may name several states at once — "unpaid,partial" is the
// money still to collect. Each one is checked, so a typo is still refused.
const enumList = (value, field, allowed) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return String(value)
    .split(",")
    .map((part) => requiredEnum(part.trim(), field, allowed));
};

const requiredArray = (value, field) => {
  if (!Array.isArray(value)) {
    throw new AppError(400, `${field} must be a list`);
  }

  return value;
};

module.exports = {
  enumList,
  requiredString,
  optionalString,
  requiredNumber,
  optionalNumber,
  requiredId,
  requiredEnum,
  optionalEnum,
  requiredBoolean,
  requiredEmail,
  requiredPassword,
  requiredArray,
};
