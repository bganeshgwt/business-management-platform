import ContentTabs from "../../../../components/ContentTabs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import useConfirm from "../../../../hooks/useConfirm";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { printDebitNote } from "./healthPrint";
import "../styles/health.css";

// Batches: what expires soon, grouped by the distributor who supplied it (to
// send back for credit before it expires), the debit notes sent and the
// distributors' credit notes, and recalls — every sale of the batch with the
// buyer's phone, and the batch blocked so it cannot be sold or moved.
const TABS = [["expiry", "Expiring by distributor"], ["returns", "Debit notes"], ["recalls", "Recalls"]];
const REASONS = [["expired", "Expired"], ["near_expiry", "Near expiry"], ["breakage", "Breakage / damage"], ["recall", "Recalled batch"], ["other", "Other"]];
const daysWord = (d) => (d < 0 ? `Expired ${-d} day${d === -1 ? "" : "s"} ago` : d === 0 ? "Expires today" : `${d} days left`);

export default function PharmacyBatchesPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : "expiry";
  return (
    <div className="stack">
      <BusinessHeader icon="clock" title="Expiry, returns & recalls"
        description="Send short-dated and broken stock back to the distributor on a debit note; recall a batch to find every buyer and stop it being sold." />
      <ContentTabs label="Pharmacy stock views" value={tab} options={TABS.map(([value,label])=>({value,label}))} onChange={key=>setParams(p=>{const next=new URLSearchParams(p);next.set("tab",key);return next;},{replace:true})}>
      {tab === "expiry" && <ExpiryView biz={biz} />}
      {tab === "returns" && <ReturnsView biz={biz} />}
      {tab === "recalls" && <RecallsView biz={biz} />}
      </ContentTabs>
    </div>
  );
}

function ExpiryView({ biz }) {
  const [days, setDays] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [returning, setReturning] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "pharmacy/near-expiry", days ? { days } : undefined, controller.signal)
      .then((d) => { setData(d); setError(""); if (!days) setDays(String(d.days)); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, days, version]);
  const canReturn = biz.can("pharmacy.approve") && biz.can("purchasing.refund");
  const columns = useMemo(() => [
    { key: "label", header: "Medicine", value: (l) => l.label, mobile: "title", render: (l) => <span className="bz-two-line"><strong>{l.label}</strong><small className="muted mono">{l.lot_code}</small></span> },
    { key: "expiry", header: "Expiry", type: "date", value: (l) => l.expires_on, mobile: "subtitle", render: (l) => <span className="bz-inline">{dateShort(l.expires_on, { year: true })} <StatusBadge tone={l.days_left < 0 ? "danger" : l.days_left <= 30 ? "warning" : "info"} label={daysWord(Number(l.days_left))} /></span> },
    { key: "qty", header: "On hand", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit), mobile: "show" },
    { key: "value", header: "At cost", type: "money", exact: true, value: (l) => Number(l.cost_value), total: "sum", mobile: "show" },
    { key: "recalled", header: "", label: "Recall", value: (l) => (l.recalled ? "Recalled" : ""), render: (l) => (l.recalled ? <StatusBadge tone="danger" label="Recalled" /> : null) },
  ], []);
  return (
    <>
      <ErrorMessage message={error} />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="alert" label="Expired, still on the shelf" value={data ? String(data.totals.expired) : ""} loading={!data} />
        <StatTile icon="clock" label={`Batches within ${data?.days || "…"} days`} value={data ? String(data.totals.batches) : ""} loading={!data} />
        <StatTile icon="money" label="Their value at cost" money={data ? Number(data.totals.costValue) : undefined} loading={!data} />
        <StatTile icon="truck" label="Distributors to return to" value={data ? String(data.groups.filter((g) => g.supplier_id).length) : ""} loading={!data} />
      </div>
      <div className="bz-inline">
        <div className="segmented" role="group" aria-label="Expiring within">
          {["30", "60", "90", "180"].map((n) => <button key={n} type="button" className={`segment ${days === n ? "is-active" : ""}`} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>)}
        </div>
      </div>
      {!data && !error && <Loading />}
      {data && !data.groups.length && <SectionCard><p className="muted">Nothing expires within {data.days} days.</p></SectionCard>}
      {data?.groups.map((g) => (
        <SectionCard key={g.supplier_id || "none"} flush icon="truck" title={g.supplier_name}
          description={`${g.lots.length} batch${g.lots.length === 1 ? "" : "es"} · ${biz.exact(g.cost_value)} at cost${g.expired ? ` · ${g.expired} expired` : ""}${g.phone ? ` · ${g.phone}` : ""}`}
          actions={canReturn && g.supplier_id && <button type="button" className="button button-secondary" onClick={() => setReturning(g)}><Icon name="returns" size={15} /> Return on a debit note</button>}>
          <DataGrid id={`pharmacy-expiry-${g.supplier_id || "none"}`} caption={`Expiring stock from ${g.supplier_name}`} variant="compact" rows={g.lots} columns={columns} currency={biz.symbol} rowNoun={["batch", "batches"]}
            rowClassName={(l) => (Number(l.days_left) < 0 ? "dg-tone-danger" : Number(l.days_left) <= 30 ? "dg-tone-warning" : "")} pageSize={25} />
        </SectionCard>
      ))}
      {returning && <DebitNoteDialog group={returning} onClose={() => setReturning(null)} onSaved={(note) => { setReturning(null); setVersion((n) => n + 1); toast.success(`Debit note ${note.note_no} sent: ${biz.exact(note.claimed)} claimed`); }} />}
    </>
  );
}

