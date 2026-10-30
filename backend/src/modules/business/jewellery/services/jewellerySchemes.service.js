const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./jewelleryCommon');
const money = require('./jewelleryMoney');

// Gold schemes (module "jewellery"): a customer joins a plan the shop offers
// and pays a fixed amount every month, for at most 11 months; the money is
// turned into jewellery on a jewellery bill within the year. Each instalment
// is a core collection receipt of the customer's money (a receipt, not a
// sale: the GST is on the jewellery bill that redeems the scheme), so the day
// close, the customer's account and the cash limit see it. The bill that
// redeems a scheme uses all the money it holds, and, when every instalment
// was paid and the scheme has matured, takes the plan's discount off the bill
// (a percentage of one instalment, given as a discount, never as "interest").
// A scheme's money is never paid back in money: a scheme cancelled with a
// manager's approval is stopped (no more instalments and no discount), and
// what was paid is still used on a jewellery bill. When the bill that redeemed
// a scheme is returned while the scheme is within its tenure (to its day 364),
// its money goes back onto the scheme by credit note, to be redeemed again;
// after that it stays on the returned bill as the customer's credit.
//
// A scheme still open on its day 364 (the business's clock) is closed when
// someone confirms it (the bell asks the shop that day: the platform runs no
// jobs by itself): billed as gold or silver equal to all it holds at that
// day's rate (the fewest milligrams whose bill comes to its money; the few
// rupees the last milligram adds are due when the customer collects), the
// metal set aside from the shop's metal and tagged as a piece held in the
// customer's safekeeping, never sold to anyone else; the customer collects it
// later against the bill. A company's scheme money is shown against 25% of
// its net worth (Settings › Jewellery settings), and the bell warns past it.
// The plan's terms are kept on each scheme as they were when the customer
// joined. Money is integer paise in this file.

const { fail, id } = c;
const MAX_INSTALMENT = 1000000;
const INSTALMENT_KINDS = ['cash', 'upi', 'card', 'bank'];
// Cash paid into one scheme stays under this: its instalments pay one jewellery bill.
const CASH_LIMIT = 20000000;
const STAGE_WORDS = { paying: 'Paying', due: 'Instalment due', matured: 'Matured', stopped: 'Stopped', closing: 'Closes today (day 364)', past_close: 'Past its close day',
  safekeeping: 'In safekeeping', redeemed: 'Redeemed' };
// A company's gold scheme money is kept within this share of its net worth.
const NET_WORTH_SHARE = 25;
const pins = () => require('../../salon-weight/services/businessManagerPin');
const bills = () => require('./jewelleryBills.service');
const piecesOf = () => require('./jewelleryPieces.service');
const NO_INTEREST = /\binterest/i;

const PAID_SQL = (s) => `(SELECT count(*)::int FROM jewellery_scheme_instalments i WHERE i.business_id=${s}.business_id AND i.scheme_id=${s}.id)`;
const SCHEMES_SQL = `SELECT x.*,
    CASE WHEN x.status='redeemed' AND x.close_id IS NOT NULL AND x.collected_at IS NULL AND x.close_piece_status='safekeeping' THEN 'safekeeping'
      WHEN x.status='redeemed' THEN 'redeemed' WHEN x.close_by::date<x.today THEN 'past_close' WHEN x.close_by::date=x.today THEN 'closing'
      WHEN x.status='stopped' THEN 'stopped'
      WHEN x.paid_count<x.instalments AND x.next_due<=x.today THEN 'due' WHEN x.paid_count=x.instalments AND x.today>=x.maturity_on::date THEN 'matured'
      ELSE 'paying' END AS stage,
    (x.close_by::date-x.today) AS days_left
  FROM (SELECT s.id,s.location_id,l.name AS location_name,s.scheme_no,s.contact_id,s.member_name,s.member_phone,s.plan_id,s.plan_name,s.instalments,s.instalment,
      s.discount_percent,s.terms,s.nominee_name,s.nominee_relation,s.terms_accepted_at,s.started_on::text AS started_on,s.maturity_on::text AS maturity_on,
      s.close_by::text AS close_by,s.status,s.stop_reason,s.stopped_at,su.name AS stopped_by_name,au.name AS stop_approved_by_name,s.redeemed_document_id,
      d.document_no AS redeemed_document_no,s.redeemed_at,s.discount,s.notes,s.created_at,u.name AS by_name,(now() AT TIME ZONE b.timezone)::date AS today,
      ${PAID_SQL('s')} AS paid_count,
      COALESCE((SELECT sum(i.amount) FROM jewellery_scheme_instalments i WHERE i.business_id=s.business_id AND i.scheme_id=s.id),0) AS paid,
      jewellery_scheme_held(s.business_id,s.id) AS held,
      COALESCE((SELECT sum(i.amount) FROM jewellery_scheme_instalments i JOIN business_collections k ON k.business_id=i.business_id AND k.id=i.collection_id
        WHERE i.business_id=s.business_id AND i.scheme_id=s.id AND k.method='cash'),0) AS cash_paid,
      (s.started_on+make_interval(months => ${PAID_SQL('s')}))::date AS next_due,
      k.id AS close_id,k.created_at AS closed_at,k.collected_at,ku.name AS collected_by_name,kp.id AS close_piece_id,kp.tag_no AS close_tag,kp.status AS close_piece_status,
      kp.metal AS close_metal,kp.purity AS close_purity,kp.net_weight AS close_weight
    FROM jewellery_schemes s JOIN businesses b ON b.id=s.business_id JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id
    JOIN users u ON u.id=s.created_by LEFT JOIN users su ON su.id=s.stopped_by LEFT JOIN users au ON au.id=s.stop_approved_by
    LEFT JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.redeemed_document_id
    LEFT JOIN jewellery_scheme_closes k ON k.business_id=s.business_id AND k.scheme_id=s.id LEFT JOIN users ku ON ku.id=k.collected_by
    LEFT JOIN jewellery_pieces kp ON kp.business_id=k.business_id AND kp.id=k.piece_id WHERE s.business_id=$1) x`;
