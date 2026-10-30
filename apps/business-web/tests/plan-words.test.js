import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENDED, METHODS, ORDER_STATUS, PAYMENT_STATUS, banner, endedNotice, methodWords, moduleBadge, orderSummary, priceText, selectionSummary, stateBadge, standing,
  todayIn, yearlySaving,
} from "../src/modules/plan/planWords.js";

// Your plan's words (modules/plan/planWords.js): the banner every member
// sees in the app's frame (the owner with a link, staff with neither link nor
// price), what the read-only answer says once on a page, a business's state
// on the list of businesses, an order's lines with its GST, the price of a
// choice, and the plan badge of a module in Business tools and Features.

const TODAY = "2026-10-30";
const owner = { isOwner: true, today: TODAY, planPath: "/business-admin/7/plan" };
const staff = { isOwner: false, today: TODAY, planPath: "/business-admin/7/plan" };
const plan = (state, extra = {}) => ({ state, accessEndsOn: null, trialEndsOn: null, graceEndsOn: null, daysLeft: null, ...extra });

test("a free trial: the days left, and the owner's way to choose a plan", () => {
  const trial = plan("trial", { trialEndsOn: "2026-11-07", accessEndsOn: "2026-11-07", daysLeft: 9 });
  assert.deepEqual(banner(trial, owner), {
    tone: "info", urgent: false, text: "Free trial: 9 days left.", action: { label: "Choose your plan", to: "/business-admin/7/plan" },
  });
  assert.deepEqual(banner(trial, staff), { tone: "info", urgent: false, text: "Free trial: 9 days left.", action: null });
  // The last three days are urgent: they show on the billing screens too.
  assert.deepEqual(banner({ ...trial, daysLeft: 3 }, staff), { tone: "warn", urgent: true, text: "Free trial: 3 days left.", action: null });
  assert.equal(banner({ ...trial, daysLeft: 1 }, owner).text, "Free trial: last day today.");
  // Paid or given time already follows the trial: nothing to choose.
  assert.equal(banner({ ...trial, accessEndsOn: "2027-11-07" }, owner), null);
  assert.equal(banner({ ...trial, accessEndsOn: null }, owner), null);
});

test("paid or given time ending within 15 days, and far from its end", () => {
  const paid = plan("paid", { accessEndsOn: "2026-11-12", daysLeft: 14 });
  assert.deepEqual(banner(paid, owner), { tone: "info", urgent: false, text: "Your plan ends on 12 Nov.", action: { label: "Renew", to: "/business-admin/7/plan" } });
  assert.deepEqual(banner(paid, staff), { tone: "info", urgent: false, text: "This business's plan ends on 12 Nov. Ask the owner to renew.", action: null });
  assert.deepEqual(banner({ ...paid, daysLeft: 1 }, owner), { tone: "warn", urgent: true, text: "Your plan ends today.", action: { label: "Renew", to: "/business-admin/7/plan" } });
  assert.equal(banner({ ...paid, accessEndsOn: "2027-01-12", daysLeft: 75 }, owner), null);
  // Given time is arranged by the company: the owner's link opens Your plan, where its contact is.
  const given = plan("given", { accessEndsOn: "2026-11-12", daysLeft: 14 });
  assert.deepEqual(banner(given, owner).action, { label: "Your plan", to: "/business-admin/7/plan" });
  assert.equal(banner(plan("given", { daysLeft: null }), owner), null);
  // A date in another year carries its year.
  assert.equal(banner(plan("paid", { accessEndsOn: "2027-01-05", daysLeft: 8 }), { ...owner, today: "2026-12-29" }).text, "Your plan ends on 5 Jan 2027.");
});

