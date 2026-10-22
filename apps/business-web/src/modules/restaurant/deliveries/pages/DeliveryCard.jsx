// One delivery on the board, with its status line and payment chip.

import Icon from "@bmp/ui/Icon";
import ActionMenu from "../../../../components/ActionMenu";
import { dateShort, money, moneyExact } from "@bmp/shared/format";
import { PAYMENT_METHOD, PRE_DISPATCH, STATUS, STEPS, clockOf, duration, minutesSince, slaTone } from "./deliveryFormat";
import { ChannelBadge, GuestPhone } from "./DeliveryParts";

// ---------------------------------------------------------------- a card

function PaymentChip({ delivery, currency }) {
  if (delivery.paymentState === "paid") {
    const methods = delivery.paymentMethods.map((method) => PAYMENT_METHOD[method] || method).join(" + ");
    return <span className="dlv-pay is-paid">Paid{methods ? ` · ${methods}` : ""}</span>;
  }

  if (delivery.paymentState === "not_billed") {
    return <span className="dlv-pay is-unbilled">Not billed yet</span>;
  }

  return (
    <span className="dlv-pay is-collect">
      Collect {money(delivery.dueAmount, currency)}
      {delivery.paymentState === "part_paid" ? " (part paid)" : ""}
    </span>
  );
}

