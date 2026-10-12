import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../../components/ActionMenu";
import useConfirm from "../../../../hooks/useConfirm";
import { toast } from "../../../../services/toast";
import { dateShort } from "../../../../services/format";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { WEEKDAYS, minutesText } from "./salon";
import { Holidays, RecipeDialog, WeekDialog } from "./SalonRound2Parts";
import { weekText } from "./salonRound2";

// How long each service takes (and its clean-up), which services each
// stylist does, which resources are rooms, and the booking rules (deposit,
// free cancellation, late-cancel and no-show charges, calendar hours).
// Pro pass F-12: the one place for stylists and rooms (the generic Staff &
// rooms screen is not shown to salons), with working hours, weekly off and leave.
const TABS = [{ value: "staff", label: "Stylists & rooms" }, { value: "services", label: "Service times" }, { value: "holidays", label: "Holidays" }, { value: "rules", label: "Booking rules" }];

export default function SalonSetupPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTabState] = useState(() => (TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "staff"));
  const setTab = (value) => { setTabState(value); setParams(value === "staff" ? {} : { tab: value }, { replace: true }); };
  const [notice, setNotice] = useState("");
  return (
    <div className="stack">
      <BusinessHeader icon="clock" title="Stylists & services"
        description="Who works when, which services each stylist does, how long each service takes, and the booking rules. The calendar follows all of it." />
      <SuccessMessage message={notice} />
      <Segmented label="Show" value={tab} options={TABS} onChange={(value) => { setTab(value); setNotice(""); }} />
      {tab === "services" && <Services onNotice={setNotice} />}
      {tab === "staff" && <Staff onNotice={setNotice} />}
      {tab === "rules" && <Rules onNotice={setNotice} />}
      {tab === "holidays" && <Holidays onNotice={setNotice} />}
    </div>
  );
}

function Services({ onNotice }) {
  const biz = useOpenBusiness();
  const list = useServerList("salon/services", { gridId: "salon-services" });
  const [editing, setEditing] = useState(null);
  const [recipe, setRecipe] = useState(null);
  const canEdit = biz.can("catalog.edit");
  const columns = useMemo(() => [
    { key: "label", header: "Service", value: (s) => s.label, mobile: "title", pin: true },
    { key: "category", header: "Category", value: (s) => s.category || "", filter: "select", mobile: "subtitle" },
    { key: "price", header: "Price", type: "money", exact: true, value: (s) => Number(s.price), mobile: "show" },
    { key: "duration", header: "Takes", type: "number", value: (s) => (s.timed ? Number(s.duration_minutes) : null), mobile: "show",
      render: (s) => (s.timed ? minutesText(s.duration_minutes) : <span className="muted">Not set (1 hr)</span>) },
    { key: "buffer", header: "Clean-up", type: "number", value: (s) => (s.timed ? Number(s.buffer_minutes) : null), render: (s) => (s.timed ? `${s.buffer_minutes} min` : "—") },
    { key: "needs_room", header: "Room", type: "status", value: (s) => (s.needs_room ? "yes" : "no"), render: (s) => (s.needs_room ? <Badge tone="info" label="Needs a room" /> : "—") },
    { key: "stylists", header: "Stylists who do it", type: "number", value: (s) => s.stylist_count, render: (s) => (s.stylist_count ? s.stylist_count : "Everyone") },
    { key: "backbar", header: "Products used", type: "number", value: (s) => s.backbar_products, render: (s) => (s.backbar_products ? `${s.backbar_products} product${s.backbar_products === 1 ? "" : "s"}` : "—") },
    { key: "active", header: "Status", type: "status", value: (s) => (s.active ? "active" : "inactive"), render: (s) => <ActiveBadge active={s.active} />, defaultHidden: true },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => (
      <div className="row-actions">
        <button type="button" className="chip-button" onClick={() => setEditing(s)}>Set time</button>
        <button type="button" className="chip-button" onClick={() => setRecipe(s)}>Products used</button>
      </div>
    ) },
  ].filter(Boolean), [canEdit]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="clock" title="Services and how long they take">
        <DataGrid {...list.gridProps} caption="Services" columns={columns} currency={biz.symbol} rowNoun={["service", "services"]}
          rowClassName={(s) => (!s.active ? "dg-tone-muted" : !s.timed ? "dg-tone-warning" : "")}
          empty="No services yet" emptyHint="Add services under Services & products first." emptyIcon="clock" />
      </SectionCard>
      {editing && (
        <ServiceDialog service={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onNotice(`${editing.label}: time saved.`); list.reload(); }} />
      )}
      {recipe && <RecipeDialog service={recipe} onClose={() => setRecipe(null)} onSaved={(r) => { setRecipe(null); onNotice(`${recipe.label}: ${r.products.length ? `uses ${r.products.length} product${r.products.length === 1 ? "" : "s"}, ${biz.exact(r.cost)} a service` : "no products"}.`); list.reload(); }} />}
    </>
  );
}

