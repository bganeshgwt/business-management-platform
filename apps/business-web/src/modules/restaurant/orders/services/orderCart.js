// The POS cart for a running order: what is already on the order, what the
// waiter has changed, and what saving will send.
//
// A running order is edited, never re-entered. Lines already on the order
// ("saved" lines) keep their price, their kitchen state and the time they were
// rung up; the server only ever changes what the waiter touched:
//   - minus on a saved line takes some of it off. If the kitchen already has
//     it, that is a cancellation after KOT (a reason, and a manager's PIN for
//     staff who cannot do it themselves).
//   - plus on a saved line, or tapping the same dish again, is a NEW line: a
//     new round for the kitchen, at today's price.
//   - cancelled lines are never loaded, so they can never come back.
//
// Saving sends only what changed, each changed line with the quantity this
// screen showed. A table is often worked from two places at once; a line this
// screen did not touch is never sent, so it can never undo what another till
// or a guest's QR order did to it, and a line both changed is refused by the
// server rather than overwritten (see rebaseCart).
//
// Kept free of React so the rules can be tested on their own.

// Every open order, for the Still running strip. The server caps a list at
// 500 and sends every running table before any takeaway, so a table can never
// drop off the strip; the strip says so if a restaurant ever has more.
export const RUNNING_LIMIT = 500;

// Why a dish the kitchen already has is being taken off. The same list the
// server accepts.
export const CANCEL_REASONS = [
  { code: "guest_changed_mind", label: "Guest changed their mind" },
  { code: "wrong_order", label: "Wrong dish punched" },
  { code: "delay", label: "Took too long" },
  { code: "quality", label: "Quality complaint" },
  { code: "other", label: "Other" },
];

export const reasonLabel = (code) =>
  (CANCEL_REASONS.find((reason) => reason.code === code) || {}).label || "—";

export const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// A line's money exactly as the server works it out (services/order.service
// priceLines): the base rounded, the tax rounded, then added.
export const lineMoney = ({ unitPrice, modifierTotal = 0, quantity, taxPercentage = 0, taxMode, priceIncludesTax }) => {
  const base = round2((Number(unitPrice) + Number(modifierTotal)) * Number(quantity));
  const percentage = Number(taxPercentage) || 0;

  if (priceIncludesTax ?? (taxMode === "inclusive")) {
    const net = round2(base / (1 + percentage / 100));

    return { net, tax: round2(base - net), total: base };
  }

  const tax = round2((base * percentage) / 100);

  return { net: base, tax, total: round2(base + tax) };
};

export const offerKey = (productId, variantId) => `${productId}:${variantId || ""}`;

// The price a dish sells at right now, in the size chosen: a happy-hour price
// for that exact dish and size when one is running at this outlet, otherwise
// the menu price plus the size's difference. `offers` is a Map from
// offerKey to the rows GET /orders/offers returns.
export const unitPriceFor = (product, variant, offers) => {
  const offer = offers ? offers.get(offerKey(product.id, variant ? variant.id : null)) : null;

  if (offer) {
    return { unitPrice: Number(offer.price), offer };
  }

  return {
    unitPrice: round2(Number(product.price) + (variant ? Number(variant.priceDelta) : 0)),
    offer: null,
  };
};

const sameModifiers = (left = [], right = []) => {
  if (left.length !== right.length) {
    return false;
  }

  const ids = new Set(right.map((modifier) => modifier.id));

  return left.every((modifier) => ids.has(modifier.id));
};

// The same dish ordered the same way: dish, size, add-ons and the note.
const sameDish = (line, candidate) =>
  line.productId === candidate.productId &&
  (line.productVariantId || null) === (candidate.productVariantId || null) &&
  (line.notes || "") === (candidate.notes || "") &&
  (line.courseNo || 1) === (candidate.courseNo || 1) &&
  Boolean(line.holdCourse) === Boolean(candidate.holdCourse) &&
  JSON.stringify(line.comboSelections || []) === JSON.stringify(candidate.comboSelections || []) &&
  sameModifiers(line.modifiers, candidate.modifiers);

// The cart for an order just opened or just saved: its live lines only.
export const cartFromOrder = (order) =>
  (order.items || [])
    .filter((item) => item.itemStatus !== "cancelled")
    .map((item) => ({
      key: `saved-${item.id}`,
      id: item.id,
      saved: true,
      productId: item.productId,
      productVariantId: item.productVariantId,
      name: item.itemName,
      variantName: item.variantName,
      modifiers: item.modifiers || [],
      notes: item.notes || "",
      courseNo: item.courseNo || 1,
      courseName: item.courseName || "",
      holdCourse: item.fireStatus === "held",
      quantity: item.quantity,
      savedQuantity: item.quantity,
      kitchenQuantity: item.kitchenQuantity || 0,
      kitchenStage: item.kitchenStage || null,
      unitPrice: item.unitPrice,
      modifierTotal: item.modifierTotal,
      taxPercentage: item.taxPercentage,
      priceIncludesTax: item.priceIncludesTax,
      comboSelections: (item.comboParts || []).filter(part=>part.groupId).map(part=>({groupId:part.groupId,productId:part.productId,productVariantId:part.productVariantId})),
      lineTotal: item.lineTotal,
      itemStatus: item.itemStatus,
      createdAt: item.createdAt,
      priceWindowName: item.priceWindowName || null,
    }));

