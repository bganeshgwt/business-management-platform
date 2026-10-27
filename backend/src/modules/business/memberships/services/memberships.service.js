const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const c = require('./memberCommon');
// The core's pricing of lines as a sale, without saving (quotations).
const quotes = () => require('../../quotations/services/businessQuotations.service');

// Memberships (module "member_plans", gyms, studios and coaching centres).
//
//   sell      a plan to a member (one of the customers, or a new one typed
//             with the sale) from a day, today or later: the bill is posted by
//             the core with the plan's item (and the joining fee with a
//             member's first membership), priced as any sale (customer prices,
//             offers, the discount, GST, round-off), paid now or left on the
//             member's dues; the membership keeps the plan's terms as sold and
//             the policy version. A fee may be split into instalments adding
//             up to the bill; the bill then falls due on the last of them.
//   renew     a new membership of a plan for the same member, starting the
//             day after the one renewed ends (while it runs or within its
//             grace days; after that, from today).
// A member gets a code (M0001) with their first membership, for their card
// and the desk. Someone who does not see sales sees memberships without money.

const { fail, id, paise, rupees } = c;
const MAX_START_AHEAD = 180;
const MAX_INSTALMENTS = 36;
const MONEY_FIELDS = ['price', 'price_net', 'price_tax', 'joining_fee', 'bill_total', 'bill_due', 'credit', 'refunded', 'dues', 'overdue'];

