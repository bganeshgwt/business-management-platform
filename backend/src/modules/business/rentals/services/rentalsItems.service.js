const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./rentalsCommon');

// Rental items (module "rentals", rental and hire businesses).
//
//   items     each thing hired out, billed as a service item of the catalogue
//             (an existing one counted in services, or one made with it: its
//             name, GST slab and SAC typed with it). Renting goods without an
//             operator is taxed at the rate of a sale of the like goods, so the
//             item's slab is the like goods' slab. Hired one by one (each a
//             unit with its own number) or from a pool of how many the shop
//             has; a motor vehicle, self-drive or with the shop's driver; a
//             meter read at each handover and return; the deposit for each one
//             hired; rates by the hour, day, week and month; a minimum hire; a
//             turnaround time between hires; the late fee after a grace time.
//             A change applies to bookings made after it: a booking keeps the
//             rates and rules it was made at. Switched off, never deleted.
//   units     each unit of an item hired one by one: its name, its
//             registration or serial number, its meter, and whether it is in
//             service, in maintenance (not handed over) or retired (not booked).
//   settings  whether a hirer's photo ID is recorded at every handover, and
//             the shop's terms printed on the booking and handover slips.
// A rental item's hire is billed only from its booking (checkLooseSale).

const { fail, id } = c;
const MAX_RATE = 1000000;
const MAX_DEPOSIT = 10000000;
const MAX_TERMS = 2000;

const ITEMS_SQL = `SELECT i.id,i.sku_id,s.label AS name,s.code AS item_code,s.tax_rate,s.tax_rate_id,s.hsn_code,(s.active AND p.active) AS item_active,
    i.kind,i.pool_quantity,i.vehicle,i.with_driver,i.meter,i.description,i.deposit,i.rate_hour,i.rate_day,i.rate_week,i.rate_month,i.min_hours,i.buffer_minutes,
    i.grace_minutes,i.late_per,i.late_rate,i.sort_order,i.active,i.created_at,i.updated_at,
    COALESCE((SELECT json_agg(json_build_object('id',u.id,'label',u.label,'serial_no',u.serial_no,'meter_reading',u.meter_reading::text,'status',u.status,'status_note',u.status_note)
      ORDER BY u.status='retired',lower(u.label)) FROM rental_units u WHERE u.business_id=i.business_id AND u.item_id=i.id),'[]') AS units,
    (SELECT count(*)::int FROM rental_units u WHERE u.business_id=i.business_id AND u.item_id=i.id AND u.status<>'retired') AS units_in_service,
    COALESCE((SELECT sum(h.quantity) FROM rental_holds(i.business_id,i.id) h WHERE h.part='out'),0)::int AS out_now
  FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  WHERE i.business_id=$1`;

repo.addLists({
  // Every rental item with its units and what is out now, in the shop's order.
  'rental-items': { sql: ITEMS_SQL, search: ['name', 'item_code', 'description', 'units'], filters: { kind: 'kind', active: 'active', vehicle: 'vehicle' },
    order: 'active DESC,sort_order,lower(name),id' },
});

async function load(db, business) {
  const items = await repo.all(db, `SELECT * FROM (${ITEMS_SQL}) x ORDER BY active DESC,sort_order,lower(name),id LIMIT 500`, [business.id]);
  return { items, settings: settingsShape(await c.settingsOf(db, business.id)) };
}

async function list(business) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  return load(repo.pool, business);
}

// --- Reading an item as typed ------------------------------------------------------------------------

const rate = (value, name) => (c.given(value) ? core.decimal(value, name, 2, 0.01, MAX_RATE) : null);

