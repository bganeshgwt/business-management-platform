import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { quantity } from "../../core/pages/hooks";

// A part's substitutes, offered when it is out of stock (on the job card, the
// estimate, a vehicle's parts and the parts counter): its newer and older
// numbers and the parts that do the same job (Parts fitment), in stock first.

// --- A part's substitutes ------------------------------------------------------------------------------

// The part's newer and older numbers and its group's parts, in stock first; onPick(sku) to use one instead.
export function SubstitutesDialog({ biz, skuId, locationId, onPick, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `garage/parts/${skuId}/substitutes`, locationId ? { locationId } : undefined, controller.signal)
      .then(setData).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, skuId, locationId]);
  const why = { newer: "newer number", older: "older number", group: "does the same job" };
  return (
    <FormDialog title={data ? `Instead of ${data.part.label}` : "Substitutes"} icon="switch" width={560} onClose={onClose} hideSubmit onSubmit={() => undefined}
      description={data ? `${data.part.label} has ${quantity(data.part.in_stock)} in stock here. These can be used instead.` : undefined}>
      {error && <p className="field-wide bz-due">{error}</p>}
      {!data && !error ? <Loading /> : data && (
        data.substitutes.length ? (
          <ul className="field-wide gar-subs">
            {data.substitutes.map((s) => (
              <li key={s.id}>
                <span><strong>{s.label}</strong> <small className="muted mono">{s.code}</small> · {why[s.why]} · {quantity(s.in_stock, s.unit)} in stock</span>
                {onPick && <button type="button" className="button button-sm" disabled={s.in_stock <= 0} onClick={() => onPick(s)}>Use this</button>}
              </li>
            ))}
          </ul>
        ) : <p className="field-wide muted">No substitute is recorded for it (Parts fitment).</p>
      )}
    </FormDialog>
  );
}

// A hint that a part is out of stock here, with its substitutes a click away.
export function OutOfStock({ biz, sku, locationId, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link-button small gar-out" onClick={() => setOpen(true)}><Icon name="switch" size={12} /> Out of stock: substitutes</button>
      {open && <SubstitutesDialog biz={biz} skuId={sku.id} locationId={locationId} onClose={() => setOpen(false)} onPick={onPick ? (s) => { setOpen(false); onPick(s); } : null} />}
    </>
  );
}

// The parts counter: when the part just added is out of stock here, the
// substitutes in stock, each one click away (onPick); nothing otherwise.
export function CounterSubstitutes({ biz, sku, locationId, onPick, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `garage/parts/${sku.id}/substitutes`, locationId ? { locationId } : undefined, controller.signal).then(setData).catch(() => setData(null));
    return () => controller.abort();
  }, [biz.id, sku.id, locationId]);
  const offered = data && data.part.in_stock <= 0 ? data.substitutes.filter((s) => s.in_stock > 0) : [];
  if (!offered.length) return null;
  return (
    <div className="small rt-scan-tip" role="status">
      <span>{data.part.label} is out of stock here. In stock instead: </span>
      {offered.slice(0, 4).map((s) => (
        <button key={s.id} type="button" className="button button-secondary button-sm" onClick={() => onPick(s)}>{s.label} <small className="muted">({quantity(s.in_stock, s.unit)})</small></button>
      ))}
      <button type="button" className="link-button" onClick={onClose} aria-label="Close">Close</button>
    </div>
  );
}