// What is still to pay on a bill: its total less returns and payments, plus refunds.
const DUE_SQL = (d) => `(${d}.total
  -COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
  -COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
  +COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;

// --- Lists ------------------------------------------------------------------------------------------

// Every membership with its status today (the business's date).
const MEMBERSHIPS_SQL = `SELECT x.*,CASE WHEN x.status IN ('upcoming','active','frozen') THEN 'running' WHEN x.in_grace THEN 'running' ELSE 'ended' END AS stage FROM (
  SELECT m.id,m.membership_no,m.location_id,l.name AS location_name,m.contact_id,ct.name AS member_name,ct.phone AS member_phone,pr.member_code,
    m.plan_id,m.plan_name,m.kind,m.duration_unit,m.duration,m.sessions_total,m.sessions_used,
    CASE WHEN m.sessions_total IS NULL THEN NULL ELSE m.sessions_total-m.sessions_used END AS sessions_left,
    m.price,m.joining_fee,m.tax_rate,m.start_on,m.base_end_on,m.frozen_days,m.end_on,m.grace_days,
    CASE WHEN m.end_on IS NULL THEN NULL ELSE m.end_on+m.grace_days END AS grace_until,
    m.closed,m.closed_on,m.renewal_of,m.upgraded_from,m.transferred_from,m.document_id,d.document_no,m.credit,m.refunded,m.created_at,
    ${c.STATUS_SQL('m', 't.today')} AS status,
    (m.closed IS NULL AND m.end_on IS NOT NULL AND t.today > m.end_on AND t.today <= m.end_on+m.grace_days) AS in_grace,
    CASE WHEN m.end_on IS NULL THEN NULL ELSE m.end_on-t.today END AS days_left,
    CASE WHEN m.transferred_from IS NULL THEN ${DUE_SQL('d')} END AS bill_due,
    (SELECT r.membership_no FROM member_memberships r WHERE r.business_id=m.business_id AND r.renewal_of=m.id AND r.closed IS NULL ORDER BY r.id LIMIT 1) AS renewed_by_no,
    (SELECT max(k.created_at) FROM member_checkins k WHERE k.business_id=m.business_id AND k.membership_id=m.id AND k.allowed) AS last_checkin_at
  FROM member_memberships m JOIN businesses bz ON bz.id=m.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE bz.timezone)::date AS today) t
  JOIN business_locations l ON l.business_id=m.business_id AND l.id=m.location_id
  JOIN business_contacts ct ON ct.business_id=m.business_id AND ct.id=m.contact_id
  LEFT JOIN member_profiles pr ON pr.business_id=m.business_id AND pr.contact_id=m.contact_id
  JOIN business_documents d ON d.business_id=m.business_id AND d.id=m.document_id
  WHERE m.business_id=$1) x`;

// How much a membership matters now, for a member's "current" one.
const RANK_SQL = (status, inGrace) => `CASE ${status} WHEN 'active' THEN 0 WHEN 'frozen' THEN 1 WHEN 'upcoming' THEN 2
  WHEN 'expired' THEN CASE WHEN ${inGrace} THEN 3 ELSE 4 END WHEN 'used_up' THEN 5 ELSE 6 END`;
// Every member (a customer with a member code) with their current membership:
// running first (a plan by time before a pack, the one ending first), then
// the one that ended last.
const MEMBERS_SQL = `SELECT ct.id AS contact_id,ct.name,ct.phone,ct.email,ct.active,pr.member_code,pr.created_at AS member_since,
    cur.id AS membership_id,cur.membership_no,cur.plan_id,cur.plan_name,cur.kind,cur.status,cur.in_grace,cur.start_on,cur.end_on,cur.grace_until,cur.days_left,
    cur.sessions_left,cur.sessions_total,
    (SELECT count(*)::int FROM (${MEMBERSHIPS_SQL}) r WHERE r.contact_id=ct.id AND r.stage='running') AS running,
    ${repo.contactBalanceSql('ct')} AS dues,
    (SELECT max(k.created_at) FROM member_checkins k WHERE k.business_id=ct.business_id AND k.contact_id=ct.id AND k.allowed) AS last_checkin_at
  FROM member_profiles pr JOIN business_contacts ct ON ct.business_id=pr.business_id AND ct.id=pr.contact_id
  LEFT JOIN LATERAL (SELECT * FROM (${MEMBERSHIPS_SQL}) y WHERE y.contact_id=ct.id
    ORDER BY ${RANK_SQL('y.status', 'y.in_grace')}, (y.sessions_total IS NOT NULL), CASE WHEN y.stage='running' THEN y.end_on END NULLS LAST, y.end_on DESC NULLS LAST, y.id DESC
    LIMIT 1) cur ON TRUE
  WHERE pr.business_id=$1`;

repo.addLists({
  'member-memberships': { sql: MEMBERSHIPS_SQL, search: ['membership_no', 'member_name', 'member_phone', 'member_code', 'plan_name', 'document_no'], date: 'created_at',
    filters: { status: 'status', stage: 'stage', plan: 'plan_id', contact: 'contact_id', location: 'location_id', kind: 'kind' }, order: 'id DESC' },
  'member-members': { sql: `SELECT * FROM (${MEMBERS_SQL}) z`, search: ['name', 'phone', 'member_code', 'membership_no', 'plan_name'],
    filters: { status: 'status', plan: 'plan_id', active: 'active' }, order: `${RANK_SQL('status', 'in_grace')}, end_on NULLS LAST, lower(name), contact_id` },
});

// What someone who does not see sales sees: no money.
const seesMoney = (business) => access.can(business, 'sales.view');
function withoutMoney(row) {
  const out = { ...row };
  for (const key of MONEY_FIELDS) if (key in out) out[key] = null;
  if (Array.isArray(out.instalments)) out.instalments = out.instalments.map((i) => ({ ...i, amount: null, covered: null }));
  if ('bill' in out) out.bill = null;
  if (Array.isArray(out.events)) out.events = out.events.map((e) => ({ ...e, details: {} }));
  return out;
}
const shape = (business, row) => (seesMoney(business) ? { ...row, money: true } : { ...withoutMoney(row), money: false });
const listShape = (business, page) => (seesMoney(business) ? page : { ...page, items: page.items.map(withoutMoney) });

// --- Reading -----------------------------------------------------------------------------------------

// A membership's instalments with what the payments on its bill cover, in order.
async function instalmentsOf(db, business, m, day) {
  const list = await repo.all(db, 'SELECT seq,due_on::text AS due_on,amount FROM member_instalments WHERE business_id=$1 AND membership_id=$2 ORDER BY seq', [business.id, m.id]);
  if (!list.length) return [];
  const paid = await repo.one(db, `SELECT COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0)
    -COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS paid`, [business.id, m.document_id]);
  let left = Math.max(0, paise(paid.paid));
  return list.map((i) => {
    const amount = paise(i.amount);
    const covered = Math.min(amount, left);
    left -= covered;
    const status = covered === amount ? 'paid' : i.due_on < day ? 'overdue' : covered > 0 ? 'part_paid' : 'due';
    return { seq: i.seq, due_on: i.due_on, amount: i.amount, covered: rupees(covered), status, days_overdue: status === 'overdue' ? c.daysBetween(i.due_on, day) : 0 };
  });
}

async function load(db, business, membershipId) {
  const m = await repo.one(db, `SELECT * FROM (${MEMBERSHIPS_SQL}) w WHERE w.id=$2`, [business.id, membershipId]);
  if (!m) fail('Membership not found', 404);
  const day = await c.today(db, business);
  // One query at a time: `db` may be a transaction's own client.
  const row = await repo.one(db, `SELECT m.price_net,m.price_tax,m.policy_version,m.max_freeze_days,m.max_freezes,m.transferable,m.close_reason,m.closed_at,m.notes,
      m.line_id,m.joining_line_id,m.return_id,m.refund_id,m.approved_by,ap.name AS approved_by_name,cb.name AS closed_by_name,u.name AS created_by_name,
      pol.policy,rt.return_no,
      (SELECT membership_no FROM member_memberships WHERE business_id=m.business_id AND id=COALESCE(m.renewal_of,m.upgraded_from,m.transferred_from)) AS source_no,
      (SELECT json_agg(json_build_object('id',n.id,'membership_no',n.membership_no,'how',CASE WHEN n.renewal_of=m.id THEN 'renewal' WHEN n.upgraded_from=m.id THEN 'upgrade' ELSE 'transfer' END,
        'member_name',nc.name) ORDER BY n.id) FROM member_memberships n JOIN business_contacts nc ON nc.business_id=n.business_id AND nc.id=n.contact_id
        WHERE n.business_id=m.business_id AND (n.renewal_of=m.id OR n.upgraded_from=m.id OR n.transferred_from=m.id)) AS followed_by
    FROM member_memberships m JOIN users u ON u.id=m.created_by LEFT JOIN users ap ON ap.id=m.approved_by LEFT JOIN users cb ON cb.id=m.closed_by
    JOIN member_plan_policies pol ON pol.business_id=m.business_id AND pol.plan_id=m.plan_id AND pol.version=m.policy_version
    LEFT JOIN business_returns rt ON rt.business_id=m.business_id AND rt.id=m.return_id
    WHERE m.business_id=$1 AND m.id=$2`, [business.id, m.id]);
  const freezes = await repo.all(db, `SELECT f.id,f.starts_on::text AS starts_on,f.planned_days,f.days,f.reason,f.ended_on::text AS ended_on,f.created_at,u.name AS created_by_name,
      (f.days>0 AND $3::date BETWEEN f.starts_on AND f.starts_on+f.days-1) AS current,(f.ended_on IS NULL AND f.starts_on>$3::date) AS ahead
    FROM member_freezes f JOIN users u ON u.id=f.created_by WHERE f.business_id=$1 AND f.membership_id=$2 ORDER BY f.starts_on,f.id`, [business.id, m.id, day]);
  const events = await repo.all(db, `SELECT e.id,e.kind,e.note,e.details,e.created_at,u.name AS by_name FROM member_events e JOIN users u ON u.id=e.created_by
    WHERE e.business_id=$1 AND e.membership_id=$2 ORDER BY e.id`, [business.id, m.id]);
  const instalments = await instalmentsOf(db, business, m, day);
  const bill = m.transferred_from ? null : await repo.one(db, `SELECT d.id,d.document_no,d.total,d.due_on::text AS due_on,${DUE_SQL('d')} AS due FROM business_documents d
    WHERE d.business_id=$1 AND d.id=$2`, [business.id, m.document_id]);
  const reminders = await repo.all(db, `SELECT r.kind,r.channel,r.created_at,u.name AS by_name FROM member_reminders r JOIN users u ON u.id=r.created_by
    WHERE r.business_id=$1 AND r.membership_id=$2 ORDER BY r.id DESC LIMIT 10`, [business.id, m.id]);
  const freezesTaken = freezes.filter((f) => Number(f.days) > 0).length, daysFrozen = freezes.reduce((s, f) => s + Number(f.days), 0);
  return { ...m, ...row, term: c.termWords({ ...m, sessions: m.sessions_total }), today: day, freezes, events, instalments, bill, reminders,
    freeze_left: { freezes: Math.max(0, Number(row.max_freezes) - freezesTaken), days: Math.max(0, Number(row.max_freeze_days) - daysFrozen) } };
}

async function detail(business, membershipId) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  return shape(business, await load(repo.pool, business, id(membershipId, 'Membership')));
}

// A member: their code, their memberships (current ones first) and their last check-ins.
async function member(business, contactId) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.view');
  const contact = await repo.one(repo.pool, `SELECT ct.id,ct.name,ct.phone,ct.email,ct.address,ct.active,pr.member_code,pr.created_at AS member_since,${repo.contactBalanceSql('ct')} AS dues
    FROM business_contacts ct LEFT JOIN member_profiles pr ON pr.business_id=ct.business_id AND pr.contact_id=ct.id
    WHERE ct.business_id=$1 AND ct.id=$2 AND ct.kind='customer'`, [business.id, id(contactId, 'Member')]);
  if (!contact) fail('Member not found', 404);
  const ids = await repo.all(repo.pool, `SELECT id FROM (${MEMBERSHIPS_SQL}) w WHERE w.contact_id=$2 ORDER BY ${RANK_SQL('w.status', 'w.in_grace')}, w.start_on DESC, w.id DESC`,
    [business.id, contact.id]);
  const memberships = [];
  for (const row of ids) memberships.push(shape(business, await load(repo.pool, business, row.id)));
  const checkins = await repo.all(repo.pool, `SELECT k.id,k.day::text AS day,k.created_at,k.allowed,k.reason,k.note,k.session_used,k.found_by,m.membership_no,l.name AS location_name,u.name AS by_name
    FROM member_checkins k LEFT JOIN member_memberships m ON m.business_id=k.business_id AND m.id=k.membership_id
    JOIN business_locations l ON l.business_id=k.business_id AND l.id=k.location_id JOIN users u ON u.id=k.created_by
    WHERE k.business_id=$1 AND k.contact_id=$2 ORDER BY k.id DESC LIMIT 30`, [business.id, contact.id]);
  return { member: seesMoney(business) ? contact : { ...contact, dues: null }, memberships, checkins, money: seesMoney(business) };
}

// --- A member's code -----------------------------------------------------------------------------------

// The member's code, made with their first membership: M0001, M0002 …
// (skipping any typed by hand).
async function ensureProfile(db, business, user, contactId) {
  const found = await repo.one(db, 'SELECT * FROM member_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, contactId]);
  if (found) return found;
  for (;;) {
    const counter = await repo.one(db, `INSERT INTO member_settings(business_id,last_member_no) VALUES($1,1)
      ON CONFLICT (business_id) DO UPDATE SET last_member_no=member_settings.last_member_no+1 RETURNING last_member_no`, [business.id]);
    const code = `M${String(counter.last_member_no).padStart(4, '0')}`;
    if (await repo.one(db, 'SELECT 1 FROM member_profiles WHERE business_id=$1 AND member_code=$2', [business.id, code])) continue;
    return repo.one(db, 'INSERT INTO member_profiles(business_id,contact_id,member_code,created_by,updated_by) VALUES($1,$2,$3,$4,$4) RETURNING *', [business.id, contactId, code, user.id]);
  }
}

const readCode = (value) => {
  const code = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) fail('A member code is 2 to 20 letters, digits or dashes (the number on the member\'s card)');
  return code;
};
// body: { code } — the number on a card the member already holds, say.
async function changeCode(business, user, contactId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const code = readCode(body.code);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM member_profiles WHERE business_id=$1 AND contact_id=$2 FOR UPDATE', [business.id, id(contactId, 'Member')]);
    if (!current) fail('Member not found: a member gets a code with their first membership', 404);
    if (current.member_code === code) return current;
    const taken = await repo.one(db, `SELECT ct.name FROM member_profiles pr JOIN business_contacts ct ON ct.business_id=pr.business_id AND ct.id=pr.contact_id
      WHERE pr.business_id=$1 AND pr.member_code=$2`, [business.id, code]);
    if (taken) fail(`${code} is ${taken.name}'s code`, 409);
    const row = await repo.one(db, 'UPDATE member_profiles SET member_code=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND contact_id=$2 RETURNING *',
      [business.id, current.contact_id, code, user.id]);
    await repo.audit(db, business.id, user.id, 'member.code_changed', current.contact_id, { from: current.member_code, to: code });
    return row;
  });
}

