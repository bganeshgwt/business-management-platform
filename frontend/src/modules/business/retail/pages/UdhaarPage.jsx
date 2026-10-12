import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../../components/ActionMenu";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { escapeHtml, printDocument } from "../../../../services/print";
import { businessPath, word } from "../../../../services/businessNav";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { businessToday, dateTime, newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { dateWords, methodWord, udhaarMessage, whatsappLink } from "./retail";
import "../styles/business-retail.css";

// Udhaar: what regular customers owe the shop on credit. The figures are the
// shared receivables (the same collections, balances and statements the
// wholesale screens use); this screen adds the reminder book — who was
// reminded, how, and the date they promised to pay.

const TABS = [["book", "Who owes"], ["remind", "Remind today"], ["log", "Reminders sent"]];
const SHOW = [["owing", "Owing"], ["overdue", "Overdue"], ["advance", "Paid ahead"], ["all", "All customers"]];
const CHANNELS = { whatsapp: "WhatsApp", sms: "SMS", call: "Phone call", visit: "Visited", other: "Other" };
const STATEMENT_WORDS = { opening: "Opening balance", sale: "Bill", return: "Goods returned", payment: "Paid at the counter", collection: "Udhaar paid", refund: "Refund given" };
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export default function UdhaarPage() {
  const biz = useOpenBusiness();
  const [tab, setTab] = useState("book");
  const [summary, setSummary] = useState(null);
  const [version, setVersion] = useState(0);
  const [action, setAction] = useState(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "udhaar", { limit: 1, show: "owing" }, controller.signal)
      .then(setSummary).catch(() => {});
    return () => controller.abort();
  }, [biz.id, version]);
  const changed = (message) => { setAction(null); setNotice(message); setVersion((n) => n + 1); };
  const open = (kind, row) => setAction({ kind, row });

  return (
    <div className="stack">
      <BusinessHeader icon="wallet" title="Udhaar"
        description="Customers who buy on credit: what each owes, since when, and what they promised. Money collected settles the oldest bills first."
        actions={<Link className="button button-secondary" to={businessPath(biz.id, "collections")}><Icon name="wallet" size={16} /> {word(biz.type, "collections", "Collections")}</Link>} />
      <div className="stat-grid">
        <StatTile icon="wallet" tone="primary" label="Udhaar to collect" value={summary ? biz.amount(summary.totals.outstanding) : "—"} note={summary ? `${summary.total} ${summary.total === 1 ? "customer" : "customers"}` : ""} />
        <StatTile icon="alert" tone="danger" label="Overdue" value={summary ? biz.amount(summary.totals.overdue) : "—"} note="past their credit days" />
        <StatTile icon="clock" tone="warning" label="Over 90 days old" value={summary ? biz.amount(summary.totals.days_over_90) : "—"} note="hardest to recover" />
        <StatTile icon="calendar" label="0–30 days old" value={summary ? biz.amount(summary.totals.days_0_30) : "—"} note="recent udhaar" />
      </div>
      <SuccessMessage message={notice} />
      <div className="segmented" role="tablist" aria-label="Udhaar views">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`segment ${tab === key ? "is-active" : ""}`} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "book" && <Book key={`b${version}`} onAction={open} />}
      {tab === "remind" && <RemindToday key={`r${version}`} onAction={open} />}
      {tab === "log" && <ReminderLog key={`l${version}`} />}
      {action?.kind === "collect" && <CollectDialog row={action.row} onClose={() => setAction(null)} onSaved={changed} />}
      {action?.kind === "remind" && <RemindDialog row={action.row} onClose={() => setAction(null)} onSaved={changed} />}
      {action?.kind === "statement" && <StatementDialog row={action.row} onClose={() => setAction(null)} />}
    </div>
  );
}

