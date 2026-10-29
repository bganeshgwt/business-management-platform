import { useEffect, useMemo, useState } from "react";
import ContentTabs from "../../../../components/ContentTabs";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { printRegister } from "./agriPrint";
import "../styles/agri.css";

// Stock kept apart: none of it can be sold, each taken out of stock by a
// stock adjustment.
//   Expired: a batch past its expiry, segregated and marked not for sale
//     until it is disposed of as the Centre specifies (Insecticides Rules
//     1971, rule 10A). This tab is the register of expired stock.
//   Seized: taken by an inspector, with the seizure receipt; closed when the
//     seizure ends, or released back into the batch it came from.
//   Sampled: drawn by an inspector, with the sample slip; closed with what
//     came of it.

const KINDS = [
  { value: "expired", label: "Expired", title: "Expired stock (rule 10A)", verb: "Dispose of it", closeWord: "Disposed of" },
  { value: "seized", label: "Seized", title: "Seized by an inspector", verb: "Close the seizure", closeWord: "Closed" },
  { value: "sampled", label: "Sampled", title: "Samples drawn", verb: "Close the sample", closeWord: "Closed" },
];
const STATUS = { held: { tone: "warning", label: "Kept apart" }, closed: { tone: "neutral", label: "Closed" }, released: { tone: "success", label: "Released" } };

export default function KeptApartPage() {
  const biz = useOpenBusiness();
  const [kind, setKind] = useState("expired");
  const [heldOnly, setHeldOnly] = useState(true);
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState(null);
  const canEdit = biz.can("inventory.edit");
  const locations = biz.locations.filter((l) => l.active);
  const k = KINDS.find((x) => x.value === kind);
  const list = useServerList("agri/kept-apart", { gridId: `agri-kept-apart-${kind}`, params: { kind, ...(heldOnly ? { status: "held" } : {}) } });
  const columns = useMemo(() => [
    { key: "held_on", header: "Kept apart", type: "date", value: (h) => h.held_on, mobile: "subtitle" },
    { key: "label", header: "Item", value: (h) => h.label, mobile: "title", pin: true },
    { key: "lot_code", header: "Batch", value: (h) => h.lot_code || "", className: "mono" },
    { key: "expires_on", header: "Expiry", type: "date", value: (h) => h.expires_on, defaultHidden: kind !== "expired" },
    locations.length > 1 && { key: "location_name", header: "At", value: (h) => h.location_name },
    { key: "quantity", header: "Quantity", type: "number", value: (h) => Number(h.quantity), render: (h) => quantity(h.quantity, h.unit), mobile: "show" },
    kind !== "expired" && { key: "officer", header: "Inspector", value: (h) => h.officer || "" },
    kind !== "expired" && { key: "officer_reference", header: kind === "sampled" ? "Sample slip" : "Seizure receipt", value: (h) => h.officer_reference || "", className: "mono" },
    { key: "status", header: "State", value: (h) => STATUS[h.status]?.label, render: (h) => <Badge {...STATUS[h.status]} /> },
    { key: "closed_on", header: kind === "expired" ? "Disposed of" : "Closed", type: "date", value: (h) => h.closed_on },
    { key: "closed_how", header: kind === "expired" ? "How" : "What came of it", value: (h) => h.closed_how || "" },
    { key: "closed_reference", header: "Reference", value: (h) => h.closed_reference || "", defaultHidden: true },
    { key: "notes", header: "Notes", value: (h) => h.notes || "", defaultHidden: true },
    { key: "created_by_name", header: "Kept apart by", value: (h) => h.created_by_name, defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (h) => canEdit && h.status === "held" && (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={() => setClosing({ hold: h, how: "closed" })}>{k.verb}</button>
        {kind === "seized" && <button type="button" className="chip-button" onClick={() => setClosing({ hold: h, how: "released" })}>Release it</button>}
      </span>
    ) },
  ].filter(Boolean), [canEdit, kind, k, locations.length]);
  async function print() {
    try {
      const rows = await list.gridProps.server.fetchAll();
      printRegister({
        biz, title: "Register of expired insecticides", period: heldOnly ? "Still kept apart" : "Every entry", rows,
        note: "Kept apart from other stock and marked not for sale, until disposed of as the Central Government specifies (Insecticides Rules 1971, rule 10A).",
        columns: [
          ["Date kept apart", (h) => dateShort(h.held_on, { year: true })], ["Item", (h) => h.label], ["Batch", (h) => h.lot_code], ["Expiry", (h) => (h.expires_on ? dateShort(h.expires_on, { year: true }) : "")],
          ["Quantity", (h) => quantity(h.quantity, h.unit)], ["Location", (h) => h.location_name], ["Disposed of on", (h) => (h.closed_on ? dateShort(h.closed_on, { year: true }) : "")],
          ["How", (h) => h.closed_how || ""], ["Reference", (h) => h.closed_reference || ""],
        ],
      });
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }
  return (
    <div className="stack">
      <BusinessHeader icon="lock" title="Stock kept apart"
        description="Stock that is not for sale: expired batches until they are disposed of (rule 10A), stock seized by an inspector, and samples drawn. Each comes out of stock as it is kept apart."
        primary={canEdit && <button type="button" className="button" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Keep stock apart</button>} />
      <ContentTabs label="Kept apart" value={kind} options={KINDS} onChange={setKind}>
        <ErrorMessage message={list.error} />
        <SectionCard flush icon="lock" title={k.title}
          actions={kind === "expired" && biz.can("inventory.view") && <button type="button" className="button button-secondary button-sm" onClick={print}><Icon name="print" size={14} /> Print the register</button>}>
          <DataGrid {...list.gridProps} caption={k.title} columns={columns} rowNoun={["entry", "entries"]}
            toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={heldOnly} onChange={(e) => setHeldOnly(e.target.checked)} /> Still kept apart only</label>}
            exportName={biz.can("inventory.export") ? `${biz.business.code}-kept-apart-${kind}` : undefined}
            empty={heldOnly ? "Nothing kept apart" : "Nothing yet"}
            emptyHint={kind === "expired" ? "Keep an expired batch apart here: it comes out of stock and goes in the register until it is disposed of." : "Keep stock apart here when an inspector seizes it or draws a sample."}
            emptyIcon="lock" />
        </SectionCard>
      </ContentTabs>
      {adding && <KeepApartDialog kind={kind} onClose={() => setAdding(false)}
        onSaved={(h) => { setAdding(false); setKind(h.kind); list.reload(); toast.success(`${quantity(h.quantity, h.unit)} of ${h.label} kept apart: it cannot be sold.`); }} />}
      {closing && <CloseDialog hold={closing.hold} how={closing.how} onClose={() => setClosing(null)}
        onSaved={(h) => { setClosing(null); list.reload(); toast.success(h.status === "released" ? `${h.label} released back into stock.` : `${h.label}: closed.`); }} />}
    </div>
  );
}

