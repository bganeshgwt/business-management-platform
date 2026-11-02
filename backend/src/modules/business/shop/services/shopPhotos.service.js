const multer = require('multer');
const repo = require('../../core/repositories/business.repository');
const access = require('../../core/services/businessAccess.service');
const AppError = require('../../../../utils/AppError');
const v = require('../../../../utils/validate');
const { saveProductImage, removeUpload } = require('../../../../middlewares/upload');

// A product's photo for the online shop: a picture of the product, not
// personal data, kept with the restaurant's dish photos in the public uploads
// (middlewares/upload.js checks each file's bytes are a JPG, PNG or WEBP and
// names it itself). The staff app sends two sizes it made from the one
// picked: `image` (up to 1080 px, the item's page) and `thumb` (up to 400 px,
// the shop's grid); a browser that could not make them sends the picture
// alone, used for both. The guests' page shows each in a box of a fixed shape,
// loaded only as it scrolls into view, so nothing on the page jumps.

const fail = (message, status = 400) => { throw new AppError(status, message); };
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, callback) => callback(TYPES.includes(file.mimetype) ? null : new AppError(400, 'Only JPG, PNG and WEBP images can be uploaded'), TYPES.includes(file.mimetype)),
}).fields([{ name: 'image', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]);

async function allowed(business) {
  if (!business.modules.includes('online_shop')) fail('Online shop is not switched on for this business. An owner can turn it on in Settings › Business tools.', 403);
  await access.requireAny(business, ['catalog.edit', 'online_shop.manage']);
}

async function save(business, user, productId, files = {}) {
  await allowed(business);
  const image = files.image && files.image[0];
  if (!image) fail('Choose a photo to upload');
  const thumb = files.thumb && files.thumb[0];
  const id = v.requiredId(productId, 'Item');
  const product = await repo.one(repo.pool, 'SELECT id,name,kind FROM catalog_products WHERE business_id=$1 AND id=$2', [business.id, id]);
  if (!product) fail('Item not found', 404);
  // Each file's bytes are checked as it is written; nothing is kept from a refused upload.
  const large = saveProductImage(`b${business.id}`, image.buffer);
  let small;
  try {
    small = thumb ? saveProductImage(`b${business.id}`, thumb.buffer) : large;
  } catch (error) {
    await removeUpload(large);
    throw error;
  }
  let old;
  try {
    old = await repo.transaction(async (db) => {
      const before = await repo.one(db, 'SELECT photo_path,thumb_path FROM shop_item_details WHERE business_id=$1 AND product_id=$2 FOR UPDATE', [business.id, product.id]);
      await db.query(`INSERT INTO shop_item_details(business_id,product_id,photo_path,thumb_path,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT (business_id,product_id) DO UPDATE SET photo_path=EXCLUDED.photo_path,thumb_path=EXCLUDED.thumb_path,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [business.id, product.id, large, small, user.id]);
      await repo.audit(db, business.id, user.id, 'online_shop.photo_added', product.id, { name: product.name });
      return before;
    });
  } catch (error) {
    await removeUpload(large);
    if (small !== large) await removeUpload(small);
    throw error;
  }
  // The photo it replaced is gone once the new one is saved.
  if (old?.photo_path) await removeUpload(old.photo_path);
  if (old?.thumb_path && old.thumb_path !== old.photo_path) await removeUpload(old.thumb_path);
  return { productId: Number(product.id), photo: { large, small } };
}

async function remove(business, user, productId) {
  await allowed(business);
  const id = v.requiredId(productId, 'Item');
  const old = await repo.transaction(async (db) => {
    const before = await repo.one(db, 'SELECT photo_path,thumb_path FROM shop_item_details WHERE business_id=$1 AND product_id=$2 FOR UPDATE', [business.id, id]);
    if (!before?.photo_path) fail('This item has no photo', 404);
    await db.query('UPDATE shop_item_details SET photo_path=NULL,thumb_path=NULL,updated_by=$3,updated_at=now() WHERE business_id=$1 AND product_id=$2', [business.id, id, user.id]);
    await repo.audit(db, business.id, user.id, 'online_shop.photo_removed', id, {});
    return before;
  });
  await removeUpload(old.photo_path);
  if (old.thumb_path !== old.photo_path) await removeUpload(old.thumb_path);
  return { productId: id, photo: null };
}

module.exports = { upload, save, remove };
