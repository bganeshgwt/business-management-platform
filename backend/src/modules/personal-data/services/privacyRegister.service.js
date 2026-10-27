const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const consents = require('./consents');
const privacyNotice = require('./privacyNotice');
const { inBusiness, requestKey, sha256, id, person } = require('./personalData.service');

// The requests register and the breach register, for both engines (see
// personalData.service.js for the world each flow works from).
//
//   A request (to see, correct or erase a person's data, or a grievance) is
//   received on the business's own day and answered within 90 days of it;
//   the bell warns as the day nears. An access request's answer is the export
//   of everything held; a correction is made on the normal screens; an
//   erasure is carried out from its request. The request is kept as the record.
//   A breach shows the Board's 72 hours from when it was found, the people
//   affected and each notice sent to them. Nothing is filed from here.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const KINDS = ['access', 'correction', 'erasure', 'grievance'];
const REQUEST_CHANNELS = ['counter', 'phone', 'email', 'letter'];
const NOTICE_CHANNELS = ['whatsapp', 'sms', 'email', 'letter', 'in_person', 'phone'];
const DUE_SOON_DAYS = 15;
const BOARD_HOURS = 72;

repo.addLists({
  'privacy-requests': {
    sql: `SELECT r.id,r.request_no,r.kind,r.contact_id,r.customer_id,r.person_name,r.reply_to,r.channel,r.details,r.received_on::text AS received_on,
        r.due_on::text AS due_on,r.status,r.reply,r.closed_at,r.erased_at,r.created_at,COALESCE(c.name,g.name) AS person_now,u.name AS created_by_name,
        w.name AS closed_by_name,(r.due_on - business_privacy_today(r.business_id)) AS days_left
      FROM business_privacy_requests r LEFT JOIN business_contacts c ON c.business_id=r.business_id AND c.id=r.contact_id
      LEFT JOIN customers g ON g.id=r.customer_id LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users w ON w.id=r.closed_by WHERE r.business_id=$1`,
    search: ['person_name', 'person_now', 'details', 'reply_to', 'request_no'], date: 'created_at', filters: { status: 'status', kind: 'kind' },
    order: "(status = 'open') DESC,due_on,id DESC",
  },
  'privacy-breaches': {
    sql: `SELECT b.id,b.breach_no,b.found_at,b.found_at + interval '${BOARD_HOURS} hours' AS board_due_at,b.what_happened,b.impact,b.steps_taken,b.affected,
        b.board_informed_at,b.board_report_at,b.board_reference,b.status,b.closed_at,b.created_at,u.name AS created_by_name,
        (SELECT count(*)::int FROM business_privacy_breach_people p WHERE p.business_id=b.business_id AND p.breach_id=b.id) AS people,
        (SELECT count(*)::int FROM business_privacy_breach_notices n WHERE n.business_id=b.business_id AND n.breach_id=b.id) AS notices
      FROM business_privacy_breaches b LEFT JOIN users u ON u.id=b.created_by WHERE b.business_id=$1`,
    search: ['what_happened', 'impact', 'steps_taken', 'breach_no'], date: 'found_at', filters: { status: 'status' }, order: "(status = 'open') DESC,found_at DESC,id DESC",
  },
});

// A paged list for either register: { total, items }.
async function page(world, kind, query) {
  await world.require('privacy.view');
  const limit = query.limit === undefined ? 25 : id(query.limit, 'Page size');
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) fail('Invalid pagination');
  const businessId = await world.ensureBusiness(repo.pool, false);
  if (!businessId) return { total: 0, items: [] };
  const filters = {};
  for (const key of repo.listFilters(kind)) if (query[key] !== undefined && query[key] !== '') filters[key] = String(query[key]).slice(0, 60);
  const search = typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : null;
  return repo.page(businessId, kind, limit, offset, { search, filters, timezone: world.timezone || 'Asia/Kolkata' });
}

// --- Requests -----------------------------------------------------------------------------

