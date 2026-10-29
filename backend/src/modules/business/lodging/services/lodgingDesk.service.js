const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./lodgingCommon');
const stays = require('./lodgingStays.service');

// The front desk's day and the reservations calendar (module "lodging"), on the
// business's clock: a night belongs to the date it starts on.
//
//   desk      today's arrivals (and reservations past their arrival day not
//             checked in), the guests in the house, today's departures (and
//             guests past their departure day), the rooms by status (out of
//             order tonight when a period covers today), the room nights the
//             night audit has still to post, and the audits run lately.
//   calendar  two weeks (or up to a month) of nights, for every room type, at
//             every property or one: each room with the stay in it each night
//             (or out of order, with why), the stays with no room yet, and how
//             many rooms of the type are left each night.
//   free      for a stay being typed or checked in: each room free or not over
//             its nights (taken, or out of order), and how many of each type are left.
// The database checks every stay again when it is saved.

const { fail, id } = c;

// Room nights of stays in the house not posted yet, up to tonight (or the night before departure).
const PENDING_SQL = `SELECT s.id,count(n)::int AS nights FROM lodging_stays s JOIN businesses z ON z.id=s.business_id
  JOIN LATERAL generate_series(s.arrival::timestamp,LEAST((now() AT TIME ZONE z.timezone)::date,s.departure-1)::timestamp,interval '1 day') n ON TRUE
  WHERE s.business_id=$1 AND s.status='in_house' AND ($2::bigint IS NULL OR s.location_id=$2)
    AND NOT EXISTS (SELECT 1 FROM lodging_charges ch WHERE ch.business_id=s.business_id AND ch.stay_id=s.id AND ch.kind='room_night' AND ch.voided_at IS NULL AND ch.night=n::date)
  GROUP BY s.id`;

async function desk(business) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const scope = business.location_scope || null;
  const today = await c.today(repo.pool, business);
  const rows = await repo.all(repo.pool, `SELECT * FROM (${stays.STAYS_SQL}) x WHERE x.status IN ('reserved','in_house') AND ($2::bigint IS NULL OR x.location_id=$2)
    AND (x.status='in_house' OR x.arrival<=x.today) ORDER BY x.arrival,x.id LIMIT 500`, [business.id, scope]);
  const pending = await repo.all(repo.pool, PENDING_SQL, [business.id, scope]);
  const pendingOf = (stayId) => pending.find((p) => Number(p.id) === Number(stayId))?.nights || 0;
  const items = rows.map((s) => ({ ...s, nights_to_post: s.status === 'in_house' ? pendingOf(s.id) : 0 }));
  const shaped = c.seesMoney(business) ? items : items.map(stays.withoutMoney);
  const rooms = await repo.one(repo.pool, `SELECT count(*) FILTER (WHERE status='vacant_clean' AND NOT down)::int AS vacant_clean,
      count(*) FILTER (WHERE status='vacant_dirty' AND NOT down)::int AS vacant_dirty,count(*) FILTER (WHERE status='occupied')::int AS occupied,
      count(*) FILTER (WHERE status<>'occupied' AND down)::int AS out_of_order,count(*)::int AS rooms
    FROM (SELECT r.status,EXISTS (SELECT 1 FROM lodging_out_of_order o WHERE o.business_id=r.business_id AND o.room_id=r.id AND o.cancelled_at IS NULL AND o.starts_on<=$3::date
        AND (o.ends_on IS NULL OR o.ends_on>=$3::date)) AS down
      FROM lodging_rooms r WHERE r.business_id=$1 AND r.active AND ($2::bigint IS NULL OR r.location_id=$2)) x`, [business.id, scope, today]);
  const settings = await c.settingsOf(repo.pool, business.id);
  // The night audits run lately, the last first.
  const audits = await repo.all(repo.pool, `SELECT a.id,a.location_id,l.name AS location_name,a.day::text AS day,a.nights,a.no_shows,a.created_at,u.name AS by_name
    FROM lodging_night_audits a JOIN users u ON u.id=a.created_by LEFT JOIN business_locations l ON l.business_id=a.business_id AND l.id=a.location_id
    WHERE a.business_id=$1 AND ($2::bigint IS NULL OR a.location_id IS NULL OR a.location_id=$2) ORDER BY a.day DESC,a.id DESC LIMIT 5`, [business.id, scope]);
  return {
    today,
    arrivals: shaped.filter((s) => s.status === 'reserved'),
    inHouse: shaped.filter((s) => s.status === 'in_house'),
    departures: shaped.filter((s) => s.status === 'in_house' && s.departure <= today),
    rooms,
    audit: { nights: pending.reduce((sum, p) => sum + p.nights, 0), stays: pending.length, ready: Boolean(settings.low_tax_rate_id), last: audits[0] || null, recent: audits,
      // Yesterday not closed by an audit: the property's business date is the date on its clock, and the audit closes it.
      yesterdayOpen: !audits.some((a) => a.day >= c.addDays(today, -1)), noShowCutoff: settings.no_show_cutoff ? c.hhmm(settings.no_show_cutoff) : null },
    counts: { arrivals: shaped.filter((s) => s.status === 'reserved' && s.arrival === today).length, late: shaped.filter((s) => s.late_arrival).length,
      inHouse: shaped.filter((s) => s.status === 'in_house').length, departures: shaped.filter((s) => s.status === 'in_house' && s.departure === today).length,
      overstays: shaped.filter((s) => s.status === 'in_house' && s.departure < today).length },
  };
}

