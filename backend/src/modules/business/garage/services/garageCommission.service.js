const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const expenses = require('../../core/services/businessExpenses.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./garageCommon');
const money = require('./garageMoney');
const { reversalOf } = require('./garageReversal');

// Mechanics' commission on labour (module "garage", garages).
//
//   rates     a percent per labour item (it comes first) or per mechanic,
//             kept in Settings › Garage settings (settings.edit).
//   earned    when a job is billed: each labour line's value before GST, as
//             billed, earns its mechanic the rate. The line's mechanic is who
//             ticked it done, when they are on the job card; otherwise the
//             job card's mechanics share it equally (to the paisa). A line
//             with no rate earns nothing.
//   paid      through the expense book (a payout is an expense of the day, so
//             the drawer and the day's money see it), never more than is due;
//             a manager's (garage.approve with expenses.create).
//   taken     when the bill line that carried a labour line is credited (a
//   back      return, or a credit by value such as an insurer's short payment
//             written off), the commission it earned is taken back in
//             proportion to the labour credited, to the paisa, as an entry of
//             its own dated the credit's day. A payout already made stays: what
//             is taken back comes off what is due next, and what is due may go
//             below nothing (the mechanic owes it). A short payment billed to
//             the owner instead takes nothing back: the labour is still billed.
//   report    for a period, each mechanic's labour billed, commission earned,
//             taken back and paid, and what is due now (reports.view).
// Money is integer paise.

const { fail, id } = c;
const { paise, rupees } = money;
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

// --- Rates ---------------------------------------------------------------------------------------------

async function rates(business) {
  c.requireGarage(business);
  await access.requireAny(business, ['settings.view', 'reports.view', 'garage.approve']);
  return repo.all(repo.pool, `SELECT r.id,r.sku_id,s.label,s.code,r.user_id,u.name AS user_name,r.percent,r.updated_at,b.name AS updated_by_name
    FROM garage_commission_rates r JOIN users b ON b.id=r.updated_by LEFT JOIN catalog_skus s ON s.business_id=r.business_id AND s.id=r.sku_id
    LEFT JOIN users u ON u.id=r.user_id WHERE r.business_id=$1 ORDER BY (r.sku_id IS NULL),COALESCE(s.label,u.name)`, [business.id]);
}

// body: { skuId | userId, percent (empty: no rate) }
async function setRate(business, user, body) {
  c.requireGarage(business);
  await access.require(business, 'settings.edit');
  const skuId = c.given(body.skuId) ? id(body.skuId, 'Labour item') : null;
  const userId = c.given(body.userId) ? id(body.userId, 'Mechanic') : null;
  if (Boolean(skuId) === Boolean(userId)) fail('Give the rate for a labour item or for a mechanic');
  const percent = c.given(body.percent) ? core.decimal(String(body.percent).trim(), 'Commission %', 2, 0.01, 100) : null;
  return repo.transaction(async (db) => {
    let name;
    if (skuId) {
      const sku = await repo.one(db, `SELECT s.label,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2`, [business.id, skuId]);
      if (!sku) fail('Labour item not found', 404);
      if (sku.kind !== 'service') fail(`${sku.label} is kept in stock: commission is on labour, a service`);
      name = sku.label;
    } else {
      const person = (await c.mechanics(db, business)).find((m) => Number(m.id) === userId);
      if (!person) fail('A mechanic is a member whose role works on job cards', 404);
      name = person.name;
    }
    const column = skuId ? 'sku_id' : 'user_id';
    const before = await repo.one(db, `SELECT percent FROM garage_commission_rates WHERE business_id=$1 AND ${column}=$2`, [business.id, skuId || userId]);
    if (percent === null) await db.query(`DELETE FROM garage_commission_rates WHERE business_id=$1 AND ${column}=$2`, [business.id, skuId || userId]);
    else if (before) await db.query(`UPDATE garage_commission_rates SET percent=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND ${column}=$2`, [business.id, skuId || userId, percent.toFixed(2), user.id]);
    else await db.query(`INSERT INTO garage_commission_rates(business_id,${column},percent,updated_by) VALUES($1,$2,$3,$4)`, [business.id, skuId || userId, percent.toFixed(2), user.id]);
    await repo.audit(db, business.id, user.id, 'garage_commission.rate_changed', skuId || userId, { for: name, kind: skuId ? 'labour' : 'mechanic',
      from: before ? before.percent : null, to: percent === null ? null : percent.toFixed(2) });
    return rates(business);
  });
}

// --- Earned at billing ---------------------------------------------------------------------------------

