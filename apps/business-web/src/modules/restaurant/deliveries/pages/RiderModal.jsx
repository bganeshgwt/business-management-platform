// Assigning a rider.

import { useState } from "react";
import { Link } from "react-router-dom";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { money } from "@bmp/shared/format";
import { dispatchDeliveries, updateDelivery } from "../services/delivery.service";
import { STATUS, duration, initials, minutesSince } from "./deliveryFormat";
import { ChannelBadge } from "./DeliveryParts";
import "../styles/deliveries.css";

// ---------------------------------------------------------------- modals

function RiderPicker({ riders, now, value, onChange, partnerName, onPartnerName, board }) {
  return (
    <div className="dlv-picker" role="radiogroup" aria-label="Rider">
      {riders.map((rider) => {
        const runMinutes = rider.runStartedAt ? minutesSince(rider.runStartedAt, now) : null;

        return (
          <label key={rider.id} className={`dlv-pick ${value === String(rider.id) ? "is-picked" : ""}`}>
            <input
              type="radio"
              name="rider"
              value={rider.id}
              checked={value === String(rider.id)}
              onChange={() => onChange(String(rider.id))}
            />
            <span className="dlv-avatar small" aria-hidden="true">
              {initials(rider.name)}
            </span>
            <span className="dlv-pick-body">
              <strong>{rider.name}</strong>
              <span className="muted small">
                {rider.state === "on_run"
                  ? `On a run with ${rider.outNow.length} · ${duration(runMinutes)}`
                  : "Free now"}{" "}
                · {rider.deliveredToday} today
              </span>
            </span>
          </label>
        );
      })}

      <label className={`dlv-pick ${value === "partner" ? "is-picked" : ""}`}>
        <input
          type="radio"
          name="rider"
          value="partner"
          checked={value === "partner"}
          onChange={() => onChange("partner")}
        />
        <span className="dlv-avatar small is-partner" aria-hidden="true">
          <Icon name="scooter" size={14} />
        </span>
        <span className="dlv-pick-body">
          <strong>Partner rider</strong>
          <span className="muted small">Swiggy or Zomato's own rider, or a Porter / Dunzo pickup</span>
        </span>
      </label>

      {value === "partner" && (
        <label className="field">
          <span>Partner rider's name</span>
          <input
            value={partnerName}
            maxLength={100}
            placeholder="e.g. Venkatesh"
            onChange={(event) => onPartnerName(event.target.value)}
            autoFocus
          />
        </label>
      )}

      {riders.length === 0 && (
        <p className="muted small">
          No one is in the delivery team yet. Add riders under{" "}
          <Link to="/staff">Staff</Link> (department: delivery), or use a partner rider.
        </p>
      )}
      {board && board.dayOpen === false && <p className="muted small">The business day is closed.</p>}
    </div>
  );
}

