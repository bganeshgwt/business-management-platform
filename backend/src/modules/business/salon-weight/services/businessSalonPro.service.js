const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const salon = require('./businessSalon.service');

// Salon & spa, pro pass F (7 Oct 2026): moving a booking, arrival, the
// walk-in waiting list, WhatsApp confirmations and reminders (recorded),
// the client card (profile, notes, colour formulas), stylist leave, package
// holder actions (extend, usage) and the appointment history with deposits
// and bills. Moving a booking never charges the late-cancellation fee: the
// booking, its deposit and its price stay as they were.

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const optionalId = (value, name) => (value === undefined || value === null || value === '' ? null : id(value, name));

repo.addLists({
  // Appointment history for a salon: the deposit, the bill and any charge on each booking.
  'salon-appointments': {
    sql: `SELECT a.id,a.starts_at,a.ends_at,a.status,a.contact_id,a.resource_id,a.sku_id,r.location_id,c.name AS contact_name,c.phone AS contact_phone,
      s.label AS service_name,r.name AS resource_name,rm.name AS room_name,d.price_at_booking,k.collection_no AS deposit_no,k.amount AS deposit_amount,
      bd.document_no AS bill_no,bd.total AS bill_total,d.bill_document_id,fd.document_no AS fee_no,fd.total AS fee_total,d.fee_document_id,
      d.arrived_at,COALESCE(d.walk_in,false) AS walk_in,COALESCE(d.moved_count,0) AS moved_count,d.reminder_sent_at,d.confirmation_sent_at
      FROM business_appointments a JOIN business_contacts c ON c.business_id=a.business_id AND c.id=a.contact_id
      JOIN catalog_skus s ON s.business_id=a.business_id AND s.id=a.sku_id
      JOIN business_resources r ON r.business_id=a.business_id AND r.id=a.resource_id
      LEFT JOIN salon_appointment_details d ON d.business_id=a.business_id AND d.appointment_id=a.id
      LEFT JOIN business_resources rm ON rm.business_id=d.business_id AND rm.id=d.room_id
      LEFT JOIN business_collections k ON k.business_id=d.business_id AND k.id=d.deposit_collection_id
      LEFT JOIN business_documents bd ON bd.business_id=d.business_id AND bd.id=d.bill_document_id
      LEFT JOIN business_documents fd ON fd.business_id=d.business_id AND fd.id=d.fee_document_id WHERE a.business_id=$1`,
    search: ['contact_name', 'contact_phone', 'service_name', 'resource_name', 'bill_no'], date: 'starts_at',
    filters: { status: 'status', staff: 'resource_id', contact: 'contact_id', location: 'location_id' }, order: 'starts_at DESC,id DESC',
  },
  'salon-walk-ins': {
    sql: `SELECT w.*,c.name AS contact_name,c.phone AS contact_phone,s.label AS service_name,r.name AS resource_name,
      COALESCE(ss.duration_minutes,60) AS duration_minutes,(w.arrived_at AT TIME ZONE b.timezone)::date = (now() AT TIME ZONE b.timezone)::date AS today
      FROM salon_walk_ins w JOIN businesses b ON b.id=w.business_id
      JOIN business_contacts c ON c.business_id=w.business_id AND c.id=w.contact_id
      JOIN catalog_skus s ON s.business_id=w.business_id AND s.id=w.sku_id
      LEFT JOIN salon_services ss ON ss.business_id=w.business_id AND ss.sku_id=w.sku_id
      LEFT JOIN business_resources r ON r.business_id=w.business_id AND r.id=w.resource_id WHERE w.business_id=$1`,
    search: ['contact_name', 'contact_phone', 'service_name'], date: 'arrived_at', filters: { status: 'status', location: 'location_id' }, order: 'arrived_at',
  },
  'salon-commission-payouts': {
    sql: `SELECT p.*,r.name AS resource_name,r.location_id,u.name AS created_by_name FROM salon_commission_payouts p
      JOIN business_resources r ON r.business_id=p.business_id AND r.id=p.resource_id JOIN users u ON u.id=p.created_by WHERE p.business_id=$1`,
    search: ['resource_name', 'reference', 'note'], date: 'created_at', filters: { staff: 'resource_id', location: 'location_id' }, order: 'created_at DESC,id DESC',
  },
  'salon-plan-usage': {
    sql: `SELECT x.id,x.client_plan_id,x.created_at,x.document_no,x.document_id,x.label,x.quantity,x.kind,x.amount FROM (
      SELECT pr.id,pr.client_plan_id,pr.created_at,d.document_no,d.id AS document_id,s.label,pr.quantity,'session' AS kind,NULL::numeric AS amount
        FROM salon_package_redemptions pr JOIN business_documents d ON d.business_id=pr.business_id AND d.id=pr.document_id
        JOIN catalog_skus s ON s.business_id=pr.business_id AND s.id=pr.sku_id WHERE pr.business_id=$1
      UNION ALL
      SELECT mu.id,mu.client_plan_id,d.created_at,d.document_no,d.id,l.label,l.quantity,'discount',mu.amount
        FROM salon_membership_uses mu JOIN business_documents d ON d.business_id=mu.business_id AND d.id=mu.document_id
        JOIN business_document_lines l ON l.business_id=mu.business_id AND l.id=mu.line_id WHERE mu.business_id=$1) x WHERE true`,
    search: ['document_no', 'label'], filters: { plan: 'client_plan_id' }, order: 'created_at DESC,id DESC',
  },
});

