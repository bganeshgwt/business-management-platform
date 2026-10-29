const repo = require('../../core/repositories/business.repository');
const core = require('../../core/services/business.service');
const c = require('./memberCommon');

// A fee billed on a membership (module "member_plans"): a freeze, a transfer,
// an instalment paid late, a class's late cancel or no-show. Each is its own
// bill, posted by the core to the member, on the plan's own service item
// with the fee's words: so it is a service at the plan's slab and SAC. The
// fee is typed as the business's prices are (with or without GST, as its
// settings say); what is not paid now stays on the member's dues. Billed
// inside the caller's transaction, once per request key.

const { rupees } = c;
const WORDS = { freeze: 'Freeze fee', transfer: 'Transfer fee', late: 'Late fee', late_cancel: 'Late cancel fee', no_show: 'No-show fee' };

// m: the membership row; amount: paise; label: the bill line's words; extra: { instalmentDueOn, instalmentSeq, bookingId }.
async function bill(db, business, user, m, { kind, amount, label, requestKey, paidNow = [], extra = {} }) {
  const item = await repo.one(db, `SELECT s.id,s.tax_rate FROM member_plan_types p JOIN catalog_skus s ON s.business_id=p.business_id AND s.id=p.price_sku_id
    WHERE p.business_id=$1 AND p.id=$2`, [business.id, m.plan_id]);
  const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
  const inclusive = settings?.tax_mode === 'inclusive';
  const net = inclusive ? core.inclusiveNet(amount, Number(item.tax_rate)) : amount;
  const tax = inclusive ? amount - net : core.lineTax(amount, Number(item.tax_rate));
  const words = `${WORDS[kind]} · ${label}`.slice(0, 150);
  const documentBody = { kind: 'sale', locationId: m.location_id, contactId: m.contact_id, lines: [{ skuId: item.id, quantity: 1 }], notes: `${words} (${m.membership_no})`.slice(0, 500) };
  const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, `fee-${kind}`), hash: c.hashOf(documentBody),
    lines: documentBody.lines, paidNow, membership: true,
    fixed: [{ price: Number(rupees(amount)), net, tax, priceRuleId: null, enteredPrice: null, label: words }] });
  const fee = await repo.one(db, `INSERT INTO member_fees(business_id,membership_id,kind,instalment_due_on,instalment_seq,booking_id,amount,document_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (business_id,document_id) DO NOTHING RETURNING *`,
  [business.id, m.id, kind, extra.instalmentDueOn || null, extra.instalmentSeq || null, extra.bookingId || null, document.total, document.id, user.id]);
  if (fee) {
    await repo.audit(db, business.id, user.id, 'membership.fee_billed', m.id, { membershipNo: m.membership_no, kind, documentNo: document.document_no, total: document.total });
    await db.query('INSERT INTO member_events(business_id,membership_id,kind,note,details,created_by) VALUES($1,$2,$3,$4,$5,$6)',
      [business.id, m.id, 'fee', `${words}: ${document.document_no}`.slice(0, 500), JSON.stringify({ kind, documentNo: document.document_no, total: document.total }), user.id]);
  }
  return document;
}

module.exports = { bill, WORDS };
