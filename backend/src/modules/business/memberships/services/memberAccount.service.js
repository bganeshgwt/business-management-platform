const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const c = require('./memberCommon');
const ms = require('./memberships.service');
const fees = require('./memberFees.service');
const changes = require('./memberChanges.service');

// What changes on a membership's account after its sale (module "member_plans"):
//
//   seats         who uses a shared membership's seats: a seat given to a
//                 member (made a member with a code) or given up.
//   add-ons       a locker (with its number), a towel, a diet plan or a
//                 personal-training pack sold after the plan, on its own bill;
//                 it ends with the membership.
//   instalments   a manager changes the schedule of a fee in instalments (due
//                 days and amounts) without changing its total; the old
//                 schedule is kept and the change audited.
//   late fee      an instalment overdue beyond the plan's days (its rule as
//                 sold, disclosed at the sale) takes the plan's late fee,
//                 billed when someone confirms it; once per instalment.
//   refunds due   money to go back on a day (a cancellation's refund paid
//                 later, or what a move to a cheaper plan leaves over): listed
//                 and on the bell until paid through the core's refund.

const { fail, id, paise, rupees } = c;

async function lockOpen(db, business, membershipId, what) {
  const { m, day } = await changes.lockMembership(db, business, membershipId);
  if (m.closed) fail(`Membership ${m.membership_no} was ${m.closed}: ${what}`, 409);
  return { m, day };
}

// --- Seats -----------------------------------------------------------------------------------------

// body: { contactId | member: { name, phone? } }
async function addSeat(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const newMember = c.given(body.contactId) ? null : ms.readNewMember(body.member);
  if (!c.given(body.contactId) && !newMember) fail('Choose the member who takes the seat, or type a new member\'s name');
  if (newMember) await access.require(business, 'contacts.create');
  return repo.transaction(async (db) => {
    const { m } = await lockOpen(db, business, membershipId, 'its seats no longer change');
    if (Number(m.seats) < 2) fail(`Membership ${m.membership_no} is for one member: it has no seats to share`, 409);
    const contact = newMember ? await core.createContact(business, user, newMember, db) : await ms.customer(db, business, id(body.contactId, 'Member'));
    if (await repo.one(db, 'SELECT 1 FROM member_seats WHERE business_id=$1 AND membership_id=$2 AND contact_id=$3 AND removed_at IS NULL', [business.id, m.id, contact.id])) {
      fail(`${contact.name} has a seat on ${m.membership_no} already`, 409);
    }
    await ms.ensureProfile(db, business, user, contact.id);
    await db.query('INSERT INTO member_seats(business_id,membership_id,contact_id,created_by) VALUES($1,$2,$3,$4)', [business.id, m.id, contact.id, user.id]);
    await ms.event(db, business, user, m.id, 'seat_added', `${contact.name} takes a seat`, { contactId: contact.id, member: contact.name });
    await repo.audit(db, business.id, user.id, 'membership.seat_added', m.id, { membershipNo: m.membership_no, member: contact.name });
    return ms.shape(business, await ms.load(db, business, m.id));
  });
}

async function removeSeat(business, user, membershipId, seatId) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  return repo.transaction(async (db) => {
    const { m } = await changes.lockMembership(db, business, membershipId);
    const seat = await repo.one(db, `SELECT s.*,ct.name FROM member_seats s JOIN business_contacts ct ON ct.business_id=s.business_id AND ct.id=s.contact_id
      WHERE s.business_id=$1 AND s.membership_id=$2 AND s.id=$3 FOR UPDATE OF s`, [business.id, m.id, id(seatId, 'Seat')]);
    if (!seat) fail('Seat not found', 404);
    if (seat.removed_at) return ms.shape(business, await ms.load(db, business, m.id));
    await db.query('UPDATE member_seats SET removed_at=now(),removed_by=$3 WHERE business_id=$1 AND id=$2', [business.id, seat.id, user.id]);
    await ms.event(db, business, user, m.id, 'seat_removed', `${seat.name} gives up a seat`, { contactId: seat.contact_id, member: seat.name });
    await repo.audit(db, business.id, user.id, 'membership.seat_removed', m.id, { membershipNo: m.membership_no, member: seat.name });
    return ms.shape(business, await ms.load(db, business, m.id));
  });
}

// --- Add-ons after the sale ---------------------------------------------------------------------------

