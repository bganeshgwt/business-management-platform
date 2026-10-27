// An owner's GST thresholds: the arithmetic, the dates and the words, pure (no
// database). Money is whole paise; a day is YYYY-MM-DD on a business's own
// clock. The figures themselves (₹5 crore, ₹10 crore, the 30 days, the 6
// digits) are never written here: they are rows of platform_gst_thresholds,
// read by the service and passed in.

const AppError = require('../../../utils/AppError');
const { gstinProblem } = require('../../../utils/gstin');

const fail = (message, status = 400) => { throw new AppError(status, message); };

// --- PAN --------------------------------------------------------------------------------

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// The PAN a GSTIN carries (its characters 3 to 12), or null when the text is
// not a valid GSTIN (a restaurant's GST number is typed freely, so it may not be).
function panOfGstin(text) {
  const gstin = String(text ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!gstin || gstinProblem(gstin)) return null;
  return gstin.slice(2, 12);
}

// A PAN an owner types: in capitals, the spaces taken out; empty is none.
function readPan(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const pan = String(value).replace(/\s/g, '').toUpperCase();
  if (!PAN.test(pan)) fail('PAN must look like ABCDE1234F: five letters, four digits and a letter');
  return pan;
}

// A PAN shown to someone who is not an owner: its last four characters only.
const maskPan = (pan) => (pan ? `••••••${String(pan).slice(-4)}` : null);

// Where a business's PAN comes from, never a guess: its GSTINs (its own and
// its locations' or outlets'), all carrying one PAN; else the PAN its owner
// recorded while it has no GSTIN; else none, with the reason.
//   gstins    every GSTIN text the business keeps (empty ones left out)
//   recorded  the PAN its owner recorded, or null
// Returns { pan, source: 'gstin' | 'recorded' | null, reason: null | 'gstins_differ' | 'gstin_invalid' | 'no_gstin', pans }.
function panSource({ gstins = [], recorded = null }) {
  const texts = gstins.filter((text) => String(text ?? '').trim() !== '');
  const pans = [...new Set(texts.map(panOfGstin).filter(Boolean))].sort();
  if (pans.length > 1) return { pan: null, source: null, reason: 'gstins_differ', pans };
  if (pans.length === 1) return { pan: pans[0], source: 'gstin', reason: null, pans };
  if (recorded) return { pan: recorded, source: 'recorded', reason: null, pans };
  return { pan: null, source: null, reason: texts.length ? 'gstin_invalid' : 'no_gstin', pans };
}

// --- Days and the financial year ----------------------------------------------------------

function addDays(day, days) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10);
}
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// A day as a sentence says it: "1 April 2027".
function longDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// The financial year (April to March) a day falls in: { label: '2026-27', from, to }.
function financialYear(day) {
  const [y, m] = String(day).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return { label: `${start}-${String((start + 1) % 100).padStart(2, '0')}`, from: `${start}-04-01`, to: `${start + 1}-03-31` };
}
const yearBefore = (year) => financialYear(addDays(year.from, -1));
const yearAfterFrom = (year) => addDays(year.to, 1);

// The year's turnover at the pace so far: what was sold from the later of
// 1 April and the day the business came onto the platform up to today,
// spread over the days to 31 March. Nothing sold yet projects nothing.
function projection(soFar, { year, today, startedOn = null }) {
  if (soFar <= 0) return soFar;
  const start = startedOn && startedOn > year.from ? startedOn : year.from;
  if (today < start) return soFar;
  const elapsed = BigInt(daysBetween(start, today) + 1);
  const span = BigInt(daysBetween(start, year.to) + 1);
  // Half a paisa up.
  return Number((BigInt(soFar) * span * 2n + elapsed) / (elapsed * 2n));
}

// --- Money ------------------------------------------------------------------------------------

// A decimal text of rupees (as PostgreSQL sends NUMERIC) in whole paise, exactly.
function toPaise(text) {
  const value = String(text ?? '0').trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2})\d*)?$/.exec(value);
  if (!match) return Math.round(Number(value) * 100);
  const amount = Number(match[2]) * 100 + Number((match[3] || '0').padEnd(2, '0'));
  return match[1] ? -amount : amount;
}
const rupees = (paise) => `${paise < 0 ? '-' : ''}${(Math.abs(paise) / 100).toFixed(2)}`;

