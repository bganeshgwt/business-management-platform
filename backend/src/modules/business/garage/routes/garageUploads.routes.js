const express = require('express');
const authenticate = require('../../../../middlewares/authenticate');
const access = require('../../core/services/businessAccess.service');
const files = require('../services/garageFiles.service');

// A garage's job card photos (multipart): of an inspection item, or of the
// work. Mounted in routes/index.js BEFORE the /businesses router, whose
// JSON-only check would refuse a file upload. A photo is opened only through
// the API, by someone who sees its job card.
const router = express.Router();
const loaded = async (req, res, next) => {
  try {
    req.business = await access.open(req.user, req.params.businessId);
    access.scope(req, req.business);
    next();
  } catch (error) { next(error); }
};

router.post('/businesses/:businessId/garage/photos', authenticate, loaded, files.uploadOne, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await files.addPhoto(req.business, req.user, req.body, req.file) });
  } catch (error) { next(error); }
});
router.get('/businesses/:businessId/garage/photos/:photoId', authenticate, loaded, async (req, res, next) => {
  try {
    const { photo, full } = await files.open(req.business, req.params.photoId);
    res.setHeader('Content-Type', photo.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${photo.file_name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(full);
  } catch (error) { next(error); }
});

module.exports = router;
