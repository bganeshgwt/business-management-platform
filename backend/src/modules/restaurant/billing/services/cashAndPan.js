// The cash limit and the buyer's PAN on the restaurant's own bills: the two
// Income-tax rules the shared core keeps for every business, kept for the
// restaurant by its database (migration 1791972000000: the triggers on
// payments and customer_advances). The figures the screens show are read
// with the database's own functions (bill.repository findById), so they are
// the figures the next payment is checked against.
//
//   - Cash of ₹2,00,000 or more is never taken for one bill (its cash
//     payments with their cash tips, and what it took from an advance paid in
//     cash), or from one guest on one day of the restaurant's calendar (cash
//     on the bills that name them, and their advances taken in cash).
//   - A bill over ₹2,00,000 takes no payment until it records the buyer's
//     PAN, or their declaration that they have none (Form 97).

const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");
const { toPaise, fromPaise } = require("../../../../utils/money");

// ₹2,00,000 or more in cash is refused, so a paisa under it is the most.
const CASH_LIMIT_PAISE = 20000000;
// A bill over ₹2,00,000 records the buyer's PAN.
const PAN_ABOVE_PAISE = 20000000;
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// A PAN as printed on the card (any case typed): five letters, four digits
// and a letter, checked as the shared core checks it. Empty is none.
const readPan = (value, name = "PAN") => {
  const text = v.optionalString(value, name, 10);

  if (!text) {
    return null;
  }

  const pan = text.toUpperCase();

  if (!PAN_SHAPE.test(pan)) {
    throw new AppError(400, `${name} must look like ABCDE1234F: five letters, four digits and a letter`);
  }

  return pan;
};

// The buyer's PAN typed for a bill, or that they have none and signed a
// declaration (Form 97): { pan, panDeclaration } as the request sends it.
// Returns { pan, declaration }, or null when it says neither.
const readBuyerPan = (buyer) => {
  if (buyer === undefined || buyer === null) {
    return null;
  }

  if (typeof buyer !== "object" || Array.isArray(buyer)) {
    throw new AppError(400, "Buyer must be an object");
  }

  const pan = readPan(buyer.pan, "Buyer PAN");
  const declaration = v.requiredBoolean(buyer.panDeclaration, "PAN declaration", false);

  if (pan && declaration) {
    throw new AppError(400, "Give the buyer's PAN or record their declaration, not both");
  }

  return pan || declaration ? { pan, declaration } : null;
};

// Whether a bill of this total needs the buyer's PAN before it is paid.
const panNeeded = (total) => toPaise(total) > PAN_ABOVE_PAISE;

// The PAN inside a GSTIN (its 3rd to 12th characters), when it is one.
const panInGstin = (gstin) => {
  const part = gstin ? String(gstin).slice(2, 12) : "";

  return PAN_SHAPE.test(part) ? part : null;
};

// The cash that can still be taken after `taken` (rupees).
const cashLeft = (taken) => fromPaise(Math.max(0, CASH_LIMIT_PAISE - 1 - toPaise(taken)));

// A bill's cash figures, from its full read: the cash taken for it and what
// more it may take, and the same for the guest it names, today on the
// restaurant's clock. `left` is the most cash the bill can still take now.
const cashLimitOf = (row) => {
  const taken = fromPaise(toPaise(row.cash_on_bill));
  const bill = { taken, left: cashLeft(taken) };
  let guest = null;

  if (row.cash_guest_id) {
    const today = fromPaise(toPaise(row.cash_from_guest_today));
    guest = { customerId: Number(row.cash_guest_id), name: row.cash_guest_name || null, taken: today, left: cashLeft(today) };
  }

  return {
    limit: fromPaise(CASH_LIMIT_PAISE),
    bill,
    guest,
    left: guest ? Math.min(bill.left, guest.left) : bill.left,
  };
};

// A rule the database keeps (the cash limit, the buyer's PAN) refusing with
// its own sentence, as the 409 the API answers with; null for anything else.
const ruleRefusal = (error) =>
  error && error.code === "23514" && !error.constraint && error.message ? new AppError(409, error.message) : null;

module.exports = {
  readBuyerPan,
  panNeeded,
  panInGstin,
  cashLimitOf,
  ruleRefusal,
};
