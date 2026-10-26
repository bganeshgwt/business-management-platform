const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
const stays = require('./lodgingStays.service');
const folio = require('./lodgingFolio.service');
const desk = require('./lodgingDesk.service');

// The occupants (module "lodging"): foreign guests' Form-III reports, an
// occupant's details corrected while they are in the house, the guest
// register, and the bell.
//
//   Form-III    every foreign national who stays, an OCI cardholder too, is
//               reported on the portal within 24 hours of arrival and again
//               within 24 hours of departure (Immigration and Foreigners Act
//               2025, in force from 1 September 2025; Form-III replaced Form C).
//               The portal is web-only: nothing is sent from here. Each report's
//               countdown runs from the check-in and from the check-out; staff
//               mark it reported with the portal's acknowledgement number, kept
//               once. Overdue reports are listed and the bell rings.
//   register    every occupant of the stays in a date range, with their ID
//               details, for the local police format: kept, never deleted.
// Guests' ID details are for those who check guests in (lodging.create) or print
// the register (lodging.print).

const { fail, id } = c;
const DAY_MS = 86400000;

// Each foreign occupant with their two reports: due when (24 hours after the check-in and the check-out), reported or not.
const FORM_III_SQL = `SELECT g.id,g.stay_id,s.stay_no,s.status AS stay_status,s.location_id,r.room_no,g.full_name,g.child,g.gender,g.nationality,g.id_kind,g.id_ref,g.visa_type,g.visa_no,
    g.arrived_india_on,g.next_destination,g.arrived_at,g.departed_at,g.arrived_at+interval '24 hours' AS arrival_due_at,g.departed_at+interval '24 hours' AS departure_due_at,
    g.frro_arrival_ack,g.frro_arrival_at,ua.name AS frro_arrival_by_name,g.frro_departure_ack,g.frro_departure_at,ud.name AS frro_departure_by_name,
    (g.frro_arrival_ack IS NULL) AS arrival_open,(g.departed_at IS NOT NULL AND g.frro_departure_ack IS NULL) AS departure_open,
    (g.frro_arrival_ack IS NULL AND now()>g.arrived_at+interval '24 hours') OR (g.departed_at IS NOT NULL AND g.frro_departure_ack IS NULL AND now()>g.departed_at+interval '24 hours') AS overdue
  FROM lodging_stay_guests g JOIN lodging_stays s ON s.business_id=g.business_id AND s.id=g.stay_id LEFT JOIN lodging_rooms r ON r.business_id=s.business_id AND r.id=s.room_id
  LEFT JOIN users ua ON ua.id=g.frro_arrival_by LEFT JOIN users ud ON ud.id=g.frro_departure_by
  WHERE g.business_id=$1 AND g.foreigner`;

// query: { view?: open (reports still to make, the default) | all (the last 90 days) }
async function formIII(business, query = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const view = v.requiredEnum(query.view ?? 'open', 'Show', ['open', 'all']);
  const rows = await repo.all(repo.pool, `SELECT * FROM (${FORM_III_SQL}) x WHERE ($2::bigint IS NULL OR x.location_id=$2)
    AND (${view === 'open' ? 'x.arrival_open OR x.departure_open' : "x.arrived_at>now()-interval '90 days' OR x.arrival_open OR x.departure_open"})
    ORDER BY x.overdue DESC,LEAST(CASE WHEN x.arrival_open THEN x.arrival_due_at END,CASE WHEN x.departure_open THEN x.departure_due_at END) NULLS LAST,x.arrived_at DESC,x.id LIMIT 500`,
  [business.id, business.location_scope || null]);
  const now = (await repo.one(repo.pool, 'SELECT now() AS now')).now;
  return {
    now, view,
    items: rows.map((g) => {
      const next = g.arrival_open ? { event: 'arrival', dueAt: g.arrival_due_at } : g.departure_open ? { event: 'departure', dueAt: g.departure_due_at } : null;
      return { ...g, next: next ? { ...next, minutesLeft: Math.round((new Date(next.dueAt) - new Date(now)) / 60000) } : null };
    }),
    counts: { overdue: rows.filter((g) => g.overdue).length, open: rows.filter((g) => g.arrival_open || g.departure_open).length },
  };
}

