import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import DataGrid from "../../../components/DataGrid/DataGrid";
import SearchPicker from "../../../components/SearchPicker";
import Icon from "../../../components/Icon";
import { ErrorMessage } from "../../../components/Feedback";
import { dateShort, timeOnly } from "../../../services/format";
import { getErrorMessage } from "../../../services/api";
import toast from "../../../services/toast";
import useTasks from "./useTasks";
import useServerGrid from "./useServerGrid";
import { CategoryTag, PriorityTag, Progress, StatusPill } from "./parts";
import { CreateMenu } from "./forms";
import { TASK_STATUS } from "./taskWords";

// The team board: every task this person may see, as a list (a paged grid)
// or as a board of columns. Filters by person, status, category, place and
// priority; links from the bell arrive with ?status=overdue / review.

const STATUS_FILTERS = [["", "All"], ["open", "Open"], ["overdue", "Overdue"], ["review", "To review"], ["done", "Done"], ["missed", "Missed"], ["cancelled", "Cancelled"]];
const COLUMNS = [["todo", "To do"], ["in_progress", "In progress"], ["done", "Done"], ["missed", "Missed"]];

const due = (task) => (task.dueAt ? `${dateShort(task.dueAt)}, ${timeOnly(task.dueAt)}` : "—");

function Filters({ filters, set }) {
  const t = useTasks();
  // The fixed choices and roles are matched here; people are searched on the server.
  const fixed = useMemo(() => [
    { key: "me", label: "Assigned to me", detail: "" },
    { key: "on_shift", label: "Whoever is on shift", detail: "" },
    { key: "unassigned", label: "Not assigned", detail: "" },
    ...t.roles.map((r) => ({ key: `${r.kind}:${r.id}`, label: `Role: ${r.name}`, detail: "" })),
  ], [t.roles]);
  const [picked, setPicked] = useState(null);
  const value = fixed.find((o) => o.key === filters.assignee) || (picked?.key === filters.assignee ? picked : null)
    || (filters.assignee ? { key: filters.assignee, label: "Chosen person", detail: "" } : null);
  const search = (q, { signal }) => {
    const text = q.trim().toLowerCase();
    const own = fixed.filter((o) => !text || o.label.toLowerCase().includes(text));
    // The three fixed choices, then people, then roles (a restaurant may have many roles).
    const plain = own.filter((o) => !o.key.includes(":"));
    const roleRows = own.filter((o) => o.key.includes(":"));
    return t.searchPeople(q, { signal }).then((rows) => [...plain, ...rows.map((p) => ({ key: `${p.kind}:${p.id}`, label: p.name, detail: p.detail || "" })), ...roleRows]);
  };
  return (
    <div className="tk-filters">
      <div className="tk-filter-person">
        <SearchPicker aria-label="Person" placeholder="Anyone" search={search} value={value} limit={40}
          getKey={(o) => o.key} getLabel={(o) => o.label} getDescription={(o) => o.detail} minChars={0}
          onChange={(o) => { setPicked(o); set("assignee", o?.key || ""); }} />
      </div>
      <select aria-label="Category" value={filters.category} onChange={(e) => set("category", e.target.value)}>
        <option value="">Every category</option>
        {t.categories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      {t.places.length > 1 && !t.outletScope && (
        <select aria-label={t.placeWord} value={filters.place} onChange={(e) => set("place", e.target.value)}>
          <option value="">{`Every ${t.placeWord.toLowerCase()}`}</option>
          {t.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      <select aria-label="Priority" value={filters.priority} onChange={(e) => set("priority", e.target.value)}>
        <option value="">Any priority</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
      </select>
      <select aria-label="Kind" value={filters.kind} onChange={(e) => set("kind", e.target.value)}>
        <option value="">One-off and recurring</option><option value="one_off">One-off only</option><option value="recurring">Recurring only</option>
      </select>
    </div>
  );
}

function Kanban({ filters }) {
  const t = useTasks();
  const navigate = useNavigate();
  const [columns, setColumns] = useState(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(null);
  const load = useCallback(() => {
    const base = { ...filters, status: undefined };
    Object.keys(base).forEach((k) => base[k] === "" && delete base[k]);
    return Promise.all(COLUMNS.map(([code]) => t.api.list({ ...base, status: code, limit: 60, sort: ["done", "missed"].includes(code) ? "-due" : "due" })))
      .then((lists) => { setColumns(Object.fromEntries(COLUMNS.map(([code], i) => [code, lists[i]]))); setError(""); })
      .catch((err) => setError(getErrorMessage(err)));
  }, [t.api, filters]);
  useEffect(() => { load(); }, [load]);

  // Drag to In progress starts a task; to Done finishes it (the checklist must be complete).
  const drop = async (column) => {
    const task = dragging;
    setDragging(null);
    if (!task || task.status === column) return;
    try {
      if (column === "in_progress" && task.status === "todo") await t.api.startTask(task.id);
      else if (column === "done" && ["todo", "in_progress"].includes(task.status)) await t.api.complete(task.id, {});
      else return toast.info("Open the task to do that");
      toast.success(column === "done" ? "Task done" : "Task started");
      load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };

  return (
    <>
      <ErrorMessage message={error} />
      <div className="tk-kanban" data-motion-skip>
        {COLUMNS.map(([code, label]) => {
          const list = columns?.[code];
          return (
            <section key={code} className={`tk-col tk-col-${code} ${dragging ? "is-target" : ""}`} aria-label={label}
              onDragOver={(e) => e.preventDefault()} onDrop={() => drop(code)}>
              <h2 className="tk-col-head">{label} <span className="tk-count">{list ? list.total : "…"}</span></h2>
              <ul className="tk-col-list">
                {!list && [0, 1].map((n) => <li key={n} className="tk-kcard skeleton tk-card-skeleton" />)}
                {list?.rows.map((task) => (
                  <li key={task.id} className={`tk-kcard ${task.overdue ? "is-overdue" : ""}`} draggable={["todo", "in_progress"].includes(task.status)}
                    onDragStart={() => setDragging(task)} onDragEnd={() => setDragging(null)}>
                    <button type="button" className="tk-kcard-open" onClick={() => navigate(t.link(`run/${task.id}`))}>
                      <strong>{task.title}</strong>
                      <span className="tk-card-meta">
                        <span className={task.overdue ? "text-danger" : ""}><Icon name="clock" size={12} /> {due(task)}</span>
                        <CategoryTag code={task.category} />
                        <PriorityTag priority={task.priority} />
                      </span>
                      <span className="muted small">{task.assigneeNames}{task.placeName ? ` · ${task.placeName}` : ""}</span>
                      {task.itemCount > 0 && <Progress done={task.answeredCount} total={task.itemCount} failed={task.failedCount} />}
                      {task.reviewStatus === "pending" && <span className="tk-tag tone-warning">To review</span>}
                    </button>
                  </li>
                ))}
                {list && list.total > list.rows.length && <li className="muted small tk-col-more">{list.total - list.rows.length} more: use the list</li>}
                {list && list.total === 0 && <li className="muted small tk-col-more">Nothing here</li>}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

export default function BoardPage() {
  const t = useTasks();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") || "list";
  const filters = {
    status: params.get("status") || "", assignee: params.get("assignee") || "", category: params.get("category") || "",
    place: params.get("place") || "", priority: params.get("priority") || "", kind: params.get("kind") || "",
  };
  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const paramsKey = params.toString();
  const query = useMemo(() => Object.fromEntries(["status", "assignee", "category", "place", "priority", "kind", "schedule", "ahead", "project"]
    .map((k) => [k, new URLSearchParams(paramsKey).get(k)]).filter(([, v]) => v)), [paramsKey]);
  const fetchPage = useCallback((p) => t.api.list({ ...p, sort: p.status === "done" ? "-due" : undefined }), [t.api]);
  const list = useServerGrid("tasks-board", fetchPage, query);

  const columns = [
    { key: "title", header: "Task", value: (r) => r.title, mobile: "title", minWidth: 220,
      render: (r) => <Link to={t.link(`run/${r.id}`)} className="tk-grid-title">{r.title}{r.scheduleId && <Icon name="refresh" size={12} />}</Link> },
    { key: "status", header: "Status", type: "status", value: (r) => (r.overdue ? "overdue" : r.status), render: (r) => <StatusPill status={r.status} overdue={r.overdue} />, mobile: "subtitle" },
    { key: "due", header: "Due", type: "datetime", value: (r) => r.dueAt },
    { key: "who", header: "Assigned to", value: (r) => r.assigneeNames },
    { key: "progress", header: "Checklist", value: (r) => (r.itemCount ? r.answeredCount / r.itemCount : null),
      render: (r) => (r.itemCount ? <Progress done={r.answeredCount} total={r.itemCount} failed={r.failedCount} /> : <span className="muted">—</span>), csv: (r) => (r.itemCount ? `${r.answeredCount}/${r.itemCount}` : "") },
    { key: "category", header: "Category", value: (r) => t.categoryName(r.category), render: (r) => <CategoryTag code={r.category} /> },
    { key: "priority", header: "Priority", value: (r) => r.priority, render: (r) => (r.priority === "normal" ? <span className="muted">Normal</span> : <PriorityTag priority={r.priority} />) },
    { key: "place", header: t.placeWord, value: (r) => r.placeName || "Whole business", defaultHidden: t.places.length < 2 },
    { key: "done", header: "Done", type: "datetime", value: (r) => r.completedAt, defaultHidden: true },
    { key: "by", header: "Done by", value: (r) => r.completedByName, defaultHidden: true },
    { key: "score", header: "Score", type: "percent", value: (r) => r.scorePercent, defaultHidden: true },
  ];

  return (
    <div className="stack tk-page">
      <PageHeader title="Team board" icon="grid" description="Everyone's tasks: who is doing what, what is late, what waits for review."
        primary={<CreateMenu onCreated={() => list.reload()} />}
        secondary={(
          <div className="segmented" role="group" aria-label="View">
            {[["list", "List"], ["board", "Board"]].map(([code, label]) => (
              <button key={code} type="button" className={`segment ${view === code ? "is-active" : ""}`} aria-pressed={view === code} onClick={() => set("view", code === "list" ? "" : code)}>{label}</button>
            ))}
          </div>
        )} />
      {view === "list" && (
        <div className="segmented tk-status-filter" role="group" aria-label="Status" data-motion-tabs>
          {STATUS_FILTERS.map(([code, label]) => (
            <button key={code} type="button" className={`segment ${filters.status === code ? "is-active" : ""}`} aria-pressed={filters.status === code} onClick={() => set("status", code)}>{label}</button>
          ))}
        </div>
      )}
      <Filters filters={filters} set={set} />
      {view === "board"
        ? <Kanban filters={query} />
        : <DataGrid {...list.gridProps} caption="Tasks" columns={columns} rowNoun={["task", "tasks"]} exportName="tasks"
            onRowClick={(r) => navigate(t.link(`run/${r.id}`))} rowClassName={(r) => (r.overdue ? "dg-tone-danger" : r.status === "missed" ? "dg-tone-warning" : ["done", "cancelled"].includes(r.status) ? "dg-tone-muted" : "")}
            empty={filters.status === "review" ? "Nothing waiting for review" : "No tasks match"} emptyIcon="check"
            emptyHint={Object.values(filters).some(Boolean) ? "Clear a filter to see more." : `Create a task or set up a recurring one. Statuses: ${Object.values(TASK_STATUS).map((s) => s.label).join(", ")}.`} />}
    </div>
  );
}
