const paymentTypeService = require("../services/paymentType.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");

const METHODS = ["cash", "card", "upi", "online", "wallet", "other"];

const readBody = (body = {}, { creating }) => ({
  // The method is chosen once, when the type is made (see the repository).
  paymentMethod: creating ? v.requiredEnum(body.paymentMethod, "Method", METHODS) : undefined,
  name: v.requiredString(body.name, "Name", 60),
  needsReference: v.requiredBoolean(body.needsReference, "Needs a reference", false),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
  sortOrder: v.optionalNumber(body.sortOrder, "Order", { min: 0, max: 999 }) ?? 0,
});

// Read by every till (the payment screen offers them): anyone who can see
// the orders and bills may list them.
const list = async (req, res) => {
  res.json({ success: true, data: await paymentTypeService.list(req.user.restaurantId) });
};

const create = async (req, res) => {
  const type = await paymentTypeService.create(req.user.restaurantId, readBody(req.body, { creating: true }), req.user.id);

  await logAction(req, "create", "payment_type", {
    id: type.id,
    label: `${type.methodLabel} · ${type.name}`,
    details: { needsReference: type.needsReference },
  });

  res.status(201).json({ success: true, message: `${type.name} added under ${type.methodLabel}`, data: type });
};

const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Payment type");
  const { before, after } = await paymentTypeService.update(
    req.user.restaurantId,
    id,
    readBody(req.body, { creating: false }),
    req.user.id
  );

  await logAction(req, "update", "payment_type", {
    id,
    label: `${after.methodLabel} · ${after.name}`,
    details: {
      before: { name: before.name, needsReference: before.needsReference, status: before.status },
      after: { name: after.name, needsReference: after.needsReference, status: after.status },
    },
  });

  res.json({
    success: true,
    message: after.status === "active" ? `${after.name} saved` : `${after.name} is switched off; its history stays`,
    data: after,
  });
};

const remove = async (req, res) => {
  const id = v.requiredId(req.params.id, "Payment type");
  const type = await paymentTypeService.remove(req.user.restaurantId, id);

  await logAction(req, "delete", "payment_type", { id, label: `${type.methodLabel} · ${type.name}` });

  res.json({ success: true, message: `${type.name} deleted` });
};

module.exports = { list, create, update, remove };
