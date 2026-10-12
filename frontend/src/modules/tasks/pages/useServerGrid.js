import { useCallback, useEffect, useMemo, useState } from "react";
import { rememberedPageSize } from "../../../components/DataGrid/useGridLayout";
import { getErrorMessage } from "../../../services/api";

// A DataGrid paged by the API: rows of one page, the total, filters and the
// search box. `fetchPage(params)` answers { rows, total }. A change of
// filters or search goes back to page 1.
export default function useServerGrid(gridId, fetchPage, filters) {
  const filterKey = JSON.stringify(filters);
  const [limit, setLimit] = useState(() => rememberedPageSize(gridId, 25));
  // The page belongs to the filters it was picked under; new filters start at 0.
  const [paging, setPaging] = useState({ key: "", offset: 0 });
  const [q, setQ] = useState("");
  const [result, setResult] = useState({ key: null, data: null, error: "" });
  const [version, setVersion] = useState(0);
  const pageKey = `${filterKey}|${q}`;
  const offset = paging.key === pageKey ? paging.offset : 0;
  const requestKey = `${pageKey}|${limit}|${offset}|${version}`;

  useEffect(() => {
    let live = true;
    fetchPage({ ...JSON.parse(filterKey), q: q.trim() || undefined, limit, offset })
      .then((data) => { if (live) setResult({ key: requestKey, data, error: "" }); })
      .catch((err) => { if (live) setResult((r) => ({ key: requestKey, data: r.data, error: getErrorMessage(err) })); });
    return () => { live = false; };
  }, [fetchPage, filterKey, q, limit, offset, requestKey]);

  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const loading = result.key !== requestKey;

  const gridProps = useMemo(() => ({
    id: gridId,
    rows: result.data?.rows || [],
    loading: loading && !result.data,
    error: result.error || undefined,
    onRetry: reload,
    search: { value: q, onChange: setQ, placeholder: "Search" },
    server: {
      total: result.data?.total ?? 0,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      onChange: ({ page, pageSize }) => { setLimit(pageSize); setPaging({ key: pageKey, offset: (page - 1) * pageSize }); },
      fetchAll: () => fetchPage({ ...JSON.parse(filterKey), q: q.trim() || undefined, limit: 200, offset: 0 }).then((v) => v.rows),
    },
  }), [gridId, result, loading, reload, q, offset, limit, pageKey, fetchPage, filterKey]);

  return { data: result.data, error: result.error, reload, gridProps };
}
