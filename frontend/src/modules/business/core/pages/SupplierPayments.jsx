import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { escapeHtml, printDocument } from "../../../../services/print";
import { amountInWords, dateShort } from "../../../../services/format";
import { monthStart } from "../../../../services/dates";
import { toast } from "../../../../services/toast";
import FormDialog from "./FormDialog";
import { Badge, Field, FormError } from "./ui";
import { businessDate } from "./invoice";
import { businessToday, newKey, useOpenBusiness, useServerList } from "./hooks";

// What the business owes its suppliers (pro pass C-05): the list with what is
// overdue by each supplier's credit days, paying a supplier against several
// receipts at once (oldest first, or the ones chosen; extra stays as an
// advance), the supplier's account and statement, and the payment voucher.

const METHODS = [["bank", "Bank transfer"], ["upi", "UPI"], ["cash", "Cash"], ["cheque", "Cheque"], ["card", "Card"]];
const SHOW = [["owing", "We owe"], ["overdue", "Overdue"], ["advance", "Advance paid"], ["all", "All suppliers"]];

export function PayablesCard() {
  const biz = useOpenBusiness();
  const [show, setShow] = useState("owing");
  const list = useServerList("payables", { gridId: "business-payables", params: { show, sort: show === "overdue" ? "overdue" : "outstanding" } });
  const [action, setAction] = useState(null);
  const canPay = biz.can("purchasing.edit");
  const columns = useMemo(() => [
    { key: "name", header: "Supplier", value: (r) => r.name, mobile: "title", pin: true },
    { key: "outstanding", header: "We owe", type: "money", exact: true, value: (r) => Number(r.outstanding), total: "sum", mobile: "show" },
    { key: "overdue", header: "Overdue", type: "money", exact: true, value: (r) => Number(r.overdue), total: "sum", mobile: "show",
      render: (r) => (Number(r.overdue) > 0.004 ? <span className="bz-due">{biz.exact(r.overdue)}</span> : <span className="muted">—</span>) },
    { key: "open_bills", header: "Open receipts", type: "number", value: (r) => r.open_bills },
    { key: "oldest_bill", header: "Oldest unpaid", type: "date", value: (r) => r.oldest_bill || "" },
    { key: "next_due", header: "Next due", type: "date", value: (r) => r.next_due || "", defaultHidden: true },
    { key: "credit_days", header: "Credit days", type: "number", value: (r) => r.credit_days, defaultHidden: true },
    { key: "balance", header: "Balance", type: "money", exact: true, value: (r) => Number(r.balance), defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <span className="bz-row-actions">
        {canPay && Number(r.outstanding) > 0.004 && <button type="button" className="chip-button" onClick={() => setAction({ kind: "pay", row: r })}>Pay</button>}
        <button type="button" className="chip-button" onClick={() => setAction({ kind: "statement", row: r })}>Statement</button>
      </span>
    ) },
  ], [biz, canPay]);
  return (
    <SectionCard flush icon="wallet" title="What you owe suppliers" description="Overdue by each supplier's credit days. Pay settles the oldest receipts first; anything extra stays as an advance."
      actions={(
        <div className="segmented" role="group" aria-label="Show">
          {SHOW.map(([code, label]) => <button key={code} type="button" className={`segment ${show === code ? "is-active" : ""}`} aria-pressed={show === code} onClick={() => setShow(code)}>{label}</button>)}
        </div>
      )}>
      <DataGrid {...list.gridProps} caption="What you owe suppliers" columns={columns} currency={biz.symbol} rowKey={(r) => r.contact_id}
        rowClassName={(r) => (Number(r.overdue) > 0.004 ? "dg-tone-danger" : "")}
        empty={show === "owing" ? "You owe no supplier anything" : "No suppliers here"} emptyIcon="truck" />
      {action?.kind === "pay" && <SupplierPayDialog contactId={action.row.contact_id} name={action.row.name} onClose={() => setAction(null)} onSaved={(v) => { setAction(null); list.reload(); toast.success(`${v.payment_no} saved: ${biz.exact(v.amount)} to ${action.row.name}`, { action: { label: "Print", onClick: () => printVoucher(biz, v.id) } }); }} />}
      {action?.kind === "statement" && <SupplierStatementDialog contact={{ id: action.row.contact_id, name: action.row.name }} onClose={() => setAction(null)} />}
    </SectionCard>
  );
}

