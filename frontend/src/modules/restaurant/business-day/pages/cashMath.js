// Figures the cash screens share: a count by notes, the difference between a
// count and what the drawer should hold, and how that difference is said.
// Every sum is done in paise, so ₹0.10 + ₹0.20 is never ₹0.30000000000000004.

// The notes an Indian drawer holds, largest first (₹2,000 notes are out of
// circulation). Coins are counted as one amount.
export const NOTES = [500, 200, 100, 50, 20, 10];

const paise = (value) => Math.round(Number(value || 0) * 100);

// The total of a note-by-note count.
export const notesTotal = (notes) =>
  (NOTES.reduce((sum, note) => sum + note * 100 * Math.max(0, Math.floor(Number(notes[note]) || 0)), 0) +
    Math.max(0, paise(notes.coins))) /
  100;

// The denominations as the API takes them: only what was counted.
export const notesPayload = (notes) => {
  const out = {};

  for (const note of NOTES) {
    const value = Math.floor(Number(notes[note]) || 0);

    if (value > 0) {
      out[String(note)] = value;
    }
  }

  const coins = paise(notes.coins) / 100;

  if (coins > 0) {
    out.coins = coins;
  }

  return out;
};

// Count less what should be there, to the paisa.
export const difference = (counted, expected) => (paise(counted) - paise(expected)) / 100;

// How far out a count is: exact, within the threshold, or beyond it (which
// needs a reason before the drawer can close).
export const varianceTone = (variance, threshold) => {
  if (Math.abs(variance) < 0.005) {
    return "match";
  }

  return Math.abs(variance) > Number(threshold || 0) + 0.004 ? "far" : "near";
};

// "₹150 short", "₹20 over", "Matches".
export const varianceWords = (variance, money) => {
  if (variance === null || variance === undefined) {
    return "";
  }

  if (Math.abs(variance) < 0.005) {
    return "Matches";
  }

  return `${money(Math.abs(variance))} ${variance < 0 ? "short" : "over"}`;
};

// The name of a way to pay, as the cash-up says it.
export const METHOD_WORDS = { cash: "Cash", card: "Card", upi: "UPI", online: "Online", wallet: "Wallet", other: "Other" };

// What each non-cash total is ticked against.
export const CHECK_AGAINST = {
  card: "the card machine's settlement slip",
  upi: "the UPI app or bank statement",
  online: "the payment gateway's report",
  wallet: "the wallet app",
  other: "its own record",
};
