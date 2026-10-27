import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useAuth from "../../hooks/useAuth";
import useLiveRefresh from "../../hooks/useLiveRefresh";
import { getErrorMessage, outletStorage } from "../../services/api";
import { toast } from "../../services/toast";
import { listTables } from "../../modules/restaurant/tables/services/table.service";
import { getServiceDay, listOrders } from "../../modules/restaurant/orders/services/order.service";
import { listTableRequests } from "../../modules/restaurant/orders/services/tableRequest.service";
import { getPass } from "../../modules/restaurant/kitchen/services/kitchen.service";
import { RUNNING_LIMIT } from "../../modules/restaurant/orders/services/orderCart";
import { getSettings } from "../../modules/restaurant/setup/services/restaurant.service";
import { alertsWanted, prepareAlerts, rememberAlerts, ring } from "./captainAlerts";
import { arrivalText, arrivals, countsOf, sectionOf, shownTables, waitingAt } from "./captainFloor";

// The captain app's floor, read through the APIs the POS, Table requests and
// the kitchen already use, each only where this person may read it:
//   GET /tables                    the room, each table's captain of the day
//   GET /orders (open, today's)    where each order is in the kitchen
//   GET /table-requests (waiting)  guests' calls and QR orders (QR ordering)
//   GET /kitchen/pass              food at the pass (the kitchen display)
//   GET /orders/day                whether orders can be taken
// Live updates read again what a change touches, within a second; the
// screens' own minute's read is only a safety net. A call or food at the
// pass that arrives at the tables shown says so on the screen, and buzzes and
// chimes the phone once alerts are switched on.

const AREAS = ["table", "order", "bill", "kot", "table_request", "reservation", "business_day"];
const ONLY_MINE_KEY = "rmp_captain_tables";

const readOnlyMine = () => {
  try {
    return localStorage.getItem(ONLY_MINE_KEY) !== "all";
  } catch {
    return true;
  }
};

