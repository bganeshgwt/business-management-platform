const express = require('express');
const authenticate = require('../../../../middlewares/authenticate');
const access = require('../../core/services/businessAccess.service');
const common = require('../services/healthCommon');

// Prescription scans (multipart), mounted in routes/index.js BEFORE the
// /businesses router, whose JSON-only check would refuse a file upload.
// The file is opened only through the API, to someone who may see the
// prescriptions, and every look is logged.
const router = express.Router();
const loaded = (permission) => async (req, res, next) => {
  try {
    req.business = await access.load(req.user, req.params.businessId);
    await access.require(req.business, permission);
    next();
  } catch (error) { next(error); }
};

router.post('/businesses/:businessId/pharmacy/prescription-files', authenticate, loaded('pharmacy.create'), common.uploadOne, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await common.addPrescriptionFile(req.business, req.user, req.file) });
  } catch (error) { next(error); }
});
router.get('/businesses/:businessId/pharmacy/prescription-files/:fileId', authenticate, loaded('pharmacy.view'), async (req, res, next) => {
  try {
    const { file, full } = await common.openFile(req.business, req.user, req.params.fileId);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${file.file_name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(full);
  } catch (error) { next(error); }
});

module.exports = router;
