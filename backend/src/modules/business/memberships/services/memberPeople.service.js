const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./memberCommon');
const ms = require('./memberships.service');

// A member's own details beyond the contact, and those who are not members yet
// (module "member_plans"):
//
//   profile      date of birth (the age shown, birthdays listed), and a
//                coaching student's school and class.
//   guardians    a coaching student's guardians, several, each with a phone
//                and whether they agreed to messages on WhatsApp.
//   results      a student's test results (the test, its day, the marks out
//                of what, remarks), shown in order as their progress.
//   enquiries    someone who asked: how they came, what they want, when to
//                call back (the follow-up list); a trial pass of so many days
//                (and visits) that checks in like a membership, has no bill
//                and never asks for a mandate, one per person; the member they
//                became when a membership is sold from the enquiry, or why not.

const { fail, id } = c;
const SOURCES = ['walk_in', 'phone', 'whatsapp', 'social', 'website', 'referral', 'other'];

async function studentOf(db, business, contactId) {
  const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Member')]);
  if (!contact) fail('Member not found', 404);
  return contact;
}

// --- Profile ----------------------------------------------------------------------------------------

// body: { dateOfBirth?, school?, className? } — empty clears.
async function saveProfile(business, user, contactId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const dateOfBirth = c.given(body.dateOfBirth) ? c.readDate(body.dateOfBirth, 'Date of birth') : null;
  const school = c.optionalText(body.school, 'School', 150) || null;
  const className = c.optionalText(body.className, 'Class', 40) || null;
  const contact = await repo.transaction(async (db) => {
    const found = await studentOf(db, business, contactId);
    const today = await c.today(db, business);
    if (dateOfBirth && (dateOfBirth > today || dateOfBirth < '1900-01-01')) fail('The date of birth is a day in the past');
    const before = await ms.ensureProfile(db, business, user, found.id);
    await db.query('UPDATE member_profiles SET date_of_birth=$3,school=$4,class_name=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND contact_id=$2',
      [business.id, found.id, dateOfBirth, school, className, user.id]);
    await repo.audit(db, business.id, user.id, 'member.profile_changed', found.id, { member: found.name,
      ...(String(before.date_of_birth || '') !== String(dateOfBirth || '') ? { dateOfBirth: 'changed' } : {}), school, className });
    return found;
  });
  return ms.member(business, contact.id);
}

// --- Guardians --------------------------------------------------------------------------------------

