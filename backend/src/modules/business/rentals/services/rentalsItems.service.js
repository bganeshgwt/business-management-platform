const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./rentalsCommon');
const money = require('./rentalsMoney');

// Rental items (module "rentals", rental and hire businesses).
//
//   items     each thing hired out, billed as a service item of the catalogue
//             (an existing one counted in services, or one made with it: its
//             name, GST slab and SAC typed with it). Renting goods without an
//             operator is taxed at the rate of a sale of the like goods, so the
//             item's slab is the like goods' slab. Hired one by one (each a
//             unit with its own number), from a pool of how many the shop has
//             (counted at each location), or as a kit of pooled parts (billed
//             as the kit or by its parts); a motor vehicle, self-drive or with
//             the shop's driver; a meter read at each handover and return; the
//             deposit for each one hired; rates by the hour, day, week and
//             month; a minimum hire; a turnaround time between hires; the late
//             fee after a grace time (by the hour, the day or slabs, with an
//             optional cap); a kilometre allowance with the extra-kilometre
//             rate and a fuel charge for a vehicle; a class (its checklist and
//             late slabs). A change applies to bookings made after it: a
//             booking keeps the rates and rules it was made at. Switched off,
//             never deleted.
//   units     each unit of an item hired one by one: its name, its
//             registration or serial number, its meter, the location it is
//             kept at, and whether it is in service, in maintenance (not handed
//             over) or retired (not booked). A vehicle also keeps its class (as
//             a driving licence names it), engine, length and fuel (they decide
//             the like goods' slab: a mismatch with its item's slab is shown,
//             and the item's slab stays the one billed), the dates its papers
//             run until, and its service schedule.
//   classes   the shop's classes of what it hires out: the checklist checked
//             at every handover and return of their items, and late fee slabs
//             with a cap for items with none of their own.
//   settings  whether a hirer's photo ID is recorded at every handover, the
//             shop's terms printed on the slips, when the bell warns of a
//             vehicle's papers running out and whether a vehicle with one run
//             out is handed over, and the cancellation slabs.
// A rental item's hire is billed only from its booking (checkLooseSale).

const { fail, id } = c;
const MAX_RATE = 1000000;
const MAX_DEPOSIT = 10000000;
const MAX_TERMS = 2000;
const MAX_PARTS = 30;
const MAX_POINTS = 30;

const ITEMS_SQL = `SELECT i.id,i.sku_id,s.label AS name,s.code AS item_code,s.tax_rate,s.tax_rate_id,s.hsn_code,(s.active AND p.active) AS item_active,
    i.kind,i.pool_quantity,i.vehicle,i.with_driver,i.meter,i.description,i.deposit,i.rate_hour,i.rate_day,i.rate_week,i.rate_month,i.min_hours,i.buffer_minutes,
    i.grace_minutes,i.late_per,i.late_rate,i.late_slabs,i.late_cap,i.kit_billing,i.class_id,k.name AS class_name,i.km_allowance,i.km_per,i.extra_km_rate,i.fuel_per,
    i.fuel_rate,i.tank_litres,i.sort_order,i.active,i.created_at,i.updated_at,
    COALESCE((SELECT json_agg(json_build_object('id',u.id,'label',u.label,'serial_no',u.serial_no,'meter_reading',u.meter_reading::text,'status',u.status,'status_note',u.status_note,
      'location_id',u.location_id,'location_name',ul.name,'vehicle_class',u.vehicle_class,'engine_cc',u.engine_cc,'length_mm',u.length_mm,'fuel_type',u.fuel_type,
      'rc_valid_until',u.rc_valid_until,'permit_valid_until',u.permit_valid_until,'insurance_valid_until',u.insurance_valid_until,'puc_valid_until',u.puc_valid_until,
      'fitness_valid_until',u.fitness_valid_until,'service_per',u.service_per,'service_every',u.service_every,'serviced_at',u.serviced_at,'serviced_meter',u.serviced_meter::text)
      ORDER BY u.status='retired',lower(u.label)) FROM rental_units u JOIN business_locations ul ON ul.business_id=u.business_id AND ul.id=u.location_id
      WHERE u.business_id=i.business_id AND u.item_id=i.id),'[]') AS units,
    COALESCE((SELECT json_agg(json_build_object('location_id',pc.location_id,'location_name',pl.name,'quantity',pc.quantity) ORDER BY pl.id)
      FROM rental_pool_counts pc JOIN business_locations pl ON pl.business_id=pc.business_id AND pl.id=pc.location_id WHERE pc.business_id=i.business_id AND pc.item_id=i.id),'[]') AS counts,
    COALESCE((SELECT json_agg(json_build_object('item_id',kp.part_id,'name',ps.label,'quantity',kp.quantity) ORDER BY lower(ps.label))
      FROM rental_kit_parts kp JOIN rental_items pi ON pi.business_id=kp.business_id AND pi.id=kp.part_id JOIN catalog_skus ps ON ps.business_id=pi.business_id AND ps.id=pi.sku_id
      WHERE kp.business_id=i.business_id AND kp.kit_id=i.id),'[]') AS parts,
    (SELECT count(*)::int FROM rental_units u WHERE u.business_id=i.business_id AND u.item_id=i.id AND u.status<>'retired') AS units_in_service,
    COALESCE((SELECT sum(h.quantity) FROM rental_holds(i.business_id,i.id) h WHERE h.part='out'),0)::int AS out_now
  FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  LEFT JOIN rental_classes k ON k.business_id=i.business_id AND k.id=i.class_id
  WHERE i.business_id=$1`;

