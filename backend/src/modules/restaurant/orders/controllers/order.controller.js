const orderService = require("../services/order.service");
const restaurantFeatures = require("../../setup/services/restaurantFeatures.service");
const authorizeOrApprove = require("../../../../middlewares/authorizeOrApprove");
const AppError = require("../../../../utils/AppError");
const { logAction } = require("../../../../utils/audit");
const v = require("../../../../utils/validate");
const { maskMobile } = require("../../../../utils/phone");

const ORDER_TYPES = ["dine_in", "takeaway", "delivery", "qr", "online"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Taking off a dish the kitchen already has needs orders.cancel_after_kot, or
// a manager's PIN for this one request. It cannot sit on the route: the same
// PUT that adds two naan may also take a paneer tikka off, and only the
// service knows which, once it has the order locked. So the shared approval
// check is run from inside the service, only when it is needed, with what
// the change would take off (`scope`: the order, the dish, how many, how
// much). A manager's approval is tied to exactly those facts: the PIN prompt
// shows them, and the approval covers no more.
const CANCEL_AFTER_KOT = "orders.cancel_after_kot";

const approvalGate = (req, res) => {
  let checked = null;

  const gate = (scope) => {
    if (!checked) {
      const check = authorizeOrApprove(CANCEL_AFTER_KOT, { scope: () => scope });

      checked = new Promise((resolve, reject) => {
        Promise.resolve(check(req, res, resolve)).catch(reject);
      }).then(() => req.approval || null);
    }

    return checked;
  };

  // Whether this person may take dishes off by themselves. Someone who may
  // not needs a manager for each dish (see order.service authoriseCancellation),
  // and the service has to know that before it asks for anything.
  gate.holds = (req.user?.permissions || []).includes(CANCEL_AFTER_KOT);
  // Whether a manager's token came with the request: redeeming it reads the
  // database, so the service does that outside the order's lock
  // (order.service approvalOutsideLock).
  gate.hasToken = Boolean(req.get("X-Approval-Token"));

  return gate;
};

const optionalId = (value, field) =>
  value === undefined || value === null || value === "" ? null : v.requiredId(value, field);

// A head count is a whole number of people.
const optionalCount = (value, field) => {
  const number = v.optionalNumber(value, field, { min: 1, max: 999 });

  if (number !== null && !Number.isInteger(number)) {
    throw new AppError(400, `${field} must be a whole number`);
  }

  return number;
};

const readModifierIds = (value) =>
  value === undefined || value === null
    ? []
    : v.requiredArray(value, "Add-ons").map((id) => v.requiredId(id, "Add-on"));

const readNewItem = (item) => {
  if (!item || typeof item !== "object") {
    throw new AppError(400, "Each item must name a dish and a quantity");
  }

  const courseNo = v.optionalNumber(item.courseNo, "Course", { min: 1, max: 20 }) ?? 1;
  if (!Number.isInteger(courseNo)) throw new AppError(400, 'Course must be a whole number');
  return {
    productId: v.requiredId(item.productId, "Product"),
    productVariantId: optionalId(item.productVariantId, "Size"),
    modifierIds: readModifierIds(item.modifierIds),
    comboSelections: require('../../menu/services/menuServiceOptions.service').readSelections(item.comboSelections),
    quantity: v.requiredNumber(item.quantity, "Quantity", { min: 0.01, max: 9999 }),
    notes: v.optionalString(item.notes, "Item notes", 200),
    courseNo,
    courseName: v.optionalString(item.courseName, "Course name", 60),
    holdCourse: v.requiredBoolean(item.holdCourse, "Hold course", false),
  };
};

const fireCourse = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const courseNo = v.requiredNumber(req.params.courseNo, "Course", { min: 1, max: 20 });
  if(!Number.isInteger(courseNo))throw new AppError(400,'Course must be a whole number');
  const order = await orderService.fireCourse(req.user.restaurantId, id, courseNo, req.user.id);
  logAction(req, "fire", "order", { id, label: order.orderNumber, details: { courseNo } });
  res.json({ success: true, message: `Course ${courseNo} sent to the kitchen`, data: order });
};

