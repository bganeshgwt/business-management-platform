// The live delivery board: tiles, riders strip and cards by stage.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import TruncationNotice from "../../../../components/TruncationNotice";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { getErrorMessage } from "../../../../services/api";
import { count, money, moneyExact } from "../../../../services/format";
import { dayMonth, today } from "../../../../services/dates";
import { escapeHtml, printDocument } from "../../../../services/print";
import { getDelivery, getDeliveryBoard, setDeliveryStatus } from "../services/delivery.service";
import SettleRiderModal from "./SettleRiderModal";
import { PRE_DISPATCH, clockOf, digitsOf, duration, initials, minutesSince } from "./deliveryFormat";
import DeliveryCard from "./DeliveryCard";
import { ChannelBadge } from "./DeliveryParts";
import { CancelModal, DetailsModal, PackedModal } from "./DeliveryModals";
import RiderModal from "./RiderModal";
import { confirmAction } from "../../../../services/confirm";

// ---------------------------------------------------------------- the board

const REFRESH_EVERY = 15000;

export default function BoardTab() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("orders.manage");
  // Settling a rider's cash pays bills: orders.manage and payments.manage.
  const canSettle = canManage && hasPermission("payments.manage");
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState("");
  const [column, setColumn] = useState("dispatch");
  const [showAllDone, setShowAllDone] = useState(false);
  // Deliveries left open from an earlier day stay off the columns until asked
  // for: tonight's board is tonight's (they are counted in the notice).
  const [showEarlier, setShowEarlier] = useState(false);
  const [channelFilter, setChannelFilter] = useQueryFilter("channel");
  const [focusParam] = useQueryFilter("order");
  // The board is today's: the open business day. An earlier date is picked
  // here (the owner's rule for live screens), and only then are that day's
  // deliveries shown — including any never marked delivered, which can still
  // be closed from it.
  const [dayParam, setDayParam] = useQueryFilter("day");

  const focusId = Number(focusParam) || null;
  const toastTimer = useRef(null);
  const focusedOnce = useRef(null);

  const say = useCallback((text, tone = "ok") => {
    setToast({ text, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const apply = useCallback(
    (next) => {
      setData(next);
      setError("");
      setLoadedAt(Date.now());

      // Arriving from the bell: open the column the order is in, once.
      if (focusId && focusedOnce.current !== focusId) {
        const order = next.orders.find((one) => one.id === focusId);

        if (order) {
          setColumn(
            PRE_DISPATCH.includes(order.status)
              ? "dispatch"
              : order.status === "out_for_delivery"
                ? "road"
                : "done"
          );
        }
      }
    },
    [focusId]
  );

  const fail = useCallback((err) => setError(getErrorMessage(err)), []);

  const refresh = useCallback(() => {
    setRefreshing(true);

    return getDeliveryBoard(dayParam || undefined)
      .then(apply)
      .catch(fail)
      .finally(() => setRefreshing(false));
  }, [apply, fail, dayParam]);

  useEffect(() => {
    getDeliveryBoard(dayParam || undefined).then(apply).catch(fail);
  }, [apply, fail, dayParam]);

  // Every 15 seconds while the screen is being looked at; at once on coming
  // back to it, rather than showing a board ten minutes stale.
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

  // The clocks on the cards.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);

  // Scrolls the order the bell pointed at into view, once it is on screen.
  useEffect(() => {
    if (!data || !focusId || focusedOnce.current === focusId) {
      return;
    }

    const element = document.getElementById(`dlv-order-${focusId}`);

    if (element && element.scrollIntoView) {
      focusedOnce.current = focusId;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [data, focusId, column]);

  const orders = useMemo(() => {
    if (!data) {
      return [];
    }

    const term = search.trim().toLowerCase();
    const digits = digitsOf(term);

    return data.orders.filter((order) => {
      if (channelFilter === "untagged" && order.channel) return false;
      if (
        channelFilter &&
        channelFilter !== "untagged" &&
        (!order.channel || String(order.channel.id) !== channelFilter)
      ) {
        return false;
      }

      if (!term) return true;

      const haystack = [
        order.orderNumber,
        order.customerName,
        order.address,
        order.landmark,
        order.externalRef,
        order.rider && order.rider.name,
        order.partnerRiderName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(term) || (digits.length >= 3 && digitsOf(order.customerMobile).includes(digits));
    });
  }, [data, search, channelFilter]);

  if (!data && !error) {
    return <Loading label="Loading the delivery board…" />;
  }

  if (!data) {
    return <ErrorMessage message={error} />;
  }

  const board = data;
  const stats = board.stats;
  // An earlier business date picked: history, the same board read for that
  // day. (A board still on screen from before the pick says nothing yet.)
  const pastDay = board.viewingDate && board.viewingDate === dayParam ? board.viewingDate : null;
  const pickDay = (value) => setDayParam(!value || value === board.todayDate ? "" : value);

  // Packed food first (it is going cold), then the oldest orders.
  const rank = { ready: 0, preparing: 1, pending: 2 };
  const inView = pastDay || showEarlier ? orders : orders.filter((order) => !order.earlierDay);
  const toDispatch = inView
    .filter((order) => PRE_DISPATCH.includes(order.status))
    .sort((a, b) => rank[a.status] - rank[b.status] || new Date(a.placedAt) - new Date(b.placedAt));
  const onRoad = inView
    .filter((order) => order.status === "out_for_delivery")
    .sort((a, b) => new Date(a.dispatchedAt) - new Date(b.dispatchedAt));
  const delivered = orders
    .filter((order) => order.status === "delivered")
    .sort((a, b) => new Date(b.deliveredAt || b.placedAt) - new Date(a.deliveredAt || a.placedAt));
  const cancelled = orders.filter((order) => order.status === "cancelled");

  const act = async (delivery, status, extra = {}) => {
    // The kitchen display still has this order on the line: ask before
    // calling it packed, because packed food can be sent out and sending it
    // out clears those tickets from the kitchen's screen.
    if (status === "ready" && !extra.confirmPacked && delivery.status !== "out_for_delivery" && delivery.kitchenOpenTickets > 0) {
      setModal({ type: "packed", delivery });
      return;
    }

    setBusyId(delivery.id);

    try {
      const result = await setDeliveryStatus(delivery.id, { status, ...extra });
      say(result.message);
      await refresh();
    } catch (err) {
      // A ticket reached the kitchen screen after this board was drawn.
      const data = err && err.response && err.response.data && err.response.data.data;

      if (data && data.needsConfirmation === "confirmPacked") {
        setModal({ type: "packed", delivery: { ...delivery, kitchenOpenTickets: data.openTickets } });
      } else {
        say(getErrorMessage(err), "error");
      }
    } finally {
      setBusyId(null);
    }
  };

  const dispatch = (delivery) => {
    if (delivery.rider || delivery.partnerRiderName) {
      act(delivery, "out_for_delivery");
    } else {
      setModal({ type: "dispatch", orderIds: [delivery.id] });
    }
  };

  const closeModal = () => setModal(null);

  // A run out for hours (or days) was delivered without anyone marking it:
  // close it in one go, every order the rider still carries marked delivered.
  // Their cash stays with the rider until it is settled.
  const confirm = confirmAction;
  const closeRun = async (rider) => {
    const sure = await confirm({
      title: `Close ${rider.name}'s run?`,
      message: `${rider.outNow.map((order) => order.orderNumber).join(", ")} will be marked delivered. Any cash on them stays with the rider until you settle it.`,
      confirmLabel: "Mark delivered",
      cancelLabel: "Not yet",
      tone: "primary",
    });

    if (!sure) {
      return;
    }

    setBusyId(`rider-${rider.id}`);
    let closed = 0;

    try {
      for (const order of rider.outNow) {
        await setDeliveryStatus(order.id, { status: "delivered" });
        closed += 1;
      }

      say(`${rider.name}'s run is closed: ${closed} ${closed === 1 ? "order" : "orders"} marked delivered.`);
    } catch (err) {
      say(`${closed > 0 ? `${closed} marked delivered, then: ` : ""}${getErrorMessage(err)}`, "error");
    } finally {
      setBusyId(null);
      refresh();
    }
  };

  const afterModal = (message) => {
    setModal(null);

    if (message) {
      say(message);
    }

    refresh();
  };

  // A finished card on the board is a summary, and a card may show the
  // guest's number masked; the edit form and the slip need the whole order
  // with the number the rider calls, which is fetched when one is opened.
  const withFull = (delivery, open) => {
    if (!delivery.summary && !/X/.test(delivery.customerMobile || "")) {
      open(delivery);
      return;
    }

    getDelivery(delivery.id)
      .then(open)
      .catch((err) => say(getErrorMessage(err), "error"));
  };

  const cardProps = {
    board,
    now,
    canManage,
    focusId,
    onAct: act,
    onDispatch: dispatch,
    onEdit: (delivery) => withFull(delivery, (full) => setModal({ type: "details", delivery: full })),
    onAssign: (delivery) => setModal({ type: "assign", delivery }),
    onCancel: (delivery) => setModal({ type: "cancel", delivery }),
    onPrint: (delivery) => withFull(delivery, (full) => printSlip(full, board)),
    onOpen: (delivery) => navigate(`/pos?order=${delivery.id}`),
  };

  const secondsAgo = loadedAt ? Math.max(0, Math.round((now - loadedAt) / 1000)) : null;
  const shownDone = showAllDone ? delivered : delivered.slice(0, 8);

  const columns = [
    {
      key: "dispatch",
      title: "To dispatch",
      hint: "New, cooking and packed",
      tone: "dispatch",
      items: toDispatch,
      empty: {
        message: "Nothing waiting to go out",
        hint: "New delivery orders from the POS, Swiggy and Zomato land here.",
      },
    },
    {
      key: "road",
      title: "Out for delivery",
      hint: "On the road now",
      tone: "road",
      items: onRoad,
      empty: {
        message: "No one is on the road",
        hint: "Dispatch a packed order to a rider and it moves here with its clock running.",
      },
    },
    {
      key: "done",
      title: pastDay ? "Delivered" : "Delivered today",
      hint: "Most recent first",
      tone: "done",
      items: shownDone,
      total: delivered.length,
      empty: pastDay
        ? { message: "Nothing delivered that day", hint: "Pick another date, or go back to today." }
        : {
            message: "Nothing delivered yet today",
            hint: "Orders land here the moment a rider marks them delivered.",
          },
    },
  ];

  return (
    <div className="stack">
      {error && <ErrorMessage message={`Could not refresh: ${error}`} />}

      {pastDay ? (
        <div className="alert alert-notice dlv-past-day" role="status">
          <span>
            Deliveries of <b>{dayMonth(pastDay, { year: true })}</b>, an earlier business day. Anything never marked
            delivered can still be closed from here.
          </span>
          <button type="button" className="button button-secondary button-sm" onClick={() => pickDay("")}>
            Back to today
          </button>
        </div>
      ) : (
        !board.dayOpen && (
          <div className="alert alert-notice">
            No business day is open, so no new orders can be taken. An earlier day&apos;s deliveries, and any it left
            on the road, are under Day: pick its date. <Link to="/business-day">Open the day</Link>
          </div>
        )
      )}

      <StatTiles board={board} stats={stats} pastDay={pastDay} />

      {!pastDay && stats.earlierInPlay > 0 && (
        <div className="alert alert-notice dlv-earlier-notice" role="status">
          <span>
            <strong>
              {count(stats.earlierInPlay)} {stats.earlierInPlay === 1 ? "delivery was" : "deliveries were"} left open
              from earlier days
            </strong>{" "}
            — not counted as late, and {showEarlier ? "shown below with their date" : "not on the columns below"}. Mark
            each delivered or cancel it; a rider&apos;s whole run can be closed from the Riders card.
          </span>
          <button type="button" className="button button-secondary button-sm" onClick={() => setShowEarlier((value) => !value)}>
            {showEarlier ? "Hide them" : "Show them"}
          </button>
        </div>
      )}

      <RiderStrip
        board={board}
        now={now}
        canManage={canManage}
        onSettle={canSettle ? (rider) => setModal({ type: "settle", rider }) : null}
        onCloseRun={canManage ? closeRun : null}
        busyId={busyId}
        onRun={(rider) =>
          setModal({
            type: "dispatch",
            riderId: rider.id,
            // His own orders that are packed go in the bag; ones still
            // cooking wait for the next run.
            orderIds: rider.assigned
              .filter((order) => board.orders.some((one) => one.id === order.id && one.status === "ready"))
              .map((order) => order.id),
          })
        }
      />

      <TruncationNotice
        shown={board.shownOrders}
        total={board.totalOrders}
        what="delivery orders"
        hint="Everything still in play is shown; the earliest finished deliveries are left off, and the figures above count only what is shown."
      />

      <div className="dlv-toolbar">
        <div className="dlv-filter-chips" role="radiogroup" aria-label="Filter by channel">
          <button
            type="button"
            role="radio"
            aria-checked={!channelFilter}
            className={`dlv-filter ${!channelFilter ? "is-active" : ""}`}
            onClick={() => setChannelFilter("")}
          >
            All channels <span className="dlv-filter-count">{board.orders.length}</span>
          </button>
          {board.channels
            .filter((channel) => channel.status === "active" || channel.boardCount > 0)
            .map((channel) => (
              <button
                type="button"
                role="radio"
                key={channel.id}
                aria-checked={channelFilter === String(channel.id)}
                className={`dlv-filter sw-${channel.color} ${
                  channelFilter === String(channel.id) ? "is-active" : ""
                }`}
                onClick={() => setChannelFilter(String(channel.id))}
              >
                <i aria-hidden="true" />
                {channel.name} <span className="dlv-filter-count">{channel.boardCount}</span>
              </button>
            ))}
          {board.untaggedCount > 0 && (
            <button
              type="button"
              role="radio"
              aria-checked={channelFilter === "untagged"}
              className={`dlv-filter sw-slate ${channelFilter === "untagged" ? "is-active" : ""}`}
              onClick={() => setChannelFilter("untagged")}
              title="Delivery orders nobody has put on a channel yet"
            >
              <i aria-hidden="true" />
              No channel <span className="dlv-filter-count">{board.untaggedCount}</span>
            </button>
          )}
        </div>

        <div className="dlv-toolbar-right">
          <label className="field dlv-day">
            <span>Day</span>
            <input
              type="date"
              value={pastDay || board.todayDate || ""}
              max={board.todayDate || today()}
              onChange={(event) => pickDay(event.target.value)}
              aria-label="Business day to show"
            />
          </label>
          <label className="dlv-search">
            <Icon name="search" size={16} />
            <span className="sr-only">Search deliveries</span>
            <input
              type="search"
              value={search}
              placeholder="Order, guest, phone, address…"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="button button-secondary live-badge dlv-live"
            onClick={refresh}
            title="Refreshes by itself every 15 seconds"
          >
            <span className={`live-dot ${refreshing ? "is-busy" : ""}`} aria-hidden="true" />
            Live · {secondsAgo === null || secondsAgo < 5 ? "just now" : `${secondsAgo}s ago`}
          </button>
        </div>
      </div>

      {toast && (
        <div className={`dlv-toast ${toast.tone === "error" ? "is-error" : ""}`} role="status">
          <Icon name={toast.tone === "error" ? "alert" : "check"} size={16} />
          <span>{toast.text}</span>
        </div>
      )}

      {/* On a phone the three columns are one at a time. */}
      <div className="segmented dlv-column-switch" role="tablist" aria-label="Board column">
        {columns.map((col) => (
          <button
            type="button"
            key={col.key}
            role="tab"
            aria-selected={column === col.key}
            className={`segment ${column === col.key ? "is-active" : ""}`}
            onClick={() => setColumn(col.key)}
          >
            {col.title.replace(" for delivery", "").replace(" today", "")}{" "}
            <b>{col.total ?? col.items.length}</b>
          </button>
        ))}
      </div>

      <div className="dlv-board">
        {columns.map((col) => (
          <section
            key={col.key}
            className={`dlv-column tone-${col.tone} ${column === col.key ? "is-current" : ""}`}
            aria-label={col.title}
          >
            <header className="dlv-column-head">
              <h2>
                {col.title} <span className="dlv-column-count">{col.total ?? col.items.length}</span>
              </h2>
              <span className="muted small">{col.hint}</span>
            </header>

            {col.items.length === 0 ? (
              <EmptyState
                icon={col.key === "done" ? "check-circle" : col.key === "road" ? "scooter" : "box"}
                message={col.empty.message}
                hint={col.empty.hint}
              />
            ) : (
              <div className="dlv-cards">
                {col.items.map((delivery) => (
                  <DeliveryCard key={delivery.id} delivery={delivery} busy={busyId === delivery.id} {...cardProps} />
                ))}
              </div>
            )}

            {col.key === "done" && delivered.length > 8 && (
              <button type="button" className="link-button dlv-more" onClick={() => setShowAllDone(!showAllDone)}>
                {showAllDone
                  ? "Show the latest 8"
                  : `Show all ${delivered.length} delivered ${pastDay ? "that day" : "today"}`}
              </button>
            )}

            {col.key === "done" && cancelled.length > 0 && (
              <details className="dlv-cancelled">
                <summary>
                  {cancelled.length} cancelled {pastDay ? "that day" : "today"}
                </summary>
                <ul>
                  {cancelled.map((delivery) => (
                    <li key={delivery.id}>
                      <b>{delivery.orderNumber}</b> <ChannelBadge channel={delivery.channel} />
                      <span className="muted small">
                        {delivery.customerName || "Guest"} · {delivery.cancelReason || "no reason given"}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        ))}
      </div>

      {modal && modal.type === "details" && (
        <DetailsModal delivery={modal.delivery} board={board} onClose={closeModal} onDone={afterModal} />
      )}
      {modal && (modal.type === "dispatch" || modal.type === "assign") && (
        <RiderModal
          mode={modal.type}
          board={board}
          delivery={modal.delivery}
          initialOrderIds={modal.orderIds}
          initialRiderId={modal.riderId}
          now={now}
          onClose={closeModal}
          onDone={afterModal}
        />
      )}
      {modal && modal.type === "cancel" && (
        <CancelModal delivery={modal.delivery} onClose={closeModal} onDone={afterModal} />
      )}
      {modal && modal.type === "settle" && (
        <SettleRiderModal rider={modal.rider} currency={board.currency} onClose={closeModal} onDone={afterModal} />
      )}
      {modal && modal.type === "packed" && (
        <PackedModal
          delivery={modal.delivery}
          onClose={closeModal}
          onConfirm={() => {
            const delivery = modal.delivery;
            setModal(null);
            act(delivery, "ready", { confirmPacked: true });
          }}
        />
      )}
    </div>
  );
}

function StatTiles({ board, stats, pastDay = null }) {
  const currency = board.currency;
  const onTimeTone =
    stats.onTimeRate === null ? "neutral" : stats.onTimeRate >= 85 ? "success" : stats.onTimeRate >= 70 ? "warning" : "danger";

  return (
    <div className="stat-grid dlv-stats">
      <StatTile
        icon="box"
        tone={stats.lateWaiting > 0 ? "danger" : stats.readyTooLong > 0 ? "warning" : "primary"}
        label="To dispatch"
        value={count(stats.toDispatch)}
        className={stats.lateWaiting > 0 ? "dlv-tile-late" : ""}
      >
        <span className="dlv-stat-note">
          <span className="dlv-mini pill-new">{stats.pending} new</span>
          <span className="dlv-mini pill-cooking">{stats.preparing} cooking</span>
          <span className="dlv-mini pill-ready">{stats.ready} packed</span>
        </span>
        {stats.readyTooLong > 0 ? (
          <span className="dlv-stat-flag">
            {stats.readyTooLong} packed over {board.readyWaitMinutes} min
          </span>
        ) : stats.lateWaiting > 0 ? (
          <span className="dlv-stat-flag is-late">
            {stats.lateWaiting} not out after {board.slaMinutes} min
          </span>
        ) : null}
      </StatTile>

      <StatTile
        icon="scooter"
        tone={stats.lateOut > 0 ? "danger" : "info"}
        label="On the road"
        value={count(stats.outNow)}
        note={`${stats.ridersOut} ${stats.ridersOut === 1 ? "rider" : "riders"} out${
          stats.partnerOut > 0 ? ` · ${stats.partnerOut} with partner riders` : ""
        }`}
        className={stats.lateOut > 0 ? "dlv-tile-late" : ""}
      >
        {stats.lateOut > 0 && (
          <span className="dlv-stat-flag is-late">
            {stats.lateOut} past {board.slaMinutes} min
          </span>
        )}
      </StatTile>

      <StatTile
        icon="check-circle"
        tone="success"
        label={pastDay ? "Delivered" : "Delivered today"}
        value={count(stats.deliveredToday)}
        note={`${
          stats.avgDoorMinutes !== null ? `avg ${duration(stats.avgDoorMinutes)} door to door` : "no timed deliveries yet"
        }${stats.cancelledToday > 0 ? ` · ${stats.cancelledToday} cancelled` : ""}`}
      />

      <StatTile
        icon="timer"
        tone={onTimeTone}
        label="Delivered on time"
        value={stats.onTimeRate === null ? "—" : `${stats.onTimeRate}%`}
        note={
          stats.timedCount > 0
            ? `${stats.onTimeCount} of ${stats.timedCount} within ${board.slaMinutes} min`
            : `target: within ${board.slaMinutes} min`
        }
      >
        {stats.lateNow > 0 && (
          <span className="dlv-stat-flag is-late">
            {stats.lateNow} running late now
          </span>
        )}
      </StatTile>

      {/* The restaurant's money: only for someone who may see sales figures. */}
      {board.showsMoney && (
        <>
          <StatTile
            icon="cash"
            tone={stats.cashWithRiders > 0 ? "warning" : "neutral"}
            label="Cash with riders"
            value={money(Math.round(stats.cashWithRiders), currency)}
            note={`cash on delivery still out${
              stats.deliveredUnsettledCount > 0
                ? ` · ${money(Math.round(stats.deliveredUnsettled), currency)} delivered, not settled`
                : ""
            }`}
          />

          <StatTile
            icon="money"
            tone="violet"
            label={pastDay ? "Delivery sales" : "Delivery sales today"}
            value={money(Math.round(stats.salesToday), currency)}
            note={`${count(stats.ordersToday)} orders, cancelled left out`}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- riders

function RiderStrip({ board, now, canManage, onRun, onSettle, onCloseRun, busyId }) {
  const riders = board.riders.filter((rider) => rider.active || rider.outNow.length > 0);
  // Only packed bags can go, so "Send on a run" waits for one.
  const packed = board.orders.filter((order) => order.status === "ready").length;

  return (
    <SectionCard
      className="dlv-riders"
      aria-label="Riders"
      icon="users"
      tone="info"
      title="Riders"
      description={`${riders.filter((rider) => rider.state === "free").length} free · ${
        riders.filter((rider) => rider.state === "on_run").length
      } on a run. Send a free rider out once a bag is packed.`}
    >

      {riders.length === 0 ? (
        <EmptyState
          icon="scooter"
          message="No delivery riders yet"
          hint="Anyone in the delivery department under Staff appears here, ready to be sent out."
          action={
            <Link className="button button-secondary" to="/staff">
              Go to Staff
            </Link>
          }
        />
      ) : (
        <div className="dlv-rider-list">
          {riders.map((rider) => {
            const runMinutes = rider.runStartedAt ? minutesSince(rider.runStartedAt, now) : null;
            const overdue = runMinutes !== null && runMinutes > board.outWarnMinutes;
            // Out for hours: a run nobody closed, not a rider still riding.
            const notClosed = Boolean(rider.runNotClosed);

            return (
              <article
                key={rider.id}
                className={`dlv-rider ${rider.state === "on_run" ? (overdue ? "is-overdue" : "is-out") : "is-free"}`}
              >
                <div className="dlv-rider-head">
                  <span className="dlv-avatar" aria-hidden="true">
                    {initials(rider.name)}
                  </span>
                  <div className="dlv-rider-who">
                    <strong>{rider.name}</strong>
                    <span className="muted small">
                      {rider.mobile ? (
                        <a href={`tel:${digitsOf(rider.mobile)}`} className="dlv-tel">
                          {rider.mobile}
                        </a>
                      ) : (
                        "no mobile on file"
                      )}
                    </span>
                  </div>
                  <span
                    className={`dlv-rider-state ${overdue ? "is-overdue" : rider.state === "on_run" ? "is-out" : "is-free"}`}
                    title={rider.runStartedAt ? `Out since ${clockOf(rider.runStartedAt, board.timezone)}` : undefined}
                  >
                    {rider.state === "on_run"
                      ? notClosed
                        ? "Run not closed"
                        : overdue
                          ? `Out ${duration(runMinutes)}`
                          : `On a run · ${duration(runMinutes)}`
                      : "Free"}
                  </span>
                </div>

                <p className="dlv-rider-now">
                  {rider.outNow.length > 0 ? (
                    <>
                      <Icon name="scooter" size={14} /> Carrying{" "}
                      <b>{rider.outNow.map((order) => order.orderNumber).join(", ")}</b>
                    </>
                  ) : rider.assigned.length > 0 ? (
                    <>
                      <Icon name="box" size={14} /> Waiting for{" "}
                      <b>{rider.assigned.map((order) => order.orderNumber).join(", ")}</b>
                    </>
                  ) : (
                    <span className="muted">
                      {rider.lastDeliveredAt
                        ? `Back since ${clockOf(rider.lastDeliveredAt, board.timezone)}`
                        : "Ready for the first run"}
                    </span>
                  )}
                </p>

                <dl className="dlv-rider-figures">
                  <div>
                    <dt>Today</dt>
                    <dd>{rider.deliveredToday}</dd>
                  </div>
                  <div>
                    <dt>Avg ride</dt>
                    <dd>{rider.avgRideMinutes === null ? "—" : `${rider.avgRideMinutes}m`}</dd>
                  </div>
                  <div>
                    <dt>To collect</dt>
                    <dd className={rider.cashToCollect > 0 ? "is-cash" : ""}>
                      {money(rider.cashToCollect, board.currency)}
                    </dd>
                  </div>
                </dl>

                {rider.deliveredUnpaid > 0 && (
                  <p className="dlv-rider-handin">
                    <Icon name="cash" size={14} /> {rider.deliveredUnpaid} delivered, not paid in ·{" "}
                    <b>{money(rider.cashToHandIn, board.currency)}</b>
                  </p>
                )}

                {notClosed && (
                  <p className="dlv-rider-stuck">
                    <Icon name="alert" size={14} /> Out {duration(runMinutes)}. Mark the run delivered once the
                    rider confirms.
                  </p>
                )}

                <div className="dlv-rider-actions">
                  {onCloseRun && notClosed && (
                    <button
                      type="button"
                      className="chip-button dlv-rider-close"
                      disabled={busyId === `rider-${rider.id}`}
                      onClick={() => onCloseRun(rider)}
                    >
                      <Icon name="check" size={14} /> Close run
                    </button>
                  )}
                  {canManage && rider.state === "free" && packed > 0 && (
                    <button type="button" className="chip-button dlv-rider-run" onClick={() => onRun(rider)}>
                      <Icon name="scooter" size={14} /> Send on a run
                    </button>
                  )}
                  {onSettle && rider.deliveredUnpaid > 0 && (
                    <button type="button" className="chip-button dlv-rider-settle" onClick={() => onSettle(rider)}>
                      <Icon name="wallet" size={14} /> Settle cash
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// A slip for the rider's bag: where, who, what, and whether to take money.
const printSlip = (delivery, board) => {
  const currency = board.currency;
  const collect =
    delivery.paymentState === "paid"
      ? "PAID — collect nothing"
      : `COLLECT ${moneyExact(delivery.dueAmount, currency)}${delivery.billed ? "" : " (not billed yet)"}`;
  const rider = delivery.rider ? delivery.rider.name : delivery.partnerRiderName || "—";

  printDocument({
    title: `Delivery ${delivery.orderNumber}`,
    styles: `
      body { font-family: ui-monospace, Consolas, monospace; font-size: 12px; width: 72mm; color: #000; }
      h1 { font-size: 18px; margin: 0 0 2px; }
      .muted { color: #333; }
      .box { border: 1px solid #000; padding: 6px; margin: 8px 0; }
      .big { font-size: 15px; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; margin-top: 6px; }
      td { padding: 2px 0; vertical-align: top; }
      td.q { width: 28px; }
      .collect { font-size: 16px; font-weight: 700; text-align: center; border: 2px solid #000; padding: 6px; margin-top: 8px; }
    `,
    body: `
      <h1>${escapeHtml(delivery.orderNumber)}</h1>
      <div class="muted">${escapeHtml(delivery.channel ? delivery.channel.name : "Delivery")}${
        delivery.externalRef ? ` · #${escapeHtml(delivery.externalRef)}` : ""
      } · placed ${escapeHtml(clockOf(delivery.placedAt, board.timezone))}</div>
      <div class="box">
        <div class="big">${escapeHtml(delivery.customerName || "Guest")}</div>
        <div>${escapeHtml(delivery.customerMobile || "no phone")}</div>
        <div style="margin-top:4px">${escapeHtml(delivery.address || "NO ADDRESS — ask the desk")}</div>
        ${delivery.landmark ? `<div>Landmark: ${escapeHtml(delivery.landmark)}</div>` : ""}
      </div>
      <table>
        ${delivery.items
          .map(
            (item) =>
              `<tr><td class="q">${escapeHtml(item.quantity)}×</td><td>${escapeHtml(item.name)}${
                item.variant ? ` (${escapeHtml(item.variant)})` : ""
              }</td></tr>`
          )
          .join("")}
      </table>
      ${delivery.notes ? `<p>Note: ${escapeHtml(delivery.notes)}</p>` : ""}
      <div>Rider: ${escapeHtml(rider)}</div>
      ${delivery.promisedBy ? `<div>Promised by ${escapeHtml(clockOf(delivery.promisedBy, board.timezone))}</div>` : ""}
      <div class="collect">${escapeHtml(collect)}</div>
    `,
  });
};
