const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
const money = require('./lodgingMoney');
const stays = require('./lodgingStays.service');

// The check-in, the folio and the check-out (module "lodging").
//
//   check-in    a reservation checks in from its arrival day to the night before
//               its departure (a day use on its day), to a room of its type that
//               is vacant and clean and free over its nights; every occupant is
//               recorded, adults and children, not only the one who booked: their
//               name, photo ID (of an Aadhaar card only the last four digits are
//               kept) and nationality, and for a foreigner (an OCI cardholder too)
//               the passport, the visa or OCI card, the date they arrived in India
//               and their next destination. Their Form-III countdowns start now.
//               Before the property's check-in time on the arrival day, the
//               policy's early check-in charge goes on the folio (a manager may
//               waive it); a day use's price goes on the folio.
//   the folio   a room night for each night of the stay that has come, posted by
//               the night audit (or at check-out) at that night's rates as the
//               stay keeps them, less its discount, with the GST slab its value
//               decides, and its plan's meals as their own line at the meal
//               item's slab; extras (service items) and goods kept in stock (at
//               their own slabs; the goods leave stock when their folio is
//               billed) posted by the desk; each charge on the folio its routing
//               sends it to; a mistake voided by a manager (a night posted again
//               at the stay's rates now).
//   night audit every stay in the house gets its room nights up to tonight that
//               are not posted yet; run again, it posts nothing twice.
//   check-out   on the business's date: the nights up to last night (one at
//               least) posted, a night posted ahead and not stayed voided, the
//               stay ending today; after the property's check-out time on the
//               departure day the policy's late check-out charge (a manager may
//               waive it); each folio billed through the core with its own GST
//               invoice: the main one to the guest or to the company billed (its
//               GSTIN on the invoice; supplied where the property is), each other
//               to whom it is billed, paid by what is taken now, then by the
//               advances and the deposits; a group's folio is billed with the
//               group; the room left to be made up; the occupants gone, their
//               Form-III departure countdowns started. A guest's own bill is paid
//               in full unless someone with lodging.approve checks them out; a
//               company's may stay on its dues. What is left of the advances and
//               deposits goes back now (a manager's PIN) or later.
// Money is integer paise.

const { fail, id } = c;
const MAX_GUESTS = 60;
const nightLabel = (stay, roomNo, typeName, night) => `${typeName} · room ${roomNo} · night of ${c.dateWords(night)}`.slice(0, 150);
const ORDER = "CASE ch.kind WHEN 'room_night' THEN 0 WHEN 'day_use' THEN 0 WHEN 'meal' THEN 1 ELSE 2 END,ch.night,ch.id";

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

// --- Routing ----------------------------------------------------------------------------------------------------

// The folio each kind of charge of a stay goes to (none: the main folio).
async function routesOf(db, business, stayId) {
  return Object.fromEntries((await repo.all(db, 'SELECT category,folio_id FROM lodging_routes WHERE business_id=$1 AND stay_id=$2', [business.id, stayId]))
    .map((r) => [r.category, Number(r.folio_id)]));
}
const folioFor = (routes, kind) => routes[c.CATEGORY[kind]] || null;

// --- Check-in ---------------------------------------------------------------------------------------------------

// A charge the policy works out from a night (an early check-in or a late check-out), posted to the folio at that night's slab.
async function postPolicyCharge(db, business, user, stay, { kind, amount, slab, night, names, routes, key }) {
  const label = `${kind === 'early_check_in' ? 'Early check-in' : 'Late check-out'} · ${names.typeName} · room ${names.roomNo}`.slice(0, 150);
  return repo.one(db, `INSERT INTO lodging_charges(business_id,stay_id,kind,night,sku_id,label,quantity,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,request_key,created_by,folio_id)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$7,'exclusive',$8,$9,$7,$10,$11,$12,$13) RETURNING *`, [business.id, stay.id, kind, night, names.skuId, label, money.rupees(amount), slab.id,
    Number(slab.rate).toFixed(2), money.rupees(money.taxOn(amount, slab.rate)), key, user.id, folioFor(routes, kind)]);
}

