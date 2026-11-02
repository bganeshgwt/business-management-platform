import { useState } from "react";
import Icon from "@bmp/ui/Icon";
import useAuth from "../hooks/useAuth";
import useOnline from "../hooks/useOnline";
import useOutbox from "../hooks/useOutbox";
import { outbox } from "../services/offline/outboxStore";
import { outboxSummary } from "../services/offline/outboxWords";
import { confirmAction } from "../services/confirm";
import SidePanel from "./SidePanel";
import StatusBadge from "./StatusBadge";
import "../styles/offline.css";

// The calm offline indicator in the top bar and the workspaces' headers
// (docs/ARCHITECTURE.md › The offline base): "Offline", "Offline · 3 waiting
// to send", "1 needs attention". Nothing shows while the device is online
// with nothing waiting. A tap opens the list of what waits and what the
// server refused, with its reason; each can be sent again, or discarded
// after a confirmation that says what is lost.
const timeOf = (at) => new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export default function OfflineBar({ className = "" }) {
  const { online, since } = useOnline();
  const box = useOutbox();
  const [open, setOpen] = useState(false);
  const summary = outboxSummary({ online, counts: box.counts, paused: box.paused });

  // Everything sent and back online: nothing to show, the list included
  // (closed here, so it does not open by itself next time).
  if (!summary) {
    if (open) setOpen(false);
    return null;
  }

  return (
    <>
      <button
        type="button"
        className={`offline-pill ${className}`.trim()}
        data-tone={summary.tone}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={online ? "What is waiting to reach the server" : `No connection to the server since ${timeOf(since)}`}
      >
        <span className="offline-dot" aria-hidden="true" />
        <span className="offline-pill-text">{summary.label}</span>
      </button>
      <OutboxPanel open={open} onClose={() => setOpen(false)} online={online} since={since} box={box} />
    </>
  );
}

function OutboxPanel({ open, onClose, online, since, box }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(null);

  const discard = async (item) => {
    const found = outbox.describe(item.id);
    const others = found?.dependents || [];
    const sure = await confirmAction({
      title: `Discard "${item.label}"?`,
      message: (
        <>
          <p>It has not reached the server, and discarding it loses it for good.</p>
          {item.shared && <p>It is a bill a customer was given: its number will be missing, and the manager is asked to say why. Send it again instead, once what it needs is put right.</p>}
          {others.length > 0 && (
            <p>
              {plural(others.length, "item waits", "items wait")} for it and will need attention:{" "}
              {others.map((each) => `"${each.label}"`).join(", ")}.
            </p>
          )}
        </>
      ),
      confirmLabel: "Discard it",
      cancelLabel: "Keep it",
    });

    if (sure) {
      await outbox.discard(item.id);
    }
  };

  const again = async (item) => {
    setBusy(item.id);

    try {
      await outbox.retry(item.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      icon="refresh"
      title="Waiting to send"
      count={box.counts.total || undefined}
      rule="Made on this device, not yet on the server. Each goes by itself when it can."
      footer={
        box.counts.total > 0 && (
          <button type="button" className="button" onClick={() => outbox.flush()} disabled={!online}>
            <Icon name="refresh" size={15} /> Send now
          </button>
        )
      }
    >
      <div className="outbox-state" role="status">
        <Icon name={online ? "check" : "alert"} size={16} />
        <span>
          {online
            ? box.paused === "signin"
              ? "Online. Sign in again and what is waiting goes at once."
              : "Online. What is waiting is being sent."
            : `Offline since ${timeOf(since)}. What is waiting goes as soon as the connection is back; nothing is lost.`}
        </span>
      </div>

      {!box.durable && (
        <p className="alert alert-notice">
          This browser is not keeping these on the device (a private window, or storage switched off): keep this page open until they are sent.
        </p>
      )}

      {box.items.length === 0 ? (
        <p className="outbox-empty">Nothing is waiting. Changes made on other devices show here when the connection is back.</p>
      ) : (
        <ul className="outbox-list">
          {box.items.map((item) => {
            // The device's own items (an offline till's bills) go with whoever is signed in.
            const theirs = user && !item.shared && String(item.userId) !== String(user.id);
            return (
              <li key={item.id} className="outbox-item" data-state={item.state}>
                <div className="outbox-item-head">
                  <span className="outbox-item-label">{item.label}</span>
                  <StatusBadge
                    tone={item.state === "attention" ? "danger" : item.state === "sending" ? "info" : "warning"}
                    label={item.state === "attention" ? "Needs attention" : item.state === "sending" ? "Sending" : "Waiting"}
                  />
                </div>
                <span className="outbox-item-meta">
                  Made {timeOf(item.createdAt)}
                  {item.userName ? ` by ${item.userName}` : ""}
                  {item.attempts > 0 ? ` · tried ${plural(item.attempts, "time", "times")}` : ""}
                </span>
                {(item.lastError || theirs) && (
                  <span className="outbox-item-why">
                    {theirs ? `Goes when ${item.userName || "the person who made it"} signs in on this device.` : item.lastError}
                  </span>
                )}
                {!theirs && (
                  <div className="outbox-item-actions">
                    <button type="button" className="button button-secondary button-sm" disabled={!online || item.state === "sending" || busy === item.id}
                      onClick={() => again(item)}>
                      <Icon name="refresh" size={14} /> {item.state === "attention" ? "Send again" : "Send now"}
                    </button>
                    <button type="button" className="button button-secondary button-sm" disabled={item.state === "sending"} onClick={() => discard(item)}>
                      <Icon name="trash" size={14} /> Discard…
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SidePanel>
  );
}