// body: { requestKey, skuId, kind, lockerNo?, label?, payment? | payments? }
async function addAddon(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, membershipId: String(membershipId) });
  const [addon] = ms.readAddons([{ skuId: body.skuId, kind: body.kind, lockerNo: body.lockerNo, label: body.label }]);
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  return repo.transaction(async (db) => {
    const { m, day } = await lockOpen(db, business, membershipId, 'it takes no add-on');
    const old = await repo.one(db, 'SELECT id,request_hash,membership_id FROM member_addons WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || Number(old.membership_id) !== Number(m.id)) fail('This request key was already used for different data', 409);
      return ms.shape(business, await ms.load(db, business, m.id));
    }
    if (m.end_on && m.end_on < day) fail(`Membership ${m.membership_no} is over: an add-on goes with a running membership`, 409);
    access.requireLocation(business, m.location_id);
    await ms.addonItems(db, business, [addon]);
    const documentBody = { kind: 'sale', locationId: m.location_id, contactId: m.contact_id, lines: [{ skuId: addon.skuId, quantity: 1 }],
      notes: `${addon.label} with ${m.membership_no}, to ${m.end_on ? c.dateWords(m.end_on) : 'its end'}`.slice(0, 500) };
    const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(requestKey, 'bill'), hash: c.hashOf(documentBody),
      lines: documentBody.lines, paidNow: parts, membership: true });
    const line = await repo.one(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 AND sku_id=$3 ORDER BY id LIMIT 1', [business.id, document.id, addon.skuId]);
    await db.query(`INSERT INTO member_addons(business_id,membership_id,kind,sku_id,label,locker_no,document_id,line_id,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [business.id, m.id, addon.kind, addon.skuId, addon.label, addon.lockerNo, document.id, line.id, requestKey, hash, user.id]);
    await ms.event(db, business, user, m.id, 'addon', `${addon.label} on ${document.document_no}`, { label: addon.label, kind: addon.kind, documentNo: document.document_no, total: document.total });
    await repo.audit(db, business.id, user.id, 'membership.addon_sold', m.id, { membershipNo: m.membership_no, label: addon.label, documentNo: document.document_no, total: document.total });
    return ms.shape(business, await ms.load(db, business, m.id));
  });
}

// --- Instalments --------------------------------------------------------------------------------------

// body: { reason, instalments: [{ dueOn, amount }] } — a manager's change; the total stays.
async function changeInstalments(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.approve');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  const list = ms.readInstalments(body.instalments);
  if (!list) fail('Give the new schedule: two or more instalments');
  return repo.transaction(async (db) => {
    const { m } = await lockOpen(db, business, membershipId, 'its instalments no longer change');
    const current = await repo.all(db, 'SELECT seq,version,due_on::text AS due_on,amount FROM member_instalments WHERE business_id=$1 AND membership_id=$2 AND replaced_at IS NULL ORDER BY seq',
      [business.id, m.id]);
    if (!current.length) fail(`Membership ${m.membership_no} has no fee in instalments`, 409);
    const total = current.reduce((s, i) => s + paise(i.amount), 0);
    const sum = list.reduce((s, i) => s + i.amount, 0);
    if (sum !== total) fail(`The new instalments add up to ${rupees(sum)}: they keep the total of ${rupees(total)}`, 409, { reason: 'instalments_total', total: rupees(total) });
    const sold = (await repo.one(db, 'SELECT (m.created_at AT TIME ZONE b.timezone)::date::text AS day FROM member_memberships m JOIN businesses b ON b.id=m.business_id WHERE m.id=$1', [m.id])).day;
    if (list[0].dueOn < sold) fail('An instalment falls due on or after the day the membership was sold');
    const same = list.length === current.length && list.every((x, i) => x.dueOn === current[i].due_on && x.amount === paise(current[i].amount));
    if (same) return ms.shape(business, await ms.load(db, business, m.id));
    const version = Number(current[0].version) + 1;
    await db.query('UPDATE member_instalments SET replaced_at=now(),replaced_by=$3 WHERE business_id=$1 AND membership_id=$2 AND replaced_at IS NULL', [business.id, m.id, user.id]);
    for (const [i, x] of list.entries()) {
      await db.query('INSERT INTO member_instalments(business_id,membership_id,version,seq,due_on,amount,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [business.id, m.id, version, i + 1, x.dueOn, rupees(x.amount), reason, user.id]);
    }
    const from = current.map((i) => ({ dueOn: i.due_on, amount: i.amount }));
    const to = list.map((x) => ({ dueOn: x.dueOn, amount: rupees(x.amount) }));
    await ms.event(db, business, user, m.id, 'instalments_changed', `Instalments changed: ${reason}`, { version, from, to });
    await repo.audit(db, business.id, user.id, 'membership.instalments_changed', m.id, { membershipNo: m.membership_no, reason, version, from, to });
    return ms.shape(business, await ms.load(db, business, m.id));
  });
}

// body: { requestKey, seq, payment? | payments? } — the plan's late fee on an overdue instalment.
async function lateFee(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const seq = Number(core.decimal(body.seq, 'Instalment', 0, 1, 36));
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  return repo.transaction(async (db) => {
    const { m, day } = await changes.lockMembership(db, business, membershipId);
    if (m.closed && m.closed !== 'transferred') fail(`Membership ${m.membership_no} was ${m.closed}: its instalments no longer fall due`, 409);
    const instalment = (await ms.instalmentsOf(db, business, m, day)).find((i) => i.seq === seq);
    if (!instalment) fail('Instalment not found', 404);
    const billed = await repo.one(db, `SELECT d.request_key FROM member_fees f JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
      WHERE f.business_id=$1 AND f.membership_id=$2 AND f.kind='late' AND f.instalment_due_on=$3::date`, [business.id, m.id, instalment.due_on]);
    if (billed) {
      if (billed.request_key !== c.derivedKey(requestKey, 'fee-late')) fail(`The late fee of instalment ${seq} is billed already`, 409);
      return ms.shape(business, await ms.load(db, business, m.id));
    }
    if (!(paise(m.late_fee) > 0)) fail(`${m.plan_name} takes no late fee: none was disclosed when it was sold`, 409);
    if (instalment.status !== 'overdue') fail(`Instalment ${seq} is not overdue`, 409);
    if (instalment.days_overdue <= Number(m.late_fee_after_days)) {
      fail(`The late fee is due when an instalment is more than ${m.late_fee_after_days} days overdue: instalment ${seq} is ${instalment.days_overdue}`, 409);
    }
    access.requireLocation(business, m.location_id);
    await fees.bill(db, business, user, m, { kind: 'late', amount: paise(m.late_fee), label: `instalment ${seq} of ${m.membership_no}, due ${c.dateWords(instalment.due_on)}`,
      requestKey, paidNow: parts, extra: { instalmentDueOn: instalment.due_on, instalmentSeq: seq } });
    return ms.shape(business, await ms.load(db, business, m.id));
  });
}

// --- Refunds due ---------------------------------------------------------------------------------------

const REFUNDS_SQL = `SELECT r.id,r.membership_id,m.membership_no,m.plan_name,m.contact_id,ct.name AS member_name,ct.phone AS member_phone,pr.member_code,r.kind,r.amount,
    r.due_on,r.document_id,d.document_no,r.refund_id,r.paid_at,(r.refund_id IS NULL) AS open,(r.refund_id IS NULL AND r.due_on<=t.today) AS due_now,m.location_id,
    ap.name AS approved_by_name,r.created_at
  FROM member_refunds r JOIN member_memberships m ON m.business_id=r.business_id AND m.id=r.membership_id
  JOIN businesses b ON b.id=r.business_id CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE b.timezone)::date AS today) t
  JOIN business_contacts ct ON ct.business_id=m.business_id AND ct.id=m.contact_id LEFT JOIN member_profiles pr ON pr.business_id=m.business_id AND pr.contact_id=m.contact_id
  JOIN business_documents d ON d.business_id=r.business_id AND d.id=r.document_id LEFT JOIN users ap ON ap.id=r.approved_by
  WHERE r.business_id=$1`;
repo.addLists({
  'member-refunds': { sql: `SELECT * FROM (${REFUNDS_SQL}) x`, search: ['member_name', 'member_phone', 'member_code', 'membership_no', 'document_no'],
    filters: { open: 'open', due: 'due_now', contact: 'contact_id', membership: 'membership_id' }, order: 'open DESC, due_on, id' },
});

// body: { method | methodId } — a refund due paid now, through the core's refund on its bill.
async function payRefund(business, user, refundId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.refund');
  return repo.transaction(async (db) => {
    const found = await repo.one(db, 'SELECT membership_id FROM member_refunds WHERE business_id=$1 AND id=$2', [business.id, id(refundId, 'Refund')]);
    if (!found) fail('Refund not found', 404);
    const { m } = await changes.lockMembership(db, business, found.membership_id);
    const row = await repo.one(db, 'SELECT * FROM member_refunds WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, refundId]);
    access.requireLocation(business, m.location_id);
    if (row.refund_id) return repo.one(db, `${REFUNDS_SQL} AND r.id=$2`, [business.id, row.id]);
    const how = body && typeof body === 'object' ? body : {};
    if (!c.given(how.method) && !c.given(how.methodId)) fail('Choose how the money goes back (cash, card, UPI or bank)', 400, { reason: 'refund_method' });
    const left = await changes.creditLeft(db, business, row.document_id);
    if (left < paise(row.amount)) fail(`Only ${rupees(Math.max(0, left))} is left to give back on the bill`, 409);
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2', [business.id, row.document_id]);
    const input = returns.readRefund({ amount: row.amount, method: how.method, methodId: how.methodId, reason: `Refund due on membership ${m.membership_no}`,
      requestKey: c.derivedKey(String(row.request_key), 'pay') });
    const refund = await returns.postRefund(db, business, user, doc, input);
    await db.query('UPDATE member_refunds SET refund_id=$3,paid_by=$4,paid_at=now() WHERE business_id=$1 AND id=$2', [business.id, row.id, refund.id, user.id]);
    await ms.event(db, business, user, m.id, 'refund_paid', `${refund.amount} refunded (due ${c.dateWords(row.due_on)})`, { amount: refund.amount, method: refund.method, refundId: refund.id });
    await repo.audit(db, business.id, user.id, 'membership.refund_paid', m.id, { membershipNo: m.membership_no, amount: refund.amount, method: refund.method, dueOn: row.due_on });
    return repo.one(db, `${REFUNDS_SQL} AND r.id=$2`, [business.id, row.id]);
  });
}

module.exports = { addSeat, removeSeat, addAddon, changeInstalments, lateFee, payRefund, REFUNDS_SQL };
