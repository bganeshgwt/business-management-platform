const sellingRules = require("../../menu/services/sellingRules.service");
const restaurantFeatures = require("../../setup/services/restaurantFeatures.service");
const tableRequestRepository = require("../repositories/tableRequest.repository");
const tableRepository = require("../../tables/repositories/table.repository");
const restaurantRepository = require("../../setup/repositories/restaurant.repository");
const crmRepository = require("../../crm/repositories/crm.repository");
const onlineOrderRepository = require("../../online/repositories/onlineOrder.repository");
const deliveryRepository = require("../../deliveries/repositories/delivery.repository");
const orderService = require("./order.service");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// A QR token is the 32 hex characters the Tables screen generates. Anything
// that could not be one is turned away before it costs a database read.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// How many order requests one table may have waiting for staff at once. Past
// this the guest is asked to wait: it stops a stuck phone (or a bored child)
// burying the inbox, and three unanswered orders means the floor needs a nudge,
// not a fourth card.
const MAX_WAITING_ORDERS = 3;

const TABLE_NOT_FOUND =
  "We couldn't find this table. The QR code may be out of date — please ask a member of staff for help.";

const CALL_LABELS = {
  call_waiter: "a waiter",
  bill: "the bill",
  water: "water",
  other: "help",
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

// ---------------------------------------------------------------- the table behind a QR code

// An unknown token, a table taken out of use, a floor or a section closed for
// the season and a suspended restaurant all look the same to a guest: this
// code does not work, please ask someone. Which one it was is none of the
// public's business. A section counts like a floor: staff cannot accept an
// order from a closed section (the order service refuses the table), so the
// guest must not be able to send one and wait for nothing.
const resolveTable = async (token) => {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new AppError(404, TABLE_NOT_FOUND);
  }

  const table = await tableRequestRepository.findTableByToken(token);

  if (
    !table ||
    table.status !== "active" ||
    table.floor_status !== "active" ||
    (table.area_status && table.area_status !== "active") ||
    table.restaurant_status !== "active"
  ) {
    throw new AppError(404, TABLE_NOT_FOUND);
  }

  // QR table ordering switched off (Settings -> Features): the code no longer
  // takes orders or calls.
  table.features = await restaurantFeatures.assertRestaurantHas(
    table.restaurant_id,
    "qr_ordering",
    "Ordering from the table is not available here at the moment. Please ask a member of staff."
  );

  return table;
};

// ---------------------------------------------------------------- the guest's menu

// The timed price for this exact dish/size: higher priority, then the
// matching outlet, then the newer window — the same
// order the order service settles it in, so the menu never promises a price
// the bill will not honour.
const bestOffer = (offers, variantId) => {
  const candidates = offers.filter(
    (offer) =>
      (variantId === null ? offer.product_variant_id === null : Number(offer.product_variant_id) === Number(variantId))
  );

  candidates.sort(
    (a, b) =>
      Number(b.product_variant_id !== null) - Number(a.product_variant_id !== null) ||
      b.priority - a.priority ||
      Number(Boolean(b.outlet_id)) - Number(Boolean(a.outlet_id)) ||
      b.window_id - a.window_id
  );

  return candidates[0] || null;
};

const groupBy = (rows, key) => {
  const map = new Map();

  for (const row of rows) {
    const list = map.get(row[key]) || [];
    list.push(row);
    map.set(row[key], list);
  }

  return map;
};

const orderingState = (settings, day) => {
  if (!settings.ordering_enabled) {
    return {
      enabled: false,
      reason:
        "Ordering from the table is paused right now. Please order with your waiter — you can still call them from here.",
    };
  }

  if (!day.business_day_id) {
    return {
      enabled: false,
      reason: "We're not taking orders just yet. Please ask a member of staff.",
    };
  }

  return { enabled: true, reason: null };
};

