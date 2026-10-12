const timeclockService = require("../services/timeclock.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PIN_PATTERN = /^\d{4,6}$/;

// A real calendar date. The round trip catches 2026-02-30, which Date.parse
// quietly rolls over to 2 March and Postgres then refuses with a 500. The
// range keeps date maths (a day either side) inside four-digit years.
const readDate = (value, field, fallback = null) => {
  if (!value) {
    return fallback;
  }

  const real =
    typeof value === "string" &&
    DATE_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

  if (!real) {
    throw new AppError(400, `${field} must be a real date like 2026-09-24`);
  }

  if (value < "2000-01-01" || value > "2099-12-31") {
    throw new AppError(400, `${field} must be between 2000 and 2099`);
  }

  return value;
};

// Ids and counts are whole numbers. 1.5 or 1e30 would otherwise reach
// Postgres as a BIGINT or a LIMIT and come back as a 500.
const readWhole = (value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new AppError(400, `${field} must be a whole number`);
  }

  if (number < min || number > max) {
    throw new AppError(
      400,
      max === Number.MAX_SAFE_INTEGER
        ? `${field} must be a whole number of ${min} or more`
        : `${field} must be between ${min} and ${max}`
    );
  }

  return number;
};

const readId = (value, field) => readWhole(value, field);

// A PIN arrives as text so a leading zero survives ("0472" is not 472).
const readPin = (value, field = "PIN") => {
  if (value === undefined || value === null || value === "") {
    throw new AppError(400, `Enter the ${field}`);
  }

  if (typeof value !== "string" || !PIN_PATTERN.test(value)) {
    throw new AppError(400, `The ${field} must be 4 to 6 digits`);
  }

  return value;
};

// The kiosk names a person by the tile they tapped (employeeId) or by the
// code they typed (employeeCode) — one or the other.
const readWho = (body) => {
  if (body.employeeId !== undefined && body.employeeId !== null && body.employeeId !== "") {
    return { employeeId: readId(body.employeeId, "Employee"), employeeCode: null };
  }

  const code = v.optionalString(body.employeeCode, "Employee code", 30);

  if (!code) {
    throw new AppError(400, "Tap your name, or type your employee code");
  }

  return { employeeId: null, employeeCode: code };
};

// A wrong PIN that has just locked someone out is worth a line in the
// activity log: five misses in a row is either a forgotten PIN or someone
// trying theirs.
const auditLockout = (req, error) => {
  if (error instanceof AppError && error.details && error.details.justLocked) {
    logAction(req, "lock", "employee_pin", {
      id: error.details.employeeId,
      label: error.details.employeeName,
      details: { lockedUntil: error.details.lockedUntil },
    });
  }
};

const board = async (req, res) => {
  res.json({ success: true, data: await timeclockService.board(req.user.restaurantId) });
};

const verify = async (req, res) => {
  const body = req.body || {};
  const data = { ...readWho(body), pin: readPin(body.pin) };
  const result = await timeclockService.verify(req.user.restaurantId, data);

  if (!result.valid) {
    if (result.justLocked) {
      logAction(req, "lock", "employee_pin", {
        id: result.employee.id,
        label: result.employee.name,
        details: { lockedUntil: result.lockedUntil },
      });
    }

    const { justLocked, ...answer } = result;
    res.json({ success: true, message: result.message, data: { ...answer, locked: result.reason === "locked" || justLocked } });
    return;
  }

  res.json({ success: true, data: result });
};

// The tablet's photo with a punch, as a data address ("data:image/jpeg;
// base64,..."). Only a real JPEG, WebP or PNG under 150 KB is kept; anything
// else counts as "no photo" rather than stopping someone clocking in.
const PHOTO_LIMIT = 150 * 1024;
const SIGNATURES = {
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  "image/webp": (bytes) => bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP",
};

const readPhoto = (value) => {
  if (typeof value !== "string" || value.length > PHOTO_LIMIT * 1.4) {
    return null;
  }

  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);

  if (!match) {
    return null;
  }

  const image = Buffer.from(match[2], "base64");

  if (image.length < 100 || image.length > PHOTO_LIMIT || !SIGNATURES[match[1]](image)) {
    return null;
  }

  return { mimeType: match[1], image };
};

const punch = async (req, res) => {
  const body = req.body || {};
  const data = {
    ...readWho(body),
    pin: readPin(body.pin),
    action: v.requiredEnum(body.action, "Action", timeclockService.ACTIONS),
    photo: readPhoto(body.photo),
  };

  try {
    const result = await timeclockService.punch(req.user.restaurantId, data, req.user.id);

    res.status(201).json({ success: true, message: result.confirmation.message, data: result });
  } catch (error) {
    auditLockout(req, error);
    throw error;
  }
};

const day = async (req, res) => {
  // Left out, the service picks today on the restaurant's own clock.
  const date = readDate(req.query.date, "Date", null);

  res.json({ success: true, data: await timeclockService.day(req.user.restaurantId, date) });
};

const listPunches = async (req, res) => {
  const from = readDate(req.query.from, "From", null);
  const to = readDate(req.query.to, "To", from);

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  const filters = {
    from,
    to,
    employeeId: req.query.employeeId ? readId(req.query.employeeId, "Employee") : null,
    source: req.query.source ? v.requiredEnum(req.query.source, "Source", ["kiosk", "manager"]) : null,
    limit:
      req.query.limit === undefined || req.query.limit === ""
        ? 200
        : readWhole(req.query.limit, "Limit", { min: 1, max: 500 }),
  };

  res.json({ success: true, data: await timeclockService.listPunches(req.user.restaurantId, filters) });
};

