const AppError = require("../../../utils/AppError");
const v = require("../../../utils/validate");

// Words and checks the tasks services share.

const CATEGORIES = ["stock_check", "audit", "cleaning", "day_to_day", "hiring", "maintenance", "marketing", "opening_closing",
  "procurement", "production", "project_management", "food_safety", "health_safety", "others"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const SEVERITIES = ["low", "medium", "high", "critical"];
const TASK_STATUSES = ["todo", "in_progress", "done", "missed", "cancelled"];
const ISSUE_STATUSES = ["open", "in_progress", "resolved", "closed"];
const PROJECT_STATUSES = ["planning", "active", "on_hold", "completed", "cancelled"];
const ITEM_KINDS = ["section", "checkbox", "yes_no", "number", "text", "photo", "signature", "choice"];
const ASSIGN_MODES = ["people", "role", "on_shift", "unassigned"];
const FREQUENCIES = ["daily", "weekdays", "weekly", "monthly", "every_n_days", "per_shift"];

const fail = (status, message, data) => { throw new AppError(status, message, data); };
const id = (value, name = "Record") => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === "" ? null : v.requiredId(value, name));

const dateText = (value, name) => {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) fail(400, `${name} must be a date (YYYY-MM-DD)`);
  return text;
};
const timeText = (value, name) => {
  const text = String(value || "");
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(text)) fail(400, `${name} must be a time like 09:30`);
  return text.slice(0, 5);
};
// A moment: an ISO timestamp with its offset, as the browser sends it.
const momentText = (value, name) => {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) || Number.isNaN(Date.parse(text))) fail(400, `${name} must be a date and time`);
  return new Date(text).toISOString();
};

const category = (value, fallback = "day_to_day") => v.optionalEnum(value, "Category", CATEGORIES, fallback);

// YYYY-MM-DD arithmetic on plain calendar days (no time zone involved).
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayOfWeek = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const lastDayOfMonth = (day) => {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.getUTCDate();
};
// Today in the business's time zone.
const localToday = (timezone, now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

const page = (query) => {
  const limit = query.limit === undefined ? 25 : v.requiredId(query.limit, "Page size");
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) fail(400, "Invalid pagination");
  return { limit, offset };
};
const search = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null);

module.exports = {
  CATEGORIES, PRIORITIES, SEVERITIES, TASK_STATUSES, ISSUE_STATUSES, PROJECT_STATUSES, ITEM_KINDS, ASSIGN_MODES, FREQUENCIES,
  fail, id, optionalId, dateText, timeText, momentText, category, addDays, dayOfWeek, daysBetween, lastDayOfMonth, localToday, page, search, v,
};
