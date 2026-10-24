const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');

// What the memberships services share: the type and module guard, the words
// for kinds and statuses, the business's own date and calendar maths, the
// pro-rata share of what a membership has left, and request keys.
// Money is integer paise; dates are YYYY-MM-DD text on the business's clock.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };

function requireMemberships(business) {
  if (business.business_type !== 'memberships') fail('This screen belongs to gyms, studios and coaching centres', 404);
  if (!business.modules.includes('member_plans')) fail('Plans & memberships is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

const KINDS = ['duration', 'sessions', 'both'];
const UNITS = ['days', 'months'];
const STATUSES = ['upcoming', 'active', 'frozen', 'expired', 'used_up', 'cancelled', 'transferred', 'upgraded'];
const STATUS_WORDS = { upcoming: 'not started yet', active: 'active', frozen: 'frozen', expired: 'over', used_up: 'used up', cancelled: 'cancelled',
  transferred: 'transferred', upgraded: 'upgraded' };
// Why a member is turned away at the desk, as the desk's screen labels it.
const REASONS = { no_membership: 'No membership', not_started: 'Not started yet', expired: 'Membership over', frozen: 'Frozen',
  no_sessions: 'No sessions left', dues: 'Fees overdue' };

const id = (value, name = 'Record ID') => v.requiredId(value, name);
const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const roundedDivide = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
// A request key for each part of a posting, made from the posting's own key,
// so a retried posting never makes its parts twice.
const derivedKey = (key, part) => {
  const h = crypto.createHash('sha256').update(`${key}:${part}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const optionalText = (value, name, max) => v.optionalString(value === undefined || value === null ? value : String(value), name, max);

// --- Dates ------------------------------------------------------------------------------------------

function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
// The same day so many months later (the month's last day when it has fewer).
function addMonths(day, months) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };
// The business's own date (its time zone).
async function today(db, business) {
  return (await repo.one(db, 'SELECT (now() AT TIME ZONE $1)::date::text AS day', [business.timezone || 'Asia/Kolkata'])).day;
}
// A plan's last day when it starts on `startOn`: so many days, or the day
// before the same date so many months later.
function lastDayOf(plan, startOn) {
  if (plan.kind === 'sessions') return null;
  return plan.duration_unit === 'months' ? addDays(addMonths(startOn, plan.duration), -1) : addDays(startOn, plan.duration - 1);
}
// "1 month", "90 days", "12 sessions", "10 sessions in 2 months".
function termWords(plan) {
  const sessions = plan.sessions ?? plan.sessions_total;
  const time = plan.duration ? `${plan.duration} ${plan.duration_unit === 'months' ? (plan.duration === 1 ? 'month' : 'months') : (plan.duration === 1 ? 'day' : 'days')}` : null;
  if (plan.kind === 'duration') return time;
  if (plan.kind === 'sessions') return `${sessions} session${sessions === 1 ? '' : 's'}`;
  return `${sessions} session${sessions === 1 ? '' : 's'} in ${time}`;
}

// --- Status ----------------------------------------------------------------------------------------

// A membership's status on a day (SQL): closed as it was closed, else not
// started, frozen, over (past its last day), a pack used up, or active.
// `m`: the membership's alias; `day`: an SQL date.
const STATUS_SQL = (m, day) => `CASE WHEN ${m}.closed IS NOT NULL THEN ${m}.closed
  WHEN ${m}.start_on > ${day} THEN 'upcoming'
  WHEN EXISTS (SELECT 1 FROM member_freezes f WHERE f.business_id=${m}.business_id AND f.membership_id=${m}.id AND f.days>0
    AND ${day} BETWEEN f.starts_on AND f.starts_on+f.days-1) THEN 'frozen'
  WHEN ${m}.end_on IS NOT NULL AND ${day} > ${m}.end_on THEN 'expired'
  WHEN ${m}.sessions_total IS NOT NULL AND ${m}.sessions_used >= ${m}.sessions_total THEN 'used_up'
  ELSE 'active' END`;
// Still running: not closed and not over, used up or past its grace days.
const RUNNING = ['upcoming', 'active', 'frozen'];

// --- Pro-rata --------------------------------------------------------------------------------------

// The days of a freeze (from `starts`, `days` long) that fall from `from` to `to`.
function overlap(starts, days, from, to) {
  if (days <= 0 || to < from) return 0;
  const first = starts > from ? starts : from;
  const lastFrozen = addDays(starts, days - 1);
  const last = lastFrozen < to ? lastFrozen : to;
  return last < first ? 0 : daysBetween(first, last) + 1;
}
// What a membership has left when its last day counted is `lastDay`, as
// [left, whole]: the days left of those it was sold for (days frozen up to
// then are not used), the sessions left of a pack, or for a pack with a time
// the smaller of the two. Days and sessions are whole numbers.
function unusedShare(m, freezes, lastDay) {
  const shares = [];
  if (m.base_end_on) {
    const whole = daysBetween(m.start_on, m.base_end_on) + 1;
    const elapsed = Math.max(0, daysBetween(m.start_on, lastDay) + 1);
    const frozen = freezes.reduce((sum, f) => sum + overlap(f.starts_on, Number(f.days), m.start_on, lastDay), 0);
    const used = Math.min(whole, Math.max(0, elapsed - frozen));
    shares.push({ left: whole - used, whole, by: 'days', used });
  }
  if (m.sessions_total) {
    const used = Number(m.sessions_used);
    shares.push({ left: Number(m.sessions_total) - used, whole: Number(m.sessions_total), by: 'sessions', used });
  }
  return shares.reduce((a, b) => (BigInt(a.left) * BigInt(b.whole) <= BigInt(b.left) * BigInt(a.whole) ? a : b));
}
// That share of an amount in paise, rounded to the paisa (halves up).
const shareOf = (amount, share) => roundedDivide(BigInt(amount) * BigInt(share.left), BigInt(share.whole));

// --- A plan's item on a bill ------------------------------------------------------------------------

// A plan's item goes on a bill only from Members & plans, which makes the
// membership with it (the core asks this of every other sale of a business
// with the tool on).
async function checkLooseSale(db, business, lines) {
  const skuIds = [...new Set(lines.map((line) => Number(line.sku.id)))];
  const plan = await repo.one(db, `SELECT p.name FROM member_plan_types p WHERE p.business_id=$1 AND p.price_sku_id=ANY($2::bigint[]) ORDER BY p.id LIMIT 1`, [business.id, skuIds]);
  if (plan) fail(`${plan.name} is a membership plan: sell it from the Members screen, which makes the membership with its bill`, 409);
}

module.exports = { fail, requireMemberships, KINDS, UNITS, STATUSES, STATUS_WORDS, REASONS, RUNNING, id, given, paise, rupees, roundedDivide, hashOf, derivedKey,
  optionalText, readDate, addDays, daysBetween, addMonths, dateWords, today, lastDayOf, termWords, STATUS_SQL, overlap, unusedShare, shareOf, checkLooseSale };
