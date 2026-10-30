const { test } = require('node:test');
const assert = require('node:assert/strict');

const DATABASE = require.resolve('../src/config/database');
const math = require('../src/modules/platform/services/planMath');

// The arithmetic of paid plans, without the database: when a paid period
// ends, what an add-on costs for the days left, the GST split, the company's
// invoice numbers and financial year, the sample GSTIN and the UPI link an
// owner pays with.

test('the counting loads no database', () => {
  assert.equal(require.cache[DATABASE], undefined);
});

test('a month ends the day before the same date next month, or on the last day of a month too short for it', () => {
  assert.equal(math.periodEnd('2026-01-31', 'month'), '2026-02-28');
  assert.equal(math.periodEnd('2028-01-31', 'month'), '2028-02-29');
  assert.equal(math.periodEnd('2026-01-29', 'month'), '2026-02-28');
  assert.equal(math.periodEnd('2026-01-28', 'month'), '2026-02-27');
  assert.equal(math.periodEnd('2026-02-01', 'month'), '2026-02-28');
  assert.equal(math.periodEnd('2026-03-31', 'month'), '2026-04-30');
  assert.equal(math.periodEnd('2026-12-31', 'month'), '2027-01-30');
  assert.equal(math.periodEnd('2026-12-15', 'month'), '2027-01-14');
});

test('a year ends the day before the same date next year; 29 February runs to 28 February', () => {
  assert.equal(math.periodEnd('2026-10-30', 'year'), '2027-10-29');
  assert.equal(math.periodEnd('2027-03-01', 'year'), '2028-02-29');
  assert.equal(math.periodEnd('2028-02-29', 'year'), '2029-02-28');
  assert.equal(math.periodEnd('2026-01-01', 'year'), '2026-12-31');
  assert.throws(() => math.periodEnd('2026-10-30', 'week'), /a month or a year/);
  assert.throws(() => math.periodEnd('2026-02-30', 'month'), /date/);
});

test('days are counted with both ends', () => {
  assert.equal(math.daysBetweenInclusive('2026-10-30', '2027-10-29'), 365);
  assert.equal(math.daysBetweenInclusive('2028-01-01', '2028-12-31'), 366);
  assert.equal(math.daysBetweenInclusive('2026-11-05', '2026-11-05'), 1);
  assert.equal(math.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(math.addDays('2026-03-01', -1), '2026-02-28');
});

test('an add-on bought mid-period costs its full price for the days left, to the paisa, half up', () => {
  assert.equal(math.addOnCharge(199900n, 10, 365), 5477n);
  assert.equal(math.addOnCharge(199900n, 365, 365), 199900n);
  assert.equal(math.addOnCharge(19900n, 15, 30), 9950n);
  // 1 x 1 / 2 is half a paisa: it rounds up.
  assert.equal(math.addOnCharge(1n, 1, 2), 1n);
  assert.equal(math.addOnCharge(0n, 10, 30), 0n);
  assert.throws(() => math.addOnCharge(199900n, 0, 365), /days/);
  assert.throws(() => math.addOnCharge(199900n, 366, 365), /days/);
});

test('GST: CGST and SGST each half within the supplier\'s state, IGST to another state', () => {
  assert.deepEqual(math.gstSplit(499900n, '18', '29', '29'), { cgst: 44991n, sgst: 44991n, igst: 0n });
  assert.deepEqual(math.gstSplit(499900n, '18', '22', '29'), { cgst: 0n, sgst: 0n, igst: 89982n });
  assert.deepEqual(math.gstSplit(699800n, '18.00', '22', '29'), { cgst: 0n, sgst: 0n, igst: 125964n });
  // Each half is rounded on its own: 0.45 paise is no paisa, 0.9 is one.
  assert.deepEqual(math.gstSplit(5n, '18', '27', '27'), { cgst: 0n, sgst: 0n, igst: 0n });
  assert.deepEqual(math.gstSplit(5n, '18', '27', '09'), { cgst: 0n, sgst: 0n, igst: 1n });
  assert.deepEqual(math.gstSplit(100000n, '0', '27', '27'), { cgst: 0n, sgst: 0n, igst: 0n });
  assert.throws(() => math.gstSplit(100n, 'eighteen', '27', '27'), /rate/);
});

test('the financial year runs April to March, written as on Indian invoices', () => {
  assert.equal(math.fiscalYearOf('2027-03-31'), '2627');
  assert.equal(math.fiscalYearOf('2027-04-01'), '2728');
  assert.equal(math.fiscalYearOf('2099-12-31'), '9900');
});

test('invoice numbers: prefix, year and number, at most 16 characters', () => {
  assert.equal(math.invoiceNumber('BMP', '2627', 1), 'BMP/2627/00001');
  assert.equal(math.invoiceNumber('SAMPLE', '2627', 1), 'SAMPLE/2627/0001');
  assert.equal(math.invoiceNumber('BMP', '2627', 123456), 'BMP/2627/123456');
  // A long prefix shrinks the padding to fit.
  assert.equal(math.invoiceNumber('ACME-SOFT', '2627', 7), 'ACME-SOFT/2627/7');
  assert.equal(math.invoiceNumber('ACMESOFT', '2627', 42), 'ACMESOFT/2627/42');
  assert.throws(() => math.invoiceNumber('ACME-SOFTW', '2627', 1), /16 characters/);
  assert.throws(() => math.invoiceNumber('ACME-SOFT', '2627', 12), /16 characters/);
});

test('the sample GSTIN is known wherever it is read', () => {
  assert.equal(math.SAMPLE_GSTIN, '22AAAAA0000A1ZC');
  assert.equal(math.isSampleGstin('22AAAAA0000A1ZC'), true);
  assert.equal(math.isSampleGstin(' 22aaaaa0000a1zc '), true);
  assert.equal(math.isSampleGstin('29AAAAA0000A1Z9'), false);
  assert.equal(math.isSampleGstin(null), false);
});

test('the UPI link carries the payee, the amount in rupees, INR and the note, each encoded', () => {
  assert.equal(math.upiLink({ upiId: 'acme@okaxis', payee: 'Acme Soft', amountPaise: 589882n, note: 'Order 12' }),
    'upi://pay?pa=acme%40okaxis&pn=Acme%20Soft&am=5898.82&cu=INR&tn=Order%2012');
  assert.equal(math.upiLink({ upiId: 'a.b@ybl', payee: 'R & S', amountPaise: 100, note: 'x' }), 'upi://pay?pa=a.b%40ybl&pn=R%20%26%20S&am=1.00&cu=INR&tn=x');
});

test('rupees and paise convert exactly', () => {
  assert.equal(math.toPaise('4999.00'), 499900n);
  assert.equal(math.toPaise('0.5'), 50n);
  assert.equal(math.toPaise(1259.64), 125964n);
  assert.equal(math.toRupees(825764n), '8257.64');
  assert.equal(math.toRupees(5n), '0.05');
  assert.throws(() => math.toPaise('12.345'), /paise/);
});
