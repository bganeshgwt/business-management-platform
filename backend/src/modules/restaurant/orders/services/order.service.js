const sellingRules = require("../../menu/services/sellingRules.service");
const serviceOptions = require('../../menu/services/menuServiceOptions.service');
const orderRepository = require("../repositories/order.repository");
const priceWindowRepository = require("../../menu/repositories/priceWindow.repository");
const tableRepository = require("../../tables/repositories/table.repository");
const deliveryChargeRepository = require("../../deliveries/repositories/deliveryCharge.repository");
const guestAddressRepository = require("../../online/repositories/guestAddress.repository");
const guestAddressService = require("../../online/services/guestAddress.service");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const outletRepository = require("../../setup/repositories/outlet.repository");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const crmRepository = require("../../crm/repositories/crm.repository");
const kitchenRepository = require("../../kitchen/repositories/kitchen.repository");
const serviceSettingsRepository = require("../../setup/repositories/serviceSettings.repository");
const AppError = require("../../../../utils/AppError");
const { round2, taxFromExclusive, taxFromInclusive } = require("../../../../utils/money");
const { abroadTenCountry, normaliseMobile, mobileProblem, tenDigitTwin } = require("../../../../utils/phone");

// Why a dish the kitchen already has is being taken off (utils/cancelReasons).
const { CANCEL_REASONS, reasonLabel } = require("../../../../utils/cancelReasons");

const REASON_CODES = CANCEL_REASONS.map((reason) => reason.code);

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toOrder = (row) => ({
  id: row.id,
  orderNumber: row.order_number,
  orderType: row.order_type,
  source: row.source,
  outletId: row.outlet_id || null,
  tableId: row.table_id,
  tableNo: row.table_no,
  customerId: row.customer_id,
  customerName: row.customer_name || row.linked_customer_name,
  customerMobile: row.customer_mobile,
  guestCount: row.guest_count,
  orderStatus: row.order_status,
  kitchenStatus: row.kitchen_status,
  subtotal: Number(row.subtotal),
  taxAmount: Number(row.tax_amount),
  totalAmount: Number(row.total_amount),
  notes: row.notes,
  cancelReason: row.cancel_reason,
  placedAt: row.placed_at,
  completedAt: row.completed_at,
  updatedAt: row.updated_at,
  businessDayId: row.business_day_id,
  // Lists only: taken on an earlier trading day (still open or billed there).
  ...(row.earlier_day === undefined ? {} : { earlierDay: row.earlier_day === true }),
  // Tables pushed against this one for the same party ([{ tableId, tableNo }]),
  // and, for an order that was joined into another, which one.
  joinedTables: (row.joined_tables || []).map((table) => ({ tableId: table.tableId, tableNo: table.tableNo })),
  mergedIntoOrderId: row.merged_into_order_id || null,
  mergedIntoOrderNumber: row.merged_into_order_number || null,
  createdByName: row.created_by_name,
  billId: row.bill_id,
  billNumber: row.bill_number,
  billStatus: row.bill_status,
  itemCount: row.item_count,
  // Live plates (two naan on one line are two), in lists only.
  dishCount: row.dish_count === undefined || row.dish_count === null ? null : Number(row.dish_count),
  // Delivery details, kept on the order by the deliveries module.
  channelId: row.channel_id || null,
  channelName: row.channel_name || null,
  deliveryStatus: row.delivery_status || null,
  deliveryAddress: row.delivery_address || null,
  deliveryLandmark: row.delivery_landmark || null,
  externalOrderRef: row.external_order_ref || null,
  deliveryEtaMinutes:
    row.delivery_eta_minutes === null || row.delivery_eta_minutes === undefined
      ? null
      : Number(row.delivery_eta_minutes),
  partnerRiderName: row.partner_rider_name || null,
  dispatchedAt: row.dispatched_at || null,
  deliveredAt: row.delivered_at || null,
  // The parcel's daily token (1, 2, 3... each business day), when the
  // restaurant uses them, and when it was handed over.
  tokenNo: row.token_no === null || row.token_no === undefined ? null : Number(row.token_no),
  tokenCollectedAt: row.token_collected_at || null,
  // The trip charge on a delivery (SW-A-17), worked out by the server from
  // the channel; the bill shows it as its own line with its GST.
  deliveryCharge: Number(row.delivery_charge || 0),
  deliveryChargeTaxPercent:
    row.delivery_charge_tax_percent === null || row.delivery_charge_tax_percent === undefined
      ? null
      : Number(row.delivery_charge_tax_percent),
  deliveryChargeWaived: Boolean(row.delivery_charge_waived_at),
  deliveryChargeWaivedReason: row.delivery_charge_waived_reason || null,
  items: (row.items || []).map((item) => ({
    id: item.id,
    productId: item.product_id,
    productVariantId: item.product_variant_id,
    itemName: item.item_name,
    variantName: item.variant_name,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    modifierTotal: Number(item.modifier_total),
    taxPercentage: Number(item.tax_percentage),
    priceIncludesTax: item.price_includes_tax,
    mrp: item.mrp == null ? null : Number(item.mrp),
    comboParts: item.combo_parts || [],
    priceWindowId: item.price_window_id,
    priceWindowName: item.price_window_name,
    lineSubtotal: Number(item.line_subtotal),
    lineTax: Number(item.line_tax),
    lineTotal: Number(item.line_total),
    itemStatus: item.item_status,
    notes: item.notes,
    courseNo: Number(item.course_no || 1),
    courseName: item.course_name || null,
    fireStatus: item.fire_status || "fired",
    firedAt: item.fired_at || null,
    // When this line was rung up and by whom: a table's second round is its
    // own line with its own time.
    createdAt: item.created_at,
    createdByName: item.created_by_name || null,
    // How much of the line the kitchen already has (on a KOT). Taking off
    // more than the rest is a cancellation after KOT.
    kitchenQuantity: Number(item.kitchen_quantity || 0),
    kitchenStage: item.kitchen_stage || null,
    // How much of this line has been taken off since it was rung up.
    cancelledQuantity: Number(item.cancelled_quantity || 0),
    // The real add-on ids, which is what the POS sends back when it saves.
    modifiers: (item.modifiers || []).map((modifier) => ({
      id: modifier.id,
      name: modifier.name,
      price: Number(modifier.price),
    })),
  })),
});

// ------------------------------------------------------------------ pricing

const uniqueIds = (ids) => [...new Set((ids || []).map(Number))].sort((a, b) => a - b);

// What a line IS, for deciding whether two lines are the same dish ordered
// the same way: dish, size, add-ons and the note for the kitchen.
const keyOf = (productId, variantId, modifierIds, notes) =>
  [productId, variantId || "", uniqueIds(modifierIds).join(","), (notes || "").trim()].join("|");

const selectionKey = selections => (selections || []).map(s => `${s.groupId}:${s.productId}:${s.productVariantId || ''}`).sort().join(',');
const requestKey = (item) => [keyOf(item.productId, item.productVariantId, item.modifierIds, item.notes),
  item.courseNo || 1, item.holdCourse ? 'held' : 'fired', selectionKey(item.comboSelections)].join('|');

const lineModifierIds = (line) =>
  (line.modifiers || []).map((modifier) => modifier.id).filter((id) => id !== null && id !== undefined);

const lineKey = (line) =>
  [keyOf(line.product_id, line.product_variant_id, lineModifierIds(line), line.notes),
    line.course_no || 1, line.fire_status || 'fired', selectionKey((line.combo_parts || []).filter(p => p.groupId))].join('|');

// Two requests for the same dish, ordered the same way, are one line of two —
// the way a paper ticket reads and the way a kitchen expects it. A different
// size, different add-ons or a note for the cook make it a line of its own.
//
// The POS already merges as the cashier taps; this is here so the order is
// recorded properly whatever sent it.
const mergeRequested = (requestedItems) => {
  const merged = [];

  for (const requested of requestedItems) {
    const modifierIds = uniqueIds(requested.modifierIds);
    const key = requestKey({ ...requested, modifierIds });
    const existing = merged.find((line) => line.key === key);

    if (existing) {
      existing.quantity = round2(existing.quantity + requested.quantity);
    } else {
      merged.push({ ...requested, modifierIds, key });
    }
  }

  return merged;
};

// "Paneer Tikka" is sold out today. Take it off the order and save again.
// Several at once are named together, so the waiter fixes the order once.
const soldOutMessage = (list) => {
  if (list.length === 1) {
    return `"${list[0].name}" is sold out${list[0].today ? " today" : ""}. Take it off the order and save again.`;
  }

  const names = list.map((one) => `"${one.name}"${one.today ? " (today)" : ""}`).join(", ");

  return `These are sold out: ${names}. Take them off the order and save again.`;
};

const splitTax = (lineBase, taxPercentage, taxMode) =>
  taxMode === "inclusive"
    ? taxFromInclusive(lineBase, taxPercentage)
    : taxFromExclusive(lineBase, taxPercentage);