// What has been taken off this order so far, for a quiet note under the cart:
// whole lines cancelled, and part of a line (2 of 3 naan) that is still on.
// { key, name, quantity, left } — `left` is how many of that line are still
// on the order (0 for a line taken off whole).
export const takenOffEarlier = (order) =>
  (order && order.items ? order.items : [])
    .map((item) => {
      const cancelled = item.itemStatus === "cancelled";
      // A line cancelled whole by an older release has no record of how many;
      // its own quantity is what came off.
      const quantity = cancelled ? item.cancelledQuantity || item.quantity : item.cancelledQuantity || 0;

      return {
        key: item.id,
        name: item.variantName ? `${item.itemName} (${item.variantName})` : item.itemName,
        quantity,
        left: cancelled ? 0 : item.quantity,
      };
    })
    .filter((row) => row.quantity > 0);

let nextKey = 0;

// A dish tapped on the menu. It joins a line the waiter added in this edit
// when it is the same dish ordered the same way; it never joins a saved line,
// because more of a dish the kitchen already has is a new round.
export const addLine = (cart, candidate) => {
  const index = cart.findIndex((line) => !line.saved && sameDish(line, candidate));

  if (index >= 0) {
    return cart.map((line, at) =>
      at === index ? { ...line, quantity: round2(line.quantity + candidate.quantity) } : line
    );
  }

  nextKey += 1;

  return [...cart, { ...candidate, key: `new-${Date.now()}-${nextKey}`, saved: false }];
};

// Plus or minus on a line. Returns the new cart, or null for plus on a saved
// line at its full quantity: that is more of a dish already on the order, and
// the caller adds it as a new line at today's price (addLine).
//
// A saved line can go down to 0 and stays in the cart, struck through, so the
// waiter sees what saving will take off and can undo it with plus.
export const stepLine = (cart, key, delta) => {
  const line = cart.find((one) => one.key === key);

  if (!line) {
    return cart;
  }

  if (line.saved) {
    if (delta > 0 && line.quantity >= line.savedQuantity) {
      return null;
    }

    const quantity = round2(Math.min(Math.max(line.quantity + delta, 0), line.savedQuantity));

    return cart.map((one) => (one.key === key ? { ...one, quantity } : one));
  }

  const quantity = round2(line.quantity + delta);

  return quantity <= 0
    ? cart.filter((one) => one.key !== key)
    : cart.map((one) => (one.key === key ? { ...one, quantity } : one));
};

// Anything saving would change.
export const isDirty = (cart) =>
  cart.some((line) => !line.saved || line.quantity !== line.savedQuantity);

// What saving would take off that the kitchen already has — the part of a
// reduction beyond what the kitchen has not been sent yet.
export const pendingCancellations = (cart, taxMode) =>
  cart
    .filter((line) => line.saved && line.quantity < line.savedQuantity)
    .map((line) => {
      const removed = round2(line.savedQuantity - line.quantity);
      const unsent = round2(Math.max(line.savedQuantity - line.kitchenQuantity, 0));
      const afterKot = round2(removed - Math.min(removed, unsent));
      const after = line.quantity > 0 ? lineMoney({ ...line, taxMode }).total : 0;
      const amount = afterKot > 0 ? round2(((line.lineTotal - after) * afterKot) / removed) : 0;

      return {
        key: line.key,
        id: line.id,
        name: line.name,
        variantName: line.variantName,
        quantity: afterKot,
        amount,
        kitchenStage: line.kitchenStage,
      };
    })
    .filter((row) => row.quantity > 0);

const changeOf = (line) =>
  line.saved
    ? { id: line.id, quantity: line.quantity, seenQuantity: line.savedQuantity }
    : {
        productId: line.productId,
        productVariantId: line.productVariantId || null,
        modifierIds: (line.modifiers || []).map((modifier) => modifier.id).filter(id=>id!==null&&id!==undefined),
        quantity: line.quantity,
        notes: line.notes || null,
        courseNo: line.courseNo || 1,
        courseName: line.courseName || null,
        holdCourse: Boolean(line.holdCourse),
        comboSelections: line.comboSelections || [],
      };

const changed = (line) => !line.saved || line.quantity !== line.savedQuantity;

// The request body's items: only what the waiter changed. A saved line by
// its id, with the quantity wanted now and the quantity this screen showed;
// a new dish by what it is. Prices are never sent, and a saved line nobody
// touched is not sent at all.
export const buildItems = (cart) => cart.filter(changed).map(changeOf);