// A manager's correction: always with a reason, because a punch typed in
// later is exactly the one someone will ask about on payday.
const addPunch = async (req, res) => {
  const body = req.body || {};
  const at = v.requiredString(body.at, "Time", 40);

  if (Number.isNaN(Date.parse(at))) {
    throw new AppError(400, "Time must be a date and time, like 2026-09-24T23:30:00+05:30");
  }

  if (!body.workDate) {
    throw new AppError(400, "Work date is required: the day the shift started");
  }

  const data = {
    employeeId: readId(body.employeeId, "Employee"),
    workDate: readDate(body.workDate, "Work date"),
    action: v.requiredEnum(body.action, "Action", timeclockService.ACTIONS),
    at,
    note: v.requiredString(body.note, "Reason", 200),
  };

  const result = await timeclockService.addPunch(req.user.restaurantId, data, req.user.id);

  logAction(req, "create", "attendance_punch", {
    id: result.punch.id,
    label: result.employee.name,
    details: { action: data.action, at: result.punch.at, workDate: data.workDate, reason: data.note },
  });

  res.status(201).json({ success: true, message: "Punch added and the day recalculated", data: result });
};

// Taking back a punch added by mistake: also with a reason, and the punch it
// removed is kept in full in the activity log.
const removePunch = async (req, res) => {
  const body = req.body || {};
  const punchId = readId(req.params.punchId, "Punch id");
  const reason = v.requiredString(body.reason, "Reason for removing it", 200);
  const result = await timeclockService.removePunch(req.user.restaurantId, punchId, req.user.id);

  logAction(req, "delete", "attendance_punch", {
    id: result.punch.id,
    label: result.employee.name,
    details: {
      action: result.punch.action,
      at: result.punch.at,
      workDate: result.punch.workDate,
      addedBecause: result.punch.note,
      reason,
    },
  });

  res.json({
    success: true,
    message: `${result.label} removed for ${result.employee.name}. ${
      result.dayCleared ? "No punches are left that day, so the day is cleared." : "Their day has been worked out again."
    }`,
    data: result,
  });
};

const listPins = async (req, res) => {
  res.json({ success: true, data: await timeclockService.listPins(req.user.restaurantId) });
};

const setPin = async (req, res) => {
  const body = req.body || {};
  const employeeId = readId(req.params.employeeId, "Employee id");
  const pin = readPin(body.pin);
  const confirmPin = readPin(body.confirmPin, "PIN again");

  if (pin !== confirmPin) {
    throw new AppError(400, "The two PINs do not match. Type the same PIN twice.");
  }

  const result = await timeclockService.setPin(req.user.restaurantId, employeeId, pin, req.user.id);

  logAction(req, result.hadPin ? "reset" : "create", "employee_pin", {
    id: result.employeeId,
    label: result.name,
  });

  res.json({
    success: true,
    message: `${result.hadPin ? "New PIN saved" : "PIN set"} for ${result.name}`,
    data: { employeeId: result.employeeId },
  });
};

const removePin = async (req, res) => {
  const result = await timeclockService.removePin(
    req.user.restaurantId,
    readId(req.params.employeeId, "Employee id"),
    req.user.id
  );

  if (result.hadPin) {
    logAction(req, "delete", "employee_pin", { id: result.employeeId, label: result.name });
  }

  res.json({
    success: true,
    message: result.hadPin ? `PIN removed for ${result.name}` : `${result.name} had no PIN to remove`,
    data: { employeeId: result.employeeId, hadPin: result.hadPin },
  });
};

const unlockPin = async (req, res) => {
  const result = await timeclockService.unlockPin(
    req.user.restaurantId,
    readId(req.params.employeeId, "Employee id")
  );

  logAction(req, "unlock", "employee_pin", { id: result.employeeId, label: result.name });

  res.json({ success: true, message: `${result.name} can use their PIN again`, data: { employeeId: result.employeeId } });
};

// --- Punch photos ---

const getSettings = async (req, res) => {
  res.json({ success: true, data: await timeclockService.getSettings(req.user.restaurantId) });
};

const saveSettings = async (req, res) => {
  const body = req.body || {};
  const { before, after } = await timeclockService.saveSettings(
    req.user.restaurantId,
    {
      punchPhotos: v.requiredBoolean(body.punchPhotos, "Take a photo at each punch", false),
      photoKeepDays: v.optionalNumber(body.photoKeepDays, "Keep photos for (days)", { min: 1, max: 365 }) ?? 60,
    },
    req.user.id
  );

  logAction(req, "update", "timeclock_settings", {
    label: "Punch photos",
    details: { changes: { punchPhotos: [before.punchPhotos, after.punchPhotos], photoKeepDays: [before.photoKeepDays, after.photoKeepDays] } },
  });

  res.json({
    success: true,
    message: after.punchPhotos
      ? `Saved. The tablet takes a photo at each punch; photos are deleted after ${after.photoKeepDays} days.`
      : "Saved. The tablet no longer takes photos.",
    data: after,
  });
};

// The picture itself, only for managers, never cached by a shared browser.
const photo = async (req, res) => {
  const punchId = readId(req.params.punchId, "Punch id");
  const result = await timeclockService.getPhoto(req.user.restaurantId, punchId);

  res.set("Content-Type", result.mimeType);
  res.set("Cache-Control", "private, no-store");
  res.send(result.image);
};

module.exports = {
  getSettings,
  saveSettings,
  photo,
  board,
  verify,
  punch,
  day,
  listPunches,
  addPunch,
  removePunch,
  listPins,
  setPin,
  removePin,
  unlockPin,
};
