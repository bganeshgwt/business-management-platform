const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const returns = require('../../core/services/businessReturns.service');
const c = require('./memberCommon');
const ms = require('./memberships.service');
const quotes = () => require('../../quotations/services/businessQuotations.service');
// A manager's say-so with their PIN (shared with the salon, repairs and garages).
const pins = () => require('../../salon-weight/services/businessManagerPin');

// Changes to a running membership (module "member_plans"):
//
//   freeze     from a day (today or later) for some days, within the plan's
//              limits as sold; its last day moves on by the frozen days. Ended
//              early when the member comes back (or called off before it
//              begins), which gives the days back.
//   transfer   what is left of it (its days or sessions, its freezes left) to
//              another member, when its plan allows it and its bill is paid;
//              it is closed as transferred and the other member's membership
//              carries on from today on the same bill.
//   upgrade    to another plan from today: the part not used (by days, or by
//              sessions for a pack, the smaller for a pack with a time) comes
//              back as a credit note on its bill, and what the member paid
//              beyond what is now due on it pays the new plan's bill first.
//   cancel     with a reason; the part not used may come back (a credit note
//              on its bill, at most that pro-rata part, and the joining fee if
//              chosen) with a manager's approval and PIN, and what the member
//              paid beyond what is now due goes back to them (the core's
//              refund). Nothing comes back from a membership passed on by
//              another member: its bill is theirs.
// The days used are counted from the first day to the last day counted (the
// day of cancelling; for an upgrade the day before, as the new plan starts
// today), less the days frozen. Money is integer paise. A preview runs the
// change and rolls it back, so its figures are those the change would make.

const { fail, id, paise, rupees } = c;
const MAX_FREEZE_AHEAD = 60;

// Marker that rolls a preview back with its figures.
class Preview { constructor(result) { this.result = result; } }
async function previewOf(work) {
  try {
    await repo.transaction(work);
  } catch (error) {
    if (error instanceof Preview) return error.result;
    throw error;
  }
  throw new Error('A preview did not finish');
}

// The membership, locked, with its status today and its freezes.
async function lockMembership(db, business, membershipId) {
  // Same lock order as every posting: the business, then the record.
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const day = await c.today(db, business);
  const m = await repo.one(db, `SELECT m.*,${c.STATUS_SQL('m', '$3::date')} AS status,ct.name AS member_name FROM member_memberships m
    JOIN business_contacts ct ON ct.business_id=m.business_id AND ct.id=m.contact_id WHERE m.business_id=$1 AND m.id=$2 FOR UPDATE OF m`,
  [business.id, id(membershipId, 'Membership'), day]);
  if (!m) fail('Membership not found', 404);
  const freezes = await repo.all(db, 'SELECT id,starts_on::text AS starts_on,planned_days,days,ended_on::text AS ended_on FROM member_freezes WHERE business_id=$1 AND membership_id=$2 ORDER BY starts_on,id',
    [business.id, m.id]);
  return { m, freezes, day };
}
const statusWords = (m) => c.STATUS_WORDS[m.status] || m.status;
function requireRunning(m, what) {
  if (m.closed) fail(`Membership ${m.membership_no} was ${m.closed}`, 409);
  if (!c.RUNNING.includes(m.status)) fail(`Membership ${m.membership_no} is ${statusWords(m)}: it is not ${what}`, 409);
}
// The bill a membership was sold on, locked, with what is still due on it.
async function lockBill(db, business, documentId) {
  const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, documentId]);
  const sums = await repo.one(db, `SELECT
    COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id=$1 AND document_id=$2),0) AS paid,
    COALESCE((SELECT sum(total) FROM business_returns WHERE business_id=$1 AND document_id=$2),0) AS returned,
    COALESCE((SELECT sum(amount) FROM business_refunds WHERE business_id=$1 AND document_id=$2),0) AS refunded`, [business.id, doc.id]);
  const due = paise(doc.total) - paise(sums.returned) - paise(sums.paid) + paise(sums.refunded);
  return { doc, due, paid: paise(sums.paid) - paise(sums.refunded) };
}
// What the member has paid on a bill beyond what is now due on it (paise).
async function creditLeft(db, business, documentId) {
  return -(await lockBill(db, business, documentId)).due;
}
const memberWords = (m) => `${m.member_name}'s membership ${m.membership_no}`;