repo.addLists({
  // Every rental item with its units and what is out now, in the shop's order.
  'rental-items': { sql: ITEMS_SQL, search: ['name', 'item_code', 'description', 'units'], filters: { kind: 'kind', active: 'active', vehicle: 'vehicle' },
    order: 'active DESC,sort_order,lower(name),id' },
});

// A vehicle unit's slab by its facts, against its item's: the item's stays the one billed.
function withSlabCheck(item) {
  const units = (item.units || []).map((u) => {
    const slab = item.vehicle && !item.with_driver ? money.vehicleSlab({ vehicle: item.vehicle, fuel: u.fuel_type, cc: u.engine_cc, length: u.length_mm }) : null;
    const matches = slab === null ? null : slab === Number(item.tax_rate);
    return { ...u, slab, slab_matches: matches, slab_warning: matches === false
      ? `${u.label}'s engine, length and fuel make renting it out ${slab}% (the like goods' rate), but ${item.name} is billed at ${Number(item.tax_rate)}%: check the item's GST slab with an accountant`
      : null };
  });
  return { ...item, units };
}

const CLASSES_SQL = `SELECT k.id,k.name,k.checklist,k.late_slabs,k.late_cap,k.active,k.updated_at,
    (SELECT count(*)::int FROM rental_items i WHERE i.business_id=k.business_id AND i.class_id=k.id) AS items
  FROM rental_classes k WHERE k.business_id=$1 ORDER BY k.active DESC,lower(k.name),k.id`;

async function load(db, business) {
  const items = (await repo.all(db, `SELECT * FROM (${ITEMS_SQL}) x ORDER BY active DESC,sort_order,lower(name),id LIMIT 500`, [business.id])).map(withSlabCheck);
  const classes = await repo.all(db, CLASSES_SQL, [business.id]);
  const warnings = items.filter((i) => i.active).flatMap((i) => i.units.filter((u) => u.status !== 'retired' && u.slab_warning).map((u) => u.slab_warning));
  return { items, classes, warnings, settings: settingsShape(await c.settingsOf(db, business.id)) };
}

async function list(business) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  return load(repo.pool, business);
}

// --- Reading an item as typed ------------------------------------------------------------------------

const rate = (value, name) => (c.given(value) ? core.decimal(value, name, 2, 0.01, MAX_RATE) : null);
const kept = (body, key, current, column, read) => (body[key] === undefined && current ? current[column] : read(body[key]));
const numberOr = (x) => (x === null || x === undefined ? null : Number(x));

