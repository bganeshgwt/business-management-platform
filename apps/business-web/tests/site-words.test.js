import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TYPE_GROUPS, TYPE_LINES, addonsFor, companyName, needsWords, pageTitle, priceLabel, priceSummary, plusGst, refFrom, startLabel, toggleAddon, typeGroups, websiteHref,
} from "../src/modules/site/siteWords.js";
import { POLICY_KINDS, POLICY_TITLES, policyOf } from "../src/modules/site/sitePolicies.js";

// The public site's words: what a sign-up comes to after the trial, the
// business types in the product overview's groups, the add-ons a plan can
// take, and the policies, whose every name, number and rate comes from the
// site's info.

const basic = { code: "grocery_basic", name: "Basic", monthly: "499.00", yearly: "4999.00", modules: [{ code: "sales", name: "Sales" }] };
const loyalty = { code: "loyalty", name: "Loyalty points", monthly: "199.00", yearly: "1999.00", available: true, requires: [] };
const offers = { code: "offers", name: "Offers", monthly: "199.50", yearly: "1999.00", available: true, requires: [] };

test("the summary: free for the trial, then the plan and add-ons for a month or a year, before GST", () => {
  assert.equal(priceSummary({ plan: basic, addons: [loyalty], billingPeriod: "year", trialDays: 14, gstRate: "18.00" }), "Free for 14 days, then ₹6,998 + 18% GST a year");
  assert.equal(priceSummary({ plan: basic, billingPeriod: "month", trialDays: 14, gstRate: "18.00" }), "Free for 14 days, then ₹499 + 18% GST a month");
  assert.equal(priceSummary({ plan: basic, addons: [loyalty, offers], billingPeriod: "month", trialDays: 1, gstRate: "18.00" }), "Free for 1 day, then ₹897.50 + 18% GST a month");
  assert.equal(priceSummary({ plan: { ...basic, yearly: "123456.00" }, billingPeriod: "year", trialDays: 7, gstRate: "12.00" }), "Free for 7 days, then ₹1,23,456 + 12% GST a year");
  // No trial: the first payment comes first.
  assert.equal(priceSummary({ plan: basic, addons: [loyalty], billingPeriod: "month", trialDays: 0, gstRate: "18.00" }), "Pay ₹698 + 18% GST a month to start");
  // A price not set for the period cannot be added up.
  assert.equal(priceSummary({ plan: { ...basic, monthly: null }, billingPeriod: "month", trialDays: 14, gstRate: "18.00" }),
    "Free for 14 days. The price after the trial is not set yet: ask us for it.");
  assert.equal(priceSummary({ plan: basic, addons: [{ ...loyalty, yearly: null }], billingPeriod: "year", trialDays: 0, gstRate: "18.00" }),
    "The price is not set yet: ask us for it before you start.");
  assert.equal(plusGst(undefined), "+ GST");
  assert.equal(startLabel(14), "Start free trial");
  assert.equal(startLabel(0), "Sign up");
});

test("a price as the pages say it", () => {
  assert.equal(priceLabel(basic, "month"), "₹499 a month");
  assert.equal(priceLabel(basic, "year"), "₹4,999 a year");
  assert.equal(priceLabel({ monthly: "0.00" }, "month"), "Free");
  assert.equal(priceLabel({ monthly: null }, "month"), "Price not set yet");
});

const TYPES = ["agri_inputs", "books", "electronics", "fashion", "fuel_station", "garage", "general_retail", "grocery", "hardware", "healthcare", "jewellery",
  "laundry", "lodging", "meat", "memberships", "optical", "pharmacy", "rentals", "restaurant", "salon", "supermarket", "weight_retail", "wholesale"]
  .map((code) => ({ code, name: code }));

test("the business types in the product overview's groups, each with what the platform does for it", () => {
  const groups = typeGroups(TYPES);
  assert.deepEqual(groups.map((group) => group.title),
    ["Food", "Shops", "Trade", "Speciality retail", "Building and farm", "Vehicles and fuel", "Services", "Stays", "Health", "Weight-based"]);
  assert.deepEqual(groups.find((group) => group.title === "Shops").types.map((type) => type.code), ["grocery", "supermarket", "books", "general_retail"]);
  assert.equal(groups.flatMap((group) => group.types).length, 23);
  for (const type of TYPES) assert.ok(TYPE_LINES[type.code], type.code);
  assert.equal(TYPE_GROUPS.flatMap((group) => group.codes).length, 23);
  // A type no group names yet still shows, last.
  const later = typeGroups([...TYPES, { code: "bakery_chain", name: "Bakery chains" }]);
  assert.deepEqual(later.at(-1), { title: "Other businesses", types: [{ code: "bakery_chain", name: "Bakery chains" }] });
  assert.deepEqual(typeGroups([{ code: "salon", name: "Salon" }]), [{ title: "Services", types: [{ code: "salon", name: "Salon" }] }]);
});

