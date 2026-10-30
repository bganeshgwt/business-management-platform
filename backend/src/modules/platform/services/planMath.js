// The arithmetic of paid plans, in whole paise (BigInt) and calendar dates
// ("YYYY-MM-DD", no clock). Pure functions: the services read the rows and
// the business's today; these only count.
//
//   periodEnd        the last day of a month or a year from its first day
//   addOnCharge      an add-on bought mid-period: its full price for the
//                    period times the days left over the days in the period
//   gstSplit         CGST and SGST (each half) within the supplier's state,
//                    IGST to another state
//   fiscalYearOf     April to March, written "2627" as on Indian invoices
//   invoiceNumber    "<prefix>/<FY>/<n>", at most 16 characters (GST)
//   upiLink          the UPI payment link an owner pays an order with

// The sample GSTIN the company's invoices carry until the real one is entered:
// the well-known dummy PAN AAAAA0000A, state 22, with a valid check character.
// An invoice under it is a sample, never a tax invoice.
const SAMPLE_GSTIN = '22AAAAA0000A1ZC';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const parts = (date) => {
  const match = DATE.exec(String(date));
  if (!match) throw new Error(`Not a date: ${date}`);
  const [y, m, d] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new Error(`Not a date: ${date}`);
  return { y, m, d };
};
const text = (at) => at.toISOString().slice(0, 10);
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// A date moved by whole days.
const addDays = (date, days) => {
  const { y, m, d } = parts(date);
  return text(new Date(Date.UTC(y, m - 1, d + Number(days))));
};

// Days from one date to another, both included.
const daysBetweenInclusive = (from, to) => {
  const a = parts(from);
  const b = parts(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000) + 1;
};

// The day before the same date a month (or a year) later. When the later
// month has no such date (31 January, 29 February), its last day: 31 Jan runs
// to 28 Feb (29 in a leap year), 29 Feb 2028 to 28 Feb 2029.
const periodEnd = (startsOn, billingPeriod) => {
  if (billingPeriod !== 'month' && billingPeriod !== 'year') throw new Error('A period is a month or a year');
  const { y, m, d } = parts(startsOn);
  const months = billingPeriod === 'month' ? 1 : 12;
  const ty = y + Math.floor((m - 1 + months) / 12);
  const tm = ((m - 1 + months) % 12) + 1;
  if (d > lastDayOf(ty, tm)) return text(new Date(Date.UTC(ty, tm - 1, lastDayOf(ty, tm))));
  return text(new Date(Date.UTC(ty, tm - 1, d - 1)));
};

// round(full x daysLeft / periodDays), a half paisa up.
const addOnCharge = (fullPricePaise, daysLeft, periodDays) => {
  const left = Number(daysLeft);
  const days = Number(periodDays);
  if (!Number.isInteger(days) || days < 1 || !Number.isInteger(left) || left < 1 || left > days) throw new Error('The days left must be 1 to the days in the period');
  const full = BigInt(fullPricePaise);
  return (full * BigInt(left) * 2n + BigInt(days)) / (2n * BigInt(days));
};

// A GST rate ("18", "18.00", 12.5) in hundredths of a per cent.
const rateHundredths = (ratePercent) => {
  const value = String(ratePercent ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value) || Number(value) > 100) throw new Error(`Not a GST rate: ${ratePercent}`);
  return BigInt(Math.round(Number(value) * 100));
};

// Same state: CGST = SGST = round(taxable x rate/2 %). Otherwise IGST =
// round(taxable x rate %). Half a paisa rounds up.
const gstSplit = (taxablePaise, ratePercent, supplierState, buyerState) => {
  const taxable = BigInt(taxablePaise);
  const rate = rateHundredths(ratePercent);
  if (String(supplierState) === String(buyerState)) {
    const half = (taxable * rate + 10000n) / 20000n;
    return { cgst: half, sgst: half, igst: 0n };
  }
  return { cgst: 0n, sgst: 0n, igst: (taxable * rate + 5000n) / 10000n };
};

// "2027-03-31" -> "2627"; "2027-04-01" -> "2728".
const fiscalYearOf = (date) => {
  const { y, m } = parts(date);
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
};

// The real series pads its number to 5 digits, the sample series to 4; a
// long prefix gets less padding, and a number that cannot fit in 16
// characters is refused (GST allows no more).
const invoiceNumber = (prefix, fiscalYear, n) => {
  const head = `${prefix}/${fiscalYear}/`;
  const digits = String(n);
  const padding = Math.max(digits.length, Math.min(prefix === 'SAMPLE' ? 4 : 5, 16 - head.length));
  const number = `${head}${digits.padStart(padding, '0')}`;
  if (number.length > 16) throw new Error(`Invoice number ${number} is longer than 16 characters`);
  return number;
};

const isSampleGstin = (gstin) => String(gstin ?? '').trim().toUpperCase() === SAMPLE_GSTIN;

// Whole paise from rupees ("4999.00", 1259.64), and back ("8257.64").
const toPaise = (rupees) => {
  const value = typeof rupees === 'number' ? rupees.toFixed(2) : String(rupees ?? '').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`Not an amount in rupees and paise: ${rupees}`);
  const paise = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] ? -paise : paise;
};
const toRupees = (paise) => {
  const value = BigInt(paise);
  const sign = value < 0n ? '-' : '';
  const whole = value < 0n ? -value : value;
  return `${sign}${whole / 100n}.${String(whole % 100n).padStart(2, '0')}`;
};

// upi://pay?pa=<UPI ID>&pn=<payee>&am=<rupees>&cu=INR&tn=<note>.
const upiLink = ({ upiId, payee, amountPaise, note }) =>
  `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}&am=${toRupees(amountPaise)}&cu=INR&tn=${encodeURIComponent(note)}`;

module.exports = {
  SAMPLE_GSTIN, addDays, daysBetweenInclusive, periodEnd, addOnCharge, gstSplit, fiscalYearOf, invoiceNumber, isSampleGstin, toPaise, toRupees, upiLink,
};
