// Money helpers. Everything is rounded to 2 decimals at each step, so the
// printed bill always adds up exactly; JavaScript floats would drift otherwise.

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Splits a gross amount into net and tax when prices already include tax.
const taxFromInclusive = (grossAmount, taxPercentage) => {
  const net = round2(grossAmount / (1 + taxPercentage / 100));
  return { net, tax: round2(grossAmount - net) };
};

// Adds tax on top when prices exclude tax.
const taxFromExclusive = (netAmount, taxPercentage) => ({
  net: round2(netAmount),
  tax: round2((netAmount * taxPercentage) / 100),
});

// Rounds a bill total to the nearest whole unit of currency and reports the
// difference, which appears on the bill as "round off".
const roundOff = (total) => {
  const rounded = Math.round(total);
  return { rounded: round2(rounded), difference: round2(rounded - total) };
};

// --- Whole paise --------------------------------------------------------------
// A bill is worked out in whole paise (integers), where every sum is exact,
// and turned back into rupees only at the end. Splitting one rounded figure
// across several lines is where rupee floats lose a paisa; in paise the parts
// always add up to the whole.
const toPaise = (value) => Math.round(Number(value || 0) * 100);
const fromPaise = (paise) => Math.round(paise) / 100;

// A percentage of an amount in paise, to the nearest paisa (a half rounds up).
const percentOf = (paise, percent) => Math.round((paise * Number(percent || 0)) / 100);

// Splits `target` paise into whole-paise parts in proportion to `weights`,
// adding up to exactly `target` (largest remainder; ties go to the earlier
// part). A weight of zero or less gets nothing unless every weight is zero,
// when the first part takes it all.
const apportion = (target, weights) => {
  if (weights.length === 0) {
    return [];
  }

  const whole = Math.round(target);
  const clean = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const total = clean.reduce((sum, weight) => sum + weight, 0);

  if (total === 0) {
    return clean.map((ignored, index) => (index === 0 ? whole : 0));
  }

  const raw = clean.map((weight) => (whole * weight) / total);
  const parts = raw.map((value) => Math.floor(value));
  let left = whole - parts.reduce((sum, part) => sum + part, 0);

  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let k = 0; left > 0; k = (k + 1) % order.length) {
    parts[order[k].index] += 1;
    left -= 1;
  }

  return parts;
};

// CGST and SGST are each half of the GST. An odd paisa goes to CGST, so the
// two always add up to the tax exactly — never a paisa over, as printing
// (tax / 2) twice used to.
const splitGst = (gstPaise) => {
  const cgst = Math.round(gstPaise / 2);
  return { cgst, sgst: gstPaise - cgst };
};

module.exports = {
  round2,
  taxFromInclusive,
  taxFromExclusive,
  roundOff,
  toPaise,
  fromPaise,
  percentOf,
  apportion,
  splitGst,
};
