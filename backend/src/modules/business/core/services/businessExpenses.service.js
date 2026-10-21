const repo = require('../repositories/business.repository');
const access = require('./businessAccess.service');
const { decimal, dateText, uuid } = require('./business.service');
const paymentMethods = require('./businessPaymentMethods.service');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');

const CATEGORIES = ['rent','utilities','wages','transport','supplies','cleaning','maintenance','other'];
const KINDS = ['cash','upi','card','bank'];
const today = (business) => new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }).format(new Date());
const fail = (message, status = 400) => { throw new AppError(status, message); };
// How far back a paid expense may be dated: older days' takings are settled.
const BACKDATE_DAYS = 30;
const daysBefore = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

async function location(db, business, value, required = false) {
  const chosen = value || business.location_scope || business.member_location_id;
  if (!chosen && !required) return null;
  if (!chosen) fail('Choose the location that paid this expense');
  const id = v.requiredId(chosen, 'Location');
  access.requireLocation(business, id);
  const row = await repo.one(db, 'SELECT id,active FROM business_locations WHERE business_id=$1 AND id=$2', [business.id,id]);
  if (!row || required && !row.active) fail('That location is not available', 404);
  return id;
}

async function list(business, query) {
  await access.require(business, 'expenses.view');
  const from = dateText(query.from || today(business), 'Start date');
  const to = dateText(query.to || from, 'End date');
  if (to < from || Date.parse(to)-Date.parse(from) > 366*86400000) fail('Choose up to 367 days');
  const locationId = await location(repo.pool,business,query.locationId || query.location);
  const limit = query.limit === undefined ? 25 : v.requiredId(query.limit,'Page size');
  const offset = Number(query.offset || 0);
  if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) fail('Invalid pagination');
  const search = v.optionalString(query.q,'Search',100) || '';
  const where = `e.business_id=$1 AND ($4::bigint IS NULL OR e.location_id=$4)
    AND (e.description ILIKE '%'||$5||'%' OR COALESCE(e.reference,'') ILIKE '%'||$5||'%' OR e.category ILIKE '%'||$5||'%')`;
  const values = [business.id,from,to,locationId,search];
  const [items, count, totals] = await Promise.all([
    repo.all(repo.pool, `SELECT e.*,e.spent_on::text AS spent_on,l.name AS location_name,u.name AS created_by_name
      FROM business_expenses e JOIN business_locations l ON l.business_id=e.business_id AND l.id=e.location_id
      JOIN users u ON u.id=e.created_by WHERE ${where}
      AND (e.spent_on BETWEEN $2::date AND $3::date OR (e.voided_at AT TIME ZONE $8)::date BETWEEN $2::date AND $3::date)
      ORDER BY e.spent_on DESC,e.id DESC LIMIT $6 OFFSET $7`, [...values,limit,offset,business.timezone]),
    repo.one(repo.pool, `SELECT count(*)::int AS total FROM business_expenses e WHERE ${where}
      AND (e.spent_on BETWEEN $2::date AND $3::date OR (e.voided_at AT TIME ZONE $6)::date BETWEEN $2::date AND $3::date)`, [...values,business.timezone]),
    repo.one(repo.pool, `SELECT
      COALESCE(sum(amount) FILTER(WHERE spent_on BETWEEN $2::date AND $3::date),0)::text AS paid,
      COALESCE(sum(amount) FILTER(WHERE (voided_at AT TIME ZONE $6)::date BETWEEN $2::date AND $3::date),0)::text AS reversed
      FROM business_expenses e WHERE ${where}`, [...values,business.timezone]),
  ]);
  return {items,total:count.total,limit,offset,totals};
}

