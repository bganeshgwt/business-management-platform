import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import FormDialog from "./FormDialog";
import { Badge, BusinessHeader, Field } from "./ui";
import { businessToday, newKey, quantity, useOpenBusiness, useServerList } from "./hooks";
import { dateShort } from "../../../../services/format";
import { inPacks } from "../../wholesale/pages/tradeFormat";

// Whole days from today to a batch's expiry (negative once past).
const daysTo = (day, today) => Math.round((Date.parse(String(day).slice(0, 10)) - Date.parse(today)) / 86400000);

// Stock on hand by location and batch, with corrections that need a reason.
export default function StockPage() {
  const biz = useOpenBusiness();
  const [location, setLocation] = useState("");
  // Pro pass D-13: empty batches are hidden unless asked for; expiring soon is one tap.
  const [show, setShow] = useState("in_stock");
  const list = useServerList("stock", { gridId: "business-stock", params: { ...(location ? { location } : {}), ...(show ? { [show]: "true" } : {}) } });
  const [adjusting, setAdjusting] = useState(null);
  const [notice, setNotice] = useState("");
  const batches = biz.has("batches") || biz.has("serials");
  // Days to a batch's expiry, for the badge (pro pass C-25: shown on phone cards too).
  const today = businessToday(biz.business.timezone);

  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (l) => l.label, mobile: "title", pin: true },
    { key: "code", header: "SKU", value: (l) => l.code, className: "mono", defaultHidden: true },
    { key: "location", header: "Location", value: (l) => l.location_name, mobile: "subtitle" },
    { key: "shelf", header: "Shelf", value: (l) => l.shelf_location || "", render: (l) => l.shelf_location || <span className="muted">—</span> },
    batches && { key: "lot", header: biz.has("serials") ? "Batch / serial" : "Batch", value: (l) => l.lot_code || "", className: "mono", mobile: "show" },
    biz.has("batches") && { key: "expires_on", header: "Expiry", type: "date", value: (l) => l.expires_on,
      render: (l) => (l.expires_on ? (
        <span className="bz-inline">{dateShort(l.expires_on, { year: true })}
          {l.expired ? <Badge tone="danger" label="Expired" /> : Number(l.quantity) > 0 && daysTo(l.expires_on, today) <= 30 && <Badge tone={daysTo(l.expires_on, today) <= 7 ? "danger" : "warning"} label={daysTo(l.expires_on, today) === 1 ? "1 day left" : `${daysTo(l.expires_on, today)} days left`} />}
        </span>
      ) : <span className="muted">—</span>), mobile: "show" },
    { key: "quantity", header: "On hand", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit), mobile: "show" },
    { key: "packs", header: "In packs", value: (l) => (l.pack_unit ? inPacks(l.quantity, l.unit, l.pack_unit, l.pack_factor) : ""), defaultHidden: !biz.has("sales_orders"),
      render: (l) => (l.pack_unit ? inPacks(l.quantity, l.unit, l.pack_unit, l.pack_factor) : <span className="muted">—</span>) },
    { key: "unit_cost", header: "Average cost", type: "money", exact: true, value: (l) => Number(l.unit_cost) },
    { key: "value", header: "Stock value", type: "money", exact: true, value: (l) => Number(l.quantity) * Number(l.unit_cost), total: "sum", mobile: "show" },
    biz.can("inventory.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => <button type="button" className="chip-button" onClick={() => setAdjusting(l)}>Correct</button> },
  ], [biz, batches, today]);

  return (
    <div className="stack">
      <BusinessHeader icon="box" title="Stock on hand"
        description="What is on the shelf at each location, batch by batch, at its average cost. Corrections need a reason and are kept in the movement history."
        />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Stock">
        <DataGrid {...list.gridProps} caption="Stock on hand" columns={columns.filter(Boolean)} currency={biz.symbol} rowNoun={["batch", "batches"]}
          toolbar={(
            <>
              {biz.locations.length > 1 && (
                <label className="field">
                  <span>Location</span>
                  <select value={location} onChange={(e) => setLocation(e.target.value)}>
                    <option value="">All locations</option>
                    {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              )}
              <label className="field">
                <span>Show</span>
                <select value={show} onChange={(e) => setShow(e.target.value)}>
                  <option value="in_stock">Batches with stock</option>
                  {biz.has("batches") && <option value="expiring">Expiring in 90 days</option>}
                  <option value="">All, including empty</option>
                </select>
              </label>
            </>
          )}
          rowClassName={(l) => (l.expired && Number(l.quantity) > 0 ? "dg-tone-danger" : Number(l.quantity) === 0 ? "dg-tone-muted" : Number(l.reorder_level) > 0 && Number(l.quantity) <= Number(l.reorder_level) ? "dg-tone-warning" : "")}
          exportName={biz.can("inventory.export") ? `${biz.business.code}-stock` : undefined}
          empty="No stock yet" emptyHint="Stock appears when a purchase is received." emptyIcon="box" />
      </SectionCard>
      {adjusting && <AdjustDialog lot={adjusting} onClose={() => setAdjusting(null)}
        onSaved={() => { setAdjusting(null); setNotice("Stock corrected."); list.reload(); }} />}
    </div>
  );
}

function AdjustDialog({ lot, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ direction: "-", amount: "", reason: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Correct ${lot.label}`} icon="sliders" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Post correction"
      description={`${lot.location_name}${lot.lot_code ? ` · ${lot.lot_code}` : ""} · on hand ${quantity(lot.quantity, lot.unit)}. The average cost stays as it is.`}
      onSubmit={() => businessWrite(biz.id, `stock/${lot.id}/adjustments`, { quantity: `${form.direction === "-" ? "-" : ""}${form.amount}`, reason: form.reason, requestKey })}>
      <Field label="Change">
        <select value={form.direction} onChange={set("direction")}>
          <option value="-">Remove (shortage, damage, wastage)</option>
          {lot.tracking !== "serial" && <option value="+">Add (found extra)</option>}
        </select>
      </Field>
      <Field label={`Quantity (${lot.unit})`}><input required type="number" min="0.001" step="0.001" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Reason" wide><input required maxLength={300} value={form.reason} onChange={set("reason")} placeholder="e.g. Damaged in rain" /></Field>
    </FormDialog>
  );
}
