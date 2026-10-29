import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../../components/DataGrid/DataGrid";
import { clearOldTickets, getBoard as getKitchenBoard, getKitchenDay, setTicketStatus } from "../../../kitchen/services/kitchen.service";
import { getDeliveryBoard, setDeliveryStatus } from "../../../deliveries/services/delivery.service";
import RiderModal from "../../../deliveries/pages/RiderModal";
import {
  acceptTableRequest,
  acknowledgeTableRequest,
  completeTableRequest,
  listTableRequests,
  rejectTableRequest,
} from "../../../orders/services/tableRequest.service";
import { getErrorMessage } from "../../../../../services/api";
import { count, money } from "@bmp/shared/format";
import { minutesFrom, waitText } from "../liveFormat";
import { PanelFacts, PanelMessage } from "./panelKit";
import { errorText, refreshDashboard, usePanelQuery } from "./panelData";

const badge = (label, tone) => (
  <span className={`badge badge-${tone} status-badge`}>
    <span className="badge-dot" aria-hidden="true" />
    {label}
  </span>
);

// ------------------------------------------------------------------ kitchen

const TICKET = { new: ["New", "info"], cooking: ["Cooking", "warning"], ready: ["Ready", "success"] };

const ticketFor = (ticket) =>
  ticket.tableNo ? `Table ${ticket.tableNo}` : ticket.tokenNo ? `Token ${ticket.tokenNo}` : ticket.orderNumber;

const dishesOf = (ticket) =>
  (ticket.items || [])
    .filter((item) => Number(item.liveQuantity ?? item.quantity) > 0)
    .map((item) => `${item.liveQuantity ?? item.quantity} × ${item.kitchenName || item.name}`)
    .join(", ");


// The kitchen's tickets as the dashboard counts them: today's open tickets at
// this outlet, late once they are not ready `lateMinutes` after they were
// sent. Someone who may run the kitchen (kot.manage) can bump one to ready
// here, and a manager (kot.manage + orders.manage) can clear tickets left
// open for hours or from earlier days in one go.
export function KitchenPanel({ ctx, view }) {
  return view === "day" ? <KitchenDayPanel ctx={ctx} /> : <KitchenNowPanel ctx={ctx} view={view} />;
}

// "19:05" on the restaurant's clock (the browser's own zone when unknown).
const clockAt = (value, timeZone) =>
  value ? new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }) : "—";

// Minutes between two moments, or null.
const minutesBetween = (from, to) => (from && to ? Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000)) : null);

const DONE = {
  served: ["Served", "success"],
  cancelled: ["Cancelled", "neutral"],
  new: ["New", "info"],
  cooking: ["Cooking", "warning"],
  ready: ["Ready", "success"],
};

