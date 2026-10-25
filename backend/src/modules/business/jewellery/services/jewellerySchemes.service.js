const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./jewelleryCommon');

// Gold schemes (module "jewellery"): a customer joins a plan the shop offers
// and pays a fixed amount every month, for at most 11 months; the money is
// turned into jewellery on a jewellery bill within the year. Each instalment
// is a core collection receipt of the customer's money (a receipt, not a
// sale: the GST is on the jewellery bill that redeems the scheme), so the day
// close, the customer's account and the cash limit see it. The bill that
// redeems a scheme uses all that was paid, and, when every instalment was paid
// and the scheme has matured, takes the plan's discount off the pieces (a
// percentage of one instalment, given as a discount, never as "interest").
// A scheme's money is never paid back in money: a scheme cancelled with a
// manager's approval is stopped (no more instalments and no discount), and
// what was paid is still used on a jewellery bill. A scheme closes by its day
// 364: the bell reminds the shop. The plan's terms are kept on each scheme as
// they were when the customer joined. Money is integer paise in this file.

const { fail, id } = c;
const MAX_INSTALMENT = 1000000;
const INSTALMENT_KINDS = ['cash', 'upi', 'card', 'bank'];
// Cash paid into one scheme stays under this: its instalments pay one jewellery bill.
const CASH_LIMIT = 20000000;
const STAGE_WORDS = { paying: 'Paying', due: 'Instalment due', matured: 'Matured', stopped: 'Stopped', past_close: 'Past its close day', redeemed: 'Redeemed' };
const pins = () => require('../../salon-weight/services/businessManagerPin');
const NO_INTEREST = /\binterest/i;

const PAID_SQL = (s) => `(SELECT count(*)::int FROM jewellery_scheme_instalments i WHERE i.business_id=${s}.business_id AND i.scheme_id=${s}.id)`;
const SCHEMES_SQL = `SELECT x.*,
    CASE WHEN x.status='redeemed' THEN 'redeemed' WHEN x.close_by::date<x.today THEN 'past_close' WHEN x.status='stopped' THEN 'stopped'
      WHEN x.paid_count<x.instalments AND x.next_due<=x.today THEN 'due' WHEN x.paid_count=x.instalments AND x.today>=x.maturity_on::date THEN 'matured'
      ELSE 'paying' END AS stage,
    (x.close_by::date-x.today) AS days_left
  FROM (SELECT s.id,s.location_id,l.name AS location_name,s.scheme_no,s.contact_id,s.member_name,s.member_phone,s.plan_id,s.plan_name,s.instalments,s.instalment,
      s.discount_percent,s.terms,s.nominee_name,s.nominee_relation,s.terms_accepted_at,s.started_on::text AS started_on,s.maturity_on::text AS maturity_on,
      s.close_by::text AS close_by,s.status,s.stop_reason,s.stopped_at,su.name AS stopped_by_name,au.name AS stop_approved_by_name,s.redeemed_document_id,
      d.document_no AS redeemed_document_no,s.redeemed_at,s.discount,s.notes,s.created_at,u.name AS by_name,(now() AT TIME ZONE b.timezone)::date AS today,
      ${PAID_SQL('s')} AS paid_count,
      COALESCE((SELECT sum(i.amount) FROM jewellery_scheme_instalments i WHERE i.business_id=s.business_id AND i.scheme_id=s.id),0) AS paid,
      COALESCE((SELECT sum(i.amount) FROM jewellery_scheme_instalments i JOIN business_collections k ON k.business_id=i.business_id AND k.id=i.collection_id
        WHERE i.business_id=s.business_id AND i.scheme_id=s.id AND k.method='cash'),0) AS cash_paid,
      (s.started_on+make_interval(months => ${PAID_SQL('s')}))::date AS next_due
    FROM jewellery_schemes s JOIN businesses b ON b.id=s.business_id JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id
    JOIN users u ON u.id=s.created_by LEFT JOIN users su ON su.id=s.stopped_by LEFT JOIN users au ON au.id=s.stop_approved_by
    LEFT JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.redeemed_document_id WHERE s.business_id=$1) x`;
