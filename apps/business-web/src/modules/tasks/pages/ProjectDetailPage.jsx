import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../components/SectionCard";
import StatTile from "../../../components/StatTile";
import DataGrid from "../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../components/ActionMenu";
import { ErrorMessage, ScreenLoading } from "../../../components/Feedback";
import { dateShort, timeOnly } from "@bmp/shared/format";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useConfirm from "../../../hooks/useConfirm";
import useTasks from "./useTasks";
import { Comments, History, Progress, StatusPill } from "./parts";
import { ProjectFormDialog, TaskFormDialog } from "./forms";

// One project: progress, milestones (tick them off), task lists with their
// tasks, members, comments and the history trail.

export default function ProjectDetailPage() {
  const { projectId } = useParams();
  const t = useTasks();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [project, setProject] = useState(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [milestone, setMilestone] = useState({ name: "", dueOn: "" });
  const [listName, setListName] = useState("");
  const [listFilter, setListFilter] = useState("");
  const load = useCallback(() => t.api.project(projectId).then((v) => { setProject(v); setError(""); }).catch((err) => setError(getErrorMessage(err))), [t.api, projectId]);
  useEffect(() => { load(); }, [load]);

  const act = async (work, message) => {
    try {
      const value = await work();
      if (value) setProject(value);
      if (message) toast.success(message);
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err));
      return false;
    }
  };

  if (error) return <div className="stack"><ErrorMessage message={error} /><Link className="button button-secondary" to={t.link("projects")}>Back to projects</Link></div>;
  if (!project) return <ScreenLoading label="Opening the project…" />;
  const can = project.can;
  const listName_ = (id) => project.lists.find((l) => l.id === id)?.name || "No list";
  const shown = project.tasks.filter((x) => !listFilter || String(x.listId || "none") === listFilter);

  return (
    <div className="stack tk-page tk-project">
      <div className="tk-run-head card">
        <Link to={t.link("projects")} className="tk-back"><Icon name="undo" size={14} /> Projects</Link>
        <div className="tk-run-title">
          <h1>{project.name}</h1>
          <div className="tk-run-actions">
            <StatusPill kind="project" status={project.status} />
            {can.edit && <ActionMenu label="Project actions" items={[
              { label: "Change project", icon: "edit", onClick: () => setDialog("edit") },
              project.status !== "completed" && { label: "Mark completed", icon: "check", onClick: () => act(() => t.api.updateProject(project.id, { status: "completed" }), "Project completed") },
              project.status === "active" && { label: "Put on hold", icon: "clock", onClick: () => act(() => t.api.updateProject(project.id, { status: "on_hold" }), "On hold") },
              ["on_hold", "planning", "completed"].includes(project.status) && { label: "Make active", icon: "refresh", onClick: () => act(() => t.api.updateProject(project.id, { status: "active" }), "Active") },
            ].filter(Boolean)} />}
          </div>
        </div>
        <div className="tk-card-meta">
          <span><Icon name="user" size={13} /> {project.ownerName}</span>
          {(project.startOn || project.endOn) && <span className={project.late ? "text-danger" : ""}><Icon name="calendar" size={13} /> {project.startOn ? dateShort(project.startOn) : "?"} – {project.endOn ? dateShort(project.endOn) : "open"}{project.late ? " (late)" : ""}</span>}
          {project.placeName && <span><Icon name="store" size={13} /> {project.placeName}</span>}
          <span><Icon name="users" size={13} /> {project.members.map((m) => m.name).join(", ")}</span>
        </div>
        {project.description && <p className="tk-run-desc">{project.description}</p>}
        <div className="tk-run-progress"><Progress done={project.doneCount} total={project.taskCount || 1} label={`${project.progressPercent}% done · ${project.doneCount} of ${project.taskCount} tasks`} /></div>
      </div>

      <div className="tk-tiles">
        <StatTile icon="check" label="Tasks done" value={`${project.doneCount}/${project.taskCount}`} tone="success" />
        <StatTile icon="alert" label="Overdue tasks" value={String(project.overdueCount)} tone={project.overdueCount ? "danger" : "neutral"} />
        <StatTile icon="star" label="Milestones" value={`${project.milestoneList.filter((m) => m.doneAt).length}/${project.milestoneList.length}`} tone="info" />
      </div>

      <SectionCard icon="star" title="Milestones" description="The points that matter. Tick one when it is reached.">
        <DataGrid id="tasks-project-milestones" caption="Milestones" variant="compact" rows={project.milestoneList} rowNoun={["milestone", "milestones"]} empty="No milestones yet" emptyIcon="star"
          rowClassName={(m) => (m.doneAt ? "dg-tone-muted" : m.dueOn && m.dueOn < new Date().toISOString().slice(0, 10) ? "dg-tone-danger" : "")}
          columns={[
            { key: "done", header: "", label: "Reached", type: "actions", pin: false, render: (m) => (
              <input type="checkbox" aria-label={`${m.name} reached`} checked={Boolean(m.doneAt)} onChange={(e) => act(() => t.api.updateMilestone(project.id, m.id, { done: e.target.checked }), e.target.checked ? "Milestone reached" : "Milestone reopened")} />) },
            { key: "name", header: "Milestone", value: (m) => m.name, mobile: "title" },
            { key: "due", header: "Due", type: "date", value: (m) => m.dueOn },
            { key: "tasks", header: "Tasks", value: (m) => (m.taskCount ? `${m.doneCount}/${m.taskCount}` : "—") },
            { key: "reached", header: "Reached", value: (m) => (m.doneAt ? `${dateShort(m.doneAt)} · ${m.doneByName}` : "") },
            ...(can.edit ? [{ key: "actions", header: "", type: "actions", render: (m) => <button type="button" className="chip-button" onClick={async () => {
              if (await confirm({ title: `Remove “${m.name}”?`, message: "Its tasks stay in the project.", confirmLabel: "Remove" })) act(() => t.api.removeMilestone(project.id, m.id), "Milestone removed");
            }}>Remove</button> }] : []),
          ]} />
        {can.edit && (
          <form className="tk-inline-form" onSubmit={(e) => { e.preventDefault(); act(() => t.api.addMilestone(project.id, { name: milestone.name, dueOn: milestone.dueOn || null }), "Milestone added").then((ok) => ok && setMilestone({ name: "", dueOn: "" })); }}>
            <input aria-label="New milestone" placeholder="New milestone" value={milestone.name} maxLength={120} required onChange={(e) => setMilestone((m) => ({ ...m, name: e.target.value }))} />
            <input aria-label="Due" type="date" value={milestone.dueOn} onChange={(e) => setMilestone((m) => ({ ...m, dueOn: e.target.value }))} />
            <button className="button button-secondary button-sm">Add milestone</button>
          </form>
        )}
      </SectionCard>

      <SectionCard icon="list" title="Tasks" flush actions={can.addTask && <button type="button" className="button button-sm" onClick={() => setDialog({ task: listFilter && listFilter !== "none" ? Number(listFilter) : null })}><Icon name="plus" size={14} /> Add task</button>}>
        <div className="tk-list-tabs segmented" role="group" aria-label="Task list">
          <button type="button" className={`segment ${!listFilter ? "is-active" : ""}`} aria-pressed={!listFilter} onClick={() => setListFilter("")}>All ({project.tasks.length})</button>
          {project.lists.map((l) => (
            <button key={l.id} type="button" className={`segment ${listFilter === String(l.id) ? "is-active" : ""}`} aria-pressed={listFilter === String(l.id)} onClick={() => setListFilter(String(l.id))}>
              {l.name} ({project.tasks.filter((x) => x.listId === l.id).length})
            </button>
          ))}
        </div>
        <DataGrid id="tasks-project-tasks" caption="Project tasks" rows={shown} rowNoun={["task", "tasks"]} empty="No tasks in this list" emptyIcon="check"
          onRowClick={(x) => navigate(t.link(`run/${x.id}`))} rowClassName={(x) => (x.overdue ? "dg-tone-danger" : x.status === "done" ? "dg-tone-muted" : "")}
          columns={[
            { key: "title", header: "Task", value: (x) => x.title, mobile: "title", minWidth: 220 },
            { key: "status", header: "Status", type: "status", value: (x) => (x.overdue ? "overdue" : x.status), render: (x) => <StatusPill status={x.status} overdue={x.overdue} />, mobile: "subtitle" },
            { key: "list", header: "List", value: (x) => listName_(x.listId) },
            { key: "who", header: "Assigned to", value: (x) => x.assigneeNames },
            { key: "due", header: "Due", type: "datetime", value: (x) => x.dueAt, render: (x) => (x.dueAt ? `${dateShort(x.dueAt)}, ${timeOnly(x.dueAt)}` : "—") },
            { key: "milestone", header: "Milestone", value: (x) => project.milestoneList.find((m) => m.id === x.milestoneId)?.name || "", defaultHidden: true },
          ]} />
        {can.edit && (
          <form className="tk-inline-form tk-pad" onSubmit={(e) => { e.preventDefault(); act(() => t.api.addList(project.id, { name: listName }), "List added").then((ok) => ok && setListName("")); }}>
            <input aria-label="New task list" placeholder="New task list, e.g. Licences" value={listName} maxLength={80} required onChange={(e) => setListName(e.target.value)} />
            <button className="button button-secondary button-sm">Add list</button>
            {listFilter && listFilter !== "none" && <button type="button" className="button button-ghost button-sm" onClick={async () => {
              const list = project.lists.find((l) => String(l.id) === listFilter);
              if (list && await confirm({ title: `Remove the list “${list.name}”?`, message: "Its tasks stay in the project, outside any list.", confirmLabel: "Remove" })) {
                if (await act(() => t.api.removeList(project.id, list.id), "List removed")) setListFilter("");
              }
            }}>Remove this list</button>}
          </form>
        )}
      </SectionCard>

      <SectionCard icon="message" title="Comments"><Comments comments={project.comments} onAdd={async (body) => { await t.api.commentProject(project.id, body); await load(); }} /></SectionCard>
      <SectionCard icon="history" title="History"><History items={project.history} /></SectionCard>

      {dialog === "edit" && <ProjectFormDialog project={project} onClose={() => setDialog(null)} onSaved={(v) => { setDialog(null); if (v) setProject(v); else load(); }} />}
      {dialog?.task !== undefined && (
        <TaskFormDialog preset={{ projectId: project.id, projectListId: dialog.task, category: "project_management" }} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} />
      )}
    </div>
  );
}
