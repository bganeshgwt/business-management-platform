import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { getErrorMessage } from "../../../../services/api";
import * as timeclock from "../services/timeclock.service";
import { PunchCamera, PunchPhoto, PunchPhotoSettings } from "./PunchPhotos";
import ClockPinModal from "./ClockPinModal";
import "../styles/timeclock.css";
import "../../../../styles/staff.css";
import { hoursFromMinutes } from "./hoursText";

// The staff time clock.
//
// One page, three jobs. The first tab is the tablet at the staff entrance:
// tap your name, type your PIN, clock in / take a break / clock out, and walk
// on — the confirmation clears itself after five seconds. Beside it, the
// board a manager glances at: who is in, who is on a break and for how long,
// who is late. The other tabs are for the office: every person's day as a
// timeline (with a way to add the clock-out someone forgot), and PINs.
//
// Every time on this page is shown on the restaurant's clock, from the
// server's time, so a tablet whose own clock has drifted still shows (and
// punches) the right time.

const PIN_MIN = 4;
const PIN_MAX = 6;
const DONE_SECONDS = 5;
const IDLE_SECONDS = 20;
const LONG_BREAK_MINUTES = 45;
const BOARD_REFRESH_MS = 30000;
const HOUR = 3600000;

// --- icons -------------------------------------------------------------------

const ICONS = {
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  login: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  coffee: "M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4ZM6 2v2M10 2v2M14 2v2",
  play: "M7 4.5v15l12-7.5Z",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  alert:
    "M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z",
  hourglass: "M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4",
  check: "M20 6 9 17l-5-5",
  lock: "M5 11h14v10H5ZM8 11V7a4 4 0 0 1 8 0v4",
  key: "M15.5 7.5 19 4M21 2l-2 2 3 3-3.5 3.5-3-3M11.39 11.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78Z",
  backspace: "M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM18 9l-6 6M12 9l6 6",
  expand: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3",
  shrink: "M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  calendar: "M3 5h18v16H3ZM16 3v4M8 3v4M3 10h18",
  timeline: "M3 5h10M7 12h12M5 19h8",
  door: "M3 21h18M6 21V3h10v18M13 12h.01M16 5l4 1v15",
  plus: "M12 5v14M5 12h14",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  moon: "M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35",
};

// The shared icon set's name for the tiles, where the two differ.
const TILE_ICON = { hourglass: "timer" };

function Icon({ name, size = 18 }) {
  return (
    <svg
      className="tc-icon"
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
      <path d={ICONS[name]} />
    </svg>
  );
}

// --- time on the restaurant's clock -----------------------------------------

const formatters = new Map();

const formatter = (timezone, options, locale = "en-IN") => {
  const key = `${locale}|${timezone}|${JSON.stringify(options)}`;

  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat(locale, { timeZone: timezone, ...options }));
  }

  return formatters.get(key);
};

const tidyPeriod = (text) => text.replace(/\s?([ap])\.?m\.?$/i, (_, half) => ` ${half.toLowerCase()}m`);

// "5:58 pm"
const timeLabel = (value, timezone) =>
  value
    ? tidyPeriod(formatter(timezone, { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(value)))
    : "—";

// "9 am"
const hourLabel = (ms, timezone) =>
  tidyPeriod(formatter(timezone, { hour: "numeric", hour12: true }).format(new Date(ms)));

const partsOf = (ms, timezone) => {
  const parts = formatter(
    timezone,
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    },
    "en-CA"
  ).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type).value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
};

