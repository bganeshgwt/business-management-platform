import { useCallback, useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import useAuth from "../../../../hooks/useAuth";
import { getErrorMessage } from "../../../../services/api";
import { listGuestAddresses, removeGuestAddress, updateGuestAddress } from "../../online/services/guestAddress.service";
import { dayMonth } from "../../../../services/floorTables";
import "../styles/guest-addresses.css";

const LABELS = ["Home", "Office", "Other"];

// A guest's saved delivery addresses in the guest book: at most
// five, newest used first. They are saved by themselves when a delivery goes
// to a new address; here they are corrected or removed. The full text is for
// people who may see contact details; others see the label and the area.
export default function GuestAddresses({ customerId, canManage }) {
  const { hasPermission } = useAuth();
  const canSeeContacts = hasPermission("customers.contact");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      listGuestAddresses(customerId)
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [customerId]
  );

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return error ? <p className="alert">{error}</p> : null;
  }

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const result = await updateGuestAddress(customerId, editing.id, {
        label: editing.label,
        address: editing.address,
        landmark: editing.landmark || null,
      });
      setMessage(result.message);
      setEditing(null);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (address) => {
    setBusy(true);
    setError("");

    try {
      const result = await removeGuestAddress(customerId, address.id);
      setMessage(result.message);
      setRemoving(null);
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="gad-card" aria-label="Saved delivery addresses">
      <header className="gad-head">
        <span>
          <Icon name="map-pin" size={15} /> Delivery addresses
          <span className="muted small">
            {" "}
            · {data.addresses.length} of {data.max}
          </span>
        </span>
        {!canSeeContacts && data.addresses.length > 0 && (
          <span className="muted small">Full addresses are shown to managers only.</span>
        )}
      </header>

      {error && <p className="alert">{error}</p>}
      {message && (
        <p className="alert alert-success" role="status">
          {message}
        </p>
      )}

      {data.addresses.length === 0 ? (
        <p className="muted small gad-empty">
          None yet. An address is kept here by itself when a delivery for this guest goes to it.
        </p>
      ) : (
        <ul className="gad-list">
          {data.addresses.map((address) =>
            editing && editing.id === address.id ? (
              <li key={address.id} className="gad-item is-editing">
                <form className="gad-form" onSubmit={save}>
                  <div className="segmented" role="radiogroup" aria-label="Label">
                    {LABELS.map((label) => (
                      <button
                        key={label}
                        type="button"
                        role="radio"
                        aria-checked={editing.label === label}
                        className={`segment ${editing.label === label ? "is-active" : ""}`}
                        onClick={() => setEditing({ ...editing, label })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="field">
                    <span>Address *</span>
                    <textarea
                      rows={2}
                      value={editing.address}
                      onChange={(event) => setEditing({ ...editing, address: event.target.value })}
                      maxLength={500}
                      required
                    />
                  </label>
                  <label className="field">
                    <span>Landmark</span>
                    <input
                      value={editing.landmark || ""}
                      onChange={(event) => setEditing({ ...editing, landmark: event.target.value })}
                      maxLength={200}
                    />
                  </label>
                  <div className="form-actions">
                    <button type="button" className="button button-secondary button-sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="button button-sm" disabled={busy || !editing.address.trim()}>
                      {busy ? "Saving…" : "Save address"}
                    </button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={address.id} className="gad-item">
                <span className="gad-label">
                  <Icon name={address.label === "Office" ? "store" : "home"} size={13} /> {address.label}
                </span>
                <span className="gad-text">
                  {address.address}
                  {address.landmark && <span className="muted small">Landmark: {address.landmark}</span>}
                  <span className="muted small gad-used">
                    Used {address.useCount} {address.useCount === 1 ? "time" : "times"} · last {dayMonth(address.lastUsedAt)}
                  </span>
                </span>
                {canManage && (
                  <span className="gad-actions">
                    {removing === address.id ? (
                      <>
                        <span className="small">Remove?</span>
                        <button type="button" className="button button-danger button-sm" onClick={() => remove(address)} disabled={busy}>
                          Remove
                        </button>
                        <button type="button" className="button button-secondary button-sm" onClick={() => setRemoving(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        {canSeeContacts && (
                          <button type="button" className="chip-button" onClick={() => setEditing({ ...address })}>
                            <Icon name="edit" size={13} /> Edit
                          </button>
                        )}
                        <button type="button" className="chip-button" onClick={() => setRemoving(address.id)}>
                          <Icon name="trash" size={13} /> Remove
                        </button>
                      </>
                    )}
                  </span>
                )}
              </li>
            )
          )}
        </ul>
      )}
    </section>
  );
}
