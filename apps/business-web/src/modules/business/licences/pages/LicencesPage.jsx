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
import { businessToday, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { CATEGORY_WORDS, usesAgri } from "../../agri/pages/agri";
import LicenceDetail from "./LicenceDetail";
import { SELLS_TO, STATES, daysWords, kindName, offeredKinds, sellsToWords } from "./licences";
import "../styles/licences.css";

// Licences & registrations: what each location holds, its number, the
// authority, the dates it is valid and the days it has left. The bell warns
// 60 days before one runs out. A licence is renewed by giving its new date,
// and switched off when surrendered or cancelled; it is never deleted.
// A farm-input shop's bills of fertilisers, seeds and pesticides need a
// licence in force covering them at the selling location, for retail or
// wholesale sales as the buyer is (a buyer with a GSTIN buys wholesale).
// The kinds a licence may be, with their rules, come from the server, those
// of the business's own trade first. A licence's name or Open shows its
// detail (LicenceDetail.jsx): a renewal applied for, its scanned copies and
// the records it keeps.

export default function LicencesPage() {
  const biz = useOpenBusiness();
  const [location, setLocation] = useState("");
  const [showOff, setShowOff] = useState(false);
  const list = useServerList("licences", { gridId: "business-licences", params: { ...(location ? { location } : {}), ...(showOff ? {} : { active: "true" }) } });
  const [editing, setEditing] = useState(null);
  const canEdit = biz.can("licences.edit");
  const [openId, setOpenId] = useState(null);
  // Raised when the licence open in the detail is saved in its own form, so the detail reads it again.
  const [detailVersion, setDetailVersion] = useState(0);
  // The kinds a new licence may be, with what each covers and who it sells to.
  const kindList = useOptions(canEdit ? ["licences/kinds"] : []);
  const kindRows = kindList.options?.["licences/kinds"];
  const kinds = useMemo(() => (kindRows ? offeredKinds(kindRows) : null), [kindRows]);
  const many = biz.locations.length > 1;
  const agri = usesAgri(biz);

  const columns = useMemo(() => [
    { key: "name", header: "Licence", value: (l) => l.name, mobile: "title", pin: true, minWidth: 220,
      render: (l) => <span className="bz-two-line"><button type="button" className="link-button lic-open" onClick={() => setOpenId(l.id)}>{l.name}</button><small className="muted">{l.authority || kindName(l)}</small></span> },
    { key: "licence_no", header: "Number", value: (l) => l.licence_no, className: "mono", mobile: "subtitle" },
    many && { key: "location", header: "Location", value: (l) => l.location_name },
    { key: "valid_from", header: "Valid from", type: "date", value: (l) => l.valid_from },
    { key: "valid_until", header: "Valid until", type: "date", value: (l) => l.valid_until,
      render: (l) => (l.valid_until ? dateShort(l.valid_until, { year: true }) : <span className="muted">No expiry</span>) },
    { key: "days_left", header: "Days left", type: "number", value: (l) => (l.days_left === null ? null : Number(l.days_left)),
      render: (l) => (l.days_left === null || l.state === "off" ? <span className="muted">—</span> : daysWords(Number(l.days_left), l.state)), mobile: "show" },
    { key: "state", header: "Status", type: "status", value: (l) => STATES[l.state]?.label || l.state, render: (l) => <Badge tone={STATES[l.state]?.tone} label={STATES[l.state]?.label || l.state} /> },
    agri && { key: "covers", header: "Covers", value: (l) => (l.covers || []).map((c) => CATEGORY_WORDS[c] || c).join(", "),
      render: (l) => (l.covers?.length ? l.covers.map((c) => CATEGORY_WORDS[c] || c).join(", ") : <span className="muted">—</span>) },
    agri && { key: "sells_to", header: "Sells to", value: (l) => (l.covers?.length ? sellsToWords(l.sells_to) : ""),
      render: (l) => (l.covers?.length ? sellsToWords(l.sells_to) : <span className="muted">—</span>) },
    agri && { key: "qualified_person", header: "Qualified person", value: (l) => l.qualified_person || "", defaultHidden: true },
    { key: "file_count", header: "Copies", type: "number", value: (l) => Number(l.file_count || 0),
      render: (l) => (Number(l.file_count) ? Number(l.file_count) : <span className="muted">None</span>) },
    { key: "notes", header: "Notes", value: (l) => l.notes || "", defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={() => setOpenId(l.id)}>Open</button>
        {canEdit && <button type="button" className="chip-button" onClick={() => setEditing(l)}>Edit</button>}
      </span>
    ) },
  ].filter(Boolean), [many, agri, canEdit]);

  return (
    <div className="stack">
      <BusinessHeader icon="shield" title="Licences"
        description={`The licences and registrations each location holds, with their numbers, the dates they are valid and their scanned copies. The bell warns 60 days before one runs out.${agri ? " Bills of fertilisers, seeds and pesticides at a location need its licence in force that covers them, one for wholesale sales when the buyer has a GSTIN." : ""}`}
        primary={canEdit && <button type="button" className="button" disabled={!kinds} onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add a licence</button>} />
      <ErrorMessage message={list.error || kindList.error} />
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
          rowClassName={(l) => (l.state === "off" ? "dg-tone-muted" : l.state === "expired" ? "dg-tone-danger" : ["expiring", "renewal_pending"].includes(l.state) ? "dg-tone-warning" : "")}
          exportName={biz.can("reports.export") ? `${biz.business.code}-licences` : undefined}
          empty="No licences kept yet" emptyHint={canEdit ? "Add each licence the location holds, with its number and the date it runs out." : "Licences appear here once they are added."} emptyIcon="shield" />
      </SectionCard>
      {openId && <LicenceDetail licenceId={openId} version={detailVersion} onClose={() => { if (!editing) setOpenId(null); }} onChanged={list.reload}
        onEdit={canEdit ? setEditing : undefined} />}
      {editing && <LicenceDialog licence={editing} kinds={kinds} onClose={() => setEditing(null)}
        onSaved={(l) => { setEditing(null); toast.success(`${l.name} saved.`); list.reload(); setDetailVersion((n) => n + 1); }} />}
    </div>
  );
}

