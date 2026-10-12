// Packed, details and cancel dialogs.

import { useState } from "react";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { money } from "../../../../services/format";
import { setDeliveryStatus, updateDelivery } from "../services/delivery.service";
import { CANCEL_REASONS, ETAS } from "./deliveryFormat";

// "The kitchen says it is still cooking — is the bag really at the pass?"
export function PackedModal({ delivery, onClose, onConfirm }) {
  const tickets = delivery.kitchenOpenTickets;

  return (
    <Modal
      title={`Is ${delivery.orderNumber} packed?`}
      description="The kitchen has not finished it yet."
      icon="box"
      onClose={onClose}
      width={480}
    >
      <div className="stack dlv-confirm">
        <p>
          The kitchen display still shows {delivery.orderNumber} as{" "}
          <b>{delivery.kitchenStatus === "preparing" ? "cooking" : "not started"}</b> ({tickets} open{" "}
          {tickets === 1 ? "ticket" : "tickets"}).
        </p>
        <p className="muted small">
          Mark it packed only if the bag really is at the pass — the cook may have forgotten to bump it. Once it goes
          out, its tickets clear from the kitchen screen.
        </p>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Not yet
          </button>
          <button type="button" className="button" onClick={onConfirm}>
            Yes, it is packed
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function DetailsModal({ delivery, board, onClose, onDone }) {
  const channels = board.channels.filter(
    (channel) => channel.status === "active" || (delivery.channel && channel.id === delivery.channel.id)
  );
  const riders = board.riders.filter((rider) => rider.active || (delivery.rider && rider.id === delivery.rider.id));

  const [form, setForm] = useState({
    channelId: delivery.channel ? String(delivery.channel.id) : "",
    externalRef: delivery.externalRef || "",
    customerName: delivery.customerName || "",
    customerMobile: delivery.customerMobile || "",
    address: delivery.address || "",
    landmark: delivery.landmark || "",
    etaMinutes: delivery.etaMinutes ? String(delivery.etaMinutes) : "",
    rider: delivery.rider ? String(delivery.rider.id) : delivery.partnerRiderName ? "partner" : "",
    partnerRiderName: delivery.partnerRiderName || "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const channel = channels.find((one) => String(one.id) === form.channelId);
  const aggregator = channel && channel.type === "aggregator";
  // Food on the road, or already at the door, was carried by someone: the
  // rider can be corrected but not taken off.
  const riderFixed =
    delivery.status === "out_for_delivery" ||
    (delivery.status === "delivered" && Boolean(delivery.rider || delivery.partnerRiderName));
  const ownRiderOut = delivery.status === "out_for_delivery" && form.rider && form.rider !== "partner";

  const submit = async (event) => {
    event.preventDefault();
    setError("");

    // Only what changed is sent: the server treats "not sent" as "leave it".
    const payload = {};
    const text = (value) => value.trim() || null;

    if (form.channelId !== (delivery.channel ? String(delivery.channel.id) : "")) {
      payload.channelId = form.channelId ? Number(form.channelId) : null;
    }

    [
      ["externalRef", delivery.externalRef],
      ["customerName", delivery.customerName],
      ["customerMobile", delivery.customerMobile],
      ["address", delivery.address],
      ["landmark", delivery.landmark],
    ].forEach(([key, before]) => {
      if (text(form[key]) !== (before || null)) {
        payload[key] = text(form[key]);
      }
    });

    const eta = form.etaMinutes ? Number(form.etaMinutes) : null;

    if (eta !== (delivery.etaMinutes || null)) {
      payload.etaMinutes = eta;
    }

    const riderBefore = delivery.rider ? String(delivery.rider.id) : delivery.partnerRiderName ? "partner" : "";

    if (form.rider === "partner") {
      if (!form.partnerRiderName.trim()) {
        setError("Type the partner rider's name");
        return;
      }

      if (riderBefore !== "partner" || form.partnerRiderName.trim() !== delivery.partnerRiderName) {
        payload.partnerRiderName = form.partnerRiderName.trim();
      }
    } else if (form.rider !== riderBefore) {
      if (form.rider) {
        payload.riderId = Number(form.rider);
      } else {
        payload.riderId = null;
        payload.partnerRiderName = null;
      }
    }

    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }

    setSaving(true);

    try {
      const result = await updateDelivery(delivery.id, payload);
      onDone(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${delivery.orderNumber} · delivery details`}
      description="Where it goes, which channel it came from, and when it was promised."
      icon="map-pin"
      onClose={onClose}
      width={640}
    >
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />

        <div className="form-grid dlv-form">
          <label className="field">
            <span>Channel</span>
            <select value={form.channelId} onChange={set("channelId")}>
              <option value="">— Not set —</option>
              {channels.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                  {one.commissionPercent > 0 ? ` (${one.commissionPercent}%)` : ""}
                  {one.status !== "active" ? " — switched off" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{aggregator ? `${channel.name} order ID` : "Partner order ID"}</span>
            <input
              value={form.externalRef}
              onChange={set("externalRef")}
              maxLength={60}
              placeholder={aggregator ? "What their support desk asks for" : "Optional"}
            />
          </label>

          <label className="field">
            <span>Guest name</span>
            <input value={form.customerName} onChange={set("customerName")} maxLength={150} />
          </label>

          <label className="field">
            <span>Guest mobile</span>
            <input
              value={form.customerMobile}
              onChange={set("customerMobile")}
              maxLength={20}
              inputMode="tel"
              placeholder="98480 12345"
            />
          </label>

          <label className="field field-wide">
            <span>
              Delivery address
              {ownRiderOut && <span className="muted small"> · your rider is on the way there, so it cannot be blank</span>}
            </span>
            <textarea
              rows={2}
              value={form.address}
              onChange={set("address")}
              maxLength={500}
              required={Boolean(ownRiderOut)}
              placeholder="Flat / house, building, street, area"
            />
          </label>

          <label className="field">
            <span>Landmark</span>
            <input
              value={form.landmark}
              onChange={set("landmark")}
              maxLength={200}
              placeholder="Opp. the temple, gate 2…"
            />
          </label>

          <label className="field">
            <span>Promised in</span>
            <select value={form.etaMinutes} onChange={set("etaMinutes")}>
              <option value="">— No promise —</option>
              {[...new Set([...ETAS, ...(delivery.etaMinutes ? [delivery.etaMinutes] : [])])]
                .sort((a, b) => a - b)
                .map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} minutes from ordering
                  </option>
                ))}
            </select>
          </label>

          <label className="field">
            <span>Rider</span>
            <select value={form.rider} onChange={set("rider")}>
              {!riderFixed && <option value="">— Not assigned —</option>}
              {riders.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                  {one.state === "on_run" ? " (on a run)" : ""}
                </option>
              ))}
              <option value="partner">Partner rider…</option>
            </select>
          </label>

          {form.rider === "partner" && (
            <label className="field">
              <span>Partner rider's name</span>
              <input value={form.partnerRiderName} onChange={set("partnerRiderName")} maxLength={100} />
            </label>
          )}
        </div>

        {channel && channel.commissionPercent > 0 && (
          <p className="muted small">
            {channel.name} keeps {channel.commissionPercent}% of this bill (
            {money((delivery.amount * channel.commissionPercent) / 100, board.currency)}).
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : "Save details"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CancelModal({ delivery, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [other, setOther] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const finalReason = reason === "other" ? other.trim() : reason;

  const submit = async (event) => {
    event.preventDefault();

    if (!finalReason) {
      setError("Say why — it is how you find out which channel or area keeps going wrong");
      return;
    }

    setSaving(true);

    try {
      const result = await setDeliveryStatus(delivery.id, { status: "cancelled", reason: finalReason });
      onDone(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Cancel ${delivery.orderNumber}?`}
      description="The order comes off the board and out of the kitchen."
      icon="x-circle"
      onClose={onClose}
      width={520}
    >
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />

        <p className="muted">
          {delivery.orderStatus === "open"
            ? "The order is not billed yet, so it is cancelled too and the kitchen stops cooking it."
            : `This order already has a bill (${delivery.billNumbers}). The delivery is cancelled here; void the bill in Bills if the money must go back.`}
        </p>

        <div className="dlv-reasons" role="radiogroup" aria-label="Reason">
          {[...CANCEL_REASONS, "other"].map((option) => (
            <button
              type="button"
              key={option}
              role="radio"
              aria-checked={reason === option}
              className={`dlv-reason ${reason === option ? "is-active" : ""}`}
              onClick={() => setReason(option)}
            >
              {option === "other" ? "Something else…" : option}
            </button>
          ))}
        </div>

        {reason === "other" && (
          <label className="field">
            <span>Reason</span>
            <input value={other} onChange={(event) => setOther(event.target.value)} maxLength={200} autoFocus />
          </label>
        )}

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep it
          </button>
          <button type="submit" className="button button-danger" disabled={saving}>
            {saving ? "Cancelling…" : "Cancel delivery"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
