import { dateShort } from "@bmp/shared/format";
import { whatsappLink } from "../../retail/pages/retail";

// Jewellery shops: the purities, words and messages the rates, pieces, bill,
// old gold, schemes and cash report screens share. The server checks every
// step again (jewellery/services); these only show and prepare them.

// A jeweller with its tools on.
export const usesJewellery = (biz) => biz.type === "jewellery" && biz.has("jewellery");

// The purities a jeweller rates, sells and buys by (the server keeps the same list).
export const PURITIES = {
  gold: [{ code: "24K", fineness: 999, carat: 24 }, { code: "22K", fineness: 916, carat: 22 }, { code: "18K", fineness: 750, carat: 18 }, { code: "14K", fineness: 585, carat: 14 }],
  silver: [{ code: "999", fineness: 999 }, { code: "925", fineness: 925 }],
  platinum: [{ code: "950", fineness: 950 }],
};
export const METALS = [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }, { value: "platinum", label: "Platinum" }];
export const metalWord = (metal) => METALS.find((m) => m.value === metal)?.label || metal;
const purityOf = (metal, purity) => (PURITIES[metal] || []).find((p) => p.code === purity) || null;
// As a hallmark shows it: 22K916 for gold, 925 for silver.
export function purityMark(metal, purity) {
  const p = purityOf(metal, purity);
  if (!p) return purity || "";
  return p.carat ? `${p.carat}K${p.fineness}` : String(p.fineness);
}
// "Gold 22K916".
export const purityWords = (metal, purity) => `${metalWord(metal)} ${purityMark(metal, purity)}`;
export const ALL_PURITIES = Object.entries(PURITIES).flatMap(([metal, list]) => list.map((p) => ({ metal, purity: p.code, key: `${metal}:${p.code}`, label: purityWords(metal, p.code) })));

// Weights to the milligram, as a jeweller writes them: 12.345 g.
export const grams = (value) => `${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} g`;
// A rate per gram with no paise when it has none: ₹12,150/g.
export const perGram = (biz, value) => `${biz.exact(value).replace(/\.00$/, "")}/g`;

// A piece's status, as the screens show it.
export const PIECE_STATUSES = {
  in_stock: { label: "In stock", tone: "success" }, on_approval: { label: "On approval", tone: "warning" }, at_karigar: { label: "At the karigar", tone: "info" },
  at_centre: { label: "At the hallmarking centre", tone: "info" }, sold: { label: "Sold", tone: "neutral" }, melted: { label: "Melted", tone: "neutral" },
  split: { label: "Split", tone: "neutral" }, merged: { label: "Merged", tone: "neutral" }, retagged: { label: "Given a new tag", tone: "neutral" },
};
export const OPEN_STATUSES = ["in_stock", "on_approval", "at_karigar", "at_centre"];
// Where a piece out of the shop is, and the screen its challan opens on.
export const OUT_SCREENS = { approval: { screen: "approvals", param: "challan" }, karigar: { screen: "karigar-work", param: "receive" },
  centre: { screen: "hallmarking", param: "consignment" } };
export const MAKING_MODES = [{ value: "per_gram", label: "Per gram" }, { value: "percent", label: "% of the metal's value" }, { value: "flat", label: "Flat for the piece" }];
// "₹300/g", "12% of metal", "₹6,500 flat".
export function makingWords(biz, mode, value) {
  if (value === null || value === undefined) return "";
  if (mode === "percent") return `${Number(value)}% of metal`;
  if (mode === "flat") return `${biz.exact(value).replace(/\.00$/, "")} flat`;
  return perGram(biz, value);
}
// HUIDs typed with spaces or commas between them: "ab12c3, QW34E5" → ["AB12C3", "QW34E5"].
export const readHuids = (text) => String(text || "").toUpperCase().split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
// Net weight to the milligram from what is typed (gross less stones), or "" while either is unclear.
export function netOf(gross, stones) {
  const g = Math.round(Number(gross) * 1000), s = Math.round(Number(stones || 0) * 1000);
  if (!gross || !Number.isFinite(g) || !Number.isFinite(s) || s >= g) return "";
  return ((g - s) / 1000).toFixed(3);
}

// Old gold: how an article is tested, the photo ID seen, and a voucher's state.
export const TEST_METHODS = [{ value: "xrf", label: "Karatmeter (XRF)" }, { value: "touchstone", label: "Touchstone" }, { value: "acid", label: "Acid test" },
  { value: "fire_assay", label: "Fire assay" }];
export const ID_KINDS = [{ value: "aadhaar", label: "Aadhaar card" }, { value: "voter_id", label: "Voter ID" }, { value: "driving_licence", label: "Driving licence" },
  { value: "passport", label: "Passport" }, { value: "pan_card", label: "PAN card" }, { value: "other", label: "Other photo ID" }];
export const OLD_GOLD_STATES = { open: { label: "Value left", tone: "warning" }, settled: { label: "Settled", tone: "success" }, cancelled: { label: "Cancelled", tone: "neutral" } };
// "gold:22K silver:925" (a voucher's purities) → "22K916 · 925".
export const marksOf = (text) => String(text || "").split(" ").filter(Boolean).map((key) => { const [metal, purity] = key.split(":"); return purityMark(metal, purity); }).join(" · ");
// The fineness of a purity: what an article valued as it is taken to hold, until it is tested.
export const finenessOf = (metal, purity) => purityOf(metal, purity)?.fineness ?? "";

