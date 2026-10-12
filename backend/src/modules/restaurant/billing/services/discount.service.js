const discountRepository = require("../repositories/discount.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const tradingDay = require("../../business-day/services/tradingDay");
const { DISCOUNT_REASONS, COMPLIMENTARY_REASONS } = require("./bill.service");
const AppError = require("../../../../utils/AppError");

const DUPLICATE = "23505";

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// Dates arrive as plain "YYYY-MM-DD" text (see config/database.js).
const toDiscount = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  discountType: row.discount_type,
  value: Number(row.value),
  maxDiscountAmount: row.max_discount_amount === null ? null : Number(row.max_discount_amount),
  minOrderAmount: Number(row.min_order_amount),
  validFrom: row.valid_from,
  validTo: row.valid_to,
  usageLimit: row.usage_limit,
  usedCount: row.used_count,
  appliesTo: row.applies_to,
  status: row.status,
  // The rules (SW-B-17).
  offerType: row.offer_type || "discount",
  productIds: (row.product_ids || []).map(Number),
  categoryIds: (row.category_ids || []).map(Number),
  weekdays: (row.weekdays || []).map(Number),
  timeFrom: row.time_from || null,
  timeTo: row.time_to || null,
  oncePerGuest: Boolean(row.once_per_guest),
  buyQuantity: row.buy_quantity === null || row.buy_quantity === undefined ? null : Number(row.buy_quantity),
  getQuantity: row.get_quantity === null || row.get_quantity === undefined ? null : Number(row.get_quantity),
  getDiscountPercent:
    row.get_discount_percent === null || row.get_discount_percent === undefined ? null : Number(row.get_discount_percent),
  // What it has given so far, on bills not voided.
  billCount: row.bill_count === undefined ? undefined : Number(row.bill_count),
  discountGiven: row.discount_given === undefined ? undefined : Number(row.discount_given),
});

// Rules the database cannot express on its own.
const validate = (data) => {
  if (data.discountType === "percentage" && data.value > 100) {
    throw new AppError(400, "A percentage discount cannot be more than 100");
  }

  if (data.discountType === "amount" && data.maxDiscountAmount !== null) {
    throw new AppError(400, "A maximum discount only applies to percentage discounts");
  }

  if (data.validFrom && data.validTo && data.validTo < data.validFrom) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  if (Boolean(data.timeFrom) !== Boolean(data.timeTo)) {
    throw new AppError(400, "Give both the start and the end of the hours, or neither");
  }

  if (data.timeFrom && data.timeFrom === data.timeTo) {
    throw new AppError(400, "The hours start and end at the same time. Leave both empty for all day.");
  }

  if (data.offerType === "buy_get" && !(data.productIds.length || data.categoryIds.length)) {
    throw new AppError(400, "Pick the dishes or categories the buy-and-get offer is on");
  }
};

// Chosen dishes and categories must be this restaurant's own.
const checkMenu = async (restaurantId, data) => {
  const found = await discountRepository.findMenuNames(restaurantId, data.productIds, data.categoryIds);

  if (found.products.length !== new Set(data.productIds).size) {
    throw new AppError(400, "One of the chosen dishes was not found. Pick the dishes again.");
  }

  if (found.categories.length !== new Set(data.categoryIds).size) {
    throw new AppError(400, "One of the chosen categories was not found. Pick them again.");
  }
};

const list = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await discountRepository.findAll(restaurantId);
  return rows.map(toDiscount);
};

const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  validate(data);
  await checkMenu(restaurantId, data);

  try {
    return toDiscount(await discountRepository.create(restaurantId, data, userId));
  } catch (error) {
    if (error.code === DUPLICATE) {
      throw new AppError(409, `A discount with code "${data.code}" already exists`);
    }

    throw error;
  }
};

// The code stays fixed after creation: customers may already have it.
const update = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);
  validate(data);
  await checkMenu(restaurantId, data);

  const row = await discountRepository.update(restaurantId, id, data, userId);

  if (!row) {
    throw new AppError(404, "Discount not found");
  }

  return toDiscount(row);
};