// query: { from? (YYYY-MM-DD, today), days? (14), roomType?, location? (one property; every property when left out) }
async function calendar(business, query = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const from = query.from ? c.readDate(query.from, 'From') : await c.today(repo.pool, business);
  const days = query.days ? c.whole(query.days, 'Days', 1, 31) : 14;
  const typeId = query.roomType ? id(query.roomType, 'Room type') : null;
  const until = c.addDays(from, days);
  const scope = business.location_scope || (c.given(query.location) ? id(query.location, 'Property') : null);
  const dayList = Array.from({ length: days }, (_, i) => c.addDays(from, i));
  const types = await repo.all(repo.pool, `SELECT t.id,s.label AS name,t.base_occupancy,t.max_occupancy,t.rack_rate,t.weekend_rate FROM lodging_room_types t
    JOIN catalog_skus s ON s.business_id=t.business_id AND s.id=t.sku_id WHERE t.business_id=$1 AND t.active AND ($2::bigint IS NULL OR t.id=$2) ORDER BY t.sort_order,lower(s.label),t.id`,
  [business.id, typeId]);
  const rooms = await repo.all(repo.pool, `SELECT r.id,r.room_no,r.floor,r.room_type_id,r.status,r.status_note,r.location_id,l.name AS location_name,r.cleaning,r.out_of_service,
      r.out_of_service_note FROM lodging_rooms r JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
    WHERE r.business_id=$1 AND r.active AND ($2::bigint IS NULL OR r.location_id=$2) ORDER BY l.name,r.sort_order,lower(r.floor),length(r.room_no),lower(r.room_no),r.id`, [business.id, scope]);
  const downs = await repo.all(repo.pool, `SELECT o.room_id,o.starts_on::text AS starts_on,o.ends_on::text AS ends_on,o.reason FROM lodging_out_of_order o
    JOIN lodging_rooms r ON r.business_id=o.business_id AND r.id=o.room_id WHERE o.business_id=$1 AND o.cancelled_at IS NULL AND o.starts_on<$3::date
      AND (o.ends_on IS NULL OR o.ends_on>=$2::date) AND ($4::bigint IS NULL OR r.location_id=$4)`, [business.id, from, until, scope]);
  const downOn = (roomId, day) => downs.find((o) => Number(o.room_id) === Number(roomId) && o.starts_on <= day && (!o.ends_on || o.ends_on >= day)) || null;
  const held = await repo.all(repo.pool, `SELECT s.id,s.stay_no,s.guest_name,s.status,s.arrival::text AS arrival,s.departure::text AS departure,s.room_type_id,s.room_id,s.adults,s.children,s.source,s.ota_name,s.day_use,
      s.location_id
    FROM lodging_stays s WHERE s.business_id=$1 AND s.status IN ('reserved','in_house','checked_out') AND s.arrival<$3::date AND s.departure>$2::date
      AND ($4::bigint IS NULL OR s.location_id=$4) ORDER BY s.arrival,s.id`, [business.id, from, until, scope]);
  const on = (stay, day) => stay.arrival <= day && stay.departure > day;
  const stayText = (s) => ({ id: s.id, stayNo: s.stay_no, guestName: s.guest_name, status: s.status, arrival: s.arrival, departure: s.departure, adults: s.adults, children: s.children,
    source: s.source, otaName: s.ota_name });
  return {
    from, to: c.addDays(until, -1), days: dayList, today: await c.today(repo.pool, business), locationId: scope,
    types: types.map((type) => {
      const mine = rooms.filter((r) => Number(r.room_type_id) === Number(type.id));
      const stayList = held.filter((s) => Number(s.room_type_id) === Number(type.id));
      const unassigned = stayList.filter((s) => !s.room_id && s.status === 'reserved');
      return {
        id: type.id, name: type.name, rooms: mine.map((room) => ({ id: room.id, roomNo: room.room_no, floor: room.floor, locationId: room.location_id, locationName: room.location_name,
          status: room.status !== 'occupied' && downOn(room.id, dayList[0]) ? 'out_of_order' : room.status, statusNote: downOn(room.id, dayList[0])?.reason || room.status_note,
          cleaning: room.cleaning, outOfService: room.out_of_service ? room.out_of_service_note : null,
          nights: dayList.map((day) => {
            const s = held.find((x) => Number(x.room_id) === Number(room.id) && on(x, day));
            return { day, stay: s ? stayText(s) : null, down: downOn(room.id, day)?.reason || null };
          }) })),
        unassigned: unassigned.map((s) => ({ ...stayText(s), nights: dayList.map((day) => on(s, day)) })),
        left: dayList.map((day) => ({ day, left: Math.max(0, mine.length - mine.filter((r) => downOn(r.id, day)).length
          - stayList.filter((s) => ['reserved', 'in_house'].includes(s.status) && !s.day_use && on(s, day)).length) })),
      };
    }),
  };
}

