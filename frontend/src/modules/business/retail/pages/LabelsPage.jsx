import { useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { barcodeSvg } from "../services/barcode";
import { escapeHtml, printDocument } from "../../../../services/print";
import FormDialog from "../../core/pages/FormDialog";
import { BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import "../styles/business-retail.css";

// Barcode labels: pick items, say how many labels each, print them on a
// standard A4 label sheet. Items without a barcode can be given an in-store
// one (EAN-13 starting 200). Loose items sold by weight get a code for the
// label scale, whose printed labels then scan straight into the bill.

const SHEETS = {
  a24: { label: "A4 · 24 per sheet (3 × 8, 63.5 × 33.9 mm)", columns: 3, rows: 8, width: 63.5, height: 33.9, top: 12.9, left: 7.2, gapX: 2.5, gapY: 0 },
  a40: { label: "A4 · 40 per sheet (4 × 10, 48.5 × 25.4 mm)", columns: 4, rows: 10, width: 48.5, height: 25.4, top: 21.5, left: 8, gapX: 0, gapY: 0 },
  a65: { label: "A4 · 65 per sheet (5 × 13, 38.1 × 21.2 mm)", columns: 5, rows: 13, width: 38.1, height: 21.2, top: 10.7, left: 4.7, gapX: 2.5, gapY: 0 },
};

export default function LabelsPage() {
  const biz = useOpenBusiness();
  const list = useServerList("catalog", { gridId: "retail-label-items", params: { kind: "goods", active: "true" } });
  // A purchase receipt can open this page with the pieces that just arrived.
  const { state } = useLocation();
  const [queue, setQueue] = useState(() => (Array.isArray(state?.labels) ? state.labels : []));
  const [sheet, setSheet] = useState("a24");
  // Garment tag (fashion, pro pass E-11): style, a large size, colour and the
  // price including GST, instead of the shelf label.
  const [template, setTemplate] = useState(state?.template === "garment" || biz.has("variants") ? "garment" : "shelf");
  const [showPrice, setShowPrice] = useState(true);
  const [showShop, setShowShop] = useState(true);
  const [skip, setSkip] = useState("0");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [sheetOpen, setSheetOpen] = useState(false);
  const add = useCallback((items) => {
    if (!items.length) return;
    setSheetOpen(true);
    setQueue((all) => {
      const next = all.map((item) => ({ ...item }));
      for (const item of items) {
        const found = next.find((q) => q.id === item.id);
        if (found) found.copies = String(Number(found.copies) + 1);
        else next.push({ id: item.id, label: item.label, code: item.code, barcode: item.barcode, price: item.price, mrp: item.mrp, unit: item.unit, copies: "1",
          size: item.size ?? item.attributes?.size ?? "", color: item.color ?? item.attributes?.color ?? "", brand: item.brand || "", style: item.style || item.product_name || "" });
      }
      return next;
    });
  }, []);
  async function giveBarcodes(items) {
    setError("");
    try {
      const result = await businessWrite(biz.id, "retail/barcodes", { skuIds: items.map((i) => i.id) });
      setNotice(result.assigned.length ? `${result.assigned.length} item${result.assigned.length === 1 ? "" : "s"} now have an in-store barcode.` : "Every chosen item already had a barcode.");
      setQueue((all) => all.map((q) => ({ ...q, barcode: result.assigned.find((a) => a.id === q.id)?.barcode || q.barcode })));
      list.reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  const columns = useMemo(() => [
    { key: "label", header: "Item", value: (s) => s.label, mobile: "title", pin: true },
    { key: "code", header: "SKU", value: (s) => s.code, className: "mono", mobile: "subtitle" },
    { key: "barcode", header: "Barcode", value: (s) => s.barcode || "", className: "mono", render: (s) => s.barcode || <span className="muted">None yet</span>, mobile: "show" },
    { key: "price", header: "Price", type: "money", exact: true, value: (s) => Number(s.price), mobile: "show" },
    { key: "stock", header: "In stock", type: "number", value: (s) => Number(s.stock), render: (s) => quantity(s.stock, s.unit) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => <button type="button" className="chip-button" onClick={() => add([s])}>Add to sheet</button> },
  ], [add]);

  const totalLabels = queue.reduce((s, q) => s + Math.max(0, Math.floor(Number(q.copies) || 0)), 0);
  const layout = SHEETS[sheet];
  const perSheet = layout.columns * layout.rows;
  const skipCount = Math.min(perSheet - 1, Math.max(0, Math.floor(Number(skip) || 0)));
  const sheets = Math.ceil((totalLabels + skipCount) / perSheet);
  const shop = biz.settings.display_name || biz.business.name;

  function labelHtml(item) {
    if (template === "garment") return garmentHtml(item);
    const code = item.barcode || item.code;
    let svg = "";
    try { svg = barcodeSvg(code).svg; } catch { svg = ""; }
    return `<div class="lbl">${showShop ? `<div class="shop">${escapeHtml(shop)}</div>` : ""}<div class="name">${escapeHtml(item.label)}</div>
      <div class="bc">${svg}</div><div class="foot"><span>${escapeHtml(code)}</span>${showPrice && Number(item.mrp) > Number(item.price) ? `<s>MRP ${escapeHtml(biz.exact(item.mrp))}</s>` : ""}${showPrice ? `<b>${escapeHtml(biz.exact(item.price))}${item.unit && item.unit !== "each" ? `/${escapeHtml(item.unit)}` : ""}</b>` : ""}</div></div>`;
  }
  // A swing tag: brand, style, the size large, colour, MRP / price (incl. GST), barcode.
  function garmentHtml(item) {
    const code = item.barcode || item.code;
    let svg = "";
    try { svg = barcodeSvg(code).svg; } catch { svg = ""; }
    const marked = Number(item.mrp) > Number(item.price);
    return `<div class="lbl tag"><div class="shop">${escapeHtml(item.brand || shop)}</div>
      <div class="tag-row"><div class="name">${escapeHtml(item.style || item.label)}${item.color ? `<br><span class="col">${escapeHtml(item.color)}</span>` : ""}</div>
      ${item.size ? `<div class="size">${escapeHtml(item.size)}</div>` : ""}</div>
      <div class="bc">${svg}</div><div class="foot"><span>${escapeHtml(code)}</span>${showPrice ? `<b>${marked ? `<s>MRP ${escapeHtml(biz.exact(item.mrp))}</s> ` : "MRP "}${escapeHtml(biz.exact(marked ? item.price : (item.mrp || item.price)))}</b>` : ""}</div>
      ${showPrice ? '<div class="incl">Incl. of all taxes</div>' : ""}</div>`;
  }
  function print() {
    const cells = [...Array(skipCount).fill('<div class="lbl empty"></div>')];
    for (const item of queue) for (let n = 0; n < Math.floor(Number(item.copies) || 0); n += 1) cells.push(labelHtml(item));
    const pages = [];
    for (let i = 0; i < cells.length; i += perSheet) pages.push(`<div class="sheet">${cells.slice(i, i + perSheet).join("")}</div>`);
    printDocument({
      title: `Labels ${biz.business.code}`,
      styles: `@page{size:A4;margin:0} body{margin:0;font:7.5pt system-ui;color:#000}
        .sheet{width:210mm;height:296mm;box-sizing:border-box;padding:${layout.top}mm 0 0 ${layout.left}mm;display:grid;
          grid-template-columns:repeat(${layout.columns},${layout.width}mm);grid-auto-rows:${layout.height}mm;column-gap:${layout.gapX}mm;row-gap:${layout.gapY}mm;page-break-after:always;overflow:hidden}
        .lbl{box-sizing:border-box;padding:1.5mm 2mm;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden}
        .shop{font-size:6pt;color:#333;white-space:nowrap;overflow:hidden} .name{font-weight:600;line-height:1.15;max-height:2.4em;overflow:hidden}
        .bc{flex:1;min-height:0;padding:0.5mm 0} .bc svg{width:100%;height:100%} .foot{display:flex;justify-content:space-between;gap:2mm;font:6.5pt ui-monospace,Consolas,monospace}
        .foot b{font:700 8pt system-ui}
        .tag .tag-row{display:flex;justify-content:space-between;align-items:flex-start;gap:1.5mm} .tag .size{font:800 15pt system-ui;line-height:1;border:0.3mm solid #000;padding:0.6mm 1.4mm;border-radius:1mm}
        .tag .col{font-weight:400} .tag .incl{font-size:5.5pt;color:#333;text-align:right}`,
      body: pages.join(""),
    });
  }

  return (
    <div className="stack">
      <BusinessHeader icon="tag" title="Barcode labels"
        description="Choose items, set how many labels each, and print on an A4 label sheet. Items without a barcode can be given one here."
        actions={<button type="button" className="button button-secondary" onClick={() => setSheetOpen(true)}><Icon name="print" size={16} /> Label sheet ({totalLabels})</button>} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="list" title="Items">
        <DataGrid {...list.gridProps} caption="Items to label" columns={columns} currency={biz.symbol} rowNoun={["item", "items"]}
          selectable bulkActions={(rows, clear) => (
            <>
              <button type="button" className="button button-sm" onClick={() => { add(rows); clear(); }}>Add {rows.length} to the sheet</button>
              {biz.can("catalog.edit") && rows.some((r) => !r.barcode) && (
                <button type="button" className="button button-secondary button-sm" onClick={() => { giveBarcodes(rows.filter((r) => !r.barcode)); clear(); }}>Give barcodes to {rows.filter((r) => !r.barcode).length} without one</button>
              )}
            </>
          )}
          empty="No goods in the catalogue yet" emptyIcon="tag" />
      </SectionCard>
      {sheetOpen && <Modal title="Label sheet" icon="print" width={1000} onClose={() => setSheetOpen(false)}>
      <SectionCard icon="print" title={`Label sheet · ${totalLabels} ${totalLabels === 1 ? "label" : "labels"}${totalLabels ? ` on ${sheets} ${sheets === 1 ? "sheet" : "sheets"}` : ""}`}
        actions={queue.length > 0 && <button type="button" className="button button-secondary button-sm" onClick={() => setQueue([])}>Clear</button>}>
        {queue.length === 0 ? <p className="muted">Add items from the list above (tick several and use “Add to the sheet”).</p> : (
          <div className="stack">
            <DataGrid variant="editor" caption="Labels to print" rows={queue} rowKey={(q) => q.id} rowNoun={["item", "items"]} currency={biz.symbol} columns={[
              { key: "label", header: "Item", value: (q) => q.label },
              { key: "code", header: "Printed code", value: (q) => q.barcode || q.code, className: "mono" },
              { key: "copies", header: "Labels", type: "number", value: (q) => Number(q.copies) || 0, total: "sum", render: (q, ctx) => (
                <input aria-label={ctx.label} className="rt-copies" type="number" min="0" max="500" step="1" value={q.copies}
                  onChange={(e) => setQueue((all) => all.map((x) => (x.id === q.id ? { ...x, copies: e.target.value } : x)))} />
              ) },
              { key: "remove", header: "", label: "Remove", type: "actions", render: (q) => <button type="button" className="link-button danger" onClick={() => setQueue((all) => all.filter((x) => x.id !== q.id))}>Remove</button> },
            ]} />
            <div className="form-grid">
              <Field label="Label sheet">
                <select value={sheet} onChange={(e) => setSheet(e.target.value)}>{Object.entries(SHEETS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}</select>
              </Field>
              <Field label="Label style">
                <select value={template} onChange={(e) => setTemplate(e.target.value)}>
                  <option value="shelf">Shelf / product label</option>
                  <option value="garment">Garment tag (size large, MRP incl. GST)</option>
                </select>
              </Field>
              <Field label="Start at label" hint="Skip labels already used on a part sheet."><input type="number" min="0" max={perSheet - 1} value={skip} onChange={(e) => setSkip(e.target.value)} /></Field>
              <label className="checkbox bz-check"><input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> Print the price</label>
              <label className="checkbox bz-check"><input type="checkbox" checked={showShop} onChange={(e) => setShowShop(e.target.checked)} /> Print the shop name</label>
            </div>
            <div className="rt-label-preview" aria-label="Preview of the first labels">
              {queue.slice(0, 4).map((q) => <LabelPreview key={q.id} item={q} shop={showShop ? (template === "garment" && q.brand ? q.brand : shop) : ""} price={showPrice ? biz.exact(q.price) : ""} garment={template === "garment"} />)}
            </div>
            <div className="form-actions bz-start">
              <button type="button" className="button" disabled={!totalLabels || totalLabels > 5000} onClick={print}><Icon name="print" size={16} /> Print {totalLabels} labels</button>
            </div>
          </div>
        )}
      </SectionCard>
      </Modal>}
      {biz.has("weight") && <ScaleCodes />}
    </div>
  );
}

function LabelPreview({ item, shop, price, garment }) {
  const code = item.barcode || item.code;
  let svg = "";
  let kind = "";
  try { ({ svg, kind } = barcodeSvg(code)); } catch { svg = ""; }
  return (
    <div className="rt-label">
      {shop && <small>{shop}</small>}
      {garment && item.size ? <span className="rt-label-tag"><strong>{item.style || item.label}{item.color ? ` · ${item.color}` : ""}</strong><b>{item.size}</b></span> : <strong>{item.label}</strong>}
      {/* The SVG is built from digits and rectangles only (services/barcode.js). */}
      <span dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="rt-label-foot"><span>{code}</span>{price && <span className="rt-label-price">{price}</span>}</span>
      <small className="muted">{kind}</small>
    </div>
  );
}

// Codes for the label scale: weigh, print, and the label scans into the bill.
function ScaleCodes() {
  const biz = useOpenBusiness();
  const list = useServerList("retail/scale-items", { gridId: "retail-scale-items" });
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function remove(row) {
    setError("");
    try {
      await businessWrite(biz.id, `retail/scale-items/${row.sku_id}`, undefined, "delete");
      setNotice(`Scale code ${row.plu_code} removed from ${row.label}.`);
      list.reload();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }
  return (
    <SectionCard flush icon="scale" title="Weighing-scale codes"
      description="Give each loose item the code you set on the label scale. Its labels (21 + code + grams) then scan straight into the bill at the right weight."
      actions={biz.can("catalog.edit") && <button type="button" className="button button-secondary button-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add a code</button>}>
      <SuccessMessage message={notice} />
      <ErrorMessage message={error || list.error} />
      <DataGrid {...list.gridProps} caption="Weighing-scale codes" currency={biz.symbol} rowNoun={["code", "codes"]} columns={[
        { key: "plu_code", header: "Scale code", value: (r) => r.plu_code, render: (r) => <span className="mono">{r.plu_code}</span>, mobile: "title" },
        { key: "label", header: "Item", value: (r) => r.label, mobile: "subtitle" },
        { key: "code", header: "SKU", value: (r) => r.code, className: "mono" },
        { key: "price", header: "Price", type: "money", exact: true, value: (r) => Number(r.price), render: (r) => `${biz.exact(r.price)} / ${r.unit}`, mobile: "show" },
        biz.can("catalog.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => <button type="button" className="link-button danger" onClick={() => remove(r)}>Remove</button> },
      ].filter(Boolean)} empty="No scale codes yet" emptyHint="Add one for each loose item you weigh on a label scale." emptyIcon="scale" />
      {adding && <ScaleCodeDialog onClose={() => setAdding(false)} onSaved={(row) => { setAdding(false); setNotice(`Scale code ${row.plu_code} saved.`); list.reload(); }} />}
    </SectionCard>
  );
}

function ScaleCodeDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["catalog?active=true&kind=goods", "units"]);
  const units = options?.units || [];
  const weighed = (options?.["catalog?active=true&kind=goods"] || []).filter((s) => units.find((u) => u.code === s.unit)?.kind === "weight" && s.tracking !== "serial");
  const [form, setForm] = useState({ skuId: "", pluCode: "" });
  return (
    <FormDialog title="Add a scale code" icon="scale" width={520} onClose={onClose} onSaved={onSaved} disabled={!options}
      onSubmit={() => businessWrite(biz.id, `retail/scale-items/${form.skuId}`, { pluCode: form.pluCode }, "put")}
      description="Use the same number (1–99999) as the item's key on your label scale.">
      <FormError message={error} />
      <Field label="Loose item (sold by weight)" wide>
        <select required value={form.skuId} onChange={(e) => setForm((f) => ({ ...f, skuId: e.target.value }))}>
          <option value="">Choose…</option>
          {weighed.map((s) => <option key={s.id} value={s.id}>{s.label} · {biz.exact(s.price)}/{s.unit}</option>)}
        </select>
      </Field>
      <Field label="Scale code"><input required inputMode="numeric" pattern="\d{1,5}" maxLength={5} value={form.pluCode} onChange={(e) => setForm((f) => ({ ...f, pluCode: e.target.value }))} /></Field>
    </FormDialog>
  );
}
