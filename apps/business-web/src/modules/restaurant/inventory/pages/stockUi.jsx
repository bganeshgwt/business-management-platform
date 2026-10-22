import { useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";

// Small pieces shared by the stock and purchasing screens, so a status chip,
// a tile or a "why?" box looks the same on every one of them — and the same
// as on every other screen, since each one is drawn by the shared design
// system (StatTile, badges) rather than by stock styles of its own.

// The sections of a page (Items / Stock counts / Closing stock). A tab may
// carry an Icon name, a count shown as a small pill after its words, and a
// `short` name for a phone ("Register" for "Purchase register"). On a phone
// the tabs wrap as pills instead of scrolling sideways, so every section and
// the one that is open stay in sight (stock.css).
export function Tabs({ tabs, active, onChange, label }) {
  return (
    // data-motion-tabs: the active underline glides from the old tab to the
    // new one (the shared motion system; off with reduced motion).
    <div className="stk-tabs" role="tablist" aria-label={label} data-motion-tabs>
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          key={tab.key}
          aria-selected={active === tab.key}
          className={`stk-tab ${active === tab.key ? "is-active" : ""}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.icon && <Icon name={tab.icon} size={16} />}
          {tab.short ? (
            <>
              <span className="stk-tab-long">{tab.label}</span>
              <span className="stk-tab-short">{tab.short}</span>
            </>
          ) : (
            tab.label
          )}
          {tab.count !== undefined && tab.count !== null && <span className="stk-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

// One figure. The screens pass a tone only when the figure needs attention
// (a count of late orders that is above zero), so no tone means a calm,
// neutral tile.
export function Tile({ label, value, note, tone, icon }) {
  return <StatTile icon={icon} tone={tone || "neutral"} label={label} value={value} note={note} />;
}

// Status as a dot and a word, never colour alone. The tones are the ones the
// stock screens have always used; "muted" is the quiet grey of a cancelled or
// voided record, and "violet" a fifth hue for an end state that is neither
// good nor bad (an order closed short).
const BADGE_TONES = {
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  info: "badge-info",
  primary: "badge-primary",
  muted: "badge-neutral",
  violet: "stk-chip-violet",
};

export function Chip({ tone, children, title }) {
  return (
    <span className={`badge status-badge stk-chip ${BADGE_TONES[tone] || "badge-neutral"}`} title={title}>
      <span className="badge-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

// Asks "why?" before something that changes the books: voiding a bill,
// a payment or a return. The reason is kept with the record.
export function ReasonDialog({ title, message, label = "Reason", placeholder, confirmLabel, danger = true, onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onCancel} width={460} icon={danger ? "alert" : "edit"}>
      <form className="stack" onSubmit={submit}>
        <ErrorMessage message={error} />
        {message && <p>{message}</p>}
        <label className="field">
          <span>{label} *</span>
          <textarea
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={placeholder}
            maxLength={200}
            required
            autoFocus
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Keep it
          </button>
          <button
            type="submit"
            className={`button ${danger ? "button-danger" : ""}`}
            disabled={busy || !reason.trim()}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The places stock can be held: the main store and outlets with their own.
export function StoreSelect({ stores, value, onChange, label = "Store", includeAll = false, id }) {
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {includeAll && <option value="all">All stores</option>}
        {stores
          .filter((store) => !store.outletId || store.ownStore)
          .map((store) => (
            <option key={store.outletId || "main"} value={store.outletId ? String(store.outletId) : "main"}>
              {store.name}
            </option>
          ))}
      </select>
    </label>
  );
}
