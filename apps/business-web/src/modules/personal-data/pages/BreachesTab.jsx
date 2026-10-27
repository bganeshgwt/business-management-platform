import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../components/DataGrid/DataGrid";
import SectionCard from "../../../components/SectionCard";
import SidePanel from "../../../components/SidePanel";
import Modal from "../../../components/Modal";
import FormField from "../../../components/FormField";
import SearchPicker from "../../../components/SearchPicker";
import StatusBadge from "../../../components/StatusBadge";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { toast } from "../../../services/toast";
import { dateTime } from "@bmp/shared/format";
import { BOARD_HOURS, NOTICE_CHANNELS, boardWords, breachTone } from "../personalData";
import usePagedList from "./usePagedList";

// The breach register. A breach records when it was found, what happened,
// its impact, the steps taken and the people affected (chosen, or every
// customer). The Data Protection Board is told without delay and sent a
// detailed report within 72 hours of when it was found: the register shows
// the hours left. The people affected are told in plain language, filled from
// the record, and each notice sent is recorded. It files nothing itself.

// A moment typed in a datetime-local box, as the server reads it.
const fromLocal = (value) => (value ? new Date(value).toISOString() : null);
const toLocal = (value) => {
  if (!value) return "";
  const at = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
};
const STATUS = { open: "Open", closed: "Closed" };

export default function BreachesTab({ privacy, openId, onOpen }) {
  const list = usePagedList(privacy.api, "breaches", { gridId: `privacy-breaches-${privacy.api.kind}` });
  const [recording, setRecording] = useState(false);
  const columns = useMemo(() => [
    { key: "no", header: "No.", value: (b) => b.breach_no, mobile: "title", pin: true, render: (b) => <strong>Breach {b.breach_no}</strong> },
    { key: "found", header: "Found", type: "date", value: (b) => b.found_at, render: (b) => dateTime(b.found_at) },
    { key: "what", header: "What happened", value: (b) => b.what_happened, mobile: "subtitle", minWidth: 240 },
    { key: "board", header: "The Board", value: (b) => boardWords(b), mobile: "show",
      render: (b) => <StatusBadge status={b.status} label={boardWords(b)} tone={breachTone(b)} /> },
    { key: "people", header: "People affected", value: (b) => (b.affected === "all" ? "Everyone" : b.people), render: (b) => (b.affected === "all" ? "Everyone" : b.people) },
    { key: "notices", header: "Notices sent", type: "number", value: (b) => b.notices },
    { key: "status", header: "Status", type: "status", value: (b) => STATUS[b.status], render: (b) => <StatusBadge status={b.status} label={STATUS[b.status]} tone={b.status === "open" ? "info" : "neutral"} /> },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (b) => <button type="button" className="chip-button" onClick={() => onOpen(b.id)}>Open</button> },
  ], [onOpen]);
  return (
    <>
      <SectionCard flush icon="alert" title="Breaches"
        actions={privacy.canManage && <button type="button" className="button" onClick={() => setRecording(true)}><Icon name="plus" size={16} /> Record a breach</button>}>
        <DataGrid {...list.gridProps} caption="Personal data breaches" columns={columns} rowNoun={["breach", "breaches"]}
          rowClassName={(b) => (b.status === "closed" ? "dg-tone-muted" : breachTone(b) === "danger" ? "dg-tone-danger" : "")}
          empty="No breach recorded" emptyIcon="shield"
          emptyHint="If personal data is lost, stolen or seen by someone who should not see it, record it here at once: the Board's detailed report is due within 72 hours." />
      </SectionCard>
      {recording && <RecordBreachDialog privacy={privacy} onClose={() => setRecording(false)}
        onSaved={(row) => { setRecording(false); toast.success(`Breach ${row.breach_no} recorded. The Board's report is due by ${dateTime(row.board_due_at)}.`); list.reload(); onOpen(row.id); }} />}
      {/* A panel of its own for each breach, so nothing of one shows on the next. */}
      <BreachPanel key={openId || "closed"} privacy={privacy} breachId={openId} onClose={() => onOpen(null)} onChanged={list.reload} />
    </>
  );
}

