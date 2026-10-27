import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SidePanel from "../../../../components/SidePanel";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { downloadCsv } from "../../../../services/csv";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, Field } from "../../core/pages/ui";
import { businessToday, dateTime, newKey } from "../../core/pages/hooks";
import { ALL_PURITIES, LABOUR_BASES, PIECE_STATUSES, WORK_KINDS, finenessOf, grams, readHuids, splitPurity } from "./jewellery";
import { printIssueChallan } from "./jewelleryPrint";

// The forms and panels of Karigar work: a karigar (one of the suppliers, with
// the wastage allowed and whether they are registered for GST) and their
// labour rates; an issue challan (metal, pieces to repair, stones) and a
// receipt (pieces made, tagged as they come in; pieces repaired, weighed
// again; scrap and metal; stones), each with its lines; what is left with a
// karigar written off; their labour invoice; and the ITC-04 data. Labour and
// money show to those who see purchases; the server checks every step again.

const issueLine = (kind = "metal") => ({ key: newKey(), kind, purity: "gold:22K", netWeight: "", fineness: "", tag: "", description: "", pieces: "", carat: "", value: "" });
const receiptLine = (kind = "made", skuId = "") => ({ key: newKey(), kind, skuId, tagNo: "", tag: "", gross: "", stone: "", designCode: "", description: "", work: "jewellery",
  labourBasis: "", labourRate: "", hallmarked: false, huids: "", purity: "gold:22K", netWeight: "", fineness: "", pieces: "", carat: "" });
const ISSUE_KINDS = [{ value: "metal", label: "Metal" }, { value: "piece", label: "A piece to repair" }, { value: "stone", label: "Stones" }];
const RECEIPT_KINDS = [{ value: "made", label: "A piece made" }, { value: "repaired", label: "A piece repaired" }, { value: "metal", label: "Scrap or metal" }, { value: "stone", label: "Stones" }];
const optional = (value) => (String(value ?? "").trim() === "" ? undefined : String(value).trim());

// A karigar: a supplier chosen or added, with the wastage allowed on the pieces they make.
export function KarigarForm({ biz, karigar, onClose, onSaved }) {
  const editing = Boolean(karigar);
  const [supplier, setSupplier] = useState(null);
  const [typed, setTyped] = useState(null);
  const [form, setForm] = useState({ wastage: editing ? String(Number(karigar.wastage_percent)) : "0", active: editing ? karigar.active : true, notes: karigar?.notes || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => (editing
    ? businessWrite(biz.id, `jewellery/karigars/${karigar.contact_id}`, { wastagePercent: form.wastage || "0", active: form.active, notes: form.notes.trim() || null }, "put")
    : businessWrite(biz.id, "jewellery/karigars", { ...(supplier ? { contactId: supplier.id } : { supplier: { name: typed?.name?.trim() || "", phone: optional(typed?.phone),
      gstin: optional(typed?.gstin?.toUpperCase()), pan: optional(typed?.pan?.toUpperCase()) } }), wastagePercent: form.wastage || "0", notes: optional(form.notes) }));
  return (
    <FormDialog title={editing ? `Karigar ${karigar.name}` : "A karigar"} icon="user" onClose={onClose} onSubmit={submit} onSaved={onSaved}
      successMessage={editing ? "Saved." : (k) => `${k.name} is a karigar.`}
      description="A karigar is one of the shop's suppliers. Their labour is billed at 5% GST (1.5% for diamond work) when they are registered for GST, and with no GST when they are not.">
      {!editing && (typed ? (
        <>
          <Field label="Name"><input required maxLength={150} value={typed.name} onChange={(e) => setTyped((t) => ({ ...t, name: e.target.value }))} /></Field>
          <Field label="Phone (optional)"><input inputMode="tel" maxLength={30} value={typed.phone} onChange={(e) => setTyped((t) => ({ ...t, phone: e.target.value }))} /></Field>
          <Field label="GSTIN (optional)" hint="Empty: not registered for GST."><input className="mono" maxLength={15} value={typed.gstin} onChange={(e) => setTyped((t) => ({ ...t, gstin: e.target.value }))} /></Field>
          <Field label="PAN (optional)"><input className="mono" maxLength={10} value={typed.pan} onChange={(e) => setTyped((t) => ({ ...t, pan: e.target.value }))} /></Field>
          <div className="field-wide"><button type="button" className="link-button" onClick={() => setTyped(null)}>Choose a supplier instead</button></div>
        </>
      ) : (
        <div className="field-wide jw-row">
          <div className="field jw-grow">
            <SearchPicker label="Supplier" placeholder="Name or phone" value={supplier} onChange={setSupplier} minChars={2}
              search={(q, { signal }) => businessRead(biz.id, "contacts", { kind: "supplier", active: "true", q, limit: 15 }, signal).then((page) => page.items)}
              getLabel={(x) => x.name} getDescription={(x) => [x.phone, x.gstin].filter(Boolean).join(" · ")} />
          </div>
          {biz.can("contacts.create") && <button type="button" className="button button-secondary" onClick={() => { setSupplier(null); setTyped({ name: "", phone: "", gstin: "", pan: "" }); }}><Icon name="user-plus" size={15} /> New supplier</button>}
        </div>
      ))}
      <Field label="Wastage allowed (%)" hint="Of the weight and fine weight of each piece they make, written off on the receipt."><input type="number" min="0" max="25" step="0.01" value={form.wastage} onChange={set("wastage")} /></Field>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Takes work now</label>}
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// The karigar's labour for each jewellery item: per gram of net weight or per piece. An item left empty has no rate.
export function RatesForm({ biz, karigar, items, onClose, onSaved }) {
  const [rows, setRows] = useState(() => items.map((i) => {
    const r = karigar.rates.find((x) => String(x.sku_id) === String(i.sku_id));
    return { skuId: i.sku_id, label: i.label, basis: r?.basis || "per_gram", rate: r ? String(Number(r.rate)) : "" };
  }));
  const setRow = (skuId, change) => setRows((all) => all.map((r) => (r.skuId === skuId ? { ...r, ...change } : r)));
  return (
    <FormDialog title={`${karigar.name}'s labour rates`} icon="tag" width={720} onClose={onClose} onSaved={onSaved} successMessage="Rates saved."
      onSubmit={() => businessWrite(biz.id, `jewellery/karigars/${karigar.contact_id}/rates`, { rates: rows.filter((r) => r.rate !== "").map((r) => ({ skuId: r.skuId, basis: r.basis, rate: r.rate })) }, "put")}
      description="A piece they make is charged at its item's rate unless someone who sees costs types another on the receipt.">
      <table className="jw-rates field-wide">
        <thead><tr><th scope="col">Item</th><th scope="col">Labour by</th><th scope="col">Rate (₹)</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.skuId}>
            <th scope="row">{r.label}</th>
            <td><select aria-label={`${r.label}: labour by`} value={r.basis} onChange={(e) => setRow(r.skuId, { basis: e.target.value })}>{LABOUR_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select></td>
            <td><input aria-label={`${r.label}: rate`} type="number" min="0" step="0.01" value={r.rate} placeholder="No rate" onChange={(e) => setRow(r.skuId, { rate: e.target.value })} /></td>
          </tr>
        ))}</tbody>
      </table>
    </FormDialog>
  );
}

