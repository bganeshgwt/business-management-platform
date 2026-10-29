import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { businessWrite } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import ReasonDialog from "../../core/pages/ReasonDialog";
import { Badge, Field } from "../../core/pages/ui";
import { newKey } from "../../core/pages/hooks";
import { atWords, nowInput } from "./fuel";

// The parts of a shift's settlement besides the readings: the cash dropped
// during the shift (how much, when and to whom), the cash counted by notes
// and coins, the attendant's other sales (lubricants, additives, shop items:
// GST invoices at their slabs, never on the fuel bills), and a walk-in
// buyer's fill of ₹2,00,000 or more (a bill of its own with the buyer's PAN
// or declaration, the cash limit checked). The server works out and checks
// every figure again.

// The cash handed over during the shift; a manager cancels one typed wrongly while it is open.
export function CashDrops({ biz, shift, onChanged }) {
  const [dialog, setDialog] = useState(null);
  const open = shift.status === "open";
  const canAdd = open && biz.can("fuel.create");
  if (!open && !shift.drops.length) return null;
  return (
    <SectionCard icon="wallet" title="Cash drops" aria-label="Cash drops" description={`Cash handed over during the shift, counted with the cash at its close${shift.dropped !== null ? `: ${biz.exact(shift.dropped)}` : ""}.`}
      actions={canAdd && <button type="button" className="button button-secondary button-sm" onClick={() => setDialog({ kind: "add" })}><Icon name="plus" size={14} /> Record a cash drop</button>}>
      {!shift.drops.length ? <p className="muted">No cash dropped on this shift.</p> : (
        <ul className="fuel-history">
          {shift.drops.map((d) => (
            <li key={d.id}>
              <strong className="mono">{d.amount === null ? "—" : biz.exact(d.amount)}</strong> to {d.received_by_name} · {atWords(d.dropped_at, biz)}{d.note ? ` · ${d.note}` : ""}
              {d.cancelled_at ? <> · <Badge tone="neutral" label={`Cancelled: ${d.cancel_reason}`} /></>
                : open && biz.can("fuel.approve") && <> · <button type="button" className="link-button danger" onClick={() => setDialog({ kind: "cancel", drop: d })}>Cancel</button></>}
            </li>
          ))}
        </ul>
      )}
      {dialog?.kind === "add" && <DropDialog biz={biz} shift={shift} onClose={() => setDialog(null)} onSaved={(s) => { setDialog(null); toast.success("Cash drop recorded."); onChanged(s); }} />}
      {dialog?.kind === "cancel" && (
        <ReasonDialog title="Cancel the cash drop" icon="undo" label="Why it is cancelled" submitLabel="Cancel it" onClose={() => setDialog(null)}
          onSaved={(s) => { setDialog(null); toast.success("Cash drop cancelled."); onChanged(s); }}
          onSubmit={(reason) => businessWrite(biz.id, `fuel/shifts/${shift.id}/drops/${dialog.drop.id}/cancel`, { reason })} />
      )}
    </SectionCard>
  );
}