function rowActions(biz, row, onAction) {
  const owes = Number(row.balance) > 0.004;
  return (
    <div className="row-actions">
      {biz.can("receivables.create") && owes && <button type="button" className="chip-button" onClick={() => onAction("collect", row)}>Collect</button>}
      {/* Pro pass C-18: Remind is an everyday action, so it is a button too. */}
      {biz.can("receivables.create") && owes && <button type="button" className="chip-button" onClick={() => onAction("remind", row)}>Remind</button>}
      <ActionMenu label={`More for ${row.name}`} items={[
        { label: "Statement", icon: "file", onClick: () => onAction("statement", row) },
      ]} />
    </div>
  );
}
// "42 days" since a date, for how long a bill has waited.
function daysAgo(day) {
  const days = Math.max(0, Math.round((Date.now() - new Date(`${String(day).slice(0, 10)}T00:00:00`).getTime()) / 86400000));
  return days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}
const customerCell = (row) => <span className="bz-two-line"><strong>{row.name}</strong><small className="muted">{row.phone || "No phone"}</small></span>;
function promiseCell(row) {
  if (!row.reminded_at) return <span className="muted">Not yet</span>;
  return (
    <span className="bz-two-line">
      <span>{CHANNELS[row.reminded_by] || row.reminded_by} · {dateWords(row.reminded_at)}</span>
      {row.promised_on && <small className={row.promise_broken ? "rt-promise-broken" : "muted"}>{row.promise_broken ? "Promise broken: " : "Promised "}{dateWords(row.promised_on)}</small>}
    </span>
  );
}

function Book({ onAction }) {
  const biz = useOpenBusiness();
  const [show, setShow] = useState("owing");
  const list = useServerList("udhaar", { gridId: "retail-udhaar-book", params: { show } });
  const columns = useMemo(() => [
    { key: "name", header: "Customer", value: (r) => r.name, render: customerCell, mobile: "title", pin: true },
    { key: "balance", header: "Owes", type: "money", exact: true, value: (r) => Number(r.balance), total: "sum", mobile: "show" },
    { key: "overdue", header: "Overdue", type: "money", exact: true, value: (r) => Number(r.overdue), total: "sum", mobile: "show" },
    { key: "oldest_bill", header: "Oldest unpaid bill", type: "date", value: (r) => r.oldest_bill, mobile: "subtitle",
      render: (r) => (r.oldest_bill ? <span>{dateWords(r.oldest_bill)}<small className="muted"> · {daysAgo(r.oldest_bill)}</small></span> : <span className="muted">—</span>) },
    { key: "open_bills", header: "Unpaid bills", type: "number", value: (r) => r.open_bills },
    { key: "credit_limit", header: "Credit limit", type: "money", value: (r) => (r.credit_limit === null ? null : Number(r.credit_limit)),
      render: (r) => (r.credit_limit === null ? <span className="muted">No limit</span> : `${biz.amount(r.credit_limit)} · ${Math.round((Number(r.balance) / Math.max(1, Number(r.credit_limit))) * 100)}% used`) },
    { key: "last_collection_at", header: "Last paid", type: "date", value: (r) => r.last_collection_at, defaultHidden: true },
    { key: "reminded_at", header: "Last reminder", minWidth: 180, value: (r) => r.reminded_at || "", render: promiseCell, mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => rowActions(biz, r, onAction) },
  ], [biz, onAction]);
  return (
    <SectionCard flush icon="list" title="Udhaar book">
      <ErrorMessage message={list.error} />
      <DataGrid {...list.gridProps} caption="Customers and their udhaar" rowKey={(r) => r.contact_id} columns={columns} currency={biz.symbol}
        server={{ ...list.gridProps.server, totals: list.data?.totals ? { balance: Number(list.data.totals.balance), overdue: Number(list.data.totals.overdue) } : undefined }}
        toolbar={(
          <div className="segmented" role="group" aria-label="Which customers">
            {SHOW.map(([key, label]) => <button key={key} type="button" className={`segment ${show === key ? "is-active" : ""}`} aria-pressed={show === key} onClick={() => setShow(key)}>{label}</button>)}
          </div>
        )}
        rowNoun={["customer", "customers"]} exportName={biz.can("receivables.export") ? `${biz.business.code}-udhaar` : undefined}
        rowClassName={(r) => (r.promise_broken ? "dg-tone-danger" : Number(r.overdue) > 0.004 ? "dg-tone-warning" : Number(r.balance) < -0.004 ? "dg-tone-success" : "")}
        empty={show === "owing" ? "Nobody owes you anything" : "No customers here"} emptyHint="Bills put on udhaar at the counter appear here." emptyIcon="wallet" />
    </SectionCard>
  );
}

