const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');
const licences = require('./businessLicences.service');

// What a licence keeps beside it, by what it covers:
//   insecticides  the products or brands endorsed on it (Insecticides Rules
//                 1971, rule 10(4): selling another insecticide needs an
//                 endorsement), and each manufacturer's principal certificate
//                 (rule 10(4A)): its registration and manufacturing licence
//                 numbers, the formulations it authorises and its validity,
//                 withdrawn with a date when the principal withdraws it
//   fertilisers   the certificates of source in Form O (Fertiliser (Control)
//                 Order 1985, clause 8): one from each source the fertiliser
//                 comes from, with its number and date, and the supplier of
//                 this business it covers purchases from
// Each is switched off (or withdrawn), never deleted (a database trigger).
// The counter asks `insecticideNote` (a farm-input shop warns or stops,
// as its setting says) and a purchase asks `sourceNote` (it warns).

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const { dateWords, readDate, optionalDate, blank } = licences;
const normal = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// The licence the record goes on, covering what the record is about.
async function licenceFor(db, business, licenceId, category) {
  const licence = await licences.load(db, business, licenceId, { lock: true });
  if (!licence.covers.includes(category)) {
    fail(category === 'insecticide' ? `${licence.name} does not cover insecticides: endorsements and principal certificates go on an insecticide licence`
      : `${licence.name} does not cover fertilisers: certificates of source (Form O) go on a fertiliser authorisation`);
  }
  return licence;
}
async function begin(business, user, licenceId, category, work) {
  licences.requireLicences(business);
  await access.require(business, 'licences.edit');
  return repo.transaction(async (db) => {
    const licence = await licenceFor(db, business, licenceId, category);
    const result = await work(db, licence);
    return { ...(await licences.detail(db, business, licence.id, { full: true })), saved: result };
  });
}

// --- Reading one licence's records ------------------------------------------------------------------

// Each principal certificate's standing on the business's date: valid, not
// yet valid, run out, or withdrawn.
const principalState = (p, today) => (p.withdrawn_on && p.withdrawn_on <= today ? 'withdrawn' : p.valid_from > today ? 'not_yet'
  : p.valid_until && p.valid_until < today ? 'expired' : 'valid');

async function ofLicence(db, business, licence) {
  const insecticide = licence.covers.includes('insecticide'), fertiliser = licence.covers.includes('fertiliser');
  const endorsements = insecticide ? await repo.all(db, `SELECT e.*,p.name AS product_name,p.brand AS product_brand FROM business_licence_endorsements e
      LEFT JOIN catalog_products p ON p.business_id=e.business_id AND p.id=e.product_id WHERE e.business_id=$1 AND e.licence_id=$2
      ORDER BY e.active DESC,COALESCE(p.name,e.brand)`, [business.id, licence.id]) : [];
  const principals = insecticide ? (await repo.all(db, `SELECT * FROM business_licence_principals WHERE business_id=$1 AND licence_id=$2
      ORDER BY lower(manufacturer),valid_from DESC,id DESC`, [business.id, licence.id])).map((p) => ({ ...p, state: principalState(p, licence.today) })) : [];
  const sources = fertiliser ? await repo.all(db, `SELECT s.*,c.name AS contact_name FROM business_licence_sources s
      LEFT JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.business_id=$1 AND s.licence_id=$2
      ORDER BY s.active DESC,lower(s.name)`, [business.id, licence.id]) : [];
  return { keeps_endorsements: insecticide, keeps_sources: fertiliser, endorsements, principals, sources };
}

// --- Endorsements -----------------------------------------------------------------------------

