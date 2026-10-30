// Your plan's words, without React (so a test runs them outside the bundler):
// the banner in the app's frame, what the read-only answer says once on a
// page, a business's state in a few words, an order's lines with its GST, the
// price of a choice, and a module's plan badge in Business tools and
// Features. Every member sees the banner; only the owner gets a link, and
// nobody but the owner a price: staff see the state and its dates alone.
import { dateShort, money, moneyExact } from "@bmp/shared/format";

// The read-only answer's own sentence (the server's, middlewares/planGuard.js).
export const ENDED = "This business's plan has ended. You can still see and export everything; renew in Your plan to add or change anything.";
const STAFF_ENDED = "This business's plan has ended. You can still see and export everything. Ask the owner to renew to add or change anything.";
const CHECKING = "We are checking your payment. Everything keeps working meanwhile.";
const STAFF_CHECKING = "The payment for this business's plan is being checked. Everything keeps working meanwhile.";

// Time with an end shows a banner from 15 days before it; the last 3 days
// are urgent, and show on the billing screens too.
const SOON = 15;
const LAST_DAYS = 3;

const PERIOD = { month: "a month", year: "a year" };
const PER = { month: "month", year: "year" };

// "12 Nov" this year, "5 Jan 2027" in another; `today` is "YYYY-MM-DD".
const day = (date, today) => dateShort(date, { now: today ? new Date(`${today}T00:00:00`) : Date.now() });

// "18.00" -> "18%", 9 -> "9%", 2.5 -> "2.5%".
export const percent = (value) => `${Number(Number(value).toFixed(2))}%`;

// A price before GST for a month or a year: "₹4,999 a year", "₹199.50 a month".
export const priceText = (value, billingPeriod) => (value === null || value === undefined ? "Price not set yet" : `${money(value)} ${PERIOD[billingPeriod] || ""}`.trim());
export const periodWords = (billingPeriod) => PERIOD[billingPeriod] || "";

// What a year saves against twelve months of the same plan, in rupees ("989.00"), or null.
export function yearlySaving(plan) {
  if (!plan || plan.monthly === null || plan.monthly === undefined || plan.yearly === null || plan.yearly === undefined) return null;
  const saved = Math.round(Number(plan.monthly) * 100) * 12 - Math.round(Number(plan.yearly) * 100);
  return saved > 0 ? (saved / 100).toFixed(2) : null;
}