// --- Selling -----------------------------------------------------------------------------------------

// A member typed with the sale: { name, phone?, email? } (made a customer).
function readNewMember(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('A new member is a name, with a phone and an e-mail if they give them');
  // consents: what the member agrees to as they join (bills, reminders, offers), recorded with the contact.
  return { kind: 'customer', name: value.name, phone: value.phone, email: value.email, consents: value.consents };
}
// Instalments: [{ dueOn, amount }], two or more, each later than the one before.
function readInstalments(value) {
  if (value === undefined || value === null) return null;
  const list = v.requiredArray(value, 'Instalments');
  if (!list.length) return null;
  if (list.length < 2 || list.length > MAX_INSTALMENTS) fail(`A fee in instalments has from 2 to ${MAX_INSTALMENTS} of them`);
  const read = list.map((x, i) => {
    if (!x || typeof x !== 'object') fail(`Instalment ${i + 1} needs its amount and due day`);
    return { dueOn: c.readDate(x.dueOn, `Instalment ${i + 1}: due on`), amount: paise(core.decimal(x.amount, `Instalment ${i + 1}: amount`, 2, 0.01, 100000000)) };
  });
  read.forEach((x, i) => { if (i && x.dueOn <= read[i - 1].dueOn) fail(`Instalment ${i + 1} falls due after instalment ${i}`); });
  return read;
}
function checkInstalments(list, day, total) {
  if (!list) return;
  if (list[0].dueOn < day) fail('The first instalment falls due today or later');
  if (list.at(-1).dueOn > c.addDays(day, 3 * 366)) fail('The last instalment falls due within three years');
  const sum = list.reduce((s, x) => s + x.amount, 0);
  if (sum !== total) fail(`The instalments add up to ${rupees(sum)}, not the bill's ${rupees(total)}`, 409, { reason: 'instalments_total', billTotal: rupees(total) });
}

