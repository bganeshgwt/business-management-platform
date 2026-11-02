// The online shop's words, clocks and printouts for staff (pure: the pages
// draw them; tests/online-shop.test.js checks them).
import { escapeHtml } from "../../../../services/print.js";

export const LANES = [
  { value: "new", label: "New" },
  { value: "packing", label: "Packing" },
  { value: "out", label: "Ready & out" },
  { value: "done", label: "Done" },
];
export const STATUS_WORDS = {
  placed: "New", accepted: "Accepted", packed: "Packed & billed", ready: "Ready for pickup", out_for_delivery: "Out for delivery",
  completed: "Completed", declined: "Declined", cancelled: "Cancelled",
};
export const STATUS_TONES = {
  placed: "warning", accepted: "info", packed: "info", ready: "success", out_for_delivery: "info", completed: "neutral", declined: "danger", cancelled: "neutral",
};
export const PAYMENT_WORDS = { pay_at_shop: "Pays at the shop", cash_on_delivery: "Cash on delivery", upi_on_delivery: "UPI on delivery" };
export const SUBSTITUTION_WORDS = { remove: "Remove it", similar: "Replace with similar", call: "Call me" };
export const DECLINE_REASONS = ["Items out of stock", "The shop is closing", "Outside our delivery area", "Too many orders just now"];
export const COMPLAINT_OUTCOMES = [
  { value: "taken_back", label: "Taken back" }, { value: "refunded", label: "Refunded" }, { value: "replaced", label: "Replaced" },
  { value: "explained", label: "Explained to the customer" }, { value: "other", label: "Other" },
];

// "4 min", "1 h 12 min", "2 d" — how long ago, or how long left.
export function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `${Math.floor(minutes / 1440)} d`;
}

// The clock on a new order's card: how long until the shop's own rule declines it.
export function declineClock(autoDeclineAt, now) {
  if (!autoDeclineAt) return null;
  const left = new Date(autoDeclineAt).getTime() - now;
  if (left <= 0) return { words: "Declining now", tone: "danger" };
  return { words: `Declines itself in ${span(left)}`, tone: left < 5 * 60000 ? "danger" : left < 15 * 60000 ? "warning" : "neutral" };
}

// A complaint's clock: acknowledge within 48 hours, resolve within a month.
export function complaintClock(complaint, now) {
  if (complaint.status === "resolved") return { words: "Resolved", tone: "success" };
  const due = complaint.status === "open" ? complaint.acknowledgeBy : complaint.resolveBy;
  const left = new Date(due).getTime() - now;
  const what = complaint.status === "open" ? "acknowledge" : "resolve";
  if (left <= 0) return { words: `Late to ${what} by ${span(-left)}`, tone: "danger" };
  const opened = now - new Date(complaint.createdAt).getTime();
  return { words: `${what === "acknowledge" ? "Acknowledge" : "Resolve"} within ${span(left)}`,
    tone: complaint.status === "open" && opened >= 24 * 3600000 ? "warning" : left < 7 * 86400000 && what === "resolve" ? "warning" : "neutral" };
}

// The pick list: lines in shelf order (those with no shelf last), then by name.
export function pickOrder(lines) {
  return [...lines].sort((a, b) => {
    const shelfA = a.shelf || "￿", shelfB = b.shelf || "￿";
    return shelfA.localeCompare(shelfB, "en", { numeric: true }) || a.position - b.position;
  });
}

// "2", "1.25 kg" — a quantity on a staff screen.
export const qty = (value, unit, weighed) => `${Number(Number(value).toFixed(3))}${weighed || unit !== "each" ? ` ${unit}` : ""}`;

// The UPI link the order slip's QR pays: exact amount, the order in its note.
export function upiLink({ id, payee }, amount, orderNo) {
  const parts = [`pa=${encodeURIComponent(id)}`, `pn=${encodeURIComponent(payee || "")}`, `am=${Number(amount).toFixed(2)}`, "cu=INR", `tn=${encodeURIComponent(`Order ${orderNo}`)}`];
  return `upi://pay?${parts.join("&")}`;
}

// What a shop shares on WhatsApp with its shop link.
export const shareText = (name, url) => `Order from ${name} online, for pickup or home delivery: ${url}\nPay when you collect, or cash or UPI on delivery.`;

const SLIP_STYLES = `body{font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;max-width:80mm;margin:0 auto}
h1{font-size:16px;margin:0 0 2px}h2{font-size:13px;margin:10px 0 4px}p{margin:2px 0}.muted{color:#555}
table{width:100%;border-collapse:collapse;margin-top:6px}td{padding:3px 0;vertical-align:top;border-bottom:1px dashed #bbb}td.num{text-align:right;white-space:nowrap}
.total td{font-weight:700;border-bottom:0;border-top:1px solid #111}.qr{display:block;margin:10px auto 2px;width:42mm;height:42mm}.center{text-align:center}
.box{border:1px solid #111;padding:6px;margin-top:8px}`;

