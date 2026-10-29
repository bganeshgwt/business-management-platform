const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// What the rental services share: the type and module guard, the words for
// statuses, ID documents, fuel levels and charges, reading times, numbers and
// meter readings as the counter types them, request keys, and the business's
// own clock. Money is integer paise; a booking's times are instants, read
// and shown on the business's clock.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

function requireRentals(business) {
  if (business.business_type !== 'rentals') fail('This screen belongs to rental and hire businesses', 404);
  if (!business.modules.includes('rentals')) fail('Hire items & bookings is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

const STATUS_WORDS = { quote: 'quote', reserved: 'reserved', out: 'out', returned: 'returned', cancelled: 'cancelled' };
// Where a booking stands, worked out from its status, its times and its money.
const STAGE_WORDS = { quote: 'quote', reserved: 'reserved', out: 'out', due_today: 'due back today', overdue: 'overdue', to_settle: 'back, to settle',
  closed: 'closed', cancelled: 'cancelled' };
const ID_KINDS = { aadhaar: 'Aadhaar card', voter_id: 'Voter ID', driving_licence: 'Driving licence', passport: 'Passport', pan_card: 'PAN card', other: 'Other photo ID' };
// Fuel in eighths of a tank.
const FUEL_LEVELS = ['empty', 'one_eighth', 'quarter', 'three_eighths', 'half', 'five_eighths', 'three_quarters', 'seven_eighths', 'full'];
const FUEL_WORDS = { empty: 'empty', one_eighth: 'an eighth', quarter: 'a quarter', three_eighths: 'three eighths', half: 'half', five_eighths: 'five eighths',
  three_quarters: 'three quarters', seven_eighths: 'seven eighths', full: 'full' };
const CHARGE_KINDS = ['damage', 'missing', 'cleaning', 'fuel', 'other'];
const CHARGE_WORDS = { damage: 'Damage', missing: 'Missing', cleaning: 'Cleaning', fuel: 'Fuel', other: 'Charge', cancellation: 'Cancellation charge' };
const VEHICLES = ['car', 'motorcycle', 'other'];
const VEHICLE_WORDS = { car: 'car', motorcycle: 'motorcycle', other: 'vehicle' };
// The State Transport Authority's licence a self-drive vehicle is hired out under (Settings › Licences).
const SELF_DRIVE_LICENCES = { car: { kind: 'rent_a_cab', words: 'rent-a-cab licence' }, motorcycle: { kind: 'rent_a_motorcycle', words: 'rent-a-motorcycle licence' } };
const METERS = ['km', 'hours'];
const LATE_PER = ['none', 'hour', 'day', 'slabs'];
// A vehicle's class as a driving licence names it.
const VEHICLE_CLASSES = { MC50CC: 'Motorcycle up to 50 cc', MCWOG: 'Motorcycle without gear (scooter)', MCWG: 'Motorcycle with gear', 'LMV-NT': 'Light motor vehicle, non-transport',
  LMV: 'Light motor vehicle', TRANS: 'Transport vehicle' };
const FUEL_TYPES = ['petrol', 'diesel', 'cng', 'lpg', 'electric'];
// A vehicle's papers, by the date each runs until.
const PAPERS = { rc_valid_until: 'registration certificate', permit_valid_until: 'permit', insurance_valid_until: 'insurance', puc_valid_until: 'PUC certificate',
  fitness_valid_until: 'fitness certificate' };
const PAPER_KEYS = { rc_valid_until: 'rcValidUntil', permit_valid_until: 'permitValidUntil', insurance_valid_until: 'insuranceValidUntil', puc_valid_until: 'pucValidUntil',
  fitness_valid_until: 'fitnessValidUntil' };
// Money taken for a booking and money handed back from it.
const RECEIPT_KINDS = ['cash', 'card', 'upi', 'bank'];
const MAX_DAYS = 90;
const MAX_LINES = 50;

const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const optionalText = (value, name, max) => v.optionalString(value === undefined || value === null ? value : String(value), name, max);
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
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

// A time as the counter types it: "2026-10-26T10:00" is that time on the
// business's clock; an instant with its offset ("…Z", "…+05:30") is itself.
// Read to the minute, as a Date.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?$/;
async function readInstant(db, business, value, name) {
  const text = String(value ?? '').trim();
  if (!INSTANT.test(text) || !Number.isFinite(Date.parse(text.slice(0, 10)))) fail(`${name} must be a date and time, like 2026-10-26T10:00`);
  const zoned = /(Z|[+-]\d{2}:\d{2})$/.test(text);
  try {
    const row = await repo.one(db, `SELECT date_trunc('minute', CASE WHEN $3 THEN $1::timestamptz ELSE ($1::timestamp AT TIME ZONE $2) END) AS at`,
      [text, business.timezone || 'Asia/Kolkata', zoned]);
    return row.at;
  } catch {
    return fail(`${name} must be a date and time, like 2026-10-26T10:00`);
  }
}
// A calendar date as typed (YYYY-MM-DD), checked.
function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
// An instant on the business's clock: "26 Oct, 10:00 am".
function timeWords(at, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    hour12: true }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod || '').toLowerCase()}`;
}
// The business's own date (its time zone), as YYYY-MM-DD.
async function today(db, business) {
  return (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone || 'Asia/Kolkata'])).day;
}
// "a, b and c".
const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A vehicle's registration as on its plate (letters and digits: "ts 09 ab-1234"
// is TS09AB1234); a machine's serial number in letters, digits, / and -. Empty is none.
function readSerial(value, vehicle) {
  if (!given(value)) {
    if (vehicle) fail('Give the vehicle\'s registration number, as on its plate');
    return null;
  }
  if (vehicle) {
    const plate = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{4,15}$/.test(plate) || !/[A-Z]/.test(plate) || !/[0-9]/.test(plate)) fail('The registration number is the number on the plate, like TS09AB1234');
    return plate;
  }
  const text = String(value).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9/-]{0,29}$/.test(text)) fail('A serial number is 1 to 30 letters, digits, / or -');
  return text;
}
// A meter reading: kilometres or running hours, to one decimal place.
function readMeter(value, name) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,9}(\.\d)?$/.test(text)) fail(`${name} must be a reading of up to one decimal place, like 25340 or 1203.5`);
  return Number(text);
}
// A photo ID as typed: its kind and number; of an Aadhaar card only the last
// four digits are kept, and the full number is refused.
function readId(kind, ref) {
  const idKind = v.requiredEnum(kind, 'Photo ID', Object.keys(ID_KINDS));
  const idRef = String(ref ?? '').toUpperCase().replace(/\s+/g, '');
  if (idKind === 'aadhaar' && !/^\d{4}$/.test(idRef)) fail('Type only the last four digits of the Aadhaar number: the shop keeps no more of it');
  if (!/^[A-Z0-9/-]{2,30}$/.test(idRef)) fail('The photo ID\'s number is 2 to 30 letters and digits');
  return { idKind, idRef };
}
// A driving licence number as printed (letters and digits, / and -).
function readLicence(value) {
  const text = String(value ?? '').toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9/-]{5,30}$/.test(text)) fail('The driving licence number is 5 to 30 letters and digits, as printed on it');
  return text;
}

// A calendar date as typed, or none.
const optionalDate = (value, name) => (given(value) ? readDate(value, name) : null);
// Licence classes as ticked: a list of the classes a driving licence (or permit) names.
function readClasses(value, name) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const classes = [...new Set(list.map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  for (const x of classes) if (!VEHICLE_CLASSES[x]) fail(`${name}: ${x} is not a class of vehicle a licence names (${Object.keys(VEHICLE_CLASSES).join(', ')})`);
  return classes;
}
// Late fee slabs as typed: [{ from (hours late), flat, times }] — the first from 0, rising; a flat amount
// and/or a multiple of the hourly rate. null when none are given.
function readLateSlabs(value) {
  if (value === undefined || value === null) return null;
  const list = v.requiredArray(value, 'Late fee slabs');
  if (!list.length) return null;
  if (list.length > 10) fail('Give at most 10 late fee slabs');
  const slabs = list.map((raw, index) => {
    const name = `Late fee slab ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
    const from = index === 0 ? 0 : whole(raw.from, `${name}: from hours late`, 1, 2160);
    const flat = given(raw.flat) ? coreDecimal(raw.flat, `${name}: flat amount`, 0, 1000000) : 0;
    const times = given(raw.times) ? coreDecimal(raw.times, `${name}: times the hourly rate`, 0, 100) : 0;
    if (!flat && !times) fail(`${name}: give a flat amount, a multiple of the hourly rate, or both`);
    return { from, flat, times };
  });
  for (let i = 1; i < slabs.length; i += 1) if (slabs[i].from <= slabs[i - 1].from) fail('Each late fee slab starts at more hours late than the one before');
  return slabs;
}
// Cancellation slabs as typed: [{ hours (before the out time), percent }], most hours first. null when none.
function readCancelSlabs(value) {
  if (value === undefined || value === null) return null;
  const list = v.requiredArray(value, 'Cancellation slabs');
  if (!list.length) return null;
  if (list.length > 10) fail('Give at most 10 cancellation slabs');
  const slabs = list.map((raw, index) => {
    const name = `Cancellation slab ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
    return { hours: whole(raw.hours, `${name}: hours before the out time`, 0, 2160), percent: coreDecimal(raw.percent, `${name}: percent of the hire`, 0, 100) };
  }).sort((a, b) => b.hours - a.hours);
  for (let i = 1; i < slabs.length; i += 1) if (slabs[i].hours === slabs[i - 1].hours) fail('Each cancellation slab starts at different hours before the out time');
  return slabs;
}
// A decimal of up to two places, as typed (the core's reader, loaded when first needed).
const coreDecimal = (value, name, min, max) => require('../../core/services/business.service').decimal(value, name, 2, min, max);
// The business's first location in use: where a pool or unit is kept unless placed elsewhere.
const firstLocation = async (db, businessId) => (await repo.one(db, 'SELECT min(id) AS id FROM business_locations WHERE business_id=$1 AND active', [businessId])).id;

// Money is for those who see sales.
const seesMoney = (business) => access.can(business, 'sales.view');

// The settings as a business has them (the defaults until first saved).
const DEFAULTS = { id_required: true, terms: null, papers_warn_days: 30, papers_urgent_days: 7, papers_lapsed: 'refuse', cancel_slabs: null, no_show_percent: null };
async function settingsOf(db, businessId) {
  const row = await repo.one(db, 'SELECT * FROM rental_settings WHERE business_id=$1', [businessId]);
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS, business_id: businessId, updated_at: null, updated_by: null };
}

// What is left of a receipt: less bills it paid and earlier refunds.
const FREE_SQL = (k) => `${k}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${k}.business_id AND p.collection_id=${k}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${k}.business_id AND f.collection_id=${k}.id),0)`;
// What is still to pay on a bill: its total less returns and payments, plus refunds.
const DUE_SQL = (d) => `(${d}.total
  -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
  -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
  +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;

module.exports = { fail, id, requireRentals, STATUS_WORDS, STAGE_WORDS, ID_KINDS, FUEL_LEVELS, FUEL_WORDS, CHARGE_KINDS, CHARGE_WORDS, VEHICLES, VEHICLE_WORDS,
  SELF_DRIVE_LICENCES, METERS, LATE_PER, VEHICLE_CLASSES, FUEL_TYPES, PAPERS, PAPER_KEYS, RECEIPT_KINDS, MAX_DAYS, MAX_LINES, given, optionalText, paise, rupees, hashOf,
  derivedKey, whole, readInstant, readDate, optionalDate, addDays, dateWords, timeWords, today, listWords, plural, readSerial, readMeter, readId, readLicence, readClasses,
  readLateSlabs, readCancelSlabs, firstLocation, seesMoney, DEFAULTS, settingsOf, FREE_SQL, DUE_SQL };
