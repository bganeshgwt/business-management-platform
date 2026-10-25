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
//                 each one back late
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

// The late fee of so many back late: { units, fee } (paise), from the minutes past the due time.
function lateFee({ minutes, grace, per, rate, quantity }) {
  if (per === 'none' || !rate || minutes <= Number(grace) || !quantity) return { units: 0, fee: 0 };
  const units = per === 'hour' ? Math.ceil(minutes / 60) : Math.ceil(minutes / 1440);
  return { units, fee: units * paise(rate) * quantity };
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

module.exports = { paise, rupees, HOURS, chargedHours, bestPrice, periodWords, lateWords, split, lateFee, billFigures, figuresText, today, billLines };