// The order slip that goes in the bag: the order, the customer, what was
// packed, the amount to collect and, with a UPI ID, a QR for that exact amount.
export function slipHtml({ order, shopName, money, qrDataUrl = null, privacy = "" }) {
  const rows = order.lines.filter((line) => !["unavailable", "replaced"].includes(line.state)).map((line) => `<tr><td>${escapeHtml(line.name)}<br><span class="muted">${escapeHtml(
    qty(line.packedQuantity ?? line.quantity, line.unit, line.weighed))}</span></td><td class="num">${escapeHtml(money(line.packedAmount))}</td></tr>`).join("");
  const left = order.lines.filter((line) => ["unavailable", "replaced"].includes(line.state)).map((line) => escapeHtml(line.name));
  const amount = order.finalTotal ?? order.figures?.total ?? order.total;
  return `<h1>${escapeHtml(shopName)}</h1>
<p><strong>Online order ${escapeHtml(order.orderNo)}</strong>${order.document ? ` · Bill ${escapeHtml(order.document.number)}` : ""}</p>
<p>${escapeHtml(order.name)}${order.mobile ? ` · ${escapeHtml(order.mobile)}` : ""}</p>
${order.service === "delivery" ? `<p>${escapeHtml([order.address, order.landmark, order.pinCode].filter(Boolean).join(", "))}</p>` : "<p>Pickup at the shop</p>"}
${order.slot ? `<p>Slot: ${escapeHtml(order.slot.date)} ${escapeHtml(order.slot.from)}–${escapeHtml(order.slot.to)}</p>` : ""}
<table>${rows}${order.figures?.delivery ? `<tr><td>Delivery charge</td><td class="num">${escapeHtml(money(order.figures.delivery))}</td></tr>` : ""}
<tr class="total"><td>To collect</td><td class="num">${escapeHtml(money(amount))}</td></tr></table>
${left.length ? `<p class="muted">Not in the bag: ${left.join(", ")}</p>` : ""}
<div class="box"><p><strong>${escapeHtml(PAYMENT_WORDS[order.paymentMode] || "")}</strong></p>
${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt=""><p class="center">Scan to pay ${escapeHtml(money(amount))} by UPI</p>` : ""}</div>
${order.note ? `<p class="muted">Note: ${escapeHtml(order.note)}</p>` : ""}
${privacy ? `<p class="muted">${escapeHtml(privacy)}</p>` : ""}`;
}
export const SLIP = SLIP_STYLES;

const POSTER_STYLES = `@page{size:A5;margin:12mm}body{font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;text-align:center}
h1{font-size:28px;margin:6mm 0 2mm}.lead{font-size:18px;margin:0 0 6mm}.qr{width:95mm;height:95mm}.link{font-size:12px;word-break:break-all;color:#333;margin-top:4mm}
.how{display:flex;justify-content:center;gap:8mm;margin-top:6mm;font-size:13px}.logo{max-height:22mm;max-width:60mm}`;

// The A5 poster for the counter or the door: the name, the QR and the link.
export function posterHtml({ name, url, qrDataUrl, logoUrl = null }) {
  return `${logoUrl ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="">` : ""}<h1>${escapeHtml(name)}</h1>
<p class="lead">Scan to order online</p><img class="qr" src="${qrDataUrl}" alt="">
<div class="how"><span>Pickup or home delivery</span><span>Pay when you get it</span></div><p class="link">${escapeHtml(url)}</p>`;
}
export const POSTER = POSTER_STYLES;

// A photo picked from the phone or computer, made into the shop's two sizes
// in the browser (no upload of a 12 MB camera picture): the large one for the
// item's page and the small one for the grid, as WebP where the browser
// makes it, else JPEG. Resolves { large, small } as Files, or the picture
// itself for both when the browser cannot draw it.
export async function shopPhotoSizes(file, { large = 1080, small = 400 } = {}) {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return { large: file, small: null };
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { large: file, small: null };
  }
  const draw = (side) => new Promise((resolve) => {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob && blob.type === "image/webp") resolve(new File([blob], `photo-${side}.webp`, { type: "image/webp" }));
      else canvas.toBlob((jpeg) => resolve(jpeg ? new File([jpeg], `photo-${side}.jpg`, { type: "image/jpeg" }) : null), "image/jpeg", 0.85);
    }, "image/webp", 0.85);
  });
  const [big, little] = await Promise.all([draw(large), draw(small)]);
  bitmap.close?.();
  return big ? { large: big, small: little } : { large: file, small: null };
}
