const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');

// Room types, rooms and the settings (module "lodging", hotels, lodges and guest houses).
//
//   settings    the two GST slabs a room night is billed at (the lower one at
//               or below the limit a room a night, the higher above it), the
//               limit (₹7,500 until changed), the weekend nights and the terms
//               on the registration card. Nothing is reserved or billed until
//               the slabs are set.
//   room types  each billed as a service item counted in nights (an existing
//               one, or one made with it: its name and SAC typed with it), with
//               its base and most occupancy, its extra beds, and its rate plan
//               (rack, weekend, each extra adult, child and extra bed, each a
//               night before GST). A change applies to stays booked after it:
//               a stay keeps the rates it was booked at. Switched off, never deleted.
//   rooms       each room's number, type, floor and location; out of use, never deleted.
//   status      housekeeping marks a room clean or dirty, and puts it out of order
//               (with why) and back; a room is occupied while a guest is checked in.
// A room type's nights are billed only from a stay's folio (checkLooseSale).

const { fail, id } = c;

const TYPES_SQL = `SELECT t.id,t.sku_id,s.label AS name,s.code AS item_code,s.hsn_code,(s.active AND p.active) AS item_active,t.base_occupancy,t.max_occupancy,t.max_extra_beds,
    t.rack_rate,t.weekend_rate,t.extra_adult_rate,t.child_rate,t.extra_bed_rate,t.description,t.sort_order,t.active,t.created_at,t.updated_at,
    (SELECT count(*)::int FROM lodging_rooms r WHERE r.business_id=t.business_id AND r.room_type_id=t.id AND r.active) AS rooms_in_use
  FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
  WHERE t.business_id=$1`;
const ROOMS_SQL = `SELECT r.id,r.location_id,l.name AS location_name,r.room_type_id,k.label AS room_type,r.room_no,r.floor,r.status,r.status_note,r.status_at,u.name AS status_by_name,
    r.sort_order,r.active
  FROM lodging_rooms r JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
  JOIN lodging_room_types t ON t.business_id=r.business_id AND t.id=r.room_type_id JOIN catalog_skus k ON k.business_id=t.business_id AND k.id=t.sku_id
  JOIN users u ON u.id=r.status_by WHERE r.business_id=$1`;
const ROOM_ORDER = 'r.active DESC,l.name,r.sort_order,lower(r.floor),length(r.room_no),lower(r.room_no),r.id';

const settingsShape = (s) => ({ lowTaxRateId: s.low_tax_rate_id, highTaxRateId: s.high_tax_rate_id, lowName: s.low_name || null, highName: s.high_name || null,
  lowRate: s.low_rate === undefined || s.low_rate === null ? null : Number(s.low_rate).toFixed(2), highRate: s.high_rate === undefined || s.high_rate === null ? null : Number(s.high_rate).toFixed(2),
  slabLimit: Number(s.slab_limit).toFixed(2), weekendNights: s.weekend_nights, terms: s.terms, updatedAt: s.updated_at, ready: Boolean(s.low_tax_rate_id) });

async function load(db, business) {
  const roomTypes = await repo.all(db, `SELECT * FROM (${TYPES_SQL}) x ORDER BY active DESC,sort_order,lower(name),id LIMIT 200`, [business.id]);
  const rooms = await repo.all(db, `${ROOMS_SQL} ORDER BY ${ROOM_ORDER} LIMIT 2000`, [business.id]);
  const slabs = await repo.all(db, 'SELECT id,name,rate,is_default FROM business_tax_rates WHERE business_id=$1 AND active ORDER BY rate,id', [business.id]);
  return { settings: settingsShape(await c.settingsOf(db, business.id)), slabs, roomTypes: roomTypes.map((t) => ({ ...t, rooms: rooms.filter((r) => Number(r.room_type_id) === Number(t.id)) })),
    rooms, timezone: business.timezone };
}

// Room types with their rooms, the rooms, the settings and the slabs to choose from.
async function setup(business) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  return load(repo.pool, business);
}

// --- Settings ----------------------------------------------------------------------------------------

