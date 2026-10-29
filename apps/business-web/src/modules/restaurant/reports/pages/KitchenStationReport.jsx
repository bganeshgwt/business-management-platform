// Kitchen stations tab of the Reports screen.

import { useMemo } from "react";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { count } from "@bmp/shared/format";
import { durationText, hourRange, hoursText } from "./kitchenReportWords";

// How each kitchen station did over the dates chosen: its tickets and dishes,
// how long a ticket took from sent to ready and from ready to served (the
// average, and the time nine tickets in ten beat), the tickets past the
// kitchen's late mark, and its busiest hours. The whole kitchen's figures are
// the tiles above; cancelled tickets are left out, and the note says how many.
export default function KitchenStationReport({ data }) {
  const total = data.total;
  const columns = useMemo(
    () => [
      { key: "station", header: "Station", value: (row) => row.stationName, mobile: "title", className: "report-strong", filter: "text" },
      { key: "tickets", header: "Tickets", type: "number", value: (row) => row.tickets, total: "sum", mobile: "show" },
      { key: "dishes", header: "Dishes", type: "number", value: (row) => row.dishes, total: "sum" },
      {
        key: "avgReady",
        header: "Sent to ready, average",
        type: "number",
        value: (row) => row.avgReadySeconds,
        render: (row) => durationText(row.avgReadySeconds),
        mobile: "show",
      },
      {
        key: "p90Ready",
        header: "Sent to ready, 9 in 10 within",
        type: "number",
        value: (row) => row.p90ReadySeconds,
        render: (row) => durationText(row.p90ReadySeconds),
      },
      {
        key: "avgServe",
        header: "Ready to served, average",
        type: "number",
        value: (row) => row.avgServeSeconds,
        render: (row) => durationText(row.avgServeSeconds),
        mobile: "show",
      },
      {
        key: "p90Serve",
        header: "Ready to served, 9 in 10 within",
        type: "number",
        value: (row) => row.p90ServeSeconds,
        render: (row) => durationText(row.p90ServeSeconds),
      },
      {
        key: "late",
        header: "Late",
        type: "number",
        value: (row) => row.late,
        total: "sum",
        render: (row) => <span className={row.late > 0 ? "text-danger" : ""}>{count(row.late)}</span>,
        mobile: "show",
      },
      { key: "cleared", header: "Cleared unserved", type: "number", value: (row) => row.cleared, total: "sum", defaultHidden: true },
      {
        key: "busiest",
        header: "Busiest hours",
        value: (row) => hoursText(row.busiestHours),
      },
    ],
    []
  );

  return (
    <div className="stack">
      {total && (
        <div className="stat-grid">
          <StatTile icon="chef" tone="primary" label="Tickets" value={count(total.tickets)} note={`${count(total.dishes)} dishes`} />
          <StatTile
            icon="clock"
            tone="info"
            label="Sent to ready"
            value={durationText(total.avgReadySeconds)}
            note={total.p90ReadySeconds === null ? "no ticket timed" : `9 in 10 within ${durationText(total.p90ReadySeconds)}`}
          />
          <StatTile
            icon="timer"
            label="Ready to served"
            value={durationText(total.avgServeSeconds)}
            note={total.p90ServeSeconds === null ? "no ticket waited at the pass" : `9 in 10 within ${durationText(total.p90ServeSeconds)}`}
          />
          <StatTile
            icon="alert"
            tone={total.late > 0 ? "danger" : "success"}
            label={`Late (over ${data.lateMinutes} min)`}
            value={count(total.late)}
            note={total.busiestHours.length > 0 ? `busiest ${hourRange(total.busiestHours[0].hour)}` : undefined}
          />
        </div>
      )}

      <SectionCard
        icon="chef"
        tone="info"
        title="Each station"
        description={`A ticket is late once it is not ready ${data.lateMinutes} minutes after it was sent (Kitchen settings). Ready to served counts the tickets that waited at the pass. ${
          data.cancelledLeftOut > 0
            ? `${count(data.cancelledLeftOut)} cancelled ${data.cancelledLeftOut === 1 ? "ticket is" : "tickets are"} left out.`
            : "Cancelled tickets are left out."
        }`}
        flush
      >
        <DataGrid
          id="report-kitchen-stations"
          caption="Kitchen stations"
          columns={columns}
          rows={data.stations}
          rowKey={(row) => row.stationId}
          empty="No kitchen ticket in this period."
          emptyHint="Tickets are counted on the business day they were sent, from the kitchen display's times."
          emptyIcon="chef"
          exportName="kitchen-stations"
          rowNoun={["station", "stations"]}
        />
      </SectionCard>

      {data.hours.length > 0 && (
        <SectionCard icon="clock" title="Tickets by hour" description="Every station's tickets, by the hour they were sent, on the restaurant's clock.">
          <ul className="report-hours">
            {data.hours.map((row) => (
              <li key={row.hour}>
                <span>{hourRange(row.hour)}</span>
                <strong>{count(row.tickets)}</strong>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
