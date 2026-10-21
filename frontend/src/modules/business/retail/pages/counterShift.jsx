import { useCallback, useEffect, useState } from "react";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { Field } from "../../core/pages/ui";

// The cashier's own shift at this counter: open it with the float in the
// drawer, close it by counting the cash. The count is blind: the cashier
// types what they counted first, and only then hears whether the drawer is
// short or over (and says why). Checked by the server against this
// cashier's own cash sales, collections, refunds and expenses.
export default function ShiftButton({ biz, locationId }) {
  const [shift, setShift] = useState(undefined);
  const [dialog, setDialog] = useState(null);
  const load = useCallback((signal) => {
    if (!locationId) return;
    businessRead(biz.id, "shifts/current", { location: locationId }, signal).then(setShift).catch(() => setShift(null));
  }, [biz.id, locationId]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  if (shift === undefined || !locationId) return null;
  const since = shift ? new Date(shift.opened_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  return (
    <>
      <button type="button" className="button button-secondary" onClick={() => setDialog(shift ? "close" : "open")}
        title={shift ? `Your shift has been open since ${since}. Close it to count your cash.` : "Start your shift with the cash in the drawer"}>
        <Icon name="wallet" size={15} /> {shift ? `Shift since ${since}` : "Open shift"}
      </button>
      {dialog === "open" && <OpenShift biz={biz} locationId={locationId} onClose={() => setDialog(null)} onDone={(row) => { setDialog(null); setShift(row); toast.success("Shift opened"); }} />}
      {dialog === "close" && shift && <CloseShift biz={biz} shift={shift} onClose={() => setDialog(null)} onDone={(row) => { setDialog(null); setShift(null); toast.success(Number(row.difference) === 0 ? "Shift closed: the cash matches" : `Shift closed: ${biz.exact(Math.abs(Number(row.difference)))} ${Number(row.difference) < 0 ? "short" : "over"}`); }} />}
    </>
  );
}

function OpenShift({ biz, locationId, onClose, onDone }) {
  const [cash, setCash] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (cash === "" || Number(cash) < 0) { setError("Count the cash in the drawer and enter it (0 if it is empty)."); return; }
    setBusy(true); setError("");
    try { onDone(await businessWrite(biz.id, "shifts", { locationId, openingCash: cash })); }
    catch (err) { setError(getErrorMessage(err)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Open your shift" icon="wallet" width={440} onClose={onClose} description="The cash in your drawer now. At the end you count it again.">
      <form className="form-grid" onSubmit={submit} noValidate>
        <Field label={`Opening cash (${biz.symbol})`} wide>
          <input type="number" min="0" step="0.01" inputMode="decimal" autoFocus value={cash} onChange={(e) => setCash(e.target.value)} />
        </Field>
        <ErrorMessage message={error} />
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
          <button className="button" disabled={busy}>{busy ? "Opening…" : "Open shift"}</button>
        </div>
      </form>
    </Modal>
  );
}

function CloseShift({ biz, shift, onClose, onDone }) {
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [gap, setGap] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (counted === "" || Number(counted) < 0) { setError("Count the cash in your drawer and enter it."); return; }
    setBusy(true); setError("");
    try {
      onDone(await businessWrite(biz.id, `shifts/${shift.id}/close`, { countedCash: counted, reason: reason.trim() || undefined }));
    } catch (err) {
      const data = err?.response?.data?.data;
      // Short or over: show the figures now and ask why.
      if (data?.reason === "difference_reason_required") setGap(data);
      else setError(getErrorMessage(err));
    } finally { setBusy(false); }
  };
  const diff = gap ? Number(gap.difference) : 0;
  return (
    <Modal title="Close your shift" icon="wallet" width={480} onClose={onClose}
      description={`Opened at ${new Date(shift.opened_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} with ${biz.exact(shift.opening_cash)}. Count the notes and coins in your drawer.`}>
      <form className="form-grid" onSubmit={submit} noValidate>
        <Field label={`Cash counted (${biz.symbol})`} wide>
          <input type="number" min="0" step="0.01" inputMode="decimal" autoFocus value={counted} onChange={(e) => { setCounted(e.target.value); setGap(null); }} />
        </Field>
        {gap && (
          <div className="field-wide">
            <div className={`alert ${diff < 0 ? "" : "alert-info"}`} role="alert">
              Should be {biz.exact(gap.expected)} · counted {biz.exact(gap.counted)} · <strong>{biz.exact(Math.abs(diff))} {diff < 0 ? "short" : "over"}</strong>
            </div>
            <Field label="Why is it different?" wide>
              <textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Gave ₹50 extra change to a customer" />
            </Field>
          </div>
        )}
        <ErrorMessage message={error} />
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
          <button className="button" disabled={busy || (gap && !reason.trim())}>{busy ? "Closing…" : "Close shift"}</button>
        </div>
      </form>
    </Modal>
  );
}