// body: { lowTaxRateId?, highTaxRateId?, slabLimit?, weekendNights?: [1-7], terms? } — what is left out stays.
async function saveSettings(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'settings.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const before = await c.settingsOf(db, business.id);
    const slab = async (value, name) => {
      const row = await repo.one(db, 'SELECT id,name,rate,active FROM business_tax_rates WHERE business_id=$1 AND id=$2', [business.id, id(value, name)]);
      if (!row) fail(`${name} not found`, 404);
      if (!row.active) fail(`${row.name} is switched off: choose a slab in use`, 409);
      return row;
    };
    const lowGiven = body.lowTaxRateId !== undefined, highGiven = body.highTaxRateId !== undefined;
    if (lowGiven !== highGiven && !before.low_tax_rate_id) fail('Choose both slabs: the one at or below the limit and the one above it');
    const low = lowGiven ? await slab(body.lowTaxRateId, 'The slab at or below the limit') : null;
    const high = highGiven ? await slab(body.highTaxRateId, 'The slab above the limit') : null;
    const next = {
      low_tax_rate_id: low ? low.id : before.low_tax_rate_id,
      high_tax_rate_id: high ? high.id : before.high_tax_rate_id,
      slab_limit: body.slabLimit === undefined ? Number(before.slab_limit) : core.decimal(body.slabLimit, 'The limit a room a night', 2, 1, 10000000),
      weekend_nights: body.weekendNights === undefined ? before.weekend_nights
        : [...new Set(v.requiredArray(body.weekendNights, 'Weekend nights').map((d) => c.whole(d, 'A weekend night', 1, 7)))].sort((a, b) => a - b),
      terms: body.terms === undefined ? before.terms : c.optionalText(body.terms, 'Terms on the registration card', 2000),
    };
    if (next.low_tax_rate_id && Number(next.low_tax_rate_id) === Number(next.high_tax_rate_id)) fail('The two slabs are different slabs: the lower one, and the higher one above the limit');
    await db.query(`INSERT INTO lodging_settings(business_id,low_tax_rate_id,high_tax_rate_id,slab_limit,weekend_nights,terms,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (business_id) DO UPDATE SET low_tax_rate_id=EXCLUDED.low_tax_rate_id,high_tax_rate_id=EXCLUDED.high_tax_rate_id,slab_limit=EXCLUDED.slab_limit,
        weekend_nights=EXCLUDED.weekend_nights,terms=EXCLUDED.terms,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, next.low_tax_rate_id, next.high_tax_rate_id, Number(next.slab_limit).toFixed(2), next.weekend_nights, next.terms, user.id]);
    const was = { lowTaxRateId: before.low_tax_rate_id, highTaxRateId: before.high_tax_rate_id, slabLimit: Number(before.slab_limit).toFixed(2), weekendNights: before.weekend_nights, terms: before.terms };
    const now = { lowTaxRateId: next.low_tax_rate_id, highTaxRateId: next.high_tax_rate_id, slabLimit: Number(next.slab_limit).toFixed(2), weekendNights: next.weekend_nights, terms: next.terms };
    const changed = Object.keys(now).filter((k) => JSON.stringify(was[k] ?? null) !== JSON.stringify(now[k] ?? null));
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'lodging_settings.updated', null, { from: Object.fromEntries(changed.map((k) => [k, was[k]])), to: Object.fromEntries(changed.map((k) => [k, now[k]])) });
    }
    return settingsShape(await c.settingsOf(db, business.id));
  });
}

// --- Room types ----------------------------------------------------------------------------------------

// The occupancy, beds and rate plan as typed; `current` keeps what is left out (an update).
function readType(body, current = null) {
  const keep = (key, fallback) => (body[key] === undefined && current ? fallback : undefined);
  const base = keep('baseOccupancy', Number(current?.base_occupancy)) ?? c.whole(body.baseOccupancy, 'Adults the rate is for', 1, 20);
  const most = keep('maxOccupancy', Number(current?.max_occupancy)) ?? c.whole(body.maxOccupancy ?? base, 'Most guests in the room', 1, 30);
  if (most < base) fail('The most guests in the room is at least the adults the rate is for');
  const beds = keep('maxExtraBeds', Number(current?.max_extra_beds)) ?? (c.given(body.maxExtraBeds) ? c.whole(body.maxExtraBeds, 'Extra beds', 0, 5) : 0);
  const rates = body.rates === undefined && current ? null : body.rates || {};
  if (rates !== null && (typeof rates !== 'object' || Array.isArray(rates))) fail('Give the rates a night: the rack rate, and the weekend, extra adult, child and extra bed rates if any');
  const fromRow = (value) => (value === null || value === undefined ? null : c.paise(value));
  const read = rates === null
    ? { rack: fromRow(current.rack_rate), weekend: fromRow(current.weekend_rate), extraAdult: fromRow(current.extra_adult_rate), child: fromRow(current.child_rate), extraBed: fromRow(current.extra_bed_rate) }
    : { rack: c.readRate(rates.rack, 'The rack rate', { required: true }), weekend: c.readRate(rates.weekend, 'The weekend rate'),
      extraAdult: c.readRate(rates.extraAdult, 'The rate for an extra adult', { zero: true }), child: c.readRate(rates.child, 'The rate for a child', { zero: true }),
      extraBed: c.readRate(rates.extraBed, 'The rate for an extra bed', { zero: true }) };
  if (beds > 0 && read.extraBed === null) fail('Give the rate for an extra bed, or allow none');
  return {
    base, most, beds, rates: read,
    description: body.description === undefined && current ? current.description : c.optionalText(body.description, 'Description', 300),
    sortOrder: c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : current ? Number(current.sort_order) : 0,
  };
}
const rateText = (p) => (p === null ? null : c.rupees(p));

// A free item code for a new room type's service item: ROOM-01, ROOM-02 ….
async function freeCode(db, businessId) {
  const count = await repo.one(db, 'SELECT count(*)::int AS n FROM lodging_room_types WHERE business_id=$1', [businessId]);
  for (let n = count.n + 1; ; n += 1) {
    const code = `ROOM-${String(n).padStart(2, '0')}`;
    if (!await repo.one(db, 'SELECT 1 FROM catalog_skus WHERE business_id=$1 AND code=$2', [businessId, code])) return code;
  }
}

// body: { skuId } an existing service item counted in nights, or { item: { name, hsnCode?, code? } } for a new one;
//   baseOccupancy, maxOccupancy?, maxExtraBeds?, rates: { rack, weekend?, extraAdult?, child?, extraBed? }, description?, sortOrder?
async function createRoomType(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  const typed = readType(body);
  const insert = async (db, sku) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    if (await repo.one(db, 'SELECT 1 FROM lodging_room_types WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id])) fail(`${sku.label} is already a room type`, 409);
    const same = await repo.one(db, `SELECT 1 FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
      WHERE t.business_id=$1 AND lower(s.label)=lower($2)`, [business.id, sku.label]);
    if (same) fail(`There is a room type called ${sku.label} already`, 409);
    const row = await repo.one(db, `INSERT INTO lodging_room_types(business_id,sku_id,base_occupancy,max_occupancy,max_extra_beds,rack_rate,weekend_rate,extra_adult_rate,child_rate,
        extra_bed_rate,description,sort_order,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
    [business.id, sku.id, typed.base, typed.most, typed.beds, rateText(typed.rates.rack), rateText(typed.rates.weekend), rateText(typed.rates.extraAdult), rateText(typed.rates.child),
      rateText(typed.rates.extraBed), typed.description, typed.sortOrder, user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_room_type.created', row.id, { name: sku.label, baseOccupancy: typed.base, maxOccupancy: typed.most, extraBeds: typed.beds,
      rates: { rack: row.rack_rate, weekend: row.weekend_rate, extraAdult: row.extra_adult_rate, child: row.child_rate, extraBed: row.extra_bed_rate } });
    return row;
  };
  if (c.given(body.skuId)) {
    return repo.transaction(async (db) => {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.is_kit,s.unit,p.kind FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.active`, [business.id, id(body.skuId, 'Service item')]);
      if (!sku) fail('Service item not found', 404);
      if (sku.kind !== 'service' || sku.is_kit || sku.unit !== 'night') fail(`${sku.label} is not a service counted in nights: a room type's nights are billed as one`);
      await insert(db, sku);
      return load(db, business);
    });
  }
  const item = body.item && typeof body.item === 'object' && !Array.isArray(body.item) ? body.item : null;
  if (!item) fail('Give the room type\'s name (a new service item counted in nights is made with it), or an existing service item');
  const name = v.requiredString(typeof item.name === 'string' ? item.name : '', 'Name', 150);
  const code = c.given(item.code) ? String(item.code).trim().toUpperCase() : await freeCode(repo.pool, business.id);
  // The item's own slab is shown in the catalogue only: each night is billed at the slab its value decides.
  const settings = await c.settingsOf(repo.pool, business.id);
  const slab = settings.low_tax_rate_id || (await repo.one(repo.pool, 'SELECT id FROM business_tax_rates WHERE business_id=$1 AND is_default AND active', [business.id]))?.id;
  if (!slab) fail('Set the two GST slabs for room nights first, under Settings › Room types & rates');
  await core.createCatalog(business, user, { kind: 'service', unit: 'night', name, label: name, code, price: '0', taxRateId: slab, hsnCode: item.hsnCode },
    async (db, sku) => { await insert(db, sku); });
  return load(repo.pool, business);
}