const requestRow = (db, businessId, requestId, lock = false) => repo.one(db, `SELECT r.*,r.received_on::text AS received_on,r.due_on::text AS due_on,
    (r.due_on - business_privacy_today(r.business_id)) AS days_left FROM business_privacy_requests r WHERE r.business_id=$1 AND r.id=$2${lock ? ' FOR UPDATE' : ''}`,
[businessId, requestId]);

async function logRequest(world, body) {
  await world.require('privacy.manage');
  const key = requestKey(body.requestKey);
  const kind = v.requiredEnum(body.kind, 'What the person asks', KINDS);
  const personId = body.personId === undefined || body.personId === null || body.personId === '' ? null : person(world, body.personId).id;
  const channel = v.optionalEnum(body.channel, 'How it came in', REQUEST_CHANNELS, 'counter');
  const details = v.requiredString(body.details, 'What they asked', 2000);
  if (details.length < 3) fail('Say what they asked');
  const replyTo = v.optionalString(body.replyTo, 'Where to reply', 150);
  const receivedOn = body.receivedOn ? v.requiredString(body.receivedOn, 'Received on', 10) : null;
  if (receivedOn && !/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) fail('Received on must be a date like 2026-10-27');
  const hash = sha256({ kind, personId, channel, details, replyTo, receivedOn, personName: body.personName ?? null });
  return inBusiness(world, async (db, businessId) => {
    await world.lock(db);
    const seen = await repo.one(db, 'SELECT id,request_hash FROM business_privacy_requests WHERE business_id=$1 AND request_key=$2', [businessId, key]);
    if (seen) {
      if (seen.request_hash !== hash) fail('This request key was already used for different data', 409);
      return requestRow(db, businessId, seen.id);
    }
    const who = personId ? await world.person(db, personId) : null;
    if (personId && !who) fail(`${world.words.Person} not found`, 404);
    const personName = v.optionalString(body.personName, 'Who asked', 150) || who?.name;
    if (!personName) fail('Name the person who asked');
    const today = await world.today(db);
    const received = receivedOn || today;
    if (received > today) fail('A request cannot be received on a day still to come');
    const number = Number((await repo.one(db, 'SELECT COALESCE(max(request_no),0)+1 AS n FROM business_privacy_requests WHERE business_id=$1', [businessId])).n);
    const row = await repo.one(db, `INSERT INTO business_privacy_requests(business_id,request_no,kind,${world.column},person_name,reply_to,channel,details,received_on,due_on,
        request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$9::date + 90,$10,$11,$12) RETURNING id`,
    [businessId, number, kind, personId, personName, replyTo, channel, details, received, key, hash, world.user.id]);
    await world.audit(db, 'privacy_request.logged', row.id, { requestNo: number, kind, personId });
    return requestRow(db, businessId, row.id);
  });
}

// One request, with the person as they are now, their consents and, for an
// erasure still to do, what holds it back.
async function request(world, requestId) {
  await world.require('privacy.view');
  const businessId = await world.ensureBusiness(repo.pool, false);
  if (!businessId) fail('Request not found', 404);
  const row = await requestRow(repo.pool, businessId, id(requestId, 'Request'));
  if (!row) fail('Request not found', 404);
  const personId = row[world.column];
  const who = personId ? await world.person(repo.pool, personId) : null;
  const status = personId ? (await consents.statusOf(repo.pool, businessId, world.column, [personId])).get(Number(personId)) : null;
  const open = row.status === 'open' && row.kind === 'erasure' && who && !who.erased_at ? await world.openItems(repo.pool, personId) : [];
  const users = await repo.all(repo.pool, 'SELECT id,name FROM users WHERE id=ANY($1::bigint[])', [[row.created_by, row.closed_by, row.erased_by].filter(Boolean)]);
  const nameOf = (userId) => users.find((u) => Number(u.id) === Number(userId))?.name || null;
  return { ...row, person_id: personId, person: who || null, consents: status || null, open,
    created_by_name: nameOf(row.created_by), closed_by_name: nameOf(row.closed_by), erased_by_name: nameOf(row.erased_by) };
}