// Prices always come from the menu, never from the browser: the request only
// says which product, size, add-ons and quantity.
//
// Everything is checked as the menu stands right now, because these are NEW
// lines: a dish that is sold out, off the menu or in a category switched off
// (breakfast after 11), a size or add-on that is switched off, an add-on the
// dish does not offer, and a combo with a dish inside it that has run out are
// all refused, as the QR menu already refuses them. Lines already on an order
// are never priced or checked again (see updateItems).
//
// options.outletId is where the order is taken: an outlet's own happy hour
// applies there and nowhere else. options.db is the connection of an edit
// that prices its new round under the order's lock: the menu is read through
// it, never through a second connection (order.repository create says why).
const priceLines = async (restaurantId, requestedItems, taxMode, timezone, options = {}) => {
  if (!requestedItems || requestedItems.length === 0) {
    throw new AppError(400, "Add at least one item to the order");
  }

  const merged = mergeRequested(requestedItems);
  const menu = await orderRepository.findSellable(
    restaurantId,
    [...new Set(merged.map((line) => Number(line.productId)))],
    [...new Set(merged.flatMap((line) => line.modifierIds))],
    options.db,
    options.outletId || null
  );

  const products = new Map(menu.products.map((row) => [Number(row.id), row]));
  const variants = new Map(menu.variants.map((row) => [Number(row.id), row]));
  const modifiers = new Map(menu.modifiers.map((row) => [Number(row.id), row]));
  const offered = new Set(menu.links.map((row) => `${row.product_id}:${row.modifier_id}`));
  // Sold out for tonight, from the POS or the kitchen: "12:" is the whole
  // dish, "12:40" one size of it.
  const soldToday = new Set((menu.soldOut || []).map((row) => `${row.product_id}:${row.product_variant_id || ""}`));
  const isSoldToday = (productId, variantId) =>
    soldToday.has(`${productId}:`) || Boolean(variantId && soldToday.has(`${productId}:${variantId}`));
  // Every sold-out dish in the request, so the refusal names them all at
  // once rather than one per attempt.
  const soldOut = [];
  const partsOf = new Map();

  for (const part of menu.parts) {
    partsOf.set(Number(part.combo_product_id), [...(partsOf.get(Number(part.combo_product_id)) || []), part]);
  }

  // Every happy-hour price running now at this outlet, read once.
  const offers = new Map(
    (await priceWindowRepository.findActivePrices(restaurantId, timezone, options.outletId || null, options.db)).map(
      (row) => [`${row.product_id}:${row.product_variant_id || ""}`, row]
    )
  );

  const rules = await sellingRules.list(restaurantId, options.db);
  const lines = [];

  for (const requested of merged) {
    const product = products.get(Number(requested.productId));

    if (!product) {
      throw new AppError(400, "One of the selected products does not exist");
    }

    if (product.status !== "active") {
      throw new AppError(400, `"${product.name}" is not on the menu right now`);
    }

    if (!serviceOptions.availableNow(product.availability_schedule, timezone)) {
      throw new AppError(400, `"${product.name}" is outside its serving times`);
    }
    const chosenParts = serviceOptions.selectedParts(product.combo_choice_groups, requested.comboSelections);
    const comboParts = product.is_combo ? (partsOf.get(Number(product.id)) || []).map(part => ({
      productId:Number(part.id), productVariantId:part.product_variant_id ? Number(part.product_variant_id) : null,
      name:part.name,variantName:part.variant_name || null,quantity:Number(part.quantity),extraPrice:0,
    })).concat(chosenParts) : null;
    for (const part of comboParts || []) {
      const db = options.db || require('../../../../config/database');
      const current = (await db.query(`SELECT p.*,c.status AS category_status,v.status AS variant_status
        FROM products p JOIN categories c ON c.id=p.category_id
        LEFT JOIN product_variants v ON v.id=$3 AND v.product_id=p.id
        WHERE p.restaurant_id=$1 AND p.id=$2`,[restaurantId,part.productId,part.productVariantId])).rows[0];
      const partRule = sellingRules.selectRule(rules, part.productId, options);
      if (!current || current.status !== 'active' || !current.is_available || current.category_status !== 'active'
        || (part.productVariantId && current.variant_status !== 'active') || partRule?.is_available === false
        || isSoldToday(part.productId,part.productVariantId)
        || !serviceOptions.availableNow(current.availability_schedule,timezone)) {
        throw new AppError(400, `"${product.name}" cannot be served: ${part.name} is unavailable`);
      }
    }

    if (product.category_status !== "active") {
      throw new AppError(
        400,
        `"${product.name}" is in ${product.category_name}, which is switched off right now`
      );
    }

    if (!product.is_available) {
      soldOut.push({ productId: product.id, productVariantId: null, name: product.name, today: false });
      continue;
    }

    if (isSoldToday(product.id, null)) {
      soldOut.push({ productId: product.id, productVariantId: null, name: product.name, today: true });
      continue;
    }

    // A thali the kitchen cannot make is not sold: every dish in it must be
    // on the menu and not sold out.
    for (const part of product.is_combo ? partsOf.get(Number(product.id)) || [] : []) {
      if (part.status !== "active" || (part.variant_status && part.variant_status !== "active")) {
        throw new AppError(
          400,
          `"${product.name}" can't be sold right now: "${part.name}" in it is off the menu`
        );
      }

      if (!part.is_available) {
        throw new AppError(
          400,
          `"${product.name}" can't be sold right now: "${part.name}" in it is sold out`
        );
      }

      if (isSoldToday(part.id, part.product_variant_id)) {
        throw new AppError(
          400,
          `"${product.name}" can't be sold right now: "${part.name}${part.variant_name ? ` (${part.variant_name})` : ""}" in it is sold out today`,
          { reason: "sold_out", items: [{ productId: product.id, productVariantId: null, name: product.name, today: true }] }
        );
      }
    }

    const rule = sellingRules.selectRule(rules, product.id, options);
    if (rule && !rule.is_available) throw new AppError(400, `"${product.name}" is not available for this outlet or service`);
    let unitPrice = Number(rule?.price ?? product.price);
    let variantName = null;

    if (requested.productVariantId) {
      const variant = variants.get(Number(requested.productVariantId));

      if (!variant || Number(variant.product_id) !== Number(product.id)) {
        throw new AppError(400, `That size does not belong to "${product.name}"`);
      }

      if (variant.status !== "active") {
        throw new AppError(400, `The ${variant.name} size of "${product.name}" is switched off`);
      }

      if (isSoldToday(product.id, variant.id)) {
        soldOut.push({
          productId: product.id,
          productVariantId: variant.id,
          name: `${product.name} (${variant.name})`,
          today: true,
        });
        continue;
      }

      unitPrice = round2(unitPrice + Number(variant.price_delta));
      variantName = variant.name;
    }

    // A happy-hour price replaces the menu price outright — it is not a
    // discount, so the bill shows the lower price as the price of the dish.
    // It is set per dish AND size. Add-ons are still charged on top.
    const offer = offers.get(`${product.id}:${requested.productVariantId || ""}`) || null;

    if (offer) {
      unitPrice = round2(Number(offer.price));
    }

    if (unitPrice < 0) {
      throw new AppError(
        400,
        `The ${variantName || "price"} of "${product.name}" works out below zero. Fix it under Menu before selling it.`
      );
    }

    const lineModifiers = [];
    require('../../menu/services/addonGroups.service').validateSelection(product.addon_groups, requested.modifierIds, product.name);
    let modifierTotal = 0;
    for (const part of chosenParts) {
      lineModifiers.push({id:null,name:`${part.groupName}: ${part.name}${part.variantName ? ` (${part.variantName})` : ''} ×${part.quantity}`,price:part.extraPrice});
      modifierTotal = round2(modifierTotal + part.extraPrice);
    }

    for (const modifierId of requested.modifierIds) {
      const modifier = modifiers.get(Number(modifierId));

      if (!modifier) {
        throw new AppError(400, "One of the selected add-ons does not exist");
      }

      if (modifier.status !== "active") {
        throw new AppError(400, `The add-on "${modifier.name}" is switched off`);
      }

      if (!offered.has(`${product.id}:${modifier.id}`)) {
        throw new AppError(400, `"${modifier.name}" is not an add-on for "${product.name}"`);
      }

      lineModifiers.push({ id: modifier.id, name: modifier.name, price: Number(modifier.price) });
      modifierTotal = round2(modifierTotal + Number(modifier.price));
    }

    const packagingCharge=['takeaway','delivery','online'].includes(options.orderType)?Number(rule?.packaging_charge||0):0;
    if(packagingCharge>0){
      lineModifiers.push({id:null,name:'Packaging',price:packagingCharge});
      modifierTotal=round2(modifierTotal+packagingCharge);
    }
    const taxPercentage = options.billOfSupply ? 0 : Number(product.tax_percentage);
    const lineBase = round2((unitPrice + modifierTotal) * requested.quantity);
    const effectiveTaxMode = product.tax_mode === "default" ? taxMode : product.tax_mode;
    const grossUnitPrice = splitTax(unitPrice, taxPercentage, effectiveTaxMode);
    if (product.mrp !== null && product.mrp !== undefined && round2(grossUnitPrice.net + grossUnitPrice.tax) > Number(product.mrp)) {
      throw new AppError(400, `The selling price of "${product.name}" is above its MRP`);
    }
    const split = splitTax(lineBase, taxPercentage, effectiveTaxMode);

    lines.push({
      productId: product.id,
      comboParts,
      productVariantId: requested.productVariantId || null,
      itemName: product.name,
      variantName,
      quantity: requested.quantity,
      unitPrice,
      modifierTotal,
      taxPercentage,
      priceIncludesTax: effectiveTaxMode === "inclusive",
      mrp: product.mrp === null ? null : Number(product.mrp),
      // Copied, not joined: changing a rate later must not rewrite old bills.
      hsnCode: product.hsn_code || null,
      priceWindowId: offer ? offer.price_window_id : null,
      lineSubtotal: split.net,
      lineTax: split.tax,
      lineTotal: round2(split.net + split.tax),
      notes: requested.notes || null,
      courseNo: requested.courseNo || 1,
      courseName: requested.courseName || null,
      holdCourse: requested.holdCourse === true,
      modifiers: lineModifiers,
    });
  }

  if (soldOut.length > 0) {
    throw new AppError(400, soldOutMessage(soldOut), { reason: "sold_out", items: soldOut });
  }

  const totals = lines.reduce(
    (sum, line) => ({
      subtotal: round2(sum.subtotal + line.lineSubtotal),
      taxAmount: round2(sum.taxAmount + line.lineTax),
      totalAmount: round2(sum.totalAmount + line.lineTotal),
    }),
    { subtotal: 0, taxAmount: 0, totalAmount: 0 }
  );

  return { lines, totals };
};

// ------------------------------------------------------------------ shared checks

// Orders belong to a business day, so sales can be totalled per trading day.
const requireOpenBusinessDay = async (restaurantId, outletId) => {
  const day = await businessDayRepository.findOpen(restaurantId, outletId);

  if (!day) {
    // The restaurant trades through outlets, each on its own day, and this
    // till is on "All outlets": say how to go on rather than "open the day".
    if (!outletId && (await businessDayRepository.findOpen(restaurantId))) {
      throw new AppError(
        409,
        "Each outlet runs its own business day, and none is open for the restaurant as a whole. " +
          "Pick the outlet you are working at in the top bar, then take the order.",
        { reason: "outlet_required" }
      );
    }

    throw new AppError(409, "No business day is open. Open the day before taking orders.");
  }

  return day;
};

// Whether the table can take an order at all. Whether it already has one
// running is checked when the order is written, under the table's lock
// (order.repository create), so two tills cannot both open it.
const validateTable = async (restaurantId, orderType, tableId) => {
  if (orderType !== "dine_in") {
    return null;
  }

  if (!tableId) {
    throw new AppError(400, "Choose a table for a dine-in order");
  }

  const table = await tableRepository.findTableById(restaurantId, tableId);

  if (!table) {
    throw new AppError(400, "Selected table does not exist");
  }

  if (table.status !== "active") {
    throw new AppError(400, `Table ${table.table_no} is not in use`);
  }

  // A floor or a section shut for the evening (the terrace in the rain) takes
  // its tables out of service with it.
  if (table.floor_status && table.floor_status !== "active") {
    throw new AppError(400, `Table ${table.table_no} is on a floor that is closed right now`);
  }

  if (table.area_status && table.area_status !== "active") {
    throw new AppError(400, `Table ${table.table_no} is in a section that is closed right now`);
  }

  return table;
};

// A table belongs to the outlet it stands in. Staff working in one outlet
// (tied to it, or with the switcher on it) cannot ring up — or seat a party
// at — another outlet's table: the order would be filed under their outlet
// and day while it sat on the other outlet's floor, where that outlet's staff
// could neither see nor bill it, yet the table looked taken. A till with
// "All outlets" is not refused here (the order then takes the table's own
// outlet, see create).
//
// A table with no outlet is shared by every outlet: an owner or manager
// with the top bar on an outlet may seat guests there for that outlet. Staff
// TIED to an outlet that has tables of its own work on those only
// (REQ-RC-WALK-07): a manager pinned to the branch ringing up main-room table
// M4 filed the main room's sale under the branch. An outlet with no tables
// of its own (a kiosk or counter inside the main room) still uses the shared
// ones, as before.
const refuseOtherOutletTable = async (restaurantId, table, outletId, { pinned = false } = {}) => {
  if (!table || !outletId || Number(table.outlet_id) === Number(outletId)) {
    return;
  }

  if (!table.outlet_id) {
    if (!pinned || (await tableRepository.countOutletTables(restaurantId, outletId)) === 0) {
      return;
    }

    const own = await outletRepository.findById(restaurantId, outletId);

    throw new AppError(
      400,
      `Table ${table.table_no} is in the main dining room, not at ${own ? own.name : "your outlet"}. ` +
        `You work at ${own ? own.name : "your outlet"}, which has tables of its own: pick one of those, or ask ` +
        "a manager to take this table.",
      { reason: "table_main_counter" }
    );
  }

  const outlet = await outletRepository.findById(restaurantId, table.outlet_id);

  throw new AppError(
    400,
    `Table ${table.table_no} belongs to ${outlet ? outlet.name : "another outlet"}. ` +
      "Pick a table of the outlet you are working in.",
    { reason: "table_other_outlet" }
  );
};

