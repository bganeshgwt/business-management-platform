const restaurantService = require("../services/restaurant.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const restaurantFeatures = require("../services/restaurantFeatures.service");

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

// An invoice prefix GST accepts: up to 10 capitals, digits, - and /.
const INVOICE_PREFIX = /^[A-Z0-9][A-Z0-9/-]{0,9}$/;

// A UPI ID (VPA) as banks issue them: a handle, "@", and the bank's or app's
// part — kirancafe@okhdfcbank, 9876543210@ybl.
const UPI_VPA = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}@[a-zA-Z][a-zA-Z0-9.-]{1,49}$/;

// A UPI ID, checked; empty means none.
const readUpiVpa = (value, whose) => {
  const vpa = v.optionalString(value, "UPI ID", 100);

  if (vpa && !UPI_VPA.test(vpa)) {
    throw new AppError(400, `${whose} UPI ID "${vpa}" does not look right. It is written like name@bank, for example kirancafe@okhdfcbank.`);
  }

  return vpa || null;
};

// The order types a bill can be for; service charge is charged on the ones
// ticked in settings (dine-in only, unless the owner says otherwise).
const ORDER_TYPES = ["dine_in", "takeaway", "delivery", "qr", "online"];

// The restaurant id always comes from the token (req.user), never from the URL,
// so one restaurant can never read or change another's data.
const getCurrent = async (req, res) => {
  const restaurant = await restaurantService.getCurrentRestaurant(req.user.restaurantId);

  res.json({ success: true, data: restaurant });
};

const updateCurrent = async (req, res) => {
  const body = req.body || {};

  const data = {
    name: v.requiredString(body.name, "Restaurant name", 150),
    contact: v.optionalString(body.contact, "Contact", 20),
    email: body.email ? v.requiredEmail(body.email, "Email") : null,
    address: v.optionalString(body.address, "Address", 500),
  };

  const restaurant = await restaurantService.updateCurrentRestaurant(
    req.user.restaurantId,
    data,
    req.user.id
  );

  res.json({ success: true, message: "Restaurant updated", data: restaurant });
};

const getSettings = async (req, res) => {
  const settings = await restaurantService.getSettings(req.user.restaurantId);

  res.json({
    success: true,
    data: {
      currencyCode: settings.currency_code,
      currencySymbol: settings.currency_symbol,
      timezone: settings.timezone,
      taxMode: settings.tax_mode,
      defaultTaxPercentage: Number(settings.default_tax_percentage),
      serviceChargePercentage: Number(settings.service_charge_percentage),
      serviceChargeOrderTypes: settings.service_charge_order_types || ["dine_in"],
      orderPrefix: settings.order_prefix,
      invoicePrefix: settings.invoice_prefix,
      gstNumber: settings.gst_number,
      fssaiNumber: settings.fssai_number,
      gstSplit: settings.gst_split,
      billFooter: settings.bill_footer,
      autoConsumeStock: settings.auto_consume_stock,
      // The Loyalty points feature (Settings -> Features): the switch is the
      // one place loyalty is on or off; the rules below stay here.
      loyaltyEnabled: restaurantFeatures.has(req.user, "guest_loyalty"),
      loyaltyEarnAmount: Number(settings.loyalty_earn_amount),
      loyaltyPointValue: Number(settings.loyalty_point_value),
      loyaltyMinRedeem: settings.loyalty_min_redeem,
      printPaperWidth: settings.print_paper_width,
      printCopies: settings.print_copies,
      autoPrintBill: settings.auto_print_bill,
      billHeader: settings.bill_header,
      printShowQr: settings.print_show_qr,
      receiptLogoPath: settings.receipt_logo_path,
      documentType: settings.document_type || "auto",
      compositionPercentage: settings.composition_percentage === null ? null : Number(settings.composition_percentage),
      compositionNote: settings.composition_note,
      // Payments and numbering (billing build).
      upiVpa: settings.upi_vpa || null,
      upiPayeeName: settings.upi_payee_name || null,
      invoiceNumbering: settings.invoice_numbering || "continuous",
    },
  });
};