// body: { baseOccupancy?, maxOccupancy?, maxExtraBeds?, rates?, description?, sortOrder?, active? } — what is left out stays. Stays keep their booked rates.
async function updateRoomType(business, user, typeId, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const current = await repo.one(db, `SELECT t.*,s.label AS name FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
      WHERE t.business_id=$1 AND t.id=$2 FOR UPDATE OF t`, [business.id, id(typeId, 'Room type')]);
    if (!current) fail('Room type not found', 404);
    const typed = readType(body, current);
    const active = v.requiredBoolean(body.active, 'In use', current.active);
    await db.query(`UPDATE lodging_room_types SET base_occupancy=$3,max_occupancy=$4,max_extra_beds=$5,rack_rate=$6,weekend_rate=$7,extra_adult_rate=$8,child_rate=$9,extra_bed_rate=$10,
        description=$11,sort_order=$12,active=$13,updated_by=$14,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, current.id, typed.base, typed.most, typed.beds, rateText(typed.rates.rack), rateText(typed.rates.weekend), rateText(typed.rates.extraAdult), rateText(typed.rates.child),
      rateText(typed.rates.extraBed), typed.description, typed.sortOrder, active, user.id]);
    const money = (x) => (x === null || x === undefined ? null : Number(x).toFixed(2));
    const was = { baseOccupancy: Number(current.base_occupancy), maxOccupancy: Number(current.max_occupancy), maxExtraBeds: Number(current.max_extra_beds), rack: money(current.rack_rate),
      weekend: money(current.weekend_rate), extraAdult: money(current.extra_adult_rate), child: money(current.child_rate), extraBed: money(current.extra_bed_rate),
      description: current.description, sortOrder: Number(current.sort_order), active: current.active };
    const now = { baseOccupancy: typed.base, maxOccupancy: typed.most, maxExtraBeds: typed.beds, rack: rateText(typed.rates.rack), weekend: rateText(typed.rates.weekend),
      extraAdult: rateText(typed.rates.extraAdult), child: rateText(typed.rates.child), extraBed: rateText(typed.rates.extraBed), description: typed.description,
      sortOrder: typed.sortOrder, active };
    const changed = Object.keys(now).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
    if (changed.length) {
      await repo.audit(db, business.id, user.id, 'lodging_room_type.updated', current.id, { name: current.name,
        from: Object.fromEntries(changed.map((k) => [k, was[k]])), to: Object.fromEntries(changed.map((k) => [k, now[k]])) });
    }
    return load(db, business);
  });
}

// --- Rooms ---------------------------------------------------------------------------------------------

const readRoomNo = (value, name = 'Room number') => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9][A-Za-z0-9 /-]{0,19}$/.test(text)) fail(`${name} is 1 to 20 letters, digits, spaces, / or -, like 101 or G-02`);
  return text;
};

// body: { locationId, roomTypeId, rooms: [{ roomNo, floor? }] } — rooms added together.
async function addRooms(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  const typeId = id(body.roomTypeId, 'Room type');
  const list = v.requiredArray(body.rooms, 'Rooms');
  if (!list.length) fail('Add at least one room');
  if (list.length > 200) fail('Add at most 200 rooms at once');
  const rooms = list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Room ${index + 1} must be an object`);
    return { roomNo: readRoomNo(raw.roomNo, `Room ${index + 1}: number`), floor: c.optionalText(raw.floor, `Room ${index + 1}: floor`, 30) };
  });
  const seen = new Set();
  for (const room of rooms) {
    if (seen.has(room.roomNo.toLowerCase())) fail(`Room ${room.roomNo} is listed twice`);
    seen.add(room.roomNo.toLowerCase());
  }
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    const type = await repo.one(db, `SELECT t.id,t.active,s.label AS name FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
      WHERE t.business_id=$1 AND t.id=$2`, [business.id, typeId]);
    if (!type) fail('Room type not found', 404);
    if (!type.active) fail(`${type.name} is switched off: switch it on to add rooms to it`, 409);
    for (const room of rooms) {
      const clash = await repo.one(db, 'SELECT room_no FROM lodging_rooms WHERE business_id=$1 AND location_id=$2 AND lower(room_no)=lower($3)', [business.id, location.id, room.roomNo]);
      if (clash) fail(`There is a room ${clash.room_no} at this location already`, 409);
      const row = await repo.one(db, `INSERT INTO lodging_rooms(business_id,location_id,room_type_id,room_no,floor,status_by,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6,$6) RETURNING id`,
        [business.id, location.id, type.id, room.roomNo, room.floor, user.id]);
      await repo.audit(db, business.id, user.id, 'lodging_room.created', row.id, { roomNo: room.roomNo, roomType: type.name, floor: room.floor, locationId: location.id });
    }
    return load(db, business);
  });
}

