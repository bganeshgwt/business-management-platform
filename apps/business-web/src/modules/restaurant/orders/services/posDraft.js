// An unsaved POS cart survives a sign-out on the same till.
//
// A session runs out mid-service, or the till is locked and someone signs
// back in: without this the order being rung up (eight dishes for table five)
// was simply gone. The cart is kept in this browser tab's sessionStorage,
// under the person's own key, so it comes back for the same person on the
// same till, never for the next person who signs in there, and never on
// another device. Closing the tab ends it. A draft older than a service
// (12 hours) is dropped rather than brought back.
//
// Kept free of React so the rules can be tested on their own. `storage` is
// window.sessionStorage in the POS; anything with getItem/setItem/removeItem
// in a test.

const PREFIX = "rmp_pos_draft";
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const draftKey = (user) =>
  user && user.id ? `${PREFIX}:${user.restaurantId || 0}:${user.id}` : null;

// Whether there is anything worth bringing back: dishes not yet saved, a
// change to a running order, or details typed for an order not yet placed.
const worthKeeping = (draft) => {
  if (!draft) {
    return false;
  }

  const cart = Array.isArray(draft.cart) ? draft.cart : [];
  const unsavedLines = cart.some((line) => !line.saved || line.quantity !== line.savedQuantity);

  if (draft.editingOrderId) {
    return unsavedLines || Boolean(draft.headerChanged);
  }

  return (
    cart.length > 0 ||
    Boolean(draft.customerMobile) ||
    Boolean(draft.customerName) ||
    Boolean(draft.orderNotes) ||
    Boolean(draft.delivery && (draft.delivery.address || draft.delivery.externalRef))
  );
};

export const saveDraft = (storage, key, draft, now = Date.now()) => {
  if (!storage || !key) {
    return;
  }

  try {
    if (!worthKeeping(draft)) {
      storage.removeItem(key);
      return;
    }

    storage.setItem(key, JSON.stringify({ ...draft, savedAt: now }));
  } catch {
    // Storage full or blocked: the till still works, it just cannot keep the
    // cart across a sign-out.
  }
};

export const loadDraft = (storage, key, now = Date.now()) => {
  if (!storage || !key) {
    return null;
  }

  try {
    const raw = storage.getItem(key);

    if (!raw) {
      return null;
    }

    const draft = JSON.parse(raw);

    if (!draft || typeof draft !== "object" || !Number.isFinite(draft.savedAt) || now - draft.savedAt > MAX_AGE_MS) {
      storage.removeItem(key);
      return null;
    }

    return worthKeeping(draft) ? draft : null;
  } catch {
    return null;
  }
};

export const clearDraft = (storage, key) => {
  if (!storage || !key) {
    return;
  }

  try {
    storage.removeItem(key);
  } catch {
    // Nothing to do.
  }
};
