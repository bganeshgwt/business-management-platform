import { useCallback, useEffect, useRef, useState } from "react";
import PinPad from "./PinPad";
import { setApprovalHandler } from "../services/approval";
import { listApprovers, requestApprovalToken } from "../services/auth.service";
import { getErrorMessage } from "../services/api";
import { leaveBackdrop } from "./motion";
import "../styles/access.css";
import "../styles/approval-capped.css";

const sentence = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");

// Past this many names the list gets a search box and scrolls inside itself,
// so the PIN pad and Approve stay in view on a phone.
const SEARCH_FROM = 7;

const initials = (name) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

// The manager-PIN prompt, mounted once for the whole app (see main.jsx).
//
// When the server says an action needs a manager's approval, this opens over
// whatever screen asked: it names the action, lists the people who can
// approve it, and the manager standing there taps their name and types their
// PIN. The screen's request then goes through with the one-time approval, and
// the activity log names both people.
//
// When the screen (or the server's refusal) says exactly what is being
// approved — this bill, this amount — the heading and the figures under it
// are the server's own wording of those facts, and the approval is tied to
// them: what the manager reads is what the token allows, and nothing more.
// Managers capped below a discount are listed greyed, a few at most: enough
// to say why they are not offered without burying the ones who can.
const CAPPED_SHOWN = 4;

