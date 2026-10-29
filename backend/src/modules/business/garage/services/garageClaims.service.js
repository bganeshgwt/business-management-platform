const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const returns = require('../../core/services/businessReturns.service');
const c = require('./garageCommon');
const money = require('./garageMoney');
const jobs = require('./garageJobCards.service');
// The manager's say-so with their PIN (shared with the salon and repairs).
const pins = () => require('../../salon-weight/services/businessManagerPin');

// An insurance claim after it was intimated (module "garage", garages).
//
//   progress    intimated (the day the claim was made, on the claim) >
//               surveyed > approved > work done > re-inspected (each recorded
//               by the desk, with its date; a step may be skipped, never gone
//               back to) > invoiced (when the job is billed) > settled (when the
//               insurer's bill is paid, or what it did not pay is settled).
//   payments    the insurer's payments, recorded against its bill (a core
//               payment, with the UTR or cheque number); what is still due on
//               it is shown on the claim.
//   short       once the insurer has paid what it will, what it did not pay is
//               written off by a manager, or billed to the customer. Either way
//               a credit note on the insurer's bill takes it off, line by line
//               with their GST (so the insurer's input tax credit follows what
//               it paid); billed to the customer, a bill in their name carries
//               it as lines of the claim-share item at the same GST slabs.
// Money is integer paise.

const { fail, id } = c;
const { paise, rupees } = money;
const STEPS = ['surveyed', 'approved', 'work_done', 'reinspected', 'invoiced', 'settled'];
const STEP_WORDS = { intimated: 'intimated', surveyed: 'surveyed', approved: 'approved', work_done: 'work done', reinspected: 're-inspected', invoiced: 'invoiced', settled: 'settled' };
const PAY_KINDS = ['bank', 'cheque', 'upi', 'cash', 'card'];
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const derivedKey = (key, part) => jobs.derivedKey(key, `claim:${part}`);