// Links an open request to the person it is about (found after it was logged).
async function linkRequest(world, requestId, body) {
  await world.require('privacy.manage');
  const personId = person(world, body.personId).id;
  return inBusiness(world, async (db, businessId) => {
    const row = await requestRow(db, businessId, id(requestId, 'Request'), true);
    if (!row) fail('Request not found', 404);
    if (row.status !== 'open') fail('This request is closed and kept as it was answered', 409);
    if (!(await world.person(db, personId))) fail(`${world.words.Person} not found`, 404);
    await db.query(`UPDATE business_privacy_requests SET ${world.column}=$3 WHERE business_id=$1 AND id=$2`, [businessId, row.id, personId]);
    await world.audit(db, 'privacy_request.linked', row.id, { personId });
    return requestRow(db, businessId, row.id);
  }, { make: false });
}

// Answers a request: done (with the reply sent) or refused (with the reason).
async function closeRequest(world, requestId, body) {
  await world.require('privacy.manage');
  const status = v.requiredEnum(body.status, 'Answer', ['done', 'refused']);
  const reply = v.requiredString(body.reply, 'The reply', 2000);
  if (reply.length < 3) fail('Write the reply given to the person');
  return inBusiness(world, async (db, businessId) => {
    const row = await requestRow(db, businessId, id(requestId, 'Request'), true);
    if (!row) fail('Request not found', 404);
    if (row.status !== 'open') fail('This request is already answered', 409);
    if (row.kind === 'erasure' && status === 'done' && !row.erased_at) fail('Erase the person\'s data first, or refuse the request with the reason', 409, { reason: 'not_erased' });
    await db.query('UPDATE business_privacy_requests SET status=$3,reply=$4,closed_at=now(),closed_by=$5 WHERE business_id=$1 AND id=$2',
      [businessId, row.id, status, reply, world.user.id]);
    await world.audit(db, 'privacy_request.closed', row.id, { requestNo: row.request_no, status });
    return requestRow(db, businessId, row.id);
  }, { make: false });
}

const erasureReply = (day) => `Your personal details were erased on ${day}. Bills and other tax records keep what tax law needs, and your consents and this request are kept as the record.`;

// Carries out an erasure request: the person's details go wherever no legal
// reason keeps them; what is kept, and why, is written on the request for the
// accountant. Waits for anything still open (money owed or held, an order
// in the shop). Closes the request with the reply.
async function erase(world, requestId, body = {}) {
  await world.require('privacy.manage');
  const key = requestKey(body.requestKey);
  const given = v.optionalString(body.reply, 'The reply', 2000);
  const hash = sha256({ reply: given });
  const target = id(requestId, 'Request');
  const businessId = await world.ensureBusiness(repo.pool, false);
  if (!businessId) fail('Request not found', 404);
  const before = await requestRow(repo.pool, businessId, target);
  if (!before) fail('Request not found', 404);
  if (before.erasure?.requestKey === key) {
    if (before.erasure.requestHash !== hash) fail('This request key was already used for different data', 409);
    return request(world, target);
  }
  if (before.kind !== 'erasure') fail('Only an erasure request erases a person\'s data', 409);
  if (before.erased_at) fail('This person\'s data was already erased from this request', 409);
  if (before.status !== 'open') fail('This request is already answered', 409);
  const personId = before[world.column];
  if (!personId) fail(`Link the request to the ${world.words.person} first`, 409, { reason: 'no_person' });
  // The request is answered with the erasure, in the same transaction.
  const recordOn = async (db, result) => {
    const row = await requestRow(db, businessId, target, true);
    if (row.status !== 'open' || row.erased_at) fail('This request was answered meanwhile', 409);
    const day = await world.today(db);
    const reply = given || erasureReply(day);
    const erasure = { ...result, requestKey: key, requestHash: hash };
    await db.query(`UPDATE business_privacy_requests SET erased_at=now(),erased_by=$3,erasure=$4,status='done',reply=$5,closed_at=now(),closed_by=$3
      WHERE business_id=$1 AND id=$2`, [businessId, target, world.user.id, JSON.stringify(erasure), reply]);
    await world.audit(db, 'personal_data.erased', personId, { requestId: target, requestNo: row.request_no, erased: result.erased.map((e) => e.heading) });
  };
  if (world.eraseWith) {
    await world.eraseWith(personId, recordOn);
  } else {
    await repo.transaction(async (db) => {
      await world.lock(db);
      const who = await world.person(db, personId, { lock: true });
      if (!who) fail(`${world.words.Person} not found`, 404);
      if (who.erased_at) fail(`This ${world.words.person}'s data was already erased`, 409);
      const open = await world.openItems(db, personId);
      if (open.length) fail(`${who.name}'s data cannot be erased yet. ${open.join(' ')}`, 409, { reason: 'erasure_blocked', open });
      await recordOn(db, await world.erase(db, personId));
    });
  }
  return request(world, target);
}

