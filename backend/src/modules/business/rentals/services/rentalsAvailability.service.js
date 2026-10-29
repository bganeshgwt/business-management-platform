const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./rentalsCommon');

// What is free (module "rentals"), worked out from the bookings themselves
// (the database's rental_holds: a reserved booking from its out time to its
// due time and the turnaround time; one handed over, what is still out until
// it is due or now, and what came back until it came back and the turnaround
// time; maintenance booked ahead for a unit from its start to its end).
//
//   calendar  a week (or up to a month) of days on the business's clock, for
//             every item in use at a location: each unit kept there with the
//             bookings and maintenance that hold it on each day, and each pool
//             with the most held at once there on each day and what is free
//             then (of what the location has). A kit is shown by its parts.
//   free      for a booking being typed at a location: each unit free or not
//             over its time (with the item's turnaround time; one kept at
//             another location is not), how many of each pool, and how many
//             of each kit (as many as its scarcest part allows). A booking
//             being changed leaves its own holds out.
// The database checks every booking again when it is saved.

const { fail, id } = c;

// The items in use (or one), with their units in service and the pools' counts at the location.
async function itemsOf(business, itemId = null, locationId = null) {
  const items = await repo.all(repo.pool, `SELECT i.id,s.label AS name,i.kind,i.pool_quantity,i.vehicle,i.with_driver,i.buffer_minutes,i.deposit,i.rate_hour,i.rate_day,i.rate_week,i.rate_month,
      COALESCE((SELECT pc.quantity FROM rental_pool_counts pc WHERE pc.business_id=i.business_id AND pc.item_id=i.id AND pc.location_id=$3),0)::int AS here
    FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    WHERE i.business_id=$1 AND i.active AND ($2::bigint IS NULL OR i.id=$2) ORDER BY i.sort_order,lower(s.label),i.id`, [business.id, itemId, locationId]);
  const units = await repo.all(repo.pool, `SELECT id,item_id,label,serial_no,status,status_note,meter_reading,location_id FROM rental_units WHERE business_id=$1 AND item_id=ANY($2::bigint[])
    AND ($3::bigint IS NULL OR location_id=$3) ORDER BY lower(label),id`, [business.id, items.map((i) => i.id), locationId]);
  const parts = await repo.all(repo.pool, 'SELECT kit_id,part_id,quantity FROM rental_kit_parts WHERE business_id=$1 AND kit_id=ANY($2::bigint[])', [business.id, items.map((i) => i.id)]);
  return items.map((item) => ({ ...item, units: units.filter((u) => Number(u.item_id) === Number(item.id)),
    parts: parts.filter((p) => Number(p.kit_id) === Number(item.id)).map((p) => ({ itemId: Number(p.part_id), quantity: Number(p.quantity) })) }));
}

// The holds of an item that overlap [from, until), leaving a booking out; a pool's by the location's bookings only.
async function holdsOf(business, itemId, from, until, exceptBooking = null, locationId = null) {
  return repo.all(repo.pool, `SELECT h.* FROM rental_holds($1,$2) h LEFT JOIN rental_bookings b ON b.business_id=$1 AND b.id=h.booking_id
    WHERE h.starts_at<$4 AND h.ends_at>$3 AND ($5::bigint IS NULL OR h.booking_id IS DISTINCT FROM $5) AND ($6::bigint IS NULL OR h.unit_id IS NOT NULL OR b.location_id=$6)
    ORDER BY h.starts_at,h.booking_id`, [business.id, itemId, from, until, exceptBooking, locationId]);
}

// The most held at once over [from, until) by these holds (each [starts, ends)).
function peak(holds, from, until) {
  const events = [];
  for (const h of holds) {
    const start = Math.max(+new Date(h.starts_at), +from), end = Math.min(+new Date(h.ends_at), +until);
    if (start < end) events.push([start, Number(h.quantity)], [end, -Number(h.quantity)]);
  }
  // A hold ending at the moment another starts frees its place first.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let used = 0, most = 0;
  for (const [, change] of events) { used += change; most = Math.max(most, used); }
  return most;
}

const holdText = (h) => ({ bookingId: h.booking_id, bookingNo: h.booking_no, customerName: h.customer_name, status: h.status, part: h.part, quantity: Number(h.quantity),
  startsAt: h.starts_at, endsAt: h.ends_at, dueAt: h.due_at });

// The location asked, or the person's own, or the business's first.
async function placeOf(business, value) {
  if (c.given(value)) {
    const location = await repo.one(repo.pool, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, id(value, 'Location')]);
    if (!location) fail('Location not found', 404);
    access.requireLocation(business, location.id);
    return location;
  }
  const own = business.location_scope || await c.firstLocation(repo.pool, business.id);
  return repo.one(repo.pool, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, own]);
}