// "20:30" as a waiter says it: "8:30 pm".
const clockText = (hhmm) => {
  const [hours, minutes] = String(hhmm || "").split(":").map(Number);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return String(hhmm || "");
  }

  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
};

// The party a free table is being kept for: a booking due within the hour
// or running up to half an hour late (the same window the floor plan shows).
// null when nobody is expected, or when guests are already eating there.
const heldFor = (row) =>
  row && row.booking_id && !row.order_id
    ? {
        id: row.booking_id,
        reference: row.booking_reference,
        guestName: row.booking_guest,
        partySize: row.booking_party,
        time: row.booking_time,
        timeText: clockText(row.booking_time),
        tableId: row.id,
        tableNo: row.table_no,
      }
    : null;

// Seating a walk-in on a table held for a booking is sometimes right (the
// booking is an hour off and the walk-in wants a quick bite), but it must be
// a decision, not an accident: the till is told who is expected and when,
// and the order goes through only when it says "seat them anyway".
const tableHeld = (booking) =>
  new AppError(
    409,
    `Table ${booking.tableNo} is held for ${booking.guestName} at ${booking.timeText} ` +
      `(${booking.partySize} ${booking.partySize === 1 ? "guest" : "guests"}, booking ${booking.reference}). ` +
      "Seat this party there anyway, or choose another table.",
    { reason: "table_held", booking }
  );

const refuseIfHeld = async (restaurantId, tableId, override) => {
  if (override || !tableId) {
    return;
  }

  const [row] = await tableRepository.findTables(restaurantId, { tableId });
  const booking = heldFor(row);

  if (booking) {
    throw tableHeld(booking);
  }
};

const resolveCustomer = async (restaurantId, data) => {
  if (!data.customerId) {
    return {
      customerId: null,
      customerName: data.customerName || null,
      customerMobile: data.customerMobile || null,
    };
  }

  const customer = await crmRepository.findCustomerById(restaurantId, data.customerId);

  if (!customer) {
    throw new AppError(400, "Selected customer does not exist");
  }

  return {
    customerId: customer.id,
    customerName: data.customerName || customer.name,
    customerMobile: data.customerMobile || customer.mobile,
  };
};

// A guest found, or signed up, by the mobile typed at the till.
//
// Staff type the number in the obvious box and expect the till to know the
// regular; before this, only a guest picked from the search earned points,
// and a regular whose number was typed in the Mobile box earned nothing. So
// a mobile on an order from the till (data.customerMobile, with no guest
// picked) is looked up in the one stored form (+91, 0 and spaces taken off):
//   known         the order is linked to them
//   new, named    they are added to the guest book and linked
//   new, no name  the number stays on the order, cleaned
// A number that is not a mobile is refused with what is wrong with it.
//
// Returns the order's guest fields, and `newGuest` ({ name, mobile }) when a
// guest is to be added. Nobody is written here: the order repository adds
// the guest inside the order's own transaction, after the table is known to
// be free (order.repository addGuest), so a refused order adds nobody.
const guestFromMobile = async (restaurantId, data) => {
  if (data.customerId || !data.customerMobile) {
    return { ...(await resolveCustomer(restaurantId, data)), newGuest: null };
  }

  const mobile = normaliseMobile(data.customerMobile);

  if (!mobile) {
    throw new AppError(400, `The guest's mobile ${mobileProblem(data.customerMobile)}`, {
      reason: "bad_mobile",
    });
  }

  const known = await crmRepository.findCustomerByMobile(restaurantId, mobile);

  if (known && !known.erased_at) {
    return {
      customerId: known.id,
      customerName: data.customerName || known.name,
      customerMobile: mobile,
      newGuest: null,
    };
  }

  if (!data.customerName) {
    return { customerId: null, customerName: null, customerMobile: mobile, newGuest: null };
  }

  return {
    customerId: null,
    customerName: data.customerName,
    customerMobile: mobile,
    newGuest: { name: data.customerName, mobile },
  };
};

// What the till shows the moment a mobile is typed: who it is, how often
// they come, what they have in points and what the floor must know (VIP,
// allergies). Only a whole, valid number is looked up, never part of one, so
// the box cannot be used to page through the guest book.
const monthDay = (date) => (date ? `2000-${String(date).slice(5, 10)}` : null);

const lookupGuest = async (restaurantId, text, { revealContacts = false } = {}) => {
  requireRestaurantId(restaurantId);

  const mobile = normaliseMobile(text);

  if (!mobile) {
    const problem = mobileProblem(text);

    return {
      mobile: null,
      valid: false,
      problem: problem ? `This number ${problem}` : "Type the guest's mobile number",
      guest: null,
    };
  }

  const known = await crmRepository.findCustomerByMobile(restaurantId, mobile);

  if (!known || known.erased_at) {
    // Nobody has this number, but somebody may have its ten digits in the
    // other form (the same digits from abroad, utils/phone tenDigitTwin).
    // Such a number is not signed up from the till (order.repository
    // addGuest), and the till says so before the order is saved rather
    // than promising a new guest.
    const twin = tenDigitTwin(mobile);
    const other = twin ? await crmRepository.findCustomerByMobile(restaurantId, twin) : null;

    return {
      mobile,
      valid: true,
      problem: null,
      guest: null,
      sameDigits:
        other && !other.erased_at ? { name: other.name, country: abroadTenCountry(mobile) || "abroad" } : null,
    };
  }

  const [totals, addresses, recent] = await Promise.all([
    crmRepository.customerTotals(restaurantId, known.id),
    guestAddressRepository.findForGuest(restaurantId, known.id),
    orderRepository.findRecentForGuest(restaurantId, known.id, 3),
  ]);

  return {
    mobile,
    valid: true,
    problem: null,
    guest: {
      id: known.id,
      name: known.name,
      mobile,
      loyaltyPoints: Number(known.loyalty_points || 0),
      visits: Number(totals.visits || 0),
      lastVisitAt: totals.last_visit || null,
      tags: known.tags || [],
      allergies: known.allergies || null,
      companyName: known.company_name || null,
      status: known.status,
      // For the birthday / anniversary badge (REQ-GUEST-OCCASION-POS). The
      // till needs the day and month only, so the year is not sent: 2000,
      // a leap year, keeps a 29 February birthday.
      dateOfBirth: monthDay(known.date_of_birth),
      anniversaryDate: monthDay(known.anniversary_date),
      // Saved delivery addresses, newest used first (SW-A-18): full for
      // people who may see contact details, the label and area for others.
      addresses: addresses.map((row) => guestAddressService.toAddress(row, revealContacts)),
      // The last three orders, for "Repeat" (at today's prices).
      recentOrders: recent.map((row) => ({
        id: row.id,
        orderNumber: row.order_number,
        orderType: row.order_type,
        placedAt: row.placed_at,
        totalAmount: Number(row.total_amount),
        items: (row.items || [])
          .filter((item) => Number(item.quantity) > 0)
          .map((item) => ({ ...item, quantity: Number(item.quantity) })),
      })),
    },
  };
};

// The kitchen learns about an order the moment it is saved, even with no
// kitchen screen open, so the KOT prints at once. A kitchen problem must never
// lose the order itself: the order is already saved, and the kitchen display
// picks up anything it missed on its next refresh.
const syncKitchen = async (restaurantId, orderId) => {
  try {
    await kitchenRepository.sync(restaurantId, { orderIds: [orderId] });
  } catch (error) {
    console.error(`Kitchen tickets for order ${orderId} will be cut on the next refresh:`, error.message);
  }
};

const notOpen = (result) => {
  if (result.error === "NOT_FOUND") {
    return new AppError(404, "Order not found");
  }

  if (result.status === "billed") {
    return new AppError(
      409,
      "A billed order can no longer be changed. Void its bill in Bills to reopen it, then change it."
    );
  }

  return new AppError(409, `A ${result.status} order can no longer be changed`);
};

// ------------------------------------------------------------------ reading

const list = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  // { items, total } rather than a bare array, matching what expenses and
  // feedback already return. `total` is how many match the filter, which may
  // be more than were sent, so the screen can say so instead of quietly
  // showing a page and calling it the answer.
  const { rows, total, summary } = await orderRepository.findAll(restaurantId, filters);

  return {
    items: rows.map(toOrder),
    total,
    limit: filters.limit || 100,
    offset: filters.offset || 0,
    // Over every matching order, not only the page sent: how many are on
    // tables, how many are not, and what they all come to.
    summary: {
      onTables: summary.onTables,
      other: total - summary.onTables,
      amount: round2(summary.amount),
      // Taken on an earlier trading day and still in this list (left open):
      // the live screens flag them apart from tonight's.
      earlier: summary.earlier,
      earlierTables: summary.earlierTables,
      oldestAt: summary.oldestAt,
    },
  };
};

const getById = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const row = await orderRepository.findById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Order not found");
  }

  return toOrder(row);
};

// The outlet an order is priced at, by the rules the order itself follows:
//   a running order (orderId)   its own outlet: a new round is priced there
//                               (planEdit), whatever the till has selected
//   a new order                 this till's outlet; with "All outlets" and a
//                               dine-in table (tableId), the table's own
//                               outlet (create)
const pricingOutletId = async (restaurantId, tillOutletId, context = {}) => {
  if (context.orderId) {
    const order = await orderRepository.findOutletOf(restaurantId, context.orderId);

    if (!order) {
      throw new AppError(404, "Order not found");
    }

    return order.outlet_id || null;
  }

  if (tillOutletId) {
    return tillOutletId;
  }

  if (context.tableId) {
    const table = await tableRepository.findTableById(restaurantId, context.tableId);

    return table ? table.outlet_id || null : null;
  }

  return null;
};

