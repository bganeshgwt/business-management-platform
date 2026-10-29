const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
// The folio's goods (a minibar's) and the stay's history; required when used, as they require each other.
const folio = () => require('./lodgingFolio.service');
const stays = () => require('./lodgingStays.service');

// Housekeeping (module "lodging", hotels, lodges and guest houses). A room's
// status has three parts, kept apart:
//
//   occupancy     vacant or occupied: a room is occupied while a guest is
//                 checked in to it (the check-in and the check-out set it).
//   cleanliness   dirty → being cleaned → clean → inspected, each step with who
//                 and when (the room's history); a guest's room is left dirty
//                 at check-out. When the property asks for it, a guest checks
//                 in only to an inspected room (the database checks it too).
//   availability  out of order: a period booked from today or ahead, with its
//                 reason, to a last night or until put back in order; the room
//                 is off sale those nights, so a reservation that would need it
//                 is refused with the reason (lodgingStays typeFull, and the
//                 database). Out of service: a flag; the room stays on sale.
// Besides: do not disturb on a guest's room (no cleaning starts while it is
// on), and each room type's linen and minibar checklist: a room's check
// records what was found, and a minibar item the guest in the room used is
// posted to their folio as goods (it leaves stock when the folio is billed).

const { fail, id } = c;
const STEP_WORDS = { dirty: 'Marked dirty', cleaning: 'Cleaning started', clean: 'Cleaned', inspected: 'Inspected' };
// The steps that may follow each: dirty → being cleaned (or straight to clean) → clean → inspected; any step back to dirty.
const NEXT = { dirty: ['cleaning', 'clean'], cleaning: ['dirty', 'clean'], clean: ['dirty', 'inspected'], inspected: ['dirty'] };
// The old words for two steps (vacant dirty, vacant clean), still taken.
const OLD_WORDS = { vacant_dirty: 'dirty', vacant_clean: 'clean' };

// --- The board ---------------------------------------------------------------------------------------------------

const BOARD_SQL = `SELECT x.*,
    (SELECT json_build_object('id',s.id,'stay_no',s.stay_no,'guest_name',s.guest_name,'departure',s.departure,'adults',s.adults,'children',s.children)
      FROM lodging_stays s WHERE s.business_id=x.business_id AND s.room_id=x.id AND s.status='in_house' LIMIT 1) AS guest,
    (SELECT json_build_object('id',s.id,'stay_no',s.stay_no,'guest_name',s.guest_name,'arrival',s.arrival)
      FROM lodging_stays s WHERE s.business_id=x.business_id AND s.room_id=x.id AND s.status='reserved' AND s.arrival<=z.today ORDER BY s.arrival,s.id LIMIT 1) AS arriving,
    (SELECT json_build_object('id',o.id,'starts_on',o.starts_on,'ends_on',o.ends_on,'reason',o.reason) FROM lodging_out_of_order o
      WHERE o.business_id=x.business_id AND o.room_id=x.id AND o.cancelled_at IS NULL AND o.starts_on<=z.today AND (o.ends_on IS NULL OR o.ends_on>=z.today) LIMIT 1) AS out_of_order,
    (SELECT json_build_object('id',o.id,'starts_on',o.starts_on,'ends_on',o.ends_on,'reason',o.reason) FROM lodging_out_of_order o
      WHERE o.business_id=x.business_id AND o.room_id=x.id AND o.cancelled_at IS NULL AND o.starts_on>z.today ORDER BY o.starts_on LIMIT 1) AS next_out_of_order,
    (SELECT count(*)::int FROM lodging_tickets k WHERE k.business_id=x.business_id AND k.room_id=x.id AND k.status IN ('open','in_progress')) AS open_tickets
  FROM (SELECT r.*,l.name AS location_name,k.label AS room_type,u.name AS status_by_name,cu.name AS cleaned_by_name,iu.name AS inspected_by_name FROM lodging_rooms r
    JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
    JOIN lodging_room_types t ON t.business_id=r.business_id AND t.id=r.room_type_id JOIN catalog_skus k ON k.business_id=t.business_id AND k.id=t.sku_id
    JOIN users u ON u.id=r.status_by LEFT JOIN users cu ON cu.id=r.cleaned_by LEFT JOIN users iu ON iu.id=r.inspected_by
    WHERE r.business_id=$1 AND r.active AND ($2::bigint IS NULL OR r.location_id=$2) AND ($3::bigint IS NULL OR r.id=$3)) x
  CROSS JOIN (SELECT (now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1) z
  ORDER BY x.location_name,x.sort_order,lower(x.floor),length(x.room_no),lower(x.room_no),x.id`;
