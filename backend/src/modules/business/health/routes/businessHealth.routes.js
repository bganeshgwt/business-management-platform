const repo = require('../../core/repositories/business.repository');
const v = require('../../../../utils/validate');
const AppError = require('../../../../utils/AppError');
const core = require('../../core/services/business.service');
const common = require('../services/healthCommon');
const pharmacy = require('../services/businessPharmacy.service');
const clinic = require('../services/businessClinic.service');
const lab = require('../services/businessLab.service');

// Round 2 (R2-HEALTH) — pharmacy, clinic and lab, added to the Business Admin
// router so they share its login, membership, module and permission checks
// (context) and its database-error translation:
//   /:businessId/health/…     settings and the people who sign (pharmacist, doctor, pathologist)
//   /:businessId/pharmacy/…   drug master, prescription sales, registers, recalls, expiry returns
//   /:businessId/clinic/…     patients, consent, consultations, today's patients
//   /:businessId/lab/…        tests and panels, orders, samples, results, approval, reports
// Services repeat every permission check. The prescription scan upload
// (multipart) is mounted before the JSON-only business router: healthUploads.routes.js.

module.exports = function healthRoutes(router, { context, send, b }) {
  const list = (path, name, permission, check, fixed = {}) => router.get(b(path), context(permission), async (req, res) => {
    if (check) check(req.business);
    const limit = req.query.limit === undefined ? 25 : v.requiredId(req.query.limit, 'Page size');
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) throw new AppError(400, 'Invalid pagination');
    const filters = { ...fixed };
    for (const key of repo.listFilters(name)) if (req.query[key] !== undefined && req.query[key] !== '' && !(key in fixed)) filters[key] = String(req.query[key]).slice(0, 60);
    const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : null;
    const date = (value, label) => (value === undefined || value === '' ? null : core.dateText(value, label));
    const from = date(req.query.from, 'From date'), to = date(req.query.to, 'To date');
    if (from && to && to < from) throw new AppError(400, 'The end date is before the start date');
    send(res, await repo.page(req.business.id, name, limit, offset, { search, from, to, timezone: req.business.timezone, filters }));
  });
  const isPharmacy = (business) => pharmacy.requirePharmacy(business);
  const isClinic = (business) => clinic.requireClinic(business);
  const isLab = (business) => lab.requireLab(business);

  // Settings and signatories (pharmacy and clinic alike).
  router.get(b('/health/settings'), context(['pharmacy.view', 'patients.view', 'lab.view', 'settings.view']), async (req, res) => send(res, await common.getSettings(req.business)));
  router.put(b('/health/settings'), context(['pharmacy.edit', 'settings.edit']), async (req, res) => send(res, await common.saveSettings(req.business, req.user, req.body)));
  router.put(b('/health/location-licences/:locationId'), context(['pharmacy.edit', 'settings.edit']), async (req, res) =>
    send(res, await common.saveLocationLicences(req.business, req.user, req.params.locationId, req.body)));
  router.get(b('/health/signatories'), context(['pharmacy.view', 'patients.view', 'lab.view', 'settings.view']), async (req, res) =>
    send(res, await common.signatories(req.business, req.query.kind ? v.requiredEnum(req.query.kind, 'Kind', ['pharmacist', 'doctor', 'pathologist']) : null)));
  router.post(b('/health/signatories'), context(['pharmacy.edit', 'settings.edit']), async (req, res) => send(res, await common.saveSignatory(req.business, req.user, req.body), 201));

  // Pharmacy.
  list('/pharmacy/drugs', 'pharmacy-drugs', ['pharmacy.view', 'sales.create'], isPharmacy);
  router.get(b('/pharmacy/drugs/:skuId'), context(['pharmacy.view', 'sales.create']), async (req, res) => send(res, await pharmacy.drug(req.business, req.params.skuId)));
  router.put(b('/pharmacy/drugs/:skuId'), context('pharmacy.edit'), async (req, res) => send(res, await pharmacy.saveDrug(req.business, req.user, req.params.skuId, req.body)));
  router.get(b('/pharmacy/drugs/:skuId/substitutes'), context(['pharmacy.view', 'sales.create']), async (req, res) => send(res, await pharmacy.substitutes(req.business, req.params.skuId)));
  router.post(b('/pharmacy/sales'), context('sales.create'), async (req, res) => send(res, await pharmacy.sell(req.business, req.user, req.body), 201));
  list('/pharmacy/prescriptions', 'pharmacy-prescriptions', 'pharmacy.view', isPharmacy);
  router.get(b('/pharmacy/prescriptions/:id'), context('pharmacy.view'), async (req, res) => send(res, await pharmacy.prescription(req.business, req.user, req.params.id)));
  list('/pharmacy/registers/h1', 'pharmacy-register', 'pharmacy.view', isPharmacy, { register: 'H1' });
  list('/pharmacy/registers/x', 'pharmacy-register', 'pharmacy.view', isPharmacy, { register: ['X', 'narcotic'] });
  router.get(b('/pharmacy/summary'), context('pharmacy.view'), async (req, res) => send(res, await pharmacy.registerSummary(req.business, req.query)));
  list('/pharmacy/recalls', 'pharmacy-recalls', 'pharmacy.view', isPharmacy);
  router.post(b('/pharmacy/recalls'), context('pharmacy.approve'), async (req, res) => send(res, await pharmacy.createRecall(req.business, req.user, req.body), 201));
  router.get(b('/pharmacy/recalls/:id'), context('pharmacy.view'), async (req, res) => send(res, await pharmacy.recall(req.business, req.params.id)));
  router.post(b('/pharmacy/recalls/:id'), context('pharmacy.approve'), async (req, res) => send(res, await pharmacy.updateRecall(req.business, req.user, req.params.id, req.body)));
  router.get(b('/pharmacy/near-expiry'), context('inventory.view'), async (req, res) => send(res, await pharmacy.nearExpiry(req.business, req.query)));
  list('/pharmacy/debit-notes', 'pharmacy-debit-notes', 'pharmacy.view', isPharmacy);
  router.post(b('/pharmacy/debit-notes'), context('pharmacy.approve'), async (req, res) => send(res, await pharmacy.createDebitNote(req.business, req.user, req.body), 201));
  router.get(b('/pharmacy/debit-notes/:id'), context('pharmacy.view'), async (req, res) => send(res, await pharmacy.debitNote(req.business, req.params.id)));
  router.post(b('/pharmacy/debit-notes/:id/credit'), context('pharmacy.approve'), async (req, res) => send(res, await pharmacy.creditDebitNote(req.business, req.user, req.params.id, req.body)));

  // Clinic.
  list('/clinic/patients', 'patients', 'patients.view', isClinic);
  router.post(b('/clinic/patients'), context('patients.create'), async (req, res) => send(res, await clinic.register(req.business, req.user, req.body), 201));
  router.get(b('/clinic/patients/:contactId'), context('patients.view'), async (req, res) => send(res, await clinic.patient(req.business, req.params.contactId)));
  router.patch(b('/clinic/patients/:contactId'), context('patients.edit'), async (req, res) => send(res, await clinic.updatePatient(req.business, req.user, req.params.contactId, req.body)));
  router.put(b('/clinic/patients/:contactId/clinical'), context('patients.edit_clinical'), async (req, res) => send(res, await clinic.saveClinical(req.business, req.user, req.params.contactId, req.body)));
  router.post(b('/clinic/patients/:contactId/consents'), context('patients.create'), async (req, res) => send(res, await clinic.addConsent(req.business, req.user, req.params.contactId, req.body), 201));
  router.post(b('/clinic/consents/:id/withdraw'), context('patients.edit'), async (req, res) => send(res, await clinic.withdrawConsent(req.business, req.user, req.params.id, req.body)));
  router.get(b('/clinic/today'), context('patients.view'), async (req, res) => send(res, await clinic.today(req.business, req.query)));
  list('/clinic/visits', 'health-visits', 'patients.view', isClinic);
  list('/clinic/follow-ups', 'health-follow-ups', 'patients.view', isClinic);
  router.post(b('/clinic/visits'), context(['patients.edit_clinical', 'patients.create']), async (req, res) => send(res, await clinic.openVisit(req.business, req.user, req.body), 201));
  router.get(b('/clinic/visits/:id'), context('patients.view'), async (req, res) => send(res, await clinic.visit(req.business, req.params.id)));
  router.patch(b('/clinic/visits/:id'), context('patients.edit_clinical'), async (req, res) => send(res, await clinic.saveVisit(req.business, req.user, req.params.id, req.body)));
  router.post(b('/clinic/visits/:id/notes'), context('patients.edit_clinical'), async (req, res) => send(res, await clinic.addVisitNote(req.business, req.user, req.params.id, req.body), 201));
  router.post(b('/clinic/visits/:id/bill'), context('sales.create'), async (req, res) => send(res, await clinic.billVisit(req.business, req.user, req.params.id, req.body), 201));

  // Lab.
  list('/lab/tests', 'lab-tests', 'lab.view', isLab);
  router.get(b('/lab/tests/:id'), context('lab.view'), async (req, res) => send(res, await lab.test(req.business, req.params.id)));
  router.post(b('/lab/tests'), context('lab.edit'), async (req, res) => send(res, await lab.saveTest(req.business, req.user, null, req.body), 201));
  router.put(b('/lab/tests/:id'), context('lab.edit'), async (req, res) => send(res, await lab.saveTest(req.business, req.user, req.params.id, req.body)));
  list('/lab/orders', 'lab-orders', 'lab.view', isLab);
  router.get(b('/lab/worklist'), context('lab.view'), async (req, res) => send(res, await lab.worklist(req.business)));
  router.post(b('/lab/orders'), context('lab.create'), async (req, res) => send(res, await lab.createOrder(req.business, req.user, req.body), 201));
  router.get(b('/lab/orders/:id'), context('lab.view'), async (req, res) => send(res, await lab.order(req.business, req.params.id)));
  router.get(b('/lab/orders/:id/report'), context('lab.print'), async (req, res) => send(res, await lab.report(req.business, req.params.id)));
  router.put(b('/lab/orders/:id/results'), context('lab.edit'), async (req, res) => send(res, await lab.enterResults(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lab/orders/:id/approve'), context('lab.approve'), async (req, res) => send(res, await lab.approve(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lab/orders/:id/cancel'), context('lab.create'), async (req, res) => send(res, await lab.cancelOrder(req.business, req.user, req.params.id, req.body)));
  router.post(b('/lab/orders/:id/refer'), context('lab.create'), async (req, res) => send(res, await lab.refer(req.business, req.user, req.params.id, req.body)));
  router.get(b('/lab/samples/barcode/:code'), context('lab.view'), async (req, res) => send(res, await lab.sampleByBarcode(req.business, req.params.code)));
  router.post(b('/lab/samples/:id'), context('lab.create'), async (req, res) => send(res, await lab.sampleAction(req.business, req.user, req.params.id, req.body)));
};
