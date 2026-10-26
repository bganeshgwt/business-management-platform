import { useEffect, useRef, useState } from "react";
import useAuth from "./useAuth";
import { outletStorage } from "../services/api";
import { safetyNetMs, subscribeLive } from "../services/live";
import { SAFETY_NET_MS } from "../services/liveClient";

// Keeps a screen that shows what other devices change up to date: it reads
// again as soon as the server says something it shows has changed (live
// updates, services/liveClient.js), and, as a safety net only, every minute
// (or less often, or never: `every`).
//
//   const live = useLiveRefresh({ restaurant: true }, ["kot", "kot_slip"], refresh);
//   const live = useLiveRefresh({ business: biz.id }, ["token", "visit"], load);
//   …
//   <LiveIndicator status={live} />
//
// scope    { restaurant: true }: the signed-in person's restaurant, at the
//          outlet picked (nothing for a login with no restaurant); or
//          { business: id }; or null for none
// areas    what the screen shows (API.md › Live updates lists the areas), or
//          ["*"] for everything
// refresh  reads the screen again. It gets { reasons, changes }: why
//          ("change", "reconnect", "timer", "visible", "session", "access")
//          and the changes heard ({ area, id, outlet } or { area, id,
//          location }). A promise it returns is waited for: live updates
//          never run it twice at once.
// options  every: the safety net in ms (at least a minute; 0 for none, when
//          the screen keeps its own, as a TanStack Query does, or never had
//          one); refreshOnVisible: false
//          to read on coming back to the tab only when a change was missed
//          while it was hidden; debounceMs and minIntervalMs: how long a
//          burst is gathered, and the least time between two reads (a heavy
//          screen, such as the dashboard, waits longer); enabled.
//
// Nothing is read while the tab is hidden: a change heard then is read when
// the tab comes back. Returns the stream's status for LiveIndicator:
// "connecting", "live", "reconnecting" or "off".
export default function useLiveRefresh(scope, areas, refresh, options = {}) {
  const { user } = useAuth();
  const { every = SAFETY_NET_MS, refreshOnVisible = true, debounceMs, minIntervalMs, enabled = true } = options;
  const [status, setStatus] = useState("connecting");
  const latest = useRef(refresh);
  const missed = useRef(false);

  useEffect(() => {
    latest.current = refresh;
  });

  const restaurant = Boolean(scope && scope.restaurant);
  const business = scope && scope.business ? String(scope.business) : "";
  const areaList = areas.join(",");
  const userId = user ? user.id : null;
  // A login with no restaurant has no restaurant stream to open.
  const active = enabled && Boolean(userId) && (restaurant ? Boolean(user.restaurantId) : Boolean(business));

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const target = restaurant ? { restaurant: true, user: userId, outlet: outletStorage.get() } : { business, user: userId };

    return subscribeLive(
      target,
      areaList.split(","),
      (batch) => {
        if (document.visibilityState === "hidden") {
          missed.current = true;
          return undefined;
        }

        return latest.current(batch);
      },
      { onStatus: setStatus, debounceMs, minIntervalMs }
    );
  }, [active, userId, restaurant, business, areaList, debounceMs, minIntervalMs]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const interval = every > 0 ? safetyNetMs(every) : 0;
    const timer = interval
      ? setInterval(() => {
          if (document.visibilityState === "visible") {
            latest.current({ reasons: ["timer"], changes: [] });
          }
        }, interval)
      : null;

    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      const wasMissed = missed.current;
      missed.current = false;

      if (refreshOnVisible || wasMissed) {
        latest.current({ reasons: ["visible"], changes: [] });
      }
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (timer) {
        clearInterval(timer);
      }

      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, every, refreshOnVisible]);

  return active ? status : "off";
}
