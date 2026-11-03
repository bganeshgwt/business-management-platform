import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import ContentTabs from "../../../../components/ContentTabs";
import LiveIndicator from "../../../../components/LiveIndicator";
import { ErrorMessage } from "../../../../components/Feedback";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, relative } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { FLAG_WORDS, flagDetail } from "./tillWords";
import "../styles/till.css";

// Daily money › Offline bills: the manager's review of what tills billed with
// no network. Each bill was handed to a customer and is posted as it was
// made; what the till could not know is flagged here by kind, to look at and
// acknowledge (the billed price stands); stock sold short is settled from
// stock received since, or as a count that was wrong; numbers of a till's
// series that never arrived are noted with why (GSTR-1 Table 13 counts every
// number); voids, every offline bill by till and time, and the cashiers' cash
// with the offline bills that arrived after their shift closed.

const TABS = [
  { value: "review", label: "To review" },
  { value: "stock", label: "Stock short" },
  { value: "numbers", label: "Numbers" },
  { value: "bills", label: "All offline bills" },
  { value: "cash", label: "Cash" },
];

export default function OfflineBillsPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "review";
  const setTab = (value) => setParams((p) => { const next = new URLSearchParams(p); next.set("tab", value); return next; }, { replace: true });
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [openDoc, setOpenDoc] = useState(null);
  const canReview = biz.can("offline_till.review");

  const load = useCallback(() => businessRead(biz.id, "till/review")
    .then((answer) => { setSummary(answer); setError(""); setVersion((n) => n + 1); })
    .catch((err) => setError(getErrorMessage(err))), [biz.id]);
  useEffect(() => {
    let live = true;
    businessRead(biz.id, "till/review").then((answer) => live && setSummary(answer)).catch((err) => live && setError(getErrorMessage(err)));
    return () => { live = false; };
  }, [biz.id]);
  const live = useLiveRefresh({ business: biz.id }, ["till", "sale"], load);

  return (
    <div className="stack">
      <BusinessHeader icon="receipt" title="Offline bills"
        description="Bills the tills made with no internet, sent when it came back. Each was given to a customer and stands as made; what changed meanwhile is flagged here, to look at." />
      <ErrorMessage message={error} />
      <div className="till-tiles">
        <StatTile icon="alert" tone={summary?.to_review ? "warning" : "neutral"} label="Bills to review" value={String(summary?.to_review ?? "")} loading={!summary} onClick={() => setTab("review")} />
        <StatTile icon="box" tone={summary?.shortfalls ? "danger" : "neutral"} label="Stock sold short" value={String(summary?.shortfalls ?? "")} loading={!summary} onClick={() => setTab("stock")} />
        <StatTile icon="file" tone={summary?.missing ? "danger" : "neutral"} label="Numbers not arrived" value={String(summary?.missing ?? "")} loading={!summary} onClick={() => setTab("numbers")} />
        <StatTile icon="receipt" label="Offline bills today" value={String(summary?.bills ?? "")} note={summary ? `${biz.exact(summary.sales)} · ${summary.voids} voided` : ""} loading={!summary} onClick={() => setTab("bills")} />
      </div>
      <ContentTabs label="Offline bills" value={tab} onChange={setTab} options={TABS}>
        {tab === "review" && <ReviewTab biz={biz} canReview={canReview} version={version} live={live} onChanged={load} onOpen={setOpenDoc} />}
        {tab === "stock" && <StockTab biz={biz} canReview={canReview} version={version} onChanged={load} onOpen={setOpenDoc} />}
        {tab === "numbers" && <NumbersTab biz={biz} canReview={canReview} version={version} onChanged={load} />}
        {tab === "bills" && <BillsTab version={version} onOpen={setOpenDoc} />}
        {tab === "cash" && <CashTab summary={summary} />}
      </ContentTabs>
      {openDoc && <DocumentDetail documentId={openDoc} onClose={() => setOpenDoc(null)} onChanged={load} />}
    </div>
  );
}

