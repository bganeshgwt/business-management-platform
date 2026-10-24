import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SearchPicker from "../../../../components/SearchPicker";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { KINDS, UNITS, termWords, wordOf } from "./memberships";
import "../styles/memberships.css";

// Membership plans: each plan with its item's price, GST and SAC (a gym,
// yoga, fitness or personal-training plan is taxed at 5% without input tax
// credit; coaching, tuition and dance, music or art classes at 18%: the
// item's own slab), its joining fee, how it may be
// frozen, its grace days, whether it can be passed on and its refund policy
// (a changed policy is its next version; memberships keep the one they were
// sold with). Plans are switched off, never deleted. Below: when overdue
// fees turn a member away at check-in.

const POLICY = "If you cancel, the fee for the days (or sessions) you have not used is refunded pro rata, as worked out on the day you cancel. The joining fee is not refunded.";

export default function PlansPage() {
  const biz = useOpenBusiness();
  const [showOff, setShowOff] = useState(false);
  const list = useServerList("member-plans/plans", { gridId: "member-plans", params: showOff ? {} : { active: "true" } });
  const [editing, setEditing] = useState(null);
  const canEdit = biz.can("member_plans.edit");
  const columns = useMemo(() => [
    { key: "name", header: "Plan", value: (p) => p.name, mobile: "title", pin: true,
      render: (p) => <span className="bz-two-line"><span>{p.name}</span><small className="muted">{termWords(p)}</small></span> },
    { key: "price", header: "Price", type: "money", exact: true, value: (p) => Number(p.price), mobile: "subtitle",
      render: (p) => <span className="bz-two-line"><span>{biz.exact(p.price)}</span><small className="muted">+ GST {Number(p.tax_rate)}%{p.hsn_code ? ` · SAC ${p.hsn_code}` : ""}</small></span> },
    { key: "joining", header: "Joining fee", value: (p) => p.joining_label || "", render: (p) => (p.joining_label ? biz.exact(p.joining_price) : <span className="muted">None</span>) },
    { key: "freezes", header: "Freezes", value: (p) => p.max_freezes, render: (p) => (p.max_freezes ? `${p.max_freezes}, ${p.max_freeze_days} days in all` : <span className="muted">None</span>) },
    { key: "grace_days", header: "Grace days", type: "number", value: (p) => p.grace_days },
    { key: "transferable", header: "Passed on", value: (p) => (p.transferable ? "Yes" : "No") },
    { key: "policy_version", header: "Policy", value: (p) => `Version ${p.policy_version}`, defaultHidden: true },
    { key: "running", header: "Running", type: "number", value: (p) => p.running },
    { key: "active", header: "Sold", value: (p) => (p.active ? "Yes" : "No"), render: (p) => <ActiveBadge active={p.active} /> },
  ], [biz]);
  return (
    <div className="stack">
      <BusinessHeader icon="book" title="Membership plans"
        description="The plans the desk sells: by days or months, a pack of sessions, or sessions within a time; each sold as its own service item with its GST and SAC."
        primary={canEdit && <button type="button" className="button" onClick={() => setEditing({})}><Icon name="plus" size={16} /> Add a plan</button>} />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="book" title="Plans">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Plan or item" }} caption="Plans" columns={columns} rowKey={(p) => p.id}
          rowNoun={["plan", "plans"]} currency={biz.symbol} onRowClick={canEdit ? (p) => setEditing(p) : undefined}
          toolbar={<label className="checkbox bz-check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> Show plans not sold any more</label>}
          rowClassName={(p) => (!p.active ? "dg-tone-muted" : "")}
          empty="No plans yet" emptyHint={canEdit ? "Add the plans the desk sells: monthly, quarterly, a pack of classes, a course." : undefined} emptyIcon="book" />
      </SectionCard>
      <CheckInRule />
      {editing && <PlanDialog plan={editing.id ? editing : null} onClose={() => setEditing(null)}
        onSaved={(p) => { setEditing(null); toast.success(`${p.name} saved.`); list.reload(); }} />}
    </div>
  );
}

function CheckInRule() {
  const biz = useOpenBusiness();
  const canEdit = biz.can("settings.edit");
  const [settings, setSettings] = useState(null);
  const [days, setDays] = useState("");
  const [never, setNever] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "member-plans/settings", undefined, controller.signal)
      .then((s) => { setSettings(s); setNever(s.duesBlockDays === null); setDays(s.duesBlockDays === null ? "7" : String(s.duesBlockDays)); })
      .catch(() => setSettings(null));
    return () => controller.abort();
  }, [biz.id]);
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await businessWrite(biz.id, "member-plans/settings", { duesBlockDays: never ? null : days }, "put");
      setSettings(saved);
      toast.success("Check-in rule saved.");
    } catch (err) { toast.error(getErrorMessage(err)); } finally { setSaving(false); }
  };
  if (!settings) return null;
  return (
    <SectionCard icon="check" title="Fees overdue at check-in" description="A member whose fees are overdue by more than these days is turned away at the desk, with the reason.">
      <form className="mem-setting" onSubmit={save}>
        <Field label="Days overdue"><input type="number" min="0" max="365" required disabled={!canEdit || never} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <label className="checkbox bz-check"><input type="checkbox" disabled={!canEdit} checked={never} onChange={(e) => setNever(e.target.checked)} /> Never turn a member away for fees</label>
        {canEdit && <button type="submit" className="button" disabled={saving}>{saving ? "Saving…" : "Save"}</button>}
      </form>
    </SectionCard>
  );
}