async function create(business,user,body) {
  await access.require(business,'expenses.create');
  const spentOn = dateText(body.spentOn,'Expense date');
  if (spentOn > today(business)) fail('A paid expense cannot have a future date');
  if (spentOn < daysBefore(today(business), BACKDATE_DAYS)) fail(`A paid expense can be dated up to ${BACKDATE_DAYS} days back`);
  const amount = decimal(body.amount,'Amount',2,0.01,999999999).toFixed(2);
  const description = v.requiredString(body.description,'What was paid for',200);
  const category = v.requiredEnum(body.category,'Category',CATEGORIES);
  const reference = v.optionalString(body.reference,'Reference',100);
  const requestKey = uuid(body.requestKey);
  const choice = paymentMethods.readChoice(body,'Paid by',KINDS);
  return repo.transaction(async(db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE',[business.id]);
    if (!await repo.one(db,"SELECT 1 FROM business_capabilities WHERE business_id=$1 AND capability='expenses'",[business.id])) {
      fail('Expenses are switched off for this business',409);
    }
    // Serialize duplicate submissions before reading the receipt.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${business.id}:expense:${requestKey}`]);
    const locationId = await location(db,business,body.locationId,true);
    const existing = await repo.one(db,'SELECT *,spent_on::text AS spent_on FROM business_expenses WHERE business_id=$1 AND request_key=$2',[business.id,requestKey]);
    if (existing) {
      access.requireLocation(business,existing.location_id);
      if (existing.spent_on !== spentOn) {
        fail('This request already recorded a different expense',409);
      }
      if (Number(existing.amount)!==Number(amount) || existing.description!==description || existing.category!==category ||
        String(existing.location_id)!==String(locationId) || String(existing.created_by)!==String(user.id) || (existing.reference || null)!==(reference || null)
        || choice.method && existing.method!==choice.method || choice.methodId && String(existing.method_id)!==String(choice.methodId))
        fail('This request already recorded a different expense',409);
      return existing;
    }
    // A past day whose cash was already counted here stays as counted.
    if (spentOn < today(business) && await repo.one(db,'SELECT 1 FROM business_cash_checks WHERE business_id=$1 AND location_id=$2 AND checked_on>=$3 LIMIT 1',[business.id,locationId,spentOn])) {
      fail(`The cash at this location was already counted on or after ${spentOn}; record the expense with today's date`,409);
    }
    const method = await paymentMethods.settle(db,business.id,choice,'Paid by',KINDS);
    const row = await repo.one(db,`INSERT INTO business_expenses(business_id,location_id,spent_on,category,description,amount,method,method_name,method_id,reference,request_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *,spent_on::text AS spent_on`,
      [business.id,locationId,spentOn,category,description,amount,method.method,method.methodName,choice.methodId,reference,requestKey,user.id]);
    await repo.audit(db,business.id,user.id,'expense.recorded',row.id,{amount,method:row.method,locationId,spentOn,description});
    return row;
  });
}

async function reverse(business,user,expenseId,body) {
  await access.require(business,'expenses.approve');
  const reason = v.requiredString(body.reason,'Reason',300);
  return repo.transaction(async(db) => {
    const old = await repo.one(db,'SELECT * FROM business_expenses WHERE business_id=$1 AND id=$2 FOR UPDATE',[business.id,v.requiredId(expenseId,'Expense')]);
    if (!old) fail('Expense not found',404);
    access.requireLocation(business,old.location_id);
    if (old.voided_at) return old;
    const row = await repo.one(db,'UPDATE business_expenses SET voided_at=now(),voided_by=$3,void_reason=$4 WHERE business_id=$1 AND id=$2 RETURNING *',[business.id,old.id,user.id,reason]);
    await repo.audit(db,business.id,user.id,'expense.reversed',row.id,{reason,amount:row.amount,locationId:row.location_id});
    return row;
  });
}

async function totalsByMethod(business,from,to,locationId) {
  if (!access.can(business,'expenses.view')) return [];
  return repo.all(repo.pool,`SELECT method,method_name,sum(amount)::text AS amount FROM (
    SELECT method,method_name,amount FROM business_expenses WHERE business_id=$1 AND spent_on BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR location_id=$4)
    UNION ALL SELECT method,method_name,-amount FROM business_expenses WHERE business_id=$1 AND (voided_at AT TIME ZONE $5)::date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR location_id=$4)
    ) events GROUP BY method,method_name`,[business.id,from,to,locationId,business.timezone]);
}

// Expenses paid out of the drawer, for takings. They count in everyone's cash
// figures (the money really left); takings hides the breakdown from a role
// without expenses.view.
async function moneyRows(business,from,to,locationId,db=repo.pool) {
  return repo.all(db,`SELECT 'expense' AS source,method,method_name,created_by AS person,location_id,-amount AS amount,false AS at_sale
    FROM business_expenses WHERE business_id=$1 AND spent_on BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR location_id=$4)
    UNION ALL SELECT 'expense',method,method_name,voided_by,location_id,amount,false
    FROM business_expenses WHERE business_id=$1 AND (voided_at AT TIME ZONE $5)::date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR location_id=$4)`,
    [business.id,from,to,locationId,business.timezone]);
}

module.exports={list,create,reverse,totalsByMethod,moneyRows,CATEGORIES};
