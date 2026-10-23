// Words and small helpers shared by the fashion and electronics screens.

// "S, M, L" or "S M L" → ["S", "M", "L"] (commas win when present, so "Sky blue, White" keeps its spaces).
export const splitList = (text) => {
  const raw = String(text || "");
  const parts = raw.includes(",") ? raw.split(",") : raw.split(/\s+/);
  const seen = new Set();
  return parts.map((p) => p.trim()).filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()));
};

export const SIZE_PRESETS = [
  { label: "S–XXL", value: "S, M, L, XL, XXL" },
  { label: "Waist 28–38", value: "28, 30, 32, 34, 36, 38" },
  { label: "Kids 2–12Y", value: "2-3Y, 4-5Y, 6-7Y, 8-9Y, 10-11Y, 12-13Y" },
  { label: "Free size", value: "Free size" },
];

const METHOD_WORDS = { cash: "Cash", card: "Card", upi: "UPI", bank: "Bank transfer", cheque: "Cheque", credit_note: "Credit note", on_account: "Kept on account" };
export const methodWord = (method) => METHOD_WORDS[method] || method || "—";

// A whole-number quantity for display: 12, 2.5.
export const qty = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });

export const REPAIR_STATES = {
  received: ["info", "Received"], diagnosing: ["info", "Diagnosing"], waiting_parts: ["warning", "Waiting for parts"],
  in_repair: ["warning", "In repair"], awaiting_approval: ["danger", "Awaiting approval"], ready: ["active", "Ready for pickup"], delivered: ["neutral", "Delivered"], cancelled: ["inactive", "Cancelled"],
};

// A refusal raised in the browser, shaped like the server's so forms show its sentence.
export const refuse = (message) => Object.assign(new Error(message), { response: { data: { message } } });

// A date ("2027-10-05" or a timestamp) in the business's own date format
// (Business settings › Prices, totals and numbering).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function businessDate(value, format = "DD/MM/YYYY") {
  if (!value) return "—";
  const text = String(value);
  const [y, m, d] = (/^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date(text).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })).split("-");
  if (format === "YYYY-MM-DD") return `${y}-${m}-${d}`;
  if (format === "DD-MM-YYYY") return `${d}-${m}-${y}`;
  if (format === "DD MMM YYYY") return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
  return `${d}/${m}/${y}`;
}

// One row for Barcode labels: the garment tag needs the style, size and colour.
export const labelOf = (v, product, copies) => ({ id: v.sku_id, label: v.label, code: v.code, barcode: v.barcode, price: v.price, mrp: v.mrp, unit: v.unit,
  size: v.size, color: v.color, brand: product?.brand || "", style: product?.name || product?.product_name || "", copies: String(copies) });
