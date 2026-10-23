const discountService = require("../services/discount.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { readDate } = require("../../../../utils/calendarDate");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const optionalDate = (value, field) => {
  if (!value) {
    return null;
  }

  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new AppError(400, `${field} must be a date like 2026-09-18`);
  }

  return value;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const optionalTime = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !TIME.test(value.slice(0, 5))) {
    throw new AppError(400, `${field} must be a time like 16:00`);
  }

  return value.slice(0, 5);
};

const idList = (value, field) =>
  value === undefined || value === null ? [] : [...new Set(v.requiredArray(value, field).map((id) => v.requiredId(id, field)))];

// The offer's rules: which dishes, which days and hours, once per
// guest, and buy X get Y.
const readRules = (body = {}) => {
  const offerType = v.optionalEnum(body.offerType, "Offer type", ["discount", "buy_get"], "discount");
  const weekdays =
    body.weekdays === undefined || body.weekdays === null
      ? []
      : [...new Set(v.requiredArray(body.weekdays, "Days").map((day) => v.requiredNumber(day, "Day", { min: 0, max: 6 })))]
          .map(Math.trunc)
          .sort();

  const rules = {
    offerType,
    productIds: idList(body.productIds, "Dish"),
    categoryIds: idList(body.categoryIds, "Category"),
    // Every day of the week is the same as no limit.
    weekdays: weekdays.length === 7 ? [] : weekdays,
    timeFrom: optionalTime(body.timeFrom, "Start of the hours"),
    timeTo: optionalTime(body.timeTo, "End of the hours"),
    oncePerGuest: body.oncePerGuest === undefined ? false : v.requiredBoolean(body.oncePerGuest, "Once per guest", false),
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
  };

  if (offerType === "buy_get") {
    rules.buyQuantity = v.requiredNumber(body.buyQuantity, "Buy how many", { min: 1, max: 50 });
    rules.getQuantity = v.requiredNumber(body.getQuantity, "Get how many", { min: 1, max: 50 });
    rules.getDiscountPercent = v.requiredNumber(body.getDiscountPercent ?? 100, "Off the ones they get (%)", {
      min: 1,
      max: 100,
    });

    if (!Number.isInteger(rules.buyQuantity) || !Number.isInteger(rules.getQuantity)) {
      throw new AppError(400, "Buy and get are whole numbers of dishes");
    }
  }

  return rules;
};

const readBody = (body = {}) => {
  const rules = readRules(body);

  // Buy X get Y is a percentage off the dishes the guest gets (100: free).
  const offer = rules.offerType === "buy_get"
    ? { discountType: "percentage", value: rules.getDiscountPercent }
    : {
        discountType: v.requiredEnum(body.discountType, "Discount type", ["percentage", "amount"]),
        value: v.requiredNumber(body.value, "Value", { min: 0.01, max: 9999999 }),
      };

  return { ...readOffer(body), ...offer, ...rules };
};

const readOffer = (body = {}) => ({
  name: v.requiredString(body.name, "Offer name", 150),
  description: v.optionalString(body.description, "Description", 500),
  maxDiscountAmount: v.optionalNumber(body.maxDiscountAmount, "Maximum discount", {
    min: 0.01,
    max: 9999999,
  }),
  minOrderAmount: v.optionalNumber(body.minOrderAmount, "Minimum order amount", {
    min: 0,
    max: 9999999,
  }) ?? 0,
  validFrom: optionalDate(body.validFrom, "Valid from"),
  validTo: optionalDate(body.validTo, "Valid to"),
  usageLimit: v.optionalNumber(body.usageLimit, "Usage limit", { min: 1, max: 1000000 }),
  appliesTo: v.optionalEnum(
    body.appliesTo,
    "Applies to",
    ["all", "dine_in", "takeaway", "delivery", "online"],
    "all"
  ),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

const list = async (req, res) => {
  res.json({ success: true, data: await discountService.list(req.user.restaurantId) });
};

// Given away at the till in a period: ?from=YYYY-MM-DD&to=YYYY-MM-DD. With no
// dates, the business day the till is trading on (the open day, else today on
// the restaurant's clock): the list opens on today, older days are a date
// pick away. The dates used come back as from and to.
const given = async (req, res) => {
  const from = readDate(req.query.from, "From");
  const to = readDate(req.query.to, "To");

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  // Paging: ?page=2&pageSize=25 (25, 50 or 100 to a page).
  const pageSize = req.query.pageSize
    ? Number(v.requiredEnum(String(req.query.pageSize), "Page size", ["25", "50", "100"]))
    : req.query.page
      ? 25
      : null;
  const page = req.query.page ? v.requiredId(req.query.page, "Page") : 1;

  res.json({
    success: true,
    data: await discountService.given(req.user.restaurantId, { from, to, page, pageSize, outletId: req.outletId || null }),
  });
};

const create = async (req, res) => {
  const data = {
    ...readBody(req.body),
    code: v.requiredString(req.body?.code, "Code", 30).toUpperCase().replace(/\s+/g, ""),
  };

  const discount = await discountService.create(req.user.restaurantId, data, req.user.id);

  logAction(req, "create", "discount", {
    id: discount.id,
    label: discount.code,
    details: { type: discount.discountType, value: discount.value },
  });

  res.status(201).json({ success: true, message: "Offer created", data: discount });
};

// What an offer's change did, field by field: turning ₹30 off into ₹300 off
// is exactly what an owner reads the activity log to find.
const OFFER_FIELDS = [
  "name",
  "discountType",
  "value",
  "maxDiscountAmount",
  "minOrderAmount",
  "validFrom",
  "validTo",
  "usageLimit",
  "appliesTo",
  "status",
  "offerType",
  "productIds",
  "categoryIds",
  "weekdays",
  "timeFrom",
  "timeTo",
  "oncePerGuest",
  "buyQuantity",
  "getQuantity",
  "getDiscountPercent",
];

const findOffer = async (restaurantId, id) =>
  (await discountService.list(restaurantId)).find((offer) => Number(offer.id) === Number(id)) || null;

const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Discount id");
  const before = await findOffer(req.user.restaurantId, id);
  const discount = await discountService.update(
    req.user.restaurantId,
    id,
    readBody(req.body),
    req.user.id
  );

  logAction(req, "update", "discount", {
    id: discount.id,
    label: discount.code,
    details: { changes: diff(before, discount, OFFER_FIELDS) },
  });

  res.json({ success: true, message: "Offer updated", data: discount });
};

const remove = async (req, res) => {
  const id = v.requiredId(req.params.id, "Discount id");
  const before = await findOffer(req.user.restaurantId, id);

  await discountService.remove(req.user.restaurantId, id);

  logAction(req, "delete", "discount", {
    id,
    label: before ? before.code : null,
    details: before
      ? { type: before.discountType, value: before.value, usedCount: before.usedCount, status: before.status }
      : null,
  });

  res.json({ success: true, message: "Offer deleted" });
};

module.exports = {
  given,
  list,
  create,
  update,
  remove,
};
