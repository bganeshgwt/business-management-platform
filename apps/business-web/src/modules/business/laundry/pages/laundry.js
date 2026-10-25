import { dateShort } from "@bmp/shared/format";
import { whatsappLink } from "../../retail/pages/retail";

// Laundries and dry cleaners: the words, statuses and messages the garment
// order, racks, unclaimed and price list screens share. The server checks
// every step again (laundry/services); these only show and prepare them.

// A laundry with its tools on.
export const usesLaundry = (biz) => biz.type === "laundry" && biz.has("laundry");

// A garment's status, and an order's (worked out from its garments).
export const ITEM_STATUSES = {
  received: { label: "Received", tone: "info" }, in_process: { label: "In process", tone: "warning" }, ready: { label: "Ready", tone: "success" },
  delivered: { label: "Delivered", tone: "neutral" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
export const ORDER_STATUSES = {
  received: { label: "Received", tone: "info" }, in_process: { label: "In process", tone: "warning" }, part_ready: { label: "Partly ready", tone: "warning" },
  ready: { label: "Ready to collect", tone: "success" }, part_delivered: { label: "Partly delivered", tone: "info" }, delivered: { label: "Delivered", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const OPEN = ["received", "in_process", "ready"];
export const DEFECTS = [
  { value: "stain", label: "Stain" }, { value: "tear", label: "Tear" }, { value: "hole", label: "Hole" }, { value: "missing_button", label: "Missing button" },
  { value: "colour_bleed", label: "Colour bleed" }, { value: "fading", label: "Fading" }, { value: "shrinkage", label: "Shrinkage" }, { value: "burn", label: "Burn mark" },
  { value: "worn", label: "Worn" }, { value: "loose_thread", label: "Loose threads" },
];
export const ISSUES = [
  { value: "damage", label: "Damage" }, { value: "stain", label: "Stain" }, { value: "shrinkage", label: "Shrinkage" }, { value: "colour_run", label: "Colour run" },
  { value: "lost", label: "Lost" }, { value: "missing_part", label: "Missing part" }, { value: "other", label: "Other" },
];
export const DECISIONS = [
  { value: "refund", label: "Money back", hint: "A credit note on the garment's bill line, and what the customer paid beyond what is then due goes back." },
  { value: "credit", label: "Credit note", hint: "A credit note only: it lowers what the customer owes, or stays to their credit on the bill." },
  { value: "reprocess", label: "Reprocess", hint: "The work is done again at no charge: the garment goes back into the work." },
  { value: "rejected", label: "Rejected", hint: "No claim: say why." },
];
export const COUNTED = [{ value: "piece", label: "A piece" }, { value: "pair", label: "A pair" }, { value: "set", label: "A set of pieces" }];
export const wordOf = (list, value) => list.find((x) => x.value === value)?.label || value || "";

// "3 pieces", "1 pair", "2 sets of 2", "2.345 kg · 11 pieces".
export function quantityWords(item) {
  const pieces = Number(item.pieces);
  if (item.per === "kg") return `${Number(item.quantity)} kg · ${pieces} ${pieces === 1 ? "piece" : "pieces"}`;
  const n = Number(item.quantity);
  if (item.counted_as === "pair") return `${n} ${n === 1 ? "pair" : "pairs"}`;
  if (item.counted_as === "set") return `${n} ${n === 1 ? "set" : "sets"} of ${pieces / n}`;
  return `${n} ${n === 1 ? "piece" : "pieces"}`;
}
// What was noted at intake, in one line: "Stain, tear · near the collar".
export const defectWords = (item) => [(item.defects || []).map((d) => wordOf(DEFECTS, d)).join(", "), item.defect_note].filter(Boolean).join(" · ");
// "₹40.00 each", "₹89.90 a kg".
export const rateWords = (exact, price) => `${exact(price.price)} ${price.per === "kg" ? "a kg" : "each"}`;

// The prepared WhatsApp messages about an order.
export function orderMessage(biz, order, kind) {
  const shop = biz.settings.display_name || biz.business.name;
  const pieces = order.counts?.pieces ?? order.pieces;
  const due = order.money !== false && Number(order.due || 0) + Number(order.bill?.due || 0) > 0 ? ` Amount to pay: ${biz.exact(Number(order.due || 0) + Number(order.bill?.due || 0))}.` : "";
  const lines = {
    received: `Namaste ${order.customer_name}, we have your garments (order ${order.order_no}, ${pieces} ${pieces === 1 ? "piece" : "pieces"}). They will be ready by ${dateShort(order.promised_on, { year: true })}.`,
    ready: `Namaste ${order.customer_name}, your garments are ready to collect (order ${order.order_no}).${due} Please bring your order receipt.`,
    delayed: `Namaste ${order.customer_name}, your garments (order ${order.order_no}) need a little more time. Sorry for the wait; we will message you when they are ready.`,
    reminder: `Namaste ${order.customer_name}, your garments (order ${order.order_no}) are ready and waiting for you.${due} Please collect them at your convenience.`,
  };
  return `${lines[kind] || lines.received}${biz.settings.phone ? ` Call us on ${biz.settings.phone}.` : ""}\n— ${shop}`;
}
export const messageLink = (biz, order, kind) => whatsappLink(order.customer_phone, orderMessage(biz, order, kind));
export const NOTICES = [{ value: "received", label: "Order taken in" }, { value: "ready", label: "Ready to collect" }, { value: "delayed", label: "Running late" },
  { value: "reminder", label: "Collect reminder" }];
// The message that fits the order now (the button offered first).
export const noticeFor = (status) => (["ready", "part_ready", "part_delivered"].includes(status) ? "ready" : "received");

// A manager's say-so as the API takes it (LaundryApproval.jsx): who approves and
// their PIN, with "Me" made explicit when no one else was chosen, and the reason when asked.
export const emptyApproval = () => ({ reason: "", approverId: "", pin: "" });
export function approvalBody(value, userId) {
  const approverId = value.approverId || String(userId || "");
  return { ...(value.reason ? { reason: value.reason } : {}), ...(approverId ? { approverId } : {}), ...(value.pin ? { pin: value.pin } : {}) };
}

// The hold on garments not paid for, as the screens and the receipt say it.
export const LIEN_NOTE = "Garments are held until paid: whoever puts their labour or skill into goods left with them may keep the goods until paid, unless agreed otherwise "
  + "(Indian Contract Act, section 170). A customer with an account with the shop (credit days or a credit limit on their customer record) may take them on the account.";