// Everything held about a person: viewed on screen, or exported as a file
// for an access request. Each is written to the activity log.
async function personData(world, personId, { requestId = null, exported = false } = {}) {
  await world.require('privacy.export');
  const who = person(world, personId);
  return inBusiness(world, async (db, businessId) => {
    const row = await world.person(db, who.id);
    if (!row) fail(`${world.words.Person} not found`, 404);
    const forRequest = requestId ? await requestRow(db, businessId, id(requestId, 'Request')) : null;
    if (requestId && !forRequest) fail('Request not found', 404);
    const held = await world.exportOf(db, who.id);
    // One after another, on the transaction's own connection.
    const history = await consents.history(db, businessId, who);
    const child = await repo.all(db, `SELECT guardian_name,guardian_relation,consent_method,verified_how,marked_at,ended_at,end_reason FROM business_children
      WHERE business_id=$1 AND ${who.column}=$2 ORDER BY id`, [businessId, who.id]);
    const requests = await repo.all(db, `SELECT request_no,kind,received_on::text AS received_on,due_on::text AS due_on,status,reply,closed_at FROM business_privacy_requests
      WHERE business_id=$1 AND ${who.column}=$2 ORDER BY id`, [businessId, who.id]);
    await world.audit(db, exported ? 'personal_data.exported' : 'personal_data.viewed', who.id, { requestId: forRequest?.id || null, sections: held.sections.length });
    const day = await world.today(db);
    return {
      filename: `personal-data-${world.words.person}-${who.id}-${day}.json`,
      data: {
        business: world.name || null, exportedOn: day, exportedBy: world.user.name || null, request: forRequest ? forRequest.request_no : null,
        person: held.person, consents: history, child, requests,
        sections: held.sections.map((s) => ({ heading: s.heading, rows: s.rows })),
      },
    };
  }, { make: false });
}

// --- Breaches -------------------------------------------------------------------------------

const breachRow = (db, businessId, breachId, lock = false) => repo.one(db, `SELECT b.*,b.found_at + interval '${BOARD_HOURS} hours' AS board_due_at
  FROM business_privacy_breaches b WHERE b.business_id=$1 AND b.id=$2${lock ? ' FOR UPDATE' : ''}`, [businessId, breachId]);