function ServiceDialog({ service, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({ durationMinutes: String(service.duration_minutes || 60), bufferMinutes: String(service.buffer_minutes || 0), needsRoom: Boolean(service.needs_room) });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`How long ${service.label} takes`} icon="clock" width={520} onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `salon/services/${service.id}`, { durationMinutes: Number(form.durationMinutes), bufferMinutes: Number(form.bufferMinutes), needsRoom: form.needsRoom }, "put")}>
      <Field label="Service time (minutes)"><input required type="number" min="5" max="600" step="5" value={form.durationMinutes} onChange={set("durationMinutes")} /></Field>
      <Field label="Clean-up after (minutes)" hint="The stylist is busy for this too"><input required type="number" min="0" max="120" step="5" value={form.bufferMinutes} onChange={set("bufferMinutes")} /></Field>
      <label className="bz-check field-wide"><input type="checkbox" checked={form.needsRoom} onChange={(e) => setForm((f) => ({ ...f, needsRoom: e.target.checked }))} /> Needs a room (facials, massages, spa)</label>
    </FormDialog>
  );
}

const hoursText = (r) => (r.works_from ? `${String(r.works_from).slice(0, 5)} – ${String(r.works_to).slice(0, 5)}` : "Salon hours");
const offText = (r) => ((r.weekly_off || []).length ? (r.weekly_off || []).map((d) => WEEKDAYS[Number(d)]).join(", ") : "None");
const leaveText = (l) => (String(l.from_date).slice(0, 10) === String(l.to_date).slice(0, 10) ? dateShort(l.from_date) : `${dateShort(l.from_date)} – ${dateShort(l.to_date)}`);