// Large sums the way they are said in India: ₹5 crore, ₹4.25 crore, ₹82.5 lakh, ₹45,000.
function bigMoney(paise) {
  const value = paise / 100;
  const trim = (n) => n.toFixed(2).replace(/\.?0+$/, '');
  if (Math.abs(value) >= 1e7) return `₹${trim(value / 1e7)} crore`;
  if (Math.abs(value) >= 1e5) return `₹${trim(value / 1e5)} lakh`;
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// --- The thresholds ------------------------------------------------------------------------------

// The figures in force on a day, one per code (the latest whose date has
// come; one with no date is in force), grouped into steps: the turnover they
// are measured against, and whether a rule applies above it or at it and above.
// `rows` are platform_gst_thresholds rows ({ code, turnover as text, comparison, applies_from, … }).
function stepsOn(rows, day) {
  const latest = new Map();
  for (const row of rows) {
    if (row.applies_from && row.applies_from > day) continue;
    const kept = latest.get(row.code);
    if (!kept || (row.applies_from || '') > (kept.applies_from || '')) latest.set(row.code, row);
  }
  const steps = new Map();
  for (const row of latest.values()) {
    const key = `${toPaise(row.turnover)}|${row.comparison}`;
    if (!steps.has(key)) steps.set(key, { figure: toPaise(row.turnover), comparison: row.comparison, rules: [] });
    steps.get(key).rules.push(row);
  }
  return [...steps.values()]
    .map((step) => ({ ...step, rules: step.rules.sort((a, b) => Number(a.id) - Number(b.id)) }))
    .sort((a, b) => a.figure - b.figure || a.comparison.localeCompare(b.comparison));
}

const passes = (amount, step) => (step.comparison === 'above' ? amount > step.figure : amount >= step.figure);

// Where a PAN's turnover stands against each step. A figure's rules apply in
// a financial year when the year before passed it (as the research reads the
// notifications: e-invoicing from 1 April 2026 for a turnover above ₹5 crore
// in 2025-26). So a step is crossed when last year's whole turnover passed it
// (by: 'last_year': its rules apply now) or this year's turnover so far has
// (by: 'this_year': they apply from the next 1 April, appliesFrom); near when
// this year so far has reached the warning level, a whole percent of it; else
// below. And whether the pace so far passes it by 31 March.
//   year  the financial year of thisYear (financialYear)
function standing(steps, { thisYear, lastYear, projected, warnPercent, year }) {
  return steps.map((step) => {
    const before = passes(lastYear, step);
    const now = passes(thisYear, step);
    const warnAt = Math.ceil((step.figure * warnPercent) / 100);
    const state = before || now ? 'crossed' : thisYear >= warnAt ? 'near' : 'below';
    return {
      ...step,
      state,
      by: before ? 'last_year' : now ? 'this_year' : null,
      // The day its rules apply from when that is still to come: the next 1 April, once this year so far has passed it.
      appliesFrom: !before && now ? yearAfterFrom(year) : null,
      warnAt,
      // This year so far as a share of the figure, to one decimal, rounded down.
      share: step.figure > 0 ? Math.floor((Math.max(thisYear, 0) * 1000) / step.figure) / 10 : 0,
      onPace: state !== 'crossed' && passes(projected, step),
    };
  });
}

// How serious a step's standing is: its rules applying now, then from the
// next 1 April, then nearing it, then below.
const level = (step) => (step.state === 'crossed' ? (step.by === 'last_year' ? 3 : 2) : step.state === 'near' ? 1 : 0);
// The more serious of two standings of the same step (two owners' views of one business).
const moreSerious = (a, b) => (level(b) > level(a) ? b : a);

// Whether the rule of this code applies, now or from the next 1 April (its
// step crossed): { rule, now, from } with `from` that day while it is still
// to come (null when it applies now); null when it does not apply.
function applying(steps, code) {
  for (const step of steps) {
    const rule = step.rules.find((r) => r.code === code);
    if (rule) return step.state === 'crossed' ? { rule, now: step.by === 'last_year', from: step.appliesFrom } : null;
  }
  return null;
}

// --- Words ---------------------------------------------------------------------------------------

// A figure's name inside a sentence: "E-invoicing" is "e-invoicing", "The 30-day
// limit…" "the 30-day limit…"; an acronym stays as it is.
const sentenceName = (name) => (/^.[a-z-]/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name);
const listWords = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// A step in one sentence, with the years it is about:
//   passed last year     "Turnover passed ₹5 crore in 2025-26: e-invoicing and 6-digit HSN / SAC codes on invoices apply"
//   passed this year     "Turnover has passed ₹5 crore in 2026-27 so far: from 1 April 2027, e-invoicing and … apply"
//   nearing it           "Turnover is nearing ₹5 crore in 2026-27: above ₹5 crore, e-invoicing and … apply from 1 April 2027"
// (₹10 crore, measured at it and above: "reached", "at ₹10 crore").
function stepWords(step, { year, lastYear }) {
  const names = listWords(step.rules.map((rule) => sentenceName(rule.name)));
  const verb = step.rules.length === 1 ? 'applies' : 'apply';
  const figure = bigMoney(step.figure);
  const above = step.comparison === 'above';
  const nextYear = longDay(yearAfterFrom(year));
  if (step.state === 'crossed' && step.by === 'last_year') return `Turnover ${above ? 'passed' : 'reached'} ${figure} in ${lastYear.label}: ${names} ${verb}`;
  if (step.state === 'crossed') return `Turnover has ${above ? 'passed' : 'reached'} ${figure} in ${year.label} so far: from ${nextYear}, ${names} ${verb}`;
  if (step.state === 'near') return `Turnover is nearing ${figure} in ${year.label}: ${above ? 'above' : 'at'} ${figure}, ${names} ${verb} from ${nextYear}`;
  return `Turnover is below ${figure}`;
}

// The bell's lines for one PAN's standing: one for each step it is near or
// past, a critical one once passed (its rules apply now, or from the next
// 1 April: the moment to prepare). A line's id carries the year, the figure and
// the standing, so passing a figure, and its rules coming to apply now, are
// news again after a warning was read.
//   prefix   the alert ids' first part (a provider's key)
//   pan      as this person may see it (in full for an owner, else masked)
//   figures  { thisYear, lastYear, businesses } when this person may see every
//            business's money under the PAN, else null (the warning without sums)
//   link     where the alert opens: a function of the step, or a path
function alerts({ steps, year, lastYear, pan, figures, link, prefix, today }) {
  return steps.filter((step) => step.state !== 'below').map((step) => {
    const when = step.by === 'last_year' ? `in ${lastYear.label}` : `in ${year.label} so far`;
    const sums = figures
      ? (step.by === 'last_year'
        ? `${bigMoney(figures.lastYear)} in ${lastYear.label}`
        : `${bigMoney(figures.thisYear)} in ${year.label} so far, ${step.share}% of ${bigMoney(step.figure)}`)
        + `, across ${figures.businesses} ${figures.businesses === 1 ? 'business' : 'businesses'}`
      : `the businesses under this PAN together, ${when}`;
    return {
      id: `${prefix}:${year.label}:${step.figure / 100}:${step.state}${step.by ? `:${step.by}` : ''}`,
      severity: step.state === 'crossed' ? 'critical' : 'warning',
      category: 'GST',
      title: stepWords(step, { year, lastYear }),
      detail: `PAN ${pan} · ${sums}`,
      link: typeof link === 'function' ? link(step) : link,
      at: `${today}T00:00:00.000Z`,
    };
  });
}

module.exports = {
  panOfGstin, readPan, maskPan, panSource,
  addDays, daysBetween, longDay, financialYear, yearBefore, yearAfterFrom, projection,
  toPaise, rupees, bigMoney,
  stepsOn, standing, level, moreSerious, applying, stepWords, alerts,
};