// The sale as asked: the plan, the member, the start, the joining fee, the discount.
function readSale(body) {
  return {
    locationId: id(body.locationId, 'Location'), planId: id(body.planId, 'Plan'),
    contactId: c.given(body.contactId) ? id(body.contactId, 'Member') : null, newMember: readNewMember(body.member),
    renewalOf: c.given(body.renewalOf) ? id(body.renewalOf, 'Membership to renew') : null,
    startOn: c.given(body.startOn) ? c.readDate(body.startOn, 'Starts on') : null,
    joiningFee: body.joiningFee === undefined || body.joiningFee === null ? null : v.requiredBoolean(body.joiningFee, 'Joining fee'),
    discount: quotes().readDiscount(body), instalments: readInstalments(body.instalments), notes: c.optionalText(body.notes, 'Notes', 500),
  };
}

async function planFor(db, business, planId) {
  const plan = await repo.one(db, `SELECT p.*,s.label AS item_label,s.active AS item_active FROM member_plan_types p
    JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.price_sku_id WHERE p.business_id=$1 AND p.id=$2`, [business.id, planId]);
  if (!plan) fail('Plan not found', 404);
  if (!plan.active) fail(`${plan.name} is not sold any more: switch it on under Settings › Membership plans to sell it`, 409);
  if (!plan.item_active) fail(`${plan.item_label}, the item ${plan.name} is sold as, is switched off in the catalogue`, 409);
  return plan;
}

