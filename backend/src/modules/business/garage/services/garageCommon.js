const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// What the garage services share: the type and module guard, who sees what
// (every job card, or only the ones a mechanic is assigned to; money, or
// none), reading registration numbers and kilometres as people write them,
// the words for statuses, and the business's own date.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);

function requireGarage(business) {
  if (business.business_type !== 'garage') fail('This screen belongs to vehicle service & auto parts businesses', 404);
  if (!business.modules.includes('garage')) fail('Vehicles & job cards is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

// The service desk sees every vehicle and job card (garage.view); a mechanic
// (garage.edit without it) sees the job cards assigned to them. Money is for
// those who see sales.
const seesAll = (business) => access.can(business, 'garage.view');
const seesMoney = (business) => access.can(business, 'sales.view');
// The desk's changes (details, the estimate, approvals, the claim): garage.edit with garage.view.
async function requireDesk(business) {
  await access.require(business, 'garage.edit');
  if (!seesAll(business)) fail('The service desk changes this: your role works on the job cards assigned to it', 403);
}

const STATUS_WORDS = {
  received: 'received', estimate_sent: 'waiting for the owner\'s approval', approved: 'approved', in_progress: 'in progress',
  waiting_parts: 'waiting for parts', ready: 'ready to deliver', delivered: 'delivered', cancelled: 'cancelled',
};
const OPEN = ['received', 'estimate_sent', 'approved', 'in_progress', 'waiting_parts', 'ready'];
const FUELS = ['petrol', 'diesel', 'cng', 'petrol_cng', 'lpg', 'electric', 'hybrid'];
const FUEL_LEVELS = ['empty', 'quarter', 'half', 'three_quarters', 'full'];
const LINE_KINDS = ['part', 'labour', 'sublet'];
const PAYERS = ['customer', 'insurer'];
const CHANNELS = ['in_person', 'phone', 'whatsapp'];
const CHANNEL_WORDS = { in_person: 'in person', phone: 'on the phone', whatsapp: 'on WhatsApp' };

const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const optionalText = (value, name, max) => v.optionalString(value === undefined || value === null ? value : String(value), name, max);

// A registration number as printed on the plate: upper case, letters and
// digits only ("ts 09 ab-1234" is TS09AB1234).
const plateOf = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function readRegistration(value, name = 'Registration number') {
  const text = plateOf(value);
  if (!text) fail(`${name} is required`);
  if (!/^[A-Z0-9]{4,15}$/.test(text) || !/[A-Z]/.test(text) || !/[0-9]/.test(text)) fail(`${name} must be the number on the plate, like TS09AB1234`);
  return text;
}
// A chassis or engine number, the same way (letters and digits only). Empty is none.
function readFrameNumber(value, name, min) {
  if (!given(value)) return null;
  const text = plateOf(value);
  if (text.length < min || text.length > 30) fail(`${name} must be ${min} to 30 letters and digits`);
  return text;
}
// Kilometres as typed (45210, 45,210). Empty is none.
function readKm(value, name) {
  if (!given(value)) return null;
  const text = String(value).replace(/[\s,]/g, '');
  if (!/^\d{1,7}$/.test(text)) fail(`${name} must be a whole number of kilometres`);
  return Number(text);
}
// "45,210" as Indian readers group it (1,23,456).
const km = (n) => Number(n).toLocaleString('en-IN');

// A calendar date as typed (YYYY-MM-DD), checked. Empty is none when `optional`.
function readDate(value, name, optional = false) {
  if (optional && !given(value)) return null;
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
  return (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone || 'Asia/Kolkata'])).day;
}
// "a, b and c".
const listWords = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// How far a vehicle goes in a day, from its odometer log since the meter was
// last changed: the first reading to the last, over the days between them.
// For the vehicle aliased `v`; needs `tz` (the business's time zone) in scope.
const DRIVING_SQL = (alias) => `LEFT JOIN LATERAL (
    SELECT min(r.reading_km) AS first_km, max(r.reading_km) AS last_km,
      (min(r.recorded_at) AT TIME ZONE tz)::date AS first_on, (max(r.recorded_at) AT TIME ZONE tz)::date AS last_on
    FROM garage_odometer_readings r
    WHERE r.business_id=${alias}.business_id AND r.vehicle_id=${alias}.id
      AND r.id >= COALESCE((SELECT max(x.id) FROM garage_odometer_readings x WHERE x.business_id=${alias}.business_id AND x.vehicle_id=${alias}.id
        AND x.lower_approved_by IS NOT NULL),0)) drive ON true`;
// The average a day (one decimal) and today's reading worked out from it.
const AVERAGE_SQL = 'CASE WHEN drive.last_on > drive.first_on THEN round((drive.last_km-drive.first_km)::numeric/(drive.last_on-drive.first_on),1) END';
const PROJECTED_SQL = (alias, on = 'today') => `CASE WHEN drive.last_on > drive.first_on THEN ${alias}.odometer_km
    + round((drive.last_km-drive.first_km)::numeric/(drive.last_on-drive.first_on) * GREATEST(0, (${on})-drive.last_on))::int END`;

// The members who work on job cards: those whose role holds garage.edit (or full access).
async function mechanics(db, business) {
  return repo.all(db, `SELECT u.id,u.name,r.name AS role_name,r.template_code FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code='garage.edit'))
    ORDER BY (r.template_code='mechanic') DESC,u.name`, [business.id]);
}

module.exports = { fail, id, requireGarage, seesAll, seesMoney, requireDesk, STATUS_WORDS, OPEN, FUELS, FUEL_LEVELS, LINE_KINDS, PAYERS, CHANNELS, CHANNEL_WORDS,
  given, optionalText, plateOf, readRegistration, readFrameNumber, readKm, km, readDate, addDays, addMonths, dateWords, today, listWords,
  DRIVING_SQL, AVERAGE_SQL, PROJECTED_SQL, mechanics };
