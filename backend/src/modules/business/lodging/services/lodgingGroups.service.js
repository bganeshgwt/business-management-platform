const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const c = require('./lodgingCommon');
const money = require('./lodgingMoney');
const stays = require('./lodgingStays.service');
const folio = require('./lodgingFolio.service');

// Group bookings (module "lodging"): one booking of several rooms (a block)
// for a group or a company (GB/2627/0001).
//
//   the block    each room its own stay of the group, with its room type, plan,
//                guests and beds, arriving and leaving with the group or on its
//                own dates; checked as any reservation (the calendar, the rooms
//                free); the organiser or company the group's folio is billed to.
//   rooming      each room's guest named on the rooming list while it is
//                reserved (until then, the organiser).
//   the folio    the group's folio, billed to the organiser or company: the
//                kinds of charges the group routes to it (the room and its tax
//                to start with) go there from every room; billed with its own
//                GST invoice once every stay of the group has left (checked out
//                or cancelled), paid first by what is left of the rooms'
//                advances and deposits.
//   together     the rooms checked in together, and checked out together with
//                the group's folio billed; or each on its own.

const { fail, id } = c;
const MAX_ROOMS = 50;

const GROUPS_SQL = `SELECT g.id,g.group_no,g.name,g.location_id,l.name AS location_name,g.contact_id,k.name AS contact_name,g.notes,g.created_at,
    (g.created_at AT TIME ZONE z.timezone) AS created_local,
    (SELECT min(s.arrival) FROM lodging_stays s WHERE s.business_id=g.business_id AND s.group_id=g.id) AS arrival,
    (SELECT max(s.departure) FROM lodging_stays s WHERE s.business_id=g.business_id AND s.group_id=g.id) AS departure,
    (SELECT count(*)::int FROM lodging_stays s WHERE s.business_id=g.business_id AND s.group_id=g.id) AS rooms,
    (SELECT count(*)::int FROM lodging_stays s WHERE s.business_id=g.business_id AND s.group_id=g.id AND s.status IN ('reserved','in_house')) AS open_rooms,
    f.id AS folio_id,f.document_id,d.document_no
  FROM lodging_groups g JOIN businesses z ON z.id=g.business_id JOIN business_locations l ON l.business_id=g.business_id AND l.id=g.location_id
  JOIN business_contacts k ON k.business_id=g.business_id AND k.id=g.contact_id
  LEFT JOIN lodging_folios f ON f.business_id=g.business_id AND f.group_id=g.id LEFT JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
  WHERE g.business_id=$1`;
repo.addLists({
  // Every group booking, newest first.
  'lodging-groups': { sql: GROUPS_SQL, search: ['group_no', 'name', 'contact_name', 'notes', 'document_no'], date: 'created_local', filters: { location: 'location_id' },
    order: 'created_at DESC,id DESC' },
});

const ROUTE_CHOICES = ['group', 'stay'];
// Which kinds of charges go to the group's folio: { room, meals, extras, goods }, each "group" or "stay" (the room and its tax to the group, the rest to each stay, to start with).
function readRoute(value) {
  const route = { room: 'group', meals: 'stay', extras: 'stay', goods: 'stay' };
  if (value === undefined || value === null) return route;
  if (typeof value !== 'object' || Array.isArray(value)) fail('Say for each kind of charge whether it goes to the group\'s folio or to each stay');
  for (const k of c.CATEGORIES) if (value[k] !== undefined) route[k] = v.requiredEnum(value[k], `Where ${k} go`, ROUTE_CHOICES);
  return route;
}

