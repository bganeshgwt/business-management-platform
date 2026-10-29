const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./memberCommon');
const ms = require('./memberships.service');
const plans = require('./memberPlans.service');
// The open items of a customer, oldest first, as the shared receivables age them.
const receivables = () => require('../../wholesale/services/businessReceivables.service');

// Check-in at the front desk (module "member_plans"):
//
//   A member is found by their code (typed, or scanned from the QR on their
//   card) or picked from a search, and let in on a membership that runs today
//   (started, not frozen, within its last day or its grace days, with a
//   session left on a pack), or turned away with the reason: no membership,
//   not started yet, over, frozen, no sessions left, or fees overdue by more
//   than the business's days (Settings › Membership plans). A pack loses one
//   session a day: coming back the same day uses none. Every check-in is
//   kept, let in or not. The membership used: the one asked for, else a
//   membership by time before a pack (no session is used then), the pack
//   ending first before the others.
//   A membership lets its member in only at the branches and between the
//   hours its plan allows, and within its visits a day, a week (Monday to
//   Sunday on the business's calendar), a month or in all; else the member
//   is turned away with that reason. Each member of a shared membership (its
//   seats) checks in on their own. A member checking in for a class booked
//   now (starting within the hour, or begun up to half an hour ago) is marked
//   attended; the class takes the pack's session for the day.

const { fail, id, paise, rupees } = c;
// A class booked on the membership: its attendance is marked with the check-in.
const classes = () => require('./memberClasses.service');

// Fees overdue by more than `days` days: bills past their due day (a bill in
// instalments counts by its instalments instead), and instalments past
// theirs, not yet paid. Returns { amount (paise), days (the most overdue) }.
async function overdueFees(db, business, contactId, day, days) {
  const bills = await repo.one(db, `WITH oi AS (${receivables().openItemsSql})
    SELECT COALESCE(sum(open_amount),0) AS amount,COALESCE(max(days_overdue),0)::int AS days FROM oi
    WHERE open_amount > 0 AND days_overdue > $3 AND (document_id IS NULL OR NOT EXISTS (SELECT 1 FROM member_memberships m
      WHERE m.business_id=$1 AND m.document_id=oi.document_id AND EXISTS (SELECT 1 FROM member_instalments i WHERE i.business_id=m.business_id AND i.membership_id=m.id)))`,
  [business.id, contactId, days]);
  let amount = paise(bills.amount), most = Number(bills.days);
  const scheduled = await repo.all(db, `SELECT DISTINCT m.id,m.document_id FROM member_memberships m JOIN member_instalments i ON i.business_id=m.business_id AND i.membership_id=m.id
    WHERE m.business_id=$1 AND m.contact_id=$2 AND m.transferred_from IS NULL AND (m.closed IS NULL OR m.closed='transferred')`, [business.id, contactId]);
  for (const m of scheduled) {
    for (const i of await ms.instalmentsOf(db, business, m, day)) {
      if (i.status === 'overdue' && i.days_overdue > days) {
        amount += paise(i.amount) - paise(i.covered);
        most = Math.max(most, i.days_overdue);
      }
    }
  }
  return { amount, days: most };
}

