const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const numbering = require('../../core/services/businessNumbering');
const paymentMethods = require('../../core/services/businessPaymentMethods.service');
const c = require('./lodgingCommon');
const money = require('./lodgingMoney');
const rateCards = require('./lodgingRates.service');
// Handing money back and a manager's PIN (shared with the salon, repairs, opticians, garages, laundries and rentals).
const refunds = () => require('../../salon-weight/services/businessAdvanceRefunds');
const pins = () => require('../../salon-weight/services/businessManagerPin');
// The folio's postings (a discount changed in the house posts the nights again); required when used, as it requires this file.
const folio = () => require('./lodgingFolio.service');

// Reservations and stays (module "lodging", hotels, lodges and guest houses).
//
//   reserve   a guest (one of the customers, or a new one typed at the desk),
//             a company billed instead (a customer with its GSTIN), where the
//             booking came from (a walk-in, the phone, or an OTA with its
//             booking id), the nights (arrival and departure dates on the
//             business's clock), the room type and, if chosen, the room;
//             adults, children and extra beds; the room type's rates as they
//             are, or one rate agreed for every night. Each night is priced at
//             its own rate with its own GST slab (decided by the night's value).
//             The room is never booked twice over a night, and the room type
//             never over its rooms: checked here, and by the database. An
//             advance may be taken (a collection receipt, money on account).
//   change    a reservation: its nights, type, room, guests, beds, rate, who is
//             billed and its notes, priced again; a stay in the house: its
//             departure, a move to another room, extra beds, who is billed, and
//             (with lodging.approve) the rate; priced again for the nights to come.
//   money     advances and refundable deposits taken for a stay, each a
//             collection receipt in the guest's name, held for the stay's bill.
//   cancel    a reservation cancelled, or marked a no-show once its arrival day
//             has come, with a reason; a cancellation charge is billed with GST
//             as the room type's nights (at the slab of the first night), paid
//             first from what is held; the rest goes back with a manager's PIN.
// The check-in, the folio and the check-out have a file of their own. Money
// is integer paise; someone who does not see sales sees stays without money.

const { fail, id } = c;
const MONEY_FIELDS = ['estimate_subtotal', 'estimate_tax', 'estimate_total', 'rack_rate', 'weekend_rate', 'extra_adult_rate', 'child_rate', 'extra_bed_rate', 'agreed_rate',
  'advance', 'held', 'deposit_held', 'bill_due'];
const CHARGE_MONEY = ['room_rate', 'extra_adult_rate', 'child_rate', 'extra_bed_rate', 'unit_price', 'amount', 'net', 'tax', 'discount'];

// --- Lists ---------------------------------------------------------------------------------------------

// Every stay with its room and where it stands: its stage (from its status,
// its dates on the business's clock and its money), what is held for it
// (advances and deposits) and what is still due on its bill.
const STAYS_SQL = `SELECT y.*,
    CASE WHEN y.status='reserved' AND y.arrival<y.today THEN 'late_arrival' WHEN y.status='reserved' AND y.arrival=y.today THEN 'arriving'
      WHEN y.status='reserved' THEN 'reserved' WHEN y.status='in_house' AND y.departure<y.today THEN 'overstay'
      WHEN y.status='in_house' AND y.departure=y.today THEN 'due_out' WHEN y.status='in_house' THEN 'in_house'
      WHEN y.bill_due>0 OR y.held>0 THEN 'to_settle' ELSE y.status END AS stage,
    (y.status='reserved' AND y.arrival<=y.today) AS arriving_today,
    (y.status='reserved' AND y.arrival<y.today) AS late_arrival,
    (y.status='in_house') AS in_house,
    (y.status='in_house' AND y.departure<=y.today) AS due_out,
    (y.status IN ('reserved','in_house') OR y.bill_due>0 OR y.held>0) AS open
  FROM (
  SELECT s.id,s.stay_no,s.location_id,l.name AS location_name,s.contact_id,s.guest_name,s.guest_phone,s.bill_to_contact_id,bt.name AS bill_to_name,bt.gstin AS bill_to_gstin,
    s.source,s.ota_name,s.ota_booking_id,s.status,s.arrival,s.departure,(s.departure-s.arrival) AS nights,s.room_type_id,ts.label AS room_type,s.room_id,r.room_no,
    s.adults,s.children,s.extra_beds,s.estimate_total,s.document_id,d.document_no,s.checked_in_at,s.checked_out_at,s.cancelled_at,s.notes,s.created_at,s.updated_at,
    (s.arrival::timestamp AT TIME ZONE z.timezone) AS arrival_at,(now() AT TIME ZONE z.timezone)::date AS today,
    COALESCE(m.advance,0) AS advance,COALESCE(m.held,0) AS held,COALESCE(m.deposit_held,0) AS deposit_held,
    (CASE WHEN d.id IS NULL THEN 0 ELSE GREATEST(0,${c.DUE_SQL('d')}) END + COALESCE((SELECT sum(GREATEST(0,${c.DUE_SQL('fd')})) FROM lodging_folios f
      JOIN business_documents fd ON fd.business_id=f.business_id AND fd.id=f.document_id WHERE f.business_id=s.business_id AND f.stay_id=s.id),0)) AS bill_due,
    s.day_use,s.day_from,s.day_until,s.group_id,s.rate_plan_id,s.discount_percent,
    (SELECT count(*)::int FROM lodging_stay_guests g WHERE g.business_id=s.business_id AND g.stay_id=s.id AND g.foreigner) AS foreigners
  FROM lodging_stays s JOIN businesses z ON z.id=s.business_id
  JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id
  JOIN lodging_room_types t ON t.business_id=s.business_id AND t.id=s.room_type_id JOIN catalog_skus ts ON ts.business_id=t.business_id AND ts.id=t.sku_id
  LEFT JOIN lodging_rooms r ON r.business_id=s.business_id AND r.id=s.room_id
  LEFT JOIN business_contacts bt ON bt.business_id=s.business_id AND bt.id=s.bill_to_contact_id
  LEFT JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.document_id
  LEFT JOIN LATERAL (SELECT sum(k.amount) FILTER (WHERE x.purpose='advance') AS advance,sum(${c.FREE_SQL('k')}) AS held,
      sum(${c.FREE_SQL('k')}) FILTER (WHERE x.purpose='deposit') AS deposit_held
    FROM lodging_receipts x JOIN business_collections k ON k.business_id=x.business_id AND k.id=x.collection_id WHERE x.business_id=s.business_id AND x.stay_id=s.id) m ON TRUE
  WHERE s.business_id=$1) y`;

repo.addLists({
  // Every stay by its arrival (newest first, with dates).
  'lodging-stays': { sql: STAYS_SQL, search: ['stay_no', 'guest_name', 'guest_phone', 'room_no', 'room_type', 'bill_to_name', 'ota_booking_id', 'document_no', 'notes'],
    date: 'arrival_at', filters: { stage: 'stage', status: 'status', location: 'location_id', contact: 'contact_id', room_type: 'room_type_id', open: 'open', in_house: 'in_house' },
    order: 'arrival DESC,id DESC' },
});

// What someone who does not see sales sees of a stay: no money.
function withoutMoney(row) {
  const out = { ...row };
  for (const key of MONEY_FIELDS) if (key in out) out[key] = null;
  if (Array.isArray(out.charges)) out.charges = out.charges.map((x) => Object.fromEntries(Object.entries(x).map(([k, value]) => [k, CHARGE_MONEY.includes(k) ? null : value])));
  if (Array.isArray(out.nights)) out.nights = out.nights.map((n) => ({ ...n, amount: null, tax: null, tax_rate: null, value: null, discount: null, room_rate: null, meals: null, meals_tax: null }));
  for (const key of ['receipts']) if (Array.isArray(out[key])) out[key] = [];
  out.bill = null; out.folio = null; out.money = false; out.policy_charges = null;
  if (Array.isArray(out.folios)) out.folios = out.folios.map((f) => ({ ...f, total: null, due: null }));
  return out;
}
// What someone who neither checks guests in nor prints the register sees of the occupants: their names, not their IDs.
const ID_FIELDS = ['id_ref', 'visa_type', 'visa_no', 'arrived_india_on', 'phone', 'address', 'age'];
const withoutIds = (guest) => ({ ...guest, ...Object.fromEntries(ID_FIELDS.map((k) => [k, null])), ids: false });
function shape(business, stay) {
  const guests = c.seesIds(business) ? stay.guests : (stay.guests || []).map(withoutIds);
  const out = { ...stay, guests, ids: c.seesIds(business) };
  return c.seesMoney(business) ? { ...out, money: true } : withoutMoney(out);
}
const listShape = (business, page) => (c.seesMoney(business) ? page : { ...page, items: page.items.map(withoutMoney) });

// --- Reading a request ---------------------------------------------------------------------------------

// The nights as typed: an arrival and a departure date, a night at least, 180 at most.
function readNights(arrivalValue, departureValue) {
  const arrival = c.readDate(arrivalValue, 'Arrival');
  const departure = c.readDate(departureValue, 'Departure');
  if (departure <= arrival) fail('The departure is after the arrival: a stay is one night at least');
  if (money.nightCount(arrival, departure) > c.MAX_NIGHTS) fail(`A stay runs at most ${c.MAX_NIGHTS} nights`);
  return { arrival, departure };
}
// Adults, children and extra beds as typed (`current` keeps what is left out).
function readParty(body, current = null) {
  return {
    adults: body.adults === undefined && current ? Number(current.adults) : c.whole(body.adults ?? 1, 'Adults', 1, 30),
    children: body.children === undefined ? (current ? Number(current.children) : 0) : c.whole(body.children === '' || body.children === null ? 0 : body.children, 'Children', 0, 30),
    extraBeds: body.extraBeds === undefined ? (current ? Number(current.extra_beds) : 0) : c.whole(body.extraBeds === '' || body.extraBeds === null ? 0 : body.extraBeds, 'Extra beds', 0, 5),
  };
}
// Where the booking came from: a walk-in, the phone, or an OTA with its name and booking id.
function readSource(body, current = null) {
  const source = body.source === undefined && current ? current.source : v.requiredEnum(body.source ?? 'walk_in', 'Booked by', c.SOURCES);
  if (source !== 'ota') return { source, otaName: null, otaBookingId: null };
  const otaName = body.otaName === undefined && current ? current.ota_name : c.optionalText(body.otaName, 'OTA', 60);
  const otaBookingId = body.otaBookingId === undefined && current ? current.ota_booking_id : c.optionalText(body.otaBookingId, 'OTA booking id', 60);
  if (!otaName || !otaBookingId) fail('An OTA booking is kept with the OTA\'s name and its booking id');
  return { source, otaName, otaBookingId };
}