function RecordBreachDialog({ privacy, onClose, onSaved }) {
  const words = privacy.api.person;
  const [form, setForm] = useState({ foundAt: toLocal(new Date()), whatHappened: "", impact: "", stepsTaken: "", affected: "chosen", people: [] });
  const [requestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const search = useCallback((q, { signal }) => privacy.api.search(q, signal), [privacy.api]);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await privacy.api.recordBreach({ requestKey, foundAt: fromLocal(form.foundAt), whatHappened: form.whatHappened.trim(), impact: form.impact.trim(),
        stepsTaken: form.stepsTaken.trim(), affected: form.affected, people: form.affected === "chosen" ? form.people.map((p) => p.id) : [] }));
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="Record a breach" icon="alert" width={680} onClose={onClose} dismissible={!busy}
      description={`The Data Protection Board is told without delay and sent a detailed report within ${BOARD_HOURS} hours of when it was found; the people affected are told in plain language. This register files nothing itself.`}>
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
        <FormField label="When it was found">
          <input type="datetime-local" required value={form.foundAt} onChange={set("foundAt")} />
        </FormField>
        <FormField label="Who is affected">
          <select value={form.affected} onChange={set("affected")}>
            <option value="chosen">Some {words.many}, chosen by name</option>
            <option value="all">Every {words.one}</option>
          </select>
        </FormField>
        <FormField label="What happened" wide>
          <textarea required rows={3} maxLength={4000} value={form.whatHappened} onChange={set("whatHappened")} />
        </FormField>
        <FormField label="The impact on them" wide hint="What of theirs may be seen or used, and what that may mean for them.">
          <textarea required rows={2} maxLength={4000} value={form.impact} onChange={set("impact")} />
        </FormField>
        <FormField label="The steps taken" wide>
          <textarea required rows={2} maxLength={4000} value={form.stepsTaken} onChange={set("stepsTaken")} />
        </FormField>
        {form.affected === "chosen" && (
          <div className="field-wide stack">
            <SearchPicker label={`Add the ${words.many} affected`} search={search} clearOnSelect getLabel={(p) => p.name}
              getDescription={(p) => [p.phone, p.email].filter(Boolean).join(" · ")} placeholder="Name, phone or e-mail"
              onChange={(p) => p && setForm((f) => (f.people.some((x) => x.id === p.id) ? f : { ...f, people: [...f.people, p] }))} />
            {form.people.length > 0 && (
              <div className="pd-chips">
                {form.people.map((p) => (
                  <button key={p.id} type="button" className="pd-chip is-on" onClick={() => setForm((f) => ({ ...f, people: f.people.filter((x) => x.id !== p.id) }))}
                    aria-label={`Take ${p.name} off`}>{p.name} <Icon name="x" size={12} /></button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Record the breach"}</button>
        </div>
      </form>
    </Modal>
  );
}

// WhatsApp, with the notice as its words, to a person's own number.
const whatsappTo = (phone, text) => {
  const digits = String(phone || "").replace(/\D/g, "");
  const to = digits.length === 10 ? `91${digits}` : digits.length === 11 && digits.startsWith("0") ? `91${digits.slice(1)}` : digits;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
};

function BreachPanel({ privacy, breachId, onClose, onChanged }) {
  const words = privacy.api.person;
  const [breach, setBreach] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [board, setBoard] = useState(null);
  const [noticeText, setNoticeText] = useState(null);
  const [sendTo, setSendTo] = useState(null);
  const [everyone, setEveryone] = useState(null);
  const load = useCallback((signal) => privacy.api.breach(breachId, signal).then((b) => {
    setBreach(b);
    setError("");
    setBoard({ informedAt: toLocal(b.board_informed_at), reportAt: toLocal(b.board_report_at), reference: b.board_reference || "" });
    setNoticeText(b.people_notice_text);
  }).catch((err) => { if (!signal?.aborted) setError(getErrorMessage(err)); }), [privacy.api, breachId]);
  useEffect(() => {
    if (!breachId) return undefined;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, breachId]);
  const run = async (work, done) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
      onChanged();
      if (done) toast.success(done);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const search = useCallback((q, { signal }) => privacy.api.search(q, signal), [privacy.api]);
  const open = breach?.status === "open";
  const notified = new Set((breach?.notices || []).map((n) => String(n.person_id)));
  const showEveryone = () => privacy.api.everyone({ limit: 100 }).then(setEveryone).catch((err) => setError(getErrorMessage(err)));

  const saveBoard = () => run(() => privacy.api.updateBreach(breach.id, { boardInformedAt: fromLocal(board.informedAt), boardReportAt: fromLocal(board.reportAt),
    boardReference: board.reference.trim() || null }), "Saved.");
  const saveNotice = () => run(() => privacy.api.updateBreach(breach.id, { peopleNotice: noticeText.trim() }), "The notice to the people affected is saved.");
  // Refused, with the server's sentence, until the report to the Board is recorded.
  const close = () => run(() => privacy.api.closeBreach(breach.id), `Breach ${breach.breach_no} closed.`);

  return (
    <SidePanel open={Boolean(breachId)} icon="alert" wide onClose={onClose} title={breach ? `Breach ${breach.breach_no}` : "Breach"}
      rule={breach ? `Found ${dateTime(breach.found_at)} · the Board's report due by ${dateTime(breach.board_due_at)}` : ""}>
      <div className="stack pd-panel">
        <ErrorMessage message={error} />
        {!breach ? (!error && <p className="muted">Loading…</p>) : (
          <>
            <div className="pd-facts">
              <StatusBadge status={breach.status} label={boardWords(breach)} tone={breachTone(breach)} />
              <span className="muted">{breach.affected === "all" ? `Every ${words.one} (${breach.affected_count})` : `${breach.affected_count} ${breach.affected_count === 1 ? words.one : words.many} affected`}</span>
            </div>
            <dl className="pd-record">
              <dt>What happened</dt><dd>{breach.what_happened}</dd>
              <dt>The impact</dt><dd>{breach.impact}</dd>
              <dt>The steps taken</dt><dd>{breach.steps_taken}</dd>
            </dl>

            <section className="pd-section" aria-label="The Data Protection Board">
              <h3>The Data Protection Board</h3>
              <p className="muted">Tell the Board without delay, and send it the detailed report within {BOARD_HOURS} hours of when the breach was found. Record both here.</p>
              <div className="form-grid">
                <FormField label="When the Board was told" optional>
                  <input type="datetime-local" disabled={!open || !privacy.canManage} value={board?.informedAt || ""} onChange={(e) => setBoard((b) => ({ ...b, informedAt: e.target.value }))} />
                </FormField>
                <FormField label="When the detailed report went" optional>
                  <input type="datetime-local" disabled={!open || !privacy.canManage} value={board?.reportAt || ""} onChange={(e) => setBoard((b) => ({ ...b, reportAt: e.target.value }))} />
                </FormField>
                <FormField label="The Board's reference" optional>
                  <input maxLength={100} disabled={!open || !privacy.canManage} value={board?.reference || ""} onChange={(e) => setBoard((b) => ({ ...b, reference: e.target.value }))} />
                </FormField>
              </div>
              {open && privacy.canManage && <div className="pd-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={saveBoard}>Save</button></div>}
            </section>

            <section className="pd-section" aria-label="The notice to the people affected">
              <h3>The notice to the people affected</h3>
              <FormField label="In plain language, filled from the record" hint="Edit it if needed; every notice sent keeps the words it went with.">
                <textarea rows={8} maxLength={4000} disabled={!open || !privacy.canManage} value={noticeText || ""} onChange={(e) => setNoticeText(e.target.value)} />
              </FormField>
              {open && privacy.canManage && noticeText !== breach.people_notice_text && (
                <div className="pd-actions"><button type="button" className="button button-secondary" disabled={busy || (noticeText || "").trim().length < 50} onClick={saveNotice}>Save the notice</button></div>
              )}
            </section>

            <section className="pd-section" aria-label="The people affected">
              <h3>The people affected</h3>
              {breach.affected === "chosen" ? (
                <>
                  {open && privacy.canManage && (
                    <SearchPicker label={`Add a ${words.one}`} search={search} clearOnSelect getLabel={(p) => p.name}
                      getDescription={(p) => [p.phone, p.email].filter(Boolean).join(" · ")} placeholder="Name, phone or e-mail"
                      onChange={(p) => p && run(() => privacy.api.addPeople(breach.id, [p.id]), `${p.name} added.`)} />
                  )}
                  <PeopleList people={breach.people} notified={notified} open={open && privacy.canManage} busy={busy}
                    onSend={setSendTo} onRemove={(p) => run(() => privacy.api.removePerson(breach.id, p.person_id), `${p.name} taken off.`)} />
                </>
              ) : (
                <>
                  <p className="muted">Every {words.one} is affected. Tell each one, and record each notice sent.</p>
                  {everyone ? (
                    <PeopleList people={everyone.items.map((p) => ({ person_id: p.id, name: p.name, phone: p.phone, email: p.email }))} notified={notified}
                      open={open && privacy.canManage} busy={busy} onSend={setSendTo} />
                  ) : <button type="button" className="chip-button" onClick={showEveryone}>Show them</button>}
                  {everyone && everyone.total > everyone.items.length && (
                    <p className="muted">The first {everyone.items.length} of {everyone.total}. Find anyone else by name:</p>
                  )}
                  {everyone && everyone.total > everyone.items.length && open && privacy.canManage && (
                    <SearchPicker label={`Find a ${words.one}`} search={search} clearOnSelect getLabel={(p) => p.name}
                      onChange={(p) => p && setSendTo({ person_id: p.id, name: p.name, phone: p.phone, email: p.email })} />
                  )}
                </>
              )}
            </section>

            {breach.notices.length > 0 && (
              <section className="pd-section" aria-label="Notices sent">
                <h3>Notices sent</h3>
                <ul className="pd-consents">
                  {breach.notices.map((n) => (
                    <li key={n.id}><strong>{n.name}</strong><small className="muted">{NOTICE_CHANNELS[n.channel] || n.channel} · {dateTime(n.sent_at)}{n.sent_by_name ? ` · ${n.sent_by_name}` : ""}</small></li>
                  ))}
                </ul>
              </section>
            )}

            {open && privacy.canManage && (
              <div className="pd-actions">
                <button type="button" className="button" disabled={busy} onClick={close}>Close the breach</button>
              </div>
            )}
          </>
        )}
      </div>
      {sendTo && breach && (
        <SendNoticeDialog privacy={privacy} breach={breach} person={sendTo} text={breach.people_notice_text} onClose={() => setSendTo(null)}
          onSent={() => { setSendTo(null); load(); onChanged(); toast.success("Notice recorded."); }} />
      )}
    </SidePanel>
  );
}

function PeopleList({ people, notified, open, busy, onSend, onRemove }) {
  if (!people.length) return <p className="muted">No one added yet.</p>;
  return (
    <ul className="pd-people">
      {people.map((p) => (
        <li key={p.person_id}>
          <span className="pd-two-line"><strong>{p.name}</strong><small className="muted">{[p.phone, p.email].filter(Boolean).join(" · ") || "No phone or e-mail kept"}</small></span>
          {notified.has(String(p.person_id)) ? <StatusBadge status="done" label="Told" tone="success" /> : open && (
            <span className="pd-actions">
              <button type="button" className="chip-button" disabled={busy} onClick={() => onSend(p)}>Send the notice</button>
              {onRemove && <button type="button" className="chip-button" disabled={busy} onClick={() => onRemove(p)}>Take off</button>}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// Sending one person the notice: by WhatsApp with its words, or by SMS,
// e-mail, letter, a call or in person; recorded once sent.
function SendNoticeDialog({ privacy, breach, person, text, onClose, onSent }) {
  const [channel, setChannel] = useState(person.phone ? "whatsapp" : person.email ? "email" : "in_person");
  const [requestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const record = async () => {
    setBusy(true);
    setError("");
    try {
      await privacy.api.recordNotice(breach.id, { requestKey, personId: person.person_id, channel });
      onSent();
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Tell ${person.name}`} icon="message" width={560} onClose={onClose} dismissible={!busy}
      description="Send it from the business's own phone or e-mail, then record it here.">
      <div className="stack">
        <ErrorMessage message={error} />
        <label className="field">
          <span>How it goes</span>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {Object.entries(NOTICE_CHANNELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <pre className="pd-notice-text">{text}</pre>
        {channel === "whatsapp" && person.phone && (
          <a className="button button-secondary" href={whatsappTo(person.phone, text)} target="_blank" rel="noreferrer"><Icon name="message" size={16} /> Open WhatsApp with the notice</a>
        )}
        {channel === "email" && person.email && (
          <a className="button button-secondary" href={`mailto:${person.email}?subject=${encodeURIComponent("About your personal data")}&body=${encodeURIComponent(text)}`}>
            <Icon name="mail" size={16} /> Open an e-mail with the notice</a>
        )}
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="button" onClick={record} disabled={busy}>{busy ? "Recording…" : "Record it as sent"}</button>
        </div>
      </div>
    </Modal>
  );
}