// The rates (the whole set when given), deposit and rules as typed; `current` keeps what is left out (an update).
function readRules(body, kind, vehicle, current = null) {
  const rates = body.rates === undefined && current ? { hour: current.rate_hour, day: current.rate_day, week: current.rate_week, month: current.rate_month } : body.rates || {};
  if (typeof rates !== 'object' || Array.isArray(rates)) fail('Give the rates by the hour, day, week or month');
  const read = {
    rateHour: rate(rates.hour, 'Rate for an hour'), rateDay: rate(rates.day, 'Rate for a day'), rateWeek: rate(rates.week, 'Rate for a week'), rateMonth: rate(rates.month, 'Rate for a month'),
  };
  if ([read.rateHour, read.rateDay, read.rateWeek, read.rateMonth].every((r) => r === null)) fail('Give at least one rate: by the hour, day, week or month');
  read.deposit = body.deposit === undefined && current ? Number(current.deposit) : c.given(body.deposit) ? core.decimal(body.deposit, 'Deposit for each one', 2, 0, MAX_DEPOSIT) : 0;
  read.minHours = body.minHours === undefined && current ? Number(current.min_hours) : c.given(body.minHours) ? c.whole(body.minHours, 'Minimum hire (hours)', 0, 2160) : 0;
  read.bufferMinutes = body.bufferMinutes === undefined && current ? Number(current.buffer_minutes)
    : c.given(body.bufferMinutes) ? c.whole(body.bufferMinutes, 'Turnaround time (minutes)', 0, 10080) : 0;
  read.graceMinutes = body.graceMinutes === undefined && current ? Number(current.grace_minutes)
    : c.given(body.graceMinutes) ? c.whole(body.graceMinutes, 'Grace time (minutes)', 0, 1440) : 0;
  // Late: by the hour while there is an hour rate, else by the day, unless chosen.
  const latePer = body.latePer === undefined ? (current ? current.late_per : read.rateHour !== null ? 'hour' : read.rateDay !== null ? 'day' : 'none')
    : v.requiredEnum(body.latePer, 'Late fee', c.LATE_PER);
  const lateRate = latePer === 'none' ? null : body.lateRate === undefined && current ? (current.late_rate === null ? null : Number(current.late_rate)) : rate(body.lateRate, 'Late fee');
  if (latePer === 'hour' && lateRate === null && read.rateHour === null) fail('Give the late fee for each hour late, or a rate for an hour');
  if (latePer === 'day' && lateRate === null && read.rateDay === null) fail('Give the late fee for each day late, or a rate for a day');
  read.latePer = latePer;
  read.lateRate = lateRate;
  read.description = body.description === undefined && current ? current.description : c.optionalText(body.description, 'Description', 300);
  read.sortOrder = c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : current ? Number(current.sort_order) : 0;
  // A vehicle's meter is its odometer; another unit may have an hour meter or none; a pool has none.
  if (kind === 'pool') read.meter = null;
  else if (vehicle) read.meter = 'km';
  else read.meter = body.meter === undefined && current ? current.meter : c.given(body.meter) ? v.requiredEnum(body.meter, 'Meter', c.METERS) : null;
  read.withDriver = vehicle ? (body.withDriver === undefined && current ? current.with_driver : v.requiredBoolean(body.withDriver, 'Hired with the shop\'s driver', false)) : false;
  return read;
}

// A free item code for a new rental item's service item: RNT-01, RNT-02 ….
async function freeCode(db, businessId) {
  const count = await repo.one(db, 'SELECT count(*)::int AS n FROM rental_items WHERE business_id=$1', [businessId]);
  for (let n = count.n + 1; ; n += 1) {
    const code = `RNT-${String(n).padStart(2, '0')}`;
    if (!await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [businessId, code])) return code;
  }
}

// Units as typed with a new item, or one added: { label, serialNo?, meterReading? }.
function readUnit(raw, vehicle, meter, name = 'Unit') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  return {
    label: v.requiredString(typeof raw.label === 'string' ? raw.label : '', `${name}: name`, 80),
    serialNo: c.readSerial(raw.serialNo, vehicle),
    meterReading: meter && c.given(raw.meterReading) ? c.readMeter(raw.meterReading, `${name}: meter reading`) : null,
  };
}

