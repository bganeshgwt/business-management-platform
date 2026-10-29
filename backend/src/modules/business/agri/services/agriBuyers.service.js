const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const access = require('../../core/services/businessAccess.service');
const common = require('./agriCommon');

// A customer's tags as a buyer (agri_buyer_tags): a pest-control operator or
// a government body (with their licence or order reference, and its date),
// who may buy a restricted-use pesticide; a bulk consumer, whose insecticide
// purchases go in the Form XIII register. A tag in force is on and not past
// its date. Tagging someone a pest-control operator or a government body is
// a manager's (agri.approve); a bulk consumer, anyone who keeps farmers
// (agri.edit). Switched off, never deleted.

const { fail, requireAgri, TAGS, TAG_WORDS } = common;
const NEEDS = { pest_control_operator: 'agri.approve', government: 'agri.approve', bulk_consumer: 'agri.edit' };

repo.addLists({
  // Every tag with its customer, and whether it is in force today.
  'agri-buyer-tags': {
    sql: `SELECT x.*,(x.active AND (x.valid_until IS NULL OR x.valid_until>=x.today)) AS in_force FROM (
      SELECT t.contact_id::text||'-'||t.tag AS id,t.contact_id,t.tag,t.reference,t.valid_until,t.notes,t.active,t.created_at,t.updated_at,
        c.name,c.phone,c.address,c.gstin,u.name AS updated_by_name,(now() AT TIME ZONE b.timezone)::date AS today
      FROM agri_buyer_tags t JOIN business_contacts c ON c.business_id=t.business_id AND c.id=t.contact_id JOIN businesses b ON b.id=t.business_id
      LEFT JOIN users u ON u.id=COALESCE(t.updated_by,t.created_by) WHERE t.business_id=$1) x`,
    search: ['name', 'phone', 'reference', 'notes'],
    filters: { tag: 'tag', active: 'active', contact: 'contact_id' }, order: 'active DESC,name,tag',
  },
});
const listCheck = (business) => requireAgri(business);

// The tags in force for a customer on a day: [{ tag, reference, valid_until }].
const tagsOf = (db, business, contactId, day) => repo.all(db, `SELECT tag,reference,valid_until FROM agri_buyer_tags
  WHERE business_id=$1 AND contact_id=$2 AND active AND (valid_until IS NULL OR valid_until>=$3::date) ORDER BY tag`, [business.id, contactId, day]);

// body: { tag, reference? (required for a pest-control operator or a government
// body), validUntil?, notes?, active? } — a tag given, changed or switched off.
async function save(business, user, contactId, body) {
  requireAgri(business);
  const tag = v.requiredEnum(body.tag, 'Tag', TAGS);
  await access.require(business, NEEDS[tag]);
  const reference = v.optionalString(body.reference, tag === 'government' ? 'Order reference' : 'Licence number', 80);
  if (!reference && tag !== 'bulk_consumer') fail(`A ${TAG_WORDS[tag]} is tagged with ${tag === 'government' ? 'the order or authority it buys under' : 'their licence number'}`);
  const validUntil = body.validUntil === undefined || body.validUntil === null || body.validUntil === '' ? null : common.readDate(body.validUntil, 'Valid until');
  const notes = v.optionalString(body.notes, 'Notes', 300);
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' FOR UPDATE", [business.id, v.requiredId(contactId, 'Customer')]);
    if (!contact) fail('Customer not found', 404);
    const current = await repo.one(db, 'SELECT * FROM agri_buyer_tags WHERE business_id=$1 AND contact_id=$2 AND tag=$3 FOR UPDATE', [business.id, contact.id, tag]);
    const active = v.requiredBoolean(body.active, 'Active', true);
    if (!current) {
      if (!active) fail(`${contact.name} is not tagged as a ${TAG_WORDS[tag]}`, 404);
      await db.query(`INSERT INTO agri_buyer_tags(business_id,contact_id,tag,reference,valid_until,notes,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
        [business.id, contact.id, tag, reference, validUntil, notes, user.id]);
      await repo.audit(db, business.id, user.id, 'buyer.tagged', contact.id, { name: contact.name, tag, reference, validUntil });
    } else {
      await db.query('UPDATE agri_buyer_tags SET reference=$4,valid_until=$5,notes=$6,active=$7,updated_by=$8,updated_at=now() WHERE business_id=$1 AND contact_id=$2 AND tag=$3',
        [business.id, contact.id, tag, reference, validUntil, notes, active, user.id]);
      await repo.audit(db, business.id, user.id, active === current.active ? 'buyer.tag_changed' : active ? 'buyer.tag_switched_on' : 'buyer.tag_switched_off', contact.id,
        { name: contact.name, tag, from: { reference: current.reference, validUntil: current.valid_until, active: current.active }, to: { reference, validUntil, active } });
    }
    return repo.one(db, `SELECT t.*,c.name FROM agri_buyer_tags t JOIN business_contacts c ON c.business_id=t.business_id AND c.id=t.contact_id
      WHERE t.business_id=$1 AND t.contact_id=$2 AND t.tag=$3`, [business.id, contact.id, tag]);
  });
}

module.exports = { listCheck, tagsOf, save };
