// The service charge of a bill priced before its GST was kept rate by rate
// (bill_taxes), shared out over the GST rates of the food it was charged on.
//
// Why: service charge is part of the restaurant's supply, so GST taxes it at
// the rate of the food it is on — 5% on 5% food, 18% on 18% drinks. A bill
// priced today keeps it per rate. An older bill kept one service charge and
// one GST figure for it, and the GST return used to file that at the rate it
// works out to: a bill of 5% food and 18% drinks filed its service charge at
// 10.04%, a rate no law has, and the GST portal refuses it.
//
// Here the service charge is shared over the rates in proportion to each
// rate's food (as the bill itself shares it today), and the GST the bill
// actually charged on it is shared in proportion to what each share carries
// at its own rate — so every row is at a real rate, and the parts add up to
// exactly what the bill charged, to the paisa. For a bill whose service
// charge GST was worked at the blended rate (how the older bills did it)
// each share then carries exactly its own rate's GST.
//
// Pure, in paise. No database.
const { apportion, halves, snapRate } = require("./gstBreakdown");

// lines          the bill's dishes: [{ rate, taxable }] (taxable after discount)
// serviceCharge  { value, tax } — the service charge and the GST on it
// Returns [{ rate, value, tax, cgst }], one per rate that has a share.
const shareServiceCharge = (lines, serviceCharge) => {
  const value = Math.round(serviceCharge.value || 0);
  const tax = Math.round(serviceCharge.tax || 0);

  if (value <= 0 && tax <= 0) {
    return [];
  }

  const byRate = new Map();

  for (const line of lines || []) {
    const rate = Number(line.rate || 0);
    byRate.set(rate, (byRate.get(rate) || 0) + Math.max(0, Number(line.taxable || 0)));
  }

  const rates = [...byRate.keys()].sort((a, b) => a - b);
  const weights = rates.map((rate) => byRate.get(rate));
  const taxedFood = rates.reduce((sum, rate, index) => sum + (rate > 0 ? weights[index] : 0), 0);

  // No food left to share it by (an old bill whose lines are gone), or GST on
  // a service charge whose food carried none: filed whole, at the real rate
  // it comes nearest to.
  if (weights.every((weight) => weight <= 0) || (tax > 0 && taxedFood <= 0)) {
    const rate = value > 0 && tax > 0 ? snapRate((tax / value) * 100) : 0;
    return [{ rate, value, tax, cgst: halves(tax).cgst }];
  }

  const values = apportion(value, weights);
  // What each share would carry at its own rate: the weights the bill's GST
  // on service charge is shared by.
  const carried = rates.map((rate, index) => (values[index] * rate) / 100);
  const taxes = tax > 0 ? apportion(tax, carried) : rates.map(() => 0);

  return rates
    .map((rate, index) => ({ rate, value: values[index], tax: taxes[index], cgst: halves(taxes[index]).cgst }))
    .filter((row) => row.value !== 0 || row.tax !== 0);
};

module.exports = { shareServiceCharge };
