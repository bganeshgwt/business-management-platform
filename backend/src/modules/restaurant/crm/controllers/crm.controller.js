const crmService = require("../services/crm.service");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const AppError = require("../../../../utils/AppError");
const { readMobile } = require("../../../../utils/phone");
const { readGstin } = require("../../../../utils/gstin");
const consents = require("../../../personal-data/services/consents");
const personalData = require("../../../personal-data/services/personalDataRestaurant");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const readDate = (value, field) => {
  if (!value) {
    return null;
  }

  if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AppError(400, `${field} must be a date like 1990-05-20`);
  }

  return value;
};

// Full mobiles, emails and addresses are for customers.contact (owners and
// managers). Everyone else who can see guests (a cashier, a floor role given
// customers.view or feedback.view) sees "XXXXXX3210", on every read and on
// the answer to every write, so no list, form or saved complaint hands back a
// number the person could not read in the list. A cashier who typed a guest's
// whole number gets that number back (crm.service toListedCustomer), and can
// open one guest's contact details on purpose (revealContact, logged).
const canSeeContacts = (req) => (req.user?.permissions || []).includes("customers.contact");
// Staff who attach guests to orders get back the one number they typed in full
// (see crm.service toListedCustomer); a view-only role does not.
const attachesGuests = (req) => (req.user?.permissions || []).includes("customers.manage");

const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

const TAGS = ["vip", "allergy", "jain", "vegan", "corporate", "family", "blogger"];

// --- Paging and sorting ---

const readPage = (query, { defaultLimit = 25, maxLimit = 100 } = {}) => {
  const limit = v.optionalNumber(query.limit, "Limit", { min: 1, max: maxLimit });
  const offset = v.optionalNumber(query.offset, "Offset", { min: 0, max: 10000000 });

  if ((limit !== null && !Number.isInteger(limit)) || (offset !== null && !Number.isInteger(offset))) {
    throw new AppError(400, "Limit and offset must be whole numbers");
  }

  return { limit: limit ?? defaultLimit, offset: offset ?? 0 };
};

const readDirection = (value) => v.optionalEnum(value, "Direction", ["asc", "desc"], null);