// The group as it is: its stays, its folio with the charges on it, and what it comes to.
async function load(db, business, groupId) {
  const group = await repo.one(db, `${GROUPS_SQL} AND g.id=$2`, [business.id, groupId]);
  if (!group) fail('Group booking not found', 404);
  access.requireLocation(business, group.location_id);
  const items = await repo.all(db, `SELECT * FROM (${stays.STAYS_SQL}) x WHERE x.group_id=$2 ORDER BY x.arrival,x.id`, [business.id, group.id]);
  const charges = await repo.all(db, `SELECT ch.id,ch.stay_id,s.stay_no,ch.kind,ch.night::text AS night,ch.label,ch.quantity,ch.amount,ch.net,ch.tax,ch.tax_rate,ch.line_id,ch.voided_at
    FROM lodging_charges ch JOIN lodging_stays s ON s.business_id=ch.business_id AND s.id=ch.stay_id WHERE ch.business_id=$1 AND ch.folio_id=$2 ORDER BY ch.night,ch.id`,
  [business.id, group.folio_id]);
  const live = charges.filter((x) => !x.voided_at);
  const bill = group.document_id ? await repo.one(db, `SELECT d.id,d.document_no,d.total,${c.DUE_SQL('d')} AS due FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`,
    [business.id, group.document_id]) : null;
  const out = { ...group, stays: items, charges: live, folio: { id: group.folio_id, total: money.rupees(live.reduce((s, x) => s + money.paise(x.net) + money.paise(x.tax), 0)),
    unbilled: money.rupees(live.filter((x) => !x.line_id).reduce((s, x) => s + money.paise(x.net) + money.paise(x.tax), 0)) }, bill };
  if (c.seesMoney(business)) return { ...out, money: true };
  return { ...out, stays: items.map(stays.withoutMoney), charges: live.map((x) => ({ ...x, amount: null, net: null, tax: null })), folio: { id: group.folio_id }, bill: null, money: false };
}
async function detail(business, groupId) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  return load(repo.pool, business, id(groupId, 'Group booking'));
}
async function lockGroup(db, business, groupId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const group = await repo.one(db, 'SELECT * FROM lodging_groups WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(groupId, 'Group booking')]);
  if (!group) fail('Group booking not found', 404);
  access.requireLocation(business, group.location_id);
  return group;
}
const groupStays = (db, business, groupId) => repo.all(db, 'SELECT * FROM lodging_stays WHERE business_id=$1 AND group_id=$2 ORDER BY id FOR UPDATE', [business.id, groupId]);

// body: { requestKey, locationId, name, contactId | guest: { name, phone? } (the organiser or company the group's folio is billed to), arrival, departure,
//   rooms: [{ roomTypeId, ratePlanId?, roomId?, adults, children?, extraBeds?, agreedRate?, contactId? | guest? (the room's guest: the organiser when left out),
//   arrival?, departure? (the room's own dates: the group's when left out) }], route?: { room, meals, extras, goods: group | stay }, source?, otaName?,
//   otaBookingId?, discount?, notes? }
async function create(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const name = v.requiredString(typeof body.name === 'string' ? body.name : '', 'Group name', 150);
  const organiser = stays.readGuest(body, 'the organiser');
  if (!organiser.contactId && !organiser.newGuest) fail('Choose the organiser or company the group is billed to, or type a new one\'s name');
  const list = v.requiredArray(body.rooms, 'Rooms');
  if (list.length < 2) fail('A group booking is two rooms or more: book one room as a stay');
  if (list.length > MAX_ROOMS) fail(`A group booking takes at most ${MAX_ROOMS} rooms`);
  const route = readRoute(body.route);
  const notes = c.optionalText(body.notes, 'Notes', 500);
  const rooms = list.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Room ${index + 1} must be an object`);
    const reading = stays.readReservation({ locationId: body.locationId, arrival: raw.arrival ?? body.arrival, departure: raw.departure ?? body.departure, roomTypeId: raw.roomTypeId,
      roomId: raw.roomId, ratePlanId: raw.ratePlanId, adults: raw.adults, children: raw.children, extraBeds: raw.extraBeds, agreedRate: raw.agreedRate, discount: body.discount,
      source: body.source, otaName: body.otaName, otaBookingId: body.otaBookingId, notes: body.notes, contactId: raw.contactId, guest: raw.guest });
    return reading;
  });
  return stays.posting(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM lodging_groups WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return load(db, business, old.id);
    }
    const locationId = rooms[0].locationId;
    access.requireLocation(business, locationId);
    const contact = await stays.guestContact(db, business, user, organiser);
    const number = await numbering.nextNumber(db, business.id, locationId, 'stay_group', user.id);
    const group = await repo.one(db, `INSERT INTO lodging_groups(business_id,location_id,group_no,series_id,name,contact_id,notes,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`, [business.id, locationId, number.number, number.seriesId, name, contact.id, notes, requestKey, hash, user.id]);
    const groupFolio = await repo.one(db, 'INSERT INTO lodging_folios(business_id,group_id,name,contact_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [business.id, group.id, `Group ${group.group_no}`.slice(0, 60), contact.id, user.id]);
    const made = [];
    for (const [index, r] of rooms.entries()) {
      const guest = r.guest.contactId || r.guest.newGuest ? await stays.guestContact(db, business, user, r.guest) : contact;
      const stayId = await stays.reserveIn(db, business, user, r, { requestKey: c.derivedKey(requestKey, `room:${index}`), hash, contact: guest, groupId: group.id });
      for (const category of c.CATEGORIES.filter((k) => route[k] === 'group')) {
        await db.query('INSERT INTO lodging_routes(business_id,stay_id,category,folio_id,updated_by) VALUES($1,$2,$3,$4,$5)', [business.id, stayId, category, groupFolio.id, user.id]);
      }
      made.push(stayId);
    }
    const details = { groupNo: group.group_no, name, billedTo: contact.name, rooms: made.length, route };
    await repo.audit(db, business.id, user.id, 'lodging_group.created', group.id, details);
    await repo.event(db, business.id, user.id, 'lodging_group.created', 'lodging_group', group.id, { ...details, stayIds: made, locationId });
    return load(db, business, group.id);
  });
}

// body: { stays: [{ stayId, contactId | guest: { name, phone? } }] } — the rooming list: each reserved room's guest named.
async function rooming(business, user, groupId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const list = v.requiredArray(body.stays, 'Rooming list');
  if (!list.length) fail('Name the guest of at least one room');
  return stays.posting(async (db) => {
    const group = await lockGroup(db, business, groupId);
    const own = await groupStays(db, business, group.id);
    for (const [index, raw] of list.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Line ${index + 1} of the rooming list must be an object`);
      const stay = own.find((s) => Number(s.id) === Number(raw.stayId));
      if (!stay) fail(`Line ${index + 1}: that stay is not one of group ${group.group_no}'s`, 404);
      if (stay.status !== 'reserved') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: the rooming list names the guests of rooms still reserved`, 409);
      const guest = stays.readGuest(raw, `the guest of ${stay.stay_no}`);
      if (!guest.contactId && !guest.newGuest) fail(`Line ${index + 1}: choose the room's guest, or type a new one's name`);
      const contact = await stays.guestContact(db, business, user, guest);
      if (Number(contact.id) === Number(stay.contact_id)) continue;
      await db.query('UPDATE lodging_stays SET contact_id=$3,guest_name=$4,guest_phone=$5,bill_to_contact_id=CASE WHEN bill_to_contact_id=$3 THEN NULL ELSE bill_to_contact_id END,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2',
        [business.id, stay.id, contact.id, contact.name, contact.phone || null, user.id]);
      await stays.history(db, business, user, stay, null, null, `Rooming list: the guest is ${contact.name} (was ${stay.guest_name})`);
      await repo.audit(db, business.id, user.id, 'lodging_stay.roomed', stay.id, { stayNo: stay.stay_no, groupNo: group.group_no, from: stay.guest_name, to: contact.name });
    }
    return load(db, business, group.id);
  });
}

// body: { requestKey, stays: [{ stayId, roomId?, guests: [occupant…], arrivedFrom?, goingTo?, purpose? }] } — rooms of the group checked in together.
async function checkIn(business, user, groupId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, groupId: String(groupId) });
  const list = v.requiredArray(body.stays, 'Rooms to check in');
  if (!list.length) fail('Check in at least one room');
  return stays.posting(async (db) => {
    const group = await lockGroup(db, business, groupId);
    const own = await groupStays(db, business, group.id);
    for (const [index, raw] of list.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Room ${index + 1} must be an object`);
      const stay = own.find((s) => Number(s.id) === Number(raw.stayId));
      if (!stay) fail(`Room ${index + 1}: that stay is not one of group ${group.group_no}'s`, 404);
      const key = c.derivedKey(requestKey, `check-in:${stay.id}`);
      if (stay.checkin_key) {
        if (stay.checkin_key !== key) fail(`Stay ${stay.stay_no} is checked in already`, 409);
        continue;
      }
      await folio.checkInIn(db, business, user, stay, raw, { requestKey: key, hash, register: folio.readRegister(raw), waiver: null });
    }
    await repo.audit(db, business.id, user.id, 'lodging_group.checked_in', group.id, { groupNo: group.group_no, stays: list.map((r) => Number(r.stayId)) });
    return load(db, business, group.id);
  });
}

