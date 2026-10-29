const express = require('express');
const authenticate = require('../../../../middlewares/authenticate');
const access = require('../../core/services/businessAccess.service');
const files = require('../services/laundryFiles.service');

// A laundry's pictures (multipart): photos of garments at intake and at their
// quality check, and the customer's signature drawn at intake. Mounted in
// routes/index.js BEFORE the /businesses router, whose JSON-only check would
// refuse a file upload. A picture is opened only through the API, by someone
// who sees the order.
const router = express.Router();
const loaded = async (req, res, next) => {
  try {
    req.business = await access.open(req.user, req.params.businessId);
    access.scope(req, req.business);
    next();
  } catch (error) { next(error); }
};

router.post('/businesses/:businessId/laundry/files', authenticate, loaded, files.uploadOne, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await files.add(req.business, req.user, req.body, req.file) });
  } catch (error) { next(error); }
});
router.get('/businesses/:businessId/laundry/files/:fileId', authenticate, loaded, async (req, res, next) => {
  try {
    const { file, full } = await files.open(req.business, req.params.fileId);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${file.file_name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(full);
  } catch (error) { next(error); }
});

module.exports = router;
