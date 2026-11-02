const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const orders = require('./shopOrders.service');

// Complaints about online orders (E-Commerce Rules 2020 r.4(5)): "Report a
// problem" on the order's page opens one with a ticket number; staff
// acknowledge it within 48 hours and resolve it within a month, and the bell
// warns from 24 hours unacknowledged. Defective, wrong, expired or late goods
// are taken back through the bill's returns (Sales history).

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const KINDS = ['missing', 'wrong', 'damaged', 'expired', 'quality', 'late', 'billing', 'other'];
const KIND_WORDS = {
  missing: 'Something was missing', wrong: 'Wrong item', damaged: 'Damaged or leaking', expired: 'Past its expiry', quality: 'Poor quality',
  late: 'Came late', billing: 'Charged wrongly', other: 'Something else',
};
const OUTCOMES = ['taken_back', 'refunded', 'replaced', 'explained', 'other'];
const OUTCOME_WORDS = { taken_back: 'Taken back', refunded: 'Refunded', replaced: 'Replaced', explained: 'Explained to the customer', other: 'Other' };
const CLIENT_KEY = /^[A-Za-z0-9-]{8,64}$/;
const MAX_OPEN = 3;

// A guest's complaint on their order's page.
async function open(guestToken, body = {}) {
  if (typeof body.clientKey !== 'string' || !CLIENT_KEY.test(body.clientKey)) fail('This page sent a complaint it cannot recognise. Reload the page and try again.');
  const kind = v.requiredEnum(body.kind, 'What went wrong', KINDS);
  const details = v.requiredString(body.details, 'Tell the shop what happened', 1000);
  return repo.transaction(async (db) => {
    const order = await orders.loadByGuestToken(db, guestToken, { lock: true });
    const again = await repo.one(db, 'SELECT * FROM shop_complaints WHERE order_id=$1 AND client_key=$2', [order.id, body.clientKey]);
    if (again) {
      if (again.kind !== kind || again.details !== details) fail('This complaint was already sent with other words. Reload the page to see it.', 409, { reason: 'key_reused' });
      return orders.guestAnswer(db, guestToken);
    }
    const waiting = await repo.one(db, "SELECT count(*)::int AS n FROM shop_complaints WHERE order_id=$1 AND status<>'resolved'", [order.id]);
    if (waiting.n >= MAX_OPEN) fail('This order already has 3 complaints the shop is looking into. Please call the shop.', 409, { reason: 'too_many' });
    const ticketNo = await orders.nextNumber(db, order.business_id, 'complaint');
    const row = await repo.one(db, `INSERT INTO shop_complaints(business_id,location_id,order_id,contact_id,ticket_no,client_key,kind,details,acknowledge_by,resolve_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '48 hours',now()+interval '1 month') RETURNING id`,
    [order.business_id, order.location_id, order.id, order.contact_id, ticketNo, body.clientKey, kind, details]);
    await db.query('UPDATE shop_orders SET revision=revision+1,updated_at=now() WHERE id=$1', [order.id]);
    await repo.guestAudit(db, order.business_id, 'online_complaint.opened', row.id, { ticketNo, orderNo: order.order_no, kind });
    return orders.guestAnswer(db, guestToken);
  });
}

