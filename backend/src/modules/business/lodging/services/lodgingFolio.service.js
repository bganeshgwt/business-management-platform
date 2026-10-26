const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
const money = require('./lodgingMoney');
const stays = require('./lodgingStays.service');
const pins = () => require('../../salon-weight/services/businessManagerPin');

// The check-in, the folio and the check-out (module "lodging").
//
//   check-in    a reservation checks in from its arrival day to the night before
//               its departure, to a room of its type that is vacant and clean
//               and free over its nights; every occupant is recorded, adults and
//               children, not only the one who booked: their name, photo ID (of
//               an Aadhaar card only the last four digits are kept) and
//               nationality, and for a foreigner (an OCI cardholder too) the
//               passport, the visa or OCI card, the date they arrived in India
//               and their next destination. Their Form-III countdowns start now.
//   the folio   a room night for each night of the stay that has come, posted by
//               the night audit (or at check-out) at that night's rate as the
//               stay has it, with the GST slab its value decides; extras (service
//               items at their own slabs) posted by the desk; a mistake voided by
//               a manager (a night posted again at the stay's rates now).
//   night audit every stay in the house gets its room nights up to tonight that
//               are not posted yet; run again, it posts nothing twice.
//   check-out   on the business's date: the nights up to last night (one at
//               least) posted, a night posted ahead and not stayed voided, the
//               stay ending today; one core sale of the folio to the guest or to
//               the company billed (its GSTIN on the invoice; supplied where the
//               property is), paid by what is taken now, then by the advances
//               and the deposits; the room left to be made up; the occupants
//               gone, their Form-III departure countdowns started. A guest's own
//               bill is paid in full unless someone with lodging.approve checks
//               them out; a company's may stay on its dues. What is left of the
//               advances and deposits goes back now (a manager's PIN) or later.
// Money is integer paise.

const { fail, id } = c;
const MAX_GUESTS = 60;
const nightLabel = (stay, roomNo, typeName, night) => `${typeName} · room ${roomNo} · night of ${c.dateWords(night)}`.slice(0, 150);

// --- Occupants ------------------------------------------------------------------------------------------------

// One occupant as typed: { fullName, child?, gender?, age?, phone?, address?, nationality?, foreigner?, idKind?, idRef?,
//   visaType?, visaNo?, arrivedIndiaOn?, nextDestination? }.
function readGuest(raw, index, today) {
  const name = `Occupant ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${name} must be an object`);
  const child = v.requiredBoolean(raw.child, `${name}: a child`, false);
  const foreigner = v.requiredBoolean(raw.foreigner, `${name}: a foreign national`, false);
  const fullName = v.requiredString(typeof raw.fullName === 'string' ? raw.fullName : '', `${name}: name`, 150);
  const nationality = c.optionalText(raw.nationality, `${name}: nationality`, 60) || (foreigner ? null : 'Indian');
  if (!nationality) fail(`${fullName}: give the nationality, as on the passport`);
  const guest = {
    fullName, child, foreigner, nationality,
    gender: c.given(raw.gender) ? v.requiredEnum(raw.gender, `${name}: gender`, c.GENDERS) : null,
    age: c.given(raw.age) ? c.whole(raw.age, `${fullName}: age`, 0, 120) : null,
    phone: c.optionalText(raw.phone, `${fullName}: phone`, 30), address: c.optionalText(raw.address, `${fullName}: address`, 300),
    idKind: null, idRef: null, visaType: null, visaNo: null, arrivedIndiaOn: null, nextDestination: c.optionalText(raw.nextDestination, `${fullName}: next destination`, 150),
  };
  if (c.given(raw.idKind) || c.given(raw.idRef)) Object.assign(guest, c.readId(raw.idKind, raw.idRef, `${fullName}: photo ID`));
  if (!child && !guest.idKind) fail(`${fullName}: record the photo ID seen, its kind and number (of an Aadhaar card, only its last four digits)`);
  if (foreigner) {
    if (guest.idKind !== 'passport') fail(`${fullName} is a foreign national: record their passport (its number) as the photo ID`);
    guest.visaType = c.optionalText(raw.visaType, `${fullName}: visa type`, 40);
    const visaNo = String(raw.visaNo ?? '').toUpperCase().replace(/\s+/g, '');
    if (!guest.visaType || !/^[A-Z0-9/-]{2,40}$/.test(visaNo)) fail(`${fullName}: give the visa's type and number, or for an OCI cardholder "OCI card" and the card's number`);
    guest.visaNo = visaNo;
    guest.arrivedIndiaOn = c.readDate(raw.arrivedIndiaOn, `${fullName}: arrived in India on`);
    if (guest.arrivedIndiaOn > today) fail(`${fullName}: the date of arrival in India is today or before`);
    if (!guest.nextDestination) fail(`${fullName}: give the next destination (city and country), for Form-III`);
  }
  return guest;
}
function readGuests(value, today) {
  const list = v.requiredArray(value, 'Occupants');
  if (!list.length) fail('Record every occupant: the guests staying in the room');
  if (list.length > MAX_GUESTS) fail(`A stay takes at most ${MAX_GUESTS} occupants`);
  return list.map((raw, index) => readGuest(raw, index, today));
}
const GUEST_COLUMNS = 'full_name,child,gender,age,phone,address,nationality,foreigner,id_kind,id_ref,visa_type,visa_no,arrived_india_on,next_destination';
const guestValues = (g) => [g.fullName, g.child, g.gender, g.age, g.phone, g.address, g.nationality, g.foreigner, g.idKind, g.idRef, g.visaType, g.visaNo, g.arrivedIndiaOn, g.nextDestination];

