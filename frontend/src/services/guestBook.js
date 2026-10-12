// Words, checks and sheets for the guest book, feedback and complaints
// screens. Kept out of the page files so each page stays about its layout.
import { formatMobile } from "./phone";

// --- Tags -----------------------------------------------------------------------
// The same fixed list the database allows (chk_customers_tags).
export const GUEST_TAGS = [
  { value: "vip", label: "VIP", hint: "Greet by name, best table" },
  { value: "allergy", label: "Allergy", hint: "Tell the kitchen" },
  { value: "jain", label: "Jain", hint: "No onion, garlic or root veg" },
  { value: "vegan", label: "Vegan", hint: "No dairy, egg or honey" },
  { value: "corporate", label: "Corporate", hint: "Bills a company" },
  { value: "family", label: "Family", hint: "Comes with children" },
  { value: "blogger", label: "Food blogger", hint: "Writes reviews" },
];

const TAG_LABELS = Object.fromEntries(GUEST_TAGS.map((tag) => [tag.value, tag.label]));

export const tagLabel = (value) => TAG_LABELS[value] || value;

// --- Complaints -----------------------------------------------------------------
export const COMPENSATION_OPTIONS = [
  { value: "apology", label: "Apology only", costs: false },
  { value: "replaced", label: "Dish remade or replaced", costs: true },
  { value: "removed", label: "Dish taken off the bill", costs: true },
  { value: "discount", label: "Discount on the bill", costs: true },
  { value: "complimentary", label: "Something on the house", costs: true },
  { value: "refund", label: "Refund", costs: true },
  { value: "voucher", label: "Voucher for the next visit", costs: true },
  { value: "points", label: "Loyalty points", costs: true },
];

const COMPENSATION_LABELS = Object.fromEntries(COMPENSATION_OPTIONS.map((row) => [row.value, row.label]));

export const compensationLabel = (value) => COMPENSATION_LABELS[value] || value || "";

export const compensationCosts = (value) =>
  Boolean(COMPENSATION_OPTIONS.find((row) => row.value === value && row.costs));

// --- GSTIN ------------------------------------------------------------------------
// The same check as backend/src/utils/gstin.js: the format, the state code and
// the check character, so a typo shows while it is typed.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const GST_STATES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  10: "Bihar", 11: "Sikkim", 12: "Arunachal Pradesh", 13: "Nagaland", 14: "Manipur",
  15: "Mizoram", 16: "Tripura", 17: "Meghalaya", 18: "Assam", 19: "West Bengal",
  20: "Jharkhand", 21: "Odisha", 22: "Chhattisgarh", 23: "Madhya Pradesh", 24: "Gujarat",
  26: "Dadra and Nagar Haveli and Daman and Diu", 27: "Maharashtra", 29: "Karnataka", 30: "Goa",
  31: "Lakshadweep", 32: "Kerala", 33: "Tamil Nadu", 34: "Puducherry",
  35: "Andaman and Nicobar Islands", 36: "Telangana", 37: "Andhra Pradesh", 38: "Ladakh",
  97: "Other Territory", 99: "Centre Jurisdiction",
};

const checkCharacter = (first14) => {
  let sum = 0;

  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }

  return CHARS[(36 - (sum % 36)) % 36];
};

export const tidyGstin = (value) => String(value || "").replace(/[\s-]/g, "").toUpperCase();

// { ok, text } for the line under the GSTIN box, or null while it is empty.
export const gstinHint = (value) => {
  const gstin = tidyGstin(value);

  if (!gstin) {
    return null;
  }

  if (gstin.length !== 15) {
    return { ok: false, text: `${gstin.length} of 15 characters` };
  }

  if (!GSTIN_PATTERN.test(gstin)) {
    return { ok: false, text: "Not in the GSTIN format, like 27AAPFU0939F1ZV" };
  }

  const state = GST_STATES[gstin.slice(0, 2)];

  if (!state) {
    return { ok: false, text: `${gstin.slice(0, 2)} is not a GST state code` };
  }

  if (checkCharacter(gstin.slice(0, 14)) !== gstin[14]) {
    return { ok: false, text: "A character is mistyped: the last one does not match the rest" };
  }

  return { ok: true, text: `Registered in ${state} · checks out` };
};

