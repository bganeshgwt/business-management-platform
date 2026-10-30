import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import DataGrid from "../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../components/DateRangeFilter";
import StatusBadge from "../../../components/StatusBadge";
import FormField from "../../../components/FormField";
import { ErrorMessage } from "../../../components/Feedback";
import FormDialog from "../../business/core/pages/FormDialog";
import SampleNotice from "../SampleNotice";
import { getErrorMessage } from "../../../services/api";
import { toast } from "../../../services/toast";
import { moneyExact, relative } from "@bmp/shared/format";
import { monthStart, today } from "@bmp/shared/dates";
import { confirmConsolePayment, consolePayments, recordConsolePayment, rejectConsolePayment } from "../services/console.service";
import { METHOD_WORDS, PAYMENT_STATES, dayWords } from "../consoleWords";
import "../styles/console.css";

// Platform › Payments (/platform/payments): the payments owners entered with
// their reference, the ones being checked first. Confirming one (once the
// money is in the company's account) issues its invoice and extends the
// business; rejecting one needs a reason, and the order stays open. Open
// orders with no payment being checked wait for a payment the company
// received some other way, recorded and confirmed at once. Then every
// payment, by state, date paid and business, with a CSV.
const STATUS_FILTER = [["", "Every state"], ["pending", "Being checked"], ["confirmed", "Confirmed"], ["rejected", "Rejected"]];
const money = (value) => moneyExact(Number(value || 0));
const KIND_WORDS = { subscription: "Plan", add_on: "Add-ons" };
const orderWords = (row) => `${KIND_WORDS[row.orderKind || row.kind] || ""} · ${dayWords(row.startsOn)} to ${dayWords(row.endsOn)}`;

