const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
const stays = require('./lodgingStays.service');
const folio = require('./lodgingFolio.service');

// A guest moved to another property of the business mid-stay (module "lodging"):
// a check-out at the one and a check-in at the other, linked. The folio is
// billed, not carried: each property's nights are billed on its own GST
// invoice, from that property (its GSTIN, and its state the place of supply),
// so GST stays per property. What is left of the advances and deposits held
// for the first stay carries on and pays the new stay's bill. The same guest,
// party, source and company billed; the new stay arrives today, on the other
// property's rates and rooms; its occupants are recorded again there (their
// Form-III arrival is due again for that property). No late check-out at the
// one and no early check-in at the other.

const { fail, id } = c;

// An occupant as the check-in takes them, from their record.
const occupantOf = (g) => ({ fullName: g.full_name, child: g.child, foreigner: g.foreigner, nationality: g.nationality, gender: g.gender || undefined,
  age: g.age === null ? undefined : g.age, phone: g.phone || undefined, address: g.address || undefined, idKind: g.id_kind || undefined, idRef: g.id_ref || undefined,
  visaType: g.visa_type || undefined, visaNo: g.visa_no || undefined, arrivedIndiaOn: g.arrived_india_on ? c.dayOf(g.arrived_india_on) : undefined,
  nextDestination: g.next_destination || undefined });

// body: { requestKey, locationId (the other property), roomTypeId, roomId, ratePlanId?, departure? (the stay's when left out), agreedRate?, extraBeds?,
//   notes?, payment? | payments? (the rest of this property's bill), folioPayments?, buyer? } — returns the new stay.
async function moveProperty(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  await access.require(business, 'sales.create');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf({ ...body, stayId: String(stayId) });
  const locationId = id(body.locationId, 'Property');
  access.requireLocation(business, locationId);
  if (!c.given(body.roomId)) fail('Choose the room the guest moves to');
  const asked = await folio.readCheckout(business, user, { payment: body.payment, payments: body.payments, folioPayments: body.folioPayments });
  const agreed = c.readRate(body.agreedRate, 'The agreed rate');
  return stays.posting(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    if (stay.checkout_key) {
      if (stay.checkout_key !== requestKey || stay.checkout_hash !== hash) fail(`Stay ${stay.stay_no} is checked out already`, 409);
      const next = await repo.one(db, 'SELECT id FROM lodging_stays WHERE business_id=$1 AND moved_from_stay_id=$2', [business.id, stay.id]);
      if (!next) fail(`Stay ${stay.stay_no} is checked out already`, 409);
      return stays.shape(business, await stays.load(db, business, next.id));
    }
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: a guest in the house moves to another property`, 409);
    if (stay.day_use) fail(`Stay ${stay.stay_no} is a day use: it stays at its property`, 409);
    if (stay.group_id) fail(`Stay ${stay.stay_no} is one of a group's: a group's rooms stay at its property`, 409);
    if (Number(locationId) === Number(stay.location_id)) fail('The guest is at that property already: move them to another room instead', 409);
    const places = await repo.all(db, 'SELECT id,name,active FROM business_locations WHERE business_id=$1 AND id IN ($2,$3)', [business.id, stay.location_id, locationId]);
    const here = places.find((l) => Number(l.id) === Number(stay.location_id));
    const there = places.find((l) => Number(l.id) === Number(locationId));
    if (!there || !there.active) fail('Property not found', 404);
    const today = await c.today(db, business);
    if (today <= c.dayOf(stay.arrival)) {
      fail(`Stay ${stay.stay_no} arrived today: a guest moves to another property from their second day; until then change their room here, or cancel and book there`, 409);
    }
    const departure = c.given(body.departure) ? c.readDate(body.departure, 'Departure') : c.dayOf(stay.departure);
    if (departure <= today) fail('The stay at the other property is one night at least: give it a departure after today');
    // The occupants in the room now, to be recorded at the other property.
    const guests = await repo.all(db, 'SELECT * FROM lodging_stay_guests WHERE business_id=$1 AND stay_id=$2 AND departed_at IS NULL ORDER BY seq', [business.id, stay.id]);
    // The check-out here: every folio billed with this property's GST.
    await folio.checkOutIn(db, business, user, stay, { buyer: body.buyer }, { requestKey, hash, ...asked, how: null, approval: null, waiver: null, moving: true });
    // The stay there, for the same guest and party, continuing this one.
    const contact = await repo.one(db, 'SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2', [business.id, stay.contact_id]);
    const r = { locationId, guest: { contactId: Number(stay.contact_id), newGuest: null }, nights: { arrival: today, departure },
      party: { adults: Number(stay.adults), children: Number(stay.children), extraBeds: c.given(body.extraBeds) ? c.whole(body.extraBeds, 'Extra beds', 0, 5) : 0 },
      source: { source: stay.source, otaName: stay.ota_name, otaBookingId: stay.ota_booking_id }, agreed, dayUse: null,
      notes: body.notes === undefined ? stay.notes : c.optionalText(body.notes, 'Notes', 500), planId: c.given(body.ratePlanId) ? id(body.ratePlanId, 'Rate plan') : null,
      discount: null, roomTypeId: body.roomTypeId, roomId: body.roomId, billToContactId: stay.bill_to_contact_id, advance: null };
    const nextId = await stays.reserveIn(db, business, user, r, { requestKey: c.derivedKey(requestKey, 'stay'), hash, contact, movedFrom: stay.id });
    const next = await repo.one(db, 'SELECT * FROM lodging_stays WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, nextId]);
    await folio.checkInIn(db, business, user, next, { guests: guests.map(occupantOf), roomId: body.roomId }, { requestKey: c.derivedKey(requestKey, 'in'), hash,
      register: { arrivedFrom: here.name, goingTo: stay.going_to, purpose: stay.purpose }, waiver: null, moving: true });
    await stays.history(db, business, user, stay, null, null, `Moved to ${there.name}: stay ${next.stay_no}`);
    await stays.history(db, business, user, next, null, null, `Moved from ${here.name}: stay ${stay.stay_no}`);
    const out = await repo.one(db, 'SELECT d.document_no,d.total,d.place_of_supply FROM lodging_stays s LEFT JOIN business_documents d ON d.business_id=s.business_id AND d.id=s.document_id WHERE s.business_id=$1 AND s.id=$2',
      [business.id, stay.id]);
    const details = { from: { stayNo: stay.stay_no, property: here.name, documentNo: out?.document_no || null, total: out?.total || null, placeOfSupply: out?.place_of_supply || null },
      to: { stayNo: next.stay_no, property: there.name, arrival: today, departure } };
    await repo.audit(db, business.id, user.id, 'lodging_stay.moved_property', next.id, details);
    await repo.event(db, business.id, user.id, 'lodging_stay.moved_property', 'lodging_stay', next.id, { ...details, fromStayId: stay.id, locationId });
    return stays.shape(business, await stays.load(db, business, next.id));
  });
}

module.exports = { moveProperty };
