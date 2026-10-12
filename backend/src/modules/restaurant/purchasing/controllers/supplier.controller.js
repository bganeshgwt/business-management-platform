const supplierService = require("../services/supplier.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");

// A GSTIN is 15 characters: 2-digit state code, 10-character PAN, entity
// number, Z, check character. The purchase register splits GST into CGST and
// SGST or IGST from the state code, so a malformed one is refused rather than
// quietly producing the wrong split.
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

const readGstin = (value) => {
  const text = v.optionalString(value, "GST number", 20);

  if (!text) {
    return null;
  }

  const gstin = text.toUpperCase().replace(/\s+/g, "");

  if (!GSTIN.test(gstin)) {
    throw new AppError(400, "GST number must be the 15-character GSTIN, like 37ABCDE1234F1Z5");
  }

  return gstin;
};

const readBody = (body = {}) => ({
  name: v.requiredString(body.name, "Supplier name", 150),
  code: body.code ? v.requiredString(body.code, "Code", 30).toUpperCase() : null,
  contactPerson: v.optionalString(body.contactPerson, "Contact person", 150),
  mobile: v.optionalString(body.mobile, "Mobile", 20),
  email: body.email ? v.requiredEmail(body.email, "Email") : null,
  address: v.optionalString(body.address, "Address", 500),
  gstNumber: readGstin(body.gstNumber),
  paymentTerms: v.optionalString(body.paymentTerms, "Payment terms", 100),
  // Days of credit from the bill date: drives due dates and ageing. Empty
  // means cash on delivery as far as due dates go.
  creditDays: v.optionalNumber(body.creditDays, "Credit days", { min: 0, max: 365 }),
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

const list = async (req, res) => {
  const full = Array.isArray(req.user.permissions) && req.user.permissions.includes("suppliers.view");
  const rows = await supplierService.list(req.user.restaurantId);

  res.json({
    success: true,
    data: full
      ? rows
      : rows.map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          gstNumber: row.gstNumber,
          creditDays: row.creditDays,
          status: row.status,
          lite: true,
        })),
  });
};

const create = async (req, res) => {
  const supplier = await supplierService.create(
    req.user.restaurantId,
    readBody(req.body),
    req.user.id
  );

  logAction(req, "create", "supplier", { id: supplier.id, label: supplier.name });

  res.status(201).json({ success: true, message: "Supplier created", data: supplier });
};

const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Supplier id");
  const supplier = await supplierService.update(
    req.user.restaurantId,
    id,
    readBody(req.body),
    req.user.id
  );

  logAction(req, "update", "supplier", { id: supplier.id, label: supplier.name });

  res.json({ success: true, message: "Supplier updated", data: supplier });
};

const remove = async (req, res) => {
  const id = v.requiredId(req.params.id, "Supplier id");

  await supplierService.remove(req.user.restaurantId, id);

  logAction(req, "delete", "supplier", { id });

  res.json({ success: true, message: "Supplier deleted" });
};

module.exports = { list, create, update, remove };
