import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import Icon from "../../../components/Icon";
import { EmptyState, ErrorMessage } from "../../../components/Feedback";
import { dateLong, dateShort, timeOnly } from "../../../services/format";
import { getErrorMessage } from "../../../services/api";
import useTasks from "./useTasks";
import { CategoryTag, PriorityTag, Progress, StatusPill } from "./parts";
import { CreateMenu } from "./forms";

// My tasks: what is mine to do, phone first. Today (open now or due today),
// Overdue, Upcoming (the next 7 days), Done today. One tap opens the
// checklist; the count on each tab says where the work is.

const TABS = [["today", "Today"], ["overdue", "Overdue"], ["upcoming", "Upcoming"], ["done", "Done"]];

const dueText = (task) => {
  if (!task.dueAt) return "No due time";
  const due = new Date(task.dueAt);
  const sameDay = due.toDateString() === new Date().toDateString();
  return sameDay ? `Due ${timeOnly(task.dueAt)}` : `Due ${dateShort(task.dueAt)}, ${timeOnly(task.dueAt)}`;
};

export function TaskCard({ task }) {
  const { link } = useTasks();
  const notYet = task.status === "todo" && task.opensAt && new Date(task.opensAt) > new Date();
  const action = task.status === "todo" ? (notYet ? `Opens ${timeOnly(task.opensAt)}` : "Start") : task.status === "in_progress" ? "Continue" : "View";
  return (
    <li className={`tk-card ${task.overdue ? "is-overdue" : ""} ${task.status === "done" ? "is-done" : ""} ${task.status === "missed" ? "is-missed" : ""}`}>
      <Link to={link(`run/${task.id}`)} className="tk-card-link">
        <div className="tk-card-top">
          <strong className="tk-card-title">{task.title}</strong>
          <StatusPill status={task.status} overdue={task.overdue} />
        </div>
        <div className="tk-card-meta">
          <span className={task.overdue ? "text-danger" : ""}><Icon name="clock" size={13} /> {dueText(task)}</span>
          {task.shiftLabel && <span>{task.shiftLabel}</span>}
          {task.placeName && <span><Icon name="store" size={13} /> {task.placeName}</span>}
          <CategoryTag code={task.category} />
          <PriorityTag priority={task.priority} />
          {task.assignMode !== "people" && <span className="muted">{task.assigneeNames}</span>}
          {task.reviewStatus === "pending" && <span className="tk-tag tone-warning">Waiting for review</span>}
          {task.reviewStatus === "changes_requested" && <span className="tk-tag tone-danger">Sent back: {task.reviewNote}</span>}
        </div>
        {task.itemCount > 0 && (
          <Progress done={task.answeredCount} total={task.itemCount} failed={task.failedCount}
            label={`${task.answeredCount}/${task.itemCount} checks${task.failedCount ? ` · ${task.failedCount} failed` : ""}`} />
        )}
        <span className="tk-card-go">{action} <Icon name="external" size={13} /></span>
      </Link>
    </li>
  );
}

export default function MyTasksPage() {
  const { api, can, link } = useTasks();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  // null until someone picks a tab: it then opens on the first one with work (overdue first).
  const [picked, setPicked] = useState(null);

  const load = useCallback(() => api.mine().then((value) => { setData(value); setError(""); }).catch((err) => setError(getErrorMessage(err))), [api]);
  useEffect(() => { load(); }, [load]);
  // Live enough for a shift: every minute, and when the tab comes back.
  useEffect(() => {
    const timer = setInterval(load, 60000);
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onFocus); };
  }, [load]);

  const groups = useMemo(() => {
    const out = { today: [], overdue: [], upcoming: [], done: [] };
    for (const task of data?.tasks || []) out[task.bucket]?.push(task);
    return out;
  }, [data]);
  const tab = picked || (groups.overdue.length ? "overdue" : groups.today.length ? "today" : groups.upcoming.length ? "upcoming" : "today");
  const setTab = setPicked;

  const todayDone = groups.done.filter((t) => t.status === "done").length;
  const todayAll = groups.today.length + groups.overdue.length + todayDone;
  const list = groups[tab] || [];

  return (
    <div className="stack tk-page tk-my">
      <PageHeader title="My tasks" icon="check" description={data ? dateLong(data.today) : "What is yours to do"}
        primary={<CreateMenu onCreated={load} />} />
      <ErrorMessage message={error} />
      <section className="card tk-my-summary" aria-label="Today at a glance">
        <div>
          <span className="tk-my-big">{todayDone}<small>/{todayAll}</small></span>
          <span className="muted small">done today</span>
        </div>
        <Progress done={todayDone} total={todayAll || 1} label={todayAll ? `${Math.round((100 * todayDone) / todayAll)}%` : "Nothing due"} />
        {groups.overdue.length > 0 && <button type="button" className="tk-my-alert" onClick={() => setTab("overdue")}><Icon name="alert" size={15} /> {groups.overdue.length} overdue</button>}
        {data?.reviewCount > 0 && can("tasks.review") && <Link className="tk-my-review" to={`${link("board")}?status=review`}><Icon name="check" size={15} /> {data.reviewCount} to review</Link>}
      </section>
      <div className="segmented tk-my-tabs" role="tablist" aria-label="Which tasks">
        {TABS.map(([code, label]) => (
          <button key={code} type="button" role="tab" aria-selected={tab === code} className={`segment ${tab === code ? "is-active" : ""}`}
            onClick={() => setTab(code)}>
            {label} <span className={`tk-count ${code === "overdue" && groups.overdue.length ? "is-danger" : ""}`}>{groups[code].length}</span>
          </button>
        ))}
      </div>
      {!data && !error && <ul className="tk-cards">{[0, 1, 2].map((n) => <li key={n} className="tk-card skeleton tk-card-skeleton" />)}</ul>}
      {data && list.length === 0 && (
        <EmptyState icon="check" message={{ today: "Nothing left for today", overdue: "Nothing overdue", upcoming: "Nothing coming up this week", done: "Nothing finished yet today" }[tab]}
          hint={tab === "today" ? "New tasks for you show up here. Pull down or come back later." : undefined} />
      )}
      {list.length > 0 && <ul className="tk-cards">{list.map((task) => <TaskCard key={task.id} task={task} />)}</ul>}
    </div>
  );
}