// A room type of this business, in use, with its rates.
async function roomTypeOf(db, business, typeId) {
  const type = await repo.one(db, `SELECT t.*,s.label AS name FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
    WHERE t.business_id=$1 AND t.id=$2`, [business.id, id(typeId, 'Room type')]);
  if (!type) fail('Room type not found', 404);
  return type;
}
// The guests a room type takes and the beds it allows.
function checkParty(type, party, rates) {
  if (party.adults + party.children > Number(type.max_occupancy)) fail(`${type.name} takes at most ${type.max_occupancy} guests`);
  if (party.adults > Number(rates.base_occupancy) && (rates.extra_adult_rate === null || rates.extra_adult_rate === undefined)) {
    fail(`${type.name}'s rate is for ${rates.base_occupancy} ${Number(rates.base_occupancy) === 1 ? 'adult' : 'adults'}, and it takes no extra adult`);
  }
  if (party.extraBeds > Number(type.max_extra_beds)) fail(Number(type.max_extra_beds) ? `${type.name} takes at most ${type.max_extra_beds} extra ${Number(type.max_extra_beds) === 1 ? 'bed' : 'beds'}` : `${type.name} takes no extra bed`);
  if (party.extraBeds > 0 && (rates.extra_bed_rate === null || rates.extra_bed_rate === undefined)) fail(`${type.name} has no rate for an extra bed`);
}
// The room type's rates as a stay keeps them.
const typeRates = (type) => ({ base_occupancy: type.base_occupancy, rack_rate: type.rack_rate, weekend_rate: type.weekend_rate, extra_adult_rate: type.extra_adult_rate,
  child_rate: type.child_rate, extra_bed_rate: type.extra_bed_rate });

// A room of this business for a stay: in use, of its type, at its location.
async function roomFor(db, business, roomId, type, locationId) {
  const room = await repo.one(db, 'SELECT * FROM lodging_rooms WHERE business_id=$1 AND id=$2', [business.id, id(roomId, 'Room')]);
  if (!room) fail('Room not found', 404);
  if (!room.active) fail(`Room ${room.room_no} is out of use`, 409);
  if (Number(room.location_id) !== Number(locationId)) fail(`Room ${room.room_no} is at another location`, 409);
  if (Number(room.room_type_id) !== Number(type.id)) fail(`Room ${room.room_no} is not a ${type.name} room: choose the room type it is, or another room`, 409);
  return room;
}

// The first stay holding a room over some of these nights (leaving a stay out), with its words.
async function roomClash(db, business, roomId, arrival, departure, exceptStay = null) {
  return repo.one(db, `SELECT s.id,s.stay_no,s.guest_name,s.status,s.arrival,s.departure,r.room_no FROM lodging_stays s JOIN lodging_rooms r ON r.business_id=s.business_id AND r.id=s.room_id
    WHERE s.business_id=$1 AND s.room_id=$2 AND s.status IN ('reserved','in_house') AND NOT s.day_use AND s.arrival<$4::date AND s.departure>$3::date AND ($5::bigint IS NULL OR s.id<>$5)
    ORDER BY s.arrival,s.id LIMIT 1`, [business.id, roomId, arrival, departure, exceptStay]);
}
const clashWords = (clash) => `Room ${clash.room_no} is ${clash.status === 'in_house' ? 'occupied' : 'booked'} by ${clash.stay_no} (${clash.guest_name}) for ${c.nightsWords(clash.arrival, clash.departure)}`;

// The first night a room type has no room left for one more stay (leaving a stay out): { night, held, rooms } or null.
async function typeFull(db, business, typeId, locationId, arrival, departure, exceptStay = null) {
  const rooms = (await repo.one(db, 'SELECT count(*)::int AS n FROM lodging_rooms WHERE business_id=$1 AND location_id=$2 AND room_type_id=$3 AND active',
    [business.id, locationId, typeId])).n;
  const busiest = await repo.one(db, `SELECT n::date::text AS night,count(x.id)::int AS held
    FROM generate_series($4::date::timestamp,($5::date-1)::timestamp,interval '1 day') n
    LEFT JOIN lodging_stays x ON x.business_id=$1 AND x.location_id=$2 AND x.room_type_id=$3 AND x.status IN ('reserved','in_house') AND NOT x.day_use AND x.arrival<=n::date AND x.departure>n::date
      AND ($6::bigint IS NULL OR x.id<>$6)
    GROUP BY n HAVING count(x.id)+1>$7 ORDER BY n LIMIT 1`, [business.id, locationId, typeId, arrival, departure, exceptStay, rooms]);
  return busiest ? { ...busiest, rooms } : null;
}
const fullWords = (type, full) => (full.rooms === 0 ? `There are no ${type.name} rooms at this location yet: add them under Settings › Room types & rates`
  : `Every ${type.name} room is taken on the night of ${c.dayWords(full.night)} (${full.held} ${full.held === 1 ? 'stay' : 'stays'} for ${full.rooms} ${full.rooms === 1 ? 'room' : 'rooms'}): choose other dates or another room type`);

// --- Pricing ---------------------------------------------------------------------------------------------

// Each night (or a day use) priced from its rates, with its meals: { nights, subtotal, tax, total, roomSubtotal } (paise).
// `rows`: the nights' rates (lodgingMoney.nightRow), `party`: { adults, children, extraBeds, baseOccupancy }, `percent`: the stay's discount.
async function priceNights(db, business, rows, party, percent = null) {
  const settings = c.slabsOf(await c.settingsOf(db, business.id));
  const mealSku = rows.find((r) => r.mealSkuId)?.mealSkuId;
  const mealRate = mealSku ? Number((await repo.one(db, 'SELECT tax_rate FROM catalog_skus WHERE business_id=$1 AND id=$2', [business.id, mealSku])).tax_rate) : null;
  return { ...money.estimateRows(rows, party, settings, percent, mealRate), mealRate };
}
const nightText = (n) => ({ night: n.night, weekend: n.weekend, rateKind: n.rateKind, roomRate: money.rupees(n.roomRate), extraAdults: n.extraAdults, children: n.children,
  extraBeds: n.extraBeds, value: money.rupees(n.value), discount: money.rupees(n.discount), amount: money.rupees(n.amount), taxRate: Number(n.slab.rate).toFixed(2), slab: n.slab.name,
  tax: money.rupees(n.tax), meals: money.rupees(n.meal), mealsTax: money.rupees(n.mealTax), total: money.rupees(n.amount + n.tax + n.meal + n.mealTax) });
const partyOf = (stay) => ({ adults: Number(stay.adults), children: Number(stay.children), extraBeds: Number(stay.extra_beds), baseOccupancy: Number(stay.base_occupancy) });

// The stay's nights with the rates they were priced at (paise), in order.
async function nightRows(db, business, stayId) {
  const rows = await repo.all(db, 'SELECT n.*,n.night::text AS night FROM lodging_stay_nights n WHERE n.business_id=$1 AND n.stay_id=$2 ORDER BY n.night', [business.id, stayId]);
  return rows.map(money.nightRow);
}
// The nights' rates kept with the stay: those from `arrival` to the night before `departure`; a night already posted keeps
// the rates it was posted at; `replace`: the others take these rates, else only the nights it had none for.
async function saveNights(db, business, stayId, rows, { arrival, departure, replace }) {
  await db.query(`DELETE FROM lodging_stay_nights n WHERE n.business_id=$1 AND n.stay_id=$2 AND (n.night<$3::date OR n.night>=$4::date OR $5::boolean)
    AND NOT EXISTS (SELECT 1 FROM lodging_charges ch WHERE ch.business_id=n.business_id AND ch.stay_id=n.stay_id AND ch.night=n.night AND ch.kind IN ('room_night','day_use')
      AND ch.voided_at IS NULL)`, [business.id, stayId, arrival, departure, replace]);
  for (const r of rows) {
    await db.query(`INSERT INTO lodging_stay_nights(business_id,stay_id,night,rate_kind,room_rate,extra_adult_rate,child_rate,extra_bed_rate,meal_sku_id,meal_adult_rate,meal_child_rate)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, [business.id, stayId, r.night, r.rateKind, money.rupees(r.roomRate), r.extraAdult === null ? null : money.rupees(r.extraAdult),
      r.child === null ? null : money.rupees(r.child), r.extraBed === null ? null : money.rupees(r.extraBed), r.mealSkuId, r.mealSkuId ? money.rupees(r.mealAdult || 0) : null,
      r.mealSkuId && r.mealChild !== null ? money.rupees(r.mealChild) : null]);
  }
}
// The extra persons' rates a party needs, every night: a night with no rate for an extra adult, child or bed refuses them.
function checkNightParty(type, party, rows) {
  const base = Number(type.base_occupancy);
  for (const r of rows) {
    if (party.adults > base && r.extraAdult === null) fail(`${type.name}'s rate on the night of ${c.dayWords(r.night)} is for ${c.plural(base, 'adult')}, and it takes no extra adult`);
    if (party.extraBeds > 0 && r.extraBed === null) fail(`${type.name} has no rate for an extra bed on the night of ${c.dayWords(r.night)}`);
  }
}

// A discount on a stay as typed: { percent, reason }, or none (null); `{}` or a nil percent takes it off; undefined: left as it is.
function readDiscount(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !c.given(value.percent) || Number(value.percent) === 0) return null;
  return { percent: core.decimal(value.percent, 'Discount (percent)', 2, 0.01, 100), reason: v.requiredString(typeof value.reason === 'string' ? value.reason : '', 'Reason for the discount', 300) };
}
// A discount given: by the discount permission, within the business's most bill discount (the owner, any).
async function checkDiscount(db, business, discount) {
  if (!discount) return;
  await access.require(business, 'sales.discount');
  const limit = await repo.one(db, 'SELECT max_bill_discount_percent FROM business_settings WHERE business_id=$1', [business.id]);
  const most = Number(limit?.max_bill_discount_percent ?? 10);
  if (!business.full_access && discount.percent > most) fail(`At most ${most}% of a bill can be taken off. The owner can change this in Business settings.`, 409);
}

// A day use as typed: { from (HH:MM), hours (1-12) }, or null for a stay of nights.
function readDayUse(value) {
  if (value === undefined || value === null || value === false) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('A day use is a start time and a block of hours');
  return { from: c.readTime(value.from, 'Day use from'), hours: c.whole(value.hours, 'Day use hours', 1, 12) };
}
// The block's start and end on the business's clock, checked to lie within its day and not to have passed.
async function dayUseHours(db, business, day, dayUse) {
  const row = await repo.one(db, `SELECT (($2::date + $3::time) AT TIME ZONE $1) AS day_from,(($2::date + $3::time) AT TIME ZONE $1) + make_interval(hours => $4::int) AS day_until,
      (($2::date + 1)::timestamp AT TIME ZONE $1) AS day_end,now() AS now`, [business.timezone || 'Asia/Kolkata', day, dayUse.from, dayUse.hours]);
  if (new Date(row.day_until) > new Date(row.day_end)) fail(`A day use is a block of hours within its day: ${c.plural(dayUse.hours, 'hour')} from ${dayUse.from} runs past midnight`);
  if (new Date(row.day_until) <= new Date(row.now)) fail('Those hours have passed: choose a later start');
  return row;
}
// The stay holding a room at the hours a day use would (or a day use holding it at a night stay's hours), with its words, or null.
async function hoursClash(db, business, roomId, held, exceptStay = null) {
  return repo.one(db, `SELECT s.id,s.stay_no,s.guest_name,s.status,s.arrival,s.departure,s.day_use,r.room_no FROM lodging_stays s JOIN lodging_rooms r ON r.business_id=s.business_id AND r.id=s.room_id
    JOIN businesses z ON z.id=s.business_id LEFT JOIN lodging_settings t ON t.business_id=s.business_id
    WHERE s.business_id=$1 AND s.room_id=$2 AND s.status IN ('reserved','in_house') AND ($5::bigint IS NULL OR s.id<>$5) AND (s.day_use OR $6::boolean)
      AND lodging_stay_held(s.day_use,s.day_from,s.day_until,s.arrival,s.departure,z.timezone,COALESCE(t.check_in_time,'12:00'),COALESCE(t.check_out_time,'11:00'))
        && tstzrange($3::timestamptz,$4::timestamptz) LIMIT 1`,
  [business.id, roomId, held.from, held.until, exceptStay, held.dayUse]);
}
// The hours a night stay holds its room: from the check-in time on its arrival day to the check-out time on its departure day.
async function nightHeld(db, business, arrival, departure) {
  return repo.one(db, `SELECT lower(h) AS "from",upper(h) AS "until" FROM (SELECT lodging_stay_held(FALSE,NULL,NULL,$2::date,$3::date,z.timezone,COALESCE(t.check_in_time,'12:00'),
      COALESCE(t.check_out_time,'11:00')) AS h FROM businesses z LEFT JOIN lodging_settings t ON t.business_id=z.id WHERE z.id=$1) x`, [business.id, arrival, departure]);
}
const hoursWords = (clash) => `Room ${clash.room_no} is ${clash.status === 'in_house' ? 'occupied' : 'booked'} by ${clash.stay_no} (${clash.guest_name}) at those hours${clash.day_use ? ' (a day use)' : ''}`;

