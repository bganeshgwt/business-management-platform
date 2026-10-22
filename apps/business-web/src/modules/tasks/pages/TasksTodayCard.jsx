import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import { tasksApi, tasksBase } from "../services/tasks.service";
import "../styles/tasks.css";

// "Today's checklists" on the restaurant dashboard and the Business Admin
// Overview: today's progress, what is overdue, issues waiting. One small
// request (GET …/tasks/summary); nothing shows until it answers, and nothing
// at all if it fails (the dashboard's own figures matter more).
export default function TasksTodayCard({ businessId = null }) {
  const api = useMemo(() => tasksApi(tasksBase(businessId)), [businessId]);
  const root = businessId ? `/business-admin/${businessId}/tasks` : "/tasks";
  const [s, setS] = useState(null);
  useEffect(() => {
    let live = true;
    api.summary().then((v) => live && setS(v)).catch(() => {});
    return () => { live = false; };
  }, [api]);
  if (!s) return null;
  const total = s.team ? s.todayTotal : s.mine.open + s.mine.done;
  const done = s.team ? s.todayDone : s.mine.done;
  const pct = total ? Math.round((100 * done) / total) : 0;
  const overdue = s.team ? s.overdue : s.mine.overdue;
  if (!total && !overdue && !(s.issues?.open)) return null;
  return (
    <SectionCard icon="check" title="Today's checklists" description={s.team ? "Everyone's tasks due today" : "Your tasks today"}
      actions={<Link className="button button-secondary button-sm" to={root}>My tasks</Link>}>
      <div className="tk-today">
        <div className="tk-today-figure"><strong>{done}</strong><span>/{total} done</span></div>
        <span className="tk-progress" aria-label={`${pct}% done`}>
          <span className="tk-progress-track"><span className={`tk-progress-fill ${pct === 100 ? "is-full" : ""}`} style={{ transform: `scaleX(${pct / 100})` }} /></span>
          <span className="tk-progress-text">{pct}%</span>
        </span>
        <div className="tk-today-links">
          {overdue > 0 && <Link className="tk-my-alert" to={s.team ? `${root}/board?status=overdue` : root}><Icon name="alert" size={14} /> {overdue} overdue</Link>}
          {s.todayMissed > 0 && s.team && <Link className="tk-my-alert" to={`${root}/board?status=missed`}>{s.todayMissed} missed today</Link>}
          {s.review > 0 && <Link className="tk-my-review" to={`${root}/board?status=review`}><Icon name="check" size={14} /> {s.review} to review</Link>}
          {s.issues?.serious > 0 && <Link className="tk-my-alert" to={`${root}/issues?severity=high`}><Icon name="alert" size={14} /> {s.issues.serious} serious issue{s.issues.serious === 1 ? "" : "s"}</Link>}
          {s.issues?.open > 0 && !s.issues.serious && <Link className="tk-my-review" to={`${root}/issues`}>{s.issues.open} open issue{s.issues.open === 1 ? "" : "s"}</Link>}
        </div>
      </div>
    </SectionCard>
  );
}
