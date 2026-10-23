import { count, moneyExact } from "@bmp/shared/format";
import LiveBlock, { Facts, Figures } from "./LiveBlock";
import { PanelLink } from "./panels/DashboardPanels";
import { floorCounts } from "./liveFormat";

// The stages a table goes through, in the floor plan's own words and hues
// (dashboard.css gives each the same token the floor plan uses), so a
// manager who knows one screen reads the other. Out of service is not on the
// bar: it is not capacity, and drawing it would shrink every other state.
const SEGMENTS = [
  { key: "running", label: "Eating" },
  { key: "printed", label: "Bill printed" },
  { key: "paid", label: "Paid, still seated" },
  { key: "reserved", label: "Held for a booking" },
  { key: "cleaning", label: "Being cleaned" },
  { key: "free", label: "Free" },
];

// The floor right now (tables.view): busy, free, held, being cleaned.
// The tables that need someone now, one line each with the action that
// opens the floor panel on them (where Take payment / Mark ready / Bill are).
const actionLines = (tables, outletId, currency, canSeeSales) => {
  const mine = outletId ? tables.filter((table) => table.outletId === outletId) : tables;
  const names = (list) =>
    list
      .slice(0, 3)
      .map((table) => table.tableNo)
      .join(", ") + (list.length > 3 ? ` +${list.length - 3}` : "");
  const toPay = mine.filter((table) => table.floorState === "printed");
  const cleaning = mine.filter((table) => table.floorState === "cleaning");
  const earlier = mine.filter((table) => table.live && table.live.earlierDay);
  const due = toPay.reduce((sum, table) => sum + Number((table.live && table.live.billDue) || 0), 0);

  return [
    earlier.length > 0 && {
      key: "earlier",
      tone: "danger",
      label: `Left open: ${names(earlier)}`,
      action: "Bill or cancel",
      panel: "floor.busy",
    },
    toPay.length > 0 && {
      key: "pay",
      tone: "warning",
      label: `To pay: ${names(toPay)}${canSeeSales && due > 0 ? ` · ${moneyExact(due, currency)}` : ""}`,
      action: "Take payment",
      panel: "floor.pay",
    },
    cleaning.length > 0 && {
      key: "cleaning",
      tone: "warning",
      label: `Cleaning: ${names(cleaning)}`,
      action: "Mark ready",
      panel: "floor.cleaning",
    },
  ].filter(Boolean);
};

export default function FloorBlock({ entry, outletId, currency = "₹", canSeeSales = false }) {
  return (
    <LiveBlock
      icon="table"
      tone="info"
      title="Floor"
      to="/tables"
      panel="floor.all"
      openLabel="Open the floor plan"
      entry={entry}
      summary={(tables) => {
        const floor = floorCounts(tables, outletId);

        if (floor.total === 0) {
          return outletId ? "No tables are set up at this outlet" : "No tables are set up yet";
        }

        return floor.inService === 0
          ? "Every table is out of service"
          : `${count(floor.busy)} of ${count(floor.inService)} tables in use`;
      }}
      alert={(tables) => {
        const floor = floorCounts(tables, outletId);

        return floor.inService > 0 && floor.free === 0 && floor.busy > 0 ? { tone: "warning", text: "Full" } : null;
      }}
    >
      {(tables) => {
        const floor = floorCounts(tables, outletId);

        if (floor.total === 0) {
          return (
            <p className="muted small dash-quiet">
              {outletId
                ? "Tables are given an outlet on the Tables screen; pick All outlets to see the whole floor."
                : "Add floors and tables on the Tables screen to see the room fill up here."}
            </p>
          );
        }

        return (
          <>
            <Figures
              items={[
                { label: "In use", value: count(floor.busy), of: `/${count(floor.inService)}`, panel: "floor.busy", to: "/tables" },
                { label: "Free", value: count(floor.free), panel: "floor.free", to: "/tables" },
                { label: "Held", title: "Held for a booking due soon", value: count(floor.reserved), panel: "floor.reserved", to: "/tables" },
                { label: "Cleaning", title: "Being cleaned after the last party", value: count(floor.cleaning), panel: "floor.cleaning", to: "/tables" },
              ]}
            />

            {SEGMENTS.some((segment) => segment.key !== "free" && floor[segment.key] > 0) && (
              <div className="dash-meter-wrap">
                <div
                  className="dash-meter"
                  role="img"
                  aria-label={SEGMENTS.map((segment) => `${segment.label} ${floor[segment.key]}`).join(", ")}
                >
                  {SEGMENTS.filter((segment) => floor[segment.key] > 0).map((segment) => (
                    <span
                      key={segment.key}
                      className={`dash-meter-part dash-state-${segment.key}`}
                      style={{ flexGrow: floor[segment.key] }}
                      title={`${segment.label}: ${floor[segment.key]}`}
                    />
                  ))}
                </div>
                <ul className="legend dash-legend">
                  {SEGMENTS.filter((segment) => floor[segment.key] > 0).map((segment) => (
                    <li key={segment.key} className={`legend-item dash-state-${segment.key}`}>
                      <span className="legend-swatch" aria-hidden="true" />
                      <span className="legend-label">{segment.label}</span>
                      <span className="legend-count">{count(floor[segment.key])}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {actionLines(tables, outletId, currency, canSeeSales).map((line) => (
              <div key={line.key} className={`dash-floor-line tone-${line.tone}`}>
                <span className="dash-floor-line-text">{line.label}</span>
                <PanelLink className="button button-sm button-secondary" to="/tables" panel={line.panel}>
                  {line.action}
                </PanelLink>
              </div>
            ))}

            <Facts
              items={[
                floor.busy > 0 && {
                  icon: "users",
                  label: "Guests at tables",
                  value: count(floor.guests),
                },
                floor.seats > 0 && {
                  icon: "layers",
                  label: "Seats in use",
                  value: `${count(floor.seatsBusy)} of ${count(floor.seats)}`,
                },
                floor.off > 0 && {
                  icon: "ban",
                  label: "Out of service (not counted)",
                  value: count(floor.off),
                },
              ]}
            />
          </>
        );
      }}
    </LiveBlock>
  );
}