// --- Moving a booking ---------------------------------------------------------------------

// body: { startsAt, resourceId?, roomId? (null = no room; left out = keep) }
// Same checks as a new booking (hours, skills, the stylist's hours and leave,
// no double booking of the stylist or the room). The deposit, the price
// booked and any package stay with the booking; nothing is charged.
async function move(business, user, appointmentId, body) {
  salon.requireSalon(business);
  await access.require(business, 'appointments.edit');
  const starts = new Date(body.startsAt);
  if (typeof body.startsAt !== 'string' || !Number.isFinite(starts.getTime())) fail('Choose the new start time');
  const override = await salon.readOverride(business, user, body);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(appointmentId, 'Appointment')]);
    await access.requireAppointmentLocation(db, business, appointment);
    if (!appointment) fail('Appointment not found', 404);
    if (appointment.status !== 'booked') fail('Only a booking still to come can be moved', 409);
    const details = await repo.one(db, 'SELECT * FROM salon_appointment_details WHERE business_id=$1 AND appointment_id=$2 FOR UPDATE', [business.id, appointment.id]);
    if (details?.bill_document_id) fail('This booking has been billed; it cannot be moved', 409);
    const staffId = optionalId(body.resourceId, 'Stylist') || Number(appointment.resource_id);
    const staff = await salon.lockResource(db, business, staffId, 'staff', 'Stylist');
    const service = await repo.one(db, `SELECT s.label,COALESCE(ss.needs_room,false) AS needs_room FROM catalog_skus s
      LEFT JOIN salon_services ss ON ss.business_id=s.business_id AND ss.sku_id=s.id WHERE s.business_id=$1 AND s.id=$2`, [business.id, appointment.sku_id]);
    const skills = await repo.all(db, 'SELECT sku_id FROM salon_staff_skills WHERE business_id=$1 AND resource_id=$2', [business.id, staff.id]);
    if (skills.length && !skills.some((k) => Number(k.sku_id) === Number(appointment.sku_id))) fail(`${staff.name} does not do ${service.label}. Choose another stylist.`, 409);
    // The booking keeps its length (service time and clean-up as booked).
    const ends = new Date(starts.getTime() + (new Date(appointment.ends_at).getTime() - new Date(appointment.starts_at).getTime()));
    const settings = await salon.settingsRow(db, business.id);
    const hours = await repo.one(db, `SELECT ($2::timestamptz AT TIME ZONE b.timezone)::time AS starts,($3::timestamptz AT TIME ZONE b.timezone)::time AS ends,
      ($2::timestamptz AT TIME ZONE b.timezone)::date = ($3::timestamptz AT TIME ZONE b.timezone)::date AS same_day,
      $2::timestamptz < now() - interval '1 hour' AS past FROM businesses b WHERE b.id=$1`, [business.id, starts, ends]);
    if (hours.past) fail('That time has already passed');
    if (!hours.same_day) fail('The booking must end on the day it starts');
    let broken = null;
    if (hours.starts < settings.opens_at || hours.ends > settings.closes_at) {
      broken = `The salon books from ${String(settings.opens_at).slice(0, 5)} to ${String(settings.closes_at).slice(0, 5)}.`;
      if (!override) fail(broken, 400, { reason: 'outside_hours', rule: broken });
    }
    let roomId = details?.room_id ? Number(details.room_id) : null;
    if (body.roomId !== undefined) roomId = optionalId(body.roomId, 'Room');
    let room = null;
    if (roomId) room = await salon.lockResource(db, business, roomId, 'room', 'Room');
    if (service.needs_room && !room) fail(`${service.label} needs a room. Choose one.`);
    if (room && Number(room.location_id) !== Number(staff.location_id)) fail(`${room.name} is at another location than ${staff.name}`);
    const away = await salon.staffAvailable(db, business, staff, starts, ends, override);
    broken = [broken, away].filter(Boolean).join(' ') || null;
    const busy = await repo.one(db, `SELECT a.id FROM business_appointments a WHERE a.business_id=$1 AND a.resource_id=$2 AND a.id<>$5
      AND a.status='booked' AND a.starts_at<$4 AND a.ends_at>$3 LIMIT 1`, [business.id, staff.id, starts, ends, appointment.id]);
    if (busy) fail(`${staff.name} already has an appointment at that time`, 409);
    if (room) {
      const taken = await repo.one(db, `SELECT a.id FROM business_appointments a JOIN salon_appointment_details d ON d.business_id=a.business_id AND d.appointment_id=a.id AND d.room_id=$2
        WHERE a.business_id=$1 AND a.id<>$5 AND a.status='booked' AND a.starts_at<$4 AND a.ends_at>$3 LIMIT 1`, [business.id, room.id, starts, ends, appointment.id]);
      if (taken) fail(`${room.name} is already booked at that time`, 409);
    }
    const updated = await repo.one(db, 'UPDATE business_appointments SET resource_id=$3,starts_at=$4,ends_at=$5 WHERE business_id=$1 AND id=$2 RETURNING *',
      [business.id, appointment.id, staff.id, starts, ends]);
    if (details) {
      // A moved booking is confirmed again (the old message names the old time).
      await db.query(`UPDATE salon_appointment_details SET room_id=$3,moved_count=moved_count+1,confirmation_sent_at=NULL,reminder_sent_at=NULL
        WHERE business_id=$1 AND appointment_id=$2`, [business.id, appointment.id, room?.id || null]);
    } else if (room) {
      fail('This booking was made outside the salon calendar; it can be moved to another time or stylist, but not given a room', 409);
    }
    const from = { startsAt: appointment.starts_at, resourceId: Number(appointment.resource_id), roomId: details?.room_id ? Number(details.room_id) : null };
    const to = { startsAt: updated.starts_at, resourceId: Number(staff.id), roomId: room ? Number(room.id) : null };
    if (broken) await salon.recordOverride(db, business, user, appointment.id, 'moved', broken, override);
    await repo.audit(db, business.id, user.id, 'appointment.moved', appointment.id, { from, to, ...(broken ? { override: override.reason } : {}) });
    await repo.event(db, business.id, user.id, 'appointment.moved', 'appointment', appointment.id, { from, to, endsAt: updated.ends_at });
    return { ...updated, room_id: to.roomId, resource_name: staff.name, room_name: room?.name || null };
  });
}

