import Icon from "../../../../components/Icon";
import { isoToday, occasionsOf } from "./occasions";
import "../../../../styles/backoffice-sweep.css";

// A guest's occasion this week (sweep SW-B-21): "Anniversary today",
// "Birthday Sat". Shown wherever staff meet the guest — the guest's card and
// the till's guest box — so the floor can wish them, or send a dessert with a
// candle. Today means the restaurant's open business day (pass it as
// `today`, YYYY-MM-DD); left out, it is the calendar date.
export default function GuestOccasion({ guest, today }) {
  const occasions = occasionsOf(guest, today || isoToday());

  if (occasions.length === 0) {
    return null;
  }

  return (
    <span className="bo-occasions">
      {occasions.map((occasion) => (
        <span key={occasion.kind} className={`bo-occasion ${occasion.days === 0 ? "is-today" : ""}`}>
          <Icon name={occasion.kind === "anniversary" ? "sparkles" : "gift"} size={12} />
          {occasion.label}
        </span>
      ))}
    </span>
  );
}