// The menu a guest sees, priced for one place and one kind of service: a
// table's dine-in menu, or the online page's takeaway or delivery menu on the
// Website channel. The selling rules decide the price, the packaging charge
// and whether a dish is sold for that service at all — the order service's
// own rules, so the menu never promises a price the bill will not honour.
// Only what a guest should see: no codes, tax rates, costs, stock or ids of
// anything but the dishes, sizes and add-ons they can pick.
const menuFor = async (restaurantId, { outletId = null, orderType = "dine_in", channelId = null, timezone }) => {
  const [categories, products, variants, modifiers, comboParts, offers, rules, soldOut] =
    await Promise.all([
      tableRequestRepository.findMenuCategories(restaurantId),
      tableRequestRepository.findMenuProducts(restaurantId),
      tableRequestRepository.findMenuVariants(restaurantId),
      tableRequestRepository.findMenuModifiers(restaurantId),
      tableRequestRepository.findComboParts(restaurantId),
      tableRequestRepository.findLiveOffers(restaurantId, timezone, outletId),
      sellingRules.list(restaurantId),
      require('../../menu/repositories/availability.repository').findSoldOutKeys(restaurantId, undefined, outletId || null),
    ]);

  const variantsBy = groupBy(variants, "product_id");
  const modifiersBy = groupBy(modifiers, "product_id");
  const partsBy = groupBy(comboParts, "combo_product_id");
  const offersBy = groupBy(offers, "product_id");
  const soldKeys = new Set(soldOut.map(row=>`${row.product_id}:${row.product_variant_id || ''}`));
  const packed = ["takeaway", "delivery", "online"].includes(orderType);

  // Which offers are running and on how many dishes, for the banner that
  // tells a guest "Happy hour — 12 dishes until 7 pm".
  const liveWindows = new Map();

  const dishes = products.map((product) => {
    const rule = sellingRules.selectRule(rules, product.id, { outletId, orderType, channelId });
    const base = Number(rule?.price ?? product.price);
    const productOffers = offersBy.get(product.id) || [];
    const offer = bestOffer(productOffers, null);
    const productVariants = variantsBy.get(product.id) || [];
    const sizeOffers = productVariants.map((variant) => bestOffer(productOffers, variant.id));

    const sizes = productVariants.map((variant, index) => ({
      id: variant.id,
      name: variant.name,
      price: round2(base + Number(variant.price_delta)),
      offerPrice: sizeOffers[index] ? Number(sizeOffers[index].price) : null,
      isDefault: variant.is_default,
      soldOut: soldKeys.has(`${product.id}:`) || soldKeys.has(`${product.id}:${variant.id}`),
    }));

    const windowsHere = new Map(
      [offer, ...sizeOffers].filter(Boolean).map((used) => [used.window_id, used])
    );

    for (const [windowId, used] of windowsHere) {
      const entry = liveWindows.get(windowId) || {
        name: used.name,
        endsAt: used.ends_at,
        dishCount: 0,
      };
      entry.dishCount += 1;
      liveWindows.set(windowId, entry);
    }

    const inServingTime = require('../../menu/services/menuServiceOptions.service').availableNow(product.availability_schedule, timezone);

    return {
      id: product.id,
      categoryId: product.category_id,
      name: product.name,
      description: product.description,
      foodType: product.food_type,
      addonGroups: product.addon_groups || [],
      comboChoiceGroups: product.combo_choice_groups || [],
      price: base,
      offerPrice: offer ? Number(offer.price) : null,
      offerName: offer ? offer.name : null,
      // Packing, per portion, for a parcel (the selling rule's own figure).
      packagingCharge: packed ? Number(rule?.packaging_charge || 0) : 0,
      soldOut: !product.is_available || rule?.is_available === false || soldKeys.has(`${product.id}:`)
        || !inServingTime,
      // Why a dish cannot be had, when it is a matter of the clock: "come
      // back at lunch" is a different message from "gone for tonight".
      notNow: !inServingTime,
      image: product.image_path,
      isCombo: product.is_combo,
      includes: (partsBy.get(product.id) || []).map((part) => ({
        name: part.name,
        variant: part.variant_name,
        quantity: Number(part.quantity),
      })),
      variants: sizes,
      modifiers: (modifiersBy.get(product.id) || []).map((modifier) => ({
        id: modifier.id,
        name: modifier.name,
        price: Number(modifier.price),
      })),
    };
  });

  const dishesById = new Map(dishes.map(dish=>[Number(dish.id),dish]));
  for (const dish of dishes) {
    dish.comboChoiceGroups = dish.comboChoiceGroups.map(group=>({...group,options:group.options.map(option=>{
      const part=dishesById.get(Number(option.productId));
      const size=option.productVariantId ? part?.variants.find(v=>Number(v.id)===Number(option.productVariantId)) : null;
      return {...option,name:part?.name || option.name,variantName:size?.name || option.variantName,
        isAvailable:Boolean(part && !part.soldOut && (!option.productVariantId || (size && !size.soldOut)))};
    })}));
    if(dish.comboChoiceGroups.some(group=>group.options.filter(option=>option.isAvailable).length<group.choose))dish.soldOut=true;
  }
  const dishesBy = groupBy(dishes, "categoryId");

  return {
    offers: [...liveWindows.values()],
    categories: categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        description: category.description,
        dishes: dishesBy.get(category.id) || [],
      }))
      .filter((category) => category.dishes.length > 0),
  };
};

const getMenu = async (token) => {
  const table = await resolveTable(token);
  const restaurantId = table.restaurant_id;
  const timezone = table.timezone || "Asia/Kolkata";

  const [settings, day, menu] = await Promise.all([
    tableRequestRepository.findSettings(restaurantId),
    tableRequestRepository.findDayWindow(restaurantId, table.outlet_id || null),
    menuFor(restaurantId, { outletId: table.outlet_id || null, orderType: "dine_in", timezone }),
  ]);

  return {
    restaurant: {
      name: table.restaurant_name,
      currencySymbol: table.currency_symbol || "₹",
      taxMode: table.tax_mode || "exclusive",
      serviceChargePercentage: Number(table.service_charge_percentage || 0),
    },
    table: {
      tableNo: table.table_no,
      floorName: table.floor_name,
      areaName: table.area_name,
    },
    ordering: {
      ...orderingState(settings, day),
      callsEnabled: settings.calls_enabled,
      note: settings.guest_note,
      maxLines: 30,
      maxQuantity: 20,
    },
    offers: menu.offers,
    categories: menu.categories,
  };
};

// ---------------------------------------------------------------- what the guest sees back

// How far along the kitchen is, as a number, so two readings can be compared
// and the further one kept.
const KITCHEN_RANK = { pending: 0, preparing: 0, ready: 1, served: 2 };

const SERVED = { stage: "served", label: "Served — enjoy your meal", detail: null };
const READY = { stage: "ready", label: "Ready — on its way to you", detail: null };
const BEING_PREPARED = {
  stage: "accepted",
  label: "Accepted — being prepared",
  detail: "The kitchen has your order.",
};

