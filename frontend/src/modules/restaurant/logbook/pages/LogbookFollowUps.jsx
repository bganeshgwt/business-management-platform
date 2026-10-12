import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import { getHandover } from "../services/logbook.service";
import useAuth from "../../../../hooks/useAuth";
import CategoryChip from "./CategoryChip";

// Open log book follow-ups, for the dashboard: each stays there until someone
// closes it in the log book. Renders nothing for someone who cannot read the
// log book, or when nothing is open — so it can sit on any page.
//
//   <LogbookFollowUps />
//
// `handover`, when given, is the answer already read by the caller (the
// dashboard reads it with its other live blocks in one request); the card
// then reads nothing itself. Leave it out and the card reads its own.
export default function LogbookFollowUps({ limit = 4, handover, onOpen }) {
  const { hasPermission } = useAuth();
  const allowed = hasPermission("logbook.view");
  const given = handover !== undefined;
  const [own, setData] = useState(null);
  const data = given ? handover : own;

  useEffect(() => {
    if (!allowed || given) {
      return;
    }

    getHandover()
      .then(setData)
      .catch(() => setData(null));
  }, [allowed, given]);

  if (!allowed || !data || (data.openCount === 0 && data.unread.length === 0)) {
    return null;
  }

  return (
    <SectionCard
      icon="book"
      tone="warning"
      title={data.openCount ? `Log book · ${data.openCount} follow-up${data.openCount === 1 ? "" : "s"} open` : "Log book"}
      description={data.unread.length ? `${data.unread.length} new since you were last here` : "Close each one in the log book once it is dealt with."}
      actions={
        <Link
          className="button button-secondary button-sm"
          to={data.unread.length ? "/logbook?handover=1" : "/logbook?open=1"}
          onClick={onOpen}
        >
          Open the log book <Icon name="arrow-right" size={14} />
        </Link>
      }
    >
      <ul className="asw-followups">
        {data.openFollowUps.slice(0, limit).map((entry) => (
          <li key={entry.id}>
            <CategoryChip category={entry.category} />
            <span className="asw-followup-text">{entry.body}</span>
            <span className="muted small">{entry.createdByName}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
