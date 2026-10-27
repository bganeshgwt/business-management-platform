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
import { confirmAction } from "../../../services/confirm";
import { toast } from "../../../services/toast";
import { dateShort, dateTime } from "@bmp/shared/format";
import { CHANNELS, KINDS, REQUEST_CHANNELS, REQUEST_STATUS, downloadPersonFile, dueWords, kindLabel, requestTone } from "../personalData";
import { refusalOf } from "../services/privacy.service";
import { PersonPrivacy } from "../components/ChildMark";
import usePagedList from "./usePagedList";

// The requests register: a person asks to see, correct or erase their data,
// or raises a grievance. Each is received on the business's own day and
// answered within 90 days of it; the bell warns 15 days before. An access
// request is answered with the file of everything held; a correction is made
// on the normal screens; an erasure is carried out from here.

const STATUS_FILTERS = [{ value: "open", label: "Open" }, { value: "", label: "All" }, { value: "done", label: "Answered" }, { value: "refused", label: "Refused" }];

export default function RequestsTab({ privacy, openId, onOpen }) {
  const [status, setStatus] = useState("open");
  const list = usePagedList(privacy.api, "requests", { gridId: `privacy-requests-${privacy.api.kind}`, params: status ? { status } : {} });
  const [logging, setLogging] = useState(false);
  const words = privacy.api.person;

  const columns = useMemo(() => [
    { key: "no", header: "No.", value: (r) => r.request_no, mobile: "title", pin: true, render: (r) => <strong>Request {r.request_no}</strong> },
    { key: "kind", header: "Asks to", value: (r) => kindLabel(r.kind), mobile: "subtitle" },
    { key: "person", header: words.One, value: (r) => r.person_now || r.person_name,
      render: (r) => <span className="pd-two-line"><span>{r.person_now || r.person_name}</span>{r.person_now && r.person_now !== r.person_name && <small className="muted">Asked as {r.person_name}</small>}</span> },
    { key: "received", header: "Received", type: "date", value: (r) => r.received_on },
    { key: "due", header: "Answer by", type: "date", value: (r) => r.due_on, mobile: "show",
      render: (r) => <span className="pd-two-line"><span>{dateShort(r.due_on, { year: true })}</span>{r.status === "open" && <small className={`pd-due pd-due-${requestTone(r)}`}>{dueWords(r.days_left)}</small>}</span> },
    { key: "status", header: "Status", type: "status", value: (r) => REQUEST_STATUS[r.status] || r.status, mobile: "show",
      render: (r) => <StatusBadge status={r.status} label={REQUEST_STATUS[r.status] || r.status} tone={requestTone(r)} /> },
    { key: "channel", header: "Came in", value: (r) => CHANNELS[r.channel] || r.channel, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <button type="button" className="chip-button" onClick={() => onOpen(r.id)}>Open</button> },
  ], [onOpen, words.One]);

  return (
    <>
      <SectionCard flush icon="list" title="Requests"
        actions={privacy.canManage && <button type="button" className="button" onClick={() => setLogging(true)}><Icon name="plus" size={16} /> Log a request</button>}>
        <DataGrid {...list.gridProps} caption="Requests about personal data" columns={columns} rowNoun={["request", "requests"]}
          toolbar={(
            <label className="field">
              <span>Show</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
          )}
          rowClassName={(r) => (r.status !== "open" ? "dg-tone-muted" : Number(r.days_left) < 0 ? "dg-tone-danger" : requestTone(r) === "warning" ? "dg-tone-warning" : "")}
          empty={status === "open" ? "No request waiting" : "No request yet"} emptyIcon="shield"
          emptyHint={`When a ${words.one} asks to see, correct or erase their data, or complains about how it is used, log it here the day it comes: it is answered within 90 days.`} />
      </SectionCard>
      {logging && <LogRequestDialog privacy={privacy} onClose={() => setLogging(false)}
        onSaved={(row) => { setLogging(false); toast.success(`Request ${row.request_no} logged: answer by ${dateShort(row.due_on, { year: true })}.`); list.reload(); onOpen(row.id); }} />}
      {/* A panel of its own for each request, so nothing of one shows on the next. */}
      <RequestPanel key={openId || "closed"} privacy={privacy} requestId={openId} onClose={() => onOpen(null)} onChanged={list.reload} />
    </>
  );
}

