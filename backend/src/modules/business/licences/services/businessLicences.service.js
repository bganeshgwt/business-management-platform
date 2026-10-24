const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// Licences & registrations (module "licences": every type but a restaurant;
// on for a seeds, fertilisers & pesticides shop). Each location keeps the
// licences it holds (business_licences): its kind (a short code), its name
// as issued, its number, the issuing authority, the dates it is valid from
// and until (none: it does not expire), the product categories it covers
// and notes. A licence is changed (renewed, corrected) or switched off,
// never deleted, and stays with its location and kind (a database trigger).
//
// Other modules ask `holds` (or `standing`, which also says why not) whether
// a location holds a licence in force on a day: of a kind, covering a
// category, or both. A farm-input shop's bills ask it for fertiliser, seed
// and insecticide lines. The bell asks `expiring`.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
// The bell warns this many days before a licence runs out.
const WARN_DAYS = 60;
// The product categories a licence may cover (the CHECK on business_licences.covers).
const CATEGORIES = ['fertiliser', 'seed', 'insecticide'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (day) => { const [y, m, d] = String(day).slice(0, 10).split('-'); return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`; };

function requireLicences(business) {
  if (!business.modules.includes('licences')) fail('Licences & registrations is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

// Where a licence stands on the business's own date: off, not yet valid,
// expired, running out within WARN_DAYS, valid, or valid with no end date.
const stateSql = (l, today) => `CASE WHEN NOT ${l}.active THEN 'off' WHEN ${l}.valid_from > ${today} THEN 'not_yet'
  WHEN ${l}.valid_until IS NULL THEN 'no_expiry' WHEN ${l}.valid_until < ${today} THEN 'expired'
  WHEN ${l}.valid_until <= ${today} + ${WARN_DAYS} THEN 'expiring' ELSE 'valid' END`;

repo.addLists({
  // Every licence with its location, where it stands today and the days it has left.
  licences: {
    sql: `SELECT x.*,${stateSql('x', 'x.today')} AS state,(x.valid_until - x.today) AS days_left FROM (
      SELECT l.*,loc.name AS location_name,(now() AT TIME ZONE b.timezone)::date AS today,u.name AS updated_by_name
      FROM business_licences l JOIN businesses b ON b.id=l.business_id
      JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
      LEFT JOIN users u ON u.id=COALESCE(l.updated_by,l.created_by) WHERE l.business_id=$1) x`,
    search: ['name', 'licence_no', 'authority', 'location_name', 'kind', 'notes'],
    filters: { location: 'location_id', active: 'active', kind: 'kind', state: 'state', id: 'id' },
    order: 'active DESC,valid_until NULLS LAST,location_name,name',
  },
});

function readDate(value, name) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text) fail(`${name} must be a valid date`);
  return text;
}
// The licence as typed: its kind and name, number, authority, dates, what it covers and notes.
function readLicence(body, { kindGiven = true } = {}) {
  const kind = kindGiven ? v.requiredString(body.kind, 'Kind of licence', 30).toLowerCase() : null;
  if (kindGiven && !/^[a-z][a-z0-9_]{1,29}$/.test(kind)) fail('The kind of licence is a short code of letters, digits and _ (for example fertiliser or trade)');
  const validFrom = readDate(body.validFrom, 'Valid from');
  const validUntil = body.validUntil === undefined || body.validUntil === null || body.validUntil === '' ? null : readDate(body.validUntil, 'Valid until');
  if (validUntil && validUntil < validFrom) fail('A licence cannot run out before it is valid from');
  const covers = body.covers === undefined || body.covers === null ? [] : v.requiredArray(body.covers, 'What it covers');
  for (const category of covers) v.requiredEnum(category, 'What it covers', CATEGORIES);
  if (new Set(covers).size !== covers.length) fail('Each category it covers is named once');
  return {
    kind, name: v.requiredString(body.name, 'Name of the licence', 150), licenceNo: v.requiredString(body.licenceNo, 'Licence number', 80),
    authority: v.optionalString(body.authority, 'Issuing authority', 200), validFrom, validUntil, covers: [...covers].sort(),
    notes: v.optionalString(body.notes, 'Notes', 500),
  };
}

async function detail(db, business, licenceId) {
  return repo.one(db, `SELECT l.*,loc.name AS location_name,${stateSql('l', 'x.today')} AS state,(l.valid_until - x.today) AS days_left
    FROM business_licences l JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
    CROSS JOIN (SELECT (now() AT TIME ZONE timezone)::date AS today FROM businesses WHERE id=$1) x
    WHERE l.business_id=$1 AND l.id=$2`, [business.id, licenceId]);
}

// One number is kept once for a kind of licence in a business.
async function numberFree(db, business, kind, licenceNo, exceptId = null) {
  const clash = await repo.one(db, `SELECT l.name,loc.name AS location_name FROM business_licences l JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
    WHERE l.business_id=$1 AND l.kind=$2 AND lower(l.licence_no)=lower($3) AND ($4::bigint IS NULL OR l.id<>$4)`, [business.id, kind, licenceNo, exceptId]);
  if (clash) fail(`${clash.name} number ${licenceNo} is already kept for ${clash.location_name}`, 409);
}

// body: { locationId, kind, name, licenceNo, authority?, validFrom, validUntil? (none: no expiry), covers?: [category], notes? }
async function create(business, user, body) {
  requireLicences(business);
  await access.require(business, 'licences.edit');
  const f = readLicence(body);
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  return repo.transaction(async (db) => {
    const location = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    await numberFree(db, business, f.kind, f.licenceNo);
    const row = await repo.one(db, `INSERT INTO business_licences(business_id,location_id,kind,name,licence_no,authority,valid_from,valid_until,covers,notes,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
    [business.id, location.id, f.kind, f.name, f.licenceNo, f.authority, f.validFrom, f.validUntil, f.covers, f.notes, user.id]);
    await repo.audit(db, business.id, user.id, 'licence.created', row.id, { kind: f.kind, name: f.name, licenceNo: f.licenceNo, location: location.name,
      validFrom: f.validFrom, validUntil: f.validUntil, covers: f.covers });
    return detail(db, business, row.id);
  });
}

