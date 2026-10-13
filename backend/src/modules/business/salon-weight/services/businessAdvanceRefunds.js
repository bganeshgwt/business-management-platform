const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');

// Handing back money a customer paid in advance (round 2, R2-SVC): a salon
// client's advance or deposit, or a repair job's advance. The advance is a
// shared receivables collection (business_collections); the refund is its
// own row (business_collection_refunds) with a number made from the receipt
// it comes out of (RC/2627/0012-R1), the manager who approved it with their
// PIN, the reason, and how the money went back. Together with what was put
// against bills it never passes what was collected (also a database rule).
// Money is integer paise in this file.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const METHODS = ['cash', 'upi', 'bank'];

// What is left of a receipt: less bills it paid and earlier refunds.
const FREE_SQL = (k) => `${k}.amount-COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${k}.business_id AND p.collection_id=${k}.id),0)
  -COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=${k}.business_id AND f.collection_id=${k}.id),0)`;

// body: { amount?, method or methodId, reference?, reason, requestKey } (the reason is the approval's).
const needsReference = (method, reference) => {
  if (method && method !== 'cash' && !reference) fail(`Enter the ${method === 'upi' ? 'UPI' : 'bank'} reference of the refund`);
};
function readRefund(body) {
  const amount = body.amount === undefined || body.amount === null || body.amount === '' ? null : paise(core.decimal(body.amount, 'Amount to refund', 2, 0.01, 10000000));
  const { method, methodId } = paymentMethods.readChoice(body, 'Refunded by', METHODS, 'cash');
  const reference = v.optionalString(body.reference, 'Reference', 100);
  needsReference(method, reference);
  return { amount, method, methodId, reference, requestKey: core.uuid(body.requestKey) };
}

// Inside the caller's transaction (the business row already locked).
// Returns { refund, repeated } — a repeated request key returns the first refund.
async function refundCollection(db, business, user, { collectionId, contactId, input, approval, source, repairJobId = null, label }) {
  const { requestKey } = input;
  const hash = hashOf({ collectionId: Number(collectionId), amount: input.amount, method: input.method, ...(input.methodId ? { methodId: input.methodId } : {}), reference: input.reference, reason: approval.reason, source });
  const old = await repo.one(db, 'SELECT * FROM business_collection_refunds WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
  if (old) {
    if (old.request_hash !== hash) fail('This request key was already used for a different refund', 409);
    return { refund: old, repeated: true };
  }
  // A refund naming one of the business's methods takes its kind and name.
  const { method, methodName } = await paymentMethods.settle(db, business.id, input, 'Refunded by', METHODS);
  needsReference(method, input.reference);
  const receipt = await repo.one(db, `SELECT k.*,${FREE_SQL('k')} AS free,
      EXISTS (SELECT 1 FROM business_collection_cheques q WHERE q.business_id=k.business_id AND q.collection_id=k.id AND q.status='bounced') AS bounced
    FROM business_collections k WHERE k.business_id=$1 AND k.id=$2 FOR UPDATE OF k`, [business.id, collectionId]);
  if (!receipt || (contactId && Number(receipt.contact_id) !== Number(contactId))) fail('That advance is not this customer\'s', 404);
  if (receipt.bounced) fail(`${receipt.collection_no} was a cheque that bounced; there is nothing to refund`, 409);
  const free = paise(receipt.free);
  if (free <= 0) fail(`Nothing is left of ${receipt.collection_no} to refund: it was used on bills or refunded already`, 409);
  const amount = input.amount === null ? free : input.amount;
  if (amount > free) fail(`Only ${rupees(free)} is left of ${receipt.collection_no} to refund`, 409);
  const count = await repo.one(db, 'SELECT count(*)::int AS n FROM business_collection_refunds WHERE business_id=$1 AND collection_id=$2', [business.id, receipt.id]);
  const refundNo = `${receipt.collection_no}-R${count.n + 1}`.slice(0, 60);
  const refund = await repo.one(db, `INSERT INTO business_collection_refunds(business_id,collection_id,contact_id,refund_no,amount,method,reference,reason,source,repair_job_id,approved_by,
      request_key,request_hash,created_by,method_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
  [business.id, receipt.id, receipt.contact_id, refundNo, rupees(amount), method, input.reference, approval.reason, source, repairJobId, approval.approver.id,
    requestKey, hash, user.id, methodName]);
  await repo.audit(db, business.id, approval.approver.id, 'collection.refunded', refund.id, {
    refundNo, collectionNo: receipt.collection_no, amount: refund.amount, method, reason: approval.reason, requestedBy: user.id, source, ...(label ? { for: label } : {}),
  });
  await repo.event(db, business.id, user.id, 'collection.refunded', 'collection', receipt.id, {
    refundId: refund.id, refundNo, contactId: receipt.contact_id, amount: refund.amount, method, approvedBy: approval.approver.id, source, repairJobId,
  });
  return { refund: { ...refund, collection_no: receipt.collection_no, contact_name: receipt.contact_name, approved_by_name: approval.approver.name, left: rupees(free - amount) }, repeated: false };
}

module.exports = { readRefund, refundCollection, FREE_SQL };