function ReviewTab({ biz, canReview, version, live, onChanged, onOpen }) {
  const [kind, setKind] = useState("");
  const [showDone, setShowDone] = useState(false);
  const list = useServerList("till/review/flags", { gridId: "till-flags", params: { ...(kind ? { kind } : {}), ...(showDone ? {} : { open: "true" }) } });
  const [acknowledging, setAcknowledging] = useState(null);
  const { reload } = list;
  useEffect(() => { if (version) reload(); }, [version, reload]);
  const columns = useMemo(() => [
    { key: "kind", header: "What", value: (f) => FLAG_WORDS[f.kind]?.title || f.kind, pin: true, mobile: "title", minWidth: 220,
      render: (f) => <span className="till-flag-details"><StatusBadge tone={f.open ? FLAG_WORDS[f.kind]?.tone : "neutral"} label={FLAG_WORDS[f.kind]?.title || f.kind} /><small className="muted">{flagDetail(f, biz)}</small></span> },
    { key: "bill_no", header: "Bill", value: (f) => f.bill_no, mobile: "subtitle",
      render: (f) => (f.document_id ? <button type="button" className="link-button mono" onClick={() => onOpen(f.document_id)}>{f.bill_no}</button> : <span className="mono">{f.bill_no}</span>) },
    { key: "made_at", header: "Made", type: "date", value: (f) => f.made_at, render: (f) => `${dateShort(f.made_at)} ${new Date(f.made_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}` },
    { key: "made_by_name", header: "By", value: (f) => f.made_by_name },
    { key: "till_code", header: "Till", value: (f) => f.till_code },
    { key: "contact_name", header: "Customer", value: (f) => f.contact_name || "Walk-in" },
    { key: "total", header: "Total", type: "money", exact: true, value: (f) => Number(f.total) },
    { key: "state", header: "Looked at", value: (f) => (f.open ? "" : f.acknowledged_by_name),
      render: (f) => (f.open ? <span className="muted">Not yet</span> : <span className="bz-two-line"><span>{f.acknowledged_by_name}, {relative(f.acknowledged_at)}</span>{f.note && <small className="muted">{f.note}</small>}</span>) },
    canReview && { key: "actions", header: "", label: "Actions", type: "actions", render: (f) => (!f.open ? null : f.kind === "stock"
      ? <span className="muted small">Settle under Stock short</span>
      : <button type="button" className="chip-button" onClick={() => setAcknowledging(f)}>Looked at…</button>) },
  ].filter(Boolean), [biz, canReview, onOpen]);
  return (
    <SectionCard flush icon="alert" title="What changed while the tills were offline" actions={<LiveIndicator status={live} />}
      description="The billed price and rate stand: each was on the customer's receipt. Look at each, put right what needs it (a price label, a limit, an e-invoice), and mark it looked at.">
      <div className="bz-toolbar">
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Every kind</option>
          {Object.entries(FLAG_WORDS).map(([value, words]) => <option key={value} value={value}>{words.title}</option>)}
        </select>
        <label className="checkbox"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show those looked at</label>
      </div>
      <DataGrid {...list.gridProps} caption="Flags on offline bills" columns={columns} rowNoun={["flag", "flags"]}
        empty={showDone ? "Nothing flagged yet" : "Nothing to review"} emptyIcon="check" emptyHint="Offline bills with nothing flagged need no look." />
      {acknowledging && (
        <AcknowledgeDialog biz={biz} flag={acknowledging} onClose={() => setAcknowledging(null)} onDone={() => { setAcknowledging(null); reload(); onChanged(); }} />
      )}
    </SectionCard>
  );
}

function AcknowledgeDialog({ biz, flag, onClose, onDone }) {
  const [note, setNote] = useState("");
  return (
    <FormDialog title={`${FLAG_WORDS[flag.kind]?.title || "Flag"} · ${flag.bill_no}`} icon="check" width={520} submitLabel="Mark looked at" onClose={onClose}
      description={flagDetail(flag, biz)} onSubmit={() => businessWrite(biz.id, `till/flags/${flag.id}/acknowledge`, { note: note.trim() || null })} onSaved={onDone} successMessage="Marked looked at">
      <Field label="Note (optional)" hint="What was done: the shelf label corrected, the credit note given…"><input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
    </FormDialog>
  );
}

