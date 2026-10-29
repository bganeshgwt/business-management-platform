const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
const housekeeping = require('./lodgingHousekeeping.service');

// Maintenance tickets (module "lodging"): a room's issue, its priority, the
// member of staff it is given to, when the work started and ended, and the
// out-of-order period it needs, if any (booked with the ticket: the room is
// off sale those nights). A ticket is open, then in progress, then done, or cancelled while not
// done; done or cancelled, the room is put back in order (its period ends
// last night, or is withdrawn if it had not begun). Listed by status and
// priority. Tasks can still hold the rounds; a ticket is a room's own repair.

const { fail, id } = c;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUS_WORDS = { open: 'open', in_progress: 'in progress', done: 'done', cancelled: 'cancelled' };

const TICKETS_SQL = `SELECT k.id,k.ticket_no,k.room_id,r.room_no,r.location_id,l.name AS location_name,ts.label AS room_type,k.issue,k.priority,k.status,k.assigned_to,
    au.name AS assigned_name,k.started_at,su.name AS started_by_name,k.finished_at,fu.name AS finished_by_name,k.outcome,k.out_of_order_id,o.starts_on::text AS out_of_order_from,
    o.ends_on::text AS out_of_order_to,(o.cancelled_at IS NOT NULL) AS out_of_order_withdrawn,k.created_at,cu.name AS created_by_name,k.updated_at,
    CASE k.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'done' THEN 2 ELSE 3 END AS status_rank,
    CASE k.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END AS priority_rank,(k.status IN ('open','in_progress')) AS open
  FROM lodging_tickets k JOIN lodging_rooms r ON r.business_id=k.business_id AND r.id=k.room_id
  JOIN business_locations l ON l.business_id=r.business_id AND l.id=r.location_id
  JOIN lodging_room_types t ON t.business_id=r.business_id AND t.id=r.room_type_id JOIN catalog_skus ts ON ts.business_id=t.business_id AND ts.id=t.sku_id
  JOIN users cu ON cu.id=k.created_by LEFT JOIN users au ON au.id=k.assigned_to LEFT JOIN users su ON su.id=k.started_by LEFT JOIN users fu ON fu.id=k.finished_by
  LEFT JOIN lodging_out_of_order o ON o.business_id=k.business_id AND o.id=k.out_of_order_id
  WHERE k.business_id=$1`;

repo.addLists({
  // Every ticket: the open ones first (in progress, then open), by priority (urgent first), the newest first.
  'lodging-tickets': { sql: TICKETS_SQL, search: ['ticket_no', 'room_no', 'issue', 'assigned_name', 'outcome'], date: 'created_at',
    filters: { status: 'status', priority: 'priority', room: 'room_id', location: 'location_id', open: 'open', assigned: 'assigned_to' },
    order: 'status_rank,priority_rank,id DESC' },
});

const ticketRow = (db, business, ticketId) => repo.one(db, `SELECT * FROM (${TICKETS_SQL}) x WHERE x.id=$2`, [business.id, ticketId]);

// The members a ticket may be given to: those who look after the rooms (lodging.edit), with the owner.
async function staff(business) {
  c.requireLodging(business);
  await access.require(business, 'lodging.view');
  return repo.all(repo.pool, `SELECT u.id,u.name FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code='lodging.edit'))
    ORDER BY u.name`, [business.id]);
}
// A member of this business who looks after the rooms, or null when none is given.
async function assignee(db, business, value) {
  if (!c.given(value)) return null;
  const person = await repo.one(db, `SELECT u.id,u.name FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND u.id=$2 AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id
      AND p.permission_code='lodging.edit'))`, [business.id, id(value, 'Given to')]);
  if (!person) fail('A ticket is given to a member of staff who looks after the rooms', 404);
  return person;
}

// body: { requestKey, roomId, issue, priority? (normal), assignedTo?, outOfOrder?: { startsOn? (today), endsOn? (none: until the work is done), reason? (the issue) } }
async function create(business, user, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const issue = v.requiredString(typeof body.issue === 'string' ? body.issue : '', 'The issue', 500);
  const priority = v.requiredEnum(body.priority ?? 'normal', 'Priority', PRIORITIES);
  const down = body.outOfOrder && typeof body.outOfOrder === 'object' && !Array.isArray(body.outOfOrder) ? body.outOfOrder : null;
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const old = await repo.one(db, 'SELECT id,request_hash FROM lodging_tickets WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash) fail('This request key was already used for different data', 409);
      return { ticket: await ticketRow(db, business, old.id), repeated: true };
    }
    const room = await repo.one(db, 'SELECT * FROM lodging_rooms WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(body.roomId, 'Room')]);
    if (!room) fail('Room not found', 404);
    access.requireLocation(business, room.location_id);
    if (!room.active) fail(`Room ${room.room_no} is out of use`, 409);
    const person = await assignee(db, business, body.assignedTo);
    const period = down ? await housekeeping.bookIn(db, business, user, room, housekeeping.readPeriod({ ...down, reason: c.given(down.reason) ? down.reason : issue },
      await c.today(db, business))) : null;
    const number = (await repo.one(db, 'SELECT COALESCE(max(ticket_no),0)+1 AS n FROM lodging_tickets WHERE business_id=$1', [business.id])).n;
    const row = await repo.one(db, `INSERT INTO lodging_tickets(business_id,ticket_no,room_id,issue,priority,status,assigned_to,out_of_order_id,request_key,request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$10) RETURNING id`, [business.id, number, room.id, issue, priority, person?.id || null, period?.id || null, requestKey, hash, user.id]);
    const details = { ticketNo: number, roomNo: room.room_no, issue, priority, assignedTo: person?.name || null,
      ...(period ? { outOfOrder: { from: period.starts_on, to: period.ends_on } } : {}) };
    await repo.audit(db, business.id, user.id, 'lodging_ticket.opened', row.id, details);
    await repo.event(db, business.id, user.id, 'lodging_ticket.opened', 'lodging_ticket', row.id, { ...details, roomId: room.id, locationId: room.location_id });
    return { ticket: await ticketRow(db, business, row.id), repeated: false };
  });
}