// The figures of a reservation being typed, nothing saved: each night at its rate and slab, with its meals, the total,
// whether the room and the room type are free, and what the calendar refuses. body: { locationId, arrival, departure, roomTypeId, roomId?, ratePlanId?,
// adults, children?, extraBeds?, agreedRate?, discount?: { percent }, dayUse?: { from, hours }, stayId? }
async function preview(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const dayUse = readDayUse(body.dayUse);
  const nights = dayUse ? { arrival: c.readDate(body.arrival, 'Day'), departure: c.addDays(c.readDate(body.arrival, 'Day'), 1) } : readNights(body.arrival, body.departure);
  const party = readParty(body);
  const agreed = c.readRate(body.agreedRate, 'The agreed rate');
  const percent = c.given(body.discount?.percent) ? core.decimal(body.discount.percent, 'Discount (percent)', 2, 0, 100) : null;
  return repo.transaction(async (db) => {
    const existing = c.given(body.stayId) ? await repo.one(db, 'SELECT * FROM lodging_stays WHERE business_id=$1 AND id=$2', [business.id, id(body.stayId, 'Stay')]) : null;
    if (c.given(body.stayId) && !existing) fail('Stay not found', 404);
    const type = await roomTypeOf(db, business, body.roomTypeId);
    const plan = c.given(body.ratePlanId) ? await rateCards.planOf(db, business, body.ratePlanId, type) : null;
    const locationId = existing ? existing.location_id : id(body.locationId, 'Location');
    checkParty(type, party, typeRates(type));
    const room = c.given(body.roomId) ? await roomFor(db, business, body.roomId, type, locationId) : null;
    let rows, clash = null, full = null, calendarWords = null, hours = null;
    if (dayUse) {
      if (!room) fail('A day use names its room');
      hours = await dayUseHours(db, business, nights.arrival, dayUse);
      rows = [{ night: nights.arrival, rateKind: 'day_use', roomRate: await rateCards.dayUseRate(db, business, type, dayUse.hours), extraAdult: null, child: null, extraBed: null, mealSkuId: null }];
      const held = await hoursClash(db, business, room.id, { from: hours.day_from, until: hours.day_until, dayUse: true }, existing?.id || null);
      clash = held ? { words: hoursWords(held) } : null;
    } else {
      rows = await rateCards.nightsFor(db, business, { type, plan, arrival: nights.arrival, departure: nights.departure, agreed });
      checkNightParty(type, party, rows);
      const found = money.restriction(rows, { arrival: nights.arrival, nights: rows.length });
      calendarWords = found ? rateCards.restrictionWords(type, found) : null;
      const night = room ? await roomClash(db, business, room.id, nights.arrival, nights.departure, existing?.id || null) : null;
      clash = night ? { words: clashWords(night) } : null;
      full = await typeFull(db, business, type.id, locationId, nights.arrival, nights.departure, existing?.id || null);
    }
    const est = await priceNights(db, business, rows, { ...party, baseOccupancy: type.base_occupancy }, percent);
    return { ...nights, count: est.nights.length, nights: est.nights.map(nightText), subtotal: money.rupees(est.subtotal), tax: money.rupees(est.tax), total: money.rupees(est.total),
      roomFree: !clash, roomWords: clash ? clash.words : null, typeFree: !full, typeWords: full ? fullWords(type, full) : null, calendarFree: !calendarWords, calendarWords,
      ...(hours ? { dayFrom: hours.day_from, dayUntil: hours.day_until } : {}) };
  });
}

// --- Money taken for a stay -----------------------------------------------------------------------------------

// An advance or a deposit: a numbered collection receipt in the guest's name (cash, card, UPI or bank),
// kept with the stay. Inside the caller's transaction.
async function takeReceipt(db, business, user, stay, { purpose, amount, method, methodName, reference, requestKey, hash }) {
  const receipt = await numbering.nextNumber(db, business.id, stay.location_id, 'collection', user.id);
  const words = purpose === 'deposit' ? `Refundable deposit for stay ${stay.stay_no}` : `Advance on stay ${stay.stay_no}`;
  const collection = await repo.one(db, `INSERT INTO business_collections(business_id,location_id,collection_no,series_id,contact_id,contact_name,amount,method,reference,notes,request_key,request_hash,created_by,method_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [business.id, stay.location_id, receipt.number, receipt.seriesId, stay.contact_id, stay.guest_name,
    money.rupees(amount), method, reference || null, words, requestKey, hash, user.id, methodName || null]);
  await db.query('INSERT INTO lodging_receipts(business_id,collection_id,stay_id,purpose,created_by) VALUES($1,$2,$3,$4,$5)', [business.id, collection.id, stay.id, purpose, user.id]);
  await repo.audit(db, business.id, user.id, 'collection.recorded', collection.id, { amount: collection.amount, method: collection.method, stay: stay.stay_no, purpose });
  await repo.event(db, business.id, user.id, 'collection.recorded', 'collection', collection.id, {
    collectionNo: collection.collection_no, contactId: stay.contact_id, amount: collection.amount, method: collection.method, lodgingStayId: stay.id, purpose });
  await history(db, business, user, stay, null, null, `${purpose === 'deposit' ? 'Deposit' : 'Advance'} taken (${collection.collection_no}, ${collection.amount})`);
  return collection;
}

// { amount, method | methodId, reference? } as typed, for an advance or a deposit (sales.edit). null when none.
async function readMoney(db, business, value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an amount and how it was paid`);
  const amount = core.decimal(value.amount ?? 0, label, 2, 0, 10000000);
  if (amount <= 0) return null;
  await access.require(business, 'sales.edit');
  return { amount: money.paise(amount), ...await paymentMethods.pick(db, business.id, value, `${label} paid by`, c.RECEIPT_KINDS), reference: c.optionalText(value.reference, 'Reference', 100) };
}

// The receipts of a stay (or of the stays of a group) with what is left of each (locked when asked): advances first, then deposits, oldest first.
async function receiptsOf(db, business, stayIds, { lock = false } = {}) {
  return repo.all(db, `SELECT r.purpose,r.stay_id,k.contact_id,k.id,k.collection_no,k.amount,k.method,k.method_name,k.reference,k.created_at,${c.FREE_SQL('k')} AS free
    FROM lodging_receipts r JOIN business_collections k ON k.business_id=r.business_id AND k.id=r.collection_id
    WHERE r.business_id=$1 AND r.stay_id=ANY($2::bigint[]) ORDER BY r.purpose='deposit',k.id${lock ? ' FOR UPDATE OF k' : ''}`, [business.id, [].concat(stayIds).map(Number)]);
}