// The rates (the whole set when given), deposit and rules as typed; `current` keeps what is left out (an update).
// `classOf` is the class the item is in (its late slabs stand in for the item's).
function readRules(body, kind, vehicle, current = null, { kitBilling = null, classOf = null } = {}) {
  const rates = body.rates === undefined && current ? { hour: current.rate_hour, day: current.rate_day, week: current.rate_week, month: current.rate_month } : body.rates || {};
  if (typeof rates !== 'object' || Array.isArray(rates)) fail('Give the rates by the hour, day, week or month');
  const read = {
    rateHour: rate(rates.hour, 'Rate for an hour'), rateDay: rate(rates.day, 'Rate for a day'), rateWeek: rate(rates.week, 'Rate for a week'), rateMonth: rate(rates.month, 'Rate for a month'),
  };
  const noRates = [read.rateHour, read.rateDay, read.rateWeek, read.rateMonth].every((r) => r === null);
  if (noRates && kitBilling !== 'parts') fail(kind === 'kit' ? 'A kit billed as itself has its own rates: give at least one, or bill it by its parts' : 'Give at least one rate: by the hour, day, week or month');
  read.deposit = body.deposit === undefined && current ? Number(current.deposit) : c.given(body.deposit) ? core.decimal(body.deposit, 'Deposit for each one', 2, 0, MAX_DEPOSIT) : 0;
  read.minHours = body.minHours === undefined && current ? Number(current.min_hours) : c.given(body.minHours) ? c.whole(body.minHours, 'Minimum hire (hours)', 0, 2160) : 0;
  read.bufferMinutes = body.bufferMinutes === undefined && current ? Number(current.buffer_minutes)
    : c.given(body.bufferMinutes) ? c.whole(body.bufferMinutes, 'Turnaround time (minutes)', 0, 10080) : 0;
  read.graceMinutes = body.graceMinutes === undefined && current ? Number(current.grace_minutes)
    : c.given(body.graceMinutes) ? c.whole(body.graceMinutes, 'Grace time (minutes)', 0, 1440) : 0;
  // Late: by the hour while there is an hour rate, else by the day, unless chosen. A kit's late fee is its parts'.
  const latePer = kind === 'kit' ? 'none' : body.latePer === undefined ? (current ? current.late_per : read.rateHour !== null ? 'hour' : read.rateDay !== null ? 'day' : 'none')
    : v.requiredEnum(body.latePer, 'Late fee', c.LATE_PER);
  if (kind === 'kit' && c.given(body.latePer) && body.latePer !== 'none') fail('A kit\'s late fee is its parts\', each as its item sets it');
  const lateRate = latePer === 'none' ? null : body.lateRate === undefined && current ? numberOr(current.late_rate) : rate(body.lateRate, 'Late fee');
  if (latePer === 'hour' && lateRate === null && read.rateHour === null) fail('Give the late fee for each hour late, or a rate for an hour');
  if (latePer === 'day' && lateRate === null && read.rateDay === null) fail('Give the late fee for each day late, or a rate for a day');
  read.lateSlabs = latePer !== 'slabs' ? null : body.lateSlabs === undefined && current ? current.late_slabs : c.readLateSlabs(body.lateSlabs);
  if (latePer === 'slabs') {
    const slabs = read.lateSlabs || classOf?.late_slabs || null;
    if (!slabs) fail('Give the late fee slabs, or put the item in a class that has them');
    if (slabs.some((s) => Number(s.times) > 0) && lateRate === null && read.rateHour === null) fail('A slab that is a multiple of the hourly rate needs a rate for an hour, or the late fee for each hour');
  }
  read.lateCap = latePer === 'none' ? null : kept(body, 'lateCap', current, 'late_cap', (x) => rate(x, 'Most late fee for each one'));
  read.latePer = latePer;
  read.lateRate = lateRate;
  read.description = body.description === undefined && current ? current.description : c.optionalText(body.description, 'Description', 300);
  read.sortOrder = c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : current ? Number(current.sort_order) : 0;
  // A vehicle's meter is its odometer; another unit may have an hour meter or none; a pool or a kit has none.
  if (kind !== 'unit') read.meter = null;
  else if (vehicle) read.meter = 'km';
  else read.meter = body.meter === undefined && current ? current.meter : c.given(body.meter) ? v.requiredEnum(body.meter, 'Meter', c.METERS) : null;
  read.withDriver = vehicle ? (body.withDriver === undefined && current ? current.with_driver : v.requiredBoolean(body.withDriver, 'Hired with the shop\'s driver', false)) : false;
  // Kilometres: an allowance a day or a booking, and the rate for each one beyond it (an odometer only).
  const km = body.km === undefined ? (current?.km_per ? { allowance: current.km_allowance, per: current.km_per, rate: current.extra_km_rate } : null) : body.km;
  if (km && (typeof km !== 'object' || Array.isArray(km))) fail('Give the kilometre allowance as { allowance, per, rate }');
  if (km && c.given(km.per)) {
    if (read.meter !== 'km') fail('A kilometre allowance is for a unit read by its odometer');
    read.kmPer = v.requiredEnum(km.per, 'Kilometres free each', ['day', 'booking']);
    read.kmAllowance = c.whole(km.allowance ?? 0, 'Kilometres free', 0, 100000);
    read.extraKmRate = rate(km.rate, 'Rate for each extra kilometre');
    if (read.extraKmRate === null) fail('Give the rate for each kilometre beyond the allowance');
  } else {
    read.kmPer = null; read.kmAllowance = null; read.extraKmRate = null;
  }
  // Fuel short at the return: by the eighth of a tank, or by the litre with the tank's size (a vehicle only).
  const fuel = body.fuel === undefined ? (current?.fuel_per ? { per: current.fuel_per, rate: current.fuel_rate, tankLitres: current.tank_litres } : null) : body.fuel;
  if (fuel && (typeof fuel !== 'object' || Array.isArray(fuel))) fail('Give the fuel charge as { per, rate, tankLitres? }');
  if (fuel && c.given(fuel.per)) {
    if (!vehicle) fail('A fuel charge is for a vehicle');
    read.fuelPer = v.requiredEnum(fuel.per, 'Fuel charged by', ['eighth', 'litre']);
    read.fuelRate = rate(fuel.rate, read.fuelPer === 'eighth' ? 'Charge for each eighth of a tank' : 'Charge for each litre');
    if (read.fuelRate === null) fail(read.fuelPer === 'eighth' ? 'Give the charge for each eighth of a tank short' : 'Give the charge for each litre short');
    read.tankLitres = c.given(fuel.tankLitres) ? core.decimal(fuel.tankLitres, 'Tank size (litres)', 1, 0.1, 99999) : null;
    if (read.fuelPer === 'litre' && read.tankLitres === null) fail('Give the tank\'s size in litres: an eighth of it is charged for each eighth short');
  } else {
    read.fuelPer = null; read.fuelRate = null; read.tankLitres = null;
  }
  return read;
}

// The class chosen (one of the business's, in use), or none; `current` keeps the item's when left out.
async function readClass(db, business, body, current = null) {
  if (body.classId === undefined) return current?.class_id ? repo.one(db, 'SELECT * FROM rental_classes WHERE business_id=$1 AND id=$2', [business.id, current.class_id]) : null;
  if (!c.given(body.classId)) return null;
  const found = await repo.one(db, 'SELECT * FROM rental_classes WHERE business_id=$1 AND id=$2', [business.id, id(body.classId, 'Class')]);
  if (!found) fail('Class not found', 404);
  if (!found.active && Number(found.id) !== Number(current?.class_id)) fail(`${found.name} is switched off: switch it on to put items in it`, 409);
  return found;
}

// A kit's parts as typed: [{ itemId (an item from a pool), quantity (in one kit) }].
async function readParts(db, business, value, kitId = null) {
  const list = v.requiredArray(value, 'Parts of the kit');
  if (!list.length) fail('A kit has at least one part');
  if (list.length > MAX_PARTS) fail(`A kit has at most ${MAX_PARTS} parts`);
  const parts = list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Part ${index + 1} must be an object`);
    return { itemId: id(raw.itemId, `Part ${index + 1}: item`), quantity: c.whole(raw.quantity, `Part ${index + 1}: how many in one kit`, 1, 10000) };
  });
  if (new Set(parts.map((p) => p.itemId)).size !== parts.length) fail('Name each part once, with how many of it are in one kit');
  const rows = await repo.all(db, `SELECT i.id,i.kind,i.active,s.label AS name FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    WHERE i.business_id=$1 AND i.id=ANY($2::bigint[])`, [business.id, parts.map((p) => p.itemId)]);
  for (const part of parts) {
    const row = rows.find((r) => Number(r.id) === part.itemId);
    if (!row || Number(row.id) === Number(kitId)) fail('Part not found', 404);
    if (row.kind !== 'pool') fail(`${row.name} is ${row.kind === 'kit' ? 'a kit' : 'hired one by one'}: a kit's parts are items from a pool (book a unit as its own line)`);
    if (!row.active) fail(`${row.name} is switched off: switch it on to put it in a kit`, 409);
    part.name = row.name;
  }
  return parts;
}

