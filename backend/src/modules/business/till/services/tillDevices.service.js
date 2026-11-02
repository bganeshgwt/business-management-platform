const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');

// The tills of a business (docs/BUSINESS_RULES.md › Offline till): a computer
// or tablet at one location that may bill when the internet drops. A manager
// sets one up on the counter itself ("Set up offline billing on this
// computer"): it is named, given the next code (T1, T2 …, never reused) and a
// secret of 256 bits that the device keeps; only its SHA-256 is stored. The
// till sends the secret with every snapshot, report and bill
// (X-Till-Token), so a bill with a till's number and time can only come from
// that till. Settings › Tills lists them live with what each last reported,
// renames them and retires them: never while bills wait on one, unless it is
// lost (its unsent numbers are then noted as lost, for GSTR-1).

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

const DEFAULTS = { warn_hours: 12, stop_hours: 72, waiting_cap: 2000, upi_id: null, upi_payee: null };
// A cashier's till routes need the application on, besides their own sales permission.
function requireModule(business) {
  if (!business.modules.includes('offline_till')) fail('Offline till is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}
// A till is "online" when it reported within this time.
const ONLINE_MS = 3 * 60_000;

// The till on whose behalf a request comes: from its secret, at this
// business, not retired. Refusals are the till's to show ("needs attention").
async function fromToken(db, business, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    fail('This computer is not set up as an offline till of this business. Set it up again from Quick bill.', 409, { reason: 'till_unknown' });
  }
  const device = await repo.one(db, `SELECT d.*,u.name AS retired_by_name FROM business_devices d LEFT JOIN users u ON u.id=d.retired_by
    WHERE d.token_hash=$1`, [sha256(token)]);
  if (!device || Number(device.business_id) !== Number(business.id)) {
    fail('This computer is not set up as an offline till of this business. Set it up again from Quick bill.', 409, { reason: 'till_unknown' });
  }
  if (device.retired_at) {
    fail(`Till ${device.code} (${device.name}) was retired${device.retired_by_name ? ` by ${device.retired_by_name}` : ''}: ${device.retire_reason}. Its bills cannot be sent from it.`,
      409, { reason: 'till_retired', lost: device.lost });
  }
  access.requireLocation(business, device.location_id);
  return device;
}

async function settings(db, businessId) {
  const row = await repo.one(db, 'SELECT * FROM business_till_settings WHERE business_id=$1', [businessId]);
  return { ...DEFAULTS, ...(row || {}) };
}
const settingsShape = (row) => ({ warnHours: Number(row.warn_hours), stopHours: Number(row.stop_hours), waitingCap: Number(row.waiting_cap),
  upiId: row.upi_id || null, upiPayee: row.upi_payee || null });

// What Settings › Tills shows of a till: who set it up, what it last reported,
// whether it is online now, and its bills received and still to review.
const LIST_SQL = `SELECT d.id,d.location_id,d.kind,d.name,d.code,d.registered_at,d.last_seen_at,d.last_sync_at,d.pending_count,d.attention_count,
    d.oldest_pending_at,d.offline_since,d.last_year,d.last_seq,d.app_version,d.retired_at,d.retire_reason,d.lost,
    l.name AS location_name,r.name AS registered_by_name,x.name AS retired_by_name,
    (SELECT count(*)::int FROM business_till_bills b WHERE b.business_id=d.business_id AND b.device_id=d.id) AS received,
    (SELECT count(DISTINCT f.till_bill_id)::int FROM business_till_flags f JOIN business_till_bills b ON b.business_id=f.business_id AND b.id=f.till_bill_id
      WHERE f.business_id=d.business_id AND b.device_id=d.id AND f.acknowledged_at IS NULL) AS to_review,
    (SELECT count(*)::int FROM business_till_gaps g WHERE g.business_id=d.business_id AND g.device_id=d.id AND g.state='missing') AS missing
  FROM business_devices d JOIN business_locations l ON l.business_id=d.business_id AND l.id=d.location_id
  JOIN users r ON r.id=d.registered_by LEFT JOIN users x ON x.id=d.retired_by`;

function shape(row, now = Date.now()) {
  const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : null;
  const status = row.retired_at ? 'retired' : seen && now - seen <= ONLINE_MS ? 'online' : 'offline';
  return { ...row, status, online: status === 'online' };
}

async function list(business, query = {}) {
  await access.require(business, 'offline_till.view');
  const location = query.location ? id(query.location, 'Location') : (business.location_scope || null);
  if (location) access.requireLocation(business, location);
  const rows = await repo.all(repo.pool, `${LIST_SQL} WHERE d.business_id=$1 AND ($2::bigint IS NULL OR d.location_id=$2)
    ORDER BY (d.retired_at IS NOT NULL), d.location_id, d.code`, [business.id, location]);
  const now = Date.now();
  return { items: rows.map((row) => shape(row, now)), settings: settingsShape(await settings(repo.pool, business.id)), serverTime: new Date(now).toISOString() };
}

const readName = (value) => {
  const name = v.requiredString(value, 'Till name', 60);
  if (!name.trim()) fail('Give the till a name, such as "Counter 1"');
  return name.trim();
};

// "Set up offline billing on this computer": the till, its code and its secret
// (shown once, kept by the device).
async function register(business, user, body) {
  await access.require(business, 'offline_till.manage');
  const name = readName(body.name);
  const locationId = id(body.locationId, 'Counter location');
  access.requireLocation(business, locationId);
  const token = crypto.randomBytes(32).toString('base64url');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const location = await repo.one(db, 'SELECT id,name,active,sells_at_counter FROM business_locations WHERE business_id=$1 AND id=$2', [business.id, locationId]);
    if (!location || !location.active) fail('Counter location not found or closed', 404);
    if (location.sells_at_counter === false) fail(`${location.name} does not sell at the counter, so it has no till`, 409);
    // The next code, never one a till (even a retired one) had: its numbers stay its own.
    const last = await repo.one(db, "SELECT COALESCE(max(substr(code,2)::int),0) AS n FROM business_devices WHERE business_id=$1", [business.id]);
    const code = `T${Number(last.n) + 1}`;
    if (code.length > 4) fail('This business has used every till code from T1 to T999', 409);
    const device = await repo.one(db, `INSERT INTO business_devices(business_id,location_id,name,code,token_hash,registered_by,last_seen_at)
      VALUES($1,$2,$3,$4,$5,$6,now()) RETURNING *`, [business.id, locationId, name, code, sha256(token), user.id]);
    await repo.audit(db, business.id, user.id, 'till.registered', device.id, { code, name, locationId });
    const row = await repo.one(db, `${LIST_SQL} WHERE d.business_id=$1 AND d.id=$2`, [business.id, device.id]);
    return { device: shape(row), token, settings: settingsShape(await settings(db, business.id)) };
  });
}