// An earlier day's tickets, read only: the day chosen (yesterday to start,
// on the restaurant's calendar), each ticket with when it was sent, ready and
// served, and the day's figures as the kitchen display counted them. Nothing
// here moves a ticket.
function KitchenDayPanel({ ctx }) {
  const kitchen = ctx.live ? ctx.live.kitchen : null;
  const timeZone = ctx.data && ctx.data.timezone ? ctx.data.timezone : undefined;
  const today = (kitchen && kitchen.businessDate) || (ctx.data && ctx.data.businessDate) || new Date().toLocaleDateString("en-CA", timeZone ? { timeZone } : {});
  const [date, setDate] = useState(() => {
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10);
  });
  const query = usePanelQuery("kitchen-day", date, () => getKitchenDay(date), { keepPrevious: true });
  const day = query.data && query.data.date === date ? query.data : null;
  const lateMinutes = day ? day.settings.lateMinutes : 20;
  const lateAt = (ticket) =>
    ticket.status !== "cancelled" && (minutesBetween(ticket.createdAt, ticket.readyAt || (ticket.clearedReason ? ticket.servedAt : null)) ?? 0) > lateMinutes;

  return (
    <>
      <label className="field dash-panel-day">
        <span>Day</span>
        <input type="date" value={date} max={today} onChange={(event) => event.target.value && setDate(event.target.value)} />
      </label>
      {day && day.stats && (
        <PanelFacts
          items={[
            { label: "Tickets", value: count(day.stats.totalCount) },
            { label: "Average ticket time", value: day.stats.timedCount > 0 ? `${Math.round(day.stats.avgReadySeconds / 60)} min` : "—" },
            { label: `Late (over ${lateMinutes} min)`, value: count(day.stats.lateCount), tone: day.stats.lateCount > 0 ? "danger" : null },
            { label: "Cleared unserved", value: count(day.stats.clearedCount) },
          ]}
        />
      )}
      {day && day.more && (
        <PanelMessage tone="info" message="The day had more tickets than this list shows: the Kitchen stations report reads them all." />
      )}
      <DataGrid
        id="dash-panel-kitchen-day"
        caption={`Kitchen tickets of ${date}`}
        variant="compact"
        columns={[
          {
            key: "ticket",
            header: "Ticket",
            value: (ticket) => ticket.kotNo,
            mobile: "title",
            render: (ticket) => (
              <span className="panel-cell-stack">
                <strong>{ticket.kotNo}</strong>
                <span className="muted">{[ticketFor(ticket), ticket.stationName, ticket.courseName].filter(Boolean).join(" · ")}</span>
              </span>
            ),
          },
          { key: "dishes", header: "Dishes", value: dishesOf, render: (ticket) => <span className="small">{dishesOf(ticket)}</span> },
          { key: "sent", header: "Sent", value: (ticket) => ticket.createdAt, render: (ticket) => clockAt(ticket.createdAt, timeZone), mobile: "show" },
          { key: "ready", header: "Ready", value: (ticket) => ticket.readyAt || "", render: (ticket) => clockAt(ticket.readyAt, timeZone) },
          {
            key: "took",
            header: "Sent to ready",
            align: "right",
            value: (ticket) => minutesBetween(ticket.createdAt, ticket.readyAt) ?? -1,
            render: (ticket) => {
              const took = minutesBetween(ticket.createdAt, ticket.readyAt);
              return took === null ? "—" : waitText(took);
            },
            mobile: "show",
          },
          { key: "served", header: "Served", value: (ticket) => ticket.servedAt || "", render: (ticket) => clockAt(ticket.servedAt, timeZone) },
          {
            key: "status",
            header: "How it ended",
            value: (ticket) => ticket.status,
            render: (ticket) =>
              ticket.clearedReason
                ? badge("Cleared unserved", "warning")
                : badge(...(DONE[ticket.status] || [ticket.status, "neutral"])),
          },
        ]}
        rows={day ? day.tickets : []}
        rowKey={(ticket) => ticket.id}
        rowClassName={(ticket) => (lateAt(ticket) ? "dg-tone-danger" : ticket.status === "cancelled" ? "dg-tone-muted" : "")}
        defaultSort={{ key: "sent", direction: "asc" }}
        loading={!day && (query.isLoading || query.isFetching)}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty="No kitchen ticket that day"
        emptyIcon="chef"
        rowNoun={["ticket", "tickets"]}
        search={false}
      />
    </>
  );
}