// A report's date range: both dates, from not after to, at most a year and a
// bit, defaulting to the last 30 days of the restaurant's own calendar.
const readRange = async (req) => {
  let from = readDate(req.query.from, "From date");
  let to = readDate(req.query.to, "To date");

  if (!from || !to) {
    const today = await crmService.todayFor(req.user.restaurantId);
    const end = to || today;
    const start = new Date(`${end}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 29);
    to = end;
    from = from || start.toISOString().slice(0, 10);
  }

  if (from > to) {
    throw new AppError(400, "The From date must be on or before the To date");
  }

  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;

  if (days > 400) {
    throw new AppError(400, "Pick a range of at most 400 days");
  }

  return { from, to };
};

// --- Customers ---

const readTags = (value) => {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  const list = Array.isArray(value) ? value : String(value).split(",");
  const tags = [...new Set(list.map((tag) => String(tag).trim()).filter(Boolean))];

  for (const tag of tags) {
    v.requiredEnum(tag, "Tag", TAGS);
  }

  return tags;
};

// A field is read only when the request carries it. On an edit, a field left
// out keeps its value (crm.service editCustomer): an older screen or script
// that sends name and mobile alone no longer wipes the guest's email, address
// or birthday, or makes an inactive guest active again. A field sent empty is
// cleared. A new guest is active unless the request says otherwise.
const readCustomerBody = (body = {}, today) => {
  const data = {
    name: v.requiredString(body.name, "Name", 150),
    mobile: has(body, "mobile") ? readMobile(body.mobile, "Mobile") : undefined,
    email: has(body, "email") ? (body.email ? v.requiredEmail(body.email, "Email") : null) : undefined,
    address: has(body, "address") ? v.optionalString(body.address, "Address", 500) : undefined,
    dateOfBirth: has(body, "dateOfBirth") ? readDate(body.dateOfBirth, "Date of birth") : undefined,
    notes: has(body, "notes") ? v.optionalString(body.notes, "Notes", 500) : undefined,
    status: has(body, "status") ? v.optionalEnum(body.status, "Status", ["active", "inactive"], "active") : undefined,
  };

  // Today on the restaurant's clock (a server on UTC is still on yesterday until 05:30 in India).
  if (data.dateOfBirth && data.dateOfBirth > today) {
    throw new AppError(400, "Date of birth cannot be in the future");
  }

  // The wedding anniversary: read only when sent, so an older screen that
  // does not know it leaves it alone.
  if (has(body, "anniversaryDate")) {
    data.anniversaryDate = readDate(body.anniversaryDate, "Anniversary");

    if (data.anniversaryDate && data.anniversaryDate > today) {
      throw new AppError(400, "The anniversary is the wedding date, so it cannot be in the future");
    }
  }

  if (has(body, "companyName")) {
    data.companyName = v.optionalString(body.companyName, "Company name", 150);
  }

  if (has(body, "gstin")) {
    data.gstin = readGstin(body.gstin, "GSTIN");
  }

  if (has(body, "tags")) {
    data.tags = readTags(body.tags);
  }

  if (has(body, "allergies")) {
    data.allergies = v.optionalString(body.allergies, "Allergies", 300);
  }

  if (has(body, "marketingOptIn")) {
    data.marketingOptIn = v.requiredBoolean(body.marketingOptIn, "Offers consent", false);
  }

  // Consent per purpose, each yes or no: bills on WhatsApp or SMS, reminders, offers.
  if (has(body, "consents")) {
    data.consents = consents.readChoices(body.consents) || undefined;
  }

  // "This is a different number" after the form was told another guest holds
  // the same ten digits in the other form (+9598473967 and 9598473967).
  if (has(body, "sameDigitsConfirmed")) {
    data.sameDigitsConfirmed = body.sameDigitsConfirmed === true;
  }

  // A B2B invoice is made out to the company: a GSTIN on its own is no use.
  if (data.gstin && !data.companyName && has(body, "gstin")) {
    throw new AppError(400, "Add the company name the GST invoice should be made out to");
  }

  // "Allergy" on a guest's card with nothing written is worse than no tag:
  // the kitchen is warned but not told of what.
  if (data.tags && data.tags.includes("allergy") && !data.allergies) {
    throw new AppError(400, "Write what the guest is allergic to, so the kitchen knows");
  }

  return data;
};

// The till's quick search and the older screens: a plain list. How many
// matched is in the X-Total-Count header, so a caller can tell when the list
// is not all of them.
const listCustomers = async (req, res) => {
  const filters = {
    search: v.optionalString(req.query.search, "Search", 100),
    // The POS picker only needs the first few matches.
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 500 }),
  };

  const result = await crmService.listCustomers(req.user.restaurantId, filters, {
    reveal: canSeeContacts(req),
    revealTyped: attachesGuests(req),
    withTotal: true,
  });

  res.set("X-Total-Count", String(result.total));
  res.set("X-Limit", String(filters.limit || 500));
  // Part of a number was typed that, for this person, finds a guest only in
  // full or by its last 4 digits (crm.service readSearch).
  res.set("X-Search-Limited", result.searchLimited ? "1" : "0");
  // Readable by a screen on another origin (the app is served apart from the API).
  res.set("Access-Control-Expose-Headers", "X-Total-Count, X-Limit, X-Search-Limited");
  res.json({ success: true, data: result.items });
};

const BOOK_SORTS = ["name", "visits", "lastVisit", "spend", "points", "created"];

const readBookFilters = (query) => {
  const sort = v.optionalEnum(query.sort, "Sort", BOOK_SORTS, "name");
  const direction = readDirection(query.dir);

  return {
    search: v.optionalString(query.search, "Search", 100),
    status: v.optionalEnum(query.status, "Status", ["active", "inactive", "erased", "all"], "active"),
    tag: v.optionalEnum(query.tag, "Tag", TAGS, null),
    optedIn: query.optedIn === "true" || query.optedIn === "1",
    business: query.business === "true" || query.business === "1",
    // Quick views: a birthday or anniversary in the next 7 days, no visit in
    // 60 days, or guests who have spent (sorted by spend on the screen).
    view: v.optionalEnum(query.view, "View", ["occasion", "lapsed", "top"], null),
    sort,
    // Names read A to Z; every number reads biggest first unless asked.
    ascending: direction ? direction === "asc" : sort === "name",
  };
};

// The guest book, a page at a time.
const guestBook = async (req, res) => {
  const filters = { ...readBookFilters(req.query), ...readPage(req.query) };

  res.json({
    success: true,
    data: await crmService.listGuestBook(req.user.restaurantId, filters, canSeeContacts(req), {
      revealTyped: attachesGuests(req),
    }),
  });
};

// Every matching guest, for a CSV. Owners and managers only
// (customers.export), and written to the activity log.
const exportGuestBook = async (req, res) => {
  const filters = readBookFilters(req.query);
  const result = await crmService.exportGuestBook(req.user.restaurantId, filters, canSeeContacts(req));

  logAction(req, "export", "guest_book", {
    label: `${Math.min(result.total, result.cap)} guests`,
    details: {
      rows: Math.min(result.total, result.cap),
      search: filters.search || undefined,
      status: filters.status,
      tag: filters.tag || undefined,
      optedIn: filters.optedIn || undefined,
    },
  });

  res.json({ success: true, data: result });
};

// A consent given or withdrawn on the form is logged with the consent itself,
// in the same transaction (modules/personal-data).
const createCustomer = async (req, res) => {
  const customer = await crmService.createCustomer(
    req.user.restaurantId,
    readCustomerBody(req.body, await crmService.todayFor(req.user.restaurantId)),
    req.user.id,
    { userName: req.user.name }
  );

  res.status(201).json({ success: true, message: "Customer created", data: customer });
};

const updateCustomer = async (req, res) => {
  const id = v.requiredId(req.params.id, "Customer id");
  const reveal = canSeeContacts(req);
  const { before, after } = await crmService.editCustomer(
    req.user.restaurantId,
    id,
    readCustomerBody(req.body, await crmService.todayFor(req.user.restaurantId)),
    req.user.id,
    // A form that could not show the number sends its box back empty.
    { reveal, keepHiddenContact: !reveal, userName: req.user.name }
  );

  if (before.gstin !== after.gstin || before.companyName !== after.companyName) {
    logAction(req, "update_business", "customer", {
      id,
      label: after.name,
      details: {
        companyName: [before.companyName, after.companyName],
        gstin: [before.gstin, after.gstin],
      },
    });
  }

  res.json({ success: true, message: "Customer updated", data: after });
};

// Only a record with no history (added by mistake) can be deleted outright;
// see crm.service removeCustomer.
const removeCustomer = async (req, res) => {
  const id = v.requiredId(req.params.id, "Customer id");
  const removed = await crmService.removeCustomer(req.user.restaurantId, id, {
    canErase: (req.user?.permissions || []).includes("customers.erase"),
  });

  logAction(req, "delete", "customer", { id, label: removed.name });

  res.json({ success: true, message: "Customer deleted" });
};

// "Delete my data". The activity log names the record by number only: writing
// the guest's name there would keep exactly what they asked to have removed.
// The erasure is kept in the requests register (Settings › Personal data) as
// a request received and done today, with the reason as what was asked.
const eraseCustomer = async (req, res) => {
  const id = v.requiredId(req.params.id, "Customer id");
  const reason = v.requiredString(req.body?.reason, "Reason", 200);
  const result = await crmService.eraseCustomer(req.user.restaurantId, id, req.user.id, {
    within: (client, erased) => personalData.recordGuestBookErasure(client, req.user, id, reason, erased),
  });

  logAction(req, "erase", "customer", {
    id,
    label: `Guest #${id}`,
    details: {
      reason,
      pointsCancelled: result.pointsCancelled,
      cleared: result.cleared,
      detached: result.detached,
    },
  });

  res.json({
    success: true,
    message: "The guest's personal details were erased. Their bills are kept.",
    data: {
      customer: result.customer,
      pointsCancelled: result.pointsCancelled,
      cleared: result.cleared,
      detached: result.detached,
    },
  });
};

