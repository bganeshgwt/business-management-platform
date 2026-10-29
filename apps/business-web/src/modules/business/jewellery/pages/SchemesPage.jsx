import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { Badge, BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { SCHEME_STAGES } from "./jewellery";
import { EnrolForm, SchemePanel } from "./SchemeDialogs";
import "../styles/jewellery.css";

// Gold schemes: every customer's scheme with what was paid in, the next
// instalment's day, its maturity and the day it closes by, and where it
// stands (paying, an instalment due, matured, stopped, closing today on its
// day 364, past its close day, in the customer's safekeeping, redeemed).
// Below, the money the shop holds for open schemes, to be given as jewellery,
// with the discounts they give, exported for the accountant; and for a
// company, all of it against 25% of its net worth (Jewellery settings).

const CHIPS = [["open", "Open", { open: "true" }], ["due", "Instalment due", { stage: "due" }], ["matured", "Matured", { stage: "matured" }], ["stopped", "Stopped", { stage: "stopped" }],
  ["closing", "Day 364 today", { stage: "closing" }], ["past_close", "Past the close day", { stage: "past_close" }], ["safekeeping", "In safekeeping", { stage: "safekeeping" }],
  ["redeemed", "Redeemed", { stage: "redeemed" }], ["all", "All", {}]];
const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export default function SchemesPage() {
  const biz = useOpenBusiness();
  const [chip, setChip] = useState("open");
  const [plans, setPlans] = useState(null);
  const [money, setMoney] = useState(null);
  const [error, setError] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [version, setVersion] = useState(0);
  const params = useMemo(() => CHIPS.find(([value]) => value === chip)?.[2] || {}, [chip]);
  const list = useServerList("jewellery/schemes", { gridId: "jewellery-schemes", params });
  const many = biz.locations.length > 1;
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "jewellery/scheme-plans", undefined, controller.signal), businessRead(biz.id, "jewellery/schemes/liability", undefined, controller.signal)])
      .then(([p, m]) => { setPlans(p.items); setMoney(m); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const reload = useCallback(() => { setVersion((n) => n + 1); list.reload(); }, [list]);
  const columns = useMemo(() => [
    { key: "scheme_no", header: "Scheme", value: (s) => s.scheme_no, className: "mono", mobile: "title", pin: true },
    { key: "member", header: "Member", value: (s) => `${s.member_name} ${s.member_phone || ""}`, mobile: "subtitle",
      render: (s) => <span className="bz-two-line"><span>{s.member_name}</span>{s.member_phone && <small className="muted">{s.member_phone}</small>}</span> },
    { key: "plan_name", header: "Plan", value: (s) => s.plan_name },
    { key: "instalment", header: "Each month", type: "money", exact: true, value: (s) => Number(s.instalment) },
    { key: "paid_count", header: "Paid", value: (s) => `${s.paid_count} of ${s.instalments}` },
    { key: "paid", header: "Paid in", type: "money", exact: true, value: (s) => Number(s.paid), total: "sum", mobile: "show" },
    { key: "next_due", header: "Next due", value: (s) => (s.status === "active" && s.paid_count < s.instalments ? dateShort(s.next_due_on, { year: true }) : "—") },
    { key: "maturity_on", header: "Matures", value: (s) => dateShort(s.maturity_on, { year: true }), defaultHidden: true },
    { key: "close_by", header: "Close by", value: (s) => s.close_by, render: (s) => <span className="bz-two-line"><span>{dateShort(s.close_by, { year: true })}</span>
      {s.status !== "redeemed" && <small className={Number(s.days_left) <= 30 ? "bz-minus" : "muted"}>{Number(s.days_left) < 0 ? `${-Number(s.days_left)} days past` : `${s.days_left} days`}</small>}</span> },
    { key: "stage", header: "Stands", type: "status", value: (s) => SCHEME_STAGES[s.stage]?.label || s.stage, mobile: "show",
      render: (s) => <Badge tone={SCHEME_STAGES[s.stage]?.tone} label={SCHEME_STAGES[s.stage]?.label || s.stage} /> },
    { key: "location", header: "Location", value: (s) => s.location_name || "", defaultHidden: !many },
  ], [many]);
  const exportMoney = () => {
    const rows = [["Scheme", "Member", "Phone", "Plan", "Joined", "Matures", "Close by", "Instalments paid", "Paid in", "Discount now", "Discount when complete", "Stands"],
      ...money.items.map((i) => [i.scheme_no, i.member_name, i.member_phone, i.plan_name, i.started_on, i.maturity_on, i.close_by, `${i.paid_count} of ${i.instalments}`, i.paid,
        i.discount_now, i.discount_when_complete, SCHEME_STAGES[i.stage]?.label || i.stage])];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv" }));
    link.download = `gold-schemes-${money.asOf}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const canEnrol = biz.can("jewellery.create") && biz.can("sales.edit");
  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Gold schemes"
        description="Customers pay every month and turn what they paid into jewellery within the year, with the plan's discount when every instalment is paid. Never paid back in money."
        primary={canEnrol && <button type="button" className="button" disabled={!plans} onClick={() => setEnrolling(true)}><Icon name="plus" size={16} /> Enrol a customer</button>}
        secondary={biz.can("sales.view") && <Link className="button button-secondary" to={biz.path("scheme-plans")}><Icon name="settings" size={15} /> Plans</Link>} />
      <ErrorMessage message={error || list.error} />
      <SectionCard flush icon="calendar" title="Schemes">
        <div className="fe-chips" role="group" aria-label="Schemes">
          {CHIPS.map(([value, label]) => <button key={value} type="button" aria-pressed={chip === value} className={`fe-chip ${chip === value ? "is-active" : ""}`} onClick={() => setChip(value)}>{label}</button>)}
        </div>
        <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Scheme, member, phone or plan" }} caption="Gold schemes" columns={columns}
          rowNoun={["scheme", "schemes"]} onRowClick={(s) => setOpenId(s.id)} rowClassName={(s) => (["past_close", "closing"].includes(s.stage) ? "dg-tone-danger" : s.stage === "safekeeping" ? "" : s.status === "redeemed" ? "dg-tone-muted" : "")}
          empty="No schemes here" emptyHint={canEnrol ? "Enrol a customer in a plan to start one." : undefined} emptyIcon="calendar" />
      </SectionCard>
      {money && (
        <SectionCard icon="wallet" title="Money held for the schemes" description={`As of ${dateShort(money.asOf, { year: true })}: what customers paid into schemes not yet redeemed, owed to them as jewellery.`}
          actions={biz.can("jewellery.export") && money.items.length > 0 && <button type="button" className="button button-secondary" onClick={exportMoney}><Icon name="download" size={15} /> Export</button>}>
          <div className="jw-totals">
            <span>{money.totals.schemes} open</span>
            <strong>Held {biz.exact(money.totals.paid)}</strong>
            <span>Discounts due now {biz.exact(money.totals.discountNow)}</span>
            <span>When complete {biz.exact(money.totals.discountWhenComplete)}</span>
            {money.totals.closingToday > 0 && <span className="bz-minus">{money.totals.closingToday} on day 364 today: close each into safekeeping</span>}
            {money.totals.pastClose > 0 && <span className="bz-minus">{money.totals.pastClose} past the close day</span>}
            {money.totals.closingIn30 > 0 && <span>{money.totals.closingIn30} closing within 30 days</span>}
          </div>
          {money.byPlan.length > 0 && (
            <table className="jw-rates">
              <thead><tr><th scope="col">Plan</th><th scope="col">Open schemes</th><th scope="col">Held</th></tr></thead>
              <tbody>{money.byPlan.map((p) => <tr key={p.plan}><th scope="row">{p.plan}</th><td>{p.schemes}</td><td>{biz.exact(p.paid)}</td></tr>)}</tbody>
            </table>
          )}
          {money.netWorth && (
            <p className={`jw-note ${money.netWorth.over ? "jw-warn" : ""}`}>
              A company keeps its gold scheme money within {money.netWorth.sharePercent}% of its net worth: {biz.exact(money.netWorth.held)} held against {biz.exact(money.netWorth.limit)}
              {" "}({money.netWorth.sharePercent}% of {biz.exact(money.netWorth.netWorth)} as of {dateShort(money.netWorth.on, { year: true })}), {money.netWorth.usedPercent}% of the net worth.
              {money.netWorth.over ? ` It is ${biz.exact(-Number(money.netWorth.headroom))} past it.` : ` ${biz.exact(money.netWorth.headroom)} left within it.`}
            </p>
          )}
        </SectionCard>
      )}
      {enrolling && <EnrolForm biz={biz} plans={plans || []} onClose={() => setEnrolling(false)} onSaved={(s) => { setEnrolling(false); reload(); setOpenId(s.id); }} />}
      {openId && <SchemePanel biz={biz} schemeId={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
