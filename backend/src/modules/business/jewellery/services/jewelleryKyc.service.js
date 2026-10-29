const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const core = require('../../core/services/business.service');
const c = require('./jewelleryCommon');

// Customers' KYC (module "jewellery"): the officially valid documents a
// customer showed, each with its type (the shop keeps the list of types it
// accepts, in Jewellery settings: the exact list was not taken from the
// guidelines, so it is the shop's data), its number (of an Aadhaar card, only
// the last four digits are kept), the name on it, the day it was seen and a
// copy (a photo or PDF); and a firm's beneficial owners (name, role, share
// and PAN). A dealer in precious metals keeps a customer's identity records
// at least five years after the relationship ends: they are kept whatever the
// personal-data erasure does to the customer's record (personalDataRegistry.js),
// and the screen shows the earliest day they may go (five years after the
// customer's last transaction). Numbers and PANs are shown in full, and
// copies opened, only to those who may see KYC (jewellery.manage); everyone
// else who sees customers sees the last four (a karigar sees none of it). A
// record is never changed or deleted: one entered
// by mistake is set aside, with why.

const { fail, id } = c;
const KEEP_YEARS = 5;
const AADHAAR_RULE = 'Of an Aadhaar card, only the last four digits are kept.';
const isAadhaar = (kind) => /aadhaar/i.test(kind);
// The last four characters, the rest hidden: ••••••1234.
const masked = (text) => (text ? `${'•'.repeat(Math.max(0, Math.min(8, String(text).length - 4)))}${String(text).slice(-4)}` : text);
const seesKyc = (business) => access.can(business, 'jewellery.manage');

async function customerRow(db, business, contactId) {
  const row = await repo.one(db, `SELECT id,name,phone,gstin,pan,active,erased_at FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer'`,
    [business.id, id(contactId, 'Customer')]);
  if (!row) fail('Customer not found', 404);
  return row;
}

// The customer's KYC as the caller may see it, and when it may go: five years after their last transaction.
async function kycOf(db, business, contactId) {
  const customer = await customerRow(db, business, contactId);
  const [documents, owners, last] = await c.inTurn(
    () => repo.all(db, `SELECT d.id,d.kind,d.number,d.name_on_document,d.seen_on::text AS seen_on,d.notes,d.created_at,u.name AS by_name,d.removed_at,d.remove_reason,
        ru.name AS removed_by_name,(SELECT f.id FROM jewellery_files f WHERE f.business_id=d.business_id AND f.kyc_id=d.id AND f.removed_at IS NULL ORDER BY f.id DESC LIMIT 1) AS copy_id
      FROM jewellery_kyc_documents d JOIN users u ON u.id=d.created_by LEFT JOIN users ru ON ru.id=d.removed_by
      WHERE d.business_id=$1 AND d.contact_id=$2 ORDER BY (d.removed_at IS NULL) DESC,d.id DESC`, [business.id, customer.id]),
    () => repo.all(db, `SELECT o.id,o.name,o.role,o.share_percent,o.pan,o.created_at,u.name AS by_name,o.removed_at FROM jewellery_kyc_owners o JOIN users u ON u.id=o.created_by
      WHERE o.business_id=$1 AND o.contact_id=$2 ORDER BY (o.removed_at IS NULL) DESC,o.id`, [business.id, customer.id]),
    () => repo.one(db, `SELECT (max(at) AT TIME ZONE $3)::date::text AS day FROM (
        SELECT created_at AS at FROM business_documents WHERE business_id=$1 AND contact_id=$2
        UNION ALL SELECT created_at FROM business_collections WHERE business_id=$1 AND contact_id=$2
        UNION ALL SELECT created_at FROM jewellery_old_gold WHERE business_id=$1 AND contact_id=$2) x`, [business.id, customer.id, business.timezone]));
  const full = seesKyc(business);
  const keepUntil = last?.day ? `${Number(last.day.slice(0, 4)) + KEEP_YEARS}${last.day.slice(4)}` : null;
  return { customer: { id: customer.id, name: customer.name, phone: customer.phone, gstin: customer.gstin, pan: full ? customer.pan : masked(customer.pan), erased: Boolean(customer.erased_at) },
    full, lastTransaction: last?.day || null, keepUntil, keepYears: KEEP_YEARS, aadhaarRule: AADHAAR_RULE,
    documents: documents.map((d) => ({ ...d, number: full ? d.number : masked(d.number), copy_id: full ? d.copy_id : null, has_copy: Boolean(d.copy_id) })),
    owners: owners.map((o) => ({ ...o, pan: full ? o.pan : masked(o.pan) })),
    kinds: (await require('./jewellerySettings.service').settingsOf(db, business.id)).kyc_kinds || [] };
}

async function detail(business, contactId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.view');
  await access.require(business, 'contacts.view');
  return kycOf(repo.pool, business, contactId);
}

