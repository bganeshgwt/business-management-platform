import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import DataGrid from "../../../components/DataGrid/DataGrid";
import Icon from "../../../components/Icon";
import { relative } from "../../../services/format";
import useTasks from "./useTasks";
import useServerGrid from "./useServerGrid";
import { CategoryTag, SeverityTag, StatusPill } from "./parts";
import { IssueFormDialog } from "./forms";

// Issues: everything wrong that someone must fix. Open and being fixed come
// first, the most serious on top. Staff see what they reported or own;
// issues.view sees all.

const STATUS = [["active", "Open"], ["resolved", "Fixed"], ["closed", "Closed"], ["", "All"]];

export default function IssuesPage() {
  const t = useTasks();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [reporting, setReporting] = useState(false);
  const status = params.get("status") ?? "active";
  const severity = params.get("severity") || "";
  const category = params.get("category") || "";
  const assignee = params.get("assignee") || "";
  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value || key === "status") next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const query = useMemo(() => Object.fromEntries(Object.entries({ status, severity, category, assignee }).filter(([, v]) => v)), [status, severity, category, assignee]);
  const fetchPage = useCallback((p) => t.api.issues(p), [t.api]);
  const list = useServerGrid("tasks-issues", fetchPage, query);

  const columns = [
    { key: "code", header: "No.", value: (r) => r.number, render: (r) => <span className="tk-code">{r.code}</span>, csv: (r) => r.code, width: 100 },
    { key: "title", header: "What is wrong", value: (r) => r.title, mobile: "title", minWidth: 240,
      render: (r) => <Link to={t.link(`issues/${r.id}`)} className="tk-grid-title">{r.title}{r.photoCount > 0 && <Icon name="eye" size={12} />}</Link> },
    { key: "severity", header: "Severity", value: (r) => ["low", "medium", "high", "critical"].indexOf(r.severity), render: (r) => <SeverityTag severity={r.severity} />, csv: (r) => r.severity },
    { key: "status", header: "Status", type: "status", value: (r) => r.status, render: (r) => <StatusPill kind="issue" status={r.status} />, mobile: "subtitle" },
    { key: "assignee", header: "Assigned to", value: (r) => r.assigneeName || "Nobody yet" },
    { key: "age", header: "Reported", type: "datetime", value: (r) => r.reportedAt, render: (r) => <span title={r.reportedByName}>{relative(r.reportedAt)}</span> },
    { key: "category", header: "Category", value: (r) => t.categoryName(r.category), render: (r) => <CategoryTag code={r.category} /> },
    { key: "asset", header: "Equipment", value: (r) => r.assetLabel },
    { key: "place", header: t.placeWord, value: (r) => r.placeName || "Whole business", defaultHidden: t.places.length < 2 },
    { key: "by", header: "Reported by", value: (r) => r.reportedByName, defaultHidden: true },
    { key: "from", header: "From", value: (r) => (r.sourceTaskId ? "Checklist" : r.sourceLogbookEntryId ? "Log book" : "Reported"), defaultHidden: true },
  ];

  return (
    <div className="stack tk-page">
      <PageHeader title="Issues" icon="alert" description="Problems to fix: reported with a photo, raised by failed checks, or from the log book."
        primary={t.can("issues.create") && <button type="button" className="button" onClick={() => setReporting(true)}><Icon name="plus" size={16} /> Report issue</button>} />
      <div className="segmented tk-status-filter" role="group" aria-label="Status" data-motion-tabs>
        {STATUS.map(([code, label]) => (
          <button key={code} type="button" className={`segment ${status === code ? "is-active" : ""}`} aria-pressed={status === code} onClick={() => set("status", code)}>{label}</button>
        ))}
      </div>
      <div className="tk-filters">
        <select aria-label="Severity" value={severity} onChange={(e) => set("severity", e.target.value)}>
          <option value="">Any severity</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
        </select>
        <select aria-label="Category" value={category} onChange={(e) => set("category", e.target.value)}>
          <option value="">Every category</option>
          {t.categories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        <select aria-label="Assigned" value={assignee} onChange={(e) => set("assignee", e.target.value)}>
          <option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Not assigned</option>
        </select>
      </div>
      <DataGrid {...list.gridProps} caption="Issues" columns={columns} rowNoun={["issue", "issues"]} exportName="issues"
        onRowClick={(r) => navigate(t.link(`issues/${r.id}`))}
        rowClassName={(r) => (["open", "in_progress"].includes(r.status) && r.severity === "critical" ? "dg-tone-danger" : r.overdue ? "dg-tone-warning" : r.status === "closed" ? "dg-tone-muted" : "")}
        empty={status === "active" ? "No open issues" : "No issues here"} emptyIcon="check" emptyHint={status === "active" ? "Anything wrong? Report it with a photo." : undefined} />
      {reporting && <IssueFormDialog onClose={() => setReporting(false)} onSaved={(i) => { setReporting(false); navigate(t.link(`issues/${i.id}`)); }} />}
    </div>
  );
}
