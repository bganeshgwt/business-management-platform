// The database layer, loaded on first use: the readers here load no database.
const repo = () => require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');

// What the optical services share: the type and module guard, the words for
// statuses, lenses and remakes, reading powers as an optometrist writes them,
// and the business's own date.

const fail = (message, status = 400) => { throw new AppError(status, message); };

function requireOptical(business) {
  if (business.business_type !== 'optical') fail('This screen belongs to optical shops', 404);
  if (!business.modules.includes('optical')) fail('Prescriptions & spectacle orders is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

const EYES = ['right', 'left'];
const ZONES = ['distance', 'near', 'intermediate'];
const EYE_WORDS = { right: 'right eye', left: 'left eye' };
const ZONE_WORDS = { distance: 'distance', near: 'near', intermediate: 'intermediate' };
// A prism's base: horizontal (in or out) and vertical (up or down), each its own prism.
const PRISM_BASES = ['in', 'out'];
const VERTICAL_BASES = ['up', 'down'];
const LENS_TYPES = ['single_vision', 'bifocal', 'progressive'];
const LENS_WORDS = { single_vision: 'single vision', bifocal: 'bifocal', progressive: 'progressive' };
const MATERIALS = ['cr39', 'polycarbonate', 'trivex', 'glass', 'other'];
const COATINGS = ['anti_reflective', 'blue_cut', 'uv', 'photochromic', 'scratch_resistant'];
const REMAKE_REASONS = ['power_change', 'non_adaptation', 'measurement', 'lab_defect', 'breakage', 'coating', 'other'];
const COST_BEARERS = ['shop', 'lab', 'customer'];
const STATUS_WORDS = { booked: 'booked', at_lab: 'at the lab', in_workshop: 'in the workshop', quality_check: 'at the quality check', ready: 'ready to collect',
  delivered: 'delivered', cancelled: 'cancelled' };
const OPEN = ['booked', 'at_lab', 'in_workshop', 'quality_check', 'ready'];
// A prescription for spectacles, or for contact lenses.
const KINDS = ['spectacles', 'contact_lens'];
// The workshop's steps, in order, before the quality check.
const WORKSHOP_STEPS = ['cutting', 'edging', 'fitting'];
// How often a contact lens is replaced, and in how many days.
const MODALITIES = ['daily', 'fortnightly', 'monthly', 'quarterly', 'half_yearly', 'yearly'];
const MODALITY_DAYS = { daily: 1, fortnightly: 14, monthly: 30, quarterly: 90, half_yearly: 180, yearly: 365 };
// A spectacle lens's details kept with its item: picked on an order instead of typed.
const LENS_ITEM_KEYS = ['lensDesign', 'lensIndex', 'lensMaterial', 'coatings', 'tint'];
// A contact lens's details kept with its item (each power of a lens product is its own item).
const CONTACT_LENS_KEYS = ['power', 'baseCurve', 'diameter', 'cyl', 'axis', 'add', 'colour', 'modality', 'lensesPerPack'];
// An item is a contact lens when it keeps a base curve (the power grid writes one).
const isContactLens = (attributes) => Boolean(attributes && attributes.baseCurve !== undefined && attributes.baseCurve !== null && attributes.baseCurve !== '');

const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';

// A power in dioptres as written: -2.25, +1.50, 2, 0, or plano for 0.00 (SPH).
// In steps of 0.25 between `min` and `max`; returned as text with two places.
function readPower(value, name, { min = -30, max = 30, plano = false } = {}) {
  if (!given(value)) return null;
  const text = String(value).trim().replace(/\s+/g, '').replace(/^−/, '-');
  if (plano && /^(plano|pl|∞)$/i.test(text)) return '0.00';
  if (!/^[+-]?\d{1,2}(\.\d{1,2})?$/.test(text)) fail(`${name} must be a number of dioptres like -2.25 or +1.50`);
  const number = Number(text);
  if (number < min || number > max) fail(`${name} must be from ${min > 0 ? '+' : ''}${min.toFixed(2)} to +${max.toFixed(2)}`);
  if (Math.round(number * 100) % 25 !== 0) fail(`${name} goes in steps of 0.25 (for example ${(Math.round(number * 4) / 4).toFixed(2)})`);
  return number.toFixed(2);
}
function readAxis(value, name) {
  if (!given(value)) return null;
  const text = String(value).trim();
  if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 180) fail(`${name} must be a whole number of degrees from 1 to 180 (a horizontal axis is 180)`);
  return Number(text);
}
// A measurement in mm with at most one decimal place.
function readMillimetres(value, name, min, max) {
  if (!given(value)) return null;
  const text = String(value).trim();
  if (!/^\d{1,2}(\.\d)?$/.test(text) || Number(text) < min || Number(text) > max) fail(`${name} must be from ${min} to ${max} mm, with at most one decimal place`);
  return Number(text).toFixed(1);
}

// A calendar date as typed (YYYY-MM-DD), checked.
function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// The same day so many months later (the last day of the month when it has fewer days).
function addMonths(day, months) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
// The business's own date (its time zone), as YYYY-MM-DD.
async function today(db, business) {
  return (await repo().one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone || 'Asia/Kolkata'])).day;
}
// "a, b and c".
const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const optionalText = (value, name, max) => v.optionalString(value === undefined || value === null ? value : String(value), name, max);

// A lens's index (1.40 to 2.00), as typed: "1.6" is 1.60.
function readIndex(value, name) {
  if (!given(value)) return null;
  const text = String(value).trim();
  if (!/^\d\.\d{1,2}$/.test(text) || Number(text) < 1.4 || Number(text) > 2) fail(`${name} must be from 1.40 to 2.00 (1.50, 1.56, 1.60, 1.67, 1.74)`);
  return Number(text).toFixed(2);
}
// A list of coatings, each named once, in a set order.
function readCoatings(value, name) {
  if (value === undefined || value === null || value === '') return [];
  const list = v.requiredArray(value, name);
  for (const coating of list) v.requiredEnum(coating, name.replace(/s$/, ''), COATINGS);
  if (new Set(list).size !== list.length) fail(`${name}: each coating is named once`);
  return [...list].sort();
}
// A whole number of months from 1 to 60, or none.
function readMonths(value, name) {
  if (!given(value)) return null;
  const text = String(value).trim();
  if (!/^\d{1,2}$/.test(text) || Number(text) < 1 || Number(text) > 60) fail(`${name} is 1 to 60 whole months, or left empty`);
  return Number(text);
}
module.exports = { fail, requireOptical, EYES, ZONES, EYE_WORDS, ZONE_WORDS, PRISM_BASES, VERTICAL_BASES, LENS_TYPES, LENS_WORDS, MATERIALS, COATINGS, REMAKE_REASONS, COST_BEARERS,
  STATUS_WORDS, OPEN, KINDS, WORKSHOP_STEPS, MODALITIES, MODALITY_DAYS, LENS_ITEM_KEYS, CONTACT_LENS_KEYS, isContactLens,
  given, readPower, readAxis, readMillimetres, readDate, addDays, addMonths, dateWords, today, listWords, optionalText, readIndex, readCoatings, readMonths };
