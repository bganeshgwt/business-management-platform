const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom, momentAt } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A rental and hire business's own tools: rental items hired one by one (each
// unit with its number and meter) or from a pool, their rates billed at the
// cheapest mix of hours, days, weeks and months; quotes and bookings checked
// against what is free (a unit never twice, a pool never over); the handover
// with the hirer's ID and the condition noted; returns with late fees and
// charges billed through the core; advances and refundable deposits held as
// core collection receipts, the deposit applied to the bill and the rest
// handed back. Money adds up to the paisa, postings are idempotent, the
// database keeps its rules, audit and events are written, and other types and
// other owners are kept out. Runs on its own throwaway database with every
// migration applied.
test('rentals and hire', { timeout: 300000 }, async (t) => {
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
  const password = `Hire-${crypto.randomBytes(8).toString('hex')}`;
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
  const login = async (email) => (await signIn(base, email, password)).token;
  const ownerUser = await owner('hire-owner');
  await owner('hire-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('hire-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('hire-other@test.invalid'));
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);

  const [rentals, grocery, laundry] = await createBusinesses(request, 'OWNER', ['rentals', 'grocery', 'laundry']);
  const [elsewhere] = await createBusinesses(other, 'OTHER', ['rentals']);
  const R = (suffix) => `/businesses/${rentals.id}/${suffix}`;

  await t.test('modules, permissions and roles per type', async () => {
    assert.ok(rentals.capabilities.includes('rentals'), 'a rental business starts with hire items & bookings');
    assert.ok(rentals.capabilities.includes('receivables'), 'a rental business keeps its hirers\' dues');
    for (const business of [grocery, laundry]) assert.ok(!business.capabilities.includes('rentals'), `${business.business_type} has no hire bookings`);
    const tools = await request('GET', R('modules'));
    const module = tools.find((m) => m.code === 'rentals');
    assert.equal(module.name, 'Hire items & bookings');
    assert.deepEqual([...module.requires].sort(), ['catalog', 'contacts', 'sales']);
    const licences = tools.find((m) => m.code === 'licences');
    assert.deepEqual([licences.enabled, licences.recommended], [false, true]);
    assert.match(licences.recommended_note, /rent-a-cab or rent-a-motorcycle licence/);
    assert.ok(!(await request('GET', `/businesses/${grocery.id}/modules`)).some((m) => m.code === 'rentals'), 'a grocery is not offered hire bookings');
    await request('PUT', `/businesses/${grocery.id}/modules/rentals`, { enabled: true }, 409);
    await request('PUT', R('modules/sales'), { enabled: false }, 409);
    const permissions = await rows("SELECT code FROM business_permissions WHERE module_code='rentals' ORDER BY sort_order");
    assert.deepEqual(permissions.map((p) => p.code), ['rentals.view', 'rentals.create', 'rentals.edit', 'rentals.approve', 'rentals.cancel', 'rentals.refund', 'rentals.print']);
    const grants = async (business, template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2`, [business.id, template])).p
      .filter((p) => p.startsWith('rentals.'));
    assert.deepEqual(await grants(rentals, 'manager'), ['rentals.approve', 'rentals.cancel', 'rentals.create', 'rentals.edit', 'rentals.print', 'rentals.refund', 'rentals.view']);
    assert.deepEqual(await grants(rentals, 'cashier'), ['rentals.create', 'rentals.edit', 'rentals.print', 'rentals.view']);
    assert.deepEqual(await grants(rentals, 'stock_keeper'), ['rentals.edit', 'rentals.print', 'rentals.view']);
    assert.deepEqual(await grants(rentals, 'accountant'), ['rentals.print', 'rentals.view']);
    assert.deepEqual(await grants(rentals, 'viewer'), ['rentals.view']);
    assert.deepEqual(await grants(grocery, 'viewer'), ['rentals.view'], 'role copies match their templates everywhere');
    assert.equal((await request('GET', R('roles?limit=100'))).items.length, 6, 'no role of its own');
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_number_series_document_kind_check'")).d.includes("'rental'"));
    assert.ok((await one("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='business_collection_refunds_source_check'")).d.includes("'rentals'"));
    assert.notEqual(String(elsewhere.id), String(rentals.id));
  });

  // --- Shared set-up: the yard, its GST slabs, service items and hirers ---------------------------------
  const yard = (await request('GET', R('locations'))).items[0];
  const slabs = (await request('GET', R('tax-rates'))).items;
  const gst18 = slabs.find((r) => Number(r.rate) === 18), gst40 = slabs.find((r) => Number(r.rate) === 40);
  const serviceItem = (body) => request('POST', R('catalog'), { kind: 'service', unit: 'service', price: '0', taxRateId: gst18.id, ...body }, 201);
  const customer = (name, phone, extra = {}) => request('POST', R('contacts'), { kind: 'customer', name, ...(phone ? { phone } : {}), ...extra }, 201);


  await t.test('the database keeps rental items, units, bookings, handovers, returns and charges within their rules', async () => {
    const hire = await serviceItem({ name: 'Rule generator hire', code: 'RULE-GEN', hsnCode: '997319' });
    const chairs = await serviceItem({ name: 'Rule chairs hire', code: 'RULE-CHAIR' });
    const cars = await serviceItem({ name: 'Rule car hire', code: 'RULE-CAR', taxRateId: gst40.id });
    const hourly = await request('POST', R('catalog'), { kind: 'service', unit: 'hour', price: '0', taxRateId: gst18.id, name: 'Rule hourly hire', code: 'RULE-HOUR' }, 201);
    await request('PUT', R('modules/inventory'), { enabled: true });
    const goods = await request('POST', R('catalog'), { kind: 'goods', tracking: 'quantity', unit: 'each', name: 'Rule fuel can', code: 'RULE-CAN', price: '50', taxRateId: gst18.id }, 201);
    const hirer = await customer('Rule Hirer', '9000000201');
    const supplier = await request('POST', R('contacts'), { kind: 'supplier', name: 'Rule Supplier' }, 201);
    // An item is billed as a service item counted in services, once; it keeps it, its kind and whether it is a vehicle; never deleted.
    const item = (sku, extra = {}) => one(`INSERT INTO rental_items(business_id,sku_id,kind,pool_quantity,vehicle,meter,rate_hour,rate_day,late_per,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [rentals.id, sku, extra.kind || 'unit', extra.pool ?? null, extra.vehicle ?? null, extra.meter ?? null,
      'hour' in extra ? extra.hour : '100', 'day' in extra ? extra.day : '1500', extra.latePer || 'hour', ownerUser.id]);
    await assert.rejects(item(goods.id), /billed as a service item of this business, counted in services/);
    await assert.rejects(item(hourly.id), /counted in services/);
    await assert.rejects(item(hire.id, { hour: null, day: null }), /check/);
    await assert.rejects(item(hire.id, { kind: 'pool' }), /check/);
    await assert.rejects(item(hire.id, { latePer: 'hour', hour: null }), /check/);
    const gen = await item(hire.id, { meter: 'hours' });
    await assert.rejects(item(hire.id), /unique|duplicate/);
    const chairPool = await item(chairs.id, { kind: 'pool', pool: 100, hour: null, day: '12', latePer: 'day' });
    const car = await item(cars.id, { vehicle: 'car', meter: 'km', day: '3000' });
    await assert.rejects(rows("UPDATE rental_items SET kind='pool',pool_quantity=5 WHERE id=$1", [gen.id]), /keeps the item it is billed as/);
    await assert.rejects(rows("UPDATE rental_items SET vehicle='other',meter='km' WHERE id=$1", [gen.id]), /keeps the item it is billed as/);
    await rows('UPDATE rental_items SET rate_day=1600,deposit=5000 WHERE id=$1', [gen.id]);
    await assert.rejects(rows('DELETE FROM rental_items WHERE id=$1', [gen.id]), /never deleted/);
    // Units: of an item hired one by one; a vehicle with its registration; the meter never goes back; never deleted.
    const unit = (itemId, label, serial = null, meter = null) => one(`INSERT INTO rental_units(business_id,item_id,label,serial_no,meter_reading,created_by)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [rentals.id, itemId, label, serial, meter, ownerUser.id]);
    await assert.rejects(unit(chairPool.id, 'Chair 1'), /a pool keeps how many it has/);
    await assert.rejects(unit(car.id, 'Car without plate'), /registration number/);
    const genA = await unit(gen.id, 'Rule generator A', 'GX-101', 120);
    const genB = await unit(gen.id, 'Rule generator B', 'GX-102');
    const carA = await unit(car.id, 'Rule car', 'TS09AB1234', 25000);
    await assert.rejects(unit(gen.id, 'rule GENERATOR a'), /unique|duplicate/);
    await assert.rejects(unit(gen.id, 'Rule generator C', 'GX-101'), /unique|duplicate/);
    await assert.rejects(rows('UPDATE rental_units SET meter_reading=100 WHERE id=$1', [genA.id]), /a reading never goes back/);
    await rows('UPDATE rental_units SET meter_reading=130 WHERE id=$1', [genA.id]);
    await assert.rejects(rows("UPDATE rental_units SET status='maintenance' WHERE id=$1", [genB.id]), /check/);
    await assert.rejects(rows('DELETE FROM rental_units WHERE id=$1', [genB.id]), /never deleted/);
    // A booking: for a customer, a quote or reserved, today or later, at most 90 days.
    const booking = async (extra = {}) => one(`INSERT INTO rental_bookings(business_id,location_id,booking_no,contact_id,customer_name,status,out_at,due_at,tax_mode,subtotal,tax,total,
        deposit_due,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,'Rule Hirer',$5,now()+make_interval(mins=>$6::int),now()+make_interval(mins=>$7::int),'exclusive',0,0,0,$8,$9,$10,$11) RETURNING *`,
    [rentals.id, yard.id, `RULE-${crypto.randomBytes(3).toString('hex')}`, extra.contactId || hirer.id, extra.status || 'reserved', extra.from ?? 60, extra.until ?? 180,
      extra.deposit || 0, key(), 'x'.repeat(64), ownerUser.id]);
    await assert.rejects(booking({ contactId: supplier.id }), /Choose a customer/);
    await assert.rejects(booking({ status: 'out' }), /starts as a quote or reserved/);
    await assert.rejects(booking({ from: -60 * 30, until: -60 * 28 }), /starts today or later/);
    await assert.rejects(booking({ from: 60, until: 60 }), /check/);
    await assert.rejects(booking({ from: 60, until: 60 * 24 * 91 }), /check/);
    // A line: of its item's hire service, a unit for an item hired one by one and how many from a pool;
    // priced as its blocks at its booked rates (here 100 an hour, 1500 a day).
    const line = (b, it, extra = {}) => {
      const quantity = extra.quantity || 1;
      return one(`INSERT INTO rental_booking_lines(business_id,booking_id,seq,item_id,unit_id,sku_id,item_name,unit_label,quantity,rate_hour,rate_day,min_hours,
          buffer_minutes,grace_minutes,late_per,late_rate,deposit_each,charged_hours,hours,days,price,amount,tax_rate,net,tax)
        VALUES($1,$2,$3,$4,$5,$6,'Rule item',$7,$8,100,1500,0,$9,0,'hour',100,0,2,$10,$11,$12,$13,18,$13,$14) RETURNING *`,
      [rentals.id, b.id, extra.seq || 1, it.id, extra.unit?.id ?? null, extra.sku || it.sku_id, extra.unit ? extra.unit.label : null, quantity,
        extra.buffer || 0, extra.hours ?? 2, extra.days ?? 0, extra.price ?? '200', extra.amount ?? String(200 * quantity), String(36 * quantity)]);
    };
    const first = await booking();
    await assert.rejects(line(first, gen), /booked by its unit; a pool by how many/);
    await assert.rejects(line(first, chairPool, { unit: genA }), /booked by its unit; a pool by how many/);
    await assert.rejects(line(first, gen, { unit: genA, sku: chairs.id }), /hire service of its item/);
    await assert.rejects(line(first, gen, { unit: genA, price: '250', amount: '250' }), /check/);
    await assert.rejects(line(first, gen, { unit: genA, hours: 1, price: '100', amount: '100' }), /check/);
    const firstLine = await line(first, gen, { unit: genA });
    await assert.rejects(line(first, gen, { unit: genA, seq: 2 }), /unique|duplicate/);
    // What is free: the same unit is not held twice over the same time.
    const second = await booking({ from: 90, until: 240 });
    const clash = await line(second, gen, { unit: genA }).then(() => null, (error) => error);
    assert.ok(clash, 'the second booking of the same unit over the same time is refused');
    assert.match(clash.message, /^Rule generator A \(Rule item\) is booked on RULE-\w+ for Rule Hirer from .+ until it is free again at .+: it is not free from .+ to .+$/);
    assert.equal(clash.code, '23514');
    await line(second, gen, { unit: genB });
    // The turnaround time after a hire: free again only once it has passed.
    const later = await booking({ from: 185, until: 300 });
    await line(later, gen, { unit: genA, buffer: 30 });
    await assert.rejects(booking({ from: 310, until: 400 }).then((b) => line(b, gen, { unit: genA })), /is booked on RULE-\w+ for Rule Hirer/);
    await booking({ from: 335, until: 400 }).then((b) => line(b, gen, { unit: genA }));
    // A quote holds nothing: quoted over the same time, then refused while another booking holds the unit.
    const quote = await booking({ status: 'quote', from: 90, until: 170 });
    await line(quote, gen, { unit: genA });
    await assert.rejects(rows("UPDATE rental_bookings SET status='reserved' WHERE id=$1", [quote.id]), /is booked on/);
    // A pool is never held more than it has, at its busiest time.
    const event1 = await booking({ from: 60, until: 600 });
    await line(event1, chairPool, { quantity: 60 });
    const event2 = await booking({ from: 700, until: 900 });
    await line(event2, chairPool, { quantity: 80 });
    const event3 = await booking({ from: 500, until: 800 });
    const over = await line(event3, chairPool, { quantity: 30 }).then(() => null, (error) => error);
    assert.match(over.message, /^Only 20 of the 100 Rule item are free from .+ to .+: 80 are booked then$/);
    await line(event3, chairPool, { quantity: 20 });
    await assert.rejects(rows('UPDATE rental_booking_lines SET quantity=21,amount=4200,net=4200,tax=756 WHERE booking_id=$1', [event3.id]), /Only 20 of the 100/);
    // Lines keep their item and unit.
    await assert.rejects(rows('UPDATE rental_booking_lines SET unit_id=$2,unit_label=$3 WHERE id=$1', [firstLine.id, genB.id, genB.label]), /keeps its item and unit/);
    // The handover: a deposit asked is held (or someone agreed to less); a unit in maintenance stays; a self-drive car needs a licence in force.
    const hired = await booking({ from: 2, until: 120, deposit: '5000' });
    await line(hired, car, { unit: carA, hours: 0, days: 1, price: '1500', amount: '1500' });
    const handOver = (b, extra = '') => rows(`UPDATE rental_bookings SET status='out',checked_out_at=now(),checked_out_by=$2,checkout_key=$3,checkout_hash=$4${extra} WHERE id=$1`,
      [b.id, ownerUser.id, key(), 'x'.repeat(64)]);
    const waived = ",deposit_waived_by=$2,deposit_waiver='Regular customer'";
    await assert.rejects(handOver(hired), /asks a deposit of 5000\.00: take the rest, or record who agreed to less/);
    await assert.rejects(handOver(hired, waived), /self-drive vehicle is handed over with the hirer's driving licence/);
    await assert.rejects(handOver(hired, `${waived},licence_no='TS0920190001234',licence_valid_until=current_date-2`), /ran out on .+: a vehicle is not handed over on it/);
    await assert.rejects(handOver(hired, `${waived},licence_no='TS0920190001234',licence_valid_until=current_date+400,id_kind='aadhaar',id_ref='123456789012'`), /check/);
    await rows("UPDATE rental_units SET status='maintenance',status_note='Brake pads' WHERE id=$1", [carA.id]);
    await assert.rejects(handOver(hired, `${waived},licence_no='TS0920190001234',licence_valid_until=current_date+400`), /Rule car is in maintenance and is not handed over/);
    await rows("UPDATE rental_units SET status='available',status_note=NULL WHERE id=$1", [carA.id]);
    await handOver(hired, `${waived},licence_no='TS0920190001234',licence_valid_until=current_date+400,id_kind='aadhaar',id_ref='9012'`);
    // A unit out is held until it is due back (or now, while it is late).
    await assert.rejects(booking({ from: 60, until: 100 }).then((b) => line(b, car, { unit: carA, hours: 0, days: 1, price: '1500', amount: '1500' })),
      /Rule car \(Rule item\) is out on RULE-\w+ with Rule Hirer, due back .+: it is not free from .+ to .+$/);
    // What was recorded at the handover stays; a handed-over booking keeps its lines and out time.
    await assert.rejects(rows("UPDATE rental_bookings SET id_ref='1111' WHERE id=$1", [hired.id]), /recorded at the handover stays/);
    await assert.rejects(rows("UPDATE rental_bookings SET out_at=out_at+interval '1 minute' WHERE id=$1", [hired.id]), /out time stays/);
    const carLine = await one('SELECT * FROM rental_booking_lines WHERE booking_id=$1', [hired.id]);
    await assert.rejects(rows('UPDATE rental_booking_lines SET meter_out=25100 WHERE id=$1', [carLine.id]), /noted at the handover stays/);
    await assert.rejects(rows('DELETE FROM rental_booking_lines WHERE booking_id=$1', [hired.id]), /its lines stay/);
    await assert.rejects(line(hired, gen, { unit: genB, seq: 2 }), /nothing more goes on it/);
    await assert.rejects(rows("UPDATE rental_bookings SET status='returned' WHERE id=$1", [first.id]), /cannot go from reserved to returned/);
    await assert.rejects(rows('DELETE FROM rental_bookings WHERE id=$1', [first.id]), /never deleted/);
    // Advances and deposits: a new receipt in the hirer's name, by cash, card, UPI or bank, for a booking reserved or out.
    const receipt = async (b, method = 'cash', contactId = hirer.id) => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const k = (await db.query(`INSERT INTO business_collections(business_id,location_id,collection_no,contact_id,contact_name,amount,method,reference,request_key,request_hash,created_by)
          VALUES($1,$2,$3,$4,'Rule Hirer',500,$5,$6,$7,$8,$9) RETURNING id`, [rentals.id, yard.id, `RULE-RC-${crypto.randomBytes(3).toString('hex')}`, contactId, method,
          method === 'cheque' ? '000123' : null, key(), 'x'.repeat(64), ownerUser.id])).rows[0];
        await db.query("INSERT INTO rental_receipts(business_id,collection_id,booking_id,purpose,created_by) VALUES($1,$2,$3,'deposit',$4)", [rentals.id, k.id, b.id, ownerUser.id]);
        await db.query('COMMIT');
        return k;
      } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    };
    await assert.rejects(receipt(quote), /while it is reserved or out/);
    await assert.rejects(receipt(first, 'cheque'), /new receipt in its hirer's name, by cash, card, UPI or bank/);
    const otherHirer = await customer('Rule Other', '9000000202');
    await assert.rejects(receipt(first, 'cash', otherHirer.id), /new receipt in its hirer's name/);
    const held = await receipt(hired);
    assert.equal((await one('SELECT rental_deposit_held($1,$2) AS h', [rentals.id, hired.id])).h, '500.00');
    await assert.rejects(rows('DELETE FROM rental_receipts WHERE collection_id=$1', [held.id]), /stays with it/);
    // Returns: of a booking out, no more than went out; the late fee worked out from the due time.
    const takeBack = async (b, lines, charges = []) => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const r = (await db.query('INSERT INTO rental_returns(business_id,booking_id,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [rentals.id, b.id, key(), 'x'.repeat(64), ownerUser.id])).rows[0];
        for (const x of lines) {
          await db.query(`INSERT INTO rental_return_lines(business_id,return_id,booking_id,line_id,quantity,missing,meter_in,late_minutes,late_units,late_fee)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [rentals.id, r.id, b.id, x.lineId, x.quantity ?? 1, x.missing ?? 0, x.meter ?? null, x.minutes ?? 0, x.units ?? 0, x.fee ?? 0]);
        }
        for (const c of charges) {
          await db.query('INSERT INTO rental_charges(business_id,booking_id,return_id,booking_line_id,kind,amount,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [rentals.id, b.id, r.id, c.lineId, c.kind, c.amount, c.note ?? null, ownerUser.id]);
        }
        await db.query('COMMIT');
        return r;
      } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    };
    await assert.rejects(takeBack(first, [{ lineId: firstLine.id }]), /things come back on a booking that is out/);
    await assert.rejects(takeBack(hired, [{ lineId: carLine.id, quantity: 2 }]), /1 more come back at most/);
    await assert.rejects(takeBack(hired, [{ lineId: carLine.id, minutes: 30 }]), /worked out from its due time and its booked late rate/);
    await assert.rejects(takeBack(hired, [{ lineId: carLine.id }], [{ lineId: carLine.id, kind: 'damage', amount: '800' }]), /check/);
    await takeBack(hired, [{ lineId: carLine.id }], [{ lineId: carLine.id, kind: 'damage', amount: '800', note: 'Scratch on the rear door' }]);
    await assert.rejects(takeBack(hired, [{ lineId: carLine.id }]), /0 more come back at most/);
    await assert.rejects(rows('UPDATE rental_return_lines SET quantity=0 WHERE line_id=$1', [carLine.id]), /kept as it was taken/);
    await assert.rejects(rows('DELETE FROM rental_charges WHERE booking_id=$1', [hired.id]), /kept as it was noted/);
    await assert.rejects(rows('DELETE FROM rental_returns WHERE booking_id=$1', [hired.id]), /kept as it was taken/);
    // Back, the unit is free again (it has no turnaround time).
    await booking({ from: 60, until: 100 }).then((b) => line(b, car, { unit: carA, hours: 0, days: 1, price: '1500', amount: '1500' }));
    // History is kept as it was written.
    await rows("INSERT INTO rental_booking_events(business_id,booking_id,note,created_by) VALUES($1,$2,'Rule note',$3)", [rentals.id, first.id, ownerUser.id]);
    await assert.rejects(rows("UPDATE rental_booking_events SET note='x' WHERE booking_id=$1", [first.id]), /kept as it was written/);
    // Cancelled, a booking no longer changes and holds nothing: the quote can now be reserved.
    await rows("UPDATE rental_bookings SET status='cancelled',cancelled_at=now(),cancelled_by=$2,cancel_reason='Rule',cancel_key=$3,cancel_hash=$4 WHERE id=$1",
      [first.id, ownerUser.id, key(), 'x'.repeat(64)]);
    await assert.rejects(rows("UPDATE rental_bookings SET notes='x' WHERE id=$1", [first.id]), /is cancelled and no longer changes/);
    await rows("UPDATE rental_bookings SET status='reserved' WHERE id=$1", [quote.id]);
    // Another owner's rental business is a business of its own.
    assert.equal((await one('SELECT count(*)::int AS n FROM rental_bookings WHERE business_id=$1', [elsewhere.id])).n, 0);
  });
  // --- Staff --------------------------------------------------------------------------------------------
  const roles = (await request('GET', R('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', R('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('hire-desk@test.invalid', 'cashier');
  const yardHand = await staff('hire-yard@test.invalid', 'stock_keeper');
  const viewer = await staff('hire-viewer@test.invalid', 'viewer');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const approval = { approverId: ownerUser.id, pin: '2468' };
  const minute = (offsetMinutes = 0) => new Date(Math.floor(Date.now() / 60000) * 60000 + offsetMinutes * 60000).toISOString();
  // Time passes: a booking handed over moved back so many minutes, as if it went out then (its times only).
  async function backdate(bookingId, minutes) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // The availability check runs with the change, so the guard can be put back in the same transaction.
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE rental_bookings DISABLE TRIGGER rental_bookings_guard');
      await db.query(`UPDATE rental_bookings SET out_at=out_at-make_interval(mins=>$2::int),due_at=due_at-make_interval(mins=>$2::int),
        checked_out_at=checked_out_at-make_interval(mins=>$2::int) WHERE id=$1`, [bookingId, minutes]);
      await db.query('ALTER TABLE rental_bookings ENABLE TRIGGER rental_bookings_guard');
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  let gen, chairs, innova, tempo, genA, genB, innova1, asha, ravi, hotel;

  await t.test('rental items: billed as service items with their slab and SAC, one by one with units or from a pool, rates, rules and the settings', async () => {
    // A unit item made with its own service item: 18% (the default slab), its SAC, hour, day and week rates, a minimum, turnaround, grace and late fee.
    let list = await request('POST', R('rentals/items'), { item: { name: 'Generator 15 kVA', hsnCode: '997329' }, kind: 'unit', meter: 'hours', deposit: '5000',
      rates: { hour: '300', day: '1500', week: '7000' }, minHours: '4', bufferMinutes: '60', graceMinutes: '30', latePer: 'hour', lateRate: '400',
      units: [{ label: 'Gen A', serialNo: 'gx-201', meterReading: '1200' }, { label: 'Gen B', serialNo: 'GX 202', meterReading: '800' }] }, 201);
    gen = list.items.find((i) => i.name === 'Generator 15 kVA');
    assert.deepEqual([gen.kind, gen.tax_rate, gen.hsn_code, gen.meter, gen.deposit, gen.rate_hour, gen.rate_day, gen.rate_week, gen.rate_month, gen.min_hours, gen.late_rate],
      ['unit', '18.00', '997329', 'hours', '5000.00', '300.00', '1500.00', '7000.00', null, 4, '400.00']);
    assert.match(gen.item_code, /^RNT-\d{2}$/);
    assert.deepEqual(gen.units.map((u) => [u.label, u.serial_no, u.meter_reading, u.status]), [['Gen A', 'GX-201', '1200.0', 'available'], ['Gen B', 'GX202', '800.0', 'available']]);
    [genA, genB] = gen.units;
    const sku = await one('SELECT s.price,s.unit,p.kind FROM catalog_skus s JOIN catalog_products p ON p.id=s.product_id WHERE s.id=$1', [gen.sku_id]);
    assert.deepEqual([sku.price, sku.unit, sku.kind], ['0.00', 'service', 'service'], 'its price is in its rates');
    // A pool: how many the shop has, a day and a week rate, late by the day.
    list = await request('POST', R('rentals/items'), { item: { name: 'Plastic chair' }, kind: 'pool', poolQuantity: '200', deposit: '20', rates: { day: '12', week: '60' },
      bufferMinutes: '120', graceMinutes: '60' }, 201);
    chairs = list.items.find((i) => i.name === 'Plastic chair');
    assert.deepEqual([chairs.kind, chairs.pool_quantity, chairs.late_per, chairs.late_rate, chairs.units], ['pool', 200, 'day', null, []]);
    // A self-drive car at the like goods' slab (40%), with month rates; a vehicle needs its registration.
    assert.match((await refused('POST', R('rentals/items'), { item: { name: 'Bad car', taxRateId: gst40.id }, kind: 'unit', vehicle: 'car', rates: { day: '3500' },
      units: [{ label: 'No plate' }] })).message, /registration number/);
    list = await request('POST', R('rentals/items'), { item: { name: 'Innova Crysta', taxRateId: gst40.id, hsnCode: '997329' }, kind: 'unit', vehicle: 'car', deposit: '10000',
      rates: { hour: '450', day: '3500', week: '21000', month: '80000' }, minHours: '8', graceMinutes: '30', units: [{ label: 'Innova 1', serialNo: 'ts 09 cd-5678', meterReading: '25000' }] }, 201);
    innova = list.items.find((i) => i.name === 'Innova Crysta');
    [innova1] = innova.units;
    assert.deepEqual([innova.tax_rate, innova.vehicle, innova.meter, innova.with_driver, innova.late_per, innova.late_rate, innova1.serial_no], ['40.00', 'car', 'km', false, 'hour', null, 'TS09CD5678']);
    // A vehicle hired with the shop's driver (the hirer does not drive), at 5%.
    const gst5 = slabs.find((r) => Number(r.rate) === 5);
    list = await request('POST', R('rentals/items'), { item: { name: 'Tempo Traveller with driver', taxRateId: gst5.id }, kind: 'unit', vehicle: 'other', withDriver: true,
      rates: { day: '5000' }, units: [{ label: 'Tempo 1', serialNo: 'TS10UB5555' }] }, 201);
    tempo = list.items.find((i) => i.name === 'Tempo Traveller with driver');
    assert.deepEqual([tempo.with_driver, tempo.tax_rate], [true, '5.00']);
    // What is refused: no rate; a late fee by the hour with no hour rate or late rate; an item counted in hours; goods; the same item twice.
    assert.match((await refused('POST', R('rentals/items'), { item: { name: 'No rate' }, kind: 'unit' })).message, /at least one rate/);
    assert.match((await refused('POST', R('rentals/items'), { item: { name: 'Bad late' }, kind: 'pool', poolQuantity: '5', rates: { day: '10' }, latePer: 'hour' })).message,
      /late fee for each hour late, or a rate for an hour/);
    const hourly = await request('POST', R('catalog'), { kind: 'service', unit: 'hour', price: '0', taxRateId: gst18.id, name: 'Sound system hire', code: 'SND-HOUR' }, 201);
    assert.match((await refused('POST', R('rentals/items'), { skuId: hourly.id, kind: 'pool', poolQuantity: '2', rates: { hour: '500' } })).message, /not a service counted in services/);
    assert.equal((await refused('POST', R('rentals/items'), { skuId: gen.sku_id, kind: 'unit', rates: { day: '1' } })).status, 409);
    // Only someone who keeps the catalogue sets items up; a viewer reads them.
    assert.equal((await refused('POST', R('rentals/items'), { item: { name: 'Desk item' }, kind: 'pool', poolQuantity: '1', rates: { day: '1' } }, desk.token)).status, 403);
    assert.equal((await viewer.call('GET', R('rentals/items'))).items.filter((i) => !i.name.startsWith('Rule')).length, 4);
    // Units: added; for maintenance and back in service; a retired unit is not booked.
    list = await request('POST', R(`rentals/items/${gen.id}/units`), { label: 'Gen C', serialNo: 'GX-203' }, 201);
    const genC = list.items.find((i) => i.id === gen.id).units.find((u) => u.label === 'Gen C');
    assert.equal((await refused('POST', R(`rentals/items/${gen.id}/units`), { label: 'Gen D', serialNo: 'GX-201' })).status, 409);
    assert.match((await refused('PATCH', R(`rentals/units/${genC.id}`), { status: 'maintenance' }, yardHand.token)).message, /Say what the maintenance is for/);
    list = await yardHand.call('PATCH', R(`rentals/units/${genC.id}`), { status: 'maintenance', statusNote: 'Oil change' });
    assert.equal(list.items.find((i) => i.id === gen.id).units.find((u) => u.id === genC.id).status, 'maintenance');
    list = await request('PATCH', R(`rentals/units/${genC.id}`), { status: 'retired', statusNote: 'Sold' });
    assert.equal(list.items.find((i) => i.id === gen.id).units.find((u) => u.id === genC.id).status, 'retired');
    // The settings: a photo ID at every handover until changed, and the terms on the slips.
    const settings = await request('GET', R('rentals/settings'));
    assert.deepEqual([settings.idRequired, settings.terms], [true, null]);
    assert.equal((await refused('PUT', R('rentals/settings'), { terms: 'x' }, desk.token)).status, 403);
    const saved = await request('PUT', R('rentals/settings'), { terms: 'Return everything clean and on time. The deposit comes back once all is checked.' });
    assert.match(saved.terms, /deposit comes back/);
    asha = await customer('Asha Rao', '9876500111');
    ravi = await customer('Ravi Teja', '9876500112');
    hotel = await customer('Hotel Greenleaf', '9876500113', { creditDays: '15' });
  });

  const book = (body, by = request, expected = 201) => by('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, ...body }, expected);
  const tomorrow = addDays(today, 1);
  let first, chairBooking, carBooking;

  await t.test('the price of a hire: the cheapest mix of hours, days, weeks and months, a minimum, GST to the paisa', async () => {
    const quote = (outAt, dueAt, lines) => request('POST', R('rentals/bookings/preview'), { locationId: yard.id, outAt, dueAt, lines });
    // 10 days of a generator: a week and 3 days (7,000 + 3 × 1,500 = 11,500) is less than 10 days (15,000) or 2 weeks (14,000).
    let p = await quote(`${tomorrow}T10:00`, `${addDays(tomorrow, 10)}T10:00`, [{ itemId: gen.id, unitId: genA.id }]);
    assert.deepEqual([p.lines[0].hours, p.lines[0].period, p.lines[0].price, p.lines[0].tax, p.total, p.deposit, p.free], [240, '1 week + 3 days', '11500.00', '2070.00', '13570.00', '5000.00', true]);
    // 6 days: a week (7,000) is less than 6 days (9,000).
    p = await quote(`${tomorrow}T10:00`, `${addDays(tomorrow, 6)}T10:00`, [{ itemId: gen.id, unitId: genA.id }]);
    assert.deepEqual([p.lines[0].period, p.lines[0].price], ['1 week', '7000.00']);
    // 2 hours with a minimum of 4: 4 hours (1,200) is less than a day.
    p = await quote(`${tomorrow}T10:00`, `${tomorrow}T12:00`, [{ itemId: gen.id, unitId: genA.id }]);
    assert.deepEqual([p.lines[0].hours, p.lines[0].period, p.lines[0].price], [4, '4 hours', '1200.00']);
    // 40 days of a car: a month, a week and 3 days (80,000 + 21,000 + 10,500 = 1,11,500), GST at 40%.
    p = await quote(`${tomorrow}T09:00`, `${addDays(tomorrow, 40)}T09:00`, [{ itemId: innova.id, unitId: innova1.id }]);
    assert.deepEqual([p.lines[0].period, p.lines[0].price, p.lines[0].tax, p.total, p.deposit], ['1 month + 1 week + 3 days', '111500.00', '44600.00', '156100.00', '10000.00']);
    // 50 chairs for 2 days and 2½ hours (an hour or part counts: 51): 3 days at 12 each (36) is less than a week (60).
    p = await quote(`${tomorrow}T08:00`, `${addDays(tomorrow, 2)}T10:30`, [{ itemId: chairs.id, quantity: '50' }]);
    assert.deepEqual([p.lines[0].hours, p.lines[0].period, p.lines[0].price, p.lines[0].amount, p.lines[0].tax, p.deposit], [51, '3 days', '36.00', '1800.00', '324.00', '1000.00']);
    assert.equal(paise(p.subtotal) + paise(p.tax), paise(p.total));
    // What is refused: back before out, more than 90 days, a day passed, a retired unit, more than the pool, the same unit twice.
    const bad = (outAt, dueAt, lines) => refused('POST', R('rentals/bookings/preview'), { locationId: yard.id, outAt, dueAt, lines });
    assert.match((await bad(`${tomorrow}T10:00`, `${tomorrow}T09:00`, [{ itemId: gen.id, unitId: genA.id }])).message, /due back time is after the out time/);
    assert.match((await bad(`${tomorrow}T10:00`, `${addDays(tomorrow, 91)}T10:00`, [{ itemId: gen.id, unitId: genA.id }])).message, /at most 90 days/);
    assert.match((await bad(`${addDays(today, -1)}T10:00`, `${tomorrow}T10:00`, [{ itemId: gen.id, unitId: genA.id }])).message, /starts today or later/);
    const retired = gen.units.find((u) => u.label === 'Gen C') || (await request('GET', R('rentals/items'))).items.find((i) => i.id === gen.id).units.find((u) => u.label === 'Gen C');
    assert.match((await bad(`${tomorrow}T10:00`, `${tomorrow}T14:00`, [{ itemId: gen.id, unitId: retired.id }])).message, /retired and is not booked/);
    assert.match((await bad(`${tomorrow}T10:00`, `${tomorrow}T14:00`, [{ itemId: chairs.id, quantity: '201' }])).message, /The shop has 200 of Plastic chair/);
    assert.match((await bad(`${tomorrow}T10:00`, `${tomorrow}T14:00`, [{ itemId: gen.id, unitId: genA.id }, { itemId: gen.id, unitId: genA.id }])).message, /on the booking twice/);
    assert.match((await bad('tomorrow', `${tomorrow}T14:00`, [{ itemId: gen.id, unitId: genA.id }])).message, /date and time/);
  });

  await t.test('booking: reserved with an advance, idempotent, and what is free: a unit never booked twice, even when two are saved at once', async () => {
    // Out now, back in 6 hours: a day (1,500) is less than 6 hours (1,800); 18% GST 270; an advance of 500 in cash.
    first = await book({ contactId: asha.id, outAt: minute(), dueAt: minute(360), lines: [{ itemId: gen.id, unitId: genA.id }], advance: { amount: '500', method: 'cash' },
      notes: 'Wedding at the community hall' }, desk.call);
    assert.match(first.booking_no, /^RN\//);
    assert.deepEqual([first.status, first.subtotal, first.tax, first.total, first.deposit_due, first.advance_summary.taken, first.lines[0].period, first.lines[0].late_rate],
      ['reserved', '1500.00', '270.00', '1770.00', '5000.00', '500.00', '1 day', '400.00']);
    assert.equal(first.receipts[0].purpose, 'advance');
    assert.match(first.receipts[0].collection_no, /^RC\//);
    // The same request again is the same booking; the same key with other data is refused.
    const again = { requestKey: key(), locationId: yard.id, contactId: ravi.id, outAt: `${addDays(today, 3)}T10:00`, dueAt: `${addDays(today, 3)}T18:00`, lines: [{ itemId: chairs.id, quantity: '10' }] };
    const made = await request('POST', R('rentals/bookings'), again, 201);
    assert.equal((await request('POST', R('rentals/bookings'), again, 201)).id, made.id);
    assert.equal((await refused('POST', R('rentals/bookings'), { ...again, notes: 'Other' })).status, 409);
    // The same unit over the same time is refused, saying which booking holds it; the preview says so too.
    const clash = await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: ravi.id, outAt: minute(60), dueAt: minute(120),
      lines: [{ itemId: gen.id, unitId: genA.id }] });
    assert.equal(clash.status, 409);
    assert.match(clash.message, new RegExp(`Gen A \\(Generator 15 kVA\\) is booked on ${first.booking_no.replace(/\//g, '\\/')} for Asha Rao from .+ until it is free again at .+: it is not free from`));
    const seen = await request('POST', R('rentals/bookings/preview'), { locationId: yard.id, outAt: minute(60), dueAt: minute(120), lines: [{ itemId: gen.id, unitId: genA.id }] });
    assert.deepEqual([seen.free, seen.lines[0].free], [false, false]);
    assert.match(seen.lines[0].words, /Gen A is booked on RN\//);
    // Its turnaround time (an hour) keeps it after its due time: free again only once that has passed.
    assert.equal((await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: ravi.id, outAt: minute(390), dueAt: minute(500),
      lines: [{ itemId: gen.id, unitId: genA.id }] })).status, 409);
    const free = await request('GET', R(`rentals/free?outAt=${encodeURIComponent(minute(60))}&dueAt=${encodeURIComponent(minute(120))}`));
    const units = free.items.find((i) => i.itemId === gen.id).units;
    assert.deepEqual(units.map((u) => [u.label, u.free]), [['Gen A', false], ['Gen B', true]]);
    // Two bookings of Gen B for the same time saved together: one is booked, the other refused.
    const race = (contactId) => call('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId, outAt: `${addDays(today, 5)}T10:00`, dueAt: `${addDays(today, 5)}T20:00`,
      lines: [{ itemId: gen.id, unitId: genB.id }] }, ownerToken);
    const results = await Promise.all([race(asha.id), race(ravi.id), race(hotel.id)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    assert.ok(results.filter((r) => r.status === 409).every((r) => /Gen B \(Generator 15 kVA\) is booked on RN\//.test(r.body.message)));
    assert.equal((await one(`SELECT count(*)::int AS n FROM rental_booking_lines l JOIN rental_bookings b ON b.id=l.booking_id
      WHERE l.unit_id=$1 AND b.status='reserved'`, [genB.id])).n, 1);
    // A pool: never booked over what it has, at its busiest.
    chairBooking = await book({ contactId: hotel.id, outAt: minute(), dueAt: minute(48 * 60), lines: [{ itemId: chairs.id, quantity: '150' }] }, desk.call);
    assert.deepEqual([chairBooking.lines[0].period, chairBooking.total, chairBooking.deposit_due], ['2 days', '4248.00', '3000.00']);
    const over = await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: ravi.id, outAt: minute(60), dueAt: minute(600),
      lines: [{ itemId: chairs.id, quantity: '60' }] }, desk.token);
    assert.equal(over.status, 409);
    assert.match(over.message, /Only 50 of the 200 Plastic chair are free from .+: 150 are booked then/);
    // A quote holds nothing, and is refused when reserved over what is held.
    const q = await book({ status: 'quote', contactId: ravi.id, outAt: minute(30), dueAt: minute(200), lines: [{ itemId: gen.id, unitId: genA.id }] });
    assert.deepEqual([q.status, q.total], ['quote', '1416.00']);
    assert.match((await refused('POST', R(`rentals/bookings/${q.id}/confirm`))).message, /Gen A \(Generator 15 kVA\) is booked on/);
    assert.match((await refused('POST', R('rentals/bookings'), { requestKey: key(), status: 'quote', locationId: yard.id, contactId: ravi.id, outAt: minute(30), dueAt: minute(200),
      lines: [{ itemId: gen.id, unitId: genB.id }], advance: { amount: '100', method: 'cash' } })).message, /not a quote: reserve it first/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='rental_booking.created' AND entity_id=$2", [rentals.id, first.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='rental_booking.created' AND entity_id=$2", [rentals.id, first.id]));
    // A rental item's hire is billed from its booking only.
    const loose = await refused('POST', R('documents'), { kind: 'sale', requestKey: key(), locationId: yard.id, contactId: asha.id, lines: [{ skuId: gen.sku_id, quantity: '1' }] });
    assert.deepEqual([loose.status, /Generator 15 kVA is hired out from Bookings/.test(loose.message)], [409, true]);
  });

  await t.test('changes and extensions: priced again, a line kept keeps its booked rates, the advance stays within the hire', async () => {
    const b = await book({ contactId: ravi.id, outAt: `${addDays(today, 2)}T10:00`, dueAt: `${addDays(today, 2)}T12:00`, lines: [{ itemId: gen.id, unitId: genB.id }],
      advance: { amount: '1000', method: 'upi', reference: 'UPI-77' } });
    assert.deepEqual([b.lines[0].period, b.total], ['4 hours', '1416.00']);
    // The hour rate goes up; the booking keeps the rate it was made at; a new booking takes the new one.
    await request('PATCH', R(`rentals/items/${gen.id}`), { rates: { hour: '350', day: '1500', week: '7000' } });
    let now = await desk.call('PATCH', R(`rentals/bookings/${b.id}`), { dueAt: `${addDays(today, 2)}T13:00` });
    assert.deepEqual([now.lines[0].price, now.lines[0].rate_hour, now.total], ['1200.00', '300.00', '1416.00']);
    const fresh = await request('POST', R('rentals/bookings/preview'), { locationId: yard.id, outAt: `${addDays(today, 2)}T15:00`, dueAt: `${addDays(today, 2)}T17:00`,
      lines: [{ itemId: gen.id, unitId: genB.id }] });
    assert.deepEqual([fresh.lines[0].price, fresh.free], ['1400.00', true]);
    // Another unit and another item: a new line takes today's rates; the advance (1,000) is never more than the hire.
    now = await desk.call('PATCH', R(`rentals/bookings/${b.id}`), { lines: [{ itemId: gen.id, unitId: genB.id }, { itemId: chairs.id, quantity: '20' }] });
    assert.deepEqual([now.lines.length, now.lines[1].period, now.lines[1].amount, now.deposit_due], [2, '1 day', '240.00', '5400.00']);
    assert.match((await refused('PATCH', R(`rentals/bookings/${b.id}`), { lines: [{ itemId: chairs.id, quantity: '5' }] }, desk.token)).message,
      /1000\.00 was taken as an advance: the hire cannot come to less than that/);
    await request('PATCH', R(`rentals/items/${gen.id}`), { rates: { hour: '300', day: '1500', week: '7000' } });
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='rental_booking.changed' AND entity_id=$2", [rentals.id, b.id]));
    // A booking that is not out yet is cancelled with a cancellation charge billed (18%, at its item's slab); the advance pays it; the rest goes back with a PIN.
    const body = { requestKey: key(), reason: 'Function postponed', charges: [{ lineId: now.lines[0].id, amount: '300' }], refund: { method: 'upi', reference: 'UPI-BACK' } };
    assert.equal((await refused('POST', R(`rentals/bookings/${b.id}/cancel`), body, desk.token)).status, 403);
    assert.equal((await refused('POST', R(`rentals/bookings/${b.id}/cancel`), body)).data?.reason, 'approval_needed');
    now = await request('POST', R(`rentals/bookings/${b.id}/cancel`), { ...body, approval });
    const bill = await request('GET', R(`documents/${now.document_id}`));
    assert.deepEqual(bill.lines.map((l) => [l.label, l.net, l.tax]), [['Cancellation charge · Generator 15 kVA · Gen B (GX202)', '300.00', '54.00']]);
    assert.deepEqual([bill.total, bill.payments.map((p) => [p.amount, p.method])], ['354.00', [['354.00', 'upi']]]);
    assert.deepEqual([now.status, now.advance_summary.applied, now.advance_summary.refunded, now.advance_summary.left], ['cancelled', '354.00', '646.00', '0.00']);
    assert.equal(paise('354.00') + paise('646.00'), paise('1000.00'), 'the advance is the charge and what went back, to the paisa');
    assert.ok(await one("SELECT 1 FROM business_collection_refunds WHERE business_id=$1 AND source='rentals'", [rentals.id]));
    assert.equal((await request('POST', R(`rentals/bookings/${b.id}/cancel`), { ...body, approval })).status, 'cancelled', 'asking again is the same cancellation');
    assert.match((await refused('PATCH', R(`rentals/bookings/${b.id}`), { notes: 'x' })).message, /cancelled and no longer changes/);
  });

  await t.test('the handover: the hirer\'s ID (only the last four digits of an Aadhaar), the condition and meter, the deposit asked, and for a self-drive car its licences', async () => {
    const F = (suffix = '') => R(`rentals/bookings/${first.id}${suffix}`);
    const hand = (body, token = ownerToken) => call('POST', F('/checkout'), { requestKey: key(), lines: [{ lineId: first.lines[0].id, note: 'Tank full, no dents', meter: '1201' }], ...body }, token);
    assert.match((await hand({ idKind: 'aadhaar', idRef: '1234 5678 9012' })).body.message, /only the last four digits of the Aadhaar number/);
    assert.match((await hand({ idKind: 'aadhaar', idRef: '9012', lines: [{ lineId: first.lines[0].id }] })).body.message, /Read Gen A's hour meter as it goes out/);
    assert.match((await hand({ idKind: 'aadhaar', idRef: '9012', lines: [{ lineId: first.lines[0].id, meter: '1100' }] })).body.message, /read 1200 last: a reading never goes back/);
    assert.match((await hand({})).body.message, /Record the hirer's photo ID/);
    const short = await hand({ idKind: 'aadhaar', idRef: '9012' });
    assert.deepEqual([short.status, short.body.data?.reason, short.body.data?.asked, short.body.data?.held], [409, 'deposit_short', '5000.00', '0.00']);
    // The yard hand does not take money; the desk takes the deposit (a receipt, no GST), then the yard hand hands it over.
    assert.equal((await hand({ idKind: 'aadhaar', idRef: '9012', deposit: { amount: '5000', method: 'cash' } }, yardHand.token)).status, 403);
    let now = await desk.call('POST', F('/receipts'), { requestKey: key(), purpose: 'deposit', amount: '5000', method: 'cash' }, 201);
    assert.deepEqual([now.deposit.collected, now.deposit.held], ['5000.00', '5000.00']);
    const body = { idKind: 'aadhaar', idRef: '9012' };
    const handed = await hand(body, yardHand.token);
    assert.equal(handed.status, 200, JSON.stringify(handed.body));
    now = handed.body.data;
    assert.deepEqual([now.status, now.id_kind, now.id_ref, now.lines[0].meter_out, now.lines[0].out_note, now.money], ['out', 'aadhaar', '9012', '1201.0', 'Tank full, no dents', false]);
    assert.equal(now.total, null, 'the yard hand sees no money');
    assert.equal((await one('SELECT meter_reading FROM rental_units WHERE id=$1', [genA.id])).meter_reading, '1201.0');
    // The ID kept is the last four digits only, nowhere the whole number.
    assert.equal((await one("SELECT count(*)::int AS n FROM rental_bookings WHERE id_ref LIKE '%5678%'")).n, 0);
    // A self-drive car: the driving licence in force, and the State Transport Authority's rent-a-cab licence of the location.
    carBooking = await book({ contactId: ravi.id, outAt: minute(), dueAt: minute(50 * 60), lines: [{ itemId: innova.id, unitId: innova1.id }] }, desk.call);
    assert.deepEqual([carBooking.lines[0].period, carBooking.lines[0].price, carBooking.tax, carBooking.total, carBooking.deposit_due], ['2 days + 2 hours', '7900.00', '3160.00', '11060.00', '10000.00']);
    const C = (suffix = '') => R(`rentals/bookings/${carBooking.id}${suffix}`);
    const car = (extra) => call('POST', C('/checkout'), { requestKey: key(), idKind: 'driving_licence', idRef: 'TS0920190001234',
      lines: [{ lineId: carBooking.lines[0].id, meter: '25010', fuel: 'full', note: 'Small scratch on the rear bumper' }], ...extra }, ownerToken);
    assert.match((await car({})).body.message, /goes out on the hirer's driving licence/);
    assert.match((await car({ licenceNo: 'TS0920190001234', licenceValidUntil: addDays(today, -1) })).body.message, /ran out on .+: a vehicle is not handed over on it/);
    // A self-drive car goes in the hirer register (Form 5): the full address, and the licence's issuing authority, classes and issue date.
    const valid = { licenceNo: 'ts09 2019 0001234', licenceValidUntil: addDays(today, 900),
      register: { address: '12-3-45, Ameerpet, Hyderabad 500016', licenceAuthority: 'RTA Khairatabad', licenceClasses: ['LMV', 'MCWG'], licenceIssuedOn: '2019-06-12' } };
    assert.match((await car(valid)).body.message, /needs the State Transport Authority's rent-a-cab licence: switch on Licences & registrations in Settings › Business tools/);
    await request('PUT', R('modules/licences'), { enabled: true });
    assert.match((await car(valid)).body.message, /holds no rent-a-cab licence\. Add or renew it under Settings › Licences/);
    await request('POST', R('licences'), { locationId: yard.id, kind: 'rent_a_cab', name: 'Rent a cab licence', licenceNo: 'STA/RAC/2026/77', authority: 'State Transport Authority',
      validFrom: addDays(today, -30), validUntil: addDays(today, 1795) }, 201);
    assert.match((await car({ ...valid, lines: [{ lineId: carBooking.lines[0].id, meter: '25010' }] })).body.message, /Note Innova 1's fuel as it goes out/);
    // Less deposit than asked: refused, then agreed by a manager (their own say-so, with the reason).
    await desk.call('POST', C('/receipts'), { requestKey: key(), purpose: 'deposit', amount: '6000', method: 'upi', reference: 'UPI-DEP-1' }, 201);
    assert.equal((await car(valid)).body.data?.reason, 'deposit_short');
    const out = await car({ ...valid, waiver: { reason: 'Known hirer: rest of the deposit waived' } });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([out.body.data.status, out.body.data.licence_no, out.body.data.licence_valid_until, out.body.data.deposit_waiver, out.body.data.deposit.held, out.body.data.lines[0].fuel_out],
      ['out', 'TS0920190001234', addDays(today, 900), 'Known hirer: rest of the deposit waived', '6000.00', 'full']);
    // A vehicle with the shop's driver goes out on no licence of the hirer's.
    const tour = await book({ contactId: asha.id, outAt: minute(), dueAt: minute(600), lines: [{ itemId: tempo.id, unitId: tempo.units[0].id }] });
    const tourOut = await call('POST', R(`rentals/bookings/${tour.id}/checkout`), { requestKey: key(), idKind: 'voter_id', idRef: 'TSV1234567',
      lines: [{ lineId: tour.lines[0].id, meter: '10000', fuel: 'full' }] }, ownerToken);
    assert.equal(tourOut.status, 200, JSON.stringify(tourOut.body));
    // Handed over is handed over: the same request again is the same handover; nothing on it changes but its due back time.
    const again = await call('POST', F('/checkout'), { requestKey: key(), ...body }, ownerToken);
    assert.match(again.body.message, /handed over already/);
    assert.match((await refused('PATCH', F(), { outAt: minute(10) })).message, /only when it is due back and its notes change/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='rental_booking.checked_out' AND entity_id=$2", [rentals.id, first.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='rental_booking.checked_out' AND entity_id=$2", [rentals.id, first.id]));
  });

  await t.test('the board, the due back lists, the bell and the week of what is free', async () => {
    // The generator's booking is late: moved back 8 hours 30 minutes, it was due back 2 hours 30 minutes ago.
    await backdate(first.id, 510);
    const board = await desk.call('GET', R('rentals/bookings/board'));
    const stageOf = (b) => board.items.find((x) => x.id === b.id)?.stage;
    assert.deepEqual([stageOf(first), stageOf(carBooking), stageOf(chairBooking)], ['overdue', 'out', 'reserved']);
    assert.ok(board.counts.overdue >= 1 && board.counts.out_now >= 3 && board.counts.reserved >= 2);
    assert.ok((await desk.call('GET', R('rentals/bookings/open?overdue=true'))).items.every((x) => x.overdue));
    // Due back today: something out and due on the business's own date.
    const dueToday = await book({ contactId: hotel.id, outAt: minute(), dueAt: `${today}T23:59`, lines: [{ itemId: chairs.id, quantity: '10' }] }).catch(() => null);
    if (dueToday && dueToday.status === 'reserved') {
      await call('POST', R(`rentals/bookings/${dueToday.id}/checkout`), { requestKey: key(), idKind: 'pan_card', idRef: 'ABCDE1234F', deposit: { amount: '200', method: 'cash' } }, ownerToken);
      const due = await desk.call('GET', R('rentals/bookings/open?due_today=true'));
      assert.ok(due.items.some((x) => x.id === dueToday.id && x.stage === 'due_today'));
    }
    // The bell: past its due back time.
    const bell = await request('GET', R('notifications'));
    assert.ok(bell.items.some((n) => n.category === 'Bookings' && n.title === `${first.booking_no} is past its due back time`));
    // The week: each unit with the bookings holding it on each day; each pool with the most held at once.
    const week = await viewer.call('GET', R(`rentals/availability?from=${today}`));
    assert.equal(week.days.length, 7);
    const genRow = week.items.find((i) => i.itemId === gen.id).units.find((u) => u.label === 'Gen A');
    assert.ok(genRow.days[0].holds.some((h) => h.bookingNo === first.booking_no && h.part === 'out'));
    const chairDay = week.items.find((i) => i.itemId === chairs.id).days[0];
    assert.ok(chairDay.held >= 150 && chairDay.free === 200 - chairDay.held);
    assert.ok(!week.items.find((i) => i.itemId === gen.id).units.some((u) => u.label === 'Gen C'), 'a retired unit with nothing booked is left out');
  });

  await t.test('the return: late fee and damage billed with GST, the advance and the deposit paying the bill, the rest handed back with a PIN', async () => {
    const F = (suffix = '') => R(`rentals/bookings/${first.id}${suffix}`);
    const now0 = await request('GET', F());
    // 2 hours 30 minutes late, after 30 minutes' grace: 3 hours at 400 = 1,200 so far.
    assert.deepEqual([now0.overdue, now0.lines[0].late_units_now, now0.lines[0].late_fee_now], [true, 3, '1200.00']);
    const body = { requestKey: key(), lines: [{ lineId: first.lines[0].id, quantity: '1', meter: '1209.5', note: 'Panel scratched' }],
      charges: [{ lineId: first.lines[0].id, kind: 'damage', amount: '800', note: 'Scratch on the side panel' }], refund: { method: 'cash' } };
    const preview = await request('POST', F('/returns/preview'), body);
    // Hire 1,500 + 270; late 1,200 + 216; damage 800 + 144: 4,130.00. The advance pays 500, the deposit 3,630; 1,370 of the deposit goes back.
    assert.deepEqual([preview.final, preview.lateFee, preview.total, preview.advance, preview.deposit, preview.due, preview.depositBack],
      [true, '1200.00', '4130.00', '500.00', '3630.00', '0.00', '1370.00']);
    assert.deepEqual(preview.bill.map((x) => [x.label, x.net, x.tax]), [['Hire for 1 day · Generator 15 kVA · Gen A (GX-201)', '1500.00', '270.00'],
      ['Late return, 3 hours · Generator 15 kVA · Gen A (GX-201)', '1200.00', '216.00'], ['Damage · Scratch on the side panel · Generator 15 kVA · Gen A (GX-201)', '800.00', '144.00']]);
    // The meter never reads less; money handed back needs the PIN; the yard hand does not bill.
    assert.match((await refused('POST', F('/returns'), { ...body, requestKey: key(), refund: undefined, lines: [{ lineId: first.lines[0].id, meter: '1100' }] })).message, /cannot come back reading less/);
    assert.equal((await refused('POST', F('/returns'), body)).data?.reason, 'approval_needed');
    assert.equal((await refused('POST', F('/returns'), { ...body, refund: undefined }, yardHand.token)).status, 403);
    const back = await request('POST', F('/returns'), { ...body, approval }, 201);
    assert.deepEqual([back.status, back.deposit.collected, back.deposit.applied, back.deposit.refunded, back.deposit.held, back.advance_summary.applied],
      ['returned', '5000.00', '3630.00', '1370.00', '0.00', '500.00']);
    const bill = await request('GET', R(`documents/${back.document_id}`));
    assert.deepEqual([bill.total, bill.subtotal, bill.tax, bill.contact_id], ['4130.00', '3500.00', '630.00', asha.id]);
    assert.deepEqual(bill.lines.map((l) => [l.label, l.quantity, l.unit_price, l.tax_rate, l.hsn_code]), [['Hire for 1 day · Generator 15 kVA · Gen A (GX-201)', '1.000', '1500.00', '18.00', '997329'],
      ['Late return, 3 hours · Generator 15 kVA · Gen A (GX-201)', '1.000', '1200.00', '18.00', '997329'],
      ['Damage · Scratch on the side panel · Generator 15 kVA · Gen A (GX-201)', '1.000', '800.00', '18.00', '997329']]);
    assert.deepEqual(bill.payments.map((p) => [p.amount, p.method]).sort(), [['3630.00', 'cash'], ['500.00', 'cash']]);
    assert.equal(bill.payments.reduce((s, p) => s + paise(p.amount), 0), paise(bill.total), 'the advance and the deposit are the bill, to the paisa');
    assert.equal(paise('3630.00') + paise('1370.00'), paise('5000.00'), 'the deposit is what paid the bill and what went back');
    const refund = await one("SELECT amount,method,approved_by FROM business_collection_refunds WHERE business_id=$1 AND source='rentals' ORDER BY id DESC LIMIT 1", [rentals.id]);
    assert.deepEqual([refund.amount, refund.method, Number(refund.approved_by)], ['1370.00', 'cash', Number(ownerUser.id)]);
    assert.deepEqual([back.returns[0].lines[0].late_units, back.returns[0].lines[0].late_fee, back.charges[0].line_id !== null, back.lines[0].line_id !== null], [3, '1200.00', true, true]);
    assert.equal((await one('SELECT meter_reading FROM rental_units WHERE id=$1', [genA.id])).meter_reading, '1209.5');
    // A retry is the same return; the same key with other data is refused; nothing more comes back.
    assert.equal((await request('POST', F('/returns'), { ...body, approval }, 201)).document_id, back.document_id);
    assert.equal((await refused('POST', F('/returns'), { ...body, approval, note: 'Other' })).status, 409);
    assert.match((await refused('POST', F('/returns'), { ...body, approval, requestKey: key() })).message, /is returned: things come back on a booking that is out/);
    // The unit is free again once back (after its turnaround time).
    const free = await request('GET', R(`rentals/free?outAt=${encodeURIComponent(minute(70))}&dueAt=${encodeURIComponent(minute(130))}`));
    assert.equal(free.items.find((i) => i.itemId === gen.id).units.find((u) => u.label === 'Gen A').free, true);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='rental_booking.returned' AND entity_id=$2", [rentals.id, first.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='rental_booking.returned' AND entity_id=$2", [rentals.id, first.id]));
    // A deposit held stays out of the customer's "apply advance": the car's deposit pays only the car's bill.
    const carNow = await request('GET', R(`rentals/bookings/${carBooking.id}`));
    assert.equal(carNow.deposit.held, '6000.00');
    const delivery = await serviceItem({ name: 'Delivery to the venue', code: 'DLV' });
    await request('POST', R('documents'), { kind: 'sale', requestKey: key(), locationId: yard.id, contactId: ravi.id, lines: [{ skuId: delivery.id, quantity: '1', unitPrice: '500' }] }, 201);
    const apply = await call('POST', R(`receivables/customers/${ravi.id}/apply-advance`), { requestKey: key() }, ownerToken);
    assert.deepEqual([apply.status, /no advance to apply/.test(apply.body.message)], [409, true]);
    assert.equal((await request('GET', R(`rentals/bookings/${carBooking.id}`))).deposit.held, '6000.00');
  });

  await t.test('a pool back in parts: what is missing charged and taken off the pool, cleaning, the rest paid at the counter', async () => {
    const P = (suffix = '') => R(`rentals/bookings/${chairBooking.id}${suffix}`);
    await desk.call('POST', P('/checkout'), { requestKey: key(), idKind: 'pan_card', idRef: 'AAACH1234K', deposit: { amount: '3000', method: 'upi', reference: 'UPI-CH-1' } });
    // 100 back now; the rest is still out (no bill yet, no money taken).
    let now = await yardHand.call('POST', P('/returns'), { requestKey: key(), lines: [{ lineId: chairBooking.lines[0].id, quantity: '100' }] }, 201);
    assert.deepEqual([now.status, now.lines[0].back, now.lines[0].left, now.document_id], ['out', 100, 50, null]);
    assert.match((await refused('POST', P('/returns'), { requestKey: key(), lines: [{ lineId: chairBooking.lines[0].id, quantity: '51' }] }, desk.token)).message, /50 of Plastic chair are still out/);
    // The last 50: 45 back, 5 missing (750 for them) and cleaning 200; hire 3,600 + 648, missing 750 + 135, cleaning 200 + 36 = 5,369.00.
    // The deposit (3,000) pays first; the rest, 2,369.00, is paid now.
    const last = { requestKey: key(), lines: [{ lineId: chairBooking.lines[0].id, quantity: '45', missing: '5' }],
      charges: [{ lineId: chairBooking.lines[0].id, kind: 'missing', amount: '750', note: '5 chairs not returned' }, { lineId: chairBooking.lines[0].id, kind: 'cleaning', amount: '200' }],
      payment: { amount: 'full', method: 'cash' } };
    const preview = await desk.call('POST', P('/returns/preview'), last);
    assert.deepEqual([preview.total, preview.deposit, preview.due, preview.depositBack], ['5369.00', '3000.00', '2369.00', '0.00']);
    now = await desk.call('POST', P('/returns'), last, 201);
    const bill = await request('GET', R(`documents/${now.document_id}`));
    assert.deepEqual(bill.lines.map((l) => [l.label, l.quantity, l.net, l.tax]), [['Hire for 2 days · 150 × Plastic chair', '150.000', '3600.00', '648.00'],
      ['Missing · 5 chairs not returned · Plastic chair', '1.000', '750.00', '135.00'], ['Cleaning · Plastic chair', '1.000', '200.00', '36.00']]);
    assert.deepEqual([bill.total, bill.payments.map((p) => [p.amount, p.method]).sort()], ['5369.00', [['2369.00', 'cash'], ['3000.00', 'upi']]]);
    assert.deepEqual([now.status, now.deposit.applied, now.deposit.held], ['returned', '3000.00', '0.00']);
    // What will not come back leaves the pool.
    assert.equal((await one('SELECT pool_quantity FROM rental_items WHERE id=$1', [chairs.id])).pool_quantity, 195);
    // The pool cannot be set below what bookings to come hold.
    const big = await book({ contactId: ravi.id, outAt: `${addDays(today, 8)}T08:00`, dueAt: `${addDays(today, 8)}T20:00`, lines: [{ itemId: chairs.id, quantity: '190' }] });
    assert.match((await refused('PATCH', R(`rentals/items/${chairs.id}`), { poolQuantity: '150' })).message, /hold 190 of Plastic chair at their busiest/);
    await request('POST', R(`rentals/bookings/${big.id}/cancel`), { requestKey: key(), reason: 'Customer booked elsewhere' });
  });

  await t.test('the deposits held: the ledger booking by booking and in all, a deposit handed back later, and who sees money', async () => {
    const ledger = await desk.call('GET', R('rentals/deposits'));
    const row = (b) => ledger.items.find((x) => x.id === b.id);
    assert.deepEqual([paise(row(first).collected), paise(row(first).applied), paise(row(first).refunded), paise(row(first).held), row(first).state], [500000, 363000, 137000, 0, 'settled']);
    assert.deepEqual([paise(row(carBooking).held), row(carBooking).state], [600000, 'held']);
    const totals = await desk.call('GET', R('rentals/deposits/totals'));
    assert.ok(paise(totals.held) >= paise('6000.00') && totals.bookings >= 1);
    assert.equal(paise(totals.collected), paise(totals.applied) + paise(totals.refunded) + paise(totals.held), 'what was taken is what paid bills, went back, and is held');
    // Someone who does not see sales does not see the deposits.
    assert.equal((await refused('GET', R('rentals/deposits'), undefined, yardHand.token)).status, 403);
    // A deposit is handed back only once the booking is back or cancelled.
    assert.match((await refused('POST', R(`rentals/bookings/${carBooking.id}/refund`), { requestKey: key(), method: 'cash', reason: 'Early', ...approval })).message,
      /held until it is back \(or cancelled\)/);
    // The car comes back on time: its bill paid from the deposit (11,060 is more than 6,000 held); the rest is owed on the hirer's account.
    const C = (suffix = '') => R(`rentals/bookings/${carBooking.id}${suffix}`);
    const now = await request('POST', C('/returns'), { requestKey: key(), lines: [{ lineId: carBooking.lines[0].id, meter: '25420', fuel: 'half' }] }, 201);
    assert.deepEqual([now.status, now.deposit.applied, now.deposit.held, now.bill.total, now.bill.due], ['returned', '6000.00', '0.00', '11060.00', '5060.00']);
    const board = await request('GET', R('rentals/bookings/board'));
    assert.equal(board.items.find((x) => x.id === carBooking.id).stage, 'to_settle');
  });

  await t.test('other types and other owners are kept out', async () => {
    assert.equal((await refused('GET', `/businesses/${grocery.id}/rentals/bookings`)).status, 403);
    assert.equal((await refused('GET', `/businesses/${laundry.id}/rentals/items`)).status, 403);
    // The item routes check the catalogue permission first, then answer for a rental business only.
    assert.equal((await refused('POST', `/businesses/${grocery.id}/rentals/items`, { item: { name: 'Chair' }, kind: 'pool', poolQuantity: '1', rates: { day: '1' } })).status, 404);
    assert.equal((await refused('GET', R(`rentals/bookings/${first.id}`), undefined, await login('hire-other@test.invalid'))).status, 404);
    assert.equal((await other('GET', `/businesses/${elsewhere.id}/rentals/bookings`)).total, 0);
    // A viewer reads and changes nothing.
    assert.equal((await refused('POST', R('rentals/bookings'), { requestKey: key(), locationId: yard.id, contactId: asha.id, outAt: minute(60), dueAt: minute(120),
      lines: [{ itemId: gen.id, unitId: genB.id }] }, viewer.token)).status, 403);
    assert.equal((await viewer.call('GET', R(`rentals/bookings/${first.id}`))).total, '1770.00', 'a viewer sees sales, and the money');
  });
});
