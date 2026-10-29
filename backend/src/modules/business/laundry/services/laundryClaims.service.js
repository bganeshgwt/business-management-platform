const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const c = require('./laundryCommon');
const orders = require('./laundryOrders.service');
// A manager's say-so with their PIN (shared with the salon, repairs and garages).
const pins = () => require('../../salon-weight/services/businessManagerPin');

// Damage claims (module "laundry"): a customer says a garment came back
// damaged, stained, shrunk, with its colour run, lost or missing a part.
//
//   record   on a garment of the order (not cancelled): what is wrong, the
//            customer's own description, and an amount when they name one.
//            One claim at a time on a garment waits for a decision.
//   decide   by a manager (laundry.refund), once:
//              refund     the garment's charge, or part of it, comes back: a
//                         credit note on its bill line (the core's, GST in the
//                         line's proportion), and what the customer paid beyond
//                         what is then due goes back through the core's
//                         refund, with the manager's PIN
//              credit     a credit note only: it lowers what the customer owes,
//                         or stays to their credit on the bill
//              reprocess  the work done again at no charge: the garment goes
//                         back into the work (a delivered one is taken back in,
//                         under its tag or a new one)
//              rejected   with a note why
//            A credit note or a refund is at most the garment's charge on the
//            bill; compensation beyond it (the garment's value) is paid
//            outside the bill. A printed disclaimer does not decide a claim:
//            what the customer was told and acknowledged at intake is on the
//            garment, and the claim records when it was reported.
// Money is integer paise.

const { fail, id } = c;

const CLAIMS_SQL = `SELECT cl.id,cl.order_id,o.order_no,cl.item_id,i.tag_no,i.garment_name,i.service_name,i.status AS item_status,cl.issue,cl.description,cl.asked_amount,
    cl.reported_at,rp.name AS reported_by_name,cl.decision,cl.amount,cl.decision_note,cl.decided_at,dc.name AS decided_by_name,cl.refunded,rt.return_no,
    o.customer_name,o.customer_phone,o.contact_id,o.location_id,i.delivered_at,(cl.decision IS NULL) AS open,
    CASE WHEN i.delivered_at IS NULL THEN NULL ELSE (cl.reported_at AT TIME ZONE b.timezone)::date-(i.delivered_at AT TIME ZONE b.timezone)::date END AS days_after_delivery
  FROM laundry_claims cl JOIN laundry_orders o ON o.business_id=cl.business_id AND o.id=cl.order_id
  JOIN laundry_order_items i ON i.business_id=cl.business_id AND i.id=cl.item_id JOIN businesses b ON b.id=cl.business_id
  JOIN users rp ON rp.id=cl.reported_by LEFT JOIN users dc ON dc.id=cl.decided_by LEFT JOIN business_returns rt ON rt.business_id=cl.business_id AND rt.id=cl.return_id
  WHERE cl.business_id=$1`;
repo.addLists({
  // Claims waiting for a decision first, then the newest.
  'laundry-claims': { sql: CLAIMS_SQL, search: ['order_no', 'tag_no', 'customer_name', 'customer_phone', 'description', 'garment_name'], date: 'reported_at',
    filters: { open: 'open', decision: 'decision', issue: 'issue', order: 'order_id', location: 'location_id' }, order: 'open DESC, id DESC' },
});
const listShape = (business, page) => (c.seesMoney(business) ? page : { ...page, items: page.items.map((x) => ({ ...x, amount: null, asked_amount: null, refunded: null })) });