// Where an accepted request's dishes are. It is THIS request's dishes that
// matter, not the whole order's: dessert ordered from the phone after the
// mains were served is not "served" the moment it is accepted.
//
//   - On the kitchen display, each order line's own status is kept by the
//     display, so the request is as far along as its slowest dish. A dish
//     the display has not ticketed yet is still "pending", which is right.
//     Staff can also mark the whole order served from the Orders screen; the
//     display catches up on its next refresh. That covers these dishes only
//     if they were already on a ticket — the display settles an order before
//     cutting a new round, so an order still reading "served" after this
//     round was ticketed was served after it.
//   - Without the display, the order's kitchen status is all there is. It is
//     put back to "pending" whenever a new round is added (the order
//     repository's editOrder), so whatever it says now happened after these
//     dishes went on; and what the request had reached before a later round
//     was added is kept (rememberReached), so it never goes backwards.
const acceptedStage = (row) => {
  if (row.order_status === "cancelled") {
    return {
      stage: "rejected",
      label: "Cancelled by the restaurant",
      detail: "Please speak to your waiter.",
    };
  }

  const linked = Number(row.own_linked || 0);
  const live = Number(row.own_live || 0);

  if (linked > 0 && live === 0) {
    return {
      stage: "rejected",
      label: "Taken off your order",
      detail: "The staff removed these dishes. Please speak to your waiter.",
    };
  }

  // Paid and gone: whatever was ordered was eaten.
  if (row.order_status === "completed") {
    return SERVED;
  }

  let reached;

  if (row.on_kitchen_display && live > 0) {
    reached =
      Number(row.own_served) === live ? 2 : Number(row.own_ready) === live ? 1 : 0;

    // Marked from the Orders screen (a kitchen that does not work the
    // display): "served" or "ready" there covers these dishes once they are
    // on a ticket. Every round is ticketed the moment it is saved, so this is
    // how a restaurant without the display still tells its QR guests.
    if (row.own_ticketed && row.kitchen_status === "served") {
      reached = 2;
    } else if (row.own_ticketed && row.kitchen_status === "ready") {
      reached = Math.max(reached, 1);
    }
  } else {
    reached = KITCHEN_RANK[row.kitchen_status] || 0;
  }

  reached = Math.max(reached, KITCHEN_RANK[row.kitchen_reached] || 0);

  return reached === 2 ? SERVED : reached === 1 ? READY : BEING_PREPARED;
};

const orderStage = (row) => {
  if (row.status === "pending" || row.status === "processing") {
    return {
      stage: "sent",
      label: "Sent to staff",
      detail: "Waiting for the staff to confirm your order.",
    };
  }

  if (row.status === "rejected") {
    return {
      stage: "rejected",
      label: "Couldn't be accepted",
      detail: row.reject_reason,
    };
  }

  if (row.status === "cancelled") {
    return { stage: "cancelled", label: "Cancelled", detail: "You cancelled this order." };
  }

  return acceptedStage(row);
};

const callStage = (row) => {
  if (row.status === "pending") {
    return { stage: "sent", label: "Someone is on the way", detail: "The staff have been told." };
  }

  if (row.status === "acknowledged") {
    return {
      stage: "acknowledged",
      label: "Seen — someone is on the way",
      detail: "A member of staff is coming over.",
    };
  }

  if (row.status === "cancelled") {
    return { stage: "cancelled", label: "Cancelled", detail: null };
  }

  return { stage: "done", label: "Done", detail: null };
};

// Final means nothing more will happen that the guest needs to see, so the
// phone can stop asking. An accepted order is still followed to the table:
// "ready" and "served" are what a hungry guest is waiting to read — so it is
// final only once its own dishes are served, or it has been called off.
const isFinal = (row, stage) => {
  if (["rejected", "cancelled", "done"].includes(row.status)) {
    return true;
  }

  return row.status === "accepted" && ["served", "rejected", "cancelled"].includes(stage);
};

const toGuestRequest = (row) => {
  const isOrder = row.request_type === "order";
  const stage = isOrder ? orderStage(row) : callStage(row);
  const items = (row.items || []).map((item) => ({
    name: item.name,
    variant: item.variant,
    modifiers: (item.modifiers || []).map((modifier) => modifier.name),
    quantity: Number(item.quantity),
    notes: item.notes,
    foodType: item.foodType,
    lineTotal: Number(item.lineTotal),
  }));

  return {
    id: row.id,
    type: row.request_type,
    status: row.status,
    ...stage,
    final: isFinal(row, stage.stage),
    orderNumber: row.status === "accepted" ? row.order_number : null,
    notes: row.notes,
    itemCount: row.item_count,
    itemsTotal: round2(items.reduce((sum, item) => sum + item.lineTotal, 0)),
    items,
    repeatCount: row.repeat_count,
    createdAt: row.created_at,
    // Only a still-waiting request can be withdrawn by the guest.
    canCancel: isOrder ? row.status === "pending" : ["pending", "acknowledged"].includes(row.status),
  };
};

// A phone's id for one submission, sent again for a different one: a stale
// page, or a hand-made request. Said so, rather than answering with whatever
// the key made before.
const KEY_IN_USE =
  "This page sent something else a moment ago. Please refresh the page and try again.";

const readBack = async (table, id) => {
  const rows = await tableRequestRepository.findForTable(table.restaurant_id, table.id, [id]);

  // Only a key re-sent long after the request it made (outside what a guest
  // may still read) gets here.
  if (rows.length === 0) {
    throw new AppError(409, KEY_IN_USE);
  }

  return toGuestRequest(rows[0]);
};

// ---------------------------------------------------------------- placing an order

// Two identical lines are one line of two — dish, size, add-ons and note all
// the same — using the order service's own rule, so the estimate here lines up
// with what acceptance will price, line for line.
const mergeLines = (items) => {
  const merged = [];

  for (const item of items) {
    const modifierIds = [...new Set(item.modifierIds)].sort((a, b) => a - b);
    const notes = item.notes || null;

    const same = merged.find(
      (line) =>
        line.productId === item.productId &&
        (line.variantId || null) === (item.variantId || null) &&
        (line.notes || "") === (notes || "") &&
        JSON.stringify(line.comboSelections || []) === JSON.stringify(item.comboSelections || []) &&
        line.modifierIds.length === modifierIds.length &&
        line.modifierIds.every((id, index) => id === modifierIds[index])
    );

    if (same) {
      same.quantity += item.quantity;
    } else {
      merged.push({ ...item, modifierIds, notes });
    }
  }

  return merged;
};

