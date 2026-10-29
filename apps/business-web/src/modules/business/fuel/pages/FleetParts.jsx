import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, Field } from "../../core/pages/ui";
import { newKey } from "../../core/pages/hooks";
import { dayWords, firstOutlet, monthWords } from "./fuel";

// A fleet customer's terms with the station and what follows from them, on
// their statement: billed per shift or by the month (the fills held on their
// slips until one invoice for the month bills them, the stock leaving with
// it), the interest on overdue credit by their rate and days (worked out to
// the paisa, billed when someone confirms it), and the slip books issued to
// them by serial (each slip taken once). The server checks every rule again.

export function FleetTerms({ biz, statement, onChanged }) {
  const [dialog, setDialog] = useState(null);
  const terms = statement.terms;
  const canInvoice = biz.can("fuel.edit") && biz.can("sales.create");
  const outlets = statement.unbilled.outlets.map((id) => biz.locations.find((l) => String(l.id) === String(id))).filter(Boolean);
  const invoice = async (locationId) => {
    try {
      const made = await businessWrite(biz.id, `fuel/fleet/${statement.customer.id}/invoice`, { requestKey: newKey(), month: statement.month, locationId });
      toast.success(`Invoice ${made.document_no} made for ${made.fills} ${made.fills === 1 ? "fill" : "fills"}.`);
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  return (
    <SectionCard icon="calendar" title="Billing and interest" aria-label="Billing and interest"
      description={terms.billing === "month" ? "Billed by the month: each shift's credit fills are held on their slips until one invoice for the month bills them."
        : "Billed per shift: each shift's credit fills go on a fuel bill of the shift."}
      actions={biz.can("fuel.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog("terms")}><Icon name="edit" size={14} /> Change the terms</button>}>
      <dl className="fuel-facts">
        <dt>Billed</dt><dd>{terms.billing === "month" ? "By the month" : "Per shift"}</dd>
        <dt>Interest on overdue credit</dt><dd>{terms.interestRate ? `${Number(terms.interestRate)}% a month, from ${terms.interestAfterDays} days after a bill falls due` : "None"}</dd>
        <dt>Fills not yet billed</dt><dd className="mono">{statement.unbilled.fills ? `${statement.unbilled.fills} · ${biz.exact(statement.unbilled.amount)}` : "None"}</dd>
      </dl>
      {canInvoice && outlets.map((l) => (
        <button key={l.id} type="button" className="button" onClick={() => invoice(l.id)}>
          <Icon name="receipt" size={16} /> Invoice {monthWords(statement.month)}{outlets.length > 1 || biz.locations.length > 1 ? ` at ${l.name}` : ""}
        </button>
      ))}
      {statement.invoices.length > 0 && (
        <ul className="fuel-history">
          {statement.invoices.map((i) => <li key={i.id}><strong className="mono">{i.document_no}</strong> · {i.location_name} · {i.fills} {i.fills === 1 ? "fill" : "fills"} · {biz.exact(i.total)}</li>)}
        </ul>
      )}
      {dialog === "terms" && <TermsDialog biz={biz} customer={statement.customer} terms={terms} onClose={() => setDialog(null)}
        onSaved={() => { setDialog(null); toast.success("Terms saved."); onChanged(); }} />}
    </SectionCard>
  );
}

function TermsDialog({ biz, customer, terms, onClose, onSaved }) {
  const [form, setForm] = useState({ billing: terms.billing, interestRate: terms.interestRate ? String(Number(terms.interestRate)) : "", interestAfterDays: String(terms.interestAfterDays || 0) });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`${customer.name}'s terms`} icon="calendar" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Save the terms"
      description="Fills already held for a month stay held for its invoice when billing goes back to each shift."
      onSubmit={() => businessWrite(biz.id, `fuel/fleet/${customer.id}/terms`, { billing: form.billing, interestRate: form.interestRate.trim() || null, interestAfterDays: form.interestAfterDays || "0" }, "put")}>
      <Field label="Billed">
        <select value={form.billing} onChange={set("billing")}>
          <option value="shift">Per shift: a fuel bill for each shift's fills</option>
          <option value="month">By the month: one invoice for the month's fills</option>
        </select>
      </Field>
      <Field label="Interest on overdue credit (% a month, optional)"><input inputMode="decimal" className="mono" value={form.interestRate} onChange={set("interestRate")} placeholder="e.g. 1.5" /></Field>
      <Field label="Interest from this many days after a bill falls due"><input inputMode="numeric" className="mono" value={form.interestAfterDays} onChange={set("interestAfterDays")} /></Field>
    </FormDialog>
  );
}

// The interest on the customer's overdue fuel bills, worked out to today, and billing it.
export function FleetInterest({ biz, contactId, version }) {
  const [interest, setInterest] = useState(null);
  const [error, setError] = useState("");
  const [again, setAgain] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `fuel/fleet/${contactId}/interest`, undefined, controller.signal)
      .then((x) => { setInterest(x); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version, again]);
  if (!interest) return <ErrorMessage message={error} />;
  if (!interest.terms.interestRate && !interest.charges.length) return null;
  const bill = async () => {
    try {
      await businessWrite(biz.id, `fuel/fleet/${contactId}/interest`, { requestKey: newKey(), locationId: firstOutlet(biz), amount: interest.due });
      toast.success(`Interest of ${biz.exact(interest.due)} billed.`);
      setAgain((n) => n + 1);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  return (
    <SectionCard flush icon="percent" title="Interest on overdue credit"
      description={`Worked out to ${dayWords(interest.upTo)}: ${biz.exact(interest.worked)}, of which ${biz.exact(interest.billed)} billed · due now ${biz.exact(interest.due)}`}
      actions={biz.can("fuel.approve") && biz.can("sales.create") && Number(interest.due) > 0
        && <button type="button" className="button button-sm" onClick={bill}><Icon name="receipt" size={14} /> Bill {biz.exact(interest.due)}</button>}>
      <DataGrid variant="compact" id="fuel-interest" caption="Interest bill by bill" rows={interest.bills} rowKey={(b) => b.documentId} currency={biz.symbol} rowNoun={["bill", "bills"]}
        columns={[
          { key: "bill", header: "Bill", value: (b) => b.documentNo, className: "mono", mobile: "title" },
          { key: "from", header: "Interest from", value: (b) => b.from, render: (b) => dayWords(b.from) },
          { key: "days", header: "Days", type: "number", value: (b) => b.days },
          { key: "interest", header: "Interest", type: "money", exact: true, value: (b) => Number(b.interest), total: "sum", mobile: "show" },
        ]}
        empty="No bill is overdue" emptyIcon="percent" />
    </SectionCard>
  );
}

// The slip books issued to the customer, each with its slips used and left.
export function SlipBooks({ biz, customer }) {
  const [books, setBooks] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "fuel/indent-books", { contactId: customer.id }, controller.signal)
      .then((x) => { setBooks(x); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, customer.id, version]);
  const reload = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); };
  const keeps = biz.can("fuel.edit");
  const toggle = (b) => businessWrite(biz.id, `fuel/indent-books/${b.id}`, { active: !b.active }, "patch")
    .then(() => reload(b.active ? `Book ${b.book_no} withdrawn.` : `Book ${b.book_no} back in use.`)).catch((err) => toast.error(getErrorMessage(err)));
  return (
    <SectionCard flush icon="book" title="Slip books" description="Indent books issued by serial: each slip is taken once, and a slip outside the customer's books in use is refused."
      actions={keeps && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "issue" })}><Icon name="plus" size={14} /> Issue a book</button>}>
      <ErrorMessage message={error} />
      <DataGrid variant="compact" id="fuel-slip-books" caption="Slip books" rows={books || []} loading={!books && !error} rowKey={(b) => b.id} rowNoun={["book", "books"]}
        onRowClick={(b) => setDialog({ kind: "book", id: b.id })} rowClassName={(b) => (b.active ? "" : "dg-tone-muted")}
        columns={[
          { key: "book_no", header: "Book", value: (b) => b.book_no, className: "mono", mobile: "title" },
          { key: "serials", header: "Slips", value: (b) => `${b.first_serial}–${b.last_serial}`, className: "mono", mobile: "subtitle" },
          { key: "issued", header: "Issued", value: (b) => b.issued_on, render: (b) => dayWords(b.issued_on) },
          { key: "used", header: "Used", type: "number", value: (b) => b.used },
          { key: "unused", header: "Unused", type: "number", value: (b) => b.unused, mobile: "show" },
          { key: "active", header: "In use", value: (b) => (b.active ? "Yes" : "No"), render: (b) => <ActiveBadge active={b.active} /> },
          keeps && { key: "actions", header: "", label: "Actions", type: "actions",
            render: (b) => <button type="button" className="chip-button" onClick={(e) => { e.stopPropagation(); toggle(b); }}>{b.active ? "Withdraw" : "Back in use"}</button> },
        ].filter(Boolean)}
        empty="No slip books" emptyHint="Without books, a slip's number is noted as typed." emptyIcon="book" />
      {dialog?.kind === "issue" && <IssueBookDialog biz={biz} customer={customer} onClose={() => setDialog(null)} onSaved={(b) => reload(`Book ${b.book_no} issued.`)} />}
      {dialog?.kind === "book" && <BookDialog biz={biz} bookId={dialog.id} onClose={() => setDialog(null)} />}
    </SectionCard>
  );
}

