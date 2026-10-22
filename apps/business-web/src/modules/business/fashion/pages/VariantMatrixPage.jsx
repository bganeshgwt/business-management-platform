import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { labelOf, qty, splitList, refuse } from "./feFormat";
import { MarkdownDialog, MarkdownList } from "./fashionParts";
import "./shared";

// One style's matrix: stock by colour (rows) and size (columns) at one
// location or all. Pro pass: the price shows once per size (a cell shows its
// own only when it differs); tapping a cell opens what can be done with that
// variant (price, reorder level, barcode, labels, receive, sales); on a phone
// the grid stays a grid that scrolls sideways with the colours pinned.
// Receiving takes a cost per size, the supplier's bill, several styles on one
// receipt, and offers the labels for what arrived.

// Rows of a matrix: one per colour (and fabric), cells keyed by size.
function matrixRows(data) {
  const map = new Map();
  for (const v of data?.variants || []) {
    const key = `${v.color.toLowerCase()}|${(v.fabric || "").toLowerCase()}`;
    const row = map.get(key) || { key, color: v.color, fabric: v.fabric || "", cells: {}, total: 0 };
    row.cells[v.size.toLowerCase()] = v;
    row.total += Number(v.stock);
    map.set(key, row);
  }
  const order = (data?.colors || []).map((c) => c.toLowerCase());
  return [...map.values()].sort((a, b) => order.indexOf(a.color.toLowerCase()) - order.indexOf(b.color.toLowerCase()) || a.fabric.localeCompare(b.fabric));
}
// The price of a size when every colour has the same one (else null).
function sizePrice(data, size) {
  const prices = [...new Set((data?.variants || []).filter((v) => v.size.toLowerCase() === size.toLowerCase()).map((v) => Number(v.price)))];
  return prices.length === 1 ? prices[0] : null;
}

