const tipService = require("../services/tip.service");
const { logAction, diff } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const readDate = (value, field, fallback = null) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
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

const readRange = async (req, source) => {
  const today = await tipService.today(req.user.restaurantId);
  const to = readDate(source.to, "To", today);
  const from = readDate(source.from, "From", `${to.slice(0, 8)}01`);

  if (to < from) {
    throw new AppError(400, "The end date cannot be before the start date");
  }

  return { from, to };
};

const readIds = (value, field) =>
  value === undefined || value === null ? [] : v.requiredArray(value, field).map((id) => v.requiredId(id, field));

// Collected, shared and each person's tips for the period, in one answer for
// the Tips screen.
const overview = async (req, res) => {
  const { from, to } = await readRange(req, req.query);
  const [collected, people, shareouts] = await Promise.all([
    tipService.collected(req.user.restaurantId, from, to),
    tipService.byPerson(req.user.restaurantId, from, to),
    tipService.listShareouts(req.user.restaurantId, from, to),
  ]);

  res.json({ success: true, data: { from, to, ...collected, people, shareouts } });
};

const readShareoutInput = async (req) => {
  const body = req.body || {};
  const { from, to } = await readRange(req, body);

  return {
    from,
    to,
    payDate: readDate(body.payDate, "Pay date", to),
    basis: body.basis ? v.requiredEnum(body.basis, "Share by", ["hours", "points"]) : null,
    excludeEmployeeIds: readIds(body.excludeEmployeeIds, "Left out"),
    expectedTotal: v.optionalNumber(body.expectedTotal, "Total you saw", { min: 0, max: 99999999 }),
    note: v.optionalString(body.note, "Note", 200),
  };
};

// Every share before anything is saved.
const preview = async (req, res) => {
  res.json({ success: true, data: await tipService.preview(req.user.restaurantId, await readShareoutInput(req)) });
};

const confirm = async (req, res) => {
  const input = await readShareoutInput(req);
  const { shareout } = await tipService.confirm(req.user.restaurantId, input, req.user.id);

  logAction(req, "share_out", "tips", {
    id: shareout.id,
    label: `Tips ${shareout.from} to ${shareout.to}`,
    details: {
      tips: shareout.tipsTotal,
      serviceCharge: shareout.serviceChargeTotal,
      direct: shareout.directTotal,
      pool: shareout.poolTotal,
      basis: shareout.basis,
      payDate: shareout.payDate,
      people: shareout.shares.length,
    },
  });

  res.status(201).json({
    success: true,
    message: `Tips shared between ${shareout.shares.length} ${shareout.shares.length === 1 ? "person" : "people"}. They show on Payroll as a Tips line.`,
    data: shareout,
  });
};

const undo = async (req, res) => {
  const id = v.requiredId(req.params.id, "Share-out id");
  const removed = await tipService.undo(req.user.restaurantId, id);

  logAction(req, "undo", "tips", {
    id,
    label: `Tips ${removed.from} to ${removed.to}`,
    details: {
      total: removed.total,
      shares: removed.shares.map((share) => ({ name: share.name, kind: share.kind, amount: share.amount })),
    },
  });

  res.json({ success: true, message: "Share-out undone. Its tips can be shared again.", data: removed });
};

const getSettings = async (req, res) => {
  res.json({ success: true, data: await tipService.getSettings(req.user.restaurantId) });
};

// {"Captain": 3, "Steward": 2}: up to 40 designations, points 0 to 100.
const readPoints = (value) => {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "Points per designation must be a list of designations and points");
  }

  const entries = Object.entries(value);

  if (entries.length > 40) {
    throw new AppError(400, "Give points for up to 40 designations");
  }

  const clean = {};

  for (const [name, points] of entries) {
    const label = String(name).trim();

    if (!label || label.length > 100) {
      throw new AppError(400, "Each designation needs a name of up to 100 letters");
    }

    clean[label] = v.requiredNumber(points, `Points for ${label}`, { min: 0, max: 100 });
  }

  return clean;
};

const saveSettings = async (req, res) => {
  const body = req.body || {};
  const { before, after } = await tipService.saveSettings(
    req.user.restaurantId,
    {
      routing: v.requiredEnum(body.routing, "Who gets a tip", ["pool", "captain"]),
      includeServiceCharge: v.requiredBoolean(body.includeServiceCharge, "Share the service charge", false),
      shareBasis: v.requiredEnum(body.shareBasis, "Share the pool by", ["hours", "points"]),
      designationPoints: readPoints(body.designationPoints),
      defaultPoints: v.optionalNumber(body.defaultPoints, "Points for anyone else", { min: 0, max: 100 }) ?? 1,
    },
    req.user.id
  );

  logAction(req, "update", "tip_settings", {
    label: "How tips are shared",
    details: {
      changes: diff(before, after, ["routing", "includeServiceCharge", "shareBasis", "defaultPoints"]),
      ...(JSON.stringify(before.designationPoints) !== JSON.stringify(after.designationPoints)
        ? { designationPoints: [before.designationPoints, after.designationPoints] }
        : {}),
    },
  });

  res.json({ success: true, message: "Saved", data: after });
};

module.exports = {
  overview,
  preview,
  confirm,
  undo,
  getSettings,
  saveSettings,
};
