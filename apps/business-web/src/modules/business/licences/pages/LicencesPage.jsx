import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { dateShort } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { CATEGORY_WORDS, usesAgri } from "../../agri/pages/agri";

// Licences & registrations: what each location holds, its number, the
// authority, the dates it is valid and the days it has left. The bell warns
// 60 days before one runs out. A licence is renewed by giving its new date,
// and switched off when surrendered or cancelled; it is never deleted.
// A farm-input shop's bills of fertilisers, seeds and pesticides need a
// licence in force covering them at the selling location.

// The kinds this screen offers, those of the business's own trade first.
const KINDS = [
  { value: "fertiliser", name: "Fertiliser authorisation letter (Form A2)", covers: ["fertiliser"], types: ["agri_inputs"] },
  { value: "seed", name: "Seed dealer licence (Form B)", covers: ["seed"], types: ["agri_inputs"] },
  { value: "insecticide", name: "Insecticide sale licence (Form VIII)", covers: ["insecticide"], types: ["agri_inputs"] },
  { value: "md42", name: "Medical device sale registration (MD-42)", types: ["optical"] },
  { value: "bis", name: "BIS registration (hallmarking)", types: ["jewellery"] },
  { value: "peso", name: "PESO licence (Form XIV)", types: ["fuel_station"] },
  // Self-drive cars and motorcycles go out only while the location holds one in force.
  { value: "rent_a_cab", name: "Rent-a-cab licence (State Transport Authority)", types: ["rentals"] },
  { value: "rent_a_motorcycle", name: "Rent-a-motorcycle licence (State Transport Authority)", types: ["rentals"] },
  { value: "trade", name: "Trade licence" },
  { value: "shop", name: "Shops & establishments registration" },
  { value: "fssai", name: "FSSAI registration or licence" },
  { value: "other", name: "" },
];
const kindsFor = (type) => [...KINDS.filter((k) => k.types?.includes(type)), ...KINDS.filter((k) => !k.types)];
const kindName = (kind) => KINDS.find((k) => k.value === kind)?.name || (kind === "other" ? "Other licence" : kind);
const STATES = {
  valid: { label: "Valid", tone: "success" }, no_expiry: { label: "No expiry", tone: "success" }, expiring: { label: "Runs out soon", tone: "warning" },
  expired: { label: "Run out", tone: "danger" }, not_yet: { label: "Not yet valid", tone: "info" }, off: { label: "Switched off", tone: "neutral" },
};
const daysWords = (n) => (n === null || n === undefined ? "" : n < 0 ? `Ran out ${-n} day${n === -1 ? "" : "s"} ago` : n === 0 ? "Last day" : `${n} day${n === 1 ? "" : "s"} left`);