test("grace, a payment being checked, and the end", () => {
  const grace = plan("grace", { accessEndsOn: "2026-10-27", graceEndsOn: "2026-11-03", daysLeft: 5 });
  assert.deepEqual(banner(grace, owner), {
    tone: "warn", urgent: true, text: "Your plan ended on 27 Oct. Renew by 3 Nov to keep billing.", action: { label: "Renew", to: "/business-admin/7/plan" },
  });
  assert.equal(banner(grace, staff).text, "This business's plan ended on 27 Oct. Ask the owner to renew by 3 Nov to keep billing.");
  assert.equal(banner(grace, staff).action, null);

  const checking = banner(plan("checking", { daysLeft: 2 }), owner);
  assert.equal(checking.text, "We are checking your payment. Everything keeps working meanwhile.");
  assert.deepEqual([checking.tone, checking.urgent, checking.action.label], ["info", true, "Your plan"]);
  assert.equal(banner(plan("checking"), staff).text, "The payment for this business's plan is being checked. Everything keeps working meanwhile.");

  assert.equal(ENDED, "This business's plan has ended. You can still see and export everything; renew in Your plan to add or change anything.");
  assert.deepEqual(banner(plan("ended"), owner), { tone: "danger", urgent: true, text: ENDED, action: { label: "Renew", to: "/business-admin/7/plan" } });
  assert.deepEqual(banner(plan("ended"), staff), {
    tone: "danger", urgent: true, text: "This business's plan has ended. You can still see and export everything. Ask the owner to renew to add or change anything.", action: null,
  });
});

test("no banner where there is nothing to say, and never a price", () => {
  assert.equal(banner(null, owner), null);
  for (const state of ["unmanaged", "off"]) assert.equal(banner(plan(state), owner), null);
  assert.equal(banner(plan("paid", { accessEndsOn: "2027-10-29", daysLeft: 365 }), owner), null);
  // An owner with no Your plan to open (a restaurant's, seen from Business Admin by another member) gets no link.
  assert.equal(banner(plan("ended"), { ...owner, planPath: null }).action, null);
  const all = ["trial", "paid", "given", "grace", "checking", "ended"].flatMap((state) => [owner, staff].map((who) => banner(plan(state, { daysLeft: 2, accessEndsOn: "2026-11-01", trialEndsOn: "2026-11-01", graceEndsOn: "2026-11-05" }), who)));
  for (const shown of all.filter(Boolean)) assert.doesNotMatch(shown.text, /₹/);
});

test("the read-only answer, said once on a page: the owner renews, staff ask the owner", () => {
  assert.deepEqual(endedNotice({ isOwner: true }), { text: "This business's plan has ended: renew it to add or change anything.", actionLabel: "Renew" });
  assert.deepEqual(endedNotice({ isOwner: false }), { text: "This business's plan has ended. Ask the owner to renew it.", actionLabel: null });
});

test("a business's state on the list of businesses and on Your plan", () => {
  assert.deepEqual(stateBadge(plan("trial", { daysLeft: 14, trialEndsOn: "2026-11-12" }), { today: TODAY }), { tone: "info", label: "Free trial · 14 days left" });
  assert.deepEqual(stateBadge(plan("trial", { daysLeft: 1 }), { today: TODAY }), { tone: "info", label: "Free trial · last day" });
  assert.deepEqual(stateBadge(plan("paid", { accessEndsOn: "2027-10-29", daysLeft: 365 }), { today: TODAY }), { tone: "success", label: "Paid until 29 Oct 2027" });
  assert.deepEqual(stateBadge(plan("paid", { accessEndsOn: "2026-11-12", daysLeft: 14 }), { today: TODAY }), { tone: "warning", label: "Paid until 12 Nov" });
  assert.deepEqual(stateBadge(plan("given", { accessEndsOn: "2026-12-31", daysLeft: 63 }), { today: TODAY }), { tone: "success", label: "Given until 31 Dec" });
  assert.equal(stateBadge(plan("given"), { today: TODAY }), null);
  assert.deepEqual(stateBadge(plan("grace", { accessEndsOn: "2026-10-27", graceEndsOn: "2026-11-03" }), { today: TODAY }), { tone: "warning", label: "Ended · renew by 3 Nov" });
  assert.deepEqual(stateBadge(plan("checking"), { today: TODAY }), { tone: "info", label: "Payment being checked" });
  assert.deepEqual(stateBadge(plan("ended"), { today: TODAY }), { tone: "danger", label: "Ended · read-only" });
  assert.deepEqual(stateBadge(plan("off"), { today: TODAY }), { tone: "neutral", label: "Switched off" });
  assert.equal(stateBadge(plan("unmanaged"), { today: TODAY }), null);
  assert.equal(stateBadge(null, { today: TODAY }), null);
});

