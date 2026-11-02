// The offline till's rules that need no database: its bill numbers, the
// financial year a moment falls in, the business date of a moment, whether a
// bill's time is inside the allowed window, and the GST rate in force on a
// day. The staff app keeps the same rules for the till itself
// (apps/business-web/src/modules/business/till/tillRules.js); the unit tests
// run both on the same cases (tests/till-rules.test.js).

// "2026" -> "2627": the year as Indian invoices print it.
const fiscalLabel = (year) => `${String(year % 100).padStart(2, '0')}${String((year + 1) % 100).padStart(2, '0')}`;

// The financial year (by the year it starts in) of a business date, with the
// business's year starting in `startMonth` (4: April).
function fiscalYearOf(day, startMonth = 4) {
  const [year, month] = String(day).split('-').map(Number);
  return month >= Number(startMonth || 4) ? year : year - 1;
}

const PADDING = 5;
// A till's bill number: its code, the year and five digits, "T2/2627/00001".
const billNumber = (code, year, seq) => `${code}/${fiscalLabel(year)}/${String(seq).padStart(PADDING, '0')}`;

// { code, label, seq } from a bill number, or null when it is not a till's.
function readBillNumber(text) {
  const match = /^(T[1-9][0-9]{0,2})\/([0-9]{4})\/([0-9]{5,8})$/.exec(String(text || ''));
  return match ? { code: match[1], label: match[2], seq: Number(match[3]) } : null;
}

// The business's date (YYYY-MM-DD) at a moment, in its own time zone.
const dayOf = (instant, timezone = 'Asia/Kolkata') => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(instant));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A till's clock may be a few minutes off even after it is set by the server's.
const CLOCK_GRACE = 5 * MINUTE;

// Why a bill's time is outside the allowed window, or null: made after it
// arrived (the till's clock ahead), before the till was set up, or later
// into an offline spell than the business allows (its stop limit).
function timeProblem({ madeAt, receivedAt, registeredAt, offlineSince = null, stopHours = 72 }) {
  const made = Date.parse(madeAt);
  if (made > Date.parse(receivedAt) + CLOCK_GRACE) return { why: 'future', words: 'Made later than it arrived: the till\'s clock is ahead.' };
  if (registeredAt && made < Date.parse(registeredAt) - CLOCK_GRACE) return { why: 'before', words: 'Made before the till was set up: the till\'s clock is behind.' };
  if (offlineSince && made - Date.parse(offlineSince) > stopHours * HOUR + 10 * MINUTE) {
    return { why: 'limit', words: `Made more than ${stopHours} hours into the till's time offline, past the business's limit.` };
  }
  return null;
}

// The GST rate of an item on a day: the rate a change moved it to (the latest
// whose date has come by then, applied or still scheduled), else the rate it
// had before the first change after that day, else its rate now.
//   changes: [{ startsOn: 'YYYY-MM-DD', rate (the change's), fromRate (once applied) }]
function rateOn(current, changes, day) {
  const sorted = [...(changes || [])].sort((a, b) => String(a.startsOn).localeCompare(String(b.startsOn)));
  const before = sorted.filter((change) => String(change.startsOn) <= day);
  if (before.length) return Number(before[before.length - 1].rate);
  const after = sorted.find((change) => change.fromRate !== null && change.fromRate !== undefined);
  return after ? Number(after.fromRate) : Number(current);
}

module.exports = { fiscalLabel, fiscalYearOf, billNumber, readBillNumber, dayOf, timeProblem, rateOn, PADDING, CLOCK_GRACE };