function RemindToday({ onAction }) {
  const biz = useOpenBusiness();
  const list = useServerList("udhaar/reminders", { gridId: "retail-udhaar-remind" });
  const columns = useMemo(() => [
    { key: "name", header: "Customer", value: (r) => r.name, render: customerCell, mobile: "title", pin: true },
    { key: "overdue", header: "Overdue", type: "money", exact: true, value: (r) => Number(r.overdue), total: "sum", mobile: "show" },
    { key: "balance", header: "Owes in all", type: "money", exact: true, value: (r) => Number(r.balance), total: "sum" },
    { key: "oldest_bill", header: "Oldest unpaid", type: "date", value: (r) => r.oldest_bill, mobile: "subtitle" },
    { key: "reminders", header: "Reminders", type: "number", value: (r) => r.reminders },
    { key: "reminded_at", header: "Last reminder", minWidth: 180, value: (r) => r.reminded_at || "", render: promiseCell, mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <div className="row-actions">
        {biz.can("receivables.create") && <button type="button" className="chip-button" onClick={() => onAction("remind", r)}>Remind</button>}
        {biz.can("receivables.create") && <button type="button" className="chip-button" onClick={() => onAction("collect", r)}>Collect</button>}
      </div>
    ) },
  ], [biz, onAction]);
  return (
    <SectionCard flush icon="bell" title="Overdue udhaar to follow up" description="Most overdue first. Broken promises are marked in red.">
      <ErrorMessage message={list.error} />
      <DataGrid {...list.gridProps} caption="Customers to remind" rowKey={(r) => r.contact_id} columns={columns} currency={biz.symbol}
        rowNoun={["customer", "customers"]} rowClassName={(r) => (r.promise_broken ? "dg-tone-danger" : r.promise_pending ? "dg-tone-muted" : "")}
        exportName={biz.can("receivables.export") ? `${biz.business.code}-udhaar-to-remind` : undefined}
        empty="Nobody is overdue" emptyHint="Customers past their credit days appear here." emptyIcon="check" />
    </SectionCard>
  );
}

function ReminderLog() {
  const biz = useOpenBusiness();
  const list = useServerList("udhaar/reminder-log", { gridId: "retail-udhaar-log", period: true });
  const columns = [
    { key: "created_at", header: "When", type: "datetime", value: (r) => r.created_at, mobile: "subtitle" },
    { key: "contact_name", header: "Customer", value: (r) => r.contact_name, mobile: "title", pin: true },
    { key: "channel", header: "How", value: (r) => CHANNELS[r.channel] || r.channel, mobile: "show" },
    { key: "balance", header: "Owed then", type: "money", exact: true, value: (r) => Number(r.balance), mobile: "show" },
    { key: "promised_on", header: "Promised to pay by", type: "date", value: (r) => r.promised_on },
    { key: "note", header: "Note", value: (r) => r.note || "" },
    { key: "created_by_name", header: "By", value: (r) => r.created_by_name, defaultHidden: true },
  ];
  return (
    <SectionCard flush icon="history" title="Reminders sent">
      <ErrorMessage message={list.error} />
      <DataGrid {...list.gridProps} caption="Reminders sent" columns={columns} currency={biz.symbol} toolbar={<PeriodFilter list={list} />}
        rowNoun={["reminder", "reminders"]} exportName={biz.can("receivables.export") ? `${biz.business.code}-udhaar-reminders` : undefined}
        empty="No reminders in these dates" emptyIcon="message" />
    </SectionCard>
  );
}

