const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { signIn } = require('./helpers/signIn');

// Words and looks per business type: a gym's screens call its people members
// and its bookings sessions; a coaching centre's, students and classes; an
// owner renames members to clients for their own business; the platform
// changes a type's word or adds a kind, and every business of it follows.
test('words and looks: by type, by kind, an owner\'s own, and the platform\'s console', { timeout: 300000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 10000 });
  let pool, server, created = false;
  await admin.connect();
  t.after(async () => {
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
  const { runner } = await import('node-pg-migrate');
  await runner({ databaseUrl: { ...connection, database }, dir: path.resolve(__dirname, '../../migrations'), migrationsTable: 'pgmigrations', direction: 'up', count: Infinity, checkOrder: true, log() {} });
  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const password = `Words-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const platformUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id', ['Platform Admin', 'platform@words.invalid', hash]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformUser.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email, secret = password) => (await signIn(base, email, secret))?.token || null;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const platform = as(await login('platform@words.invalid'));
  const P = (route) => `/users/platform${route}`;
  const gymBody = {
    businessType: 'memberships', name: 'Iron Temple Gym', code: 'IRON-TEMPLE', stateCode: '29', city: 'Mysuru',
    owner: { email: 'owner@irontemple.invalid', name: 'Vikram S', password },
  };
  let gym, owner;
  const B = (route) => `/businesses/${gym.id}/${route}`;
  const words = async (who = owner) => (await who('GET', B('context'))).terms;

  await t.test('a gym made with no kind speaks as a gym, its first location a branch', async () => {
    gym = (await platform('POST', P('/businesses'), gymBody, 201)).business;
    assert.equal(gym.kind, null);
    owner = as(await login('owner@irontemple.invalid'));
    const context = await owner('GET', B('context'));
    assert.deepEqual(context.terms.customer, { one: 'Member', many: 'Members' });
    assert.deepEqual(context.terms.appointment, { one: 'Session', many: 'Sessions' });
    assert.deepEqual(context.terms.goods, { one: 'Product for sale', many: 'Products for sale' });
    // A word the type leaves alone keeps its default.
    assert.deepEqual(context.terms.service, { one: 'Service', many: 'Services' });
    assert.equal(context.terms['phrase.bill_note'].one, '');
    assert.equal(context.terms['example.category'].many, null);
    assert.equal(Object.keys(context.terms).length, (await one('SELECT count(*)::int AS n FROM term_keys')).n);
    assert.deepEqual(context.look, { icon: 'dumbbell', accent: 'rose', kind: null, kindName: null, logo: null, defaultItemKind: 'service' });
    assert.equal(context.business.type_name, 'Gyms, studios & coaching');
    assert.equal((await owner('GET', B('locations'))).items[0].name, 'Main branch');
    // The directory carries each business's look.
    const listed = (await owner('GET', '/businesses')).businesses.find((b) => Number(b.id) === Number(gym.id));
    assert.deepEqual(listed.look, { icon: 'dumbbell', accent: 'rose', kind: null, kindName: null, logo: null, defaultItemKind: 'service' });
  });

  await t.test('the owner renames members to clients, and back; only the words an owner may rename', async () => {
    const view = await owner('GET', B('words'));
    assert.deepEqual(view.kinds.map((k) => k.code), ['gym', 'yoga_studio', 'dance_studio', 'coaching', 'sports_academy']);
    const customer = view.words.find((w) => w.key === 'customer');
    assert.deepEqual([customer.typeWord, customer.own, customer.kindWords.coaching], [{ one: 'Member', many: 'Members' }, null, { one: 'Student', many: 'Students' }]);
    assert.ok(!view.words.some((w) => w.key === 'goods' || w.area === 'examples'), 'only the words an owner renames');
    // Spaces trimmed; kept as typed.
    const saved = await owner('PUT', B('words'), { words: { customer: { one: '  Client ', many: 'Clients  ' } } });
    assert.deepEqual(saved.words.find((w) => w.key === 'customer').own, { one: 'Client', many: 'Clients' });
    assert.deepEqual((await words()).customer, { one: 'Client', many: 'Clients' });
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='settings.words_updated' ORDER BY id DESC LIMIT 1", [gym.id]);
    assert.deepEqual(audit.details.words.customer, { from: null, to: { one: 'Client', many: 'Clients' } });
    // Refusals.
    await owner('PUT', B('words'), { words: { goods: { one: 'Things', many: 'Things' } } }, 400);
    await owner('PUT', B('words'), { words: { item: { one: 'Course' } } }, 400);
    await owner('PUT', B('words'), { words: { location: { one: 'x'.repeat(81), many: 'Branches' } } }, 400);
    await owner('PUT', B('words'), { words: ['customer'] }, 400);
    // The type's own word again is no word of the owner's.
    await owner('PUT', B('words'), { words: { location: { one: 'Branch', many: 'Branches' } } });
    await owner('PUT', B('words'), { words: { location: { one: 'Location', many: 'Locations' } } });
    assert.equal(await one("SELECT 1 FROM business_terms WHERE business_id=$1 AND key='location'", [gym.id]), undefined);
    // Back to the type's word.
    await owner('PUT', B('words'), { words: { customer: null } });
    assert.deepEqual((await words()).customer, { one: 'Member', many: 'Members' });
  });

  await t.test("a change of kind brings the kind's words and keeps the owner's own", async () => {
    await owner('PUT', B('words'), { words: { location: { one: 'Centre', many: 'Centres' } } });
    const saved = await owner('PUT', B('words'), { kind: 'coaching' });
    assert.equal(saved.kind, 'coaching');
    const context = await owner('GET', B('context'));
    assert.deepEqual([context.terms.customer.many, context.terms.provider.many, context.terms.appointment.one, context.terms.location.one],
      ['Students', 'Faculty', 'Class', 'Centre']);
    assert.deepEqual([context.look.icon, context.look.kind, context.look.kindName, context.business.type_name],
      ['graduation', 'coaching', 'Coaching & tuition centre', 'Coaching & tuition centre']);
    await owner('PUT', B('words'), { kind: 'spa' }, 400);
    await owner('PUT', B('words'), { kind: null });
    assert.equal((await words()).customer.one, 'Member');
    assert.equal((await words()).location.one, 'Centre');
  });

  await t.test('kinds at creation: an owner adds a dental clinic, named and worded as one', async () => {
    const made = await owner('POST', '/businesses', { businessType: 'healthcare', kind: 'dental', name: 'Smile Dental', code: 'SMILE-DENTAL' }, 201);
    assert.equal(made.kind, 'dental');
    const dental = (await owner('GET', `/businesses/${made.id}/context`));
    assert.deepEqual([dental.terms.customer.one, dental.terms.provider.one, dental.look.icon], ['Patient', 'Dentist', 'tooth']);
    assert.equal((await owner('GET', `/businesses/${made.id}/locations`)).items[0].name, 'Main clinic');
    await owner('POST', '/businesses', { businessType: 'healthcare', kind: 'yoga_studio', name: 'Wrong Kind', code: 'WRONG-KIND' }, 400);
    assert.equal(await one("SELECT 1 FROM businesses WHERE code='WRONG-KIND'"), undefined);
  });

  await t.test("the console: a type's word reaches its businesses; a new kind; a kind switched off", async () => {
    const listed = await platform('GET', P('/business-types'));
    assert.equal(listed.types.length, (await one('SELECT count(*)::int AS n FROM business_types')).n);
    const gyms = listed.types.find((type) => type.code === 'memberships');
    assert.deepEqual([gyms.icon, gyms.accent, gyms.defaultItemKind, gyms.kinds.length], ['dumbbell', 'rose', 'service', 5]);
    const page = await platform('GET', P('/business-types/memberships'));
    const provider = page.words.find((w) => w.key === 'provider');
    assert.deepEqual([provider.standard.one, provider.type.one, provider.kinds.yoga_studio.one, provider.ownerMayRename], ['Staff member', 'Trainer', 'Teacher', true]);
    // The type's word, seen at once by its businesses.
    await words();
    await platform('PUT', P('/business-types/memberships'), { words: { provider: { one: 'Coach', many: 'Coaches' } } });
    assert.deepEqual((await words()).provider, { one: 'Coach', many: 'Coaches' });
    // Back to the default.
    const back = await platform('PUT', P('/business-types/memberships'), { words: { provider: null }, accent: 'violet' });
    assert.equal(back.words.find((w) => w.key === 'provider').type, null);
    assert.equal((await words()).provider.one, 'Staff member');
    assert.equal((await owner('GET', B('context'))).look.accent, 'violet');
    // A new kind, with words of its own.
    await platform('PUT', P('/business-types/memberships/kinds/crossfit'), { icon: 'dumbbell' }, 400);
    await platform('PUT', P('/business-types/memberships/kinds/crossfit'), { name: 'CrossFit box', icon: 'dumbbell', words: { appointment: { one: 'WOD', many: 'WODs' } } });
    assert.ok((await owner('GET', B('words'))).kinds.some((k) => k.code === 'crossfit'));
    await owner('PUT', B('words'), { kind: 'crossfit' });
    assert.equal((await words()).appointment.one, 'WOD');
    // Switched off: kept by the gym that has it, offered to none.
    await platform('PUT', P('/business-types/memberships/kinds/crossfit'), { active: false });
    assert.equal((await owner('GET', B('context'))).look.kind, 'crossfit');
    assert.ok((await owner('GET', B('words'))).kinds.some((k) => k.code === 'crossfit'), 'the kind it has is still listed for it');
    await owner('POST', '/businesses', { businessType: 'memberships', kind: 'crossfit', name: 'Box Two', code: 'BOX-TWO' }, 400);
    // Refusals.
    await platform('PUT', P('/business-types/memberships'), { words: { 'example.kit': { one: 'Kit', many: 'Kits' } } });
    assert.equal((await one("SELECT many FROM business_type_terms WHERE business_type='memberships' AND key='example.kit'")).many, null);
    await platform('PUT', P('/business-types/memberships'), { words: { nonsense: { one: 'x' } } }, 400);
    await platform('PUT', P('/business-types/memberships'), { words: { item: { one: 'Plan' } } }, 400);
    await platform('PUT', P('/business-types/memberships'), { icon: 'Not An Icon' }, 400);
    await platform('PUT', P('/business-types/memberships'), { accent: 'beige' }, 400);
    await platform('PUT', P('/business-types/memberships'), { name: 'Salon & spa' }, 409);
    await platform('PUT', P('/business-types/restaurant/kinds/diner'), { name: 'Diner' }, 400);
    await platform('PUT', P('/business-types/nowhere'), { accent: 'teal' }, 404);
    // Every change is in the platform's log.
    const logged = (await pool.query("SELECT action FROM platform_audit WHERE entity_type IN ('business_type','business_kind') ORDER BY id")).rows.map((r) => r.action);
    assert.ok(logged.includes('platform.business_type_updated') && logged.includes('platform.business_kind_added') && logged.includes('platform.business_kind_updated'), logged.join());
    // Only the platform.
    await owner('GET', P('/business-types'), undefined, 403);
    await owner('PUT', P('/business-types/memberships'), { accent: 'teal' }, 403);
  });

  await t.test("a booking's service, an issue's and an offer's examples, the label sheet and selling a plan, by type and kind", async () => {
    const word = async (id, key, plural = false) => (await one('SELECT business_word($1,$2,$3) AS w', [id, key, plural])).w;
    const coaching = await owner('POST', '/businesses', { businessType: 'memberships', kind: 'coaching', name: 'Bright Minds Academy', code: 'BRIGHT-MINDS' }, 201);
    assert.deepEqual([await word(coaching.id, 'booked_service', true), await word(coaching.id, 'phrase.sell_plan'), await word(coaching.id, 'example.offer_amount')],
      ['Classes', 'Enrol a student', '₹2,000 off the course fee']);
    const dental = await one("SELECT id FROM businesses WHERE code='SMILE-DENTAL'");
    assert.deepEqual([await word(dental.id, 'example.asset'), await word(dental.id, 'booked_service')], ['Dental chair 2, autoclave', 'Consultation or test']);
    const garage = await owner('POST', '/businesses', { businessType: 'garage', name: 'Speed Auto Works', code: 'SPEED-AUTO' }, 201);
    assert.deepEqual([await word(garage.id, 'phrase.labels'), await word(garage.id, 'example.asset'), await word(garage.id, 'booked_service')],
      ['Part labels', 'Hoist 2, wheel aligner', 'Service']);
  });

  await t.test("the modules each type is offered: a kirana never sees Quotations until the platform offers it, and keeps it after", async () => {
    const kiranaType = await platform('GET', P('/business-types/grocery'));
    const quote = (view) => view.modules.find((m) => m.code === 'quotations');
    assert.deepEqual([quote(kiranaType).offered, quote(kiranaType).recommended, quote(kiranaType).onAtStart, quote(kiranaType).inUse], [false, false, false, 0]);
    const hardwareType = await platform('GET', P('/business-types/hardware'));
    assert.deepEqual([quote(hardwareType).offered, quote(hardwareType).onAtStart], [true, true]);
    assert.equal((await platform('GET', P('/business-types/restaurant'))).modules, null);

    // A kirana: Quotations is not in its Business tools and is not switched on.
    const made = (await platform('POST', P('/businesses'), { businessType: 'grocery', name: 'Sri Ganesh Kirana', code: 'GANESH-KIRANA', stateCode: '29', city: 'Mysuru',
      owner: { email: 'owner@ganeshkirana.invalid', name: 'Ganesh R', password } }, 201)).business;
    const shopOwner = as(await login('owner@ganeshkirana.invalid'));
    const K = (route) => `/businesses/${made.id}/${route}`;
    assert.equal((await shopOwner('GET', K('modules'))).find((m) => m.code === 'quotations'), undefined);
    const refusedOn = await call('PUT', K('modules/quotations'), { enabled: true }, await login('owner@ganeshkirana.invalid'));
    assert.equal(refusedOn.status, 409);
    assert.equal(refusedOn.body.data.reason, 'not_offered');

    // Offered: it shows, and the kirana switches it on.
    await platform('PUT', P('/business-types/grocery/modules/quotations'), { offered: true });
    const listed = (await shopOwner('GET', K('modules'))).find((m) => m.code === 'quotations');
    assert.deepEqual([listed.offered, listed.enabled], [true, false]);
    await shopOwner('PUT', K('modules/quotations'), { enabled: true });
    // No longer offered: the kirana keeps it (listed, on), and the console counts it.
    const after = await platform('PUT', P('/business-types/grocery/modules/quotations'), { offered: false });
    assert.equal(quote(after).inUse, 1);
    const kept = (await shopOwner('GET', K('modules'))).find((m) => m.code === 'quotations');
    assert.deepEqual([kept.offered, kept.enabled], [false, true]);
    // Switched off, it is not switched on again.
    await shopOwner('PUT', K('modules/quotations'), { enabled: false });
    assert.equal((await shopOwner('GET', K('modules'))).find((m) => m.code === 'quotations'), undefined);
    assert.equal((await call('PUT', K('modules/quotations'), { enabled: true }, await login('owner@ganeshkirana.invalid'))).status, 409);

    // Recommended needs its reason; recommended and on at start, a new kirana starts with it.
    await platform('PUT', P('/business-types/grocery/modules/quotations'), { offered: true, recommended: true }, 400);
    const advised = await platform('PUT', P('/business-types/grocery/modules/quotations'),
      { offered: true, recommended: true, recommendedNote: 'For function and office orders', onAtStart: true });
    assert.deepEqual([quote(advised).recommended, quote(advised).recommendedNote, quote(advised).onAtStart], [true, 'For function and office orders', true]);
    const second = (await platform('POST', P('/businesses'), { businessType: 'grocery', name: 'New Kirana', code: 'NEW-KIRANA', stateCode: '29', city: 'Mysuru',
      owner: { email: 'owner@newkirana.invalid', name: 'Asha K', password } }, 201)).business;
    assert.ok(await one("SELECT 1 FROM business_capabilities WHERE business_id=$1 AND capability='quotations'", [second.id]), 'on at start');
    // Not offered takes away recommended and on at start with it.
    const off = await platform('PUT', P('/business-types/grocery/modules/quotations'), { offered: false });
    assert.deepEqual([quote(off).offered, quote(off).recommended, quote(off).recommendedNote, quote(off).onAtStart], [false, false, null, false]);

    // What another offered module needs is not taken away first.
    const needing = off.modules.find((m) => m.offered && m.requires.length);
    if (needing) {
      const needed = off.modules.find((m) => m.code === needing.requires[0]);
      const refused = await call('PUT', P(`/business-types/grocery/modules/${needed.code}`), { offered: false }, await login('platform@words.invalid'));
      assert.equal(refused.status, 409);
      assert.match(refused.body.message, new RegExp(`${needing.name} needs ${needed.name}`));
    }
    // A restaurant's features are its own; a module the type does not use is not there.
    assert.equal((await call('PUT', P('/business-types/restaurant/modules/quotations'), { offered: true }, await login('platform@words.invalid'))).status, 409);
    assert.equal((await call('PUT', P('/business-types/grocery/modules/member_plans'), { offered: true }, await login('platform@words.invalid'))).status, 404);
    assert.ok(await one("SELECT 1 FROM platform_audit WHERE action='platform.business_type_module_updated' AND details->>'module'='quotations'"));
  });

  await t.test("a database message can name a business's word", async () => {
    assert.equal((await one("SELECT business_word($1,'customer',true) AS w", [gym.id])).w, 'Members');
    assert.equal((await one("SELECT business_word($1,'example.first_location') AS w", [gym.id])).w, 'Main branch');
  });
});