function DebitNoteDialog({ group, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [reason, setReason] = useState(group.lots.some((l) => Number(l.days_left) < 0) ? "expired" : "near_expiry");
  const [notes, setNotes] = useState("");
  const [picked, setPicked] = useState(() => Object.fromEntries(group.lots.filter((l) => !l.recalled).map((l) => [l.id, String(Number(l.quantity))])));
  const [key] = useState(newKey);
  const lines = Object.entries(picked).filter(([, q]) => Number(q) > 0);
  return (
    <FormDialog title={`Return to ${group.supplier_name}`} icon="truck" width={760} onClose={onClose} onSaved={onSaved} submitLabel={`Send debit note (${lines.length})`}
      description="The stock leaves now as a supplier return on the purchase that brought each batch, so what you owe this distributor goes down. Record their credit note when it comes."
      onSubmit={() => businessWrite(biz.id, "pharmacy/debit-notes", { requestKey: key, contactId: group.supplier_id, reason, notes, lines: lines.map(([lotId, quantityValue]) => ({ lotId: Number(lotId), quantity: quantityValue })) })}>
      <Field label="Reason"><select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Note (optional)"><input maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="field-wide">
        <DataGrid id="pharmacy-debit-note-lines" caption="Batches to return" variant="editor" rows={group.lots} pageSize={false} columns={[
          { key: "label", header: "Batch", value: (l) => l.label, render: (l) => <span className="bz-two-line"><strong>{l.label}</strong><small className="muted">{l.lot_code} · exp {dateShort(l.expires_on, { year: true })}</small></span> },
          { key: "have", header: "On hand", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit) },
          { key: "qty", header: "Return", type: "number", value: (l) => Number(picked[l.id] || 0), render: (l, ctx) => (
            <input aria-label={ctx.label} className="hl-qty" type="number" min="0" max={Number(l.quantity)} step="1" value={picked[l.id] ?? ""} disabled={l.recalled && reason !== "recall"}
              onChange={(e) => setPicked((p) => ({ ...p, [l.id]: e.target.value }))} />) },
        ]} />
      </div>
    </FormDialog>
  );
}

