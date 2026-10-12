const outletService = require("../services/outlet.service");
const restaurantService = require("../services/restaurant.service");
const { logAction } = require("../../../../utils/audit");
const { gstinProblem } = require("../../../../utils/gstin");
const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");

// The outlet's own GSTIN, for a branch registered on its own. Checked the
// same way as a guest's (format, state code, check character), but the
// sentence points at the outlet's registration, not a guest's certificate.
const readOutletGstin = (value) => {
  const gstin = value === undefined || value === null ? "" : String(value).replace(/[\s-]/g, "").toUpperCase();

  if (!gstin) {
    return null;
  }

  const problem = gstinProblem(gstin);

  if (problem) {
    throw new AppError(
      400,
      `The outlet's GSTIN ${problem.replace(
        "Check it against the guest's GST certificate",
        "Check it against the outlet's GST registration certificate"
      )}`
    );
  }

  return gstin;
};

// An FSSAI licence or registration: 14 digits (spaces and dashes typed with
// it are dropped). Empty: the outlet prints the restaurant's.
const readFssai = (value) => {
  if (value === undefined) {
    return undefined;
  }

  const digits = value === null ? "" : String(value).replace(/[\s-]/g, "");

  if (!digits) {
    return null;
  }

  if (!/^\d{14}$/.test(digits)) {
    throw new AppError(400, "An FSSAI licence number is 14 digits. Check it against the outlet's FSSAI licence.");
  }

  return digits;
};

// A UPI ID like kirancafe@okhdfcbank; empty: the restaurant's is used.
const readUpi = (value) => {
  if (value === undefined) {
    return undefined;
  }

  const vpa = v.optionalString(value, "UPI ID", 100);

  if (vpa && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}@[a-zA-Z][a-zA-Z0-9.-]{1,49}$/.test(vpa)) {
    throw new AppError(400, `The outlet's UPI ID "${vpa}" does not look right. It is written like name@bank, for example beachroad@okicici.`);
  }

  return vpa || null;
};

const readBody = (body = {}) => ({
  // Each premises holds its own FSSAI licence; its bills print it.
  fssaiNumber: readFssai(body.fssaiNumber),
  // A branch that banks on its own: the UPI ID its bills' QR codes pay.
  upiVpa: readUpi(body.upiVpa),
  upiPayeeName: body.upiPayeeName === undefined ? undefined : v.optionalString(body.upiPayeeName, "UPI payee name", 100),
  name: v.requiredString(body.name, "Outlet name", 150),
  code: v.requiredString(body.code, "Outlet code", 30).toUpperCase(),
  contact: v.optionalString(body.contact, "Contact", 20),
  address: v.optionalString(body.address, "Address", 500),
  // Only for a branch that is its own GST registration (usually one in
  // another state). Left empty, the outlet files under the restaurant's GSTIN.
  // Not sent at all (an older screen or script): the GSTIN on file is kept.
  gstNumber: body.gstNumber === undefined ? undefined : readOutletGstin(body.gstNumber),
  orderPrefix: v.optionalString(body.orderPrefix, "Order prefix", 10)?.toUpperCase() || null,
  invoicePrefix: v.optionalString(body.invoicePrefix, "Invoice prefix", 10)?.toUpperCase() || null,
  status: v.optionalEnum(body.status, "Status", ["active", "inactive"], "active"),
});

// ?series=1 (the Outlets page): each outlet also carries its invoice series,
// the real next bill number and the outlets it shares the series with.
const list = async (req, res) => {
  const outlets = await outletService.list(req.user.restaurantId);

  if (req.query.series !== "1" && req.query.series !== "true") {
    res.json({ success: true, data: outlets });
    return;
  }

  const series = await restaurantService.getInvoiceSeries(req.user.restaurantId);
  const byOutlet = new Map(series.filter((row) => row.outletId !== null).map((row) => [Number(row.outletId), row]));

  res.json({
    success: true,
    data: outlets.map((outlet) => {
      const row = byOutlet.get(Number(outlet.id));

      return {
        ...outlet,
        invoiceSeries: row
          ? { series: row.series, derived: row.derived, nextNumber: row.nextNumber, issued: row.issued, sharedWith: row.sharedWith }
          : null,
      };
    }),
  });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "Outlet id");
  const outlet = await outletService.getById(req.user.restaurantId, id);

  res.json({ success: true, data: outlet });
};

// What is recorded at an outlet: whether it can be deleted, or should be
// closed (set inactive) instead.
const usage = async (req, res) => {
  const id = v.requiredId(req.params.id, "Outlet id");

  res.json({ success: true, data: await outletService.usage(req.user.restaurantId, id) });
};

const create = async (req, res) => {
  const outlet = await outletService.create(req.user.restaurantId, readBody(req.body), req.user.id);

  logAction(req, "create", "outlet", { id: outlet.id, label: outlet.name });

  res.status(201).json({ success: true, message: "Outlet created", data: outlet });
};

const update = async (req, res) => {
  const id = v.requiredId(req.params.id, "Outlet id");
  const outlet = await outletService.update(
    req.user.restaurantId,
    id,
    readBody(req.body),
    req.user.id
  );

  logAction(req, "update", "outlet", {
    id: outlet.id,
    label: outlet.name,
    details: { status: outlet.status, gstNumber: outlet.gst_number, fssaiNumber: outlet.fssai_number, upiVpa: outlet.upi_vpa },
  });

  res.json({ success: true, message: "Outlet updated", data: outlet });
};

const remove = async (req, res) => {
  const id = v.requiredId(req.params.id, "Outlet id");
  const outlet = await outletService.remove(req.user.restaurantId, id);

  logAction(req, "delete", "outlet", { id, label: outlet.name });

  res.json({ success: true, message: `Outlet "${outlet.name}" deleted` });
};

module.exports = {
  list,
  getById,
  usage,
  create,
  update,
  remove,
};
