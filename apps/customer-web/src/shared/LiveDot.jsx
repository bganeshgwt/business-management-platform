import "./shared.css";

// The small mark that says a guest page follows what it shows by itself
// (useGuestLive's status). Calm on purpose: a steady dot, never blinking.
//   live         a green dot, "Live": changes arrive within a second or two
//   connecting   the same words, the dot not yet lit, so a page that connects
//                at once never flickers between two sentences
//   polling, paused
//                a grey dot, "Updates every few seconds": the stream is not
//                open, and the page reads on its own
//   off          nothing: nothing more can happen to what the page shows
export default function LiveDot({ status, className = "" }) {
  if (!status || status === "off") {
    return null;
  }

  const live = status === "live";
  const quiet = status === "polling" || status === "paused";

  return (
    <span
      className={`gs-live ${live ? "is-live" : quiet ? "is-quiet" : "is-connecting"} ${className}`}
      role="status"
      title={quiet ? "This page reads the latest news every few seconds" : "This page updates by itself"}
    >
      <span className="gs-live-dot" aria-hidden="true" />
      <span>{quiet ? "Updates every few seconds" : "Live"}</span>
    </span>
  );
}