function ReturnsView({ biz }) {
  const list = useServerList("pharmacy/debit-notes", { gridId: "pharmacy-debit-notes", period: true });
  const [open, setOpen] = useState(null);
  const columns = useMemo(() => [
    { key: "no", header: "Debit note", value: (n) => n.note_no, className: "mono", mobile: "title" },
    { key: "date", header: "Sent", type: "date", value: (n) => n.created_at, mobile: "subtitle" },
    { key: "supplier", header: "Distributor", value: (n) => n.supplier_name },
    { key: "reason", header: "Reason", value: (n) => REASONS.find(([v]) => v === n.reason)?.[1] || n.reason },
    { key: "lines", header: "Batches", type: "number", value: (n) => n.line_count },
    { key: "claimed", header: "Claimed", type: "money", exact: true, value: (n) => Number(n.claimed), total: "sum", mobile: "show" },
    { key: "credited", header: "Credited", type: "money", exact: true, value: (n) => (n.credited_amount == null ? null : Number(n.credited_amount)), total: "sum" },
    { key: "status", header: "Status", value: (n) => n.status, mobile: "show", render: (n) => (n.status === "credited"
      ? <StatusBadge tone={n.short_credited ? "warning" : "success"} label={n.short_credited ? "Credited short" : `Credited · ${n.credit_note_no}`} /> : <StatusBadge tone="warning" label="Awaiting credit note" />) },
  ], []);
  return (
    <SectionCard flush icon="list" title="Debit notes">
      <DataGrid {...list.gridProps} caption="Debit notes to distributors" columns={columns} currency={biz.symbol} toolbar={<PeriodFilter list={list} />} rowNoun={["debit note", "debit notes"]}
        onRowClick={(n) => setOpen(n.id)} exportName={biz.can("pharmacy.export") ? `${biz.business.code}-debit-notes` : undefined}
        empty="No debit notes in this period" emptyHint="Return expiring stock from the first tab." emptyIcon="truck" />
      <DebitNotePanel id={open} onClose={() => setOpen(null)} onChanged={list.reload} />
    </SectionCard>
  );
}

function DebitNotePanel({ id, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const [note, setNote] = useState(null);
  const [error, setError] = useState("");
  const [crediting, setCrediting] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `pharmacy/debit-notes/${id}`, undefined, controller.signal).then(setNote).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, id, version]);
  const print = async () => printDebitNote(note, (await businessRead(biz.id, "health/settings")).seller, biz.symbol);
  return (
    <SidePanel open={Boolean(id)} title={note ? `Debit note ${note.note_no}` : "Debit note"} icon="truck" onClose={onClose}
      footer={note && <span className="bz-inline">
        <button type="button" className="button button-secondary" onClick={print}><Icon name="print" size={15} /> Print</button>
        {note.status === "sent" && biz.can("pharmacy.approve") && <button type="button" className="button" onClick={() => setCrediting(true)}>Record credit note</button>}
      </span>}>
      <ErrorMessage message={error} />
      {!note || String(note.id) !== String(id) ? !error && <Loading /> : (
        <div className="stack">
          <dl className="hl-facts">
            <dt>Distributor</dt><dd>{note.supplier_name}{note.supplier_phone ? ` · ${note.supplier_phone}` : ""}</dd>
            <dt>Sent</dt><dd>{dateTime(note.created_at)} by {note.created_by_name}</dd>
            <dt>Claimed</dt><dd>{biz.exact(note.claimed)}{Number(note.written_off) ? ` · ${biz.exact(note.written_off)} written off (no purchase on record)` : ""}</dd>
            <dt>Credit note</dt><dd>{note.status === "credited" ? `${note.credit_note_no} of ${dateShort(note.credit_note_date, { year: true })}: ${biz.exact(note.credited_amount)}` : "Awaited"}</dd>
          </dl>
          <DataGrid id="pharmacy-debit-note-detail" caption="Batches returned" variant="compact" rows={note.lines} currency={biz.symbol} columns={[
            { key: "label", header: "Medicine", value: (l) => l.label, mobile: "title" },
            { key: "batch", header: "Batch", value: (l) => l.lot_code, className: "mono" },
            { key: "exp", header: "Expiry", type: "date", value: (l) => l.expires_on },
            { key: "qty", header: "Quantity", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit) },
            { key: "value", header: "Value", type: "money", exact: true, value: (l) => Number(l.value), total: "sum" },
            { key: "ret", header: "Return", value: (l) => l.return_no || (l.adjustment_id ? "Written off" : "") },
          ]} />
        </div>
      )}
      {crediting && note && <CreditDialog note={note} onClose={() => setCrediting(false)} onSaved={() => { setCrediting(false); setVersion((n) => n + 1); onChanged(); }} />}
    </SidePanel>
  );
}

