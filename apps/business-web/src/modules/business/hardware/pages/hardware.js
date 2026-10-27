import { useEffect, useState, useSyncExternalStore } from "react";
import { businessOptions, businessRead } from "../../../../services/business.service";

// The site a hardware shop's bill, quotation or order goes to: one of the
// customer's open sites. Shown only in a hardware shop with Sites on, for a
// named customer.
export const usesSites = (biz) => biz.type === "hardware" && biz.can("hardware_sites.view");

// The customer's open sites (and the chosen one, even if it was closed since).
export function useCustomerSites(biz, contactId) {
  const [sites, setSites] = useState({ contactId: null, list: [] });
  const wanted = usesSites(biz) && contactId ? String(contactId) : null;
  useEffect(() => {
    if (!wanted) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "hardware/sites", { contact: wanted, limit: 100 }, controller.signal)
      .then((page) => setSites({ contactId: wanted, list: page.items }))
      .catch(() => { if (!controller.signal.aborted) setSites({ contactId: wanted, list: [] }); });
    return () => controller.abort();
  }, [biz.id, wanted]);
  return wanted && sites.contactId === wanted ? sites.list : [];
}

// Fitters' commission: "Fitted by" on a bill, for someone who may name a
// fitter (and see the register) in a hardware shop with the module on.
export const usesFitters = (biz) => biz.type === "hardware" && biz.can("fitter_commission.view") && biz.can("fitter_commission.create");

export const TRADES = [
  { value: "painter", label: "Painter" }, { value: "plumber", label: "Plumber" }, { value: "electrician", label: "Electrician" },
  { value: "mason", label: "Mason" }, { value: "carpenter", label: "Carpenter" }, { value: "other", label: "Other fitter" },
];
export const tradeWord = (trade) => TRADES.find((t) => t.value === trade)?.label || trade;

// The address a UPI app opens to pay a fitter the amount, with a note that
// lands on both bank statements. null without a UPI id or an amount.
export function upiPayLink({ upiId, name, amount, note }) {
  const paise = Math.round(Number(amount || 0) * 100);
  if (!upiId || !(paise > 0)) return null;
  const parts = [`pa=${encodeURIComponent(String(upiId).trim()).replace(/%40/g, "@")}`, name ? `pn=${encodeURIComponent(String(name).trim().slice(0, 50))}` : null,
    `am=${(paise / 100).toFixed(2)}`, "cu=INR", note ? `tn=${encodeURIComponent(String(note).slice(0, 50))}` : null].filter(Boolean);
  return `upi://pay?${parts.join("&")}`;
}

// Paint tinting (module "hardware_tinting"): a bill's or a quotation's line of
// a base item in its pack, tinted to a maker's shade on the maker's own
// machine, and the tinting board. In a hardware shop with the module on.
export const usesTinting = (biz) => biz.type === "hardware" && biz.has("hardware_tinting");

// "Asian Paints 7974 Sunset Glow": a shade, or the shade of a tinting job (shade_code, shade_name).
export const shadeWords = (shade) => (shade ? [shade.maker, shade.code ?? shade.shade_code, shade.name ?? shade.shade_name].filter(Boolean).join(" ") : "");

// Millilitres to two decimals: 5, 1.6 (a drop under 0.01 keeps its thousandths).
const millilitres = (value) => value.toLocaleString("en-IN", { maximumFractionDigits: value > 0 && value < 0.01 ? 3 : 2 });

// A formula ([{ colourant, ml }], millilitres for one litre of base) in words:
// "XR 1.25 · YE 0.4". With `litres`, the litres in one tin of the base, for
// that tin: "XR 5 ml · YE 1.6 ml for one 4 L tin". "" without a formula.
export function formulaWords(formula, litres) {
  const list = (Array.isArray(formula) ? formula : []).filter((f) => f?.colourant);
  if (!list.length) return "";
  const per = Number(litres);
  if (!(per > 0)) return list.map((f) => `${f.colourant} ${millilitres(Number(f.ml))}`).join(" · ");
  return `${list.map((f) => `${f.colourant} ${millilitres(Number(f.ml) * per)} ml`).join(" · ")} for one ${per.toLocaleString("en-IN", { maximumFractionDigits: 3 })} L tin`;
}

// The shades and the tinting charge, read once for a business and shared
// while the app is open (every line of a Quick bill asks for the shades, and
// a maker's whole shade card is thousands): read again after fifteen
// minutes, or at once after a change made here (forgetTinting).
const FRESH_MS = 15 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const kept = new Map();
const reading = new Set();
const again = new Set();
const listeners = new Set();
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function load(key, read) {
  if (reading.has(key)) {
    again.add(key);
    return;
  }
  reading.add(key);
  read()
    .then((value) => kept.set(key, { value, at: Date.now(), read }))
    // A read that fails keeps what was read before, and is tried again shortly.
    .catch(() => kept.set(key, { value: kept.get(key)?.value ?? null, at: Date.now() - FRESH_MS + RETRY_MS, read }))
    .finally(() => {
      reading.delete(key);
      if (again.delete(key)) load(key, read);
      listeners.forEach((listener) => listener());
    });
}
function useKept(key, read, on) {
  const entry = useSyncExternalStore(subscribe, () => (on ? kept.get(key) : undefined));
  useEffect(() => {
    const now = kept.get(key);
    if (on && !reading.has(key) && !(now && Date.now() - now.at < FRESH_MS)) load(key, read);
    // `read` reads the same thing for the same key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on]);
  return entry;
}
// After a shade or the tinting charge is changed here: read them again.
export function forgetTinting(businessId) {
  for (const [key, entry] of kept) if (key.startsWith(`${businessId}|`)) load(key, entry.read);
}

// The shades that are on, every maker's: [{ id, maker, code, name, card, base,
// formula, active, job_count }]; null while they are read, [] where tinting
// is not used or for someone who may not see the shades.
const NO_SHADES = [];
export function useShades(biz) {
  const on = usesTinting(biz) && biz.can("hardware_tinting.view");
  const entry = useKept(`${biz.id}|shades`, () => businessOptions(biz.id, "hardware/shades", undefined, { active: "true" }), on);
  if (!on) return NO_SHADES;
  return entry ? entry.value || NO_SHADES : null;
}

// The tinting charge: the service item billed for tinting one tin, as the
// settings give it ({ id, label, code, barcode, price, taxRate, unit, active }).
// null when none is set, when it is switched off, or while it is read.
export function useTintCharge(biz) {
  const on = usesTinting(biz) && biz.can("hardware_tinting.view");
  const entry = useKept(`${biz.id}|charge`, async () => {
    const { charge } = await businessRead(biz.id, "hardware/tinting/settings");
    return charge?.active ? charge : null;
  }, on);
  return (on && entry?.value) || null;
}

// A manager's say-so as the API takes it (TintApproval.jsx): who approves and
// their PIN, with "Me" made explicit when no one else was chosen.
export const emptyApproval = () => ({ approverId: "", pin: "" });
export function approvalBody(value, userId) {
  const approverId = value.approverId || String(userId || "");
  return { ...(approverId ? { approverId } : {}), ...(value.pin ? { pin: value.pin } : {}) };
}
