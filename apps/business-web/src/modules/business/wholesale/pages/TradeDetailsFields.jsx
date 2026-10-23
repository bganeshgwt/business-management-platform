import "../../../../styles/business-trade.css";
import { Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { GST_STATES } from "../../core/pages/invoice";
import { DAYS } from "./tradeFormat";

// The wholesale part of the customer form.
export default function TradeDetailsFields({ trade }) {
  const biz = useOpenBusiness();
  const { options } = useOptions(["beats?active=true", ...(biz.can("wholesale.view") ? ["price-groups?active=true"] : [])]);
  const t = trade.value;
  return (
    <>
      <p className="field-wide muted small bz-form-section">Trade details</p>
      <Field label="Customer type">
        <select value={t.tradeType} onChange={trade.set("tradeType")}>
          <option value="trade">Trade (shop, retailer)</option>
          <option value="walk_in">Walk-in / counter (kept out of orders)</option>
        </select>
      </Field>
      <Field label="Beat (optional)" hint={biz.can("sales_orders.edit") ? "Orders and collections take its route and salesperson." : "Set under Routes & salespeople."}>
        <select value={t.beatId} disabled={!biz.can("sales_orders.edit")} onChange={trade.set("beatId")}>
          <option value="">Not on a beat</option>
          {(options?.["beats?active=true"] || []).map((b) => <option key={b.id} value={b.id}>{b.route_name} · {b.name}{b.visit_day ? ` (${DAYS[b.visit_day - 1]})` : ""}</option>)}
        </select>
      </Field>
      {biz.can("wholesale.view") && (
        <Field label="Price group (optional)">
          <select value={t.priceGroupId} onChange={trade.set("priceGroupId")}>
            <option value="">None — list and slab prices</option>
            {(options?.["price-groups?active=true"] || []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Contact person (optional)"><input maxLength={100} value={t.contactPerson} onChange={trade.set("contactPerson")} /></Field>
      <Field label="State (optional)" hint="The place of supply on invoices when there is no GSTIN.">
        <select value={t.stateCode} onChange={trade.set("stateCode")}>
          <option value="">Same as the GSTIN / this business</option>
          {Object.entries(GST_STATES).map(([code, name]) => <option key={code} value={String(code).padStart(2, "0")}>{name}</option>)}
        </select>
      </Field>
      <Field label="PIN code (optional)"><input inputMode="numeric" maxLength={6} pattern="[1-9][0-9]{5}" title="Six digits" value={t.pinCode} onChange={trade.set("pinCode")} /></Field>
      <Field label="PAN (optional)"><input maxLength={10} value={t.pan} onChange={trade.set("pan")} className="mono" /></Field>
      <Field label="FSSAI licence (optional)"><input inputMode="numeric" maxLength={14} value={t.fssai} onChange={trade.set("fssai")} className="mono" /></Field>
      {biz.can("receivables.approve") && <label className="checkbox bz-check"><input type="checkbox" checked={t.holdExempt} onChange={trade.set("holdExempt")} /> Never put on credit hold</label>}
    </>
  );
}
