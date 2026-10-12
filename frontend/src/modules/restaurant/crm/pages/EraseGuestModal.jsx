import { useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { eraseGuest } from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { count } from "../../../../services/format";

// A guest's request to have their data deleted (DPDP Act 2023).
//
// The record is not deleted: the bills on it must be kept for GST, and the
// visits and sales on reports must still add up. Everything that says who the
// person was is removed instead, here and in every copy the system made.
export default function EraseGuestModal({ guest, onClose, onErased }) {
  const [reason, setReason] = useState("");
  const [sure, setSure] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const erase = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const result = await eraseGuest(guest.id, reason.trim());
      const points = result.data.pointsCancelled;
      onErased(
        `${guest.name}'s personal details were erased. Their bills are kept${points ? `; ${count(points)} points were cancelled` : ""}.`
      );
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Erase ${guest.name}'s personal details`}
      icon="eye-off"
      description="For a guest who asked to have their data removed (DPDP Act 2023)."
      onClose={onClose}
      width={560}
    >
      <form className="stack" onSubmit={erase}>
        <ErrorMessage message={error} />

        <div className="crm-erase-lists">
          <div className="crm-erase-removed">
            <h3 className="crm-mini-heading">
              <Icon name="x-circle" size={15} /> Removed
            </h3>
            <ul className="small">
              <li>Name, mobile, email, birthday and address</li>
              <li>Notes, tags, allergies, company name and GSTIN</li>
              <li>Their name and number on feedback, complaints, orders and bookings</li>
              {guest.loyaltyPoints > 0 && <li>{count(guest.loyaltyPoints)} points still owed (cancelled)</li>}
            </ul>
          </div>
          <div className="crm-erase-kept">
            <h3 className="crm-mini-heading">
              <Icon name="check-circle" size={15} /> Kept
            </h3>
            <ul className="small">
              <li>Every bill and its amounts (GST law)</li>
              {guest.gstin && <li>On tax invoices already issued: the company and GSTIN they were made out to</li>}
              <li>Visit counts and sales in reports</li>
              <li>The record, as “Erased guest #{guest.id}”</li>
            </ul>
          </div>
        </div>

        <label className="field">
          <span>How did they ask? *</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            maxLength={200}
            placeholder="Email to the manager on 24 Sep"
          />
          <small className="muted">Kept on the activity log. Do not write their name or number here.</small>
        </label>

        <label className="checkbox crm-erase-sure">
          <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
          <span>I understand this cannot be undone.</span>
        </label>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-danger" disabled={saving || !sure || !reason.trim()}>
            <Icon name="eye-off" size={16} />
            {saving ? "Erasing…" : "Erase personal details"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