async function saveParts(db, business, user, kitId, parts) {
  await db.query('DELETE FROM rental_kit_parts WHERE business_id=$1 AND kit_id=$2', [business.id, kitId]);
  for (const part of parts) {
    await db.query('INSERT INTO rental_kit_parts(business_id,kit_id,part_id,quantity,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, kitId, part.itemId, part.quantity, user.id]);
  }
}

// A free item code for a new rental item's service item: RNT-01, RNT-02 ….
async function freeCode(db, businessId) {
  const count = await repo.one(db, 'SELECT count(*)::int AS n FROM rental_items WHERE business_id=$1', [businessId]);
  for (let n = count.n + 1; ; n += 1) {
    const code = `RNT-${String(n).padStart(2, '0')}`;
    if (!await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [businessId, code])) return code;
  }
}

// A location of the business in use, as chosen; the first one when left out.
async function readLocation(db, business, value, name = 'Location') {
  if (!c.given(value)) return c.firstLocation(db, business.id);
  const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, id(value, name)]);
  if (!location) fail('Location not found', 404);
  access.requireLocation(business, location.id);
  return location.id;
}

// Units as typed with a new item, or one added: { label, serialNo?, meterReading?, locationId? }.
function readUnit(raw, vehicle, meter, name = 'Unit') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  return {
    label: v.requiredString(typeof raw.label === 'string' ? raw.label : '', `${name}: name`, 80),
    serialNo: c.readSerial(raw.serialNo, vehicle),
    meterReading: meter && c.given(raw.meterReading) ? c.readMeter(raw.meterReading, `${name}: meter reading`) : null,
    locationId: raw.locationId,
  };
}

async function insertUnit(db, business, user, item, unit) {
  if (unit.serialNo) {
    const clash = await repo.one(db, 'SELECT label FROM rental_units WHERE business_id=$1 AND serial_no=$2', [business.id, unit.serialNo]);
    if (clash) fail(`${unit.serialNo} is already ${clash.label}`, 409);
  }
  const same = await repo.one(db, 'SELECT 1 FROM rental_units WHERE business_id=$1 AND item_id=$2 AND lower(label)=lower($3)', [business.id, item.id, unit.label]);
  if (same) fail(`${item.name || 'This item'} already has a unit called ${unit.label}`, 409);
  const locationId = await readLocation(db, business, unit.locationId, 'Unit kept at');
  const row = await repo.one(db, 'INSERT INTO rental_units(business_id,item_id,label,serial_no,meter_reading,location_id,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *',
    [business.id, item.id, unit.label, unit.serialNo, unit.meterReading, locationId, user.id]);
  await repo.audit(db, business.id, user.id, 'rental_unit.created', row.id, { item: item.name, label: row.label, serialNo: row.serial_no, meterReading: row.meter_reading, locationId });
  return row;
}

