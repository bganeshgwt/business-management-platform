const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const config = require("../config/env");
const AppError = require("../utils/AppError");

// Public uploads live under one folder outside src/ (UPLOADS_DIR, by default
// backend/uploads; config/env.js), so they are never mixed up with code and
// are easy to back up or keep on a mounted volume. app.js serves it at /uploads.
const UPLOAD_ROOT = config.uploadsDir;
const PRODUCT_DIR = path.join(UPLOAD_ROOT, "products");

const MAX_BYTES = 2 * 1024 * 1024;

// What the browser claims, mapped to the extension we give the file. The claim
// is only a first filter — the bytes are checked after the upload.
const ALLOWED = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

// The first bytes of each format. A file is only kept if it really is one of
// these, whatever its name or declared type said.
const SIGNATURES = [
  { ext: ".jpg", bytes: [0xff, 0xd8, 0xff] },
  { ext: ".png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WEBP is "RIFF" then four size bytes then "WEBP".
  { ext: ".webp", bytes: [0x52, 0x49, 0x46, 0x46], at: 0, also: { bytes: [0x57, 0x45, 0x42, 0x50], at: 8 } },
];

const ensureDir = () => {
  fs.mkdirSync(PRODUCT_DIR, { recursive: true });
};

const matches = (buffer, signature) => {
  const at = signature.at || 0;

  if (buffer.length < at + signature.bytes.length) {
    return false;
  }

  return signature.bytes.every((byte, index) => buffer[at + index] === byte);
};

// Reads the real format out of the bytes, or null if it is not an image we take.
const sniff = (buffer) => {
  for (const signature of SIGNATURES) {
    if (matches(buffer, signature) && (!signature.also || matches(buffer, signature.also))) {
      return signature.ext;
    }
  }

  return null;
};

// The file is held in memory rather than written straight to disk, so a file
// that turns out not to be an image never lands in the uploads folder at all.
const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!ALLOWED[file.mimetype]) {
      callback(new AppError(400, "Only JPG, PNG and WEBP images can be uploaded"));
      return;
    }

    callback(null, true);
  },
}).single("image");

// Writes the checked bytes under a name we generate. The uploader's own
// filename is never used: it could carry a path, a double extension, or
// characters the filesystem treats specially.
const saveProductImage = (restaurantId, buffer) => {
  const extension = sniff(buffer);

  if (!extension) {
    throw new AppError(400, "That file is not a JPG, PNG or WEBP image");
  }

  ensureDir();

  const name = `${restaurantId}-${crypto.randomUUID()}${extension}`;
  fs.writeFileSync(path.join(PRODUCT_DIR, name), buffer);

  return `products/${name}`;
};

// Deleting the old photo when a new one replaces it, so the folder does not
// grow forever. Awaited rather than fired and forgotten, so the file is really
// gone before the reply goes out; a missing file is not an error, because the
// row is what matters.
const removeUpload = async (relativePath) => {
  if (!relativePath) {
    return;
  }

  const full = path.join(UPLOAD_ROOT, relativePath);

  // Refuses anything that resolves outside the uploads folder, however the
  // stored path got there.
  if (!full.startsWith(UPLOAD_ROOT + path.sep)) {
    return;
  }

  try {
    await fs.promises.rm(full, { force: true });
  } catch {
    // A file we cannot delete is untidy, not a failure worth showing the user.
  }
};

module.exports = { productImageUpload, saveProductImage, removeUpload };
