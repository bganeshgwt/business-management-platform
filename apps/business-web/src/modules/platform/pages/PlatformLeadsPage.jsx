import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import DataGrid from "../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../components/DateRangeFilter";
import FormField from "../../../components/FormField";
import Modal from "../../../components/Modal";
import StatusBadge from "../../../components/StatusBadge";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { count, dateShort, dateTime } from "@bmp/shared/format";
import { daysAgo, today } from "@bmp/shared/dates";
import { addLeadNote, getTrialFunnel, listLeads, setLeadStatus } from "../services/dashboards.service";
import {
  BUCKETS, avgDaysText, conversionText, funnelRows, leadStatusWord, outcomeWord, sourceWord, stateWord, trialLengthWord,
} from "../funnelWords";
import "../styles/dashboards.css";

// Platform › Leads & trials (/platform/leads): the free-trial funnel for any
// dates (requests to be called back, free trials started and where they came
// from, a first sale during the trial, still on trial, continued (paid) and
// stopped), filtered or split by business type, state, source tag, plan and
// trial length, each number opening the businesses behind it with the owner to
// call; and every lead with its follow-up and notes. Every list has a CSV.

const ENQUIRY_BUCKETS = ["enquiries", "enquiriesSignedUp"];
const SPLITS = [
  { value: "type", label: "Business type" }, { value: "state", label: "State" }, { value: "ref", label: "Source tag" },
  { value: "plan", label: "Plan chosen" }, { value: "trialDays", label: "Trial length" },
];
const NO_FILTERS = { type: "", state: "", ref: "", plan: "", trialDays: "" };
const OUTCOME_TONES = { on_trial: "info", continued: "success", stopped: "danger", not_signed_up: "neutral" };
const STATE_TONES = { trial: "info", paid: "success", given: "primary", grace: "warning", checking: "info", ended: "danger", off: "neutral" };
const LEAD_STATUSES = ["new", "contacted", "not_interested"];
// The query the API takes: only the filters that are set.
const asParams = (values) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== null && value !== undefined));
const phoneLink = (mobile) => (mobile ? <a href={`tel:${mobile}`}>{mobile}</a> : null);

