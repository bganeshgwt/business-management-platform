const crypto = require('node:crypto');
const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');
const consents = require('./consents');
const privacyNotice = require('./privacyNotice');

// Personal data (DPDP Act 2023 and Rules 2025): one model for both engines,
// as tasks and GST rate changes are (ARCHITECTURE §4.3, §4.5). Every flow here
// works from a `world` (personalDataShop.js, personalDataRestaurant.js):
//
//   kind              'shop' (a customer contact) or 'restaurant' (a guest)
//   column            the person's column: contact_id or customer_id
//   words             { person, people, Person }
//   ensureBusiness(db, make)  the business the rows belong to (a restaurant's is made when first needed)
//   lock(db)          the business row's lock (numbering, notices)
//   today(db)         the business's own date
//   can(p), require(p), requireAny(list)
//   consentRecorders  who may record or withdraw a consent; peopleReaders who may read one person's consents
//   audit(db, action, entityId, details)
//   person(db, id), search(db, q), everyone(db, limit, offset), countEveryone(db)
//   openItems(db, id), exportOf(db, id), erase / eraseWith   (privacyRegister.service.js)
//
// This file: the privacy notice and contact, consent per purpose, and a
// child's mark. Requests and breaches are in privacyRegister.service.js.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requestKey(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('A valid request key is required');
  return value;
}
const id = (value, name) => v.requiredId(value, name);
const person = (world, value) => consents.personOf(world.column, id(value, world.words.Person));

// Runs work in one transaction with the world's business row made if needed.
async function inBusiness(world, work, { make = true } = {}) {
  return repo.transaction(async (db) => {
    const businessId = await world.ensureBusiness(db, make);
    return work(db, businessId);
  });
}

// --- The privacy notice and contact ----------------------------------------------------

const noticeView = (row) => (!row ? null : {
  id: row.id, version: row.version, label: `v${row.version}`, notice: row.notice, bills_text: row.bills_text, reminders_text: row.reminders_text,
  offers_text: row.offers_text, contact_name: row.contact_name, contact_phone: row.contact_phone, contact_email: row.contact_email,
  published_at: row.published_at, published_by_name: row.published_by_name, print_line: privacyNotice.printLine(row),
});

// The notice in force (any member reads it: the counter shows it when a
// consent is taken), and the starter text while none is published.
async function notice(world) {
  const businessId = await world.ensureBusiness(repo.pool, false);
  const row = businessId ? await repo.one(repo.pool, `SELECT n.*,u.name AS published_by_name FROM business_privacy_notices n LEFT JOIN users u ON u.id=n.published_by
    WHERE n.business_id=$1 ORDER BY n.version DESC LIMIT 1`, [businessId]) : null;
  const starter = row ? null : privacyNotice.starter(await starterFacts(world));
  return { current: noticeView(row), starter };
}

// What the starter text names: the business and a contact to begin with.
async function starterFacts(world) {
  if (world.kind === 'shop') {
    const facts = await repo.one(repo.pool, `SELECT COALESCE(NULLIF(btrim(s.display_name),''),b.name) AS name,
        (SELECT phone FROM business_locations l WHERE l.business_id=b.id AND l.active AND l.phone IS NOT NULL ORDER BY l.id LIMIT 1) AS phone
      FROM businesses b LEFT JOIN business_settings s ON s.business_id=b.id WHERE b.id=$1`, [world.businessId]);
    return { name: facts.name, type: world.type, contactName: facts.name, contactPhone: facts.phone, contactEmail: null };
  }
  const facts = await repo.one(repo.pool, 'SELECT name,contact AS phone,email FROM restaurants WHERE id=$1', [world.restaurantId]);
  return { name: facts?.name || 'The restaurant', type: 'restaurant', contactName: facts?.name || null, contactPhone: facts?.phone || null, contactEmail: facts?.email || null };
}

// Every version, newest first.
async function notices(world) {
  await world.require('privacy.view');
  const businessId = await world.ensureBusiness(repo.pool, false);
  if (!businessId) return [];
  return (await repo.all(repo.pool, `SELECT n.*,u.name AS published_by_name FROM business_privacy_notices n LEFT JOIN users u ON u.id=n.published_by
    WHERE n.business_id=$1 ORDER BY n.version DESC`, [businessId])).map(noticeView);
}

function readNotice(body) {
  const text = (value, name, min, max) => {
    const read = v.requiredString(value, name, max);
    if (read.length < min) fail(`${name} needs at least ${min} characters: say plainly what it covers`);
    return read;
  };
  const contactPhone = v.optionalString(body.contactPhone, 'Contact phone', 30);
  const contactEmail = body.contactEmail ? v.requiredEmail(body.contactEmail, 'Contact e-mail') : null;
  if (!contactPhone && !contactEmail) fail('Give the privacy contact\'s phone or e-mail, so people can reach them');
  return {
    notice: text(body.notice, 'The notice', 200, 8000),
    billsText: text(body.billsText, 'The consent notice for bills on WhatsApp or SMS', 20, 600),
    remindersText: text(body.remindersText, 'The consent notice for reminders', 20, 600),
    offersText: text(body.offersText, 'The consent notice for offers', 20, 600),
    contactName: v.requiredString(body.contactName, 'Privacy contact', 150), contactPhone, contactEmail,
  };
}