function DropDialog({ biz, shift, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ amount: "", receivedBy: "", droppedAt: "", note: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Cash drop · ${shift.shift_no}`} icon="wallet" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Record it"
      onSubmit={() => businessWrite(biz.id, `fuel/shifts/${shift.id}/drops`, { requestKey, amount: form.amount.trim(), receivedBy: form.receivedBy,
        ...(form.droppedAt ? { droppedAt: form.droppedAt } : {}), note: form.note.trim() || null })}>
      <Field label={`Amount (${biz.symbol})`}><input required inputMode="decimal" className="mono" value={form.amount} onChange={set("amount")} /></Field>
      <Field label="Handed to">
        <select required value={form.receivedBy} onChange={set("receivedBy")}>
          <option value="">Choose who took it</option>
          {shift.receivers.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Dropped at (optional)" hint="Left empty: now."><input type="datetime-local" max={nowInput(biz)} value={form.droppedAt} onChange={set("droppedAt")} /></Field>
      <Field label="Note (optional)" wide><input maxLength={300} value={form.note} onChange={set("note")} placeholder="e.g. into the safe" /></Field>
    </FormDialog>
  );
}

// The cash counted note by note and coin by coin: the count is the cash.
export function CashCount({ biz, denominations, count, setCount }) {
  const total = denominations.reduce((sum, d) => sum + d * Number(count[d] || 0), 0);
  return (
    <div className="fuel-count" aria-label="Notes and coins counted">
      {denominations.map((d) => (
        <label key={d} className="field fuel-count-cell">
          <span>{biz.symbol}{d} ×</span>
          <input inputMode="numeric" className="mono" aria-label={`${biz.symbol}${d} notes or coins`} value={count[d] || ""}
            onChange={(e) => setCount((c) => ({ ...c, [d]: e.target.value.replace(/\D/g, "") }))} placeholder="0" />
        </label>
      ))}
      <p className="fuel-count-total">Counted: <strong className="mono">{biz.exact(total)}</strong></p>
    </div>
  );
}

// The attendant's other sales: an item that is not a fuel, its quantity, and the customer when it is on their account.
export function OtherSales({ items, customers, goods, setGoods }) {
  const set = (key, name, value) => setGoods((all) => all.map((g) => (g.key === key ? { ...g, [name]: value } : g)));
  return (
    <>
      {!goods.length && <p className="muted">No lubricants or shop items sold on this shift.</p>}
      {goods.map((g, index) => (
        <fieldset key={g.key} className="fuel-row" aria-label={`Other sale ${index + 1}`}>
          <Field label="Item">
            <select required value={g.skuId} onChange={(e) => set(g.key, "skuId", e.target.value)}>
              <option value="">Choose the item</option>
              {items.map((i) => <option key={i.id} value={String(i.id)}>{i.label}</option>)}
            </select>
          </Field>
          <Field label="Quantity"><input required inputMode="decimal" className="mono" value={g.quantity} onChange={(e) => set(g.key, "quantity", e.target.value)} /></Field>
          <Field label="Billed to">
            <select value={g.contactId} onChange={(e) => set(g.key, "contactId", e.target.value)}>
              <option value="">Walk-in buyer (paid now)</option>
              {customers.map((c) => <option key={c.id} value={String(c.id)}>{c.name} (on account)</option>)}
            </select>
          </Field>
          <button type="button" className="link-button danger" onClick={() => setGoods((all) => all.filter((x) => x.key !== g.key))}>Remove</button>
        </fieldset>
      ))}
    </>
  );
}

// Fills of ₹2,00,000 or more to walk-in buyers: each a bill of its own, paid in full by its own payments.
export function BigFills({ biz, fuels, methods, fills, setFills }) {
  const set = (key, name, value) => setFills((all) => all.map((f) => (f.key === key ? { ...f, [name]: value } : f)));
  return (
    <>
      {!fills.length && <p className="muted">No single fill of {biz.symbol}2,00,000 or more on this shift.</p>}
      {fills.map((f, index) => (
        <fieldset key={f.key} className="fuel-row" aria-label={`Big fill ${index + 1}`}>
          <Field label="Fuel">
            <select required value={f.productId} onChange={(e) => set(f.key, "productId", e.target.value)}>
              <option value="">Choose</option>
              {fuels.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Quantity"><input required inputMode="decimal" className="mono" value={f.litres} onChange={(e) => set(f.key, "litres", e.target.value)} /></Field>
          <Field label="Vehicle (optional)"><input maxLength={15} className="mono" value={f.registration} onChange={(e) => set(f.key, "registration", e.target.value)} /></Field>
          <Field label="Buyer (optional)"><input maxLength={150} value={f.buyerName} onChange={(e) => set(f.key, "buyerName", e.target.value)} /></Field>
          <Field label="Buyer's PAN"><input maxLength={10} className="mono" value={f.pan} disabled={f.declaration} onChange={(e) => set(f.key, "pan", e.target.value.toUpperCase())} /></Field>
          <label className="checkbox bz-check"><input type="checkbox" checked={f.declaration} onChange={(e) => set(f.key, "declaration", e.target.checked)} /> No PAN: declaration (Form 97) signed</label>
          <Field label="Paid by">
            <select value={f.bankMethodId} onChange={(e) => set(f.key, "bankMethodId", e.target.value)}>
              <option value="">Choose</option>
              {methods.map((m) => <option key={m.key} value={String(m.id)}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Amount by it"><input inputMode="decimal" className="mono" value={f.bank} onChange={(e) => set(f.key, "bank", e.target.value)} /></Field>
          <Field label={`Cash (under ${biz.symbol}2,00,000)`}><input inputMode="decimal" className="mono" value={f.cash} onChange={(e) => set(f.key, "cash", e.target.value)} /></Field>
          <button type="button" className="link-button danger" onClick={() => setFills((all) => all.filter((x) => x.key !== f.key))}>Remove</button>
        </fieldset>
      ))}
    </>
  );
}

