const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./rentalsCommon');

// Use and earnings (module "rentals"), for a period of the business's
// calendar (from the first day's midnight to the last day's end, on its
// clock; a period running into today stops at now).
//
//   each unit   the days it was out (from its handover to its return, or now
//               while it is out) against the days it was available (from the
//               start of the period, or when it was added, to its end or when
//               it was retired, less the maintenance booked), the share of the
//               days it was out, the hires it went out on, the hire it earned
//               and the fees (late, kilometres, fuel, charges) on bills dated in
//               the period (before GST).
//   each item   its units added up; a pool by piece-days (each piece out for a
//               day is one) against the pool's pieces for each day; a kit by
//               the hire billed on its own line.
// Money is for those who see sales.

const { fail } = c;
const DAY = 86400;
const days = (seconds) => Math.round((Number(seconds) / DAY) * 10) / 10;
const share = (out, available) => (Number(available) > 0 ? Math.round((Number(out) / Number(available)) * 1000) / 10 : null);

const PERIOD = `p AS (SELECT ($2::date::timestamp AT TIME ZONE z.timezone) AS p0,(($3::date+1)::timestamp AT TIME ZONE z.timezone) AS p1,
    LEAST(now(),(($3::date+1)::timestamp AT TIME ZONE z.timezone)) AS pe FROM businesses z WHERE z.id=$1)`;
// The bill lines of a set of booking lines (bl), on bills dated in the period: the hire, and the fees.
const BILLED = (bl) => `COALESCE((SELECT sum(dl.net) FROM rental_booking_lines l JOIN business_document_lines dl ON dl.business_id=l.business_id AND dl.id=l.line_id
      JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id WHERE l.business_id=$1 AND ${bl} AND d.created_at>=p.p0 AND d.created_at<p.p1),0) AS hire,
    COALESCE((SELECT sum(dl.net) FROM business_document_lines dl JOIN business_documents d ON d.business_id=dl.business_id AND d.id=dl.document_id
      WHERE dl.business_id=$1 AND d.created_at>=p.p0 AND d.created_at<p.p1 AND dl.id IN (
        SELECT f.fee FROM rental_booking_lines l JOIN rental_return_lines rl ON rl.business_id=l.business_id AND rl.line_id=l.id
          CROSS JOIN LATERAL (VALUES (rl.late_line_id),(rl.km_line_id),(rl.fuel_line_id)) f(fee) WHERE l.business_id=$1 AND ${bl} AND f.fee IS NOT NULL
        UNION ALL SELECT ch.line_id FROM rental_booking_lines l JOIN rental_charges ch ON ch.business_id=l.business_id AND ch.booking_line_id=l.id
          WHERE l.business_id=$1 AND ${bl} AND ch.line_id IS NOT NULL)),0) AS fees`;

const UNITS_SQL = `WITH ${PERIOD}
  SELECT u.id,u.label,u.serial_no,u.item_id,s.label AS item_name,u.status,
    COALESCE((SELECT sum(GREATEST(0,EXTRACT(EPOCH FROM (LEAST(COALESCE(back.at,now()),p.pe)-GREATEST(b.checked_out_at,p.p0)))))
      FROM rental_booking_lines l JOIN rental_bookings b ON b.business_id=l.business_id AND b.id=l.booking_id
      LEFT JOIN LATERAL (SELECT max(r.created_at) AS at FROM rental_return_lines rl JOIN rental_returns r ON r.business_id=rl.business_id AND r.id=rl.return_id
        WHERE rl.business_id=l.business_id AND rl.line_id=l.id) back ON TRUE
      WHERE l.business_id=$1 AND l.unit_id=u.id AND b.checked_out_at IS NOT NULL AND b.checked_out_at<p.pe AND COALESCE(back.at,now())>p.p0),0) AS seconds_out,
    (SELECT count(DISTINCT b.id)::int FROM rental_booking_lines l JOIN rental_bookings b ON b.business_id=l.business_id AND b.id=l.booking_id
      WHERE l.business_id=$1 AND l.unit_id=u.id AND b.checked_out_at>=p.p0 AND b.checked_out_at<p.pe) AS hires,
    GREATEST(0,EXTRACT(EPOCH FROM (LEAST(p.pe,CASE WHEN u.status='retired' THEN u.updated_at ELSE p.pe END)-GREATEST(p.p0,u.created_at)))) AS seconds_in_service,
    COALESCE((SELECT sum(GREATEST(0,EXTRACT(EPOCH FROM (LEAST(d.ends_at,p.pe)-GREATEST(d.starts_at,p.p0))))) FROM rental_downtime d
      WHERE d.business_id=$1 AND d.unit_id=u.id AND d.cancelled_at IS NULL AND d.starts_at<p.pe AND d.ends_at>p.p0),0) AS seconds_down,
    ${BILLED('l.unit_id=u.id')}
  FROM rental_units u JOIN rental_items i ON i.business_id=u.business_id AND i.id=u.item_id JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id CROSS JOIN p
  WHERE u.business_id=$1 AND u.created_at<p.pe AND ($4::bigint IS NULL OR u.location_id=$4)
  ORDER BY i.sort_order,lower(s.label),lower(u.label)`;

