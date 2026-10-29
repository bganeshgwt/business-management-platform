const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const expenses = require('../../core/services/businessExpenses.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./memberCommon');

// Trainers' pay and sales commission (module "member_plans", permission
// member_plans.manage):
//
//   rules     what a trainer (of Trainers & studios) or a salesperson (a staff
//             login) earns from a month on: a fixed sum a month, per class
//             taken (a class of the timetable with someone attending), per
//             personal-training session given (an appointment of theirs
//             marked done), and a share of the personal-training plans and
//             of the other plans they sold (the plan's value before GST, less
//             what was credited back on it). A new rule replaces the one
//             before from its month. The shop's own rates: none are assumed.
//   report    each person's month worked out from the class, appointment and
//             membership records, on the business's calendar.
//   payout    a month's pay to one person, paid through the expense book (as
//             wages) so the drawer and the day's money see it; once a month
//             per person, its figures kept as paid.
// Memberships brought in from another system, trial passes and memberships
// passed on are never sales.

const { fail, id, paise, rupees } = c;

// A month typed as YYYY-MM, with its first and last day.
function readMonth(value, name = 'Month') {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) fail(`${name} must be a month such as 2026-10`);
  const first = `${text}-01`;
  return { month: text, first, last: c.addDays(c.addMonths(first, 1), -1) };
}

const RULES_SQL = `SELECT r.id,r.trainer_id,r.user_id,COALESCE(t.name,u.name) AS name,CASE WHEN r.trainer_id IS NULL THEN 'staff' ELSE 'trainer' END AS kind,
    to_char(r.from_month,'YYYY-MM') AS from_month,r.fixed_monthly,r.per_class,r.per_pt_session,r.pt_sales_percent,r.plan_sales_percent,r.created_at,cb.name AS created_by_name
  FROM member_pay_rules r LEFT JOIN business_resources t ON t.business_id=r.business_id AND t.id=r.trainer_id LEFT JOIN users u ON u.id=r.user_id
  JOIN users cb ON cb.id=r.created_by WHERE r.business_id=$1`;

async function rules(business) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.manage');
  return repo.all(repo.pool, `${RULES_SQL} ORDER BY name,r.from_month DESC,r.id DESC`, [business.id]);
}

