const priceWindowService = require("../services/priceWindow.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// An id is a whole number, or nothing: 1.5 used to reach the database and
// come back as a server error.
const optionalId = (value, field) =>
  value === undefined || value === null || value === "" ? null : v.requiredId(value, field);

const readTime = (value, field) => {
  const text = v.requiredString(value, field, 5);

  if (!TIME_PATTERN.test(text)) {
    throw new AppError(400, `${field} must look like 16:00`);
  }

  return text;
};

const readDate = (value, field) => {
  if (!value) {
    return null;
  }

  const text = String(value).trim();

  if (!DATE_PATTERN.test(text)) {
    throw new AppError(400, `${field} must look like 2026-09-19`);
  }

  return text;
};

const readBody = (body = {}) => {
  const days = v.requiredArray(body.daysOfWeek, "Days").map((day) => {
    const number = v.requiredNumber(day, "Day", { min: 0, max: 6 });
    return Math.round(number);
  });

  if (days.length === 0) {
    throw new AppError(400, "Choose at least one day of the week");
  }

  // Sending Monday twice would make the window match twice for no reason.
  const unique = [...new Set(days)];

  return {
    outletId: optionalId(body.outletId, "Outlet"),
    name: v.requiredString(body.name, "Name", 80),
    daysOfWeek: unique,
    startTime: readTime(body.startTime, "Start time"),
    endTime: readTime(body.endTime, "End time"),
    validFrom: readDate(body.validFrom, "Valid from"),
    validTo: readDate(body.validTo, "Valid to"),
    priority: v.optionalNumber(body.priority, "Priority", { min: 0, max: 999 }) ?? 0,
    status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
  };
};

const list = async (req, res) => {
  const filters = {
    status: req.query.status
      ? v.requiredEnum(req.query.status, "Status", ["active", "inactive"])
      : null,
  };

  res.json({ success: true, data: await priceWindowService.list(req.user.restaurantId, filters) });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "Price window id");

  res.json({ success: true, data: await priceWindowService.getById(req.user.restaurantId, id) });
};

const create = async (req, res) => {
  const data = readBody(req.body);

  if (data.startTime === data.endTime) {
    throw new AppError(400, "Start and end time cannot be the same");
  }

  const window = await priceWindowService.create(req.user.restaurantId, data, req.user.id);

  logAction(req, "create", "price_window", window);

  res.status(201).json({ success: true, message: "Price window added", data: window });
};

const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Price window id");
  const data = readBody(req.body);

  if (data.startTime === data.endTime) {
    throw new AppError(400, "Start and end time cannot be the same");
  }

  const window = await priceWindowService.update(req.user.restaurantId, id, data, req.user.id);

  logAction(req, "update", "price_window", window);

  res.json({ success: true, message: "Price window saved", data: window });
};

const remove = async (req, res) => {
  const id = v.requiredId(req.params.id, "Price window id");

  await priceWindowService.remove(req.user.restaurantId, id);

  logAction(req, "delete", "price_window", { id });

  res.json({ success: true, message: "Price window deleted" });
};

// The dish list is posted whole, like a combo's parts.
const setItems = async (req, res) => {
  const id = v.requiredId(req.params.id, "Price window id");
  const body = req.body || {};

  const items = v.requiredArray(body.items, "Items").map((item) => ({
    productId: v.requiredId(item.productId, "Dish"),
    productVariantId: optionalId(item.productVariantId, "Size"),
    price: v.requiredNumber(item.price, "Price", { min: 0, max: 9999999 }),
  }));

  const window = await priceWindowService.setItems(
    req.user.restaurantId,
    id,
    items,
    req.user.id
  );

  logAction(req, "update", "price_window_items", { id, details: { items: items.length } });

  res.json({ success: true, message: "Prices saved", data: window });
};

module.exports = { list, getById, create, update, remove, setItems };
