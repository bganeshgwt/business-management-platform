import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DataGrid from "../../../components/DataGrid/DataGrid";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import { ErrorMessage } from "../../../components/Feedback";
import { dateLong, timeOnly } from "../../../services/format";
import { getErrorMessage } from "../../../services/api";
import useTasks from "./useTasks";
import { CategoryTag, StatusPill } from "./parts";
import { CreateMenu } from "./forms";
import { todayText, WEEKDAYS } from "./taskWords";

// The calendar: a month of tasks by their due day. A day shows up to three
// tasks and "+5 more"; picking a day lists all of them. Managers see the
// team's tasks (or only theirs); everyone else sees their own.

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthTitle = (month) => new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

export default function CalendarPage() {
  const t = useTasks();
  const navigate = useNavigate();
  const [month, setMonth] = useState(() => todayText().slice(0, 7));
  const [day, setDay] = useState(todayText());
  const [mineOnly, setMineOnly] = useState(!t.can("tasks.view"));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  // Six weeks starting on the Monday on or before the 1st.
  const cells = useMemo(() => {
    const first = new Date(`${month}-01T00:00:00`);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return ymd(d); });
  }, [month]);

  const load = useCallback(() => t.api.calendar({ from: cells[0], to: cells[41], mine: mineOnly ? 1 : undefined })
    .then((value) => { setData(value); setError(""); }).catch((err) => setError(getErrorMessage(err))), [t.api, cells, mineOnly]);
  useEffect(() => { load(); }, [load]);

  const byDay = useMemo(() => {
    const map = {};
    for (const task of data?.tasks || []) (map[task.day] ||= []).push(task);
    return map;
  }, [data]);
  const shift = (by) => {
    const d = new Date(`${month}-01T00:00:00`);
    d.setMonth(d.getMonth() + by);
    setMonth(ymd(d).slice(0, 7));
  };
  const today = todayText();
  const dayTasks = byDay[day] || [];

  return (
    <div className="stack tk-page">
      <PageHeader title="Calendar" icon="calendar" description="Tasks by the day they are due." primary={<CreateMenu onCreated={load} />} />
      <ErrorMessage message={error} />
      <SectionCard className="tk-cal-card" title={monthTitle(month)} icon="calendar"
        actions={(
          <div className="tk-cal-nav">
            {t.can("tasks.view") && (
              <div className="segmented" role="group" aria-label="Whose tasks">
                <button type="button" className={`segment ${!mineOnly ? "is-active" : ""}`} aria-pressed={!mineOnly} onClick={() => setMineOnly(false)}>Team</button>
                <button type="button" className={`segment ${mineOnly ? "is-active" : ""}`} aria-pressed={mineOnly} onClick={() => setMineOnly(true)}>Mine</button>
              </div>
            )}
            <button type="button" className="button button-secondary button-sm" aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
            <button type="button" className="button button-secondary button-sm" onClick={() => { setMonth(today.slice(0, 7)); setDay(today); }}>Today</button>
            <button type="button" className="button button-secondary button-sm" aria-label="Next month" onClick={() => shift(1)}>›</button>
          </div>
        )}>
        <div className="tk-cal" role="grid" aria-label={monthTitle(month)}>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => <div key={d} className="tk-cal-dow" role="columnheader">{WEEKDAYS[d]}</div>)}
          {cells.map((cell) => {
            const list = byDay[cell] || [];
            const late = list.some((x) => x.overdue);
            const missed = list.filter((x) => x.status === "missed").length;
            return (
              <button key={cell} type="button" role="gridcell" aria-selected={cell === day}
                className={`tk-cal-day ${cell.slice(0, 7) !== month ? "is-other" : ""} ${cell === today ? "is-today" : ""} ${cell === day ? "is-picked" : ""}`}
                onClick={() => setDay(cell)} aria-label={`${dateLong(cell)}: ${list.length} task${list.length === 1 ? "" : "s"}`}>
                <span className="tk-cal-num">{Number(cell.slice(8))}</span>
                <span className="tk-cal-chips">
                  {list.slice(0, 3).map((x) => <span key={x.id} className={`tk-cal-chip tone-${x.overdue ? "danger" : x.status === "done" ? "success" : x.status === "missed" ? "warning" : "info"}`}>{x.title}</span>)}
                  {list.length > 3 && <span className="tk-cal-more">+{list.length - 3} more</span>}
                </span>
                {list.length > 0 && <span className={`tk-cal-dot ${late ? "is-late" : missed ? "is-missed" : ""}`} aria-hidden="true">{list.length}</span>}
              </button>
            );
          })}
        </div>
      </SectionCard>
      <SectionCard title={dateLong(day)} icon="list" flush>
        <DataGrid id="tasks-calendar-day" caption={`Tasks due ${dateLong(day)}`} variant="compact" rows={dayTasks} rowNoun={["task", "tasks"]}
          empty="Nothing due this day" emptyIcon="calendar" onRowClick={(x) => navigate(t.link(`run/${x.id}`))}
          rowClassName={(x) => (x.overdue ? "dg-tone-danger" : x.status === "done" ? "dg-tone-muted" : "")}
          columns={[
            { key: "time", header: "Due", value: (x) => x.dueAt, render: (x) => (x.dueAt ? timeOnly(x.dueAt) : "—"), mobile: "subtitle" },
            { key: "title", header: "Task", value: (x) => x.title, mobile: "title" },
            { key: "who", header: "Assigned to", value: (x) => x.assigneeNames },
            { key: "category", header: "Category", value: (x) => t.categoryName(x.category), render: (x) => <CategoryTag code={x.category} /> },
            { key: "status", header: "Status", type: "status", value: (x) => (x.overdue ? "overdue" : x.status), render: (x) => <StatusPill status={x.status} overdue={x.overdue} /> },
          ]} />
      </SectionCard>
    </div>
  );
}