// The happy-hour prices running right now where the order will be charged,
// one per dish and size, worked out by the same rules the order is charged
// by. The POS shows these, so the price on the screen is the price on the
// bill: it names the order it has open, or the table it is about to seat
// (context { orderId, tableId }), because with "All outlets" selected a
// table's order is charged at the table's outlet, happy hour included.
const offers = async (restaurantId, outletId, context = {}) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const at = await pricingOutletId(restaurantId, outletId, context);
  const rows = await priceWindowRepository.findActivePrices(restaurantId, settings.timezone, at);

  const order = context.orderId ? await orderRepository.findById(restaurantId, context.orderId) : null;
  const pricingContext = {outletId: at, orderType: order ? order.order_type : context.orderType || "dine_in", channelId: order ? order.channel_id : context.channelId || null};
  if (!order && pricingContext.channelId) await sellingRules.channel(restaurantId, pricingContext.channelId);
  const rules = await sellingRules.list(restaurantId);
  const pool = require("../../../../config/database");
  const products = (await pool.query("SELECT p.id,p.price,p.availability_schedule,v.id AS variant_id,v.price_delta FROM products p LEFT JOIN product_variants v ON v.product_id=p.id WHERE p.restaurant_id=$1",[restaurantId])).rows;
  const contextual = new Map();
  for(const product of products) {
    const rule = sellingRules.selectRule(rules,product.id,pricingContext);
    const inSchedule=serviceOptions.availableNow(product.availability_schedule,settings.timezone);
    if(!rule && inSchedule) continue;
    const price=Number(rule?.price ?? product.price);
    const packagingCharge=["takeaway","delivery","online"].includes(pricingContext.orderType)?Number(rule.packaging_charge||0):0;
    const isAvailable=inSchedule && rule?.is_available!==false;
    const unavailableReason=!inSchedule ? 'Outside serving times' : !isAvailable ? 'Unavailable for this service' : null;
    contextual.set(`${product.id}:`,{productId:product.id,productVariantId:null,price,windowName:rule?'Service price':null,packagingCharge,isAvailable,unavailableReason});
    if(product.variant_id)contextual.set(`${product.id}:${product.variant_id}`,{productId:product.id,productVariantId:product.variant_id,price:round2(price+Number(product.price_delta)),windowName:rule?'Service price':null,packagingCharge,isAvailable,unavailableReason});
  }
  for(const row of rows) {
    const key=`${row.product_id}:${row.product_variant_id || ""}`;
    contextual.set(key,{...contextual.get(key),productId:row.product_id,productVariantId:row.product_variant_id||null,price:Number(row.price),windowId:row.price_window_id,windowName:row.name,endsAt:row.ends_at});
  }
  return [...contextual.values()];

};

// Whether a business day is open, for the POS. Everyone who takes orders
// needs to know, but reading the business-day screen (its cash, its
// history) needs business_day.view, which a captain rightly does not have.
// Without this a captain's POS read "no business day is open" and would not
// save anything at all.
//
// `latest`: with no day open, the most recent business day of this till
// (closed), so the Orders list opens on the last service rather than on
// every order ever taken. Null when a day is open or none was ever opened.
const serviceDay = async (restaurantId, outletId) => {
  requireRestaurantId(restaurantId);

  const day = await businessDayRepository.findOpen(restaurantId, outletId);
  const last = day ? null : (await businessDayRepository.findRecent(restaurantId, 1, outletId))[0] || null;

  return {
    current: day ? { id: day.id, businessDate: day.business_date, openedAt: day.opened_at } : null,
    latest: last
      ? { id: last.id, businessDate: last.business_date, status: last.day_status, closedAt: last.closed_at || null }
      : null,
  };
};

// The outlets a sale can be taken for, by name, for the POS. A till on "All
// outlets" asks which outlet a takeaway (or an order on a table shared by
// every outlet) is for, so every bill belongs to an outlet. Everyone who takes
// orders must be able to answer that, but the outlets screen itself
// (outlets.view: addresses, GST numbers, invoice series) is for owners and
// managers — a cashier not tied to one outlet was never asked before. Only
// the open outlets, and only their names.
const saleOutlets = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await outletRepository.findAll(restaurantId);

  return rows.filter((row) => row.status === "active").map((row) => ({ id: row.id, name: row.name }));
};

// ------------------------------------------------------------------ new orders

// data.holdCheck (the till): a table held for a booking needs
// data.overrideHold. data.linkGuest (the till): a typed mobile finds or adds
// the guest (guestFromMobile). Other callers (QR requests, seed scripts)
// send neither and get exactly what they always got.
const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const table = await validateTable(restaurantId, data.orderType, data.tableId);

  await refuseOtherOutletTable(restaurantId, table, data.outletId, { pinned: Boolean(data.outletPinned) });

  if (data.holdCheck && data.orderType === "dine_in") {
    await refuseIfHeld(restaurantId, data.tableId, data.overrideHold);
  }

  // A table's order belongs to the outlet the table is in, also when it was
  // rung up with "All outlets" selected: its prices, its bill, its stock and
  // where its party may later move are that outlet's. (Opening a table from
  // a booking already did this.) The till shows prices by the same rule
  // (offers, pricingOutletId), so the price on the screen is the one charged.
  const outletId = data.outletId || (table && table.outlet_id) || null;

  // A parcel or a delivery with no outlet is the main counter's sale: the
  // main counter is a selling point of its own, with its own business day,
  // so while its day is open there is nothing to ask. Only when the main
  // counter is not trading would "no outlet" put the sale on nobody's
  // counter — then it must say which outlet it is for. The till asks before
  // saving (with the main counter as one of the choices); this is the same
  // rule for anything else that calls the API. Staff tied to an outlet always
  // have theirs (set by resolveOutlet), and a restaurant with no outlets is
  // not asked.
  if (
    data.saleOutletCheck &&
    !outletId &&
    ["takeaway", "delivery"].includes(data.orderType) &&
    !(await businessDayRepository.findOpen(restaurantId, null))
  ) {
    const open = await saleOutlets(restaurantId);

    if (open.length > 0) {
      throw new AppError(
        409,
        `Pick the outlet this ${data.orderType === "delivery" ? "delivery" : "takeaway"} is for ` +
          `(${open.map((outlet) => outlet.name).slice(0, 4).join(", ")}${open.length > 4 ? "…" : ""}) in the top bar, then save it again.`,
        { reason: "outlet_required" }
      );
    }
  }

  const day = await requireOpenBusinessDay(restaurantId, outletId);

  const channel = await sellingRules.channel(restaurantId, data.channelId);
  const settings = await restaurantRepository.findSettings(restaurantId, outletId);
  const { lines, totals } = await priceLines(
    restaurantId,
    data.items,
    settings.tax_mode,
    settings.timezone,
    { outletId, orderType: data.orderType, channelId: data.channelId, billOfSupply: settings.document_type === "bill_of_supply" }
  );

  // A parcel at a counter that calls orders by token gets the day's next
  // one (service settings: which kinds of order, if any).
  const service = await serviceSettingsRepository.find(restaurantId);
  const withToken = Boolean(service.tokens_enabled) && (service.token_order_types || []).includes(data.orderType);

  // Who the guest is, from the mobile typed. A new guest is only written
  // with the order itself (order.repository create), so a refused order
  // leaves nobody behind in the book.
  const { newGuest, ...customer } = data.linkGuest
    ? await guestFromMobile(restaurantId, data)
    : { ...(await resolveCustomer(restaurantId, data)), newGuest: null };

  const order = await orderRepository.create(
    restaurantId,
    {
      ...data,
      channelCommissionPercent: channel ? Number(channel.commission_percent) : null,
      ...customer,
      outletId,
      newGuest,
      withToken,
      businessDayId: day.id,
      orderPrefix: settings.order_prefix,
      tableId: data.orderType === "dine_in" ? data.tableId : null,
      items: lines,
      totals,
    },
    userId
  );

  await syncKitchen(restaurantId, order.id);

  return {
    ...(await getById(restaurantId, order.id)),
    guestAdded: order.guest_added || null,
    guestNotice: order.guest_notice || null,
  };
};

// A dine-in order with nothing on it yet: a party seated from a booking or
// the waiting list. The table turns Running on the floor plan and shows in
// the POS, where the waiter adds dishes. Takes the table's row lock, so it
// cannot open a table another till has just opened. Every check a till's
// order gets applies: the table, its floor and its section must be in
// service, it must be the outlet's own table, and the order goes on that
// outlet's business day with that outlet's settings.
const openTable = async (restaurantId, input, userId) => {
  requireRestaurantId(restaurantId);

  const table = await validateTable(restaurantId, "dine_in", input.tableId);

  await refuseOtherOutletTable(restaurantId, table, input.outletId);

  const outletId = input.outletId || table.outlet_id || null;
  const day = await requireOpenBusinessDay(restaurantId, outletId);
  const customer = await resolveCustomer(restaurantId, input);
  const settings = await restaurantRepository.findSettings(restaurantId, outletId);

  const order = await orderRepository.create(
    restaurantId,
    {
      outletId,
      businessDayId: day.id,
      orderPrefix: settings.order_prefix,
      orderType: "dine_in",
      source: input.source || "pos",
      tableId: table.id,
      ...customer,
      guestCount: input.guestCount || null,
      notes: input.notes ? String(input.notes).slice(0, 500) : null,
      items: [],
      totals: { subtotal: 0, taxAmount: 0, totalAmount: 0 },
    },
    userId
  );

  return toOrder(order);
};

// The open business day an order at this outlet goes on, or why there is
// none. For callers that must know before they commit to anything (seating
// a party claims the booking and the table first).
const dayFor = (restaurantId, outletId) => requireOpenBusinessDay(restaurantId, outletId || null);

// ------------------------------------------------------------------ token collection

// What the collection screen by the counter shows: the day's token numbers
// still being made, and those ready to pick up — nothing else (no prices, no
// names, no mobiles). A token leaves "Ready" when staff mark it collected, or
// by itself this many minutes after it was ready. Staff who take orders also
// get each token's order id, to mark it collected; a display screen does not.
const collectionBoard = async (restaurantId, outletId, { staff = false } = {}) => {
  requireRestaurantId(restaurantId);

  const [day, service, restaurant] = await Promise.all([
    businessDayRepository.findOpen(restaurantId, outletId || null),
    serviceSettingsRepository.find(restaurantId),
    restaurantRepository.findById(restaurantId),
  ]);
  const outlet = outletId ? await outletRepository.findById(restaurantId, outletId) : null;
  const clearMinutes = Number(service.collection_clear_minutes);
  const base = {
    serverTime: new Date().toISOString(),
    restaurantName: restaurant ? restaurant.name : null,
    outletName: outlet ? outlet.name : null,
    tokensEnabled: Boolean(service.tokens_enabled),
    clearMinutes,
    businessDate: day ? day.business_date : null,
    preparing: [],
    ready: [],
  };

  if (!day) {
    return base;
  }

  const rows = await orderRepository.findCollectionTokens(restaurantId, day.id);
  const now = Date.now();
  const shown = (row) => ({ token: Number(row.token_no), ...(staff ? { orderId: row.id } : {}) });

  return {
    ...base,
    preparing: rows
      .filter((row) => ["pending", "preparing"].includes(row.kitchen_status))
      .map((row) => ({ ...shown(row), since: row.placed_at })),
    ready: rows
      .filter(
        (row) =>
          row.kitchen_status === "ready" && now - new Date(row.ready_at).getTime() < clearMinutes * 60000
      )
      .sort((a, b) => new Date(b.ready_at) - new Date(a.ready_at))
      .map((row) => ({ ...shown(row), readyAt: row.ready_at })),
  };
};

