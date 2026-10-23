// Online table booking for guests. No login: anyone on the internet
// can send anything here, so every field is read strictly and refused in
// words a guest can act on.
const publicBookingService = require("../services/publicBooking.service");
const AppError = require("../../../../utils/AppError");
const { normaliseMobile, mobileProblem } = require("../../../../utils/phone");

const OCCASIONS = ["birthday", "anniversary", "business", "date_night", "other"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Nothing a guest reads may be cached on the way: "Request received" shown
// after the restaurant said yes is worse than nothing.
const noStore = (res) => res.set("Cache-Control", "no-store");

const readText = (value, field, maxLength, { required = false } = {}) => {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (required) {
      throw new AppError(400, `Please enter ${field.toLowerCase()}`);
    }

    return null;
  }

  if (typeof value !== "string") {
    throw new AppError(400, `${field} must be text`);
  }

  const text = value.trim().replace(/\s+/g, " ");

  if (text.length > maxLength) {
    throw new AppError(400, `${field} must be ${maxLength} characters or less`);
  }

  return text;
};

const readDate = (value) => {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new AppError(400, "Please pick a date");
  }

  const [year, month, day] = value.split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));

  if (year < 2000 || year > 2100 || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new AppError(400, "Please pick a real date");
  }

  return value;
};

const readTime = (value) => {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new AppError(400, "Please pick a time");
  }

  return value;
};

const readParty = (value) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;

  if (!Number.isInteger(number) || number < 1 || number > 50) {
    throw new AppError(400, "Please choose how many guests are coming");
  }

  return number;
};

// The guest book's one form of a mobile (utils/phone), so the per-mobile limit
// sees "+91 98765 43210" and "9876543210" as the same phone.
const readMobile = (value) => {
  const text = readText(value, "Your mobile number", 20, { required: true });
  const mobile = normaliseMobile(text);

  if (!mobile) {
    throw new AppError(400, `Mobile number ${mobileProblem(text) || "is not a mobile number"}. Enter 10 digits, like 98765 43210.`);
  }

  return mobile;
};

const readName = (value) => {
  const name = readText(value, "Your name", 80, { required: true });

  if (name.length < 2 || !/\p{L}/u.test(name)) {
    throw new AppError(400, "Please enter your name, so we know who to expect");
  }

  return name;
};

const readOccasion = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !OCCASIONS.includes(value)) {
    throw new AppError(400, "Please pick an occasion from the list");
  }

  return value;
};

const info = async (req, res) => {
  noStore(res);
  res.json({ success: true, data: await publicBookingService.info(req.params.token) });
};

const times = async (req, res) => {
  noStore(res);

  const date = readDate(req.query.date);
  const partySize = readParty(req.query.party);

  res.json({ success: true, data: await publicBookingService.times(req.params.token, date, partySize) });
};

const request = async (req, res) => {
  const body = req.body || {};

  // A field no person can see on the page. A form-filling bot fills it in.
  if (body.website) {
    throw new AppError(400, "Something went wrong sending your request. Please refresh the page and try again.");
  }

  const input = {
    date: readDate(body.date),
    startTime: readTime(body.time),
    partySize: readParty(body.partySize),
    guestName: readName(body.guestName),
    guestMobile: readMobile(body.guestMobile),
    occasion: readOccasion(body.occasion),
    specialRequests: readText(body.notes, "Your note", 300),
  };

  const booking = await publicBookingService.request(req.params.token, input);

  noStore(res);
  res.status(201).json({
    success: true,
    message: "Request sent. The restaurant will confirm it shortly — keep this page to see their answer.",
    data: booking,
  });
};

const status = async (req, res) => {
  noStore(res);
  res.json({ success: true, data: await publicBookingService.status(req.params.guestToken) });
};

const cancel = async (req, res) => {
  const booking = await publicBookingService.cancel(req.params.guestToken);

  noStore(res);
  res.json({ success: true, message: "Your booking is cancelled. Thank you for letting us know.", data: booking });
};

module.exports = { info, times, request, status, cancel };
