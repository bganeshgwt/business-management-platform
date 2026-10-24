import { useEffect, useState } from "react";
import { businessRead } from "../../../../services/business.service";

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