// Waives a delivery's charge (a regular, a late delivery, a wrong order) or
// charges it again. Only while the order is open: once billed, the bill is
// what changes. The reason is kept on the order and in the activity log.
const setDeliveryChargeWaived = async (restaurantId, id, { waived, reason }, userId) => {
  requireRestaurantId(restaurantId);

  const order = await orderRepository.findById(restaurantId, id);

  if (!order) {
    throw new AppError(404, "Order not found");
  }

  if (order.order_type !== "delivery") {
    throw new AppError(400, `${order.order_number} is not a delivery, so it has no delivery charge.`);
  }

  if (order.order_status !== "open") {
    throw new AppError(
      409,
      `${order.order_number} is already ${order.order_status === "billed" ? "billed" : order.order_status}. ` +
        "Change the delivery charge on its bill instead."
    );
  }

  if (waived && order.delivery_charge_waived_at) {
    throw new AppError(409, `The delivery charge on ${order.order_number} is already waived.`);
  }

  const before = Number(order.delivery_charge || 0);
  const pool = require("../../../../config/database");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await deliveryChargeRepository.setWaived(client, restaurantId, id, { waived, reason: waived ? reason : null }, userId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { order: await getById(restaurantId, id), before };
};

const markCollected = async (restaurantId, id, userId) => {
  requireRestaurantId(restaurantId);

  const row = await orderRepository.markCollected(restaurantId, id, userId);

  if (!row) {
    const order = await orderRepository.findById(restaurantId, id);

    if (!order) {
      throw new AppError(404, "Order not found");
    }

    throw new AppError(
      409,
      order.token_no ? `Token ${order.token_no} was already collected.` : `${order.order_number} has no token to collect.`
    );
  }

  return { id: row.id, orderNumber: row.order_number, tokenNo: Number(row.token_no) };
};

// ------------------------------------------------------------------ changing an order

// A line's money for a new quantity, at the line's own price. Whether the
// price included tax is read from the line itself, so a later change to the
// restaurant's tax setting cannot re-price what is already on the order.
const lineMoney = (line, quantity) => {
  const unit = round2(Number(line.unit_price) + Number(line.modifier_total));
  const base = round2(unit * quantity);
  const percentage = Number(line.tax_percentage);
  const inclusive = line.price_includes_tax ?? (
    percentage > 0 &&
    Math.abs(Number(line.line_total) - round2(unit * Number(line.quantity))) < 0.005);
  const split = splitTax(base, percentage, inclusive ? "inclusive" : "exclusive");

  return { lineSubtotal: split.net, lineTax: split.tax, lineTotal: round2(split.net + split.tax) };
};

const dishName = (line) => `${line.item_name}${line.variant_name ? ` (${line.variant_name})` : ""}`;

const qtyText = (quantity) => String(round2(quantity));

// Taking `newQuantity` of a line off. What the kitchen has not been sent comes
// off first and freely; only what it already has counts as a cancellation
// after KOT. A quantity already on a bill that still stands cannot come off.
const planReduction = ({ line, newQuantity, source, reasonCode, reasonNote, stageOfCancel }) => {
  const quantity = Number(line.quantity);
  const removed = round2(quantity - newQuantity);
  const billed = Number(line.billed_quantity || 0);

  if (billed > newQuantity + 0.0001) {
    throw new AppError(
      409,
      `${qtyText(billed)} × "${dishName(line)}" is already on a bill. Void that bill in Bills before taking it off.`,
      { reason: "already_billed", itemId: line.id }
    );
  }

  const unsent = round2(Math.max(quantity - Number(line.kitchen_quantity || 0), 0));
  const free = round2(Math.min(removed, unsent));
  const afterKot = round2(removed - free);
  const money = newQuantity > 0 ? lineMoney(line, newQuantity) : null;
  const removedAmount = round2(Number(line.line_total) - (money ? money.lineTotal : 0));
  const afterKotAmount = afterKot > 0 ? round2((removedAmount * afterKot) / removed) : 0;
  const freeAmount = round2(removedAmount - afterKotAmount);
  const unitPrice = round2(Number(line.unit_price) + Number(line.modifier_total));
  const base = {
    orderItemId: line.id,
    productId: line.product_id,
    itemName: line.item_name,
    variantName: line.variant_name,
    modifiersLabel: (line.modifiers || []).map((modifier) => modifier.name).join(", ") || null,
    unitPrice,
    source,
  };
  const rows = [];

  if (afterKot > 0) {
    const cancellation = stageOfCancel(line.line_key, afterKot);
    rows.push({
      ...base,
      quantity: afterKot,
      amount: afterKotAmount,
      afterKot: true,
      kitchenStage: cancellation.stage || line.kitchen_stage || null,
      cookedQuantity: cancellation.cookedQuantity,
      reasonCode,
      reasonNote,
    });
  }

  if (free > 0) {
    rows.push({
      ...base,
      quantity: free,
      amount: freeAmount,
      afterKot: false,
      kitchenStage: null,
      reasonCode: reasonCode || null,
      reasonNote: reasonCode ? reasonNote : null,
    });
  }

  return {
    update: newQuantity > 0 ? { id: line.id, quantity: newQuantity, ...money } : null,
    cancelId: newQuantity > 0 ? null : line.id,
    rows,
    afterKot,
    afterKotAmount,
  };
};

// What a manager approves when dishes the kitchen has are taken off, as the
// facts the approval is tied to (approval.service SCOPE_FIELDS): this order,
// at most this many plates, worth at most this much and, when it is one dish
// (or one dish in several rounds), that dish. The PIN prompt shows these same
// facts, so a manager who approved "Take off 1 × Tikka" has not approved two
// tikkas and three lassis.
const approvalScope = (orderId, dishes) => {
  const scope = {
    orderId: Number(orderId),
    quantity: round2(dishes.reduce((sum, dish) => sum + dish.quantity, 0)),
    amount: round2(dishes.reduce((sum, dish) => sum + dish.amount, 0)),
  };

  if (dishes.length === 1) {
    scope.orderItemId = Number(dishes[0].itemId);
  } else if (new Set(dishes.map((dish) => Number(dish.productId))).size === 1) {
    scope.productId = Number(dishes[0].productId);
  }

  return scope;
};

// The approval service checks each fact of this request against the
// approval. Two more checks it cannot make, returned as the reason the
// approval does not cover this change (null when it does):
//   - an approval given for one dish carries that dish, and a save that
//     takes off other dishes as well is not covered by it, even when the
//     plates and the money add up to no more;
//   - an approval that names no dish was given for cancelling the whole
//     order ("Cancel ORD-0412, which the kitchen already has") and covers
//     that and nothing else: not taking some dishes off an order that stays
//     open.
const notCoveredBy = (approval, dishes, wholeOrder) => {
  const approved = approval && approval.scope;

  if (!approved) {
    return null;
  }

  if (!approved.orderItemId && !approved.productId) {
    return wholeOrder
      ? null
      : "That approval was for cancelling the whole order, not for taking dishes off it. Ask the manager to approve this dish.";
  }

  const other = approved.orderItemId
    ? dishes.some((dish) => Number(dish.itemId) !== Number(approved.orderItemId))
    : dishes.some((dish) => Number(dish.productId) !== Number(approved.productId));

  return other
    ? "That approval was for one dish only, and this change takes off others as well. Ask the manager to approve again."
    : null;
};

// A dish the kitchen already has comes off only with a reason and with
// someone allowed to: the person doing it (orders.cancel_after_kot) or a
// manager standing next to them (PIN). `gate(scope)` is that check, supplied
// by the controller; it returns the approval (with the approving manager), or
// null when none was needed. `gate.holds` says whether the person may do it
// themselves. The gate is called last, once everything else about the change
// has been checked, because a manager's approval is spent the moment it is
// used.
//
// A manager approves one dish at a time, by name: "Take off 1 × Paneer Tikka
// on ORD-0412", which is what the PIN prompt shows and what the approval is
// tied to. A change that takes several different dishes off at once, by
// someone who needs a manager, is refused before anyone is asked, naming the
// dishes: the POS saves each dish with its own approval. The one exception is
// cancelling the whole order (options.wholeOrder), approved as the order.
const authoriseCancellation = async (reductions, reasonCode, reasonNote, gate, orderId, options = {}) => {
  const afterKot = reductions.filter((reduction) => reduction.afterKot > 0);

  if (afterKot.length === 0) {
    return null;
  }

  const dishes = afterKot.map((reduction) => {
    const row = reduction.rows.find((one) => one.afterKot);

    return {
      itemId: row.orderItemId,
      productId: row.productId,
      itemName: row.itemName,
      variantName: row.variantName,
      quantity: row.quantity,
      amount: row.amount,
      kitchenStage: row.kitchenStage,
    };
  });

  if (!reasonCode) {
    const names = dishes.map((dish) => `${qtyText(dish.quantity)} × ${dish.itemName}`).join(", ");

    throw new AppError(
      400,
      `The kitchen already has ${names}. Choose why ${dishes.length === 1 ? "it is" : "they are"} being taken off.`,
      { reason: "cancel_reason_required", dishes, reasons: CANCEL_REASONS }
    );
  }

  if (reasonCode === "other" && !reasonNote) {
    throw new AppError(400, "Write a short note when the reason is Other", {
      reason: "cancel_note_required",
      dishes,
    });
  }

  // No gate means the call came from the server's own code (a seed script, a
  // module finishing its own work), not from a person at a till.
  if (!gate) {
    return null;
  }

  const scope = approvalScope(orderId, dishes);
  const wholeOrder = Boolean(options.wholeOrder);

  if (!wholeOrder && !gate.holds && !scope.orderItemId && !scope.productId) {
    const names = dishes
      .map((dish) => `${qtyText(dish.quantity)} × ${dish.itemName}${dish.variantName ? ` (${dish.variantName})` : ""}`)
      .join(", ");

    throw new AppError(
      403,
      `A manager approves one dish at a time. Take these off one dish at a time, each with its own approval: ${names}. Nothing was changed.`,
      { reason: "approval_per_dish", permission: "orders.cancel_after_kot", dishes }
    );
  }

  const approval = await gate(scope);
  const problem = notCoveredBy(approval, dishes, wholeOrder);

  if (problem) {
    throw new AppError(403, problem, {
      reason: "approval_invalid",
      permission: "orders.cancel_after_kot",
      action: "take off a dish the kitchen already has",
      scope,
    });
  }

  return approval ? approval.approverId : null;
};

// A manager's approval token is redeemed by the approval service, on a
// connection of its own. Redeeming it while the order's transaction holds a
// connection is the hold-and-wait that hung the whole server in a rush (see
// order.repository create): a dozen captains saving approved changes at once
// held every connection, each waiting for one more. So a change that comes
// with a manager's token is planned in two passes:
//   1. under the order's lock, with a stand-in for the approval check. When
//      the plan reaches the approval, the stand-in notes what the manager is
//      asked to approve (the scope) and stops it. The transaction is rolled
//      back having written nothing, and its connection is given back.
//   2. the token is redeemed for that scope, with no connection held.
//   3. the change is planned again under the lock, with the approval in hand.
//      If the order changed in between so that the change would now take off
//      something else (the kitchen cut another round, another till took a
//      dish off), the approval does not cover it: nothing is changed and the
//      manager is asked again, for what the order now shows.
// Someone who may take dishes off themselves, and a request with no token
// (refused with "a manager's approval is needed", which reads nothing), go
// through the real check in one pass.
class ApprovalPending extends Error {}

// Whether what the change takes off now is still what the manager approved:
// the same order and dish, and no more plates or money (less is fine, as
// the approval service itself allows).
const UP_TO = ["quantity", "amount"];

const stillCovered = (now, approved) => {
  const keys = Object.keys(now || {}).sort();

  if (keys.join(",") !== Object.keys(approved || {}).sort().join(",")) {
    return false;
  }

  return keys.every((key) =>
    UP_TO.includes(key) ? Number(now[key]) <= Number(approved[key]) : Number(now[key]) === Number(approved[key])
  );
};

const approvalOutsideLock = async (gate, run) => {
  if (!gate || gate.holds || !gate.hasToken) {
    return run(gate);
  }

  let asked = null;
  let redeemed = false;
  let approval = null;

  const standIn = async (scope) => {
    if (!redeemed) {
      asked = scope;
      throw new ApprovalPending("The manager's approval is redeemed outside the order's lock");
    }

    if (!stillCovered(scope, asked)) {
      throw new AppError(
        403,
        "The order changed while the manager was approving, so that approval no longer covers this change. Nothing was changed. Ask the manager to approve what the order shows now.",
        {
          reason: "approval_invalid",
          permission: "orders.cancel_after_kot",
          action: "take off a dish the kitchen already has",
          scope,
        }
      );
    }

    return approval;
  };

  standIn.holds = false;
  standIn.hasToken = true;

  try {
    return await run(standIn);
  } catch (error) {
    if (!(error instanceof ApprovalPending)) {
      throw error;
    }
  }

  approval = await gate(asked);
  redeemed = true;

  return run(standIn);
};

// The reason written on a cancellation. A person always gives one (the
// controller passes a gate and authoriseCancellation insists); the server's
// own code may not, and the record still says so plainly.
const SYSTEM_REASON = { code: "other", note: "Changed by the system, no reason given" };

const reasonFor = (request, gate) =>
  !gate && !request.cancelReason
    ? SYSTEM_REASON
    : { code: request.cancelReason || null, note: request.cancelNote || null };

// The header fields of an edit. The POS sends them under `header`, only the
// ones it means to change. Older callers (the seed scripts, other modules)
// pass them at the top level, and there every one of them is set, as before.
const headerOf = (data) => {
  if (data.header) {
    return data.header;
  }

  const has = (key) => Object.prototype.hasOwnProperty.call(data, key);
  const header = {};

  if (has("notes")) {
    header.notes = data.notes || null;
  }

  if (has("guestCount")) {
    header.guestCount = data.guestCount || null;
  }

  if (has("customerId") || has("customerName") || has("customerMobile")) {
    header.customer = {
      customerId: data.customerId || null,
      customerName: data.customerName || null,
      customerMobile: data.customerMobile || null,
    };
  }

  return header;
};

const guestText = (guest) =>
  guest.name ? `${guest.name}${guest.mobile ? ` (${guest.mobile})` : ""}` : guest.mobile || "nobody";

// The order's own details are worked from two places at once as often as its
// dishes are: the counter writes "No onion" while the captain's tablet seats
// two more. A screen sends, with each detail it changes, what it showed for
// that detail (`seen`). When another device has changed that same detail
// since, nothing is saved and the waiter is told what it says now, rather
// than one device quietly wiping what the other wrote. A detail the screen
// did not change is never sent, so it is never compared. Both devices setting
// the same thing is no clash.
const checkHeaderSeen = (order, header, changes, seen) => {
  if (!seen) {
    return;
  }

  const clash = (what, now) =>
    new AppError(
      409,
      `${what} on ${order.order_number} was changed on another device after this screen opened it: ${now}. Nothing was saved. Check it and save again.`,
      { reason: "order_changed", field: what }
    );

  if (changes.notes !== undefined && seen.notes !== undefined) {
    const now = order.notes || "";

    if (now !== (seen.notes || "") && now !== (changes.notes || "")) {
      throw clash("The note", now ? `it now reads "${now}"` : "it was cleared");
    }
  }

  if (changes.guestCount !== undefined && seen.guestCount !== undefined) {
    const now = Number(order.guest_count || 0);

    if (now !== Number(seen.guestCount || 0) && now !== Number(changes.guestCount || 0)) {
      throw clash("The number of guests", now ? `it is ${now} now` : "it was cleared");
    }
  }

  if (header.customer && seen.customer) {
    const guestOf = (id, name, mobile) => ({ id: Number(id || 0), name: name || "", mobile: mobile || "" });
    const same = (a, b) => a.id === b.id && a.name === b.name && a.mobile === b.mobile;
    // An order linked to a guest with no name of its own shows the guest
    // book's name, and that is what a screen saw.
    const now = guestOf(order.customer_id, order.customer_name || order.linked_customer_name, order.customer_mobile);
    const saw = guestOf(seen.customer.customerId, seen.customer.customerName, seen.customer.customerMobile);
    const wanted = guestOf(changes.customerId, changes.customerName, changes.customerMobile);

    if (!same(now, saw) && !same(now, wanted)) {
      throw clash("The guest", `it is ${guestText(now)} now`);
    }
  }
};

// The header fields the request actually sent. A field left out is left as it
// is; one sent empty is cleared.
const readHeaderChanges = async (restaurantId, header = {}) => {
  const changes = {};

  if (header.notes !== undefined) {
    changes.notes = header.notes;
  }

  if (header.guestCount !== undefined) {
    changes.guestCount = header.guestCount;
  }

  if (header.customer) {
    Object.assign(changes, await resolveCustomer(restaurantId, header.customer));
  }

  return changes;
};

// More of a dish already on the order, ordered exactly the same way: a new
// line at today's price, which is a new round (a new KOT) for the kitchen.
const moreOf = (line, quantity) => ({
  productId: line.product_id,
  productVariantId: line.product_variant_id,
  modifierIds: lineModifierIds(line),
  comboSelections: (line.combo_parts || []).filter(part => part.groupId),
  courseNo: line.course_no || 1,
  courseName: line.course_name,
  holdCourse: line.fire_status === 'held',
  quantity: round2(quantity),
  notes: line.notes,
});

// A line another device changed after this screen read the order. Nothing is
// saved: the screen reloads the order and the waiter looks again, rather than
// either device quietly undoing the other.
const changedElsewhere = (order, line, seen, now) =>
  new AppError(
    409,
    `${dishName(line)} on ${order.order_number} was changed on another device after this screen opened it: it is ${qtyText(now)} now, not ${qtyText(seen)}. Nothing was saved. Check the order and make your change again.`,
    { reason: "order_changed", itemId: line.id, quantity: now }
  );

// Works out what an edit changes, line by line.
//
// The POS sends only what the waiter changed (changesOnly):
//   { id, quantity, seenQuantity }  a line already on the order: how many are
//                                   wanted now, and how many the screen showed
//                                   when the waiter changed it (0 takes it off)
//   { productId, ... }              a new dish, always a line of its own
// A line the request does not name is left exactly as it is. A table is
// often worked from two places at once (a captain's tablet and the counter, a
// guest's QR order accepted at the pass); each adds its own dishes without
// touching the other's. A line one device changed after the other read the
// order is never overwritten: its seenQuantity no longer matches, and the
// edit is refused with the dish named. That is what stops a screen opened
// before a manager took two burnt naan off from quietly putting them back,
// and a screen that never saw the dal another till added from taking it off.
//
// Older callers (seed scripts, other modules) send the whole cart instead, no
// ids and no changesOnly. Each dish is matched to the live lines of the same
// dish ordered the same way, and a live line the cart leaves out comes off.
//
// Either way an existing line keeps its price (a happy-hour drink stays at the
// happy-hour price when dessert is added after the window closes), its
// kitchen status and its time; a dish that has since sold out does not stop
// the table ordering anything else; and a cancelled line is never brought
// back. More of a dish already on the order is a NEW line at today's price: a
// new round for the kitchen, with its own KOT.
//
// `header` is the request's header already read (readHeaderChanges, done by
// the caller before the order is locked), and `db` the edit's own connection:
// everything the plan reads under the lock goes through it.
const planEdit = async ({ restaurantId, order, items, request, settings, stageOfCancel, gate, db, header }) => {
  // Saving dishes never moves the party. A screen that sends another table
  // with a save (the POS before this release kept its table picker live while
  // editing) is told how a move is made, instead of the table being quietly
  // ignored while the waiter believes the guests were moved.
  if (request.tableId && Number(request.tableId) !== Number(order.table_id)) {
    throw new AppError(
      409,
      `Saving dishes does not move ${order.order_number} to another table. Use Move table to move the party, or Move dishes for some of the food.`,
      { reason: "use_move_table" }
    );
  }

  const reason = reasonFor(request, gate);
  const live = items.filter((item) => item.item_status !== "cancelled");
  const cancelledById = new Map(
    items.filter((item) => item.item_status === "cancelled").map((item) => [Number(item.id), item])
  );
  const byId = new Map(live.map((line) => [Number(line.id), line]));
  // liveOnly is what callers of the previous release call changesOnly.
  const wholeCart =
    !request.changesOnly && !request.liveOnly && request.items.every((item) => !item.id);
  const targets = new Map();
  const named = new Set();
  const additions = [];
  const fresh = [];

  for (const item of request.items) {
    if (!item.id) {
      fresh.push(item);
      continue;
    }

    const id = Number(item.id);
    const wanted = round2(item.quantity);
    const seen =
      item.seenQuantity === undefined || item.seenQuantity === null ? null : round2(item.seenQuantity);

    // Taken off already: whatever the screen still thinks, it stays off. A
    // screen that wanted some of it kept, though, is told, not ignored.
    if (cancelledById.has(id)) {
      if (seen !== null && wanted !== seen && wanted > 0) {
        throw changedElsewhere(order, cancelledById.get(id), seen, 0);
      }

      continue;
    }

    const line = byId.get(id);

    if (!line) {
      throw new AppError(
        409,
        "This order changed while you had it open. Open it again from Still running and redo your change.",
        { reason: "stale_order" }
      );
    }

    if (named.has(id)) {
      throw new AppError(400, `"${dishName(line)}" is listed twice`);
    }

    named.add(id);

    const now = round2(line.quantity);

    if (seen !== null && wanted === seen) {
      // The screen did not touch this line, whatever has happened to it since.
      continue;
    }

    if (seen !== null && seen !== now) {
      throw changedElsewhere(order, line, seen, now);
    }

    // Without seenQuantity, asking for more than the line has is either a
    // screen that missed a cancellation or a caller wanting more. The first
    // would send cancelled food back to the kitchen, so neither is guessed.
    if (seen === null && wanted > now) {
      throw new AppError(
        409,
        `${order.order_number} has ${qtyText(now)} × ${dishName(line)}, not ${qtyText(wanted)}. If this screen is out of date, open the order again. More of a dish already on the order goes on as a new dish.`,
        { reason: "order_changed", itemId: line.id, quantity: now }
      );
    }

    if (wanted > now) {
      additions.push(moreOf(line, wanted - now));
    } else if (wanted < now) {
      targets.set(id, wanted);
    }
  }

  if (wholeCart) {
    for (const group of mergeRequested(fresh)) {
      const same = live
        .filter((line) => lineKey(line) === group.key)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
      const onOrder = round2(same.reduce((sum, line) => sum + Number(line.quantity), 0));

      // Keep the oldest lines first, so a smaller number takes off the newest.
      let keep = Math.min(group.quantity, onOrder);

      for (const line of same) {
        const take = round2(Math.min(Number(line.quantity), keep));
        targets.set(Number(line.id), take);
        keep = round2(keep - take);
      }

      if (group.quantity > onOrder) {
        additions.push({ ...group, quantity: round2(group.quantity - onOrder) });
      }
    }

    // The whole cart is the order as the caller wants it: a live dish it
    // leaves out comes off.
    for (const line of live) {
      if (!targets.has(Number(line.id))) {
        targets.set(Number(line.id), 0);
      }
    }
  } else {
    additions.push(...fresh);
  }

  const reductions = [];

  for (const line of live) {
    const target = targets.get(Number(line.id));

    if (target !== undefined && target < Number(line.quantity)) {
      reductions.push(
        planReduction({
          line,
          newQuantity: target,
          source: "edit",
          reasonCode: reason.code,
          reasonNote: reason.note,
          stageOfCancel,
        })
      );
    }
  }

  const priced =
    additions.length > 0
      ? await priceLines(restaurantId, additions, settings.tax_mode, settings.timezone, {
          outletId: order.outlet_id,
          orderType: order.order_type, channelId: order.channel_id,
          db, billOfSupply: settings.document_type === "bill_of_supply",
        })
      : { lines: [] };
  // Checked (a detail another device changed meanwhile) before any approval
  // is asked for, since an approval is spent the moment it is used. A guest
  // who does not exist was refused before the order was even locked.
  checkHeaderSeen(order, headerOf(request), header, request.seen || null);

  const approvedBy = await authoriseCancellation(reductions, reason.code, reason.note, gate, order.id);

  const rows = reductions.flatMap((reduction) => reduction.rows);

  return {
    changes: {
      updates: reductions.map((reduction) => reduction.update).filter(Boolean),
      cancelIds: reductions.map((reduction) => reduction.cancelId).filter(Boolean),
      inserts: priced.lines,
      cancellations: rows,
      header,
      approvedBy,
    },
    summary: {
      added: priced.lines.map((line) => ({
        itemName: line.itemName,
        variantName: line.variantName,
        quantity: line.quantity,
        lineTotal: line.lineTotal,
      })),
      cancelled: rows.map((row) => ({
        orderItemId: row.orderItemId,
        itemName: row.itemName,
        variantName: row.variantName,
        quantity: row.quantity,
        amount: row.amount,
        afterKot: row.afterKot,
        kitchenStage: row.kitchenStage,
        reasonCode: row.reasonCode,
        reason: reasonLabel(row.reasonCode),
        note: row.reasonNote,
        source: row.source,
      })),
      approvedBy,
    },
  };
};

// Saves a change to a running order: only what changed is written.
//
//   data = { items, changesOnly, header, seen, cancelReason, cancelNote }
//          seen: what the screen showed of each detail in header (checkHeaderSeen)
//   options.gate  the manager-approval check for dishes the kitchen has
const updateItems = async (restaurantId, id, data, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const settings = await restaurantRepository.findSettings(restaurantId);
  let summary = null;
  let newGuest = null;

  // A mobile typed at the till with no guest picked finds (or adds) the
  // guest, exactly as on a new order. Looked up before the order is locked,
  // so the lookup never holds up the table; a new guest is written inside
  // the edit's own transaction (editOrder), so a refused edit adds nobody.
  const typed = data.header && data.header.customer;

  if (data.linkGuest && typed && !typed.customerId && typed.customerMobile) {
    const resolved = await guestFromMobile(restaurantId, typed);

    newGuest = resolved.newGuest;
    data = {
      ...data,
      header: {
        ...data.header,
        customer: {
          customerId: resolved.customerId,
          customerName: resolved.customerName,
          customerMobile: resolved.customerMobile,
        },
      },
    };
  }

  // The header's guest is read now, before the order is locked (a guest
  // who does not exist is refused here), so the lock is never held while
  // the guest book is read on a second connection.
  const header = await readHeaderChanges(restaurantId, headerOf(data));

  const result = await approvalOutsideLock(options.gate, (gate) =>
    orderRepository.editOrder(
      restaurantId,
      id,
      async ({ order, items, stageOfCancel, db }) => {
        const planned = await planEdit({
          restaurantId,
          order,
          items,
          request: data,
          settings,
          stageOfCancel,
          gate,
          db,
          header,
        });

        summary = planned.summary;
        return newGuest ? { ...planned.changes, newGuest } : planned.changes;
      },
      userId
    )
  );

  if (result.error) {
    throw notOpen(result);
  }

  await syncKitchen(restaurantId, id);

  return {
    ...(await getById(restaurantId, id)),
    changes: summary,
    guestAdded: result.guestAdded || null,
    guestNotice: result.guestNotice || null,
  };
};

// Adds dishes to a running order and leaves every line it already has exactly
// as it is. Used by QR table requests: the new lines are priced now (at the
// order's own outlet), under the order's lock, and the kitchen is told at once.
//
//   items    [{ productId, productVariantId, modifierIds, quantity, notes }]
//   options  { note, customerName, customerMobile } — the note is added under
//            the order's own notes; name and mobile only fill a blank
//
// Returns the order, with `addedItems` listing the new lines in the order
// they were given ({ id, productId, productVariantId, quantity }).
const appendItems = async (restaurantId, orderId, items, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, "Add at least one item to the order");
  }

  const settings = await restaurantRepository.findSettings(restaurantId);
  let added = [];

  const result = await orderRepository.editOrder(
    restaurantId,
    orderId,
    async ({ order, db }) => {
      const priced = await priceLines(restaurantId, items, settings.tax_mode, settings.timezone, {
        outletId: order.outlet_id,
        orderType: order.order_type, channelId: order.channel_id,
        db, billOfSupply: settings.document_type === "bill_of_supply",
      });
      added = priced.lines;

      const header = {};

      if (options.note) {
        header.notes = order.notes ? `${order.notes}\n${options.note}` : options.note;
      }

      if (options.customerName && !order.customer_name) {
        header.customerName = options.customerName;
      }

      if (options.customerMobile && !order.customer_mobile) {
        header.customerMobile = options.customerMobile;
      }

      return { inserts: priced.lines, header };
    },
    userId
  );

  if (result.error) {
    throw notOpen(result);
  }

  await syncKitchen(restaurantId, orderId);

  return {
    ...(await getById(restaurantId, orderId)),
    addedItems: result.insertedIds.map((id, index) => ({
      id,
      productId: added[index].productId,
      productVariantId: added[index].productVariantId || null,
      quantity: Number(added[index].quantity),
    })),
  };
};

