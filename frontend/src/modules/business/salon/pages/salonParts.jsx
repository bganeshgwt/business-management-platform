import { useState } from "react";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { balanceText } from "../../../../services/format";
import { Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";

// Pieces the salon screens share (pro pass F-02): a client picker that finds
// by name or phone and adds a new client on the spot.

// value: the chosen contact object (or null). clients: every active client.
// onCreated(contact) also adds the new one to the caller's list.
// hideLabel: the label is only spoken (a compact bar that says "Client" itself).
export function ClientPicker({ value, onChange, clients, onCreated, label = "Client", required, placeholder = "Name or phone", walkIn, autoFocus, hideLabel = false }) {
  const biz = useOpenBusiness();
  const [creating, setCreating] = useState(null);
  const canCreate = biz.can("contacts.create");
  return (
    <>
      <SearchPicker label={hideLabel ? undefined : label} aria-label={hideLabel ? label : undefined} value={value} onChange={onChange} options={clients} required={required} autoFocus={autoFocus}
        getKey={(c) => c.id} getLabel={(c) => c.name}
        getDescription={(c) => [c.phone, Number(c.balance) ? balanceText(c.balance) : ""].filter(Boolean).join(" · ")}
        getKeywords={(c) => `${c.phone || ""} ${String(c.phone || "").replace(/\D/g, "")} ${c.code || ""}`}
        placeholder={walkIn && !value ? "Walk-in — or type a name or phone" : placeholder}
        onCreate={canCreate ? (text) => setCreating(text) : undefined}
        createLabel={(text) => `Add a new client “${text}”`} />
      {creating !== null && (
        <NewClientDialog text={creating} onClose={() => setCreating(null)}
          onSaved={(contact) => { setCreating(null); onCreated?.(contact); onChange(contact); }} />
      )}
    </>
  );
}

function NewClientDialog({ text, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const digits = String(text || "").replace(/\D/g, "");
  const looksLikePhone = digits.length >= 6 && digits.length >= String(text).replace(/\s/g, "").length - 2;
  const [form, setForm] = useState({ name: looksLikePhone ? "" : text, phone: looksLikePhone ? text : "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Not a <form>: this dialog opens inside other forms (Book, New bill).
  const save = async () => {
    if (!form.name.trim()) { setError("Enter the client's name"); return; }
    setBusy(true);
    setError("");
    try {
      onSaved(await businessWrite(biz.id, "contacts", { kind: "customer", name: form.name.trim(), phone: form.phone.trim() || null }));
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="New client" icon="user" onClose={onClose} width={460} dismissible={!busy}>
      <div className="form-grid" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); save(); } }}>
        <ErrorMessage message={error} />
        <Field label="Name" wide><input maxLength={150} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} data-autofocus /></Field>
        <Field label="Phone" wide hint="For booking confirmations and reminders on WhatsApp"><input inputMode="tel" maxLength={30} value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></Field>
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Add client"}</button>
        </div>
      </div>
    </Modal>
  );
}
