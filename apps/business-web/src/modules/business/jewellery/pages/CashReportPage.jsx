import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { dateTime, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/jewellery.css";

// The cash report: the cash the shop took from and paid to each customer
// (bills, receipts, gold scheme instalments, refunds, advances handed back,
// old gold paid out), in the month to today or any period, customers with one
// PAN taken as one, with a flag at ₹10 lakh: a jeweller carrying out cash
// transactions of ₹10 lakh or more with a customer, at once or in several
// that appear linked, is a reporting entity under the PMLA, and then reports
// each month's cash transactions above ₹10 lakh to FIU-IND by the 15th. The
// monthly worksheet below is for that report; nothing is filed from here.

const LEVELS = { reporting: { label: "₹10 lakh or more", tone: "danger" }, watch: { label: "Past the shop's level", tone: "warning" } };
const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
function download(name, rows) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv" }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
const monthBefore = (day) => { const [y, m] = day.split("-").map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); };

function PersonPanel({ biz, person, period, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/cash-report/person", { key: person.key, from: period.from, to: period.to }, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, person.key, period.from, period.to]);
  return (
    <SidePanel open title={person.name} icon="wallet" wide onClose={onClose} rule={`Cash from ${dateShort(period.from, { year: true })} to ${dateShort(period.to, { year: true })}`}>
      <ErrorMessage message={error} />
      {!data ? !error && <Loading /> : (
        <table className="jw-rates">
          <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Of</th><th scope="col">Customer</th><th scope="col">In</th><th scope="col">Out</th></tr></thead>
          <tbody>{data.transactions.map((x, index) => (
            <tr key={`${x.ref}:${index}`}><td>{dateTime(x.at)}</td><td>{x.kindWords}</td><td className="mono">{x.ref}</td><td>{x.name || "—"}</td>
              <td>{Number(x.cashIn) ? biz.exact(x.cashIn) : ""}</td><td>{Number(x.cashOut) ? biz.exact(x.cashOut) : ""}</td></tr>
          ))}</tbody>
        </table>
      )}
    </SidePanel>
  );
}

export default function CashReportPage() {
  const biz = useOpenBusiness();
  const [period, setPeriod] = useState({ from: "", to: "" });
  const [report, setReport] = useState(null);
  const [month, setMonth] = useState("");
  const [sheet, setSheet] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/cash-report", { ...(period.from ? { from: period.from } : {}), ...(period.to ? { to: period.to } : {}) }, controller.signal)
      .then((r) => { setReport(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, period.from, period.to]);
  const shownMonth = month || (report ? monthBefore(report.today) : "");
  useEffect(() => {
    if (!shownMonth) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/cash-report/month", { month: shownMonth }, controller.signal).then(setSheet)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, shownMonth]);
  const flagged = useMemo(() => (report ? report.people.filter((p) => p.level) : []), [report]);
  if (!report) return <div className="stack"><BusinessHeader icon="reports" title="Cash report" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  const exportReport = () => download(`cash-report-${report.from}-${report.to}.csv`, [["Customer", "Phone", "PAN", "Transactions", "Cash in", "Cash out", "In and out", "Largest", "Flag"],
    ...report.people.map((p) => [p.name, p.phone, p.pan, p.count, p.cashIn, p.cashOut, p.total, p.largest, p.level ? LEVELS[p.level].label : ""]),
    ...(report.unlinked.count ? [["Walk-ins not linked to a customer", "", "", report.unlinked.count, report.unlinked.cashIn, report.unlinked.cashOut, "", "", ""]] : [])]);
  const exportSheet = () => download(`cash-transactions-${sheet.month}.csv`, [["Customer", "PAN", "Date", "What", "Of", "Cash in", "Cash out"],
    ...sheet.people.flatMap((p) => p.transactions.map((x) => [p.name, p.pan, x.day, x.kindWords, x.ref, x.cashIn, x.cashOut]))]);
  return (
    <div className="stack">
      <BusinessHeader icon="reports" title="Cash report"
        description="The cash taken from and paid to each customer, customers with one PAN as one, flagged at ₹10 lakh. Nothing is filed from here."
        secondary={<Link className="button button-secondary" to={biz.path("jewellery-settings")}><Icon name="settings" size={15} /> Alert level</Link>} />
      <ErrorMessage message={error} />
      <SectionCard icon="alert" title={report.reportingEntity ? "The shop is a reporting entity" : "₹10 lakh in cash with a customer"}>
        <p className="jw-note">A jeweller that carries out cash transactions of ₹10 lakh or more with a customer, at once or in several that appear linked (paying cash for old jewellery is one), is a reporting entity under the PMLA, and from then on reports each month&apos;s cash transactions above ₹10 lakh (and the linked ones within a month adding up to more) to FIU-IND by the 15th of the next month.
          {report.reportingEntity ? ` The owner said the shop is a reporting entity on ${dateTime(report.reportingEntityAt)}.` : " Say so in Jewellery settings once the shop is one."}</p>
      </SectionCard>
      <SectionCard icon="wallet" title="Cash with each customer" description={`From ${dateShort(report.from, { year: true })} to ${dateShort(report.to, { year: true })}${report.watchLevel ? `; the shop's own alert level ${biz.exact(report.watchLevel)}` : ""}.`}
        actions={report.people.length > 0 && <button type="button" className="button button-secondary" onClick={exportReport}><Icon name="download" size={15} /> Export</button>}>
        <div className="jw-row">
          <Field label="From"><input type="date" value={period.from || report.from} max={report.today} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} /></Field>
          <Field label="To"><input type="date" value={period.to || report.to} max={report.today} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} /></Field>
          {(period.from || period.to) && <button type="button" className="link-button" onClick={() => setPeriod({ from: "", to: "" })}>The month to today</button>}
        </div>
        <div className="jw-totals">
          <span>{report.totals.people} customers</span><span>In {biz.exact(report.totals.cashIn)}</span><span>Out {biz.exact(report.totals.cashOut)}</span>
          {report.totals.reporting > 0 && <strong className="bz-minus">{report.totals.reporting} at ₹10 lakh or more</strong>}
          {report.totals.watch > 0 && <span>{report.totals.watch} past the shop&apos;s level</span>}
        </div>
        {report.people.length === 0 ? <p className="jw-note">No cash with a customer in these days.</p> : (
          <table className="jw-rates">
            <thead><tr><th scope="col">Customer</th><th scope="col">PAN</th><th scope="col">Transactions</th><th scope="col">Cash in</th><th scope="col">Cash out</th><th scope="col">In and out</th><th scope="col">Flag</th></tr></thead>
            <tbody>{report.people.map((p) => (
              <tr key={p.key} className={p.level === "reporting" ? "jw-flag" : ""}>
                <th scope="row"><button type="button" className="link-button" onClick={() => setOpen(p)}>{p.name}</button>{p.phone && <small className="muted"> · {p.phone}</small>}</th>
                <td className="mono">{p.pan || "—"}</td><td>{p.count}</td><td>{biz.exact(p.cashIn)}</td><td>{biz.exact(p.cashOut)}</td><td><strong>{biz.exact(p.total)}</strong></td>
                <td>{p.level ? <Badge tone={LEVELS[p.level].tone} label={LEVELS[p.level].label} /> : ""}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {report.unlinked.count > 0 && <p className="muted small">Walk-ins&apos; cash not linked to a customer (no customer or PAN on the bill): {report.unlinked.count} · in {biz.exact(report.unlinked.cashIn)} · out {biz.exact(report.unlinked.cashOut)}.</p>}
        {flagged.length > 0 && <p className="jw-note jw-warn">Check whether these customers&apos; cash transactions are linked, and keep their KYC.</p>}
      </SectionCard>
      <SectionCard icon="file" title="Monthly cash transactions worksheet" description="Each customer whose cash in a month was above ₹10 lakh, in one transaction or several, with every cash transaction: what a reporting entity reports by the 15th of the next month."
        actions={sheet?.people.length > 0 && <button type="button" className="button button-secondary" onClick={exportSheet}><Icon name="download" size={15} /> Export</button>}>
        <div className="jw-row">
          <Field label="Month"><input type="month" value={shownMonth} max={report.today.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} /></Field>
          {sheet && <p className="muted small">Due by {dateShort(sheet.dueBy, { year: true })}.</p>}
        </div>
        {!sheet ? <Loading /> : sheet.people.length === 0 ? <p className="jw-note">No customer&apos;s cash was above ₹10 lakh in this month.</p> : sheet.people.map((p) => (
          <section key={p.key}>
            <h3 className="jw-subhead">{p.name}{p.pan ? ` · PAN ${p.pan}` : ""}: {biz.exact(p.total)}</h3>
            <table className="jw-rates">
              <thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Of</th><th scope="col">In</th><th scope="col">Out</th></tr></thead>
              <tbody>{p.transactions.map((x, index) => <tr key={`${x.ref}:${index}`}><td>{dateShort(x.day, { year: true })}</td><td>{x.kindWords}</td><td className="mono">{x.ref}</td>
                <td>{Number(x.cashIn) ? biz.exact(x.cashIn) : ""}</td><td>{Number(x.cashOut) ? biz.exact(x.cashOut) : ""}</td></tr>)}</tbody>
            </table>
          </section>
        ))}
      </SectionCard>
      {open && <PersonPanel biz={biz} person={open} period={report} onClose={() => setOpen(null)} />}
    </div>
  );
}