// --- Dates --------------------------------------------------------------------------
// The app's own month names: the browser's en-IN gives "Sept", which no
// other screen (or the printed KOT) uses.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "12 Sep" this year, "12 Sep 2025" otherwise.
export const shortDate = (value) => {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const text = `${date.getDate()} ${MONTHS[date.getMonth()]}`;

  return date.getFullYear() === new Date().getFullYear() ? text : `${text} ${date.getFullYear()}`;
};

// "24 Sep, 8:40 pm": when something happened, for lists and history.
export const dateTime = (value) => {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return `${shortDate(date)}, ${date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
};

const dayNumber = (date) => Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 86400000);

// "3 days ago", "yesterday", for the last-visit column: a manager scanning for
// regulars who have gone quiet reads this faster than a date. Counted in
// calendar days, so last night's dinner is "yesterday" at half past midnight.
export const sinceText = (value, now = new Date()) => {
  if (!value) {
    return "";
  }

  const days = dayNumber(now) - dayNumber(new Date(value));

  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;

  return `${Math.round(days / 365)} years ago`;
};

// --- CSV sheets --------------------------------------------------------------------
// Rows for services/csv.js downloadCsv (which guards cells against formulas).

export const guestBookSheet = (items) => [
  [
    "Name",
    "Mobile",
    "Email",
    "Company",
    "GSTIN",
    "Tags",
    "Allergies",
    "Offers consent",
    "Consent recorded",
    "Birthday",
    "Anniversary",
    "Visits",
    "Last visit",
    "Total spend",
    "Points",
    "Status",
  ],
  ...items.map((row) => [
    row.name,
    // Someone who may export but not read full numbers gets them masked.
    formatMobile(row.mobile) || row.mobileDisplay || "",
    row.email || row.emailMasked || "",
    row.companyName || "",
    row.gstin || "",
    (row.tags || []).map(tagLabel).join(", "),
    row.allergies || "",
    row.marketingOptIn ? "Yes" : "No",
    row.marketingOptInAt ? String(row.marketingOptInAt).slice(0, 10) : "",
    row.dateOfBirth || "",
    row.anniversaryDate || "",
    row.visits,
    row.lastVisit ? String(row.lastVisit).slice(0, 10) : "",
    Number(row.spend).toFixed(2),
    row.loyaltyPoints,
    row.erased ? "Erased" : row.status,
  ]),
];

export const pointHoldersSheet = (report) => [
  ["Guest", "Mobile", "Points", `Worth (${report.currency})`, "Last visit"],
  ...report.holders.items.map((row) => [
    row.name,
    formatMobile(row.mobile) || row.mobileDisplay || "",
    row.points,
    Number(row.value).toFixed(2),
    row.lastVisit ? String(row.lastVisit).slice(0, 10) : "",
  ]),
  [],
  ["Points owed in total", "", report.owed.points, Number(report.owed.value).toFixed(2), ""],
];

export const pointsByDaySheet = (report) => [
  ["Business day", "Points earned", "Points redeemed", `Redeemed value (${report.currency})`, "Bills with points used"],
  ...report.byDay.map((row) => [row.date, row.earned, row.redeemed, Number(row.redeemedValue).toFixed(2), row.redeemedBills]),
  [],
  ["Total", report.period.earned, report.period.redeemed, Number(report.period.redeemedValue).toFixed(2), report.period.redeemedBills],
];

export const customerSalesSheet = (report) => [
  ["Guest", "Mobile", "Company", "GSTIN", "Visits", "Bills", `Sales (${report.currency})`, `Average per visit (${report.currency})`, `Discounts (${report.currency})`, `Paid with points (${report.currency})`, "Last bill"],
  ...report.items.map((row) => [
    row.name,
    formatMobile(row.mobile) || row.mobileDisplay || "",
    row.companyName || "",
    row.gstin || "",
    row.visits,
    row.bills,
    Number(row.spend).toFixed(2),
    Number(row.average).toFixed(2),
    Number(row.discounts).toFixed(2),
    Number(row.pointsValue).toFixed(2),
    row.lastVisit ? String(row.lastVisit).slice(0, 10) : "",
  ]),
  [],
  ["Guests in the book", "", "", "", "", report.totals.guestBills, Number(report.totals.guestSales).toFixed(2)],
  ["Walk-ins (no guest)", "", "", "", "", report.totals.walkInBills, Number(report.totals.walkInSales).toFixed(2)],
  ["All sales", "", "", "", "", report.totals.bills, Number(report.totals.sales).toFixed(2)],
];
