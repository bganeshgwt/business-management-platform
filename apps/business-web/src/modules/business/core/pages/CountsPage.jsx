import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { Badge, BusinessHeader, Field, PeriodFilter } from "./ui";
import { newKey, useOpenBusiness, useOptions, useServerList } from "./hooks";

// Stock counts: start a sheet for a location, enter what is on the shelf,
// and an approver posts the differences as corrections with reasons.
export default function CountsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const list = useServerList("counts", { gridId: "business-counts", period: true });
  const [starting, setStarting] = useState(false);

  const columns = useMemo(() => [
    { key: "count_no", header: "Count", value: (c) => c.count_no, mobile: "title", pin: true, render: (c) => <Link className="mono" to={biz.path(`counts/${c.id}`)}>{c.count_no}</Link> },
    { key: "created_at", header: "Started", type: "datetime", value: (c) => c.created_at },
    { key: "location", header: "Location", value: (c) => c.location_name, mobile: "subtitle" },
    { key: "progress", header: "Counted", value: (c) => c.counted_count, render: (c) => `${c.counted_count} of ${c.line_count}`, mobile: "show" },
    { key: "corrected", header: "Corrections", type: "number", value: (c) => c.corrected_count },
    { key: "status", header: "Status", type: "status", value: (c) => c.status, render: (c) => <Badge status={c.status} label={c.status === "open" ? "Counting" : undefined} />, mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (c) => <Link className="chip-button" to={biz.path(`counts/${c.id}`)}>{c.status === "open" ? "Continue" : "Open"}</Link> },
  ], [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Stock counts"
        description="Count a location's shelves. Differences are posted only when someone approves the count, each with a reason, against the stock at that moment."
        actions={biz.can("stock_counts.create") && <button type="button" className="button" onClick={() => setStarting(true)}><Icon name="plus" size={16} /> Start a count</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Counts in this period">
        <DataGrid {...list.gridProps} caption="Stock counts" columns={columns} rowNoun={["count", "counts"]} toolbar={<PeriodFilter list={list} />}
          rowClassName={(c) => (c.status === "open" ? "dg-tone-warning" : c.status === "cancelled" ? "dg-tone-muted" : "")}
          empty="No counts in these dates" emptyIcon="clipboard" />
      </SectionCard>
      {starting && <StartDialog onClose={() => setStarting(false)} onSaved={(c) => navigate(biz.path(`counts/${c.id}`))} />}
    </div>
  );
}

function StartDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["categories?active=true"]);
  const [requestKey] = useState(newKey);
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState({ locationId: String(locations[0]?.id || ""), categoryId: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Start a stock count" icon="clipboard" width={540} submitLabel="Start" onClose={onClose} onSaved={onSaved}
      description="The sheet lists every batch at the location. Sales can go on while you count."
      onSubmit={() => businessWrite(biz.id, "counts", { ...form, categoryId: form.categoryId || undefined, notes: form.notes || undefined, requestKey })}>
      <Field label="Location">
        <select required value={form.locationId} onChange={set("locationId")}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      <Field label="Only this category (optional)">
        <select value={form.categoryId} onChange={set("categoryId")}>
          <option value="">Everything</option>
          {(options?.["categories?active=true"] || []).map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
        </select>
      </Field>
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. Month-end count, aisle 1–4" /></Field>
    </FormDialog>
  );
}
