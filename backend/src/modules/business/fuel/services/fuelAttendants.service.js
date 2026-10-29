const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const expenses = require('../../core/services/businessExpenses.service');
const c = require('./fuelCommon');
const money = require('./fuelMoney');

// The attendants' accounts (module "fuel", fuel stations). A shift closed
// short leaves its short due from its attendant (the walk-in bills are paid
// it from their account, so nothing is left due on them); an excess is held
// on the account. A short is recovered when the attendant pays it, or by a
// deduction recorded when they are paid their wages (the wages paid out go in
// the expense book, as wages); an excess goes to other income only when a
// manager takes it there, saying why. What the attendant pays and what goes
// to income are money in on the day's money (day close), at the outlet where
// it was handed in. A reopened shift's short or excess is reversed.
// Every entry is kept as it was written and audited.

const { fail, id } = c;
const KINDS = ['cash', 'upi', 'card', 'bank'];
const SIGNS = { short: ['due', 1], short_reversed: ['due', -1], paid: ['due', -1], deducted: ['due', -1], excess: ['held', 1], excess_reversed: ['held', -1], to_income: ['held', -1] };

// Money of the attendants' accounts is for those who see sales.
async function requireMoney(business) {
  c.requireFuel(business);
  await access.require(business, 'fuel.view');
  await access.require(business, 'sales.view');
}

// What a list of entries adds up to, in paise: { due, held, short, excess, paid, deducted, toIncome, reversed }.
function sums(entries) {
  const out = { due: 0, held: 0, short: 0, excess: 0, paid: 0, deducted: 0, toIncome: 0, shortReversed: 0, excessReversed: 0 };
  for (const e of entries) {
    const amount = money.paise(e.amount);
    const [balance, sign] = SIGNS[e.kind];
    out[balance] += sign * amount;
    const key = { short: 'short', excess: 'excess', paid: 'paid', deducted: 'deducted', to_income: 'toIncome', short_reversed: 'shortReversed', excess_reversed: 'excessReversed' }[e.kind];
    out[key] += amount;
  }
  return out;
}
const shaped = (s) => Object.fromEntries(Object.entries(s).map(([k, x]) => [k, money.rupees(x)]));

