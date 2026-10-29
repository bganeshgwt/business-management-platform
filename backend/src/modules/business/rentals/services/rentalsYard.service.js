const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./rentalsCommon');

// The yard (module "rentals"): where each unit and each pool's pieces are
// kept, the vehicles' papers and the service schedules, maintenance booked
// ahead, and transfers between locations.
//
//   the yard      every unit in use with its location, state, papers (each
//                 date, and whether it has run out or runs out within the
//                 business's warning days) and service (when it was last done
//                 and whether it is due); maintenance booked from now on; each
//                 pool's count at each location; the latest transfers.
//   transfers     a unit, or so many pieces of a pool, moved from one location
//                 to another now: a unit not booked or out from now on; no
//                 more pieces than the location keeps beyond what its bookings
//                 hold at their busiest from now on.
//   downtime      maintenance booked ahead for a unit, from a time to a time:
//                 it holds the unit as a booking does (the database refuses it
//                 over a booking, and a booking over it). Cancelled, never
//                 deleted.
//   services      a service done on a unit, with its meter: the schedule
//                 counts again from it.
//   the bell      a vehicle's paper running out (from the warning days, again
//                 from the urgent days, and once it has run out), and a unit
//                 whose service is due.
// Times are instants on the business's clock; "today" is the business's date.

const { fail, id } = c;

// Where a paper stands on a day: run out, urgent, due soon or fine.
function paperState(until, today, settings) {
  if (!until) return null;
  const day = typeof until === 'string' ? until.slice(0, 10) : until.toISOString().slice(0, 10);
  const left = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const state = left < 0 ? 'lapsed' : left <= Number(settings.papers_urgent_days) ? 'urgent' : left <= Number(settings.papers_warn_days) ? 'soon' : 'ok';
  return { until: day, daysLeft: left, state };
}

// When a unit's service falls due: by its meter (hours or km) or by days from the last service.
function serviceDue(unit, today, timezone) {
  if (!unit.service_per) return null;
  const every = Number(unit.service_every);
  if (unit.service_per === 'days') {
    const last = new Date(unit.serviced_at).toLocaleDateString('en-CA', { timeZone: timezone || 'Asia/Kolkata' });
    const dueOn = c.addDays(last, every);
    return { per: 'days', every, dueOn, due: dueOn <= today };
  }
  const dueAt = Number(unit.serviced_meter || 0) + every;
  const reading = unit.meter_reading === null ? null : Number(unit.meter_reading);
  return { per: unit.service_per, every, dueAt, reading, due: reading !== null && reading >= dueAt };
}

const UNITS_SQL = `SELECT u.*,i.vehicle,i.with_driver,i.meter,i.active AS item_active,s.label AS item_name,l.name AS location_name,
    (SELECT max(x.created_at) FROM rental_services x WHERE x.business_id=u.business_id AND x.unit_id=u.id) AS last_service_at
  FROM rental_units u JOIN rental_items i ON i.business_id=u.business_id AND i.id=u.item_id JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
  JOIN business_locations l ON l.business_id=u.business_id AND l.id=u.location_id
  WHERE u.business_id=$1 AND u.status<>'retired' AND i.active ORDER BY i.sort_order,lower(s.label),lower(u.label)`;

async function unitsOf(db, business) {
  const today = await c.today(db, business);
  const settings = await c.settingsOf(db, business.id);
  const units = await repo.all(db, UNITS_SQL, [business.id]);
  return units.map((u) => ({ ...u, papers: Object.fromEntries(Object.keys(c.PAPERS).map((k) => [k, paperState(u[k], today, settings)])), service: serviceDue(u, today, business.timezone) }));
}

