import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import SearchPicker from "../../../../components/SearchPicker";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { dateTime, useOpenBusiness } from "../../core/pages/hooks";
import { toast } from "../../../../services/toast";
import KycPanel from "./KycPanel";
import StrLog from "./StrLog";
import "../styles/jewellery.css";

// The cash report: the cash the shop took from and paid to each person
// (bills, receipts, gold scheme instalments, refunds, advances handed back,
// old gold paid out), in the rolling month to today or any period, customers
// sharing a PAN or a phone number, or in one family group the shop sets,
// taken as one person, with the shop's own alert levels and a flag at ₹10
// lakh: a jeweller carrying out cash
// transactions of ₹10 lakh or more with a customer, at once or in several
// that appear linked, is a reporting entity under the PMLA, and then reports
// each month's cash transactions above ₹10 lakh to FIU-IND by the 15th. The
// monthly worksheet below is for that report; nothing is filed from here.
// Each person's KYC opens from their row; those who keep the suspicious
// transaction log see it at the foot.

const LEVELS = { reporting: { label: "₹10 lakh or more", tone: "danger" }, alert: { label: "Past the shop's level", tone: "warning" } };
const LINKS = { pan: "same PAN", phone: "same phone", family: "family group" };
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
  const [kyc, setKyc] = useState(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/cash-report", { ...(period.from ? { from: period.from } : {}), ...(period.to ? { to: period.to } : {}) }, controller.signal)
      .then((r) => { setReport(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, period.from, period.to, version]);
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
        description="The cash taken from and paid to each person, customers sharing a PAN or a phone number, or in one family group, as one, flagged at ₹10 lakh. Nothing is filed from here."
        secondary={<Link className="button button-secondary" to={biz.path("jewellery-settings")}><Icon name="settings" size={15} /> Alert levels</Link>} />
      <ErrorMessage message={error} />
      <SectionCard icon="alert" title={report.reportingEntity ? "The shop is a reporting entity" : "₹10 lakh in cash with a customer"}>
        <p className="jw-note">A jeweller that carries out cash transactions of ₹10 lakh or more with a customer, at once or in several that appear linked (paying cash for old jewellery is one), is a reporting entity under the PMLA, and from then on reports each month&apos;s cash transactions above ₹10 lakh (and the linked ones within a month adding up to more) to FIU-IND by the 15th of the next month.
          {report.reportingEntity ? ` The owner said the shop is a reporting entity on ${dateTime(report.reportingEntityAt)}.` : " Say so in Jewellery settings once the shop is one."}</p>
      </SectionCard>
      <SectionCard icon="wallet" title="Cash with each customer" description={`From ${dateShort(report.from, { year: true })} to ${dateShort(report.to, { year: true })}${report.alertLevels.length ? `; the shop's own alert levels ${report.alertLevels.map((x) => biz.exact(x)).join(", ")}` : ""}.`}
        actions={report.people.length > 0 && <button type="button" className="button button-secondary" onClick={exportReport}><Icon name="download" size={15} /> Export</button>}>
        <div className="jw-row">
          <Field label="From"><input type="date" value={period.from || report.from} max={report.today} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} /></Field>
          <Field label="To"><input type="date" value={period.to || report.to} max={report.today} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} /></Field>
          {(period.from || period.to) && <button type="button" className="link-button" onClick={() => setPeriod({ from: "", to: "" })}>The rolling month to today</button>}
        </div>
        <div className="jw-totals">
          <span>{report.totals.people} people</span><span>In {biz.exact(report.totals.cashIn)}</span><span>Out {biz.exact(report.totals.cashOut)}</span>
          {report.totals.reporting > 0 && <strong className="bz-minus">{report.totals.reporting} at ₹10 lakh or more</strong>}
          {report.totals.alert > 0 && <span>{report.totals.alert} past the shop&apos;s levels</span>}
        </div>
        {report.people.length === 0 ? <p className="jw-note">No cash with a customer in these days.</p> : (
          <table className="jw-rates">
            <thead><tr><th scope="col">Person</th><th scope="col">PAN</th><th scope="col">Transactions</th><th scope="col">Cash in</th><th scope="col">Cash out</th><th scope="col">In and out</th><th scope="col">Flag</th><th scope="col">KYC</th></tr></thead>
            <tbody>{report.people.map((p) => (
              <tr key={p.key} className={p.level === "reporting" ? "jw-flag" : ""}>
                <th scope="row"><button type="button" className="link-button" onClick={() => setOpen(p)}>{p.name}</button>{p.phone && <small className="muted"> · {p.phone}</small>}
                  {p.links.length > 0 && <small className="muted"> · linked by {p.links.map((l) => LINKS[l.link] || l.link).join(" and ")}</small>}</th>
                <td className="mono">{p.pan || "—"}</td><td>{p.count}</td><td>{biz.exact(p.cashIn)}</td><td>{biz.exact(p.cashOut)}</td><td><strong>{biz.exact(p.total)}</strong></td>
                <td>{p.level ? <Badge tone={LEVELS[p.level].tone} label={p.level === "alert" ? `Past ${biz.exact(p.alertLevel)}` : LEVELS[p.level].label} /> : ""}</td>
                <td>{p.contacts.map((x) => <button key={x.id} type="button" className="chip-button" onClick={() => setKyc(x)}>{p.contacts.length > 1 ? x.name : p.kyc ? "On file" : "Record"}</button>)}</td>
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
      <FamilyGroups biz={biz} onChanged={() => setVersion((n) => n + 1)} />
      {biz.can("jewellery.review") && <StrLog biz={biz} />}
      {open && <PersonPanel biz={biz} person={open} period={report} onClose={() => setOpen(null)} />}
      {kyc && <KycPanel biz={biz} contact={kyc} onClose={() => { setKyc(null); setVersion((n) => n + 1); }} />}
    </div>
  );
}

// The family groups the shop sets: each group's customers are one person in the cash report (a customer is in one group at a time).
function FamilyGroups({ biz, onChanged }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/cash-report/families", undefined, controller.signal).then((d) => { setList(d.items); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const run = async (work, message) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      setList((await work()).items);
      toast.success(message);
      onChanged?.();
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const findCustomer = (q, { signal }) => businessRead(biz.id, "contacts", { kind: "customer", q, limit: 15 }, signal).then((page) => page.items);
  const make = async (event) => {
    event.preventDefault();
    if (await run(() => businessWrite(biz.id, "jewellery/cash-report/families", { name: name.trim() }), `${name.trim()} made.`)) setName("");
  };
  return (
    <SectionCard icon="users" title="Family groups" description="Customers in one family group are one person in the cash report, beside those linked by a PAN or a phone number.">
      <ErrorMessage message={error} />
      <form className="jw-row" onSubmit={make}>
        <Field label="A new family group"><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rao family" /></Field>
        <button type="submit" className="button button-secondary" disabled={busy}><Icon name="plus" size={15} /> Make it</button>
      </form>
      {!list ? !error && <Loading /> : list.length === 0 ? <p className="jw-note">No family groups yet.</p> : list.map((f) => (
        <section key={f.id} className="jw-family">
          <h3 className="jw-subhead">{f.name}</h3>
          {f.members.length === 0 ? <p className="muted small">No one in it yet.</p> : (
            <ul className="jw-history">{f.members.map((m) => (
              <li key={m.id}><span>{m.name}{m.phone ? ` · ${m.phone}` : ""}</span>
                <button type="button" className="link-button danger" disabled={busy} aria-label={`Take ${m.name} out of ${f.name}`}
                  onClick={() => run(() => businessWrite(biz.id, `jewellery/cash-report/families/${f.id}`, { remove: [m.id] }, "put"), `${m.name} taken out.`)}>Take out</button></li>
            ))}</ul>
          )}
          <SearchPicker label={`Add a customer to ${f.name}`} placeholder="Name or phone" value={null} minChars={2} search={findCustomer}
            onChange={(c) => { if (c) run(() => businessWrite(biz.id, `jewellery/cash-report/families/${f.id}`, { add: [c.id] }, "put"), `${c.name} added.`); }}
            getLabel={(x) => x.name} getDescription={(x) => x.phone || ""} />
        </section>
      ))}
    </SectionCard>
  );
}