function Staff({ onNotice }) {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  const list = useServerList("salon/staff", { gridId: "salon-staff" });
  const [editing, setEditing] = useState(null);
  const [leave, setLeave] = useState(null);
  const [week, setWeek] = useState(null);
  const canEdit = biz.can("appointments.create");
  const toggle = async (r) => {
    if (r.active && !(await confirm({ title: `Switch off ${r.name}?`, message: "They are no longer offered on the calendar or the bill. Past bills and commission stay.", confirmLabel: "Switch off", cancelLabel: "Keep" }))) return;
    try {
      await businessWrite(biz.id, `salon/staff/${r.id}`, { kind: r.kind, active: !r.active }, "put");
      toast.success(`${r.name} ${r.active ? "switched off" : "switched on"}`);
      list.reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const cancelLeave = async (r, l) => {
    try {
      await businessWrite(biz.id, `salon/staff/${r.id}/leave/${l.id}/cancel`, {});
      toast.success(`${r.name}'s leave on ${leaveText(l)} cancelled`);
      list.reload();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const columns = useMemo(() => [
    { key: "name", header: "Name", value: (r) => r.name, mobile: "title", pin: true },
    { key: "kind", header: "Stylist or room", type: "status", value: (r) => r.kind, filter: "select", mobile: "subtitle",
      filterOptions: [{ value: "staff", label: "Stylist" }, { value: "room", label: "Room" }],
      render: (r) => <Badge tone={r.kind === "room" ? "neutral" : "info"} label={r.kind === "room" ? "Room" : "Stylist"} /> },
    { key: "role_label", header: "Role", value: (r) => r.role_label || "", defaultHidden: true },
    { key: "skills", header: "Does", value: (r) => (r.kind === "room" ? "" : r.skills.map((s) => s.label).join(", ")), mobile: "show",
      render: (r) => (r.kind === "room" ? "—" : r.skills.length ? r.skills.map((s) => s.label).join(", ") : <span className="muted">Every service</span>) },
    { key: "hours", header: "Works", value: (r) => (r.kind === "room" ? "" : hoursText(r)), render: (r) => (r.kind === "room" ? "—" : hoursText(r)) },
    { key: "week", header: "Weekly schedule", value: (r) => (r.kind === "room" ? "" : weekText(r)), render: (r) => (r.kind === "room" ? "—" : weekText(r) || "—"), mobile: "show" },
    { key: "weekly_off", header: "Weekly off", value: (r) => (r.kind === "room" ? "" : offText(r)), render: (r) => (r.kind === "room" ? "—" : offText(r)) },
    { key: "leave", header: "Leave coming", value: (r) => (r.leave || []).length, mobile: "show",
      render: (r) => ((r.leave || []).length ? (
        <span className="sw-row">{r.leave.map((l) => <span key={l.id} className="sw-chip is-warning" title={l.reason || undefined}>{leaveText(l)}
          {canEdit && <button type="button" className="link-button" aria-label={`Cancel leave ${leaveText(l)}`} onClick={() => cancelLeave(r, l)}>×</button>}</span>)}</span>
      ) : "—") },
    { key: "location_name", header: "Location", value: (r) => r.location_name, defaultHidden: biz.locations.length < 2 },
    { key: "booked_today", header: "Booked today", type: "number", value: (r) => r.booked_today, mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (r) => (r.active ? "active" : "inactive"), render: (r) => <ActiveBadge active={r.active} /> },
    canEdit && { key: "actions", header: "", label: "Actions", type: "actions", render: (r) => (
      <div className="row-actions">
        <button type="button" className="chip-button" onClick={() => setEditing(r)}>Edit</button>
        <ActionMenu label={`More for ${r.name}`} items={[
          r.kind === "staff" && r.active && { label: "Weekly schedule", icon: "clock", onClick: () => setWeek(r) },
          r.kind === "staff" && r.active && { label: "Add leave", icon: "calendar", onClick: () => setLeave(r) },
          { label: r.active ? "Switch off" : "Switch on", icon: r.active ? "ban" : "check", danger: r.active, onClick: () => toggle(r) },
        ].filter(Boolean)} />
      </div>
    ) },
  ].filter(Boolean), [canEdit, biz.locations.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="users" title="Stylists and rooms"
        actions={canEdit && <button type="button" className="button button-sm" onClick={() => setEditing({ kind: "staff", skills: [] })}><Icon name="plus" size={15} /> Add</button>}>
        <DataGrid {...list.gridProps} caption="Stylists and rooms" columns={columns} rowNoun={["person or room", "people and rooms"]}
          rowClassName={(r) => (!r.active ? "dg-tone-muted" : "")} empty="No stylists or rooms yet" emptyIcon="users" />
      </SectionCard>
      {editing && <StaffDialog resource={editing} onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); onNotice(`${r.name} saved.`); list.reload(); }} />}
      {week && <WeekDialog resource={week} onClose={() => setWeek(null)} onSaved={(result) => {
        setWeek(null);
        onNotice(`${week.name}'s week saved.${result.clashes?.length ? ` ${result.clashes.length} booking${result.clashes.length === 1 ? " is" : "s are"} now outside it: move ${result.clashes.length === 1 ? "it" : "them"} on the calendar.` : ""}`);
        list.reload();
      }} />}
      {leave && <LeaveDialog resource={leave} onClose={() => setLeave(null)} onSaved={() => { onNotice(`Leave added for ${leave.name}. The calendar shows it and refuses bookings then.`); setLeave(null); list.reload(); }} />}
    </>
  );
}

function LeaveDialog({ resource, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: biz.business.timezone }).format(new Date());
  const [form, setForm] = useState({ fromDate: today, toDate: today, reason: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value, ...(name === "fromDate" && f.toDate < e.target.value ? { toDate: e.target.value } : {}) }));
  return (
    <FormDialog title={`Leave for ${resource.name}`} icon="calendar" width={520} submitLabel="Add leave" onClose={onClose} onSaved={onSaved}
      description="Bookings already on those days must be moved to another stylist first."
      onSubmit={() => businessWrite(biz.id, `salon/staff/${resource.id}/leave`, { ...form, reason: form.reason || null })}>
      <Field label="From"><input required type="date" min={today} value={form.fromDate} onChange={set("fromDate")} /></Field>
      <Field label="To (last day off)"><input required type="date" min={form.fromDate} value={form.toDate} onChange={set("toDate")} /></Field>
      <Field label="Reason" wide><input maxLength={200} value={form.reason} onChange={set("reason")} placeholder="Family wedding" /></Field>
    </FormDialog>
  );
}