function StockTab({ biz, canReview, version, onChanged, onOpen }) {
  const [showDone, setShowDone] = useState(false);
  const list = useServerList("till/review/shortfalls", { gridId: "till-shortfalls", params: showDone ? {} : { open: "true" } });
  const [settling, setSettling] = useState(null);
  const [busy, setBusy] = useState(null);
  const { reload } = list;
  useEffect(() => { if (version) reload(); }, [version, reload]);
  const take = useCallback(async (row) => {
    setBusy(row.id);
    try {
      await businessWrite(biz.id, `till/shortfalls/${row.id}/resolve`, { how: "received" });
      toast.success(`${Number(row.quantity)} ${row.unit} of ${row.label} taken from stock for ${row.bill_no}`);
      reload(); onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [biz.id, reload, onChanged]);
  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, pin: true, mobile: "title", minWidth: 200 },
    { key: "quantity", header: "Sold short", type: "number", value: (r) => Number(r.quantity), render: (r) => `${Number(r.quantity)} ${r.unit}`, mobile: "subtitle" },
    { key: "stock_now", header: "Usable stock now", type: "number", value: (r) => Number(r.stock_now), render: (r) => `${Number(r.stock_now)} ${r.unit}` },
    { key: "bill_no", header: "Bill", value: (r) => r.bill_no, render: (r) => <button type="button" className="link-button mono" onClick={() => onOpen(r.document_id)}>{r.bill_no}</button> },
    { key: "made_at", header: "Made", type: "date", value: (r) => r.made_at },
    { key: "location_name", header: "Location", value: (r) => r.location_name, defaultHidden: true },
    { key: "resolution", header: "Settled", value: (r) => r.resolution || "",
      render: (r) => (r.open ? <span className="muted">Not yet</span> : <span className="bz-two-line"><span>{r.resolution === "received" ? "Taken from stock received" : "The count was wrong"} · {r.resolved_by_name}</span>{r.note && <small className="muted">{r.note}</small>}</span>) },
    canReview && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (!r.open ? null : (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" disabled={busy === r.id || Number(r.stock_now) < Number(r.quantity)} title={Number(r.stock_now) < Number(r.quantity) ? "Receive the stock first (Purchases)" : ""} onClick={() => take(r)}>Take from stock</button>
        <button type="button" className="chip-button" onClick={() => setSettling(r)}>The count was wrong…</button>
      </span>
    )) },
  ].filter(Boolean), [canReview, busy, onOpen, take]);
  return (
    <SectionCard flush icon="box" title="Stock sold short"
      description="An offline bill sold more than the books held here: the bill took what there was, so no stock went below zero. Once the stock that was sold is entered (a purchase not yet entered), take it from there; if it was on the shelf all along, the count was wrong: say why, and nothing is taken.">
      <div className="bz-toolbar"><label className="checkbox"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show those settled</label></div>
      <DataGrid {...list.gridProps} caption="Stock sold short" columns={columns} rowNoun={["item", "items"]} empty="Nothing sold short" emptyIcon="check" />
      {settling && (
        <SettleDialog biz={biz} row={settling} onClose={() => setSettling(null)} onDone={() => { setSettling(null); reload(); onChanged(); }} />
      )}
    </SectionCard>
  );
}

function SettleDialog({ biz, row, onClose, onDone }) {
  const [note, setNote] = useState("");
  return (
    <FormDialog title={`${row.label}: the count was wrong`} icon="box" width={520} submitLabel="Settle it" onClose={onClose}
      description={`${Number(row.quantity)} ${row.unit} sold on ${row.bill_no} that the books did not hold. Nothing is taken from stock.`}
      onSubmit={() => businessWrite(biz.id, `till/shortfalls/${row.id}/resolve`, { how: "adjusted", note: note.trim() })} onSaved={onDone} successMessage="Settled">
      <Field label="Why the count was wrong"><input required maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Two cartons were in the back store" autoFocus /></Field>
    </FormDialog>
  );
}