function StatusLine({ delivery, board, now, compact = false }) {
  const status = delivery.status;
  const meta = STATUS[status];
  let text = "";
  let alert = "";

  if (status === "pending") {
    text = `Waiting to be accepted · ${duration(minutesSince(delivery.placedAt, now))}`;
  } else if (status === "preparing") {
    text = delivery.preparingAt ? `In the kitchen since ${clockOf(delivery.preparingAt, board.timezone)}` : "In the kitchen";
  } else if (status === "ready") {
    const waiting = delivery.readyAt ? minutesSince(delivery.readyAt, now) : null;
    text = waiting === null ? "Packed at the pass" : `Packed ${duration(waiting)} ago, waiting for a rider`;
    alert = waiting !== null && waiting > board.readyWaitMinutes ? "warn" : "";
  } else if (status === "out_for_delivery") {
    const out = minutesSince(delivery.dispatchedAt, now);
    text = `Left at ${clockOf(delivery.dispatchedAt, board.timezone)} · out ${duration(out)}`;
    alert = out > board.outCriticalMinutes ? "late" : out > board.outWarnMinutes ? "warn" : "";
  } else if (status === "delivered") {
    text = delivery.deliveredAt
      ? `At ${clockOf(delivery.deliveredAt, board.timezone)}${
          delivery.rideMinutes !== null ? ` · ride ${delivery.rideMinutes} min` : ""
        }`
      : "Delivered";
  } else if (status === "cancelled") {
    text = delivery.cancelReason || "Cancelled";
  }

  const stepIndex = STEPS.findIndex((step) => step.key === status);

  return (
    <div className="dlv-status">
      <div className="dlv-status-row">
        <span className={`dlv-state tone-${meta.tone}`}>{meta.label}</span>
        <span className={`dlv-status-text ${alert ? `is-${alert}` : ""}`}>{text}</span>
      </div>
      {status !== "cancelled" && !compact && (
        <ol className="dlv-steps" aria-label={`Step ${stepIndex + 1} of ${STEPS.length}: ${meta.label}`}>
          {STEPS.map((step, index) => (
            <li
              key={step.key}
              className={index < stepIndex ? "is-done" : index === stepIndex ? "is-now" : ""}
              title={step.label}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

export default function DeliveryCard({ delivery, board, now, canManage, busy, focusId, onAct, onDispatch, onEdit, onAssign, onCancel, onPrint, onOpen }) {
  const status = delivery.status;
  const live = PRE_DISPATCH.includes(status) || status === "out_for_delivery";
  const elapsed = minutesSince(delivery.placedAt, now);
  const tone = live
    ? slaTone(elapsed, board)
    : status === "delivered"
      ? delivery.doorMinutes !== null && delivery.doorMinutes > board.slaMinutes
        ? "late-done"
        : "done"
      : "cancelled";
  const promiseLate =
    live && delivery.promisedBy && new Date(delivery.promisedBy).getTime() < now;
  const riderName = delivery.rider ? delivery.rider.name : delivery.partnerRiderName;
  const riderLabel = delivery.rider
    ? delivery.rider.name
    : delivery.partnerRiderName
      ? `${delivery.channel && delivery.channel.type === "aggregator" ? delivery.channel.name : "Partner"} rider · ${delivery.partnerRiderName}`
      : "No rider yet";
  const compact = status === "delivered";
  const itemsText = delivery.items
    .map((item) => `${item.name}${item.variant ? ` (${item.variant})` : ""}${item.quantity !== 1 ? ` ×${item.quantity}` : ""}`)
    .join(", ");

  const menu = [
    { label: "Edit address & details", onClick: () => onEdit(delivery) },
    ...(PRE_DISPATCH.includes(status) ? [{ label: riderName ? "Change rider" : "Assign a rider", onClick: () => onAssign(delivery) }] : []),
    ...(status === "pending" ? [{ label: "Mark packed", onClick: () => onAct(delivery, "ready") }] : []),
    { label: "Print delivery slip", onClick: () => onPrint(delivery) },
    ...(delivery.orderStatus === "open" ? [{ label: "Open in POS", onClick: () => onOpen(delivery) }] : []),
    ...(status === "out_for_delivery"
      ? [{ label: "Back at the restaurant", onClick: () => onAct(delivery, "ready") }]
      : []),
    ...(status === "delivered"
      ? [{ label: "Not delivered — undo", onClick: () => onAct(delivery, "out_for_delivery") }]
      : []),
    ...(live
      ? [
          { separator: true, label: "sep" },
          { label: "Cancel delivery", danger: true, onClick: () => onCancel(delivery) },
        ]
      : []),
  ];

  let primary = null;

  if (canManage && status === "pending") {
    primary = { label: "Accept", run: () => onAct(delivery, "preparing"), strong: true };
  } else if (canManage && status === "preparing") {
    primary = { label: "Mark packed", run: () => onAct(delivery, "ready") };
  } else if (canManage && status === "ready") {
    primary = {
      label: riderName ? `Dispatch with ${riderName.split(" ")[0]}` : "Dispatch",
      run: () => onDispatch(delivery),
      strong: true,
    };
  } else if (canManage && status === "out_for_delivery") {
    primary = { label: "Delivered", run: () => onAct(delivery, "delivered"), strong: true };
  }

  return (
    <article
      id={`dlv-order-${delivery.id}`}
      className={`dlv-card tone-${tone} st-${status} ${focusId === delivery.id ? "is-focused" : ""}`}
    >
      <header className="dlv-card-head">
        <div className="dlv-card-title">
          <div className="dlv-card-line">
            <span className="dlv-order-no">{delivery.orderNumber}</span>
            <ChannelBadge channel={delivery.channel} />
          </div>
          <span className="dlv-card-sub">
            {delivery.externalRef ? <span className="mono">#{delivery.externalRef}</span> : null}
            {delivery.externalRef ? " · " : ""}
            placed {delivery.earlierDay ? `${dateShort(delivery.placedAt)}, ` : ""}
            {clockOf(delivery.placedAt, board.timezone)}
            {delivery.earlierDay && <span className="dlv-earlier"> · left open from an earlier day</span>}
          </span>
        </div>

        {live ? (
          <div className={`dlv-timer is-${tone}`} title={`${board.slaMinutes} minutes door to door is the target`}>
            <span className="dlv-timer-value">{duration(elapsed)}</span>
            <span className="dlv-timer-label">
              {elapsed > board.slaMinutes ? `${elapsed - board.slaMinutes} min over` : `${board.slaMinutes - elapsed} min left`}
            </span>
          </div>
        ) : status === "delivered" ? (
          <div className={`dlv-timer is-${tone}`}>
            <span className="dlv-timer-value">{duration(delivery.doorMinutes)}</span>
            <span className="dlv-timer-label">door to door</span>
          </div>
        ) : null}
      </header>

      <StatusLine delivery={delivery} board={board} now={now} compact={compact} />

      {compact ? (
        // Done and dusted: who, who took it, and whether the money is in.
        <div className="dlv-card-body">
          <p className="dlv-guest">
            <strong>{delivery.customerName || "Guest"}</strong>
            <span className="muted small">
              {delivery.itemCount} {delivery.itemCount === 1 ? "item" : "items"}
              {delivery.address ? ` · ${delivery.address.split(",").slice(-1)[0].trim()}` : ""}
            </span>
          </p>
          <div className="dlv-money">
            <span className="dlv-rider-name">
              <Icon name="scooter" size={14} />
              {riderLabel}
            </span>
            <span className="dlv-money-right">
              <span className="dlv-amount">{money(delivery.amount, board.currency)}</span>
              <PaymentChip delivery={delivery} currency={board.currency} />
              {canManage ? (
                <ActionMenu items={menu} label={`More for ${delivery.orderNumber}`} />
              ) : null}
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="dlv-card-body">
            <p className="dlv-guest">
              <strong>{delivery.customerName || "Guest"}</strong>
              <GuestPhone key={delivery.id} delivery={delivery} />
            </p>

            {delivery.address ? (
              <p className="dlv-address">
                <Icon name="map-pin" size={14} />
                <span>
                  {delivery.address}
                  {delivery.landmark && <span className="dlv-landmark"> · {delivery.landmark}</span>}
                </span>
              </p>
            ) : (
              <button
                type="button"
                className="dlv-address is-missing"
                onClick={() => onEdit(delivery)}
                disabled={!canManage}
              >
                <Icon name="alert" size={14} />
                <span>
                  {delivery.channel && delivery.channel.type === "aggregator" && !delivery.rider
                    ? "Address is in the partner app"
                    : "No address yet — add it before a rider goes"}
                </span>
              </button>
            )}

            <p className="dlv-items" title={itemsText}>
              <Icon name="box" size={14} />
              <span>
                <b>
                  {delivery.itemCount} {delivery.itemCount === 1 ? "item" : "items"}
                </b>{" "}
                · {itemsText || "no items"}
              </span>
            </p>

            {delivery.notes && <p className="dlv-note">{delivery.notes}</p>}

            <div className="dlv-money">
              <span className="dlv-amount">{moneyExact(delivery.amount, board.currency)}</span>
              <PaymentChip delivery={delivery} currency={board.currency} />
            </div>

            <div className="dlv-rider-line">
              <span className={`dlv-rider-name ${riderName ? "" : status === "ready" ? "is-missing" : "is-none"}`}>
                <Icon name="scooter" size={14} />
                {riderLabel}
              </span>
              {delivery.promisedBy && live && (
                <span className={`dlv-promise ${promiseLate ? "is-late" : ""}`}>
                  <Icon name="clock" size={13} /> promised {clockOf(delivery.promisedBy, board.timezone)}
                </span>
              )}
            </div>
          </div>

          <footer className="dlv-card-actions">
            {primary && (
              <button
                type="button"
                className={`button ${primary.strong ? "dlv-go" : "button-secondary"}`}
                onClick={primary.run}
                disabled={busy}
              >
                {busy ? "Working…" : primary.label}
              </button>
            )}
            {canManage && status === "ready" && !riderName && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => onAssign(delivery)}
                disabled={busy}
                title="Name the rider now; dispatch when the food goes"
              >
                Assign
              </button>
            )}
            {!canManage && <span className="muted small">View only</span>}
            <span className="dlv-card-menu">
              {canManage ? (
                <ActionMenu items={menu} label={`More for ${delivery.orderNumber}`} />
              ) : (
                <button type="button" className="chip-button" onClick={() => onPrint(delivery)}>
                  Print slip
                </button>
              )}
            </span>
          </footer>
        </>
      )}
    </article>
  );
}
