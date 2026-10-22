import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../components/PageHeader";
import SectionCard from "../../../components/SectionCard";
import StatTile from "../../../components/StatTile";
import DataGrid from "../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../components/DateRangeFilter";
import { BarList } from "../../../components/Charts";
import { ErrorMessage } from "../../../components/Feedback";
import { count, dateShort } from "@bmp/shared/format";
import { getErrorMessage } from "../../../services/api";
import useTasks from "./useTasks";
import { CategoryTag } from "./parts";
import { ComplianceStrip } from "./RecurringPage";
import { todayText } from "./taskWords";

// Task reports for a period: completion rate, on time, missed by person and
// by category, recurring compliance ("Temperature log 28/30"), open issues
// by age and category, and the review backlog.

const pct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const minusDays = (day, n) => { const d = new Date(`${day}T00:00:00`); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export default function TaskReportsPage() {
  const t = useTasks();
  const [range, setRange] = useState(() => ({ from: minusDays(todayText(), 29), to: todayText() }));
  const [place, setPlace] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(() => t.api.report({ from: range.from || undefined, to: range.to || undefined, place: place || undefined })
    .then((v) => { setData(v); setError(""); }).catch((err) => setError(getErrorMessage(err))), [t.api, range, place]);
  useEffect(() => { load(); }, [load]);
  const tot = data?.totals;
  const rateCols = [
    { key: "due", header: "Due", type: "number", value: (r) => r.due, total: "sum" },
    { key: "done", header: "Done", type: "number", value: (r) => r.done, total: "sum" },
    { key: "rate", header: "Completion", type: "percent", value: (r) => r.completionRate, render: (r) => <span className={`tk-rate ${r.completionRate >= 90 ? "is-good" : r.completionRate >= 70 ? "is-ok" : r.completionRate === null ? "" : "is-bad"}`}>{pct(r.completionRate)}</span> },
    { key: "ontime", header: "On time", type: "percent", value: (r) => r.onTimeRate, render: (r) => pct(r.onTimeRate) },
    { key: "missed", header: "Missed", type: "number", value: (r) => r.missed, total: "sum" },
  ];

  return (
    <div className="stack tk-page">
      <PageHeader title="Task reports" icon="chart" description="Are the checklists getting done, on time, and by whom? What is still broken?" />
      <div className="tk-filters tk-report-filters">
        <DateRangeFilter from={range.from} to={range.to} onChange={setRange} />
        {t.places.length > 1 && !t.outletScope && (
          <label className="field"><span>{t.placeWord}</span>
            <select value={place} onChange={(e) => setPlace(e.target.value)}>
              <option value="">{`Every ${t.placeWord.toLowerCase()}`}</option>
              {t.places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <ErrorMessage message={error} />
      <div className="tk-tiles">
        <StatTile icon="check" label="Completion rate" value={pct(tot?.completionRate)} note={tot ? `${count(tot.done)} of ${count(tot.due)} due` : undefined} tone={tot?.completionRate >= 90 ? "success" : tot?.completionRate >= 70 ? "warning" : "danger"} loading={!data} />
        <StatTile icon="clock" label="Done on time" value={pct(tot?.onTimeRate)} note={tot ? `${count(tot.onTime)} of ${count(tot.done)} done` : undefined} tone="info" loading={!data} />
        <StatTile icon="alert" label="Missed" value={tot ? count(tot.missed) : ""} note={tot ? `${count(tot.overdue)} overdue now` : undefined} tone={tot?.missed ? "danger" : "neutral"} loading={!data} />
        <StatTile icon="clipboard" label="Average checklist score" value={tot?.averageScore === null || tot?.averageScore === undefined ? "—" : `${Math.round(tot.averageScore)}%`} note={tot ? `${count(tot.withFailures)} with failed checks` : undefined} tone="neutral" loading={!data} />
        {data && t.has("issues") && <StatTile icon="alert" label="Open issues" value={count(data.issuesByAge.reduce((n, r) => n + r.open, 0))} note={`${count(data.issuesByAge.reduce((n, r) => n + r.serious, 0))} serious`} tone="warning" to={t.link("issues")} />}
        {data && <StatTile icon="check" label="Waiting for review" value={count(data.reviewBacklog.count)} note={data.reviewBacklog.oldest ? `oldest ${dateShort(data.reviewBacklog.oldest)}` : "none waiting"} to={`${t.link("board")}?status=review`} />}
      </div>

      <SectionCard icon="refresh" title="Recurring compliance" description="Each recurring task: how many of its days were done. Red squares were missed." flush>
        <DataGrid id="tasks-report-compliance" caption="Recurring compliance" rows={data?.compliance || []} loading={!data} rowKey={(r) => r.scheduleId} rowNoun={["recurring task", "recurring tasks"]} exportName="task-compliance"
          empty="No recurring tasks were due in this period" emptyIcon="refresh"
          columns={[
            { key: "title", header: "Recurring task", value: (r) => r.title, mobile: "title", minWidth: 200 },
            { key: "score", header: "Done", value: (r) => r.completionRate, render: (r) => <strong>{r.done}/{r.due}</strong>, csv: (r) => `${r.done}/${r.due}` },
            ...rateCols.slice(2),
            { key: "fails", header: "With failed checks", type: "number", value: (r) => r.withFailures },
            { key: "strip", header: "Day by day", value: () => "", render: (r) => <ComplianceStrip days={r.days} />, sortable: false, csv: () => "" },
          ]} />
      </SectionCard>

      <div className="tk-two">
        <SectionCard icon="users" title="By person" description="Tasks they were named on (directly or as their staff record)." flush>
          <DataGrid id="tasks-report-people" caption="By person" variant="compact" rows={data?.byPerson || []} loading={!data} rowKey={(r) => r.person} rowNoun={["person", "people"]} exportName="tasks-by-person"
            empty="No tasks named a person in this period" columns={[{ key: "name", header: "Person", value: (r) => r.name, mobile: "title" }, ...rateCols, { key: "overdue", header: "Overdue now", type: "number", value: (r) => r.overdue }]} />
        </SectionCard>
        <SectionCard icon="grid" title="By category" flush>
          <DataGrid id="tasks-report-categories" caption="By category" variant="compact" rows={data?.byCategory || []} loading={!data} rowKey={(r) => r.category} rowNoun={["category", "categories"]} exportName="tasks-by-category"
            empty="No tasks due in this period" columns={[{ key: "category", header: "Category", value: (r) => t.categoryName(r.category), render: (r) => <CategoryTag code={r.category} />, mobile: "title" }, ...rateCols]} />
        </SectionCard>
      </div>

      {t.has("issues") && (
        <div className="tk-two">
          <SectionCard icon="clock" title="Open issues by age">
            {data && <BarList rows={data.issuesByAge.map((r) => ({ label: r.bucket, value: r.open, sub: r.serious ? `${r.serious} serious` : undefined }))} format={(v) => `${count(v)} open`} empty="No open issues." />}
          </SectionCard>
          <SectionCard icon="alert" title="Issues by category" flush>
            <DataGrid id="tasks-report-issues" caption="Issues by category" variant="compact" rows={data?.issuesByCategory || []} loading={!data} rowKey={(r) => r.category} rowNoun={["category", "categories"]} exportName="issues-by-category"
              empty="No issues" columns={[
                { key: "category", header: "Category", value: (r) => t.categoryName(r.category), render: (r) => <CategoryTag code={r.category} />, mobile: "title" },
                { key: "open", header: "Open", type: "number", value: (r) => r.open, total: "sum" },
                { key: "serious", header: "Serious", type: "number", value: (r) => r.serious, total: "sum" },
                { key: "reported", header: "Reported in period", type: "number", value: (r) => r.reported, total: "sum" },
                { key: "resolved", header: "Fixed in period", type: "number", value: (r) => r.resolved, total: "sum" },
                { key: "hours", header: "Hours to fix (avg)", type: "number", value: (r) => r.hoursToFix },
              ]} />
          </SectionCard>
        </div>
      )}
    </div>
  );
}