// Inside the billing transaction: `values` are the job's lines as billed
// (garageMoney.todayValues); `day` the business's date; `billLines` which bill
// line carries each job card line (job line id → document line id), kept with
// the commission so a credit of that line takes it back.
async function earn(db, business, job, values, day, billLines = new Map()) {
  const labour = values.filter((x) => x.line.kind === 'labour' && x.net > 0);
  if (!labour.length) return [];
  const rateRows = await repo.all(db, 'SELECT sku_id,user_id,percent FROM garage_commission_rates WHERE business_id=$1', [business.id]);
  if (!rateRows.length) return [];
  const itemRate = new Map(rateRows.filter((r) => r.sku_id).map((r) => [Number(r.sku_id), Number(r.percent)]));
  const personRate = new Map(rateRows.filter((r) => r.user_id).map((r) => [Number(r.user_id), Number(r.percent)]));
  const crew = (await repo.all(db, 'SELECT user_id FROM garage_job_card_mechanics WHERE business_id=$1 AND job_card_id=$2 ORDER BY user_id', [business.id, job.id])).map((r) => Number(r.user_id));
  const earned = [];
  for (const value of labour) {
    const doneBy = value.line.done_by ? Number(value.line.done_by) : null;
    const people = doneBy && crew.includes(doneBy) ? [doneBy] : crew;
    if (!people.length) continue;
    const shares = money.apportion(value.net, people.map(() => 1));
    for (const [index, userId] of people.entries()) {
      const percent = itemRate.get(Number(value.line.sku_id)) ?? personRate.get(userId);
      if (!percent) continue;
      const amount = Math.round((shares[index] * percent) / 100);
      await db.query(`INSERT INTO garage_commissions(business_id,job_card_id,line_id,user_id,base,percent,amount,earned_on,document_line_id,line_net)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [business.id, job.id, value.line.id, userId, rupees(shares[index]), percent.toFixed(2), rupees(amount), day,
        billLines.get(Number(value.line.id)) || null, rupees(value.net)]);
      earned.push({ userId, lineId: Number(value.line.id), base: rupees(shares[index]), percent, amount: rupees(amount) });
    }
  }
  return earned;
}

// --- Taken back when the labour is credited ------------------------------------------------------------

// Inside a return's transaction (businessReturns.postReturn, the bill locked,
// its lines in): the commission earned on each bill line it credits, taken
// back in proportion to the labour credited so far on that line. Returns the
// entries made.
async function reverse(db, business, user, saved) {
  const credited = await repo.all(db, `SELECT rl.line_id,COALESCE((SELECT sum(x.net) FROM business_return_lines x WHERE x.business_id=rl.business_id AND x.line_id=rl.line_id),0) AS credited
    FROM business_return_lines rl WHERE rl.business_id=$1 AND rl.return_id=$2`, [business.id, saved.id]);
  if (!credited.length) return [];
  const earned = await repo.all(db, `SELECT g.id,g.user_id,g.job_card_id,g.document_line_id,g.amount,g.base,g.line_net,u.name AS user_name,
      COALESCE((SELECT sum(r.amount) FROM garage_commission_reversals r WHERE r.business_id=g.business_id AND r.commission_id=g.id),0) AS amount_back,
      COALESCE((SELECT sum(r.base) FROM garage_commission_reversals r WHERE r.business_id=g.business_id AND r.commission_id=g.id),0) AS base_back
    FROM garage_commissions g JOIN users u ON u.id=g.user_id WHERE g.business_id=$1 AND g.document_line_id=ANY($2::bigint[]) ORDER BY g.id`,
  [business.id, credited.map((x) => x.line_id)]);
  if (!earned.length) return [];
  const day = await c.today(db, business);
  const made = [];
  for (const entry of earned) {
    const line = credited.find((x) => String(x.line_id) === String(entry.document_line_id));
    const back = reversalOf({ amount: paise(entry.amount), base: paise(entry.base), lineNet: paise(entry.line_net) }, paise(line.credited),
      { amount: paise(entry.amount_back), base: paise(entry.base_back) });
    if (!back.amount && !back.base) continue;
    const row = await repo.one(db, `INSERT INTO garage_commission_reversals(business_id,commission_id,user_id,return_id,line_id,base,amount,reversed_on)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, entry.id, entry.user_id, saved.id, entry.document_line_id, rupees(back.base), rupees(back.amount), day]);
    made.push({ ...row, user_name: entry.user_name, job_card_id: entry.job_card_id });
  }
  if (!made.length) return made;
  const mechanics = made.map((m) => ({ userId: Number(m.user_id), mechanic: m.user_name, amount: m.amount, base: m.base }));
  await repo.audit(db, business.id, user.id, 'garage_commission.taken_back', saved.id, { returnNo: saved.return_no, documentId: Number(saved.document_id), reversedOn: day, mechanics });
  await repo.event(db, business.id, user.id, 'garage_commission.taken_back', 'return', saved.id, { returnNo: saved.return_no, documentId: Number(saved.document_id), reversedOn: day,
    mechanics: mechanics.map(({ userId, amount: value }) => ({ userId, amount: value })) });
  return made;
}

