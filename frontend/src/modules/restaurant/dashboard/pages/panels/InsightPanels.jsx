import { Link } from "react-router-dom";
import DataGrid from "../../../../../components/DataGrid/DataGrid";
import { getNotifications } from "../../../../../services/notification.service";
import { getGuestInsights, getGuestSegment } from "../../../crm/services/guestInsight.service";
import { listLogbook } from "../../../logbook/services/logbook.service";
import { count } from "../../../../../services/format";
import { plural } from "../../../reports/pages/reportFormat";
import { PanelFacts } from "./panelKit";
import { errorText, usePanelQuery } from "./panelData";

const badge = (label, tone) => (
  <span className={`badge badge-${tone} status-badge`}>
    <span className="badge-dot" aria-hidden="true" />
    {label}
  </span>
);

// ------------------------------------------------------------------ alerts

const SEVERITY = { critical: ["Critical", "danger"], warning: ["Warning", "warning"], info: ["Note", "info"] };

// The bell's alerts at one level (read ones included, as the chips count
// them). Each row's own link goes to the screen the alert is about.
export function AlertsPanel({ severity }) {
  const query = usePanelQuery("alerts", null, () => getNotifications());
  const answer = query.data || null;
  const rows = answer ? answer.items.filter((item) => !severity || item.severity === severity) : [];

  return (
    <>
      {answer && (
        <PanelFacts
          items={[
            { label: "Critical", value: count(answer.counts.critical || 0), tone: answer.counts.critical > 0 ? "danger" : null },
            { label: "Warnings", value: count(answer.counts.warning || 0), tone: answer.counts.warning > 0 ? "warning" : null },
            { label: "Notes", value: count(answer.counts.info || 0) },
            { label: "Unread", value: count(answer.unreadCount || 0) },
          ]}
        />
      )}
      <DataGrid
        id={`dash-panel-alerts-${severity || "all"}`}
        caption="Restaurant alerts"
        variant="compact"
        columns={[
          {
            key: "title",
            header: "Alert",
            value: (item) => item.title,
            mobile: "title",
            render: (item) => (
              <span className="panel-cell-stack">
                <strong style={{ fontWeight: item.read ? 500 : 700 }}>{item.title}</strong>
                {item.detail && <span className="muted">{item.detail}</span>}
              </span>
            ),
          },
          { key: "level", header: "Level", value: (item) => item.severity, render: (item) => badge(...(SEVERITY[item.severity] || [item.severity, "neutral"])), mobile: "subtitle" },
          { key: "at", header: "When", type: "datetime", value: (item) => item.at, mobile: "show" },
          {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (item) =>
              item.link ? (
                <Link className="button button-secondary button-sm" to={item.link}>
                  Go to it
                </Link>
              ) : null,
          },
        ]}
        rows={rows}
        rowKey={(item) => item.id}
        loading={!answer && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty="No alert at this level"
        emptyIcon="bell"
        rowNoun={["alert", "alerts"]}
      />
    </>
  );
}

// ------------------------------------------------------------------ guests

const isRegular = (entry) => (entry.guest.tags || []).includes("regulars");

// Known guests seated now (their bill carries a guest-book mobile), regulars
// first, the same list as the Guests card.
export function GuestsPanel({ ctx }) {
  const { currency, canSeeSales } = ctx;
  const query = usePanelQuery("guests", null, () => getGuestInsights());
  const insights = query.data || null;
  const rows = insights ? [...insights.inHouse.filter(isRegular), ...insights.inHouse.filter((one) => !isRegular(one))] : [];

  return (
    <>
      {insights && (
        <PanelFacts
          items={[
            { label: "Known guests in", value: count(insights.inHouse.length) },
            { label: "Regulars in", value: count(insights.inHouse.filter(isRegular).length) },
            { label: "Birthdays this week", value: count((insights.segments.find((segment) => segment.key === "birthdays") || { count: 0 }).count) },
          ]}
        />
      )}
      <DataGrid
        id="dash-panel-guests"
        caption="Known guests seated now"
        variant="compact"
        columns={[
          {
            key: "guest",
            header: "Guest",
            value: (one) => one.guest.name,
            mobile: "title",
            render: (one) => (
              <span className="panel-cell-stack">
                <strong>{one.guest.name}</strong>
                <span className="muted">{one.favourite ? `Usually ${one.favourite}` : plural(one.guest.visits, "visit", "visits")}</span>
              </span>
            ),
          },
          { key: "table", header: "Table", value: (one) => (one.tableNo ? `Table ${one.tableNo}` : "Seated"), mobile: "subtitle" },
          { key: "visits", header: "Visits", type: "number", value: (one) => one.guest.visits, mobile: "show" },
          canSeeSales && { key: "spend", header: "Spent so far", type: "money", value: (one) => one.guest.lifetimeSpend ?? null },
          {
            key: "tags",
            header: "",
            label: "Marks",
            value: (one) => (isRegular(one) ? "Regular" : ""),
            render: (one) => (
              <span className="panel-row-actions" style={{ justifyContent: "flex-start" }}>
                {isRegular(one) && badge("Regular", "success")}
                {one.guest.birthday && one.guest.birthday.inDays === 0 && badge("Birthday", "primary")}
              </span>
            ),
            mobile: "show",
          },
        ]}
        rows={rows}
        rowKey={(one) => one.orderId}
        loading={!insights && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty="No guest from the guest book is seated right now"
        emptyHint="Guests show here when their bill carries a mobile number from the guest book."
        emptyIcon="heart"
        currency={currency}
        rowNoun={["guest", "guests"]}
      />
    </>
  );
}

// Birthdays in the next seven days, soonest first; today's at the top.
export function BirthdaysPanel({ ctx }) {
  const { currency, canSeeSales } = ctx;
  const query = usePanelQuery("birthdays", null, () => getGuestSegment("birthdays", { limit: 50 }));
  const segment = query.data || null;

  return (
    <DataGrid
      id="dash-panel-birthdays"
      caption="Birthdays this week"
      variant="compact"
      columns={[
        { key: "guest", header: "Guest", value: (guest) => guest.name, mobile: "title" },
        {
          key: "when",
          header: "Birthday",
          value: (guest) => (guest.birthday ? guest.birthday.inDays : null),
          render: (guest) =>
            !guest.birthday
              ? "—"
              : guest.birthday.inDays === 0
                ? badge("Today", "primary")
                : guest.birthday.inDays === 1
                  ? "Tomorrow"
                  : `In ${guest.birthday.inDays} days`,
          mobile: "subtitle",
        },
        { key: "mobile", header: "Mobile", value: (guest) => guest.mobileMasked || guest.mobile || "", mobile: "show" },
        { key: "visits", header: "Visits", type: "number", value: (guest) => guest.visits, mobile: "show" },
        canSeeSales && { key: "spend", header: "Spent", type: "money", value: (guest) => guest.lifetimeSpend },
      ]}
      rows={segment ? segment.items : []}
      rowKey={(guest) => guest.id}
      defaultSort={{ key: "when", direction: "asc" }}
      loading={!segment && query.isLoading}
      error={errorText(query)}
      onRetry={() => query.refetch()}
      empty="No birthdays in the next seven days"
      emptyIcon="gift"
      currency={currency}
      rowNoun={["guest", "guests"]}
    />
  );
}

// ------------------------------------------------------------------ log book

// Log book entries marked for follow-up and not yet closed.
export function LogbookPanel() {
  const query = usePanelQuery("logbook", null, () => listLogbook({ open: 1, limit: 200 }));
  const page = query.data || null;

  return (
    <DataGrid
      id="dash-panel-logbook"
      caption="Open log book follow-ups"
      variant="compact"
      columns={[
        {
          key: "body",
          header: "Entry",
          value: (entry) => entry.body,
          mobile: "title",
          render: (entry) => <span style={{ whiteSpace: "pre-wrap" }}>{entry.body}</span>,
        },
        { key: "category", header: "About", value: (entry) => String(entry.category || "").replace(/_/g, " "), mobile: "subtitle" },
        { key: "by", header: "Written by", value: (entry) => entry.createdByName || "", mobile: "show" },
        { key: "at", header: "When", type: "datetime", value: (entry) => entry.createdAt, mobile: "show" },
        { key: "where", header: "Where", value: (entry) => [entry.outletName, entry.tableLabel].filter(Boolean).join(" · "), defaultHidden: true },
      ]}
      rows={page ? page.items : []}
      rowKey={(entry) => entry.id}
      loading={!page && query.isLoading}
      error={errorText(query)}
      onRetry={() => query.refetch()}
      empty="Every follow-up is closed"
      emptyIcon="book"
      rowNoun={["entry", "entries"]}
    />
  );
}

