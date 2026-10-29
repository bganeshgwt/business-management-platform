const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
const money = require('./lodgingMoney');
const stays = require('./lodgingStays.service');
const folio = require('./lodgingFolio.service');

// Occupants joining and leaving partway, and guest profiles (module "lodging").
//
//   joining   an occupant joins a stay in the house: recorded as at check-in
//             (their photo ID; a foreigner's passport and visa, their Form-III
//             countdown from now), kept for the register with when they came.
//             The stay's adults or children grow by one, so its nights still to
//             post are priced for them (an extra adult at the night's rate).
//   leaving   an occupant leaves partway (never the last adult): their
//             departure kept for the register (a foreigner's Form-III
//             departure countdown starts); the nights still to post are priced
//             for those left.
//   profiles  a guest's preferences and the desk's notes, kept with their
//             contact, with their past stays.

const { fail, id } = c;

// The stay's party changed in the house: its nights still to post priced again, those posted as they were. Returns the estimate (paise).
async function estimateInHouse(db, business, stay, party) {
  const priced = await stays.priceNights(db, business, await stays.nightRows(db, business, stay.id), { ...party, baseOccupancy: Number(stay.base_occupancy) }, stay.discount_percent);
  const posted = await repo.all(db, `SELECT night::text AS night,kind,net,tax FROM lodging_charges WHERE business_id=$1 AND stay_id=$2 AND kind IN ('room_night','meal','day_use')
    AND voided_at IS NULL`, [business.id, stay.id]);
  let subtotal = 0, tax = 0;
  for (const n of priced.nights) {
    const room = posted.find((p) => p.night === n.night && p.kind !== 'meal');
    const meal = posted.find((p) => p.night === n.night && p.kind === 'meal');
    subtotal += room ? money.paise(room.net) + (meal ? money.paise(meal.net) : 0) : n.net + n.meal;
    tax += room ? money.paise(room.tax) + (meal ? money.paise(meal.tax) : 0) : n.tax + n.mealTax;
  }
  return { subtotal, tax, total: subtotal + tax };
}
async function setParty(db, business, user, stay, party) {
  const est = await estimateInHouse(db, business, stay, party);
  await db.query('UPDATE lodging_stays SET adults=$3,children=$4,estimate_subtotal=$5,estimate_tax=$6,estimate_total=$7,updated_by=$8,updated_at=now() WHERE business_id=$1 AND id=$2',
    [business.id, stay.id, party.adults, party.children, money.rupees(est.subtotal), money.rupees(est.tax), money.rupees(est.total), user.id]);
}

