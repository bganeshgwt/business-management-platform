import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { printStatement } from "./garagePrint";
import { STATUSES, km } from "./garage";
import "../styles/garage.css";

// A customer's statement: every vehicle they own (a fleet) and any other they
// had serviced here, each with its job cards, and what they were billed, paid
// and still owe on them; for the whole time or a period, printed for them.

export default function StatementPage() {
  const biz = useOpenBusiness();
  const { contactId } = useParams();
  const navigate = useNavigate();
  const today = businessToday(biz.business.timezone);
  const [range, setRange] = useState(null);
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `garage/customers/${contactId}/statement`, range || undefined, controller.signal)
      .then((s) => { setStatement(s); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, range]);
  if (!statement) return <div className="stack"><BusinessHeader icon="file" title="Statement" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const money = statement.money !== false;
  return (
    <div className="stack">
      <BusinessHeader icon="file" title={`Statement · ${statement.customer.name}`}
        description={`${statement.vehicles.length} ${statement.vehicles.length === 1 ? "vehicle" : "vehicles"} · ${statement.jobs} ${statement.jobs === 1 ? "job" : "jobs"}${statement.from ? ` from ${statement.from} to ${statement.to || today}` : ""}`}
        secondary={(
          <>
            <Link className="button button-secondary" to={biz.path("vehicles")}><Icon name="arrow-left" size={15} /> All vehicles</Link>
            {biz.can("garage.print") && <button type="button" className="button button-secondary" onClick={() => printStatement(biz, statement)}><Icon name="print" size={15} /> Print the statement</button>}
          </>
        )} />
      <ErrorMessage message={error} />
      <div className="form-actions bz-start">
        <DateRangeFilter from={range?.from || ""} to={range?.to || today} anchor={today} label="dates" onChange={(next) => next.from && next.to && setRange({ from: next.from, to: next.to })} />
        {range && <button type="button" className="button button-secondary button-sm" onClick={() => setRange(null)}>Every job</button>}
      </div>
      {money && (
        <div className="stat-grid">
          <StatTile icon="receipt" label="Billed" money={Number(statement.billed)} />
          <StatTile icon="money" label="Paid" money={Number(statement.paid)} />
          <StatTile icon="wallet" tone={Number(statement.due) > 0 ? "warning" : "neutral"} label="Due on these jobs" money={Number(statement.due)}
            note={`owes ${biz.exact(statement.customer.balance)} in all`} />
        </div>
      )}
      {statement.vehicles.map((v) => (
        <SectionCard key={v.id} flush icon="truck" title={`${v.registration_no} · ${v.vehicle_name}`}
          description={[v.owned_now ? null : "no longer theirs", v.odometer_km !== null ? `last reading ${km(v.odometer_km)}` : null, money && v.billed ? `billed ${biz.exact(v.billed)}` : null].filter(Boolean).join(" · ") || undefined}
          actions={<Link className="button button-secondary button-sm" to={biz.path(`vehicles/${v.id}`)}>The vehicle</Link>}>
          <DataGrid variant="compact" id="garage-statement-jobs" caption={`Jobs on ${v.registration_no}`} rows={v.jobs} rowKey={(j) => j.id} currency={biz.symbol} rowNoun={["job", "jobs"]}
            onRowClick={(j) => navigate(biz.path(`job-cards/${j.id}`))} empty="No jobs in these dates" columns={[
              { key: "job_no", header: "Job card", value: (j) => j.job_no, className: "mono", mobile: "title" },
              { key: "created_at", header: "Date", type: "date", value: (j) => j.created_at, mobile: "subtitle" },
              { key: "status", header: "Status", value: (j) => STATUSES[j.status]?.label || j.status, render: (j) => <Badge tone={STATUSES[j.status]?.tone} label={STATUSES[j.status]?.label || j.status} /> },
              { key: "odometer_in", header: "Reading", type: "number", value: (j) => j.odometer_in, render: (j) => km(j.odometer_in) },
              { key: "work", header: "Work", value: (j) => (j.complaints || []).join("; ") },
              { key: "bill", header: "Bill", value: (j) => j.document_no || "", render: (j) => (j.document_no ? <span className="bz-two-line"><span className="mono">{j.document_no}</span>{j.insurer_document_no && <small className="muted">insurer {j.insurer_document_no}</small>}</span> : "—") },
              money && { key: "billed", header: "Billed", type: "money", exact: true, value: (j) => (j.billed === null ? null : Number(j.billed)), total: "sum" },
              money && { key: "due", header: "Due", type: "money", exact: true, value: (j) => (j.due === null ? null : Number(j.due)), total: "sum" },
            ].filter(Boolean)} />
        </SectionCard>
      ))}
    </div>
  );
}
