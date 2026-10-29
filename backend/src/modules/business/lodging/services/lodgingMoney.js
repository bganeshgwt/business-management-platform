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

// --- The calendar --------------------------------------------------------------------------------
//
// Each night's rates worked out from the calendar, most particular first:
//   the room's rate   one rate agreed for every night; else the date's own rate
//                     (the plan's, then the room type's); else a season's
//                     (the plan's own season, then the room type's) at its
//                     weekend rate on a weekend night, else its weekday rate;
//                     else the plan's own rates; else the room type's (its
//                     weekend rate on a weekend night, else its rack rate)
//   extra persons     each extra adult, child and extra bed rate from the date,
//                     then the season, then the room type
//   restrictions      the minimum stay (the date's, then the season's), closed
//                     to arrival and stop-sell (the plan's date or the room type's)
//   the meals         the plan's meals: their item and their rates for each
//                     adult and child, kept apart from the room's
const given = (x) => x !== null && x !== undefined;
const first = (...values) => values.find(given) ?? null;
// A rate in rupees (or null) as paise (or null).
const paiseOrNull = (value) => (given(value) ? paise(value) : null);

// type: { rack, weekend, extraAdult, child, extraBed } (paise or null); plan: null or { id, room, weekend, mealSkuId, mealAdult, mealChild };
// seasons: [{ planId, startsOn, endsOn, weekday, weekend, extraAdult, child, extraBed, minStay }]; days: [{ planId, day, room, extraAdult, child, extraBed,
// minStay, closedToArrival, stopSell }]; agreed: paise or null. Returns one row a night.
function resolveNights(arrival, departure, { type, plan = null, seasons = [], days = [], weekendNights = [], agreed = null }) {
  const planId = plan ? Number(plan.id) : null;
  return nightsOf(arrival, departure).map((night) => {
    const weekend = weekendNights.map(Number).includes(isoDay(night));
    const covers = (s) => s.startsOn <= night && s.endsOn >= night;
    const season = (planId && seasons.find((s) => Number(s.planId) === planId && covers(s))) || seasons.find((s) => !given(s.planId) && covers(s)) || null;
    const dayPlan = planId ? days.find((d) => d.day === night && Number(d.planId) === planId) || null : null;
    const dayType = days.find((d) => d.day === night && !given(d.planId)) || null;
    let rateKind, roomRate;
    if (given(agreed)) { rateKind = 'agreed'; roomRate = agreed; }
    else if (given(dayPlan?.room) || given(dayType?.room)) { rateKind = 'override'; roomRate = first(dayPlan?.room, dayType?.room); }
    else if (season) { rateKind = 'season'; roomRate = weekend && given(season.weekend) ? season.weekend : season.weekday; }
    else if (given(plan?.room)) { const w = weekend && given(plan.weekend); rateKind = w ? 'weekend' : 'rack'; roomRate = w ? plan.weekend : plan.room; }
    else { const w = weekend && given(type.weekend); rateKind = w ? 'weekend' : 'rack'; roomRate = w ? type.weekend : type.rack; }
    return {
      night, weekend, rateKind, roomRate,
      extraAdult: first(dayPlan?.extraAdult, dayType?.extraAdult, season?.extraAdult, type.extraAdult),
      child: first(dayPlan?.child, dayType?.child, season?.child, type.child),
      extraBed: first(dayPlan?.extraBed, dayType?.extraBed, season?.extraBed, type.extraBed),
      mealSkuId: plan?.mealSkuId ? Number(plan.mealSkuId) : null, mealAdult: plan?.mealSkuId ? plan.mealAdult : null, mealChild: plan?.mealSkuId ? first(plan.mealChild) : null,
      minStay: first(dayPlan?.minStay, dayType?.minStay, season?.minStay), closedToArrival: Boolean(dayPlan?.closedToArrival || dayType?.closedToArrival),
      stopSell: Boolean(dayPlan?.stopSell || dayType?.stopSell),
    };
  });
}

// What a stay may not do on the calendar, the first refusal or null: a night not sold (stop-sell), an arrival on a
// day closed to arrival, or fewer nights than the arrival day's minimum stay. `only`: the nights being added (an
// extension checks only stop-sell on them).
function restriction(rows, { arrival, nights, only = null }) {
  const sold = rows.filter((r) => !only || only.includes(r.night)).find((r) => r.stopSell);
  if (sold) return { reason: 'stop_sell', night: sold.night };
  if (only) return null;
  const arriving = rows.find((r) => r.night === arrival);
  if (arriving?.closedToArrival) return { reason: 'closed_to_arrival', night: arrival };
  if (arriving && given(arriving.minStay) && nights < arriving.minStay) return { reason: 'min_stay', night: arrival, minStay: arriving.minStay };
  return null;
}

// A night's rates as the database keeps them (rupees) for the counting (paise).
const nightRow = (row) => ({ night: typeof row.night === 'string' ? row.night.slice(0, 10) : row.night, rateKind: row.rate_kind, roomRate: paise(row.room_rate),
  extraAdult: paiseOrNull(row.extra_adult_rate), child: paiseOrNull(row.child_rate), extraBed: paiseOrNull(row.extra_bed_rate),
  mealSkuId: given(row.meal_sku_id) ? Number(row.meal_sku_id) : null, mealAdult: paiseOrNull(row.meal_adult_rate), mealChild: paiseOrNull(row.meal_child_rate) });

