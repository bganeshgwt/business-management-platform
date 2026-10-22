import { useState } from "react";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import useBusiness from "../../../../hooks/useBusiness";
import { useDirtyGuard } from "./hooks";
import { toast } from "../../../../services/toast";

// A form in a dialog, the same way on every Business Admin screen: the
// server's sentence shown when it refuses, the button busy while saving, and
// the form marked unsaved once anything is typed (switching business asks).
// `successMessage` (text, or (result) => text) shows a toast once it saved.
export default function FormDialog({ title, description, icon, width = 640, submitLabel = "Save", onSubmit, onClose, onSaved, children, disabled, hideSubmit, successMessage }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirtyState] = useState(false);
  const { confirmLeave, setDirty } = useBusiness();
  useDirtyGuard(dirty);

  const close = async () => {
    if (busy) return;
    if (dirty && !(await confirmLeave())) return;
    setDirty(false);
    onClose();
  };

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await onSubmit();
      setDirtyState(false);
      setDirty(false);
      const message = typeof successMessage === "function" ? successMessage(result) : successMessage;
      if (message) toast.success(message);
      onSaved?.(result);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} description={description} icon={icon} onClose={close} width={width} dismissible={!busy}>
      <form className="form-grid bz-form" onSubmit={submit} onChange={() => setDirtyState(true)}>
        {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
        <fieldset className="bz-fieldset" disabled={busy || disabled}>{children}</fieldset>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={close} disabled={busy}>
            {hideSubmit ? "Close" : "Cancel"}
          </button>
          {!hideSubmit && (
            <button type="submit" className="button" disabled={busy || disabled}>
              {busy ? "Saving…" : submitLabel}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
