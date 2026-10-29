// The core's GST arithmetic (loaded when first needed, so the counting here can be tried on its own).
const core = () => require('../../core/services/business.service');

// A hire's money, worked out exactly as the core works out a sale, in integer
// paise. Pure functions: the services read the rows, these only count.
//
//   the period    the hours charged: every hour or part of one from the out
//                 time to the due time, never less than the item's minimum
//   the price     the cheapest mix of the item's month (30 days), week (7
//                 days), day and hour rates that covers those hours: a 10-day
//                 hire is a week and 3 days when that costs less than 10 days,
//                 6 days a week when a week costs less than 6 days
//   a line        the price of one for the period times how many, in the
//                 business's price terms, with GST taken out of it (prices
//                 including GST) or put on it (before GST)
//   late          within the grace time nothing; after it, every hour (or
//                 day) or part of one since it was due, at the late rate, for
//                 each one back late; or by slabs: the slab the hours late
//                 fall in prices all of them (a flat amount and a multiple of
//                 the hourly rate for each hour); never more than the cap
//   kilometres    each kilometre (or part of one) beyond the allowance (so
//                 many a day of the hire, or a booking), at the extra rate
//   fuel          each eighth of a tank short of the level it went out with,
//                 at the rate for an eighth, or for each litre (an eighth of
//                 the tank's litres)
//   a percent     of a value, to the paisa (a discount, a cancellation charge)
//   the bill      one line a booking line's hire, one a late fee, one a charge,
//                 each at its item's GST rate of the day (a price before GST
//                 keeps its taxable value, one including GST its total)

const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const HOURS = { months: 720, weeks: 168, days: 24, hours: 1 };

// The hours a hire is charged for: from its minutes, each hour or part of one, at least the minimum (and one).
const chargedHours = (minutes, minHours = 0) => Math.max(1, Math.ceil(Math.max(0, minutes) / 60), Number(minHours) || 0);

// The cheapest mix of the rates given (paise; null when not offered) covering
// `hours`: { months, weeks, days, hours, price }. A larger block wins a tie.
function bestPrice(rates, hours) {
  const blocks = [['months', rates.month], ['weeks', rates.week], ['days', rates.day], ['hours', rates.hour]]
    .filter(([, rate]) => rate !== null && rate !== undefined).map(([name, rate]) => ({ name, size: HOURS[name], rate: Number(rate) }));
  if (!blocks.length) throw new Error('A rental item has at least one rate');
  const cost = new Array(hours + 1).fill(Infinity);
  const pick = new Array(hours + 1).fill(-1);
  cost[0] = 0;
  for (let t = 1; t <= hours; t += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      const c = cost[Math.max(0, t - blocks[b].size)] + blocks[b].rate;
      if (c < cost[t]) { cost[t] = c; pick[t] = b; }
    }
  }
  const mix = { months: 0, weeks: 0, days: 0, hours: 0 };
  for (let t = hours; t > 0;) {
    const block = blocks[pick[t]];
    mix[block.name] += 1;
    t = Math.max(0, t - block.size);
  }
  return { ...mix, price: cost[hours] };
}

// "1 week + 3 days", "5 hours", "2 months".
function periodWords({ months = 0, weeks = 0, days = 0, hours = 0 }) {
  const part = (n, one) => (n ? `${n} ${one}${n === 1 ? '' : 's'}` : null);
  return [part(months, 'month'), part(weeks, 'week'), part(days, 'day'), part(hours, 'hour')].filter(Boolean).join(' + ');
}
// "3 hours", "1 day" of lateness charged.
const lateWords = (units, per) => `${units} ${per}${units === 1 ? '' : 's'}`;

// A line's value in the price terms given (paise), split into before GST and GST at the rate.
function split(amount, taxRate, taxMode) {
  if (taxMode === 'inclusive') {
    const net = core().inclusiveNet(amount, Number(taxRate));
    return { net, tax: amount - net };
  }
  return { net: amount, tax: core().lineTax(amount, Number(taxRate)) };
}

// The slab the hours late fall in: the last whose start is before them.
const slabOf = (slabs, hours) => [...(slabs || [])].reverse().find((s) => Number(s.from) < hours) || null;