// body: { requestKey, guest: { fullName, child?, … as at check-in } } — an occupant joining a stay in the house.
async function join(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const requestKey = core.uuid(body.requestKey);
  return stays.posting(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    const old = await repo.one(db, 'SELECT id,stay_id FROM lodging_stay_guests WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (Number(old.stay_id) !== Number(stay.id)) fail('This request key was already used for different data', 409);
      return stays.shape(business, await stays.load(db, business, stay.id));
    }
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: an occupant joins a stay in the house`, 409);
    const today = await c.today(db, business);
    const seq = (await repo.one(db, 'SELECT COALESCE(max(seq),0)::int+1 AS n FROM lodging_stay_guests WHERE business_id=$1 AND stay_id=$2', [business.id, stay.id])).n;
    const guest = folio.readGuest(body.guest, seq - 1, today);
    const type = await stays.roomTypeOf(db, business, stay.room_type_id);
    const party = { adults: Number(stay.adults) + (guest.child ? 0 : 1), children: Number(stay.children) + (guest.child ? 1 : 0), extraBeds: Number(stay.extra_beds) };
    if (party.adults + party.children > Number(type.max_occupancy)) fail(`${type.name} takes at most ${type.max_occupancy} guests: move the stay to a larger room first`, 409);
    if (party.adults > Number(stay.base_occupancy) && stay.extra_adult_rate === null) fail(`${type.name}'s rate is for ${c.plural(Number(stay.base_occupancy), 'adult')}, and it takes no extra adult`, 409);
    await db.query(`INSERT INTO lodging_stay_guests(business_id,stay_id,seq,${folio.GUEST_COLUMNS},created_by,updated_by,request_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19)`, [business.id, stay.id, seq, ...folio.guestValues(guest), user.id, requestKey]);
    await setParty(db, business, user, stay, party);
    await stays.history(db, business, user, stay, null, null, `${guest.fullName} joined the stay${guest.child ? ' (a child)' : ''}${guest.foreigner ? ': Form-III due within 24 hours' : ''}`);
    const details = { stayNo: stay.stay_no, guest: guest.fullName, child: guest.child, foreigner: guest.foreigner, adults: party.adults, children: party.children };
    await repo.audit(db, business.id, user.id, 'lodging_guest.joined', stay.id, details);
    await repo.event(db, business.id, user.id, 'lodging_guest.joined', 'lodging_stay', stay.id, details);
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// body: { reason? } — an occupant leaving a stay in the house partway (never the last adult).
async function leave(business, user, stayId, guestId, body = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const reason = c.optionalText(body.reason, 'Reason', 300);
  return stays.posting(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    const guest = await repo.one(db, 'SELECT * FROM lodging_stay_guests WHERE business_id=$1 AND stay_id=$2 AND id=$3 FOR UPDATE', [business.id, stay.id, id(guestId, 'Occupant')]);
    if (!guest) fail('Occupant not found', 404);
    if (guest.departed_at) return stays.shape(business, await stays.load(db, business, stay.id));
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: an occupant leaves partway while the stay is in the house`, 409);
    const party = { adults: Number(stay.adults) - (guest.child ? 0 : 1), children: Number(stay.children) - (guest.child ? 1 : 0), extraBeds: Number(stay.extra_beds) };
    if (party.adults < 1) fail(`${guest.full_name} is the last adult in the room: check the stay out instead`, 409);
    await db.query('UPDATE lodging_stay_guests SET departed_at=now(),updated_by=$3,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, guest.id, user.id]);
    await setParty(db, business, user, stay, party);
    await stays.history(db, business, user, stay, null, null, `${guest.full_name} left the stay${reason ? `: ${reason}` : ''}${guest.foreigner ? ' · Form-III departure due within 24 hours' : ''}`);
    const details = { stayNo: stay.stay_no, guest: guest.full_name, child: guest.child, reason, adults: party.adults, children: party.children };
    await repo.audit(db, business.id, user.id, 'lodging_guest.left', stay.id, details);
    await repo.event(db, business.id, user.id, 'lodging_guest.left', 'lodging_stay', stay.id, details);
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// --- Guest profiles ------------------------------------------------------------------------------------------

async function customerOf(db, business, contactId) {
  const contact = await repo.one(db, "SELECT id,name,phone,gstin,active FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Guest')]);
  if (!contact) fail('Guest not found', 404);
  return contact;
}
// A guest's profile: their preferences and notes, and their stays (as the guest who booked, or as an occupant by the same name), newest first.
async function profile(business, contactId) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const contact = await customerOf(repo.pool, business, contactId);
  const saved = await repo.one(repo.pool, `SELECT g.preferences,g.notes,g.updated_at,u.name AS updated_by_name FROM lodging_guest_profiles g JOIN users u ON u.id=g.updated_by
    WHERE g.business_id=$1 AND g.contact_id=$2`, [business.id, contact.id]);
  const past = await repo.all(repo.pool, `SELECT x.id,x.stay_no,x.status,x.stage,x.arrival,x.departure,x.nights,x.room_type,x.room_no,x.location_name,x.estimate_total,x.day_use
    FROM (${stays.STAYS_SQL}) x WHERE x.contact_id=$2 AND ($3::bigint IS NULL OR x.location_id=$3) ORDER BY x.arrival DESC,x.id DESC LIMIT 100`,
  [business.id, contact.id, business.location_scope || null]);
  const items = c.seesMoney(business) ? past : past.map((s) => ({ ...s, estimate_total: null }));
  return { contact, preferences: saved?.preferences || null, notes: saved?.notes || null, updatedAt: saved?.updated_at || null, updatedBy: saved?.updated_by_name || null,
    stays: items, counts: { stays: past.filter((s) => s.status === 'checked_out').length, nights: past.filter((s) => s.status === 'checked_out' && !s.day_use).reduce((n, s) => n + Number(s.nights), 0) } };
}

// body: { preferences?, notes? } — what is left out stays; empty clears it.
async function saveProfile(business, user, contactId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  await repo.transaction(async (db) => {
    const contact = await customerOf(db, business, contactId);
    const before = await repo.one(db, 'SELECT preferences,notes FROM lodging_guest_profiles WHERE business_id=$1 AND contact_id=$2 FOR UPDATE', [business.id, contact.id]);
    const preferences = body.preferences === undefined ? before?.preferences || null : c.optionalText(body.preferences, 'Preferences', 1000);
    const notes = body.notes === undefined ? before?.notes || null : c.optionalText(body.notes, 'Notes', 2000);
    await db.query(`INSERT INTO lodging_guest_profiles(business_id,contact_id,preferences,notes,updated_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (business_id,contact_id) DO UPDATE SET preferences=EXCLUDED.preferences,notes=EXCLUDED.notes,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [business.id, contact.id, preferences, notes, user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_guest_profile.saved', contact.id, { guest: contact.name, preferences: preferences !== (before?.preferences || null), notes: notes !== (before?.notes || null) });
  });
  return profile(business, contactId);
}

module.exports = { join, leave, profile, saveProfile, estimateInHouse };