// Pay one supplier: the open receipts are shown oldest first.
export function SupplierPayDialog({ contactId, name, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ amount: "", method: "bank", reference: "", notes: "", mode: "auto", locationId: String(locations[0]?.id || "") });
  const [amounts, setAmounts] = useState({});
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `suppliers/${contactId}/account`, undefined, controller.signal)
      .then((a) => { setAccount(a); setForm((f) => ({ ...f, amount: f.amount || (Number(a.summary.outstanding) > 0 ? Number(a.summary.outstanding).toFixed(2) : "") })); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId]);
  const chosen = Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0);
  const submit = () => businessWrite(biz.id, `suppliers/${contactId}/payments`, {
    locationId: form.locationId, amount: form.amount, method: form.method, reference: form.reference || undefined, notes: form.notes || undefined, requestKey,
    ...(form.mode === "advance" ? { allocations: [] } : {}),
    ...(form.mode === "choose" ? { allocations: Object.entries(amounts).filter(([, v]) => Number(v) > 0).map(([documentId, amount]) => ({ documentId: Number(documentId), amount })) } : {}),
  });
  return (
    <FormDialog title={`Pay ${name}`} icon="wallet" width={780} submitLabel="Save payment" onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!account}
      description={account ? `You owe ${biz.exact(account.summary.outstanding)}${Number(account.summary.overdue) > 0 ? `, ${biz.exact(account.summary.overdue)} of it overdue` : ""}.` : "Loading what you owe…"}>
      <FormError message={error} />
      {!account && !error && <div className="field-wide"><Loading /></div>}
      <Field label="Amount paid"><input required type="number" min="0.01" step="0.01" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Paid by">
        <select value={form.method} onChange={set("method")}>{METHODS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>
      </Field>
      <Field label={form.method === "cheque" ? "Cheque number" : form.method === "bank" ? "UTR / reference (optional)" : "Reference (optional)"}>
        <input required={form.method === "cheque"} maxLength={100} value={form.reference} onChange={set("reference")} />
      </Field>
      {locations.length > 1 && (
        <Field label="Paid from">
          <select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </Field>
      )}
      <Field label="Put it against" wide>
        <select value={form.mode} onChange={set("mode")}>
          <option value="auto">Oldest receipts first (automatic)</option>
          <option value="choose">Receipts I choose</option>
          <option value="advance">Nothing yet — an advance to the supplier</option>
        </select>
      </Field>
      {account && (
        <div className="field-wide bz-lines">
          <DataGrid variant="editor" caption="Open receipts" rows={account.items} rowKey={(b) => `${b.document_id}-${b.reference}`} currency={biz.symbol} rowNoun={["receipt", "receipts"]}
            empty="No open receipts" columns={[
              { key: "reference", header: "Receipt", value: (b) => b.reference, render: (b) => <span>{b.reference}{b.supplier_bill_no ? <small className="muted"> · bill {b.supplier_bill_no}</small> : null}</span> },
              { key: "bill_date", header: "Date", type: "date", value: (b) => b.bill_date },
              { key: "due_on", header: "Due", value: (b) => b.due_on || "", render: (b) => (b.due_on ? <span className={b.overdue ? "bz-due" : ""}>{dateShort(b.due_on)}{b.overdue ? " · overdue" : ""}</span> : "—") },
              { key: "open", header: "Open", type: "money", exact: true, value: (b) => Number(b.open_amount), total: "sum" },
              form.mode === "choose" && { key: "pay", header: "Pay now", type: "money", value: (b) => Number(amounts[b.document_id]) || 0, total: "sum", render: (b, ctx) => (b.document_id
                ? <input aria-label={ctx.label} type="number" min="0" step="0.01" max={b.open_amount} value={amounts[b.document_id] || ""} onChange={(e) => setAmounts((a) => ({ ...a, [b.document_id]: e.target.value }))} />
                : <span className="muted">kept on account</span>) },
            ].filter(Boolean)} />
          {form.mode === "choose" && <span className="muted small">Chosen {biz.exact(chosen)}{Number(form.amount) > chosen ? ` · ${biz.exact(Number(form.amount) - chosen)} stays as an advance` : ""}</span>}
          {account.advances.length > 0 && <p className="muted small">Already paid ahead: {biz.exact(account.advances.reduce((s, a) => s + Number(a.unallocated), 0))}.</p>}
        </div>
      )}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

const KIND_WORDS = { purchase: "Receipt", return: "Returned", payment: "Payment", voucher: "Payment", refund: "Refund received", opening: "Opening balance" };

export function SupplierStatementDialog({ contact, onClose }) {
  const biz = useOpenBusiness();
  const anchor = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: monthStart(anchor), to: anchor });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `suppliers/${contact.id}/statement`, range, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contact.id, range]);
  const columns = [
    { key: "day", header: "Date", type: "date", value: (e) => e.day, mobile: "subtitle" },
    { key: "kind", header: "What", value: (e) => KIND_WORDS[e.kind] || e.kind, mobile: "title", render: (e) => <Badge tone={e.kind === "purchase" ? "info" : e.kind === "opening" ? "neutral" : "active"} label={KIND_WORDS[e.kind] || e.kind} /> },
    { key: "reference", header: "Reference", value: (e) => e.reference, mobile: "show" },
    { key: "billed", header: "Billed", type: "money", exact: true, value: (e) => Number(e.billed) || null, total: "sum" },
    { key: "paid", header: "Paid / returned", type: "money", exact: true, value: (e) => Number(e.paid) || null, total: "sum" },
    { key: "balance", header: "We owe", type: "money", exact: true, value: (e) => Number(e.balance), total: "none", mobile: "show" },
  ];
  return (
    <Modal title={`Statement · ${contact.name}`} icon="file" width={900} onClose={onClose}
      description={data ? `Brought forward ${biz.exact(data.opening)} · we owe ${biz.exact(data.closing)} at the end` : undefined}>
      <ErrorMessage message={error} />
      <SectionCard flush icon="list" title="Entries" actions={data && biz.can("purchasing.print") && <button type="button" className="button button-secondary button-sm" onClick={() => printStatement(data, biz)}><Icon name="print" size={15} /> Print</button>}>
        <DataGrid id="business-supplier-statement" caption="Supplier statement" columns={columns} rows={(data?.entries || []).map((e, i) => ({ ...e, id: `${e.kind}-${i}` }))}
          loading={!data && !error} currency={biz.symbol} pageSize={50} rowNoun={["entry", "entries"]}
          toolbar={<DateRangeFilter from={range.from} to={range.to} anchor={anchor} label="statement dates" onChange={(next) => next.from && next.to && setRange(next)} />}
          exportName={biz.can("purchasing.export") ? `supplier-statement-${contact.name}` : undefined} empty="No entries in these dates" emptyIcon="file" />
      </SectionCard>
    </Modal>
  );
}

