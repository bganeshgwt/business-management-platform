const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const c = require('./memberCommon');
const ms = require('./memberships.service');
const consents = require('../../../personal-data/services/consents');
// Refunds due, for the bell.
const account = () => require('./memberAccount.service');

// The lists the desk works from (module "member_plans"):
//
//   renewals    memberships ending in the next 7 or 15 days, and those that
//               ended in the last 30 (the renewal calls), not yet renewed and
//               with nothing else running after them for the member; each with
//               the last reminder given and a WhatsApp message ready to send.
//   fees due    each instalment with what the payments on its bill cover: due,
//               part paid, overdue (with the days) or paid. A cancelled or
//               upgraded membership's instalments no longer fall due.
//   reminders   each renewal or fees reminder given (WhatsApp, a call, SMS).
//   lists       birthdays in the next seven days, packs whose sessions run low
//               (Settings › Membership plans), and memberships whose grace days
//               are ending: each with the last reminder and a WhatsApp message
//               ready (a birthday wish needs the member's consent to offers,
//               the others to reminders).
//   counts      the day's picture: memberships active, frozen, ending soon and
//               ended lately, today's check-ins and those turned away, fees overdue.
//   the bell    memberships ending, instalments overdue, and refunds due until paid.
// "Today" is the business's date.

const { fail, id } = c;
const KINDS = ['renewal', 'fees', 'birthday', 'sessions_low', 'grace_end'];

const RENEWALS_SQL = `SELECT x.*,(x.days_left BETWEEN 0 AND 7) AS soon_7,(x.days_left BETWEEN 0 AND 15) AS soon_15,(x.days_left BETWEEN -30 AND -1) AS ended_30,
    (SELECT max(r.created_at) FROM member_reminders r WHERE r.business_id=$1 AND r.membership_id=x.id AND r.kind='renewal') AS last_reminded_at,
    (SELECT count(*)::int FROM member_reminders r WHERE r.business_id=$1 AND r.membership_id=x.id AND r.kind='renewal') AS reminders
  FROM (${ms.MEMBERSHIPS_SQL}) x
  WHERE x.closed IS NULL AND x.end_on IS NOT NULL AND x.days_left BETWEEN -30 AND 15 AND x.renewed_by_no IS NULL
    AND NOT EXISTS (SELECT 1 FROM member_memberships n WHERE n.business_id=$1 AND n.contact_id=x.contact_id AND n.id<>x.id AND n.closed IS NULL
      AND (n.end_on > x.end_on OR (n.end_on IS NULL AND n.sessions_used < n.sessions_total)))`;

// Each instalment with what the payments on its bill (less refunds) cover, in order.
const INSTALMENTS_SQL = `SELECT y.*,
    CASE WHEN y.covered >= y.amount THEN 'paid' WHEN y.due_on < y.today THEN 'overdue' WHEN y.covered > 0 THEN 'part_paid' ELSE 'due' END AS status,
    (y.covered < y.amount AND y.due_on < y.today) AS overdue,(y.covered < y.amount AND y.due_on BETWEEN y.today AND y.today+7) AS due_soon,
    (y.covered < y.amount) AS open,CASE WHEN y.covered < y.amount AND y.due_on < y.today THEN y.today-y.due_on ELSE 0 END AS days_overdue,y.amount-y.covered AS left_to_pay
  FROM (SELECT i.membership_id,i.seq,i.due_on,i.amount,m.membership_no,m.plan_name,m.contact_id,ct.name AS member_name,ct.phone AS member_phone,pr.member_code,
      m.document_id,d.document_no,m.location_id,t.today,
      (SELECT count(*)::int FROM member_instalments z WHERE z.business_id=i.business_id AND z.membership_id=i.membership_id) AS instalments,
      (SELECT max(r.created_at) FROM member_reminders r WHERE r.business_id=i.business_id AND r.membership_id=i.membership_id AND r.kind='fees') AS last_reminded_at,
      GREATEST(0,LEAST(i.amount,GREATEST(0,p.paid)-(sum(i.amount) OVER (PARTITION BY i.membership_id ORDER BY i.seq)-i.amount))) AS covered
    FROM member_instalments i JOIN member_memberships m ON m.business_id=i.business_id AND m.id=i.membership_id
    JOIN businesses bz ON bz.id=i.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE bz.timezone)::date AS today) t
    JOIN business_contacts ct ON ct.business_id=m.business_id AND ct.id=m.contact_id
    LEFT JOIN member_profiles pr ON pr.business_id=m.business_id AND pr.contact_id=m.contact_id
    JOIN business_documents d ON d.business_id=m.business_id AND d.id=m.document_id
    CROSS JOIN LATERAL (SELECT COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=m.business_id AND document_id=m.document_id),0)
      -COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=m.business_id AND document_id=m.document_id),0) AS paid) p
    WHERE i.business_id=$1 AND i.replaced_at IS NULL AND (m.closed IS NULL OR m.closed='transferred')) y`;

