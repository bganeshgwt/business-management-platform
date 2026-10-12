const v = require("../../../../utils/validate");
const { logAction } = require("../../../../utils/audit");
const attachmentService = require("../services/attachment.service");

// The files on an expense or a purchase bill (SW-B-09). One set of handlers
// per kind of record; `param` is the route's name for the record's id.
//
// Someone tied to one outlet reaches only that outlet's records (the service
// treats another outlet's as not found).
const forEntity = (entityType, param, label) => {
  const ids = (req) => ({
    entityId: v.requiredId(req.params[param], `${label} id`),
    outletId: req.outletPinned ? req.outletId : null,
  });

  const list = async (req, res) => {
    const { entityId, outletId } = ids(req);

    res.json({ success: true, data: await attachmentService.list(req.user.restaurantId, entityType, entityId, outletId) });
  };

  const add = async (req, res) => {
    const { entityId, outletId } = ids(req);
    const file = await attachmentService.add(req.user.restaurantId, entityType, entityId, req.file, req.user.id, outletId);

    logAction(req, "attach", entityType, {
      id: entityId,
      label: file.fileName,
      details: { attachmentId: file.id, sizeBytes: file.sizeBytes, mimeType: file.mimeType },
    });

    res.status(201).json({ success: true, message: "File attached", data: file });
  };

  // The file itself, for the signed-in person only: never cached by a shared
  // proxy, shown in the browser (a photo, a PDF) rather than downloaded.
  const download = async (req, res) => {
    const { entityId, outletId } = ids(req);
    const attachmentId = v.requiredId(req.params.attachmentId, "File id");
    const { row, absolutePath } = await attachmentService.open(
      req.user.restaurantId,
      entityType,
      entityId,
      attachmentId,
      outletId
    );

    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
    res.type(row.mime_type);
    res.sendFile(absolutePath);
  };

  // Removing a file is recorded; the file itself is kept (see the service).
  const remove = async (req, res) => {
    const { entityId, outletId } = ids(req);
    const attachmentId = v.requiredId(req.params.attachmentId, "File id");
    const file = await attachmentService.remove(req.user.restaurantId, entityType, entityId, attachmentId, req.user.id, outletId);

    logAction(req, "remove_attachment", entityType, {
      id: entityId,
      label: file.fileName,
      details: { attachmentId: file.id },
    });

    res.json({ success: true, message: "File removed", data: file });
  };

  return { list, add, download, remove };
};

module.exports = {
  expense: forEntity("expense", "id", "Expense"),
  purchaseBill: forEntity("purchase_bill", "receiptId", "Purchase bill"),
};
