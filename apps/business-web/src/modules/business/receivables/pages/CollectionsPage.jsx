import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { word } from "../../../../services/businessNav";
import { toast } from "../../../../services/toast";
import { Badge, BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { ChequeActionDialog, CollectionDialog } from "./receivablesParts";
import { CHEQUE_STATUS, METHODS, chequeWord, printReceipt, receiptMethod } from "./receivablesFormat";

// The salesperson's evening settlement lives with the wholesale screens.
const SettlementPanel = lazy(() => import("../../wholesale/pages/SettlementPanel"));

// Money received from customers: one numbered receipt each, with the bills it
// settled, what went against an old opening balance and what is a true
// advance (pro pass D-01). Cheques have their own tab (in hand, deposited,
// cleared, bounced — D-02); a wholesaler settles each salesperson's day here
// (D-03). Receipts are never edited.
export default function CollectionsPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const wholesale = biz.has("sales_orders") && biz.can("sales_orders.view");
  const tabs = [{ value: "receipts", label: "Receipts" }, { value: "cheques", label: "Cheques" }, ...(wholesale ? [{ value: "settle", label: "Salesperson settlement" }] : [])];
  const [tab, setTab] = useState(() => (tabs.some((x) => x.value === params.get("tab")) ? params.get("tab") : "receipts"));
  const [creating, setCreating] = useState(() => params.get("new") === "1" && biz.can("receivables.create"));
  const [openId, setOpenId] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (params.get("new") || params.get("tab")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
  }, [params, setParams]);
  const title = word(biz.type, "collections", "Collections");
  const saved = (c) => {
    setCreating(false);
    toast.success(`Receipt ${c.collection_no} saved for ${biz.exact(c.amount)}${Number(c.unallocated) ? `; ${biz.exact(c.unallocated)} kept as advance` : ""}`);
    setVersion((n) => n + 1); setOpenId(c.id);
  };
  return (
    <div className="stack">
      <BusinessHeader icon="wallet" title={title}
        description="Every receipt of money from customers, with the bills it settled. Cheques are tracked until they clear; a bounced cheque opens the bills again."
        primary={biz.can("receivables.create") && <button type="button" className="button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> Record collection</button>} />
      <Segmented label="Show" value={tab} options={tabs} onChange={setTab} />
      {tab === "receipts" && <Receipts key={version} wholesale={wholesale} onOpen={setOpenId} />}
      {tab === "cheques" && <Cheques key={version} onChanged={() => setVersion((n) => n + 1)} />}
      {tab === "settle" && <Suspense fallback={<Loading />}><SettlementPanel key={version} onChanged={() => setVersion((n) => n + 1)} onOpenReceipt={setOpenId} /></Suspense>}
      {creating && <CollectionDialog onClose={() => setCreating(false)} onSaved={saved} />}
      {openId && <ReceiptDetail collectionId={openId} onClose={() => setOpenId(null)} onChanged={() => setVersion((n) => n + 1)} />}
    </div>
  );
}

