// GST rate changes: the arithmetic and the dates, pure. The preview a person
// sees and the change the database applies on its date (the migration's
// business_tax_change_price) come to the same paisa, because both work in
// whole paise and round half a paisa up.

const paise = (value) => Math.round(Number(value) * 100);
const rupees = (amount) => (amount / 100).toFixed(2);
// A rate in hundredths of a per cent: 18.00% is 1800.
const basis = (rate) => Math.round(Number(rate) * 100);
// n / d for whole numbers, half up (both positive).
const divide = (n, d) => Number((n * 2n + d) / (d * 2n));

// A price that includes GST, keeping its part before GST at a new rate:
// ₹118.00 at 18% is ₹105.00 at 5%.
function keepNet(pricePaise, fromRate, toRate) {
  return divide(BigInt(pricePaise) * (10000n + BigInt(basis(toRate))), 10000n + BigInt(basis(fromRate)));
}

// One unit at a price: its part before GST, the GST, and what the customer
// pays, as a bill works them out (business.service.js inclusiveNet, lineTax).
function unitFigures(pricePaise, rate, inclusive) {
  if (inclusive) {
    const net = divide(BigInt(pricePaise) * 10000n, 10000n + BigInt(basis(rate)));
    return { net, tax: pricePaise - net, total: pricePaise };
  }
  const tax = divide(BigInt(pricePaise) * BigInt(basis(rate)), 10000n);
  return { net: pricePaise, tax, total: pricePaise + tax };
}

// The price an item takes from a change: a price that includes GST moves only
// when the change keeps the part before GST; a price before GST never moves.
function priceAfter(pricePaise, fromRate, toRate, { inclusive, keeps }) {
  return inclusive && keeps === 'net' && basis(fromRate) !== basis(toRate) ? keepNet(pricePaise, fromRate, toRate) : pricePaise;
}

// A YYYY-MM-DD date moved by whole days (calendar arithmetic, no clock).
function addDays(date, days) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10);
}
// The same day two years on (29 February: the 28th).
function twoYearsOn(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  const day = Math.min(d, new Date(Date.UTC(y + 2, m, 0)).getUTCDate());
  return `${y + 2}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// Why a change cannot start on this date, or null. `today` is the business's
// own date: a change is entered ahead, from tomorrow, and starts within two
// years (a later date is a typing slip). `fromToday` says how to change an
// item's GST from today instead.
function startProblem(startsOn, today, fromToday = '') {
  if (startsOn <= today) return `A GST rate change starts on a later day than today (${dateWords(today)}).${fromToday ? ` ${fromToday}` : ''}`;
  if (startsOn > twoYearsOn(today)) return `A GST rate change starts within two years of today, by ${dateWords(twoYearsOn(today))}`;
  return null;
}

// "1 Apr 2027": how a date is said in a sentence.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateWords(date) {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
// "18%", "0.25%": a rate as it is said.
const rateWords = (rate) => `${Number(rate)}%`;

module.exports = { paise, rupees, basis, keepNet, unitFigures, priceAfter, addDays, twoYearsOn, startProblem, dateWords, rateWords };
