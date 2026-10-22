// The waitlist.

import ActionMenu from "../../../../components/ActionMenu";
import { clockIn, minutesSince, timeLabel, waitText } from "./reservationFormat";
import { Glyph } from "./ReservationChips";

// ---------------------------------------------------------------- waitlist

export default function WaitlistPanel({ waitlist, timezone, now, canManage, canSeat, handlers, onAdd }) {
  const { waiting, recent, stats } = waitlist;
  // Still marked waiting hours after their quote ran out: not at the door any
  // more, just never ticked off. Listed with the day's earlier walk-ins so
  // the host can record what happened, without an alarm on every one.
  const unclosed = waitlist.unclosed || [];

  return (
    <section className="card rsv-waitlist" aria-label="Walk-in waitlist">
      <div className="rsv-waitlist-head">
        <div className="rsv-head-main">
          <span className="section-card-icon tone-warning" aria-hidden="true">
            <Glyph name="door" size={18} />
          </span>
          <div>
          <h2>
            Walk-in waitlist <span className="rsv-count is-strong">{waiting.length}</span>
          </h2>
          <p className="muted small">
            {stats.averageWaitMinutes === null
              ? "No walk-ins seated yet today."
              : `Today: average wait ${stats.averageWaitMinutes} min · ${stats.seatedToday} seated · ${stats.leftToday} walked away`}
          </p>
          </div>
        </div>
        {canManage && (
          <button type="button" className="button button-secondary rsv-small-button" onClick={onAdd}>
            <Glyph name="plus" size={14} /> Add walk-in
          </button>
        )}
      </div>

      {waiting.length === 0 ? (
        <div className="rsv-wait-empty">
          <Glyph name="door" size={26} />
          <div>
            <p>Nobody waiting at the door.</p>
            <p className="muted small">
              When the room is full, add walk-ins here with a quoted wait. The clock starts the moment
              they join, and the bell warns you when a promise is about to be broken.
            </p>
          </div>
        </div>
      ) : (
        <ol className="rsv-wait-list">
          {waiting.map((entry, index) => {
            const waited = minutesSince(entry.joinedAt, now);
            const share = entry.quotedMinutes > 0 ? waited / entry.quotedMinutes : 1;
            const state = share >= 1 ? "over" : share >= 0.8 ? "near" : "ok";
            const menu = [
              { label: "Edit", onClick: () => handlers.edit(entry) },
              { separator: true },
              { label: "Left without a table", onClick: () => handlers.left(entry), danger: true },
              { label: "Remove (added by mistake)", onClick: () => handlers.remove(entry) },
            ];

            return (
              <li key={entry.id} className={`rsv-wait is-${state}`}>
                <div className="rsv-wait-top">
                  <span className="rsv-wait-pos">{index + 1}</span>
                  <div className="rsv-wait-who">
                    <strong>{entry.guestName}</strong>
                    <span className="rsv-pill">
                      <Glyph name="users" size={12} /> {entry.partySize}
                    </span>
                    <span className="rsv-wait-line">
                      waiting {waited} min (quoted {entry.quotedMinutes})
                    </span>
                    {(entry.guestMobile || entry.notes) && (
                      <span className="muted small rsv-wait-notes">
                        {[entry.guestMobile, entry.notes].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                  <span className="rsv-wait-clock" title={`Joined ${minutesSince(entry.joinedAt, now)} min ago`}>
                    <strong>{waitText(waited)}</strong>
                    <small>{state === "over" ? `${waited - entry.quotedMinutes} over` : `of ${entry.quotedMinutes}`}</small>
                  </span>
                </div>
                <div className="rsv-wait-bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
                </div>
                {canManage && (
                  <div className="rsv-wait-actions">
                    {canSeat && (
                      <button type="button" className="button rsv-small-button" onClick={() => handlers.seat(entry)}>
                        Seat
                      </button>
                    )}
                    {entry.notifiedAt ? (
                      <span className="rsv-notified">
                        <Glyph name="bell" size={13} /> Told {minutesSince(entry.notifiedAt, now)} min ago
                      </span>
                    ) : (
                      <button type="button" className="chip-button" onClick={() => handlers.notify(entry)}>
                        <Glyph name="bell" size={13} /> Table ready
                      </button>
                    )}
                    <ActionMenu items={menu} label={`More for ${entry.guestName}`} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {(recent.length > 0 || unclosed.length > 0) && (
        <details className="rsv-wait-recent" open={unclosed.length > 0}>
          <summary>
            Earlier today · {recent.length + unclosed.length}
            {unclosed.length > 0 && (
              <span className="rsv-wait-unclosed-count">
                {unclosed.length} never closed
              </span>
            )}
          </summary>
          <ul>
            {unclosed.map((entry) => (
              <li key={entry.id} className="rsv-wait-unclosed">
                <span>
                  <strong>{entry.guestName}</strong> · {entry.partySize}
                </span>
                <span className="muted small">
                  joined {timeLabel(clockIn(timezone, Date.parse(entry.joinedAt)).minutes)}{" "}
                  · quoted {entry.quotedMinutes} min · never seated or closed
                </span>
                {canManage && (
                  <span className="rsv-wait-unclosed-actions">
                    <button type="button" className="link-button" onClick={() => handlers.left(entry)}>
                      Walked away
                    </button>
                    <button type="button" className="link-button" onClick={() => handlers.remove(entry)}>
                      Remove
                    </button>
                  </span>
                )}
              </li>
            ))}
            {recent.map((entry) => {
              const waited = Math.round((new Date(entry.resolvedAt) - new Date(entry.joinedAt)) / 60000);

              return (
                <li key={entry.id}>
                  <span>
                    <strong>{entry.guestName}</strong> · {entry.partySize}
                  </span>
                  <span className="muted small">
                    {entry.status === "seated"
                      ? `seated${entry.tableNo ? ` at ${entry.tableNo}` : ""} after ${waited} min`
                      : entry.status === "left"
                        ? `walked away after ${waited} min`
                        : "removed"}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
