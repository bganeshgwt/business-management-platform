import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { getErrorMessage } from "../../../../services/api";
import { count } from "@bmp/shared/format";
import {
  clearOldTickets,
  createStation,
  getBoard,
  getStationSetup,
  makeDefaultStation,
  recallLastTicket,
  recallTicket,
  recordSlipPrint,
  recordTicketPrint,
  searchDishes,
  setCategoryStation,
  setDishStation,
  setTicketItemDone,
  setTicketStatus,
  updateKitchenSettings,
  updateStation,
} from "../services/kitchen.service";
import {
  COLUMNS,
  NAME_MODES,
  STATION_COLORS,
  allDayCounts,
  destination,
  dishNames,
  duration,
  itemNames,
  kotDate,
  playChime,
  plural,
  printKot,
  printSlip,
  qty,
  shortName,
  slipTitle,
  ticketClock,
  timeOfDay,
  toneFor,
  unlockChime,
} from "../../../../services/kot";
import KitchenSoldOut from "./KitchenSoldOut";
import "../styles/kitchen.css";

// The board refreshes this often while it is on screen. Ten seconds is as
// quick as a waiter walks from the till to the pass.
const REFRESH_EVERY = 10000;

// How long a ticket that just arrived keeps its glow.
const FRESH_FOR = 15000;

const SOUND_KEY = "rmp_kds_sound";

const OPEN = ["new", "cooking", "ready"];

// A ticket open this long was almost certainly served without anyone
// pressing Served. The board says so, and offers a manager the tidy-up.
const STALE_AFTER_MINUTES = 120;

// The ages "Clear old tickets" offers. The server refuses anything under an
// hour: a ticket that young may still be on the stove.
const CLEAR_CHOICES = [60, 120, 240];