const ITEMS_SQL = `WITH ${PERIOD}
  SELECT i.id,s.label AS name,i.kind,i.pool_quantity,
    CASE WHEN i.kind='pool' THEN
      COALESCE((SELECT sum(rl.quantity*GREATEST(0,EXTRACT(EPOCH FROM (LEAST(r.created_at,p.pe)-GREATEST(b.checked_out_at,p.p0)))))
        FROM rental_booking_lines l JOIN rental_bookings b ON b.business_id=l.business_id AND b.id=l.booking_id
        JOIN rental_return_lines rl ON rl.business_id=l.business_id AND rl.line_id=l.id JOIN rental_returns r ON r.business_id=rl.business_id AND r.id=rl.return_id
        WHERE l.business_id=$1 AND l.item_id=i.id AND rl.quantity>0 AND b.checked_out_at<p.pe AND r.created_at>p.p0),0)
      + COALESCE((SELECT sum((l.quantity-x.back)*GREATEST(0,EXTRACT(EPOCH FROM (p.pe-GREATEST(b.checked_out_at,p.p0)))))
        FROM rental_booking_lines l JOIN rental_bookings b ON b.business_id=l.business_id AND b.id=l.booking_id
        CROSS JOIN LATERAL (SELECT COALESCE(sum(rl.quantity+rl.missing),0)::int AS back FROM rental_return_lines rl WHERE rl.business_id=l.business_id AND rl.line_id=l.id) x
        WHERE l.business_id=$1 AND l.item_id=i.id AND b.status='out' AND l.quantity>x.back AND b.checked_out_at<p.pe),0) END AS piece_seconds_out,
    CASE WHEN i.kind='pool' THEN i.pool_quantity*GREATEST(0,EXTRACT(EPOCH FROM (p.pe-GREATEST(p.p0,i.created_at)))) END AS piece_seconds_available,
    (SELECT count(DISTINCT b.id)::int FROM rental_booking_lines l JOIN rental_bookings b ON b.business_id=l.business_id AND b.id=l.booking_id
      WHERE l.business_id=$1 AND l.item_id=i.id AND b.checked_out_at>=p.p0 AND b.checked_out_at<p.pe) AS hires,
    ${BILLED('l.item_id=i.id')}
  FROM rental_items i JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id CROSS JOIN p
  WHERE i.business_id=$1 AND i.created_at<p.pe ORDER BY i.active DESC,i.sort_order,lower(s.label),i.id`;

// query: { from, to (YYYY-MM-DD; this month so far) }
async function report(business, query = {}) {
  c.requireRentals(business);
  await access.require(business, 'rentals.view');
  const today = await c.today(repo.pool, business);
  const from = query.from ? c.readDate(query.from, 'From') : `${today.slice(0, 8)}01`;
  const to = query.to ? c.readDate(query.to, 'To') : today;
  if (to < from) fail('The end date is before the start date');
  if (Date.parse(to) - Date.parse(from) > 400 * DAY * 1000) fail('Choose a period of at most a year');
  const money = c.seesMoney(business);
  const unitRows = await repo.all(repo.pool, UNITS_SQL, [business.id, from, to, business.location_scope || null]);
  const itemRows = await repo.all(repo.pool, ITEMS_SQL, [business.id, from, to]);
  const units = unitRows.map((u) => {
    const out = Number(u.seconds_out), available = Math.max(0, Number(u.seconds_in_service) - Number(u.seconds_down));
    return { unitId: u.id, label: u.label, serialNo: u.serial_no, itemId: u.item_id, itemName: u.item_name, status: u.status, hires: u.hires, daysOut: days(out),
      daysAvailable: days(available), use: share(out, available), hire: money ? u.hire : null, fees: money ? u.fees : null, outSeconds: out, availableSeconds: available };
  });
  const items = itemRows.map((i) => {
    if (i.kind === 'unit') {
      const mine = units.filter((u) => Number(u.itemId) === Number(i.id));
      const out = mine.reduce((s, u) => s + u.outSeconds, 0), available = mine.reduce((s, u) => s + u.availableSeconds, 0);
      return { itemId: i.id, name: i.name, kind: i.kind, units: mine.length, hires: i.hires, daysOut: days(out), daysAvailable: days(available), use: share(out, available),
        hire: money ? i.hire : null, fees: money ? i.fees : null };
    }
    if (i.kind === 'pool') {
      return { itemId: i.id, name: i.name, kind: i.kind, pool: Number(i.pool_quantity), hires: i.hires, daysOut: days(i.piece_seconds_out), daysAvailable: days(i.piece_seconds_available),
        use: share(i.piece_seconds_out, i.piece_seconds_available), hire: money ? i.hire : null, fees: money ? i.fees : null };
    }
    return { itemId: i.id, name: i.name, kind: i.kind, hires: i.hires, daysOut: null, daysAvailable: null, use: null, hire: money ? i.hire : null, fees: money ? i.fees : null };
  });
  const add = (list, key) => (money ? list.reduce((s, x) => s + c.paise(x[key] || 0), 0) : null);
  return { from, to, money, units: units.map(({ outSeconds: _o, availableSeconds: _a, ...u }) => u), items,
    totals: { hire: money ? c.rupees(add(items, 'hire')) : null, fees: money ? c.rupees(add(items, 'fees')) : null } };
}

module.exports = { report };