async function rename(business, user, deviceId, body) {
  await access.require(business, 'offline_till.manage');
  const name = readName(body.name);
  return repo.transaction(async (db) => {
    const device = await repo.one(db, 'SELECT * FROM business_devices WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(deviceId, 'Till')]);
    if (!device) fail('Till not found', 404);
    access.requireLocation(business, device.location_id);
    if (device.retired_at) fail('This till is retired', 409);
    await db.query('UPDATE business_devices SET name=$3 WHERE business_id=$1 AND id=$2', [business.id, device.id, name]);
    await repo.audit(db, business.id, user.id, 'till.renamed', device.id, { from: device.name, to: name });
    return shape(await repo.one(db, `${LIST_SQL} WHERE d.business_id=$1 AND d.id=$2`, [business.id, device.id]));
  });
}

// Retiring a till: never while bills wait on it (they would be refused once it
// is retired), unless it is lost or broken, when the numbers it said it used
// and that never arrived are noted as lost for GSTR-1.
async function retire(business, user, deviceId, body) {
  await access.require(business, 'offline_till.manage');
  const reason = v.requiredString(body.reason, 'Reason', 300).trim();
  if (!reason) fail('Say why the till is retired');
  const lost = v.requiredBoolean(body.lost, 'Lost or broken', false);
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const device = await repo.one(db, 'SELECT * FROM business_devices WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(deviceId, 'Till')]);
    if (!device) fail('Till not found', 404);
    access.requireLocation(business, device.location_id);
    if (device.retired_at) fail('This till is already retired', 409);
    const waiting = Number(device.pending_count) + Number(device.attention_count);
    if (waiting > 0 && !lost) {
      fail(`${waiting} ${waiting === 1 ? 'bill waits' : 'bills wait'} on till ${device.code} to be sent. Send ${waiting === 1 ? 'it' : 'them'} from the till first (its till panel on Quick bill has Send now), or retire it as lost or broken.`,
        409, { reason: 'till_waiting', waiting });
    }
    await db.query('UPDATE business_devices SET retired_at=now(),retired_by=$3,retire_reason=$4,lost=$5 WHERE business_id=$1 AND id=$2',
      [business.id, device.id, user.id, reason, lost]);
    const noted = lost ? await require('./tillBills.service').markLost(db, business, device) : 0;
    await repo.audit(db, business.id, user.id, 'till.retired', device.id, { code: device.code, reason, lost, ...(noted ? { numbersLost: noted } : {}) });
    return { ...shape(await repo.one(db, `${LIST_SQL} WHERE d.business_id=$1 AND d.id=$2`, [business.id, device.id])), numbersLost: noted };
  });
}