const mergeCustomer = async (req, res) => {
  const keepId = v.requiredId(req.params.id, "Customer id");
  const mergeId = v.requiredId(req.body?.mergeId, "Guest to merge");
  const result = await crmService.mergeCustomers(req.user.restaurantId, keepId, mergeId, req.user.id, {
    reveal: canSeeContacts(req),
  });

  logAction(req, "merge", "customer", {
    id: keepId,
    label: `${result.customer.name} ← ${result.merged.name}`,
    details: {
      mergedId: result.merged.id,
      mergedName: result.merged.name,
      // The last digits say which record it was; the activity log is read by
      // supervisors who may not see guests' numbers.
      mergedMobile: result.merged.mobileMasked || undefined,
      pointsMoved: result.pointsMoved,
      pointsBefore: result.pointsBefore,
      recordsMoved: result.recordsMoved,
      gstinSetAside: result.invoices.gstinSetAside || undefined,
    },
  });

  const setAside = result.invoices.gstinSetAside;

  res.json({
    success: true,
    message:
      `${result.merged.name} was merged into ${result.customer.name}.` +
      (setAside
        ? ` The GSTIN ${setAside.gstin} was not kept on the record, because it also holds ordinary bills that must stay ordinary sales;` +
          " invoices already made out to it keep it."
        : ""),
    data: result,
  });
};