// Everything the order service would let slide for a till but a guest must
// not get away with: a size from another dish, an add-on the dish does not
// offer, an add-on or size switched off, a dish in a hidden category.
const checkCart = async (restaurantId, lines) => {
  const productIds = [...new Set(lines.map((line) => line.productId))];

  const [products, variants, links] = await Promise.all([
    tableRequestRepository.findProductsForCart(restaurantId, productIds),
    tableRequestRepository.findVariantsForCart(restaurantId, productIds),
    tableRequestRepository.findModifierLinksForCart(restaurantId, productIds),
  ]);

  const productsById = new Map(products.map((product) => [product.id, product]));

  for (const line of lines) {
    const product = productsById.get(line.productId);

    // Deliberately the same words for "never existed" and "another
    // restaurant's dish": the answer must not tell the two apart.
    if (!product) {
      throw new AppError(
        400,
        "One of the dishes in your order is no longer on the menu. Please refresh the menu and try again."
      );
    }

    if (product.status !== "active" || product.category_status !== "active") {
      throw new AppError(400, `"${product.name}" is no longer on the menu. Please remove it and try again.`);
    }

    if (!product.is_available) {
      throw new AppError(400, `Sorry — "${product.name}" has just sold out. Please remove it and try again.`);
    }

    if (line.quantity > 20) {
      throw new AppError(400, `You can order up to 20 of "${product.name}" at a time.`);
    }

    const sizes = variants.filter((variant) => variant.product_id === product.id);
    const activeSizes = sizes.filter((variant) => variant.status === "active");

    if (line.variantId) {
      const size = activeSizes.find((variant) => variant.id === line.variantId);

      if (!size) {
        throw new AppError(400, `That size of "${product.name}" isn't available. Please choose another.`);
      }
    } else if (activeSizes.length > 0) {
      throw new AppError(400, `Please choose a size for "${product.name}".`);
    }

    for (const modifierId of line.modifierIds) {
      const link = links.find(
        (candidate) => candidate.product_id === product.id && candidate.id === modifierId
      );

      if (!link || link.status !== "active") {
        throw new AppError(400, `One of the add-ons you chose isn't available for "${product.name}".`);
      }
    }

    line.product = product;
  }
};

const placeOrder = async (token, input) => {
  const table = await resolveTable(token);
  const restaurantId = table.restaurant_id;

  const [settings, day] = await Promise.all([
    tableRequestRepository.findSettings(restaurantId),
    tableRequestRepository.findDayWindow(restaurantId, table.outlet_id || null),
  ]);

  const state = orderingState(settings, day);

  if (!state.enabled) {
    throw new AppError(409, state.reason);
  }

  const lines = mergeLines(input.items);

  if (lines.reduce((sum, line) => sum + line.quantity, 0) > 100) {
    throw new AppError(400, "That's a very large order — please place it with your waiter.");
  }

  await checkCart(restaurantId, lines);

  // Priced by the order service, from the menu, now. Whatever price the phone
  // may have sent is never read.
  const pricing = await restaurantRepository.findSettings(restaurantId);
  const { lines: priced, totals } = await orderService.priceLines(
    restaurantId,
    lines.map((line) => ({
      productId: line.productId,
      productVariantId: line.variantId || null,
      modifierIds: line.modifierIds,
      comboSelections: line.comboSelections || [],
      quantity: line.quantity,
      notes: line.notes,
    })),
    pricing.tax_mode,
    pricing.timezone,
    {outletId: table.outlet_id, orderType: "dine_in", billOfSupply: pricing.document_type==='bill_of_supply'}
  );

  // mergeLines already did what priceLines' own merge would, so the priced
  // lines come back one for one, in the same order.
  const items = lines.map((line, index) => {
    const price = priced[index];

    return {
      productId: line.productId,
      productVariantId: line.variantId || null,
      modifierIds: line.modifierIds,
      comboSelections: line.comboSelections || [],
      itemName: price.itemName,
      variantName: price.variantName,
      modifiers: price.modifiers,
      foodType: line.product.food_type,
      quantity: line.quantity,
      notes: line.notes,
      unitPrice: price.unitPrice,
      lineTotal: round2((price.unitPrice + price.modifierTotal) * line.quantity),
    };
  });

  const result = await tableRequestRepository.createOrderRequest(
    {
      restaurantId,
      outletId: table.outlet_id,
      tableId: table.id,
      businessDayId: day.business_day_id,
      clientKey: input.clientKey,
      guestName: input.guestName,
      guestMobile: input.guestMobile,
      notes: input.notes,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      estimatedTotal: totals.totalAmount,
    },
    items,
    MAX_WAITING_ORDERS
  );

  if (result.error === "TOO_MANY_WAITING") {
    throw new AppError(
      409,
      `This table already has ${result.waiting} orders waiting for the staff to confirm. Please give them a moment — or call a waiter.`
    );
  }

  if (result.error === "KEY_IN_USE") {
    throw new AppError(409, KEY_IN_USE);
  }

  return { request: await readBack(table, result.id), duplicate: result.duplicate };
};

// ---------------------------------------------------------------- following up

const getRequests = async (token, ids) => {
  const table = await resolveTable(token);

  if (ids.length === 0) {
    return [];
  }

  const rows = await tableRequestRepository.findForTable(table.restaurant_id, table.id, ids);
  return rows.map(toGuestRequest);
};

const getRequest = async (token, id) => {
  const table = await resolveTable(token);
  const rows = await tableRequestRepository.findForTable(table.restaurant_id, table.id, [id]);

  if (rows.length === 0) {
    throw new AppError(404, "We couldn't find that request for this table.");
  }

  return toGuestRequest(rows[0]);
};

const cancelRequest = async (token, id) => {
  const table = await resolveTable(token);
  const cancelled = await tableRequestRepository.cancelForTable(table.restaurant_id, table.id, id);

  if (!cancelled) {
    const rows = await tableRequestRepository.findForTable(table.restaurant_id, table.id, [id]);

    if (rows.length === 0) {
      throw new AppError(404, "We couldn't find that request for this table.");
    }

    throw new AppError(
      409,
      "The staff have already picked this up, so it can't be cancelled from here. Please speak to your waiter."
    );
  }

  return readBack(table, id);
};

// ---------------------------------------------------------------- calls

