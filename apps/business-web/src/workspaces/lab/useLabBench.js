import { useCallback, useEffect, useMemo, useState } from "react";
import useLiveRefresh from "../../hooks/useLiveRefresh";
import useServerNow from "../../hooks/useServerNow";
import { businessRead } from "../../services/business.service";
import { getErrorMessage } from "../../services/api";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { benchCounts } from "./labBench.js";

// The lab workspace's bench, read once by its layout and shared by its
// screens: GET /lab/bench, every open order (whatever its day) and those
// reported today at the branch in view, each with its samples and tests and
// never a result. A sample collected, a result typed or a report approved on
// any screen reads it again within a second (live updates); a minute's read
// is the safety net. Reading it logs nothing: it holds no clinical data.
export default function useLabBench() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const load = useCallback(() => businessRead(biz.id, "lab/bench")
    .then((bench) => { setData(bench); setError(""); setOffset(Date.parse(bench.server_time) - Date.now() || 0); })
    .catch((err) => setError(getErrorMessage(err))), [biz.id]);
  useEffect(() => { load(); }, [load]);
  const live = useLiveRefresh({ business: biz.id }, ["lab"], load);
  const now = useServerNow(offset, 30000);
  const orders = useMemo(() => data?.orders || [], [data]);
  const counts = useMemo(() => benchCounts(orders), [orders]);
  return {
    data,
    orders,
    error,
    reload: load,
    live,
    now,
    counts,
    // How many values are out of range: only for those who see results (the server decides).
    resultsVisible: Boolean(data?.results_visible),
    can: { collect: biz.can("lab.create"), enter: biz.can("lab.edit"), approve: biz.can("lab.approve"), print: biz.can("lab.print") },
  };
}
