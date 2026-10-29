const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { addDays, daysFrom } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// A laundry's prices of its own (by location, customer group and customer,
// from a date), carpets by the square foot, each service's days to the
// promised day on the shop's open days, discounts and offers kept as taken
// in, prepaid kilo and piece packages with carry-forward, photos and the
// customer's signature, the quality check with rewash and packing, a garment
// changed after intake with its bill adjusted, garments added to an open
// order, the pieces under one tag handed over one by one, and the claims
// added up. Money to the paisa, refusals with their codes, idempotent retries,
// audit and events. Runs on its own throwaway database with every migration.
test('laundry: prices of their own, packages, checks and changes', { timeout: 300000 }, async (t) => {
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
  const password = `Wash-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('press-owner');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('press-owner@test.invalid');
  const request = as(ownerToken);
  const refused = async (method, route, body, token = ownerToken) => {
    const result = await call(method, route, body, token);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const today = daysFrom(0);
  const weekday = (day) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

  const [laundry, grocery] = await createBusinesses(request, 'OWNER', ['laundry', 'grocery']);
  const L = (suffix) => `/businesses/${laundry.id}/${suffix}`;
  const locations = (await request('GET', L('locations'))).items;
  const shop = locations[0];
  const branch = await request('POST', L('locations'), { name: 'Banjara Hills counter', code: 'BH' }, 201);
  const slabs = (await request('GET', L('tax-rates'))).items;
  const gst18 = slabs.find((r) => Number(r.rate) === 18);
  const customer = (name, phone) => request('POST', L('contacts'), { kind: 'customer', name, ...(phone ? { phone } : {}) }, 201);
  await pool.query('UPDATE business_settings SET max_bill_discount_percent=10 WHERE business_id=$1', [laundry.id]);

  // Staff: the counter (a cashier), the presser (a stock keeper) and a manager.
  const roles = (await request('GET', L('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', L('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    const token = await login(email);
    return { id: user.id, call: as(token), token };
  }
  const desk = await staff('press-desk@test.invalid', 'cashier');
  const presser = await staff('press-work@test.invalid', 'stock_keeper');
  const manager = await staff('press-manager@test.invalid', 'manager');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [ownerUser.id, await bcrypt.hash('2468', 4)]);
  const approval = { approverId: ownerUser.id, pin: '2468' };

  // The price list: dry cleaning, wash and iron, wash and fold by the kilo, carpet shampoo by the square foot.
  let list = await request('POST', L('laundry/services'), { item: { name: 'Dry cleaning', hsnCode: '999712' } }, 201);
  list = await request('POST', L('laundry/services'), { item: { name: 'Wash & iron' } }, 201);
  list = await request('POST', L('laundry/services'), { item: { name: 'Wash & fold' } }, 201);
  list = await request('POST', L('laundry/services'), { item: { name: 'Carpet shampoo', hsnCode: '999719' } }, 201);
  for (const g of [{ name: 'Shirt' }, { name: 'Saree' }, { name: 'Mixed clothes' }, { name: 'Carpet' }, { name: 'Suit (3 piece)', countedAs: 'set', pieces: '3' }]) {
    list = await request('POST', L('laundry/garments'), g, 201);
  }
  const svc = Object.fromEntries(list.services.map((s) => [s.name, s]));
  const garmentOf = (name) => list.garments.find((g) => g.name === name);
  const price = (garment, service, value, per = 'item') => ({ garmentTypeId: garmentOf(garment).id, serviceId: svc[service].id, per, price: value });
  list = await request('PUT', L('laundry/prices'), { prices: [price('Shirt', 'Dry cleaning', '120'), price('Shirt', 'Wash & iron', '40'), price('Saree', 'Dry cleaning', '350'),
    price('Mixed clothes', 'Wash & fold', '89.90', 'kg'), price('Carpet', 'Carpet shampoo', '25.50', 'sqft'), price('Suit (3 piece)', 'Dry cleaning', '600')] });
  assert.equal(list.prices.find((p) => Number(p.garment_type_id) === Number(garmentOf('Carpet').id)).per, 'sqft');
  const asha = await customer('Asha Rao', '9876500201');
  const meena = await customer('Meena Iyer', '9876500202');
  const ravi = await customer('Ravi Kumar', '9876500203');
  const item = (garment, service, extra = {}) => ({ garmentTypeId: garmentOf(garment).id, serviceId: svc[service].id, ...extra });
  const preview = (body, by = request) => by('POST', L('laundry/orders/preview'), { locationId: shop.id, ...body });
  const take = (body, by = request, expected = 201) => by('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, ...body }, expected);

  await t.test('prices of their own: a location\'s, a group\'s and a customer\'s, from a date, ended never deleted, the list for the rest', async () => {
    // A customer group, with Asha in it.
    let groups = await request('POST', L('laundry/groups'), { name: 'Green Meadows Society' }, 201);
    const society = groups.find((g) => g.name === 'Green Meadows Society');
    assert.equal((await refused('POST', L('laundry/groups'), { name: 'green meadows society' })).status, 409);
    assert.equal((await refused('POST', L('laundry/groups'), { name: 'Hotels' }, desk.token)).status, 403);
    await request('PUT', L('laundry/group-members'), { contactId: asha.id, groupId: society.id });
    groups = await request('GET', L('laundry/groups'));
    assert.equal(groups.find((g) => g.id === society.id).members, 1);
    assert.deepEqual((await request('GET', L(`laundry/group-members?group=${society.id}`))).items.map((m) => m.name), ['Asha Rao']);
    // Shirts dry cleaned: the list 120; the main counter 110; the society 100; Asha herself 90 from tomorrow.
    const shirt = { garmentTypeId: garmentOf('Shirt').id, serviceId: svc['Dry cleaning'].id };
    await request('POST', L('laundry/price-overrides'), { ...shirt, locationId: shop.id, price: '110' }, 201);
    const forSociety = await request('POST', L('laundry/price-overrides'), { ...shirt, groupId: society.id, price: '100' }, 201);
    const forAsha = await request('POST', L('laundry/price-overrides'), { ...shirt, contactId: asha.id, price: '90', validFrom: addDays(today, 1) }, 201);
    // One a day for the same garment, service and party; never from a day passed; one party at a time.
    assert.match((await refused('POST', L('laundry/price-overrides'), { ...shirt, groupId: society.id, price: '95' })).message, /starts on .*: end it first/);
    assert.equal((await refused('POST', L('laundry/price-overrides'), { ...shirt, groupId: society.id, price: '95', validFrom: addDays(today, -1) })).status, 400);
    assert.equal((await refused('POST', L('laundry/price-overrides'), { ...shirt, groupId: society.id, contactId: asha.id, price: '95' })).status, 400);
    assert.equal((await refused('POST', L('laundry/price-overrides'), { garmentTypeId: garmentOf('Saree').id, serviceId: svc['Wash & iron'].id, locationId: shop.id, price: '9' })).status, 409);
    const priceFor = async (body) => (await preview({ items: [item('Shirt', 'Dry cleaning')], ...body })).items[0];
    assert.deepEqual([(await priceFor({})).rate, (await priceFor({})).priceSource], ['110.00', 'location']);
    assert.deepEqual([(await priceFor({ contactId: asha.id })).rate, (await priceFor({ contactId: asha.id })).priceSource], ['100.00', 'group'], 'Asha\'s own price starts tomorrow');
    assert.equal((await priceFor({ contactId: ravi.id })).rate, '110.00');
    assert.deepEqual([(await priceFor({ contactId: ravi.id, locationId: branch.id })).rate, (await priceFor({ locationId: branch.id })).priceSource], ['120.00', 'list']);
    // By date: Meena's price that ended yesterday no longer counts; the one from today does.
    await pool.query(`INSERT INTO laundry_price_overrides(business_id,garment_type_id,service_id,contact_id,per,price,valid_from,valid_to,created_by)
      VALUES($1,$2,$3,$4,'item',80,$5,$6,$7),($1,$2,$3,$4,'item',95,$8,NULL,$7)`, [laundry.id, shirt.garmentTypeId, shirt.serviceId, meena.id, addDays(today, -9), addDays(today, -1), ownerUser.id, today]);
    assert.deepEqual([(await priceFor({ contactId: meena.id })).rate, (await priceFor({ contactId: meena.id })).priceSource], ['95.00', 'customer']);
    // A new price for the society from a later day ends today's the day before.
    await request('POST', L('laundry/price-overrides'), { ...shirt, groupId: society.id, price: '105', validFrom: addDays(today, 3) }, 201);
    assert.equal((await one('SELECT valid_to::text AS d FROM laundry_price_overrides WHERE id=$1', [forSociety.id])).d, addDays(today, 2));
    // Asha's own, not started, is withdrawn: ended the day before it starts, in force on no day.
    const ended = await request('POST', L(`laundry/price-overrides/${forAsha.id}/end`), {});
    assert.equal(ended.validTo, today);
    const listed = (await request('GET', L('laundry/price-overrides?current=true'))).items;
    assert.ok(!listed.some((o) => o.id === forAsha.id) && listed.some((o) => o.id === forSociety.id));
    // The database keeps them: never deleted, never kept on longer, never two at once.
    await assert.rejects(pool.query('DELETE FROM laundry_price_overrides WHERE id=$1', [forSociety.id]), /never deleted/);
    await assert.rejects(pool.query('UPDATE laundry_price_overrides SET valid_to=NULL WHERE id=$1', [forSociety.id]), /ended earlier/);
    await assert.rejects(pool.query('UPDATE laundry_price_overrides SET price=1 WHERE id=$1', [forSociety.id]), /keeps what it was set at/);
    await assert.rejects(pool.query(`INSERT INTO laundry_price_overrides(business_id,garment_type_id,service_id,location_id,per,price,valid_from,created_by)
      VALUES($1,$2,$3,$4,'item',1,$5,$6)`, [laundry.id, shirt.garmentTypeId, shirt.serviceId, shop.id, today, ownerUser.id]), /in force on these days/);
    // The order keeps the price and where it came from.
    const order = await take({ contactId: asha.id, items: [item('Shirt', 'Dry cleaning')] }, desk.call);
    assert.deepEqual([order.items[0].rate, order.items[0].price_source, Number(order.items[0].price_override_id)], ['100.00', 'group', Number(forSociety.id)]);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='laundry_price_override.set'", [laundry.id]));
  });

  await t.test('area pricing: a carpet by the square foot, length × width rounded as the shop sets, to the paisa', async () => {
    // 8.5 × 5.75 ft = 48.875 sq ft: to the hundredth 48.88 × 25.50 = 1,246.44, GST 224.36.
    let quote = await preview({ items: [item('Carpet', 'Carpet shampoo', { length: '8.5', width: '5.75' })] });
    assert.deepEqual([quote.items[0].per, quote.items[0].quantity, quote.items[0].base, quote.items[0].tax, quote.total], ['sqft', '48.88', '1246.44', '224.36', '1470.80']);
    await request('PUT', L('laundry/settings'), { areaRounding: 'up' });
    quote = await preview({ items: [item('Carpet', 'Carpet shampoo', { length: '8.5', width: '5.75' })] });
    assert.deepEqual([quote.items[0].quantity, quote.items[0].base, quote.items[0].tax], ['49', '1249.50', '224.91']);
    await request('PUT', L('laundry/settings'), { areaRounding: 'nearest' });
    assert.equal((await preview({ items: [item('Carpet', 'Carpet shampoo', { length: '6.2', width: '4.1' })] })).items[0].quantity, '25', '25.42 to the nearest whole');
    assert.match((await refused('POST', L('laundry/orders/preview'), { locationId: shop.id, items: [item('Carpet', 'Carpet shampoo', { length: '8' })] })).message, /length and width/);
    assert.match((await refused('POST', L('laundry/orders/preview'), { locationId: shop.id, items: [item('Carpet', 'Carpet shampoo', { length: '8.555', width: '2' })] })).message, /decimal/);
    await request('PUT', L('laundry/settings'), { areaRounding: 'exact' });
    // Kept with its size and billed on one line that names it.
    const order = await take({ contactId: ravi.id, items: [item('Carpet', 'Carpet shampoo', { length: '8.5', width: '5.75' })] });
    assert.deepEqual([order.items[0].length_ft, order.items[0].width_ft, order.items[0].quantity, order.total], ['8.50', '5.75', '48.880', '1470.80']);
    await request('POST', L(`laundry/orders/${order.id}/status`), { status: 'ready' });
    const handed = await request('POST', L(`laundry/orders/${order.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const bill = await request('GET', L(`documents/${handed.deliveries[0].document_id}`));
    assert.deepEqual(bill.lines.map((l) => [l.label, l.quantity, l.net, l.tax]), [[`Carpet shampoo · Carpet 8.5 × 5.75 ft, 48.88 sq ft · tag ${order.items[0].tag_no}`, '1.000', '1246.44', '224.36']]);
  });

  await t.test('days per service: the promised day from the slowest garment, counted on the shop\'s open days', async () => {
    // The shop is closed on tomorrow's weekday; ordinary 3 days, express 1; dry cleaning takes 5 (express 2).
    const closed = weekday(addDays(today, 1));
    await request('PUT', L('laundry/settings'), { readyDays: '3', expressDays: '1', closedDays: [closed] });
    await request('PUT', L(`laundry/services/${svc['Dry cleaning'].id}`), { readyDays: '5', expressDays: '2' });
    assert.match((await refused('PUT', L(`laundry/services/${svc['Wash & iron'].id}`), { readyDays: '1', expressDays: '2' })).message, /no later than an ordinary one/);
    // Open days after today, tomorrow skipped: 2, 3, 4 … from today.
    const open = (n) => { let at = today; for (let left = n; left > 0;) { at = addDays(at, 1); if (weekday(at) !== closed) left -= 1; } return at; };
    assert.equal((await preview({ items: [item('Shirt', 'Wash & iron')] })).promisedOn, open(3));
    assert.equal((await preview({ items: [item('Shirt', 'Wash & iron'), item('Saree', 'Dry cleaning')] })).promisedOn, open(5), 'the slowest garment decides');
    assert.equal((await preview({ express: true, items: [item('Shirt', 'Wash & iron'), item('Saree', 'Dry cleaning')] })).promisedOn, open(2));
    assert.equal(open(3), addDays(today, 4), 'tomorrow, closed, is not counted');
    // Taken in without a promised day: the day worked out.
    const order = await take({ contactId: ravi.id, items: [item('Saree', 'Dry cleaning')] });
    assert.equal(order.promised_on, open(5));
    assert.match((await refused('PUT', L('laundry/settings'), { closedDays: [1, 2, 3, 4, 5, 6, 7] })).message, /open on at least one day/);
    await request('PUT', L('laundry/settings'), { closedDays: [] });
  });

  await t.test('discounts: by line and on the order with a reason, within the most discount and by the discount permission; offers kept as taken in', async () => {
    // Saree 350.00 less 5% (17.50), two shirts 2 × 40.00; ₹20 off the order spread by what each pays (392.35 and 94.40): 16.12 and 3.88,
    // before GST 13.66 and 3.29. Saree 318.84 + 57.39; shirts 76.71 + 13.81. Total 466.75.
    const body = { contactId: meena.id, items: [item('Saree', 'Dry cleaning', { discount: { percent: '5' } }), item('Shirt', 'Wash & iron', { quantity: '2' })],
      discount: { amount: '20', reason: 'Regular customer' } };
    assert.equal((await refused('POST', L('laundry/orders/preview'), { locationId: shop.id, ...body }, desk.token)).status, 403, 'the counter gives no discount without the permission');
    assert.match((await refused('POST', L('laundry/orders/preview'), { locationId: shop.id, ...body, discount: { amount: '20' } }, manager.token)).message, /Say why the discount is given/);
    const order = await take(body, manager.call);
    assert.deepEqual(order.items.map((i) => [i.discount_amount, i.amount, i.net, i.tax]), [['31.16', '318.84', '318.84', '57.39'], ['3.29', '76.71', '76.71', '13.81']]);
    assert.deepEqual([order.total, order.discount_amount, order.discount_reason], ['466.75', '20.00', 'Regular customer']);
    // Beyond the business's most (10% of 507.40): refused for a manager, allowed for the owner.
    const tooMuch = { contactId: meena.id, items: [item('Saree', 'Dry cleaning', { discount: { percent: '15' } })], discount: { reason: 'Festival' } };
    const over = await refused('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, ...tooMuch }, manager.token);
    assert.deepEqual([over.status, /At most 10% of a bill/.test(over.message)], [409, true]);
    assert.equal((await take(tooMuch)).items[0].discount_amount, '52.50');
    assert.match((await refused('POST', L('laundry/orders/preview'), { locationId: shop.id, items: [item('Shirt', 'Wash & iron', { discount: { amount: '100' } })], discount: { reason: 'x' } })).message,
      /more than it comes to/);
    // An offer: 20% off dry cleaning for ten days, taken off at intake and kept on the garment and its bill line.
    await request('PUT', L('modules/offers'), { enabled: true });
    const offer = await request('POST', L('offers'), { name: 'Monsoon dry cleaning', kind: 'item_percent', skuId: svc['Dry cleaning'].sku_id, value: '20', startsOn: today, endsOn: addDays(today, 10) }, 201);
    const offered = await take({ contactId: ravi.id, items: [item('Saree', 'Dry cleaning')] }, desk.call);
    assert.deepEqual([offered.items[0].offer_name, offered.items[0].offer_percent, offered.items[0].offer_amount, offered.items[0].amount, offered.total],
      ['Monsoon dry cleaning', '20.00', '70.00', '280.00', '330.40']);
    await pool.query('UPDATE retail_offers SET active=false WHERE id=$1', [offer.id]);
    await request('POST', L(`laundry/orders/${offered.id}/status`), { status: 'ready' });
    const handed = await desk.call('POST', L(`laundry/orders/${offered.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'upi' } });
    const bill = await request('GET', L(`documents/${handed.deliveries[0].document_id}`));
    assert.deepEqual([bill.lines[0].label, bill.lines[0].net, bill.total], [`Dry cleaning · Saree · offer Monsoon dry cleaning · tag ${offered.items[0].tag_no}`, '280.00', '330.40']);
    const audit = await one("SELECT details FROM business_audit WHERE business_id=$1 AND action='laundry_order.taken_in' AND entity_id=$2", [laundry.id, order.id]);
    assert.deepEqual([audit.details.discount, audit.details.discountReason], ['40.65', 'Regular customer']);
  });

  let kiloPlan, piecePlan, kilos;
  await t.test('packages: kilo and piece packages sold on a bill with GST, used at intake, given back on a cancellation, carried forward by the rule', async () => {
    // A plan is sold as its own service item (its price and GST slab).
    let plans = await request('POST', L('laundry/plans'), { name: 'Wash & fold 30 kg', unit: 'kg', quantity: '30', validityDays: '30', carryForward: 'up_to', carryMax: '5',
      carryDays: '7', serviceIds: [svc['Wash & fold'].id], price: '2499' }, 201);
    kiloPlan = plans.find((p) => p.name === 'Wash & fold 30 kg');
    assert.deepEqual([kiloPlan.unit, kiloPlan.quantity, kiloPlan.price, kiloPlan.tax_rate, kiloPlan.item_code], ['kg', '30.000', '2499.00', '18.00', 'LPK-01']);
    plans = await request('POST', L('laundry/plans'), { name: 'Ironing 50 pieces', unit: 'piece', quantity: '50', validityDays: '60', serviceIds: [svc['Wash & iron'].id], price: '1500' }, 201);
    piecePlan = plans.find((p) => p.name === 'Ironing 50 pieces');
    assert.equal((await refused('POST', L('laundry/plans'), { name: 'Half kilo', unit: 'piece', quantity: '2.5', validityDays: '10', serviceIds: [svc['Wash & iron'].id], price: '1' })).status, 400);
    // Sold to Asha: a bill of the plan's item (2,499.00 + 449.82 GST), paid now.
    const sale = { requestKey: key(), planId: kiloPlan.id, contactId: asha.id, locationId: shop.id, payment: { amount: 'full', method: 'upi', reference: 'UPI-PK1' } };
    kilos = await desk.call('POST', L('laundry/packages'), sale, 201);
    const bill = await request('GET', L(`documents/${kilos.document_id}`));
    assert.deepEqual([bill.total, bill.lines[0].label, bill.lines[0].tax, kilos.left_now, kilos.ends_on, kilos.price], ['2948.82', 'Wash & fold 30 kg', '449.82', '30.000', addDays(today, 29), '2948.82']);
    assert.equal((await desk.call('POST', L('laundry/packages'), sale, 201)).id, kilos.id, 'a retry is the same package');
    assert.equal((await refused('POST', L('laundry/packages'), { ...sale, contactId: meena.id }, desk.token)).status, 409);
    assert.equal((await refused('POST', L('laundry/packages'), { ...sale, requestKey: key() }, presser.token)).status, 403);
    // The plan's item is sold only as a package.
    const loose = await refused('POST', L('documents'), { requestKey: key(), kind: 'sale', locationId: shop.id, contactId: meena.id, lines: [{ skuId: kiloPlan.sku_id, quantity: '1' }] });
    assert.deepEqual([loose.status, /is a laundry package: sell it from Customers › Packages/.test(loose.message)], [409, true]);
    // Used at intake: 7.25 kg paid by the package; a 25 kg bundle takes the 22.75 kg left, the rest charged (2,247.50 × 2.25 / 25 = 202.27 + 36.41).
    const first = await take({ contactId: asha.id, items: [item('Mixed clothes', 'Wash & fold', { quantity: '7.25', pieces: '20', packageId: kilos.id })] }, desk.call);
    assert.deepEqual([first.items[0].package_quantity, first.items[0].package_amount, first.items[0].amount, first.total], ['7.250', '651.78', '0.00', '0.00']);
    const second = await take({ contactId: asha.id, items: [item('Mixed clothes', 'Wash & fold', { quantity: '25', pieces: '60', packageId: kilos.id })] }, desk.call);
    assert.deepEqual([second.items[0].package_quantity, second.items[0].base, second.items[0].package_amount, second.items[0].amount, second.items[0].tax],
      ['22.750', '2247.50', '2045.23', '202.27', '36.41']);
    assert.match((await refused('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, contactId: asha.id,
      items: [item('Mixed clothes', 'Wash & fold', { quantity: '1', pieces: '2', packageId: kilos.id })] }, desk.token)).message, /has nothing left/);
    // Another customer's package, a service it does not cover, or its unit's wrong garment: refused.
    assert.equal((await refused('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, contactId: meena.id,
      items: [item('Mixed clothes', 'Wash & fold', { quantity: '1', pieces: '2', packageId: kilos.id })] }, desk.token)).status, 404);
    // Handed over: the line the package paid for in part, charged for the rest.
    await presser.call('POST', L(`laundry/orders/${second.id}/status`), { status: 'ready' });
    const handed = await desk.call('POST', L(`laundry/orders/${second.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const charged = await request('GET', L(`documents/${handed.deliveries[0].document_id}`));
    assert.deepEqual([charged.lines[0].label, charged.lines[0].net, charged.total],
      [`Wash & fold · Mixed clothes 25 kg, 60 pieces · package · tag ${second.items[0].tag_no}`, '202.27', '238.68']);
    // Cancelled, the first bundle gives its 7.25 kg back; a package that was used is not cancelled.
    await request('POST', L(`laundry/orders/${first.id}/cancel`), { requestKey: key(), reason: 'Customer took the bundle home' });
    let now = await request('GET', L(`laundry/packages/${kilos.id}`));
    assert.deepEqual([now.left_now, now.used], ['7.250', '22.750']);
    assert.equal((await refused('POST', L(`laundry/packages/${kilos.id}/cancel`), { reason: 'x' })).status, 409);
    // A line that sold a package is credited only once the package is cancelled.
    const back = await refused('POST', L(`documents/${kilos.document_id}/returns`), { requestKey: key(), reason: 'No', lines: [{ lineId: bill.lines[0].id, quantity: '1', restock: false }] });
    assert.deepEqual([back.status, /sold a laundry package/.test(back.message)], [409, true]);
    // The next package, bought before the first ends: up to 5 kg of the 7.25 left is carried into it.
    const renewed = await desk.call('POST', L('laundry/packages'), { requestKey: key(), planId: kiloPlan.id, contactId: asha.id, locationId: shop.id }, 201);
    assert.deepEqual([renewed.carried_in, renewed.left_now], ['5.000', '35.000']);
    now = await request('GET', L(`laundry/packages/${kilos.id}`));
    assert.deepEqual([now.left_now, now.carried_on], ['2.250', '5.000']);
    assert.equal((await refused('POST', L(`laundry/packages/${renewed.id}/cancel`), { reason: 'x' })).status, 409, 'what was carried in stays');
    // A piece package: three shirts ironed under one tag draw three pieces.
    const pieces = await desk.call('POST', L('laundry/packages'), { requestKey: key(), planId: piecePlan.id, contactId: meena.id, locationId: shop.id }, 201);
    const ironed = await take({ contactId: meena.id, items: [item('Shirt', 'Wash & iron', { quantity: '3', packageId: pieces.id })] }, desk.call);
    assert.deepEqual([ironed.items[0].package_quantity, ironed.items[0].amount], ['3.000', '0.00']);
    assert.equal((await refused('POST', L('laundry/orders'), { requestKey: key(), locationId: shop.id, contactId: meena.id,
      items: [item('Mixed clothes', 'Wash & fold', { quantity: '1', pieces: '2', packageId: pieces.id })] }, desk.token)).status, 409, 'a piece package pays for garments by the piece');
    // An unused package is cancelled (a manager), and its line then credited from the bill.
    const spare = await desk.call('POST', L('laundry/packages'), { requestKey: key(), planId: piecePlan.id, contactId: ravi.id, locationId: shop.id, payment: { amount: 'full', method: 'cash' } }, 201);
    assert.equal((await refused('POST', L(`laundry/packages/${spare.id}/cancel`), { reason: 'Bought by mistake' }, desk.token)).status, 403);
    assert.equal((await manager.call('POST', L(`laundry/packages/${spare.id}/cancel`), { reason: 'Bought by mistake' })).status, 'cancelled');
    const spareBill = await request('GET', L(`documents/${spare.document_id}`));
    await request('POST', L(`documents/${spare.document_id}/returns`), { requestKey: key(), reason: 'Package cancelled', lines: [{ lineId: spareBill.lines[0].id, quantity: '1', restock: false }] }, 201);
    await assert.rejects(pool.query('DELETE FROM laundry_packages WHERE id=$1', [kilos.id]), /never deleted/);
    await assert.rejects(pool.query("UPDATE laundry_packages SET quantity=99 WHERE id=$1", [kilos.id]), /kept as it was sold/);
    const listed = await request('GET', L(`laundry/packages?contact=${asha.id}`));
    assert.equal(listed.total, 2);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='laundry_package.sold' AND entity_id=$2", [laundry.id, renewed.id]));
  });

  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2A0D5D10000000049454E44AE426082', 'hex');
  const upload = async (fields, token = ownerToken, bytes = png) => {
    const form = new FormData();
    for (const [field, value] of Object.entries(fields)) form.append(field, String(value));
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'photo.png');
    const response = await fetch(`${base}${L('laundry/files')}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  await t.test('photos and the signature at intake; the quality check with rewash and packing, each step with who and when', async () => {
    const order = await take({ contactId: ravi.id, items: [item('Saree', 'Dry cleaning', { defects: ['stain'], acknowledged: true }), item('Shirt', 'Wash & iron')] }, desk.call);
    const [saree, shirt] = order.items;
    // Photos at intake of a garment received, and the customer's signature drawn on the screen (once).
    assert.equal((await upload({ orderId: order.id, kind: 'photo', stage: 'intake', itemId: saree.id }, desk.token)).status, 201);
    assert.equal((await upload({ orderId: order.id, kind: 'signature' }, desk.token)).status, 201);
    assert.equal((await upload({ orderId: order.id, kind: 'signature' }, desk.token)).status, 409);
    assert.equal((await upload({ orderId: order.id, kind: 'photo', stage: 'intake', itemId: saree.id }, desk.token, Buffer.from('not a picture, only words here'))).status, 400);
    let now = await request('GET', L(`laundry/orders/${order.id}`));
    assert.deepEqual([now.signed, now.items[0].intake_photos, now.files.length], [true, 1, 2]);
    const opened = await fetch(`${base}${L(`laundry/files/${now.files[0].id}`)}`, { headers: { Authorization: `Bearer ${presser.token}` } });
    assert.deepEqual([opened.status, opened.headers.get('content-type'), opened.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
    await assert.rejects(pool.query('DELETE FROM laundry_files WHERE order_id=$1', [order.id]), /kept as it was taken/);
    // The shop requires the quality check and packing before the rack.
    await request('PUT', L('laundry/settings'), { qcRequired: true, packingRequired: true });
    await presser.call('POST', L(`laundry/orders/${order.id}/status`), { status: 'in_process' });
    assert.equal((await upload({ orderId: order.id, kind: 'photo', stage: 'intake', itemId: saree.id }, desk.token)).status, 409, 'an intake photo is of a garment received');
    const early = await refused('POST', L(`laundry/orders/${order.id}/status`), { status: 'ready' }, presser.token);
    assert.deepEqual([early.status, /passes its quality check before it is packed or ready/.test(early.message)], [409, true]);
    now = await presser.call('POST', L(`laundry/orders/${order.id}/status`), { status: 'qc' });
    assert.deepEqual(now.items.map((i) => i.status), ['qc', 'qc']);
    assert.equal((await upload({ orderId: order.id, kind: 'photo', stage: 'qc', itemId: saree.id }, presser.token)).status, 201);
    // The saree goes back to be washed again, with the reason; the shirt passes and is packed.
    assert.match((await refused('POST', L(`laundry/orders/${order.id}/qc`), { result: 'rewash', itemIds: [saree.id] }, presser.token)).message, /Say why/);
    now = await presser.call('POST', L(`laundry/orders/${order.id}/qc`), { result: 'rewash', itemIds: [saree.id], reason: 'Stain still showing' });
    assert.deepEqual([now.items[0].status, now.items[0].rewashes], ['in_process', 1]);
    now = await presser.call('POST', L(`laundry/orders/${order.id}/qc`), { result: 'pass', itemIds: [shirt.id] });
    assert.deepEqual([now.items[1].status, now.items[1].qc_by_name, now.items[1].packed_by_name], ['packed', 'press-work', 'press-work']);
    assert.ok(now.items[1].qc_at && now.items[1].packed_at);
    now = await presser.call('POST', L(`laundry/orders/${order.id}/status`), { status: 'ready', itemIds: [shirt.id], rack: 'q-1' });
    assert.deepEqual([now.items[1].status, now.items[1].rack, now.status], ['ready', 'Q-1', 'part_ready']);
    // The saree again: to QC, passed, packed, ready.
    await presser.call('POST', L(`laundry/orders/${order.id}/status`), { status: 'qc', itemIds: [saree.id] });
    await presser.call('POST', L(`laundry/orders/${order.id}/qc`), { result: 'pass' });
    now = await presser.call('POST', L(`laundry/orders/${order.id}/status`), { status: 'ready', rack: 'Q-2' });
    assert.equal(now.status, 'ready');
    const steps = now.events.filter((e) => e.item_id === saree.id && e.to_status).map((e) => `${e.from_status}>${e.to_status}`);
    assert.deepEqual(steps, ['received>in_process', 'in_process>qc', 'qc>in_process', 'in_process>qc', 'qc>packed', 'packed>ready']);
    assert.ok(now.events.every((e) => e.by_name && e.created_at), 'each step has who and when');
    await assert.rejects(pool.query("UPDATE laundry_order_items SET rewashes=5 WHERE id=$1", [saree.id]), /washed again from its quality check/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='laundry_order.quality_checked' AND entity_id=$2", [laundry.id, order.id]));
    await request('PUT', L('laundry/settings'), { qcRequired: false, packingRequired: false });
  });

  await t.test('changing a garment before its work starts, its bill adjusted through the core; garments added to an open order; pieces handed over one by one', async () => {
    await request('PUT', L('laundry/settings'), { billAt: 'intake', partDelivery: 'whole_order' });
    // Billed at intake and paid: Meena's own price for a shirt dry cleaned 95.00 + 17.10, saree 350.00 + 63.00 = 525.10.
    const order = await take({ contactId: meena.id, items: [item('Shirt', 'Dry cleaning'), item('Saree', 'Dry cleaning')], payment: { amount: 'full', method: 'upi', reference: 'UPI-77' } }, desk.call);
    assert.deepEqual([order.total, order.bills[0].paid, order.due], ['525.10', '525.10', '0.00']);
    const [shirt] = order.items;
    const change = { requestKey: key(), serviceId: svc['Wash & iron'].id, reason: 'Customer asked for a wash instead' };
    const C = L(`laundry/orders/${order.id}/items/${shirt.id}/change`);
    assert.equal((await refused('POST', C, change, desk.token)).status, 403, 'a manager changes a garment');
    let now = await manager.call('POST', C, change);
    const changed = now.items[0];
    // The old line credited in full (112.10), the shirt billed again at 40.00 + 7.20, paid from what was paid on the old bill (64.90 is left there to her credit).
    assert.deepEqual([changed.service_name, changed.rate, changed.net, changed.tax, changed.status], ['Wash & iron', '40.00', '40.00', '7.20', 'received']);
    assert.notEqual(changed.document_id, order.document_id);
    assert.deepEqual(now.bills.map((b) => [b.total, b.returned, b.paid, b.refunded, b.due]), [['525.10', '112.10', '525.10', '47.20', '-64.90'], ['47.20', '0', '47.20', '0', '0.00']]);
    const moved = await rows("SELECT method,amount FROM business_payments WHERE document_id=$1", [changed.document_id]);
    assert.deepEqual(moved.map((p) => [p.method, p.amount]), [['credit_note', '47.20']]);
    assert.deepEqual([now.total, now.changes.length, now.changes[0].was.service, now.changes[0].became.service], ['460.20', 1, 'Dry cleaning', 'Wash & iron']);
    assert.equal((await manager.call('POST', C, change)).changes.length, 1, 'a retry is the same change');
    assert.equal((await refused('POST', C, { ...change, reason: 'Other' }, manager.token)).status, 409);
    // A typed price; once in the work, the garment no longer changes.
    now = await manager.call('POST', C, { requestKey: key(), price: '35', reason: 'Old customer' });
    assert.deepEqual([now.items[0].rate, now.items[0].price_source, now.items[0].net], ['35.00', 'manual', '35.00']);
    await presser.call('POST', L(`laundry/orders/${order.id}/status`), { status: 'in_process', itemIds: [shirt.id] });
    assert.equal((await refused('POST', C, { requestKey: key(), quantity: '2', reason: 'More' }, manager.token)).status, 409);
    await assert.rejects(pool.query("UPDATE laundry_order_items SET rate=1 WHERE id=$1", [shirt.id]), /keeps what was noted and priced/);
    // Garments added to the open order, priced as at intake and billed on a bill of their own.
    const add = { requestKey: key(), items: [item('Suit (3 piece)', 'Dry cleaning')], payment: { amount: 'full', method: 'cash' } };
    now = await desk.call('POST', L(`laundry/orders/${order.id}/items`), add, 201);
    const suit = now.items.find((i) => i.garment_name === 'Suit (3 piece)');
    assert.deepEqual([suit.seq, suit.pieces, suit.net, suit.tax, suit.added_by_name, now.bills.length], [3, 3, '600.00', '108.00', 'press-desk', 4]);
    assert.equal((await desk.call('POST', L(`laundry/orders/${order.id}/items`), add, 201)).items.length, 3, 'a retry adds nothing more');
    // The suit's three pieces leave one by one: one now, then the other two.
    await presser.call('POST', L(`laundry/orders/${order.id}/status`), { status: 'ready', itemIds: [suit.id] });
    assert.match((await refused('POST', L(`laundry/orders/${order.id}/deliver`), { requestKey: key(), itemIds: [suit.id], pieces: { [suit.id]: 4 } }, desk.token)).message, /from 1 to 3/);
    const piece = { requestKey: key(), itemIds: [suit.id], pieces: { [suit.id]: 1 }, collectedBy: 'Driver' };
    now = await desk.call('POST', L(`laundry/orders/${order.id}/deliver`), piece);
    const half = now.items.find((i) => i.id === suit.id);
    assert.deepEqual([half.status, half.pieces_delivered, now.status, now.deliveries.at(-1).tags], ['ready', 1, 'part_delivered', [`${suit.tag_no} (1 of 3)`]]);
    assert.equal((await desk.call('POST', L(`laundry/orders/${order.id}/deliver`), piece)).deliveries.length, now.deliveries.length, 'a retry is the same handover');
    assert.equal((await refused('POST', L(`laundry/orders/${order.id}/cancel`), { requestKey: key(), reason: 'x', itemIds: [suit.id] })).status, 409);
    now = await desk.call('POST', L(`laundry/orders/${order.id}/deliver`), { requestKey: key(), itemIds: [suit.id] });
    assert.deepEqual([now.items.find((i) => i.id === suit.id).status, now.deliveries.at(-1).tags], ['delivered', [`${suit.tag_no} (2 of 3)`]]);
    // An order with nothing left in the shop takes no more garments.
    const done = await take({ contactId: ravi.id, items: [item('Shirt', 'Wash & iron')], payment: { amount: 'full', method: 'cash' } }, desk.call);
    await request('POST', L(`laundry/orders/${done.id}/status`), { status: 'ready' });
    await desk.call('POST', L(`laundry/orders/${done.id}/deliver`), { requestKey: key() });
    assert.equal((await refused('POST', L(`laundry/orders/${done.id}/items`), { requestKey: key(), items: [item('Shirt', 'Wash & iron')] }, desk.token)).status, 409);
    // Billed at delivery, a garment changed is simply re-priced; garments added wait for the handover's bill.
    await request('PUT', L('laundry/settings'), { billAt: 'delivery' });
    const later = await take({ contactId: ravi.id, items: [item('Shirt', 'Wash & iron', { quantity: '2' })] }, desk.call);
    now = await manager.call('POST', L(`laundry/orders/${later.id}/items/${later.items[0].id}/change`), { requestKey: key(), quantity: '3', reason: 'One more shirt in the bag' });
    assert.deepEqual([now.items[0].quantity, now.items[0].pieces, now.items[0].net, now.total, now.bills.length], ['3.000', 3, '120.00', '141.60', 0]);
    now = await desk.call('POST', L(`laundry/orders/${later.id}/items`), { requestKey: key(), items: [item('Saree', 'Dry cleaning')] }, 201);
    assert.deepEqual([now.items.length, now.total, now.bills.length], [2, '554.60', 0]);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='laundry_order.garment_changed' AND entity_id=$2", [laundry.id, order.id]));
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='laundry_order.garments_added' AND entity_id=$2", [laundry.id, order.id]));
  });

  await t.test('claims added up by service, by who took the garment in and by month, with the compensation paid', async () => {
    const order = await take({ contactId: asha.id, items: [item('Saree', 'Dry cleaning'), item('Shirt', 'Wash & iron'), item('Shirt', 'Dry cleaning')] }, desk.call);
    await presser.call('POST', L(`laundry/orders/${order.id}/status`), { status: 'ready' });
    await desk.call('POST', L(`laundry/orders/${order.id}/deliver`), { requestKey: key(), payment: { amount: 'full', method: 'cash' } });
    const claim = async (itemId, issue) => (await desk.call('POST', L(`laundry/orders/${order.id}/claims`), { requestKey: key(), itemId, issue, description: 'Customer says so' }, 201)).claims.at(-1);
    const [saree, shirtA, shirtB] = order.items;
    const c1 = await claim(saree.id, 'colour_run');
    await request('POST', L(`laundry/claims/${c1.id}/decide`), { requestKey: key(), decision: 'refund', amount: '150', refund: { method: 'cash' }, approval });
    const c2 = await claim(shirtA.id, 'stain');
    await request('POST', L(`laundry/claims/${c2.id}/decide`), { requestKey: key(), decision: 'rejected', note: 'Stain noted at intake' });
    const c3 = await claim(shirtB.id, 'damage');
    await request('POST', L(`laundry/claims/${c3.id}/decide`), { requestKey: key(), decision: 'credit', amount: '20.50' });
    await claim(saree.id, 'lost');
    const byService = await request('GET', L('laundry/claims/report?by=service'));
    const dry = byService.rows.find((r) => r.key === 'Dry cleaning');
    assert.deepEqual([dry.claims, dry.waiting, dry.refunds, dry.credits, dry.compensation, dry.refunded], [3, 1, 1, 1, '170.50', '150.00']);
    assert.deepEqual([byService.totals.claims, byService.totals.rejected, byService.totals.compensation], [4, 1, '170.50']);
    const byStaff = await request('GET', L(`laundry/claims/report?by=staff&from=${today}&to=${today}`));
    assert.deepEqual(byStaff.rows.map((r) => [r.key, r.claims]), [['press-desk', 4]]);
    const byMonth = await desk.call('GET', L('laundry/claims/report?by=month'));
    assert.deepEqual([byMonth.rows[0].key, byMonth.rows[0].claims], [today.slice(0, 7), 4]);
    const hidden = await presser.call('GET', L('laundry/claims/report'));
    assert.deepEqual([hidden.money, hidden.rows[0].compensation], [false, null], 'no money for someone who does not see sales');
    assert.equal((await refused('GET', L(`laundry/claims/report?from=${today}&to=${addDays(today, -1)}`))).status, 400);
  });

  await t.test('another type is kept out of the new routes', async () => {
    assert.equal((await refused('GET', `/businesses/${grocery.id}/laundry/plans`)).status, 403);
    assert.equal((await refused('GET', `/businesses/${grocery.id}/laundry/claims/report`)).status, 403);
    assert.equal((await refused('POST', `/businesses/${grocery.id}/laundry/groups`, { name: 'x' })).status, 404);
    const form = new FormData();
    form.append('orderId', '1'); form.append('kind', 'signature');
    form.append('file', new Blob([png], { type: 'image/png' }), 'sign.png');
    const response = await fetch(`${base}/businesses/${grocery.id}/laundry/files`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` }, body: form });
    assert.equal(response.status, 404);
  });
});