// A manager's approval in a form (JewelleryApproval): empty, and as the server takes it.
export const emptyApproval = () => ({ approverId: "", pin: "" });
export const approvalBody = (value) => ({ ...(value.approverId ? { approverId: value.approverId } : {}), ...(value.pin ? { pin: value.pin } : {}) });

// Gold schemes: where a scheme stands.
export const SCHEME_STAGES = {
  paying: { label: "Paying", tone: "info" }, due: { label: "Instalment due", tone: "warning" }, matured: { label: "Matured", tone: "success" },
  stopped: { label: "Stopped", tone: "neutral" }, past_close: { label: "Past its close day", tone: "danger" }, redeemed: { label: "Redeemed", tone: "neutral" },
};
// A reminder to send a scheme's member on WhatsApp (the shop picks the chat).
export function schemeReminder(biz, s) {
  const shop = biz.settings.display_name || biz.business.name;
  const left = Number(s.instalments) - Number(s.paid_count);
  const words = s.stage === "matured" || left === 0
    ? `your gold scheme ${s.scheme_no} is ready to be turned into jewellery. Please visit us before ${dateShort(s.close_by, { year: true })}.`
    : `instalment ${Number(s.paid_count) + 1} of ${s.instalments} (${biz.exact(s.instalment)}) of your gold scheme ${s.scheme_no} is due on ${dateShort(s.next_due || s.next_due_on, { year: true })}.`;
  return whatsappLink(s.member_phone || "", `${shop}: Dear ${s.member_name}, ${words}`);
}

// Custom orders: where an order stands on its path.
export const ORDER_STATUSES = {
  booked: { label: "Booked", tone: "info" }, issued: { label: "With the karigar", tone: "info" }, received: { label: "Received", tone: "warning" },
  at_centre: { label: "At the hallmarking centre", tone: "info" }, hallmarked: { label: "Hallmarked", tone: "warning" }, ready: { label: "Ready", tone: "success" },
  delivered: { label: "Delivered", tone: "neutral" }, cancelled: { label: "Cancelled", tone: "neutral" },
};
// Approval challans and hallmarking consignments: where each stands.
export const APPROVAL_STATES = { out: { label: "Out", tone: "info" }, overdue: { label: "Past its day", tone: "danger" }, closed: { label: "Closed", tone: "neutral" } };
export const CONSIGNMENT_STATES = { at_centre: { label: "At the centre", tone: "info" }, returned: { label: "Back", tone: "success" } };
// A karigar's labour: jewellery work at 5% GST, diamond work at 1.5% (none from a karigar not registered for GST).
export const WORK_KINDS = [{ value: "jewellery", label: "Jewellery work (5%)" }, { value: "diamond", label: "Diamond work (1.5%)" }];
export const LABOUR_BASES = [{ value: "per_gram", label: "Per gram" }, { value: "per_piece", label: "Per piece" }];
// What a karigar holds, in fine weight by metal: "gold 2.638 g · silver 12.000 g".
export const karigarHeldWords = (k) => [Number(k.gold_fine) ? `gold ${grams(k.gold_fine)}` : null, Number(k.silver_fine) ? `silver ${grams(k.silver_fine)}` : null,
  Number(k.platinum_fine) ? `platinum ${grams(k.platinum_fine)}` : null].filter(Boolean).join(" · ") || "—";
// "gold:22K" ↔ { metal, purity }, as the purity pickers hold them.
export const purityKey = (metal, purity) => `${metal}:${purity}`;
export const splitPurity = (key) => { const [metal, purity] = String(key).split(":"); return { metal, purity }; };
// Tags typed or scanned with spaces, commas or new lines between them.
export const readTags = (text) => [...new Set(String(text || "").toUpperCase().split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];

export const SESSION_WORDS = { morning: "Morning", evening: "Evening" };
// The session a rate sheet set now is most likely for (the shop can change it).
export const sessionNow = () => (new Date().getHours() < 13 ? "morning" : "evening");

// Today's rates as a message to send to customers (WhatsApp lets the shop pick whom).
export function ratesMessage(biz, board) {
  const shop = board.seller?.display_name || biz.settings.display_name || biz.business.name;
  const lines = board.rates.map((r) => {
    const tenGrams = r.metal === "gold" ? ` (10 g ${biz.exact(Number(r.sell_rate) * 10).replace(/\.00$/, "")})` : "";
    return `${r.label}: ${perGram(biz, r.sell_rate)}${tenGrams}`;
  });
  const buying = board.rates.filter((r) => r.buy_rate).map((r) => `${r.label}: ${perGram(biz, r.buy_rate)}`);
  return [`${shop} · rates for ${dateShort(board.day, { year: true })}`, ...lines,
    ...(buying.length ? ["We buy old gold and silver at:", ...buying] : []),
    "Rates per gram before making charges and GST."].join("\n");
}
export const ratesShareLink = (biz, board) => whatsappLink("", ratesMessage(biz, board));
