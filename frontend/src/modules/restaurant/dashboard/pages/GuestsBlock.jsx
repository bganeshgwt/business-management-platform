import { PanelLink } from "./panels/DashboardPanels";
import { count } from "../../../../services/format";
import { plural } from "../../reports/pages/reportFormat";
import LiveBlock, { Figures } from "./LiveBlock";

const SHOW_GUESTS = 3;

const isRegular = (entry) => (entry.guest.tags || []).includes("regulars");
const birthdayToday = (guest) => Boolean(guest && guest.birthday && guest.birthday.inDays === 0);

// Known guests in the house (customers.view): who is seated right now that
// the restaurant knows — regulars first, because they are the ones to greet
// by name — and whose birthday it is today.
//
// `entry` is the guest-insights summary; `birthdays` the birthday list, read
// separately because the summary only counts the week, not the day.
export default function GuestsBlock({ entry, birthdays, scope }) {
  const birthdayRows = birthdays && birthdays.data ? birthdays.data.items : null;
  const todayCount = birthdayRows ? birthdayRows.filter(birthdayToday).length : null;

  return (
    <LiveBlock
      icon="heart"
      tone="danger"
      title="Guests"
      to="/crm/insights"
      panel="guests"
      openLabel="Open guest insights"
      entry={entry}
      scope={scope}
      summary={(insights) =>
        insights.inHouse.length > 0
          ? `${plural(insights.inHouse.length, "known guest", "known guests")} seated now`
          : "No guests from the guest book seated right now"
      }
    >
      {(insights) => {
        const regulars = insights.inHouse.filter(isRegular);
        const week = (insights.segments.find((segment) => segment.key === "birthdays") || { count: 0 }).count;
        const shown = [...regulars, ...insights.inHouse.filter((one) => !isRegular(one))].slice(0, SHOW_GUESTS);

        return (
          <>
            <Figures
              items={[
                { label: "Regulars in now", value: count(regulars.length), of: `/${count(insights.inHouse.length)}`, panel: "guests", to: "/crm/insights" },
                {
                  label: "Birthdays today",
                  value: todayCount === null ? "—" : count(todayCount),
                  note: `${count(week)} this week`,
                  panel: "birthdays",
                  to: "/crm/insights",
                },
              ]}
            />

            {shown.length > 0 ? (
              <ul className="dash-guests">
                {shown.map((one) => (
                  <li key={one.orderId}>
                    <span className="dash-guest-mark" aria-hidden="true">
                      {String(one.guest.name || "?").trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="dash-guest-text">
                      <PanelLink to={`/crm/insights?guest=${one.guest.id}`} panel="guests" className="dash-guest-name">
                        {one.guest.name}
                      </PanelLink>
                      <span className="dash-guest-note">
                        {[
                          one.tableNo ? `Table ${one.tableNo}` : "Seated",
                          plural(one.guest.visits, "visit", "visits"),
                          one.favourite ? `usually ${one.favourite}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    {isRegular(one) && <span className="badge badge-success">Regular</span>}
                    {birthdayToday(one.guest) && <span className="badge badge-primary">Birthday</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small dash-quiet">
                Guests show here when their bill carries a mobile number from the guest book.
              </p>
            )}

            {insights.inHouse.length > shown.length && (
              <p className="muted small">
                and {plural(insights.inHouse.length - shown.length, "more guest", "more guests")} —{" "}
                <PanelLink to="/crm/insights" panel="guests">see all</PanelLink>
              </p>
            )}
          </>
        );
      }}
    </LiveBlock>
  );
}
