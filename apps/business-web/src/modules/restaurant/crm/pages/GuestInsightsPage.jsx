import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { ColumnChart } from "../../../../components/Charts";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import CustomerHistoryModal from "./CustomerHistoryModal";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { getErrorMessage } from "../../../../services/api";
import { downloadCsv } from "../../../../services/csv";
import { elapsed } from "@bmp/shared/dates";
import { count, money } from "@bmp/shared/format";
import { formatMobile } from "../../../../services/phone";
import {
  exportGuestSegment,
  findGuest,
  getGuestInsights,
  getGuestSegment,
} from "../services/guestInsight.service";
import {
  copyButtonLabel,
  exportButtonLabel,
  exportedWhat,
  exportScope,
  guestListFilename,
  guestListSheet,
  inHouseHistory,
  lapsedEmpty,
  plural,
  shortDate,
} from "../services/guestInsightText";
import "../styles/guest-insights.css";

// Guest insights: who comes back, who stopped, who to thank.
//
// Built for the manager with ten minutes before service: the headline numbers
// first, then who you know is in the room right now, then the lists that turn
// into phone calls and WhatsApp messages — regulars, new faces worth a second
// visit, regulars who have gone quiet, birthdays, the unhappy, and guests
// sitting on points. Every list says in one line how it is decided, and every
// guest opens onto their full history.
//
// Nothing here is typed in. It is all worked out from bills, so it refreshes
// itself and cannot drift from the takings.

const REFRESH_MS = 60000;
const PAGE_SIZE = 25;

// How each list looks. The rules and the words that explain them come from
// the server, so a list and its definition can never disagree. The icons are
// the app's shared set, so a list reads the same here as anywhere else.
const SEGMENT_LOOK = {
  regulars: { icon: "heart", tag: "Regular" },
  new: { icon: "user-plus", tag: "New" },
  lapsed: { icon: "timer", tag: "Lapsed", shortcut: "At risk" },
  "big-spenders": { icon: "trend-up", tag: "Big spender" },
  birthdays: { icon: "calendar", tag: "Birthday" },
  // A couple's wedding anniversary this week (sweep SW-B-21).
  anniversaries: { icon: "sparkles", tag: "Anniversary" },
  unhappy: { icon: "frown", tag: "Unhappy", shortcut: "Unhappy" },
  points: { icon: "gift", tag: "Points" },
};

const SEGMENT_KEYS = Object.keys(SEGMENT_LOOK);
const PRIMARY_SEGMENTS = ["regulars", "new", "lapsed", "unhappy"];

// The colour of each list's tag wherever a guest carries it. The list cards
// get theirs from the server, which uses the same names.
const TONES = {
  regulars: "success",
  new: "info",
  lapsed: "warning",
  "big-spenders": "primary",
  birthdays: "pink",
  anniversaries: "pink",
  unhappy: "danger",
  points: "teal",
};

const toneOf = (key) => TONES[key] || "neutral";

// --- small formatting helpers -------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const weekday = (iso) => {
  const [year, month, day] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
};

const daysAgoLabel = (days) => {
  if (days === null || days === undefined) {
    return "Never";
  }

  if (days <= 0) {
    return "Today";
  }

  return days === 1 ? "Yesterday" : `${days} days ago`;
};

const percent = (value) =>
  `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(Number(value || 0))}%`;

const decimal = (value) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(Number(value || 0));

const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

// The same guest is the same colour everywhere on the page.
const avatarTone = (id) => `gi-avatar-${Number(id) % 6}`;

const birthdayTag = (birthday) => {
  if (!birthday) {
    return "Birthday";
  }

  if (birthday.inDays === 0) {
    return "Birthday today";
  }

  return birthday.inDays === 1 ? "Birthday tomorrow" : `Birthday ${weekday(birthday.date)}`;
};

const anniversaryTag = (anniversary) => {
  if (!anniversary) {
    return "Anniversary";
  }

  if (anniversary.inDays === 0) {
    return "Anniversary today";
  }

  return anniversary.inDays === 1 ? "Anniversary tomorrow" : `Anniversary ${weekday(anniversary.date)}`;
};

const timeLabel = (date) =>
  date
    .toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s?([ap])\.?m\.?$/i, (_, half) => ` ${half.toLowerCase()}m`);

// Copying needs a secure page (https or localhost) and a browser willing to
// allow it. Where the modern way is refused, the old way is tried; if that is
// refused too the caller shows the numbers for the person to copy by hand.
const copyText = async (text) => {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (no focus, a locked-down browser): try the old way below.
    }
  }

  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.appendChild(box);
  box.select();

  let copied = false;

  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  document.body.removeChild(box);
  return copied;
};

// --- pieces -------------------------------------------------------------------