const listDuplicates = async (req, res) => {
  res.json({
    success: true,
    data: await crmService.listDuplicates(req.user.restaurantId, canSeeContacts(req)),
  });
};

const dismissDuplicate = async (req, res) => {
  const id = v.requiredId(req.params.id, "Customer id");
  await crmService.dismissDuplicate(req.user.restaurantId, id, req.user.id);

  logAction(req, "not_duplicate", "customer", { id });

  res.json({ success: true, message: "Marked as a different guest" });
};

// Everything known about one customer: visits, favourites and points.
const customerHistory = async (req, res) => {
  const id = v.requiredId(req.params.id, "Customer id");
  const visitsOffset = v.optionalNumber(req.query.visitsOffset, "Visits offset", { min: 0, max: 1000000 });

  res.json({
    success: true,
    data: await crmService.customerHistory(req.user.restaurantId, id, {
      reveal: canSeeContacts(req),
      visitsOffset: visitsOffset ? Math.floor(visitsOffset) : 0,
    }),
  });
};

const adjustPoints = async (req, res) => {
  const id = v.requiredId(req.params.id, "Customer id");
  const body = req.body || {};
  const points = v.requiredNumber(body.points, "Points", { min: -100000, max: 100000 });

  if (points === 0) {
    throw new AppError(400, "Enter a number of points to add or take away");
  }

  const reason = v.requiredString(body.notes, "Reason", 200);
  const result = await crmService.adjustPoints(req.user.restaurantId, id, Math.round(points), reason, req.user.id);

  // The reason is what a supervisor reading the log needs most ("waited 40
  // minutes"); logAction adds the approving manager when a PIN was used.
  logAction(req, "loyalty_adjust", "customer", { id, details: { points: Math.round(points), reason } });

  res.json({ success: true, message: "Points updated", data: result });
};

// One guest's full contact details, opened on purpose by someone who sees
// them masked. Written to the activity log before answering (the daily limit
// is counted from it); crm.service revealContact has the why.
const revealContact = async (req, res) => {
  const id = v.requiredId(req.params.id, "Customer id");
  // Someone who sees every number anyway is not counted or logged. For
  // everyone else the service writes the activity-log row in the same
  // transaction as the count, so the limit holds for requests sent at once.
  const limited = !canSeeContacts(req);
  const contact = await crmService.revealContact(req.user.restaurantId, id, req.user.id, {
    limited,
    userName: req.user.name,
  });

  res.json({ success: true, data: { ...contact, logged: limited } });
};

// --- Feedback ---

const listFeedback = async (req, res) => {
  const page = readPage(req.query, { defaultLimit: 200, maxLimit: 200 });
  const filters = {
    status: req.query.status
      ? v.requiredEnum(req.query.status, "Status", ["new", "reviewed", "archived"])
      : null,
    rating: v.optionalEnum(req.query.rating, "Rating", ["happy", "neutral", "unhappy"], null),
    search: v.optionalString(req.query.search, "Search", 100),
    ...page,
  };

  res.json({
    success: true,
    data: await crmService.listFeedback(req.user.restaurantId, filters, canSeeContacts(req)),
  });
};

const createFeedback = async (req, res) => {
  const body = req.body || {};

  const data = {
    customerId: body.customerId ? v.requiredId(body.customerId, "Customer") : null,
    customerName: v.optionalString(body.customerName, "Customer name", 150),
    customerMobile: readMobile(body.customerMobile, "Customer mobile"),
    rating: v.requiredNumber(body.rating, "Rating", { min: 1, max: 5 }),
    comments: v.optionalString(body.comments, "Comments", 1000),
    source: v.optionalEnum(
      body.source,
      "Source",
      ["in_store", "qr", "website", "phone", "other"],
      "in_store"
    ),
    feedbackStatus: "new",
  };

  if (!Number.isInteger(data.rating)) {
    throw new AppError(400, "Rating must be a whole number of stars, 1 to 5");
  }

  const result = await crmService.createFeedback(req.user.restaurantId, data, req.user.id, {
    reveal: canSeeContacts(req),
  });

  res.status(201).json({ success: true, message: "Feedback saved", data: result });
};