function CreditDialog({ note, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ creditNoteNo: "", creditNoteDate: today, amount: String(Number(note.claimed)) });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <FormDialog title={`Credit note for ${note.note_no}`} icon="receipt" width={520} onClose={onClose} onSaved={onSaved} successMessage="Credit note recorded"
      description={`${biz.exact(note.claimed)} was claimed. A smaller credit is recorded as it is; settle the difference with the distributor.`}
      onSubmit={() => businessWrite(biz.id, `pharmacy/debit-notes/${note.id}/credit`, form)}>
      <Field label="Distributor's credit note no."><input required maxLength={60} value={form.creditNoteNo} onChange={set("creditNoteNo")} /></Field>
      <Field label="Its date"><input required type="date" max={today} value={form.creditNoteDate} onChange={set("creditNoteDate")} /></Field>
      <Field label="Amount credited"><input required type="number" min="0" max={Number(note.claimed)} step="0.01" value={form.amount} onChange={set("amount")} /></Field>
    </FormDialog>
  );
}

function RecallsView({ biz }) {
  const list = useServerList("pharmacy/recalls", { gridId: "pharmacy-recalls" });
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const columns = useMemo(() => [
    { key: "label", header: "Medicine", value: (r) => r.label, mobile: "title", render: (r) => <span className="bz-two-line"><strong>{r.label}</strong><small className="muted mono">Batch {r.lot_code}</small></span> },
    { key: "reason", header: "Reason", value: (r) => r.reason, render: (r) => <span className="bz-two-line"><span>{r.reason}</span><small className="muted">{r.reference || ""}</small></span> },
    { key: "date", header: "Opened", type: "date", value: (r) => r.created_at, mobile: "subtitle" },
    { key: "sales", header: "Bills", type: "number", value: (r) => r.sales, mobile: "show" },
    { key: "stock", header: "On hand", type: "number", value: (r) => Number(r.on_hand) },
    { key: "status", header: "Status", value: (r) => r.status, mobile: "show", render: (r) => (r.status === "closed" ? <StatusBadge tone="neutral" label="Closed" /> : r.blocked ? <StatusBadge tone="danger" label="Open · blocked" /> : <StatusBadge tone="warning" label="Open" />) },
  ], []);
  return (
    <SectionCard flush icon="alert" title="Recalls" actions={biz.can("pharmacy.approve") && <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Recall a batch</button>}>
      <DataGrid {...list.gridProps} caption="Batch recalls" columns={columns} rowNoun={["recall", "recalls"]} onRowClick={(r) => setOpen(r.id)}
        empty="No recalls" emptyHint="When a drug alert names a batch you stocked, recall it here." emptyIcon="alert" />
      <RecallPanel id={open} onClose={() => setOpen(null)} onChanged={list.reload} />
      {adding && <RecallDialog onClose={() => setAdding(false)} onSaved={(r) => { setAdding(false); list.reload(); setOpen(r.id); toast.success(`Batch ${r.lot_code} recalled: ${r.sales.length} bill(s) to follow up`); }} />}
    </SectionCard>
  );
}

function RecallDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [drug, setDrug] = useState(null);
  const [lots, setLots] = useState([]);
  const [form, setForm] = useState({ lotCode: "", reason: "", reference: "", block: true });
  const pick = useCallback(async (d) => {
    setDrug(d);
    if (!d) return setLots([]);
    const stock = await businessRead(biz.id, "stock", { sku: d.id, limit: 100 });
    setLots(stock.items);
  }, [biz.id]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  return (
    <FormDialog title="Recall a batch" icon="alert" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Recall"
      description="Every bill with this batch is listed with the buyer's phone. While blocked, the batch cannot be sold or moved; it can still go back to the distributor."
      onSubmit={() => businessWrite(biz.id, "pharmacy/recalls", { skuId: drug?.id, ...form })}>
      <div className="field-wide">
        <SearchPicker label="Medicine" required value={drug} onChange={pick} minChars={2}
          search={(q, { signal }) => businessRead(biz.id, "pharmacy/drugs", { q, limit: 20 }, signal).then((r) => r.items)} getKey={(d) => d.id} getLabel={(d) => d.label} />
      </div>
      <Field label="Batch number" hint={lots.length ? "Batches received here are listed; type another if it was sold out long ago." : undefined}>
        <input required list="recall-lots" maxLength={100} value={form.lotCode} onChange={set("lotCode")} />
      </Field>
      <datalist id="recall-lots">{lots.map((l) => <option key={l.id} value={l.lot_code}>{`${Number(l.quantity)} left · exp ${l.expires_on ? dateShort(l.expires_on, { year: true }) : "—"}`}</option>)}</datalist>
      <Field label="Alert reference"><input maxLength={120} value={form.reference} onChange={set("reference")} placeholder="e.g. CDSCO NSQ alert, Sep 2026" /></Field>
      <Field label="Reason" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} /></Field>
      <label className="hl-check field-wide"><input type="checkbox" checked={form.block} onChange={set("block")} /> Block the batch now (no sale or transfer)</label>
    </FormDialog>
  );
}