function KeepApartDialog({ kind: start, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const locations = biz.locations.filter((l) => l.active);
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ kind: start, locationId: String(biz.currentLocationId || locations[0]?.id || ""), search: "", lotId: "", quantity: "", officer: "", officerReference: "", notes: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const [lots, setLots] = useState({ key: "", rows: [] });
  const key = JSON.stringify([form.locationId, form.search.trim()]);
  useEffect(() => {
    if (!form.locationId) return undefined;
    const [locationId, q] = JSON.parse(key);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessRead(biz.id, "stock", { location: locationId, in_stock: "true", ...(q ? { q } : {}), limit: 50 }, controller.signal)
        .then((page) => setLots({ key, rows: page.items }))
        .catch(() => { if (!controller.signal.aborted) setLots({ key, rows: [] }); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [biz.id, form.locationId, key]);
  // Only batches past their expiry are kept apart as expired.
  const choices = lots.rows.filter((l) => form.kind !== "expired" || (l.expires_on && l.expires_on < today));
  const lot = choices.find((l) => String(l.id) === form.lotId);
  const submit = () => businessWrite(biz.id, "agri/kept-apart", { requestKey, kind: form.kind, lotId: form.lotId, quantity: form.quantity,
    ...(form.kind === "expired" ? {} : { officer: form.officer.trim(), officerReference: form.officerReference.trim() }), notes: form.notes.trim() || null });
  const k = KINDS.find((x) => x.value === form.kind);
  return (
    <FormDialog title="Keep stock apart" icon="lock" width={680} submitLabel="Keep it apart" onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description="It comes out of stock now, so it cannot be sold, and stays on this list until it is closed.">
      <Field label="Kept apart as">
        <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value, lotId: "" }))}>{KINDS.map((x) => <option key={x.value} value={x.value}>{x.title}</option>)}</select>
      </Field>
      {locations.length > 1 && (
        <Field label="At">
          <select value={form.locationId} onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value, lotId: "" }))}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        </Field>
      )}
      <Field label="Find the item or batch" wide><input type="search" value={form.search} onChange={set("search")} placeholder="Item name, code or batch number" /></Field>
      <Field label="Batch" wide hint={form.kind === "expired" ? "Only batches past their expiry show." : undefined}>
        <select required value={form.lotId} onChange={set("lotId")}>
          <option value="">{lots.key === key ? (choices.length ? "Choose the batch…" : "No batch found") : "Looking…"}</option>
          {choices.map((l) => <option key={l.id} value={l.id}>{l.label}{l.lot_code ? ` · ${l.lot_code}` : ""}{l.expires_on ? ` · expiry ${dateShort(l.expires_on, { year: true })}` : ""} · {quantity(l.quantity, l.unit)}</option>)}
        </select>
      </Field>
      <Field label={lot ? `Quantity (${lot.unit})` : "Quantity"}>
        <input type="number" required min="0.001" max={lot ? Number(lot.quantity) : undefined} step="0.001" inputMode="decimal" value={form.quantity} onChange={set("quantity")} />
      </Field>
      {lot && <button type="button" className="link-button bz-link-left" onClick={() => setForm((f) => ({ ...f, quantity: String(Number(lot.quantity)) }))}>All of it: {quantity(lot.quantity, lot.unit)}</button>}
      {form.kind !== "expired" && (
        <>
          <Field label="Inspector"><input required maxLength={150} value={form.officer} onChange={set("officer")} /></Field>
          <Field label={form.kind === "sampled" ? "Sample slip number" : "Seizure receipt number"}><input required maxLength={80} className="mono" value={form.officerReference} onChange={set("officerReference")} /></Field>
        </>
      )}
      <Field label="Notes (optional)" wide><input maxLength={300} value={form.notes} onChange={set("notes")} placeholder={k.value === "expired" ? "e.g. on the top shelf of the back room, marked not for sale" : undefined} /></Field>
    </FormDialog>
  );
}