test("the add-ons a plan can take, and what ticking one ticks with it", () => {
  const guests = { code: "guests", name: "Guests & CRM", available: true, requires: [] };
  const preorders = { code: "preorders", name: "Pre-orders", available: true, requires: ["guests"] };
  const online = { code: "online_ordering", name: "Online ordering page", available: true, requires: ["guests"] };
  const hidden = { code: "brands", name: "Brands", available: false, requires: [] };
  const type = { addons: [guests, preorders, online, hidden, { code: "sales", name: "Sales", available: true, requires: [] }] };
  const offered = addonsFor(type, basic);
  assert.deepEqual(offered.map((addon) => addon.code), ["guests", "preorders", "online_ordering"]);
  assert.deepEqual(toggleAddon([], "preorders", true, offered), ["guests", "preorders"]);
  assert.deepEqual(toggleAddon(["guests", "preorders", "online_ordering"], "guests", false, offered), []);
  assert.deepEqual(toggleAddon(["guests", "preorders", "online_ordering"], "preorders", false, offered), ["guests", "online_ordering"]);
  assert.equal(needsWords(preorders, offered), "needs Guests & CRM");
  assert.equal(needsWords(guests, offered), null);
});

test("titles, the company's name and where a visitor came from", () => {
  assert.equal(pageTitle("Pricing", "Acme Suite"), "Pricing · Acme Suite");
  assert.equal(pageTitle(null, "Acme Suite"), "Acme Suite");
  assert.equal(pageTitle("Pricing", undefined), "Pricing");
  assert.equal(companyName({ company: { name: null } }), "the platform company");
  assert.equal(companyName({ company: { name: "Acme Soft Private Limited" } }), "Acme Soft Private Limited");
  // The company's website is a link only when it is an address.
  assert.equal(websiteHref("https://acme.invalid/about"), "https://acme.invalid/about");
  assert.equal(websiteHref("acme.in"), "https://acme.in");
  assert.equal(websiteHref("javascript:alert(1)"), null);
  assert.equal(websiteHref("Call us"), null);
  assert.equal(refFrom("?ref=facebook&x=1"), "facebook");
  assert.equal(refFrom("?utm_source=google&utm_medium=cpc"), "google");
  assert.equal(refFrom(""), null);
});

const info = (extra = {}) => ({
  brandName: "Acme Suite", company: { name: null, address: null, city: null, postalCode: null, phone: null, email: null, website: null },
  support: { phone: null, email: null }, grievance: { name: null, email: null }, trialDays: 9, graceDays: 3, gstRate: "12.00", ...extra,
});
const textOf = (policy) => [policy.title, policy.description, policy.lead, ...policy.sections.flatMap((section) => [section.heading,
  ...section.body.flatMap((part) => (typeof part === "string" ? [part] : part.list))])].join("\n");

test("the policies: every name, number and rate from the site's info", () => {
  assert.deepEqual(POLICY_KINDS, ["terms", "privacy", "refunds"]);
  for (const kind of POLICY_KINDS) {
    const text = textOf(policyOf(kind, info()));
    assert.equal(policyOf(kind, info()).title, POLICY_TITLES[kind]);
    assert.match(text, /Acme Suite/, kind);
    // No figure the settings decide is written into the words.
    for (const fixed of ["14 days", "7 days", "18%", "Business Management Platform"]) assert.ok(!text.includes(fixed), `${kind}: ${fixed}`);
  }
  const terms = textOf(policyOf("terms", info()));
  assert.match(terms, /free for 9 days/);
  assert.match(terms, /keeps working for 3 more days while you renew/);
  // With no contact entered yet, the Contact page.
  assert.match(terms, /Write to us, or to our grievance officer with a complaint, through the Contact page\./);
  assert.match(textOf(policyOf("privacy", info())), /To ask, or to complain, write to our grievance officer through the Contact page\./);
  assert.match(terms, /GST at 12% is added/);
  assert.match(terms, /provided by the platform company\./);
  assert.match(terms, /data processor/);
  assert.match(terms, /read-only: you and your staff can still see, print and export everything/);
  assert.match(textOf(policyOf("refunds", info())), /is not refunded, in whole or in part/);
  assert.match(textOf(policyOf("refunds", info())), /free for 9 days/);
  assert.match(textOf(policyOf("privacy", info())), /Data Protection Board of India/);
  // The company's own details, once entered.
  const filled = info({ company: { name: "Acme Soft Private Limited", address: "12 MG Road", city: "Bengaluru", postalCode: "560001", phone: null, email: "hello@acme.invalid", website: null },
    support: { phone: "080 4000 5678", email: null }, grievance: { name: "Meera Rao", email: "grievance@acme.invalid" } });
  const withCompany = textOf(policyOf("terms", filled));
  assert.match(withCompany, /provided by Acme Soft Private Limited, 12 MG Road, Bengaluru 560001\./);
  assert.match(withCompany, /Write to us at hello@acme\.invalid or 080 4000 5678\./);
  assert.match(withCompany, /A complaint goes to our grievance officer, Meera Rao, at grievance@acme\.invalid\./);
  assert.ok(!withCompany.includes("the platform company"));
  assert.match(textOf(policyOf("privacy", filled)), /Write to us at hello@acme\.invalid or 080 4000 5678\./);
  // A grievance officer with no email of their own is reached the same way.
  assert.match(textOf(policyOf("terms", { ...filled, grievance: { name: "Meera Rao", email: null } })), /A complaint goes to our grievance officer, Meera Rao, the same way\./);
  // No trial and no grace days.
  const none = textOf(policyOf("terms", info({ trialDays: 0, graceDays: 0 })));
  assert.match(none, /has no free trial/);
  assert.match(none, /there are no extra days/);
  assert.match(textOf(policyOf("refunds", info({ trialDays: 0 }))), /once your first payment is confirmed/);
});