// body: { trainerId | userId, fromMonth: 'YYYY-MM', fixedMonthly?, perClass?, perPtSession?, ptSalesPercent?, planSalesPercent? }
async function addRule(business, user, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.manage');
  const trainerId = c.given(body.trainerId) ? Number(id(body.trainerId, 'Trainer')) : null;
  const userId = c.given(body.userId) ? Number(id(body.userId, 'Salesperson')) : null;
  if (Boolean(trainerId) === Boolean(userId)) fail('Choose a trainer or a salesperson');
  const { first } = readMonth(body.fromMonth, 'From month');
  const amount = (value, name) => (c.given(value) ? core.decimal(value, name, 2, 0, 10000000) : 0);
  const percent = (value, name) => (c.given(value) ? core.decimal(value, name, 2, 0, 100) : 0);
  const rule = { fixed: amount(body.fixedMonthly, 'Fixed a month'), perClass: amount(body.perClass, 'Per class'), perPt: amount(body.perPtSession, 'Per personal-training session'),
    ptPercent: percent(body.ptSalesPercent, 'Share of personal-training sales (%)'), planPercent: percent(body.planSalesPercent, 'Share of other plans sold (%)') };
  return repo.transaction(async (db) => {
    const name = trainerId ? (await repo.one(db, 'SELECT name FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, trainerId]))?.name
      : (await repo.one(db, 'SELECT u.name FROM business_memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND m.user_id=$2', [business.id, userId]))?.name;
    if (!name) fail(trainerId ? 'Trainer not found' : 'That person is not on this business\'s staff', 404);
    const row = await repo.one(db, `INSERT INTO member_pay_rules(business_id,trainer_id,user_id,from_month,fixed_monthly,per_class,per_pt_session,pt_sales_percent,plan_sales_percent,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [business.id, trainerId, userId, first, rule.fixed.toFixed(2), rule.perClass.toFixed(2), rule.perPt.toFixed(2),
      rule.ptPercent.toFixed(2), rule.planPercent.toFixed(2), user.id]);
    await repo.audit(db, business.id, user.id, 'member_pay_rule.created', row.id, { name, fromMonth: first.slice(0, 7), ...rule });
    return repo.one(db, `${RULES_SQL} AND r.id=$2`, [business.id, row.id]);
  });
}

// The rule in force for a person in a month (the latest written from that month or before).
const ruleOf = (db, business, person, first) => repo.one(db, `${RULES_SQL} AND ${person.kind === 'trainer' ? 'r.trainer_id' : 'r.user_id'}=$2 AND r.from_month<=$3::date
  ORDER BY r.from_month DESC,r.id DESC LIMIT 1`, [business.id, person.id, first]);

// The value sold (before GST, less what was credited back on the plan's line) by a trainer or a salesperson in the month.
const SALES_SQL = (column) => `SELECT COALESCE(sum(m.price_net-COALESCE((SELECT sum(rl.net) FROM business_return_lines rl WHERE rl.business_id=m.business_id AND rl.line_id=m.line_id),0))
    FILTER (WHERE m.personal_training),0) AS pt,
    COALESCE(sum(m.price_net-COALESCE((SELECT sum(rl.net) FROM business_return_lines rl WHERE rl.business_id=m.business_id AND rl.line_id=m.line_id),0))
    FILTER (WHERE NOT m.personal_training),0) AS plans,count(*)::int AS memberships
  FROM member_memberships m WHERE m.business_id=$1 AND m.${column}=$2 AND m.origin='sale' AND m.transferred_from IS NULL
    AND (m.created_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date`;

// One person's month: the figures from the records, the rule, the amount, and its payout if paid.
async function figuresOf(db, business, person, { first, last }) {
  const tz = business.timezone || 'Asia/Kolkata';
  const rule = await ruleOf(db, business, person, first);
  let classes = 0, ptSessions = 0;
  if (person.kind === 'trainer') {
    classes = (await repo.one(db, `SELECT count(*)::int AS n FROM member_class_sessions s WHERE s.business_id=$1 AND s.trainer_id=$2 AND s.cancelled_at IS NULL
      AND s.day BETWEEN $3::date AND $4::date AND EXISTS (SELECT 1 FROM member_class_bookings k WHERE k.business_id=s.business_id AND k.session_id=s.id AND k.status='attended')`,
    [business.id, person.id, first, last])).n;
    ptSessions = (await repo.one(db, `SELECT count(*)::int AS n FROM business_appointments a WHERE a.business_id=$1 AND a.resource_id=$2 AND a.status='completed'
      AND (a.starts_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date`, [business.id, person.id, first, last, tz])).n;
  }
  const sales = await repo.one(db, SALES_SQL(person.kind === 'trainer' ? 'trainer_id' : 'sold_by'), [business.id, person.id, first, last, tz]);
  const ptSales = paise(sales.pt), planSales = paise(sales.plans);
  const parts = rule ? {
    fixed: paise(rule.fixed_monthly), classes: classes * paise(rule.per_class), ptSessions: ptSessions * paise(rule.per_pt_session),
    ptSales: c.percentOf(ptSales, rule.pt_sales_percent), planSales: c.percentOf(planSales, rule.plan_sales_percent),
  } : { fixed: 0, classes: 0, ptSessions: 0, ptSales: 0, planSales: 0 };
  const amount = Object.values(parts).reduce((s, x) => s + x, 0);
  const paid = await repo.one(db, `SELECT p.id,p.amount,p.created_at,e.method,e.method_name,u.name AS by_name FROM member_payouts p
    JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id JOIN users u ON u.id=p.created_by
    WHERE p.business_id=$1 AND ${person.kind === 'trainer' ? 'p.trainer_id' : 'p.user_id'}=$2 AND p.month=$3::date AND e.voided_at IS NULL ORDER BY p.id DESC LIMIT 1`,
  [business.id, person.id, first]);
  return { person, rule, figures: { classes, ptSessions, ptSales: rupees(ptSales), planSales: rupees(planSales), memberships: sales.memberships },
    parts: Object.fromEntries(Object.entries(parts).map(([k, x]) => [k, rupees(x)])), amount: rupees(amount), paid };
}

// Who is paid or credited in a month: trainers and salespeople with a rule in force or something to their name.
async function people(db, business, { first, last }) {
  const tz = business.timezone || 'Asia/Kolkata';
  return repo.all(db, `SELECT 'trainer' AS kind,t.id,t.name FROM business_resources t WHERE t.business_id=$1 AND (
        EXISTS (SELECT 1 FROM member_pay_rules r WHERE r.business_id=t.business_id AND r.trainer_id=t.id AND r.from_month<=$2::date)
        OR EXISTS (SELECT 1 FROM member_class_sessions s WHERE s.business_id=t.business_id AND s.trainer_id=t.id AND s.day BETWEEN $2::date AND $3::date)
        OR EXISTS (SELECT 1 FROM member_memberships m WHERE m.business_id=t.business_id AND m.trainer_id=t.id AND (m.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date))
    UNION ALL
    SELECT 'staff',u.id,u.name FROM users u WHERE EXISTS (SELECT 1 FROM business_memberships bm WHERE bm.business_id=$1 AND bm.user_id=u.id) AND (
        EXISTS (SELECT 1 FROM member_pay_rules r WHERE r.business_id=$1 AND r.user_id=u.id AND r.from_month<=$2::date)
        OR EXISTS (SELECT 1 FROM member_memberships m WHERE m.business_id=$1 AND m.sold_by=u.id AND m.origin='sale' AND (m.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date))
    ORDER BY kind DESC,name`, [business.id, first, last, tz]);
}

// query: { month: 'YYYY-MM' (this month by default) }
async function report(business, query) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.manage');
  const day = await c.today(repo.pool, business);
  const period = readMonth(c.given(query.month) ? query.month : day.slice(0, 7));
  const rows = [];
  for (const person of await people(repo.pool, business, period)) rows.push(await figuresOf(repo.pool, business, person, period));
  const sum = (pick) => rupees(rows.reduce((s, r) => s + paise(pick(r)), 0));
  return { month: period.month, from: period.first, to: period.last, rows,
    totals: { amount: sum((r) => r.amount), paid: sum((r) => (r.paid ? r.paid.amount : 0)), ptSales: sum((r) => r.figures.ptSales), planSales: sum((r) => r.figures.planSales) } };
}

// body: { requestKey, month, trainerId | userId, method | methodId, reference?, locationId? }
async function payout(business, user, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.manage');
  await access.require(business, 'expenses.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const period = readMonth(body.month);
  const person = c.given(body.trainerId) ? { kind: 'trainer', id: Number(id(body.trainerId, 'Trainer')) } : c.given(body.userId) ? { kind: 'staff', id: Number(id(body.userId, 'Salesperson')) } : null;
  if (!person) fail('Choose the trainer or salesperson paid');
  const choice = paymentMethods.readChoice(body, 'Paid by', expenses.KINDS);
  const reference = v.optionalString(body.reference, 'Reference', 100) || null;
  return repo.transaction(async (db) => {
    // One payout at a time per business: what is due is read after the lock.
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM member_payouts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return figuresOf(db, business, { ...person, name: null }, period).then((r) => ({ ...r, payoutId: old.id }));
    }
    if (await repo.one(db, 'SELECT 1 FROM business_expenses WHERE business_id=$1 AND request_key=$2', [business.id, requestKey])) fail('This request key was already used for different data', 409);
    const day = await c.today(db, business);
    if (period.first > day) fail('A month is paid once it has begun');
    const name = person.kind === 'trainer' ? (await repo.one(db, 'SELECT name FROM business_resources WHERE business_id=$1 AND id=$2', [business.id, person.id]))?.name
      : (await repo.one(db, 'SELECT u.name FROM business_memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND m.user_id=$2', [business.id, person.id]))?.name;
    if (!name) fail(person.kind === 'trainer' ? 'Trainer not found' : 'That person is not on this business\'s staff', 404);
    const result = await figuresOf(db, business, { ...person, name }, period);
    if (result.paid) fail(`${name}'s pay for ${period.month} is paid already`, 409);
    if (paise(result.amount) <= 0) fail(`${name} has nothing to be paid for ${period.month}`, 409);
    const chosen = body.locationId || business.location_scope || business.member_location_id;
    if (!chosen) fail('Choose the location that paid');
    const locationId = id(chosen, 'Location');
    access.requireLocation(business, locationId);
    if (!await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId])) fail('That location is not available', 404);
    const expense = await expenses.insertExpense(db, business, user, { locationId, spentOn: day, category: 'wages',
      description: `${person.kind === 'trainer' ? 'Trainer\'s pay' : 'Sales commission'}: ${name}, ${period.month}`.slice(0, 200), amount: result.amount, choice, reference, requestKey });
    const row = await repo.one(db, `INSERT INTO member_payouts(business_id,trainer_id,user_id,month,amount,figures,expense_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [business.id, person.kind === 'trainer' ? person.id : null, person.kind === 'staff' ? person.id : null, period.first,
      result.amount, JSON.stringify({ figures: result.figures, parts: result.parts, rule: result.rule }), expense.id, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'member_pay.paid', row.id, { name, month: period.month, amount: result.amount, method: expense.method, expenseId: expense.id });
    await repo.event(db, business.id, user.id, 'member_pay.paid', 'member_payout', row.id, { name, month: period.month, amount: result.amount, expenseId: expense.id });
    return { ...(await figuresOf(db, business, { ...person, name }, period)), payoutId: row.id };
  });
}

module.exports = { rules, addRule, report, payout, readMonth };
