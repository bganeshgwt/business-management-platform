// Walk-in and waitlist entry form.

import { useState } from "react";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { addToWaitlist, updateWaitlistEntry } from "../services/reservation.service";
import { QUOTES } from "./reservationFormat";
import { GuestMatch, PartyStepper } from "./GuestMatch";

// ---------------------------------------------------------------- walk-ins

export default function WalkInEditor({ entry, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    guestMobile: entry?.guestMobile || "",
    guestName: entry?.guestName || "",
    customerId: entry?.customerId || null,
    customerName: entry?.customerName || null,
    partySize: entry?.partySize || 2,
    quotedMinutes: entry?.quotedMinutes ?? 15,
    notes: entry?.notes || "",
  }));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");

    const payload = {
      guestName: form.guestName,
      guestMobile: form.guestMobile || null,
      customerId: form.customerId,
      partySize: Number(form.partySize),
      quotedMinutes: Number(form.quotedMinutes),
      notes: form.notes || null,
    };

    try {
      onSaved(entry ? await updateWaitlistEntry(entry.id, payload) : await addToWaitlist(payload));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={entry ? `Edit ${entry.guestName}` : "Add a walk-in to the waitlist"}
      description="The wait you quote starts counting the moment they join."
      icon="users"
      onClose={onClose}
      width={560}
    >
      <form className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        <div className="rsv-row-2">
          <label className="field">
            <span>Mobile</span>
            <input
              type="tel"
              inputMode="tel"
              value={form.guestMobile}
              onChange={(event) => setForm({ ...form, guestMobile: event.target.value })}
              placeholder="to call them when the table is ready"
              autoFocus={!entry}
              maxLength={20}
            />
          </label>
          <label className="field">
            <span>Name *</span>
            <input
              value={form.guestName}
              onChange={(event) => setForm({ ...form, guestName: event.target.value })}
              required
              maxLength={150}
            />
          </label>
        </div>
        <GuestMatch
          mobile={form.guestMobile}
          customerId={form.customerId}
          customerName={form.customerName}
          onLink={(customer) =>
            setForm((current) => ({
              ...current,
              customerId: customer.id,
              customerName: customer.name,
              guestName: current.guestName || customer.name,
            }))
          }
          onUnlink={() => setForm((current) => ({ ...current, customerId: null, customerName: null }))}
        />
        <div className="field">
          <span>Party size *</span>
          <PartyStepper value={form.partySize} onChange={(value) => setForm({ ...form, partySize: value })} />
        </div>
        <div className="field">
          <span>Quoted wait</span>
          <div className="rsv-choice-row" role="radiogroup" aria-label="Quoted wait">
            {QUOTES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                role="radio"
                aria-checked={Number(form.quotedMinutes) === minutes}
                className={`rsv-choice ${Number(form.quotedMinutes) === minutes ? "is-active" : ""}`}
                onClick={() => setForm({ ...form, quotedMinutes: minutes })}
              >
                {minutes} min
              </button>
            ))}
          </div>
          <small className="muted">Quote honestly — the list turns amber, then red, as the promise runs out.</small>
        </div>
        <label className="field">
          <span>Notes</span>
          <input
            value={form.notes}
            onChange={(event) => setForm({ ...form, notes: event.target.value })}
            maxLength={300}
            placeholder="Outdoor if possible, high chair, will wait at the bar…"
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : entry ? "Save" : "Add to waitlist"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