function readMoment(value, name, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${name} is required`);
    return null;
  }
  const at = new Date(String(value));
  if (Number.isNaN(at.getTime())) fail(`${name} must be a date and time`);
  if (at.getTime() > Date.now() + 5 * 60000) fail(`${name} cannot be in the future`);
  return at.toISOString();
}
const longText = (value, name, min, max) => {
  const text = v.requiredString(value, name, max);
  if (text.length < min) fail(`${name} needs at least ${min} characters`);
  return text;
};

// The plain-language notice to the people affected, filled from the record.
async function defaultNotice(db, world, businessId, breach) {
  const notice = await consents.notice(db, businessId);
  const contact = notice ? privacyNotice.contactLine({ contactName: notice.contact_name, contactPhone: notice.contact_phone, contactEmail: notice.contact_email }) : null;
  const name = world.name || (await repo.one(db, 'SELECT name FROM businesses WHERE id=$1', [businessId]))?.name || 'We';
  const day = new Date(breach.found_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: world.timezone || 'Asia/Kolkata' });
  return [
    `${name}: about your personal data`,
    '',
    `On ${day} we found this: ${breach.what_happened}`,
    `What it means for you: ${breach.impact}`,
    `What we have done: ${breach.steps_taken}`,
    '',
    `If you have questions, or want to know more, contact ${contact || 'us'}.`,
  ].join('\n');
}

async function breach(world, breachId) {
  await world.require('privacy.view');
  const businessId = await world.ensureBusiness(repo.pool, false);
  if (!businessId) fail('Breach not found', 404);
  const row = await breachRow(repo.pool, businessId, id(breachId, 'Breach'));
  if (!row) fail('Breach not found', 404);
  const people = row.affected === 'chosen'
    ? await repo.all(repo.pool, `SELECT p.id,p.${world.column} AS person_id,COALESCE(c.name,g.name) AS name,COALESCE(c.phone,g.mobile) AS phone,COALESCE(c.email,g.email) AS email,
        EXISTS (SELECT 1 FROM business_privacy_breach_notices n WHERE n.business_id=p.business_id AND n.breach_id=p.breach_id AND n.${world.column}=p.${world.column}) AS notified
      FROM business_privacy_breach_people p LEFT JOIN business_contacts c ON c.business_id=p.business_id AND c.id=p.contact_id LEFT JOIN customers g ON g.id=p.customer_id
      WHERE p.business_id=$1 AND p.breach_id=$2 ORDER BY 3,2`, [businessId, row.id])
    : [];
  const notices = await repo.all(repo.pool, `SELECT n.id,n.${world.column} AS person_id,COALESCE(c.name,g.name) AS name,n.channel,n.notice_text,n.sent_at,u.name AS sent_by_name
    FROM business_privacy_breach_notices n LEFT JOIN business_contacts c ON c.business_id=n.business_id AND c.id=n.contact_id LEFT JOIN customers g ON g.id=n.customer_id
    LEFT JOIN users u ON u.id=n.sent_by WHERE n.business_id=$1 AND n.breach_id=$2 ORDER BY n.sent_at DESC,n.id DESC`, [businessId, row.id]);
  const everyone = row.affected === 'all' ? await world.countEveryone(repo.pool) : people.length;
  const hoursLeft = Math.round((new Date(row.board_due_at).getTime() - Date.now()) / 360000) / 10;
  return { ...row, people, notices, affected_count: everyone, hours_left: hoursLeft,
    people_notice_text: row.people_notice || await defaultNotice(repo.pool, world, businessId, row) };
}

async function addPeople(db, world, businessId, breachId, ids) {
  for (const personId of ids) {
    if (!(await world.person(db, personId))) fail(`${world.words.Person} not found`, 404);
    await db.query(`INSERT INTO business_privacy_breach_people(business_id,breach_id,${world.column},added_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [businessId, breachId, personId, world.user.id]);
  }
}
const readPeople = (world, value) => [...new Set(v.requiredArray(value ?? [], 'People').map((x) => person(world, x).id))];