// How an owner paid the company, as the "I have paid" form offers it.
export const METHODS = [["upi", "UPI"], ["bank", "Bank transfer"], ["cash", "Cash"], ["cheque", "Cheque"]];
export const methodWords = (code) => Object.fromEntries(METHODS)[code] || code;
export const PAYMENT_STATUS = {
  pending: { tone: "warning", label: "Being checked" },
  confirmed: { tone: "success", label: "Confirmed" },
  rejected: { tone: "danger", label: "Not confirmed" },
};
export const ORDER_STATUS = {
  open: { tone: "info", label: "To pay" },
  paid: { tone: "success", label: "Paid" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

// Today's date ("YYYY-MM-DD") on a business's own clock; India's when the
// zone is not one the browser knows.
export function todayIn(timeZone, now = new Date()) {
  const read = (zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return read(timeZone || "Asia/Kolkata");
  } catch {
    return read("Asia/Kolkata");
  }
}

// The banner for the plan's state (business_plan_state, as the business's
// context and the restaurant's profile carry it, never with prices), or null
// when there is nothing to say. `isOwner` gets the link to Your plan
// (`planPath`), when there is one to open; `urgent` banners show on the
// billing screens too.
export function banner(plan, { isOwner = false, today, planPath = null } = {}) {
  if (!plan) return null;
  const link = (label) => (isOwner && planPath ? { label, to: planPath } : null);
  const days = plan.daysLeft;
  switch (plan.state) {
    case "trial": {
      // Paid or given time follows the trial already: nothing to choose.
      if (plan.accessEndsOn === null || (plan.trialEndsOn && plan.accessEndsOn > plan.trialEndsOn)) return null;
      const urgent = days !== null && days !== undefined && days <= LAST_DAYS;
      const text = days > 1 ? `Free trial: ${days} days left.` : days === 1 ? "Free trial: last day today." : "Free trial.";
      return { tone: urgent ? "warn" : "info", urgent, text, action: link("Choose your plan") };
    }
    case "paid":
    case "given": {
      if (!plan.accessEndsOn || days === null || days === undefined || days > SOON) return null;
      const urgent = days <= LAST_DAYS;
      const when = days > 1 ? `ends on ${day(plan.accessEndsOn, today)}` : "ends today";
      return {
        tone: urgent ? "warn" : "info", urgent,
        text: isOwner ? `Your plan ${when}.` : `This business's plan ${when}. Ask the owner to renew.`,
        // Given time is arranged by the company: Your plan says whom to ask.
        action: link(plan.state === "paid" ? "Renew" : "Your plan"),
      };
    }
    case "grace": {
      const ended = day(plan.accessEndsOn, today);
      const by = day(plan.graceEndsOn, today);
      return {
        tone: "warn", urgent: true,
        text: isOwner ? `Your plan ended on ${ended}. Renew by ${by} to keep billing.` : `This business's plan ended on ${ended}. Ask the owner to renew by ${by} to keep billing.`,
        action: link("Renew"),
      };
    }
    case "checking":
      return { tone: "info", urgent: true, text: isOwner ? CHECKING : STAFF_CHECKING, action: link("Your plan") };
    case "ended":
      return { tone: "danger", urgent: true, text: isOwner ? ENDED : STAFF_ENDED, action: link("Renew") };
    default:
      return null;
  }
}

// What a refused write (402 plan_ended) says once on a page, beside the
// screen's own error: the owner renews, staff ask the owner.
export const endedNotice = ({ isOwner = false } = {}) => (isOwner
  ? { text: "This business's plan has ended: renew it to add or change anything.", actionLabel: "Renew" }
  : { text: "This business's plan has ended. Ask the owner to renew it.", actionLabel: null });

// A business's state in a few words, with the StatusBadge tone: the list of
// businesses and the top of Your plan. null when there is nothing to say
// (given time with no end, a business made outside the app).
export function stateBadge(plan, { today } = {}) {
  if (!plan) return null;
  const days = plan.daysLeft;
  const soon = days !== null && days !== undefined && days <= SOON;
  switch (plan.state) {
    case "trial": return { tone: "info", label: days > 1 ? `Free trial · ${days} days left` : "Free trial · last day" };
    case "paid": return { tone: soon ? "warning" : "success", label: `Paid until ${day(plan.accessEndsOn, today)}` };
    case "given": return plan.accessEndsOn ? { tone: soon ? "warning" : "success", label: `Given until ${day(plan.accessEndsOn, today)}` } : null;
    case "grace": return { tone: "warning", label: `Ended · renew by ${day(plan.graceEndsOn, today)}` };
    case "checking": return { tone: "info", label: "Payment being checked" };
    case "ended": return { tone: "danger", label: "Ended · read-only" };
    case "off": return { tone: "neutral", label: "Switched off" };
    default: return null;
  }
}

// Where the plan stands, in a sentence for its owner (the top of Your plan).
export function standing(plan, { today, brand = "us" } = {}) {
  if (!plan) return "";
  switch (plan.state) {
    case "trial":
      if (plan.accessEndsOn === null) return `Free trial until ${day(plan.trialEndsOn, today)}; your access then continues with no end date.`;
      if (plan.accessEndsOn > plan.trialEndsOn) return `Free trial until ${day(plan.trialEndsOn, today)}; your plan then runs to ${day(plan.accessEndsOn, today)}.`;
      return `Free trial until ${day(plan.trialEndsOn, today)}: everything your type of business can use is unlocked. Choose your plan before it ends; nothing is charged until then.`;
    case "paid":
      return `Paid until ${day(plan.accessEndsOn, today)}. Renewing now adds the next period after that day, so no day is lost.`;
    case "given":
      return plan.accessEndsOn ? `Your access is arranged by ${brand} until ${day(plan.accessEndsOn, today)}.` : `Your access is arranged by ${brand}, with no end date.`;
    case "grace":
      return `Your plan ended on ${day(plan.accessEndsOn, today)}. Renew by ${day(plan.graceEndsOn, today)} to keep billing.`;
    case "checking":
      return CHECKING;
    case "ended":
      return ENDED;
    case "off":
      return `This business is switched off. Contact ${brand} to switch it on again.`;
    default:
      return "This business is not on a plan: nothing is charged for it.";
  }
}

// An order as the screen lists it: each line (an add-on bought mid-period
// says the days it is charged for), the taxable value, the GST (CGST and SGST
// within the company's state, IGST to another) and the total.
export function orderSummary(order) {
  const row = (key, label, amount, { detail = "", total = false } = {}) => ({ key, label, detail, amount: moneyExact(amount), total });
  const lines = (order.lines || []).map((line) => row(`line-${line.lineNo}`, line.name, line.amount, {
    detail: Number(line.chargedDays) < Number(line.periodDays) ? `${line.chargedDays} of ${line.periodDays} days` : periodWords(order.billingPeriod),
  }));
  const rate = Number(order.gstRate);
  const tax = order.supplierStateCode === order.placeOfSupplyCode
    ? [row("cgst", `CGST ${percent(rate / 2)}`, order.cgst), row("sgst", `SGST ${percent(rate / 2)}`, order.sgst)]
    : [row("igst", `IGST ${percent(rate)}`, order.igst)];
  return [...lines, row("taxable", "Taxable value", order.taxable), ...tax, row("total", "Total", order.total, { total: true })];
}

// What a choice comes to for its month or year, before GST: the plan and the
// add-ons it does not include already. `missing` names what has no price for
// the period yet (it cannot be bought until it has one).
export function selectionSummary({ catalogue, planCode, billingPeriod, addons = [], gstRate, trialEndsOn = null, today } = {}) {
  const plan = (catalogue?.plans || []).find((item) => item.code === planCode);
  if (!plan) return { amount: null, missing: ["a plan"], text: "Choose a plan to see its price." };
  const priceOf = (item) => (billingPeriod === "month" ? item.monthly : item.yearly);
  const included = new Set((plan.modules || []).map((module) => module.code));
  const chosen = (catalogue.addons || []).filter((addon) => addons.includes(addon.code) && !included.has(addon.code));
  const missing = [plan, ...chosen].filter((item) => priceOf(item) === null || priceOf(item) === undefined).map((item) => item.name);
  if (missing.length) return { amount: null, missing, text: `Price not set yet for ${missing.join(", ")}` };
  const paise = [plan, ...chosen].reduce((sum, item) => sum + Math.round(Number(priceOf(item)) * 100), 0);
  const amount = (paise / 100).toFixed(2);
  const price = `${money(amount)} + ${percent(gstRate)} GST ${PERIOD[billingPeriod]}`;
  return { amount, missing, text: trialEndsOn ? `Free until ${day(trialEndsOn, today)}, then ${price}` : price };
}

const IN_PLAN = { kind: "in_plan", tone: "success", label: "In your plan" };

// A module's plan badge in Business tools and Features, or null. During the
// trial, for the owner (who has the plan's prices, `view`: Your plan's
// answer): in the choice for after the trial, or an add-on at its price after
// it. After the trial: "Not in your plan" for a module the plan does not
// unlock (anyone may see why its switch is off), and "In your plan" for the
// owner when the plan unlocks a list of modules rather than everything.
// `module`: { code, kind, inPlan }.
export function moduleBadge(module, { plan, view, isOwner = false } = {}) {
  if (!module || module.kind === "core" || !plan || ["unmanaged", "off"].includes(plan.state)) return null;
  if (plan.state === "trial") {
    if (!isOwner || !view) return null;
    const { selection, catalogue } = view;
    const chosenPlan = (catalogue.plans || []).find((item) => item.code === selection.planCode);
    const included = new Set([...(chosenPlan?.modules || []).map((item) => item.code), ...(selection.addons || []).map((item) => item.code)]);
    if (included.has(module.code)) return IN_PLAN;
    const addon = (catalogue.addons || []).find((item) => item.code === module.code);
    if (!addon) return null;
    if (!addon.available) return { kind: "addon", tone: "neutral", label: "After the trial: ask us to add it" };
    const price = selection.billingPeriod === "month" ? addon.monthly : addon.yearly;
    if (price === null || price === undefined) return { kind: "addon", tone: "info", label: "Add-on after the trial · price not set yet" };
    return { kind: "addon", tone: "info", label: `Add-on · ${money(price)}/${PER[selection.billingPeriod]} after the trial` };
  }
  if (module.inPlan === false) return { kind: "not_in_plan", tone: "warning", label: "Not in your plan" };
  if (isOwner && view && view.plan && !view.plan.everything) return IN_PLAN;
  return null;
}
