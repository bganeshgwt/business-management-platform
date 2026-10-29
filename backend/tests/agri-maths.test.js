const { test } = require('node:test');
const assert = require('node:assert/strict');
const interest = require('../src/modules/business/agri/services/agriInterest');
const schemes = require('../src/modules/business/agri/services/agriSchemeMaths');
const dates = require('../src/modules/business/agri/services/agriDates');

// A farm-input shop's sums on fixed inputs: interest on overdue season credit
// to the paisa, what a company scheme's purchases earn, and a seed lot's
// validity in months. Worked by hand beside each case.

test('a seed lot\'s months: the same day, or the month\'s last day', () => {
  assert.equal(dates.addMonths('2026-03-15', 9), '2026-12-15');
  // 31 May + 9 months: February has no 31st, so its last day (29th in a leap year).
  assert.equal(dates.addMonths('2026-05-31', 9), '2027-02-28');
  assert.equal(dates.addMonths('2027-05-31', 9), '2028-02-29');
  // A retest's 6 months from 28 February is 28 August, not the 31st.
  assert.equal(dates.addMonths('2027-02-28', 6), '2027-08-28');
  assert.equal(dates.addMonths('2026-08-31', 6), '2027-02-28');
  assert.equal(dates.addMonths('2026-12-31', 1), '2027-01-31');
  assert.equal(dates.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dates.daysBetween('2026-10-01', '2026-11-01'), 31);
  assert.equal(dates.dateWords('2026-11-05'), '5 Nov 2026');
});

test('interest after the due date: a % a month on what is owed each day, to the paisa', () => {
  const policy = { interest: 'after_due', rate: '2.00', dueOn: '2026-09-10' };
  // 10,000 billed 2026-08-01; 4,000 paid 2026-09-20. Up to 2026-09-30: 9 days
  // (11th to 19th) on 10,000 and 11 days (20th to 30th) on 6,000:
  // (1,000,000 × 9 + 600,000 × 11) paise-days × 2% / 30 = 10,400 paise.
  const a = interest.billInterest({ documentId: 1, documentNo: 'SI-1', day: '2026-08-01', total: 1000000, changes: [{ day: '2026-09-20', amount: -400000 }] }, policy, '2026-09-30');
  assert.deepEqual([a.from, a.days, a.owedDays, a.interest], ['2026-09-10', 20, 15600000, 10400]);
  assert.deepEqual(a.periods, [{ from: '2026-09-11', to: '2026-09-19', days: 9, owed: 1000000 }, { from: '2026-09-20', to: '2026-09-30', days: 11, owed: 600000 }]);
  // 5,000 for 20 days: 10,000,000 × 2% / 30 = 6,666.67 paise, so 6,667 (half up).
  const b = interest.billInterest({ documentId: 2, documentNo: 'SI-2', day: '2026-08-31', total: 500000, changes: [] }, policy, '2026-09-30');
  assert.equal(b.interest, 6667);
  assert.deepEqual(interest.seasonInterest([
    { documentId: 1, documentNo: 'SI-1', day: '2026-08-01', total: 1000000, changes: [{ day: '2026-09-20', amount: -400000 }] },
    { documentId: 2, documentNo: 'SI-2', day: '2026-08-31', total: 500000, changes: [] },
  ], policy, '2026-09-30').total, 17067);
  // Paid before the due date: only what was left earns interest; a refund adds back from its day.
  const c = interest.billInterest({ documentId: 3, documentNo: 'SI-3', day: '2026-08-01', total: 300000,
    changes: [{ day: '2026-09-01', amount: -100000 }, { day: '2026-09-25', amount: 50000 }] }, policy, '2026-09-30');
  // 200,000 × 14 (11th to 24th) + 250,000 × 6 (25th to 30th) = 4,300,000 × 2% / 30 = 2,866.67, so 2,867.
  assert.deepEqual([c.owedDays, c.interest], [4300000, 2867]);
  // Paid in full (or more) earns nothing from that day.
  const d = interest.billInterest({ documentId: 4, documentNo: 'SI-4', day: '2026-08-01', total: 100000, changes: [{ day: '2026-09-15', amount: -120000 }] }, policy, '2026-09-30');
  assert.deepEqual([d.owedDays, d.interest, d.periods.length], [400000, 267, 1]);
  // Not yet due, or worked out to the due date itself: none.
  assert.equal(interest.billInterest({ documentId: 5, documentNo: 'SI-5', day: '2026-08-01', total: 100000, changes: [] }, policy, '2026-09-10').interest, 0);
  assert.equal(interest.billInterest({ documentId: 5, documentNo: 'SI-5', day: '2026-08-01', total: 100000, changes: [] }, { ...policy, interest: 'none' }, '2026-12-31').interest, 0);
});

