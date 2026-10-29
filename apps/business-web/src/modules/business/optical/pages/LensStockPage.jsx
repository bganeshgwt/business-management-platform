import { useEffect, useMemo, useState } from "react";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { MODALITIES, power, wordOf } from "./optical";
import "../styles/optical.css";

// Contact lenses in stock, power by power: each lens product made by its
// powers (the power grid), and for the one chosen a grid of its powers down
// the side and its variants across (a toric's CYL and AXIS, a multifocal's
// ADD, a coloured lens's colour), each cell the stock held, at one location
// or all.

// A variant's column heading: "-0.75 × 180", "ADD +2.00", "Blue", or "Stock" for a plain lens.
const variantOf = (p) => [p.cyl ? `${power(p.cyl)} × ${p.axis}` : null, p.add ? `ADD ${power(p.add)}` : null, p.colour].filter(Boolean).join(" · ") || "Stock";

export default function LensStockPage() {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState("");
  const [products, setProducts] = useState(null);
  const [productId, setProductId] = useState("");
  const [grid, setGrid] = useState(null);
  const [heldOnly, setHeldOnly] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "optical/lens-stock", locationId ? { locationId } : undefined, controller.signal)
      .then((list) => { setProducts(list); setProductId((id) => id || String(list.find((p) => Number(p.stock) > 0)?.id || list[0]?.id || "")); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, locationId]);
  useEffect(() => {
    if (!productId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `optical/lens-stock/${productId}`, locationId ? { locationId } : undefined, controller.signal)
      .then((g) => { setGrid(g); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, productId, locationId]);
  // Powers down the side, variants across.
  const table = useMemo(() => {
    if (!grid || String(grid.product.id) !== String(productId)) return null;
    const powers = [...new Set(grid.powers.map((p) => Number(p.power)))].sort((a, b) => a - b);
    const variants = [...new Set(grid.powers.map(variantOf))];
    const cell = new Map(grid.powers.map((p) => [`${Number(p.power)}|${variantOf(p)}`, p]));
    const rows = powers.filter((pw) => !heldOnly || variants.some((v) => Number(cell.get(`${pw}|${v}`)?.stock || 0) > 0));
    return { rows, variants, cell };
  }, [grid, productId, heldOnly]);
  const chosen = products?.find((p) => String(p.id) === String(productId));

  return (
    <div className="stack">
      <BusinessHeader icon="box" title="Contact lens stock"
        description="Each contact lens made by its powers, with the stock of every power: powers down the side, a toric's cylinder and axis, a multifocal's ADD or a colour across." />
      <ErrorMessage message={error} />
      {!products && !error && <Loading />}
      {products && !products.length && <SectionCard icon="box" title="No contact lenses made by powers yet"><p className="muted">Add one on Frames, lenses & products with Add item, ticking “Contact lenses: one item for each power” (Variants on).</p></SectionCard>}
      {products && products.length > 0 && (
        <SectionCard icon="box" title={chosen ? chosen.name : "Contact lens stock"}
          description={grid && chosen ? [grid.base_curve ? `BC ${grid.base_curve}` : null, grid.diameter ? `DIA ${grid.diameter}` : null, grid.modality ? wordOf(MODALITIES, grid.modality).toLowerCase() : null,
            grid.lenses_per_pack ? `${grid.lenses_per_pack} lenses a unit` : null, `${chosen.powers_in_stock} of ${chosen.items} powers in stock`].filter(Boolean).join(" · ") : undefined}>
          <div className="opt-setting">
            <Field label="Contact lens">
              <select value={productId} onChange={(e) => setProductId(e.target.value)}>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({Number(p.stock)} in stock)</option>)}
              </select>
            </Field>
            {locations.length > 1 && (
              <Field label="At">
                <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Every location</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            )}
            <label className="checkbox bz-check"><input type="checkbox" checked={heldOnly} onChange={(e) => setHeldOnly(e.target.checked)} /> Only powers in stock</label>
          </div>
          {!table ? <Loading /> : (
            <div className="opt-rx-wrap">
              <table className="opt-rx opt-stock">
                <caption className="sr-only">Stock of each power</caption>
                <thead><tr><th scope="col">Power</th>{table.variants.map((v) => <th key={v} scope="col">{v}</th>)}</tr></thead>
                <tbody>
                  {table.rows.map((pw) => (
                    <tr key={pw}>
                      <th scope="row">{power(pw)}</th>
                      {table.variants.map((v) => {
                        const p = table.cell.get(`${pw}|${v}`);
                        const n = Number(p?.stock || 0);
                        return <td key={v} className={!p ? "muted" : n > 0 ? "opt-held" : "opt-none"} title={p ? `${p.code}` : undefined}>{p ? n : "—"}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!table.rows.length && <p className="muted small">No power of this lens is in stock here.</p>}
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}
