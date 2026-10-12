// The reservations summary tiles.

import StatTile from "../../../../components/StatTile";
import { Glyph } from "./ReservationChips";

// ---------------------------------------------------------------- numbers

export default function SummaryTiles({ board, isToday, stale }) {
  const summary = board.summary;
  const stats = board.waitlist.stats;
  const noShowRate = summary.bookings > 0 ? Math.round((summary.noShows / summary.bookings) * 100) : 0;

  const tiles = [
    {
      key: "bookings",
      icon: "calendar",
      tone: "primary",
      value: summary.bookings,
      label: "Bookings",
      note:
        `${summary.confirmed} confirmed · ${summary.cancelled} cancelled` +
        (summary.requested > 0 ? ` · ${summary.requested} online ${summary.requested === 1 ? "request" : "requests"} waiting` : ""),
    },
    {
      key: "covers",
      icon: "users",
      tone: "info",
      value: summary.expectedCovers,
      label: "Expected covers",
      note: summary.toArrive > 0 ? `${summary.toArrive} parties still to arrive` : "everyone accounted for",
    },
    {
      key: "seated",
      icon: "check-circle",
      tone: "success",
      value: summary.seated,
      label: "Seated",
      note: `${summary.seatedCovers} covers · ${summary.seatedNow} at tables now`,
    },
    {
      key: "noshow",
      icon: "alert",
      value: summary.noShows,
      label: "No-shows",
      note: summary.noShows > 0 ? `${summary.noShowCovers} covers lost · ${noShowRate}% of bookings` : "none so far",
      tone: summary.noShows > 0 ? "danger" : "neutral",
    },
    {
      key: "waiting",
      icon: <Glyph name="door" size={18} />,
      value: stats.waitingNow,
      label: "Waiting now",
      note: stats.waitingNow > 0 ? `${stats.waitingCovers} covers · longest ${stats.longestMinutes} min` : "nobody at the door",
      tone: stats.waitingNow > 0 ? "warning" : "neutral",
      live: true,
    },
    {
      key: "wait",
      icon: "timer",
      tone: "violet",
      value: stats.averageWaitMinutes === null ? "—" : `${stats.averageWaitMinutes}m`,
      label: "Average wait today",
      note: `${stats.seatedToday} walk-ins seated · ${stats.leftToday} walked away`,
    },
  ];

  return (
    <div className={`stat-grid rsv-tiles ${stale ? "rsv-stale" : ""}`}>
      {tiles.map((tile) => (
        <StatTile
          key={tile.key}
          icon={tile.icon}
          tone={tile.tone}
          value={tile.value}
          label={
            <>
              {tile.label}
              {tile.live && !isToday && <span className="rsv-tile-live"> · right now</span>}
            </>
          }
          note={tile.note}
        />
      ))}
    </div>
  );
}
