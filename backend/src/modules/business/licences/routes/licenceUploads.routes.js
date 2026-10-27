const express = require('express');
const authenticate = require('../../../../middlewares/authenticate');
const access = require('../../core/services/businessAccess.service');
const files = require('../services/licenceFiles.service');

// A licence's scanned copies (multipart), mounted in routes/index.js BEFORE
// the /businesses router, whose JSON-only check would refuse a file upload.
// A copy is opened only through the API, by someone who may see licences.
const router = express.Router();
const opened = async (req, res, next) => {
  try {
    req.business = await access.open(req.user, req.params.businessId);
    access.scope(req, req.business);
    next();
  } catch (error) { next(error); }
};

router.post('/businesses/:businessId/licences/:licenceId/files', authenticate, opened, files.uploadOne, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await files.add(req.business, req.user, req.params.licenceId, req.file) });
  } catch (error) { next(error); }
});
router.get('/businesses/:businessId/licences/:licenceId/files/:fileId', authenticate, opened, async (req, res, next) => {
  try {
    const { file, full } = await files.open(req.business, req.params.licenceId, req.params.fileId);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${file.file_name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(full);
  } catch (error) { next(error); }
});

module.exports = router;