// A room as the board shows it: out of order tonight when a period covers today (and no guest is in it).
const shapeRoom = (r) => ({ ...r, status: r.status !== 'occupied' && r.out_of_order ? 'out_of_order' : r.status, ready: r.status === 'vacant_clean' && !r.out_of_order });
async function roomsOf(db, business, roomId = null) {
  return (await repo.all(db, BOARD_SQL, [business.id, business.location_scope || null, roomId])).map(shapeRoom);
}
const roomRow = async (db, business, roomId) => (await roomsOf(db, business, roomId))[0];

// The out-of-order periods tonight and ahead (and those that ended yesterday), with their tickets.
const PERIODS_SQL = `SELECT o.id,o.room_id,r.room_no,r.location_id,l.name AS location_name,k.label AS room_type,o.starts_on::text AS starts_on,o.ends_on::text AS ends_on,o.reason,
    o.created_at,u.name AS created_by_name,(o.starts_on<=z.today) AS begun,t.id AS ticket_id,t.ticket_no,t.status AS ticket_status
  FROM lodging_out_of_order o JOIN lodging_rooms r ON r.business_id=o.business_id AND r.id=o.room_id
  JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
  JOIN lodging_room_types y ON y.business_id=r.business_id AND y.id=r.room_type_id JOIN catalog_skus k ON k.business_id=y.business_id AND k.id=y.sku_id
  JOIN users u ON u.id=o.created_by LEFT JOIN lodging_tickets t ON t.business_id=o.business_id AND t.out_of_order_id=o.id
  CROSS JOIN (SELECT (now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1) z
  WHERE o.business_id=$1 AND o.cancelled_at IS NULL AND (o.ends_on IS NULL OR o.ends_on>=z.today) AND ($2::bigint IS NULL OR r.location_id=$2)
  ORDER BY o.starts_on,lower(r.room_no),o.id`;

// Rooms by status (occupied, out of order tonight, vacant dirty, vacant clean), each with its cleanliness, the guest in it or due today,
// its out-of-order period now or next, do not disturb, out of service and its open tickets; the out-of-order periods; the counts.
async function board(business) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const rooms = await roomsOf(repo.pool, business);
  const periods = await repo.all(repo.pool, PERIODS_SQL, [business.id, business.location_scope || null]);
  const settings = await c.settingsOf(repo.pool, business.id);
  const counts = Object.fromEntries(c.ROOM_STATUSES.map((s) => [s, rooms.filter((r) => r.status === s).length]));
  const cleaning = Object.fromEntries(c.CLEANING.map((s) => [s, rooms.filter((r) => r.cleaning === s).length]));
  return { rooms, counts, cleaning, periods, inspectionRequired: Boolean(settings.inspection_required), today: await c.today(repo.pool, business) };
}