const PLANS_SQL = `SELECT p.id,p.name,p.instalments,p.min_instalment,p.discount_percent,p.terms,p.active,p.created_at,u.name AS by_name,
    (SELECT count(*)::int FROM jewellery_schemes s WHERE s.business_id=p.business_id AND s.plan_id=p.id AND s.status<>'redeemed') AS open_schemes,
    (SELECT count(*)::int FROM jewellery_schemes s WHERE s.business_id=p.business_id AND s.plan_id=p.id) AS schemes
  FROM jewellery_scheme_plans p JOIN users u ON u.id=p.created_by WHERE p.business_id=$1`;

repo.addLists({
  // Every scheme, newest first, with what was paid and is held, the next instalment's day, where it stands, and whether it is
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

// What the scheme paid on the bill that redeemed it and has not had back, and the credit left on that bill (paise):
// how much of its money can go back onto it now.
async function putBackChoice(db, business, scheme) {
  if (scheme.status !== 'redeemed' || scheme.close_id || !scheme.redeemed_document_id) return null;
  const row = await repo.one(db, `SELECT
      COALESCE((SELECT sum(p.amount) FROM business_payments p JOIN jewellery_scheme_instalments i ON i.business_id=p.business_id AND i.collection_id=p.collection_id
        WHERE p.business_id=$1 AND p.document_id=$2 AND i.scheme_id=$3),0)
      + COALESCE((SELECT sum(CASE kind WHEN 'used' THEN amount ELSE -amount END) FROM jewellery_scheme_moves WHERE business_id=$1 AND scheme_id=$3 AND document_id=$2),0) AS on_bill,
      COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0)
      - COALESCE((SELECT sum(f.amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0)
      - (d.total - COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0)) AS credit
    FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, scheme.redeemed_document_id, scheme.id]);
  const most = Math.max(0, Math.min(c.paise(row.on_bill), c.paise(row.credit)));
  return { documentId: scheme.redeemed_document_id, documentNo: scheme.redeemed_document_no, onBill: Number(row.on_bill).toFixed(2), credit: Number(row.credit).toFixed(2),
    amount: c.rupees(most), withinTenure: dayText(scheme.today) <= dayText(scheme.close_by) };
}

async function view(db, business, schemeId) {
  const row = await repo.one(db, `SELECT * FROM (${SCHEMES_SQL}) w WHERE w.id=$2`, [business.id, schemeId]);
  if (!row) fail('Gold scheme not found', 404);
  const [instalments, moves] = await c.inTurn(
    () => repo.all(db, `SELECT i.seq,i.due_on::text AS due_on,i.paid_on::text AS paid_on,i.amount,i.collection_id,k.collection_no,k.method,k.method_name,k.reference,
      i.created_at,u.name AS by_name FROM jewellery_scheme_instalments i JOIN business_collections k ON k.business_id=i.business_id AND k.id=i.collection_id
      JOIN users u ON u.id=i.created_by WHERE i.business_id=$1 AND i.scheme_id=$2 ORDER BY i.seq`, [business.id, row.id]),
    () => repo.all(db, `SELECT m.id,m.kind,m.amount,m.document_id,d.document_no,m.created_at,u.name AS by_name FROM jewellery_scheme_moves m
      JOIN business_documents d ON d.business_id=m.business_id AND d.id=m.document_id JOIN users u ON u.id=m.created_by
      WHERE m.business_id=$1 AND m.scheme_id=$2 ORDER BY m.id`, [business.id, row.id]));
  const today = dayText(row.today);
  // The passbook: every instalment of the plan, paid or still to pay.
  const schedule = Array.from({ length: row.instalments }, (_, index) => {
    const paid = instalments.find((i) => i.seq === index + 1) || null;
    const dueOn = c.addMonths(row.started_on, index);
    return { seq: index + 1, due_on: dueOn, paid, late: !paid && dueOn < today && row.status === 'active' };
  });
  const scheme = { ...row, today, next_due: dayText(row.next_due) };
  const back = await putBackChoice(db, business, scheme);
  return { ...scheme, stage_words: STAGE_WORDS[row.stage], instalments_paid: instalments, schedule, moves, discount_now: c.rupees(discountNow(scheme)),
    discount_when_complete: c.rupees(discountOf(row.instalment, row.discount_percent)), yearly_rate: yearlyRate(row.instalments, row.discount_percent),
    can_pay: row.status === 'active' && row.paid_count < row.instalments && today < row.maturity_on,
    can_close: row.status !== 'redeemed' && today >= row.close_by && c.paise(row.held) > 0,
    can_collect: row.stage === 'safekeeping',
    put_back: back && c.paise(back.amount) > 0 ? back : null };
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
    ? { kind: 'customer', name: body.customer.name, phone: body.customer.phone, consents: body.customer.consents } : null;
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

// Who may approve stopping a scheme (or a deduction on old gold other than the rule's): members whose role holds
// jewellery.approve, with whether they have a PIN and whether someone else set it (pin_given: it approves nothing
// until they choose their own).
async function approvers(business) {
  c.requireJewellery(business);
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin,u.pin_must_change AS pin_given FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id
      AND p.permission_code='jewellery.approve')) ORDER BY u.name`, [business.id]);
}

// The money held for schemes against 25% of a company's net worth, as the settings give it (null: no net worth given).
function netWorthCheck(settings, heldPaise) {
  if (settings.company_net_worth === null || settings.company_net_worth === undefined) return null;
  const worth = c.paise(settings.company_net_worth);
  const limit = c.roundedDivide(worth * NET_WORTH_SHARE, 100);
  return { netWorth: c.rupees(worth), on: String(settings.net_worth_on).slice(0, 10), sharePercent: NET_WORTH_SHARE, limit: c.rupees(limit), held: c.rupees(heldPaise),
    usedPercent: worth ? (heldPaise * 100 / worth).toFixed(2) : null, headroom: c.rupees(limit - heldPaise), over: heldPaise > limit };
}

// The schemes' money the shop holds for its customers, to be given as jewellery:
// every scheme not yet redeemed, what it holds, the discount it gives now
// and when complete, and when it closes by; and, for a company, all of it
// against 25% of its net worth.
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
      paid_count: r.paid_count, paid: Number(r.held).toFixed(2), discount_now: c.rupees(discountNow(scheme)),
      discount_when_complete: r.status === 'active' ? c.rupees(discountOf(r.instalment, r.discount_percent)) : '0.00' };
  });
  const sum = (key) => c.rupees(items.reduce((s, i) => s + c.paise(i[key]), 0));
  const byPlan = [...items.reduce((map, i) => map.set(i.plan_name, [...(map.get(i.plan_name) || []), i]), new Map())]
    .map(([plan, list]) => ({ plan, schemes: list.length, paid: c.rupees(list.reduce((s, i) => s + c.paise(i.paid), 0)) }));
  // The whole business's scheme money (every location), for the net worth check.
  const all = await repo.one(repo.pool, `SELECT COALESCE(sum(w.held),0) AS held FROM (${SCHEMES_SQL}) w WHERE w.status<>'redeemed'`, [business.id]);
  const settings = await require('./jewellerySettings.service').settingsOf(repo.pool, business.id);
  return { asOf: rows[0] ? dayText(rows[0].today) : await c.today(repo.pool, business), items, byPlan, netWorth: netWorthCheck(settings, c.paise(all.held)),
    totals: { schemes: items.length, paid: sum('paid'), discountNow: sum('discount_now'), discountWhenComplete: sum('discount_when_complete'),
      pastClose: items.filter((i) => i.stage === 'past_close').length, closingToday: items.filter((i) => i.stage === 'closing').length,
      closingIn30: items.filter((i) => !['past_close', 'closing'].includes(i.stage) && Number(i.days_left) <= 30).length } };
}