// body: { event: arrival | departure, acknowledgement } — a report made on the portal, marked with its acknowledgement number.
async function markReported(business, user, guestId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const event = v.requiredEnum(body.event, 'Report', ['arrival', 'departure']);
  const ack = String(body.acknowledgement ?? '').trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9/-]{3,40}$/.test(ack)) fail('The acknowledgement number is 3 to 40 letters and digits, as the portal gives it');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const guest = await repo.one(db, `SELECT g.*,s.stay_no,s.location_id FROM lodging_stay_guests g JOIN lodging_stays s ON s.business_id=g.business_id AND s.id=g.stay_id
      WHERE g.business_id=$1 AND g.id=$2 FOR UPDATE OF g`, [business.id, id(guestId, 'Occupant')]);
    if (!guest) fail('Occupant not found', 404);
    access.requireLocation(business, guest.location_id);
    if (!guest.foreigner) fail(`${guest.full_name} is not a foreign national: Form-III is for foreigners`, 409);
    const field = event === 'arrival' ? 'frro_arrival' : 'frro_departure';
    if (guest[`${field}_ack`]) {
      if (guest[`${field}_ack`] === ack) return { guest: await guestRow(db, business, guest.id), repeated: true };
      fail(`The Form-III ${event} report of ${guest.full_name} is recorded already (acknowledgement ${guest[`${field}_ack`]})`, 409);
    }
    if (event === 'departure' && !guest.departed_at) fail(`${guest.full_name} has not left yet: the departure report is made after the check-out`, 409);
    await db.query(`UPDATE lodging_stay_guests SET ${field}_ack=$3,${field}_at=now(),${field}_by=$4,updated_by=$4,updated_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, guest.id, ack, user.id]);
    const stay = { id: guest.stay_id };
    await stays.history(db, business, user, stay, null, null, `Form-III ${event} report of ${guest.full_name} made on the portal (acknowledgement ${ack})`);
    const details = { stayNo: guest.stay_no, guest: guest.full_name, event, acknowledgement: ack };
    await repo.audit(db, business.id, user.id, 'lodging_guest.form_iii_reported', guest.id, details);
    await repo.event(db, business.id, user.id, 'lodging_guest.form_iii_reported', 'lodging_guest', guest.id, { ...details, stayId: guest.stay_id });
    return { guest: await guestRow(db, business, guest.id), repeated: false };
  });
}
const guestRow = (db, business, guestId) => repo.one(db, `SELECT * FROM (${FORM_III_SQL}) x WHERE x.id=$2`, [business.id, guestId]);

// body: the occupant's details as at check-in — corrected while the stay is in the house.
async function updateGuest(business, user, stayId, guestId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    const guest = await repo.one(db, 'SELECT * FROM lodging_stay_guests WHERE business_id=$1 AND stay_id=$2 AND id=$3 FOR UPDATE', [business.id, stay.id, id(guestId, 'Occupant')]);
    if (!guest) fail('Occupant not found', 404);
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} has left: its occupants' details are kept as they were`, 409);
    const today = await c.today(db, business);
    const merged = {
      fullName: guest.full_name, child: guest.child, gender: guest.gender, age: guest.age, phone: guest.phone, address: guest.address, nationality: guest.nationality,
      foreigner: guest.foreigner, idKind: guest.id_kind, idRef: guest.id_ref, visaType: guest.visa_type, visaNo: guest.visa_no, arrivedIndiaOn: guest.arrived_india_on,
      nextDestination: guest.next_destination, ...body,
    };
    if (merged.child !== guest.child) fail('An occupant stays an adult or a child as recorded at check-in');
    const next = folio.readGuest(merged, Number(guest.seq) - 1, today);
    await db.query(`UPDATE lodging_stay_guests SET (${folio.GUEST_COLUMNS})=($3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16),updated_by=$17,updated_at=now() WHERE business_id=$1 AND id=$2`,
      [business.id, guest.id, ...folio.guestValues(next), user.id]);
    const before = { fullName: guest.full_name, nationality: guest.nationality, foreigner: guest.foreigner, idKind: guest.id_kind, visaType: guest.visa_type, nextDestination: guest.next_destination };
    const after = { fullName: next.fullName, nationality: next.nationality, foreigner: next.foreigner, idKind: next.idKind, visaType: next.visaType, nextDestination: next.nextDestination };
    await stays.history(db, business, user, stay, null, null, `Occupant ${guest.seq}'s details corrected (${next.fullName})`);
    await repo.audit(db, business.id, user.id, 'lodging_guest.corrected', guest.id, { stayNo: stay.stay_no, from: before, to: after, idChanged: guest.id_ref !== next.idRef });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// query: { from (YYYY-MM-DD), to } — every occupant of the stays in the house between those dates, with their ID
