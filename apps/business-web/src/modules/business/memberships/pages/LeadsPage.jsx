import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import MembershipDialog from "./MembershipDialog";
import { LEAD_SOURCES, LEAD_STATUSES, dayWords, wordOf } from "./memberships";
import "../../fashion/styles/business-fashion-electronics.css";
import "../styles/memberships.css";

// Enquiries: who asked, how they came, what they want and when to call them
// back; the follow-up list is those due today or before. A trial pass (days,
// and visits if the plan counts them) checks in like a membership, has no bill
// and never asks for a mandate, one per person; a membership sold from the
// enquiry closes it as the member they became. An enquiry that came to
// nothing is closed as lost, with why.

const CHIPS = [["due", "To follow up"], ["open", "Open"], ["trial", "On a trial"], ["member", "Became members"], ["lost", "Lost"], ["", "All"]];

export default function LeadsPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const [chip, setChip] = useState("due");
  const params = chip === "due" ? { due: "true" } : chip ? { status: chip } : {};
  const list = useServerList("member-plans/leads", { gridId: "member-leads", params });
  const [dialog, setDialog] = useState(null);
  const canAct = biz.can("member_plans.create");
  const canSell = canAct && biz.can("sales.create");
  const saved = (message) => { setDialog(null); toast.success(message); list.reload(); };
  const columns = useMemo(() => [
    { key: "name", header: "Who", value: (l) => `${l.name} ${l.phone || ""}`, mobile: "title", pin: true,
      render: (l) => <span className="bz-two-line"><span>{l.contact_id ? <Link to={biz.path(`members/${l.contact_id}`)}>{l.name}</Link> : l.name}</span><small className="muted">{l.phone || l.email || ""}</small></span> },
    { key: "source", header: "Came by", value: (l) => wordOf(LEAD_SOURCES, l.source) },
    { key: "interest", header: "Interested in", value: (l) => l.interest || "" },
    { key: "follow_up_on", header: "Follow up", type: "date", value: (l) => l.follow_up_on, mobile: "subtitle",
      render: (l) => (l.follow_up_on ? <span className={l.due ? "bz-minus" : ""}>{dayWords(l.follow_up_on)}</span> : <span className="muted">—</span>) },
    { key: "status", header: "", value: (l) => LEAD_STATUSES[l.status]?.label, mobile: "show",
      render: (l) => <Badge tone={LEAD_STATUSES[l.status]?.tone} label={`${LEAD_STATUSES[l.status]?.label}${l.trial_no && l.status === "trial" ? ` · to ${dayWords(l.trial_end_on)}` : ""}${l.membership_no ? ` · ${l.membership_no}` : ""}`} /> },
    { key: "notes", header: "Notes", value: (l) => l.notes || l.lost_reason || "", defaultHidden: true },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => canAct && ["open", "trial"].includes(l.status) && (
      <span className="bz-row-actions">
        <button type="button" className="chip-button" onClick={() => setDialog({ edit: l })}>Follow up</button>
        {l.status === "open" && <button type="button" className="chip-button" onClick={() => setDialog({ trial: l })}>Trial pass</button>}
        {canSell && <button type="button" className="chip-button" onClick={() => setDialog({ sell: l })}><Icon name="user-plus" size={14} /> Make a member</button>}
      </span>
    ) },
  ], [biz, canAct, canSell]);
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Enquiries"
        description="Who asked, how they came and when to call back; trial passes that check in like a membership with no bill; and the members they became."
        primary={canAct && <button type="button" className="button" onClick={() => setDialog({ edit: {} })}><Icon name="plus" size={16} /> Add an enquiry</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="users" title="Enquiries">
        <div className="fe-chips" role="group" aria-label="Which enquiries">
          {CHIPS.map(([value, label]) => (
            <button key={value || "all"} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""}`} onClick={() => setChip(value)}>{label}</button>
          ))}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Name, phone or interest" }} caption="Enquiries" columns={columns}
          rowKey={(l) => l.id} rowNoun={["enquiry", "enquiries"]} rowClassName={(l) => (l.due ? "dg-tone-warning" : "")}
          exportName={biz.can("member_plans.export") ? `${biz.business.code}-enquiries` : undefined}
          empty={chip === "due" ? "Nobody to call back today" : "No enquiries"} emptyIcon="users" />
      </SectionCard>
      {dialog?.edit && <LeadDialog lead={dialog.edit} onClose={() => setDialog(null)} onSaved={(l) => saved(`${l.name}'s enquiry saved.`)} />}
      {dialog?.trial && <TrialDialog lead={dialog.trial} onClose={() => setDialog(null)}
        onSaved={(m) => { setDialog(null); toast.success(`Trial pass ${m.membership_no} for ${m.member_name}.`); navigate(biz.path(`members/${m.contact_id}`)); }} />}
      {dialog?.sell && <MembershipDialog mode="sell" lead={dialog.sell} onClose={() => setDialog(null)}
        onSaved={(m) => { setDialog(null); toast.success(`${m.membership_no} sold: ${m.member_name} is a member.`); navigate(biz.path(`members/${m.contact_id}`)); }} />}
    </div>
  );
}

function LeadDialog({ lead, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(lead.id);
  const today = businessToday(biz.business.timezone);
  const [form, setForm] = useState({ name: lead.name || "", phone: lead.phone || "", email: lead.email || "", source: lead.source || "walk_in", interest: lead.interest || "",
    followUpOn: lead.follow_up_on || today, notes: lead.notes || "", lost: false, lostReason: "",
    locationId: String(lead.location_id || biz.currentLocationId || biz.member.location_id || biz.locations[0]?.id || "") });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const body = { name: form.name, phone: form.phone, email: form.email, source: form.source, interest: form.interest, followUpOn: form.followUpOn || null, notes: form.notes };
  const submit = () => (editing
    ? businessWrite(biz.id, `member-plans/leads/${lead.id}`, { ...body, ...(form.lost ? { status: "lost", lostReason: form.lostReason } : {}) }, "put")
    : businessWrite(biz.id, "member-plans/leads", { ...body, locationId: form.locationId }));
  return (
    <FormDialog title={editing ? `Follow up ${lead.name}` : "Add an enquiry"} icon="users" width={620} onClose={onClose} onSaved={onSaved} onSubmit={submit}>
      <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Phone"><input inputMode="tel" maxLength={30} value={form.phone} onChange={set("phone")} /></Field>
      <Field label="E-mail (optional)"><input type="email" maxLength={150} value={form.email} onChange={set("email")} /></Field>
      <Field label="Came by"><select value={form.source} onChange={set("source")}>{LEAD_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
      <Field label="Interested in"><input maxLength={200} value={form.interest} onChange={set("interest")} placeholder="e.g. Morning yoga, three days a week" /></Field>
      <Field label="Follow up on"><input type="date" value={form.followUpOn} onChange={set("followUpOn")} /></Field>
      {!editing && biz.locations.length > 1 && <Field label="Branch"><select value={form.locationId} onChange={set("locationId")}>{biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
      <Field label="Notes" wide><textarea rows={3} maxLength={1000} value={form.notes} onChange={set("notes")} placeholder="What was said on the last call" /></Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.lost} onChange={set("lost")} /> Close it: they will not join</label>}
      {form.lost && <Field label="Why not" wide><input required maxLength={300} value={form.lostReason} onChange={set("lostReason")} placeholder="e.g. Joined a gym near home" /></Field>}
    </FormDialog>
  );
}

function TrialDialog({ lead, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const today = businessToday(biz.business.timezone);
  const { options } = useOptions(["member-plans/plans?active=true"]);
  const plans = options?.["member-plans/plans?active=true"] || [];
  const [form, setForm] = useState({ planId: "", days: "3", visits: "", startOn: today });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`A trial pass for ${lead.name}`} icon="user-plus" width={560} onClose={onClose} onSaved={onSaved} submitLabel="Give the trial pass"
      description="It checks in like a membership of the plan, has no bill and never asks for a mandate. One trial pass per person."
      onSubmit={() => businessWrite(biz.id, `member-plans/leads/${lead.id}/trial`, { requestKey, planId: form.planId, days: form.days, startOn: form.startOn, ...(form.visits ? { visits: form.visits } : {}) })}>
      <Field label="Plan tried"><select required value={form.planId} onChange={set("planId")}><option value="">Choose the plan…</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Days"><input type="number" required min="1" max="30" value={form.days} onChange={set("days")} /></Field>
      <Field label="Visits (optional)" hint="Empty: any visits within the days."><input type="number" min="1" max="30" value={form.visits} onChange={set("visits")} /></Field>
      <Field label="Starts on"><input type="date" required min={today} value={form.startOn} onChange={set("startOn")} /></Field>
    </FormDialog>
  );
}
