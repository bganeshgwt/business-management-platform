const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const { addDays, daysFrom } = require('./helpers/dates');

// A gym's, studio's or coaching centre's own tools: plans by days, months or
// sessions with a refund policy kept in versions; memberships sold on a bill
// with their terms kept, renewed, upgraded with pro-rata credit, frozen,
// transferred, and cancelled with a pro-rata refund a manager approves;
// check-ins let in or turned away with the reason; fees in instalments; the
// renewals and fees-due lists. Money adds up to the paisa, postings are
// idempotent, the database keeps its rules, audit and events are written, and
// other types and other owners are kept out. Runs on its own throwaway
// database with every migration applied.
test('gyms, studios and coaching', { timeout: 300000 }, async (t) => {
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
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `Gym-${crypto.randomBytes(8).toString('hex')}`;
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
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  const login = async (email) => {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password }) });
    return (await response.json()).data.token;
  };
  const ownerUser = await owner('gym-owner');
  await owner('gym-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('gym-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('gym-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);
  // The same date so many months later (the month's last day when it has fewer).
  const addMonthsOf = (day, months) => {
    const [y, m, d] = day.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    target.setUTCDate(Math.min(d, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
    return target.toISOString().slice(0, 10);
  };

  const [made, grocery, optical] = await createBusinesses(request, 'OWNER', ['memberships', 'grocery', 'optical']);
  // The gym also books personal-training sessions (its recommended tool).
  const [gym] = await withTools(request, [made]);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['memberships']);
  const G = (suffix) => `/businesses/${gym.id}/${suffix}`;

  await t.test('modules, permissions and roles per type', async () => {
    assert.ok(made.capabilities.includes('member_plans'), 'a gym starts with plans & memberships');
    assert.ok(made.capabilities.includes('receivables'), 'a gym keeps its members\' dues');
    for (const business of [grocery, optical]) assert.ok(!business.capabilities.includes('member_plans'), `${business.business_type} has no plans & memberships`);
    const tools = await request('GET', G('modules'));
    const module = tools.find((m) => m.code === 'member_plans');
    assert.equal(module.name, 'Plans & memberships');
    assert.deepEqual([...module.requires].sort(), ['catalog', 'contacts', 'sales']);
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'member_plans'), 'a grocery is not offered plans & memberships');
    await request('PUT', `/businesses/${grocery.id}/modules/member_plans`, { enabled: true }, 409);
    // Sales stays on while plans & memberships need it.
    await request('PUT', G('modules/sales'), { enabled: false }, 409);
    const permissions = await rows("SELECT code FROM business_permissions WHERE module_code='member_plans' ORDER BY sort_order");
    assert.deepEqual(permissions.map((p) => p.code), ['member_plans.view', 'member_plans.create', 'member_plans.edit', 'member_plans.approve',
      'member_plans.cancel', 'member_plans.refund', 'member_plans.export']);
    // The trainer: a gym's own role, with no money.
    const roles = (await request('GET', G('roles?limit=100'))).items;
    const trainer = roles.find((r) => r.template_code === 'trainer');
    assert.ok(trainer, 'a gym has the trainer role');
    assert.equal(trainer.name, 'Trainer');
    for (const business of [grocery, optical]) {
      assert.ok(!(await request('GET', `/businesses/${business.id}/roles?limit=100`)).items.some((r) => r.template_code === 'trainer'), `${business.business_type} has no trainer`);
    }
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2`, [business.id, template])).p;
    const own = async (business, template) => (await grants(business, template)).filter((p) => p.startsWith('member_plans.'));
    assert.deepEqual(await grants(gym, 'trainer'), ['appointments.edit', 'appointments.view', 'member_plans.create', 'member_plans.view']);
    assert.ok(!(await grants(gym, 'trainer')).some((p) => /^(sales|receivables|purchasing|contacts)\./.test(p)), 'the trainer sees no money');
    assert.deepEqual(await own(gym, 'manager'), ['member_plans.approve', 'member_plans.cancel', 'member_plans.create', 'member_plans.edit', 'member_plans.export',
      'member_plans.refund', 'member_plans.view']);
    assert.deepEqual(await own(gym, 'cashier'), ['member_plans.create', 'member_plans.edit', 'member_plans.view']);
    assert.deepEqual(await own(gym, 'stock_keeper'), ['member_plans.view']);
    assert.deepEqual(await own(gym, 'accountant'), ['member_plans.export', 'member_plans.view']);
    assert.deepEqual(await own(gym, 'viewer'), ['member_plans.export', 'member_plans.view']);
    assert.deepEqual(await own(grocery, 'viewer'), ['member_plans.export', 'member_plans.view'], 'role copies match their templates everywhere');
    // Memberships are numbered documents of their own.
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'")).d.includes("'membership'"));
    assert.notEqual(String(elsewhere.id), String(gym.id));
  });

  // --- Shared set-up: the gym's front desk, its items and members --------------------------------------
  const shop = (await request('GET', G('locations'))).items[0];
  const slabs = (await request('GET', G('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18);
  const service = (body) => request('POST', G('catalog'), { kind: 'service', unit: 'service', taxRateId: gst5.id, ...body }, 201);
  const customer = (name, phone) => request('POST', G('contacts'), { kind: 'customer', name, ...(phone ? { phone } : {}) }, 201);
  const supplier = await request('POST', G('contacts'), { kind: 'supplier', name: 'Fit Gear Suppliers' }, 201);
  // The gym sells towels and supplements over the counter too.
  await request('PUT', G('modules/inventory'), { enabled: true });

  await t.test('the database keeps plans, memberships, freezes, check-ins and instalments within their rules', async () => {
    const rule = await customer('Rule Check', '9000000001');
    const stranger = await customer('Rule Stranger');
    const item = await service({ name: 'Rule monthly', code: 'RULE-MON', price: '1000', hsnCode: '999723' });
    const joining = await service({ name: 'Rule joining fee', code: 'RULE-JOIN', price: '500', hsnCode: '999723' });
    const towel = await request('POST', G('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'Gym towel', code: 'RULE-TOWEL', price: '200', taxRateId: gst18.id }, 201);
    // A bill of the item made before it became a plan's (Members & plans bills a plan's item itself).
    const bill = await request('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, contactId: rule.id,
      lines: [{ skuId: item.id, quantity: 1 }, { skuId: joining.id, quantity: 1 }] }, 201);
    const billLines = await rows('SELECT id,sku_id FROM business_document_lines WHERE document_id=$1 ORDER BY id', [bill.id]);
    const line = billLines.find((l) => String(l.sku_id) === String(item.id)), joiningLine = billLines.find((l) => String(l.sku_id) === String(joining.id));
    // A plan and its first policy go in together (the policy is checked when both are saved).
    const plan = async (sku, extra = {}) => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const p = (await db.query(`INSERT INTO member_plan_types(business_id,name,kind,duration_unit,duration,sessions,price_sku_id,joining_sku_id,max_freeze_days,max_freezes,grace_days,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [gym.id, extra.name || `Rule ${sku}`, extra.kind || 'duration', extra.unit === undefined ? 'days' : extra.unit,
          extra.duration === undefined ? 30 : extra.duration, extra.sessions ?? null, sku, extra.joining ?? null, extra.freezeDays ?? 10, extra.freezes ?? 2, extra.grace ?? 3, ownerUser.id])).rows[0];
        if (extra.policy !== false) await db.query('INSERT INTO member_plan_policies(business_id,plan_id,version,policy,created_by) VALUES($1,$2,1,$3,$4)', [gym.id, p.id, 'Unused days refunded pro rata.', ownerUser.id]);
        await db.query('COMMIT');
        return p;
      } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    };
    // A plan is its own service item; a joining fee is a service; the policy goes in with it.
    await assert.rejects(plan(towel.id), /sold as a service item/);
    await assert.rejects(plan(item.id, { joining: towel.id }), /joining fee is a service item/);
    await assert.rejects(plan(item.id, { policy: false }), /policy_fkey|violates foreign key/);
    await assert.rejects(plan(item.id, { kind: 'sessions' }), /check/);
    const monthly = await plan(item.id, { joining: joining.id });
    await assert.rejects(plan(joining.id, { name: 'Rule joining as plan' }), /joining fee of another plan/);
    await assert.rejects(pool.query('UPDATE member_plan_types SET price_sku_id=$2 WHERE id=$1', [monthly.id, joining.id]), /keeps its price item/);
    await assert.rejects(pool.query('UPDATE member_plan_types SET policy_version=3 WHERE id=$1', [monthly.id]), /one version at a time/);
    await assert.rejects(pool.query('DELETE FROM member_plan_types WHERE id=$1', [monthly.id]), /never deleted/);
    await assert.rejects(pool.query("UPDATE member_plan_policies SET policy='No refunds' WHERE plan_id=$1", [monthly.id]), /kept as it was written/);
    // A membership: sold on its member's own bill, on a line of its plan's item.
    const membership = (values = {}) => one(`INSERT INTO member_memberships(business_id,location_id,membership_no,contact_id,plan_id,plan_name,kind,duration_unit,duration,
        price,price_net,price_tax,tax_rate,joining_fee,policy_version,max_freeze_days,max_freezes,grace_days,transferable,start_on,base_end_on,end_on,document_id,line_id,joining_line_id,
        request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,'Rule monthly','duration','days',30,'1050.00','1000.00','50.00',5,'525.00',1,10,2,3,FALSE,$6,$7,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [gym.id, shop.id, values.no || `RULE-${crypto.randomBytes(3).toString('hex')}`, values.contactId || rule.id, monthly.id, values.start || today, addDays(values.start || today, 29),
      bill.id, values.lineId || line.id, values.joiningLineId === undefined ? joiningLine.id : values.joiningLineId, key(), 'x'.repeat(64), ownerUser.id]);
    await assert.rejects(membership({ lineId: joiningLine.id, joiningLineId: null }), /bill line of its plan's item/);
    await assert.rejects(membership({ contactId: stranger.id }), /member's own bill/);
    await assert.rejects(membership({ contactId: supplier.id }), /Choose a customer/);
    const m = await membership({ start: addDays(today, -5) });
    await assert.rejects(membership({ no: 'RULE-AGAIN' }), /unique|duplicate/);
    await assert.rejects(pool.query("UPDATE member_memberships SET plan_name='Gold' WHERE id=$1", [m.id]), /keeps its member, plan, terms, start and bill/);
    await assert.rejects(pool.query('UPDATE member_memberships SET end_on=end_on+5 WHERE id=$1', [m.id]), /check/);
    await assert.rejects(pool.query('UPDATE member_memberships SET frozen_days=5,end_on=end_on+5 WHERE id=$1', [m.id]), /frozen days follow its freezes/);
    await assert.rejects(pool.query('DELETE FROM member_memberships WHERE id=$1', [m.id]), /never deleted/);
    // The lines that sold it come back only on the credit note its cancellation or upgrade makes.
    const back = await refused('POST', G(`documents/${bill.id}/returns`), { requestKey: key(), reason: 'Member left', lines: [{ lineId: line.id, quantity: '1', restock: false }] });
    assert.equal(back.status, 409);
    assert.match(back.message, /sold membership RULE-.*cancelled or upgraded/);
    // Freezes: from today or later, within its days, not overlapping, within the plan's limits; they move its last day.
    const freeze = (startsOn, days) => one(`INSERT INTO member_freezes(business_id,membership_id,starts_on,planned_days,days,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$4,$5,$6,$7) RETURNING *`, [gym.id, m.id, startsOn, days, key(), 'x'.repeat(64), ownerUser.id]);
    await assert.rejects(freeze(addDays(today, -1), 2), /starts today or later/);
    await assert.rejects(freeze(addDays(today, 40), 2), /between its first day/);
    await assert.rejects(freeze(today, 11), /allows 10 days frozen in all: 10 left/);
    const first = await freeze(today, 4);
    assert.deepEqual(Object.values(await one('SELECT frozen_days,end_on::text FROM member_memberships WHERE id=$1', [m.id])), [4, addDays(today, 24 + 4)]);
    await assert.rejects(freeze(addDays(today, 3), 2), /already frozen on some of those days/);
    await freeze(addDays(today, 10), 2);
    await assert.rejects(freeze(addDays(today, 20), 1), /allows 2 freezes, and 2 are used/);
    await assert.rejects(pool.query('DELETE FROM member_freezes WHERE id=$1', [first.id]), /never deleted/);
    await assert.rejects(pool.query('UPDATE member_freezes SET planned_days=3 WHERE id=$1', [first.id]), /keeps its first day and its planned days/);
    await assert.rejects(pool.query('UPDATE member_freezes SET ended_on=$2,ended_by=$3,ended_at=now(),days=1 WHERE id=$1', [first.id, addDays(today, 1), ownerUser.id]), /day the member comes back/);
    // Coming back the same day calls it off: the membership's last day follows.
    await pool.query('UPDATE member_freezes SET ended_on=$2,ended_by=$3,ended_at=now(),days=0 WHERE id=$1', [first.id, today, ownerUser.id]);
    assert.deepEqual(Object.values(await one('SELECT frozen_days,end_on::text FROM member_memberships WHERE id=$1', [m.id])), [2, addDays(today, 24 + 2)]);
    // Check-ins are dated on the business's clock; one lets a member in only on their own running membership.
    const checkIn = (values = {}) => one(`INSERT INTO member_checkins(business_id,location_id,contact_id,membership_id,day,found_by,allowed,reason,session_used,request_key,created_by)
      VALUES($1,$2,$3,$4,'2000-01-01','search',$5,$6,$7,$8,$9) RETURNING *`, [gym.id, shop.id, values.contactId || rule.id, values.membershipId === undefined ? m.id : values.membershipId,
      values.allowed ?? true, values.reason ?? null, values.session ?? false, key(), ownerUser.id]);
    const entry = await checkIn();
    assert.equal((await one('SELECT day::text AS d FROM member_checkins WHERE id=$1', [entry.id])).d, today, 'the day is the business\'s, not the one sent');
    await assert.rejects(checkIn({ contactId: stranger.id }), /another member's/);
    await assert.rejects(checkIn({ session: true }), /no sessions to count/);
    await assert.rejects(checkIn({ allowed: false, reason: 'no_membership' }), /check/);
    await checkIn({ allowed: false, reason: 'dues' });
    await assert.rejects(pool.query("UPDATE member_checkins SET note='x' WHERE id=$1", [entry.id]), /kept as it was recorded/);
    // Instalments are set with the membership when it is sold.
    await assert.rejects(pool.query(`INSERT INTO member_instalments(business_id,membership_id,seq,due_on,amount) VALUES($1,$2,1,$3,'787.50'),($1,$2,2,$4,'787.50')`,
      [gym.id, m.id, today, addDays(today, 30)]), /set when membership .* is sold/);
    // Closed once, then it changes no more.
    await pool.query("UPDATE member_memberships SET closed='cancelled',closed_on=$2,close_reason='Rule check',closed_by=$3,closed_at=now(),close_key=$4,close_hash=$5 WHERE id=$1",
      [m.id, today, ownerUser.id, key(), 'x'.repeat(64)]);
    await assert.rejects(pool.query("UPDATE member_memberships SET notes='x' WHERE id=$1", [m.id]), /was cancelled and no longer changes/);
    await assert.rejects(checkIn(), /was cancelled and lets no one in/);
    await assert.rejects(freeze(addDays(today, 15), 1), /is not frozen any more/);
    // Another owner's gym is a business of its own.
    assert.equal((await one('SELECT count(*)::int AS n FROM member_memberships WHERE business_id=$1', [elsewhere.id])).n, 0);
  });

  // --- Staff, plans and members --------------------------------------------------------------------------
  const roles = (await request('GET', G('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', G('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('gym-desk@test.invalid', 'cashier');
  const trainer = await staff('gym-trainer@test.invalid', 'trainer');
  const viewer = await staff('gym-viewer@test.invalid', 'viewer');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const approval = { approverId: ownerUser.id, pin: '2468' };
  const joiningFee = await service({ name: 'Joining fee', code: 'JOIN-FEE', price: '500', hsnCode: '999723' });
  const policy = 'If you cancel, the fee for the days (or sessions) you have not used is refunded pro rata. The joining fee is not refunded.';
  const newPlan = (body) => request('POST', G('member-plans/plans'), { policy, ...body }, 201);
  // Time passes: a membership moved back so many days, as if sold then (its dates only).
  async function backdate(membershipId, days) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE member_memberships DISABLE TRIGGER member_memberships_guard');
      await db.query('UPDATE member_memberships SET start_on=start_on-$2::int,base_end_on=base_end_on-$2::int,end_on=end_on-$2::int WHERE id=$1', [membershipId, days]);
      await db.query('ALTER TABLE member_memberships ENABLE TRIGGER member_memberships_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  const sell = (body, by = request, expected = 201) => by('POST', G('member-plans/memberships'), { requestKey: key(), locationId: shop.id, ...body }, expected);
  const checkIn = (body, by = request, expected = 201) => by('POST', G('member-plans/check-ins'), { requestKey: key(), locationId: shop.id, ...body }, expected);
  let gym30, gym90, yoga, pt, coaching, asha, ravi;

  await t.test('plans: their own service item with its GST and SAC, a joining fee, freeze, grace and transfer rules, the policy in versions', async () => {
    // A plan made with its own item: the price, GST slab and SAC typed with it.
    gym30 = await newPlan({ name: 'Gym 30 days', kind: 'duration', durationUnit: 'days', duration: '30', item: { price: '999', taxRateId: gst5.id, hsnCode: '999723' },
      joiningSkuId: joiningFee.id, maxFreezes: '2', maxFreezeDays: '15', graceDays: '3', transferable: true });
    assert.match(gym30.item_code, /^PLAN-\d{3}$/);
    assert.deepEqual([gym30.term, gym30.price, gym30.tax_rate, gym30.hsn_code, gym30.joining_label, gym30.policy_version, gym30.policies.length],
      ['30 days', '999.00', '5.00', '999723', 'Joining fee', 1, 1]);
    const item = await one('SELECT s.label,p.kind FROM catalog_skus s JOIN catalog_products p ON p.id=s.product_id WHERE s.id=$1', [gym30.price_sku_id]);
    assert.deepEqual([item.label, item.kind], ['Gym 30 days', 'service']);
    gym90 = await newPlan({ name: 'Gym 90 days', kind: 'duration', durationUnit: 'days', duration: '90', item: { price: '2700', taxRateId: gst5.id, hsnCode: '999723' } });
    yoga = await newPlan({ name: 'Yoga 10 classes', kind: 'sessions', sessions: '10', item: { price: '1999', taxRateId: gst5.id, hsnCode: '999723' } });
    pt = await newPlan({ name: 'Personal training 8 in 60 days', kind: 'both', durationUnit: 'days', duration: '60', sessions: '8',
      item: { price: '6400', taxRateId: gst5.id, hsnCode: '999723' }, maxFreezes: '1', maxFreezeDays: '7' });
    // Coaching is taxed at 18%: its own item says so.
    const course = await service({ name: 'JEE coaching, one year', code: 'JEE-1Y', price: '48000', taxRateId: gst18.id, hsnCode: '999293' });
    coaching = await newPlan({ name: 'JEE coaching', kind: 'duration', durationUnit: 'months', duration: '12', item: { skuId: course.id } });
    assert.deepEqual([coaching.term, coaching.tax_rate, coaching.hsn_code], ['12 months', '18.00', '999293']);
    // The rules of a plan: one plan per item; a joining fee is not a plan; a pack with no end date is not frozen; both freeze limits or neither.
    assert.equal((await refused('POST', G('member-plans/plans'), { name: 'Again', kind: 'duration', durationUnit: 'days', duration: '30', policy, item: { skuId: course.id } })).status, 409);
    assert.equal((await refused('POST', G('member-plans/plans'), { name: 'Fee', kind: 'duration', durationUnit: 'days', duration: '30', policy, item: { skuId: joiningFee.id } })).status, 409);
    assert.match((await refused('POST', G('member-plans/plans'), { name: 'Pack', kind: 'sessions', sessions: '5', maxFreezes: '1', maxFreezeDays: '5', policy, item: { price: '1', taxRateId: gst5.id } })).message,
      /not frozen/);
    assert.match((await refused('POST', G('member-plans/plans'), { name: 'Half', kind: 'duration', durationUnit: 'days', duration: '30', maxFreezes: '1', policy, item: { price: '1', taxRateId: gst5.id } })).message,
      /both how many freezes/);
    assert.match((await refused('POST', G('member-plans/plans'), { name: 'No policy', kind: 'duration', durationUnit: 'days', duration: '30', item: { price: '1', taxRateId: gst5.id } })).message,
      /Refund policy is required/);
    // Only someone who sets up plans changes them; a changed policy is a new version, the first kept as written.
    assert.equal((await refused('POST', G('member-plans/plans'), { name: 'Desk plan', kind: 'sessions', sessions: '1', policy, item: { price: '1', taxRateId: gst5.id } }, viewer.token)).status, 403);
    const edited = await request('PUT', G(`member-plans/plans/${yoga.id}`), { name: 'Yoga 10 classes', kind: 'sessions', sessions: '10', price: '1999', policy: `${policy} Classes not taken in a month lapse.` });
    assert.deepEqual([edited.policy_version, edited.policies.map((p) => p.version)], [2, [2, 1]]);
    assert.equal(edited.policies[1].policy, policy);
    const listed = await viewer.call('GET', G('member-plans/plans'));
    assert.deepEqual(listed.items.map((p) => p.name).filter((name) => !name.startsWith('Rule')), ['Gym 30 days', 'Gym 90 days', 'JEE coaching', 'Personal training 8 in 60 days', 'Yoga 10 classes']);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='member_plan.updated' AND (details->>'policyVersion')::int=2", [gym.id]));
    // A plan's item goes on a bill only from Members & plans.
    const loose = await refused('POST', G('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, lines: [{ skuId: gym30.price_sku_id, quantity: 1 }] });
    assert.deepEqual([loose.status, /Gym 30 days is a membership plan/.test(loose.message)], [409, true]);
  });

  await t.test('selling: a bill through the core, the terms kept as sold, a member code, renewals that start after the end, no overlaps', async () => {
    // A new member typed with the sale: made a customer, given code M0001; the joining fee comes with a first membership.
    const preview = await desk.call('POST', G('member-plans/memberships/preview'), { locationId: shop.id, planId: gym30.id, member: { name: 'Asha Rao', phone: '9876500001' } });
    assert.deepEqual([preview.total, preview.joiningFee, preview.startOn, preview.endOn], ['1573.95', true, today, addDays(today, 29)]);
    const sold = await sell({ planId: gym30.id, member: { name: 'Asha Rao', phone: '9876500001' }, payments: [{ amount: 'full', method: 'cash' }] }, desk.call);
    asha = { id: sold.contact_id };
    assert.deepEqual([sold.member_code, sold.status, sold.start_on, sold.end_on, sold.price, sold.price_net, sold.price_tax, sold.joining_fee, sold.policy_version, sold.bill.total, sold.bill.due],
      ['M0001', 'active', today, addDays(today, 29), '1048.95', '999.00', '49.95', '525.00', 1, '1573.95', '0.00']);
    assert.equal(sold.events[0].kind, 'sold');
    const bill = await request('GET', G(`documents/${sold.document_id}`));
    assert.deepEqual(bill.lines.map((l) => [l.label, l.net, l.tax, l.hsn_code]), [['Gym 30 days', '999.00', '49.95', '999723'], ['Joining fee', '500.00', '25.00', '999723']]);
    // A later price never changes what was sold.
    await request('PUT', G(`member-plans/plans/${gym30.id}`), { name: 'Gym 30 days', kind: 'duration', durationUnit: 'days', duration: '30', joiningSkuId: joiningFee.id,
      maxFreezes: '2', maxFreezeDays: '15', graceDays: '3', transferable: true, policy, price: '1099' });
    assert.equal((await request('GET', G(`member-plans/memberships/${sold.id}`))).price, '1048.95');
    await request('PUT', G(`member-plans/plans/${gym30.id}`), { name: 'Gym 30 days', kind: 'duration', durationUnit: 'days', duration: '30', joiningSkuId: joiningFee.id,
      maxFreezes: '2', maxFreezeDays: '15', graceDays: '3', transferable: true, policy, price: '999' });
    // A repeat of the same sale is the same membership; the same key with other data is refused.
    const again = { requestKey: key(), locationId: shop.id, planId: yoga.id, contactId: asha.id, payments: [{ amount: 'full', method: 'upi' }] };
    const pack = await request('POST', G('member-plans/memberships'), again, 201);
    assert.equal((await request('POST', G('member-plans/memberships'), again, 201)).id, pack.id);
    assert.equal((await refused('POST', G('member-plans/memberships'), { ...again, planId: gym90.id })).status, 409);
    assert.deepEqual([pack.joining_fee, pack.sessions_total, pack.sessions_left, pack.end_on, pack.policy_version, pack.member_code], ['0.00', 10, 10, null, 2, 'M0001']);
    // The same plan never overlaps itself: renew it to start after its end.
    const overlap = await refused('POST', G('member-plans/memberships'), { requestKey: key(), locationId: shop.id, planId: gym30.id, contactId: asha.id, startOn: addDays(today, 5) });
    assert.deepEqual([overlap.status, overlap.data?.reason], [409, 'overlap']);
    const renewal = await sell({ planId: gym30.id, contactId: asha.id, renewalOf: sold.id, payments: [{ amount: 'full', method: 'cash' }] });
    assert.deepEqual([renewal.start_on, renewal.end_on, renewal.joining_fee, renewal.source_no, renewal.status], [addDays(today, 30), addDays(today, 59), '0.00', sold.membership_no, 'upcoming']);
    assert.equal((await refused('POST', G('member-plans/memberships'), { requestKey: key(), locationId: shop.id, planId: gym30.id, contactId: asha.id, renewalOf: sold.id })).status, 409);
    // A membership starts today or later, within 180 days.
    ravi = await customer('Ravi Teja', '9876500002');
    assert.match((await refused('POST', G('member-plans/memberships'), { requestKey: key(), locationId: shop.id, planId: gym90.id, contactId: ravi.id, startOn: addDays(today, -1) })).message,
      /starts today or later/);
    // Who sells: the desk (with Sales); a trainer checks members in but takes no money.
    assert.equal((await refused('POST', G('member-plans/memberships'), { requestKey: key(), locationId: shop.id, planId: gym90.id, contactId: ravi.id }, trainer.token)).status, 403);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='membership.sold' AND entity_id=$2", [gym.id, sold.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='membership.renewed' AND entity_id=$2", [gym.id, renewal.id]));
    // A bill line that sold a membership is credited only from the membership.
    const back = await refused('POST', G(`documents/${sold.document_id}/returns`), { requestKey: key(), reason: 'Changed mind', lines: [{ lineId: sold.line_id, quantity: '1', restock: false }] });
    assert.deepEqual([back.status, /sold membership MS\//.test(back.message)], [409, true]);
  });

  await t.test('cancelling: the unused days come back pro rata to the paisa, with a manager\'s PIN, through the core\'s credit note and refund', async () => {
    const meena = await customer('Meena Iyer', '9876500003');
    const m = await sell({ planId: gym30.id, contactId: meena.id, payments: [{ amount: 'full', method: 'cash' }] });
    // Ten days pass: on the eleventh day 11 of the 30 days are used, 19 left: 1,048.95 × 19 / 30 = 664.335, to the paisa 664.34.
    await backdate(m.id, 10);
    const preview = await request('POST', G(`member-plans/memberships/${m.id}/cancel/preview`), {});
    assert.deepEqual([preview.lastDay, preview.used, preview.left, preview.whole, preview.by, preview.most, preview.creditNote, preview.refund, preview.stillDue],
      [today, 11, 19, 30, 'days', '664.34', '664.34', '664.34', '0.00']);
    // With the joining fee given back too.
    assert.equal((await request('POST', G(`member-plans/memberships/${m.id}/cancel/preview`), { joiningFee: true })).refund, '1189.34');
    // The desk does not cancel; a cancellation that gives anything back needs a manager's PIN; never more than the part not used.
    assert.equal((await refused('POST', G(`member-plans/memberships/${m.id}/cancel`), { requestKey: key(), reason: 'Moving to Pune' }, desk.token)).status, 403);
    const body = { requestKey: key(), reason: 'Moving to Pune', refund: { method: 'cash' } };
    const noPin = await refused('POST', G(`member-plans/memberships/${m.id}/cancel`), body);
    assert.deepEqual([noPin.status, noPin.data?.reason], [400, 'approval_needed']);
    assert.equal((await refused('POST', G(`member-plans/memberships/${m.id}/cancel`), { ...body, approval: { ...approval, pin: '1111' } })).status, 400);
    assert.match((await refused('POST', G(`member-plans/memberships/${m.id}/cancel`), { ...body, credit: '700', approval })).message, /At most 664\.34/);
    const cancelled = await request('POST', G(`member-plans/memberships/${m.id}/cancel`), { ...body, approval });
    assert.deepEqual([cancelled.status, cancelled.closed_on, cancelled.credit, cancelled.refunded, cancelled.approved_by_name], ['cancelled', today, '664.34', '664.34', 'gym-owner']);
    // The credit note splits GST in the line's own proportion and adds up exactly; the refund is the core's.
    const bill = await request('GET', G(`documents/${m.document_id}`));
    const credited = await one('SELECT rl.quantity,rl.net,rl.tax FROM business_return_lines rl JOIN business_returns r ON r.id=rl.return_id WHERE r.document_id=$1', [m.document_id]);
    assert.deepEqual([credited.net, credited.tax, bill.returns[0].total, bill.refunds[0].amount, bill.refunds[0].method], ['632.70', '31.64', '664.34', '664.34', 'cash']);
    assert.equal(paise(credited.net) + paise(credited.tax), paise('664.34'));
    assert.equal(paise(bill.total) - paise(bill.returns[0].total) - paise(bill.payments[0].amount) + paise(bill.refunds[0].amount), 0, 'nothing is owed on the bill either way');
    // Asking again is the same cancellation; the same key with other data is refused; it lets no one in now.
    const repeat = await request('POST', G(`member-plans/memberships/${m.id}/cancel`), { ...body, approval });
    assert.equal(repeat.refunded, '664.34');
    assert.equal((await one('SELECT count(*)::int AS n FROM business_refunds WHERE document_id=$1', [m.document_id])).n, 1);
    assert.equal((await refused('POST', G(`member-plans/memberships/${m.id}/cancel`), { ...body, reason: 'Other', approval })).status, 409);
    const turned = await checkIn({ contactId: meena.id });
    assert.deepEqual([turned.allowed, turned.reason], [false, 'no_membership']);
    // The audit names the manager who approved; the outbox has the cancellation.
    const audit = await one("SELECT actor_id,details FROM business_audit WHERE business_id=$1 AND action='membership.cancelled' AND entity_id=$2", [gym.id, m.id]);
    assert.deepEqual([Number(audit.actor_id), audit.details.refund, audit.details.creditNote], [Number(ownerUser.id), '664.34', '664.34']);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='membership.cancelled' AND entity_id=$2", [gym.id, m.id]));
    // A pack comes back by the sessions left: 3 of 10 used, 7 left: 2,098.95 × 7 / 10 = 1,469.265, to the paisa 1,469.27.
    const pack = await sell({ planId: yoga.id, contactId: meena.id, payments: [{ amount: 'full', method: 'upi' }] });
    await pool.query('UPDATE member_memberships SET sessions_used=3 WHERE id=$1', [pack.id]);
    const byPack = await request('POST', G(`member-plans/memberships/${pack.id}/cancel/preview`), {});
    assert.deepEqual([byPack.by, byPack.left, byPack.whole, byPack.most], ['sessions', 7, 10, '1469.27']);
    // A pack with a time comes back by the smaller part left: 21 of 60 days used (39 left) but 4 of 8 sessions (4 left): half of 6,720.00.
    const ptPack = await sell({ planId: pt.id, contactId: meena.id, payments: [{ amount: 'full', method: 'card' }] });
    await backdate(ptPack.id, 20);
    await pool.query('UPDATE member_memberships SET sessions_used=4 WHERE id=$1', [ptPack.id]);
    const smaller = await request('POST', G(`member-plans/memberships/${ptPack.id}/cancel/preview`), {});
    assert.deepEqual([smaller.by, smaller.left, smaller.whole, smaller.most], ['sessions', 4, 8, '3360.00']);
    // Money not yet paid is not refunded: the credit note lowers what is owed.
    const unpaid = await sell({ planId: gym90.id, contactId: meena.id, payments: [{ amount: '1000', method: 'cash' }] });
    const owed = await request('POST', G(`member-plans/memberships/${unpaid.id}/cancel/preview`), {});
    // On its first day 1 of 90 days is used: 2,835.00 × 89 / 90 = 2,803.50 comes off the bill, leaving 31.50 for the day used; of the 1,000 paid, 968.50 goes back.
    assert.deepEqual([owed.most, owed.creditNote, owed.refund, owed.stillDue], ['2803.50', '2803.50', '968.50', '0.00']);
    // Cancelling without giving anything back needs no PIN.
    const plain = await request('POST', G(`member-plans/memberships/${unpaid.id}/cancel`), { requestKey: key(), reason: 'Member asked, no refund', credit: '0' });
    assert.deepEqual([plain.status, plain.credit, plain.return_id], ['cancelled', null, null]);
  });

  await t.test('upgrading: the unused part is a credit note that pays the new plan\'s bill first, to the paisa', async () => {
    const kiran = await customer('Kiran Kumar', '9876500004');
    const m = await sell({ planId: gym30.id, contactId: kiran.id, joiningFee: false, payments: [{ amount: 'full', method: 'cash' }] });
    await backdate(m.id, 10);
    // The new plan starts today: 10 days used (to yesterday), 20 of 30 left: 1,048.95 × 20 / 30 = 699.30.
    const preview = await desk.call('POST', G(`member-plans/memberships/${m.id}/upgrade/preview`), { planId: gym90.id });
    assert.deepEqual([preview.lastDay, preview.used, preview.left, preview.credit, preview.creditApplied, preview.newTotal, preview.due, preview.startOn, preview.endOn],
      [addDays(today, -1), 10, 20, '699.30', '699.30', '2835.00', '2135.70', today, addDays(today, 89)]);
    const body = { requestKey: key(), planId: gym90.id, payments: [{ amount: 'full', method: 'upi' }] };
    const next = await desk.call('POST', G(`member-plans/memberships/${m.id}/upgrade`), body, 201);
    assert.deepEqual([next.plan_name, next.start_on, next.end_on, next.source_no, next.status, next.bill.due], ['Gym 90 days', today, addDays(today, 89), m.membership_no, 'active', '0.00']);
    const old = await request('GET', G(`member-plans/memberships/${m.id}`));
    assert.deepEqual([old.status, old.closed_on, old.credit], ['upgraded', addDays(today, -1), '699.30']);
    // The old bill: a credit note of 699.30 (666.00 + 33.30) moved to the new bill by credit note; the new bill: 699.30 by credit note and 2,135.70 by UPI.
    const credited = await one('SELECT rl.net,rl.tax FROM business_return_lines rl JOIN business_returns r ON r.id=rl.return_id WHERE r.document_id=$1', [m.document_id]);
    assert.deepEqual([credited.net, credited.tax], ['666.00', '33.30']);
    const oldBill = await request('GET', G(`documents/${m.document_id}`));
    assert.deepEqual(oldBill.refunds.map((f) => [f.amount, f.method]), [['699.30', 'credit_note']]);
    const newBill = await request('GET', G(`documents/${next.document_id}`));
    assert.deepEqual(newBill.payments.map((p) => [p.amount, p.method]).sort(), [['2135.70', 'upi'], ['699.30', 'credit_note']]);
    assert.equal(paise(newBill.total), paise('699.30') + paise('2135.70'));
    // Asking again is the same upgrade; a membership already upgraded is not upgraded again.
    assert.equal((await desk.call('POST', G(`member-plans/memberships/${m.id}/upgrade`), body, 201)).id, next.id);
    assert.equal((await refused('POST', G(`member-plans/memberships/${m.id}/upgrade`), { ...body, requestKey: key() }, desk.token)).status, 409);
    // A credit bigger than the new plan's bill is refused: that is a cancellation with a refund.
    const big = await sell({ planId: gym90.id, contactId: kiran.id, startOn: addDays(today, 90), payments: [{ amount: 'full', method: 'cash' }] });
    const cheaper = await refused('POST', G(`member-plans/memberships/${big.id}/upgrade/preview`), { planId: gym30.id });
    assert.deepEqual([cheaper.status, cheaper.data?.reason, cheaper.data?.credit], [409, 'credit_exceeds_plan', '2835.00']);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='membership.upgraded' AND entity_id=$2", [gym.id, m.id]));
  });

  await t.test('freezing and transferring within the plan\'s rules', async () => {
    const sunita = await customer('Sunita Devi', '9876500005');
    const m = await sell({ planId: gym30.id, contactId: sunita.id, payments: [{ amount: 'full', method: 'cash' }] });
    const frozen = await desk.call('POST', G(`member-plans/memberships/${m.id}/freeze`), { requestKey: key(), days: '5', reason: 'Travelling' }, 201);
    assert.deepEqual([frozen.status, frozen.end_on, frozen.frozen_days, frozen.freeze_left], ['frozen', addDays(today, 34), 5, { freezes: 1, days: 10 }]);
    const turned = await checkIn({ contactId: sunita.id }, trainer.call);
    assert.deepEqual([turned.allowed, turned.reason], [false, 'frozen']);
    // Back the same day: the freeze is called off and its days given back (it does not count).
    const back = await desk.call('POST', G(`member-plans/memberships/${m.id}/unfreeze`), {});
    assert.deepEqual([back.status, back.end_on, back.freeze_left], ['active', addDays(today, 29), { freezes: 2, days: 15 }]);
    // Within the plan's limits: 15 days in all, in 2 freezes.
    assert.match((await refused('POST', G(`member-plans/memberships/${m.id}/freeze`), { requestKey: key(), startsOn: addDays(today, 2), days: '16' }, desk.token)).message, /15 more days at most/);
    await desk.call('POST', G(`member-plans/memberships/${m.id}/freeze`), { requestKey: key(), startsOn: addDays(today, 2), days: '10' }, 201);
    await desk.call('POST', G(`member-plans/memberships/${m.id}/freeze`), { requestKey: key(), startsOn: addDays(today, 15), days: '5' }, 201);
    assert.match((await refused('POST', G(`member-plans/memberships/${m.id}/freeze`), { requestKey: key(), startsOn: addDays(today, 25), days: '1' }, desk.token)).message, /2 freezes its plan allows/);
    assert.equal((await request('GET', G(`member-plans/memberships/${m.id}`))).end_on, addDays(today, 44));
    // A transfer waits until no freeze is to come; it needs the plan's leave and a paid bill.
    assert.match((await refused('POST', G(`member-plans/memberships/${m.id}/transfer`), { requestKey: key(), toMember: { name: 'Gita' } }, desk.token)).message, /freeze to come/);
    const lalit = await customer('Lalit Mohan', '9876500006');
    const loan = await sell({ planId: gym30.id, contactId: lalit.id, joiningFee: false });
    const unpaid = await refused('POST', G(`member-plans/memberships/${loan.id}/transfer`), { requestKey: key(), toMember: { name: 'Gita Sharma', phone: '9876500007' } }, desk.token);
    assert.deepEqual([unpaid.status, /still to pay/.test(unpaid.message)], [409, true]);
    await request('POST', G(`documents/${loan.document_id}/payments`), { requestKey: key(), amount: '1048.95', method: 'cash' }, 201);
    const body = { requestKey: key(), toMember: { name: 'Gita Sharma', phone: '9876500007' }, reason: 'Gave it to his sister' };
    const moved = await desk.call('POST', G(`member-plans/memberships/${loan.id}/transfer`), body, 201);
    assert.deepEqual([moved.member_name, moved.start_on, moved.end_on, moved.source_no, moved.document_id, moved.status, moved.member_code],
      ['Gita Sharma', today, loan.end_on, loan.membership_no, loan.document_id, 'active', 'M0006']);
    assert.equal((await desk.call('POST', G(`member-plans/memberships/${loan.id}/transfer`), body, 201)).id, moved.id, 'asking again is the same transfer');
    const was = await request('GET', G(`member-plans/memberships/${loan.id}`));
    assert.deepEqual([was.status, was.closed_on], ['transferred', addDays(today, -1)]);
    assert.equal((await checkIn({ contactId: lalit.id })).allowed, false);
    assert.equal((await checkIn({ contactId: moved.contact_id })).allowed, true);
    // Nothing comes back from a membership passed on: its bill is the first member's.
    assert.equal((await request('POST', G(`member-plans/memberships/${moved.id}/cancel/preview`), {})).most, '0.00');
    assert.match((await refused('POST', G(`member-plans/memberships/${moved.id}/cancel`), { requestKey: key(), reason: 'x', credit: '10', approval })).message, /passed on by another member/);
    assert.match((await refused('POST', G(`member-plans/memberships/${moved.id}/upgrade/preview`), { planId: gym90.id })).message, /passed on by another member/);
    // A plan that does not allow it is not passed on.
    const notMine = await sell({ planId: gym90.id, contactId: lalit.id, payments: [{ amount: 'full', method: 'cash' }] });
    assert.match((await refused('POST', G(`member-plans/memberships/${notMine.id}/transfer`), { requestKey: key(), toContactId: sunita.id }, desk.token)).message, /not passed on/);
  });

  await t.test('check-in: by code or search, let in or turned away with the reason, one session a day off a pack, fees overdue', async () => {
    const asha30 = (await request('GET', G(`member-plans/members/${asha.id}`))).memberships;
    // By the code on the card (any case), and again the same day.
    const first = await checkIn({ code: 'm0001' }, desk.call);
    assert.deepEqual([first.allowed, first.member_name, first.plan_name, first.found_by, first.again_today], [true, 'Asha Rao', 'Gym 30 days', 'code', false]);
    const second = await checkIn({ code: 'M0001' }, desk.call);
    assert.deepEqual([second.allowed, second.again_today], [true, true]);
    assert.equal((await refused('POST', G('member-plans/check-ins'), { requestKey: key(), locationId: shop.id, code: 'M9999' }, desk.token)).status, 404);
    // A pack loses one session a day, asked for by name; the trainer checks members in.
    const yogaPack = asha30.find((x) => x.plan_name === 'Yoga 10 classes');
    const session = await checkIn({ contactId: asha.id, membershipId: yogaPack.id }, trainer.call);
    assert.deepEqual([session.allowed, session.session_used, session.sessions_left], [true, true, 9]);
    const sameDay = await checkIn({ contactId: asha.id, membershipId: yogaPack.id }, trainer.call);
    assert.deepEqual([sameDay.allowed, sameDay.session_used, sameDay.sessions_left], [true, false, 9]);
    // A repeat of a check-in is the same check-in.
    const tap = { requestKey: key(), locationId: shop.id, contactId: asha.id };
    assert.equal((await request('POST', G('member-plans/check-ins'), tap, 201)).id, (await request('POST', G('member-plans/check-ins'), tap, 201)).id);
    // Not started, over (after the grace days), in the grace days; a viewer does not check in.
    const upcoming = await checkIn({ contactId: asha.id, membershipId: asha30.find((x) => x.status === 'upcoming').id });
    assert.deepEqual([upcoming.allowed, upcoming.reason], [false, 'not_started']);
    const nikhil = await customer('Nikhil Jain', '9876500008');
    const ended = await sell({ planId: gym30.id, contactId: nikhil.id, joiningFee: false, payments: [{ amount: 'full', method: 'cash' }] });
    await backdate(ended.id, 31);
    const grace = await checkIn({ contactId: nikhil.id });
    assert.deepEqual([grace.allowed, /grace days until/.test(grace.note)], [true, true]);
    await backdate(ended.id, 3);
    const over = await checkIn({ contactId: nikhil.id });
    assert.deepEqual([over.allowed, over.reason, /ended on/.test(over.words)], [false, 'expired', true]);
    assert.equal((await refused('POST', G('member-plans/check-ins'), { requestKey: key(), locationId: shop.id, contactId: nikhil.id }, viewer.token)).status, 403);
    // Fees overdue by more than the business's days (7 until changed) turn a member away.
    const owes = await customer('Owes Fees', '9876500009');
    const credit = await sell({ planId: gym90.id, contactId: owes.id, joiningFee: false });
    assert.equal((await checkIn({ contactId: owes.id })).allowed, true);
    await pool.query('UPDATE business_documents SET due_on=due_on-10 WHERE id=$1', [credit.document_id]);
    const dues = await checkIn({ contactId: owes.id }, desk.call);
    assert.deepEqual([dues.allowed, dues.reason, dues.fees_overdue, /10 days overdue/.test(dues.words)], [false, 'dues', '2835.00', true]);
    const trainerSees = await checkIn({ contactId: owes.id }, trainer.call);
    assert.deepEqual([trainerSees.reason, trainerSees.fees_overdue], ['dues', null], 'a trainer sees no money');
    assert.equal((await request('GET', G('member-plans/settings'))).duesBlockDays, 7);
    await desk.call('PUT', G('member-plans/settings'), { duesBlockDays: '15' }, 403);
    await request('PUT', G('member-plans/settings'), { duesBlockDays: '15' });
    assert.equal((await checkIn({ contactId: owes.id })).allowed, true);
    await request('PUT', G('member-plans/settings'), { duesBlockDays: null });
    // Today's check-ins, let in and turned away.
    const listed = await trainer.call('GET', G(`member-plans/check-ins?from=${today}&to=${today}&limit=100`));
    assert.ok(listed.items.some((k) => k.reason === 'dues') && listed.items.some((k) => k.session_used));
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='member.checkin_refused'", [gym.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='membership.session_used' AND entity_id=$2", [gym.id, yogaPack.id]));
  });

  await t.test('instalments: amounts and due days adding up to the bill, covered in order by collections, overdue and fees due', async () => {
    const student = await customer('Arjun Reddy', '9876500010');
    const fee = (day, amount) => ({ dueOn: day, amount });
    const four = [fee(today, '14160'), fee(addDays(today, 30), '14160'), fee(addDays(today, 60), '14160'), fee(addDays(today, 90), '14160')];
    // 48,000 + 18% = 56,640.00 in four instalments; they must add up to the bill and fall due in order.
    const wrong = await refused('POST', G('member-plans/memberships'), { requestKey: key(), locationId: shop.id, planId: coaching.id, contactId: student.id,
      instalments: [fee(today, '14160'), fee(addDays(today, 30), '14160')] });
    assert.deepEqual([wrong.status, wrong.data?.reason, wrong.data?.billTotal], [409, 'instalments_total', '56640.00']);
    assert.match((await refused('POST', G('member-plans/memberships'), { requestKey: key(), locationId: shop.id, planId: coaching.id, contactId: student.id,
      instalments: [fee(addDays(today, 30), '28320'), fee(today, '28320')] })).message, /falls due after instalment 1/);
    const enrolled = await sell({ planId: coaching.id, contactId: student.id, instalments: four, payments: [{ amount: '14160', method: 'upi' }] });
    assert.deepEqual([enrolled.end_on, enrolled.bill.total, enrolled.bill.due_on, enrolled.instalments.map((i) => i.status)],
      [addDays(addMonthsOf(today, 12), -1), '56640.00', addDays(today, 90), ['paid', 'due', 'due', 'due']]);
    // A collection through the shared receivables covers the next instalment in part.
    await request('POST', G('collections'), { requestKey: key(), locationId: shop.id, contactId: student.id, amount: '10000', method: 'cash',
      allocations: [{ documentId: enrolled.document_id, amount: '10000' }] }, 201);
    const now = await request('GET', G(`member-plans/memberships/${enrolled.id}`));
    assert.deepEqual(now.instalments.map((i) => [i.status, i.covered]), [['paid', '14160.00'], ['part_paid', '10000.00'], ['due', '0.00'], ['due', '0.00']]);
    // Time passes: the second instalment is 10 days overdue.
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE member_instalments DISABLE TRIGGER member_instalments_append_only');
      await db.query('UPDATE member_instalments SET due_on=due_on-40 WHERE membership_id=$1 AND seq<=2', [enrolled.id]);
      await db.query('ALTER TABLE member_instalments ENABLE TRIGGER member_instalments_append_only');
      await db.query('COMMIT');
    } finally { db.release(); }
    const due = await request('GET', G(`member-plans/instalments?contact=${student.id}&open=true`));
    assert.deepEqual(due.items.map((i) => [i.seq, i.status, paise(i.left_to_pay), i.days_overdue]), [[2, 'overdue', 416000, 10], [3, 'due', 1416000, 0], [4, 'due', 1416000, 0]]);
    await request('PUT', G('member-plans/settings'), { duesBlockDays: '7' });
    const turned = await checkIn({ contactId: student.id });
    assert.deepEqual([turned.allowed, turned.reason], [false, 'dues']);
    await request('PUT', G('member-plans/settings'), { duesBlockDays: null });
    // Fees are money: a trainer has no list of them.
    assert.equal((await refused('GET', G('member-plans/instalments'), undefined, trainer.token)).status, 403);
    const counts = await request('GET', G('member-plans/counts'));
    assert.deepEqual([counts.instalments_overdue, counts.fees_overdue], [1, '4160.00']);
    // Instalments never change once set.
    await assert.rejects(pool.query('UPDATE member_instalments SET amount=1 WHERE membership_id=$1', [enrolled.id]), /kept as they were set/);
  });

  await t.test('lists: members with their current plan, renewal calls with reminders, money hidden from those who do not see sales', async () => {
    const members = await desk.call('GET', G('member-plans/members?q=Asha'));
    assert.deepEqual(members.items.map((x) => [x.name, x.member_code, x.plan_name, x.status, x.running]), [['Asha Rao', 'M0001', 'Gym 30 days', 'active', 3]]);
    const page = await request('GET', G(`member-plans/members/${asha.id}`));
    assert.deepEqual(page.memberships.map((x) => x.status), ['active', 'active', 'upcoming']);
    assert.ok(page.checkins.length >= 3);
    // Renewal calls: ending in 7 or 15 days, ended in the last 30, not renewed.
    const ravi30 = await sell({ planId: gym30.id, contactId: ravi.id, joiningFee: false, payments: [{ amount: 'full', method: 'cash' }] });
    await backdate(ravi30.id, 25);
    const soon = await desk.call('GET', G('member-plans/renewals?soon7=true'));
    assert.ok(soon.items.some((r) => r.id === ravi30.id && r.days_left === 4));
    assert.ok(!soon.items.some((r) => r.contact_id === asha.id), 'a membership renewed already is not called about');
    const ended = await desk.call('GET', G('member-plans/renewals?ended=true'));
    assert.ok(ended.items.every((r) => r.days_left < 0));
    await desk.call('POST', G(`member-plans/memberships/${ravi30.id}/reminders`), { kind: 'renewal', channel: 'whatsapp' }, 201);
    assert.equal((await desk.call('GET', G('member-plans/renewals?soon7=true'))).items.find((r) => r.id === ravi30.id).reminders, 1);
    await assert.rejects(pool.query("UPDATE member_reminders SET channel='call'"), /kept as it was given/);
    // A trainer sees members and plans, but no prices or dues.
    const seen = await trainer.call('GET', G(`member-plans/members/${asha.id}`));
    assert.deepEqual([seen.money, seen.member.dues, seen.memberships[0].price, seen.memberships[0].bill], [false, null, null, null]);
    assert.equal((await trainer.call('GET', G('member-plans/memberships'))).items[0].price, null);
    // The member code can be the number on a card they already hold.
    await desk.call('PUT', G(`member-plans/members/${ravi.id}/code`), { code: 'gym-0042' });
    assert.equal((await checkIn({ code: 'GYM-0042' })).member_name, 'Ravi Teja');
    assert.equal((await refused('PUT', G(`member-plans/members/${ravi.id}/code`), { code: 'M0001' }, desk.token)).status, 409);
    // The bell: memberships ending in the next three days or in their grace days.
    await backdate(ravi30.id, 2);
    const bell = await request('GET', G('notifications'));
    assert.ok(bell.items.some((n) => n.category === 'Memberships' && n.title === "Ravi Teja's Gym 30 days ends in 2 days"));
  });

  await t.test('other types and other owners are kept out', async () => {
    // A grocery has no plans & memberships: refused before anything is read.
    assert.equal((await refused('GET', `/businesses/${grocery.id}/member-plans/plans`)).status, 403);
    assert.equal((await refused('POST', `/businesses/${optical.id}/member-plans/check-ins`, { requestKey: key(), locationId: shop.id, code: 'M0001' })).status, 403);
    // Another owner's gym: not theirs to read.
    assert.equal((await call('GET', G('member-plans/plans'), undefined, (await login('gym-other@test.invalid')))).status, 404);
    assert.equal((await other('GET', `/businesses/${elsewhere.id}/member-plans/members`)).total, 0);
    // A viewer reads, and changes nothing.
    assert.equal((await refused('POST', G(`member-plans/memberships/${(await request('GET', G('member-plans/memberships'))).items[0].id}/freeze`), { requestKey: key(), days: '1' }, viewer.token)).status, 403);
  });
});