const callStaff = async (token, input) => {
  const table = await resolveTable(token);
  const restaurantId = table.restaurant_id;

  const [settings, day] = await Promise.all([
    tableRequestRepository.findSettings(restaurantId),
    tableRequestRepository.findDayWindow(restaurantId, table.outlet_id || null),
  ]);

  if (!settings.calls_enabled) {
    throw new AppError(
      409,
      "Calling staff from the table is switched off right now. Please catch the eye of a member of staff."
    );
  }

  const result = await tableRequestRepository.createCall({
    restaurantId,
    outletId: table.outlet_id,
    tableId: table.id,
    businessDayId: day.business_day_id,
    requestType: input.type,
    clientKey: input.clientKey,
    notes: input.type === "other" ? input.message : null,
  });

  if (result.error === "KEY_IN_USE") {
    throw new AppError(409, KEY_IN_USE);
  }

  return {
    request: await readBack(table, result.id),
    repeated: result.repeated,
    duplicate: result.duplicate,
    message: result.repeated
      ? `We've reminded the staff that you'd like ${CALL_LABELS[input.type]}.`
      : `We've let the staff know you'd like ${CALL_LABELS[input.type]}.`,
  };
};

// ---------------------------------------------------------------- feedback

// Into the restaurant's own feedback book, marked as from the QR code. The
// table is written into the comment so the manager reading it knows where the
// guest sat — the feedback table has no column for it.
const leaveFeedback = async (token, input) => {
  const table = await resolveTable(token);
  const restaurantId = table.restaurant_id;

  // Feedback goes into the guest book's feedback: the Guests feature.
  if (!table.features.includes("guests")) {
    throw new AppError(403, "Feedback cannot be left here at the moment. Please tell a member of staff.", {
      reason: "feature_off",
      feature: "guests",
    });
  }
  const comments = input.comment
    ? `Table ${table.table_no} · ${input.comment}`
    : `Table ${table.table_no}`;

  const existing = await tableRequestRepository.findRecentFeedback(
    restaurantId,
    input.rating,
    comments
  );

  if (existing) {
    return { id: existing, duplicate: true };
  }

  const id = await crmRepository.createFeedback(
    restaurantId,
    {
      customerId: null,
      customerName: input.name,
      customerMobile: input.mobile,
      rating: input.rating,
      comments,
      source: "qr",
      feedbackStatus: "new",
    },
    null
  );

  return { id, duplicate: false };
};

// ---------------------------------------------------------------- the staff inbox

const secondsBetween = (from, to) =>
  from && to ? Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000)) : null;

const toStaffRequest = (row) => ({
  id: row.id,
  type: row.request_type,
  status: row.status,
  tableId: row.table_id,
  tableNo: row.table_no,
  // Where it came from: a table's QR code, or the restaurant's own ordering
  // page (SW-A-22) — then it has no table, but a service, a guest, maybe an
  // address, and how they will pay.
  channel: row.channel || "qr",
  serviceType: row.service_type || null,
  deliveryAddress: row.delivery_address || null,
  deliveryLandmark: row.delivery_landmark || null,
  paymentMode: row.payment_mode || null,
  deliveryCharge: Number(row.delivery_charge || 0),
  outletId: row.outlet_id || null,
  outletName: row.outlet_name || null,
  floorName: row.floor_name,
  areaName: row.area_name,
  guestName: row.guest_name,
  guestMobile: row.guest_mobile,
  notes: row.notes,
  itemCount: row.item_count,
  estimatedTotal: Number(row.estimated_total),
  items: (row.items || []).map((item) => ({
    id: item.id,
    productId: item.productId,
    productVariantId: item.productVariantId,
    name: item.name,
    variant: item.variant,
    modifiers: (item.modifiers || []).map((modifier) => ({
      id: modifier.id,
      name: modifier.name,
      price: Number(modifier.price),
    })),
    quantity: Number(item.quantity),
    notes: item.notes,
    foodType: item.foodType,
    unitPrice: Number(item.unitPrice),
    lineTotal: Number(item.lineTotal),
  })),
  orderId: row.order_id,
  orderNumber: row.order_number,
  orderAction: row.order_action,
  rejectReason: row.reject_reason,
  repeatCount: row.repeat_count,
  lastAskedAt: row.last_asked_at,
  acknowledgedAt: row.acknowledged_at,
  acknowledgedByName: row.acknowledged_by_name,
  resolvedAt: row.resolved_at,
  resolvedByName: row.resolved_by_name,
  createdAt: row.created_at,
  // Sent before the business day it would be served on began. Never shown
  // among today's requests; an order of an earlier day can only be rejected.
  fromEarlierDay: Boolean(row.from_earlier_day),
  // Request to first action, for "answered in 1m 20s".
  responseSeconds: secondsBetween(row.created_at, row.acknowledged_at || row.resolved_at),
  tableOrder: row.live_order_id
    ? {
        id: row.live_order_id,
        orderNumber: row.live_order_number,
        status: row.live_order_status,
        // The outlet the running order belongs to (null: taken with All
        // outlets). Someone working in another outlet cannot add to it.
        outletId: row.live_order_outlet_id || null,
        outletName: row.live_order_outlet_name || null,
      }
    : null,
});

// `outletId`, on every staff call below, is the outlet the person is working
// in (null for the whole restaurant). Requests from another outlet's tables
// are not in their inbox and cannot be acted on — see outletScopeSql.
const list = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  // "Today" is each request's own place's business day (the repository's
  // TODAY_FROM); `since` only labels the list.
  const [window, { rows, total }, captains] = await Promise.all([
    tableRequestRepository.findInboxWindow(restaurantId, filters.outletId || null),
    tableRequestRepository.findAll(restaurantId, filters),
    // The captain who has each table today (SW-A-20): the inbox puts a
    // captain's own tables first and marks them; everyone still sees all.
    require("../../tables/services/captainSection.service").captainsToday(restaurantId, filters.outletId || null),
  ]);

  return {
    items: rows.map((row) => ({
      ...toStaffRequest(row),
      captain: row.table_id ? captains.get(Number(row.table_id)) || null : null,
    })),
    total,
    limit: filters.limit,
    offset: filters.offset || 0,
    from: filters.from || null,
    to: filters.to || null,
    // Timers on screen run from the server's clock, not the tablet's, which
    // may be minutes out.
    serverTime: new Date().toISOString(),
    since: window.since,
  };
};

