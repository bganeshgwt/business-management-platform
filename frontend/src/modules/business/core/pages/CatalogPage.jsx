import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { word } from "../../../../services/businessNav";
import FormDialog from "./FormDialog";
import { ActiveBadge, BusinessHeader, Field, FormError } from "./ui";
import { quantity, useOpenBusiness, useOptions, useServerList } from "./hooks";
import { inPacks, packOf } from "../../wholesale/pages/tradeFormat";

// Extra details a product may carry, by the module that allows them.
const ATTRIBUTES = {
  variants: [["size", "Size"], ["color", "Colour"], ["fabric", "Fabric"]],
  books: [["isbn", "ISBN"], ["author", "Author"], ["publisher", "Publisher"]],
  serials: [["model", "Model"], ["warrantyMonths", "Warranty (months)"]],
  batches: [["manufacturer", "Manufacturer"], ["packDescription", "Pack description"]],
};
const TRACKING = { none: "Not stocked", quantity: "Quantity", batch: "Batch & expiry", serial: "Serial / IMEI" };

export default function CatalogPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const [category, setCategory] = useState("");
  const { options } = useOptions(["categories?active=true"]);
  const categories = options?.["categories?active=true"] || [];
  const list = useServerList("catalog", { gridId: "business-catalog", params: category ? { category } : {} });
  const [editing, setEditing] = useState(() => (params.get("new") === "1" && biz.can("catalog.create") ? {} : null));
  const [notice, setNotice] = useState("");
  const title = word(biz.type, "products", "Products & services");
  useEffect(() => {
    if (params.get("new")) setParams({}, { replace: true });
  }, [params, setParams]);

  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (s) => s.label, mobile: "title", pin: true,
      render: (s) => <span className="bz-two-line"><strong>{s.label}</strong>{s.product_name !== s.label && <small className="muted">{s.product_name}</small>}</span> },
    { key: "code", header: "SKU", value: (s) => s.code, className: "mono", mobile: "subtitle" },
    { key: "barcode", header: "Barcode", value: (s) => s.barcode || "", className: "mono", defaultHidden: true },
    { key: "category", header: "Category", value: (s) => s.category || "" },
    { key: "price", header: biz.settings.tax_mode === "inclusive" ? "Price (incl. tax)" : "Price", type: "money", exact: true, value: (s) => Number(s.price), mobile: "show" },
    { key: "mrp", header: "MRP", type: "money", exact: true, value: (s) => (s.mrp === null || s.mrp === undefined ? null : Number(s.mrp)), defaultHidden: biz.type === "salon" || biz.type === "healthcare" },
    { key: "tax", header: "GST", value: (s) => s.tax_rate_name || `${Number(s.tax_rate)}%` },
    { key: "hsn", header: "HSN / SAC", value: (s) => s.hsn_code || "", className: "mono", defaultHidden: true },
    { key: "unit", header: "Unit", value: (s) => s.unit_name || s.unit },
    { key: "tracking", header: "Stock tracking", value: (s) => TRACKING[s.tracking], defaultHidden: true },
    { key: "stock", header: "In stock", type: "number", value: (s) => (s.kind === "service" ? null : Number(s.stock)), render: (s) => (s.kind === "service" ? <span className="muted">Service</span> : quantity(s.stock, s.unit)), mobile: "show" },
    // Pro pass D-12: the case price and stock in cases, for goods sold by the pack.
    { key: "case_price", header: "Pack price", type: "money", exact: true, defaultHidden: !biz.has("sales_orders"),
      value: (s) => (packOf(s) ? Number(s.price) * packOf(s).factor : null), render: (s) => (packOf(s) ? `${biz.exact(Number(s.price) * packOf(s).factor)} / ${packOf(s).unit}` : <span className="muted">—</span>) },
    { key: "in_packs", header: "In packs", defaultHidden: !biz.has("sales_orders"), value: (s) => (packOf(s) ? inPacks(s.stock, s.unit, packOf(s).unit, packOf(s).factor) : ""),
      render: (s) => (packOf(s) && s.kind !== "service" ? inPacks(s.stock, s.unit, packOf(s).unit, packOf(s).factor) : <span className="muted">—</span>) },
    { key: "active", header: "Status", type: "status", value: (s) => (s.active ? "active" : "inactive"), render: (s) => <ActiveBadge active={s.active} /> },
    biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => <button type="button" className="chip-button" onClick={() => setEditing(s)}>Edit</button> },
  ], [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="tag" title={title}
        description="Everything you sell, with its price, GST slab, category and stock. Changing a price never changes a bill already posted."
        actions={biz.can("catalog.create") && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add item</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="All items">
        <DataGrid {...list.gridProps} caption={title} columns={columns.filter(Boolean)} currency={biz.symbol}
          toolbar={categories.length > 0 && (
            <label className="field">
              <span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
              </select>
            </label>
          )}
          exportName={biz.can("catalog.export") ? `${biz.business.code}-catalogue` : undefined}
          rowClassName={(s) => (!s.active ? "dg-tone-muted" : s.kind === "goods" && Number(s.reorder_level) > 0 && Number(s.stock) <= Number(s.reorder_level) ? "dg-tone-warning" : "")}
          empty="Nothing in the catalogue yet" emptyIcon="tag" />
      </SectionCard>
      {editing && <CatalogDialog sku={editing} onClose={() => setEditing(null)}
        onSaved={(s) => { setEditing(null); setNotice(`${s.label} saved.`); list.reload(); }} />}
    </div>
  );
}

