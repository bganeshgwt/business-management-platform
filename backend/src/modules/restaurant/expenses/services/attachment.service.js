const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const config = require("../../../../config/env");
const pool = require("../../../../config/database");
const AppError = require("../../../../utils/AppError");

// The paper bill behind an expense or a supplier's bill: a
// photo of the receipt or the PDF the supplier sent. Up to five files on one
// record, JPG, PNG or PDF, at most 5 MB each.
//
// The files are kept OUTSIDE the public uploads folder (which is served to
// anyone with the link), in attachments/ of the private uploads folder
// (PRIVATE_UPLOADS_DIR; config/env.js), and only ever sent through the API, to
// a signed-in person of the same restaurant with the right to see that
// record. Removing one is recorded (who and when) and the file itself is
// kept: a receipt that vanishes after someone asks about it is exactly what a
// theft check must be able to see. A voided purchase bill keeps its files.
const PRIVATE_ROOT = path.join(config.privateUploadsDir, "attachments");
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;

// What the browser may claim. The claim is only a first filter: the bytes are
// checked after the upload (a renamed .exe is not a PDF).
const ALLOWED = ["image/jpeg", "image/png", "application/pdf"];

const SIGNATURES = [
  { mime: "image/jpeg", ext: ".jpg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: ".png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "application/pdf", ext: ".pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

const sniff = (buffer) =>
  SIGNATURES.find((signature) => buffer.length >= signature.bytes.length && signature.bytes.every((byte, at) => buffer[at] === byte)) ||
  null;

const TOO_BIG = "That file is larger than 5 MB. Take the photo again at a lower size, or save the PDF smaller, and try again.";
const WRONG_TYPE = "Only a photo (JPG or PNG) or a PDF of the bill can be attached.";

// One file per request, held in memory so a file that turns out not to be a
// photo or a PDF never touches the disk.
const uploadOne = (req, res, next) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter: (request, file, callback) => {
      callback(ALLOWED.includes(file.mimetype) ? null : new AppError(400, WRONG_TYPE), ALLOWED.includes(file.mimetype));
    },
  }).single("file")(req, res, (error) => {
    if (error && error.code === "LIMIT_FILE_SIZE") {
      next(new AppError(400, TOO_BIG));
      return;
    }

    if (error && error.code && String(error.code).startsWith("LIMIT_")) {
      next(new AppError(400, "Attach one file at a time."));
      return;
    }

    next(error);
  });

// What each kind of record is, and how to find one in this restaurant. A
// record of another restaurant (or, for someone tied to one outlet, of
// another outlet) is simply not found.
const ENTITIES = {
  expense: {
    label: "expense",
    find: async (restaurantId, id) =>
      (await pool.query("SELECT id, outlet_id, expense_status AS status FROM expenses WHERE restaurant_id = $1 AND id = $2", [
        restaurantId,
        id,
      ])).rows[0] || null,
  },
  purchase_bill: {
    label: "purchase bill",
    find: async (restaurantId, id) =>
      (await pool.query("SELECT id, outlet_id, receipt_status AS status FROM goods_receipts WHERE restaurant_id = $1 AND id = $2", [
        restaurantId,
        id,
      ])).rows[0] || null,
  },
};

// `outletId` (someone tied to one outlet): only that outlet's records.
const requireEntity = async (restaurantId, entityType, entityId, outletId = null) => {
  const entity = ENTITIES[entityType];
  const row = await entity.find(restaurantId, entityId);

  if (!row || (outletId && row.outlet_id && Number(row.outlet_id) !== Number(outletId))) {
    throw new AppError(404, `That ${entity.label} was not found`);
  }

  return row;
};

const toAttachment = (row) => ({
  id: row.id,
  fileName: row.file_name,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  isImage: row.mime_type !== "application/pdf",
  createdAt: row.created_at,
  createdByName: row.created_by_name || null,
});

