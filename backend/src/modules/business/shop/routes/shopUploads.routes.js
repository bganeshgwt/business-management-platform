const express = require('express');
const authenticate = require('../../../../middlewares/authenticate');
const access = require('../../core/services/businessAccess.service');
const photos = require('../services/shopPhotos.service');

// A product's photo for the online shop (multipart: `image`, and `thumb` when
// the browser made the small one). Mounted in routes/index.js BEFORE the
// /businesses router, whose JSON-only check would refuse a file upload.
const router = express.Router();
const loaded = async (req, res, next) => {
  try {
    req.business = await access.open(req.user, req.params.businessId);
    access.scope(req, req.business);
    next();
  } catch (error) { next(error); }
};

router.post('/businesses/:businessId/online-shop/items/:productId/photo', authenticate, loaded, photos.upload, async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await photos.save(req.business, req.user, req.params.productId, req.files) });
  } catch (error) { next(error); }
});

module.exports = router;