export default function VariantMatrixPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const { productId } = useParams();
  const [params, setParams] = useSearchParams();
  const [location, setLocation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(() => (params.get("receive") ? { kind: "receive" } : null));
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `fashion/products/${productId}`, location ? { locationId: location } : undefined, controller.signal)
      .then((result) => { setData(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, productId, location, version]);

  const variants = useMemo(() => data?.variants || [], [data]);
  const sizes = useMemo(() => data?.sizes || [], [data]);
  const rows = useMemo(() => matrixRows(data), [data]);
  const fabrics = (data?.fabrics || []).length > 0;

  const variantColumns = useMemo(() => [
    { key: "label", header: "Variant", value: (v) => `${v.color} / ${v.size}${v.fabric ? ` / ${v.fabric}` : ""}`, mobile: "title", pin: true },
    { key: "code", header: "SKU code", value: (v) => v.code, className: "mono", mobile: "subtitle" },
    { key: "barcode", header: "Barcode", value: (v) => v.barcode || "", className: "mono" },
    { key: "price", header: "Price", type: "money", exact: true, value: (v) => Number(v.price), mobile: "show" },
    { key: "stock", header: location ? "In stock here" : "In stock", type: "number", value: (v) => Number(v.stock), total: "sum", render: (v) => qty(v.stock), mobile: "show" },
    biz.locations.length > 1 && !location && { key: "where", header: "Where", value: (v) => Object.entries(v.stock_by_location || {}).map(([id, q]) => `${biz.locations.find((l) => String(l.id) === id)?.name || id}: ${qty(q)}`).join(" · ") },
    { key: "active", header: "Status", type: "status", value: (v) => (v.active ? "active" : "inactive"), render: (v) => <ActiveBadge active={v.active} />, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (v) => <button type="button" className="chip-button" onClick={() => setDialog({ kind: "cell", variant: v })}>Open</button> },
  ].filter(Boolean), [biz, location]);

  if (!data) {
    return <div className="stack"><BusinessHeader icon="grid" title="Size × colour" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  }
  const units = variants.reduce((s, v) => s + Number(v.stock), 0);
  const prices = variants.map((v) => Number(v.price));
  const tracked = variants[0]?.tracking;
  const done = (message) => { setDialog(null); if (message) toast.success(message); setVersion((n) => n + 1); if (params.get("receive")) setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true }); };
  const labelsFor = (list) => navigate(biz.path("labels"), { state: { labels: list, template: "garment" } });
  const allLabels = () => labelsFor(variants.filter((v) => Number(v.stock) > 0).map((v) => labelOf(v, data.product, Math.max(1, Math.round(Number(v.stock))))));
  const more = [
    biz.can("catalog.create") && { label: "Add sizes or colours", icon: "plus", onClick: () => setDialog({ kind: "add" }) },
    biz.can("catalog.edit") && { label: "Set prices by size or colour", icon: "tag", onClick: () => setDialog({ kind: "prices" }) },
    biz.can("catalog.edit") && { label: "Type the maker's barcodes", icon: "qr", onClick: () => setDialog({ kind: "barcodes" }) },
    biz.has("offers") && biz.can("offers.create") && { label: "Mark down this style", icon: "percent", onClick: () => setDialog({ kind: "markdown" }) },
  ].filter(Boolean);
  return (
    <div className="stack">
      <BusinessHeader icon="grid" title={data.product.name}
        description={[data.product.brand, data.product.category_name, `${sizes.length} sizes × ${(data.colors || []).length} colours${fabrics ? ` × ${data.fabrics.length} fabrics` : ""}`].filter(Boolean).join(" · ")}
        primary={biz.can("purchasing.create") && <button type="button" className="button" onClick={() => setDialog({ kind: "receive" })}><Icon name="truck" size={15} /> Receive stock</button>}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("variants")}><Icon name="arrow-left" size={15} /> All styles</Link>
            {biz.can("catalog.print") && <button type="button" className="button button-secondary" disabled={!units} onClick={allLabels}><Icon name="print" size={15} /> Tags for stock</button>}
          </>
        )}
        more={more} />
      <ErrorMessage message={error} />
      <div className="stat-grid">
        <StatTile icon="layers" label="Variants" value={variants.length} />
        <StatTile icon="box" tone={units > 0 ? "primary" : "warning"} label={location ? "Pieces here" : "Pieces in stock"} value={qty(units)} />
        <StatTile icon="alert" tone={variants.some((v) => Number(v.stock) <= 0) ? "warning" : "neutral"} label="Sold out" value={variants.filter((v) => Number(v.stock) <= 0).length} note="sizes and colours" />
        <StatTile icon="tag" label="Price" value={Math.min(...prices) === Math.max(...prices) ? biz.exact(prices[0]) : `${biz.amount(Math.min(...prices))}–${biz.amount(Math.max(...prices))}`} />
      </div>
      <MarkdownList productId={data.product.id} version={version} onChanged={() => setVersion((n) => n + 1)} />
      <SectionCard flush icon="grid" title="Stock by size and colour" description="Tap a size to change its price, reorder level or barcode, print its tags or receive it. Red: none left; amber: at or below the reorder level."
        actions={biz.locations.length > 1 && (
          <label className="field fe-inline-field">
            <span>Location</span>
            <select value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">All locations</option>
              {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}>
        <div className="fe-matrix-wrap">
          <table className="fe-matrix">
            <caption className="sr-only">{data.product.name}: stock by size and colour</caption>
            <thead>
              <tr>
                <th scope="col" className="fe-matrix-colour">{fabrics ? "Colour · fabric" : "Colour"}</th>
                {sizes.map((size) => {
                  const price = sizePrice(data, size);
                  return <th scope="col" key={size}><strong>{size}</strong><small>{price !== null ? biz.exact(price) : "prices vary"}</small></th>;
                })}
                <th scope="col">All</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className="fe-matrix-colour">{row.color}{row.fabric && <small>{row.fabric}</small>}</th>
                  {sizes.map((size) => {
                    const v = row.cells[size.toLowerCase()];
                    if (!v) return <td key={size} className="fe-matrix-none" title="Not made in this size and colour">—</td>;
                    const stock = Number(v.stock);
                    const tone = stock <= 0 ? "is-out" : Number(v.reorder_level) > 0 && stock <= Number(v.reorder_level) ? "is-low" : "";
                    const own = sizePrice(data, size) === null;
                    return (
                      <td key={size}>
                        <button type="button" className={`fe-matrix-cell ${tone} ${v.active ? "" : "is-off"}`} onClick={() => setDialog({ kind: "cell", variant: v })}
                          aria-label={`${row.color} ${size}: ${qty(stock)} in stock, ${biz.exact(v.price)}. Open`}>
                          <strong>{qty(stock)}</strong>{own && <small>{biz.exact(v.price)}</small>}
                        </button>
                      </td>
                    );
                  })}
                  <td className="fe-matrix-total">{qty(row.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="fe-matrix-colour">All colours</th>
                {sizes.map((size) => <td key={size} className="fe-matrix-total">{qty(rows.reduce((s, r) => s + Number(r.cells[size.toLowerCase()]?.stock || 0), 0))}</td>)}
                <td className="fe-matrix-total">{qty(units)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </SectionCard>
      <SectionCard flush icon="list" title="Every variant" description="Scan a barcode at Quick bill to sell the exact size and colour.">
        <DataGrid id="fashion-variant-list" caption="Variants" columns={variantColumns} rows={variants} rowKey={(v) => v.sku_id} currency={biz.symbol}
          rowNoun={["variant", "variants"]} rowClassName={(v) => (!v.active ? "dg-tone-muted" : Number(v.stock) <= 0 ? "dg-tone-danger" : "")}
          exportName={biz.can("catalog.export") ? `${biz.business.code}-variants-${productId}` : undefined} />
      </SectionCard>
      {dialog?.kind === "receive" && <ReceiveDialog data={data} tracked={tracked} onClose={() => done()} onSaved={(r) => { done(`Received on ${r.doc.document_no}: ${qty(r.pieces)} pieces.`); setDialog({ kind: "received", result: r }); }} />}
      {dialog?.kind === "received" && <ReceivedDialog result={dialog.result} onLabels={() => labelsFor(dialog.result.labels)} onClose={() => setDialog(null)} />}
      {dialog?.kind === "add" && <AddDialog data={data} onClose={() => setDialog(null)} onSaved={(r) => done(`${r.created} new variant${r.created === 1 ? "" : "s"} added.`)} />}
      {dialog?.kind === "prices" && <PricesDialog data={data} onClose={() => setDialog(null)} onSaved={(r) => done(`Price set on ${r.updated} variant${r.updated === 1 ? "" : "s"}.`)} />}
      {dialog?.kind === "barcodes" && <BarcodesDialog data={data} rows={rows} onClose={() => setDialog(null)} onSaved={(r) => done(`${r.updated} barcode${r.updated === 1 ? "" : "s"} saved.`)} />}
      {dialog?.kind === "markdown" && <MarkdownDialog products={[{ id: data.product.id, name: data.product.name, min_price: Math.min(...prices) }]} onClose={() => setDialog(null)} onSaved={() => done()} />}
      {dialog?.kind === "cell" && <CellDialog variant={dialog.variant} product={data.product} onClose={() => setDialog(null)}
        onEdit={() => setDialog({ kind: "variant", variant: dialog.variant })} onReceive={() => setDialog({ kind: "receive" })}
        onLabels={(n) => labelsFor([labelOf(dialog.variant, data.product, n)])} />}
      {dialog?.kind === "variant" && <VariantDialog variant={dialog.variant} productId={data.product.id} onClose={() => setDialog(null)} onSaved={() => done("Variant saved.")} />}
    </div>
  );
}

// What can be done with one size and colour.
function CellDialog({ variant, product, onClose, onEdit, onReceive, onLabels }) {
  const biz = useOpenBusiness();
  const [copies, setCopies] = useState(String(Math.max(1, Math.round(Number(variant.stock)) || 1)));
  const where = Object.entries(variant.stock_by_location || {}).map(([id, q]) => `${biz.locations.find((l) => String(l.id) === id)?.name || id}: ${qty(q)}`).join(" · ");
  return (
    <Modal title={`${variant.color} / ${variant.size}${variant.fabric ? ` / ${variant.fabric}` : ""}`} icon="tag" width={520} onClose={onClose} description={`${product.name} · ${variant.code}`}>
      <div className="stack">
        <dl className="fe-facts">
          <dt>In stock</dt><dd>{qty(variant.stock)}{where && biz.locations.length > 1 ? ` (${where})` : ""}</dd>
          <dt>Price</dt><dd>{biz.exact(variant.price)}{variant.mrp ? ` · MRP ${biz.exact(variant.mrp)}` : ""}</dd>
          <dt>Reorder at</dt><dd>{Number(variant.reorder_level) > 0 ? qty(variant.reorder_level) : "Not set"}</dd>
          <dt>Barcode</dt><dd className="mono">{variant.barcode || "None"}</dd>
        </dl>
        <div className="fe-cell-actions">
          {biz.can("catalog.edit") && <button type="button" className="button" onClick={onEdit}><Icon name="edit" size={15} /> Price, reorder, barcode</button>}
          {biz.can("purchasing.create") && <button type="button" className="button button-secondary" onClick={onReceive}><Icon name="truck" size={15} /> Receive</button>}
          {biz.can("reports.view") && <Link className="button button-secondary" to={`${biz.path("variant-reports")}?productId=${product.id}`}><Icon name="chart" size={15} /> How it sells</Link>}
          {biz.can("inventory.view") && biz.locations.length > 1 && <Link className="button button-secondary" to={biz.path("transfers")}><Icon name="truck" size={15} /> Move stock</Link>}
        </div>
        {biz.can("catalog.print") && (
          <div className="fe-inline-row">
            <Field label="Tags to print"><input type="number" min="1" max="500" step="1" value={copies} onChange={(e) => setCopies(e.target.value)} /></Field>
            <button type="button" className="button button-secondary" disabled={!(Number(copies) > 0)} onClick={() => onLabels(Math.floor(Number(copies)))}><Icon name="print" size={15} /> Print tags</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// After a receipt: the tags for what arrived, one click away.
function ReceivedDialog({ result, onLabels, onClose }) {
  const biz = useOpenBusiness();
  return (
    <Modal title={`Received on ${result.doc.document_no}`} icon="check" width={480} onClose={onClose}
      description={`${qty(result.pieces)} pieces from ${result.styles} style${result.styles === 1 ? "" : "s"}${result.doc.supplier_bill_no ? ` · supplier bill ${result.doc.supplier_bill_no}` : ""}.`}>
      <div className="form-actions bz-start">
        {biz.can("catalog.print") && <button type="button" className="button" onClick={onLabels}><Icon name="print" size={15} /> Print {qty(result.pieces)} tags</button>}
        <button type="button" className="button button-secondary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

// Purchase entry in the shape of the matrix: pieces per size and colour, a
// cost per size, several styles on one supplier bill.
function ReceiveDialog({ data, tracked, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["contacts?kind=supplier&active=true"]);
  const suppliers = options?.["contacts?kind=supplier&active=true"] || [];
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ contactId: "", locationId: String(locations[0]?.id || ""), billNo: "", billDate: businessToday(biz.business.timezone), notes: "" });
  const [styles, setStyles] = useState([{ data, quantities: {}, costs: {} }]);
  const [adding, setAdding] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const update = (index, patch) => setStyles((all) => all.map((s, i) => (i === index ? { ...s, ...patch(s) } : s)));
  const lines = styles.flatMap((s) => s.data.variants.filter((v) => Number(s.quantities[v.sku_id]) > 0)
    .map((v) => ({ v, s, quantity: s.quantities[v.sku_id], cost: s.costs[v.size.toLowerCase()] })));
  const pieces = lines.reduce((sum, l) => sum + Number(l.quantity), 0);
  const value = lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.cost || 0), 0);
  const addStyle = async (product) => {
    if (!product) return;
    if (styles.some((s) => String(s.data.product.id) === String(product.id))) { setAdding(false); return; }
    const matrix = await businessRead(biz.id, `fashion/products/${product.id}`);
    setStyles((all) => [...all, { data: matrix, quantities: {}, costs: {} }]);
    setAdding(false);
  };
  const submit = () => {
    if (!lines.length) return Promise.reject(refuse("Type how many pieces arrived in at least one size and colour."));
    const missing = lines.find((l) => !(Number(l.cost) >= 0) || l.cost === "" || l.cost === undefined);
    if (missing) return Promise.reject(refuse(`Type the cost for size ${missing.v.size} of ${missing.s.data.product.name}.`));
    return businessWrite(biz.id, "documents", { kind: "purchase", locationId: form.locationId, contactId: form.contactId, requestKey, notes: form.notes || undefined,
      ...(form.billNo.trim() ? { supplierBillNo: form.billNo.trim(), supplierBillDate: form.billDate || undefined } : {}),
      lines: lines.map((l) => ({ skuId: l.v.sku_id, quantity: String(l.quantity), unitPrice: String(l.cost) })) })
      .then((doc) => ({ doc, pieces, styles: new Set(lines.map((l) => l.s.data.product.id)).size,
        labels: lines.map((l) => labelOf(l.v, l.s.data.product, Number(l.quantity))) }));
  };
  if (tracked && tracked !== "quantity") {
    return (
      <FormDialog title="Receive stock" icon="truck" hideSubmit onClose={onClose} onSubmit={async () => {}}>
        <p className="field-wide">These variants carry a {tracked === "serial" ? "serial number" : "batch"} on every piece. Receive them under Purchases, where each line takes its {tracked === "serial" ? "serial" : "batch"}.</p>
      </FormDialog>
    );
  }
  return (
    <FormDialog title="Receive stock" icon="truck" width={1040} onClose={onClose} onSaved={onSaved} onSubmit={submit} disabled={!options}
      submitLabel={pieces ? `Receive ${qty(pieces)} piece${pieces === 1 ? "" : "s"} · ${biz.exact(value)}` : "Receive"}
      description="Type how many of each size and colour arrived and the cost of each size (before GST). Add more styles from the same supplier bill below.">
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      <Field label="Supplier">
        <select required value={form.contactId} onChange={set("contactId")}><option value="">Choose…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </Field>
      <Field label="Location">
        <select required value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
      </Field>
      <Field label="Supplier bill number (optional)"><input maxLength={60} value={form.billNo} onChange={set("billNo")} placeholder="e.g. KM/4471" /></Field>
      <Field label="Bill date"><input type="date" max={businessToday(biz.business.timezone)} value={form.billDate} onChange={set("billDate")} /></Field>
      {styles.map((style, index) => (
        <div className="field-wide fe-receive-style" key={style.data.product.id}>
          <div className="fe-receive-head">
            <h3 className="fe-subhead"><Icon name="grid" size={15} /> {style.data.product.name}</h3>
            {index > 0 && <button type="button" className="link-button danger" onClick={() => setStyles((all) => all.filter((_, i) => i !== index))}>Remove style</button>}
          </div>
          <ReceiveGrid style={style} onQuantity={(skuId, value) => update(index, (s) => ({ quantities: { ...s.quantities, [skuId]: value } }))}
            onCost={(size, value) => update(index, (s) => ({ costs: { ...s.costs, [size.toLowerCase()]: value } }))}
            onAllCosts={(value) => update(index, (s) => ({ costs: Object.fromEntries(s.data.sizes.map((z) => [z.toLowerCase(), value])) }))} />
        </div>
      ))}
      <div className="field-wide">
        {adding ? (
          <SearchPicker label="Another style on this bill" autoFocus placeholder="Style name" onChange={(p) => addStyle(p).catch(() => setAdding(false))}
            search={(q, { signal }) => businessRead(biz.id, "fashion/products", { q, limit: 12 }, signal).then((page) => page.items)}
            getLabel={(p) => p.name} getDescription={(p) => `${(p.sizes || []).join(", ")} · ${(p.colors || []).join(", ")}`} />
        ) : <button type="button" className="button button-secondary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add another style</button>}
      </div>
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function ReceiveGrid({ style, onQuantity, onCost, onAllCosts }) {
  const { data, quantities, costs } = style;
  const rows = matrixRows(data);
  return (
    <div className="fe-matrix-wrap">
      <table className="fe-matrix is-entry">
        <thead>
          <tr>
            <th scope="col" className="fe-matrix-colour">Colour</th>
            {data.sizes.map((size) => <th scope="col" key={size}>{size}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr className="fe-matrix-costs">
            <th scope="row" className="fe-matrix-colour">Cost each
              <input aria-label="Cost for every size" type="number" min="0" step="0.01" placeholder="All sizes" onChange={(e) => onAllCosts(e.target.value)} /></th>
            {data.sizes.map((size) => (
              <td key={size}><input aria-label={`Cost of size ${size}`} type="number" min="0" step="0.01" placeholder="₹" value={costs[size.toLowerCase()] ?? ""} onChange={(e) => onCost(size, e.target.value)} /></td>
            ))}
          </tr>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="fe-matrix-colour">{row.color}{row.fabric && <small>{row.fabric}</small>}</th>
              {data.sizes.map((size) => {
                const v = row.cells[size.toLowerCase()];
                if (!v) return <td key={size} className="fe-matrix-none">—</td>;
                return <td key={size}><input aria-label={`${row.color} ${size} pieces`} type="number" min="0" step="1" placeholder="0" value={quantities[v.sku_id] ?? ""} onChange={(e) => onQuantity(v.sku_id, e.target.value)} /></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddDialog({ data, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ sizes: "", colors: "", fabrics: "", price: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Add sizes or colours" icon="plus" width={620} onClose={onClose} onSaved={onSaved} submitLabel="Add variants"
      description={`Now: ${data.sizes.join(", ")} in ${data.colors.join(", ")}. Every missing combination is created; a new colour takes each size's current price.`}
      onSubmit={() => businessWrite(biz.id, `fashion/products/${data.product.id}/variants`, { sizes: splitList(form.sizes), colors: splitList(form.colors), fabrics: splitList(form.fabrics), price: form.price || undefined })}>
      <Field label="New sizes" wide hint="Separate with commas."><input value={form.sizes} onChange={set("sizes")} placeholder="e.g. XXL, 3XL" /></Field>
      <Field label="New colours" wide hint="Separate with commas."><input value={form.colors} onChange={set("colors")} placeholder="e.g. Olive, Black" /></Field>
      {data.fabrics.length > 0 && <Field label="New fabrics" wide><input value={form.fabrics} onChange={set("fabrics")} /></Field>}
      <Field label="Price for the new sizes" hint="Not needed for new colours."><input type="number" min="0" step="0.01" value={form.price} onChange={set("price")} /></Field>
    </FormDialog>
  );
}

function PricesDialog({ data, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [price, setPrice] = useState("");
  const [sizes, setSizes] = useState([]);
  const [colors, setColors] = useState([]);
  const toggle = (list, setList, value) => setList(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  const matching = data.variants.filter((v) => (!sizes.length || sizes.includes(v.size)) && (!colors.length || colors.includes(v.color))).length;
  return (
    <FormDialog title="Set prices" icon="tag" width={620} onClose={onClose} onSaved={onSaved} submitLabel={`Set price on ${matching} variant${matching === 1 ? "" : "s"}`}
      description="Pick sizes and/or colours (none picked means all), then the price. Bills already posted keep their prices. For a sale with an end date, use Mark down instead."
      onSubmit={() => businessWrite(biz.id, `fashion/products/${data.product.id}/prices`, { price, sizes, colors }, "put")}>
      <Field label={biz.settings.tax_mode === "inclusive" ? "New price (including GST)" : "New price (before GST)"}><input required type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
      <fieldset className="field-wide bz-plain-fieldset">
        <legend>Sizes</legend>
        <div className="fe-checks">{data.sizes.map((s) => <label key={s} className="checkbox"><input type="checkbox" checked={sizes.includes(s)} onChange={() => toggle(sizes, setSizes, s)} /> {s}</label>)}</div>
      </fieldset>
      <fieldset className="field-wide bz-plain-fieldset">
        <legend>Colours</legend>
        <div className="fe-checks">{data.colors.map((c) => <label key={c} className="checkbox"><input type="checkbox" checked={colors.includes(c)} onChange={() => toggle(colors, setColors, c)} /> {c}</label>)}</div>
      </fieldset>
    </FormDialog>
  );
}

// The maker's barcodes for a whole delivery: one box per size and colour
// (a scanner types into the focused box and moves on with Enter).
function BarcodesDialog({ data, rows, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [codes, setCodes] = useState(() => Object.fromEntries(data.variants.map((v) => [v.sku_id, v.barcode || ""])));
  const changed = Object.fromEntries(Object.entries(codes).filter(([id, code]) => code.trim() && code.trim() !== (data.variants.find((v) => String(v.sku_id) === id)?.barcode || "")));
  const next = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const inputs = [...event.currentTarget.closest("table").querySelectorAll("input")];
    inputs[inputs.indexOf(event.currentTarget) + 1]?.focus();
  };
  return (
    <FormDialog title="The maker's barcodes" icon="qr" width={980} onClose={onClose} onSaved={onSaved} submitLabel={`Save ${Object.keys(changed).length} barcode${Object.keys(changed).length === 1 ? "" : "s"}`}
      description="Scan the code on each tag into its size and colour. It replaces the in-store code; a code already on another item is refused."
      onSubmit={() => (Object.keys(changed).length ? businessWrite(biz.id, `fashion/products/${data.product.id}/barcodes`, { barcodes: changed }, "put") : Promise.reject(refuse("Nothing changed.")))}>
      <div className="field-wide fe-matrix-wrap">
        <table className="fe-matrix is-entry is-codes">
          <thead><tr><th scope="col" className="fe-matrix-colour">Colour</th>{data.sizes.map((size) => <th scope="col" key={size}>{size}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="fe-matrix-colour">{row.color}{row.fabric && <small>{row.fabric}</small>}</th>
                {data.sizes.map((size) => {
                  const v = row.cells[size.toLowerCase()];
                  if (!v) return <td key={size} className="fe-matrix-none">—</td>;
                  return <td key={size}><input aria-label={`${row.color} ${size} barcode`} className="mono" maxLength={80} value={codes[v.sku_id]} onKeyDown={next}
                    onChange={(e) => setCodes((all) => ({ ...all, [v.sku_id]: e.target.value }))} /></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FormDialog>
  );
}

function VariantDialog({ variant, productId, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ price: String(Number(variant.price)), reorderLevel: String(Number(variant.reorder_level)), active: variant.active, barcode: variant.barcode || "" });
  const submit = async () => {
    const saved = await businessWrite(biz.id, `catalog/${variant.sku_id}`, { label: variant.label, price: form.price, reorderLevel: form.reorderLevel, active: form.active }, "patch");
    if (form.barcode.trim() && form.barcode.trim() !== (variant.barcode || "")) {
      await businessWrite(biz.id, `fashion/products/${productId}/barcodes`, { barcodes: { [variant.sku_id]: form.barcode.trim() } }, "put");
    }
    return saved;
  };
  return (
    <FormDialog title={`${variant.color} / ${variant.size}${variant.fabric ? ` / ${variant.fabric}` : ""}`} icon="edit" width={520} onClose={onClose} onSaved={onSaved}
      description={`${variant.code}`} onSubmit={submit}>
      <Field label={biz.settings.tax_mode === "inclusive" ? "Price (including GST)" : "Price (before GST)"}><input required type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} /></Field>
      <Field label="Reorder level"><input type="number" min="0" step="1" value={form.reorderLevel} onChange={(e) => setForm((f) => ({ ...f, reorderLevel: e.target.value }))} /></Field>
      <Field label="Barcode" wide hint="Scan the maker's barcode to use it instead of the in-store one."><input className="mono" maxLength={80} value={form.barcode} onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))} /></Field>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} /> On sale (untick to stop selling this variant)</label>
    </FormDialog>
  );
}
