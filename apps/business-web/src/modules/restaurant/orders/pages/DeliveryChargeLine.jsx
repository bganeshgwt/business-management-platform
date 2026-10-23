import { useState } from "react";
import { moneyExact } from "@bmp/shared/format";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { restoreDeliveryCharge, waiveDeliveryCharge } from "../services/order.service";
import Icon from "@bmp/ui/Icon";
import { channelForCharge, previewCharge } from "../services/deliveryCharge";

// The trip charge on a delivery, shown in the cart before saving.
//
// Before the order is saved the till works it out the way the server will
// (the channel's charge, nothing from "free above"), so the cashier can tell
// the guest on the phone; once saved, the order's own figure is shown — the
// server's, which is the one that is charged. A saved, open order can have
// the charge waived with a reason (a manager, or their PIN) or charged again.
// A delivery with no channel picked is the restaurant's own delivery.
export default function DeliveryChargeLine({ channels, channelId, foodTotal, savedOrder, changed, currency, onSaved }) {
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const channel = channelForCharge(channels, channelId);
  const preview = previewCharge(channel, foodTotal);
  const saved = savedOrder && savedOrder.orderType === "delivery" && savedOrder.orderStatus === "open" ? savedOrder : null;
  // The saved figure while nothing that moves it has changed on screen.
  const shown = saved && !changed ? { charge: saved.deliveryCharge, free: false, short: null } : preview;
  const waived = Boolean(saved && saved.deliveryChargeWaived);
  const rate = saved && !changed ? saved.deliveryChargeTaxPercent : null;

  if (!waived && shown.charge === 0 && !shown.free && !(channel && channel.deliveryCharge > 0)) {
    // Nothing is ever charged on this channel (Swiggy collects its own fee).
    return null;
  }

  const waive = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const result = await withApproval(
        (headers) => waiveDeliveryCharge(saved.id, reason.trim(), headers),
        `Waive the ${moneyExact(saved.deliveryCharge, currency)} delivery charge on ${saved.orderNumber}`,
        { permission: "orders.waive_delivery_charge", scope: { orderId: saved.id, amount: saved.deliveryCharge } }
      );
      setWaiving(false);
      setReason("");
      onSaved(result.data, result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    setError("");

    try {
      const result = await restoreDeliveryCharge(saved.id);
      onSaved(result.data, result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pos-delivery-charge">
      <div className="pos-delivery-charge-row">
        <span>
          <Icon name="truck" size={14} /> Delivery charge
          {channel && <span className="muted small"> · {channel.name}</span>}
        </span>
        <strong className={waived || shown.free ? "pos-charge-free" : ""}>
          {waived ? "Waived" : shown.free ? "Free" : moneyExact(shown.charge, currency)}
        </strong>
      </div>
      <p className="muted small pos-delivery-charge-note">
        {waived
          ? `Reason: ${saved.deliveryChargeWaivedReason}.`
          : shown.free
            ? `Free delivery above ${moneyExact(channel.deliveryFreeAbove, currency)}.`
            : shown.short !== null && shown.short > 0
              ? `${moneyExact(shown.short, currency)} more of food for free delivery. `
              : ""}
        {!waived && !shown.free && shown.charge > 0 && `Plus GST${rate !== null ? ` at ${rate}%` : " at the food's rate"}, on the bill.`}
      </p>
      {saved && !changed && !waiving && (
        <div className="pos-delivery-charge-actions">
          {waived ? (
            <button type="button" className="link-button" onClick={restore} disabled={busy}>
              Charge it again
            </button>
          ) : (
            saved.deliveryCharge > 0 && (
              <button type="button" className="link-button" onClick={() => setWaiving(true)} disabled={busy}>
                Waive delivery charge
              </button>
            )
          )}
        </div>
      )}
      {waiving && (
        <form className="pos-delivery-waive" onSubmit={waive}>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why? Regular guest, late delivery…"
            maxLength={200}
            autoFocus
            aria-label="Reason for waiving the delivery charge"
          />
          <button type="submit" className="button button-sm" disabled={busy || !reason.trim()}>
            {busy ? "Waiving…" : "Waive"}
          </button>
          <button type="button" className="button button-secondary button-sm" onClick={() => setWaiving(false)}>
            Keep it
          </button>
        </form>
      )}
      {error && <p className="pos-delivery-charge-error">{error}</p>}
    </div>
  );
}
