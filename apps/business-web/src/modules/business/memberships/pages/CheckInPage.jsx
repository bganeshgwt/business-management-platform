import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { timeOnly } from "@bmp/shared/format";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { REASONS, dayWords, statusOf } from "./memberships";
import "../styles/memberships.css";

// Check-in at the front desk: the member's code typed or scanned from the QR
// on their card (a scanner types it and presses Enter), or their name or
// phone searched; the answer comes at once in large type: let in (with the
// plan, its last day or the sessions left, and grace days or a second visit
// today said), or turned away with the reason (another branch, outside the
// plan's hours or its visits used among them). A member with a pack as well
// can use a session of it instead; a class booked now is marked attended.
// Today's check-ins are below.

const CODE = /^[A-Za-z0-9][A-Za-z0-9-]{1,19}$/;

export default function CheckInPage() {
  const biz = useOpenBusiness();
  const input = useRef(null);
  const today = businessToday(biz.business.timezone);
  const [text, setText] = useState("");
  const [matches, setFound] = useState({ q: "", items: [] });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canCheck = biz.can("member_plans.create");
  const location = biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id;
  const list = useServerList("member-plans/check-ins", { gridId: "member-checkins-today", params: { from: today, to: today } });
  useEffect(() => { input.current?.focus(); }, []);
  // Members matching what is typed (two letters or more), for what is typed now.
  const typed = text.trim();
  const found = typed.length >= 2 && matches.q === typed ? matches.items : [];
  useEffect(() => {
    if (typed.length < 2) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessRead(biz.id, "member-plans/members", { q: typed, limit: 8 }, controller.signal).then((page) => setFound({ q: typed, items: page.items }))
        .catch(() => setFound({ q: typed, items: [] }));
    }, 200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [biz.id, typed]);
  const check = async (body) => {
    setBusy(true);
    setError("");
    try {
      const answer = await businessWrite(biz.id, "member-plans/check-ins", { requestKey: newKey(), locationId: location, ...body });
      setResult(answer);
      setText("");
      setFound({ q: "", items: [] });
      list.reload();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  const submit = (event) => {
    event.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    const code = q.replace(/\s+/g, "").toUpperCase();
    // A member's code (a scanner types it and presses Enter before any search
    // comes back), or the one member the search found by name or phone.
    if (found.some((m) => (m.member_code || "").toUpperCase() === code)) return check({ code });
    if (found.length === 1) return check({ contactId: found[0].contact_id });
    if (!found.length && CODE.test(code)) return check({ code });
    setError(found.length ? "Several members match: choose one from the list" : "No member matches: check the code, or search by name or phone");
  };
  const columns = useMemo(() => [
    { key: "created_at", header: "Time", value: (k) => k.created_at, render: (k) => timeOnly(k.created_at), mobile: "subtitle" },
    { key: "member_name", header: "Member", value: (k) => `${k.member_name} ${k.member_code || ""}`, mobile: "title",
      render: (k) => <Link to={biz.path(`members/${k.contact_id}`)} className="bz-two-line"><span>{k.member_name}</span><small className="muted mono">{k.member_code}</small></Link> },
    { key: "plan_name", header: "Membership", value: (k) => k.plan_name || "", render: (k) => k.plan_name || <span className="muted">—</span> },
    { key: "allowed", header: "", value: (k) => (k.allowed ? "In" : REASONS[k.reason]), mobile: "show",
      render: (k) => <Badge tone={k.allowed ? "success" : "danger"} label={k.allowed ? (k.session_used ? `In · ${k.sessions_left} left` : "In") : REASONS[k.reason]} /> },
    { key: "note", header: "Note", value: (k) => k.note || "" },
    { key: "by_name", header: "By", value: (k) => k.by_name, defaultHidden: true },
  ], [biz]);
  return (
    <div className="stack">
      <BusinessHeader icon="check" title="Check-in" description="Type or scan the member's code, or find them by name or phone. Let in, or turned away with the reason; every check-in is kept." />
      {canCheck && (
        <SectionCard icon="qr" title="Who is here?">
          <form className="mem-checkin" onSubmit={submit}>
            <input ref={input} className="mem-checkin-input" value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
              placeholder="Member code, name or phone" aria-label="Member code, name or phone" autoComplete="off" spellCheck={false} />
            <button type="submit" className="button" disabled={busy || !text.trim()}><Icon name="check" size={16} /> Check in</button>
          </form>
          {found.length > 0 && (
            <ul className="mem-found">
              {found.map((m) => (
                <li key={m.contact_id}>
                  <button type="button" className="mem-found-row" disabled={busy} onClick={() => check({ contactId: m.contact_id })}>
                    <span className="bz-two-line"><span>{m.name}</span><small className="muted">{[m.member_code, m.phone].filter(Boolean).join(" · ")}</small></span>
                    <span className="bz-two-line"><span>{m.plan_name || "No membership"}</span><small className="muted">{m.end_on ? `to ${dayWords(m.end_on)}` : m.sessions_total ? `${m.sessions_left} sessions left` : ""}</small></span>
                    {m.status && <Badge tone={statusOf(m).tone} label={statusOf(m).label} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ErrorMessage message={error} />
          {result && <Answer result={result} busy={busy} onUse={(m) => check({ contactId: result.contact_id, membershipId: m.id })} />}
        </SectionCard>
      )}
      <SectionCard flush icon="clock" title="Today's check-ins">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Member, code or plan" }} caption="Today's check-ins" columns={columns}
          rowKey={(k) => k.id} rowNoun={["check-in", "check-ins"]} rowClassName={(k) => (k.allowed ? "" : "dg-tone-danger")}
          exportName={biz.can("member_plans.export") ? `${biz.business.code}-check-ins-${today}` : undefined}
          empty="No check-ins yet today" emptyIcon="check" />
      </SectionCard>
    </div>
  );
}

function Answer({ result: r, busy, onUse }) {
  const biz = useOpenBusiness();
  const left = r.sessions_left !== null && r.sessions_left !== undefined;
  return (
    <div className={`mem-answer ${r.allowed ? "is-in" : "is-out"}`} role="status" aria-live="polite">
      <div className="mem-answer-head">
        <Icon name={r.allowed ? "check-circle" : "x-circle"} size={30} />
        <div>
          <strong className="mem-answer-title">{r.allowed ? `${r.member_name} is in` : `${r.member_name}: ${REASONS[r.reason]}`}</strong>
          <small>{r.member_code ? `Member ${r.member_code}` : "No member code"}{r.plan_name ? ` · ${r.plan_name} (${r.membership_no})` : ""}</small>
        </div>
      </div>
      <p className="mem-answer-words">
        {r.allowed
          ? [r.end_on ? `Runs to ${dayWords(r.end_on)}` : null, left ? `${r.sessions_left} of ${r.sessions_total} sessions left${r.session_used ? " (one used now)" : ""}` : null,
            r.again_today ? `already in today at ${timeOnly(r.first_today_at)}` : null, r.note].filter(Boolean).join(" · ")
          : r.words}
        {r.fees_overdue ? ` (${biz.exact(r.fees_overdue)})` : ""}
      </p>
      {(r.classes || []).length > 0 && (
        <p className="mem-answer-words">Attended: {r.classes.map((k) => `${k.className} at ${k.time}${k.sessionUsed ? " (a session used)" : ""}`).join(", ")}</p>
      )}
      <div className="form-actions bz-start">
        {(r.others || []).map((m) => (
          <button key={m.id} type="button" className="button button-secondary button-sm" disabled={busy || m.session_today} onClick={() => onUse(m)}>
            Use {m.plan_name}{m.sessions_left !== null ? ` (${m.sessions_left} left)` : ""}{m.session_today ? ": used today" : ""}
          </button>
        ))}
        <Link className="button button-secondary button-sm" to={biz.path(`members/${r.contact_id}`)}>The member's page</Link>
      </div>
    </div>
  );
}