// Dishes the kitchen has that saving takes off, one group per dish (a dish
// rung up in two rounds is one group). A manager approving at the till
// approves one dish at a time, by name: "Take off 1 × Paneer Tikka on
// ORD-0412", never a vague "some dishes". Each group is saved on its own, with
// its own approval, before the rest of the change.
//   [{ productId, name, items, dishes }] — items for the request, dishes as
//   pendingCancellations describes them
export const cancellationGroups = (cart, taxMode) => {
  const pending = pendingCancellations(cart, taxMode);
  const groups = new Map();

  for (const dish of pending) {
    const line = cart.find((one) => one.key === dish.key);
    const group = groups.get(line.productId) || { productId: line.productId, name: line.name, items: [], dishes: [] };

    group.items.push(changeOf(line));
    group.dishes.push(dish);
    groups.set(line.productId, group);
  }

  return [...groups.values()];
};

// The cart again after the server refused a save because another device
// changed the order meanwhile. It starts from the order as it is now; every
// dish this screen was adding is kept, and a reduction is kept only where
// the line is still what this screen saw. `dropped` names the lines the waiter
// must look at again.
export const rebaseCart = (order, cart) => {
  const next = cartFromOrder(order);
  const dropped = [];

  for (const line of cart.filter((one) => one.saved && one.quantity !== one.savedQuantity)) {
    const index = next.findIndex((one) => one.id === line.id);

    if (index >= 0 && next[index].savedQuantity === line.savedQuantity) {
      next[index] = { ...next[index], quantity: line.quantity };
    } else {
      dropped.push(line.variantName ? `${line.name} (${line.variantName})` : line.name);
    }
  }

  return { cart: [...next, ...cart.filter((one) => !one.saved)], dropped };
};

// ------------------------------------------------------------------ the order's own details
//
// The guest count, the note and the guest are worked from two places at once
// as much as the dishes are. The same rule holds: a screen sends only the
// details the waiter changed on it, each with what it showed, and it tells
// "changed here" from "changed elsewhere" by comparing the boxes with what it
// last SHOWED (the order as it opened, refreshed or saved it), never with a
// fresher copy of the order. Comparing with a fresher copy is what made a
// note another till wrote look like the waiter had deleted it.

// The details as the POS boxes hold them. The guest is one detail: the
// guest-book entry, the name and the mobile go together.
export const headerOf = (order) => ({
  guestCount: order && order.guestCount ? String(order.guestCount) : "",
  notes: (order && order.notes) || "",
  customerId: (order && order.customerId) || null,
  customerName: (order && order.customerName) || "",
  customerMobile: (order && order.customerMobile) || "",
});

const HEADER_PARTS = [["guestCount"], ["notes"], ["customerId", "customerName", "customerMobile"]];

const samePart = (left, right, part) => part.every((field) => String(left[field] ?? "") === String(right[field] ?? ""));

// What saving would send about the order itself: each detail the waiter
// changed since this screen showed `seen`, and under `seen` what it showed.
// Empty when nothing changed.
export const headerChanges = (seen, current) => {
  const changes = {};
  const shown = {};

  if (!samePart(seen, current, HEADER_PARTS[0])) {
    changes.guestCount = current.guestCount ? Number(current.guestCount) : null;
    shown.guestCount = seen.guestCount ? Number(seen.guestCount) : null;
  }

  if (!samePart(seen, current, HEADER_PARTS[1])) {
    changes.notes = current.notes || null;
    shown.notes = seen.notes || null;
  }

  if (!samePart(seen, current, HEADER_PARTS[2])) {
    changes.customerId = current.customerId || null;
    changes.customerName = current.customerName || null;
    changes.customerMobile = current.customerMobile || null;
    shown.customerId = seen.customerId || null;
    shown.customerName = seen.customerName || null;
    shown.customerMobile = seen.customerMobile || null;
  }

  return Object.keys(changes).length > 0 ? { ...changes, seen: shown } : {};
};

// The boxes once a fresher copy of the order has come in (`fresh`, from
// headerOf): a detail the waiter has not touched shows what the order says
// now; one the waiter is changing keeps the waiter's words.
export const rebaseHeader = (seen, current, fresh) => {
  const next = { ...current };

  for (const part of HEADER_PARTS) {
    if (samePart(seen, current, part)) {
      for (const field of part) {
        next[field] = fresh[field];
      }
    }
  }

  return next;
};

// What one cart line comes to: a saved line untouched is exactly what the
// order says; anything else is priced the way the server will price it.
export const lineTotalOf = (line, taxMode) =>
  line.saved && line.quantity === line.savedQuantity
    ? line.lineTotal
    : line.quantity > 0
      ? lineMoney({ ...line, taxMode }).total
      : 0;

export const cartTotal = (cart, taxMode) =>
  round2(cart.reduce((sum, line) => sum + lineTotalOf(line, taxMode), 0));