// The claim's progress, its insurer's bill and what is due on it, and its settlement.
async function ofJob(db, business, job) {
  const steps = await repo.all(db, `SELECT s.step,s.on_date::text AS on_date,s.note,s.created_at,u.name AS by_name FROM garage_claim_steps s JOIN users u ON u.id=s.created_by
    WHERE s.business_id=$1 AND s.job_card_id=$2 ORDER BY s.id`, [business.id, job.id]);
  const status = steps.length ? steps.at(-1).step : 'intimated';
  let bill = null;
  if (job.insurer_document_id) {
    const doc = await repo.one(db, `SELECT d.id,d.document_no,d.total,
        COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0) AS paid,
        COALESCE((SELECT sum(amount) FROM business_refunds r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS refunded,
        COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned
      FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, job.insurer_document_id]);
    const payments = await repo.all(db, `SELECT p.id,p.amount,p.method,p.method_name,p.reference,p.created_at,u.name AS by_name FROM business_payments p JOIN users u ON u.id=p.created_by
      WHERE p.business_id=$1 AND p.document_id=$2 ORDER BY p.id`, [business.id, doc.id]);
    const due = paise(doc.total) - paise(doc.returned) - paise(doc.paid) + paise(doc.refunded);
    bill = { id: Number(doc.id), document_no: doc.document_no, total: doc.total, paid: rupees(paise(doc.paid) - paise(doc.refunded)), credited: rupees(paise(doc.returned)),
      due: rupees(Math.max(0, due)), payments };
  }
  const settlement = await repo.one(db, `SELECT s.how,s.short_amount,s.reason,s.created_at,r.return_no,d.document_no AS customer_document_no,a.name AS approved_by_name
    FROM garage_claim_settlements s JOIN business_returns r ON r.business_id=s.business_id AND r.id=s.return_id JOIN users a ON a.id=s.approved_by
    LEFT JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.customer_document_id WHERE s.business_id=$1 AND s.job_card_id=$2`, [business.id, job.id]);
  return { status, steps, insurer_bill: bill, settlement: settlement || null };
}

// A step at billing: invoiced (and, for a bill in the insurer's name the
// customer paid at once, settled). Inside the billing transaction.
async function invoiced(db, business, user, job, day, { settled = false } = {}) {
  await db.query('INSERT INTO garage_claim_steps(business_id,job_card_id,step,on_date,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, job.id, 'invoiced', day, user.id]);
  if (settled) {
    await db.query('INSERT INTO garage_claim_steps(business_id,job_card_id,step,on_date,note,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [business.id, job.id, 'settled', day, 'Paid by the customer at delivery', user.id]);
  }
}

// body: { step: surveyed | approved | work_done | reinspected, on? (a date; today), note? }
async function step(business, user, jobId, body) {
  c.requireGarage(business);
  await c.requireDesk(business);
  const name = v.requiredEnum(body.step, 'Step', STEPS.slice(0, 4));
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const job = await jobs.lockJob(db, business, jobId);
    jobs.requireOpen(job);
    const claim = await repo.one(db, 'SELECT * FROM garage_claims WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]);
    if (!claim) fail(`Job card ${job.job_no} has no claim`, 404);
    if (name === 'approved' && claim.approved_amount === null) fail('Enter the amount the insurer approved on the claim first', 409);
    const on = c.given(body.on) ? c.readDate(body.on, 'Date') : await c.today(db, business);
    await db.query('INSERT INTO garage_claim_steps(business_id,job_card_id,step,on_date,note,created_by) VALUES($1,$2,$3,$4,$5,$6)', [business.id, job.id, name, on, note, user.id]);
    await jobs.history(db, business, user, job, job.status, job.status, [`Claim ${STEP_WORDS[name]} on ${c.dateWords(on)}`, note].filter(Boolean).join(' · '));
    await repo.audit(db, business.id, user.id, 'job_card.claim_step', job.id, { jobNo: job.job_no, step: name, on, ...(note ? { note } : {}) });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// The billed job card with its claim and the insurer's bill, locked.
async function lockBilled(db, business, jobId) {
  const job = await jobs.lockJob(db, business, jobId);
  const claim = await repo.one(db, 'SELECT * FROM garage_claims WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]);
  if (!claim) fail(`Job card ${job.job_no} has no claim`, 404);
  if (!job.insurer_document_id) fail(`Job card ${job.job_no} has no bill to the insurer${job.status === 'delivered' ? '' : ' yet: it is made when the job is billed'}`, 409);
  const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, job.insurer_document_id]);
  return { job, claim, doc };
}
async function dueOn(db, business, doc) {
  const row = await repo.one(db, `SELECT
    COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
    COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded,
    COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned`, [business.id, doc.id]);
  return paise(doc.total) - paise(row.returned) - paise(row.paid) + paise(row.refunded);
}
async function settledStep(db, business, user, job, note) {
  const already = await repo.one(db, "SELECT 1 FROM garage_claim_steps WHERE business_id=$1 AND job_card_id=$2 AND step='settled'", [business.id, job.id]);
  if (already) return;
  await db.query('INSERT INTO garage_claim_steps(business_id,job_card_id,step,on_date,note,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [business.id, job.id, 'settled', await c.today(db, business), note, user.id]);
}

// The insurer's payment against its bill. body: { requestKey, amount, method | methodId, reference? }
async function insurerPayment(business, user, jobId, body) {
  c.requireGarage(business);
  await access.require(business, 'garage.view');
  await access.require(business, 'sales.edit');
  const requestKey = core.uuid(body.requestKey);
  const amount = core.decimal(body.amount, 'Amount', 2, 0.01, 100000000);
  const choice = paymentMethods.readChoice(body, 'Paid by', PAY_KINDS);
  const reference = c.optionalText(body.reference, 'Reference', 100);
  return repo.transaction(async (db) => {
    const { job, claim, doc } = await lockBilled(db, business, jobId);
    const old = await repo.one(db, 'SELECT document_id,amount,reference FROM business_payments WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (Number(old.document_id) !== Number(doc.id) || paise(old.amount) !== paise(amount) || (old.reference || null) !== (reference || null)) fail('This request key was already used for different data', 409);
      return jobs.shape(business, await jobs.load(db, business, job.id));
    }
    if (await repo.one(db, 'SELECT 1 FROM garage_claim_settlements WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id])) {
      fail(`The claim on ${job.job_no} is settled: what the insurer did not pay was settled already`, 409);
    }
    const due = await dueOn(db, business, doc);
    if (paise(amount) > due) fail(`The insurer owes ${rupees(Math.max(0, due))} on ${doc.document_no}: a payment cannot be more than that`, 409);
    const { method, methodName } = await paymentMethods.settle(db, business.id, choice, 'Paid by', PAY_KINDS);
    await core.recordPayment(db, business, user, doc, { amount: amount.toFixed(2), method, methodName, reference, key: requestKey });
    if (paise(amount) === due) await settledStep(db, business, user, job, null);
    await jobs.history(db, business, user, job, job.status, job.status, `The insurer paid on ${doc.document_no}${reference ? ` (${reference})` : ''}`);
    await repo.audit(db, business.id, user.id, 'job_card.insurer_paid', job.id, { jobNo: job.job_no, claimNo: claim.claim_no, documentNo: doc.document_no, amount: amount.toFixed(2), method,
      ...(reference ? { reference } : {}), dueAfter: rupees(due - paise(amount)) });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

// What the insurer did not pay, settled once it has paid what it will.
// body: { requestKey, how: written_off | billed, reason, approverId?, pin? (a manager's say-so, to write off) }
async function settleShort(business, user, jobId, body) {
  c.requireGarage(business);
  const how = v.requiredEnum(body.how, 'Settled by', ['written_off', 'billed']);
  const requestKey = core.uuid(body.requestKey);
  const hash = hashOf({ ...body, jobId: String(jobId), pin: undefined });
  let approval;
  if (how === 'written_off') {
    await access.require(business, 'garage.view');
    approval = await pins().readApproval(business, user, body, 'garage.approve', { reasonLabel: 'Why it is written off', selfWithoutPin: true });
  } else {
    await c.requireDesk(business);
    await access.require(business, 'sales.create');
    approval = { reason: v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300), approver: { id: Number(user.id), name: user.name } };
  }
  return repo.transaction(async (db) => {
    const { job, claim, doc } = await lockBilled(db, business, jobId);
    const done = await repo.one(db, 'SELECT request_key,request_hash FROM garage_claim_settlements WHERE business_id=$1 AND job_card_id=$2', [business.id, job.id]);
    if (done) {
      if (done.request_key === requestKey && done.request_hash === hash) return jobs.shape(business, await jobs.load(db, business, job.id));
      fail(done.request_key === requestKey ? 'This request key was already used for different data' : `The claim on ${job.job_no} is settled already`, 409);
    }
    const short = await dueOn(db, business, doc);
    if (short <= 0) fail(`The insurer has paid ${doc.document_no} in full: nothing is short`, 409);
    // The credit note: the short amount over the bill's lines by their value, GST in each line's own proportion.
    const lines = await repo.all(db, 'SELECT id,sku_id,label,net,tax,tax_rate FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, doc.id]);
    const parts = money.apportion(short, lines.map((l) => paise(l.net) + paise(l.tax)));
    const values = new Map(lines.map((l, i) => [Number(l.id), parts[i]]).filter(([, p]) => p > 0));
    const words = how === 'written_off' ? 'written off' : 'billed to the customer';
    const credit = await returns.postReturn(db, business, user, doc, { reason: `Claim ${claim.claim_no || claim.policy_no}: the insurer's short payment ${words} · ${approval.reason}`.slice(0, 300),
      requestKey: derivedKey(requestKey, 'credit'), hash, lines: [...values.keys()].map((lineId) => ({ lineId })), values, goodsByValue: true });
    let ownerDoc = null;
    if (how === 'billed') {
      const garage = await jobs.settingsOf(db, business);
      const share = garage.share;
      if (!share || !share.active || share.kind !== 'service' || share.internal_use) fail('Choose the item that bills the owner\'s share of a claim, under Settings › Garage settings', 409);
      const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
      const inclusive = settings?.tax_mode === 'inclusive';
      const slabs = money.bySlab(lines.map((l, i) => ({ rate: Number(l.tax_rate), gross: parts[i] })));
      const input = slabs.map(() => ({ skuId: share.id, quantity: '1' }));
      const fixed = slabs.map((s) => ({ price: (s.net + (inclusive ? s.tax : 0)) / 100, net: s.net, tax: s.tax, priceRuleId: null, enteredPrice: null, taxRate: s.rate.toFixed(2),
        label: money.shareLine(share, s.rate).label }));
      const documentBody = { kind: 'sale', locationId: job.location_id, contactId: job.contact_id, lines: input,
        notes: [`Job card ${job.job_no}`, job.registration_no, `what ${claim.insurer_name || 'the insurer'} did not pay of ${doc.document_no} (claim ${claim.claim_no || claim.policy_no})`].join(' · ').slice(0, 500) };
      ownerDoc = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: derivedKey(requestKey, 'owner'), hash, lines: input, paidNow: null, fixed });
    }
    await db.query(`INSERT INTO garage_claim_settlements(business_id,job_card_id,document_id,short_amount,how,return_id,customer_document_id,reason,approved_by,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [business.id, job.id, doc.id, rupees(short), how, credit.id, ownerDoc?.id || null, approval.reason, approval.approver.id, requestKey, hash, user.id]);
    await settledStep(db, business, user, job, `Short payment of ${rupees(short)} ${words}`);
    await jobs.history(db, business, user, job, job.status, job.status, `The insurer's short payment ${words}: credit note ${credit.return_no}${ownerDoc ? `, bill ${ownerDoc.document_no}` : ''}`);
    const details = { jobNo: job.job_no, claimNo: claim.claim_no, documentNo: doc.document_no, short: rupees(short), returnNo: credit.return_no, reason: approval.reason,
      approvedBy: approval.approver.name, ...(ownerDoc ? { ownerDocumentNo: ownerDoc.document_no, ownerTotal: ownerDoc.total } : {}) };
    await repo.audit(db, business.id, approval.approver.id, how === 'written_off' ? 'job_card.claim_short_written_off' : 'job_card.claim_short_billed', job.id, { ...details, recordedBy: Number(user.id) });
    await repo.event(db, business.id, user.id, 'job_card.claim_settled', 'job_card', job.id, { ...details, how });
    return jobs.shape(business, await jobs.load(db, business, job.id));
  });
}

module.exports = { STEPS, ofJob, invoiced, step, insurerPayment, settleShort };
