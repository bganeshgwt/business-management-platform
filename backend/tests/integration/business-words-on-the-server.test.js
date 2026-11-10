const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { signIn } = require('./helpers/signIn');
const { rewriteHistory } = require('./helpers/history');

// What the server writes, and how a new business starts, in the business's
// own words (migration 1791990000010): a gym's refusals and bell name its
// members and their fees, its import guide shows a monthly membership counted
// by the month at 5%, its notice says "tell us at the front desk"; a clinic's
// name patients and start at nil GST; a new gym, salon, clinic and garage
// start with the roles and units of their trade.
test('words on the server: refusals, the bell, import guides, and a new business by its trade', { timeout: 600000 }, async (t) => {
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
  const password = `Server-${crypto.randomBytes(8).toString('hex')}`;
  const platformUser = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES(NULL,$1,$2,$3) RETURNING id',
    ['Platform Admin', 'platform@server-words.invalid', await bcrypt.hash(password, 4)]);
  await pool.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='SUPER_ADMIN' AND restaurant_id IS NULL", [platformUser.id]);
  const app = require('../../src/app');
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(method, route, body, auth) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  }
  const login = async (email) => (await signIn(base, email, password))?.token || null;
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const key = () => crypto.randomUUID();
  const platform = as(await login('platform@server-words.invalid'));
  const gym = (await platform('POST', '/users/platform/businesses', {
    businessType: 'memberships', name: 'Iron Temple Gym', code: 'IRON-TEMPLE', stateCode: '29', city: 'Mysuru',
    owner: { email: 'owner@server-words.invalid', name: 'Vikram S', password },
  }, 201)).business;
  const ownerToken = await login('owner@server-words.invalid');
  const owner = as(ownerToken);
  const ownerId = (await one("SELECT id FROM users WHERE email='owner@server-words.invalid'")).id;
  const make = (businessType, code, name, kind) => owner('POST', '/businesses', { businessType, code, name, ...(kind ? { kind } : {}) }, 201);
  const yoga = await make('memberships', 'PRANA-YOGA', 'Prana Yoga Studio', 'yoga_studio');
  const coaching = await make('memberships', 'BRIGHT-TUTORIALS', 'Bright Tutorials', 'coaching');
  const salon = await make('salon', 'GLOW-SALON', 'Glow Unisex Salon');
  const clinic = await make('healthcare', 'LIFELINE-CLINIC', 'Lifeline Family Clinic');
  const physio = await make('healthcare', 'MOVE-PHYSIO', 'Move Physiotherapy Centre', 'physiotherapy');
  const garage = await make('garage', 'SPEED-AUTO', 'Speed Auto Garage');
  const grocery = await make('grocery', 'GANESH-KIRANA', 'Sri Ganesh Kirana Stores');
  const laundry = await make('laundry', 'SPARKLE-LAUNDRY', 'Sparkle Laundry');
  const rentals = await make('rentals', 'SAI-TENTS', 'Sai Tent House');
  const lodging = await make('lodging', 'GREEN-PARK', 'Green Park Lodge');
  const B = (business, route) => `/businesses/${business.id}/${route}`;
  const placeOf = async (business) => (await owner('GET', B(business, 'locations'))).items[0];
  const sale = async (business, body, expected = 201) => owner('POST', B(business, 'documents'),
    { kind: 'sale', locationId: (await placeOf(business)).id, requestKey: key(), ...body }, expected);

  await t.test('a new gym, salon, clinic and garage start with the roles, units and GST slab of their trade', async () => {
    const roles = async (business) => (await rows('SELECT template_code FROM business_roles WHERE business_id=$1 ORDER BY template_code', [business.id])).map((r) => r.template_code);
    const named = async (business, template) => (await one('SELECT name FROM business_roles WHERE business_id=$1 AND template_code=$2', [business.id, template])).name;
    const units = async (business) => (await rows(`SELECT code FROM business_units WHERE business_id=$1
      AND code IN ('month','session','class','visit','test','bag','packet') ORDER BY code`, [business.id])).map((r) => r.code);
    const slab = async (business) => (await one('SELECT name FROM business_tax_rates WHERE business_id=$1 AND is_default', [business.id])).name;
    // A gym: its front desk and trainers; no cashier, and no stock keeper where no stock is kept.
    assert.deepEqual(await roles(gym), ['accountant', 'manager', 'member_desk', 'owner', 'trainer', 'viewer']);
    assert.equal(await named(gym, 'member_desk'), 'Front desk');
    assert.deepEqual(await units(gym), ['class', 'month', 'session']);
    assert.deepEqual([await slab(gym), await slab(yoga), await slab(coaching)], ['GST 5%', 'GST 5%', 'GST 18%']);
    // The front desk does what a cashier does, and more.
    const desk = (await rows(`SELECT p.permission_code AS code FROM business_role_permissions p JOIN business_roles r ON r.id=p.role_id
      WHERE r.business_id=$1 AND r.template_code='member_desk' ORDER BY 1`, [gym.id])).map((r) => r.code);
    const cashier = (await rows(`SELECT DISTINCT permission_code AS code FROM business_role_template_permissions
      WHERE template_code IN ('cashier','member_desk') ORDER BY 1`)).map((r) => r.code);
    assert.deepEqual(desk, cashier);
    assert.ok(['member_plans.create', 'contacts.edit', 'appointments.cancel'].every((code) => desk.includes(code)));
    // A salon: its receptionist and stylists, a stock keeper for its retail shelf, the session, 5%.
    assert.deepEqual(await roles(salon), ['accountant', 'manager', 'owner', 'receptionist', 'stock_keeper', 'stylist', 'viewer']);
    assert.deepEqual([await named(salon, 'receptionist'), await named(salon, 'stylist')], ['Receptionist', 'Stylist']);
    assert.deepEqual(await units(salon), ['session']);
    assert.equal(await slab(salon), 'GST 5%');
    // A clinic: receptionist and nurse beside its doctors and lab; visits and tests; exempt services.
    assert.deepEqual(await roles(clinic), ['accountant', 'doctor', 'lab_technician', 'manager', 'nurse', 'owner', 'pathologist', 'receptionist', 'viewer']);
    assert.deepEqual(await units(clinic), ['test', 'visit']);
    assert.deepEqual([await slab(clinic), await slab(physio)], ['GST nil / exempt', 'GST nil / exempt']);
    // A garage: a service advisor beside its cashier, mechanics and parts store; 18%.
    assert.deepEqual(await roles(garage), ['accountant', 'cashier', 'manager', 'mechanic', 'owner', 'service_advisor', 'stock_keeper', 'viewer']);
    assert.equal(await named(garage, 'service_advisor'), 'Service advisor');
    assert.deepEqual([await units(garage), await slab(garage)], [[], 'GST 18%']);
    // A laundry's presser, a rental yard's yard hand, a lodge's front desk without a second cashier; a kirana's bags and packets.
    assert.deepEqual(await roles(laundry), ['accountant', 'cashier', 'manager', 'owner', 'presser', 'viewer']);
    assert.deepEqual(await roles(rentals), ['accountant', 'cashier', 'manager', 'owner', 'viewer', 'yard_hand']);
    assert.deepEqual(await roles(lodging), ['accountant', 'front_desk', 'housekeeping', 'manager', 'owner', 'viewer']);
    assert.deepEqual(await roles(grocery), ['accountant', 'cashier', 'manager', 'owner', 'stock_keeper', 'viewer']);
    assert.deepEqual([await units(grocery), await slab(grocery)], [['bag', 'packet'], 'GST 18%']);
    // An older client's "cashier" finds the clinic's receptionist.
    const groceryCashier = await one("SELECT id FROM business_roles WHERE business_id=$1 AND template_code='cashier'", [grocery.id]);
    const divya = await owner('POST', B(grocery, 'staff-accounts'), { name: 'Divya Menon', email: 'divya@server-words.invalid', password, roleId: groceryCashier.id }, 201);
    await owner('POST', B(clinic, 'members'), { userId: divya.user_id, role: 'cashier' }, 201);
    assert.equal((await one(`SELECT r.template_code FROM business_memberships m JOIN business_roles r ON r.id=m.role_id
      WHERE m.business_id=$1 AND m.user_id=$2`, [clinic.id, divya.user_id])).template_code, 'receptionist');
  });

  await t.test("a gym's and a clinic's refusals name their members and patients", async () => {
    // A gym keeps no stock until it switches Stock on.
    const goods = await owner('POST', B(gym, 'catalog'), { kind: 'goods', name: 'Whey protein 1 kg', code: 'WHEY-1KG', unit: 'each', tracking: 'quantity', price: '2400' }, 400);
    assert.equal(goods.message, 'Products for sale are not kept here: switch on Stock in Settings › Business tools to add them');
    // The cash limit counts one member's cash in a day (Income-tax Act 2025, section 186).
    const annual = await owner('POST', B(gym, 'catalog'), { kind: 'service', name: 'Annual membership', code: 'ANNUAL', unit: 'month', price: '100000', taxRate: '5' }, 201);
    const ravi = await owner('POST', B(gym, 'contacts'), { kind: 'customer', name: 'Ravi Kumar', phone: '9845012345' }, 201);
    const cash = (expected) => sale(gym, { contactId: ravi.id, lines: [{ skuId: annual.id, quantity: '1' }], payments: [{ method: 'cash', amount: 'full' }] }, expected);
    await cash(201);
    assert.match((await cash(409)).message,
      /^Cash of ₹2,00,000 or more cannot be taken from one member in a day \(Income-tax Act 2025, section 186\): today's cash from this member would reach ₹210000\.00\./);
    // What the database writes names them too.
    const supplier = await owner('POST', B(gym, 'contacts'), { kind: 'supplier', name: 'FitLife Supplements' }, 201);
    await assert.rejects(pool.query('SELECT business_privacy_person($1,$2,NULL)', [gym.id, supplier.id]), /Personal data here is about a member of this business/);
    const clinicSupplier = await owner('POST', B(clinic, 'contacts'), { kind: 'supplier', name: 'City Surgicals' }, 201);
    await assert.rejects(pool.query('SELECT business_privacy_person($1,$2,NULL)', [clinic.id, clinicSupplier.id]), /Personal data here is about a patient of this business/);
    // A clinic's patients.
    const consent = { method: 'verbal', givenBy: 'Self' };
    const unknown = await owner('POST', B(clinic, 'clinic/patients'), { contactId: 999999, ageYears: 40, sex: 'female', consent }, 404);
    assert.equal(unknown.message, 'Patient not found');
    const doctor = await owner('POST', B(clinic, 'resources'), { locationId: (await placeOf(clinic)).id, name: 'Dr. Rao', roleLabel: 'Doctor' }, 201);
    const visit = await owner('POST', B(clinic, 'catalog'), { kind: 'service', name: 'Consultation', code: 'CONSULT', unit: 'visit', price: '500' }, 201);
    const tomorrow = new Date(Date.now() + 86400000);
    const booking = await owner('POST', B(clinic, 'appointments'), { resourceId: doctor.id, contactId: 999999, skuId: visit.id,
      startsAt: tomorrow.toISOString(), endsAt: new Date(tomorrow.getTime() + 900000).toISOString() }, 404);
    assert.equal(booking.message, 'Patient or service not found');
    // A walk-in pays the whole bill: "on account" at a garage, "udhaar" at a kirana.
    const labour = await owner('POST', B(garage, 'catalog'), { kind: 'service', name: 'General service labour', code: 'LABOUR', unit: 'hour', price: '500' }, 201);
    const garageWalkIn = await sale(garage, { lines: [{ skuId: labour.id, quantity: '1' }], payments: [{ method: 'cash', amount: '100' }] }, 409);
    assert.equal(garageWalkIn.message, 'A walk-in customer pays the whole bill now. To leave any of it unpaid (on account), choose the customer first.');
    const rice = await owner('POST', B(grocery, 'catalog'), { kind: 'service', name: 'Rice, bulk order', code: 'RICEBULK', unit: 'service', price: '500', taxRate: '0' }, 201);
    const shopWalkIn = await sale(grocery, { lines: [{ skuId: rice.id, quantity: '1' }], payments: [{ method: 'cash', amount: '100' }] }, 409);
    assert.equal(shopWalkIn.message, 'A walk-in customer pays the whole bill now. To leave any of it unpaid (udhaar), choose the customer first.');
  });

  await t.test("the bell asks for a gym's member fees and a kirana's udhaar, and counts a physiotherapist's sessions", async () => {
    const plan = await owner('POST', B(gym, 'catalog'), { kind: 'service', name: 'Monthly membership', code: 'MONTHLY', unit: 'month', price: '1500', taxRate: '5' }, 201);
    const meena = await owner('POST', B(gym, 'contacts'), { kind: 'customer', name: 'Meena Iyer', phone: '9845011111' }, 201);
    const fees = await sale(gym, { contactId: meena.id, lines: [{ skuId: plan.id, quantity: '1' }] });
    await rewriteHistory(pool, 'UPDATE business_documents SET due_on = due_on - 10 WHERE id=$1', [fees.id]);
    const due = (await owner('GET', B(gym, 'notifications'))).items.find((item) => item.id.startsWith(`overdue:${meena.id}:`));
    assert.deepEqual([due.category, due.title, due.detail, due.link],
      ['Member dues', 'Meena Iyer: ₹1,575.00 fees overdue', '1 bill · oldest due 10 days ago', `/business-admin/${gym.id}/outstanding`]);
    const rice = await one("SELECT id FROM catalog_skus WHERE business_id=$1 AND code='RICEBULK'", [grocery.id]);
    const kiran = await owner('POST', B(grocery, 'contacts'), { kind: 'customer', name: 'Kiran', phone: '9845022222' }, 201);
    const credit = await sale(grocery, { contactId: kiran.id, lines: [{ skuId: rice.id, quantity: '1' }] });
    await rewriteHistory(pool, 'UPDATE business_documents SET due_on = due_on - 3 WHERE id=$1', [credit.id]);
    const udhaar = (await owner('GET', B(grocery, 'notifications'))).items.find((item) => item.id.startsWith(`overdue:${kiran.id}:`));
    assert.deepEqual([udhaar.category, udhaar.title, udhaar.detail, udhaar.link],
      ['Udhaar', 'Kiran: ₹500.00 udhaar overdue', '1 bill · oldest due 3 days ago', `/business-admin/${grocery.id}/udhaar`]);
    // A physiotherapy centre's bookings are sessions (its kind's word), still to come today.
    const late = (await one("SELECT (now() AT TIME ZONE timezone)::time > '23:50' AS late FROM businesses WHERE id=$1", [physio.id])).late;
    if (!late) {
      const therapist = await owner('POST', B(physio, 'resources'), { locationId: (await placeOf(physio)).id, name: 'Dr. Nair' }, 201);
      const sitting = await owner('POST', B(physio, 'catalog'), { kind: 'service', name: 'Physiotherapy session', code: 'PHYSIO', unit: 'visit', price: '700' }, 201);
      const lata = await owner('POST', B(physio, 'contacts'), { kind: 'customer', name: 'Lata Shah', phone: '9845033333' }, 201);
      await pool.query(`INSERT INTO business_appointments(business_id,resource_id,contact_id,sku_id,starts_at,ends_at,status,created_by)
        VALUES($1,$2,$3,$4,now()+interval '5 minutes',now()+interval '50 minutes','booked',$5)`, [physio.id, therapist.id, lata.id, sitting.id, ownerId]);
      const today = (await owner('GET', B(physio, 'notifications'))).items.find((item) => item.id.startsWith('appointments:'));
      assert.deepEqual([today.category, today.title], ['Sessions', '1 session still to come today']);
    }
  });

  await t.test("import guides show a gym's and a clinic's own examples, and leave out stock where none is kept", async () => {
    const gymGuide = await owner('GET', B(gym, 'catalog/import-guide'));
    const labels = gymGuide.columns.map((column) => column.label);
    for (const stockOnly of ['Barcode', 'Kind', 'Stock tracking', 'MRP', 'Purchase price', 'Reorder level', 'Opening stock', 'Location', 'Batch', 'Expiry']) {
      assert.ok(!labels.includes(stockOnly), `a gym's guide has no ${stockOnly} column`);
    }
    assert.equal(gymGuide.columns.find((column) => column.key === 'name').example, 'Monthly membership');
    assert.match(gymGuide.columns.find((column) => column.key === 'category').help, /\(Memberships › Monthly\)/);
    assert.deepEqual(gymGuide.sample.columns, ['Name', 'Code', 'Category', 'Unit', 'HSN / SAC', 'GST rate', 'Sale price']);
    assert.deepEqual(gymGuide.sample.rows[0], ['Monthly membership', 'MONTHLY-MEMBERSHIP', 'Memberships', 'month', '999723', 'GST 5%', '300']);
    const clinicGuide = await owner('GET', B(clinic, 'catalog/import-guide'));
    assert.deepEqual(clinicGuide.sample.rows[0], ['Consultation — general physician', 'CONSULTATION-GENERAL', 'Consultations', 'visit', '999312', 'GST nil / exempt', '300']);
    // A kirana keeps stock: its own item leads, with its HSN, MRP and opening stock.
    const shopGuide = await owner('GET', B(grocery, 'catalog/import-guide'));
    assert.ok(['MRP', 'Opening stock', 'Barcode'].every((label) => shopGuide.columns.some((column) => column.label === label)));
    const first = Object.fromEntries(shopGuide.sample.columns.map((label, index) => [label, shopGuide.sample.rows[0][index]]));
    assert.deepEqual([first.Name, first.Code, first.Category, first['HSN / SAC'], first.Kind], ['Toor dal 1 kg', 'TOOR-DAL-1', 'Staples', '0713', 'Goods']);
    // The gym's members, in the contacts guide and in a file's check.
    const people = await owner('GET', `${B(gym, 'contacts/import-guide')}?kind=customer`);
    assert.equal(people.columns[0].example, 'Example member');
    assert.match(people.columns.find((column) => column.key === 'phone').help, /^Optional, never needed for a bill\./);
    assert.equal(people.sample.rows[0][0], 'Example member one');
    const checked = await call('POST', B(gym, 'contacts/import'), { kind: 'customer', dryRun: true, rows: [{ 'Member name': 'Anita Rao', Phone: '98450 70707' }] }, ownerToken);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.message, 'Ready: 1 new member, 0 to update, 0 unchanged');
  });

  await t.test("the privacy notice, the business tools, the roles' permissions and an erasure, in a gym's words", async () => {
    const notice = (await owner('GET', B(gym, 'privacy/notice'))).starter.notice;
    assert.match(notice, /tell us at the front desk or on the phone/);
    assert.match(notice, /never a condition of being served/);
    assert.match((await owner('GET', B(clinic, 'privacy/notice'))).starter.notice, /tell us at the reception or on the phone/);
    assert.match((await owner('GET', B(grocery, 'privacy/notice'))).starter.notice, /tell us at the counter or on the phone/);
    // Modules and permissions name the people a business serves in its words.
    assert.equal((await owner('GET', B(gym, 'modules'))).find((module) => module.code === 'contacts').name, 'Members & suppliers');
    assert.equal((await owner('GET', B(clinic, 'modules'))).find((module) => module.code === 'contacts').name, 'Patients & suppliers');
    const catalogue = await owner('GET', B(gym, 'permissions'));
    assert.equal(catalogue.permissions.find((permission) => permission.code === 'contacts.view').name, 'See members and suppliers');
    assert.equal(catalogue.modules.find((module) => module.code === 'receivables').description,
      'Money collected from members against their bills, advances, outstanding balances, ageing and statements.');
    assert.equal((await owner('GET', B(gym, 'context'))).moduleCatalogue.find((module) => module.code === 'contacts').name, 'Members & suppliers');
    assert.equal((await owner('GET', B(grocery, 'context'))).moduleCatalogue.find((module) => module.code === 'contacts').name, 'Customers & suppliers');
    // A role that may not add members is told so in the gym's words.
    const viewerRole = await one("SELECT id FROM business_roles WHERE business_id=$1 AND template_code='viewer'", [gym.id]);
    await owner('POST', B(gym, 'staff-accounts'), { name: 'Arun Pillai', email: 'arun@server-words.invalid', password, roleId: viewerRole.id }, 201);
    const viewer = as(await login('arun@server-words.invalid'));
    assert.equal((await viewer('POST', B(gym, 'contacts'), { kind: 'customer', name: 'New Member' }, 403)).message,
      'Your role (Viewer) does not allow this: add members and suppliers.');
    // An erased member's record keeps a member's name.
    const sunil = await owner('POST', B(gym, 'contacts'), { kind: 'customer', name: 'Sunil Joshi', phone: '9845044444' }, 201);
    const asked = await owner('POST', B(gym, 'privacy/requests'), { kind: 'erasure', personId: sunil.id, details: 'Asked to erase his details', requestKey: key() }, 201);
    const done = await owner('POST', B(gym, `privacy/requests/${asked.id}/erase`), { requestKey: key() });
    assert.ok(done.erasure.erased.some((entry) => entry.heading === 'Member record'));
    assert.equal((await one('SELECT name FROM business_contacts WHERE id=$1', [sunil.id])).name, `Erased member #${sunil.id}`);
  });

  await t.test("the task library reads in a gym's words, with no stock check where no stock is kept", async () => {
    await owner('PUT', B(gym, 'modules/tasks'), { enabled: true });
    await owner('PUT', B(gym, 'modules/projects'), { enabled: true });
    const library = await owner('GET', B(gym, 'tasks/library'));
    const opening = library.find((template) => template.code === 'common.opening');
    assert.deepEqual([opening.name, opening.description], ['Opening checklist', 'Everything that must be right before the first member walks in.']);
    assert.ok(!library.some((template) => template.code === 'common.supplier_order'));
    const detail = await owner('GET', B(gym, 'tasks/library/common.opening'));
    assert.ok(detail.items.some((item) => item.kind === 'section' && item.label === 'Front desk'));
    await owner('GET', B(gym, 'tasks/library/common.supplier_order'), undefined, 404);
    const projects = await owner('GET', B(gym, 'tasks/project-templates'));
    assert.ok(projects.some((template) => template.name === 'Launch of new plans & services'));
    assert.ok(!projects.some((template) => template.code === 'project.annual_audit'));
  });

  await t.test('the server and the database name only words the business has', async () => {
    // Every key the server's code asks for is a word in the database.
    const keys = new Set((await rows('SELECT key FROM term_keys')).map((row) => row.key));
    for (const used of ['customer', 'customer_list', 'walk_in', 'provider', 'resource', 'item', 'goods', 'service', 'counter', 'appointment', 'dues', 'dues_list',
      'on_account', 'bill', 'sale', 'location', 'example.item_name', 'example.category', 'example.hsn']) assert.ok(keys.has(used), used);
    // A wholesaler's bills are invoices.
    const wholesale = await make('wholesale', 'MAHA-FMCG', 'Mahalakshmi FMCG Distributors');
    assert.deepEqual([await one("SELECT business_word($1,'bill',TRUE) AS w", [wholesale.id])].map((r) => r.w), ['Invoices']);
    assert.equal((await one("SELECT business_word_lower($1,'customer_list',TRUE) AS w", [lodging.id])).w, 'guests & companies');
  });
});
