// Coupons and loyalty points applied to a bill.
// Part of bill.service.js, which re-exports these for its callers.

const discountRepository = require("../../repositories/discount.repository");
const loyaltyService = require("../../../crm/services/loyalty.service");
const crmRepository = require("../../../crm/repositories/crm.repository");
const AppError = require("../../../../../utils/AppError");

// ------------------------------------------------------------------ checks

// Checks a coupon and returns it; the amount is worked out by the pricing.
// Its dates are read against the business day, so a coupon valid "until the
// 24th" still works at 00:30 while the 24th's day is open.
// A coupon already on the bill (its use already counted) is not checked again
// for being switched off, its dates, its days and hours, its usage limit or
// "once per guest": changing something else on the bill must not throw off a
// coupon the guest was already given — least of all because this very bill
// took its last use, or the happy hour ended while the guest was eating.
//
// The rules (SW-B-17) the coupon may carry, each refused in words the till
// can read out:
//   chosen dishes / categories   only those lines count and are discounted
//   weekdays                     by the business date's day of the week
//   hours                        by the restaurant's clock (may run past
//                                midnight)
//   once per guest               needs a guest on the order
//   buy X get Y                  needs X + Y of the chosen dishes
//
// lines: the bill's lines ({ orderItemId, quantity, productId, categoryId,
// itemName }). Returns the coupon with lineIds (a Set, or null for the whole
// bill) and buyGet for the pricing.
const resolveCoupon = async (
  restaurantId,
  code,
  {
    subtotal,
    orderType,
    businessDate,
    alreadyOnBill = null,
    lines = [],
    customerId = null,
    billId = null,
    timezone = null,
    db = undefined,
  }
) => {
  if (!code) {
    return null;
  }

  const discounts = await discountRepository.findAll(restaurantId, db);
  const discount = discounts.find((row) => row.code.toUpperCase() === code.trim().toUpperCase());

  if (!discount) {
    throw new AppError(400, `No offer found with code "${code}"`);
  }

  const kept = alreadyOnBill && Number(alreadyOnBill) === Number(discount.id);

  if (!kept && discount.status !== "active") {
    throw new AppError(400, "That offer is not active");
  }

  if (!kept && discount.valid_from && businessDate < discount.valid_from) {
    throw new AppError(400, `That offer starts on ${discount.valid_from}`);
  }

  if (!kept && discount.valid_to && businessDate > discount.valid_to) {
    throw new AppError(400, `That offer ended on ${discount.valid_to}`);
  }

  if (!kept && discount.usage_limit && discount.used_count >= discount.usage_limit) {
    throw new AppError(400, "That offer has reached its usage limit");
  }

  if (subtotal < Number(discount.min_order_amount)) {
    throw new AppError(400, `This offer needs a minimum order of ${discount.min_order_amount}`);
  }

  if (discount.applies_to !== "all" && discount.applies_to !== orderType) {
    throw new AppError(400, `That offer applies to ${discount.applies_to.replace("_", "-")} orders only`);
  }

  const weekdays = (discount.weekdays || []).map(Number);

  if (!kept && weekdays.length > 0 && businessDate) {
    const today = new Date(`${String(businessDate).slice(0, 10)}T00:00:00Z`).getUTCDay();

    if (!weekdays.includes(today)) {
      throw new AppError(400, `${discount.code} runs on ${weekdays.sort().map((day) => WEEKDAYS[day]).join(", ")} only`);
    }
  }

  if (!kept && discount.time_from && discount.time_to) {
    const now = clockOf(timezone);
    const from = discount.time_from.slice(0, 5);
    const to = discount.time_to.slice(0, 5);
    const open = from < to ? now >= from && now < to : now >= from || now < to;

    if (!open) {
      throw new AppError(400, `${discount.code} runs from ${hourText(from)} to ${hourText(to)} only (it is ${hourText(now)} now)`);
    }
  }

  if (!kept && discount.once_per_guest) {
    if (!customerId) {
      throw new AppError(400, `${discount.code} is once per guest. Attach the guest to the order first.`);
    }

    const earlier = await discountRepository.findGuestUse(restaurantId, discount.id, customerId, billId, db);

    if (earlier) {
      throw new AppError(400, `This guest has already used ${discount.code} (on ${earlier.bill_number}). It is once per guest.`);
    }
  }

  const productIds = (discount.product_ids || []).map(Number);
  const categoryIds = (discount.category_ids || []).map(Number);
  const scoped = productIds.length > 0 || categoryIds.length > 0;
  const eligible = scoped
    ? lines.filter(
        (line) => productIds.includes(Number(line.productId)) || categoryIds.includes(Number(line.categoryId))
      )
    : lines;

  if (scoped && eligible.length === 0) {
    throw new AppError(400, `${discount.code} is for chosen dishes only, and none of them is on this bill`);
  }

  let buyGet = null;

  if (discount.offer_type === "buy_get") {
    buyGet = {
      buy: Number(discount.buy_quantity),
      get: Number(discount.get_quantity),
      percent: Number(discount.get_discount_percent),
    };
    const units = eligible.reduce((sum, line) => sum + Math.floor(Number(line.quantity) + 1e-9), 0);

    if (units < buyGet.buy + buyGet.get) {
      throw new AppError(
        400,
        `${discount.code} is buy ${buyGet.buy} get ${buyGet.get}: the bill needs ${buyGet.buy + buyGet.get} of the offer's dishes (it has ${units})`
      );
    }
  }

  return {
    ...discount,
    lineIds: scoped ? new Set(eligible.map((line) => Number(line.orderItemId))) : null,
    buyGet,
  };
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The time on the restaurant's clock, as "HH:MM".
const clockOf = (timezone) => {
  const options = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: timezone || "Asia/Kolkata" }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "Asia/Kolkata" }).format(new Date());
  }
};

