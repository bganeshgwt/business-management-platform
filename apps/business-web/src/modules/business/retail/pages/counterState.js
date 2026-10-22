import { useEffect, useState } from "react";
import { businessRead } from "../../../../services/business.service";
import { businessToday } from "../../core/pages/hooks";

// Quick bill's state outside the screen: held bills, the last bill and what
// a customer's udhaar looks like before more is given.

// --- Held bills ------------------------------------------------------------------
// Parked in this browser tab (sessionStorage): a bill put aside to serve the
// next customer. Nothing is posted until it is recalled and paid.
const HOLD_LIMIT = 5;
const holdKey = (businessId) => `counter-held-${businessId}`;
export function readHeld(businessId) {
  try { return JSON.parse(sessionStorage.getItem(holdKey(businessId)) || "[]"); } catch { return []; }
}
export function writeHeld(businessId, held) {
  try { sessionStorage.setItem(holdKey(businessId), JSON.stringify(held.slice(0, HOLD_LIMIT))); } catch { /* private window: held bills stay in memory only */ }
}
export const HELD_LIMIT = HOLD_LIMIT;
const lastKey = (businessId) => `counter-last-${businessId}`;
export function readLast(businessId) {
  try { return sessionStorage.getItem(lastKey(businessId)); } catch { return null; }
}
export function writeLast(businessId, documentId) {
  try { sessionStorage.setItem(lastKey(businessId), String(documentId)); } catch { /* ignore */ }
}

// What the counter should know before giving more udhaar.
export function udhaarRisk(customer, account, biz) {
  const owes = Number(account?.summary?.balance ?? customer?.balance ?? 0);
  const overdue = Number(account?.summary?.overdue || 0);
  const limitRaw = account?.contact?.credit_limit ?? customer?.credit_limit;
  const limit = limitRaw === null || limitRaw === undefined || limitRaw === "" ? null : Number(limitRaw);
  const last = account?.reminders?.find((r) => r.promised_on);
  const today = businessToday(biz.business.timezone);
  const promise = last && owes > 0.004 ? { on: String(last.promised_on).slice(0, 10), broken: String(last.promised_on).slice(0, 10) < today } : null;
  return { owes, overdue, limit, limitLeft: limit === null ? null : limit - owes, promise };
}

// The udhaar book entry of one customer (what they owe, overdue, promises).
export function useCustomerAccount(biz, customer) {
  const [account, setAccount] = useState(null);
  const allowed = biz.has("receivables") && biz.can("receivables.view");
  const id = customer?.id;
  const refresh = customer?.refresh;
  useEffect(() => {
    if (!id || !allowed) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `udhaar/${id}`, undefined, controller.signal).then(setAccount).catch(() => setAccount(null));
    return () => { controller.abort(); setAccount(null); };
  }, [biz.id, id, allowed, refresh]);
  return account;
}

// True on a phone-width screen (the counter's compact lines and pay bar).
export function useNarrow(query = "(max-width: 640px)") {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const change = () => setNarrow(list.matches);
    change();
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return narrow;
}