// The stay's advances, then its deposits, paid on its bill (each a payment from its receipt), up to what is due.
// Returns what each paid (paise). Inside the caller's transaction, the bill locked.
async function applyReceipts(db, business, user, stayIds, document, key) {
  const used = { advance: 0, deposit: 0 };
  const owed = await repo.one(db, `SELECT ${c.DUE_SQL('d')} AS due FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, document.id]);
  let left = Math.max(0, money.paise(owed.due));
  for (const receipt of await receiptsOf(db, business, stayIds, { lock: true })) {
    // A receipt settles only bills of the customer who paid it.
    if (Number(receipt.contact_id) !== Number(document.contact_id)) continue;
    const take = Math.min(left, Math.max(0, money.paise(receipt.free)));
    if (take <= 0) continue;
    await core.recordPayment(db, business, user, document, { amount: money.rupees(take), method: receipt.method, reference: receipt.collection_no,
      key: c.derivedKey(key, `receipt:${receipt.id}`), collectionId: receipt.id });
    used[receipt.purpose] += take;
    left -= take;
  }
  return used;
}

// What is left of the stay's receipts handed back (deposits first, then advances), each a numbered refund of its
// receipt with the manager who approved it. `amount` null: all that is left. Asked again with the same key, the
// refunds already made are the answer. Returns the refunds (`repeated` on those made before).
async function refundLeft(db, business, user, stay, { amount = null, how, approval, key }) {
  const made = [];
  let left = amount;
  const receipts = (await receiptsOf(db, business, stay.id, { lock: true }))
    .sort((a, b) => (a.purpose === b.purpose ? Number(a.id) - Number(b.id) : a.purpose === 'deposit' ? -1 : 1));
  for (const receipt of receipts) {
    const requestKey = c.derivedKey(key, `refund:${receipt.id}`);
    const before = await repo.one(db, 'SELECT * FROM business_collection_refunds WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (before) {
      made.push({ ...before, collection_no: receipt.collection_no, purpose: receipt.purpose, repeated: true });
      if (left !== null) left -= Math.min(left, money.paise(before.amount));
      continue;
    }
    const free = Math.max(0, money.paise(receipt.free));
    const take = left === null ? free : Math.min(left, free);
    if (take <= 0) continue;
    const input = { amount: take, method: how.method, methodId: how.methodId, reference: how.reference, requestKey };
    const { refund } = await refunds().refundCollection(db, business, user, { collectionId: receipt.id, contactId: stay.contact_id, input, approval, source: 'lodging', label: stay.stay_no });
    made.push({ ...refund, purpose: receipt.purpose, repeated: false });
    if (left !== null) left -= take;
  }
  if (left !== null && left > 0) fail(`Only ${money.rupees(amount - left)} is held for stay ${stay.stay_no}`, 409);
  return made;
}

// How money goes back: { method | methodId, reference? } — cash, UPI or bank (a reference for UPI and bank).
function readBack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Say how the money goes back');
  const { method, methodId } = paymentMethods.readChoice(value, 'Handed back by', ['cash', 'upi', 'bank'], 'cash');
  const reference = c.optionalText(value.reference, 'Reference', 100);
  if (method && method !== 'cash' && !reference) fail(`Enter the ${method === 'upi' ? 'UPI' : 'bank'} reference of the money handed back`);
  return { method, methodId, reference };
}

// What the bill of these values asks to be paid now, after what is held for the stay: the parts as typed
// ("full": all that is left), or refused when they come to more. `figures` are the bill's.
function partsAfterHeld(parts, figures, held) {
  const due = Math.max(0, figures.total - held);
  const fixedPaid = parts.filter((p) => p.amount !== 'full').reduce((s, p) => s + money.paise(p.amount), 0);
  if (fixedPaid > due) fail(`Only ${money.rupees(due)} is left to pay on this bill${held ? ' after the money held for the stay' : ''}`);
  return parts.map((p) => (p.amount === 'full' ? { ...p, amount: Number(money.rupees(due - fixedPaid)) } : p)).filter((p) => money.paise(p.amount) > 0);
}

// The stay's bill (a core sale) of these values, one line each, at their fixed prices and rates: to `contactId`,
// paid by what is taken now, then by the stay's advances and deposits (`stayIds`: the stays whose receipts pay it,
// the stay's own when left out). `key`: the bill's own request key (each of a stay's folios has its own). Inside the
// caller's transaction. Returns { document, used, lineIds (in the order of the values), figures }.
async function postBill(db, business, user, stay, { values, contactId, parts, buyer, key, hash, notes, stayIds = [stay.id] }) {
  const settings = await repo.one(db, 'SELECT tax_mode,rounding FROM business_settings WHERE business_id=$1', [business.id]);
  const billLines = money.billLines(values, settings?.tax_mode || 'exclusive');
  const figures = money.billFigures(values, settings?.rounding);
  if (figures.total > c.MAX_TOTAL) fail('The bill would come to more than a bill can hold');
  const held = (await receiptsOf(db, business, stayIds)).filter((r) => Number(r.contact_id) === Number(contactId)).reduce((s, r) => s + Math.max(0, money.paise(r.free)), 0);
  const paidNow = partsAfterHeld(parts, figures, held);
  const documentBody = { kind: 'sale', locationId: stay.location_id, contactId, lines: billLines.map((l) => l.input), notes: String(notes).slice(0, 500),
    buyer: { pan: buyer?.pan, panDeclaration: buyer?.panDeclaration } };
  const document = await core.postDocument(db, business, user, documentBody, { kind: 'sale', requestKey: c.derivedKey(key, 'bill'), hash, lines: documentBody.lines, paidNow,
    fixed: billLines.map((l) => l.fixed), lodging: true });
  if (money.paise(document.total) !== figures.total) fail(`The bill would come to ${document.total}, not the ${money.rupees(figures.total)} worked out for the stay. Try again.`, 409);
  const lineIds = (await repo.all(db, 'SELECT id FROM business_document_lines WHERE business_id=$1 AND document_id=$2 ORDER BY id', [business.id, document.id])).map((r) => r.id);
  if (lineIds.length !== billLines.length) fail('The bill does not have a line for each charge. Try again.', 409);
  const locked = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, document.id]);
  const used = await applyReceipts(db, business, user, stayIds, locked, key);
  return { document, used, lineIds, figures };
}

// --- History ---------------------------------------------------------------------------------------------------

async function history(db, business, user, stay, from, to, note) {
  await db.query('INSERT INTO lodging_stay_events(business_id,stay_id,from_status,to_status,note,created_by) VALUES($1,$2,$3,$4,$5,$6)',
    [business.id, stay.id, from, to, note ? String(note).slice(0, 500) : null, user.id]);
}

// --- Reservations ----------------------------------------------------------------------------------------------

async function lockStay(db, business, stayId) {
  // Same lock order as every posting: the business, then the record.
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const stay = await repo.one(db, 'SELECT * FROM lodging_stays WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(stayId, 'Stay')]);
  if (!stay) fail('Stay not found', 404);
  access.requireLocation(business, stay.location_id);
  return stay;
}

// A customer of this business who is billed for a stay instead of its guest. null when none.
async function billToOf(db, business, value, guestId) {
  if (!c.given(value)) return null;
  const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(value, 'Billed to')]);
  if (!contact) fail('The company billed is not a customer of this business', 404);
  if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
  if (Number(contact.id) === Number(guestId)) return null;
  return contact;
}

// Runs a posting; a room taken twice at the same moment comes back as the database's sentence.
const posting = (work) => repo.transaction(work).catch((error) => { throw c.roomTaken(error); });

// The guest of a reservation as typed: one of the customers (contactId) or a new one ({ name, phone?, consents? }).
function readGuest(body, label = 'the guest') {
  const contactId = c.given(body.contactId) ? id(body.contactId, 'Guest') : null;
  const newGuest = body.guest && typeof body.guest === 'object' && !Array.isArray(body.guest) && c.given(body.guest.name)
    ? { kind: 'customer', name: body.guest.name, phone: body.guest.phone, consents: body.guest.consents } : null;
  if (contactId && newGuest) fail(`Choose ${label} or type a new one, not both`);
  return { contactId, newGuest };
}
// The guest's contact, found or made (contacts.create), inside the caller's transaction.
async function guestContact(db, business, user, { contactId, newGuest }) {
  if (contactId) {
    const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]);
    if (!contact) fail('Guest not found', 404);
    if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
    return contact;
  }
  await access.require(business, 'contacts.create');
  return core.createContact(business, user, newGuest, db);
}

// A reservation as typed, read and checked before anything is saved.
function readReservation(body) {
  const dayUse = readDayUse(body.dayUse);
  const nights = dayUse ? { arrival: c.readDate(body.arrival, 'Day'), departure: null } : readNights(body.arrival, body.departure);
  if (dayUse) nights.departure = c.addDays(nights.arrival, 1);
  const party = readParty(body);
  const agreed = c.readRate(body.agreedRate, 'The agreed rate');
  if (dayUse && (party.extraBeds || agreed !== null || c.given(body.ratePlanId))) fail('A day use is priced by its block of hours: no extra bed, agreed rate or rate plan');
  return { locationId: id(body.locationId, 'Location'), guest: readGuest(body), nights, party, source: readSource(body), agreed, dayUse, notes: c.optionalText(body.notes, 'Notes', 500),
    planId: c.given(body.ratePlanId) ? id(body.ratePlanId, 'Rate plan') : null, discount: readDiscount(body.discount) ?? null, roomTypeId: body.roomTypeId, roomId: body.roomId,
    billToContactId: body.billToContactId, advance: body.advance };
}

// A reservation saved, inside the caller's transaction (the business locked). r: readReservation's; `contact`: the guest's contact
// when the caller has it; `groupId`: the group it belongs to. Returns the stay's id (the one made before with this key, if any).
async function reserveIn(db, business, user, r, { requestKey, hash, contact = null, groupId = null }) {
  const old = await repo.one(db, 'SELECT id,request_hash FROM lodging_stays WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
  if (old) {
    if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
    return old.id;
  }
  access.requireLocation(business, r.locationId);
  const location = await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, r.locationId]);
  if (!location) fail('Location not found', 404);
  const { nights, party, source } = r;
  const today = await c.today(db, business);
  if (nights.arrival < today) fail('A stay arrives today or later');
  const type = await roomTypeOf(db, business, r.roomTypeId);
  if (!type.active) fail(`${type.name} is switched off: switch it on to book it`, 409);
  const plan = r.planId ? await rateCards.planOf(db, business, r.planId, type) : null;
  if (plan && !plan.active) fail(`${plan.name} is switched off: choose another plan`, 409);
  const rates = { ...typeRates(type), agreed_rate: r.agreed === null ? null : money.rupees(r.agreed) };
  checkParty(type, party, rates);
  const room = c.given(r.roomId) ? await roomFor(db, business, r.roomId, type, location.id) : null;
  let rows, hours = null;
  if (r.dayUse) {
    if (!room) fail('A day use names its room');
    hours = await dayUseHours(db, business, nights.arrival, r.dayUse);
    const clash = await hoursClash(db, business, room.id, { from: hours.day_from, until: hours.day_until, dayUse: true });
    if (clash) fail(`${hoursWords(clash)}: choose another room or other hours`, 409);
    rows = [{ night: nights.arrival, rateKind: 'day_use', roomRate: await rateCards.dayUseRate(db, business, type, r.dayUse.hours), extraAdult: null, child: null, extraBed: null,
      mealSkuId: null, mealAdult: null, mealChild: null }];
  } else {
    if (room) {
      const clash = await roomClash(db, business, room.id, nights.arrival, nights.departure);
      if (clash) fail(`${clashWords(clash)}: choose another room`, 409);
      const day = await hoursClash(db, business, room.id, { ...await nightHeld(db, business, nights.arrival, nights.departure), dayUse: false });
      if (day) fail(`${hoursWords(day)}: choose another room`, 409);
    }
    const full = await typeFull(db, business, type.id, location.id, nights.arrival, nights.departure);
    if (full) fail(fullWords(type, full), 409);
    rows = await rateCards.nightsFor(db, business, { type, plan, arrival: nights.arrival, departure: nights.departure, agreed: r.agreed });
    rateCards.checkRestrictions(type, rows, { arrival: nights.arrival, nights: rows.length });
    checkNightParty(type, party, rows);
  }
  await checkDiscount(db, business, r.discount);
  const est = await priceNights(db, business, rows, { ...party, baseOccupancy: type.base_occupancy }, r.discount?.percent);
  if (!contact) {
    if (!r.guest.contactId && !r.guest.newGuest) fail('Choose the guest, or type the new guest\'s name');
    contact = await guestContact(db, business, user, r.guest);
  }
  const billTo = await billToOf(db, business, r.billToContactId, contact.id);
  const advance = await readMoney(db, business, r.advance, 'Advance');
  if (advance && advance.amount > est.total) fail(`An advance is money on account for the stay: at most ${money.rupees(est.total)}, the stay as booked`);
  const policy = r.dayUse ? null : await rateCards.policyFor(db, business, { plan, locationId: location.id });
  const number = await numbering.nextNumber(db, business.id, location.id, 'stay', user.id);
  const stay = await repo.one(db, `INSERT INTO lodging_stays(business_id,location_id,stay_no,series_id,contact_id,guest_name,guest_phone,bill_to_contact_id,source,ota_name,ota_booking_id,
      status,arrival,departure,room_type_id,room_id,adults,children,extra_beds,base_occupancy,rack_rate,weekend_rate,extra_adult_rate,child_rate,extra_bed_rate,agreed_rate,
      estimate_subtotal,estimate_tax,estimate_total,notes,request_key,request_hash,created_by,updated_by,rate_plan_id,policy,discount_percent,discount_reason,day_use,day_from,day_until,
      day_hours,group_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41)
    RETURNING *`,
  [business.id, location.id, number.number, number.seriesId, contact.id, contact.name, contact.phone || null, billTo?.id || null, source.source, source.otaName, source.otaBookingId,
    nights.arrival, nights.departure, type.id, room?.id || null, party.adults, party.children, party.extraBeds, rates.base_occupancy, rates.rack_rate, rates.weekend_rate,
    rates.extra_adult_rate, rates.child_rate, rates.extra_bed_rate, rates.agreed_rate, money.rupees(est.subtotal), money.rupees(est.tax), money.rupees(est.total), r.notes,
    requestKey, hash, user.id, plan?.id || null, policy, r.discount?.percent ?? null, r.discount?.reason ?? null, Boolean(r.dayUse), hours?.day_from || null, hours?.day_until || null,
    r.dayUse?.hours || null, groupId]);
  await saveNights(db, business, stay.id, rows, { arrival: nights.arrival, departure: nights.departure, replace: true });
  await history(db, business, user, stay, null, 'reserved', [`Reserved: ${type.name}${plan ? ` (${plan.name}, ${plan.meal_plan})` : ''}${room ? `, room ${room.room_no}` : ''}`,
    r.dayUse ? `day use ${r.dayUse.from} for ${c.plural(r.dayUse.hours, 'hour')} on ${c.dayWords(nights.arrival)}` : c.nightsWords(nights.arrival, nights.departure),
    `${c.plural(party.adults, 'adult')}${party.children ? `, ${c.plural(party.children, 'child', 'children')}` : ''}`, source.source === 'ota' ? `${source.otaName} ${source.otaBookingId}` : c.SOURCE_WORDS[source.source],
    r.discount ? `discount ${r.discount.percent}% (${r.discount.reason})` : null].filter(Boolean).join(' · '));
  if (advance) await takeReceipt(db, business, user, stay, { purpose: 'advance', ...advance, requestKey: c.derivedKey(requestKey, 'advance'), hash });
  const details = { stayNo: stay.stay_no, guest: contact.name, arrival: nights.arrival, departure: nights.departure, roomType: type.name, roomNo: room?.room_no || null,
    source: source.source, estimate: stay.estimate_total, billTo: billTo?.name || null, plan: plan?.name || null, dayUse: Boolean(r.dayUse), groupId,
    ...(r.discount ? { discountPercent: r.discount.percent, discountReason: r.discount.reason } : {}) };
  await repo.audit(db, business.id, user.id, 'lodging_stay.reserved', stay.id, details);
  await repo.event(db, business.id, user.id, 'lodging_stay.reserved', 'lodging_stay', stay.id, { ...details, locationId: location.id, contactId: contact.id, roomTypeId: type.id,
    roomId: room?.id || null });
  return stay.id;
}

// body: { requestKey, locationId, contactId | guest: { name, phone? }, billToContactId?, source?: walk_in | phone | ota, otaName?, otaBookingId?,
//   arrival, departure (a day use: arrival only, the day), roomTypeId, roomId? (a day use: required), ratePlanId?, adults, children?, extraBeds?, agreedRate?,
//   discount?: { percent, reason }, dayUse?: { from (HH:MM), hours }, notes?, advance?: { amount, method | methodId, reference? } }
async function create(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const r = readReservation(body);
  if (!r.guest.contactId && !r.guest.newGuest) fail('Choose the guest, or type the new guest\'s name');
  return posting(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const stayId = await reserveIn(db, business, user, r, { requestKey, hash });
    return shape(business, await load(db, business, stayId));
  });
}

// body: what changes, the rest stays — a reservation: { arrival?, departure?, roomTypeId?, roomId? (null: none yet), ratePlanId? (null: none), adults?, children?,
//   extraBeds?, agreedRate? (null: the calendar's rates), discount? ({ percent, reason }; null: none), billToContactId? (null: the guest), source?, otaName?,
//   otaBookingId?, notes? }; a stay in the house: { departure?, roomId? (a move: with roomTypeId for another type, at the rates booked), extraBeds?,
//   agreedRate? and ratePlanId? (lodging.approve), discount?, billToContactId?, notes?, arrivedFrom?, goingTo?, purpose? }; a day use: { discount?,
//   billToContactId?, notes? }. Priced again; the nights keep the rates they were priced at unless the room type, the plan or the agreed rate changes;
//   new nights take the calendar's; what is left out stays.
async function update(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  return posting(async (db) => {
    const stay = await lockStay(db, business, stayId);
    if (!['reserved', 'in_house'].includes(stay.status)) fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]} and no longer changes`, 409);
    const inHouse = stay.status === 'in_house';
    if (inHouse) {
      for (const key of ['arrival', 'adults', 'children', 'source', 'otaName', 'otaBookingId']) {
        if (body[key] !== undefined) fail(`Stay ${stay.stay_no} is in the house: its arrival, its guests and where it was booked stay as they are`, 409);
      }
    }
    if (stay.day_use) {
      for (const key of ['arrival', 'departure', 'roomTypeId', 'roomId', 'ratePlanId', 'adults', 'children', 'extraBeds', 'agreedRate']) {
        if (body[key] !== undefined) fail(`Stay ${stay.stay_no} is a day use: it keeps its day, hours, room and guests; cancel it and book again`, 409);
      }
    }
    const today = await c.today(db, business);
    const nights = stay.day_use ? { arrival: c.dayOf(stay.arrival), departure: c.dayOf(stay.departure) }
      : readNights(body.arrival ?? c.dayOf(stay.arrival), body.departure ?? c.dayOf(stay.departure));
    if (!inHouse && body.arrival !== undefined && nights.arrival < today) fail('A stay arrives today or later');
    if (inHouse && nights.departure < today) fail(`Stay ${stay.stay_no} has a guest in the house: they leave today or later`);
    const party = readParty(body, stay);
    const source = inHouse ? { source: stay.source, otaName: stay.ota_name, otaBookingId: stay.ota_booking_id } : readSource(body, stay);
    const typeChanged = body.roomTypeId !== undefined && Number(body.roomTypeId) !== Number(stay.room_type_id);
    const type = await roomTypeOf(db, business, typeChanged ? body.roomTypeId : stay.room_type_id);
    if (typeChanged && !type.active) fail(`${type.name} is switched off: switch it on to book it`, 409);
    if (typeChanged && inHouse && body.roomId === undefined) fail('A guest in the house moves to another room type with the room they move to');
    const agreedGiven = body.agreedRate !== undefined;
    const agreed = agreedGiven ? c.readRate(body.agreedRate, 'The agreed rate') : (stay.agreed_rate === null ? null : money.paise(stay.agreed_rate));
    const rateChange = agreedGiven && agreed !== (stay.agreed_rate === null ? null : money.paise(stay.agreed_rate));
    // The plan: as it is, another of the room type's, or none; a stay moved to another type keeps a plan only when given one of the new type's.
    const planGiven = body.ratePlanId !== undefined;
    const planId = planGiven ? (c.given(body.ratePlanId) ? id(body.ratePlanId, 'Rate plan') : null) : typeChanged ? null : stay.rate_plan_id;
    const plan = planId ? await rateCards.planOf(db, business, planId, type) : null;
    const planChanged = Number(planId || 0) !== Number(stay.rate_plan_id || 0);
    if (plan && planChanged && !plan.active) fail(`${plan.name} is switched off: choose another plan`, 409);
    if (inHouse && (rateChange || planChanged)) await access.require(business, 'lodging.approve');
    const discountGiven = readDiscount(body.discount);
    const discount = discountGiven === undefined ? (stay.discount_percent === null ? null : { percent: Number(stay.discount_percent), reason: stay.discount_reason }) : discountGiven;
    const discountChanged = discountGiven !== undefined && (Number(discount?.percent || 0) !== Number(stay.discount_percent || 0) || (discount?.reason || null) !== (stay.discount_reason || null));
    if (discountChanged) await checkDiscount(db, business, discount);
    // A reservation moved to another type takes that type's rates; a guest moved in the house keeps the rates booked.
    const rates = { ...(typeChanged && !inHouse ? typeRates(type) : stay), agreed_rate: agreed === null ? null : money.rupees(agreed) };
    checkParty(type, party, rates);
    let room = null;
    const roomGiven = body.roomId !== undefined;
    if (roomGiven && c.given(body.roomId)) room = await roomFor(db, business, body.roomId, type, stay.location_id);
    if (roomGiven && !c.given(body.roomId) && inHouse) fail(`Stay ${stay.stay_no} has a guest in the house: they keep a room`);
    const roomId = roomGiven ? room?.id || null : typeChanged ? null : stay.room_id;
    if (typeChanged && !roomGiven && stay.room_id) fail('Choose a room of the new room type, or none yet');
    const moving = inHouse && roomId && Number(roomId) !== Number(stay.room_id);
    if (moving && room.status !== 'vacant_clean') fail(`Room ${room.room_no} is ${c.ROOM_WORDS[room.status]}${room.status_note ? ` (${room.status_note})` : ''}: a guest moves to a room that is vacant and clean`, 409);
    const notes = body.notes === undefined ? stay.notes : c.optionalText(body.notes, 'Notes', 500);
    const register = {
      arrivedFrom: body.arrivedFrom === undefined ? stay.arrived_from : c.optionalText(body.arrivedFrom, 'Coming from', 150),
      goingTo: body.goingTo === undefined ? stay.going_to : c.optionalText(body.goingTo, 'Going to', 150),
      purpose: body.purpose === undefined ? stay.purpose : c.optionalText(body.purpose, 'Purpose of the visit', 150),
    };
    const billTo = body.billToContactId === undefined ? (stay.bill_to_contact_id ? { id: stay.bill_to_contact_id } : null) : await billToOf(db, business, body.billToContactId, stay.contact_id);
    const datesChanged = nights.arrival !== c.dayOf(stay.arrival) || nights.departure !== c.dayOf(stay.departure);
    const replace = typeChanged || planChanged || rateChange;
    if (!stay.day_use) {
      if (roomId) {
        const clash = await roomClash(db, business, roomId, nights.arrival, nights.departure, stay.id);
        if (clash) fail(`${clashWords(clash)}: choose another room`, 409);
        const day = await hoursClash(db, business, roomId, { ...await nightHeld(db, business, nights.arrival, nights.departure), dayUse: false }, stay.id);
        if (day) fail(`${hoursWords(day)}: choose another room`, 409);
      }
      const full = await typeFull(db, business, type.id, stay.location_id, nights.arrival, nights.departure, stay.id);
      if (full) fail(fullWords(type, full), 409);
      // The calendar as it is now: the rates of nights new to the stay (or of every night still to post, when the rates change), and its restrictions.
      const fresh = await rateCards.nightsFor(db, business, { type, plan, arrival: nights.arrival, departure: nights.departure, agreed });
      if (!inHouse && (datesChanged || typeChanged || planChanged)) rateCards.checkRestrictions(type, fresh, { arrival: nights.arrival, nights: fresh.length });
      if (inHouse && nights.departure > c.dayOf(stay.departure)) {
        rateCards.checkRestrictions(type, fresh, { arrival: nights.arrival, nights: fresh.length, only: money.nightsOf(c.dayOf(stay.departure), nights.departure) });
      }
      checkNightParty(type, party, replace ? fresh : fresh.filter((r) => r.night >= c.dayOf(stay.departure) || r.night < c.dayOf(stay.arrival)));
      await saveNights(db, business, stay.id, fresh, { ...nights, replace });
    }
    const priced = await priceNights(db, business, await nightRows(db, business, stay.id), { ...party, baseOccupancy: rates.base_occupancy }, discount?.percent);
    // A stay in the house: the nights posted count as they were posted (their meals too).
    let subtotal = priced.subtotal, tax = priced.tax;
    if (inHouse) {
      const posted = await repo.all(db, `SELECT night::text AS night,kind,net,tax FROM lodging_charges WHERE business_id=$1 AND stay_id=$2 AND kind IN ('room_night','meal','day_use')
        AND voided_at IS NULL`, [business.id, stay.id]);
      subtotal = 0; tax = 0;
      for (const n of priced.nights) {
        const room = posted.find((p) => p.night === n.night && p.kind !== 'meal');
        const meal = posted.find((p) => p.night === n.night && p.kind === 'meal');
        subtotal += (room ? money.paise(room.net) : n.net) + (room ? (meal ? money.paise(meal.net) : 0) : n.meal);
        tax += (room ? money.paise(room.tax) : n.tax) + (room ? (meal ? money.paise(meal.tax) : 0) : n.mealTax);
      }
    }
    const policy = planChanged && !inHouse ? await rateCards.policyFor(db, business, { plan, locationId: stay.location_id }) : stay.policy;
    await db.query(`UPDATE lodging_stays SET arrival=$3,departure=$4,room_type_id=$5,room_id=$6,adults=$7,children=$8,extra_beds=$9,base_occupancy=$10,rack_rate=$11,weekend_rate=$12,
        extra_adult_rate=$13,child_rate=$14,extra_bed_rate=$15,agreed_rate=$16,estimate_subtotal=$17,estimate_tax=$18,estimate_total=$19,bill_to_contact_id=$20,source=$21,ota_name=$22,
        ota_booking_id=$23,notes=$24,arrived_from=$25,going_to=$26,purpose=$27,updated_by=$28,updated_at=now(),rate_plan_id=$29,policy=$30,discount_percent=$31,discount_reason=$32
      WHERE business_id=$1 AND id=$2`,
    [business.id, stay.id, nights.arrival, nights.departure, type.id, roomId, party.adults, party.children, party.extraBeds, rates.base_occupancy, rates.rack_rate, rates.weekend_rate,
      rates.extra_adult_rate, rates.child_rate, rates.extra_bed_rate, rates.agreed_rate, money.rupees(subtotal), money.rupees(tax), money.rupees(subtotal + tax), billTo?.id || null,
      source.source, source.otaName, source.otaBookingId, notes, register.arrivedFrom, register.goingTo, register.purpose, user.id, planId, policy, discount?.percent ?? null,
      discount?.reason ?? null]);
    let movedFrom = null;
    if (moving) {
      movedFrom = await repo.one(db, 'SELECT id,room_no FROM lodging_rooms WHERE business_id=$1 AND id=$2', [business.id, stay.room_id]);
      await db.query("UPDATE lodging_rooms SET status='vacant_dirty',status_note=$3,status_by=$4,status_at=now() WHERE business_id=$1 AND id=$2",
        [business.id, stay.room_id, `Moved to room ${room.room_no}: ${stay.stay_no}`.slice(0, 300), user.id]);
      await db.query("UPDATE lodging_rooms SET status='occupied',status_note=$3,status_by=$4,status_at=now() WHERE business_id=$1 AND id=$2",
        [business.id, room.id, `Moved in: ${stay.stay_no}`.slice(0, 300), user.id]);
    }
    // A discount changed in the house: the nights posted and not billed are posted again at it (each at the slab its value now decides).
    let reposted = 0;
    if (inHouse && discountChanged) reposted = await folio().repostNights(db, business, user, { ...stay, discount_percent: discount?.percent ?? null }, `Discount ${discount ? `of ${discount.percent}%` : 'taken off'}: posted again`);
    const said = [datesChanged ? c.nightsWords(nights.arrival, nights.departure) : null,
      typeChanged ? `room type ${type.name}` : null, planChanged ? (plan ? `plan ${plan.name} (${plan.meal_plan})` : 'no rate plan') : null,
      moving ? `moved from room ${movedFrom.room_no} to ${room.room_no}` : roomGiven && Number(roomId) !== Number(stay.room_id) ? (room ? `room ${room.room_no}` : 'no room yet') : null,
      party.adults !== Number(stay.adults) || party.children !== Number(stay.children) ? `${c.plural(party.adults, 'adult')}, ${c.plural(party.children, 'child', 'children')}` : null,
      party.extraBeds !== Number(stay.extra_beds) ? c.plural(party.extraBeds, 'extra bed') : null, rateChange ? (agreed === null ? 'the calendar\'s rates' : `agreed rate ${money.rupees(agreed)} a night`) : null,
      discountChanged ? (discount ? `discount ${discount.percent}% (${discount.reason})` : 'no discount') : null, reposted ? `${c.plural(reposted, 'night')} posted again` : null,
      body.billToContactId !== undefined && Number(billTo?.id || 0) !== Number(stay.bill_to_contact_id || 0) ? (billTo ? 'billed to a company' : 'billed to the guest') : null,
      notes !== stay.notes ? 'notes changed' : null].filter(Boolean);
    if (said.length) await history(db, business, user, stay, null, null, `Changed: ${c.listWords(said)}`);
    const details = { stayNo: stay.stay_no, arrival: { from: c.dayOf(stay.arrival), to: nights.arrival }, departure: { from: c.dayOf(stay.departure), to: nights.departure },
      roomTypeId: { from: Number(stay.room_type_id), to: Number(type.id) }, roomId: { from: stay.room_id, to: roomId }, estimate: { from: stay.estimate_total, to: money.rupees(subtotal + tax) },
      ...(rateChange ? { agreedRate: { from: stay.agreed_rate, to: rates.agreed_rate } } : {}), ...(planChanged ? { ratePlanId: { from: stay.rate_plan_id, to: planId } } : {}),
      ...(discountChanged ? { discount: { from: stay.discount_percent, to: discount?.percent ?? null, reason: discount?.reason ?? null } } : {}) };
    await repo.audit(db, business.id, user.id, moving ? 'lodging_stay.moved' : 'lodging_stay.changed', stay.id, details);
    await repo.event(db, business.id, user.id, moving ? 'lodging_stay.moved' : 'lodging_stay.changed', 'lodging_stay', stay.id, details);
    return shape(business, await load(db, business, stay.id));
  });
}

