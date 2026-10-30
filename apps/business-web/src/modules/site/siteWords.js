// The public site's words, without React: what a sign-up comes to after the
// trial, prices said the same way on every page, the business types in the
// groups the product overview uses with what the platform does for each, the
// pages' titles, and the add-ons a plan can take. Every figure comes from the
// site's API (/api/site): the price list, the trial days and the GST rate.
import { money } from "@bmp/shared/format";

const PERIOD = { month: "a month", year: "a year" };
const PRICE_KEY = { month: "monthly", year: "yearly" };

// A price of the period (month or year), as text from the API, or null when
// it is not set yet.
export const priceOf = (item, billingPeriod) => {
  const value = item ? item[PRICE_KEY[billingPeriod]] : null;
  return value === null || value === undefined || value === "" ? null : value;
};

// Rupees as paise, so prices add up to the paisa.
const paise = (value) => Math.round(Number(value) * 100);

// "18%": the GST rate as the site says it ("18.00" from the API).
export const gstPercent = (gstRate) => `${Number(gstRate)}%`;

// "+ 18% GST": prices are before GST.
export const plusGst = (gstRate) => (gstRate === null || gstRate === undefined || gstRate === "" ? "+ GST" : `+ ${gstPercent(gstRate)} GST`);

export const periodWords = (billingPeriod) => PERIOD[billingPeriod];

// "₹499 a month", "Free", or "Price not set yet".
export const priceLabel = (item, billingPeriod) => {
  const price = priceOf(item, billingPeriod);
  if (price === null) return "Price not set yet";
  return paise(price) === 0 ? "Free" : `${money(price)} ${PERIOD[billingPeriod]}`;
};

export const trialWords = (trialDays) => `${trialDays} ${Number(trialDays) === 1 ? "day" : "days"}`;

// What the plan and add-ons come to after the free trial, before GST:
//   "Free for 14 days, then ₹6,998 + 18% GST a year"
//   "Pay ₹499 + 18% GST a month to start" (no trial)
export function priceSummary({ plan, addons = [], billingPeriod, trialDays, gstRate }) {
  const prices = [plan, ...addons].map((item) => priceOf(item, billingPeriod));
  const free = Number(trialDays) > 0 ? `Free for ${trialWords(trialDays)}` : null;
  if (!plan || prices.some((price) => price === null)) {
    return free ? `${free}. The price after the trial is not set yet: ask us for it.` : "The price is not set yet: ask us for it before you start.";
  }
  const total = money(prices.reduce((sum, price) => sum + paise(price), 0) / 100);
  return free ? `${free}, then ${total} ${plusGst(gstRate)} ${PERIOD[billingPeriod]}` : `Pay ${total} ${plusGst(gstRate)} ${PERIOD[billingPeriod]} to start`;
}

// "Start free trial", or "Sign up" while new businesses get no trial.
export const startLabel = (trialDays) => (Number(trialDays) > 0 ? "Start free trial" : "Sign up");

// --- Business types ---------------------------------------------------------------------------

// The groups of PRODUCT_OVERVIEW.md "How it is organised", in its order.
export const TYPE_GROUPS = [
  { title: "Food", codes: ["restaurant"] },
  { title: "Shops", codes: ["grocery", "supermarket", "books", "general_retail"] },
  { title: "Trade", codes: ["wholesale"] },
  { title: "Speciality retail", codes: ["fashion", "electronics", "optical", "jewellery"] },
  { title: "Building and farm", codes: ["hardware", "agri_inputs"] },
  { title: "Vehicles and fuel", codes: ["garage", "fuel_station"] },
  { title: "Services", codes: ["salon", "memberships", "laundry", "rentals"] },
  { title: "Stays", codes: ["lodging"] },
  { title: "Health", codes: ["pharmacy", "healthcare"] },
  { title: "Weight-based", codes: ["meat", "weight_retail"] },
];

// The types the API lists, in their groups; a type no group names yet comes
// last, under "Other businesses".
export function typeGroups(types = []) {
  const groups = TYPE_GROUPS.map((group) => ({ title: group.title, types: group.codes.map((code) => types.find((type) => type.code === code)).filter(Boolean) }))
    .filter((group) => group.types.length);
  const placed = new Set(TYPE_GROUPS.flatMap((group) => group.codes));
  const others = types.filter((type) => !placed.has(type.code));
  return others.length ? [...groups, { title: "Other businesses", types: others }] : groups;
}

