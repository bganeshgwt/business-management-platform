import { useEffect, useMemo, useState } from "react";
import { businessOptions, businessRead } from "../../../../services/business.service";
import { quantity as qtyText } from "../../core/pages/hooks";

// Quick bill's shelf: every item the shop sells, as buttons, with its price
// and what is in stock at the selling location — so a cashier sees what there
// is and adds it with one click instead of remembering names. Typing in the
// item box narrows the shelf as it narrows the matches; the category chips
// narrow it too. Items sold out here stay on the shelf, greyed, so the
// cashier can tell the customer at once. After a bill only the items it
// sold are counted again (`sold`), not the whole shelf.
const SHOWN = 60;

export default function CounterShelf({ biz, locationId, query, onAdd, sold }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("");

  useEffect(() => {
    if (!locationId) return undefined;
    const controller = new AbortController();
    Promise.all([
      businessOptions(biz.id, "catalog", controller.signal, { active: "true", kind: "goods" }),
      businessOptions(biz.id, "stock", controller.signal, { location: locationId, in_stock: "true" }),
      // This branch's own prices, where it has them (the bill itself is priced by the server).
      businessRead(biz.id, "branch-prices", { location: locationId }, controller.signal).catch(() => []),
    ]).then(([catalog, lots, prices]) => {
      const here = new Map();
      for (const lot of lots) here.set(Number(lot.sku_id), (here.get(Number(lot.sku_id)) || 0) + Number(lot.quantity));
      const own = new Map((prices || []).map((p) => [Number(p.sku_id), p.price]));
      setItems(catalog.map((s) => ({ ...s, price: own.get(Number(s.id)) ?? s.price, here: s.is_kit ? Number(s.stock) : here.get(Number(s.id)) || 0 })));
      setError("");
    }).catch((err) => { if (!controller.signal.aborted) setError(err?.message || "The items could not be loaded"); });
    return () => controller.abort();
  }, [biz.id, locationId]);

  useEffect(() => {
    if (!locationId || !sold?.skuIds.length) return undefined;
    const controller = new AbortController();
    Promise.all(sold.skuIds.map((sku) => businessOptions(biz.id, "stock", controller.signal, { location: locationId, sku, in_stock: "true" })
      .then((lots) => [Number(sku), lots.reduce((sum, lot) => sum + Number(lot.quantity), 0)])))
      .then((counted) => {
        const now = new Map(counted);
        setItems((all) => all && all.map((s) => (!s.is_kit && now.has(Number(s.id)) ? { ...s, here: now.get(Number(s.id)) } : s)));
      })
      .catch(() => { /* the shelf keeps its last count; the bill itself was saved */ });
    return () => controller.abort();
  }, [biz.id, locationId, sold]);

  const categories = useMemo(() => [...new Set((items || []).map((s) => s.category).filter(Boolean))].sort(), [items]);
  const words = String(query || "").trim().toLowerCase();
  const shown = useMemo(() => (items || [])
    .filter((s) => !category || s.category === category)
    .filter((s) => !words || `${s.label} ${s.code} ${s.barcode || ""} ${s.brand || ""}`.toLowerCase().includes(words))
    .sort((a, b) => (b.here > 0) - (a.here > 0) || a.label.localeCompare(b.label)), [items, category, words]);

  if (error) return <p className="small rt-warn">{error}</p>;
  if (!items) return <p className="small muted">Loading the items…</p>;
  if (!items.length) return null;

  return (
    <div className="rt-shelf">
      <div className="rt-shelf-head">
        <span className="small muted">{words ? `Items matching "${query.trim()}"` : "Or click an item"}</span>
        {categories.length > 1 && (
          <div className="rt-shelf-cats" role="group" aria-label="Category">
            <button type="button" className={`chip-button ${!category ? "is-active" : ""}`} aria-pressed={!category} onClick={() => setCategory("")}>All</button>
            {categories.map((c) => (
              <button key={c} type="button" className={`chip-button ${category === c ? "is-active" : ""}`} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>
            ))}
          </div>
        )}
      </div>
      {shown.length === 0
        ? <p className="small muted">No item matches. Check the spelling, or scan the barcode.</p>
        : (
          <div className="rt-shelf-grid">
            {shown.slice(0, SHOWN).map((s) => {
              const out = !(s.here > 0);
              return (
                <button key={s.id} type="button" className={`rt-tile ${out ? "is-out" : ""}`} disabled={out}
                  title={out ? `${s.label}: none left here` : `Add ${s.label}`} onClick={() => onAdd(s)}>
                  <span className="rt-tile-name">{s.label}</span>
                  <span className="rt-tile-price">{biz.exact(s.price)}<small className="muted"> / {s.unit}</small></span>
                  <span className={`rt-tile-stock ${out ? "is-out" : ""}`}>{out ? "Sold out here" : `${qtyText(s.here, s.unit)} here`}</span>
                </button>
              );
            })}
          </div>
        )}
      {shown.length > SHOWN && <p className="small muted">Showing {SHOWN} of {shown.length}. Type a few letters to find the rest.</p>}
    </div>
  );
}