// --- Check-in -------------------------------------------------------------------------------------------------

// body: { requestKey, roomId? (the stay's room when left out), guests: [occupant…], arrivedFrom?, goingTo?, purpose?,
//   advance?: { amount, method | methodId, reference? }, deposit?: { amount, method | methodId, reference? } }
async function checkIn(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, stayId: String(stayId) });
  const register = { arrivedFrom: c.optionalText(body.arrivedFrom, 'Coming from', 150), goingTo: c.optionalText(body.goingTo, 'Going to', 150),
    purpose: c.optionalText(body.purpose, 'Purpose of the visit', 150) };
  return stays.posting(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    if (stay.checkin_key) {
      if (stay.checkin_key !== requestKey || stay.checkin_hash !== hash) fail(`Stay ${stay.stay_no} is checked in already`, 409);
      return stays.shape(business, await stays.load(db, business, stay.id));
    }
    if (stay.status !== 'reserved') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: a reservation checks in`, 409);
    const today = await c.today(db, business);
    const arrival = c.dayOf(stay.arrival), departure = c.dayOf(stay.departure);
    if (today < arrival) fail(`Stay ${stay.stay_no} arrives on ${c.dateWords(arrival)}: change its arrival to today to check in now`, 409);
    if (today >= departure) fail(`Stay ${stay.stay_no} was to leave on ${c.dateWords(departure)}: change its dates first`, 409);
    const guests = readGuests(body.guests, today);
    const grown = guests.filter((g) => !g.child).length, young = guests.length - grown;
    if (grown !== Number(stay.adults) || young !== Number(stay.children)) {
      fail(`Stay ${stay.stay_no} is for ${c.plural(Number(stay.adults), 'adult')}${Number(stay.children) ? ` and ${c.plural(Number(stay.children), 'child', 'children')}` : ''}: record every occupant (${c.plural(grown, 'adult')}${young ? ` and ${c.plural(young, 'child', 'children')}` : ''} given), or change the stay's guests first`);
    }
    const type = await stays.roomTypeOf(db, business, stay.room_type_id);
    const roomId = c.given(body.roomId) ? id(body.roomId, 'Room') : stay.room_id;
    if (!roomId) fail('Choose the room the guest checks in to');
    const room = await stays.roomFor(db, business, roomId, type, stay.location_id);
    if (room.status !== 'vacant_clean') {
      fail(`Room ${room.room_no} is ${c.ROOM_WORDS[room.status]}${room.status_note && room.status === 'out_of_order' ? ` (${room.status_note})` : ''}: a guest checks in to a room that is vacant and clean`, 409);
    }
    const clash = await stays.roomClash(db, business, room.id, arrival, departure, stay.id);
    if (clash) fail(`${stays.clashWords(clash)}: choose another room`, 409);
    const advance = await stays.readMoney(db, business, body.advance, 'Advance');
    const deposit = await stays.readMoney(db, business, body.deposit, 'Deposit');
    await db.query(`UPDATE lodging_stays SET status='in_house',room_id=$3,checked_in_at=now(),checked_in_by=$4,checkin_key=$5,checkin_hash=$6,
        arrived_from=COALESCE($7,arrived_from),going_to=COALESCE($8,going_to),purpose=COALESCE($9,purpose),updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2`,
    [business.id, stay.id, room.id, user.id, requestKey, hash, register.arrivedFrom, register.goingTo, register.purpose]);
    for (const [index, guest] of guests.entries()) {
      await db.query(`INSERT INTO lodging_stay_guests(business_id,stay_id,seq,${GUEST_COLUMNS},created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
        [business.id, stay.id, index + 1, ...guestValues(guest), user.id]);
    }
    await db.query("UPDATE lodging_rooms SET status='occupied',status_note=$3,status_by=$4,status_at=now() WHERE business_id=$1 AND id=$2",
      [business.id, room.id, `Checked in: ${stay.stay_no}`, user.id]);
    const receiptStay = { ...stay, status: 'in_house' };
    if (advance) await stays.takeReceipt(db, business, user, receiptStay, { purpose: 'advance', ...advance, requestKey: c.derivedKey(requestKey, 'advance'), hash });
    if (deposit) await stays.takeReceipt(db, business, user, receiptStay, { purpose: 'deposit', ...deposit, requestKey: c.derivedKey(requestKey, 'deposit'), hash });
    const foreigners = guests.filter((g) => g.foreigner).length;
    await stays.history(db, business, user, stay, 'reserved', 'in_house', [`Checked in to room ${room.room_no}`, `${c.plural(guests.length, 'occupant')} recorded`,
      foreigners ? `${c.plural(foreigners, 'foreign national')}: Form-III due within 24 hours` : null].filter(Boolean).join(' · '));
    const details = { stayNo: stay.stay_no, roomNo: room.room_no, occupants: guests.length, foreigners, idKinds: [...new Set(guests.map((g) => g.idKind).filter(Boolean))] };
    await repo.audit(db, business.id, user.id, 'lodging_stay.checked_in', stay.id, details);
    await repo.event(db, business.id, user.id, 'lodging_stay.checked_in', 'lodging_stay', stay.id, { ...details, roomId: room.id, departure });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// --- The folio ------------------------------------------------------------------------------------------------

// A room night of a stay in the house posted at the stay's rate for that night and the slab its value decides; nothing
// when that night is posted already (the database keeps a night once). Inside the caller's transaction. Returns the row or null.
async function postNight(db, business, user, stay, night, settings, names) {
  const priced = money.priceNight(night, money.ratesOf(stay), { adults: stay.adults, children: stay.children, extraBeds: stay.extra_beds }, settings);
  const row = await repo.one(db, `INSERT INTO lodging_charges(business_id,stay_id,kind,night,room_id,sku_id,label,quantity,rate_kind,room_rate,extra_adults,extra_adult_rate,children,child_rate,
      extra_beds,extra_bed_rate,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,created_by)
    VALUES($1,$2,'room_night',$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,'exclusive',$16,$17,$15,$18,$19)
    ON CONFLICT (business_id,stay_id,night) WHERE kind='room_night' AND voided_at IS NULL DO NOTHING RETURNING *`,
  [business.id, stay.id, night, stay.room_id, names.skuId, nightLabel(stay, names.roomNo, names.typeName, night), priced.rateKind, money.rupees(priced.roomRate), priced.extraAdults,
    stay.extra_adult_rate, priced.children, stay.child_rate, priced.extraBeds, stay.extra_bed_rate, money.rupees(priced.amount), priced.slab.id, Number(priced.slab.rate).toFixed(2),
    money.rupees(priced.tax), user.id]);
  return row;
}
// The item, room and type name a stay's nights are posted with.
async function namesOf(db, business, stay) {
  return repo.one(db, `SELECT t.sku_id AS "skuId",k.label AS "typeName",r.room_no AS "roomNo" FROM lodging_room_types t JOIN catalog_skus k ON k.business_id=t.business_id AND k.id=t.sku_id
    LEFT JOIN lodging_rooms r ON r.business_id=t.business_id AND r.id=$3 WHERE t.business_id=$1 AND t.id=$2`, [business.id, stay.room_type_id, stay.room_id]);
}
// The nights of a stay up to `last` (inclusive) with no charge in force: what is still to post.
async function missingNights(db, business, stay, last) {
  const rows = await repo.all(db, `SELECT n::date::text AS night FROM generate_series($3::date::timestamp,$4::date::timestamp,interval '1 day') n
    WHERE NOT EXISTS (SELECT 1 FROM lodging_charges ch WHERE ch.business_id=$1 AND ch.stay_id=$2 AND ch.kind='room_night' AND ch.voided_at IS NULL AND ch.night=n::date)
    ORDER BY n`, [business.id, stay.id, c.dayOf(stay.arrival), last]);
  return rows.map((r) => r.night);
}

// The night audit: every stay in the house (at the caller's location) gets its room nights up to tonight, or the night
// before it leaves, that are not posted yet. Run again, it posts nothing twice. body: {} — returns what it posted.
async function nightAudit(business, user) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const settings = c.slabsOf(await c.settingsOf(db, business.id));
    const today = await c.today(db, business);
    const inHouse = await repo.all(db, `SELECT * FROM lodging_stays WHERE business_id=$1 AND status='in_house' AND ($2::bigint IS NULL OR location_id=$2) ORDER BY id FOR UPDATE`,
      [business.id, business.location_scope || null]);
    const posted = [];
    for (const stay of inHouse) {
      const last = [today, c.addDays(c.dayOf(stay.departure), -1)].sort()[0];
      if (last < c.dayOf(stay.arrival)) continue;
      const names = await namesOf(db, business, stay);
      const nights = [];
      for (const night of await missingNights(db, business, stay, last)) {
        const row = await postNight(db, business, user, stay, night, settings, names);
        if (row) nights.push(row);
      }
      if (!nights.length) continue;
      const words = nights.map((n) => `${c.dayWords(n.night)} ${n.amount} at ${Number(n.tax_rate)}%`);
      await stays.history(db, business, user, stay, null, null, `Night audit: ${c.plural(nights.length, 'room night')} posted (${words.join(', ')})`);
      await repo.event(db, business.id, user.id, 'lodging_stay.nights_posted', 'lodging_stay', stay.id, { stayNo: stay.stay_no,
        nights: nights.map((n) => ({ night: n.night, amount: n.amount, taxRate: n.tax_rate, tax: n.tax })) });
      posted.push({ stayId: stay.id, stayNo: stay.stay_no, guestName: stay.guest_name, roomNo: names.roomNo,
        nights: nights.map((n) => ({ night: n.night, rateKind: n.rate_kind, amount: n.amount, taxRate: n.tax_rate, tax: n.tax })) });
    }
    const count = posted.reduce((s, p) => s + p.nights.length, 0);
    await repo.audit(db, business.id, user.id, 'lodging.night_audit', null, { today, stays: posted.length, nights: count });
    const shaped = c.seesMoney(business) ? posted : posted.map((p) => ({ ...p, nights: p.nights.map((n) => ({ night: n.night, rateKind: n.rateKind })) }));
    return { today, posted: shaped, nights: count, stays: inHouse.length };
  });
}

// body: { requestKey, skuId, quantity?, price? (in the business's price terms; the item's price when left out), note? } — an extra on the folio.
async function addCharge(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const requestKey = core.uuid(body.requestKey);
  const skuId = id(body.skuId, 'Item');
  const quantityText = c.given(body.quantity) ? String(body.quantity).trim() : '1';
  if (!/^\d{1,5}(\.\d{1,3})?$/.test(quantityText) || Number(quantityText) <= 0) fail('How many is a quantity from 0.001 to 10000');
  const note = c.optionalText(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    const old = await repo.one(db, 'SELECT id,stay_id,sku_id,quantity FROM lodging_charges WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (Number(old.stay_id) !== Number(stay.id) || Number(old.sku_id) !== skuId || Number(old.quantity) !== Number(quantityText)) fail('This request key was already used for different data', 409);
      return stays.shape(business, await stays.load(db, business, stay.id));
    }
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: charges go on the folio while the guest is in the house`, 409);
    const sku = await repo.one(db, `SELECT s.*,p.kind,u.decimals AS unit_decimals,(s.active AND p.active) AS in_use FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      JOIN business_units u ON u.business_id=s.business_id AND u.code=s.unit WHERE s.business_id=$1 AND s.id=$2`, [business.id, skuId]);
    if (!sku) fail('Item not found', 404);
    if (!sku.in_use) fail(`${sku.label} is switched off in the catalogue`, 409);
    if (sku.kind !== 'service') fail(`${sku.label} is goods kept in stock: sell it on a bill of its own; the folio takes services`, 409);
    if (sku.internal_use) fail(`${sku.label} is kept for use in services only and is not billed`, 409);
    if (await repo.one(db, 'SELECT 1 FROM lodging_room_types WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id])) fail(`${sku.label} is a room type's nights: the night audit posts them`, 409);
    const decimals = (quantityText.split('.')[1] || '').length;
    if (decimals > Number(sku.unit_decimals)) fail(`${sku.label} is counted in whole ${sku.unit === 'service' ? 'services' : `${sku.unit}s`}`);
    const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
    const taxMode = settings?.tax_mode || 'exclusive';
    const price = c.given(body.price) ? money.paise(core.decimal(body.price, 'Price', 2, 0.01, 10000000)) : money.paise(sku.price);
    if (price <= 0) fail(`${sku.label} has no price in the catalogue: type the price charged`);
    const figures = money.extraFigures({ price, quantity: quantityText, taxRate: sku.tax_rate, taxMode });
    if (figures.amount <= 0) fail('The charge comes to nothing');
    const today = await c.today(db, business);
    const label = [sku.label, note].filter(Boolean).join(' · ').slice(0, 150);
    await db.query(`INSERT INTO lodging_charges(business_id,stay_id,kind,night,sku_id,label,quantity,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,note,request_key,created_by)
      VALUES($1,$2,'extra',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [business.id, stay.id, today, sku.id, label, quantityText, (price / 100).toFixed(4), money.rupees(figures.amount),
      taxMode, sku.tax_rate_id, Number(sku.tax_rate).toFixed(2), money.rupees(figures.net), money.rupees(figures.tax), note, requestKey, user.id]);
    await stays.history(db, business, user, stay, null, null, `Charged: ${label} ${money.rupees(figures.net + (taxMode === 'inclusive' ? 0 : figures.tax))}`);
    const details = { stayNo: stay.stay_no, item: sku.label, quantity: quantityText, amount: money.rupees(figures.amount), taxRate: Number(sku.tax_rate).toFixed(2) };
    await repo.audit(db, business.id, user.id, 'lodging_charge.posted', stay.id, details);
    await repo.event(db, business.id, user.id, 'lodging_charge.posted', 'lodging_stay', stay.id, { ...details, skuId: sku.id });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// body: { reason } — a charge posted by mistake, voided before it is billed (lodging.approve). A room night is posted
// again at the stay's rates now (every night of a stay is billed); an extra is left off the bill.
async function voidCharge(business, user, stayId, chargeId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.approve');
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    const charge = await repo.one(db, 'SELECT * FROM lodging_charges WHERE business_id=$1 AND stay_id=$2 AND id=$3 FOR UPDATE', [business.id, stay.id, id(chargeId, 'Charge')]);
    if (!charge) fail('Charge not found', 404);
    if (charge.voided_at) return stays.shape(business, await stays.load(db, business, stay.id));
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: a charge is voided while the guest is in the house`, 409);
    if (charge.line_id) fail('That charge is billed: credit it on the bill instead', 409);
    await db.query('UPDATE lodging_charges SET voided_at=now(),voided_by=$3,void_reason=$4 WHERE business_id=$1 AND id=$2', [business.id, charge.id, user.id, reason]);
    let again = null;
    if (charge.kind === 'room_night') {
      const settings = c.slabsOf(await c.settingsOf(db, business.id));
      again = await postNight(db, business, user, stay, charge.night, settings, await namesOf(db, business, stay));
    }
    await stays.history(db, business, user, stay, null, null, `Voided: ${charge.label} ${charge.amount} — ${reason}${again ? ` · posted again at ${again.amount} with GST ${Number(again.tax_rate)}%` : ''}`);
    const details = { stayNo: stay.stay_no, label: charge.label, amount: charge.amount, reason, ...(again ? { postedAgain: again.amount, taxRate: again.tax_rate } : {}) };
    await repo.audit(db, business.id, user.id, 'lodging_charge.voided', stay.id, details);
    await repo.event(db, business.id, user.id, 'lodging_charge.voided', 'lodging_stay', stay.id, { ...details, chargeId: charge.id });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// --- Check-out ------------------------------------------------------------------------------------------------

// The check-out worked out, nothing written: the nights to post now and those posted ahead and not stayed, the
// day it ends, the bill's values (every night and extra not billed), its figures, and what the advances and
// deposits pay and what is left of them.
async function planCheckout(db, business, stay) {
  const today = await c.today(db, business);
  const arrival = c.dayOf(stay.arrival), departure = c.dayOf(stay.departure);
  if (today > departure) fail(`Stay ${stay.stay_no} was to leave on ${c.dateWords(departure)}: extend it to today first`, 409);
  const ends = [today, c.addDays(arrival, 1)].sort().at(-1);
  const settings = c.slabsOf(await c.settingsOf(db, business.id));
  const names = await namesOf(db, business, stay);
  const charges = await repo.all(db, `SELECT * FROM lodging_charges WHERE business_id=$1 AND stay_id=$2 AND voided_at IS NULL AND line_id IS NULL ORDER BY kind<>'room_night',night,id`,
    [business.id, stay.id]);
  const ahead = charges.filter((x) => x.kind === 'room_night' && x.night >= ends);
  const kept = charges.filter((x) => !(x.kind === 'room_night' && x.night >= ends));
  const missing = (await missingNights(db, business, stay, c.addDays(ends, -1)));
  const party = { adults: stay.adults, children: stay.children, extraBeds: stay.extra_beds };
  const toPost = missing.map((night) => ({ night, ...money.priceNight(night, money.ratesOf(stay), party, settings) }));
  const fromRow = (x) => ({ ref: { kind: 'charge', charge: x }, skuId: x.sku_id, quantity: Number(x.quantity), net: money.paise(x.net), tax: money.paise(x.tax), taxRate: Number(x.tax_rate), label: x.label,
    night: x.kind === 'room_night' ? x.night : null });
  const fromNew = (n) => ({ ref: { kind: 'night', night: n.night }, skuId: names.skuId, quantity: 1, net: n.net, tax: n.tax, taxRate: Number(n.slab.rate),
    label: nightLabel(stay, names.roomNo, names.typeName, n.night), night: n.night });
  const values = [...kept.filter((x) => x.kind === 'room_night').map(fromRow), ...toPost.map(fromNew)].sort((a, b) => a.night.localeCompare(b.night))
    .concat(kept.filter((x) => x.kind !== 'room_night').map(fromRow));
  const settingsRow = await repo.one(db, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const figures = money.billFigures(values, settingsRow?.rounding);
  const receipts = await stays.receiptsOf(db, business, stay.id);
  const free = (purpose) => receipts.filter((r) => r.purpose === purpose).reduce((s, r) => s + Math.max(0, money.paise(r.free)), 0);
  const advance = Math.min(free('advance'), figures.total);
  const deposit = Math.min(free('deposit'), figures.total - advance);
  return { today, ends, early: ends < departure, settings, names, ahead, toPost, values, figures, advance, deposit, due: figures.total - advance - deposit,
    depositBack: free('deposit') - deposit, advanceBack: free('advance') - advance };
}

const planText = (plan, stay, business) => ({
  stayNo: stay.stay_no, today: plan.today, departure: plan.ends, early: plan.early, nightsToPost: plan.toPost.map((n) => n.night), nightsNotStayed: plan.ahead.map((x) => x.night),
  billTo: stay.bill_to_contact_id ? 'company' : 'guest',
  ...(c.seesMoney(business) ? {
    ...money.figuresText(plan.figures), advance: money.rupees(plan.advance), deposit: money.rupees(plan.deposit), due: money.rupees(plan.due),
    depositBack: money.rupees(plan.depositBack), advanceBack: money.rupees(plan.advanceBack),
    bill: plan.values.map((x) => ({ label: x.label, quantity: x.quantity, net: money.rupees(x.net), tax: money.rupees(x.tax), taxRate: Number(x.taxRate).toFixed(2) })),
  } : {}),
});

// The figures of a check-out, nothing saved (the check-out screen).
async function checkoutPreview(business, user, stayId) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  // Nothing is locked: a preview never waits for a posting.
  return repo.transaction(async (db) => {
    const stay = await repo.one(db, 'SELECT * FROM lodging_stays WHERE business_id=$1 AND id=$2', [business.id, id(stayId, 'Stay')]);
    if (!stay) fail('Stay not found', 404);
    access.requireLocation(business, stay.location_id);
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: a guest in the house checks out`, 409);
    return planText(await planCheckout(db, business, stay), stay, business);
  });
}