// body: the same but the location and the kind, which never change; active? (switched off when surrendered or cancelled).
// A later valid-until date is a renewal.
async function update(business, user, licenceId, body) {
  requireLicences(business);
  await access.require(business, 'licences.edit');
  const f = readLicence(body, { kindGiven: false });
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM business_licences WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(licenceId, 'Licence')]);
    if (!current) fail('Licence not found', 404);
    // Left out, it keeps whether it is on.
    const active = body.active === undefined ? current.active : v.requiredBoolean(body.active, 'Active');
    access.requireLocation(business, current.location_id);
    if (body.kind !== undefined && String(body.kind).toLowerCase() !== current.kind) fail('A licence keeps its kind: add the other licence on its own');
    if (body.locationId !== undefined && String(body.locationId) !== String(current.location_id)) fail('A licence stays with its location: add it for the other location on its own');
    await numberFree(db, business, current.kind, f.licenceNo, current.id);
    await db.query(`UPDATE business_licences SET name=$3,licence_no=$4,authority=$5,valid_from=$6,valid_until=$7,covers=$8,notes=$9,active=$10,updated_by=$11,updated_at=now()
      WHERE business_id=$1 AND id=$2`, [business.id, current.id, f.name, f.licenceNo, f.authority, f.validFrom, f.validUntil, f.covers, f.notes, active, user.id]);
    // What changed, from and to, in the activity log.
    const was = { name: current.name, licenceNo: current.licence_no, authority: current.authority, validFrom: current.valid_from, validUntil: current.valid_until,
      covers: [...current.covers].sort(), notes: current.notes, active: current.active };
    const now = { name: f.name, licenceNo: f.licenceNo, authority: f.authority, validFrom: f.validFrom, validUntil: f.validUntil, covers: f.covers, notes: f.notes, active };
    const changed = Object.keys(now).filter((key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]));
    if (changed.length) {
      const renewed = active && current.active && f.validUntil !== current.valid_until && (f.validUntil === null || (current.valid_until !== null && f.validUntil > current.valid_until));
      const action = active !== current.active ? (active ? 'licence.switched_on' : 'licence.switched_off') : renewed ? 'licence.renewed' : 'licence.updated';
      await repo.audit(db, business.id, user.id, action, current.id, { name: f.name, licenceNo: f.licenceNo,
        from: Object.fromEntries(changed.map((key) => [key, was[key]])), to: Object.fromEntries(changed.map((key) => [key, now[key]])) });
    }
    return detail(db, business, current.id);
  });
}