// --- A scheme on a jewellery bill ---------------------------------------------------------------------

// The scheme a bill redeems (locked when posting): not redeemed yet, with all the money it holds: each
// instalment receipt not yet paid on a bill (and what is free on it), what came back onto it from a returned bill
// (paise), and the discount it gives today.
async function forBill(db, business, schemeId, { lock = false } = {}) {
  if (lock) await repo.one(db, 'SELECT id FROM jewellery_schemes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, schemeId]);
  const row = await repo.one(db, `SELECT * FROM (${SCHEMES_SQL}) w WHERE w.id=$2`, [business.id, schemeId]);
  if (!row) fail('Gold scheme not found', 404);
  if (row.status === 'redeemed') fail(`Scheme ${row.scheme_no} was redeemed on ${row.redeemed_document_no}`, 409);
  const receipts = await repo.all(db, `SELECT i.seq,i.amount,i.collection_id,k.collection_no,k.method,
      i.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=i.business_id AND p.collection_id=i.collection_id),0) AS free
    FROM jewellery_scheme_instalments i JOIN business_collections k ON k.business_id=i.business_id AND k.id=i.collection_id
    WHERE i.business_id=$1 AND i.scheme_id=$2 ORDER BY i.seq`, [business.id, row.id]);
  const back = await repo.one(db, `SELECT COALESCE(sum(CASE kind WHEN 'back' THEN amount ELSE -amount END),0) AS amount FROM jewellery_scheme_moves
    WHERE business_id=$1 AND scheme_id=$2`, [business.id, row.id]);
  const scheme = { ...row, today: dayText(row.today) };
  const free = receipts.map((r) => ({ ...r, freePaise: c.paise(r.free) })).filter((r) => r.freePaise > 0);
  const backPaise = c.paise(back.amount);
  return { ...scheme, receipts: free, backPaise, heldPaise: free.reduce((s, r) => s + r.freePaise, 0) + backPaise, cashPaise: c.paise(row.cash_paid), discount: discountNow(scheme) };
}

// After the bill's sale is posted: the scheme is redeemed on it, each instalment's receipt pays what is free on it,
// and what came back onto the scheme is used (its credit-note payment, made with the bill under backKey).
async function redeem(db, business, user, document, scheme, discount, keyOf, backKey) {
  await db.query(`UPDATE jewellery_schemes SET status='redeemed',redeemed_document_id=$3,redeemed_at=now(),discount=$4 WHERE business_id=$1 AND id=$2`,
    [business.id, scheme.id, document.id, c.rupees(discount)]);
  for (const receipt of scheme.receipts) {
    await core.recordPayment(db, business, user, document, { amount: c.rupees(receipt.freePaise), method: receipt.method, reference: receipt.collection_no,
      key: keyOf(receipt), collectionId: receipt.collection_id });
  }
  if (scheme.backPaise > 0) {
    const payment = await repo.one(db, 'SELECT id FROM business_payments WHERE business_id=$1 AND request_key=$2', [business.id, backKey]);
    await db.query(`INSERT INTO jewellery_scheme_moves(business_id,scheme_id,kind,document_id,payment_id,amount,created_by) VALUES($1,$2,'used',$3,$4,$5,$6)`,
      [business.id, scheme.id, document.id, payment.id, c.rupees(scheme.backPaise), user.id]);
  }
  const figures = { schemeNo: scheme.scheme_no, documentNo: document.document_no, paid: c.rupees(scheme.heldPaise), discount: c.rupees(discount), instalments: scheme.receipts.length,
    ...(scheme.backPaise > 0 ? { putBackUsed: c.rupees(scheme.backPaise) } : {}) };
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

// --- Day 364: closed into safekeeping, collected later ------------------------------------------------------

// The fewest milligrams of metal at a rate whose bill (less the scheme's discount, with 3% GST, rounded as the
// business rounds) comes to at least the scheme's money (paise), worked out as the bill works it out.
function closingWeight(heldPaise, discountPaise, ratePaise, rounding) {
  const totalFor = (milligrams) => {
    const taxable = money.share(BigInt(milligrams) * BigInt(ratePaise), 1000n) - discountPaise;
    if (taxable < 0) return -1;
    const raw = taxable + core.lineTax(taxable, 3);
    return rounding === 'nearest_rupee' ? Math.floor((raw + 50) / 100) * 100 : raw;
  };
  let milligrams = Math.max(1, Math.floor(((heldPaise * 100) / 103 + discountPaise) * 1000 / ratePaise) - 5);
  while (totalFor(milligrams) < heldPaise) milligrams += 1;
  while (milligrams > 1 && totalFor(milligrams - 1) >= heldPaise) milligrams -= 1;
  return { milligrams, total: totalFor(milligrams) };
}

// What a close would come to now (nothing saved): the weight of the metal, its bill and what would be due on collection.
// query: { metal, purity }
async function closePreview(business, schemeId, query = {}) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await c.requireMoney(business);
  const { metal, purity } = c.readPurity(query.metal, query.purity);
  const scheme = await forBill(repo.pool, business, id(schemeId, 'Scheme'));
  const now = await require('./jewelleryRates.service').ratesNow(repo.pool, business);
  const rate = now.byPurity.get(`${metal}:${purity}`);
  if (!rate) fail(`${c.purityWords(metal, purity)} has no rate today: set today's rates first`, 409);
  const settings = await repo.one(repo.pool, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const weight = closingWeight(scheme.heldPaise, scheme.discount, c.paise(rate.sell_rate), settings?.rounding);
  const location = c.given(query.locationId) ? id(query.locationId, 'Location') : scheme.location_id;
  const held = await repo.one(repo.pool, `SELECT COALESCE(sum(net_weight),0) AS net FROM jewellery_metal_movements WHERE business_id=$1 AND location_id=$2 AND metal=$3 AND purity=$4`,
    [business.id, location, metal, purity]);
  return { schemeNo: scheme.scheme_no, held: c.rupees(scheme.heldPaise), discount: c.rupees(scheme.discount), metal, purity, label: c.purityWords(metal, purity),
    rate: Number(rate.sell_rate).toFixed(2), netWeight: c.grams(weight.milligrams), total: c.rupees(weight.total), due: c.rupees(weight.total - scheme.heldPaise),
    shopHolds: Number(held.net).toFixed(3), enough: c.mg(held.net) >= weight.milligrams, closeBy: scheme.close_by, today: scheme.today };
}

// body: { requestKey, metal, purity, locationId? (where the metal is set aside; the scheme's own when left out), buyer?: { pan?, panDeclaration? } }.
// A scheme still open on or after its day 364 is billed as gold or silver equal to its money, held in the customer's safekeeping.
async function close(business, user, schemeId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.approve');
  await access.require(business, 'sales.create');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const { metal, purity } = c.readPurity(body.metal, body.purity);
  const buyer = body.buyer && typeof body.buyer === 'object' && !Array.isArray(body.buyer) ? body.buyer : {};
  const pieces = piecesOf();
  const accounts = require('./jewelleryAccounts');
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const done = await repo.one(db, 'SELECT scheme_id,request_hash FROM jewellery_scheme_closes WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash || Number(done.scheme_id) !== Number(schemeId)) fail('This request key was already used for different data', 409);
      return view(db, business, done.scheme_id);
    }
    const scheme = await forBill(db, business, id(schemeId, 'Scheme'), { lock: true });
    if (scheme.today < scheme.close_by) {
      fail(`Scheme ${scheme.scheme_no} closes on its day 364, ${c.dateWords(scheme.close_by)}: until then the customer redeems it on a jewellery bill`, 409);
    }
    if (scheme.heldPaise <= 0) fail(`Scheme ${scheme.scheme_no} holds no money to close`, 409);
    const location = await c.locationRow(db, business, c.given(body.locationId) ? body.locationId : scheme.location_id);
    const now = await require('./jewelleryRates.service').ratesNow(db, business);
    const rate = now.byPurity.get(`${metal}:${purity}`);
    if (!rate) fail(`${c.purityWords(metal, purity)} has no rate today: set today's rates first`, 409);
    const settings = await repo.one(db, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
    const weight = closingWeight(scheme.heldPaise, scheme.discount, c.paise(rate.sell_rate), settings?.rounding);
    const fineness = c.purityOf(metal, purity).fineness;
    const fine = c.fineMg(weight.milligrams, fineness);
    const held = await repo.one(db, `SELECT COALESCE(sum(net_weight),0) AS net,COALESCE(sum(fine_weight),0) AS fine FROM jewellery_metal_movements
      WHERE business_id=$1 AND location_id=$2 AND metal=$3 AND purity=$4`, [business.id, location.id, metal, purity]);
    if (c.mg(held.net) < weight.milligrams || c.mg(held.fine) < fine) {
      fail(`${location.name} holds ${c.grams(c.mg(held.net))} g of ${c.purityWords(metal, purity)}: scheme ${scheme.scheme_no} needs ${c.grams(weight.milligrams)} g. Bring the metal in first (Metal account), or close it in another purity.`, 409);
    }
    // The metal set aside as a piece of its own, tagged now, under the item the shop's safekeeping is billed as.
    const sku = await accounts.accountItem(db, business, user, `${metal}_safekeeping`);
    const tag = await pieces.nextTag(db, business);
    const f = { metal, purity, grossWeight: weight.milligrams / 1000, stoneWeight: 0, wastagePercent: 0, makingMode: 'flat', makingValue: 0, hallmarked: false, oldHallmark: false,
      hallmarkCharge: 0, exemption: metal === 'gold' && weight.milligrams >= 2000 ? 'bullion' : null, description: `${c.purityWords(metal, purity)} for gold scheme ${scheme.scheme_no}`,
      designCode: null, notes: null };
    const pieceId = await pieces.insertPiece(db, business, user, { skuId: sku.id, label: sku.label, tag, locationId: location.id, cost: 0,
      reasonWords: `Set aside from the shop's metal for gold scheme ${scheme.scheme_no}`, requestKey: c.derivedKey(requestKey, 'piece'), hash, f,
      event: { note: `Set aside for gold scheme ${scheme.scheme_no}, closed on its day 364`, details: { schemeNo: scheme.scheme_no } } });
    await db.query(`INSERT INTO jewellery_metal_movements(business_id,location_id,metal,purity,net_weight,fine_weight,source,piece_id,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'safekeeping',$7,$8,$9)`, [business.id, location.id, metal, purity, `-${c.grams(weight.milligrams)}`, `-${c.grams(fine)}`, pieceId,
      `Set aside for gold scheme ${scheme.scheme_no} (piece ${tag})`, user.id]);
    const posted = await bills().postIn(db, business, user, { input: { locationId: location.id, tags: [tag], items: [], discount: null, contactId: scheme.contact_id,
      newCustomer: null, oldGold: [], scheme: scheme.id, credits: [], order: null, approval: null,
      notes: `Gold scheme ${scheme.scheme_no} closed on its day 364: held in safekeeping` }, parts: [], buyer, requestKey: c.derivedKey(requestKey, 'bill'), hash, location,
    safekeeping: true });
    await db.query(`INSERT INTO jewellery_scheme_closes(business_id,scheme_id,bill_id,piece_id,location_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [business.id, scheme.id, posted.bill.id, pieceId, location.id, requestKey, hash, user.id]);
    await db.query("UPDATE jewellery_pieces SET status='safekeeping',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, pieceId, user.id]);
    await pieces.history(db, business, user, pieceId, 'safekeeping', { from: 'in_stock', to: 'safekeeping',
      note: `Sold on ${posted.document.document_no} and held in ${scheme.member_name}'s safekeeping (gold scheme ${scheme.scheme_no})` });
    const figures = { schemeNo: scheme.scheme_no, member: scheme.member_name, held: c.rupees(scheme.heldPaise), discount: c.rupees(scheme.discount),
      purity: c.purityWords(metal, purity), netWeight: c.grams(weight.milligrams), rate: Number(rate.sell_rate).toFixed(2), documentNo: posted.document.document_no,
      total: posted.document.total, due: c.rupees(c.paise(posted.document.total) - scheme.heldPaise), tag, closeBy: scheme.close_by };
    await repo.audit(db, business.id, user.id, 'jewellery_scheme.closed', scheme.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_scheme.closed', 'jewellery_scheme', scheme.id, { ...figures, documentId: posted.document.id, pieceId,
      contactId: scheme.contact_id, locationId: location.id });
    return view(db, business, scheme.id);
  });
}

// body: { requestKey, note?, payment?: { method | methodId, reference? } (what is still due on the bill) }. The customer collects
// what their scheme was closed into: the piece is theirs out of the shop, with anything still due on its bill paid first.
async function collect(business, user, schemeId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const note = c.optionalText(body.note, 'Note', 300);
  const payment = body.payment && typeof body.payment === 'object' && !Array.isArray(body.payment) ? body.payment : null;
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const close = await repo.one(db, `SELECT k.*,s.scheme_no,s.member_name,s.contact_id,b.document_id FROM jewellery_scheme_closes k
      JOIN jewellery_schemes s ON s.business_id=k.business_id AND s.id=k.scheme_id JOIN jewellery_bills b ON b.business_id=k.business_id AND b.id=k.bill_id
      WHERE k.business_id=$1 AND k.scheme_id=$2 FOR UPDATE OF k`, [business.id, id(schemeId, 'Scheme')]);
    if (!close) fail('That scheme was not closed into safekeeping', 404);
    access.requireLocation(business, close.location_id);
    if (close.collected_at) return view(db, business, close.scheme_id);
    const piece = await repo.one(db, 'SELECT id,tag_no,status FROM jewellery_pieces WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, close.piece_id]);
    if (piece.status !== 'safekeeping') fail(`Piece ${piece.tag_no} is ${piecesOf().STATUS_WORDS[piece.status]}: it was taken back on its bill's credit note`, 409);
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, close.document_id]);
    const sums = await repo.one(db, `SELECT COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
      COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded,
      COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned`, [business.id, doc.id]);
    const due = c.paise(doc.total) - c.paise(sums.returned) - c.paise(sums.paid) + c.paise(sums.refunded);
    if (due > 0) {
      if (!payment) fail(`${c.rupees(due)} is due on bill ${doc.document_no}: take it as the customer collects`, 409);
      await access.require(business, 'sales.edit');
      const choice = paymentMethods.readChoice(payment, 'Paid by', INSTALMENT_KINDS);
      const method = await paymentMethods.settle(db, business.id, choice, 'Paid by', INSTALMENT_KINDS);
      await core.recordPayment(db, business, user, doc, { amount: c.rupees(due), method: method.method, methodName: method.methodName,
        reference: c.optionalText(payment.reference, 'Reference', 100), key: c.derivedKey(requestKey, 'due') });
    }
    await db.query('UPDATE jewellery_scheme_closes SET collected_at=now(),collected_by=$3,collect_note=$4 WHERE business_id=$1 AND id=$2', [business.id, close.id, user.id, note]);
    await db.query("UPDATE jewellery_pieces SET status='sold',updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2", [business.id, piece.id, user.id]);
    await piecesOf().history(db, business, user, piece.id, 'collected', { from: 'safekeeping', to: 'sold', note: note || `Collected by ${close.member_name}` });
    const figures = { schemeNo: close.scheme_no, tag: piece.tag_no, documentNo: doc.document_no, paidNow: c.rupees(Math.max(0, due)), ...(note ? { note } : {}) };
    await repo.audit(db, business.id, user.id, 'jewellery_scheme.collected', close.scheme_id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_scheme.collected', 'jewellery_scheme', close.scheme_id, { ...figures, pieceId: piece.id, contactId: close.contact_id });
    return view(db, business, close.scheme_id);
  });
}

