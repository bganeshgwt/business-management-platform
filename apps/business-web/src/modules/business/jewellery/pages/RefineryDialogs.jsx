import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SidePanel from "../../../../components/SidePanel";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { dateTime, newKey } from "../../core/pages/hooks";
import { ALL_PURITIES, REFINERY_OUTCOMES, REFINERY_PARTIES, finenessOf, grams, perGram, splitPurity } from "./jewellery";

// Refinery challans: the shop's metal (melted pieces, old gold, scrap) sent
// out, purity by purity, to a refiner (a supplier) who gives it back refined,
// or to a bullion dealer (a customer) who buys it on a sale bill at a rate per
// gram of the fine metal sent, with 3% GST. A challan may name the lines of
// old gold it carries. Sent, brought back and sold by a manager.

const blankLine = (purity = "gold:22K", netWeight = "") => ({ key: newKey(), purity, netWeight, fineness: "" });

// carries: [{ voucherId, seq, voucherNo, description }] the old gold lines it takes (from a voucher's panel), with their purity and weight.
export function RefinerySendForm({ biz, carries = [], start, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [party, setParty] = useState("refiner");
  const [contact, setContact] = useState(null);
  const [locationId, setLocationId] = useState(String(start?.locationId || biz.currentLocationId || locations[0]?.id || ""));
  const [lines, setLines] = useState(() => [blankLine(start?.purity, start?.netWeight)]);
  const [notes, setNotes] = useState("");
  const set = (key, change) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));
  const kind = party === "refiner" ? "supplier" : "customer";
  return (
    <FormDialog title="Send metal to a refiner or dealer" icon="truck" width={820} onClose={onClose} onSaved={onSaved} submitLabel="Make the challan"
      successMessage={(c) => `Challan ${c.challan_no} made.`}
      description="Out of what the location holds of each purity, one metal a challan. A refiner gives it back refined; a bullion dealer buys it on a bill."
      onSubmit={() => businessWrite(biz.id, "jewellery/refinery", { requestKey, locationId, party, contactId: contact?.id,
        lines: lines.map((l) => ({ ...splitPurity(l.purity), netWeight: l.netWeight, ...(l.fineness !== "" ? { fineness: l.fineness } : {}) })),
        ...(carries.length ? { oldGold: carries.map((c) => ({ voucherId: c.voucherId, seq: c.seq })) } : {}), notes: notes.trim() || undefined })}>
      <Field label="Sent to"><select value={party} onChange={(e) => { setParty(e.target.value); setContact(null); }}>{REFINERY_PARTIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
      <div className="field">
        <SearchPicker key={kind} label={party === "refiner" ? "The refiner (a supplier)" : "The dealer who buys it (a customer)"} placeholder="Name or phone" value={contact} onChange={setContact} minChars={2}
          search={(q, { signal }) => businessRead(biz.id, "contacts", { kind, active: "true", q, limit: 15 }, signal).then((page) => page.items)}
          getLabel={(x) => x.name} getDescription={(x) => x.gstin || x.phone || ""} />
      </div>
      {locations.length > 1 && <Field label="From"><select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <div className="field-wide jw-og-lines">
        {lines.map((l, index) => {
          const { metal, purity } = splitPurity(l.purity);
          return (
            <div key={l.key} className="jw-row">
              <Field label={`Purity ${index + 1}`}><select value={l.purity} onChange={(e) => set(l.key, { purity: e.target.value })}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
              <Field label="Weight (g)"><input required type="number" min="0.001" step="0.001" value={l.netWeight} onChange={(e) => set(l.key, { netWeight: e.target.value })} /></Field>
              <Field label="Fineness"><input type="number" min="0.1" max="999.9" step="0.1" value={l.fineness} placeholder={String(finenessOf(metal, purity))} onChange={(e) => set(l.key, { fineness: e.target.value })} /></Field>
              {lines.length > 1 && <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>}
            </div>
          );
        })}
        {lines.length < 30 && <button type="button" className="chip-button" onClick={() => setLines((all) => [...all, blankLine(all.at(-1)?.purity)])}><Icon name="plus" size={13} /> Another purity</button>}
      </div>
      {carries.length > 0 && <p className="field-wide muted small">Carries old gold {carries.map((c) => `${c.voucherNo} (${c.description})`).join(", ")}.</p>}
      <Field label="Notes (optional)" wide><input maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </FormDialog>
  );
}

function BackForm({ biz, challan, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ purity: `${challan.metal}:${challan.metal === "gold" ? "24K" : challan.metal === "silver" ? "999" : "950"}`, netWeight: "", fineness: "" });
  const { metal, purity } = splitPurity(form.purity);
  return (
    <FormDialog title={`Back from ${challan.party_name}`} icon="undo" onClose={onClose} onSaved={onSaved} submitLabel="Bring it in" successMessage="The refined metal is in the shop's metal."
      description={`${grams(challan.fine_weight)} of fine metal went on ${challan.challan_no}. What comes back joins the shop's metal; the fine metal lost is shown against what went.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/refinery/${challan.id}/back`, { requestKey, purity, netWeight: form.netWeight, ...(form.fineness !== "" ? { fineness: form.fineness } : {}) })}>
      <Field label="Comes back as"><select value={form.purity} onChange={(e) => setForm((f) => ({ ...f, purity: e.target.value }))}>
        {ALL_PURITIES.filter((p) => p.metal === challan.metal).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
      <Field label="Weight back (g)"><input required type="number" min="0.001" step="0.001" value={form.netWeight} onChange={(e) => setForm((f) => ({ ...f, netWeight: e.target.value }))} /></Field>
      <Field label="Fineness assayed"><input type="number" min="0.1" max="999.9" step="0.1" value={form.fineness} placeholder={String(finenessOf(metal, purity))} onChange={(e) => setForm((f) => ({ ...f, fineness: e.target.value }))} /></Field>
    </FormDialog>
  );
}

