import { useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { BusinessHeader, Field } from "./ui";
import { businessToday, useOpenBusiness, useServerList } from "./hooks";

const KINDS = { sale: "Sale invoices", purchase: "Purchase receipts", sales_return: "Credit notes (sales returns)", purchase_return: "Debit notes (supplier returns)", stock_transfer: "Stock transfers", stock_count: "Stock counts",
  // Wholesale sales orders and collection receipts.
  sales_order: "Sales orders", collection: "Collection receipts", purchase_order: "Purchase orders", delivery_challan: "Delivery challans",
  // Electronics repair job cards.
  repair_job: "Repair job cards",
  // Meat / weight shops' cutting batches.
  processing: "Cutting batches",
  // Estimates (not GST documents).
  quotation: "Quotations" };
const fiscalLabel = (year) => `${year}-${String((Number(year) + 1) % 100).padStart(2, "0")}`;
const sample = (s) => `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;

// How documents are numbered: per location, kind and financial year. A number
// is taken inside the posting itself, so two counters can never get the same
// one, and a posting that fails gives its number back.
export default function NumberSeriesPage() {
  const biz = useOpenBusiness();
  const list = useServerList("number-series", { gridId: "business-number-series" });
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const columns = [
    { key: "document_kind", header: "Document", value: (s) => KINDS[s.document_kind], mobile: "title", pin: true },
    { key: "location", header: "Location", value: (s) => s.location_name, mobile: "subtitle" },
    { key: "fiscal_year", header: "Financial year", value: (s) => fiscalLabel(s.fiscal_year) },
    { key: "prefix", header: "Prefix", value: (s) => s.prefix, className: "mono" },
    { key: "next", header: "Next number", value: (s) => sample(s), className: "mono", mobile: "show" },
    { key: "used", header: "Used so far", type: "number", value: (s) => Number(s.next_number) - 1 },
    biz.can("settings.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => <button type="button" className="chip-button" onClick={() => setEditing(s)}>Edit</button> },
  ];
  return (
    <div className="stack">
      <BusinessHeader icon="file" title="Number series"
        description="Each location numbers its own documents, starting again each financial year. A series is created automatically with the first document; set one up first to choose its prefix. GST invoice numbers are at most 16 characters."
        actions={biz.can("settings.edit") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add series</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Series">
        <DataGrid {...list.gridProps} caption="Number series" columns={columns.filter(Boolean)} rowNoun={["series", "series"]}
          empty="No series yet" emptyHint="The first sale at a location starts one, like SI/2627/0001." />
      </SectionCard>
      {editing && <SeriesDialog series={editing} onClose={() => setEditing(null)} onSaved={(s) => { setEditing(null); setNotice(`Series ${s.prefix} saved.`); list.reload(); }} />}
    </div>
  );
}

function SeriesDialog({ series, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(series.id);
  const today = businessToday(biz.business.timezone);
  const startMonth = Number(biz.settings.fiscal_year_start_month || 4);
  const thisYear = Number(today.slice(5, 7)) >= startMonth ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  const [form, setForm] = useState({
    locationId: String(series.location_id || biz.locations[0]?.id || ""), documentKind: series.document_kind || "sale", fiscalYear: String(series.fiscal_year || thisYear),
    prefix: series.prefix || "", padding: String(series.padding || 4), nextNumber: String(series.next_number || 1),
  });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const used = editing && Number(series.next_number) > 1;
  const preview = form.prefix ? `${form.prefix.toUpperCase()}${String(form.nextNumber || 1).padStart(Number(form.padding) || 1, "0")}` : "";
  return (
    <FormDialog title={editing ? `Edit ${series.prefix}` : "Add a number series"} icon="file" width={600} onClose={onClose} onSaved={onSaved}
      description={used ? "Numbers from this series are in use: only the next number can move, and only forward." : undefined}
      onSubmit={() => (editing ? businessWrite(biz.id, `number-series/${series.id}`, form, "patch") : businessWrite(biz.id, "number-series", form))}>
      {!editing && (
        <>
          <Field label="Document">
            <select value={form.documentKind} onChange={set("documentKind")}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label="Location">
            <select value={form.locationId} onChange={set("locationId")}>{biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          </Field>
          <Field label="Financial year">
            <select value={form.fiscalYear} onChange={set("fiscalYear")}>{[thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{fiscalLabel(y)}</option>)}</select>
          </Field>
        </>
      )}
      <Field label="Prefix" hint="Letters, digits, / and -; must not end in a digit."><input required maxLength={12} className="mono" disabled={used} value={form.prefix} onChange={set("prefix")} placeholder="e.g. INV/26-27/" /></Field>
      <Field label="Digits"><input required type="number" min="1" max="8" disabled={used} value={form.padding} onChange={set("padding")} /></Field>
      <Field label="Next number"><input required type="number" min={series.next_number || 1} step="1" value={form.nextNumber} onChange={set("nextNumber")} /></Field>
      {preview && <p className="field-wide muted">The next document will be numbered <strong className="mono">{preview}</strong> ({preview.length} characters).</p>}
    </FormDialog>
  );
}