// details and when they came and left, for the local police format. At most 92 days.
async function register(business, query = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.print');
  const today = await c.today(repo.pool, business);
  const from = query.from ? c.readDate(query.from, 'From') : today;
  const to = query.to ? c.readDate(query.to, 'To') : from;
  if (to < from) fail('The end date is before the start date');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS > 92) fail('The register is printed for at most 92 days at a time');
  const zone = business.timezone || 'Asia/Kolkata';
  const rows = await repo.all(repo.pool, `SELECT g.id,g.seq,g.full_name,g.child,g.gender,g.age,g.phone,g.address,g.nationality,g.foreigner,g.id_kind,g.id_ref,g.visa_type,g.visa_no,
      g.arrived_india_on,g.next_destination,g.arrived_at,g.departed_at,g.frro_arrival_ack,g.frro_departure_ack,s.id AS stay_id,s.stay_no,s.guest_name,s.guest_phone,s.adults,s.children,
      s.arrived_from,s.going_to,s.purpose,s.status,r.room_no,k.label AS room_type,l.name AS location_name
    FROM lodging_stay_guests g JOIN lodging_stays s ON s.business_id=g.business_id AND s.id=g.stay_id
    JOIN business_locations l ON l.business_id=s.business_id AND l.id=s.location_id LEFT JOIN lodging_rooms r ON r.business_id=s.business_id AND r.id=s.room_id
    JOIN lodging_room_types t ON t.business_id=s.business_id AND t.id=s.room_type_id JOIN catalog_skus k ON k.business_id=t.business_id AND k.id=t.sku_id
    WHERE g.business_id=$1 AND (g.arrived_at AT TIME ZONE $4)::date<=$3::date AND (g.departed_at IS NULL OR (g.departed_at AT TIME ZONE $4)::date>=$2::date)
      AND ($5::bigint IS NULL OR s.location_id=$5)
    ORDER BY g.arrived_at,s.id,g.seq LIMIT 5000`, [business.id, from, to, zone, business.location_scope || null]);
  const settings = await repo.one(repo.pool, 'SELECT * FROM business_settings WHERE business_id=$1', [business.id]);
  const location = business.location_scope ? await repo.one(repo.pool, 'SELECT * FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, business.location_scope]) : null;
  return { from, to, timezone: zone, seller: core.branchSeller(settings, location), items: rows };
}

// --- The bell ----------------------------------------------------------------------------------------------------

