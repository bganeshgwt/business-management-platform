const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const repo = require("../repositories/tasks.repository");
const tasks = require("./tasks.service");
const issues = require("./issues.service");
const recurrence = require("./recurrence.service");
const { fail, id, optionalId, v } = require("./common");
const config = require("../../../config/env");
const AppError = require("../../../utils/AppError");

// Photos, signatures and files on tasks, checklist items and issues. Kept
// OUTSIDE the public uploads folder, in tasks/<business>/ of the private
// uploads folder (PRIVATE_UPLOADS_DIR; config/env.js), under a generated
// name, and only ever sent through the API to someone who may see the
// record. The bytes are checked: a renamed file is refused.

const ROOT = path.join(config.privateUploadsDir, "tasks");
const MAX_BYTES = 5 * 1024 * 1024;
const SIGNATURES = [
  { mime: "image/jpeg", ext: "jpg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/webp", ext: "webp", bytes: [0x52, 0x49, 0x46, 0x46], also: [0x57, 0x45, 0x42, 0x50] },
  { mime: "application/pdf", ext: "pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];
const sniff = (buffer) => SIGNATURES.find((s) => buffer.length >= 12 && s.bytes.every((b, i) => buffer[i] === b) && (!s.also || s.also.every((b, i) => buffer[8 + i] === b))) || null;

const uploadOne = (req, res, next) =>
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 10 } }).single("file")(req, res, (error) => {
    if (error && error.code === "LIMIT_FILE_SIZE") return next(new AppError(400, "That file is larger than 5 MB. Take the photo again at a lower size and try again."));
    if (error && error.code && String(error.code).startsWith("LIMIT_")) return next(new AppError(400, "Attach one file at a time."));
    return next(error);
  });

const dirOf = (businessId) => path.join(ROOT, String(Number(businessId)));

// Where the file goes and who may add it.
async function target(db, scope, body, owner) {
  if (owner.taskId) {
    const row = await tasks.load(db, scope, owner.taskId, { lock: true });
    const itemId = optionalId(body.itemId, "Checklist item");
    const can = tasks.rights(scope, row);
    if (itemId) {
      if (!can.work) fail(403, "This task is not open for you to fill in");
      const item = await repo.one(db, "SELECT * FROM business_task_items WHERE business_id = $1 AND task_id = $2 AND id = $3 FOR UPDATE", [scope.businessId, row.id, itemId]);
      if (!item) fail(404, "Checklist item not found");
      if (item.kind === "section") fail(400, "A section heading takes no photo");
      return { column: "task_id", ownerId: row.id, item, task: row };
    }
    return { column: "task_id", ownerId: row.id, item: null, task: row };
  }
  if (owner.issueId) {
    const row = await issues.load(db, scope, owner.issueId, { lock: true });
    return { column: "issue_id", ownerId: row.id, item: null };
  }
  fail(400, "Nothing to attach to");
}