// query: { arrival, departure, roomType?, stay? (a stay being changed or checked in: its own nights left out), location? (one property) } — the rooms free over those nights.
async function free(business, query = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  const { arrival, departure } = stays.readNights(query.arrival, query.departure);
  const exceptStay = query.stay ? id(query.stay, 'Stay') : null;
  const typeId = query.roomType ? id(query.roomType, 'Room type') : null;
  const scope = business.location_scope || (c.given(query.location) ? id(query.location, 'Property') : null);
  const rooms = await repo.all(repo.pool, `SELECT r.id,r.room_no,r.floor,r.room_type_id,k.label AS room_type,r.status,r.status_note,r.location_id,
      (SELECT json_build_object('id',s.id,'stay_no',s.stay_no,'guest_name',s.guest_name,'status',s.status,'arrival',s.arrival,'departure',s.departure)
        FROM lodging_stays s WHERE s.business_id=r.business_id AND s.room_id=r.id AND s.status IN ('reserved','in_house') AND NOT s.day_use AND s.arrival<$3::date AND s.departure>$2::date
          AND ($4::bigint IS NULL OR s.id<>$4) ORDER BY s.arrival LIMIT 1) AS clash,
      (SELECT json_build_object('starts_on',o.starts_on,'ends_on',o.ends_on,'reason',o.reason) FROM lodging_out_of_order o WHERE o.business_id=r.business_id AND o.room_id=r.id
        AND o.cancelled_at IS NULL AND o.starts_on<$3::date AND (o.ends_on IS NULL OR o.ends_on>=GREATEST($2::date,(now() AT TIME ZONE z.timezone)::date)) ORDER BY o.starts_on LIMIT 1) AS down,
      r.cleaning,r.out_of_service,r.out_of_service_note
    FROM lodging_rooms r JOIN lodging_room_types t ON t.business_id=r.business_id AND t.id=r.room_type_id JOIN catalog_skus k ON k.business_id=t.business_id AND k.id=t.sku_id
    JOIN businesses z ON z.id=r.business_id
    WHERE r.business_id=$1 AND r.active AND ($5::bigint IS NULL OR r.room_type_id=$5) AND ($6::bigint IS NULL OR r.location_id=$6)
    ORDER BY r.sort_order,lower(r.floor),length(r.room_no),lower(r.room_no),r.id`, [business.id, arrival, departure, exceptStay, typeId, scope]);
  return {
    arrival, departure,
    rooms: rooms.map((r) => ({ id: r.id, roomNo: r.room_no, floor: r.floor, roomTypeId: r.room_type_id, roomType: r.room_type, status: r.status, statusNote: r.status_note,
      cleaning: r.cleaning, outOfService: r.out_of_service ? r.out_of_service_note : null, free: !r.clash && !r.down,
      clash: r.clash ? { id: r.clash.id, stayNo: r.clash.stay_no, guestName: r.clash.guest_name, status: r.clash.status, arrival: r.clash.arrival, departure: r.clash.departure,
        words: stays.clashWords({ ...r.clash, room_no: r.room_no }) } : r.down ? { outOfOrder: true, words: c.downWords({ ...r.down, room_no: r.room_no }) } : null })),
  };
}

module.exports = { desk, calendar, free, PENDING_SQL };