test("where the plan stands, in a sentence for its owner", () => {
  const brand = "Acme Soft";
  assert.equal(standing(plan("trial", { trialEndsOn: "2026-11-12", accessEndsOn: "2026-11-12", daysLeft: 14 }), { today: TODAY, brand }),
    "Free trial until 12 Nov: everything your type of business can use is unlocked. Choose your plan before it ends; nothing is charged until then.");
  assert.equal(standing(plan("trial", { trialEndsOn: "2026-11-12", accessEndsOn: "2027-11-12", daysLeft: 14 }), { today: TODAY, brand }),
    "Free trial until 12 Nov; your plan then runs to 12 Nov 2027.");
  assert.equal(standing(plan("paid", { accessEndsOn: "2027-11-12" }), { today: TODAY, brand }),
    "Paid until 12 Nov 2027. Renewing now adds the next period after that day, so no day is lost.");
  assert.equal(standing(plan("given", { accessEndsOn: "2026-12-31" }), { today: TODAY, brand }), "Your access is arranged by Acme Soft until 31 Dec.");
  assert.equal(standing(plan("given"), { today: TODAY, brand }), "Your access is arranged by Acme Soft, with no end date.");
  assert.equal(standing(plan("grace", { accessEndsOn: "2026-10-27", graceEndsOn: "2026-11-03" }), { today: TODAY, brand }),
    "Your plan ended on 27 Oct. Renew by 3 Nov to keep billing.");
  assert.equal(standing(plan("checking"), { today: TODAY, brand }), "We are checking your payment. Everything keeps working meanwhile.");
  assert.equal(standing(plan("ended"), { today: TODAY, brand }), ENDED);
});

const LINES = [
  { lineNo: 1, itemKind: "plan", itemCode: "grocery_basic", name: "Basic plan", fullPrice: "4999.00", chargedDays: 365, periodDays: 365, amount: "4999.00" },
  { lineNo: 2, itemKind: "module", itemCode: "loyalty", name: "Loyalty points", fullPrice: "1999.00", chargedDays: 365, periodDays: 365, amount: "1999.00" },
];

test("an order's lines, its GST to another state as IGST, and its total", () => {
  const order = { billingPeriod: "year", supplierStateCode: "22", placeOfSupplyCode: "29", gstRate: "18.00", taxable: "6998.00",
    cgst: "0.00", sgst: "0.00", igst: "1259.64", total: "8257.64", lines: LINES };
  assert.deepEqual(orderSummary(order), [
    { key: "line-1", label: "Basic plan", detail: "a year", amount: "₹4,999.00", total: false },
    { key: "line-2", label: "Loyalty points", detail: "a year", amount: "₹1,999.00", total: false },
    { key: "taxable", label: "Taxable value", detail: "", amount: "₹6,998.00", total: false },
    { key: "igst", label: "IGST 18%", detail: "", amount: "₹1,259.64", total: false },
    { key: "total", label: "Total", detail: "", amount: "₹8,257.64", total: true },
  ]);
});

