import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import StatTile from "../../../../components/StatTile";
import Icon from "@bmp/ui/Icon";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import { count, durationMinutes, money, moneyExact } from "@bmp/shared/format";
import { dayMonth, daysAgo, today } from "@bmp/shared/dates";
import { playChime, unlockChime } from "../../../../services/kot";
import { getSettings } from "../../setup/services/restaurant.service";
import { listTables } from "../../tables/services/table.service";
import {
  acceptTableRequest,
  acknowledgeTableRequest,
  closeEarlierTableRequests,
  completeTableRequest,
  getTableRequestSettings,
  getTableRequestSummary,
  listTableRequests,
  rejectTableRequest,
  updateTableRequestSettings,
} from "../services/tableRequest.service";
import { CALL_META } from "../services/tableRequestWords";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import SectionCard from "../../../../components/SectionCard";
import { customerWebOrigin } from "../../../../services/customerWeb";
import "../styles/table-requests.css";
import "../styles/online-inbox.css";

// The captain's inbox: QR orders waiting for a yes, and tables calling for a
// waiter, the bill or water. Built to be worked from a phone on the floor as
// much as from the till — the thing that matters is which table has waited
// longest, so waiting requests come first, oldest first, with a clock that
// turns amber and then red.
//
// Its cards (OrderCard, CallCard) and the reject dialog (RejectDialog) are the
// captain app's too (workspaces/captain): one way to answer a guest.

// A card that just arrived keeps its glow this long.
const FRESH_FOR = 20000;
const SOUND_KEY = "rmp_table_requests_sound";

// The same marks the notification bell uses, so the card and the bell turn
// amber and red together.
const ORDER_WARN_MIN = 2;
const ORDER_LATE_MIN = 5;
const CALL_WARN_MIN = 3;
const CALL_LATE_MIN = 6;

const OPEN = ["pending", "processing", "acknowledged"];

// The inbox is today's (the owner's rule for live screens): Waiting and
// Today hold nothing from an earlier business day. Waiting is the live board
// of cards; Today and Earlier days are lists that grow, read a page at a time
// in the data grid, Earlier days by date range. (An old link to ?view=all
// opens Earlier days.)
const VIEWS = [
  { key: "pending", label: "Waiting" },
  { key: "today", label: "Today" },
  { key: "history", label: "Earlier days" },
];

// One tap fills the reason; it can still be edited. Written to the guest,
// because the guest is who reads it.
const REJECT_REASONS = [
  { label: "Dish sold out", text: "Sorry — a dish you ordered has just sold out. Your waiter will suggest something else." },
  { label: "Kitchen closing", text: "Sorry — the kitchen has closed for the night." },
  { label: "Order with waiter", text: "Please place this order with your waiter, who is on the way." },
  { label: "Looks like a repeat", text: "This looks like a repeat of your last order, so we have not sent it again. Please check with your waiter." },
];

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
    // Storage switched off: the toggle still works for this visit.
  }
};

// ---------------------------------------------------------------- icons

// Every mark comes from the shared icon set except these two, which it does
// not carry: the bell struck through (chime off) and a drop of water.
const GLYPHS = {
  "bell-off":
    "M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20",
  drop: "M12 2.7s6 6.3 6 11.3a6 6 0 0 1-12 0c0-5 6-11.3 6-11.3z",
};

function Glyph({ name, size = 18 }) {
  if (!GLYPHS[name]) {
    return <Icon name={name} size={size} />;
  }

  return (
    <svg
      className="icon"
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

// ---------------------------------------------------------------- time

// "0:42", "3:05", "1h 04m": a live clock, readable from across the room.
const clock = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));

  if (seconds >= 3600) {
    return durationMinutes(seconds / 60);
  }

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

