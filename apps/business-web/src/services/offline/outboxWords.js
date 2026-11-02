// What the offline indicator says (components/OfflineBar.jsx), from whether
// the server answers and what waits in the outbox: null when there is
// nothing to say. { tone: offline | attention | sending, label }.
export function outboxSummary({ online, counts, paused }) {
  const waiting = counts.waiting + counts.sending;

  if (!online) {
    return { tone: "offline", label: waiting ? `Offline · ${waiting} waiting to send` : "Offline" };
  }

  if (counts.attention) {
    return { tone: "attention", label: `${counts.attention} need${counts.attention === 1 ? "s" : ""} attention${waiting ? ` · ${waiting} waiting` : ""}` };
  }

  if (paused === "signin" && waiting) {
    return { tone: "offline", label: `${waiting} waiting for sign-in` };
  }

  return waiting ? { tone: "sending", label: `Sending ${waiting}…` } : null;
}