function NumbersTab({ biz, canReview, version, onChanged }) {
  const [state, setState] = useState("missing");
  const list = useServerList("till/review/gaps", { gridId: "till-gaps", params: state ? { state } : {} });
  const [noting, setNoting] = useState(null);
  const today = businessToday(biz.business.timezone);
  const [period, setPeriod] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [table, setTable] = useState(null);
  const { reload } = list;
  useEffect(() => { if (version) reload(); }, [version, reload]);
  useEffect(() => {
    let live = true;
    businessRead(biz.id, "till/numbers", period).then((answer) => live && setTable(answer)).catch(() => live && setTable({ series: [] }));
    return () => { live = false; };
  }, [biz.id, period, version]);
  const columns = useMemo(() => [
    { key: "bill_no", header: "Number", value: (g) => g.bill_no, pin: true, mobile: "title", className: "mono" },
    { key: "till_code", header: "Till", value: (g) => `${g.till_code} · ${g.till_name}`, render: (g) => <span>{g.till_code} · {g.till_name}{g.till_lost ? <small className="muted"> · lost</small> : null}</span> },
    { key: "state", header: "Now", value: (g) => g.state, mobile: "subtitle",
      render: (g) => (g.state === "arrived" ? <StatusBadge tone="success" label="Arrived since" /> : g.state === "noted" ? <StatusBadge tone="neutral" label="Noted" />
        : g.on_till ? <StatusBadge tone="info" label="Still on the till" /> : <StatusBadge tone="danger" label="Not arrived" />) },
    { key: "found_at", header: "Found", type: "date", value: (g) => g.found_at },
    { key: "reason", header: "Why", value: (g) => g.reason || "", render: (g) => (g.reason ? <span className="bz-two-line"><span>{g.reason}</span><small className="muted">{g.noted_by_name}</small></span> : <span className="muted">—</span>) },
    canReview && { key: "actions", header: "", label: "Actions", type: "actions", render: (g) => (g.state === "missing" ? <button type="button" className="chip-button" onClick={() => setNoting(g)}>Note why…</button> : null) },
  ].filter(Boolean), [canReview]);
  return (
    <>
      <SectionCard flush icon="file" title="Numbers that have not arrived"
        description="A later number of the till's series arrived, or the till was retired as lost after using them. A number still on the till goes when it is sent; one that never will (the till's data cleared, the computer lost) is noted with why: GSTR-1 counts every number issued.">
        <div className="bz-toolbar">
          <select aria-label="Show" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="missing">Not arrived</option><option value="noted">Noted</option><option value="arrived">Arrived since</option><option value="">Every number</option>
          </select>
        </div>
        <DataGrid {...list.gridProps} caption="Numbers not arrived" columns={columns} rowNoun={["number", "numbers"]} empty="Every number has arrived" emptyIcon="check" />
      </SectionCard>
      <SectionCard flush icon="file" title="Documents issued (GSTR-1 Table 13)" description="Each till's series in the period: its first and last number, how many, how many voided (cancelled) and how many have not arrived.">
        <div className="bz-toolbar">
          <Field label="From"><input type="date" value={period.from} max={period.to} onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, from: e.target.value }))} /></Field>
          <Field label="To"><input type="date" value={period.to} min={period.from} onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, to: e.target.value }))} /></Field>
        </div>
        <DataGrid id="till-table-13" caption="Documents issued by the tills" rows={table?.series || []} loading={!table} rowKey={(r) => r.prefix}
          columns={[
            { key: "prefix", header: "Series", value: (r) => r.prefix, pin: true, className: "mono", render: (r) => <span className="bz-two-line"><span className="mono">{r.prefix}</span><small className="muted">{r.tillCode} · {r.tillName}</small></span> },
            { key: "first", header: "From", value: (r) => r.first, className: "mono" },
            { key: "last", header: "To", value: (r) => r.last, className: "mono" },
            { key: "total", header: "Total numbers", type: "number", value: (r) => r.total },
            { key: "voided", header: "Cancelled (voided)", type: "number", value: (r) => r.voided },
            { key: "missing", header: "Not arrived", type: "number", value: (r) => r.missing },
            { key: "issued", header: "Net issued", type: "number", value: (r) => r.issued },
          ]}
          rowNoun={["series", "series"]} empty="No offline bills in this period" emptyIcon="file" />
      </SectionCard>
      {noting && <NoteDialog biz={biz} gap={noting} onClose={() => setNoting(null)} onDone={() => { setNoting(null); reload(); onChanged(); }} />}
    </>
  );
}

