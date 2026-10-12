// Shared pieces for the business definitions: how busy a day is, item rows,
// regular customers and suppliers.
const clock = require('../clock');
const { people, mobile, gstin } = require('../people');

// How busy a day is, as a multiple of an ordinary weekday.
// shape: { weekdays: [Sun..Sat factors], festivals: { 'YYYY-MM-DD': factor },
//          ranges: [[from, to, factor]], monthStart, growth }
function busy(day, shape) {
  let f = (shape.weekdays || [1, 1, 1, 1, 1, 1, 1])[clock.weekday(day)];
  for (const [d, factor] of Object.entries(shape.festivals || {})) if (d === day) f *= factor;
  for (const [from, to, factor] of shape.ranges || []) if (clock.between(day, from, to)) f *= factor;
  const date = Number(day.slice(8, 10));
  if (shape.monthStart && date <= 5) f *= shape.monthStart;
  if (shape.growth) f *= 1 + shape.growth * clock.daysBetween(clock.addDays(clock.today(), -90), day);
  return f;
}
const volume = (baseCount, shape) => (day, r) => r.around(baseCount * busy(day, shape), 0.18);

// [label, code, unit, mrp, gst, category, popularity, supplier, opts]
function items(rows) {
  return rows.map(([label, code, unit, mrp, gst, category, w, supplier, opts = {}]) => ({
    name: opts.name || label, label, code, unit, mrp, gst, category, w, supplier, ...opts,
    price: opts.price ?? mrp, mrpPrinted: opts.loose ? false : opts.mrpPrinted,
  }));
}

// Regular customers: { key, name, phone, udhaar, creditLimit, creditDays, visits, … }.
function regulars(region, count, seed, plan = {}) {
  const list = people(region, count, seed);
  return list.map((p, i) => {
    const kind = (plan.udhaar || [])[i] || null;
    return { key: `c${i + 1}`, name: p.name, phone: mobile(`${seed}|${i}`), visits: plan.visits ? plan.visits(i) : 1 + (i % 4 === 0 ? 2 : 0), udhaar: kind,
      creditLimit: kind ? String(plan.limit ? plan.limit(i, kind) : 5000) : undefined, creditDays: kind ? (plan.days ? plan.days(i, kind) : 15) : undefined,
      ...(plan.extra ? plan.extra(i, kind) : {}) };
  });
}

function supplier(key, name, state, seed, extra) {
  return { key, name, phone: mobile(`supplier|${seed}`), gstin: gstin(state, `supplier|${seed}`, extra.holder || 'F', name[0]), billPrefix: extra.prefix, ...extra };
}

module.exports = { busy, volume, items, regulars, supplier, gstin, mobile, people };