const hoursLabel = (minutes) => (minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`);

const minutesOpen = (ticket, now) => (now - new Date(ticket.createdAt).getTime()) / 60000;

// ?station=3 from the address bar. Anything that is not a plain positive
// number (a mangled bookmark) is treated as a station that no longer exists.
const parseStation = (value) => (/^[1-9]\d{0,14}$/.test(value) ? Number(value) : null);

// Remembered per screen: the tandoor's tablet may want the chime while the
// manager's laptop does not. Storage can be blocked, in which case it is off.
const readSound = () => {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
};

const writeSound = (on) => {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    // Private mode or storage switched off: the toggle still works this visit.
  }
};

const ago = (milliseconds) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));

  if (seconds < 5) {
    return "just now";
  }

  if (seconds < 90) {
    return `${seconds}s ago`;
  }

  return `${Math.round(seconds / 60)} min ago`;
};

// ---------------------------------------------------------------- icons

// The shared icon set draws almost every mark on the board. These few are
// the board's own: recall to the pass, the chime switched off, full screen
// in and out, and the route a dish takes to its station.
const GLYPHS = {
  recall: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  bellOff:
    "M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  collapse: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h4M18 9v6a4 4 0 0 1-4 4h-4",
};

// The board's older names for marks the shared set has under its own name.
const SHARED_NAME = { flame: "fire", tray: "cloche" };

function Glyph({ name, size = 18 }) {
  if (!GLYPHS[name]) {
    return <Icon name={SHARED_NAME[name] || name} size={size} className="kds-icon" />;
  }

  return (
    <svg
      className="icon kds-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={GLYPHS[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------- the page

export default function KitchenDisplayPage() {
  const { hasPermission } = useAuth();
  const canSetup = hasPermission("menu.manage");
  const [tab, setTab] = useQueryFilter("tab", "board");
  const view = canSetup && tab === "stations" ? "stations" : "board";

  return (
    <div className="stack kds-page">
      <PageHeader
        icon="chef"
        title="Kitchen display"
        description={
          view === "board"
            ? "Every ticket from the tills, by station, with the clock running."
            : "Where each dish is cooked, and how long is too long."
        }
        action={
          canSetup && (
            <div className="segmented" role="tablist" aria-label="Kitchen display views">
              <button
                type="button"
                role="tab"
                aria-selected={view === "board"}
                className={`segment ${view === "board" ? "is-active" : ""}`}
                onClick={() => setTab("board")}
              >
                <Icon name="grid" size={15} /> Board
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "stations"}
                className={`segment ${view === "stations" ? "is-active" : ""}`}
                onClick={() => setTab("stations")}
              >
                <Icon name="settings" size={15} /> Stations &amp; routing
              </button>
            </div>
          )
        }
      />

      {view === "board" ? (
        <Board
          canManage={hasPermission("kot.manage")}
          canClear={hasPermission("kot.manage") && hasPermission("orders.manage")}
          canOpenDay={hasPermission("business_day.manage")}
          canMarkSoldOut={hasPermission("menu.availability")}
        />
      ) : (
        <StationsSetup />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the board

function Board({ canManage, canClear, canOpenDay, canMarkSoldOut }) {
  const [stationFilter, setStationFilter] = useQueryFilter("station", "");
  const stationId = parseStation(stationFilter);
  // ?older=1: also show the tickets left open from earlier days (the board
  // is today's otherwise; the server only counts them).
  const [olderFilter, setOlderFilter] = useQueryFilter("older", "");
  const showOlder = olderFilter === "1";

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // The server's clock minus this device's. Kitchen tablets are often minutes
  // out, and a timer that starts at "-3:00" is worse than none.
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState({});
  const [toast, setToast] = useState(null);
  const [column, setColumn] = useState("new");
  const [focus, setFocus] = useState(false);
  const [sound, setSound] = useState(readSound);
  const [panel, setPanel] = useState(null);
  const [fresh, setFresh] = useState({});
  const [clearing, setClearing] = useState(false);

  const seen = useRef(null);
  // The station the screen is showing now. A board asked for before the cook
  // switched station is thrown away when it lands, so it cannot put the old
  // station's tickets back on screen.
  const stationRef = useRef(stationId);
  const soundRef = useRef(sound);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const again = useRef(() => undefined);
  // Bumped by every action, so a refresh that set off before a tap cannot
  // land afterwards and put the old state back on screen.
  const actions = useRef(0);
  const toastTimer = useRef(null);
  const chipsRef = useRef(null);
  const loaded = Boolean(data);
  // A wall TV bookmarked to a station that has since been removed (or a
  // mangled link) shows the whole kitchen, with a note, rather than an empty
  // board that looks quiet.
  const unknownStation =
    loaded &&
    Boolean(stationFilter) &&
    (!stationId || !data.stations.some((station) => station.id === stationId));

  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  const say = useCallback((text, tone = "ok") => {
    setToast({ text, tone, at: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3800);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const apply = useCallback((next) => {
    const known = seen.current;
    const arrivals = known
      ? next.tickets.filter((ticket) => ticket.status === "new" && !known.has(ticket.id))
      : [];

    seen.current = new Set([...(known || []), ...next.tickets.map((ticket) => ticket.id)]);

    if (arrivals.length > 0) {
      const until = Date.now() + FRESH_FOR;

      setFresh((current) => {
        const copy = { ...current };

        for (const ticket of arrivals) {
          copy[ticket.id] = until;
        }

        return copy;
      });

      if (soundRef.current) {
        playChime();
      }
    }

    setData(next);
    setOffset(new Date(next.serverTime).getTime() - Date.now());
    setUpdatedAt(Date.now());
    setNow(Date.now());
    setError("");
    setOffline(false);
  }, []);

  const fail = useCallback((err) => {
    setError(getErrorMessage(err));
    setOffline(true);
  }, []);

  const params = useMemo(
    () => ({ ...(stationId ? { stationId } : {}), ...(showOlder ? { older: 1 } : {}) }),
    [stationId, showOlder]
  );

  useEffect(() => {
    stationRef.current = stationId;
    // Another station's tickets are not "new arrivals": no chime, no glow.
    seen.current = null;

    getBoard(params)
      .then((next) => {
        if (stationRef.current === stationId) {
          apply(next);
        }
      })
      .catch(fail);
  }, [params, stationId, apply, fail]);

  const refresh = useCallback(() => {
    // One request at a time. Asked again meanwhile, it goes once more when
    // this one lands, so a tap during a slow refresh still gets fresh figures.
    if (inFlight.current) {
      queued.current = true;
      return Promise.resolve();
    }

    inFlight.current = true;
    const startedAt = actions.current;
    const asked = stationId;
    setRefreshing(true);

    return getBoard(params)
      .then((next) => {
        if (actions.current === startedAt && stationRef.current === asked) {
          apply(next);
        } else {
          queued.current = true;
        }
      })
      .catch(fail)
      .finally(() => {
        inFlight.current = false;
        setRefreshing(false);

        if (queued.current) {
          queued.current = false;
          again.current();
        }
      });
  }, [params, stationId, apply, fail]);

  useEffect(() => {
    again.current = refresh;
  }, [refresh]);

  // Nothing is fetched while the screen is hidden; coming back refreshes at
  // once rather than showing a board ten minutes stale.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }, REFRESH_EVERY);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // On a phone the chips scroll sideways; the station being shown is brought
  // into view, so a tablet opened on ?station=… says which station it is.
  useEffect(() => {
    const active = chipsRef.current && chipsRef.current.querySelector(".kds-chip.is-active");

    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }, [stationId, loaded]);

  // The clocks on the tickets.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(tick);
  }, []);

  // A browser only plays sound after the page has been touched, so the first
  // tap anywhere on the screen unlocks the chime.
  useEffect(() => {
    if (!sound) {
      return undefined;
    }

    const unlock = () => unlockChime();
    document.addEventListener("pointerdown", unlock, { once: true });

    return () => document.removeEventListener("pointerdown", unlock);
  }, [sound]);

  // Focus mode fills the screen for a wall TV or a tablet on the pass.
  const exitFocus = useCallback(() => {
    setFocus(false);

    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => undefined);
    }
  }, []);

  const enterFocus = () => {
    setFocus(true);

    const root = document.documentElement;

    if (root.requestFullscreen && !document.fullscreenElement) {
      root.requestFullscreen().catch(() => undefined);
    }
  };

  useEffect(() => {
    if (!focus) {
      return undefined;
    }

    const onKey = (event) => {
      if (event.key === "Escape") {
        exitFocus();
      }
    };

    const onFullscreen = () => {
      if (!document.fullscreenElement) {
        setFocus(false);
      }
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreen);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [focus, exitFocus]);

  const toggleSound = () => {
    const next = !sound;

    setSound(next);
    writeSound(next);

    if (next && unlockChime()) {
      // Played straight away, so whoever switched it on hears what it sounds like.
      playChime();
    }

    say(next ? "Chime on for new tickets" : "Chime off");
  };

  // Puts a ticket the server just returned into the board, wherever it now belongs.
  const merge = useCallback((ticket) => {
    setData((current) => {
      if (!current) {
        return current;
      }

      const before = current.tickets.find((one) => one.id === ticket.id);
      const others = current.tickets.filter((one) => one.id !== ticket.id);
      const recent = current.recentServed.filter((one) => one.id !== ticket.id);
      // A ticket from an action carries no "same order" list; the one on
      // screen is kept until the refresh that follows brings a new one.
      const placed =
        ticket.siblings || !before ? ticket : { ...ticket, siblings: before.siblings };

      return {
        ...current,
        tickets: OPEN.includes(ticket.status) ? [...others, placed] : others,
        recentServed: ticket.status === "served" ? [ticket, ...recent] : recent,
      };
    });
  }, []);

  const run = async (ticketId, work) => {
    actions.current += 1;
    setBusy((current) => ({ ...current, [ticketId]: true }));

    try {
      const result = await work();

      merge(result.data);

      if (result.message) {
        say(result.message);
      }
    } catch (err) {
      say(getErrorMessage(err), "error");
    } finally {
      refresh();
      setBusy((current) => {
        const copy = { ...current };
        delete copy[ticketId];
        return copy;
      });
    }
  };

  const move = (ticket, status) => run(ticket.id, () => setTicketStatus(ticket.id, status));

  const toggleItem = (ticket, item) => {
    // Shown at once; the server's answer replaces it a moment later.
    merge({
      ...ticket,
      items: ticket.items.map((one) => (one.id === item.id ? { ...one, isDone: !one.isDone } : one)),
    });

    run(ticket.id, async () => ({
      data: (await setTicketItemDone(ticket.id, item.id, !item.isDone)).data,
    }));
  };

  // A station that no longer exists shows the whole kitchen, so Recall
  // brings back the whole kitchen's last ticket, not the missing station's.
  const recall = (ticket) =>
    run(ticket ? ticket.id : "recall", () =>
      ticket ? recallTicket(ticket.id) : recallLastTicket(unknownStation ? null : stationId)
    ).then(() => setPanel(null));

  const clearOld = async (olderThanMinutes) => {
    actions.current += 1;
    setBusy((current) => ({ ...current, clear: true }));

    try {
      const result = await clearOldTickets({
        olderThanMinutes,
        stationId: unknownStation ? null : stationId,
      });

      say(result.message);
      setClearing(false);
    } catch (err) {
      say(getErrorMessage(err), "error");
    } finally {
      refresh();
      setBusy((current) => {
        const copy = { ...current };
        delete copy.clear;
        return copy;
      });
    }
  };

  const print = async (ticket) => {
    try {
      const stamped = await recordTicketPrint(ticket.id);

      merge(stamped);
      printKot(stamped, {
        restaurantName: data.print.restaurantName,
        paperWidth: data.print.paperWidth,
      });
    } catch (err) {
      say(getErrorMessage(err), "error");
    }
  };

  // A change slip from the list: the first print of one no till printed, or
  // a reprint (the paper says REPRINT). The list is read again afterwards.
  const printChange = async (slip) => {
    setBusy((current) => ({ ...current, [`slip-${slip.id}`]: true }));

    try {
      const stamped = await recordSlipPrint(slip.id);

      printSlip(stamped, {
        restaurantName: data.print.restaurantName,
        paperWidth: data.print.paperWidth,
      });
      say(`${slipTitle(stamped)} slip for ${stamped.orderNumber} printed${stamped.printCount > 1 ? " (reprint)" : ""}`);
    } catch (err) {
      say(getErrorMessage(err), "error");
    } finally {
      setBusy((current) => {
        const copy = { ...current };
        delete copy[`slip-${slip.id}`];
        return copy;
      });
      refresh();
    }
  };

  if (!data) {
    return error ? <ErrorMessage message={error} /> : <Loading label="Loading the kitchen…" />;
  }

  const clockNow = now + offset;
  const settings = data.settings;
  // The server already sends one station's tickets when one is chosen; this
  // only matters for the moment between switching station and the new board
  // arriving.
  const inStation = (ticket) => !stationId || unknownStation || ticket.stationId === stationId;
  const visible = data.tickets.filter(inStation);
  const live = visible.filter((ticket) => ticket.status !== "cancelled");
  const byColumn = Object.fromEntries(
    COLUMNS.map((col) => [
      col.key,
      visible
        .filter((ticket) =>
          ticket.status === "cancelled"
            ? (ticket.readyAt ? "ready" : ticket.startedAt ? "cooking" : "new") === col.key
            : ticket.status === col.key
        )
        .sort((a, b) =>
          col.key === "ready"
            ? new Date(a.readyAt || a.createdAt) - new Date(b.readyAt || b.createdAt)
            : new Date(a.createdAt) - new Date(b.createdAt)
        ),
    ])
  );
  // Column counts are live tickets, the same as the figures above; a void
  // ticket still showing is counted beside them, not in them.
  const columnCounts = Object.fromEntries(
    COLUMNS.map((col) => [
      col.key,
      {
        live: byColumn[col.key].filter((ticket) => ticket.status !== "cancelled").length,
        void: byColumn[col.key].filter((ticket) => ticket.status === "cancelled").length,
      },
    ])
  );

  const recentHere = data.recentServed.filter(inStation);
  const lastServed = recentHere[0] || null;
  const allDay = allDayCounts(visible);
  // A switched-off station keeps its chip only while it still has food to finish.
  const stationsShown = data.stations.filter(
    (station) => station.status === "active" || station.openCount > 0
  );
  const currentStation = unknownStation
    ? null
    : data.stations.find((station) => station.id === stationId) || null;
  const kitchenOpen = data.stations.reduce((sum, station) => sum + station.openCount, 0);
  const slips = data.changeSlips || [];
  const unprintedSlips = slips.filter((slip) => slip.printCount === 0).length;
  const kitchenLate = data.stations.some((station) => station.lateCount > 0);
  const stale = live.filter(
    (ticket) => OPEN.includes(ticket.status) && minutesOpen(ticket, clockNow) >= STALE_AFTER_MINUTES
  );
  // Tickets left open from earlier days, not on the board (only counted).
  const earlier = data.earlierOpen && !data.earlierOpen.shown ? data.earlierOpen : null;

  return (
    <section
      className={`kds ${focus ? "is-focus" : ""}`}
      aria-label="Kitchen board"
    >
      {!data.businessDay.isOpen && (
        <div className="alert alert-notice kds-notice" role="status">
          No business day is open, so the tills cannot send orders yet.{" "}
          {canOpenDay && <Link to="/business-day">Open the day</Link>}
        </div>
      )}

      {unknownStation && (
        <div className="alert alert-notice kds-notice" role="status">
          This link was for a station that no longer exists, so every station is shown.{" "}
          <button type="button" className="link-button" onClick={() => setStationFilter("")}>
            Clear it
          </button>
        </div>
      )}

      {earlier && earlier.count > 0 && (
        <div className="alert alert-notice kds-notice kds-stale" role="status">
          <span>
            <strong>
              {plural(earlier.count, "ticket", "tickets")} left open from earlier days
            </strong>{" "}
            (the oldest from {kotDate(earlier.oldestAt)}) are not on the board.{" "}
            {canClear ? "Clear them so the counts are right." : "A manager can clear them from this screen."}
          </span>
          <span className="kds-stale-buttons">
            <button type="button" className="button button-secondary" onClick={() => setOlderFilter("1")}>
              Show them
            </button>
            {canClear && (
              <button type="button" className="button button-secondary kds-stale-action" onClick={() => setClearing(true)}>
                Clear old tickets
              </button>
            )}
          </span>
        </div>
      )}

      {showOlder && (
        <div className="alert alert-info kds-notice" role="status">
          <span>Showing tickets left open from earlier days too.</span>
          <button type="button" className="link-button" onClick={() => setOlderFilter("")}>
            Today&apos;s tickets only
          </button>
        </div>
      )}

      {stale.length > 0 && (
        <div className="alert alert-notice kds-notice kds-stale" role="status">
          <span>
            <strong>
              {plural(stale.length, "ticket has", "tickets have")} been open for over{" "}
              {hoursLabel(STALE_AFTER_MINUTES)}
            </strong>{" "}
            — most likely served without anyone pressing Served.{" "}
            {canClear ? "" : "A manager can clear them from this screen."}
          </span>
          {canClear && (
            <button
              type="button"
              className="button button-secondary kds-stale-action"
              onClick={() => setClearing(true)}
            >
              Clear old tickets
            </button>
          )}
        </div>
      )}

      {focus && (
        <div className="kds-focus-bar">
          <strong>{currentStation ? currentStation.name : "All stations"}</strong>
          <span className="kds-focus-clock">{timeOfDay(clockNow)}</span>
        </div>
      )}

      <StatsStrip
        stats={data.stats}
        live={live}
        settings={settings}
        now={clockNow}
        stationName={currentStation ? currentStation.name : null}
      />

      <div className="kds-toolbar">
        <div className="kds-chips" role="tablist" aria-label="Stations" ref={chipsRef}>
          <StationChip
            label="All stations"
            count={kitchenOpen}
            active={!stationId || unknownStation}
            late={kitchenLate}
            onClick={() => setStationFilter("")}
          />
          {stationsShown.map((station) => (
            <StationChip
              key={station.id}
              label={station.name}
              color={station.color}
              count={station.openCount}
              active={!unknownStation && stationId === station.id}
              muted={station.status !== "active"}
              late={station.lateCount > 0}
              onClick={() => setStationFilter(String(station.id))}
            />
          ))}
        </div>

        <div className="kds-tools">
          <button
            type="button"
            className={`kds-tool ${panel === "allday" ? "is-on" : ""}`}
            onClick={() => setPanel(panel === "allday" ? null : "allday")}
            aria-expanded={panel === "allday"}
            title="How many of each dish are still to cook"
          >
            <Glyph name="list" />
            <span className="kds-tool-label">All-day</span>
          </button>

          {canManage && (
            <div className="kds-split">
              <button
                type="button"
                className="kds-tool"
                onClick={() => recall(null)}
                disabled={!lastServed || Boolean(busy.recall)}
                title={
                  lastServed
                    ? `Bring ${lastServed.kotNo} back to the pass`
                    : "Nothing served in the last three hours"
                }
              >
                <Glyph name="recall" />
                <span className="kds-tool-label">
                  Recall
                  {lastServed && <span className="kds-tool-more"> {lastServed.kotNo}</span>}
                </span>
              </button>
              <button
                type="button"
                className={`kds-tool kds-tool-caret ${panel === "served" ? "is-on" : ""}`}
                onClick={() => setPanel(panel === "served" ? null : "served")}
                aria-expanded={panel === "served"}
                aria-label="Recently served tickets"
                title="Recently served tickets"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                  <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.5" />
                </svg>
              </button>
            </div>
          )}

          {/* Dishes taken off and tables changed after the KOT went to
              paper. A slip no till has printed is counted on the button. */}
          <button
            type="button"
            className={`kds-tool ${panel === "slips" ? "is-on" : ""} ${unprintedSlips > 0 ? "has-alert" : ""}`}
            onClick={() => setPanel(panel === "slips" ? null : "slips")}
            aria-expanded={panel === "slips"}
            title="Cancel and table-changed slips for tickets the kitchen has on paper"
          >
            <Glyph name="print" />
            <span className="kds-tool-label">
              Change slips
              {unprintedSlips > 0 && <span className="kds-tool-badge">{unprintedSlips}</span>}
            </span>
          </button>

          {/* The kitchen is the first to know a dish has run out: one tap
              here and the tills stop selling it (menu.availability). */}
          {canMarkSoldOut && (
            <button
              type="button"
              className={`kds-tool ${panel === "soldout" ? "is-on" : ""}`}
              onClick={() => setPanel(panel === "soldout" ? null : "soldout")}
              aria-expanded={panel === "soldout"}
              title="Mark a dish sold out for today, or put it back on sale"
            >
              <Glyph name="ban" />
              <span className="kds-tool-label">Sold out</span>
            </button>
          )}

          <button
            type="button"
            className={`kds-tool ${sound ? "is-on" : ""}`}
            onClick={toggleSound}
            aria-pressed={sound}
            title={sound ? "Chime on for new tickets" : "Chime off"}
          >
            <Glyph name={sound ? "bell" : "bellOff"} />
            <span className="kds-tool-label">
              Chime<span className="kds-tool-more">{sound ? " on" : " off"}</span>
            </span>
          </button>

          <button
            type="button"
            className="kds-tool"
            onClick={focus ? exitFocus : enterFocus}
            title={focus ? "Leave full screen (Esc)" : "Full screen for a wall TV or tablet"}
          >
            <Glyph name={focus ? "collapse" : "expand"} />
            <span className="kds-tool-label">{focus ? "Exit" : "Focus"}</span>
          </button>

          <button
            type="button"
            className={`kds-live ${offline ? "is-offline" : ""}`}
            onClick={refresh}
            title={offline ? "Cannot reach the server — retrying. Tap to try now." : "Refresh now"}
          >
            <span className={`live-dot ${refreshing ? "is-busy" : ""}`} aria-hidden="true" />
            <span className="kds-tool-label">
              {offline ? "Offline" : "Live"}
              <span className="kds-tool-more">
                {offline ? " — retrying" : ` · ${ago(now - (updatedAt || now))}`}
              </span>
            </span>
          </button>
        </div>
      </div>

      {panel === "allday" && (
        <AllDayPanel rows={allDay} stationName={currentStation ? currentStation.name : null} />
      )}

      {panel === "slips" && (
        <ChangeSlipsPanel slips={slips} busy={busy} onPrint={printChange} />
      )}

      {panel === "soldout" && canMarkSoldOut && (
        <KitchenSoldOut onClose={() => setPanel(null)} onChanged={(message) => say(message)} />
      )}

      {panel === "served" && canManage && (
        <ServedPanel
          tickets={recentHere}
          now={clockNow}
          busy={busy}
          onRecall={(ticket) => recall(ticket)}
        />
      )}

      <div className="segmented kds-column-switch" role="tablist" aria-label="Board columns">
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            type="button"
            role="tab"
            aria-selected={column === col.key}
            className={`segment ${column === col.key ? "is-active" : ""}`}
            onClick={() => setColumn(col.key)}
          >
            {col.label} <span className="kds-switch-count">{columnCounts[col.key].live}</span>
          </button>
        ))}
      </div>

      <div className="kds-columns">
        {COLUMNS.map((col) => (
          <section
            key={col.key}
            className={`kds-column kds-column-${col.key} ${column === col.key ? "is-current" : ""}`}
            aria-label={`${col.label} tickets`}
          >
            <header className="kds-column-head">
              <span className={`kds-status-pill kds-pill-${col.key}`}>{col.label}</span>
              <span className="kds-column-count">{columnCounts[col.key].live}</span>
              {columnCounts[col.key].void > 0 && (
                <span className="kds-column-void" title="Cancelled at the till, leaving shortly">
                  + {columnCounts[col.key].void} void
                </span>
              )}
              <span className="kds-column-hint">{col.hint}</span>
            </header>

            {byColumn[col.key].length === 0 ? (
              <div className="kds-column-empty">
                <Glyph name={col.key === "ready" ? "tray" : col.key === "cooking" ? "flame" : "clock"} size={26} />
                <p>
                  {col.key === "new"
                    ? "No new tickets"
                    : col.key === "cooking"
                      ? "Nothing on the stove"
                      : "Nothing waiting at the pass"}
                </p>
                <small>
                  {col.key === "new"
                    ? "Orders from the POS appear here within ten seconds."
                    : col.key === "cooking"
                      ? "Tap Start on a new ticket when it goes on."
                      : "Ready plates wait here until they are served."}
                </small>
              </div>
            ) : (
              <div className="kds-tickets">
                {byColumn[col.key].map((ticket) => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    now={clockNow}
                    settings={settings}
                    fresh={(fresh[ticket.id] || 0) > now}
                    busy={Boolean(busy[ticket.id])}
                    canManage={canManage}
                    siblings={ticket.siblings || []}
                    onMove={(status) => move(ticket, status)}
                    onToggle={(item) => toggleItem(ticket, item)}
                    onPrint={() => print(ticket)}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      {clearing && (
        <ClearOldDialog
          tickets={live}
          earlier={earlier}
          now={clockNow}
          stationName={currentStation ? currentStation.name : null}
          busy={Boolean(busy.clear)}
          onClear={clearOld}
          onClose={() => setClearing(false)}
        />
      )}

      {toast && (
        <div
          key={toast.at}
          className={`kds-toast ${toast.tone === "error" ? "is-error" : ""}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          {toast.text}
        </div>
      )}
    </section>
  );
}