// A used discount is kept for history and switched off instead of deleted.
const remove = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const existing = await discountRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Discount not found");
  }

  if (existing.used_count > 0) {
    throw new AppError(
      409,
      `This discount has been used ${existing.used_count} time(s). Set it to inactive instead.`
    );
  }

  await discountRepository.remove(restaurantId, id);
};

// What was given away at the till in a period — discounts on bills and
// dishes, and no-charge bills — with who gave it, who approved it and why,
// and the totals by reason and by person.
//
// With pageSize the bill-by-bill list comes a page at a time (25, 50 or 100),
// numbered by `total`; the totals by reason and person always cover the whole
// period.
const given = async (restaurantId, { from: fromAsked, to: toAsked, page = 1, pageSize = null, outletId = null }) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  // No dates: the business day the till is on (a night still open after
  // midnight keeps its own date), else today on the restaurant's clock — or
  // last night's until the cut-off hour, when that day was just closed.
  let from = fromAsked;
  let to = toAsked;

  if (!from || !to) {
    const open = await tradingDay.openDayOf(restaurantId, outletId);
    const trading = open ? open.business_date : await tradingDay.dateWithNoDayOpenAt(restaurantId, outletId || null, settings);

    from = from || to || trading;
    to = to || (from > trading ? from : trading);
  }
  const label = (kind, reason) =>
    reason ? (kind === "complimentary" ? COMPLIMENTARY_REASONS : DISCOUNT_REASONS)[reason] || reason : "No reason given";

  const [rows, totals] = await Promise.all([
    discountRepository.findGiven(restaurantId, {
      from,
      to,
      timezone: settings.timezone,
      outletId,
      ...(pageSize ? { limit: pageSize, offset: (Math.max(1, page) - 1) * pageSize } : {}),
    }),
    discountRepository.findGivenTotals(restaurantId, { from, to, timezone: settings.timezone, outletId }),
  ]);

  const summed = (grouping) =>
    totals
      .filter((row) => row.grouping === grouping)
      .map((row) => ({
        kind: row.kind,
        label: grouping === "reason" ? label(row.kind, row.label) : row.label,
        bills: row.bills,
        amount: Number(row.amount),
        approved: row.approved,
      }));

  const byReason = summed("reason");
  // Every given bill falls under exactly one reason, so these count the
  // whole period whatever page is on show.
  const total = byReason.reduce((sum, row) => sum + row.bills, 0);
  const approvedCount = byReason.reduce((sum, row) => sum + row.approved, 0);

  return {
    from,
    to,
    total,
    approvedCount,
    page: pageSize ? Math.max(1, page) : 1,
    pageSize: pageSize || null,
    totals: {
      discountBills: byReason.filter((row) => row.kind === "discount").reduce((s, row) => s + row.bills, 0),
      discountAmount: byReason.filter((row) => row.kind === "discount").reduce((s, row) => s + row.amount, 0),
      complimentaryBills: byReason.filter((row) => row.kind === "complimentary").reduce((s, row) => s + row.bills, 0),
      complimentaryAmount: byReason
        .filter((row) => row.kind === "complimentary")
        .reduce((s, row) => s + row.amount, 0),
    },
    byReason,
    byStaff: summed("staff"),
    items: rows.map((row) => ({
      billId: row.bill_id,
      billNumber: row.bill_number,
      orderNumber: row.order_number,
      orderType: row.order_type,
      tableNo: row.table_no,
      customerName: row.customer_name,
      businessDate: row.business_date,
      billedAt: row.billed_at,
      billStatus: row.bill_status,
      kind: row.kind,
      amount: Number(row.amount),
      subtotal: Number(row.subtotal),
      totalAmount: Number(row.total_amount),
      percent: Number(row.subtotal) > 0 ? Math.round((Number(row.amount) * 1000) / Number(row.subtotal)) / 10 : 0,
      manualDiscount: row.manual_discount_type
        ? { type: row.manual_discount_type, value: Number(row.manual_discount_value) }
        : null,
      itemDiscountAmount: Number(row.item_discount_amount),
      reason: row.reason,
      reasonLabel: label(row.kind, row.reason),
      note: row.note,
      givenBy: row.given_by,
      approvedBy: row.approved_by,
    })),
  };
};

module.exports = {
  given,
  list,
  create,
  update,
  remove,
};
