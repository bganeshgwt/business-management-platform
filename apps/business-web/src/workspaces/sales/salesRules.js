// The salesperson app's rules on the phone, kept free of React, the API and
// the browser (tests/sales-app.test.js runs them): today's beats and their
// shops in visit order, the distance from a shop's saved place, what the
// phone checks before an order or a collection (credit hold, credit limit, a
// new shop's cash only, the ₹2,00,000 cash rule), a UPI reference and a
// cheque, the day's figures, and the receipt shared on WhatsApp. The server
// checks every one of them again and decides
// (backend/src/modules/business/wholesale/services/salespersonApp.service.js).

import { amountInWords, moneyExact } from "@bmp/shared/format";

const paise = (value) => Math.round(Number(value || 0) * 100);
export const rupeesOf = (p) => (p / 100).toFixed(2);

// Why a visit ended with no order: the server's fixed list (the pack carries it too).
export const NO_ORDER_REASONS = [
  { code: "shop_closed", label: "Shop closed" },
  { code: "owner_away", label: "Owner not available" },
  { code: "enough_stock", label: "Enough stock" },
  { code: "dues_or_hold", label: "Dues pending or credit hold" },
  { code: "price_or_scheme", label: "Price or scheme" },
  { code: "other_brand", label: "Prefers another brand" },
  { code: "order_later", label: "Will order later" },
  { code: "other", label: "Other" },
];
export const reasonLabel = (code) => NO_ORDER_REASONS.find((r) => r.code === code)?.label || code;

// Quick answers when a check-in is away from the shop's saved place, or the
// shop is not on today's beat: the salesperson may type their own.
export const FAR_REASONS = ["GPS is weak here", "The shop has moved", "The shop's saved place is wrong", "Met the owner away from the shop"];
export const OFF_BEAT_REASONS = ["The shop called for stock", "Covering another salesperson's beat", "On the way between beats", "Collecting dues"];

export const CASH_LIMIT_PAISE = 20000000;
export const CASH_LIMIT_WORDS = "Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186). Take the rest by UPI or cheque.";

// The great-circle distance in whole metres (the server's own formula).
export function distanceMetres(a, b) {
  const rad = (deg) => (Number(deg) * Math.PI) / 180;
  const dLat = rad(b.latitude) - rad(a.latitude);
  const dLon = rad(b.longitude) - rad(a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h))));
}