// Takes all or part of one line off (the Remove button on the Orders
// screen). input = { quantity (null = the whole line), reasonCode, note }.
const cancelItem = async (restaurantId, orderId, itemId, input, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  let summary = null;

  // `gate` is the approval check, or its stand-in (approvalOutsideLock).
  const plan = (gate) => async ({ items, stageOfCancel }) => {
    const line = items.find((item) => Number(item.id) === Number(itemId));

    if (!line) {
      throw new AppError(404, "That item is not on this order");
    }

    if (line.item_status === "cancelled") {
      throw new AppError(409, `"${dishName(line)}" is already cancelled`);
    }

    const quantity = Number(line.quantity);
    const take = input.quantity === null || input.quantity === undefined ? quantity : round2(input.quantity);

    if (take > quantity) {
      throw new AppError(400, `Only ${qtyText(quantity)} × "${dishName(line)}" is on the order`);
    }

    const reason = reasonFor({ cancelReason: input.reasonCode, cancelNote: input.note }, gate);
    const reduction = planReduction({
      line,
      newQuantity: round2(quantity - take),
      source: "item",
      reasonCode: reason.code,
      reasonNote: reason.note,
      stageOfCancel,
    });

    const approvedBy = await authoriseCancellation(
      [reduction],
      reason.code,
      reason.note,
      gate,
      orderId
    );

    summary = {
      cancelled: reduction.rows.map((row) => ({
        orderItemId: row.orderItemId,
        itemName: row.itemName,
        variantName: row.variantName,
        quantity: row.quantity,
        amount: row.amount,
        afterKot: row.afterKot,
        kitchenStage: row.kitchenStage,
        reasonCode: row.reasonCode,
        reason: reasonLabel(row.reasonCode),
        note: row.reasonNote,
        source: row.source,
      })),
      approvedBy,
    };

    return {
      updates: reduction.update ? [reduction.update] : [],
      cancelIds: reduction.cancelId ? [reduction.cancelId] : [],
      cancellations: reduction.rows,
      approvedBy,
    };
  };

  const result = await approvalOutsideLock(options.gate, (gate) =>
    orderRepository.editOrder(restaurantId, orderId, plan(gate), userId)
  );

  if (result.error) {
    throw notOpen(result);
  }

  await syncKitchen(restaurantId, orderId);

  return { ...(await getById(restaurantId, orderId)), changes: summary };
};

