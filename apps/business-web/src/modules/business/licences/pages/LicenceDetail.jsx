import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, Field, FormError } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import {
  COPY_MAX_BYTES, COPY_TYPES, addLicenceCopy, copyDates, coversWords, daysWords, fileSize, formulationsOf, insecticidesOf, kindName,
  openLicenceCopy, principalStateOf, qualifiedWords, renewalRuleWords, sellsToWords, stateOf,
} from "./licences";
import "../styles/licences.css";

// One licence, opened from the list under Settings › Licences: what it says,
// a renewal applied for, its scanned copies and, by what it covers, the
// records kept beside it: an insecticide licence's endorsements and principal
// certificates, a fertiliser authorisation's certificates of source (Form O).
// A record is switched off or withdrawn, never deleted. The server answers a
// record's change with the whole licence again, which is then shown.
//
//   licenceId  the licence to show
//   version    raised by the list when the licence was changed in its own form (Edit), to read it again
//   onClose    closes the detail
//   onChanged  after anything is saved here, so the list reads it again
//   onEdit     (licence) => opens the licence's own form; left out for someone who may not change licences
export default function LicenceDetail({ licenceId, version = 0, onClose, onChanged, onEdit }) {
  const biz = useOpenBusiness();
  const canEdit = biz.can("licences.edit");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [reads, setReads] = useState(0);
  // A form over the detail: { kind: "principal" | "withdrawal" | "source", record }.
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `licences/${licenceId}`, undefined, controller.signal)
      .then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, licenceId, version, reads]);
  // The catalogue's insecticides and the manufacturers they name, for an endorsement and a principal certificate.
  const catalogue = useOptions(canEdit && data?.keeps_endorsements ? ["catalog?active=true"] : []);
  const skus = catalogue.options?.["catalog?active=true"];
  const insecticides = useMemo(() => insecticidesOf(skus), [skus]);
  const changed = (message) => { toast.success(message); onChanged?.(); };
  const saved = (detail, message) => { setData(detail); changed(message); };
  const closeDialog = () => setDialog(null);
  const fromDialog = (detail, message) => { closeDialog(); saved(detail, message); };
  const l = data;
  return (
    <>
      <Modal title={l ? l.name : "Loading…"} icon="shield" width={940} onClose={() => { if (!dialog) onClose(); }}
        description={l ? [kindName(l), l.location_name].filter(Boolean).join(" · ") : undefined}>
        <ErrorMessage message={error} />
        {!l && !error && <Loading />}
        {l && (
          <div className="stack">
            <Summary licence={l} onEdit={canEdit && onEdit ? () => onEdit(l) : undefined} />
            {l.valid_until && (
              <Renewal key={[l.valid_until, l.renewal_applied_on, l.renewal_reference].join("|")} licence={l} canEdit={canEdit} canOpenEdit={Boolean(canEdit && onEdit)}
                onSaved={(row, message) => { setData((d) => ({ ...d, ...row })); changed(message); }} />
            )}
            <Copies licence={l} canEdit={canEdit} onAdded={(message) => { setReads((n) => n + 1); changed(message); }} />
            {l.keeps_endorsements && (
              <Endorsements licence={l} canEdit={canEdit} items={insecticides.products} itemsLoading={canEdit && !skus && !catalogue.error}
                itemsError={catalogue.error} onSaved={saved} />
            )}
            {l.keeps_endorsements && <Principals licence={l} canEdit={canEdit} onOpen={setDialog} />}
            {l.keeps_sources && <Sources licence={l} canEdit={canEdit} onSaved={saved} onOpen={setDialog} />}
          </div>
        )}
      </Modal>
      {l && dialog?.kind === "principal" && <PrincipalDialog licence={l} principal={dialog.record} makers={insecticides.makers} onClose={closeDialog} onSaved={fromDialog} />}
      {l && dialog?.kind === "withdrawal" && <WithdrawalDialog licence={l} principal={dialog.record} onClose={closeDialog} onSaved={fromDialog} />}
      {l && dialog?.kind === "source" && <SourceDialog licence={l} source={dialog.record} onClose={closeDialog} onSaved={fromDialog} />}
    </>
  );
}