// body: { roomNo?, floor?, roomTypeId?, sortOrder?, active? } — what is left out stays.
async function updateRoom(business, user, roomId, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const room = await repo.one(db, 'SELECT * FROM lodging_rooms WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(roomId, 'Room')]);
    if (!room) fail('Room not found', 404);
    access.requireLocation(business, room.location_id);
    const roomNo = body.roomNo === undefined ? room.room_no : readRoomNo(body.roomNo);
    const floor = body.floor === undefined ? room.floor : c.optionalText(body.floor, 'Floor', 30);
    const typeId = body.roomTypeId === undefined ? Number(room.room_type_id) : id(body.roomTypeId, 'Room type');
    const sortOrder = c.given(body.sortOrder) ? c.whole(body.sortOrder, 'Order on the list', 0, 999) : Number(room.sort_order);
    const active = v.requiredBoolean(body.active, 'In use', room.active);
    if (roomNo.toLowerCase() !== room.room_no.toLowerCase()) {
      const clash = await repo.one(db, 'SELECT room_no FROM lodging_rooms WHERE business_id=$1 AND location_id=$2 AND lower(room_no)=lower($3) AND id<>$4',
        [business.id, room.location_id, roomNo, room.id]);
      if (clash) fail(`There is a room ${clash.room_no} at this location already`, 409);
    }
    if (typeId !== Number(room.room_type_id)) {
      const type = await repo.one(db, 'SELECT active FROM lodging_room_types WHERE business_id=$1 AND id=$2', [business.id, typeId]);
      if (!type) fail('Room type not found', 404);
      if (!type.active) fail('That room type is switched off', 409);
    }
    await db.query('UPDATE lodging_rooms SET room_no=$3,floor=$4,room_type_id=$5,sort_order=$6,active=$7,updated_by=$8,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, room.id, roomNo, floor, typeId, sortOrder, active, user.id]);
    const changed = { ...(roomNo !== room.room_no ? { roomNo: { from: room.room_no, to: roomNo } } : {}), ...(floor !== room.floor ? { floor: { from: room.floor, to: floor } } : {}),
      ...(typeId !== Number(room.room_type_id) ? { roomTypeId: { from: Number(room.room_type_id), to: typeId } } : {}), ...(active !== room.active ? { active: { from: room.active, to: active } } : {}) };
    if (Object.keys(changed).length) await repo.audit(db, business.id, user.id, 'lodging_room.updated', room.id, { roomNo, ...changed });
    return load(db, business);
  });
}

