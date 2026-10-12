import { Link } from "react-router-dom";
import Icon from "../../../../components/Icon";
import { staleWords, useBusinessDayStatus } from "./staleDayStatus";
import { dateShort } from "../../../../services/format";
import useAuth from "../../../../hooks/useAuth";
import { dateText } from "./moneyText";
import "../styles/stale-day.css";

// A business day left open from an earlier date books every bill, expense,
// waste entry and stock movement since onto that old date. These two pieces
// say so wherever an entry is dated by the open day:
//
//   <StaleDayNotice />   a red banner (Business day, Expenses, Waste, Reports)
//                        with "Close <date> and open today" for someone who
//                        may close a day, else "ask a manager".
//   <BusinessDateChip /> the date a form's entry will go on, amber when the
//                        open day is not today's date.
//
// Both read GET /business-day (the till chosen at the top: the main counter
// or an outlet) unless the screen passes the status it already has. Without
// business_day.view they show nothing.

// status: the GET /business-day answer, when the screen has it already.
// onCloseDay: the Business day screen opens its own close; elsewhere the
// button goes there (?closeStale=1) and the close opens on arrival.
export function StaleDayNotice({ status: given, onCloseDay = null, className = "" }) {
  const { hasPermission } = useAuth();
  const status = useBusinessDayStatus(given);
  const stale = status && status.stale;

  if (!stale) {
    return null;
  }

  const counter = (status.counter && status.counter.name) || "The main counter";
  const mayClose = hasPermission("business_day.manage");
  const label = `Close ${dateShort(stale.businessDate)} and open today`;

  return (
    <section className={`stale-day ${className}`} role="alert" aria-labelledby="stale-day-title">
      <span className="stale-day-icon" aria-hidden="true">
        <Icon name="alert" size={20} />
      </span>
      <div className="stale-day-text">
        <h2 id="stale-day-title">
          {counter} is still on {dateText(stale.businessDate, { weekday: true, year: false })} ({staleWords(stale)} ago)
        </h2>
        <p>
          Every bill, expense, waste entry and cash count since has gone on that date, so today&apos;s day book, GST month and
          cash count are wrong until it is closed.
          {mayClose ? "" : " Ask a manager to close it."}
        </p>
      </div>
      {mayClose &&
        (onCloseDay ? (
          <button type="button" className="button button-danger stale-day-action" onClick={onCloseDay}>
            <Icon name="moon" size={16} /> {label}
          </button>
        ) : (
          <Link className="button button-danger stale-day-action" to="/business-day?closeStale=1">
            <Icon name="moon" size={16} /> {label}
          </Link>
        ))}
    </section>
  );
}

// The date an entry made now is filed under. prefix: "Goes on" by default.
export function BusinessDateChip({ status: given, prefix = "Goes on business day", className = "" }) {
  const status = useBusinessDayStatus(given);

  if (!status || !status.current) {
    return null;
  }

  const date = status.current.businessDate;
  const today = status.opening && status.opening.today;
  const old = Boolean(status.stale);

  return (
    <span className={`bday-chip ${old ? "is-old" : ""} ${className}`} title={old ? "The open business day is not today's date" : undefined}>
      <Icon name={old ? "alert" : "calendar"} size={14} />
      <span>
        {prefix} <strong>{dateText(date, { weekday: true, year: false })}</strong>
        {old && today ? ` (still open — today is ${dateShort(today)})` : ""}
      </span>
    </span>
  );
}