function StaffDialog({ resource, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { options, error } = useOptions(["salon/services?active=true"]);
  const locations = biz.locations.filter((l) => l.active);
  const [form, setForm] = useState({ name: resource.name || "", roleLabel: resource.role_label || "", locationId: String(resource.location_id || locations[0]?.id || ""), kind: resource.kind || "staff",
    worksFrom: resource.works_from ? String(resource.works_from).slice(0, 5) : "", worksTo: resource.works_to ? String(resource.works_to).slice(0, 5) : "" });
  const [off, setOff] = useState(() => new Set((resource.weekly_off || []).map(Number)));
  const [skills, setSkills] = useState(() => new Set((resource.skills || []).map((s) => String(s.sku_id))));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const services = options?.["salon/services?active=true"] || [];
  const submit = async () => {
    const saved = resource.id ? resource : await businessWrite(biz.id, "resources", { name: form.name, roleLabel: form.roleLabel || (form.kind === "room" ? "Room" : null), locationId: form.locationId });
    await businessWrite(biz.id, `salon/staff/${saved.id}`, { kind: form.kind, skuIds: form.kind === "room" ? [] : [...skills],
      ...(resource.id ? { name: form.name, roleLabel: form.roleLabel || null } : {}),
      ...(form.kind === "staff" ? { weeklyOff: [...off], worksFrom: form.worksFrom || "", worksTo: form.worksTo || "" } : {}) }, "put");
    return { ...saved, name: form.name || saved.name };
  };
  return (
    <FormDialog title={resource.id ? `Edit ${resource.name}` : "Add a stylist or room"} icon="users" width={640} onSubmit={submit} onClose={onClose} onSaved={onSaved} disabled={!options}>
      <FormError message={error} />
      <Field label="Name"><input required maxLength={150} value={form.name} onChange={set("name")} /></Field>
      <Field label="Role (optional)"><input maxLength={100} value={form.roleLabel} onChange={set("roleLabel")} placeholder="Senior stylist" /></Field>
      {!resource.id && locations.length > 1 && (
        <Field label="Location"><select value={form.locationId} onChange={set("locationId")}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      )}
      <Field label="This is a">
        <select value={form.kind} onChange={set("kind")}><option value="staff">Stylist / therapist</option><option value="room">Room</option></select>
      </Field>
      {form.kind === "staff" && (
        <>
          <Field label="Works from" hint="Empty = the salon's hours"><input type="time" value={form.worksFrom} onChange={set("worksFrom")} /></Field>
          <Field label="Works till"><input type="time" value={form.worksTo} onChange={set("worksTo")} required={Boolean(form.worksFrom)} /></Field>
          <fieldset className="field-wide bz-plain-fieldset">
            <legend>Weekly day off</legend>
            <div className="sw-row">
              {WEEKDAYS.map((d, i) => (
                <label key={d} className="bz-check"><input type="checkbox" checked={off.has(i)} onChange={(e) => setOff((all) => {
                  const next = new Set(all);
                  if (e.target.checked) next.add(i); else next.delete(i);
                  return next;
                })} /> {d}</label>
              ))}
            </div>
          </fieldset>
        </>
      )}
      {form.kind === "staff" && (
        <fieldset className="field-wide bz-plain-fieldset">
          <legend>Services this person does <small className="muted">(none ticked = every service)</small></legend>
          <div className="sw-check-grid">
            {services.map((s) => (
              <label key={s.id} className="bz-check">
                <input type="checkbox" checked={skills.has(String(s.id))} onChange={(e) => setSkills((all) => {
                  const next = new Set(all);
                  if (e.target.checked) next.add(String(s.id)); else next.delete(String(s.id));
                  return next;
                })} /> {s.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </FormDialog>
  );
}

function Rules({ onNotice }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canEdit = biz.can("settings.edit");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "salon/settings", {}, controller.signal)
      .then((s) => setForm({ depositPercent: String(Number(s.deposit_percent)), freeCancelHours: String(s.free_cancel_hours), lateCancelFeePercent: String(Number(s.late_cancel_fee_percent)),
        noShowFeePercent: String(Number(s.no_show_fee_percent)), opensAt: String(s.opens_at).slice(0, 5), closesAt: String(s.closes_at).slice(0, 5),
        sessionCommissionBasis: s.session_commission_basis || "package_price" }))
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await businessWrite(biz.id, "salon/settings", form, "put");
      onNotice("Booking rules saved.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!form) return <><ErrorMessage message={error} />{!error && <p className="sw-note">Loading the rules…</p>}</>;
  return (
    <SectionCard as="form" icon="shield" title="Booking rules" onSubmit={save}
      description="Charges are kept only out of a deposit, never more than it; the rest of the deposit stays as the client's advance for their next bill.">
      <ErrorMessage message={error} />
      <fieldset className="form-grid bz-fieldset" disabled={!canEdit || busy}>
        <Field label="Suggested deposit (% of the price)" hint="0 = no deposit asked"><input type="number" min="0" max="100" step="0.01" value={form.depositPercent} onChange={set("depositPercent")} /></Field>
        <Field label="Free cancellation up to (hours before)"><input type="number" min="0" max="168" value={form.freeCancelHours} onChange={set("freeCancelHours")} /></Field>
        <Field label="Late cancellation charge (% of the price)"><input type="number" min="0" max="100" step="0.01" value={form.lateCancelFeePercent} onChange={set("lateCancelFeePercent")} /></Field>
        <Field label="No-show charge (% of the price)"><input type="number" min="0" max="100" step="0.01" value={form.noShowFeePercent} onChange={set("noShowFeePercent")} /></Field>
        <Field label="Calendar opens at"><input type="time" value={form.opensAt} onChange={set("opensAt")} /></Field>
        <Field label="Calendar closes at"><input type="time" value={form.closesAt} onChange={set("closesAt")} /></Field>
        <Field label="Commission on package sessions" hint="What a session used from a package is worth to the stylist">
          <select value={form.sessionCommissionBasis} onChange={set("sessionCommissionBasis")}>
            <option value="package_price">The package's price per session</option><option value="list_price">The service's list price</option>
          </select>
        </Field>
      </fieldset>
      <p className="sw-note" style={{ marginTop: "0.75rem" }}>
        Example: a ₹1,200 hair spa with a ₹300 deposit. Cancelled {form.freeCancelHours} hours or more before: no charge, ₹300 stays as advance.
        Cancelled later: {Number(form.lateCancelFeePercent)}% = ₹{Math.min(300, Math.round(12 * Number(form.lateCancelFeePercent)))} kept.
        No-show: {Number(form.noShowFeePercent)}% = ₹{Math.min(300, Math.round(12 * Number(form.noShowFeePercent)))} kept.
      </p>
      {canEdit && <div className="form-actions"><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save rules"}</button></div>}
    </SectionCard>
  );
}