const PLANS_SQL = `SELECT p.id,p.name,p.instalments,p.min_instalment,p.discount_percent,p.terms,p.active,p.created_at,u.name AS by_name,
    (SELECT count(*)::int FROM jewellery_schemes s WHERE s.business_id=p.business_id AND s.plan_id=p.id AND s.status<>'redeemed') AS open_schemes,
    (SELECT count(*)::int FROM jewellery_schemes s WHERE s.business_id=p.business_id AND s.plan_id=p.id) AS schemes
  FROM jewellery_scheme_plans p JOIN users u ON u.id=p.created_by WHERE p.business_id=$1`;

repo.addLists({
  // Every scheme, newest first, with what was paid, the next instalment's day, where it stands, and whether it is
  // open (not yet redeemed: its money is still held for the customer).
  'jewellery-schemes': { sql: `SELECT y.*,(y.next_due)::text AS next_due_on,(y.status<>'redeemed') AS open FROM (${SCHEMES_SQL}) y`,
    search: ['scheme_no', 'member_name', 'member_phone', 'plan_name'], date: 'created_at',
    filters: { status: 'status', stage: 'stage', open: 'open', plan: 'plan_id', contact: 'contact_id', location: 'location_id' }, order: 'id DESC' },
});

// The plan's discount as a yearly figure: simple, on the money held from each
// instalment's month to maturity (n instalments of A at months 0 … n−1,
// maturity at month n: A × n(n+1)/2 money-months), for comparing plans.
const yearlyRate = (instalments, discountPercent) => (Number(discountPercent) * 24 / (instalments * (instalments + 1))).toFixed(1);
const discountOf = (instalmentRupees, percent) => c.roundedDivide(c.paise(instalmentRupees) * Math.round(Number(percent) * 100), 10000);

const planShape = (p) => ({ ...p, yearly_rate: yearlyRate(p.instalments, p.discount_percent), discount: c.rupees(discountOf(p.min_instalment, p.discount_percent)) });

async function plans(business) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  return { items: (await repo.all(repo.pool, `${PLANS_SQL} ORDER BY p.active DESC,lower(p.name)`, [business.id])).map(planShape) };
}

// body: { requestKey, name, instalments (2-11), minInstalment (whole rupees), discountPercent (0-100: of one instalment), terms }
async function createPlan(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const name = v.requiredString(body.name, 'Plan name', 80);
  const instalments = c.decimal(body.instalments, 'Instalments', 0, 2, 11);
  const min = c.decimal(body.minInstalment, 'Smallest monthly instalment', 0, 100, MAX_INSTALMENT);
  const percent = c.decimal(body.discountPercent, 'Discount (% of one instalment)', 2, 0, 100);
  const terms = v.requiredString(body.terms, 'Terms', 4000);
  if (NO_INTEREST.test(name) || NO_INTEREST.test(terms)) fail('A scheme\'s benefit is a discount on the jewellery bill: say "discount", never "interest"');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_scheme_plans WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
    } else {
      if (await repo.one(db, 'SELECT 1 FROM jewellery_scheme_plans WHERE business_id=$1 AND lower(name)=lower($2)', [business.id, name])) fail(`A plan is called ${name} already`, 409);
      const row = await repo.one(db, `INSERT INTO jewellery_scheme_plans(business_id,name,instalments,min_instalment,discount_percent,terms,request_key,request_hash,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`, [business.id, name, instalments, min.toFixed(2), percent.toFixed(2), terms, requestKey, hash, user.id]);
      const figures = { name, instalments, minInstalment: min.toFixed(2), discountPercent: percent.toFixed(2), yearlyRate: yearlyRate(instalments, percent) };
      await repo.audit(db, business.id, user.id, 'jewellery_scheme_plan.created', row.id, figures);
      await repo.event(db, business.id, user.id, 'jewellery_scheme_plan.created', 'jewellery_scheme_plan', row.id, figures);
    }
    return { items: (await repo.all(db, `${PLANS_SQL} ORDER BY p.active DESC,lower(p.name)`, [business.id])).map(planShape) };
  });
}