// The licence that decides whether a location may sell under it on a day:
// one in force (kind and category as asked, either may be left out), or
// else the one that came closest (switched off, expired or not yet valid), so
// a refusal can say which. null: the location has none at all.
async function standing(db, business, { locationId, kind = null, category = null, on }) {
  if (!kind && !category) throw new Error('A licence is asked for by its kind, its category or both');
  const row = await repo.one(db, `SELECT x.*,(x.state='in_force') AS in_force FROM (
      SELECT l.id,l.kind,l.name,l.licence_no,l.valid_from,l.valid_until,l.active,
        CASE WHEN NOT l.active THEN 'off' WHEN l.valid_from > $5::date THEN 'not_yet'
          WHEN l.valid_until IS NOT NULL AND l.valid_until < $5::date THEN 'expired' ELSE 'in_force' END AS state
      FROM business_licences l WHERE l.business_id=$1 AND l.location_id=$2 AND ($3::text IS NULL OR l.kind=$3) AND ($4::text IS NULL OR $4 = ANY (l.covers))) x
    ORDER BY (x.state='in_force') DESC,x.active DESC,x.valid_until DESC NULLS FIRST,x.id DESC LIMIT 1`, [business.id, locationId, kind, category, on]);
  return row || null;
}
// Whether a location holds, on a day, a licence in force of a kind and/or covering a category.
const holds = async (db, business, query) => Boolean((await standing(db, business, query))?.in_force);

// Why a location may not sell under a licence it lacks, in words: none, or
// the one that came closest and what is wrong with it.
function whyNot(licence, what, locationName) {
  if (!licence) return `${locationName} holds no ${what}`;
  if (licence.state === 'off') return `${locationName}'s ${what} (${licence.licence_no}) is switched off`;
  if (licence.state === 'not_yet') return `${locationName}'s ${what} (${licence.licence_no}) is valid only from ${dateWords(licence.valid_from)}`;
  return `${locationName}'s ${what} (${licence.licence_no}) ran out on ${dateWords(licence.valid_until)}`;
}

// The bell: active licences that run out within WARN_DAYS, or have run out.
async function expiring(business, limit) {
  return repo.all(repo.pool, `WITH today AS (SELECT (now() AT TIME ZONE timezone)::date AS d FROM businesses WHERE id=$1)
    SELECT l.id,l.name,l.licence_no,l.valid_until::text AS valid_until,(l.valid_until - today.d) AS days,loc.name AS location_name
    FROM business_licences l CROSS JOIN today JOIN business_locations loc ON loc.business_id=l.business_id AND loc.id=l.location_id
    WHERE l.business_id=$1 AND l.active AND l.valid_until IS NOT NULL AND l.valid_until <= today.d + ${WARN_DAYS}
    ORDER BY l.valid_until,l.name LIMIT $2`, [business.id, limit]);
}

module.exports = { requireLicences, create, update, standing, holds, whyNot, expiring, dateWords, WARN_DAYS, CATEGORIES };