// Only ids, quantities and notes are accepted: prices come from the menu.
const readNewItems = (body = {}) => v.requiredArray(body.items, "Items").map(readNewItem);

// An edit lists lines already on the order by their id with the quantity
// wanted now (0 takes it off) and the quantity the screen showed when the
// waiter changed it, and new dishes as for a new order.
const readEditItems = (body = {}) =>
  v.requiredArray(body.items, "Items").map((item) => {
    if (item && typeof item === "object" && item.id !== undefined && item.id !== null) {
      return {
        id: v.requiredId(item.id, "Order line"),
        quantity: v.requiredNumber(item.quantity, "Quantity", { min: 0, max: 9999 }),
        seenQuantity: v.optionalNumber(item.seenQuantity, "Quantity shown", { min: 0, max: 9999 }),
      };
    }

    return readNewItem(item);
  });

const readCommon = (body = {}) => ({
  customerId: optionalId(body.customerId, "Customer"),
  customerName: v.optionalString(body.customerName, "Customer name", 150),
  customerMobile: v.optionalString(body.customerMobile, "Customer mobile", 20),
  guestCount: optionalCount(body.guestCount, "Guests"),
  notes: v.optionalString(body.notes, "Notes", 500),
});

// Only the fields the request sent. Leaving one out leaves it as it is.
const readHeader = (body = {}) => {
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const header = {};

  if (has("notes")) {
    header.notes = v.optionalString(body.notes, "Notes", 500);
  }

  if (has("guestCount")) {
    header.guestCount = optionalCount(body.guestCount, "Guests");
  }

  if (has("customerId") || has("customerName") || has("customerMobile")) {
    header.customer = {
      customerId: optionalId(body.customerId, "Customer"),
      customerName: v.optionalString(body.customerName, "Customer name", 150),
      customerMobile: v.optionalString(body.customerMobile, "Customer mobile", 20),
    };
  }

  return header;
};

// What the screen showed of the order's own details when the waiter changed
// them: { notes, guestCount, customerId, customerName, customerMobile }, any
// of them. A detail another device changed after that is not overwritten
// (order.service checkHeaderSeen). Left out, nothing is compared, as before.
const readSeen = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "What the screen showed of the order could not be read. Reload the page and try again.");
  }

  const has = (key) => Object.prototype.hasOwnProperty.call(value, key);
  const seen = {};

  if (has("notes")) {
    // No length cap: a note guests added by QR can have grown past what one
    // person may type, and what the screen showed must still be read.
    seen.notes = v.optionalString(value.notes, "Notes shown", 20000);
  }

  if (has("guestCount")) {
    seen.guestCount = v.optionalNumber(value.guestCount, "Guests shown", { min: 0, max: 999 });
  }

  if (has("customerId") || has("customerName") || has("customerMobile")) {
    seen.customer = {
      customerId: optionalId(value.customerId, "Guest shown"),
      customerName: v.optionalString(value.customerName, "Guest name shown", 150),
      customerMobile: v.optionalString(value.customerMobile, "Guest mobile shown", 20),
    };
  }

  return seen;
};

const readReason = (value) =>
  v.optionalEnum(value, "Reason", orderService.REASON_CODES, null);

const dishLabel = (row) => `${row.itemName}${row.variantName ? ` (${row.variantName})` : ""}`;

// One activity-log row for each dish taken off after the kitchen had it:
// what, how many, what it was worth, why, and (written by logAction) the
// manager who approved it.
const logCancellations = (req, order) => {
  const cancelled = order.changes && order.changes.cancelled ? order.changes.cancelled : [];

  for (const row of cancelled.filter((one) => one.afterKot)) {
    logAction(req, "cancel_item", "order", {
      id: order.id,
      label: order.orderNumber,
      details: {
        dish: dishLabel(row),
        quantity: row.quantity,
        amount: row.amount,
        reason: row.reason,
        note: row.note || undefined,
        kitchenHad: row.kitchenStage || "sent",
        via: row.source === "edit" ? "POS edit" : "Orders screen",
        itemId: row.orderItemId,
      },
    });
  }
};

