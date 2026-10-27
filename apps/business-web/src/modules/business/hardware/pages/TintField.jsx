import { useEffect, useMemo, useState } from "react";
import SearchPicker from "../../../../components/SearchPicker";
import { businessRead } from "../../../../services/business.service";
import { shadeWords, useShades, usesTinting } from "./hardware";
import "../styles/hardware.css";

// The shade a bill's or a quotation's line of paint is tinted to: one of the
// shades that are on and need the base the item is (its "paintBase" detail,
// compared without case). Small enough for a Quick bill line or a row of an
// entry grid. Shown in a hardware shop with Paint tinting on, to someone who
// may put tinted paint on bills, for an item whose details name its base.
//   sku: the base item; value: a shade id as text ("" = not tinted);
//   onChange(shade | null); label: a word shown above it (optional).

const sameBase = (a, b) => String(a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === String(b ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export default function TintField({ biz, sku, value, onChange, label }) {
  const base = String(sku?.attributes?.paintBase ?? "").trim();
  const on = usesTinting(biz) && biz.can("hardware_tinting.create") && Boolean(base);
  const shades = useShades(biz);
  const chosenId = value ? String(value) : "";
  const matching = useMemo(() => (shades || []).filter((s) => sameBase(s.base, base)), [shades, base]);
  const listed = (shades || []).find((s) => String(s.id) === chosenId) || null;
  // A shade chosen before and switched off since (a quotation's): read on its own, to say so.
  const [gone, setGone] = useState(null);
  const lookFor = on && shades && chosenId && !listed ? chosenId : "";
  useEffect(() => {
    if (!lookFor) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "hardware/shades", { id: lookFor, limit: 1 }, controller.signal)
      .then((page) => setGone(page.items[0] || null))
      .catch(() => {});
    return () => controller.abort();
  }, [biz.id, lookFor]);
  if (!on) return null;
  const chosen = listed || (gone && String(gone.id) === chosenId ? gone : null);
  const warning = !chosen ? ""
    : !chosen.active ? "This shade is switched off: choose another, or take the tint off."
      : !sameBase(chosen.base, base) ? `This shade needs the ${chosen.base} base, and ${sku.label} is the ${base} base.` : "";
  return (
    <div className="hw-tint">
      {label && <span className="hw-tint-label">{label}</span>}
      <SearchPicker aria-label={`Shade for ${sku.label}`} options={matching} value={chosen} onChange={(shade) => onChange(shade || null)}
        getKey={(s) => s.id} getLabel={(s) => `${s.code} ${s.name}`} getDescription={(s) => [s.maker, s.card].filter(Boolean).join(" · ")}
        placeholder="Not tinted: choose a shade"
        emptyText={!shades ? "Reading the shades…" : matching.length ? "No shade matches" : `No shades need the ${base} base yet`} />
      {chosenId && (
        <span className="hw-tint-chosen">
          {chosen && <small className="muted">{shadeWords(chosen)}{chosen.card ? ` · ${chosen.card}` : ""}</small>}
          <button type="button" className="link-button" onClick={() => onChange(null)} aria-label={`Take the tint off ${sku.label}`}>Take the tint off</button>
        </span>
      )}
      {warning && <small className="hw-tint-warn">{warning}</small>}
    </div>
  );
}