// body: { productId | brand, endorsedOn? } — an item (every pack of it) or a brand endorsed on the licence.
async function addEndorsement(business, user, licenceId, body) {
  const productGiven = !blank(body.productId), brand = v.optionalString(body.brand, 'Brand', 100);
  if (productGiven === Boolean(brand)) fail('Endorse one item or one brand at a time');
  const endorsedOn = optionalDate(body.endorsedOn, 'Endorsed on');
  return begin(business, user, licenceId, 'insecticide', async (db, licence) => {
    let product = null;
    if (productGiven) {
      product = await repo.one(db, 'SELECT id,name FROM catalog_products WHERE business_id=$1 AND id=$2', [business.id, id(body.productId, 'Item')]);
      if (!product) fail('Item not found', 404);
    }
    const clash = await repo.one(db, `SELECT id,active FROM business_licence_endorsements WHERE business_id=$1 AND licence_id=$2
      AND (product_id=$3 OR ($4::text IS NOT NULL AND lower(brand)=lower($4)))`, [business.id, licence.id, product?.id || null, brand]);
    if (clash) fail(`${product ? product.name : brand} is already ${clash.active ? 'endorsed on' : 'kept, switched off, on'} this licence${clash.active ? '' : ': switch it on again'}`, 409);
    const row = await repo.one(db, `INSERT INTO business_licence_endorsements(business_id,licence_id,product_id,brand,endorsed_on,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id`, [business.id, licence.id, product?.id || null, brand, endorsedOn, user.id]);
    await repo.audit(db, business.id, user.id, 'licence.endorsement_added', licence.id, { licenceNo: licence.licence_no, endorsementId: row.id,
      ...(product ? { item: product.name } : { brand }), endorsedOn });
    return { id: row.id };
  });
}

// body: { active?, endorsedOn? } — an endorsement that no longer stands is switched off.
async function updateEndorsement(business, user, licenceId, endorsementId, body) {
  return begin(business, user, licenceId, 'insecticide', async (db, licence) => {
    const current = await repo.one(db, `SELECT e.*,p.name AS product_name FROM business_licence_endorsements e LEFT JOIN catalog_products p ON p.business_id=e.business_id AND p.id=e.product_id
      WHERE e.business_id=$1 AND e.licence_id=$2 AND e.id=$3 FOR UPDATE OF e`, [business.id, licence.id, id(endorsementId, 'Endorsement')]);
    if (!current) fail('Endorsement not found', 404);
    const active = v.requiredBoolean(body.active, 'Active', current.active);
    const endorsedOn = body.endorsedOn === undefined ? current.endorsed_on : optionalDate(body.endorsedOn, 'Endorsed on');
    if (active === current.active && endorsedOn === current.endorsed_on) return { id: current.id };
    await db.query('UPDATE business_licence_endorsements SET active=$4,endorsed_on=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND licence_id=$2 AND id=$3',
      [business.id, licence.id, current.id, active, endorsedOn, user.id]);
    await repo.audit(db, business.id, user.id, active === current.active ? 'licence.endorsement_changed' : active ? 'licence.endorsement_switched_on' : 'licence.endorsement_switched_off',
      licence.id, { licenceNo: licence.licence_no, endorsementId: current.id, ...(current.product_name ? { item: current.product_name } : { brand: current.brand }),
        from: { active: current.active, endorsedOn: current.endorsed_on }, to: { active, endorsedOn } });
    return { id: current.id };
  });
}

// --- Principal certificates -------------------------------------------------------------------

function readPrincipal(body, { manufacturerGiven = true } = {}) {
  const formulations = v.requiredArray(body.formulations, 'Formulations authorised').map((f) => v.requiredString(f, 'Formulation', 20).replace(/\s+/g, ' '));
  if (!formulations.length || formulations.length > 20) fail('Name between 1 and 20 formulations the certificate authorises (EC, WP, SC…)');
  if (new Set(formulations.map(normal)).size !== formulations.length) fail('Each formulation is named once');
  const validFrom = readDate(body.validFrom, 'Valid from');
  const validUntil = optionalDate(body.validUntil, 'Valid until');
  if (validUntil && validUntil < validFrom) fail('A certificate cannot run out before it is valid from');
  return {
    manufacturer: manufacturerGiven ? v.requiredString(body.manufacturer, 'Manufacturer', 150).replace(/\s+/g, ' ') : null,
    registrationNo: v.requiredString(body.registrationNo, 'Registration number', 200), manufacturingLicenceNo: v.requiredString(body.manufacturingLicenceNo, 'Manufacturing licence number', 80),
    formulations, validFrom, validUntil,
  };
}