// The client is here (in the chair or waiting): shown on the calendar, and
// the booking no longer shows as late.
async function arrive(business, user, appointmentId) {
  salon.requireSalon(business);
  await access.require(business, 'appointments.edit');
  return repo.transaction(async (db) => {
    const appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(appointmentId, 'Appointment')]);
    await access.requireAppointmentLocation(db, business, appointment);
    if (!appointment) fail('Appointment not found', 404);
    if (appointment.status !== 'booked') fail('Only a booking still to come can be marked arrived', 409);
    const today = await repo.one(db, `SELECT ($2::timestamptz AT TIME ZONE timezone)::date = (now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1`,
      [business.id, appointment.starts_at]);
    if (!today.today) fail('A client can be marked arrived only on the day of the booking', 409);
    const details = await repo.one(db, 'SELECT * FROM salon_appointment_details WHERE business_id=$1 AND appointment_id=$2 FOR UPDATE', [business.id, appointment.id]);
    if (!details) fail('This booking was made outside the salon calendar', 409);
    if (details.arrived_at) return { ...appointment, arrived_at: details.arrived_at, repeated: true };
    const row = await repo.one(db, 'UPDATE salon_appointment_details SET arrived_at=now() WHERE business_id=$1 AND appointment_id=$2 RETURNING arrived_at', [business.id, appointment.id]);
    await repo.audit(db, business.id, user.id, 'appointment.arrived', appointment.id, {});
    await repo.event(db, business.id, user.id, 'appointment.arrived', 'appointment', appointment.id, { arrivedAt: row.arrived_at });
    return { ...appointment, arrived_at: row.arrived_at };
  });
}

