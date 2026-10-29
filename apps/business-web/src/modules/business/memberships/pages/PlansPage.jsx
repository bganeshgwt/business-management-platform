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
import { KINDS, PENALTIES, UNITS, VISIT_PERIODS, optionWords, termWords, wordOf } from "./memberships";
import "../styles/memberships.css";

// Membership plans: each plan with its item's price, GST and SAC (a gym,
// yoga, fitness or personal-training plan is taxed at 5% without input tax
// credit; coaching, tuition and dance, music or art classes at 18%: the
// item's own slab), its joining fee, how it may be
// frozen, its grace days, whether it can be passed on and its refund policy
// (a changed policy is its next version; memberships keep the one they were
// sold with). Plans are switched off, never deleted. A plan may also limit
// visits, let members in only at some branches or hours, have seats for a
// couple, a family or a company, book only some classes, and take fees for a
// freeze, a transfer and a late instalment (disclosed at the sale). Below:
// when overdue fees turn a member away at check-in, the class penalties, and
// when a pack's sessions run low.

const POLICY = "If you cancel, the fee for the days (or sessions) you have not used is refunded pro rata, as worked out on the day you cancel. The joining fee is not refunded.";

export default function PlansPage() {
  const biz = useOpenBusiness();
  const [showOff, setShowOff] = useState(false);
  const list = useServerList("member-plans/plans", { gridId: "member-plans", params: showOff ? {} : { active: "true" } });
  const [editing, setEditing] = useState(null);
  const canEdit = biz.can("member_plans.edit");
  const columns = useMemo(() => [
    { key: "name", header: "Plan", value: (p) => p.name, mobile: "title", pin: true,
      render: (p) => <span className="bz-two-line"><span>{p.name}</span><small className="muted">{[termWords(p), optionWords(p)].filter(Boolean).join(" · ")}</small></span> },
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
  const [rules, setRules] = useState({ lateCancelPenalty: "none", noShowPenalty: "none", penaltyFee: "0", lowSessions: "2" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "member-plans/settings", undefined, controller.signal)
      .then((s) => {
        setSettings(s); setNever(s.duesBlockDays === null); setDays(s.duesBlockDays === null ? "7" : String(s.duesBlockDays));
        setRules({ lateCancelPenalty: s.lateCancelPenalty, noShowPenalty: s.noShowPenalty, penaltyFee: String(Number(s.penaltyFee)), lowSessions: String(s.lowSessions) });
      })
      .catch(() => setSettings(null));
    return () => controller.abort();
  }, [biz.id]);
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const saved = await businessWrite(biz.id, "member-plans/settings", { duesBlockDays: never ? null : days, ...rules }, "put");
      setSettings(saved);
      toast.success("Settings saved.");
    } catch (err) { toast.error(getErrorMessage(err)); } finally { setSaving(false); }
  };
  const setRule = (name) => (e) => setRules((r) => ({ ...r, [name]: e.target.value }));
  if (!settings) return null;
  const fee = rules.lateCancelPenalty === "fee" || rules.noShowPenalty === "fee";
  return (
    <SectionCard icon="check" title="Check-in, classes and reminders"
      description="A member whose fees are overdue by more than these days is turned away at the desk, with the reason. A late cancel (after a class's cut-off) or a no-show takes the penalty chosen here.">
      <form className="mem-setting" onSubmit={save}>
        <Field label="Days overdue"><input type="number" min="0" max="365" required disabled={!canEdit || never} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <label className="checkbox bz-check"><input type="checkbox" disabled={!canEdit} checked={never} onChange={(e) => setNever(e.target.checked)} /> Never turn a member away for fees</label>
        <Field label="A late cancel"><select disabled={!canEdit} value={rules.lateCancelPenalty} onChange={setRule("lateCancelPenalty")}>{PENALTIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
        <Field label="A no-show"><select disabled={!canEdit} value={rules.noShowPenalty} onChange={setRule("noShowPenalty")}>{PENALTIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
        {fee && <Field label="Penalty fee" hint="Billed as a service at the member's plan's slab."><input type="number" min="0.01" step="0.01" required disabled={!canEdit} value={rules.penaltyFee} onChange={setRule("penaltyFee")} /></Field>}
        <Field label="Sessions left that count as running low"><input type="number" min="1" max="100" required disabled={!canEdit} value={rules.lowSessions} onChange={setRule("lowSessions")} /></Field>
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
    visitLimit: plan?.visit_limit ? String(plan.visit_limit) : "", visitPeriod: plan?.visit_period || "week", branches: (plan?.access_locations || []).map(String),
    accessFrom: plan?.access_from ? String(plan.access_from).slice(0, 5) : "", accessTo: plan?.access_to ? String(plan.access_to).slice(0, 5) : "", seats: plan ? String(plan.seats) : "1",
    classes: !plan || plan.class_names === null ? "all" : plan.class_names.length ? "some" : "none", classNames: (plan?.class_names || []).join(", "),
    personalTraining: plan ? plan.personal_training : false, freezeFee: plan ? String(Number(plan.freeze_fee)) : "0", freezeNoticeDays: plan ? String(plan.freeze_notice_days) : "0",
    transferFee: plan ? String(Number(plan.transfer_fee)) : "0", lateFee: plan ? String(Number(plan.late_fee)) : "0", lateFeeAfterDays: plan ? String(plan.late_fee_after_days) : "0",
    joiningRefundPercent: plan ? String(plan.joining_refund_percent) : "0",
  }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const slab = form.taxRateId || String(slabs.find((r) => Number(r.rate) === 5)?.id || "");
  const searchServices = (q, { signal }) => businessRead(biz.id, "catalog", { kind: "service", active: "true", q, limit: 15 }, signal).then((page) => page.items);
  const frozen = form.kind !== "sessions" && Number(form.maxFreezes) > 0;
  const toggleBranch = (id) => setForm((f) => ({ ...f, branches: f.branches.includes(String(id)) ? f.branches.filter((x) => x !== String(id)) : [...f.branches, String(id)] }));
  const submit = () => {
    const terms = { name: form.name, kind: form.kind, ...(form.kind !== "sessions" ? { durationUnit: form.durationUnit, duration: form.duration } : {}),
      ...(form.kind !== "duration" ? { sessions: form.sessions } : {}), maxFreezes: form.kind === "sessions" ? "0" : form.maxFreezes,
      maxFreezeDays: form.kind === "sessions" ? "0" : form.maxFreezeDays, graceDays: form.graceDays, transferable: form.transferable, policy: form.policy,
      joiningSkuId: joining?.id || null, ...(form.visitLimit ? { visitLimit: form.visitLimit, visitPeriod: form.visitPeriod } : {}),
      accessLocations: form.branches.length ? form.branches : null, ...(form.accessFrom || form.accessTo ? { accessFrom: form.accessFrom, accessTo: form.accessTo } : {}), seats: form.seats,
      classNames: form.classes === "all" ? null : form.classes === "none" ? [] : form.classNames.split(",").map((x) => x.trim()).filter(Boolean),
      personalTraining: form.personalTraining, freezeFee: frozen ? form.freezeFee : "0", freezeNoticeDays: frozen ? form.freezeNoticeDays : "0",
      transferFee: form.transferable ? form.transferFee : "0", lateFee: form.lateFee, lateFeeAfterDays: form.lateFeeAfterDays, joiningRefundPercent: form.joiningRefundPercent };
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
      {frozen && (
        <>
          <Field label="Freeze fee" hint="Billed with each freeze, at the plan's slab."><input type="number" min="0" step="0.01" value={form.freezeFee} onChange={set("freezeFee")} /></Field>
          <Field label="Days of notice for a freeze"><input type="number" min="0" max="60" value={form.freezeNoticeDays} onChange={set("freezeNoticeDays")} /></Field>
        </>
      )}
      <Field label="Grace days" hint="Days after the last day on which the member is still let in."><input type="number" min="0" max="90" value={form.graceDays} onChange={set("graceDays")} /></Field>
      <label className="checkbox bz-check"><input type="checkbox" checked={form.transferable} onChange={set("transferable")} /> Can be passed on to another member</label>
      {form.transferable && <Field label="Transfer fee"><input type="number" min="0" step="0.01" value={form.transferFee} onChange={set("transferFee")} /></Field>}
      <Field label="Visits allowed" hint="Empty: no limit."><input type="number" min="1" max="1000" value={form.visitLimit} onChange={set("visitLimit")} /></Field>
      {form.visitLimit && <Field label="Counted"><select value={form.visitPeriod} onChange={set("visitPeriod")}>{VISIT_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>}
      <Field label="Let in from" hint="Empty: any time the business is open."><input type="time" value={form.accessFrom} onChange={set("accessFrom")} /></Field>
      <Field label="Let in until"><input type="time" value={form.accessTo} onChange={set("accessTo")} /></Field>
      {biz.locations.length > 1 && (
        <fieldset className="field-wide mem-branches">
          <legend>Branches it lets the member in at (none ticked: every branch)</legend>
          {biz.locations.map((l) => <label key={l.id} className="checkbox bz-check"><input type="checkbox" checked={form.branches.includes(String(l.id))} onChange={() => toggleBranch(l.id)} /> {l.name}</label>)}
        </fieldset>
      )}
      <Field label="Seats" hint="2 for a couple, more for a family or a company: each member checks in on their own."><input type="number" min="1" max="50" value={form.seats} onChange={set("seats")} /></Field>
      <Field label="Classes it books"><select value={form.classes} onChange={set("classes")}><option value="all">Every class</option><option value="some">Only these classes</option><option value="none">No classes</option></select></Field>
      {form.classes === "some" && <Field label="Class names" hint="As on the timetable, with commas: Yoga, Zumba"><input required maxLength={800} value={form.classNames} onChange={set("classNames")} /></Field>}
      <label className="checkbox bz-check"><input type="checkbox" checked={form.personalTraining} onChange={set("personalTraining")} /> A personal-training plan (counts as PT sales for trainers' pay)</label>
      <Field label="Late fee on an instalment" hint="Disclosed at the sale; billed when someone confirms it."><input type="number" min="0" step="0.01" value={form.lateFee} onChange={set("lateFee")} /></Field>
      {Number(form.lateFee) > 0 && <Field label="Days overdue before the late fee"><input type="number" min="0" max="90" value={form.lateFeeAfterDays} onChange={set("lateFeeAfterDays")} /></Field>}
      {joining && <Field label="Joining fee that can come back (%)"><input type="number" min="0" max="100" value={form.joiningRefundPercent} onChange={set("joiningRefundPercent")} /></Field>}
      <Field label={editing ? `Refund policy (now version ${plan.policy_version})` : "Refund policy"} wide hint="Printed on the membership slip; a membership keeps the version it was sold with.">
        <textarea required rows={4} maxLength={4000} value={form.policy} onChange={set("policy")} />
      </Field>
      {editing && <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.active} onChange={set("active")} /> Sold (untick to stop selling it)</label>}
    </FormDialog>
  );
}