function RecallPanel({ id, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  const [row, setRow] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `pharmacy/recalls/${id}`, undefined, controller.signal).then(setRow).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, id, version]);
  const [asking, setAsking] = useState(null);
  const act = async (action, note) => {
    if (action === "block" && !(await confirm({ title: "Block this batch?", message: "It cannot be sold or moved until unblocked.", confirmLabel: "Block" }))) return;
    await businessWrite(biz.id, `pharmacy/recalls/${id}`, { action, note });
    toast.success(action === "close" ? "Recall closed" : action === "block" ? "Batch blocked" : "Batch unblocked");
    setVersion((n) => n + 1); onChanged();
  };
  const canAct = biz.can("pharmacy.approve") && row?.status === "open";
  return (
    <SidePanel open={Boolean(id)} title={row ? `Recall · ${row.label} · ${row.lot_code}` : "Recall"} count={row?.sales.length} icon="alert" onClose={onClose}
      rule="Every bill that took this batch, with who to call."
      footer={canAct && <span className="bz-inline">
        {row.blocked ? <button type="button" className="button button-secondary" onClick={() => setAsking("unblock")}>Unblock</button>
          : <button type="button" className="button button-secondary" onClick={() => act("block").catch((err) => toast.error(getErrorMessage(err)))}>Block</button>}
        <button type="button" className="button" onClick={() => setAsking("close")}>Close the recall</button></span>}>
      <ErrorMessage message={error} />
      {!row || String(row.id) !== String(id) ? !error && <Loading /> : (
        <div className="stack">
          <p>{row.reason}{row.reference ? ` · ${row.reference}` : ""} · {row.status === "closed" ? `closed ${dateShort(row.closed_at)}: ${row.close_note}` : row.blocked ? "batch blocked" : "batch not blocked"}</p>
          <p className="muted">Stock of this batch: {row.stock.length ? row.stock.map((s) => `${Number(s.quantity)} at ${s.location_name}`).join(", ") : "none"}</p>
          <DataGrid id="pharmacy-recall-sales" caption="Bills with this batch" variant="compact" rows={row.sales} rowKey={(s) => s.document_id} columns={[
            { key: "date", header: "Sold", type: "datetime", value: (s) => s.created_at, mobile: "subtitle" },
            { key: "bill", header: "Bill", value: (s) => s.document_no, className: "mono" },
            { key: "who", header: "Customer / patient", value: (s) => s.customer_name || "Walk-in", mobile: "title" },
            { key: "phone", header: "Phone", value: (s) => s.phone || "", render: (s) => (s.phone ? <a href={`tel:${s.phone}`}>{s.phone}</a> : <span className="muted">Not known</span>), mobile: "show" },
            { key: "qty", header: "Quantity", type: "number", value: (s) => Number(s.quantity), render: (s) => `${quantity(s.quantity, s.unit)}${Number(s.returned) ? ` (${Number(s.returned)} back)` : ""}` },
            { key: "doctor", header: "Prescriber", value: (s) => s.doctor_name || "" },
          ]} exportName={`recall-${row.lot_code}`} empty="No sales of this batch" />
        </div>
      )}
      {asking && <ReasonDialog title={asking === "close" ? "Close the recall" : "Unblock the batch"} icon="alert" submitLabel={asking === "close" ? "Close recall" : "Unblock"}
        label={asking === "close" ? "How it was closed" : "Why it may be sold again"} placeholder={asking === "close" ? "Returned to the distributor; buyers informed" : ""}
        onSubmit={(note) => act(asking, note)} onClose={() => setAsking(null)} onSaved={() => setAsking(null)} />}
    </SidePanel>
  );
}