const list = async (req, res) => {
  const filters = {
    outletId: req.outletId || null,
    status: req.query.status
      ? v.requiredEnum(req.query.status, "Status", ["open", "billed", "completed", "cancelled"])
      : null,
    orderType: req.query.orderType
      ? v.requiredEnum(req.query.orderType, "Order type", ORDER_TYPES)
      : null,
    businessDayId: optionalId(req.query.businessDayId, "Business day"),
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 500 }) ?? 100,
    // Where a page starts (the Orders screen pages through every order).
    offset: v.optionalNumber(req.query.offset, "Offset", { min: 0, max: 10000000 }) ?? 0,
    // "tables_first": every running table before any takeaway, each newest
    // first. The POS's Still running strip asks for this, so a busy counter's
    // takeaways can never push a table off it.
    // "oldest": the longest-waiting first (the dashboard's Running orders).
    sort: v.optionalEnum(req.query.sort, "Sort", ["newest", "tables_first", "oldest"], "newest"),
    // "today": this trading day's orders only; "earlier": only those taken
    // on an earlier trading day and still in the list (left open).
    age: v.optionalEnum(req.query.age, "Age", ["today", "earlier"], null),
  };

  // Whole numbers only: "1.5" would otherwise reach the database as a page
  // size or a starting row and come back as a server error.
  if (!Number.isInteger(filters.limit) || !Number.isInteger(filters.offset)) {
    throw new AppError(400, "Limit and offset must be whole numbers");
  }

  const data = await orderService.list(req.user.restaurantId, filters);

  // A list of orders is a list of guests' numbers. Staff who may see guests'
  // full contact details (customers.contact) get them; everyone else sees the
  // last four digits, the way the guest book shows them. Opening one order
  // (GET /:id) still gives the till the number of the guest it is serving.
  if (!(req.user.permissions || []).includes("customers.contact")) {
    data.items = data.items.map((order) =>
      order.customerMobile ? { ...order, customerMobile: maskMobile(order.customerMobile) } : order
    );
  }

  res.json({ success: true, data });
};

const getById = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");

  res.json({ success: true, data: await orderService.getById(req.user.restaurantId, id) });
};

// ?orderId= (the order the till has open) or ?tableId= (the table a new
// order is for): the prices are the ones that order will be charged.
const offers = async (req, res) => {
  const context = {
    orderType: v.optionalEnum(req.query.orderType, "Service type", ORDER_TYPES, "dine_in"),
    channelId: optionalId(req.query.channelId, "Channel"),
    orderId: optionalId(req.query.orderId, "Order"),
    tableId: optionalId(req.query.tableId, "Table"),
  };

  res.json({ success: true, data: await orderService.offers(req.user.restaurantId, req.outletId, context) });
};

const serviceDay = async (req, res) => {
  res.json({ success: true, data: await orderService.serviceDay(req.user.restaurantId, req.outletId) });
};

const saleOutlets = async (req, res) => {
  res.json({ success: true, data: await orderService.saleOutlets(req.user.restaurantId) });
};

const readDate = (value, field) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const text = String(value).trim();

  if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw new AppError(400, `${field} must look like 2026-09-24`);
  }

  return text;
};

const cancellations = async (req, res) => {
  const filters = {
    from: readDate(req.query.from, "From"),
    to: readDate(req.query.to, "To"),
    userId: optionalId(req.query.userId, "Staff member"),
    reason: readReason(req.query.reason),
    // Follows the outlet the person is working in; an owner looking at every
    // outlet sends none.
    outletId: req.outletId || null,
    limit: v.optionalNumber(req.query.limit, "Limit", { min: 1, max: 1000 }) ?? 500,
    // The Every dish grid pages through the server (25, 50 or 100 a page).
    offset: v.optionalNumber(req.query.offset, "Offset", { min: 0, max: 10000000 }) ?? 0,
  };

  res.json({
    success: true,
    data: await orderService.cancellations(req.user.restaurantId, filters),
  });
};

// A new guest signed up from the till is worth a line in the activity log:
// the guest book grew, and this says who added them and on which order.
const logGuestAdded = (req, order) => {
  if (order && order.guestAdded) {
    logAction(req, "create", "customer", {
      id: order.guestAdded.id,
      label: order.guestAdded.name,
      details: { via: "POS order", order: order.orderNumber },
    });
  }
};

