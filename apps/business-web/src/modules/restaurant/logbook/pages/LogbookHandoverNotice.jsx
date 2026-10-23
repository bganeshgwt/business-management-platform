import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { getHandover, markLogbookRead } from "../services/logbook.service";
import { getErrorMessage } from "../../../../services/api";
import CategoryChip from "./CategoryChip";
import "../../../../styles/staff.css";

// Right after signing in (or taking over a till with a PIN), a manager is
// shown what the log book has that they have not read: the entries other
// people wrote since their last shift. They read them here and mark them
// read, or open the log book. The panel does not block the screen they land
// on, and it goes once they move to another screen or close it: the log
// book itself keeps "Since you were last here" for later.
//
// Mounted by AuthProvider, which is the one place that knows a sign-in has
// just happened; it draws nothing for people without logbook.view, or when
// nothing is unread.

const SHOWN = 3;

const firstLine = (text) => {
  const line = String(text || "").split("\n")[0];
  return line.length > 110 ? `${line.slice(0, 107)}…` : line;
};

export default function LogbookHandoverNotice() {
  const location = useLocation();

  // A sign-in starts on the sign-in screen and then lands on a page: the
  // panel starts there, so it knows which screen "moving on" is from.
  if (location.pathname === "/login") {
    return null;
  }

  return <HandoverPanel />;
}

function HandoverPanel() {
  const location = useLocation();
  // The screen the sign-in landed on.
  const [landedOn] = useState(() => location.pathname);
  const [handover, setHandover] = useState(null);
  const [closed, setClosed] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;

    getHandover()
      .then((result) => {
        if (live) {
          setHandover(result);
        }
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, []);

  // Moving on to another screen means the moment has passed.
  const movedOn = location.pathname !== landedOn;

  if (closed || movedOn || location.pathname.startsWith("/logbook")) {
    return null;
  }

  if (!handover || (!done && handover.unread.length === 0)) {
    return null;
  }

  const markAllRead = async () => {
    setError("");

    try {
      await markLogbookRead(handover.unread.map((entry) => entry.id));
      setDone(true);
      window.setTimeout(() => setClosed(true), 1600);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const unread = handover.unread;

  return (
    <aside className="staff-handover-notice" role="status" aria-label="Log book handover" data-motion-item>
      <div className="staff-handover-notice-head">
        <span className="staff-handover-notice-icon" aria-hidden="true">
          <Icon name="book" size={18} />
        </span>
        <div>
          <strong>{done ? "All read" : `Log book · ${unread.length} new since you were last here`}</strong>
          <span className="muted small">
            {done ? "Have a good shift." : "Read what the last shift handed over before you start."}
          </span>
        </div>
        <button type="button" className="icon-button" aria-label="Close the log book handover" onClick={() => setClosed(true)}>
          <Icon name="x" size={16} />
        </button>
      </div>

      {!done && (
        <>
          <ul className="staff-handover-notice-list">
            {unread.slice(0, SHOWN).map((entry) => (
              <li key={entry.id}>
                <CategoryChip category={entry.category} />
                <span className="staff-handover-notice-text">
                  {firstLine(entry.body)}
                  <span className="muted small"> · {entry.createdByName}</span>
                </span>
              </li>
            ))}
            {unread.length > SHOWN && <li className="muted small">…and {unread.length - SHOWN} more in the log book.</li>}
          </ul>
          {error && <p className="staff-handover-notice-error small">{error}</p>}
          <div className="staff-handover-notice-actions">
            <button type="button" className="button button-secondary button-sm" onClick={markAllRead}>
              <Icon name="check" size={15} /> Mark all read
            </button>
            <Link className="button button-sm" to="/logbook?handover=1" onClick={() => setClosed(true)}>
              Open log book <Icon name="arrow-right" size={15} />
            </Link>
          </div>
        </>
      )}
    </aside>
  );
}
