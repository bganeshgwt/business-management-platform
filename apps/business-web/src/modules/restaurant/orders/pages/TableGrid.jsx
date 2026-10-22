import { useState } from "react";
import { dateShort, moneyExact } from "@bmp/shared/format";
import { elapsed } from "@bmp/shared/dates";
import { describeTable, groupTables, tileWhy } from "../../../../services/floorTables";
import Icon from "@bmp/ui/Icon";

// What each colour on a tile means, in the words the tile itself uses. Only
// the states actually on the floor are listed, so a new waiter reads a short
// key, not a catalogue.
const LEGEND = [
  { state: "free", label: "Free" },
  { state: "running", label: "Eating" },
  { state: "printed", label: "Bill printed" },
  { state: "paid", label: "Paid" },
  { state: "joined", label: "Joined to another table" },
  { state: "held", label: "Held for a booking" },
  { state: "cleaning", label: "Being cleaned" },
  { state: "off", label: "Out of service" },
];

// The room as the till sees it: every table in service, grouped by floor and
// section, each saying at a glance what is happening there (free, eating for
// how long and how much, joined to another table, being cleaned, held for a
// booking). Used to choose a table for a new order, on the captain's phone
// as the first screen, and to choose where a party or some dishes move to.
//
//   choose(table, info)   a tap on a table that may be chosen
//   reasonOff(table, info) why a table may not be chosen here (null: it may)
//   myUserId              the signed-in person: a captain with a section today
//                         (SW-A-20) sees "My tables" first, and can show all
export default function TableGrid({ tables: allTables, joinedBy, now, currency, choose, reasonOff, selectedId, compact, myUserId = null }) {
  const [onlyMine, setOnlyMine] = useState(true);
  const mine = myUserId ? allTables.filter((table) => table.captain && table.captain.userId === myUserId) : [];
  const tables = mine.length > 0 && onlyMine ? mine : allTables;
  const groups = groupTables(tables);

  if (tables.length === 0) {
    return (
      <div className="pos-table-empty">
        <Icon name="table" size={22} />
        <p className="muted small">
          No tables are set up yet. Add them under Tables → Floor plan, then come back here.
        </p>
      </div>
    );
  }

  const onFloor = new Set(tables.map((table) => describeTable(table, joinedBy).state));
  const legend = LEGEND.filter((item) => onFloor.has(item.state));

  return (
    <div className={`pos-table-groups ${compact ? "is-compact" : ""}`}>
      {mine.length > 0 && (
        <div className="segmented pos-my-tables" role="radiogroup" aria-label="Which tables">
          <button
            type="button"
            role="radio"
            aria-checked={onlyMine}
            className={`segment ${onlyMine ? "is-active" : ""}`}
            onClick={() => setOnlyMine(true)}
          >
            My tables · {mine.length}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!onlyMine}
            className={`segment ${!onlyMine ? "is-active" : ""}`}
            onClick={() => setOnlyMine(false)}
          >
            All tables · {allTables.length}
          </button>
        </div>
      )}
      {legend.length > 1 && (
        <ul className="pos-table-legend" aria-label="What the colours mean">
          {legend.map((item) => (
            <li key={item.state}>
              <span className={`pos-table-dot pos-dot-${item.state}`} aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
      )}

      {groups.map((group) => (
        <section key={group.name} className="pos-table-group">
          <h3 className="pos-table-group-name">{group.name}</h3>
          <div className="pos-table-grid">
            {group.tables.map((table) => {
              const info = describeTable(table, joinedBy);
              const off = reasonOff ? reasonOff(table, info) : null;
              const why = tileWhy(off, info);
              const live = table.live;

              return (
                <button
                  type="button"
                  key={table.id}
                  className={`pos-table pos-table-${info.state} ${selectedId === table.id ? "is-selected" : ""}`}
                  onClick={() => choose(table, info)}
                  disabled={Boolean(off)}
                  title={off || (table.captain ? `Captain: ${table.captain.userName}` : undefined)}
                  aria-label={`Table ${table.tableNo}: ${info.label}${info.note ? `, ${info.note}` : ""}${off ? `. ${off}` : ""}`}
                >
                  <span className="pos-table-head">
                    <span className="pos-table-no">{table.tableNo}</span>
                    {selectedId === table.id ? (
                      <Icon name="check-circle" size={16} className="pos-table-picked" />
                    ) : (
                      <span className="pos-table-seats" aria-hidden="true">
                        <Icon name="users" size={12} />
                        {table.capacity}
                      </span>
                    )}
                  </span>
                  {live ? (
                    <>
                      <span className="pos-table-money">{moneyExact(live.orderTotal, currency)}</span>
                      <span className="pos-table-label">
                        <span className={`pos-table-dot pos-dot-${info.state}`} aria-hidden="true" />
                        {info.label}
                      </span>
                      {live.placedAt && (
                        <span className={`pos-table-note ${live.earlierDay ? "is-earlier" : ""}`}>
                          <Icon name={live.earlierDay ? "alert" : "clock"} size={11} />
                          {live.earlierDay ? `Open since ${dateShort(live.placedAt)}` : elapsed(live.placedAt, now)}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="pos-table-label">
                        <span className={`pos-table-dot pos-dot-${info.state}`} aria-hidden="true" />
                        {info.label}
                      </span>
                      {/* The seats are already in the tile's corner. */}
                      {info.note && info.note !== `${table.capacity} seats` && <span className="pos-table-note">{info.note}</span>}
                    </>
                  )}
                  {why && <span className="pos-table-why">{why}</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