// A pool's count at a location set; refused below what bookings at that location hold from now on at their busiest.
async function setCount(db, business, item, locationId, quantity) {
  const held = (await repo.one(db, `SELECT rental_location_peak($1,$2,$3,now(),now()+interval '100 days',NULL,NULL) AS n`, [business.id, item.id, locationId])).n;
  const place = await repo.one(db, 'SELECT name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId]);
  if (quantity < held) {
    fail(`Bookings reserved or out hold ${held} of ${item.name} at their busiest${place ? ` at ${place.name}` : ''}: the pool stays at ${held} or more until they are back or changed`, 409);
  }
  await db.query(`INSERT INTO rental_pool_counts(business_id,item_id,location_id,quantity) VALUES($1,$2,$3,$4)
    ON CONFLICT (business_id,item_id,location_id) DO UPDATE SET quantity=EXCLUDED.quantity`, [business.id, item.id, locationId, quantity]);
}

const itemRow = (business, sku, kind, poolQuantity, vehicle, rules, extra) => [business.id, sku.id, kind, poolQuantity, vehicle, rules.withDriver, rules.meter, rules.description,
  rules.deposit.toFixed(2), rules.rateHour, rules.rateDay, rules.rateWeek, rules.rateMonth, rules.minHours, rules.bufferMinutes, rules.graceMinutes, rules.latePer, rules.lateRate,
  rules.sortOrder, extra.userId, extra.kitBilling, extra.classId, rules.lateSlabs === null ? null : JSON.stringify(rules.lateSlabs), rules.lateCap, rules.kmAllowance, rules.kmPer,
  rules.extraKmRate, rules.fuelPer, rules.fuelRate, rules.tankLitres];

// body: { skuId } an existing service item counted in services, or { item: { name, taxRateId?, hsnCode?, code? } } for a new one;
//   kind: unit | pool | kit, poolQuantity and locationId? (a pool), kitBilling: kit | parts and parts: [{ itemId, quantity }] (a kit),
//   vehicle?: car | motorcycle | other, withDriver?, meter? (km | hours), classId?, description?, deposit?, rates: { hour?, day?, week?, month? },
//   minHours?, bufferMinutes?, graceMinutes?, latePer? (none | hour | day | slabs), lateRate?, lateSlabs?: [{ from, flat, times }], lateCap?,
//   km?: { allowance, per: day | booking, rate }, fuel?: { per: eighth | litre, rate, tankLitres? }, sortOrder?,
//   units?: [{ label, serialNo?, meterReading?, locationId? }] (an item hired one by one)
async function createItem(business, user, body) {
  c.requireRentals(business);
  await access.require(business, 'catalog.edit');
  const kind = v.requiredEnum(body.kind, 'Hired out', ['unit', 'pool', 'kit']);
  const vehicle = kind === 'unit' && c.given(body.vehicle) ? v.requiredEnum(body.vehicle, 'Vehicle', c.VEHICLES) : null;
  if (kind !== 'unit' && c.given(body.vehicle)) fail('A vehicle is hired one by one, each with its registration');
  const kitBilling = kind === 'kit' ? v.requiredEnum(body.kitBilling, 'A kit is billed', ['kit', 'parts']) : null;
  const classOf = await readClass(repo.pool, business, body);
  const rules = readRules(body, kind, vehicle, null, { kitBilling, classOf });
  const poolQuantity = kind === 'pool' ? c.whole(body.poolQuantity, 'How many the shop has', 1, 1000000) : null;
  const units = kind === 'unit' && body.units !== undefined && body.units !== null ? v.requiredArray(body.units, 'Units').map((u, i) => readUnit(u, vehicle, rules.meter, `Unit ${i + 1}`)) : [];
  if (kind !== 'unit' && body.units !== undefined && body.units !== null && body.units.length) fail(kind === 'pool' ? 'A pool keeps how many it has, not units' : 'A kit is made of its parts, not units');
  if (units.length > 200) fail('Add at most 200 units at once');
  const parts = kind === 'kit' ? await readParts(repo.pool, business, body.parts) : [];
  const insert = async (db, sku) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    if (await repo.one(db, 'SELECT 1 FROM rental_items WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id])) fail(`${sku.label} is already a rental item`, 409);
    const item = await repo.one(db, `INSERT INTO rental_items(business_id,sku_id,kind,pool_quantity,vehicle,with_driver,meter,description,deposit,rate_hour,rate_day,rate_week,rate_month,
        min_hours,buffer_minutes,grace_minutes,late_per,late_rate,sort_order,created_by,updated_by,kit_billing,class_id,late_slabs,late_cap,km_allowance,km_per,extra_km_rate,
        fuel_per,fuel_rate,tank_litres)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *`,
    itemRow(business, sku, kind, poolQuantity, vehicle, rules, { userId: user.id, kitBilling, classId: classOf?.id || null }));
    // A new pool starts at the first location; elsewhere when chosen.
    if (kind === 'pool' && c.given(body.locationId)) {
      const locationId = await readLocation(db, business, body.locationId, 'Pool kept at');
      const first = await c.firstLocation(db, business.id);
      if (Number(locationId) !== Number(first)) {
        await db.query('UPDATE rental_pool_counts SET quantity=0 WHERE business_id=$1 AND item_id=$2 AND location_id=$3', [business.id, item.id, first]);
        await setCount(db, business, { ...item, name: sku.label }, locationId, poolQuantity);
      }
    }
    if (kind === 'kit') await saveParts(db, business, user, item.id, parts);
    for (const unit of units) await insertUnit(db, business, user, { ...item, name: sku.label }, unit);
    await repo.audit(db, business.id, user.id, 'rental_item.created', item.id, { name: sku.label, kind, poolQuantity, vehicle, withDriver: rules.withDriver, deposit: item.deposit,
      rates: { hour: item.rate_hour, day: item.rate_day, week: item.rate_week, month: item.rate_month }, latePer: item.late_per, lateRate: item.late_rate, units: units.length,
      ...(kind === 'kit' ? { kitBilling, parts: parts.map((p) => ({ name: p.name, quantity: p.quantity })) } : {}), classId: classOf?.id || null,
      lateSlabs: rules.lateSlabs, lateCap: rules.lateCap, km: rules.kmPer ? { allowance: rules.kmAllowance, per: rules.kmPer, rate: rules.extraKmRate } : null,
      fuel: rules.fuelPer ? { per: rules.fuelPer, rate: rules.fuelRate, tankLitres: rules.tankLitres } : null });
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

// body: { rates?, deposit?, minHours?, bufferMinutes?, graceMinutes?, latePer?, lateRate?, lateSlabs?, lateCap?, km?, fuel?, classId?, description?, sortOrder?,
//   withDriver?, meter?, poolQuantity? with locationId? (a pool: that location's count), kitBilling?, parts? (a kit), active? } — what is left out stays.
// Bookings keep what they were made at.
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
    const kitBilling = current.kind === 'kit' ? (body.kitBilling === undefined ? current.kit_billing : v.requiredEnum(body.kitBilling, 'A kit is billed', ['kit', 'parts'])) : null;
    const classOf = await readClass(db, business, body, current);
    const rules = readRules(body, current.kind, current.vehicle, current, { kitBilling, classOf });
    const active = v.requiredBoolean(body.active, 'In use', current.active);
    if (current.kind === 'pool' && body.poolQuantity !== undefined) {
      const quantity = c.whole(body.poolQuantity, 'How many the shop has', 0, 1000000);
      const locations = await repo.all(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND active ORDER BY id', [business.id]);
      if (locations.length > 1 && !c.given(body.locationId)) fail('Say which location\'s count this is: the pool is counted at each location');
      await setCount(db, business, current, await readLocation(db, business, body.locationId, 'Pool kept at'), quantity);
    }
    const parts = current.kind === 'kit' && body.parts !== undefined ? await readParts(db, business, body.parts, current.id) : null;
    if (parts) await saveParts(db, business, user, current.id, parts);
    await db.query(`UPDATE rental_items SET with_driver=$3,meter=$4,description=$5,deposit=$6,rate_hour=$7,rate_day=$8,rate_week=$9,rate_month=$10,min_hours=$11,
        buffer_minutes=$12,grace_minutes=$13,late_per=$14,late_rate=$15,sort_order=$16,active=$17,updated_by=$18,updated_at=now(),kit_billing=$19,class_id=$20,late_slabs=$21,
        late_cap=$22,km_allowance=$23,km_per=$24,extra_km_rate=$25,fuel_per=$26,fuel_rate=$27,tank_litres=$28 WHERE business_id=$1 AND id=$2`,
    [business.id, current.id, rules.withDriver, rules.meter, rules.description, rules.deposit.toFixed(2), rules.rateHour, rules.rateDay, rules.rateWeek, rules.rateMonth,
      rules.minHours, rules.bufferMinutes, rules.graceMinutes, rules.latePer, rules.lateRate, rules.sortOrder, active, user.id, kitBilling, classOf?.id || null,
      rules.lateSlabs === null ? null : JSON.stringify(rules.lateSlabs), rules.lateCap, rules.kmAllowance, rules.kmPer, rules.extraKmRate, rules.fuelPer, rules.fuelRate, rules.tankLitres]);
    const after = await repo.one(db, 'SELECT * FROM rental_items WHERE business_id=$1 AND id=$2', [business.id, current.id]);
    const text = (x) => (x === null || x === undefined ? null : String(x));
    const asMoney = (x) => (x === null || x === undefined ? null : Number(x).toFixed(2));
    const shape = (r) => ({ poolQuantity: text(r.pool_quantity), withDriver: r.with_driver, meter: r.meter, description: r.description, deposit: asMoney(r.deposit),
      rateHour: asMoney(r.rate_hour), rateDay: asMoney(r.rate_day), rateWeek: asMoney(r.rate_week), rateMonth: asMoney(r.rate_month), minHours: Number(r.min_hours),
      bufferMinutes: Number(r.buffer_minutes), graceMinutes: Number(r.grace_minutes), latePer: r.late_per, lateRate: asMoney(r.late_rate), sortOrder: Number(r.sort_order),
      active: r.active, kitBilling: r.kit_billing, classId: text(r.class_id), lateSlabs: r.late_slabs, lateCap: asMoney(r.late_cap), kmAllowance: r.km_allowance, kmPer: r.km_per,
      extraKmRate: asMoney(r.extra_km_rate), fuelPer: r.fuel_per, fuelRate: asMoney(r.fuel_rate), tankLitres: text(r.tank_litres) });
    const was = shape(current), now = shape(after);
    const changed = Object.keys(now).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
    if (changed.length || parts) {
      await repo.audit(db, business.id, user.id, 'rental_item.updated', current.id, { name: current.name,
        from: Object.fromEntries(changed.map((k) => [k, was[k]])), to: Object.fromEntries(changed.map((k) => [k, now[k]])),
        ...(parts ? { parts: parts.map((p) => ({ name: p.name, quantity: p.quantity })) } : {}) });
    }
    return load(db, business);
  });
}

// body: { label, serialNo?, meterReading?, locationId? } — a unit of an item hired one by one.
async function addUnit(business, user, itemId, body) {
  c.requireRentals(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const item = await repo.one(db, `SELECT i.*,s.label AS name FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
      WHERE i.business_id=$1 AND i.id=$2`, [business.id, id(itemId, 'Rental item')]);
    if (!item) fail('Rental item not found', 404);
    if (item.kind !== 'unit') fail(`${item.name} is ${item.kind === 'kit' ? 'a kit, made of its parts' : 'hired from a pool: change how many the shop has instead'}`);
    await insertUnit(db, business, user, item, readUnit(body, item.vehicle, item.meter));
    return load(db, business);
  });
}

// The vehicle's facts, papers and service schedule as typed (what is left out stays).
function readUnitFacts(body, unit) {
  const facts = {};
  const vehicleOnly = (key) => { if (body[key] !== undefined && !unit.vehicle) fail(`${unit.label} is not a vehicle`); };
  ['vehicleClass', 'engineCc', 'lengthMm', 'fuelType', ...Object.values(c.PAPER_KEYS)].forEach(vehicleOnly);
  if (body.vehicleClass !== undefined) facts.vehicle_class = c.given(body.vehicleClass) ? v.requiredEnum(String(body.vehicleClass).toUpperCase(), 'Class of vehicle', Object.keys(c.VEHICLE_CLASSES)) : null;
  if (body.engineCc !== undefined) facts.engine_cc = c.given(body.engineCc) ? c.whole(body.engineCc, 'Engine (cc)', 1, 20000) : null;
  if (body.lengthMm !== undefined) facts.length_mm = c.given(body.lengthMm) ? c.whole(body.lengthMm, 'Length (mm)', 100, 30000) : null;
  if (body.fuelType !== undefined) facts.fuel_type = c.given(body.fuelType) ? v.requiredEnum(body.fuelType, 'Fuel', c.FUEL_TYPES) : null;
  for (const [column, key] of Object.entries(c.PAPER_KEYS)) {
    if (body[key] !== undefined) facts[column] = c.optionalDate(body[key], `${c.PAPERS[column][0].toUpperCase()}${c.PAPERS[column].slice(1)} valid until`);
  }
  if (body.servicePer !== undefined || body.serviceEvery !== undefined) {
    const per = body.servicePer === undefined ? unit.service_per : c.given(body.servicePer) ? v.requiredEnum(body.servicePer, 'Serviced every', ['hours', 'km', 'days']) : null;
    if (per === 'hours' && unit.meter !== 'hours') fail(`${unit.label} has no hour meter: service it every so many days instead`);
    if (per === 'km' && unit.meter !== 'km') fail(`${unit.label} has no odometer: service it every so many days instead`);
    facts.service_per = per;
    facts.service_every = per ? c.whole(body.serviceEvery ?? unit.service_every, per === 'days' ? 'Serviced every (days)' : per === 'km' ? 'Serviced every (km)' : 'Serviced every (hours)', 1, 1000000) : null;
  }
  return facts;
}

// body: { label?, serialNo?, status?: available | maintenance | retired, statusNote?, vehicleClass?, engineCc?, lengthMm?, fuelType?, rcValidUntil?, permitValidUntil?,
//   insuranceValidUntil?, pucValidUntil?, fitnessValidUntil?, servicePer?: hours | km | days, serviceEvery? } — what is left out stays.
// A unit's name, number, vehicle facts, papers and schedule are the catalogue's (catalog.edit); in service or not, the yard's (rentals.edit).
async function updateUnit(business, user, unitId, body) {
  c.requireRentals(business);
  const factKeys = ['vehicleClass', 'engineCc', 'lengthMm', 'fuelType', 'servicePer', 'serviceEvery', ...Object.values(c.PAPER_KEYS)];
  const naming = body.label !== undefined || body.serialNo !== undefined || factKeys.some((k) => body[k] !== undefined);
  const status = body.status === undefined ? null : v.requiredEnum(body.status, 'Unit is', ['available', 'maintenance', 'retired']);
  if (naming) await access.require(business, 'catalog.edit');
  if (status) await access.require(business, 'rentals.edit');
  if (!naming && !status) fail('Give the unit\'s new name, number, details or state');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const unit = await repo.one(db, `SELECT u.*,i.vehicle,i.kind,i.meter,s.label AS item_name FROM rental_units u JOIN rental_items i ON i.business_id=u.business_id AND i.id=u.item_id
      JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id WHERE u.business_id=$1 AND u.id=$2 FOR UPDATE OF u`, [business.id, id(unitId, 'Unit')]);
    if (!unit) fail('Unit not found', 404);
    const label = body.label === undefined ? unit.label : v.requiredString(typeof body.label === 'string' ? body.label : '', 'Unit name', 80);
    const serialNo = body.serialNo === undefined ? unit.serial_no : c.readSerial(body.serialNo, unit.vehicle);
    const next = status || unit.status;
    const note = next === 'available' ? null : body.statusNote === undefined && next === unit.status ? unit.status_note : c.optionalText(body.statusNote, 'Why', 300);
    if (next !== 'available' && !note) fail(next === 'maintenance' ? 'Say what the maintenance is for' : 'Say why the unit is retired');
    const facts = readUnitFacts(body, unit);
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
      if (held && !['back', 'downtime'].includes(held.part)) {
        fail(`${unit.label} is ${held.part === 'out' ? 'out' : 'booked'} on ${held.booking_no} (${held.customer_name}): move that booking to another unit, or wait until it is back, before retiring it`, 409);
      }
    }
    // A schedule set now counts from now, at the meter's reading.
    if (facts.service_per && !unit.serviced_at) { facts.serviced_at = new Date(); facts.serviced_meter = unit.meter_reading; }
    const columns = Object.keys(facts);
    await db.query(`UPDATE rental_units SET label=$3,serial_no=$4,status=$5,status_note=$6,updated_by=$7,updated_at=now()${columns.map((k, i) => `,${k}=$${8 + i}`).join('')}
      WHERE business_id=$1 AND id=$2`, [business.id, unit.id, label, serialNo, next, note, user.id, ...columns.map((k) => facts[k])]);
    const factChanges = Object.fromEntries(columns.filter((k) => String(unit[k] ?? '') !== String(facts[k] ?? '') && !['serviced_at', 'serviced_meter'].includes(k))
      .map((k) => [k, { from: unit[k] instanceof Date ? unit[k].toISOString().slice(0, 10) : unit[k], to: facts[k] instanceof Date ? facts[k].toISOString() : facts[k] }]));
    const changed = { ...(label !== unit.label ? { label: { from: unit.label, to: label } } : {}), ...(serialNo !== unit.serial_no ? { serialNo: { from: unit.serial_no, to: serialNo } } : {}),
      ...(next !== unit.status || note !== unit.status_note ? { status: { from: unit.status, to: next }, note } : {}), ...factChanges };
    if (Object.keys(changed).length) await repo.audit(db, business.id, user.id, 'rental_unit.updated', unit.id, { item: unit.item_name, unit: label, ...changed });
    return load(db, business);
  });
}