const updateSettings = async (req, res) => {
  const body = req.body || {};

  const data = {
    currencyCode: v.requiredString(body.currencyCode, "Currency code", 3).toUpperCase(),
    currencySymbol: v.requiredString(body.currencySymbol, "Currency symbol", 5),
    // Checked against the places the database knows in the service.
    timezone: v.requiredString(body.timezone, "Timezone", 50),
    // Left out by an older screen: the saved choice is kept.
    serviceChargeOrderTypes:
      body.serviceChargeOrderTypes === undefined || body.serviceChargeOrderTypes === null
        ? null
        : [...new Set(v.requiredArray(body.serviceChargeOrderTypes, "Service charge order types"))].map((type) =>
            v.requiredEnum(type, "Service charge order type", ORDER_TYPES)
          ),
    taxMode: v.requiredEnum(body.taxMode, "Tax mode", ["inclusive", "exclusive"]),
    defaultTaxPercentage: v.requiredNumber(body.defaultTaxPercentage, "Default tax %", {
      min: 0,
      max: 100,
    }),
    serviceChargePercentage: v.requiredNumber(body.serviceChargePercentage, "Service charge %", {
      min: 0,
      max: 100,
    }),
    orderPrefix: v.requiredString(body.orderPrefix, "Order prefix", 10).toUpperCase(),
    invoicePrefix: v.requiredString(body.invoicePrefix, "Invoice prefix", 10).toUpperCase(),
    gstNumber: v.optionalString(body.gstNumber, "GST number", 20),
    fssaiNumber: v.optionalString(body.fssaiNumber, "FSSAI number", 20),
    gstSplit: v.requiredBoolean(body.gstSplit, "GST split", true),
    billFooter: v.optionalString(body.billFooter, "Bill footer", 200),
    autoConsumeStock: v.requiredBoolean(body.autoConsumeStock, "Auto stock consumption", true),
    loyaltyEarnAmount: v.optionalNumber(body.loyaltyEarnAmount, "Spend per point", {
      min: 1,
      max: 999999,
    }) ?? 100,
    loyaltyPointValue: v.optionalNumber(body.loyaltyPointValue, "Point value", {
      min: 0.01,
      max: 9999,
    }) ?? 1,
    loyaltyMinRedeem: v.optionalNumber(body.loyaltyMinRedeem, "Minimum points to redeem", {
      min: 0,
      max: 100000,
    }) ?? 50,
    printPaperWidth: v.optionalEnum(
      body.printPaperWidth,
      "Paper width",
      ["58mm", "80mm", "a4"],
      "80mm"
    ),
    printCopies: v.optionalNumber(body.printCopies, "Copies", { min: 1, max: 5 }) ?? 1,
    autoPrintBill: v.requiredBoolean(body.autoPrintBill, "Auto print", false),
    billHeader: v.optionalString(body.billHeader, "Bill header", 200),
    printShowQr: v.requiredBoolean(body.printShowQr, "Show QR", false),
    receiptLogoPath: v.optionalString(body.receiptLogoPath, "Receipt logo URL", 500),
    documentType: v.optionalEnum(body.documentType, "Document type", ["auto", "tax_invoice", "bill_of_supply"], "auto"),
    compositionPercentage: v.optionalNumber(body.compositionPercentage, "Composition rate", { min: 0, max: 100 }),
    compositionNote: v.optionalString(body.compositionNote, "Composition note", 200),
  };

  // The prefix starts every invoice number, and GST allows only letters,
  // digits, "-" and "/" in one (16 characters in all; see
  // restaurant.repository SERIES_MAX). A space or a "#" would make every bill
  // a number the GST portal refuses.
  if (!INVOICE_PREFIX.test(data.invoicePrefix)) {
    throw new AppError(
      400,
      "The invoice prefix can use letters, digits, - and / only (GST allows nothing else in an invoice number), up to 10 characters, like INV or HYD/26"
    );
  }

  // The UPI ID printed as a QR on bills, and numbers that restart each
  // financial year. Left out (an older screen): kept as they are.
  const money = {
    upiVpa: body.upiVpa === undefined ? undefined : readUpiVpa(body.upiVpa, "The restaurant's"),
    upiPayeeName: body.upiPayeeName === undefined ? undefined : v.optionalString(body.upiPayeeName, "UPI payee name", 100),
    invoiceNumbering:
      body.invoiceNumbering === undefined
        ? undefined
        : v.requiredEnum(body.invoiceNumbering, "Invoice numbering", ["continuous", "financial_year"]),
  };

  // Loyalty on or off is the Loyalty points feature now. An older screen (or
  // script) that still sends it switches the feature, under the same rules
  // as Settings -> Features: Guests must be on, and the change is logged.
  const loyaltyEnabled =
    body.loyaltyEnabled === undefined || body.loyaltyEnabled === null
      ? undefined
      : v.requiredBoolean(body.loyaltyEnabled, "Loyalty", false);

  await restaurantService.checkNumbering(req.user.restaurantId, data.invoicePrefix, money.invoiceNumbering);

  if (loyaltyEnabled !== undefined && loyaltyEnabled !== restaurantFeatures.has(req.user, "guest_loyalty")) {
    const switched = await restaurantFeatures.set(req.user, "guest_loyalty", loyaltyEnabled);
    req.user.features = switched.features.filter((feature) => feature.enabled).map((feature) => feature.code);
  }

  await restaurantService.updateSettings(req.user.restaurantId, data, req.user.id);
  await restaurantService.updateMoneySettings(req.user.restaurantId, money, req.user.id);
  Object.assign(data, Object.fromEntries(Object.entries(money).filter(([, value]) => value !== undefined)));

  logAction(req, "update", "settings", { label: "Restaurant settings", details: data });

  return getSettings(req, res);
};

