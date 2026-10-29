const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');

// The suspicious transaction log (module "jewellery"): a case for each
// transaction the shop finds suspicious, whatever its amount (attempted ones
// too): who (a customer, or a name as known), what was seen, the bills and
// vouchers it concerns, notes as it is looked into, and the decision once:
// reported to FIU-IND by the shop's principal officer (outside the platform,
// with the day and the acknowledgement typed in: the platform files nothing)
// or not reported, with why. Telling the customer is forbidden (tipping
// off), so the log is seen only by a permission of its own (jewellery.review:
// the owner's, and whoever the owner gives it), never shown to counter staff,
// never in the bell, the activity log or a customer's own copy of their data.
// It is audited in its own history: who opened, read, noted and decided each
// case, and when.

const { fail, id } = c;
const STATUS_WORDS = { open: 'Open', reported: 'Reported', not_reported: 'Not reported' };

async function guard(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.review');
}

const CASES_SQL = `SELECT k.id,k.case_no,k.contact_id,ct.name AS customer_name,k.subject,k.transactions,k.status,k.reported_on::text AS reported_on,k.report_ref,
    k.decided_at,du.name AS decided_by_name,k.created_at,u.name AS by_name,
    (SELECT count(*)::int FROM jewellery_str_entries e WHERE e.business_id=k.business_id AND e.case_id=k.id AND e.kind='note') AS notes
  FROM jewellery_str_cases k JOIN users u ON u.id=k.created_by LEFT JOIN users du ON du.id=k.decided_by
  LEFT JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id WHERE k.business_id=$1`;

async function list(business, query = {}) {
  await guard(business);
  const status = c.given(query.status) ? v.requiredEnum(query.status, 'Status', Object.keys(STATUS_WORDS)) : null;
  const rows = await repo.all(repo.pool, `${CASES_SQL} AND ($2::text IS NULL OR k.status=$2) ORDER BY k.id DESC LIMIT 200`, [business.id, status]);
  return { items: rows.map((r) => ({ ...r, status_words: STATUS_WORDS[r.status] })) };
}

async function caseView(db, business, caseId) {
  const row = await repo.one(db, `SELECT k.*,k.reported_on::text AS reported_on,ct.name AS customer_name,ct.phone AS customer_phone,u.name AS by_name,du.name AS decided_by_name
    FROM jewellery_str_cases k JOIN users u ON u.id=k.created_by LEFT JOIN users du ON du.id=k.decided_by
    LEFT JOIN business_contacts ct ON ct.business_id=k.business_id AND ct.id=k.contact_id WHERE k.business_id=$1 AND k.id=$2`, [business.id, caseId]);
  if (!row) fail('Case not found', 404);
  const entries = await repo.all(db, `SELECT e.id,e.kind,e.note,e.created_at,u.name AS by_name FROM jewellery_str_entries e JOIN users u ON u.id=e.created_by
    WHERE e.business_id=$1 AND e.case_id=$2 ORDER BY e.id`, [business.id, row.id]);
  const { request_key: _key, request_hash: _hash, ...shown } = row;
  return { ...shown, status_words: STATUS_WORDS[row.status], entries };
}

// A case opened to read is written in its history.
async function detail(business, user, caseId) {
  await guard(business);
  return repo.transaction(async (db) => {
    const found = await repo.one(db, 'SELECT id FROM jewellery_str_cases WHERE business_id=$1 AND id=$2', [business.id, id(caseId, 'Case')]);
    if (!found) fail('Case not found', 404);
    await db.query("INSERT INTO jewellery_str_entries(business_id,case_id,kind,created_by) VALUES($1,$2,'viewed',$3)", [business.id, found.id, user.id]);
    return caseView(db, business, found.id);
  });
}

// body: { requestKey, contactId? | subject (a name as known), grounds (what was seen), transactions? (the bills and vouchers) }
async function open(business, user, body) {
  await guard(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : null;
  const typedSubject = c.optionalText(body.subject, 'Who', 150);
  if (!contactId && !typedSubject) fail('Choose the customer, or write who it is as known');
  const grounds = v.requiredString(body.grounds, 'What was seen', 4000);
  const transactions = c.optionalText(body.transactions, 'The transactions it concerns', 500);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_str_cases WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return caseView(db, business, old.id);
    }
    const customer = contactId ? await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]) : null;
    if (contactId && !customer) fail('Customer not found', 404);
    const next = await repo.one(db, 'SELECT COALESCE(max(case_no),0)+1 AS n FROM jewellery_str_cases WHERE business_id=$1', [business.id]);
    const row = await repo.one(db, `INSERT INTO jewellery_str_cases(business_id,case_no,contact_id,subject,grounds,transactions,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [business.id, next.n, customer?.id || null, typedSubject || customer.name, grounds, transactions, requestKey, hash, user.id]);
    await db.query("INSERT INTO jewellery_str_entries(business_id,case_id,kind,created_by) VALUES($1,$2,'opened',$3)", [business.id, row.id, user.id]);
    return caseView(db, business, row.id);
  });
}

// body: { note }
async function note(business, user, caseId, body) {
  await guard(business);
  const text = v.requiredString(body.note, 'Note', 4000);
  return repo.transaction(async (db) => {
    const found = await repo.one(db, 'SELECT id FROM jewellery_str_cases WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(caseId, 'Case')]);
    if (!found) fail('Case not found', 404);
    await db.query("INSERT INTO jewellery_str_entries(business_id,case_id,kind,note,created_by) VALUES($1,$2,'note',$3,$4)", [business.id, found.id, text, user.id]);
    return caseView(db, business, found.id);
  });
}

// body: { decision: 'reported' | 'not_reported', note (why), reportedOn? (the day it was reported), reportRef? (the acknowledgement) }
async function decide(business, user, caseId, body) {
  await guard(business);
  const decision = v.requiredEnum(body.decision, 'Decision', ['reported', 'not_reported']);
  const why = v.requiredString(body.note, decision === 'reported' ? 'What was reported' : 'Why it is not reported', 4000);
  const reportedOn = decision === 'reported' ? c.readDate(body.reportedOn, 'Reported on') : null;
  const reportRef = decision === 'reported' ? c.optionalText(body.reportRef, 'Acknowledgement', 80) : null;
  return repo.transaction(async (db) => {
    const found = await repo.one(db, 'SELECT id,case_no,status FROM jewellery_str_cases WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(caseId, 'Case')]);
    if (!found) fail('Case not found', 404);
    if (found.status !== 'open') fail(`Case ${found.case_no} is decided: ${STATUS_WORDS[found.status].toLowerCase()}`, 409);
    if (reportedOn && reportedOn > await c.today(db, business)) fail('It was reported today or earlier');
    await db.query(`UPDATE jewellery_str_cases SET status=$3,decision_note=$4,reported_on=$5,report_ref=$6,decided_by=$7,decided_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, found.id, decision, why, reportedOn, reportRef, user.id]);
    await db.query("INSERT INTO jewellery_str_entries(business_id,case_id,kind,note,created_by) VALUES($1,$2,'decided',$3,$4)",
      [business.id, found.id, `${STATUS_WORDS[decision]}: ${why}`.slice(0, 4000), user.id]);
    return caseView(db, business, found.id);
  });
}

module.exports = { STATUS_WORDS, list, detail, open, note, decide };