test("an add-on for the days left, its GST within the state as CGST and SGST", () => {
  const order = { billingPeriod: "year", supplierStateCode: "29", placeOfSupplyCode: "29", gstRate: "18.00", taxable: "547.70",
    cgst: "49.29", sgst: "49.29", igst: "0.00", total: "646.28",
    lines: [{ lineNo: 1, itemKind: "module", itemCode: "offers", name: "Offers & coupons", fullPrice: "1999.00", chargedDays: 100, periodDays: 365, amount: "547.70" }] };
  assert.deepEqual(orderSummary(order).map((row) => [row.label, row.detail, row.amount]), [
    ["Offers & coupons", "100 of 365 days", "₹547.70"],
    ["Taxable value", "", "₹547.70"],
    ["CGST 9%", "", "₹49.29"],
    ["SGST 9%", "", "₹49.29"],
    ["Total", "", "₹646.28"],
  ]);
  assert.equal(orderSummary({ ...order, gstRate: "5.00" })[2].label, "CGST 2.5%");
});

const VIEW = {
  plan: { state: "trial", trialEndsOn: "2026-11-12", accessEndsOn: "2026-11-12", everything: true, daysLeft: 14 },
  selection: { planCode: "grocery_basic", billingPeriod: "year", addons: [{ code: "loyalty" }] },
  catalogue: {
    plans: [{ code: "grocery_basic", name: "Basic", monthly: "499.00", yearly: "4999.00", modules: [{ code: "receivables", name: "Customer credit" }] }],
    addons: [
      { code: "receivables", name: "Customer credit", soldAs: "module", monthly: "199.00", yearly: "1999.00", available: true },
      { code: "loyalty", name: "Loyalty points", soldAs: "module", monthly: "199.00", yearly: "1999.00", available: true },
      { code: "offers", name: "Offers & coupons", soldAs: "module", monthly: "199.00", yearly: "1999.00", available: true },
      { code: "lab", name: "Laboratory", soldAs: "application", monthly: "499.00", yearly: null, available: true },
      { code: "kits", name: "Kits", soldAs: "module", monthly: "199.00", yearly: "1999.00", available: false },
    ],
  },
  gstRate: "18.00",
};

test("the price of a choice: the plan and its add-ons for a month or a year, before GST", () => {
  const { catalogue } = VIEW;
  assert.deepEqual(selectionSummary({ catalogue, planCode: "grocery_basic", billingPeriod: "year", addons: ["loyalty"], gstRate: "18.00" }),
    { amount: "6998.00", missing: [], text: "₹6,998 + 18% GST a year" });
  assert.deepEqual(selectionSummary({ catalogue, planCode: "grocery_basic", billingPeriod: "month", addons: [], gstRate: "18.00", trialEndsOn: "2026-11-12", today: TODAY }),
    { amount: "499.00", missing: [], text: "Free until 12 Nov, then ₹499 + 18% GST a month" });
  // An add-on the plan includes is not charged again; one with no price for the period cannot be bought yet.
  assert.equal(selectionSummary({ catalogue, planCode: "grocery_basic", billingPeriod: "year", addons: ["receivables"], gstRate: "18.00" }).amount, "4999.00");
  assert.deepEqual(selectionSummary({ catalogue, planCode: "grocery_basic", billingPeriod: "year", addons: ["lab"], gstRate: "18.00" }).missing, ["Laboratory"]);
  assert.deepEqual(selectionSummary({ catalogue, planCode: "nothing", billingPeriod: "year", addons: [], gstRate: "18.00" }).missing, ["a plan"]);
});

