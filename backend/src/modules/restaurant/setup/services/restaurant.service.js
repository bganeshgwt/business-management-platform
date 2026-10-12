const bcrypt = require("bcrypt");
const restaurantRepository = require("../repositories/restaurant.repository");
const AppError = require("../../../../utils/AppError");

const DEFAULT_OPEN = "10:00";
const DEFAULT_CLOSE = "23:00";

// PostgreSQL TIME comes back as "10:00:00"; the screens work in "10:00".
const toHourMinute = (time) => (time ? String(time).slice(0, 5) : null);

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  return restaurantId;
};

const getCurrentRestaurant = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const restaurant = await restaurantRepository.findById(restaurantId);

  if (!restaurant) {
    throw new AppError(404, "Restaurant not found");
  }

  return restaurant;
};

// The restaurant code is not editable: invoices and reports refer to it.
const updateCurrentRestaurant = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const updated = await restaurantRepository.update(restaurantId, data, userId);

  if (!updated) {
    throw new AppError(404, "Restaurant not found");
  }

  return updated;
};

const getSettings = async (restaurantId) => {
  requireRestaurantId(restaurantId);
  return restaurantRepository.findSettings(restaurantId);
};

// GST's limit on an invoice number, characters.
const INVOICE_NUMBER_MAX = 16;

// Numbers that restart each financial year carry the year (INV/26-27/00001),
// which leaves room for a series of at most FY_SERIES_MAX characters. Turning
// it on, or changing a prefix while it is on, is refused when the main
// counter's prefix or an outlet's own prefix is longer, naming which.
//
// numbering: the choice being saved (undefined: the one on file).
const checkNumbering = async (restaurantId, invoicePrefix, numbering) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const yearly = (numbering === undefined ? settings.invoice_numbering : numbering) === "financial_year";

  if (!yearly) {
    return;
  }

  const max = restaurantRepository.FY_SERIES_MAX;
  const tooLong = [];

  if (String(invoicePrefix || settings.invoice_prefix).length > max) {
    tooLong.push(`the main counter's "${invoicePrefix || settings.invoice_prefix}"`);
  }

  const { outlets } = await restaurantRepository.findInvoiceSeries(restaurantId);

  for (const outlet of outlets) {
    if (outlet.status === "active" && outlet.ownPrefix && outlet.ownPrefix.length > max) {
      tooLong.push(`${outlet.name}'s "${outlet.ownPrefix}"`);
    }
  }

  if (tooLong.length > 0) {
    throw new AppError(
      400,
      `With numbers that restart each year the year goes into the number (like INV/26-27/0001), so a prefix can be at most ${max} characters to stay within GST's 16. Shorten ${tooLong.join(" and ")} first.`
    );
  }
};

// The UPI ID, its payee name and the numbering choice; a key left undefined
// keeps what is on file.
const updateMoneySettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  if (Object.values(data).every((value) => value === undefined)) {
    return;
  }

  await restaurantRepository.updateMoneySettings(restaurantId, data, userId);
};

// The invoice series the restaurant prints — the main counter's and each
// outlet's — with what a bill number looks like in each, and which outlets
// share one numbering (two outlets whose series come out the same take turns
// on one counter, so no number is ever printed twice, but their numbers then
// interleave). A branch with a GSTIN of its own files its own return, so it
// should have a prefix of its own too.
const getInvoiceSeries = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const { restaurantPrefix, outlets, numbering, financialYear, mainSample, mainNext } =
    await restaurantRepository.findInvoiceSeries(restaurantId);
  const yearly = numbering === "financial_year";
  const rows = [
    {
      outletId: null,
      name: "Main counter",
      code: null,
      status: "active",
      ownPrefix: restaurantPrefix,
      series: restaurantPrefix,
      hasOwnGstin: false,
      sample: mainSample,
      next: mainNext,
    },
    ...outlets.map((row) => ({
      outletId: row.id,
      name: row.name,
      code: row.code,
      status: row.status,
      ownPrefix: row.ownPrefix,
      series: row.series,
      hasOwnGstin: row.hasOwnGstin,
      sample: row.sample,
      next: row.next,
    })),
  ];

  return rows.map((row) => {
    const sharedWith = rows
      .filter((other) => other !== row && other.series === row.series && other.status === "active")
      .map((other) => other.name);
    // Digits left for the number after "<series>-" (or, numbering by year,
    // after "<series>/26-27/"); bills print at least four.
    const digits = INVOICE_NUMBER_MAX - row.series.length - (yearly ? 7 : 1);
    const { sample, next, ...rest } = row;

    return {
      ...rest,
      numbering: numbering || "continuous",
      financialYear: yearly ? financialYear : null,
      derived: row.outletId !== null && !row.ownPrefix,
      example: sample,
      fits: digits >= 4,
      // The last bill the series can number within GST's 16 characters.
      lastNumber: digits >= 4 ? 10 ** digits - 1 : 0,
      sharedWith,
      // The number the next bill in this series gets, and how many it has
      // numbered so far (shared series count together).
      nextNumber: next ? next.nextNumber : null,
      issued: next ? next.issued : 0,
    };
  });
};

