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

// --- The home page ----------------------------------------------------------------------------

// The default plan with the lowest monthly price, across the types: "Plans from ₹499 a month".
export function lowestPlan(pricing) {
  const plans = (pricing?.types || []).flatMap((type) => type.plans.filter((plan) => plan.isDefault && priceOf(plan, "month") !== null));
  return plans.reduce((low, plan) => (!low || paise(plan.monthly) < paise(low.monthly) ? plan : low), null);
}

// The module or application with the lowest monthly price that a plan can add.
export function lowestAddon(pricing) {
  const addons = (pricing?.types || []).flatMap((type) => (type.addons || []).filter((addon) => addon.available && priceOf(addon, "month") !== null));
  return addons.reduce((low, addon) => (!low || paise(addon.monthly) < paise(low.monthly) ? addon : low), null);
}

// How many modules and applications the price list offers, in the plans or
// as add-ons, each counted once across the types.
export function catalogueSize(pricing) {
  const codes = new Set();
  for (const type of pricing?.types || []) {
    for (const plan of type.plans || []) for (const module of plan.modules || []) codes.add(module.code);
    for (const addon of type.addons || []) if (addon.available) codes.add(addon.code);
  }
  return codes.size;
}

// What a year saves on twelve months, in whole percent rounded down, so it
// never says more than it is: 16 for ₹499 a month or ₹4,999 a year.
export function yearlySaving(plan) {
  const month = priceOf(plan, "month");
  const year = priceOf(plan, "year");
  if (month === null || year === null || paise(month) <= 0) return 0;
  const twelve = paise(month) * 12;
  return Math.max(0, Math.floor(((twelve - paise(year)) * 100) / twelve));
}

// The home page's questions, with the trial and grace days from the site's info.
export function homeQuestions(info) {
  const trialDays = Number(info?.trialDays) || 0;
  const graceDays = Number(info?.graceDays) || 0;
  const readOnly = "everything can still be seen, printed and exported, and nothing is deleted";
  return [
    trialDays > 0 && {
      question: "What happens when the free trial ends?",
      answer: `Choose your plan and pay for it in Your plan, during the trial or after it. A trial that ends unpaid leaves your business read-only: ${readOnly}. Paying brings everything back.`,
    },
    {
      question: "How do I pay?",
      answer: "In Your plan: by UPI, with a QR code for the exact amount, by bank transfer, or by cash or cheque. Enter the payment's reference, and your business carries on as soon as we confirm it, with our GST invoice.",
    },
    {
      question: "What if I renew late?",
      answer: graceDays > 0
        ? `When paid time ends, your business keeps working for ${graceDays} more ${graceDays === 1 ? "day" : "days"} while you renew. After that it is read-only until you pay: ${readOnly}.`
        : `When paid time ends, your business is read-only until you renew: ${readOnly}.`,
    },
    {
      question: "Can I add modules later?",
      answer: "Yes. Switch on what your plan unlocks in Settings, and add modules and applications in Your plan: on paid time, from today to the end of the period, for the days left.",
    },
    {
      question: "Who can see my business's data?",
      answer: "You, and the staff you give a login, each with the role you choose. Our team sees your plan, its dates and counts, never your sales, customers or patients.",
    },
    {
      question: "Does it work on a phone?",
      answer: "Yes, in the browser on a computer, tablet or phone. The till, the kitchen display and the waiters' captain app each have screens made for them.",
    },
    {
      question: "Can I run more than one business?",
      answer: `Yes. Add another business from your login, with its own plan${trialDays > 0 ? " and its own free trial" : ""}. A restaurant signs up on its own, with its own email and mobile number.`,
    },
  ].filter(Boolean);
}

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