test('interest from each bill\'s date', () => {
  // 3,000 at 1.5% a month from 2026-08-16 to 2026-09-30: 45 days: 300,000 × 45 × 1.5% / 30 = 6,750 paise.
  const bill = { documentId: 1, documentNo: 'SI-9', day: '2026-08-16', total: 300000, changes: [] };
  const worked = interest.billInterest(bill, { interest: 'from_bill', rate: '1.5', dueOn: '2026-12-01' }, '2026-09-30');
  assert.deepEqual([worked.from, worked.days, worked.interest], ['2026-08-16', 45, 6750]);
  assert.equal(interest.rateHundredths('1.5'), 150);
  assert.equal(interest.rateHundredths('2'), 200);
  assert.throws(() => interest.rateHundredths('1.505'));
});

test('a company scheme: the highest slab reached sets the rebate on every unit; targets, free goods and gifts once reached', () => {
  const benefits = [
    { kind: 'per_unit', minQuantity: 0, rate: 200 }, { kind: 'per_unit', minQuantity: 100000, rate: 500 },
    { kind: 'target', minQuantity: 150000, amount: 50000 }, { kind: 'free_goods', minQuantity: 200000, freeSkuId: 7, freeQuantity: 5000 },
    { kind: 'gift', minQuantity: 150000, gift: 'Wall clock' },
  ];
  // 125 units: the 100 slab, ₹5 on each = ₹625; the target, free goods and gift still ahead.
  let result = schemes.earned(benefits, 125000);
  assert.deepEqual([result.rebate, result.targetAmount, result.money, result.freeGoods, result.gift], [62500, 0, 62500, null, null]);
  assert.deepEqual(result.next, [{ kind: 'target', minQuantity: 150000, short: 25000 }, { kind: 'free_goods', minQuantity: 200000, short: 75000 },
    { kind: 'gift', minQuantity: 150000, short: 25000 }]);
  // 99.5 units at ₹2: ₹199.00; 1.234 units at ₹2.50: 308.5 paise, so 309 (half up).
  assert.equal(schemes.earned(benefits, 99500).rebate, 19900);
  assert.equal(schemes.earned([{ kind: 'per_unit', minQuantity: 0, rate: 250 }], 1234).rebate, 309);
  // 200 units: everything reached.
  result = schemes.earned(benefits, 200000);
  assert.deepEqual([result.rebate, result.targetAmount, result.money, result.freeGoods, result.gift, result.next], [100000, 50000, 150000, { freeSkuId: 7, quantity: 5000 }, 'Wall clock', []]);
  // What is due once the claims received are set against it.
  const due = schemes.due(result, [
    { kind: 'money', amount: 150000, quantity: null, received: true, receivedAmount: 120000, receivedQuantity: 0 },
    { kind: 'free_goods', amount: null, quantity: 5000, received: false, receivedAmount: 0, receivedQuantity: 0 },
    { kind: 'gift', amount: null, quantity: null, received: true, receivedAmount: 0, receivedQuantity: 0 },
  ]);
  assert.deepEqual(due.money, { earned: 150000, claimed: 150000, received: 120000, awaited: 0, due: 30000, unclaimed: 0 });
  assert.deepEqual(due.freeGoods, { earned: 5000, claimed: 5000, received: 0, due: 5000 });
  assert.deepEqual(due.gift, { earned: 'Wall clock', claimed: true, received: true });
  // Nothing bought: the first slab (from 0) at nothing.
  assert.deepEqual([schemes.earned(benefits, 0).rebate, schemes.earned([], 50000).money], [0, 0]);
});