// A room of this business, locked, at a location the person works at.
async function lockRoom(db, business, roomId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const room = await repo.one(db, 'SELECT * FROM lodging_rooms WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(roomId, 'Room')]);
  if (!room) fail('Room not found', 404);
  access.requireLocation(business, room.location_id);
  return room;
}

// --- Cleaning steps -----------------------------------------------------------------------------------------------

// body: { cleaning: dirty | cleaning | clean | inspected, note? } (or { status: vacant_dirty | vacant_clean }: dirty and clean) — the room's next
// cleaning step; a guest's room is cleaned too (it stays occupied). Repeated, it is the same step.
async function setCleaning(business, user, roomId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  if (body.status === 'out_of_order') fail('Book the room out of order with its first night and its reason');
  const step = body.cleaning !== undefined ? v.requiredEnum(body.cleaning, 'Cleaning step', c.CLEANING) : OLD_WORDS[v.requiredEnum(body.status, 'Room status', Object.keys(OLD_WORDS))];
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const room = await lockRoom(db, business, roomId);
    if (!room.active) fail(`Room ${room.room_no} is out of use`, 409);
    if (room.cleaning === step) return { room: await roomRow(db, business, room.id), repeated: true };
    if (!NEXT[room.cleaning].includes(step)) {
      fail(step === 'inspected' ? `Room ${room.room_no} is ${c.CLEANING_WORDS[room.cleaning]}: a room is inspected once it is clean`
        : `Room ${room.room_no} is ${c.CLEANING_WORDS[room.cleaning]}: mark it dirty first`, 409);
    }
    if (step === 'cleaning' && room.dnd) fail(`Room ${room.room_no}'s guest asked not to be disturbed: clean it once they take the sign off`, 409);
    const status = room.status === 'occupied' ? 'occupied' : ['dirty', 'cleaning'].includes(step) ? 'vacant_dirty' : 'vacant_clean';
    await db.query(`UPDATE lodging_rooms SET status=$3,cleaning=$4,status_note=$5,status_by=$6,status_at=now(),
        cleaned_by=CASE WHEN $4='clean' THEN $6 ELSE cleaned_by END,cleaned_at=CASE WHEN $4='clean' THEN now() ELSE cleaned_at END,
        inspected_by=CASE WHEN $4='inspected' THEN $6 ELSE inspected_by END,inspected_at=CASE WHEN $4='inspected' THEN now() ELSE inspected_at END,updated_by=$6,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, room.id, status, step, note, user.id]);
    const details = { roomNo: room.room_no, from: room.status, to: status, cleaning: { from: room.cleaning, to: step }, ...(note ? { note } : {}) };
    await repo.audit(db, business.id, user.id, 'lodging_room.status_changed', room.id, details);
    await repo.event(db, business.id, user.id, 'lodging_room.status_changed', 'lodging_room', room.id, { ...details, locationId: room.location_id });
    return { room: await roomRow(db, business, room.id), repeated: false, said: STEP_WORDS[step] };
  });
}

// body: { dnd?: true | false, outOfService?: true | false, note? (why it is out of service) } — do not disturb (a guest's room only), and out of
// service (the room stays on sale, flagged with why).
async function setFlags(business, user, roomId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  if (body.dnd === undefined && body.outOfService === undefined) fail('Say what changes: do not disturb, or out of service');
  return repo.transaction(async (db) => {
    const room = await lockRoom(db, business, roomId);
    if (!room.active) fail(`Room ${room.room_no} is out of use`, 409);
    const dnd = v.requiredBoolean(body.dnd, 'Do not disturb', room.dnd);
    const outOfService = v.requiredBoolean(body.outOfService, 'Out of service', room.out_of_service);
    if (dnd && room.status !== 'occupied') fail(`Room ${room.room_no} has no guest in it: do not disturb is for a guest's room`, 409);
    let why = room.out_of_service_note;
    if (body.outOfService !== undefined) {
      why = outOfService ? c.optionalText(body.note, 'Why it is out of service', 300) : null;
      if (outOfService && !why) fail('Say why the room is out of service');
    }
    if (dnd === room.dnd && outOfService === room.out_of_service && why === room.out_of_service_note) return { room: await roomRow(db, business, room.id), repeated: true };
    await db.query(`UPDATE lodging_rooms SET dnd=$3,out_of_service=$4,out_of_service_note=$5,status_by=$6,status_at=now(),updated_by=$6,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, room.id, dnd, outOfService, why, user.id]);
    const details = { roomNo: room.room_no, ...(dnd !== room.dnd ? { dnd: { from: room.dnd, to: dnd } } : {}),
      ...(outOfService !== room.out_of_service || why !== room.out_of_service_note ? { outOfService: { from: room.out_of_service, to: outOfService, note: why } } : {}) };
    await repo.audit(db, business.id, user.id, 'lodging_room.flags_changed', room.id, details);
    return { room: await roomRow(db, business, room.id), repeated: false };
  });
}

// --- Out of order --------------------------------------------------------------------------------------------------

const periodRow = (db, business, periodId) => repo.one(db, `SELECT o.*,o.starts_on::text AS starts_on,o.ends_on::text AS ends_on,r.room_no FROM lodging_out_of_order o
  JOIN lodging_rooms r ON r.business_id=o.business_id AND r.id=o.room_id WHERE o.business_id=$1 AND o.id=$2`, [business.id, periodId]);
// The first stay holding a room over some of these nights (`until` null: every night from `from`), or null.
const holderOf = (db, business, roomId, from, until) => repo.one(db, `SELECT s.stay_no,s.guest_name,s.status,s.arrival::text AS arrival,s.departure::text AS departure FROM lodging_stays s
  WHERE s.business_id=$1 AND s.room_id=$2 AND s.status IN ('reserved','in_house') AND daterange(s.arrival,s.departure) && daterange($3::date,$4::date,'[]')
  ORDER BY s.arrival,s.id LIMIT 1`, [business.id, roomId, from, until]);
const holderWords = (room, s) => `Room ${room.room_no} is ${s.status === 'in_house' ? 'occupied' : 'booked'} by ${s.stay_no} (${s.guest_name}) for ${c.nightsWords(s.arrival, s.departure)}: move the stay to another room first`;

// The out-of-order period booked inside the caller's transaction (the room locked): checked against the stays holding the room
// and the room type's stays on each of its nights (the database checks both again when the work is saved). Returns the period.
async function bookIn(db, business, user, room, { startsOn, endsOn, reason, requestKey = null }) {
  const today = await c.today(db, business);
  if (!room.active) fail(`Room ${room.room_no} is out of use`, 409);
  if (startsOn < today) fail('A room is put out of order from today or a day ahead');
  if (endsOn && endsOn < startsOn) fail('The last night out of order is on or after the first');
  const other = await repo.one(db, `SELECT starts_on::text AS starts_on,ends_on::text AS ends_on,reason,$3::text AS room_no FROM lodging_out_of_order WHERE business_id=$1 AND room_id=$2
    AND cancelled_at IS NULL AND daterange(starts_on,ends_on,'[]') && daterange($4::date,$5::date,'[]') LIMIT 1`, [business.id, room.id, room.room_no, startsOn, endsOn]);
  if (other) fail(`${c.downWords(other)} already: change that period instead`, 409);
  const holder = await holderOf(db, business, room.id, startsOn, endsOn);
  if (holder) fail(holderWords(room, holder), 409);
  const row = await repo.one(db, `INSERT INTO lodging_out_of_order(business_id,room_id,starts_on,ends_on,reason,request_key,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
    [business.id, room.id, startsOn, endsOn, reason, requestKey, user.id]);
  const details = { roomNo: room.room_no, startsOn, endsOn, reason };
  await repo.audit(db, business.id, user.id, 'lodging_room.out_of_order', room.id, { ...details, periodId: row.id });
  await repo.event(db, business.id, user.id, 'lodging_room.out_of_order', 'lodging_room', room.id, { ...details, periodId: row.id, locationId: room.location_id });
  return periodRow(db, business, row.id);
}
// A period as typed: its first night (today when left out), its last night (none: until put back in order) and its reason.
function readPeriod(body, today) {
  const startsOn = c.given(body.startsOn) ? c.readDate(body.startsOn, 'Out of order from') : today;
  const endsOn = c.given(body.endsOn) ? c.readDate(body.endsOn, 'Out of order to') : null;
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why it is out of order', 300);
  return { startsOn, endsOn, reason };
}

// body: { requestKey?, roomId, startsOn? (today), endsOn? (the last night; none: until put back in order), reason }
async function bookOutOfOrder(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  const requestKey = c.given(body.requestKey) ? core.uuid(body.requestKey) : null;
  return repo.transaction(async (db) => {
    const room = await lockRoom(db, business, body.roomId);
    const typed = readPeriod(body, await c.today(db, business));
    if (requestKey) {
      const old = await repo.one(db, 'SELECT id,room_id,starts_on::text AS starts_on,ends_on::text AS ends_on,reason FROM lodging_out_of_order WHERE business_id=$1 AND request_key=$2',
        [business.id, requestKey]);
      if (old) {
        if (Number(old.room_id) !== Number(room.id) || old.starts_on !== typed.startsOn || old.ends_on !== typed.endsOn || old.reason !== typed.reason) {
          fail('This request key was already used for different data', 409);
        }
        return { period: await periodRow(db, business, old.id), repeated: true };
      }
    }
    return { period: await bookIn(db, business, user, room, { ...typed, requestKey }), repeated: false };
  });
}

// body: { endsOn? (the new last night; null: until put back in order), reason? } — a period changed; `back`: put back in order today
// (its last night was last night; one not begun is withdrawn).
async function changeOutOfOrder(business, user, periodId, body, { back = false } = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const period = await repo.one(db, `SELECT o.*,o.starts_on::text AS starts_on,o.ends_on::text AS ends_on,r.room_no,r.location_id FROM lodging_out_of_order o
      JOIN lodging_rooms r ON r.business_id=o.business_id AND r.id=o.room_id WHERE o.business_id=$1 AND o.id=$2 FOR UPDATE OF o`, [business.id, id(periodId, 'Out-of-order period')]);
    if (!period) fail('Out-of-order period not found', 404);
    access.requireLocation(business, period.location_id);
    const today = await c.today(db, business);
    const yesterday = c.addDays(today, -1);
    if (period.cancelled_at || (period.ends_on && period.ends_on < yesterday)) fail(`That out-of-order period of room ${period.room_no} is over`, 409);
    let endsOn = period.ends_on, cancel = false;
    if (back) {
      if (period.starts_on >= today) cancel = true;
      else if (period.ends_on && period.ends_on < today) return { period: await periodRow(db, business, period.id), repeated: true };
      else endsOn = yesterday;
    } else if (body.endsOn !== undefined) {
      endsOn = c.given(body.endsOn) ? c.readDate(body.endsOn, 'Out of order to') : null;
      if (endsOn && endsOn < period.starts_on) fail('The last night out of order is on or after the first: withdraw it instead');
      if (endsOn && endsOn < yesterday) fail('An out-of-order period ends last night at the earliest: the nights gone stay as they were');
    }
    const reason = !back && body.reason !== undefined ? v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why it is out of order', 300) : period.reason;
    const longer = !cancel && endsOn !== period.ends_on && (endsOn === null || (period.ends_on !== null && endsOn > period.ends_on));
    if (longer) {
      const holder = await holderOf(db, business, period.room_id, period.ends_on ? c.addDays(period.ends_on, 1) : period.starts_on, endsOn);
      if (holder) fail(holderWords(period, holder), 409);
    }
    await db.query(`UPDATE lodging_out_of_order SET ends_on=$3,reason=$4,cancelled_at=CASE WHEN $5 THEN now() END,cancelled_by=CASE WHEN $5 THEN $6::bigint END,updated_by=$6,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, period.id, endsOn, reason, cancel, user.id]);
    const details = { roomNo: period.room_no, periodId: period.id, startsOn: period.starts_on, endsOn: { from: period.ends_on, to: endsOn }, ...(cancel ? { withdrawn: true } : {}),
      ...(reason !== period.reason ? { reason: { from: period.reason, to: reason } } : {}) };
    await repo.audit(db, business.id, user.id, back ? 'lodging_room.back_in_order' : 'lodging_room.out_of_order_changed', period.room_id, details);
    return { period: await periodRow(db, business, period.id), repeated: false };
  });
}

// A period put back in order today, inside the caller's transaction (a ticket done or cancelled): its last night was last night, or one not
// begun is withdrawn. Nothing when it is over already. Returns the period, or null.
async function backInOrderIn(db, business, user, periodId, why) {
  const period = await repo.one(db, `SELECT o.*,o.starts_on::text AS starts_on,o.ends_on::text AS ends_on,r.room_no FROM lodging_out_of_order o
    JOIN lodging_rooms r ON r.business_id=o.business_id AND r.id=o.room_id WHERE o.business_id=$1 AND o.id=$2 FOR UPDATE OF o`, [business.id, periodId]);
  const today = await c.today(db, business);
  if (!period || period.cancelled_at || (period.ends_on && period.ends_on < today)) return null;
  const cancel = period.starts_on >= today;
  const endsOn = cancel ? period.ends_on : c.addDays(today, -1);
  await db.query(`UPDATE lodging_out_of_order SET ends_on=$3,cancelled_at=CASE WHEN $4 THEN now() END,cancelled_by=CASE WHEN $4 THEN $5::bigint END,updated_by=$5,updated_at=now()
    WHERE business_id=$1 AND id=$2`, [business.id, period.id, endsOn, cancel, user.id]);
  await repo.audit(db, business.id, user.id, 'lodging_room.back_in_order', period.room_id, { roomNo: period.room_no, periodId: period.id, startsOn: period.starts_on,
    endsOn: { from: period.ends_on, to: endsOn }, ...(cancel ? { withdrawn: true } : {}), why });
  return periodRow(db, business, period.id);
}

// The out-of-order periods tonight and ahead.
async function periods(business) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  return { items: await repo.all(repo.pool, PERIODS_SQL, [business.id, business.location_scope || null]), today: await c.today(repo.pool, business) };
}

// --- Linen and minibar checklists ---------------------------------------------------------------------------------

const ITEMS_SQL = `SELECT i.id,i.room_type_id,i.kind,i.name,i.sku_id,k.label AS item,k.code AS item_code,k.price,i.par,i.sort_order,i.active FROM lodging_checklist_items i
  LEFT JOIN catalog_skus k ON k.business_id=i.business_id AND k.id=i.sku_id WHERE i.business_id=$1`;
const itemName = (i) => i.name || i.item;

// Each room type's linen and minibar checklist.
async function checklists(business) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const items = await repo.all(repo.pool, `${ITEMS_SQL} AND i.active ORDER BY i.room_type_id,i.kind,i.sort_order,i.id`, [business.id]);
  const money = c.seesMoney(business);
  return { items: items.map((i) => ({ ...i, name: itemName(i), price: money ? i.price : null })) };
}

// body: { roomTypeId, items: [{ kind: linen | minibar, name? (linen), skuId? (minibar: goods kept by quantity), par }] } — the room type's
// checklist in place of the one it had (an item left out is switched off, never deleted).
async function setChecklist(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'catalog.edit');
  const list = v.requiredArray(body.items, 'Checklist');
  if (list.length > 60) fail('A checklist holds at most 60 items');
  const typed = list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Item ${index + 1} must be an object`);
    const kind = v.requiredEnum(raw.kind, `Item ${index + 1}: linen or minibar`, ['linen', 'minibar']);
    return { kind, name: kind === 'linen' ? v.requiredString(typeof raw.name === 'string' ? raw.name : '', `Item ${index + 1}: name`, 80) : null,
      skuId: kind === 'minibar' ? id(raw.skuId, `Item ${index + 1}: minibar item`) : null, par: c.whole(raw.par, `Item ${index + 1}: how many a room holds`, 1, 99), sortOrder: index };
  });
  const keyOf = (t) => (t.kind === 'linen' ? `linen:${t.name.toLowerCase()}` : `minibar:${t.skuId}`);
  if (new Set(typed.map(keyOf)).size !== typed.length) fail('Each item is on the checklist once');
  let typeId;
  await repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const type = await stays().roomTypeOf(db, business, body.roomTypeId);
    typeId = type.id;
    for (const t of typed.filter((x) => x.kind === 'minibar')) {
      const sku = await repo.one(db, `SELECT s.id,s.label,s.tracking,s.is_kit,p.kind,(s.active AND p.active) AS in_use FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
        WHERE s.business_id=$1 AND s.id=$2`, [business.id, t.skuId]);
      if (!sku) fail('Minibar item not found', 404);
      if (sku.kind !== 'goods' || sku.is_kit || ['batch', 'serial'].includes(sku.tracking)) fail(`${sku.label} is not goods kept by quantity: a minibar holds goods from stock`);
      if (!sku.in_use) fail(`${sku.label} is switched off in the catalogue`, 409);
    }
    const current = await repo.all(db, 'SELECT * FROM lodging_checklist_items WHERE business_id=$1 AND room_type_id=$2 FOR UPDATE', [business.id, type.id]);
    const seen = new Set();
    for (const t of typed) {
      const row = current.find((x) => x.kind === t.kind && (t.kind === 'linen' ? x.name.toLowerCase() === t.name.toLowerCase() : Number(x.sku_id) === t.skuId));
      if (row) {
        seen.add(Number(row.id));
        await db.query('UPDATE lodging_checklist_items SET name=$3,par=$4,sort_order=$5,active=TRUE,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2',
          [business.id, row.id, t.name, t.par, t.sortOrder, user.id]);
      } else {
        await db.query('INSERT INTO lodging_checklist_items(business_id,room_type_id,kind,name,sku_id,par,sort_order,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [business.id, type.id, t.kind, t.name, t.skuId, t.par, t.sortOrder, user.id]);
      }
    }
    for (const row of current.filter((x) => x.active && !seen.has(Number(x.id)))) {
      await db.query('UPDATE lodging_checklist_items SET active=FALSE,updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, row.id, user.id]);
    }
    await repo.audit(db, business.id, user.id, 'lodging_checklist.set', type.id, { roomType: type.name, items: typed.map((t) => ({ kind: t.kind, name: t.name, skuId: t.skuId, par: t.par })) });
  });
  const all = await checklists(business);
  return { ...all, roomTypeId: typeId };
}

// body: { requestKey, kind: linen | minibar, lines: [{ itemId, found }], note? } — a room's linen or minibar checked against its room type's
// checklist (every item counted). A minibar item the guest in the room used (found below the number it holds) is posted to their folio as
// goods at its catalogue price; with no guest in the room nothing is charged.
async function checkRoom(business, user, roomId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, roomId: String(roomId) });
  const kind = v.requiredEnum(body.kind, 'Checklist', ['linen', 'minibar']);
  const lines = v.requiredArray(body.lines, 'What was found').map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Line ${index + 1} must be an object`);
    return { itemId: id(raw.itemId, `Line ${index + 1}: item`), found: c.whole(raw.found, `Line ${index + 1}: how many were found`, 0, 999) };
  });
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) fail('Each item is counted once');
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const room = await lockRoom(db, business, roomId);
    const old = await repo.one(db, 'SELECT id,request_hash FROM lodging_room_checks WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return { check: await checkOf(db, business, old.id), room: await roomRow(db, business, room.id), repeated: true };
    }
    if (!room.active) fail(`Room ${room.room_no} is out of use`, 409);
    const items = await repo.all(db, `${ITEMS_SQL} AND i.room_type_id=$2 AND i.kind=$3 AND i.active ORDER BY i.sort_order,i.id`, [business.id, room.room_type_id, kind]);
    if (!items.length) fail(`Room ${room.room_no}'s room type has no ${kind} checklist yet: set it under Settings › Room types & rates`, 409);
    const missing = items.filter((i) => !lines.some((l) => l.itemId === Number(i.id)));
    if (missing.length) fail(`Count every item on the checklist: ${c.listWords(missing.map(itemName))} not counted`);
    const stranger = lines.find((l) => !items.some((i) => Number(i.id) === l.itemId));
    if (stranger) fail(`That item is not on room ${room.room_no}'s ${kind} checklist`, 404);
    const stay = await repo.one(db, "SELECT * FROM lodging_stays WHERE business_id=$1 AND room_id=$2 AND status='in_house' FOR UPDATE", [business.id, room.id]);
    const check = await repo.one(db, 'INSERT INTO lodging_room_checks(business_id,room_id,kind,stay_id,note,request_key,request_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [business.id, room.id, kind, stay?.id || null, note, requestKey, hash, user.id]);
    const used = [];
    for (const item of items) {
      const line = lines.find((l) => l.itemId === Number(item.id));
      const short = Math.max(0, Number(item.par) - line.found);
      let chargeId = null;
      if (kind === 'minibar' && short > 0 && stay) {
        const charge = await folio().chargeIn(db, business, user, stay, { skuId: Number(item.sku_id), quantityText: String(short), note: `Minibar, room ${room.room_no}`,
          requestKey: c.derivedKey(requestKey, `item:${item.id}`) });
        chargeId = charge.id;
      }
      if (short > 0) used.push({ name: itemName(item), short, charged: Boolean(chargeId) });
      await db.query('INSERT INTO lodging_room_check_lines(business_id,check_id,item_id,par,found,charge_id) VALUES($1,$2,$3,$4,$5,$6)',
        [business.id, check.id, item.id, item.par, line.found, chargeId]);
    }
    const details = { roomNo: room.room_no, kind, short: used, stayNo: stay?.stay_no || null, ...(note ? { note } : {}) };
    await repo.audit(db, business.id, user.id, 'lodging_room.checked', room.id, details);
    await repo.event(db, business.id, user.id, 'lodging_room.checked', 'lodging_room', room.id, { ...details, checkId: check.id, stayId: stay?.id || null });
    return { check: await checkOf(db, business, check.id), room: await roomRow(db, business, room.id), repeated: false };
  });
}
// A room check with its lines (and what each minibar line charged, for those who see money).
async function checkOf(db, business, checkId) {
  const check = await repo.one(db, `SELECT k.id,k.room_id,k.kind,k.stay_id,s.stay_no,k.note,k.created_at,u.name AS by_name FROM lodging_room_checks k JOIN users u ON u.id=k.created_by
    LEFT JOIN lodging_stays s ON s.business_id=k.business_id AND s.id=k.stay_id WHERE k.business_id=$1 AND k.id=$2`, [business.id, checkId]);
  const lines = await repo.all(db, `SELECT l.item_id,COALESCE(i.name,sk.label) AS name,l.par,l.found,GREATEST(0,l.par-l.found) AS short,l.charge_id,ch.quantity AS charged,ch.amount,ch.tax
    FROM lodging_room_check_lines l JOIN lodging_checklist_items i ON i.business_id=l.business_id AND i.id=l.item_id LEFT JOIN catalog_skus sk ON sk.business_id=i.business_id AND sk.id=i.sku_id
    LEFT JOIN lodging_charges ch ON ch.business_id=l.business_id AND ch.id=l.charge_id WHERE l.business_id=$1 AND l.check_id=$2 ORDER BY i.sort_order,i.id`, [business.id, checkId]);
  const money = c.seesMoney(business);
  return { ...check, lines: lines.map((l) => ({ ...l, amount: money ? l.amount : null, tax: money ? l.tax : null })) };
}

// A room's checks, newest first.
async function roomChecks(business, roomId) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const room = await repo.one(repo.pool, 'SELECT id,location_id FROM lodging_rooms WHERE business_id=$1 AND id=$2', [business.id, id(roomId, 'Room')]);
  if (!room) fail('Room not found', 404);
  access.requireLocation(business, room.location_id);
  const ids = await repo.all(repo.pool, 'SELECT id FROM lodging_room_checks WHERE business_id=$1 AND room_id=$2 ORDER BY id DESC LIMIT 20', [business.id, room.id]);
  const items = [];
  for (const row of ids) items.push(await checkOf(repo.pool, business, row.id));
  return { items };
}

module.exports = { board, roomsOf, setCleaning, setFlags, bookIn, readPeriod, bookOutOfOrder, changeOutOfOrder, backInOrderIn, periods, checklists, setChecklist, checkRoom,
  roomChecks };
