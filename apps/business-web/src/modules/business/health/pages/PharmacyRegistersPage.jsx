import ContentTabs from "../../../../components/ContentTabs";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import StatTile from "../../../../components/StatTile";
import StatusBadge from "../../../../components/StatusBadge";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import { BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { quantity, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { ScheduleBadge } from "./healthParts";
import { openPrescriptionFile } from "./healthFormat";
import { printDebitNote, printRegister } from "./healthPrint";
import "../styles/health.css";

// Pharmacy reports: the H1 register and the Schedule X register (filled in by
// each prescription sale), the prescription log (every Schedule H / H1 / X
// bill with its scan), and the status of expiry returns to distributors.
// Each opens on this month with the period visible, prints as the inspector
// expects (S.No., date, patient, prescriber, drug, quantity, batch) and exports.
const TABS = [["h1", "H1 register"], ["x", "Schedule X register"], ["prescriptions", "Prescription log"], ["returns", "Expiry returns"]];
const REASON_WORDS = { expired: "Expired", near_expiry: "Near expiry", breakage: "Breakage", recall: "Recall", other: "Other" };

export default function PharmacyRegistersPage() {
  const biz = useOpenBusiness();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get("tab")) ? params.get("tab") : "h1";
  const [summary, setSummary] = useState(null);
  const [rx, setRx] = useState(null);
  const path = { h1: "pharmacy/registers/h1", x: "pharmacy/registers/x", prescriptions: "pharmacy/prescriptions", returns: "pharmacy/debit-notes" }[tab];
  const list = useServerList(path, { gridId: `pharmacy-register-${tab}`, period: true });
  const range = list.range;
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "pharmacy/summary", range, controller.signal).then(setSummary).catch(() => {});
    return () => controller.abort();
  }, [biz.id, range]);

  const registerColumns = useMemo(() => [
    { key: "date", header: "Date", type: "datetime", value: (e) => e.created_at, mobile: "subtitle" },
    { key: "bill", header: "Bill", value: (e) => e.document_no, className: "mono" },
    { key: "patient", header: "Patient", value: (e) => e.patient_name, mobile: "title", render: (e) => <span className="bz-two-line"><strong>{e.patient_name}</strong><small className="muted">{e.patient_address || ""}</small></span> },
    { key: "doctor", header: "Prescriber", value: (e) => `${e.doctor_name} (${e.doctor_reg_no})`, render: (e) => <span className="bz-two-line"><span>{e.doctor_name}</span><small className="muted">{e.doctor_reg_no}{e.doctor_address ? ` · ${e.doctor_address}` : ""}</small></span> },
    { key: "drug", header: "Drug", value: (e) => e.drug_name, render: (e) => <span className="bz-two-line"><span>{e.drug_name}</span><small className="muted">{e.composition || ""}</small></span>, mobile: "show" },
    { key: "qty", header: "Quantity", type: "number", value: (e) => Number(e.quantity), render: (e) => quantity(e.quantity, e.unit), mobile: "show" },
    { key: "returned", header: "Returned", type: "number", value: (e) => Number(e.returned || 0), render: (e) => (Number(e.returned) ? quantity(e.returned, e.unit) : "—") },
    { key: "batch", header: "Batch", value: (e) => e.lot_code, className: "mono" },
    { key: "expiry", header: "Expiry", type: "date", value: (e) => e.expires_on },
    tab === "x" && { key: "pharmacist", header: "Pharmacist", value: (e) => e.pharmacist_name || "", render: (e) => <span className="bz-two-line"><span>{e.pharmacist_name}</span><small className="muted">{e.pharmacist_reg_no}</small></span> },
    { key: "keep", header: "Keep until", type: "date", value: (e) => e.retain_until, defaultHidden: true },
  ].filter(Boolean), [tab]);
  const rxColumns = useMemo(() => [
    { key: "date", header: "Date", type: "datetime", value: (r) => r.created_at, mobile: "subtitle" },
    { key: "bill", header: "Bill", value: (r) => r.document_no, className: "mono" },
    { key: "patient", header: "Patient", value: (r) => r.patient_name, mobile: "title", render: (r) => <span className="bz-two-line"><strong>{r.patient_name}</strong><small className="muted">{r.patient_phone || ""}</small></span> },
    { key: "doctor", header: "Doctor", value: (r) => `${r.doctor_name} (${r.doctor_reg_no})`, render: (r) => <span className="bz-two-line"><span>{r.doctor_name}</span><small className="muted">{r.doctor_reg_no}</small></span> },
    { key: "schedules", header: "Schedules", value: (r) => r.schedules || "", render: (r) => <span className="bz-inline">{(r.schedules || "").split(",").filter(Boolean).map((s) => <ScheduleBadge key={s} schedule={s} />)}</span>, mobile: "show" },
    { key: "items", header: "Medicines", value: (r) => r.items },
    { key: "rx_date", header: "Prescribed", type: "date", value: (r) => r.prescribed_on, defaultHidden: true },
    { key: "scan", header: "Scan", value: (r) => (r.file_id ? "Yes" : "No"), render: (r) => (r.file_id ? <button type="button" className="chip-button" onClick={(ev) => { ev.stopPropagation(); openPrescriptionFile(biz.id, r.file_id); }}>Open scan</button> : <StatusBadge tone="warning" label="No scan" />) },
    { key: "pharmacist", header: "Pharmacist", value: (r) => r.pharmacist_name || "", defaultHidden: true },
    { key: "keep", header: "Keep until", type: "date", value: (r) => r.retain_until, defaultHidden: true },
  ], [biz.id]);
  const returnColumns = useMemo(() => [
    { key: "no", header: "Debit note", value: (n) => n.note_no, className: "mono", mobile: "title" },
    { key: "date", header: "Sent", type: "date", value: (n) => n.created_at, mobile: "subtitle" },
    { key: "supplier", header: "Distributor", value: (n) => n.supplier_name },
    { key: "reason", header: "Reason", value: (n) => REASON_WORDS[n.reason] || n.reason },
    { key: "claimed", header: "Claimed", type: "money", exact: true, value: (n) => Number(n.claimed), total: "sum", mobile: "show" },
    { key: "credited", header: "Credited", type: "money", exact: true, value: (n) => (n.credited_amount == null ? null : Number(n.credited_amount)), total: "sum" },
    { key: "status", header: "Status", value: (n) => n.status, render: (n) => (n.status === "credited"
      ? <StatusBadge tone={n.short_credited ? "warning" : "success"} label={n.short_credited ? "Credited short" : "Credited"} /> : <StatusBadge tone="warning" label="Awaiting credit note" />), mobile: "show" },
    { key: "cn", header: "Credit note", value: (n) => n.credit_note_no || "" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (n) => <button type="button" className="chip-button" onClick={async () => {
      try { printDebitNote(await businessRead(biz.id, `pharmacy/debit-notes/${n.id}`), await businessRead(biz.id, "health/settings").then((s) => s.seller), biz.symbol); } catch (err) { toast.error(getErrorMessage(err)); }
    }}><Icon name="print" size={14} /> Print</button> },
  ], [biz.id, biz.symbol]);

  async function print() {
    try {
      const rows = await list.gridProps.server.fetchAll();
      const settings = await businessRead(biz.id, "health/settings");
      const period = range ? `${dateShort(range.from, { year: true })} – ${dateShort(range.to, { year: true })}` : "";
      if (tab === "prescriptions") {
        printRegister("Prescription log", rows, [["Date", (r) => dateTime(r.created_at)], ["Bill", (r) => r.document_no], ["Patient", (r) => r.patient_name], ["Doctor", (r) => `${r.doctor_name} (${r.doctor_reg_no})`],
          ["Prescribed on", (r) => dateShort(r.prescribed_on, { year: true })], ["Schedules", (r) => r.schedules], ["Medicines", (r) => r.items], ["Scan", (r) => (r.file_id ? "Yes" : "No")]], settings.seller, period);
      } else if (tab === "returns") {
        printRegister("Expiry returns to distributors", rows, [["Debit note", (n) => n.note_no], ["Date", (n) => dateShort(n.created_at, { year: true })], ["Distributor", (n) => n.supplier_name],
          ["Reason", (n) => REASON_WORDS[n.reason]], ["Claimed", (n) => Number(n.claimed).toFixed(2)], ["Credit note", (n) => n.credit_note_no || "Awaited"], ["Credited", (n) => (n.credited_amount == null ? "" : Number(n.credited_amount).toFixed(2))]], settings.seller, period);
      } else {
        printRegister(tab === "h1" ? "Schedule H1 register" : "Schedule X register", rows, [["Date", (e) => dateTime(e.created_at)], ["Bill", (e) => e.document_no], ["Patient", (e) => `${e.patient_name}${e.patient_address ? `, ${e.patient_address}` : ""}`],
          ["Prescriber", (e) => `${e.doctor_name}, Reg. ${e.doctor_reg_no}${e.doctor_address ? `, ${e.doctor_address}` : ""}`], ["Drug", (e) => e.drug_name], ["Quantity", (e) => quantity(e.quantity, e.unit)], ["Returned", (e) => (Number(e.returned) ? quantity(e.returned, e.unit) : "")],
          ["Batch", (e) => e.lot_code], ["Expiry", (e) => (e.expires_on ? dateShort(e.expires_on, { year: true }) : "")], ...(tab === "x" ? [["Pharmacist", (e) => `${e.pharmacist_name || ""} ${e.pharmacist_reg_no || ""}`]] : [])], settings.seller, period);
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  const columns = tab === "prescriptions" ? rxColumns : tab === "returns" ? returnColumns : registerColumns;
  return (
    <div className="stack">
      <BusinessHeader icon="clipboard" title="Registers & prescriptions"
        description="Written automatically with each prescription sale. Kept for the years set in Pharmacy settings (H1: 3, prescriptions and Schedule X: 2)." />
      <div className="stat-grid bz-stat-grid">
        <StatTile icon="file" label="Prescriptions this period" value={summary ? String(summary.prescriptions) : ""} loading={!summary} note={summary ? `${summary.doctors} doctors · ${summary.without_scan} without a scan` : undefined} />
        <StatTile icon="clipboard" label="H1 register entries" value={summary ? String(summary.h1_entries) : ""} loading={!summary} />
        <StatTile icon="shield" label="Schedule X entries" value={summary ? String(summary.x_entries) : ""} loading={!summary} />
        <StatTile icon="truck" label="Returns awaiting credit" value={summary ? String(summary.returns_awaiting_credit) : ""} loading={!summary} note={summary ? `${biz.amount(summary.returns_awaiting_value)} claimed` : undefined} />
      </div>
      <ContentTabs label="Register" value={tab} options={TABS.map(([value,label])=>({value,label}))} onChange={key=>setParams(p=>{const next=new URLSearchParams(p);next.set("tab",key);return next;},{replace:true})}>
      <SectionCard flush icon="list" title={TABS.find(([k]) => k === tab)[1]}
        actions={biz.can("pharmacy.print") && <button type="button" className="button button-secondary" onClick={print}><Icon name="print" size={15} /> Print</button>}>
        <DataGrid key={tab} {...list.gridProps} caption={TABS.find(([k]) => k === tab)[1]} columns={columns} currency={biz.symbol}
          toolbar={<PeriodFilter list={list} />} rowNoun={tab === "returns" ? ["debit note", "debit notes"] : tab === "prescriptions" ? ["prescription", "prescriptions"] : ["entry", "entries"]}
          onRowClick={tab === "prescriptions" ? (r) => setRx(r.id) : undefined}
          exportName={biz.can("pharmacy.export") ? `${biz.business.code}-${tab}` : undefined}
          empty={tab === "returns" ? "No returns in this period" : "No entries in this period"} emptyHint="Choose another period above." emptyIcon="clipboard" />
      </SectionCard>
      </ContentTabs>
      <PrescriptionPanel id={rx} onClose={() => setRx(null)} />
    </div>
  );
}

function PrescriptionPanel({ id, onClose }) {
  const biz = useOpenBusiness();
  const [row, setRow] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `pharmacy/prescriptions/${id}`, undefined, controller.signal).then(setRow).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, id]);
  return (
    <SidePanel open={Boolean(id)} title={row ? `Prescription · ${row.document_no}` : "Prescription"} icon="file" onClose={onClose}
      footer={row?.file_id && <button type="button" className="button" onClick={() => openPrescriptionFile(biz.id, row.file_id)}><Icon name="external" size={15} /> Open the scan</button>}>
      <ErrorMessage message={error} />
      {!row || String(row.id) !== String(id) ? !error && <Loading /> : (
        <div className="stack">
          <dl className="hl-facts">
            <dt>Patient</dt><dd>{row.patient_name}{row.patient_age != null ? `, ${row.patient_age} y` : ""}{row.patient_phone ? ` · ${row.patient_phone}` : ""}</dd>
            <dt>Address</dt><dd>{row.patient_address || "—"}</dd>
            <dt>Doctor</dt><dd>{row.doctor_name} · Reg. {row.doctor_reg_no}{row.doctor_address ? ` · ${row.doctor_address}` : ""}</dd>
            <dt>Prescribed on</dt><dd>{dateShort(row.prescribed_on, { year: true })}</dd>
            <dt>Sold</dt><dd>{dateTime(row.billed_at)} · {row.document_no} · {biz.exact(row.total)}</dd>
            <dt>Pharmacist</dt><dd>{row.pharmacist_name ? `${row.pharmacist_name} (${row.pharmacist_reg_no})` : "—"}</dd>
            <dt>Keep until</dt><dd>{dateShort(row.retain_until, { year: true })}</dd>
          </dl>
          <DataGrid id="pharmacy-prescription-lines" caption="Medicines sold" variant="compact" rows={row.lines} columns={[
            { key: "label", header: "Medicine", value: (l) => l.label, mobile: "title" },
            { key: "schedule", header: "Schedule", value: (l) => l.schedule || "", render: (l) => <ScheduleBadge schedule={l.schedule} /> },
            { key: "qty", header: "Quantity", value: (l) => (l.entered_unit ? `${Number(l.entered_quantity)} ${l.entered_unit}` : quantity(l.quantity, l.unit)) },
            { key: "batch", header: "Batch", value: (l) => l.lot_code, className: "mono" },
          ]} />
        </div>
      )}
    </SidePanel>
  );
}