export default function ApprovalDialog() {
  const [request, setRequest] = useState(null);
  const [approvers, setApprovers] = useState(null);
  // Managers who could approve a smaller discount but not this one (their own
  // cap is lower): shown greyed with their limit, so nobody types a PIN that
  // is bound to be refused.
  const [capped, setCapped] = useState([]);
  // The server's words for what is being approved: { summary, facts }.
  const [described, setDescribed] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [approverId, setApproverId] = useState(null);
  // With a long list, a chosen manager folds the list away (see below).
  const [picking, setPicking] = useState(false);
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");
  // The note is optional and rarely used at the till, so it sits behind a
  // link: on a phone its box would push the PIN keys under the Approve bar.
  const [noting, setNoting] = useState(false);
  const [find, setFind] = useState("");
  const [error, setError] = useState("");
  // Counts refused tries, so the keypad is brought back into view after each.
  const [refusals, setRefusals] = useState(0);
  const [busy, setBusy] = useState(false);
  const padRef = useRef(null);

  // After a wrong PIN the prompt grows (the error, the folded name), and on a
  // short phone screen the bottom row of keys (Clear, 0, ⌫) could end up
  // under the Approve bar. Scroll just enough to show the whole keypad; the
  // prompt keeps room for the bar (scroll-padding-bottom in access.css).
  useEffect(() => {
    if (refusals > 0 && padRef.current) {
      padRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [refusals]);

  // Registered for the life of the app: withApproval and the api interceptor
  // call it and wait for a token (or null when cancelled).
  useEffect(
    () =>
      setApprovalHandler(
        (next) =>
          new Promise((resolve) => {
            setApprovers(null);
            setCapped([]);
            setDescribed(null);
            setLoadFailed(false);
            setApproverId(null);
            setPicking(false);
            setPin("");
            setNote("");
            setNoting(false);
            setFind("");
            setRefusals(0);
            setError(
              next.message ||
                (next.invalid ? "That approval was not accepted. Ask the manager to approve again." : "")
            );
            setRequest({ ...next, resolve });
          })
      ),
    []
  );

  // Who can approve this, and the server's wording of what it is, fetched
  // each time the prompt opens.
  useEffect(() => {
    if (!request) {
      return;
    }

    listApprovers(request.permission, request.scope)
      .then((data) => {
        setApprovers(data.approvers);
        setCapped(data.notAllowed || []);
        setDescribed(data.summary ? { summary: data.summary, facts: data.facts || [] } : null);

        // A PIN someone else set approves nothing until its person chooses their own.
        const open = data.approvers.filter((row) => !row.lockedUntil && !row.pinGiven);

        if (open.length === 1) {
          setApproverId(open[0].id);
        }
      })
      .catch((err) => {
        setApprovers([]);
        setLoadFailed(true);
        setError(getErrorMessage(err));
      });
  }, [request]);

  const close = useCallback(
    (token) => {
      if (request) {
        request.resolve(token || null);
        // The prompt goes at once; its dimmed backdrop fades out behind it.
        leaveBackdrop("is-top");
      }

      setRequest(null);
    },
    [request]
  );

  // Escape cancels, like every other dialog.
  useEffect(() => {
    if (!request) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        close(null);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [request, close]);

  const approve = async () => {
    if (!approverId) {
      setError("Tap the name of the manager who is approving");
      return;
    }

    if (pin.length < 4) {
      setError("Enter the manager's PIN (4 to 6 digits)");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const result = await requestApprovalToken({
        permission: request.permission,
        approverId,
        pin,
        method: request.method,
        url: request.url,
        // The same facts the heading was built from: the token is tied to them.
        scope: request.scope || undefined,
        label: request.label || sentence(request.action),
        note: note.trim() || undefined,
      });

      close(result.approvalToken);
    } catch (err) {
      setPin("");
      setError(getErrorMessage(err));
      setRefusals((count) => count + 1);

      // A PIN that has just locked cannot be tried again for a while.
      const locked = err.response?.data?.data?.lockedUntil;

      if (locked) {
        setApprovers((rows) =>
          (rows || []).map((row) => (row.id === approverId ? { ...row, lockedUntil: locked } : row))
        );
        setApproverId(null);
        setPicking(false);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!request) {
    return null;
  }

  // Bill and order numbers stay whole on a narrow screen ("INV-0001", not
  // "INV-" then "0001"): their hyphen becomes a non-breaking one.
  const heading = ((described && described.summary) || request.label || sentence(request.action) || "This action").replace(
    /([A-Z]{2,})-(\d)/g,
    "$1‑$2"
  );
  const searchable = approvers !== null && approvers.length >= SEARCH_FROM;
  const chosen = (approvers || []).find((row) => row.id === approverId) || null;
  // On a phone a long list of names would push the PIN pad out of sight, so
  // once a manager is picked from it the list folds to their name alone,
  // with "Change" to open it again. It stays folded after a wrong PIN, so
  // the manager can see it is still their name the PIN is checked against.
  const folded = searchable && chosen !== null && !picking;
  const term = find.trim().toLowerCase();
  // The chosen manager always stays in the list, whatever is typed.
  const shown = (approvers || []).filter(
    (row) => !term || row.id === approverId || row.name.toLowerCase().includes(term)
  );

  return (
    <div className="acc-overlay" role="presentation">
      <div className="acc-approval" role="dialog" aria-modal="true" aria-labelledby="acc-approval-title">
        <div className="acc-approval-head">
          <span className="acc-approval-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <div>
            <p className="acc-eyebrow">Manager approval</p>
            <h2 id="acc-approval-title">{heading}</h2>
            <p className="muted small">
              You need a manager's OK to {request.action || "do this"}. Ask a manager to tap their name and enter
              their PIN.
            </p>
          </div>
        </div>

        {described && described.facts.length > 0 && (
          <div className="acc-approval-scope">
            <dl>
              {described.facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
            <p className="muted small">This approval covers only what is shown here, once.</p>
          </div>
        )}

        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}

        {approvers === null ? (
          <p className="muted">Finding who can approve…</p>
        ) : loadFailed ? null : approvers.length === 0 ? (
          capped.length > 0 ? (
            <div className="acc-empty-note">
              <p>Nobody here may approve this much.</p>
              <div className="acc-approvers" aria-label="Managers whose limit is lower">
                {capped.slice(0, CAPPED_SHOWN).map((row) => (
                  <button key={row.id} type="button" className="acc-approver is-capped" disabled aria-disabled="true">
                    <span className="acc-avatar" aria-hidden="true">
                      {initials(row.name)}
                    </span>
                    <span className="acc-approver-name">{row.name}</span>
                    <span className="badge badge-neutral">up to {row.limit}%</span>
                  </button>
                ))}
              </div>
              <p className="muted small">Give a smaller discount, or ask the owner.</p>
            </div>
          ) : (
            <p className="acc-empty-note">
              Nobody who can {request.action || "approve this"} has set a PIN yet. A manager sets one under{" "}
              <strong>My profile → Personal PIN</strong>, or an admin under <strong>Users</strong>.
            </p>
          )
        ) : (
          <>
            {folded ? (
              <div className="acc-approver-chosen">
                <span className="acc-avatar" aria-hidden="true">
                  {initials(chosen.name)}
                </span>
                <span>
                  <span className="muted small">Approving</span>
                  <strong>{chosen.name}</strong>
                </span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setPicking(true)}
                  disabled={busy}
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                {searchable && (
                  <label className="field acc-approver-find">
                    <span>Find the manager</span>
                    <input
                      type="search"
                      value={find}
                      onChange={(event) => setFind(event.target.value)}
                      placeholder={`${approvers.length} people can approve — type a name`}
                    />
                  </label>
                )}

                <div
                  className={`acc-approvers ${searchable ? "is-scrolling" : ""}`}
                  role="radiogroup"
                  aria-label="Who is approving"
                >
                  {shown.length === 0 && <p className="muted small">Nobody by that name can approve this.</p>}
                  {shown.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      role="radio"
                      aria-checked={approverId === row.id}
                      className={`acc-approver ${approverId === row.id ? "is-active" : ""}`}
                      disabled={Boolean(row.lockedUntil) || Boolean(row.pinGiven) || busy}
                      title={row.pinGiven ? `${row.name}'s PIN was set by someone else: it approves nothing until they choose their own under My profile` : undefined}
                      onClick={() => {
                        setApproverId(row.id);
                        setPicking(false);
                        setError("");
                      }}
                    >
                      <span className="acc-avatar" aria-hidden="true">
                        {initials(row.name)}
                      </span>
                      <span className="acc-approver-name">{row.name}</span>
                      {row.lockedUntil && <span className="badge badge-danger">PIN locked</span>}
                      {!row.lockedUntil && row.pinGiven && <span className="badge badge-neutral">PIN not their own yet</span>}
                    </button>
                  ))}
                  {!term &&
                    capped.slice(0, CAPPED_SHOWN).map((row) => (
                      <button
                        key={`capped-${row.id}`}
                        type="button"
                        className="acc-approver is-capped"
                        disabled
                        aria-disabled="true"
                        title={`${row.name} may approve up to ${row.limit}% off`}
                      >
                        <span className="acc-avatar" aria-hidden="true">
                          {initials(row.name)}
                        </span>
                        <span className="acc-approver-name">{row.name}</span>
                        <span className="badge badge-neutral">up to {row.limit}%</span>
                      </button>
                    ))}
                  {!term && capped.length > CAPPED_SHOWN && (
                    <p className="muted small">
                      and {capped.length - CAPPED_SHOWN} more whose limit is too low for this discount
                    </p>
                  )}
                </div>
              </>
            )}

            <div ref={padRef}>
              <PinPad
                value={pin}
                onChange={setPin}
                onSubmit={approve}
                disabled={busy}
                label="Manager's PIN"
                shakeKey={refusals}
              />
            </div>

            {noting ? (
              <label className="field">
                <span>Note for the activity log (optional)</span>
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={200}
                  placeholder="Why it was allowed"
                  autoFocus
                />
              </label>
            ) : (
              <button
                type="button"
                className="link-button acc-approval-add-note"
                onClick={() => setNoting(true)}
                disabled={busy}
              >
                Add a note for the activity log
              </button>
            )}
          </>
        )}

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={() => close(null)} disabled={busy}>
            Cancel
          </button>
          {approvers && approvers.length > 0 && (
            <button type="button" className="button" onClick={approve} disabled={busy}>
              {busy ? "Checking…" : "Approve"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