// --- The report and payouts ----------------------------------------------------------------------------

const PAID_SQL = `COALESCE((SELECT sum(p.amount) FROM garage_commission_payouts p JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id
  WHERE p.business_id=$1 AND p.user_id=x.user_id AND e.voided_at IS NULL),0)`;
const EARNED_SQL = 'COALESCE((SELECT sum(g.amount) FROM garage_commissions g WHERE g.business_id=$1 AND g.user_id=x.user_id),0)';
// Taken back when the labour it was earned on was credited.
const BACK_SQL = 'COALESCE((SELECT sum(r.amount) FROM garage_commission_reversals r WHERE r.business_id=$1 AND r.user_id=x.user_id),0)';

async function period(business, query) {
  const today = await c.today(repo.pool, business);
  const from = c.given(query.from) ? core.dateText(query.from, 'From date') : `${today.slice(0, 8)}01`;
  const to = c.given(query.to) ? core.dateText(query.to, 'To date') : today;
  if (to < from || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose a date range of up to 367 days');
  return { from, to };
}

// query: { from?, to? } (this month to today)
async function report(business, query = {}) {
  c.requireGarage(business);
  await access.require(business, 'reports.view');
  const { from, to } = await period(business, query);
  const rows = await repo.all(repo.pool, `WITH x AS (
      SELECT user_id FROM garage_commissions WHERE business_id=$1 UNION SELECT user_id FROM garage_commission_payouts WHERE business_id=$1
      UNION SELECT user_id FROM garage_commission_rates WHERE business_id=$1 AND user_id IS NOT NULL)
    SELECT x.user_id,u.name,
      (SELECT count(DISTINCT g.line_id)::int FROM garage_commissions g WHERE g.business_id=$1 AND g.user_id=x.user_id AND g.earned_on BETWEEN $2::date AND $3::date) AS lines,
      (SELECT count(DISTINCT g.job_card_id)::int FROM garage_commissions g WHERE g.business_id=$1 AND g.user_id=x.user_id AND g.earned_on BETWEEN $2::date AND $3::date) AS jobs,
      COALESCE((SELECT sum(g.base) FROM garage_commissions g WHERE g.business_id=$1 AND g.user_id=x.user_id AND g.earned_on BETWEEN $2::date AND $3::date),0) AS labour,
      COALESCE((SELECT sum(g.amount) FROM garage_commissions g WHERE g.business_id=$1 AND g.user_id=x.user_id AND g.earned_on BETWEEN $2::date AND $3::date),0) AS earned,
      COALESCE((SELECT sum(r.amount) FROM garage_commission_reversals r WHERE r.business_id=$1 AND r.user_id=x.user_id AND r.reversed_on BETWEEN $2::date AND $3::date),0) AS taken_back,
      COALESCE((SELECT sum(p.amount) FROM garage_commission_payouts p JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id
        WHERE p.business_id=$1 AND p.user_id=x.user_id AND e.voided_at IS NULL AND e.spent_on BETWEEN $2::date AND $3::date),0) AS paid,
      ${EARNED_SQL}-${BACK_SQL}-${PAID_SQL} AS due,
      (SELECT percent FROM garage_commission_rates r WHERE r.business_id=$1 AND r.user_id=x.user_id) AS own_rate
    FROM x JOIN users u ON u.id=x.user_id ORDER BY u.name`, [business.id, from, to]);
  const sum = (key) => rupees(rows.reduce((total, r) => total + paise(r[key]), 0));
  return { from, to, rows, totals: { lines: rows.reduce((n, r) => n + r.lines, 0), labour: sum('labour'), earned: sum('earned'), taken_back: sum('taken_back'), paid: sum('paid'),
    due: sum('due') } };
}

// A mechanic's labour lines in the period. query: { from?, to? }
async function lines(business, userId, query = {}) {
  c.requireGarage(business);
  await access.require(business, 'reports.view');
  const { from, to } = await period(business, query);
  const items = await repo.all(repo.pool, `SELECT g.id,g.earned_on::text AS earned_on,j.id AS job_card_id,j.job_no,j.registration_no,l.label,g.base,g.percent,g.amount
    FROM garage_commissions g JOIN garage_job_cards j ON j.business_id=g.business_id AND j.id=g.job_card_id JOIN garage_job_card_lines l ON l.business_id=g.business_id AND l.id=g.line_id
    WHERE g.business_id=$1 AND g.user_id=$2 AND g.earned_on BETWEEN $3::date AND $4::date ORDER BY g.earned_on,g.id`, [business.id, id(userId, 'Mechanic'), from, to]);
  const payouts = await repo.all(repo.pool, `SELECT p.id,p.amount,p.notes,p.created_at,e.spent_on::text AS spent_on,e.method,e.method_name,e.reference,e.voided_at,u.name AS by_name
    FROM garage_commission_payouts p JOIN business_expenses e ON e.business_id=p.business_id AND e.id=p.expense_id JOIN users u ON u.id=p.created_by
    WHERE p.business_id=$1 AND p.user_id=$2 AND e.spent_on BETWEEN $3::date AND $4::date ORDER BY p.id`, [business.id, id(userId, 'Mechanic'), from, to]);
  // Commission taken back on credits in the period, each with its credit note and the labour line it was earned on.
  const takenBack = await repo.all(repo.pool, `SELECT r.id,r.reversed_on::text AS reversed_on,j.id AS job_card_id,j.job_no,j.registration_no,l.label,rt.return_no,d.document_no,
      r.base,g.percent,r.amount
    FROM garage_commission_reversals r JOIN garage_commissions g ON g.business_id=r.business_id AND g.id=r.commission_id
    JOIN garage_job_cards j ON j.business_id=g.business_id AND j.id=g.job_card_id JOIN garage_job_card_lines l ON l.business_id=g.business_id AND l.id=g.line_id
    JOIN business_returns rt ON rt.business_id=r.business_id AND rt.id=r.return_id JOIN business_documents d ON d.business_id=rt.business_id AND d.id=rt.document_id
    WHERE r.business_id=$1 AND r.user_id=$2 AND r.reversed_on BETWEEN $3::date AND $4::date ORDER BY r.reversed_on,r.id`, [business.id, id(userId, 'Mechanic'), from, to]);
  return { from, to, items, taken_back: takenBack, payouts };
}

// body: { requestKey, amount, method | methodId, reference?, notes?, locationId? } — never more than is due.
async function payout(business, user, userId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.approve');
  await access.require(business, 'expenses.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, userId: String(userId) });
  const amount = core.decimal(body.amount, 'Amount', 2, 0.01, 10000000);
  const choice = paymentMethods.readChoice(body, 'Paid by', expenses.KINDS);
  const reference = c.optionalText(body.reference, 'Reference', 100);
  const notes = c.optionalText(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM garage_commission_payouts WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return repo.one(db, 'SELECT * FROM garage_commission_payouts WHERE business_id=$1 AND id=$2', [business.id, old.id]);
    }
    if (await repo.one(db, 'SELECT 1 FROM business_expenses WHERE business_id=$1 AND request_key=$2', [business.id, requestKey])) fail('This request key was already used for different data', 409);
    const person = await repo.one(db, 'SELECT id,name FROM users WHERE id=$1', [id(userId, 'Mechanic')]);
    const totals = await repo.one(db, `SELECT ${EARNED_SQL} AS earned,${BACK_SQL} AS back,${PAID_SQL} AS paid FROM (SELECT $2::bigint AS user_id) x`, [business.id, person?.id || 0]);
    if (!person || paise(totals.earned) === 0) fail('This person has earned no commission here', 404);
    // What was taken back on credits comes off what is due; below nothing, the mechanic owes it.
    const due = paise(totals.earned) - paise(totals.back) - paise(totals.paid);
    if (due < 0) fail(`${person.name} owes ${rupees(-due)} of commission taken back on credits: nothing is due to pay`, 409);
    if (paise(amount) > due) fail(`${person.name} is due ${rupees(Math.max(0, due))}: a payout cannot be more than that`, 409);
    const chosen = body.locationId || business.location_scope || business.member_location_id
      || (await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND active ORDER BY id LIMIT 1', [business.id]))?.id;
    if (!chosen) fail('Choose the location that paid');
    const locationId = id(chosen, 'Location');
    access.requireLocation(business, locationId);
    if (!await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId])) fail('That location is not available', 404);
    const expense = await expenses.insertExpense(db, business, user, { locationId, spentOn: await c.today(db, business), category: 'other',
      description: `Mechanic's commission: ${person.name}`.slice(0, 200), amount: amount.toFixed(2), choice, reference, requestKey });
    const row = await repo.one(db, `INSERT INTO garage_commission_payouts(business_id,user_id,expense_id,amount,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [business.id, person.id, expense.id, amount.toFixed(2), notes, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'garage_commission.paid', row.id, { mechanic: person.name, amount: row.amount, method: expense.method, expenseId: expense.id });
    await repo.event(db, business.id, user.id, 'garage_commission.paid', 'garage_commission_payout', row.id, { userId: Number(person.id), amount: row.amount, method: expense.method,
      expenseId: Number(expense.id) });
    return row;
  });
}

module.exports = { rates, setRate, earn, reverse, report, lines, payout };
