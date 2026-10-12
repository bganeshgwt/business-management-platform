const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { logAction } = require("../../../../utils/audit");
const captainSectionService = require("../services/captainSection.service");

const readDate = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AppError(400, `${field} must be a date like 2026-10-06`);
  }

  return value;
};

const readRows = (raw) => {
  const list = v.requiredArray(raw, "Assignments");

  if (list.length > 500) {
    throw new AppError(400, "At most 500 assignments in one plan");
  }

  return list.map((row) => {
    const item = row && typeof row === "object" ? row : {};
    const out = {
      userId: v.requiredId(item.userId, "Captain"),
      floorId: item.floorId ? v.requiredId(item.floorId, "Floor") : null,
      areaId: item.areaId ? v.requiredId(item.areaId, "Section") : null,
      tableId: item.tableId ? v.requiredId(item.tableId, "Table") : null,
    };

    if ([out.floorId, out.areaId, out.tableId].filter(Boolean).length !== 1) {
      throw new AppError(400, "Give each captain a floor, a section or a table (one per line)");
    }

    return out;
  });
};

const plan = async (req, res) => {
  res.json({
    success: true,
    data: await captainSectionService.plan(req.user.restaurantId, readDate(req.query.date, "Date"), req.outletId || null),
  });
};

const save = async (req, res) => {
  const body = req.body || {};
  const date = readDate(body.date, "Date") || (await captainSectionService.currentDate(req.user.restaurantId, req.outletId || null));
  const rows = readRows(body.assignments);
  const result = await captainSectionService.save(req.user.restaurantId, date, rows, req.user.id);

  logAction(req, "plan_sections", "captain_sections", {
    label: date,
    details: {
      date,
      assignments: result.assignments.map((row) => `${row.userName}: ${row.label}`),
    },
  });

  res.json({ success: true, message: `Captain plan for ${date} saved`, data: result });
};

const copy = async (req, res) => {
  const body = req.body || {};
  const to = readDate(body.to, "Copy to") || (await captainSectionService.currentDate(req.user.restaurantId, req.outletId || null));
  const from = readDate(body.from, "Copy from");

  if (!from) {
    throw new AppError(400, "Say which day to copy the plan from");
  }

  const result = await captainSectionService.copy(req.user.restaurantId, from, to, req.user.id);

  logAction(req, "copy_sections", "captain_sections", { label: to, details: { from, to, assignments: result.assignments.length } });

  res.json({ success: true, message: `${from}'s captain plan copied to ${to}`, data: result });
};

module.exports = { plan, save, copy };
