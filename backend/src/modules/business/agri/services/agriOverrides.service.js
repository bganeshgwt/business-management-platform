const crypto = require('node:crypto');
const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// A manager's override at the counter (agri_overrides), given before the bill
// with the manager's PIN and a reason, and used by one bill at the same till
// on the day it was given:
//   restricted_use  these restricted-use pesticides, for a buyer not tagged as
//                   a pest-control operator or a government body
//   bag_limit       a farmer's subsidised bags over the month's limit
// Each only while the shop's setting allows an override instead of a stop.
// The approver's role holds agri.approve; a manager may allow their own bill
// with the reason alone. The PIN is checked before anything is locked, and
// never kept (nor in the request's hash).

const { fail, requireAgri } = common;
const KINDS = ['restricted_use', 'bag_limit'];
const pins = () => require('../../salon-weight/services/businessManagerPin');
const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
const id = (value, name = 'Record ID') => v.requiredId(value, name);

// Who may give an override: members whose role holds agri.approve, with whether they have a PIN
// and whether someone else set it (pin_given: it approves nothing until they choose their own).
async function approvers(business) {
  requireAgri(business);
  return repo.all(repo.pool, `SELECT u.id,u.name,(u.pin_hash IS NOT NULL) AS has_pin,u.pin_must_change AS pin_given FROM business_memberships m JOIN users u ON u.id=m.user_id AND u.status='active'
    JOIN business_roles r ON r.business_id=m.business_id AND r.id=m.role_id AND r.active
    WHERE m.business_id=$1 AND m.active AND (r.full_access OR EXISTS (SELECT 1 FROM business_role_permissions p WHERE p.business_id=r.business_id AND p.role_id=r.id
      AND p.permission_code='agri.approve')) ORDER BY u.name`, [business.id]);
}

// The restricted-use molecules an item is sold under (none: anyone may buy it).
async function restrictedOf(db, sku) {
  const item = common.classification(sku.attributes);
  if (item.kind !== 'pesticide') return [];
  const { byName } = await common.molecules(db);
  return item.molecules.map((name) => byName.get(common.normal(name))).filter((m) => m?.users_only
    && (!m.users_formulation || common.formulaKey(item.formulation).includes(common.formulaKey(m.users_formulation))));
}

