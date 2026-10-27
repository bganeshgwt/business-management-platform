import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../../../services/api";

// One page at a time of a register ("requests" or "breaches"), searched and
// filtered on the server, for either front door: the DataGrid's server props,
// as Business Admin's useServerList gives them.
export default function usePagedList(api, kind, { gridId, params = {} } = {}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(25);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState({ key: "", data: null, error: "" });
  const paramsKey = JSON.stringify(params);
  const key = JSON.stringify([api.key, kind, paramsKey, limit, offset, search, version]);

  useEffect(() => {
    const controller = new AbortController();
    api.list(kind, { ...JSON.parse(paramsKey), limit, offset, q: search.trim() || undefined }, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ key, data, error: "" }); })
      .catch((err) => { if (!controller.signal.aborted) setState({ key, data: null, error: getErrorMessage(err) }); });
    return () => controller.abort();
  }, [api, kind, paramsKey, limit, offset, search, version, key]);

  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const current = state.key === key ? state : { data: state.data, error: "" };
  const fetchAll = useCallback(async () => {
    const all = [];
    for (let at = 0; ; at += 100) {
      const page = await api.list(kind, { ...JSON.parse(paramsKey), limit: 100, offset: at, q: search.trim() || undefined });
      all.push(...page.items);
      if (!page.items.length || all.length >= page.total) return all;
    }
  }, [api, kind, paramsKey, search]);

  return {
    data: current.data,
    reload,
    gridProps: {
      id: gridId,
      rows: current.data?.items || [],
      loading: !current.data && !current.error,
      error: current.data ? "" : current.error,
      onRetry: reload,
      search: { value: search, placeholder: "Search", onChange: (value) => { setSearch(value); setOffset(0); } },
      server: {
        total: current.data?.total ?? 0,
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
        fetchAll,
        onChange: ({ page, pageSize }) => { setLimit(pageSize); setOffset((page - 1) * pageSize); },
      },
    },
  };
}