// --- Classes --------------------------------------------------------------------------------------------

function readChecklist(value) {
  if (value === undefined || value === null) return [];
  const list = v.requiredArray(value, 'Checklist');
  if (list.length > MAX_POINTS) fail(`A checklist has at most ${MAX_POINTS} points`);
  const points = list.map((p, i) => v.requiredString(typeof p === 'string' ? p : '', `Checklist point ${i + 1}`, 80));
  if (new Set(points.map((p) => p.toLowerCase())).size !== points.length) fail('Name each point of the checklist once');
  return points;
}

// body: { name, checklist?: [point], lateSlabs?: [{ from, flat, times }], lateCap?, active? } — a class (catalog.edit).
async function saveClass(business, user, classId, body) {
  c.requireRentals(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = classId ? await repo.one(db, 'SELECT * FROM rental_classes WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(classId, 'Class')]) : null;
    if (classId && !current) fail('Class not found', 404);
    const name = body.name === undefined && current ? current.name : v.requiredString(typeof body.name === 'string' ? body.name : '', 'Name of the class', 80);
    const checklist = body.checklist === undefined && current ? current.checklist : readChecklist(body.checklist);
    const lateSlabs = body.lateSlabs === undefined && current ? current.late_slabs : c.readLateSlabs(body.lateSlabs);
    const lateCap = body.lateCap === undefined && current ? current.late_cap : rate(body.lateCap, 'Most late fee for each one');
    const active = v.requiredBoolean(body.active, 'In use', current ? current.active : true);
    const same = await repo.one(db, 'SELECT 1 FROM rental_classes WHERE business_id=$1 AND lower(name)=lower($2) AND id<>COALESCE($3,0)', [business.id, name, current?.id || null]);
    if (same) fail(`There is already a class called ${name}`, 409);
    if (current && !active && current.active) {
      const using = await repo.one(db, `SELECT count(*)::int AS n FROM rental_items WHERE business_id=$1 AND class_id=$2 AND active AND late_per='slabs' AND late_slabs IS NULL`,
        [business.id, current.id]);
      if (using.n) fail(`${using.n} item${using.n === 1 ? ' takes its' : 's take their'} late fee slabs from ${current.name}: give them their own first`, 409);
    }
    const values = [business.id, name, checklist, lateSlabs ? JSON.stringify(lateSlabs) : null, lateCap, active, user.id];
    const row = current
      ? await repo.one(db, `UPDATE rental_classes SET name=$2,checklist=$3,late_slabs=$4,late_cap=$5,active=$6,updated_by=$7,updated_at=now() WHERE business_id=$1 AND id=$8 RETURNING *`,
        [...values, current.id])
      : await repo.one(db, 'INSERT INTO rental_classes(business_id,name,checklist,late_slabs,late_cap,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *', values);
    await repo.audit(db, business.id, user.id, current ? 'rental_class.updated' : 'rental_class.created', row.id, { name, checklist, lateSlabs, lateCap, active,
      ...(current ? { was: { name: current.name, checklist: current.checklist, lateSlabs: current.late_slabs, lateCap: current.late_cap, active: current.active } } : {}) });
    return load(db, business);
  });
}

