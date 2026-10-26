import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { Segmented } from "../../fashion/pages/shared";
import { FormIIIDialog } from "./LodgingDialogs";
import { FORM_III_NOTE, atWords, countdownWords, dateWords } from "./lodging";
import "../styles/lodging.css";

// Foreign guests (Form-III): every foreign national who stays, an OCI
// cardholder too, with the two reports each is due — within 24 hours of the
// check-in and of the check-out — counting down on the property's clock, and
// the acknowledgement number of each report made. Reports are made on the
// portal (web-only); here they are marked made. Overdue ones come first.

export default function ForeignGuestsPage() {
  const biz = useOpenBusiness();
  const [view, setView] = useState("open");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [dialog, setDialog] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "lodging/form-iii", { view }, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, view, version]);
  const report = (g, event) => {
    const ack = event === "arrival" ? g.frro_arrival_ack : g.frro_departure_ack;
    if (ack) return <span className="bz-two-line"><span className="ldg-done">Reported · {ack}</span><small className="muted">{atWords(event === "arrival" ? g.frro_arrival_at : g.frro_departure_at, biz)} · {event === "arrival" ? g.frro_arrival_by_name : g.frro_departure_by_name}</small></span>;
    if (event === "departure" && !g.departed_at) return <span className="muted">After the check-out</span>;
    const dueAt = event === "arrival" ? g.arrival_due_at : g.departure_due_at;
    const minutes = Math.round((new Date(dueAt) - new Date(data.now)) / 60000);
    return (
      <span className="bz-two-line">
        <span className={minutes < 0 ? "ldg-overdue" : "ldg-due"}>{countdownWords(minutes)}</span>
        <small className="muted">by {atWords(dueAt, biz)}</small>
        <button type="button" className="link-button" onClick={() => setDialog({ guest: g, event })}>Mark reported</button>
      </span>
    );
  };
  return (
    <div className="stack">
      <BusinessHeader icon="users" title="Foreign guests (Form-III)" description={FORM_III_NOTE} />
      <ErrorMessage message={error} />
      <SectionCard flush icon="users" title={view === "open" ? "To report" : "The last 90 days"}
        description={data ? `${data.counts.open} to report${data.counts.overdue ? ` · ${data.counts.overdue} overdue` : ""}` : undefined}
        actions={<Segmented label="Show" options={[{ value: "open", label: "To report" }, { value: "all", label: "The last 90 days" }]} value={view} onChange={setView} />}>
        <DataGrid variant="compact" id="lodging-form-iii" caption="Form-III reports" rows={data?.items || []} loading={!data && !error} rowKey={(g) => g.id} rowNoun={["guest", "guests"]}
          rowClassName={(g) => (g.overdue ? "dg-tone-danger" : "")}
          empty={view === "open" ? "Nothing to report" : "No foreign guests in the last 90 days"} emptyIcon="users" columns={[
            { key: "name", header: "Guest", value: (g) => g.full_name, mobile: "title", pin: true,
              render: (g) => <span className="bz-two-line"><span>{g.full_name}</span><small className="muted">{g.nationality}{g.child ? " · child" : ""}</small></span> },
            { key: "papers", header: "Passport and visa", value: (g) => `${g.id_ref || ""} ${g.visa_type || ""} ${g.visa_no || ""}`,
              render: (g) => <span className="bz-two-line"><span className="mono">{g.id_ref}</span><small className="muted">{g.visa_type} {g.visa_no}{g.arrived_india_on ? ` · in India from ${dateWords(g.arrived_india_on)}` : ""}</small></span> },
            { key: "stay", header: "Stay", value: (g) => g.stay_no, render: (g) => <span className="bz-two-line"><Link to={biz.path(`lodging-stays/${g.stay_id}`)} className="mono">{g.stay_no}</Link>
              <small className="muted">{g.room_no ? `room ${g.room_no}` : ""}{g.next_destination ? ` · next: ${g.next_destination}` : ""}</small></span> },
            { key: "arrived", header: "Arrived", type: "datetime", value: (g) => g.arrived_at, render: (g) => atWords(g.arrived_at, biz) },
            { key: "arrival", header: "Arrival report", value: (g) => g.frro_arrival_ack || "", mobile: "show", render: (g) => report(g, "arrival") },
            { key: "departure", header: "Departure report", value: (g) => g.frro_departure_ack || "", mobile: "show", render: (g) => report(g, "departure") },
          ]} />
      </SectionCard>
      {dialog && <FormIIIDialog guest={dialog.guest} event={dialog.event} onClose={() => setDialog(null)}
        onSaved={() => { setDialog(null); toast.success(`Form-III ${dialog.event} report of ${dialog.guest.full_name} marked made.`); setVersion((n) => n + 1); }} />}
    </div>
  );
}