// A WhatsApp confirmation or reminder was sent from this person's phone
// (wa.me): recorded so the day's list shows who still needs one.
async function messageSent(business, user, appointmentId, body) {
  salon.requireSalon(business);
  await access.requireAny(business, ['appointments.create', 'appointments.edit']);
  const kind = v.requiredEnum(body.kind, 'Message', ['confirmation', 'reminder']);
  return repo.transaction(async (db) => {
    const appointment = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2', [business.id, id(appointmentId, 'Appointment')]);
    await access.requireAppointmentLocation(db, business, appointment);
    if (!appointment) fail('Appointment not found', 404);
    if (appointment.status !== 'booked') fail('Only a booking still to come gets a confirmation or reminder', 409);
    const column = kind === 'confirmation' ? 'confirmation_sent_at' : 'reminder_sent_at';
    const row = await repo.one(db, `UPDATE salon_appointment_details SET ${column}=now() WHERE business_id=$1 AND appointment_id=$2 RETURNING ${column} AS sent_at`, [business.id, appointment.id]);
    if (!row) fail('This booking was made outside the salon calendar', 409);
    await repo.audit(db, business.id, user.id, `appointment.${kind}_sent`, appointment.id, { channel: 'whatsapp' });
    await repo.event(db, business.id, user.id, `appointment.${kind}_sent`, 'appointment', appointment.id, { channel: 'whatsapp', contactId: appointment.contact_id });
    return { appointmentId: Number(appointment.id), kind, sentAt: row.sent_at };
  });
}

// --- Walk-ins --------------------------------------------------------------------------------

