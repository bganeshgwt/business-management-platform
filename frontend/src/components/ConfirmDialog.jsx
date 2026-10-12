import Modal from "./Modal";
import Icon from "./Icon";

// Used instead of window.confirm so delete prompts match the rest of the UI.
// For a one-off question in an event handler, useConfirm() (services/confirm.js)
// opens this same dialog and returns a promise — no state to keep.
//
// The warning mark and the red button say "this is the one you cannot take
// back" before the words are read; Cancel sits first, where a hurried hand
// lands, and takes focus, so a stray Enter never confirms.
//
// tone      "danger" (default: red button, warning mark) or "primary" (an
//           ordinary yes/no such as "Switch to this outlet?")
// busy      while the action runs: the button says "Working…" and Cancel,
//           Escape and the backdrop do nothing, so it cannot close half-done.
// confirmLabel defaults to "Delete" (most callers delete something); pass the
//           verb for anything else — "Switch off", "Void bill".
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  busy,
  tone = "danger",
}) {
  const danger = tone !== "primary";

  return (
    <Modal title={title} onClose={onCancel} width={420} dismissible={!busy} initialFocus="container" className="confirm-dialog">
      <div className="confirm-body">
        <span className={`confirm-mark ${danger ? "" : "is-primary"}`} aria-hidden="true">
          <Icon name={danger ? "alert" : "info"} size={20} />
        </span>
        <div className="confirm-text">{typeof message === "string" ? <p>{message}</p> : message}</div>
      </div>
      <div className="form-actions">
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy} data-autofocus>
          {cancelLabel}
        </button>
        <button type="button" className={`button ${danger ? "button-danger" : "button-primary"}`} onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