// body: { active }. A plan switched off takes no one new; its schemes run on.
async function setPlanActive(business, user, planId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  const active = v.requiredBoolean(body.active, 'Active');
  return repo.transaction(async (db) => {
    const plan = await repo.one(db, 'SELECT id,name,active FROM jewellery_scheme_plans WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(planId, 'Plan')]);
    if (!plan) fail('Plan not found', 404);
    if (plan.active !== active) {
      await db.query('UPDATE jewellery_scheme_plans SET active=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, plan.id, active, user.id]);
      await repo.audit(db, business.id, user.id, 'jewellery_scheme_plan.updated', plan.id, { name: plan.name, from: { active: plan.active }, to: { active } });
    }
    return { items: (await repo.all(db, `${PLANS_SQL} ORDER BY p.active DESC,lower(p.name)`, [business.id])).map(planShape) };
  });
}

// --- A scheme ----------------------------------------------------------------------------------------

// The discount a scheme gives on the bill that redeems it now (paise): the plan's
// percentage of one instalment, when every instalment is paid, it was not stopped, and it has matured.
const discountNow = (s) => (s.status === 'active' && Number(s.paid_count) === Number(s.instalments) && String(s.today) >= String(s.maturity_on).slice(0, 10)
  ? discountOf(s.instalment, s.discount_percent) : 0);
const dayText = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

async function view(db, business, schemeId) {
  const row = await repo.one(db, `SELECT * FROM (${SCHEMES_SQL}) w WHERE w.id=$2`, [business.id, schemeId]);
  if (!row) fail('Gold scheme not found', 404);
  const instalments = await repo.all(db, `SELECT i.seq,i.due_on::text AS due_on,i.paid_on::text AS paid_on,i.amount,i.collection_id,k.collection_no,k.method,k.method_name,k.reference,
      i.created_at,u.name AS by_name FROM jewellery_scheme_instalments i JOIN business_collections k ON k.business_id=i.business_id AND k.id=i.collection_id
      JOIN users u ON u.id=i.created_by WHERE i.business_id=$1 AND i.scheme_id=$2 ORDER BY i.seq`, [business.id, row.id]);
  const today = dayText(row.today);
  // The passbook: every instalment of the plan, paid or still to pay.
  const schedule = Array.from({ length: row.instalments }, (_, index) => {
    const paid = instalments.find((i) => i.seq === index + 1) || null;
    const dueOn = c.addMonths(row.started_on, index);
    return { seq: index + 1, due_on: dueOn, paid, late: !paid && dueOn < today && row.status === 'active' };
  });
  const scheme = { ...row, today, next_due: dayText(row.next_due) };
  return { ...scheme, stage_words: STAGE_WORDS[row.stage], instalments_paid: instalments, schedule, discount_now: c.rupees(discountNow(scheme)),
    discount_when_complete: c.rupees(discountOf(row.instalment, row.discount_percent)), yearly_rate: yearlyRate(row.instalments, row.discount_percent),
    can_pay: row.status === 'active' && row.paid_count < row.instalments && today < row.maturity_on };
}

async function detail(business, schemeId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  const scheme = await view(repo.pool, business, id(schemeId, 'Scheme'));
  access.requireLocation(business, scheme.location_id);
  return scheme;
}

function readPayment(body) {
  const choice = paymentMethods.readChoice(body.payment && typeof body.payment === 'object' ? body.payment : body, 'Paid by', INSTALMENT_KINDS);
  const source = body.payment && typeof body.payment === 'object' ? body.payment : body;
  return { choice, reference: c.optionalText(source.reference, 'Reference', 100) };
}

// One instalment: the customer's money as a numbered collection receipt, and its place in the scheme.
async function addInstalment(db, business, user, scheme, { method, reference, locationId, requestKey, hash }) {
  const seq = Number(scheme.paid_count) + 1;
  const words = `Gold scheme ${scheme.scheme_no}: instalment ${seq} of ${scheme.instalments}`;
  const receipt = await numbering.nextNumber(db, business.id, locationId, 'collection', user.id);
  const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,
      request_key,request_hash,created_by,method_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [business.id, locationId, receipt.number, receipt.seriesId, scheme.contact_id, scheme.member_name, Number(scheme.instalment).toFixed(2), method.method, reference, words,
    c.derivedKey(requestKey, 'instalment'), hash, user.id, method.methodName]);
  await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, goldScheme: scheme.scheme_no });
  await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
    collectionNo: collection.collection_no, contactId: scheme.contact_id, amount: collection.amount, method: collection.method });
  await db.query(`INSERT INTO jewellery_scheme_instalments(business_id,scheme_id,seq,due_on,collection_id,amount,paid_on,created_by)
    VALUES($1,$2,$3,$4,$5,$6,(now() AT TIME ZONE $8)::date,$7)`, [business.id, scheme.id, seq, c.addMonths(scheme.started_on, seq - 1), collection.id, collection.amount,
    user.id, business.timezone]);
  return { seq, collection };
}