// The member's memberships that have not been closed (their own, or a seat
// of a shared one), with their status today, their visits in the plan's
// period, and whether they let the member in here and now.
async function membershipsOf(db, business, contactId, day, { locationId = null, time = null } = {}) {
  const list = await repo.all(db, `SELECT m.id,m.membership_no,m.plan_name,m.kind,m.start_on::text AS start_on,m.end_on::text AS end_on,m.grace_days,m.sessions_total,m.sessions_used,
      m.seats,m.access_locations,m.access_from::text AS access_from,m.access_to::text AS access_to,m.visit_limit,m.visit_period,
      ${c.STATUS_SQL('m', '$3::date')} AS status,(m.end_on IS NOT NULL AND $3::date > m.end_on AND $3::date <= m.end_on+m.grace_days) AS in_grace,
      (SELECT (f.starts_on+f.days-1)::text FROM member_freezes f WHERE f.business_id=m.business_id AND f.membership_id=m.id AND f.days>0
        AND $3::date BETWEEN f.starts_on AND f.starts_on+f.days-1 LIMIT 1) AS frozen_until,
      EXISTS (SELECT 1 FROM member_checkins k WHERE k.business_id=m.business_id AND k.membership_id=m.id AND k.contact_id=$2 AND k.day=$3::date AND k.session_used) AS session_today,
      (SELECT min(k.created_at) FROM member_checkins k WHERE k.business_id=m.business_id AND k.membership_id=m.id AND k.contact_id=$2 AND k.day=$3::date AND k.allowed) AS first_today,
      (SELECT count(*)::int FROM member_checkins k WHERE k.business_id=m.business_id AND k.membership_id=m.id AND k.contact_id=$2 AND k.allowed
        AND k.day BETWEEN CASE m.visit_period WHEN 'day' THEN $3::date WHEN 'week' THEN date_trunc('week', $3::date)::date WHEN 'month' THEN date_trunc('month', $3::date)::date
          ELSE m.start_on END AND $3::date) AS visits,
      EXISTS (SELECT 1 FROM member_class_bookings b JOIN member_class_sessions s ON s.business_id=b.business_id AND s.id=b.session_id WHERE b.business_id=m.business_id
        AND b.membership_id=m.id AND b.contact_id=$2 AND s.day=$3::date AND b.status IN ('booked','promoted','attended')) AS class_today,
      (SELECT array_agg(l.name ORDER BY l.name) FROM business_locations l WHERE l.business_id=m.business_id AND l.id=ANY(m.access_locations)) AS location_names
    FROM member_memberships m WHERE m.business_id=$1 AND m.closed IS NULL
      AND ((m.seats=1 AND m.contact_id=$2) OR (m.seats>1 AND EXISTS (SELECT 1 FROM member_seats s WHERE s.business_id=m.business_id AND s.membership_id=m.id AND s.contact_id=$2
        AND s.removed_at IS NULL)))
    ORDER BY (m.sessions_total IS NOT NULL), m.end_on NULLS LAST, m.id`, [business.id, contactId, day]);
  return list.map((m) => {
    const runs = m.status === 'active' || (m.status === 'expired' && m.in_grace && !(m.sessions_total && m.sessions_used >= m.sessions_total));
    const limit = runs ? limitOf(m, locationId, time) : null;
    return { ...m, limit, usable: runs && !limit };
  });
}

// Why a running membership does not let the member in here and now: another
// branch, outside its hours, or its visits used.
function limitOf(m, locationId, time) {
  if (locationId && m.access_locations && !m.access_locations.map(Number).includes(Number(locationId))) {
    return { reason: 'branch', words: `${m.plan_name} lets the member in at ${(m.location_names || []).join(', ')} only` };
  }
  if (time && m.access_from && (time < m.access_from || time >= m.access_to)) {
    return { reason: 'time_of_day', words: `${m.plan_name} lets the member in from ${c.hhmm(m.access_from)} to ${c.hhmm(m.access_to)}` };
  }
  if (m.visit_limit && Number(m.visits) >= Number(m.visit_limit)) {
    return { reason: 'visit_limit', words: `${m.plan_name} allows ${m.visit_limit} visit${Number(m.visit_limit) === 1 ? '' : 's'} ${c.PERIOD_WORDS[m.visit_period]}: all are used` };
  }
  return null;
}

// Why a membership does not let the member in, and in words.
function refusalOf(m) {
  if (m.limit) return m.limit;
  if (m.status === 'frozen') return { reason: 'frozen', words: `${m.plan_name} is frozen until ${c.dateWords(m.frozen_until)}` };
  if (m.status === 'upcoming') return { reason: 'not_started', words: `${m.plan_name} starts on ${c.dateWords(m.start_on)}` };
  if (m.status === 'used_up' || (m.sessions_total && m.sessions_used >= m.sessions_total)) return { reason: 'no_sessions', words: `all ${m.sessions_total} sessions of ${m.plan_name} are used` };
  return { reason: 'expired', words: `${m.plan_name} ended on ${c.dateWords(m.end_on)}${Number(m.grace_days) ? ` (its ${m.grace_days} grace days are over)` : ''}` };
}
const REFUSAL_ORDER = ['branch', 'time_of_day', 'visit_limit', 'frozen', 'not_started', 'no_sessions', 'expired'];

