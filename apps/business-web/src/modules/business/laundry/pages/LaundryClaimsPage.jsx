import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateTime } from "@bmp/shared/format";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { DECISIONS, ISSUES, wordOf } from "./laundry";
import "../styles/laundry.css";

// Damage claims: every claim, those waiting for a manager first (each opens
// its order, where it is decided), and the claims of a period added up by
// service, by the person who took the garment in, or by month: how many,
// waiting, and decided each way, with the compensation given (credit notes,
// with their GST) and the money refunded of it.

const BY = [{ value: "service", label: "By service" }, { value: "staff", label: "By who took it in" }, { value: "month", label: "By month" }];

export default function LaundryClaimsPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [by, setBy] = useState("service");
  const [period, setPeriod] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const list = useServerList("laundry/claims", { gridId: "laundry-claims" });
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "laundry/claims/report", { by, from: period.from || undefined, to: period.to || undefined }, controller.signal)
      .then((r) => { setReport(r); setError(""); }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, by, period]);
  const money = report?.money !== false;
  const rows = report ? [...report.rows, { ...report.totals, key: "All" }] : [];
  return (
    <div className="stack">
      <BusinessHeader icon="alert" title="Claims" description="Damage claims, and the claims of a period added up with the compensation given. A claim is decided on its order." />
      <SectionCard flush icon="chart" title="Claims added up"
        actions={(
          <span className="form-actions bz-start">
            <Segmented label="Add up" options={BY} value={by} onChange={setBy} />
            <Field label="From"><input type="date" value={period.from} max={period.to || undefined} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} /></Field>
            <Field label="To"><input type="date" value={period.to} min={period.from || undefined} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} /></Field>
          </span>
        )}>
        <ErrorMessage message={error} />
        <DataGrid variant="compact" id="laundry-claims-report" caption="Claims added up" rows={rows} loading={!report && !error} rowKey={(r) => r.key} currency={biz.symbol}
          rowClassName={(r) => (r.key === "All" ? "ldy-report-total" : "")} rowNoun={["row", "rows"]} columns={[
            { key: "key", header: BY.find((b) => b.value === by).label.replace("By ", "").replace(/^\w/, (c) => c.toUpperCase()), value: (r) => r.key, mobile: "title",
              render: (r) => (r.key === "All" ? <strong>All</strong> : r.key) },
            { key: "claims", header: "Claims", type: "number", value: (r) => r.claims, mobile: "show" },
            { key: "waiting", header: "Waiting", type: "number", value: (r) => r.waiting },
            { key: "refunds", header: "Money back", type: "number", value: (r) => r.refunds },
            { key: "credits", header: "Credit note", type: "number", value: (r) => r.credits },
            { key: "reprocessed", header: "Reprocessed", type: "number", value: (r) => r.reprocessed },
            { key: "rejected", header: "Rejected", type: "number", value: (r) => r.rejected },
            money && { key: "compensation", header: "Compensation", type: "money", exact: true, value: (r) => Number(r.compensation) },
            money && { key: "refunded", header: "Refunded", type: "money", exact: true, value: (r) => Number(r.refunded) },
            money && { key: "asked", header: "Asked", type: "money", exact: true, value: (r) => Number(r.asked) },
          ].filter(Boolean)} empty="No claims in this period" emptyIcon="alert" />
      </SectionCard>
      <SectionCard flush icon="alert" title="Every claim">
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Order, tag, customer or phone" }} caption="Damage claims" rowNoun={["claim", "claims"]}
          currency={biz.symbol} rowClassName={(x) => (x.open ? "dg-tone-warning" : "")} columns={[
            { key: "order", header: "Order", value: (x) => x.order_no, mobile: "title", render: (x) => <Link to={biz.path(`garment-orders/${x.order_id}`)} className="mono">{x.order_no}</Link> },
            { key: "garment", header: "Garment", value: (x) => `${x.tag_no} ${x.garment_name}`, render: (x) => <span className="bz-two-line"><span>{x.garment_name} · {x.service_name}</span><small className="muted mono">{x.tag_no}</small></span> },
            { key: "customer", header: "Customer", value: (x) => x.customer_name },
            { key: "issue", header: "Claim", value: (x) => x.description, render: (x) => <span className="bz-two-line"><span>{wordOf(ISSUES, x.issue)}</span><small className="muted">{x.description}</small></span> },
            { key: "reported", header: "Reported", type: "datetime", value: (x) => x.reported_at, render: (x) => <span className="bz-two-line"><span>{dateTime(x.reported_at)}</span>
              <small className="muted">{[x.reported_by_name, x.days_after_delivery !== null && x.days_after_delivery !== undefined ? `${x.days_after_delivery} days after the handover` : null].filter(Boolean).join(" · ")}</small></span> },
            { key: "decision", header: "Decision", value: (x) => (x.decision ? wordOf(DECISIONS, x.decision) : "Waiting"), mobile: "show",
              render: (x) => (x.decision ? <span className="bz-two-line"><Badge tone={x.decision === "rejected" ? "neutral" : "success"} label={wordOf(DECISIONS, x.decision)} />
                <small className="muted">{[x.amount ? biz.exact(x.amount) : null, x.return_no, x.decided_by_name].filter(Boolean).join(" · ")}</small></span>
                : <Badge tone="warning" label="Waiting for a manager" />) },
          ]} empty="No damage claims" emptyIcon="alert" />
      </SectionCard>
    </div>
  );
}