function CollectDialog({ row, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: Number(row.balance).toFixed(2), method: "cash", reference: "", notes: "", locationId: String(locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, `udhaar/${row.contact_id}/collections`, {
    locationId: form.locationId, amount: form.amount, method: form.method, reference: form.reference || undefined, notes: form.notes || undefined, requestKey,
  });
  return (
    <FormDialog title={`Collect udhaar from ${row.name}`} icon="wallet" width={560} submitLabel="Save collection" onClose={onClose} onSubmit={submit}
      description={`Owes ${biz.exact(row.balance)}. The money settles the oldest bills first; anything more is kept as an advance for the next bill.`}
      onSaved={(c) => onSaved(`${c.collection_no}: ${biz.exact(c.amount)} from ${row.name}${Number(c.unallocated) > 0 ? `, ${biz.exact(c.unallocated)} kept as advance` : ""}.`)}>
      <Field label="Amount received"><input required type="number" min="0.01" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by">
        <select value={form.method} onChange={set("method")}>{["cash", "upi", "card", "bank", "cheque"].map((m) => <option key={m} value={m}>{methodWord(m)}</option>)}</select>
      </Field>
      {locations.length > 1 && (
        <Field label="Received at">
          <select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </Field>
      )}
      <Field label={form.method === "cheque" ? "Cheque number" : "Reference (optional)"}><input required={form.method === "cheque"} maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function RemindDialog({ row, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ channel: row.phone ? "whatsapp" : "call", promisedOn: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const message = udhaarMessage({ name: row.name, shop: biz.settings.display_name || biz.business.name, balance: biz.exact(row.balance), promisedOn: form.promisedOn });
  const submit = () => {
    // Opened straight from the click, before waiting on the server, so the
    // browser does not treat it as a pop-up.
    if (form.channel === "whatsapp") window.open(whatsappLink(row.phone, message), "_blank", "noopener");
    return businessWrite(biz.id, `udhaar/${row.contact_id}/reminders`, { channel: form.channel, promisedOn: form.promisedOn || undefined, note: form.note || undefined });
  };
  return (
    <FormDialog title={`Remind ${row.name}`} icon="message" width={600} onClose={onClose} onSubmit={submit}
      submitLabel={form.channel === "whatsapp" ? "Open WhatsApp and save" : "Save reminder"}
      description={`Owes ${biz.exact(row.balance)}${Number(row.overdue) > 0 ? `, ${biz.exact(row.overdue)} of it overdue` : ""}.`}
      onSaved={() => onSaved(`Reminder to ${row.name} saved.`)}>
      <Field label="How">
        <select value={form.channel} onChange={set("channel")}>
          {Object.entries(CHANNELS).filter(([k]) => row.phone || !["whatsapp", "sms"].includes(k)).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </Field>
      <Field label="Promised to pay by (optional)"><input type="date" min={today} max={addDays(today, 365)} value={form.promisedOn} onChange={set("promisedOn")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} placeholder="e.g. Will pay after salary on the 7th" onChange={set("note")} /></Field>
      {form.channel === "whatsapp" && (
        <div className="field-wide">
          <span className="small muted">Message</span>
          <p className="rt-rule-line small" style={{ whiteSpace: "pre-line" }}>{message}</p>
        </div>
      )}
    </FormDialog>
  );
}

function StatementDialog({ row, onClose }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: addDays(today, -89), to: today });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `udhaar/${row.contact_id}/statement`, range, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, row.contact_id, range]);
  const rows = (data?.entries || []).map((e, i) => ({ ...e, id: i }));
  const print = () => printDocument({
    title: `Statement ${row.name}`,
    styles: "body{font:12px system-ui;color:#111} h1{font-size:17px;margin:0} table{width:100%;border-collapse:collapse;margin-top:10px} td,th{border-bottom:1px solid #ddd;padding:5px;text-align:left} .r{text-align:right} .tot{margin-top:8px;text-align:right;font-weight:700}",
    body: `<h1>${escapeHtml(biz.settings.display_name || biz.business.name)}</h1><p>Udhaar statement for <strong>${escapeHtml(row.name)}</strong>${row.phone ? ` · ${escapeHtml(row.phone)}` : ""}<br>${escapeHtml(dateWords(data.from, true))} to ${escapeHtml(dateWords(data.to, true))}</p>
      <table><thead><tr><th>Date</th><th>What</th><th>Reference</th><th class="r">Took</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead><tbody>
      <tr><td>${escapeHtml(dateWords(data.from, true))}</td><td>Brought forward</td><td></td><td></td><td></td><td class="r">${escapeHtml(biz.exact(data.opening))}</td></tr>
      ${data.entries.map((e) => `<tr><td>${escapeHtml(dateWords(e.day, true))}</td><td>${escapeHtml(STATEMENT_WORDS[e.kind] || e.kind)}</td><td>${escapeHtml(e.reference || "")}</td><td class="r">${Number(e.debit) ? escapeHtml(biz.exact(e.debit)) : ""}</td><td class="r">${Number(e.credit) ? escapeHtml(biz.exact(e.credit)) : ""}</td><td class="r">${escapeHtml(biz.exact(e.balance))}</td></tr>`).join("")}
      </tbody></table><div class="tot">${Number(data.closing) >= 0 ? "Owes" : "Paid ahead"} ${escapeHtml(biz.exact(Math.abs(Number(data.closing))))}</div>`,
  });
  return (
    <Modal title={`Statement · ${row.name}`} icon="file" width={900} onClose={onClose} description="Every bill, return and payment in the dates chosen, with the running udhaar.">
      <div className="stack">
        <div className="rt-statement-head">
          <DateRangeFilter from={range.from} to={range.to} anchor={today} label="statement dates" onChange={(next) => { if (next.from && next.to) setRange(next); }} />
          <div className="row-actions">
            {data && row.phone && <a className="button button-secondary button-sm" target="_blank" rel="noreferrer" href={whatsappLink(row.phone, udhaarMessage({ name: row.name, shop: biz.settings.display_name || biz.business.name, balance: biz.exact(data.closing) }))}><Icon name="message" size={14} /> WhatsApp</a>}
            {data && biz.can("receivables.print") && <button type="button" className="button button-secondary button-sm" onClick={print}><Icon name="print" size={14} /> Print</button>}
          </div>
        </div>
        <ErrorMessage message={error} />
        {!data && !error && <Loading />}
        {data && (
          <>
            <div className="bz-totals">
              <span>Brought forward <strong>{biz.exact(data.opening)}</strong></span>
              <span>Took <strong>{biz.exact(data.debit)}</strong></span>
              <span>Paid <strong>{biz.exact(data.credit)}</strong></span>
              <span className={Number(data.closing) > 0 ? "bz-due" : ""}>{Number(data.closing) >= 0 ? "Owes now" : "Paid ahead"} <strong>{biz.exact(Math.abs(Number(data.closing)))}</strong></span>
            </div>
            <DataGrid id="retail-udhaar-statement" variant="compact" caption="Statement" rows={rows} currency={biz.symbol} rowNoun={["entry", "entries"]} columns={[
              { key: "day", header: "Date", type: "date", value: (e) => e.day, mobile: "subtitle" },
              { key: "kind", header: "What", value: (e) => STATEMENT_WORDS[e.kind] || e.kind, mobile: "title", render: (e) => <Badge tone={e.kind === "sale" || e.kind === "refund" ? "warning" : "active"} label={STATEMENT_WORDS[e.kind] || e.kind} /> },
              { key: "reference", header: "Reference", value: (e) => e.reference || "" },
              { key: "debit", header: "Took", type: "money", exact: true, value: (e) => (Number(e.debit) ? Number(e.debit) : null), total: "sum", mobile: "show" },
              { key: "credit", header: "Paid", type: "money", exact: true, value: (e) => (Number(e.credit) ? Number(e.credit) : null), total: "sum", mobile: "show" },
              { key: "balance", header: "Balance", type: "money", exact: true, value: (e) => Number(e.balance) },
            ]} empty="Nothing in these dates" />
            <p className="muted small">Printed {dateTime(new Date().toISOString())}. Opening balance and earlier entries are carried into “Brought forward”.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