function readGuardian(body) {
  return { name: v.requiredString(typeof body.name === 'string' ? body.name : '', 'Guardian\'s name', 150), relation: c.optionalText(body.relation, 'Relation', 40) || null,
    phone: c.optionalText(body.phone, 'Phone', 30) || null, consent: v.requiredBoolean(body.whatsappConsent, 'Agreed to WhatsApp', false), active: v.requiredBoolean(body.active, 'Active', true) };
}
async function addGuardian(business, user, contactId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const g = readGuardian(body);
  if (g.consent && !g.phone) fail('A guardian who agrees to WhatsApp gives a phone');
  return repo.transaction(async (db) => {
    const contact = await studentOf(db, business, contactId);
    const count = await repo.one(db, 'SELECT count(*)::int AS n FROM member_guardians WHERE business_id=$1 AND contact_id=$2 AND active', [business.id, contact.id]);
    if (count.n >= 6) fail(`${contact.name} has six guardians already`, 409);
    const row = await repo.one(db, `INSERT INTO member_guardians(business_id,contact_id,name,relation,phone,whatsapp_consent,consent_at,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6 THEN now() END,$7,$7) RETURNING *`, [business.id, contact.id, g.name, g.relation, g.phone, g.consent, user.id]);
    await repo.audit(db, business.id, user.id, 'member_guardian.created', row.id, { student: contact.name, name: g.name, relation: g.relation, whatsappConsent: g.consent });
    return row;
  });
}
async function updateGuardian(business, user, guardianId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const g = readGuardian(body);
  if (g.consent && !g.phone) fail('A guardian who agrees to WhatsApp gives a phone');
  return repo.transaction(async (db) => {
    const old = await repo.one(db, 'SELECT * FROM member_guardians WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(guardianId, 'Guardian')]);
    if (!old) fail('Guardian not found', 404);
    const row = await repo.one(db, `UPDATE member_guardians SET name=$3,relation=$4,phone=$5,whatsapp_consent=$6,consent_at=CASE WHEN $6 THEN COALESCE(consent_at,now()) END,
      active=$7,updated_by=$8,updated_at=now() WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, old.id, g.name, g.relation, g.phone, g.consent, g.active, user.id]);
    await repo.audit(db, business.id, user.id, 'member_guardian.updated', row.id, { name: g.name, ...(old.whatsapp_consent !== g.consent ? { whatsappConsent: g.consent } : {}),
      ...(old.active !== g.active ? { active: g.active } : {}) });
    return row;
  });
}

// --- Test results -----------------------------------------------------------------------------------

function readResult(body) {
  const outOf = core.decimal(body.outOf, 'Out of', 2, 0.01, 99999);
  const marks = core.decimal(body.marks, 'Marks', 2, 0, 99999);
  if (marks > outOf) fail(`The marks are at most ${outOf}`);
  return { testName: v.requiredString(typeof body.testName === 'string' ? body.testName : '', 'Test', 150), takenOn: c.readDate(body.takenOn, 'Taken on'), marks, outOf,
    remarks: c.optionalText(body.remarks, 'Remarks', 500) || null };
}
async function addResult(business, user, contactId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const r = readResult(body);
  return repo.transaction(async (db) => {
    const contact = await studentOf(db, business, contactId);
    if (r.takenOn > await c.today(db, business)) fail('A test result is of a test taken today or before');
    const row = await repo.one(db, `INSERT INTO member_test_results(business_id,contact_id,test_name,taken_on,marks,out_of,remarks,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *,taken_on::text AS taken_on`, [business.id, contact.id, r.testName, r.takenOn, r.marks.toFixed(2), r.outOf.toFixed(2), r.remarks, user.id]);
    await repo.audit(db, business.id, user.id, 'member_result.created', row.id, { student: contact.name, test: r.testName, marks: row.marks, outOf: row.out_of });
    return row;
  });
}
async function updateResult(business, user, resultId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.edit');
  const r = readResult(body);
  return repo.transaction(async (db) => {
    const old = await repo.one(db, 'SELECT * FROM member_test_results WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(resultId, 'Result')]);
    if (!old) fail('Result not found', 404);
    const row = await repo.one(db, `UPDATE member_test_results SET test_name=$3,taken_on=$4,marks=$5,out_of=$6,remarks=$7,updated_by=$8,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *,taken_on::text AS taken_on`, [business.id, old.id, r.testName, r.takenOn, r.marks.toFixed(2), r.outOf.toFixed(2), r.remarks, user.id]);
    await repo.audit(db, business.id, user.id, 'member_result.updated', row.id, { test: r.testName, from: { marks: old.marks, outOf: old.out_of }, to: { marks: row.marks, outOf: row.out_of } });
    return row;
  });
}

// --- Enquiries and trial passes ------------------------------------------------------------------------

const LEADS_SQL = `SELECT x.*,(x.status IN ('open','trial') AND x.follow_up_on IS NOT NULL AND x.follow_up_on<=x.today) AS due FROM (
  SELECT l.id,l.location_id,lc.name AS location_name,l.name,l.phone,l.email,l.source,l.interest,l.follow_up_on,l.status,l.notes,l.lost_reason,l.contact_id,
    l.trial_membership_id,tm.membership_no AS trial_no,tm.end_on AS trial_end_on,l.membership_id,mm.membership_no,l.created_at,u.name AS created_by_name,pr.member_code,
    (now() AT TIME ZONE b.timezone)::date AS today
  FROM member_leads l JOIN businesses b ON b.id=l.business_id JOIN business_locations lc ON lc.business_id=l.business_id AND lc.id=l.location_id
  JOIN users u ON u.id=l.created_by LEFT JOIN member_memberships tm ON tm.business_id=l.business_id AND tm.id=l.trial_membership_id
  LEFT JOIN member_memberships mm ON mm.business_id=l.business_id AND mm.id=l.membership_id
  LEFT JOIN member_profiles pr ON pr.business_id=l.business_id AND pr.contact_id=l.contact_id
  WHERE l.business_id=$1) x`;
repo.addLists({
  'member-leads': { sql: LEADS_SQL, search: ['name', 'phone', 'email', 'interest', 'notes'], date: 'created_at',
    filters: { status: 'status', source: 'source', due: 'due', location: 'location_id' }, order: "CASE WHEN status IN ('open','trial') THEN 0 ELSE 1 END, follow_up_on NULLS LAST, id DESC" },
});

function readLead(body, old = {}) {
  const pick = (key) => (body[key] === undefined ? old[key] : body[key]);
  return {
    name: v.requiredString(String(pick('name') ?? ''), 'Name', 150), phone: c.optionalText(pick('phone'), 'Phone', 30) || null, email: c.optionalText(pick('email'), 'E-mail', 150) || null,
    source: v.requiredEnum(pick('source') ?? 'walk_in', 'How they came', SOURCES), interest: c.optionalText(pick('interest'), 'Interested in', 200) || null,
    followUpOn: c.given(pick('followUpOn')) ? c.readDate(pick('followUpOn'), 'Follow up on') : null, notes: c.optionalText(pick('notes'), 'Notes', 1000) || null,
  };
}

// body: { locationId, name, phone?, email?, source, interest?, followUpOn?, notes? }
async function addLead(business, user, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  const lead = readLead(body);
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  return repo.transaction(async (db) => {
    if (!await repo.one(db, 'SELECT 1 FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId])) fail('Location not found', 404);
    const row = await repo.one(db, `INSERT INTO member_leads(business_id,location_id,name,phone,email,source,interest,follow_up_on,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`, [business.id, locationId, lead.name, lead.phone, lead.email, lead.source, lead.interest, lead.followUpOn, lead.notes, user.id]);
    await repo.audit(db, business.id, user.id, 'member_lead.created', row.id, { name: lead.name, source: lead.source, interest: lead.interest, followUpOn: lead.followUpOn });
    return repo.one(db, `${LEADS_SQL} WHERE x.id=$2`, [business.id, row.id]);
  });
}

// body: the enquiry's fields, and { status?: open | lost, lostReason? }.
async function updateLead(business, user, leadId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  return repo.transaction(async (db) => {
    const old = await repo.one(db, 'SELECT * FROM member_leads WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(leadId, 'Enquiry')]);
    if (!old) fail('Enquiry not found', 404);
    access.requireLocation(business, old.location_id);
    if (old.status === 'member') fail(`${old.name} became a member: the enquiry is closed`, 409);
    const lead = readLead(body, { ...old, followUpOn: old.follow_up_on });
    let status = old.status, lostReason = old.lost_reason;
    if (body.status !== undefined) {
      const asked = v.requiredEnum(body.status, 'Status', ['open', 'lost']);
      if (asked === 'lost') { status = 'lost'; lostReason = v.requiredString(typeof body.lostReason === 'string' ? body.lostReason : '', 'Why not', 300); }
      else { status = old.trial_membership_id ? 'trial' : 'open'; lostReason = null; }
    }
    await db.query(`UPDATE member_leads SET name=$3,phone=$4,email=$5,source=$6,interest=$7,follow_up_on=$8,notes=$9,status=$10,lost_reason=$11,updated_by=$12,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, old.id, lead.name, lead.phone, lead.email, lead.source, lead.interest, lead.followUpOn, lead.notes, status, lostReason, user.id]);
    await repo.audit(db, business.id, user.id, 'member_lead.updated', old.id, { name: lead.name, ...(status !== old.status ? { status: { from: old.status, to: status } } : {}),
      ...(String(old.follow_up_on || '') !== String(lead.followUpOn || '') ? { followUpOn: lead.followUpOn } : {}), ...(lostReason ? { lostReason } : {}) });
    return repo.one(db, `${LEADS_SQL} WHERE x.id=$2`, [business.id, old.id]);
  });
}

// body: { requestKey, planId, days (1–30), visits? (1–30), startOn? } — a trial pass: a membership with no bill.
async function trial(business, user, leadId, body) {
  c.requireMemberships(business);
  await access.require(business, 'member_plans.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, leadId: String(leadId) });
  const days = Number(core.decimal(body.days, 'Days', 0, 1, 30));
  const visits = c.given(body.visits) ? Number(core.decimal(body.visits, 'Visits', 0, 1, 30)) : null;
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT id,request_hash FROM member_memberships WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return ms.shape(business, await ms.load(db, business, done.id));
    }
    const lead = await repo.one(db, 'SELECT * FROM member_leads WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(leadId, 'Enquiry')]);
    if (!lead) fail('Enquiry not found', 404);
    access.requireLocation(business, lead.location_id);
    if (lead.status !== 'open') fail(`${lead.name}'s enquiry is ${lead.status === 'trial' ? 'on a trial pass already' : lead.status === 'member' ? 'closed: a member already' : 'closed as lost'}`, 409);
    const day = await c.today(db, business);
    const startOn = c.given(body.startOn) ? c.readDate(body.startOn, 'Starts on') : day;
    if (startOn < day || startOn > c.addDays(day, 30)) fail('A trial pass starts today or within 30 days');
    const plan = await ms.planFor(db, business, id(body.planId, 'Plan'));
    let contact;
    if (lead.contact_id) contact = await ms.customer(db, business, lead.contact_id);
    else {
      await access.require(business, 'contacts.create');
      contact = await core.createContact(business, user, { kind: 'customer', name: lead.name, phone: lead.phone || undefined, email: lead.email || undefined }, db);
    }
    // One trial per person: someone who has held a membership or a trial gets none.
    const held = await repo.one(db, 'SELECT membership_no,origin FROM member_memberships WHERE business_id=$1 AND contact_id=$2 ORDER BY id LIMIT 1', [business.id, contact.id]);
    if (held) fail(`${contact.name} has ${held.origin === 'trial' ? 'had a trial pass' : 'a membership'} already (${held.membership_no}): a trial pass is for someone new`, 409);
    await ms.ensureProfile(db, business, user, contact.id);
    const end = c.addDays(startOn, days - 1);
    const terms = { ...c.termsOf(plan), seats: 1, freeze_fee: 0, freeze_notice_days: 0, transfer_fee: 0, late_fee: 0, late_fee_after_days: 0, joining_refund_percent: 0,
      visit_limit: null, visit_period: null };
    const membership = await ms.insertMembership(db, business, user, {
      locationId: lead.location_id, contactId: contact.id, planName: `Trial · ${plan.name}`.slice(0, 100),
      plan: { id: plan.id, name: plan.name, kind: visits ? 'both' : 'duration', duration_unit: 'days', duration: days, grace_days: 0, transferable: false },
      sessionsTotal: visits, net: 0, tax: 0, taxRate: 0, joiningFee: 0, policyVersion: plan.policy_version, maxFreezeDays: 0, maxFreezes: 0, start: startOn, end,
      notes: `Trial pass from enquiry ${lead.id}`, requestKey, hash, terms, origin: 'trial',
    });
    await db.query("UPDATE member_leads SET status='trial',contact_id=$3,trial_membership_id=$4,updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2",
      [business.id, lead.id, contact.id, membership.id, user.id]);
    const details = { plan: plan.name, startOn, endOn: end, days, visits };
    await ms.event(db, business, user, membership.id, 'trial', `Trial pass: ${days} day${days === 1 ? '' : 's'}${visits ? `, ${visits} visit${visits === 1 ? '' : 's'}` : ''}`, details);
    await repo.audit(db, business.id, user.id, 'membership.trial_given', membership.id, { membershipNo: membership.membership_no, member: contact.name, ...details });
    return ms.shape(business, await ms.load(db, business, membership.id));
  });
}

module.exports = { saveProfile, addGuardian, updateGuardian, addResult, updateResult, addLead, updateLead, trial, SOURCES };