// "16:00" as the till says it: 4 pm, 4:30 pm, 12 noon.
const hourText = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;

  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${suffix}`;
};

// The coupon as the pricing takes it.
const couponForPricing = (coupon) =>
  coupon
    ? {
        discountType: coupon.discount_type,
        value: Number(coupon.value),
        maxDiscountAmount: coupon.max_discount_amount === null ? null : Number(coupon.max_discount_amount),
        lineIds: coupon.lineIds || null,
        buyGet: coupon.buyGet || null,
      }
    : null;

// How many points the guest may use on this bill: their balance, plus what
// this bill already holds of theirs when it is being re-priced.
// db: the pool, or the client of the transaction re-pricing the bill.
const resolveLoyalty = async (restaurantId, customerId, settings, requestedPoints, alreadyOnBill = 0, db = undefined) => {
  const pointValue = Number(settings.loyalty_point_value);

  if (!requestedPoints) {
    return null;
  }

  if (!settings.loyalty_enabled) {
    throw new AppError(403, "Loyalty points is switched off for this restaurant. An owner can switch it on in Settings → Features.", { reason: "feature_off", feature: "guest_loyalty" });
  }

  if (!customerId) {
    throw new AppError(400, "Attach the guest to the order before using their points");
  }

  // Points past their last day go first, so the balance checked (and the
  // number in the refusal) is what the guest really has.
  await loyaltyService.expireGuest(restaurantId, customerId, db || null);

  const customer = await crmRepository.findCustomerById(restaurantId, customerId, db);

  if (!customer) {
    throw new AppError(400, "That guest no longer exists");
  }

  const available = Number(customer.loyalty_points) + Number(alreadyOnBill || 0);

  if (requestedPoints > available) {
    throw new AppError(400, `${customer.name} has only ${available} points`);
  }

  if (requestedPoints < settings.loyalty_min_redeem) {
    throw new AppError(400, `At least ${settings.loyalty_min_redeem} points are needed to redeem`);
  }

  return { points: requestedPoints, pointValue };
};

module.exports = {
  resolveCoupon,
  couponForPricing,
  resolveLoyalty,
};