async function recordBreach(world, body) {
  await world.require('privacy.manage');
  const key = requestKey(body.requestKey);
  const f = {
    foundAt: readMoment(body.foundAt, 'When it was found', { required: true }),
    whatHappened: longText(body.whatHappened, 'What happened', 10, 4000),
    impact: longText(body.impact, 'The impact', 3, 4000),
    stepsTaken: longText(body.stepsTaken, 'The steps taken', 3, 4000),
    affected: v.requiredEnum(body.affected, 'Who is affected', ['all', 'chosen']),
    people: body.people === undefined ? [] : readPeople(world, body.people),
  };
  const hash = sha256(f);
  return inBusiness(world, async (db, businessId) => {
    await world.lock(db);
    const seen = await repo.one(db, 'SELECT id,request_hash FROM business_privacy_breaches WHERE business_id=$1 AND request_key=$2', [businessId, key]);
    if (seen) {
      if (seen.request_hash !== hash) fail('This request key was already used for different data', 409);
      return breachRow(db, businessId, seen.id);
    }
    const number = Number((await repo.one(db, 'SELECT COALESCE(max(breach_no),0)+1 AS n FROM business_privacy_breaches WHERE business_id=$1', [businessId])).n);
    const row = await repo.one(db, `INSERT INTO business_privacy_breaches(business_id,breach_no,found_at,what_happened,impact,steps_taken,affected,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`, [businessId, number, f.foundAt, f.whatHappened, f.impact, f.stepsTaken, f.affected, key, hash, world.user.id]);
    if (f.affected === 'chosen') await addPeople(db, world, businessId, row.id, f.people);
    await world.audit(db, 'breach.recorded', row.id, { breachNo: number, affected: f.affected, people: f.people.length });
    return breachRow(db, businessId, row.id);
  });
}

// What is learnt as it goes: the record, the people's notice, and when the
// business told the Board and sent its detailed report.
async function updateBreach(world, breachId, body) {
  await world.require('privacy.manage');
  return inBusiness(world, async (db, businessId) => {
    const row = await breachRow(db, businessId, id(breachId, 'Breach'), true);
    if (!row) fail('Breach not found', 404);
    if (row.status !== 'open') fail('This breach is closed and kept as it was', 409);
    const given = (key) => body[key] !== undefined;
    const next = {
      what_happened: given('whatHappened') ? longText(body.whatHappened, 'What happened', 10, 4000) : row.what_happened,
      impact: given('impact') ? longText(body.impact, 'The impact', 3, 4000) : row.impact,
      steps_taken: given('stepsTaken') ? longText(body.stepsTaken, 'The steps taken', 3, 4000) : row.steps_taken,
      affected: given('affected') ? v.requiredEnum(body.affected, 'Who is affected', ['all', 'chosen']) : row.affected,
      people_notice: given('peopleNotice') ? (body.peopleNotice ? longText(body.peopleNotice, 'The notice to the people affected', 50, 4000) : null) : row.people_notice,
      board_informed_at: given('boardInformedAt') ? readMoment(body.boardInformedAt, 'When the Board was told') : row.board_informed_at,
      board_report_at: given('boardReportAt') ? readMoment(body.boardReportAt, 'When the detailed report went to the Board') : row.board_report_at,
      board_reference: given('boardReference') ? v.optionalString(body.boardReference, 'The Board\'s reference', 100) : row.board_reference,
    };
    const found = new Date(row.found_at).getTime();
    for (const [key, words] of [['board_informed_at', 'The Board was told'], ['board_report_at', 'The detailed report went']]) {
      if (next[key] && new Date(next[key]).getTime() < found) fail(`${words} before the breach was found`);
    }
    await db.query(`UPDATE business_privacy_breaches SET what_happened=$3,impact=$4,steps_taken=$5,affected=$6,people_notice=$7,board_informed_at=$8,board_report_at=$9,
      board_reference=$10,updated_by=$11,updated_at=now() WHERE business_id=$1 AND id=$2`, [businessId, row.id, next.what_happened, next.impact, next.steps_taken,
      next.affected, next.people_notice, next.board_informed_at, next.board_report_at, next.board_reference, world.user.id]);
    await world.audit(db, 'breach.updated', row.id, { breachNo: row.breach_no, fields: Object.keys(body).filter((k) => k !== 'requestKey') });
    return breachRow(db, businessId, row.id);
  }, { make: false });
}