// What every bill number will look like: the main counter's series and each
// outlet's, so the owner sees it before the first bill prints.
const getInvoiceSeries = async (req, res) => {
  res.json({ success: true, data: await restaurantService.getInvoiceSeries(req.user.restaurantId) });
};

const listTimezones = async (req, res) => {
  res.json({ success: true, data: await restaurantService.listTimezones() });
};

const getDiscountLimits = async (req, res) => {
  res.json({ success: true, data: await restaurantService.getDiscountLimits(req.user.restaurantId) });
};

// { limits: [{ roleId, maxPercent }] } — maxPercent null takes a role's cap off.
const saveDiscountLimits = async (req, res) => {
  const limits = v.requiredArray(req.body?.limits, "Limits").map((limit) => ({
    roleId: v.requiredId(limit && limit.roleId, "Role"),
    maxPercent:
      limit && (limit.maxPercent === null || limit.maxPercent === "")
        ? null
        : v.requiredNumber(limit && limit.maxPercent, "Most a role may take off (%)", { min: 0, max: 100 }),
  }));

  const saved = await restaurantService.saveDiscountLimits(req.user.restaurantId, limits, req.user.id);

  logAction(req, "update", "settings", {
    label: "Till discount limits",
    details: {
      limits: saved.roles.map((role) => ({ role: role.name, maxPercent: role.maxPercent })),
    },
  });

  res.json({ success: true, message: "Discount limits saved", data: saved });
};

const getBusinessHours = async (req, res) => {
  const days = await restaurantService.getBusinessHours(req.user.restaurantId);

  res.json({ success: true, data: days });
};

// All seven days are sent together, so the week is always complete and consistent.
const updateBusinessHours = async (req, res) => {
  const days = v.requiredArray(req.body?.days, "Days");

  if (days.length !== 7) {
    throw new AppError(400, "All seven days must be provided");
  }

  const parsed = days.map((day, index) => {
    const isOpen = v.requiredBoolean(day.isOpen, `Day ${index} open/closed`, true);
    const periods = isOpen
      ? v.requiredArray(day.periods || [{ openTime: day.openTime, closeTime: day.closeTime }], "Service periods").map((period) => ({
          openTime: v.requiredString(period.openTime, "Opening time", 8),
          closeTime: v.requiredString(period.closeTime, "Closing time", 8),
        }))
      : [];
    if (periods.length > 3) throw new AppError(400, "A day can have up to three service periods");
    const openTime = isOpen ? periods[0].openTime : null;
    const closeTime = isOpen ? periods[periods.length - 1].closeTime : null;

    if (isOpen && periods.some((period) => !TIME_PATTERN.test(period.openTime) || !TIME_PATTERN.test(period.closeTime))) {
      throw new AppError(400, "Times must be in 24-hour HH:MM format");
    }

    return {
      dayOfWeek: v.requiredNumber(day.dayOfWeek, "Day of week", { min: 0, max: 6 }),
      isOpen,
      openTime,
      closeTime,
      periods,
    };
  });

  const saved = await restaurantService.updateBusinessHours(
    req.user.restaurantId,
    parsed,
    req.user.id
  );

  res.json({ success: true, message: "Business hours updated", data: saved });
};

module.exports = {
  getCurrent,
  updateCurrent,
  getSettings,
  updateSettings,
  getInvoiceSeries,
  listTimezones,
  getDiscountLimits,
  saveDiscountLimits,
  getBusinessHours,
  updateBusinessHours,
};
