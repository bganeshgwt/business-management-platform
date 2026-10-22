import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../../components/DataGrid/DataGrid";
import { listOrders } from "../../../orders/services/order.service";
import { listTables } from "../../../tables/services/table.service";
import CancelOrderDialog from "../../../orders/pages/CancelOrderDialog";
import { count, dateShort, money, moneyExact } from "@bmp/shared/format";
import { clock12, floorCounts, waitText } from "../liveFormat";
import { PanelFacts, PanelMessage } from "./panelKit";
import { errorText, minutesAgo, refreshDashboard, usePaging, usePanelQuery } from "./panelData";
import { useFloorActions } from "./floorActions";
import FloorActionButtons from "./FloorActionButtons";

const TYPE = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };

const earlierBadge = (at) => (
  <span className="badge badge-warning status-badge dash-earlier-badge" title="Taken on an earlier business day and never closed">
    <span className="badge-dot" aria-hidden="true" />
    Left open since {dateShort(at)}
  </span>
);

// Running orders. Tonight's by default (the live screens show today), the
// oldest first so a stuck order is never under a fresh one; orders left open
// from earlier days have their own view, with Bill and Cancel.
export function RunningOrdersPanel({ ctx, view = "today" }) {
  const { data, currency, canSeeSales, hasPermission } = ctx;
  const navigate = useNavigate();
  const paging = usePaging();
  const [cancelling, setCancelling] = useState(null);
  const [message, setMessage] = useState(null);
  const age = view === "earlier" ? "earlier" : view === "all" ? undefined : "today";
  const params = {
    status: "open",
    sort: "oldest",
    ...(age ? { age } : {}),
    limit: paging.pageSize,
    offset: (paging.page - 1) * paging.pageSize,
  };
  const query = usePanelQuery("running-orders", params, () => listOrders(params), { keepPrevious: true });
  const page = query.data;
  // Ages are worked out against when the list was read.
  const now = query.dataUpdatedAt;
  const earlier = data.openOrdersEarlier || { count: 0 };
  const canOpen = hasPermission("orders.create");
  const canBill = canOpen && hasPermission("billing.manage");
  const canCancel = hasPermission("orders.manage");

  return (
    <>
      <PanelFacts
        items={[
          { label: "Tonight", value: count(Math.max(0, data.openOrders - earlier.count)) },
          earlier.count > 0 && { label: "From earlier days", value: count(earlier.count), tone: "warning" },
          page && page.summary && { label: "At tables", value: count(page.summary.onTables) },
          page && page.summary && { label: "Takeaway & other", value: count(page.summary.other) },
          canSeeSales && page && page.summary && { label: "Value", value: money(page.summary.amount, currency) },
        ]}
      />
      {view === "earlier" && earlier.count > 0 && (
        <p className="panel-note">
          Orders taken on an earlier business day and never closed. Bill the ones the guests paid for, cancel the
          rest (with a reason) so tonight&apos;s floor and figures are right.
        </p>
      )}
      <PanelMessage message={message && message.text} tone={message && message.tone} onDismiss={() => setMessage(null)} />
      <DataGrid
        id={`dash-panel-running-orders-${view}`}
        caption="Running orders"
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
                {order.tokenNo && <span className="muted">Token {order.tokenNo}</span>}
                {order.earlierDay && earlierBadge(order.placedAt)}
              </span>
            ),
          },
          {
            key: "where",
            header: "Where",
            value: (order) => (order.tableNo ? `Table ${order.tableNo}` : TYPE[order.orderType] || order.orderType),
            render: (order) => (
              <span className="panel-cell-stack">
                <span>{order.tableNo ? `Table ${order.tableNo}` : TYPE[order.orderType] || order.orderType}</span>
                {order.customerName && <span className="muted">{order.customerName}</span>}
              </span>
            ),
            mobile: "subtitle",
          },
          { key: "guests", header: "Guests", type: "number", value: (order) => order.guestCount || null },
          {
            key: "age",
            header: "Running for",
            value: (order) => minutesAgo(order.placedAt, now),
            render: (order) => waitText(minutesAgo(order.placedAt, now)),
            align: "right",
            mobile: "show",
          },
          { key: "dishes", header: "Dishes", type: "number", value: (order) => order.dishCount },
          canSeeSales && {
            key: "total",
            header: "Value",
            type: "money",
            exact: true,
            value: (order) => order.totalAmount,
            mobile: "show",
          },
          (canOpen || canCancel) && {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (order) => (
              <FloorActionButtons
                tableId={order.id}
                menuLabel="More for this order"
                busy={null}
                actions={[
                  canBill && order.earlierDay && { key: "bill", label: "Bill", primary: true, onClick: () => navigate(`/pos?order=${order.id}&bill=1`) },
                  canOpen && { key: "open", label: "Open", primary: !(order.earlierDay && canBill), onClick: () => navigate(`/pos?order=${order.id}`) },
                  canBill && !order.earlierDay && { key: "bill", label: "Bill", onClick: () => navigate(`/pos?order=${order.id}&bill=1`) },
                  canCancel && order.earlierDay && !order.billId && { key: "cancel", label: "Cancel order", danger: true, onClick: () => setCancelling(order) },
                ].filter(Boolean)}
              />
            ),
          },
        ]}
        rows={page ? page.items : []}
        loading={!page && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty={view === "earlier" ? "Nothing left open from earlier days" : "No orders running"}
        emptyIcon="utensils"
        currency={currency}
        rowNoun={["order", "orders"]}
        rowClassName={(order) => (order.earlierDay ? "dg-tone-warning" : "")}
        server={{
          total: page ? page.total : 0,
          page: paging.page,
          pageSize: paging.pageSize,
          onChange: paging.onChange,
        }}
      />
      {cancelling &&
        createPortal(
          <CancelOrderDialog
            order={cancelling}
            onClose={() => setCancelling(null)}
            onCancelled={(updated, slipNote) => {
              setCancelling(null);
              setMessage({ tone: "success", text: `${updated ? updated.orderNumber : "The order"} was cancelled.${slipNote ? ` ${slipNote}` : ""}` });
              refreshDashboard();
            }}
          />,
          document.body
        )}
    </>
  );
}

