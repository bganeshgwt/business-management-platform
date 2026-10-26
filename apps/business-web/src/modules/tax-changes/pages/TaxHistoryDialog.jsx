import { useCallback, useEffect, useMemo, useState } from "react";
import Modal from "../../../components/Modal";
import StatusBadge from "../../../components/StatusBadge";
import { EmptyState, ErrorMessage, Loading } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { dateTime, moneyExact } from "@bmp/shared/format";
import { STATUSES, onDate, rateText } from "../taxChanges";
import "../styles/tax-changes.css";

// An item's GST history, newest first: the GST rate changes by date that moved
// it or are to move it (with who entered each and why, and what its price
// became), and each time its rate was changed on the item itself. A change
// still to come can be cancelled for this item here.
export default function TaxHistoryDialog({ api, words, itemId, label, canEdit, currency = "₹", onClose, onChanged }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback((signal) => api.history(itemId, signal).then(setHistory).catch((err) => { if (!signal?.aborted) setError(getErrorMessage(err)); }), [api, itemId]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Changes by date and changes on the item itself, in one list, newest first.
  const entries = useMemo(() => {
    if (!history) return [];
    const changes = history.changes.map((c) => ({ kind: "change", key: `c${c.id}`, when: c.starts_on, ...c }));
    const edits = history.edits.map((e) => ({ kind: "edit", key: `e${e.id}`, when: String(e.created_at).slice(0, 10), ...e }));
    return [...changes, ...edits].sort((a, b) => String(b.when).localeCompare(String(a.when)) || String(b.key).localeCompare(String(a.key)));
  }, [history]);

  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      await api.cancelItem(cancelling.change_id, cancelling.id, reason.trim());
      setCancelling(null);
      setReason("");
      await load();
      onChanged?.();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // What an edit on the item itself says: the shop's slab (from, to) or the restaurant's tax rate (changes.taxRate).
  const editWords = (e) => {
    const d = e.details || {};
    const [from, to] = d.changes?.taxRate || [d.from, d.to];
    return `${from} → ${to}`;
  };

  return (
    <Modal title={`GST history · ${label}`} icon="history" width={720} onClose={busy ? () => {} : onClose} dismissible={!busy}
      description={history ? `Now at ${history.item.slab_name || rateText(history.item.tax_rate)}. A bill keeps the rate it was made at.` : undefined}
      footer={<button type="button" className="button" onClick={onClose} disabled={busy}>Close</button>}>
      <div className="stack">
        <ErrorMessage message={error} />
        {!history && !error && <Loading />}
        {history && !entries.length && (
          <EmptyState icon="history" message={`No GST change for this ${words.item} yet`} hint={`Its ${words.rate} has stayed as it was made. The yearly change is entered on GST rate changes.`} />
        )}
        {cancelling && (
          <form className="txc-cancel" onSubmit={(event) => { event.preventDefault(); cancel(); }}>
            <label className="field">
              <span>Why {label} stays at {cancelling.from_name || "its rate"} on {onDate(cancelling.starts_on)}</span>
              <input required autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Not covered by the notification" />
            </label>
            <div className="txc-cancel-actions">
              <button type="button" className="button button-secondary" onClick={() => setCancelling(null)} disabled={busy}>Keep it</button>
              <button type="submit" className="button button-danger" disabled={busy || !reason.trim()}>{busy ? "Cancelling…" : "Cancel for this " + words.item}</button>
            </div>
          </form>
        )}
        {entries.length > 0 && (
          <ol className="txc-history" aria-label={`GST history of ${label}`}>
            {entries.map((e) => (
              <li key={e.key} className={`txc-entry txc-${e.kind === "edit" ? "edit" : e.status}`}>
                <div className="txc-entry-head">
                  <strong>{e.kind === "edit" ? `Changed on the ${words.item}` : `From ${onDate(e.starts_on)}`}</strong>
                  {e.kind === "change"
                    ? <StatusBadge status={e.status} label={STATUSES[e.status]?.label || e.status} tone={STATUSES[e.status]?.tone || "neutral"} />
                    : <span className="muted small">{dateTime(e.created_at)}</span>}
                </div>
                {e.kind === "edit" ? (
                  <p>{editWords(e)} <span className="muted">· {e.actor_name}</span></p>
                ) : (
                  <>
                    <p>
                      {e.from_name ? `${e.from_name} → ` : ""}<strong>{e.to_name}</strong> ({rateText(e.rate)})
                      {e.price_before !== null && e.price_before !== e.price_after && <> · price {moneyExact(e.price_before, currency)} → {moneyExact(e.price_after, currency)}</>}
                    </p>
                    <p className="muted small">{e.reason} · entered by {e.created_by_name}, {dateTime(e.created_at)}</p>
                    {e.status === "cancelled" && <p className="muted small">Cancelled by {e.cancelled_by_name}, {dateTime(e.cancelled_at)}: {e.cancel_reason}</p>}
                    {e.note && <p className={`small ${e.status === "refused" ? "text-danger" : "muted"}`}>{e.note}</p>}
                    {e.status === "scheduled" && canEdit && !cancelling && (
                      <button type="button" className="chip-button" onClick={() => { setCancelling(e); setReason(""); }}>Cancel for this {words.item}</button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  );
}
