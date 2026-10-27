// An order for pickup's money, as the screens show it before the server
// works it out (businessWeightDaily.service.js): plain functions, in rupees
// rounded to the paisa.

const paise = (value) => Math.round(Number(value || 0) * 100);

// What an order comes to at today's rates, the most its advance may be: each
// weight at its item's shelf price (GST included, as the counter shows it),
// each "₹ worth" as it is. lines: [{ quantity, amount, price, taxRate }].
// The bill weighs it again at pickup.
export function orderEstimate(lines, taxMode = "exclusive") {
  const total = (lines || []).reduce((sum, line) => {
    if (Number(line.amount) > 0) return sum + paise(line.amount);
    const shelf = taxMode === "inclusive" ? Number(line.price || 0) : Number(line.price || 0) * (1 + Number(line.taxRate || 0) / 100);
    return sum + Math.round(Number(line.quantity || 0) * shelf * 100);
  }, 0);
  return Math.max(0, Math.ceil(total / 100 - 1e-9));
}

// What Quick bill takes for an order's bill: its advance pays after any
// credit voucher, up to what is left of the bill. { fromAdvance, toPay }.
export function advanceOnBill(total, fromVoucher, advanceLeft) {
  const rest = Math.max(0, paise(total) - paise(fromVoucher));
  const fromAdvance = Math.min(rest, Math.max(0, paise(advanceLeft)));
  return { fromAdvance: fromAdvance / 100, toPay: (rest - fromAdvance) / 100 };
}