// The period asked for (the month so far until given), on the business's clock.
async function period(db, business, query) {
  const today = await c.today(db, business);
  const from = query.from ? c.readDate(query.from, 'From date') : `${today.slice(0, 8)}01`;
  const to = query.to ? c.readDate(query.to, 'To date') : today;
  if (to < from) fail('The end date is before the start date');
  if (Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('Choose up to 367 days');
  return { today, from, to };
}

const ENTRIES_SQL = `SELECT e.*,(e.created_at AT TIME ZONE b.timezone)::date::text AS day,s.shift_no,s.id AS shift_id,l.name AS location_name,u.name AS created_by_name,x.description AS wages
  FROM fuel_attendant_entries e JOIN businesses b ON b.id=e.business_id JOIN business_locations l ON l.business_id=e.business_id AND l.id=e.location_id JOIN users u ON u.id=e.created_by
  LEFT JOIN fuel_shift_closes k ON k.business_id=e.business_id AND k.id=e.close_id LEFT JOIN fuel_shifts s ON s.business_id=k.business_id AND s.id=k.shift_id
  LEFT JOIN business_expenses x ON x.business_id=e.business_id AND x.id=e.expense_id
  WHERE e.business_id=$1`;

// query: { from?, to?, locationId? } — each attendant with an account: what
// they owed and held before the period, what came on and off it in the
// period, and what they owe and what is held for them at its end.
async function accounts(business, query = {}) {
  await requireMoney(business);
  const db = repo.pool;
  const { from, to, today } = await period(db, business, query);
  const locationId = c.given(query.locationId) ? id(query.locationId, 'Outlet') : business.location_scope || null;
  if (locationId) access.requireLocation(business, locationId);
  const entries = await repo.all(db, `SELECT * FROM (${ENTRIES_SQL}) e WHERE e.day<=$2 AND ($3::bigint IS NULL OR e.location_id=$3) ORDER BY e.attendant_name,e.id`,
    [business.id, to, locationId]);
  const people = [...new Set(entries.map((e) => String(e.attendant_id)))];
  const items = people.map((person) => {
    const mine = entries.filter((e) => String(e.attendant_id) === person);
    const before = sums(mine.filter((e) => e.day < from));
    const within = sums(mine.filter((e) => e.day >= from));
    const end = sums(mine);
    return { attendantId: Number(person), name: mine.at(-1).attendant_name, opening: { due: money.rupees(before.due), held: money.rupees(before.held) },
      period: shaped(within), closing: { due: money.rupees(end.due), held: money.rupees(end.held) },
      shifts: new Set(mine.filter((e) => e.day >= from && (e.kind === 'short' || e.kind === 'excess')).map((e) => String(e.close_id))).size };
  });
  const total = (pick) => money.rupees(items.reduce((sum, x) => sum + money.paise(pick(x)), 0));
  return { from, to, today, locationId, items, totals: { due: total((x) => x.closing.due), held: total((x) => x.closing.held), short: total((x) => x.period.short),
    excess: total((x) => x.period.excess), paid: total((x) => x.period.paid), deducted: total((x) => x.period.deducted), toIncome: total((x) => x.period.toIncome) } };
}

// query: { from?, to? } — one attendant's account: every entry of the period
// with its shift, and what they owe and what is held for them now.
async function account(business, attendantId, query = {}) {
  await requireMoney(business);
  const db = repo.pool;
  const { from, to } = await period(db, business, query);
  const person = await personOf(db, business, attendantId);
  const all = await repo.all(db, `SELECT * FROM (${ENTRIES_SQL}) e WHERE e.attendant_id=$2 AND e.day<=$3 ORDER BY e.id`, [business.id, person.id, to]);
  const now = await repo.one(db, 'SELECT due,held FROM fuel_attendant_balance($1,$2)', [business.id, person.id]);
  const before = sums(all.filter((e) => e.day < from));
  return { attendant: person, from, to, opening: { due: money.rupees(before.due), held: money.rupees(before.held) }, period: shaped(sums(all.filter((e) => e.day >= from))),
    entries: all.filter((e) => e.day >= from).map(({ request_hash: _h, ...e }) => e), now: { due: money.rupees(money.paise(now.due)), held: money.rupees(money.paise(now.held)) } };
}

// Someone with an account here, or on the staff.
async function personOf(db, business, value) {
  const personId = id(value, 'Attendant');
  const person = await repo.one(db, `SELECT u.id,u.name FROM users u WHERE u.id=$2 AND (EXISTS (SELECT 1 FROM business_memberships m WHERE m.business_id=$1 AND m.user_id=u.id)
    OR EXISTS (SELECT 1 FROM fuel_attendant_entries e WHERE e.business_id=$1 AND e.attendant_id=u.id))`, [business.id, personId]);
  if (!person) fail('Attendant not found', 404);
  return person;
}

// One entry written by a person (not a close): checked, audited, its event raised.
async function record(business, user, attendantId, body, { kind, permission, words }) {
  c.requireFuel(business);
  await access.require(business, 'sales.view');
  await access.require(business, permission);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const amount = c.readMoney(body.amount, kind === 'to_income' ? 'Excess taken to income' : kind === 'deducted' ? 'Deducted from the wages' : 'Amount paid',
    { min: 0, minExclusive: true, max: 9999999.99 });
  const note = kind === 'paid' ? c.optionalText(body.note, 'Note', 300) : v.requiredString(typeof body.note === 'string' ? body.note : '', kind === 'to_income' ? 'Why it goes to income' : 'What the deduction is for', 300);
  const choice = kind === 'paid' ? paymentMethods.readChoice(body, 'Paid by', KINDS) : null;
  // A deduction made when the wages are paid: what is paid out now, if anything, goes in the expense book.
  const wages = kind === 'deducted' && c.given(body.wages) && Number(body.wages) > 0 ? c.readMoney(body.wages, 'Wages paid now', { min: 0, minExclusive: true }) : null;
  const wagesChoice = wages ? paymentMethods.readChoice(body.wagesPaidBy || body, 'Wages paid by', expenses.KINDS) : null;
  if (wages) {
    await access.require(business, 'expenses.create');
    if (!business.modules.includes('expenses')) fail('Expenses are switched off for this business: the wages are paid out through them', 409);
  }
  // The account is read back once the transaction has committed the entry.
  const personId = await repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,attendant_id,request_hash FROM fuel_attendant_entries WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return old.attendant_id;
    }
    const person = await personOf(db, business, attendantId);
    const location = await c.locationOf(db, business, body.locationId);
    const balance = await repo.one(db, 'SELECT due,held FROM fuel_attendant_balance($1,$2)', [business.id, person.id]);
    if (kind !== 'to_income' && money.paise(amount) > money.paise(balance.due)) fail(`${person.name} owes ₹${money.rupees(Math.max(0, money.paise(balance.due)))} on their account: no more than that is recovered`, 409);
    if (kind === 'to_income' && money.paise(amount) > money.paise(balance.held)) fail(`₹${money.rupees(Math.max(0, money.paise(balance.held)))} of ${person.name} is held as excess: no more than that goes to income`, 409);
    const method = choice ? await paymentMethods.settle(db, business.id, choice, 'Paid by', KINDS) : kind === 'to_income' ? { method: 'cash', methodName: null } : { method: null, methodName: null };
    let expense = null;
    if (wages) {
      expense = await expenses.insertExpense(db, business, user, { locationId: location.id, spentOn: await c.today(db, business), category: 'wages',
        description: `Wages to ${person.name}, ₹${amount} short deducted`.slice(0, 200), amount: wages, choice: wagesChoice, reference: null, requestKey: c.derivedKey(requestKey, 'wages') });
    }
    const row = await repo.one(db, `INSERT INTO fuel_attendant_entries(business_id,location_id,attendant_id,attendant_name,kind,amount,method,method_name,expense_id,note,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [business.id, location.id, person.id, person.name, kind, amount, method.method, method.methodName, expense?.id || null,
      note, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, `fuel_attendant.${words}`, row.id, { attendant: person.name, amount: row.amount, location: location.name, note,
      ...(method.method ? { method: method.method, methodName: method.methodName } : {}), ...(expense ? { wagesPaid: expense.amount, expenseId: expense.id } : {}) });
    await repo.event(db, business.id, user.id, `fuel_attendant.${words}`, 'fuel_attendant_entry', row.id, { attendantId: person.id, locationId: location.id, amount: row.amount,
      method: method.method });
    return person.id;
  });
  return account(business, personId, {});
}

// body: { requestKey, locationId, amount, methodId | method, note? } — the attendant pays what they owe.
const pay = (business, user, attendantId, body) => record(business, user, attendantId, body, { kind: 'paid', permission: 'fuel.edit', words: 'paid' });
// body: { requestKey, locationId, amount, note, wages?, wagesPaidBy?: { methodId | method } } — kept back from their wages.
const deduct = (business, user, attendantId, body) => record(business, user, attendantId, body, { kind: 'deducted', permission: 'fuel.approve', words: 'deducted' });
// body: { requestKey, locationId, amount, note } — an excess taken to other income by a manager.
const toIncome = (business, user, attendantId, body) => record(business, user, attendantId, body, { kind: 'to_income', permission: 'fuel.approve', words: 'excess_to_income' });

// The day's money (day close): an attendant paying their short and an excess
// taken to income are money in, on the day and at the outlet they were written.
async function moneyRows(business, from, to, locationId, db = repo.pool) {
  return repo.all(db, `SELECT CASE e.kind WHEN 'paid' THEN 'attendant' ELSE 'other_income' END AS source,e.method,e.method_name,e.created_by AS person,e.location_id,e.amount,false AS at_sale
    FROM fuel_attendant_entries e WHERE e.business_id=$1 AND e.kind IN ('paid','to_income') AND (e.created_at AT TIME ZONE $5)::date BETWEEN $2::date AND $3::date
      AND ($4::bigint IS NULL OR e.location_id=$4)`, [business.id, from, to, locationId, business.timezone]);
}

module.exports = { accounts, account, pay, deduct, toIncome, moneyRows, sums };