// body: { requestKey, purpose: advance | deposit, amount, method | methodId, reference? } — while the stay is reserved or in the house.
async function receive(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  await access.require(business, 'sales.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, stayId: String(stayId) });
  const purpose = v.requiredEnum(body.purpose, 'Taken as', ['advance', 'deposit']);
  return repo.transaction(async (db) => {
    const stay = await lockStay(db, business, stayId);
    const old = await repo.one(db, 'SELECT id,request_hash FROM business_collections WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(business, await load(db, business, stay.id));
    }
    if (!['reserved', 'in_house'].includes(stay.status)) fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: money is taken for it while it is reserved or in the house`, 409);
    const taken = await readMoney(db, business, { amount: body.amount, method: body.method, methodId: body.methodId, reference: body.reference }, purpose === 'deposit' ? 'Deposit' : 'Advance');
    if (!taken) fail('Give the amount taken');
    if (purpose === 'advance') {
      const advances = (await receiptsOf(db, business, stay.id)).filter((r) => r.purpose === 'advance').reduce((s, r) => s + money.paise(r.amount), 0);
      const extras = await repo.one(db, `SELECT COALESCE(sum(net+tax),0) AS total FROM lodging_charges WHERE business_id=$1 AND stay_id=$2 AND kind='extra' AND voided_at IS NULL`, [business.id, stay.id]);
      const expected = money.paise(stay.estimate_total) + money.paise(extras.total);
      if (advances + taken.amount > expected) fail(`An advance is money on account for the stay: at most ${money.rupees(Math.max(0, expected - advances))} more`);
    }
    await takeReceipt(db, business, user, stay, { purpose, ...taken, requestKey, hash });
    return shape(business, await load(db, business, stay.id));
  });
}

// --- Policies ------------------------------------------------------------------------------------------------

// What the stay's policy charges now, worked out from its room nights (after its discount, before GST) and the
// property's check-in and check-out times on the business's clock: a cancellation now (free until the window, then
// its nights or percentage; the full stay when its plan is not refundable), a no-show, an early check-in now, a
// late check-out now, and the deposit it asks with the date it is due by. null until the slabs are set.
async function policyNow(db, business, stay) {
  const lodging = await c.settingsOf(db, business.id);
  if (!lodging.low_tax_rate_id) return null;
  const rows = await nightRows(db, business, stay.id);
  if (!rows.length) return null;
  const settings = c.slabsOf(lodging);
  const priced = rows.map((r) => money.priceRow(r, partyOf(stay), settings, stay.discount_percent));
  const values = priced.map((n) => n.amount);
  const times = await repo.one(db, `SELECT EXTRACT(EPOCH FROM ((($1::date + $2::time) AT TIME ZONE $5) - now()))/3600 AS hours_before,
      now() < (($1::date + $2::time) AT TIME ZONE $5) AS before_check_in,now() > (($3::date + $4::time) AT TIME ZONE $5) AS after_check_out,
      (s.created_at AT TIME ZONE $5)::date::text AS booked_on
    FROM lodging_stays s WHERE s.business_id=$6 AND s.id=$7`,
  [c.dayOf(stay.arrival), lodging.check_in_time, c.dayOf(stay.departure), lodging.check_out_time, business.timezone || 'Asia/Kolkata', business.id, stay.id]);
  const p = stay.policy || null;
  const first = priced[0], last = priced[priced.length - 1];
  const cancelled = money.cancelCharge(p, values, Number(times.hours_before));
  const noShow = money.noShowCharge(p, values);
  const dayUse = Boolean(stay.day_use);
  const early = !dayUse && p?.earlyKind && times.before_check_in ? money.timeCharge(p.earlyKind, p.earlyValue, first.amount) : 0;
  const late = !dayUse && p?.lateKind && times.after_check_out ? money.timeCharge(p.lateKind, p.lateValue, last.amount) : 0;
  const deposit = money.depositDue(p, { total: money.paise(stay.estimate_total), firstNight: first.amount + first.tax + first.meal + first.mealTax });
  const by = p?.depositKind ? [c.addDays(c.dayOf(stay.arrival), -Number(p.depositDays)), times.booked_on].sort().at(-1) : null;
  const taken = (await receiptsOf(db, business, stay.id)).reduce((s, r) => s + money.paise(r.amount), 0);
  const withTax = (amount, slab) => ({ amount, tax: money.taxOn(amount, slab.rate), taxRate: Number(slab.rate), slab });
  return {
    policy: p, checkInTime: c.hhmm(lodging.check_in_time), checkOutTime: c.hhmm(lodging.check_out_time), hoursBefore: Number(times.hours_before),
    cancel: { ...withTax(cancelled.amount, first.slab), rule: cancelled.rule }, noShow: { ...withTax(noShow.amount, first.slab), rule: noShow.rule },
    early: { ...withTax(early, first.slab), now: Boolean(times.before_check_in) && !dayUse, night: first.night },
    late: { ...withTax(late, last.slab), now: Boolean(times.after_check_out) && !dayUse, night: last.night },
    deposit: { amount: deposit, by, taken, short: Math.max(0, deposit - taken) },
  };
}
const policyText = (terms) => (terms ? {
  policy: terms.policy, checkInTime: terms.checkInTime, checkOutTime: terms.checkOutTime,
  ...Object.fromEntries(['cancel', 'noShow', 'early', 'late'].map((k) => [k, { amount: money.rupees(terms[k].amount), tax: money.rupees(terms[k].tax), taxRate: terms[k].taxRate.toFixed(2),
    ...(terms[k].rule !== undefined ? { rule: terms[k].rule } : {}), ...(terms[k].now !== undefined ? { now: terms[k].now } : {}) }])),
  deposit: { amount: money.rupees(terms.deposit.amount), by: terms.deposit.by, taken: money.rupees(terms.deposit.taken), short: money.rupees(terms.deposit.short) },
} : null);
// A policy's charge waived by a manager: lodging.approve, the manager's own or with their PIN. body: { reason, approverId?, pin? }.
async function readWaiver(business, user, value) {
  if (value === undefined || value === null) return null;
  return pins().readApproval(business, user, value, 'lodging.approve', { reasonLabel: 'Reason for waiving the charge', selfWithoutPin: true });
}
// A waiver as the request hash keeps it (never the PIN).
const waiverKey = (value) => (value ? { reason: value.reason, approverId: value.approverId } : undefined);
// A charge the policy worked out and a manager waived: written down, audited.
async function recordWaiver(db, business, user, stay, { charge, amount, waiver }) {
  const words = { early_check_in: 'Early check-in charge', late_check_out: 'Late check-out charge', cancellation: 'Cancellation charge', no_show: 'No-show charge' };
  await history(db, business, user, stay, null, null, `${words[charge]} of ${money.rupees(amount)} waived by ${waiver.approver.name}: ${waiver.reason}`);
  await repo.audit(db, business.id, waiver.approver.id, 'lodging_policy.waived', stay.id, { stayNo: stay.stay_no, charge, amount: money.rupees(amount), reason: waiver.reason,
    approvedBy: waiver.approver.name, askedBy: user.id });
}

// body: { requestKey, reason, noShow?: true (the arrival day has come and the guest did not), charge?: amount (only for a stay booked under no policy:
//   before GST), waiver?: { reason, approverId?, pin? } (the policy's charge waived by a manager), payment? | payments? (the rest of that bill),
//   refund?: { method | methodId, reference? } (what is left held, handed back), approval?: { approverId?, pin? } (with a refund), buyer? }
// The charge is the stay's policy's, billed with GST as the room type's nights at the slab of the first night.
async function cancel(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.cancel');
  const requestKey = core.uuid(body.requestKey);
  const reason = v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Reason', 300);
  const noShow = v.requiredBoolean(body.noShow, 'No-show', false);
  const typed = c.given(body.charge) ? money.paise(core.decimal(body.charge, 'Cancellation charge', 2, 0, 10000000)) : null;
  const parts = core.readPayments(body);
  if (parts.length) await access.require(business, 'sales.edit');
  const how = body.refund ? readBack(body.refund) : null;
  if (how) await access.require(business, 'lodging.refund');
  // A manager's PIN is checked before the transaction (a PIN check holds no locks).
  const approval = how ? await pins().readApproval(business, user, { ...(body.approval || {}), reason: `${noShow ? 'No-show' : 'Reservation cancelled'}: ${reason}`.slice(0, 300) },
    'lodging.refund', { reasonLabel: 'Reason' }) : null;
  const waiver = await readWaiver(business, user, body.waiver);
  const hash = c.hashOf({ ...body, approval: undefined, waiver: waiverKey(body.waiver), stayId: String(stayId) });
  return repo.transaction(async (db) => {
    const stay = await lockStay(db, business, stayId);
    if (stay.cancel_key) {
      if (stay.cancel_key !== requestKey || stay.cancel_hash !== hash) fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]} already`, 409);
      return shape(business, await load(db, business, stay.id));
    }
    if (stay.status !== 'reserved') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: ${stay.status === 'in_house' ? 'a guest in the house checks out instead' : 'it no longer changes'}`, 409);
    const today = await c.today(db, business);
    if (noShow && today < c.dayOf(stay.arrival)) fail(`Stay ${stay.stay_no} arrives on ${c.dateWords(stay.arrival)}: a guest is a no-show once the arrival day has come; cancel it instead`, 409);
    // The charge: the policy's, worked out (a manager may waive it); typed only for a stay booked under no policy.
    const terms = await policyNow(db, business, stay);
    let charge = typed || 0;
    if (stay.policy) {
      const worked = noShow ? terms.noShow : terms.cancel;
      if (typed !== null && typed !== worked.amount) {
        fail(`The ${noShow ? 'no-show' : 'cancellation'} charge is worked out by the stay's policy: ${money.rupees(worked.amount)} before GST. A manager may waive it.`, 409, { reason: 'policy_charge' });
      }
      charge = worked.amount;
      if (waiver && charge > 0) {
        await recordWaiver(db, business, user, stay, { charge: noShow ? 'no_show' : 'cancellation', amount: charge, waiver });
        charge = 0;
      }
    } else if (waiver) fail(`Stay ${stay.stay_no} was booked under no policy: there is no charge to waive`, 409);
    if (charge > 0) await access.require(business, 'sales.create');
    if (parts.length && !charge) fail('A payment goes with a cancellation charge: there is nothing else to pay');
    let bill = null;
    if (charge > 0) {
      // What the property keeps is billed with GST as the room's nights, at the slab of the first night booked.
      const first = { slab: terms.cancel.slab };
      const type = await repo.one(db, `SELECT t.sku_id,s.label AS name FROM lodging_room_types t JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id
        WHERE t.business_id=$1 AND t.id=$2`, [business.id, stay.room_type_id]);
      const tax = money.taxOn(charge, first.slab.rate);
      const label = `${noShow ? 'No-show charge' : 'Cancellation charge'} · ${type.name} · ${stay.stay_no}`.slice(0, 150);
      const row = await repo.one(db, `INSERT INTO lodging_charges(business_id,stay_id,kind,night,sku_id,label,quantity,unit_price,amount,tax_mode,tax_rate_id,tax_rate,net,tax,note,request_key,created_by)
        VALUES($1,$2,'cancellation',$3,$4,$5,1,$6,$6,'exclusive',$7,$8,$6,$9,$10,$11,$12) RETURNING *`,
      [business.id, stay.id, today, type.sku_id, label, money.rupees(charge), first.slab.id, Number(first.slab.rate).toFixed(2), money.rupees(tax), reason, c.derivedKey(requestKey, 'charge'), user.id]);
      bill = await postBill(db, business, user, stay, { values: [{ skuId: type.sku_id, quantity: 1, net: charge, tax, taxRate: first.slab.rate, label }], contactId: stay.contact_id,
        parts, buyer: body.buyer, key: requestKey, hash, notes: `Stay ${stay.stay_no} · ${noShow ? 'no-show' : 'cancelled'} · ${reason}` });
      await db.query('UPDATE lodging_charges SET line_id=$3 WHERE business_id=$1 AND id=$2', [business.id, row.id, bill.lineIds[0]]);
    }
    const status = noShow ? 'no_show' : 'cancelled';
    await db.query(`UPDATE lodging_stays SET status=$3,cancelled_at=now(),cancelled_by=$4,cancel_reason=$5,cancel_key=$6,cancel_hash=$7,document_id=$8,updated_by=$4,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, stay.id, status, user.id, reason, requestKey, hash, bill?.document.id || null]);
    const back = how ? await refundLeft(db, business, user, stay, { how, approval, key: requestKey }) : [];
    await history(db, business, user, stay, 'reserved', status, [reason, bill ? `${noShow ? 'no-show' : 'cancellation'} charge billed (${bill.document.document_no})` : null,
      back.length ? `${money.rupees(back.reduce((s, r) => s + money.paise(r.amount), 0))} handed back (${back.map((r) => r.refund_no).join(', ')})` : null].filter(Boolean).join(' · '));
    const details = { stayNo: stay.stay_no, reason, noShow, documentNo: bill?.document.document_no || null, charged: bill ? bill.document.total : null,
      refunded: back.map((r) => ({ refundNo: r.refund_no, amount: r.amount, purpose: r.purpose })), ...(approval ? { approvedBy: approval.approver.name } : {}) };
    await repo.audit(db, business.id, approval?.approver.id || user.id, noShow ? 'lodging_stay.no_show' : 'lodging_stay.cancelled', stay.id, details);
    await repo.event(db, business.id, user.id, noShow ? 'lodging_stay.no_show' : 'lodging_stay.cancelled', 'lodging_stay', stay.id, { ...details, documentId: bill?.document.id || null });
    return shape(business, await load(db, business, stay.id));
  });
}

// What is left of the advances and deposits of a stay that has ended, handed back (deposits first) by cash, UPI or
// bank, with a reason and a manager's PIN (lodging.refund): a numbered refund of each receipt.
// body: { requestKey, amount? (all that is left), method | methodId, reference?, reason, approverId?, pin? }
async function refundHeld(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.refund');
  const requestKey = core.uuid(body.requestKey);
  const amount = c.given(body.amount) ? money.paise(core.decimal(body.amount, 'Amount to hand back', 2, 0.01, 10000000)) : null;
  const how = readBack(body);
  const approval = await pins().readApproval(business, user, body, 'lodging.refund', { reasonLabel: 'Reason for handing it back' });
  return repo.transaction(async (db) => {
    const stay = await lockStay(db, business, stayId);
    if (!['checked_out', 'cancelled', 'no_show'].includes(stay.status)) {
      fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: its advance and deposit are held until it ends, and then pay its bill first`, 409);
    }
    const made = await refundLeft(db, business, user, stay, { amount, how, approval, key: requestKey });
    if (!made.length) fail(`Nothing is held for stay ${stay.stay_no} to hand back`, 409);
    const fresh = made.filter((r) => !r.repeated);
    if (fresh.length) {
      await history(db, business, user, stay, null, null, `${money.rupees(fresh.reduce((s, r) => s + money.paise(r.amount), 0))} handed back (${fresh.map((r) => r.refund_no).join(', ')}) — ${approval.reason}`);
    }
    return { refunds: made, repeated: !fresh.length, stay: shape(business, await load(db, business, stay.id)) };
  });
}

