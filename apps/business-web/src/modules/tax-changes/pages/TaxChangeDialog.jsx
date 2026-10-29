import { useCallback, useEffect, useState } from "react";
import Modal from "../../../components/Modal";
import DataGrid from "../../../components/DataGrid/DataGrid";
import StatusBadge from "../../../components/StatusBadge";
import { ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { dateTime, moneyExact } from "@bmp/shared/format";
import { STATES, STATUSES, keepsWords, onDate, plural, rateText } from "../taxChanges";
import { OpenDocuments } from "./TaxNotices";
import "../styles/tax-changes.css";

// One GST rate change: when, to which rate, why and by whom, and what happened
// to each item. Before its date it can be cancelled, whole or item by item,
// with a reason; from its date it is kept for good.
export default function TaxChangeDialog({ api, words, changeId, canEdit, currency = "₹", onClose, onChanged }) {
  const [change, setChange] = useState(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback((signal) => api.detail(changeId, signal).then(setChange).catch((err) => { if (!signal?.aborted) setError(getErrorMessage(err)); }), [api, changeId]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      const next = cancelling.item ? await api.cancelItem(change.id, cancelling.item.id, reason.trim()) : await api.cancel(change.id, reason.trim());
      setChange(next);
      setCancelling(null);
      setReason("");
      onChanged?.(next);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const state = change ? STATES[change.state] || STATES.scheduled : null;
  const open = change && change.scheduled > 0 && canEdit;
  const columns = [
    { key: "item", header: words.Item, value: (i) => i.label, mobile: "title", pin: true,
      render: (i) => <span className="txc-two-line"><strong>{i.label}</strong>{i.code && <small className="muted mono">{i.code}</small>}</span> },
    { key: "status", header: "Status", type: "status", value: (i) => i.status, mobile: "subtitle",
      render: (i) => <StatusBadge status={i.status} label={STATUSES[i.status]?.label || i.status} tone={STATUSES[i.status]?.tone || "neutral"} /> },
    { key: "from", header: "From", value: (i) => i.from_name || rateText(i.from_rate), render: (i) => (i.from_rate === null ? <span className="muted">On its date</span> : i.from_name || rateText(i.from_rate)) },
    { key: "price", header: "Price", value: (i) => Number(i.price_after ?? 0), mobile: "show",
      render: (i) => (i.price_before === null ? <span className="muted">—</span> : i.price_before === i.price_after ? moneyExact(i.price_after, currency)
        : <span className="nowrap">{moneyExact(i.price_before, currency)} → <strong>{moneyExact(i.price_after, currency)}</strong></span>) },
    { key: "note", header: "Note", value: (i) => i.note || i.cancel_reason || "",
      render: (i) => (i.status === "cancelled" ? <small>{i.cancel_reason} <span className="muted">· {i.cancelled_by_name}, {dateTime(i.cancelled_at)}</span></small>
        : i.note ? <small className={i.status === "refused" ? "text-danger" : "muted"}>{i.note}</small> : "") },
    open && { key: "actions", header: "", label: "Actions", type: "actions",
      render: (i) => (i.status === "scheduled" ? <button type="button" className="chip-button" onClick={() => { setCancelling({ item: i }); setReason(""); }}>Cancel</button> : null) },
  ].filter(Boolean);

  return (
    <Modal title={change ? `GST rate change from ${onDate(change.starts_on)}` : "GST rate change"} icon="percent" width={980} onClose={busy ? () => {} : onClose} dismissible={!busy}
      footer={<>
        {open && !cancelling && <button type="button" className="button button-secondary" onClick={() => { setCancelling({ item: null }); setReason(""); }}>Cancel the change</button>}
        <button type="button" className="button" onClick={onClose} disabled={busy}>Close</button>
      </>}>
      <div className="stack">
        <ErrorMessage message={error} />
        {!change && !error && <Loading />}
        {change && (
          <>
            <dl className="txc-facts">
              <div><dt>Moves to</dt><dd><strong>{change.rate_name}</strong> ({rateText(change.rate)})</dd></div>
              <div><dt>From</dt><dd>{onDate(change.starts_on)}</dd></div>
              <div><dt>Prices that include GST</dt><dd>{keepsWords(change.keeps)}</dd></div>
              <div><dt>State</dt><dd><StatusBadge status={change.state} label={state.label} tone={state.tone} /></dd></div>
              <div className="txc-wide"><dt>Reason</dt><dd>{change.reason}</dd></div>
              <div className="txc-wide"><dt>Entered by</dt><dd>{change.created_by_name}, {dateTime(change.created_at)}</dd></div>
            </dl>
            {cancelling && (
              <form className="txc-cancel" onSubmit={(event) => { event.preventDefault(); cancel(); }}>
                <label className="field">
                  <span>{cancelling.item ? `Why ${cancelling.item.label} stays where it is` : `Why the whole change is cancelled (${plural(change.scheduled, words.item, words.items)} still to move)`}</span>
                  <input required autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Notification withdrawn" />
                </label>
                <div className="txc-cancel-actions">
                  <button type="button" className="button button-secondary" onClick={() => setCancelling(null)} disabled={busy}>Keep it</button>
                  <button type="submit" className="button button-danger" disabled={busy || !reason.trim()}>{busy ? "Cancelling…" : cancelling.item ? `Cancel for ${cancelling.item.label}` : "Cancel the change"}</button>
                </div>
              </form>
            )}
            <OpenDocuments documents={change.documents} words={words} />
            <DataGrid id="tax-change-items" variant="compact" caption={`The ${words.items} it moves`} rows={change.items} rowKey={(i) => i.id}
              rowNoun={[words.item, words.items]} currency={currency} columns={columns}
              rowClassName={(i) => (i.status === "cancelled" ? "dg-tone-muted" : i.status === "refused" ? "dg-tone-danger" : "")} />
          </>
        )}
      </div>
    </Modal>
  );
}