export default function useCaptainFloor() {
  const { user, hasPermission, hasFeature } = useAuth();
  // What this person may read and do, as the API decides it.
  const can = useMemo(
    () => ({
      calls: hasFeature("qr_ordering") && hasPermission("orders.view"),
      accept: hasPermission("orders.create"),
      pass: hasFeature("kitchen_display") && (hasPermission("kot.manage") || hasPermission("kds.view")),
      serve: hasFeature("kitchen_display") && hasPermission("kot.manage"),
      // A table's running total is for someone who may see takings, as on
      // the dashboard's floor.
      money: hasPermission("sales.view"),
    }),
    [hasFeature, hasPermission]
  );

  const [tables, setTables] = useState(null);
  const [orders, setOrders] = useState([]);
  const [requests, setRequests] = useState([]);
  const [pass, setPass] = useState({ tickets: [], passMinutes: 8 });
  const [dayOpen, setDayOpen] = useState(null);
  const [errors, setErrors] = useState({});
  // The server's clock less this device's: the waiting clocks run on the
  // server's, so a phone five minutes slow does not make a guest look patient.
  const [offset, setOffset] = useState(0);
  const [onlyMine, setOnlyMine] = useState(readOnlyMine);
  const [alerts, setAlerts] = useState(alertsWanted);
  const [loaded, setLoaded] = useState(false);
  const [currency, setCurrency] = useState("₹");
  const seen = useRef(null);
  const seenFor = useRef(null);

  const setError = useCallback(
    (key, text) => setErrors((current) => (current[key] === text ? current : { ...current, [key]: text })),
    []
  );
  const loadTables = useCallback(
    () =>
      listTables()
        .then((rows) => {
          setTables(rows.filter((row) => row.status === "active"));
          setError("tables", "");
        })
        .catch((err) => setError("tables", getErrorMessage(err))),
    [setError]
  );

  const loadOrders = useCallback(
    () =>
      listOrders({ status: "open", limit: RUNNING_LIMIT, sort: "tables_first", age: "today" })
        .then((page) => setOrders(page.items))
        .catch(() => undefined),
    []
  );

  const loadRequests = useCallback(() => {
    if (!can.calls) {
      return Promise.resolve();
    }

    return listTableRequests({ view: "pending", limit: 200 })
      .then((page) => {
        setRequests(page.items);
        setOffset(new Date(page.serverTime).getTime() - Date.now() || 0);
        setError("calls", "");
      })
      .catch((err) => setError("calls", getErrorMessage(err)));
  }, [can.calls, setError]);

  const loadPass = useCallback(() => {
    if (!can.pass) {
      return Promise.resolve();
    }

    return getPass()
      .then((data) => {
        setPass(data);
        setOffset(new Date(data.serverTime).getTime() - Date.now() || 0);
        setError("pass", "");
      })
      .catch((err) => setError("pass", getErrorMessage(err)));
  }, [can.pass, setError]);

  const loadDay = useCallback(
    () =>
      getServiceDay()
        .then((data) => setDayOpen(Boolean(data.current)))
        .catch(() => undefined),
    []
  );

  // A change reads again only what it touches; a reconnection, the safety
  // net or coming back to the tab reads everything.
  const refresh = useCallback(
    (batch) => {
      const areas = new Set(batch.changes.map((change) => change.area));
      const everything = batch.reasons.some((reason) => reason !== "change");
      const touched = (...names) => everything || names.some((name) => areas.has(name));
      const work = [];

      if (touched("table", "order", "bill", "reservation", "business_day")) work.push(loadTables());
      if (touched("order", "kot", "bill")) work.push(loadOrders(), loadPass());
      if (touched("table_request")) work.push(loadRequests());
      if (touched("business_day")) work.push(loadDay());

      return Promise.all(work);
    },
    [loadTables, loadOrders, loadPass, loadRequests, loadDay]
  );

  const live = useLiveRefresh({ restaurant: true }, AREAS, refresh);

  useEffect(() => {
    refresh({ reasons: ["open"], changes: [] }).finally(() => setLoaded(true));
  }, [refresh]);

  // The currency symbol, from the settings every till reads.
  useEffect(() => {
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol || "₹"))
      .catch(() => undefined);
  }, []);

  const mine = useMemo(() => sectionOf(tables || [], user.id), [tables, user.id]);
  const shown = useMemo(() => shownTables(tables || [], mine, onlyMine), [tables, mine, onlyMine]);
  const waiting = useMemo(() => waitingAt(tables || [], { orders, requests, tickets: pass.tickets }), [tables, orders, requests, pass.tickets]);
  const counts = useMemo(() => countsOf(shown, waiting), [shown, waiting]);

  // Something new at the tables shown: said on the screen, and the phone
  // buzzes and chimes when alerts are on. Nothing rings for what was already
  // waiting when the screen opened, or when the tables shown change.
  useEffect(() => {
    if (!loaded) {
      return;
    }

    const showing = shown.map((table) => table.id).join(",");
    const { keys, fresh } = arrivals(seenFor.current === showing ? seen.current : null, shown, waiting);
    seen.current = keys;
    seenFor.current = showing;

    if (fresh.length === 0) {
      return;
    }

    if (alerts) {
      ring();
    }

    toast.info(fresh.length === 1 ? arrivalText(fresh[0]) : fresh.map(arrivalText).join(". "), { id: "captain-arrival", duration: 6000 });
  }, [loaded, shown, waiting, alerts]);

  // Alerts switched on earlier on this device: the first tap lets the
  // browser play the chime again.
  useEffect(() => {
    if (!alerts) {
      return undefined;
    }

    const unlock = () => prepareAlerts();

    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, [alerts]);

  const toggleAlerts = () => {
    const next = !alerts;

    rememberAlerts(next);

    if (next) {
      // The tap itself: the browser lets the page sound from now on, and the
      // waiter hears and feels what an alert is like.
      prepareAlerts();
      ring();
    }

    setAlerts(next);
  };

  const chooseMine = (value) => {
    setOnlyMine(value);

    try {
      localStorage.setItem(ONLY_MINE_KEY, value ? "mine" : "all");
    } catch {
      // Storage blocked: the choice holds until the page reloads.
    }
  };

  return {
    user,
    can,
    tables,
    mine,
    shown,
    onlyMine: onlyMine && mine.length > 0,
    chooseMine,
    waiting,
    counts,
    requests,
    pass,
    dayOpen,
    errors,
    offset,
    live,
    alerts,
    toggleAlerts,
    loaded,
    currency,
    // The outlet this person works in: tied to it, or picked on this device.
    workingOutlet: user.outletId || outletStorage.get() || null,
    reload: { tables: loadTables, requests: loadRequests, pass: loadPass, orders: loadOrders },
  };
}