// body: { requestKey, kind, locationId, contactId? (a bag limit's farmer; a
// restricted-use pesticide's buyer, when one is chosen), skuIds? (restricted
// use: the pesticides it allows), approval: { approverId?, pin?, reason } }
async function give(business, user, body) {
  requireAgri(business);
  await access.require(business, 'sales.create');
  const kind = v.requiredEnum(body.kind, 'Override', KINDS);
  const requestKey = require('../../core/services/business.service').uuid(body.requestKey);
  const given = body.approval && typeof body.approval === 'object' && !Array.isArray(body.approval) ? body.approval : {};
  const approval = await pins().readApproval(business, user, given, 'agri.approve', { reasonLabel: 'Why it is allowed', selfWithoutPin: true });
  const hash = hashOf({ ...body, approval: { approverId: given.approverId ?? null, reason: approval.reason } });
  const locationId = id(body.locationId, 'Location');
  access.requireLocation(business, locationId);
  const contactId = body.contactId === undefined || body.contactId === null || body.contactId === '' ? null : id(body.contactId, 'Customer');
  const skuIds = kind === 'restricted_use' ? [...new Set(v.requiredArray(body.skuIds, 'Items').map((x) => id(x, 'Item')))] : [];
  if (kind === 'restricted_use' && (!skuIds.length || skuIds.length > 100)) fail('Name between 1 and 100 pesticides the override allows');
  if (kind === 'bag_limit' && !contactId) fail('A farmer\'s bags over the limit are allowed for that farmer: choose the customer first');
  return repo.transaction(async (db) => {
    await db.query('SELECT id FROM businesses WHERE id=$1 FOR UPDATE', [business.id]);
    const done = await repo.one(db, 'SELECT * FROM agri_overrides WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (done) {
      if (done.request_hash !== hash) fail('This request key was already used for different data', 409);
      return shape(db, business, done.id);
    }
    const location = await repo.one(db, 'SELECT id,name FROM business_locations WHERE business_id=$1 AND id=$2 AND active', [business.id, locationId]);
    if (!location) fail('Location not found', 404);
    const contact = contactId ? await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'", [business.id, contactId]) : null;
    if (contactId && !contact) fail('Customer not found', 404);
    const settings = await common.settingsOf(db, business);
    if (kind === 'restricted_use' && settings.restricted_use !== 'override') {
      fail('This shop stops restricted-use pesticides for buyers not tagged as pest-control operators or government bodies: no override is given (Settings › Farm input checks).', 409);
    }
    if (kind === 'bag_limit' && settings.bag_limit_mode !== 'override') {
      fail('This shop stops subsidised bags over the month\'s limit: no override is given (Settings › Farm input checks).', 409);
    }
    const skus = skuIds.length ? await repo.all(db, 'SELECT id,label,attributes FROM catalog_skus WHERE business_id=$1 AND id=ANY($2::bigint[])', [business.id, skuIds]) : [];
    if (skus.length !== skuIds.length) fail('Item not found', 404);
    for (const sku of skus) {
      if (!(await restrictedOf(db, sku)).length) fail(`${sku.label} is not a restricted-use pesticide: it needs no override`);
    }
    const today = await common.today(db, business);
    const row = await repo.one(db, `INSERT INTO agri_overrides(business_id,kind,location_id,contact_id,sku_ids,given_on,reason,approved_by,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [business.id, kind, location.id, contact?.id || null, skuIds, today, approval.reason, approval.approver.id, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'agri.override_given', row.id, { kind, location: location.name, ...(contact ? { customer: contact.name } : {}),
      ...(skus.length ? { items: skus.map((s) => s.label) } : {}), approvedBy: approval.approver.name, reason: approval.reason });
    return shape(db, business, row.id);
  });
}

async function shape(db, business, overrideId) {
  const row = await repo.one(db, `SELECT o.id,o.kind,o.location_id,o.contact_id,o.sku_ids,o.given_on::text AS given_on,o.reason,o.document_id,o.created_at,
      a.name AS approved_by_name,c.name AS contact_name
    FROM agri_overrides o JOIN users a ON a.id=o.approved_by LEFT JOIN business_contacts c ON c.business_id=o.business_id AND c.id=o.contact_id
    WHERE o.business_id=$1 AND o.id=$2`, [business.id, overrideId]);
  return { ...row, sku_ids: row.sku_ids.map(Number) };
}

// The overrides a bill names, checked for it: unused, given today at its
// till, for its customer. Returns { restricted_use?, bag_limit? }.
async function forBill(db, business, ids, { location, contact, today }) {
  const out = {};
  for (const overrideId of ids) {
    const row = await repo.one(db, 'SELECT * FROM agri_overrides WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, overrideId]);
    if (!row) fail('That manager\'s override was not found', 404);
    if (row.document_id) fail('That manager\'s override was used by another bill: ask for a new one', 409);
    if (row.given_on !== today) fail('A manager\'s override is used the day it is given: ask for a new one', 409);
    if (Number(row.location_id) !== Number(location.id)) fail('That manager\'s override was given for another till', 409);
    if (row.contact_id && Number(row.contact_id) !== Number(contact?.id)) fail('That manager\'s override was given for another customer', 409);
    if (out[row.kind]) fail('Name one override of each kind on a bill');
    out[row.kind] = { ...row, sku_ids: row.sku_ids.map(Number) };
  }
  return out;
}

// After the bill is saved: each override it used is used up.
async function useUp(db, business, overrides, documentId) {
  for (const row of Object.values(overrides)) {
    await db.query('UPDATE agri_overrides SET document_id=$3 WHERE business_id=$1 AND id=$2', [business.id, row.id, documentId]);
  }
}

module.exports = { approvers, restrictedOf, give, forBill, useUp };