// body: { requestKey, amount? (empty: all that can go back) }. The bill that redeemed the scheme was returned (in full or in
// part) while the scheme is within its tenure: its money on that bill goes back onto the scheme by credit note, and the scheme is
// open again (as it was: active or stopped), to be redeemed on another jewellery bill. Past its day 364 it stays as credit.
async function putBack(business, user, schemeId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await c.requireMoney(business);
  const requestKey = core.uuid(body.requestKey);
  const amount = c.given(body.amount) ? c.paise(c.decimal(body.amount, 'Amount', 2, 0.01, 100000000)) : null;
  const first = await repo.one(repo.pool, 'SELECT id,redeemed_document_id FROM jewellery_schemes WHERE business_id=$1 AND id=$2', [business.id, id(schemeId, 'Scheme')]);
  if (!first) fail('Gold scheme not found', 404);
  const refundKey = c.derivedKey(requestKey, 'scheme-back');
  const earlier = await repo.one(repo.pool, `SELECT f.document_id,f.amount FROM business_refunds f JOIN jewellery_scheme_moves m ON m.refund_id=f.id
    WHERE f.business_id=$1 AND f.request_key=$2 AND m.scheme_id=$3`, [business.id, refundKey, first.id]);
  const documentId = earlier ? earlier.document_id : first.redeemed_document_id;
  if (!documentId) fail('This scheme was not redeemed: nothing goes back onto it', 409);
  return repo.transaction(async (db) => {
    // The bill is locked as the core locks a refund (business, then document), by someone who may refund it.
    const doc = await require('../../core/services/businessReturns.service').lockDocument(db, business, documentId, 'refund');
    const done = await repo.one(db, 'SELECT id,document_id,amount FROM business_refunds WHERE business_id=$1 AND request_key=$2', [business.id, refundKey]);
    if (done) {
      if (Number(done.document_id) !== Number(doc.id) || (amount !== null && c.paise(done.amount) !== amount)) fail('This request key was already used for different data', 409);
      return view(db, business, first.id);
    }
    await db.query('SELECT id FROM jewellery_schemes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, first.id]);
    const scheme = await view(db, business, first.id);
    access.requireLocation(business, scheme.location_id);
    if (scheme.status !== 'redeemed' || Number(scheme.redeemed_document_id) !== Number(doc.id)) fail(`Scheme ${scheme.scheme_no} is not redeemed on ${doc.document_no}`, 409);
    if (scheme.close_id) fail(`Scheme ${scheme.scheme_no} was closed into safekeeping on its day 364: its money stays on the bill as the customer's credit`, 409);
    if (scheme.today > scheme.close_by) {
      fail(`Scheme ${scheme.scheme_no} ended on its day 364 (${c.dateWords(scheme.close_by)}): its money stays on ${doc.document_no} as credit for the customer's next jewellery bill`, 409);
    }
    const choice = await putBackChoice(db, business, scheme);
    const most = c.paise(choice.amount);
    if (most <= 0) fail(`Nothing of scheme ${scheme.scheme_no} can go back from ${doc.document_no}: take the pieces back on the bill's credit note first`, 409);
    const back = amount ?? most;
    if (back > most) fail(`At most ${c.rupees(most)} of scheme ${scheme.scheme_no} goes back from ${doc.document_no}`, 409);
    const refund = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by)
      VALUES($1,$2,$3,'credit_note',$4,$5,$6) RETURNING *`, [business.id, doc.id, c.rupees(back), `Gold scheme ${scheme.scheme_no}'s money put back on the scheme`, refundKey, user.id]);
    await repo.audit(db, business.id, user.id, 'sale.refunded', refund.id, { documentId: doc.id, amount: refund.amount, method: 'credit_note' });
    await repo.event(db, business.id, user.id, 'sale.refunded', 'refund', refund.id, { documentId: doc.id, documentNo: doc.document_no, amount: refund.amount, method: 'credit_note' });
    await db.query(`INSERT INTO jewellery_scheme_moves(business_id,scheme_id,kind,document_id,refund_id,amount,created_by) VALUES($1,$2,'back',$3,$4,$5,$6)`,
      [business.id, scheme.id, doc.id, refund.id, c.rupees(back), user.id]);
    await db.query(`UPDATE jewellery_schemes SET status=CASE WHEN stopped_at IS NULL THEN 'active' ELSE 'stopped' END,redeemed_document_id=NULL,redeemed_at=NULL,discount=NULL
      WHERE business_id=$1 AND id=$2`, [business.id, scheme.id]);
    const figures = { schemeNo: scheme.scheme_no, documentNo: doc.document_no, amount: c.rupees(back), closeBy: scheme.close_by };
    await repo.audit(db, business.id, user.id, 'jewellery_scheme.put_back', scheme.id, figures);
    await repo.event(db, business.id, user.id, 'jewellery_scheme.put_back', 'jewellery_scheme', scheme.id, { ...figures, documentId: doc.id, refundId: refund.id,
      contactId: scheme.contact_id });
    return view(db, business, scheme.id);
  });
}

