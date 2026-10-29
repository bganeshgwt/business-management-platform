// Interest on a farmer's overdue season credit, worked out to the paisa.
// Nothing here reads the database: the season's service gives each bill and
// what changed its balance, day by day on the business's own clock.
//
// The policy is the season's: none; after_due, a % a month on what is still
// owed after the season's due date; from_bill, a % a month on what is still
// owed from each bill's own date. It is simple interest, never on interest:
// each day after the start, up to and including the day it is worked out to,
// earns rate% / 30 of what was owed on the bill at the end of that day (its
// total, less returns and payments, plus refunds, up to that day; never less
// than nothing). Each bill's interest is rounded to the paisa, half up, once.

const DAY = 86400000;
const dayNumber = (day) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY);
const dayText = (n) => new Date(n * DAY).toISOString().slice(0, 10);

// rate: "2.00" (% a month, up to 2 decimal places) -> hundredths of a percent (200).
function rateHundredths(rate) {
  const text = String(rate ?? '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error(`Interest rate ${text} is not a % with up to 2 decimal places`);
  const [whole, part = ''] = text.split('.');
  return Number(whole) * 100 + Number(part.padEnd(2, '0'));
}

// bill: { documentId, documentNo, day (the bill's date), total (paise),
//   changes: [{ day, amount (paise; a return or payment is negative, a refund positive) }] }
// policy: { interest: 'after_due' | 'from_bill', rate: '2.00', dueOn }
// upTo: the day it is worked out to (the business's today).
// Returns { documentId, documentNo, from (the start: interest runs from the next day), days, owedDays (paise × days),
//   interest (paise), periods: [{ from, to, days, owed (paise) }] }
function billInterest(bill, policy, upTo) {
  const start = policy.interest === 'from_bill' ? bill.day : policy.dueOn;
  const out = { documentId: bill.documentId, documentNo: bill.documentNo, from: start, days: 0, owedDays: 0, interest: 0, periods: [] };
  if (policy.interest === 'none' || !start || upTo <= start) return out;
  const first = dayNumber(start) + 1, last = dayNumber(upTo);
  // What is owed at the end of each day: the total, then each change from its own day.
  const changes = [...bill.changes].map((c) => ({ day: dayNumber(c.day), amount: c.amount })).sort((a, b) => a.day - b.day);
  let owed = bill.total;
  let i = 0;
  while (i < changes.length && changes[i].day < first) { owed += changes[i].amount; i += 1; }
  let sum = 0n;
  let day = first;
  while (day <= last) {
    // Changes made on this day count for the whole of it.
    while (i < changes.length && changes[i].day === day) { owed += changes[i].amount; i += 1; }
    // The same amount owed until the day before the next change (or the last day).
    const next = i < changes.length ? Math.min(changes[i].day - 1, last) : last;
    const days = next - day + 1;
    const counted = Math.max(0, owed);
    if (counted > 0) {
      sum += BigInt(counted) * BigInt(days);
      out.periods.push({ from: dayText(day), to: dayText(next), days, owed: counted });
    }
    out.days += days;
    day = next + 1;
  }
  out.owedDays = Number(sum);
  // interest = Σ owed × rate% / 30 = Σ owed × hundredths / 300000, half up.
  const numerator = sum * BigInt(rateHundredths(policy.rate));
  out.interest = Number((numerator * 2n + 300000n) / 600000n);
  return out;
}

// Every bill of a season: { bills: [billInterest…], total (paise) }.
function seasonInterest(bills, policy, upTo) {
  const each = bills.map((bill) => billInterest(bill, policy, upTo));
  return { bills: each, total: each.reduce((sum, b) => sum + b.interest, 0) };
}

module.exports = { billInterest, seasonInterest, rateHundredths };
