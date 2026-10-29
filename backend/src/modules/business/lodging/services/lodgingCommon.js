const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// What the lodging services share: the type and module guard, the words for
// statuses, sources and ID documents, reading dates, numbers and IDs as the
// front desk types them, request keys, the settings, and the business's own
// clock. Money is integer paise; a stay's nights are dates on the business's
// clock (a night belongs to the date it starts on).

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

function requireLodging(business) {
  if (business.business_type !== 'lodging') fail('This screen belongs to hotels, lodges and guest houses', 404);
  if (!business.modules.includes('lodging')) fail('Rooms & stays is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

const STATUS_WORDS = { reserved: 'reserved', in_house: 'in the house', checked_out: 'checked out', cancelled: 'cancelled', no_show: 'a no-show' };
const ROOM_STATUSES = ['vacant_clean', 'vacant_dirty', 'occupied', 'out_of_order'];
const ROOM_WORDS = { vacant_clean: 'vacant and clean', vacant_dirty: 'vacant, to be made up', occupied: 'occupied', out_of_order: 'out of order' };
const SOURCES = ['walk_in', 'phone', 'ota'];
const SOURCE_WORDS = { walk_in: 'Walk-in', phone: 'Phone', ota: 'OTA' };
const ID_KINDS = { aadhaar: 'Aadhaar card', voter_id: 'Voter ID', driving_licence: 'Driving licence', passport: 'Passport', pan_card: 'PAN card', other: 'Other photo ID' };
const GENDERS = ['female', 'male', 'other'];
// Money taken for a stay, and money handed back from it.
const RECEIPT_KINDS = ['cash', 'card', 'upi', 'bank'];
const MAX_NIGHTS = 180;
// The most a night's rate may be: ₹10,00,000.
const MAX_RATE = 1000000;
// The most a stay's bill may come to (₹100 crore, the core's limit for a bill).
const MAX_TOTAL = 100000000000;

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

// A calendar date as typed (YYYY-MM-DD), checked.
function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
const dayWords = (day) => { const [, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]}`; };
// A date column as YYYY-MM-DD (pg gives DATE as text here; a Date when it is not).
const dayOf = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
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
// "the nights of 26 to 28 Oct", "the night of 26 Oct".
const nightsWords = (arrival, departure) => {
  const last = addDays(departure, -1);
  return last === arrival ? `the night of ${dayWords(arrival)}` : `the nights of ${dayWords(arrival)} to ${dayWords(last)}`;
};

// A photo ID as typed: its kind and number; of an Aadhaar card only the last
// four digits are kept, and the full number is refused.
function readId(kind, ref, name = 'Photo ID') {
  const idKind = v.requiredEnum(kind, name, Object.keys(ID_KINDS));
  const idRef = String(ref ?? '').toUpperCase().replace(/\s+/g, '');
  if (idKind === 'aadhaar' && !/^\d{4}$/.test(idRef)) fail(`${name}: type only the last four digits of the Aadhaar number; no more of it is kept`);
  if (!/^[A-Z0-9/-]{2,30}$/.test(idRef)) fail(`${name}: the number is 2 to 30 letters and digits`);
  return { idKind, idRef };
}
// A rate a night (rupees, before GST), checked: paise, or null when empty and not required.
function readRate(value, name, { required = false, zero = false } = {}) {
  if (!given(value)) {
    if (required) fail(`Give ${name.toLowerCase()}`);
    return null;
  }
  const text = String(value).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) fail(`${name} must be an amount in rupees, up to two decimal places`);
  const p = paise(text);
  if (p > MAX_RATE * 100) fail(`${name} is at most ${MAX_RATE.toLocaleString('en-IN')} a night`);
  if (p === 0 && !zero) fail(`${name} must be more than zero`);
  return p;
}

// Money is for those who see sales; guests' ID details for those who check guests in or print the register.
const seesMoney = (business) => access.can(business, 'sales.view');
const seesIds = (business) => access.can(business, 'lodging.create') || access.can(business, 'lodging.print');

// The settings as a business has them (the defaults until first saved), with its two slabs.
const DEFAULTS = { low_tax_rate_id: null, high_tax_rate_id: null, slab_limit: '7500.00', weekend_nights: [5, 6], terms: null, check_in_time: '12:00:00', check_out_time: '11:00:00' };
async function settingsOf(db, businessId) {
  const row = await repo.one(db, `SELECT s.*,lo.name AS low_name,lo.rate AS low_rate,hi.name AS high_name,hi.rate AS high_rate FROM lodging_settings s
    LEFT JOIN business_tax_rates lo ON lo.business_id=s.business_id AND lo.id=s.low_tax_rate_id
    LEFT JOIN business_tax_rates hi ON hi.business_id=s.business_id AND hi.id=s.high_tax_rate_id WHERE s.business_id=$1`, [businessId]);
  const s = row ? { ...DEFAULTS, ...row } : { ...DEFAULTS, business_id: businessId, updated_at: null, updated_by: null };
  return { ...s, weekend_nights: (s.weekend_nights || []).map(Number) };
}
// The settings as the counting takes them; refused until the two slabs are set.
function slabsOf(settings) {
  if (!settings.low_tax_rate_id) fail('Set the two GST slabs for room nights first, under Settings › Room types & rates', 409, { reason: 'slabs_not_set' });
  return {
    weekendNights: settings.weekend_nights,
    slabs: { limit: paise(settings.slab_limit), low: { id: Number(settings.low_tax_rate_id), rate: Number(settings.low_rate), name: settings.low_name },
      high: { id: Number(settings.high_tax_rate_id), rate: Number(settings.high_rate), name: settings.high_name } },
  };
}

// What is left of a receipt: less bills it paid and earlier refunds.
const FREE_SQL = (k) => `${k}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${k}.business_id AND p.collection_id=${k}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${k}.business_id AND f.collection_id=${k}.id),0)`;
// What is still to pay on a bill: its total less returns and payments, plus refunds.
const DUE_SQL = (d) => `(${d}.total
  -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
  -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
  +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;

// A time of day as typed (HH:MM, 24-hour), checked.
function readTime(value, name) {
  const text = String(value ?? '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) fail(`${name} is a time of day like 12:00 or 14:30`);
  return text;
}
const hhmm = (time) => String(time || '').slice(0, 5);
// Which folio routing rule a charge follows: the room (its nights, a day use, an early check-in or a late check-out,
// with their tax), meals, extras or goods. A cancellation charge is billed to the guest.
const CATEGORY = { room_night: 'room', day_use: 'room', early_check_in: 'room', late_check_out: 'room', meal: 'meals', extra: 'extras', goods: 'goods' };
const CATEGORIES = ['room', 'meals', 'extras', 'goods'];

// The database's own sentence for a room taken twice (the exclusion constraint),
// when two stays were saved at the same moment and the check before it could not see the other.
function roomTaken(error) {
  if (error?.code === '23P01' && error.constraint === 'lodging_stays_room_free') {
    return new AppError(409, 'That room is taken by another stay over some of these nights. Choose another room, or other dates.');
  }
  return error;
}

module.exports = { fail, id, requireLodging, STATUS_WORDS, ROOM_STATUSES, ROOM_WORDS, SOURCES, SOURCE_WORDS, ID_KINDS, GENDERS, RECEIPT_KINDS, MAX_NIGHTS, MAX_RATE,
  MAX_TOTAL, given, optionalText, paise, rupees, hashOf, derivedKey, whole, readDate, addDays, dateWords, dayWords, dayOf, timeWords, today, listWords, plural,
  nightsWords, readId, readRate, seesMoney, seesIds, DEFAULTS, settingsOf, slabsOf, FREE_SQL, DUE_SQL, roomTaken, readTime, hhmm, CATEGORY, CATEGORIES };