// A discount of a percentage off a value, to the paisa (halves up).
const discountOf = (value, percent) => (given(percent) && Number(percent) > 0 ? roundedDivide(BigInt(value) * BigInt(basis(percent)), 10000n) : 0);

// One night (or a day use) priced from its rates: its value with the extra persons, the discount off it, what is
// charged, the slab that decides and its GST; and its meals (before GST; their GST at the meal item's rate, `mealRate`).
// party: { adults, children, extraBeds, baseOccupancy }.
function priceRow(row, party, settings, percent = null, mealRate = null) {
  const dayUse = row.rateKind === 'day_use';
  const extraAdults = dayUse ? 0 : Math.max(0, Number(party.adults) - Number(party.baseOccupancy));
  const children = dayUse ? 0 : Number(party.children || 0);
  const extraBeds = dayUse ? 0 : Number(party.extraBeds || 0);
  const value = row.roomRate + extraAdults * (row.extraAdult || 0) + children * (row.child || 0) + extraBeds * (row.extraBed || 0);
  const discount = discountOf(value, percent);
  const amount = value - discount;
  const slab = slabFor(amount, settings.slabs);
  const meal = row.mealSkuId ? Number(party.adults) * (row.mealAdult || 0) + Number(party.children || 0) * (row.mealChild || 0) : 0;
  return { night: row.night, weekend: row.weekend, rateKind: row.rateKind, roomRate: row.roomRate, extraAdults, children, extraBeds, value, discount, amount, slab,
    net: amount, tax: taxOn(amount, slab.rate), mealSkuId: row.mealSkuId, meal, mealTax: meal && given(mealRate) ? taxOn(meal, mealRate) : 0 };
}

// Every night of a stay priced, with its meals, and added up: { nights, subtotal, tax, total, roomSubtotal }.
function estimateRows(rows, party, settings, percent = null, mealRate = null) {
  const nights = rows.map((row) => priceRow(row, party, settings, percent, mealRate));
  const subtotal = nights.reduce((sum, n) => sum + n.net + n.meal, 0);
  const tax = nights.reduce((sum, n) => sum + n.tax + n.mealTax, 0);
  return { nights, subtotal, tax, total: subtotal + tax, roomSubtotal: nights.reduce((sum, n) => sum + n.net, 0) };
}

// --- Policies --------------------------------------------------------------------------------------
//
// What a policy charges, worked out from the stay's room nights (their values
// after the discount, before GST; meals and extras are not in them):
//   early check-in / late check-out   a percentage of the night's value, a flat fee, or a full night
//   cancellation      free until the policy's hours before the arrival, then so
//                     many of the first nights or a percentage of the stay; a plan
//                     that is not refundable: the full stay, whenever cancelled
//   no-show           the first night, or the full stay (not refundable: the full stay)
//   deposit           a percentage of the stay's total, or the first night with its GST
const percentOf = (value, percent) => roundedDivide(BigInt(value) * BigInt(basis(percent)), 10000n);
function timeCharge(kind, value, nightValue) {
  if (kind === 'percent') return percentOf(nightValue, value);
  if (kind === 'flat') return paise(value);
  if (kind === 'night') return nightValue;
  return 0;
}
// policy: the stay's (camel case, rupees); values: the room nights' values (paise) in order; hoursBefore: the hours left to the arrival.
function cancelCharge(policy, values, hoursBefore) {
  const all = values.reduce((s, x) => s + x, 0);
  if (!policy) return { amount: 0, rule: null };
  if (policy.refundable === false) return { amount: all, rule: 'not_refundable' };
  if (!policy.cancelKind) return { amount: 0, rule: null };
  if (hoursBefore >= Number(policy.cancelFreeHours)) return { amount: 0, rule: 'free' };
  const amount = policy.cancelKind === 'nights' ? values.slice(0, Number(policy.cancelValue)).reduce((s, x) => s + x, 0) : percentOf(all, policy.cancelValue);
  return { amount, rule: policy.cancelKind };
}
function noShowCharge(policy, values) {
  const all = values.reduce((s, x) => s + x, 0);
  if (!policy) return { amount: 0, rule: null };
  if (policy.refundable === false || policy.noShowKind === 'full_stay') return { amount: all, rule: policy.refundable === false ? 'not_refundable' : 'full_stay' };
  if (policy.noShowKind === 'first_night') return { amount: values[0] || 0, rule: 'first_night' };
  return { amount: 0, rule: null };
}
// total: the stay's total with GST; firstNight: the first night with its GST.
function depositDue(policy, { total, firstNight }) {
  if (!policy?.depositKind) return 0;
  return policy.depositKind === 'percent' ? percentOf(total, policy.depositValue) : firstNight;
}

module.exports = { paise, rupees, milli, taxOn, netOf, addDays, nightCount, nightsOf, isoDay, ratesOf, nightValue, slabFor, priceNight, estimate, extraFigures,
  billFigures, figuresText, billLines, resolveNights, restriction, nightRow, discountOf, priceRow, estimateRows, timeCharge, cancelCharge, noShowCharge, depositDue };