// "answered in 1m 35s": how quickly the floor responded.
const took = (seconds) => {
  if (seconds === null || seconds === undefined) {
    return "";
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  return durationMinutes(minutes);
};

const timeOfDay = (value) =>
  new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

const tone = (milliseconds, warnMinutes, lateMinutes) => {
  if (milliseconds >= lateMinutes * 60000) return "late";
  if (milliseconds >= warnMinutes * 60000) return "warn";
  return "ok";
};

const place = (request) => [request.floorName, request.areaName].filter(Boolean).join(" · ");

// An order from the restaurant's own ordering page: no table, but
// a service, a selling point, maybe an address, and how the guest will pay.
const isOnline = (request) => request.channel === "website";
const SERVICE_WORDS = { takeaway: "takeaway", delivery: "delivery" };
const PAYMENT_WORDS = { pay_at_pickup: "Pays at pickup", cash_on_delivery: "Cash on delivery" };
const onlineTitle = (request) =>
  `Online ${SERVICE_WORDS[request.serviceType] || "order"}${request.guestName ? ` · ${request.guestName}` : ""}`;
const onlinePlace = (request) => request.outletName || "Main counter";

const plural = (value, one, many) => `${count(value)} ${value === 1 ? one : many}`;

// ---------------------------------------------------------------- pieces

function FoodMark({ type }) {
  return <span className={`tr-food tr-food-${type || "veg"}`} aria-hidden="true" />;
}

const STATUS_CHIPS = {
  pending: { label: "Waiting", tone: "warn" },
  processing: { label: "Accepting…", tone: "warn" },
  accepted: { label: "Accepted", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
  acknowledged: { label: "On the way", tone: "info" },
  done: { label: "Done", tone: "good" },
  cancelled: { label: "Cancelled by guest", tone: "muted" },
};

function StatusChip({ status }) {
  const chip = STATUS_CHIPS[status] || { label: status, tone: "muted" };

  return <span className={`tr-chip tr-chip-${chip.tone}`}>{chip.label}</span>;
}

function WaitClock({ since, now, warn, late }) {
  const age = now - new Date(since).getTime();
  const state = tone(age, warn, late);

  return (
    <span className={`tr-clock is-${state}`} title={`Waiting since ${timeOfDay(since)}`}>
      <Icon name="timer" size={15} />
      {clock(age)}
    </span>
  );
}

// The captain who has the table today: "Your table", or their name.
function CaptainTag({ request, myUserId }) {
  if (!request.captain) {
    return null;
  }

  const mine = myUserId && request.captain.userId === myUserId;

  return (
    <span className={`tr-captain ${mine ? "is-mine" : ""}`}>{mine ? "Your table" : `${request.captain.userName}'s table`}</span>
  );
}

// Where "Open in POS" goes for an order: the POS, or the captain app's own
// order screen (its `orderLink`).
const posLink = (orderId) => `/pos?order=${orderId}`;

export function OrderCard({ request, now, busy, error, fresh, canAct, canOpenPos, currency, workingOutlet, onAccept, onReject, myUserId = null, orderLink = posLink }) {
  const open = OPEN.includes(request.status);
  // A table shared by every outlet can have another outlet's order running
  // on it. Only someone working there adds to it (as in the POS), so this
  // card cannot be accepted from here; the server refuses it the same way.
  const online = isOnline(request);
  const elsewhere = Boolean(
    workingOutlet &&
      request.tableOrder &&
      String(request.tableOrder.outletId || "") !== String(workingOutlet)
  );
  const elsewhereName = elsewhere ? request.tableOrder.outletName || "All outlets" : null;
  const [expanded, setExpanded] = useState(false);
  const showItems = open || expanded;

  return (
    <article
      className={`tr-card tr-order ${online ? "is-online" : ""} ${open ? "is-open" : "is-closed"} ${fresh ? "is-fresh" : ""}`}
    >
      <header className="tr-card-head">
        {online ? (
          <span className={`tr-table-badge oi-badge is-${request.serviceType}`} title="From your online ordering page">
            <Icon name={request.serviceType === "delivery" ? "scooter" : "store"} size={20} />
          </span>
        ) : (
          <span className="tr-table-badge">{request.tableNo}</span>
        )}
        <div className="tr-card-title">
          <strong>{online ? onlineTitle(request) : `Table ${request.tableNo}`}</strong>
          <span>
            {online ? `Website · ${onlinePlace(request)}` : place(request) || "Dining room"} · {timeOfDay(request.createdAt)}
            <CaptainTag request={request} myUserId={myUserId} />
          </span>
        </div>
        {open ? (
          <WaitClock since={request.createdAt} now={now} warn={ORDER_WARN_MIN} late={ORDER_LATE_MIN} />
        ) : (
          <StatusChip status={request.status} />
        )}
      </header>

      {(request.guestName || request.guestMobile) && (
        <p className="tr-guest">
          <span className="tr-guest-name">{request.guestName || "Guest"}</span>
          {/* Staff who may not see guests' full numbers get the last four
              digits ("XXXXXX4823"): shown, but not a number to dial. */}
          {request.guestMobile &&
            (/X/.test(request.guestMobile) ? (
              <span className="tr-guest-phone">
                <Icon name="phone" size={13} /> {request.guestMobile}
              </span>
            ) : (
              <a href={`tel:${request.guestMobile}`} className="tr-guest-phone">
                <Icon name="phone" size={13} /> {request.guestMobile}
              </a>
            ))}
        </p>
      )}

      {online && (
        <div className="oi-details">
          {request.serviceType === "delivery" && request.deliveryAddress && (
            <p className="oi-address">
              <Icon name="home" size={14} />
              <span>
                {request.deliveryAddress}
                {request.deliveryLandmark ? <span className="muted"> · {request.deliveryLandmark}</span> : null}
              </span>
            </p>
          )}
          <p className="oi-tags">
            <span className="oi-tag is-channel">Website</span>
            <span className={`oi-tag is-${request.serviceType}`}>
              {request.serviceType === "delivery" ? "Delivery" : "Takeaway"}
            </span>
            <span className="oi-tag">{PAYMENT_WORDS[request.paymentMode] || "Pays on collection"}</span>
          </p>
        </div>
      )}

      {showItems ? (
        <ul className="tr-items">
          {request.items.map((item) => (
            <li key={item.id}>
              <FoodMark type={item.foodType} />
              <span className="tr-qty">{item.quantity}×</span>
              <span className="tr-item-name">
                {item.name}
                {item.variant && <span className="tr-variant"> ({item.variant})</span>}
                {item.modifiers.length > 0 && (
                  <span className="tr-mods">+ {item.modifiers.map((modifier) => modifier.name).join(", ")}</span>
                )}
                {item.notes && <span className="tr-item-note">“{item.notes}”</span>}
              </span>
              <span className="tr-item-price">{money(item.lineTotal, currency)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <button type="button" className="tr-items-summary" onClick={() => setExpanded(true)}>
          {request.items
            .slice(0, 3)
            .map((item) => `${item.quantity}× ${item.name}`)
            .join(", ")}
          {request.items.length > 3 ? ` +${request.items.length - 3} more` : ""}
        </button>
      )}

      {request.notes && open && (
        <p className="tr-note">
          <Icon name="message" size={14} /> {request.notes}
        </p>
      )}

      <div className="tr-card-foot">
        <div className="tr-total">
          <span>
            {plural(request.itemCount, "item", "items")} · est.{" "}
            <strong>{moneyExact(request.estimatedTotal, currency)}</strong> incl. GST
            {online && request.deliveryCharge > 0 ? ` + ${moneyExact(request.deliveryCharge, currency)} delivery` : ""}
          </span>
          {open && online && (
            <span className="tr-destination is-new">
              Opens a {request.serviceType} at {request.outletName || "the main counter"}
            </span>
          )}
          {open && !online && (
            <span className={`tr-destination ${request.tableOrder ? "is-add" : "is-new"}`}>
              {request.tableOrder
                ? elsewhere
                  ? `On ${request.tableOrder.orderNumber} (${elsewhereName})`
                  : request.tableOrder.status === "billed"
                    ? `Table already billed on ${request.tableOrder.orderNumber}`
                    : `Adds to ${request.tableOrder.orderNumber}`
                : "Opens a new order"}
            </span>
          )}
        </div>

        {request.status === "accepted" && (
          <p className="tr-outcome is-good">
            <Icon name="check" size={15} />
            <span>
              {request.orderAction === "added" ? "Added to" : "Opened"}{" "}
              <strong>{request.orderNumber || "the order"}</strong>
              {request.resolvedByName ? ` by ${request.resolvedByName}` : ""}
              {request.responseSeconds !== null ? ` · answered in ${took(request.responseSeconds)}` : ""}
            </span>
            {canOpenPos && request.orderId && (
              <Link to={orderLink(request.orderId)} className="tr-link">
                Open in POS <Icon name="external" size={13} />
              </Link>
            )}
          </p>
        )}

        {request.status === "rejected" && (
          <p className="tr-outcome is-bad">
            <Icon name="x-circle" size={15} />
            <span>
              {request.resolvedByName ? `${request.resolvedByName}: ` : ""}“{request.rejectReason}”
            </span>
          </p>
        )}

        {error && (
          <p className="tr-card-error" role="alert">
            {error}
          </p>
        )}

        {open && canAct && elsewhere && (
          <p className="tr-muted-line">
            {request.tableOrder.orderNumber} belongs to {elsewhereName}: someone working there accepts this.
          </p>
        )}
        {open && canAct && (
          <div className="tr-actions">
            <button
              type="button"
              className="button button-secondary tr-reject"
              disabled={Boolean(busy)}
              onClick={() => onReject(request)}
            >
              Reject
            </button>
            <button
              type="button"
              className="button tr-accept"
              disabled={Boolean(busy) || request.status === "processing" || elsewhere}
              onClick={() => onAccept(request)}
            >
              <Icon name="check" size={16} />
              {busy === "accept" ? "Accepting…" : "Accept"}
            </button>
          </div>
        )}
        {open && !canAct && (
          <p className="tr-muted-line">Only staff who can take orders can accept or reject this.</p>
        )}
      </div>
    </article>
  );
}

export function CallCard({ request, now, busy, error, fresh, canOpenPos, onAcknowledge, onDone, myUserId = null, orderLink = posLink }) {
  const meta = CALL_META[request.type] || CALL_META.other;
  const open = ["pending", "acknowledged"].includes(request.status);

  return (
    <article className={`tr-card tr-call tr-call-${request.type} ${open ? "is-open" : "is-closed"} ${fresh ? "is-fresh" : ""}`}>
      <header className="tr-card-head">
        <span className="tr-call-icon">
          <Glyph name={meta.icon} size={20} />
        </span>
        <div className="tr-card-title">
          <strong>
            Table {request.tableNo} · {meta.title}
          </strong>
          <span>
            {place(request) || "Dining room"} · {timeOfDay(request.createdAt)}
            <CaptainTag request={request} myUserId={myUserId} />
          </span>
        </div>
        {open ? (
          <WaitClock since={request.createdAt} now={now} warn={CALL_WARN_MIN} late={CALL_LATE_MIN} />
        ) : (
          <StatusChip status={request.status} />
        )}
      </header>

      {request.type === "other" && request.notes && <p className="tr-call-message">“{request.notes}”</p>}

      {(request.repeatCount > 0 && open) || request.status === "acknowledged" ? (
        <div className="tr-call-meta">
          {request.repeatCount > 0 && open && (
            <span className="tr-chip tr-chip-bad">
              <Icon name="refresh" size={12} /> Asked {request.repeatCount + 1}× · last {clock(now - new Date(request.lastAskedAt).getTime())} ago
            </span>
          )}
          {request.status === "acknowledged" && (
            <span className="tr-chip tr-chip-info">
              {request.acknowledgedByName || "Someone"} is on the way
            </span>
          )}
        </div>
      ) : null}

      {!open && request.status === "done" && (
        <p className="tr-muted-line">
          Done{request.resolvedByName ? ` by ${request.resolvedByName}` : ""}
          {request.responseSeconds !== null ? ` · answered in ${took(request.responseSeconds)}` : ""}
        </p>
      )}

      {error && (
        <p className="tr-card-error" role="alert">
          {error}
        </p>
      )}

      {open && (
        <div className="tr-actions">
          {request.type === "bill" && request.tableOrder && canOpenPos && (
            <Link to={orderLink(request.tableOrder.id)} className="button button-secondary tr-bill-link">
              <Icon name="receipt" size={15} /> {request.tableOrder.orderNumber}
            </Link>
          )}
          {request.status === "pending" && (
            <button
              type="button"
              className="button button-secondary"
              disabled={Boolean(busy)}
              title="Acknowledge: the guest sees that someone is coming"
              onClick={() => onAcknowledge(request)}
            >
              {busy === "acknowledge" ? "Saving…" : "On my way"}
            </button>
          )}
          <button type="button" className="button tr-done" disabled={Boolean(busy)} onClick={() => onDone(request)}>
            <Icon name="check" size={16} />
            {busy === "done" ? "Saving…" : "Done"}
          </button>
        </div>
      )}
    </article>
  );
}

// Rejecting a guest's order, with the reason written to the guest, who reads
// it on their phone. A failed acceptance usually says exactly why ("sold
// out"), which is the reason the guest needs, so it is offered as the
// starting text.
//   request    the order being rejected
//   failure    what refused accepting it, if anything did
//   busy       the rejection is being sent
//   error      the server's refusal of it
//   onReject(reason), onClose
export function RejectDialog({ request, failure = "", busy, error, onReject, onClose }) {
  const [reason, setReason] = useState(() => (failure && /sold out/i.test(failure) ? REJECT_REASONS[0].text : ""));

  return (
    <Modal
      title={
        isOnline(request)
          ? `Reject ${request.guestName ? `${request.guestName}'s` : "the"} online order`
          : `Reject the order from table ${request.tableNo}`
      }
      description="The guest sees your reason on their phone, so write it to them. Nothing goes to the kitchen."
      icon="x-circle"
      onClose={onClose}
      width={540}
    >
      <div className="stack">
        <p className="small tr-reject-help">Pick a reason, or write your own:</p>
        <div className="tr-reason-chips">
          {REJECT_REASONS.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`chip-button ${reason === option.text ? "is-active" : ""}`}
              onClick={() => setReason(option.text)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Reason for the guest</span>
          <textarea
            rows={3}
            maxLength={200}
            value={reason}
            placeholder="e.g. Sorry — the mutton is finished for tonight."
            onChange={(event) => setReason(event.target.value)}
          />
          <small className="muted">{reason.length}/200</small>
        </label>
        <ErrorMessage message={error} />
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep it
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={!reason.trim() || busy}
            onClick={() => onReject(reason.trim())}
          >
            {busy ? "Rejecting…" : "Reject order"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- the lists

// What became of a request, in words, for the lists.
const outcomeOf = (request) => {
  const open = OPEN.includes(request.status);

  if (open && request.fromEarlierDay) {
    return request.status === "acknowledged"
      ? { label: "On the way, never closed", tone: "bad" }
      : { label: "Never answered", tone: "bad" };
  }

  return STATUS_CHIPS[request.status] || { label: request.status, tone: "muted" };
};

// The request in words, for the grid's cell, search and the CSV.
const requestText = (request) => {
  if (request.type === "order") {
    return `${isOnline(request) ? "Online order" : "QR order"} · ${plural(request.itemCount, "item", "items")}`;
  }

  const meta = CALL_META[request.type] || CALL_META.other;

  return request.type === "other" && request.notes ? `${meta.title}: ${request.notes}` : meta.title;
};

// The most the API hands back in one request (tableRequest.controller.js).
const API_MAX = 500;

// Today's requests (mode "today") or those of earlier days by date range
// (mode "history"), a page at a time in the shared data grid, newest first
// (today: still-waiting ones first, oldest first). `refreshKey` reloads the
// page on show: today's list follows the inbox's 10-second refresh, history
// reloads only after an action taken here (it does not change under the
// reader).
function RequestGrid({
  mode,
  refreshKey,
  busy,
  cardErrors,
  canAct,
  canOpenPos,
  currency,
  onAccept,
  onReject,
  onAcknowledge,
  onDone,
}) {
  const history = mode === "history";
  const [fromParam, setFrom] = useQueryFilter("from");
  const [toParam, setTo] = useQueryFilter("to");
  const [type, setType] = useQueryFilter("type");
  // The last seven days, until the reader picks a range. Today's own
  // requests are never in this list (the API keeps them to Waiting and
  // Today), so a range that reaches today, or a business day still open
  // since yesterday, shows only what came before the day opened.
  const from = history ? fromParam || daysAgo(7) : undefined;
  const to = history ? toParam || today() : undefined;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() =>
    rememberedPageSize(history ? "table-requests-history" : "table-requests-today", 25)
  );
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [reloads, setReloads] = useState(0);
  const { hasPermission } = useAuth();
  const canClose = hasPermission("orders.manage");
  const [closing, setClosing] = useState(false);
  const [closeNote, setCloseNote] = useState("");

  // Every QR order an earlier day left waiting is rejected (the guest sees
  // why) and every call from then closed; today's are never touched.
  const closeEarlier = async () => {
    setClosing(true);
    setCloseNote("");

    try {
      const result = await closeEarlierTableRequests("Not taken: sent on an earlier day");
      setCloseNote(result.message);
      setReloads((value) => value + 1);
    } catch (err) {
      setCloseNote(getErrorMessage(err));
    } finally {
      setClosing(false);
    }
  };

  const query = useMemo(
    () => ({ view: history ? "history" : "today", from, to, type: type || undefined }),
    [history, from, to, type]
  );

  useEffect(() => {
    let live = true;

    listTableRequests({ ...query, limit: pageSize, offset: (page - 1) * pageSize })
      .then((result) => {
        if (live) {
          setData(result);
          setError("");
        }
      })
      .catch((err) => {
        if (live) setError(getErrorMessage(err));
      });

    return () => {
      live = false;
    };
  }, [query, page, pageSize, refreshKey, reloads]);

  // "Export CSV" takes every request that matches, not only the page on show.
  const fetchAll = async () => {
    const all = [];

    for (let at = 0; ; at += API_MAX) {
      const result = await listTableRequests({ ...query, limit: API_MAX, offset: at });
      all.push(...result.items);

      if (result.items.length === 0 || all.length >= result.total) {
        return all;
      }
    }
  };

  const columns = useMemo(
    () => [
      {
        key: "table",
        header: "From",
        value: (request) => (isOnline(request) ? onlineTitle(request) : request.tableNo),
        mobile: "title",
        pin: true,
        csv: (request) =>
          isOnline(request)
            ? `${onlineTitle(request)} (Website, ${onlinePlace(request)})`
            : `Table ${request.tableNo}${place(request) ? ` (${place(request)})` : ""}`,
        render: (request) =>
          isOnline(request) ? (
            <span className="tr-h-table">
              <strong>{onlineTitle(request)}</strong>
              <span className="muted small">Website · {onlinePlace(request)}</span>
            </span>
          ) : (
            <span className="tr-h-table">
              <strong>Table {request.tableNo}</strong>
              <span className="muted small">{place(request) || "Dining room"}</span>
            </span>
          ),
      },
      {
        key: "sent",
        header: "Sent",
        type: "datetime",
        value: (request) => request.createdAt,
        mobile: "subtitle",
        render: (request) => <span className="nowrap">{dayMonth(request.createdAt, { time: true })}</span>,
      },
      {
        key: "request",
        header: "Request",
        value: requestText,
        mobile: "show",
        minWidth: 180,
        render: (request) =>
          request.type === "order" ? (
            <span className="tr-h-request">
              {requestText(request)}
              <span className="muted small">
                est. {moneyExact(request.estimatedTotal, currency)}
                {request.guestName ? ` · ${request.guestName}` : ""}
                {request.guestMobile ? ` · ${request.guestMobile}` : ""}
              </span>
            </span>
          ) : (
            <span className="tr-h-request">{requestText(request)}</span>
          ),
      },
      {
        key: "outcome",
        header: "Outcome",
        type: "status",
        value: (request) => outcomeOf(request).label,
        mobile: "show",
        render: (request) => {
          const outcome = outcomeOf(request);

          return (
            <span className="tr-h-outcome">
              <span className={`tr-chip tr-chip-${outcome.tone}`}>{outcome.label}</span>
              {request.status === "accepted" && request.orderNumber && (
                <span className="muted small">
                  {canOpenPos && request.orderId ? (
                    <Link to={`/pos?order=${request.orderId}`}>{request.orderNumber}</Link>
                  ) : (
                    request.orderNumber
                  )}
                </span>
              )}
              {request.status === "rejected" && request.rejectReason && (
                <span className="muted small">“{request.rejectReason}”</span>
              )}
              {cardErrors[request.id] && (
                <span className="tr-card-error small" role="alert">
                  {cardErrors[request.id]}
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "handled",
        header: "Handled by",
        value: (request) => request.resolvedByName || request.acknowledgedByName || "",
        mobile: "show",
        render: (request) => (
          <span className="small">
            {request.resolvedByName || request.acknowledgedByName || "—"}
            {request.responseSeconds !== null && request.responseSeconds !== undefined && (
              <span className="muted"> · in {took(request.responseSeconds)}</span>
            )}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        label: "Actions",
        type: "actions",
        render: (request) => {
          const isOrder = request.type === "order";
          const open = OPEN.includes(request.status);
          const rowBusy = busy[request.id];

          if (!open || (isOrder && !canAct)) {
            return null;
          }

          return (
            <div className="row-actions">
              {isOrder ? (
                <>
                  {/* An order of an earlier day is never cooked: the guests
                      have gone. It can only be rejected. */}
                  {!request.fromEarlierDay && (
                    <button
                      type="button"
                      className="button button-sm"
                      disabled={Boolean(rowBusy) || request.status === "processing"}
                      onClick={() => onAccept(request)}
                    >
                      {rowBusy === "accept" ? "Accepting…" : "Accept"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    disabled={Boolean(rowBusy)}
                    onClick={() => onReject(request)}
                  >
                    Reject
                  </button>
                </>
              ) : (
                <>
                  {request.status === "pending" && !request.fromEarlierDay && (
                    <button
                      type="button"
                      className="button button-secondary button-sm"
                      disabled={Boolean(rowBusy)}
                      onClick={() => onAcknowledge(request)}
                    >
                      On my way
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    disabled={Boolean(rowBusy)}
                    onClick={() => onDone(request)}
                  >
                    {rowBusy === "done" ? "Saving…" : request.fromEarlierDay ? "Close" : "Done"}
                  </button>
                </>
              )}
            </div>
          );
        },
      },
    ],
    [busy, cardErrors, canAct, canOpenPos, currency, onAccept, onReject, onAcknowledge, onDone]
  );

  const kindWords =
    type === "order" ? "orders" : type === "online" ? "online orders" : type === "service" ? "calls" : "requests";

  return (
    <>
      {data && error && <ErrorMessage message={`Could not refresh: ${error}`} />}

      <SectionCard
        icon={history ? "history" : "list"}
        title={history ? "Earlier days" : "Today's requests"}
        description={
          history
            ? "QR orders and calls by the business day they were sent on, newest first. One never answered can still be rejected or closed here; an order from an earlier day is never cooked."
            : "Every QR order and call since the day opened: the ones still waiting first, then the newest."
        }
        className="tr-history"
        flush
        actions={
          history && canClose ? (
            <button type="button" className="button button-secondary button-sm" disabled={closing} onClick={closeEarlier}>
              {closing ? "Closing…" : "Close all still waiting"}
            </button>
          ) : null
        }
      >
      {closeNote && <p className="muted small tr-close-note">{closeNote}</p>}
      <DataGrid
        id={history ? "table-requests-history" : "table-requests-today"}
        caption={history ? "Table requests of earlier days" : "Today's table requests"}
        columns={columns}
        rows={data ? data.items : []}
        rowKey={(request) => request.id}
        loading={!data && !error}
        error={data ? "" : error}
        onRetry={() => setReloads((current) => current + 1)}
        empty={history ? "Nothing in these dates" : `No ${kindWords} yet today`}
        emptyIcon={history ? "history" : "bell"}
        emptyHint={
          history
            ? `No ${kindWords} from ${dayMonth(from)} to ${dayMonth(to)}.`
            : "Orders and calls from guests' phones show here as they arrive."
        }
        rowClassName={(request) =>
          OPEN.includes(request.status) && request.fromEarlierDay ? "dg-tone-danger" : ""
        }
        exportName={history ? `table-requests-${from}-to-${to}` : "table-requests-today"}
        // The API pages; it does not sort or search, so the headers do not
        // offer to (sorting 25 of 300 would only look like an answer).
        server={{
          total: data ? data.total : 0,
          page,
          pageSize,
          fetchAll,
          onChange: (change) => {
            if (change.pageSize !== pageSize) {
              setPageSize(change.pageSize);
              setPage(1);
            } else {
              setPage(change.page);
            }
          },
        }}
        toolbar={
          <>
            {history && (
              <DateRangeFilter
                from={from}
                to={to}
                label="request dates"
                onChange={(range) => {
                  setFrom(range.from);
                  setTo(range.to);
                  setPage(1);
                }}
              />
            )}
            <label className="field">
              <span>Kind</span>
              <select
                value={type}
                onChange={(event) => {
                  setType(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">Orders and calls</option>
                <option value="order">All orders</option>
                <option value="online">Online orders</option>
                <option value="service">Calls</option>
              </select>
            </label>
          </>
        }
      />
      </SectionCard>
    </>
  );
}

// ---------------------------------------------------------------- settings

// "On" / "Off" in words beside a switch the reader may not change.
function SwitchState({ on }) {
  return <span className={`tr-switch-state ${on ? "is-on" : ""}`}>{on ? "On" : "Off"}</span>;
}

function SettingsModal({ onClose, onSaved, canManage, canPreview }) {
  const [form, setForm] = useState(null);
  const [tables, setTables] = useState([]);
  const [tableToken, setTableToken] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTableRequestSettings()
      .then((settings) =>
        setForm({
          orderingEnabled: settings.orderingEnabled,
          callsEnabled: settings.callsEnabled,
          guestNote: settings.guestNote || "",
        })
      )
      .catch((err) => setError(getErrorMessage(err)));

    if (canPreview) {
      listTables()
        .then((rows) => {
          // Only tables a guest could really order from: switched on, and
          // on a floor and in a section that are open (inService). A table
          // on a closed floor answers the guest "we couldn't find this
          // table", so previewing it would only open an error page.
          const usable = rows.filter((row) => row.inService);
          setTables(usable);
          setTableToken(usable[0] ? usable[0].qrToken : "");
        })
        .catch(() => setTables([]));
    }
  }, [canPreview]);

  const save = async () => {
    setSaving(true);
    setError("");

    try {
      await updateTableRequestSettings({
        orderingEnabled: form.orderingEnabled,
        callsEnabled: form.callsEnabled,
        guestNote: form.guestNote.trim() || null,
      });
      onSaved("QR ordering settings saved");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="QR ordering"
      description="What guests can do from the QR code on their table."
      icon="qr"
      onClose={onClose}
      width={560}
    >
      {!form ? (
        error ? <ErrorMessage message={error} /> : <Loading />
      ) : (
        <div className="stack tr-settings">
          {!canManage && (
            <p className="tr-locked-note">
              <Icon name="lock" size={15} />
              <span>Only a manager can change these. This is what guests can do right now.</span>
            </p>
          )}

          <label className={`tr-switch-row ${form.orderingEnabled ? "is-on" : ""} ${canManage ? "" : "is-locked"}`}>
            <input
              type="checkbox"
              checked={form.orderingEnabled}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, orderingEnabled: event.target.checked })}
            />
            <span className="tr-switch" aria-hidden="true" />
            <span>
              <strong>Guests can order from the table</strong>
              <small>
                Switch off on a slammed night: guests can still browse the menu and call a waiter.
              </small>
            </span>
            {!canManage && <SwitchState on={form.orderingEnabled} />}
          </label>

          <label className={`tr-switch-row ${form.callsEnabled ? "is-on" : ""} ${canManage ? "" : "is-locked"}`}>
            <input
              type="checkbox"
              checked={form.callsEnabled}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, callsEnabled: event.target.checked })}
            />
            <span className="tr-switch" aria-hidden="true" />
            <span>
              <strong>Guests can call staff</strong>
              <small>The Call waiter, Request bill and Water buttons on the guest's phone.</small>
            </span>
            {!canManage && <SwitchState on={form.callsEnabled} />}
          </label>

          <label className="field">
            <span>Note shown at the top of the guest menu</span>
            <input
              value={form.guestNote}
              maxLength={200}
              disabled={!canManage}
              placeholder="e.g. Kitchen closes at 11 pm · Happy hours 4–7 pm"
              onChange={(event) => setForm({ ...form, guestNote: event.target.value })}
            />
          </label>

          {canPreview && tables.length > 0 && (
            <div className="tr-preview">
              <span>
                <strong>See what guests see</strong>
                <small>Opens the guest menu for a table, exactly as its QR code does.</small>
              </span>
              <div className="tr-preview-row">
                <select value={tableToken} onChange={(event) => setTableToken(event.target.value)} aria-label="Table">
                  {tables.map((table) => (
                    <option key={table.id} value={table.qrToken}>
                      Table {table.tableNo}
                      {table.floorName ? ` · ${table.floorName}` : ""}
                    </option>
                  ))}
                </select>
                <a className="button button-secondary" href={`${customerWebOrigin()}/order/${tableToken}`} target="_blank" rel="noreferrer">
                  <Icon name="external" size={15} /> Open guest menu
                </a>
              </div>
            </div>
          )}

          <ErrorMessage message={error} />

          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              {canManage ? "Cancel" : "Close"}
            </button>
            {canManage && (
              <button type="button" className="button" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- the page

export default function TableRequestsPage() {
  const { user, hasPermission } = useAuth();
  // The outlet this person works in (tied to it, or the switcher on it).
  const workingOutlet = user.outletId || outletStorage.get() || null;
  const canAct = hasPermission("orders.create");
  const canManage = hasPermission("orders.manage");
  const canOpenPos = hasPermission("orders.create");
  const canPreview = hasPermission("tables.view");
  const canReadSettings = hasPermission("restaurant.settings.view");

  const [view, setView] = useQueryFilter("view", "pending");
  const activeView =
    view === "all" ? "history" : VIEWS.some((option) => option.key === view) ? view : "pending";
  // Today and Earlier days are data grids; Waiting is the board of cards.
  const inGrid = activeView !== "pending";
  // Bumped after every action, so the grids reload too.
  const [version, setVersion] = useState(0);
  const [lane, setLane] = useState("orders");

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastLoaded, setLastLoaded] = useState(null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [currency, setCurrency] = useState("₹");

  const [busy, setBusy] = useState({});
  const [cardErrors, setCardErrors] = useState({});
  const [flash, setFlash] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [rejectError, setRejectError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sound, setSound] = useState(readSound);

  const seen = useRef(null);
  const [freshSince, setFreshSince] = useState({});
  const soundRef = useRef(sound);

  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  // The live part: what is waiting now (the board of cards, the counts on
  // the column switch and the chime for a new arrival, whichever view is on
  // show) and today's figures. Today and Earlier days load their own pages
  // (RequestGrid).
  const load = useCallback(
    () =>
      Promise.all([listTableRequests({ view: "pending", limit: 200 }), getTableRequestSummary()])
        .then(([page, figures]) => {
          const arrived = Date.now();
          const waiting = page.items.filter((request) => OPEN.includes(request.status));
          const newOnes = seen.current ? waiting.filter((request) => !seen.current.has(request.id)) : [];

          if (!seen.current) {
            seen.current = new Set();
          }

          for (const request of waiting) {
            seen.current.add(request.id);
          }

          if (newOnes.length > 0) {
            setFreshSince((current) => {
              const next = { ...current };
              for (const request of newOnes) next[request.id] = arrived;
              return next;
            });

            if (soundRef.current) {
              playChime();
            }
          }

          setItems(page.items);
          setTotal(page.total);
          setSummary(figures);
          // Timers run on the server's clock: a tablet five minutes slow
          // must not make a guest look five minutes more patient.
          setOffset(new Date(page.serverTime).getTime() - arrived);
          setLastLoaded(arrived);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live: a guest's order or call, and every answer to one from another
  // device, shows within a second (live updates). As a safety net the inbox
  // also reads itself every minute, and at once on coming back to the tab.
  const live = useLiveRefresh({ restaurant: true }, ["table_request", "order"], load);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // The currency symbol lives in the restaurant settings, which a captain may
  // not read; asking anyway would only put a refused request in the console.
  useEffect(() => {
    if (!canReadSettings) {
      return;
    }

    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol || "₹"))
      .catch(() => undefined);
  }, [canReadSettings]);

  useEffect(() => {
    if (!flash) {
      return undefined;
    }

    const timer = setTimeout(() => setFlash(null), 9000);
    return () => clearTimeout(timer);
  }, [flash]);

  const serverNow = now + offset;

  // A captain's own tables first; everyone still sees every request.
  const myUserId = user ? user.id : null;
  const mineFirst = useCallback(
    (list) =>
      myUserId
        ? [...list.filter((request) => request.captain && request.captain.userId === myUserId),
           ...list.filter((request) => !(request.captain && request.captain.userId === myUserId))]
        : list,
    [myUserId]
  );
  const orders = useMemo(() => mineFirst(items.filter((request) => request.type === "order")), [items, mineFirst]);
  const calls = useMemo(() => mineFirst(items.filter((request) => request.type !== "order")), [items, mineFirst]);
  const openOrders = orders.filter((request) => OPEN.includes(request.status)).length;
  const openCalls = calls.filter((request) => OPEN.includes(request.status)).length;

  // ---------------------------------------------------------------- actions

  const setCardBusy = (id, value) =>
    setBusy((current) => {
      const next = { ...current };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });

  const setCardError = (id, message) =>
    setCardErrors((current) => {
      const next = { ...current };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const run = async (request, kind, call) => {
    setCardBusy(request.id, kind);
    setCardError(request.id, null);

    try {
      const response = await call();
      setFlash({
        text: response.message,
        orderId: kind === "accept" ? response.data.order.id : null,
      });
    } catch (err) {
      setCardError(request.id, getErrorMessage(err));
    } finally {
      setCardBusy(request.id, null);
      setVersion((current) => current + 1);
      load();
    }
  };

  const accept = (request) => run(request, "accept", () => acceptTableRequest(request.id));
  const acknowledge = (request) => run(request, "acknowledge", () => acknowledgeTableRequest(request.id));
  const done = (request) => run(request, "done", () => completeTableRequest(request.id));

  const openReject = (request) => {
    setRejecting(request);
    setRejectError("");
  };

  const confirmReject = async (reason) => {
    setRejectError("");
    setCardBusy(rejecting.id, "reject");

    try {
      const response = await rejectTableRequest(rejecting.id, reason);
      setFlash({ text: response.message, orderId: null });
      setCardError(rejecting.id, null);
      setRejecting(null);
    } catch (err) {
      setRejectError(getErrorMessage(err));
    } finally {
      setCardBusy(rejecting.id, null);
      setVersion((current) => current + 1);
      load();
    }
  };

  const toggleSound = () => {
    const next = !sound;

    if (next) {
      unlockChime();
      playChime();
    }

    setSound(next);
    writeSound(next);
  };

  // ---------------------------------------------------------------- render

  const secondsAgo = lastLoaded ? Math.max(0, Math.round((now - lastLoaded) / 1000)) : null;
  const oldestOrder = summary && summary.oldestOrderAt ? serverNow - new Date(summary.oldestOrderAt).getTime() : 0;
  const oldestCall = summary && summary.oldestCallAt ? serverNow - new Date(summary.oldestCallAt).getTime() : 0;
  const isFresh = (id) => freshSince[id] && now - freshSince[id] < FRESH_FOR;

  const callBreakdown = summary
    ? [
        summary.openCallsByType.bill > 0 && `${summary.openCallsByType.bill} bill`,
        summary.openCallsByType.water > 0 && `${summary.openCallsByType.water} water`,
        summary.openCallsByType.call_waiter > 0 && `${summary.openCallsByType.call_waiter} waiter`,
        summary.openCallsByType.other > 0 && `${summary.openCallsByType.other} other`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const emptyOrders = {
    message: "No orders waiting",
    hint:
      "When a guest orders from the QR code on their table, or from your online ordering page, it lands here" +
      (sound ? " with a chime." : "."),
  };

  const emptyCalls = {
    message: "Nobody is waiting",
    hint: "Calls for a waiter, the bill or water from guests' phones land here.",
  };

  return (
    <div className="stack tr-page">
      <PageHeader
        icon="bell"
        title="Table requests"
        description="Orders and calls from guests' phones — table QR codes and your online ordering page. Nothing is cooked until you accept an order."
        action={
          <div className="tr-header-actions">
            <span className={`tr-live ${error || live === "reconnecting" ? "is-down" : ""}`} role="status" data-live={live}>
              <span className="tr-live-dot" />
              {error
                ? "Offline — retrying"
                : secondsAgo === null
                  ? "Connecting…"
                  : `${live === "live" ? "Live" : live === "reconnecting" ? "Reconnecting" : live === "off" ? "Not live" : "Connecting"} · ${secondsAgo}s ago`}
            </span>
            <button
              type="button"
              className={`button button-secondary tr-icon-button ${sound ? "is-on" : ""}`}
              onClick={toggleSound}
              aria-pressed={sound}
              title={sound ? "Chime on for new requests" : "Chime off"}
            >
              <Glyph name={sound ? "bell" : "bell-off"} size={16} />
              <span>{sound ? "Sound on" : "Sound off"}</span>
            </button>
            <button
              type="button"
              className="button button-secondary tr-icon-button"
              onClick={() => setSettingsOpen(true)}
              aria-label="QR ordering settings"
              title="QR ordering settings"
            >
              <Icon name="qr" size={16} />
              <span>QR ordering</span>
            </button>
          </div>
        }
      />

      {summary && (
        <div className="stat-grid tr-stats">
          <StatTile
            icon="utensils"
            tone={
              summary.pendingOrders === 0
                ? "neutral"
                : tone(oldestOrder, ORDER_WARN_MIN, ORDER_LATE_MIN) === "late"
                  ? "danger"
                  : "warning"
            }
            value={count(summary.pendingOrders)}
            label="Orders waiting"
            note={summary.pendingOrders > 0 ? `Oldest ${clock(oldestOrder)}` : "All answered"}
          />
          <StatTile
            icon="bell"
            tone={
              summary.openCalls === 0
                ? "neutral"
                : tone(oldestCall, CALL_WARN_MIN, CALL_LATE_MIN) === "late"
                  ? "danger"
                  : "info"
            }
            value={count(summary.openCalls)}
            label="Tables calling"
            note={summary.openCalls > 0 ? callBreakdown : `${count(summary.callsDoneToday)} answered today`}
          />
          <StatTile
            icon="check-circle"
            tone="success"
            value={count(summary.acceptedToday)}
            label="Guest orders accepted"
            note={
              // The rupee value is sent only to people who may see sales
              // figures; everyone else sees how many were ordered.
              typeof summary.acceptedValueToday === "number"
                ? `${money(summary.acceptedValueToday, currency)} est. today`
                : `of ${count(summary.ordersToday)} ordered today`
            }
          />
          <StatTile
            icon="clock"
            tone="neutral"
            value={summary.avgResponseSeconds === null ? "—" : took(summary.avgResponseSeconds)}
            label="Average response"
            note="today, to first action"
          />
          <StatTile
            icon="x-circle"
            tone={summary.rejectedToday > 0 ? "danger" : "neutral"}
            value={count(summary.rejectedToday)}
            label="Rejected today"
            note={`of ${plural(summary.ordersToday, "guest order", "guest orders")} today`}
          />
        </div>
      )}

      {flash && (
        <div className="alert alert-success tr-flash" role="status">
          <Icon name="check" size={16} />
          <span>{flash.text}</span>
          {flash.orderId && canOpenPos && (
            <Link to={`/pos?order=${flash.orderId}`} className="tr-link">
              Open in POS <Icon name="external" size={13} />
            </Link>
          )}
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setFlash(null)}>
            <Icon name="x" size={16} />
          </button>
        </div>
      )}

      <ErrorMessage message={error && !loading && items.length > 0 ? "" : error} />

      <div className="tr-toolbar">
        <div className="segmented" role="tablist" aria-label="Show">
          {VIEWS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={activeView === option.key}
              className={`segment ${activeView === option.key ? "is-active" : ""}`}
              onClick={() => setView(option.key)}
            >
              {option.label}
              {option.key === "pending" && summary && summary.pendingOrders + summary.openCalls > 0 && (
                <span className="tr-count">{summary.pendingOrders + summary.openCalls}</span>
              )}
            </button>
          ))}
        </div>

        {!inGrid && (
        <div className="segmented tr-lanes" role="tablist" aria-label="Column">
          <button
            type="button"
            role="tab"
            aria-selected={lane === "orders"}
            className={`segment ${lane === "orders" ? "is-active" : ""}`}
            onClick={() => setLane("orders")}
          >
            Orders <span className="tr-count">{openOrders}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lane === "calls"}
            className={`segment ${lane === "calls" ? "is-active" : ""}`}
            onClick={() => setLane("calls")}
          >
            Calls <span className="tr-count">{openCalls}</span>
          </button>
        </div>
        )}

        <p className="muted small tr-toolbar-note">
          {activeView === "history"
            ? "Earlier business days, newest first · today's are under Waiting and Today"
            : activeView === "today"
              ? "Since the day opened · waiting ones first · new ones appear by themselves"
              : total > items.length
                ? `Longest waiting first · ${count(items.length)} of ${count(total)} waiting shown`
                : "Longest waiting first · new ones appear by themselves"}
        </p>
      </div>

      {inGrid ? (
        <RequestGrid
          key={activeView}
          mode={activeView}
          refreshKey={activeView === "today" ? `${version}:${lastLoaded}` : version}
          busy={busy}
          cardErrors={cardErrors}
          canAct={canAct}
          canOpenPos={canOpenPos}
          currency={currency}
          onAccept={accept}
          onReject={openReject}
          onAcknowledge={acknowledge}
          onDone={done}
        />
      ) : loading ? (
        <Loading />
      ) : (
        <div className={`tr-board show-${lane}`}>
          <section className="tr-lane tr-lane-orders" aria-labelledby="tr-orders-title">
            <header className="tr-lane-head">
              <span className="tr-lane-icon is-orders">
                <Icon name="utensils" size={18} />
              </span>
              <div>
                <h2 id="tr-orders-title">Orders</h2>
                <p className="muted small">
                  From tables and your online page. Check the dishes, then accept — it goes to the kitchen and the bill.
                </p>
              </div>
              <span className="tr-lane-count">{openOrders}</span>
            </header>
            {orders.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon="utensils"
                  message={emptyOrders.message}
                  hint={emptyOrders.hint}
                  action={
                    canPreview ? (
                      <Link to="/tables?print=qr" className="button button-secondary">
                        <Icon name="qr" size={16} /> Print table QR codes
                      </Link>
                    ) : null
                  }
                />
              </div>
            ) : (
              <div className="tr-cards">
                {orders.map((request) => (
                  <OrderCard
                    key={request.id}
                    request={request}
                    now={serverNow}
                    busy={busy[request.id]}
                    error={cardErrors[request.id]}
                    fresh={isFresh(request.id)}
                    canAct={canAct}
                    canOpenPos={canOpenPos}
                    currency={currency}
                    workingOutlet={workingOutlet}
                    onAccept={accept}
                    onReject={openReject}
                    myUserId={myUserId}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="tr-lane tr-lane-calls" aria-labelledby="tr-calls-title">
            <header className="tr-lane-head">
              <span className="tr-lane-icon is-calls">
                <Icon name="bell" size={18} />
              </span>
              <div>
                <h2 id="tr-calls-title">Calls from tables</h2>
                <p className="muted small">Tap “On my way” so the guest sees someone is coming.</p>
              </div>
              <span className="tr-lane-count">{openCalls}</span>
            </header>
            {calls.length === 0 ? (
              <div className="card">
                <EmptyState icon="bell" message={emptyCalls.message} hint={emptyCalls.hint} />
              </div>
            ) : (
              <div className="tr-cards">
                {calls.map((request) => (
                  <CallCard
                    key={request.id}
                    request={request}
                    now={serverNow}
                    busy={busy[request.id]}
                    error={cardErrors[request.id]}
                    fresh={isFresh(request.id)}
                    canOpenPos={canOpenPos}
                    onAcknowledge={acknowledge}
                    onDone={done}
                    myUserId={myUserId}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {rejecting && (
        <RejectDialog
          key={rejecting.id}
          request={rejecting}
          failure={cardErrors[rejecting.id]}
          busy={busy[rejecting.id] === "reject"}
          error={rejectError}
          onReject={confirmReject}
          onClose={() => setRejecting(null)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          canManage={canManage}
          canPreview={canPreview}
          onClose={() => setSettingsOpen(false)}
          onSaved={(message) => {
            setSettingsOpen(false);
            setFlash({ text: message, orderId: null });
          }}
        />
      )}
    </div>
  );
}