function CatalogDialog({ sku, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(sku.id);
  const { options, error } = useOptions(["units?active=true", "tax-rates?active=true", "categories?active=true", ...(biz.has("variants") && !editing ? ["catalog"] : [])]);
  const units = options?.["units?active=true"] || [];
  const slabs = options?.["tax-rates?active=true"] || [];
  const categories = options?.["categories?active=true"] || [];
  const services = biz.type === "healthcare" || !biz.has("inventory");
  const [form, setForm] = useState(() => ({
    name: "", productId: "", label: sku.label || "", code: "", barcode: sku.barcode || "", kind: sku.kind || (services ? "service" : "goods"), unit: services ? "service" : "each",
    tracking: biz.type === "pharmacy" ? "batch" : "quantity", price: sku.price || "", taxRateId: sku.tax_rate_id ? String(sku.tax_rate_id) : "",
    categoryId: sku.category_id ? String(sku.category_id) : "", brand: "", reorderLevel: sku.reorder_level ? String(Number(sku.reorder_level)) : "", active: sku.active ?? true,
    mrp: sku.mrp ? String(Number(sku.mrp)) : "", hsnCode: sku.hsn_code || "",
    // Pro pass C-17: stock already on the shelf when the item is added.
    openingQuantity: "", openingCost: "", openingLocation: String(biz.locations.find((l) => l.active)?.id || ""), openingLot: "", openingExpiry: "",
  }));
  const canOpening = !editing && biz.has("inventory") && biz.can("inventory.edit");
  const set = (name) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [name]: value, ...(name === "kind" ? { unit: value === "service" ? "service" : "each" } : {}) }));
  };
  const defaultSlab = slabs.find((t) => t.is_default);
  const taxRateId = form.taxRateId || (editing ? "" : String(defaultSlab?.id || ""));
  const attributeFields = biz.context.capabilities.flatMap((cap) => ATTRIBUTES[cap] || []);
  const unitChoices = units.filter((u) => (form.kind === "service" ? ["time", "service"].includes(u.kind) : !["time", "service"].includes(u.kind)));
  const products = [...new Map((options?.catalog || []).map((s) => [s.product_id, s.product_name])).entries()];

  const submit = () => (editing
    ? businessWrite(biz.id, `catalog/${sku.id}`, { label: form.label, price: form.price, taxRateId: taxRateId || undefined, taxRate: taxRateId ? undefined : sku.tax_rate,
      categoryId: form.categoryId || null, reorderLevel: form.reorderLevel || 0, active: form.active, mrp: form.mrp, hsnCode: form.hsnCode, barcode: form.barcode }, "patch")
    : businessWrite(biz.id, "catalog", {
      ...form, taxRateId: taxRateId || undefined, categoryId: form.categoryId || undefined, productId: form.productId || undefined, reorderLevel: form.reorderLevel || 0,
      attributes: Object.fromEntries(attributeFields.map(([key]) => [key, form[key] || ""])),
      ...(canOpening && form.kind === "goods" && form.tracking !== "serial" && Number(form.openingQuantity) > 0 ? { openingStock: {
        quantity: form.openingQuantity, unitCost: form.openingCost || "0", locationId: form.openingLocation,
        ...(form.tracking === "batch" ? { lotCode: form.openingLot, expiresOn: form.openingExpiry || undefined } : {}),
      } } : {}),
    }));

  return (
    <FormDialog title={editing ? `Edit ${sku.label}` : "Add an item"} icon="tag" width={720} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={!options}>
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      {!editing && (
        <>
          <Field label="Product name" wide><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
          {biz.has("variants") && products.length > 0 && (
            <Field label="Variant of (optional)" hint="Pick a product to add this as one of its sizes or colours." wide>
              <select value={form.productId} onChange={set("productId")}>
                <option value="">A new product</option>
                {products.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Name on the bill (optional)" hint="For a variant: e.g. “Blue / M”."><input maxLength={150} value={form.label} onChange={set("label")} /></Field>
          <Field label="SKU code"><input required maxLength={60} value={form.code} onChange={set("code")} className="mono" /></Field>
          <Field label="Barcode (optional)"><input maxLength={80} value={form.barcode} onChange={set("barcode")} className="mono" /></Field>
          <Field label="Kind">
            <select value={form.kind} onChange={set("kind")}>
              {biz.has("inventory") && <option value="goods">Goods (kept in stock)</option>}
              <option value="service">Service</option>
            </select>
          </Field>
          <Field label="Stock unit">
            <select required value={form.unit} onChange={set("unit")}>
              {unitChoices.map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}
            </select>
          </Field>
          {form.kind === "goods" && (
            <Field label="Stock tracking">
              <select value={form.tracking} onChange={set("tracking")}>
                <option value="quantity">Quantity only</option>
                {biz.has("batches") && <option value="batch">Batch & expiry</option>}
                {biz.has("serials") && <option value="serial">Serial / IMEI number</option>}
              </select>
            </Field>
          )}
          <Field label="Brand (optional)"><input maxLength={100} value={form.brand} onChange={set("brand")} /></Field>
        </>
      )}
      {editing && <Field label="Name on the bill" wide><input required maxLength={150} value={form.label} onChange={set("label")} /></Field>}
      {editing && sku.kind !== "service" && (
        <Field label="Barcode (optional)" hint={sku.barcode ? "Change it to the code printed on the pack, or clear it. Two items never share one." : "The code printed on the pack; scanning it bills this item."}>
          <input maxLength={80} value={form.barcode} onChange={set("barcode")} className="mono" />
        </Field>
      )}
      <Field label={biz.settings.tax_mode === "inclusive" ? "Selling price (including GST)" : "Selling price (before GST)"}
        hint={editing && packOf(sku) && Number(form.price) > 0 ? `${biz.exact(Number(form.price) * packOf(sku).factor)} a ${packOf(sku).unit} of ${packOf(sku).factor}` : undefined}>
        <input required type="number" min="0" step="0.01" value={form.price} onChange={set("price")} />
      </Field>
      {form.kind === "goods" && (
        <Field label="MRP (optional)" hint="Printed on the pack, GST included. The item is never billed above it.">
          <input type="number" min="0" step="0.01" value={form.mrp} onChange={set("mrp")} />
        </Field>
      )}
      <Field label="GST slab">
        <select value={taxRateId} onChange={set("taxRateId")}>
          {editing && !sku.tax_rate_id && <option value="">{Number(sku.tax_rate)}% (no slab)</option>}
          {slabs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      <Field label={form.kind === "service" ? "SAC code (optional)" : "HSN code (optional)"} hint="4, 6 or 8 digits, printed on the tax invoice.">
        <input inputMode="numeric" pattern="[0-9]{4}([0-9]{2}){0,2}" title="4, 6 or 8 digits" maxLength={8} value={form.hsnCode} onChange={set("hsnCode")} className="mono" />
      </Field>
      <Field label="Category">
        <select value={form.categoryId} onChange={set("categoryId")}>
          <option value="">None</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
        </select>
      </Field>
      {form.kind === "goods" && <Field label="Reorder level" hint="Shown as low on stock at or below this."><input type="number" min="0" step="0.001" value={form.reorderLevel} onChange={set("reorderLevel")} /></Field>}
      {canOpening && form.kind === "goods" && form.tracking !== "serial" && (
        <div className="bz-opening" role="group" aria-labelledby="opening-stock-title">
          <p className="bz-opening-title" id="opening-stock-title"><strong>Opening stock</strong> <span className="muted">(optional)</span></p>
          <p className="muted small">What is already on the shelf. It goes into stock at once, with “Opening stock” as the reason in the stock movements.</p>
          <div className="bz-opening-grid">
            <Field label={`Quantity (${form.unit})`}><input type="number" min="0" step="0.001" value={form.openingQuantity} onChange={set("openingQuantity")} /></Field>
            <Field label="Cost price (each, optional)" hint="What you paid; it values the stock."><input type="number" min="0" step="0.01" value={form.openingCost} onChange={set("openingCost")} /></Field>
            {biz.locations.filter((l) => l.active).length > 1 && (
              <Field label="At">
                <select value={form.openingLocation} onChange={set("openingLocation")}>
                  {biz.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            )}
            {form.tracking === "batch" && (
              <>
                <Field label="Batch number"><input maxLength={100} required={Number(form.openingQuantity) > 0} value={form.openingLot} onChange={set("openingLot")} className="mono" /></Field>
                <Field label="Expiry date (optional)"><input type="date" value={form.openingExpiry} onChange={set("openingExpiry")} /></Field>
              </>
            )}
          </div>
        </div>
      )}
      {!editing && attributeFields.map(([key, label]) => (
        <Field key={key} label={label}><input maxLength={150} value={form[key] || ""} onChange={set(key)} /></Field>
      ))}
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active (switched-off items cannot be sold)</label>}
    </FormDialog>
  );
}