async function yard(business) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  const db = repo.pool;
  const units = await unitsOf(db, business);
  const downtime = await repo.all(db, `SELECT d.id,d.unit_id,d.starts_at,d.ends_at,d.reason,d.created_at,u.label AS unit_label,s.label AS item_name,cu.name AS by_name
    FROM rental_downtime d JOIN rental_units u ON u.business_id=d.business_id AND u.id=d.unit_id JOIN rental_items i ON i.business_id=d.business_id AND i.id=d.item_id
    JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id JOIN users cu ON cu.id=d.created_by
    WHERE d.business_id=$1 AND d.cancelled_at IS NULL AND d.ends_at>now() ORDER BY d.starts_at,d.id LIMIT 200`, [business.id]);
  const pools = await repo.all(db, `SELECT i.id,s.label AS name,i.pool_quantity,
      COALESCE((SELECT json_agg(json_build_object('location_id',pc.location_id,'location_name',l.name,'quantity',pc.quantity) ORDER BY l.id)
        FROM rental_pool_counts pc JOIN business_locations l ON l.business_id=pc.business_id AND l.id=pc.location_id WHERE pc.business_id=i.business_id AND pc.item_id=i.id),'[]') AS counts
    FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id WHERE i.business_id=$1 AND i.kind='pool' AND i.active ORDER BY i.sort_order,lower(s.label)`,
  [business.id]);
  const transfers = await repo.all(db, `SELECT t.id,t.item_id,t.unit_id,t.quantity,t.note,t.created_at,s.label AS item_name,u.label AS unit_label,f.name AS from_name,o.name AS to_name,
      cu.name AS by_name
    FROM rental_transfers t JOIN rental_items i ON i.business_id=t.business_id AND i.id=t.item_id JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    LEFT JOIN rental_units u ON u.business_id=t.business_id AND u.id=t.unit_id JOIN business_locations f ON f.business_id=t.business_id AND f.id=t.from_location_id
    JOIN business_locations o ON o.business_id=t.business_id AND o.id=t.to_location_id JOIN users cu ON cu.id=t.created_by
    WHERE t.business_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 100`, [business.id]);
  const locations = await repo.all(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND active ORDER BY id', [business.id]);
  const settings = await c.settingsOf(db, business.id);
  return { units, downtime, pools, transfers, locations, papersWarnDays: Number(settings.papers_warn_days), papersUrgentDays: Number(settings.papers_urgent_days),
    papersLapsed: settings.papers_lapsed };
}