function PlanDialog({ plan, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(plan);
  const { options } = useOptions(["tax-rates?active=true"]);
  const slabs = options?.["tax-rates?active=true"] || [];
  const [existing, setExisting] = useState(null);
  const [joining, setJoining] = useState(plan?.joining_sku_id ? { id: plan.joining_sku_id, label: plan.joining_label, code: plan.joining_code } : null);
  const [form, setForm] = useState(() => ({
    name: plan?.name || "", kind: plan?.kind || "duration", durationUnit: plan?.duration_unit || "months", duration: plan?.duration ? String(plan.duration) : "1",
    sessions: plan?.sessions ? String(plan.sessions) : "", useExisting: false, price: plan ? String(plan.price) : "", taxRateId: plan?.tax_rate_id ? String(plan.tax_rate_id) : "",
    hsnCode: plan?.hsn_code || "999723", maxFreezes: plan ? String(plan.max_freezes) : "0", maxFreezeDays: plan ? String(plan.max_freeze_days) : "0",
    graceDays: plan ? String(plan.grace_days) : "0", transferable: plan ? plan.transferable : false, policy: plan?.policy || POLICY, active: plan ? plan.active : true,
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const slab = form.taxRateId || String(slabs.find((r) => Number(r.rate) === 5)?.id || "");
  const searchServices = (q, { signal }) => businessRead(biz.id, "catalog", { kind: "service", active: "true", q, limit: 15 }, signal).then((page) => page.items);
  const submit = () => {
    const terms = { name: form.name, kind: form.kind, ...(form.kind !== "sessions" ? { durationUnit: form.durationUnit, duration: form.duration } : {}),
      ...(form.kind !== "duration" ? { sessions: form.sessions } : {}), maxFreezes: form.kind === "sessions" ? "0" : form.maxFreezes,
      maxFreezeDays: form.kind === "sessions" ? "0" : form.maxFreezeDays, graceDays: form.graceDays, transferable: form.transferable, policy: form.policy,
      joiningSkuId: joining?.id || null };
    if (editing) return businessWrite(biz.id, `member-plans/plans/${plan.id}`, { ...terms, active: form.active, price: form.price, taxRateId: slab, hsnCode: form.hsnCode }, "put");
    if (form.useExisting && !existing) throw new Error("Choose the service item the plan is sold as");
    return businessWrite(biz.id, "member-plans/plans", { ...terms, item: form.useExisting ? { skuId: existing.id } : { price: form.price, taxRateId: slab, hsnCode: form.hsnCode } });
  };
  return (
    <FormDialog title={editing ? `Change ${plan.name}` : "Add a plan"} icon="book" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={editing ? "Save" : "Add the plan"}
      description={editing ? "Changes apply to memberships sold from now on: those sold keep their terms. A changed policy becomes its next version." : "The plan is sold as a service item of its own, named as the plan."}>
      <Field label="Plan name"><input required maxLength={100} value={form.name} onChange={set("name")} placeholder="e.g. Gym monthly" /></Field>
      <Field label="Kind"><select value={form.kind} onChange={set("kind")}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></Field>
      {form.kind !== "sessions" && (
        <>
          <Field label={wordOf(UNITS, form.durationUnit)}><input type="number" required min="1" max={form.durationUnit === "months" ? 120 : 3660} value={form.duration} onChange={set("duration")} /></Field>
          <Field label="Counted in"><select value={form.durationUnit} onChange={set("durationUnit")}>{UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></Field>
        </>
      )}
      {form.kind !== "duration" && <Field label="Sessions"><input type="number" required min="1" max="1000" value={form.sessions} onChange={set("sessions")} /></Field>}
      {!editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.useExisting} onChange={set("useExisting")} /> Sold as a service item already in the catalogue</label>}
      {!editing && form.useExisting ? (
        <div className="field-wide">
          <SearchPicker label="Service item" placeholder="Name or code" value={existing} onChange={setExisting} minChars={1} search={searchServices}
            getLabel={(s) => s.label} getDescription={(s) => `${s.code} · ${biz.exact(s.price)} + GST ${Number(s.tax_rate)}%${s.hsn_code ? ` · SAC ${s.hsn_code}` : ""}`} />
        </div>
      ) : (
        <>
          <Field label="Price (before GST)"><input type="number" required min="0" step="0.01" value={form.price} onChange={set("price")} /></Field>
          <Field label="GST" hint="Gym, yoga, fitness and personal training: 5%, without input tax credit. Coaching and tuition, and dance, music or art classes: 18%.">
            <select required value={slab} onChange={set("taxRateId")}>{slabs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </Field>
          <Field label="SAC" hint="999723 for a gym, yoga or fitness centre; 999293 for coaching; 999291 for dance, music and art classes.">
            <input inputMode="numeric" maxLength={8} className="mono" value={form.hsnCode} onChange={set("hsnCode")} />
          </Field>
        </>
      )}
      <div className="field-wide">
        <SearchPicker label="Joining fee item (optional)" placeholder="A service such as Joining fee" value={joining} onChange={setJoining} minChars={1} search={searchServices}
          getLabel={(s) => s.label} getDescription={(s) => `${s.code || ""}${s.price !== undefined ? ` · ${biz.exact(s.price)}` : ""}`} />
      </div>
      {form.kind !== "sessions" && (
        <>
          <Field label="Freezes allowed"><input type="number" min="0" max="12" value={form.maxFreezes} onChange={set("maxFreezes")} /></Field>
          <Field label="Days frozen in all"><input type="number" min="0" max="365" value={form.maxFreezeDays} onChange={set("maxFreezeDays")} /></Field>
        </>
      )}
      <Field label="Grace days" hint="Days after the last day on which the member is still let in."><input type="number" min="0" max="90" value={form.graceDays} onChange={set("graceDays")} /></Field>
      <label className="checkbox bz-check"><input type="checkbox" checked={form.transferable} onChange={set("transferable")} /> Can be passed on to another member</label>
      <Field label={editing ? `Refund policy (now version ${plan.policy_version})` : "Refund policy"} wide hint="Printed on the membership slip; a membership keeps the version it was sold with.">
        <textarea required rows={4} maxLength={4000} value={form.policy} onChange={set("policy")} />
      </Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> Sold (untick to stop selling it)</label>}
    </FormDialog>
  );
}