// A ticket of this business, locked, at a location the person works at.
async function lockTicket(db, business, ticketId) {
  await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
  const ticket = await repo.one(db, `SELECT k.*,r.room_no,r.location_id FROM lodging_tickets k JOIN lodging_rooms r ON r.business_id=k.business_id AND r.id=k.room_id
    WHERE k.business_id=$1 AND k.id=$2 FOR UPDATE OF k`, [business.id, id(ticketId, 'Ticket')]);
  if (!ticket) fail('Ticket not found', 404);
  access.requireLocation(business, ticket.location_id);
  return ticket;
}

// body: { issue?, priority?, assignedTo? (null: no one) } — while it is open or in progress.
async function update(business, user, ticketId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  return repo.transaction(async (db) => {
    const ticket = await lockTicket(db, business, ticketId);
    if (['done', 'cancelled'].includes(ticket.status)) fail(`Ticket ${ticket.ticket_no} is ${STATUS_WORDS[ticket.status]} and no longer changes`, 409);
    const issue = body.issue === undefined ? ticket.issue : v.requiredString(typeof body.issue === 'string' ? body.issue : '', 'The issue', 500);
    const priority = body.priority === undefined ? ticket.priority : v.requiredEnum(body.priority, 'Priority', PRIORITIES);
    const person = body.assignedTo === undefined ? (ticket.assigned_to ? { id: ticket.assigned_to } : null) : await assignee(db, business, body.assignedTo);
    await db.query('UPDATE lodging_tickets SET issue=$3,priority=$4,assigned_to=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND id=$2',
      [business.id, ticket.id, issue, priority, person?.id || null, user.id]);
    await repo.audit(db, business.id, user.id, 'lodging_ticket.changed', ticket.id, { ticketNo: ticket.ticket_no, roomNo: ticket.room_no,
      ...(issue !== ticket.issue ? { issue: { from: ticket.issue, to: issue } } : {}), ...(priority !== ticket.priority ? { priority: { from: ticket.priority, to: priority } } : {}),
      ...(Number(person?.id || 0) !== Number(ticket.assigned_to || 0) ? { assignedTo: { from: ticket.assigned_to, to: person?.id || null } } : {}) });
    return { ticket: await ticketRow(db, business, ticket.id) };
  });
}

// The work started (open → in progress), done (with what was done) or the ticket cancelled (with why). Done or cancelled, the room's
// out-of-order period ends (last night) unless `keepOutOfOrder`. Asked again, the same step is the answer. body: { outcome?, reason?, keepOutOfOrder? }
async function step(business, user, ticketId, to, body = {}) {
  c.requireLodging(business);
  await access.require(business, 'lodging.edit');
  const outcome = to === 'cancelled' ? v.requiredString(typeof body.reason === 'string' ? body.reason : '', 'Why it is cancelled', 500)
    : to === 'done' ? c.optionalText(body.outcome, 'What was done', 500) : null;
  const keep = v.requiredBoolean(body.keepOutOfOrder, 'Keep it out of order', false);
  return repo.transaction(async (db) => {
    const ticket = await lockTicket(db, business, ticketId);
    if (ticket.status === to) return { ticket: await ticketRow(db, business, ticket.id), repeated: true };
    if (['done', 'cancelled'].includes(ticket.status)) fail(`Ticket ${ticket.ticket_no} is ${STATUS_WORDS[ticket.status]} and no longer changes`, 409);
    if (to === 'in_progress' && ticket.status !== 'open') fail(`Ticket ${ticket.ticket_no} is ${STATUS_WORDS[ticket.status]}`, 409);
    const starts = to === 'in_progress' || (to === 'done' && !ticket.started_at);
    await db.query(`UPDATE lodging_tickets SET status=$3,started_at=CASE WHEN $4 THEN now() ELSE started_at END,started_by=CASE WHEN $4 THEN $5::bigint ELSE started_by END,
        finished_at=CASE WHEN $3 IN ('done','cancelled') THEN now() END,finished_by=CASE WHEN $3 IN ('done','cancelled') THEN $5::bigint END,outcome=COALESCE($6,outcome),
        updated_by=$5,updated_at=now() WHERE business_id=$1 AND id=$2`, [business.id, ticket.id, to, starts, user.id, outcome]);
    let back = null;
    if (['done', 'cancelled'].includes(to) && ticket.out_of_order_id && !keep) {
      back = await housekeeping.backInOrderIn(db, business, user, ticket.out_of_order_id, `Ticket ${ticket.ticket_no} ${STATUS_WORDS[to]}`);
    }
    const action = { in_progress: 'lodging_ticket.started', done: 'lodging_ticket.done', cancelled: 'lodging_ticket.cancelled' }[to];
    const details = { ticketNo: ticket.ticket_no, roomNo: ticket.room_no, from: ticket.status, to, ...(outcome ? { outcome } : {}), ...(back ? { backInOrder: true } : {}) };
    await repo.audit(db, business.id, user.id, action, ticket.id, details);
    await repo.event(db, business.id, user.id, action, 'lodging_ticket', ticket.id, { ...details, roomId: ticket.room_id });
    return { ticket: await ticketRow(db, business, ticket.id), repeated: false };
  });
}

module.exports = { PRIORITIES, staff, create, update, step };