function printStatement(data, biz) {
  const seller = data.seller || {};
  const d = (v) => escapeHtml(businessDate(v, seller.date_format, biz.business.timezone));
  const rows = data.entries.map((e) => `<tr><td>${d(e.day)}</td><td>${escapeHtml(KIND_WORDS[e.kind] || e.kind)} · ${escapeHtml(e.reference)}</td>
    <td class="r">${Number(e.billed) ? escapeHtml(biz.exact(e.billed)) : ""}</td><td class="r">${Number(e.paid) ? escapeHtml(biz.exact(e.paid)) : ""}</td><td class="r">${escapeHtml(biz.exact(e.balance))}</td></tr>`).join("");
  printDocument({
    title: `Statement ${data.contact.name}`,
    styles: "body{font:12px system-ui;color:#111} @page{size:A4;margin:12mm} h1{font-size:17px;margin:0} table{width:100%;border-collapse:collapse;margin-top:10px} td,th{border-bottom:1px solid #ddd;padding:5px;text-align:left} .r{text-align:right}",
    body: `<h1>${escapeHtml(seller.legal_name || seller.display_name || biz.business.name)}</h1>${seller.gstin ? `<small>GSTIN ${escapeHtml(seller.gstin)}</small>` : ""}
      <p><strong>Supplier statement</strong> · ${escapeHtml(data.contact.name)}${data.contact.gstin ? ` (GSTIN ${escapeHtml(data.contact.gstin)})` : ""} · ${d(data.from)} to ${d(data.to)}</p>
      <table><thead><tr><th>Date</th><th>Particulars</th><th class="r">Billed</th><th class="r">Paid / returned</th><th class="r">We owe</th></tr></thead>
      <tbody><tr><td>${d(data.from)}</td><td>Brought forward</td><td></td><td></td><td class="r">${escapeHtml(biz.exact(data.opening))}</td></tr>${rows}</tbody></table>
      <p style="text-align:right"><strong>We owe ${escapeHtml(biz.exact(data.closing))}</strong></p>`,
  });
}

