const repo = require('../../business/core/repositories/business.repository');
const AppError = require('../../../utils/AppError');
const v = require('../../../utils/validate');

// Consent per purpose and per business (business_consents, migration
// 1791977000000_personal-data): what every module that takes a customer or
// messages one uses, inside its own transaction.
//
// A person is { column, id }: a shop's customer contact ({ column:
// 'contact_id' }) or a restaurant's guest ({ column: 'customer_id' }). A
// consent belongs to one business: a contact belongs to one business, and a
// guest to one restaurant, so another business of the same owner never sees it.
//
//   bills_digital  bills and other documents sent on WhatsApp or SMS
//   reminders      reminders: dues, appointments, renewals, service due (on WhatsApp, SMS or a call)
//   offers         offers; never for a child
//   treatment, reports_digital   a clinic patient's, given on the clinic's own consent notice

const fail = (message, status = 400, details) => { throw new AppError(status, message, details); };

const PURPOSES = ['bills_digital', 'reminders', 'offers'];
const CLINIC_PURPOSES = ['treatment', 'reports_digital'];
const ALL_PURPOSES = [...PURPOSES, ...CLINIC_PURPOSES];
// Where it was given or withdrawn; 'import' is only for what came from earlier records.
const CHANNELS = ['counter', 'guests_site', 'phone'];
const METHODS = ['signed_form', 'verbal', 'digital'];
const WORDS = {
  bills_digital: 'bills on WhatsApp or SMS',
  reminders: 'reminders on WhatsApp, SMS or a call',
  offers: 'offers on WhatsApp or SMS',
  treatment: 'treatment and medical records',
  reports_digital: 'reports on WhatsApp or e-mail',
};
const COLUMNS = ['contact_id', 'customer_id'];

const personOf = (column, id) => {
  if (!COLUMNS.includes(column)) throw new Error(`Unknown person column ${column}`);
  return { column, id: Number(id) };
};
const where = (person, from = 2) => `${person.column}=$${from}`;

// The business's privacy notice in force: its newest version, or null.
async function notice(db, businessId) {
  if (!businessId) return null;
  return (await repo.one(db, `SELECT * FROM business_privacy_notices WHERE business_id=$1 ORDER BY version DESC LIMIT 1`, [businessId])) || null;
}

// Active purposes, child marks and erasure of several people at once:
// Map(id -> { purposes: [], child: bool, erased: bool }).
async function statusOf(db, businessId, column, ids) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const map = new Map(list.map((id) => [id, { purposes: [], child: false, erased: false }]));
  if (!businessId || !list.length) return map;
  personOf(column, list[0]);
  // One after another: db may be a transaction's own connection.
  const consents = await repo.all(db, `SELECT ${column} AS id,purpose FROM business_consents WHERE business_id=$1 AND ${column}=ANY($2::bigint[]) AND withdrawn_at IS NULL ORDER BY id`,
    [businessId, list]);
  const children = await repo.all(db, `SELECT ${column} AS id FROM business_children WHERE business_id=$1 AND ${column}=ANY($2::bigint[]) AND ended_at IS NULL`, [businessId, list]);
  const erased = column === 'customer_id'
    ? await repo.all(db, 'SELECT id FROM customers WHERE id=ANY($1::bigint[]) AND erased_at IS NOT NULL', [list])
    : await repo.all(db, 'SELECT id FROM business_contacts WHERE business_id=$1 AND id=ANY($2::bigint[]) AND erased_at IS NOT NULL', [businessId, list]);
  for (const row of consents) map.get(Number(row.id))?.purposes.push(row.purpose);
  for (const row of children) { const entry = map.get(Number(row.id)); if (entry) entry.child = true; }
  for (const row of erased) { const entry = map.get(Number(row.id)); if (entry) entry.erased = true; }
  return map;
}

async function active(db, businessId, person) {
  return (await statusOf(db, businessId, person.column, [person.id])).get(person.id) || { purposes: [], child: false, erased: false };
}