export default function PlatformLeadsPage() {
  const [range, setRange] = useState(() => ({ from: daysAgo(29), to: today() }));
  const [filters, setFilters] = useState(NO_FILTERS);
  const [by, setBy] = useState("");
  const [funnel, setFunnel] = useState(null);
  const [choices, setChoices] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const query = useMemo(() => asParams({ ...range, ...filters }), [range, filters]);

  useEffect(() => {
    let current = true;
    getTrialFunnel({ ...query, ...asParams({ by }) })
      .then((result) => {
        if (!current) return;
        setFunnel(result);
        setChoices(result.choices);
        setError("");
      })
      .catch((err) => current && setError(getErrorMessage(err)));
    return () => { current = false; };
  }, [query, by]);

  const setFilter = (key) => (event) => setFilters((before) => ({ ...before, [key]: event.target.value }));
  const plans = (choices?.plans || []).filter((plan) => !filters.type || plan.businessType === filters.type);

  return (
    <div className="stack pd-page">
      <PageHeader icon="users" eyebrow="Platform" title="Leads & trials"
        description="Who asked to be called back, who started a free trial, who went on to pay and who stopped. Every number opens the businesses behind it, with the owner to call." />
      <ErrorMessage message={error} />
      <SectionCard icon="chart" title="Free-trial funnel"
        description="Trials that started in these dates, on each business's own date; enquiries on the day they came in. A trial replaced by given time is not counted.">
        <div className="pd-filters">
          <DateRangeFilter from={range.from} to={range.to} label="trial dates" onChange={(next) => { if (next.from && next.to) setRange(next); }} />
          <label className="field">
            <span>Business type</span>
            <select aria-label="Business type" value={filters.type} onChange={(event) => setFilters((before) => ({ ...before, type: event.target.value, plan: "" }))}>
              <option value="">Every type</option>
              {(choices?.types || []).map((type) => <option key={type.code} value={type.code}>{type.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>State</span>
            <select aria-label="State" value={filters.state} onChange={setFilter("state")}>
              <option value="">Every state</option>
              {(choices?.states || []).map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Source tag</span>
            <select aria-label="Source tag" value={filters.ref} onChange={setFilter("ref")}>
              <option value="">Any source</option>
              {(choices?.refs || []).map((ref) => <option key={ref} value={ref}>{ref}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Plan chosen</span>
            <select aria-label="Plan chosen" value={filters.plan} onChange={setFilter("plan")}>
              <option value="">Any plan</option>
              {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name} · {plan.typeName}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Trial length</span>
            <select aria-label="Trial length" value={filters.trialDays} onChange={setFilter("trialDays")}>
              <option value="">Any length</option>
              {(choices?.trialLengths || []).map((days) => <option key={days} value={days}>{trialLengthWord(days)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Split by</span>
            <select aria-label="Split by" value={by} onChange={(event) => setBy(event.target.value)}>
              <option value="">No split</option>
              {SPLITS.map((split) => <option key={split.value} value={split.value}>{split.label}</option>)}
            </select>
          </label>
        </div>
        {funnel && <FunnelTable funnel={funnel} onOpen={setOpen} />}
        {funnel && <p className="pd-funnel-summary">From a trial's start to its first payment, on average: {avgDaysText(funnel.avgDaysToPay)}.</p>}
        {funnel && by && funnel.groups && <FunnelGroups by={by} groups={funnel.groups} />}
      </SectionCard>
      {open && <FunnelList key={`${open} ${JSON.stringify(query)}`} bucket={open} query={query} onClose={() => setOpen(null)} />}
      <Leads />
    </div>
  );
}

function FunnelTable({ funnel, onOpen }) {
  return (
    <ul className="pd-funnel" aria-label="Free-trial funnel">
      {funnelRows(funnel).map((row) => (
        <li key={row.key} className={`pd-funnel-row ${row.depth ? "is-nested" : ""}`} data-bucket={row.key}>
          <span className="pd-funnel-label">{row.label}</span>
          <button type="button" className="pd-funnel-count" disabled={!row.value} onClick={() => onOpen(row.key)}
            aria-label={`${row.label}: ${row.value === null ? "not counted" : count(row.value)}. Show the list`}>
            {row.value === null ? "—" : count(row.value)}
          </button>
          {(row.note || row.parts.length > 0) && (
            <span className="pd-funnel-meta">
              {row.note && <span>{row.note}</span>}
              {row.parts.map((part) => (part.value > 0
                ? <button key={part.key} type="button" className="pd-funnel-part" onClick={() => onOpen(part.key)} title={`Show ${BUCKETS[part.key].toLowerCase()}`}>{part.text}</button>
                : <span key={part.key} className="pd-funnel-part">{part.text}</span>))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function FunnelGroups({ by, groups }) {
  const heading = SPLITS.find((split) => split.value === by)?.label || "Group";
  const columns = useMemo(() => [
    { key: "label", header: heading, value: (g) => g.label, mobile: "title", pin: true },
    { key: "trialsStarted", header: "Trials", type: "number", value: (g) => g.trialsStarted, total: "sum" },
    { key: "activated", header: "Made a sale", type: "number", value: (g) => g.activated, total: "sum" },
    { key: "stillOnTrial", header: "Still on trial", type: "number", value: (g) => g.stillOnTrial, total: "sum" },
    { key: "continued", header: "Continued (paid)", type: "number", value: (g) => g.continued, total: "sum", mobile: "show" },
    { key: "stopped", header: "Stopped", type: "number", value: (g) => g.stopped, total: "sum", mobile: "show" },
    { key: "conversion", header: "Conversion", type: "number", value: (g) => (g.conversion === null ? null : Number(g.conversion)),
      render: (g) => conversionText(g.conversion), csv: (g) => g.conversion ?? "" },
  ], [heading]);
  return (
    <>
      <h3 className="pd-subhead">By {heading.toLowerCase()}</h3>
      <DataGrid id="platform-funnel-groups" caption={`Free trials by ${heading.toLowerCase()}`} columns={columns}
        rows={groups.map((group) => ({ ...group, id: group.key ?? "none" }))} exportName={`platform-trials-by-${by}`} rowNoun={["group", "groups"]}
        empty="No trials in these dates" />
    </>
  );
}

function trialColumns() {
  return [
    { key: "name", header: "Business", value: (r) => r.name, mobile: "title", pin: true,
      render: (r) => <span className="pd-two-line"><strong>{r.name}</strong><small>{r.typeName}</small></span> },
    { key: "owner", header: "Owner", value: (r) => r.ownerName || "", mobile: "subtitle",
      render: (r) => <span className="pd-two-line"><span>{r.ownerName || "—"}</span>{r.ownerMobile && <small>{phoneLink(r.ownerMobile)}</small>}</span> },
    { key: "mobile", header: "Owner's mobile", value: (r) => r.ownerMobile || "", defaultHidden: true },
    { key: "email", header: "Owner's email", value: (r) => r.ownerEmail || "", defaultHidden: true },
    { key: "trial", header: "Trial", value: (r) => r.trialStartsOn, csv: (r) => `${r.trialStartsOn} to ${r.trialEndsOn}`,
      render: (r) => <span className="pd-two-line"><span>{dateShort(r.trialStartsOn)} to {dateShort(r.trialEndsOn)}</span><small>{trialLengthWord(r.trialDays)}</small></span> },
    { key: "outcome", header: "How it went", type: "status", value: (r) => outcomeWord(r.outcome), mobile: "show",
      render: (r) => <StatusBadge status={r.outcome} label={outcomeWord(r.outcome)} tone={OUTCOME_TONES[r.outcome]} /> },
    { key: "today", header: "Today", type: "status", value: (r) => stateWord(r.state),
      render: (r) => <StatusBadge status={r.state} label={stateWord(r.state)} tone={STATE_TONES[r.state] || "neutral"} /> },
    { key: "firstSale", header: "First sale", type: "date", value: (r) => r.firstSaleOn },
    { key: "paidOn", header: "First paid", type: "date", value: (r) => r.paidOn },
    { key: "daysToPay", header: "Days to pay", type: "number", value: (r) => r.daysToPay },
    { key: "source", header: "Came from", value: (r) => `${sourceWord(r.source)}${r.ref ? ` (${r.ref})` : ""}` },
    { key: "region", header: "State", value: (r) => r.stateName || "" },
    { key: "plan", header: "Plan chosen", value: (r) => r.planName || "", defaultHidden: true },
  ];
}

function enquiryColumns() {
  return [
    { key: "name", header: "Name", value: (r) => r.name, mobile: "title", pin: true,
      render: (r) => <span className="pd-two-line"><strong>{r.name}</strong>{r.businessName && <small>{r.businessName}</small>}</span> },
    { key: "mobile", header: "Mobile", value: (r) => r.mobile || "", render: (r) => phoneLink(r.mobile) || "—", mobile: "subtitle" },
    { key: "email", header: "Email", value: (r) => r.email || "" },
    { key: "type", header: "Type", value: (r) => r.typeName || "" },
    { key: "city", header: "City", value: (r) => [r.city, r.stateName].filter(Boolean).join(", ") },
    { key: "date", header: "Came in", type: "datetime", value: (r) => r.createdAt },
    { key: "status", header: "Follow-up", type: "status", value: (r) => leadStatusWord(r.status) },
    { key: "business", header: "Signed up", value: (r) => (r.business ? r.business.name : ""), mobile: "show",
      render: (r) => (r.business ? <span className="pd-two-line"><span>{r.business.name}</span><small>{stateWord(r.business.state)}</small></span> : <span className="muted">Not yet</span>) },
  ];
}

// The businesses (or enquiries) behind one number of the funnel. Shown afresh
// for each number and each change of the filters (its key).
function FunnelList({ bucket, query, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const card = useRef(null);
  const enquiries = ENQUIRY_BUCKETS.includes(bucket);
  const columns = useMemo(() => (enquiries ? enquiryColumns() : trialColumns()), [enquiries]);

  useEffect(() => {
    let current = true;
    getTrialFunnel({ ...query, list: bucket })
      .then((result) => { if (current) { setItems(result.items); setError(""); } })
      .catch((err) => current && setError(getErrorMessage(err)));
    return () => { current = false; };
  }, [bucket, query]);
  useEffect(() => { card.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }); }, [bucket]);

  return (
    <div ref={card}>
      <SectionCard flush icon="list" title={BUCKETS[bucket]}
        description={enquiries ? "The people who asked to be called back, with whether they signed up." : "Each business with its owner to call, its trial dates and how it went."}
        actions={<button type="button" className="button button-ghost button-sm" onClick={onClose}><Icon name="x" size={14} /> Close</button>}>
        <DataGrid id={enquiries ? "platform-funnel-enquiries" : "platform-funnel-trials"} caption={BUCKETS[bucket]} columns={columns}
          rows={(items || []).map((item) => ({ ...item, id: enquiries ? item.id : item.businessId }))} loading={!items && !error} error={error}
          exportName={`platform-${bucket.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`} rowNoun={enquiries ? ["enquiry", "enquiries"] : ["business", "businesses"]}
          empty="Nobody in this number" emptyIcon="users" />
      </SectionCard>
    </div>
  );
}

// Every lead, newest first, with its follow-up and notes.
function Leads() {
  const [filters, setFilters] = useState({ status: "", source: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notesFor, setNotesFor] = useState(null);

  const load = useCallback(() => {
    listLeads(asParams(filters))
      .then((result) => { setData(result); setError(""); })
      .catch((err) => setError(getErrorMessage(err)));
  }, [filters]);
  useEffect(() => { load(); }, [load]);

  const replace = (lead) => setData((before) => ({ ...before, items: before.items.map((item) => (item.id === lead.id ? lead : item)) }));
  const changeStatus = useCallback(async (lead, status) => {
    try {
      replace(await setLeadStatus(lead.id, status));
      setError("");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);
  const noteAdded = (leadId, note) => setData((before) => ({
    ...before, items: before.items.map((item) => (item.id === leadId ? { ...item, notes: [note, ...item.notes] } : item)),
  }));

  const columns = useMemo(() => [
    { key: "date", header: "Came in", type: "datetime", value: (l) => l.createdAt },
    { key: "name", header: "Name", value: (l) => l.name, mobile: "title", pin: true,
      render: (l) => <span className="pd-two-line"><strong>{l.name}</strong>{l.businessName && <small>{l.businessName}</small>}</span> },
    { key: "mobile", header: "Mobile", value: (l) => l.mobile || "", render: (l) => phoneLink(l.mobile) || "—", mobile: "subtitle" },
    { key: "email", header: "Email", value: (l) => l.email || "" },
    { key: "type", header: "Type", value: (l) => l.typeName || "", filter: "select" },
    { key: "city", header: "City", value: (l) => [l.city, l.stateName].filter(Boolean).join(", ") },
    { key: "source", header: "Source", value: (l) => `${l.source === "enquiry" ? "Call-back request" : "Sign-up"}${l.ref ? ` · ${l.ref}` : ""}`, filter: "select" },
    { key: "message", header: "Message", value: (l) => l.message || "", defaultHidden: true },
    { key: "status", header: "Follow-up", type: "status", value: (l) => leadStatusWord(l.status), mobile: "show", csv: (l) => leadStatusWord(l.status),
      render: (l) => (
        <select aria-label={`Follow-up for ${l.name}`} value={l.status} onChange={(event) => changeStatus(l, event.target.value)}>
          {LEAD_STATUSES.map((status) => <option key={status} value={status}>{leadStatusWord(status)}</option>)}
        </select>
      ) },
    { key: "outcome", header: "How it went", type: "status", value: (l) => (l.business ? `${l.business.name}: ${stateWord(l.outcome)}` : outcomeWord(l.outcome)),
      render: (l) => (l.business
        ? <span className="pd-two-line"><span>{l.business.name}</span><small>{stateWord(l.outcome)}</small></span>
        : <span className="muted">{outcomeWord(l.outcome)}</span>) },
    { key: "notes", header: "Notes", value: (l) => l.notes.length, csv: (l) => l.notes.map((note) => note.note).join(" | "),
      render: (l) => (
        <button type="button" className="chip-button" onClick={() => setNotesFor(l.id)} aria-label={`Notes for ${l.name}`}>
          <Icon name="message" size={14} /> {l.notes.length ? `${count(l.notes.length)} ${l.notes.length === 1 ? "note" : "notes"}` : "Add a note"}
        </button>
      ) },
  ], [changeStatus]);

  const lead = notesFor && data ? data.items.find((item) => item.id === notesFor) : null;
  return (
    <SectionCard flush icon="phone" title="Leads"
      description={`Call-back requests and sign-ups, newest first${data && data.total > data.items.length ? ` (the latest ${count(data.items.length)} of ${count(data.total)})` : ""}. Set the follow-up as you call, and keep notes.`}>
      <ErrorMessage message={error} />
      <DataGrid id="platform-leads" caption="Leads" columns={columns} rows={data?.items || []} loading={!data && !error}
        exportName="platform-leads" rowNoun={["lead", "leads"]} search="Name, mobile, email or city"
        toolbar={(
          <span className="pd-filters">
            <select aria-label="Follow-up" value={filters.status} onChange={(event) => setFilters((before) => ({ ...before, status: event.target.value }))}>
              <option value="">Any follow-up</option>
              {LEAD_STATUSES.map((status) => <option key={status} value={status}>{leadStatusWord(status)}</option>)}
            </select>
            <select aria-label="Source" value={filters.source} onChange={(event) => setFilters((before) => ({ ...before, source: event.target.value }))}>
              <option value="">Requests and sign-ups</option>
              <option value="enquiry">Call-back requests</option>
              <option value="signup">Sign-ups</option>
            </select>
          </span>
        )}
        empty="No leads yet" emptyHint="Requests to be called back and sign-ups from the platform's site appear here." emptyIcon="users" />
      {lead && <NotesDialog lead={lead} onClose={() => setNotesFor(null)} onAdded={noteAdded} />}
    </SectionCard>
  );
}

function NotesDialog({ lead, onClose, onAdded }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      onAdded(lead.id, await addLeadNote(lead.id, text));
      setText("");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Notes: ${lead.name}`} icon="message" width={560} onClose={onClose} dismissible={!saving}
      description="Calls made and what was said. A note is kept as it was written.">
      <dl className="pd-lead-facts">
        <dt>Mobile</dt><dd>{phoneLink(lead.mobile) || "—"}</dd>
        <dt>Email</dt><dd>{lead.email || "—"}</dd>
        {lead.message && <><dt>Their message</dt><dd>{lead.message}</dd></>}
        <dt>Follow-up</dt><dd>{leadStatusWord(lead.status)}</dd>
      </dl>
      {lead.notes.length ? (
        <ul className="pd-notes" aria-label={`Notes on ${lead.name}`}>
          {lead.notes.map((note) => (
            <li key={note.id}>
              <p>{note.note}</p>
              <small className="muted">{note.by || "The platform"} · {dateTime(note.createdAt)}</small>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">No notes yet.</p>}
      <form className="stack" onSubmit={submit}>
        <FormField label="New note" error={error}>
          <textarea rows={3} maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} />
        </FormField>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>Close</button>
          <button type="submit" className="button" disabled={saving || !text.trim()}>{saving ? "Saving…" : "Add note"}</button>
        </div>
      </form>
    </Modal>
  );
}