// --- Reading a stay ---------------------------------------------------------------------------------------------

async function load(db, business, stayId) {
  const s = await repo.one(db, `SELECT s.*,l.name AS location_name,to_jsonb(l) AS location,ts.label AS room_type,t.max_occupancy,t.max_extra_beds,r.room_no,r.floor,r.status AS room_status,
      bt.name AS bill_to_name,bt.gstin AS bill_to_gstin,ct.gstin AS guest_gstin,ct.credit_days,ct.credit_limit,cu.name AS created_by_name,ci.name AS checked_in_by_name,
      co.name AS checked_out_by_name,ca.name AS cancelled_by_name,d.document_no,(now() AT TIME ZONE z.timezone)::date::text AS today
    FROM lodging_stays s JOIN businesses z ON z.id=s.business_id JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id
    JOIN lodging_room_types t ON t.business_id=s.business_id AND t.id=s.room_type_id JOIN catalog_skus ts ON ts.business_id=t.business_id AND ts.id=t.sku_id
    LEFT JOIN lodging_rooms r ON r.business_id=s.business_id AND r.id=s.room_id LEFT JOIN business_contacts bt ON bt.business_id=s.business_id AND bt.id=s.bill_to_contact_id
    JOIN business_contacts ct ON ct.business_id=s.business_id AND ct.id=s.contact_id JOIN users cu ON cu.id=s.created_by LEFT JOIN users ci ON ci.id=s.checked_in_by
    LEFT JOIN users co ON co.id=s.checked_out_by LEFT JOIN users ca ON ca.id=s.cancelled_by LEFT JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.document_id
    WHERE s.business_id=$1 AND s.id=$2`, [business.id, stayId]);
  if (!s) fail('Stay not found', 404);
  access.requireLocation(business, s.location_id);
  // One query at a time: `db` may be a transaction's own client.
  const guests = await repo.all(db, `SELECT g.*,ua.name AS frro_arrival_by_name,ud.name AS frro_departure_by_name FROM lodging_stay_guests g
    LEFT JOIN users ua ON ua.id=g.frro_arrival_by LEFT JOIN users ud ON ud.id=g.frro_departure_by WHERE g.business_id=$1 AND g.stay_id=$2 ORDER BY g.seq`, [business.id, s.id]);
  const charges = await repo.all(db, `SELECT ch.*,rm.room_no,u.name AS by_name,vu.name AS voided_by_name,dl.document_id AS line_document_id
    FROM lodging_charges ch LEFT JOIN lodging_rooms rm ON rm.business_id=ch.business_id AND rm.id=ch.room_id JOIN users u ON u.id=ch.created_by LEFT JOIN users vu ON vu.id=ch.voided_by
    LEFT JOIN business_document_lines dl ON dl.business_id=ch.business_id AND dl.id=ch.line_id
    WHERE ch.business_id=$1 AND ch.stay_id=$2 ORDER BY ch.kind<>'room_night',ch.night,ch.id`, [business.id, s.id]);
  const receipts = await repo.all(db, `SELECT r.purpose,k.id,k.collection_no,k.amount,k.method,k.method_name,k.reference,k.created_at,${c.FREE_SQL('k')} AS free,
      COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=k.business_id AND p.collection_id=k.id),0) AS used,
      COALESCE((SELECT sum(f.amount) FROM business_collection_refunds f WHERE f.business_id=k.business_id AND f.collection_id=k.id),0) AS refunded,
      COALESCE((SELECT json_agg(json_build_object('id',f.id,'refund_no',f.refund_no,'amount',f.amount::text,'method',f.method,'method_name',f.method_name,'reference',f.reference,
        'reason',f.reason,'created_at',f.created_at,'approved_by_name',a.name) ORDER BY f.id) FROM business_collection_refunds f JOIN users a ON a.id=f.approved_by
        WHERE f.business_id=k.business_id AND f.collection_id=k.id),'[]') AS refunds
    FROM lodging_receipts r JOIN business_collections k ON k.business_id=r.business_id AND k.id=r.collection_id WHERE r.business_id=$1 AND r.stay_id=$2 ORDER BY k.id`, [business.id, s.id]);
  const events = await repo.all(db, `SELECT e.id,e.from_status,e.to_status,e.note,e.created_at,u.name AS by_name FROM lodging_stay_events e JOIN users u ON u.id=e.created_by
    WHERE e.business_id=$1 AND e.stay_id=$2 ORDER BY e.id`, [business.id, s.id]);
  const bill = s.document_id ? await repo.one(db, `SELECT d.id,d.document_no,d.total,d.created_at,d.contact_name,d.buyer_gstin,d.place_of_supply,
      COALESCE((SELECT sum(total) FROM business_returns r WHERE r.business_id=d.business_id AND r.document_id=d.id),0) AS returned,
      COALESCE((SELECT sum(amount) FROM business_payments p WHERE p.business_id=d.business_id AND p.document_id=d.id),0) AS paid,
      COALESCE((SELECT sum(amount) FROM business_refunds f WHERE f.business_id=d.business_id AND f.document_id=d.id),0) AS refunded,${c.DUE_SQL('d')} AS due
    FROM business_documents d WHERE d.business_id=$1 AND d.id=$2`, [business.id, s.document_id]) : null;
  const settings = await repo.one(db, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const lodging = await c.settingsOf(db, business.id);
  const sum = (list, key) => list.reduce((x, r) => x + money.paise(r[key]), 0);
  const of = (purpose) => receipts.filter((r) => r.purpose === purpose);
  const deposit = { collected: money.rupees(sum(of('deposit'), 'amount')), applied: money.rupees(sum(of('deposit'), 'used')), refunded: money.rupees(sum(of('deposit'), 'refunded')),
    held: money.rupees(sum(of('deposit'), 'free')) };
  const advance = { taken: money.rupees(sum(of('advance'), 'amount')), applied: money.rupees(sum(of('advance'), 'used')), refunded: money.rupees(sum(of('advance'), 'refunded')),
    left: money.rupees(sum(of('advance'), 'free')) };
  // Each night of the stay (or its day use): posted (its charge) or still to post (priced at the rates it keeps, when the slabs are set), with its meals.
  let nights = [];
  if (['reserved', 'in_house'].includes(s.status) && lodging.low_tax_rate_id) {
    const est = await priceNights(db, business, await nightRows(db, business, s.id), partyOf(s), s.discount_percent);
    nights = est.nights.map((n) => {
      const posted = charges.find((x) => ['room_night', 'day_use'].includes(x.kind) && !x.voided_at && x.night === n.night);
      const meal = charges.find((x) => x.kind === 'meal' && !x.voided_at && x.night === n.night);
      return posted ? { night: n.night, posted: true, charge_id: posted.id, rate_kind: posted.rate_kind, value: money.rupees(money.paise(posted.amount) + money.paise(posted.discount || 0)),
        discount: posted.discount, amount: posted.amount, tax_rate: posted.tax_rate, tax: posted.tax, meals: meal ? meal.amount : null, billed: Boolean(posted.line_id) }
        : { night: n.night, posted: false, rate_kind: n.rateKind, weekend: n.weekend, room_rate: money.rupees(n.roomRate), value: money.rupees(n.value), discount: money.rupees(n.discount),
          amount: money.rupees(n.amount), tax_rate: Number(n.slab.rate).toFixed(2), tax: money.rupees(n.tax), meals: n.meal ? money.rupees(n.meal) : null,
          meals_tax: n.meal ? money.rupees(n.mealTax) : null, billed: false, due: n.night <= s.today };
    });
  }
  // The plan, the policy's charges now, the group, the folios beyond the main one with their routing and bills, and the guest's profile.
  const plan = s.rate_plan_id ? await repo.one(db, `SELECT p.id,p.name,p.meal_plan,p.refundable,k.label AS meal_item FROM lodging_rate_plans p
    LEFT JOIN catalog_skus k ON k.business_id=p.business_id AND k.id=p.meal_sku_id WHERE p.business_id=$1 AND p.id=$2`, [business.id, s.rate_plan_id]) : null;
  const policyCharges = ['reserved', 'in_house'].includes(s.status) ? policyText(await policyNow(db, business, s)) : null;
  const group = s.group_id ? await repo.one(db, 'SELECT id,group_no,name,contact_id FROM lodging_groups WHERE business_id=$1 AND id=$2', [business.id, s.group_id]) : null;
  const folios = await repo.all(db, `SELECT f.id,f.name,f.stay_id,f.group_id,f.contact_id,k.name AS contact_name,k.gstin,f.document_id,d.document_no,d.total,f.billed_at,
      CASE WHEN d.id IS NULL THEN 0 ELSE GREATEST(0,${c.DUE_SQL('d')}) END AS due
    FROM lodging_folios f JOIN business_contacts k ON k.business_id=f.business_id AND k.id=f.contact_id LEFT JOIN business_documents d ON d.business_id=f.business_id AND d.id=f.document_id
    WHERE f.business_id=$1 AND (f.stay_id=$2 OR (f.group_id IS NOT NULL AND f.group_id=$3)) ORDER BY f.group_id IS NULL,f.id`, [business.id, s.id, s.group_id]);
  const routes = Object.fromEntries((await repo.all(db, 'SELECT category,folio_id FROM lodging_routes WHERE business_id=$1 AND stay_id=$2', [business.id, s.id])).map((r) => [r.category, r.folio_id]));
  const profile = await repo.one(db, 'SELECT preferences,notes FROM lodging_guest_profiles WHERE business_id=$1 AND contact_id=$2', [business.id, s.contact_id]);
  // The folio so far: the charges posted and not voided, and the nights still to post.
  const live = charges.filter((x) => !x.voided_at);
  const toPost = nights.filter((n) => !n.posted);
  const folio = { posted: money.rupees(live.reduce((x, r) => x + money.paise(r.net) + money.paise(r.tax), 0)),
    to_post: money.rupees(toPost.reduce((x, n) => x + money.paise(n.amount) + money.paise(n.tax), 0)),
    unbilled: money.rupees(live.filter((x) => !x.line_id).reduce((x, r) => x + money.paise(r.net) + money.paise(r.tax), 0)),
    held: money.rupees(sum(receipts, 'free')) };
  const { request_hash: _hash, checkin_hash: _checkin, checkout_hash: _checkout, cancel_hash: _cancel, location, ...rest } = s;
  return {
    ...rest, arrival: c.dayOf(s.arrival), departure: c.dayOf(s.departure), nights_count: money.nightCount(c.dayOf(s.arrival), c.dayOf(s.departure)),
    guests, charges, nights, folio, receipts, deposit, advance_summary: advance, bill, events, terms: lodging.terms, slabs_ready: Boolean(lodging.low_tax_rate_id),
    plan, policy_charges: policyCharges, group, folios, routes, profile, check_in_time: c.hhmm(lodging.check_in_time), check_out_time: c.hhmm(lodging.check_out_time),
    seller: core.branchSeller(settings, location), timezone: business.timezone,
  };
}

async function detail(business, stayId) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  return shape(business, await load(repo.pool, business, id(stayId, 'Stay')));
}

