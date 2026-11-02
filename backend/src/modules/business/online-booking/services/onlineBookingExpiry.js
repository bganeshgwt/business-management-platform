const repo = require('../../core/repositories/business.repository');

// A guest's request that nobody answered in time (the link's hours, never
// past its start) expires: it holds nothing once its time is up
// (business_appointment_holds reads request_expires_at, so no clash check
// ever waits for this), and the first read that comes along after that marks
// it expired, with the business's own audit row (channel automatic:
// "Automatic") and an event, so the desk's screens and the guest's page hear
// of it. Reads that call this: the guest's page, the desk's online bookings,
// the bell, the salon calendar and every online booking or change.
//
//   expireDue(businessId, db?) → how many appointments it marked expired
// With `db` it works in the caller's transaction; without, in its own, after
// a quick look (most reads find nothing to expire). Two at once mark each
// appointment once: the second waits on the first's row locks and then finds
// it no longer requested.

async function expireDue(businessId, db = null) {
  const work = async (dbx) => {
    const rows = await repo.all(dbx, `UPDATE business_appointments a SET status='expired'
      WHERE a.business_id=$1 AND a.status='requested' AND a.request_expires_at<=now()
      RETURNING a.id,a.online_booking_id,a.starts_at,a.request_expires_at,(SELECT r.location_id FROM business_resources r WHERE r.business_id=a.business_id AND r.id=a.resource_id) AS location_id`,
    [businessId]);
    for (const row of rows) {
      const details = { onlineBookingId: Number(row.online_booking_id), startsAt: row.starts_at, expiredAt: row.request_expires_at, reason: 'not_answered' };
      await repo.automaticAudit(dbx, businessId, 'appointment.expired', row.id, details);
      await repo.event(dbx, businessId, null, 'appointment.expired', 'appointment', row.id, { ...details, locationId: Number(row.location_id), source: 'guests_site' });
    }
    return rows.length;
  };
  if (db) return work(db);
  const due = await repo.one(repo.pool, "SELECT 1 FROM business_appointments WHERE business_id=$1 AND status='requested' AND request_expires_at<=now() LIMIT 1", [businessId]);
  return due ? repo.transaction(work) : 0;
}

module.exports = { expireDue };
