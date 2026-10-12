import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { word } from "../../../../services/businessNav";
import { dateShort } from "../../../../services/format";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { SIZE_PRESETS, qty, splitList } from "./feFormat";
import "./shared";
import { GstRuleDialog, MarkdownDialog, MarkdownList } from "./fashionParts";

// Size × colour: every product that comes in sizes and colours, and a form
// that creates the whole matrix at once — one SKU per variant with its own
// code, barcode, price and stock.
export default function VariantsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const list = useServerList("fashion/products", { gridId: "fashion-products" });
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [marking, setMarking] = useState(null);
  const [gstOpen, setGstOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [markdowns, setMarkdowns] = useState([]);
  const title = word(biz.type, "variants", "Variants");
  const canMark = biz.has("offers") && biz.can("offers.create");
  // Styles on a markdown now: "30% off" next to their price.
  useEffect(() => {
    if (!biz.has("offers") || !biz.can("offers.view")) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "fashion/markdowns", undefined, controller.signal).then((rows) => setMarkdowns(rows.filter((r) => r.status === "running"))).catch(() => {});
    return () => controller.abort();
  }, [biz, version]);
  const offOf = (p) => markdowns.find((m) => Number(m.product_id) === Number(p.id));

  const columns = useMemo(() => [
    { key: "name", header: "Product", value: (p) => p.name, mobile: "title", pin: true,
      render: (p) => <span className="bz-two-line"><strong>{p.name}</strong><small className="muted">{[p.brand, p.category].filter(Boolean).join(" · ") || "—"}</small></span> },
    { key: "sizes", header: "Sizes", value: (p) => (p.sizes || []).join(", "), mobile: "subtitle" },
    { key: "colors", header: "Colours", value: (p) => (p.colors || []).join(", "), mobile: "show" },
    { key: "variant_count", header: "Variants", type: "number", value: (p) => p.variant_count, total: "sum" },
    { key: "price", header: "Price", type: "money", value: (p) => Number(p.min_price),
      render: (p) => {
        const off = offOf(p);
        const range = Number(p.min_price) === Number(p.max_price) ? biz.exact(p.min_price) : `${biz.exact(p.min_price)} – ${biz.exact(p.max_price)}`;
        return off ? <span className="bz-two-line"><span>{range}</span><small className="fe-markdown">{Number(off.value)}% off till {dateShort(off.ends_on)}</small></span> : range;
      }, mobile: "show" },
    { key: "stock", header: "In stock", type: "number", value: (p) => Number(p.stock), total: "sum", render: (p) => qty(p.stock), mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (p) => (p.active ? "active" : "inactive"), render: (p) => <ActiveBadge active={p.active} />, defaultHidden: true },
  // offOf reads the markdowns loaded above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [biz, markdowns]);

  return (
    <div className="stack">
      <BusinessHeader icon="grid" title={title}
        description="Each size and colour of a product is its own item, with its own code, barcode, price and stock. Open a product to see its stock by size and colour."
        primary={biz.can("catalog.create") && <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> New product with sizes</button>}
        more={biz.can("settings.edit") ? [{ label: "GST on clothing by price", icon: "percent", onClick: () => setGstOpen(true) }] : undefined} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="layers" title="Products with sizes and colours">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Product, brand or category" }} caption="Products with variants" columns={columns}
          currency={biz.symbol} rowNoun={["product", "products"]} onRowClick={(p) => navigate(biz.path(`variants/${p.id}`))}
          rowClassName={(p) => (!p.active ? "dg-tone-muted" : Number(p.stock) <= 0 ? "dg-tone-warning" : "")}
          selectable={canMark} bulkActions={canMark ? (rows, clear) => (
            <button type="button" className="button button-sm" onClick={() => { setMarking(rows); clear(); }}><Icon name="tag" size={14} /> Mark down {rows.length} style{rows.length === 1 ? "" : "s"}</button>
          ) : undefined}
          exportName={biz.can("catalog.export") ? `${biz.business.code}-variants` : undefined}
          empty="No products with sizes yet" emptyHint="Add one: type its sizes and colours and every variant is created." emptyIcon="grid"
          emptyAction={biz.can("catalog.create") && <button type="button" className="button button-secondary" onClick={() => setAdding(true)}>New product with sizes</button>} />
      </SectionCard>
      <MarkdownList version={version} onChanged={() => setVersion((n) => n + 1)} />
      {marking && <MarkdownDialog products={marking} onClose={() => setMarking(null)} onSaved={() => { setMarking(null); setVersion((n) => n + 1); }} />}
      {gstOpen && <GstRuleDialog onClose={() => setGstOpen(false)} onSaved={() => setGstOpen(false)} />}
      {adding && <NewProductDialog onClose={() => setAdding(false)}
        onSaved={(result) => { setAdding(false); setNotice(`${result.product.name}: ${result.created} variants created.`); navigate(biz.path(`variants/${result.product.id}`)); }} />}
    </div>
  );
}

function NewProductDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["tax-rates?active=true", "categories?active=true"]);
  const slabs = options?.["tax-rates?active=true"] || [];
  const categories = options?.["categories?active=true"] || [];
  const fallbackSlab = slabs.find((t) => Number(t.rate) === 5) || slabs.find((t) => t.is_default);
  const [form, setForm] = useState({ name: "", brand: "", codePrefix: "", price: "", taxRateId: "", categoryId: "", sizes: "S, M, L, XL", colors: "", fabrics: "", reorderLevel: "" });
  const [sizePrices, setSizePrices] = useState({});
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const sizes = splitList(form.sizes), colors = splitList(form.colors), fabrics = splitList(form.fabrics);
  const total = sizes.length * colors.length * Math.max(fabrics.length, 1);
  const submit = () => businessWrite(biz.id, "fashion/products", {
    name: form.name, brand: form.brand || undefined, codePrefix: form.codePrefix || undefined, price: form.price,
    taxRateId: form.taxRateId || fallbackSlab?.id, categoryId: form.categoryId || undefined, reorderLevel: form.reorderLevel || undefined,
    sizes, colors, fabrics, sizePrices: Object.fromEntries(Object.entries(sizePrices).filter(([size, price]) => price !== "" && sizes.includes(size))),
  });
  return (
    <FormDialog title="New product with sizes and colours" icon="grid" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={!options}
      submitLabel={total ? `Create ${total} variant${total === 1 ? "" : "s"}` : "Create variants"}
      description="Every size × colour becomes its own item with an in-store barcode (or type the maker's barcodes later). Stock comes in through a purchase.">
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      <Field label="Product name" wide><input required maxLength={120} value={form.name} onChange={set("name")} placeholder="e.g. Oxford cotton shirt" /></Field>
      <Field label="Brand (optional)"><input maxLength={100} value={form.brand} onChange={set("brand")} /></Field>
      <Field label="Code prefix" hint="Codes become PREFIX-COLOUR-SIZE, e.g. OXF-WHI-M."><input maxLength={20} className="mono" value={form.codePrefix} onChange={set("codePrefix")} placeholder="e.g. OXF" /></Field>
      <Field label="Category">
        <select value={form.categoryId} onChange={set("categoryId")}><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}</select>
      </Field>
      <Field label="GST slab">
        <select value={form.taxRateId || String(fallbackSlab?.id || "")} onChange={set("taxRateId")}>{slabs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      </Field>
      <Field label={biz.settings.tax_mode === "inclusive" ? "Price (including GST)" : "Price (before GST)"}><input required type="number" min="0" step="0.01" value={form.price} onChange={set("price")} /></Field>
      <Field label="Reorder level per variant (optional)"><input type="number" min="0" step="1" value={form.reorderLevel} onChange={set("reorderLevel")} /></Field>
      <Field label="Sizes" wide hint="Separate with commas. They are listed S, M, L… and 28, 30, 32… whatever order you type.">
        <input required value={form.sizes} onChange={set("sizes")} />
      </Field>
      <div className="field-wide fe-presets">
        <span className="muted small">Quick sizes:</span>
        {SIZE_PRESETS.map((p) => <button key={p.label} type="button" className="chip-button" onClick={() => setForm((f) => ({ ...f, sizes: p.value }))}>{p.label}</button>)}
      </div>
      <Field label="Colours" wide hint="Separate with commas, e.g. Sky blue, White, Navy."><input required value={form.colors} onChange={set("colors")} /></Field>
      <Field label="Fabrics (optional)" wide hint="Only when the same style comes in more than one fabric."><input value={form.fabrics} onChange={set("fabrics")} placeholder="e.g. Cotton, Linen" /></Field>
      {sizes.length > 0 && (
        <div className="field-wide">
          <span className="fe-label">A different price for some sizes (optional)</span>
          <div className="fe-size-prices">
            {sizes.map((size) => (
              <label key={size} className="field fe-size-price">
                <span>{size}</span>
                <input type="number" min="0" step="0.01" placeholder={form.price || "Same"} value={sizePrices[size] ?? ""} onChange={(e) => setSizePrices((all) => ({ ...all, [size]: e.target.value }))} />
              </label>
            ))}
          </div>
        </div>
      )}
      <p className="field-wide muted small">{total ? `${sizes.length} size${sizes.length === 1 ? "" : "s"} × ${colors.length} colour${colors.length === 1 ? "" : "s"}${fabrics.length ? ` × ${fabrics.length} fabrics` : ""} = ${total} variants.` : "Type at least one size and one colour."}</p>
    </FormDialog>
  );
}
