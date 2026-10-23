import { useEffect, useMemo, useState } from "react";
import useBusiness from "../../../../hooks/useBusiness";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";

// The business's own payment methods (Settings › Payment methods): names the
// owner chose (PhonePe, Sodexo, HDFC current a/c), each of one fixed kind.
// The kind is what the books count (cash in the drawer, the cheque register,
// change given back); the name is what the counter offers and the day close
// shows.
//
// A screen keeps a "method key": "m<id>" for one of these methods, or a bare
// kind ("cash") meaning "the first method of that kind" — so a screen can
// start on "cash" before the list has loaded. `body(key)` turns it into what
// the server takes: { method: kind, methodId }.

export const KIND_WORDS = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", cheque: "Cheque" };
export const METHOD_KINDS = Object.keys(KIND_WORDS);

// One request per business, shared by every screen; dropped when the owner
// changes the methods so the next screen reads them again.
const cache = new Map();
export function forgetPaymentMethods(businessId) {
  cache.delete(String(businessId));
}
function load(businessId) {
  const id = String(businessId);
  if (!cache.has(id)) {
    cache.set(id, businessRead(businessId, "payment-methods").catch((err) => {
      cache.delete(id);
      throw err;
    }));
  }
  return cache.get(id);
}

const keyOf = (m) => (m.id ? `m${m.id}` : m.kind);
// Until the list arrives (or if it cannot be read): the five kinds by their usual names.
const FALLBACK = METHOD_KINDS.map((kind) => ({ id: null, name: KIND_WORDS[kind], kind, key: kind }));

// Pure helpers over a list of methods (each with `key`); usePaymentMethods hands them to the screens.
function methodTools(list) {
  const methods = list;
  const byKey = new Map(methods.map((m) => [m.key, m]));
  const options = (kinds = METHOD_KINDS) => methods.filter((m) => kinds.includes(m.kind));
  // The method a key stands for: itself, or the first of a bare kind, or
  // (when that kind has none switched on) the first method allowed here.
  const find = (key, kinds = METHOD_KINDS) => {
    if (byKey.has(key)) return byKey.get(key);
    const first = methods.find((m) => m.kind === key);
    if (first) return first;
    return options(kinds)[0] || null;
  };
  const kindOf = (key, kinds) => find(key, kinds)?.kind || (METHOD_KINDS.includes(key) ? key : null);
  return {
    methods,
    options,
    find,
    kindOf,
    resolve: (key, kinds) => find(key, kinds)?.key || key,
    name: (key, kinds) => find(key, kinds)?.name || KIND_WORDS[key] || key,
    // A kind's label on a button: the method's own name when the kind has just one.
    label: (kind) => {
      const own = methods.filter((m) => m.kind === kind);
      return own.length === 1 ? own[0].name : KIND_WORDS[kind] || kind;
    },
    has: (kind) => methods.some((m) => m.kind === kind),
    // What the server takes. A bare kind with no method (an older server) is sent as the kind alone.
    body: (key, kinds) => {
      const m = find(key, kinds);
      if (!m) return { method: key };
      return m.id ? { method: m.kind, methodId: m.id } : { method: m.kind };
    },
  };
}

// The open business's methods switched on, loaded once per business.
export function usePaymentMethods() {
  const { context } = useBusiness();
  const businessId = context.business.id;
  const [state, setState] = useState({ businessId: null, list: null, error: "" });
  useEffect(() => {
    let live = true;
    load(businessId)
      .then((rows) => { if (live) setState({ businessId, list: rows, error: "" }); })
      .catch((err) => { if (live) setState({ businessId, list: null, error: getErrorMessage(err) }); });
    return () => { live = false; };
  }, [businessId]);
  const current = state.businessId === businessId ? state : { list: null, error: "" };
  const tools = useMemo(() => methodTools(current.list ? current.list.map((m) => ({ ...m, key: keyOf(m) })) : FALLBACK), [current.list]);
  return { ...tools, ready: Boolean(current.list), error: current.error };
}