// body: { contactId, skuId, resourceId? (asked for), locationId?, note? }
async function addWalkIn(business, user, body) {
  salon.requireSalon(business);
  await access.require(business, 'appointments.create');
  const note = v.optionalString(body.note, 'Note', 300);
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, id(body.contactId, 'Client')]);
    if (!contact) fail('Client not found', 404);
    const service = await repo.one(db, `SELECT s.id,s.label FROM catalog_skus s JOIN catalog_products p ON p.business_id=s.business_id AND p.id=s.product_id
      WHERE s.business_id=$1 AND s.id=$2 AND s.active AND p.kind='service'`, [business.id, id(body.skuId, 'Service')]);
    if (!service) fail('Service not found', 404);
    const resourceId = optionalId(body.resourceId, 'Stylist');
    let location = optionalId(body.locationId, 'Location');
    if (resourceId) {
      const staff = await salon.lockResource(db, business, resourceId, 'staff', 'Stylist');
      location = location || Number(staff.location_id);
    }
    if (!location) location = Number((await repo.one(db, 'SELECT id FROM business_locations WHERE business_id=$1 AND active ORDER BY id LIMIT 1', [business.id])).id);
    const waiting = await repo.one(db, "SELECT id FROM salon_walk_ins WHERE business_id=$1 AND contact_id=$2 AND status='waiting'", [business.id, contact.id]);
    if (waiting) fail(`${contact.name} is already waiting`, 409);
    const row = await repo.one(db, `INSERT INTO salon_walk_ins(business_id,location_id,contact_id,sku_id,resource_id,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [business.id, location, contact.id, service.id, resourceId, note, user.id]);
    await repo.audit(db, business.id, user.id, 'walk_in.added', row.id, { contact: contact.name, service: service.label });
    await repo.event(db, business.id, user.id, 'walk_in.added', 'walk_in', row.id, { contactId: contact.id, skuId: service.id, resourceId });
    return { ...row, contact_name: contact.name, service_name: service.label };
  });
}

// Seat a walk-in with a stylist: booked from now for the service's time.
// body: { resourceId, roomId?, requestKey }
async function seatWalkIn(business, user, walkInId, body) {
  salon.requireSalon(business);
  await access.require(business, 'appointments.create');
  const walkIn = await repo.one(repo.pool, 'SELECT * FROM salon_walk_ins WHERE business_id=$1 AND id=$2', [business.id, id(walkInId, 'Walk-in')]);
  if (!walkIn) fail('Walk-in not found', 404);
  // From the next whole minute: the booking's start must not be in the past.
  const now = new Date(Math.ceil(Date.now() / 60000) * 60000);
  const bookingBody = { contactId: walkIn.contact_id, skuId: walkIn.sku_id, resourceId: body.resourceId || walkIn.resource_id, roomId: body.roomId || null,
    startsAt: now.toISOString(), notes: walkIn.note || null, requestKey: body.requestKey };
  if (!bookingBody.resourceId) fail('Choose the stylist who will do it');
  const input = await salon.readBooking(business, bookingBody);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM salon_walk_ins WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, walkIn.id]);
    if (current.status === 'seated') {
      const done = await repo.one(db, 'SELECT * FROM business_appointments WHERE business_id=$1 AND id=$2', [business.id, current.appointment_id]);
      return { walkIn: current, appointment: done, repeated: true };
    }
    if (current.status !== 'waiting') fail('This walk-in has left the waiting list', 409);
    const appointment = await salon.bookIn(db, business, user, bookingBody, input, { walkIn: true });
    const row = await repo.one(db, `UPDATE salon_walk_ins SET status='seated',appointment_id=$3,closed_at=now(),closed_by=$4 WHERE business_id=$1 AND id=$2 RETURNING *`,
      [business.id, walkIn.id, appointment.id, user.id]);
    await repo.audit(db, business.id, user.id, 'walk_in.seated', walkIn.id, { appointmentId: appointment.id });
    return { walkIn: row, appointment };
  });
}

async function walkInLeft(business, user, walkInId) {
  salon.requireSalon(business);
  await access.require(business, 'appointments.create');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `UPDATE salon_walk_ins SET status='left',closed_at=now(),closed_by=$3 WHERE business_id=$1 AND id=$2 AND status='waiting' RETURNING *`,
      [business.id, id(walkInId, 'Walk-in'), user.id]);
    if (!row) fail('This walk-in is not waiting any more', 409);
    await repo.audit(db, business.id, user.id, 'walk_in.left', row.id, {});
    return row;
  });
}

// --- The client card -----------------------------------------------------------------------

function dateOrNull(value, name) {
  return value === undefined || value === null || value === '' ? null : core.dateText(value, name);
}
// body: { birthday?, anniversary?, gender?, preferredResourceId?, allergies? }
async function saveProfile(business, user, contactId, body) {
  salon.requireSalon(business);
  await access.require(business, 'contacts.edit');
  const f = {
    birthday: dateOrNull(body.birthday, 'Birthday'), anniversary: dateOrNull(body.anniversary, 'Anniversary'),
    gender: body.gender === undefined || body.gender === null || body.gender === '' ? null : v.requiredEnum(body.gender, 'Gender', ['female', 'male', 'other']),
    preferred: optionalId(body.preferredResourceId, 'Usual stylist'), allergies: v.optionalString(body.allergies, 'Allergies', 300),
  };
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Client')]);
    if (!contact) fail('Client not found', 404);
    if (f.preferred) await salon.lockResource(db, business, f.preferred, 'staff', 'Stylist');
    const row = await repo.one(db, `INSERT INTO salon_client_profiles(business_id,contact_id,birthday,anniversary,gender,preferred_resource_id,allergies,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(business_id,contact_id) DO UPDATE SET birthday=EXCLUDED.birthday,anniversary=EXCLUDED.anniversary,
      gender=EXCLUDED.gender,preferred_resource_id=EXCLUDED.preferred_resource_id,allergies=EXCLUDED.allergies,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, contact.id, f.birthday, f.anniversary, f.gender, f.preferred, f.allergies, user.id]);
    await repo.audit(db, business.id, user.id, 'client.profile_updated', contact.id, f);
    return row;
  });
}

