const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./lodgingCommon');
const stays = require('./lodgingStays.service');

// A stay's folios beyond its main one, and the routing of its charges (module "lodging").
//
//   folios    a stay has its main folio (billed to the company it is billed to,
//             or to the guest) and may have more: the company's, the guest's
//             extras, each billed to a customer of the business (a company with
//             its GSTIN on the invoice); a group's stay may also send charges to
//             its group's folio. Each folio is billed with its own GST invoice
//             at check-out (a group's with the group).
//   routing   each kind of charge goes to a folio: the room (its nights, a day
//             use, early check-in and late check-out, with their tax), meals,
//             extras, goods (left out: the main folio). Changing a route moves
//             that kind's charges not yet billed; one charge may be moved too.

const { fail, id } = c;
const KINDS = { room: ['room_night', 'day_use', 'early_check_in', 'late_check_out'], meals: ['meal'], extras: ['extra'], goods: ['goods'] };

// A customer of this business, in use, to bill a folio to.
async function customerOf(db, business, value) {
  const contact = await repo.one(db, "SELECT * FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, id(value, 'Billed to')]);
  if (!contact) fail('Whom the folio is billed to is not a customer of this business', 404);
  if (!contact.active) fail(`${contact.name} is switched off: switch them on again first`, 409);
  return contact;
}
// A folio the stay's charges may go to: its own or its group's, not billed. null: the main folio.
async function folioOf(db, business, stay, value) {
  if (value === null || value === '') return null;
  const folio = await repo.one(db, 'SELECT * FROM lodging_folios WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(value, 'Folio')]);
  if (!folio || (Number(folio.stay_id) !== Number(stay.id) && (!folio.group_id || Number(folio.group_id) !== Number(stay.group_id)))) fail('Folio not found', 404);
  if (folio.document_id) fail(`Folio ${folio.name} is billed already`, 409);
  return folio;
}
const readName = (value) => {
  const name = v.requiredString(typeof value === 'string' ? value : '', 'Folio name', 60);
  if (name.toLowerCase() === 'main') fail('Main is the stay\'s own folio: name this one for whom it is (Company, Extras)');
  return name;
};

// body: { requestKey, name, contactId } — a folio beyond the main one, billed to a customer (a company with its GSTIN, or the guest).
async function createFolio(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const requestKey = core.uuid(body.requestKey);
  const name = readName(body.name);
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    const old = await repo.one(db, 'SELECT id,stay_id,name,contact_id FROM lodging_folios WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (Number(old.stay_id) !== Number(stay.id) || old.name !== name || Number(old.contact_id) !== Number(body.contactId)) fail('This request key was already used for different data', 409);
      return stays.shape(business, await stays.load(db, business, stay.id));
    }
    if (!['reserved', 'in_house'].includes(stay.status)) fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: folios are opened while it is reserved or in the house`, 409);
    const contact = await customerOf(db, business, body.contactId);
    if (await repo.one(db, 'SELECT 1 FROM lodging_folios WHERE business_id=$1 AND stay_id=$2 AND lower(name)=lower($3)', [business.id, stay.id, name])) {
      fail(`Stay ${stay.stay_no} has a folio called ${name} already`, 409);
    }
    const folio = await repo.one(db, 'INSERT INTO lodging_folios(business_id,stay_id,name,contact_id,request_key,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [business.id, stay.id, name, contact.id, requestKey, user.id]);
    await stays.history(db, business, user, stay, null, null, `Folio ${name} opened, billed to ${contact.name}${contact.gstin ? ` (GSTIN ${contact.gstin})` : ''}`);
    await repo.audit(db, business.id, user.id, 'lodging_folio.opened', folio.id, { stayNo: stay.stay_no, name, contactId: contact.id, billedTo: contact.name });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// body: { name?, contactId? } — a folio not yet billed: its name and whom it is billed to.
async function updateFolio(business, user, stayId, folioId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    const folio = await folioOf(db, business, stay, folioId);
    if (!folio) fail('Folio not found', 404);
    if (folio.group_id) fail('The group\'s folio is changed from the group', 409);
    const name = body.name === undefined ? folio.name : readName(body.name);
    const contact = body.contactId === undefined ? { id: folio.contact_id } : await customerOf(db, business, body.contactId);
    if (name.toLowerCase() !== folio.name.toLowerCase() && await repo.one(db, 'SELECT 1 FROM lodging_folios WHERE business_id=$1 AND stay_id=$2 AND lower(name)=lower($3)',
      [business.id, stay.id, name])) fail(`Stay ${stay.stay_no} has a folio called ${name} already`, 409);
    await db.query('UPDATE lodging_folios SET name=$3,contact_id=$4 WHERE business_id=$1 AND id=$2', [business.id, folio.id, name, contact.id]);
    await repo.audit(db, business.id, user.id, 'lodging_folio.changed', folio.id, { stayNo: stay.stay_no, from: { name: folio.name, contactId: folio.contact_id }, to: { name, contactId: contact.id } });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// body: { room?, meals?, extras?, goods? } — each a folio id (the stay's own or its group's) or null (the main folio); what is left out stays.
// The charges of that kind not yet billed move with the route.
async function setRouting(business, user, stayId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  const given = c.CATEGORIES.filter((k) => body[k] !== undefined);
  if (!given.length) fail('Say where a kind of charge goes: room, meals, extras or goods');
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    if (!['reserved', 'in_house'].includes(stay.status)) fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: its charges are routed while it is reserved or in the house`, 409);
    const said = [];
    for (const category of given) {
      const folio = await folioOf(db, business, stay, body[category]);
      if (folio) {
        await db.query(`INSERT INTO lodging_routes(business_id,stay_id,category,folio_id,updated_by) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT (business_id,stay_id,category) DO UPDATE SET folio_id=EXCLUDED.folio_id,updated_by=EXCLUDED.updated_by,updated_at=now()`, [business.id, stay.id, category, folio.id, user.id]);
      } else {
        await db.query('DELETE FROM lodging_routes WHERE business_id=$1 AND stay_id=$2 AND category=$3', [business.id, stay.id, category]);
      }
      const moved = await db.query(`UPDATE lodging_charges SET folio_id=$4 WHERE business_id=$1 AND stay_id=$2 AND kind=ANY($3::text[]) AND line_id IS NULL AND voided_at IS NULL
        AND folio_id IS DISTINCT FROM $4`, [business.id, stay.id, KINDS[category], folio?.id || null]);
      said.push(`${category} to ${folio ? folio.name : 'the main folio'}${moved.rowCount ? ` (${c.plural(moved.rowCount, 'charge')} moved)` : ''}`);
    }
    await stays.history(db, business, user, stay, null, null, `Routed: ${c.listWords(said)}`);
    await repo.audit(db, business.id, user.id, 'lodging_stay.routed', stay.id, { stayNo: stay.stay_no, routes: Object.fromEntries(given.map((k) => [k, body[k] === '' ? null : body[k]])) });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

// body: { folioId } (null: the main folio) — a charge not yet billed moved to another folio of the stay (or its group's).
async function moveCharge(business, user, stayId, chargeId, body) {
  c.requireLodging(business);
  await access.require(business, 'lodging.create');
  return repo.transaction(async (db) => {
    const stay = await stays.lockStay(db, business, stayId);
    const charge = await repo.one(db, 'SELECT * FROM lodging_charges WHERE business_id=$1 AND stay_id=$2 AND id=$3 FOR UPDATE', [business.id, stay.id, id(chargeId, 'Charge')]);
    if (!charge) fail('Charge not found', 404);
    if (charge.line_id || charge.voided_at) fail('That charge is billed or voided: it stays on its folio', 409);
    if (charge.kind === 'cancellation') fail('A cancellation charge is billed to the guest', 409);
    if (stay.status !== 'in_house') fail(`Stay ${stay.stay_no} is ${c.STATUS_WORDS[stay.status]}: its charges move while the guest is in the house`, 409);
    const folio = await folioOf(db, business, stay, body.folioId ?? null);
    if (Number(charge.folio_id || 0) === Number(folio?.id || 0)) return stays.shape(business, await stays.load(db, business, stay.id));
    await db.query('UPDATE lodging_charges SET folio_id=$3 WHERE business_id=$1 AND id=$2', [business.id, charge.id, folio?.id || null]);
    await stays.history(db, business, user, stay, null, null, `Moved: ${charge.label} to ${folio ? `folio ${folio.name}` : 'the main folio'}`);
    await repo.audit(db, business.id, user.id, 'lodging_charge.moved', stay.id, { stayNo: stay.stay_no, label: charge.label, from: charge.folio_id, to: folio?.id || null });
    return stays.shape(business, await stays.load(db, business, stay.id));
  });
}

module.exports = { KINDS, customerOf, createFolio, updateFolio, setRouting, moveCharge };
