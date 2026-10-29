const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// What the laundry services share: the type and module guard, the words for
// statuses, defects and claims, reading tags and racks as the counter types
// them, request keys, and the business's own date.
// Money is integer paise; dates are YYYY-MM-DD text on the business's clock.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

function requireLaundry(business) {
  if (business.business_type !== 'laundry') fail('This screen belongs to laundries and dry cleaners', 404);
  if (!business.modules.includes('laundry')) fail('Garment orders is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

// A garment's way through the shop, and the words for it: received, in the
// work, at its quality check (qc), packed, ready on a rack, then delivered.
const OPEN = ['received', 'in_process', 'qc', 'packed', 'ready'];
const OPEN_SQL = "('received','in_process','qc','packed','ready')";
const STATUS_WORDS = { received: 'received', in_process: 'in process', qc: 'at its quality check', packed: 'packed', ready: 'ready', delivered: 'delivered',
  cancelled: 'cancelled' };
// An order's status, worked out from its garments.
const ORDER_WORDS = { received: 'received', in_process: 'in process', part_ready: 'partly ready', ready: 'ready to collect', part_delivered: 'partly delivered',
  delivered: 'delivered', cancelled: 'cancelled' };
const DEFECTS = ['stain', 'tear', 'hole', 'missing_button', 'colour_bleed', 'fading', 'shrinkage', 'burn', 'worn', 'loose_thread'];
const DEFECT_WORDS = { stain: 'stain', tear: 'tear', hole: 'hole', missing_button: 'missing button', colour_bleed: 'colour bleed', fading: 'fading',
  shrinkage: 'shrinkage', burn: 'burn mark', worn: 'worn', loose_thread: 'loose threads' };
const COUNTED_AS = ['piece', 'pair', 'set'];
const ISSUES = ['damage', 'stain', 'shrinkage', 'colour_run', 'lost', 'missing_part', 'other'];
const ISSUE_WORDS = { damage: 'damage', stain: 'a stain', shrinkage: 'shrinkage', colour_run: 'colour run', lost: 'lost', missing_part: 'a missing part', other: 'other' };
const DECISIONS = ['refund', 'credit', 'reprocess', 'rejected'];
const NOTICES = ['received', 'ready', 'delayed', 'reminder'];
const CHANNELS = ['whatsapp', 'call', 'sms'];

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

// A tag as printed or as already on the garment: upper case, letters, digits,
// / and - ("lo 12" is LO12). Empty is none.
function readTag(value, name = 'Tag number') {
  if (!given(value)) return null;
  const text = String(value).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9/-]{0,19}$/.test(text)) fail(`${name} must be 1 to 20 letters, digits, / or -, like 1042 or A-17`);
  return text;
}
// A rack and slot as the shop names them ("a-12", "Rack 3 / 14"). Empty is none.
function readRack(value, name = 'Rack') {
  if (!given(value)) return null;
  const text = String(value).toUpperCase().trim().replace(/\s+/g, ' ');
  if (!/^[A-Z0-9][A-Z0-9 /-]{0,19}$/.test(text)) fail(`${name} must be 1 to 20 letters, digits, spaces, / or -, like A-12`);
  return text;
}

// A calendar date as typed (YYYY-MM-DD), checked.
function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// The ISO weekday of a date (1 Monday … 7 Sunday).
const weekday = (day) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
// So many days the shop is open after a day: the days it is closed each week are skipped.
function addOpenDays(day, n, closed = []) {
  const shut = new Set((closed || []).map(Number));
  if (shut.size >= 7) return addDays(day, n);
  let at = day;
  for (let left = n; left > 0;) {
    at = addDays(at, 1);
    if (!shut.has(weekday(at))) left -= 1;
  }
  return at;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
// The business's own date (its time zone), as YYYY-MM-DD.
async function today(db, business) {
  return (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone || 'Asia/Kolkata'])).day;
}
// "a, b and c".
const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Money is for those who see sales.
const seesMoney = (business) => access.can(business, 'sales.view');

// The settings as a business has them (the defaults until first saved).
const DEFAULTS = { bill_at: 'delivery', part_delivery: 'whole_order', express_percent: '0.00', ready_days: 3, express_days: 1, unclaimed_days: 30, receipt_terms: null, last_tag_no: 0,
  area_rounding: 'exact', closed_days: [], qc_required: false, packing_required: false };
async function settingsOf(db, businessId) {
  const row = await repo.one(db, 'SELECT * FROM laundry_settings WHERE business_id=$1', [businessId]);
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS, business_id: businessId, updated_at: null, updated_by: null };
}

module.exports = { fail, id, requireLaundry, OPEN, OPEN_SQL, STATUS_WORDS, ORDER_WORDS, DEFECTS, DEFECT_WORDS, COUNTED_AS, ISSUES, ISSUE_WORDS, DECISIONS, NOTICES, CHANNELS,
  given, optionalText, paise, rupees, hashOf, derivedKey, readTag, readRack, readDate, addDays, addOpenDays, weekday, dateWords, today, listWords, plural, seesMoney, DEFAULTS, settingsOf };