// The receipts a guest's stays hold (advances and deposits): they pay only their stay's bill, and what is left goes
// back from the stay, so "apply advance" in the customer's dues leaves them alone.
async function heldReceipts(db, business, contactId) {
  const rows = await repo.all(db, `SELECT r.collection_id FROM lodging_receipts r JOIN business_collections k ON k.business_id=r.business_id AND k.id=r.collection_id
    WHERE r.business_id=$1 AND k.contact_id=$2`, [business.id, contactId]);
  return new Set(rows.map((r) => Number(r.collection_id)));
}

// Who may approve: rates changed for a guest in the house, a charge voided, a bill left to pay (lodging.approve); money
// handed back (lodging.refund). Members whose role holds it, with whether they have a PIN.
const APPROVALS = ['lodging.approve', 'lodging.refund'];
async function approvers(business, query = {}) {
  c.requireLodging(business);
  const permission = query.permission === undefined ? 'lodging.refund' : String(query.permission);
  if (!APPROVALS.includes(permission)) fail('Unknown approval');
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code=$2))
    ORDER BY u.name`, [business.id, permission]);
}

module.exports = { STAYS_SQL, shape, listShape, withoutMoney, readNights, readParty, roomTypeOf, typeRates, checkParty, roomFor, roomClash, clashWords, typeFull, fullWords, priceNights,
  nightText, preview, takeReceipt, readMoney, receiptsOf, applyReceipts, refundLeft, readBack, partsAfterHeld, postBill, history, lockStay, billToOf, posting, create, update,
  receive, cancel, refundHeld, load, detail, heldReceipts, approvers, partyOf, nightRows, policyNow, readWaiver, waiverKey, recordWaiver, readGuest, guestContact, readReservation,
  reserveIn };
