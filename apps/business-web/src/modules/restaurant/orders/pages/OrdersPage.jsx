import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import ActionMenu from "../../../../components/ActionMenu";
import CancelOrderDialog from "./CancelOrderDialog";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import {
  cancelOrder,
  cancelOrderItem,
  getOrder,
  getServiceDay,
  listCancellations,
  listOrderMoves,
  listOrders,
  setKitchenStatus,
} from "../services/order.service";
import { getOrderTickets } from "../../kitchen/services/kitchen.service";
import { getOrderAdvances } from "../../billing/services/bill.service";
import { TakeOrderAdvance } from "../../billing/pages/AdvancesPanel";
import { printChangeSlips } from "../services/kotSlips";
import { tablesText } from "../../../../services/floorTables";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { CANCEL_REASONS, reasonLabel } from "../services/orderCart";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import { moneyExact, money, count } from "@bmp/shared/format";
import { dayMonth, today } from "@bmp/shared/dates";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { ORDER_TYPE_OPTIONS, orderTypeLabel } from "../../../../services/labels";
import "../styles/orders.css";
import "../styles/pos.css";

const STATUS_LABELS = {
  open: "Open",
  billed: "Billed",
  completed: "Completed",
  cancelled: "Cancelled",
};

// Each status as a badge tone: running now, waiting to pay, done, called off.
const STATUS_TONES = {
  open: "badge-primary",
  billed: "badge-warning",
  completed: "badge-success",
  cancelled: "badge-danger",
};

const KITCHEN_STATUSES = ["pending", "preparing", "ready", "served"];

// The whole order's kitchen state, in words.
const KITCHEN_WORDS = {
  pending: "Waiting",
  preparing: "Cooking",
  ready: "Ready",
  served: "Served",
};

const TYPE_ICONS = { dine_in: "utensils", takeaway: "box", delivery: "scooter" };

// How far the kitchen had got, in words.
const STAGE_WORDS = {
  new: "On a KOT",
  cooking: "Cooking",
  ready: "Ready",
  served: "Served",
};

const LINE_WORDS = {
  pending: "Sent",
  preparing: "Cooking",
  ready: "Ready",
  served: "Served",
  cancelled: "Cancelled",
};

const SOURCE_WORDS = { edit: "POS edit", item: "Orders screen", order: "Whole order cancelled" };

// A KOT's stage, in the kitchen's words.
const KOT_WORDS = {
  new: "Waiting",
  cooking: "Cooking",
  ready: "At the pass",
  served: "Served",
  cancelled: "Cancelled",
};

// What a move did, in a sentence: "PF1 → PF2", "PF3 joined (ORD-0004)".
const moveText = (move) => {
  if (move.type === "table") {
    return `Moved from ${move.fromTableNo} to ${move.toTableNo}`;
  }

  if (move.type === "join") {
    return `${move.fromTableNo} joined to ${move.toTableNo}${move.fromOrderNumber ? `, bringing ${move.fromOrderNumber}` : ""}`;
  }

  if (move.type === "unjoin") {
    return `${move.fromTableNo} given back`;
  }

  return `Dishes moved from ${move.fromTableNo} (${move.fromOrderNumber}) to ${move.toTableNo} (${move.toOrderNumber})`;
};

// The most the API hands back in one request (order.controller.js): the CSV
// export reads every matching order this many at a time.
const API_MAX = 500;

// "30 Sep, 7:42 pm", with the app's own month names: the browser's en-IN
// short month spells September "Sept".
const when = (value) => (value ? dayMonth(value, { time: true }) : "");

export default function OrdersPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("orders.manage");
  const canKitchen = hasPermission("kot.manage");
  // An order's KOTs are read through the kitchen, by anyone who works with
  // tickets (the till prints them, the kitchen cooks them).
  const canSeeKots = canKitchen || hasPermission("kds.view");
  const canCancelAfterKot = hasPermission("orders.cancel_after_kot");
  // The cancellations report is a theft report that names staff: it is read
  // like the activity log (audit.view), by owners and managers, not cashiers.
  const canReport = hasPermission("audit.view");

  const [view, setView] = useQueryFilter("view", "orders");

  return (
    <div className="stack oc-page">
      <PageHeader
        icon="clipboard"
        title="Orders"
        description="Every order from every channel, newest first."
        action={
          canReport ? (
            <div className="segmented oc-tabs" role="tablist" aria-label="Orders views">
              <button
                type="button"
                role="tab"
                aria-selected={view !== "cancelled"}
                className={`segment ${view !== "cancelled" ? "is-active" : ""}`}
                onClick={() => setView("orders")}
              >
                <Icon name="list" size={15} />
                Orders
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "cancelled"}
                className={`segment ${view === "cancelled" ? "is-active" : ""}`}
                onClick={() => setView("cancelled")}
              >
                <Icon name="undo" size={15} />
                Dishes cancelled after KOT
              </button>
            </div>
          ) : undefined
        }
      />

      {canReport && view === "cancelled" ? (
        <CancelledAfterKot />
      ) : (
        <OrdersList
          canManage={canManage}
          canKitchen={canKitchen}
          canSeeKots={canSeeKots}
          canCancelAfterKot={canCancelAfterKot}
        />
      )}
    </div>
  );
}