function IssueBookDialog({ biz, customer, onClose, onSaved }) {
  const [form, setForm] = useState({ bookNo: "", firstSerial: "", lastSerial: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Issue a slip book to ${customer.name}`} icon="book" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Issue it"
      onSubmit={() => businessWrite(biz.id, "fuel/indent-books", { contactId: customer.id, bookNo: form.bookNo.trim(), firstSerial: form.firstSerial, lastSerial: form.lastSerial,
        note: form.note.trim() || null })}>
      <Field label="Book number"><input required maxLength={30} value={form.bookNo} onChange={set("bookNo")} /></Field>
      <Field label="First slip"><input required inputMode="numeric" className="mono" value={form.firstSerial} onChange={set("firstSerial")} /></Field>
      <Field label="Last slip"><input required inputMode="numeric" className="mono" value={form.lastSerial} onChange={set("lastSerial")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} /></Field>
    </FormDialog>
  );
}

// A book's slips: those used (on which shift, for which vehicle) and those still unused.
function BookDialog({ biz, bookId, onClose }) {
  const [book, setBook] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `fuel/indent-books/${bookId}`, undefined, controller.signal).then(setBook).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, bookId]);
  return (
    <FormDialog title={book ? `Book ${book.book_no}` : "Slip book"} icon="book" width={640} onClose={onClose} onSaved={onClose} onSubmit={async () => null} submitLabel="Close"
      description={book ? `Slips ${book.first_serial} to ${book.last_serial}: ${book.used} used, ${book.unused} unused.` : undefined}>
      <ErrorMessage message={error} />
      {book && (
        <div className="field-wide">
          <p><strong>Unused:</strong> {book.unusedRanges.map((r) => (r.from === r.to ? r.from : `${r.from}–${r.to}`)).join(", ") || "none"}</p>
          <ul className="fuel-history">
            {book.usedSlips.map((s) => <li key={s.serial}><span className="mono">{s.serial}</span> · {s.registration} · {s.product_name} · shift {s.shift_no}{s.held ? " · held for the month" : ""}</li>)}
          </ul>
          {!book.usedSlips.length && <Badge tone="neutral" label="No slip used yet" />}
        </div>
      )}
    </FormDialog>
  );
}