const setFeedbackStatus = async (req, res) => {
  const id = v.requiredId(req.params.id, "Feedback id");
  const status = v.requiredEnum(req.body?.status, "Status", ["new", "reviewed", "archived"]);

  await crmService.setFeedbackStatus(req.user.restaurantId, id, status, req.user.id);

  res.json({ success: true, message: "Feedback updated" });
};

// --- Complaints ---

const COMPENSATION = ["apology", "replaced", "removed", "discount", "complimentary", "refund", "voucher", "points"];

const listComplaints = async (req, res) => {
  const page = readPage(req.query, { defaultLimit: 200, maxLimit: 200 });
  const filters = {
    status: v.enumList(req.query.status, "Status", [
      "open",
      "in_progress",
      "resolved",
      "closed",
    ]),
    search: v.optionalString(req.query.search, "Search", 100),
    // One outlet's complaints only (the dashboard, with an outlet chosen).
    outletId: v.optionalNumber(req.query.outletId, "Outlet", { min: 1 }),
    // ?sort=age: by priority, then the longest-waiting first.
    oldestFirst: v.optionalEnum(req.query.sort, "Sort", ["age", "newest"], "newest") === "age",
    ...page,
  };

  res.json({
    success: true,
    data: await crmService.listComplaints(req.user.restaurantId, filters, canSeeContacts(req)),
  });
};

const listAssignees = async (req, res) => {
  res.json({ success: true, data: await crmService.listAssignees(req.user.restaurantId) });
};

// "Which bill is this about?" — checked while the complaint form is open, so
// the person logging it sees the bill, its amount and its guest before saving.
const lookupReference = async (req, res) => {
  const reference = v.requiredString(req.query.reference, "Bill or order number", 40);

  res.json({
    success: true,
    data: await crmService.lookupReference(req.user.restaurantId, reference, canSeeContacts(req)),
  });
};

const readComplaintBody = (body = {}) => {
  const data = {
    subject: v.requiredString(body.subject, "Subject", 200),
    description: v.optionalString(body.description, "Description", 1000),
    category: v.optionalEnum(
      body.category,
      "Category",
      ["food", "service", "delivery", "billing", "hygiene", "other"],
      "other"
    ),
    priority: v.optionalEnum(body.priority, "Priority", ["low", "medium", "high"], "medium"),
    assignedTo: body.assignedTo ? v.requiredId(body.assignedTo, "Assigned to") : null,
  };

  // The bill or order it is about: a number typed off the bill, or the ids.
  if (has(body, "reference")) {
    data.reference = v.optionalString(body.reference, "Bill or order number", 40);
  }

  if (has(body, "billId")) {
    data.billId = body.billId ? v.requiredId(body.billId, "Bill") : null;
  }

  if (has(body, "orderId")) {
    data.orderId = body.orderId ? v.requiredId(body.orderId, "Order") : null;
  }

  if (has(body, "compensationType")) {
    data.compensationType = v.optionalEnum(body.compensationType, "Compensation", COMPENSATION, null);
  }

  if (has(body, "compensationValue")) {
    const value = v.optionalNumber(body.compensationValue, "Compensation value", { min: 0, max: 1000000 });
    data.compensationValue = value ?? 0;
  }

  if (has(body, "compensationNotes")) {
    data.compensationNotes = v.optionalString(body.compensationNotes, "Compensation details", 300);
  }

  return data;
};

const createComplaint = async (req, res) => {
  const body = req.body || {};

  const data = {
    ...readComplaintBody(body),
    customerId: body.customerId ? v.requiredId(body.customerId, "Customer") : null,
    customerName: v.optionalString(body.customerName, "Customer name", 150),
    customerMobile: readMobile(body.customerMobile, "Customer mobile"),
    complaintStatus: "open",
  };

  const complaint = await crmService.createComplaint(req.user.restaurantId, data, req.user.id, {
    reveal: canSeeContacts(req),
  });

  if (complaint.compensationType) {
    logAction(req, "compensate", "complaint", {
      id: complaint.id,
      label: complaint.subject,
      details: { type: complaint.compensationType, value: complaint.compensationValue },
    });
  }

  res.status(201).json({ success: true, message: "Complaint logged", data: complaint });
};

