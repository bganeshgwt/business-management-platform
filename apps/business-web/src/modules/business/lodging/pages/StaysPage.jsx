import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import { Badge, BusinessHeader, PeriodFilter } from "../../core/pages/ui";
import { useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { STAGES, dateWords, partyWords, wordOf, SOURCES } from "./lodging";
import "../styles/lodging.css";

// Every stay by its arrival (reservations ahead, guests in the house, stays
// that have ended): its guest, room, nights, where it stands and its money. A
// stay opens with its occupants, folio and history.

export default function StaysPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const list = useServerList("lodging/stays", { gridId: "lodging-stays", period: "ahead" });
  const money = biz.can("sales.view");
  const many = biz.locations.length > 1;
  const columns = useMemo(() => [
    { key: "stay_no", header: "Stay", value: (s) => s.stay_no, className: "mono", mobile: "title", pin: true },
    { key: "guest", header: "Guest", value: (s) => `${s.guest_name} ${s.guest_phone || ""}`, mobile: "show",
      render: (s) => <span className="bz-two-line"><span>{s.guest_name}</span><small className="muted">{[s.guest_phone, s.bill_to_name ? `billed to ${s.bill_to_name}` : null].filter(Boolean).join(" · ")}</small></span> },
    { key: "room", header: "Room", value: (s) => `${s.room_type} ${s.room_no || ""}`, mobile: "subtitle",
      render: (s) => <span className="bz-two-line"><span>{s.room_no ? `Room ${s.room_no}` : "No room yet"}</span><small className="muted">{s.room_type} · {partyWords(s.adults, s.children)}</small></span> },
    { key: "arrival", header: "Arrival", type: "date", value: (s) => s.arrival, render: (s) => dateWords(s.arrival) },
    { key: "departure", header: "Departure", type: "date", value: (s) => s.departure, render: (s) => <span className={s.stage === "overstay" ? "bz-minus" : ""}>{dateWords(s.departure)}</span> },
    { key: "nights", header: "Nights", type: "number", value: (s) => Number(s.nights) },
    { key: "stage", header: "Stage", type: "status", value: (s) => STAGES[s.stage]?.label || s.stage, mobile: "show",
      render: (s) => <Badge tone={STAGES[s.stage]?.tone} label={STAGES[s.stage]?.label || s.stage} />,
      filter: "select", filterOptions: Object.values(STAGES).map((x) => ({ value: x.label, label: x.label })) },
    { key: "source", header: "Booked by", value: (s) => (s.source === "ota" ? `${s.ota_name} ${s.ota_booking_id}` : wordOf(SOURCES, s.source)), defaultHidden: true },
    money && { key: "estimate_total", header: "Room nights", type: "money", exact: true, value: (s) => (s.estimate_total === null ? null : Number(s.estimate_total)), total: "sum" },
    money && { key: "held", header: "Held", type: "money", exact: true, value: (s) => (s.held === null ? null : Number(s.held)), total: "sum" },
    money && { key: "bill_due", header: "Due", type: "money", exact: true, value: (s) => (s.bill_due === null ? null : Number(s.bill_due)), total: "sum" },
    { key: "document_no", header: "Bill", value: (s) => s.document_no || "", className: "mono", defaultHidden: true },
    { key: "location", header: "Property", value: (s) => s.location_name, defaultHidden: !many },
  ].filter(Boolean), [money, many]);
  return (
    <div className="stack">
      <BusinessHeader icon="home" title="Stays" description="Every reservation and stay by its arrival date, with where it stands: reserved, in the house, checked out, cancelled or a no-show."
        primary={biz.can("lodging.create") && <Link className="button" to={biz.path("lodging-stays/new")}><Icon name="plus" size={16} /> New reservation</Link>} />
      <DataGrid {...list.gridProps} search={{ ...list.gridProps.search, placeholder: "Stay, guest, phone, room, company or OTA booking" }} caption="Stays" columns={columns}
        currency={biz.symbol} rowNoun={["stay", "stays"]} onRowClick={(s) => navigate(biz.path(`lodging-stays/${s.id}`))} toolbar={<PeriodFilter list={list} />}
        rowClassName={(s) => (s.stage === "overstay" || s.late_arrival ? "dg-tone-danger" : s.stage === "to_settle" ? "dg-tone-warning" : ["checked_out", "cancelled", "no_show"].includes(s.stage) ? "dg-tone-muted" : "")}
        exportName={biz.can("sales.export") ? `${biz.business.code}-stays` : undefined}
        empty="No stays arriving in these dates" emptyHint="Pick other dates." emptyIcon="calendar" />
    </div>
  );
}