export default function RiderModal({ mode, board, delivery, initialOrderIds = [], initialRiderId, now, onClose, onDone }) {
  const riders = board.riders.filter((rider) => rider.active);
  const startRider = initialRiderId
    ? String(initialRiderId)
    : delivery && delivery.rider
      ? String(delivery.rider.id)
      : delivery && delivery.partnerRiderName
        ? "partner"
        : "";

  const byAge = (a, b) => new Date(a.placedAt) - new Date(b.placedAt);
  // Only packed bags can go in a run. Orders still in the kitchen are shown
  // (so the desk sees what is coming) but cannot be ticked.
  const candidates = board.orders.filter((order) => order.status === "ready").sort(byAge);
  const cooking = board.orders
    .filter((order) => order.status === "pending" || order.status === "preparing")
    .sort(byAge);

  const [rider, setRider] = useState(startRider);
  const [partnerName, setPartnerName] = useState((delivery && delivery.partnerRiderName) || "");
  const [picked, setPicked] = useState(
    () => new Set(initialOrderIds.filter((id) => candidates.some((order) => order.id === id)))
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const ownRider = rider && rider !== "partner";
  const chosen = candidates.filter((order) => picked.has(order.id));
  const noAddress = ownRider ? chosen.filter((order) => !order.address) : [];

  const toggle = (id) => {
    const next = new Set(picked);

    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }

    setPicked(next);
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");

    if (!rider) {
      setError("Choose who is taking it");
      return;
    }

    if (rider === "partner" && !partnerName.trim()) {
      setError("Type the partner rider's name, so the desk knows who has the food");
      return;
    }

    const who = rider === "partner" ? { partnerRiderName: partnerName.trim() } : { riderId: Number(rider) };

    setSaving(true);

    try {
      if (mode === "assign") {
        const result = await updateDelivery(delivery.id, who);
        onDone(`${result.data.orderNumber} is with ${rider === "partner" ? partnerName.trim() : result.data.rider.name}`);
      } else {
        if (chosen.length === 0) {
          setError("Pick at least one order for this run");
          setSaving(false);
          return;
        }

        const result = await dispatchDeliveries({ orderIds: chosen.map((order) => order.id), ...who });
        onDone(result.message);
      }
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  const title =
    mode === "assign"
      ? `Rider for ${delivery.orderNumber}`
      : initialRiderId
        ? `Send ${riders.find((one) => one.id === initialRiderId)?.name || "a rider"} on a run`
        : "Dispatch";

  return (
    <Modal
      title={title}
      description={mode === "assign" ? "Who takes this order out." : "Pick the packed bags and the rider taking them."}
      icon="scooter"
      onClose={onClose}
      width={620}
    >
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />

        {mode === "assign" && (
          <p className="muted small">
            The rider waits for the food. It only counts as out for delivery once you press Dispatch.
          </p>
        )}

        <RiderPicker
          riders={riders}
          now={now}
          value={rider}
          onChange={setRider}
          partnerName={partnerName}
          onPartnerName={setPartnerName}
          board={board}
        />

        {mode === "dispatch" && (
          <fieldset className="dlv-run">
            <legend>
              Orders in this run <span className="muted small">— one rider can carry several</span>
            </legend>
            {candidates.length === 0 ? (
              <p className="muted small">
                No bag is packed yet. Mark an order packed on its card when it is at the pass, then send it out.
              </p>
            ) : (
              <ul className="dlv-run-list">
                {candidates.map((order) => (
                  <li key={order.id}>
                    <label className={`dlv-run-item ${picked.has(order.id) ? "is-picked" : ""}`}>
                      <input type="checkbox" checked={picked.has(order.id)} onChange={() => toggle(order.id)} />
                      <span className="dlv-run-main">
                        <b>{order.orderNumber}</b> <ChannelBadge channel={order.channel} />{" "}
                        <span className={`dlv-state tone-${STATUS[order.status].tone}`}>{STATUS[order.status].label}</span>
                        <span className="muted small dlv-run-addr">
                          {order.customerName || "Guest"} · {order.address || "no address"}
                          {order.rider && String(order.rider.id) !== rider ? ` · assigned to ${order.rider.name}` : ""}
                        </span>
                      </span>
                      <span className="dlv-run-money">{money(order.amount, board.currency)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}

            {cooking.length > 0 && (
              <details className="dlv-run-later">
                <summary>
                  {cooking.length} still in the kitchen — {cooking.length === 1 ? "it goes" : "they go"} once packed
                </summary>
                <ul className="dlv-run-list">
                  {cooking.map((order) => (
                    <li key={order.id}>
                      <div className="dlv-run-item is-disabled" aria-disabled="true">
                        <span className="dlv-run-main">
                          <b>{order.orderNumber}</b> <ChannelBadge channel={order.channel} />{" "}
                          <span className={`dlv-state tone-${STATUS[order.status].tone}`}>{STATUS[order.status].label}</span>
                          <span className="muted small dlv-run-addr">
                            {order.customerName || "Guest"} · placed {minutesSince(order.placedAt, now)} min ago
                          </span>
                        </span>
                        <span className="dlv-run-money">{money(order.amount, board.currency)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </fieldset>
        )}

        {noAddress.length > 0 && (
          <div className="alert alert-notice">
            {noAddress.map((order) => order.orderNumber).join(", ")} {noAddress.length === 1 ? "has" : "have"} no
            address. Add it from the card's menu before your rider sets off.
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving || (mode === "dispatch" && candidates.length === 0)}>
            {saving
              ? "Working…"
              : mode === "assign"
                ? "Assign rider"
                : chosen.length > 1
                  ? `Dispatch ${chosen.length} orders`
                  : "Dispatch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