export default function PlatformPaymentsPage() {
  const navigate = useNavigate();
  const [waiting, setWaiting] = useState(null);
  const [all, setAll] = useState(null);
  const [filters, setFilters] = useState(() => ({ status: "", from: monthStart(), to: today(), q: "" }));
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [recording, setRecording] = useState(null);

  // A payment confirmed, rejected or recorded here reads both lists again,
  // each with the filters on screen at that moment; an answer that comes back
  // after a newer request was sent is dropped.
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((n) => n + 1);

  useEffect(() => {
    let live = true;
    consolePayments({ status: "pending" })
      .then((result) => { if (live) { setWaiting(result); setError(""); } })
      .catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [version]);
  useEffect(() => {
    let live = true;
    consolePayments({ status: filters.status || undefined, from: filters.from || undefined, to: filters.to || undefined, q: filters.q.trim() || undefined })
      .then((result) => { if (live) setAll(result); })
      .catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [filters, version]);

  const confirm = async (payment) => {
    setConfirming(payment.id);
    try {
      const result = await confirmConsolePayment(payment.id);
      toast.success(`Confirmed: ${payment.businessName}. Invoice ${result.invoice?.number || ""} issued.`,
        result.invoice ? { action: { label: "Open invoice", onClick: () => navigate(`/platform/invoices/${result.invoice.id}`) } } : undefined);
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setConfirming(null);
    }
  };

  const business = (row) => <Link to={`/platform/businesses/${row.businessId}`}><strong>{row.businessName}</strong></Link>;
  const waitingColumns = useMemo(() => [
    { key: "business", header: "Business", value: (p) => p.businessName, mobile: "title", render: business },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (p) => Number(p.amount), mobile: "show" },
    { key: "method", header: "Paid by", value: (p) => METHOD_WORDS[p.method] || p.method },
    { key: "reference", header: "Reference", value: (p) => p.reference, className: "mono", mobile: "show" },
    { key: "paidOn", header: "Date paid", type: "date", value: (p) => p.paidOn },
    { key: "entered", header: "Entered", type: "datetime", value: (p) => p.submittedAt, render: (p) => `${relative(p.submittedAt)}${p.submittedBy ? ` by ${p.submittedBy}` : ""}` },
    { key: "order", header: "For", value: orderWords },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => (
      <span className="bz-actions">
        <button type="button" className="button button-sm" disabled={confirming === p.id} onClick={() => confirm(p)}>{confirming === p.id ? "Confirming…" : "Confirm"}</button>
        <button type="button" className="button button-secondary button-sm" onClick={() => setRejecting(p)}>Reject</button>
      </span>
    ) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [confirming]);

  const openColumns = useMemo(() => [
    { key: "business", header: "Business", value: (o) => o.businessName, mobile: "title", render: business },
    { key: "order", header: "Order", value: (o) => `No. ${o.id}`, render: (o) => <span className="bz-two-line"><span>No. {o.id}</span><small className="muted">{orderWords(o)}</small></span> },
    { key: "total", header: "Total with GST", type: "money", exact: true, value: (o) => Number(o.total), mobile: "show" },
    { key: "validUntil", header: "Prices held until", type: "date", value: (o) => o.validUntil, render: (o) => (o.expired ? `${dayWords(o.validUntil)} (past)` : dayWords(o.validUntil)) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (o) => <button type="button" className="chip-button" onClick={() => setRecording(o)}>Record payment</button> },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const allColumns = useMemo(() => [
    { key: "business", header: "Business", value: (p) => p.businessName, mobile: "title", pin: true, render: business },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (p) => Number(p.amount), mobile: "show" },
    { key: "method", header: "Paid by", value: (p) => METHOD_WORDS[p.method] || p.method },
    { key: "reference", header: "Reference", value: (p) => p.reference, className: "mono" },
    { key: "paidOn", header: "Date paid", type: "date", value: (p) => p.paidOn },
    { key: "status", header: "State", type: "status", value: (p) => PAYMENT_STATES[p.status]?.label || p.status, mobile: "subtitle",
      render: (p) => <StatusBadge status={p.status} label={PAYMENT_STATES[p.status]?.label || p.status} tone={PAYMENT_STATES[p.status]?.tone} /> },
    { key: "by", header: "Entered by", value: (p) => (p.recorded ? `Recorded by ${p.submittedBy || "the platform"}` : p.submittedBy || "") },
    { key: "decided", header: "Decided", type: "datetime", value: (p) => p.decidedAt || "", render: (p) => (p.decidedAt ? `${relative(p.decidedAt)}${p.decidedBy ? ` by ${p.decidedBy}` : ""}` : "") },
    { key: "note", header: "Reason", value: (p) => p.decisionNote || "" },
    { key: "invoice", header: "Invoice", value: (p) => p.invoiceNumber || "",
      render: (p) => (p.invoiceId ? <Link className="mono" to={`/platform/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link> : "") },
    { key: "order", header: "For", value: orderWords, defaultHidden: true },
  ], []);

  const sampleMode = waiting?.sampleMode;
  return (
    <div className="stack pc-page">
      <PageHeader icon="money" eyebrow="Platform" title="Payments"
        description="Payments owners made for their plans, with the reference they entered. Confirm one once the money is in the company's account: that issues its invoice and extends the business." />
      {sampleMode && <SampleNotice />}
      <ErrorMessage message={error} />

      <SectionCard icon="clock" title={`Being checked${waiting ? ` (${waiting.pendingCount})` : ""}`}
        description="Find each in the bank statement or UPI app by its reference, then confirm it, or reject it with the reason." flush>
        <DataGrid id="platform-payments-waiting" caption="Payments being checked" variant="compact" pageSize={false} rows={waiting?.items || []} columns={waitingColumns}
          loading={!waiting && !error} empty="No payments to check" emptyHint="An owner's payment appears here as soon as they enter its reference." emptyIcon="check-circle" />
      </SectionCard>

      {waiting?.openOrders.length > 0 && (
        <SectionCard icon="receipt" title="Open orders, not paid yet" description="Money the company received some other way: record it against its order, and it is confirmed at once." flush>
          <DataGrid id="platform-payments-open" caption="Open orders" variant="compact" pageSize={false} rows={waiting.openOrders} columns={openColumns} />
        </SectionCard>
      )}

      <SectionCard icon="list" title="Every payment" flush>
        <DataGrid id="platform-payments" caption="Payments" columns={allColumns} rows={all?.items || []} loading={!all && !error} exportName="platform-payments"
          rowNoun={["payment", "payments"]} search={false}
          toolbar={(
            <span className="pc-toolbar">
              <input type="search" placeholder="Business, code or reference" aria-label="Search payments" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
              <select aria-label="State" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                {STATUS_FILTER.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <DateRangeFilter from={filters.from} to={filters.to} label="dates paid" onChange={(range) => setFilters((f) => ({ ...f, ...range }))} />
            </span>
          )}
          empty="No payments in these dates" emptyIcon="money" />
      </SectionCard>

      {rejecting && (
        <RejectDialog payment={rejecting} onClose={() => setRejecting(null)} onSaved={() => { setRejecting(null); reload(); }} />
      )}
      {recording && (
        <RecordDialog order={recording} onClose={() => setRecording(null)} onSaved={() => { setRecording(null); reload(); }} />
      )}
    </div>
  );
}

function RejectDialog({ payment, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Reject a payment: ${payment.businessName}`} icon="x-circle" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Reject payment"
      description={`${money(payment.amount)} by ${METHOD_WORDS[payment.method] || payment.method}, reference ${payment.reference}. The order stays open; the owner sees the reason.`}
      successMessage="Payment rejected. Its order stays open."
      onSubmit={() => rejectConsolePayment(payment.id, reason.trim())}>
      <FormField label="Reason" wide hint="Such as “No such UTR in the bank statement”.">
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </FormDialog>
  );
}

function RecordDialog({ order, onClose, onSaved }) {
  const [form, setForm] = useState({ method: "bank", reference: "", paidOn: today() });
  return (
    <FormDialog title={`Record a payment: ${order.businessName}`} icon="money" width={600} onClose={onClose} onSaved={onSaved} submitLabel="Record and confirm"
      description={`Order ${order.id}, ${money(order.total)} with GST. It is confirmed at once: the invoice is issued and the time added.`}
      successMessage={(result) => `Payment recorded. Invoice ${result.invoice?.number || ""} issued.`}
      onSubmit={() => recordConsolePayment(order.businessId, { orderId: order.id, method: form.method, reference: form.reference.trim(), paidOn: form.paidOn })}>
      <FormField label="Paid by">
        <select value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}>
          {Object.entries(METHOD_WORDS).map(([code, words]) => <option key={code} value={code}>{words}</option>)}
        </select>
      </FormField>
      <FormField label="Date paid"><input type="date" required max={today()} value={form.paidOn} onChange={(e) => setForm((f) => ({ ...f, paidOn: e.target.value }))} /></FormField>
      <FormField label="Reference" wide hint="The UPI or bank transaction number, the cheque number, or who handed over the cash.">
        <input required maxLength={100} value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} />
      </FormField>
    </FormDialog>
  );
}
