const express = require('express');
const authenticate = require('../../../../middlewares/authenticate');
const access = require('../../core/services/businessAccess.service');
const files = require('../services/memberFiles.service');

// A gym's, studio's or coaching centre's signatures (multipart): the member's
// acceptance of the refund policy, drawn on the screen. Mounted in
// routes/index.js BEFORE the /businesses router, whose JSON-only check would
// refuse a file upload. A signature is opened only through the API, by
// someone who sees memberships.
const router = express.Router();
const loaded = async (req, res, next) => {
  try {
    req.business = await access.open(req.user, req.params.businessId);
    access.scope(req, req.business);
    next();
  } catch (error) { next(error); }
};

router.post('/businesses/:businessId/member-plans/acceptances', authenticate, loaded, files.uploadOne, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await files.add(req.business, req.user, req.body, req.file) });
  } catch (error) { next(error); }
});
router.get('/businesses/:businessId/member-plans/acceptances/:acceptanceId', authenticate, loaded, async (req, res, next) => {
  try {
    const { file, full } = await files.open(req.business, req.params.acceptanceId);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', 'inline; filename="signature"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(full);
  } catch (error) { next(error); }
});

module.exports = router;