// The bell: schemes on their day 364 today and past it, not yet closed (bill each into safekeeping now), those closing
// within 30 days, metal in safekeeping waiting to be collected, and a company's scheme money past 25% of its net worth.
async function bell(business, base) {
  if (!c.seesMoney(business)) return [];
  const row = await repo.one(repo.pool, `SELECT count(*) FILTER (WHERE stage='past_close')::int AS past,count(*) FILTER (WHERE stage='closing')::int AS today,
      count(*) FILTER (WHERE stage NOT IN ('past_close','closing','safekeeping') AND days_left<=30)::int AS soon,count(*) FILTER (WHERE stage='safekeeping')::int AS held,
      min(close_by) FILTER (WHERE stage<>'safekeeping') AS first,COALESCE(sum(held) FILTER (WHERE status<>'redeemed'),0) AS money,min(closed_at) AS closed
    FROM (${SCHEMES_SQL}) w WHERE (w.status<>'redeemed' OR w.stage='safekeeping') AND ($2::bigint IS NULL OR w.location_id=$2)`, [business.id, business.location_scope || null]);
  const items = [];
  if (row.today) {
    items.push({ id: `jewellery-schemes:closing:${dayText(row.first)}`, severity: 'critical', category: 'Gold schemes', title: `${c.plural(row.today, 'gold scheme')} ${row.today === 1 ? 'reaches' : 'reach'} day 364 today`,
      detail: 'Close each today: its money is billed as gold or silver held in the customer\'s safekeeping', at: new Date().toISOString(), link: `${base}/gold-schemes` });
  }
  if (row.past) {
    items.push({ id: 'jewellery-schemes:past', severity: 'critical', category: 'Gold schemes', title: `${c.plural(row.past, 'gold scheme')} past the close day`,
      detail: 'A scheme\'s money is turned into jewellery within the year: close each into safekeeping now', at: `${dayText(row.first)}T00:00:00.000Z`, link: `${base}/gold-schemes` });
  }
  if (row.soon) {
    items.push({ id: 'jewellery-schemes:soon', severity: 'warning', category: 'Gold schemes', title: `${c.plural(row.soon, 'gold scheme')} closing within 30 days`,
      detail: 'Bill each by its close day', at: `${dayText(row.first)}T00:00:00.000Z`, link: `${base}/gold-schemes` });
  }
  if (row.held) {
    items.push({ id: 'jewellery-schemes:safekeeping', severity: 'info', category: 'Gold schemes', title: `Metal in safekeeping for ${c.plural(row.held, 'customer')}`,
      detail: 'Closed schemes\' gold or silver waiting to be collected against their bills', at: new Date(row.closed).toISOString(), link: `${base}/gold-schemes` });
  }
  const settings = await require('./jewellerySettings.service').settingsOf(repo.pool, business.id);
  const check = business.location_scope ? null : netWorthCheck(settings, c.paise(row.money));
  if (check?.over) {
    items.push({ id: `jewellery-schemes:net-worth:${check.on}`, severity: 'critical', category: 'Gold schemes', title: 'Gold scheme money is past 25% of the company\'s net worth',
      detail: `${c.rupees(c.paise(check.held))} held against ${c.rupees(c.paise(check.limit))} (25% of ${c.rupees(c.paise(check.netWorth))} as of ${c.dateWords(check.on)})`,
      at: new Date().toISOString(), link: `${base}/gold-schemes` });
  }
  return items;
}

module.exports = { STAGE_WORDS, yearlyRate, plans, createPlan, setPlanActive, detail, view, enrol, payInstalment, stop, approvers, liability, forBill, redeem, heldReceipts,
  closingWeight, closePreview, close, collect, putBack, netWorthCheck, bell };