// --- Settings ----------------------------------------------------------------------------------------

const settingsShape = (s) => ({ idRequired: s.id_required, terms: s.terms, papersWarnDays: Number(s.papers_warn_days), papersUrgentDays: Number(s.papers_urgent_days),
  papersLapsed: s.papers_lapsed, cancelSlabs: s.cancel_slabs, noShowPercent: s.no_show_percent === null || s.no_show_percent === undefined ? null : Number(s.no_show_percent),
  updatedAt: s.updated_at });

async function settings(business) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  return settingsShape(await c.settingsOf(repo.pool, business.id));
}

// body: { idRequired?, terms?, papersWarnDays?, papersUrgentDays?, papersLapsed?: warn | refuse, cancelSlabs?: [{ hours, percent }], noShowPercent? }
// — what is left out stays. Bookings print the terms as they are when printed.
async function saveSettings(business, user, body) {
  c.requireRentals(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    const before = await c.settingsOf(db, business.id);
    const next = {
      id_required: body.idRequired === undefined ? before.id_required : v.requiredBoolean(body.idRequired, 'Photo ID at every handover'),
      terms: body.terms === undefined ? before.terms : c.optionalText(body.terms, 'Terms on the slips', MAX_TERMS),
      papers_warn_days: body.papersWarnDays === undefined ? Number(before.papers_warn_days) : c.whole(body.papersWarnDays, 'Days before a paper runs out to warn', 1, 365),
      papers_urgent_days: body.papersUrgentDays === undefined ? Number(before.papers_urgent_days) : c.whole(body.papersUrgentDays, 'Days before a paper runs out to warn again', 0, 365),
      papers_lapsed: body.papersLapsed === undefined ? before.papers_lapsed : v.requiredEnum(body.papersLapsed, 'A vehicle with a paper run out', ['warn', 'refuse']),
      cancel_slabs: body.cancelSlabs === undefined ? before.cancel_slabs : c.readCancelSlabs(body.cancelSlabs),
      no_show_percent: body.noShowPercent === undefined ? before.no_show_percent : c.given(body.noShowPercent) ? core.decimal(body.noShowPercent, 'Charge for a no-show (percent)', 2, 0, 100) : null,
    };
    if (next.papers_urgent_days >= next.papers_warn_days) fail('Warn again closer to the date than the first warning');
    await db.query(`INSERT INTO rental_settings(business_id,id_required,terms,papers_warn_days,papers_urgent_days,papers_lapsed,cancel_slabs,no_show_percent,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (business_id) DO UPDATE SET id_required=EXCLUDED.id_required,terms=EXCLUDED.terms,papers_warn_days=EXCLUDED.papers_warn_days,
        papers_urgent_days=EXCLUDED.papers_urgent_days,papers_lapsed=EXCLUDED.papers_lapsed,cancel_slabs=EXCLUDED.cancel_slabs,no_show_percent=EXCLUDED.no_show_percent,
        updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, next.id_required, next.terms, next.papers_warn_days, next.papers_urgent_days, next.papers_lapsed, next.cancel_slabs ? JSON.stringify(next.cancel_slabs) : null,
      next.no_show_percent, user.id]);
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || String(a ?? '') === String(b ?? '');
    const changed = Object.keys(next).filter((k) => !same(before[k], next[k]) && !(typeof next[k] === 'number' && Number(before[k]) === next[k]));
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

module.exports = { ITEMS_SQL, list, load, createItem, updateItem, addUnit, updateUnit, saveClass, settings, saveSettings, checkLooseSale, withSlabCheck };
