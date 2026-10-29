import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { dayWords, monthWords, qty } from "./fuel";
import { printStatement } from "./fuelPrint";
import { FleetInterest, FleetTerms, SlipBooks } from "./FleetParts";
import "../styles/fuel.css";

// A fleet customer's statement for a month: each vehicle's fills on credit
// (the day, the slip, the fuel, the quantity at the price in force and the
// fuel bill it went on) with the vehicle's total, the month's totals by fuel,
// and the account: what was owed at the start, billed, paid or credited, and
// owed at the end (for those who see the customers' accounts).

export default function FleetStatementPage() {
  const biz = useOpenBusiness();
  const { contactId } = useParams();
  const [params, setParams] = useSearchParams();
  const today = businessToday(biz.business.timezone);
  const month = /^\d{4}-\d{2}$/.test(params.get("month") || "") ? params.get("month") : today.slice(0, 7);
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `fuel/fleet/${contactId}/statement`, { month }, controller.signal)
      .then((s) => { setStatement(s); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, month, version]);

  if (!statement || statement.month !== month) {
    return (
      <div className="stack">
        <BusinessHeader icon="truck" title="Fleet statement" />
        <ErrorMessage message={error} />
        {!error && <Loading />}
        <Link to={biz.path("fuel-fleet")}>Back to Fleet statements</Link>
      </div>
    );
  }
  const c = statement.customer;
  return (
    <div className="stack">
      <BusinessHeader icon="truck" title={c.name} description={`Fleet statement for ${monthWords(statement.month)}${c.phone ? ` · ${c.phone}` : ""}`}
        primary={biz.can("fuel.print") && <button type="button" className="button button-secondary" onClick={() => printStatement(biz, statement)}><Icon name="print" size={16} /> Print the statement</button>} />
      <div className="fuel-toolbar">
        <label className="field fuel-outlet"><span>Month</span><input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setParams({ month: e.target.value })} /></label>
        <Link className="small" to={biz.path("fuel-fleet")}>Back to Fleet statements</Link>
      </div>
      <div className="stat-grid">
        <StatTile icon="truck" tone="primary" label="Fills this month" value={String(statement.fills)} note={statement.totals.map((t) => `${t.product} ${qty(t.litres, t.unit)}`).join(" · ") || "none"} />
        <StatTile icon="receipt" tone="neutral" label="Filled on credit" value={biz.exact(statement.amount)} />
        <StatTile icon="wallet" tone={c.credit_limit !== null && Number(c.balance) > Number(c.credit_limit) ? "danger" : "neutral"} label="Owes now" value={biz.exact(c.balance)}
          note={c.credit_limit !== null ? `credit limit ${biz.exact(c.credit_limit)}${c.credit_days !== null ? ` · ${c.credit_days} days` : ""}` : "no credit limit"} />
      </div>
      <FleetTerms biz={biz} statement={statement} onChanged={() => setVersion((n) => n + 1)} />
      <FleetInterest biz={biz} contactId={c.id} version={version} />
      <SlipBooks biz={biz} customer={c} />
      {statement.vehicles.length ? statement.vehicles.map((v) => (
        <SectionCard key={v.registration} flush icon="truck" title={v.registration} description={`${v.fills.length} ${v.fills.length === 1 ? "fill" : "fills"} · ${biz.exact(v.amount)}`}>
          <DataGrid variant="compact" id="fuel-statement-fills" caption={`Fills of ${v.registration}`} rows={v.fills} rowKey={(f) => f.id} currency={biz.symbol} rowNoun={["fill", "fills"]}
            exportName={biz.can("fuel.export") ? `${biz.business.code}-${v.registration}-${statement.month}` : undefined}
            columns={[
              { key: "day", header: "Day", value: (f) => f.day, mobile: "title", render: (f) => dayWords(f.day) },
              { key: "slip_no", header: "Slip", value: (f) => f.slip_no || "", className: "mono" },
              { key: "fuel", header: "Fuel", value: (f) => f.product_name },
              { key: "litres", header: "Quantity", value: (f) => Number(f.litres), className: "mono", render: (f) => qty(f.litres, f.unit), mobile: "subtitle" },
              { key: "price", header: "Price", type: "money", exact: true, value: (f) => Number(f.price) },
              { key: "amount", header: "Amount", type: "money", exact: true, value: (f) => Number(f.amount), total: "sum", mobile: "show" },
              { key: "shift", header: "Shift", value: (f) => f.shift_no, className: "mono", defaultHidden: true },
              { key: "document_no", header: "Bill", value: (f) => f.document_no || "Held for the month", className: "mono" },
            ]} />
        </SectionCard>
      )) : <p className="muted">No fills on credit in {monthWords(statement.month)}.</p>}
      {statement.ledger && (
        <SectionCard flush icon="wallet" title="The account" description={`Owed on ${dayWords(statement.from)}: ${biz.exact(statement.ledger.opening)} · billed ${biz.exact(statement.ledger.debit)} · paid and credited ${biz.exact(statement.ledger.credit)} · owed at the end ${biz.exact(statement.ledger.closing)}`}>
          <DataGrid variant="compact" id="fuel-statement-ledger" caption="The account" rows={statement.ledger.entries} rowKey={(e, i) => `${e.kind}-${e.reference}-${i}`} currency={biz.symbol}
            rowNoun={["entry", "entries"]}
            columns={[
              { key: "day", header: "Day", value: (e) => e.day, mobile: "title", render: (e) => dayWords(e.day) },
              { key: "reference", header: "What", value: (e) => e.reference, mobile: "subtitle" },
              { key: "debit", header: "Billed", type: "money", exact: true, value: (e) => Number(e.debit), total: "sum" },
              { key: "credit", header: "Paid or credited", type: "money", exact: true, value: (e) => Number(e.credit), total: "sum" },
              { key: "balance", header: "Balance", type: "money", exact: true, value: (e) => Number(e.balance), mobile: "show" },
            ]}
            empty="No bills or payments this month" emptyIcon="wallet" />
        </SectionCard>
      )}
    </div>
  );
}
