import { dateShort, money } from "@bmp/shared/format";

// Words the platform console's screens share: a plan's state as a badge and
// when its time ends, a price before GST, how a payment was made, and the GST
// register's CSV, which the company's accountant files the GST return from.
// Pure, so the unit tests read them without a browser.

export const PLAN_STATES = {
  trial: { label: "On trial", tone: "info" },
  paid: { label: "Paying", tone: "success" },
  given: { label: "Given time", tone: "primary" },
  grace: { label: "In grace", tone: "warning" },
  checking: { label: "Payment being checked", tone: "warning" },
  ended: { label: "Ended (read-only)", tone: "danger" },
  off: { label: "Switched off", tone: "neutral" },
  unmanaged: { label: "Not on a plan", tone: "neutral" },
};
export const stateWords = (state) => PLAN_STATES[state] || { label: state || "—", tone: "neutral" };

export const PERIOD_KINDS = { trial: "Free trial", paid: "Paid time", given: "Given time" };
export const METHOD_WORDS = { upi: "UPI", bank: "Bank transfer", cash: "Cash", cheque: "Cheque" };
export const PERIOD_WORDS = { month: "a month", year: "a year" };
export const PAYMENT_STATES = {
  pending: { label: "Being checked", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
};

// "29 Dec 2026", always with the year: a calendar date as that day, a moment
// as its day on the clock of the person reading (never the UTC day).
export const dayWords = (value) => {
  if (!value) return "";
  const text = String(value);
  return dateShort(/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : value, { year: true });
};

// A list row's plan facts (its columns) in the shape of the business page's plan.
export const planOfRow = (row) => ({
  state: row.state, accessEndsOn: row.access_ends_on, trialEndsOn: row.trial_ends_on, graceEndsOn: row.grace_ends_on, checkingUntil: row.checking_until,
});

// When a business's time ends, as its list and its page say it.
export function endsWords(plan) {
  if (!plan) return "";
  switch (plan.state) {
    case "trial": return `Trial until ${dayWords(plan.trialEndsOn || plan.accessEndsOn)}`;
    case "paid": return `Paid until ${dayWords(plan.accessEndsOn)}`;
    case "given": return plan.accessEndsOn ? `Given until ${dayWords(plan.accessEndsOn)}` : "Given, with no end date";
    case "grace": return `Ended on ${dayWords(plan.accessEndsOn)}; works until ${dayWords(plan.graceEndsOn)}`;
    case "checking": return plan.checkingUntil ? `Payment being checked; works until ${dayWords(plan.checkingUntil)}` : "Payment being checked";
    case "ended": return plan.accessEndsOn ? `Ended on ${dayWords(plan.accessEndsOn)}` : "Ended";
    case "off": return "Switched off";
    default: return "";
  }
}

// A price before GST for a month or a year: "₹4,999 a year + 18% GST".
export function priceWords(price, period, gstRate) {
  if (price === null || price === undefined || price === "") return "Price not set yet";
  if (Number(price) === 0) return "Free";
  return `${money(Number(price))} ${PERIOD_WORDS[period] || ""} + ${Number(gstRate)}% GST`.replace("  ", " ");
}

// The GST register as the GST return reads it (GSTR-1): one row per real tax
// invoice, never a SAMPLE one. Dates as the GST offline tool writes them
// (30-Oct-2026), the place of supply as its code and state (29-Karnataka),
// amounts as plain rupees.
export const GST_REGISTER_HEADER = ["Invoice number", "Invoice date", "Buyer name", "Buyer GSTIN", "Place of supply", "Taxable value", "GST rate (%)",
  "CGST", "SGST", "IGST", "Invoice value"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const gstDate = (value) => {
  const [y, m, d] = String(value).slice(0, 10).split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
};
export const gstRegisterRows = (items) => [
  GST_REGISTER_HEADER,
  ...items.filter((item) => !item.sample).map((item) => [
    item.number, gstDate(item.issuedOn), item.buyerName || "", item.buyerGstin || "",
    `${item.placeOfSupplyCode}-${item.placeOfSupplyName || ""}`, item.taxable, String(Number(item.gstRate)), item.cgst, item.sgst, item.igst, item.total,
  ]),
];
