// The salesperson app's rules that need no database: the reasons a visit
// ends with no order, the distance between two places, a UPI reference and a
// cheque number as typed, a place sent by the phone, and the day's figures the
// office reads (calls, productive calls, strike rate, lines per call, beat
// adherence). The phone has its own copy of what it checks before sending
// (apps/business-web/src/workspaces/sales/salesRules.js); the server decides.

const AppError = require('../../../../utils/AppError');

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };

// Why a visit ended with no order: a fixed list, so the office can count them.
const NO_ORDER_REASONS = {
  shop_closed: 'Shop closed',
  owner_away: 'Owner not available',
  enough_stock: 'Enough stock',
  dues_or_hold: 'Dues pending or credit hold',
  price_or_scheme: 'Price or scheme',
  other_brand: 'Prefers another brand',
  order_later: 'Will order later',
  other: 'Other',
};

// Cash of ₹2,00,000 or more from one customer in a day is refused
// (Income-tax Act 2025, section 186): the database's own rule, in paise.
const CASH_LIMIT_PAISE = 20000000;

// The great-circle distance in whole metres between two places
// ({ latitude, longitude } in degrees), on the mean Earth radius.
function distanceMetres(a, b) {
  const rad = (deg) => (Number(deg) * Math.PI) / 180;
  const dLat = rad(b.latitude) - rad(a.latitude);
  const dLon = rad(b.longitude) - rad(a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h))));
}

// A place as the phone sends it: { latitude, longitude, accuracy } in
// degrees and metres, or null when none was sent. Six decimal places is about
// 11 cm, more than a phone knows.
function readPlace(value, name = 'Location') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be a latitude and a longitude`);
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) fail(`${name} is not a place on Earth`);
  const accuracy = value.accuracy === undefined || value.accuracy === null || value.accuracy === '' ? null : Number(value.accuracy);
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000)) fail(`${name}'s accuracy must be in metres`);
  return { latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)), accuracy: accuracy === null ? null : Math.round(accuracy) };
}

// The 12-digit UPI transaction reference (UTR) the payer's app shows.
function readUtr(value) {
  const text = String(value ?? '').replace(/\s/g, '');
  if (!/^\d{12}$/.test(text)) fail('Enter the 12-digit UPI reference (UTR) from the payer\'s app', 400, { field: 'reference' });
  return text;
}

// An Indian cheque's six-digit number.
function readChequeNo(value) {
  const text = String(value ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(text)) fail('Enter the cheque\'s six-digit number', 400, { field: 'reference' });
  return text;
}

// ISO day of the week of a YYYY-MM-DD date: 1 Monday … 7 Sunday.
const isoWeekday = (date) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

// A place's link that opens in Google Maps.
const mapsLink = (latitude, longitude) => `https://www.google.com/maps?q=${Number(latitude).toFixed(6)},${Number(longitude).toFixed(6)}`;

// The day's figures from its counts: strike rate (productive ÷ total calls)
// and beat adherence (planned shops visited ÷ planned) as whole per cent,
// lines per call (order lines ÷ productive calls) to one place; null where
// there is nothing to divide by.
function dayFigures({ planned = 0, visitedPlanned = 0, calls = 0, productive = 0, lines = 0 }) {
  const percent = (part, whole) => (whole > 0 ? Math.round((part * 100) / whole) : null);
  return {
    strike_rate: percent(productive, calls),
    adherence: percent(visitedPlanned, planned),
    lines_per_call: productive > 0 ? Math.round((lines * 10) / productive) / 10 : null,
  };
}

module.exports = { NO_ORDER_REASONS, CASH_LIMIT_PAISE, distanceMetres, readPlace, readUtr, readChequeNo, isoWeekday, mapsLink, dayFigures };