// What the platform does for each type, in a line, from PRODUCT_OVERVIEW.md
// "What each business type gets": only what is built.
export const TYPE_LINES = {
  restaurant: "A POS for dine-in, takeaway and delivery, KOTs to the kitchen display, tables, QR ordering and the captain app, set up as a restaurant, café, bakery or cloud kitchen.",
  grocery: "Quick bill with barcodes and scale labels, offers and loyalty points, udhaar, and batches about to expire.",
  supermarket: "Billing counters with cashier shifts, departments, offers and loyalty, and stock sent between branches.",
  books: "ISBN billing that catches a wrong check digit, school sets and book orders.",
  general_retail: "Billing with GST, stock, purchases and customers' dues for any shop.",
  wholesale: "Sales orders, dispatch and van load sheets, routes and beats, price lists, schemes and credit hold.",
  fashion: "A size and colour grid with a barcode for each, exchanges and credit vouchers, garment tags and GST by price.",
  electronics: "An IMEI and serial register, warranties, repairs, EMI and financiers.",
  optical: "Eye tests and prescriptions, spectacle orders through the lab, and the recall list.",
  jewellery: "The day's gold and silver rates, tagged pieces with their HUID, old gold, gold schemes and karigar work.",
  hardware: "Quotations for a site, today's rates for cement and steel, material calculators, paint tinting and fitters' commission.",
  agri_inputs: "Licences checked at the counter, banned molecules refused, seed lots, subsidised fertiliser and farmers' season credit.",
  garage: "Vehicles and job cards, estimates the owner approves, insurance claims and service reminders.",
  fuel_station: "The dealer's back office: nozzle readings and each attendant's settlement, tank dips and density, and fleet credit.",
  salon: "Appointments by stylist and room, packages, memberships and commissions.",
  memberships: "Plans and memberships, check-in at the door, fees in instalments and renewal calls.",
  laundry: "Garment orders with tags, racks and slots, billing at hand-over, and damage claims.",
  rentals: "Bookings that never clash, hand-over and return with deposits, late fees and the fleet's papers.",
  lodging: "Rooms and housekeeping, reservations, check-in with every occupant, folios and the night audit.",
  pharmacy: "A drug master with batches and expiry, Schedule H, H1 and X registers, and recalls.",
  healthcare: "The front desk's tokens and each doctor's queue, consultations and prescriptions, and a lab with sample barcodes and QC.",
  meat: "Selling by weight at the day's rates, cutting yield and wastage.",
  weight_retail: "Loose goods sold by weight, repacked, and costed by yield.",
};

export const typeLine = (code) => TYPE_LINES[code] || "Billing with GST, stock, purchases and customers' dues.";

// --- Plans and add-ons ------------------------------------------------------------------------

// The add-ons a plan can take: the type's modules and applications it does
// not include, those owners may add.
export const addonsFor = (type, plan) => {
  const included = new Set((plan?.modules || []).map((module) => module.code));
  return (type?.addons || []).filter((addon) => !included.has(addon.code) && addon.available);
};

// Ticking an add-on ticks what it needs (outside the plan) too; unticking one
// unticks the add-ons that need it.
export function toggleAddon(chosen, code, on, offered) {
  const byCode = new Map(offered.map((addon) => [addon.code, addon]));
  const next = new Set(chosen);
  if (on) {
    const stack = [code];
    while (stack.length) {
      const current = stack.pop();
      if (!byCode.has(current) || next.has(current)) continue;
      next.add(current);
      stack.push(...(byCode.get(current).requires || []));
    }
  } else {
    const stack = [code];
    while (stack.length) {
      const current = stack.pop();
      if (!next.delete(current)) continue;
      stack.push(...offered.filter((addon) => (addon.requires || []).includes(current)).map((addon) => addon.code));
    }
  }
  return offered.map((addon) => addon.code).filter((addonCode) => next.has(addonCode));
}

// "needs Guests & CRM": what an add-on needs that the plan does not include.
export const needsWords = (addon, offered) => {
  const names = (addon.requires || []).map((code) => offered.find((other) => other.code === code)?.name).filter(Boolean);
  return names.length ? `needs ${names.join(" and ")}` : null;
};

// --- The pages -------------------------------------------------------------------------------

// "Pricing · Business Management Platform"; the brand alone for the home page's own.
export const pageTitle = (page, brandName) => (brandName ? (page ? `${page} · ${brandName}` : brandName) : page || "");

// The company as the site names it: its legal name, or "the platform company"
// until the super admin enters it.
export const companyName = (info) => info?.company?.name || "the platform company";

// The company's website as a link: an http(s) address, or a bare domain
// ("acme.in"); null for anything else, which is shown as text.
export function websiteHref(value) {
  const text = String(value || "").trim();
  if (/^https?:\/\/[^\s]+$/i.test(text)) return text;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?$/i.test(text) ? `https://${text}` : null;
}

// Where a visitor came from: the ref or utm_source of the link that brought them.
export function refFrom(search) {
  const params = new URLSearchParams(search || "");
  const ref = (params.get("ref") || params.get("utm_source") || "").trim();
  return ref ? ref.slice(0, 100) : null;
}