// The group's folio billed, inside the caller's transaction (the group locked): once every stay of the group has left.
async function billIn(db, business, user, group, { requestKey, hash, parts, buyer }) {
  const groupFolio = await repo.one(db, 'SELECT * FROM lodging_folios WHERE business_id=$1 AND group_id=$2 FOR UPDATE', [business.id, group.id]);
  if (groupFolio.document_id) return null;
  const own = await repo.all(db, 'SELECT id,stay_no,status FROM lodging_stays WHERE business_id=$1 AND group_id=$2 ORDER BY id', [business.id, group.id]);
  const open = own.filter((s) => ['reserved', 'in_house'].includes(s.status));
  if (open.length) fail(`The group's folio is billed once every stay of it has left: ${open.map((s) => s.stay_no).join(', ')} ${open.length === 1 ? 'is' : 'are'} still reserved or in the house`, 409);
  const charges = await repo.all(db, `SELECT ch.*,ch.night::text AS night FROM lodging_charges ch WHERE ch.business_id=$1 AND ch.folio_id=$2 AND ch.voided_at IS NULL AND ch.line_id IS NULL
    ORDER BY CASE ch.kind WHEN 'room_night' THEN 0 WHEN 'day_use' THEN 0 WHEN 'meal' THEN 1 ELSE 2 END,ch.night,ch.stay_id,ch.id`, [business.id, groupFolio.id]);
  if (!charges.length) fail(`Nothing is on group ${group.group_no}'s folio to bill`, 409);
  const bill = await stays.postBill(db, business, user, { id: null, location_id: group.location_id }, { values: charges.map(folio.valueOf), contactId: groupFolio.contact_id, parts, buyer,
    key: c.derivedKey(requestKey, 'group'), hash, notes: `Group ${group.group_no} · ${group.name} · ${c.plural(own.length, 'room')}`, stayIds: own.map((s) => s.id) });
  for (const [index, x] of charges.entries()) await db.query('UPDATE lodging_charges SET line_id=$3 WHERE business_id=$1 AND id=$2', [business.id, x.id, bill.lineIds[index]]);
  await db.query('UPDATE lodging_folios SET document_id=$3,billed_at=now() WHERE business_id=$1 AND id=$2', [business.id, groupFolio.id, bill.document.id]);
  const details = { groupNo: group.group_no, documentNo: bill.document.document_no, total: bill.document.total, charges: charges.length, advanceUsed: money.rupees(bill.used.advance),
    depositUsed: money.rupees(bill.used.deposit) };
  await repo.audit(db, business.id, user.id, 'lodging_group.billed', group.id, details);
  await repo.event(db, business.id, user.id, 'lodging_group.billed', 'lodging_group', group.id, { ...details, documentId: bill.document.id });
  return bill;
}

