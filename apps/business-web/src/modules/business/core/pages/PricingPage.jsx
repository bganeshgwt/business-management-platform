import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { word } from "../../../../services/businessNav";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "./ui";
import { quantity, useOpenBusiness, useOptions, useServerList } from "./hooks";

// Quantity slabs and customer price lists. The highest slab a line reaches
// sets the price of every unit on it; a customer's own slab beats the general one.
export default function PricingPage() {
  const biz = useOpenBusiness();
  const list = useServerList("pricing", { gridId: "business-pricing" });
  const [adding, setAdding] = useState(false);
  const [disabling, setDisabling] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (r) => r.label, mobile: "title", pin: true },
    { key: "customer", header: "For", value: (r) => r.contact_name || "All customers", mobile: "subtitle" },
    { key: "minimum", header: "From quantity", type: "number", value: (r) => Number(r.minimum_quantity), render: (r) => quantity(r.minimum_quantity, r.unit_code || r.unit), mobile: "show" },
    { key: "price", header: "Price", type: "money", exact: true, value: (r) => Number(r.unit_price), render: (r) => `${biz.exact(r.unit_price)} / ${r.unit_code || r.unit}`, mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (r) => (r.active ? "active" : "inactive"), render: (r) => <ActiveBadge active={r.active} /> },
    biz.can("wholesale.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => r.active && <button type="button" className="chip-button" onClick={() => setDisabling(r)}>Switch off</button> },
  ], [biz]);

  const disable = async () => {
    try {
      await businessWrite(biz.id, `pricing/${disabling.id}`, undefined, "delete");
      setNotice("Price switched off. Bills already posted keep their prices.");
      list.reload();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDisabling(null);
    }
  };

  return (
    <div className="stack">
      <BusinessHeader icon="percent" title={word(biz.type, "pricing", "Wholesale prices")}
        description="Lower prices for bigger quantities, for everyone or for one customer, per unit or per pack. A customer's own price comes first, then a price for the pack the line is entered in; the highest slab reached prices every unit on the line."
        actions={biz.can("wholesale.edit") && <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add price</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="list" title="Price slabs">
        <DataGrid {...list.gridProps} caption="Price slabs" columns={columns.filter(Boolean)} currency={biz.symbol} rowNoun={["slab", "slabs"]}
          rowClassName={(r) => (!r.active ? "dg-tone-muted" : "")} empty="No wholesale prices yet" emptyIcon="percent" />
      </SectionCard>
      {adding && <PriceDialog onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setNotice("Price saved."); list.reload(); }} />}
      {disabling && <ConfirmDialog title="Switch off this price?" message={`${disabling.label} from ${quantity(disabling.minimum_quantity, disabling.unit)} for ${disabling.contact_name || "all customers"}.`}
        confirmLabel="Switch off" onConfirm={disable} onCancel={() => setDisabling(null)} />}
    </div>
  );
}

function PriceDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["catalog?active=true", "contacts?kind=customer&active=true"]);
  const [form, setForm] = useState({ skuId: "", contactId: "", unitCode: "", minimumQuantity: "", unitPrice: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value, ...(name === "skuId" ? { unitCode: "" } : {}) }));
  // A slab may be set per pack the item has ("5 cases or more: 2,050 a case").
  const sku = (options?.["catalog?active=true"] || []).find((s) => String(s.id) === form.skuId);
  return (
    <FormDialog title="Add a wholesale price" icon="percent" width={560} onClose={onClose} onSaved={onSaved} disabled={!options}
      onSubmit={() => businessWrite(biz.id, "pricing", { ...form, contactId: form.contactId || undefined, unitCode: form.unitCode || undefined })}>
      <Field label="Item" wide>
        <select required value={form.skuId} onChange={set("skuId")}>
          <option value="">Choose…</option>
          {(options?.["catalog?active=true"] || []).map((s) => <option key={s.id} value={s.id}>{s.label} · {biz.exact(s.price)}</option>)}
        </select>
      </Field>
      <Field label="For" wide>
        <select value={form.contactId} onChange={set("contactId")}>
          <option value="">All customers</option>
          {(options?.["contacts?kind=customer&active=true"] || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Priced per" wide hint={form.unitCode ? "Applies when the line is entered in this pack; the quantity counts packs." : "Counts and prices the item's own unit."}>
        <select value={form.unitCode} onChange={set("unitCode")} disabled={!sku}>
          <option value="">{sku ? sku.unit : "unit"}</option>
          {(sku?.pack_sizes || []).map((p) => <option key={p.unit_code} value={p.unit_code}>{p.unit_code} of {Number(p.quantity_in_base)} {sku.unit}</option>)}
        </select>
      </Field>
      <Field label={`From quantity${form.unitCode ? ` (${form.unitCode})` : ""}`}><input required type="number" min={form.unitCode ? "1" : "0.001"} step={form.unitCode ? "1" : "0.001"} value={form.minimumQuantity} onChange={set("minimumQuantity")} /></Field>
      <Field label={`Price per ${form.unitCode || sku?.unit || "unit"}`}><input required type="number" min="0" step="0.01" value={form.unitPrice} onChange={set("unitPrice")} /></Field>
    </FormDialog>
  );
}