// The late fee of so many back late: { units, fee } (paise), from the minutes
// past the due time. `slabs` and `cap` as booked; `rate` the late rate (by
// slabs: the hourly rate their multiples apply to).
function lateFee({ minutes, grace, per, rate, quantity, slabs = null, cap = null }) {
  if (per === 'none' || minutes <= Number(grace) || !quantity) return { units: 0, fee: 0 };
  let units, one;
  if (per === 'slabs') {
    units = Math.ceil(minutes / 60);
    const slab = slabOf(slabs, units);
    if (!slab) return { units: 0, fee: 0 };
    const times = Math.round(Number(slab.times) * 100);
    one = paise(slab.flat) + Math.floor((times * paise(rate || 0) * units + 50) / 100);
  } else {
    if (!rate) return { units: 0, fee: 0 };
    units = per === 'hour' ? Math.ceil(minutes / 60) : Math.ceil(minutes / 1440);
    one = units * paise(rate);
  }
  if (cap !== null && cap !== undefined) one = Math.min(one, paise(cap));
  return { units, fee: one * quantity };
}

// The kilometres beyond the allowance and their charge (paise): `out` and `back`
// the odometer readings (to a tenth), the allowance a day of the hours charged
// (each 24 or part of them) or a booking.
function kmFee({ out, back, allowance, per, chargedHours, rate }) {
  if (!per || out === null || out === undefined || back === null || back === undefined) return { extra: 0, fee: 0 };
  const days = per === 'day' ? Math.max(1, Math.ceil(Number(chargedHours) / 24)) : 1;
  const tenths = Math.round(Number(back) * 10) - Math.round(Number(out) * 10) - Number(allowance) * days * 10;
  const extra = Math.max(0, Math.ceil(tenths / 10));
  return { extra, fee: extra * paise(rate) };
}

// A fuel level in eighths of a tank.
const EIGHTHS = { empty: 0, one_eighth: 1, quarter: 2, three_eighths: 3, half: 4, five_eighths: 5, three_quarters: 6, seven_eighths: 7, full: 8 };
// The fuel short of the level it went out with and its charge (paise): by the
// eighth, or by the litre (an eighth of the tank's litres), to the paisa.
function fuelFee({ out, back, per, rate, tank }) {
  if (!per || !out || !back) return { short: 0, fee: 0 };
  const short = Math.max(0, EIGHTHS[out] - EIGHTHS[back]);
  if (per === 'eighth') return { short, fee: short * paise(rate) };
  return { short, fee: Math.floor((short * Math.round(Number(tank) * 10) * paise(rate) + 40) / 80) };
}

// A percent of a value (paise), to the paisa.
const percentOf = (amount, percent) => Math.floor((amount * Math.round(Number(percent) * 100) + 5000) / 10000);

// The GST slab renting a vehicle without an operator takes, as the like goods'
// (from 22 September 2025): an electric vehicle 5%; a motorcycle up to 350 cc
// 18%, above it 40%; a car on petrol, LPG or CNG up to 1200 cc, or on diesel up
// to 1500 cc, and up to 4000 mm long 18%, any other car 40%. null when the
// vehicle's facts do not say.
function vehicleSlab({ vehicle, fuel, cc, length }) {
  if (fuel === 'electric') return 5;
  if (vehicle === 'motorcycle') return cc ? (Number(cc) <= 350 ? 18 : 40) : null;
  if (vehicle !== 'car' || !fuel || !cc || !length) return null;
  const small = Number(length) <= 4000 && Number(cc) <= (fuel === 'diesel' ? 1500 : 1200);
  return small ? 18 : 40;
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

// A value of the booking's price terms as a bill takes it today: GST at the item's rate now.
const today = (amount, rateNow, bookedMode) => split(amount, rateNow, bookedMode);

// The bill's lines for these values, in the business's price terms now (mode):
// each line's fixed prices are its own, so the bill adds up to them.
// value: { skuId, quantity, net, tax, label }.
function billLines(values, mode) {
  return values.map((value) => {
    const gross = value.net + (mode === 'inclusive' ? value.tax : 0);
    return {
      value,
      input: { skuId: value.skuId, quantity: String(value.quantity) },
      fixed: { price: Number(((gross / 100) / value.quantity).toFixed(4)), net: value.net, tax: value.tax, priceRuleId: null, enteredPrice: null, label: String(value.label).slice(0, 150) },
    };
  });
}

module.exports = { paise, rupees, HOURS, EIGHTHS, chargedHours, bestPrice, periodWords, lateWords, split, slabOf, lateFee, kmFee, fuelFee, percentOf, vehicleSlab, billFigures,
  figuresText, today, billLines };