// Throws 409 consent_required unless the person has an active consent for
// the purpose. `name` says who in the sentence.
async function require_(db, businessId, person, purpose, name = 'This customer') {
  const status = await active(db, businessId, person);
  if (status.erased) fail(`${name}'s data was erased at their request: nothing is sent to them`, 409, { reason: 'consent_required', purpose });
  if (!status.purposes.includes(purpose)) {
    fail(`${name} has not agreed to ${WORDS[purpose]}. Ask them, and record their consent on their record first.`, 409, { reason: 'consent_required', purpose });
  }
}

// A reminder to a shop's customer on WhatsApp, by SMS or by a call (a
// renewal call included) needs their consent to reminders; a visit or a word
// at the counter does not.
const REMINDER_CHANNELS = ['whatsapp', 'sms', 'call'];
async function requireReminder(db, businessId, contactId, channel = 'whatsapp', name = 'This customer') {
  if (!REMINDER_CHANNELS.includes(channel)) return;
  await require_(db, businessId, personOf('contact_id', contactId), 'reminders', name);
}

// Reads { purposes: [...], channel, method, givenBy, note } for recording.
function readGiven(body, { purposes = PURPOSES } = {}) {
  const list = [...new Set(v.requiredArray(body?.purposes, 'Purposes'))];
  if (!list.length) fail('Choose what the person agrees to');
  for (const purpose of list) v.requiredEnum(purpose, 'Purpose', purposes);
  return {
    purposes: list,
    channel: v.optionalEnum(body.channel, 'Where it was given', CHANNELS, 'counter'),
    method: v.optionalEnum(body.method, 'How it was given', METHODS, 'verbal'),
    givenBy: v.optionalString(body.givenBy, 'Given by', 150),
    note: v.optionalString(body.note, 'Note', 300),
  };
}

// The consents a form sets: { bills_digital: true|false, … }. true records
// one when none is active, false withdraws the active one, a purpose left
// out stays as it is. null when the form sent none.
function readChoices(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail('Consents must be given per purpose');
  const choices = {};
  for (const [purpose, given] of Object.entries(value)) {
    v.requiredEnum(purpose, 'Purpose', PURPOSES);
    if (typeof given !== 'boolean') fail('Each consent is yes or no');
    choices[purpose] = given;
  }
  return choices;
}

// Records consent for each purpose not already given, inside the caller's
// transaction. `audit(db, action, entityId, details)` writes the activity row
// of the caller's engine. Returns the active rows, new and kept.
// opts: { businessId, person, purposes, channel, method, givenBy, note, userId,
//         audit, clinicVersion (a clinic's own consent notice, for its purposes), notice (the privacy notice shown),
//         givenOn (channel 'import' only: the day the earlier records say it was given) }
// Channel 'import' brings over a consent from the business's earlier records
// (a guest list): no notice of the business's was shown, so none is named.
async function record(db, opts) {
  const { businessId, person, purposes, channel = 'counter', givenBy = null, note = null, userId = null, audit } = opts;
  const imported = channel === 'import';
  const method = imported ? null : opts.method || 'verbal';
  const general = imported ? [] : purposes.filter((p) => !(opts.clinicVersion && (CLINIC_PURPOSES.includes(p) || p === 'reminders')));
  const shown = general.length ? (opts.notice !== undefined ? opts.notice : await notice(db, businessId)) : null;
  if (general.length && !shown) {
    fail('Publish the business\'s privacy notice before recording consent: Settings › Personal data', 409, { reason: 'no_privacy_notice' });
  }
  const rows = [];
  for (const purpose of purposes) {
    const current = await repo.one(db, `SELECT * FROM business_consents WHERE business_id=$1 AND ${where(person)} AND purpose=$3 AND withdrawn_at IS NULL`,
      [businessId, person.id, purpose]);
    if (current) { rows.push(current); continue; }
    const onClinic = !imported && !general.includes(purpose);
    const version = imported ? null : onClinic ? opts.clinicVersion : `v${shown.version}`;
    const row = await repo.one(db, `INSERT INTO business_consents(business_id,${person.column},purpose,notice_id,notice_version,channel,method,given_by,recorded_by,note,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::date::timestamptz,now())) RETURNING *`,
    [businessId, person.id, purpose, imported || onClinic ? null : shown.id, version, channel, method, givenBy, userId, note, imported ? opts.givenOn || null : null]);
    if (audit) await audit(db, 'consent.given', person.id, { purpose, version: row.notice_version, channel, method: method || undefined, givenBy: givenBy || undefined });
    rows.push(row);
  }
  return rows;
}