// The membership being renewed, and the day its renewal starts: the day after
// it ends while it runs or within its grace days; from today after that (or
// for a pack with no end date).
async function renewalStart(db, business, renewalOf, contactId, day) {
  const old = await repo.one(db, `SELECT m.*,${c.STATUS_SQL('m', '$3::date')} AS status FROM member_memberships m WHERE m.business_id=$1 AND m.id=$2 FOR UPDATE`, [business.id, renewalOf, day]);
  if (!old) fail('The membership to renew was not found', 404);
  if (contactId && Number(old.contact_id) !== Number(contactId)) fail(`Membership ${old.membership_no} is another member's`, 409);
  if (old.closed) fail(`Membership ${old.membership_no} was ${old.closed}: sell a new membership instead`, 409);
  const next = await repo.one(db, 'SELECT membership_no FROM member_memberships WHERE business_id=$1 AND renewal_of=$2 AND closed IS NULL', [business.id, old.id]);
  if (next) fail(`Membership ${old.membership_no} is already renewed by ${next.membership_no}`, 409);
  const start = old.end_on && day <= c.addDays(old.end_on, Number(old.grace_days)) ? c.addDays(old.end_on, 1) : day;
  return { old, start };
}

// Everything a sale needs, worked out and checked, nothing saved yet.
async function prepare(db, business, user, input, { day, contact }) {
  const plan = await planFor(db, business, input.planId);
  let start = input.startOn || day, renewal = null;
  if (input.renewalOf) {
    renewal = await renewalStart(db, business, input.renewalOf, contact?.id, day);
    if (input.startOn && input.startOn !== renewal.start) fail(`A renewal starts on ${c.dateWords(renewal.start)}, the day after ${renewal.old.membership_no} ends`);
    start = renewal.start;
  } else {
    if (start < day) fail('A membership starts today or later');
    if (start > c.addDays(day, MAX_START_AHEAD)) fail(`A membership starts within ${MAX_START_AHEAD} days`);
  }
  const end = c.lastDayOf(plan, start);
  // Memberships of one plan with an end date never overlap (a pack of sessions
  // with no end date may: the oldest is used first).
  if (contact && end) {
    const clash = await repo.one(db, `SELECT membership_no,start_on::text AS start_on,end_on::text AS end_on FROM member_memberships
      WHERE business_id=$1 AND contact_id=$2 AND plan_id=$3 AND closed IS NULL AND end_on IS NOT NULL AND start_on<=$5::date AND end_on>=$4::date
      ORDER BY end_on DESC LIMIT 1`, [business.id, contact.id, plan.id, start, end]);
    if (clash) {
      fail(`${contact.name} already has ${plan.name} from ${c.dateWords(clash.start_on)} to ${c.dateWords(clash.end_on)} (${clash.membership_no}): renew it to start on ${c.dateWords(c.addDays(clash.end_on, 1))}`,
        409, { reason: 'overlap', membershipNo: clash.membership_no });
    }
  }
  // The joining fee: with a member's first membership unless the desk says otherwise.
  const first = !contact || !(await repo.one(db, 'SELECT 1 FROM member_memberships WHERE business_id=$1 AND contact_id=$2 LIMIT 1', [business.id, contact.id]));
  const joining = input.joiningFee === null ? Boolean(plan.joining_sku_id) && first && !renewal : input.joiningFee;
  if (joining && !plan.joining_sku_id) fail(`${plan.name} has no joining fee`);
  const lines = [{ skuId: plan.price_sku_id, quantity: 1 }, ...(joining ? [{ skuId: plan.joining_sku_id, quantity: 1 }] : [])];
  return { plan, start, end, renewal, joining, lines };
}

