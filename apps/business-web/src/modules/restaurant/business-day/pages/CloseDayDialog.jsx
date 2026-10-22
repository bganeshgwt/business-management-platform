import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import LiveValue from "../../../../components/LiveValue";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { checkCloseBusinessDay, closeBusinessDay, getClosePreview } from "../services/businessDay.service";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { count as countText, moneyExact } from "@bmp/shared/format";
import useShake from "../../../../hooks/useShake";
import { motionAllowed } from "../../../../components/motion";
import CashCount from "./CashCount";
import { CHECK_AGAINST, METHOD_WORDS, difference, notesPayload, varianceTone, varianceWords } from "./cashMath";
import { dateText } from "./moneyText";
import "../styles/stale-day.css";

const METHOD_ICONS = { card: "card", upi: "qr", online: "external", wallet: "wallet", other: "wallet" };

// The cash-up at the end of the day: what is still in the way, the drawer
// counted (note by note or as a total), what it should hold and the
// difference, a reason when that difference is beyond the restaurant's
// threshold, and the card and UPI totals ticked against the machine and the
// bank app. Everything is checked by the server before any manager is asked
// for a PIN, so an approval is never spent on a close that would be refused.
//
// A blind count (Business day → Cash rules) hides what the drawer should
// hold from whoever counts it, until the count is in.
//
// carryByDefault: started from "Close <old date> and open today" — the unpaid
// bills of a forgotten day are carried as dues unless the closer unticks it.
export default function CloseDayDialog({ day, currency, onClose, onClosed, onShowDrawers, carryByDefault = false }) {
  const money = (value) => moneyExact(value, currency);

  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [method, setMethod] = useState("notes");
  const [notes, setNotes] = useState({});
  const [cash, setCash] = useState("");
  const [reason, setReason] = useState("");
  // Card, UPI…: { matched, reported, note } as the closer ticked them.
  const [checks, setChecks] = useState({});
  const [carryUnpaid, setCarryUnpaid] = useState(Boolean(carryByDefault));
  const [dayNotes, setDayNotes] = useState("");
  const [error, setError] = useState("");
  // The server's last refusal, with the count it was for.
  const [refusal, setRefusal] = useState(null);
  const [saving, setSaving] = useState(false);

  const [countRef, shakeCount] = useShake();
  const [reasonRef, shakeReason] = useShake();
  const [checksRef, shakeChecks] = useShake();

  const loadPreview = () =>
    getClosePreview()
      .then(setPreview)
      .catch((err) => setLoadError(getErrorMessage(err)));

  useEffect(() => {
    getClosePreview()
      .then(setPreview)
      .catch((err) => setLoadError(getErrorMessage(err)));
  }, []);

  const figures = preview ? preview.figures : null;
  const blind = Boolean(preview && preview.blind);
  const threshold = preview ? Number(preview.rules.varianceThreshold) : 0;
  const counted = cash === "" || !Number.isFinite(Number(cash)) ? null : Math.round(Number(cash) * 100) / 100;

  // The difference as the count is typed (when the closer may see what the
  // drawer should hold), or as the server said it for this very count.
  const variance =
    !blind && figures && counted !== null
      ? difference(counted, figures.inDrawer)
      : refusal && refusal.variance !== undefined && refusal.counted === counted
        ? Number(refusal.variance)
        : null;
  const tone = variance === null ? null : varianceTone(variance, threshold);
  const needsReason = tone === "far";

  const due = figures ? figures.methods.filter((row) => row.method !== "cash" && Math.abs(row.net) > 0.004) : [];
  const blockers = preview ? preview.blockers : null;
  const unpaid = blockers ? blockers.unpaidBills : [];
  // One line however many: how many, what they come to, the largest named.
  const unpaidSummary =
    blockers && blockers.unpaidSummary
      ? blockers.unpaidSummary
      : {
          count: unpaid.length,
          due: unpaid.reduce((sum, bill) => sum + Number(bill.due), 0),
          largest: [...unpaid].sort((a, b) => b.due - a.due).slice(0, 5),
        };
  const billsLink = `/bills?status=unpaid,partial&from=${day.businessDate}`;

  const setCheck = (key, patch) => setChecks((all) => ({ ...all, [key]: { matched: false, reported: "", note: "", ...all[key], ...patch } }));

  const methodChecks = () =>
    due.map((row) => {
      const given = checks[row.method] || {};

      return {
        method: row.method,
        matched: given.matched === true,
        reported: given.matched === true || given.reported === "" || given.reported === undefined ? null : Number(given.reported),
        note: given.note ? given.note.trim() : null,
      };
    });

  // Says why, shakes what was refused and brings it into view: the button is
  // at the foot of a long dialog, the count at its head.
  const refuse = (message, shake, ref) => {
    setError(message);
    shake();

    if (ref && ref.current) {
      ref.current.scrollIntoView({ block: "center", behavior: motionAllowed() ? "smooth" : "auto" });
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError("");

    // An empty box is not a count of ₹0: the day used to close on ₹0 when the
    // box was left empty.
    if (counted === null || counted < 0) {
      refuse(
        "Enter the cash counted in the drawer before closing the day. An empty box is not ₹0: count the drawer, and type 0 only if it is really empty.",
        shakeCount,
        countRef
      );
      return;
    }

    for (const row of due) {
      const given = checks[row.method] || {};
      const word = METHOD_WORDS[row.method] || row.method;

      if (given.matched !== true && (given.reported === "" || given.reported === undefined)) {
        refuse(`Tick ${word} (${money(row.net)}) against ${CHECK_AGAINST[row.method] || "its own record"}, or type what it shows.`, shakeChecks, checksRef);
        return;
      }

      if (given.matched !== true && Math.abs(Number(given.reported) - row.net) > 0.004 && !(given.note || "").trim()) {
        refuse(`${word} shows ${money(Number(given.reported))} but the bills say ${money(row.net)}. Write a note saying why.`, shakeChecks, checksRef);
        return;
      }
    }

    if (needsReason && !reason.trim()) {
      refuse(
        `The drawer is ${varianceWords(variance, money)}. More than ${money(threshold)} over or short needs a reason before the day can close.`,
        shakeReason,
        reasonRef
      );
      return;
    }

    const payload = {
      closingCash: counted,
      countMethod: method,
      denominations: method === "notes" ? notesPayload(notes, preview?.rules?.denominations) : null,
      varianceReason: reason.trim() || null,
      methodChecks: methodChecks(),
      notes: dayNotes.trim() || null,
      carryUnpaid,
    };

    setSaving(true);

    try {
      // Checked in full first: a refusal here costs no manager's PIN.
      const check = await checkCloseBusinessDay(payload);

      if (check.refused) {
        setRefusal({ ...check.refused, counted });
        setError(check.refused.message);

        const why = check.refused.reason;

        if (why === "variance_reason_required") {
          shakeReason();
        } else if (why === "method_check_required" || why === "method_note_required") {
          shakeChecks();
        } else {
          shakeCount();
        }

        // What is in the way may have changed since the dialog opened.
        loadPreview();
        return;
      }

      const closed = await withApproval(
        (headers) => closeBusinessDay(payload, headers),
        `Close business day ${dateText(day.businessDate)}`,
        {
          permission: "business_day.close",
          scope: check.approval ? check.approval.scope : { businessDayId: day.id, closingCash: counted, carryUnpaid },
        }
      );

      onClosed(closed);
    } catch (err) {
      setError(getErrorMessage(err));
      shakeCount();
    } finally {
      setSaving(false);
    }
  };

  const hasBlockers =
    blockers &&
    (blockers.openOrders > 0 || unpaid.length > 0 || blockers.pendingExpenses.length > 0 || blockers.openDrawers.length > 0);

  return (
    <Modal
      title="Close business day"
      icon="moon"
      description="Count the drawer, tick card and UPI, then close. Closing may ask for a manager's PIN."
      onClose={onClose}
      width={640}
    >
      <form className="form-grid bd-form" onSubmit={submit} noValidate>
        <div className="field-wide bd-closing">
          <span className="bd-closing-icon" aria-hidden="true">
            <Icon name="calendar" size={18} />
          </span>
          <span className="bd-closing-text">
            <strong>{dateText(day.businessDate, { weekday: true })}</strong>
            <span className="small muted">Started with {money(day.openingCash)} in the drawer</span>
          </span>
        </div>

        <ErrorMessage message={loadError} />

        {!preview && !loadError ? (
          <div className="field-wide">
            <Loading label="Adding up the day…" />
          </div>
        ) : null}

        {hasBlockers && (
          <div className="field-wide cash-blockers" role="status">
            <strong>
              <Icon name="alert" size={16} /> Before the day can close
            </strong>
            <ul>
              {blockers.openOrders > 0 && (
                <li className="cash-blocker">
                  <span className="cash-blocker-what">
                    <strong>
                      {countText(blockers.openOrders)} open {blockers.openOrders === 1 ? "order" : "orders"}
                    </strong>
                    {blockers.openOrdersValue > 0 ? ` · ${money(blockers.openOrdersValue)}` : ""} · bill or cancel{" "}
                    {blockers.openOrders === 1 ? "it" : "each"} first
                  </span>
                  <Link to="/orders?days=all&status=open">Review in Orders</Link>
                </li>
              )}
              {blockers.earlierOrders && blockers.earlierOrders.count > 0 && (
                <li className="cash-blocker is-old">
                  <span className="cash-blocker-what">
                    <strong>
                      {countText(blockers.earlierOrders.count)} of them left open from earlier days
                    </strong>{" "}
                    · oldest {dateText(blockers.earlierOrders.oldest, { year: false })} ·{" "}
                    {money(blockers.earlierOrders.value)} · bill the ones that were eaten, cancel the rest with a reason
                  </span>
                  <Link to="/orders?days=all&status=open">Bill or cancel</Link>
                </li>
              )}
              {blockers.pendingExpenses.length > 0 && (
                <li className="cash-blocker">
                  <span className="cash-blocker-what">
                    <strong>
                      {countText(blockers.pendingExpenses.length)} cash{" "}
                      {blockers.pendingExpenses.length === 1 ? "expense" : "expenses"} waiting
                    </strong>{" "}
                    · {money(blockers.pendingExpenses.reduce((sum, row) => sum + Number(row.amount), 0))} · the cash has
                    already left the drawer
                  </span>
                  <Link to="/expenses?status=pending">Approve or reject</Link>
                </li>
              )}
              {blockers.openDrawers.length > 0 && (
                <li className="cash-blocker">
                  <span className="cash-blocker-what">
                    <strong>
                      {blockers.openDrawers.length === 1 ? "1 drawer" : `${countText(blockers.openDrawers.length)} drawers`} still open
                    </strong>{" "}
                    · {blockers.openDrawers.map((row) => row.cashierName).join(", ")}
                  </span>
                  <button type="button" className="link-button" onClick={onShowDrawers}>
                    End {blockers.openDrawers.length === 1 ? "that shift" : "those shifts"}
                  </button>
                </li>
              )}
              {unpaid.length > 0 && (
                <li className="cash-blocker">
                  <span className="cash-blocker-what">
                    <strong>
                      {countText(unpaidSummary.count)} unpaid {unpaidSummary.count === 1 ? "bill" : "bills"}
                    </strong>{" "}
                    · {money(unpaidSummary.due)} due
                    {unpaidSummary.count > 1 && unpaidSummary.largest.length > 0 && (
                      <span className="cash-blocker-sub">
                        Largest:{" "}
                        {unpaidSummary.largest.map((bill, index) => (
                          <span key={bill.id}>
                            {index > 0 ? ", " : ""}
                            {bill.billNumber} ({money(bill.due)})
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <Link to={billsLink}>Review in Bills</Link>
                </li>
              )}
            </ul>
            {unpaid.length > 0 && (
              <label className="checkbox">
                <input type="checkbox" checked={carryUnpaid} onChange={(event) => setCarryUnpaid(event.target.checked)} />
                Close anyway and carry {unpaidSummary.count === 1 ? "it" : `all ${countText(unpaidSummary.count)}`} as dues (
                {money(unpaidSummary.due)}, written onto the day)
              </label>
            )}
          </div>
        )}

        <CashCount
          countRef={countRef}
          currency={currency}
          value={cash}
          onChange={setCash}
          method={method}
          onMethod={setMethod}
          notes={notes}
          onNotes={setNotes}
          denominations={preview?.rules?.denominations}
          refused={Boolean(error) && counted === null}
          message={counted === null ? error : ""}
          autoFocus
        />

        {figures && !blind && (
          <div className="field-wide cash-expect-wrap">
            <p className="section-heading">What the drawer should hold</p>
            <dl className="cash-expect">
              <div>
                <dt>Opening cash</dt>
                <dd>{money(figures.openingCash)}</dd>
              </div>
              <div>
                <dt>+ Cash taken</dt>
                <dd>{money(figures.cashSales)}</dd>
              </div>
              {figures.duesCollectedCash > 0 && (
                <div className="is-sub">
                  <dt>of which dues collected</dt>
                  <dd>{money(figures.duesCollectedCash)}</dd>
                </div>
              )}
              {figures.cashTips > 0 && (
                <div>
                  <dt>+ Tips given in cash</dt>
                  <dd>{money(figures.cashTips)}</dd>
                </div>
              )}
              <div>
                <dt>− Cash refunds</dt>
                <dd>{money(figures.cashRefunds)}</dd>
              </div>
              <div>
                <dt>− Cash expenses</dt>
                <dd>{money(figures.cashExpenses)}</dd>
              </div>
              {figures.pettyCash > 0 && (
                <div className="is-sub">
                  <dt>of which petty cash from the drawer</dt>
                  <dd>{money(figures.pettyCash)}</dd>
                </div>
              )}
              {figures.supplierCash > 0 && (
                <div>
                  <dt>− Paid to suppliers from the till</dt>
                  <dd>{money(figures.supplierCash)}</dd>
                </div>
              )}
              {figures.riderShortfall > 0 && (
                <div>
                  <dt>− Riders short on settlement</dt>
                  <dd>{money(figures.riderShortfall)}</dd>
                </div>
              )}
              {figures.riderRepaid > 0 && (
                <div>
                  <dt>+ Rider shortfalls handed over</dt>
                  <dd>{money(figures.riderRepaid)}</dd>
                </div>
              )}
              {figures.cashAdvances > 0 && (
                <div>
                  <dt>+ Advances and deposits in cash</dt>
                  <dd>{money(figures.cashAdvances)}</dd>
                </div>
              )}
              {figures.cashAdvancesReturned > 0 && (
                <div>
                  <dt>− Advances handed back in cash</dt>
                  <dd>{money(figures.cashAdvancesReturned)}</dd>
                </div>
              )}
              {figures.dropped > 0 && (
                <div>
                  <dt>− Dropped to the safe</dt>
                  <dd>{money(figures.dropped)}</dd>
                </div>
              )}
              {figures.paidIn > 0 && (
                <div>
                  <dt>+ Float top-ups from the safe</dt>
                  <dd>{money(figures.paidIn)}</dd>
                </div>
              )}
              <div className="is-total">
                <dt>Should be in the drawer</dt>
                <dd>
                  <LiveValue value={figures.inDrawer} align="end">
                    {money(figures.inDrawer)}
                  </LiveValue>
                </dd>
              </div>
            </dl>
          </div>
        )}

        {blind && (
          <div className="field-wide alert alert-info">
            Blind count: count the drawer first. What it should hold is not shown, so the count is your own; the difference is
            said once the count is in.
          </div>
        )}

        {variance !== null && (
          <div className={`field-wide cash-diff is-${tone}`} aria-live="polite">
            <span className="cash-diff-label">
              <Icon name={tone === "match" ? "check-circle" : "alert-circle"} size={18} />
              {tone === "match" ? "The count matches" : variance < 0 ? "Short" : "Over"}
            </span>
            <span className="cash-diff-value">
              <LiveValue value={variance} align="end" tone={tone === "far" ? "danger" : tone === "near" ? "warning" : "success"}>
                {tone === "match" ? money(0) : money(Math.abs(variance))}
              </LiveValue>
            </span>
            {tone !== "match" && (
              <small>
                {needsReason
                  ? `More than ${money(threshold)} needs a reason. The first figure counted is kept on the day.`
                  : `Within the ${money(threshold)} the restaurant allows without a reason.`}
              </small>
            )}
          </div>
        )}

        {needsReason && (
          <label className="field field-wide" ref={reasonRef}>
            <span>Why is the drawer {variance < 0 ? "short" : "over"}?</span>
            <textarea
              rows={2}
              maxLength={300}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={variance < 0 ? "₹200 change given twice to table 6" : "A guest left the change"}
            />
            <small className="muted">Goes on the day and in the activity log.</small>
          </label>
        )}

        {due.length > 0 && (
          <div className="field-wide cash-methods" ref={checksRef}>
            <p className="section-heading">Tick card and UPI</p>
            {due.map((row) => {
              const given = checks[row.method] || {};
              const word = METHOD_WORDS[row.method] || row.method;

              return (
                <div key={row.method} className={`cash-method ${given.matched ? "is-ticked" : ""}`}>
                  <span className="cash-method-name">
                    <strong>
                      <Icon name={METHOD_ICONS[row.method] || "wallet"} size={15} /> {word}
                    </strong>
                    <span className="small muted">
                      {row.payments} payment{row.payments === 1 ? "" : "s"}
                      {row.refunded > 0 ? ` · ${money(row.refunded)} refunded` : ""} · check against {CHECK_AGAINST[row.method] || "its record"}
                    </span>
                  </span>
                  <span className="cash-method-figure">{money(row.net)}</span>
                  <div className="cash-method-actions">
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={given.matched === true}
                        onChange={(event) => setCheck(row.method, { matched: event.target.checked })}
                      />
                      Matches
                    </label>
                    {given.matched !== true && (
                      <>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          aria-label={`What ${word} shows`}
                          placeholder="It shows ₹…"
                          value={given.reported ?? ""}
                          onChange={(event) => setCheck(row.method, { reported: event.target.value })}
                        />
                        <input
                          className="cash-method-note"
                          maxLength={200}
                          aria-label={`Why ${word} differs`}
                          placeholder="Why it differs"
                          value={given.note ?? ""}
                          onChange={(event) => setCheck(row.method, { note: event.target.value })}
                        />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* The opening note is kept: the closer's note goes beside it, never
            over it (SW-B-07). */}
        {(day.openingNotes || day.notes) && (
          <p className="field-wide muted small pre-line">
            Opening note{day.openedByName ? ` (${day.openedByName})` : ""}: {day.openingNotes || day.notes}
          </p>
        )}
        <label className="field field-wide">
          <span>Closing note (optional)</span>
          <textarea
            rows={2}
            maxLength={500}
            value={dayNotes}
            onChange={(event) => setDayNotes(event.target.value)}
            placeholder="Anything the owner should know about today. The opening note is kept."
          />
        </label>

        <ErrorMessage message={error} />

        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving || !preview}>
            <Icon name="moon" size={16} /> {saving ? "Closing…" : "Close day"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
