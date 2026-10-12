import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import { cancelOrder } from "../services/order.service";
import { printChangeSlips } from "../services/kotSlips";
import { CANCEL_REASONS, reasonLabel } from "../services/orderCart";
import { settingsQuery } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import useAuth from "../../../../hooks/useAuth";
import "../styles/orders.css";

// Cancelling a whole running order from a list (the dashboard's panels, the
// Orders screen's row menu): the same reasons, the same manager PIN for food
// the kitchen already has, and the same change slip to the kitchen as the
// order screen. `order` needs { id, orderNumber } and, for the wording,
// tableNo and earlierDay.
export default function CancelOrderDialog({ order, onClose, onCancelled }) {
  const { user } = useAuth();
  const settings = useQuery(settingsQuery());
  const [code, setCode] = useState(order.earlierDay ? "other" : "");
  const [note, setNote] = useState(order.earlierDay ? "Left open from an earlier day" : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ready = (code && code !== "other") || note.trim().length > 0;

  const submit = async () => {
    setSaving(true);
    setError("");

    try {
      const reason = code && code !== "other" ? `${reasonLabel(code)}${note.trim() ? ` — ${note.trim()}` : ""}` : note.trim();
      const updated = await withApproval(
        (headers) => cancelOrder(order.id, reason, code || undefined, headers),
        `Cancel ${order.orderNumber}`
      );
      let slipNote = "";

      try {
        const result = await printChangeSlips([order.id], {
          restaurantName: user ? user.restaurantName : "",
          paperWidth: (settings.data && settings.data.printPaperWidth) || "80mm",
        });
        slipNote = result.problem || result.note || "";
      } catch {
        slipNote = "";
      }

      onCancelled?.(updated, slipNote);
    } catch (err) {
      setError(err.approvalCancelled ? "The order was not cancelled: the manager's approval was cancelled." : getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Cancel ${order.orderNumber}?`}
      icon="x-circle"
      description={order.tableNo ? `Table ${order.tableNo}` : undefined}
      onClose={saving ? () => undefined : onClose}
      width={460}
      footer={
        <>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
            Keep the order
          </button>
          <button type="button" className="button button-danger" onClick={submit} disabled={saving || !ready}>
            {saving ? "Cancelling…" : "Cancel order"}
          </button>
        </>
      }
    >
      <div className="stack">
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <p className="muted small">
          The order is closed without a bill and the table is freed. Food the kitchen already has is recorded on the
          cancelled-after-KOT report and may need a manager&apos;s PIN.
        </p>
        <div className="oc-reasons" role="radiogroup" aria-label="Why is the order being cancelled?">
          {CANCEL_REASONS.map((reason) => (
            <button
              type="button"
              key={reason.code}
              role="radio"
              aria-checked={code === reason.code}
              className={`chip-button oc-reason ${code === reason.code ? "is-active" : ""}`}
              onClick={() => setCode(reason.code)}
            >
              {reason.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>{code && code !== "other" ? "Anything to add (optional)" : "Reason for cancelling"}</span>
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={150} />
        </label>
        <p className="muted small">
          <Icon name="info" size={14} /> The activity log records who cancelled it and why.
        </p>
      </div>
    </Modal>
  );
}