// body: { kind: note | formula, body }
async function addNote(business, user, contactId, body) {
  salon.requireSalon(business);
  await access.require(business, 'contacts.edit');
  const kind = v.requiredEnum(body.kind ?? 'note', 'Kind', ['note', 'formula']);
  const text = v.requiredString(body.body, kind === 'formula' ? 'Colour formula' : 'Note', 500);
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(contactId, 'Client')]);
    if (!contact) fail('Client not found', 404);
    const row = await repo.one(db, 'INSERT INTO salon_client_notes(business_id,contact_id,kind,body,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [business.id, contact.id, kind, text, user.id]);
    await repo.audit(db, business.id, user.id, `client.${kind}_added`, contact.id, { noteId: row.id });
    return row;
  });
}

// --- Stylist leave -----------------------------------------------------------------------

// body: { fromDate, toDate, reason? }. Bookings in those dates must be moved first.
async function addLeave(business, user, resourceId, body) {
  salon.requireSalon(business);
  await access.require(business, 'appointments.create');
  const from = core.dateText(body.fromDate, 'From'), to = core.dateText(body.toDate ?? body.fromDate, 'To');
  if (to < from) fail('Leave must end on or after the day it starts');
  const reason = v.optionalString(body.reason, 'Reason', 200);
  return repo.transaction(async (db) => {
    const staff = await salon.lockResource(db, business, id(resourceId, 'Stylist'), 'staff', 'Stylist');
    const booked = await repo.one(db, `SELECT count(*)::int AS n FROM business_appointments a JOIN businesses b ON b.id=a.business_id
      WHERE a.business_id=$1 AND a.resource_id=$2 AND a.status='booked' AND (a.starts_at AT TIME ZONE b.timezone)::date BETWEEN $3::date AND $4::date`, [business.id, staff.id, from, to]);
    if (booked.n) fail(`${staff.name} has ${booked.n} booking${booked.n === 1 ? '' : 's'} in those dates. Move ${booked.n === 1 ? 'it' : 'them'} to another stylist first.`, 409);
    const overlap = await repo.one(db, `SELECT id FROM salon_staff_leave WHERE business_id=$1 AND resource_id=$2 AND cancelled_at IS NULL AND from_date <= $4::date AND to_date >= $3::date`,
      [business.id, staff.id, from, to]);
    if (overlap) fail(`${staff.name} already has leave in those dates`, 409);
    const row = await repo.one(db, 'INSERT INTO salon_staff_leave(business_id,resource_id,from_date,to_date,reason,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [business.id, staff.id, from, to, reason, user.id]);
    await repo.audit(db, business.id, user.id, 'staff.leave_added', staff.id, { from, to, reason });
    return row;
  });
}
async function cancelLeave(business, user, resourceId, leaveId) {
  salon.requireSalon(business);
  await access.require(business, 'appointments.create');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `UPDATE salon_staff_leave SET cancelled_at=now(),cancelled_by=$4 WHERE business_id=$1 AND resource_id=$2 AND id=$3 AND cancelled_at IS NULL RETURNING *`,
      [business.id, id(resourceId, 'Stylist'), id(leaveId, 'Leave'), user.id]);
    if (!row) fail('Leave not found', 404);
    await repo.audit(db, business.id, user.id, 'staff.leave_cancelled', row.resource_id, { leaveId: row.id });
    return row;
  });
}