// --- Freezes -----------------------------------------------------------------------------------------

// body: { requestKey, startsOn? (today), days, reason? }
async function freeze(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, membershipId: String(membershipId) });
  const reason = c.optionalText(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const { m, freezes, day } = await lockMembership(db, business, membershipId);
    const old = await repo.one(db, 'SELECT id,request_hash,membership_id FROM member_freezes WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || Number(old.membership_id) !== Number(m.id)) fail('This request key was already used for different data', 409);
      return ms.shape(business, await ms.load(db, business, m.id));
    }
    requireRunning(m, 'frozen');
    if (!m.end_on) fail(`Membership ${m.membership_no} is a pack of sessions with no end date: it is not frozen`, 409);
    if (Number(m.max_freezes) === 0) fail(`${m.plan_name} is not frozen: its plan allows no freezes`, 409);
    const renewal = await repo.one(db, 'SELECT membership_no,start_on::text AS start_on FROM member_memberships WHERE business_id=$1 AND renewal_of=$2 AND closed IS NULL', [business.id, m.id]);
    if (renewal) fail(`Membership ${m.membership_no} is followed by its renewal ${renewal.membership_no} from ${c.dateWords(renewal.start_on)}: it is not frozen any more`, 409);
    const startsOn = c.given(body.startsOn) ? c.readDate(body.startsOn, 'Frozen from') : day;
    if (startsOn < day) fail('A freeze starts today or later');
    if (startsOn > c.addDays(day, MAX_FREEZE_AHEAD)) fail(`A freeze starts within ${MAX_FREEZE_AHEAD} days`);
    const taken = freezes.filter((f) => Number(f.days) > 0);
    const daysLeft = Number(m.max_freeze_days) - taken.reduce((s, f) => s + Number(f.days), 0);
    if (taken.length >= Number(m.max_freezes)) fail(`Membership ${m.membership_no} has had the ${m.max_freezes} freeze${Number(m.max_freezes) === 1 ? '' : 's'} its plan allows`, 409);
    if (daysLeft <= 0) fail(`Membership ${m.membership_no} has been frozen for all the ${m.max_freeze_days} days its plan allows`, 409);
    const days = Number(core.decimal(body.days, 'Days frozen', 0, 1, 365));
    if (days > daysLeft) fail(`Membership ${m.membership_no} can be frozen for ${daysLeft} more day${daysLeft === 1 ? '' : 's'} at most`);
    const row = await repo.one(db, `INSERT INTO member_freezes(business_id,membership_id,starts_on,planned_days,days,reason,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8) RETURNING *`, [business.id, m.id, startsOn, days, reason, requestKey, hash, user.id]);
    const after = await repo.one(db, 'SELECT end_on::text AS end_on FROM member_memberships WHERE business_id=$1 AND id=$2', [business.id, m.id]);
    const until = c.addDays(startsOn, days - 1);
    await ms.event(db, business, user, m.id, 'frozen', `Frozen from ${c.dateWords(startsOn)} to ${c.dateWords(until)}${reason ? ` · ${reason}` : ''}`,
      { startsOn, days, until, endOnBefore: m.end_on, endOn: after.end_on });
    await repo.audit(db, business.id, user.id, 'membership.frozen', m.id, { membershipNo: m.membership_no, startsOn, days, endOn: after.end_on, ...(reason ? { reason } : {}) });
    await repo.event(db, business.id, user.id, 'membership.frozen', 'membership', m.id, { membershipNo: m.membership_no, contactId: m.contact_id, freezeId: row.id, startsOn, days, endOn: after.end_on });
    return ms.shape(business, await ms.load(db, business, m.id));
  });
}