// Withdraws one active consent (by id, or the person's for a purpose).
// Returns the row, or null when there was none to withdraw.
async function withdraw(db, { businessId, consentId = null, person = null, purpose = null, userId, reason, channel = 'counter', audit }) {
  const row = consentId
    ? await repo.one(db, 'SELECT * FROM business_consents WHERE business_id=$1 AND id=$2 FOR UPDATE', [businessId, consentId])
    : await repo.one(db, `SELECT * FROM business_consents WHERE business_id=$1 AND ${where(person)} AND purpose=$3 AND withdrawn_at IS NULL FOR UPDATE`,
      [businessId, person.id, purpose]);
  if (!row) return null;
  if (row.withdrawn_at) fail('This consent was already withdrawn', 409);
  const saved = await repo.one(db, `UPDATE business_consents SET withdrawn_at=now(),withdrawn_by=$3,withdrawal_reason=$4,withdrawal_channel=$5
    WHERE business_id=$1 AND id=$2 RETURNING *`, [businessId, row.id, userId, reason, channel]);
  if (audit) await audit(db, 'consent.withdrawn', row.contact_id || row.customer_id, { purpose: row.purpose, reason, channel });
  return saved;
}

// Every active consent of the person withdrawn and a child's mark ended, kept
// as the record: their data is being erased.
async function stopAll(db, { businessId, person, userId, reason, audit }) {
  for (const purpose of ALL_PURPOSES) {
    await withdraw(db, { businessId, person, purpose, userId, reason, channel: 'counter', audit });
  }
  await db.query(`UPDATE business_children SET ended_at=now(),ended_by=$3,end_reason=$4 WHERE business_id=$1 AND ${person.column}=$2 AND ended_at IS NULL`,
    [businessId, person.id, userId, reason]);
}

// A form's choices applied: records what is now given, withdraws what is not.
async function apply(db, { businessId, person, choices, channel = 'counter', method = 'verbal', userId, audit, reason = 'Changed on the customer\'s record' }) {
  if (!choices) return;
  const given = Object.entries(choices).filter(([, yes]) => yes).map(([purpose]) => purpose);
  if (given.length) await record(db, { businessId, person, purposes: given, channel, method, userId, audit });
  for (const [purpose, yes] of Object.entries(choices)) {
    if (!yes) await withdraw(db, { businessId, person, purpose, userId, reason, channel, audit });
  }
}

// The history of one person's consents, newest first, with who recorded and withdrew each.
function history(db, businessId, person) {
  return repo.all(db, `SELECT k.id,k.purpose,k.notice_id,k.notice_version,k.channel,k.method,k.given_by,k.note,k.created_at,
      k.withdrawn_at,k.withdrawal_reason,k.withdrawal_channel,u.name AS recorded_by_name,w.name AS withdrawn_by_name
    FROM business_consents k LEFT JOIN users u ON u.id=k.recorded_by LEFT JOIN users w ON w.id=k.withdrawn_by
    WHERE k.business_id=$1 AND k.${person.column}=$2 ORDER BY k.created_at DESC,k.id DESC`, [businessId, person.id]);
}

module.exports = { PURPOSES, CLINIC_PURPOSES, ALL_PURPOSES, CHANNELS, METHODS, WORDS, REMINDER_CHANNELS, personOf, notice, statusOf, active, require: require_, requireReminder,
  readGiven, readChoices, record, withdraw, stopAll, apply, history };
