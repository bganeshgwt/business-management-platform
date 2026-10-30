import { notOwnReason, optionText, pinNote } from "../../core/pages/approvers";

// Letting an order through a customer's credit hold, as Sales orders and a
// quotation's sales order both do: someone with credit control
// (receivables.approve) gives the reason; anyone else names a manager who
// has it and types that manager's PIN. The server checks the PIN and keeps
// who let it through (the order's hold releases and the activity log). The
// release being filled in is useHoldRelease (useHoldRelease.js).

// hold: the server's credit_hold refusal ({ holdReason, overdue, days, limitDays, bounces, bounceDays }).
export default function HoldRelease({ biz, hold, release, setRelease, releasers }) {
  if (!hold) return null;
  const why = biz.can("receivables.approve") ? "" : notOwnReason(releasers);
  return (
    <div className="field-wide bz-note-card is-warning" role="group" aria-label="Let it through">
      <strong>Let it through: {hold.holdReason === "bounced_cheques" ? `${hold.bounces} cheques bounced in the last ${hold.bounceDays} days.` : `${biz.exact(hold.overdue)} is ${hold.days} days overdue (limit ${hold.limitDays} days).`}</strong>
      {!biz.can("receivables.approve") && (
        <>
          <label className="field"><span>Manager</span>
            <select required value={release.approverId} onChange={(e) => setRelease((r) => ({ ...r, approverId: e.target.value }))}>
              <option value="">Choose…</option>
              {(releasers || []).map((p) => <option key={p.id} value={p.id} disabled={Boolean(pinNote(p))}>{optionText(p)}</option>)}
            </select>
          </label>
          <label className="field"><span>Their PIN</span><input type="password" inputMode="numeric" autoComplete="off" required minLength={4} maxLength={8} value={release.pin} onChange={(e) => setRelease((r) => ({ ...r, pin: e.target.value }))} /></label>
        </>
      )}
      <label className="field" style={{ flex: "1 1 16rem" }}><span>Reason</span><input required maxLength={300} value={release.reason} onChange={(e) => setRelease((r) => ({ ...r, reason: e.target.value }))} placeholder="e.g. Cheque promised for Friday" /></label>
      {why && <p className="field-wide small muted">{why}</p>}
    </div>
  );
}
