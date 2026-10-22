import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import DataGrid from "../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import { dateShort } from "@bmp/shared/format";
import { getErrorMessage } from "../../../services/api";
import useTasks from "./useTasks";
import { Progress, StatusPill } from "./parts";
import { ProjectFormDialog } from "./forms";

// Projects: bigger jobs with an owner, members, milestones and task lists.
// Progress is done tasks of all tasks (cancelled ones left out).

const SHOW = [["live", "Current"], ["completed", "Completed"], ["", "All"]];

export default function ProjectsPage() {
  const t = useTasks();
  const navigate = useNavigate();
  const [show, setShow] = useState("live");
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => t.api.projects({ status: show || undefined }).then((v) => { setRows(v); setError(""); }).catch((err) => setError(getErrorMessage(err))), [t.api, show]);
  useEffect(() => { load(); }, [load]);

  const columns = [
    { key: "name", header: "Project", value: (r) => r.name, mobile: "title", minWidth: 220, render: (r) => <Link to={t.link(`projects/${r.id}`)} className="tk-grid-title">{r.name}</Link> },
    { key: "status", header: "Status", type: "status", value: (r) => r.status, render: (r) => <StatusPill kind="project" status={r.status} />, mobile: "subtitle" },
    { key: "progress", header: "Progress", type: "percent", value: (r) => r.progressPercent,
      render: (r) => <Progress done={r.doneCount} total={r.taskCount || 1} label={r.taskCount ? `${r.progressPercent}% · ${r.doneCount}/${r.taskCount}` : "No tasks"} /> },
    { key: "next", header: "Next milestone", value: (r) => r.milestones?.next?.name || "",
      render: (r) => (r.milestones?.next ? <span>{r.milestones.next.name}{r.milestones.next.dueOn && <span className="muted small"> · {dateShort(r.milestones.next.dueOn)}</span>}</span> : <span className="muted">—</span>) },
    { key: "owner", header: "Owner", value: (r) => r.ownerName },
    { key: "end", header: "Ends", type: "date", value: (r) => r.endOn, render: (r) => (r.endOn ? <span className={r.late ? "text-danger" : ""}>{dateShort(r.endOn)}{r.late ? " (late)" : ""}</span> : "—") },
    { key: "overdue", header: "Overdue tasks", type: "number", value: (r) => r.overdueCount },
    { key: "members", header: "Members", type: "number", value: (r) => r.memberCount, defaultHidden: true },
    { key: "start", header: "Starts", type: "date", value: (r) => r.startOn, defaultHidden: true },
    { key: "place", header: t.placeWord, value: (r) => r.placeName || "Whole business", defaultHidden: true },
  ];

  return (
    <div className="stack tk-page">
      <PageHeader title="Projects" icon="layers" description="A new outlet, a festival sale, the annual stock audit: milestones, task lists and who is on it."
        primary={t.can("projects.create") && <button type="button" className="button" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New project</button>} />
      <div className="segmented tk-status-filter" role="group" aria-label="Show" data-motion-tabs>
        {SHOW.map(([code, label]) => <button key={code} type="button" className={`segment ${show === code ? "is-active" : ""}`} aria-pressed={show === code} onClick={() => setShow(code)}>{label}</button>)}
      </div>
      <DataGrid id="tasks-projects" caption="Projects" columns={columns} rows={rows || []} loading={!rows && !error} error={error || undefined} onRetry={load}
        rowNoun={["project", "projects"]} exportName="projects" onRowClick={(r) => navigate(t.link(`projects/${r.id}`))}
        rowClassName={(r) => (r.late ? "dg-tone-danger" : ["completed", "cancelled"].includes(r.status) ? "dg-tone-muted" : "")}
        empty="No projects yet" emptyIcon="layers" emptyHint={t.can("projects.create") ? "Start one from a ready plan: New outlet opening, Festival sale set-up, Annual stock audit…" : "Projects you are a member of show here."} />
      {creating && <ProjectFormDialog onClose={() => setCreating(false)} onSaved={() => setCreating(false)} />}
    </div>
  );
}