export default function LicencesPage() {
  const biz = useOpenBusiness();
  const [location, setLocation] = useState("");
  const [showOff, setShowOff] = useState(false);
  const list = useServerList("licences", { gridId: "business-licences", params: { ...(location ? { location } : {}), ...(showOff ? {} : { active: "true" }) } });
  const [editing, setEditing] = useState(null);
  const canEdit = biz.can("licences.edit");
  const many = biz.locations.length > 1;
  const agri = usesAgri(biz);

  const columns = useMemo(() => [
    { key: "name", header: "Licence", value: (l) => l.name, mobile: "title", pin: true, minWidth: 220,
      render: (l) => <span className="bz-two-line"><strong>{l.name}</strong><small className="muted">{l.authority || kindName(l.kind)}</small></span> },
    { key: "licence_no", header: "Number", value: (l) => l.licence_no, className: "mono", mobile: "subtitle" },
    many && { key: "location", header: "Location", value: (l) => l.location_name },
    { key: "valid_from", header: "Valid from", type: "date", value: (l) => l.valid_from },
    { key: "valid_until", header: "Valid until", type: "date", value: (l) => l.valid_until,
      render: (l) => (l.valid_until ? dateShort(l.valid_until, { year: true }) : <span className="muted">No expiry</span>) },
    { key: "days_left", header: "Days left", type: "number", value: (l) => (l.days_left === null ? null : Number(l.days_left)),
      render: (l) => (l.days_left === null || l.state === "off" ? <span className="muted">—</span> : daysWords(Number(l.days_left))), mobile: "show" },
    { key: "state", header: "Status", type: "status", value: (l) => STATES[l.state]?.label || l.state, render: (l) => <Badge tone={STATES[l.state]?.tone} label={STATES[l.state]?.label || l.state} /> },
    agri && { key: "covers", header: "Covers", value: (l) => (l.covers || []).map((c) => CATEGORY_WORDS[c] || c).join(", "),
      render: (l) => (l.covers?.length ? l.covers.map((c) => CATEGORY_WORDS[c] || c).join(", ") : <span className="muted">—</span>) },
    { key: "notes", header: "Notes", value: (l) => l.notes || "", defaultHidden: true },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => <button type="button" className="chip-button" onClick={() => setEditing(l)}>Edit</button> },
  ].filter(Boolean), [many, agri, canEdit]);

  return (
    <div className="stack">
      <BusinessHeader icon="shield" title="Licences"
        description={`The licences and registrations each location holds, with their numbers and the dates they are valid. The bell warns 60 days before one runs out.${agri ? " Bills of fertilisers, seeds and pesticides at a location need its licence in force that covers them." : ""}`}
        primary={canEdit && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add a licence</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="shield" title="Licences & registrations">
        <DataGrid {...list.gridProps} caption="Licences" columns={columns} rowNoun={["licence", "licences"]}
          toolbar={(
            <>
              {many && (
                <label className="field">
                  <span>Location</span>
                  <select value={location} onChange={(e) => setLocation(e.target.value)}>
                    <option value="">Every location</option>
                    {biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              )}
              <label className="checkbox bz-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show switched-off licences</label>
            </>
          )}
          rowClassName={(l) => (l.state === "off" ? "dg-tone-muted" : l.state === "expired" ? "dg-tone-danger" : l.state === "expiring" ? "dg-tone-warning" : "")}
          exportName={biz.can("reports.export") ? `${biz.business.code}-licences` : undefined}
          empty="No licences kept yet" emptyHint={canEdit ? "Add each licence the location holds, with its number and the date it runs out." : "Licences appear here once they are added."} emptyIcon="shield" />
      </SectionCard>
      {editing && <LicenceDialog licence={editing} onClose={() => setEditing(null)}
        onSaved={(l) => { setEditing(null); toast.success(`${l.name} saved.`); list.reload(); }} />}
    </div>
  );
}

function LicenceDialog({ licence, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(licence.id);
  const kinds = kindsFor(biz.type);
  const agri = biz.type === "agri_inputs";
  const first = kinds[0];
  const [form, setForm] = useState(() => (editing ? {
    locationId: String(licence.location_id), kind: licence.kind, name: licence.name, licenceNo: licence.licence_no, authority: licence.authority || "",
    validFrom: licence.valid_from, validUntil: licence.valid_until || "", noExpiry: !licence.valid_until, covers: licence.covers || [], notes: licence.notes || "", active: licence.active,
  } : {
    locationId: String(biz.locations.find((l) => l.active)?.id || ""), kind: first.value, name: first.name, licenceNo: "", authority: "",
    validFrom: businessToday(biz.business.timezone), validUntil: "", noExpiry: false, covers: first.covers || [], notes: "", active: true,
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  // A kind fills in its usual name and what it covers, unless they were changed.
  const pickKind = (e) => {
    const next = KINDS.find((k) => k.value === e.target.value);
    setForm((f) => {
      const was = KINDS.find((k) => k.value === f.kind);
      return { ...f, kind: next.value, name: !f.name || f.name === was?.name ? next.name : f.name, covers: next.covers || [] };
    });
  };
  const toggleCover = (category) => setForm((f) => ({ ...f, covers: f.covers.includes(category) ? f.covers.filter((c) => c !== category) : [...f.covers, category] }));
  const submit = () => {
    const body = { name: form.name.trim(), licenceNo: form.licenceNo.trim(), authority: form.authority.trim() || null, validFrom: form.validFrom,
      validUntil: form.noExpiry ? null : form.validUntil, covers: form.covers, notes: form.notes.trim() || null };
    return editing ? businessWrite(biz.id, `licences/${licence.id}`, { ...body, active: form.active }, "patch")
      : businessWrite(biz.id, "licences", { ...body, locationId: form.locationId, kind: form.kind });
  };
  return (
    <FormDialog title={editing ? `Edit ${licence.name}` : "Add a licence"} icon="shield" width={640} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      description={editing ? `Held by ${licence.location_name}. To renew it, give the new date it is valid until; switch it off once it is surrendered or cancelled.`
        : "Each licence is held for one place of business: add it for the location that holds it."}>
      {!editing && biz.locations.length > 1 && (
        <Field label="Location">
          <select required value={form.locationId} onChange={set("locationId")}>
            {biz.locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
      )}
      {!editing && (
        <Field label="Kind">
          <select value={form.kind} onChange={pickKind}>
            {kinds.map((k) => <option key={k.value} value={k.value}>{k.value === "other" ? "Another licence or registration" : k.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Name, as on the licence" wide><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Licence number"><input required maxLength={80} className="mono" value={form.licenceNo} onChange={set("licenceNo")} /></Field>
      <Field label="Issuing authority (optional)"><input maxLength={200} value={form.authority} onChange={set("authority")} placeholder="e.g. Agriculture Officer of the mandal" /></Field>
      <Field label="Valid from"><input required type="date" value={form.validFrom} onChange={set("validFrom")} /></Field>
      {!form.noExpiry && <Field label="Valid until"><input required type="date" min={form.validFrom || undefined} value={form.validUntil} onChange={set("validUntil")} /></Field>}
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.noExpiry} onChange={set("noExpiry")} /> It does not run out</label>
      {agri && (
        <fieldset className="field-wide bz-plain-fieldset">
          <legend>What it lets this location sell</legend>
          <span className="bz-inline">
            {Object.entries(CATEGORY_WORDS).map(([category, label]) => (
              <label key={category} className="checkbox bz-check"><input type="checkbox" checked={form.covers.includes(category)} onChange={() => toggleCover(category)} /> {label}s</label>
            ))}
          </span>
          <small className="muted">Bills of these at this location need this licence in force.</small>
        </fieldset>
      )}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. renewal applied for on the state portal" /></Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (switch it off when it is surrendered or cancelled)</label>}
    </FormDialog>
  );
}
