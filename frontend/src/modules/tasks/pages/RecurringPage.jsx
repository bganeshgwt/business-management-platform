import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import DataGrid from "../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../components/ActionMenu";
import Modal from "../../../components/Modal";
import Icon from "../../../components/Icon";
import { dateShort } from "../../../services/format";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useConfirm from "../../../hooks/useConfirm";
import useTasks from "./useTasks";
import ScheduleFormDialog from "./ScheduleForm";
import { CategoryTag } from "./parts";
import { frequencyText } from "./taskWords";

// Recurring tasks: the opening checklist every morning, the temperature log
// twice a day, the stock check at month end. Each shows how it went in the
// last 30 days ("28/30 done") and opens a day-by-day strip.

export function ComplianceStrip({ days }) {
  return (
    <ol className="tk-strip" aria-label="Day by day">
      {days.map((d, i) => (
        <li key={`${d.day}-${i}`} className={`tk-strip-cell is-${d.status} ${d.failed ? "has-failed" : ""}`} title={`${dateShort(d.day)}: ${d.status.replace("_", " ")}${d.failed ? ", with failed checks" : ""}`}>
          <span className="visually-hidden">{dateShort(d.day)} {d.status}</span>
        </li>
      ))}
    </ol>
  );
}

function ComplianceDialog({ schedule, onClose }) {
  const t = useTasks();
  const [data, setData] = useState(null);
  useEffect(() => { t.api.compliance(schedule.id).then(setData).catch((err) => toast.error(getErrorMessage(err))); }, [t.api, schedule.id]);
  return (
    <Modal title={schedule.title} icon="refresh" description={`${frequencyText(schedule)} · last 30 days`} onClose={onClose} width={700}>
      {!data ? <p className="muted">Loading…</p> : (
        <div className="stack">
          <ComplianceStrip days={data.days} />
          <p className="tk-legend"><span className="tk-strip-cell is-done" /> Done <span className="tk-strip-cell is-missed" /> Missed <span className="tk-strip-cell is-todo" /> To do / not yet <span className="tk-strip-cell is-done has-failed" /> Done with failed checks</p>
          <DataGrid id="tasks-compliance-days" caption="Days" variant="compact" rows={[...data.days].reverse()} rowKey={(d) => `${d.day}-${d.slot}`} rowNoun={["day", "days"]}
            columns={[
              { key: "day", header: "Day", type: "date", value: (d) => d.day, mobile: "title" },
              { key: "status", header: "Status", type: "status", value: (d) => d.status },
              { key: "done", header: "Done at", type: "datetime", value: (d) => d.completed_at },
              { key: "late", header: "On time", value: (d) => (d.completed_at ? (new Date(d.completed_at) <= new Date(d.due_at) ? "Yes" : "Late") : "") },
              { key: "failed", header: "Failed checks", type: "number", value: (d) => d.failed_count },
              { key: "open", header: "", type: "actions", render: (d) => <Link className="chip-button" to={t.link(`run/${d.id}`)}>Open</Link> },
            ]} />
        </div>
      )}
    </Modal>
  );
}

