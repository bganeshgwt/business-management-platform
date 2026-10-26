import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import { printGuestRegister } from "./lodgingPrint";
import { atWords, dateWords, idWords, partyWords } from "./lodging";
import "../styles/lodging.css";

// The guest register: every occupant of the rooms between two dates, not only
// the one who booked, with the photo ID seen (of an Aadhaar card only the last
// four digits), nationality, address and phone, the room and party, where they
// came from and go next and why, and when they came and left; foreign
// nationals with their passport, visa or OCI card and Form-III acknowledgements.
// Printed for the local police format.

export default function GuestRegisterPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [range, setRange] = useState({ from: today, to: today });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!range.from || !range.to || range.to < range.from) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "lodging/register", range, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, range]);
  const set = (name) => (e) => setRange((r) => ({ ...r, [name]: e.target.value }));
  const period = data ? (data.from === data.to ? dateWords(data.from) : `${dateWords(data.from)} to ${dateWords(data.to)}`) : "";
  return (
    <div className="stack">
      <BusinessHeader icon="book" title="Guest register"
        description="Every occupant of the rooms between two dates, with the photo ID seen, for the local police. Foreign nationals with their Form-III acknowledgements."
        primary={<button type="button" className="button" disabled={!data} onClick={() => printGuestRegister(biz, data)}><Icon name="print" size={16} /> Print the register</button>} />
      <ErrorMessage message={error} />
      <SectionCard icon="calendar" title="Dates">
        <div className="form-grid bz-form">
          <Field label="From"><input type="date" required max={range.to || undefined} value={range.from} onChange={set("from")} /></Field>
          <Field label="To"><input type="date" required min={range.from || undefined} value={range.to} onChange={set("to")} /></Field>
        </div>
      </SectionCard>
      <SectionCard flush icon="users" title={period ? `Guests · ${period}` : "Guests"} description={data ? `${data.items.length} ${data.items.length === 1 ? "occupant" : "occupants"}` : undefined}>
        <DataGrid variant="compact" id="lodging-register" caption="Guest register" rows={data?.items || []} loading={!data && !error} rowKey={(g) => g.id} rowNoun={["occupant", "occupants"]}
          empty="No guests in these dates" emptyIcon="users" columns={[
            { key: "arrived", header: "Arrived", type: "datetime", value: (g) => g.arrived_at, mobile: "subtitle", render: (g) => atWords(g.arrived_at, biz, { today: false }) },
            { key: "name", header: "Name", value: (g) => g.full_name, mobile: "title", pin: true,
              render: (g) => <span className="bz-two-line"><span>{g.full_name}</span><small className="muted">{[g.child ? "child" : null, g.gender, g.age !== null && g.age !== undefined ? `${g.age} yrs` : null].filter(Boolean).join(" · ")}</small></span> },
            { key: "nationality", header: "Nationality", value: (g) => g.nationality },
            { key: "id", header: "Photo ID", value: (g) => idWords(g.id_kind, g.id_ref), mobile: "show",
              render: (g) => (g.foreigner ? <span className="bz-two-line"><span>{idWords(g.id_kind, g.id_ref)}</span><small className="muted">{g.visa_type} {g.visa_no}{g.next_destination ? ` · next: ${g.next_destination}` : ""}</small></span>
                : idWords(g.id_kind, g.id_ref) || <span className="muted">—</span>) },
            { key: "room", header: "Room", value: (g) => g.room_no || "", render: (g) => <span className="bz-two-line"><span>{g.room_no || "—"}</span><small className="muted">{g.stay_no} · {partyWords(g.adults, g.children)}</small></span> },
            { key: "contact", header: "Address and phone", value: (g) => [g.address, g.phone].filter(Boolean).join(" · "), defaultHidden: true },
            { key: "trip", header: "From, to, why", value: (g) => [g.arrived_from, g.going_to, g.purpose].filter(Boolean).join(" · "), defaultHidden: true },
            { key: "left", header: "Left", type: "datetime", value: (g) => g.departed_at, render: (g) => (g.departed_at ? atWords(g.departed_at, biz, { today: false }) : "In the house") },
            { key: "frro", header: "Form-III", value: (g) => [g.frro_arrival_ack, g.frro_departure_ack].filter(Boolean).join(" "),
              render: (g) => (g.foreigner ? [g.frro_arrival_ack ? `Arrival ${g.frro_arrival_ack}` : "Arrival to report", g.departed_at ? (g.frro_departure_ack ? `Departure ${g.frro_departure_ack}` : "Departure to report") : null].filter(Boolean).join(" · ") : "") },
          ]} />
      </SectionCard>
    </div>
  );
}
