// An online order's money, in whole paise (pure: the services read the rows,
// these only count). BUSINESS_RULES.md › Online shop.
//
// A guest sees one price per unit with GST inside it, whatever the shop's
// own tax mode: the shelf price (the walk-in price at the link's location,
// GST added when the shop prices before GST, never above the MRP). Each
// line's amount is that price times the quantity, to the paisa; the cart's
// total is the lines, the delivery charge and the shop's rounding. The bill
// is posted with these same amounts (business.service.js postDocument with
// `fixed` lines: the GST worked out of each line's amount at the item's rate
// on the day of the bill), so the bill comes to what the cart said for what
// was packed, and never to more than the guest agreed to.
//
//   shelfPaise(price, rate, taxMode, mrp)   one unit's price with GST, at most the MRP
//   lineAmount(pricePaise, quantity)        a line's amount
//   deliveryCharge({ service, fee, freeAbove, itemsTotal })
//   roundBill(raw, rounding)                the shop's rounding ('nearest_rupee' or none)
//   cartTotals({ lines, service, fee, freeAbove, minOrder, rounding })
//   weighedAllowance(lines)                 10% of the weighed lines' amounts: what
//                                           weighing may add without asking
//   splitByRate(amount, goods)              the delivery charge shared over the
//                                           goods' GST rates by their value
//   inclusiveParts(gross, rate)             { net, tax } of an amount with GST inside
//   discountRoom(...)                       how much more staff may take off a bill
//   unitSalePrice(...)                      ₹ per kg, litre, metre or piece

const { apportion } = require('../../../../utils/money');

const paise = (rupees) => Math.round(Number(rupees) * 100);
const milli = (quantity) => Math.round(Number(quantity) * 1000);
const rupees = (amount) => (amount / 100).toFixed(2);
// numerator / denominator to the nearest whole number, a half rounding up (both not negative).
const roundedDivide = (numerator, denominator) => Number((BigInt(numerator) * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n));
const lineTax = (net, rate) => roundedDivide(BigInt(net) * BigInt(paise(rate)), 10000n);

function shelfPaise(price, rate, taxMode, mrp = null) {
  const base = paise(price);
  const shelf = taxMode === 'inclusive' ? base : base + lineTax(base, rate);
  const cap = mrp === null || mrp === undefined || mrp === '' ? null : paise(mrp);
  return cap !== null && cap > 0 && shelf > cap ? cap : shelf;
}

const lineAmount = (pricePaise, quantity) => roundedDivide(BigInt(pricePaise) * BigInt(milli(quantity)), 1000n);

function deliveryCharge({ service, fee, freeAbove = null, itemsTotal }) {
  if (service !== 'delivery' || !(fee > 0)) return 0;
  return freeAbove !== null && freeAbove !== undefined && itemsTotal >= freeAbove ? 0 : fee;
}

const roundBill = (raw, rounding) => (rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw);

// lines: [{ pricePaise, quantity, weighed }] (fee, freeAbove, minOrder in paise; freeAbove null: never free).
function cartTotals({ lines, service, fee = 0, freeAbove = null, minOrder = 0, rounding = 'none' }) {
  const itemsTotal = lines.reduce((sum, line) => sum + lineAmount(line.pricePaise, line.quantity), 0);
  const delivery = deliveryCharge({ service, fee, freeAbove, itemsTotal });
  const raw = itemsTotal + delivery;
  const total = roundBill(raw, rounding);
  const delivering = service === 'delivery';
  return {
    itemsTotal,
    delivery,
    roundOff: total - raw,
    total,
    allowance: weighedAllowance(lines),
    // What the guest still needs to add for free delivery, or for the minimum order (delivery).
    moreForFree: delivering && fee > 0 && freeAbove !== null && freeAbove !== undefined && itemsTotal < freeAbove ? freeAbove - itemsTotal : 0,
    moreForMinimum: delivering && minOrder > 0 && itemsTotal < minOrder ? minOrder - itemsTotal : 0,
  };
}

// Weighing may come to a little more than the guest asked for ("about 500 g"):
// up to 10% of each weighed line's amount is taken as agreed when they place
// the order, and the cart says so. More than that waits for their OK.
const weighedAllowance = (lines) => lines.filter((line) => line.weighed)
  .reduce((sum, line) => sum + Math.floor(lineAmount(line.pricePaise, line.quantity) / 10), 0);

