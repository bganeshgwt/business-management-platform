const core = require('../../core/services/business.service');

// A garment order's money, worked out exactly as the core works out a sale,
// in integer paise:
//   a garment   its price for each one times how many, its price a kilo
//               times the kilos (to the gram), or its price a square foot
//               times the area (length × width, rounded as the shop sets),
//               each to the paisa; the express surcharge, that percentage of
//               it (to the paisa, halves up); less what a prepaid package
//               pays (its share of the price for the kilos or pieces it
//               covers), an offer's percentage, and the discount given (on the
//               garment, and its share of one on the whole order). What is
//               left is its value in the order's price terms, with GST taken
//               out of it (prices including GST) or put on it (before GST)
//   today       each garment as a bill takes it now: GST at its item's rate of
//               the day (a price including GST keeps its total, one before GST
//               keeps its taxable value)
//   a bill      one line a garment at its own value (so many of its item, or
//               one for a bundle by the kilo or a piece by the square foot),
//               with words that name the garment and its tag; before GST, GST,
//               the round-off as the business rounds, and the total
// A discount given in rupees is off what the customer pays (with GST), as at
// the core's counter, and is spread over the garments by what each pays.
// Pure functions: the services read the rows, these only count.

const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const paise = (value) => Math.round(Number(value) * 100);
const milli = (value) => Math.round(Number(value) * 1000);
const rupees = (p) => (p / 100).toFixed(2);
const percentOf = (amount, percent) => roundedDivide(BigInt(amount) * BigInt(paise(percent)), 10000n);
const sum = (values) => values.reduce((total, value) => total + value, 0);

// total split over weights in proportion, the rounding carried forward: the parts add up exactly.
function split(total, weights) {
  const whole = sum(weights);
  if (!whole || !total) return weights.map(() => 0);
  let given = 0, running = 0;
  return weights.map((weight) => {
    running += weight;
    const upto = roundedDivide(BigInt(total) * BigInt(running), BigInt(whole));
    const part = upto - given;
    given = upto;
    return part;
  });
}

// The area of a carpet or curtain in square feet (as text, to two places at
// most) from its length and width in feet (to two places): to the hundredth
// ("exact", halves up), to the nearest whole one, or up to the next whole one.
function areaOf(length, width, rounding = 'exact') {
  const raw = BigInt(paise(length)) * BigInt(paise(width));
  if (rounding === 'nearest') return String(roundedDivide(raw, 10000n));
  if (rounding === 'up') return String((raw + 9999n) / 10000n);
  return String(Number((roundedDivide(raw, 100n) / 100).toFixed(2)));
}

// A garment at its price: for each one (a whole quantity), a kilo or a square foot (paise).
const baseOf = (per, rate, quantity) => (per === 'item' ? paise(rate) * Number(quantity) : roundedDivide(BigInt(paise(rate)) * BigInt(milli(quantity)), 1000n));
// GST taken out of a value (prices including GST) or put on it (before GST).
function taxed(amount, taxRate, taxMode) {
  if (taxMode === 'inclusive') {
    const net = core.inclusiveNet(amount, Number(taxRate));
    return { net, tax: amount - net };
  }
  return { net: amount, tax: core.lineTax(amount, Number(taxRate)) };
}
// What the customer pays for a value in the order's price terms, and back.
const payableOf = (amount, taxRate, taxMode) => (taxMode === 'inclusive' ? amount : amount + core.lineTax(amount, Number(taxRate)));
const priceTermsOf = (payable, taxRate, taxMode) => (taxMode === 'inclusive' ? payable
  : roundedDivide(BigInt(payable) * 10000n, 10000n + BigInt(paise(taxRate))));

// One garment's figures (paise) at its price with the express surcharge, before any package, offer or discount.
function garmentFigures({ per, rate, quantity, expressPercent = 0, taxRate, taxMode }) {
  const base = baseOf(per, rate, quantity);
  const surcharge = percentOf(base, expressPercent);
  const amount = base + surcharge;
  return { base, surcharge, amount, ...taxed(amount, taxRate, taxMode) };
}

// What a prepaid package pays of a garment: its share of the price for what it
// covers (kilos of a bundle, or pieces of a garment by the piece).
const packageShare = (base, covered, of) => (covered >= of ? base : roundedDivide(BigInt(base) * BigInt(milli(covered)), BigInt(milli(of))));