// --- Housekeeping ----------------------------------------------------------------------------------------

// Rooms by status, each with the guest in it (and when they leave) or the next guest due today.
async function board(business) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const rooms = await repo.all(repo.pool, `SELECT x.*,
      (SELECT json_build_object('id',s.id,'stay_no',s.stay_no,'guest_name',s.guest_name,'departure',s.departure,'adults',s.adults,'children',s.children)
        FROM lodging_stays s WHERE s.business_id=x.business_id AND s.room_id=x.id AND s.status='in_house' LIMIT 1) AS guest,
      (SELECT json_build_object('id',s.id,'stay_no',s.stay_no,'guest_name',s.guest_name,'arrival',s.arrival)
        FROM lodging_stays s WHERE s.business_id=x.business_id AND s.room_id=x.id AND s.status='reserved' AND s.arrival<=(now() AT TIME ZONE z.timezone)::date
        ORDER BY s.arrival,s.id LIMIT 1) AS arriving
    FROM (SELECT r.*,l.name AS location_name,k.label AS room_type,u.name AS status_by_name FROM lodging_rooms r
      JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
      JOIN lodging_room_types t ON t.business_id=r.business_id AND t.id=r.room_type_id JOIN catalog_skus k ON k.business_id=t.business_id AND k.id=t.sku_id
      JOIN users u ON u.id=r.status_by WHERE r.business_id=$1 AND r.active AND ($2::bigint IS NULL OR r.location_id=$2)) x
    JOIN businesses z ON z.id=x.business_id
    ORDER BY x.location_name,x.sort_order,lower(x.floor),length(x.room_no),lower(x.room_no),x.id`, [business.id, business.location_scope || null]);
  const counts = Object.fromEntries(c.ROOM_STATUSES.map((s) => [s, rooms.filter((r) => r.status === s).length]));
  return { rooms, counts, today: await c.today(repo.pool, business) };
}

