const logbookService = require("../services/logbook.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const readDate = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (
    typeof value !== "string" ||
    !DATE_PATTERN.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new AppError(400, `${field} must be a date like 2026-09-19`);
  }

  return value;
};

const CATEGORY_WORDS = {
  maintenance: "Maintenance",
  guest: "Guest",
  stock: "Stock",
  staff: "Staff",
  other: "Other",
};

const list = async (req, res) => {
  const q = req.query;
  const from = readDate(q.from, "From");
  const to = readDate(q.to, "To");

  if (from && to && to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  res.json({
    success: true,
    data: await logbookService.list(req.user.restaurantId, req.user, {
      from,
      to,
      outletId: v.optionalNumber(q.outletId, "Outlet", { min: 1 }),
      category: q.category ? v.requiredEnum(q.category, "Category", logbookService.CATEGORIES) : null,
      search: v.optionalString(q.search, "Search", 100),
      openOnly: q.open === "1" || q.open === "true",
      limit: v.optionalNumber(q.limit, "Limit", { min: 1, max: 200 }) ?? 50,
      offset: v.optionalNumber(q.offset, "Offset", { min: 0, max: 1000000 }) ?? 0,
    }),
  });
};

const create = async (req, res) => {
  const body = req.body || {};
  const entry = await logbookService.create(
    req.user.restaurantId,
    req.user,
    {
      body: v.requiredString(body.body, "What happened", 1000),
      category: v.requiredEnum(body.category, "Kind", logbookService.CATEGORIES),
      tableId: v.optionalNumber(body.tableId, "Table", { min: 1 }),
      outletId: v.optionalNumber(body.outletId, "Outlet", { min: 1 }),
      needsFollowUp: body.needsFollowUp === true,
    },
    req.outletId || null
  );

  logAction(req, "create", "logbook_entry", {
    id: entry.id,
    label: `${CATEGORY_WORDS[entry.category]}${entry.needsFollowUp ? " · needs follow-up" : ""}`,
    details: { shift: entry.shiftLabel, table: entry.tableLabel || undefined, outlet: entry.outletName || undefined },
  });

  res.status(201).json({ success: true, message: "Added to the log book", data: entry });
};

const close = async (req, res) => {
  const id = v.requiredId(req.params.id, "Entry id");
  const entry = await logbookService.close(
    req.user.restaurantId,
    req.user,
    id,
    v.optionalString((req.body || {}).note, "What was done", 300)
  );

  logAction(req, "close", "logbook_entry", {
    id,
    label: `${CATEGORY_WORDS[entry.category]} follow-up closed`,
    details: { note: entry.closeNote || undefined, writtenBy: entry.createdByName },
  });

  res.json({ success: true, message: "Follow-up closed", data: entry });
};

const markRead = async (req, res) => {
  const ids = [...new Set(v.requiredArray((req.body || {}).ids, "Entries").map((id) => v.requiredId(id, "Entry")))];

  if (ids.length > 200) {
    throw new AppError(400, "Mark up to 200 entries at a time");
  }

  res.json({ success: true, data: await logbookService.markRead(req.user.restaurantId, req.user, ids) });
};

const handover = async (req, res) => {
  res.json({ success: true, data: await logbookService.handover(req.user.restaurantId, req.user) });
};

const getOne = async (req, res) => {
  const id = v.requiredId(req.params.id, "Entry id");
  res.json({ success: true, data: await logbookService.getEntry(req.user.restaurantId, req.user, id) });
};

module.exports = {
  list,
  create,
  close,
  markRead,
  handover,
  getOne,
};
