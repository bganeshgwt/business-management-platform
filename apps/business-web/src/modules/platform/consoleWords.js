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

// A calendar day ("2026-11-13") as a count of days, for the days between two.
const dayNumber = (date) => {
  const [y, m, d] = String(date).slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

// How far a period has run on a day, both days counted: "Day 3 of 14", with
// its share for a bar; nothing for a period with no end or not begun yet.
export function periodProgress(period, onDay) {
  if (!period?.startsOn || !period.endsOn || !onDay) return null;
  const total = dayNumber(period.endsOn) - dayNumber(period.startsOn) + 1;
  const day = Math.min(dayNumber(onDay) - dayNumber(period.startsOn) + 1, total);
  if (total < 1 || day < 1) return null;
  return { day, total, share: Math.round((day * 100) / total), words: `Day ${day} of ${total}` };
}

// When a business's time ends, from a day, with the tone a list shows it in:
// a week or less to go is a warning, an end gone by is ended.
export function endsInWords(endsOn, onDay) {
  if (!endsOn || !onDay) return null;
  const days = dayNumber(endsOn) - dayNumber(onDay);
  if (days === 0) return { text: "Ends today", tone: "warning" };
  if (days === 1) return { text: "Ends tomorrow", tone: "warning" };
  if (days > 1) return { text: `In ${days} days`, tone: days <= 7 ? "warning" : "neutral" };
  return { text: days === -1 ? "Ended yesterday" : `Ended ${-days} days ago`, tone: "danger" };
}

// A price before GST for a month or a year: "₹4,999 a year + 18% GST".
export function priceWords(price, period, gstRate) {
  if (price === null || price === undefined || price === "") return "Price not set yet";
  if (Number(price) === 0) return "Free";
  return `${money(Number(price))} ${PERIOD_WORDS[period] || ""} + ${Number(gstRate)}% GST`.replace("  ", " ");
}

// What a year at this price saves on twelve months of the monthly one, rounded
// down so it never says more than it is: "16% less than twelve months"; a year
// dearer than twelve months says so; nothing when a price is missing or equal.
export function yearSavingWords(monthly, yearly) {
  if ([monthly, yearly].some((price) => price === null || price === undefined || String(price).trim() === "" || Number.isNaN(Number(price)))) return "";
  const twelve = Math.round(Number(monthly) * 100) * 12;
  const year = Math.round(Number(yearly) * 100);
  if (twelve <= 0 || year === twelve) return "";
  if (year > twelve) return "Dearer than twelve months";
  const saved = Math.floor(((twelve - year) * 100) / twelve);
  return saved > 0 ? `${saved}% less than twelve months` : "";
}

// The sample GSTIN the company's invoices carry until the real one is entered
// (the API's planMath.js): its invoices are samples, in a series of their own.
export const SAMPLE_GSTIN = "22AAAAA0000A1ZC";

// "2627": the financial year (April to March) a day falls in, as invoice numbers write it.
export function fiscalYearCode(date = new Date()) {
  const start = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(start % 100).padStart(2, "0")}${String((start + 1) % 100).padStart(2, "0")}`;
}

// The year's first invoice number, as the API makes it: the company's prefix
// padded to 5 digits (BMP/2627/00001), or, while the GSTIN is the sample one,
// the SAMPLE series padded to 4; a long prefix leaves fewer digits, as GST
// allows 16 characters in all.
export function firstInvoiceNumber(prefix, gstin, date = new Date()) {
  const sample = String(gstin || "").trim().toUpperCase() === SAMPLE_GSTIN;
  const head = `${sample ? "SAMPLE" : String(prefix || "").trim().toUpperCase()}/${fiscalYearCode(date)}/`;
  return `${head}${"1".padStart(Math.max(1, Math.min(sample ? 4 : 5, 16 - head.length)), "0")}`;
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