const getById = async (restaurantId, id, outletId = null) => {
  requireRestaurantId(restaurantId);

  const row = await tableRequestRepository.findById(restaurantId, id, outletId);

  if (!row) {
    throw new AppError(404, "Request not found");
  }

  return toStaffRequest(row);
};

const getSummary = async (restaurantId, outletId = null, channels = undefined) => {
  requireRestaurantId(restaurantId);

  const [window, row] = await Promise.all([
    tableRequestRepository.findInboxWindow(restaurantId, outletId),
    tableRequestRepository.summary(restaurantId, outletId, channels),
  ]);

  return {
    pendingOrders: row.pending_orders,
    oldestOrderAt: row.oldest_order_at,
    openCalls: row.open_calls,
    unansweredCalls: row.unanswered_calls,
    oldestCallAt: row.oldest_call_at,
    openCallsByType: {
      call_waiter: row.open_waiter_calls,
      bill: row.open_bill_calls,
      water: row.open_water_calls,
      other: row.open_other_calls,
    },
    ordersToday: row.orders_today,
    acceptedToday: row.accepted_today,
    acceptedValueToday: Number(row.accepted_value_today),
    rejectedToday: row.rejected_today,
    callsToday: row.calls_today,
    callsDoneToday: row.calls_done_today,
    avgResponseSeconds: row.avg_response_seconds,
    serverTime: new Date().toISOString(),
    since: window.since,
  };
};

// Why a button did nothing: said the way a colleague would say it.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "1 Oct" in the restaurant's own time zone, with the app's month names.
const dayLabel = (value, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type) => Number(parts.find((one) => one.type === type).value);

  return `${part("day")} ${MONTHS[part("month") - 1]}`;
};

const alreadyHandled = (row) => {
  const who = row.resolved_by_name || "someone";

  switch (row.status) {
    case "accepted":
      return `${who} already accepted this${row.order_number ? ` — it is on ${row.order_number}` : ""}.`;
    case "rejected":
      return `${who} already rejected this: ${row.reject_reason}`;
    case "cancelled":
      return "The guest cancelled this request.";
    case "processing":
      return "Someone is accepting this request right now.";
    case "acknowledged":
      return `${row.acknowledged_by_name || "Someone"} is already on it.`;
    case "done":
      return `${who} already marked this done.`;
    default:
      return "This request has already been dealt with.";
  }
};

const requireRequest = async (restaurantId, id, outletId = null) => {
  const row = await tableRequestRepository.findById(restaurantId, id, outletId);

  if (!row) {
    throw new AppError(404, "Request not found");
  }

  return row;
};

// The order-service shape of the guest's dishes, straight from what was
// stored: ids, quantities and notes only. Prices are the order service's.
const requestedLines = (row) =>
  (row.items || []).map((item) => ({
    productId: item.productId,
    productVariantId: item.productVariantId || null,
    modifierIds: (item.modifierIds || []).map(Number),
    comboSelections: item.comboSelections || [],
    quantity: Number(item.quantity),
    notes: item.notes || null,
  }));

const guestNote = (row) => (row.notes ? `QR: ${row.notes}` : null);

// Which order line each of the guest's dishes became. The order service keeps
// the lines in the order they were given, and the guest's lines were already
// merged by the same rule, so it is one for one; each pair is still checked
// (same dish, size and quantity), and a line that does not match is left
// unlinked rather than guessed — the status screen then falls back to the
// order's own kitchen status for it.
const linkLines = (requestItems, orderLines) =>
  requestItems
    .map((item, index) => {
      const line = orderLines[index];

      return line &&
        Number(line.productId) === Number(item.productId) &&
        (line.productVariantId || null) === (item.productVariantId || null) &&
        Number(line.quantity) === Number(item.quantity)
        ? { requestItemId: item.id, orderItemId: line.id }
        : null;
    })
    .filter(Boolean);

// The order service numbers a new order from a count of the restaurant's
// orders, so two tables accepted at the same instant can be handed the same
// number and one of them is refused by the database. Nothing was written for
// the loser, so it simply asks again — by then the winner's order is counted.
const ORDER_NUMBER_TAKEN = "orders_restaurant_id_order_number_key";

const isOrderNumberClash = (error) =>
  error && error.code === "23505" && error.constraint === ORDER_NUMBER_TAKEN;

const createOrderWithRetry = async (restaurantId, data, userId) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await orderService.create(restaurantId, data, userId);
    } catch (error) {
      if (!isOrderNumberClash(error) || attempt >= 5) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 40 * attempt + Math.random() * 60));
    }
  }
};

// A table somebody else has just opened: the order service refuses a second
// order on it (its table lock and the one-open-order-per-table index), with
// this reason.
const isTableBusy = (error) =>
  error instanceof AppError && error.details && error.details.reason === "table_busy";

// A table shared by every outlet can have another outlet's order running on
// it. Someone working in one outlet cannot add dishes to another outlet's
// order from the POS ("Order not found in this outlet"), and accepting a
// guest's QR order must not do it either: the dishes would land on an order
// that outlet bills, from a screen that cannot see it. The request stays
// waiting for someone working there.
const otherOutletRefusal = (table, live) =>
  new AppError(
    409,
    `Table ${table.table_no} already has ${live.order_number} running, and it belongs to ${
      live.outlet_name ? live.outlet_name : "the whole restaurant (taken with All outlets)"
    }. Only someone working ${
      live.outlet_name ? `at ${live.outlet_name}` : "with All outlets"
    } can add this guest's dishes to it — the request stays waiting for them.`,
    { reason: "order_other_outlet", orderId: live.id, outletId: live.outlet_id || null }
  );

