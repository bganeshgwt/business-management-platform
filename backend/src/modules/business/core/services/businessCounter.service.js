const crypto = require('node:crypto');
const repo = require('../repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const access = require('./businessAccess.service');

// Per-staff PIN at a shared counter.
//
// A shop's till stays signed in all day. Each cashier switches the till to
// themselves with their own PIN (no sign-out, the bill being built stays),
// and every bill then records who billed it (business_documents.created_by is
// the person the till is switched to). With "Ask the PIN for every bill" on
// (Business settings › Prices, totals and numbering), Quick bill asks the biller's PIN before each
// bill and the server checks it.
//
// The PIN typed to switch the till counts for the next bill: the switch
// gives the till a proof (random, 256 bits) for the person it switched to, in
// this business, from the session the switch began, usable on one bill within
// PROOF_MINUTES. Only its SHA-256 is kept (business_counter_bill_proofs). The
// bill spends it inside its own transaction, so a bill that is refused leaves
// it for the next try, and a retry of the same bill (same request key) is
// answered; after that, or once it runs out, the PIN is asked as before.
//
// Nothing new about PINs: the person's own PIN (My profile, or set by an
// admin under Users), checked by the access module with its five-try lock,
// the account lock and the two-step device rule (auth.service › switchToRow,
// checkPin). A PIN an admin set switches the till to its person, who then
// chooses their own before anything else; it gives no bill proof and confirms
// no bill (auth.service › assertOwnPin).

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };
const PROOF_MINUTES = 2;
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
// The session a request is made in: the SHA-256 of its bearer token (null without one).
const sessionOf = (authorization) => {
  const [scheme, token] = String(authorization || '').split(' ');
  return scheme === 'Bearer' && token ? sha256(token) : null;
};
const auth = () => require('../../../access/services/auth.service');
const users = () => require('../../../access/repositories/user.repository');

// Members who may bill here: active, in an active role that holds sales.create.
const SELLERS = `FROM business_memberships m
  JOIN users u ON u.id=m.user_id AND u.status='active'
  JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
  WHERE m.business_id=$1 AND m.active
    AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id AND p.permission_code='sales.create'))`;

// pinGiven: someone else set the PIN. It still switches the till to its
// person, but confirms no bill, so the till's bill PIN does not offer it.
async function staff(business, user) {
  await access.require(business, 'sales.create');
  const rows = await repo.all(repo.pool, `SELECT u.id,u.name,r.name AS role_name,(u.pin_hash IS NOT NULL) AS has_pin,u.pin_must_change AS pin_given,
      COALESCE(u.pin_locked_until > now(),false) AS locked ${SELLERS} ORDER BY u.name`, [business.id]);
  return { current: Number(user.id), people: rows.map((r) => ({ id: Number(r.id), name: r.name, roleName: r.role_name, hasPin: r.has_pin, pinGiven: r.pin_given, locked: r.locked })) };
}

// The till carries on as another member: their PIN, every lock rule. Returns
// a session for that person (token, user), exactly like the restaurant till;
// with "Ask the PIN for every bill" on, also the proof that the PIN just typed
// counts for their next bill (billProof, billProofExpiresAt).
async function switchTo(business, user, body, meta = {}) {
  await access.require(business, 'sales.create');
  const userId = v.requiredId(body.userId, 'Person');
  const member = await repo.one(repo.pool, `SELECT u.id ${SELLERS} AND u.id=$2`, [business.id, userId]);
  if (!member) fail('That person does not bill at this business', 404);
  if (typeof body.pin !== 'string' || !/^\d{4,6}$/.test(body.pin)) fail('Enter the PIN (4 to 6 digits)');
  const row = await users().findPinById(userId);
  const session = await auth().switchToRow(user, row, { pin: body.pin, deviceTokens: body.deviceTokens }, meta);
  // A PIN someone else set switches the till, but counts for no bill: the
  // person chooses their own first, and that one is asked for the bill.
  const given = Boolean(row.pin_must_change);
  const issued = await repo.transaction(async (db) => {
    const setting = await repo.one(db, 'SELECT counter_pin_every_bill FROM business_settings WHERE business_id=$1', [business.id]);
    let proof = null, expiresAt = null;
    if (setting?.counter_pin_every_bill && !given) {
      // Proofs run out in minutes; a day later they are no use even as a record.
      await db.query("DELETE FROM business_counter_bill_proofs WHERE business_id=$1 AND expires_at < now() - interval '1 day'", [business.id]);
      proof = crypto.randomBytes(32).toString('base64url');
      expiresAt = (await repo.one(db, `INSERT INTO business_counter_bill_proofs(business_id,user_id,switched_by,proof_hash,session_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,now() + make_interval(mins => $6)) RETURNING expires_at`, [business.id, userId, user.id, sha256(proof), sha256(session.token), PROOF_MINUTES])).expires_at;
    }
    await repo.audit(db, business.id, userId, 'counter.switched', null, { from: Number(user.id), to: userId, billProof: Boolean(proof), ...(given ? { pinGiven: true } : {}) });
    return proof ? { billProof: proof, billProofExpiresAt: new Date(expiresAt).toISOString() } : null;
  });
  return { ...session, ...issued };
}

// "Ask the PIN for every bill": the PIN of the person the till is switched
// to, or the proof their switch gave the till. `session`: the bill request's
// own (sessionOf). Returns null, or what the bill spends inside its own
// transaction (`spend(db, requestKey)`).
async function checkBill(business, user, { pin, proof, session } = {}) {
  const setting = await repo.one(repo.pool, 'SELECT counter_pin_every_bill FROM business_settings WHERE business_id=$1', [business.id]);
  if (!setting?.counter_pin_every_bill) return null;
  const given = (value) => value !== undefined && value !== null && value !== '';
  if (given(pin)) {
    if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) fail('Enter the PIN (4 to 6 digits)', 400, { reason: 'wrong_pin' });
    const row = await users().findPinById(user.id);
    // A PIN someone else set confirms no bill: anyone who set it knows it.
    auth().assertOwnPin(row, { self: true, what: 'confirm a bill' });
    await auth().checkPin(row, pin);
    return null;
  }
  if (given(proof) && typeof proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof)) {
    return { spend: (db, requestKey) => spendProof(db, business, user, { proof, session, requestKey }) };
  }
  fail('This business asks the biller\'s PIN for every bill. Enter your PIN.', 403, { reason: 'pin_required' });
}

// Uses the switch's proof for this bill: once, within its minutes, for the
// person, business and session it was given to. The same bill asked again
// (its answer lost) is answered with it; anything else asks for the PIN.
async function spendProof(db, business, user, { proof, session, requestKey }) {
  const values = [sha256(proof), business.id, user.id, session, requestKey];
  const used = await repo.one(db, `UPDATE business_counter_bill_proofs SET used_at=now(),used_request_key=$5
    WHERE proof_hash=$1 AND business_id=$2 AND user_id=$3 AND session_hash=$4 AND used_at IS NULL AND expires_at > now() RETURNING id`, values);
  if (used) return;
  const again = await repo.one(db, `SELECT id FROM business_counter_bill_proofs
    WHERE proof_hash=$1 AND business_id=$2 AND user_id=$3 AND session_hash=$4 AND used_request_key=$5`, values);
  if (again) return;
  fail(`The PIN typed to switch the till counts for one bill within ${PROOF_MINUTES} minutes. Enter your PIN for this bill.`, 403, { reason: 'pin_required' });
}

module.exports = { staff, switchTo, checkBill, sessionOf };