async function insertUnit(db, business, user, item, unit) {
  if (unit.serialNo) {
    const clash = await repo.one(db, 'SELECT label FROM rental_units WHERE business_id=$1 AND serial_no=$2', [business.id, unit.serialNo]);
    if (clash) fail(`${unit.serialNo} is already ${clash.label}`, 409);
  }
  const same = await repo.one(db, 'SELECT 1 FROM rental_units WHERE business_id=$1 AND item_id=$2 AND lower(label)=lower($3)', [business.id, item.id, unit.label]);
  if (same) fail(`${item.name || 'This item'} already has a unit called ${unit.label}`, 409);
  const row = await repo.one(db, 'INSERT INTO rental_units(business_id,item_id,label,serial_no,meter_reading,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *',
    [business.id, item.id, unit.label, unit.serialNo, unit.meterReading, user.id]);
  await repo.audit(db, business.id, user.id, 'rental_unit.created', row.id, { item: item.name, label: row.label, serialNo: row.serial_no, meterReading: row.meter_reading });
  return row;
}

// body: { skuId } an existing service item counted in services, or { item: { name, taxRateId?, hsnCode?, code? } } for a new one;
//   kind: unit | pool, poolQuantity (a pool), vehicle?: car | motorcycle | other, withDriver?, meter? (km | hours), description?,
//   deposit?, rates: { hour?, day?, week?, month? }, minHours?, bufferMinutes?, graceMinutes?, latePer?, lateRate?, sortOrder?,
//   units?: [{ label, serialNo?, meterReading? }] (an item hired one by one)
async function createItem(business, user, body) {
  c.requireRentals(business);
  await access.require(business, 'catalog.edit');
  const kind = v.requiredEnum(body.kind, 'Hired out', ['unit', 'pool']);
  const vehicle = kind === 'unit' && c.given(body.vehicle) ? v.requiredEnum(body.vehicle, 'Vehicle', c.VEHICLES) : null;
  if (kind === 'pool' && c.given(body.vehicle)) fail('A vehicle is hired one by one, each with its registration');
  const rules = readRules(body, kind, vehicle);
  const poolQuantity = kind === 'pool' ? c.whole(body.poolQuantity, 'How many the shop has', 1, 1000000) : null;
  const units = kind === 'unit' && body.units !== undefined && body.units !== null ? v.requiredArray(body.units, 'Units').map((u, i) => readUnit(u, vehicle, rules.meter, `Unit ${i + 1}`)) : [];
  if (kind === 'pool' && body.units !== undefined && body.units !== null && body.units.length) fail('A pool keeps how many it has, not units');
  if (units.length > 200) fail('Add at most 200 units at once');
  const insert = async (db, sku) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    if (await repo.one(db, 'SELECT 1 FROM rental_items WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id])) fail(`${sku.label} is already a rental item`, 409);
    const item = await repo.one(db, `INSERT INTO rental_items(business_id,sku_id,kind,pool_quantity,vehicle,with_driver,meter,description,deposit,rate_hour,rate_day,rate_week,rate_month,
        min_hours,buffer_minutes,grace_minutes,late_per,late_rate,sort_order,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20) RETURNING *`,
    [business.id, sku.id, kind, poolQuantity, vehicle, rules.withDriver, rules.meter, rules.description, rules.deposit.toFixed(2), rules.rateHour, rules.rateDay, rules.rateWeek,
      rules.rateMonth, rules.minHours, rules.bufferMinutes, rules.graceMinutes, rules.latePer, rules.lateRate, rules.sortOrder, user.id]);
    for (const unit of units) await insertUnit(db, business, user, { ...item, name: sku.label }, unit);
    await repo.audit(db, business.id, user.id, 'rental_item.created', item.id, { name: sku.label, kind, poolQuantity, vehicle, withDriver: rules.withDriver, deposit: item.deposit,
      rates: { hour: item.rate_hour, day: item.rate_day, week: item.rate_week, month: item.rate_month }, latePer: item.late_per, lateRate: item.late_rate, units: units.length });
    return item;
  };
  if (c.given(body.skuId)) {
    return repo.transaction(async (db) => {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.is_kit,s.unit,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(body.skuId, 'Service item')]);
      if (!sku) fail('Service item not found', 404);
      if (sku.kind !== 'service' || sku.is_kit || sku.unit !== 'service') fail(`${sku.label} is not a service counted in services: a rental item is billed as one`);
      await insert(db, sku);
      return load(db, business);
    });
  }
  const typed = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? body.item : null;
  if (!typed) fail('Give the rental item\'s service item: a new one with its name and GST slab, or an existing service item');
  const name = v.requiredString(typeof typed.name === 'string' ? typed.name : '', 'Name', 150);
  // A new service item: priced by the rental item's rates, so its own price is nil; its
  // GST slab is the one chosen (the like goods' slab), or the business's default slab.
  const code = c.given(typed.code) ? String(typed.code).trim().toUpperCase() : await freeCode(repo.pool, business.id);
  const slab = c.given(typed.taxRateId) ? id(typed.taxRateId, 'GST slab')
    : (await repo.one(repo.pool, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND is_default AND active', [business.id]))?.id;
  if (!slab) fail('Choose the GST slab of what is hired out');
  await core.createCatalog(business, user, { kind: 'service', unit: 'service', name, label: name, code, price: '0', taxRateId: slab, hsnCode: typed.hsnCode },
    async (db, sku) => { await insert(db, sku); });
  return load(repo.pool, business);
}

// The most of an item held at once from now on by bookings reserved or out.
const committed = async (db, business, itemId) => (await repo.one(db, `SELECT rental_pool_peak($1,$2,now(),now()+interval '100 days',NULL,NULL) AS n`, [business.id, itemId])).n;

// body: { rates?, deposit?, minHours?, bufferMinutes?, graceMinutes?, latePer?, lateRate?, description?, sortOrder?, withDriver?, meter?, poolQuantity?, active? }
// — what is left out stays. Bookings keep what they were made at.
async function updateItem(business, user, itemId, body) {
  c.requireRentals(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, `SELECT i.*,s.label AS name FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
      WHERE i.business_id=$1 AND i.id=$2 FOR UPDATE OF i`, [business.id, id(itemId, 'Rental item')]);
    if (!current) fail('Rental item not found', 404);
    if (body.kind !== undefined && body.kind !== current.kind) fail('A rental item keeps how it is hired out: add another item for the other way');
    if (body.vehicle !== undefined && (body.vehicle || null) !== current.vehicle) fail('A rental item keeps whether it is a vehicle: add another item');
    const rules = readRules(body, current.kind, current.vehicle, current);
    const active = v.requiredBoolean(body.active, 'In use', current.active);
    let poolQuantity = current.pool_quantity;
    if (current.kind === 'pool' && body.poolQuantity !== undefined) {
      poolQuantity = c.whole(body.poolQuantity, 'How many the shop has', 0, 1000000);
      const held = await committed(db, business, current.id);
      if (poolQuantity < held) fail(`Bookings reserved or out hold ${held} of ${current.name} at their busiest: the pool stays at ${held} or more until they are back or changed`, 409);
    }
    await db.query(`UPDATE rental_items SET pool_quantity=$3,with_driver=$4,meter=$5,description=$6,deposit=$7,rate_hour=$8,rate_day=$9,rate_week=$10,rate_month=$11,min_hours=$12,
        buffer_minutes=$13,grace_minutes=$14,late_per=$15,late_rate=$16,sort_order=$17,active=$18,updated_by=$19,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, current.id, poolQuantity, rules.withDriver, rules.meter, rules.description, rules.deposit.toFixed(2), rules.rateHour, rules.rateDay, rules.rateWeek, rules.rateMonth,
      rules.minHours, rules.bufferMinutes, rules.graceMinutes, rules.latePer, rules.lateRate, rules.sortOrder, active, user.id]);
    const text = (x) => (x === null || x === undefined ? null : String(x));
    const money = (x) => (x === null || x === undefined ? null : Number(x).toFixed(2));
    const was = { poolQuantity: text(current.pool_quantity), withDriver: current.with_driver, meter: current.meter, description: current.description, deposit: money(current.deposit),
      rateHour: money(current.rate_hour), rateDay: money(current.rate_day), rateWeek: money(current.rate_week), rateMonth: money(current.rate_month), minHours: Number(current.min_hours),
      bufferMinutes: Number(current.buffer_minutes), graceMinutes: Number(current.grace_minutes), latePer: current.late_per, lateRate: money(current.late_rate), sortOrder: Number(current.sort_order),
      active: current.active };
    const now = { poolQuantity: text(poolQuantity), withDriver: rules.withDriver, meter: rules.meter, description: rules.description, deposit: money(rules.deposit), rateHour: money(rules.rateHour),
      rateDay: money(rules.rateDay), rateWeek: money(rules.rateWeek), rateMonth: money(rules.rateMonth), minHours: rules.minHours, bufferMinutes: rules.bufferMinutes,
      graceMinutes: rules.graceMinutes, latePer: rules.latePer, lateRate: money(rules.lateRate), sortOrder: rules.sortOrder, active };
    const changed = Object.keys(now).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'rental_item.updated', current.id, { name: current.name,
        from: Object.fromEntries(changed.map((k) => [k, was[k]])), to: Object.fromEntries(changed.map((k) => [k, now[k]])) });
    }
    return load(db, business);
  });
}

// body: { label, serialNo?, meterReading? } — a unit of an item hired one by one.
async function addUnit(business, user, itemId, body) {
  c.requireRentals(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const item = await repo.one(db, `SELECT i.*,s.label AS name FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
      WHERE i.business_id=$1 AND i.id=$2`, [business.id, id(itemId, 'Rental item')]);
    if (!item) fail('Rental item not found', 404);
    if (item.kind !== 'unit') fail(`${item.name} is hired from a pool: change how many the shop has instead`);
    await insertUnit(db, business, user, item, readUnit(body, item.vehicle, item.meter));
    return load(db, business);
  });
}

// body: { label?, serialNo?, status?: available | maintenance | retired, statusNote? } — what is left out stays.
// A unit's name and number are the catalogue's (catalog.edit); in service or not, the yard's (rentals.edit).
async function updateUnit(business, user, unitId, body) {
  c.requireRentals(business);
  const naming = body.label !== undefined || body.serialNo !== undefined;
  const status = body.status === undefined ? null : v.requiredEnum(body.status, 'Unit is', ['available', 'maintenance', 'retired']);
  if (naming) await access.require(business, 'catalog.edit');
  if (status) await access.require(business, 'rentals.edit');
  if (!naming && !status) fail('Give the unit\'s new name, number or state');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const unit = await repo.one(db, `SELECT u.*,i.vehicle,i.kind,s.label AS item_name FROM rental_units u JOIN rental_items i ON i.business_id=u.business_id AND i.id=u.item_id
      JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id WHERE u.business_id=$1 AND u.id=$2 FOR UPDATE OF u`, [business.id, id(unitId, 'Unit')]);
    if (!unit) fail('Unit not found', 404);
    const label = body.label === undefined ? unit.label : v.requiredString(typeof body.label === 'string' ? body.label : '', 'Unit name', 80);
    const serialNo = body.serialNo === undefined ? unit.serial_no : c.readSerial(body.serialNo, unit.vehicle);
    const next = status || unit.status;
    const note = next === 'available' ? null : body.statusNote === undefined && next === unit.status ? unit.status_note : c.optionalText(body.statusNote, 'Why', 300);
    if (next !== 'available' && !note) fail(next === 'maintenance' ? 'Say what the maintenance is for' : 'Say why the unit is retired');
    if (serialNo && serialNo !== unit.serial_no) {
      const clash = await repo.one(db, 'SELECT label FROM rental_units WHERE business_id=$1 AND serial_no=$2 AND id<>$3', [business.id, serialNo, unit.id]);
      if (clash) fail(`${serialNo} is already ${clash.label}`, 409);
    }
    if (label.toLowerCase() !== unit.label.toLowerCase()) {
      const same = await repo.one(db, 'SELECT 1 FROM rental_units WHERE business_id=$1 AND item_id=$2 AND lower(label)=lower($3) AND id<>$4', [business.id, unit.item_id, label, unit.id]);
      if (same) fail(`${unit.item_name} already has a unit called ${label}`, 409);
    }
    if (next === 'retired' && unit.status !== 'retired') {
      const held = await repo.one(db, `SELECT * FROM rental_unit_clash($1,$2,$3,now(),now()+interval '100 days',NULL,NULL)`, [business.id, unit.item_id, unit.id]);
      if (held && held.part !== 'back') {
        fail(`${unit.label} is ${held.part === 'out' ? 'out' : 'booked'} on ${held.booking_no} (${held.customer_name}): move that booking to another unit, or wait until it is back, before retiring it`, 409);
      }
    }
    await db.query('UPDATE rental_units SET label=$3,serial_no=$4,status=$5,status_note=$6,updated_by=$7,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, unit.id, label, serialNo, next, note, user.id]);
    const changed = { ...(label !== unit.label ? { label: { from: unit.label, to: label } } : {}), ...(serialNo !== unit.serial_no ? { serialNo: { from: unit.serial_no, to: serialNo } } : {}),
      ...(next !== unit.status || note !== unit.status_note ? { status: { from: unit.status, to: next }, note } : {}) };
    if (Object.keys(changed).length) await repo.audit(db, business.id, user.id, 'rental_unit.updated', unit.id, { item: unit.item_name, unit: label, ...changed });
    return load(db, business);
  });
}

// --- Settings ----------------------------------------------------------------------------------------

const settingsShape = (s) => ({ idRequired: s.id_required, terms: s.terms, updatedAt: s.updated_at });

async function settings(business) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  return settingsShape(await c.settingsOf(repo.pool, business.id));
}

// body: { idRequired?, terms? } — what is left out stays. Bookings print the terms as they are when printed.
async function saveSettings(business, user, body) {
  c.requireRentals(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    const before = await c.settingsOf(db, business.id);
    const next = {
      id_required: body.idRequired === undefined ? before.id_required : v.requiredBoolean(body.idRequired, 'Photo ID at every handover'),
      terms: body.terms === undefined ? before.terms : c.optionalText(body.terms, 'Terms on the slips', MAX_TERMS),
    };
    await db.query(`INSERT INTO rental_settings(business_id,id_required,terms,updated_by) VALUES($1,$2,$3,$4)
      ON CONFLICT (business_id) DO UPDATE SET id_required=EXCLUDED.id_required,terms=EXCLUDED.terms,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, next.id_required, next.terms, user.id]);
    const changed = Object.keys(next).filter((k) => String(before[k] ?? '') !== String(next[k] ?? ''));
    if (changed.length) await repo.audit(db, business.id, user.id, 'rental_settings.updated', null, Object.fromEntries(changed.map((k) => [k, { from: before[k], to: next[k] }])));
    return settingsShape(await c.settingsOf(db, business.id));
  });
}

// A rental item's hire is billed from its booking only: refused on any other bill.
async function checkLooseSale(db, business, lines) {
  const skuIds = [...new Set(lines.map((line) => Number(line.sku.id)))];
  const item = await repo.one(db, `SELECT s.label FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    WHERE i.business_id=$1 AND i.sku_id=ANY($2::bigint[]) ORDER BY s.label LIMIT 1`, [business.id, skuIds]);
  if (item) fail(`${item.label} is hired out from Bookings: its hire is billed when the booking comes back`, 409);
}

module.exports = { ITEMS_SQL, list, load, createItem, updateItem, addUnit, updateUnit, settings, saveSettings, checkLooseSale };