// The complaints, open ones first, each with its clocks.
async function list(business, { status: wanted, q } = {}) {
  await access.require(business, 'online_shop.view');
  const values = [business.id];
  const where = [];
  if (wanted === 'open') where.push("c.status<>'resolved'");
  if (wanted === 'resolved') where.push("c.status='resolved'");
  if (business.location_scope) { values.push(business.location_scope); where.push(`c.location_id=$${values.length}`); }
  if (q) {
    values.push(`%${String(q).trim().slice(0, 60).replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
    where.push(`concat_ws(' ',c.ticket_no,o.order_no,o.guest_name,o.guest_mobile) ILIKE $${values.length}`);
  }
  const rows = await repo.all(repo.pool, `SELECT c.*,o.order_no,o.guest_name,o.guest_mobile,o.id AS order_id,o.document_id,l.name AS location_name,
      ua.name AS acknowledged_by_name,ur.name AS resolved_by_name,now() AS server_time
    FROM shop_complaints c JOIN shop_orders o ON o.business_id=c.business_id AND o.id=c.order_id
    JOIN business_locations l ON l.business_id=c.business_id AND l.id=c.location_id
    LEFT JOIN users ua ON ua.id=c.acknowledged_by LEFT JOIN users ur ON ur.id=c.resolved_by
    WHERE c.business_id=$1 ${where.map((w) => `AND ${w}`).join(' ')}
    ORDER BY (c.status='resolved'),c.created_at DESC LIMIT 200`, values);
  return {
    complaints: rows.map((row) => ({
      id: Number(row.id), ticketNo: row.ticket_no, orderId: Number(row.order_id), orderNo: row.order_no, documentId: row.document_id ? Number(row.document_id) : null,
      name: row.guest_name, mobile: row.guest_mobile, locationName: row.location_name, kind: row.kind, kindWords: KIND_WORDS[row.kind], details: row.details, status: row.status,
      createdAt: row.created_at, acknowledgeBy: row.acknowledge_by, resolveBy: row.resolve_by, acknowledgedAt: row.acknowledged_at, acknowledgement: row.acknowledgement,
      acknowledgedBy: row.acknowledged_by_name, resolvedAt: row.resolved_at, resolvedBy: row.resolved_by_name, outcome: row.outcome, outcomeWords: OUTCOME_WORDS[row.outcome] || null,
      resolution: row.resolution,
    })),
    serverTime: rows[0]?.server_time || new Date().toISOString(),
    kinds: KIND_WORDS, outcomes: OUTCOME_WORDS,
  };
}

async function lockComplaint(db, business, complaintId) {
  const row = await repo.one(db, 'SELECT * FROM shop_complaints WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, v.requiredId(complaintId, 'Complaint')]);
  if (!row) fail('Complaint not found', 404);
  access.requireLocation(business, row.location_id);
  return row;
}

// Acknowledged: the customer is told who has it and what happens next.
async function acknowledge(business, user, complaintId, body = {}) {
  await access.require(business, 'online_shop.review');
  const note = v.requiredString(body.note, 'What you tell the customer', 500);
  return repo.transaction(async (db) => {
    const row = await lockComplaint(db, business, complaintId);
    if (row.status !== 'open') fail(row.status === 'resolved' ? 'This complaint is already resolved' : 'This complaint is already acknowledged', 409);
    await db.query("UPDATE shop_complaints SET status='acknowledged',acknowledged_at=now(),acknowledged_by=$2,acknowledgement=$3 WHERE id=$1", [row.id, user.id, note]);
    await db.query('UPDATE shop_orders SET revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, row.order_id]);
    await repo.audit(db, business.id, user.id, 'online_complaint.acknowledged', row.id, { ticketNo: row.ticket_no });
    return { id: Number(row.id), status: 'acknowledged' };
  });
}

// Resolved, with what was done (an item taken back goes through the bill's returns first).
async function resolve(business, user, complaintId, body = {}) {
  await access.require(business, 'online_shop.review');
  const outcome = v.requiredEnum(body.outcome, 'What was done', OUTCOMES);
  const resolution = v.requiredString(body.resolution, 'What you tell the customer', 1000);
  return repo.transaction(async (db) => {
    const row = await lockComplaint(db, business, complaintId);
    if (row.status === 'resolved') fail('This complaint is already resolved', 409);
    await db.query(`UPDATE shop_complaints SET status='resolved',acknowledged_at=COALESCE(acknowledged_at,now()),acknowledged_by=COALESCE(acknowledged_by,$2),
      resolved_at=now(),resolved_by=$2,outcome=$3,resolution=$4 WHERE id=$1`, [row.id, user.id, outcome, resolution]);
    await db.query('UPDATE shop_orders SET revision=revision+1,updated_at=now() WHERE business_id=$1 AND id=$2', [business.id, row.order_id]);
    await repo.audit(db, business.id, user.id, 'online_complaint.resolved', row.id, { ticketNo: row.ticket_no, outcome });
    return { id: Number(row.id), status: 'resolved' };
  });
}

// --- Mobiles blocked from ordering online ----------------------------------------------------------

async function blocked(business) {
  await access.require(business, 'online_shop.view');
  const rows = await repo.all(repo.pool, `SELECT m.*,u.name AS blocked_by_name,(SELECT count(*)::int FROM shop_orders o WHERE o.business_id=m.business_id AND o.guest_mobile=m.mobile) AS orders
    FROM shop_blocked_mobiles m JOIN users u ON u.id=m.blocked_by WHERE m.business_id=$1 AND m.lifted_at IS NULL ORDER BY m.blocked_at DESC`, [business.id]);
  return { blocked: rows.map((row) => ({ id: Number(row.id), mobile: row.mobile, reason: row.reason, blockedAt: row.blocked_at, blockedBy: row.blocked_by_name, orders: row.orders })) };
}

async function block(business, user, body = {}) {
  await access.require(business, 'online_shop.manage');
  const { readGuestMobile } = require('../../guests');
  const mobile = readGuestMobile(body.mobile);
  const reason = v.requiredString(body.reason, 'Reason', 300);
  return repo.transaction(async (db) => {
    const row = await repo.one(db, `INSERT INTO shop_blocked_mobiles(business_id,mobile,reason,blocked_by) VALUES($1,$2,$3,$4)
      ON CONFLICT (business_id,mobile) WHERE lifted_at IS NULL DO NOTHING RETURNING id`, [business.id, mobile, reason, user.id]);
    if (!row) fail(`${mobile} is already blocked from ordering online`, 409);
    await repo.audit(db, business.id, user.id, 'online_shop.mobile_blocked', row.id, { mobile: `******${mobile.slice(-4)}` });
    return { id: Number(row.id), mobile };
  });
}

async function lift(business, user, blockId) {
  await access.require(business, 'online_shop.manage');
  return repo.transaction(async (db) => {
    const row = await repo.one(db, 'UPDATE shop_blocked_mobiles SET lifted_at=now(),lifted_by=$3 WHERE business_id=$1 AND id=$2 AND lifted_at IS NULL RETURNING id,mobile',
      [business.id, v.requiredId(blockId, 'Blocked mobile'), user.id]);
    if (!row) fail('That mobile is not blocked', 404);
    await repo.audit(db, business.id, user.id, 'online_shop.mobile_unblocked', row.id, { mobile: `******${row.mobile.slice(-4)}` });
    return { id: Number(row.id), lifted: true };
  });
}

module.exports = { open, list, acknowledge, resolve, blocked, block, lift, KINDS, KIND_WORDS, OUTCOMES, OUTCOME_WORDS };