// What housekeeping and the front desk may set: clean, dirty, out of order (with why).
const SETTABLE = { vacant_clean: ['vacant_dirty', 'out_of_order'], vacant_dirty: ['vacant_clean', 'out_of_order'], out_of_order: ['vacant_clean', 'vacant_dirty'], occupied: [] };

// body: { status: vacant_clean | vacant_dirty | out_of_order, note? (why it is out of order) }
async function setRoomStatus(business, user, roomId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  const status = v.requiredEnum(body.status, 'Room status', ['vacant_clean', 'vacant_dirty', 'out_of_order']);
  const note = c.optionalText(body.note, status === 'out_of_order' ? 'Why it is out of order' : 'Note', 300);
  if (status === 'out_of_order' && !note) fail('Say why the room is out of order');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const room = await repo.one(db, 'SELECT * FROM lodging_rooms WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(roomId, 'Room')]);
    if (!room) fail('Room not found', 404);
    access.requireLocation(business, room.location_id);
    if (!room.active) fail(`Room ${room.room_no} is out of use`, 409);
    if (room.status === status && (note || null) === (room.status_note || null)) return { room: await roomRow(db, business, room.id), repeated: true };
    if (room.status === 'occupied') fail(`Room ${room.room_no} has a guest in it: it is made up after they check out`, 409);
    if (room.status !== status && !SETTABLE[room.status].includes(status)) fail(`Room ${room.room_no} is ${c.ROOM_WORDS[room.status]}`, 409);
    await db.query('UPDATE lodging_rooms SET status=$3,status_note=$4,status_by=$5,status_at=now(),updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, room.id, status, note, user.id]);
    const details = { roomNo: room.room_no, from: room.status, to: status, ...(note ? { note } : {}) };
    await repo.audit(db, business.id, user.id, 'lodging_room.status_changed', room.id, details);
    await repo.event(db, business.id, user.id, 'lodging_room.status_changed', 'lodging_room', room.id, { ...details, locationId: room.location_id });
    return { room: await roomRow(db, business, room.id), repeated: false };
  });
}
const roomRow = (db, business, roomId) => repo.one(db, `${ROOMS_SQL} AND r.id=$2`, [business.id, roomId]);

// A room's status history, newest first.
async function history(business, roomId) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const room = await repo.one(repo.pool, `${ROOMS_SQL} AND r.id=$2`, [business.id, id(roomId, 'Room')]);
  if (!room) fail('Room not found', 404);
  access.requireLocation(business, room.location_id);
  const log = await repo.all(repo.pool, `SELECT g.id,g.from_status,g.to_status,g.note,g.created_at,u.name AS by_name FROM lodging_room_status_log g JOIN users u ON u.id=g.created_by
    WHERE g.business_id=$1 AND g.room_id=$2 ORDER BY g.id DESC LIMIT 100`, [business.id, room.id]);
  return { room, log };
}

// A room type's nights are billed from a stay's folio only: refused on any other bill.
async function checkLooseSale(db, business, lines) {
  const skuIds = [...new Set(lines.map((line) => Number(line.sku.id)))];
  const type = await repo.one(db, `SELECT s.label FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
    WHERE t.business_id=$1 AND t.sku_id=ANY($2::bigint[]) ORDER BY s.label LIMIT 1`, [business.id, skuIds]);
  if (type) fail(`${type.label} is a room type: its nights are billed on the stay's folio at check-out`, 409);
}

module.exports = { TYPES_SQL, ROOMS_SQL, setup, load, saveSettings, createRoomType, updateRoomType, addRooms, updateRoom, board, setRoomStatus, history, checkLooseSale };
