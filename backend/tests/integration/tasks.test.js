const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { withTools } = require('./helpers/tools');
const dates = require('./helpers/dates');

// Tasks, issues & projects (migration 1791620000000, backend/src/modules/tasks):
// one data model keyed on business_id, two front doors (/api/tasks for the
// signed-in restaurant, /api/businesses/:id/tasks for any business). Covers
// the template library and own templates, assignment rules (people, role,
// on shift, self only), recurring tasks without duplicates and the missed
// sweep, failed answers raising issues, completion and review rules,
// permissions and outlet scope, tenant isolation, the log book link,
// projects and the reports' arithmetic.
test('tasks, issues and projects', { timeout: 900000 }, async (t) => {
  require('dotenv').config({ quiet: true });
  const database = `rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  const admin = new Client({ ...connection, database: 'postgres' });
  let created = false, pool, server;
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
  const recurrence = require('../../src/modules/tasks/services/recurrence.service');

  // Two restaurants. In the first: an owner, a manager, a cashier tied to outlet A,
  // a kitchen hand with a staff record, and a store keeper.
  const password = `Tasks-${crypto.randomBytes(8).toString('hex')}`;
  const hash = await bcrypt.hash(password, 4);
  const restaurant = async (code) => {
    const r = await one('INSERT INTO restaurants(name,code) VALUES($1,$1) RETURNING id', [code]);
    await pool.query("INSERT INTO restaurant_settings(restaurant_id, timezone) VALUES($1, 'Asia/Kolkata')", [r.id]);
    return r.id;
  };
  const rid = await restaurant('TASKS1');
  const rid2 = await restaurant('TASKS2');
  const outletA = (await one("INSERT INTO outlets(restaurant_id,name,code) VALUES($1,'Indiranagar','IND') RETURNING id", [rid])).id;
  const outletB = (await one("INSERT INTO outlets(restaurant_id,name,code) VALUES($1,'Koramangala','KOR') RETURNING id", [rid])).id;
  const outletOther = (await one("INSERT INTO outlets(restaurant_id,name,code) VALUES($1,'Elsewhere','ELS') RETURNING id", [rid2])).id;
  const makeUser = async (restaurantId, email, role, outletId = null) => {
    const user = await one('INSERT INTO users(restaurant_id,outlet_id,name,email,password_hash) VALUES($1,$2,$3,$3,$4) RETURNING id', [restaurantId, outletId, email, hash]);
    await pool.query('INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 AND restaurant_id IS NULL', [user.id, role]);
    return Number(user.id);
  };
  const ids = {
    owner: await makeUser(rid, 'owner@tasks.invalid', 'RESTAURANT_ADMIN'),
    manager: await makeUser(rid, 'manager@tasks.invalid', 'MANAGER'),
    cashier: await makeUser(rid, 'cashier@tasks.invalid', 'CASHIER', outletA),
    kitchen: await makeUser(rid, 'kitchen@tasks.invalid', 'KITCHEN'),
    other: await makeUser(rid2, 'other@tasks.invalid', 'RESTAURANT_ADMIN'),
  };
  const kitchenEmployee = (await one("INSERT INTO employees(restaurant_id,user_id,employee_code,name,status) VALUES($1,$2,'K1','Kitchen Ravi','active') RETURNING id", [rid, ids.kitchen])).id;
  const cashierEmployee = (await one("INSERT INTO employees(restaurant_id,user_id,employee_code,name,status) VALUES($1,$2,'C1','Cashier Meena','active') RETURNING id", [rid, ids.cashier])).id;
  const noLogin = (await one("INSERT INTO employees(restaurant_id,employee_code,name,status) VALUES($1,'H1','Helper Babu','active') RETURNING id", [rid])).id;

  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = {};
  for (const who of Object.keys(ids)) {
    const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: `${who}@tasks.invalid`, password }) });
    tokens[who] = (await response.json()).data.token;
  }
  const call = async (who, method, route, body, expected = 200) => {
    const isForm = body instanceof FormData;
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[who]}`, ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const json = await response.json();
    assert.equal(response.status, expected, `${who} ${method} ${route}: ${JSON.stringify(json).slice(0, 400)}`);
    return expected >= 400 ? json : json.data;
  };
  const as = (who) => (method, route, body, expected) => call(who, method, route, body, expected);
  const O = as('owner'), M = as('manager'), C = as('cashier'), K = as('kitchen'), X = as('other');
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const HOUR = 3600000, DAY = 24 * HOUR;
  const businessOf = async (restaurantId) => Number((await one('SELECT restaurant_business_id($1) AS id', [restaurantId])).id);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const photo = (itemId) => { const fd = new FormData(); if (itemId) fd.append('itemId', String(itemId)); fd.append('kind', 'photo'); fd.append('file', new Blob([png], { type: 'image/png' }), 'p.png'); return fd; };

  await t.test('the three modules start on for the restaurant and are an owner\'s choice for every other type, with their permissions', async () => {
    const types = await pool.query("SELECT business_type, count(*)::int AS n, count(*) FILTER (WHERE enabled_by_default)::int AS on_ FROM platform_module_business_types WHERE module_code IN ('tasks','issues','projects') GROUP BY 1");
    assert.equal(types.rows.length, 23);
    assert.ok(types.rows.every((r) => r.n === 3 && r.on_ === (r.business_type === 'restaurant' ? 3 : 0)));
    const me = await O('GET', '/auth/me');
    for (const code of ['tasks', 'issues', 'projects']) assert.ok(me.features.includes(code), code);
    assert.ok(me.permissions.includes('tasks.manage') && me.permissions.includes('issues.review'));
    const cashier = await C('GET', '/auth/me');
    assert.deepEqual(cashier.permissions.filter((p) => /^(tasks|issues|projects)\./.test(p)), ['issues.create']);
    const ctx = await O('GET', '/tasks/context');
    assert.equal(ctx.world, 'restaurant');
    assert.equal(ctx.categories.length, 14);
    // People are searched on the server (paged), not loaded with the context.
    assert.equal(ctx.directory.people, undefined);
    assert.ok(ctx.directory.peopleCount >= 2);
    const everyone = await O('GET', '/tasks/people?limit=50');
    assert.equal(everyone.total, ctx.directory.peopleCount);
    assert.ok(everyone.rows.some((p) => p.kind === 'employee' && p.id === Number(noLogin)), 'staff without a login can be assigned');
    const logins = await O('GET', '/tasks/people?kind=user&limit=50');
    assert.ok(logins.rows.length > 0 && logins.rows.every((p) => p.kind === 'user'));
    assert.equal(ctx.directory.places.length, 2);
  });

  await t.test('template library by business type; own templates are copied, edited and validated', async () => {
    const lib = await O('GET', '/tasks/library');
    assert.ok(lib.some((x) => x.code === 'restaurant.temperature_log'));
    assert.ok(lib.some((x) => x.code === 'common.opening'));
    assert.ok(!lib.some((x) => x.code === 'pharmacy.fridge'), 'another type\'s template is not offered');
    const temp = await O('GET', '/tasks/library/restaurant.temperature_log');
    const chiller = temp.items.find((i) => i.label === 'Walk-in chiller');
    assert.equal(chiller.kind, 'number');
    assert.deepEqual([chiller.min_value, chiller.max_value, chiller.critical], [0, 5, true]);
    await O('GET', '/tasks/library/pharmacy.fridge', undefined, 404);
    const copy = await O('POST', '/tasks/templates/copy', { libraryCode: 'restaurant.fssai_hygiene' }, 201);
    assert.equal(copy.libraryCode, 'restaurant.fssai_hygiene');
    assert.ok(copy.items.length > 10);
    const items = [{ kind: 'section', label: 'Bar' }, { kind: 'number', label: 'Beer fridge', minValue: 1, maxValue: 6, unit: '°C', critical: true },
      { kind: 'choice', label: 'Glassware', options: [{ label: 'Clean' }, { label: 'Smudged', fail: true }] }, { kind: 'photo', label: 'Photo of the bar' }];
    const saved = await O('PUT', `/tasks/templates/${copy.id}`, { name: 'Bar hygiene', category: 'food_safety', items });
    assert.equal(saved.items.length, 4);
    assert.equal(saved.items[0].required, false, 'a section is never required');
    await O('PUT', `/tasks/templates/${copy.id}`, { name: 'Bad', items: [{ kind: 'number', label: 'x', minValue: 5, maxValue: 1 }] }, 400);
    await O('PUT', `/tasks/templates/${copy.id}`, { name: 'Bad', items: [{ kind: 'choice', label: 'x', options: [{ label: 'only one' }] }] }, 400);
    await O('POST', '/tasks/templates', { name: 'Empty', items: [{ kind: 'section', label: 'Only a heading' }] }, 400);
    await M('POST', '/tasks/templates', { name: 'Manager made', items: [{ kind: 'checkbox', label: 'Lights off' }] }, 201);
    await C('POST', '/tasks/templates', { name: 'Cashier made', items: [{ kind: 'checkbox', label: 'x' }] }, 403);
    await C('GET', '/tasks/library', undefined, 200);
    const own = await O('GET', '/tasks/templates');
    assert.equal(own.length, 2);
  });

  await t.test('assignment: self only without assign; people, several people, a role, staff records, on shift', async () => {
    // A cashier has no tasks.create; a store keeper neither. The owner assigns.
    await C('POST', '/tasks', { title: 'Mine' }, 403);
    const toCashier = await O('POST', '/tasks', { title: 'Count the float', assignMode: 'people', assignees: [{ kind: 'user', id: ids.cashier }], placeId: outletA, dueAt: iso(2 * HOUR) }, 201);
    const mine = await C('GET', '/tasks/my');
    assert.ok(mine.tasks.some((x) => x.id === toCashier.id && x.mine));
    const several = await O('POST', '/tasks', { title: 'Restock straws', assignees: [{ kind: 'user', id: ids.manager }, { kind: 'employee', id: Number(kitchenEmployee) }, { kind: 'employee', id: Number(noLogin) }] }, 201);
    assert.match(several.assigneeNames, /Kitchen Ravi/);
    assert.ok((await K('GET', '/tasks/my')).tasks.some((x) => x.id === several.id), 'the staff record linked to a login counts as that person');
    assert.ok((await M('GET', '/tasks/my')).tasks.some((x) => x.id === several.id));
    assert.ok(!(await C('GET', '/tasks/my')).tasks.some((x) => x.id === several.id));
    const managerRole = Number((await one("SELECT id FROM roles WHERE code='MANAGER' AND restaurant_id IS NULL")).id);
    const byRole = await O('POST', '/tasks', { title: 'Approve the weekly order', assignMode: 'role', assignees: [{ kind: 'role', id: managerRole }] }, 201);
    assert.ok((await M('GET', '/tasks/my')).tasks.some((x) => x.id === byRole.id));
    assert.ok(!(await K('GET', '/tasks/my')).tasks.some((x) => x.id === byRole.id));
    // A manager (tasks.assign) assigns; a person from another restaurant cannot be named.
    await M('POST', '/tasks', { title: 'x', assignees: [{ kind: 'user', id: ids.other }] }, 400);
    await O('POST', '/tasks', { title: 'x', assignMode: 'role', assignees: [] }, 400);
    await O('POST', '/tasks', { title: 'x', assignMode: 'on_shift', assignees: [{ kind: 'user', id: ids.owner }] }, 400);
    // On shift: with nobody rostered that day everyone sees it; once a roster exists, only those rostered or clocked in.
    // The task's day is the day it is due: tonight, so today's roster is its roster
    // whatever the hour (an hour from now is tomorrow's date after 23:00).
    const today = dates.today();
    const onShift = await O('POST', '/tasks', { title: 'Close the gas valves', assignMode: 'on_shift', dueAt: dates.momentAt(today, '23:59') }, 201);
    assert.ok((await K('GET', '/tasks/my')).tasks.some((x) => x.id === onShift.id));
    assert.ok((await C('GET', '/tasks/my')).tasks.some((x) => x.id === onShift.id));
    const shift = (await one("INSERT INTO shifts(restaurant_id,name,start_time,end_time) VALUES($1,'Evening','16:00','23:59') RETURNING id", [rid])).id;
    await pool.query("INSERT INTO shift_assignments(restaurant_id,employee_id,shift_id,work_date,assignment_status) VALUES($1,$2,$3,$4,'scheduled')", [rid, kitchenEmployee, shift, today]);
    assert.ok((await K('GET', '/tasks/my')).tasks.some((x) => x.id === onShift.id), 'rostered today');
    assert.ok(!(await C('GET', '/tasks/my')).tasks.some((x) => x.id === onShift.id), 'not rostered, not clocked in');
    await pool.query("INSERT INTO attendance(restaurant_id,employee_id,attendance_date,check_in,attendance_status) VALUES($1,$2,$3,now(),'present')", [rid, cashierEmployee, today]);
    assert.ok((await C('GET', '/tasks/my')).tasks.some((x) => x.id === onShift.id), 'clocked in counts as on shift');
    // Starting a shared task makes it yours; others see who has it.
    const started = await K('POST', `/tasks/${onShift.id}/start`, {});
    assert.equal(started.startedByName, 'kitchen@tasks.invalid');
  });

  await t.test('recurring tasks: generated once however often asked, past days missed, edits regenerate the future only', async () => {
    // A day's last check stays open until the 5 am cut-off the next morning, so the
    // days that are over are those before the trading date (yesterday's date
    // between midnight and the cut-off). Occurrences are made to a week past today.
    const today = dates.today();
    const trading = dates.tradingToday();
    const startsOn = dates.addDays(trading, -3);
    const s = await O('POST', '/tasks/schedules', { title: 'Temperature log', libraryCode: 'restaurant.temperature_log', frequency: 'daily', dueTimes: ['10:30', '17:00'],
      assignMode: 'on_shift', startsOn, placeId: outletA }, 201);
    const business = await businessOf(rid);
    const countOf = async () => Number((await one('SELECT count(*) AS n FROM business_tasks WHERE business_id=$1 AND schedule_id=$2', [business, s.id])).n);
    // From three days before the trading date to a week past today, two a day.
    const made = 2 * (dates.daysBetween(startsOn, dates.addDays(today, 7)) + 1);
    assert.equal(await countOf(), made);
    const scope = await require('../../src/modules/tasks/services/scope').forRestaurant({ user: { ...(await O('GET', '/auth/me')), id: ids.owner, restaurantId: rid } });
    await pool.query('UPDATE business_task_schedules SET generated_through = NULL WHERE id = $1', [s.id]);
    await Promise.all(Array.from({ length: 6 }, () => recurrence.ensure(scope, { force: true })));
    assert.equal(await countOf(), made, 'six screens at once make nothing twice');
    const dup = await one('SELECT count(*) AS n FROM (SELECT occurrence_date, occurrence_slot FROM business_tasks WHERE schedule_id=$1 GROUP BY 1,2 HAVING count(*) > 1) x', [s.id]);
    assert.equal(Number(dup.n), 0);
    // Every day that is over closed without being done: missed, with a line in its history.
    const past = await one(`SELECT count(*) FILTER (WHERE status='missed') AS missed, count(*) AS n FROM business_tasks WHERE schedule_id=$1 AND occurrence_date < $2`, [s.id, trading]);
    assert.equal(Number(past.n), 6);
    assert.equal(Number(past.missed), 6);
    assert.ok(Number((await one("SELECT count(*) AS n FROM business_task_history WHERE action='missed' AND task_id IN (SELECT id FROM business_tasks WHERE schedule_id=$1)", [s.id])).n) >= 6);
    // A missed task cannot be filled in.
    const missed = await one("SELECT id FROM business_tasks WHERE schedule_id=$1 AND status='missed' LIMIT 1", [s.id]);
    const item = await one('SELECT id FROM business_task_items WHERE task_id=$1 AND kind=$2 LIMIT 1', [missed.id, 'number']);
    await O('PUT', `/tasks/${missed.id}/items/${item.id}`, { value: 3 }, 403);
    // Change to three times a day: days ahead not started are rebuilt; the past stays.
    await O('PUT', `/tasks/schedules/${s.id}`, { title: 'Temperature log', libraryCode: 'restaurant.temperature_log', frequency: 'daily', dueTimes: ['10:30', '14:00', '18:00'],
      assignMode: 'on_shift', startsOn, placeId: outletA });
    const tomorrow = await one('SELECT count(*) AS n FROM business_tasks WHERE schedule_id=$1 AND occurrence_date = $2::date + 1', [s.id, today]);
    assert.equal(Number(tomorrow.n), 3);
    assert.equal(Number((await one("SELECT count(*) AS n FROM business_tasks WHERE schedule_id=$1 AND status='missed' AND occurrence_date < $2", [s.id, trading])).n), 6);
    // Pausing cancels the future occurrences not started.
    await O('PATCH', `/tasks/schedules/${s.id}/active`, { active: false });
    assert.equal(Number((await one("SELECT count(*) AS n FROM business_tasks WHERE schedule_id=$1 AND status='todo' AND due_at > now()", [s.id])).n), 0);
    await O('PATCH', `/tasks/schedules/${s.id}/active`, { active: true });
    // Rule maths.
    const fallsOn = recurrence.fallsOn;
    assert.equal(fallsOn({ frequency: 'monthly', month_day: 31, starts_on: '2026-01-01' }, '2026-02-28'), true, 'day 31 means the last day of February');
    assert.equal(fallsOn({ frequency: 'monthly', month_day: 31, starts_on: '2026-01-01' }, '2026-02-27'), false);
    assert.equal(fallsOn({ frequency: 'every_n_days', every_n: 3, starts_on: '2026-10-01' }, '2026-10-07'), true);
    assert.equal(fallsOn({ frequency: 'every_n_days', every_n: 3, starts_on: '2026-10-01' }, '2026-10-08'), false);
    assert.equal(fallsOn({ frequency: 'weekly', weekdays: [1], starts_on: '2026-10-01' }, '2026-10-05'), true, 'a Monday');
    assert.equal(fallsOn({ frequency: 'daily', starts_on: '2026-10-01', ends_on: '2026-10-03' }, '2026-10-04'), false, 'after it stops');
    const slots = recurrence.slotsOn({ frequency: 'daily', due_times: ['01:00', '22:00'] }, '2026-10-07');
    assert.deepEqual(slots.map((x) => x.due), ['2026-10-07 22:00', '2026-10-08 01:00'], 'a 1 am check belongs to the night before');
    await O('POST', '/tasks/schedules', { title: 'x', frequency: 'weekly', weekdays: [], startsOn }, 400);
    await C('POST', '/tasks/schedules', { title: 'x', frequency: 'daily', startsOn }, 403);
  });

  await t.test('a failed answer raises one issue; required items, photos and review decide Done', async () => {
    const task = await O('POST', '/tasks', { libraryCode: 'restaurant.temperature_log', dueAt: iso(3 * HOUR), requiresReview: true, assignees: [{ kind: 'user', id: ids.manager }] }, 201);
    const chiller = task.items.find((i) => i.label === 'Walk-in chiller');
    const first = await M('PUT', `/tasks/${task.id}/items/${chiller.id}`, { value: 9 });
    assert.ok(first.raisedIssue, 'an issue was raised');
    assert.equal(first.task.status, 'in_progress');
    assert.equal(first.task.failedCount, 1);
    assert.equal(first.task.criticalFailed, true);
    const issue = await O('GET', `/tasks/issues/${first.raisedIssue.id}`);
    assert.match(issue.title, /Walk-in chiller: 9 °C \(allowed 0 to 5 °C\)/);
    assert.equal(issue.severity, 'high');
    assert.equal(issue.sourceTaskId, task.id);
    const again = await M('PUT', `/tasks/${task.id}/items/${chiller.id}`, { value: 11 });
    assert.equal(again.raisedIssue, null, 'one issue per item');
    const corrected = await M('PUT', `/tasks/${task.id}/items/${chiller.id}`, { value: 4 });
    assert.equal(corrected.task.failedCount, 0);
    assert.ok(corrected.task.items.find((i) => i.id === chiller.id).issueId, 'the issue stays as evidence');
    // Required items first.
    const refused = await M('POST', `/tasks/${task.id}/complete`, {}, 409);
    assert.ok(refused.data.missing.length >= 3);
    for (const i of corrected.task.items) {
      if (i.kind === 'number' && i.id !== chiller.id) await M('PUT', `/tasks/${task.id}/items/${i.id}`, { value: i.minValue === null ? 3 : i.minValue + 1 });
      if (i.kind === 'yes_no') await M('PUT', `/tasks/${task.id}/items/${i.id}`, { value: 'yes' });
    }
    await M('PUT', `/tasks/${task.id}/items/${chiller.id}`, { value: 'warm' }, 400);
    await C('PUT', `/tasks/${task.id}/items/${chiller.id}`, { value: 3 }, 404);
    const done = await M('POST', `/tasks/${task.id}/complete`, { note: 'All fine after the door seal was fixed' });
    assert.equal(done.status, 'done');
    assert.equal(done.reviewStatus, 'pending');
    assert.equal(done.scorePercent, 100);
    // Reviewing needs tasks.review; the owner sends it back, then approves.
    await K('POST', `/tasks/${task.id}/review`, { decision: 'approve' }, 403);
    await C('POST', `/tasks/${task.id}/review`, { decision: 'approve' }, 403);
    await O('POST', `/tasks/${task.id}/review`, { decision: 'changes' }, 400);
    const back = await O('POST', `/tasks/${task.id}/review`, { decision: 'changes', note: 'Write the action taken' });
    assert.equal(back.status, 'in_progress');
    assert.equal(back.reviewStatus, 'changes_requested');
    await M('POST', `/tasks/${task.id}/complete`, {});
    const approved = await O('POST', `/tasks/${task.id}/review`, { decision: 'approve' });
    assert.equal(approved.reviewStatus, 'approved');
    assert.deepEqual(approved.history.slice(0, 3).map((h) => h.action), ['approved', 'completed', 'changes_requested']);

    // A photo the checklist asks for: refused without, accepted with; a renamed file is refused.
    const photoTask = await O('POST', '/tasks', { title: 'Shop front', items: [{ kind: 'photo', label: 'Photo of the shutter' }, { kind: 'checkbox', label: 'Lights on', photoRequired: true }] }, 201);
    const [shot, lights] = photoTask.items;
    await O('PUT', `/tasks/${photoTask.id}/items/${lights.id}`, { value: true });
    await O('POST', `/tasks/${photoTask.id}/complete`, {}, 409);
    await O('POST', `/tasks/${photoTask.id}/files`, photo(shot.id), 201);
    await O('POST', `/tasks/${photoTask.id}/files`, photo(lights.id), 201);
    const fake = new FormData(); fake.append('file', new Blob([Buffer.from('MZ not an image at all here')], { type: 'image/png' }), 'x.png');
    await O('POST', `/tasks/${photoTask.id}/files`, fake, 400);
    const finished = await O('POST', `/tasks/${photoTask.id}/complete`, {});
    assert.equal(finished.status, 'done');
    const file = finished.files[0];
    const download = await fetch(`${base}/tasks/files/${file.id}`, { headers: { Authorization: `Bearer ${tokens.owner}` } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    const foreign = await fetch(`${base}/tasks/files/${file.id}`, { headers: { Authorization: `Bearer ${tokens.other}` } });
    assert.equal(foreign.status, 404);

    // Issues switched off: the answer is only marked failed.
    await pool.query("SELECT restaurant_feature_set($1, 'issues', FALSE)", [rid]);
    const quiet = await O('POST', '/tasks', { libraryCode: 'restaurant.hot_holding' }, 201);
    const dal = quiet.items.find((i) => i.kind === 'number');
    const r = await O('PUT', `/tasks/${quiet.id}/items/${dal.id}`, { value: 40 });
    assert.equal(r.raisedIssue, null);
    assert.equal(r.task.failedCount, 1);
    const off = await O('GET', '/tasks/issues', undefined, 403);
    assert.equal(off.data.reason, 'feature_off');
    await pool.query("SELECT restaurant_feature_set($1, 'issues', TRUE)", [rid]);
  });

  await t.test('permissions and outlet scope', async () => {
    const atB = await O('POST', '/tasks', { title: 'Deep clean at Koramangala', placeId: outletB, assignMode: 'on_shift' }, 201);
    const atA = await O('POST', '/tasks', { title: 'Deep clean at Indiranagar', placeId: outletA, assignMode: 'on_shift' }, 201);
    await C('GET', `/tasks/${atB.id}`, undefined, 404);
    assert.equal((await C('GET', `/tasks/${atA.id}`)).id, atA.id);
    assert.ok(!(await C('GET', '/tasks/my')).tasks.some((x) => x.id === atB.id), 'tied to outlet A');
    await C('GET', '/tasks?limit=10', undefined, 200);
    const visible = await C('GET', '/tasks?limit=100');
    assert.ok(visible.rows.every((x) => x.placeId === null || x.placeId === Number(outletA)));
    await C('GET', '/tasks/reports', undefined, 403);
    await C('GET', '/tasks/schedules', undefined, 403);
    // Reporting an issue: allowed; it lands at the cashier's own outlet; others' issues stay hidden.
    const reported = await C('POST', '/tasks/issues', { title: 'Card machine not printing', severity: 'medium', category: 'maintenance' }, 201);
    assert.equal(reported.placeId, Number(outletA));
    await C('POST', '/tasks/issues', { title: 'x', placeId: outletB }, 403);
    const list = await C('GET', '/tasks/issues');
    assert.ok(list.rows.every((x) => x.reportedById === ids.cashier || x.assigneeId === ids.cashier));
    await C('POST', `/tasks/issues/${reported.id}/status`, { status: 'closed' }, 409);
    await K('POST', '/tasks/projects', { name: 'x' }, 403);
    // Cancel needs tasks.manage (or being its creator); the trail says who.
    await K('POST', `/tasks/${atA.id}/cancel`, { reason: 'no' }, 403);
    const byManager = await M('POST', `/tasks/${atA.id}/cancel`, { reason: 'Done last night' });
    assert.equal(byManager.status, 'cancelled');
    assert.equal(byManager.history[0].action, 'cancelled');
    // Switched off for the restaurant: the whole module refuses with feature_off.
    await pool.query("SELECT restaurant_feature_set($1, 'projects', FALSE)", [rid]);
    await pool.query("SELECT restaurant_feature_set($1, 'issues', FALSE)", [rid]);
    await pool.query("SELECT restaurant_feature_set($1, 'tasks', FALSE)", [rid]);
    assert.equal((await O('GET', '/tasks/my', undefined, 403)).data.reason, 'feature_off');
    for (const code of ['tasks', 'issues', 'projects']) await pool.query('SELECT restaurant_feature_set($1, $2, TRUE)', [rid, code]);
  });

  await t.test('tenant isolation in both worlds, and the database refuses foreign pointers', async () => {
    const mine = await O('POST', '/tasks', { title: 'Our secret' }, 201);
    await X('GET', `/tasks/${mine.id}`, undefined, 404);
    await X('PUT', `/tasks/${mine.id}/items/1`, { value: true }, 404);
    await X('POST', '/tasks', { title: 'x', placeId: outletA }, 400);
    const businessA = await businessOf(rid);
    const businessB = await businessOf(rid2);
    await assert.rejects(pool.query("INSERT INTO business_tasks(business_id,title,category_code,outlet_id) VALUES($1,'x','others',$2)", [businessA, outletOther]), { code: '23514' });
    await assert.rejects(pool.query("INSERT INTO business_task_assignees(business_id,task_id,kind,user_id) VALUES($1,$2,'user',$3)", [businessA, mine.id, ids.other]), { code: '23514' });
    await assert.rejects(pool.query("INSERT INTO business_task_assignees(business_id,task_id,kind,user_id) VALUES($1,$2,'user',$3)", [businessB, mine.id, ids.other]), { code: '23503' });
    // Business world: the owner adds a pharmacy and a grocery with tasks, issues
    // and projects on; the other restaurant's owner is no member. The pharmacy
    // comes first so the grocery's location does not share outlet A's id.
    const [pharmacy, grocery] = await withTools(O, await createBusinesses(O, 'OWNER', ['pharmacy', 'grocery']), { work: true });
    await X('GET', `/businesses/${grocery.id}/tasks/my`, undefined, 404);
    const g = `/businesses/${grocery.id}/tasks`;
    const ctx = await O('GET', `${g}/context`);
    assert.equal(ctx.world, 'business');
    assert.equal(ctx.businessType, 'grocery');
    const lib = await O('GET', `${g}/library`);
    assert.ok(lib.some((x) => x.code === 'grocery.month_end_stock') && !lib.some((x) => x.code.startsWith('restaurant.')));
    const gt = await O('POST', g, { libraryCode: 'grocery.expiry_check', placeId: ctx.directory.places[0].id }, 201);
    await O('GET', `/businesses/${pharmacy.id}/tasks/${gt.id}`, undefined, 404);
    await O('GET', `/tasks/${gt.id}`, undefined, 404);
    await O('POST', g, { title: 'x', outletId: outletA }, 400);
    // A member with the cashier role: their own tasks and reporting issues only.
    await O('POST', `/businesses/${grocery.id}/members`, { userId: ids.kitchen, role: 'cashier' }, 201);
    const forKitchen = await O('POST', g, { title: 'Face up the biscuits shelf', assignees: [{ kind: 'user', id: ids.kitchen }] }, 201);
    assert.ok((await K('GET', `${g}/my`)).tasks.some((x) => x.id === forKitchen.id));
    await K('GET', `${g}?limit=5`, undefined, 200);
    await K('GET', `${g}/reports`, undefined, 403);
    await K('POST', g, { title: 'x' }, 403);
    await K('POST', `${g}/issues`, { title: 'Freezer door not closing', severity: 'high' }, 201);
    // A business role and a resource (no login) as assignees.
    const cashierRole = ctx.directory.roles.find((r) => r.name.startsWith('Cashier'));
    const byRole = await O('POST', g, { title: 'Count the cash', assignMode: 'role', assignees: [{ kind: 'business_role', id: cashierRole.id }] }, 201);
    assert.ok((await K('GET', `${g}/my`)).tasks.some((x) => x.id === byRole.id));
    await O('POST', g, { title: 'x', assignMode: 'role', assignees: [{ kind: 'role', id: 1 }] }, 400);
    // Module switched off in Business Admin: 403 naming it.
    await O('PUT', `/businesses/${grocery.id}/modules/projects`, { enabled: false });
    const offMsg = await O('GET', `${g}/projects`, undefined, 403);
    assert.match(offMsg.message, /Projects is not switched on/);
  });

  await t.test('log book entries become issues once; issues convert to tasks and run their course', async () => {
    const entry = await O('POST', '/staff/logbook', { category: 'maintenance', body: 'Walk-in freezer making noise. Technician coming at 11.', needsFollowUp: true }, 201);
    const issue = await O('POST', `/tasks/issues/from-logbook/${entry.id}`, {}, 201);
    assert.equal(issue.sourceLogbookEntryId, entry.id);
    assert.equal(issue.category, 'maintenance');
    assert.equal(issue.logbook.body, entry.body);
    const again = await O('POST', `/tasks/issues/from-logbook/${entry.id}`, {}, 201);
    assert.equal(again.id, issue.id, 'one issue per entry');
    await X('POST', `/tasks/issues/from-logbook/${entry.id}`, {}, 404);
    const converted = await O('POST', `/tasks/issues/${issue.id}/convert`, { assignees: [{ kind: 'user', id: ids.manager }] }, 201);
    assert.equal(converted.issue.status, 'in_progress');
    const task = await M('GET', `/tasks/${converted.taskId}`);
    assert.equal(task.issueId, issue.id);
    assert.equal(task.priority, 'normal');
    await M('POST', `/tasks/issues/${issue.id}/status`, { status: 'resolved' }, 400);
    await O('PATCH', `/tasks/issues/${issue.id}`, { assigneeId: ids.manager });
    const fixed = await M('POST', `/tasks/issues/${issue.id}/status`, { status: 'resolved', note: 'Fan motor replaced' });
    assert.equal(fixed.status, 'resolved');
    const closed = await O('POST', `/tasks/issues/${issue.id}/status`, { status: 'closed' });
    assert.ok(closed.closedAt);
    const reopened = await O('POST', `/tasks/issues/${issue.id}/status`, { status: 'open', note: 'Noise is back' });
    assert.equal(reopened.resolvedAt, null);
    assert.deepEqual(reopened.history.slice(0, 4).map((h) => h.action), ['reopened', 'closed', 'resolved', 'assigned']);
    await O('DELETE', `/tasks/issues/${issue.id}`, undefined, 409);
  });

  await t.test('projects: from a template, membership decides who sees them, progress counts done tasks', async () => {
    const templates = await O('GET', '/tasks/project-templates');
    assert.ok(templates.some((x) => x.code === 'project.new_outlet'));
    const p = await O('POST', '/tasks/projects', { name: 'Whitefield outlet', templateCode: 'project.new_outlet', memberIds: [ids.manager] }, 201);
    assert.equal(p.milestoneList.length, 4);
    assert.equal(p.lists.length, 5);
    assert.equal(p.taskCount, 19);
    assert.equal(p.progressPercent, 0);
    await K('GET', `/tasks/projects/${p.id}`, undefined, 404);
    assert.equal((await M('GET', `/tasks/projects/${p.id}`)).id, p.id);
    for (const task of p.tasks.slice(0, 7)) await O('POST', `/tasks/${task.id}/complete`, {});
    await O('POST', `/tasks/${p.tasks[7].id}/cancel`, { reason: 'Not needed here' });
    const after = await O('GET', `/tasks/projects/${p.id}`);
    assert.equal(after.taskCount, 18, 'cancelled tasks are left out');
    assert.equal(after.doneCount, 7);
    assert.equal(after.progressPercent, 39);
    await M('PATCH', `/tasks/projects/${p.id}/milestones/${after.milestoneList[0].id}`, { done: true });
    await K('PATCH', `/tasks/projects/${p.id}`, { name: 'Renamed' }, 404);
    await M('PATCH', `/tasks/projects/${p.id}`, { name: 'Whitefield outlet opening' });
    const done = await O('PATCH', `/tasks/projects/${p.id}`, { status: 'completed' });
    assert.ok(done.completedAt);
    await O('PATCH', `/tasks/projects/${p.id}`, { endOn: '2000-01-01' }, 400);
  });

  await t.test('reports: completion, on-time, missed by person and category, compliance, issue ages', async () => {
    // A clean business for exact numbers: the owner's pharmacy, with no tasks yet.
    const ph = (await O('GET', '/businesses')).businesses.find((b) => b.business_type === 'pharmacy');
    const P = `/businesses/${ph.id}/tasks`;
    const day = (await one("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)::text AS d")).d;
    const yesterday = (h) => new Date(`${day}T${h}:00+05:30`).toISOString();
    const make = (title, category, assignees) => O('POST', P, { title, category, dueAt: yesterday('18:00'), assignees }, 201);
    const me = [{ kind: 'user', id: ids.owner }];
    const a = await make('Shelf check A', 'stock_check', me);
    const b = await make('Shelf check B', 'stock_check', me);
    const c = await make('Clean counter', 'cleaning', me);
    const d = await make('Clean shelves', 'cleaning', me);
    for (const x of [a, b, c]) await O('POST', `${P}/${x.id}/complete`, {});
    await pool.query("UPDATE business_tasks SET completed_at = due_at - interval '30 minutes' WHERE id = ANY($1::bigint[])", [[a.id, b.id]]);
    await pool.query("UPDATE business_tasks SET completed_at = due_at + interval '2 hours' WHERE id = $1", [c.id]);
    await pool.query("UPDATE business_tasks SET closes_at = due_at + interval '1 hour' WHERE id = $1", [d.id]);
    recurrence.forget(ph.id);
    const report = await O('GET', `${P}/reports?from=${day}&to=${day}`);
    assert.deepEqual([report.totals.due, report.totals.done, report.totals.onTime, report.totals.missed], [4, 3, 2, 1]);
    assert.equal(report.totals.completionRate, 75);
    assert.equal(report.totals.onTimeRate, 66.7);
    const cleaning = report.byCategory.find((r) => r.category === 'cleaning');
    assert.deepEqual([cleaning.due, cleaning.done, cleaning.missed, cleaning.completionRate], [2, 1, 1, 50]);
    const owner = report.byPerson.find((r) => r.person === String(ids.owner));
    assert.deepEqual([owner.due, owner.done, owner.missed], [4, 3, 1]);
    // Compliance of a daily schedule over its first four days, all over (before the
    // trading date: a day's check stays open until the cut-off next morning):
    // three done, one missed.
    const trading = dates.tradingToday();
    const start = dates.addDays(trading, -4);
    const s = await O('POST', `${P}/schedules`, { title: 'Medicine fridge', libraryCode: 'pharmacy.fridge', frequency: 'daily', dueTimes: ['10:00'], startsOn: start, assignMode: 'on_shift' }, 201);
    const occ = (await pool.query('SELECT id FROM business_tasks WHERE schedule_id=$1 AND occurrence_date < $2 ORDER BY occurrence_date', [s.id, trading])).rows;
    assert.equal(occ.length, 4);
    await pool.query("UPDATE business_tasks SET status='done', completed_at = due_at - interval '5 minutes', completed_by=$2 WHERE id = ANY($1::bigint[])", [occ.slice(0, 3).map((r) => r.id), ids.owner]);
    const rep2 = await O('GET', `${P}/reports?from=${start}&to=${dates.addDays(trading, -1)}`);
    const fridge = rep2.compliance.find((r) => r.scheduleId === s.id);
    assert.deepEqual([fridge.due, fridge.done, fridge.missed, fridge.completionRate], [4, 3, 1, 75]);
    assert.equal(fridge.days.length, 4);
    // Open issues by age.
    const old = await O('POST', `${P}/issues`, { title: 'Old leak', severity: 'high' }, 201);
    await pool.query("UPDATE business_issues SET reported_at = now() - interval '10 days' WHERE id = $1", [old.id]);
    await O('POST', `${P}/issues`, { title: 'New leak', severity: 'low' }, 201);
    const rep3 = await O('GET', `${P}/reports`);
    const ages = Object.fromEntries(rep3.issuesByAge.map((r) => [r.bucket, r]));
    assert.equal(ages['8+ days'].open, 1);
    assert.equal(ages['8+ days'].serious, 1);
    assert.equal(ages['0–1 days'].open, 1);
    // The bell carries the serious issue for those who see issues.
    const feed = await O('GET', `/businesses/${ph.id}/notifications`);
    assert.ok(feed.items.some((x) => x.id.startsWith('issues:serious:')));
  });
});