// body: { requestKey, itemId, unitId? (a unit) | quantity (pieces of a pool) and fromLocationId, toLocationId, note? } — moved now.
async function transfer(business, user, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const toId = id(body.toLocationId, 'Moved to');
  const note = c.optionalText(body.note, 'Note', 300);
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM rental_transfers WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return;
    }
    const item = await repo.one(db, `SELECT i.*,s.label AS name FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
      WHERE i.business_id=$1 AND i.id=$2 FOR UPDATE OF i`, [business.id, id(body.itemId, 'Rental item')]);
    if (!item) fail('Rental item not found', 404);
    if (item.kind === 'kit') fail(`${item.name} is a kit: move its parts`);
    const to = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, toId]);
    if (!to) fail('Location not found', 404);
    let unit = null, quantity = 1, fromId;
    if (item.kind === 'unit') {
      unit = await repo.one(db, 'SELECT * FROM rental_units WHERE business_id=$1 AND item_id=$2 AND id=$3 FOR UPDATE', [business.id, item.id, id(body.unitId, 'Unit')]);
      if (!unit) fail('Unit not found', 404);
      if (unit.status === 'retired') fail(`${unit.label} is retired`, 409);
      fromId = Number(unit.location_id);
      if (fromId === Number(to.id)) fail(`${unit.label} is kept at ${to.name} already`);
      const held = await repo.one(db, `SELECT * FROM rental_unit_clash($1,$2,$3,now(),now()+interval '100 days',NULL,NULL) h`, [business.id, item.id, unit.id]);
      if (held && ['booked', 'out'].includes(held.part)) {
        fail(`${unit.label} is ${held.part === 'out' ? 'out' : 'booked'} on ${held.booking_no} (${held.customer_name}): it moves once that booking is back, or moved to another unit`, 409);
      }
    } else {
      quantity = c.whole(body.quantity, 'How many move', 1, 1000000);
      fromId = id(body.fromLocationId, 'Moved from');
      if (fromId === Number(to.id)) fail('Moved from and to the same location');
    }
    const from = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, fromId]);
    if (!from) fail('Location not found', 404);
    access.requireLocation(business, from.id);
    access.requireLocation(business, to.id);
    const row = await repo.one(db, `INSERT INTO rental_transfers(business_id,item_id,unit_id,quantity,from_location_id,to_location_id,note,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [business.id, item.id, unit?.id || null, quantity, from.id, to.id, note, requestKey, hash, user.id]);
    if (unit) {
      await db.query('UPDATE rental_units SET location_id=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, unit.id, to.id, user.id]);
    } else {
      const count = await repo.one(db, 'SELECT quantity FROM rental_pool_counts WHERE business_id=$1 AND item_id=$2 AND location_id=$3 FOR UPDATE', [business.id, item.id, from.id]);
      const have = Number(count?.quantity || 0);
      if (quantity > have) fail(`${from.name} keeps ${have} of ${item.name}`, 409);
      const held = (await repo.one(db, `SELECT rental_location_peak($1,$2,$3,now(),now()+interval '100 days',NULL,NULL) AS n`, [business.id, item.id, from.id])).n;
      if (have - quantity < held) fail(`Bookings at ${from.name} hold ${held} of ${item.name} at their busiest from now on: at most ${Math.max(0, have - held)} can move`, 409);
      await db.query('UPDATE rental_pool_counts SET quantity=quantity-$4 WHERE business_id=$1 AND item_id=$2 AND location_id=$3', [business.id, item.id, from.id, quantity]);
      await db.query(`INSERT INTO rental_pool_counts(business_id,item_id,location_id,quantity) VALUES($1,$2,$3,$4)
        ON CONFLICT (business_id,item_id,location_id) DO UPDATE SET quantity=rental_pool_counts.quantity+EXCLUDED.quantity`, [business.id, item.id, to.id, quantity]);
    }
    const details = { item: item.name, unit: unit?.label || null, quantity, from: from.name, to: to.name, note };
    await repo.audit(db, business.id, user.id, 'rental_transfer.made', row.id, details);
    await repo.event(db, business.id, user.id, 'rental_transfer.made', 'rental_transfer', row.id, { ...details, itemId: item.id, unitId: unit?.id || null, fromLocationId: from.id,
      toLocationId: to.id });
  });
  return yard(business);
}

// body: { requestKey, startsAt, endsAt, reason } — maintenance booked ahead for a unit, over free time.
async function addDowntime(business, user, unitId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, unitId: String(unitId) });
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'What the maintenance is', 300);
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM rental_downtime WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return;
    }
    const unit = await repo.one(db, 'SELECT * FROM rental_units WHERE business_id=$1 AND id=$2', [business.id, id(unitId, 'Unit')]);
    if (!unit) fail('Unit not found', 404);
    if (unit.status === 'retired') fail(`${unit.label} is retired`, 409);
    access.requireLocation(business, unit.location_id);
    const startsAt = await c.readInstant(db, business, body.startsAt, 'Maintenance from');
    const endsAt = await c.readInstant(db, business, body.endsAt, 'Maintenance until');
    if (endsAt <= startsAt) fail('The maintenance ends after it starts');
    if (endsAt - startsAt > c.MAX_DAYS * 86400000) fail(`Maintenance is booked for at most ${c.MAX_DAYS} days at a time`);
    if (endsAt <= new Date()) fail('Maintenance is booked from now on');
    const row = await repo.one(db, `INSERT INTO rental_downtime(business_id,item_id,unit_id,starts_at,ends_at,reason,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [business.id, unit.item_id, unit.id, startsAt, endsAt, reason, requestKey, hash, user.id]);
    // Checked now as well as when saved, so the answer names what is in the way.
    await db.query('SET CONSTRAINTS rental_downtime_free IMMEDIATE');
    const details = { unit: unit.label, from: startsAt, until: endsAt, reason };
    await repo.audit(db, business.id, user.id, 'rental_downtime.booked', row.id, details);
    await repo.event(db, business.id, user.id, 'rental_downtime.booked', 'rental_downtime', row.id, { ...details, unitId: unit.id });
  });
  return yard(business);
}