const setKitchenStatus = async (restaurantId, id, status, userId) => {
  requireRestaurantId(restaurantId);

  const updated = await orderRepository.setKitchenStatus(restaurantId, id, status, userId);

  if (!updated) {
    throw new AppError(404, "Order not found");
  }

  return getById(restaurantId, id);
};

// Cancels a whole open order. When the kitchen already had any of its food,
// that is the biggest cancellation after KOT there is, so it needs someone
// allowed to (or a manager's PIN), and every dish it had is recorded for the
// owner's report.
//
//   input  the reason as text, or { reason, reasonCode }
const cancel = async (restaurantId, id, input, userId, options = {}) => {
  requireRestaurantId(restaurantId);

  const reason = typeof input === "string" ? input : input.reason;
  const reasonCode = (typeof input === "object" && input.reasonCode) || "other";
  let summary = null;

  // `gate` is the approval check, or its stand-in (approvalOutsideLock).
  const plan = (gate) => async ({ items, stageOfCancel }) => {
    const reductions = items
      .filter((item) => item.item_status !== "cancelled")
      .map((line) =>
        planReduction({
          line,
          newQuantity: 0,
          source: "order",
          reasonCode,
          reasonNote: String(reason).slice(0, 200),
          stageOfCancel,
        })
      );

    const approvedBy = await authoriseCancellation(
      reductions,
      reasonCode,
      String(reason).slice(0, 200),
      gate,
      id,
      { wholeOrder: true }
    );
    const rows = reductions.flatMap((reduction) => reduction.rows);

    summary = {
      cancelled: rows
        .filter((row) => row.afterKot)
        .map((row) => ({
          itemName: row.itemName,
          variantName: row.variantName,
          quantity: row.quantity,
          amount: row.amount,
          kitchenStage: row.kitchenStage,
        })),
      approvedBy,
    };

    return { cancellations: rows, approvedBy };
  };

  const result = await approvalOutsideLock(options.gate, (gate) =>
    orderRepository.cancel(restaurantId, id, reason, userId, plan(gate))
  );

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Order not found");
  }

  if (result.error === "NOT_OPEN") {
    const message =
      result.status === "billed"
        ? "This order has a bill. Void the bill first."
        : `A ${result.status} order cannot be cancelled`;

    throw new AppError(409, message);
  }

  await syncKitchen(restaurantId, id);

  return { ...toOrder(result.order), changes: summary };
};


