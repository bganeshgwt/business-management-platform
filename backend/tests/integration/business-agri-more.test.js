const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { createBusinesses } = require('./helpers/businesses');
const { daysFrom, momentAt } = require('./helpers/dates');
const { signIn } = require('./helpers/signIn');

// The rest of the seeds, fertilisers & pesticides shop: crops in groups and
// the shop's own crops, label-approved crops, restricted-use pesticides
// (tagged buyers, a manager's override, carbofuran 3% CG only), seed lots
// with their tags and retests, a farmer's subsidised bags in a month, stock
// kept apart (expired, seized, sampled), food or feed at a location, Form
// XIII, Form XIV and the sulphur buyers' register with the returns sent and
// the bell, the board of a day gone by at that day's prices, season credit
// (its limit, terms, interest to the paisa and produce taken against it),
// a quotation's bill on a season, company schemes and the advisory line.
// Refusals with their status, idempotent retries, the rules the database
// keeps, audit and events, other types and other owners. Runs on its own
// throwaway database with every migration applied.
test('the rest of the seeds, fertilisers & pesticides shop', { timeout: 600000 }, async (t) => {
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
  process.env.DB_POOL_GUARD = 'throw';
  const { runner } = await import('node-pg-migrate');
  const dir = path.resolve(__dirname, '../../migrations');
  const migrate = (options) => runner({ databaseUrl: { ...connection, database }, dir, migrationsTable: 'pgmigrations', checkOrder: true, log() {}, ...options });
  await migrate({ direction: 'up', count: Infinity });

  await t.test('the Down half takes this migration away and Up brings it back', async () => {
    scratch = new Client({ ...connection, database });
    await scratch.connect();
    const tables = ['agri_crop_groups', 'agri_shop_crops', 'agri_buyer_tags', 'agri_overrides', 'agri_seed_lots', 'agri_seed_retests', 'agri_seed_qr_codes', 'agri_stock_holds',
      'agri_food_locations', 'agri_bag_limits', 'agri_season_credits', 'agri_season_interest', 'agri_produce_receipts', 'agri_produce_payments', 'agri_schemes',
      'agri_scheme_items', 'agri_scheme_benefits', 'agri_scheme_claims', 'agri_returns_filed', 'business_price_history'];
    const left = async () => (await scratch.query('SELECT count(*)::int AS n FROM pg_tables WHERE tablename = ANY($1)', [tables])).rows[0].n;
    const column = async (table, name) => (await scratch.query('SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, name])).rows[0].n;
    assert.equal(await left(), tables.length);
    const stamp = Number(fs.readdirSync(dir).find((file) => file.endsWith('_agri-more.sql')).split('_')[0]);
    await migrate({ direction: 'down', count: stamp, timestamp: true });
    assert.equal(await left(), 0);
    for (const [table, name] of [['agri_crops', 'is_group'], ['agri_molecules', 'users_only'], ['agri_settings', 'restricted_use'], ['agri_bills', 'season_credit_id'],
      ['agri_sale_lines', 'advisory']]) assert.equal(await column(table, name), 0, `${table}.${name} is gone`);
    assert.equal((await scratch.query("SELECT count(*)::int AS n FROM business_permissions WHERE code='agri.approve'")).rows[0].n, 0);
    assert.equal((await scratch.query("SELECT count(*)::int AS n FROM agri_crops WHERE code IN ('fruits','pulses','cereals','oilseeds')")).rows[0].n, 0);
    await migrate({ direction: 'up', count: Infinity });
    assert.equal(await left(), tables.length);
  });

  pool = require('../../src/config/database');
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const rows = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const password = `AgriMore-${crypto.randomBytes(8).toString('hex')}`;
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
  const ownerUser = await owner('more-owner');
  await owner('more-other');
  const as = (auth) => async (method, route, body, expected = 200) => {
    const result = await call(method, route, body, auth);
    assert.equal(result.status, expected, `${method} ${route}: ${JSON.stringify(result.body)}`);
    return result.body.data ?? result.body;
  };
  const ownerToken = await login('more-owner@test.invalid');
  const request = as(ownerToken);
  const other = as(await login('more-other@test.invalid'));
  // The status, the sentence and the data of a refusal.
  const refused = async (method, route, body, auth = ownerToken) => {
    const result = await call(method, route, body, auth);
    return { status: result.status, message: result.body.message, data: result.body.data };
  };

  const [agri, grocery] = await createBusinesses(request, 'MORE', ['agri_inputs', 'grocery']);
  const [otherAgri] = await createBusinesses(other, 'OTHERMORE', ['agri_inputs']);
  const A = (suffix) => `/businesses/${agri.id}/${suffix}`;
  const key = () => crypto.randomUUID();
  const paise = (value) => Math.round(Number(value) * 100);
  const year = Number(daysFrom(0).slice(0, 4));
  const audited = (action, entityId) => one('SELECT details FROM business_audit WHERE business_id=$1 AND action=$2 AND entity_id=$3 ORDER BY id DESC LIMIT 1', [agri.id, action, entityId]);
  const evented = async (kind, entityId) => (await one('SELECT payload FROM business_events WHERE business_id=$1 AND kind=$2 AND entity_id=$3 ORDER BY id DESC LIMIT 1', [agri.id, kind, entityId]))?.payload;
  // These bills are checked for every rule but the licences (business-agri.test.js and licences-hardware.test.js check those).
  await request('PUT', A('modules/licences'), { enabled: false });
  await request('PUT', A('modules/stock_transfers'), { enabled: true });
  const shop = (await request('GET', A('locations'))).items[0];
  const slabs = (await request('GET', A('tax-rates'))).items;
  const gst5 = slabs.find((r) => Number(r.rate) === 5), gst18 = slabs.find((r) => Number(r.rate) === 18), nil = slabs.find((r) => Number(r.rate) === 0);
  const roles = (await request('GET', A('roles?limit=100'))).items;
  async function staff(email, template) {
    const user = await one('INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [ownerUser.restaurant_id, email.split('@')[0], email, hash]);
    await request('POST', A('members'), { userId: user.id, roleId: roles.find((r) => r.template_code === template).id }, 201);
    return { id: user.id, token: await login(email), call: as(await login(email)) };
  }
  const manager = await staff('more-manager@test.invalid', 'manager');
  await pool.query('UPDATE users SET pin_hash=$2,pin_set_at=now() WHERE id=$1', [manager.id, await bcrypt.hash('2580', 4)]);
  const cashierUser = await staff('more-cashier@test.invalid', 'cashier');
  const cashier = cashierUser.call;
  const keeper = (await staff('more-keeper@test.invalid', 'stock_keeper')).call;
  const accountant = (await staff('more-accountant@test.invalid', 'accountant')).call;
  const viewer = (await staff('more-viewer@test.invalid', 'viewer')).call;

  const opening = (quantity, unitCost, extra = {}) => ({ openingStock: { quantity, unitCost, locationId: shop.id, ...extra } });
  const goods = (body, expected = 201) => request('POST', A('catalog'), { kind: 'goods', tracking: 'quantity', taxRateId: gst5.id, ...body }, expected);
  const pesticide = (name, code, molecules, formulation, extra = {}) => goods({ name, code, unit: 'bottle', tracking: 'batch', price: '310', taxRateId: gst18.id,
    attributes: { inputKind: 'pesticide', molecules, formulation, ...(extra.attributes || {}) }, ...opening('30', '240', { lotCode: `${code}-L1`, expiresOn: daysFrom(400) }), ...(extra.body || {}) });
  const cash = { payment: { amount: 'full', method: 'cash' } };
  const sale = (body, expected = 201, by = request) => by('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...body }, expected);
  const bill = (body) => refused('POST', A('documents'), { kind: 'sale', requestKey: key(), locationId: shop.id, ...body });
  const sqlDay = async (sql, values) => (await one(sql, values)).d;

  // Items and customers the subtests share.
  const urea = await goods({ name: 'Neem coated urea 45 kg', code: 'UREA-45', unit: 'bag', price: '266.50', mrp: '266.50', hsnCode: '3102',
    attributes: { inputKind: 'fertiliser', subsidised: true, netKg: '45' }, ...opening('200', '242') });
  const manure = await goods({ name: 'Organic manure 50 kg', code: 'MANURE-50', unit: 'bag', price: '500', taxRateId: nil.id,
    attributes: { inputKind: 'fertiliser', netKg: '50' }, ...opening('400', '420') });
  const dap = await goods({ name: 'DAP 18:46:0 50 kg', code: 'DAP-50', unit: 'bag', price: '1350', mrp: '1350', hsnCode: '3105', attributes: { inputKind: 'fertiliser', netKg: '50' } });
  const ramaiah = await request('POST', A('agri/farmers'), { name: 'Ramaiah Goud', phone: '9848012345', village: 'Kothur', relativeName: 'Venkaiah Goud', landAcres: '3.5' }, 201);
  const lakshmi = await request('POST', A('agri/farmers'), { name: 'Lakshmi Bai', village: 'Kothur' }, 201);
  const shankar = await request('POST', A('agri/farmers'), { name: 'Shankar Reddy', village: 'Madgul' }, 201);

  await t.test('approving is a manager\'s: overrides, season credit terms and its interest', async () => {
    const grants = async (template) => (await one(`SELECT COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code),'{}') AS p FROM business_role_permissions rp
      JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code=$2 AND rp.permission_code='agri.approve'`, [agri.id, template])).p;
    assert.deepEqual(await grants('manager'), ['agri.approve']);
    for (const template of ['cashier', 'stock_keeper', 'accountant', 'viewer']) assert.deepEqual(await grants(template), [], `${template} does not approve`);
    assert.equal((await one("SELECT count(*)::int AS n FROM business_role_permissions rp JOIN business_roles r ON r.business_id=rp.business_id AND r.id=rp.role_id WHERE r.business_id=$1 AND r.template_code='manager' AND rp.permission_code='agri.approve'", [grocery.id])).n, 1,
      'role copies match their templates everywhere');
  });

  // --- Crops in groups -------------------------------------------------------------------------
  let mono, malathion, tomato;
  await t.test('crops in groups: a ban on a group catches each crop in it, the shop\'s own crops too', async () => {
    const listed = await request('GET', A('agri/crops'));
    const byKey = (k) => listed.crops.find((c) => c.key === k);
    assert.deepEqual(listed.crops.filter((c) => c.is_group).map((c) => c.code).sort(), ['cereals', 'fruits', 'fruits_vegetables_raw', 'oilseeds', 'pulses', 'vegetables']);
    assert.deepEqual([byKey('potato').groups, byKey('guava').groups, byKey('soybean').groups, byKey('sorghum').groups], [['vegetables'], ['fruits'], ['oilseeds'], ['cereals']]);
    mono = await pesticide('Monocrotophos 36% SL 500 ml', 'MONO-500', ['Monocrotophos'], '36% SL');
    malathion = await pesticide('Malathion 50% EC 500 ml', 'MAL-500', ['malathion'], '50% EC');
    // The shop's own crop, with another name and its groups (a cashier keeps farmers, so crops too).
    const added = await cashier('POST', A('agri/crops'), { name: '  Tomato ', aliases: ['tamatar'], groups: ['vegetables', 'fruits_vegetables_raw'] }, 201);
    tomato = added.crops.find((c) => c.name === 'Tomato');
    assert.deepEqual([tomato.own, tomato.shop_aliases, tomato.shop_groups], [true, ['tamatar'], ['vegetables', 'fruits_vegetables_raw']]);
    assert.deepEqual((await audited('crop.added', tomato.shop_crop_id)).details, { crop: 'Tomato', aliases: ['tamatar'], groups: ['vegetables', 'fruits_vegetables_raw'] });
    // Other names and a group for one of the platform's crops.
    const pea = (await cashier('POST', A('agri/crops'), { cropCode: 'pea', aliases: ['matar'], groups: ['vegetables', 'pulses'] }, 201)).crops.find((c) => c.code === 'pea');
    assert.deepEqual([pea.groups, pea.shop_aliases, pea.shop_groups], [['pulses'], ['matar'], ['vegetables']], 'a group it is in already is not added again');
    // Refusals: a name taken, a group put in a group, not a group, two kinds at once, a name changed, the wrong role.
    assert.equal((await refused('POST', A('agri/crops'), { name: 'potato' })).status, 409);
    const clash = await refused('POST', A('agri/crops'), { name: 'Brinjal', aliases: ['Tamatar'] });
    assert.deepEqual([clash.status, clash.message], [409, 'Tamatar already names Tomato']);
    assert.equal((await refused('POST', A('agri/crops'), { cropCode: 'vegetables', aliases: ['sabzi'] })).status, 400);
    assert.equal((await refused('POST', A('agri/crops'), { name: 'Okra', groups: ['potato'] })).status, 400);
    assert.equal((await refused('POST', A('agri/crops'), { name: 'Okra', cropCode: 'pea' })).status, 400);
    assert.equal((await refused('POST', A('agri/crops'), { cropCode: 'pea', aliases: ['mattar'] })).status, 409, 'its additions are changed, not added twice');
    assert.equal((await refused('PUT', A(`agri/crops/${tomato.shop_crop_id}`), { name: 'Tomatoes', aliases: ['tamatar'], groups: ['vegetables'] })).status, 400);
    await viewer('POST', A('agri/crops'), { name: 'Okra' }, 403);
    const changed = await request('PUT', A(`agri/crops/${tomato.shop_crop_id}`), { aliases: ['tamatar', 'tamata'], groups: ['vegetables', 'fruits_vegetables_raw'] });
    assert.deepEqual(changed.crops.find((c) => c.name === 'Tomato').shop_aliases, ['tamatar', 'tamata']);

    // A molecule barred on a group: refused for its crops, by any of their names.
    const forCrop = (sku, crop) => bill({ ...cash, agri: { crop }, lines: [{ skuId: sku.id, quantity: '1', lotCode: `${sku.code}-L1` }] });
    let answer = await forCrop(mono, 'tamata');
    assert.deepEqual([answer.status, answer.message], [409,
      'Monocrotophos must not be used on vegetables (tomato is one): Monocrotophos 36% SL 500 ml cannot be sold for it (S.O. 4294(E), 3 October 2023).']);
    answer = await forCrop(mono, 'Matar');
    assert.match(answer.message, /^Monocrotophos must not be used on vegetables \(pea is one\)/, 'through the group the shop added');
    assert.match((await forCrop(malathion, 'matar')).message, /^Malathion must not be used on pea:/, 'the platform\'s crop by the shop\'s other name');
    assert.match((await forCrop(mono, 'Potato')).message, /^Monocrotophos must not be used on vegetables \(potato is one\)/, 'the platform\'s own groups');
    const paddy = await sale({ ...cash, agri: { crop: 'Paddy' }, lines: [{ skuId: mono.id, quantity: '1', lotCode: 'MONO-500-L1' }] });
    assert.deepEqual(await one('SELECT crop,crop_code,shop_crop_id FROM agri_sale_lines WHERE document_id=$1', [paddy.id]), { crop: 'Paddy', crop_code: null, shop_crop_id: null });
    // A shop's crop is kept on the line; switched off, it is no longer matched.
    const forTomato = await sale({ ...cash, agri: { crop: 'Tomato' }, lines: [{ skuId: malathion.id, quantity: '1', lotCode: 'MAL-500-L1' }] });
    assert.deepEqual(await one('SELECT crop,crop_code,shop_crop_id FROM agri_sale_lines WHERE document_id=$1', [forTomato.id]), { crop: 'Tomato', crop_code: null, shop_crop_id: tomato.shop_crop_id });
    await request('PUT', A(`agri/crops/${tomato.shop_crop_id}`), { aliases: ['tamatar'], groups: ['vegetables', 'fruits_vegetables_raw'], active: false });
    assert.ok(await audited('crop.switched_off', tomato.shop_crop_id));
    await sale({ ...cash, agri: { crop: 'tamatar' }, lines: [{ skuId: mono.id, quantity: '1', lotCode: 'MONO-500-L1' }] });
    await request('PUT', A(`agri/crops/${tomato.shop_crop_id}`), { aliases: ['tamatar'], groups: ['vegetables', 'fruits_vegetables_raw'], active: true });
    // The database holds the same rule where the line is kept, and keeps the crops.
    const plain = await sale({ ...cash, lines: [{ skuId: manure.id, quantity: '1' }] });
    const line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [plain.id]);
    await assert.rejects(pool.query(`INSERT INTO agri_sale_lines(business_id,line_id,document_id,sku_id,input_kind,crop,shop_crop_id,molecules)
      VALUES($1,$2,$3,$4,'pesticide','Tomato',$5,'{Monocrotophos}')`, [agri.id, line.id, plain.id, mono.id, tomato.shop_crop_id]), /Monocrotophos must not be used on vegetables/);
    await assert.rejects(pool.query('DELETE FROM agri_shop_crops WHERE id=$1', [tomato.shop_crop_id]), /never deleted; switch it off/);
    await assert.rejects(pool.query("UPDATE agri_shop_crops SET groups='{potato}' WHERE id=$1", [tomato.shop_crop_id]), /only into the groups on the list/);
    // The counter's list carries the shop's crops with their groups.
    const master = await cashier('GET', A('agri/molecules'));
    assert.deepEqual(master.crops.find((c) => c.key === `shop-${tomato.shop_crop_id}`).groups, ['vegetables', 'fruits_vegetables_raw']);
    assert.deepEqual(master.crops.find((c) => c.key === 'pea').aliases, ['peas', 'matar']);
  });

  // --- Label-approved crops and the advisory line -------------------------------------------------
  let imida;
  await t.test('a pesticide\'s label names its crops: another crop warns; the advisory line prints when switched on', async () => {
    imida = await pesticide('Imidacloprid 17.8% SL 250 ml', 'IMI-250', ['Imidacloprid'], '17.8% SL', { attributes: { approvedCrops: ['cotton', ' vegetables', 'Chilli'],
      dosePerAcre: '100 ml in 200 L water', safetyDays: '15', ppe: 'gloves and a mask', manufacturer: 'Bayer CropScience' } });
    assert.deepEqual(imida.attributes.approvedCrops, ['cotton', 'Vegetables', 'Chilli'], 'a crop on the list takes its spelling');
    assert.deepEqual([imida.attributes.safetyDays, imida.attributes.ppe], ['15', 'gloves and a mask']);
    // Each belongs to a pesticide; a safety interval is whole days.
    await goods({ name: 'Zinc sulphate', code: 'ZN-1', unit: 'bag', price: '400', attributes: { inputKind: 'fertiliser', approvedCrops: ['Paddy'] } }, 400);
    await goods({ name: 'Zinc sulphate', code: 'ZN-2', unit: 'bag', price: '400', attributes: { inputKind: 'fertiliser', dosePerAcre: '10 kg' } }, 400);
    assert.equal((await refused('POST', A('catalog'), { kind: 'goods', tracking: 'batch', name: 'Acephate 75% SP', code: 'ACE-1', unit: 'bottle', price: '100', taxRateId: gst18.id,
      attributes: { inputKind: 'pesticide', molecules: ['Acephate'], safetyDays: '1.5' } })).status, 400);
    assert.equal((await refused('POST', A('catalog'), { kind: 'goods', tracking: 'batch', name: 'Acephate', code: 'ACE-2', unit: 'bottle', price: '100', taxRateId: gst18.id,
      attributes: { inputKind: 'pesticide', molecules: ['Acephate'], safetyDays: 'two weeks' } })).status, 400);
    const line = [{ skuId: imida.id, quantity: '1', lotCode: 'IMI-250-L1' }];
    // A crop in a group on the label: no warning. Another crop: billed with a warning, kept on the line.
    const tomatoBill = await sale({ ...cash, agri: { crop: 'tamatar' }, lines: line });
    assert.equal(tomatoBill.warnings, undefined);
    const paddyBill = await sale({ ...cash, agri: { crop: 'Paddy' }, lines: line });
    assert.deepEqual(paddyBill.warnings, ['Imidacloprid 17.8% SL 250 ml is not approved on its label for Paddy (its label names cotton, Vegetables and Chilli).']);
    assert.deepEqual((await audited('sale.posted', paddyBill.id)).details.warnings, paddyBill.warnings);
    assert.deepEqual(await one('SELECT off_label,advisory FROM agri_sale_lines WHERE document_id=$1', [paddyBill.id]), { off_label: true, advisory: null });
    await sale({ ...cash, lines: line }, 201);
    // The counter asks ahead: the same warning.
    const notes = await cashier('POST', A('agri/counter-check'), { locationId: shop.id, crop: 'Paddy', lines: [{ skuId: imida.id, quantity: '1' }] });
    assert.deepEqual(notes.notes.map((n) => [n.kind, n.level]), [['label', 'warn']]);
    // The advisory line, switched on: kept with the line as printed and shown on the bill.
    await cashier('PUT', A('agri/settings'), { advisoryOn: true }, 403);
    const set = await request('PUT', A('agri/settings'), { advisoryOn: true });
    assert.deepEqual([set.advisoryOn, set.changed], [true, ['advisoryOn']]);
    const advised = await sale({ ...cash, agri: { crop: 'Cotton' }, lines: line });
    const shown = await request('GET', A(`documents/${advised.id}`));
    assert.equal(shown.agri.lines[0].advisory, 'Dose 100 ml in 200 L water per acre; wait 15 days before harvest; wear gloves and a mask');
    await request('PUT', A('agri/settings'), { advisoryOn: false });
  });

  // --- Restricted use ------------------------------------------------------------------------------
  let alp, pco;
  await t.test('restricted use: tagged buyers, a manager\'s override, carbofuran only as 3% CG', async () => {
    alp = await pesticide('Aluminium phosphide 56% FU 10 tablets', 'ALP-10', ['Aluminium phosphide'], '56% FU');
    const cyp = await pesticide('Cypermethrin 10% EC 500 ml', 'CYP-10', ['Cypermethrin'], '10% EC');
    const smoke = await pesticide('Cypermethrin 3% smoke generator', 'CYP-SG', ['Cypermethrin'], '3% Smoke generator');
    const alpLine = [{ skuId: alp.id, quantity: '1', lotCode: 'ALP-10-L1' }];
    // Stopped for a buyer not tagged, as the shop's setting says (stop, to start with).
    let answer = await bill({ ...cash, lines: alpLine });
    assert.equal(answer.status, 409);
    assert.equal(answer.message, 'Aluminium phosphide 56% FU 10 tablets contains Aluminium phosphide, which goes only to pest-control operators and government bodies '
      + '(used only by government bodies or approved pest-control experts): choose the customer tagged as one.');
    assert.deepEqual(answer.data, { reason: 'restricted_use', override: false, skuIds: [alp.id] });
    // The cypermethrin smoke generator only, not its 10% EC.
    await sale({ ...cash, lines: [{ skuId: cyp.id, quantity: '1', lotCode: 'CYP-10-L1' }] });
    assert.equal((await bill({ ...cash, lines: [{ skuId: smoke.id, quantity: '1', lotCode: 'CYP-SG-L1' }] })).status, 409);
    // No override while the shop stops them.
    const ask = (body, token = cashierUser.token) => refused('POST', A('agri/overrides'), { requestKey: key(), kind: 'restricted_use', locationId: shop.id, skuIds: [alp.id],
      approval: { approverId: manager.id, pin: '2580', reason: 'Fumigation of the godown by the cold storage owner' }, ...body }, token);
    assert.equal((await ask({})).status, 409);
    await cashier('PUT', A('agri/settings'), { restrictedUse: 'override' }, 403);
    await request('PUT', A('agri/settings'), { restrictedUse: 'override' });
    assert.deepEqual((await audited('agri.settings_changed', agri.id)).details, { restrictedUse: { from: 'block', to: 'override' } });
    answer = await bill({ ...cash, lines: alpLine });
    assert.deepEqual([answer.status, answer.data.override], [409, true]);
    assert.match(answer.message, /choose the customer tagged as one, or ask a manager to allow it\.$/);
    const notes = await cashier('POST', A('agri/counter-check'), { locationId: shop.id, lines: [{ skuId: alp.id, quantity: '1' }] });
    assert.deepEqual(notes.notes.map((n) => [n.kind, n.level, n.override]), [['restricted', 'stop', 'restricted_use']]);
    // The manager's PIN: wrong, then right; someone without agri.approve cannot give one.
    assert.equal((await ask({ approval: { approverId: manager.id, pin: '1111', reason: 'Fumigation' } })).status, 400);
    assert.equal((await ask({ approval: { approverId: cashierUser.id, pin: '1111', reason: 'Fumigation' } })).status, 403);
    assert.equal((await ask({ skuIds: [cyp.id] })).status, 400, 'an item anyone may buy needs no override');
    const overrideKey = key();
    const overrideBody = { requestKey: overrideKey, kind: 'restricted_use', locationId: shop.id, skuIds: [alp.id],
      approval: { approverId: manager.id, pin: '2580', reason: 'Fumigation of the godown by the cold storage owner' } };
    const given = await cashier('POST', A('agri/overrides'), overrideBody, 201);
    assert.deepEqual([given.kind, given.sku_ids, given.approved_by_name, given.document_id, given.given_on], ['restricted_use', [alp.id], 'more-manager', null, daysFrom(0)]);
    assert.equal((await cashier('POST', A('agri/overrides'), overrideBody, 201)).id, given.id, 'a retry is the same override');
    assert.equal((await refused('POST', A('agri/overrides'), { ...overrideBody, approval: { ...overrideBody.approval, reason: 'Another reason' } }, cashierUser.token)).status, 409);
    assert.ok(!JSON.stringify(await one('SELECT * FROM agri_overrides WHERE id=$1', [given.id])).includes('2580'), 'the PIN is never kept');
    assert.deepEqual((await audited('agri.override_given', given.id)).details.approvedBy, 'more-manager');
    // Used by one bill at its till, the day it was given.
    const allowed = await sale({ ...cash, lines: alpLine, agri: { overrideIds: [given.id] } }, 201, cashier);
    assert.deepEqual(await one('SELECT restricted_by,override_id FROM agri_sale_lines WHERE document_id=$1', [allowed.id]), { restricted_by: 'override', override_id: given.id });
    assert.equal((await one('SELECT document_id FROM agri_overrides WHERE id=$1', [given.id])).document_id, allowed.id);
    assert.equal((await bill({ ...cash, lines: alpLine, agri: { overrideIds: [given.id] } })).status, 409, 'used once');
    await assert.rejects(pool.query('UPDATE agri_overrides SET reason=$2 WHERE id=$1', [given.id, 'x']), /used once, by one bill/);
    // A buyer tagged as a pest-control operator in force buys without one.
    pco = await request('POST', A('contacts'), { kind: 'customer', name: 'Safe Pest Control Services', address: 'Plot 7, Shamshabad' }, 201);
    await cashier('PUT', A(`agri/buyer-tags/${pco.id}`), { tag: 'pest_control_operator', reference: 'PCO/TS/2024/0193' }, 403);
    assert.equal((await refused('PUT', A(`agri/buyer-tags/${pco.id}`), { tag: 'pest_control_operator' })).status, 400, 'with their licence number');
    const tag = await request('PUT', A(`agri/buyer-tags/${pco.id}`), { tag: 'pest_control_operator', reference: 'PCO/TS/2024/0193', validUntil: daysFrom(300) });
    assert.deepEqual([tag.tag, tag.reference, tag.active], ['pest_control_operator', 'PCO/TS/2024/0193', true]);
    assert.ok(await audited('buyer.tagged', pco.id));
    const toPco = await sale({ ...cash, contactId: pco.id, lines: [...alpLine, { skuId: smoke.id, quantity: '1', lotCode: 'CYP-SG-L1' }] });
    assert.deepEqual((await rows('SELECT restricted_by FROM agri_sale_lines WHERE document_id=$1 ORDER BY line_id', [toPco.id])).map((r) => r.restricted_by),
      ['pest_control_operator', 'pest_control_operator']);
    assert.deepEqual((await one('SELECT buyer_tags FROM agri_bills WHERE document_id=$1', [toPco.id])).buyer_tags, ['pest_control_operator']);
    // A tag past its date is no tag; the list shows it.
    await request('PUT', A(`agri/buyer-tags/${pco.id}`), { tag: 'pest_control_operator', reference: 'PCO/TS/2024/0193', validUntil: daysFrom(-1) });
    assert.equal((await bill({ ...cash, contactId: pco.id, lines: alpLine })).status, 409);
    assert.equal((await request('GET', A(`agri/buyer-tags?contact=${pco.id}`))).items[0].in_force, false);
    await request('PUT', A(`agri/buyer-tags/${pco.id}`), { tag: 'pest_control_operator', reference: 'PCO/TS/2024/0193', validUntil: daysFrom(300) });
    await assert.rejects(pool.query('DELETE FROM agri_buyer_tags WHERE contact_id=$1', [pco.id]), /never deleted/);
    // Carbofuran only as its 3% CG: refused on the item form and by the database.
    const carbofuran = { kind: 'goods', tracking: 'batch', name: 'Carbofuran 10% GR', code: 'CBF-1', unit: 'bag', price: '400', taxRateId: gst18.id,
      attributes: { inputKind: 'pesticide', molecules: ['Carbofuran'], formulation: '10% GR' } };
    const wrong = await refused('POST', A('catalog'), carbofuran);
    assert.deepEqual([wrong.status, wrong.message], [409, 'Carbofuran may be kept for sale only as its 3% CG formulation (S.O. 4294(E), 3 October 2023): give the formulation 3% CG, or the item cannot be kept.']);
    const cg = await request('POST', A('catalog'), { ...carbofuran, name: 'Carbofuran 3% CG 10 kg', attributes: { ...carbofuran.attributes, formulation: '3 % C.G.' } }, 201);
    await assert.rejects(pool.query(`UPDATE catalog_skus SET attributes=attributes||'{"formulation":"10% GR"}' WHERE id=$1`, [cg.id]), /may be kept for sale only as its 3% CG formulation/);
    // The database repeats the user rule and the formulation rule where the line is kept.
    const plain = await sale({ ...cash, lines: [{ skuId: manure.id, quantity: '1' }] });
    const line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [plain.id]);
    const insert = (molecules, formulation) => pool.query(`INSERT INTO agri_sale_lines(business_id,line_id,document_id,sku_id,input_kind,molecules,formulation)
      VALUES($1,$2,$3,$4,'pesticide',$5,$6)`, [agri.id, line.id, plain.id, alp.id, molecules, formulation]);
    await assert.rejects(insert(['Aluminium phosphide'], '56% FU'), /goes only to a pest-control operator or a government body, or on a manager's override/);
    await assert.rejects(insert(['Carbofuran'], '10% GR'), /Carbofuran is sold only as its 3% CG formulation/);
  });

  // --- Seed lots -----------------------------------------------------------------------------------
  await t.test('seed lots: the tag gives 9 months from the test, a passing retest 6 more, and the counter sells to that date', async () => {
    const seed = await goods({ name: 'Paddy seed BPT 5204 (certified)', code: 'SEED-BPT', unit: 'kg', tracking: 'batch', price: '60', taxRateId: nil.id,
      attributes: { inputKind: 'seed', seedClass: 'certified', seedCrop: 'Paddy', seedVariety: 'BPT 5204' } });
    const supplier = await request('POST', A('contacts'), { kind: 'supplier', name: 'Telangana State Seeds Development Corporation' }, 201);
    const receive = (lines, expected = 201) => request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines }, expected);
    await receive([{ skuId: seed.id, quantity: '100', unitPrice: '45', lotCode: 'S-1', expiresOn: daysFrom(100) },
      { skuId: seed.id, quantity: '50', unitPrice: '45', lotCode: 'S-2', expiresOn: daysFrom(30) }]);
    // Part of S-1 goes to the branch, and a second part is on its way.
    const branch = await request('POST', A('locations'), { name: 'Kothur branch', code: 'KTR' }, 201);
    const lotS1 = await one("SELECT id FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND lot_code='S-1'", [agri.id, shop.id]);
    const sent = await request('POST', A('transfers'), { requestKey: key(), fromLocationId: shop.id, toLocationId: branch.id, lines: [{ lotId: lotS1.id, quantity: '20' }] }, 201);
    await request('POST', A(`transfers/${sent.id}/receive`), {});
    const onTheWay = await request('POST', A('transfers'), { requestKey: key(), fromLocationId: shop.id, toLocationId: branch.id, lines: [{ lotId: lotS1.id, quantity: '5' }] }, 201);

    // The tag of S-1: tested 100 days ago, so valid for 9 months from then, everywhere the lot is.
    const testedOn = daysFrom(-100);
    const validUntil = await sqlDay("SELECT ($1::date + interval '9 months')::date::text AS d", [testedOn]);
    const tagBody = { skuId: seed.id, lotCode: 'S-1', testedOn, germination: '85', purity: '98.5', tagNo: 'TG/2026/118', qrText: 'https://seedtrace.gov.in/qr/LOT-S1' };
    await cashier('POST', A('agri/seed-lots'), tagBody, 403);
    const tagged = await keeper('POST', A('agri/seed-lots'), tagBody, 201);
    assert.deepEqual([tagged.tested_on, tagged.germination, tagged.purity, tagged.tag_no, tagged.valid_until, tagged.qr_codes.length], [testedOn, '85.00', '98.50', 'TG/2026/118', validUntil, 1]);
    assert.deepEqual(tagged.held.map((h) => h.expires_on), [validUntil, validUntil], 'the shop\'s lot and the branch\'s');
    assert.equal((await one('SELECT expires_on::text AS d FROM business_stock_transfer_lines WHERE transfer_id=$1', [onTheWay.id])).d, validUntil);
    await request('POST', A(`transfers/${onTheWay.id}/receive`), {});
    assert.equal((await audited('seed_lot.tagged', tagged.id)).details.validUntil, validUntil);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='stock.expiry_changed' AND entity_id=$2", [agri.id, lotS1.id]));
    // Refusals: kept already, not received, not a seed, a test still to come, a % over 100.
    assert.equal((await refused('POST', A('agri/seed-lots'), tagBody)).status, 409);
    assert.equal((await refused('POST', A('agri/seed-lots'), { ...tagBody, lotCode: 'S-9' })).status, 404);
    assert.equal((await refused('POST', A('agri/seed-lots'), { ...tagBody, skuId: urea.id })).status, 400);
    assert.equal((await refused('POST', A('agri/seed-lots'), { ...tagBody, lotCode: 'S-2', testedOn: daysFrom(1) })).status, 400);
    assert.equal((await refused('POST', A('agri/seed-lots'), { ...tagBody, lotCode: 'S-2', germination: '101' })).status, 400);
    // The same lot received again comes in at its tag's date; another date is refused.
    await receive([{ skuId: seed.id, quantity: '10', unitPrice: '45', lotCode: 'S-1' }]);
    assert.match((await refused('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
      lines: [{ skuId: seed.id, quantity: '10', unitPrice: '45', lotCode: 'S-1', expiresOn: daysFrom(5) }] })).message, /is valid until .*, by its tag/);
    // A pack's SATHI QR text, kept once.
    await keeper('POST', A(`agri/seed-lots/${tagged.id}/qr-codes`), { qrText: 'https://seedtrace.gov.in/qr/PACK-0001' }, 201);
    assert.equal((await refused('POST', A(`agri/seed-lots/${tagged.id}/qr-codes`), { qrText: 'https://seedtrace.gov.in/qr/LOT-S1' })).status, 409);
    // A tag corrected before any retest moves the date with it.
    const corrected = await keeper('PUT', A(`agri/seed-lots/${tagged.id}`), { testedOn: daysFrom(-90) });
    assert.equal(corrected.valid_until, await sqlDay("SELECT ($1::date + interval '9 months')::date::text AS d", [daysFrom(-90)]));

    // S-2 was tested 300 days ago: its 9 months are over, and the counter refuses it.
    const s2 = await keeper('POST', A('agri/seed-lots'), { skuId: seed.id, lotCode: 'S-2', testedOn: daysFrom(-300), germination: '82', purity: '98' }, 201);
    assert.ok(s2.valid_until < daysFrom(0));
    const sellS2 = { ...cash, lines: [{ skuId: seed.id, quantity: '5', lotCode: 'S-2' }] };
    assert.match((await bill(sellS2)).message, /^Seed lot S-2 of Paddy seed BPT 5204 \(certified\) was valid until .*: it cannot be sold\.$/);
    // A failed retest keeps the date; a passing one adds 6 months, and the counter sells it.
    const retest = (body, expected = 201) => keeper('POST', A(`agri/seed-lots/${s2.id}/retests`), { requestKey: key(), germination: '83', purity: '98', ...body }, expected);
    const failed = await retest({ testedOn: daysFrom(-5), germination: '70', passed: false, reportNo: 'STL/442' });
    assert.equal(failed.valid_until, s2.valid_until);
    await retest({ testedOn: daysFrom(-6), passed: true }, 400);
    const passKey = key();
    const passBody = { requestKey: passKey, testedOn: daysFrom(-1), germination: '84', purity: '98', passed: true, reportNo: 'STL/451' };
    const passed = await keeper('POST', A(`agri/seed-lots/${s2.id}/retests`), passBody, 201);
    const extended = await sqlDay("SELECT ($1::date + interval '6 months')::date::text AS d", [s2.valid_until]);
    assert.deepEqual([passed.valid_until, passed.retests.map((r) => [r.passed, r.valid_before, r.valid_after])],
      [extended, [[false, s2.valid_until, s2.valid_until], [true, s2.valid_until, extended]]]);
    assert.equal((await keeper('POST', A(`agri/seed-lots/${s2.id}/retests`), passBody, 201)).retests.length, 2, 'a retry is the same retest');
    assert.equal((await refused('POST', A(`agri/seed-lots/${s2.id}/retests`), { ...passBody, germination: '90' })).status, 409);
    const sold = await sale(sellS2);
    assert.ok(sold.id, 'the counter uses the extended date');
    assert.deepEqual((await evented('agri.seed_lot_retested', s2.id)).validUntil, extended);
    assert.equal((await refused('PUT', A(`agri/seed-lots/${s2.id}`), { germination: '80' })).status, 409, 'a retested lot keeps its first test');
    await assert.rejects(pool.query('UPDATE agri_seed_retests SET passed=false WHERE seed_lot_id=$1', [s2.id]), /kept as it was entered/);
    await assert.rejects(pool.query('DELETE FROM agri_seed_lots WHERE id=$1', [s2.id]), /never deleted/);
    // The lots list, with the tag, its state and what has no tag yet.
    const lots = await keeper('GET', A(`agri/seed-lots?location=${shop.id}&in_stock=true`));
    assert.deepEqual(lots.items.map((l) => [l.lot_code, l.state, l.no_tag]).sort(), [['S-1', 'valid', false], ['S-2', 'valid', false]]);
    await viewer('GET', A('agri/seed-lots'));
    await request('GET', `/businesses/${grocery.id}/agri/seed-lots`, undefined, 404);
  });

  // --- Subsidised bags in a month ----------------------------------------------------------------------
  await t.test('a farmer\'s subsidised bags in a month, on the business\'s clock: a warning near the limit, a stop or an override over it', async () => {
    await request('PATCH', A(`locations/${shop.id}`), { name: shop.name, stateCode: '36' });
    await cashier('PUT', A('agri/settings'), { bagLimits: [{ stateCode: '36', bagsPerMonth: 10 }] }, 403);
    const set = await request('PUT', A('agri/settings'), { bagLimits: [{ stateCode: '36', bagsPerMonth: 10 }] });
    assert.deepEqual(set.bagLimits, [{ stateCode: '36', bagsPerMonth: 10, own: true }]);
    assert.equal((await refused('PUT', A('agri/settings'), { bagLimits: [{ stateCode: 'TS', bagsPerMonth: 10 }] })).status, 400);
    const ureaBill = (bags, receipt, extra = {}) => bill({ ...cash, contactId: shankar.contact_id, agri: { posReceipt: receipt, ...extra }, lines: [{ skuId: urea.id, quantity: String(bags) }] });
    const tz = 'Asia/Kolkata';
    // Six bags in the last minute of last month, three in the first of this one: only this month's count.
    const last = await sale({ ...cash, contactId: shankar.contact_id, agri: { posReceipt: '1024/0901' }, lines: [{ skuId: urea.id, quantity: '6' }] });
    await pool.query(`UPDATE business_documents SET created_at=(date_trunc('month',now() AT TIME ZONE $2) - interval '1 minute') AT TIME ZONE $2 WHERE id=$1`, [last.id, tz]);
    const first = await sale({ ...cash, contactId: shankar.contact_id, agri: { posReceipt: '1024/0902' }, lines: [{ skuId: urea.id, quantity: '3' }] });
    await pool.query(`UPDATE business_documents SET created_at=LEAST(now(),(date_trunc('month',now() AT TIME ZONE $2) + interval '1 minute') AT TIME ZONE $2) WHERE id=$1`, [first.id, tz]);
    const asked = await cashier('POST', A('agri/counter-check'), { locationId: shop.id, contactId: shankar.contact_id, lines: [{ skuId: urea.id, quantity: '1' }] });
    assert.deepEqual(asked.bags, { before: 3, after: 4, limit: 10 }, 'last month\'s six are not counted; with this one, four');
    // Five more: eight, near the limit.
    const near = await ureaBill(5, '1024/0903');
    assert.equal(near.status, 201);
    const nearBill = (await rows('SELECT id FROM business_documents WHERE business_id=$1 ORDER BY id DESC LIMIT 1', [agri.id]))[0];
    assert.deepEqual((await audited('sale.posted', nearBill.id)).details.warnings, ['Shankar Reddy\'s subsidised bags this month come to 8 with this bill, near the limit of 10 a month for a farmer here.']);
    // Three more: eleven, over it. Stopped, as the shop's setting says.
    let over = await ureaBill(3, '1024/0904');
    assert.deepEqual([over.status, over.data], [409, { reason: 'bag_limit', override: false }]);
    assert.equal(over.message, 'Shankar Reddy\'s subsidised bags this month come to 11 with this bill, over the limit of 10 a month for a farmer here. Bill fewer bags.');
    const counter = await cashier('POST', A('agri/counter-check'), { locationId: shop.id, contactId: shankar.contact_id, lines: [{ skuId: urea.id, quantity: '3' }] });
    assert.deepEqual(counter.notes.map((n) => [n.kind, n.level, n.override]), [['bags', 'stop', undefined]]);
    // A walk-in's bags are not counted.
    await sale({ ...cash, agri: { posReceipt: '1024/0905' }, lines: [{ skuId: urea.id, quantity: '12' }] });
    // A manager's override, as the setting allows.
    await request('PUT', A('agri/settings'), { bagLimitMode: 'override' });
    over = await ureaBill(3, '1024/0906');
    assert.deepEqual(over.data, { reason: 'bag_limit', override: true });
    assert.equal((await refused('POST', A('agri/overrides'), { requestKey: key(), kind: 'bag_limit', locationId: shop.id,
      approval: { approverId: manager.id, pin: '2580', reason: 'Two acres more on lease' } })).status, 400, 'for a named farmer');
    const given = await cashier('POST', A('agri/overrides'), { requestKey: key(), kind: 'bag_limit', locationId: shop.id, contactId: shankar.contact_id,
      approval: { approverId: manager.id, pin: '2580', reason: 'Two acres more on lease' } }, 201);
    assert.equal((await ureaBill(3, '1024/0907', { overrideIds: [given.id] })).status, 201);
    const allowed = (await rows('SELECT id FROM business_documents WHERE business_id=$1 ORDER BY id DESC LIMIT 1', [agri.id]))[0];
    assert.deepEqual((await one('SELECT bag_override_id FROM agri_bills WHERE document_id=$1', [allowed.id])).bag_override_id, given.id);
    assert.deepEqual((await audited('sale.posted', allowed.id)).details.warnings,
      ['Shankar Reddy\'s subsidised bags this month come to 11 with this bill, over the limit of 10 a month for a farmer here; allowed by a manager\'s override.']);
    // Another farmer's override is no override for this one; one within the limit needs none.
    const forLakshmi = await cashier('POST', A('agri/overrides'), { requestKey: key(), kind: 'bag_limit', locationId: shop.id, contactId: lakshmi.contact_id,
      approval: { approverId: manager.id, pin: '2580', reason: 'Harvest delayed' } }, 201);
    assert.equal((await ureaBill(1, '1024/0908', { overrideIds: [forLakshmi.id] })).status, 409);
    assert.equal((await bill({ ...cash, contactId: lakshmi.contact_id, agri: { posReceipt: '1024/0909', overrideIds: [forLakshmi.id] }, lines: [{ skuId: urea.id, quantity: '1' }] })).status, 400);
    // Bags that came back are not counted: two back, nine this month.
    const line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [allowed.id]);
    await request('POST', A(`documents/${allowed.id}/returns`), { requestKey: key(), reason: 'Two bags not needed', lines: [{ lineId: line.id, quantity: '2', restock: true }] }, 201);
    assert.equal((await cashier('POST', A('agri/counter-check'), { locationId: shop.id, contactId: shankar.contact_id, lines: [{ skuId: urea.id, quantity: '0' }] })).bags.before, 9);
    await request('PUT', A('agri/settings'), { bagLimitMode: 'block' });
  });

  // --- Stock kept apart ----------------------------------------------------------------------------------
  let profenofos;
  await t.test('stock kept apart: expired, seized and sampled, each through a stock adjustment, never sold', async () => {
    profenofos = await pesticide('Profenofos 50% EC 1 L', 'PRF-1', ['Profenofos'], '50% EC');
    const supplier = await request('POST', A('contacts'), { kind: 'supplier', name: 'Krishi Agencies' }, 201);
    await request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
      lines: [{ skuId: profenofos.id, quantity: '4', unitPrice: '520', lotCode: 'PF-OLD', expiresOn: daysFrom(-5) }] }, 201);
    const lotOf = (code) => one('SELECT id,quantity FROM business_stock_lots WHERE business_id=$1 AND location_id=$2 AND lot_code=$3', [agri.id, shop.id, code]);
    const old = await lotOf('PF-OLD'), fresh = await lotOf('PRF-1-L1');
    const keepApart = (body, expected = 201, by = keeper) => by('POST', A('agri/kept-apart'), { requestKey: key(), ...body }, expected);
    // Expired: segregated, not for sale (rule 10A). Not before its date; never more than is there.
    assert.equal((await refused('POST', A('agri/kept-apart'), { requestKey: key(), kind: 'expired', lotId: fresh.id, quantity: '1' })).status, 400);
    assert.equal((await refused('POST', A('agri/kept-apart'), { requestKey: key(), kind: 'expired', lotId: old.id, quantity: '9' })).status, 409);
    await keepApart({ kind: 'expired', lotId: old.id, quantity: '1' }, 403, cashier);
    const expiredKey = key();
    const expired = await keeper('POST', A('agri/kept-apart'), { requestKey: expiredKey, kind: 'expired', lotId: old.id, quantity: '4', notes: 'Shelf C, marked not for sale' }, 201);
    assert.deepEqual([expired.kind, expired.status, expired.quantity, expired.lot_code, expired.held_on], ['expired', 'held', '4.000', 'PF-OLD', daysFrom(0)]);
    assert.equal((await keeper('POST', A('agri/kept-apart'), { requestKey: expiredKey, kind: 'expired', lotId: old.id, quantity: '4', notes: 'Shelf C, marked not for sale' }, 201)).id, expired.id);
    assert.equal(Number((await lotOf('PF-OLD')).quantity), 0, 'out of stock, through a stock adjustment');
    const adjustment = await one('SELECT a.quantity,a.reason FROM agri_stock_holds h JOIN business_stock_adjustments a ON a.business_id=h.business_id AND a.id=h.adjustment_id WHERE h.id=$1', [expired.id]);
    assert.deepEqual([adjustment.quantity, adjustment.reason], ['-4.000', 'Expired: kept apart, not for sale (Insecticides Rules 1971, rule 10A)']);
    assert.ok(await one("SELECT 1 FROM business_events WHERE business_id=$1 AND kind='stock.adjusted' AND payload->>'lotId'=$2", [agri.id, String(old.id)]));
    // Seized and sampled: an inspector's name and their receipt or slip.
    assert.equal((await refused('POST', A('agri/kept-apart'), { requestKey: key(), kind: 'seized', lotId: fresh.id, quantity: '2' })).status, 400);
    const seized = await keepApart({ kind: 'seized', lotId: fresh.id, quantity: '2', officer: 'K. Srinivas, Agriculture Officer', officerReference: 'SZ/RR/2026/31' });
    const sampled = await keepApart({ kind: 'sampled', lotId: fresh.id, quantity: '1', officer: 'K. Srinivas, Agriculture Officer', officerReference: 'SMP/RR/2026/77' });
    assert.equal(Number((await lotOf('PRF-1-L1')).quantity), 27);
    // None can be sold: what is kept apart is out of the lot.
    assert.equal((await bill({ ...cash, lines: [{ skuId: profenofos.id, quantity: '28', lotCode: 'PRF-1-L1' }] })).status, 409);
    // Closed: released back into stock (seized only), or closed with what came of it.
    const close = (hold, body, expected = 200) => keeper('POST', A(`agri/kept-apart/${hold.id}/close`), { requestKey: key(), on: daysFrom(0), ...body }, expected);
    assert.equal((await refused('POST', A(`agri/kept-apart/${expired.id}/close`), { requestKey: key(), how: 'released', on: daysFrom(0), details: 'Order' })).status, 400);
    const released = await close(seized, { how: 'released', details: 'Released after the sample conformed', reference: 'REL/RR/2026/31' });
    assert.equal(released.status, 'released');
    assert.equal(Number((await lotOf('PRF-1-L1')).quantity), 29, 'back into the lot it came from');
    await close(sampled, { how: 'closed', details: 'Lab report: conforms to the label', reference: 'STL/R/1180' });
    const disposed = await close(expired, { how: 'closed', details: 'Returned to the company for disposal as the Centre specifies', reference: 'RTN/2026/22' });
    assert.deepEqual([disposed.status, disposed.closed_how, disposed.closed_reference], ['closed', 'Returned to the company for disposal as the Centre specifies', 'RTN/2026/22']);
    assert.equal((await refused('POST', A(`agri/kept-apart/${expired.id}/close`), { requestKey: key(), how: 'closed', on: daysFrom(0), details: 'Again' })).status, 409);
    // The register of expired stock (rule 10A), and the record kept as it was.
    const register = await viewer('GET', A('agri/kept-apart?kind=expired'));
    assert.deepEqual(register.items.map((h) => [h.label, h.lot_code, Number(h.quantity), h.status]), [['Profenofos 50% EC 1 L', 'PF-OLD', 4, 'closed']]);
    await assert.rejects(pool.query('UPDATE agri_stock_holds SET quantity=1 WHERE id=$1', [expired.id]), /kept apart keeps what was kept, and is closed once/);
    await assert.rejects(pool.query('DELETE FROM agri_stock_holds WHERE id=$1', [sampled.id]), /never deleted/);
    assert.ok(await audited('stock.kept_apart', expired.id));
  });

  // --- Food or feed at a location (rule 10C) ---------------------------------------------------------------
  await t.test('a location that also stores or sells food or feed warns of insecticides received or kept there', async () => {
    const household = await pesticide('Mosquito repellent liquid 45 ml', 'MOSQ-45', ['Prallethrin'], '1.6% LV', { attributes: { household: true } });
    assert.equal(household.attributes.household, 'yes');
    await goods({ name: 'Neem cake', code: 'NEEM-1', unit: 'bag', price: '600', attributes: { inputKind: 'fertiliser', household: true } }, 400);
    const marked = await request('PUT', A('agri/settings'), { foodLocations: [shop.id] });
    assert.deepEqual(marked.foodLocations, [shop.id]);
    assert.equal(marked.warnings.length, 1);
    assert.match(marked.warnings[0], /^Aluminium phosphide 56% FU 10 tablets, .*Profenofos 50% EC 1 L are insecticides other than a registered household one, and .* also stores or sells food or feed: no such insecticide is stored or sold in the same building \(Insecticides Rules 1971, rule 10C\)\.$/);
    assert.ok(!marked.warnings[0].includes('Mosquito'), 'a registered household insecticide is not named');
    // Received there: a warning with the receipt (a household one: none).
    const supplier = await request('POST', A('contacts'), { kind: 'supplier', name: 'Godrej Consumer depot' }, 201);
    const receipt = await request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
      lines: [{ skuId: imida.id, quantity: '5', unitPrice: '240', lotCode: 'IMI-250-L2', expiresOn: daysFrom(500) }] }, 201);
    assert.equal(receipt.warnings.length, 1);
    assert.match(receipt.warnings[0], /^Imidacloprid 17\.8% SL 250 ml is an insecticide other than a registered household one/);
    const quiet = await request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id,
      lines: [{ skuId: household.id, quantity: '5', unitPrice: '50', lotCode: 'MOSQ-L2', expiresOn: daysFrom(500) }] }, 201);
    assert.equal(quiet.warnings, undefined);
    // The bell keeps saying so while it is marked.
    const bell = async () => (await request('GET', A('notifications'))).items.filter((i) => i.category === 'Farm inputs' && i.id.startsWith('agri-food:'));
    const items = await bell();
    assert.equal(items.length, 1);
    assert.match(items[0].title, /^Insecticides are kept at .*, which also stores or sells food or feed$/);
    assert.equal(items[0].link, `/business-admin/${agri.id}/agri-settings`);
    await request('PUT', A('agri/settings'), { foodLocations: [] });
    assert.deepEqual(await bell(), []);
    assert.deepEqual((await audited('agri.settings_changed', agri.id)).details, { foodLocations: { from: [shop.id], to: [] } });
  });

  // --- Registers, returns and the bell ---------------------------------------------------------------------
  await t.test('Form XIII, Form XIV and the sulphur buyers\' register come from the bills; a return marked sent leaves the bell', async () => {
    const dealer = await request('POST', A('contacts'), { kind: 'customer', name: 'Sri Sai Agro Agencies', gstin: '36ABCPR1234K1ZO', address: 'Main Road, Shadnagar' }, 201);
    const estate = await request('POST', A('contacts'), { kind: 'customer', name: 'Green Valley Estates', address: 'Survey 42, Chevella' }, 201);
    await cashier('PUT', A(`agri/buyer-tags/${estate.id}`), { tag: 'bulk_consumer', notes: 'Mango orchard, 120 acres' });
    const imidaLine = (quantity) => [{ skuId: imida.id, quantity, lotCode: 'IMI-250-L1' }];
    const toDealer = await sale({ ...cash, contactId: dealer.id, agri: { crop: 'Cotton' }, lines: imidaLine('3') });
    const toEstate = await sale({ ...cash, contactId: estate.id, agri: { crop: 'Mango' }, lines: imidaLine('5') });
    await sale({ ...cash, contactId: ramaiah.contact_id, agri: { crop: 'Cotton' }, lines: imidaLine('2') });
    assert.deepEqual((await one('SELECT buyer_tags FROM agri_bills WHERE document_id=$1', [toEstate.id])).buyer_tags, ['bulk_consumer']);
    const day = daysFrom(0), month = day.slice(0, 7);
    const xiii = await viewer('GET', A(`agri/form-xiii?from=${day}&to=${day}`));
    assert.deepEqual(xiii.rows.map((r) => [r.insecticide, r.buyer, r.buyer_kind, r.buyer_gstin, Number(r.quantity), r.address]), [
      ['Imidacloprid 17.8% SL 250 ml', 'Sri Sai Agro Agencies', 'dealer', '36ABCPR1234K1ZO', 3, 'Main Road, Shadnagar'],
      ['Imidacloprid 17.8% SL 250 ml', 'Green Valley Estates', 'bulk_consumer', null, 5, 'Survey 42, Chevella'],
    ]);
    assert.ok(xiii.rows.every((r) => r.document_no && r.batch === 'IMI-250-L1'));
    assert.ok(toDealer.id);
    // The month's Form XIV: each insecticide's stock, adding up, with what went to dealers and bulk consumers apart.
    const xiv = await viewer('GET', A(`agri/form-xiv?locationId=${shop.id}&month=${month}`));
    for (const row of xiv.rows) {
      const m = (x) => Math.round(Number(x) * 1000);
      assert.equal(m(row.opening) + m(row.purchased) - m(row.sold) + m(row.other), m(row.closing), `${row.label} adds up`);
    }
    const imidaRow = xiv.rows.find((r) => r.id === imida.id);
    assert.deepEqual([imidaRow.to_trade, imidaRow.purchased, imidaRow.molecules], ['8.000', '5.000', ['Imidacloprid']]);
    assert.match(xiv.dueOn, /^\d{4}-\d{2}-15$/);
    assert.equal(xiv.filed, null);
    // Sulphur: sold with its buyer's name and address.
    const sulphur = await pesticide('Wettable sulphur 80% WDG 1 kg', 'SUL-1', ['Sulphur'], '80% WDG');
    const sulphurLine = [{ skuId: sulphur.id, quantity: '2', lotCode: 'SUL-1-L1' }];
    assert.match((await bill({ ...cash, buyer: { name: 'Mallesh' }, lines: sulphurLine })).message, /^Sulphur is sold with its buyer's name and address \(Insecticides Rules 1971, rule 10B\)/);
    const bare = await request('POST', A('contacts'), { kind: 'customer', name: 'Narsimha' }, 201);
    assert.match((await bill({ ...cash, contactId: bare.id, lines: sulphurLine })).message, /give Narsimha an address, or their village as a farmer/);
    await sale({ ...cash, buyer: { name: 'Mallesh' }, agri: { village: 'Shadnagar' }, lines: sulphurLine });
    await sale({ ...cash, contactId: lakshmi.contact_id, lines: [{ skuId: sulphur.id, quantity: '1', lotCode: 'SUL-1-L1' }] });
    const register = await viewer('GET', A(`agri/sulphur-register?from=${day}&to=${day}`));
    assert.deepEqual(register.rows.map((r) => [r.buyer, r.address, Number(r.quantity)]), [['Mallesh', 'Shadnagar', 2], ['Lakshmi Bai', 'Kothur', 1]]);
    // Last month's returns are due: on the bell until marked sent; this month's is sent once it is over.
    const lastMonth = await sqlDay("SELECT to_char(date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date) - interval '1 month','YYYY-MM') AS d", []);
    const bell = async () => (await request('GET', A('notifications'))).items.filter((i) => i.id.startsWith('agri-return:'));
    const atShop = async () => (await bell()).filter((i) => i.id.split(':')[2] === String(shop.id));
    let due = await atShop();
    assert.deepEqual(due.map((i) => i.id.split(':')[1]).sort(), ['form_d', 'form_xiv']);
    const xivItem = due.find((i) => i.id.startsWith('agri-return:form_xiv:'));
    assert.match(xivItem.title, /^Form XIV for \w+ \d{4} (is due by|was due on) 15 \w{3} \d{4}$/);
    assert.equal(xivItem.severity, daysFrom(0).slice(8) > '15' ? 'critical' : 'warning');
    assert.equal(xivItem.link, `/business-admin/${agri.id}/agri-registers?tab=form-xiv`);
    await viewer('POST', A('agri/returns-filed'), { form: 'form_xiv', locationId: shop.id, month: lastMonth, filedOn: daysFrom(0) }, 403);
    assert.equal((await refused('POST', A('agri/returns-filed'), { form: 'form_xiv', locationId: shop.id, month, filedOn: daysFrom(0) })).status, 400, 'once the month is over');
    const filed = await cashier('POST', A('agri/returns-filed'), { form: 'form_xiv', locationId: shop.id, month: lastMonth, filedOn: daysFrom(0), reference: 'ACK/RR/2026/1093' }, 201);
    assert.deepEqual([filed.filed.filed_on, filed.filed.reference], [daysFrom(0), 'ACK/RR/2026/1093']);
    assert.equal((await refused('POST', A('agri/returns-filed'), { form: 'form_xiv', locationId: shop.id, month: lastMonth, filedOn: daysFrom(0) })).status, 409);
    due = await atShop();
    assert.deepEqual(due.map((i) => i.id.split(':')[1]), ['form_d']);
    assert.ok((await bell()).some((i) => i.id.startsWith('agri-return:form_d:') && i.id.split(':')[2] !== String(shop.id)), 'the branch keeps seed too');
    assert.equal((await viewer('GET', A(`agri/form-xiv?locationId=${shop.id}&month=${lastMonth}`))).filed.reference, 'ACK/RR/2026/1093');
    await assert.rejects(pool.query('DELETE FROM agri_returns_filed WHERE business_id=$1', [agri.id]), /kept as it was marked/);
    assert.ok(await one("SELECT 1 FROM business_audit WHERE business_id=$1 AND action='agri.return_filed' AND entity_id=$2", [agri.id, shop.id]));
  });

  // --- The board of a day gone by --------------------------------------------------------------------------------
  await t.test('the board of a day gone by shows that day\'s prices, from the price history', async () => {
    // DAP was priced 1,300 three days ago, its branch price 1,280 set two days ago; today it is 1,350 and the branch price is gone.
    const history = await rows('SELECT price,mrp,location_id FROM business_price_history WHERE business_id=$1 AND sku_id=$2 ORDER BY id', [agri.id, dap.id]);
    assert.deepEqual(history.map((h) => [h.price, h.mrp, h.location_id]), [['1350.00', '1350.00', null]], 'the price it was made with');
    await pool.query('ALTER TABLE business_price_history DISABLE TRIGGER business_price_history_fixed');
    try {
      await pool.query("UPDATE business_price_history SET changed_at=now() - interval '3 days',price=1300 WHERE business_id=$1 AND sku_id=$2", [agri.id, dap.id]);
    } finally {
      await pool.query('ALTER TABLE business_price_history ENABLE TRIGGER business_price_history_fixed');
    }
    await pool.query('UPDATE catalog_skus SET price=1300 WHERE id=$1', [dap.id]);
    await request('PUT', A(`catalog/${dap.id}/branch-prices`), { prices: [{ locationId: shop.id, price: '1280' }] });
    await pool.query('ALTER TABLE business_price_history DISABLE TRIGGER business_price_history_fixed');
    try {
      await pool.query(`UPDATE business_price_history SET changed_at=now() - interval '2 days' WHERE business_id=$1 AND sku_id=$2 AND location_id IS NOT NULL`, [agri.id, dap.id]);
      await pool.query(`DELETE FROM business_price_history WHERE business_id=$1 AND sku_id=$2 AND location_id IS NULL AND price=1300 AND changed_at > now() - interval '1 day'`, [agri.id, dap.id]);
    } finally {
      await pool.query('ALTER TABLE business_price_history ENABLE TRIGGER business_price_history_fixed');
    }
    await request('PUT', A(`catalog/${dap.id}/branch-prices`), { prices: [{ locationId: shop.id, price: '' }] });
    await request('PATCH', A(`catalog/${dap.id}`), { label: dap.label, price: '1350', mrp: '1350', taxRateId: gst5.id, active: true });
    const kept = await rows('SELECT price,location_id FROM business_price_history WHERE business_id=$1 AND sku_id=$2 ORDER BY changed_at,id', [agri.id, dap.id]);
    assert.deepEqual(kept.map((h) => [h.price, h.location_id]), [['1300.00', null], ['1280.00', shop.id], [null, shop.id], ['1350.00', null]]);
    const boardOn = async (on) => (await viewer('GET', A(`agri/board?locationId=${shop.id}&on=${on}`))).rows.find((r) => r.id === dap.id);
    const three = await boardOn(daysFrom(-3)), two = await boardOn(daysFrom(-2)), today = await boardOn(daysFrom(0));
    assert.deepEqual([three.price, two.price, today.price], ['1300.00', '1280.00', '1350.00']);
    assert.deepEqual([two.opening_price, two.price_changed], ['1300.00', true], 'the branch price was set that day');
    assert.deepEqual([today.opening_price, today.price_changed], ['1280.00', true], 'the day began at the branch price');
    // Days before the history began show the first price kept.
    assert.equal((await boardOn(daysFrom(-10))).price, '1300.00');
    await assert.rejects(pool.query('DELETE FROM business_price_history WHERE sku_id=$1', [dap.id]), /never changed/);
  });

  // --- Season credit ----------------------------------------------------------------------------------------------
  let kharif;
  await t.test('season credit: its limit, terms, interest to the paisa, billed when confirmed, and produce taken against it', async () => {
    const terms = { contactId: ramaiah.contact_id, season: 'kharif', seasonYear: year, dueOn: daysFrom(10), creditLimit: '15000', interest: 'after_due', interestRate: '2',
      guarantorName: 'Venkaiah Goud', guarantorPhone: '9848000001', guarantorAddress: 'Kothur', cropPledged: 'Paddy, 3 acres' };
    await cashier('POST', A('agri/season-credits'), terms, 403);
    assert.equal((await refused('POST', A('agri/season-credits'), { ...terms, interestRate: undefined })).status, 400);
    assert.equal((await refused('POST', A('agri/season-credits'), { ...terms, interestRate: '12' })).status, 400);
    assert.equal((await refused('POST', A('agri/season-credits'), { ...terms, dueOn: daysFrom(-1) })).status, 400);
    assert.equal((await refused('POST', A('agri/season-credits'), { ...terms, guarantorName: undefined })).status, 400, 'a guarantor\'s phone needs their name');
    kharif = await manager.call('POST', A('agri/season-credits'), terms, 201);
    assert.deepEqual([kharif.season.season, kharif.season.credit_limit, kharif.season.interest, kharif.season.interest_rate, kharif.season.guarantor_name, kharif.owed],
      ['kharif', '15000.00', 'after_due', '2.00', 'Venkaiah Goud', '0.00']);
    assert.equal((await refused('POST', A('agri/season-credits'), terms)).status, 409);
    // Bills on it fall due on its date, within its limit.
    const onCredit = (bags, extra = {}) => bill({ contactId: ramaiah.contact_id, agri: { seasonCreditId: kharif.season.id, ...extra }, lines: [{ skuId: manure.id, quantity: String(bags) }] });
    const a = await onCredit(20), b = await onCredit(10);
    assert.deepEqual([a.status, b.status], [201, 201]);
    const [billA, billB] = await rows("SELECT id,document_no,total,due_on::text AS due_on FROM business_documents WHERE business_id=$1 AND contact_id=$2 AND kind='sale' ORDER BY id DESC LIMIT 2", [agri.id, ramaiah.contact_id]).then((r) => r.reverse());
    assert.deepEqual([billA.total, billB.total, billA.due_on], ['10000.00', '5000.00', daysFrom(10)]);
    const overLimit = await onCredit(1);
    assert.equal(overLimit.status, 409);
    assert.equal(overLimit.message, `This bill would take Ramaiah Goud's Kharif ${year} credit to ₹15,500.00 owed, over its limit of ₹15,000.00. Take a payment now, or raise the season's limit under Farm inputs › Season credit.`);
    assert.equal((await onCredit(1, { dueOn: daysFrom(11) })).status, 409, 'its bills fall due on its own date');
    // Its due date and interest are fixed once a bill is on it; its limit and guarantor change.
    assert.equal((await refused('PUT', A(`agri/season-credits/${kharif.season.id}`), { ...terms, dueOn: daysFrom(12) })).status, 409);
    const raised = await request('PUT', A(`agri/season-credits/${kharif.season.id}`), { ...terms, creditLimit: '20000' });
    assert.equal(raised.season.credit_limit, '20000.00');
    assert.deepEqual((await audited('season_credit.changed', kharif.season.id)).details.to, { creditLimit: 20000 });
    // Closed, it takes no new bills; opened again, it does.
    await request('PUT', A(`agri/season-credits/${kharif.season.id}`), { ...terms, creditLimit: '20000', closed: true });
    assert.match((await onCredit(1)).message, /credit is closed: open it again under Farm inputs › Season credit/);
    await request('PUT', A(`agri/season-credits/${kharif.season.id}`), { ...terms, creditLimit: '20000', closed: false });

    // The timeline the interest is worked out on: the season fell due 20 days ago; bill A was made
    // 60 days ago, bill B 30 days ago; 4,000 was paid on bill A 10 days ago.
    await pool.query('ALTER TABLE agri_season_credits DISABLE TRIGGER agri_season_credits_guard');
    try {
      await pool.query('UPDATE agri_season_credits SET due_on=$2 WHERE id=$1', [kharif.season.id, daysFrom(-20)]);
    } finally {
      await pool.query('ALTER TABLE agri_season_credits ENABLE TRIGGER agri_season_credits_guard');
    }
    await pool.query('UPDATE business_documents SET created_at=$2,due_on=$3 WHERE id=$1', [billA.id, momentAt(daysFrom(-60), '10:00'), daysFrom(-20)]);
    await pool.query('UPDATE business_documents SET created_at=$2,due_on=$3 WHERE id=$1', [billB.id, momentAt(daysFrom(-30), '10:00'), daysFrom(-20)]);
    await request('POST', A(`documents/${billA.id}/payments`), { amount: '4000', method: 'upi', requestKey: key() }, 201);
    await pool.query('UPDATE business_payments SET created_at=$2 WHERE document_id=$1', [billA.id, momentAt(daysFrom(-10), '11:00')]);
    // After the due date, 2% a month (a thirtieth a day): bill A owed 10,000 for 9 days and 6,000
    // for 11; bill B owed 5,000 for 20 days. (10,000×9 + 6,000×11) × 2% / 30 = 104.00;
    // 5,000 × 20 × 2% / 30 = 66.666… = 66.67. Interest is 170.67.
    let detail = await viewer('GET', A(`agri/season-credits/${kharif.season.id}`));
    assert.deepEqual([detail.owed, detail.left, detail.interest.worked, detail.interest.billed, detail.interest.due], ['11000.00', '9000.00', '170.67', '0.00', '170.67']);
    const ofA = detail.interest.bills.find((x) => x.documentId === billA.id);
    assert.deepEqual([ofA.from, ofA.days, ofA.interest, ofA.periods.map((p) => [p.days, p.owed])], [daysFrom(-20), 20, '104.00', [[9, '10000.00'], [11, '6000.00']]]);
    assert.equal(detail.interest.bills.find((x) => x.documentId === billB.id).interest, '66.67');
    assert.equal(detail.bills.find((x) => x.id === billA.id).interest, '104.00');
    // A role that sees no dues gets the terms without the money.
    const hidden = await keeper('GET', A(`agri/season-credits/${kharif.season.id}`));
    assert.deepEqual([hidden.money, hidden.season.credit_limit, hidden.interest], [false, undefined, undefined]);
    await keeper('GET', A('agri/season-credits?owing=true'), undefined, 403);
    // Billed only when confirmed, as seen: as a bill of the interest item, due at once, on the season.
    const interestKey = key();
    const charge = { requestKey: interestKey, locationId: shop.id, amount: '170.67' };
    assert.match((await refused('POST', A(`agri/season-credits/${kharif.season.id}/interest`), charge)).message, /^Choose the service item interest is billed as/);
    const interestItem = await request('POST', A('catalog'), { kind: 'service', tracking: 'none', name: 'Interest on overdue credit', code: 'INTEREST', unit: 'service', price: '1', taxRateId: nil.id }, 201);
    assert.equal((await refused('PUT', A('agri/settings'), { interestSkuId: urea.id })).status, 400, 'a service item');
    await request('PUT', A('agri/settings'), { interestSkuId: interestItem.id });
    await cashier('POST', A(`agri/season-credits/${kharif.season.id}/interest`), charge, 403);
    const moved = await refused('POST', A(`agri/season-credits/${kharif.season.id}/interest`), { ...charge, amount: '170.66' });
    assert.deepEqual([moved.status, moved.message], [409, 'The interest due is now ₹170.67, not ₹170.66: look at it again before billing it']);
    const charged = await manager.call('POST', A(`agri/season-credits/${kharif.season.id}/interest`), charge, 201);
    const interestBill = await one('SELECT * FROM business_documents WHERE id=$1', [charged.documentId]);
    assert.deepEqual([interestBill.subtotal, interestBill.tax, interestBill.round_off, interestBill.total, interestBill.due_on, interestBill.contact_id],
      ['170.67', '0.00', '0.33', '171.00', daysFrom(0), ramaiah.contact_id]);
    assert.equal((await one('SELECT label FROM business_document_lines WHERE document_id=$1', [interestBill.id])).label,
      `Interest on Kharif ${year} credit to ${(await sqlDay("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','FMDD Mon YYYY') AS d", []))} (2% a month)`);
    assert.equal((await one('SELECT season_credit_id FROM agri_bills WHERE document_id=$1', [interestBill.id])).season_credit_id, kharif.season.id);
    assert.deepEqual([charged.interest.billed, charged.interest.due, charged.owed], ['170.67', '0.00', '11171.00']);
    assert.equal((await manager.call('POST', A(`agri/season-credits/${kharif.season.id}/interest`), charge, 201)).documentId, interestBill.id, 'a retry is the same bill');
    assert.match((await refused('POST', A(`agri/season-credits/${kharif.season.id}/interest`), { ...charge, requestKey: key() })).message, /^No interest is due/);
    const kept = await one('SELECT worked_to::text AS worked_to,amount,workings FROM agri_season_interest WHERE document_id=$1', [interestBill.id]);
    assert.deepEqual([kept.worked_to, kept.amount, kept.workings.map((w) => [w.documentNo, w.interest])], [daysFrom(0), '170.67', [[billA.document_no, '104.00'], [billB.document_no, '66.67']]]);
    assert.deepEqual((await evented('agri.interest_billed', kharif.season.id)).amount, '170.67');
    await assert.rejects(pool.query('UPDATE agri_season_interest SET amount=1 WHERE document_id=$1', [interestBill.id]), /kept as it was worked out/);

    // Produce against what is owed: 4.75 quintals of paddy at 2,183.33 is 10,370.8175 = 10,370.82.
    // It pays the season's bills oldest due first: bill A (6,000), then bill B (4,370.82 of 5,000).
    const takingsOf = async () => (await request('GET', A(`reports/takings?from=${daysFrom(0)}&to=${daysFrom(0)}`))).received;
    const before = await takingsOf();
    const produceKey = key();
    const produce = { requestKey: produceKey, locationId: shop.id, crop: 'Paddy (BPT 5204)', quantity: '4.75', unit: 'quintal', rate: '2183.33', notes: 'Weighed at the shop' };
    await viewer('POST', A(`agri/season-credits/${kharif.season.id}/produce`), produce, 403);
    const taken = await request('POST', A(`agri/season-credits/${kharif.season.id}/produce`), produce, 201);
    assert.deepEqual([taken.receipt.receipt_no, taken.receipt.value, taken.receipt.payments.map((p) => [p.document_id, p.amount])],
      [1, '10370.82', [[billA.id, '6000.00'], [billB.id, '4370.82']]]);
    assert.equal(taken.receipt.payments.reduce((sum, p) => sum + paise(p.amount), 0), paise(taken.receipt.value), 'the payments add up to the produce\'s value');
    assert.equal(taken.owed, '800.18');
    const payments = await rows('SELECT method,method_name,reference,amount FROM business_payments WHERE document_id=ANY($1::bigint[]) AND method=$2 ORDER BY id', [[billA.id, billB.id], 'credit_note']);
    assert.deepEqual(payments.map((p) => [p.method_name, p.reference, p.amount]), [['Produce', 'PR-1 Paddy (BPT 5204)', '6000.00'], ['Produce', 'PR-1 Paddy (BPT 5204)', '4370.82']]);
    assert.equal((await request('POST', A(`agri/season-credits/${kharif.season.id}/produce`), produce, 201)).receipt.id, taken.receipt.id, 'a retry is the same receipt');
    assert.equal((await refused('POST', A(`agri/season-credits/${kharif.season.id}/produce`), { ...produce, quantity: '4.80' })).status, 409);
    const tooMuch = await refused('POST', A(`agri/season-credits/${kharif.season.id}/produce`), { ...produce, requestKey: key(), quantity: '1', rate: '1000' });
    assert.deepEqual([tooMuch.status, tooMuch.message], [409, `The produce is worth ₹1,000.00, more than the ₹800.18 Ramaiah Goud owes on Kharif ${year} credit: take less, or settle the rest in money`]);
    // No money moved: the day's money received and cash are as they were.
    const after = await takingsOf();
    assert.deepEqual([after.total, after.cash, after.upi], [before.total, before.cash, before.upi]);
    assert.deepEqual((await evented('agri.produce_taken', kharif.season.id)).value, '10370.82');
    await assert.rejects(pool.query('UPDATE agri_produce_receipts SET value=1 WHERE id=$1', [taken.receipt.id]), /kept as it was taken/);

    // From each bill's date: 1.5% a month on a 3,000 bill of 45 days ago is 3,000 × 45 × 1.5% / 30 = 67.50.
    const rabi = await request('POST', A('agri/season-credits'), { contactId: lakshmi.contact_id, season: 'rabi', seasonYear: year, dueOn: daysFrom(30),
      creditLimit: '3500', interest: 'from_bill', interestRate: '1.5' }, 201);
    const c = await sale({ contactId: lakshmi.contact_id, agri: { seasonCreditId: rabi.season.id }, lines: [{ skuId: manure.id, quantity: '6' }] });
    await pool.query('UPDATE business_documents SET created_at=$2 WHERE id=$1', [c.id, momentAt(daysFrom(-45), '09:00')]);
    detail = await request('GET', A(`agri/season-credits/${rabi.season.id}`));
    assert.deepEqual([detail.owed, detail.interest.worked], ['3000.00', '67.50']);
    // Its limit of 3,500: 1,000 more on credit is over; with 500 paid now, 500 on credit is within it.
    assert.equal((await bill({ contactId: lakshmi.contact_id, agri: { seasonCreditId: rabi.season.id }, lines: [{ skuId: manure.id, quantity: '2' }] })).status, 409);
    await sale({ contactId: lakshmi.contact_id, agri: { seasonCreditId: rabi.season.id }, payment: { amount: '500', method: 'cash' }, lines: [{ skuId: manure.id, quantity: '2' }] });
    // A season on another customer's bill, and a walk-in, are refused.
    assert.equal((await bill({ contactId: shankar.contact_id, agri: { seasonCreditId: rabi.season.id }, lines: [{ skuId: manure.id, quantity: '1' }] })).status, 404);
    assert.equal((await bill({ ...cash, agri: { seasonCreditId: rabi.season.id }, lines: [{ skuId: manure.id, quantity: '1' }] })).status, 400);
    // The list: each season with what is owed on it.
    const listed = await viewer('GET', A(`agri/season-credits?contact=${ramaiah.contact_id}`));
    assert.deepEqual(listed.items.map((s) => [s.season, Number(s.owed), s.overdue, Number(s.interest_billed)]), [['kharif', 800.18, true, 170.67]]);
    await assert.rejects(pool.query('DELETE FROM agri_season_credits WHERE id=$1', [rabi.season.id]), /never deleted; close it instead/);
  });

  await t.test('a quotation\'s bill takes the season', async () => {
    await request('PUT', A('modules/quotations'), { enabled: true });
    const zaid = await request('POST', A('agri/season-credits'), { contactId: ramaiah.contact_id, season: 'zaid', seasonYear: year, dueOn: daysFrom(40) }, 201);
    const q = await request('POST', A('quotations'), { requestKey: key(), locationId: shop.id, contactId: ramaiah.contact_id, validUntil: daysFrom(5),
      lines: [{ skuId: manure.id, quantity: '2' }] }, 201);
    const made = await request('POST', A(`quotations/${q.id}/bill`), { requestKey: key(), agri: { seasonCreditId: zaid.season.id } }, 201);
    assert.deepEqual([made.document.total, made.document.due_on], ['1000.00', daysFrom(40)]);
    assert.deepEqual(await one('SELECT season,season_year,season_credit_id FROM agri_bills WHERE document_id=$1', [made.document.id]), { season: 'zaid', season_year: year, season_credit_id: zaid.season.id });
    // A season given by its name, year and date opens the customer's credit for it.
    const q2 = await request('POST', A('quotations'), { requestKey: key(), locationId: shop.id, contactId: shankar.contact_id, validUntil: daysFrom(5),
      lines: [{ skuId: manure.id, quantity: '1' }] }, 201);
    const opened = await request('POST', A(`quotations/${q2.id}/bill`), { requestKey: key(), agri: { season: 'rabi', seasonYear: year, dueOn: daysFrom(60) } }, 201);
    const season = await one('SELECT s.* FROM agri_bills b JOIN agri_season_credits s ON s.id=b.season_credit_id WHERE b.document_id=$1', [opened.document.id]);
    assert.deepEqual([season.contact_id, season.season, season.due_on, season.interest, season.credit_limit], [shankar.contact_id, 'rabi', daysFrom(60), 'none', null]);
    assert.ok(await audited('season_credit.opened', season.id));
  });

  // --- Company schemes ----------------------------------------------------------------------------------------------
  await t.test('company schemes: what the purchases earn at the slab reached, the claims and what is still due', async () => {
    const coromandel = await request('POST', A('contacts'), { kind: 'supplier', name: 'Coromandel International depot' }, 201);
    const iffco = await request('POST', A('contacts'), { kind: 'supplier', name: 'IFFCO depot' }, 201);
    const scheme = { contactId: coromandel.id, name: `Kharif ${year} DAP offtake scheme`, season: 'kharif', seasonYear: year, startsOn: daysFrom(-30), endsOn: daysFrom(30),
      skuIds: [dap.id], benefits: [{ kind: 'per_unit', minQuantity: '0', rate: '2' }, { kind: 'per_unit', minQuantity: '100', rate: '5' },
        { kind: 'target', minQuantity: '150', amount: '500' }, { kind: 'free_goods', minQuantity: '200', freeSkuId: dap.id, freeQuantity: '5' },
        { kind: 'gift', minQuantity: '150', gift: 'Wall clock' }] };
    await keeper('POST', A('agri/schemes'), scheme, 403);
    assert.equal((await refused('POST', A('agri/schemes'), { ...scheme, skuIds: [dap.id, imida.id] })).status, 400, 'one unit for its items');
    assert.equal((await refused('POST', A('agri/schemes'), { ...scheme, contactId: ramaiah.contact_id })).status, 404);
    assert.equal((await refused('POST', A('agri/schemes'), { ...scheme, benefits: [...scheme.benefits, { kind: 'target', minQuantity: '150', amount: '700' }] })).status, 400);
    const made = await request('POST', A('agri/schemes'), scheme, 201);
    const receive = (supplier, lines) => request('POST', A('documents'), { kind: 'purchase', requestKey: key(), locationId: shop.id, contactId: supplier.id, lines }, 201);
    // 80 bags, then 60 with 10 of them free (50 paid), from Coromandel; 40 from IFFCO (another supplier); 5 of the first 80 sent back.
    const p1 = await receive(coromandel, [{ skuId: dap.id, quantity: '80', unitPrice: '1290' }]);
    await receive(coromandel, [{ skuId: dap.id, quantity: '50', freeQuantity: '10', unitPrice: '1290' }]);
    await receive(iffco, [{ skuId: dap.id, quantity: '40', unitPrice: '1295' }]);
    const before = await receive(coromandel, [{ skuId: dap.id, quantity: '30', unitPrice: '1290' }]);
    await pool.query('UPDATE business_documents SET created_at=$2 WHERE id=$1', [before.id, momentAt(daysFrom(-40), '12:00')]);
    const p1Line = await one('SELECT id FROM business_document_lines WHERE document_id=$1', [p1.id]);
    await request('POST', A(`documents/${p1.id}/returns`), { requestKey: key(), reason: 'Torn bags', lines: [{ lineId: p1Line.id, quantity: '5' }] }, 201);
    let ledger = await keeper('GET', A(`agri/schemes/${made.scheme.id}`));
    assert.deepEqual([ledger.bought, ledger.earned.rate, ledger.earned.rebate, ledger.earned.target, ledger.earned.money, ledger.earned.gift, ledger.earned.freeGoods],
      ['125.000', '5.00', '625.00', '0.00', '625.00', null, null]);
    assert.deepEqual(ledger.purchases.map((p) => [p.counted, p.earns]), [['75.000', '375.00'], ['50.000', '250.00']]);
    assert.deepEqual(ledger.next.map((n) => [n.kind, n.short]), [['target', '25.000'], ['free_goods', '75.000'], ['gift', '25.000']]);
    // 30 more: 155 bags reach the target and the gift.
    await receive(coromandel, [{ skuId: dap.id, quantity: '30', unitPrice: '1290' }]);
    ledger = await keeper('GET', A(`agri/schemes/${made.scheme.id}`));
    assert.deepEqual([ledger.bought, ledger.earned.rebate, ledger.earned.target, ledger.earned.money, ledger.earned.gift], ['155.000', '775.00', '500.00', '1275.00', 'Wall clock']);
    // Claims made and received; what is still due.
    await keeper('POST', A(`agri/schemes/${made.scheme.id}/claims`), { kind: 'money', claimedOn: daysFrom(0), amount: '1275' }, 403);
    ledger = await accountant('POST', A(`agri/schemes/${made.scheme.id}/claims`), { kind: 'money', claimedOn: daysFrom(0), reference: 'CLM/KH/118', amount: '1275' }, 201);
    assert.deepEqual([ledger.due.money.claimed, ledger.due.money.awaited, ledger.due.money.due, ledger.due.money.unclaimed], ['1275.00', '1275.00', '1275.00', '0.00']);
    const claim = ledger.claims[0];
    ledger = await accountant('POST', A(`agri/schemes/${made.scheme.id}/claims/${claim.id}/received`), { receivedOn: daysFrom(0), receivedAmount: '1000', receivedReference: 'CN/2026/88' });
    assert.deepEqual([ledger.due.money.received, ledger.due.money.due, ledger.due.money.awaited], ['1000.00', '275.00', '0.00']);
    assert.equal((await refused('POST', A(`agri/schemes/${made.scheme.id}/claims/${claim.id}/received`), { receivedOn: daysFrom(0), receivedAmount: '275' })).status, 409);
    ledger = await request('POST', A(`agri/schemes/${made.scheme.id}/claims`), { kind: 'gift', claimedOn: daysFrom(0), description: 'Wall clock' }, 201);
    ledger = await request('POST', A(`agri/schemes/${made.scheme.id}/claims/${ledger.claims[1].id}/received`), { receivedOn: daysFrom(0) });
    assert.deepEqual(ledger.due.gift, { earned: 'Wall clock', claimed: true, received: true });
    assert.equal((await refused('POST', A(`agri/schemes/${made.scheme.id}/claims`), { kind: 'gift', claimedOn: daysFrom(0) })).status, 400);
    await assert.rejects(pool.query('DELETE FROM agri_scheme_claims WHERE scheme_id=$1', [made.scheme.id]), /never deleted/);
    await assert.rejects(pool.query('UPDATE agri_scheme_claims SET received_amount=1 WHERE id=$1', [claim.id]), /recorded once/);
    assert.ok(await audited('scheme.claim_received', made.scheme.id));
    // The list, for whoever sees purchases.
    assert.equal((await keeper('GET', A('agri/schemes'))).items[0].awaited, 0);
    await cashier('GET', A('agri/schemes'), undefined, 403);
  });

  // --- Other types and owners ---------------------------------------------------------------------------------------------
  await t.test('the new farm-input tools belong to the type, the business and the module', async () => {
    const G = (suffix) => `/businesses/${grocery.id}/${suffix}`;
    for (const route of ['agri/crops', 'agri/season-credits', `agri/form-xiii?from=${daysFrom(0)}&to=${daysFrom(0)}`]) await request('GET', G(route), undefined, 403);
    for (const route of ['agri/kept-apart', 'agri/schemes']) await request('GET', G(route), undefined, 404);
    await other('GET', A('agri/crops'), undefined, 404);
    await other('GET', A(`agri/season-credits/${kharif.season.id}`), undefined, 404);
    await other('POST', `/businesses/${otherAgri.id}/agri/overrides`, { requestKey: key(), kind: 'bag_limit', locationId: shop.id, contactId: ramaiah.contact_id,
      approval: { reason: 'x' } }, 404);
    // Another business's season, override or crop is not this one's.
    assert.equal((await refused('GET', `/businesses/${otherAgri.id}/agri/season-credits/${kharif.season.id}`, undefined, (await signIn(base, 'more-other@test.invalid', password)).token)).status, 404);
  });
});