export default function RecurringPage() {
  const t = useTasks();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const load = useCallback(() => t.api.schedules({ all: 1 }).then((v) => { setRows(v); setError(""); }).catch((err) => setError(getErrorMessage(err))), [t.api]);
  useEffect(() => { load(); }, [load]);

  const pause = async (row) => {
    if (row.active && !(await confirm({ title: `Pause “${row.title}”?`, message: "Its tasks still to come and not started are cancelled. Resume it any time.", confirmLabel: "Pause", tone: "primary" }))) return;
    try {
      await t.api.scheduleActive(row.id, !row.active);
      toast.success(row.active ? "Paused" : "Resumed");
      load();
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const rate = (r) => (r.compliance?.due ? Math.round((100 * r.compliance.done) / r.compliance.due) : null);
  const columns = [
    { key: "title", header: "Recurring task", value: (r) => r.title, mobile: "title", minWidth: 220 },
    { key: "repeats", header: "Repeats", value: (r) => frequencyText(r), mobile: "subtitle" },
    { key: "who", header: "Assigned to", value: (r) => (r.assignMode === "on_shift" ? "Whoever is on shift" : r.assignMode === "unassigned" ? "Not assigned" : r.assignees.map((a) => a.name).join(", ")) },
    { key: "compliance", header: "Last 30 days", value: (r) => rate(r),
      render: (r) => (r.compliance?.due ? <span className={`tk-rate ${rate(r) >= 90 ? "is-good" : rate(r) >= 70 ? "is-ok" : "is-bad"}`}>{r.compliance.done}/{r.compliance.due} done · {rate(r)}%</span> : <span className="muted">Nothing due yet</span>),
      csv: (r) => (r.compliance?.due ? `${r.compliance.done}/${r.compliance.due}` : "") },
    { key: "missed", header: "Missed", type: "number", value: (r) => r.compliance?.missed ?? 0 },
    { key: "category", header: "Category", value: (r) => t.categoryName(r.category), render: (r) => <CategoryTag code={r.category} /> },
    { key: "template", header: "Checklist", value: (r) => r.templateName || (r.libraryCode ? "From the library" : "None") },
    { key: "place", header: t.placeWord, value: (r) => r.placeName || "Whole business", defaultHidden: t.places.length < 2 },
    { key: "state", header: "State", type: "status", value: (r) => (r.active ? "active" : "on_hold"), render: (r) => <span className={`tk-tag ${r.active ? "tone-success" : "tone-warning"}`}>{r.active ? "Running" : "Paused"}</span> },
    { key: "period", header: "From – to", value: (r) => `${dateShort(r.startsOn)} – ${r.endsOn ? dateShort(r.endsOn) : "no end"}`, defaultHidden: true },
    { key: "actions", header: "", type: "actions", render: (r) => (
      <ActionMenu label={`Actions for ${r.title}`} items={[
        { label: "Day by day", icon: "calendar", onClick: () => setDialog({ kind: "days", schedule: r }) },
        t.can("tasks.assign") && { label: "Change", icon: "edit", onClick: () => setDialog({ kind: "edit", schedule: r }) },
        t.can("tasks.assign") && { label: r.active ? "Pause" : "Resume", icon: r.active ? "ban" : "refresh", onClick: () => pause(r) },
        { label: "See its tasks", icon: "list", onClick: () => navigate(`${t.link("board")}?schedule=${r.id}&ahead=all`) },
      ].filter(Boolean)} />
    ) },
  ];

  return (
    <div className="stack tk-page">
      <PageHeader title="Recurring tasks" icon="refresh" description="Checklists that come back on their own. A day not done in time is missed and counts against compliance."
        primary={t.can("tasks.assign") && <button type="button" className="button" onClick={() => setDialog({ kind: "edit", schedule: null })}><Icon name="plus" size={16} /> New recurring task</button>} />
      <DataGrid id="tasks-recurring" caption="Recurring tasks" columns={columns} rows={rows || []} loading={!rows && !error} error={error || undefined} onRetry={load}
        rowNoun={["recurring task", "recurring tasks"]} exportName="recurring-tasks" onRowClick={(r) => setDialog({ kind: "days", schedule: r })}
        rowClassName={(r) => (!r.active ? "dg-tone-muted" : rate(r) !== null && rate(r) < 70 ? "dg-tone-danger" : "")}
        empty="No recurring tasks yet" emptyIcon="refresh" emptyHint="Set up the opening checklist, a temperature log or a weekly deep clean from the Templates library." />
      {dialog?.kind === "edit" && <ScheduleFormDialog schedule={dialog.schedule} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />}
      {dialog?.kind === "days" && <ComplianceDialog schedule={dialog.schedule} onClose={() => setDialog(null)} />}
    </div>
  );
}