// The last reminder of a kind given on a membership.
const REMINDED_SQL = (kind, membership) => `(SELECT max(r.created_at) FROM member_reminders r WHERE r.business_id=$1 AND r.membership_id=${membership} AND r.kind='${kind}')`;

// Members whose birthday falls in the next seven days (the business's date),
// with the age they turn and their latest membership (theirs or a seat).
const BIRTHDAYS_SQL = `SELECT y.*,${REMINDED_SQL('birthday', 'y.membership_id')} AS last_reminded_at FROM (
  SELECT ct.id AS contact_id,ct.name AS member_name,ct.phone AS member_phone,pr.member_code,pr.date_of_birth::text AS date_of_birth,nb.next::text AS birthday,
    nb.next-t.today AS days_to,date_part('year', age(nb.next, pr.date_of_birth))::int AS turns,cur.id AS membership_id,cur.membership_no,cur.plan_name
  FROM member_profiles pr JOIN business_contacts ct ON ct.business_id=pr.business_id AND ct.id=pr.contact_id JOIN businesses b ON b.id=pr.business_id
  CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.timezone)::date AS today) t
  CROSS JOIN LATERAL (SELECT (pr.date_of_birth + make_interval(years => (extract(year FROM t.today)-extract(year FROM pr.date_of_birth))::int))::date AS this_year) ty
  CROSS JOIN LATERAL (SELECT CASE WHEN ty.this_year>=t.today THEN ty.this_year
    ELSE (pr.date_of_birth + make_interval(years => (extract(year FROM t.today)-extract(year FROM pr.date_of_birth))::int+1))::date END AS next) nb
  JOIN LATERAL (SELECT m.id,m.membership_no,m.plan_name FROM member_memberships m WHERE m.business_id=pr.business_id AND (m.contact_id=pr.contact_id
      OR EXISTS (SELECT 1 FROM member_seats s WHERE s.business_id=m.business_id AND s.membership_id=m.id AND s.contact_id=pr.contact_id))
    ORDER BY m.closed IS NULL DESC,m.id DESC LIMIT 1) cur ON TRUE
  WHERE pr.business_id=$1 AND pr.date_of_birth IS NOT NULL AND ct.active) y
WHERE y.days_to BETWEEN 0 AND 7`;

// Packs running (or not yet begun) with only a few sessions left: as few as Settings › Membership plans says, or fewer.
const SESSIONS_LOW_SQL = `SELECT x.*,${REMINDED_SQL('sessions_low', 'x.id')} AS last_reminded_at FROM (${ms.MEMBERSHIPS_SQL}) x
  WHERE x.closed IS NULL AND x.sessions_total IS NOT NULL AND x.status IN ('active','upcoming','frozen')
    AND x.sessions_left BETWEEN 1 AND COALESCE((SELECT low_sessions FROM member_settings WHERE business_id=$1),2)`;

// Memberships in their grace days (not renewed, nothing else running after them): the grace ends on grace_until.
const GRACE_SQL = `SELECT r.*,(r.grace_days+r.days_left) AS grace_days_left,${REMINDED_SQL('grace_end', 'r.id')} AS grace_reminded_at FROM (${RENEWALS_SQL}) r WHERE r.in_grace`;

