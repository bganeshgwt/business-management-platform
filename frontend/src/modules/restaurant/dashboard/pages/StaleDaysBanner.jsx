import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Icon from "../../../../components/Icon";
import CloseDayDialog from "../../business-day/pages/CloseDayDialog";
import { getBusinessDay } from "../../business-day/services/businessDay.service";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import { count, dateShort, money } from "../../../../services/format";
import { refreshDashboard } from "./panels/panelData";

// A counter (the main counter or an outlet with its own day) whose business
// day is older than today was left open: every bill since has gone on that
// old day, and the dashboard's "today" adds it in. Said in red at the top,
// with Close day for each counter for someone who may close a day — the
// same close (cash count, card and UPI ticks, the manager's PIN) as the
// Business day screen.
//
// A day is closed for the counter the till is working in (the outlet chosen
// at the top), so closing another counter's day switches the till to it
// first and comes back here with the close open (?closeDay=<day id>).

const daysBetween = (from, to) =>
  Math.max(0, Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000));

const SHOWN = 3;

export default function StaleDaysBanner({ data, user, hasPermission, currency, canSeeSales }) {
  const [params, setParams] = useSearchParams();
  const [closing, setClosing] = useState(null);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [done, setDone] = useState("");
  const arrived = useRef(false);
  const canClose = hasPermission("business_day.close");
  const today = data.tradingToday;
  const stale = today ? (data.openDays || []).filter((day) => day.businessDate && day.businessDate < today) : [];
  // The counter this till works in now: an outlet, or the main counter.
  const here = outletStorage.get() ? Number(outletStorage.get()) : user.outletId ? Number(user.outletId) : null;
  const isHere = (day) => (day.outletId || null) === (data.outletId || here || null);
  // Someone tied to one outlet closes only their own counter's day.
  const mayClose = (day) => canClose && (!user.outletId || Number(user.outletId) === Number(day.outletId));

  const openClose = (day) => {
    setError("");

    if (!isHere(day)) {
      outletStorage.set(day.outletId || null);
      window.location.assign(`/?closeDay=${day.businessDayId}`);
      return;
    }

    getBusinessDay()
      .then((status) => {
        if (status && status.current && Number(status.current.id) === Number(day.businessDayId)) {
          setClosing(status.current);
        } else {
          setError("That day is no longer open here. The dashboard has been refreshed.");
          refreshDashboard();
        }
      })
      .catch((err) => setError(getErrorMessage(err)));
  };

  // Back from switching counters: the close it was asked for, once.
  useEffect(() => {
    const wanted = params.get("closeDay");

    if (!wanted || arrived.current) {
      return;
    }

    arrived.current = true;
    const next = new URLSearchParams(params);
    next.delete("closeDay");
    setParams(next, { replace: true });
    const day = stale.find((one) => Number(one.businessDayId) === Number(wanted));

    if (day && mayClose(day)) {
      openClose(day);
    }
    // Only once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  if (stale.length === 0 && !done) {
    return null;
  }

  const oldest = stale.reduce((first, day) => (!first || day.businessDate < first.businessDate ? day : first), null);
  const shown = showAll ? stale : stale.slice(0, SHOWN);

  return (
    <>
      {done && (
        <div className="alert alert-success" role="status">
          <span>{done}</span>
          <button type="button" className="link-button small" onClick={() => setDone("")} style={{ marginLeft: "auto" }}>
            Dismiss
          </button>
        </div>
      )}
      {stale.length > 0 && (
        <section className="dash-oldday" role="alert" aria-labelledby="dash-oldday-title">
          <div className="dash-oldday-head">
            <span className="dash-oldday-icon" aria-hidden="true">
              <Icon name="alert" size={20} />
            </span>
            <div>
              <h2 id="dash-oldday-title">
                {stale.length === 1
                  ? `${oldest.label} has been open since ${dateShort(oldest.businessDate)}`
                  : `${count(stale.length)} counters were left open from earlier days`}
              </h2>
              <p>
                {stale.length === 1
                  ? `${daysBetween(oldest.businessDate, today)} days ago. `
                  : `The oldest, ${oldest.label}, since ${dateShort(oldest.businessDate)}. `}
                Every bill since has gone on that old day. Close it so today&apos;s sales, cash and reports start fresh
                {canClose ? "." : " — ask a manager to close it."}
              </p>
            </div>
          </div>
          {error && <p className="dash-oldday-error">{error}</p>}
          <ul className="dash-oldday-list">
            {shown.map((day) => (
              <li key={day.businessDayId}>
                <span className="dash-oldday-name">
                  <strong>{day.label}</strong>
                  <span className="muted small">
                    since {dateShort(day.businessDate)}
                    {canSeeSales && day.billCount > 0
                      ? ` · ${count(day.billCount)} bills, ${money(day.netSales, currency)}`
                      : day.billCount > 0
                        ? ` · ${count(day.billCount)} bills`
                        : " · no bills"}
                  </span>
                </span>
                {mayClose(day) && (
                  <button type="button" className="button button-sm button-danger" onClick={() => openClose(day)}>
                    Close day
                  </button>
                )}
              </li>
            ))}
          </ul>
          {stale.length > SHOWN && (
            <button type="button" className="link-button small" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "Show fewer" : `Show all ${count(stale.length)} counters`}
            </button>
          )}
        </section>
      )}
      {closing && (
        <CloseDayDialog
          day={closing}
          currency={currency}
          onClose={() => setClosing(null)}
          onClosed={() => {
            setClosing(null);
            setDone(`The business day of ${dateShort(closing.businessDate)} is closed.`);
            refreshDashboard();
          }}
          onShowDrawers={() => window.location.assign("/business-day?tab=drawers")}
        />
      )}
    </>
  );
}
