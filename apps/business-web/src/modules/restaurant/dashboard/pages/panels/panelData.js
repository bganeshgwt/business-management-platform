import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { queryClient, sessionScope } from "../../../../../services/queryClient";
import { getErrorMessage } from "../../../../../services/api";

// Reading a dashboard panel's list, and refreshing everything after an
// action in one (the components that draw a panel are in panelKit.jsx).

// A panel's list is kept for 20 seconds: long enough that closing and
// reopening it is instant, short enough that it never disagrees with the
// dashboard for long (the dashboard itself reads every 30).
const PANEL_FRESH = 20000;

export const panelKey = (name, params = null) => ["dash-panel", name, ...sessionScope(), params];

export function usePanelQuery(name, params, queryFn, options = {}) {
  return useQuery({
    queryKey: panelKey(name, params),
    queryFn,
    staleTime: PANEL_FRESH,
    gcTime: 2 * 60 * 1000,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
    enabled: options.enabled !== false,
    refetchInterval: options.refetchInterval,
    refetchIntervalInBackground: false,
  });
}

// After an action in a panel: the figures on the dashboard, its live blocks
// and every panel list are read again, so the count in the header, the tile
// behind the panel and the rows all agree.
export const refreshDashboard = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard-live"] }),
    queryClient.invalidateQueries({ queryKey: ["dash-panel"] }),
  ]);

export const errorText = (query) => (query.error ? getErrorMessage(query.error) : "");

// Server paging for a panel grid, starting at 25 a page.
export function usePaging(initial = 25) {
  const [paging, setPaging] = useState({ page: 1, pageSize: initial });

  return {
    ...paging,
    reset: () => setPaging((current) => ({ ...current, page: 1 })),
    onChange: ({ page, pageSize }) =>
      setPaging((current) =>
        current.pageSize !== pageSize ? { page: 1, pageSize } : { page: page || 1, pageSize: current.pageSize }
      ),
  };
}

// "12 min ago" style ages for rows, on the server's clock when it is known.
export const minutesAgo = (since, now = Date.now()) =>
  since ? Math.max(0, Math.round((new Date(now).getTime() - new Date(since).getTime()) / 60000)) : null;