const billedRefusal = (table, live) =>
  new AppError(
    409,
    `Table ${table.table_no} has already been billed${
      live.bill_number ? ` (${live.bill_number})` : ""
    }. Void the bill in Bills to reopen ${live.order_number}, then accept this — or reject it and let the guest know.`
  );

// Turns an order request into a real order, through the order service only —
// the same code the POS uses, so a QR dish is priced, checked (sold out,
// serving times) and sent to the kitchen exactly like one rung up at the till:
//   - a table with nothing running gets a new dine-in order, source "qr";
//   - a table already eating has the new dishes added to its open order
//     (appendItems: priced at the order's own outlet and service, every
//     existing line left untouched, and the KOT cut at once — before, a QR
//     second round reached the kitchen only when a kitchen screen next
//     refreshed);
//   - a table whose bill is already printed is refused with the way out.
//
// Two requests from one table accepted at the same moment are kept apart by
// the order service itself: the table's row lock lets only one of them open
// the table, and the other is told the table is busy — it then adds its
// dishes to the order the first one opened. Nothing here holds a database
// connection while it waits. The old accept lock did (a session lock on its
// own connection, then the order work needed a second one), and twelve
// accepts at once took every connection in the pool and froze the whole API.
const acceptInto = async (restaurantId, row, userId, outletId) => {
  const lines = requestedLines(row);

  if (lines.length === 0) {
    throw new AppError(409, "This request has no dishes on it. Reject it instead.");
  }

  if (lines.some((line) => !line.productId)) {
    throw new AppError(
      409,
      "A dish on this request has since been removed from the menu. Reject it and ask the guest to order again."
    );
  }

  const table = await tableRepository.findTableById(restaurantId, row.table_id);

  if (!table || table.status !== "active") {
    throw new AppError(409, `Table ${row.table_no} is no longer in use. Reject this request instead.`);
  }

  for (let attempt = 1; ; attempt += 1) {
    const live = await tableRequestRepository.findLiveOrder(restaurantId, table.id);

    if (!live) {
      try {
        const order = await createOrderWithRetry(
          restaurantId,
          {
            orderType: "dine_in",
            source: "qr",
            tableId: table.id,
            outletId: table.outlet_id || outletId || null,
            customerId: null,
            customerName: row.guest_name,
            customerMobile: row.guest_mobile,
            guestCount: null,
            notes: guestNote(row),
            items: lines,
          },
          userId
        );

        return { order, action: "created", links: linkLines(row.items || [], order.items) };
      } catch (error) {
        // Opened by someone else a moment ago: add to their order instead.
        if (isTableBusy(error) && attempt < 3) {
          continue;
        }

        throw error;
      }
    }

    // Working in one outlet, only that outlet's own order is added to — the
    // same line the POS draws (order.routes).
    if (outletId && Number(live.outlet_id || 0) !== Number(outletId)) {
      throw otherOutletRefusal(table, live);
    }

    if (live.order_status !== "open") {
      throw billedRefusal(table, live);
    }

    await tableRequestRepository.rememberReached(restaurantId, live.id);

    let order;

    try {
      order = await orderService.appendItems(restaurantId, live.id, lines, userId, {
        note: guestNote(row),
        customerName: row.guest_name,
        customerMobile: row.guest_mobile,
      });
    } catch (error) {
      // Billed (or paid, or cancelled) between the look and the write.
      if (error instanceof AppError && error.statusCode === 409 && attempt < 3) {
        const now = await tableRequestRepository.findLiveOrder(restaurantId, table.id);

        if (now && now.id === live.id && now.order_status !== "open") {
          throw billedRefusal(table, now);
        }

        if (!now || now.id !== live.id) {
          continue;
        }
      }

      throw error;
    }

    return { order, action: "added", links: linkLines(row.items || [], order.addedItems) };
  }
};

// A website order (SW-A-22): a takeaway or delivery order of its own, on the
// Website channel, at the selling point its link belongs to — the outlet, or
// the main counter when the link is the main counter's (outlet null). Never
// at the outlet of whoever pressed Accept: the guest ordered from that
// kitchen, and its day, riders and delivery area are the ones that apply.
// Through the order service like everything else, so the Website channel's
// prices, packaging and delivery charge, sold-out dishes and serving times
// all apply exactly as at the till. The guest goes into the guest book by
// mobile (linkGuest), as a mobile typed at the till does.
const PAYMENT_NOTES = { pay_at_pickup: "Pay at pickup", cash_on_delivery: "Cash on delivery" };

const onlineNote = (row) =>
  [`Website ${row.service_type}`, PAYMENT_NOTES[row.payment_mode], row.notes].filter(Boolean).join(" · ").slice(0, 500);

const acceptOnline = async (restaurantId, row, userId) => {
  const lines = requestedLines(row);

  if (row.service_type === "delivery" && !(await restaurantFeatures.featuresOf(restaurantId)).includes("deliveries")) {
    throw restaurantFeatures.offError("Deliveries & rider cash", "deliveries");
  }

  if (lines.length === 0) {
    throw new AppError(409, "This request has no dishes on it. Reject it instead.");
  }

  if (lines.some((line) => !line.productId)) {
    throw new AppError(
      409,
      "A dish on this order has since been removed from the menu. Reject it and tell the guest to order again."
    );
  }

  const channel = await onlineOrderRepository.findWebsiteChannel(restaurantId);

  if (!channel) {
    throw new AppError(
      409,
      "The Website sales channel is switched off (Deliveries → Channels). Switch it on to accept online orders, or reject this one."
    );
  }

  const link = row.online_link_id ? await onlineOrderRepository.findLink(restaurantId, row.online_link_id) : null;

  const order = await createOrderWithRetry(
    restaurantId,
    {
      orderType: row.service_type,
      source: "website",
      channelId: channel.id,
      outletId: row.outlet_id || null,
      customerId: null,
      customerName: row.guest_name,
      customerMobile: row.guest_mobile,
      linkGuest: true,
      notes: onlineNote(row),
      items: lines,
    },
    userId
  );

  // Where the rider goes, and what the guest was promised. Written through
  // the deliveries module's own column list.
  if (row.service_type === "delivery") {
    await deliveryRepository.update(
      restaurantId,
      order.id,
      {
        address: row.delivery_address,
        landmark: row.delivery_landmark,
        etaMinutes: link ? link.delivery_minutes : null,
      },
      userId
    );
  }

  return { order, action: "created", links: linkLines(row.items || [], order.items) };
};