// The check-in inside the caller's transaction (the stay locked): the occupants, the room, the early check-in charge or the day use's price,
// an advance and a deposit. Returns nothing; the caller loads the stay.
async function checkInIn(db, business, user, stay, body, { requestKey, hash, register, waiver }) {
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
  if (stay.day_use && Number(roomId) !== Number(stay.room_id)) fail(`Stay ${stay.stay_no} is a day use: it checks in to the room it booked`, 409);
  const room = await stays.roomFor(db, business, roomId, type, stay.location_id);
  if (room.status !== 'vacant_clean') {
    fail(`Room ${room.room_no} is ${c.ROOM_WORDS[room.status]}${room.status_note && room.status === 'out_of_order' ? ` (${room.status_note})` : ''}: a guest checks in to a room that is vacant and clean`, 409);
  }
  if (!stay.day_use) {
    const clash = await stays.roomClash(db, business, room.id, arrival, departure, stay.id);
    if (clash) fail(`${stays.clashWords(clash)}: choose another room`, 409);
  }
  const advance = await stays.readMoney(db, business, body.advance, 'Advance');
  const deposit = await stays.readMoney(db, business, body.deposit, 'Deposit');
  // Before the property's check-in time on the arrival day: the policy's early check-in charge (a manager may waive it).
  const terms = stay.day_use ? null : await stays.policyNow(db, business, stay);
  const early = terms?.early.now && terms.early.amount > 0 ? terms.early : null;
  if (waiver && !early) fail(`Stay ${stay.stay_no} has no early check-in charge to waive`, 409);
  await db.query(`UPDATE lodging_stays SET status='in_house',room_id=$3,checked_in_at=now(),checked_in_by=$4,checkin_key=$5,checkin_hash=$6,
      arrived_from=COALESCE($7,arrived_from),going_to=COALESCE($8,going_to),purpose=COALESCE($9,purpose),updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2`,
  [business.id, stay.id, room.id, user.id, requestKey, hash, register.arrivedFrom, register.goingTo, register.purpose]);
  for (const [index, guest] of guests.entries()) {
    await db.query(`INSERT INTO lodging_stay_guests(business_id,stay_id,seq,${GUEST_COLUMNS},created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
      [business.id, stay.id, index + 1, ...guestValues(guest), user.id]);
  }
  await db.query("UPDATE lodging_rooms SET status='occupied',status_note=$3,status_by=$4,status_at=now() WHERE business_id=$1 AND id=$2",
    [business.id, room.id, `Checked in: ${stay.stay_no}`, user.id]);
  const inHouse = { ...stay, status: 'in_house', room_id: room.id };
  const names = await namesOf(db, business, inHouse);
  const routes = await routesOf(db, business, stay.id);
  let charged = null;
  if (stay.day_use) {
    charged = await postDayUse(db, business, user, inHouse, names, routes, c.derivedKey(requestKey, 'day-use'));
  } else if (early && waiver) {
    await stays.recordWaiver(db, business, user, stay, { charge: 'early_check_in', amount: early.amount, waiver });
  } else if (early) {
    charged = await postPolicyCharge(db, business, user, inHouse, { kind: 'early_check_in', amount: early.amount, slab: early.slab, night: arrival, names, routes,
      key: c.derivedKey(requestKey, 'early') });
  }
  if (advance) await stays.takeReceipt(db, business, user, inHouse, { purpose: 'advance', ...advance, requestKey: c.derivedKey(requestKey, 'advance'), hash });
  if (deposit) await stays.takeReceipt(db, business, user, inHouse, { purpose: 'deposit', ...deposit, requestKey: c.derivedKey(requestKey, 'deposit'), hash });
  const foreigners = guests.filter((g) => g.foreigner).length;
  await stays.history(db, business, user, stay, 'reserved', 'in_house', [`Checked in to room ${room.room_no}`, `${c.plural(guests.length, 'occupant')} recorded`,
    charged?.kind === 'early_check_in' ? `early check-in charged (${charged.amount})` : null, charged?.kind === 'day_use' ? `day use charged (${charged.amount})` : null,
    foreigners ? `${c.plural(foreigners, 'foreign national')}: Form-III due within 24 hours` : null].filter(Boolean).join(' · '));
  const details = { stayNo: stay.stay_no, roomNo: room.room_no, occupants: guests.length, foreigners, idKinds: [...new Set(guests.map((g) => g.idKind).filter(Boolean))],
    ...(charged ? { charged: { kind: charged.kind, amount: charged.amount } } : {}) };
  await repo.audit(db, business.id, user.id, 'lodging_stay.checked_in', stay.id, details);
  await repo.event(db, business.id, user.id, 'lodging_stay.checked_in', 'lodging_stay', stay.id, { ...details, roomId: room.id, departure });
}
const readRegister = (body) => ({ arrivedFrom: c.optionalText(body.arrivedFrom, 'Coming from', 150), goingTo: c.optionalText(body.goingTo, 'Going to', 150),
  purpose: c.optionalText(body.purpose, 'Purpose of the visit', 150) });

// body: { requestKey, roomId? (the stay's room when left out), guests: [occupant…], arrivedFrom?, goingTo?, purpose?,
//   advance?: { amount, method | methodId, reference? }, deposit?: { amount, method | methodId, reference? }, waiver?: { reason, approverId?, pin? } (the early check-in charge) }
async function checkIn(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, waiver: stays.waiverKey(body.waiver), stayId: String(stayId) });
  const register = readRegister(body);
  const waiver = await stays.readWaiver(business, user, body.waiver);
  return stays.posting(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    if (stay.checkin_key) {
      if (stay.checkin_key !== requestKey || stay.checkin_hash !== hash) fail(`Stay ${stay.stay_no} is checked in already`, 409);
      return stays.shape(business, await stays.load(db, business, stay.id));
    }
    await checkInIn(db, business, user, stay, body, { requestKey, hash, register, waiver });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// --- The folio ------------------------------------------------------------------------------------------------

// The item, room, type and plan names a stay's nights are posted with.
async function namesOf(db, business, stay) {
  return repo.one(db, `SELECT t.sku_id AS "skuId",k.label AS "typeName",r.room_no AS "roomNo",p.name AS "planName",p.meal_plan AS "mealPlan"
    FROM lodging_room_types t JOIN catalog_skus k ON k.business_id=t.business_id AND k.id=t.sku_id
    LEFT JOIN lodging_rooms r ON r.business_id=t.business_id AND r.id=$3 LEFT JOIN lodging_rate_plans p ON p.business_id=t.business_id AND p.id=$4
    WHERE t.business_id=$1 AND t.id=$2`, [business.id, stay.room_type_id, stay.room_id, stay.rate_plan_id || null]);
}
// A night's rates as the stay keeps them, priced for its party and discount; refused when the night has none.
async function pricedNight(db, business, stay, night, settings) {
  const row = await repo.one(db, 'SELECT n.*,n.night::text AS night FROM lodging_stay_nights n WHERE n.business_id=$1 AND n.stay_id=$2 AND n.night=$3', [business.id, stay.id, night]);
  if (!row) fail(`The night of ${c.dateWords(night)} of stay ${stay.stay_no} has no rate: change the stay to price it again`, 409);
  return { row: money.nightRow(row), ...money.priceRow(money.nightRow(row), stays.partyOf(stay), settings, stay.discount_percent) };
}

// A room night of a stay in the house posted at the stay's rates for that night, less its discount, at the slab its value decides,
// with the plan's meals for that night as their own charge; nothing when that night is posted already (the database keeps a night
// once). Inside the caller's transaction. Returns the room night's row (with `meal`, the meals' row) or null.
async function postNight(db, business, user, stay, night, settings, names, routes = {}) {
  const priced = await pricedNight(db, business, stay, night, settings);
  const r = priced.row;
  const row = await repo.one(db, `INSERT INTO lodging_charges(business_id,stay_id,kind,night,room_id,sku_id,label,quantity,rate_kind,room_rate,extra_adults,extra_adult_rate,children,child_rate,
      extra_beds,extra_bed_rate,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,created_by,discount,folio_id)
    VALUES($1,$2,'room_night',$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,'exclusive',$16,$17,$15,$18,$19,$20,$21)
    ON CONFLICT (business_id,stay_id,night) WHERE kind='room_night' AND voided_at IS NULL DO NOTHING RETURNING *`,
  [business.id, stay.id, night, stay.room_id, names.skuId, nightLabel(stay, names.roomNo, names.typeName, night), r.rateKind, money.rupees(r.roomRate), priced.extraAdults,
    r.extraAdult === null ? null : money.rupees(r.extraAdult), priced.children, r.child === null ? null : money.rupees(r.child), priced.extraBeds,
    r.extraBed === null ? null : money.rupees(r.extraBed), money.rupees(priced.amount), priced.slab.id, Number(priced.slab.rate).toFixed(2), money.rupees(priced.tax), user.id,
    priced.discount ? money.rupees(priced.discount) : null, folioFor(routes, 'room_night')]);
  if (row && r.mealSkuId && priced.meal > 0) {
    const sku = await repo.one(db, 'SELECT tax_rate,tax_rate_id FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, r.mealSkuId]);
    const label = `${names.planName || 'Plan'} meals (${names.mealPlan || 'plan'}) · ${c.plural(Number(stay.adults), 'adult')}${Number(stay.children) ? `, ${c.plural(Number(stay.children), 'child', 'children')}` : ''} · night of ${c.dateWords(night)}`;
    row.meal = await repo.one(db, `INSERT INTO lodging_charges(business_id,stay_id,kind,night,sku_id,label,quantity,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,created_by,folio_id)
      VALUES($1,$2,'meal',$3,$4,$5,1,$6,$6,'exclusive',$7,$8,$6,$9,$10,$11) ON CONFLICT (business_id,stay_id,night) WHERE kind='meal' AND voided_at IS NULL DO NOTHING RETURNING *`,
    [business.id, stay.id, night, r.mealSkuId, label.slice(0, 150), money.rupees(priced.meal), sku.tax_rate_id, Number(sku.tax_rate).toFixed(2),
      money.rupees(money.taxOn(priced.meal, sku.tax_rate)), user.id, folioFor(routes, 'meal')]);
  }
  return row;
}
// A day use's price posted on its folio, less the discount, at the slab its value would take for a night.
async function postDayUse(db, business, user, stay, names, routes, key) {
  const settings = c.slabsOf(await c.settingsOf(db, business.id));
  const priced = await pricedNight(db, business, stay, c.dayOf(stay.arrival), settings);
  const hours = Number(stay.day_hours);
  return repo.one(db, `INSERT INTO lodging_charges(business_id,stay_id,kind,night,room_id,sku_id,label,quantity,rate_kind,room_rate,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,
      request_key,created_by,discount,folio_id)
    VALUES($1,$2,'day_use',$3,$4,$5,$6,1,'day_use',$7,$8,$8,'exclusive',$9,$10,$8,$11,$12,$13,$14,$15) RETURNING *`,
  [business.id, stay.id, c.dayOf(stay.arrival), stay.room_id, names.skuId, `${names.typeName} · room ${names.roomNo} · day use, ${c.plural(hours, 'hour')} on ${c.dateWords(stay.arrival)}`.slice(0, 150),
    money.rupees(priced.row.roomRate), money.rupees(priced.amount), priced.slab.id, Number(priced.slab.rate).toFixed(2), money.rupees(priced.tax), key, user.id,
    priced.discount ? money.rupees(priced.discount) : null, folioFor(routes, 'day_use')]);
}
// The nights of a stay up to `last` (inclusive) with no charge in force: what is still to post.
async function missingNights(db, business, stay, last) {
  const rows = await repo.all(db, `SELECT n::date::text AS night FROM generate_series($3::date::timestamp,$4::date::timestamp,interval '1 day') n
    WHERE NOT EXISTS (SELECT 1 FROM lodging_charges ch WHERE ch.business_id=$1 AND ch.stay_id=$2 AND ch.kind='room_night' AND ch.voided_at IS NULL AND ch.night=n::date)
    ORDER BY n`, [business.id, stay.id, c.dayOf(stay.arrival), last]);
  return rows.map((r) => r.night);
}
// The room nights (or the day use) of a stay in the house posted and not billed, voided and posted again at its rates now (its discount changed).
// Returns how many were posted again.
async function repostNights(db, business, user, stay, reason) {
  const settings = c.slabsOf(await c.settingsOf(db, business.id));
  const names = await namesOf(db, business, stay);
  const routes = await routesOf(db, business, stay.id);
  const open = await repo.all(db, `SELECT * FROM lodging_charges WHERE business_id=$1 AND stay_id=$2 AND kind IN ('room_night','day_use') AND voided_at IS NULL AND line_id IS NULL
    ORDER BY night FOR UPDATE`, [business.id, stay.id]);
  for (const charge of open) {
    await db.query('UPDATE lodging_charges SET voided_at=now(),voided_by=$3,void_reason=$4 WHERE business_id=$1 AND id=$2', [business.id, charge.id, user.id, reason.slice(0, 300)]);
    if (charge.kind === 'day_use') await postDayUse(db, business, user, stay, names, { room: charge.folio_id }, c.derivedKey(charge.request_key, `again:${charge.id}`));
    else await postNight(db, business, user, stay, c.dayOf(charge.night), settings, names, { room: charge.folio_id });
  }
  return open.length;
}

// The night audit: every stay in the house (at the caller's location) gets its room nights up to tonight, or the night
// before it leaves, that are not posted yet, with their meals. Run again, it posts nothing twice. body: {} — returns what it posted.
async function nightAudit(business, user) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const settings = c.slabsOf(await c.settingsOf(db, business.id));
    const today = await c.today(db, business);
    const inHouse = await repo.all(db, `SELECT * FROM lodging_stays WHERE business_id=$1 AND status='in_house' AND NOT day_use AND ($2::bigint IS NULL OR location_id=$2) ORDER BY id FOR UPDATE`,
      [business.id, business.location_scope || null]);
    const posted = [];
    for (const stay of inHouse) {
      const last = [today, c.addDays(c.dayOf(stay.departure), -1)].sort()[0];
      if (last < c.dayOf(stay.arrival)) continue;
      const names = await namesOf(db, business, stay);
      const routes = await routesOf(db, business, stay.id);
      const nights = [];
      for (const night of await missingNights(db, business, stay, last)) {
        const row = await postNight(db, business, user, stay, night, settings, names, routes);
        if (row) nights.push(row);
      }
      if (!nights.length) continue;
      const words = nights.map((n) => `${c.dayWords(n.night)} ${n.amount} at ${Number(n.tax_rate)}%${n.meal ? `, meals ${n.meal.amount} at ${Number(n.meal.tax_rate)}%` : ''}`);
      await stays.history(db, business, user, stay, null, null, `Night audit: ${c.plural(nights.length, 'room night')} posted (${words.join('; ')})`);
      await repo.event(db, business.id, user.id, 'lodging_stay.nights_posted', 'lodging_stay', stay.id, { stayNo: stay.stay_no,
        nights: nights.map((n) => ({ night: n.night, amount: n.amount, taxRate: n.tax_rate, tax: n.tax, ...(n.meal ? { meals: n.meal.amount, mealsTaxRate: n.meal.tax_rate } : {}) })) });
      posted.push({ stayId: stay.id, stayNo: stay.stay_no, guestName: stay.guest_name, roomNo: names.roomNo,
        nights: nights.map((n) => ({ night: n.night, rateKind: n.rate_kind, amount: n.amount, discount: n.discount, taxRate: n.tax_rate, tax: n.tax,
          meals: n.meal ? { amount: n.meal.amount, taxRate: n.meal.tax_rate, tax: n.meal.tax } : null })) });
    }
    const count = posted.reduce((s, p) => s + p.nights.length, 0);
    await repo.audit(db, business.id, user.id, 'lodging.night_audit', null, { today, stays: posted.length, nights: count });
    const shaped = c.seesMoney(business) ? posted : posted.map((p) => ({ ...p, nights: p.nights.map((n) => ({ night: n.night, rateKind: n.rateKind })) }));
    return { today, posted: shaped, nights: count, stays: inHouse.length };
  });
}

// The folio a charge is posted to: as given (one of the stay's own or its group's, not billed), else its routing.
async function folioChoice(db, business, stay, value, routes, kind) {
  if (value === undefined) return folioFor(routes, kind);
  if (value === null || value === '') return null;
  const folio = await repo.one(db, 'SELECT * FROM lodging_folios WHERE business_id=$1 AND id=$2', [business.id, id(value, 'Folio')]);
  if (!folio || (Number(folio.stay_id) !== Number(stay.id) && (!folio.group_id || Number(folio.group_id) !== Number(stay.group_id)))) fail('Folio not found', 404);
  if (folio.document_id) fail(`Folio ${folio.name} is billed already: post the charge to another folio`, 409);
  return folio.id;
}

// body: { requestKey, skuId, quantity?, price? (in the business's price terms; the item's price when left out), note?, folioId? (null: the main folio;
//   left out: as the stay's routing sends it) } — an extra (a service item) or goods kept in stock by quantity (a minibar's, toiletries) on the folio.
// Goods leave stock when their folio is billed; there must be enough at the property for those on the folios not yet billed.
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
    if (sku.internal_use) fail(`${sku.label} is kept for use in services only and is not billed`, 409);
    if (sku.is_kit) fail(`${sku.label} is a kit: sell it on a bill of its own`, 409);
    if (await repo.one(db, 'SELECT 1 FROM lodging_room_types WHERE business_id=$1 AND sku_id=$2', [business.id, sku.id])) fail(`${sku.label} is a room type's nights: the night audit posts them`, 409);
    const kind = sku.kind === 'service' ? 'extra' : 'goods';
    if (kind === 'goods' && ['batch', 'serial'].includes(sku.tracking)) fail(`${sku.label} is kept by batch or serial number: sell it on a bill of its own`, 409);
    const decimals = (quantityText.split('.')[1] || '').length;
    if (decimals > Number(sku.unit_decimals)) fail(`${sku.label} is counted in whole ${sku.unit === 'service' ? 'services' : `${sku.unit}s`}`);
    const settings = await repo.one(db, 'SELECT tax_mode FROM business_settings WHERE business_id=$1', [business.id]);
    const taxMode = settings?.tax_mode || 'exclusive';
    const price = c.given(body.price) ? money.paise(core.decimal(body.price, 'Price', 2, 0.01, 10000000)) : money.paise(sku.price);
    if (price <= 0) fail(`${sku.label} has no price in the catalogue: type the price charged`);
    if (kind === 'goods') {
      core.checkMrp(sku.label, price / 100, sku.tax_rate, taxMode, sku.mrp);
      if (sku.tracking !== 'none') {
        // Enough in stock at the property for these and the goods on folios not yet billed (they leave stock when billed).
        const stock = await repo.one(db, `SELECT COALESCE(sum(l.quantity),0) AS on_hand,
            (SELECT COALESCE(sum(ch.quantity),0) FROM lodging_charges ch JOIN lodging_stays x ON x.business_id=ch.business_id AND x.id=ch.stay_id
              WHERE ch.business_id=$1 AND ch.sku_id=$3 AND ch.kind='goods' AND ch.voided_at IS NULL AND ch.line_id IS NULL AND x.location_id=$2) AS on_folios
          FROM business_stock_lots l WHERE l.business_id=$1 AND l.location_id=$2 AND l.sku_id=$3 AND (l.expires_on IS NULL OR l.expires_on>=(now() AT TIME ZONE $4)::date)`,
        [business.id, stay.location_id, sku.id, business.timezone || 'Asia/Kolkata']);
        const free = money.milli(stock.on_hand) - money.milli(stock.on_folios);
        if (free < money.milli(quantityText)) {
          fail(`Only ${Math.max(0, free) / 1000} of ${sku.label} is in stock at this property${Number(stock.on_folios) ? ` beyond the ${Number(stock.on_folios)} on folios not yet billed` : ''}`, 409);
        }
      }
    }
    const figures = money.extraFigures({ price, quantity: quantityText, taxRate: sku.tax_rate, taxMode });
    if (figures.amount <= 0) fail('The charge comes to nothing');
    const today = await c.today(db, business);
    const folioId = await folioChoice(db, business, stay, body.folioId, await routesOf(db, business, stay.id), kind);
    const label = [sku.label, note].filter(Boolean).join(' · ').slice(0, 150);
    await db.query(`INSERT INTO lodging_charges(business_id,stay_id,kind,night,sku_id,label,quantity,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,note,request_key,created_by,folio_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [business.id, stay.id, kind, today, sku.id, label, quantityText, (price / 100).toFixed(4), money.rupees(figures.amount),
      taxMode, sku.tax_rate_id, Number(sku.tax_rate).toFixed(2), money.rupees(figures.net), money.rupees(figures.tax), note, requestKey, user.id, folioId]);
    await stays.history(db, business, user, stay, null, null, `Charged: ${label} ${money.rupees(figures.net + (taxMode === 'inclusive' ? 0 : figures.tax))}`);
    const details = { stayNo: stay.stay_no, item: sku.label, kind, quantity: quantityText, amount: money.rupees(figures.amount), taxRate: Number(sku.tax_rate).toFixed(2), folioId };
    await repo.audit(db, business.id, user.id, 'lodging_charge.posted', stay.id, details);
    await repo.event(db, business.id, user.id, 'lodging_charge.posted', 'lodging_stay', stay.id, { ...details, skuId: sku.id });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// body: { reason } — a charge posted by mistake, voided before it is billed (lodging.approve). A room night (or a day use) is posted
// again at the stay's rates now (every night of a stay is billed); any other charge is left off the bill.
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
      again = await postNight(db, business, user, stay, c.dayOf(charge.night), settings, await namesOf(db, business, stay), { room: charge.folio_id, meals: charge.folio_id });
    } else if (charge.kind === 'day_use') {
      again = await postDayUse(db, business, user, stay, await namesOf(db, business, stay), { room: charge.folio_id }, c.derivedKey(charge.request_key, `void:${charge.id}`));
    }
    await stays.history(db, business, user, stay, null, null, `Voided: ${charge.label} ${charge.amount} — ${reason}${again ? ` · posted again at ${again.amount} with GST ${Number(again.tax_rate)}%` : ''}`);
    const details = { stayNo: stay.stay_no, label: charge.label, amount: charge.amount, reason, ...(again ? { postedAgain: again.amount, taxRate: again.tax_rate } : {}) };
    await repo.audit(db, business.id, user.id, 'lodging_charge.voided', stay.id, details);
    await repo.event(db, business.id, user.id, 'lodging_charge.voided', 'lodging_stay', stay.id, { ...details, chargeId: charge.id });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// --- Check-out ------------------------------------------------------------------------------------------------

// The stay's folios (its own and its group's) by id.
async function foliosOf(db, business, stay) {
  return repo.all(db, `SELECT f.*,k.name AS contact_name FROM lodging_folios f JOIN business_contacts k ON k.business_id=f.business_id AND k.id=f.contact_id
    WHERE f.business_id=$1 AND (f.stay_id=$2 OR (f.group_id IS NOT NULL AND f.group_id=$3)) ORDER BY f.id`, [business.id, stay.id, stay.group_id || null]);
}
// A charge as a bill's value.
const valueOf = (x) => ({ skuId: x.sku_id, quantity: Number(x.quantity), net: money.paise(x.net), tax: money.paise(x.tax), taxRate: Number(x.tax_rate), label: x.label });
// The bills of these charges: one a folio (the main one first, billed to the company billed or the guest), leaving out a group's folio
// (billed with the group). Returns [{ folioId, folio, contactId, charges }].
function billsOf(stay, charges, folios) {
  const out = [];
  for (const x of charges) {
    const folioId = x.folio_id ? Number(x.folio_id) : null;
    const folio = folioId ? folios.find((f) => Number(f.id) === folioId) : null;
    if (folio?.group_id) continue;
    let bill = out.find((b) => b.folioId === folioId);
    if (!bill) {
      bill = { folioId, folio, contactId: folio ? Number(folio.contact_id) : Number(stay.bill_to_contact_id || stay.contact_id), charges: [] };
      out.push(bill);
    }
    bill.charges.push(x);
  }
  return out.sort((a, b) => (a.folioId || 0) - (b.folioId || 0));
}

// The check-out worked out, nothing written: the nights to post now (with their meals) and those posted ahead and not stayed, the
// day it ends, the late check-out charge, each folio's bill (every charge not billed), its figures, and what the advances and deposits pay.
async function planCheckout(db, business, stay) {
  const today = await c.today(db, business);
  const arrival = c.dayOf(stay.arrival), departure = c.dayOf(stay.departure);
  if (today > departure) fail(`Stay ${stay.stay_no} was to leave on ${c.dateWords(departure)}: extend it to today first`, 409);
  const ends = stay.day_use ? departure : [today, c.addDays(arrival, 1)].sort().at(-1);
  const settings = c.slabsOf(await c.settingsOf(db, business.id));
  const names = await namesOf(db, business, stay);
  const routes = await routesOf(db, business, stay.id);
  const folios = await foliosOf(db, business, stay);
  const charges = await repo.all(db, `SELECT ch.*,ch.night::text AS night FROM lodging_charges ch WHERE ch.business_id=$1 AND ch.stay_id=$2 AND ch.voided_at IS NULL AND ch.line_id IS NULL ORDER BY ${ORDER}`,
    [business.id, stay.id]);
  const ahead = stay.day_use ? [] : charges.filter((x) => ['room_night', 'meal'].includes(x.kind) && x.night >= ends);
  const kept = charges.filter((x) => !ahead.includes(x));
  const missing = stay.day_use ? [] : await missingNights(db, business, stay, c.addDays(ends, -1));
  const mealSku = (await repo.one(db, 'SELECT meal_sku_id FROM lodging_stay_nights WHERE business_id=$1 AND stay_id=$2 AND meal_sku_id IS NOT NULL LIMIT 1', [business.id, stay.id]))?.meal_sku_id;
  const mealRate = mealSku ? Number((await repo.one(db, 'SELECT tax_rate FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, mealSku])).tax_rate) : null;
  const toPost = [];
  for (const night of missing) {
    const priced = await pricedNight(db, business, stay, night, settings);
    const meal = priced.meal && !kept.some((x) => x.kind === 'meal' && x.night === night) ? priced.meal : 0;
    toPost.push({ ...priced, night, meal, mealTax: meal && mealRate !== null ? money.taxOn(meal, mealRate) : 0, mealRate });
  }
  // After the check-out time on the departure day: the policy's late check-out charge.
  const terms = stay.day_use ? null : await stays.policyNow(db, business, stay);
  const late = terms?.late.now && terms.late.amount > 0 && ends === departure && !kept.some((x) => x.kind === 'late_check_out') ? terms.late : null;
  // What each folio is billed: the charges kept, the nights to post with their meals, and the late check-out charge.
  const pending = [...kept,
    ...toPost.map((n) => ({ kind: 'room_night', night: n.night, folio_id: folioFor(routes, 'room_night'), sku_id: names.skuId, quantity: 1, net: money.rupees(n.net), tax: money.rupees(n.tax),
      tax_rate: n.slab.rate, label: nightLabel(stay, names.roomNo, names.typeName, n.night) })),
    ...toPost.filter((n) => n.meal).map((n) => ({ kind: 'meal', night: n.night, folio_id: folioFor(routes, 'meal'), sku_id: n.mealSkuId, quantity: 1, net: money.rupees(n.meal),
      tax: money.rupees(n.mealTax), tax_rate: n.mealRate, label: `${names.planName || 'Plan'} meals · night of ${c.dateWords(n.night)}` })),
    ...(late ? [{ kind: 'late_check_out', night: late.night, folio_id: folioFor(routes, 'late_check_out'), sku_id: names.skuId, quantity: 1, net: money.rupees(late.amount),
      tax: money.rupees(late.tax), tax_rate: late.slab.rate, label: `Late check-out · ${names.typeName} · room ${names.roomNo}` }] : [])];
  const settingsRow = await repo.one(db, 'SELECT rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const bills = billsOf(stay, pending, folios).map((b) => ({ ...b, values: b.charges.map(valueOf), figures: money.billFigures(b.charges.map(valueOf), settingsRow?.rounding) }));
  const total = bills.reduce((s, b) => s + b.figures.total, 0);
  // The advances and deposits pay the bills of the guest who paid them (a receipt settles only its own customer's bills).
  const own = bills.filter((b) => b.contactId === Number(stay.contact_id)).reduce((s, b) => s + b.figures.total, 0);
  const receipts = (await stays.receiptsOf(db, business, stay.id)).filter((r) => Number(r.contact_id) === Number(stay.contact_id));
  const free = (purpose) => receipts.filter((r) => r.purpose === purpose).reduce((s, r) => s + Math.max(0, money.paise(r.free)), 0);
  const advance = Math.min(free('advance'), own);
  const deposit = Math.min(free('deposit'), own - advance);
  const onGroup = pending.filter((x) => folios.find((f) => Number(f.id) === Number(x.folio_id))?.group_id);
  return { today, ends, early: ends < departure, settings, names, routes, folios, ahead, toPost, late, bills, onGroup, total, advance, deposit, due: total - advance - deposit,
    depositBack: free('deposit') - deposit, advanceBack: free('advance') - advance };
}

const planText = (plan, stay, business) => ({
  stayNo: stay.stay_no, today: plan.today, departure: plan.ends, early: plan.early, nightsToPost: plan.toPost.map((n) => n.night), nightsNotStayed: plan.ahead.filter((x) => x.kind === 'room_night').map((x) => x.night),
  billTo: stay.bill_to_contact_id ? 'company' : 'guest', lateCheckOut: plan.late ? { now: true } : null,
  ...(c.seesMoney(business) ? {
    ...money.figuresText({ subtotal: plan.bills.reduce((s, b) => s + b.figures.subtotal, 0), tax: plan.bills.reduce((s, b) => s + b.figures.tax, 0),
      roundOff: plan.bills.reduce((s, b) => s + b.figures.roundOff, 0), total: plan.total }),
    advance: money.rupees(plan.advance), deposit: money.rupees(plan.deposit), due: money.rupees(plan.due), depositBack: money.rupees(plan.depositBack), advanceBack: money.rupees(plan.advanceBack),
    lateCheckOut: plan.late ? { now: true, amount: money.rupees(plan.late.amount), tax: money.rupees(plan.late.tax), taxRate: plan.late.taxRate.toFixed(2) } : null,
    bill: plan.bills.flatMap((b) => b.values).map((x) => ({ label: x.label, quantity: x.quantity, net: money.rupees(x.net), tax: money.rupees(x.tax), taxRate: Number(x.taxRate).toFixed(2) })),
    folios: plan.bills.map((b) => ({ folioId: b.folioId, name: b.folio?.name || 'Main', contactId: b.contactId, ...money.figuresText(b.figures),
      lines: b.values.map((x) => ({ label: x.label, quantity: x.quantity, net: money.rupees(x.net), tax: money.rupees(x.tax), taxRate: Number(x.taxRate).toFixed(2) })) })),
    onGroupFolio: money.rupees(plan.onGroup.reduce((s, x) => s + money.paise(x.net) + money.paise(x.tax), 0)),
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

// The payments taken now for a folio's bill: the main folio's from `payment` / `payments`, another's from `folioPayments[folioId]`.
function readFolioPayments(body) {
  const out = {};
  const given = body.folioPayments;
  if (given === undefined || given === null) return out;
  if (typeof given !== 'object' || Array.isArray(given)) fail('Payments for the folios are given by folio');
  for (const [key, value] of Object.entries(given)) out[Number(key)] = core.readPayments(Array.isArray(value) ? { payments: value } : { payment: value });
  return out;
}

// The check-out inside the caller's transaction (the stay locked). Returns nothing; the caller loads the stay.
async function checkOutIn(db, business, user, stay, body, { requestKey, hash, parts, folioParts, how, approval, waiver }) {
  if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: a guest in the house checks out`, 409);
  // Who is billed: as the stay has it, or changed now.
  if (body.billToContactId !== undefined) {
    const billTo = await stays.billToOf(db, business, body.billToContactId, stay.contact_id);
    if (Number(billTo?.id || 0) !== Number(stay.bill_to_contact_id || 0)) {
      await db.query('UPDATE lodging_stays SET bill_to_contact_id=$3,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, stay.id, billTo?.id || null, user.id]);
      stay.bill_to_contact_id = billTo?.id || null;
    }
  }
  const plan = await planCheckout(db, business, stay);
  // Nights (and their meals) posted ahead and not stayed (the guest leaves early) are voided; the nights to last night are posted.
  for (const x of plan.ahead) {
    await db.query('UPDATE lodging_charges SET voided_at=now(),voided_by=$3,void_reason=$4 WHERE business_id=$1 AND id=$2',
      [business.id, x.id, user.id, `Checked out on ${c.dateWords(plan.today)}: the night of ${c.dateWords(x.night)} was not stayed`]);
  }
  for (const n of plan.toPost) {
    const row = await postNight(db, business, user, stay, n.night, plan.settings, plan.names, plan.routes);
    if (!row) fail('A room night was posted by another screen just now. Try again.', 409);
  }
  // The late check-out charge, or its waiver.
  if (waiver && !plan.late) fail(`Stay ${stay.stay_no} has no late check-out charge to waive`, 409);
  if (plan.late && waiver) await stays.recordWaiver(db, business, user, stay, { charge: 'late_check_out', amount: plan.late.amount, waiver });
  else if (plan.late) {
    await postPolicyCharge(db, business, user, stay, { kind: 'late_check_out', amount: plan.late.amount, slab: plan.late.slab, night: plan.late.night, names: plan.names, routes: plan.routes,
      key: c.derivedKey(requestKey, 'late') });
  }
  // Each folio's own bill (a group's folio is billed with the group), the main one first.
  const charges = await repo.all(db, `SELECT ch.*,ch.night::text AS night FROM lodging_charges ch WHERE ch.business_id=$1 AND ch.stay_id=$2 AND ch.voided_at IS NULL AND ch.line_id IS NULL ORDER BY ${ORDER}`,
    [business.id, stay.id]);
  const folios = await foliosOf(db, business, stay);
  const posted = [];
  for (const b of billsOf(stay, charges, folios)) {
    const bill = await stays.postBill(db, business, user, stay, { values: b.charges.map(valueOf), contactId: b.contactId, parts: b.folioId ? folioParts[b.folioId] || [] : parts,
      buyer: body.buyer, key: b.folioId ? c.derivedKey(requestKey, `folio:${b.folioId}`) : requestKey, hash,
      notes: `Stay ${stay.stay_no} · room ${plan.names.roomNo} · ${stay.day_use ? `day use on ${c.dateWords(stay.arrival)}` : c.nightsWords(c.dayOf(stay.arrival), plan.ends)} · guest ${stay.guest_name}${b.folio ? ` · folio ${b.folio.name}` : ''}` });
    // What is still due once the advances and deposits paid: a company's stays on its dues; the guest's own needs a manager.
    const owed = await repo.one(db, `SELECT ${c.DUE_SQL('d')} AS due FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, bill.document.id]);
    if (money.paise(owed.due) > 0 && b.contactId === Number(stay.contact_id) && !access.can(business, 'lodging.approve')) {
      fail(`${money.rupees(money.paise(owed.due))} is left to pay on the bill${b.folio ? ` of folio ${b.folio.name}` : ''}: take the payment, or have a manager check the guest out with it left on their dues`, 409,
        { reason: 'bill_due', due: money.rupees(money.paise(owed.due)) });
    }
    for (const [index, x] of b.charges.entries()) await db.query('UPDATE lodging_charges SET line_id=$3 WHERE business_id=$1 AND id=$2', [business.id, x.id, bill.lineIds[index]]);
    if (b.folioId) await db.query('UPDATE lodging_folios SET document_id=$3,billed_at=now() WHERE business_id=$1 AND id=$2', [business.id, b.folioId, bill.document.id]);
    posted.push({ ...bill, folio: b.folio });
  }
  const main = posted.find((p) => !p.folio) || posted[0] || null;
  await db.query(`UPDATE lodging_stays SET status='checked_out',departure=$3,checked_out_at=now(),checked_out_by=$4,checkout_key=$5,checkout_hash=$6,document_id=$7,updated_by=$4,updated_at=now()
    WHERE business_id=$1 AND id=$2`, [business.id, stay.id, plan.ends, user.id, requestKey, hash, main?.document.id || null]);
  await db.query('UPDATE lodging_stay_guests SET departed_at=now(),updated_by=$3,updated_at=now() WHERE business_id=$1 AND stay_id=$2 AND departed_at IS NULL', [business.id, stay.id, user.id]);
  await db.query("UPDATE lodging_rooms SET status='vacant_dirty',status_note=$3,status_by=$4,status_at=now() WHERE business_id=$1 AND id=$2",
    [business.id, stay.room_id, `Checked out: ${stay.stay_no}`, user.id]);
  const back = how ? await stays.refundLeft(db, business, user, stay, { how, approval, key: requestKey }) : [];
  const refunded = back.reduce((s, r) => s + money.paise(r.amount), 0);
  const used = posted.reduce((s, p) => ({ advance: s.advance + p.used.advance, deposit: s.deposit + p.used.deposit }), { advance: 0, deposit: 0 });
  const foreigners = (await repo.one(db, 'SELECT count(*)::int AS n FROM lodging_stay_guests WHERE business_id=$1 AND stay_id=$2 AND foreigner', [business.id, stay.id])).n;
  await stays.history(db, business, user, stay, 'in_house', 'checked_out', [`Checked out of room ${plan.names.roomNo}`,
    posted.length ? `billed (${posted.map((p) => `${p.document.document_no}${p.folio ? ` for ${p.folio.name}` : ''}`).join(', ')})` : 'nothing billed on its own: its charges are on the group\'s folio',
    plan.ahead.length ? `${c.plural(plan.ahead.filter((x) => x.kind === 'room_night').length, 'night')} not stayed voided` : null, used.advance ? 'the advance applied to the bill' : null,
    used.deposit ? 'the deposit applied to the bill' : null, refunded ? `${money.rupees(refunded)} handed back (${back.map((r) => r.refund_no).join(', ')})` : null,
    foreigners ? 'Form-III departure due within 24 hours' : null].filter(Boolean).join(' · '));
  const details = { stayNo: stay.stay_no, roomNo: plan.names.roomNo, documentNo: main?.document.document_no || null, billTotal: main?.document.total || null,
    bills: posted.map((p) => ({ documentNo: p.document.document_no, total: p.document.total, folio: p.folio?.name || null })), billedTo: stay.bill_to_contact_id ? 'company' : 'guest',
    nights: money.nightCount(c.dayOf(stay.arrival), plan.ends), advanceUsed: money.rupees(used.advance), depositUsed: money.rupees(used.deposit), handedBack: money.rupees(refunded),
    ...(approval && refunded ? { approvedBy: approval.approver.name } : {}) };
  await repo.audit(db, business.id, user.id, 'lodging_stay.checked_out', stay.id, details);
  await repo.event(db, business.id, user.id, 'lodging_stay.checked_out', 'lodging_stay', stay.id, { ...details, documentId: main?.document.id || null, roomId: stay.room_id });
}

// What a check-out asks besides the stay: the payments, money handed back with its approval, a waiver. Read before the transaction.
async function readCheckout(business, user, body) {
  const parts = core.readPayments(body);
  const folioParts = readFolioPayments(body);
  if (parts.length || Object.values(folioParts).some((p) => p.length)) await access.require(business, 'sales.edit');
  const how = body.refund ? stays.readBack(body.refund) : null;
  if (how) await access.require(business, 'lodging.refund');
  // A manager's PIN for money handed back, checked before the transaction (a PIN check holds no locks).
  const approval = how ? await require('../../salon-weight/services/businessManagerPin').readApproval(business, user, { ...(body.approval || {}),
    reason: c.given(body.approval?.reason) ? body.approval.reason : 'Advance and deposit left handed back at check-out' }, 'lodging.refund', { reasonLabel: 'Reason' }) : null;
  const waiver = await stays.readWaiver(business, user, body.waiver);
  return { parts, folioParts, how, approval, waiver };
}

// body: { requestKey, billToContactId? (null: the guest; left out: as the stay has it), payment? | payments? (the rest of the main folio's bill),
//   folioPayments?: { [folioId]: payment | [payments] } (another folio's), refund?: { method | methodId, reference? } (what is left of the advances and
//   deposits, handed back), approval?: { approverId?, pin?, reason? }, waiver?: { reason, approverId?, pin? } (the late check-out charge),
//   buyer?: { pan?, panDeclaration? } }
async function checkOut(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, approval: undefined, waiver: stays.waiverKey(body.waiver), stayId: String(stayId) });
  const asked = await readCheckout(business, user, body);
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    if (stay.checkout_key) {
      if (stay.checkout_key !== requestKey || stay.checkout_hash !== hash) fail(`Stay ${stay.stay_no} is checked out already`, 409);
      return stays.shape(business, await stays.load(db, business, stay.id));
    }
    await checkOutIn(db, business, user, stay, body, { requestKey, hash, ...asked });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

module.exports = { readGuest, readGuests, GUEST_COLUMNS, guestValues, readRegister, checkIn, checkInIn, postNight, postDayUse, namesOf, missingNights, repostNights, nightAudit,
  addCharge, voidCharge, routesOf, foliosOf, valueOf, planCheckout, checkoutPreview, checkOut, checkOutIn, readCheckout };
