// Choosing tables for a booking.

import { useState } from "react";
import { Loading } from "../../../../components/Feedback";
import { timeLabel, toMinutes } from "./reservationFormat";

// ---------------------------------------------------------------- table picking

const FIT_TEXT = {
  free: "Free",
  clash: "Booked",
  small: "Too small",
  occupied: "In use",
  cleaning: "Cleaning",
  closed: "Closed",
};

export default function TablePicker({
  availability,
  loading,
  value,
  onChange,
  mode,
  allowNone,
  overrides,
  setOverrides,
  extraIds = [],
  onExtraChange,
}) {
  // "Join more tables" for a large party: further taps add or remove tables
  // to push together with the main one, instead of changing the main table.
  const [joining, setJoining] = useState(false);

  if (!availability) {
    return <Loading label={loading ? "Checking tables…" : "Pick a time to see free tables."} />;
  }

  const groups = [];
  // A table on a closed floor or in a closed section takes nobody (the POS
  // could not serve it): it is not offered at all, only counted.
  const offered = availability.tables.filter((table) => table.fit !== "closed");
  const closedCount = availability.tables.length - offered.length;

  for (const table of offered) {
    const key = `${table.floorName}${table.areaName ? ` · ${table.areaName}` : ""}`;
    let group = groups.find((item) => item.key === key);

    if (!group) {
      group = { key, tables: [] };
      groups.push(group);
    }

    group.tables.push(table);
  }

  const chosen = availability.tables.find((table) => String(table.id) === String(value));
  const extras = availability.tables.filter((table) => extraIds.includes(String(table.id)));
  const multi = Boolean(onExtraChange) && Boolean(chosen);
  const adding = multi && (joining || extras.length > 0);
  const together = chosen ? chosen.capacity + extras.reduce((sum, table) => sum + table.capacity, 0) : 0;
  const party = Number(availability.partySize) || 0;
  const pick = (table) => {
    if (adding && String(table.id) !== String(value)) {
      const id = String(table.id);
      onExtraChange(extraIds.includes(id) ? extraIds.filter((item) => item !== id) : [...extraIds, id]);
      return;
    }

    onChange(String(table.id));
  };
  // A table with guests on it right now is not free for a booking starting
  // now, even when nothing is booked on it: it is free only once they leave.
  const freeCount = availability.tables.filter((table) => table.fit === "free" && !table.inUse).length;
  const inUseCount = availability.tables.filter((table) => table.fit === "free" && table.inUse).length;

  return (
    <div className={`rsv-picker ${loading ? "rsv-stale" : ""}`}>
      <p className="rsv-picker-summary">
        <strong>{freeCount}</strong> of {offered.length} tables free{" "}
        {mode === "now"
          ? "right now"
          : `at ${timeLabel(toMinutes(availability.startTime))} – ${timeLabel(toMinutes(availability.endTime))}`}
        {availability.partySize ? ` for ${availability.partySize}` : ""}
        {inUseCount > 0 && (
          <span className="rsv-picker-inuse">
            {" "}
            · {inUseCount} more {inUseCount === 1 ? "has" : "have"} guests on {inUseCount === 1 ? "it" : "them"} now,
            free only if they leave in time
          </span>
        )}
        {closedCount > 0 && (
          <span className="rsv-picker-inuse">
            {" "}
            · {closedCount} on a closed floor or section, not offered
          </span>
        )}
      </p>

      {multi && (
        <div className={`rsv-join-bar ${adding ? "is-on" : ""}`}>
          {adding ? (
            <>
              <span>
                <strong>{[chosen, ...extras].map((table) => table.tableNo).join(" + ")}</strong> seat {together}
                {party ? ` for a party of ${party}` : ""}. Tap more tables to push together; tap one again to take it
                off.
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setJoining(false);
                  onExtraChange([]);
                }}
              >
                One table only
              </button>
            </>
          ) : (
            <>
              <span className="muted">Large party? Hold more tables together with {chosen.tableNo}.</span>
              <button type="button" className="link-button" onClick={() => setJoining(true)}>
                Join more tables
              </button>
            </>
          )}
        </div>
      )}

      {allowNone && !adding && (
        <button
          type="button"
          className={`rsv-pick rsv-pick-none ${!value ? "is-selected" : ""}`}
          onClick={() => {
            onChange("");
            onExtraChange?.([]);
          }}
        >
          <span className="rsv-pick-no">No table yet</span>
          <span className="rsv-pick-note">assign it later</span>
        </button>
      )}

      {groups.map((group) => (
        <div key={group.key} className="rsv-pick-group">
          <p className="rsv-pick-group-name">{group.key}</p>
          <div className="rsv-pick-grid">
            {group.tables.map((table) => {
              // A booking cannot be written over another; seating now may
              // knowingly borrow a table before its booking arrives.
              // A table still being cleaned after the last party is not
              // ready for anyone: mark it ready on the floor plan first.
              const blocked =
                table.fit === "occupied" ||
                table.fit === "cleaning" ||
                (mode !== "now" && table.fit === "clash");
              const selected = String(table.id) === String(value);
              const joined = extraIds.includes(String(table.id));

              return (
                <button
                  key={table.id}
                  type="button"
                  className={`rsv-pick fit-${table.fit} ${selected ? "is-selected" : ""} ${joined ? "is-joined" : ""}`}
                  disabled={blocked && !joined}
                  aria-pressed={adding ? selected || joined : undefined}
                  onClick={() => pick(table)}
                  title={
                    table.clash
                      ? `${table.clash.guestName} (${table.clash.partySize}) ${timeLabel(toMinutes(table.clash.startTime))}–${timeLabel(toMinutes(table.clash.endTime))}`
                      : undefined
                  }
                >
                  <span className="rsv-pick-no">{table.tableNo}</span>
                  <span className="rsv-pick-seats">{table.capacity} seats</span>
                  <span className="rsv-pick-note">
                    {selected && adding
                      ? "Main table"
                      : joined
                        ? `Joined to ${chosen.tableNo}`
                        : table.fit === "clash"
                      ? `${table.clash.guestName.split(" ")[0]} ${timeLabel(toMinutes(table.clash.startTime))}`
                      : table.fit === "occupied" && table.live
                        ? `${table.live.orderNumber}`
                        : table.fit === "cleaning" && table.cleaning
                          ? `Cleaning · ${table.cleaning.minutesLeft} min`
                          : adding && table.fit === "small"
                            ? "Free"
                            : FIT_TEXT[table.fit]}
                    {table.fit === "free" && table.inUse && " · in use now"}
                  </span>
                  {availability.suggestedTableId === table.id && <span className="rsv-pick-best">Best fit</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {adding && party > together && (
        <div className="rsv-override-block">
          <label className="checkbox rsv-override">
            <input
              type="checkbox"
              checked={overrides.capacity}
              onChange={(event) => setOverrides({ ...overrides, capacity: event.target.checked })}
            />
            Over capacity is fine — these tables seat {together} for {party}, we will add chairs
          </label>
          {overrides.capacity && (
            <label className="field">
              <span>How will the party fit? *</span>
              <input
                value={overrides.reason || ""}
                onChange={(event) => setOverrides({ ...overrides, reason: event.target.value })}
                maxLength={200}
                placeholder="Two high chairs at the end, kids on laps…"
              />
            </label>
          )}
        </div>
      )}
      {!adding && chosen && chosen.fit === "small" && (
        <label className="checkbox rsv-override">
          <input
            type="checkbox"
            checked={overrides.capacity}
            onChange={(event) => setOverrides({ ...overrides, capacity: event.target.checked })}
          />
          Over capacity is fine — table {chosen.tableNo} seats {chosen.capacity}, we will add chairs
        </label>
      )}
      {chosen && chosen.fit === "clash" && mode === "now" && (
        <label className="checkbox rsv-override is-warning">
          <input
            type="checkbox"
            checked={overrides.clash}
            onChange={(event) => setOverrides({ ...overrides, clash: event.target.checked })}
          />
          {chosen.tableNo} is booked for {chosen.clash.guestName} at {timeLabel(toMinutes(chosen.clash.startTime))}.
          Seat anyway — they will be done by then
        </label>
      )}
      {chosen && chosen.fit === "clash" && mode !== "now" && (
        <p className="alert">
          {chosen.tableNo} is already booked {timeLabel(toMinutes(chosen.clash.startTime))} –{" "}
          {timeLabel(toMinutes(chosen.clash.endTime))} for {chosen.clash.guestName}. Pick another table or time.
        </p>
      )}
    </div>
  );
}