// The floor plan's states, in its own words.
const STATES = {
  running: { label: "Eating", tone: "info" },
  printed: { label: "Bill printed", tone: "warning" },
  paid: { label: "Paid, still seated", tone: "success" },
  reserved: { label: "Held for a booking", tone: "violet" },
  cleaning: { label: "Being cleaned", tone: "warning" },
  free: { label: "Free", tone: "neutral" },
  out_of_service: { label: "Out of service", tone: "neutral" },
};

const FLOOR_VIEWS = [
  { key: "busy", label: "In use", states: ["running", "printed", "paid"] },
  { key: "pay", label: "To pay", states: ["printed"] },
  { key: "free", label: "Free", states: ["free"] },
  { key: "reserved", label: "Held", states: ["reserved"] },
  { key: "cleaning", label: "Cleaning", states: ["cleaning"] },
  { key: "all", label: "All tables", states: null },
];

// Who needs someone first: a bill waiting to be paid, a table to reset, a
// party due, then the longest-seated; free tables after, switched-off last.
const PRIORITY = ["printed", "cleaning", "reserved", "running", "paid", "free", "out_of_service"];

const sortForAction = (tables) =>
  [...tables].sort((a, b) => {
    const left = PRIORITY.indexOf(a.floorState || "free");
    const right = PRIORITY.indexOf(b.floorState || "free");

    if (left !== right) {
      return left - right;
    }

    const since = (table) => (table.live && table.live.placedAt ? new Date(table.live.placedAt).getTime() : Infinity);

    return since(a) - since(b);
  });

// What is going on at the table, in one short line.
const detailOf = (table, now) => {
  const live = table.live;
  const state = table.floorState || "free";

  if (live && ["running", "printed", "paid"].includes(state)) {
    const parts = [live.orderNumber, waitText(minutesAgo(live.placedAt, now))];

    if (live.joinedTo) {
      parts.push(`with ${live.joinedTo}`);
    }

    return parts.filter(Boolean).join(" · ");
  }

  if (state === "reserved" && table.booking) {
    return `${clock12(table.booking.startTime)} · ${table.booking.guestName} · ${table.booking.partySize}`;
  }

  if (state === "cleaning" && table.turn) {
    return table.turn.minutesLeft > 0 ? `ready in ${table.turn.minutesLeft} min` : "due to be ready";
  }

  if (state === "out_of_service") {
    return table.outOfServiceReason === "floor" ? "floor closed" : table.outOfServiceReason === "area" ? "area closed" : "switched off";
  }

  return "";
};