async function breachPeople(world, breachId, body) {
  await world.require('privacy.manage');
  const ids = readPeople(world, body.personIds);
  if (!ids.length) fail('Choose the people affected');
  return inBusiness(world, async (db, businessId) => {
    const row = await breachRow(db, businessId, id(breachId, 'Breach'), true);
    if (!row) fail('Breach not found', 404);
    if (row.affected !== 'chosen') fail('This breach affects every customer: no one is chosen', 409);
    await addPeople(db, world, businessId, row.id, ids);
    await world.audit(db, 'breach.people_added', row.id, { people: ids.length });
    return { added: ids.length };
  }, { make: false });
}

async function removeBreachPerson(world, breachId, personId) {
  await world.require('privacy.manage');
  const who = person(world, personId);
  return inBusiness(world, async (db, businessId) => {
    const row = await breachRow(db, businessId, id(breachId, 'Breach'), true);
    if (!row) fail('Breach not found', 404);
    const result = await db.query(`DELETE FROM business_privacy_breach_people WHERE business_id=$1 AND breach_id=$2 AND ${who.column}=$3`, [businessId, row.id, who.id]);
    if (!result.rowCount) fail('Not on this breach', 404);
    await world.audit(db, 'breach.person_removed', row.id, { personId: who.id });
    return { removed: true };
  }, { make: false });
}

