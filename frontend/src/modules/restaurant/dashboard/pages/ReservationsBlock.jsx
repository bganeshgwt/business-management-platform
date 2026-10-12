import { count } from "../../../../services/format";
import { plural } from "../../reports/pages/reportFormat";
import LiveBlock, { Facts, Figures } from "./LiveBlock";
import { arrivingSoon, waitText } from "./liveFormat";

// Today's book (reservations.view): how many are coming, how many guests,
// who is due in the next hour, who is late, and the walk-in waitlist.
export default function ReservationsBlock({ entry }) {
  return (
    <LiveBlock
      icon="calendar"
      tone="violet"
      title="Reservations today"
      to="/reservations"
      panel={entry && entry.data && entry.data.summary.late > 0 ? "bookings.late" : "bookings.all"}
      openLabel="Open reservations"
      entry={entry}
      summary={(board) => {
        const { summary } = board;

        if (summary.bookings === 0) {
          return board.hours && !board.hours.isOpen ? "Closed today — no bookings" : "No bookings for today";
        }

        return `${count(summary.toArrive)} still to arrive · ${count(summary.seated)} seated`;
      }}
      alert={(board) =>
        board.summary.late > 0 ? { tone: "warning", text: `${count(board.summary.late)} late` } : null
      }
    >
      {(board) => {
        const { summary } = board;
        const waitlist = (board.waitlist && board.waitlist.stats) || { waitingNow: 0, waitingCovers: 0 };
        const soon = arrivingSoon(board);

        return (
          <>
            <Figures
              items={[
                { label: "Bookings", value: count(summary.bookings), panel: "bookings.all", to: "/reservations" },
                { label: "Guests", title: "Guests expected today", value: count(summary.expectedCovers), panel: "bookings.arriving", to: "/reservations" },
                {
                  label: "Next hour",
                  title: "Bookings due in the next hour",
                  value: count(soon.parties),
                  note: soon.parties > 0 ? plural(soon.covers, "guest", "guests") : undefined,
                },
              ]}
            />
            <Facts
              items={[
                {
                  icon: "clock",
                  label: "Running late",
                  value: count(summary.late),
                  tone: summary.late > 0 ? "warning" : null,
                },
                summary.missed > 0 && {
                  icon: "x-circle",
                  label: "Slot gone by, not marked",
                  value: count(summary.missed),
                  tone: "warning",
                },
                {
                  icon: "users",
                  label: "Waitlist",
                  value:
                    waitlist.waitingNow > 0
                      ? `${plural(waitlist.waitingNow, "party", "parties")} · ${plural(waitlist.waitingCovers, "guest", "guests")}`
                      : "Nobody waiting",
                },
                waitlist.waitingNow > 0 && {
                  icon: "timer",
                  label: "Longest wait so far",
                  value: waitText(waitlist.longestMinutes || 0),
                },
              ]}
            />
          </>
        );
      }}
    </LiveBlock>
  );
}