// "Clear old tickets": the end of a rush, when the line cooked everything and
// nobody pressed Served. Says how many each choice would take off before
// anything is touched.
function ClearOldDialog({ tickets, earlier, now, stationName, busy, onClear, onClose }) {
  const [age, setAge] = useState(STALE_AFTER_MINUTES);
  const open = tickets.filter((ticket) => OPEN.includes(ticket.status));
  // The board's own tickets, and those left open from earlier days (counted
  // by the server, not on the board).
  const olderThan = (minutes) =>
    open.filter((ticket) => minutesOpen(ticket, now) >= minutes).length +
    Number((earlier && earlier.olderThan && earlier.olderThan[minutes]) || 0);
  const chosen = olderThan(age);

  return (
    <Modal
      title="Clear old tickets"
      description="Tidy the board after a rush nobody bumped."
      icon="refresh"
      onClose={onClose}
      width={480}
    >
      <div className="stack kds-clear">
        <p>
          Open tickets older than this leave the board{stationName ? ` at ${stationName}` : ""}.
          They are marked as cleared rather than served, so they stay out of the ticket times and
          cannot be recalled. Nothing is billed or cancelled.
        </p>

        <div className="kds-clear-choices" role="radiogroup" aria-label="Older than">
          {CLEAR_CHOICES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              role="radio"
              aria-checked={age === minutes}
              className={`kds-clear-choice ${age === minutes ? "is-picked" : ""}`}
              onClick={() => setAge(minutes)}
            >
              <strong>Over {hoursLabel(minutes)}</strong>
              <span>{plural(olderThan(minutes), "ticket", "tickets")}</span>
            </button>
          ))}
        </div>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={busy || chosen === 0}
            onClick={() => onClear(age)}
          >
            {busy ? "Clearing…" : chosen === 0 ? "Nothing that old" : `Clear ${plural(chosen, "ticket", "tickets")}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function StationChip({ label, color, count: total, active, muted, late, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`kds-chip ${active ? "is-active" : ""} ${muted ? "is-muted" : ""} ${
        color ? `station-${color}` : ""
      }`}
      onClick={onClick}
    >
      {color && <span className="kds-chip-dot" aria-hidden="true" />}
      <span>{label}</span>
      <span className="kds-chip-count">{total}</span>
      {late && (
        <span className="kds-chip-late" title="Has a late ticket">
          <span className="sr-only">has a late ticket</span>
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------- figures

function StatsStrip({ stats, live, settings, now, stationName }) {
  const waiting = live
    .filter((ticket) => ticket.status === "new" || ticket.status === "cooking")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const oldest = waiting[0] || null;
  const oldestFor = oldest ? now - new Date(oldest.createdAt).getTime() : 0;
  const oldestTone = oldest ? toneFor(oldestFor, settings.warnMinutes, settings.lateMinutes) : "calm";

  const counts = {
    new: live.filter((ticket) => ticket.status === "new").length,
    cooking: live.filter((ticket) => ticket.status === "cooking").length,
    ready: live.filter((ticket) => ticket.status === "ready").length,
  };

  const avg = stats ? stats.avgReadySeconds : null;
  const avgTone =
    avg === null || avg === undefined
      ? "calm"
      : toneFor(avg * 1000, settings.warnMinutes, settings.lateMinutes);

  const scope = stationName ? `at ${stationName}` : "today";
  // The board's calm / warning / late, in the shared tile tones.
  const tileTone = { calm: "success", warning: "warning", late: "danger" };

  return (
    <div className="stat-grid kds-stats">
      <StatTile
        icon="receipt"
        tone="primary"
        label="Open tickets"
        value={count(live.length)}
      >
        <span className="kds-stat-note">
          <span className="kds-mini kds-pill-new">{counts.new} new</span>
          <span className="kds-mini kds-pill-cooking">{counts.cooking} cooking</span>
          <span className="kds-mini kds-pill-ready">{counts.ready} ready</span>
        </span>
      </StatTile>

      <StatTile
        icon="timer"
        tone={oldest ? tileTone[oldestTone] : "neutral"}
        label="Oldest waiting"
        value={<span className="mono">{oldest ? ticketClock(oldest, now, settings).text : "—"}</span>}
        note={
          oldest
            ? `${oldest.kotNo} · ${destination(oldest).primary} · ${oldest.status === "new" ? "not started" : "cooking"}`
            : "Nothing waiting"
        }
        className={oldest && oldestTone === "late" ? "kds-tile-late" : ""}
      />

      <StatTile
        icon="clock"
        tone={avg === null || avg === undefined ? "neutral" : tileTone[avgTone]}
        label="Average ticket time"
        value={duration(avg)}
        note={
          stats && stats.timedCount > 0
            ? `sent to ready, ${plural(stats.timedCount, "ticket", "tickets")} ${scope}`
            : `No ticket finished ${scope} yet`
        }
      />

      <StatTile
        icon="alert"
        tone={stats && stats.lateCount > 0 ? "danger" : "success"}
        label="Late tickets"
        value={stats ? count(stats.lateCount) : "—"}
        of={stats && stats.totalCount > 0 ? ` / ${count(stats.totalCount)}` : undefined}
        note={`over ${settings.lateMinutes} min ${scope}${stats && stats.servedCount > 0 ? ` · ${count(stats.servedCount)} served` : ""}`}
        title={stats && stats.clearedCount > 0 ? `${count(stats.clearedCount)} cleared without a bump` : undefined}
        className={stats && stats.lateCount > 0 ? "kds-tile-late" : ""}
      />
    </div>
  );
}

function AllDayPanel({ rows, stationName }) {
  return (
    <SectionCard
      className="kds-panel"
      icon="list"
      title={`All-day count${stationName ? ` · ${stationName}` : ""}`}
      description="Still to cook across every new and cooking ticket."
    >

      {rows.length === 0 ? (
        <p className="muted small">Nothing left to cook. Every open dish is done or at the pass.</p>
      ) : (
        <ul className="kds-allday">
          {rows.map((row) => (
            <li key={row.key}>
              <span className="kds-allday-qty">{qty(row.quantity)}</span>
              <span className="kds-allday-name">
                <span className={`food-dot food-${row.foodType || "veg"}`} aria-hidden="true" />
                <span className="kds-kitchen-name">
                  {row.label}
                  {row.subLabel && <span className="kds-menu-name">{row.subLabel}</span>}
                </span>
                {row.variantLabel && <span className="kds-variant">{row.variantLabel}</span>}
              </span>
              <span className="kds-allday-tickets">{plural(row.tickets, "ticket", "tickets")}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ServedPanel({ tickets, now, busy, onRecall }) {
  return (
    <SectionCard
      className="kds-panel"
      icon="history"
      tone="info"
      title="Recently served"
      description="Bumped by mistake, or a plate came back? Recall it to the pass."
    >

      {tickets.length === 0 ? (
        <p className="muted small">Nothing has been served in the last three hours.</p>
      ) : (
        <ul className="kds-served">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <span className="kds-served-no mono">{ticket.kotNo}</span>
              <span className="kds-served-where">
                <strong>
                  {[destination(ticket).primary, destination(ticket).secondary].filter(Boolean).join(" · ")}
                </strong>
                <span className="muted small">
                  {ticket.stationName} · {plural(ticket.items.filter((item) => item.liveQuantity > 0).length, "dish", "dishes")}
                  {" · served "}
                  {ago(now - new Date(ticket.servedAt).getTime())}
                  {ticket.servedByName ? ` by ${ticket.servedByName}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="chip-button"
                onClick={() => onRecall(ticket)}
                disabled={Boolean(busy[ticket.id])}
              >
                <Glyph name="recall" size={14} /> Recall
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// The day's change slips: what the tills took off, cancelled or moved after
// the kitchen had the KOT on paper. Newest first; one nobody printed is
// marked, and any can be printed (again) from here.
function ChangeSlipsPanel({ slips, busy, onPrint }) {
  return (
    <SectionCard
      className="kds-panel"
      icon="print"
      tone="warning"
      title="Change slips"
      description="When a dish on a printed KOT is taken off, the order is cancelled or the party moves table, the till prints one of these for the station. Printing again says REPRINT."
    >
      {slips.length === 0 ? (
        <p className="muted small">No dish on a printed KOT has been taken off or moved today.</p>
      ) : (
        <ul className="kds-served kds-slips">
          {slips.map((slip) => (
            <li key={slip.id} className={slip.printCount === 0 ? "is-unprinted" : ""}>
              <span className={`kds-slip-kind kind-${slip.kind}`}>{slipTitle(slip)}</span>
              <span className="kds-served-where">
                <strong>
                  {slip.kind === "table_changed"
                    ? `${slip.fromTableNo} → ${slip.toTableNo}`
                    : slip.tableNo || slip.orderNumber}
                  {" · "}
                  {slip.lines.map((line) => `${qty(line.quantity)} × ${shortName(line, slip.nameMode)}`).join(", ")}
                </strong>
                <span className="muted small">
                  {[
                    slip.stationName,
                    slip.orderNumber,
                    slip.kotNos.join(", "),
                    timeOfDay(slip.createdAt),
                    slip.reason,
                    slip.changedByName ? `by ${slip.changedByName}` : null,
                    slip.approvedByName ? `approved by ${slip.approvedByName}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className={`kds-slip-printed ${slip.printCount === 0 ? "is-pending" : ""}`}>
                {slip.printCount === 0 ? "Not printed" : `Printed${slip.printCount > 1 ? ` ×${slip.printCount}` : ""}`}
              </span>
              <button
                type="button"
                className="chip-button"
                onClick={() => onPrint(slip)}
                disabled={Boolean(busy[`slip-${slip.id}`])}
              >
                <Glyph name="print" size={14} /> {slip.printCount === 0 ? "Print" : "Reprint"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------- a ticket

const NEXT = {
  new: { status: "cooking", label: "Start cooking" },
  cooking: { status: "ready", label: "Mark ready" },
  ready: { status: "served", label: "Served" },
};

const BACK = {
  cooking: { status: "new", label: "Back to new" },
  ready: { status: "cooking", label: "Back to cooking" },
};

function TicketCard({ ticket, now, settings, fresh, busy, canManage, siblings, onMove, onToggle, onPrint }) {
  const where = destination(ticket);
  const timer = ticketClock(ticket, now, settings);
  // A ticket that turns late while the board is open blinks its late dot a
  // few times (styles/kitchen.css); one already late when the board opened
  // just shows the dot. A board opened on hundreds of late tickets then
  // starts still, instead of making every one of them blink at once.
  const [toneAtOpen] = useState(timer.tone);
  const turnedLate = timer.tone === "late" && toneAtOpen !== "late";
  const isVoid = ticket.status === "cancelled";
  const live = ticket.items.filter((item) => item.liveQuantity > 0);
  const done = live.filter((item) => item.isDone).length;
  const next = NEXT[ticket.status];
  const back = BACK[ticket.status];
  const canTap = canManage && !isVoid && !busy;
  const cookedIn =
    ticket.status === "ready" && ticket.readyAt
      ? new Date(ticket.readyAt).getTime() - new Date(ticket.createdAt).getTime()
      : null;

  return (
    <article
      className={[
        "kot-card",
        `station-${ticket.stationColor}`,
        `status-${ticket.status}`,
        isVoid ? "is-void" : `tone-${timer.tone}`,
        fresh ? "is-fresh" : "",
      ].join(" ")}
      aria-label={`${ticket.kotNo} for ${where.primary}`}
    >
      <header className="kot-head">
        <div className="kot-where">
          <span className="kot-dest">{where.primary}</span>
          <span className="kot-sub">
            {[where.secondary, ticket.guestCount ? plural(ticket.guestCount, "cover", "covers") : null]
              .filter(Boolean)
              .join(" · ") || ticket.orderNumber}
          </span>
        </div>

        {isVoid ? (
          <span className="kot-timer kot-void-stamp">VOID</span>
        ) : (
          <span
            className={`kot-timer tone-${timer.tone}${turnedLate ? " turned-late" : ""}`}
            title={`${timer.text} ${timer.label}`}
          >
            <span className="kot-timer-value mono">{timer.text}</span>
            <span className="kot-timer-label">{timer.label}</span>
          </span>
        )}
      </header>

      <div className="kot-meta">
        {ticket.tokenNo && <span className="kot-flag is-token">Token {ticket.tokenNo}</span>}
        <span className="kot-no mono">{ticket.kotNo}</span>
        <span>{ticket.orderNumber}</span>
        <span>Sent {timeOfDay(ticket.createdAt)}</span>
        <span className="kot-station">
          <span className="kot-station-dot" aria-hidden="true" />
          {ticket.stationName}
        </span>
        {ticket.takenByLabel && (
          <span className="kot-taker" title="Who took this order — call them when it is up">
            <Glyph name="user" size={13} />
            {ticket.takenByLabel}
          </span>
        )}
        {/* A later round added, or a held course fired, by someone other
            than the person who opened the order: theirs to call. */}
        {ticket.sentByLabel && (
          <span className="kot-taker kot-sender" title="Who sent this round to the kitchen">
            <Glyph name="user-plus" size={13} />
            {ticket.sentByLabel}
          </span>
        )}
        {ticket.round > 1 && <span className="kot-flag">Round {ticket.round}</span>}
        {cookedIn !== null && (
          <span className="kot-flag is-good">Cooked in {Math.max(1, Math.round(cookedIn / 60000))} min</span>
        )}
        {cookedIn === null && done > 0 && live.length > 1 && (
          <span className="kot-flag is-good">
            {done}/{live.length} up
          </span>
        )}
        {ticket.recallCount > 0 && <span className="kot-flag is-warning">Recalled</span>}
        {ticket.printCount > 0 && (
          <span className="kot-flag is-quiet" title={`Printed ${ticket.printCount} time(s)`}>
            Printed{ticket.printCount > 1 ? ` ×${ticket.printCount}` : ""}
          </span>
        )}
      </div>

      {ticket.orderNotes && (
        <p className="kot-order-note">
          <Glyph name="alert" size={15} />
          <span>{ticket.orderNotes}</span>
        </p>
      )}

      {isVoid && (
        <p className="kot-void-banner">Cancelled at the till — stop cooking. This leaves the board shortly.</p>
      )}

      <ul className="kot-lines">
        {ticket.items.map((item) => {
          const gone = item.liveQuantity <= 0;
          const tappable = canTap && !gone;
          // SW-A-12: the kitchen's own names, as the kitchen settings choose.
          const names = itemNames(item, ticket.nameMode);

          const body = (
            <>
              <span className="kot-qty">{qty(gone ? item.quantity : item.liveQuantity)}</span>
              <span className="kot-dish">
                <span className="kot-dish-name">
                  <span className={`food-dot food-${item.foodType || "veg"}`} aria-hidden="true" />
                  <span className="kds-kitchen-name">
                    {names.main}
                    {names.sub && <span className="kds-menu-name">{names.sub}</span>}
                  </span>
                  {names.variant && <span className="kds-variant">{names.variant}</span>}
                </span>
                {names.modifiers.length > 0 && (
                  <span className="kot-mods">{names.modifiers.map((name) => `+ ${name}`).join("  ")}</span>
                )}
                {names.components.length > 0 && (
                  <span className="kot-parts">
                    {names.components
                      .map((part) => `${qty(part.quantity)} × ${part.name}${part.variant ? ` (${part.variant})` : ""}`)
                      .join(" · ")}
                  </span>
                )}
                {item.notes && <span className="kot-note">{item.notes}</span>}
                {gone && <span className="kot-void-tag">Cancelled</span>}
                {!gone && item.cancelledQuantity > 0 && (
                  <span className="kot-void-tag">{qty(item.cancelledQuantity)} cancelled</span>
                )}
              </span>
              {!gone && (
                <span className={`kot-check ${item.isDone ? "is-done" : ""}`} aria-hidden="true">
                  {item.isDone && <Glyph name="check" size={16} />}
                </span>
              )}
            </>
          );

          const className = `kot-line ${item.isDone && !gone ? "is-done" : ""} ${gone ? "is-gone" : ""}`;

          return (
            <li key={item.id}>
              {tappable ? (
                <button
                  type="button"
                  className={className}
                  onClick={() => onToggle(item)}
                  aria-pressed={item.isDone}
                  title={item.isDone ? "Tap to mark not done" : "Tap when this dish is up"}
                >
                  {body}
                </button>
              ) : (
                <div className={className}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>

      {siblings.length > 0 && (
        <p className="kot-siblings">
          Same order:{" "}
          {siblings.map((other, index) => (
            <span key={other.id}>
              {index > 0 && ", "}
              <span className={`kot-sibling station-${other.stationColor}`}>
                {other.stationName} {other.kotNo}
              </span>{" "}
              <span className="muted">({other.status})</span>
            </span>
          ))}
        </p>
      )}

      <footer className="kot-actions">
        {canManage && next && !isVoid && (
          <button
            type="button"
            className={`kot-primary go-${next.status}`}
            onClick={() => onMove(next.status)}
            disabled={busy}
          >
            {next.status === "served" && <Glyph name="check" size={18} />}
            {next.label}
          </button>
        )}

        {canManage && ticket.status === "new" && (
          <button
            type="button"
            className="kot-secondary"
            onClick={() => onMove("ready")}
            disabled={busy}
            title="Straight to ready — for drinks and quick plates"
          >
            Ready
          </button>
        )}

        {canManage && back && !isVoid && (
          <button
            type="button"
            className="kot-icon-button"
            onClick={() => onMove(back.status)}
            disabled={busy}
            title={back.label}
            aria-label={back.label}
          >
            <Glyph name="undo" />
          </button>
        )}

        {!isVoid && (
          <button
            type="button"
            className="kot-icon-button"
            onClick={onPrint}
            title="Print this KOT"
            aria-label={`Print ${ticket.kotNo}`}
          >
            <Glyph name="print" />
          </button>
        )}
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------- stations

function StationsSetup() {
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const messageTimer = useRef(null);

  const fail = useCallback((err) => setError(getErrorMessage(err)), []);

  const note = useCallback((text) => {
    setMessage(text);
    setError("");
    clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(""), 4000);
  }, []);

  useEffect(() => () => clearTimeout(messageTimer.current), []);

  const reload = useCallback(() => getStationSetup().then(setSetup).catch(fail), [fail]);

  useEffect(() => {
    getStationSetup().then(setSetup).catch(fail);
  }, [fail]);

  const act = async (work) => {
    setSaving(true);

    try {
      const result = await work();

      if (result && result.message) {
        note(result.message);
      }

      await reload();
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!setup) {
    return error ? <ErrorMessage message={error} /> : <Loading label="Loading stations…" />;
  }

  const stationById = new Map(setup.stations.map((station) => [station.id, station]));
  const fallback = setup.stations.find((station) => station.isDefault);
  const active = setup.stations.filter((station) => station.status === "active");

  return (
    <div className="stack kds-setup">
      <div className="kds-route-explainer card">
        <Glyph name="route" size={22} />
        <div>
          <strong>How a dish finds its station</strong>
          <ol className="kds-route-steps">
            <li>
              <span className="kds-step">1</span>
              <span>
                A <em>dish exception</em>, if it has one
              </span>
            </li>
            <li>
              <span className="kds-step">2</span>
              <span>
                Otherwise its <em>category&rsquo;s</em> station
              </span>
            </li>
            <li>
              <span className="kds-step">3</span>
              <span>
                Otherwise the default station
                {fallback ? (
                  <>
                    , <strong>{fallback.name}</strong>
                  </>
                ) : null}
              </span>
            </li>
          </ol>
          <p className="muted small">
            One order becomes one ticket per station per round, so the tandoor never scrolls past
            the bar&rsquo;s drinks. Changes apply to the next ticket cut; tickets already on the
            board stay where they are.
          </p>
        </div>
      </div>

      {error && <ErrorMessage message={error} />}
      {message && (
        <div className="alert alert-success" role="status">
          {message}
        </div>
      )}

      <div className="kds-setup-grid">
        <SectionCard
          icon="chef"
          title="Stations"
          description="Each station gets its own tickets and its own chip on the board."
          actions={
            <button type="button" className="button button-sm" onClick={() => setEditing({})}>
              <Icon name="plus" size={15} /> Add station
            </button>
          }
        >

          <ul className="kds-station-list">
            {setup.stations.map((station) => (
              <li key={station.id} className={`station-${station.color} ${station.status !== "active" ? "is-off" : ""}`}>
                <span className="kds-swatch" aria-hidden="true" />
                <div className="kds-station-name">
                  <strong>{station.name}</strong>
                  {station.isDefault && <span className="badge badge-active">Default</span>}
                  {station.status !== "active" && <span className="badge badge-inactive">Switched off</span>}
                </div>
                <span className="kds-station-meta muted small">
                  {plural(station.categoryCount, "category", "categories")} ·{" "}
                  {plural(station.productCount, "dish exception", "dish exceptions")} ·{" "}
                  {plural(station.openCount, "open ticket", "open tickets")}
                </span>
                <div className="row-actions kds-station-actions">
                  <button type="button" className="chip-button" onClick={() => setEditing(station)}>
                    <Icon name="edit" size={14} /> Edit
                  </button>
                  {!station.isDefault && station.status === "active" && (
                    <button
                      type="button"
                      className="chip-button"
                      disabled={saving}
                      onClick={() => act(() => makeDefaultStation(station.id))}
                    >
                      Make default
                    </button>
                  )}
                  {!station.isDefault && (
                    <button
                      type="button"
                      className="chip-button"
                      disabled={saving}
                      onClick={() =>
                        act(() =>
                          updateStation(station.id, {
                            name: station.name,
                            color: station.color,
                            sortOrder: station.sortOrder,
                            status: station.status === "active" ? "inactive" : "active",
                          })
                        )
                      }
                    >
                      {station.status === "active" ? "Switch off" : "Switch on"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <p className="muted small kds-setup-foot">
            A switched-off station takes no new tickets: its dishes go to the default station until
            it is back on.
          </p>
        </SectionCard>

        <SectionCard
          icon="grid"
          tone="info"
          title="Categories"
          description="Where each part of the menu is cooked."
          className="kds-route-card"
        >

          {setup.categories.length === 0 ? (
            <EmptyState
              icon="grid"
              message="No menu categories yet"
              hint="Add categories to the menu, then choose a station for each."
              action={
                <Link className="button button-secondary" to="/menu/categories">
                  Go to categories
                </Link>
              }
            />
          ) : (
            <DataGrid
              id="kitchen-category-stations"
              caption="Which station cooks each menu category"
              variant="compact"
              className="kds-route-grid"
              rows={setup.categories}
              rowKey={(category) => category.id}
              rowNoun={["category", "categories"]}
              rowClassName={(category) => (category.status !== "active" ? "dg-tone-muted" : "")}
              columns={[
                {
                  key: "category",
                  header: "Category",
                  value: (category) => category.name,
                  mobile: "title",
                  render: (category) => (
                    <>
                      <strong>{category.name}</strong>
                      {category.status !== "active" && <span className="tag">hidden</span>}
                    </>
                  ),
                },
                {
                  key: "dishes",
                  header: "Dishes",
                  type: "number",
                  value: (category) => category.productCount,
                  mobile: "subtitle",
                  render: (category) => plural(category.productCount, "dish", "dishes"),
                },
                {
                  key: "station",
                  header: "Cooked at",
                  // Sorted by the station's name; "Default" where the category has none.
                  value: (category) =>
                    category.stationId && stationById.get(category.stationId)
                      ? stationById.get(category.stationId).name
                      : "Default",
                  minWidth: 200,
                  mobile: "show",
                  render: (category) => {
                    const mapped = category.stationId ? stationById.get(category.stationId) : null;
                    const off = mapped && mapped.status !== "active";

                    return (
                      <>
                        <select
                          className="kds-select"
                          aria-label={`Station for ${category.name}`}
                          value={category.stationId || ""}
                          disabled={saving}
                          onChange={(event) =>
                            act(() => setCategoryStation(category.id, Number(event.target.value) || null)).then(
                              (ok) =>
                                ok &&
                                note(
                                  `${category.name} → ${
                                    event.target.value
                                      ? stationById.get(Number(event.target.value)).name
                                      : `default (${fallback ? fallback.name : "main kitchen"})`
                                  }`
                                )
                            )
                          }
                        >
                          <option value="">Default{fallback ? ` · ${fallback.name}` : ""}</option>
                          {setup.stations.map((station) => (
                            <option key={station.id} value={station.id} disabled={station.status !== "active"}>
                              {station.name}
                              {station.status !== "active" ? " (switched off)" : ""}
                            </option>
                          ))}
                        </select>
                        {off && (
                          <small className="kds-warn-text">
                            Switched off — goes to {fallback ? fallback.name : "the default"} for now
                          </small>
                        )}
                      </>
                    );
                  },
                },
              ]}
            />
          )}
        </SectionCard>
      </div>

      <div className="kds-setup-grid">
        <DishExceptions
          exceptions={setup.exceptions}
          stations={active}
          stationById={stationById}
          fallback={fallback}
          saving={saving}
          onSet={(productId, stationId) => act(() => setDishStation(productId, stationId))}
        />

        <div className="stack">
          <TimersCard settings={setup.settings} onSave={(payload) => act(() => updateKitchenSettings(payload))} />
          <KitchenNamesCard
            mode={setup.settings.kitchenNameMode || "both"}
            saving={saving}
            onSave={(kitchenNameMode) => act(() => updateKitchenSettings({ kitchenNameMode }))}
          />
        </div>
      </div>

      {editing && (
        <StationModal
          station={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            const ok = await act(() =>
              editing.id ? updateStation(editing.id, payload) : createStation(payload)
            );

            if (ok) {
              setEditing(null);
            }
          }}
          saving={saving}
        />
      )}
    </div>
  );
}

function DishExceptions({ exceptions, stations, stationById, fallback, saving, onSet }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [choice, setChoice] = useState({});

  // Waits for a pause in typing before asking, so a fast typist sends one
  // search rather than one per letter.
  useEffect(() => {
    const term = search.trim();

    if (term.length < 2) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setSearching(true);
      searchDishes(term)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);

    return () => clearTimeout(timer);
  }, [search]);

  const shown = search.trim().length < 2 ? [] : results;
  const nameOf = (id) => (id && stationById.get(id) ? stationById.get(id).name : null);
  const activeName = (id) =>
    id && stationById.get(id) && stationById.get(id).status === "active" ? stationById.get(id).name : null;
  // Where a dish goes today, said the way routing works it out: its own
  // exception, else its category's station, else the default one, by name.
  // A switched-off station hands its dishes to the default, so it says that.
  const goesTo = (dish) => {
    if (activeName(dish.exceptionStationId)) {
      return `${activeName(dish.exceptionStationId)} (dish exception)`;
    }

    if (activeName(dish.categoryStationId)) {
      return activeName(dish.categoryStationId);
    }

    return fallback ? `${fallback.name} (default)` : "the default station";
  };

  return (
    <SectionCard
      icon="utensils"
      tone="warning"
      title="Dish exceptions"
      description="A dish cooked somewhere other than its category's station."
    >

      <label className="field">
        <span>Find a dish</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="e.g. Paneer Tikka, Chilli Chicken"
        />
      </label>

      {search.trim().length >= 2 && (
        <ul className="kds-dish-results">
          {searching && shown.length === 0 && <li className="muted small">Searching…</li>}
          {!searching && shown.length === 0 && <li className="muted small">No dish matches “{search.trim()}”.</li>}
          {shown.map((dish) => {
            const current = goesTo(dish);
            const picked = choice[dish.id] ?? "";

            return (
              <li key={dish.id}>
                <span className="kds-dish-name">
                  <span className={`food-dot food-${dish.foodType}`} aria-hidden="true" />
                  <strong>{dish.name}</strong>
                  <span className="muted small">
                    {dish.categoryName} · now {current}
                  </span>
                </span>
                <select
                  className="kds-select"
                  aria-label={`Station for ${dish.name}`}
                  value={picked}
                  onChange={(event) => setChoice({ ...choice, [dish.id]: event.target.value })}
                >
                  <option value="">Choose station…</option>
                  {stations.map((station) => (
                    <option key={station.id} value={station.id}>
                      {station.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="chip-button"
                  disabled={!picked || saving}
                  onClick={() => onSet(dish.id, Number(picked)).then(() => setSearch(""))}
                >
                  Send there
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {exceptions.length === 0 ? (
        <p className="muted small kds-setup-foot">
          No exceptions yet — every dish follows its category. Typical ones: Paneer Tikka to the
          tandoor, Chilli Chicken to the wok.
        </p>
      ) : (
        <ul className="kds-exceptions">
          {exceptions.map((row) => (
            <li key={row.productId}>
              <span className="kds-dish-name">
                <span className={`food-dot food-${row.foodType}`} aria-hidden="true" />
                <strong>{row.productName}</strong>
                <span className="muted small">from {row.categoryName}</span>
              </span>
              <span className={`kds-exception-to station-${stationById.get(row.stationId)?.color || "slate"}`}>
                <span className="kot-station-dot" aria-hidden="true" />
                {nameOf(row.stationId)}
              </span>
              <button
                type="button"
                className="link-button"
                disabled={saving}
                onClick={() => onSet(row.productId, null)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function TimersCard({ settings, onSave }) {
  const [warn, setWarn] = useState(String(settings.warnMinutes));
  const [late, setLate] = useState(String(settings.lateMinutes));
  // How long plated food may wait at the pass before the bell says so.
  const [pass, setPass] = useState(String(settings.passMinutes ?? 8));

  // Three example tickets, so the effect of the numbers is visible before saving.
  const sample = [5, 12, 25].map((minutes) => ({
    minutes,
    tone: toneFor(minutes * 60000, Number(warn), Number(late)),
  }));

  return (
    <SectionCard
      icon="timer"
      tone="danger"
      title="Kitchen timers"
      description="When a ticket turns amber, then red."
    >

      <form
        className="kds-timers"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ warnMinutes: Number(warn), lateMinutes: Number(late), passMinutes: Number(pass) });
        }}
      >
        <label className="field">
          <span>Warning after (minutes)</span>
          <input type="number" min="1" max="120" value={warn} onChange={(event) => setWarn(event.target.value)} />
        </label>
        <label className="field">
          <span>Late after (minutes)</span>
          <input type="number" min="2" max="180" value={late} onChange={(event) => setLate(event.target.value)} />
        </label>
        <label className="field">
          <span>At the pass, flag after (minutes)</span>
          <input type="number" min="1" max="60" value={pass} onChange={(event) => setPass(event.target.value)} />
        </label>
        <button type="submit" className="button">
          Save timers
        </button>
      </form>

      <div className="kds-timer-preview" aria-label="Preview">
        {sample.map((row) => (
          <span key={row.minutes} className={`kot-timer tone-${row.tone}`}>
            <span className="kot-timer-value mono">{String(row.minutes).padStart(2, "0")}:00</span>
            <span className="kot-timer-label">{row.tone === "calm" ? "on time" : row.tone}</span>
          </span>
        ))}
      </div>

      <p className="muted small kds-setup-foot">
        The bell warns about tickets past the late mark, turns critical ten minutes after that,
        and flags food left at the pass for over {settings.passMinutes} minutes (8 unless you change it).
      </p>
    </SectionCard>
  );
}

// SW-A-12: what tickets call a dish. Dishes, sizes and add-ons get their
// kitchen name on the menu screens; this chooses whether the KOT, the board
// and the change slips show it, the menu name, or both. Kept with the
// kitchen's own settings because it changes nothing a guest or a bill sees.
function KitchenNamesCard({ mode, saving, onSave }) {
  const [picked, setPicked] = useState(mode);
  // A worked example of one ticket line, so the choice is seen before saving.
  const example = dishNames("Paneer Tikka", "पनीर टिक्का", picked);
  const plain = dishNames("Jeera Rice", null, picked);

  return (
    <SectionCard
      icon="receipt"
      tone="info"
      title="Names on KOTs"
      description="Give a dish, size or add-on a kitchen name (Hindi, Tamil, Telugu or any script) on the menu screens. Choose here what the KOT, this board and the change slips show. Bills always keep the menu name."
    >
      <form
        className="kds-names"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(picked);
        }}
      >
        <div className="kds-name-modes" role="radiogroup" aria-label="Names on KOTs">
          {NAME_MODES.map((option) => (
            <label key={option.value} className={`kds-name-mode ${picked === option.value ? "is-picked" : ""}`}>
              <input
                type="radio"
                name="kitchen-name-mode"
                value={option.value}
                checked={picked === option.value}
                onChange={() => setPicked(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small className="muted">{option.hint}</small>
              </span>
            </label>
          ))}
        </div>

        <div className="kds-name-preview" aria-label="How a ticket line reads">
          <span className="muted small">Example ticket</span>
          <div className="kds-name-line">
            <span className="kot-qty">2</span>
            <span className="kds-kitchen-name">
              {example.main}
              {example.sub && <span className="kds-menu-name">{example.sub}</span>}
            </span>
          </div>
          <div className="kds-name-line">
            <span className="kot-qty">1</span>
            <span className="kds-kitchen-name">
              {plain.main}
              <span className="kds-menu-name">no kitchen name set: the menu name shows</span>
            </span>
          </div>
        </div>

        <button type="submit" className="button" disabled={saving || picked === mode}>
          Save
        </button>
      </form>
    </SectionCard>
  );
}

function StationModal({ station, onClose, onSave, saving }) {
  const [name, setName] = useState(station ? station.name : "");
  const [color, setColor] = useState(station ? station.color : "blue");
  const [sortOrder, setSortOrder] = useState(station ? String(station.sortOrder) : "10");

  return (
    <Modal
      title={station ? `Edit ${station.name}` : "Add a station"}
      description="A place in the kitchen that cooks its own tickets: the tandoor, the wok, the bar."
      icon="chef"
      onClose={onClose}
      width={480}
    >
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            name,
            color,
            sortOrder: Number(sortOrder) || 0,
            status: station ? station.status : "active",
          });
        }}
      >
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Tandoor, Chinese wok, Bar"
            maxLength={60}
            required
            autoFocus
          />
        </label>

        <fieldset className="field">
          <legend>Colour on the board</legend>
          <div className="kds-swatches" role="radiogroup" aria-label="Colour">
            {STATION_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                role="radio"
                aria-checked={color === swatch}
                aria-label={swatch}
                className={`kds-swatch-pick station-${swatch} ${color === swatch ? "is-picked" : ""}`}
                onClick={() => setColor(swatch)}
              />
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>Display order</span>
          <input
            type="number"
            min="0"
            max="999"
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
          />
          <small className="muted">Lower numbers come first in the station chips.</small>
        </label>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : station ? "Save station" : "Add station"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