// A notice sent to one person affected, as worded, by the business's own
// WhatsApp, SMS, e-mail, letter or in person: recorded once sent.
async function recordNotice(world, breachId, body) {
  await world.require('privacy.manage');
  const key = requestKey(body.requestKey);
  const who = person(world, body.personId);
  const channel = v.requiredEnum(body.channel, 'How it was sent', NOTICE_CHANNELS);
  const text = body.text === undefined || body.text === null || body.text === '' ? null : longText(body.text, 'The notice', 50, 4000);
  const hash = sha256({ personId: who.id, channel, text });
  return inBusiness(world, async (db, businessId) => {
    const row = await breachRow(db, businessId, id(breachId, 'Breach'), true);
    if (!row) fail('Breach not found', 404);
    const seen = await repo.one(db, 'SELECT * FROM business_privacy_breach_notices WHERE business_id=$1 AND request_key=$2', [businessId, key]);
    if (seen) {
      if (seen.request_hash !== hash) fail('This request key was already used for different data', 409);
      return seen;
    }
    if (row.status !== 'open') fail('This breach is closed and kept as it was', 409);
    const target = await world.person(db, who.id);
    if (!target) fail(`${world.words.Person} not found`, 404);
    if (row.affected === 'chosen' && !(await repo.one(db, `SELECT 1 FROM business_privacy_breach_people WHERE business_id=$1 AND breach_id=$2 AND ${who.column}=$3`, [businessId, row.id, who.id]))) {
      fail(`${target.name} is not among the people affected by this breach`, 409);
    }
    const wording = text || row.people_notice || await defaultNotice(db, world, businessId, row);
    const saved = await repo.one(db, `INSERT INTO business_privacy_breach_notices(business_id,breach_id,${who.column},channel,notice_text,sent_by,request_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [businessId, row.id, who.id, channel, wording, world.user.id, key, hash]);
    await world.audit(db, 'breach.notice_sent', row.id, { breachNo: row.breach_no, personId: who.id, channel });
    return saved;
  }, { make: false });
}

async function closeBreach(world, breachId) {
  await world.require('privacy.manage');
  return inBusiness(world, async (db, businessId) => {
    const row = await breachRow(db, businessId, id(breachId, 'Breach'), true);
    if (!row) fail('Breach not found', 404);
    if (row.status !== 'open') fail('This breach is already closed', 409);
    if (!row.board_report_at) fail('Record when the detailed report went to the Data Protection Board first', 409, { reason: 'board_report' });
    await db.query("UPDATE business_privacy_breaches SET status='closed',closed_at=now(),closed_by=$3,updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2",
      [businessId, row.id, world.user.id]);
    await world.audit(db, 'breach.closed', row.id, { breachNo: row.breach_no });
    return breachRow(db, businessId, row.id);
  }, { make: false });
}

// Every customer, a page at a time, for a breach that touches them all.
async function everyone(world, query) {
  await world.require('privacy.view');
  const limit = Math.min(Number(query.limit) || 50, 200), offset = Math.max(Number(query.offset) || 0, 0);
  return { total: await world.countEveryone(repo.pool), items: await world.everyone(repo.pool, limit, offset) };
}

// --- The bell -------------------------------------------------------------------------------

// Requests nearing their 90 days (or past them), breaches whose report to the
// Board is still to record, and a notice not yet published. `link(tab, id)`
// builds the screen's address.
async function bell(world, link) {
  if (!world.can('privacy.view')) return [];
  const businessId = await world.ensureBusiness(repo.pool, false);
  const items = [];
  if (!businessId || !(await consents.notice(repo.pool, businessId))) {
    if (world.can('privacy.manage')) {
      items.push({ id: 'privacy-notice:none', severity: 'warning', category: 'Personal data', title: 'Publish your privacy notice',
        detail: 'Consent is taken on it, and bills print its contact: check the starter text and publish it.', at: new Date().toISOString(), link: link('notice') });
    }
    if (!businessId) return items;
  }
  const requests = await repo.all(repo.pool, `SELECT id,request_no,kind,person_name,due_on::text AS due_on,(due_on - business_privacy_today(business_id)) AS days_left,created_at
    FROM business_privacy_requests WHERE business_id=$1 AND status='open' AND due_on - business_privacy_today(business_id) <= $2 ORDER BY due_on,id LIMIT 15`, [businessId, DUE_SOON_DAYS]);
  for (const r of requests) {
    const days = Number(r.days_left);
    items.push({ id: `privacy-request:${r.id}:${days < 0 ? 'late' : 'soon'}`, severity: days < 0 ? 'critical' : 'warning', category: 'Personal data',
      title: days < 0 ? `Request ${r.request_no} is ${-days} day${days === -1 ? '' : 's'} past its 90 days` : `Request ${r.request_no} is due in ${days} day${days === 1 ? '' : 's'}`,
      detail: `${r.person_name} asked for ${r.kind === 'grievance' ? 'a grievance to be answered' : r.kind}; answer by ${r.due_on}.`, at: new Date(r.created_at).toISOString(), link: link('requests', r.id) });
  }
  const breaches = await repo.all(repo.pool, `SELECT id,breach_no,found_at,found_at + interval '${BOARD_HOURS} hours' AS due FROM business_privacy_breaches
    WHERE business_id=$1 AND status='open' AND board_report_at IS NULL ORDER BY found_at LIMIT 10`, [businessId]);
  for (const b of breaches) {
    const hours = Math.round((new Date(b.due).getTime() - Date.now()) / 3600000);
    items.push({ id: `privacy-breach:${b.id}:${hours < 0 ? 'late' : 'open'}`, severity: 'critical', category: 'Personal data',
      title: hours < 0 ? `Breach ${b.breach_no}: the Board's report is ${-hours} hour${hours === -1 ? '' : 's'} late` : `Breach ${b.breach_no}: the Board's report is due in ${hours} hour${hours === 1 ? '' : 's'}`,
      detail: 'Send the Data Protection Board the detailed report within 72 hours of finding it, tell the people affected, and record both here.',
      at: new Date(b.found_at).toISOString(), link: link('breaches', b.id) });
  }
  return items;
}

module.exports = { KINDS, REQUEST_CHANNELS, NOTICE_CHANNELS, BOARD_HOURS, page, logRequest, request, linkRequest, closeRequest, erase, personData,
  breach, recordBreach, updateBreach, breachPeople, removeBreachPerson, recordNotice, closeBreach, everyone, bell };
