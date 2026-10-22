import { count } from "@bmp/shared/format";
import LiveBlock, { Facts, Figures } from "./LiveBlock";
import { clockTime } from "./liveFormat";

// Who is working (staff.clock), from the time clock: on duty, on a break,
// late for a rostered shift, still expected, and clock-outs nobody made.
export default function StaffBlock({ entry, scope }) {
  return (
    <LiveBlock
      icon="users"
      tone="info"
      title="Staff on duty"
      to="/staff/timeclock"
      panel={entry && entry.data && entry.data.counts.late > 0 ? "staff.late" : "staff.duty"}
      openLabel="Open the time clock"
      entry={entry}
      scope={scope}
      summary={(board) =>
        board.counts.rostered > 0
          ? `${count(board.counts.rostered)} on the roster today`
          : "Nobody is rostered today"
      }
      alert={(board) =>
        board.counts.late > 0 ? { tone: "warning", text: `${count(board.counts.late)} late` } : null
      }
    >
      {(board) => {
        const { counts } = board;
        const missed = (board.missedClockOuts || []).length;

        return (
          <>
            <Figures
              items={[
                {
                  label: "On duty",
                  value: count(counts.onDuty),
                  note: counts.onBreak > 0 ? `${count(counts.onBreak)} on break` : undefined,
                  panel: "staff.duty",
                  to: "/staff/timeclock",
                },
                { label: "Late", title: "Past the start of their shift and not clocked in", value: count(counts.late), tone: "warning", alert: counts.late > 0, panel: "staff.late", to: "/staff/timeclock" },
                { label: "Expected", title: "Rostered and not in yet — the shift has not started", value: count(counts.expected), panel: "staff.expected", to: "/staff/timeclock" },
              ]}
            />
            <Facts
              items={[
                {
                  icon: "coffee",
                  label: "On a break",
                  value: count(counts.onBreak),
                },
                counts.nextStart && {
                  icon: "clock",
                  label: "Next shift starts",
                  value: clockTime(counts.nextStart, board.timezone),
                },
                {
                  icon: "alert",
                  label: "Clock-outs never made",
                  value: count(missed),
                  tone: missed > 0 ? "warning" : null,
                },
              ]}
            />
          </>
        );
      }}
    </LiveBlock>
  );
}