const updateComplaint = async (req, res) => {
  const id = v.requiredId(req.params.id, "Complaint id");
  const body = req.body || {};

  const data = {
    ...readComplaintBody(body),
    complaintStatus: v.requiredEnum(body.complaintStatus, "Status", [
      "open",
      "in_progress",
      "resolved",
      "closed",
    ]),
    resolution: v.optionalString(body.resolution, "Resolution", 1000),
  };

  if (has(body, "customerMobile")) {
    data.customerMobile = readMobile(body.customerMobile, "Customer mobile");
  }

  if (has(body, "customerName")) {
    data.customerName = v.optionalString(body.customerName, "Customer name", 150);
  }

  const { before, after: complaint } = await crmService.editComplaint(
    req.user.restaurantId,
    id,
    data,
    req.user.id,
    { reveal: canSeeContacts(req) }
  );

  // What a guest was given to put things right costs money, so a change to it
  // is on the activity log beside the voids and refunds.
  if (
    before.compensationType !== complaint.compensationType ||
    before.compensationValue !== complaint.compensationValue
  ) {
    logAction(req, "compensate", "complaint", {
      id,
      label: complaint.subject,
      details: {
        type: complaint.compensationType,
        value: complaint.compensationValue,
        was: before.compensationType ? { type: before.compensationType, value: before.compensationValue } : undefined,
      },
    });
  }

  res.json({ success: true, message: "Complaint updated", data: complaint });
};

// --- Reports ---

// Points owed, how points moved day by day, and who holds them. all=1 returns
// every holder for a CSV, which is an export (customers.export, logged).
const loyaltyReport = async (req, res) => {
  const range = await readRange(req);
  const all = req.query.all === "1" || req.query.all === "true";
  const page = all ? { limit: 20000, offset: 0 } : readPage(req.query);

  if (all) {
    requireExport(req);
  }

  const report = await crmService.loyaltyReport(req.user.restaurantId, { ...range, ...page }, canSeeContacts(req));

  if (all) {
    logAction(req, "export", "loyalty_report", {
      label: `${report.holders.items.length} guests holding points`,
      details: { from: range.from, to: range.to },
    });
  }

  res.json({ success: true, data: report });
};

const SALES_SORTS = ["spend", "visits", "bills", "average", "lastVisit", "name"];

const customerSalesReport = async (req, res) => {
  const range = await readRange(req);
  const all = req.query.all === "1" || req.query.all === "true";
  const page = all ? { limit: 20000, offset: 0 } : readPage(req.query);
  const sort = v.optionalEnum(req.query.sort, "Sort", SALES_SORTS, "spend");
  const direction = readDirection(req.query.dir);

  if (all) {
    requireExport(req);
  }

  const report = await crmService.customerSalesReport(
    req.user.restaurantId,
    {
      ...range,
      ...page,
      sort,
      ascending: direction ? direction === "asc" : sort === "name",
      search: v.optionalString(req.query.search, "Search", 100),
    },
    canSeeContacts(req)
  );

  if (all) {
    logAction(req, "export", "customer_sales", {
      label: `${report.items.length} guests`,
      details: { from: range.from, to: range.to },
    });
  }

  res.json({ success: true, data: report });
};

// A whole list with names and numbers leaves the building only with
// customers.export, whichever screen asks for it.
function requireExport(req) {
  if (!(req.user?.permissions || []).includes("customers.export")) {
    throw new AppError(403, "Exporting guest lists needs the Export guest lists permission");
  }
}

module.exports = {
  customerHistory,
  adjustPoints,
  revealContact,
  listCustomers,
  guestBook,
  exportGuestBook,
  createCustomer,
  updateCustomer,
  removeCustomer,
  eraseCustomer,
  mergeCustomer,
  listDuplicates,
  dismissDuplicate,
  listFeedback,
  createFeedback,
  setFeedbackStatus,
  listComplaints,
  listAssignees,
  lookupReference,
  createComplaint,
  updateComplaint,
  loyaltyReport,
  customerSalesReport,
};