// The garments of an order (or of garments added to it) with their package,
// offer and discounts. lines: [{ base, surcharge, packageAmount, offerPercent,
// taxRate, discount: { percent } | { amount (paise the customer pays) } | null }];
// order: the discount on all of them, the same way, or null. Returns each
// line's offerAmount, discountAmount, amount, net and tax, the discount given
// by hand in what the customer pays (`manual`), and what the customer would
// pay before it (`before`), for the business's most discount; `problem` when a
// discount is more than what it is taken off.
function priceLines(lines, order, taxMode) {
  let problem = null;
  const out = lines.map((l, index) => {
    const value = l.base + l.surcharge - l.packageAmount;
    const offerAmount = l.offerAmount ?? (l.offerPercent ? percentOf(value, l.offerPercent) : 0);
    const afterOffer = value - offerAmount;
    let own = 0;
    if (l.discount?.percent) own = percentOf(afterOffer, l.discount.percent);
    else if (l.discount?.amount) own = priceTermsOf(l.discount.amount, l.taxRate, taxMode);
    if (own > afterOffer) { problem = problem || { index, left: payableOf(afterOffer, l.taxRate, taxMode) }; own = afterOffer; }
    return { ...l, value, offerAmount, afterOffer, own };
  });
  const lefts = out.map((l) => l.afterOffer - l.own);
  let shares = out.map(() => 0);
  if (order?.percent) shares = lefts.map((left) => percentOf(left, order.percent));
  else if (order?.amount) {
    const payables = lefts.map((left, i) => payableOf(left, out[i].taxRate, taxMode));
    if (order.amount > sum(payables)) problem = problem || { order: true, left: sum(payables) };
    shares = split(Math.min(order.amount, sum(payables)), payables).map((part, i) => Math.min(lefts[i], priceTermsOf(part, out[i].taxRate, taxMode)));
  }
  let manual = 0, before = 0;
  const priced = out.map((l, i) => {
    const discountAmount = l.own + shares[i];
    const amount = l.afterOffer - discountAmount;
    const payBefore = payableOf(l.afterOffer, l.taxRate, taxMode);
    before += payBefore;
    manual += payBefore - payableOf(amount, l.taxRate, taxMode);
    return { ...l, discountAmount, amount, ...taxed(amount, l.taxRate, taxMode) };
  });
  return { lines: priced, manual, before, problem };
}

// Before GST, GST, the round-off as the business rounds, and the total (paise).
function billFigures(values, rounding) {
  const subtotal = values.reduce((sum, x) => sum + x.net, 0);
  const tax = values.reduce((sum, x) => sum + x.tax, 0);
  const raw = subtotal + tax;
  const total = rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw;
  return { subtotal, tax, roundOff: total - raw, total };
}
const figuresText = (f) => ({ subtotal: rupees(f.subtotal), tax: rupees(f.tax), round_off: rupees(f.roundOff), total: rupees(f.total) });

// Each garment as a bill takes it today. Garments need tax_rate_now (their item's rate now).
function todayValues(order, items) {
  return items.map((item) => {
    const net = paise(item.net), tax = paise(item.tax), rate = Number(item.tax_rate_now ?? item.tax_rate);
    if (rate === Number(item.tax_rate)) return { item, net, tax, rate };
    if (order.tax_mode === 'inclusive') {
      const gross = net + tax;
      const taxable = core.inclusiveNet(gross, rate);
      return { item, net: taxable, tax: gross - taxable, rate };
    }
    return { item, net, tax: core.lineTax(net, rate), rate };
  });
}

// How many kilos or square feet as a person reads them: 3.25, 0.5, 12.
const kilos = (quantity) => String(Number(quantity));
// A bill line's words: the service, the garment (with the kilos and pieces of
// a bundle, or the size of a piece by the square foot), express when it
// carried the surcharge, a package, an offer or a discount when one paid part
// of it, and the tag.
function lineLabel(item) {
  const pieces = `${item.pieces} ${Number(item.pieces) === 1 ? 'piece' : 'pieces'}`;
  const what = item.per === 'kg' ? `${item.garment_name} ${kilos(item.quantity)} kg, ${pieces}`
    : item.per === 'sqft' ? `${item.garment_name} ${kilos(item.length_ft)} × ${kilos(item.width_ft)} ft, ${kilos(item.quantity)} sq ft` : item.garment_name;
  return [item.service_name, what, paise(item.surcharge) > 0 ? 'express' : null, paise(item.package_amount || 0) > 0 ? 'package' : null,
    paise(item.offer_amount || 0) > 0 ? `offer ${item.offer_name}` : null, paise(item.discount_amount || 0) > 0 ? 'discount' : null, `tag ${item.tag_no}`]
    .filter(Boolean).join(' · ').slice(0, 150);
}

// The bill's lines for these values, in the business's price terms now (mode):
// each line's fixed prices are the garment's own, so the bill adds up to them.
function billLines(values, mode) {
  return values.map(({ item, net, tax }) => {
    const quantity = item.per === 'item' ? Number(item.quantity) : 1;
    const value = net + (mode === 'inclusive' ? tax : 0);
    return {
      item,
      input: { skuId: item.sku_id, quantity: String(quantity) },
      fixed: { price: Number(((value / 100) / quantity).toFixed(4)), net, tax, priceRuleId: null, enteredPrice: null, label: lineLabel(item) },
    };
  });
}

module.exports = { paise, rupees, milli, split, areaOf, baseOf, taxed, payableOf, priceTermsOf, percentOf, garmentFigures, packageShare, priceLines, billFigures,
  figuresText, todayValues, lineLabel, billLines };