function KitchenNowPanel({ ctx, view }) {
  const { hasPermission } = ctx;
  const query = usePanelQuery("kitchen", null, () => getKitchenBoard());
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const board = query.data || null;
  const canBump = hasPermission("kot.manage");
  const canClear = hasPermission("kot.manage") && hasPermission("orders.manage");
  const earlier = board && board.earlierOpen ? board.earlierOpen : { count: 0 };
  const oldOnBoard = board
    ? board.tickets.filter(
        (ticket) => ["new", "cooking", "ready"].includes(ticket.status) && minutesFrom(ticket.createdAt, board.serverTime) >= 120
      ).length
    : 0;
  const toClear = oldOnBoard + Number((earlier.olderThan && earlier.olderThan[120]) || 0);

  const clearOld = async () => {
    setBusy("clear");
    setMessage(null);

    try {
      const result = await clearOldTickets({ olderThanMinutes: 120, stationId: null });
      setMessage({ tone: "success", text: result.message || "Old tickets cleared." });
      await refreshDashboard();
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };
  const lateMinutes = board ? board.settings.lateMinutes : 20;
  const now = board ? board.serverTime : 0;
  const open = board ? board.tickets.filter((ticket) => ["new", "cooking", "ready"].includes(ticket.status)) : [];
  const isLate = (ticket) =>
    ["new", "cooking"].includes(ticket.status) && minutesFrom(ticket.createdAt, now) >= lateMinutes;
  const late = open.filter(isLate);
  const rows = view === "open" ? open : late;

  const bump = async (ticket) => {
    setBusy(ticket.id);
    setMessage(null);

    try {
      await setTicketStatus(ticket.id, "ready");
      setMessage({ tone: "success", text: `${ticket.kotNo} is marked ready at the pass.` });
      await refreshDashboard();
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {board && (
        <PanelFacts
          items={[
            { label: `Late (over ${lateMinutes} min)`, value: count(late.length), tone: late.length > 0 ? "danger" : null },
            { label: "New", value: count(open.filter((ticket) => ticket.status === "new").length) },
            { label: "Cooking", value: count(open.filter((ticket) => ticket.status === "cooking").length) },
            { label: "Ready", value: count(open.filter((ticket) => ticket.status === "ready").length) },
          ]}
        />
      )}
      {toClear > 0 && (
        <div className="alert alert-notice dash-panel-cleanup">
          <span>
            {earlier.count > 0
              ? `${count(earlier.count)} ${earlier.count === 1 ? "ticket was" : "tickets were"} left open from earlier days (not counted here).`
              : `${count(oldOnBoard)} ${oldOnBoard === 1 ? "ticket has" : "tickets have"} been open over 2 hours.`}{" "}
            Most were served without anyone pressing Served.
          </span>
          {canClear && (
            <button type="button" className="button button-sm button-secondary" disabled={busy === "clear"} onClick={clearOld}>
              {busy === "clear" ? "Clearing…" : `Clear ${count(toClear)} older than 2 h`}
            </button>
          )}
        </div>
      )}
      <PanelMessage message={message && message.text} tone={message && message.tone} onDismiss={() => setMessage(null)} />
      <DataGrid
        id={`dash-panel-kitchen-${view === "open" ? "open" : "late"}`}
        caption={view === "open" ? "Open kitchen tickets" : "Late kitchen tickets"}
        variant="compact"
        columns={[
          {
            key: "ticket",
            header: "Ticket",
            value: (ticket) => ticket.kotNo,
            mobile: "title",
            render: (ticket) => (
              <span className="panel-cell-stack">
                <strong>{ticket.kotNo}</strong>
                <span className="muted">
                  {[ticketFor(ticket), ticket.stationName].filter(Boolean).join(" · ")}
                </span>
              </span>
            ),
          },
          {
            key: "dishes",
            header: "Dishes",
            value: dishesOf,
            render: (ticket) => <span className="small">{dishesOf(ticket)}</span>,
            mobile: "show",
          },
          {
            key: "waiting",
            header: "Waiting",
            value: (ticket) => minutesFrom(ticket.createdAt, now),
            render: (ticket) => waitText(minutesFrom(ticket.createdAt, now)),
            align: "right",
            mobile: "show",
          },
          {
            key: "status",
            header: "Stage",
            // Every late ticket is new or cooking: the column earns its room
            // only in the full list.
            defaultHidden: view !== "open",
            value: (ticket) => ticket.status,
            render: (ticket) => badge(...(TICKET[ticket.status] || [ticket.status, "neutral"])),
          },
          canBump && {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (ticket) =>
              ["new", "cooking"].includes(ticket.status) ? (
                <button type="button" className="button button-sm" disabled={busy === ticket.id} onClick={() => bump(ticket)}>
                  {busy === ticket.id ? "Marking…" : "Mark ready"}
                </button>
              ) : null,
          },
        ]}
        rows={rows}
        rowKey={(ticket) => ticket.id}
        rowClassName={(ticket) => (isLate(ticket) ? "dg-tone-danger" : "")}
        defaultSort={{ key: "waiting", direction: "desc" }}
        loading={!board && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty={view === "open" ? "Nothing on the pass" : "No ticket is late"}
        emptyIcon="chef"
        rowNoun={["ticket", "tickets"]}
        search={false}
      />
    </>
  );
}

// ------------------------------------------------------------------ deliveries

const DELIVERY = {
  pending: ["Waiting", "neutral"],
  preparing: ["Preparing", "info"],
  ready: ["Ready to go", "warning"],
  out_for_delivery: ["On the road", "primary"],
  delivered: ["Delivered", "success"],
  cancelled: ["Cancelled", "neutral"],
};


// Deliveries of today's business day(s), from the delivery board: late ones
// are past the promised time (slaMinutes after the order) and not delivered.
export function DeliveriesPanel({ ctx, view }) {
  const { currency, canSeeSales, hasPermission } = ctx;
  const navigate = useNavigate();
  const query = usePanelQuery("deliveries", null, () => getDeliveryBoard());
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [riderFor, setRiderFor] = useState(null);
  const canManage = hasPermission("orders.manage");
  const board = query.data || null;
  const now = board ? board.serverTime : 0;
  const sla = board ? board.slaMinutes : 45;
  const waiting = ["pending", "preparing", "ready"];
  const live = board ? board.orders.filter((order) => [...waiting, "out_for_delivery"].includes(order.status)) : [];
  // Late is tonight's: one left open from an earlier day is flagged apart.
  const isLate = (order) => !order.earlierDay && Math.round(minutesFrom(order.placedAt, now)) > sla;

  const move = async (order, status, done) => {
    setBusy(order.id);
    setMessage(null);

    try {
      const result = await setDeliveryStatus(order.id, { status });
      setMessage({ tone: "success", text: (result && result.message) || done });
      await refreshDashboard();
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  // The one action that moves this delivery on, then Open.
  const actionsFor = (order) => {
    const list = [];
    const named = order.rider || order.partnerRiderName;

    if (canManage && order.status === "ready" && !named) {
      list.push({ key: "send", label: "Send with rider", onClick: () => setRiderFor({ mode: "dispatch", orderIds: [order.id] }) });
    } else if (canManage && order.status === "ready" && named) {
      list.push({ key: "out", label: order.rider ? "Send out" : "Picked up", onClick: () => move(order, "out_for_delivery", "On the road.") });
    } else if (canManage && waiting.includes(order.status) && !named) {
      list.push({ key: "assign", label: "Assign rider", secondary: true, onClick: () => setRiderFor({ mode: "assign", delivery: order }) });
    } else if (canManage && order.status === "out_for_delivery") {
      list.push({ key: "done", label: "Delivered", onClick: () => move(order, "delivered", "Marked delivered.") });
    }

    list.push({ key: "open", label: "Open", secondary: true, onClick: () => navigate(`/deliveries?order=${order.id}`) });
    return list;
  };
  const rows = live.filter((order) =>
    view === "dispatch" ? waiting.includes(order.status) : view === "out" ? order.status === "out_for_delivery" : isLate(order)
  );
  const stats = board ? board.stats : null;

  return (
    <>
      {stats && (
        <PanelFacts
          items={[
            { label: "Late", value: count(stats.lateNow), tone: stats.lateNow > 0 ? "danger" : null },
            { label: "Late on the road", value: count(stats.lateOut) },
            { label: "Late, not out yet", value: count(stats.lateWaiting) },
            {
              label: "Riders",
              value: `${count((board.riders || []).filter((rider) => rider.active && rider.state === "free").length)} free · ${count(
                (board.riders || []).filter((rider) => rider.state === "on_run").length
              )} out`,
            },
          ]}
        />
      )}
      <PanelMessage message={message && message.text} tone={message && message.tone} onDismiss={() => setMessage(null)} />
      <DataGrid
        id={`dash-panel-deliveries-${view || "late"}`}
        caption="Deliveries"
        variant="compact"
        columns={[
          {
            key: "order",
            header: "Order",
            value: (order) => order.orderNumber,
            mobile: "title",
            render: (order) => (
              <span className="panel-cell-stack">
                <strong>{order.orderNumber}</strong>
                <span className="muted">{order.customerName || "Guest"}</span>
                {order.earlierDay && <span className="dash-earlier-text">Left open from an earlier day</span>}
              </span>
            ),
          },
          {
            key: "status",
            header: "Stage",
            value: (order) => order.status,
            render: (order) => badge(...(DELIVERY[order.status] || [order.status, "neutral"])),
            mobile: "subtitle",
          },
          {
            key: "rider",
            header: "Rider",
            value: (order) => (order.rider ? order.rider.name : order.partnerRiderName || ""),
            render: (order) =>
              order.rider ? (
                <span className="panel-cell-stack">
                  <span>{order.rider.name}</span>
                  {order.rider.mobile && <span className="muted">{order.rider.mobile}</span>}
                </span>
              ) : order.partnerRiderName ? (
                `${order.partnerRiderName} (partner)`
              ) : (
                <span className="muted">Not assigned</span>
              ),
            mobile: "show",
          },
          {
            key: "age",
            header: "Since order",
            value: (order) => minutesFrom(order.placedAt, now),
            render: (order) => waitText(minutesFrom(order.placedAt, now)),
            align: "right",
            mobile: "show",
          },
          { key: "address", header: "Address", value: (order) => order.address || "", defaultHidden: true },
          canSeeSales && { key: "amount", header: "Amount", type: "money", value: (order) => order.amount },
          {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (order) => (
              <span className="panel-row-actions">
                {actionsFor(order).map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className={`button button-sm ${action.secondary ? "button-secondary" : ""}`}
                    disabled={busy === order.id}
                    onClick={action.onClick}
                  >
                    {action.label}
                  </button>
                ))}
              </span>
            ),
          },
        ]}
        rows={rows}
        rowKey={(order) => order.id}
        rowClassName={(order) => (isLate(order) ? "dg-tone-danger" : order.earlierDay ? "dg-tone-warning" : "")}
        defaultSort={{ key: "age", direction: "desc" }}
        loading={!board && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty={view === "late" || !view ? "No delivery is running late" : "Nothing here right now"}
        emptyIcon="scooter"
        currency={currency}
        rowNoun={["delivery", "deliveries"]}
        search={false}
      />
      {stats && canSeeSales && stats.cashWithRiders > 0 && (
        <p className="panel-note">Cash with riders now: {money(stats.cashWithRiders, currency)}.</p>
      )}
      {riderFor &&
        board &&
        createPortal(
          <div className="dlv">
          <RiderModal
            mode={riderFor.mode}
            board={board}
            delivery={riderFor.delivery}
            initialOrderIds={riderFor.orderIds}
            now={new Date(board.serverTime).getTime()}
            onClose={() => setRiderFor(null)}
            onDone={(text) => {
              setRiderFor(null);
              if (text) setMessage({ tone: "success", text });
              refreshDashboard();
            }}
          />
          </div>,
          document.body
        )}
    </>
  );
}

// ------------------------------------------------------------------ table requests

const REJECT_REASONS = ["Dish sold out", "Kitchen closing", "Please ask your waiter"];

// QR orders waiting to be accepted (kind "orders"), or calls from tables (a
// waiter, the bill, water): every open one ("calls") or only those nobody has
// answered yet ("unanswered", the dashboard's count). Accepting and rejecting need orders.create, as on Table requests;
// answering a call needs only orders.view.
export function RequestsPanel({ ctx, kind }) {
  const { hasPermission, currency, canSeeSales } = ctx;
  const params = { view: "pending", type: kind === "orders" ? "order" : "service", limit: 200 };
  const query = usePanelQuery(`requests-${kind}`, params, () => listTableRequests(params));
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState("");
  const canAct = hasPermission("orders.create");
  const page = query.data || null;
  const now = page ? page.serverTime : 0;
  const rows = page
    ? page.items.filter((request) =>
        kind === "orders"
          ? ["pending", "processing"].includes(request.status)
          : kind === "unanswered"
            ? request.status === "pending"
            : ["pending", "acknowledged"].includes(request.status)
      )
    : [];

  const run = async (request, label, call) => {
    setBusy(request.id);
    setMessage(null);

    try {
      const response = await call();
      setMessage({ tone: "success", text: (response && response.message) || label });
      await refreshDashboard();
      return true;
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const reject = async (event) => {
    event.preventDefault();

    if (await run(rejecting, "Order rejected", () => rejectTableRequest(rejecting.id, reason.trim()))) {
      setRejecting(null);
      setReason("");
    }
  };

  const actions = (request) => {
    if (busy === request.id) {
      return <span className="muted small">Working…</span>;
    }

    if (kind === "orders") {
      return canAct ? (
        <span className="panel-row-actions">
          <button type="button" className="button button-sm" onClick={() => run(request, "Order accepted", () => acceptTableRequest(request.id))}>
            Accept
          </button>
          <button
            type="button"
            className="button button-secondary button-sm"
            onClick={() => {
              setRejecting(request);
              setReason("");
            }}
          >
            Reject
          </button>
        </span>
      ) : null;
    }

    return request.status === "pending" ? (
      <button type="button" className="button button-sm" onClick={() => run(request, "On the way", () => acknowledgeTableRequest(request.id))}>
        Answer
      </button>
    ) : (
      <button type="button" className="button button-secondary button-sm" onClick={() => run(request, "Done", () => completeTableRequest(request.id))}>
        Done
      </button>
    );
  };

  return (
    <>
      <PanelMessage message={message && message.text} tone={message && message.tone} onDismiss={() => setMessage(null)} />
      {rejecting && (
        <form className="card" style={{ padding: 14, display: "grid", gap: 10 }} onSubmit={reject}>
          <strong>Reject order from {rejecting.tableNo ? `table ${rejecting.tableNo}` : "the guest"}?</strong>
          <label className="field">
            <span>Reason the guest will see</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} required autoFocus />
          </label>
          <div className="panel-row-actions" style={{ justifyContent: "flex-start" }}>
            {REJECT_REASONS.map((text) => (
              <button key={text} type="button" className="chip-button" onClick={() => setReason(text)}>
                {text}
              </button>
            ))}
          </div>
          <div className="panel-row-actions">
            <button type="button" className="button button-secondary button-sm" onClick={() => setRejecting(null)}>
              Keep it
            </button>
            <button type="submit" className="button button-danger button-sm" disabled={!reason.trim() || busy === rejecting.id}>
              Reject order
            </button>
          </div>
        </form>
      )}
      <DataGrid
        id={`dash-panel-requests-${kind}`}
        caption={kind === "orders" ? "QR orders to accept" : "Table calls"}
        variant="compact"
        columns={[
          {
            key: "table",
            header: "Table",
            value: (request) => (request.tableNo ? `Table ${request.tableNo}` : request.guestName || "Guest"),
            mobile: "title",
          },
          kind === "orders"
            ? {
                key: "what",
                header: "Order",
                value: (request) =>
                  (request.items || []).map((item) => `${item.quantity} × ${item.name || item.itemName}`).join(", "),
                render: (request) => (
                  <span className="panel-cell-stack">
                    <span>{count(request.itemCount)} {request.itemCount === 1 ? "dish" : "dishes"}</span>
                    {canSeeSales && request.estimatedTotal ? <span className="muted">{money(request.estimatedTotal, currency)}</span> : null}
                  </span>
                ),
                mobile: "subtitle",
              }
            : {
                key: "what",
                header: "Asked for",
                value: (request) => request.type,
                render: (request) => ({ call_waiter: "A waiter", bill: "The bill", water: "Water" }[request.type] || request.type),
                mobile: "subtitle",
              },
          {
            key: "status",
            header: "Status",
            value: (request) => request.status,
            render: (request) =>
              request.status === "acknowledged"
                ? badge(`Answered${request.acknowledgedByName ? ` by ${request.acknowledgedByName}` : ""}`, "success")
                : badge("Waiting", "warning"),
            mobile: "show",
          },
          {
            key: "waiting",
            header: "Waiting",
            value: (request) => minutesFrom(request.createdAt, now),
            render: (request) => waitText(minutesFrom(request.createdAt, now)),
            align: "right",
            mobile: "show",
          },
          { key: "actions", header: "", label: "Actions", type: "actions", render: actions },
        ]}
        rows={rows}
        rowKey={(request) => request.id}
        loading={!page && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty={kind === "orders" ? "No QR order is waiting" : "No table is calling"}
        emptyIcon="qr"
        rowNoun={kind === "orders" ? ["order", "orders"] : ["call", "calls"]}
        defaultSort={{ key: "waiting", direction: "desc" }}
        search={false}
      />
      {kind === "orders" && !canAct && (
        <p className="panel-note">Accepting or rejecting a QR order needs the permission to take orders.</p>
      )}
    </>
  );
}