// " · Kiran added to the guest book", or why they were not added.
const guestLine = (order) => {
  if (order && order.guestAdded) {
    return ` · ${order.guestAdded.name} added to the guest book`;
  }

  return order && order.guestNotice ? ` · ${order.guestNotice}` : "";
};

// Seating a party on a table held for a booking goes through only when the
// till says so ("seat them anyway").
const readOverrideHold = (body = {}) => body.overrideHold === true || body.seatDespiteHold === true;

// ------------------------------------------------------------------ tokens

// The collection screen's board. Only someone who takes orders gets the
// order ids (to mark a token collected); a display screen gets numbers only.
const collectionBoard = async (req, res) => {
  const staff = (req.user?.permissions || []).includes("orders.create");

  res.json({
    success: true,
    data: await orderService.collectionBoard(req.user.restaurantId, req.outletId, { staff }),
  });
};

// The amount the waiver is for, read from the order (never from the screen),
// so a manager's PIN for "waive ₹40" cannot be spent on a bigger charge. The
// reason is checked here, before anyone is asked for a PIN.
const waiveScope = async (req) => {
  const id = v.requiredId(req.params.id, "Order id");

  readWaiveReason(req.body);

  const order = await require("../repositories/order.repository").findById(req.user.restaurantId, id);

  return { orderId: id, amount: order ? Number(order.delivery_charge || 0) : 0 };
};

const readWaiveReason = (body) => v.requiredString((body || {}).reason, "Reason for waiving the delivery charge", 200);

const waiveDeliveryCharge = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const reason = readWaiveReason(req.body);
  const { order, before } = await orderService.setDeliveryChargeWaived(
    req.user.restaurantId,
    id,
    { waived: true, reason },
    req.user.id
  );

  logAction(req, "waive_delivery_charge", "order", {
    id,
    label: order.orderNumber,
    details: { amount: before, reason },
  });

  res.json({ success: true, message: `Delivery charge waived on ${order.orderNumber}`, data: order });
};

const restoreDeliveryCharge = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const { order } = await orderService.setDeliveryChargeWaived(req.user.restaurantId, id, { waived: false }, req.user.id);

  logAction(req, "restore_delivery_charge", "order", {
    id,
    label: order.orderNumber,
    details: { amount: order.deliveryCharge },
  });

  res.json({ success: true, message: `Delivery charge added back on ${order.orderNumber}`, data: order });
};

const markCollected = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const result = await orderService.markCollected(req.user.restaurantId, id, req.user.id);

  logAction(req, "collect_token", "order", {
    id,
    label: result.orderNumber,
    details: { token: result.tokenNo },
  });

  res.json({ success: true, message: `Token ${result.tokenNo} collected`, data: result });
};

// What a switched-off feature takes away from an order (Settings -> Features):
// a delivery needs Deliveries; picking a guest from the guest book needs
// Guests. With Guests off a name and mobile typed at the till stay on the
// order as plain text (for the collection call or the delivery), and nobody
// is looked up or added to the guest book.
const checkFeatures = async (req, data, orderType) => {
  if (orderType === "delivery") {
    await restaurantFeatures.assertOn(req.user, "deliveries");
  }

  if (data.customerId) {
    await restaurantFeatures.assertOn(req.user, "guests");
  }

  if (Object.prototype.hasOwnProperty.call(data, "linkGuest")) {
    data.linkGuest = restaurantFeatures.has(req.user, "guests");
  }
};

