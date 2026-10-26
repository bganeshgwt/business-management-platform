import StatusBadge from "./StatusBadge";

// A small, quiet word beside a live screen's title: whether changes made on
// other devices appear here by themselves (hooks/useLiveRefresh.js).
//
//   <LiveIndicator status={live} />
//
// It never moves or flashes, and it says what the screen does meanwhile, so
// "Reconnecting" after a dropped Wi-Fi is not alarming.
const LOOKS = {
  live: { tone: "success", label: "Live", title: "Changes made on other screens appear here by themselves." },
  connecting: { tone: "neutral", label: "Connecting…", title: "Starting live updates." },
  reconnecting: {
    tone: "warning",
    label: "Reconnecting…",
    title: "Live updates are paused while the connection comes back; the screen catches up as soon as it does.",
  },
  off: { tone: "neutral", label: "Not live", title: "Live updates are not on for this screen: reopen it to read it again." },
};

export default function LiveIndicator({ status }) {
  const look = LOOKS[status] || LOOKS.connecting;

  return (
    <span className="live-indicator" title={look.title} data-live={status}>
      <StatusBadge tone={look.tone} label={look.label} />
    </span>
  );
}