// body: { requestKey, payment? | payments? (the group's folio's bill), buyer? } — the group's folio billed, once every stay of it has left.
async function bill(business, user, groupId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, groupId: String(groupId) });
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  return repo.transaction(async (db) => {
    const group = await lockGroup(db, business, groupId);
    await billIn(db, business, user, group, { requestKey, hash, parts, buyer: body.buyer });
    return load(db, business, group.id);
  });
}

// body: { requestKey, stays?: [{ stayId, payment? | payments?, folioPayments?, billToContactId? }] (left out: every room in the house, each paying
//   nothing now), payment? | payments? (the group's folio's bill), buyer? } — rooms of the group checked out together; once none is left in the
//   house or reserved, the group's folio is billed with them.
async function checkOut(business, user, groupId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, groupId: String(groupId) });
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const given = body.stays === undefined ? null : v.requiredArray(body.stays, 'Rooms to check out');
  const asked = [];
  for (const raw of given || []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Each room to check out must be an object');
    if (raw.refund || raw.waiver) fail('Money handed back and waivers are made at each stay\'s own check-out');
    asked.push({ raw, ...await folio.readCheckout(business, user, raw) });
  }
  return repo.transaction(async (db) => {
    const group = await lockGroup(db, business, groupId);
    const own = await groupStays(db, business, group.id);
    const leaving = given ? asked.map((a) => {
      const stay = own.find((s) => Number(s.id) === Number(a.raw.stayId));
      if (!stay) fail(`That stay is not one of group ${group.group_no}'s`, 404);
      return { stay, ...a };
    }) : own.filter((s) => s.status === 'in_house').map((stay) => ({ stay, raw: {}, parts: [], folioParts: {}, how: null, approval: null, waiver: null }));
    if (!leaving.length && !own.some((s) => s.status === 'in_house')) {
      const done = await repo.one(db, 'SELECT document_id FROM lodging_folios WHERE business_id=$1 AND group_id=$2', [business.id, group.id]);
      if (!done.document_id) await billIn(db, business, user, group, { requestKey, hash, parts, buyer: body.buyer });
      return load(db, business, group.id);
    }
    for (const item of leaving) {
      const key = c.derivedKey(requestKey, `check-out:${item.stay.id}`);
      if (item.stay.checkout_key) {
        if (item.stay.checkout_key !== key) fail(`Stay ${item.stay.stay_no} is checked out already`, 409);
        continue;
      }
      await folio.checkOutIn(db, business, user, item.stay, item.raw, { requestKey: key, hash, parts: item.parts, folioParts: item.folioParts, how: null, approval: null, waiver: null });
    }
    const still = await repo.one(db, "SELECT count(*)::int AS n FROM lodging_stays WHERE business_id=$1 AND group_id=$2 AND status IN ('reserved','in_house')", [business.id, group.id]);
    const unbilled = await repo.one(db, `SELECT count(*)::int AS n FROM lodging_charges ch JOIN lodging_folios f ON f.business_id=ch.business_id AND f.id=ch.folio_id
      WHERE ch.business_id=$1 AND f.group_id=$2 AND ch.voided_at IS NULL AND ch.line_id IS NULL`, [business.id, group.id]);
    if (!still.n && unbilled.n) await billIn(db, business, user, group, { requestKey, hash, parts, buyer: body.buyer });
    else if (parts.length) fail('A payment for the group\'s folio is taken when its bill is made, once every room has left', 409);
    await repo.audit(db, business.id, user.id, 'lodging_group.checked_out', group.id, { groupNo: group.group_no, stays: leaving.map((l) => l.stay.stay_no) });
    return load(db, business, group.id);
  });
}

module.exports = { GROUPS_SQL, create, detail, rooming, checkIn, checkOut, bill, load };
