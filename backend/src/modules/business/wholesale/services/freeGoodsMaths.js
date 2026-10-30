// Free goods that came with paid goods on a wholesale invoice (a scheme's, or
// given by hand), on a return of the paid goods. The owner's rule: free goods
// the customer keeps come off the credit. Pure arithmetic in integer
// thousandths of a unit and in paise, so the database check
// (wholesale_free_goods_kept) and this agree to the unit.
//
//   belongs   the free goods that belong to the paid goods returned so far:
//             free × paid returned ÷ paid bought, in the free goods' unit to
//             the thousandth (as the core keeps quantities), half away from
//             zero. What comes back is in the unit's own steps (whole for a
//             count unit), so a part of a unit that belongs is kept.
//   kept      what belongs and did not come back: never below nothing, never
//             more than belongs. Free goods brought back after being kept
//             give back what keeping them cost.
//   value     what is kept so far, at one unit's value before GST, to the
//             paisa, with GST at the paid line's rate: worked out on the whole
//             kept so far, so a part kept and later given back nets to nothing.

// numerator / denominator rounded half away from zero (non-negative BigInts).
const half = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);
const signedHalf = (numerator, denominator) => (numerator < 0n ? -half(-numerator, denominator) : half(numerator, denominator));

// Thousandths of the free goods' unit; `decimals`: the places it is rounded to
// (3, the core's precision, unless asked otherwise).
function belongs(freeMilli, paidReturnedMilli, paidMilli, decimals = 3) {
  if (paidMilli <= 0 || freeMilli <= 0 || paidReturnedMilli <= 0) return 0;
  const step = 10n ** BigInt(3 - Math.max(0, Math.min(3, decimals)));
  return Number(half(BigInt(freeMilli) * BigInt(Math.min(paidReturnedMilli, paidMilli)), BigInt(paidMilli) * step) * step);
}

// What is kept of what belongs, after what came back (thousandths).
const keptOf = (belongsMilli, backMilli) => Math.max(0, belongsMilli - backMilli);

// A unit's value: `net` paise for `milli` thousandths of the unit (the paid
// lines' own value for their quantity, for free goods of the same item).
// The value of `quantityMilli` of it, in paise.
const valueOf = (quantityMilli, price) => Number(signedHalf(BigInt(quantityMilli) * BigInt(price.net), BigInt(price.milli)));

// GST at `rateBasis` hundredths of a percent (18% = 1800) on `net` paise, as
// the core works a line's GST out.
const taxOf = (net, rateBasis) => Number(signedHalf(BigInt(net) * BigInt(rateBasis), 10000n));

// A price per unit given to four places (₹12.5000 = 125000), as a price for
// `valueOf`; with prices including GST, the GST at the item's own rate taken
// out first.
function listPrice(unitPrice, inclusive = false, rateBasis = 0) {
  const four = BigInt(Math.round(Number(unitPrice) * 10000));
  return { net: Number(inclusive ? half(four * 10000n, 10000n + BigInt(rateBasis)) : four), milli: 100000 };
}

// One unit's value before GST to four places, as the credit note shows it.
const unitValue = (price) => Number(half(BigInt(price.net) * 100000n, BigInt(price.milli))) / 10000;

// What a return changes in what is kept of one free line: { quantity, net,
// tax } (thousandths and paise, signed), from what was kept before ({ quantity,
// net, tax } summed over earlier returns) and what is kept now.
function change(before, nowMilli, price, rateBasis) {
  const value = valueOf(nowMilli, price);
  return { quantity: nowMilli - before.quantity, net: value - before.net, tax: taxOf(value, rateBasis) - before.tax };
}

module.exports = { belongs, keptOf, valueOf, taxOf, listPrice, unitValue, change };