function LogRequestDialog({ privacy, onClose, onSaved }) {
  const words = privacy.api.person;
  const [form, setForm] = useState({ kind: "access", person: null, personName: "", replyTo: "", channel: "counter", receivedOn: "", details: "" });
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
      onSaved(await privacy.api.logRequest({ requestKey, kind: form.kind, personId: form.person?.id || null, personName: form.person ? undefined : form.personName.trim() || undefined,
        replyTo: form.replyTo.trim() || null, channel: form.channel, receivedOn: form.receivedOn || undefined, details: form.details.trim() }));
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="Log a request" icon="shield" width={640} onClose={onClose} dismissible={!busy}
      description="The day it came is the day it is received: it is answered within 90 days of it, on the business's own clock.">
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
        <FormField label="What they ask">
          <select value={form.kind} onChange={set("kind")}>{Object.entries(KINDS).map(([value, k]) => <option key={value} value={value}>{k.label}</option>)}</select>
        </FormField>
        <FormField label="How it came in">
          <select value={form.channel} onChange={set("channel")}>{REQUEST_CHANNELS.map((c) => <option key={c} value={c}>{CHANNELS[c]}</option>)}</select>
        </FormField>
        <SearchPicker className="field-wide" label={`The ${words.one}`} hint={`Find them in your ${words.many}; if they cannot be found yet, give their name below and link them later.`}
          value={form.person} onChange={(person) => setForm((f) => ({ ...f, person }))} search={search}
          getLabel={(p) => p.name} getDescription={(p) => [p.phone, p.email].filter(Boolean).join(" · ")} placeholder="Name, phone or e-mail" />
        {!form.person && (
          <FormField label="Who asked">
            <input required maxLength={150} value={form.personName} onChange={set("personName")} />
          </FormField>
        )}
        <FormField label="Where to reply" optional hint="A phone number, e-mail or address they gave for the answer.">
          <input maxLength={150} value={form.replyTo} onChange={set("replyTo")} />
        </FormField>
        <FormField label="Received on" optional hint="Today when left empty.">
          <input type="date" value={form.receivedOn} onChange={set("receivedOn")} />
        </FormField>
        <FormField label="What they asked" wide>
          <textarea required rows={3} maxLength={2000} value={form.details} onChange={set("details")} />
        </FormField>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Log the request"}</button>
        </div>
      </form>
    </Modal>
  );
}