// The member is back: the freeze in progress ends today (it counts the days
// up to today), or one still to come is called off. body: { freezeId? }
async function unfreeze(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  return repo.transaction(async (db) => {
    const { m, freezes, day } = await lockMembership(db, business, membershipId);
    if (m.closed) fail(`Membership ${m.membership_no} was ${m.closed}`, 409);
    const open = freezes.filter((f) => !f.ended_on && Number(f.days) > 0 && c.addDays(f.starts_on, Number(f.days) - 1) >= day);
    const freezeRow = c.given(body.freezeId) ? freezes.find((f) => Number(f.id) === Number(body.freezeId)) : open[0];
    if (!freezeRow) {
      if (c.given(body.freezeId)) fail('Freeze not found', 404);
      fail(`Membership ${m.membership_no} is not frozen and has no freeze to come`, 409);
    }
    // Asking again is the same: the freeze has ended.
    if (freezeRow.ended_on) return ms.shape(business, await ms.load(db, business, m.id));
    if (c.addDays(freezeRow.starts_on, Number(freezeRow.days) - 1) < day) fail('That freeze is already over', 409);
    const days = Math.max(0, c.daysBetween(freezeRow.starts_on, day));
    await db.query('UPDATE member_freezes SET ended_on=$3,days=$4,ended_by=$5,ended_at=now() WHERE business_id=$1 AND id=$2', [business.id, freezeRow.id, day, days, user.id]);
    const after = await repo.one(db, 'SELECT end_on::text AS end_on FROM member_memberships WHERE business_id=$1 AND id=$2', [business.id, m.id]);
    const calledOff = days === 0;
    await ms.event(db, business, user, m.id, 'freeze_ended', calledOff ? `Freeze from ${c.dateWords(freezeRow.starts_on)} called off`
      : `Back on ${c.dateWords(day)}: frozen for ${days} day${days === 1 ? '' : 's'} of the ${freezeRow.planned_days} planned`,
    { freezeId: freezeRow.id, startsOn: freezeRow.starts_on, plannedDays: freezeRow.planned_days, days, endOnBefore: m.end_on, endOn: after.end_on });
    await repo.audit(db, business.id, user.id, 'membership.unfrozen', m.id, { membershipNo: m.membership_no, freezeId: freezeRow.id, days, plannedDays: freezeRow.planned_days, endOn: after.end_on });
    await repo.event(db, business.id, user.id, 'membership.unfrozen', 'membership', m.id, { membershipNo: m.membership_no, contactId: m.contact_id, freezeId: freezeRow.id, days, endOn: after.end_on });
    return ms.shape(business, await ms.load(db, business, m.id));
  });
}

// --- Transfer -----------------------------------------------------------------------------------------