async function findMember(db, business, body) {
  if (c.given(body.contactId)) {
    const member = await repo.one(db, `SELECT ct.id,ct.name,ct.phone,ct.active,pr.member_code FROM business_contacts ct
      LEFT JOIN member_profiles pr ON pr.business_id=ct.business_id AND pr.contact_id=ct.id WHERE ct.business_id=$1 AND ct.id=$2 AND ct.kind='customer'`, [business.id, id(body.contactId, 'Member')]);
    if (!member) fail('Member not found', 404);
    return { member, foundBy: 'search' };
  }
  const code = String(body.code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) fail('Type or scan the member\'s code, or find them by name or phone');
  const member = await repo.one(db, `SELECT ct.id,ct.name,ct.phone,ct.active,pr.member_code FROM member_profiles pr
    JOIN business_contacts ct ON ct.business_id=pr.business_id AND ct.id=pr.contact_id WHERE pr.business_id=$1 AND pr.member_code=$2`, [business.id, code.slice(0, 20)]);
  if (!member) fail(`No member has the code ${code.slice(0, 20)}`, 404, { reason: 'unknown_code' });
  return { member, foundBy: 'code' };
}

async function resultOf(db, business, row) {
  const k = await repo.one(db, `SELECT k.id,k.day::text AS day,k.created_at,k.allowed,k.reason,k.note,k.session_used,k.found_by,k.contact_id,k.membership_id,
      ct.name AS member_name,ct.phone AS member_phone,pr.member_code,m.membership_no,m.plan_name,m.start_on::text AS start_on,m.end_on::text AS end_on,m.grace_days,
      CASE WHEN m.sessions_total IS NULL THEN NULL ELSE m.sessions_total-m.sessions_used END AS sessions_left,m.sessions_total,l.name AS location_name
    FROM member_checkins k JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id
    LEFT JOIN member_profiles pr ON pr.business_id=k.business_id AND pr.contact_id=k.contact_id
    LEFT JOIN member_memberships m ON m.business_id=k.business_id AND m.id=k.membership_id
    JOIN business_locations l ON l.business_id=k.business_id AND l.id=k.location_id WHERE k.business_id=$1 AND k.id=$2`, [business.id, row.id]);
  const earlier = k.allowed && !k.session_used && k.membership_id ? await repo.one(db, `SELECT min(created_at) AS at FROM member_checkins WHERE business_id=$1 AND membership_id=$2
    AND day=$3::date AND allowed AND id<$4 AND contact_id=$5`, [business.id, k.membership_id, k.day, k.id, k.contact_id]) : null;
  return { ...k, again_today: Boolean(earlier?.at), first_today_at: earlier?.at || null, words: k.allowed ? null : `${k.member_name}: ${k.note}`, others: [] };
}