// One request: who and what, the 90 days, the person's consents, and the
// work that answers it (the file of their data, the erasure, the reply).
function RequestPanel({ privacy, requestId, onClose, onChanged }) {
  const [request, setRequest] = useState(null);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(null);
  const [answering, setAnswering] = useState(null);
  const [busy, setBusy] = useState(false);
  const words = privacy.api.person;
  const load = useCallback((signal) => privacy.api.request(requestId, signal).then((r) => { setRequest(r); setError(""); })
    .catch((err) => { if (!signal?.aborted) setError(getErrorMessage(err)); }), [privacy.api, requestId]);
  useEffect(() => {
    if (!requestId) return undefined;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, requestId]);
  const changed = () => { load(); onChanged(); };
  const search = useCallback((q, { signal }) => privacy.api.search(q, signal), [privacy.api]);
  const run = async (work) => {
    setBusy(true);
    setError("");
    try { await work(); } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(false); }
  };

  const exportFile = () => run(async () => {
    const file = await privacy.api.exportData(request.person_id, request.id);
    downloadPersonFile(file);
    toast.success(`${file.filename} saved. Send it to them, then answer the request.`);
  });
  const erase = () => run(async () => {
    const ok = await confirmAction({ title: request.person?.name ? `Erase ${request.person.name}'s data?` : "Erase their data?", confirmLabel: "Erase their data",
      message: `Their name, phone, e-mail and address go from every record where no law keeps them, and cannot be brought back. Bills and other tax records keep what tax law needs. Their consents and this request are kept as the record.` });
    if (!ok) return;
    try {
      const done = await privacy.api.erase(request.id, { requestKey: crypto.randomUUID() });
      setRequest(done);
      setBlocked(null);
      toast.success(`Erased. Request ${done.request_no} is answered.`);
      onChanged();
    } catch (err) {
      const reason = refusalOf(err);
      if (reason?.reason === "erasure_blocked") setBlocked(reason.open);
      else throw err;
    }
  });

  const open = request?.status === "open";
  const person = request?.person;
  return (
    <SidePanel open={Boolean(requestId)} icon="shield" onClose={onClose}
      title={request ? `Request ${request.request_no}: ${kindLabel(request.kind).toLowerCase()}` : "Request"}
      rule={request ? `Received ${dateShort(request.received_on, { year: true })} · answer by ${dateShort(request.due_on, { year: true })}` : ""}>
      <div className="stack pd-panel">
        <ErrorMessage message={error} />
        {!request ? (!error && <p className="muted">Loading…</p>) : (
          <>
            <div className="pd-facts">
              <StatusBadge status={request.status} label={REQUEST_STATUS[request.status]} tone={requestTone(request)} />
              {open && <span className={`pd-due pd-due-${requestTone(request)}`}>{dueWords(request.days_left)}</span>}
              <span className="muted">{CHANNELS[request.channel]}{request.reply_to ? ` · reply to ${request.reply_to}` : ""}</span>
            </div>
            <p className="pd-asked"><strong>{request.person_name}</strong> asked: {request.details}</p>

            <section className="pd-section" aria-label={`The ${words.one}`}>
              <h3>The {words.one}</h3>
              {person ? (
                <>
                  <p>{person.name}{person.phone ? ` · ${person.phone}` : ""}{person.email ? ` · ${person.email}` : ""}{person.erased_at ? " · data erased" : ""}</p>
                  {!person.erased_at && <PersonPrivacy privacy={privacy} person={{ id: request.person_id }} onChanged={changed} />}
                </>
              ) : open && privacy.canManage ? (
                <SearchPicker label={`Link the request to the ${words.one}`} search={search} getLabel={(p) => p.name}
                  getDescription={(p) => [p.phone, p.email].filter(Boolean).join(" · ")} placeholder="Name, phone or e-mail"
                  onChange={(picked) => picked && run(async () => { await privacy.api.linkRequest(request.id, picked.id); changed(); })} />
              ) : <p className="muted">Not linked to a {words.one}.</p>}
            </section>

            {open && privacy.canManage && (
              <section className="pd-section" aria-label="Answer it">
                <h3>Answer it</h3>
                {request.kind === "access" && (
                  <p>Save the file of everything held about them and send it to them, then record the answer.</p>
                )}
                {request.kind === "correction" && <p>Correct their details on their record ({words.many}), then record the answer.</p>}
                {request.kind === "erasure" && (
                  <p>Erasing removes their personal details wherever no law keeps them; bills keep what tax law needs. It waits for anything still open with them.</p>
                )}
                {blocked && (
                  <div className="pd-blocked" role="alert">
                    <strong>Not yet: settle these first.</strong>
                    <ul>{blocked.map((line) => <li key={line}>{line}</li>)}</ul>
                  </div>
                )}
                {request.open?.length > 0 && !blocked && (
                  <div className="pd-blocked"><strong>Still open with them</strong><ul>{request.open.map((line) => <li key={line}>{line}</li>)}</ul></div>
                )}
                <div className="pd-actions">
                  {request.kind === "access" && request.person_id && privacy.canExport && (
                    <button type="button" className="button" disabled={busy} onClick={exportFile}><Icon name="download" size={16} /> Save their data as a file</button>
                  )}
                  {request.kind === "erasure" && request.person_id && !person?.erased_at && (
                    <button type="button" className="button button-danger" disabled={busy} onClick={erase}><Icon name="trash" size={16} /> Erase their data</button>
                  )}
                  {request.kind !== "erasure" && <button type="button" className="button button-secondary" disabled={busy} onClick={() => setAnswering("done")}>Record the answer</button>}
                  <button type="button" className="button button-secondary" disabled={busy} onClick={() => setAnswering("refused")}>Refuse, with the reason</button>
                </div>
                {answering && <AnswerForm privacy={privacy} request={request} status={answering} onCancel={() => setAnswering(null)}
                  onSaved={(row) => { setAnswering(null); setRequest((r) => ({ ...r, ...row })); onChanged(); toast.success(`Request ${row.request_no} answered.`); }} />}
              </section>
            )}

            {!open && (
              <section className="pd-section" aria-label="The answer">
                <h3>The answer</h3>
                <p>{request.reply}</p>
                <small className="muted">{request.status === "refused" ? "Refused" : "Answered"} {dateTime(request.closed_at)}{request.closed_by_name ? ` by ${request.closed_by_name}` : ""}</small>
                {request.erasure && (
                  <div className="pd-erasure">
                    <h4>What was erased</h4>
                    <ul>{request.erasure.erased.map((e) => <li key={e.heading}>{e.heading}{e.rows > 1 ? ` (${e.rows})` : ""}</li>)}</ul>
                    <h4>What is kept, and why</h4>
                    <ul>{request.erasure.kept.map((line) => <li key={line}>{line}</li>)}</ul>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </SidePanel>
  );
}

function AnswerForm({ privacy, request, status, onCancel, onSaved }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await privacy.api.closeRequest(request.id, { status, reply: reply.trim() }));
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <form className="stack pd-answer" onSubmit={save}>
      <ErrorMessage message={error} />
      <FormField label={status === "refused" ? "Why it is refused (sent to them)" : "The answer sent to them"}>
        <textarea required rows={3} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} />
      </FormField>
      <div className="pd-actions">
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="button" disabled={busy || reply.trim().length < 3}>{busy ? "Saving…" : status === "refused" ? "Refuse the request" : "Save the answer"}</button>
      </div>
    </form>
  );
}