function OrdersList({ canManage, canKitchen, canSeeKots, canCancelAfterKot }) {
  const { user, hasPermission, hasFeature } = useAuth();
  const navigate = useNavigate();
  const canPos = hasPermission("orders.create");
  const canBill = canPos && hasPermission("billing.manage");
  // Round 2: an advance on a pickup order (a takeaway ordered ahead), used on its bill.
  const canAdvance = hasFeature("advances") && hasPermission("payments.manage");
  const [advancing, setAdvancing] = useState(null);
  const [orderAdvances, setOrderAdvances] = useState([]);
  // A whole order cancelled from its row (CancelOrderDialog: reasons, PIN).
  const [cancelling, setCancelling] = useState(null);
  const [orders, setOrders] = useState([]);
  const [currency, setCurrency] = useState("₹");
  // The receipt printer's paper, for the kitchen change slips.
  const [paperWidth, setPaperWidth] = useState("80mm");
  // Driven by the address bar, so the dashboard can link straight to the
  // orders still running rather than to every order ever taken.
  const [statusFilter, setStatusFilter] = useQueryFilter("status");
  const [typeFilter, setTypeFilter] = useState("");
  // The list opens on today's business day; older orders are one choice away.
  const [daysFilter, setDaysFilter] = useQueryFilter("days", "today");
  // The day "Today" means: the open business day, or with none open the most
  // recent one (labelled so). undefined while it loads, null when no day was
  // ever opened. Read from /orders/day, which every order taker may read —
  // the business-day screen needs business_day.view, which a captain lacks.
  const [shownDay, setShownDay] = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [viewing, setViewing] = useState(null);
  // The open order's KOTs and moves: null while they load.
  const [kots, setKots] = useState(null);
  const [moves, setMoves] = useState(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelCode, setCancelCode] = useState("");
  // Taking one dish off: { item, quantity, reason, note }.
  const [removing, setRemoving] = useState(null);
  const [saving, setSaving] = useState(false);
  const [total, setTotal] = useState(0);
  // The list is paged by the API, a page at a time in the data grid.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [listError, setListError] = useState("");

  // "Today" waits for the day's id; with no day ever opened it is every day.
  const waitingForDay = daysFilter === "today" && shownDay === undefined;
  const businessDayId = daysFilter === "today" && shownDay ? shownDay.id : undefined;
  const lastDay = shownDay && !shownDay.open;
  const dayWords = lastDay ? `Last business day (${dayMonth(shownDay.businessDate)})` : "Today";
  const filters = useMemo(
    () => ({
      status: statusFilter || undefined,
      orderType: typeFilter || undefined,
      businessDayId,
    }),
    [statusFilter, typeFilter, businessDayId]
  );
  // Only the latest request's answer is shown: pages clicked through quickly
  // can come back out of order.
  const latest = useRef(0);

  const load = useCallback(() => {
    if (waitingForDay) {
      return Promise.resolve();
    }

    const ticket = (latest.current += 1);

    return listOrders({ ...filters, limit: pageSize, offset: (page - 1) * pageSize })
      .then((result) => {
        if (ticket !== latest.current) return;
        setOrders(result.items);
        setTotal(result.total);
        setListError("");
      })
      .catch((err) => {
        if (ticket === latest.current) setListError(getErrorMessage(err));
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
  }, [filters, waitingForDay, page, pageSize]);

  // "Export CSV" takes every order that matches, not only the page on show.
  const fetchAll = async () => {
    const all = [];

    for (let at = 0; ; at += API_MAX) {
      const result = await listOrders({ ...filters, limit: API_MAX, offset: at });
      all.push(...result.items);

      if (result.items.length === 0 || all.length >= result.total) {
        return all;
      }
    }
  };

  // A filter changed: back to the first page.
  const refilter = (set) => (event) => {
    set(event.target.value);
    setPage(1);
  };

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    getServiceDay()
      .then((day) => {
        const current = day && day.current;
        const latest = day && day.latest;
        setShownDay(
          current
            ? { id: current.id, businessDate: current.businessDate, open: true }
            : latest
              ? { id: latest.id, businessDate: latest.businessDate, open: false }
              : null
        );
      })
      .catch(() => setShownDay(null));
  }, []);

  useEffect(() => {
    getSettings()
      .then((settings) => {
        setCurrency(settings.currencySymbol);
        setPaperWidth(settings.printPaperWidth || "80mm");
      })
      .catch(() => undefined);
  }, []);

  const open = async (order) => {
    setError("");
    setCancelReason("");
    setCancelCode("");
    setRemoving(null);
    setKots(null);
    setMoves(null);
    setOrderAdvances([]);

    try {
      setViewing(await getOrder(order.id));
    } catch (err) {
      setError(getErrorMessage(err));
      return;
    }

    // What the guest paid ahead on a pickup order.
    if (canAdvance && order.orderType === "takeaway") {
      getOrderAdvances(order.id)
        .then(setOrderAdvances)
        .catch(() => setOrderAdvances([]));
    }

    // Reading an order's tickets also cuts any the kitchen has not seen yet,
    // exactly as the kitchen screen does.
    if (canSeeKots) {
      getOrderTickets(order.id)
        .then(setKots)
        .catch(() => setKots([]));
    }

    listOrderMoves(order.id)
      .then(setMoves)
      .catch(() => setMoves([]));
  };

  const changeKitchen = async (status) => {
    setSaving(true);

    try {
      setViewing(await setKitchenStatus(viewing.id, status));
      setSuccess(`Kitchen status: ${status}`);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const kitchenHas = (item) => item.kitchenQuantity > 0;

  // Dishes the kitchen holds on a printed KOT were just taken off: their
  // CANCEL slip prints on this screen's printer at once (services/kotSlips).
  const printSlips = async (orderId) => {
    const result = await printChangeSlips([orderId], { restaurantName: user ? user.restaurantName : "", paperWidth });

    if (result.note) {
      setSuccess((shown) => `${shown} · ${result.note}`);
    }

    if (result.problem) {
      setError(result.problem);
    }
  };

  // Takes all or part of one dish off. Once the kitchen has it, that needs a
  // reason and, for staff who cannot do it themselves, a manager's PIN. The
  // server works out what the manager is approving (this dish, this many,
  // this much) and the PIN prompt shows exactly that, so it is not asked up
  // front with less.
  const removeLine = async () => {
    const { item, quantity, reason, note } = removing;

    setSaving(true);
    setError("");

    try {
      const updated = await withApproval(
        (headers) =>
          cancelOrderItem(
            viewing.id,
            item.id,
            { quantity: Number(quantity), reason: reason || undefined, note: note.trim() || undefined },
            headers
          ),
        `Take off ${quantity} × ${item.itemName} on ${viewing.orderNumber}`
      );

      setViewing(updated);
      setRemoving(null);
      setSuccess(`${quantity} × ${item.itemName} taken off ${updated.orderNumber}`);
      load();
      await printSlips(updated.id);
    } catch (err) {
      setError(err.approvalCancelled ? "Nothing was taken off: the manager's approval was cancelled." : getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const orderKitchenHas = viewing ? viewing.items.some((item) => item.itemStatus !== "cancelled" && kitchenHas(item)) : false;

  const cancel = async () => {
    setSaving(true);
    setError("");

    try {
      const reasonText = cancelCode && cancelCode !== "other"
        ? `${reasonLabel(cancelCode)}${cancelReason.trim() ? ` — ${cancelReason.trim()}` : ""}`
        : cancelReason.trim();

      setViewing(
        await withApproval(
          (headers) => cancelOrder(viewing.id, reasonText, cancelCode || undefined, headers),
          `Cancel ${viewing.orderNumber}`
        )
      );
      setSuccess("Order cancelled");
      load();
      await printSlips(viewing.id);
    } catch (err) {
      setError(err.approvalCancelled ? "The order was not cancelled: the manager's approval was cancelled." : getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const cancelReady =
    (cancelCode && cancelCode !== "other") || cancelReason.trim().length > 0;

  return (
    <>
      {advancing && (
        <TakeOrderAdvance
          order={advancing}
          currency={currency}
          onClose={() => setAdvancing(null)}
          onTaken={(advance) => {
            setAdvancing(null);
            setSuccess(`${advance.receiptNumber}: ${moneyExact(advance.amount, currency)} taken on ${advancing.orderNumber}. It comes off the bill at pickup.`);
            if (viewing && viewing.id === advancing.id) setOrderAdvances((rows) => [...rows, advance]);
          }}
        />
      )}
      {cancelling && (
        <CancelOrderDialog
          order={cancelling}
          onClose={() => setCancelling(null)}
          onCancelled={(updated, slipNote) => {
            setCancelling(null);
            setSuccess(`${cancelling.orderNumber} cancelled${slipNote ? ` · ${slipNote}` : ""}`);
            load();
          }}
        />
      )}
      <ErrorMessage message={viewing ? "" : error} />
      {/* A page that failed to load says so inside the list (with Try
          again); a refresh that failed over a page already shown, here. */}
      <ErrorMessage message={!viewing && orders.length > 0 ? listError : ""} />
      <SuccessMessage message={viewing ? "" : success} />

      {daysFilter === "today" && lastDay && (
        <div className="alert alert-notice oc-day-note" role="status">
          <span>
            No business day is open. Showing the last business day, {dayMonth(shownDay.businessDate, { year: true })}.
          </span>{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setDaysFilter("all");
              setPage(1);
            }}
          >
            All days
          </button>
        </div>
      )}

      <SectionCard
        icon="list"
        title={daysFilter === "today" ? (lastDay ? "Orders on the last business day" : "Today's orders") : "All orders"}
        description="Dine-in, takeaway and delivery together. Open a row for its dishes, kitchen tickets and moves."
        className="oc-list"
        flush
      >
        <DataGrid
          id="orders"
          caption="Orders"
          columns={[
            {
              key: "order",
              header: "Order",
              value: (order) => order.orderNumber,
              mobile: "title",
              pin: true,
              csv: (order) =>
                `${order.orderNumber} (${orderTypeLabel(order.orderType)}${order.channelName ? ` · ${order.channelName}` : ""})`,
              render: (order) => (
                <span className="oc-c-order">
                  <span className="mono oc-order-no">{order.orderNumber}</span>
                  <span className="oc-type">
                    <Icon name={TYPE_ICONS[order.orderType] || "receipt"} size={14} />
                    {orderTypeLabel(order.orderType)}
                    {order.channelName ? ` · ${order.channelName}` : ""}
                  </span>
                </span>
              ),
            },
            {
              key: "where",
              header: "Table / customer",
              value: (order) => (order.tableNo ? `Table ${tablesText(order)}` : order.customerName || ""),
              mobile: "subtitle",
              minWidth: 160,
              render: (order) => (
                <span className="oc-c-where">
                  <span className="oc-where">
                    {order.tableNo ? `Table ${tablesText(order)}` : order.customerName || "—"}
                  </span>
                  {order.tableNo && order.customerName && <span className="muted small">{order.customerName}</span>}
                  {order.customerMobile && <span className="muted small mono">{order.customerMobile}</span>}
                  {order.mergedIntoOrderNumber && (
                    <span className="muted small">Joined into {order.mergedIntoOrderNumber}</span>
                  )}
                </span>
              ),
            },
            {
              key: "dishes",
              // Plates on the order: two naan are two.
              header: "Dishes",
              type: "number",
              value: (order) => order.dishCount ?? order.itemCount,
              mobile: "show",
            },
            {
              key: "total",
              header: "Total",
              type: "money",
              exact: true,
              value: (order) => order.totalAmount,
              mobile: "show",
              render: (order) => <span className="oc-money">{moneyExact(order.totalAmount, currency)}</span>,
            },
            {
              key: "kitchen",
              header: "Kitchen",
              type: "status",
              value: (order) => KITCHEN_WORDS[order.kitchenStatus] || order.kitchenStatus,
              mobile: "show",
              // A cancelled order was never served: the kitchen column says nothing.
              render: (order) =>
                order.orderStatus === "cancelled" ? (
                  <span className="muted">—</span>
                ) : (
                  <span className={`oc-chip oc-chip-${order.kitchenStatus}`}>
                    {KITCHEN_WORDS[order.kitchenStatus] || order.kitchenStatus}
                  </span>
                ),
            },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (order) => STATUS_LABELS[order.orderStatus] || order.orderStatus,
              mobile: "show",
              render: (order) => (
                <span className={`badge status-badge ${STATUS_TONES[order.orderStatus] || ""}`}>
                  <span className="badge-dot" />
                  {STATUS_LABELS[order.orderStatus]}
                </span>
              ),
            },
            {
              key: "bill",
              header: "Bill",
              value: (order) => order.billNumber || "",
              render: (order) => <span className="mono small nowrap">{order.billNumber || "—"}</span>,
            },
            {
              key: "placed",
              header: "Placed",
              type: "datetime",
              minWidth: 170,
              value: (order) => order.placedAt,
              csv: (order) => `${when(order.placedAt)}${order.createdByName ? ` by ${order.createdByName}` : ""}`,
              render: (order) => (
                <span className="small oc-c-placed">
                  {when(order.placedAt)}
                  <span className="muted">{order.createdByName ? `by ${order.createdByName}` : "—"}</span>
                </span>
              ),
            },
            {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (order) => {
                const running = ["open", "billed"].includes(order.orderStatus);
                const more = [
                  canPos && running && { label: "Open in POS", icon: "external", onClick: () => navigate(`/pos?order=${order.id}`) },
                  canBill && running && { label: "Bill & pay", icon: "receipt", onClick: () => navigate(`/pos?order=${order.id}&bill=1`) },
                  canAdvance &&
                    order.orderType === "takeaway" &&
                    order.orderStatus === "open" &&
                    !order.billId && { label: "Take advance…", icon: "wallet", onClick: () => setAdvancing(order) },
                  canManage &&
                    order.orderStatus === "open" &&
                    !order.billId && { label: "Cancel order…", icon: "x-circle", danger: true, onClick: () => setCancelling(order) },
                ].filter(Boolean);

                return (
                  <span className="panel-row-actions">
                    <button type="button" className="button button-secondary button-sm" onClick={() => open(order)}>
                      Open
                    </button>
                    {more.length > 0 && <ActionMenu label={`More for ${order.orderNumber}`} items={more} />}
                  </span>
                );
              },
            },
          ]}
          rows={orders}
          rowKey={(order) => order.id}
          loading={loading}
          error={orders.length === 0 ? listError : ""}
          onRetry={load}
          empty="No orders match."
          emptyIcon="clipboard"
          emptyHint={
            statusFilter || typeFilter
              ? "Try All in Status and Type to see every order."
              : daysFilter === "today"
                ? lastDay
                  ? "No business day is open, and the last one had no orders. Pick All days in Day to look further back."
                  : "Nothing yet on today's business day. Pick All days in Day to look further back."
                : "Orders appear here as soon as the POS, a captain or a QR code places one."
          }
          rowClassName={(order) => (order.orderStatus === "cancelled" ? "dg-tone-muted" : "")}
          exportName={daysFilter === "today" ? "orders-today" : "orders"}
          // The API pages; it does not sort or search, so the headers do not
          // offer to (sorting 25 of 3,000 would only look like an answer).
          server={{
            total,
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
              <label className="field">
                <span>Day</span>
                <select value={daysFilter} onChange={refilter(setDaysFilter)}>
                  <option value="today">{dayWords}</option>
                  <option value="all">All days</option>
                </select>
              </label>

              <label className="field">
                <span>Status</span>
                <select value={statusFilter} onChange={refilter(setStatusFilter)}>
                  <option value="">All</option>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Type</span>
                <select value={typeFilter} onChange={refilter(setTypeFilter)}>
                  <option value="">All</option>
                  {ORDER_TYPE_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          }
        />
      </SectionCard>

      {viewing && (
        <Modal
          title={`${viewing.orderNumber} — ${orderTypeLabel(viewing.orderType)}`}
          icon={TYPE_ICONS[viewing.orderType] || "receipt"}
          description={`Placed ${when(viewing.placedAt)}${viewing.createdByName ? ` by ${viewing.createdByName}` : ""}`}
          onClose={() => setViewing(null)}
          width={760}
        >
          <div className="stack oc-order">
            <ErrorMessage message={error} />
            <SuccessMessage message={success} />

            <dl className="details oc-facts">
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`badge status-badge ${STATUS_TONES[viewing.orderStatus] || ""}`}>
                    <span className="badge-dot" />
                    {STATUS_LABELS[viewing.orderStatus]}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Kitchen</dt>
                <dd>
                  <span className={`oc-chip oc-chip-${viewing.kitchenStatus}`}>
                    {KITCHEN_WORDS[viewing.kitchenStatus] || viewing.kitchenStatus}
                  </span>
                </dd>
              </div>
              {viewing.tableNo && (
                <div>
                  <dt>Table</dt>
                  <dd>{tablesText(viewing)}</dd>
                </div>
              )}
              {viewing.customerName && (
                <div>
                  <dt>Customer</dt>
                  <dd>
                    {viewing.customerName} {viewing.customerMobile || ""}
                  </dd>
                </div>
              )}
              {orderAdvances.length > 0 && (
                <div className="oc-fact-wide">
                  <dt>Paid ahead</dt>
                  <dd>
                    {orderAdvances
                      .map((a) => `${a.receiptNumber} · ${moneyExact(a.amount, currency)}${a.heldAmount > 0 && a.heldAmount < a.amount ? ` (${moneyExact(a.heldAmount, currency)} left)` : a.heldAmount > 0 ? "" : " (used)"}`)
                      .join(", ")}
                  </dd>
                </div>
              )}
              <div>
                <dt>Taken by</dt>
                <dd>{viewing.createdByName || "—"}</dd>
              </div>
              {viewing.mergedIntoOrderNumber && (
                <div className="oc-fact-wide">
                  <dt>Joined into</dt>
                  <dd>{viewing.mergedIntoOrderNumber} (its dishes and KOTs went there)</dd>
                </div>
              )}
              {viewing.orderType === "delivery" && (viewing.channelName || viewing.deliveryAddress) && (
                <div className="oc-fact-wide">
                  <dt>Delivery</dt>
                  <dd>
                    {[viewing.channelName, viewing.deliveryAddress, viewing.deliveryEtaMinutes ? `promised in ${viewing.deliveryEtaMinutes} min` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </dd>
                </div>
              )}
              {viewing.orderType === "delivery" && (viewing.deliveryCharge > 0 || viewing.deliveryChargeWaived) && (
                <div className="oc-fact-wide">
                  <dt>Delivery charge</dt>
                  <dd>
                    {viewing.deliveryChargeWaived
                      ? `Waived: ${viewing.deliveryChargeWaivedReason}`
                      : `${moneyExact(viewing.deliveryCharge, currency)} plus GST, on the bill`}
                  </dd>
                </div>
              )}
              {viewing.notes && (
                <div className="oc-fact-wide">
                  <dt>Notes</dt>
                  <dd className="oc-prewrap">{viewing.notes}</dd>
                </div>
              )}
              {viewing.cancelReason && (
                <div className="oc-fact-wide oc-fact-danger">
                  <dt>Cancelled because</dt>
                  <dd>{viewing.cancelReason}</dd>
                </div>
              )}
            </dl>

            {/* The order's dishes (REQ-REST1-GRID): on a phone each line is a
                card (dish and total, then quantity, kitchen state, Remove). */}
            <DataGrid
              id="order-dialog-lines"
              variant="compact"
              caption={`Dishes on ${viewing.orderNumber}`}
              rows={viewing.items}
              rowKey={(item) => item.id}
              currency={currency}
              pageSize={false}
              rowNoun={["dish", "dishes"]}
              rowClassName={(item) => (item.itemStatus === "cancelled" ? "dg-tone-muted oc-line-cancelled" : "")}
              columns={[
                {
                  key: "item",
                  header: "Item",
                  value: (item) => item.itemName,
                  mobile: "title",
                  render: (item) => (
                    <span className="oc-l-item">
                      <span className="oc-l-name">{item.itemName}</span>
                      {item.variantName && <span className="muted"> · {item.variantName}</span>}
                      {item.modifiers.length > 0 && (
                        <span className="muted small oc-l-sub">{item.modifiers.map((modifier) => modifier.name).join(", ")}</span>
                      )}
                      {item.notes && <span className="muted small oc-l-sub">Note: {item.notes}</span>}
                      <span className="muted small oc-l-sub">
                        {when(item.createdAt)}
                        {item.createdByName ? ` · ${item.createdByName}` : ""}
                        {item.priceWindowName ? ` · ${item.priceWindowName} price` : ""}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "qty",
                  header: "Qty",
                  type: "number",
                  value: (item) => item.quantity,
                  mobile: "show",
                  render: (item) => (
                    <span>
                      × {item.quantity}
                      {item.cancelledQuantity > 0 && item.itemStatus !== "cancelled" && (
                        <span className="muted small oc-l-sub">{item.cancelledQuantity} taken off</span>
                      )}
                    </span>
                  ),
                },
                { key: "unit", header: "Unit", type: "money", exact: true, value: (item) => item.unitPrice + item.modifierTotal },
                {
                  key: "total",
                  header: "Total",
                  type: "money",
                  exact: true,
                  value: (item) => (item.itemStatus === "cancelled" ? 0 : item.lineTotal),
                  render: (item) => moneyExact(item.lineTotal, currency),
                  total: "sum",
                  mobile: "show",
                },
                {
                  key: "kitchen",
                  header: "Kitchen",
                  value: (item) => item.itemStatus,
                  mobile: "subtitle",
                  render: (item) => (
                    <span className={`oc-chip oc-chip-${item.itemStatus}`}>{LINE_WORDS[item.itemStatus] || item.itemStatus}</span>
                  ),
                },
                canManage && {
                  key: "actions",
                  header: "",
                  label: "Actions",
                  type: "actions",
                  render: (item) =>
                    viewing.orderStatus === "open" && item.itemStatus !== "cancelled" ? (
                      <button
                        type="button"
                        className="button button-ghost button-sm oc-danger-chip"
                        onClick={() => setRemoving({ item, quantity: String(item.quantity), reason: "", note: "" })}
                        disabled={saving}
                      >
                        <Icon name="minus" size={14} />
                        Remove…
                      </button>
                    ) : null,
                },
              ]}
            />

            {removing && (
              <div className="oc-remove">
                <div className="oc-remove-head">
                  <strong>
                    <Icon name="minus" size={16} />
                    Take off {removing.item.itemName}
                    {removing.item.variantName ? ` (${removing.item.variantName})` : ""}
                  </strong>
                  {kitchenHas(removing.item) ? (
                    <span className="oc-chip oc-chip-cancel">
                      Kitchen has {removing.item.kitchenQuantity}
                      {removing.item.kitchenStage === "served" ? " · already served" : ""}
                    </span>
                  ) : (
                    <span className="oc-chip oc-chip-new">Not sent to the kitchen yet</span>
                  )}
                </div>

                <div className="form-grid">
                  <label className="field">
                    <span>How many</span>
                    <input
                      type="number"
                      min="0.01"
                      max={removing.item.quantity}
                      step="1"
                      value={removing.quantity}
                      onChange={(event) => setRemoving({ ...removing, quantity: event.target.value })}
                    />
                    <small className="muted">of {removing.item.quantity} on the order</small>
                  </label>

                  <label className="field">
                    <span>Note {removing.reason === "other" ? "*" : "(optional)"}</span>
                    <input
                      value={removing.note}
                      maxLength={200}
                      onChange={(event) => setRemoving({ ...removing, note: event.target.value })}
                      placeholder="What happened?"
                    />
                  </label>

                  <div className="field field-wide">
                    <span>Why? {kitchenHas(removing.item) ? "*" : "(optional)"}</span>
                    <div className="oc-reasons" role="radiogroup" aria-label="Reason">
                      {CANCEL_REASONS.map((reason) => (
                        <button
                          type="button"
                          key={reason.code}
                          role="radio"
                          aria-checked={removing.reason === reason.code}
                          className={`chip-button oc-reason ${removing.reason === reason.code ? "is-active" : ""}`}
                          onClick={() => setRemoving({ ...removing, reason: reason.code })}
                        >
                          {reason.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {kitchenHas(removing.item) && !canCancelAfterKot && (
                  <p className="oc-pin-note">
                    <Icon name="key" size={15} />
                    A manager will be asked for their PIN.
                  </p>
                )}

                <div className="form-actions">
                  <button type="button" className="button button-secondary" onClick={() => setRemoving(null)}>
                    Keep it
                  </button>
                  <button
                    type="button"
                    className="button button-danger"
                    onClick={removeLine}
                    disabled={
                      saving ||
                      !(Number(removing.quantity) > 0) ||
                      Number(removing.quantity) > removing.item.quantity ||
                      (kitchenHas(removing.item) && !removing.reason) ||
                      (removing.reason === "other" && !removing.note.trim())
                    }
                  >
                    {saving ? "Taking off…" : `Take off ${removing.quantity || 0}`}
                  </button>
                </div>
              </div>
            )}

            {canSeeKots && (
              <section className="stack pos-order-kots">
                <h3 className="pos-order-section">
                  <Icon name="chef" size={16} />
                  Kitchen tickets (KOTs)
                </h3>
                {kots === null ? (
                  <Loading label="Reading the kitchen's tickets…" />
                ) : kots.length === 0 ? (
                  <p className="muted small oc-none">No KOT for this order yet.</p>
                ) : (
                  <ul className="pos-kot-list">
                    {kots.map((ticket) => (
                      <li key={ticket.id} className={`pos-kot pos-kot-${ticket.status}`}>
                        <div className="pos-kot-head">
                          <strong className="mono">{ticket.kotNo}</strong>
                          <span className="muted small">{ticket.stationName}</span>
                          <span className={`pos-kot-stage pos-kot-stage-${ticket.status}`}>{KOT_WORDS[ticket.status] || ticket.status}</span>
                          <span className="muted small nowrap pos-kot-when">{when(ticket.createdAt)}</span>
                        </div>
                        <div className="small pos-kot-items">
                          {ticket.items
                            .map((item) =>
                              item.cancelledQuantity > 0
                                ? `${item.liveQuantity} × ${item.name}${item.variant ? ` (${item.variant})` : ""} (${item.cancelledQuantity} struck off)`
                                : `${item.liveQuantity} × ${item.name}${item.variant ? ` (${item.variant})` : ""}`
                            )
                            .join(", ")}
                        </div>
                        <div className="muted small">
                          {ticket.takenByLabel || "—"}
                          {ticket.printCount > 0 ? ` · printed ${ticket.printCount}×` : " · not printed"}
                          {ticket.servedByName ? ` · served by ${ticket.servedByName}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {moves && moves.length > 0 && (
              <section className="stack pos-order-moves">
                <h3 className="pos-order-section">
                  <Icon name="switch" size={16} />
                  Moved
                </h3>
                <ul className="pos-move-history">
                  {moves.map((move) => (
                    <li key={move.id}>
                      <span>{moveText(move)}</span>
                      <span className="muted small">
                        {when(move.movedAt)} · {move.movedByName || "—"}
                        {move.items.length > 0
                          ? ` · ${move.items.map((item) => `${item.quantity} × ${item.itemName}`).join(", ")} (${moneyExact(move.amount, currency)})`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <dl className="details bill-totals oc-totals">
              <dt>Subtotal</dt>
              <dd>
                {moneyExact(viewing.subtotal, currency)}
              </dd>
              <dt>Tax</dt>
              <dd>
                {moneyExact(viewing.taxAmount, currency)}
              </dd>
              <dt className="oc-total-label">
                <strong>Order total</strong>
              </dt>
              <dd className="oc-total-value">
                <strong>
                  {moneyExact(viewing.totalAmount, currency)}
                </strong>
              </dd>
            </dl>

            {canKitchen && viewing.orderStatus !== "cancelled" && (
              <div className="oc-kitchen-row">
                <span className="oc-kitchen-label">
                  <Icon name="chef" size={15} />
                  Kitchen status
                </span>
                <div className="segmented oc-kitchen-switch" role="group" aria-label="Kitchen status">
                  {KITCHEN_STATUSES.map((status) => (
                    <button
                      type="button"
                      key={status}
                      className={`segment ${viewing.kitchenStatus === status ? "is-active" : ""}`}
                      onClick={() => changeKitchen(status)}
                      disabled={saving || viewing.kitchenStatus === status}
                    >
                      {KITCHEN_WORDS[status]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {canManage && viewing.orderStatus === "open" && (
              <div className="oc-cancel-order stack">
                <strong className="oc-cancel-title">
                  <Icon name="x-circle" size={16} />
                  Cancel the whole order — why?
                </strong>
                <div className="oc-reasons" role="radiogroup" aria-label="Why is the order being cancelled?">
                  {CANCEL_REASONS.map((reason) => (
                    <button
                      type="button"
                      key={reason.code}
                      role="radio"
                      aria-checked={cancelCode === reason.code}
                      className={`chip-button oc-reason ${cancelCode === reason.code ? "is-active" : ""}`}
                      onClick={() => setCancelCode(reason.code)}
                    >
                      {reason.label}
                    </button>
                  ))}
                </div>
                <div className="inline-form oc-cancel-row">
                  <input
                    placeholder={cancelCode && cancelCode !== "other" ? "Anything to add (optional)" : "Reason for cancelling"}
                    value={cancelReason}
                    onChange={(event) => setCancelReason(event.target.value)}
                    maxLength={150}
                  />
                  <button
                    type="button"
                    className="button button-danger"
                    onClick={cancel}
                    disabled={saving || !cancelReady}
                  >
                    Cancel order
                  </button>
                </div>
                {orderKitchenHas && (
                  <p className="muted small oc-cancel-help">
                    The kitchen already has food on this order, so cancelling it is recorded on the
                    cancelled-after-KOT report{canCancelAfterKot ? "" : " and needs a manager's PIN"}.
                  </p>
                )}
              </div>
            )}

            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setViewing(null)}>
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// Dishes taken off after the kitchen already had them: the one report that
// catches "serve it, take the cash, delete it from the order". By staff member,
// by reason, and line by line, with the manager who approved each.
function CancelledAfterKot() {
  const [anchor, setAnchor] = useState(null);
  const [from, setFrom] = useQueryFilter("from");
  const [to, setTo] = useQueryFilter("to");
  const [userId, setUserId] = useQueryFilter("staff");
  const [reason, setReason] = useQueryFilter("reason");
  const [data, setData] = useState(null);
  const [currency, setCurrency] = useState("₹");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Every dish pages through the server (REQ-REST1-GRID): no 500-row cap.
  const [paging, setPaging] = useState(() => ({ page: 1, pageSize: rememberedPageSize("cancelled-every-dish", 25) }));

  useEffect(() => {
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);

    // "Today" is the open business day, so a report looked at after midnight
    // still shows tonight's service.
    getServiceDay()
      .then((day) => setAnchor(day.current ? day.current.businessDate : null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    listCancellations({
      from: from || undefined,
      to: to || undefined,
      userId: userId || undefined,
      reason: reason || undefined,
      limit: paging.pageSize,
      offset: (paging.page - 1) * paging.pageSize,
    })
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [from, to, userId, reason, paging]);

  // A filter change goes back to page 1.
  const filtered = (apply) => (value) => {
    setPaging((current) => ({ ...current, page: 1 }));
    apply(value);
  };

  // Export takes every matching dish, not only the page on show.
  const fetchAll = async () => {
    const all = [];

    for (let offset = 0; ; offset += 1000) {
      const result = await listCancellations({
        from: shownFrom,
        to: shownTo,
        userId: userId || undefined,
        reason: reason || undefined,
        limit: 1000,
        offset,
      });
      all.push(...result.items);

      if (result.items.length === 0 || all.length >= result.total) {
        return all;
      }
    }
  };

  const shownFrom = from || (data ? data.from : today(anchor));
  const shownTo = to || (data ? data.to : today(anchor));

  const summary = data ? data.summary : null;

  const staffColumns = [
    {
      key: "who",
      header: "Who",
      value: (row) => row.name,
      mobile: "title",
      render: (row) => (
        <button type="button" className="link-button" onClick={() => filtered(setUserId)(String(row.userId || ""))}>
          {row.name}
        </button>
      ),
    },
    { key: "dishes", header: "Dishes", type: "number", value: (row) => row.quantity, total: "sum", mobile: "show" },
    { key: "value", header: "Value", type: "money", exact: true, value: (row) => row.amount, total: "sum", mobile: "show" },
    {
      key: "served",
      header: "Served first",
      type: "number",
      value: (row) => row.servedFirst,
      total: "sum",
      mobile: "show",
      render: (row) => (row.servedFirst > 0 ? <span className="oc-chip oc-chip-cancel">{row.servedFirst}</span> : "—"),
    },
    { key: "pin", header: "With PIN", type: "number", value: (row) => row.approved, total: "sum", mobile: "show" },
  ];

  const dishColumns = [
    { key: "when", header: "When", type: "datetime", value: (row) => row.cancelledAt, mobile: "subtitle" },
    {
      key: "order",
      header: "Order",
      value: (row) => row.orderNumber,
      render: (row) => (
        <span>
          <span className="mono">{row.orderNumber}</span>
          <span className="muted small"> · {row.tableNo ? `Table ${row.tableNo}` : orderTypeLabel(row.orderType)}</span>
        </span>
      ),
      csv: (row) => `${row.orderNumber}${row.tableNo ? ` (Table ${row.tableNo})` : ""}`,
      mobile: "show",
    },
    {
      key: "dish",
      header: "Dish",
      value: (row) => `${row.itemName}${row.variantName ? ` (${row.variantName})` : ""}`,
      mobile: "title",
      render: (row) => (
        <span>
          {row.itemName}
          {row.variantName && <span className="muted"> · {row.variantName}</span>}
          {row.modifiers && <span className="muted small"> · {row.modifiers}</span>}
          <span className="muted small"> · {SOURCE_WORDS[row.source]}</span>
        </span>
      ),
    },
    { key: "qty", header: "Qty", type: "number", value: (row) => row.quantity, total: "sum", mobile: "show" },
    { key: "value", header: "Value", type: "money", exact: true, value: (row) => row.amount, total: "sum", mobile: "show" },
    {
      key: "stage",
      header: "Kitchen had it",
      value: (row) => row.kitchenStage || "new",
      render: (row) => (
        <span className={`oc-chip oc-chip-stage-${row.kitchenStage || "new"}`}>{STAGE_WORDS[row.kitchenStage] || "On a KOT"}</span>
      ),
      csv: (row) => STAGE_WORDS[row.kitchenStage] || "On a KOT",
    },
    {
      key: "reason",
      header: "Reason",
      value: (row) => row.reason || "",
      render: (row) => (
        <span>
          {row.reason}
          {row.note && <span className="muted small"> · {row.note}</span>}
        </span>
      ),
      csv: (row) => `${row.reason || ""}${row.note ? ` (${row.note})` : ""}`,
      mobile: "show",
    },
    { key: "by", header: "Cancelled by", value: (row) => row.cancelledByName || "—" },
    {
      key: "approved",
      header: "Approved by",
      value: (row) => row.approvedByName || "",
      render: (row) => row.approvedByName || <span className="muted">Not needed</span>,
    },
  ];

  return (
    <div className="stack">
      <SectionCard
        icon="undo"
        tone="danger"
        title="Dishes cancelled after KOT"
        description="Every dish taken off an order after the kitchen already had it on a KOT — by a waiter pressing minus, the Remove button, or a whole order cancelled. Each needed a reason, and a manager's PIN for staff without the right to do it themselves."
        className="oc-report-filters"
        flush
      >
        <div className="filters oc-toolbar">
          <DateRangeFilter
            from={shownFrom}
            to={shownTo}
            anchor={anchor}
            label="cancellation dates"
            onChange={(range) => {
              setPaging((current) => ({ ...current, page: 1 }));
              setFrom(range.from);
              setTo(range.to);
            }}
          />

          <label className="field">
            <span>Staff</span>
            <select value={userId} onChange={(event) => filtered(setUserId)(event.target.value)}>
              <option value="">Everyone</option>
              {(data ? data.staff : []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Reason</span>
            <select value={reason} onChange={(event) => filtered(setReason)(event.target.value)}>
              <option value="">Any reason</option>
              {CANCEL_REASONS.map((row) => (
                <option key={row.code} value={row.code}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>

        </div>
      </SectionCard>

      <ErrorMessage message={error} />

      {loading || !data ? (
        <Loading />
      ) : (
        <>
          <div className="stat-grid">
            <StatTile
              icon="undo"
              tone="warning"
              label="Dishes taken off"
              value={count(summary.quantity)}
              note={`${count(summary.entries)} ${summary.entries === 1 ? "entry" : "entries"} on ${count(summary.orders)} ${summary.orders === 1 ? "order" : "orders"}`}
            />
            <StatTile icon="rupee" tone="danger" label="Value taken off bills" value={money(summary.amount, currency)} note="tax included" />
            <StatTile
              icon={summary.servedFirst > 0 ? "alert" : "check-circle"}
              tone={summary.servedFirst > 0 ? "danger" : "success"}
              label="Served, then cancelled"
              value={count(summary.servedFirst)}
              note={
                summary.servedFirst > 0
                  ? `${money(summary.servedAmount, currency)} — ask who and why`
                  : "None: nothing left the kitchen before it came off"
              }
              className={summary.servedFirst > 0 ? "oc-tile-alert" : ""}
            />
            <StatTile icon="key" tone="info" label="Approved with a manager's PIN" value={count(summary.approved)} note="the rest by staff allowed to" />
          </div>

          {data.total === 0 ? (
            <div className="card">
              <EmptyState
                icon="check-circle"
                message="No dishes were taken off after the kitchen had them."
                hint="That is what a well-run floor looks like. Try a wider date range to look further back."
              />
            </div>
          ) : (
            <>
              <div className="oc-report-split">
                <SectionCard icon="users" title="By staff member" description="Tap a name to see only their dishes." className="oc-staff" flush>
                  <DataGrid
                    id="cancelled-by-staff"
                    variant="compact"
                    caption="Dishes cancelled after KOT, by staff member"
                    columns={staffColumns}
                    rows={data.byStaff}
                    rowKey={(row) => row.userId || row.name}
                    currency={currency}
                    pageSize={false}
                    rowNoun={["person", "people"]}
                  />
                </SectionCard>

                <SectionCard icon="tag" title="By reason" description="Share of the value taken off.">
                  <ul className="oc-reason-bars">
                    {data.byReason.map((row) => {
                      const share = summary.amount > 0 ? Math.round((row.amount / summary.amount) * 100) : 0;

                      return (
                        <li key={row.reasonCode || "none"}>
                          <div className="oc-reason-bar-label">
                            <span>{row.reason || "No reason"}</span>
                            <span className="muted small">
                              {row.entries} · {moneyExact(row.amount, currency)}
                            </span>
                          </div>
                          <div className="oc-reason-bar" aria-hidden="true">
                            <span style={{ width: `${Math.max(share, 2)}%` }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </SectionCard>
              </div>

              <SectionCard icon="list" title="Every dish" description="Each one, with who took it off and who approved it." className="oc-every" flush>
                <DataGrid
                  id="cancelled-every-dish"
                  caption="Every dish cancelled after KOT"
                  columns={dishColumns}
                  rows={data.items}
                  rowKey={(row) => row.id}
                  loading={loading}
                  currency={currency}
                  exportName={`dishes-cancelled-after-kot-${shownFrom}-to-${shownTo}`}
                  rowClassName={(row) => (row.kitchenStage === "served" ? "dg-tone-danger" : "")}
                  rowNoun={["dish", "dishes"]}
                  server={{
                    total: data.total,
                    page: paging.page,
                    pageSize: paging.pageSize,
                    fetchAll,
                    totals: { qty: summary.quantity, value: summary.amount },
                    onChange: ({ page, pageSize }) =>
                      setPaging({ page: pageSize !== paging.pageSize ? 1 : page, pageSize }),
                  }}
                />
              </SectionCard>
            </>
          )}
        </>
      )}
    </div>
  );
}
