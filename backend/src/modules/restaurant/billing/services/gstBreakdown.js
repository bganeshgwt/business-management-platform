// How one bill's money splits for GST: taxable value and tax per rate and
// HSN/SAC code, the service charge, the round-off — in whole paise, adding up
// EXACTLY to the bill's own figures.
//
// Why paise and not rupees: the GST return is filed to the paisa, and the old
// report rounded each line's CGST and SGST separately, so the two halves
// could add up to a paisa more than the tax on the bills. Here every split is
// made in whole paise and the parts always add up to the whole.
//
// Pure functions, no database: the report service feeds them rows.

const toPaise = (value) => Math.round(Number(value || 0) * 100);
const rupees = (paise) => Math.round(paise) / 100;

// Service charge is part of what the restaurant supplies, and GST treats it
// that way: it is filed under restaurant service.
const SERVICE_CHARGE_SAC = "996331";

// The GST rates in use in India. A rate worked back from two rounded amounts
// (tax ÷ value) lands a hair off, so it is snapped to the nearest real one.
const STANDARD_RATES = [0, 0.25, 1.5, 3, 5, 6, 12, 18, 28, 40];

const snapRate = (percent) => {
  if (!Number.isFinite(percent) || percent <= 0) {
    return 0;
  }

  const nearest = STANDARD_RATES.reduce((best, rate) =>
    Math.abs(rate - percent) < Math.abs(best - percent) ? rate : best
  );

  return Math.abs(nearest - percent) <= 0.5 ? nearest : Math.round(percent * 100) / 100;
};

// Splits `target` paise into whole-paise parts in proportion to `weights`,
// adding up to exactly `target` (largest remainder). Used wherever one
// rounded figure — a bill's taxable value, its tax — is shared across lines.
const apportion = (target, weights) => {
  if (weights.length === 0) {
    return [];
  }

  const whole = Math.round(target);
  const sign = whole < 0 ? -1 : 1;
  const amount = Math.abs(whole);
  const clean = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const total = clean.reduce((sum, weight) => sum + weight, 0);

  if (total === 0) {
    return clean.map((ignored, index) => (index === 0 ? whole : 0));
  }

  const raw = clean.map((weight) => (amount * weight) / total);
  const parts = raw.map((value) => Math.floor(value));
  let left = amount - parts.reduce((sum, part) => sum + part, 0);

  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let k = 0; left > 0; k = (k + 1) % order.length) {
    parts[order[k].index] += 1;
    left -= 1;
  }

  return parts.map((part) => part * sign);
};

// CGST and SGST are each half of the tax. An odd paisa goes to CGST, and the
// two always add up to the tax — never a paisa over.
const halves = (taxPaise) => {
  const cgst = Math.round(taxPaise / 2);
  return { cgst, sgst: taxPaise - cgst };
};

// One bill, broken down.
//
//   bill   a row with subtotal, discount_amount, tax_amount, service_charge,
//          round_off, total_amount (rupees, as the database stores them)
//   lines  that bill's lines grouped by rate and code:
//          { tax_percentage, hsn_code, quantity, subtotal, tax } before discount
//
// Returns paise:
//   lines          [{ rate, hsn, quantity, taxable, tax }]
//   serviceCharge  { value, tax, rate }  — tax is what the bill charged on it
//   taxable        items' taxable value (subtotal less discount)
//   tax            the bill's whole tax (items + service charge)
//   roundOff, total
//
// The service charge's GST, where a bill charges one, is whatever the bill's
// tax holds beyond the tax on its dishes. Bills that charge none leave the
// service charge untaxed, and the report says so rather than hiding it.
const breakdownBill = (bill, lines = []) => {
  const subtotal = toPaise(bill.subtotal);
  const discount = toPaise(bill.discount_amount);
  const taxable = Math.max(0, subtotal - discount);
  const tax = toPaise(bill.tax_amount);
  const serviceCharge = toPaise(bill.service_charge);
  const roundOff = toPaise(bill.round_off);
  const total = toPaise(bill.total_amount);

  // A discount lowers every line in the same proportion, as the bill did.
  const factor = subtotal > 0 ? taxable / subtotal : 1;

  let groups = lines.map((line) => ({
    rate: Number(line.tax_percentage || 0),
    hsn: line.hsn_code || null,
    quantity: Number(line.quantity || 0),
    rawTaxable: Number(line.subtotal || 0) * factor,
    rawTax: Number(line.tax || 0) * factor,
  }));

  // A bill whose lines are gone (an old bill, a line deleted since) still has
  // its totals; they are filed at the rate they work out to.
  if (groups.length === 0 && (taxable > 0 || tax > 0)) {
    groups = [
      {
        rate: taxable > 0 ? snapRate((tax / taxable) * 100) : 0,
        hsn: null,
        quantity: 0,
        rawTaxable: taxable / 100,
        rawTax: tax / 100,
      },
    ];
  }

  const itemTaxRaw = groups.reduce((sum, group) => sum + group.rawTax, 0);
  let itemTax = Math.round(itemTaxRaw * 100);
  let serviceChargeTax = 0;

  // Tax beyond the dishes' own, on a bill that carries a service charge, is
  // the service charge's GST. A paisa or two either way is only the bill's
  // rounding and stays with the dishes.
  const beyond = tax - itemTax;

  if (serviceCharge > 0 && beyond >= 5) {
    serviceChargeTax = beyond;
  } else {
    itemTax = tax;
  }

  const taxableParts = apportion(taxable, groups.map((group) => group.rawTaxable));
  const taxParts = apportion(
    itemTax,
    groups.map((group) => group.rawTax)
  );

  // CGST and SGST are split on each line, and every table in the pack adds
  // up these same halves — so the register, the rate tables and the HSN
  // summary agree to the paisa, and CGST + SGST is the tax everywhere.
  return {
    lines: groups.map((group, index) => ({
      rate: group.rate,
      hsn: group.hsn,
      quantity: group.quantity,
      taxable: taxableParts[index],
      tax: taxParts[index],
      cgst: halves(taxParts[index]).cgst,
    })),
    serviceCharge: {
      value: serviceCharge,
      tax: serviceChargeTax,
      cgst: halves(serviceChargeTax).cgst,
      rate: serviceCharge > 0 && serviceChargeTax > 0 ? snapRate((serviceChargeTax / serviceCharge) * 100) : 0,
    },
    taxable,
    tax,
    roundOff,
    total,
  };
};

// Pure SAC codes (services) start with 99; the HSN summary files them with
// no quantity, "NA", where goods are counted in pieces.
const isServiceCode = (code) => typeof code === "string" && code.startsWith("99");

module.exports = {
  SERVICE_CHARGE_SAC,
  toPaise,
  rupees,
  snapRate,
  apportion,
  halves,
  breakdownBill,
  isServiceCode,
};