// What the licence says, and where it stands today.
function Summary({ licence: l, onEdit }) {
  const state = stateOf(l);
  const days = l.state === "off" || l.days_left === null || l.days_left === undefined ? "" : daysWords(Number(l.days_left), l.state);
  const covering = (l.covers || []).length > 0;
  return (
    <SectionCard icon="shield" title="Summary"
      actions={onEdit && <button type="button" className="button button-secondary button-sm" onClick={onEdit}><Icon name="edit" size={14} /> Edit</button>}>
      <dl className="lic-facts">
        <div><dt>Number</dt><dd className="mono">{l.licence_no}</dd></div>
        <div><dt>Kind</dt><dd>{kindName(l)}</dd></div>
        <div><dt>Issuing authority</dt><dd>{l.authority || <span className="muted">Not given</span>}</dd></div>
        <div><dt>Location</dt><dd>{l.location_name}</dd></div>
        <div><dt>Valid from</dt><dd>{dateShort(l.valid_from, { year: true })}</dd></div>
        <div><dt>Valid until</dt><dd>{l.valid_until ? dateShort(l.valid_until, { year: true }) : "No expiry"}</dd></div>
        <div><dt>Status</dt><dd className="bz-inline"><Badge tone={state.tone} label={state.label} />{days && <small className="muted">{days}</small>}</dd></div>
        {covering && <div><dt>Covers</dt><dd>{coversWords(l.covers)}</dd></div>}
        {covering && <div><dt>Sells to</dt><dd>{sellsToWords(l.sells_to)}</dd></div>}
        {(covering || l.qualified_person) && (
          <div className="lic-wide"><dt>Qualified person</dt><dd>{l.qualified_person ? qualifiedWords(l) : <span className="muted">Not given</span>}</dd></div>
        )}
        {l.notes && <div className="lic-wide"><dt>Notes</dt><dd>{l.notes}</dd></div>}
      </dl>
    </SectionCard>
  );
}