// body: { requestKey, kind (one the shop accepts), number, nameOnDocument?, seenOn (today or earlier), notes? }
async function addDocument(business, user, contactId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await access.require(business, 'contacts.view');
  const requestKey = core.uuid(body.requestKey);
  const hash = c.hashOf(body);
  const kind = v.requiredString(body.kind, 'Document', 60);
  const number = String(body.number ?? '').toUpperCase().trim().replace(/\s+/g, ' ');
  if (isAadhaar(kind) && !/^\d{4}$/.test(number)) fail('Keep only the last four digits of an Aadhaar number');
  if (!/^[A-Z0-9][A-Z0-9/ -]{1,39}$/.test(number)) fail('The document\'s number is 2 to 40 letters and digits');
  const nameOnDocument = c.optionalText(body.nameOnDocument, 'Name on the document', 150);
  const seenOn = c.readDate(body.seenOn, 'Seen on');
  const notes = c.optionalText(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    await c.lockBusiness(db, business);
    const customer = await customerRow(db, business, contactId);
    const old = await repo.one(db, 'SELECT id,contact_id,request_hash FROM jewellery_kyc_documents WHERE business_id=$1 AND request_key=$2', [business.id, requestKey]);
    if (old) {
      if (old.request_hash !== hash || Number(old.contact_id) !== Number(customer.id)) fail('This request key was already used for different data', 409);
      return kycOf(db, business, customer.id);
    }
    if (customer.erased_at) fail('This customer\'s data was erased at their request', 409);
    const kinds = (await require('./jewellerySettings.service').settingsOf(db, business.id)).kyc_kinds || [];
    const known = kinds.find((k) => k.toLowerCase() === kind.toLowerCase());
    if (!known) fail(kinds.length ? `${kind} is not one of the documents the shop accepts: ${kinds.join(', ')}` : 'Name the KYC documents the shop accepts in Jewellery settings first', 409);
    if (seenOn > await c.today(db, business)) fail('A KYC document is seen today or earlier');
    const row = await repo.one(db, `INSERT INTO jewellery_kyc_documents(business_id,contact_id,kind,number,name_on_document,seen_on,notes,request_key,request_hash,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [business.id, customer.id, known, number, nameOnDocument, seenOn, notes, requestKey, hash, user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_kyc.recorded', row.id, { customerId: customer.id, kind: known, number: masked(number), seenOn });
    return kycOf(db, business, customer.id);
  });
}

// body: { reason }. A document entered by mistake is set aside (kept, with why); by someone who may see KYC.
async function setAsideDocument(business, user, contactId, documentId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.manage');
  const reason = v.requiredString(body.reason, 'Why it is set aside', 300);
  return repo.transaction(async (db) => {
    const customer = await customerRow(db, business, contactId);
    const doc = await repo.one(db, 'SELECT id,kind,number,removed_at FROM jewellery_kyc_documents WHERE business_id=$1 AND id=$2 AND contact_id=$3 FOR UPDATE',
      [business.id, id(documentId, 'Document'), customer.id]);
    if (!doc) fail('Document not found', 404);
    if (!doc.removed_at) {
      await db.query('UPDATE jewellery_kyc_documents SET removed_at=now(),removed_by=$3,remove_reason=$4 WHERE business_id=$1 AND id=$2', [business.id, doc.id, user.id, reason]);
      await repo.audit(db, business.id, user.id, 'jewellery_kyc.set_aside', doc.id, { customerId: customer.id, kind: doc.kind, number: masked(doc.number), reason });
    }
    return kycOf(db, business, customer.id);
  });
}

// body: { name, role, sharePercent?, pan? }. A firm's beneficial owner.
async function addOwner(business, user, contactId, body) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.create');
  await access.require(business, 'contacts.view');
  const name = v.requiredString(body.name, 'Owner\'s name', 150);
  const role = v.requiredString(body.role, 'Role (partner, director, shareholder…)', 60);
  const share = c.given(body.sharePercent) ? c.decimal(body.sharePercent, 'Share (%)', 2, 0.01, 100) : null;
  const pan = c.given(body.pan) ? String(body.pan).toUpperCase().replace(/\s+/g, '') : null;
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fail('A PAN is 10 letters and digits, like ABCDE1234F');
  return repo.transaction(async (db) => {
    const customer = await customerRow(db, business, contactId);
    if (customer.erased_at) fail('This customer\'s data was erased at their request', 409);
    const row = await repo.one(db, 'INSERT INTO jewellery_kyc_owners(business_id,contact_id,name,role,share_percent,pan,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [business.id, customer.id, name, role, share === null ? null : share.toFixed(2), pan, user.id]);
    await repo.audit(db, business.id, user.id, 'jewellery_kyc.owner_added', row.id, { customerId: customer.id, name, role, sharePercent: share === null ? null : share.toFixed(2),
      pan: masked(pan) });
    return kycOf(db, business, customer.id);
  });
}

async function setAsideOwner(business, user, contactId, ownerId) {
  c.requireJewellery(business);
  await access.require(business, 'jewellery.manage');
  return repo.transaction(async (db) => {
    const customer = await customerRow(db, business, contactId);
    const owner = await repo.one(db, 'SELECT id,name,removed_at FROM jewellery_kyc_owners WHERE business_id=$1 AND id=$2 AND contact_id=$3 FOR UPDATE',
      [business.id, id(ownerId, 'Owner'), customer.id]);
    if (!owner) fail('Owner not found', 404);
    if (!owner.removed_at) {
      await db.query('UPDATE jewellery_kyc_owners SET removed_at=now(),removed_by=$3 WHERE business_id=$1 AND id=$2', [business.id, owner.id, user.id]);
      await repo.audit(db, business.id, user.id, 'jewellery_kyc.owner_set_aside', owner.id, { customerId: customer.id, name: owner.name });
    }
    return kycOf(db, business, customer.id);
  });
}

// Which of these customers have a KYC document on file (for the cash report).
async function onFile(db, business, contactIds) {
  if (!contactIds.length) return new Set();
  const rows = await repo.all(db, 'SELECT DISTINCT contact_id FROM jewellery_kyc_documents WHERE business_id=$1 AND contact_id=ANY($2::bigint[]) AND removed_at IS NULL',
    [business.id, contactIds]);
  return new Set(rows.map((r) => Number(r.contact_id)));
}

module.exports = { AADHAAR_RULE, KEEP_YEARS, masked, seesKyc, detail, addDocument, setAsideDocument, addOwner, setAsideOwner, onFile };