function LicenceDialog({ licence, kinds, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(licence.id);
  const choices = kinds || offeredKinds([]);
  const agri = biz.type === "agri_inputs";
  const first = choices[0];
  const [form, setForm] = useState(() => (editing ? {
    locationId: String(licence.location_id), kind: licence.kind, name: licence.name, licenceNo: licence.licence_no, authority: licence.authority || "",
    validFrom: licence.valid_from, validUntil: licence.valid_until || "", noExpiry: !licence.valid_until, covers: licence.covers || [], notes: licence.notes || "", active: licence.active,
    sellsTo: licence.sells_to || "both", qualifiedPerson: licence.qualified_person || "", qualification: licence.qualification || "",
    qualificationCertificate: licence.qualification_certificate || "", qualificationExemption: licence.qualification_exemption || "",
  } : {
    locationId: String(biz.locations.find((l) => l.active)?.id || ""), kind: first.code, name: first.name, licenceNo: "", authority: "",
    validFrom: businessToday(biz.business.timezone), validUntil: "", noExpiry: false, covers: first.covers || [], notes: "", active: true,
    sellsTo: first.sells_to || "both", qualifiedPerson: "", qualification: "", qualificationCertificate: "", qualificationExemption: "",
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  // A kind fills in its usual name (unless it was changed), what it covers and who it sells to.
  const pickKind = (e) => {
    const next = choices.find((k) => k.code === e.target.value);
    setForm((f) => {
      const was = choices.find((k) => k.code === f.kind);
      return { ...f, kind: next.code, name: !f.name || f.name === was?.name ? next.name : f.name, covers: next.covers || [], sellsTo: next.sells_to || "both" };
    });
  };
  const toggleCover = (category) => setForm((f) => ({ ...f, covers: f.covers.includes(category) ? f.covers.filter((c) => c !== category) : [...f.covers, category] }));
  // A licence that covers farm inputs says who it sells to, and names its qualified person.
  const covering = form.covers.length > 0;
  const [person, qualification, certificate, exemption] = [form.qualifiedPerson, form.qualification, form.qualificationCertificate, form.qualificationExemption].map((v) => v.trim());
  const showQualified = covering || Boolean(person || qualification || certificate || exemption);
  const submit = () => {
    const body = { name: form.name.trim(), licenceNo: form.licenceNo.trim(), authority: form.authority.trim() || null, validFrom: form.validFrom,
      validUntil: form.noExpiry ? null : form.validUntil, covers: form.covers, notes: form.notes.trim() || null,
      ...(covering ? { sellsTo: form.sellsTo } : {}), qualifiedPerson: person || null, qualification: qualification || null,
      qualificationCertificate: certificate || null, qualificationExemption: exemption || null };
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
            {choices.map((k) => <option key={k.code} value={k.code}>{k.code === "other" ? "Another licence or registration" : k.name}</option>)}
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
      {covering && (
        <Field label="Sells to" hint="A sale to a buyer with a GSTIN (a B2B invoice) is a wholesale sale; any other sale is retail.">
          <select value={form.sellsTo} onChange={set("sellsTo")}>
            {SELLS_TO.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
      )}
      {showQualified && (
        <fieldset className="bz-fieldset">
          <legend>Qualified person (optional)</legend>
          <Field label="Name"><input maxLength={150} required={Boolean(qualification || certificate || exemption)} value={form.qualifiedPerson} onChange={set("qualifiedPerson")} /></Field>
          <Field label="Qualification"><input maxLength={200} required={Boolean(person) && !exemption} value={form.qualification} onChange={set("qualification")} placeholder="e.g. B.Sc. (Agriculture)" /></Field>
          <Field label="Its certificate number (optional)"><input maxLength={80} className="mono" value={form.qualificationCertificate} onChange={set("qualificationCertificate")} /></Field>
          <Field label="Or why they are exempt"><input maxLength={300} value={form.qualificationExemption} onChange={set("qualificationExemption")} /></Field>
          <small className="muted field-wide">The person the licence names, with their qualification or why they are exempt. The rules on who qualifies change often, so these are kept as written on the licence.</small>
        </fieldset>
      )}
      <Field label="Notes (optional)" wide><input maxLength={500} value={form.notes} onChange={set("notes")} placeholder="e.g. the original is kept at the head office" /></Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> In use (switch it off when it is surrendered or cancelled)</label>}
    </FormDialog>
  );
}