// "120 m", "2.4 km".
export const distanceText = (metres) => (metres === null || metres === undefined ? "" : metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`);

// ISO day of the week of a YYYY-MM-DD date: 1 Monday … 7 Sunday.
export const isoWeekday = (date) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// A shop's reference in the app's addresses and its journal: "c42" for a
// customer, "n<request key>" for a shop added on this phone.
export const shopRefOf = (shop) => (shop.id ? `c${shop.id}` : `n${shop.newShopKey}`);
export const readShopRef = (ref) => {
  const text = String(ref || "");
  if (/^c\d{1,18}$/.test(text)) return { contactId: Number(text.slice(1)) };
  if (/^n[0-9a-f-]{36}$/i.test(text)) return { newShopKey: text.slice(1) };
  return null;
};

// Today's beats (planned for this day of the week), and the beats with no day.
export function beatsFor(pack, weekday) {
  const beats = pack?.beats || [];
  return { today: beats.filter((b) => Number(b.visit_day) === Number(weekday)), anyDay: beats.filter((b) => b.visit_day === null) };
}

// Shops of these beats in the order they are visited: each beat in turn, by
// its visit order, then by name.
export function shopsInOrder(shops, beats) {
  const position = new Map(beats.map((b, i) => [Number(b.id), i]));
  return shops
    .filter((s) => position.has(Number(s.beat_id)))
    .sort((a, b) => position.get(Number(a.beat_id)) - position.get(Number(b.beat_id))
      || (a.visit_order ?? 1e9) - (b.visit_order ?? 1e9) || String(a.name).localeCompare(String(b.name)));
}

// What the phone knows a shop owes and has asked for since the pack was read:
// collections lower what it owes, orders not yet delivered add to what is
// ordered. `since`: entries made after the pack was read, or not yet sent then.
export function shopSince(entries, shopRef) {
  const mine = entries.filter((e) => e.shopRef === shopRef && !e.failed);
  return {
    collected: mine.filter((e) => e.kind === "collection").reduce((sum, e) => sum + paise(e.data.amount), 0),
    cash: mine.filter((e) => e.kind === "collection" && e.data.method === "cash").reduce((sum, e) => sum + paise(e.data.amount), 0),
    ordered: mine.filter((e) => e.kind === "order").reduce((sum, e) => sum + paise(e.data.phoneTotal), 0),
    orders: mine.filter((e) => e.kind === "order").length,
  };
}

// Before an order is taken: what the server would refuse, worked out from the
// pack and what the phone did since. { ok } or { ok: false, reason, title, message }.
// The server decides; this only stops the salesperson walking away with an
// order the office will turn back.
export function orderCheck(shop, orderPaise, since = { collected: 0, ordered: 0, orders: 0 }) {
  if (!shop) return { ok: true };
  const owes = paise(shop.balance) - since.collected;
  const pending = paise(shop.pending_orders) + since.ordered;
  if (shop.approval === "pending" && (owes > 0 || Number(shop.open_orders) + since.orders > 0)) {
    return { ok: false, reason: "cash_only", title: "Cash only until the office approves this shop",
      message: owes > 0 ? `It still owes ${moneyExact(rupeesOf(owes))}. Collect it first, or ask the office to approve the shop and set its credit.`
        : "An order for it is not delivered yet. Take the next one once that is paid, or ask the office to approve the shop and set its credit." };
  }
  if (shop.hold?.held) {
    // An overdue hold lifts once what is overdue is collected (the oldest bills are settled first).
    const cleared = shop.hold.reason === "overdue" && since.collected >= paise(shop.hold.overdue);
    if (!cleared) {
      return { ok: false, reason: "credit_hold", title: "On credit hold",
        message: shop.hold.reason === "overdue"
          ? `${moneyExact(shop.hold.overdue)} is more than ${shop.hold.limit_days} days past due (${shop.hold.days} days late). Collect it, or call the office to let this order through.`
          : `${shop.hold.bounces} cheques bounced in the last ${shop.hold.bounce_days} days. Call the office to let this order through.` };
    }
  }
  if (shop.credit_limit !== null && shop.credit_limit !== undefined) {
    const exposure = owes + pending + orderPaise;
    if (exposure > paise(shop.credit_limit)) {
      return { ok: false, reason: "credit_limit", title: "Over the credit limit",
        message: `This order takes it to ${moneyExact(rupeesOf(exposure))} (owes ${moneyExact(rupeesOf(Math.max(0, owes)))}, ordered and not yet sent ${moneyExact(rupeesOf(pending))}, this order ${moneyExact(rupeesOf(orderPaise))}), over its limit of ${moneyExact(shop.credit_limit)}. Collect first, or call the office to raise the limit.` };
    }
  }
  return { ok: true };
}

// Before cash is taken: today's cash from this shop (the server's count when
// the pack is today's, and what the phone took since) and this.
export function cashCheck(shop, amountPaise, since, packIsToday) {
  const before = (packIsToday ? paise(shop?.cash_today) : 0) + (since?.cash || 0);
  return before + amountPaise >= CASH_LIMIT_PAISE ? { ok: false, message: CASH_LIMIT_WORDS, before } : { ok: true, before };
}

// A UPI reference (UTR): 12 digits. A cheque: six digits, a date, a bank.
export const utrProblem = (value) => (/^\d{12}$/.test(String(value || "").replace(/\s/g, "")) ? null : "The UTR is the 12-digit number in the payer's UPI app");
export const chequeProblem = ({ number, date, bank }, today) => {
  if (!/^\d{6}$/.test(String(number || "").replace(/\s/g, ""))) return "A cheque's number is six digits";
  if (!date) return "Enter the date on the cheque";
  const days = (Date.parse(date) - Date.parse(today)) / 86400000;
  if (days > 180) return "A post-dated cheque can be at most 180 days ahead";
  if (days < -90) return "That cheque is more than three months old; a bank will not take it";
  if (!String(bank || "").trim()) return "Enter the bank the cheque is drawn on";
  return null;
};

// Allocated to the oldest bills first (as the server settles them): what this
// amount would clear, bill by bill, and what is left as an advance.
export function oldestFirst(bills, amountPaise) {
  let left = amountPaise;
  const settles = [];
  for (const bill of bills || []) {
    if (left <= 0) break;
    const due = paise(bill.outstanding);
    if (due <= 0) continue;
    const take = Math.min(due, left);
    settles.push({ ...bill, amount: take, clears: take === due });
    left -= take;
  }
  return { settles, advance: left };
}

// The day's figures: strike rate (productive ÷ calls), beat adherence
// (planned shops visited ÷ planned) in whole per cent, lines per call.
export function dayFigures({ planned = 0, visitedPlanned = 0, calls = 0, productive = 0, lines = 0 }) {
  const percent = (part, whole) => (whole > 0 ? Math.round((part * 100) / whole) : null);
  return { strikeRate: percent(productive, calls), adherence: percent(visitedPlanned, planned), linesPerCall: productive > 0 ? Math.round((lines * 10) / productive) / 10 : null };
}

const METHOD_WORDS = { cash: "Cash", cheque: "Cheque", upi: "UPI" };
export const methodLabel = (method) => METHOD_WORDS[method] || method;

// The receipt's words, to show on screen or share on WhatsApp: who received
// how much, how, against what, and the number once it reaches the office.
export function receiptText({ business, shop, collection, salesperson, number, at }) {
  const amount = rupeesOf(paise(collection.amount));
  const how = collection.method === "cheque"
    ? `cheque no. ${collection.reference} dated ${collection.chequeDate}, ${collection.bank}${Date.parse(collection.chequeDate) > Date.parse(String(at).slice(0, 10)) ? " (post-dated: counted once it clears)" : ""}`
    : collection.method === "upi" ? `UPI, reference ${collection.reference}` : "cash";
  return [
    `${business}`,
    `Received with thanks from ${shop}: ${moneyExact(amount)} (${amountInWords(amount)}) by ${how}.`,
    number ? `Receipt ${number}.` : "Receipt number follows once it reaches the office.",
    `Collected by ${salesperson} on ${new Date(at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.`,
  ].join("\n");
}