// query: { from? (YYYY-MM-DD, today), days? (7), item?, location? }
async function calendar(business, query = {}) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  const timezone = business.timezone || 'Asia/Kolkata';
  const from = query.from ? c.readDate(query.from, 'From') : await c.today(repo.pool, business);
  const days = query.days ? c.whole(query.days, 'Days', 1, 31) : 7;
  const itemId = query.item ? id(query.item, 'Rental item') : null;
  const place = await placeOf(business, query.location);
  const dayRows = await repo.all(repo.pool, `SELECT d::date::text AS day,(d::timestamp AT TIME ZONE $1) AS starts,((d+interval '1 day')::timestamp AT TIME ZONE $1) AS ends
    FROM generate_series($2::date,$2::date+($3::int-1),interval '1 day') d ORDER BY d`, [timezone, from, days]);
  const windowStart = dayRows[0].starts, windowEnd = dayRows.at(-1).ends;
  const items = [];
  for (const item of await itemsOf(business, itemId, place.id)) {
    if (item.kind === 'kit') continue;
    const holds = await holdsOf(business, item.id, windowStart, windowEnd, null, place.id);
    const onDay = (list, d) => list.filter((h) => +new Date(h.starts_at) < +d.ends && +new Date(h.ends_at) > +d.starts);
    if (item.kind === 'unit') {
      const rows = item.units.filter((u) => u.status !== 'retired' || holds.some((h) => Number(h.unit_id) === Number(u.id))).map((unit) => {
        const mine = holds.filter((h) => Number(h.unit_id) === Number(unit.id));
        return { unitId: unit.id, label: unit.label, serialNo: unit.serial_no, status: unit.status, statusNote: unit.status_note,
          days: dayRows.map((d) => ({ day: d.day, holds: onDay(mine, d).map(holdText) })) };
      });
      if (rows.length) items.push({ itemId: item.id, name: item.name, kind: 'unit', vehicle: item.vehicle, units: rows });
    } else {
      items.push({ itemId: item.id, name: item.name, kind: 'pool', poolQuantity: Number(item.here),
        days: dayRows.map((d) => {
          const busy = peak(holds, d.starts, d.ends);
          return { day: d.day, held: busy, free: Math.max(0, Number(item.here) - busy), holds: onDay(holds, d).map(holdText) };
        }) });
    }
  }
  return { from, to: dayRows.at(-1).day, days: dayRows.map((d) => d.day), timezone, locationId: place.id, locationName: place.name, items };
}

// query: { outAt, dueAt, booking? (a booking being changed), location? } — what is free at the location over that time.
async function free(business, query = {}) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  const outAt = await c.readInstant(repo.pool, business, query.outAt, 'Out from');
  const dueAt = await c.readInstant(repo.pool, business, query.dueAt, 'Due back by');
  if (dueAt <= outAt) fail('The due back time is after the out time');
  const exceptBooking = query.booking ? id(query.booking, 'Booking') : null;
  const place = await placeOf(business, query.location);
  const all = await itemsOf(business, null, null);
  const items = [];
  const pools = {};
  for (const item of all.filter((i) => i.kind !== 'kit')) {
    const until = new Date(+dueAt + Number(item.buffer_minutes) * 60000);
    const holds = await holdsOf(business, item.id, outAt, until, exceptBooking, place.id);
    if (item.kind === 'unit') {
      items.push({ itemId: item.id, name: item.name, kind: 'unit', vehicle: item.vehicle, units: item.units.filter((u) => u.status !== 'retired').map((unit) => {
        const clash = holds.find((h) => Number(h.unit_id) === Number(unit.id));
        const elsewhere = Number(unit.location_id) !== Number(place.id);
        return { id: unit.id, label: unit.label, serialNo: unit.serial_no, status: unit.status, free: !clash && !elsewhere, elsewhere, clash: clash ? holdText(clash) : null };
      }) });
    } else {
      const here = (await repo.one(repo.pool, 'SELECT quantity FROM rental_pool_counts WHERE business_id=$1 AND item_id=$2 AND location_id=$3', [business.id, item.id, place.id]))?.quantity || 0;
      const held = peak(holds, outAt, until);
      pools[item.id] = Math.max(0, Number(here) - held);
      items.push({ itemId: item.id, name: item.name, kind: 'pool', poolQuantity: Number(here), held, free: pools[item.id] });
    }
  }
  // A kit: as many as its scarcest part allows.
  for (const kit of all.filter((i) => i.kind === 'kit')) {
    const free = kit.parts.length ? Math.min(...kit.parts.map((p) => Math.floor((pools[p.itemId] ?? 0) / p.quantity))) : 0;
    items.push({ itemId: kit.id, name: kit.name, kind: 'kit', free, parts: kit.parts.map((p) => ({ ...p, name: all.find((i) => Number(i.id) === p.itemId)?.name || '', free: pools[p.itemId] ?? 0 })) });
  }
  return { outAt, dueAt, locationId: place.id, items };
}

module.exports = { calendar, free, peak };
