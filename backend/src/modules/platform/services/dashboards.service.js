const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const { readDate } = require('../../../utils/calendarDate');
const { STATES } = require('../../../utils/gstin');
const math = require('./planMath');
const settings = require('./planSettings.service');

// The platform console's dashboards, for the platform's own super admin: the
// overview, the free-trial funnel and the leads, and the sales, renewals and
// dues reports. They read what paid plans recorded: each business's state
// (business_plan_state), its access periods and add-on grants, the orders,
// payments and invoices, and the leads. Each figure is one query over every
// business, never a query per business. The one thing changed here is a
// lead's follow-up: its status and its notes, each written to platform_audit.
//
// Trials, time the super admin gives and paid time are never added together.
// The money is the company's own: its tax invoices, on its own date (India),
// with SAMPLE invoices left out and counted apart. Of a business's own trade
// only whether, and on which day, it made its first sale during its trial is
// read: never an amount, a customer or a bill.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const ZONE = 'Asia/Kolkata';
const STATE_KEYS = ['trial', 'paid', 'given', 'grace', 'checking', 'ended', 'off'];
const LEAD_STATUSES = ['new', 'contacted', 'not_interested'];
const LEAD_SOURCES = ['enquiry', 'signup'];
const SPLITS = ['type', 'state', 'ref', 'plan', 'trialDays'];
const SALES_BY = ['month', 'plan', 'module', 'application', 'type', 'state', 'kind', 'period'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_WORDS = { new: 'New', renewal: 'Renewal', add_on: 'Add-on' };
const PERIOD_WORDS = { month: 'Monthly', year: 'Yearly' };
const DUE_BANDS = [['0-30', 'Up to 30 days', 30], ['31-60', '31 to 60 days', 60], ['61-90', '61 to 90 days', 90], ['90+', 'Over 90 days', Infinity]];

// The permission is checked on the router; a login tied to a restaurant never
// runs the platform, whatever role it is given.
function requirePlatform(user) {
  if (!user || user.restaurantId || !(user.permissions || []).includes('platform.restaurants.manage')) {
    fail("The platform console is for the platform's own accounts", 403);
  }
}

const companyToday = async () => (await repo.one(repo.pool, `SELECT (now() AT TIME ZONE '${ZONE}')::date AS today`)).today;
// 1 April of the financial year a date falls in.
const fyStartOf = (date) => {
  const [year, month] = date.split('-').map(Number);
  return `${month >= 4 ? year : year - 1}-04-01`;
};
const monthLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const sumRupees = (values) => math.toRupees(values.reduce((sum, value) => sum + math.toPaise(value), 0n));
// Continued over those whose trial is over (continued + stopped), as a
// percentage with two decimals; none finished, none to say.
const conversion = (continued, stopped) => (continued + stopped ? (Math.round((continued * 10000) / (continued + stopped)) / 100).toFixed(2) : null);
function readRange(query, today, defaultFrom) {
  const to = readDate(query.to, 'To', today);
  const from = readDate(query.from, 'From', defaultFrom(to));
  if (from > to) fail('From must be on or before To');
  return { from, to };
}

// The business's owner, to call: its first owner on the shared core, or a
// restaurant's first admin. Joined where `b` is the business.
const OWNER = `LEFT JOIN LATERAL (
    SELECT x.name,x.mobile,x.email FROM (
      SELECT u.id,u.name,u.mobile,u.email FROM business_memberships m
        JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.full_access JOIN users u ON u.id=m.user_id
        WHERE m.business_id=b.id AND m.active
      UNION ALL
      SELECT u.id,u.name,u.mobile,u.email FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles ro ON ro.id=ur.role_id AND ro.code='RESTAURANT_ADMIN'
        WHERE b.legacy_restaurant_id IS NOT NULL AND u.restaurant_id=b.legacy_restaurant_id) x
    ORDER BY x.id LIMIT 1) own ON TRUE`;

// What the business's next order would ask before GST: its selection's plan
// and add-ons for its month or year at today's prices (a price not set yet
// counts nothing). `sub` is its business_subscriptions row, `pl` that plan.
const NEXT_ORDER_VALUE = `(COALESCE(CASE sub.billing_period WHEN 'month' THEN pl.monthly_price ELSE pl.yearly_price END,0)
  + COALESCE((SELECT sum(CASE sub.billing_period WHEN 'month' THEN pr.monthly_price ELSE pr.yearly_price END) FROM business_subscription_addons a
      JOIN platform_module_prices pr ON pr.module_code=a.module_code
      WHERE a.business_id=sub.business_id AND NOT EXISTS (SELECT 1 FROM platform_plan_modules pm WHERE pm.plan_code=sub.plan_code AND pm.module_code=a.module_code)),0))`;

// --- The trial funnel ------------------------------------------------------------------------

// Every business whose trial started from $1 to $2 (its own dates), with the
// filters $3 type, $4 state, $5 source tag, $6 plan and $7 trial length:
//   source     how it came: an enquiry that signed up, a direct sign-up, an
//              owner adding a business, or the platform setting one up on a
//              free trial. A trial cancelled for given time is no trial.
//   state_code its GSTIN's state, else its state in Business settings, else
//              its lead's
//   paid       it has paid time, at any time; first_paid_on the date of its
//              first confirmed payment (or of its first paid order)
//   first_sale_at   its first sale document, or a restaurant's first bill
//              not voided, dated inside the trial
//   outcome    continued (it paid), on_trial (the trial covers its today), or
//              stopped (the trial ended and it never paid)
const TRIALS = `WITH t AS (
    SELECT DISTINCT ON (p.business_id) p.business_id,p.starts_on,p.ends_on,p.ends_on-p.starts_on+1 AS days
    FROM business_access_periods p WHERE p.kind='trial' AND p.cancelled_at IS NULL AND p.starts_on BETWEEN $1::date AND $2::date
    ORDER BY p.business_id,p.starts_on
  ), trials AS (
    SELECT b.id AS business_id,b.name,b.code,b.business_type,bt.name AS type_name,t.starts_on,t.ends_on,t.days,z.zone,business_local_today(b.id) AS today,
      l.id AS lead_id,lower(l.ref) AS ref,
      CASE WHEN l.source IS NOT NULL THEN l.source
        WHEN b.created_by IS NULL OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id=ur.role_id AND ro.code='SUPER_ADMIN' AND ro.restaurant_id IS NULL
          WHERE ur.user_id=b.created_by) THEN 'platform' ELSE 'owner' END AS source,
      COALESCE(left(bs.gstin,2),bs.state_code,l.state_code) AS state_code,sub.plan_code,pl.name AS plan_name,
      EXISTS (SELECT 1 FROM business_access_periods pp WHERE pp.business_id=b.id AND pp.kind='paid' AND pp.cancelled_at IS NULL) AS paid,
      LEAST((SELECT min(pay.paid_on) FROM platform_payments pay WHERE pay.business_id=b.id AND pay.status='confirmed'),
        (SELECT min((o.paid_at AT TIME ZONE z.zone)::date) FROM business_access_periods pp JOIN platform_orders o ON o.id=pp.order_id
          WHERE pp.business_id=b.id AND pp.kind='paid' AND pp.cancelled_at IS NULL)) AS first_paid_on,
      LEAST((SELECT min(d.created_at) FROM business_documents d WHERE d.business_id=b.id AND d.kind='sale'
          AND d.created_at>=(t.starts_on::timestamp AT TIME ZONE z.zone) AND d.created_at<((t.ends_on+1)::timestamp AT TIME ZONE z.zone)),
        (SELECT min(bl.billed_at) FROM bills bl WHERE bl.restaurant_id=b.legacy_restaurant_id AND bl.bill_status<>'void'
          AND bl.billed_at>=(t.starts_on::timestamp AT TIME ZONE z.zone) AND bl.billed_at<((t.ends_on+1)::timestamp AT TIME ZONE z.zone))) AS first_sale_at
    FROM t JOIN businesses b ON b.id=t.business_id JOIN business_types bt ON bt.code=b.business_type
    CROSS JOIN LATERAL (SELECT business_time_zone(b.id) AS zone) z
    LEFT JOIN platform_leads l ON l.business_id=b.id LEFT JOIN business_settings bs ON bs.business_id=b.id
    LEFT JOIN business_subscriptions sub ON sub.business_id=b.id LEFT JOIN platform_plans pl ON pl.code=sub.plan_code
  ), shaped AS (
    SELECT trials.*,CASE WHEN paid THEN 'continued' WHEN ends_on>=today THEN 'on_trial' ELSE 'stopped' END AS outcome,
      COALESCE(paid AND first_paid_on<=ends_on,FALSE) AS paid_in_trial
    FROM trials
    WHERE ($3::text IS NULL OR business_type=$3) AND ($4::text IS NULL OR state_code=$4) AND ($5::text IS NULL OR ref=lower($5))
      AND ($6::text IS NULL OR plan_code=$6) AND ($7::int IS NULL OR days=$7)
  )`;

// The enquiries counted on their own date (India) from $1 to $2, with the
// filters $3 type, $4 state and $5 source tag.
const ENQUIRIES = `l.source='enquiry' AND (l.created_at AT TIME ZONE '${ZONE}')::date BETWEEN $1::date AND $2::date
  AND ($3::text IS NULL OR l.business_type=$3) AND ($4::text IS NULL OR l.state_code=$4) AND ($5::text IS NULL OR lower(l.ref)=lower($5))`;

const TRIAL_BUCKETS = {
  trialsStarted: 'TRUE', fromEnquiries: "source='enquiry'", direct: "source='signup'", ownerAdded: "source='owner'", platformAdded: "source='platform'",
  activated: 'first_sale_at IS NOT NULL', stillOnTrial: "outcome='on_trial'", continued: "outcome='continued'", continuedDuringTrial: 'paid_in_trial',
  continuedAfterTrial: "outcome='continued' AND NOT paid_in_trial", stopped: "outcome='stopped'", stoppedLast30: "outcome='stopped' AND ends_on>=today-30",
};
const ENQUIRY_BUCKETS = { enquiries: 'TRUE', enquiriesSignedUp: 'l.business_id IS NOT NULL' };
const GROUP_KEYS = { type: 'business_type', state: 'state_code', ref: 'ref', plan: 'plan_code', trialDays: 'days::text' };
const NO_FILTERS = { type: null, state: null, ref: null, plan: null, trialDays: null };

function readFunnel(query, today) {
  const { from, to } = readRange(query, today, (end) => math.addDays(end, -29));
  let trialDays = null;
  if (query.trialDays !== undefined && query.trialDays !== '') {
    trialDays = v.requiredNumber(query.trialDays, 'Trial length', { min: 1, max: 365 });
    if (!Number.isInteger(trialDays)) fail('Trial length must be a whole number of days');
  }
  const state = v.optionalString(query.state, 'State', 2);
  if (state && !STATES[state]) fail('State must be a GST state code, like 29 for Karnataka');
  return {
    from, to,
    filters: {
      type: v.optionalString(query.type, 'Business type', 40), state, ref: v.optionalString(query.ref, 'Source', 100),
      plan: v.optionalString(query.plan, 'Plan', 40), trialDays,
    },
    by: v.optionalEnum(query.by, 'Split by', SPLITS, null),
    list: v.optionalEnum(query.list, 'List', [...Object.keys(TRIAL_BUCKETS), ...Object.keys(ENQUIRY_BUCKETS)], null),
  };
}
const trialParams = ({ from, to, filters }) => [from, to, filters.type, filters.state, filters.ref, filters.plan, filters.trialDays];
const enquiryParams = ({ from, to, filters }) => [from, to, filters.type, filters.state, filters.ref];

// The funnel's numbers for a range and filters. Enquiries have no plan or
// trial length: filtered by either, they are not counted (null).
async function funnelFigures(range) {
  const trials = await repo.one(repo.pool, `${TRIALS}
    SELECT count(*)::int AS trials_started,count(*) FILTER (WHERE source='enquiry')::int AS from_enquiries,count(*) FILTER (WHERE source='signup')::int AS direct,
      count(*) FILTER (WHERE source='owner')::int AS owner_added,count(*) FILTER (WHERE source='platform')::int AS platform_added,
      count(*) FILTER (WHERE first_sale_at IS NOT NULL)::int AS activated,count(*) FILTER (WHERE outcome='on_trial')::int AS still_on_trial,
      count(*) FILTER (WHERE outcome='continued')::int AS continued,count(*) FILTER (WHERE paid_in_trial)::int AS continued_during_trial,
      count(*) FILTER (WHERE outcome='stopped')::int AS stopped,count(*) FILTER (WHERE outcome='stopped' AND ends_on>=today-30)::int AS stopped_last30,
      round(avg(first_paid_on-starts_on) FILTER (WHERE outcome='continued'),1) AS avg_days_to_pay
    FROM shaped`, trialParams(range));
  const byPlan = range.filters.plan !== null || range.filters.trialDays !== null;
  const enquiries = byPlan ? null : await repo.one(repo.pool, `SELECT count(*)::int AS enquiries,count(*) FILTER (WHERE l.business_id IS NOT NULL)::int AS signed_up
    FROM platform_leads l WHERE ${ENQUIRIES}`, enquiryParams(range));
  return {
    from: range.from, to: range.to, filters: range.filters,
    enquiries: enquiries ? enquiries.enquiries : null, enquiriesSignedUp: enquiries ? enquiries.signed_up : null,
    trialsStarted: trials.trials_started, fromEnquiries: trials.from_enquiries, direct: trials.direct, ownerAdded: trials.owner_added, platformAdded: trials.platform_added,
    activated: trials.activated, stillOnTrial: trials.still_on_trial, continued: trials.continued, continuedDuringTrial: trials.continued_during_trial,
    continuedAfterTrial: trials.continued - trials.continued_during_trial, stopped: trials.stopped, stoppedLast30: trials.stopped_last30,
    conversion: conversion(trials.continued, trials.stopped), avgDaysToPay: trials.avg_days_to_pay === null ? null : Number(trials.avg_days_to_pay),
  };
}

// Each number split by one of the filters' dimensions.
async function funnelGroups(range, by) {
  const rows = await repo.all(repo.pool, `${TRIALS}
    SELECT ${GROUP_KEYS[by]} AS key,max(type_name) AS type_name,max(plan_name) AS plan_name,count(*)::int AS trials_started,
      count(*) FILTER (WHERE first_sale_at IS NOT NULL)::int AS activated,count(*) FILTER (WHERE outcome='on_trial')::int AS still_on_trial,
      count(*) FILTER (WHERE outcome='continued')::int AS continued,count(*) FILTER (WHERE outcome='stopped')::int AS stopped
    FROM shaped GROUP BY 1 ORDER BY trials_started DESC,1`, trialParams(range));
  const label = {
    type: (row) => row.type_name,
    state: (row) => (row.key ? STATES[row.key] || row.key : 'No state given'),
    ref: (row) => row.key || 'No source tag',
    plan: (row) => (row.key ? `${row.plan_name} · ${row.type_name}` : 'No plan chosen'),
    trialDays: (row) => `${row.key} ${row.key === '1' ? 'day' : 'days'}`,
  }[by];
  return rows.map((row) => ({
    key: row.key, label: label(row), trialsStarted: row.trials_started, activated: row.activated, stillOnTrial: row.still_on_trial,
    continued: row.continued, stopped: row.stopped, conversion: conversion(row.continued, row.stopped),
  }));
}

const toTrial = (row) => ({
  businessId: row.business_id, name: row.name, code: row.code, businessType: row.business_type, typeName: row.type_name,
  ownerName: row.owner_name || null, ownerMobile: row.owner_mobile || null, ownerEmail: row.owner_email || null,
  source: row.source, ref: row.ref, leadId: row.lead_id, stateCode: row.state_code, stateName: STATES[row.state_code] || null,
  planCode: row.plan_code, planName: row.plan_name, trialStartsOn: row.starts_on, trialEndsOn: row.ends_on, trialDays: row.days,
  firstSaleOn: row.first_sale_on, outcome: row.outcome, state: row.plan_state,
  paidOn: row.paid ? row.first_paid_on : null,
  daysToPay: row.paid && row.first_paid_on ? math.daysBetweenInclusive(row.starts_on, row.first_paid_on) - 1 : null,
});

// The businesses (or, for the enquiries, the leads) behind one number.
async function funnelList(range, bucket) {
  if (ENQUIRY_BUCKETS[bucket]) {
    const rows = await repo.all(repo.pool, `${leadSelect()} WHERE ${ENQUIRIES} AND ${ENQUIRY_BUCKETS[bucket]} ORDER BY l.created_at DESC,l.id DESC LIMIT 1000`,
      enquiryParams(range));
    return rows.map((row) => toLead(row));
  }
  const rows = await repo.all(repo.pool, `${TRIALS}
    SELECT s.*,(s.first_sale_at AT TIME ZONE s.zone)::date AS first_sale_on,st.state AS plan_state,
      own.name AS owner_name,own.mobile AS owner_mobile,own.email AS owner_email
    FROM shaped s JOIN businesses b ON b.id=s.business_id CROSS JOIN LATERAL business_plan_state(b.id) st
    ${OWNER}
    WHERE ${TRIAL_BUCKETS[bucket]} ORDER BY s.starts_on DESC,s.name LIMIT 1000`, trialParams(range));
  return rows.map(toTrial);
}

// What the funnel's filters can be set to.
async function funnelChoices() {
  const row = await repo.one(repo.pool, `SELECT
      COALESCE((SELECT json_agg(json_build_object('code',code,'name',name) ORDER BY name) FROM business_types),'[]') AS types,
      COALESCE((SELECT json_agg(json_build_object('code',p.code,'name',p.name,'businessType',p.business_type,'typeName',t.name) ORDER BY t.name,p.sort_order,p.name)
        FROM platform_plans p JOIN business_types t ON t.code=p.business_type),'[]') AS plans,
      COALESCE((SELECT json_agg(DISTINCT lower(ref) ORDER BY lower(ref)) FROM platform_leads WHERE ref IS NOT NULL),'[]') AS refs,
      COALESCE((SELECT json_agg(DISTINCT ends_on-starts_on+1 ORDER BY ends_on-starts_on+1) FROM business_access_periods WHERE kind='trial' AND cancelled_at IS NULL),'[]') AS trial_lengths`);
  return {
    types: row.types, plans: row.plans, refs: row.refs, trialLengths: row.trial_lengths,
    states: Object.entries(STATES).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function funnel(user, query = {}) {
  requirePlatform(user);
  const { list, by, ...range } = readFunnel(query, await companyToday());
  if (list) return { bucket: list, from: range.from, to: range.to, filters: range.filters, items: await funnelList(range, list) };
  const figures = await funnelFigures(range);
  return { ...figures, groups: by ? await funnelGroups(range, by) : null, choices: await funnelChoices() };
}

// --- Leads -----------------------------------------------------------------------------------

// A lead with its type, the business it signed up (with that business's state
// today) and its notes, newest first; `extra` adds columns.
const leadSelect = (extra = '') => `SELECT ${extra}l.*,bt.name AS type_name,b.name AS business_now,b.code AS business_code,st.state AS business_state,
    COALESCE((SELECT json_agg(json_build_object('id',n.id,'note',n.note,'createdAt',n.created_at,'by',u.name) ORDER BY n.created_at DESC,n.id DESC)
      FROM platform_lead_notes n LEFT JOIN users u ON u.id=n.created_by WHERE n.lead_id=l.id),'[]') AS notes
  FROM platform_leads l LEFT JOIN business_types bt ON bt.code=l.business_type LEFT JOIN businesses b ON b.id=l.business_id
  LEFT JOIN LATERAL business_plan_state(l.business_id) st ON TRUE`;

const toLead = (row) => ({
  id: row.id, source: row.source, name: row.name, mobile: row.mobile, email: row.email, businessName: row.business_name, businessType: row.business_type,
  typeName: row.type_name || null, city: row.city, stateCode: row.state_code, stateName: STATES[row.state_code] || null, message: row.message, ref: row.ref,
  status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, consentAt: row.consent_at, signedUpAt: row.signed_up_at,
  business: row.business_id ? { id: row.business_id, name: row.business_now, code: row.business_code, state: row.business_state } : null,
  // How it went: not signed up yet, or the state its business is in today.
  outcome: row.business_id ? row.business_state : 'not_signed_up',
  notes: row.notes,
});

async function leads(user, query = {}) {
  requirePlatform(user);
  const status = v.optionalEnum(query.status, 'Status', LEAD_STATUSES, null);
  const source = v.optionalEnum(query.source, 'Source', LEAD_SOURCES, null);
  const q = v.optionalString(query.q, 'Search', 100);
  const from = readDate(query.from, 'From');
  const to = readDate(query.to, 'To');
  if (from && to && from > to) fail('From must be on or before To');
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await repo.all(repo.pool, `${leadSelect('count(*) OVER () AS total,')}
    WHERE ($1::text IS NULL OR l.status=$1) AND ($2::text IS NULL OR l.source=$2)
      AND ($3::text IS NULL OR concat_ws(' ',l.name,l.mobile,l.email,l.business_name,l.city,l.ref,b.name) ILIKE $3)
      AND ($4::date IS NULL OR (l.created_at AT TIME ZONE '${ZONE}')::date>=$4) AND ($5::date IS NULL OR (l.created_at AT TIME ZONE '${ZONE}')::date<=$5)
    ORDER BY l.created_at DESC,l.id DESC LIMIT 500`, [status, source, like, from, to]);
  return { items: rows.map(toLead), total: rows.length ? rows[0].total : 0 };
}

const leadById = async (db, id) => toLead(await repo.one(db, `${leadSelect()} WHERE l.id=$1`, [id]));
const audit = (db, user, action, leadId, details) => db.query(`INSERT INTO platform_audit(actor_id,action,entity_type,entity_id,details)
  VALUES($1,$2,'platform_lead',$3,$4)`, [user.id, action, leadId, JSON.stringify(details)]);

// The follow-up: new, contacted or not interested. The same status again
// changes nothing.
async function setLeadStatus(user, leadId, body = {}) {
  requirePlatform(user);
  const id = v.requiredId(leadId, 'Lead');
  const status = v.requiredEnum(body.status, 'Status', LEAD_STATUSES);
  return repo.transaction(async (db) => {
    const lead = await repo.one(db, 'SELECT id,status FROM platform_leads WHERE id=$1 FOR UPDATE', [id]);
    if (!lead) fail('Lead not found', 404);
    if (lead.status !== status) {
      await db.query('UPDATE platform_leads SET status=$2,updated_by=$3,updated_at=now() WHERE id=$1', [id, status, user.id]);
      await audit(db, user, 'platform.lead_status_changed', id, { from: lead.status, to: status });
    }
    return leadById(db, id);
  });
}

// A note on a lead (a call made, what was said). Notes are kept as written.
async function addLeadNote(user, leadId, body = {}) {
  requirePlatform(user);
  const id = v.requiredId(leadId, 'Lead');
  const note = v.requiredString(body.note, 'Note', 2000);
  return repo.transaction(async (db) => {
    if (!await repo.one(db, 'SELECT 1 FROM platform_leads WHERE id=$1 FOR UPDATE', [id])) fail('Lead not found', 404);
    const row = await repo.one(db, `INSERT INTO platform_lead_notes AS n(lead_id,note,created_by) VALUES($1,$2,$3)
      RETURNING n.id,n.note,n.created_at,(SELECT u.name FROM users u WHERE u.id=n.created_by) AS by`, [id, note, user.id]);
    await audit(db, user, 'platform.lead_note_added', id, { noteId: row.id });
    return { id: row.id, note: row.note, createdAt: row.created_at, by: row.by };
  });
}

// --- The overview ----------------------------------------------------------------------------

// The money: the company's tax invoices (SAMPLE ones left out and counted
// apart) by the day they were issued, with the 12 months to this one.
async function moneyFigures(today, fyStart) {
  const [totals, months] = await Promise.all([
    repo.one(repo.pool, `WITH k AS (SELECT $1::date AS today,date_trunc('month',$1::date::timestamp)::date AS month_start,
        (date_trunc('month',$1::date::timestamp)-interval '1 month')::date AS last_month_start,$2::date AS fy_start)
      SELECT COALESCE(sum(i.total_amount) FILTER (WHERE NOT i.sample AND i.issued_on=k.today),0)::numeric(14,2) AS today,
        COALESCE(sum(i.total_amount) FILTER (WHERE NOT i.sample AND i.issued_on BETWEEN k.month_start AND k.today),0)::numeric(14,2) AS this_month,
        COALESCE(sum(i.total_amount) FILTER (WHERE NOT i.sample AND i.issued_on>=k.last_month_start AND i.issued_on<k.month_start),0)::numeric(14,2) AS last_month,
        COALESCE(sum(i.total_amount) FILTER (WHERE NOT i.sample AND i.issued_on BETWEEN k.fy_start AND k.today),0)::numeric(14,2) AS this_fy,
        COALESCE(sum(i.taxable_amount) FILTER (WHERE NOT i.sample AND i.issued_on BETWEEN k.month_start AND k.today),0)::numeric(14,2) AS before_gst,
        COALESCE(sum(i.cgst_amount+i.sgst_amount+i.igst_amount) FILTER (WHERE NOT i.sample AND i.issued_on BETWEEN k.month_start AND k.today),0)::numeric(14,2) AS gst,
        count(i.id) FILTER (WHERE i.sample)::int AS sample_count,COALESCE(sum(i.total_amount) FILTER (WHERE i.sample),0)::numeric(14,2) AS sample_total
      FROM k LEFT JOIN platform_invoices i ON TRUE`, [today, fyStart]),
    repo.all(repo.pool, `SELECT to_char(m,'YYYY-MM') AS month,COALESCE(sum(i.total_amount),0)::numeric(14,2) AS collected,
        COALESCE(sum(i.taxable_amount),0)::numeric(14,2) AS before_gst
      FROM generate_series(date_trunc('month',$1::date::timestamp)-interval '11 months',date_trunc('month',$1::date::timestamp),interval '1 month') AS m
      LEFT JOIN platform_invoices i ON NOT i.sample AND i.issued_on>=m::date AND i.issued_on<(m+interval '1 month')::date
      GROUP BY m ORDER BY m`, [today]),
  ]);
  return {
    today: totals.today, thisMonth: totals.this_month, lastMonth: totals.last_month, thisFy: totals.this_fy, fyStart,
    beforeGstThisMonth: totals.before_gst, gstThisMonth: totals.gst,
    byMonth: months.map((m) => ({ month: m.month, collected: m.collected, beforeGst: m.before_gst })),
    sampleInvoices: { count: totals.sample_count, total: totals.sample_total },
  };
}

// The businesses: how many are in each state; the recurring income of the
// paying ones (paid, or in grace after paid time): each one's current paid
// period before GST over its months, and each paid add-on in that period at
// its full price over its months; the renewals due in 7 and 30 days of paid
// time, with what the next order would ask; and the paid time that ended this
// month without a renewal. Trials and given time bring nothing.
async function businessFigures() {
  const row = await repo.one(repo.pool, `WITH s AS (
      SELECT b.id,st.state,st.access_ends_on,st.period_id,st.period_kind,business_local_today(b.id) AS today
      FROM businesses b CROSS JOIN LATERAL business_plan_state(b.id) st
    ), paying AS (
      SELECT s.id,p.starts_on,p.ends_on,o.taxable_amount,o.billing_period FROM s
      JOIN business_access_periods p ON p.id=s.period_id AND p.kind='paid' JOIN platform_orders o ON o.id=p.order_id
      WHERE s.state IN ('paid','grace')
    ), monthly AS (
      SELECT taxable_amount/CASE billing_period WHEN 'year' THEN 12 ELSE 1 END AS amount FROM paying
      UNION ALL
      SELECT l.full_price/CASE ao.billing_period WHEN 'year' THEN 12 ELSE 1 END FROM paying pp
      JOIN business_access_addons a ON a.business_id=pp.id AND a.kind='paid' AND a.cancelled_at IS NULL AND a.starts_on<=pp.ends_on AND a.ends_on>=pp.starts_on
      JOIN platform_orders ao ON ao.id=a.order_id JOIN platform_order_lines l ON l.order_id=a.order_id AND l.item_code=a.module_code
    ), due AS (
      SELECT s.access_ends_on,s.today,${NEXT_ORDER_VALUE} AS value FROM s
      JOIN business_subscriptions sub ON sub.business_id=s.id LEFT JOIN platform_plans pl ON pl.code=sub.plan_code
      WHERE s.state='paid' AND s.access_ends_on IS NOT NULL
    )
    SELECT COALESCE((SELECT json_object_agg(state,n) FROM (SELECT state,count(*)::int AS n FROM s GROUP BY state) x),'{}') AS states,
      (SELECT COALESCE(round(sum(amount),2),0)::numeric(14,2) FROM monthly) AS mrr,
      (SELECT COALESCE(round(sum(amount)*12,2),0)::numeric(14,2) FROM monthly) AS arr,
      (SELECT count(*)::int FROM paying) AS paying,
      (SELECT count(*)::int FROM due WHERE access_ends_on<=today+7) AS in7_count,
      (SELECT COALESCE(sum(value),0)::numeric(14,2) FROM due WHERE access_ends_on<=today+7) AS in7_value,
      (SELECT count(*)::int FROM due WHERE access_ends_on<=today+30) AS in30_count,
      (SELECT COALESCE(sum(value),0)::numeric(14,2) FROM due WHERE access_ends_on<=today+30) AS in30_value,
      (SELECT count(*)::int FROM s WHERE state IN ('grace','checking','ended') AND period_kind='paid' AND access_ends_on<today
        AND access_ends_on>=date_trunc('month',today::timestamp)::date) AS ended_this_month`);
  return {
    states: Object.fromEntries(STATE_KEYS.map((state) => [state, row.states[state] || 0])),
    recurring: { mrr: row.mrr, arr: row.arr, payingBusinesses: row.paying },
    renewals: {
      in7: { count: row.in7_count, value: row.in7_value }, in30: { count: row.in30_count, value: row.in30_value },
      endedThisMonthNotRenewed: row.ended_this_month,
    },
  };
}

// What is waiting: payments to confirm, enquiries nobody has called, orders
// paid in sample mode still without their tax invoice, and, until each is
// done, what going live needs: the company's details, the real GSTIN, the
// price list reviewed and a way for owners to pay.
async function todo() {
  const [row, company] = await Promise.all([
    repo.one(repo.pool, `SELECT (SELECT count(*)::int FROM platform_payments WHERE status='pending') AS payments,
      (SELECT count(*)::int FROM platform_leads WHERE source='enquiry' AND status='new') AS enquiries,
      (SELECT count(*)::int FROM platform_orders o WHERE o.status='paid' AND EXISTS (SELECT 1 FROM platform_invoices i WHERE i.order_id=o.id AND i.sample)
        AND NOT EXISTS (SELECT 1 FROM platform_invoices i WHERE i.order_id=o.id AND NOT i.sample)) AS tax_invoices`),
    settings.get(),
  ]);
  return {
    paymentsToConfirm: row.payments, newEnquiries: row.enquiries, taxInvoicesToIssue: row.tax_invoices,
    companyProblems: settings.companyProblems(company), sampleGstin: settings.isSample(company), pricesReviewed: Boolean(company.prices_reviewed_at),
    paymentDetailsMissing: !(company.upi_id || (company.bank_account_number && company.bank_ifsc)),
  };
}

async function overview(user) {
  requirePlatform(user);
  const today = await companyToday();
  const fyStart = fyStartOf(today);
  const [money, businesses, waiting, funnel30] = await Promise.all([
    moneyFigures(today, fyStart), businessFigures(), todo(), funnelFigures({ from: math.addDays(today, -29), to: today, filters: NO_FILTERS }),
  ]);
  return {
    today, money: { ...money, ...businesses.recurring }, states: businesses.states, funnel30, renewals: businesses.renewals, todo: waiting,
  };
}

// --- Reports ---------------------------------------------------------------------------------

// The company's tax invoices issued from $1 to $2 (never a SAMPLE one), with
// what each sold: the business's type, the place of supply, month or year,
// and new (a business's first paid subscription), renewal or add-on.
const SALES = `WITH inv AS (
    SELECT i.id,i.issued_on,i.taxable_amount,i.cgst_amount+i.sgst_amount+i.igst_amount AS gst,i.total_amount,i.lines,i.place_of_supply->>'code' AS state_code,
      b.business_type,bt.name AS type_name,o.billing_period,
      CASE WHEN o.kind='add_on' THEN 'add_on'
        WHEN EXISTS (SELECT 1 FROM platform_orders e WHERE e.business_id=o.business_id AND e.kind='subscription' AND e.status='paid' AND (e.paid_at,e.id)<(o.paid_at,o.id))
          THEN 'renewal' ELSE 'new' END AS kind
    FROM platform_invoices i JOIN platform_orders o ON o.id=i.order_id JOIN businesses b ON b.id=i.business_id JOIN business_types bt ON bt.code=b.business_type
    WHERE NOT i.sample AND i.issued_on BETWEEN $1::date AND $2::date
  )`;
const INVOICE_KEYS = {
  month: ["to_char(issued_on,'YYYY-MM')", '1'], type: ['business_type', 'taxable DESC,1'], state: ['state_code', 'taxable DESC,1'],
  kind: ['kind', "array_position(ARRAY['new','renewal','add_on'],kind)"], period: ['billing_period', 'taxable DESC,1'],
};
const LINE_KINDS = { plan: 'plan', module: 'module', application: 'application' };

// Sales before GST by one dimension. By month, type, state, new or renewal and
// month or year a row is whole invoices, with their GST and totals; by plan,
// module or application it is the invoices' lines of that kind, before GST.
async function salesReport(user, query = {}) {
  requirePlatform(user);
  const { from, to } = readRange(query, await companyToday(), fyStartOf);
  const by = v.optionalEnum(query.by, 'Report by', SALES_BY, 'month');
  let rows;
  if (LINE_KINDS[by]) {
    rows = (await repo.all(repo.pool, `${SALES}
      SELECT x.key,x.invoices,x.taxable,COALESCE(pl.name||' · '||pt.name,m.name,x.key) AS label FROM (
        SELECT l->>'itemCode' AS key,count(DISTINCT inv.id)::int AS invoices,sum((l->>'taxable')::numeric)::numeric(14,2) AS taxable
        FROM inv CROSS JOIN LATERAL jsonb_array_elements(inv.lines) AS l WHERE l->>'itemKind'=$3 GROUP BY 1) x
      LEFT JOIN platform_plans pl ON $3='plan' AND pl.code=x.key LEFT JOIN business_types pt ON pt.code=pl.business_type
      LEFT JOIN platform_modules m ON $3<>'plan' AND m.code=x.key
      ORDER BY x.taxable DESC,x.key`, [from, to, LINE_KINDS[by]]))
      .map((row) => ({ key: row.key, label: row.label, invoices: row.invoices, taxable: row.taxable, gst: null, total: null }));
  } else {
    const [key, order] = INVOICE_KEYS[by];
    const label = {
      month: (row) => monthLabel(row.key), type: (row) => row.type_name, state: (row) => STATES[row.key] || row.key,
      kind: (row) => KIND_WORDS[row.key], period: (row) => PERIOD_WORDS[row.key],
    }[by];
    rows = (await repo.all(repo.pool, `${SALES}
      SELECT ${key} AS key,max(type_name) AS type_name,count(*)::int AS invoices,sum(taxable_amount)::numeric(14,2) AS taxable,
        sum(gst)::numeric(14,2) AS gst,sum(total_amount)::numeric(14,2) AS total
      FROM inv GROUP BY 1 ORDER BY ${order}`, [from, to]))
      .map((row) => ({ key: row.key, label: label(row), invoices: row.invoices, taxable: row.taxable, gst: row.gst, total: row.total }));
  }
  const totals = await repo.one(repo.pool, `${SALES}
    SELECT (SELECT count(*)::int FROM inv) AS invoices,(SELECT COALESCE(sum(taxable_amount),0)::numeric(14,2) FROM inv) AS taxable,
      (SELECT COALESCE(sum(gst),0)::numeric(14,2) FROM inv) AS gst,(SELECT COALESCE(sum(total_amount),0)::numeric(14,2) FROM inv) AS total,
      (SELECT count(*)::int FROM platform_invoices WHERE sample AND issued_on BETWEEN $1::date AND $2::date) AS sample_invoices,
      (SELECT COALESCE(sum(total_amount),0)::numeric(14,2) FROM platform_invoices WHERE sample AND issued_on BETWEEN $1::date AND $2::date) AS sample_total`, [from, to]);
  return {
    from, to, by, rows,
    totals: { invoices: totals.invoices, taxable: totals.taxable, gst: totals.gst, total: totals.total },
    sample: { invoices: totals.sample_invoices, total: totals.sample_total },
  };
}

// Paid time ending within the next `within` days (30 unless asked), and paid
// time already ended and in grace: each with what its renewal would ask before
// GST, its owner to call and any order it has open.
async function renewalsReport(user, query = {}) {
  requirePlatform(user);
  let within = 30;
  if (query.within !== undefined && query.within !== '') {
    within = v.requiredNumber(query.within, 'Within', { min: 1, max: 365 });
    if (!Number.isInteger(within)) fail('Within must be a whole number of days');
  }
  const rows = await repo.all(repo.pool, `SELECT b.id,b.name,b.code,b.business_type,bt.name AS type_name,st.state,st.access_ends_on,st.grace_ends_on,
      st.access_ends_on-t.today AS days_left,sub.plan_code,pl.name AS plan_name,sub.billing_period,${NEXT_ORDER_VALUE}::numeric(14,2) AS value,
      own.name AS owner_name,own.mobile AS owner_mobile,own.email AS owner_email,oo.id AS open_order_id,oo.total_amount AS open_order_total,oo.checking
    FROM businesses b CROSS JOIN LATERAL business_plan_state(b.id) st CROSS JOIN LATERAL (SELECT business_local_today(b.id) AS today) t
    JOIN business_types bt ON bt.code=b.business_type
    LEFT JOIN business_subscriptions sub ON sub.business_id=b.id LEFT JOIN platform_plans pl ON pl.code=sub.plan_code
    ${OWNER}
    LEFT JOIN LATERAL (SELECT o.id,o.total_amount,EXISTS (SELECT 1 FROM platform_payments p WHERE p.order_id=o.id AND p.status='pending') AS checking
      FROM platform_orders o WHERE o.business_id=b.id AND o.status='open') oo ON TRUE
    WHERE (st.state='paid' AND st.access_ends_on<=t.today+$1::int) OR (st.state='grace' AND st.period_kind='paid')
    ORDER BY st.access_ends_on,b.name`, [within]);
  const items = rows.map((row) => ({
    businessId: row.id, name: row.name, code: row.code, businessType: row.business_type, typeName: row.type_name, state: row.state,
    endsOn: row.access_ends_on, graceEndsOn: row.grace_ends_on, daysLeft: row.days_left, planCode: row.plan_code, planName: row.plan_name,
    billingPeriod: row.billing_period, value: row.value, ownerName: row.owner_name || null, ownerMobile: row.owner_mobile || null, ownerEmail: row.owner_email || null,
    openOrder: row.open_order_id ? { id: row.open_order_id, total: row.open_order_total, checking: row.checking } : null,
  }));
  return { within, items, totals: { count: items.length, value: sumRupees(items.map((item) => item.value)) } };
}

// Orders still open (not paid, not cancelled), oldest first, by how many days
// old they are (India's date): up to 30, 31 to 60, 61 to 90, over 90.
async function duesReport(user) {
  requirePlatform(user);
  const today = await companyToday();
  const rows = await repo.all(repo.pool, `SELECT o.id AS order_id,o.business_id,b.name,b.code,b.business_type,bt.name AS type_name,o.kind,o.billing_period,
      (o.created_at AT TIME ZONE '${ZONE}')::date AS created_on,o.valid_until,o.valid_until<business_local_today(b.id) AS expired,o.taxable_amount,o.total_amount,
      $1::date-(o.created_at AT TIME ZONE '${ZONE}')::date AS age_days,
      EXISTS (SELECT 1 FROM platform_payments p WHERE p.order_id=o.id AND p.status='pending') AS checking,st.state,
      own.name AS owner_name,own.mobile AS owner_mobile,own.email AS owner_email
    FROM platform_orders o JOIN businesses b ON b.id=o.business_id JOIN business_types bt ON bt.code=b.business_type
    CROSS JOIN LATERAL business_plan_state(b.id) st
    ${OWNER}
    WHERE o.status='open' ORDER BY o.created_at,o.id`, [today]);
  const bandOf = (age) => DUE_BANDS.find(([, , upTo]) => age <= upTo)[0];
  const items = rows.map((row) => ({
    orderId: row.order_id, businessId: row.business_id, name: row.name, code: row.code, businessType: row.business_type, typeName: row.type_name, state: row.state,
    kind: row.kind, billingPeriod: row.billing_period, createdOn: row.created_on, validUntil: row.valid_until, expired: row.expired,
    taxable: row.taxable_amount, total: row.total_amount, ageDays: row.age_days, band: bandOf(row.age_days), checking: row.checking,
    ownerName: row.owner_name || null, ownerMobile: row.owner_mobile || null, ownerEmail: row.owner_email || null,
  }));
  return {
    today, items,
    bands: DUE_BANDS.map(([band, label]) => {
      const inBand = items.filter((item) => item.band === band);
      return { band, label, count: inBand.length, total: sumRupees(inBand.map((item) => item.total)) };
    }),
    totals: { count: items.length, total: sumRupees(items.map((item) => item.total)) },
  };
}

module.exports = { overview, funnel, leads, setLeadStatus, addLeadNote, salesReport, renewalsReport, duesReport };