function CloseDialog({ hold, how, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ on: today, details: "", reference: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const k = KINDS.find((x) => x.value === hold.kind);
  const released = how === "released";
  const submit = () => businessWrite(biz.id, `agri/kept-apart/${hold.id}/close`, { requestKey, how, on: form.on, details: form.details.trim(), reference: form.reference.trim() || null });
  return (
    <FormDialog title={released ? `Release ${hold.label}` : `${hold.label}: ${k.verb.toLowerCase()}`} icon={released ? "unlock" : "check"} width={600}
      submitLabel={released ? "Release it" : "Close it"} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={released ? `${quantity(hold.quantity, hold.unit)} goes back into batch ${hold.lot_code || "it came from"} at ${hold.location_name}, for sale again.`
        : `${quantity(hold.quantity, hold.unit)} kept apart on ${dateShort(hold.held_on, { year: true })}. It stays out of stock.`}>
      <Field label={hold.kind === "expired" ? "Disposed of on" : "On"}><input type="date" required min={hold.held_on} max={today} value={form.on} onChange={set("on")} /></Field>
      <Field label="Reference (optional)"><input maxLength={80} className="mono" value={form.reference} onChange={set("reference")} placeholder={released ? "The release order's number" : undefined} /></Field>
      <Field label={released ? "The release order" : hold.kind === "expired" ? "How it was disposed of" : "What came of it"} wide>
        <input required maxLength={300} value={form.details} onChange={set("details")}
          placeholder={hold.kind === "expired" ? "e.g. returned to the company for destruction, debit note 41" : hold.kind === "sampled" ? "e.g. sample found standard" : undefined} />
      </Field>
    </FormDialog>
  );
}