const create = async (req, res) => {
  const body = req.body || {};

  const data = {
    ...readCommon(body),
    channelId: optionalId(body.channelId, "Channel"),
    // Brands: the brand the order is taken under (null: the kitchen's name).
    brandId: optionalId(body.brandId, "Brand"),
    // From the till: a table held for a booking is checked, and a mobile
    // typed without picking a guest finds or signs up the guest.
    holdCheck: true,
    overrideHold: readOverrideHold(body),
    linkGuest: true,
    // A takeaway or delivery must name its outlet when the restaurant has
    // outlets (order.service create).
    saleOutletCheck: true,
    orderType: v.optionalEnum(body.orderType, "Order type", ORDER_TYPES, "dine_in"),
    source: v.optionalEnum(
      body.source,
      "Source",
      ["pos", "captain", "qr", "website", "phone", "partner"],
      "pos"
    ),
    tableId: optionalId(body.tableId, "Table"),
    // Settled by resolveOutlet, never taken from the request body: an outlet
    // id the browser sends is a request, not a fact.
    outletId: req.outletId,
    // Tied to that outlet (not just picked in the top bar): its own tables only.
    outletPinned: Boolean(req.outletPinned),
    items: readNewItems(body),
  };

  await checkFeatures(req, data, data.orderType);
  const order = await orderService.create(req.user.restaurantId, data, req.user.id);

  logGuestAdded(req, order);

  res.status(201).json({
    success: true,
    message: `Order placed${guestLine(order)}`,
    data: order,
  });
};

const updateItems = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const body = req.body || {};
  const data = {
    items: readEditItems(body),
    // The POS sends only what the waiter changed; a line it does not name is
    // left as it is (see planEdit). liveOnly is what the POS of the previous
    // release called it.
    changesOnly: body.changesOnly === true || body.liveOnly === true,
    header: readHeader(body),
    seen: readSeen(body.seen),
    cancelReason: readReason(body.cancelReason),
    cancelNote: v.optionalString(body.cancelNote, "Note", 200),
    // Only compared with the order's own table: a different one is refused
    // (planEdit), never quietly ignored.
    tableId: optionalId(body.tableId, "Table"),
    linkGuest: true,
  };

  // A whole cart sent from a browser can only be a POS screen from before
  // this release, still open on a till: the current one sends only what
  // changed. That screen also still holds dishes that were cancelled, as
  // ordinary cart lines, and would put them back on the order and in front
  // of the kitchen. It is asked to reload instead. (Browsers name the page a
  // save comes from; the seed scripts and other server code do not, and
  // keep sending whole carts as before.)
  //
  // The same goes for a browser changing the note, the guests or the guest
  // without saying what it showed (`seen`): only a POS screen from before
  // this release does that, and it compares its boxes with the wrong copy of
  // the order, so it would wipe a note or a guest another device put on.
  const outdated =
    (!data.changesOnly && data.items.every((item) => !item.id)) ||
    (Object.keys(data.header).length > 0 && !data.seen);

  if (outdated && req.get("Origin")) {
    throw new AppError(
      409,
      "This screen is from before an update. Reload the page, open the order again and make your change.",
      { reason: "outdated_screen" }
    );
  }

  await checkFeatures(req, data.header.customer || {});
  data.linkGuest = restaurantFeatures.has(req.user, "guests");

  const order = await orderService.updateItems(req.user.restaurantId, id, data, req.user.id, {
    gate: approvalGate(req, res),
  });

  logCancellations(req, order);
  logGuestAdded(req, order);

  const taken = (order.changes?.cancelled || []).filter((row) => row.afterKot).length;

  res.json({
    success: true,
    message: `${taken > 0 ? `Order updated · ${taken} dish${taken === 1 ? "" : "es"} cancelled` : "Order updated"}${guestLine(order)}`,
    data: order,
  });
};

// Takes all or part of one dish off: { quantity?, reason, note? }. A dish
// the kitchen already has needs a reason from the list and the right person.
const cancelItem = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const itemId = v.requiredId(req.params.itemId, "Item id");
  const body = req.body || {};

  const order = await orderService.cancelItem(
    req.user.restaurantId,
    id,
    itemId,
    {
      quantity: v.optionalNumber(body.quantity, "Quantity", { min: 0.01, max: 9999 }),
      reasonCode: readReason(body.reason),
      note: v.optionalString(body.note, "Note", 200),
    },
    req.user.id,
    { gate: approvalGate(req, res) }
  );

  logCancellations(req, order);

  // Taken off before the kitchen had it: a corrected order, still worth a line
  // in the log so the order's history reads whole.
  for (const row of (order.changes?.cancelled || []).filter((one) => !one.afterKot)) {
    logAction(req, "remove_item", "order", {
      id: order.id,
      label: order.orderNumber,
      details: { dish: dishLabel(row), quantity: row.quantity, amount: row.amount, kitchenHad: "nothing yet" },
    });
  }

  res.json({ success: true, message: "Item cancelled", data: order });
};

