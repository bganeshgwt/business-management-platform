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

// The open business, what it has on, what this person may do, and its money.
export function useOpenBusiness() {
  const biz = useBusiness();
  const business = biz.context.business;
  const symbol = CURRENCY_SYMBOL[business.currency] || `${business.currency} `;
  return {
    ...biz,
    business,
    id: business.id,
    type: business.business_type,
    settings: biz.context.settings || {},
    locations: biz.context.locations || [],
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
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    const controller = new AbortController();
    const query = { ...JSON.parse(paramsKey), limit, offset, q: search.trim() || undefined, ...(range || {}) };
    businessRead(businessId, path, query, controller.signal)
      .then((result) => { setData(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [businessId, path, paramsKey, limit, offset, search, range, version]);

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
