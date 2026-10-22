import { useEffect, useMemo, useState } from "react";
import Modal from "../../../components/Modal";
import FormField from "../../../components/FormField";
import SearchPicker from "../../../components/SearchPicker";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useTasks from "./useTasks";
import { AssignField, CategorySelect, PlaceSelect } from "./parts";
import { FREQUENCIES, WEEKDAYS, todayText } from "./taskWords";

// A recurring task: what (a template or just a title), who, where, how often
// (every day, working days, chosen weekdays, a date each month, every few
// days, every shift), at what times, from when until when.
export default function ScheduleFormDialog({ schedule, template, onClose, onSaved }) {
  const t = useTasks();
  const editing = Boolean(schedule);
  const suggested = template?.suggested;
  const [library, setLibrary] = useState([]);
  const [own, setOwn] = useState([]);
  // undefined: not touched yet (a schedule being changed shows its saved template).
  const [source, setSource] = useState(() => (template ? { ...template, key: template.source === "own" ? `own:${template.id}` : `lib:${template.code}` } : undefined));
  const [form, setForm] = useState(() => ({
    title: schedule?.title || template?.name || "",
    description: schedule?.description || "",
    category: schedule?.category || template?.category || "day_to_day",
    priority: schedule?.priority || template?.priority || "normal",
    frequency: schedule?.frequency || suggested?.frequency || "daily",
    weekdays: schedule?.weekdays || suggested?.weekdays || [1, 2, 3, 4, 5, 6],
    monthDay: schedule?.monthDay || suggested?.monthDay || 1,
    everyN: schedule?.everyN || suggested?.everyN || 2,
    dueTimes: schedule?.dueTimes || suggested?.times || ["18:00"],
    windowMinutes: schedule?.windowMinutes ?? suggested?.windowMinutes ?? "",
    shiftId: schedule?.shiftId || "",
    startsOn: schedule?.startsOn || todayText(),
    endsOn: schedule?.endsOn || "",
    placeId: schedule?.placeId || null,
    requiresReview: schedule?.requiresReview ?? template?.requiresReview ?? false,
  }));
  const [assignMode, setAssignMode] = useState(schedule?.assignMode || "on_shift");
  const [assignees, setAssignees] = useState(schedule?.assignees || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    t.api.library().then(setLibrary).catch(() => {});
    t.api.templates().then(setOwn).catch(() => {});
  }, [t.api]);
  const options = useMemo(() => [
    ...own.filter((x) => x.active).map((x) => ({ ...x, key: `own:${x.id}`, group: "Our templates" })),
    ...library.map((x) => ({ ...x, key: `lib:${x.code}`, group: "Library" })),
  ], [own, library]);
  // A schedule being changed shows its template once the lists arrive.
  const savedKey = schedule?.templateId ? `own:${schedule.templateId}` : schedule?.libraryCode ? `lib:${schedule.libraryCode}` : null;
  const chosen = source === undefined ? (savedKey && options.find((o) => o.key === savedKey)) || null : source;

  const toggleDay = (d) => set("weekdays", form.weekdays.includes(d) ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d].sort());
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = {
      title: form.title, description: form.description || null, category: form.category, priority: form.priority, frequency: form.frequency,
      weekdays: ["weekly", "weekdays"].includes(form.frequency) ? form.weekdays : null, monthDay: form.frequency === "monthly" ? Number(form.monthDay) : null,
      everyN: form.frequency === "every_n_days" ? Number(form.everyN) : null, dueTimes: form.dueTimes.filter(Boolean),
      windowMinutes: form.windowMinutes === "" ? null : Number(form.windowMinutes), shiftId: form.frequency === "per_shift" && form.shiftId ? Number(form.shiftId) : null,
      startsOn: form.startsOn, endsOn: form.endsOn || null, placeId: form.placeId, requiresReview: form.requiresReview,
      assignMode, assignees: assignees.map(({ kind, id }) => ({ kind, id })),
      templateId: chosen?.source === "own" ? chosen.id : null, libraryCode: chosen && chosen.source !== "own" ? chosen.code : null,
    };
    try {
      const saved = editing ? await t.api.updateSchedule(schedule.id, body) : await t.api.createSchedule(body);
      toast.success(editing ? "Recurring task saved" : `Recurring task set up: ${saved.title}`);
      onSaved?.(saved);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? "Change recurring task" : "New recurring task"} icon="refresh" onClose={onClose} width={720} dismissible={!busy}>
      <form className="form-grid tk-form" onSubmit={submit}>
        <div className="field-wide">
          <SearchPicker label="Checklist (template)" hint="Optional. Each day's task gets a fresh copy of it." placeholder="Opening checklist, temperature log…"
            options={options} value={chosen} getKey={(o) => o.key} getLabel={(o) => o.name} getDescription={(o) => `${o.group} · ${t.categoryName(o.category)} · ${o.itemCount} checks`}
            minChars={0} onChange={(o) => { setSource(o); if (o) setForm((f) => ({ ...f, title: f.title || o.name, category: o.category, priority: o.priority || f.priority })); }} />
        </div>
        <FormField label="Title" wide><input value={form.title} maxLength={160} required onChange={(e) => set("title", e.target.value)} /></FormField>
        <FormField label="Repeats">
          <select value={form.frequency} onChange={(e) => set("frequency", e.target.value)}>
            {FREQUENCIES.map(([code, label]) => <option key={code} value={code} disabled={code === "per_shift" && t.world === "restaurant" && !t.shifts.length}>{label}</option>)}
          </select>
        </FormField>
        {["weekly", "weekdays"].includes(form.frequency) && (
          <fieldset className="field">
            <legend>On</legend>
            <div className="tk-days">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button key={d} type="button" className={`tk-day ${form.weekdays.includes(d) ? "is-on" : ""}`} aria-pressed={form.weekdays.includes(d)} onClick={() => toggleDay(d)}>{WEEKDAYS[d]}</button>
              ))}
            </div>
          </fieldset>
        )}
        {form.frequency === "monthly" && <FormField label="Day of the month" hint="31 means the last day of short months"><input type="number" min={1} max={31} value={form.monthDay} required onChange={(e) => set("monthDay", e.target.value)} /></FormField>}
        {form.frequency === "every_n_days" && <FormField label="Every how many days"><input type="number" min={1} max={365} value={form.everyN} required onChange={(e) => set("everyN", e.target.value)} /></FormField>}
        {form.frequency === "per_shift" && t.world === "restaurant" ? (
          <FormField label="Shift" optional hint="Due at the end of each shift">
            <select value={form.shiftId} onChange={(e) => set("shiftId", e.target.value)}>
              <option value="">Every shift</option>
              {t.shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start}–{s.end})</option>)}
            </select>
          </FormField>
        ) : (
          <fieldset className="field">
            <legend>{form.frequency === "per_shift" ? "Shift change times" : "Due at"}</legend>
            <div className="tk-times">
              {form.dueTimes.map((time, i) => (
                <span key={i} className="tk-time">
                  <input type="time" aria-label={`Time ${i + 1}`} value={time} required onChange={(e) => set("dueTimes", form.dueTimes.map((x, xi) => (xi === i ? e.target.value : x)))} />
                  {form.dueTimes.length > 1 && <button type="button" className="button button-ghost button-icon button-sm" aria-label={`Remove time ${i + 1}`} onClick={() => set("dueTimes", form.dueTimes.filter((_, xi) => xi !== i))}><Icon name="x" size={12} /></button>}
                </span>
              ))}
              {form.dueTimes.length < 12 && <button type="button" className="chip-button" onClick={() => set("dueTimes", [...form.dueTimes, "16:00"])}>+ Time</button>}
            </div>
            <small className="muted">Several times a day: each one closes when the next is due.</small>
          </fieldset>
        )}
        {form.frequency !== "per_shift" && (
          <FormField label="Opens before it is due" optional hint="Minutes. Empty: open all day">
            <input type="number" min={5} max={1440} value={form.windowMinutes} onChange={(e) => set("windowMinutes", e.target.value)} />
          </FormField>
        )}
        <FormField label="Starts on"><input type="date" value={form.startsOn} required onChange={(e) => set("startsOn", e.target.value)} /></FormField>
        <FormField label="Stops on" optional><input type="date" value={form.endsOn} min={form.startsOn} onChange={(e) => set("endsOn", e.target.value)} /></FormField>
        <CategorySelect value={form.category} onChange={(v) => set("category", v)} />
        <FormField label="Priority">
          <select value={form.priority} onChange={(e) => set("priority", e.target.value)}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </FormField>
        <PlaceSelect value={form.placeId} onChange={(v) => set("placeId", v)} />
        <AssignField mode={assignMode} assignees={assignees} onChange={(mode, list) => { setAssignMode(mode); setAssignees(list); }} />
        <label className="field field-wide tk-inline"><input type="checkbox" checked={form.requiresReview} onChange={(e) => set("requiresReview", e.target.checked)} /> A manager reviews each one when it is done</label>
        <p className="muted small field-wide">Missed: a day's task not done by the end of its window (the end of the trading day, at the day cut-off hour set in settings) is marked missed and counts against compliance.</p>
        <ErrorMessage message={error} />
        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="button" disabled={busy}>{busy ? "Saving…" : editing ? "Save" : "Set up"}</button>
        </div>
      </form>
    </Modal>
  );
}