async function readSettings(business) {
  await access.require(business, 'offline_till.view');
  return settingsShape(await settings(repo.pool, business.id));
}

const hours = (value, name, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 120) fail(`${name} must be a whole number of hours from 1 to 120`);
  return n;
};
async function saveSettings(business, user, body) {
  await access.require(business, 'offline_till.manage');
  return repo.transaction(async (db) => {
    const current = await settings(db, business.id);
    const warn = hours(body.warnHours, 'Warn after', Number(current.warn_hours));
    const stop = hours(body.stopHours, 'Stop after', Number(current.stop_hours));
    if (warn > stop) fail('The warning comes before the stop: warn after fewer hours than the till stops');
    const cap = body.waitingCap === undefined || body.waitingCap === null || body.waitingCap === '' ? Number(current.waiting_cap) : Number(body.waitingCap);
    if (!Number.isInteger(cap) || cap < 50 || cap > 2000) fail('Bills waiting on a till must be a whole number from 50 to 2,000');
    let upiId = body.upiId === undefined ? current.upi_id : v.optionalString(body.upiId, 'UPI ID', 100);
    if (upiId) {
      upiId = upiId.trim();
      if (!/^[A-Za-z0-9._-]{2,60}@[A-Za-z][A-Za-z0-9.-]{1,38}$/.test(upiId)) fail('A UPI ID looks like shopname@okaxis');
    }
    const upiPayee = body.upiPayee === undefined ? current.upi_payee : (v.optionalString(body.upiPayee, 'Name on the UPI QR', 60)?.trim() || null);
    const row = await repo.one(db, `INSERT INTO business_till_settings(business_id,warn_hours,stop_hours,waiting_cap,upi_id,upi_payee,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(business_id) DO UPDATE SET warn_hours=EXCLUDED.warn_hours,stop_hours=EXCLUDED.stop_hours,
      waiting_cap=EXCLUDED.waiting_cap,upi_id=EXCLUDED.upi_id,upi_payee=EXCLUDED.upi_payee,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [business.id, warn, stop, cap, upiId || null, upiId ? upiPayee : null, user.id]);
    await repo.audit(db, business.id, user.id, 'till.settings_changed', null, { warnHours: warn, stopHours: stop, waitingCap: cap, upiId: upiId || null });
    return settingsShape(row);
  });
}

// What the till reports while it can reach the server (about every minute):
// its bills waiting and needing attention, when the oldest was made, since
// when it was offline, the last number it used and those it still holds, its
// version. The answer: the server's time (the till keeps its own clock right
// by it), the till as the server knows it, and the business's limits.
async function heartbeat(business, user, body, token) {
  await access.require(business, 'sales.create');
  requireModule(business);
  const count = (value, name) => {
    const n = Number(value ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 100000) fail(`${name} must be a whole number`);
    return n;
  };
  const when = (value, name) => {
    if (value === undefined || value === null || value === '') return null;
    const t = Date.parse(value);
    if (!Number.isFinite(t)) fail(`${name} must be a time`);
    return new Date(t).toISOString();
  };
  const pending = count(body.pending, 'Bills waiting');
  const attention = count(body.attention, 'Bills needing attention');
  const last = body.lastNumber && typeof body.lastNumber === 'object' ? body.lastNumber : null;
  const lastYear = last ? count(last.year, 'Year') : null;
  if (lastYear !== null && (lastYear < 2000 || lastYear > 2200)) fail('Year must be a financial year');
  const lastSeq = last ? count(last.seq, 'Last number') : null;
  const holding = Array.isArray(body.holding) ? body.holding.slice(0, 2000).map((n) => count(n, 'Number held')) : [];
  const version = v.optionalString(body.version, 'App version', 40);
  return repo.transaction(async (db) => {
    const device = await fromToken(db, business, token);
    await db.query(`UPDATE business_devices SET last_seen_at=now(),pending_count=$3,attention_count=$4,oldest_pending_at=$5,offline_since=$6,
      last_year=COALESCE($7,last_year),last_seq=COALESCE($8,last_seq),holding=$9,app_version=COALESCE($10,app_version) WHERE business_id=$1 AND id=$2`,
    [business.id, device.id, pending, attention, when(body.oldestMadeAt, 'Oldest bill'), when(body.offlineSince, 'Offline since'), lastYear, lastSeq, holding, version]);
    const row = await repo.one(db, `${LIST_SQL} WHERE d.business_id=$1 AND d.id=$2`, [business.id, device.id]);
    // The highest number of each year's series that reached the server: a till
    // whose own count is behind (its data restored from an old copy) moves past it.
    const received = await repo.all(db, `SELECT fiscal_year,COALESCE((SELECT max(b.seq) FROM business_till_bills b WHERE b.business_id=n.business_id AND b.series_id=n.id),0) AS seq
      FROM business_number_series n WHERE n.business_id=$1 AND n.device_id=$2`, [business.id, device.id]);
    return { serverTime: new Date().toISOString(), device: tillShape(row), settings: settingsShape(await settings(db, business.id)),
      received: Object.fromEntries(received.map((r) => [r.fiscal_year, Number(r.seq)])) };
  });
}

// The till as the till itself sees it (no counts of other people's work).
const tillShape = (row) => ({ id: row.id, code: row.code, name: row.name, locationId: row.location_id, locationName: row.location_name,
  registeredAt: row.registered_at, lastSyncAt: row.last_sync_at, retired: Boolean(row.retired_at) });

// Waiting on the tills of a location, as they last reported (closing a cashier's shift warns of them).
async function waitingAt(db, businessId, locationId) {
  const row = await repo.one(db, `SELECT COALESCE(sum(pending_count+attention_count),0)::int AS bills, count(*) FILTER (WHERE pending_count+attention_count>0)::int AS tills
    FROM business_devices WHERE business_id=$1 AND location_id=$2 AND retired_at IS NULL`, [businessId, locationId]);
  return { bills: row.bills, tills: row.tills };
}

module.exports = { fromToken, requireModule, settings, settingsShape, list, register, rename, retire, readSettings, saveSettings, heartbeat, tillShape, waitingAt, LIST_SQL, sha256 };