// The windows overlap by design — a regular is 3+ visits in 60 days, lapsed
// is nothing in 45 — so a regular can have gone quiet. Their tag says for how
// long ("Regular · Away 49 days"), which reads as the warning it is rather
// than as "Regular · Lapsed", which reads as a contradiction.
const tagText = (key, guest) => {
  if (key === "birthdays") {
    return birthdayTag(guest.birthday);
  }

  if (key === "anniversaries") {
    return anniversaryTag(guest.anniversary);
  }

  if (key === "lapsed" && guest.daysSinceLastVisit !== null && guest.daysSinceLastVisit !== undefined) {
    return `Away ${guest.daysSinceLastVisit} days`;
  }

  return SEGMENT_LOOK[key].tag;
};

function Tags({ guest, except }) {
  const shown = (guest.tags || []).filter((key) => key !== except && SEGMENT_LOOK[key]);

  if (shown.length === 0) {
    return null;
  }

  return (
    <span className="gi-tags">
      {shown.map((key) => (
        <span key={key} className={`gi-tag gi-tone-${toneOf(key)}`}>
          <Icon name={SEGMENT_LOOK[key].icon} size={12} />
          {tagText(key, guest)}
        </span>
      ))}
    </span>
  );
}

// Whole rupees for an average: ₹2,319 reads at a glance, ₹2,319.12 makes the
// eye do work for paise nobody will act on.
const roundedMoney = (value, currency) => money(Math.round(Number(value || 0)), currency);

function GuestButton({ guest, onOpen, children }) {
  return (
    <button type="button" className="gi-guest" onClick={() => onOpen(guest)}>
      <span className={`gi-avatar ${avatarTone(guest.id)}`} aria-hidden="true">
        {initials(guest.name)}
      </span>
      <span className="gi-guest-text">
        <span className="gi-guest-name">{guest.name}</span>
        {children}
      </span>
    </button>
  );
}