// An issue challan. preset: { contactId, orderId, tags } (a piece sent from its panel, an order's work).
export function IssueForm({ biz, karigars, preset = {}, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const working = karigars.filter((k) => k.active && k.contact_active);
  const money = biz.can("sales.view") || biz.can("purchasing.view");
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState(() => ({ contactId: String(preset.contactId || working[0]?.contact_id || ""), orderId: preset.orderId ? String(preset.orderId) : "",
    locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""), dueOn: "", notes: "" }));
  const [lines, setLines] = useState(() => (preset.tags?.length ? preset.tags.map((tag) => ({ ...issueLine("piece"), tag })) : [issueLine("metal")]));
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/orders", { open: "true", limit: 100 }, controller.signal).then((page) => setOrders(page.items)).catch(() => setOrders([]));
    return () => controller.abort();
  }, [biz.id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const setLine = (key, change) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));
  const body = (l) => (l.kind === "metal" ? { kind: "metal", ...splitPurity(l.purity), netWeight: l.netWeight, fineness: optional(l.fineness), description: optional(l.description) }
    : l.kind === "piece" ? { kind: "piece", tag: l.tag.trim(), description: optional(l.description) }
      : { kind: "stone", description: l.description.trim(), pieces: optional(l.pieces), carat: optional(l.carat), ...(money ? { value: optional(l.value) } : {}) });
  const submit = () => businessWrite(biz.id, "jewellery/karigars/issues", { requestKey, contactId: form.contactId, locationId: form.locationId, orderId: optional(form.orderId),
    dueOn: optional(form.dueOn), notes: optional(form.notes), lines: lines.map(body) });
  if (!working.length) return <FormDialog title="Issue to a karigar" icon="truck" onClose={onClose} onSubmit={() => {}} hideSubmit><p className="field-wide jw-note">Add a karigar first.</p></FormDialog>;
  return (
    <FormDialog title="Issue to a karigar" icon="truck" width={900} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Make the challan"
      successMessage={(i) => `Issue challan ${i.issue_no} made.`}
      description="Metal goes out of the shop's own metal at its fineness; a piece goes out of stock to the karigar and is not sold until it is back on their receipt.">
      <Field label="Karigar"><select required value={form.contactId} onChange={set("contactId")}>{working.map((k) => <option key={k.contact_id} value={k.contact_id}>{k.name}{k.registered ? "" : " (not registered)"}</option>)}</select></Field>
      {locations.length > 1 && <Field label="From"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="For a custom order (optional)"><select value={form.orderId} onChange={set("orderId")}><option value="">The shop's own work</option>
        {orders.map((o) => <option key={o.id} value={o.id}>{o.order_no} · {o.customer_name} · {o.description}</option>)}</select></Field>
      <Field label="Due back (optional)"><input type="date" min={businessToday(biz.business.timezone)} value={form.dueOn} onChange={set("dueOn")} /></Field>
      <div className="field-wide jw-og-lines">
        {lines.map((l, index) => (
          <fieldset key={l.key} className="jw-og-line">
            <legend>Line {index + 1}</legend>
            <div className="jw-row">
              <Field label="What"><select value={l.kind} onChange={(e) => setLine(l.key, { kind: e.target.value })}>{ISSUE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
              {l.kind === "metal" && (
                <>
                  <Field label="Purity"><select value={l.purity} onChange={(e) => setLine(l.key, { purity: e.target.value })}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
                  <Field label="Weight (g)"><input required type="number" min="0.001" step="0.001" value={l.netWeight} onChange={(e) => setLine(l.key, { netWeight: e.target.value })} /></Field>
                  <Field label="Fineness" hint="Parts in a thousand."><input type="number" min="0.1" max="999.9" step="0.1" value={l.fineness} placeholder={String(finenessOf(splitPurity(l.purity).metal, splitPurity(l.purity).purity))} onChange={(e) => setLine(l.key, { fineness: e.target.value })} /></Field>
                </>
              )}
              {l.kind === "piece" && <Field label="Tag"><input required className="mono" maxLength={20} value={l.tag} onChange={(e) => setLine(l.key, { tag: e.target.value.toUpperCase() })} /></Field>}
              {l.kind === "stone" && (
                <>
                  <Field label="How many (optional)"><input type="number" min="1" step="1" value={l.pieces} onChange={(e) => setLine(l.key, { pieces: e.target.value })} /></Field>
                  <Field label="Carats (optional)"><input type="number" min="0.001" step="0.001" value={l.carat} onChange={(e) => setLine(l.key, { carat: e.target.value })} /></Field>
                  {money && <Field label="Value (₹, optional)"><input type="number" min="0" step="0.01" value={l.value} onChange={(e) => setLine(l.key, { value: e.target.value })} /></Field>}
                </>
              )}
            </div>
            <div className="jw-row">
              <Field label={l.kind === "piece" ? "The work to do (optional)" : l.kind === "stone" ? "What the stones are" : "Words (optional)"}>
                <input required={l.kind === "stone"} maxLength={150} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
              </Field>
              {lines.length > 1 && <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>}
            </div>
          </fieldset>
        ))}
        {lines.length < 50 && <button type="button" className="chip-button" onClick={() => setLines((all) => [...all, issueLine("metal")])}><Icon name="plus" size={13} /> Another line</button>}
      </div>
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// A receipt from a karigar. preset: { contactId, issueId }.
export function ReceiveForm({ biz, karigars, items, preset = {}, onClose, onSaved }) {
  const locations = biz.locations.filter((l) => l.active);
  const costs = biz.can("purchasing.view");
  const active = items.filter((i) => i.active);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState(() => ({ contactId: String(preset.contactId || karigars[0]?.contact_id || ""), issueId: preset.issueId ? String(preset.issueId) : "",
    locationId: String(biz.currentLocationId || biz.member.location_id || locations[0]?.id || ""), karigarRef: "", notes: "" }));
  const [lines, setLines] = useState(() => [receiptLine("made", String(active[0]?.sku_id || ""))]);
  const [issues, setIssues] = useState([]);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!form.contactId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/karigars/issues", { karigar: form.contactId, limit: 50 }, controller.signal).then((page) => setIssues(page.items)).catch(() => setIssues([]));
    return () => controller.abort();
  }, [biz.id, form.contactId]);
  // The pieces still out on the challan chosen come back as repairs, to weigh again.
  useEffect(() => {
    if (!form.issueId || touched) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/karigars/issues/${form.issueId}`, undefined, controller.signal).then((issue) => {
      const out = issue.lines.filter((l) => l.kind === "piece" && l.piece_status === "at_karigar");
      if (out.length) setLines(out.map((l) => ({ ...receiptLine("repaired"), tag: l.tag_no, gross: Number(l.gross_weight).toFixed(3), description: l.description || "" })));
    }).catch(() => {});
    return () => controller.abort();
  }, [biz.id, form.issueId, touched]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const setLine = (key, change) => { setTouched(true); setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l))); };
  const labour = (l) => (costs && l.labourRate !== "" ? { labourBasis: l.labourBasis || "per_piece", labourRate: l.labourRate } : {});
  const body = (l) => {
    if (l.kind === "made") {
      return { kind: "made", skuId: l.skuId, tagNo: optional(l.tagNo), description: optional(l.description), designCode: optional(l.designCode), grossWeight: l.gross,
        stoneWeight: optional(l.stone), hallmarked: l.hallmarked, huids: l.hallmarked ? readHuids(l.huids) : [], work: l.work, ...labour(l) };
    }
    if (l.kind === "repaired") return { kind: "repaired", tag: l.tag.trim(), grossWeight: l.gross, stoneWeight: optional(l.stone), description: optional(l.description), work: l.work, ...labour(l) };
    if (l.kind === "metal") return { kind: "metal", ...splitPurity(l.purity), netWeight: l.netWeight, fineness: optional(l.fineness), description: optional(l.description) };
    return { kind: "stone", description: l.description.trim(), pieces: optional(l.pieces), carat: optional(l.carat) };
  };
  const submit = () => businessWrite(biz.id, "jewellery/karigars/receipts", { requestKey, contactId: form.contactId, locationId: form.locationId, issueId: optional(form.issueId),
    karigarRef: optional(form.karigarRef), notes: optional(form.notes), lines: lines.map(body) });
  return (
    <FormDialog title="Receive from a karigar" icon="truck" width={960} onClose={onClose} onSubmit={submit} onSaved={onSaved} submitLabel="Make the receipt"
      successMessage={(r) => `Receipt ${r.receipt_no} made.`}
      description="A piece made is tagged into stock at its labour's cost, with the karigar's wastage allowed on it; a piece repaired is weighed again; scrap and metal go into the shop's metal.">
      <Field label="Karigar"><select required value={form.contactId} onChange={(e) => setForm((f) => ({ ...f, contactId: e.target.value, issueId: "" }))}>{karigars.map((k) => <option key={k.contact_id} value={k.contact_id}>{k.name}</option>)}</select></Field>
      <Field label="Against the challan (optional)"><select value={form.issueId} onChange={set("issueId")}><option value="">Their running account</option>
        {issues.map((i) => <option key={i.id} value={i.id}>{i.issue_no} · {dateShort(i.created_at)}{i.order_no ? ` · order ${i.order_no}` : ""}{i.pieces_out ? ` · ${i.pieces_out} out` : ""}</option>)}</select></Field>
      {locations.length > 1 && <Field label="At"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="Their challan or bill no. (optional)"><input maxLength={60} value={form.karigarRef} onChange={set("karigarRef")} /></Field>
      <div className="field-wide jw-og-lines">
        {lines.map((l, index) => (
          <fieldset key={l.key} className="jw-og-line">
            <legend>Line {index + 1}</legend>
            <div className="jw-row">
              <Field label="What"><select value={l.kind} onChange={(e) => setLine(l.key, { kind: e.target.value, skuId: l.skuId || String(active[0]?.sku_id || "") })}>{RECEIPT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
              {l.kind === "made" && (
                <>
                  <Field label="Item"><select required value={l.skuId} onChange={(e) => setLine(l.key, { skuId: e.target.value })}>{active.map((i) => <option key={i.sku_id} value={i.sku_id}>{i.label}</option>)}</select></Field>
                  <Field label="Tag (optional)" hint="Empty: the next number."><input className="mono" maxLength={20} value={l.tagNo} onChange={(e) => setLine(l.key, { tagNo: e.target.value.toUpperCase() })} /></Field>
                  <Field label="Design code (optional)"><input className="mono" maxLength={40} value={l.designCode} onChange={(e) => setLine(l.key, { designCode: e.target.value.toUpperCase() })} /></Field>
                </>
              )}
              {l.kind === "repaired" && <Field label="Tag"><input required className="mono" maxLength={20} value={l.tag} onChange={(e) => setLine(l.key, { tag: e.target.value.toUpperCase() })} /></Field>}
              {(l.kind === "made" || l.kind === "repaired") && (
                <>
                  <Field label="Gross weight (g)"><input required type="number" min="0.001" step="0.001" value={l.gross} onChange={(e) => setLine(l.key, { gross: e.target.value })} /></Field>
                  <Field label="Stones (g)"><input type="number" min="0" step="0.001" value={l.stone} placeholder={l.kind === "repaired" ? "As it was" : "0"} onChange={(e) => setLine(l.key, { stone: e.target.value })} /></Field>
                </>
              )}
              {l.kind === "metal" && (
                <>
                  <Field label="Purity"><select value={l.purity} onChange={(e) => setLine(l.key, { purity: e.target.value })}>{ALL_PURITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
                  <Field label="Weight (g)"><input required type="number" min="0.001" step="0.001" value={l.netWeight} onChange={(e) => setLine(l.key, { netWeight: e.target.value })} /></Field>
                  <Field label="Fineness"><input type="number" min="0.1" max="999.9" step="0.1" value={l.fineness} placeholder={String(finenessOf(splitPurity(l.purity).metal, splitPurity(l.purity).purity))} onChange={(e) => setLine(l.key, { fineness: e.target.value })} /></Field>
                </>
              )}
              {l.kind === "stone" && (
                <>
                  <Field label="How many (optional)"><input type="number" min="1" step="1" value={l.pieces} onChange={(e) => setLine(l.key, { pieces: e.target.value })} /></Field>
                  <Field label="Carats (optional)"><input type="number" min="0.001" step="0.001" value={l.carat} onChange={(e) => setLine(l.key, { carat: e.target.value })} /></Field>
                </>
              )}
            </div>
            {(l.kind === "made" || l.kind === "repaired") && (
              <div className="jw-row">
                <Field label="Work"><select value={l.work} onChange={(e) => setLine(l.key, { work: e.target.value })}>{WORK_KINDS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}</select></Field>
                {costs && (
                  <>
                    <Field label="Labour by"><select value={l.labourBasis || "per_piece"} onChange={(e) => setLine(l.key, { labourBasis: e.target.value })}>{LABOUR_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select></Field>
                    <Field label="Labour rate (₹)" hint={l.kind === "made" ? "Empty: the karigar's rate for the item." : "Empty: no labour."}><input type="number" min="0" step="0.01" value={l.labourRate} onChange={(e) => setLine(l.key, { labourRate: e.target.value })} /></Field>
                  </>
                )}
                {l.kind === "made" && <label className="checkbox bz-check"><input type="checkbox" checked={l.hallmarked} onChange={(e) => setLine(l.key, { hallmarked: e.target.checked })} /> Hallmarked by BIS</label>}
                {l.kind === "made" && l.hallmarked && <Field label="HUIDs"><input className="mono" value={l.huids} onChange={(e) => setLine(l.key, { huids: e.target.value })} /></Field>}
              </div>
            )}
            <div className="jw-row">
              <Field label={l.kind === "stone" ? "What the stones are" : l.kind === "made" ? "Words on the bill (optional)" : "Words (optional)"}>
                <input required={l.kind === "stone"} maxLength={150} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
              </Field>
              {lines.length > 1 && <button type="button" className="link-button danger" onClick={() => { setTouched(true); setLines((all) => all.filter((x) => x.key !== l.key)); }}>Remove</button>}
            </div>
          </fieldset>
        ))}
        {lines.length < 50 && <button type="button" className="chip-button" onClick={() => { setTouched(true); setLines((all) => [...all, receiptLine("made", String(active[0]?.sku_id || ""))]); }}><Icon name="plus" size={13} /> Another line</button>}
      </div>
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

function WriteOffForm({ biz, karigar, row, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`Write off ${karigar.name}'s ${row.mark}`} icon="alert" onClose={onClose} onSaved={onSaved} submitLabel="Write it off" successMessage="Written off."
      description={`All they still hold of ${row.label}: ${grams(row.held)} (${grams(row.heldFine)} fine). It leaves the fine-weight book as the work's actual wastage.`}
      onSubmit={() => businessWrite(biz.id, `jewellery/karigars/${karigar.contact_id}/write-off`, { requestKey, metal: row.metal, purity: row.purity, reason: reason.trim() })}>
      <Field label="Why" wide><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Melting loss on the bridal set" /></Field>
    </FormDialog>
  );
}

function InvoiceForm({ biz, karigar, onClose, onSaved }) {
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ billNo: "", billDate: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`${karigar.name}'s labour invoice`} icon="receipt" onClose={onClose} onSaved={onSaved} submitLabel="Post the purchase"
      successMessage={(v) => `Purchase ${v.document_no}: ${biz.exact(v.total)}.`}
      description={`${biz.exact(karigar.money.toInvoice)} of labour not billed yet, as a purchase from the karigar: ${karigar.registered ? "5% GST on jewellery work and 1.5% on diamond work" : "no GST: they are not registered"}.`}
      onSubmit={() => businessWrite(biz.id, "jewellery/karigars/invoices", { requestKey, contactId: karigar.contact_id, supplierBillNo: optional(form.billNo), supplierBillDate: optional(form.billDate), notes: optional(form.notes) })}>
      <Field label="Their bill no. (optional)"><input maxLength={60} value={form.billNo} onChange={set("billNo")} /></Field>
      <Field label="Their bill's date (optional)"><input type="date" value={form.billDate} onChange={set("billDate")} /></Field>
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}

// A karigar's panel: their account of metal by purity (issued, back, the wastage allowed against the actual), pieces held, labour and money.
export function KarigarPanel({ biz, contactId, items, onClose, onChanged, onIssue, onReceive, onOpenIssue, onOpenReceipt }) {
  const [karigar, setKarigar] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/karigars/${contactId}`, undefined, controller.signal).then((k) => { setKarigar(k); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version]);
  const done = () => { setDialog(null); setVersion((n) => n + 1); onChanged?.(); };
  return (
    <SidePanel open title={karigar ? karigar.name : "Karigar"} icon="user" wide onClose={onClose}
      footer={karigar && (
        <div className="jw-panel-actions">
          {biz.can("jewellery.edit") && karigar.active && <button type="button" className="button" onClick={() => onIssue(karigar)}><Icon name="truck" size={15} /> Issue</button>}
          {biz.can("jewellery.edit") && <button type="button" className="button button-secondary" onClick={() => onReceive(karigar)}>Receive</button>}
          {karigar.money && Number(karigar.money.toInvoice) > 0 && biz.can("jewellery.edit") && biz.can("purchasing.create") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "invoice" })}><Icon name="receipt" size={15} /> Labour invoice</button>}
          {biz.can("jewellery.approve") && biz.can("purchasing.view") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "rates" })}>Labour rates</button>}
          {biz.can("jewellery.approve") && <button type="button" className="button button-secondary" onClick={() => setDialog({ kind: "edit" })}><Icon name="edit" size={15} /> Change</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!karigar ? !error && <Loading /> : (
        <div className="stack">
          <dl className="jw-facts">
            {[["Phone", karigar.phone], ["GST", karigar.registered ? `Registered · ${karigar.gstin}` : "Not registered: no GST on their labour"], ["Wastage allowed", `${Number(karigar.wastage_percent)}% of each piece made`],
              ["Takes work", karigar.active ? "Yes" : "No: switched off"], ["Notes", karigar.notes]].filter(([, v]) => v).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <section>
            <h3 className="jw-subhead">Metal with them, in fine weight</h3>
            {karigar.account.length === 0 ? <p className="jw-note">Nothing issued to them yet.</p> : (
              <table className="jw-rates">
                <thead><tr><th scope="col">Purity</th><th scope="col">Issued</th><th scope="col">Back in pieces</th><th scope="col">Scrap and metal</th><th scope="col">Repairs</th>
                  <th scope="col">Wastage allowed</th><th scope="col">Written off</th><th scope="col">Held now</th><th scope="col">Actual wastage</th><th scope="col"><span className="sr-only">Write off</span></th></tr></thead>
                <tbody>{karigar.account.map((a) => (
                  <tr key={`${a.metal}:${a.purity}`}><th scope="row">{a.mark}</th><td>{grams(a.issuedFine)}</td><td>{grams(a.madeFine)}</td><td>{grams(a.returnedFine)}</td><td>{grams(a.repairsFine)}</td>
                    <td>{grams(a.allowedFine)}</td><td>{grams(a.writtenOffFine)}</td><td><strong>{grams(a.heldFine)}</strong><small className="muted"> ({grams(a.held)})</small></td><td>{grams(a.actualWastageFine)}</td>
                    <td>{(Number(a.held) !== 0 || Number(a.heldFine) !== 0) && biz.can("jewellery.approve") && <button type="button" className="link-button" onClick={() => setDialog({ kind: "writeoff", row: a })}>Write off</button>}</td></tr>
                ))}</tbody>
              </table>
            )}
            <p className="muted small">Actual wastage is what the pieces, scrap and repairs do not account for: the wastage allowed, what was written off and what they still hold.</p>
          </section>
          {karigar.held.length > 0 && (
            <section>
              <h3 className="jw-subhead">Pieces with them</h3>
              <ul className="jw-history">{karigar.held.map((p) => <li key={p.id}><span className="mono">{p.tag_no}</span><span>{p.description || p.item_label} · {grams(p.net_weight)} · {p.out_no}{p.out_due ? ` · due ${dateShort(p.out_due)}` : ""}</span></li>)}</ul>
            </section>
          )}
          {karigar.costs && karigar.rates.length > 0 && (
            <section>
              <h3 className="jw-subhead">Labour rates</h3>
              <ul className="jw-history">{karigar.rates.map((r) => <li key={r.sku_id}><span>{r.label}</span><span>{biz.exact(r.rate)} {r.basis === "per_gram" ? "a gram" : "a piece"}</span></li>)}</ul>
            </section>
          )}
          {karigar.money && (
            <section>
              <h3 className="jw-subhead">Labour and money</h3>
              <dl className="jw-facts">
                {[["Labour on receipts", biz.exact(karigar.money.labour)], ["Invoiced", biz.exact(karigar.money.invoiced)], ["Not invoiced yet", biz.exact(karigar.money.toInvoice)],
                  ["Paid", biz.exact(karigar.money.paid)], ["The shop owes them", biz.exact(karigar.money.owed)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
              </dl>
              {karigar.money.invoices.length > 0 && <ul className="jw-history">{karigar.money.invoices.map((v) => <li key={v.id}><span>{dateTime(v.created_at)} · {v.document_no}{v.supplier_bill_no ? ` (${v.supplier_bill_no})` : ""}</span><span>{biz.exact(v.total)}</span></li>)}</ul>}
            </section>
          )}
          <section>
            <h3 className="jw-subhead">Challans and receipts</h3>
            <ul className="jw-history">
              {karigar.issues.map((i) => <li key={`i${i.id}`}><span>{dateTime(i.created_at)}</span><button type="button" className="link-button" onClick={() => onOpenIssue(i.id)}>Issue {i.issue_no}{i.pieces_out ? ` · ${i.pieces_out} out` : ""}</button></li>)}
              {karigar.receipts.map((r) => <li key={`r${r.id}`}><span>{dateTime(r.created_at)}</span><button type="button" className="link-button" onClick={() => onOpenReceipt(r.id)}>Receipt {r.receipt_no}{r.unbilled && Number(r.unbilled) > 0 ? ` · ${biz.exact(r.unbilled)} to invoice` : ""}</button></li>)}
            </ul>
          </section>
        </div>
      )}
      {dialog?.kind === "edit" && <KarigarForm biz={biz} karigar={karigar} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "rates" && <RatesForm biz={biz} karigar={karigar} items={items} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "writeoff" && <WriteOffForm biz={biz} karigar={karigar} row={dialog.row} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === "invoice" && <InvoiceForm biz={biz} karigar={karigar} onClose={() => setDialog(null)} onSaved={done} />}
    </SidePanel>
  );
}

// An issue challan's panel, with its print and its receipts.
export function IssuePanel({ biz, issueId, onClose, onReceive, onOpenReceipt }) {
  const [issue, setIssue] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/karigars/issues/${issueId}`, undefined, controller.signal).then((i) => { setIssue(i); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, issueId]);
  return (
    <SidePanel open title={issue ? `Issue challan ${issue.issue_no}` : "Issue challan"} icon="truck" wide onClose={onClose}
      footer={issue && (
        <div className="jw-panel-actions">
          {biz.can("jewellery.edit") && <button type="button" className="button" onClick={() => onReceive(issue)}>Receive against it</button>}
          {biz.can("jewellery.print") && <button type="button" className="button button-secondary" onClick={() => printIssueChallan(biz, issue)}><Icon name="print" size={15} /> Print the challan</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!issue ? !error && <Loading /> : (
        <div className="stack">
          <dl className="jw-facts">
            {[["Karigar", issue.karigar_name], ["Made", `${dateTime(issue.created_at)} · ${issue.by_name}`], ["Due back", issue.due_on ? dateShort(issue.due_on, { year: true }) : null],
              ["For order", issue.order_no], ["Metal", Number(issue.metal_net) ? `${grams(issue.metal_net)} (${grams(issue.metal_fine)} fine)` : null], ["Notes", issue.notes]]
              .filter(([, v]) => v).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <table className="jw-rates">
            <thead><tr><th scope="col">What</th><th scope="col">Purity</th><th scope="col">Weight</th><th scope="col">Fine</th><th scope="col">Now</th></tr></thead>
            <tbody>{issue.lines.map((l) => (
              <tr key={l.seq}><th scope="row">{l.kind_words}{l.tag_no ? ` ${l.tag_no}` : ""}{l.description ? <small className="muted"> · {l.description}</small> : null}</th><td>{l.mark || "—"}</td>
                <td>{l.net_weight === null ? (l.pieces ? `${l.pieces}` : "—") : grams(l.net_weight)}</td><td>{l.fine_weight === null ? (l.carat ? `${Number(l.carat).toFixed(3)} ct` : "—") : grams(l.fine_weight)}</td>
                <td>{l.piece_status ? PIECE_STATUSES[l.piece_status]?.label || l.piece_status : ""}</td></tr>
            ))}</tbody>
          </table>
          {issue.receipts.length > 0 && <ul className="jw-history">{issue.receipts.map((r) => <li key={r.id}><span>{dateTime(r.created_at)}</span><button type="button" className="link-button" onClick={() => onOpenReceipt(r.id)}>Receipt {r.receipt_no}</button></li>)}</ul>}
        </div>
      )}
    </SidePanel>
  );
}

export function ReceiptPanel({ biz, receiptId, onClose }) {
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `jewellery/karigars/receipts/${receiptId}`, undefined, controller.signal).then((r) => { setReceipt(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, receiptId]);
  return (
    <SidePanel open title={receipt ? `Receipt ${receipt.receipt_no}` : "Receipt"} icon="truck" wide onClose={onClose}>
      <ErrorMessage message={error} />
      {!receipt ? !error && <Loading /> : (
        <div className="stack">
          <dl className="jw-facts">
            {[["Karigar", receipt.karigar_name], ["Made", `${dateTime(receipt.created_at)} · ${receipt.by_name}`], ["Against", receipt.issue_no ? `Issue ${receipt.issue_no}` : "Their running account"],
              ["Their challan", receipt.karigar_ref], ["Labour", receipt.costs ? biz.exact(receipt.labour) : null], ["Not invoiced yet", receipt.costs && Number(receipt.unbilled) ? biz.exact(receipt.unbilled) : null],
              ["Notes", receipt.notes]].filter(([, v]) => v).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <table className="jw-rates">
            <thead><tr><th scope="col">What</th><th scope="col">Weight</th><th scope="col">Fine</th><th scope="col">Wastage allowed</th>{receipt.costs && <th scope="col">Labour</th>}</tr></thead>
            <tbody>{receipt.lines.map((l) => (
              <tr key={l.seq}><th scope="row">{l.kind_words}{l.tag_no ? ` ${l.tag_no}` : ""}{l.order_no ? <small className="muted"> · order {l.order_no}</small> : null}{l.description ? <small className="muted"> · {l.description}</small> : null}</th>
                <td>{l.net_weight === null ? (l.pieces ? `${l.pieces}` : "—") : `${grams(l.net_weight)}${l.before_net_weight ? ` (was ${grams(l.before_net_weight)})` : ""}`}</td>
                <td>{l.fine_weight === null ? "—" : grams(l.fine_weight)}</td><td>{Number(l.wastage_weight) ? `${grams(l.wastage_weight)} (${grams(l.wastage_fine)} fine)` : "—"}</td>
                {receipt.costs && <td>{Number(l.labour) ? `${biz.exact(l.labour)}${l.work_words ? ` · ${l.work_words}` : ""}` : "—"}</td>}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </SidePanel>
  );
}

// The ITC-04 data over a period: goods sent to job workers (table 4) and received back (table 5A), with the wastage.
export function Itc04Panel({ biz, onClose }) {
  const today = businessToday(biz.business.timezone);
  const [period, setPeriod] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/karigars/itc-04", period, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, period]);
  const columns = ["Part", "Table", "Day", "Challan", "Original challan", "Original day", "Job worker", "GSTIN", "Goods", "UQC", "Quantity", "Fine g", "Value"];
  const download = () => downloadCsv([columns, ...data.rows.map((r) => [r.part, r.table, r.day, r.challanNo, r.originalNo || "", r.originalDay || "", r.karigar, r.gstin || "", r.goods, r.uqc,
    r.quantity, r.fineWeight || "", r.value || ""])], `itc-04-${data.from}-${data.to}.csv`);
  const shown = useMemo(() => data?.rows || [], [data]);
  return (
    <SidePanel open title="ITC-04 data" icon="file" wide onClose={onClose} rule={data?.note}
      toolbar={<div className="jw-row"><Field label="From"><input type="date" value={period.from} max={period.to} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} /></Field>
        <Field label="To"><input type="date" value={period.to} min={period.from} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} /></Field>
        <button type="button" className="button button-secondary" disabled={!shown.length} onClick={download}><Icon name="download" size={15} /> Download CSV</button></div>}>
      <ErrorMessage message={error} />
      {!data ? !error && <Loading /> : shown.length === 0 ? <p className="jw-note">Nothing went to or came back from a karigar in this period.</p> : (
        <table className="jw-rates">
          <thead><tr><th scope="col">Table</th><th scope="col">Day</th><th scope="col">Challan</th><th scope="col">Job worker</th><th scope="col">Goods</th><th scope="col">Quantity</th><th scope="col">Fine</th></tr></thead>
          <tbody>{shown.map((r, index) => (
            <tr key={`${r.challanNo}:${index}`}><td>{r.table}{r.part === "wastage" ? " · wastage" : ""}</td><td>{dateShort(r.day)}</td><td className="mono">{r.challanNo}{r.originalNo ? <small className="muted"> · of {r.originalNo}</small> : null}</td>
              <td>{r.karigar}{r.gstin ? <small className="muted"> · {r.gstin}</small> : null}</td><td>{r.goods}</td><td>{r.quantity} {r.uqc}</td><td>{r.fineWeight ? grams(r.fineWeight) : "—"}</td></tr>
          ))}</tbody>
        </table>
      )}
    </SidePanel>
  );
}

// Badges for a karigar in a list.
export const KarigarBadge = ({ karigar }) => (karigar.active ? <Badge tone={karigar.registered ? "success" : "neutral"} label={karigar.registered ? "Registered" : "Not registered"} /> : <Badge tone="neutral" label="Switched off" />);