// body: { requestKey, billToContactId? (null: the guest; left out: as the stay has it), payment? | payments? (the rest of the bill),
//   refund?: { method | methodId, reference? } (what is left of the advances and deposits, handed back), approval?: { approverId?, pin?, reason? },
//   buyer?: { pan?, panDeclaration? } }
async function checkOut(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, approval: undefined, stayId: String(stayId) });
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const how = body.refund ? stays.readBack(body.refund) : null;
  if (how) await access.require(business, 'lodging.refund');
  // A manager's PIN for money handed back, checked before the transaction (a PIN check holds no locks).
  const approval = how ? await pins().readApproval(business, user, { ...(body.approval || {}),
    reason: c.given(body.approval?.reason) ? body.approval.reason : 'Advance and deposit left handed back at check-out' }, 'lodging.refund', { reasonLabel: 'Reason' }) : null;
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    if (stay.checkout_key) {
      if (stay.checkout_key !== requestKey || stay.checkout_hash !== hash) fail(`Stay ${stay.stay_no} is checked out already`, 409);
      return stays.shape(business, await stays.load(db, business, stay.id));
    }
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: a guest in the house checks out`, 409);
    // Who is billed: as the stay has it, or changed now.
    let billTo = stay.bill_to_contact_id ? { id: Number(stay.bill_to_contact_id) } : null;
    if (body.billToContactId !== undefined) {
      billTo = await stays.billToOf(db, business, body.billToContactId, stay.contact_id);
      if (Number(billTo?.id || 0) !== Number(stay.bill_to_contact_id || 0)) {
        await db.query('UPDATE lodging_stays SET bill_to_contact_id=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, stay.id, billTo?.id || null, user.id]);
        stay.bill_to_contact_id = billTo?.id || null;
      }
    }
    const plan = await planCheckout(db, business, stay);
    // A night posted ahead and not stayed (the guest leaves early) is voided; the nights to last night are posted.
    for (const x of plan.ahead) {
      await db.query('UPDATE lodging_charges SET voided_at=now(),voided_by=$3,void_reason=$4 WHERE business_id=$1 AND id=$2',
        [business.id, x.id, user.id, `Checked out on ${c.dateWords(plan.today)}: the night of ${c.dateWords(x.night)} was not stayed`]);
    }
    const posted = [];
    for (const n of plan.toPost) {
      const row = await postNight(db, business, user, stay, n.night, plan.settings, plan.names);
      if (!row) fail('A room night was posted by another screen just now. Try again.', 409);
      posted.push(row);
    }
    const bill = await stays.postBill(db, business, user, stay, {
      values: plan.values.map(({ ref: _ref, night: _night, ...value }) => value), contactId: billTo?.id || stay.contact_id, parts, buyer: body.buyer, key: requestKey, hash,
      notes: `Stay ${stay.stay_no} · room ${plan.names.roomNo} · ${c.nightsWords(c.dayOf(stay.arrival), plan.ends)} · guest ${stay.guest_name}` });
    // What is still due once the advances and deposits paid: a company's stays on its dues; a guest's needs a manager.
    const owed = await repo.one(db, `SELECT ${c.DUE_SQL('d')} AS due FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, bill.document.id]);
    if (money.paise(owed.due) > 0 && !billTo && !access.can(business, 'lodging.approve')) {
      fail(`${money.rupees(money.paise(owed.due))} is left to pay on the bill: take the payment, or have a manager check the guest out with it left on their dues`, 409,
        { reason: 'bill_due', due: money.rupees(money.paise(owed.due)) });
    }
    for (const [index, x] of plan.values.entries()) {
      const chargeId = x.ref.kind === 'charge' ? x.ref.charge.id : posted.find((p) => p.night === x.ref.night).id;
      await db.query('UPDATE lodging_charges SET line_id=$3 WHERE business_id=$1 AND id=$2', [business.id, chargeId, bill.lineIds[index]]);
    }
    await db.query(`UPDATE lodging_stays SET status='checked_out',departure=$3,checked_out_at=now(),checked_out_by=$4,checkout_key=$5,checkout_hash=$6,document_id=$7,updated_by=$4,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, stay.id, plan.ends, user.id, requestKey, hash, bill.document.id]);
    await db.query('UPDATE lodging_stay_guests SET departed_at=now(),updated_by=$3,updated_at=now() WHERE business_id=$1 AND stay_id=$2 AND departed_at IS NULL', [business.id, stay.id, user.id]);
    await db.query("UPDATE lodging_rooms SET status='vacant_dirty',status_note=$3,status_by=$4,status_at=now() WHERE business_id=$1 AND id=$2",
      [business.id, stay.room_id, `Checked out: ${stay.stay_no}`, user.id]);
    const back = how ? await stays.refundLeft(db, business, user, stay, { how, approval, key: requestKey }) : [];
    const refunded = back.reduce((s, r) => s + money.paise(r.amount), 0);
    const foreigners = (await repo.one(db, 'SELECT count(*)::int AS n FROM lodging_stay_guests WHERE business_id=$1 AND stay_id=$2 AND foreigner', [business.id, stay.id])).n;
    await stays.history(db, business, user, stay, 'in_house', 'checked_out', [`Checked out of room ${plan.names.roomNo}`, `billed (${bill.document.document_no})`,
      plan.ahead.length ? `${c.plural(plan.ahead.length, 'night')} not stayed voided` : null, bill.used.advance ? 'the advance applied to the bill' : null,
      bill.used.deposit ? 'the deposit applied to the bill' : null, refunded ? `${money.rupees(refunded)} handed back (${back.map((r) => r.refund_no).join(', ')})` : null,
      foreigners ? 'Form-III departure due within 24 hours' : null].filter(Boolean).join(' · '));
    const details = { stayNo: stay.stay_no, roomNo: plan.names.roomNo, documentNo: bill.document.document_no, billTotal: bill.document.total, billedTo: billTo ? 'company' : 'guest',
      nights: money.nightCount(c.dayOf(stay.arrival), plan.ends), advanceUsed: money.rupees(bill.used.advance), depositUsed: money.rupees(bill.used.deposit), handedBack: money.rupees(refunded),
      ...(approval && refunded ? { approvedBy: approval.approver.name } : {}) };
    await repo.audit(db, business.id, user.id, 'lodging_stay.checked_out', stay.id, details);
    await repo.event(db, business.id, user.id, 'lodging_stay.checked_out', 'lodging_stay', stay.id, { ...details, documentId: bill.document.id, roomId: stay.room_id });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

module.exports = { readGuest, readGuests, GUEST_COLUMNS, guestValues, checkIn, postNight, namesOf, missingNights, nightAudit, addCharge, voidCharge, planCheckout, checkoutPreview, checkOut };