test("plan badges on Business tools and Features: in the trial by the choice and its prices, after it by what the plan unlocks", () => {
  const optional = (code, inPlan = true) => ({ code, kind: "optional", inPlan });
  const trial = { plan: VIEW.plan, view: VIEW, isOwner: true };
  assert.deepEqual(moduleBadge(optional("receivables"), trial), { kind: "in_plan", tone: "success", label: "In your plan" });
  assert.deepEqual(moduleBadge(optional("loyalty"), trial), { kind: "in_plan", tone: "success", label: "In your plan" });
  assert.deepEqual(moduleBadge(optional("offers"), trial), { kind: "addon", tone: "info", label: "Add-on · ₹1,999/year after the trial" });
  const monthly = { ...VIEW, selection: { ...VIEW.selection, billingPeriod: "month" } };
  assert.deepEqual(moduleBadge(optional("offers"), { ...trial, view: monthly }).label, "Add-on · ₹199/month after the trial");
  assert.deepEqual(moduleBadge(optional("lab"), trial), { kind: "addon", tone: "info", label: "Add-on after the trial · price not set yet" });
  assert.deepEqual(moduleBadge(optional("kits"), trial), { kind: "addon", tone: "neutral", label: "After the trial: ask us to add it" });
  // Staff see no prices: nothing during the trial.
  assert.equal(moduleBadge(optional("offers"), { plan: VIEW.plan, view: null, isOwner: false }), null);
  // The module everyone always has.
  assert.equal(moduleBadge({ code: "sales", kind: "core", inPlan: true }, trial), null);

  const paidPlan = { state: "paid", accessEndsOn: "2027-10-29", everything: false, daysLeft: 365 };
  const paid = { plan: paidPlan, view: { ...VIEW, plan: paidPlan }, isOwner: true };
  assert.deepEqual(moduleBadge(optional("offers", false), paid), { kind: "not_in_plan", tone: "warning", label: "Not in your plan" });
  assert.deepEqual(moduleBadge(optional("loyalty", true), paid), { kind: "in_plan", tone: "success", label: "In your plan" });
  // Staff learn why a switch is off, with no link and no price.
  assert.deepEqual(moduleBadge(optional("offers", false), { plan: { state: "paid" }, view: null, isOwner: false }), { kind: "not_in_plan", tone: "warning", label: "Not in your plan" });
  assert.equal(moduleBadge(optional("loyalty", true), { plan: { state: "paid" }, view: null, isOwner: false }), null);
  // Time that unlocks everything (a business set up before plans began) needs no badge.
  const everything = { state: "given", accessEndsOn: null, everything: true };
  assert.equal(moduleBadge(optional("offers", true), { plan: everything, view: { ...VIEW, plan: everything }, isOwner: true }), null);
  for (const state of ["unmanaged", "off"]) assert.equal(moduleBadge(optional("offers", false), { plan: { state }, view: null, isOwner: true }), null);
  assert.equal(moduleBadge(optional("offers", false), { plan: null, view: null, isOwner: true }), null);
});

test("prices, a year's saving, payment methods and statuses in words", () => {
  assert.equal(priceText("4999.00", "year"), "₹4,999 a year");
  assert.equal(priceText("199.50", "month"), "₹199.50 a month");
  assert.equal(priceText(null, "year"), "Price not set yet");
  assert.equal(yearlySaving({ monthly: "499.00", yearly: "4999.00" }), "989.00");
  assert.equal(yearlySaving({ monthly: "499.00", yearly: "5988.00" }), null);
  assert.equal(yearlySaving({ monthly: null, yearly: "4999.00" }), null);
  assert.deepEqual(METHODS.map(([code]) => code), ["upi", "bank", "cash", "cheque"]);
  assert.equal(methodWords("bank"), "Bank transfer");
  assert.equal(methodWords("upi"), "UPI");
  assert.deepEqual(PAYMENT_STATUS.pending, { tone: "warning", label: "Being checked" });
  assert.deepEqual(PAYMENT_STATUS.rejected, { tone: "danger", label: "Not confirmed" });
  assert.deepEqual(ORDER_STATUS.open, { tone: "info", label: "To pay" });
});

test("today on the business's own clock", () => {
  // 20:00 in London on 30 October is 01:30 on the 31st in India.
  const moment = new Date("2026-10-30T20:00:00Z");
  assert.equal(todayIn("Asia/Kolkata", moment), "2026-10-31");
  assert.equal(todayIn("America/Los_Angeles", moment), "2026-10-30");
  // An unknown zone falls back to India's.
  assert.equal(todayIn("Not/AZone", moment), "2026-10-31");
});