// Cash into a scheme stays under ₹2,00,000 (its instalments pay one bill).
function checkCash(scheme, method) {
  if (method.method !== 'cash') return;
  const cash = c.paise(scheme.cash_paid) + c.paise(scheme.instalment);
  if (cash >= CASH_LIMIT) {
    fail(`Scheme ${scheme.scheme_no}'s instalments pay one jewellery bill, and one bill takes less than ₹2,00,000 in cash (Income-tax Act 2025, section 186): cash into it would reach ${c.rupees(cash)}. Take this instalment by UPI, card or bank transfer.`, 409);
  }
}

// body: { requestKey, locationId, planId, contactId? | customer?: { name, phone? } (with contacts.create), instalment (whole rupees),
//   nomineeName?, nomineeRelation?, termsAccepted: true, payment: { method | methodId, reference? } (the first instalment), notes? }
async function enrol(business, user, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await access.require(business, 'sales.edit');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Customer') : null;
  const typed = body.customer && typeof body.customer === 'object' && !Array.isArray(body.customer) && c.given(body.customer.name)
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone } : null;
  if (contactId && typed) fail('Choose the customer or type a new one, not both');
  if (!contactId && !typed) fail('Choose the customer who joins, or add them');
  if (typed) await access.require(business, 'contacts.create');
  const planId = id(body.planId, 'Plan');
  const instalment = c.decimal(body.instalment, 'Monthly instalment', 0, 1, MAX_INSTALMENT);
  if (body.termsAccepted !== true) fail('The customer accepts the scheme\'s terms: tick that they have');
  const nomineeName = c.optionalText(body.nomineeName, 'Nominee', 150);
  const nomineeRelation = c.optionalText(body.nomineeRelation, 'Nominee\'s relation', 60);
  if (nomineeRelation && !nomineeName) fail('Give the nominee\'s name with their relation');
  const pay = readPayment(body);
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM jewellery_schemes WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return view(db, business, old.id);
    }
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    const plan = await repo.one(db, 'SELECT * FROM jewellery_scheme_plans WHERE business_id=$1 AND id=$2', [business.id, planId]);
    if (!plan) fail('Plan not found', 404);
    if (!plan.active) fail(`Plan ${plan.name} is switched off: no one joins it`, 409);
    if (instalment < Number(plan.min_instalment)) fail(`Plan ${plan.name}'s monthly instalment is at least ${Number(plan.min_instalment).toFixed(2)}`);
    let contact;
    if (contactId) {
      contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
      if (!contact) fail('Customer not found', 404);
      if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
    } else {
      contact = await core.createContact(business, user, typed, db);
    }
    const method = await paymentMethods.settle(db, business.id, pay.choice, 'Paid by', INSTALMENT_KINDS);
    const day = await c.today(db, business);
    const number = await numbering.nextNumber(db, business.id, location.id, 'gold_scheme', user.id);
    checkCash({ scheme_no: number.number, cash_paid: 0, instalment }, method);
    const row = await repo.one(db, `INSERT INTO jewellery_schemes(business_id,location_id,scheme_no,series_id,contact_id,member_name,member_phone,plan_id,plan_name,instalments,instalment,
        discount_percent,terms,nominee_name,nominee_relation,terms_accepted_at,started_on,maturity_on,close_by,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, contact.phone || null, plan.id, plan.name, plan.instalments, instalment.toFixed(2),
      plan.discount_percent, plan.terms, nomineeName, nomineeRelation, day, c.addMonths(day, plan.instalments), c.addDays(day, 364), c.optionalText(body.notes, 'Notes', 300),
      requestKey, hash, user.id]);
    const scheme = await view(db, business, row.id);
    const first = await addInstalment(db, business, user, scheme, { method, reference: pay.reference, locationId: location.id, requestKey, hash });
    const figures = { schemeNo: number.number, member: contact.name, plan: plan.name, instalments: plan.instalments, instalment: instalment.toFixed(2),
      discountPercent: Number(plan.discount_percent).toFixed(2), startedOn: day, maturityOn: scheme.maturity_on, closeBy: scheme.close_by, firstReceipt: first.collection.collection_no };
    await repo.audit(db, business.id, user.id, 'jewellery_scheme.joined', row.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_scheme.joined', 'jewellery_scheme', row.id, { ...figures, contactId: contact.id, locationId: location.id,
      collectionId: first.collection.id });
    return view(db, business, row.id);
  });
}

// body: { requestKey, method | methodId, reference? (or payment: {…}), locationId? (where it is paid; the scheme's own when left out) }
async function payInstalment(business, user, schemeId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await access.require(business, 'sales.edit');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const pay = readPayment(body);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const locked = await repo.one(db, 'SELECT id,location_id FROM jewellery_schemes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(schemeId, 'Scheme')]);
    if (!locked) fail('Gold scheme not found', 404);
    const done = await repo.one(db, `SELECT k.request_hash,i.scheme_id FROM business_collections k LEFT JOIN jewellery_scheme_instalments i ON i.business_id=k.business_id AND i.collection_id=k.id
      WHERE k.business_id=$1 AND k.request_key=$2`, [business.id, c.derivedKey(requestKey, 'instalment')]);
    if (done) {
      if (done.request_hash !== hash || Number(done.scheme_id) !== Number(locked.id)) fail('This request key was already used for different data', 409);
      return view(db, business, locked.id);
    }
    const scheme = await view(db, business, locked.id);
    const locationId = c.given(body.locationId) ? id(body.locationId, 'Location') : scheme.location_id;
    access.requireLocation(business, locationId);
    if (!await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId])) fail('Location not found', 404);
    if (scheme.status !== 'active') fail(`Scheme ${scheme.scheme_no} is ${scheme.status}: it takes no more instalments`, 409);
    if (Number(scheme.paid_count) >= Number(scheme.instalments)) fail(`Scheme ${scheme.scheme_no} has all its ${scheme.instalments} instalments`, 409);
    if (scheme.today >= scheme.maturity_on) fail(`Scheme ${scheme.scheme_no} matured on ${c.dateWords(scheme.maturity_on)}: it takes no more instalments`, 409);
    const method = await paymentMethods.settle(db, business.id, pay.choice, 'Paid by', INSTALMENT_KINDS);
    checkCash(scheme, method);
    const paid = await addInstalment(db, business, user, scheme, { method, reference: pay.reference, locationId, requestKey, hash });
    const figures = { schemeNo: scheme.scheme_no, seq: paid.seq, of: scheme.instalments, amount: paid.collection.amount, method: method.method, receipt: paid.collection.collection_no };
    await repo.audit(db, business.id, user.id, 'jewellery_scheme.instalment_paid', scheme.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_scheme.instalment_paid', 'jewellery_scheme', scheme.id, { ...figures, collectionId: paid.collection.id,
      contactId: scheme.contact_id });
    return view(db, business, scheme.id);
  });
}

// body: { reason, approval?: { approverId?, pin? } }. A scheme is stopped (cancelled) with a manager's
// approval: no more instalments and no discount; what was paid is still used on a jewellery bill.
async function stop(business, user, schemeId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.cancel');
  await c.requireMoney(business);
  const approval = await pins().readApproval(business, user, { ...(body.approval && typeof body.approval === 'object' ? body.approval : {}), reason: body.reason },
    'jewellery.approve', { reasonLabel: 'Why the scheme is stopped', selfWithoutPin: true });
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const locked = await repo.one(db, 'SELECT id,location_id,status FROM jewellery_schemes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(schemeId, 'Scheme')]);
    if (!locked) fail('Gold scheme not found', 404);
    access.requireLocation(business, locked.location_id);
    if (locked.status === 'stopped') return view(db, business, locked.id);
    if (locked.status !== 'active') fail('This scheme was redeemed on a jewellery bill: it is not stopped', 409);
    await db.query(`UPDATE jewellery_schemes SET status='stopped',stop_reason=$3,stopped_by=$4,stop_approved_by=$5,stopped_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, locked.id, approval.reason, user.id, approval.approver.id]);
    const scheme = await view(db, business, locked.id);
    const figures = { schemeNo: scheme.scheme_no, member: scheme.member_name, paid: Number(scheme.paid).toFixed(2), reason: approval.reason, approvedBy: approval.approver.name,
      requestedBy: user.id };
    await repo.audit(db, business.id, approval.approver.id, 'jewellery_scheme.stopped', scheme.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_scheme.stopped', 'jewellery_scheme', scheme.id, { ...figures, approvedBy: approval.approver.id, contactId: scheme.contact_id });
    return scheme;
  });
}