// Maintenance booked, cancelled (the unit is free again then).
async function cancelDowntime(business, user, downtimeId) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const row = await repo.one(db, `SELECT d.*,u.label FROM rental_downtime d JOIN rental_units u ON u.business_id=d.business_id AND u.id=d.unit_id
      WHERE d.business_id=$1 AND d.id=$2 FOR UPDATE OF d`, [business.id, id(downtimeId, 'Maintenance')]);
    if (!row) fail('Maintenance not found', 404);
    if (row.cancelled_at) return;
    await db.query('UPDATE rental_downtime SET cancelled_at=now(),cancelled_by=$3 WHERE business_id=$1 AND id=$2', [business.id, row.id, user.id]);
    await repo.audit(db, business.id, user.id, 'rental_downtime.cancelled', row.id, { unit: row.label, from: row.starts_at, until: row.ends_at, reason: row.reason });
    await repo.event(db, business.id, user.id, 'rental_downtime.cancelled', 'rental_downtime', row.id, { unitId: row.unit_id });
  });
  return yard(business);
}

// body: { meter?, note? } — a service done on a unit now; its schedule counts again from it.
async function recordService(business, user, unitId, body) {
  c.requireRentals(business);
  await access.require(business, 'rentals.edit');
  const note = c.optionalText(body.note, 'What was done', 300);
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const unit = await repo.one(db, `SELECT u.*,i.meter FROM rental_units u JOIN rental_items i ON i.business_id=u.business_id AND i.id=u.item_id
      WHERE u.business_id=$1 AND u.id=$2 FOR UPDATE OF u`, [business.id, id(unitId, 'Unit')]);
    if (!unit) fail('Unit not found', 404);
    const meter = c.given(body.meter) ? c.readMeter(body.meter, 'Meter reading') : null;
    if (meter !== null && !unit.meter) fail(`${unit.label} has no meter to read`);
    if (meter !== null && unit.meter_reading !== null && meter < Number(unit.meter_reading)) fail(`${unit.label}'s meter read ${Number(unit.meter_reading)} last: a reading never goes back`, 409);
    const reading = meter ?? (unit.meter_reading === null ? null : Number(unit.meter_reading));
    const row = await repo.one(db, 'INSERT INTO rental_services(business_id,item_id,unit_id,meter,note,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [business.id, unit.item_id, unit.id, reading, note, user.id]);
    await db.query(`UPDATE rental_units SET serviced_at=now(),serviced_meter=$3,meter_reading=COALESCE($4,meter_reading),updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, unit.id, reading, meter, user.id]);
    await repo.audit(db, business.id, user.id, 'rental_unit.serviced', unit.id, { unit: unit.label, meter: reading, note, serviceId: row.id });
  });
  return yard(business);
}

// The bell: papers running out or run out, and services due.
async function bell(business, base, limit) {
  const units = await unitsOf(repo.pool, business);
  const items = [];
  for (const u of units.filter((x) => x.vehicle)) {
    for (const [key, words] of Object.entries(c.PAPERS)) {
      const p = u.papers[key];
      if (!p || p.state === 'ok') continue;
      const title = p.state === 'lapsed' ? `${u.label}'s ${words} ran out on ${c.dateWords(p.until)}` : `${u.label}'s ${words} runs out on ${c.dateWords(p.until)}`;
      items.push({ id: `rental:paper:${u.id}:${key}:${p.until}:${p.state}`, severity: p.state === 'lapsed' ? 'critical' : p.state === 'urgent' ? 'warning' : 'info', category: 'Fleet',
        title, detail: p.state === 'lapsed' ? 'Renew it: the vehicle is not handed over until then' : `${c.plural(p.daysLeft, 'day')} left: renew it in time`,
        at: new Date().toISOString(), link: `${base}/rental-yard` });
    }
  }
  for (const u of units.filter((x) => x.service?.due)) {
    const s = u.service;
    items.push({ id: `rental:service:${u.id}:${u.serviced_at ? new Date(u.serviced_at).toISOString() : 'none'}`, severity: 'warning', category: 'Fleet',
      title: `${u.label} is due for its service`, detail: s.per === 'days' ? `Due on ${c.dateWords(s.dueOn)}` : `Due at ${s.dueAt} ${s.per === 'km' ? 'km' : 'hours'}; reads ${s.reading}`,
      at: new Date().toISOString(), link: `${base}/rental-yard` });
  }
  return items.slice(0, limit);
}

module.exports = { yard, transfer, addDowntime, cancelDowntime, recordService, bell, paperState, serviceDue, unitsOf };
