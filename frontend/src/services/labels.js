// The words the database's codes are shown as.
//
// These maps had been copied into four pages and were already drifting: one
// screen said "dine in", the rest said "Dine-in". A code that reaches a person
// unformatted is a bug, and it should only be fixed in one place.

const ORDER_TYPES = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery",
  qr: "QR order",
  online: "Online",
};

// The union of every method the app deals in: a bill can be settled by wallet,
// an expense can be paid by bank transfer, and neither screen sees the other's
// values.
const PAYMENT_METHODS = {
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  wallet: "Wallet",
  bank: "Bank transfer",
  online: "Online",
  other: "Other",
  // Paid from an advance the guest gave earlier (billing build).
  advance: "From advance",
};

// An unknown code is shown as itself rather than blank, so a value added to the
// database but not to this file is visible instead of silently disappearing.
export const orderTypeLabel = (value) => ORDER_TYPES[value] || value || "—";
export const paymentMethodLabel = (value) => PAYMENT_METHODS[value] || value || "—";

// Showing a stored value and offering a choice are different jobs. The maps
// above cover every value the app might have to display; the lists below are
// what each screen may actually offer, and they match the enums the API
// validates against — a dropdown with an option the server rejects is a trap.
const options = (source, codes) => codes.map((code) => ({ value: code, label: source[code] }));

// order.controller: ["dine_in", "takeaway", "delivery", "qr", "online"]
export const ORDER_TYPE_OPTIONS = options(ORDER_TYPES, [
  "dine_in",
  "takeaway",
  "delivery",
  "qr",
  "online",
]);

// bill.controller PAYMENT_METHODS, used for payments and refunds alike.
export const BILL_PAYMENT_OPTIONS = options(PAYMENT_METHODS, [
  "cash",
  "card",
  "upi",
  "online",
  "wallet",
  "other",
]);

// expense.controller: no wallet or online, but bank transfer instead.
export const EXPENSE_PAYMENT_OPTIONS = options(PAYMENT_METHODS, [
  "cash",
  "card",
  "upi",
  "bank",
  "other",
]);