repo.addLists({
  // Ending soonest first; those that ended, the most recent first after them.
  'member-renewals': { sql: RENEWALS_SQL, search: ['member_name', 'member_phone', 'member_code', 'membership_no', 'plan_name'],
    filters: { soon7: 'soon_7', soon15: 'soon_15', ended: 'ended_30', plan: 'plan_id', location: 'location_id' }, order: '(days_left < 0), abs(days_left), id' },
  'member-instalments': { sql: INSTALMENTS_SQL, search: ['member_name', 'member_phone', 'member_code', 'membership_no', 'plan_name', 'document_no'],
    filters: { status: 'status', overdue: 'overdue', due_soon: 'due_soon', open: 'open', contact: 'contact_id', membership: 'membership_id', location: 'location_id' },
    order: 'due_on, membership_id, seq' },
  'member-birthdays': { sql: BIRTHDAYS_SQL, search: ['member_name', 'member_phone', 'member_code'], order: 'days_to, member_name' },
  'member-sessions-low': { sql: SESSIONS_LOW_SQL, search: ['member_name', 'member_phone', 'member_code', 'plan_name', 'membership_no'], filters: { plan: 'plan_id' },
    order: 'sessions_left, id' },
  'member-grace-end': { sql: GRACE_SQL, search: ['member_name', 'member_phone', 'member_code', 'plan_name', 'membership_no'], order: 'grace_until, id' },
});