// Who may approve stopping a scheme: members whose role holds jewellery.approve, with whether they have a PIN.
async function approvers(business) {
  c.requireJewellery(business);
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id
      AND p.permission_code='jewellery.approve')) ORDER BY u.name`, [business.id]);
}

// The schemes' money the shop holds for its customers, to be given as jewellery:
// every scheme not yet redeemed, what was paid in, the discount it gives now
// and when complete, and when it closes by.
async function liability(business, query = {}) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  const rows = await repo.all(repo.pool, `SELECT * FROM (${SCHEMES_SQL}) w WHERE w.status<>'redeemed' AND ($2::bigint IS NULL OR w.location_id=$2) ORDER BY w.close_by,w.id`,
    [business.id, c.given(query.location) ? id(query.location, 'Location') : business.location_scope || null]);
  const items = rows.map((r) => {
    const scheme = { ...r, today: dayText(r.today) };
    return { id: r.id, scheme_no: r.scheme_no, member_name: r.member_name, member_phone: r.member_phone, plan_name: r.plan_name, location_name: r.location_name,
      started_on: r.started_on, maturity_on: r.maturity_on, close_by: r.close_by, status: r.status, stage: r.stage, days_left: r.days_left, instalments: r.instalments,
      paid_count: r.paid_count, paid: Number(r.paid).toFixed(2), discount_now: c.rupees(discountNow(scheme)),
      discount_when_complete: r.status === 'active' ? c.rupees(discountOf(r.instalment, r.discount_percent)) : '0.00' };
  });
  const sum = (key) => c.rupees(items.reduce((s, i) => s + c.paise(i[key]), 0));
  const byPlan = [...items.reduce((map, i) => map.set(i.plan_name, [...(map.get(i.plan_name) || []), i]), new Map())]
    .map(([plan, list]) => ({ plan, schemes: list.length, paid: c.rupees(list.reduce((s, i) => s + c.paise(i.paid), 0)) }));
  return { asOf: rows[0] ? dayText(rows[0].today) : await c.today(repo.pool, business), items, byPlan,
    totals: { schemes: items.length, paid: sum('paid'), discountNow: sum('discount_now'), discountWhenComplete: sum('discount_when_complete'),
      pastClose: items.filter((i) => i.stage === 'past_close').length, closingIn30: items.filter((i) => i.stage !== 'past_close' && Number(i.days_left) <= 30).length } };
}

// --- A scheme on a jewellery bill ---------------------------------------------------------------------

// The scheme a bill redeems (locked when posting): not redeemed yet, with what was paid in,
// each instalment's receipt, and the discount it gives today (paise).
async function forBill(db, business, schemeId, { lock = false } = {}) {
  if (lock) await repo.one(db, 'SELECT id FROM jewellery_schemes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, schemeId]);
  const row = await repo.one(db, `SELECT * FROM (${SCHEMES_SQL}) w WHERE w.id=$2`, [business.id, schemeId]);
  if (!row) fail('Gold scheme not found', 404);
  if (row.status === 'redeemed') fail(`Scheme ${row.scheme_no} was redeemed on ${row.redeemed_document_no}`, 409);
  const receipts = await repo.all(db, `SELECT i.seq,i.amount,i.collection_id,k.collection_no,k.method FROM jewellery_scheme_instalments i
    JOIN business_collections k ON k.business_id=i.business_id AND k.id=i.collection_id WHERE i.business_id=$1 AND i.scheme_id=$2 ORDER BY i.seq`, [business.id, row.id]);
  const scheme = { ...row, today: dayText(row.today) };
  return { ...scheme, receipts, paidPaise: c.paise(row.paid), cashPaise: c.paise(row.cash_paid), discount: discountNow(scheme) };
}

// After the bill's sale is posted: the scheme is redeemed on it, and each instalment's receipt pays it.
async function redeem(db, business, user, document, scheme, discount, keyOf) {
  await db.query(`UPDATE jewellery_schemes SET status='redeemed',redeemed_document_id=$3,redeemed_at=now(),discount=$4 WHERE business_id=$1 AND id=$2`,
    [business.id, scheme.id, document.id, c.rupees(discount)]);
  for (const receipt of scheme.receipts) {
    await core.recordPayment(db, business, user, document, { amount: Number(receipt.amount).toFixed(2), method: receipt.method, reference: receipt.collection_no,
      key: keyOf(receipt), collectionId: receipt.collection_id });
  }
  const figures = { schemeNo: scheme.scheme_no, documentNo: document.document_no, paid: Number(scheme.paid).toFixed(2), discount: c.rupees(discount), instalments: scheme.receipts.length };
  await repo.audit(db, business.id, user.id, 'jewellery_scheme.redeemed', scheme.id, figures);
  await repo.event(db, business.id, user.id, 'jewellery_scheme.redeemed', 'jewellery_scheme', scheme.id, { ...figures, documentId: document.id, contactId: scheme.contact_id });
}

// A customer's receipts held for their gold schemes not yet redeemed (collection ids): the
// core's receivables leave them out when it applies a customer's advances to their bills.
async function heldReceipts(db, business, contactId) {
  const rows = await repo.all(db, `SELECT i.collection_id FROM jewellery_scheme_instalments i JOIN jewellery_schemes s ON s.business_id=i.business_id AND s.id=i.scheme_id
    WHERE i.business_id=$1 AND s.contact_id=$2 AND s.status<>'redeemed'`, [business.id, contactId]);
  return new Set(rows.map((r) => Number(r.collection_id)));
}

// The bell: schemes past their close day not yet redeemed (bill them now), and those closing within 30 days.
async function bell(business, base) {
  if (!c.seesMoney(business)) return [];
  const row = await repo.one(repo.pool, `SELECT count(*) FILTER (WHERE stage='past_close')::int AS past,count(*) FILTER (WHERE stage<>'past_close' AND days_left<=30)::int AS soon,
      min(close_by) AS first FROM (${SCHEMES_SQL}) w WHERE w.status<>'redeemed' AND ($2::bigint IS NULL OR w.location_id=$2)`, [business.id, business.location_scope || null]);
  const items = [];
  if (row.past) {
    items.push({ id: 'jewellery-schemes:past', severity: 'critical', category: 'Gold schemes', title: `${c.plural(row.past, 'gold scheme')} past the close day`,
      detail: 'A scheme\'s money is turned into jewellery within the year: bill them now', at: `${dayText(row.first)}T00:00:00.000Z`, link: `${base}/gold-schemes` });
  }
  if (row.soon) {
    items.push({ id: 'jewellery-schemes:soon', severity: 'warning', category: 'Gold schemes', title: `${c.plural(row.soon, 'gold scheme')} closing within 30 days`,
      detail: 'Bill each by its close day', at: `${dayText(row.first)}T00:00:00.000Z`, link: `${base}/gold-schemes` });
  }
  return items;
}

module.exports = { STAGE_WORDS, yearlyRate, plans, createPlan, setPlanActive, detail, view, enrol, payInstalment, stop, approvers, liability, forBill, redeem, heldReceipts, bell };
