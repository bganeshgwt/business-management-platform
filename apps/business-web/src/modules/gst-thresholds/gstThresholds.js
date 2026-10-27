// An owner's GST thresholds: the words the screens use, without React. The
// figures (₹5 crore, ₹10 crore, the 30 days, the 6 digits) and the sentence
// for each step come from the server, which keeps them as platform data.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Where a PAN's turnover stands against a figure: passed (by last year's
// turnover its rules apply now; by this year's so far, from the next 1 April,
// the step's appliesFrom), nearing it, or below it.
export const STATES = {
  crossed: { tone: "danger", label: "Applies now" },
  near: { tone: "warning", label: "Nearing" },
  below: { tone: "success", label: "Below" },
};
// Applying now, then from the next 1 April, then nearing, then below.
const level = (step) => (step.state === "crossed" ? (step.appliesFrom ? 2 : 3) : step.state === "near" ? 1 : 0);

// A step's badge: "Applies now", "Applies from 1 Apr 2027", "Nearing" or "Below".
export function stepBadge(step) {
  if (step.state === "crossed" && step.appliesFrom) return { tone: "danger", label: `Applies from ${dayWords(step.appliesFrom)}` };
  return STATES[step.state] || STATES.below;
}

// The most serious step of a group: applying now before applying from a date,
// before nearing; the higher figure first. null when every step is below.
export function mostSerious(steps = []) {
  let worst = null;
  for (const step of steps) {
    if (level(step) === 0) continue;
    if (!worst || level(step) > level(worst) || (level(step) === level(worst) && Number(step.turnover) > Number(worst.turnover))) worst = step;
  }
  return worst;
}
export const groupState = (steps) => mostSerious(steps)?.state || "below";
// A group's badge: its most serious step's, or "Below every figure".
export function groupBadge(steps) {
  const worst = mostSerious(steps);
  return worst ? stepBadge(worst) : { tone: STATES.below.tone, label: "Below every figure" };
}

// "27 Oct 2026", read from a YYYY-MM-DD day as it is (no time zone moves it).
export function dayWords(day) {
  if (!day) return "";
  const [y, m, d] = String(day).slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
// "1 April 2027", for a sentence.
export function longDayWords(day) {
  if (!day) return "";
  const [y, m, d] = String(day).slice(0, 10).split("-").map(Number);
  return `${d} ${LONG_MONTHS[m - 1]} ${y}`;
}

// When 6-digit codes are asked of invoices: "now", or "from 1 April 2027".
export const hsnWhen = (hsn) => (hsn?.from ? `from ${longDayWords(hsn.from)}` : "now");
// The first day of the financial year after this one ({ to: "2027-03-31" }): "2027-04-01".
export const yearAfterFrom = (year) => `${String(year.to).slice(0, 4)}-04-01`;

// When a figure applies from: its first day, or in force with none recorded.
export const fromWords = (day) => (day ? `From ${dayWords(day)}` : "In force; its first date is not recorded");

// "Above ₹5 crore" or "₹10 crore or more", from the figure and how it is measured.
export function figureWords(turnover, comparison) {
  const value = Number(turnover) / 1e7;
  const figure = `₹${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, "")} crore`;
  return comparison === "above" ? `Above ${figure}` : `${figure} or more`;
}

// Where a business's PAN comes from, in words.
export function sourceWords(business) {
  if (business.source === "gstin") return `From its GSTIN${business.gstins.length === 1 ? "" : "s"} ${business.gstins.join(", ")}`;
  if (business.source === "recorded") return "Recorded by you: it has no GSTIN";
  return "";
}

// Why a business is not linked to a PAN, and what to do.
export function reasonWords(business) {
  if (business.reason === "gstins_differ") return `Its GSTINs carry different PANs (${business.pans.join(" and ")}): correct the one that is wrong in its settings.`;
  if (business.reason === "gstin_invalid") return `Its GST number ${business.gstins[0]} is not a valid GSTIN: correct it in its settings, or record its PAN.`;
  return "No GSTIN, and no PAN recorded: record the PAN it trades under, or add its GSTIN in its settings.";
}

// A PAN is recorded only for a business with no GSTIN.
export const canRecord = (business) => business.source !== "gstin" && business.reason !== "gstins_differ";

// Where a business's HSN / SAC codes are fixed: a shop's items, a restaurant's tax rates.
export const fixPath = (business) => (business.restaurant ? "/menu/tax-rates" : `/business-admin/${business.id}/products`);

// The warning level typed: a whole percent from 50 to 99, or null.
export function readWarnPercent(text) {
  const value = String(text ?? "").trim();
  if (!/^\d{2}$/.test(value)) return null;
  const level = Number(value);
  return level >= 50 && level <= 99 ? level : null;
}

// What a PAN typed looks like once tidied (the server decides).
export const tidyPan = (text) => String(text ?? "").replace(/\s/g, "").toUpperCase();
export const panShaped = (text) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(tidyPan(text));
