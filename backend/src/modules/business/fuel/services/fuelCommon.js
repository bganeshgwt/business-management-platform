const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// What the fuel station's services share: the type and module guard, the
// words for fuels and states, reading litres, totaliser readings, money,
// densities, registrations and times as the forecourt types them, request
// keys, and the business's own clock. Litres are kept to the millilitre (3
// places) and money to the paisa; the counting is fuelMoney.js. Nothing here
// talks to a dispenser or a tank gauge: every reading is typed in.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

function requireFuel(business) {
  if (business.business_type !== 'fuel_station') fail('This screen belongs to fuel stations', 404);
  if (!business.modules.includes('fuel')) fail('Tanks, nozzles & shifts is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

const FAMILIES = ['petrol', 'diesel', 'cng'];
const FAMILY_WORDS = { petrol: 'petrol', diesel: 'diesel', cng: 'CNG' };
const UNIT_STATES = ['in_use', 'suspended', 'retired'];
// The other takings an attendant hands in: UPI, cards and fleet cards (payment methods of these kinds).
const TAKING_KINDS = ['upi', 'card', 'bank'];
// How far a typed reading time may go back: a shift's readings within a day, a dip or a load within a week.
const MAX_SHIFT_SLIP = 500;
const MAX_LITRES = 1000000;

const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const optionalText = (value, name, max) => v.optionalString(value === undefined || value === null ? value : String(value), name, max);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
// A request key for each part of a posting, made from the posting's own key,
// so a retried posting never makes its parts twice.
const derivedKey = (key, part) => {
  const h = crypto.createHash('sha256').update(`${key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const whole = (value, name, min, max) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return Number(text);
};

// A decimal as typed, checked and given back as text with its places
// ("495.5" with 3 places is "495.500"), so nothing is ever a float.
function readDecimal(value, name, places, { min = 0, max = MAX_LITRES, minExclusive = false } = {}) {
  const text = String(value ?? '').trim();
  if (!new RegExp(`^\\d{1,12}(\\.\\d{1,${places}})?$`).test(text)) fail(`${name} must be a number with at most ${places} decimal places, like ${places === 3 ? '1250.500' : places === 2 ? '102.12' : '745.5'}`);
  const [whole, fraction = ''] = text.split('.');
  const normal = `${String(Number(whole))}${places ? `.${fraction.padEnd(places, '0')}` : ''}`;
  const number = Number(normal);
  if (number < min || (minExclusive && number === min) || number > max) fail(`${name} must be ${minExclusive ? 'more than' : 'at least'} ${min} and at most ${max}`);
  return normal;
}
// Litres (or kilos of CNG) to the millilitre.
const readLitres = (value, name, options = {}) => readDecimal(value, name, 3, { max: MAX_LITRES, ...options });
// A totaliser reading: up to eleven digits and three places.
const readReading = (value, name) => readDecimal(value, name, 3, { max: 99999999999.999 });
// Money to the paisa.
const readMoney = (value, name, options = {}) => readDecimal(value, name, 2, { max: 100000000, ...options });
// A density at 15 °C in kg/m³, to one place (petrol is around 740, diesel 830).
const readDensity = (value, name) => readDecimal(value, name, 1, { min: 600, max: 1100 });
const optionalDensity = (value, name) => (given(value) ? readDensity(value, name) : null);

// A vehicle's or a tank lorry's registration as on its plate ("ts 09 ub-4455" is TS09UB4455).
function readPlate(value, name = 'Registration') {
  const plate = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{4,15}$/.test(plate) || !/[A-Z]/.test(plate) || !/[0-9]/.test(plate)) fail(`${name} is the number on the plate, like TS09UB4455`);
  return plate;
}
// A nozzle's number at the outlet: letters, digits, / and - ("1", "2A", "DU1-N2").
function readNozzleNo(value) {
  const text = String(value ?? '').toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9/-]{0,9}$/.test(text)) fail('A nozzle number is 1 to 10 letters, digits, / or -, like 1 or 2A');
  return text;
}

// A time as typed: "2026-10-26T06:00" is that time on the business's clock;
// an instant with its offset ("…Z", "…+05:30") is itself. Read to the minute.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?$/;
async function readInstant(db, business, value, name) {
  const text = String(value ?? '').trim();
  if (!INSTANT.test(text) || !Number.isFinite(Date.parse(text.slice(0, 10)))) fail(`${name} must be a date and time, like 2026-10-26T06:00`);
  const zoned = /(Z|[+-]\d{2}:\d{2})$/.test(text);
  try {
    const row = await repo.one(db, `SELECT date_trunc('minute', CASE WHEN $3 THEN $1::timestamptz ELSE ($1::timestamp AT TIME ZONE $2) END) AS at`,
      [text, business.timezone || 'Asia/Kolkata', zoned]);
    return row.at;
  } catch {
    return fail(`${name} must be a date and time, like 2026-10-26T06:00`);
  }
}
// A time given, or now (to the minute when typed; the database's own now when not).
const readWhen = async (db, business, value, name) => (given(value) ? readInstant(db, business, value, name) : null);
// A calendar date as typed (YYYY-MM-DD), checked.
function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
// A month as typed (YYYY-MM): its first and last days.
function readMonth(value, name = 'Month') {
  const text = String(value ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) fail(`${name} must be a month, like 2026-10`);
  const [y, m] = text.split('-').map(Number);
  return { month: text, from: `${text}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
// An instant on the business's clock: "26 Oct, 6:00 am".
function timeWords(at, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    hour12: true }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod || '').toLowerCase()}`;
}
// The business's own date (its time zone), as YYYY-MM-DD.
async function today(db, business) {
  return (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone || 'Asia/Kolkata'])).day;
}
const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Money of other attendants' shifts is for those who see sales.
const seesMoney = (business) => access.can(business, 'sales.view');

// The settings as a business has them (MDG 2024's figures until changed).
const DEFAULTS = { density_tolerance: '3.0', variation_percent: '4.00', petrol_loss_percent: '0.75', petrol_loss_above_percent: '0.60', diesel_loss_percent: '0.25',
  diesel_loss_above_percent: '0.20', above_600_kl: false, test_litres: '5.000', stamping_warn_days: 30, denominations: [500, 200, 100, 50, 20, 10, 5, 2, 1],
  interest_sku_id: null };
async function settingsOf(db, businessId) {
  const row = await repo.one(db, 'SELECT * FROM fuel_settings WHERE business_id=$1', [businessId]);
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS, business_id: businessId, updated_at: null, updated_by: null };
}

// Same lock order as every posting: the business first.
const lockBusiness = (db, business) => db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);

// An active location of this business that this person works at.
async function locationOf(db, business, value, name = 'Outlet') {
  const locationId = id(value || business.location_scope || business.member_location_id, name);
  access.requireLocation(business, locationId);
  const location = await repo.one(db, 'SELECT id,name,code FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
  if (!location) fail('Outlet not found', 404);
  return location;
}
// The outlet a board or register shows: the one asked for, else the person's
// own, else the business's first.
async function boardOutlet(db, business, value) {
  if (given(value) || business.location_scope || business.member_location_id) return locationOf(db, business, value);
  const first = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND active ORDER BY id LIMIT 1', [business.id]);
  if (!first) fail('Outlet not found', 404);
  return locationOf(db, business, first.id);
}

module.exports = { fail, id, requireFuel, FAMILIES, FAMILY_WORDS, UNIT_STATES, TAKING_KINDS, MAX_SHIFT_SLIP, MAX_LITRES, given, optionalText, hashOf, derivedKey, whole,
  readDecimal, readLitres, readReading, readMoney, readDensity, optionalDensity, readPlate, readNozzleNo, readInstant, readWhen, readDate, readMonth, addDays, dateWords,
  timeWords, today, listWords, plural, seesMoney, DEFAULTS, settingsOf, lockBusiness, locationOf, boardOutlet };