// Publishes a new version: the one in force from now; earlier consents keep the version they were given on.
async function publishNotice(world, body) {
  await world.require('privacy.manage');
  const key = requestKey(body.requestKey);
  const f = readNotice(body);
  const hash = sha256({ ...f });
  return inBusiness(world, async (db, businessId) => {
    await world.lock(db);
    const seen = await repo.one(db, 'SELECT * FROM business_privacy_notices WHERE business_id=$1 AND request_key=$2', [businessId, key]);
    if (seen) {
      if (seen.request_hash !== hash) fail('This request key was already used for different data', 409);
      return noticeView(seen);
    }
    const version = Number((await repo.one(db, 'SELECT COALESCE(max(version),0)+1 AS v FROM business_privacy_notices WHERE business_id=$1', [businessId])).v);
    const row = await repo.one(db, `INSERT INTO business_privacy_notices(business_id,version,notice,bills_text,reminders_text,offers_text,contact_name,contact_phone,contact_email,
        published_by,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [businessId, version, f.notice, f.billsText, f.remindersText, f.offersText, f.contactName, f.contactPhone, f.contactEmail, world.user.id, key, hash]);
    await world.audit(db, 'privacy_notice.published', row.id, { version });
    return noticeView(row);
  });
}

// --- Consent ---------------------------------------------------------------------------

// Active purposes of several people, with the notice in force: what every
// screen that opens a message to a customer asks first.
async function lookup(world, ids) {
  const list = String(ids || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (list.length > 200) fail('Ask for at most 200 people at a time');
  const people = list.map((x) => id(x, world.words.Person));
  const businessId = await world.ensureBusiness(repo.pool, false);
  const map = await consents.statusOf(repo.pool, businessId, world.column, people);
  const current = businessId ? await consents.notice(repo.pool, businessId) : null;
  return { notice: current && { id: current.id, version: current.version, bills_text: current.bills_text, reminders_text: current.reminders_text, offers_text: current.offers_text },
    people: Object.fromEntries([...map.entries()].map(([key, value]) => [key, value])) };
}

// One person's consents (every one, given and withdrawn) and child's mark.
async function personView(world, personId) {
  await world.requireAny(world.peopleReaders);
  const who = person(world, personId);
  const row = await world.person(repo.pool, who.id);
  if (!row) fail(`${world.words.Person} not found`, 404);
  const businessId = await world.ensureBusiness(repo.pool, false);
  if (!businessId) return { person: row, consents: [], child: null, active: [] };
  const [history, child] = await Promise.all([
    consents.history(repo.pool, businessId, who),
    repo.one(repo.pool, `SELECT k.*,u.name AS marked_by_name FROM business_children k LEFT JOIN users u ON u.id=k.marked_by
      WHERE k.business_id=$1 AND k.${who.column}=$2 AND k.ended_at IS NULL`, [businessId, who.id]),
  ]);
  return { person: row, consents: history, child: child || null, active: history.filter((k) => !k.withdrawn_at).map((k) => k.purpose) };
}

// Records consent for the purposes given (one tap at the counter records one).
async function give(world, personId, body) {
  await world.requireAny(world.consentRecorders);
  const who = person(world, personId);
  const given = consents.readGiven(body);
  return inBusiness(world, async (db, businessId) => {
    const row = await world.person(db, who.id, { lock: true });
    if (!row) fail(`${world.words.Person} not found`, 404);
    if (row.erased_at) fail(`This ${world.words.person}'s data was erased at their request: no consent is recorded for them`, 409);
    if (given.purposes.includes('offers') && (await consents.active(db, businessId, who)).child) {
      fail(`${row.name} is marked as a child: offers are never sent to a child`, 409, { reason: 'child' });
    }
    const rows = await consents.record(db, { businessId, person: who, ...given, userId: world.user.id, audit: world.audit });
    return { consents: rows, active: (await consents.active(db, businessId, who)).purposes };
  });
}

async function withdraw(world, consentId, body = {}) {
  await world.requireAny(world.consentRecorders);
  const reason = v.optionalString(body.reason, 'Reason', 300) || 'Asked to stop';
  const channel = v.optionalEnum(body.channel, 'Where it was asked', consents.CHANNELS, 'counter');
  return inBusiness(world, async (db, businessId) => {
    const current = await repo.one(db, `SELECT * FROM business_consents WHERE business_id=$1 AND id=$2 AND ${world.column} IS NOT NULL`, [businessId, id(consentId, 'Consent')]);
    if (!current) fail('Consent not found', 404);
    if (current.withdrawn_at) fail('This consent was already withdrawn', 409);
    const row = await consents.withdraw(db, { businessId, consentId: current.id, userId: world.user.id, reason, channel, audit: world.audit });
    return { consent: row, active: (await consents.active(db, businessId, consents.personOf(world.column, current[world.column]))).purposes };
  }, { make: false });
}

// --- A child -----------------------------------------------------------------------------

// Marks a person as a child, with the parent or guardian whose consent stands
// for theirs; any consent to offers stops first, as a child is never sent
// offers. The purposes the guardian agrees to are recorded as given by them.
async function markChild(world, personId, body) {
  await world.requireAny(world.consentRecorders);
  const who = person(world, personId);
  const guardianName = v.requiredString(body.guardianName, 'Parent or guardian', 150);
  const guardianRelation = v.optionalString(body.guardianRelation, 'Relation', 40);
  const method = v.optionalEnum(body.consentMethod, 'How the guardian gave consent', consents.METHODS, 'signed_form');
  const verifiedHow = v.optionalString(body.verifiedHow, 'How the guardian was verified', 300);
  const purposes = body.purposes === undefined ? [] : [...new Set(v.requiredArray(body.purposes, 'Purposes'))];
  for (const purpose of purposes) {
    if (purpose === 'offers') fail('Offers are never sent to a child, whoever agrees');
    v.requiredEnum(purpose, 'Purpose', ['bills_digital', 'reminders']);
  }
  return inBusiness(world, async (db, businessId) => {
    const row = await world.person(db, who.id, { lock: true });
    if (!row) fail(`${world.words.Person} not found`, 404);
    if (row.erased_at) fail(`This ${world.words.person}'s data was erased at their request`, 409);
    const marked = await repo.one(db, `SELECT id FROM business_children WHERE business_id=$1 AND ${who.column}=$2 AND ended_at IS NULL`, [businessId, who.id]);
    if (marked) fail(`${row.name} is already marked as a child`, 409);
    await consents.withdraw(db, { businessId, person: who, purpose: 'offers', userId: world.user.id, reason: 'Marked as a child: offers are never sent to a child', audit: world.audit });
    const child = await repo.one(db, `INSERT INTO business_children(business_id,${who.column},guardian_name,guardian_relation,consent_method,verified_how,marked_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [businessId, who.id, guardianName, guardianRelation, method, verifiedHow, world.user.id]);
    await world.audit(db, 'person.marked_child', who.id, { guardianName, guardianRelation, method });
    if (purposes.length) {
      await consents.record(db, { businessId, person: who, purposes, channel: 'counter', method, givenBy: guardianName, userId: world.user.id, audit: world.audit });
    }
    return { child, active: (await consents.active(db, businessId, who)).purposes };
  });
}

async function endChild(world, childId, body = {}) {
  await world.requireAny(world.consentRecorders);
  const reason = v.requiredString(body.reason, 'Why the mark ends', 300);
  return inBusiness(world, async (db, businessId) => {
    const row = await repo.one(db, `SELECT * FROM business_children WHERE business_id=$1 AND id=$2 AND ${world.column} IS NOT NULL FOR UPDATE`, [businessId, id(childId, 'Mark')]);
    if (!row) fail('Not found', 404);
    if (row.ended_at) fail('This mark has already ended', 409);
    const saved = await repo.one(db, 'UPDATE business_children SET ended_at=now(),ended_by=$3,end_reason=$4 WHERE business_id=$1 AND id=$2 RETURNING *',
      [businessId, row.id, world.user.id, reason]);
    await world.audit(db, 'person.child_mark_ended', row[world.column], { reason });
    return saved;
  }, { make: false });
}

// The one line bills and receipts print with the privacy contact, and the
// notice in force: { version, line } or null while none is published.
async function printInfo(businessId) {
  const row = businessId ? await consents.notice(repo.pool, businessId) : null;
  return row ? { version: row.version, line: privacyNotice.printLine(row) } : null;
}
// The same for the signed-in restaurant (its business row, when it has one).
async function restaurantPrintInfo(restaurantId) {
  const row = await repo.one(repo.pool, 'SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [restaurantId]);
  return printInfo(row?.id || null);
}

// The restaurant's notice as the guests' site shows it where it takes a
// guest's name and number: the notice, what a guest may agree to there, and
// the contact. null while none is published.
async function publicNotice(restaurantId) {
  const business = await repo.one(repo.pool, 'SELECT id FROM businesses WHERE legacy_restaurant_id=$1', [restaurantId]);
  const row = business ? await consents.notice(repo.pool, business.id) : null;
  if (!row) return null;
  return { id: row.id, version: row.version, notice: row.notice, billsText: row.bills_text, offersText: row.offers_text,
    contact: privacyNotice.contactLine({ contactName: row.contact_name, contactPhone: row.contact_phone, contactEmail: row.contact_email }) };
}

// People to pick (a request's person, a breach's people), for those who keep the registers.
async function searchPeople(world, q) {
  await world.require('privacy.view');
  return world.search(repo.pool, v.optionalString(q, 'Search', 100), 20);
}

module.exports = { inBusiness, requestKey, sha256, id, person, notice, notices, publishNotice, lookup, personView, give, withdraw, markChild, endChild, searchPeople, noticeView,
  printInfo, restaurantPrintInfo, publicNotice };