// ------------------------------------------------------------ moving guests and dishes

// The table a party or some dishes are moving to: it exists, it is in
// service, and a free one held for a booking is only taken on purpose
// (overrideHold), exactly as for a new order.
const tableForMove = async (restaurantId, tableId, overrideHold) => {
  const [row] = await tableRepository.findTables(restaurantId, { tableId });

  if (!row) {
    throw new AppError(404, "That table does not exist");
  }

  if (row.status !== "active") {
    throw new AppError(409, `Table ${row.table_no} is not in use`);
  }

  if (row.floor_status && row.floor_status !== "active") {
    throw new AppError(409, `Table ${row.table_no} is on a floor that is closed right now`);
  }

  if (row.area_status && row.area_status !== "active") {
    throw new AppError(409, `Table ${row.table_no} is in a section that is closed right now`);
  }

  const booking = overrideHold ? null : heldFor(row);

  if (booking) {
    throw tableHeld(booking);
  }

  return row;
};

// After a move the kitchen's tickets are settled for every order touched
// (statuses, anything not yet sent), and the orders are read back.
const afterMove = async (restaurantId, result) => {
  const ids = [...new Set([result.fromOrderId, result.toOrderId].filter(Boolean))];

  for (const id of ids) {
    await syncKitchen(restaurantId, id);
  }

  const order = await getById(restaurantId, result.toOrderId);
  const from =
    result.fromOrderId && Number(result.fromOrderId) !== Number(result.toOrderId)
      ? await getById(restaurantId, result.fromOrderId)
      : null;

  return { ...result, order, from };
};

// The whole party to a free table: { tableId, overrideHold }.
const moveTable = async (restaurantId, orderId, input, userId) => {
  requireRestaurantId(restaurantId);

  await tableForMove(restaurantId, input.tableId, input.overrideHold);

  return afterMove(restaurantId, await orderRepository.moveTable(restaurantId, orderId, input.tableId, userId));
};

// A second table for the same party: { tableId, overrideHold }. An order
// running on that table is joined into this one.
const joinTable = async (restaurantId, orderId, input, userId) => {
  requireRestaurantId(restaurantId);

  await tableForMove(restaurantId, input.tableId, input.overrideHold);

  return afterMove(restaurantId, await orderRepository.joinTable(restaurantId, orderId, input.tableId, userId));
};

const unjoinTable = async (restaurantId, orderId, input, userId) => {
  requireRestaurantId(restaurantId);

  const result = await orderRepository.unjoinTable(restaurantId, orderId, input.tableId, userId);

  return { ...result, order: await getById(restaurantId, orderId) };
};

// What a dish move takes, checked against the lines as they are under the
// lock: each line named once, still on the order, showing what the screen
// showed (seenQuantity), and no more of it than there is. A line moved in
// part is split at its own price; what moves is priced for its quantity,
// and what stays is the rest of the line's money, so the two orders add up
// to exactly what the one did.
const planDishMove = (source, items, input) => {
  const live = items.filter((item) => item.item_status !== "cancelled");
  const byId = new Map(live.map((line) => [Number(line.id), line]));
  const cancelled = new Map(
    items.filter((item) => item.item_status === "cancelled").map((item) => [Number(item.id), item])
  );
  const named = new Set();
  const moves = [];

  for (const wanted of input.items) {
    const id = Number(wanted.id);

    if (cancelled.has(id)) {
      throw new AppError(409, `"${dishName(cancelled.get(id))}" was taken off ${source.order_number}, so it cannot move.`, {
        reason: "order_changed",
        itemId: id,
      });
    }

    const line = byId.get(id);

    if (!line) {
      throw new AppError(
        409,
        "This order changed while you had it open. Open it again from Still running and redo the move.",
        { reason: "stale_order" }
      );
    }

    if (named.has(id)) {
      throw new AppError(400, `"${dishName(line)}" is listed twice`);
    }

    named.add(id);

    const now = round2(line.quantity);
    const seen =
      wanted.seenQuantity === undefined || wanted.seenQuantity === null ? null : round2(wanted.seenQuantity);

    if (seen !== null && seen !== now) {
      throw changedElsewhere(source, line, seen, now);
    }

    const quantity = round2(wanted.quantity);

    if (quantity > now) {
      throw new AppError(400, `Only ${qtyText(now)} × "${dishName(line)}" is on ${source.order_number}.`);
    }

    const whole = {
      lineSubtotal: round2(Number(line.line_subtotal)),
      lineTax: round2(Number(line.line_tax)),
      lineTotal: round2(Number(line.line_total)),
    };

    if (quantity === now) {
      moves.push({ line, quantity, keep: null, move: whole });
      continue;
    }

    const move = lineMoney(line, quantity);

    moves.push({
      line,
      quantity,
      move,
      keep: {
        lineSubtotal: round2(whole.lineSubtotal - move.lineSubtotal),
        lineTax: round2(whole.lineTax - move.lineTax),
        lineTotal: round2(whole.lineTotal - move.lineTotal),
      },
    });
  }

  if (moves.length === 0) {
    throw new AppError(400, "Choose at least one dish to move");
  }

  const everything = live.every((line) =>
    moves.some((move) => Number(move.line.id) === Number(line.id) && move.keep === null)
  );

  return { everything, moves, guests: input.guests || null };
};

// Chosen dishes to another table: { tableId, items: [{ id, quantity,
// seenQuantity }], guests, overrideHold }. Onto the order running there, or a
// new order when the table is free.
const moveDishes = async (restaurantId, orderId, input, userId) => {
  requireRestaurantId(restaurantId);

  await tableForMove(restaurantId, input.tableId, input.overrideHold);

  const settings = await restaurantRepository.findSettings(restaurantId);
  const result = await orderRepository.moveDishes(
    restaurantId,
    orderId,
    input.tableId,
    ({ source, items }) => planDishMove(source, items, input),
    userId,
    { orderPrefix: settings.order_prefix }
  );

  return afterMove(restaurantId, result);
};

const MOVE_WORDS = {
  table: "Moved table",
  join: "Joined a table",
  dishes: "Moved dishes",
  unjoin: "Unjoined a table",
};

// An order's history of moves, for the Orders screen.
const listMoves = async (restaurantId, orderId) => {
  requireRestaurantId(restaurantId);

  await getById(restaurantId, orderId);

  const rows = await orderRepository.findMoves(restaurantId, orderId);

  return rows.map((row) => ({
    id: row.id,
    type: row.move_type,
    label: MOVE_WORDS[row.move_type] || row.move_type,
    fromOrderId: row.from_order_id,
    fromOrderNumber: row.from_order_number || null,
    toOrderId: row.to_order_id,
    toOrderNumber: row.to_order_number || null,
    fromTableNo: row.from_table_no || null,
    toTableNo: row.to_table_no || null,
    items: row.items || [],
    amount: Number(row.amount),
    movedAt: row.created_at,
    movedByName: row.created_by_name || null,
  }));
};

// Every table joined to a party still at the restaurant (order open, or
// billed and not yet paid), for the till's room: those tables are part of
// that party, not free.
const listJoinedTables = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const rows = await orderRepository.findLiveJoins(restaurantId);

  return rows.map((row) => ({
    tableId: row.table_id,
    tableNo: row.table_no,
    orderId: row.order_id,
    orderNumber: row.order_number,
    orderStatus: row.order_status,
    mainTableNo: row.main_table_no || null,
  }));
};

// ------------------------------------------------------------------ the owner's report

const toCancellation = (row) => ({
  id: row.id,
  orderId: row.order_id,
  orderNumber: row.order_number,
  orderType: row.order_type,
  tableNo: row.table_no,
  orderItemId: row.order_item_id,
  itemName: row.item_name,
  variantName: row.variant_name,
  modifiers: row.modifiers_label,
  quantity: Number(row.quantity),
  unitPrice: Number(row.unit_price),
  amount: Number(row.amount),
  kitchenStage: row.kitchen_stage,
  reasonCode: row.reason_code,
  reason: reasonLabel(row.reason_code),
  note: row.reason_note,
  source: row.source,
  cancelledAt: row.created_at,
  businessDate: row.business_date,
  cancelledById: row.cancelled_by,
  cancelledByName: row.cancelled_by_name,
  approvedById: row.approved_by,
  approvedByName: row.approved_by_name,
});

// Dishes taken off after the kitchen had them, for a date range, by business
// day (a cancellation at 00:30 belongs to the day it happened in).
const cancellations = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  let { from, to } = filters;

  if (!from || !to) {
    const day = await businessDayRepository.findOpen(restaurantId);
    const today = day ? day.business_date : new Date().toISOString().slice(0, 10);

    from = from || today;
    to = to || today;
  }

  if (from > to) {
    throw new AppError(400, "The start date is after the end date");
  }

  const [found, staff] = await Promise.all([
    orderRepository.findCancellations(restaurantId, { ...filters, from, to }),
    orderRepository.findCancellingStaff(restaurantId),
  ]);

  return {
    from,
    to,
    items: found.rows.map(toCancellation),
    total: found.total,
    limit: filters.limit,
    offset: filters.offset || 0,
    summary: {
      entries: found.summary.entries,
      quantity: Number(found.summary.quantity),
      amount: Number(found.summary.amount),
      orders: found.summary.orders,
      servedFirst: found.summary.served_first,
      servedAmount: Number(found.summary.served_amount),
      approved: found.summary.approved,
    },
    byStaff: found.byStaff.map((row) => ({
      userId: row.user_id,
      name: row.name,
      entries: row.entries,
      quantity: Number(row.quantity),
      amount: Number(row.amount),
      servedFirst: row.served_first,
      approved: row.approved,
    })),
    byReason: found.byReason.map((row) => ({
      reasonCode: row.reason_code,
      reason: reasonLabel(row.reason_code),
      entries: row.entries,
      amount: Number(row.amount),
    })),
    staff: staff.map((row) => ({ id: row.id, name: row.name })),
    reasons: CANCEL_REASONS,
  };
};

const fireCourse = async (restaurantId, orderId, courseNo, userId) => {
  requireRestaurantId(restaurantId);
  const order = await orderRepository.findById(restaurantId, orderId);
  if (!order) throw new AppError(404, "Order not found");
  if (order.order_status !== "open") throw new AppError(409, "Only an open order can fire a course");
  const fired = await orderRepository.fireCourse(restaurantId, orderId, courseNo, userId);
  if (!fired) throw new AppError(409, `Course ${courseNo} is not being held`);
  await syncKitchen(restaurantId, orderId);
  return getById(restaurantId, orderId);
};

module.exports = {
  setDeliveryChargeWaived,
  collectionBoard,
  markCollected,
  CANCEL_REASONS,
  REASON_CODES,
  list,
  getById,
  offers,
  serviceDay,
  saleOutlets,
  fireCourse,
  create,
  openTable,
  updateItems,
  appendItems,
  cancelItem,
  setKitchenStatus,
  cancel,
  cancellations,
  priceLines,
  refuseOtherOutletTable,
  dayFor,
  lookupGuest,
  moveTable,
  joinTable,
  unjoinTable,
  moveDishes,
  listMoves,
  listJoinedTables,
  approvalOutsideLock,
};