function NoteDialog({ biz, gap, onClose, onDone }) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Why ${gap.bill_no} never arrived`} icon="file" width={520} submitLabel="Note it" onClose={onClose}
      description="Noted for the accountant: the number counts as issued in GSTR-1. If the bill turns up later, it still arrives."
      onSubmit={() => businessWrite(biz.id, `till/gaps/${gap.id}/note`, { reason: reason.trim() })} onSaved={onDone} successMessage="Noted">
      <Field label="Why"><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The till's browser data was cleared before it was sent" autoFocus /></Field>
    </FormDialog>
  );
}

function BillsTab({ version, onOpen }) {
  const [kind, setKind] = useState("");
  const list = useServerList("till/review/bills", { gridId: "till-bills", period: true, params: kind ? { kind } : {} });
  const { reload } = list;
  useEffect(() => { if (version) reload(); }, [version, reload]);
  const columns = useMemo(() => [
    { key: "bill_no", header: "Number", value: (b) => b.bill_no, pin: true, mobile: "title",
      render: (b) => (b.document_id ? <button type="button" className="link-button mono" onClick={() => onOpen(b.document_id)}>{b.bill_no}</button> : <span className="mono">{b.bill_no}</span>) },
    { key: "kind", header: "Kind", value: (b) => (b.kind === "void" ? "Voided" : "Bill"), mobile: "subtitle",
      render: (b) => (b.kind === "void" ? <span className="bz-two-line"><StatusBadge tone="neutral" label="Voided" /><small className="muted">{b.void_reason}</small></span> : "Bill") },
    { key: "made_at", header: "Made", type: "date", value: (b) => b.made_at, render: (b) => `${dateShort(b.made_at)} ${new Date(b.made_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}` },
    { key: "received_at", header: "Arrived", type: "date", value: (b) => b.received_at, render: (b) => relative(b.received_at) },
    { key: "made_by_name", header: "Made by", value: (b) => b.made_by_name },
    { key: "sent_by_name", header: "Sent by", value: (b) => (b.sent_by_other ? b.sent_by_name : ""), render: (b) => (b.sent_by_other ? b.sent_by_name : <span className="muted">The same</span>), defaultHidden: true },
    { key: "till_code", header: "Till", value: (b) => b.till_code },
    { key: "contact_name", header: "Customer", value: (b) => b.contact_name || "Walk-in" },
    { key: "total", header: "Total", type: "money", exact: true, value: (b) => Number(b.total), total: "sum" },
    { key: "flags", header: "Flagged", value: (b) => (b.flags || []).map((k) => FLAG_WORDS[k]?.title || k).join(", "),
      render: (b) => ((b.flags || []).length ? <span className="bz-two-line"><span>{b.flags.map((k) => FLAG_WORDS[k]?.title || k).join(" · ")}</span>{b.open_flags ? <small className="muted">{b.open_flags} to look at</small> : <small className="muted">Looked at</small>}</span> : <span className="muted">Nothing</span>) },
  ], [onOpen]);
  return (
    <SectionCard flush icon="receipt" title="Every offline bill" description="By the time each was made, on its till; a voided one keeps its number.">
      <div className="bz-toolbar">
        <PeriodFilter list={list} />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Bills and voids</option><option value="bill">Bills</option><option value="void">Voids</option></select>
      </div>
      <DataGrid {...list.gridProps} caption="Offline bills" columns={columns} rowNoun={["bill", "bills"]} empty="No offline bills in this period" emptyIcon="receipt" />
    </SectionCard>
  );
}

function CashTab({ summary }) {
  const rows = summary?.cash || [];
  return (
    <SectionCard flush icon="wallet" title="Cash with offline bills"
      description="Each cashier's shift today with cash on offline bills in it. Cash from bills that arrived after the shift was closed was in the drawer but not in its figures: the drawer should have held the expected cash plus it.">
      <DataGrid id="till-cash" caption="Shifts with offline cash" rows={rows} loading={!summary} rowKey={(r) => r.id}
        columns={[
          { key: "cashier_name", header: "Cashier", value: (r) => r.cashier_name, pin: true, mobile: "title" },
          { key: "opened_at", header: "Shift", type: "date", value: (r) => r.opened_at, mobile: "subtitle",
            render: (r) => `${new Date(r.opened_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} – ${r.closed_at ? new Date(r.closed_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "open"}` },
          { key: "offline_cash", header: "Offline cash", type: "money", exact: true, value: (r) => Number(r.offline_cash) },
          { key: "arrived_after_close", header: "Arrived after the close", type: "money", exact: true, value: (r) => Number(r.arrived_after_close) },
          { key: "expected_cash", header: "Expected at the close", type: "money", exact: true, value: (r) => (r.expected_cash === null ? null : Number(r.expected_cash)) },
          { key: "expected_now", header: "Expected now", type: "money", exact: true, value: (r) => (r.expected_now === null ? null : Number(r.expected_now)) },
          { key: "counted_cash", header: "Counted", type: "money", exact: true, value: (r) => (r.counted_cash === null ? null : Number(r.counted_cash)) },
          { key: "difference_now", header: "Difference now", type: "money", exact: true, value: (r) => (r.difference_now === null ? null : Number(r.difference_now)) },
        ]}
        rowNoun={["shift", "shifts"]} empty="No shift today has cash from offline bills" emptyIcon="wallet" />
    </SectionCard>
  );
}

