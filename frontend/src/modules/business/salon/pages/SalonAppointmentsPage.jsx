import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessPath } from "../../../../services/businessNav";
import { dateShort } from "../../../../services/format";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { Badge, BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import ClientPanel from "./ClientPanel";
import { STATUS_WORDS, timeOfDay } from "./salon";
import "../styles/salon-pro.css";

// A salon's appointment history (pro pass F-13): every booking with its
// deposit, its bill or charge, and whether it was moved or a walk-in; by
// stylist, client and status. Opens on this month and the next 30 days.
export default function SalonAppointmentsPage() {
  const biz = useOpenBusiness();
  const tz = biz.business.timezone;
  const [params] = useSearchParams();
  const [staff, setStaff] = useState("");
  const [status, setStatus] = useState("");
  const [contact, setContact] = useState(() => params.get("contact") || "");
  const [docId, setDocId] = useState(null);
  const [card, setCard] = useState(null);
  const { options } = useOptions(["salon/staff?kind=staff", "contacts?kind=customer"]);
  const list = useServerList("salon/appointments", { gridId: "salon-appointment-history", period: "ahead",
    params: { ...(staff ? { staff } : {}), ...(status ? { status } : {}), ...(contact ? { contact } : {}) } });
  const clients = options?.["contacts?kind=customer"] || [];
  const columns = useMemo(() => [
    { key: "starts_at", header: "When", type: "datetime", value: (a) => a.starts_at, mobile: "subtitle",
      render: (a) => `${dateShort(a.starts_at)}, ${timeOfDay(a.starts_at, tz)}` },
    { key: "contact_name", header: "Client", value: (a) => a.contact_name, mobile: "title", pin: true,
      render: (a) => <button type="button" className="link-button bz-link-left" onClick={() => setCard(a.contact_id)}>{a.contact_name}</button> },
    { key: "service_name", header: "Service", value: (a) => a.service_name, mobile: "show" },
    { key: "resource_name", header: "Stylist", value: (a) => a.resource_name, mobile: "show" },
    { key: "deposit_amount", header: "Deposit", type: "money", exact: true, value: (a) => (a.deposit_amount === null ? null : Number(a.deposit_amount)), total: "sum" },
    { key: "paper", header: "Bill / charge", value: (a) => a.bill_no || a.fee_no || "",
      render: (a) => (a.bill_no ? <button type="button" className="link-button" onClick={() => setDocId(a.bill_document_id)}>Bill {a.bill_no} · {biz.exact(a.bill_total)}</button>
        : a.fee_no ? <button type="button" className="link-button" onClick={() => setDocId(a.fee_document_id)}>Charge {a.fee_no} · {biz.exact(a.fee_total)}</button> : "—") },
    { key: "status", header: "Status", type: "status", value: (a) => a.status, mobile: "show",
      render: (a) => <Badge status={a.status} label={`${STATUS_WORDS[a.status]}${a.walk_in ? " · walk-in" : ""}`} /> },
    { key: "moved_count", header: "Moved", type: "number", value: (a) => Number(a.moved_count), defaultHidden: true },
    { key: "open", header: "", label: "Open", type: "actions",
      render: (a) => <Link className="chip-button" to={`${businessPath(biz.id, "salon-calendar")}?date=${new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(a.starts_at))}`}>Calendar</Link> },
  ], [biz, tz]);
  return (
    <div className="stack">
      <BusinessHeader icon="calendar" title="Appointment history"
        description="Every booking with its deposit, bill or no-show charge. Click a client for their card." />
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="list" title="Bookings">
        <DataGrid {...list.gridProps} caption="Appointment history" columns={columns} currency={biz.symbol} rowNoun={["booking", "bookings"]}
          exportName={biz.can("appointments.view") ? `${biz.business.code}-appointments` : undefined}
          rowClassName={(a) => (a.status === "cancelled" ? "dg-tone-muted" : a.status === "no_show" ? "dg-tone-warning" : "")}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field"><span>Stylist</span>
                <select value={staff} onChange={(e) => setStaff(e.target.value)}>
                  <option value="">Everyone</option>
                  {(options?.["salon/staff?kind=staff"] || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Client</span>
                <select value={contact} onChange={(e) => setContact(e.target.value)}>
                  <option value="">Every client</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="field"><span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Any</option>
                  {Object.entries(STATUS_WORDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </>
          )}
          empty="No bookings in these dates" emptyIcon="calendar" />
      </SectionCard>
      {docId && <DocumentDetail documentId={docId} onClose={() => setDocId(null)} onChanged={list.reload} />}
      <ClientPanel contactId={card} onClose={() => setCard(null)} />
    </div>
  );
}
