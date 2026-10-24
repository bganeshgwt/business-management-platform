const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const access = require('../../core/services/businessAccess.service');

// Hardware, paints & building materials: a contractor's or builder's sites
// (module "hardware_sites"). A site belongs to one customer; a bill, a
// quotation or a sales order of that customer may go to it (link tables
// hardware_document_sites / _quotation_sites / _order_sites), and the
// invoices of a dispatched order take the order's site (a database
// trigger). A site's ledger is its bills, what came back, what was paid on
// them and what is still due, in date order with a running balance.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const id = (value, name = 'Record ID') => v.requiredId(value, name);
const given = (value) => value !== undefined && value !== null && value !== '';
const paise = (value) => Math.round(Number(value) * 100);
const rupees = (p) => (p / 100).toFixed(2);

function requireSites(business) {
  if (business.business_type !== 'hardware') fail('Sites belong to hardware shops', 404);
  if (!business.modules.includes('hardware_sites')) fail('Sites is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
}

// What is still to collect on a bill: its total less returns and payments, plus refunds.
const billBalanceSql = (d) => `(${d}.total
  -COALESCE((SELECT sum(r.total) FROM business_returns r WHERE r.business_id=${d}.business_id AND r.document_id=${d}.id),0)
  -COALESCE((SELECT sum(p.amount) FROM business_payments p WHERE p.business_id=${d}.business_id AND p.document_id=${d}.id),0)
  +COALESCE((SELECT sum(f.amount) FROM business_refunds f WHERE f.business_id=${d}.business_id AND f.document_id=${d}.id),0))`;

repo.addLists({
  // Each site with its customer, how many bills went there, what they came to and what is still due on them.
  'hardware-sites': {
    sql: `SELECT x.*,(x.due>0) AS has_due FROM (
      SELECT s.*,c.name AS customer_name,c.phone AS customer_phone,
      (SELECT count(*)::int FROM hardware_document_sites h WHERE h.business_id=s.business_id AND h.site_id=s.id) AS bill_count,
      (SELECT max(d.created_at) FROM hardware_document_sites h JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id
        WHERE h.business_id=s.business_id AND h.site_id=s.id) AS last_bill_at,
      COALESCE((SELECT sum(d.total) FROM hardware_document_sites h JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id
        WHERE h.business_id=s.business_id AND h.site_id=s.id),0) AS billed,
      COALESCE((SELECT sum(${billBalanceSql('d')}) FROM hardware_document_sites h JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id
        WHERE h.business_id=s.business_id AND h.site_id=s.id),0) AS due
      FROM hardware_sites s JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.business_id=$1) x`,
    search: ['name', 'address', 'contact_person', 'phone', 'customer_name'],
    filters: { contact: 'contact_id', active: 'active', id: 'id', has_due: 'has_due' }, order: 'active DESC,customer_name,name',
  },
});

function readPhone(value) {
  const phone = v.optionalString(value, 'Phone', 30);
  if (phone && phone.replace(/\D/g, '').length < 10) fail('A phone number has at least 10 digits');
  return phone || null;
}
function readSite(body) {
  return {
    name: v.requiredString(body.name, 'Site name', 150), address: v.optionalString(body.address, 'Address', 500) || null,
    contactPerson: v.optionalString(body.contactPerson, 'Contact person at the site', 150) || null, phone: readPhone(body.phone),
  };
}

// --- Sites -------------------------------------------------------------------------------------

// body: { contactId, name, address?, contactPerson?, phone? }
async function create(business, user, body) {
  requireSites(business);
  await access.require(business, 'hardware_sites.edit');
  const contactId = id(body.contactId, 'Customer');
  const site = readSite(body);
  return repo.transaction(async (db) => {
    const contact = await repo.one(db, "SELECT id,name FROM business_contacts WHERE business_id=$1 AND id=$2 AND kind='customer' AND active", [business.id, contactId]);
    if (!contact) fail('Customer not found', 404);
    const clash = await repo.one(db, 'SELECT id FROM hardware_sites WHERE business_id=$1 AND contact_id=$2 AND lower(name)=lower($3)', [business.id, contact.id, site.name]);
    if (clash) fail(`${contact.name} already has a site called ${site.name}`, 409);
    const row = await repo.one(db, `INSERT INTO hardware_sites(business_id,contact_id,name,address,contact_person,phone,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [business.id, contact.id, site.name, site.address, site.contactPerson, site.phone, user.id]);
    await repo.audit(db, business.id, user.id, 'site.created', row.id, { name: row.name, customer: contact.name });
    return { ...row, customer_name: contact.name };
  });
}

// body: { name, address?, contactPerson?, phone?, active? } — the customer never changes.
async function update(business, user, siteId, body) {
  requireSites(business);
  await access.require(business, 'hardware_sites.edit');
  const site = readSite(body);
  const active = v.requiredBoolean(body.active, 'Open', true);
  return repo.transaction(async (db) => {
    const current = await repo.one(db, 'SELECT * FROM hardware_sites WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(siteId, 'Site')]);
    if (!current) fail('Site not found', 404);
    const clash = await repo.one(db, 'SELECT id FROM hardware_sites WHERE business_id=$1 AND contact_id=$2 AND lower(name)=lower($3) AND id<>$4',
      [business.id, current.contact_id, site.name, current.id]);
    if (clash) fail(`This customer already has a site called ${site.name}`, 409);
    const row = await repo.one(db, `UPDATE hardware_sites SET name=$3,address=$4,contact_person=$5,phone=$6,active=$7,updated_by=$8,updated_at=now()
      WHERE business_id=$1 AND id=$2 RETURNING *`, [business.id, current.id, site.name, site.address, site.contactPerson, site.phone, active, user.id]);
    await repo.audit(db, business.id, user.id, active === current.active ? 'site.updated' : active ? 'site.reopened' : 'site.closed', row.id, { name: row.name });
    return row;
  });
}

// A site with its ledger: every bill that went there (+), goods that came
// back and payments on those bills (−), refunds (+), in date order with the
// running balance; and its quotations and sales orders. Money only for a
// role that sees sales.
async function ledger(business, siteId) {
  requireSites(business);
  await access.require(business, 'hardware_sites.view');
  const site = await repo.one(repo.pool, `SELECT s.*,c.name AS customer_name,c.phone AS customer_phone,c.gstin AS customer_gstin FROM hardware_sites s
    JOIN business_contacts c ON c.business_id=s.business_id AND c.id=s.contact_id WHERE s.business_id=$1 AND s.id=$2`, [business.id, id(siteId, 'Site')]);
  if (!site) fail('Site not found', 404);
  const money = access.can(business, 'sales.view');
  const [bills, entries, quotations, orders] = await Promise.all([
    money ? repo.all(repo.pool, `SELECT d.id,d.document_no,d.created_at,d.due_on,d.total,l.name AS location_name,${billBalanceSql('d')} AS balance
      FROM hardware_document_sites h JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id
      JOIN business_locations l ON l.business_id=d.business_id AND l.id=d.location_id
      WHERE h.business_id=$1 AND h.site_id=$2 ORDER BY d.created_at DESC,d.id DESC`, [business.id, site.id]) : [],
    money ? repo.all(repo.pool, `SELECT * FROM (
        SELECT d.created_at AS at,'bill' AS kind,d.document_no AS reference,d.document_no,d.id AS document_id,d.total AS amount FROM hardware_document_sites h
          JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id WHERE h.business_id=$1 AND h.site_id=$2
        UNION ALL SELECT r.created_at,'return',COALESCE(r.return_no,d.document_no),d.document_no,d.id,-r.total FROM hardware_document_sites h
          JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id
          JOIN business_returns r ON r.business_id=d.business_id AND r.document_id=d.id WHERE h.business_id=$1 AND h.site_id=$2
        UNION ALL SELECT p.created_at,'payment',COALESCE(k.collection_no,p.method_name,p.method),d.document_no,d.id,-p.amount FROM hardware_document_sites h
          JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id
          JOIN business_payments p ON p.business_id=d.business_id AND p.document_id=d.id
          LEFT JOIN business_collections k ON k.business_id=p.business_id AND k.id=p.collection_id WHERE h.business_id=$1 AND h.site_id=$2
        UNION ALL SELECT f.created_at,'refund',COALESCE(f.method_name,f.method),d.document_no,d.id,f.amount FROM hardware_document_sites h
          JOIN business_documents d ON d.business_id=h.business_id AND d.id=h.document_id
          JOIN business_refunds f ON f.business_id=d.business_id AND f.document_id=d.id WHERE h.business_id=$1 AND h.site_id=$2
      ) e ORDER BY at,kind<>'bill',document_id`, [business.id, site.id]) : [],
    business.modules.includes('quotations') && access.can(business, 'quotations.view')
      ? repo.all(repo.pool, `SELECT q.id,q.quotation_no,q.status,q.valid_until,q.total,q.created_at,
          (q.status='open' AND q.valid_until < (now() AT TIME ZONE b.timezone)::date) AS expired
          FROM hardware_quotation_sites h JOIN business_quotations q ON q.business_id=h.business_id AND q.id=h.quotation_id JOIN businesses b ON b.id=q.business_id
          WHERE h.business_id=$1 AND h.site_id=$2 ORDER BY q.id DESC`, [business.id, site.id]) : [],
    business.modules.includes('sales_orders') && access.can(business, 'sales_orders.view')
      ? repo.all(repo.pool, `SELECT o.id,o.order_no,o.status,o.total,o.created_at,o.expected_on FROM hardware_order_sites h
          JOIN wholesale_orders o ON o.business_id=h.business_id AND o.id=h.order_id WHERE h.business_id=$1 AND h.site_id=$2 ORDER BY o.id DESC`, [business.id, site.id]) : [],
  ]);
  let running = 0, billed = 0, returned = 0, paid = 0, refunded = 0;
  const statement = entries.map((e) => {
    const amount = paise(e.amount);
    running += amount;
    if (e.kind === 'bill') billed += amount; else if (e.kind === 'return') returned -= amount; else if (e.kind === 'payment') paid -= amount; else refunded += amount;
    return { ...e, amount: rupees(amount), balance: rupees(running) };
  });
  return { site, money, bills, statement, quotations, orders,
    totals: money ? { billed: rupees(billed), returned: rupees(returned), paid: rupees(paid - refunded), balance: rupees(running) } : null };
}

// A site a new bill, quotation or order may go to: this customer's, and open.
async function openSite(db, business, siteId, contactId) {
  requireSites(business);
  await access.require(business, 'hardware_sites.view');
  const site = await repo.one(db, 'SELECT * FROM hardware_sites WHERE business_id=$1 AND id=$2', [business.id, id(siteId, 'Site')]);
  if (!site) fail('Site not found', 404);
  if (!contactId) fail('Only a sale to a named customer goes to a site: choose the customer first');
  if (String(site.contact_id) !== String(contactId)) fail(`Site ${site.name} belongs to another customer: choose one of this customer's sites`, 409);
  if (!site.active) fail(`Site ${site.name} is closed. Open it again on the Sites screen to send goods there.`, 409);
  return site;
}

const siteColumns = 's.id,s.name,s.address,s.contact_person,s.phone,s.active';

// --- The site of a posted bill or an order ------------------------------------------------------

// body: { siteId } (null clears it). A bill to a named customer only.
async function setDocumentSite(business, user, documentId, body) {
  requireSites(business);
  await access.require(business, 'hardware_sites.edit');
  return repo.transaction(async (db) => {
    const doc = await repo.one(db, 'SELECT * FROM business_documents WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(documentId, 'Bill')]);
    if (!doc) fail('Bill not found', 404);
    access.requireLocation(business, doc.location_id);
    if (doc.kind !== 'sale') fail('Only a sale goes to a site');
    const current = await repo.one(db, `SELECT ${siteColumns} FROM hardware_document_sites h JOIN hardware_sites s ON s.business_id=h.business_id AND s.id=h.site_id
      WHERE h.business_id=$1 AND h.document_id=$2`, [business.id, doc.id]);
    if (!given(body.siteId)) {
      if (current) {
        await db.query('DELETE FROM hardware_document_sites WHERE business_id=$1 AND document_id=$2', [business.id, doc.id]);
        await repo.audit(db, business.id, user.id, 'document.site_cleared', doc.id, { documentNo: doc.document_no, site: current.name });
      }
      return { site: null };
    }
    const site = await openSite(db, business, body.siteId, doc.contact_id);
    if (current && String(current.id) === String(site.id)) return { site: current };
    await db.query(`INSERT INTO hardware_document_sites(business_id,document_id,site_id,set_by) VALUES($1,$2,$3,$4)
      ON CONFLICT (business_id,document_id) DO UPDATE SET site_id=EXCLUDED.site_id,set_by=EXCLUDED.set_by,set_at=now()`, [business.id, doc.id, site.id, user.id]);
    await repo.audit(db, business.id, user.id, 'document.site_set', doc.id, { documentNo: doc.document_no, site: site.name, ...(current ? { from: current.name } : {}) });
    return { site: { id: site.id, name: site.name, address: site.address, contact_person: site.contact_person, phone: site.phone, active: site.active } };
  });
}

// body: { siteId } (null clears it). An open order's invoices from now on go
// to that site; those already raised without a site go there too.
async function setOrderSite(business, user, orderId, body) {
  requireSites(business);
  await access.require(business, 'hardware_sites.edit');
  return repo.transaction(async (db) => {
    const order = await repo.one(db, 'SELECT * FROM wholesale_orders WHERE business_id=$1 AND id=$2 FOR UPDATE', [business.id, id(orderId, 'Sales order')]);
    if (!order) fail('Sales order not found', 404);
    access.requireLocation(business, order.location_id);
    if (['closed', 'cancelled'].includes(order.status)) fail(`Sales order ${order.order_no} is ${order.status}; its site no longer changes`, 409);
    const current = await repo.one(db, `SELECT ${siteColumns} FROM hardware_order_sites h JOIN hardware_sites s ON s.business_id=h.business_id AND s.id=h.site_id
      WHERE h.business_id=$1 AND h.order_id=$2`, [business.id, order.id]);
    if (!given(body.siteId)) {
      if (current) {
        await db.query('DELETE FROM hardware_order_sites WHERE business_id=$1 AND order_id=$2', [business.id, order.id]);
        await repo.audit(db, business.id, user.id, 'sales_order.site_cleared', order.id, { orderNo: order.order_no, site: current.name });
      }
      return { site: null };
    }
    const site = await openSite(db, business, body.siteId, order.contact_id);
    if (current && String(current.id) === String(site.id)) return { site: current };
    await db.query(`INSERT INTO hardware_order_sites(business_id,order_id,site_id,set_by) VALUES($1,$2,$3,$4)
      ON CONFLICT (business_id,order_id) DO UPDATE SET site_id=EXCLUDED.site_id,set_by=EXCLUDED.set_by,set_at=now()`, [business.id, order.id, site.id, user.id]);
    await db.query(`INSERT INTO hardware_document_sites(business_id,document_id,site_id,set_by)
      SELECT business_id,document_id,$3,$4 FROM wholesale_dispatches WHERE business_id=$1 AND order_id=$2 ON CONFLICT DO NOTHING`, [business.id, order.id, site.id, user.id]);
    await repo.audit(db, business.id, user.id, 'sales_order.site_set', order.id, { orderNo: order.order_no, site: site.name, ...(current ? { from: current.name } : {}) });
    return { site: { id: site.id, name: site.name, address: site.address, contact_person: site.contact_person, phone: site.phone, active: site.active } };
  });
}

async function orderSite(business, orderId) {
  requireSites(business);
  await access.require(business, 'hardware_sites.view');
  const site = await repo.one(repo.pool, `SELECT ${siteColumns} FROM hardware_order_sites h JOIN hardware_sites s ON s.business_id=h.business_id AND s.id=h.site_id
    WHERE h.business_id=$1 AND h.order_id=$2`, [business.id, id(orderId, 'Sales order')]);
  return { site: site || null };
}

// --- Quotations and the orders they become (inside the caller's transaction) ------------------

// siteId undefined: kept (a site of another customer, after the customer
// changed, is taken off); null or '': no site; an id: that site.
async function setQuotationSite(db, business, user, quotation, siteId) {
  const current = await repo.one(db, `SELECT h.site_id,s.contact_id FROM hardware_quotation_sites h JOIN hardware_sites s ON s.business_id=h.business_id AND s.id=h.site_id
    WHERE h.business_id=$1 AND h.quotation_id=$2`, [business.id, quotation.id]);
  const clear = () => db.query('DELETE FROM hardware_quotation_sites WHERE business_id=$1 AND quotation_id=$2', [business.id, quotation.id]);
  if (siteId === undefined) {
    if (current && String(current.contact_id) !== String(quotation.contact_id)) await clear();
    return;
  }
  if (!given(siteId)) {
    if (current) await clear();
    return;
  }
  const site = await openSite(db, business, siteId, quotation.contact_id);
  if (current && String(current.site_id) === String(site.id)) return;
  await db.query(`INSERT INTO hardware_quotation_sites(business_id,quotation_id,site_id,set_by) VALUES($1,$2,$3,$4)
    ON CONFLICT (business_id,quotation_id) DO UPDATE SET site_id=EXCLUDED.site_id,set_by=EXCLUDED.set_by,set_at=now()`, [business.id, quotation.id, site.id, user.id]);
}

async function siteOfQuotation(db, business, quotationId) {
  return (await repo.one(db, `SELECT ${siteColumns} FROM hardware_quotation_sites h JOIN hardware_sites s ON s.business_id=h.business_id AND s.id=h.site_id
    WHERE h.business_id=$1 AND h.quotation_id=$2`, [business.id, quotationId])) || null;
}

// The sales order a quotation became goes to the quotation's site.
async function orderFromQuotation(db, business, user, quotation, order) {
  const site = await siteOfQuotation(db, business, quotation.id);
  if (!site) return;
  await db.query('INSERT INTO hardware_order_sites(business_id,order_id,site_id,set_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [business.id, order.id, site.id, user.id]);
}

module.exports = { requireSites, openSite, create, update, ledger, setDocumentSite, setOrderSite, orderSite, setQuotationSite, siteOfQuotation, orderFromQuotation };
