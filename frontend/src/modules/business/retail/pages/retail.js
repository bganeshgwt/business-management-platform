import { printTaxInvoice } from "../../core/pages/invoice";
import { dateShort } from "../../../../services/format";

// Shared by the retail screens (Quick bill, Udhaar, Offers, Loyalty, Books,
// Barcode labels, Retail reports): words, receipt printing and messages.

export const RETAIL_TYPES = ["grocery", "supermarket", "books"];
export { GOODS as GOODS_TYPES } from "../../../../services/businessNav";
export const METHOD_WORDS = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", cheque: "Cheque", credit_note: "Credit note", finance: "EMI (financier)" };
export const methodWord = (method) => METHOD_WORDS[method] || method;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const OFFER_KINDS = {
  item_percent: "% off an item",
  item_amount: "₹ off each unit of an item",
  category_percent: "% off a category",
  bill_percent: "% off the bill",
  bill_amount: "₹ off the bill",
  buy_x_get_y: "Buy X, get Y",
};

const trimNumber = (value) => Number(value).toLocaleString("en-IN", { maximumFractionDigits: 3 });

// "10% off Detergent powder 1 kg", "Buy 4 get 1 free", "₹50 off bills over ₹1,000".
export function offerSummary(offer, amount) {
  const value = Number(offer.value);
  const minimum = Number(offer.min_bill_amount) > 0 ? ` on bills of ${amount(offer.min_bill_amount)} or more` : "";
  switch (offer.kind) {
    case "item_percent": return `${trimNumber(value)}% off ${offer.sku_label || "the item"}${minimum}`;
    case "item_amount": return `${amount(value)} off each ${offer.sku_label || "unit"}${minimum}`;
    case "category_percent": return `${trimNumber(value)}% off everything in ${offer.category_name || "the category"}${minimum}`;
    case "bill_percent": return `${trimNumber(value)}% off the bill${minimum}`;
    case "bill_amount": return `${amount(value)} off the bill${minimum}`;
    case "buy_x_get_y": return `Buy ${trimNumber(offer.buy_quantity)} ${offer.sku_label || ""}, get ${trimNumber(offer.get_quantity)} ${value >= 100 ? "free" : `at ${trimNumber(value)}% off`}${minimum}`;
    default: return offer.name;
  }
}

// Why a running offer is not giving anything right now, in words (pro pass
// C-21): "Runs Sundays only", "Runs 4–7 pm", "Runs Sat, Sun · 4–7 pm".
const DAY_NAMES = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
const clock = (text) => {
  const [h, m] = String(text).slice(0, 5).split(":").map(Number);
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
};
const half = (text) => (Number(String(text).slice(0, 2)) < 12 ? "am" : "pm");
export function offerHoursWords(offer) {
  const days = offer.days_of_week?.length ? offer.days_of_week : null;
  const dayText = days ? (days.length === 1 ? `${DAY_NAMES[days[0] - 1]} only` : days.map((d) => WEEKDAYS[d - 1]).join(", ")) : "";
  let timeText = "";
  if (offer.starts_time && offer.ends_time) {
    const a = half(offer.starts_time), b = half(offer.ends_time);
    timeText = a === b ? `${clock(offer.starts_time)}–${clock(offer.ends_time)} ${b}` : `${clock(offer.starts_time)} ${a}–${clock(offer.ends_time)} ${b}`;
  }
  const text = [dayText, timeText].filter(Boolean).join(" · ");
  return text ? `Runs ${text}` : "Not running right now";
}

// "Every day", "Sat, Sun · 18:00–21:00", "Until 31 Oct".
export function offerWhen(offer) {
  const parts = [];
  parts.push(offer.days_of_week?.length ? offer.days_of_week.map((d) => WEEKDAYS[d - 1]).join(", ") : "Every day");
  if (offer.starts_time) parts.push(`${offer.starts_time.slice(0, 5)}–${offer.ends_time.slice(0, 5)}`);
  return parts.join(" · ");
}

// "27 Sep" (the app's own short month, never "Sept"), with the year when asked.
export const dateWords = (value, withYear = false) => (value ? dateShort(value, withYear ? { year: true } : {}) || "—" : "—");

// A WhatsApp link with the message typed in (wa.me needs digits only, with
// the country code; a 10-digit Indian number gets 91 in front).
export function whatsappLink(phone, text) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) digits = `91${digits.slice(1)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function udhaarMessage({ name, shop, balance, promisedOn, phone }) {
  return [
    `Namaste ${name},`,
    `This is a gentle reminder from ${shop}: your udhaar (credit) with us is ${balance}.`,
    promisedOn ? `You said you would pay by ${dateWords(promisedOn, true)}.` : "Please clear it at your earliest convenience.",
    phone ? `You can pay in the shop or by UPI. For any question call ${phone}.` : "You can pay in the shop or by UPI.",
    "Thank you!",
  ].join("\n");
}

// The till receipt: the shared GST invoice on 80 mm paper (core/pages/invoice.js),
// from what was posted, never recalculated. extra: { change, udhaar }.
export function printReceipt(doc, biz, extra = {}) {
  printTaxInvoice(doc, biz, { paper: "80mm", ...extra });
}