// body: { requestKey, itemId, issue, description, askedAmount? }
async function record(business, user, orderId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, orderId: String(orderId) });
  const itemId = id(body.itemId, 'Garment');
  const issue = v.requiredEnum(body.issue, 'What is wrong', c.ISSUES);
  const description = v.requiredString(typeof body.description === 'string' ? body.description : '', 'What the customer says', 1000);
  const askedAmount = c.given(body.askedAmount) ? core.decimal(body.askedAmount, 'Amount the customer asks for', 2, 0.01, 100000000) : null;
  return repo.transaction(async (db) => {
    const order = await orders.lockOrder(db, business, orderId);
    const old = await repo.one(db, 'SELECT id,request_hash FROM laundry_claims WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return orders.shape(business, await orders.load(db, business, order.id));
    }
    const item = (await orders.itemsOf(db, business, order, { lock: true })).find((i) => Number(i.id) === itemId);
    if (!item) fail(`That garment is not on order ${order.order_no}`, 404);
    if (item.status === 'cancelled') fail(`Garment ${item.tag_no} was cancelled: it takes no claim`, 409);
    if (item.claim_open) fail(`Garment ${item.tag_no} already has a claim waiting for a decision`, 409);
    const claim = await repo.one(db, `INSERT INTO laundry_claims(business_id,order_id,item_id,issue,description,asked_amount,reported_by,request_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [business.id, order.id, item.id, issue, description, askedAmount === null ? null : askedAmount.toFixed(2), user.id, requestKey, hash]);
    await orders.history(db, business, user, order, item, null, null, `Damage claim ${claim.id}: ${c.ISSUE_WORDS[issue]} · ${description}`);
    await repo.audit(db, business.id, user.id, 'laundry_claim.recorded', claim.id, { orderNo: order.order_no, tag: item.tag_no, issue, description,
      ...(askedAmount !== null ? { askedAmount: askedAmount.toFixed(2) } : {}) });
    await repo.event(db, business.id, user.id, 'laundry_claim.recorded', 'laundry_claim', claim.id, { orderNo: order.order_no, orderId: order.id, itemId: item.id, issue });
    return orders.shape(business, await orders.load(db, business, order.id));
  });
}

// body: { requestKey, decision: refund | credit | reprocess | rejected, amount? (refund, credit), note? (required to reject),
//   refund?: { method | methodId, reference? } (how money goes back), approval?: { approverId?, pin? } (a refund), tagNo? (a delivered garment taken back in) }
async function decide(business, user, claimId, body) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.refund');
  const key = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, approval: undefined, claimId: String(claimId) });
  const decision = v.requiredEnum(body.decision, 'Decision', c.DECISIONS);
  const note = c.optionalText(body.note, 'Note', 500);
  if (decision === 'rejected' && !note) fail('Say why the claim is rejected');
  const money = ['refund', 'credit'].includes(decision);
  const amount = money ? c.paise(core.decimal(body.amount, 'Amount given back', 2, 0.01, 100000000)) : null;
  if (!money && c.given(body.amount)) fail('An amount goes with money back or a credit note');
  const tag = decision === 'reprocess' ? c.readTag(body.tagNo, 'New tag') : null;
  if (decision !== 'reprocess' && c.given(body.tagNo)) fail('A new tag goes with a garment taken back in for reprocessing');
  // Money leaving the drawer needs the manager's PIN, checked before the transaction.
  const approval = decision === 'refund' ? await pins().readApproval(business, user, { ...(body.approval || {}), reason: note || `Damage claim ${claimId}` }, 'laundry.refund',
    { reasonLabel: 'Reason' }) : null;
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const claim = await repo.one(db, 'SELECT * FROM laundry_claims WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(claimId, 'Claim')]);
    if (!claim) fail('Claim not found', 404);
    // Asking again is the same decision; the same key with other data is refused.
    if (claim.decide_key === key) {
      if (claim.decide_hash !== hash) fail('This request key was already used for different data', 409);
      return orders.shape(business, await orders.load(db, business, claim.order_id));
    }
    if (claim.decision) fail(`Claim ${claim.id} was decided already`, 409);
    const order = await orders.lockOrder(db, business, claim.order_id);
    const item = (await orders.itemsOf(db, business, order, { lock: true })).find((i) => Number(i.id) === Number(claim.item_id));
    let creditNote = null, refund = null;
    if (money) {
      if (!item.line_id) fail(`Garment ${item.tag_no} is not billed yet (it is billed when handed over): decide to reprocess it or reject the claim, or hand it over first`, 409);
      if (c.paise(item.credited) > 0) fail(`The charge of garment ${item.tag_no} was credited already`, 409);
      const line = await repo.one(db, 'SELECT net,tax FROM business_document_lines WHERE business_id=$1 AND id=$2', [business.id, item.line_id]);
      const charge = c.paise(line.net) + c.paise(line.tax);
      if (amount > charge) {
        fail(`At most ${c.rupees(charge)} comes back for garment ${item.tag_no}: its charge on the bill. Compensation beyond the charge is paid outside the bill.`, 400,
          { reason: 'over_charge', charge: c.rupees(charge) });
      }
      const creditKey = c.derivedKey(key, 'credit');
      await db.query('UPDATE laundry_order_items SET credit_key=$3 WHERE business_id=$1 AND id=$2', [business.id, item.id, creditKey]);
      const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, item.document_id]);
      const words = `Laundry order ${order.order_no}, garment ${item.tag_no}: damage claim ${claim.id}${note ? `. ${note}` : ''}`.slice(0, 300);
      const returnBody = { reason: words, lines: [{ lineId: item.line_id }], amount, hash };
      creditNote = await returns.postReturn(db, business, user, doc, { reason: words, requestKey: creditKey, hash: c.hashOf(returnBody), lines: returnBody.lines,
        values: new Map([[Number(item.line_id), amount]]) });
      if (decision === 'refund') {
        const [bill] = (await orders.billsOf(db, business, order)).filter((b) => Number(b.id) === Number(doc.id));
        const back = Math.max(0, Math.min(-c.paise(bill.due), c.paise(creditNote.total)));
        if (back > 0) {
          const how = body.refund && typeof body.refund === 'object' && !Array.isArray(body.refund) ? body.refund : {};
          if (!c.given(how.method) && !c.given(how.methodId)) {
            fail(`${c.rupees(back)} goes back to ${order.customer_name}: choose how (cash, card, UPI or bank)`, 400, { reason: 'refund_method', refund: c.rupees(back) });
          }
          refund = await returns.postRefund(db, business, user, doc, returns.readRefund({ amount: c.rupees(back), method: how.method, methodId: how.methodId, reason: words,
            requestKey: c.derivedKey(key, 'refund') }));
        }
      }
    }
    const decidedBy = approval?.approver.id || user.id;
    await db.query(`UPDATE laundry_claims SET decision=$3,amount=$4,decision_note=$5,decided_by=$6,decided_at=now(),decide_key=$7,decide_hash=$8,return_id=$9,refund_id=$10,refunded=$11
      WHERE business_id=$1 AND id=$2`, [business.id, claim.id, decision, amount === null ? null : c.rupees(amount), note, decidedBy, key, hash, creditNote?.id || null,
      refund?.id || null, refund ? refund.amount : null]);
    // Reprocessing: the garment goes back into the work.
    let movedTo = null;
    if (decision === 'reprocess') {
      if (['ready', 'qc', 'packed'].includes(item.status)) {
        await db.query(`UPDATE laundry_order_items SET status='in_process',rack=NULL,ready_at=NULL,ready_by=NULL,qc_at=NULL,qc_by=NULL,packed_at=NULL,packed_by=NULL
          WHERE business_id=$1 AND id=$2`, [business.id, item.id]);
        movedTo = 'in_process';
      } else if (item.status === 'delivered') {
        const newTag = tag || item.tag_no;
        const taken = await repo.one(db, `SELECT o.order_no FROM laundry_order_items i JOIN laundry_orders o ON o.business_id=i.business_id AND o.id=i.order_id
          WHERE i.business_id=$1 AND i.tag_no=$2 AND i.status IN ${c.OPEN_SQL} AND i.id<>$3`, [business.id, newTag, item.id]);
        if (taken) fail(`Tag ${newTag} is on a garment of order ${taken.order_no} now: give this garment a new tag`, 409, { reason: 'tag_taken' });
        await db.query(`UPDATE laundry_order_items SET status='received',tag_no=$3,rack=NULL,ready_at=NULL,ready_by=NULL,delivered_at=NULL,delivered_by=NULL,
          qc_at=NULL,qc_by=NULL,packed_at=NULL,packed_by=NULL,pieces_delivered=0 WHERE business_id=$1 AND id=$2`, [business.id, item.id, newTag]);
        movedTo = 'received';
      } else if (tag) {
        fail(`Garment ${item.tag_no} is still in the shop: it keeps its tag`);
      }
      if (movedTo) await orders.history(db, business, user, order, item, item.status, movedTo, `Back into the work for reprocessing (claim ${claim.id})`);
    }
    const words = { refund: 'money back', credit: 'a credit note', reprocess: 'reprocessed', rejected: 'rejected' };
    await orders.history(db, business, user, order, item, null, null, [`Claim ${claim.id} decided: ${words[decision]}`, creditNote ? `credit note ${creditNote.return_no}` : null,
      refund ? 'the money refunded' : null, note].filter(Boolean).join(' · '));
    const details = { orderNo: order.order_no, tag: item.tag_no, claimId: claim.id, decision, ...(amount !== null ? { amount: c.rupees(amount) } : {}),
      ...(creditNote ? { returnNo: creditNote.return_no, credit: creditNote.total } : {}), ...(refund ? { refund: refund.amount, refundMethod: refund.method } : {}),
      ...(note ? { note } : {}), ...(approval ? { approvedBy: approval.approver.name, requestedBy: user.id } : {}) };
    await repo.audit(db, business.id, decidedBy, 'laundry_claim.decided', claim.id, details);
    await repo.event(db, business.id, user.id, 'laundry_claim.decided', 'laundry_claim', claim.id, { orderId: order.id, itemId: item.id, decision,
      returnId: creditNote?.id || null, refundId: refund?.id || null, credit: creditNote?.total || null, refund: refund?.amount || null });
    return orders.shape(business, await orders.load(db, business, order.id));
  });
}

// The claims of a period (the days they were reported, on the business's
// clock), added up by service, by the person who took the garment in (the one
// who took the order in, or added the garment to it), or by month: how many,
// waiting, and decided each way, with the compensation given (the credit notes
// with their GST, and the money refunded of them) and what customers asked.
// Money only for someone who sees sales.
const BY = {
  service: 'i.service_name',
  staff: 'COALESCE(ab.name,cu.name)',
  month: "to_char(cl.reported_at AT TIME ZONE b.timezone,'YYYY-MM')",
};
async function report(business, query = {}) {
  c.requireLaundry(business);
  await access.require(business, 'laundry.view');
  const by = v.requiredEnum(query.by ?? 'service', 'Add up by', Object.keys(BY));
  const from = c.given(query.from) ? core.dateText(query.from, 'From date') : null;
  const to = c.given(query.to) ? core.dateText(query.to, 'To date') : null;
  if (from && to && to < from) fail('The end date is before the start date');
  const rows = await repo.all(repo.pool, `SELECT ${BY[by]} AS key,count(*)::int AS claims,count(*) FILTER (WHERE cl.decision IS NULL)::int AS waiting,
      count(*) FILTER (WHERE cl.decision='refund')::int AS refunds,count(*) FILTER (WHERE cl.decision='credit')::int AS credits,
      count(*) FILTER (WHERE cl.decision='reprocess')::int AS reprocessed,count(*) FILTER (WHERE cl.decision='rejected')::int AS rejected,
      COALESCE(sum(rt.total),0) AS compensation,COALESCE(sum(cl.refunded),0) AS refunded,COALESCE(sum(cl.asked_amount),0) AS asked
    FROM laundry_claims cl JOIN laundry_orders o ON o.business_id=cl.business_id AND o.id=cl.order_id
    JOIN laundry_order_items i ON i.business_id=cl.business_id AND i.id=cl.item_id JOIN businesses b ON b.id=cl.business_id
    JOIN users cu ON cu.id=o.created_by LEFT JOIN users ab ON ab.id=i.added_by
    LEFT JOIN business_returns rt ON rt.business_id=cl.business_id AND rt.id=cl.return_id
    WHERE cl.business_id=$1 AND ($2::date IS NULL OR (cl.reported_at AT TIME ZONE b.timezone)::date>=$2) AND ($3::date IS NULL OR (cl.reported_at AT TIME ZONE b.timezone)::date<=$3)
      AND ($4::bigint IS NULL OR o.location_id=$4)
    GROUP BY 1 ORDER BY ${by === 'month' ? '1' : 'claims DESC,1'}`, [business.id, from, to, business.location_scope || null]);
  const add = (key) => rows.reduce((sum, r) => sum + (['compensation', 'refunded', 'asked'].includes(key) ? c.paise(r[key]) : Number(r[key])), 0);
  const totals = { claims: add('claims'), waiting: add('waiting'), refunds: add('refunds'), credits: add('credits'), reprocessed: add('reprocessed'), rejected: add('rejected'),
    compensation: c.rupees(add('compensation')), refunded: c.rupees(add('refunded')), asked: c.rupees(add('asked')) };
  const money = c.seesMoney(business);
  const hide = (r) => (money ? r : { ...r, compensation: null, refunded: null, asked: null });
  return { by, from, to, money, rows: rows.map(hide), totals: hide(totals) };
}

module.exports = { record, decide, listShape, report };