// --- Packages: extend ----------------------------------------------------------------------

// body: { endsOn, reason }. A later end date only; audited with the reason.
async function extendClientPlan(business, user, clientPlanId, body) {
  salon.requireSalon(business);
  if (!business.modules.includes('packages')) fail('Packages & memberships is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
  await access.require(business, 'packages.edit');
  const endsOn = core.dateText(body.endsOn, 'New end date');
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const held = await repo.one(db, 'SELECT * FROM salon_client_plans WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(clientPlanId, 'Package or membership')]);
    if (!held) fail('Package or membership not found', 404);
    if (held.status !== 'active') fail(`${held.name} was cancelled`, 409);
    const old = String(held.ends_on instanceof Date ? held.ends_on.toISOString() : held.ends_on).slice(0, 10);
    const check = await repo.one(db, 'SELECT $1::date > $2::date AS later, $1::date - $3::date AS span', [endsOn, held.ends_on, held.starts_on]);
    if (!check.later) fail(`Choose a date after ${old}`);
    if (check.span > 3650) fail('A plan can run for at most ten years');
    const row = await repo.one(db, 'UPDATE salon_client_plans SET ends_on=$3 WHERE business_id=$1 AND id=$2 RETURNING *', [business.id, held.id, endsOn]);
    await repo.audit(db, business.id, user.id, `${held.kind}.extended`, held.id, { from: old, to: endsOn, reason });
    await repo.event(db, business.id, user.id, `${held.kind}.extended`, 'client_plan', held.id, { contactId: held.contact_id, from: old, to: endsOn, reason });
    return row;
  });
}

// What the salon still owes clients on packages: active plans, sessions not
// used yet (at the package's price per session) and plans expiring soon.
async function planTotals(business) {
  salon.requireSalon(business);
  await access.require(business, 'packages.view');
  return repo.one(repo.pool, `WITH held AS (
      SELECT cp.*,(SELECT COALESCE(sum(s.sessions),0) FROM salon_client_plan_services s WHERE s.business_id=cp.business_id AND s.client_plan_id=cp.id)::int AS sessions,
        (SELECT COALESCE(sum(r.quantity),0) FROM salon_package_redemptions r WHERE r.business_id=cp.business_id AND r.client_plan_id=cp.id)::int AS used,
        l.net AS line_net
      FROM salon_client_plans cp JOIN businesses b ON b.id=cp.business_id
      JOIN business_document_lines l ON l.business_id=cp.business_id AND l.id=cp.line_id
      WHERE cp.business_id=$1 AND cp.status='active' AND cp.ends_on >= (now() AT TIME ZONE b.timezone)::date)
    SELECT count(*)::int AS active,
      COALESCE(sum(GREATEST(sessions-used,0)) FILTER (WHERE kind='package'),0)::int AS sessions_left,
      COALESCE(sum(round(line_net*GREATEST(sessions-used,0)/NULLIF(sessions,0),2)) FILTER (WHERE kind='package'),0) AS sessions_left_value,
      count(*) FILTER (WHERE ends_on <= (SELECT (now() AT TIME ZONE timezone)::date + 30 FROM businesses WHERE id=$1))::int AS expiring_30
    FROM held`, [business.id]);
}

module.exports = {
  move, arrive, messageSent, addWalkIn, seatWalkIn, walkInLeft, saveProfile, addNote, addLeave, cancelLeave, extendClientPlan, planTotals,
};