function SellForm({ biz, challan, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [rate, setRate] = useState("");
  const amount = Number(rate) > 0 ? Number(challan.fine_weight) * Number(rate) : 0;
  return (
    <FormDialog title={`Sold to ${challan.party_name}`} icon="receipt" onClose={onClose} onSaved={onSaved} submitLabel="Make the sale bill" successMessage={(c) => `Sold on ${c.document_no}.`}
      description={`A sale bill to the dealer of the ${grams(challan.fine_weight)} of fine metal on ${challan.challan_no}, at the rate per fine gram, with 3% GST. It goes on their account; take the money on the bill.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/refinery/${challan.id}/sell`, { requestKey, rate })}>
      <Field label="Rate per gram of fine metal (₹)"><input required type="number" min="0.01" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
      {amount > 0 && <p className="field-wide jw-og-value">{grams(challan.fine_weight)} × {perGram(biz, rate)} = <strong>{biz.exact(amount)}</strong> before GST</p>}
    </FormDialog>
  );
}

export function RefineryPanel({ biz, challanId, onClose, onChanged }) {
  const [challan, setChallan] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/refinery/${challanId}`, undefined, controller.signal).then((c) => { setChallan(c); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, challanId, version]);
  const done = () => { setDialog(null); setVersion((n) => n + 1); onChanged?.(); };
  const outcome = challan ? REFINERY_OUTCOMES[challan.outcome] : null;
  const can = biz.can("jewellery.approve");
  return (
    <SidePanel open title={challan ? `Challan ${challan.challan_no}` : "Refinery challan"} icon="truck" wide onClose={onClose}
      footer={challan && challan.outcome === "out" && can && (
        <div className="jw-panel-actions">
          {challan.party === "refiner" && <button type="button" className="button" onClick={() => setDialog("back")}><Icon name="undo" size={15} /> Back refined</button>}
          {challan.party === "dealer" && biz.can("sales.create") && <button type="button" className="button" onClick={() => setDialog("sell")}><Icon name="receipt" size={15} /> Sold to the dealer</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!challan ? !error && <Loading /> : (
        <div className="stack">
          <div className="jw-piece-head"><Badge tone={outcome?.tone} label={outcome?.label || challan.outcome} /><strong>{challan.party_name}</strong><span className="muted">{challan.party_words}</span></div>
          <dl className="jw-facts">
            {[["Sent", `${dateTime(challan.created_at)} · ${challan.by_name}`], ["From", biz.locations.length > 1 ? challan.location_name : null], ["Metal", `${grams(challan.net_weight)} · fine ${grams(challan.fine_weight)}`],
              ["Back", challan.outcome === "back" ? `${challan.back_mark}: ${grams(challan.back_net_weight)} · fine ${grams(challan.back_fine_weight)} · lost ${grams(challan.loss_fine)} fine` : null],
              ["Sold", challan.outcome === "sold" ? `${challan.document_no} at ${perGram(biz, challan.sale_rate)} of fine metal · ${biz.exact(challan.sale_total)}` : null],
              ["Closed", challan.closed_at ? `${dateTime(challan.closed_at)} · ${challan.closed_by_name}` : null], ["Notes", challan.notes]]
              .filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <table className="jw-rates">
            <thead><tr><th scope="col">Purity</th><th scope="col">Weight</th><th scope="col">Fineness</th><th scope="col">Fine</th></tr></thead>
            <tbody>{challan.lines.map((l) => <tr key={l.seq}><th scope="row">{l.label}</th><td>{grams(l.net_weight)}</td><td>{Number(l.fineness).toFixed(1)}</td><td>{grams(l.fine_weight)}</td></tr>)}</tbody>
          </table>
          {challan.old_gold.length > 0 && <p className="muted small">Carries old gold {challan.old_gold.map((x) => `${x.voucher_no} (${x.description})`).join(", ")}.</p>}
        </div>
      )}
      {dialog === "back" && <BackForm biz={biz} challan={challan} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog === "sell" && <SellForm biz={biz} challan={challan} onClose={() => setDialog(null)} onSaved={done} />}
    </SidePanel>
  );
}