// body: { requestKey, locationId, contactId | code, membershipId? }
async function checkIn(business, user, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  const requestKey = core.uuid(body.requestKey);
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  const asked = c.given(body.membershipId) ? id(body.membershipId, 'Membership') : null;
  return repo.transaction(async (db) => {
    const old = await repo.one(db, 'SELECT id FROM member_checkins WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) return resultOf(db, business, old);
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    const { member, foundBy } = await findMember(db, business, body);
    const { day, time } = await c.now(db, business);
    // The member's memberships (and seats), locked: a pack's session is counted once a day.
    await db.query(`SELECT id FROM member_memberships m WHERE m.business_id=$1 AND m.closed IS NULL AND (m.contact_id=$2 OR EXISTS (SELECT 1 FROM member_seats s
      WHERE s.business_id=m.business_id AND s.membership_id=m.id AND s.contact_id=$2 AND s.removed_at IS NULL)) ORDER BY id FOR UPDATE`, [business.id, member.id]);
    const list = await membershipsOf(db, business, member.id, day, { locationId: location.id, time });
    let chosen = null, refusal = null;
    if (asked) {
      chosen = list.find((m) => Number(m.id) === asked);
      if (!chosen) {
        const any = await repo.one(db, 'SELECT membership_no,closed,contact_id FROM member_memberships WHERE business_id=$1 AND id=$2', [business.id, asked]);
        if (!any || Number(any.contact_id) !== Number(member.id)) fail('That membership is not this member\'s', 404);
        fail(`Membership ${any.membership_no} was ${any.closed}`, 409);
      }
      if (!chosen.usable) refusal = refusalOf(chosen);
    } else {
      chosen = list.find((m) => m.usable) || null;
      if (!chosen && list.length) {
        chosen = [...list].sort((a, b) => REFUSAL_ORDER.indexOf(refusalOf(a).reason) - REFUSAL_ORDER.indexOf(refusalOf(b).reason))[0];
        refusal = refusalOf(chosen);
      }
    }
    if (!chosen) refusal = { reason: 'no_membership', words: 'no membership is running' };
    // Fees overdue too long turn a member away even with a membership running.
    let note = null;
    if (!refusal) {
      const settings = await plans.settingsOf(db, business.id);
      if (settings.duesBlockDays !== null) {
        const dues = await overdueFees(db, business, member.id, day, settings.duesBlockDays);
        if (dues.amount > 0) refusal = { reason: 'dues', words: `fees are ${dues.days} days overdue`, amount: dues.amount };
      }
      if (!refusal && chosen.in_grace) note = `${chosen.plan_name} ended on ${c.dateWords(chosen.end_on)}: in its grace days until ${c.dateWords(c.addDays(chosen.end_on, Number(chosen.grace_days)))}`;
    }
    // A pack's session for the day: none when a class booked today on it takes one.
    const sessionUsed = !refusal && Boolean(chosen.sessions_total) && !chosen.session_today && !chosen.class_today;
    const row = await repo.one(db, `INSERT INTO member_checkins(business_id,location_id,contact_id,membership_id,day,found_by,allowed,reason,note,session_used,request_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [business.id, location.id, member.id, chosen?.id || null, day, foundBy, !refusal, refusal?.reason || null,
      (refusal ? refusal.words : note)?.slice(0, 300) || null, sessionUsed, requestKey, user.id]);
    // A class booked now is attended.
    const attended = refusal ? [] : await classes().attendAtCheckIn(db, business, user, member.id);
    await repo.audit(db, business.id, user.id, refusal ? 'member.checkin_refused' : 'member.checked_in', row.id, { member: member.name, membershipNo: chosen?.membership_no || null,
      ...(refusal ? { reason: refusal.reason } : {}), ...(sessionUsed ? { sessionUsed: true } : {}) });
    if (sessionUsed) {
      await repo.event(db, business.id, user.id, 'membership.session_used', 'membership', chosen.id, { membershipNo: chosen.membership_no, contactId: member.id, checkinId: row.id,
        sessionsLeft: Number(chosen.sessions_total) - Number(chosen.sessions_used) - 1 });
    }
    // The member's other memberships that would let them in (a pack's session instead, say).
    const others = list.filter((m) => m.usable && Number(m.id) !== Number(chosen?.id)).map((m) => ({ id: m.id, membership_no: m.membership_no, plan_name: m.plan_name,
      sessions_left: m.sessions_total ? Number(m.sessions_total) - Number(m.sessions_used) : null, session_today: m.session_today }));
    return { ...(await resultOf(db, business, row)), fees_overdue: refusal?.amount && ms.seesMoney(business) ? rupees(refusal.amount) : null,
      others: refusal?.reason === 'dues' ? [] : others, classes: attended };
  });
}

// --- Today's check-ins --------------------------------------------------------------------------------

const CHECKINS_SQL = `SELECT k.id,k.day::text AS day,k.created_at,k.location_id,l.name AS location_name,k.contact_id,ct.name AS member_name,ct.phone AS member_phone,pr.member_code,
    k.membership_id,m.membership_no,m.plan_name,k.allowed,k.reason,k.note,k.session_used,k.found_by,u.name AS by_name,
    CASE WHEN m.sessions_total IS NULL THEN NULL ELSE m.sessions_total-m.sessions_used END AS sessions_left
  FROM member_checkins k JOIN business_locations l ON l.business_id=k.business_id AND l.id=k.location_id
  JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id
  LEFT JOIN member_profiles pr ON pr.business_id=k.business_id AND pr.contact_id=k.contact_id
  LEFT JOIN member_memberships m ON m.business_id=k.business_id AND m.id=k.membership_id
  JOIN users u ON u.id=k.created_by WHERE k.business_id=$1`;
repo.addLists({
  'member-checkins': { sql: CHECKINS_SQL, search: ['member_name', 'member_phone', 'member_code', 'membership_no', 'plan_name'], date: 'created_at',
    filters: { allowed: 'allowed', reason: 'reason', location: 'location_id', contact: 'contact_id', membership: 'membership_id', day: 'day' }, order: 'id DESC' },
});

module.exports = { checkIn, overdueFees, membershipsOf };
