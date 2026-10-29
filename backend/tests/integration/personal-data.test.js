const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { ZONES, addDays, today } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// Personal data under the DPDP Act 2023 and Rules 2025, for both engines: a
// shop's customers on the shared core and a restaurant's guests. Each
// business publishes a privacy notice in versions with its privacy contact;
// a consent is given per purpose (bills on WhatsApp or SMS, reminders,
// offers) and per business, on the notice shown, and every reminder on
// WhatsApp or SMS checks it; a child is never sent offers; requests are due 90
// days from the day received on the business's own clock, and the bell warns;
// an access request exports everything held; an erasure waits for what is
// still open, anonymises the person and keeps the bills; the breach register
// shows the Board's 72 hours. The clinic's consents and the guest book's
// consent to offers are the same records. Runs on its own throwaway database
// with every migration applied.
test('personal data', { timeout: 900000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, scratch, created = false;
  await admin.connect();
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (scratch) await scratch.end();
    try { if (created && /^rmp_test_[a-f0-9]{20}$/.test(database)) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DB_NAME = database;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.LOGIN_ATTEMPT_LIMIT = '5000';
  const { runner } = await import('node-pg-migrate');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations',
    checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half hands the clinic its consents back; Up takes them over with the guest book\'s consent to offers', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const q = async (sql, values = []) => (await scratch.query(sql, values)).rows;
    const left = async () => (await q(`SELECT
        (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('business_privacy_notices','business_consents','business_children',
          'business_privacy_requests','business_privacy_breaches','business_privacy_breach_people','business_privacy_breach_notices')) AS tables,
        (SELECT count(*)::int FROM pg_proc WHERE proname IN ('business_privacy_erasing','business_privacy_person','business_privacy_erased','business_privacy_today',
          'business_privacy_notice_kept','business_consent_fixed','business_consent_rules','business_child_kept','business_child_rules','business_consent_guest_copy',
          'customers_offers_consent_copy','business_privacy_request_rules','business_privacy_breach_kept','business_privacy_breach_person')) AS functions,
        (SELECT count(*)::int FROM pg_proc WHERE prosrc LIKE '%business_privacy_erasing(TG_TABLE_NAME%') AS guards,
        (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename = 'health_consents') AS clinic,
        (SELECT count(*)::int FROM business_permissions WHERE module_code = 'privacy') + (SELECT count(*)::int FROM permissions WHERE module = 'privacy') AS permissions,
        (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'electronics_repair_jobs' AND column_name = 'customer_phone') AS phone`))[0];
    const after = { tables: 7, functions: 14, guards: 14, clinic: 0, permissions: 6, phone: 'YES' };
    assert.deepEqual(await left(), after);
    // This migration's Down half (it is the newest).
    await migrate({ direction: 'down', count: 1791977000000, timestamp: true });
    assert.deepEqual(await left(), { tables: 0, functions: 0, guards: 0, clinic: 1, permissions: 0, phone: 'NO' });
    // What was there before: a guest who ticked the guest book's offers box,
    // one who did not, and a clinic patient's consents (one withdrawn).
    await scratch.query(`DO $$
      DECLARE r BIGINT; u BIGINT; b BIGINT; c BIGINT;
      BEGIN
        INSERT INTO restaurants(name, code) VALUES ('Old guest book', 'OLD-BOOK') RETURNING id INTO r;
        INSERT INTO restaurant_settings(restaurant_id) VALUES (r);
        INSERT INTO users(restaurant_id, name, email, password_hash) VALUES (r, 'Old book owner', 'old-book@test.invalid', 'not a login') RETURNING id INTO u;
        INSERT INTO customers(restaurant_id, name, mobile, marketing_opt_in, marketing_opt_in_at, marketing_opt_in_by) VALUES (r, 'Asha', '9876500001', TRUE, now() - interval '3 days', u);
        INSERT INTO customers(restaurant_id, name, mobile) VALUES (r, 'Bala', '9876500002');
        INSERT INTO businesses(name, code, business_type) VALUES ('Old clinic', 'OLD-CLINIC', 'healthcare') RETURNING id INTO b;
        INSERT INTO business_contacts(business_id, kind, name, phone) VALUES (b, 'customer', 'Chitra', '9876500003') RETURNING id INTO c;
        INSERT INTO health_patients(business_id, contact_id, patient_no, age_years, sex, registered_by) VALUES (b, c, 'P00001', 30, 'female', u);
        INSERT INTO health_consents(business_id, contact_id, purpose, notice_version, method, given_by, recorded_by) VALUES (b, c, 'treatment', 'v1', 'signed_form', 'Chitra', u);
        INSERT INTO health_consents(business_id, contact_id, purpose, notice_version, method, given_by, recorded_by) VALUES (b, c, 'reminders', 'v1', 'verbal', 'Chitra', u);
        UPDATE health_consents SET withdrawn_at = now(), withdrawn_by = u, withdrawal_reason = 'Asked at the desk' WHERE purpose = 'reminders';
      END $$`);
    await migrate({ direction: 'up', count: Infinity });
    assert.deepEqual(await left(), after);
    const consents = () => q(`SELECT k.purpose, k.channel, k.notice_version, k.method, k.withdrawn_at IS NOT NULL AS withdrawn, k.withdrawal_channel,
        k.customer_id IS NOT NULL AS guest FROM business_consents k ORDER BY k.id`);
    // The clinic's rows keep their ids and details; the guest's consent to offers is brought over.
    assert.deepEqual(await consents(), [
      { purpose: 'treatment', channel: 'counter', notice_version: 'v1', method: 'signed_form', withdrawn: false, withdrawal_channel: null, guest: false },
      { purpose: 'reminders', channel: 'counter', notice_version: 'v1', method: 'verbal', withdrawn: true, withdrawal_channel: 'counter', guest: false },
      { purpose: 'offers', channel: 'import', notice_version: null, method: null, withdrawn: false, withdrawal_channel: null, guest: true },
    ]);
    assert.deepEqual(await q("SELECT name, marketing_opt_in FROM customers WHERE name IN ('Asha', 'Bala') ORDER BY name"),
      [{ name: 'Asha', marketing_opt_in: true }, { name: 'Bala', marketing_opt_in: false }]);
    // The guest's record keeps a copy that only the consents write.
    await assert.rejects(scratch.query("UPDATE customers SET marketing_opt_in = FALSE WHERE name = 'Asha'"), { code: '23514' });
    // A second Down keeps only the clinic's rows in health_consents and the copy on the guest's record.
    await migrate({ direction: 'down', count: 1791977000000, timestamp: true });
    assert.deepEqual(await q('SELECT purpose FROM health_consents ORDER BY id'), [{ purpose: 'treatment' }, { purpose: 'reminders' }]);
    assert.equal((await q("SELECT marketing_opt_in FROM customers WHERE name = 'Asha'"))[0].marketing_opt_in, true);
    await migrate({ direction: 'up', count: Infinity });
    assert.equal((await consents()).length, 3);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Pd-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  async function owner(code) {
    const restaurant = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', [code]);
    await pool.query('INSERT INTO restaurant_settings(restaurant_id) VALUES($1)', [restaurant.id]);
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,restaurant_id', [restaurant.id, code, `${code}@test.invalid`, hash]);
    await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='RESTAURANT_ADMIN' AND restaurant_id IS NULL", [person.id]);
    return person;
  }
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => (await signIn(base, email, password)).token;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  // A refusal with its reason: { status, message, data }.
  const refusal = async (auth, method, route, body) => {
    const result = await call(method, route, body, auth);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const audits = async (businessId, action) => rows('SELECT entity_id, details FROM business_audit WHERE business_id=$1 AND action=$2 ORDER BY id', [businessId, action]);

  // --- The shops ---------------------------------------------------------------------------
  const ownerUser = await owner('pd-owner');
  const ownerToken = await login('pd-owner@test.invalid');
  const request = as(ownerToken);
  const [grocery, gym, mobiles, clinic] = await withTools(request, await createBusinesses(request, 'PD', ['grocery', 'memberships', 'electronics', 'healthcare']));
  // A second shop of the same owner.
  const [corner] = await createBusinesses(request, 'PD2', ['grocery']);
  const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
  const P = (suffix) => G(`privacy/${suffix}`);
  const staff = {};
  for (const template of ['manager', 'cashier', 'accountant', 'viewer']) {
    const person = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id',
      [ownerUser.restaurant_id, `Kirana ${template}`, `pd-${template}@test.invalid`, hash]);
    const token = await login(`pd-${template}@test.invalid`);
    staff[template] = { id: person.id, token, call: as(token) };
  }
  const roles = (await request('GET', G('roles'))).items;
  for (const [template, person] of Object.entries(staff)) {
    await request('POST', G('members'), { userId: person.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
  }
  const location = (await request('GET', G('locations'))).items[0];
  const supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Agarwal Traders' }, 201);
  const sunita = await request('POST', G('contacts'), { kind: 'customer', name: 'Sunita Devi', phone: '98200 22222', creditDays: 7 }, 201);
  const ramesh = await request('POST', G('contacts'), { kind: 'customer', name: 'Ramesh Kumar', phone: '98200 11111' }, 201);
  const rice = await request('POST', G('catalog'), { name: 'Sona Masoori rice', code: 'RICE', kind: 'goods', unit: 'kg', tracking: 'quantity', price: '60', taxRate: '5' }, 201);
  await request('POST', G('documents'), { kind: 'purchase', locationId: location.id, contactId: supplier.id, requestKey: key(), lines: [{ skuId: rice.id, quantity: '100', unitPrice: '45' }] }, 201);
  // Sunita buys on udhaar.
  const sale = await request('POST', G('documents'), { kind: 'sale', locationId: location.id, contactId: sunita.id, requestKey: key(), lines: [{ skuId: rice.id, quantity: '5' }] }, 201);
  let v1, v2;

  await t.test('the permissions: owners and managers keep the registers and export; cashiers and accountants do not; both engines', async () => {
    const role = (template) => roles.find((r) => r.template_code === template);
    for (const code of ['privacy.view', 'privacy.manage', 'privacy.export']) {
      assert.ok(role('manager').permissions.includes(code), `a manager has ${code}`);
      for (const template of ['cashier', 'stock_keeper', 'accountant', 'viewer']) assert.ok(!role(template).permissions.includes(code), `a ${template} has no ${code}`);
    }
    assert.equal(role('owner').full_access, true);
    assert.deepEqual((await rows("SELECT DISTINCT template_code FROM business_role_template_permissions WHERE permission_code LIKE 'privacy.%'")).map((r) => r.template_code), ['manager']);
    const restaurantRoles = await rows(`SELECT r.code, count(*)::int AS n FROM roles r JOIN role_permissions x ON x.role_id = r.id JOIN permissions p ON p.id = x.permission_id
      WHERE r.restaurant_id IS NULL AND p.module = 'privacy' GROUP BY r.code ORDER BY r.code`);
    assert.deepEqual(restaurantRoles, [{ code: 'MANAGER', n: 3 }, { code: 'RESTAURANT_ADMIN', n: 3 }, { code: 'SUPER_ADMIN', n: 3 }]);
    // The registers are the manager's; any member reads the notice the counter shows.
    await staff.manager.call('GET', P('requests'));
    await staff.cashier.call('GET', P('requests'), undefined, 403);
    await staff.accountant.call('GET', P('breaches'), undefined, 403);
    await staff.cashier.call('GET', P(`people/${sunita.id}/export`), undefined, 403);
    await staff.accountant.call('GET', P(`people/${sunita.id}/data`), undefined, 403);
    await staff.viewer.call('GET', P('notice'));
    // It is part of every business, whatever its type.
    for (const business of [gym, mobiles, clinic, corner]) await request('GET', `/businesses/${business.id}/privacy/notice`);
  });

  await t.test('the privacy notice: a starter text that states no period, published in versions with the contact bills print', async () => {
    const fresh = await request('GET', P('notice'));
    assert.equal(fresh.current, null);
    const { starter } = fresh;
    assert.match(starter.notice, /^Sri Ganesh Kirana Stores: how we use your personal data/);
    assert.match(starter.notice, /never a condition of a sale/);
    assert.match(starter.notice, /within 90 days/);
    assert.match(starter.notice, /Data Protection Board/);
    assert.doesNotMatch(starter.notice, /\d+\s*(years?|months?)/i, 'no period of keeping is stated');
    for (const text of [starter.billsText, starter.remindersText, starter.offersText]) assert.ok(text.length >= 20);
    // The bell asks for it.
    const bell = await request('GET', G('notifications'));
    assert.ok(bell.items.some((item) => item.id === 'privacy-notice:none' && item.link.endsWith('/privacy?tab=notice')));
    // Until it is published, no consent is taken on it.
    const early = await refusal(ownerToken, 'POST', P(`people/${sunita.id}/consents`), { purposes: ['reminders'] });
    assert.equal(early.status, 409);
    assert.equal(early.data.reason, 'no_privacy_notice');
    assert.match(early.message, /Settings › Personal data/);

    const body = { ...starter, contactName: 'Lakshmi (owner)', contactPhone: '98450 11111', contactEmail: 'owner@ganesh.invalid', requestKey: key() };
    await staff.cashier.call('POST', P('notices'), body, 403);
    await request('POST', P('notices'), { ...body, notice: 'Too short to say anything', requestKey: key() }, 400);
    await request('POST', P('notices'), { ...body, contactPhone: '', contactEmail: '', requestKey: key() }, 400);
    await request('POST', P('notices'), { ...body, offersText: 'Offers', requestKey: key() }, 400);
    await request('POST', P('notices'), { ...body, requestKey: 'not-a-key' }, 400);
    v1 = await request('POST', P('notices'), body, 201);
    assert.equal(v1.version, 1);
    assert.equal(v1.label, 'v1');
    assert.equal(v1.print_line, 'Your personal data: Lakshmi (owner), 98450 11111, owner@ganesh.invalid');
    // The same request again is the same version; its key with other words is refused.
    assert.equal((await request('POST', P('notices'), body, 201)).id, v1.id);
    await request('POST', P('notices'), { ...body, contactPhone: '98450 22222' }, 409);
    // Bills and receipts print its line.
    const context = await staff.cashier.call('GET', G('context'));
    assert.deepEqual(context.privacy, { version: 1, line: v1.print_line });
    // A published notice is kept as it was.
    await assert.rejects(pool.query("UPDATE business_privacy_notices SET contact_name='Someone else' WHERE id=$1", [v1.id]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM business_privacy_notices WHERE id=$1', [v1.id]), { code: '23514' });
    v2 = await request('POST', P('notices'), { ...body, offersText: 'Send me offers on WhatsApp or SMS, at most one a week. I can stop them at any time.', requestKey: key() }, 201);
    assert.equal(v2.version, 2);
    assert.deepEqual((await request('GET', P('notices'))).map((n) => n.version), [2, 1]);
    await staff.cashier.call('GET', P('notices'), undefined, 403);
    assert.equal((await staff.cashier.call('GET', P('notice'))).current.version, 2);
    assert.equal((await audits(grocery.id, 'privacy_notice.published')).length, 2);
    assert.ok(!(await request('GET', G('notifications'))).items.some((item) => item.id === 'privacy-notice:none'));
    // Each business has its own.
    assert.equal((await request('GET', `/businesses/${corner.id}/privacy/notice`)).current, null);
  });

  await t.test('consent per purpose and per business: one tap at the counter, checked before every reminder on WhatsApp, by SMS or a call, withdrawn', async () => {
    const reminder = (body, token = staff.cashier.token) => refusal(token, 'POST', G(`udhaar/${sunita.id}/reminders`), body);
    let refused = await reminder({ channel: 'whatsapp' });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.data, { reason: 'consent_required', purpose: 'reminders' });
    assert.equal(refused.message, 'Sunita Devi has not agreed to reminders on WhatsApp, SMS or a call. Ask them, and record their consent on their record first.');
    assert.equal((await reminder({ channel: 'sms' })).status, 409);
    assert.equal((await reminder({ channel: 'call' })).status, 409);
    // A visit is not a message: it needs no consent.
    assert.equal((await reminder({ channel: 'visit' })).status, 201);

    await staff.viewer.call('POST', P(`people/${sunita.id}/consents`), { purposes: ['reminders'] }, 403);
    await request('POST', P(`people/${sunita.id}/consents`), { purposes: ['birthday_wishes'] }, 400);
    await request('POST', P(`people/${sunita.id}/consents`), { purposes: [] }, 400);
    await request('POST', P(`people/${sunita.id}/consents`), { purposes: ['reminders'], channel: 'import' }, 400);
    await request('POST', P(`people/${supplier.id}/consents`), { purposes: ['reminders'] }, 404);
    const given = await staff.cashier.call('POST', P(`people/${sunita.id}/consents`), { purposes: ['reminders'] }, 201);
    assert.deepEqual(given.active, ['reminders']);
    const consent = given.consents[0];
    assert.equal(consent.notice_version, 'v2');
    assert.equal(Number(consent.notice_id), Number(v2.id));
    assert.equal(consent.channel, 'counter');
    assert.equal(consent.method, 'verbal');
    assert.equal(Number(consent.recorded_by), Number(staff.cashier.id));
    // A second tap is the same consent.
    assert.equal((await staff.cashier.call('POST', P(`people/${sunita.id}/consents`), { purposes: ['reminders'] }, 201)).consents[0].id, consent.id);
    assert.equal((await reminder({ channel: 'whatsapp', note: 'After salary' })).status, 201);
    const lookup = await staff.cashier.call('GET', P(`consents?people=${sunita.id},${ramesh.id}`));
    assert.deepEqual(lookup.people[sunita.id], { purposes: ['reminders'], child: false, erased: false });
    assert.deepEqual(lookup.people[ramesh.id].purposes, []);
    assert.equal(lookup.notice.version, 2);
    await request('GET', P(`consents?people=${Array.from({ length: 201 }, (_, i) => i + 1).join(',')}`), undefined, 400);

    // Never shared between businesses, even of one owner.
    const there = await request('POST', `/businesses/${corner.id}/contacts`, { kind: 'customer', name: 'Sunita Devi', phone: '98200 22222',
      openingBalance: '200', openingBalanceOn: addDays(today(), -10) }, 201);
    refused = await refusal(ownerToken, 'POST', `/businesses/${corner.id}/udhaar/${there.id}/reminders`, { channel: 'whatsapp' });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.reason, 'consent_required');
    await request('POST', `/businesses/${corner.id}/privacy/people/${sunita.id}/consents`, { purposes: ['reminders'] }, 404);
    await request('GET', `/businesses/${corner.id}/privacy/people/${sunita.id}`, undefined, 404);
    assert.deepEqual((await request('GET', `/businesses/${corner.id}/privacy/consents?people=${sunita.id}`)).people[sunita.id].purposes, []);
    await assert.rejects(pool.query(`INSERT INTO business_consents(business_id,contact_id,purpose,channel,method,recorded_by) VALUES($1,$2,'reminders','import',NULL,NULL)`,
      [corner.id, sunita.id]), (error) => ['23503', '23514'].includes(error.code));

    // Withdrawn when they ask: the next reminder is refused again; the record stays.
    const stopped = await staff.cashier.call('POST', P(`consents/${consent.id}/withdraw`), { reason: 'Said stop on the phone', channel: 'phone' });
    assert.deepEqual(stopped.active, []);
    await staff.cashier.call('POST', P(`consents/${consent.id}/withdraw`), {}, 409);
    await staff.viewer.call('POST', P(`consents/${consent.id}/withdraw`), {}, 403);
    assert.equal((await reminder({ channel: 'whatsapp' })).status, 409);
    const history = await staff.cashier.call('GET', P(`people/${sunita.id}`));
    assert.equal(history.consents.length, 1);
    assert.equal(history.consents[0].withdrawal_channel, 'phone');
    assert.equal(history.consents[0].withdrawal_reason, 'Said stop on the phone');
    assert.equal(history.consents[0].recorded_by_name, 'Kirana cashier');
    // Given again: a new record, on the notice now in force.
    const again = await staff.cashier.call('POST', P(`people/${sunita.id}/consents`), { purposes: ['reminders'], channel: 'phone', method: 'verbal' }, 201);
    assert.notEqual(again.consents[0].id, consent.id);
    assert.equal((await reminder({ channel: 'whatsapp' })).status, 201);

    // The customer form sets them too, in the contact's own save; the phone stays optional.
    const farida = await staff.cashier.call('POST', G('contacts'), { kind: 'customer', name: 'Farida Begum', consents: { bills_digital: true, offers: false } }, 201);
    assert.equal(farida.phone, null);
    assert.deepEqual((await request('GET', P(`consents?people=${farida.id}`))).people[farida.id].purposes, ['bills_digital']);
    await request('PATCH', G(`contacts/${farida.id}`), { name: 'Farida Begum', consents: { bills_digital: false, reminders: true } });
    assert.deepEqual((await request('GET', P(`consents?people=${farida.id}`))).people[farida.id].purposes, ['reminders']);
    await request('POST', G('contacts'), { kind: 'customer', name: 'Wrong purpose', consents: { birthday_wishes: true } }, 400);
    await request('POST', G('contacts'), { kind: 'customer', name: 'Not a yes', consents: { offers: 'yes' } }, 400);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_contacts WHERE business_id=$1 AND name IN ('Wrong purpose','Not a yes')", [grocery.id])).n, 0);

    // The database keeps a consent as given, on the notice it names.
    await assert.rejects(pool.query("UPDATE business_consents SET purpose='offers' WHERE id=$1", [consent.id]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE business_consents SET withdrawal_reason='Changed later' WHERE id=$1", [consent.id]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM business_consents WHERE id=$1', [consent.id]), { code: '23514' });
    await assert.rejects(pool.query(`INSERT INTO business_consents(business_id,contact_id,purpose,notice_id,notice_version,channel,method,recorded_by)
      VALUES($1,$2,'offers',$3,'v9','counter','verbal',$4)`, [grocery.id, ramesh.id, v1.id, ownerUser.id]), { code: '23514' });
    await assert.rejects(pool.query(`INSERT INTO business_consents(business_id,contact_id,purpose,channel,method,recorded_by)
      VALUES($1,$2,'offers','counter','verbal',$3)`, [grocery.id, ramesh.id, ownerUser.id]), { code: '23514' });
    const givenRows = await audits(grocery.id, 'consent.given');
    assert.ok(givenRows.some((row) => Number(row.entity_id) === Number(sunita.id) && row.details.purpose === 'reminders' && row.details.version === 'v2'));
    assert.ok((await audits(grocery.id, 'consent.withdrawn')).some((row) => Number(row.entity_id) === Number(sunita.id) && row.details.channel === 'phone'));
  });

  await t.test('a child is never sent offers: the parent or guardian gives the consent, and the mark ends when it should', async () => {
    const Y = (suffix) => `/businesses/${gym.id}/privacy/${suffix}`;
    await request('POST', Y('notices'), { ...(await request('GET', Y('notice'))).starter, contactName: 'Fit Zone front desk', contactPhone: '98480 33333', requestKey: key() }, 201);
    const arjun = await request('POST', `/businesses/${gym.id}/contacts`, { kind: 'customer', name: 'Arjun Sharma', consents: { offers: true } }, 201);
    assert.deepEqual((await request('GET', Y(`consents?people=${arjun.id}`))).people[arjun.id].purposes, ['offers']);
    const mark = { guardianName: 'Meena Sharma', guardianRelation: 'Mother', consentMethod: 'signed_form', verifiedHow: 'Saw her photo ID at the desk', purposes: ['reminders'] };
    await request('POST', Y(`people/${arjun.id}/child`), { ...mark, purposes: ['offers'] }, 400);
    await request('POST', Y(`people/${arjun.id}/child`), { ...mark, guardianName: '' }, 400);
    const marked = await request('POST', Y(`people/${arjun.id}/child`), mark, 201);
    // Offers stop the moment he is marked; the guardian's consent to reminders is recorded as given by her.
    assert.deepEqual(marked.active, ['reminders']);
    const view = await request('GET', Y(`people/${arjun.id}`));
    assert.equal(view.child.guardian_name, 'Meena Sharma');
    assert.equal(view.child.verified_how, 'Saw her photo ID at the desk');
    assert.equal(view.consents.find((k) => k.purpose === 'reminders').given_by, 'Meena Sharma');
    assert.match(view.consents.find((k) => k.purpose === 'offers').withdrawal_reason, /child/);
    await request('POST', Y(`people/${arjun.id}/child`), mark, 409);
    const refused = await refusal(ownerToken, 'POST', Y(`people/${arjun.id}/consents`), { purposes: ['offers'] });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.reason, 'child');
    await request('PATCH', `/businesses/${gym.id}/contacts/${arjun.id}`, { name: 'Arjun Sharma', consents: { offers: true } }, 409);
    assert.deepEqual((await request('GET', Y(`consents?people=${arjun.id}`))).people[arjun.id], { purposes: ['reminders'], child: true, erased: false });
    // The database refuses it however it is written, and keeps the mark.
    await assert.rejects(pool.query(`INSERT INTO business_consents(business_id,contact_id,purpose,channel,method,recorded_by) VALUES($1,$2,'offers','import',NULL,NULL)`,
      [gym.id, arjun.id]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM business_children WHERE id=$1', [marked.child.id]), { code: '23514' });
    // A person with consent to offers is not marked behind it.
    const neha = await request('POST', `/businesses/${gym.id}/contacts`, { kind: 'customer', name: 'Neha', consents: { offers: true } }, 201);
    await assert.rejects(pool.query('INSERT INTO business_children(business_id,contact_id,guardian_name,consent_method,marked_by) VALUES($1,$2,$3,$4,$5)',
      [gym.id, neha.id, 'Her father', 'verbal', ownerUser.id]), { code: '23514' });
    // The mark ends (he turned 18) with a reason; then he may agree to offers himself.
    await request('POST', Y(`children/${marked.child.id}/end`), {}, 400);
    await request('POST', Y(`children/${marked.child.id}/end`), { reason: 'Turned 18' });
    await request('POST', Y(`children/${marked.child.id}/end`), { reason: 'Again' }, 409);
    assert.deepEqual((await request('POST', Y(`people/${arjun.id}/consents`), { purposes: ['offers'] }, 201)).active.sort(), ['offers', 'reminders']);
    assert.equal((await audits(gym.id, 'person.marked_child')).length, 1);
    assert.deepEqual((await audits(gym.id, 'person.child_mark_ended')).map((row) => row.details.reason), ['Turned 18']);
  });

  let access, late, soon;
  await t.test('requests: received on the business\'s own day, due 90 days on; the bell warns before the due date and once it has passed', async () => {
    // A clock a day away from India's: the request's day is the business's, not the server's.
    const zone = ZONES.find((name) => today(name) !== today('Asia/Kolkata'));
    const D = today(zone);
    await pool.query('UPDATE businesses SET timezone=$2 WHERE id=$1', [grocery.id, zone]);
    const body = { kind: 'access', personId: sunita.id, channel: 'counter', details: 'Wants to see what the shop keeps about her', requestKey: key() };
    await staff.cashier.call('POST', P('requests'), body, 403);
    await request('POST', P('requests'), { ...body, kind: 'complaint' }, 400);
    await request('POST', P('requests'), { ...body, details: '', requestKey: key() }, 400);
    await request('POST', P('requests'), { ...body, receivedOn: addDays(D, 1), requestKey: key() }, 400);
    await request('POST', P('requests'), { ...body, receivedOn: '27/10/2026', requestKey: key() }, 400);
    await request('POST', P('requests'), { ...body, personId: supplier.id, requestKey: key() }, 404);
    access = await staff.manager.call('POST', P('requests'), body, 201);
    assert.equal(access.request_no, 1);
    assert.equal(access.received_on, D);
    assert.equal(access.due_on, addDays(D, 90));
    assert.equal(Number(access.days_left), 90);
    assert.equal(access.person_name, 'Sunita Devi');
    assert.equal(access.status, 'open');
    assert.equal((await staff.manager.call('POST', P('requests'), body, 201)).id, access.id);
    await staff.manager.call('POST', P('requests'), { ...body, details: 'Something else' }, 409);
    await pool.query("UPDATE businesses SET timezone='Asia/Kolkata' WHERE id=$1", [grocery.id]);
    const T = today();
    soon = await request('POST', P('requests'), { kind: 'grievance', personName: 'A walk-in customer', replyTo: '98450 77777', channel: 'phone',
      details: 'Was asked for a phone number at the till', receivedOn: addDays(T, -80), requestKey: key() }, 201);
    late = await request('POST', P('requests'), { kind: 'correction', personId: ramesh.id, details: 'His phone number changed', receivedOn: addDays(T, -95), requestKey: key() }, 201);
    assert.equal(Number(soon.days_left), 10);
    assert.equal(Number(late.days_left), -5);
    const bell = (await request('GET', G('notifications'))).items.filter((item) => item.category === 'Personal data');
    const warning = bell.find((item) => item.id === `privacy-request:${soon.id}:soon`);
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.title, 'Request 2 is due in 10 days');
    assert.ok(warning.link.endsWith(`/privacy?tab=requests&request=${soon.id}`));
    const overdue = bell.find((item) => item.id === `privacy-request:${late.id}:late`);
    assert.equal(overdue.severity, 'critical');
    assert.equal(overdue.title, 'Request 3 is 5 days past its 90 days');
    assert.ok(!bell.some((item) => item.id.startsWith(`privacy-request:${access.id}:`)), 'a request with weeks to go is not in the bell');
    // The bell is for those who keep the register.
    assert.ok(!(await staff.cashier.call('GET', G('notifications'))).items.some((item) => item.category === 'Personal data'));
    // The register lists open requests first, by the day they are due.
    const list = await staff.manager.call('GET', P('requests'));
    assert.equal(list.total, 3);
    assert.deepEqual(list.items.map((r) => r.id), [late.id, soon.id, access.id]);
    assert.equal((await staff.manager.call('GET', P('requests?kind=grievance'))).total, 1);
    // A correction is made on the normal screens, then answered.
    await request('PATCH', G(`contacts/${ramesh.id}`), { name: 'Ramesh Kumar', phone: '98200 99999' });
    await request('POST', P(`requests/${late.id}/close`), { status: 'done' }, 400);
    const closed = await request('POST', P(`requests/${late.id}/close`), { status: 'done', reply: 'Your phone number is now 98200 99999.' });
    assert.equal(closed.status, 'done');
    await request('POST', P(`requests/${late.id}/close`), { status: 'done', reply: 'Again' }, 409);
    // A grievance answered with the reason.
    await request('POST', P(`requests/${soon.id}/close`), { status: 'refused', reply: 'The till asks, and never insists: a phone number stays optional.' });
    assert.ok(!(await request('GET', G('notifications'))).items.some((item) => item.id.startsWith('privacy-request:')));
    // A request is kept as the record.
    await assert.rejects(pool.query("UPDATE business_privacy_requests SET reply='Changed' WHERE id=$1", [late.id]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM business_privacy_requests WHERE id=$1', [soon.id]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE business_privacy_requests SET received_on=received_on - 1, due_on=due_on - 1 WHERE id=$1", [access.id]), { code: '23514' });
    assert.equal((await audits(grocery.id, 'privacy_request.logged')).length, 3);
    assert.deepEqual((await audits(grocery.id, 'privacy_request.closed')).map((row) => row.details.status), ['done', 'refused']);
  });

  await t.test('an access request: everything the shop holds about the person, across its modules, as a file; each view and export logged', async () => {
    const file = await staff.manager.call('GET', P(`people/${sunita.id}/export?requestId=${access.id}`));
    assert.match(file.filename, new RegExp(`^personal-data-customer-${sunita.id}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
    assert.equal(file.data.business, 'Sri Ganesh Kirana Stores');
    assert.equal(file.data.request, 1);
    assert.equal(file.data.person.name, 'Sunita Devi');
    const headings = file.data.sections.map((s) => s.heading);
    for (const heading of ['Bills, invoices and credit notes', 'Bill lines', 'Dues reminders sent']) assert.ok(headings.includes(heading), heading);
    assert.equal(file.data.sections.find((s) => s.heading === 'Bills, invoices and credit notes').rows[0].contact_name, 'Sunita Devi');
    assert.ok(file.data.consents.length >= 2);
    assert.equal(file.data.requests[0].kind, 'access');
    assert.doesNotMatch(JSON.stringify(file.data), /request_hash|request_key/);
    await request('GET', P(`people/${sunita.id}/export?requestId=999999`), undefined, 404);
    await request('GET', P(`people/${supplier.id}/export`), undefined, 404);
    const exported = await audits(grocery.id, 'personal_data.exported');
    assert.equal(exported.length, 1);
    assert.equal(Number(exported[0].entity_id), Number(sunita.id));
    assert.equal(Number(exported[0].details.requestId), Number(access.id));
    await staff.manager.call('GET', P(`people/${sunita.id}/data`));
    assert.equal((await audits(grocery.id, 'personal_data.viewed')).length, 1);
    await request('POST', P(`requests/${access.id}/close`), { status: 'done', reply: 'Sent her the file of her data on WhatsApp.' });
  });

  await t.test('erasure: waits for money owed, then anonymises the person everywhere, keeps the bills and the consents, and closes the request', async () => {
    const asked = await request('POST', P('requests'), { kind: 'erasure', personId: sunita.id, details: 'Asked to erase her details', requestKey: key() }, 201);
    let refused = await refusal(ownerToken, 'POST', P(`requests/${asked.id}/close`), { status: 'done', reply: 'Done' });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.reason, 'not_erased');
    const eraseKey = key();
    await staff.cashier.call('POST', P(`requests/${asked.id}/erase`), { requestKey: eraseKey }, 403);
    await request('POST', P(`requests/${access.id}/erase`), { requestKey: key() }, 409);
    refused = await refusal(ownerToken, 'POST', P(`requests/${asked.id}/erase`), { requestKey: eraseKey });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.reason, 'erasure_blocked');
    assert.match(refused.data.open[0], new RegExp(`They owe ₹${Number(sale.total).toFixed(2)}: settle it first`));
    assert.match((await request('GET', P(`requests/${asked.id}`))).open[0], /They owe/);
    // A request names its person before it erases anyone.
    const unnamed = await request('POST', P('requests'), { kind: 'erasure', personName: 'Someone who rang', channel: 'phone', details: 'Erase my number', requestKey: key() }, 201);
    refused = await refusal(ownerToken, 'POST', P(`requests/${unnamed.id}/erase`), { requestKey: key() });
    assert.equal(refused.data.reason, 'no_person');
    assert.equal(Number((await request('POST', P(`requests/${unnamed.id}/person`), { personId: ramesh.id })).contact_id), Number(ramesh.id));
    await request('POST', P(`requests/${unnamed.id}/close`), { status: 'refused', reply: 'We could not confirm the caller was Ramesh: please ask at the counter.' });

    // She settles her udhaar; then her data is erased.
    await request('POST', G(`udhaar/${sunita.id}/collections`), { locationId: location.id, amount: sale.total, method: 'cash', requestKey: key() }, 201);
    const done = await request('POST', P(`requests/${asked.id}/erase`), { requestKey: eraseKey });
    assert.equal(done.status, 'done');
    assert.ok(done.erased_at);
    assert.match(done.reply, /^Your personal details were erased on \d{4}-\d{2}-\d{2}\. Bills and other tax records keep what tax law needs/);
    assert.ok(done.erasure.erased.some((e) => e.heading === 'Customer record'));
    assert.ok(done.erasure.kept.some((line) => /^Bills, invoices and credit notes: Tax records/.test(line)), 'what is kept for tax law is listed for the accountant');
    assert.ok(done.erasure.kept.includes('The activity log, kept at least a year as the DPDP Rules ask of processing logs.'));
    // The same request again is the same erasure; another is refused.
    assert.equal((await request('POST', P(`requests/${asked.id}/erase`), { requestKey: eraseKey })).erased_at, done.erased_at);
    await request('POST', P(`requests/${asked.id}/erase`), { requestKey: key() }, 409);
    // The record is nameless; the bill keeps the name it was made out to.
    assert.deepEqual(await one('SELECT name, phone, email, active FROM business_contacts WHERE id=$1', [sunita.id]),
      { name: `Erased customer #${sunita.id}`, phone: null, email: null, active: false });
    assert.deepEqual(await one('SELECT contact_id, contact_name, total FROM business_documents WHERE id=$1', [sale.id]),
      { contact_id: sunita.id, contact_name: 'Sunita Devi', total: sale.total });
    // Her consents stop and stay as the record.
    const kept = await rows('SELECT withdrawn_at IS NOT NULL AS withdrawn, withdrawal_reason FROM business_consents WHERE business_id=$1 AND contact_id=$2 ORDER BY id', [grocery.id, sunita.id]);
    assert.deepEqual(kept, [{ withdrawn: true, withdrawal_reason: 'Said stop on the phone' },
      { withdrawn: true, withdrawal_reason: 'The customer\'s data was erased at their request' }]);
    assert.deepEqual((await request('GET', P(`consents?people=${sunita.id}`))).people[sunita.id], { purposes: [], child: false, erased: true });
    // Nothing more is recorded or changed for her.
    assert.equal((await refusal(ownerToken, 'POST', P(`people/${sunita.id}/consents`), { purposes: ['reminders'] })).status, 409);
    await request('PATCH', G(`contacts/${sunita.id}`), { name: 'Sunita Devi' }, 409);
    assert.ok(!(await request('GET', P('people?q=Sunita'))).some((p) => Number(p.id) === Number(sunita.id)));
    const erased = await audits(grocery.id, 'personal_data.erased');
    assert.equal(erased.length, 1);
    assert.equal(Number(erased[0].entity_id), Number(sunita.id));
    assert.equal(Number(erased[0].details.requestId), Number(asked.id));
  });

  await t.test('a repair taken in without a phone; a closed job card is anonymised by an erasure and by nothing else', async () => {
    const E = (suffix) => `/businesses/${mobiles.id}/${suffix}`;
    const shop = (await request('GET', E('locations'))).items[0];
    const walkIn = await request('POST', E('repairs'), { locationId: shop.id, customerName: 'Imran', device: 'Orbit 5G', problem: 'Battery drains by noon', requestKey: key() }, 201);
    assert.equal(walkIn.customer_phone, null);
    const imran = await request('POST', E('contacts'), { kind: 'customer', name: 'Imran Khan', phone: '99000 66666' }, 201);
    const job = await request('POST', E('repairs'), { locationId: shop.id, contactId: imran.id, device: 'Orbit 5G', problem: 'Screen cracked', passcode: '1 4 7 8', requestKey: key() }, 201);
    assert.equal(job.customer_phone, '99000 66666');
    await request('POST', E(`repairs/${job.id}/cancel`), { reason: 'Customer took it back' });
    await assert.rejects(pool.query("UPDATE electronics_repair_jobs SET customer_name='Someone' WHERE id=$1", [job.id]), { code: '23514' });
    await request('POST', E('privacy/notices'), { ...(await request('GET', E('privacy/notice'))).starter, contactName: 'City Mobiles', contactPhone: '99000 11111', requestKey: key() }, 201);
    const asked = await request('POST', E('privacy/requests'), { kind: 'erasure', personId: imran.id, details: 'Erase my details', requestKey: key() }, 201);
    const done = await request('POST', E(`privacy/requests/${asked.id}/erase`), { requestKey: key() });
    assert.ok(done.erasure.erased.some((e) => e.heading === 'Repairs' && e.rows === 1));
    assert.deepEqual(await one('SELECT customer_name, customer_phone, phone_digits, status FROM electronics_repair_jobs WHERE id=$1', [job.id]),
      { customer_name: `Erased customer #${imran.id}`, customer_phone: null, phone_digits: null, status: 'cancelled' });
    // Still nothing else on the closed job changes.
    await assert.rejects(pool.query("UPDATE electronics_repair_jobs SET problem='Changed' WHERE id=$1", [job.id]), { code: '23514' });
  });

  await t.test('a clinic: the patient\'s consents are the same records, and a patient\'s data stays with the medical records', async () => {
    const K = (suffix) => `/businesses/${clinic.id}/${suffix}`;
    const patient = await request('POST', K('clinic/patients'), { name: 'Swathi Reddy', sex: 'female', ageYears: 34,
      consent: { purposes: ['treatment', 'reminders'], method: 'signed_form', givenBy: 'Self' } }, 201);
    const view = await request('GET', K(`privacy/people/${patient.contact_id}`));
    assert.deepEqual(view.active.sort(), ['reminders', 'treatment']);
    assert.ok(view.consents.every((k) => k.notice_version === 'v1' && k.notice_id === null && k.method === 'signed_form'), 'given on the clinic\'s own consent notice');
    assert.equal((await audits(clinic.id, 'patient.consent_given')).length, 2);
    // Bills on WhatsApp are given on the clinic's privacy notice, once published.
    assert.equal((await refusal(ownerToken, 'POST', K(`privacy/people/${patient.contact_id}/consents`), { purposes: ['bills_digital'] })).data.reason, 'no_privacy_notice');
    await request('POST', K('privacy/notices'), { ...(await request('GET', K('privacy/notice'))).starter, contactName: 'Lifeline front desk', contactPhone: '90000 12345', requestKey: key() }, 201);
    await request('POST', K(`privacy/people/${patient.contact_id}/consents`), { purposes: ['bills_digital'] }, 201);
    const asked = await request('POST', K('privacy/requests'), { kind: 'erasure', personId: patient.contact_id, details: 'Erase my details', requestKey: key() }, 201);
    const refused = await refusal(ownerToken, 'POST', K(`privacy/requests/${asked.id}/erase`), { requestKey: key() });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.reason, 'erasure_blocked');
    assert.match(refused.data.open.join(' '), /registered patient: medical records are kept/);
  });

  await t.test('the breach register: the Board\'s 72 hours, the people affected, each notice sent, closed only after the report', async () => {
    const foundAt = new Date(Date.now() - 70 * 3600000).toISOString();
    const gopal = await request('POST', G('contacts'), { kind: 'customer', name: 'Gopal', phone: '98200 33333' }, 201);
    const farida = await one("SELECT id FROM business_contacts WHERE business_id=$1 AND name='Farida Begum'", [grocery.id]);
    const body = { foundAt, whatHappened: 'The counter laptop with the customer list was stolen from the shop', impact: 'Customers\' names and phone numbers may be seen by others',
      stepsTaken: 'Changed every password and told the police', affected: 'chosen', people: [ramesh.id], requestKey: key() };
    await staff.cashier.call('POST', P('breaches'), body, 403);
    await request('POST', P('breaches'), { ...body, foundAt: new Date(Date.now() + 86400000).toISOString(), requestKey: key() }, 400);
    await request('POST', P('breaches'), { ...body, whatHappened: 'Stolen', requestKey: key() }, 400);
    await request('POST', P('breaches'), { ...body, affected: 'some', requestKey: key() }, 400);
    const breach = await request('POST', P('breaches'), body, 201);
    assert.equal(breach.breach_no, 1);
    assert.equal(new Date(breach.board_due_at).getTime(), new Date(foundAt).getTime() + 72 * 3600000);
    assert.equal((await request('POST', P('breaches'), body, 201)).id, breach.id);
    await request('POST', P('breaches'), { ...body, impact: 'Something else' }, 409);
    const seen = await request('GET', P(`breaches/${breach.id}`));
    assert.ok(seen.hours_left > 1.5 && seen.hours_left <= 2.1, `${seen.hours_left} hours left`);
    assert.equal(seen.affected_count, 1);
    assert.equal(Number(seen.people[0].person_id), Number(ramesh.id));
    // The notice to the people is filled from the record, with the contact.
    assert.match(seen.people_notice_text, /^Sri Ganesh Kirana Stores: about your personal data/);
    assert.match(seen.people_notice_text, /stolen from the shop/);
    assert.match(seen.people_notice_text, /contact Lakshmi \(owner\), 98450 11111, owner@ganesh\.invalid\./);
    let bell = (await request('GET', G('notifications'))).items.find((item) => item.id === `privacy-breach:${breach.id}:open`);
    assert.equal(bell.severity, 'critical');
    assert.equal(bell.title, 'Breach 1: the Board\'s report is due in 2 hours');
    // People are added by search; a notice goes to each, as sent by the shop itself.
    assert.deepEqual(await request('POST', P(`breaches/${breach.id}/people`), { personIds: [farida.id] }), { added: 1 });
    await request('POST', P(`breaches/${breach.id}/people`), { personIds: [] }, 400);
    await request('POST', P(`breaches/${breach.id}/people`), { personIds: [supplier.id] }, 404);
    const noticeKey = key();
    const notice = await request('POST', P(`breaches/${breach.id}/notices`), { personId: ramesh.id, channel: 'whatsapp', requestKey: noticeKey }, 201);
    assert.equal(notice.notice_text, seen.people_notice_text);
    assert.equal((await request('POST', P(`breaches/${breach.id}/notices`), { personId: ramesh.id, channel: 'whatsapp', requestKey: noticeKey }, 201)).id, notice.id);
    await request('POST', P(`breaches/${breach.id}/notices`), { personId: ramesh.id, channel: 'sms', requestKey: noticeKey }, 409);
    await request('POST', P(`breaches/${breach.id}/notices`), { personId: gopal.id, channel: 'whatsapp', requestKey: key() }, 409);
    await request('POST', P(`breaches/${breach.id}/notices`), { personId: ramesh.id, channel: 'telegram', requestKey: key() }, 400);
    // Someone a notice went to stays on the breach; someone not yet told can be taken off.
    await request('DELETE', P(`breaches/${breach.id}/people/${ramesh.id}`), undefined, 409);
    await request('DELETE', P(`breaches/${breach.id}/people/${farida.id}`));
    await request('DELETE', P(`breaches/${breach.id}/people/${farida.id}`), undefined, 404);
    await assert.rejects(pool.query('DELETE FROM business_privacy_breach_notices WHERE id=$1', [notice.id]), { code: '23514' });
    const sent = await audits(grocery.id, 'breach.notice_sent');
    assert.equal(sent.length, 1);
    assert.equal(Number(sent[0].details.personId), Number(ramesh.id));
    assert.equal(sent[0].details.channel, 'whatsapp');
    // Closed only once the detailed report to the Board is recorded; it files nothing itself.
    const refused = await refusal(ownerToken, 'POST', P(`breaches/${breach.id}/close`));
    assert.equal(refused.status, 409);
    assert.equal(refused.data.reason, 'board_report');
    await request('PATCH', P(`breaches/${breach.id}`), { boardReportAt: new Date(Date.now() - 71 * 3600000).toISOString() }, 400);
    await request('PATCH', P(`breaches/${breach.id}`), { boardReportAt: new Date(Date.now() + 86400000).toISOString() }, 400);
    await request('PATCH', P(`breaches/${breach.id}`), { peopleNotice: 'Too short' }, 400);
    const reported = await request('PATCH', P(`breaches/${breach.id}`), { boardInformedAt: new Date(Date.now() - 60 * 3600000).toISOString(),
      boardReportAt: new Date(Date.now() - 3600000).toISOString(), boardReference: 'DPB/2026/0042' });
    assert.equal(reported.board_reference, 'DPB/2026/0042');
    assert.ok(!(await request('GET', G('notifications'))).items.some((item) => item.id.startsWith(`privacy-breach:${breach.id}:`)));
    assert.equal((await request('POST', P(`breaches/${breach.id}/close`))).status, 'closed');
    await request('POST', P(`breaches/${breach.id}/close`), undefined, 409);
    await request('PATCH', P(`breaches/${breach.id}`), { impact: 'Changed later' }, 409);
    await request('POST', P(`breaches/${breach.id}/notices`), { personId: ramesh.id, channel: 'sms', requestKey: key() }, 409);
    await assert.rejects(pool.query("UPDATE business_privacy_breaches SET impact='Changed later' WHERE id=$1", [breach.id]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM business_privacy_breaches WHERE id=$1', [breach.id]), { code: '23514' });

    // A breach of every customer: counted from the customers (an erased one is not), and its report late.
    const everyone = await request('POST', P('breaches'), { ...body, affected: 'all', people: undefined, foundAt: new Date(Date.now() - 80 * 3600000).toISOString(), requestKey: key() }, 201);
    const customers = (await one("SELECT count(*)::int AS n FROM business_contacts WHERE business_id=$1 AND kind='customer' AND erased_at IS NULL", [grocery.id])).n;
    assert.equal((await request('GET', P(`breaches/${everyone.id}`))).affected_count, customers);
    const page = await request('GET', P('everyone?limit=2'));
    assert.equal(page.total, customers);
    assert.equal(page.items.length, 2);
    await request('POST', P(`breaches/${everyone.id}/people`), { personIds: [gopal.id] }, 409);
    await request('POST', P(`breaches/${everyone.id}/notices`), { personId: gopal.id, channel: 'in_person', requestKey: key() }, 201);
    bell = (await request('GET', G('notifications'))).items.find((item) => item.id === `privacy-breach:${everyone.id}:late`);
    assert.equal(bell.title, 'Breach 2: the Board\'s report is 8 hours late');
    assert.deepEqual((await request('GET', P('breaches'))).items.map((b) => b.id), [everyone.id, breach.id]);
    assert.equal((await audits(grocery.id, 'breach.recorded')).length, 2);
    assert.equal((await audits(grocery.id, 'breach.closed')).length, 1);
  });

  await t.test('every table holding a customer contact is placed in the registry: erased, kept with its reason, or not a customer\'s', async () => {
    const registry = require('../../src/modules/personal-data/services/personalDataRegistry');
    const references = await rows(`SELECT t.relname AS table_name, array_length(k.conkey, 1) AS columns FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public' WHERE k.contype = 'f' AND k.confrelid = 'business_contacts'::regclass ORDER BY 1`);
    const tables = [...new Set(references.map((r) => r.table_name))];
    assert.deepEqual(tables.filter((name) => !registry.TABLES[name]), [], 'a table that points at a customer contact must be placed in personalDataRegistry.js');
    assert.deepEqual(Object.keys(registry.TABLES).filter((name) => !tables.includes(name)), [], 'the registry names only tables that point at a customer contact');
    assert.deepEqual(references.filter((r) => Number(r.columns) !== 2), [], 'every customer reference is (business_id, contact_id), as the export reads it');
    for (const [table, entry] of Object.entries(registry.TABLES)) {
      assert.equal([entry.erase, entry.keep, entry.party, entry.own, entry.secret].filter(Boolean).length, 1, `${table} is erased, kept, a supplier's, this module's own, or never shown`);
      if (!entry.erase) continue;
      const columns = await rows("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table]);
      for (const [column, value] of Object.entries(entry.erase)) {
        const found = columns.find((c) => c.column_name === column);
        assert.ok(found, `${table}.${column} exists`);
        if (value === null) assert.equal(found.is_nullable, 'YES', `${table}.${column} can be blanked`);
      }
    }
    // A closed record's guard lets through exactly the columns the registry blanks.
    const source = (await one("SELECT prosrc FROM pg_proc WHERE proname='business_privacy_erasing'")).prosrc;
    const guarded = [...source.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)];
    assert.equal(guarded.length, 14);
    for (const [, table, list] of guarded) {
      assert.deepEqual(list.match(/'(\w+)'/g).map((s) => s.slice(1, -1)).sort(), Object.keys(registry.TABLES[table].erase).sort(), table);
    }
  });

  // --- The restaurant ------------------------------------------------------------------------
  const restaurantService = require('../../src/modules/restaurant/setup/services/restaurant.service');
  const cafe = await restaurantService.createRestaurant({ name: 'Udupi Grand', code: 'UDUPI-PD', invoicePrefix: 'UG', admin: { name: 'Udupi owner', email: 'udupi@test.invalid', password } });
  await restaurantService.createRestaurant({ name: 'Other Cafe', code: 'OTHER-PD', admin: { name: 'Other owner', email: 'other-cafe@test.invalid', password } });
  const restaurantStaff = async (name, email, role) => {
    const row = await one('INSERT INTO users (restaurant_id, name, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING id', [cafe.id, name, email, hash]);
    await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 AND restaurant_id IS NULL', [row.id, role]);
    return as(await login(email));
  };
  const udupiToken = await login('udupi@test.invalid');
  const R = as(udupiToken);
  const otherCafe = as(await login('other-cafe@test.invalid'));
  const cafeManager = await restaurantStaff('Udupi manager', 'udupi-manager@test.invalid', 'MANAGER');
  const cafeCashier = await restaurantStaff('Udupi cashier', 'udupi-cashier@test.invalid', 'CASHIER');
  const cafeKitchen = await restaurantStaff('Udupi kitchen', 'udupi-kitchen@test.invalid', 'KITCHEN');
  const udupiOwner = await one("SELECT id FROM users WHERE email='udupi@test.invalid'");
  const food = (await R('GET', '/menu/tax-rates')).find((r) => r.isDefault);
  const mains = await R('POST', '/menu/categories', { name: 'Tiffins' }, 201);
  const dosa = await R('POST', '/menu/products', { categoryId: mains.id, name: 'Masala dosa', price: 120, taxRateId: food.id, isAvailable: true }, 201);
  const birthday = `1994-${today().slice(5)}`;
  let notice, kavya, bindu, chetan;

  await t.test('a restaurant: its own notice and contact, its guests\' consents per purpose, the copy the guest book keeps, and no offers to a child', async () => {
    const fresh = await R('GET', '/privacy/notice');
    assert.equal(fresh.current, null);
    assert.match(fresh.starter.notice, /^Udupi Grand: how we use your personal data/);
    assert.match(fresh.starter.notice, /allergies/);
    // Before it is published, a guest added with a consent is refused, and nobody is added.
    const early = await refusal(udupiToken, 'POST', '/crm/customers', { name: 'Kavya Rao', mobile: '9876500077', consents: { offers: true } });
    assert.equal(early.status, 409);
    assert.equal(early.data.reason, 'no_privacy_notice');
    assert.equal((await one("SELECT count(*)::int AS n FROM customers WHERE restaurant_id=$1 AND name='Kavya Rao'", [cafe.id])).n, 0);
    await cafeCashier('POST', '/privacy/notices', { ...fresh.starter, contactName: 'Front desk', contactPhone: '040 2345 6789', requestKey: key() }, 403);
    notice = await R('POST', '/privacy/notices', { ...fresh.starter, contactName: 'Udupi Grand front desk', contactPhone: '040 2345 6789', requestKey: key() }, 201);
    assert.equal(notice.version, 1);
    assert.equal((await R('GET', '/restaurants/current/settings')).privacyLine, 'Your personal data: Udupi Grand front desk, 040 2345 6789');
    assert.equal((await one('SELECT legacy_restaurant_id FROM businesses WHERE id=(SELECT business_id FROM business_privacy_notices WHERE id=$1)', [notice.id])).legacy_restaurant_id, cafe.id);

    kavya = await R('POST', '/crm/customers', { name: 'Kavya Rao', mobile: '9876500077', dateOfBirth: birthday, consents: { offers: true, bills_digital: true } }, 201);
    assert.equal(kavya.marketingOptIn, true);
    assert.deepEqual(await one('SELECT marketing_opt_in, marketing_opt_in_by FROM customers WHERE id=$1', [kavya.id]), { marketing_opt_in: true, marketing_opt_in_by: udupiOwner.id });
    const consents = await rows('SELECT purpose, notice_version, channel, method, recorded_by FROM business_consents WHERE customer_id=$1 ORDER BY purpose', [kavya.id]);
    assert.deepEqual(consents.map((k) => [k.purpose, k.notice_version, k.channel, k.method]), [['bills_digital', 'v1', 'counter', 'verbal'], ['offers', 'v1', 'counter', 'verbal']]);
    const logged = await rows("SELECT action, entity_label FROM audit_logs WHERE restaurant_id=$1 AND entity_type='customer' AND entity_id=$2 AND action='consent_given'", [cafe.id, kavya.id]);
    assert.equal(logged.length, 2);
    assert.ok(logged.every((row) => row.entity_label === `Guest #${kavya.id}`), 'logged by number, never by name');
    // The older box on the form is consent to offers.
    bindu = await R('POST', '/crm/customers', { name: 'Bindu', mobile: '9876500078', dateOfBirth: birthday, marketingOptIn: true }, 201);
    assert.deepEqual((await R('GET', `/privacy/consents?people=${bindu.id}`)).people[bindu.id].purposes, ['offers']);
    chetan = await R('POST', '/crm/customers', { name: 'Chetan', mobile: '9876500079', dateOfBirth: birthday }, 201);
    // Only the consents write the guest's copy.
    await assert.rejects(pool.query('UPDATE customers SET marketing_opt_in=FALSE WHERE id=$1', [kavya.id]), { code: '23514' });
    // Withdrawn on the guest's form.
    await R('PUT', `/crm/customers/${bindu.id}`, { name: 'Bindu', mobile: '9876500078', consents: { offers: false } });
    assert.equal((await one('SELECT marketing_opt_in FROM customers WHERE id=$1', [bindu.id])).marketing_opt_in, false);
    assert.equal((await rows("SELECT 1 FROM audit_logs WHERE restaurant_id=$1 AND entity_id=$2 AND action='consent_withdrawn'", [cafe.id, bindu.id])).length, 1);
    // A cashier takes guests, and their consents; the kitchen does not.
    await cafeKitchen('POST', `/privacy/people/${kavya.id}/consents`, { purposes: ['reminders'] }, 403);
    assert.deepEqual((await cafeCashier('POST', `/privacy/people/${kavya.id}/consents`, { purposes: ['reminders'] }, 201)).active.sort(), ['bills_digital', 'offers', 'reminders']);
    // A child: offers stop, and are never taken.
    const marked = await R('POST', `/privacy/people/${chetan.id}/child`, { guardianName: 'Lata (mother)', consentMethod: 'verbal', purposes: ['bills_digital'] }, 201);
    assert.deepEqual(marked.active, ['bills_digital']);
    const refused = await refusal(udupiToken, 'POST', `/privacy/people/${chetan.id}/consents`, { purposes: ['offers'] });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.reason, 'child');
    await R('PUT', `/crm/customers/${chetan.id}`, { name: 'Chetan', mobile: '9876500079', consents: { offers: true } }, 409);
    assert.equal((await one('SELECT marketing_opt_in FROM customers WHERE id=$1', [chetan.id])).marketing_opt_in, false);
    // Another restaurant never sees them.
    await otherCafe('GET', `/privacy/people/${kavya.id}`, undefined, 404);
    await otherCafe('POST', `/privacy/people/${kavya.id}/consents`, { purposes: ['offers'] }, 404);
    assert.deepEqual((await otherCafe('GET', `/privacy/consents?people=${kavya.id}`)).people[kavya.id].purposes, []);
  });

  await t.test('a restaurant: the mobiles copied for a broadcast of offers are only the guests who agreed, never a child', async () => {
    const list = await R('POST', '/guest-insights/segments/birthdays/export', { format: 'mobiles' });
    assert.deepEqual(list.items.map((row) => Number(row.id)), [Number(kavya.id)]);
    assert.equal(list.leftOut, 2);
    const logged = await one("SELECT details FROM audit_logs WHERE restaurant_id=$1 AND action='export' AND entity_type='guest_list' ORDER BY id DESC LIMIT 1", [cafe.id]);
    assert.equal(logged.details.leftOut, 2);
    // The CSV of the list is not a broadcast: everyone on it.
    assert.equal((await R('POST', '/guest-insights/segments/birthdays/export', { format: 'csv' })).total, 3);
  });

  await t.test('a restaurant: requests on its own clock, an advance holding an erasure back, the guest book\'s erasure in the register, the export', async () => {
    const settings = await one('SELECT timezone FROM restaurant_settings WHERE restaurant_id=$1', [cafe.id]);
    const zone = ZONES.find((name) => today(name) !== today(settings.timezone || 'Asia/Kolkata'));
    await pool.query('UPDATE restaurant_settings SET timezone=$2 WHERE restaurant_id=$1', [cafe.id, zone]);
    const asked = await R('POST', '/privacy/requests', { kind: 'erasure', personId: kavya.id, details: 'Asked to delete her details', requestKey: key() }, 201);
    assert.equal(asked.received_on, today(zone));
    assert.equal(asked.due_on, addDays(today(zone), 90));
    await pool.query('UPDATE restaurant_settings SET timezone=$2 WHERE restaurant_id=$1', [cafe.id, settings.timezone]);
    await cafeCashier('GET', '/privacy/requests', undefined, 403);
    assert.equal((await cafeManager('GET', '/privacy/requests')).total, 1);
    // Her advance is still with the restaurant.
    await R('POST', '/business-day/open', { openingCash: 1000 }, 201);
    await R('POST', '/bills/advances', { customerId: kavya.id, amount: 200, paymentMethod: 'cash', purpose: 'Birthday cake' }, 201);
    let refused = await refusal(udupiToken, 'POST', `/privacy/requests/${asked.id}/erase`, { requestKey: key() });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.reason, 'erasure_blocked');
    assert.match(refused.data.open[0], /advance of ₹200\.00 left/);
    refused = await refusal(udupiToken, 'POST', `/crm/customers/${kavya.id}/erase`, { reason: 'Asked' });
    assert.equal(refused.data.reason, 'erasure_blocked');
    // Her export: what the restaurant holds, logged against her number.
    await cafeCashier('GET', `/privacy/people/${kavya.id}/export`, undefined, 403);
    const file = await R('GET', `/privacy/people/${kavya.id}/export?requestId=${asked.id}`);
    assert.match(file.filename, new RegExp(`^personal-data-guest-${kavya.id}-`));
    assert.equal(file.data.person.name, 'Kavya Rao');
    assert.ok(file.data.sections.some((s) => s.heading === 'Advances'));
    assert.equal(file.data.consents.length, 3);
    assert.equal((await rows("SELECT 1 FROM audit_logs WHERE restaurant_id=$1 AND action='export_data' AND entity_type='customer' AND entity_id=$2", [cafe.id, kavya.id])).length, 1);
    // Bindu has nothing open: erased from her request.
    const askedB = await R('POST', '/privacy/requests', { kind: 'erasure', personId: bindu.id, details: 'Erase my details', requestKey: key() }, 201);
    const done = await R('POST', `/privacy/requests/${askedB.id}/erase`, { requestKey: key() });
    assert.equal(done.status, 'done');
    assert.ok(done.erasure.kept.some((line) => /^Bills: amounts, GST and the bill numbers stay/.test(line)));
    assert.deepEqual(await one('SELECT name, mobile FROM customers WHERE id=$1', [bindu.id]), { name: `Erased guest #${bindu.id}`, mobile: null });
    assert.ok((await rows('SELECT withdrawn_at FROM business_consents WHERE customer_id=$1', [bindu.id])).every((row) => row.withdrawn_at));
    assert.equal((await rows("SELECT 1 FROM audit_logs WHERE restaurant_id=$1 AND action='erase' AND entity_type='customer' AND entity_id=$2", [cafe.id, bindu.id])).length, 1);
    // The guest book's own erasure is kept in the register as a request received and done today.
    const dinesh = await R('POST', '/crm/customers', { name: 'Dinesh', mobile: '9876500080' }, 201);
    await R('POST', `/crm/customers/${dinesh.id}/erase`, { reason: 'Asked at the counter to be forgotten' });
    const register = await R('GET', '/privacy/requests?kind=erasure');
    const entry = register.items.find((r) => Number(r.customer_id) === Number(dinesh.id));
    assert.equal(entry.status, 'done');
    assert.equal(entry.person_name, `Guest #${dinesh.id}`);
    assert.equal(entry.details, 'Asked at the counter to be forgotten');
    assert.ok(entry.erased_at);
    // The restaurant's bell: a request with ten days left.
    await R('POST', '/privacy/requests', { kind: 'grievance', personName: 'A guest on the phone', details: 'Got an offer after saying no', receivedOn: addDays(today(), -80), requestKey: key() }, 201);
    const bell = (await R('GET', '/notifications')).items.filter((item) => item.source === 'privacy');
    assert.ok(bell.some((item) => item.severity === 'warning' && /is due in 10 days/.test(item.title) && item.link.startsWith('/privacy?tab=requests&request=')));
    assert.ok(!(await cafeCashier('GET', '/notifications')).items.some((item) => item.source === 'privacy'));
  });

  await t.test('a restaurant: a breach and the notice sent to a guest, on its own activity log', async () => {
    const breach = await R('POST', '/privacy/breaches', { foundAt: new Date(Date.now() - 3600000).toISOString(), whatHappened: 'A printed list of delivery addresses was left in a rider\'s bag',
      impact: 'Addresses of last week\'s delivery guests', stepsTaken: 'Got the list back and shredded it', affected: 'chosen', people: [kavya.id], requestKey: key() }, 201);
    await cafeManager('POST', `/privacy/breaches/${breach.id}/notices`, { personId: kavya.id, channel: 'phone', requestKey: key() }, 201);
    await R('POST', `/privacy/breaches/${breach.id}/notices`, { personId: chetan.id, channel: 'phone', requestKey: key() }, 409);
    assert.equal((await rows("SELECT 1 FROM audit_logs WHERE restaurant_id=$1 AND action='notice_sent' AND entity_type='breach' AND entity_id=$2", [cafe.id, breach.id])).length, 1);
    assert.equal((await R('GET', `/privacy/breaches/${breach.id}`)).notices.length, 1);
    await otherCafe('GET', `/privacy/breaches/${breach.id}`, undefined, 404);
  });

  await t.test('a restaurant\'s guests\' site shows the notice where it takes a name and number, and the guest\'s consents are recorded when the order is accepted', async () => {
    const SS = '/orders/service-settings/online-ordering';
    const link = (await R('GET', SS)).links[0];
    await R('PUT', `${SS}/${link.id}`, { enabled: true });
    const menu = await R('GET', `/public/online/${link.token}/menu?service=takeaway`);
    assert.deepEqual(menu.privacy, { id: notice.id, version: 1, notice: notice.notice, billsText: notice.bills_text, offersText: notice.offers_text,
      contact: 'Udupi Grand front desk, 040 2345 6789' });
    let seq = 0;
    const order = (extra = {}) => ({ clientKey: `pd-${(seq += 1)}-${crypto.randomBytes(4).toString('hex')}`, service: 'takeaway', paymentMode: 'pay_at_pickup',
      guestName: 'Esha Menon', guestMobile: '9876500123', items: [{ productId: dosa.id, quantity: 2 }], ...extra });
    await R('POST', `/public/online/${link.token}/orders`, order({ consents: ['reminders'], privacyNoticeId: notice.id }), 400);
    await R('POST', `/public/online/${link.token}/orders`, order({ consents: ['offers'] }), 400);
    const foreign = await one("SELECT id FROM business_privacy_notices WHERE business_id <> (SELECT business_id FROM business_privacy_notices WHERE id=$1) LIMIT 1", [notice.id]);
    await R('POST', `/public/online/${link.token}/orders`, order({ consents: ['offers'], privacyNoticeId: foreign.id }), 400);
    await R('POST', `/public/online/${link.token}/orders`, order({ consents: ['offers', 'bills_digital'], privacyNoticeId: notice.id }), 201);
    const inbox = await R('GET', '/table-requests?view=pending&type=online');
    const accepted = await R('POST', `/table-requests/${inbox.items[0].id}/accept`);
    const esha = await one("SELECT id FROM customers WHERE restaurant_id=$1 AND name='Esha Menon'", [cafe.id]);
    assert.ok(esha, 'the order adds the guest to the guest book');
    assert.equal(Number((await one('SELECT customer_id FROM orders WHERE id=$1', [accepted.order.id])).customer_id), Number(esha.id));
    const consents = await rows('SELECT purpose, channel, method, notice_version, recorded_by FROM business_consents WHERE customer_id=$1 ORDER BY purpose', [esha.id]);
    assert.deepEqual(consents, [
      { purpose: 'bills_digital', channel: 'guests_site', method: 'digital', notice_version: 'v1', recorded_by: null },
      { purpose: 'offers', channel: 'guests_site', method: 'digital', notice_version: 'v1', recorded_by: null },
    ]);
  });

  await t.test('a restaurant\'s pre-order needs only the guest\'s name; a mobile given is matched the one way the guest book keeps it', async () => {
    await R('PUT', '/restaurants/current/features/preorders', { enabled: true });
    const dueAt = new Date(`${addDays(today(), 1)}T17:30:00+05:30`).toISOString();
    const items = [{ productId: dosa.id, quantity: 10 }];
    await R('POST', '/preorders', { dueAt, items }, 400);
    const named = await R('POST', '/preorders', { customerName: 'Farhan', dueAt, items }, 201);
    const farhan = await one('SELECT name, mobile FROM customers WHERE id=$1', [named.customerId]);
    assert.deepEqual(farhan, { name: 'Farhan', mobile: null });
    const known = await R('POST', '/preorders', { customerName: 'K', customerMobile: '+91 98765 00077', dueAt, items }, 201);
    assert.equal(Number(known.customerId), Number(kavya.id));
    // A pre-order still to collect holds an erasure back.
    const asked = await R('POST', '/privacy/requests', { kind: 'erasure', personId: named.customerId, details: 'Erase my name', requestKey: key() }, 201);
    const refused = await refusal(udupiToken, 'POST', `/privacy/requests/${asked.id}/erase`, { requestKey: key() });
    assert.equal(refused.data.reason, 'erasure_blocked');
    assert.match(refused.data.open.join(' '), /1 pre-order still to collect/);
  });
});
