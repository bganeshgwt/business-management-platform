import { useCallback, useEffect, useState } from "react";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import useBusiness from "../../../../hooks/useBusiness";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { money, moneyExact } from "../../../../services/format";
import { monthStart } from "../../../../services/dates";

// What every Business Admin screen shares: the open business, its money
// format, a server-paged list with search and a period, and record pickers.

export const CURRENCY_SYMBOL = { INR: "₹" };
// Any currency's symbol, as the browser writes it (₹, $, €, AED …).
export function currencySymbol(code) {
  if (CURRENCY_SYMBOL[code]) return CURRENCY_SYMBOL[code];
  try {
    const part = new Intl.NumberFormat("en-IN", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency");
    return part ? part.value : `${code} `;
  } catch {
    return `${code} `;
  }
}
export const newKey = () => crypto.randomUUID();
const addDays = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// "Today" in the business's own time zone, so a shop in India sees its own date.
export const businessToday = (timezone) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "Asia/Kolkata" }).format(new Date());

// Quantities as people read them: 2.5 kg, 12 each.
export const quantity = (value, unit) => `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ""}`;
export const dateTime = (value) => (value ? new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");

// The age-group labels for what customers owe: "0–30 days" … "Over 90 days",
// from the business's own limits.
export function ageLabels(days) {
  const [a, b, c] = Array.isArray(days) && days.length === 3 ? days.map(Number) : [30, 60, 90];
  return { edges: [a, b, c], first: `0–${a} days`, second: `${a + 1}–${b} days`, third: `${b + 1}–${c} days`, over: `Over ${c} days` };
}

// The open business, what it has on, what this person may do, and its money.
export function useOpenBusiness() {
  const biz = useBusiness();
  const business = biz.context.business;
  const symbol = currencySymbol(business.currency);
  return {
    ...biz,
    business,
    id: business.id,
    type: business.business_type,
    settings: biz.context.settings || {},
    // The locations this person works with: theirs only when tied to one, or
    // the branch picked in the top bar. `allLocations` names every location
    // (a transfer's destination, settings); `member.location_id` is set for
    // someone tied to one location.
    locations: biz.context.locations || [],
    allLocations: biz.context.allLocations || biz.context.locations || [],
    member: biz.context.member || { location_id: null, location_name: null },
    currentLocationId: biz.context.currentLocationId || null,
    // The customer-credit age groups (Business settings › Rules; 30/60/90 by default).
    ages: ageLabels(biz.context.settings?.ageing_days),
    symbol,
    amount: (value) => money(value, symbol),
    exact: (value) => moneyExact(value, symbol),
  };
}

// A list the API pages. Lists that grow with time pass `period` and open on
// the current month (period "ahead" adds the next 30 days; "today" opens on
// today only, for a shop's own sales); every list has a server search box.
export function useServerList(path, { gridId, params = {}, period = false } = {}) {
  const { context } = useBusiness();
  const businessId = context.business.id;
  const anchor = businessToday(context.business.timezone);
  // "ahead" lists (appointments) also show the next 30 days.
  const [range, setRangeState] = useState(() => (period ? { from: period === "today" ? anchor : monthStart(anchor), to: period === "ahead" ? addDays(anchor, 30) : anchor } : null));
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(() => rememberedPageSize(gridId, 25));
  const [response, setResponse] = useState({key:"",scope:"",data:null,error:""});
  const [version, setVersion] = useState(0);
  const paramsKey = JSON.stringify(params);
  // Another business, list or filter never shows the last one's rows; a new
  // search, page or reload of the same list keeps them until the new ones arrive.
  const scope = JSON.stringify([businessId,path,paramsKey]);
  const currentKey = JSON.stringify([businessId,path,paramsKey,limit,offset,search,range,version]);
  const {data,error} = response.key === currentKey ? response
    : response.scope === scope && response.data ? {data:response.data,error:""} : {data:null,error:""};

  useEffect(() => {
    const controller = new AbortController();
    const query = { ...JSON.parse(paramsKey), limit, offset, q: search.trim() || undefined, ...(range || {}) };
    businessRead(businessId, path, query, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setResponse({key:currentKey,scope,data:result,error:""}); })
      .catch((err) => { if (!controller.signal.aborted) setResponse({key:currentKey,scope,data:null,error:getErrorMessage(err)}); });
    return () => controller.abort();
  }, [businessId, path, paramsKey, limit, offset, search, range, version, currentKey, scope]);

  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const fetchAll = useCallback(async () => {
    const all = [];
    for (let at = 0; ; at += 100) {
      const page = await businessRead(businessId, path, { ...JSON.parse(paramsKey), limit: 100, offset: at, q: search.trim() || undefined, ...(range || {}) });
      all.push(...page.items);
      if (!page.items.length || all.length >= page.total) return all;
    }
  }, [businessId, path, paramsKey, search, range]);

  const setRange = useCallback((next) => {
    if (next.from && next.to) {
      setRangeState(next);
      setOffset(0);
    }
  }, []);

  const gridProps = {
    id: gridId,
    rows: data?.items || [],
    loading: !data && !error,
    error: data ? "" : error,
    onRetry: reload,
    search: { value: search, placeholder: "Search", onChange: (value) => { setSearch(value); setOffset(0); } },
    server: {
      total: data?.total ?? 0,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      fetchAll,
      onChange: ({ page, pageSize }) => { setLimit(pageSize); setOffset((page - 1) * pageSize); },
    },
  };
  return { data, error: data ? error : "", reload, gridProps, range, setRange, anchor };
}

// The record pickers in forms (locations, items, contacts…): every row.
// Entries may carry a query: "contacts?kind=customer".
export function useOptions(paths) {
  const { context } = useBusiness();
  const businessId = context.business.id;
  const [options, setOptions] = useState(null);
  const [error, setError] = useState("");
  const key = paths.join("|");
  useEffect(() => {
    const controller = new AbortController();
    const list = key.split("|").filter(Boolean);
    Promise.all(list.map(async (entry) => {
      const [path, query] = entry.split("?");
      const params = Object.fromEntries(new URLSearchParams(query || ""));
      const rows = [];
      for (let offset = 0; ; offset += 100) {
        const page = await businessRead(businessId, path, { ...params, limit: 100, offset }, controller.signal);
        // A few endpoints (member candidates) answer with the whole list at once.
        if (Array.isArray(page)) {
          rows.push(...page);
          break;
        }
        rows.push(...page.items);
        if (!page.items.length || rows.length >= page.total) break;
      }
      return [entry, rows];
    }))
      .then((values) => setOptions(Object.fromEntries(values)))
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [businessId, key]);
  return { options, error };
}

// Remember the open form is unsaved, so switching business asks first.
export function useDirtyGuard(dirty) {
  const { setDirty } = useBusiness();
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
}