const setKitchenStatus = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const status = v.requiredEnum(req.body?.status, "Status", [
    "pending",
    "preparing",
    "ready",
    "served",
  ]);

  const order = await orderService.setKitchenStatus(
    req.user.restaurantId,
    id,
    status,
    req.user.id
  );

  res.json({ success: true, message: `Kitchen status set to ${status}`, data: order });
};

const cancel = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const reason = v.requiredString(req.body?.reason, "Cancellation reason", 200);
  const reasonCode = readReason(req.body?.reasonCode);

  const order = await orderService.cancel(
    req.user.restaurantId,
    id,
    { reason, reasonCode },
    req.user.id,
    { gate: approvalGate(req, res) }
  );

  const kitchenHad = order.changes ? order.changes.cancelled : [];

  logAction(req, "cancel", "order", {
    id: order.id,
    label: order.orderNumber,
    details: {
      reason,
      amount: order.totalAmount,
      kitchenHad: kitchenHad.length > 0 ? kitchenHad.map((row) => `${row.quantity} × ${dishLabel(row)}`) : undefined,
    },
  });

  res.json({ success: true, message: "Order cancelled", data: order });
};

// ------------------------------------------------------------ the guest at the till

// GET /orders/guest?mobile=98765 43210: who this is, as the till shows it.
const lookupGuest = async (req, res) => {
  const mobile = v.optionalString(req.query.mobile, "Mobile", 30);

  if (!mobile) {
    throw new AppError(400, "Type the guest's mobile number");
  }

  res.json({
    success: true,
    data: await orderService.lookupGuest(req.user.restaurantId, mobile, {
      revealContacts: (req.user.permissions || []).includes("customers.contact"),
    }),
  });
};

// ------------------------------------------------------------ moving guests and dishes

const readTarget = (body = {}) => ({
  tableId: v.requiredId(body.tableId, "Table"),
  overrideHold: readOverrideHold(body),
});

// "2 × Butter Naan, 1 × Dal Makhani (Half)": what moved, in plates, the way
// the waiter counts it (two naan are two, not "1 dish" because they were one
// line). A long list names the first few and counts the rest.
const qtyWord = (quantity) => String(Number(quantity));

const movedList = (moved) => (moved || []).map((row) => `${qtyWord(row.quantity)} × ${dishLabel(row)}`);

const movedText = (moved) => {
  const names = movedList(moved);

  return names.length > 4 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
};

const freedText = (tables) =>
  tables && tables.length > 0
    ? ` ${tables.length === 1 ? `Table ${tables[0]} is` : `Tables ${tables.join(", ")} are`} free again.`
    : "";

const moveTable = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const input = readTarget(req.body || {});
  const result = await orderService.moveTable(req.user.restaurantId, id, input, req.user.id);

  logAction(req, "move_table", "order", {
    id,
    label: result.order.orderNumber,
    details: {
      from: result.fromTableNo,
      to: result.toTableNo,
      freed: result.releasedTables && result.releasedTables.length ? result.releasedTables : undefined,
      seatedDespiteBooking: input.overrideHold || undefined,
    },
  });

  res.json({
    success: true,
    message: `${result.order.orderNumber} moved from table ${result.fromTableNo} to table ${result.toTableNo}.${freedText(result.releasedTables)}`,
    data: result,
  });
};

const joinTable = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const input = readTarget(req.body || {});
  const result = await orderService.joinTable(req.user.restaurantId, id, input, req.user.id);

  logAction(req, "join_table", "order", {
    id,
    label: result.order.orderNumber,
    details: {
      table: result.joinedTableNo,
      joinedOrder: result.merged ? result.merged.orderNumber : undefined,
      dishes: result.merged ? movedList(result.merged.moved) : undefined,
      seatedDespiteBooking: input.overrideHold || undefined,
    },
  });

  if (result.merged) {
    logAction(req, "join_table", "order", {
      id: result.merged.id,
      label: result.merged.orderNumber,
      details: { joinedInto: result.order.orderNumber, table: result.joinedTableNo },
    });
  }

  res.json({
    success: true,
    message: result.merged
      ? `Table ${result.joinedTableNo} joined to table ${result.tableNo}. ${result.merged.orderNumber}'s dishes${
          result.merged.moved && result.merged.moved.length > 0 ? ` (${movedText(result.merged.moved)})` : ""
        } and KOTs are on ${result.order.orderNumber} now.`
      : `Table ${result.joinedTableNo} joined to table ${result.tableNo} on ${result.order.orderNumber}.`,
    data: result,
  });
};

