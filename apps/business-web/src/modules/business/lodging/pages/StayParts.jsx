import { useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { printTaxInvoice } from "../../core/pages/invoice";
import { OccupantFields, VisaTypes } from "./LodgingDialogs";
import { ROUTE_KINDS, blankGuest, dateWords, folioName, guestBody, policyWords } from "./lodging";

// The parts of a stay beyond its room and folio (StayPage): the policy it was
// booked under with what it charges now; its folios (the main one and those
// opened for a company or the extras, and its group's) with what is on each
// and its bill, the routing of each kind of charge to a folio, and a charge
// moved; an occupant joining partway and one leaving; and the guest's profile
// (preferences and notes, kept with their contact). The server checks every
// step again.

const searchCustomers = (biz) => (q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", active: "true", q, limit: 15 }, signal).then((page) => page.items);

// --- The policy ----------------------------------------------------------------------------------------------

const RULES = { free: "free now", nights: "nights of the stay", percent: "a percentage of the stay", not_refundable: "not refundable: the full stay", first_night: "the first night",
  full_stay: "the full stay" };

export function PolicySection({ stay }) {
  const biz = useOpenBusiness();
  const pc = stay.policy_charges;
  const p = stay.policy;
  const money = (x) => `${biz.exact(x.amount)} + GST ${biz.exact(x.tax)}`;
  return (
    <SectionCard icon="settings" title="Policy" aria-label="Policy" description={`Check-in from ${stay.check_in_time}, check-out by ${stay.check_out_time}. ${p ? `Booked under ${p.name || "its rate plan"}${p.refundable === false ? " (not refundable)" : ""}: a manager may waive a charge.` : "Booked under no policy: nothing is charged for an early check-in or a late check-out, and a cancellation charge is typed."}`}>
      {p && (
        <dl className="ldg-facts">
          {policyWords(p, biz).length > 0 && <div className="ldg-fact"><dt>Terms</dt><dd>{policyWords(p, biz).join(" · ")}</dd></div>}
          {pc && stay.status === "reserved" && <div className="ldg-fact"><dt>Early check-in now</dt><dd>{pc.early.now && Number(pc.early.amount) > 0 ? money(pc.early) : "Nothing"}</dd></div>}
          {pc && stay.status === "in_house" && <div className="ldg-fact"><dt>Late check-out now</dt><dd>{pc.late.now && Number(pc.late.amount) > 0 ? money(pc.late) : "Nothing yet"}</dd></div>}
          {pc && stay.status === "reserved" && <div className="ldg-fact"><dt>Cancelled now</dt><dd>{Number(pc.cancel.amount) > 0 ? `${money(pc.cancel)} (${RULES[pc.cancel.rule] || "by the policy"})` : "Nothing"}</dd></div>}
          {pc && stay.status === "reserved" && <div className="ldg-fact"><dt>A no-show</dt><dd>{Number(pc.noShow.amount) > 0 ? `${money(pc.noShow)} (${RULES[pc.noShow.rule] || "by the policy"})` : "Nothing"}</dd></div>}
          {pc && Number(pc.deposit.amount) > 0 && <div className="ldg-fact"><dt>Deposit asked</dt>
            <dd>{biz.exact(pc.deposit.amount)}{pc.deposit.by ? ` by ${dateWords(pc.deposit.by)}` : ""} · taken {biz.exact(pc.deposit.taken)}{Number(pc.deposit.short) > 0 ? ` · ${biz.exact(pc.deposit.short)} short` : ""}</dd></div>}
        </dl>
      )}
    </SectionCard>
  );
}

// --- Folios and routing ---------------------------------------------------------------------------------------

export function FoliosSection({ stay, onOpen, onRoute }) {
  const biz = useOpenBusiness();
  const live = stay.charges.filter((x) => !x.voided_at);
  const sumOf = (id) => live.filter((x) => Number(x.folio_id || 0) === Number(id || 0)).reduce((s, x) => s + Number(x.net) + Number(x.tax), 0);
  const open = ["reserved", "in_house"].includes(stay.status) && biz.can("lodging.create");
  const print = (documentId) => businessRead(biz.id, `documents/${documentId}`).then((doc) => printTaxInvoice(doc, biz)).catch((err) => toast.error(getErrorMessage(err)));
  const rows = [
    { key: "main", name: "Main", billedTo: stay.bill_to_name || stay.guest_name, gstin: stay.bill_to_name ? stay.bill_to_gstin : stay.guest_gstin, posted: sumOf(null),
      bill: stay.bill ? { id: stay.bill.id, no: stay.bill.document_no, total: stay.bill.total, due: stay.bill.due } : null },
    ...stay.folios.map((f) => ({ key: String(f.id), name: f.group_id ? `${f.name} (the group's)` : f.name, billedTo: f.contact_name, gstin: f.gstin, posted: sumOf(f.id),
      bill: f.document_id ? { id: f.document_id, no: f.document_no, total: f.total, due: f.due } : null })),
  ];
  const routes = stay.routes || {};
  return (
    <SectionCard flush icon="receipt" title="Folios" aria-label="Folios"
      description={`Each folio is billed with its own GST invoice at check-out (a group's with the group), paid by the advance and deposit first. Routed: ${ROUTE_KINDS.map((k) => `${k.label.split(",")[0].toLowerCase()} to ${folioName(stay, routes[k.value])}`).join(" · ")}.`}
      actions={open && (
        <span className="ldg-cal-tools">
          <button type="button" className="button button-secondary button-sm" onClick={onOpen}><Icon name="plus" size={14} /> Open a folio</button>
          {stay.folios.some((f) => !f.document_id) && <button type="button" className="button button-secondary button-sm" onClick={onRoute}>Routing</button>}
        </span>
      )}>
      <DataGrid variant="compact" id="lodging-stay-folios" caption="Folios" rows={rows} rowKey={(r) => r.key} currency={biz.symbol} rowNoun={["folio", "folios"]} columns={[
        { key: "name", header: "Folio", value: (r) => r.name, mobile: "title", pin: true },
        { key: "billed_to", header: "Billed to", value: (r) => `${r.billedTo}${r.gstin ? ` · GSTIN ${r.gstin}` : ""}`, mobile: "subtitle" },
        { key: "posted", header: "On it", type: "money", exact: true, value: (r) => r.posted },
        { key: "bill", header: "Bill", value: (r) => r.bill?.no || "", mobile: "show",
          render: (r) => (r.bill && r.key === "main" ? <span className="mono">{r.bill.no}</span> : r.bill ? <button type="button" className="link-button mono" title="Print the tax invoice" onClick={() => print(r.bill.id)}>{r.bill.no}</button> : <span className="muted">Not billed</span>) },
        { key: "total", header: "Billed", type: "money", exact: true, value: (r) => (r.bill ? Number(r.bill.total) : null) },
        { key: "due", header: "Due", type: "money", exact: true, value: (r) => (r.bill ? Math.max(0, Number(r.bill.due)) : null) },
      ]} />
    </SectionCard>
  );
}

// A folio beyond the main one, billed to a customer (a company with its GSTIN on the invoice, or the guest for the extras).
export function OpenFolioDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [name, setName] = useState("");
  const [billTo, setBillTo] = useState(stay.bill_to_contact_id ? { id: stay.bill_to_contact_id, name: stay.bill_to_name, gstin: stay.bill_to_gstin } : null);
  return (
    <FormDialog title={`Open a folio on ${stay.stay_no}`} icon="plus" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Open the folio"
      description="Name it for whom it is (Company, Extras); route kinds of charges to it, or move a charge to it."
      onSubmit={() => {
        if (!billTo) throw new Error("Choose whom the folio is billed to");
        return businessWrite(biz.id, `lodging/stays/${stay.id}/folios`, { requestKey, name: name.trim(), contactId: billTo.id });
      }}>
      <Field label="Folio name"><input required maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Company, Extras" /></Field>
      <div className="field-wide">
        <SearchPicker label="Billed to" placeholder="Company or guest name" value={billTo} onChange={setBillTo} minChars={2} search={searchCustomers(biz)}
          getLabel={(c) => c.name} getDescription={(c) => (c.gstin ? `GSTIN ${c.gstin}` : c.phone || "")} />
      </div>
    </FormDialog>
  );
}

// Where each kind of charge goes: the main folio or another (not billed); the kind's charges not yet billed move with it.
export function RoutingDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const routes = stay.routes || {};
  const folios = stay.folios.filter((f) => !f.document_id);
  const [form, setForm] = useState(Object.fromEntries(ROUTE_KINDS.map((k) => [k.value, routes[k.value] ? String(routes[k.value]) : ""])));
  return (
    <FormDialog title={`Routing of ${stay.stay_no}`} icon="receipt" width={600} onClose={onClose} onSaved={onSaved} submitLabel="Save the routing"
      description="Each kind of charge goes to the folio chosen; its charges not yet billed move there now."
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/routing`, Object.fromEntries(ROUTE_KINDS.map((k) => [k.value, form[k.value] || null])), "put")}>
      {ROUTE_KINDS.map((k) => (
        <Field key={k.value} label={k.label}><select value={form[k.value]} onChange={(e) => setForm((f) => ({ ...f, [k.value]: e.target.value }))}>
          <option value="">Main</option>{folios.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
      ))}
    </FormDialog>
  );
}

// A charge not yet billed moved to another folio.
export function MoveChargeDialog({ stay, charge, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const choices = [{ id: "", name: "Main" }, ...stay.folios.filter((f) => !f.document_id).map((f) => ({ id: String(f.id), name: f.name }))]
    .filter((f) => f.id !== String(charge.folio_id || ""));
  const [folioId, setFolioId] = useState(choices[0]?.id ?? "");
  return (
    <FormDialog title={`Move ${charge.label}`} icon="receipt" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Move it"
      description={`Now on folio ${folioName(stay, charge.folio_id)}.`}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/charges/${charge.id}/move`, { folioId: folioId || null })}>
      <Field label="To the folio" wide><select value={folioId} onChange={(e) => setFolioId(e.target.value)}>{choices.map((f) => <option key={f.id || "main"} value={f.id}>{f.name}</option>)}</select></Field>
    </FormDialog>
  );
}