// A renewal applied for: the mark (the date and the application's reference)
// until the renewed date is typed, and what it does by the kind's rule. The
// server answers with the licence alone, without its copies and records.
function Renewal({ licence: l, canEdit, canOpenEdit, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ appliedOn: l.renewal_applied_on || "", reference: l.renewal_reference || "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const put = async (body, message) => {
    setBusy(true);
    setError("");
    try {
      onSaved(await businessWrite(biz.id, `licences/${l.id}/renewal`, body, "put"), message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const record = (event) => {
    event.preventDefault();
    put({ appliedOn: form.appliedOn, reference: form.reference.trim() }, `The renewal applied for on ${dateShort(form.appliedOn, { year: true })} is recorded.`);
  };
  const lapsed = Boolean(l.renewal_applied_on) && l.state === "expired";
  return (
    <SectionCard icon="refresh" title="Renewal applied for" description={renewalRuleWords(l)} bodyClassName="stack">
      {l.renewal_applied_on ? (
        <p>
          Applied for on <strong>{dateShort(l.renewal_applied_on, { year: true })}</strong>, reference <span className="mono">{l.renewal_reference}</span>.
          {l.state === "renewal_pending" && " The licence is in force past its date while the renewal is pending."}
          {lapsed && (l.renewal_rule === "applied_within" && l.renewal_deadline
            ? ` It was applied for after ${dateShort(l.renewal_deadline, { year: true })}, so the licence has lapsed.`
            : " The licence has run out.")}
        </p>
      ) : <p className="muted">No renewal applied for is recorded.</p>}
      <ErrorMessage message={error} />
      {canEdit && l.active && (
        <form className="lic-row-form" onSubmit={record}>
          <Field label="Applied for on"><input type="date" required min={l.valid_from} max={today} value={form.appliedOn} onChange={set("appliedOn")} /></Field>
          <Field label="The application's reference"><input required maxLength={80} className="mono" value={form.reference} onChange={set("reference")} placeholder="e.g. the portal's application number" /></Field>
          <button type="submit" className="button button-secondary" disabled={busy}>Record the renewal applied for</button>
          {l.renewal_applied_on && <button type="button" className="button button-secondary" disabled={busy} onClick={() => put({ appliedOn: null }, "The renewal mark is taken off.")}>Take the mark off</button>}
        </form>
      )}
      {canOpenEdit && l.active && <p className="small muted">When the renewed licence comes, type its new valid-until date with Edit: that ends the mark. Then add its scanned copy below.</p>}
      {canOpenEdit && !l.active && <p className="small muted">The licence is switched off: switch it on with Edit to record a renewal applied for.</p>}
    </SectionCard>
  );
}

// The scanned copies: each renewal's copy kept beside the earlier ones, with
// the dates the licence had when it was added. Opened only through the API.
function Copies({ licence: l, canEdit, onAdded }) {
  const biz = useOpenBusiness();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > COPY_MAX_BYTES) {
      setError("That file is larger than 5 MB. Scan the licence again at a lower size.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const copy = await addLicenceCopy(biz.id, l.id, file);
      onAdded(`${copy.file_name} is kept with ${l.name}.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard icon="file" title="Scanned copies" bodyClassName="stack"
      description="A PDF or a photo of the licence. Each renewal's copy is kept beside the earlier ones, with the dates the licence had then."
      actions={canEdit && (
        <label className={`button button-secondary button-sm lic-file${busy ? " is-busy" : ""}`}>
          <Icon name="upload" size={14} /> {busy ? "Adding…" : "Add a copy"}
          <input type="file" accept={COPY_TYPES} onChange={add} disabled={busy} />
        </label>
      )}>
      <ErrorMessage message={error} />
      <DataGrid variant="compact" id="licence-copies" caption="Scanned copies" rows={l.files} rowNoun={["copy", "copies"]}
        empty="No copy kept yet" emptyIcon="file"
        emptyHint={canEdit ? "Add a PDF or a photo (JPG, PNG or WebP) of the licence, up to 5 MB." : "A copy shows here once it is added."}
        columns={[
          { key: "file_name", header: "File", value: (f) => f.file_name, mobile: "title" },
          { key: "valid_from", header: "Valid for", value: (f) => f.valid_from, render: (f) => copyDates(f), mobile: "subtitle" },
          { key: "size_bytes", header: "Size", type: "number", value: (f) => Number(f.size_bytes), render: (f) => fileSize(f.size_bytes) },
          { key: "created_at", header: "Added", type: "datetime", value: (f) => f.created_at,
            render: (f) => <span className="bz-two-line"><span>{dateTime(f.created_at)}</span><small className="muted">by {f.uploaded_by_name}</small></span> },
          { key: "open", header: "", label: "Open", type: "actions",
            render: (f) => <button type="button" className="chip-button" onClick={() => openLicenceCopy(biz.id, l.id, f.id)}><Icon name="external" size={13} /> Open</button> },
        ]} />
    </SectionCard>
  );
}

// An insecticide licence's endorsements: the items (every pack of each) and
// the brands it lets the location sell. One that no longer stands is switched off.
function Endorsements({ licence: l, canEdit, items, itemsLoading, itemsError, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ by: "item", item: null, brand: "", endorsedOn: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The items on the licence already, endorsed or switched off: each is kept once.
  const kept = useMemo(() => new Set(l.endorsements.filter((e) => e.product_id).map((e) => String(e.product_id))), [l.endorsements]);
  const named = (e) => e.product_name || e.brand || "An item";
  const write = async (path, body, method, message) => {
    setBusy(true);
    setError("");
    try {
      onSaved(await businessWrite(biz.id, path, body, method), message);
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const byItem = form.by === "item";
  const ready = byItem ? Boolean(form.item) : Boolean(form.brand.trim());
  const add = async (event) => {
    event.preventDefault();
    if (!ready) return;
    const what = byItem ? form.item.name : form.brand.trim();
    const body = { ...(byItem ? { productId: form.item.product_id } : { brand: what }), ...(form.endorsedOn ? { endorsedOn: form.endorsedOn } : {}) };
    if (await write(`licences/${l.id}/endorsements`, body, "post", `${what} is endorsed on ${l.name}.`)) setForm((f) => ({ ...f, item: null, brand: "", endorsedOn: "" }));
  };
  const toggle = (e) => write(`licences/${l.id}/endorsements/${e.id}`, { active: !e.active }, "patch", `${named(e)} is ${e.active ? "switched off" : "switched on again"} on ${l.name}.`);
  return (
    <SectionCard icon="check-circle" title="Endorsements" bodyClassName="stack"
      description="Selling an insecticide under this licence needs the item, or its brand, endorsed on it. Whether one not endorsed warns or stops the bill is set under Settings › Farm input checks.">
      <ErrorMessage message={error} />
      <DataGrid variant="compact" id="licence-endorsements" caption="Endorsements" rows={l.endorsements} rowNoun={["endorsement", "endorsements"]}
        rowClassName={(e) => (!e.active ? "dg-tone-muted" : "")} empty="Nothing endorsed yet" emptyIcon="check-circle"
        emptyHint={canEdit ? "Add each item or brand as it is endorsed on the licence." : "Endorsements show here once they are added."}
        columns={[
          { key: "name", header: "Item or brand", value: (e) => named(e), mobile: "title",
            render: (e) => <span className="bz-two-line"><span>{named(e)}</span><small className="muted">{e.product_id ? "Item, every pack of it" : "Brand, every item of it"}</small></span> },
          { key: "endorsed_on", header: "Endorsed on", type: "date", value: (e) => e.endorsed_on,
            render: (e) => (e.endorsed_on ? dateShort(e.endorsed_on, { year: true }) : <span className="muted">—</span>) },
          { key: "active", header: "Status", type: "status", value: (e) => (e.active ? "Active" : "Switched off"), render: (e) => <ActiveBadge active={e.active} />, mobile: "show" },
          canEdit && { key: "actions", header: "", label: "Actions", type: "actions",
            render: (e) => <button type="button" className="chip-button" disabled={busy} onClick={() => toggle(e)}>{e.active ? "Switch off" : "Switch on"}</button> },
        ].filter(Boolean)} />
      {canEdit && (
        <form className="lic-row-form" onSubmit={add}>
          <Field label="Endorse">
            <select value={form.by} onChange={(e) => setForm((f) => ({ ...f, by: e.target.value }))}>
              <option value="item">An item, every pack of it</option>
              <option value="brand">A brand, every item of it</option>
            </select>
          </Field>
          {byItem ? (
            <div className="lic-grow">
              <SearchPicker label="Item" required options={items} value={form.item} onChange={(item) => setForm((f) => ({ ...f, item }))}
                getKey={(p) => p.product_id} getLabel={(p) => p.name} getKeywords={(p) => p.codes.join(" ")} isDisabled={(p) => kept.has(String(p.product_id))}
                getDescription={(p) => [p.brand, p.codes[0], kept.has(String(p.product_id)) && "already on this licence"].filter(Boolean).join(" · ")}
                placeholder="Type a pesticide item's name or code" emptyText={itemsLoading ? "Loading the items…" : "No pesticide item matches"} />
            </div>
          ) : (
            <Field label="Brand"><input required maxLength={100} value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} placeholder="e.g. Confidor" /></Field>
          )}
          <Field label="Endorsed on (optional)"><input type="date" value={form.endorsedOn} onChange={(e) => setForm((f) => ({ ...f, endorsedOn: e.target.value }))} /></Field>
          <button type="submit" className="button button-secondary" disabled={busy || !ready}><Icon name="plus" size={15} /> Add the endorsement</button>
        </form>
      )}
      {canEdit && byItem && <ErrorMessage message={itemsError} />}
    </SectionCard>
  );
}

// The principal certificates behind the insecticides sold under the licence:
// each manufacturer's, with its registration and manufacturing licence
// numbers, the formulations it authorises and its dates. A withdrawal stands
// once recorded; a new certificate is then added on its own.
function Principals({ licence: l, canEdit, onOpen }) {
  return (
    <SectionCard icon="clipboard" title="Principal certificates"
      description="Each manufacturer's certificate for the insecticides sold under this licence. An item is matched with one by the manufacturer it names."
      actions={canEdit && <button type="button" className="button button-secondary button-sm" onClick={() => onOpen({ kind: "principal", record: null })}><Icon name="plus" size={14} /> Add a certificate</button>}>
      <DataGrid variant="compact" id="licence-principals" caption="Principal certificates" rows={l.principals} rowNoun={["certificate", "certificates"]}
        rowClassName={(p) => (p.state === "withdrawn" || p.state === "expired" ? "dg-tone-muted" : "")} empty="No principal certificate kept yet" emptyIcon="clipboard"
        emptyHint={canEdit ? "Add each manufacturer's certificate, with the formulations it authorises." : "Certificates show here once they are added."}
        columns={[
          { key: "manufacturer", header: "Manufacturer", value: (p) => p.manufacturer, mobile: "title" },
          { key: "registration_no", header: "Registration no.", value: (p) => p.registration_no, className: "mono", mobile: "subtitle" },
          { key: "manufacturing_licence_no", header: "Manufacturing licence no.", value: (p) => p.manufacturing_licence_no, className: "mono" },
          { key: "formulations", header: "Formulations", value: (p) => (p.formulations || []).join(", ") },
          { key: "valid_from", header: "Valid from", type: "date", value: (p) => p.valid_from },
          { key: "valid_until", header: "Valid until", type: "date", value: (p) => p.valid_until,
            render: (p) => (p.valid_until ? dateShort(p.valid_until, { year: true }) : <span className="muted">No end date</span>) },
          { key: "state", header: "Status", type: "status", value: (p) => principalStateOf(p).label, mobile: "show",
            render: (p) => <span className="lic-state"><Badge tone={principalStateOf(p).tone} label={principalStateOf(p).label} />{p.withdrawn_note && <small className="muted">{p.withdrawn_note}</small>}</span> },
          canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => (p.withdrawn_on ? null : (
            <span className="bz-row-actions">
              <button type="button" className="chip-button" onClick={() => onOpen({ kind: "principal", record: p })}>Change</button>
              <button type="button" className="chip-button" onClick={() => onOpen({ kind: "withdrawal", record: p })}>Record the withdrawal</button>
            </span>
          )) },
        ].filter(Boolean)} />
    </SectionCard>
  );
}

// A principal certificate added, or its details changed (the manufacturer stays).
function PrincipalDialog({ licence, principal, makers, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(principal);
  const [form, setForm] = useState({
    manufacturer: "", registrationNo: principal?.registration_no || "", manufacturingLicenceNo: principal?.manufacturing_licence_no || "",
    formulations: (principal?.formulations || []).join(", "), validFrom: principal?.valid_from || "", validUntil: principal?.valid_until || "",
  });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const manufacturer = editing ? principal.manufacturer : form.manufacturer.trim();
  const submit = () => {
    const body = { registrationNo: form.registrationNo.trim(), manufacturingLicenceNo: form.manufacturingLicenceNo.trim(), formulations: formulationsOf(form.formulations),
      validFrom: form.validFrom, validUntil: form.validUntil || null };
    return editing ? businessWrite(biz.id, `licences/${licence.id}/principals/${principal.id}`, body, "patch")
      : businessWrite(biz.id, `licences/${licence.id}/principals`, { ...body, manufacturer });
  };
  return (
    <FormDialog title={editing ? `Change ${principal.manufacturer}'s certificate` : "Add a principal certificate"} icon="clipboard" width={640}
      submitLabel={editing ? "Save" : "Add the certificate"} onClose={onClose} onSubmit={submit}
      onSaved={(detail) => onSaved(detail, `${manufacturer}'s principal certificate is ${editing ? "saved" : "added"}.`)}
      description={editing ? "To correct it, or to give the dates of the same certificate renewed. When the manufacturer withdraws it, record the withdrawal instead."
        : `Kept on ${licence.name} (${licence.licence_no}). An insecticide item is matched with it by the manufacturer the item names.`}>
      {!editing && (
        <Field label="Manufacturer" wide hint="Spelt as the insecticide items name their manufacturer.">
          <input required maxLength={150} list="licence-principal-makers" value={form.manufacturer} onChange={set("manufacturer")} placeholder="e.g. Dhanuka Agritech" />
        </Field>
      )}
      {!editing && <datalist id="licence-principal-makers">{makers.map((m) => <option key={m} value={m} />)}</datalist>}
      <Field label="Registration number" hint="As on the certificate."><input required maxLength={200} className="mono" value={form.registrationNo} onChange={set("registrationNo")} /></Field>
      <Field label="Manufacturing licence number"><input required maxLength={80} className="mono" value={form.manufacturingLicenceNo} onChange={set("manufacturingLicenceNo")} /></Field>
      <Field label="Formulations it authorises" wide hint="Each one, separated by commas: up to 20.">
        <input required maxLength={400} value={form.formulations} onChange={set("formulations")} placeholder="e.g. EC, WP, SC" />
      </Field>
      <Field label="Valid from"><input required type="date" value={form.validFrom} onChange={set("validFrom")} /></Field>
      <Field label="Valid until (optional)" hint="Left blank: it has no end date."><input type="date" min={form.validFrom || undefined} value={form.validUntil} onChange={set("validUntil")} /></Field>
    </FormDialog>
  );
}

// The manufacturer withdrew its certificate: from that day it no longer
// covers its insecticides under the licence. A withdrawal stands once recorded.
function WithdrawalDialog({ licence, principal, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ withdrawnOn: today, withdrawnNote: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = () => businessWrite(biz.id, `licences/${licence.id}/principals/${principal.id}`,
    { withdrawnOn: form.withdrawnOn, withdrawnNote: form.withdrawnNote.trim() || null }, "patch");
  return (
    <FormDialog title={`Withdrawal of ${principal.manufacturer}'s certificate`} icon="ban" width={560} submitLabel="Record the withdrawal" onClose={onClose} onSubmit={submit}
      onSaved={(detail) => onSaved(detail, `${principal.manufacturer}'s certificate is recorded as withdrawn on ${dateShort(form.withdrawnOn, { year: true })}.`)}
      description={`From that day the certificate no longer covers ${principal.manufacturer}'s insecticides under ${licence.name}. A withdrawal stands once it is recorded: a new certificate is added on its own.`}>
      <Field label="Withdrawn on"><input required type="date" min={principal.valid_from} max={today} value={form.withdrawnOn} onChange={set("withdrawnOn")} /></Field>
      <Field label="Note (optional)"><input maxLength={300} value={form.withdrawnNote} onChange={set("withdrawnNote")} placeholder="e.g. the manufacturer's letter and its date" /></Field>
    </FormDialog>
  );
}

// A fertiliser authorisation's certificates of source (Form O): one from each
// source the fertiliser comes from, with the supplier whose deliveries it covers.
function Sources({ licence: l, canEdit, onSaved, onOpen }) {
  const biz = useOpenBusiness();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = async (s) => {
    setBusy(true);
    setError("");
    try {
      const body = { contactId: s.contact_id || null, name: s.name, certificateNo: s.certificate_no, certificateDate: s.certificate_date, active: !s.active };
      onSaved(await businessWrite(biz.id, `licences/${l.id}/sources/${s.id}`, body, "patch"),
        `Certificate ${s.certificate_no} from ${s.name} is ${s.active ? "switched off" : "switched on again"}.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard icon="truck" title="Certificates of source (Form O)" bodyClassName="stack"
      description="One from each source the fertiliser comes from, with the supplier whose deliveries it covers. Fertiliser received from a supplier with none here comes in with a warning."
      actions={canEdit && <button type="button" className="button button-secondary button-sm" onClick={() => onOpen({ kind: "source", record: null })}><Icon name="plus" size={14} /> Add a certificate</button>}>
      <ErrorMessage message={error} />
      <DataGrid variant="compact" id="licence-sources" caption="Certificates of source" rows={l.sources} rowNoun={["certificate", "certificates"]}
        rowClassName={(s) => (!s.active ? "dg-tone-muted" : "")} empty="No certificate of source kept yet" emptyIcon="truck"
        emptyHint={canEdit ? "Add the certificate from each source, naming the supplier whose deliveries it covers." : "Certificates show here once they are added."}
        columns={[
          { key: "name", header: "Source", value: (s) => s.name, mobile: "title" },
          { key: "contact_name", header: "Supplier", value: (s) => s.contact_name || "", render: (s) => s.contact_name || <span className="muted">—</span> },
          { key: "certificate_no", header: "Certificate no.", value: (s) => s.certificate_no, className: "mono", mobile: "subtitle" },
          { key: "certificate_date", header: "Dated", type: "date", value: (s) => s.certificate_date },
          { key: "active", header: "Status", type: "status", value: (s) => (s.active ? "Active" : "Switched off"), render: (s) => <ActiveBadge active={s.active} />, mobile: "show" },
          canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => (
            <span className="bz-row-actions">
              {s.active && <button type="button" className="chip-button" onClick={() => onOpen({ kind: "source", record: s })}>Change</button>}
              <button type="button" className="chip-button" disabled={busy} onClick={() => toggle(s)}>{s.active ? "Switch off" : "Switch on"}</button>
            </span>
          ) },
        ].filter(Boolean)} />
    </SectionCard>
  );
}

// A certificate of source added, or its details changed.
function SourceDialog({ licence, source, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(source);
  const today = businessToday(biz.business.timezone);
  const { options, error } = useOptions(["contacts?kind=supplier&active=true"]);
  // A supplier switched off since stays on its certificate.
  const suppliers = useMemo(() => {
    const rows = options?.["contacts?kind=supplier&active=true"] || [];
    return source?.contact_id && !rows.some((c) => String(c.id) === String(source.contact_id)) ? [...rows, { id: source.contact_id, name: source.contact_name }] : rows;
  }, [options, source]);
  const [form, setForm] = useState({ contactId: source?.contact_id ? String(source.contact_id) : "", name: source?.name || "",
    certificateNo: source?.certificate_no || "", certificateDate: source?.certificate_date || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const supplier = suppliers.find((c) => String(c.id) === form.contactId);
  const submit = () => {
    const body = { contactId: form.contactId || null, name: form.name.trim() || null, certificateNo: form.certificateNo.trim(), certificateDate: form.certificateDate };
    return editing ? businessWrite(biz.id, `licences/${licence.id}/sources/${source.id}`, { ...body, active: source.active }, "patch")
      : businessWrite(biz.id, `licences/${licence.id}/sources`, body);
  };
  return (
    <FormDialog title={editing ? `Change certificate ${source.certificate_no}` : "Add a certificate of source (Form O)"} icon="truck" width={640}
      submitLabel={editing ? "Save" : "Add the certificate"} onClose={onClose} onSubmit={submit} disabled={!options && !error}
      onSaved={(detail) => onSaved(detail, `Certificate ${form.certificateNo.trim()} is ${editing ? "saved" : "kept"} on ${licence.name}.`)}
      description={`Kept on ${licence.name} (${licence.licence_no}). Fertiliser received from the supplier chosen here is matched with it.`}>
      <FormError message={error} />
      <Field label="Supplier (optional)" wide hint="The supplier whose deliveries the certificate covers.">
        <select value={form.contactId} onChange={set("contactId")}>
          <option value="">No supplier: the source alone</option>
          {suppliers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label={form.contactId ? "Source, as on the certificate (optional)" : "Source, as on the certificate"} wide
        hint={supplier ? `Left blank: ${supplier.name}.` : "The manufacturer or importer the certificate names."}>
        <input required={!form.contactId} maxLength={150} value={form.name} onChange={set("name")} placeholder={supplier?.name || "e.g. the manufacturer's name"} />
      </Field>
      <Field label="Certificate number"><input required maxLength={80} className="mono" value={form.certificateNo} onChange={set("certificateNo")} /></Field>
      <Field label="Certificate date"><input required type="date" max={today} value={form.certificateDate} onChange={set("certificateDate")} /></Field>
    </FormDialog>
  );
}