// The delivery charge is part of the goods' supply (CGST s.15(2)(c)), taxed at
// the goods' rate (s.8(a)): with goods at several rates it is shared over them
// by their value, one delivery line per rate. goods: [{ rate, amount }].
// Returns [{ rate, amount }] adding up to `amount` exactly, the largest share first.
function splitByRate(amount, goods) {
  if (amount <= 0) return [];
  const byRate = new Map();
  for (const line of goods) {
    const key = Number(line.rate).toFixed(2);
    byRate.set(key, (byRate.get(key) || 0) + line.amount);
  }
  const rates = [...byRate.entries()].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]));
  if (!rates.length) return [];
  const shares = apportion(amount, rates.map(([, value]) => value));
  return rates.map(([rate], index) => ({ rate: Number(rate), amount: shares[index] })).filter((part) => part.amount > 0);
}

// The taxable value and GST inside an amount that includes GST at `rate`.
function inclusiveParts(gross, rate) {
  const net = roundedDivide(BigInt(gross) * 10000n, 10000n + BigInt(paise(rate)));
  return { net, tax: gross - net };
}

// A line shared over the batches it is packed from, by quantity: each part
// takes its cumulative share, so the parts add up to the line exactly.
// parts: [quantityMilli]; returns amounts.
function shareByQuantity(amount, parts) {
  const whole = parts.reduce((sum, part) => sum + part, 0);
  let done = 0, given = 0;
  return parts.map((part) => {
    done += part;
    const upTo = whole === 0 ? 0 : roundedDivide(BigInt(amount) * BigInt(done), BigInt(whole));
    const share = upTo - given;
    given = upTo;
    return share;
  });
}

// What staff may still take off an order's goods with their discount
// permission: the business's bill discount limit (a percentage of the goods'
// amount at the guest's prices), less what is already taken off.
function discountRoom({ goodsAmount, takenOff, limitPercent }) {
  const limit = Math.floor((goodsAmount * Math.round(Number(limitPercent || 0) * 100)) / 10000);
  return Math.max(0, limit - takenOff);
}

// A pack's net quantity as written ("500 g", "1.5 kg", "200 ml", "1 L",
// "2 m", "10 pieces"), or null.
const UNITS = {
  g: ['g', 1], gm: ['g', 1], gms: ['g', 1], gram: ['g', 1], grams: ['g', 1], kg: ['g', 1000], kgs: ['g', 1000],
  ml: ['ml', 1], l: ['ml', 1000], ltr: ['ml', 1000], litre: ['ml', 1000], litres: ['ml', 1000], liter: ['ml', 1000],
  cm: ['cm', 1], m: ['cm', 100], metre: ['cm', 100], metres: ['cm', 100], meter: ['cm', 100],
  pc: ['piece', 1], pcs: ['piece', 1], piece: ['piece', 1], pieces: ['piece', 1], n: ['piece', 1], nos: ['piece', 1], units: ['piece', 1],
};
function readNetQuantity(text) {
  const match = /(\d+(?:\.\d+)?)\s*(kgs?|gms?|grams?|g|ml|ltr|litres?|liter|l|cm|metres?|meter|m|pcs?|pieces?|nos|units|n)\b/i.exec(String(text || ''));
  if (!match) return null;
  const amount = Number(match[1]);
  const [base, factor] = UNITS[match[2].toLowerCase()] || [];
  if (!base || !(amount > 0)) return null;
  return { base, amount: amount * factor };
}

// The unit sale price the Legal Metrology (Packaged Commodities) Rules ask an
// online listing to show (G.S.R. 226(E), 2022): per kilogram, litre or metre
// for a pack of one or more, per gram, millilitre or centimetre below that,
// per piece for a count. A weighed item is priced per its own unit already.
// Returns { amount (paise, rounded), per } or null when the pack is not known.
function unitSalePrice(pricePaise, net) {
  if (!net) return null;
  const big = { g: ['kg', 1000], ml: ['litre', 1000], cm: ['metre', 100] }[net.base];
  if (net.base === 'piece') return net.amount > 1 ? { amount: Math.round(pricePaise / net.amount), per: 'piece' } : null;
  if (!big) return null;
  if (net.amount >= big[1]) return { amount: Math.round((pricePaise * big[1]) / net.amount), per: big[0] };
  return { amount: Math.round(pricePaise / net.amount), per: net.base === 'g' ? 'g' : net.base === 'ml' ? 'ml' : 'cm' };
}

module.exports = {
  paise, milli, rupees, roundedDivide, shelfPaise, lineAmount, deliveryCharge, roundBill, cartTotals, weighedAllowance, splitByRate, inclusiveParts,
  shareByQuantity, discountRoom, readNetQuantity, unitSalePrice,
};