// Form-III reports overdue (critical) and due within the day (warning), reservations past their arrival day not
// checked in, guests past their departure day, and room nights the night audit has still to post.
async function bell(business, base, limit) {
  const items = [];
  const scope = business.location_scope || null;
  if (access.can(business, 'lodging.create')) {
    const reports = await repo.all(repo.pool, `SELECT * FROM (${FORM_III_SQL}) x WHERE (x.arrival_open OR x.departure_open) AND ($2::bigint IS NULL OR x.location_id=$2)
      ORDER BY x.overdue DESC,x.arrived_at LIMIT $3`, [business.id, scope, limit]);
    for (const g of reports) {
      const event = g.arrival_open ? 'arrival' : 'departure';
      const dueAt = event === 'arrival' ? g.arrival_due_at : g.departure_due_at;
      const overdue = new Date(dueAt) < new Date();
      items.push({ id: `lodging:form-iii:${g.id}:${event}:${overdue ? 'late' : 'due'}`, severity: overdue ? 'critical' : 'warning', category: 'Form-III',
        title: overdue ? `Form-III ${event} report of ${g.full_name} is overdue` : `Report ${g.full_name}'s ${event} on Form-III`,
        detail: `${g.nationality} · ${g.stay_no}${g.room_no ? ` · room ${g.room_no}` : ''} · due by ${c.timeWords(dueAt, business.timezone)}`, at: new Date(dueAt).toISOString(),
        link: `${base}/lodging-form-iii` });
    }
  }
  const late = await repo.one(repo.pool, `SELECT count(*)::int AS n,min(arrival)::text AS first FROM (${stays.STAYS_SQL}) x WHERE x.late_arrival AND ($2::bigint IS NULL OR x.location_id=$2)`,
    [business.id, scope]);
  if (late.n > 0) {
    items.push({ id: `lodging:late:${late.n}:${late.first}`, severity: 'info', category: 'Stays', title: `${c.plural(late.n, 'reservation')} past the arrival day, not checked in`,
      detail: 'Check them in, change their dates, or mark them no-shows, at the Front desk', at: `${late.first}T00:00:00.000Z`, link: `${base}/lodging-desk` });
  }
  const over = await repo.all(repo.pool, `SELECT id,stay_no,guest_name,room_no,departure::text AS departure FROM (${stays.STAYS_SQL}) x WHERE x.stage='overstay' AND ($2::bigint IS NULL OR x.location_id=$2)
    ORDER BY x.departure,x.id LIMIT $3`, [business.id, scope, limit]);
  for (const s of over) {
    items.push({ id: `lodging:overstay:${s.id}:${s.departure}`, severity: 'warning', category: 'Stays', title: `${s.stay_no} was to leave on ${c.dateWords(s.departure)}`,
      detail: `${s.guest_name}${s.room_no ? ` · room ${s.room_no}` : ''} · extend the stay or check the guest out`, at: `${s.departure}T00:00:00.000Z`, link: `${base}/lodging-stays/${s.id}` });
  }
  if (access.can(business, 'lodging.create')) {
    const pending = await repo.all(repo.pool, desk.PENDING_SQL, [business.id, scope]);
    const today = await c.today(repo.pool, business);
    // Tonight's nights are posted by tonight's audit; a night before today still to post is late.
    const earlier = await repo.one(repo.pool, `SELECT count(*)::int AS n FROM lodging_stays s JOIN LATERAL generate_series(s.arrival::timestamp,LEAST($3::date-1,s.departure-1)::timestamp,interval '1 day') n ON TRUE
      WHERE s.business_id=$1 AND s.status='in_house' AND ($2::bigint IS NULL OR s.location_id=$2)
        AND NOT EXISTS (SELECT 1 FROM lodging_charges ch WHERE ch.business_id=s.business_id AND ch.stay_id=s.id AND ch.kind='room_night' AND ch.voided_at IS NULL AND ch.night=n::date)`,
    [business.id, scope, today]);
    if (earlier.n > 0) {
      items.push({ id: `lodging:audit:${today}:${earlier.n}`, severity: 'warning', category: 'Night audit', title: `${c.plural(earlier.n, 'room night')} from before today not posted`,
        detail: `Run the night audit at the Front desk (${c.plural(pending.length, 'stay')} in the house to post)`, at: `${today}T00:00:00.000Z`, link: `${base}/lodging-desk` });
    }
  }
  return items;
}

module.exports = { FORM_III_SQL, formIII, markReported, updateGuest, register, bell };