const unjoinTable = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const tableId = v.requiredId(req.body?.tableId, "Table");
  const result = await orderService.unjoinTable(req.user.restaurantId, id, { tableId }, req.user.id);

  logAction(req, "unjoin_table", "order", {
    id,
    label: result.orderNumber,
    details: { table: result.tableNo },
  });

  // "Free again" only when it is: the till must never be told a table is
  // free while somebody is sitting at it.
  res.json({
    success: true,
    message: result.freed
      ? `Table ${result.tableNo} is no longer part of ${result.orderNumber}, and is free again.`
      : `Table ${result.tableNo} is no longer part of ${result.orderNumber}. It stays taken: another order is running there.`,
    data: result,
  });
};

// { tableId, items: [{ id, quantity, seenQuantity }], guests?, overrideHold? }
const moveDishes = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");
  const body = req.body || {};
  const input = {
    ...readTarget(body),
    items: v.requiredArray(body.items, "Dishes").map((item) => {
      if (!item || typeof item !== "object") {
        throw new AppError(400, "Each dish to move must name the order line and how many");
      }

      return {
        id: v.requiredId(item.id, "Order line"),
        quantity: v.requiredNumber(item.quantity, "Quantity", { min: 0.01, max: 9999 }),
        seenQuantity: v.optionalNumber(item.seenQuantity, "Quantity shown", { min: 0, max: 9999 }),
      };
    }),
    guests: optionalCount(body.guests, "Guests moving"),
  };

  const result = await orderService.moveDishes(req.user.restaurantId, id, input, req.user.id);
  const fromNumber = result.from ? result.from.orderNumber : result.order.orderNumber;

  logAction(req, "move_dishes", "order", {
    id,
    label: fromNumber,
    details: {
      from: result.fromTableNo,
      to: result.toTableNo,
      toOrder: result.order.orderNumber,
      newOrder: result.created || undefined,
      everything: result.mode !== "dishes" || undefined,
      dishes: movedList(result.moved),
      amount: (result.moved || []).reduce((sum, row) => Math.round((sum + Number(row.amount)) * 100) / 100, 0),
      seatedDespiteBooking: input.overrideHold || undefined,
    },
  });

  let message;

  if (result.mode === "table") {
    message = `Every dish moved, so ${result.order.orderNumber} is on table ${result.toTableNo} now.${freedText(result.releasedTables)}`;
  } else if (result.mode === "merged") {
    message = `Every dish moved to ${result.order.orderNumber} on table ${result.toTableNo}. Table ${result.fromTableNo} is free.${freedText(result.releasedTables)}`;
  } else {
    message = `${movedText(result.moved)} moved to table ${result.toTableNo}${
      result.created ? ` on a new order, ${result.order.orderNumber}` : ` onto ${result.order.orderNumber}`
    }.`;
  }

  res.json({ success: true, message, data: result });
};

// GET /orders/:id/moves: the order's own history of moves.
const joinedTables = async (req, res) => {
  res.json({ success: true, data: await orderService.listJoinedTables(req.user.restaurantId) });
};

const moves = async (req, res) => {
  const id = v.requiredId(req.params.id, "Order id");

  res.json({ success: true, data: await orderService.listMoves(req.user.restaurantId, id) });
};

module.exports = {
  waiveScope,
  waiveDeliveryCharge,
  restoreDeliveryCharge,
  collectionBoard,
  markCollected,
  list,
  getById,
  lookupGuest,
  moveTable,
  joinTable,
  unjoinTable,
  moveDishes,
  moves,
  joinedTables,
  offers,
  serviceDay,
  saleOutlets,
  fireCourse,
  cancellations,
  create,
  updateItems,
  cancelItem,
  setKitchenStatus,
  cancel,
};