// body: { kind: renewal | fees | birthday | sessions_low | grace_end, channel: whatsapp | call | sms, contactId? (a seat's member) }
async function remind(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  const kind = v.requiredEnum(body.kind ?? 'renewal', 'Reminder', KINDS);
  const channel = v.requiredEnum(body.channel ?? 'whatsapp', 'How', ['whatsapp', 'call', 'sms']);
  return repo.transaction(async (db) => {
    const m = await repo.one(db, 'SELECT id,membership_no,contact_id FROM member_memberships WHERE business_id=$1 AND id=$2', [business.id, id(membershipId, 'Membership')]);
    if (!m) fail('Membership not found', 404);
    // The one the message goes to: the member, or one who uses a seat of it.
    let contactId = m.contact_id;
    if (c.given(body.contactId) && Number(body.contactId) !== Number(m.contact_id)) {
      const seat = await repo.one(db, 'SELECT contact_id FROM member_seats WHERE business_id=$1 AND membership_id=$2 AND contact_id=$3', [business.id, m.id, id(body.contactId, 'Member')]);
      if (!seat) fail(`That member has no seat on ${m.membership_no}`, 404);
      contactId = seat.contact_id;
    }
    // A message on WhatsApp, by SMS or a call needs the member's consent: to offers for a birthday wish, to reminders otherwise.
    const member = await repo.one(db, 'SELECT name FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, contactId]);
    if (kind === 'birthday') await consents.require(db, business.id, consents.personOf('contact_id', contactId), 'offers', member?.name);
    else await consents.requireReminder(db, business.id, contactId, channel, member?.name);
    const row = await repo.one(db, 'INSERT INTO member_reminders(business_id,membership_id,kind,channel,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [business.id, m.id, kind, channel, user.id]);
    await repo.audit(db, business.id, user.id, 'member.reminded', m.id, { membershipNo: m.membership_no, kind, channel });
    return row;
  });
}

// The day's picture, for the screens' chips.
async function counts(business) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  const row = await repo.one(repo.pool, `SELECT count(*) FILTER (WHERE x.status='active')::int AS active,count(*) FILTER (WHERE x.status='frozen')::int AS frozen,
      count(*) FILTER (WHERE x.status='upcoming')::int AS upcoming,count(*) FILTER (WHERE x.in_grace)::int AS in_grace,
      (SELECT count(*)::int FROM (${RENEWALS_SQL}) r WHERE r.soon_7) AS ending_7,(SELECT count(*)::int FROM (${RENEWALS_SQL}) r WHERE r.soon_15) AS ending_15,
      (SELECT count(*)::int FROM (${RENEWALS_SQL}) r WHERE r.ended_30) AS ended_30,
      (SELECT count(*)::int FROM member_checkins k JOIN businesses b ON b.id=k.business_id WHERE k.business_id=$1 AND k.allowed AND k.day=(now() AT TIME ZONE b.timezone)::date) AS checkins_today,
      (SELECT count(*)::int FROM member_checkins k JOIN businesses b ON b.id=k.business_id WHERE k.business_id=$1 AND NOT k.allowed AND k.day=(now() AT TIME ZONE b.timezone)::date) AS refused_today,
      (SELECT count(*)::int FROM (${INSTALMENTS_SQL}) i WHERE i.overdue) AS instalments_overdue,
      (SELECT COALESCE(sum(i.left_to_pay),0) FROM (${INSTALMENTS_SQL}) i WHERE i.overdue) AS fees_overdue
    FROM (${ms.MEMBERSHIPS_SQL}) x`, [business.id]);
  return ms.seesMoney(business) ? row : { ...row, fees_overdue: null };
}

// The bell: memberships ending in the next three days or in their grace days,
// and instalments overdue.
async function bell(business, base, limit) {
  const ending = await repo.all(repo.pool, `SELECT r.id,r.membership_no,r.member_name,r.plan_name,r.end_on::text AS end_on,r.days_left,r.in_grace,r.grace_until::text AS grace_until
    FROM (${RENEWALS_SQL}) r WHERE r.days_left BETWEEN 0 AND 3 OR r.in_grace ORDER BY r.end_on LIMIT $2`, [business.id, limit]);
  const items = ending.map((r) => {
    const days = Number(r.days_left);
    return { id: `membership:${r.id}:${days < 0 ? 'grace' : 'ending'}`, severity: days < 0 ? 'warning' : 'info', category: 'Memberships',
      title: days < 0 ? `${r.member_name}'s ${r.plan_name} has ended` : `${r.member_name}'s ${r.plan_name} ends ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`,
      detail: days < 0 ? `${r.membership_no} · in grace until ${c.dateWords(r.grace_until)}` : `${r.membership_no} · ask about renewing`,
      at: `${r.end_on}T00:00:00.000Z`, link: `${base}/renewals` };
  });
  if (ms.seesMoney(business)) {
    const fees = await repo.all(repo.pool, `SELECT i.membership_id,i.seq,i.membership_no,i.member_name,i.due_on::text AS due_on,i.days_overdue,i.left_to_pay
      FROM (${INSTALMENTS_SQL}) i WHERE i.overdue ORDER BY i.due_on LIMIT $2`, [business.id, limit]);
    for (const f of fees) {
      items.push({ id: `instalment:${f.membership_id}:${f.seq}`, severity: Number(f.days_overdue) > 30 ? 'critical' : 'warning', category: 'Fees',
        title: `${f.member_name}: instalment ${f.seq} overdue`, detail: `${f.left_to_pay} · ${f.membership_no} · due ${c.dateWords(f.due_on)}`,
        at: `${f.due_on}T00:00:00.000Z`, link: `${base}/renewals?show=fees` });
    }
    // Money to go back to a member, until it is paid.
    const refunds = await repo.all(repo.pool, `SELECT r.id,r.membership_no,r.member_name,r.amount,r.due_on::text AS due_on,r.due_now FROM (${account().REFUNDS_SQL}) r
      WHERE r.open ORDER BY r.due_on LIMIT $2`, [business.id, limit]);
    for (const r of refunds) {
      items.push({ id: `member-refund:${r.id}`, severity: r.due_now ? 'warning' : 'info', category: 'Memberships',
        title: `${r.member_name}: ${r.amount} to go back`, detail: `${r.membership_no} · ${r.due_now ? 'due' : 'due on'} ${c.dateWords(r.due_on)}`,
        at: `${r.due_on}T00:00:00.000Z`, link: `${base}/renewals?show=refunds` });
    }
  }
  return items;
}

module.exports = { remind, counts, bell, RENEWALS_SQL, INSTALMENTS_SQL, KINDS };
