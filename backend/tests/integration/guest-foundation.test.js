const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { signIn } = require('./helpers/signIn');

// The shared pieces of a business's guest pages (modules/business/guests),
// run against a database the way lanes building those pages will call them:
//   - a guest's customer record found by the last ten digits of their mobile,
//     the one used most recently, never another business's, a supplier, an
//     erased or switched-off customer; a name staff set never changed; a new
//     one made with source guests_site, and one record for two requests at
//     the same moment;
//   - consents ticked on the guests' site recorded with channel guests_site,
//     method digital, no one recording them, on the notice the page showed;
//     an unticked box withdrawing nothing; offers never for a child;
//   - the business taking nothing when its plan has ended, it is switched off
//     or its location is closed (409 not_taking_orders), and 404 for a
//     location that is not its own;
//   - the business card: only what a business shows its guests, open now on
//     its own clock, the privacy notice's link; the public notice by that link;
//   - business_audit's rule: a row with no actor is a guest's (channel
//     guests_site), and the activity log calls it "Guest (online)";
//   - the guest rate limit, per client address behind a proxy and per key;
//   - this migration's Down half and Up again.
test('guest foundation', { timeout: 600000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, mini, created = false;
  await admin.connect();
  t.after(async () => {
    if (mini) await new Promise((resolve) => mini.close(resolve));
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  process.env.TRUST_PROXY = '1';
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  pool = require('../../src/config/database');
  const repo = require('../../src/modules/business/core/repositories/business.repository');
  const guests = require('../../src/modules/business/guests');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Guests-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  async function owner(code) {
    const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', [code]);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,restaurant_id', [restaurant.id, `Owner ${code}`, `${code}@test.invalid`, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
    return person;
  }
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth, headers = {}, at = base) {
    const response = await fetch(at + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => ({})) };
  }
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const login = async (email) => (await signIn(base, email, password)).token;
  const inTransaction = (work) => repo.transaction(work);
  // A refusal thrown by a piece: its status, message and details.
  const refusal = async (work) => {
    try {
      await work();
    } catch (error) {
      return { status: error.statusCode, message: error.message, details: error.details, code: error.code };
    }
    assert.fail('expected a refusal');
  };

  const ownerA = await owner('guests-a');
  await owner('guests-b');
  const A = as(await login('guests-a@test.invalid'));
  const B = as(await login('guests-b@test.invalid'));
  const [salon, grocery] = await createBusinesses(A, 'GUESTS', ['salon', 'grocery']);
  const [elsewhere] = await createBusinesses(B, 'ELSEWHERE', ['salon']);
  const S = (suffix) => `/businesses/${salon.id}/${suffix}`;
  const mainOf = async (business) => (await A('GET', `/businesses/${business.id}/locations`)).items[0];
  const salonMain = await mainOf(salon);

  // --- business_audit: a guest's row ---------------------------------------------------------
  await t.test("a row with no actor is a guest's or automatic, and such a row names no one", async () => {
    const insert = (actor, channel) => pool.query('INSERT INTO business_audit(business_id,actor_id,action,details,channel) VALUES($1,$2,$3,$4,$5)',
      [salon.id, actor, 'contact.created', '{}', channel]);
    // No actor and no channel: refused, as every row was before.
    await assert.rejects(insert(null, null), { code: '23514', constraint: 'business_audit_actor_or_channel' });
    // A person on a guest's or an automatic row, or a channel of anything else: refused.
    await assert.rejects(insert(ownerA.id, 'guests_site'), { code: '23514', constraint: 'business_audit_actor_or_channel' });
    await assert.rejects(insert(ownerA.id, 'automatic'), { code: '23514', constraint: 'business_audit_actor_or_channel' });
    await assert.rejects(insert(null, 'counter'), { code: '23514' });
    // A guest's row, an automatic row, and a staff row as ever.
    await repo.guestAudit(pool, salon.id, 'appointment.requested', 41, { source: 'guests_site' });
    await repo.automaticAudit(pool, salon.id, 'appointment.expired', 41, { reason: 'not_answered' });
    await repo.audit(pool, salon.id, ownerA.id, 'settings.updated', null, {});
    const rows = await all('SELECT actor_id,channel,action FROM business_audit WHERE business_id=$1 AND action IN ($2,$3,$4) ORDER BY id',
      [salon.id, 'appointment.requested', 'appointment.expired', 'settings.updated']);
    const actor = (id) => (id === null ? null : Number(id));
    assert.deepEqual(rows.map((row) => [actor(row.actor_id), row.channel, row.action]),
      [[null, 'guests_site', 'appointment.requested'], [null, 'automatic', 'appointment.expired'], [Number(ownerA.id), null, 'settings.updated']]);
    // The activity log calls them "Guest (online)" and "Automatic", and finds each by that name.
    const log = await A('GET', S('audit?limit=100'));
    const guestRow = log.items.find((row) => row.action === 'appointment.requested');
    assert.deepEqual([guestRow.actor_id, guestRow.actor_name, guestRow.channel], [null, 'Guest (online)', 'guests_site']);
    const automaticRow = log.items.find((row) => row.action === 'appointment.expired');
    assert.deepEqual([automaticRow.actor_id, automaticRow.actor_name, automaticRow.channel], [null, 'Automatic', 'automatic']);
    assert.equal(log.items.find((row) => row.action === 'settings.updated').actor_name, 'Owner guests-a');
    const found = await A('GET', S('audit?q=Guest%20(online)'));
    assert.deepEqual(found.items.map((row) => row.action), ['appointment.requested']);
    const automatic = await A('GET', S('audit?q=Automatic'));
    assert.deepEqual(automatic.items.map((row) => row.action), ['appointment.expired']);
  });

  // --- A guest's customer record --------------------------------------------------------------
  const contact = (business, body) => A('POST', `/businesses/${business.id}/contacts`, { kind: 'customer', ...body }, 201);
  let priya;
  await t.test("a guest's mobile finds the customer staff know, the one used most recently, and never changes them", async () => {
    // Two records with one number, typed two ways at the counter; the newer is used.
    const older = await contact(salon, { name: 'P. Sharma', phone: '+91 98490 12345' });
    priya = await contact(salon, { name: 'Priya Sharma', phone: '098490-12345', email: 'priya@home.invalid' });
    let found = await inTransaction((db) => guests.findOrCreateGuestContact(db, salon, { name: 'priya', mobile: '9849012345', email: 'other@mail.invalid' }));
    assert.equal(found.created, false);
    assert.equal(Number(found.contact.id), Number(priya.id));
    // Never renamed, its number and email never touched.
    const kept = await one('SELECT name,phone,email,source FROM business_contacts WHERE id=$1', [priya.id]);
    assert.deepEqual(kept, { name: 'Priya Sharma', phone: '098490-12345', email: 'priya@home.invalid', source: 'staff' });
    // A bill to the older record makes it the one used most recently.
    const service = await A('POST', S('catalog'), { kind: 'service', unit: 'service', taxRate: '18', name: 'Hair spa', code: 'SPA', price: '900' }, 201);
    await A('POST', S('documents'), { kind: 'sale', requestKey: crypto.randomUUID(), locationId: salonMain.id, contactId: older.id, lines: [{ skuId: service.id, quantity: '1' }],
      payment: { amount: 'full', method: 'cash' } }, 201);
    found = await inTransaction((db) => guests.findOrCreateGuestContact(db, salon.id, { name: 'Priya', mobile: '+91 98490 12345' }));
    assert.equal(Number(found.contact.id), Number(older.id));
    assert.equal(found.contact.name, 'P. Sharma');
  });

  await t.test("a supplier, a switched-off or erased customer, or another business's is never a guest's record", async () => {
    await A('POST', S('contacts'), { kind: 'supplier', name: 'Lakme supplies', phone: '9000011111' }, 201);
    const off = await contact(salon, { name: 'Ravi Kumar', phone: '9000022222' });
    await A('PATCH', S(`contacts/${off.id}`), { name: 'Ravi Kumar', phone: '9000022222', active: false });
    const erased = await contact(salon, { name: 'Sita Devi', phone: '9000033333' });
    await pool.query('UPDATE business_contacts SET erased_at=now(),erased_by=$2 WHERE id=$1', [erased.id, ownerA.id]);
    await B('POST', `/businesses/${elsewhere.id}/contacts`, { kind: 'customer', name: 'Their customer', phone: '9000044444' }, 201);
    for (const mobile of ['9000011111', '9000022222', '9000033333', '9000044444']) {
      const made = await inTransaction((db) => guests.findOrCreateGuestContact(db, salon, { name: 'Online guest', mobile }));
      assert.equal(made.created, true, mobile);
      assert.equal(made.contact.kind, 'customer');
    }
  });

  let guestContact;
  await t.test('a new guest becomes a customer from the guests\' site, with an audit row of no actor, once however often they press Book', async () => {
    const made = await inTransaction((db) => guests.findOrCreateGuestContact(db, salon, { name: '  Anjali   Rao ', mobile: '+91 91234 56789', email: 'Anjali@Example.com' }));
    assert.equal(made.created, true);
    guestContact = made.contact;
    assert.deepEqual([made.contact.name, made.contact.phone, made.contact.email, made.contact.source, made.contact.active], ['Anjali Rao', '9123456789', 'anjali@example.com', 'guests_site', true]);
    const audit = await one("SELECT actor_id,channel,details FROM business_audit WHERE business_id=$1 AND action='contact.created' AND entity_id=$2", [salon.id, made.contact.id]);
    assert.deepEqual(audit, { actor_id: null, channel: 'guests_site', details: { source: 'guests_site' } });
    // Shown as "Guest (online)" in the activity log.
    const log = await A('GET', S('audit?limit=100'));
    assert.equal(log.items.find((row) => row.action === 'contact.created' && Number(row.entity_id) === Number(made.contact.id)).actor_name, 'Guest (online)');
    // The same mobile again finds them.
    assert.equal(Number((await inTransaction((db) => guests.findOrCreateGuestContact(db, salon, { name: 'Anjali', mobile: '9123456789' }))).contact.id), Number(made.contact.id));
    // Two requests with one new mobile at the same moment: one record.
    const both = await Promise.all([1, 2].map(() => inTransaction(async (db) => {
      const found = await guests.findOrCreateGuestContact(db, salon, { name: 'Imran Khan', mobile: '9988776655' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      return found;
    })));
    assert.equal(Number(both[0].contact.id), Number(both[1].contact.id));
    assert.deepEqual(both.map((answer) => answer.created).sort(), [false, true]);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_contacts WHERE business_id=$1 AND phone='9988776655'", [salon.id])).n, 1);
    // What a guest page sends is checked: an Indian mobile, a name, an email.
    for (const [input, words] of [[{ name: 'Anjali', mobile: '+44 7700 900123' }, /10-digit mobile/], [{ name: 'Anjali', mobile: '' }, /Enter your mobile/],
      [{ name: '7', mobile: '9123456789' }, /Please enter your name/], [{ name: 'Anjali', mobile: '9123456789', email: 'not-an-email' }, /not a valid email/]]) {
      const refused = await refusal(() => inTransaction((db) => guests.findOrCreateGuestContact(db, salon, input)));
      assert.equal(refused.status, 400);
      assert.match(refused.message, words);
    }
  });

  // --- Consents from the guests' site ------------------------------------------------------------
  let v1, v2;
  await t.test("consents ticked on a guest page are the guest's own, on the notice the page showed", async () => {
    // No notice published: nothing ticked is fine, a tick is refused.
    assert.deepEqual(await inTransaction((db) => guests.recordGuestConsents(db, salon, guestContact.id, {}, null)), { purposes: [] });
    const early = await refusal(() => inTransaction((db) => guests.recordGuestConsents(db, salon, guestContact.id, { offers: true }, null)));
    assert.deepEqual([early.status, early.details.reason], [409, 'no_privacy_notice']);
    const { starter } = await A('GET', S('privacy/notice'));
    const body = { ...starter, contactName: 'Shine Salon (owner)', contactPhone: '98450 11111', contactEmail: 'owner@shine.invalid', requestKey: crypto.randomUUID() };
    v1 = await A('POST', S('privacy/notices'), body, 201);
    v2 = await A('POST', S('privacy/notices'), { ...body, offersText: 'Send me offers on WhatsApp, at most one a week. I can stop them at any time.', requestKey: crypto.randomUUID() }, 201);
    // A reminder consent given at the counter before.
    await A('POST', S(`privacy/people/${guestContact.id}/consents`), { purposes: ['reminders'] }, 201);
    // The page showed v1; the guest ticks bills and offers and leaves reminders unticked.
    const answer = await inTransaction((db) => guests.recordGuestConsents(db, salon, guestContact.id, { bills_digital: true, offers: true, reminders: false }, v1.id));
    assert.deepEqual([...answer.purposes].sort(), ['bills_digital', 'offers', 'reminders']);
    const rows = await all(`SELECT purpose,channel,method,recorded_by,notice_id,notice_version,withdrawn_at FROM business_consents
      WHERE business_id=$1 AND contact_id=$2 ORDER BY purpose`, [salon.id, guestContact.id]);
    assert.deepEqual(rows.map((row) => [row.purpose, row.channel, row.method, row.recorded_by === null ? null : Number(row.recorded_by), Number(row.notice_id), row.notice_version, row.withdrawn_at]), [
      ['bills_digital', 'guests_site', 'digital', null, Number(v1.id), 'v1', null],
      ['offers', 'guests_site', 'digital', null, Number(v1.id), 'v1', null],
      ['reminders', 'counter', 'verbal', Number(ownerA.id), Number(v2.id), 'v2', null],
    ]);
    const audits = await all("SELECT actor_id,channel,details FROM business_audit WHERE business_id=$1 AND action='consent.given' AND entity_id=$2 ORDER BY id", [salon.id, guestContact.id]);
    assert.deepEqual(audits.filter((row) => row.channel === 'guests_site').map((row) => [row.actor_id, row.details.purpose, row.details.channel]),
      [[null, 'bills_digital', 'guests_site'], [null, 'offers', 'guests_site']]);
    // Ticked again: nothing doubles. A list of purposes works as well as a form's choices.
    await inTransaction((db) => guests.recordGuestConsents(db, salon, guestContact.id, ['bills_digital'], v2.id));
    assert.equal((await one('SELECT count(*)::int AS n FROM business_consents WHERE contact_id=$1 AND withdrawn_at IS NULL', [guestContact.id])).n, 3);
  });

  await t.test('a consent on a notice not the business\'s, for a purpose a page cannot ask, for a child\'s offers or an erased customer is not recorded', async () => {
    const theirs = await B('GET', `/businesses/${elsewhere.id}/privacy/notice`);
    const theirNotice = await B('POST', `/businesses/${elsewhere.id}/privacy/notices`,
      { ...theirs.starter, contactName: 'Elsewhere', contactPhone: '98450 22222', requestKey: crypto.randomUUID() }, 201);
    const changed = await refusal(() => inTransaction((db) => guests.recordGuestConsents(db, salon, guestContact.id, { offers: true }, theirNotice.id)));
    assert.deepEqual([changed.status, changed.details.reason], [400, 'notice_changed']);
    assert.match(changed.message, /reload the page/);
    for (const choices of [['treatment'], { reports_digital: true }, ['spam'], 'offers']) {
      assert.equal((await refusal(() => inTransaction((db) => guests.recordGuestConsents(db, salon, guestContact.id, choices, v2.id)))).status, 400, JSON.stringify(choices));
    }
    // A child: the guardian's bills consent is recorded, offers never.
    const child = await contact(salon, { name: 'Arjun (child)', phone: '9876500001' });
    await A('POST', S(`privacy/people/${child.id}/child`), { guardianName: 'Kavita Rao', guardianRelation: 'Mother', consentMethod: 'verbal' }, 201);
    const answer = await inTransaction((db) => guests.recordGuestConsents(db, salon, child.id, { bills_digital: true, offers: true }, v2.id));
    assert.deepEqual(answer.purposes, ['bills_digital']);
    const erased = await contact(salon, { name: 'Gone Guest', phone: '9876500002' });
    await pool.query('UPDATE business_contacts SET erased_at=now(),erased_by=$2 WHERE id=$1', [erased.id, ownerA.id]);
    assert.equal((await refusal(() => inTransaction((db) => guests.recordGuestConsents(db, salon, erased.id, { offers: true }, v2.id)))).status, 409);
    assert.deepEqual(guests.readGuestChoices(undefined), []);
    assert.deepEqual(guests.readGuestChoices({ offers: false, reminders: true }), ['reminders']);
  });

  // --- Taking orders, and the card -------------------------------------------------------------
  const endBusiness = async (id) => {
    await pool.query("UPDATE business_access_periods SET cancelled_at=now(),cancel_reason='Set aside by the test' WHERE business_id=$1 AND cancelled_at IS NULL", [id]);
    await pool.query(`INSERT INTO business_access_periods(business_id,kind,starts_on,ends_on,everything)
      VALUES($1,'trial',business_local_today($1)-30,business_local_today($1)-17,TRUE)`, [id]);
  };
  await t.test('a business takes nothing from its guest pages once its plan has ended, it is switched off or its location is closed', async () => {
    const groceryMain = await mainOf(grocery);
    await guests.assertBusinessTakingOrders(pool, grocery.id);
    await guests.assertBusinessTakingOrders(pool, grocery.id, { locationId: groceryMain.id });
    // A location that is not this business's, or no business at all: as an unknown link.
    for (const [businessId, options] of [[grocery.id, { locationId: salonMain.id }], [grocery.id, { locationId: 'abc' }], [987654321, {}]]) {
      const refused = await refusal(() => guests.assertBusinessTakingOrders(pool, businessId, options));
      assert.deepEqual([refused.status, refused.details.reason], [404, 'not_available']);
    }
    // A second location, closed.
    const branch = await A('POST', `/businesses/${grocery.id}/locations`, { name: 'Market branch', code: 'MKT' }, 201);
    await A('PATCH', `/businesses/${grocery.id}/locations/${branch.id}`, { name: 'Market branch', active: false });
    let refused = await refusal(() => guests.assertBusinessTakingOrders(pool, grocery.id, { locationId: branch.id, message: 'Not taking online orders now.' }));
    assert.deepEqual([refused.status, refused.message, refused.details.reason], [409, 'Not taking online orders now.', 'not_taking_orders']);
    // The plan ended.
    await endBusiness(grocery.id);
    refused = await refusal(() => guests.assertBusinessTakingOrders(pool, grocery.id));
    assert.deepEqual([refused.status, refused.details.reason], [409, 'not_taking_orders']);
    assert.match(refused.message, /isn't taking online orders or bookings right now/);
    assert.equal((await guests.guestBusinessCard(pool, grocery.id, groceryMain.id)).takingOrders, false);
    // Switched off by the platform.
    await pool.query("UPDATE businesses SET status='inactive' WHERE id=$1", [elsewhere.id]);
    refused = await refusal(() => guests.assertBusinessTakingOrders(pool, elsewhere.id));
    assert.deepEqual([refused.status, refused.details.reason], [409, 'not_taking_orders']);
    assert.equal((await guests.guestBusinessCard(pool, elsewhere.id, (await one('SELECT id FROM business_locations WHERE business_id=$1', [elsewhere.id])).id)).takingOrders, false);
  });

  let card;
  await t.test("the business card shows what the business shows its guests, open now on its own clock, and links its privacy notice", async () => {
    await pool.query(`UPDATE business_settings SET display_name='Shine Salon',legal_name='Shine Beauty Services LLP',gstin='36ABCDE1234F1Z1',state_code='36',
      address_line1='Plot 12, Road 3',address_line2='Banjara Hills',city='Hyderabad',postal_code='500034',phone='040 2345 6789',email='owner@shine.invalid',
      logo_path='https://cdn.example.com/shine.png' WHERE business_id=$1`, [salon.id]);
    // Open every day but for a minute (six to six the next morning), so "now" is open whenever this runs.
    const days = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, { open: '06:00', close: '05:59' }]));
    await A('PATCH', S(`locations/${salonMain.id}`), { name: salonMain.name, openingHours: days });
    card = await guests.guestBusinessCard(pool, salon.id, salonMain.id);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    assert.deepEqual(Object.keys(card).sort(), ['hours', 'location', 'logoUrl', 'name', 'privacy', 'seller', 'takingOrders', 'type']);
    assert.deepEqual([card.name, card.type, card.logoUrl, card.takingOrders], ['Shine Salon', 'salon', 'https://cdn.example.com/shine.png', true]);
    // The location has no address of its own: the business's.
    assert.deepEqual(card.location, { name: salonMain.name, address: 'Plot 12, Road 3, Banjara Hills', city: 'Hyderabad', postalCode: '500034', phone: '040 2345 6789' });
    assert.deepEqual(card.seller, { legalName: 'Shine Beauty Services LLP', gstin: '36ABCDE1234F1Z1', address: 'Plot 12, Road 3, Banjara Hills, Hyderabad, 500034' });
    if (clock !== '05:59') {
      assert.equal(card.hours.openNow, true, clock);
      assert.equal(card.hours.closesAt, '05:59');
    }
    assert.deepEqual(card.hours.today, { open: '06:00', close: '05:59' });
    assert.deepEqual(card.privacy, { id: Number(v2.id), version: 2, url: card.privacy.url, billsText: v2.bills_text, remindersText: v2.reminders_text,
      offersText: 'Send me offers on WhatsApp, at most one a week. I can stop them at any time.', contact: 'Shine Salon (owner), 98450 11111, owner@shine.invalid' });
    assert.match(card.privacy.url, /^\/privacy-notice\/[0-9a-z]+-[A-Za-z0-9_-]{22}$/);
    // Never the owner's email, a person's details or a note.
    assert.doesNotMatch(JSON.stringify({ ...card, privacy: null }), /owner@shine|Owner guests-a|guests-a@/);
    // A location of its own: its address, its phone and its GSTIN; closed today, opening tomorrow.
    const tomorrow = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date())) + 1) % 7];
    const branch = await A('POST', S('locations'), { name: 'Jubilee Hills', code: 'JH', addressLine1: '8-2-293, Road 36', city: 'Hyderabad', postalCode: '500033',
      phone: '040 3456 7890', gstin: '36ABCDE1234F2Z0', stateCode: '36', openingHours: { [tomorrow]: { open: '10:00', close: '20:00' } } }, 201);
    const branchCard = await guests.guestBusinessCard(pool, salon.id, branch.id);
    assert.deepEqual(branchCard.location, { name: 'Jubilee Hills', address: '8-2-293, Road 36', city: 'Hyderabad', postalCode: '500033', phone: '040 3456 7890' });
    // A branch registered on its own sells under its own GSTIN.
    assert.equal(branchCard.seller.gstin, '36ABCDE1234F2Z0');
    assert.deepEqual([branchCard.hours.openNow, branchCard.hours.today, branchCard.hours.opensAt], [false, null, { in: 1, day: tomorrow, time: '10:00' }]);
    // A logo not on https is not shown; no hours set says nothing about them.
    await pool.query("UPDATE business_settings SET logo_path='http://insecure.example.com/logo.png' WHERE business_id=$1", [salon.id]);
    await pool.query('UPDATE business_locations SET opening_hours=NULL WHERE id=$1', [salonMain.id]);
    const plain = await guests.guestBusinessCard(pool, salon.id, salonMain.id);
    assert.equal(plain.logoUrl, null);
    assert.deepEqual(plain.hours, { known: false, openNow: null, today: null, closesAt: null, opensAt: null });
    // Another business's location, or none at all: no card.
    assert.equal(await guests.guestBusinessCard(pool, salon.id, (await mainOf(grocery)).id), null);
    assert.equal(await guests.guestBusinessCard(pool, 987654321, salonMain.id), null);
  });

  await t.test("a guest reads the business's privacy notice by its link, with no login, and nothing else by a made-up one", async () => {
    const ref = card.privacy.url.split('/').pop();
    const answer = await call('GET', `/public/privacy/${ref}`, undefined, null, { Origin: 'https://book.example.com' });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.equal(answer.headers.get('access-control-allow-origin'), 'https://book.example.com');
    assert.deepEqual(answer.body.data.business, { name: 'Shine Salon', logoUrl: null });
    assert.equal(answer.body.data.notice.version, 2);
    assert.equal(answer.body.data.notice.label, 'v2');
    assert.match(answer.body.data.notice.offersText, /at most one a week/);
    assert.equal(answer.body.data.notice.contact, 'Shine Salon (owner), 98450 11111, owner@shine.invalid');
    // A link changed by a character, another business's id with this one's code, a business with no notice, or one switched off.
    const [head, mac] = ref.split('-');
    const groceryRef = guests.privacyRef.refOf(grocery.id);
    const elsewhereRef = guests.privacyRef.refOf(elsewhere.id);
    for (const bad of [`${head}-${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, `${Number(grocery.id).toString(36)}-${mac}`, groceryRef, elsewhereRef, String(salon.id), 'x']) {
      const refused = await call('GET', `/public/privacy/${bad}`);
      assert.equal(refused.status, 404, bad);
      assert.match(refused.body.message, /not available/);
    }
    // The page's foot names the platform from /api/site/info, which answers any web address too;
    // the rest of the public site's routes answer the staff app's addresses only.
    const info = await call('GET', '/site/info', undefined, null, { Origin: 'https://book.example.com' });
    assert.equal(info.status, 200);
    assert.equal(info.headers.get('access-control-allow-origin'), 'https://book.example.com');
    assert.ok(info.body.data.brandName);
    const pricing = await call('GET', '/site/pricing', undefined, null, { Origin: 'https://book.example.com' });
    assert.notEqual(pricing.headers.get('access-control-allow-origin'), 'https://book.example.com');
  });

  // --- The guest rate limit ----------------------------------------------------------------------
  await t.test('a guest limit counts each visitor behind the proxy, or each link, apart', async () => {
    const limited = express();
    limited.set('trust proxy', 1);
    limited.get('/page', guests.guestLimiter({ windowMs: 60000, max: 2 }), (req, res) => res.json({ ok: true }));
    limited.get('/link/:token', guests.guestLimiter({ windowMs: 60000, max: 2, key: (req) => `link:${req.params.token}`, message: 'This link is busy.' }), (req, res) => res.json({ ok: true }));
    mini = await new Promise((resolve) => { const s = limited.listen(0, '127.0.0.1', () => resolve(s)); });
    const at = `http://127.0.0.1:${mini.address().port}`;
    const from = (address) => ({ 'X-Forwarded-For': address });
    const statuses = async (route, addresses) => {
      const out = [];
      for (const address of addresses) out.push((await call('GET', route, undefined, null, from(address), at)).status);
      return out;
    };
    // Per address: two each, whatever the proxy's own address.
    assert.deepEqual(await statuses('/page', ['198.51.100.1', '198.51.100.1', '198.51.100.1', '198.51.100.2']), [200, 200, 429, 200]);
    // One IPv6 network counts as one.
    assert.deepEqual(await statuses('/page', ['2001:db8:1:1::1', '2001:db8:1:1::2', '2001:db8:1:1::3']), [200, 200, 429]);
    // Per link: any address, two each.
    assert.deepEqual(await statuses('/link/abc', ['203.0.113.1', '203.0.113.2', '203.0.113.3']), [200, 200, 429]);
    assert.deepEqual(await statuses('/link/xyz', ['203.0.113.3']), [200]);
    const busy = await call('GET', '/link/abc', undefined, null, from('203.0.113.9'), at);
    assert.deepEqual([busy.status, busy.body], [429, { success: false, message: 'This link is busy.' }]);
    assert.ok(busy.headers.get('ratelimit-policy'));
  });

  // --- This migration's Down half, and Up again ----------------------------------------------------
  await t.test("the migration's Down half takes the guest rule away, and Up brings it back", async () => {
    const file = fs.readdirSync(path.resolve(__dirname, '../../migrations')).find((name) => /^\d+_guest-foundation\.sql$/.test(name));
    const stamp = Number(file.split('_')[0]);
    const shape = async () => (await one(`SELECT
        (SELECT is_nullable FROM information_schema.columns WHERE table_name='business_audit' AND column_name='actor_id') AS actor_nullable,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='business_audit' AND column_name='channel') AS channel,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name='business_contacts' AND column_name='source') AS source`));
    assert.deepEqual(await shape(), { actor_nullable: 'YES', channel: 1, source: 1 });
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.deepEqual(await shape(), { actor_nullable: 'NO', channel: 0, source: 0 });
    // The guests' own rows went with the rule; the staff's stayed.
    assert.equal((await one('SELECT count(*)::int AS n FROM business_audit WHERE actor_id IS NULL')).n, 0);
    assert.ok((await one('SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1', [salon.id])).n > 0);
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await shape(), { actor_nullable: 'YES', channel: 1, source: 1 });
    assert.equal((await one("SELECT count(*)::int AS n FROM business_contacts WHERE source='staff' AND business_id=$1", [salon.id])).n > 0, true);
  });
});