// The payment voucher: what was paid and which receipts it settled.
async function printVoucher(biz, paymentId) {
  const v = await businessRead(biz.id, `supplier-payments/${paymentId}`);
  const seller = v.seller || {};
  const rows = v.allocations.map((a) => `<tr><td>${escapeHtml(a.document_no)}${a.supplier_bill_no ? ` · bill ${escapeHtml(a.supplier_bill_no)}` : ""}</td><td class="r">${escapeHtml(biz.exact(a.amount))}</td></tr>`).join("");
  printDocument({
    title: v.payment_no,
    styles: "body{font:12px system-ui;color:#111} @page{size:A5;margin:10mm} h1{font-size:16px;margin:0} table{width:100%;border-collapse:collapse;margin-top:8px} td,th{border-bottom:1px solid #ddd;padding:5px;text-align:left} .r{text-align:right}",
    body: `<h1>${escapeHtml(seller.legal_name || seller.display_name || biz.business.name)}</h1>
      <p><strong>Payment voucher ${escapeHtml(v.payment_no)}</strong> · ${escapeHtml(businessDate(v.created_at, seller.date_format, biz.business.timezone))}</p>
      <p>Paid to <strong>${escapeHtml(v.contact_name)}</strong>${v.contact_gstin ? ` (GSTIN ${escapeHtml(v.contact_gstin)})` : ""}<br>
      ${escapeHtml(biz.exact(v.amount))} by ${escapeHtml((METHODS.find(([c]) => c === v.method) || [v.method, v.method])[1])}${v.reference ? ` · ${escapeHtml(v.reference)}` : ""}<br>
      <em>${escapeHtml(amountInWords(v.amount))}</em></p>
      <table><thead><tr><th>Against</th><th class="r">Amount</th></tr></thead><tbody>${rows}
      ${Number(v.unallocated) > 0 ? `<tr><td>Advance (not yet against a receipt)</td><td class="r">${escapeHtml(biz.exact(v.unallocated))}</td></tr>` : ""}</tbody></table>
      <p style="margin-top:30px">Paid by ${escapeHtml(v.created_by_name)} ______________ &nbsp;&nbsp; Received by ______________</p>`,
  });
}
