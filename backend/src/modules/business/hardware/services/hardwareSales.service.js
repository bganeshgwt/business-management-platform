const repo = require('../../core/repositories/business.repository');
const AppError = require('../../../../utils/AppError');
const sites = require('./hardwareSites.service');
const fitters = require('./hardwareFitters.service');

// A hardware shop's bill: the site it goes to and the fitter who brought the
// customer, inside the sale's own posting (business.service.js ›
// postDocument, which loads this only when a sale names a site or a fitter),
// and what the bill shows and prints of them.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const given = (value) => value !== undefined && value !== null && value !== '';

// saved: the sale just inserted; prepared: its lines (with ids, quantity in stock units, net in paise).
async function recordSale(db, business, user, saved, prepared, body) {
  if (business.business_type !== 'hardware') fail('Sites and fitters belong to hardware shops');
  if (given(body.siteId)) {
    const site = await sites.openSite(db, business, body.siteId, saved.contact_id);
    await db.query('INSERT INTO hardware_document_sites(business_id,document_id,site_id,set_by) VALUES($1,$2,$3,$4)', [business.id, saved.id, site.id, user.id]);
  }
  if (given(body.fitterId)) await fitters.recordBill(db, business, user, saved, prepared, body.fitterId);
}

// With a bill's detail and on its print: the site it went to; on the detail
// only, its fitter (and their commission for those who see it).
async function invoiceExtras(db, business, documentId) {
  const site = await repo.one(db, `SELECT s.id,s.name,s.address,s.contact_person,s.phone FROM hardware_document_sites h
    JOIN hardware_sites s ON s.business_id=h.business_id AND s.id=h.site_id WHERE h.business_id=$1 AND h.document_id=$2`, [business.id, documentId]);
  const fitter = await fitters.billExtras(db, business, documentId);
  return { site: site || null, fitter };
}

module.exports = { recordSale, invoiceExtras };
