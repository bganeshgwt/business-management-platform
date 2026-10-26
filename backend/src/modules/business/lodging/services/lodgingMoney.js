// A stay's money, in integer paise, worked out exactly as the core works out a
// sale (the same rounding as its lineTax and inclusiveNet). Pure functions:
// the services read the rows, these only count.
//
//   a night      the date it starts on, at the stay's agreed rate if it has
//                one, else at its weekend rate on one of the property's weekend
//                nights (by the day of the week), else at its rack rate
//   its value    that rate, with each adult beyond the rate's base occupancy,
//                each child and each extra bed at their own rates, all before
//                GST: what the room is charged for that night
//   its slab     decided by that value, night by night: at or below the limit
//                (₹7,500 a room a night from 22 September 2025) the lower slab,
//                above it the higher; so a weekend night above the limit is
//                billed at the higher slab and the weekday nights round it at
//                the lower
//   its GST      the slab's rate on the value, to the paisa (halves up)
//   an extra     its price times how many (to the paisa), in the business's
//                price terms, with GST taken out of it (prices including GST)
//                or put on it (before GST), at its item's slab
//   the bill     one line a charge at its own value and rate; before GST, GST,
//                the round-off as the business rounds, and the total

const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const milli = (value) => Math.round(Number(value) * 1000);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
// A rate's basis points: 18 is 1800.
const basis = (rate) => Math.round(Number(rate) * 100);
// GST at a rate on a value before GST, and the value before GST inside one with GST in it.
const taxOn = (net, rate) => roundedDivide(BigInt(net) * BigInt(basis(rate)), 10000n);
const netOf = (gross, rate) => roundedDivide(BigInt(gross) * 10000n, 10000n + BigInt(basis(rate)));

// Calendar days (YYYY-MM-DD), with no clock: the business's dates come from the database.
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nightCount = (arrival, departure) => Math.round((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000);
// The nights of a stay: each date from the arrival to the night before the departure.
function nightsOf(arrival, departure) {
  const out = [];
  for (let day = arrival; day < departure; day = addDays(day, 1)) out.push(day);
  return out;
}
// The day of the week of a date, 1 Monday … 7 Sunday.
function isoDay(day) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

// A stay's rates as the database keeps them (rupees; null when not set), in paise.
const ratesOf = (row) => ({
  rack: paise(row.rack_rate), weekend: row.weekend_rate === null || row.weekend_rate === undefined ? null : paise(row.weekend_rate),
  extraAdult: row.extra_adult_rate === null || row.extra_adult_rate === undefined ? null : paise(row.extra_adult_rate),
  child: row.child_rate === null || row.child_rate === undefined ? null : paise(row.child_rate),
  extraBed: row.extra_bed_rate === null || row.extra_bed_rate === undefined ? null : paise(row.extra_bed_rate),
  agreed: row.agreed_rate === null || row.agreed_rate === undefined ? null : paise(row.agreed_rate), baseOccupancy: Number(row.base_occupancy),
});

// One night's value: { night, weekend, rateKind, roomRate, extraAdults, children, extraBeds, amount } (paise).
// rates: { rack, weekend, extraAdult, child, extraBed, agreed, baseOccupancy }; party: { adults, children, extraBeds }.
function nightValue(night, rates, party, weekendNights) {
  const weekend = weekendNights.map(Number).includes(isoDay(night));
  const rateKind = rates.agreed !== null && rates.agreed !== undefined ? 'agreed' : weekend && rates.weekend !== null && rates.weekend !== undefined ? 'weekend' : 'rack';
  const roomRate = rateKind === 'agreed' ? rates.agreed : rateKind === 'weekend' ? rates.weekend : rates.rack;
  const extraAdults = Math.max(0, Number(party.adults) - Number(rates.baseOccupancy));
  const children = Number(party.children || 0);
  const extraBeds = Number(party.extraBeds || 0);
  const amount = roomRate + extraAdults * (rates.extraAdult || 0) + children * (rates.child || 0) + extraBeds * (rates.extraBed || 0);
  return { night, weekend, rateKind, roomRate, extraAdults, children, extraBeds, amount };
}

// The slab a room night of this value is billed at. slabs: { limit (paise), low: { id, rate, name }, high: { id, rate, name } }.
const slabFor = (amount, slabs) => (amount <= slabs.limit ? slabs.low : slabs.high);

// One night priced: its value, its slab and its GST.
function priceNight(night, rates, party, settings) {
  const value = nightValue(night, rates, party, settings.weekendNights);
  const slab = slabFor(value.amount, settings.slabs);
  return { ...value, slab, net: value.amount, tax: taxOn(value.amount, slab.rate) };
}

// Every night of a stay priced, and the room nights added up: { nights, subtotal, tax, total }.
function estimate(arrival, departure, rates, party, settings) {
  const nights = nightsOf(arrival, departure).map((night) => priceNight(night, rates, party, settings));
  const subtotal = nights.reduce((sum, n) => sum + n.net, 0);
  const tax = nights.reduce((sum, n) => sum + n.tax, 0);
  return { nights, subtotal, tax, total: subtotal + tax };
}

// An extra on the folio: so many at a price (paise, in the business's price terms), at a rate.
function extraFigures({ price, quantity, taxRate, taxMode }) {
  const amount = roundedDivide(BigInt(price) * BigInt(milli(quantity)), 1000n);
  if (taxMode === 'inclusive') {
    const net = netOf(amount, taxRate);
    return { amount, net, tax: amount - net };
  }
  return { amount, net: amount, tax: taxOn(amount, taxRate) };
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

// The bill's lines for these values, in the business's price terms now (mode):
// each line's fixed prices and rate are the charge's own, so the bill adds up to
// them. value: { skuId, quantity, net, tax, taxRate, label }.
function billLines(values, mode) {
  return values.map((value) => {
    const gross = value.net + (mode === 'inclusive' ? value.tax : 0);
    return {
      value,
      input: { skuId: value.skuId, quantity: String(value.quantity) },
      fixed: { price: Number(((gross / 100) / Number(value.quantity)).toFixed(4)), net: value.net, tax: value.tax, taxRate: Number(value.taxRate).toFixed(2),
        priceRuleId: null, enteredPrice: null, label: String(value.label).slice(0, 150) },
    };
  });
}

module.exports = { paise, rupees, milli, taxOn, netOf, addDays, nightCount, nightsOf, isoDay, ratesOf, nightValue, slabFor, priceNight, estimate, extraFigures,
  billFigures, figuresText, billLines };