// "+05:30", "UTC+05:30", "GMT+5:30", "IST+5": an offset typed where a place
// name belongs.
const OFFSET_LIKE = /^(?:utc|gmt|ist)?\s*[+-]\s*\d{1,2}(?::?\d{2})?$/i;

// How far apart two words are (letters added, removed or changed), to offer
// "Did you mean Asia/Kolkata?" for a slip of the keyboard.
const distance = (a, b) => {
  const row = Array.from({ length: b.length + 1 }, (ignored, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }

  return row[b.length];
};

const offsetText = (seconds) => {
  const sign = seconds < 0 ? "-" : "+";
  const total = Math.abs(seconds) / 60;

  return `${sign}${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

// Time zones to pick from, as places with their offset: "(UTC+05:30) Asia/Kolkata".
const listTimezones = async () => {
  const rows = await restaurantRepository.findTimezones();

  return [
    { name: "UTC", offset: "+00:00", label: "(UTC+00:00) UTC" },
    ...rows.map((row) => {
      const offset = offsetText(Number(row.offset_seconds));
      return { name: row.name, offset, label: `(UTC${offset}) ${row.name.replace(/_/g, " ")}` };
    }),
  ];
};

// A time zone must be a place the database knows. Every order asks the
// database for the time there, so one wrong word here used to stop the till,
// and an offset like "UTC+05:30" was read with its sign backwards (POSIX) and
// moved the clock by eleven hours.
const readTimezone = async (value) => {
  const typed = String(value || "").trim();

  if (!typed) {
    throw new AppError(400, "Pick a time zone, such as Asia/Kolkata for India");
  }

  if (OFFSET_LIKE.test(typed) || /^(?:utc|gmt)[+-]/i.test(typed)) {
    throw new AppError(
      400,
      `"${typed}" is an offset, not a place. Pick the place whose clock you keep, such as Asia/Kolkata for India.`
    );
  }

  if (/^etc\//i.test(typed)) {
    throw new AppError(
      400,
      `"${typed}" counts its hours backwards and confuses people. Pick a place name instead, such as Asia/Kolkata for India.`
    );
  }

  const known = await restaurantRepository.findTimezone(typed);

  if (known) {
    return known;
  }

  const names = (await restaurantRepository.findTimezones()).map((row) => row.name);
  const close = names
    .map((name) => ({ name, gap: distance(typed.toLowerCase(), name.toLowerCase()) }))
    .filter((row) => row.gap <= 3)
    .sort((a, b) => a.gap - b.gap)[0];

  throw new AppError(
    400,
    close
      ? `"${typed}" is not a time zone the system knows. Did you mean ${close.name}?`
      : `"${typed}" is not a time zone name. Pick one from the list, such as Asia/Kolkata for India.`
  );
};

const updateSettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const timezone = await readTimezone(data.timezone);

  await restaurantRepository.updateSettings(restaurantId, { ...data, timezone }, userId);
  await restaurantRepository.updateDocumentSettings(restaurantId, data, userId);
  return restaurantRepository.findSettings(restaurantId);
};

// --- How much each role may take off a bill at the till -------------------------

const toLimit = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  custom: row.restaurant_id !== null,
  // null: no cap.
  maxPercent: row.max_percent === null ? null : Number(row.max_percent),
  people: row.people,
});

const getDiscountLimits = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  return { roles: (await restaurantRepository.findDiscountLimits(restaurantId)).map(toLimit) };
};

const saveDiscountLimits = async (restaurantId, limits, userId) => {
  requireRestaurantId(restaurantId);

  const roles = await restaurantRepository.findDiscountLimits(restaurantId);

  for (const limit of limits) {
    if (!roles.some((role) => Number(role.id) === Number(limit.roleId))) {
      throw new AppError(
        400,
        "That role cannot give discounts at all. Give it “Give an on-the-spot discount at the till” under Roles first."
      );
    }
  }

  const saved = await restaurantRepository.saveDiscountLimits(restaurantId, limits, userId);

  return { roles: saved.map(toLimit) };
};

// Always returns all seven days, using defaults for days never saved,
// so the screen can render a full week without special cases.
const getBusinessHours = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const saved = await restaurantRepository.findBusinessHours(restaurantId);
  const byDay = new Map(saved.map((row) => [row.day_of_week, row]));

  return Array.from({ length: 7 }, (unused, dayOfWeek) => {
    const row = byDay.get(dayOfWeek);

    return {
      dayOfWeek,
      isOpen: row ? row.is_open : true,
      openTime: row ? toHourMinute(row.open_time) : DEFAULT_OPEN,
      closeTime: row ? toHourMinute(row.close_time) : DEFAULT_CLOSE,
      periods: row && Array.isArray(row.periods) && row.periods.length
        ? row.periods
        : [{ openTime: row ? toHourMinute(row.open_time) : DEFAULT_OPEN, closeTime: row ? toHourMinute(row.close_time) : DEFAULT_CLOSE }],
    };
  });
};

const updateBusinessHours = async (restaurantId, days, userId) => {
  requireRestaurantId(restaurantId);

  const rows = await restaurantRepository.replaceBusinessHours(restaurantId, days, userId);

  return rows.map((row) => ({
    dayOfWeek: row.day_of_week,
    isOpen: row.is_open,
    openTime: toHourMinute(row.open_time),
    closeTime: toHourMinute(row.close_time),
    periods: row.periods || [],
  }));
};

// --- A new restaurant ------------------------------------------------------------

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,9}$/;
// An invoice number may hold only letters, digits, - and / (GST).
const INVOICE_PREFIX = /^[A-Z0-9][A-Z0-9/-]{0,9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Creates a restaurant with everything it starts with (GST rates first, the
// settings row, delivery channels, the kitchen's catch-all station) and its
// first admin — the supported way to add a restaurant, used by
// scripts/create-restaurant.js. Every input is checked before anything is
// written, and the whole thing is one transaction.
//
// data: { name, code, contact, email, address, timezone, invoicePrefix,
//         orderPrefix, admin: { name, email, mobile, password } }
const createRestaurant = async (data) => {
  const name = String(data.name || "").trim();
  const code = String(data.code || "").trim().toUpperCase();

  if (!name || name.length > 150) {
    throw new AppError(400, "Give the restaurant a name (up to 150 letters)");
  }

  if (!CODE.test(code)) {
    throw new AppError(400, "The restaurant code is 2 to 30 letters or digits, like ABC001");
  }

  const invoicePrefix = String(data.invoicePrefix || "INV").trim().toUpperCase();
  const orderPrefix = String(data.orderPrefix || "ORD").trim().toUpperCase();

  if (!INVOICE_PREFIX.test(invoicePrefix) || !PREFIX.test(orderPrefix)) {
    throw new AppError(400, "Bill and order prefixes are up to 10 letters or digits (a bill prefix may also use - and /), like INV");
  }

  const timezone = await readTimezone(data.timezone || "Asia/Kolkata");
  let admin = null;

  if (data.admin) {
    const adminName = String(data.admin.name || "").trim();
    const email = String(data.admin.email || "").trim().toLowerCase();
    const password = String(data.admin.password || "");

    if (!adminName) {
      throw new AppError(400, "Give the admin's full name");
    }

    if (!EMAIL.test(email)) {
      throw new AppError(400, "Give the admin's email address, like owner@restaurant.in");
    }

    if (password.length < 8 || password.length > 72) {
      throw new AppError(400, "The admin's password must be 8 to 72 characters");
    }

    admin = {
      name: adminName,
      email,
      mobile: data.admin.mobile ? String(data.admin.mobile).trim() : null,
      passwordHash: await bcrypt.hash(password, 12),
    };
  }

  const result = await restaurantRepository.createRestaurant({
    name,
    code,
    contact: data.contact ? String(data.contact).trim().slice(0, 20) : null,
    email: data.email ? String(data.email).trim() : null,
    address: data.address ? String(data.address).trim() : null,
    timezone,
    invoicePrefix,
    orderPrefix,
    admin,
  });

  if (result.error === "CODE_TAKEN") {
    throw new AppError(409, `A restaurant with code ${code} already exists`);
  }

  if (result.error === "EMAIL_TAKEN") {
    throw new AppError(409, `A user with the email ${admin.email} already exists`);
  }

  return {
    id: result.id,
    adminId: result.adminId,
    code,
    name,
    defaults: await restaurantRepository.countDefaults(result.id),
  };
};

module.exports = {
  createRestaurant,
  getCurrentRestaurant,
  updateCurrentRestaurant,
  getSettings,
  updateSettings,
  getInvoiceSeries,
  checkNumbering,
  updateMoneySettings,
  listTimezones,
  readTimezone,
  getDiscountLimits,
  saveDiscountLimits,
  getBusinessHours,
  updateBusinessHours,
};
