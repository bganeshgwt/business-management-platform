import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/optical.css";

// The referral report: for each doctor who referred customers (as written on
// a prescription or a spectacle order), in the dates chosen, the
// prescriptions recorded for their referrals, the customers, the spectacle
// orders booked and delivered, and (for someone who sees sales) what those
// orders come to and what their bills came to.
export default function ReferralsPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!range.from || !range.to) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "optical/referrals", range, controller.signal)
      .then((r) => { setReport(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range]);
  const set = (name) => (e) => setRange((r) => ({ ...r, [name]: e.target.value }));
  const money = report?.money;
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Referrals"
        description="The doctors who send customers, as written on prescriptions and spectacle orders: their customers' eye tests, and the orders booked and delivered, in the dates chosen." />
      <ErrorMessage message={error} />
      <SectionCard icon="calendar" title="Dates">
        <div className="opt-setting">
          <Field label="From"><input type="date" max={range.to || today} value={range.from} onChange={set("from")} /></Field>
          <Field label="To"><input type="date" min={range.from} max={today} value={range.to} onChange={set("to")} /></Field>
        </div>
      </SectionCard>
      {!report && !error && <Loading />}
      {report && (
        <>
          <div className="stat-grid">
            <StatTile icon="users" label="Doctors" value={String(report.totals.doctors)} />
            <StatTile icon="eye" label="Prescriptions" value={String(report.totals.prescriptions + report.totals.contact_lens_prescriptions)}
              note={report.totals.contact_lens_prescriptions ? `${report.totals.contact_lens_prescriptions} for contact lenses` : undefined} />
            <StatTile icon="clipboard" label="Orders booked" value={String(report.totals.orders)} note={`${report.totals.delivered} delivered`} />
            {money && <StatTile icon="money" tone="primary" label="Orders come to" money={Number(report.totals.booked_value)} note={`${biz.exact(report.totals.billed)} billed`} />}
          </div>
          <SectionCard flush icon="list" title="By doctor">
            <DataGrid variant="compact" id="optical-referrals" caption="Referrals by doctor" rows={report.rows} rowKey={(r) => r.doctor} currency={biz.symbol} rowNoun={["doctor", "doctors"]}
              columns={[
                { key: "doctor", header: "Doctor", value: (r) => r.doctor, mobile: "title" },
                { key: "prescriptions", header: "Spectacle prescriptions", type: "number", value: (r) => r.prescriptions, total: "sum" },
                { key: "contact_lens_prescriptions", header: "Contact-lens prescriptions", type: "number", value: (r) => r.contact_lens_prescriptions, total: "sum" },
                { key: "customers", header: "Customers", type: "number", value: (r) => r.customers },
                { key: "orders", header: "Orders booked", type: "number", value: (r) => r.orders, total: "sum", mobile: "show" },
                { key: "delivered", header: "Delivered", type: "number", value: (r) => r.delivered, total: "sum" },
                money && { key: "booked_value", header: "Orders come to", type: "money", exact: true, value: (r) => Number(r.booked_value), total: "sum" },
                money && { key: "billed", header: "Billed", type: "money", exact: true, value: (r) => Number(r.billed), total: "sum", mobile: "show" },
              ].filter(Boolean)}
              empty="No referrals in these dates" emptyHint="Write the referring doctor on a prescription or a spectacle order." emptyIcon="users" />
          </SectionCard>
        </>
      )}
    </div>
  );
}