const list = async (restaurantId, entityType, entityId, outletId = null) => {
  await requireEntity(restaurantId, entityType, entityId, outletId);

  const result = await pool.query(
    `SELECT a.*, u.name AS created_by_name
     FROM document_attachments a
     LEFT JOIN users u ON u.id = a.created_by
     WHERE a.restaurant_id = $1 AND a.entity_type = $2 AND a.entity_id = $3 AND a.removed_at IS NULL
     ORDER BY a.created_at, a.id`,
    [restaurantId, entityType, entityId]
  );

  return result.rows.map(toAttachment);
};

// A file name as a person reads it: no folders, no control characters.
const cleanName = (name, ext) => {
  const base = path
    .basename(String(name || ""))
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .trim()
    .slice(0, 150);

  return base || `bill${ext}`;
};

const add = async (restaurantId, entityType, entityId, file, userId, outletId = null) => {
  await requireEntity(restaurantId, entityType, entityId, outletId);

  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new AppError(400, "Choose a photo or a PDF of the bill to attach.");
  }

  const kind = sniff(file.buffer);

  if (!kind) {
    throw new AppError(400, WRONG_TYPE);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // One at a time per record, so two uploads at once cannot make six.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [Number(restaurantId), Number(entityId)]);

    const count = (
      await client.query(
        `SELECT COUNT(*)::int AS n FROM document_attachments
         WHERE restaurant_id = $1 AND entity_type = $2 AND entity_id = $3 AND removed_at IS NULL`,
        [restaurantId, entityType, entityId]
      )
    ).rows[0].n;

    if (count >= MAX_FILES) {
      throw new AppError(400, `A ${ENTITIES[entityType].label} can carry ${MAX_FILES} files. Remove one before adding another.`);
    }

    const storedName = `${restaurantId}-${crypto.randomUUID()}${kind.ext}`;

    fs.mkdirSync(PRIVATE_ROOT, { recursive: true });
    fs.writeFileSync(path.join(PRIVATE_ROOT, storedName), file.buffer);

    const result = await client.query(
      `INSERT INTO document_attachments
         (restaurant_id, entity_type, entity_id, file_name, stored_name, mime_type, size_bytes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *, (SELECT name FROM users WHERE id = $8) AS created_by_name`,
      [restaurantId, entityType, entityId, cleanName(file.originalname, kind.ext), storedName, kind.mime, file.buffer.length, userId]
    );

    await client.query("COMMIT");
    return toAttachment(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const findLive = async (restaurantId, entityType, entityId, attachmentId) => {
  const result = await pool.query(
    `SELECT * FROM document_attachments
     WHERE restaurant_id = $1 AND entity_type = $2 AND entity_id = $3 AND id = $4 AND removed_at IS NULL`,
    [restaurantId, entityType, entityId, attachmentId]
  );

  if (!result.rows[0]) {
    throw new AppError(404, "That file was not found");
  }

  return result.rows[0];
};

// The file itself: { row, absolutePath }. Only ever through here.
const open = async (restaurantId, entityType, entityId, attachmentId, outletId = null) => {
  await requireEntity(restaurantId, entityType, entityId, outletId);

  const row = await findLive(restaurantId, entityType, entityId, attachmentId);
  const full = path.join(PRIVATE_ROOT, row.stored_name);

  if (!full.startsWith(PRIVATE_ROOT + path.sep) || !fs.existsSync(full)) {
    throw new AppError(404, "That file is no longer on the server");
  }

  return { row, absolutePath: full };
};

const remove = async (restaurantId, entityType, entityId, attachmentId, userId, outletId = null) => {
  await requireEntity(restaurantId, entityType, entityId, outletId);

  const row = await findLive(restaurantId, entityType, entityId, attachmentId);

  await pool.query("UPDATE document_attachments SET removed_at = NOW(), removed_by = $3 WHERE restaurant_id = $1 AND id = $2", [
    restaurantId,
    row.id,
    userId,
  ]);

  return toAttachment(row);
};

module.exports = { uploadOne, list, add, open, remove };