// Guests we know who are at a table now: the host's cue to go and say hello.
function InHouse({ seated, currency, onOpen, now }) {
  if (seated.length === 0) {
    return null;
  }

  return (
    <SectionCard
      icon={<span className="gi-live-dot" aria-hidden="true" />}
      tone="success"
      title={`In the house now · ${seated.length}`}
      description="Guests you know, at a table right now. A hello by name from the manager is the cheapest thing a restaurant can give."
      className="gi-inhouse"
      aria-label="In the house now"
    >
      <ul className="gi-inhouse-list">
        {seated.map((entry) => {
          const history = inHouseHistory(entry.guest);

          return (
            <li key={entry.orderId} className="gi-inhouse-card">
              <GuestButton guest={entry.guest} onOpen={onOpen}>
                <span className="gi-guest-sub">
                  <span className="gi-table-chip">
                    <Icon name="utensils" size={12} />
                    {entry.tableNo}
                  </span>
                  <span className="gi-seated-for">
                    <Icon name="clock" size={12} />
                    {elapsed(entry.seatedAt, now)}
                  </span>
                  {entry.guestCount ? <span>{plural(entry.guestCount, "guest", "guests")}</span> : null}
                  {entry.stage === "billed" && (
                    <span className="gi-stage" title="The bill is on the table — the moment for a goodbye">
                      Bill on the table
                    </span>
                  )}
                </span>
              </GuestButton>
              <Tags guest={entry.guest} />
              <p className="gi-inhouse-facts small">
                {history.visits}
                {history.showSpend ? ` · ${money(entry.guest.lifetimeSpend, currency)} lifetime` : null}
                {history.showFavourite && entry.favourite ? (
                  <>
                    {" "}
                    · usually has <strong>{entry.favourite}</strong>
                  </>
                ) : null}
              </p>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

// How much of the guest book can actually be reached. A campaign list is only
// as good as the numbers on it, and each gap is something the till can fix.
function Coverage({ totals, onFile }) {
  const rows = [
    {
      key: "mobile",
      label: "Mobile number",
      have: onFile - totals.withoutMobile,
      note: "for WhatsApp and SMS",
    },
    {
      key: "birthday",
      label: "Date of birth",
      have: onFile - totals.withoutBirthday,
      note: "for birthday wishes",
    },
    { key: "email", label: "Email", have: onFile - totals.withoutEmail, note: "for newsletters" },
  ];

  return (
    <div className="gi-coverage">
      <h3>What you can reach them by</h3>
      <ul>
        {rows.map((row) => {
          const share = onFile ? (row.have / onFile) * 100 : 0;

          return (
            <li key={row.key}>
              <span className="gi-coverage-label">
                {row.label}
                <span className="muted small"> · {row.note}</span>
              </span>
              <span className="gi-coverage-track" aria-hidden="true">
                <span className="gi-coverage-fill" style={{ width: `${Math.max(share, 1)}%` }} />
              </span>
              <span className="gi-coverage-value">
                <strong>{percent(share)}</strong>
                <span className="muted small">
                  {" "}
                  {count(row.have)} of {count(onFile)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// How many times guests have been: the one chart that says whether the
// restaurant keeps the people it wins.
function Frequency({ distribution, visitors, neverVisited, totals, onFile }) {
  const onceShare = visitors ? (distribution[0].count / visitors) * 100 : 0;
  const loyalShare = visitors
    ? ((distribution[2].count + distribution[3].count) / visitors) * 100
    : 0;

  return (
    <SectionCard
      icon="chart"
      tone="info"
      title="How often guests come back"
      description="Every guest who has visited, by their number of visits"
      className="gi-chart-card"
      bodyClassName="gi-chart-body"
    >
      {visitors === 0 ? (
        <EmptyState
          icon="users"
          message="No visits linked to a guest yet."
          hint="Attach the guest at the till (search their mobile on the POS) and their visits start counting here."
        />
      ) : (
        <>
          <div className="gi-frequency-values">
            {distribution.map((bucket) => (
              <div key={bucket.key} className="gi-frequency-value">
                <strong>{count(bucket.count)}</strong>
                <span className="muted small">
                  {percent(visitors ? (bucket.count / visitors) * 100 : 0)}
                </span>
              </div>
            ))}
          </div>
          <div className="gi-frequency-plot">
            <ColumnChart
              points={distribution.map((bucket) => ({ label: bucket.label, value: bucket.count }))}
              currency=""
              height={160}
            />
          </div>
          <p className="gi-insight small">
            <Icon name="zap" size={15} className="gi-icon" />
            {onceShare >= 40 ? (
              <span>
                <strong>{percent(onceShare)}</strong> of guests have come only once. The second visit is
                where a regular is made — thank new guests while the meal is fresh.
              </span>
            ) : (
              <span>
                <strong>{percent(loyalShare)}</strong> of guests have been four times or more, and only{" "}
                {percent(onceShare)} have come just once.
              </span>
            )}
          </p>
          {neverVisited > 0 && (
            <p className="muted small">
              {plural(neverVisited, "more guest is", "more guests are")} on file without a visit yet —
              signed up, not yet back to eat.
            </p>
          )}
        </>
      )}

      {onFile > 0 && <Coverage totals={totals} onFile={onFile} />}
    </SectionCard>
  );
}

// The ten guests who have spent the most, ever. One series, so no legend: the
// bars are all the same colour and the title says what they measure.
//
// The number is the guest's rank from the server — the same one the Big
// spenders list quotes as "#3 of 141" — so two guests level on spend are both
// 3rd here too, and the next one is 5th.
function TopGuests({ guests, currency, onOpen }) {
  const max = Math.max(...guests.map((guest) => guest.lifetimeSpend), 1);
  const sharing = (rank) => guests.filter((guest) => guest.spendRank === rank).length > 1;

  return (
    <SectionCard
      icon="star"
      tone="primary"
      title="Top 10 guests by lifetime spend"
      description="Bill totals across every visit, void bills left out. Click a name for their history."
      className="gi-chart-card"
      bodyClassName="gi-chart-body"
    >
      {guests.length === 0 ? (
        <EmptyState
          icon="receipt"
          message="No guest has a paid bill yet."
          hint="Attach the guest at the till and their bills count here once paid."
        />
      ) : (
        <ol className="gi-rank">
          {guests.map((guest) => (
            <li key={guest.id} className={guest.spendRank <= 3 ? "is-podium" : ""}>
              <span
                className="gi-rank-no"
                title={sharing(guest.spendRank) ? `Level on spend: shares rank ${guest.spendRank}` : undefined}
              >
                {guest.spendRank}
              </span>
              <button type="button" className="gi-rank-name" onClick={() => onOpen(guest)}>
                <span className="gi-rank-label" title={guest.name}>
                  {guest.name}
                </span>
                <span className="muted small">
                  {count(guest.visits)} {guest.visits === 1 ? "visit" : "visits"} ·{" "}
                  {roundedMoney(guest.averageSpend, currency)} a visit
                </span>
              </button>
              <span className="gi-rank-track" aria-hidden="true">
                <span
                  className="gi-rank-fill"
                  style={{ width: `${Math.max((guest.lifetimeSpend / max) * 100, 2)}%` }}
                />
              </span>
              <span className="gi-rank-value">{money(guest.lifetimeSpend, currency)}</span>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

function SegmentCard({ segment, active, onPick }) {
  const look = SEGMENT_LOOK[segment.key];

  return (
    <button
      type="button"
      className={`gi-seg gi-tone-${segment.tone} ${active ? "is-active" : ""}`}
      onClick={() => onPick(segment.key)}
      aria-pressed={active}
      aria-controls="gi-active-list"
      title={segment.definition}
    >
      <span className="gi-seg-top">
        <span className="gi-seg-icon">
          <Icon name={look.icon} size={18} />
        </span>
        <span className="gi-seg-label">{look.shortcut || segment.label}</span>
      </span>
      <span className="gi-seg-count">{count(segment.count)}</span>
    </button>
  );
}

// What to say when a list is empty depends on why it is empty: the grid's
// empty state (message, hint, icon and any button) for this list.
function segmentEmpty({ segment, summary, searching }) {
  if (searching) {
    return { icon: "search", message: "Nobody on this list matches that name or mobile.", hint: "Search looks at names and mobile numbers on this list only." };
  }

  const { rules, history, totals, loyalty } = summary;
  const icon = SEGMENT_LOOK[segment.key] ? SEGMENT_LOOK[segment.key].icon : "users";

  if (segment.key === "lapsed") {
    const empty = lapsedEmpty({ history, rules, today: summary.today });
    return { icon, message: empty.message, hint: empty.hint };
  }

  if (segment.key === "birthdays") {
    return {
      icon,
      message: "No birthdays in the next seven days.",
      hint:
        totals.withoutBirthday > 0
          ? `${plural(totals.withoutBirthday, "guest has", "guests have")} no date of birth on file. Ask for it at the till — it is the easiest reason to invite someone back.`
          : "Every guest has a date of birth on file, so this list will fill as the dates come round.",
    };
  }

  if (segment.key === "anniversaries") {
    return {
      icon,
      message: "No wedding anniversaries in the next seven days.",
      hint: "Add the date on a guest's card in the guest book (or bring it in with the guest import) — a couple's anniversary is a table for two waiting to be booked.",
    };
  }

  if (segment.key === "points" && !loyalty.enabled) {
    return {
      icon,
      message: "Loyalty points are switched off.",
      hint: "Guests earn points on every paid bill once loyalty is on.",
      action: (
        <Link className="button button-secondary" to="/restaurant/settings">
          <Icon name="settings" size={16} /> Open restaurant settings
        </Link>
      ),
    };
  }

  if (segment.key === "unhappy") {
    return {
      icon: "smile",
      message: `No poor ratings or complaints from known guests in ${rules.unhappyWindowDays} days.`,
      hint: "Ratings and complaints are matched to a guest by the link on them or by their mobile number.",
    };
  }

  return { icon, message: "Nobody is on this list right now.", hint: "Lists refresh themselves every minute as bills are paid." };
}

// The guests on the chosen list. The rows come from the server (search and
// "Show all" ask it again); the grid sorts and pages what it was given.
// windowDays: the restaurant's "regular" window (its rules), which a row's
// recent-visit count is counted over.
function SegmentRows({ segment, items, loading, error, onRetry, empty, currency, today, loyalty, onOpen, contactsHidden, windowDays = 60 }) {
  return (
    <DataGrid
      id="crm-guest-segment"
      caption={`Guests on the list: ${segment.label}`}
      columns={[
        {
          key: "guest",
          header: "Guest",
          value: (guest) => guest.name,
          mobile: "title",
          render: (guest) => (
            <GuestButton guest={guest} onOpen={onOpen}>
              <Tags guest={guest} except={segment.key} />
            </GuestButton>
          ),
        },
        {
          key: "mobile",
          header: "Mobile",
          value: (guest) => (guest.contactHidden || contactsHidden ? guest.mobileMasked : guest.mobile),
          sortable: false,
          mobile: "subtitle",
          render: (guest) => (
            <span className="mono nowrap">
              {guest.contactHidden || contactsHidden ? (
                guest.mobileMasked ? (
                  <span>{guest.mobileMasked}</span>
                ) : (
                  <span className="muted">No mobile</span>
                )
              ) : guest.mobile ? (
                <a className="gi-phone" href={`tel:${guest.mobile}`}>
                  {formatMobile(guest.mobile) || guest.mobile}
                </a>
              ) : (
                <span className="muted">No mobile</span>
              )}
            </span>
          ),
        },
        {
          key: "visits",
          header: "Visits",
          type: "number",
          value: (guest) => guest.visits,
          mobile: "show",
          render: (guest) => (
            <>
              <span className="gi-num">{count(guest.visits)}</span>
              <span className="gi-sub">{count(guest.visits60)} in {windowDays} days</span>
            </>
          ),
        },
        {
          key: "lastVisit",
          header: "Last visit",
          type: "date",
          value: (guest) => guest.lastVisitDate,
          mobile: "show",
          render: (guest) => (
            <span className="nowrap">
              <span>{daysAgoLabel(guest.daysSinceLastVisit)}</span>
              {guest.lastVisitDate && <span className="gi-sub">{shortDate(guest.lastVisitDate, today)}</span>}
            </span>
          ),
        },
        {
          key: "spend",
          header: "Lifetime spend",
          type: "money",
          value: (guest) => guest.lifetimeSpend,
          mobile: "show",
          render: (guest) => (
            <span className="nowrap">
              <span className="gi-num">{money(guest.lifetimeSpend, currency)}</span>
              {guest.billedVisits > 0 && <span className="gi-sub">{roundedMoney(guest.averageSpend, currency)} a visit</span>}
            </span>
          ),
        },
        {
          key: "points",
          header: "Points",
          type: "number",
          value: (guest) => guest.points,
          render: (guest) => (
            <span className="nowrap">
              <span className="gi-num">{count(guest.points)}</span>
              {loyalty.enabled && guest.points > 0 && (
                <span className="gi-sub">worth {money(guest.points * loyalty.pointValue, currency)}</span>
              )}
            </span>
          ),
        },
        {
          key: "why",
          header: "Why they are on this list",
          label: "Why",
          value: (guest) => guest.reason,
          mobile: "show",
          minWidth: 200,
          render: (guest) => <span className="gi-reason">{guest.reason}</span>,
        },
      ]}
      rows={items}
      rowKey={(guest) => guest.id}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={empty.message}
      emptyHint={empty.hint}
      emptyIcon={empty.icon}
      emptyAction={empty.action}
      currency={currency}
      rowNoun={["guest", "guests"]}
      // The list's own search (above) asks the server; Export and Copy are
      // the server's, on the activity log.
      search={false}
    />
  );
}

// --- the page ------------------------------------------------------------------

export default function GuestInsightsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("customers.manage");
  const canExport = hasPermission("customers.export");
  const canSeeContacts = hasPermission("customers.contact");

  const [rawSegment, setSegment] = useQueryFilter("segment", "regulars");
  const segmentKey = SEGMENT_KEYS.includes(rawSegment) ? rawSegment : "regulars";
  const [guestParam, setGuestParam] = useQueryFilter("guest", "");

  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [list, setList] = useState(null);
  const [listError, setListError] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [fetchedName, setFetchedName] = useState(null);
  const [linkNotice, setLinkNotice] = useState("");
  const [manualCopy, setManualCopy] = useState(null);

  const loadSummary = useCallback(
    () =>
      getGuestInsights()
        .then((data) => {
          setSummary(data);
          setError("");
          setUpdatedAt(new Date());
          setNow(Date.now());
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setRefreshing(false)),
    []
  );

  const loadList = useCallback(
    () =>
      getGuestSegment(segmentKey, { search: query || undefined, limit })
        .then((data) => {
          // Which search these rows answer, so Export and Copy can say (and
          // take) exactly what is on screen.
          setList({ ...data, search: query });
          setListError("");
        })
        .catch((err) => setListError(getErrorMessage(err))),
    [segmentKey, query, limit]
  );

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // The lists move as bills are paid, so the page keeps itself current rather
  // than showing a regular as "not in" an hour after they sat down.
  useEffect(() => {
    const timer = setInterval(() => {
      loadSummary();
      loadList();
    }, REFRESH_MS);

    return () => clearInterval(timer);
  }, [loadSummary, loadList]);

  // Typing in the search waits for a pause, so each keystroke is not a request.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const pickSegment = (key) => {
    if (key === segmentKey) {
      return;
    }

    setSegment(key);
    setSearch("");
    setQuery("");
    setLimit(PAGE_SIZE);
    setNotice("");
    setList(null);
  };

  const refresh = () => {
    setRefreshing(true);
    loadSummary();
    loadList();
  };

  // The guest being looked at lives in the address, so a link from the bell
  // ("your regular is at T5") opens straight onto them. Only a whole number
  // names a guest: "?guest=1.5" or "?guest=abc" is a broken link, said so here
  // rather than sent to the server to be refused (which showed as an error in
  // the browser for a link anyone can mistype).
  const viewingId = /^\d{1,15}$/.test(String(guestParam).trim()) && Number(guestParam) >= 1 ? Number(guestParam) : null;
  const brokenGuestLink = Boolean(String(guestParam).trim()) && viewingId === null;

  const knownNames = useMemo(() => {
    const names = new Map();

    if (summary) {
      summary.topGuests.forEach((guest) => names.set(guest.id, guest.name));
      summary.inHouse.forEach((entry) => names.set(entry.guest.id, entry.guest.name));
    }

    if (list) {
      list.items.forEach((guest) => names.set(guest.id, guest.name));
    }

    return names;
  }, [summary, list]);

  const viewingName =
    viewingId &&
    (knownNames.get(viewingId) || (fetchedName && fetchedName.id === viewingId ? fetchedName.name : null));

  // A guest linked from elsewhere may not be on the first page of any list
  // here, so they are looked up by id — a small read that only says who they
  // are; their history panel fetches the history itself, once. The panel
  // opens only when the guest is found. A link to a guest who is not in this
  // guest book (removed since the bell rang, or another restaurant's) closes
  // itself and says so, rather than opening a window that can never load.
  const lookingUp = Boolean(
    viewingId && (list || listError) && !knownNames.has(viewingId) && fetchedName?.id !== viewingId
  );

  useEffect(() => {
    if (!lookingUp) {
      return;
    }

    findGuest(viewingId)
      .then((guest) => {
        if (guest) {
          setFetchedName({ id: viewingId, name: guest.name });
          return;
        }

        // Clearing the guest from the address ends the lookup; following the
        // same link again looks again, and says so again.
        setLinkNotice(
          "That guest is not in your guest book any more — they may have been removed since the link was made. Pick a list below to find a guest."
        );
        setGuestParam("");
      })
      .catch((err) => {
        setLinkNotice(`Could not open that guest: ${getErrorMessage(err)}`);
        setGuestParam("");
      });
  }, [lookingUp, viewingId, setGuestParam]);

  const closeManualCopy = useCallback(() => setManualCopy(null), []);
  const openGuest = (guest) => {
    setLinkNotice("");
    setGuestParam(String(guest.id));
  };
  const closeGuest = useCallback(() => setGuestParam(""), [setGuestParam]);

  const onGuestChanged = () => {
    loadSummary();
    loadList();
  };

  // Export and Copy take what the screen shows: the list as searched (the
  // search that drew the rows on screen, not a half-typed one), every page of
  // it rather than only the rows drawn so far.
  const runExport = async (format) => {
    setBusy(format);
    setNotice("");
    setListError("");

    try {
      const data = await exportGuestSegment(segmentKey, format, query || undefined);

      if (format === "mobiles") {
        const mobiles = [...new Set(data.items.map((guest) => guest.mobile).filter(Boolean))];

        if (mobiles.length === 0) {
          setListError(
            data.search
              ? `Nobody matching “${data.search}” on this list has a mobile number on file.`
              : "Nobody on this list has a mobile number on file."
          );
          return;
        }

        const missing = data.total - data.withMobile;
        const text = mobiles.join("\n");

        if (!(await copyText(text))) {
          setManualCopy({ label: data.segment.label, text, count: mobiles.length, missing });
          return;
        }

        setNotice(
          `Copied ${plural(mobiles.length, "mobile number", "mobile numbers")} for ${exportedWhat(
            data
          )} — paste them into a WhatsApp broadcast list or your SMS tool.${
            missing > 0 ? ` ${plural(missing, "guest has", "guests have")} no mobile on file.` : ""
          }`
        );
        return;
      }

      if (data.items.length === 0) {
        setListError(
          data.search ? `Nobody on this list matches “${data.search}”.` : "There is nobody on this list to export."
        );
        return;
      }

      downloadCsv(guestListSheet(data), guestListFilename(data));

      setNotice(`Exported ${exportedWhat(data)}.`);
    } catch (err) {
      setListError(err.response ? getErrorMessage(err) : err.message);
    } finally {
      setBusy("");
    }
  };

  if (!summary) {
    return (
      <div className="stack gi-page">
        <PageHeader icon="pie" title="Guest insights" description="Who comes back, who stopped, who to thank." />
        {error ? <ErrorMessage message={error} /> : <Loading label="Reading the guest book…" />}
      </div>
    );
  }

  const { kpis, totals, currency, segments, today } = summary;
  const active = segments.find((segment) => segment.key === segmentKey) || segments[0];
  const listReady = list && list.segment.key === segmentKey;
  // The rows on screen answer the search that Export and Copy will send.
  const shown = listReady && list.search === query ? list : null;
  const exportBlocked = busy !== "" || active.count === 0 || (query !== "" && (!shown || shown.total === 0));

  return (
    <div className="stack gi-page">
      <PageHeader
        icon="pie"
        title="Guest insights"
        description="Who comes back, who stopped, who to thank — worked out from every bill, live."
        action={
          <button
            type="button"
            className="gi-live"
            onClick={refresh}
            title="Refreshes itself every minute. Click to refresh now."
          >
            <span className={`live-dot ${refreshing ? "is-busy" : ""}`} aria-hidden="true" />
            <span>Updated {updatedAt ? timeLabel(updatedAt) : "—"}</span>
            <Icon name="refresh" size={14} />
          </button>
        }
      />

      <ErrorMessage message={error} />

      {linkNotice && (
        <div className="alert alert-notice gi-link-notice" role="status">
          <span>{linkNotice}</span>
          <button type="button" className="link-button" onClick={() => setLinkNotice("")}>
            Dismiss
          </button>
        </div>
      )}

      {brokenGuestLink && !linkNotice && (
        <div className="alert alert-notice gi-link-notice" role="status">
          <span>
            Could not open that guest: the link should end in a guest&apos;s id number, such as ?guest=42. Pick a list
            below to find a guest.
          </span>
          <button type="button" className="link-button" onClick={closeGuest}>
            Dismiss
          </button>
        </div>
      )}

      <div className="stat-grid gi-kpis">
        <StatTile
          icon="users"
          tone="neutral"
          label="Guests on file"
          value={count(kpis.guestsOnFile)}
          note={`${count(totals.visitors)} have visited · ${count(totals.neverVisited)} not yet`}
        />
        <StatTile
          icon="activity"
          tone="success"
          label="Active guests"
          value={count(kpis.activeGuests)}
          note={`visited in 60 days · ${percent(kpis.activeShare)} of all`}
        />
        <StatTile
          icon="refresh"
          tone="info"
          label="Repeat rate"
          value={percent(kpis.repeatRate)}
          note={`${count(totals.repeaters)} of ${count(totals.visitors)} came back`}
        />
        <StatTile
          icon="wallet"
          tone="primary"
          label="Spend per visit"
          value={roundedMoney(kpis.averageSpendPerVisit, currency)}
          title={`${money(kpis.averageSpendPerVisit, currency)} exactly`}
          note={`${money(totals.spend, currency)} over ${count(totals.billedVisits)} billed visits`}
        />
      </div>

      <InHouse seated={summary.inHouse} currency={currency} onOpen={openGuest} now={now} />

      <section className="gi-lists" aria-labelledby="gi-lists-title">
        <div className="gi-lists-head">
          <span className="gi-lists-icon tone-primary" aria-hidden="true">
            <Icon name="list" size={18} />
          </span>
          <div>
            <h2 id="gi-lists-title">Guest lists</h2>
            <p className="muted small">
              Pick a list to see who is on it. Click a guest for every visit, what they order and their points.
            </p>
          </div>
          <label className="field gi-group-filter">
            <span>Guest group</span>
            <select value={segmentKey} onChange={event=>pickSegment(event.target.value)} aria-controls="gi-active-list">
              {segments.map(segment=><option key={segment.key} value={segment.key}>{segment.label} ({count(segment.count)})</option>)}
            </select>
          </label>
        </div>

        <div className="gi-segs" role="group" aria-label="Guest lists">
          {PRIMARY_SEGMENTS.map(key=>segments.find(segment=>segment.key===key)).filter(Boolean).map((segment) => (
            <SegmentCard
              key={segment.key}
              segment={segment}
              active={segment.key === segmentKey}
              onPick={pickSegment}
            />
          ))}
        </div>

        <div id="gi-active-list" className={`card gi-panel gi-tone-${active.tone}`} role="region" aria-label="Selected guest list">
          <div className="gi-panel-head">
            <div className="gi-panel-title">
              <span className="gi-panel-icon">
                <Icon name={SEGMENT_LOOK[active.key].icon} size={22} />
              </span>
              <div>
                <h2>
                  {active.label}
                  <span className="gi-count-pill">{count(active.count)}</span>
                </h2>
                <p className="muted small">{active.definition}</p>
                {active.note && <p className="gi-note small">{active.note}</p>}
              </div>
            </div>

            <div className="gi-panel-actions">
              <label className="input-with-icon gi-search">
                <Icon name="search" size={16} className="input-icon" />
                <span className="sr-only">Search this list</span>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name or mobile"
                  maxLength={100}
                />
              </label>
              {canExport ? (
                <>
                  {/* A broadcast list is nothing but numbers: only for those
                      who may see guests' contact details. */}
                  {canSeeContacts && (
                    <button
                      type="button"
                      className="button button-secondary gi-action"
                      onClick={() => runExport("mobiles")}
                      disabled={exportBlocked}
                    >
                      <Icon name="copy" size={16} />
                      {busy === "mobiles" ? "Copying…" : copyButtonLabel({ search: query })}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button gi-action"
                    onClick={() => runExport("csv")}
                    disabled={exportBlocked}
                  >
                    <Icon name="download" size={16} />
                    {busy === "csv"
                      ? "Exporting…"
                      : exportButtonLabel({ search: query, matching: shown ? shown.total : null })}
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <p className="gi-hint">
            <Icon name="zap" size={16} className="gi-icon" />
            <span>{active.hint}</span>
          </p>

          {(!canExport || !canSeeContacts) && (
            <p className="muted small">
              {!canSeeContacts &&
                (canExport
                  ? "Mobiles show only their last 4 digits for your role, in an export too. "
                  : "Mobiles show only their last 4 digits for your role. ")}
              {!canExport &&
                "Exporting a list or copying its mobile numbers needs the “Export guest lists” permission: ask the owner or a manager."}
            </p>
          )}

          {canExport && active.count > 0 && (!query || (shown && shown.total > 0)) && (
            <p className="gi-scope small">
              <Icon name="download" size={14} className="gi-icon" />
              <span>
                {exportScope({
                  search: query,
                  matching: shown ? shown.total : 0,
                  onList: shown && !query ? shown.total : active.count,
                  drawn: shown ? shown.items.length : undefined,
                  canCopy: canSeeContacts,
                })}
              </span>
            </p>
          )}

          <SuccessMessage message={notice} />
          {/* A list that failed to load says so inside the list (with Try
              again); this line is for Export and Copy. */}
          <ErrorMessage message={listReady ? listError : ""} />

          <SegmentRows
            segment={active}
            items={listReady ? list.items : []}
            loading={!listReady && !listError}
            error={listReady ? "" : listError}
            onRetry={loadList}
            empty={segmentEmpty({ segment: active, summary, searching: Boolean(query) })}
            currency={currency}
            today={today}
            loyalty={summary.loyalty}
            onOpen={openGuest}
            contactsHidden={!canSeeContacts}
            windowDays={summary.rules?.regularWindowDays}
          />

          {listReady && list.total > list.items.length && (
            <div className="gi-more">
              <span className="muted small">
                Showing {count(list.items.length)} of {count(list.total)}
              </span>
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => setLimit(Math.min(list.total, 5000))}
              >
                <Icon name="chevron-down" size={15} />
                Show all {count(list.total)}
              </button>
            </div>
          )}
        </div>
      </section>

      <details className="card gi-analytics">
        <summary>
          <Icon name="chart" size={18} /> Guest trends &amp; top guests
        </summary>
        <p className="small muted">
          Average visits per guest: {decimal(kpis.averageVisits)}. New this month: {count(kpis.newThisMonth)}
          {" "}(since {shortDate(kpis.monthStart, today)}).
        </p>
        <div className="gi-charts">
          <Frequency
            distribution={summary.distribution}
            visitors={totals.visitors}
            neverVisited={totals.neverVisited}
            totals={totals}
            onFile={kpis.guestsOnFile}
          />
          <TopGuests guests={summary.topGuests} currency={currency} onOpen={openGuest} />
        </div>
      </details>

      <details className="card gi-rules">
        <summary>
          <Icon name="info" size={16} />
          How these numbers are worked out
        </summary>
        <ul>
          <li>
            A <strong>visit</strong> is an order linked to the guest at the till; cancelled orders do not
            count. A table still eating counts as a visit before its bill is paid.
          </li>
          <li>
            <strong>Spend</strong> is the total of the guest's bills, void bills left out — the same figure
            as their history panel and net sales in the reports. Money refunded later is not taken off
            here, just as the reports show refunds on a line of their own.
          </li>
          <li>
            <strong>Spend per visit</strong> divides that by the visits that have a bill, so a table still
            eating does not pull the average down.
          </li>
          <li>
            Days are counted on the restaurant's calendar ({summary.timezone}). "The last 60 days" means
            today and the 59 before it. Guests marked inactive are left out
            {totals.inactiveGuests > 0 ? ` (${count(totals.inactiveGuests)} at the moment)` : ""}.
          </li>
          <li>
            Ratings and complaints are matched to a guest by the link on them, or — when they were taken
            without one — by the last ten digits of the mobile number, so {"“+91 98495 10101”"} and
            “9849510101” are the same guest.
          </li>
          <li>
            <strong>Big spenders</strong> are everyone who has spent at least as much as the guest who closes
            the top {summary.rules.bigSpenderSharePercent}% of spenders
            {summary.rules.bigSpenderFrom ? ` (${money(summary.rules.bigSpenderFrom, currency)} today)` : ""}.
            Guests level on spend are all in, and share a rank: the Top 10 and the Big spenders list count
            it the same way, so two guests on the same amount are both 3rd and the next one is 5th.
          </li>
          <li>
            A guest can be on more than one list. A <strong>regular</strong> who has not been in for{" "}
            {summary.rules.lapsedQuietDays} days is also <strong>at risk</strong>, and their tag says how
            long they have been away.
          </li>
        </ul>
      </details>

      {manualCopy && (
        <Modal
          title={`${plural(manualCopy.count, "mobile number", "mobile numbers")} — ${manualCopy.label}`}
          icon="copy"
          description="Copy these by hand, then paste them into WhatsApp or your SMS tool."
          onClose={closeManualCopy}
          width={480}
        >
          <div className="stack gi-manual-copy">
            <p className="muted small">
              This browser did not let the page copy for you. The numbers are selected below — press Ctrl+C
              (on a phone, long-press and choose Copy), then paste them into a WhatsApp broadcast list or your
              SMS tool.
              {manualCopy.missing > 0
                ? ` ${manualCopy.missing} ${manualCopy.missing === 1 ? "guest has" : "guests have"} no mobile on file.`
                : ""}
            </p>
            <textarea
              readOnly
              autoFocus
              rows={Math.min(10, Math.max(4, manualCopy.count))}
              value={manualCopy.text}
              onFocus={(event) => event.target.select()}
              aria-label="Mobile numbers"
            />
            <div className="form-actions">
              <button type="button" className="button" onClick={closeManualCopy}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}

      {viewingId && viewingName && (
        <CustomerHistoryModal
          customer={{ id: viewingId, name: viewingName }}
          currency={currency}
          canManage={canManage}
          onClose={closeGuest}
          onChanged={onGuestChanged}
        />
      )}
    </div>
  );
}