const accept = async (restaurantId, id, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const claimed = await tableRequestRepository.claimForAccept(restaurantId, id, userId, outletId);

  if (!claimed) {
    const row = await requireRequest(restaurantId, id, outletId);

    if (row.request_type !== "order") {
      throw new AppError(400, "Only an order can be accepted. Mark a call as done instead.");
    }

    throw new AppError(409, alreadyHandled(row));
  }

  let result;

  try {
    const row = await tableRequestRepository.findById(restaurantId, id);

    // An order sent on an earlier business day: the guests have gone, and
    // accepting it would cook today for a table that ordered yesterday. It
    // can only be rejected (the claim is handed back below).
    if (row.from_earlier_day) {
      throw new AppError(
        409,
        `This order was sent on ${dayLabel(row.created_at, row.time_zone)}, before today's business day began. The guests will have left: reject it instead, and take a fresh order if they are still here.`,
        { reason: "earlier_day" }
      );
    }

    // The inbox it came from must still be switched on (Settings -> Features).
    const inboxOn = (await restaurantFeatures.featuresOf(restaurantId)).includes(row.channel === "website" ? "online_ordering" : "qr_ordering");

    if (!inboxOn) {
      throw restaurantFeatures.offError(row.channel === "website" ? "Online ordering page" : "QR table ordering", row.channel === "website" ? "online_ordering" : "qr_ordering");
    }

    result =
      row.channel === "website"
        ? await acceptOnline(restaurantId, row, userId)
        : await acceptInto(restaurantId, row, userId, outletId);
  } catch (error) {
    // Back to waiting, exactly as it was, so it can be tried again or rejected.
    await tableRequestRepository.releaseClaim(restaurantId, id);

    if (isOrderNumberClash(error)) {
      throw new AppError(
        409,
        "Several orders were opened at the same moment and this one lost its turn. Press Accept again."
      );
    }

    throw error;
  }

  await tableRequestRepository.markAccepted(
    restaurantId,
    id,
    result.order.id,
    result.action,
    userId,
    result.links
  );

  return {
    request: await getById(restaurantId, id),
    order: {
      id: result.order.id,
      orderNumber: result.order.orderNumber,
      totalAmount: result.order.totalAmount,
      itemCount: result.order.items.filter((item) => item.itemStatus !== "cancelled").length,
    },
    action: result.action,
  };
};

const reject = async (restaurantId, id, reason, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const rejected = await tableRequestRepository.reject(restaurantId, id, reason, userId, outletId);

  if (!rejected) {
    const row = await requireRequest(restaurantId, id, outletId);

    if (row.request_type !== "order") {
      throw new AppError(400, "Only an order can be rejected. Mark a call as done instead.");
    }

    throw new AppError(409, alreadyHandled(row));
  }

  return getById(restaurantId, id);
};

const acknowledge = async (restaurantId, id, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const done = await tableRequestRepository.acknowledge(restaurantId, id, userId, outletId);

  if (!done) {
    const row = await requireRequest(restaurantId, id, outletId);

    if (row.request_type === "order") {
      throw new AppError(400, "An order is accepted or rejected, not acknowledged.");
    }

    throw new AppError(409, alreadyHandled(row));
  }

  return getById(restaurantId, id);
};

const markDone = async (restaurantId, id, userId, outletId = null) => {
  requireRestaurantId(restaurantId);

  const done = await tableRequestRepository.markDone(restaurantId, id, userId, outletId);

  if (!done) {
    const row = await requireRequest(restaurantId, id, outletId);

    if (row.request_type === "order") {
      throw new AppError(400, "An order is accepted or rejected, not marked done.");
    }

    throw new AppError(409, alreadyHandled(row));
  }

  return getById(restaurantId, id);
};

const toSettings = (row) => ({
  orderingEnabled: row.ordering_enabled,
  callsEnabled: row.calls_enabled,
  guestNote: row.guest_note,
  updatedAt: row.updated_at,
});

const getSettings = async (restaurantId) => {
  requireRestaurantId(restaurantId);
  return toSettings(await tableRequestRepository.findSettings(restaurantId));
};

const updateSettings = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);
  return toSettings(await tableRequestRepository.updateSettings(restaurantId, data, userId));
};

// Everything an earlier day left waiting, closed in one go: QR orders
// rejected with the reason given, calls marked done. Today's requests are
// never touched. One by one through the same rules as the buttons, so a
// request someone else answered meanwhile is simply skipped.
const closeEarlier = async (restaurantId, reason, userId, outletId = null, channels) => {
  requireRestaurantId(restaurantId);

  const rows = await tableRequestRepository.findEarlierWaiting(restaurantId, outletId, channels);
  let rejected = 0;
  let done = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      if (row.request_type === "order") {
        await reject(restaurantId, row.id, reason, userId, outletId);
        rejected += 1;
      } else {
        await markDone(restaurantId, row.id, userId, outletId);
        done += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return { rejected, done, skipped };
};

module.exports = {
  closeEarlier,
  MAX_WAITING_ORDERS,
  // Shared with the online ordering page (onlineOrder.service).
  menuFor,
  mergeLines,
  checkCart,
  getMenu,
  placeOrder,
  getRequests,
  getRequest,
  cancelRequest,
  callStaff,
  leaveFeedback,
  list,
  getById,
  getSummary,
  accept,
  reject,
  acknowledge,
  markDone,
  getSettings,
  updateSettings,
};