// body: { requestKey, toContactId | toMember: { name, phone?, email? }, reason? }
async function transfer(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, membershipId: String(membershipId) });
  const toContactId = c.given(body.toContactId) ? id(body.toContactId, 'Member it goes to') : null;
  const newMember = body.toMember && typeof body.toMember === 'object' && !Array.isArray(body.toMember) ? { kind: 'customer', name: body.toMember.name, phone: body.toMember.phone, email: body.toMember.email } : null;
  if (!toContactId && !newMember) fail('Choose the member it goes to, or type the new member\'s name and phone');
  if (toContactId && newMember) fail('Choose the member it goes to or type a new one, not both');
  if (newMember) await access.require(business, 'contacts.create');
  const reason = c.optionalText(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const { m, freezes, day } = await lockMembership(db, business, membershipId);
    const done = await repo.one(db, 'SELECT id,request_hash FROM member_memberships WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return ms.shape(business, await ms.load(db, business, done.id));
    }
    if (!m.transferable) fail(`${m.plan_name} memberships are not passed on to another member`, 409);
    if (m.status === 'frozen') fail(`Membership ${m.membership_no} is frozen today: end the freeze first`, 409);
    requireRunning(m, 'passed on');
    if (freezes.some((f) => !f.ended_on && f.starts_on > day)) fail(`Membership ${m.membership_no} has a freeze to come: call it off first`, 409);
    const bill = await lockBill(db, business, m.document_id);
    if (bill.due > 0) fail(`${rupees(bill.due)} is still to pay on ${bill.doc.document_no}, the bill of ${m.membership_no}: collect it before passing the membership on`, 409);
    const to = toContactId ? await ms.customer(db, business, toContactId) : await core.createContact(business, user, newMember, db);
    if (Number(to.id) === Number(m.contact_id)) fail('A membership is passed on to another member', 409);
    const start = m.start_on > day ? m.start_on : day;
    if (m.end_on) {
      const clash = await repo.one(db, `SELECT membership_no FROM member_memberships WHERE business_id=$1 AND contact_id=$2 AND plan_id=$3 AND closed IS NULL AND end_on IS NOT NULL
        AND start_on<=$5::date AND end_on>=$4::date LIMIT 1`, [business.id, to.id, m.plan_id, start, m.end_on]);
      if (clash) fail(`${to.name} already has ${m.plan_name} for some of those days (${clash.membership_no})`, 409);
    }
    // What is left: its days to its last day, its sessions, its freezes.
    const taken = freezes.filter((f) => Number(f.days) > 0);
    const freezeDaysLeft = Math.max(0, Number(m.max_freeze_days) - taken.reduce((s, f) => s + Number(f.days), 0));
    const freezesLeft = freezeDaysLeft === 0 ? 0 : Math.max(0, Number(m.max_freezes) - taken.length);
    const closedOn = c.addDays(start, -1);
    await db.query(`UPDATE member_memberships SET closed='transferred',closed_on=$3,close_reason=$4,closed_by=$5,closed_at=now(),close_key=$6,close_hash=$7,updated_by=$5,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, m.id, closedOn, reason || `Passed on to ${to.name}`, user.id, requestKey, hash]);
    await ms.ensureProfile(db, business, user, to.id);
    const plan = { id: m.plan_id, name: m.plan_name, kind: m.kind, duration_unit: m.duration_unit, duration: m.duration, grace_days: m.grace_days, transferable: m.transferable };
    const next = await ms.insertMembership(db, business, user, {
      locationId: m.location_id, contactId: to.id, plan, sessionsTotal: m.sessions_total === null ? null : Number(m.sessions_total) - Number(m.sessions_used),
      net: paise(m.price_net), tax: paise(m.price_tax), taxRate: m.tax_rate, joiningFee: 0, policyVersion: m.policy_version,
      maxFreezeDays: freezesLeft ? freezeDaysLeft : 0, maxFreezes: freezesLeft, start, end: m.end_on, transferredFrom: m.id, documentId: m.document_id, lineId: m.line_id,
      notes: reason, requestKey, hash,
    });
    const details = { from: m.membership_no, to: next.membership_no, fromMember: m.member_name, toMember: to.name, startOn: start, endOn: m.end_on,
      sessionsLeft: next.sessions_total, freezesLeft, freezeDaysLeft: freezesLeft ? freezeDaysLeft : 0 };
    await ms.event(db, business, user, m.id, 'transferred', `Passed on to ${to.name} (${next.membership_no})${reason ? ` · ${reason}` : ''}`, details);
    await ms.event(db, business, user, next.id, 'transfer', `Passed on by ${m.member_name} (${m.membership_no})`, details);
    await repo.audit(db, business.id, user.id, 'membership.transferred', m.id, { ...details, ...(reason ? { reason } : {}) });
    await repo.event(db, business.id, user.id, 'membership.transferred', 'membership', m.id, { ...details, fromContactId: m.contact_id, toContactId: to.id, membershipId: next.id });
    return ms.shape(business, await ms.load(db, business, next.id));
  });
}

// --- Upgrade --------------------------------------------------------------------------------------------

// The day an upgrade's old membership counts to: yesterday (the new plan
// starts today), or the day before it began when it has not begun.
const upgradeLastDay = (m, day) => (m.start_on < day ? c.addDays(day, -1) : c.addDays(m.start_on, -1));

// body: { requestKey, locationId?, planId, discount?, payment? | payments?, instalments?, notes?, buyer? }
async function runUpgrade(db, business, user, membershipId, body, { quote }) {
  // A preview takes keys of its own: those of the real upgrade may be taken already.
  const requestKey = quote ? crypto.randomUUID() : core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, membershipId: String(membershipId) });
  const { m, freezes, day } = await lockMembership(db, business, membershipId);
  if (!quote) {
    const done = await repo.one(db, 'SELECT id,request_hash FROM member_memberships WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return { membershipId: done.id };
    }
  }
  requireRunning(m, 'upgraded');
  if (m.transferred_from) fail(`Membership ${m.membership_no} was passed on by another member, on their bill: it is not upgraded. Renew it, or sell a new plan.`, 409);
  const plan = await ms.planFor(db, business, id(body.planId, 'New plan'));
  if (Number(plan.id) === Number(m.plan_id)) fail(`Membership ${m.membership_no} is already ${plan.name}: renew it instead`, 409);
  const locationId = c.given(body.locationId) ? id(body.locationId, 'Location') : m.location_id;
  access.requireLocation(business, locationId);
  access.requireLocation(business, m.location_id);
  const contact = await ms.customer(db, business, m.contact_id);
  const lastDay = upgradeLastDay(m, day);
  const share = c.unusedShare(m, freezes, lastDay);
  const credit = c.shareOf(paise(m.price), share);
  const instalments = ms.readInstalments(body.instalments);
  const discount = quotes().readDiscount(body);
  // The old membership closes first: its credit note is the upgrade's own.
  const creditKey = credit > 0 ? c.derivedKey(requestKey, 'credit') : null;
  await db.query(`UPDATE member_memberships SET closed='upgraded',closed_on=$3,close_reason=$4,closed_by=$5,closed_at=now(),close_key=$6,close_hash=$7,credit_key=$8,updated_by=$5,updated_at=now()
    WHERE business_id=$1 AND id=$2`, [business.id, m.id, lastDay, `Upgraded to ${plan.name}`, user.id, requestKey, hash, creditKey]);
  let creditNote = null;
  const bill = await lockBill(db, business, m.document_id);
  if (credit > 0) {
    const returnBody = { reason: `Upgraded to ${plan.name}: the unused part of ${m.membership_no}`, lines: [{ lineId: m.line_id }], credit };
    creditNote = await returns.postReturn(db, business, user, bill.doc, { reason: returnBody.reason.slice(0, 300), requestKey: creditKey, hash: c.hashOf(returnBody),
      lines: [{ lineId: m.line_id }], values: new Map([[Number(m.line_id), credit]]) });
  }
  const available = Math.max(0, await creditLeft(db, business, m.document_id));
  // The new plan from today, priced as a sale of it now.
  const sale = await ms.prepare(db, business, user, { planId: plan.id, startOn: day, renewalOf: null, joiningFee: body.joiningFee === true, discount, instalments }, { day, contact });
  const quoted = await quotes().priceIn(db, business, user, { locationId, contact, lines: sale.lines, discount });
  const newTotal = paise(quoted.total);
  if (available > newTotal) {
    fail(`The credit of ${rupees(available)} is more than the ${rupees(newTotal)} bill of ${plan.name}. An upgrade is to a plan that costs at least the credit; to move to a cheaper plan, cancel this membership with its refund and sell the new one.`,
      409, { reason: 'credit_exceeds_plan', credit: rupees(available), newTotal: rupees(newTotal) });
  }
  const applied = available;
  const due = newTotal - applied;
  const figures = { membershipNo: m.membership_no, lastDay, used: share.used, left: share.left, whole: share.whole, by: share.by, price: m.price, credit: rupees(credit),
    creditNote: creditNote ? creditNote.total : '0.00', paidBefore: rupees(bill.paid), dueBefore: rupees(Math.max(0, bill.due)), creditApplied: rupees(applied),
    plan: plan.name, startOn: sale.start, endOn: sale.end, sessions: plan.sessions, newSubtotal: quoted.subtotal, newTax: quoted.tax, newRoundOff: quoted.roundOff,
    newTotal: quoted.total, due: rupees(due), newLines: quoted.lines };
  if (quote) throw new Preview(figures);
  // What is paid now goes after the credit; "full" is what is left.
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((s, p) => s + paise(p.amount), 0);
  if (fixedPaid > due) fail(`Only ${rupees(due)} is left to pay after the credit`);
  const paidNow = parts.map((p) => (p.amount === 'full' ? { ...p, amount: Number(rupees(due - fixedPaid)) } : p)).filter((p) => paise(p.amount) > 0);
  const { membership: next, document } = await ms.postSale(db, business, user, sale, { contact, locationId, requestKey, hash, paidNow, discount, instalments,
    notes: [`Upgrade of ${m.membership_no}`, c.optionalText(body.notes, 'Notes', 300)].filter(Boolean).join(' · '), buyer: body.buyer, upgradedFrom: m.id, kind: 'upgrade', day,
    note: `Upgrade of ${m.membership_no} (${m.plan_name})${applied > 0 ? `, ${rupees(applied)} of its credit taken off` : ''}` });
  if (paise(document.total) !== newTotal) fail(`The bill would come to ${document.total}, not the ${rupees(newTotal)} worked out for the upgrade. Try again.`, 409);
  if (applied > 0) await moveCredit(db, business, user, { from: bill.doc, to: document, amount: applied, note: creditNote, requestKey, what: `upgrade to ${next.membership_no}` });
  if (creditNote) {
    await db.query('UPDATE member_memberships SET return_id=$3,credit=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, m.id, creditNote.id, creditNote.total]);
  }
  const { newLines: _lines, ...said } = figures;
  const details = { ...said, newMembershipNo: next.membership_no, newDocumentNo: document.document_no, returnNo: creditNote?.return_no || null };
  await ms.event(db, business, user, m.id, 'upgraded', `Upgraded to ${plan.name} (${next.membership_no})${creditNote ? ` · credit note ${creditNote.return_no}` : ''}`, details);
  await repo.audit(db, business.id, user.id, 'membership.upgraded', m.id, details);
  await repo.event(db, business.id, user.id, 'membership.upgraded', 'membership', m.id, { membershipNo: m.membership_no, contactId: m.contact_id, membershipId: next.id,
    newMembershipNo: next.membership_no, documentId: document.id, returnId: creditNote?.id || null, credit: rupees(credit), creditApplied: rupees(applied) });
  return { membershipId: next.id };
}
// The credit a credit note left on one bill pays another of the same member:
// a refund on the first and a payment on the second, both by credit note, so
// no money moves (as an exchange does it).
async function moveCredit(db, business, user, { from, to, amount, note, requestKey, what }) {
  const out = await repo.one(db, `INSERT INTO business_refunds(business_id,document_id,amount,method,reason,request_key,created_by)
    VALUES($1,$2,$3,'credit_note',$4,$5,$6) RETURNING *`, [business.id, from.id, rupees(amount),
    `Credit${note ? ` note ${note.return_no}` : ''} used on ${to.document_no} (${what})`.slice(0, 300), c.derivedKey(requestKey, 'credit-out'), user.id]);
  await repo.audit(db, business.id, user.id, 'sale.refunded', out.id, { documentId: from.id, amount: out.amount, method: 'credit_note' });
  await repo.event(db, business.id, user.id, 'sale.refunded', 'refund', out.id, { documentId: from.id, documentNo: from.document_no, amount: out.amount, method: 'credit_note' });
  await core.recordPayment(db, business, user, to, { amount: rupees(amount), method: 'credit_note', reference: note?.return_no || from.document_no, key: c.derivedKey(requestKey, 'credit-in') });
}

async function upgradePreview(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  return previewOf((db) => runUpgrade(db, business, user, membershipId, body, { quote: true }));
}
async function upgrade(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  await access.require(business, 'sales.create');
  return repo.transaction(async (db) => {
    const { membershipId: next } = await runUpgrade(db, business, user, membershipId, body, { quote: false });
    return ms.shape(business, await ms.load(db, business, next));
  });
}

// --- Cancel --------------------------------------------------------------------------------------------

// The day a cancelled membership counts to: today, or the day before it began
// when it has not begun.
const cancelLastDay = (m, day) => (m.start_on <= day ? day : c.addDays(m.start_on, -1));

// body: { requestKey, reason, credit? (the plan's part given back; at most
//   the pro-rata part, which is the default), joiningFee? (give the joining fee
//   back too), refund?: { method | methodId, reference? } (how money goes back),
//   approval?: { approverId?, pin? } (a manager's PIN when anything comes back) }
async function runCancel(db, business, user, membershipId, body, { quote, approval }) {
  const requestKey = quote ? null : core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, approval: undefined, membershipId: String(membershipId) });
  const reason = quote ? (c.optionalText(body.reason, 'Reason', 300) || 'Cancelled') : v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  const { m, freezes, day } = await lockMembership(db, business, membershipId);
  if (!quote && m.closed === 'cancelled' && m.close_key === requestKey) {
    if (m.close_hash !== hash) fail('This request key was already used for different data', 409);
    return { membershipId: m.id };
  }
  requireRunning(m, 'cancelled');
  const lastDay = cancelLastDay(m, day);
  const share = c.unusedShare(m, freezes, lastDay);
  const transferred = Boolean(m.transferred_from);
  const most = transferred ? 0 : c.shareOf(paise(m.price), share);
  const planCredit = c.given(body.credit) ? paise(core.decimal(body.credit, 'Given back for the plan', 2, 0, 100000000)) : most;
  if (planCredit > most) fail(transferred ? `Membership ${m.membership_no} was passed on by another member, on their bill: nothing comes back from it` : `At most ${rupees(most)} of the plan comes back: the part not used`);
  const joining = body.joiningFee === true;
  if (joining && (transferred || !m.joining_line_id)) fail(`Membership ${m.membership_no} has no joining fee to give back`);
  const joiningCredit = joining ? paise(m.joining_fee) : 0;
  const giving = planCredit + joiningCredit;
  if (!quote && giving > 0) {
    await access.require(business, 'member_plans.refund');
    if (!approval) fail('A manager approves what a cancelled membership gives back, with their PIN', 400, { reason: 'approval_needed' });
  }
  if (giving > 0) access.requireLocation(business, m.location_id);
  const creditKey = giving > 0 ? (quote ? c.derivedKey(c.hashOf({ m: m.id, day }), 'credit') : c.derivedKey(requestKey, 'credit')) : null;
  await db.query(`UPDATE member_memberships SET closed='cancelled',closed_on=$3,close_reason=$4,closed_by=$5,closed_at=now(),close_key=$6,close_hash=$7,credit_key=$8,approved_by=$9,
    updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2`, [business.id, m.id, lastDay, reason, user.id, requestKey || c.derivedKey(creditKey || hash, 'quote'), hash, creditKey,
    giving > 0 ? approval?.approver.id || null : null]);
  const bill = await lockBill(db, business, m.document_id);
  let creditNote = null;
  if (giving > 0) {
    const lines = [...(planCredit > 0 ? [{ lineId: m.line_id }] : []), ...(joiningCredit > 0 ? [{ lineId: m.joining_line_id, quantity: '1', restock: false }] : [])];
    const returnBody = { reason: `Membership ${m.membership_no} cancelled: ${reason}`, lines, planCredit };
    creditNote = await returns.postReturn(db, business, user, bill.doc, { reason: returnBody.reason.slice(0, 300), requestKey: creditKey, hash: c.hashOf(returnBody), lines,
      values: planCredit > 0 ? new Map([[Number(m.line_id), planCredit]]) : null });
  }
  // What the member paid beyond what is now due on the bill goes back to them.
  const back = creditNote ? Math.max(0, Math.min(await creditLeft(db, business, m.document_id), paise(creditNote.total))) : 0;
  const after = await lockBill(db, business, m.document_id);
  const figures = { membershipNo: m.membership_no, lastDay, used: share.used, left: share.left, whole: share.whole, by: share.by, price: m.price, most: rupees(most),
    planCredit: rupees(planCredit), joiningFee: rupees(joiningCredit), creditNote: creditNote ? creditNote.total : '0.00', paid: rupees(bill.paid), dueBefore: rupees(Math.max(0, bill.due)),
    refund: rupees(back), stillDue: rupees(Math.max(0, after.due + back)), transferred };
  if (quote) throw new Preview(figures);
  let refund = null;
  if (back > 0) {
    const how = body.refund && typeof body.refund === 'object' && !Array.isArray(body.refund) ? body.refund : {};
    if (!c.given(how.method) && !c.given(how.methodId)) fail(`${rupees(back)} goes back to ${m.member_name}: choose how (cash, card, UPI or bank)`, 400, { reason: 'refund_method', refund: rupees(back) });
    const input = returns.readRefund({ amount: rupees(back), method: how.method, methodId: how.methodId, reason: `Membership ${m.membership_no} cancelled: ${reason}`.slice(0, 300),
      requestKey: c.derivedKey(requestKey, 'refund') });
    refund = await returns.postRefund(db, business, user, bill.doc, input);
  }
  if (creditNote) {
    await db.query('UPDATE member_memberships SET return_id=$3,credit=$4,refund_id=$5,refunded=$6,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, m.id, creditNote.id, creditNote.total, refund?.id || null, refund ? refund.amount : null]);
  }
  const details = { ...figures, returnNo: creditNote?.return_no || null, refundMethod: refund?.method || null, ...(approval && giving > 0 ? { approvedBy: approval.approver.name } : {}) };
  await ms.event(db, business, user, m.id, 'cancelled', [`Cancelled: ${reason}`, creditNote ? `credit note ${creditNote.return_no}` : null,
    refund ? `${refund.amount} refunded` : null].filter(Boolean).join(' · '), details);
  return { membershipId: m.id, details, creditNote, refund };
}

async function cancelPreview(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.cancel');
  return previewOf((db) => runCancel(db, business, user, membershipId, body, { quote: true, approval: null }));
}
async function cancel(business, user, membershipId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.cancel');
  // A manager's PIN is checked before the transaction (a PIN check holds no locks).
  const giving = (c.given(body.credit) ? Number(body.credit) > 0 : true) || body.joiningFee === true;
  const approval = giving && body.approval ? await pins().readApproval(business, user, { ...body.approval, reason: body.reason }, 'member_plans.approve', { reasonLabel: 'Reason' }) : null;
  return repo.transaction(async (db) => {
    const done = await runCancel(db, business, user, membershipId, body, { quote: false, approval });
    if (done.details) {
      const m = await repo.one(db, 'SELECT membership_no,contact_id FROM member_memberships WHERE business_id=$1 AND id=$2', [business.id, done.membershipId]);
      await repo.audit(db, business.id, approval?.approver.id || user.id, 'membership.cancelled', done.membershipId, { ...done.details, requestedBy: user.id, reason: body.reason });
      await repo.event(db, business.id, user.id, 'membership.cancelled', 'membership', done.membershipId, { membershipNo: m.membership_no, contactId: m.contact_id,
        returnId: done.creditNote?.id || null, refundId: done.refund?.id || null, credit: done.details.creditNote, refund: done.details.refund,
        approvedBy: approval?.approver.id || null });
    }
    return ms.shape(business, await ms.load(db, business, done.membershipId));
  });
}

module.exports = { freeze, unfreeze, transfer, upgrade, upgradePreview, cancel, cancelPreview, upgradeLastDay, cancelLastDay, lockMembership };