async function add(scope, owner, req) {
  const file = req.file;
  if (!file) fail(400, "Choose a photo or file to attach");
  const kind = v.optionalEnum(req.body?.kind, "Kind", ["photo", "signature", "file"], "photo");
  const found = sniff(file.buffer);
  if (!found) fail(400, "Only a photo (JPG, PNG, WebP) or a PDF can be attached");
  if (kind !== "file" && found.mime === "application/pdf") fail(400, "A photo or signature must be an image");
  const storedName = `${crypto.randomBytes(16).toString("hex")}.${found.ext}`;
  const dir = dirOf(scope.businessId);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, storedName);
  fs.writeFileSync(full, file.buffer, { flag: "wx" });
  try {
    return await repo.transaction(async (db) => {
      const t = await target(db, scope, req.body || {}, owner);
      const count = await repo.one(db, `SELECT count(*)::int AS n FROM business_task_files WHERE business_id = $1 AND ${t.column} = $2 AND removed_at IS NULL`, [scope.businessId, t.ownerId]);
      if (count.n >= 60) fail(409, "This record already has 60 files");
      const fileName = String(file.originalname || `${kind}.${found.ext}`).replace(/[^\w.\- ]+/g, "_").slice(0, 150) || `${kind}.${found.ext}`;
      const row = await repo.one(db, `INSERT INTO business_task_files (business_id, ${t.column}, item_id, kind, stored_name, file_name, mime_type, size_bytes, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [scope.businessId, t.ownerId, t.item?.id || null, t.item?.kind === "signature" ? "signature" : kind, storedName, fileName, found.mime, file.size, scope.userId]);
      if (t.item && ["photo", "signature"].includes(t.item.kind)) {
        await db.query("UPDATE business_task_items SET answered = TRUE, answered_by = $3, answered_at = now() WHERE business_id = $1 AND id = $2", [scope.businessId, t.item.id, scope.userId]);
      }
      if (t.task && t.task.status === "todo" && t.item) {
        await db.query("UPDATE business_tasks SET status = 'in_progress', started_at = now(), started_by = $3 WHERE business_id = $1 AND id = $2", [scope.businessId, t.task.id, scope.userId]);
      }
      if (t.task) await recurrence.recount(db, scope.businessId, t.task.id);
      const target_ = owner.taskId ? { taskId: t.ownerId } : { issueId: t.ownerId };
      await repo.history(db, scope, target_, t.item?.kind === "signature" ? "signed" : "file_added", { file: fileName, item: t.item?.label || null });
      return { id: Number(row.id) };
    });
  } catch (error) {
    fs.rmSync(full, { force: true });
    throw error;
  }
}

// The file itself, to someone who may see its task or issue.
async function open(scope, fileId) {
  const file = await repo.one(repo.pool, "SELECT * FROM business_task_files WHERE business_id = $1 AND id = $2 AND removed_at IS NULL", [scope.businessId, id(fileId, "File")]);
  if (!file) fail(404, "File not found");
  if (file.task_id) await tasks.load(repo.pool, scope, file.task_id);
  else if (file.issue_id) await issues.load(repo.pool, scope, file.issue_id);
  else fail(404, "File not found");
  const full = path.join(dirOf(scope.businessId), file.stored_name);
  if (!fs.existsSync(full)) fail(404, "The file is missing from the server");
  return { file, full };
}

// Removing is recorded; the file itself is kept (evidence).
async function remove(scope, fileId) {
  return repo.transaction(async (db) => {
    const file = await repo.one(db, "SELECT * FROM business_task_files WHERE business_id = $1 AND id = $2 AND removed_at IS NULL FOR UPDATE", [scope.businessId, id(fileId, "File")]);
    if (!file) fail(404, "File not found");
    let task = null;
    if (file.task_id) {
      task = await tasks.load(db, scope, file.task_id, { lock: true });
      if (!["todo", "in_progress"].includes(task.status) && !scope.can("tasks.manage")) fail(409, "This task is finished; its photos stay with it");
    } else {
      await issues.load(db, scope, file.issue_id, { lock: true });
    }
    const manager = file.task_id ? scope.can("tasks.manage") : scope.can("issues.manage");
    if (Number(file.uploaded_by) !== scope.userId && !manager) fail(403, "Only the person who added it can remove it");
    await db.query("UPDATE business_task_files SET removed_at = now(), removed_by = $3 WHERE business_id = $1 AND id = $2", [scope.businessId, file.id, scope.userId]);
    if (file.item_id) {
      const left = await repo.one(db, "SELECT count(*)::int AS n FROM business_task_files WHERE business_id = $1 AND item_id = $2 AND removed_at IS NULL", [scope.businessId, file.item_id]);
      if (!left.n) {
        await db.query(`UPDATE business_task_items SET answered = FALSE, answered_by = NULL, answered_at = NULL
          WHERE business_id = $1 AND id = $2 AND kind IN ('photo', 'signature')`, [scope.businessId, file.item_id]);
      }
    }
    if (task) await recurrence.recount(db, scope.businessId, task.id);
    await repo.history(db, scope, file.task_id ? { taskId: file.task_id } : { issueId: file.issue_id }, "file_removed", { file: file.file_name });
    return { removed: Number(file.id) };
  });
}

module.exports = { uploadOne, add, open, remove };