// The figures of a sale being typed (the sale dialog), nothing saved.
async function preview(business, user, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  const input = readSale(body);
  access.requireLocation(business, input.locationId);
  return repo.transaction(async (db) => {
    const day = await c.today(db, business);
    const contact = input.contactId ? await customer(db, business, input.contactId) : null;
    const sale = await prepare(db, business, user, input, { day, contact });
    const quoted = await quotes().priceIn(db, business, user, { locationId: input.locationId, contact, lines: sale.lines, discount: input.discount });
    return { ...quoted, startOn: sale.start, endOn: sale.end, sessions: sale.plan.sessions, joiningFee: sale.joining, term: c.termWords(sale.plan),
      renewalOf: sale.renewal ? { id: sale.renewal.old.id, membershipNo: sale.renewal.old.membership_no, endOn: sale.renewal.old.end_on } : null, today: day };
  });
}

async function customer(db, business, contactId) {
  const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
  if (!contact) fail('Member not found', 404);
  if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
  return contact;
}

// Writes a membership row and its first event (inside the caller's transaction).
async function insertMembership(db, business, user, values) {
  const number = await numbering.nextNumber(db, business.id, values.locationId, 'membership', user.id);
  const row = await repo.one(db, `INSERT INTO member_memberships(business_id,location_id,membership_no,series_id,contact_id,plan_id,plan_name,kind,duration_unit,duration,
      sessions_total,price,price_net,price_tax,tax_rate,joining_fee,policy_version,max_freeze_days,max_freezes,grace_days,transferable,start_on,base_end_on,end_on,
      renewal_of,upgraded_from,transferred_from,document_id,line_id,joining_line_id,notes,request_key,request_hash,created_by,updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$33) RETURNING *`,
  [business.id, values.locationId, number.number, number.seriesId, values.contactId, values.plan.id, values.plan.name, values.plan.kind, values.plan.duration_unit,
    values.plan.duration, values.sessionsTotal, rupees(values.net + values.tax), rupees(values.net), rupees(values.tax), values.taxRate, rupees(values.joiningFee),
    values.policyVersion, values.maxFreezeDays, values.maxFreezes, values.plan.grace_days, values.plan.transferable, values.start, values.end,
    values.renewalOf || null, values.upgradedFrom || null, values.transferredFrom || null, values.documentId, values.lineId, values.joiningLineId || null, values.notes || null,
    values.requestKey, values.hash, user.id]);
  return row;
}
async function event(db, business, user, membershipId, kind, note, details = {}) {
  await db.query('INSERT INTO member_events(business_id,membership_id,kind,note,details,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [business.id, membershipId, kind, note ? String(note).slice(0, 500) : null, JSON.stringify(details), user.id]);
}

// Posts the bill of a sale and writes the membership (inside the caller's
// transaction). Returns { membership, document }.
async function postSale(db, business, user, sale, { contact, locationId, requestKey, hash, paidNow, discount, instalments, notes, buyer, upgradedFrom = null, kind, day, note = null }) {
  const lastDue = instalments ? instalments.at(-1).dueOn : null;
  const documentBody = {
    kind: 'sale', locationId, contactId: contact.id, lines: sale.lines, ...(discount ? { discount } : {}),
    notes: [`${sale.plan.name} · ${c.dateWords(sale.start)}${sale.end ? ` to ${c.dateWords(sale.end)}` : ''}`, notes].filter(Boolean).join(' · ').slice(0, 500),
    buyer: { pan: buyer?.pan, panDeclaration: buyer?.panDeclaration },
  };
  const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'bill'), hash: c.hashOf(documentBody),
    lines: sale.lines, paidNow, membership: true, dueDay: lastDue });
  checkInstalments(instalments, day, paise(document.total));
  const lines = await repo.all(db, 'SELECT id,sku_id,net,tax,tax_rate FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id]);
  const planLine = lines.find((l) => Number(l.sku_id) === Number(sale.plan.price_sku_id));
  const joiningLine = sale.joining ? lines.find((l) => Number(l.sku_id) === Number(sale.plan.joining_sku_id)) : null;
  await ensureProfile(db, business, user, contact.id);
  const membership = await insertMembership(db, business, user, {
    locationId, contactId: contact.id, plan: sale.plan, sessionsTotal: sale.plan.sessions, net: paise(planLine.net), tax: paise(planLine.tax), taxRate: planLine.tax_rate,
    joiningFee: joiningLine ? paise(joiningLine.net) + paise(joiningLine.tax) : 0, policyVersion: sale.plan.policy_version, maxFreezeDays: sale.plan.max_freeze_days,
    maxFreezes: sale.plan.max_freezes, start: sale.start, end: sale.end, renewalOf: sale.renewal?.old.id, upgradedFrom, documentId: document.id, lineId: planLine.id,
    joiningLineId: joiningLine?.id, notes, requestKey, hash,
  });
  for (const [i, x] of (instalments || []).entries()) {
    await db.query('INSERT INTO member_instalments(business_id,membership_id,seq,due_on,amount) VALUES($1,$2,$3,$4,$5)', [business.id, membership.id, i + 1, x.dueOn, rupees(x.amount)]);
  }
  const details = { documentNo: document.document_no, total: document.total, plan: sale.plan.name, startOn: sale.start, endOn: sale.end, sessions: sale.plan.sessions,
    joiningFee: rupees(joiningLine ? paise(joiningLine.net) + paise(joiningLine.tax) : 0), ...(instalments ? { instalments: instalments.length } : {}),
    ...(sale.renewal ? { renewalOf: sale.renewal.old.membership_no } : {}) };
  await event(db, business, user, membership.id, kind, note || (kind === 'renewal' ? `Renewal of ${sale.renewal.old.membership_no}` : `Sold on ${document.document_no}`), details);
  return { membership, document };
}