// body: { manufacturer, registrationNo, manufacturingLicenceNo, formulations: [..], validFrom, validUntil? }
async function addPrincipal(business, user, licenceId, body) {
  const f = readPrincipal(body);
  return begin(business, user, licenceId, 'insecticide', async (db, licence) => {
    const overlap = await repo.one(db, `SELECT id FROM business_licence_principals WHERE business_id=$1 AND licence_id=$2 AND lower(manufacturer)=lower($3) AND withdrawn_on IS NULL
      AND valid_from<=COALESCE($5::date,'infinity') AND COALESCE(valid_until,'infinity')>=$4::date`, [business.id, licence.id, f.manufacturer, f.validFrom, f.validUntil]);
    if (overlap) fail(`${f.manufacturer} already has a principal certificate on this licence for those dates: change it, or record its withdrawal first`, 409);
    const row = await repo.one(db, `INSERT INTO business_licence_principals(business_id,licence_id,manufacturer,registration_no,manufacturing_licence_no,formulations,valid_from,valid_until,
      created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
    [business.id, licence.id, f.manufacturer, f.registrationNo, f.manufacturingLicenceNo, f.formulations, f.validFrom, f.validUntil, user.id]);
    await repo.audit(db, business.id, user.id, 'licence.principal_added', licence.id, { licenceNo: licence.licence_no, principalId: row.id, manufacturer: f.manufacturer,
      registrationNo: f.registrationNo, manufacturingLicenceNo: f.manufacturingLicenceNo, formulations: f.formulations, validFrom: f.validFrom, validUntil: f.validUntil });
    return { id: row.id };
  });
}

// body: the certificate's details as for a new one but the manufacturer; or
// { withdrawnOn, withdrawnNote? } when the principal withdraws it (it stands once recorded).
async function updatePrincipal(business, user, licenceId, principalId, body) {
  const withdrawing = !blank(body.withdrawnOn);
  const withdrawnOn = withdrawing ? readDate(body.withdrawnOn, 'Withdrawn on') : null;
  const note = withdrawing ? v.optionalString(body.withdrawnNote, 'Note on the withdrawal', 300) : null;
  const f = withdrawing ? null : readPrincipal(body, { manufacturerGiven: false });
  return begin(business, user, licenceId, 'insecticide', async (db, licence) => {
    const current = await repo.one(db, 'SELECT * FROM business_licence_principals WHERE business_id=$1 AND licence_id=$2 AND id=$3 FOR UPDATE',
      [business.id, licence.id, id(principalId, 'Principal certificate')]);
    if (!current) fail('Principal certificate not found', 404);
    if (current.withdrawn_on) fail(`${current.manufacturer}'s certificate was withdrawn on ${dateWords(current.withdrawn_on)}: add the new certificate on its own`, 409);
    if (withdrawing) {
      if (withdrawnOn < current.valid_from) fail('A certificate is withdrawn on or after the day it is valid from');
      if (withdrawnOn > await licences.today(db, business)) fail('A withdrawal is recorded once it has happened: the date cannot be ahead of today');
      await db.query('UPDATE business_licence_principals SET withdrawn_on=$4,withdrawn_note=$5,updated_by=$6,updated_at=now() WHERE business_id=$1 AND licence_id=$2 AND id=$3',
        [business.id, licence.id, current.id, withdrawnOn, note, user.id]);
      await repo.audit(db, business.id, user.id, 'licence.principal_withdrawn', licence.id, { licenceNo: licence.licence_no, principalId: current.id,
        manufacturer: current.manufacturer, withdrawnOn, note });
      return { id: current.id };
    }
    await db.query(`UPDATE business_licence_principals SET registration_no=$4,manufacturing_licence_no=$5,formulations=$6,valid_from=$7,valid_until=$8,updated_by=$9,updated_at=now()
      WHERE business_id=$1 AND licence_id=$2 AND id=$3`, [business.id, licence.id, current.id, f.registrationNo, f.manufacturingLicenceNo, f.formulations, f.validFrom, f.validUntil, user.id]);
    await repo.audit(db, business.id, user.id, 'licence.principal_changed', licence.id, { licenceNo: licence.licence_no, principalId: current.id, manufacturer: current.manufacturer,
      from: { registrationNo: current.registration_no, manufacturingLicenceNo: current.manufacturing_licence_no, formulations: current.formulations, validFrom: current.valid_from, validUntil: current.valid_until },
      to: { registrationNo: f.registrationNo, manufacturingLicenceNo: f.manufacturingLicenceNo, formulations: f.formulations, validFrom: f.validFrom, validUntil: f.validUntil } });
    return { id: current.id };
  });
}

// --- Sources (Form O) ---------------------------------------------------------------------------

async function readSource(db, business, body) {
  let supplier = null;
  if (!blank(body.contactId)) {
    supplier = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='supplier'", [business.id, id(body.contactId, 'Supplier')]);
    if (!supplier) fail('Supplier not found', 404);
  }
  const name = v.optionalString(body.name, 'Source', 150) || supplier?.name;
  if (!name) fail('Give the source the certificate names, or choose the supplier it covers');
  const certificateDate = readDate(body.certificateDate, 'Certificate date');
  if (certificateDate > await licences.today(db, business)) fail('A certificate of source is dated today or earlier');
  return { supplier, name: name.replace(/\s+/g, ' '), certificateNo: v.requiredString(body.certificateNo, 'Certificate number', 80), certificateDate };
}

// body: { contactId? (the supplier it covers purchases from), name? (as on the certificate; the supplier's name to start with), certificateNo, certificateDate }
async function addSource(business, user, licenceId, body) {
  return begin(business, user, licenceId, 'fertiliser', async (db, licence) => {
    const f = await readSource(db, business, body);
    const clash = await repo.one(db, 'SELECT id FROM business_licence_sources WHERE business_id=$1 AND licence_id=$2 AND lower(certificate_no)=lower($3)', [business.id, licence.id, f.certificateNo]);
    if (clash) fail(`Certificate ${f.certificateNo} is already kept on this authorisation`, 409);
    const row = await repo.one(db, `INSERT INTO business_licence_sources(business_id,licence_id,name,contact_id,certificate_no,certificate_date,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`, [business.id, licence.id, f.name, f.supplier?.id || null, f.certificateNo, f.certificateDate, user.id]);
    await repo.audit(db, business.id, user.id, 'licence.source_added', licence.id, { licenceNo: licence.licence_no, sourceId: row.id, source: f.name,
      ...(f.supplier ? { supplier: f.supplier.name } : {}), certificateNo: f.certificateNo, certificateDate: f.certificateDate });
    return { id: row.id };
  });
}

// body: the same, and active? (switched off when it no longer stands).
async function updateSource(business, user, licenceId, sourceId, body) {
  return begin(business, user, licenceId, 'fertiliser', async (db, licence) => {
    const current = await repo.one(db, 'SELECT * FROM business_licence_sources WHERE business_id=$1 AND licence_id=$2 AND id=$3 FOR UPDATE', [business.id, licence.id, id(sourceId, 'Source')]);
    if (!current) fail('Source not found', 404);
    const f = await readSource(db, business, body);
    const active = v.requiredBoolean(body.active, 'Active', current.active);
    const clash = await repo.one(db, 'SELECT id FROM business_licence_sources WHERE business_id=$1 AND licence_id=$2 AND lower(certificate_no)=lower($3) AND id<>$4',
      [business.id, licence.id, f.certificateNo, current.id]);
    if (clash) fail(`Certificate ${f.certificateNo} is already kept on this authorisation`, 409);
    await db.query(`UPDATE business_licence_sources SET name=$4,contact_id=$5,certificate_no=$6,certificate_date=$7,active=$8,updated_by=$9,updated_at=now()
      WHERE business_id=$1 AND licence_id=$2 AND id=$3`, [business.id, licence.id, current.id, f.name, f.supplier?.id || null, f.certificateNo, f.certificateDate, active, user.id]);
    await repo.audit(db, business.id, user.id, active === current.active ? 'licence.source_changed' : active ? 'licence.source_switched_on' : 'licence.source_switched_off', licence.id, {
      licenceNo: licence.licence_no, sourceId: current.id, source: f.name,
      from: { name: current.name, contactId: current.contact_id, certificateNo: current.certificate_no, certificateDate: current.certificate_date, active: current.active },
      to: { name: f.name, contactId: f.supplier?.id || null, certificateNo: f.certificateNo, certificateDate: f.certificateDate, active } });
    return { id: current.id };
  });
}

// --- What the counter and a purchase ask -----------------------------------------------------------

// Why an insecticide may not be sold under the licence in force (null: it
// may): not endorsed on it (the item or its brand), its manufacturer unknown,
// or the manufacturer's principal certificate missing, withdrawn, not yet
// valid or run out on the day. sku: the item (with product_id and attributes).
async function insecticideNote(db, business, { licence, sku, label, on, locationName }) {
  const named = `${locationName}'s insecticide licence (${licence.licence_no})`;
  const product = await repo.one(db, 'SELECT brand FROM catalog_products WHERE business_id=$1 AND id=$2', [business.id, sku.product_id]);
  const endorsed = await repo.one(db, `SELECT 1 FROM business_licence_endorsements WHERE business_id=$1 AND licence_id=$2 AND active
    AND (product_id=$3 OR ($4::text IS NOT NULL AND lower(brand)=lower($4))) LIMIT 1`, [business.id, licence.id, sku.product_id, product?.brand || null]);
  if (!endorsed) return { reason: 'not_endorsed', message: `${label} is not endorsed on ${named}: add the item or its brand to the licence's endorsements under Settings › Licences` };
  const maker = String(sku.attributes?.manufacturer || product?.brand || '').trim();
  if (!maker) return { reason: 'no_manufacturer', message: `${label} names no manufacturer, so its principal certificate cannot be checked: give the item its manufacturer` };
  const certificate = await repo.one(db, `SELECT * FROM business_licence_principals WHERE business_id=$1 AND licence_id=$2 AND lower(manufacturer)=lower($3)
    ORDER BY ((withdrawn_on IS NULL OR withdrawn_on>$4::date) AND valid_from<=$4::date AND (valid_until IS NULL OR valid_until>=$4::date)) DESC,valid_from DESC,id DESC LIMIT 1`,
  [business.id, licence.id, maker.replace(/\s+/g, ' '), on]);
  if (!certificate) return { reason: 'no_principal', message: `${named} holds no principal certificate from ${maker}, who makes ${label}` };
  const state = principalState(certificate, on);
  if (state === 'withdrawn') return { reason: 'principal_withdrawn', message: `${maker}'s principal certificate on ${named} was withdrawn on ${dateWords(certificate.withdrawn_on)}, so ${label} is not sold under it` };
  if (state === 'not_yet') return { reason: 'principal_not_yet', message: `${maker}'s principal certificate on ${named} is valid only from ${dateWords(certificate.valid_from)}` };
  if (state === 'expired') return { reason: 'principal_expired', message: `${maker}'s principal certificate on ${named} was valid until ${dateWords(certificate.valid_until)}` };
  return null;
}

// Why a purchase of fertiliser from a supplier is not covered (null: it is):
// the location's authorisation in force has no Form O naming that supplier.
async function sourceNote(db, business, { location, supplier, on }) {
  const licence = await licences.standing(db, business, { locationId: location.id, category: 'fertiliser', on });
  if (!licence?.in_force) return `${licences.whyNot(licence, 'fertiliser authorisation', location.name)}, so no certificate of source (Form O) from ${supplier.name} is kept for it`;
  const covered = await repo.one(db, `SELECT 1 FROM business_licence_sources WHERE business_id=$1 AND licence_id=$2 AND active
    AND (contact_id=$3 OR lower(name)=lower($4)) LIMIT 1`, [business.id, licence.id, supplier.id, supplier.name.replace(/\s+/g, ' ')]);
  if (covered) return null;
  return `${location.name}'s fertiliser authorisation (${licence.licence_no}) has no certificate of source (Form O) from ${supplier.name}: add it under Settings › Licences`;
}

module.exports = { ofLicence, addEndorsement, updateEndorsement, addPrincipal, updatePrincipal, addSource, updateSource, insecticideNote, sourceNote, principalState };
