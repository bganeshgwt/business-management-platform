import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, useOpenBusiness } from "../../core/pages/hooks";
import "../styles/lodging.css";

// Occupancy & revenue for dates on the business's calendar, at every property
// or one: the room nights available (each room from the day it was added, less
// its nights out of order) and sold (the nights posted), the room revenue (the
// nights' value before GST, after discounts, without meals and extras), and
// occupancy (sold ÷ available), ADR (revenue ÷ sold) and RevPAR (revenue ÷
// available); each property, each room type, each source (walk-in, phone, each
// OTA) and each rate plan, the last two against all the rooms available.

const pct = (x) => (x === null ? <span className="muted">—</span> : `${x}%`);

export default function LodgingReportsPage() {
  const biz = useOpenBusiness();
  const today = businessToday(biz.business.timezone);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [location, setLocation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!from || !to || to < from) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "lodging/reports", { from, to, location: location || undefined }, controller.signal).then((d) => { setData(d); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, from, to, location]);
  const many = biz.locations.length > 1;
  const exportName = (what) => `${biz.business.code}-${what}`;
  const columns = (label, { available = true } = {}) => [
    { key: "label", header: label, value: (r) => r.label, mobile: "title", pin: true },
    available && { key: "available", header: "Room nights available", type: "number", value: (r) => r.available },
    { key: "sold", header: "Sold", type: "number", value: (r) => r.sold, total: "sum", mobile: "show" },
    { key: "occupancy", header: "Occupancy", type: "number", value: (r) => r.occupancy, render: (r) => pct(r.occupancy), mobile: "subtitle" },
    { key: "revenue", header: "Room revenue", type: "money", exact: true, value: (r) => Number(r.revenue), total: "sum" },
    { key: "adr", header: "ADR", type: "money", exact: true, value: (r) => (r.adr === null ? null : Number(r.adr)) },
    { key: "revpar", header: "RevPAR", type: "money", exact: true, value: (r) => (r.revpar === null ? null : Number(r.revpar)) },
  ].filter(Boolean);
  const grid = (id, caption, rows, label, options) => (
    <DataGrid variant="compact" id={id} caption={caption} rows={rows} rowKey={(r) => r.key} currency={biz.symbol} rowNoun={["row", "rows"]} exportName={exportName(id)}
      columns={columns(label, options)} empty="Nothing in these dates" emptyIcon="chart" />
  );
  return (
    <div className="stack">
      <BusinessHeader icon="chart" title="Occupancy & revenue"
        description="Room nights sold against those available, the average daily rate (ADR) and the revenue per available room (RevPAR), for dates on the business's calendar. Room revenue is the nights' value before GST, without meals and extras." />
      <ErrorMessage message={error} />
      <SectionCard icon="calendar" title="Dates">
        <div className="ldg-when">
          <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          {many && <Field label="Property"><select value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">Every property</option>{biz.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
        </div>
      </SectionCard>
      {!data ? (!error && <Loading />) : (
        <>
          <div className="stat-grid">
            <StatTile icon="home" tone="primary" label="Occupancy" value={data.total.occupancy === null ? "—" : `${data.total.occupancy}%`}
              note={`${data.total.sold} of ${data.total.available} room nights${data.total.outOfOrder ? ` · ${data.total.outOfOrder} out of order` : ""}`} />
            <StatTile icon="money" tone="neutral" label="ADR" money={data.total.adr === null ? 0 : Number(data.total.adr)} note="room revenue ÷ nights sold" />
            <StatTile icon="chart" tone="neutral" label="RevPAR" money={data.total.revpar === null ? 0 : Number(data.total.revpar)} note="room revenue ÷ nights available" />
            <StatTile icon="receipt" tone="neutral" label="Room revenue" money={Number(data.total.revenue)} note="before GST" />
          </div>
          {many && !location && <SectionCard flush icon="store" title="By property">{grid("lodging-report-properties", "By property", data.properties, "Property")}</SectionCard>}
          <SectionCard flush icon="home" title="By room type">{grid("lodging-report-types", "By room type", data.byType, "Room type")}</SectionCard>
          <SectionCard flush icon="users" title="By source" description="Each against all the room nights available: its share of the house.">
            {grid("lodging-report-sources", "By source", data.bySource, "Booked by", { available: false })}</SectionCard>
          <SectionCard flush icon="receipt" title="By rate plan" description="Each against all the room nights available.">
            {grid("lodging-report-plans", "By rate plan", data.byPlan, "Rate plan", { available: false })}</SectionCard>
        </>
      )}
    </div>
  );
}
