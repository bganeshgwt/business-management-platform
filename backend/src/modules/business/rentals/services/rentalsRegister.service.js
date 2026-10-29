const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const c = require('./rentalsCommon');

// The hirer register of the rent-a-cab and rent-a-motorcycle schemes (module
// "rentals"): for each vehicle, every hire handed over in a period (on the
// business's calendar), as the forms list them — Form 5 for a cab and Form 3
// for a motorcycle: the hirer's name, full address and telephone; the driving
// licence's number, issuing authority, classes of vehicle, and issue and
// expiry dates; when it was hired and returned; the total kilometres; the
// hirer's signature; remarks. A foreign national's hires are on Form 6 (a cab)
// or Form 4 (a motorcycle), which add the passport's number, issuing authority
// and nation and its dates, the date of birth, the driving permit's number and
// issue date, and the classes it authorises. The register is printed from the
// screen; nothing is filed from here.

const { fail, id } = c;
const FORMS = { car: { own: 'Form 5', foreign: 'Form 6', scheme: 'Rent a Cab Scheme, 1989' }, motorcycle: { own: 'Form 3', foreign: 'Form 4', scheme: 'Rent a Motor Cycle Scheme, 1997' },
  other: { own: 'Hirer register', foreign: 'Hirer register (foreign nationals)', scheme: null } };

const ROWS_SQL = `SELECT b.id AS booking_id,b.booking_no,b.customer_name,b.customer_phone,b.licence_no,b.licence_valid_until,b.checked_out_at,l.id AS line_id,l.unit_id,l.meter_out,
    h.address,h.licence_authority,h.licence_classes,h.licence_issued_on,COALESCE(h.foreigner,FALSE) AS foreigner,h.passport_no,h.passport_authority,h.passport_nation,
    h.passport_issued_on,h.passport_valid_until,h.birth_date,h.permit_no,h.permit_issued_on,h.permit_classes,h.visa_no,h.visa_valid_until,h.original_held,h.original_returned_at,
    back.returned_at,back.meter_in,back.remarks,
    EXISTS (SELECT 1 FROM rental_files f WHERE f.business_id=b.business_id AND f.booking_id=b.id AND f.kind='signature' AND f.signer='hirer' AND f.stage='out') AS signed
  FROM rental_booking_lines l JOIN rental_bookings b ON b.business_id=l.business_id AND b.id=l.booking_id
  JOIN rental_items i ON i.business_id=l.business_id AND i.id=l.item_id JOIN businesses z ON z.id=b.business_id
  LEFT JOIN rental_hirers h ON h.business_id=b.business_id AND h.booking_id=b.id
  LEFT JOIN LATERAL (SELECT max(r.created_at) AS returned_at,(array_agg(rl.meter_in ORDER BY r.id DESC))[1] AS meter_in,
      string_agg(concat_ws(': ',NULLIF(rl.note,''),NULLIF(r.note,'')),' · ' ORDER BY r.id) FILTER (WHERE rl.note IS NOT NULL OR r.note IS NOT NULL) AS remarks
    FROM rental_return_lines rl JOIN rental_returns r ON r.business_id=rl.business_id AND r.id=rl.return_id WHERE rl.business_id=l.business_id AND rl.line_id=l.id) back ON TRUE
  WHERE l.business_id=$1 AND l.unit_id=ANY($2::bigint[]) AND b.checked_out_at IS NOT NULL
    AND (b.checked_out_at AT TIME ZONE z.timezone)::date BETWEEN $3::date AND $4::date
  ORDER BY l.unit_id,b.checked_out_at,b.id`;

// query: { from, to (YYYY-MM-DD; this month so far), unit? } — the register of each vehicle (rentals.print).
async function register(business, query = {}) {
  c.requireRentals(business);
  await access.require(business, 'rentals.print');
  const today = await c.today(repo.pool, business);
  const from = query.from ? c.readDate(query.from, 'From') : `${today.slice(0, 8)}01`;
  const to = query.to ? c.readDate(query.to, 'To') : today;
  if (to < from) fail('The end date is before the start date');
  const unitId = query.unit ? id(query.unit, 'Vehicle') : null;
  const vehicles = await repo.all(repo.pool, `SELECT u.id,u.label,u.serial_no,u.vehicle_class,s.label AS item_name,i.vehicle,i.with_driver FROM rental_units u
    JOIN rental_items i ON i.business_id=u.business_id AND i.id=u.item_id JOIN catalog_skus s ON s.business_id=i.business_id AND s.id=i.sku_id
    WHERE u.business_id=$1 AND i.vehicle IS NOT NULL AND ($2::bigint IS NULL OR u.id=$2) AND ($3::bigint IS NULL OR u.location_id=$3)
    ORDER BY i.vehicle,lower(s.label),lower(u.label)`, [business.id, unitId, business.location_scope || null]);
  if (unitId && !vehicles.length) fail('Vehicle not found', 404);
  const rows = await repo.all(repo.pool, ROWS_SQL, [business.id, vehicles.map((u) => u.id), from, to]);
  const day = (x) => (x ? String(x instanceof Date ? x.toISOString() : x).slice(0, 10) : null);
  const entry = (r) => ({
    bookingId: r.booking_id, bookingNo: r.booking_no, name: r.customer_name, address: r.address, telephone: r.customer_phone,
    licence: { number: r.licence_no, authority: r.licence_authority, classes: r.licence_classes || [], issuedOn: day(r.licence_issued_on), validUntil: day(r.licence_valid_until) },
    hiredAt: r.checked_out_at, returnedAt: r.returned_at,
    totalKm: r.meter_in !== null && r.meter_out !== null ? Math.round((Number(r.meter_in) - Number(r.meter_out)) * 10) / 10 : null, signed: r.signed, remarks: r.remarks,
    originalHeld: r.original_held, originalReturnedAt: r.original_returned_at,
    ...(r.foreigner ? { passport: { number: r.passport_no, authority: r.passport_authority, nation: r.passport_nation, issuedOn: day(r.passport_issued_on),
      validUntil: day(r.passport_valid_until) }, birthDate: day(r.birth_date), permit: r.permit_no ? { number: r.permit_no, issuedOn: day(r.permit_issued_on), classes: r.permit_classes || [] } : null,
    visa: r.visa_no ? { number: r.visa_no, validUntil: day(r.visa_valid_until) } : null } : {}),
  });
  return {
    from, to, timezone: business.timezone,
    vehicles: vehicles.map((u) => {
      const mine = rows.filter((r) => Number(r.unit_id) === Number(u.id));
      const forms = FORMS[u.vehicle] || FORMS.other;
      return { unitId: u.id, label: u.label, registration: u.serial_no, itemName: u.item_name, vehicle: u.vehicle, withDriver: u.with_driver, vehicleClass: u.vehicle_class,
        scheme: forms.scheme, form: forms.own, foreignForm: forms.foreign, rows: mine.filter((r) => !r.foreigner).map(entry), foreignRows: mine.filter((r) => r.foreigner).map(entry) };
    }),
  };
}

module.exports = { register };