// The floor: the tables the Floor card and the Tables-in-use tile count, by
// the same states, each with what can be done about it right here.
export function FloorPanel({ ctx, view }) {
  const { data, currency, canSeeSales } = ctx;
  // Guests and money on the table: "4 of 6 seated · ₹871.50", "₹323.00 due".
  const money2 = (table) => {
    const live = table.live;

    if (!live || !["running", "printed", "paid"].includes(table.floorState)) {
      return "";
    }

    const seated = live.guestCount ? `${count(live.guestCount)} of ${count(table.capacity)} seated` : null;
    const value = !canSeeSales
      ? null
      : table.floorState === "printed" && live.billDue !== null
        ? `${moneyExact(live.billDue, currency)} due`
        : moneyExact(live.orderTotal, currency);

    return [seated, value].filter(Boolean).join(" · ");
  };
  const query = usePanelQuery("tables", null, () => listTables());
  const actions = useFloorActions(ctx);
  const tables = query.data || null;
  const now = query.dataUpdatedAt;
  const mine = tables ? (data.outletId ? tables.filter((table) => table.outletId === data.outletId) : tables) : null;
  const floor = mine ? floorCounts(mine, null) : null;
  const chosen = FLOOR_VIEWS.find((one) => one.key === view) || FLOOR_VIEWS[0];
  const rows = mine
    ? sortForAction(mine.filter((table) => (chosen.states ? chosen.states.includes(table.floorState || "free") : true)))
    : [];
  const earlier = mine ? mine.filter((table) => table.live && table.live.earlierDay).length : 0;
  const anyActions = rows.some((table) => actions.actionsFor(table).length > 0);

  return (
    <>
      {floor && (
        <PanelFacts
          chips
          items={[
            { label: "In use", value: `${count(floor.busy)} / ${count(floor.inService)}` },
            { label: "To pay", value: count(floor.printed), tone: floor.printed > 0 ? "warning" : null },
            { label: "Free", value: count(floor.free) },
            { label: "Held", value: count(floor.reserved) },
            { label: "Cleaning", value: count(floor.cleaning), tone: floor.cleaning > 0 ? "warning" : null },
            floor.busy > 0 && { label: "Guests", value: count(floor.guests) },
            earlier > 0 && { label: "Left open", value: count(earlier), tone: "danger" },
          ]}
        />
      )}
      {earlier > 0 && (chosen.key === "busy" || chosen.key === "all") && (
        <p className="panel-note dash-earlier-note">
          {earlier === 1 ? "One table has" : `${count(earlier)} tables have`} an order from an earlier business day that
          was never billed or closed. Bill it, or cancel it with a reason.
        </p>
      )}
      <PanelMessage
        message={actions.message && actions.message.text}
        tone={actions.message && actions.message.tone}
        onDismiss={actions.clearMessage}
      />
      <DataGrid
        id={`dash-panel-floor-${chosen.key}`}
        caption={`Tables: ${chosen.label}`}
        variant="compact"
        columns={[
          {
            key: "table",
            header: "Table",
            value: (table) => table.tableNo,
            mobile: "title",
            render: (table) => (
              <span className="panel-cell-stack">
                <strong>{table.tableNo}</strong>
                <span className="muted">{[table.floorName, table.areaName].filter(Boolean).join(" · ")}</span>
              </span>
            ),
          },
          {
            key: "state",
            header: "State",
            value: (table) => table.floorState || "free",
            render: (table) => {
              const state = STATES[table.floorState || "free"] || { label: table.floorState, tone: "neutral" };
              const detail = detailOf(table, now);

              return (
                <span className="panel-cell-stack">
                  <span className={`badge badge-${state.tone} status-badge`}>
                    <span className="badge-dot" aria-hidden="true" />
                    {state.label}
                  </span>
                  {detail && <span className="muted">{detail}</span>}
                  {money2(table) && <span className="dash-table-money">{money2(table)}</span>}
                  {table.live && table.live.earlierDay && (
                    <span className="dash-earlier-text">Left open since {dateShort(table.live.placedAt)}</span>
                  )}
                </span>
              );
            },
            mobile: "subtitle",
          },
          anyActions && {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (table) => (
              <FloorActionButtons actions={actions.actionsFor(table)} busy={actions.busy} tableId={table.id} />
            ),
          },
        ]}
        rows={rows}
        rowKey={(table) => table.id}
        onRowClick={(table) => {
          const own = actions.actionsFor(table).find((action) => action.primary);

          if (own) {
            own.onClick();
          }
        }}
        rowClassName={(table) =>
          table.live && table.live.earlierDay ? "dg-tone-warning" : table.floorState === "out_of_service" ? "dg-tone-muted" : ""
        }
        loading={!tables && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty={
          chosen.key === "busy"
            ? "No table is in use"
            : chosen.key === "pay"
              ? "No table is waiting to pay"
              : "No tables in this state"
        }
        emptyIcon="table"
        rowNoun={["table", "tables"]}
        search={chosen.key === "all"}
      />
      {actions.dialogs}
    </>
  );
}