// --- Occupants joining and leaving -------------------------------------------------------------------------------

export function AddOccupantDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [requestKey] = useState(newKey);
  const [guest, setGuest] = useState(() => blankGuest(false));
  return (
    <FormDialog title={`Add an occupant to ${stay.stay_no}`} icon="user-plus" width={760} onClose={onClose} onSaved={onSaved} submitLabel="Add the occupant"
      description="Recorded as at check-in, for the register with when they came. The nights still to post are priced for them (an extra adult at the night's rate)."
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/guests`, { requestKey, guest: guestBody(guest) })}>
      <Field label="Adult or child"><select value={guest.child ? "child" : "adult"} onChange={(e) => setGuest(blankGuest(e.target.value === "child", { fullName: guest.fullName }))}>
        <option value="adult">Adult</option><option value="child">Child</option></select></Field>
      <VisaTypes />
      <OccupantFields index={stay.guests.length} guest={guest} today={today} onChange={setGuest} />
    </FormDialog>
  );
}

export function LeaveDialog({ stay, guest, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={`${guest.full_name} leaves`} icon="user" width={520} onClose={onClose} onSaved={onSaved} submitLabel="Mark them left"
      description={`Their departure is kept for the register${guest.foreigner ? ", and the Form-III departure report is due within 24 hours" : ""}. The nights still to post are priced for those left.`}
      onSubmit={() => businessWrite(biz.id, `lodging/stays/${stay.id}/guests/${guest.id}/leave`, { reason: reason.trim() || undefined })}>
      <Field label="Reason (optional)" wide><input maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Went on to Goa" /></Field>
    </FormDialog>
  );
}

// --- The guest's profile -------------------------------------------------------------------------------------------

export function ProfileSection({ stay, onEdit }) {
  const biz = useOpenBusiness();
  const profile = stay.profile || {};
  return (
    <SectionCard icon="user" title="Guest profile" aria-label="Guest profile" description={`${stay.guest_name}'s preferences and the desk's notes, kept with the guest for every stay.`}
      actions={biz.can("lodging.create") && <button type="button" className="button button-secondary button-sm" onClick={onEdit}><Icon name="edit" size={14} /> Edit</button>}>
      <dl className="ldg-facts">
        <div className="ldg-fact"><dt>Preferences</dt><dd>{profile.preferences || "None noted"}</dd></div>
        <div className="ldg-fact"><dt>Notes</dt><dd>{profile.notes || "None"}</dd></div>
      </dl>
    </SectionCard>
  );
}

export function ProfileDialog({ stay, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ preferences: stay.profile?.preferences || "", notes: stay.profile?.notes || "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`${stay.guest_name}'s profile`} icon="user" width={600} onClose={onClose} onSaved={onSaved} submitLabel="Save the profile"
      description="Shown on each of the guest's stays."
      onSubmit={() => businessWrite(biz.id, `lodging/profiles/${stay.contact_id}`, { preferences: form.preferences.trim() || null, notes: form.notes.trim() || null }, "put")}>
      <Field label="Preferences" wide><textarea rows={3} maxLength={1000} value={form.preferences} onChange={set("preferences")} placeholder="e.g. A quiet room on a high floor; feather-free pillows" /></Field>
      <Field label="Notes" wide><textarea rows={3} maxLength={2000} value={form.notes} onChange={set("notes")} /></Field>
    </FormDialog>
  );
}