// body: { requestKey, locationId, planId, contactId | member: { name, phone?, email? }, startOn?, renewalOf?, joiningFee?,
//   discount?: { amount | percent, reason }, payment? | payments?, instalments?: [{ dueOn, amount }], notes?, buyer?: { pan?, panDeclaration? } }
async function sell(business, user, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const input = readSale(body);
  if (!input.contactId && !input.newMember) fail('Choose the member, or type the new member\'s name');
  if (input.contactId && input.newMember) fail('Choose the member or type a new one, not both');
  if (input.newMember) await access.require(business, 'contacts.create');
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  access.requireLocation(business, input.locationId);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM member_memberships WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, old.id));
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, input.locationId]);
    if (!location) fail('Location not found', 404);
    const day = await c.today(db, business);
    const contact = input.contactId ? await customer(db, business, input.contactId) : await core.createContact(business, user, input.newMember, db);
    const sale = await prepare(db, business, user, input, { day, contact });
    const { membership, document } = await postSale(db, business, user, sale, { contact, locationId: location.id, requestKey, hash, paidNow: parts, discount: input.discount,
      instalments: input.instalments, notes: input.notes, buyer: body.buyer, kind: sale.renewal ? 'renewal' : 'sold', day });
    const what = sale.renewal ? 'membership.renewed' : 'membership.sold';
    await repo.audit(db, business.id, user.id, what, membership.id, { membershipNo: membership.membership_no, member: contact.name, plan: sale.plan.name, documentNo: document.document_no,
      total: document.total, startOn: sale.start, endOn: sale.end, ...(sale.renewal ? { renewalOf: sale.renewal.old.membership_no } : {}) });
    await repo.event(db, business.id, user.id, what, 'membership', membership.id, { membershipNo: membership.membership_no, contactId: contact.id, planId: sale.plan.id,
      documentId: document.id, documentNo: document.document_no, total: document.total, startOn: sale.start, endOn: sale.end, sessions: sale.plan.sessions ?? null });
    return shape(business, await load(db, business, membership.id));
  });
}

module.exports = { MEMBERSHIPS_SQL, MEMBERS_SQL, DUE_SQL, RANK_SQL, seesMoney, shape, listShape, withoutMoney, load, detail, member, ensureProfile, changeCode, readSale,
  readInstalments, checkInstalments, prepare, planFor, customer, postSale, insertMembership, event, preview, sell, instalmentsOf };
