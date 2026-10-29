import { atFull, atWords, nowInput, zonedDay, zonedInput } from "../../rentals/pages/rentals";

// Fuel stations: the words, figures and times the shift, tank, tanker,
// register, fleet and pumps screens share. The server works out and checks
// every figure again (backend fuel services); these only show and prepare
// them. Readings are typed in from the totalisers, the dip rod and the
// hydrometer: nothing here talks to a dispenser, a forecourt controller or a
// tank gauge. Times are instants shown and typed on the business's clock.

export { atFull, atWords, nowInput, zonedDay, zonedInput };

// A fuel station with its tanks, nozzles & shifts on.
export const usesFuel = (biz) => biz.type === "fuel_station" && biz.has("fuel");
// The outlet a screen opens on: the one picked in the top bar, the person's own, else the first.
export const firstOutlet = (biz) => String(biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id || "");

export const FAMILIES = [{ value: "petrol", label: "Petrol" }, { value: "diesel", label: "Diesel" }, { value: "cng", label: "CNG (sold by the kg)" }];
export const familyWord = (family) => ({ petrol: "Petrol", diesel: "Diesel", cng: "CNG" }[family] || family || "");

// "1,234.500 L", "120.250 kg"; "—" for nothing.
export const qty = (value, unit) => (value === null || value === undefined || value === ""
  ? "—" : `${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${unit === "kg" ? "kg" : "L"}`);
// A totaliser reading as the meter shows it: "1,00,500.500".
export const reading = (value) => (value === null || value === undefined || value === ""
  ? "—" : Number(value).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
// "745.5 kg/m³".
export const densityText = (value) => (value === null || value === undefined || value === "" ? "—" : `${Number(value).toFixed(1)} kg/m³`);
// "+2.5", "−6.5", "0.0".
export const signed = (value, digits = 1) => {
  const n = Number(value);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;
};
// "−505.000 L (−4.21%)".
export const variationText = (row, unit) => (row.variation === null || row.variation === undefined ? "—"
  : `${signed(row.variation, 3)} ${unit === "kg" ? "kg" : "L"}${row.percent === null ? "" : ` (${signed(row.percent, 2)}%)`}`);

// The lorry's density against the invoice's, in tenths of a kg/m³ as the
// server checks it: { difference, within }, or null while either is not typed.
const tenths = (value) => Math.round(Number(value) * 10);
export function densityCheck(invoice, receipt, tolerance) {
  const typed = (x) => x !== "" && x !== null && x !== undefined && Number.isFinite(Number(x)) && Number(x) > 0;
  if (!typed(invoice) || !typed(receipt)) return null;
  const difference = tenths(receipt) - tenths(invoice);
  return { difference: difference / 10, within: Math.abs(difference) <= tenths(tolerance) };
}
// What a tank took in by its dips, and how short of the invoice that is.
export function dipsCheck(invoiceLitres, before, after) {
  const typed = (x) => x !== "" && x !== null && x !== undefined && Number.isFinite(Number(x));
  if (!typed(invoiceLitres) || !typed(before) || !typed(after)) return null;
  const thousandths = (x) => Math.round(Number(x) * 1000);
  const received = thousandths(after) - thousandths(before);
  return { received: received / 1000, short: (thousandths(invoiceLitres) - received) / 1000 };
}

// Where an attendant's money stands against the walk-in sales.
export function settlement(difference, exact) {
  const d = Number(difference);
  if (d < 0) return { label: `Short ${exact(-d)}`, tone: "danger" };
  if (d > 0) return { label: `Excess ${exact(d)}`, tone: "warning" };
  return { label: "Exact", tone: "success" };
}

// A day of the stock register against the tolerance.
export const FLAGS = {
  within: { label: "Within tolerance", tone: "success" },
  loss: { label: "Loss beyond tolerance", tone: "warning" },
  gain: { label: "Gain beyond tolerance", tone: "danger" },
  open: { label: "Next dip to come", tone: "neutral" },
};
export const UNIT_STATES = { in_use: { label: "In use", tone: "success" }, suspended: { label: "Suspended", tone: "warning" }, retired: { label: "Retired", tone: "neutral" } };
export const RECEIPT_STATES = { accepted: { label: "Accepted", tone: "success" }, refused: { label: "Refused", tone: "danger" }, cancelled: { label: "Cancelled", tone: "neutral" } };
export const SHIFT_STATES = { open: { label: "Open", tone: "info" }, closed: { label: "Closed", tone: "neutral" } };

// A Weights & Measures stamping: "falls due in 12 days", "fell due 3 days ago".
export function dueWords(days) {
  const n = Number(days);
  if (n === 0) return "falls due today";
  if (n === 1) return "falls due tomorrow";
  if (n > 1) return `falls due in ${n} days`;
  if (n === -1) return "fell due yesterday";
  return `fell due ${-n} days ago`;
}
export const stampingTone = (days, warn) => (Number(days) < 0 ? "danger" : Number(days) <= Number(warn) ? "warning" : "success");

// "26 Oct 2026" from "2026-10-26" (a calendar day, no clock).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const dayWords = (day) => {
  if (!day) return "—";
  const [y, m, d] = String(day).slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};
// A month as people say it: "October 2026" from "2026-10".
export const monthWords = (month) => {
  const [y, m] = String(month).split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
};
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// The litres a tank's chart gives at a dip (cm), by a straight line between
// the two rows around it, to the millilitre as the server reads it; null
// while the dip is not typed or is outside the chart. rows: [{ cm, litres }].
export function chartLitres(rows, dipCm) {
  const text = String(dipCm ?? "").trim();
  if (!/^\d+(\.\d)?$/.test(text) || !rows.length) return null;
  const tenths = (x) => Math.round(Number(x) * 10);
  const cm = tenths(text);
  const chart = rows.map((r) => ({ cm: tenths(r.cm), litres: Math.round(Number(r.litres) * 1000) }));
  if (cm < chart[0].cm || cm > chart.at(-1).cm) return null;
  const upper = chart.findIndex((r) => r.cm >= cm);
  if (chart[upper].cm === cm) return chart[upper].litres / 1000;
  const low = chart[upper - 1], high = chart[upper];
  return (low.litres + Math.round(((high.litres - low.litres) * (cm - low.cm)) / (high.cm - low.cm))) / 1000;
}

export const METHOD_WORDS = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", cheque: "Cheque" };
export const methodName = (row) => row.method_name || row.methodName || METHOD_WORDS[row.method] || row.method || "";
// The takings a shift hands in besides cash: UPI, cards (an oil company's fleet card is one) and bank transfers.
export const TAKING_KINDS = ["upi", "card", "bank"];

export const VAT_NOTE = "Petrol, diesel and CNG are outside GST: they are on the GST nil slab, and each fuel bill line says the price includes state VAT.";
export const TEST_NOTE = "The 5-litre test: fuel drawn into the stamped measure to check the nozzle and poured back into the tank. It is not a sale.";
export const FLEET_CARD_NOTE = "An oil company's fleet or loyalty card is not the station's credit: it is taken as a payment method with the shift's takings, "
  + "and settled by the oil company.";
export const densityNote = (tolerance) => `The lorry's density at 15 °C is within ${Number(tolerance).toFixed(1)} kg/m³ of the invoice's, either way. `
  + "Outside that the load is refused, or a manager accepts it saying why.";
