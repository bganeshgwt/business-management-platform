// Shared bill rules: inclusive pricing of a line, service charge types, the business date, outlet scope and account limits.
// Part of bill.service.js, which re-exports these for its callers.

const billRepository = require("../../repositories/bill.repository");
const businessDayRepository = require("../../../business-day/repositories/businessDay.repository");
const AppError = require("../../../../../utils/AppError");
const { round2 } = require("../../../../../utils/money");
const { n } = require("./shape");

// Whether a line's price already had its tax in it (read off the line itself,
// as the order does, so a later change to the setting cannot re-price it).
const isInclusive = (row) => {
  if (row.price_includes_tax !== null && row.price_includes_tax !== undefined) return row.price_includes_tax;
  const unit = round2(n(row.unit_price) + n(row.modifier_total));
  const quantity = n(row.order_quantity ?? row.quantity);

  return n(row.tax_percentage) > 0 && Math.abs(n(row.order_line_total ?? row.line_total) - round2(unit * quantity)) < 0.005;
};

// A line of the order, for the quantity this bill covers.
const billedLine = (row, quantity) => {
  const orderQuantity = n(row.order_quantity ?? row.quantity);
  const share = orderQuantity > 0 ? quantity / orderQuantity : 0;

  return {
    orderItemId: Number(row.order_item_id ?? row.id),
    quantity,
    lineSubtotal: round2(n(row.order_line_subtotal ?? row.line_subtotal) * share),
    lineTax: round2(n(row.order_line_tax ?? row.line_tax) * share),
    lineTotal: round2(n(row.order_line_total ?? row.line_total) * share),
    taxPercentage: n(row.tax_percentage),
    cessPercentage: n(row.cess_percentage),
    inclusive: isInclusive(row),
    hsnCode: row.hsn_code || null,
    productId: row.product_id ? Number(row.product_id) : null,
    categoryId: row.category_id ? Number(row.category_id) : null,
    itemName: row.item_name || null,
  };
};

const serviceChargeTypes = (settings) =>
  Array.isArray(settings.service_charge_order_types) ? settings.service_charge_order_types : ["dine_in"];

// The business date money and coupons are read against: the open day's, else
// today in the restaurant's own timezone.
const businessDateOf = async (restaurantId, settings, db = undefined) => {
  const day = await businessDayRepository.findOpen(restaurantId, undefined, db);

  if (day) {
    return { day, date: day.business_date };
  }

  let date;

  try {
    date = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone || "Asia/Kolkata" }).format(new Date());
  } catch {
    date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  }

  return { day: null, date };
};

const outletOf = (ctx) => (ctx && ctx.outletPinned ? ctx.outletId : null);

const rupeesText = (value) => `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// A bill on a guest's or company's account may not come to owe more than the
// account's limit allows (billRepository.accountRoom): the refusal says what
// it would come to and what can be done instead.
const overLimitError = (room, doing) =>
  new AppError(
    400,
    room.onHold
      ? `${room.name}'s account is on hold, so this bill cannot owe more on it. Take a payment for the difference first, or take the hold off under Dues & accounts.`
      : `${doing} would put ${rupeesText(room.owed + room.due)} on ${room.name}'s account, over its ${rupeesText(room.limit)} limit${
          room.owed > 0 ? ` (${rupeesText(room.owed)} is owed on its other bills)` : ""
        }. Take a payment for the difference first, take the bill off the account, or raise the limit under Dues & accounts.`,
    { reason: "credit_limit", outstanding: room.owed, limit: room.limit, due: room.due }
  );

// Checked before anyone is asked for a PIN (the check is made again, with
// the account locked, when the change is written).
// db: the client of a transaction already open, else the pool.
const requireAccountRoom = async (restaurantId, bill, owesAfter, doing, db = null) => {
  if (!bill.account_customer_id) {
    return;
  }

  const before = billRepository.dueAt(bill, bill.total_amount);

  if (owesAfter <= before + 0.009) {
    return;
  }

  const room = db
    ? await billRepository.accountRoom(db, restaurantId, bill.account_customer_id, bill.id, owesAfter)
    : await billRepository.accountRoomNow(restaurantId, bill.account_customer_id, bill.id, owesAfter);

  if (!room.fits) {
    throw overLimitError(room, doing);
  }
};

module.exports = {
  billedLine,
  serviceChargeTypes,
  businessDateOf,
  outletOf,
  rupeesText,
  overLimitError,
  requireAccountRoom,
};