function Receipts({ wholesale, onOpen }) {
  const biz = useOpenBusiness();
  const [method, setMethod] = useState("");
  const [salesperson, setSalesperson] = useState("");
  const [route, setRoute] = useState("");
  const { options } = useOptions(wholesale ? ["salespeople", "routes"] : []);
  const params = { ...(method ? { method } : {}), ...(salesperson ? { salesperson } : {}), ...(route ? { route } : {}) };
  const list = useServerList("collections", { gridId: "receivables-collections", period: true, params });
  const today = businessToday(biz.business.timezone);
  const columns = useMemo(() => [
    { key: "collection_no", header: "Receipt", value: (k) => k.collection_no, mobile: "title", pin: true,
      render: (k) => <button type="button" className="link-button mono" onClick={() => onOpen(k.id)}>{k.collection_no}</button> },
    { key: "created_at", header: "Received", type: "datetime", value: (k) => k.created_at, mobile: "subtitle", render: (k) => dateTime(k.created_at) },
    { key: "contact_name", header: "Customer", value: (k) => k.contact_name, mobile: "show" },
    { key: "method", header: "Paid by", value: (k) => receiptMethod(k), render: (k) => (
      <span className="bz-two-line">{receiptMethod(k)}{k.cheque_status && <small><Badge tone={CHEQUE_STATUS[k.cheque_status]?.tone} label={chequeWord({ status: k.cheque_status, cheque_date: k.cheque_date }, today)} /></small>}</span>
    ) },
    { key: "reference", header: "Reference", value: (k) => k.reference || "", defaultHidden: true },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (k) => Number(k.amount), total: "sum", mobile: "show",
      render: (k) => (k.cheque_status === "bounced" ? <s className="muted">{biz.exact(k.amount)}</s> : biz.exact(k.amount)) },
    { key: "allocated", header: "Against bills", type: "money", exact: true, value: (k) => Number(k.allocated), total: "sum" },
    { key: "opening", header: "Opening bal.", type: "money", exact: true, value: (k) => Number(k.opening_applied), total: "sum",
      render: (k) => (Number(k.opening_applied) ? biz.exact(k.opening_applied) : <span className="muted">—</span>) },
    { key: "unallocated", header: "Advance", type: "money", exact: true, value: (k) => Number(k.unallocated), total: "sum",
      render: (k) => (Number(k.unallocated) ? <Badge tone="info" label={biz.exact(k.unallocated)} /> : <span className="muted">—</span>) },
    wholesale && { key: "salesperson", header: "Collected by", value: (k) => k.salesperson_name || "Office", mobile: "show" },
    wholesale && { key: "route", header: "Route", value: (k) => k.route_name || "", defaultHidden: true },
    wholesale && { key: "settled", header: "Settled", type: "status", value: (k) => (k.settled ? "Settled" : k.salesperson_id ? "Not yet" : ""), defaultHidden: true,
      render: (k) => (k.settled ? <Badge tone="success" label="Settled" /> : k.salesperson_id ? <Badge tone="warning" label="Not yet" /> : <span className="muted">—</span>) },
    { key: "by", header: "Recorded by", value: (k) => k.created_by_name, defaultHidden: true },
    { key: "location", header: "At", value: (k) => k.location_name, defaultHidden: biz.locations.length < 2 },
  ].filter(Boolean), [biz, onOpen, today, wholesale]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Receipts in this period">
        <DataGrid {...list.gridProps} caption="Receipts" columns={columns} currency={biz.symbol} rowNoun={["receipt", "receipts"]}
          rowClassName={(k) => (k.cheque_status === "bounced" ? "dg-tone-danger" : "")}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field">
                <span>Paid by</span>
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="">Any</option>
                  {METHODS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </label>
              {wholesale && (
                <label className="field">
                  <span>Collected by</span>
                  <select value={salesperson} onChange={(e) => setSalesperson(e.target.value)}>
                    <option value="">Anyone</option>
                    {(options?.salespeople || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              )}
              {wholesale && (
                <label className="field">
                  <span>Route</span>
                  <select value={route} onChange={(e) => setRoute(e.target.value)}>
                    <option value="">All routes</option>
                    {(options?.routes || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
          exportName={biz.can("receivables.export") ? `${biz.business.code}-collections` : undefined}
          empty="No collections in these dates" emptyHint="Pick other dates above, or record one." emptyIcon="wallet" />
      </SectionCard>
    </>
  );
}

const CHEQUE_TABS = [
  { value: "due", label: "To deposit" },
  { value: "post_dated", label: "Post-dated" },
  { value: "deposited", label: "Deposited" },
  { value: "bounced", label: "Bounced" },
  { value: "cleared", label: "Cleared" },
  { value: "", label: "All" },
];
const chequeParams = (show) => (show === "due" ? { due: "true" } : show === "post_dated" ? { post_dated: "true" } : show ? { status: show } : {});

function Cheques({ onChanged }) {
  const biz = useOpenBusiness();
  const [show, setShow] = useState("due");
  const list = useServerList("cheques", { gridId: "receivables-cheques", params: chequeParams(show) });
  const [acting, setActing] = useState(null);
  const today = businessToday(biz.business.timezone);
  const columns = useMemo(() => [
    { key: "cheque_no", header: "Cheque no.", value: (c) => c.cheque_no, mobile: "title", pin: true, render: (c) => <span className="mono">{c.cheque_no}</span> },
    { key: "contact", header: "Customer", value: (c) => c.contact_name, mobile: "subtitle" },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (c) => Number(c.amount), total: "sum", mobile: "show" },
    { key: "date", header: "Cheque date", type: "date", value: (c) => c.cheque_date, mobile: "show" },
    { key: "bank", header: "Bank", value: (c) => c.bank || "" },
    { key: "receipt", header: "Receipt", value: (c) => c.collection_no, render: (c) => <span className="mono">{c.collection_no}</span>, defaultHidden: true },
    { key: "salesperson", header: "Collected by", value: (c) => c.salesperson_name || "", defaultHidden: !biz.has("sales_orders") },
    { key: "status", header: "Status", type: "status", value: (c) => c.status, render: (c) => <Badge tone={CHEQUE_STATUS[c.status]?.tone} label={chequeWord(c, today)} />, mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => (
      <div className="row-actions">
        {biz.can("receivables.create") && c.status === "received" && c.cheque_date <= today && <button type="button" className="chip-button" onClick={() => setActing({ cheque: c, action: "deposit" })}>Deposit</button>}
        {biz.can("receivables.create") && ["received", "deposited"].includes(c.status) && c.cheque_date <= today && <button type="button" className="chip-button" onClick={() => setActing({ cheque: c, action: "clear" })}>Cleared</button>}
        {biz.can("receivables.approve") && ["received", "deposited"].includes(c.status) && <button type="button" className="chip-button danger" onClick={() => setActing({ cheque: c, action: "bounce" })}>Bounced</button>}
      </div>
    ) },
  ], [biz, today]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="wallet" title="Cheques" description="A cheque counts when received. Deposit it on its date; if it bounces, mark it here: the bills it paid open again.">
        <DataGrid {...list.gridProps} caption="Cheques" columns={columns} currency={biz.symbol} rowNoun={["cheque", "cheques"]}
          rowClassName={(c) => (c.status === "bounced" ? "dg-tone-danger" : c.due ? "dg-tone-warning" : "")}
          toolbar={<Segmented label="Show" value={show} options={CHEQUE_TABS} onChange={setShow} />}
          exportName={biz.can("receivables.export") ? `${biz.business.code}-cheques` : undefined}
          empty={show === "due" ? "No cheques waiting to be deposited" : "No cheques here"} emptyIcon="check" />
      </SectionCard>
      {acting && <ChequeActionDialog cheque={acting.cheque} action={acting.action} onClose={() => setActing(null)} onSaved={() => { setActing(null); list.reload(); onChanged(); }} />}
    </>
  );
}

function ReceiptDetail({ collectionId, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(null);
  const [version, setVersion] = useState(0);
  const today = businessToday(biz.business.timezone);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `collections/${collectionId}`, undefined, controller.signal)
      .then((r) => { setReceipt(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, collectionId, version]);
  const cheque = receipt?.cheque;
  return (
    <>
      <Modal title={receipt ? `Receipt ${receipt.collection_no}` : "Loading…"} icon="wallet" width={760} onClose={() => { if (!acting) onClose(); }}
        description={receipt ? `${receipt.contact_name} · ${receiptMethod(receipt)}${receipt.reference ? ` ${receipt.reference}` : ""} · ${dateTime(receipt.created_at)} by ${receipt.created_by_name}` : undefined}>
        <ErrorMessage message={error} />
        {!receipt && !error && <Loading />}
        {receipt && (
          <div className="stack">
            <div className="bz-totals">
              <span>Received <strong>{biz.exact(receipt.amount)}</strong></span>
              <span>Against bills <strong>{biz.exact(receipt.allocated)}</strong></span>
              {Number(receipt.opening_applied) > 0 && <span>Against opening balance <strong>{biz.exact(receipt.opening_applied)}</strong></span>}
              <span>Kept as advance <strong>{biz.exact(receipt.unallocated)}</strong></span>
            </div>
            {cheque && (
              <div className={`bz-note-card ${cheque.status === "bounced" ? "is-danger" : ""}`}>
                <Badge tone={CHEQUE_STATUS[cheque.status]?.tone} label={chequeWord({ ...cheque, cheque_date: cheque.cheque_date }, today)} />
                <span>Cheque {cheque.cheque_no} dated {dateShort(cheque.cheque_date, { year: true })}{cheque.bank ? ` · ${cheque.bank}` : ""}</span>
                {cheque.deposited_at && <span className="muted small">Deposited {dateShort(cheque.deposited_at)}{cheque.deposited_into ? ` into ${cheque.deposited_into}` : ""} by {cheque.deposited_by_name}</span>}
                {cheque.cleared_at && <span className="muted small">Cleared {dateShort(cheque.cleared_at)} ({cheque.cleared_by_name})</span>}
                {cheque.bounced_at && <span className="bz-due small">Bounced {dateShort(cheque.bounced_at)}: {cheque.bounce_reason}{Number(cheque.bounce_charge) > 0 ? ` · charge ${biz.exact(cheque.bounce_charge)} added` : ""}. {cheque.reversed_allocations?.length ? `Bills opened again: ${cheque.reversed_allocations.map((a) => a.documentNo).join(", ")}.` : ""}</span>}
              </div>
            )}
            {receipt.salesperson_name && <p className="muted small"><Icon name="user" size={13} /> Collected by {receipt.salesperson_name}{receipt.route_name ? ` · ${receipt.route_name}` : ""}{receipt.settlement_id ? " · settled" : ""}</p>}
            <DataGrid variant="compact" id="receivables-receipt-bills" caption="Bills settled" rows={receipt.allocations} currency={biz.symbol} rowNoun={["bill", "bills"]}
              empty={cheque?.status === "bounced" ? "The bounce took these back" : "Not put against any bill yet"} columns={[
                { key: "document_no", header: "Bill", value: (a) => a.document_no, mobile: "title", render: (a) => <span className="mono">{a.document_no}</span> },
                { key: "bill_at", header: "Bill date", type: "date", value: (a) => a.bill_at },
                { key: "total", header: "Bill total", type: "money", exact: true, value: (a) => Number(a.total) },
                { key: "amount", header: "Settled", type: "money", exact: true, value: (a) => Number(a.amount), total: "sum", mobile: "show" },
              ]} />
            {receipt.notes && <p className="muted">{receipt.notes}</p>}
            <div className="form-actions bz-start">
              {biz.can("receivables.print") && <button type="button" className="button button-secondary" onClick={() => printReceipt(receipt, biz)}><Icon name="print" size={15} /> Print receipt</button>}
              {cheque && biz.can("receivables.create") && cheque.status === "received" && cheque.cheque_date <= today && <button type="button" className="button button-secondary" onClick={() => setActing("deposit")}>Deposit</button>}
              {cheque && biz.can("receivables.create") && ["received", "deposited"].includes(cheque.status) && cheque.cheque_date <= today && <button type="button" className="button button-secondary" onClick={() => setActing("clear")}>Cleared</button>}
              {cheque && biz.can("receivables.approve") && ["received", "deposited"].includes(cheque.status) && <button type="button" className="button button-danger" onClick={() => setActing("bounce")}>Bounced</button>}
            </div>
          </div>
        )}
      </Modal>
      {acting && receipt && <ChequeActionDialog cheque={{ ...cheque, collection_id: receipt.id, collection_no: receipt.collection_no, contact_name: receipt.contact_name, amount: receipt.amount }}
        action={acting} onClose={() => setActing(null)} onSaved={() => { setActing(null); setVersion((n) => n + 1); onChanged(); }} />}
    </>
  );
}
