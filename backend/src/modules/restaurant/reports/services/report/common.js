// Shared report helpers: numbers, money and count wording, covers.
// Part of report.service.js, which re-exports these for its callers.

const AppError = require("../../../../../utils/AppError");
const { round2 } = require("../../../../../utils/money");

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const num = (value) => Number(value || 0);

// Money inside a sentence: "₹12,850.50", "₹1,500" — the paise shown in full
// when there are any, never "₹12,850.5".
const rupeeText = (rupees) => {
  const value = Number(rupees || 0);
  const whole = Math.round(value * 100) % 100 === 0;

  // The sign before the rupee: "−₹1.39", never "₹-1.39".
  return `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};

// "1 bill", "12 bills" — sentences on the owner's screens are read on a
// restaurant's first day too, when most counts are 1.
const countOf = (count, one, many) =>
  `${Number(count || 0).toLocaleString("en-IN")} ${Number(count) === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Covers and per head — one definition for every screen
// ---------------------------------------------------------------------------

// See reportRepository.covers for what counts. Per head is the dine-in bills
// that had a guest count, divided by those guests.
const coverFigures = (row) => {
  const covers = row ? num(row.covers) : 0;
  const coveredSales = row ? num(row.covered_sales) : 0;

  return {
    covers,
    perHead: covers > 0 ? round2(coveredSales / covers) : 0,
    dineInOrders: row ? num(row.dine_in_orders) : 0,
    dineInSales: row ? round2(num(row.dine_in_sales)) : 0,
    // Dine-in bills with no guest count take no part in per head. Said out
    // loud, because a floor that never records covers gets no per head at all.
    dineInWithoutGuests: row ? num(row.without_guests) : 0,
  };
};

module.exports = {
  requireRestaurantId,
  num,
  rupeeText,
  countOf,
  coverFigures,
};
