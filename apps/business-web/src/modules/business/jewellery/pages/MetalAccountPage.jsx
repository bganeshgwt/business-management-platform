import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import FormDialog from "../../core/pages/FormDialog";
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { ALL_PURITIES, grams, perGram, purityMark, splitPurity } from "./jewellery";
import "../styles/jewellery.css";

// The metal account with suppliers: a bullion dealer or wholesaler gives the
// shop metal on a metal balance, or takes metal back (old gold or scrap
// against what is owed). Each is a metal voucher in grams of a purity, with
// its fine weight; the metal comes into or goes out of the shop's own metal.
// What the shop owes each supplier is kept in grams of each purity beside the
// money it owes them. Fixing the rate (bhav cut) turns grams owed into money
// owed, in full or in part, as a purchase from the supplier at 3% GST.

const KIND_WORDS = { received: "Received", given: "Given", fixed: "Rate fixed" };

function MoveForm({ biz, preset, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [supplier, setSupplier] = useState(preset?.supplier || null);
  const [form, setForm] = useState({ kind: "received", purity: "gold:24K", weight: "", description: "", notes: "", locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title="Metal with a supplier" icon="scale" onClose={onClose} onSaved={onSaved} submitLabel="Make the voucher" successMessage="Voucher made."
      description="Metal received on a metal balance comes into the shop's own metal; metal given back goes out of it. The balance is kept in grams until its rate is fixed."
      onSubmit={() => businessWrite(biz.id, "jewellery/metal-account/entries", { requestKey, kind: form.kind, contactId: supplier?.id, locationId: form.locationId, ...splitPurity(form.purity),
        netWeight: form.weight, description: form.description.trim() || undefined, notes: form.notes.trim() || undefined })}>
      <div className="field-wide">
        <SearchPicker label="Supplier" placeholder="Name" value={supplier} onChange={setSupplier} minChars={2}
          search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "supplier", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
          getLabel={(x) => x.name} getDescription={(x) => x.gstin || ""} />
      </div>
      <Field label="The metal is"><select value={form.kind} onChange={set("kind")}><option value="received">Received from them</option><option value="given">Given to them</option></select></Field>
      {locations.length > 1 && <Field label="At"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="Purity"><select value={form.purity} onChange={set("purity")}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
      <Field label="Weight (g)"><input required type="number" min="0.001" step="0.001" value={form.weight} onChange={set("weight")} /></Field>
      <Field label="What it is (optional)"><input maxLength={150} value={form.description} onChange={set("description")} placeholder="e.g. Bars, old gold, scrap" /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function FixForm({ biz, row, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ weight: row.owed, rate: "", billNo: "", billDate: "", notes: "", locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Fix the rate: ${row.supplier_name}, ${row.mark}`} icon="wallet" onClose={onClose} onSaved={onSaved} submitLabel="Post the purchase"
      successMessage="Rate fixed: the grams are money owed now."
      description={`The shop owes ${grams(row.owed)} of ${row.label} (${grams(row.owed_fine)} fine). The grams fixed become a purchase from the supplier at 3% GST; the rest stays in grams.`}
      onSubmit={() => businessWrite(biz.id, "jewellery/metal-account/fix", { requestKey, contactId: row.contact_id, locationId: form.locationId, metal: row.metal, purity: row.purity,
        netWeight: form.weight || undefined, rate: form.rate || undefined, supplierBillNo: form.billNo.trim() || undefined, supplierBillDate: form.billDate || undefined, notes: form.notes.trim() || undefined })}>
      <Field label="Grams fixed" hint="All that is owed, or part of it."><input required type="number" min="0.001" max={row.owed} step="0.001" value={form.weight} onChange={set("weight")} /></Field>
      <Field label="Rate a gram (₹)" hint="Empty: today's selling rate for the purity."><input type="number" min="0.01" step="0.01" value={form.rate} onChange={set("rate")} /></Field>
      {locations.length > 1 && <Field label="Booked at"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="Their bill no. (optional)"><input maxLength={60} value={form.billNo} onChange={set("billNo")} /></Field>
      <Field label="Their bill's date (optional)"><input type="date" value={form.billDate} onChange={set("billDate")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

export default function MetalAccountPage() {
  const biz = useOpenBusiness();
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  const list = useServerList("jewellery/metal-account/entries", { gridId: "jewellery-metal-account" });
  const many = biz.locations.length > 1;
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/metal-account", undefined, controller.signal).then((a) => { setAccount(a); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const done = () => { setDialog(null); setVersion((n) => n + 1); list.reload(); };
  const columns = useMemo(() => [
    { key: "created_at", header: "When", type: "datetime", value: (e) => e.created_at, mobile: "subtitle" },
    { key: "voucher_no", header: "Voucher · purchase", value: (e) => e.voucher_no || e.document_no || "", className: "mono", mobile: "title" },
    { key: "supplier", header: "Supplier", value: (e) => e.supplier_name },
    { key: "kind", header: "What", value: (e) => KIND_WORDS[e.kind] || e.kind, mobile: "show" },
    { key: "purity", header: "Purity", value: (e) => purityMark(e.metal, e.purity) },
    { key: "net_weight", header: "Grams", value: (e) => Number(e.net_weight), render: (e) => grams(e.net_weight) },
    { key: "fine_weight", header: "Fine", value: (e) => Number(e.fine_weight), render: (e) => grams(e.fine_weight) },
    { key: "amount", header: "Fixed at", value: (e) => Number(e.amount || 0), render: (e) => (e.kind === "fixed" ? `${perGram(biz, e.rate)} · ${biz.exact(e.amount)}` : "—") },
    { key: "location", header: "Location", value: (e) => e.location_name, defaultHidden: !many },
  ], [biz, many]);
  const rows = account ? account.items.flatMap((s) => s.balances.map((b) => ({ ...b, owedMoney: s.owedMoney }))) : [];
  return (
    <div className="stack">
      <BusinessHeader icon="scale" title="Metal account"
        description="Metal from bullion dealers and wholesalers on a metal balance, kept in grams of each purity until its rate is fixed (bhav cut), beside the money owed to them."
        primary={biz.can("jewellery.edit") && biz.can("purchasing.create") && <button type="button" className="button" onClick={() => setDialog({ kind: "move" })}><Icon name="plus" size={16} /> Metal received or given</button>} />
      <ErrorMessage message={error || list.error} />
      <SectionCard icon="scale" title="Owed to suppliers in metal" description="A negative balance: the supplier owes the shop that metal.">
        {!account ? !error && <Loading /> : rows.length === 0 ? <p className="jw-note">No metal on a balance with any supplier.</p> : (
          <table className="jw-rates">
            <thead><tr><th scope="col">Supplier</th><th scope="col">Purity</th><th scope="col">Owed in grams</th><th scope="col">Fine</th><th scope="col">Fixed so far</th><th scope="col">Owed in money</th><th scope="col"><span className="sr-only">Fix</span></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={`${r.contact_id}:${r.metal}:${r.purity}`}><th scope="row">{r.supplier_name}</th><td>{r.mark}</td><td>{grams(r.owed)}</td><td>{grams(r.owed_fine)}</td>
                <td>{Number(r.fixed) ? `${grams(r.fixed)} · ${biz.exact(r.fixed_amount)}` : "—"}</td><td>{biz.exact(r.owedMoney)}</td>
                <td>{Number(r.owed) > 0 && biz.can("jewellery.approve") && biz.can("purchasing.create") && <button type="button" className="link-button" onClick={() => setDialog({ kind: "fix", row: r })}>Fix the rate</button>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </SectionCard>
      <SectionCard flush icon="list" title="Vouchers and fixes">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Voucher, supplier or purchase" }} caption="Metal vouchers and fixes" columns={columns}
          rowNoun={["entry", "entries"]} empty="No metal vouchers yet" emptyIcon="scale" />
      </SectionCard>
      {dialog?.kind === "move" && <MoveForm biz={biz} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "fix" && <FixForm biz={biz} row={dialog.row} onClose={() => setDialog(null)} onSaved={done} />}
    </div>
  );
}