const offsetMs = (ms, timezone) => {
  const p = partsOf(ms, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

const localDate = (ms, timezone) => {
  const p = partsOf(ms, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

const localHourMinute = (ms, timezone) => {
  const p = partsOf(ms, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

// "2026-09-24" + "23:30" on the restaurant's clock -> an ISO instant.
const zonedIso = (date, time, timezone) => {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, timezone);
  return new Date(guess - offsetMs(first, timezone)).toISOString();
};

const floorHour = (ms, timezone) => {
  const offset = offsetMs(ms, timezone);
  return Math.floor((ms + offset) / HOUR) * HOUR - offset;
};

const ceilHour = (ms, timezone) => {
  const offset = offsetMs(ms, timezone);
  return Math.ceil((ms + offset) / HOUR) * HOUR - offset;
};

const addDays = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "Thursday, 24 September"
const longDate = (date) => {
  const value = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[value.getUTCDay()]}, ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`;
};

// "Thu 24 Sep"
const shortDate = (date) => {
  const value = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[value.getUTCDay()].slice(0, 3)} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()].slice(0, 3)}`;
};

// "45m", "4h 05m", "25h 55m" (hours stay hours past a day).
const duration = hoursFromMinutes;

const minutesFrom = (from, to) => Math.max(0, Math.round((to - Date.parse(from)) / 60000));

const DEPARTMENTS = {
  kitchen: "Kitchen",
  service: "Service",
  management: "Management",
  delivery: "Delivery",
  housekeeping: "Housekeeping",
  other: "Other",
};

const roleOf = (person) => person.designation || DEPARTMENTS[person.department] || "Staff";

// A long break is one past 45 minutes — or past the shift's own break, where
// the shift allows longer (the same rule as the bell).
const isLongBreak = (person, minutes) =>
  minutes > Math.max(LONG_BREAK_MINUTES, (person.shift && person.shift.breakMinutes) || 0);

function Avatar({ person, size = "md", dot }) {
  return (
    <span
      className={`tc-avatar tc-avatar-${size} tc-dept-${person.department || "other"}`}
      data-dot={dot || undefined}
      aria-hidden="true"
    >
      {person.initials}
    </span>
  );
}

// --- what each board status looks like --------------------------------------

// Colour AND words: a new starter reading "Late · 32 min" needs no legend.
const statusView = (person, now, timezone) => {
  const shift = person.shift;

  switch (person.status) {
    case "on_duty":
      return person.pastEndMinutes && shift
        ? { tone: "warning", label: `In · ${duration(minutesFrom(shift.endsAt, now))} past shift end` }
        : { tone: "success", label: `In since ${timeLabel(person.session.since, timezone)}` };
    case "on_break":
      return {
        tone: isLongBreak(person, minutesFrom(person.session.breakStartedAt, now)) ? "danger" : "warning",
        label: `On break · ${duration(minutesFrom(person.session.breakStartedAt, now))}`,
      };
    case "late":
      return { tone: "danger", label: `Late · ${duration(minutesFrom(shift.startsAt, now))}` };
    case "expected":
      return Date.parse(shift.startsAt) <= now
        ? { tone: "info", label: "Due now" }
        : { tone: "info", label: `Due ${timeLabel(shift.startsAt, timezone)}` };
    case "left":
      return { tone: "neutral", label: `Left ${timeLabel(person.session.checkOut, timezone)}` };
    case "absent":
      return { tone: "danger", label: "Did not come in" };
    case "missed_out":
      return { tone: "danger", label: `No clock-out since ${timeLabel(person.session.since, timezone)}` };
    case "week_off":
      return { tone: "neutral", label: "Week off" };
    case "leave":
      return { tone: "neutral", label: "On leave" };
    default:
      return { tone: "neutral", label: "Not rostered today" };
  }
};

function Chip({ tone = "neutral", children }) {
  return <span className={`tc-chip tc-tone-${tone}`}>{children}</span>;
}

// ============================================================================
// The page
// ============================================================================

export default function TimeClockPage() {
  const { hasPermission } = useAuth();
  const canView = hasPermission("staff.view");
  const canManage = hasPermission("staff.manage");
  const [tab, setTab] = useQueryFilter("tab", "kiosk");

  const tabs = [
    { key: "kiosk", label: "Clock in / out", short: "Clock", icon: "clock" },
    canView ? { key: "day", label: "Day timeline", short: "Timeline", icon: "timeline" } : null,
    canManage ? { key: "pins", label: "Manage PINs", short: "PINs", icon: "key" } : null,
  ].filter(Boolean);

  const active = tabs.some((item) => item.key === tab) ? tab : "kiosk";

  return (
    <div className="stack tc-page">
      <PageHeader
        icon="clock"
        title="Time clock"
        description="Staff clock in and out here with their PIN. Who is on duty, on a break and running late — live."
        action={
          tabs.length > 1 ? (
            <div className="segmented tc-tabs" role="tablist" aria-label="Time clock views">
              {tabs.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={active === item.key}
                  className={`segment ${active === item.key ? "is-active" : ""}`}
                  onClick={() => setTab(item.key)}
                >
                  <Icon name={item.icon} size={15} />
                  <span className="tc-tab-long">{item.label}</span>
                  <span className="tc-tab-short">{item.short}</span>
                </button>
              ))}
            </div>
          ) : null
        }
      />

      {active === "kiosk" && <KioskTab canView={canView} canManage={canManage} />}
      {active === "day" && <DayTab canManage={canManage} />}
      {active === "pins" && <PinsTab />}
    </div>
  );
}

// ============================================================================
// Tab 1 — the tablet at the door, and the board
// ============================================================================

function KioskTab({ canView, canManage }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [fullscreen, setFullscreen] = useState(false);
  // Where the person at the tablet is: picking their name, typing their PIN,
  // choosing an action, or reading the confirmation. Kept here because the
  // whole area changes shape with it.
  const [step, setStep] = useState("pick");
  const areaRef = useRef(null);
  const picking = step === "pick";

  const load = useCallback(
    () =>
      timeclock
        .getBoard()
        .then((data) => {
          setBoard(data);
          setOffset(Date.parse(data.now) - Date.now());
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    load();
    const id = setInterval(load, BOARD_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // The clock ticks every second; everything live on the board (break
  // timers, "late by") is worked out from this one value.
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      areaRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  // Once a name is tapped, the keypad is what matters: bring the top of the
  // kiosk (the slim clock bar, then the keypad) into view, so nobody at the
  // door has to scroll to reach 0 and Enter — on a tablet, in full screen, or
  // after scrolling down a long list of names.
  useEffect(() => {
    const area = areaRef.current;

    if (step === "pick" || !area) {
      return;
    }

    if (document.fullscreenElement === area) {
      area.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      area.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [step]);

  if (!board) {
    return error ? <ErrorMessage message={error} /> : <Loading label="Opening the time clock…" />;
  }

  const now = tick + offset;

  return (
    <div className={`tc-area ${fullscreen ? "is-fullscreen" : ""} ${picking ? "" : "is-focused"}`} ref={areaRef}>
      <ErrorMessage message={error} />
      <Hero board={board} now={now} fullscreen={fullscreen} onFullscreen={toggleFullscreen} compact={!picking} />
      {picking && <Tiles board={board} now={now} />}
      <div className="tc-main">
        <Kiosk board={board} now={now} onPunched={load} step={step} setStep={setStep} />
        <Board board={board} now={now} canView={canView} canManage={canManage} />
      </div>
    </div>
  );
}

// The big clock while people are choosing their name; a slim bar with the
// same live time while someone is at the keypad, so the keypad and the
// buttons sit at the top of the screen on a tablet.
function Hero({ board, now, fullscreen, onFullscreen, compact }) {
  const timezone = board.timezone;
  const p = partsOf(now, timezone);
  const hour12 = p.hour % 12 || 12;
  const period = p.hour < 12 ? "am" : "pm";
  const today = localDate(now, timezone);
  const running = [...new Set(board.staff.filter((row) => ["on_duty", "on_break", "late"].includes(row.status) && row.shift).map((row) => row.shift.name))];
  const next = board.counts.nextStart;
  const clock = (
    <p className="tc-clock" aria-live="off">
      {hour12}:{String(p.minute).padStart(2, "0")}
      <span className="tc-clock-sec">:{String(p.second).padStart(2, "0")}</span>
      <span className="tc-clock-period">{period}</span>
    </p>
  );
  const fullscreenButton = (
    <button type="button" className="tc-hero-button" onClick={onFullscreen}>
      <Icon name={fullscreen ? "shrink" : "expand"} size={16} />
      {fullscreen ? "Leave full screen" : compact ? "Full screen" : "Full screen for the tablet"}
    </button>
  );

  if (compact) {
    return (
      <section className="tc-hero is-compact" aria-label="Current time">
        {clock}
        <p className="tc-hero-date">{longDate(today)}</p>
        <span className="tc-hero-compact-stat">
          <span className="tc-hero-dot is-live" />
          <span>
            <strong>{board.counts.onDuty}</strong> on duty now
          </span>
        </span>
        {fullscreenButton}
      </section>
    );
  }

  return (
    <section className="tc-hero" aria-label="Current time">
      <div className="tc-hero-main">
        <p className="tc-hero-eyebrow">
          <Icon name="door" size={15} /> Staff entrance · time clock
        </p>
        {clock}
        <p className="tc-hero-date">{longDate(today)}</p>
      </div>

      <div className="tc-hero-side">
        <div className="tc-hero-stat">
          <span className="tc-hero-dot is-live" />
          <span>
            <strong>{board.counts.onDuty}</strong> on duty now
            {running.length > 0 && (
              <span className="tc-hero-muted">
                {" "}
                · {running.length > 2 ? `${running.length} shifts running` : `${running.join(" & ")} shift`}
              </span>
            )}
          </span>
        </div>
        <div className="tc-hero-stat">
          <Icon name="hourglass" size={16} />
          <span>
            {next ? (
              <>
                <strong>{board.counts.expected}</strong> still to arrive ·{" "}
                {board.counts.expected === 1 ? "due" : "first due"} {timeLabel(next, timezone)}
              </>
            ) : (
              "Nobody else is due in today"
            )}
          </span>
        </div>
        {fullscreenButton}
      </div>
    </section>
  );
}

function Tiles({ board, now }) {
  const timezone = board.timezone;
  const onBreak = board.staff.filter((row) => row.status === "on_break");
  const late = board.staff.filter((row) => row.status === "late");
  const expected = board.staff.filter((row) => row.status === "expected");
  const longest = onBreak.reduce(
    (worst, row) => {
      const minutes = minutesFrom(row.session.breakStartedAt, now);
      return minutes > worst.minutes ? { minutes, row } : worst;
    },
    { minutes: 0, row: null }
  );
  // The tile names whoever is furthest past their start — the first call to make.
  const worstLate = late.reduce(
    (worst, row) => (!worst || minutesFrom(row.shift.startsAt, now) > minutesFrom(worst.shift.startsAt, now) ? row : worst),
    null
  );
  const onDuty = board.staff.filter((row) => row.status === "on_duty" || row.status === "on_break");
  const kitchen = onDuty.filter((row) => row.department === "kitchen").length;
  const pastEnd = board.counts.pastEnd || 0;

  const tiles = [
    {
      tone: "success",
      icon: "users",
      value: board.counts.onDuty,
      label: "On duty",
      note: !onDuty.length
        ? "Nobody clocked in yet"
        : pastEnd
          ? `${pastEnd} still in after their shift ended`
          : `${kitchen} kitchen · ${onDuty.length - kitchen} floor & other`,
    },
    {
      tone: "warning",
      icon: "coffee",
      value: board.counts.onBreak,
      label: "On a break",
      note: onBreak.length
        ? `Longest ${duration(longest.minutes)}${
            longest.row && isLongBreak(longest.row, longest.minutes) ? ` — ${longest.row.firstName}, over the break` : ""
          }`
        : "Everyone on duty is working",
    },
    {
      tone: "danger",
      icon: "alert",
      value: board.counts.late,
      label: "Late, not in",
      note: worstLate
        ? `${worstLate.firstName} · ${duration(minutesFrom(worstLate.shift.startsAt, now))} past start`
        : "Nobody is late",
    },
    {
      tone: "info",
      icon: "hourglass",
      value: board.counts.expected,
      label: "Still to arrive",
      note: expected.length ? `Next at ${timeLabel(board.counts.nextStart, timezone)}` : "Everyone rostered is here",
    },
    {
      tone: "neutral",
      icon: "logout",
      value: board.counts.left,
      label: "Done for the day",
      note: board.counts.absent
        ? `${board.counts.absent} did not come in`
        : `${board.counts.off} off or on leave today`,
    },
  ];

  return <TileRow tiles={tiles} />;
}

// A row of figures, drawn with the shared StatTile. A figure that is zero
// keeps its tile but drops its colour, so the eye goes to what needs doing.
function TileRow({ tiles, className = "" }) {
  return (
    <div className={`stat-grid tc-stat-grid ${className}`.trim()}>
      {tiles.map((tile) => (
        <StatTile
          key={tile.label}
          size="sm"
          icon={TILE_ICON[tile.icon] || tile.icon}
          tone={tile.value === 0 ? "neutral" : tile.tone}
          label={tile.label}
          value={tile.value}
          of={tile.of === undefined ? undefined : `/${tile.of}`}
          note={tile.note}
        />
      ))}
    </div>
  );
}

// --- the kiosk flow: pick -> PIN -> action -> done --------------------------

const ON_TODAY = new Set(["late", "missed_out", "on_break", "on_duty", "expected", "left", "absent"]);

const ACTION_VIEW = {
  clock_in: { label: "Clock in", icon: "login", tone: "in" },
  break_start: { label: "Start break", icon: "coffee", tone: "break" },
  break_end: { label: "End break", icon: "play", tone: "in" },
  clock_out: { label: "Clock out", icon: "logout", tone: "out" },
};

// The keypad here is the kiosk's own rather than components/PinPad: at a door
// tablet nothing has focus, so digits are caught on the window, the pad shakes
// on a wrong PIN, shows the optional 5th and 6th digits, and sends itself at
// six — none of which the till's PinPad (a focused input inside a dialog) does.
function Kiosk({ board, now, onPunched, step, setStep }) {
  const timezone = board.timezone;
  const [scope, setScope] = useState("today");
  const [search, setSearch] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [personId, setPersonId] = useState(null);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [verified, setVerified] = useState(null);
  const [result, setResult] = useState(null);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const pinRef = useRef("");
  const busyRef = useRef(false);
  // With punch photos on: takes the camera's frame at the punch.
  const cameraRef = useRef(null);

  // The person as the latest board sees them, so their chip stays live.
  const person = board.staff.find((row) => row.id === personId) || null;

  const reset = useCallback(() => {
    pinRef.current = "";
    setStep("pick");
    setPersonId(null);
    setPin("");
    setPinError(null);
    setVerified(null);
    setResult(null);
    setActionError("");
    setSearch("");
    setLookupError("");
  }, [setStep]);

  const pick = (row) => {
    pinRef.current = "";
    setPersonId(row.id);
    setPin("");
    setPinError(null);
    setLookupError("");
    setStep("pin");
  };

  const submitPin = useCallback(
    async (value) => {
      if (value.length < PIN_MIN || busyRef.current || !personId) {
        return;
      }

      busyRef.current = true;
      setBusy(true);
      setPinError(null);

      const refuse = (message, locked) => {
        pinRef.current = "";
        setPin("");
        setPinError({ message, locked });
        setShakeKey((key) => key + 1);
      };

      try {
        const data = await timeclock.verifyPin({ employeeId: personId, pin: value });

        if (data.valid) {
          setVerified(data);
          setActionError("");
          setStep("action");
        } else {
          refuse(data.message, data.locked);
        }
      } catch (err) {
        refuse(getErrorMessage(err), err.response?.status === 423);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [personId, setStep]
  );

  const press = useCallback(
    (digit) => {
      if (busyRef.current || pinRef.current.length >= PIN_MAX) {
        return;
      }

      const next = pinRef.current + digit;
      pinRef.current = next;
      setPin(next);
      setPinError(null);

      // Six digits is the longest a PIN can be, so there is nothing to wait for.
      if (next.length === PIN_MAX) {
        submitPin(next);
      }
    },
    [submitPin]
  );

  const back = useCallback(() => {
    pinRef.current = pinRef.current.slice(0, -1);
    setPin(pinRef.current);
  }, []);

  const clear = () => {
    pinRef.current = "";
    setPin("");
  };

  const doPunch = async (action) => {
    if (busyRef.current) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setActionError("");

    try {
      // No camera (or none allowed): the punch goes without, marked "no photo".
      const photo = board.punchPhotos && cameraRef.current ? cameraRef.current() : null;
      const data = await timeclock.punch({ employeeId: personId, pin: pinRef.current, action, ...(photo ? { photo } : {}) });
      pinRef.current = "";
      setPin("");
      setResult(data);
      setStep("done");
      onPunched();
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Typing works as well as tapping: digits, Backspace, Enter, Escape.
  useEffect(() => {
    if (step === "pick") {
      return undefined;
    }

    const onKey = (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (step === "pin") {
        if (/^\d$/.test(event.key)) {
          event.preventDefault();
          press(event.key);
        } else if (event.key === "Backspace") {
          event.preventDefault();
          back();
        } else if (event.key === "Enter") {
          event.preventDefault();
          submitPin(pinRef.current);
        } else if (event.key === "Escape") {
          reset();
        }
      } else if (event.key === "Escape" || (step === "done" && event.key === "Enter")) {
        reset();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, press, back, submitPin, reset]);

  // Nobody leaves the tablet unlocked behind them: the buttons close after
  // 20 seconds, the confirmation after five.
  useEffect(() => {
    if (step !== "action" && step !== "done" && step !== "pin") {
      return undefined;
    }

    const seconds = step === "done" ? DONE_SECONDS : step === "pin" ? IDLE_SECONDS * 2 : IDLE_SECONDS;
    const id = setTimeout(reset, seconds * 1000);
    return () => clearTimeout(id);
  }, [step, reset, pin, actionError]);

  const people = useMemo(() => {
    const term = search.trim().toLowerCase();

    return board.staff
      .filter((row) => scope === "all" || ON_TODAY.has(row.status))
      .filter(
        (row) =>
          !term ||
          row.name.toLowerCase().includes(term) ||
          String(row.employeeCode || "").toLowerCase().includes(term)
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [board.staff, scope, search]);

  const rosteredCount = board.staff.filter((row) => ON_TODAY.has(row.status)).length;

  const findByCode = (event) => {
    event.preventDefault();
    const term = search.trim().toLowerCase();

    if (!term) {
      return;
    }

    const byCode = board.staff.find((row) => String(row.employeeCode || "").toLowerCase() === term);
    const byName = board.staff.filter((row) => row.name.toLowerCase().includes(term));
    const match = byCode || (byName.length === 1 ? byName[0] : null);

    if (match) {
      pick(match);
    } else {
      setLookupError(
        byName.length > 1
          ? `${byName.length} people match "${search.trim()}". Tap your name below.`
          : `No one on the staff list has the code "${search.trim()}". Check it, or tap your name.`
      );
    }
  };

  // ---- step: done
  if (step === "done" && result) {
    const note = result.confirmation;
    const icon = { clock_in: "login", break_start: "coffee", break_end: "play", clock_out: "moon" }[result.punch.action];

    return (
      <section className={`card tc-kiosk tc-done tc-tone-${note.tone}`} role="status" aria-live="polite">
        <span className="tc-done-mark">
          <Icon name={note.tone === "warning" && result.punch.action === "clock_in" ? "alert" : icon} size={40} />
        </span>
        <h2 className="tc-done-headline">{note.headline}</h2>
        <p className="tc-done-line">
          {note.line} · <strong>{note.detail}</strong>
        </p>
        {note.chips.length > 0 && (
          <ul className="tc-done-chips">
            {note.chips.map((chip) => (
              <li key={chip}>{chip}</li>
            ))}
          </ul>
        )}
        <div className="tc-countdown" aria-hidden="true">
          <span key={result.punch.id} style={{ animationDuration: `${DONE_SECONDS}s` }} />
        </div>
        <button type="button" className="button button-secondary" onClick={reset}>
          Done — next person
        </button>
      </section>
    );
  }

  // ---- step: action
  if (step === "action" && verified && person) {
    const view = verified;
    const opens = view.clockInOpensAt;
    const stateLine = view.blocked
      ? "A clock-out is missing"
      : view.state === "in"
        ? `On duty since ${timeLabel(view.since, timezone)}`
        : view.state === "break"
          ? `On a break since ${timeLabel(view.breakStartedAt, timezone)}`
          : view.shift
            ? `Your shift: ${view.shift.label}`
            : "You are not on today's roster";

    const sub = (action) => {
      if (action === "clock_in") {
        if (opens) {
          return `Opens at ${timeLabel(opens, timezone)} — an hour before your shift`;
        }

        if (view.lateNow) {
          return `Started ${timeLabel(view.shift.startsAt, timezone)} · counts as ${duration(view.lateNow.minutes)} late`;
        }

        return view.shift
          ? `${view.shift.name} shift from ${timeLabel(view.shift.startsAt, timezone)}`
          : "Not rostered — your manager will see it";
      }

      if (action === "break_start") {
        return view.shift && view.shift.breakMinutes
          ? `Your shift has a ${view.shift.breakMinutes} min break`
          : "Time off the clock";
      }

      if (action === "break_end") {
        return `On break ${duration(minutesFrom(view.breakStartedAt, now))} so far`;
      }

      return view.state === "break"
        ? "Ends your break as well"
        : view.shift
          ? `Shift ends ${timeLabel(view.shift.endsAt, timezone)}`
          : "Finish for the day";
    };

    return (
      <section className="card tc-kiosk tc-kiosk-action">
        <div className="tc-action-head">
          <Avatar person={person} size="lg" />
          <div>
            <p className="tc-hello">Hi {person.firstName}</p>
            <p className="muted">{stateLine}</p>
          </div>
          {board.punchPhotos && <PunchCamera captureRef={cameraRef} />}
        </div>

        {view.blocked && (
          <div className="tc-callout tc-tone-danger" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <strong>You cannot clock in yet.</strong> {view.blocked}
            </span>
          </div>
        )}

        {view.missedClockOut && (
          <div className="alert alert-notice tc-missed">
            <Icon name="alert" size={16} /> {view.missedClockOut.message}
          </div>
        )}

        {view.lateNow && (
          <div className="tc-callout tc-tone-warning">
            <Icon name="hourglass" size={18} />
            <span>
              <strong>Running late — {duration(view.lateNow.minutes)}.</strong> {view.lateNow.message}
            </span>
          </div>
        )}

        {view.state !== "out" && (
          <dl className="tc-session">
            <div>
              <dt>Clocked in</dt>
              <dd>{timeLabel(view.checkIn, timezone)}</dd>
            </div>
            <div>
              <dt>Worked today</dt>
              <dd>{duration(view.workedMinutes)}</dd>
            </div>
            <div>
              <dt>{view.state === "break" ? "Off the clock" : "Breaks"}</dt>
              <dd>{duration(view.breakMinutes)}</dd>
            </div>
          </dl>
        )}

        <ErrorMessage message={actionError} />

        {view.actions.length > 0 && (
          <div className="tc-actions">
            {view.actions.map((action) => (
              <button
                key={action}
                type="button"
                className={`tc-action tc-action-${ACTION_VIEW[action].tone}`}
                onClick={() => doPunch(action)}
                disabled={busy || (action === "clock_in" && Boolean(opens))}
              >
                <span className="tc-action-icon">
                  <Icon name={ACTION_VIEW[action].icon} size={26} />
                </span>
                <span>
                  <span className="tc-action-label">{busy ? "Saving…" : ACTION_VIEW[action].label}</span>
                  <span className="tc-action-sub">{sub(action)}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="tc-my-day">
          <p className="tc-board-title tc-tone-neutral">Your punches {view.workDate && view.workDate !== localDate(now, timezone) ? `for ${shortDate(view.workDate)}` : "today"}</p>
          {view.punches && view.punches.length > 0 ? (
            <ol className="tc-my-punches">
              {view.punches.map((item) => (
                <li key={`${item.action}-${item.at}`}>
                  <span className={`tc-feed-dot tc-feed-${item.action}`} />
                  <span className="tc-punch-time">{timeLabel(item.at, timezone)}</span>
                  <span className="muted">{PUNCH_LABELS[item.action]}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">Nothing yet today — this will be your first punch.</p>
          )}
        </div>

        <div className="tc-action-foot">
          <button type="button" className="link-button" onClick={reset}>
            {view.blocked ? "Back to names" : "Cancel — not now"}
          </button>
          <span className="muted small">This closes by itself in {IDLE_SECONDS} seconds</span>
        </div>
      </section>
    );
  }

  // ---- step: PIN
  if (step === "pin" && person) {
    const chip = statusView(person, now, timezone);

    return (
      <section className="card tc-kiosk tc-kiosk-pin">
        <button type="button" className="tc-back" onClick={reset}>
          <Icon name="chevronLeft" size={16} /> Not you? Back to names
        </button>

        <div className="tc-pin-layout">
          <div className="tc-who">
            <Avatar person={person} size="xl" />
            <h2>{person.name}</h2>
            <p className="muted">
              {roleOf(person)}
              {person.employeeCode ? ` · ${person.employeeCode}` : ""}
            </p>
            <Chip tone={chip.tone}>{chip.label}</Chip>
            {person.shift && (
              <p className="small muted tc-who-shift">
                {person.shift.name} · {timeLabel(person.shift.startsAt, timezone)} – {timeLabel(person.shift.endsAt, timezone)}
              </p>
            )}
          </div>

          {!person.hasPin ? (
            <div className="tc-pin-entry tc-no-pin">
              <span className="tc-no-pin-mark">
                <Icon name="lock" size={30} />
              </span>
              <h3>No PIN yet</h3>
              <p className="muted">
                {person.firstName} cannot clock in until a manager sets a PIN under <strong>Manage PINs</strong>.
                Until then, ask the manager on duty to note your time.
              </p>
              <button type="button" className="button button-secondary" onClick={reset}>
                Back to names
              </button>
            </div>
          ) : (
            <div className="tc-pin-entry">
              <p className="tc-pin-prompt">Enter your PIN</p>
              <div
                key={shakeKey}
                className={`tc-dots ${pinError ? "is-wrong" : ""}`}
                role="img"
                aria-label={`${pin.length} of ${PIN_MAX} digits entered`}
              >
                {Array.from({ length: PIN_MAX }, (_, index) => (
                  <span
                    key={index}
                    className={`tc-dot ${index < pin.length ? "is-filled" : ""} ${index >= PIN_MIN ? "is-optional" : ""}`}
                  />
                ))}
              </div>
              <p className={`tc-pin-message ${pinError ? "is-error" : ""}`} role={pinError ? "alert" : undefined}>
                {pinError ? pinError.message : "4 to 6 digits · the keyboard works too"}
              </p>

              <div className="tc-keypad">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                  <button key={digit} type="button" className="tc-key" onClick={() => press(digit)} disabled={busy}>
                    {digit}
                  </button>
                ))}
                <button type="button" className="tc-key tc-key-muted" onClick={clear} disabled={busy || !pin}>
                  Clear
                </button>
                <button type="button" className="tc-key" onClick={() => press("0")} disabled={busy}>
                  0
                </button>
                <button
                  type="button"
                  className="tc-key tc-key-muted"
                  onClick={back}
                  disabled={busy || !pin}
                  aria-label="Delete last digit"
                >
                  <Icon name="backspace" size={22} />
                </button>
              </div>

              <button
                type="button"
                className="button tc-enter"
                onClick={() => submitPin(pinRef.current)}
                disabled={busy || pin.length < PIN_MIN || (pinError && pinError.locked)}
              >
                {busy ? "Checking…" : "Enter"}
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  // ---- step: pick
  return (
    <section className="card tc-kiosk">
      <div className="tc-kiosk-head">
        <div>
          <h2>Who's clocking?</h2>
          <p className="muted small">Tap your name, then type your PIN. Or search, or type your employee code.</p>
        </div>
        <div className="segmented" role="group" aria-label="Whose names to show">
          <button
            type="button"
            className={`segment ${scope === "today" ? "is-active" : ""}`}
            onClick={() => setScope("today")}
          >
            On today · {rosteredCount}
          </button>
          <button
            type="button"
            className={`segment ${scope === "all" ? "is-active" : ""}`}
            onClick={() => setScope("all")}
          >
            Everyone · {board.staff.length}
          </button>
        </div>
      </div>

      <form className="tc-search" onSubmit={findByCode}>
        <span className="tc-search-icon">
          <Icon name="search" size={17} />
        </span>
        <input
          type="text"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLookupError("");
          }}
          placeholder="Name or employee code"
          aria-label="Search by name or employee code"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="button button-secondary">
          Go
        </button>
      </form>
      {lookupError && <p className="tc-inline-error">{lookupError}</p>}

      {people.length === 0 ? (
        <EmptyState
          message={search ? "Nobody matches that." : "Nobody is rostered today."}
          hint={
            search
              ? "Check the spelling, or type the employee code from your ID card."
              : "Anyone can still clock in: switch to Everyone to find your name."
          }
          action={
            scope === "today" ? (
              <button type="button" className="button button-secondary" onClick={() => setScope("all")}>
                Show everyone
              </button>
            ) : null
          }
        />
      ) : (
        <div className="tc-people">
          {people.map((row) => {
            const chip = statusView(row, now, timezone);

            return (
              <button key={row.id} type="button" className="tc-person" onClick={() => pick(row)}>
                <Avatar person={row} dot={chip.tone} />
                <span className="tc-person-name">{row.name}</span>
                <span className="tc-person-role">{roleOf(row)}</span>
                <Chip tone={chip.tone}>{chip.label}</Chip>
                {!row.hasPin && (
                  <span className="tc-person-flag">
                    <Icon name="lock" size={12} /> No PIN
                  </span>
                )}
                {row.pinLockedUntil && (
                  <span className="tc-person-flag is-danger">
                    <Icon name="lock" size={12} /> Locked
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// --- the on-duty board ---------------------------------------------------------

function BoardRow({ person, tone, timer, timerNote, detail, action }) {
  return (
    <li className={`tc-board-row tc-tone-${tone}`}>
      <Avatar person={person} size="sm" />
      <span className="tc-board-body">
        <span className="tc-board-name">{person.name}</span>
        <span className="tc-board-detail">{detail}</span>
      </span>
      <span className="tc-board-timer">
        {timer}
        {timerNote && <small>{timerNote}</small>}
        {action}
      </span>
    </li>
  );
}

function Board({ board, now, canView, canManage }) {
  const timezone = board.timezone;
  const boardAt = Date.parse(board.now);
  const group = (status) => board.staff.filter((row) => row.status === status);
  const shiftText = (row) =>
    row.shift ? `${row.shift.name} ${timeLabel(row.shift.startsAt, timezone)} – ${timeLabel(row.shift.endsAt, timezone)}` : "Not rostered";

  // Furthest past their start first: that is the first call to make.
  const late = group("late").sort((a, b) => a.shift.startsAt.localeCompare(b.shift.startsAt));
  const onBreak = group("on_break");
  const overrun = group("on_duty").filter((row) => row.pastEndMinutes && row.shift);
  const onDuty = group("on_duty").filter((row) => !(row.pastEndMinutes && row.shift));
  const expected = group("expected").sort((a, b) => a.shift.startsAt.localeCompare(b.shift.startsAt));
  const left = group("left");
  const absent = group("absent");
  const off = board.staff.filter((row) => ["week_off", "leave"].includes(row.status));

  const sections = [
    {
      key: "late",
      title: "Late — not in yet",
      tone: "danger",
      rows: late.map((row) => {
        const minutes = minutesFrom(row.shift.startsAt, now);

        return (
          <BoardRow
            key={row.id}
            person={row}
            tone="danger"
            detail={minutes >= 120 ? `${shiftText(row)} · likely not coming — call them` : shiftText(row)}
            timer={`+${duration(minutes)}`}
            timerNote="past start"
          />
        );
      }),
    },
    {
      key: "break",
      title: "On a break",
      tone: "warning",
      rows: onBreak.map((row) => {
        const minutes = minutesFrom(row.session.breakStartedAt, now);

        const long = isLongBreak(row, minutes);

        return (
          <BoardRow
            key={row.id}
            person={row}
            tone={long ? "danger" : "warning"}
            detail={`Since ${timeLabel(row.session.breakStartedAt, timezone)} · in since ${timeLabel(row.session.since, timezone)}${
              row.shift && row.shift.breakMinutes ? ` · ${row.shift.breakMinutes} min allowed` : ""
            }`}
            timer={duration(minutes)}
            timerNote={long ? "long break" : "on break"}
          />
        );
      }),
    },
    {
      // Still on the clock a quarter of an hour or more after their shift
      // ended: staying on (overtime a manager should agree to) or gone home
      // without clocking out. Either way, worth a look now.
      key: "overrun",
      title: "Past their shift end",
      tone: "warning",
      rows: overrun.map((row) => {
        const over = minutesFrom(row.shift.endsAt, now);

        return (
          <BoardRow
            key={row.id}
            person={row}
            tone="warning"
            detail={`${row.shift.name} ended ${timeLabel(row.shift.endsAt, timezone)} · in since ${timeLabel(
              row.session.since,
              timezone
            )} — staying on, or forgot to clock out?`}
            timer={`+${duration(over)}`}
            timerNote="past end"
          />
        );
      }),
    },
    {
      key: "duty",
      title: "On duty",
      tone: "success",
      rows: onDuty.map((row) => {
        const worked = row.session.workedMinutes + Math.max(0, Math.round((now - boardAt) / 60000));
        const lateNote = row.session.lateMinutes > 0 ? ` · came ${duration(row.session.lateMinutes)} late` : "";

        return (
          <BoardRow
            key={row.id}
            person={row}
            tone="success"
            detail={`In ${timeLabel(row.session.since, timezone)}${row.shift ? ` · ends ${timeLabel(row.shift.endsAt, timezone)}` : " · not rostered"}${lateNote}`}
            timer={duration(worked)}
            timerNote="worked"
          />
        );
      }),
    },
    {
      key: "expected",
      title: "Still to arrive",
      tone: "info",
      rows: expected.map((row) => {
        const until = Math.round((Date.parse(row.shift.startsAt) - now) / 60000);

        return (
          <BoardRow
            key={row.id}
            person={row}
            tone="info"
            detail={shiftText(row)}
            timer={until > 0 ? `in ${duration(until)}` : "due now"}
          />
        );
      }),
    },
    {
      key: "left",
      title: "Done for the day",
      tone: "neutral",
      rows: left.map((row) => (
        <BoardRow
          key={row.id}
          person={row}
          tone="neutral"
          detail={`${timeLabel(row.session.checkIn, timezone)} – ${timeLabel(row.session.checkOut, timezone)}${
            row.session.overtimeMinutes ? ` · ${duration(row.session.overtimeMinutes)} overtime` : ""
          }`}
          timer={duration(row.session.workedMinutes)}
          timerNote="worked"
        />
      )),
    },
    {
      key: "absent",
      title: "Did not come in",
      tone: "danger",
      rows: absent.map((row) => (
        <BoardRow key={row.id} person={row} tone="danger" detail={`${shiftText(row)} · no clock-in`} timer="—" />
      )),
    },
  ].filter((section) => section.rows.length > 0);

  return (
    <SectionCard
      className="tc-board"
      icon="users"
      tone="success"
      title="Who's on duty"
      description="Live · updates as people clock in"
      aria-label="Who is on duty"
      actions={
        <span className="live-badge small">
          <span className="live-dot is-busy" /> {timeLabel(now, timezone)}
        </span>
      }
    >

      {board.missedClockOuts.length > 0 && (
        <div className="tc-missing">
          <p className="tc-missing-title">
            <Icon name="alert" size={15} /> Forgot to clock out
          </p>
          <ul>
            {board.missedClockOuts.map((row) => (
              <li key={row.attendanceId}>
                <span>
                  <strong>{row.employeeName}</strong> · in {shortDate(row.workDate)} at {timeLabel(row.since || row.checkIn, timezone)}, never out
                </span>
                {canView && (
                  <Link to={`/staff/timeclock?tab=day&date=${row.workDate}`} className="tc-missing-link">
                    {canManage ? "Fix" : "View"}
                    <Icon name="chevronRight" size={13} />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sections.length === 0 ? (
        <EmptyState
          message="Nobody is rostered or clocked in today."
          hint="Add today's shifts under Shifts & roster, and people will appear here as they arrive."
        />
      ) : (
        sections.map((section) => (
          <div key={section.key} className={`tc-board-section tc-tone-${section.tone}`}>
            <p className="tc-board-title">
              {section.title} <span className="tc-board-count">{section.rows.length}</span>
            </p>
            <ul className="tc-board-list">{section.rows}</ul>
          </div>
        ))
      )}

      {off.length > 0 && (
        <p className="tc-board-off small muted">
          Off today: {off.map((row) => `${row.firstName}${row.status === "leave" ? " (leave)" : ""}`).join(", ")}
        </p>
      )}

      {board.recent.length > 0 && (
        <div className="tc-feed">
          <p className="tc-board-title tc-tone-neutral">Latest punches</p>
          <ol>
            {board.recent.slice(0, 6).map((row) => (
              <li key={row.id}>
                <span className="tc-feed-time">{timeLabel(row.at, timezone)}</span>
                <span className={`tc-feed-dot tc-feed-${row.action}`} />
                <span>
                  <strong>{row.employeeName}</strong> {PUNCH_WORDS[row.action]}
                  {row.source === "manager" && <span className="muted"> · added by a manager</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </SectionCard>
  );
}

const PUNCH_WORDS = {
  clock_in: "clocked in",
  break_start: "started a break",
  break_end: "ended a break",
  clock_out: "clocked out",
};

const PUNCH_LABELS = {
  clock_in: "Clock in",
  break_start: "Break start",
  break_end: "Break end",
  clock_out: "Clock out",
};

// ============================================================================
// Tab 2 — the day as a timeline
// ============================================================================

const DAY_STATUS = {
  on_duty: { tone: "success", label: "On duty" },
  on_break: { tone: "warning", label: "On a break" },
  present: { tone: "success", label: "Present" },
  no_clock_out: { tone: "danger", label: "No clock-out" },
  absent: { tone: "danger", label: "Absent" },
  late: { tone: "danger", label: "Late, not in" },
  expected: { tone: "info", label: "Expected" },
  week_off: { tone: "neutral", label: "Week off" },
  leave: { tone: "neutral", label: "Leave" },
  half_day: { tone: "warning", label: "Half day" },
};

const DAY_ORDER = ["no_clock_out", "on_duty", "on_break", "present", "half_day", "late", "expected", "absent", "leave", "week_off"];

function DayTab({ canManage }) {
  const [requested, setRequested] = useQueryFilter("date", "");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [open, setOpen] = useState(null);
  const [fixing, setFixing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [corrections, setCorrections] = useState(null);
  const [tick, setTick] = useState(() => Date.now());

  const load = useCallback(
    () =>
      timeclock
        .getDay(requested || undefined)
        .then((day) => {
          // When it arrived, by this device's clock, so the gap to the
          // server's clock can be allowed for.
          setData({ ...day, receivedAt: Date.now() });
          setError("");
          return timeclock.listPunches({ from: addDays(day.date, -6), to: day.date, source: "manager", limit: 50 });
        })
        .then((list) => setCorrections(list))
        .catch((err) => setError(getErrorMessage(err))),
    [requested]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Today's timeline keeps moving: open stretches grow and the "now" line
  // walks across.
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!data || data.date !== data.today) {
      return undefined;
    }

    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, [data, load]);

  const timezone = data?.timezone || "Asia/Kolkata";
  const serverOffset = data ? Date.parse(data.now) - data.receivedAt : 0;
  const now = tick + serverOffset;

  const rows = useMemo(() => {
    if (!data) {
      return [];
    }

    return [...data.rows].sort((a, b) => {
      const byStatus = DAY_ORDER.indexOf(a.status) - DAY_ORDER.indexOf(b.status);

      if (byStatus !== 0) {
        return byStatus;
      }

      const aStart = a.segments[0]?.from || a.shift?.startsAt || "";
      const bStart = b.segments[0]?.from || b.shift?.startsAt || "";
      return aStart.localeCompare(bStart) || a.name.localeCompare(b.name);
    });
  }, [data]);

  const axis = useMemo(() => {
    if (!data) {
      return null;
    }

    const times = [];

    for (const row of data.rows) {
      if (row.shift) {
        times.push(Date.parse(row.shift.startsAt), Date.parse(row.shift.endsAt));
      }

      for (const segment of row.segments) {
        times.push(Date.parse(segment.from), Date.parse(segment.to));
      }
    }

    if (times.length === 0) {
      const start = Date.parse(zonedIso(data.date, "08:00", data.timezone));
      return { from: start, to: start + 16 * HOUR };
    }

    const from = floorHour(Math.min(...times), data.timezone);
    let to = ceilHour(Math.max(...times), data.timezone);

    if (to - from < 8 * HOUR) {
      to = from + 8 * HOUR;
    }

    return { from, to };
  }, [data]);

  if (!data) {
    return error ? <ErrorMessage message={error} /> : <Loading label="Loading the day…" />;
  }

  const isToday = data.date === data.today;
  const totals = data.totals;
  const span = axis.to - axis.from;
  const hours = Math.round(span / HOUR);
  const step = hours <= 12 ? 1 : hours <= 20 ? 2 : 3;
  const ticks = [];

  for (let at = axis.from; at <= axis.to; at += step * HOUR) {
    ticks.push(at);
  }

  const pct = (ms) => `${Math.min(100, Math.max(0, ((ms - axis.from) / span) * 100))}%`;
  const widthPct = (from, to) => `${Math.max(0.4, ((Math.min(to, axis.to) - Math.max(from, axis.from)) / span) * 100)}%`;
  const missing = rows.filter((row) => row.status === "no_clock_out");

  const dayTiles = [
    {
      tone: "success",
      icon: "users",
      value: totals.present,
      of: totals.rostered,
      label: "Came in",
      note: totals.off ? `of those rostered · ${totals.off} off today` : "of those rostered",
    },
    {
      tone: "warning",
      icon: "hourglass",
      value: totals.late,
      label: "Late arrivals",
      note: totals.late ? `${duration(totals.lateMinutes)} late in all, after grace` : "Everyone on time",
    },
    {
      tone: "danger",
      icon: "alert",
      value: totals.absent,
      label: "Did not come",
      note: totals.missingClockOut ? `${totals.missingClockOut} missing a clock-out` : "No missing clock-outs",
    },
    {
      tone: "info",
      icon: "clock",
      value: duration(totals.workedMinutes),
      label: "Hours worked",
      note: `${duration(totals.breakMinutes)} on breaks`,
    },
    {
      tone: "neutral",
      icon: "moon",
      value: duration(totals.overtimeMinutes),
      label: "Overtime",
      note: `${data.overtimeFromMinutes ?? 15} min or more past a shift's end`,
    },
  ];

  return (
    <div className="stack">
      <div className="card tc-day-bar">
        <div className="tc-day-nav">
          <button
            type="button"
            className="icon-button tc-nav-button"
            onClick={() => setRequested(addDays(data.date, -1))}
            aria-label="Previous day"
          >
            <Icon name="chevronLeft" />
          </button>
          <div className="tc-day-title">
            <span className="tc-day-eyebrow">{isToday ? "Today" : data.date < data.today ? "Past day" : "Upcoming"}</span>
            <strong>{longDate(data.date)}</strong>
          </div>
          <button
            type="button"
            className="icon-button tc-nav-button"
            onClick={() => setRequested(addDays(data.date, 1))}
            aria-label="Next day"
            disabled={data.date >= data.today}
          >
            <Icon name="chevronRight" />
          </button>
          <input
            type="date"
            className="tc-date-input"
            value={data.date}
            max={data.today}
            onChange={(event) => event.target.value && setRequested(event.target.value)}
            aria-label="Pick a day"
          />
          {!isToday && (
            <button type="button" className="button button-secondary" onClick={() => setRequested("")}>
              Today
            </button>
          )}
        </div>
        <ul className="tc-legend" aria-label="Legend">
          <li>
            <span className="tc-swatch tc-seg-work" /> Working
          </li>
          <li>
            <span className="tc-swatch tc-seg-break" /> Break
          </li>
          <li>
            <span className="tc-swatch tc-seg-gap" /> Off between stints
          </li>
          <li>
            <span className="tc-swatch tc-seg-work tc-swatch-open" /> Still on the clock
          </li>
          <li>
            <span className="tc-swatch tc-swatch-shift" /> Rostered shift
          </li>
        </ul>
      </div>

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <TileRow tiles={dayTiles} />

      {missing.length > 0 && (
        <div className="alert tc-missing-alert" role="alert">
          <Icon name="alert" size={16} />
          <span>
            <strong>
              {missing.length === 1 ? `${missing[0].name} never clocked out` : `${missing.length} people never clocked out`}
            </strong>{" "}
            — their hours for the day are not counted until the clock-out is added.
            {canManage ? " Open the row and add it." : " A manager needs to add it."}
          </span>
        </div>
      )}

      <SectionCard
        className="tc-timeline"
        bodyClassName="tc-timeline-body"
        icon="activity"
        title="Everyone's day"
        description={`Each bar is built from the punches on the tablet. Tap a name to see the punches${
          canManage ? " or add a missed one" : ""
        }.`}
      >

        {rows.length === 0 ? (
          <EmptyState
            message="Nobody was rostered or clocked in on this day."
            hint="Rostered staff and anyone who punched in show up here."
          />
        ) : (
          <div className="tc-tl" style={{ "--hours": hours }}>
            <div className="tc-tl-axis" aria-hidden="true">
              <span />
              <span className="tc-tl-ticks">
                {ticks.map((at, index) => (
                  <span key={at} className={`tc-tl-tick ${index % 2 ? "is-minor" : ""}`} style={{ left: pct(at) }}>
                    {hourLabel(at, timezone)}
                  </span>
                ))}
              </span>
              <span />
            </div>

            {rows.map((row) => {
              const status = DAY_STATUS[row.status] || DAY_STATUS.expected;
              const record = row.attendance;
              const expanded = open === row.id;
              const worked = record && record.checkOut ? record.workedMinutes : row.live ? row.live.workedMinutes : 0;

              return (
                <div key={row.id} className={`tc-tl-row ${expanded ? "is-open" : ""}`}>
                  <button
                    type="button"
                    className="tc-tl-who"
                    onClick={() => setOpen(expanded ? null : row.id)}
                    aria-expanded={expanded}
                  >
                    <Avatar person={row} size="sm" />
                    <span className="tc-tl-name">
                      <strong>{row.name}</strong>
                      <span className="small muted">
                        {row.shift
                          ? `${row.shift.name} ${timeLabel(row.shift.startsAt, timezone)}–${timeLabel(row.shift.endsAt, timezone)}`
                          : row.rosterStatus
                            ? DAY_STATUS[row.rosterStatus]?.label || row.rosterStatus
                            : "Not rostered"}
                      </span>
                    </span>
                  </button>

                  <div
                    className={`tc-tl-track ${!row.shift && row.segments.length === 0 ? "is-empty" : ""}`}
                    title={row.shift ? `Rostered ${timeLabel(row.shift.startsAt, timezone)} – ${timeLabel(row.shift.endsAt, timezone)}` : undefined}
                  >
                    {row.shift && (
                      <span
                        className="tc-tl-shift"
                        style={{
                          left: pct(Date.parse(row.shift.startsAt)),
                          width: widthPct(Date.parse(row.shift.startsAt), Date.parse(row.shift.endsAt)),
                        }}
                      />
                    )}
                    {row.segments.map((segment) => {
                      const to = segment.open ? Math.max(Date.parse(segment.to), now) : Date.parse(segment.to);

                      return (
                        <span
                          key={`${segment.kind}-${segment.from}`}
                          className={`tc-tl-seg tc-seg-${segment.kind} ${segment.open ? "is-open" : ""}`}
                          style={{ left: pct(Date.parse(segment.from)), width: widthPct(Date.parse(segment.from), to) }}
                          title={`${segment.kind === "work" ? "Working" : segment.kind === "break" ? "Break" : "Off the clock"} ${timeLabel(
                            segment.from,
                            timezone
                          )} – ${segment.open ? "now" : timeLabel(segment.to, timezone)}`}
                        />
                      );
                    })}
                    {isToday && now > axis.from && now < axis.to && (
                      <span className="tc-tl-now" style={{ left: pct(now) }} />
                    )}
                    {row.segments.length === 0 && (
                      <span className="tc-tl-empty">
                        {row.status === "absent"
                          ? "No clock-in"
                          : row.status === "late"
                            ? "Not in yet"
                            : row.status === "expected"
                              ? "Not started"
                              : record && record.checkIn
                                ? "Entered on the attendance sheet"
                                : ""}
                      </span>
                    )}
                  </div>

                  <div className="tc-tl-stats">
                    <Chip tone={status.tone}>{status.label}</Chip>
                    <span className="tc-tl-figures">
                      {record && record.checkIn ? (
                        <>
                          <span>
                            {timeLabel(record.checkIn, timezone)} – {record.checkOut ? timeLabel(record.checkOut, timezone) : "…"}
                          </span>
                          {row.status === "no_clock_out" ? (
                            <span className="muted">not counted</span>
                          ) : (
                            <strong>{duration(worked)}</strong>
                          )}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </span>
                    {record && (record.lateMinutes > 0 || record.overtimeMinutes > 0) && (
                      <span className="tc-tl-flags">
                        {record.lateMinutes > 0 && (
                          <span className="tc-flag tc-tone-warning">{duration(record.lateMinutes)} late</span>
                        )}
                        {record.overtimeMinutes > 0 && (
                          <span className="tc-flag tc-tone-info">+{duration(record.overtimeMinutes)} OT</span>
                        )}
                      </span>
                    )}
                  </div>

                  {expanded && (
                    <div className="tc-tl-detail">
                      {row.punches.length === 0 ? (
                        <p className="muted small">No punches on the tablet for this day.</p>
                      ) : (
                        <ol className="tc-punches">
                          {row.punches.map((item) => (
                            <li key={item.id}>
                              <span className={`tc-feed-dot tc-feed-${item.action}`} />
                              <span className="tc-punch-time">{timeLabel(item.at, timezone)}</span>
                              <span className="tc-punch-what">{PUNCH_LABELS[item.action]}</span>
                              <PunchPhoto punchId={item.id} status={item.photoStatus} hasPhoto={item.hasPhoto} />
                              <span className="small muted">
                                {item.source === "manager" ? `Added by ${item.recordedBy || "a manager"}` : "Tablet"}
                                {item.note ? ` · “${item.note}”` : ""}
                                {canManage && item.source === "manager" && (
                                  <>
                                    {" · "}
                                    <button
                                      type="button"
                                      className="link-button danger tc-remove-punch"
                                      onClick={() =>
                                        setRemoving({ ...item, workDate: data.date, employeeName: row.name })
                                      }
                                    >
                                      Remove
                                    </button>
                                  </>
                                )}
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                      {record && (
                        <p className="small muted tc-tl-sum">
                          {row.status === "no_clock_out"
                            ? "No hours are counted for this day until the missing clock-out is added."
                            : `Worked ${duration(worked)} · breaks ${duration(record.breakMinutes)} · late ${
                                record.lateMinutes
                              } min (after grace) · overtime ${duration(record.overtimeMinutes)}`}
                        </p>
                      )}
                      {canManage && (
                        <button type="button" className="button button-secondary tc-fix" onClick={() => setFixing(row)}>
                          <Icon name="plus" size={16} /> Add a missed punch
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard
        icon="edit"
        tone="warning"
        title="Punches added by hand"
        description={`The week to ${shortDate(
          data.date
        )}. Every change to someone's hours, with who made it and why. A punch taken back is kept in the activity log with the reason.`}
        flush
      >
        {!corrections || corrections.items.length === 0 ? (
          <p className="muted small tc-clean">
            <Icon name="check" size={15} /> No punches were added by hand this week — every hour came from the tablet.
          </p>
        ) : (
          <DataGrid
            id="timeclock-corrections"
            caption="Punches added by hand"
            variant="compact"
            columns={[
              {
                key: "when",
                header: "When",
                type: "date",
                value: (item) => item.workDate,
                mobile: "subtitle",
                csv: (item) => `${item.workDate} ${timeLabel(item.at, timezone)}`,
                render: (item) => (
                  <span className="nowrap">
                    {shortDate(item.workDate)} · {timeLabel(item.at, timezone)}
                  </span>
                ),
              },
              { key: "employee", header: "Employee", value: (item) => item.employeeName, mobile: "title" },
              { key: "punch", header: "Punch", value: (item) => PUNCH_LABELS[item.action] || item.action, mobile: "show" },
              { key: "reason", header: "Reason", value: (item) => item.note || "", mobile: "show", className: "staff-log-cell" },
              { key: "addedBy", header: "Added by", value: (item) => item.recordedBy || "", mobile: "show" },
              canManage && {
                key: "actions",
                header: "",
                label: "Actions",
                type: "actions",
                render: (item) => (
                  <button type="button" className="link-button danger" onClick={() => setRemoving(item)}>
                    Remove
                  </button>
                ),
              },
            ]}
            rows={corrections.items}
            rowKey={(item) => item.id}
            pageSize={10}
          />
        )}
      </SectionCard>

      {removing && (
        <RemovePunchModal
          punch={removing}
          timezone={timezone}
          onClose={() => setRemoving(null)}
          onSaved={(message) => {
            setRemoving(null);
            setSuccess(message);
            load();
          }}
        />
      )}

      {fixing && (
        <AddPunchModal
          row={fixing}
          date={data.date}
          timezone={timezone}
          onClose={() => setFixing(null)}
          onSaved={(message) => {
            setFixing(null);
            setSuccess(message);
            load();
          }}
        />
      )}
    </div>
  );
}

const REASONS = ["Forgot to clock out", "Forgot to clock in", "Tablet was not working", "Came in early — manager asked"];

function AddPunchModal({ row, date, timezone, onClose, onSaved }) {
  const state = row.live ? row.live.state : "out";
  const suggested = state === "in" ? "clock_out" : state === "break" ? "break_end" : "clock_in";
  // A sensible first guess: the rostered start for a missed clock-in, the
  // rostered end for a missed clock-out — but never a time still to come.
  const guess =
    suggested === "clock_in" && row.shift ? row.shift.startsAt : row.shift && suggested === "clock_out" ? row.shift.endsAt : null;
  // Worked out once, when the form opens (lazy state), not on every render.
  const [initialAt] = useState(() => (guess ? Math.min(Date.parse(guess), Date.now()) : null));

  const [action, setAction] = useState(suggested);
  const [time, setTime] = useState(initialAt ? localHourMinute(initialAt, timezone) : "");
  const [nextDay, setNextDay] = useState(initialAt ? localDate(initialAt, timezone) !== date : false);
  const [note, setNote] = useState(suggested === "clock_out" ? REASONS[0] : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();

    if (!time) {
      setError("Enter the time it happened");
      return;
    }

    if (!note.trim()) {
      setError("Say why — this punch will be on their record");
      return;
    }

    setSaving(true);
    setError("");

    try {
      await timeclock.addPunch({
        employeeId: row.id,
        workDate: date,
        action,
        at: zonedIso(nextDay ? addDays(date, 1) : date, time, timezone),
        note: note.trim(),
      });
      onSaved(`${PUNCH_LABELS[action]} at ${time} added for ${row.name}. Their day has been worked out again.`);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Add a missed punch — ${row.name}`}
      description="Goes on their record as added by you, with the reason."
      icon="plus"
      onClose={onClose}
      width={520}
    >
      <form className="stack tc-fix-form" onSubmit={submit}>
        <p className="muted small">
          For {longDate(date)}. It goes on the record as added by you, with the reason, and the day's hours are worked
          out again from all the punches.
        </p>
        <ErrorMessage message={error} />
        <div className="form-grid">
          <label className="field">
            Punch
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              {Object.entries(PUNCH_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Time
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
          </label>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={nextDay} onChange={(event) => setNextDay(event.target.checked)} />
          After midnight — on {shortDate(addDays(date, 1))} (a shift that ran late)
        </label>
        <label className="field">
          Reason
          <input
            type="text"
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. Forgot to clock out, left at 11:30 pm per the closing manager"
          />
        </label>
        <div className="tc-reason-chips">
          {REASONS.map((reason) => (
            <button key={reason} type="button" className="chip-button" onClick={() => setNote(reason)}>
              {reason}
            </button>
          ))}
        </div>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : "Add punch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const REMOVE_REASONS = ["Typed the wrong time", "Added to the wrong person", "Added to the wrong day", "Added twice"];

// Takes back a punch a manager added by mistake. Only hand-added punches have
// this: what the tablet recorded stays, and is corrected by adding a punch.
function RemovePunchModal({ punch, timezone, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();

    if (!reason.trim()) {
      setError("Say why it is being removed — this goes in the activity log");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const result = await timeclock.removePunch(punch.id, reason.trim());
      onSaved(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Remove a punch — ${punch.employeeName}`}
      description="Only punches a manager added can be taken back."
      icon="trash"
      onClose={onClose}
      width={500}
    >
      <form className="stack tc-fix-form" onSubmit={submit}>
        <div className="tc-remove-card">
          <span className={`tc-feed-dot tc-feed-${punch.action}`} />
          <span>
            <strong>
              {PUNCH_LABELS[punch.action]} at {timeLabel(punch.at, timezone)}
            </strong>{" "}
            <span className="muted">on {shortDate(punch.workDate)}</span>
            <span className="small muted tc-remove-note">
              Added by {punch.recordedBy || "a manager"}
              {punch.note ? ` — “${punch.note}”` : ""}
            </span>
          </span>
        </div>
        <p className="muted small">
          The day is worked out again from the punches left. The removed punch and your reason stay in the activity
          log.
        </p>
        <ErrorMessage message={error} />
        <label className="field">
          Why remove it
          <input
            type="text"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. Typed 11:30 am instead of 11:30 pm"
            autoFocus
          />
        </label>
        <div className="tc-reason-chips">
          {REMOVE_REASONS.map((item) => (
            <button key={item} type="button" className="chip-button" onClick={() => setReason(item)}>
              {item}
            </button>
          ))}
        </div>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep it
          </button>
          <button type="submit" className="button button-danger" disabled={saving}>
            {saving ? "Removing…" : "Remove punch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ============================================================================
// Tab 3 — PINs
// ============================================================================

function PinsTab() {
  const [rows, setRows] = useState(null);
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      timeclock
        .listPins()
        .then((data) => {
          setRows(data.items);
          setTimezone(data.timezone);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  const unlock = async (row) => {
    setError("");

    try {
      const result = await timeclock.unlockPin(row.id);
      setSuccess(result.message);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");

    try {
      const result = await timeclock.removePin(removing.id);
      setSuccess(result.message);
      setRemoving(null);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  };

  if (!rows) {
    return error ? <ErrorMessage message={error} /> : <Loading label="Loading PINs…" />;
  }

  const withPin = rows.filter((row) => row.hasPin).length;
  const locked = rows.filter((row) => row.lockedUntil).length;
  const term = search.trim().toLowerCase();
  const shown = rows
    .filter((row) => filter === "all" || (filter === "none" ? !row.hasPin : Boolean(row.lockedUntil)))
    .filter(
      (row) =>
        !term || row.name.toLowerCase().includes(term) || String(row.employeeCode || "").toLowerCase().includes(term)
    );

  const tiles = [
    { tone: "success", icon: "check", value: withPin, label: "Have a PIN", note: `of ${rows.length} active staff` },
    {
      tone: "warning",
      icon: "lock",
      value: rows.length - withPin,
      label: "No PIN yet",
      note: rows.length - withPin ? "They cannot use the tablet" : "Everyone can clock in",
    },
    {
      tone: "danger",
      icon: "alert",
      value: locked,
      label: "Locked now",
      note: locked ? "5 wrong PINs in 15 minutes" : "No lockouts",
    },
  ];

  return (
    <div className="stack">
      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <TileRow tiles={tiles} className="tc-stat-grid-3" />

      <SectionCard
        className="tc-pins"
        icon="key"
        title="Staff PINs"
        description="Each person clocks in with their own 4–6 digit PIN. PINs are stored scrambled — nobody, you included, can read one back. Forgotten? Set a new one."
        flush
      >
        <div className="tc-pins-head">
          <div className="tc-pins-filters">
            <div className="segmented" role="group" aria-label="Filter">
              {[
                ["all", `All · ${rows.length}`],
                ["none", `No PIN · ${rows.length - withPin}`],
                ["locked", `Locked · ${locked}`],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`segment ${filter === key ? "is-active" : ""}`}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="tc-pins-find">
              <span className="tc-search-icon">
                <Icon name="search" size={16} />
              </span>
              <input
                type="search"
                className="tc-pins-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Find a person"
                aria-label="Find a person"
              />
            </span>
          </div>
        </div>

        {shown.length === 0 ? (
          <EmptyState
            message={filter === "none" ? "Everyone has a PIN." : filter === "locked" ? "Nobody is locked out." : "Nobody matches that."}
            hint={filter === "all" ? "Try another name or code." : "Nothing to do here."}
          />
        ) : (
          <ul className="tc-pin-list">
            {shown.map((row) => (
              <li key={row.id} className="tc-pin-row">
                <span className="tc-pin-person">
                  <Avatar person={row} size="sm" />
                  <span>
                    <strong>{row.name}</strong>
                    <span className="small muted">
                      {roleOf(row)}
                      {row.employeeCode ? ` · ${row.employeeCode}` : ""}
                    </span>
                  </span>
                </span>
                <span className="tc-pin-state">
                  {row.lockedUntil ? (
                    <Chip tone="danger">Locked until {timeLabel(row.lockedUntil, timezone)}</Chip>
                  ) : row.hasPin ? (
                    <Chip tone="success">PIN set</Chip>
                  ) : (
                    <Chip tone="warning">No PIN</Chip>
                  )}
                  <span className="small muted">
                    {row.pinSetAt
                      ? `Set ${shortDate(localDate(Date.parse(row.pinSetAt), timezone))}`
                      : "Cannot clock in yet"}
                    {row.recentFailures > 0 && !row.lockedUntil ? ` · ${row.recentFailures} wrong just now` : ""}
                  </span>
                </span>
                <span className="tc-pin-actions">
                  <button
                    type="button"
                    className={`button button-sm ${row.hasPin ? "button-secondary" : ""} tc-pin-button`}
                    onClick={() => setEditing(row)}
                  >
                    <Icon name={row.hasPin ? "edit" : "key"} size={15} />
                    <span>
                      {row.hasPin ? "Reset" : "Set"}
                      <span className="tc-tab-long"> PIN</span>
                    </span>
                  </button>
                  {(row.hasPin || row.lockedUntil) && (
                    <ActionMenu
                      label={`More for ${row.name}`}
                      items={[
                        ...(row.lockedUntil
                          ? [{ label: "Unlock now", icon: "unlock", onClick: () => unlock(row) }]
                          : []),
                        ...(row.hasPin
                          ? [{ label: "Remove PIN", icon: "trash", danger: true, onClick: () => setRemoving(row) }]
                          : []),
                      ]}
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <PunchPhotoSettings />

      {editing && (
        <ClockPinModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setSuccess(message);
            load();
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title="Remove this PIN?"
          message={`${removing.name} will not be able to clock in until a new PIN is set. Use this when someone leaves, or if a PIN may have been seen.`}
          confirmLabel="Remove PIN"
          busy={busy}
          onConfirm={remove}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
