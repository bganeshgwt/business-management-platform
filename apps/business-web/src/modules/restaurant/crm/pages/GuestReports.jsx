import { useEffect, useMemo, useState } from "react";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { ColumnChart } from "../../../../components/Charts";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import Pager from "./Pager";
import { getCustomerSales, getLoyaltyReport } from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money, moneyExact } from "@bmp/shared/format";
import { daysAgo, today } from "@bmp/shared/dates";
import { downloadCsv } from "../../../../services/csv";
import {
  customerSalesSheet,
  pointHoldersSheet,
  pointsByDaySheet,
  shortDate,
  tagLabel,
} from "../../../../services/guestBook";

const HOLDERS_PAGE = 10;

// Whole rupees for an average, as Guest insights shows it: ₹3,904 a visit,
// not ₹3,903.60 here and ₹3,904 there for the same guest.
const roundedMoney = (value, currency) => money(Math.round(Number(value || 0)), currency);

// Every day in the range, quiet ones as zero: a chart that skips the days
// nobody redeemed draws Monday next to Thursday as if they were neighbours.
const everyDay = (from, to, rows) => {
  const byDate = new Map(rows.map((row) => [String(row.date).slice(0, 10), row]));
  const days = [];
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);

  while (cursor <= end && days.length < 400) {
    const key = cursor.toLocaleDateString("en-CA");
    const row = byDate.get(key);
    days.push({
      label: shortDate(cursor),
      value: row ? row.redeemedValue : 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
};

// The heading over each half of the reports: an icon in its tone, the title
// and one line on what the half is for.
function ReportHead({ id, icon, tone, title, description, actions }) {
  return (
    <div className="crm-section-head">
      <span className={`crm-section-icon tone-${tone}`} aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <div className="crm-section-titles">
        <h2 id={id}>{title}</h2>
        <p className="muted small">{description}</p>
      </div>
      {actions}
    </div>
  );
}

// A small "CSV" button in a card's heading.
function CsvButton({ busy, onClick, label = "CSV" }) {
  return (
    <button type="button" className="button button-secondary button-sm" onClick={onClick} disabled={busy}>
      <Icon name="download" size={15} />
      {busy ? "Preparing…" : label}
    </button>
  );
}

// Points and guest sales, for the owner and the accountant: what the
// restaurant owes its guests in points (a liability on the books), how points
// moved day by day, who holds them, and which guests the takings came from.
export default function GuestReports({ currency, canSeePoints, canSeeSales, canExport }) {
  const [range, setRange] = useState(() => ({ from: daysAgo(29), to: today() }));
  const [holdersOffset, setHoldersOffset] = useState(0);
  const [loyalty, setLoyalty] = useState(null);
  const [loyaltyError, setLoyaltyError] = useState("");

  const [salesSort, setSalesSort] = useState({ key: "spend", ascending: false });
  const [salesOffset, setSalesOffset] = useState(0);
  // The rows-per-page this viewer chose last time, so the first request
  // already asks for it.
  const [salesLimit, setSalesLimit] = useState(() => rememberedPageSize("crm-guest-sales", 25));
  const [sales, setSales] = useState(null);
  const [salesError, setSalesError] = useState("");
  const [exporting, setExporting] = useState("");

  const ready = range.from && range.to && range.from <= range.to;

  useEffect(() => {
    if (!canSeePoints || !ready) {
      return;
    }

    getLoyaltyReport({ from: range.from, to: range.to, limit: HOLDERS_PAGE, offset: holdersOffset })
      .then((data) => {
        // Fewer holders than when the page was chosen: back to the last page.
        if (data.holders.items.length === 0 && data.holders.total > 0 && holdersOffset > 0) {
          setHoldersOffset(Math.floor((data.holders.total - 1) / HOLDERS_PAGE) * HOLDERS_PAGE);
          return;
        }

        setLoyalty(data);
        setLoyaltyError("");
      })
      .catch((err) => setLoyaltyError(getErrorMessage(err)));
  }, [canSeePoints, ready, range.from, range.to, holdersOffset]);

  useEffect(() => {
    if (!canSeeSales || !ready) {
      return;
    }

    getCustomerSales({
      from: range.from,
      to: range.to,
      sort: salesSort.key,
      dir: salesSort.ascending ? "asc" : "desc",
      limit: salesLimit,
      offset: salesOffset,
    })
      .then((data) => {
        if (data.items.length === 0 && data.total > 0 && salesOffset > 0) {
          setSalesOffset(Math.floor((data.total - 1) / salesLimit) * salesLimit);
          return;
        }

        setSales(data);
        setSalesError("");
      })
      .catch((err) => setSalesError(getErrorMessage(err)));
  }, [canSeeSales, ready, range.from, range.to, salesSort, salesLimit, salesOffset]);

  const chart = useMemo(
    () => (loyalty ? everyDay(loyalty.from, loyalty.to, loyalty.byDay) : []),
    [loyalty]
  );

  // The server sorts this list, so the grid's header clicks (and the phone's
  // "Sort by") come here. The grid's third click ("list order") has no
  // meaning for a sorted list: it turns the column round instead.
  const changeSales = ({ page, pageSize, sort }) => {
    setSalesLimit(pageSize);
    const key = sort ? sort.key : salesSort.key;
    const ascending = sort ? sort.direction === "asc" : !salesSort.ascending;

    if (key !== salesSort.key || ascending !== salesSort.ascending) {
      setSalesSort({ key, ascending });
      setSalesOffset(0);
      return;
    }

    setSalesOffset((page - 1) * pageSize);
  };

  const changeRange = (next) => {
    setRange(next);
    setHoldersOffset(0);
    setSalesOffset(0);
  };

  // A whole list with names and numbers is an export: the server checks
  // customers.export and writes it to the activity log.
  const exportAll = async (kind) => {
    setExporting(kind);

    try {
      if (kind === "sales") {
        const all = await getCustomerSales({ from: range.from, to: range.to, sort: salesSort.key, all: 1 });
        downloadCsv(customerSalesSheet(all), `guest-sales-${range.from}-to-${range.to}.csv`);
      } else {
        const all = await getLoyaltyReport({ from: range.from, to: range.to, all: 1 });
        downloadCsv(
          kind === "holders" ? pointHoldersSheet(all) : pointsByDaySheet(all),
          kind === "holders" ? `points-owed-${all.to}.csv` : `points-by-day-${range.from}-to-${range.to}.csv`
        );
      }
    } catch (err) {
      (kind === "sales" ? setSalesError : setLoyaltyError)(getErrorMessage(err));
    } finally {
      setExporting("");
    }
  };

  return (
    <div className="stack crm-reports">
      <div className="card crm-report-filters">
        <div className="filters">
          <DateRangeFilter from={range.from} to={range.to} onChange={changeRange} label="report dates" />
        </div>
        <p className="muted small crm-report-note">
          <Icon name="info" size={14} /> Every figure below covers these dates, except “Points owed now”, which is today.
        </p>
      </div>

      {canSeePoints && (
        <section className="stack" aria-labelledby="crm-points-heading">
          <ReportHead
            id="crm-points-heading"
            icon="gift"
            tone="violet"
            title="Loyalty points"
            description="What the restaurant owes its guests in points, and how points moved in these dates."
          />

          <ErrorMessage message={loyaltyError} />

          {!loyalty ? (
            !loyaltyError && <Loading />
          ) : (
            <>
              {!loyalty.loyaltyEnabled && (
                <p className="alert alert-notice">
                  Loyalty is switched off in Settings, so no new points are being earned. Points already given are still owed.
                </p>
              )}

              <div className="stat-grid">
                <StatTile
                  icon="wallet"
                  tone="primary"
                  label="Points owed now"
                  value={`${count(loyalty.owed.points)} pts`}
                  note={`Worth ${moneyExact(loyalty.owed.value, currency)} · held by ${count(loyalty.owed.guests)} guests`}
                />
                <StatTile icon="plus" tone="success" label="Earned" value={count(loyalty.period.earned)} note="Points given on paid bills" />
                <StatTile
                  icon="receipt"
                  tone="info"
                  label="Redeemed"
                  value={count(loyalty.period.redeemed)}
                  note={`${money(loyalty.period.redeemedValue, currency)} off ${count(loyalty.period.redeemedBills)} bills`}
                />
                <StatTile
                  icon="sliders"
                  tone={loyalty.period.manual > 0 ? "warning" : "neutral"}
                  label="Given by hand"
                  value={`${loyalty.period.manual > 0 ? "+" : ""}${count(loyalty.period.manual)}`}
                  note={`${count(loyalty.period.manualEntries)} adjustments, each on the activity log`}
                />
                <StatTile
                  icon="x-circle"
                  tone="neutral"
                  label="Cancelled"
                  value={count(loyalty.period.expired)}
                  note="Expired, or erased on a guest's request"
                />
              </div>

              <div className="crm-report-grid">
                <SectionCard
                  icon="chart"
                  tone="info"
                  title="Points redeemed by day"
                  description="Rupees taken off bills with points, by business day"
                  actions={canExport && <CsvButton busy={exporting === "days"} onClick={() => exportAll("days")} />}
                  className="crm-days-card"
                  bodyClassName="stack"
                >
                  {chart.every((day) => day.value === 0) ? (
                    <p className="muted small">No points were redeemed in these dates.</p>
                  ) : (
                    <div className="crm-days-plot">
                      <ColumnChart points={chart} currency={currency} height={150} />
                    </div>
                  )}
                  {loyalty.byDay.length > 0 && (
                    <DataGrid
                      id="crm-points-by-day"
                      variant="compact"
                      caption="Points by day"
                      columns={[
                        {
                          key: "day",
                          header: "Day",
                          type: "date",
                          value: (row) => String(row.date).slice(0, 10),
                          mobile: "title",
                          render: (row) => <span className="nowrap">{shortDate(`${String(row.date).slice(0, 10)}T00:00:00`)}</span>,
                        },
                        { key: "earned", header: "Earned", type: "number", value: (row) => row.earned, total: "sum", mobile: "show" },
                        { key: "redeemed", header: "Redeemed", type: "number", value: (row) => row.redeemed, total: "sum", mobile: "show" },
                        { key: "value", header: "Value", type: "money", value: (row) => row.redeemedValue, total: "sum", mobile: "show" },
                        { key: "bills", header: "Bills", type: "number", value: (row) => row.redeemedBills, total: "sum" },
                        {
                          key: "other",
                          header: <span title="Points added or taken away by hand, or cancelled">By hand</span>,
                          label: "By hand",
                          type: "number",
                          value: (row) => row.other || 0,
                          total: "sum",
                          mobile: "show",
                          render: (row) => (row.other ? `${row.other > 0 ? "+" : ""}${count(row.other)}` : "—"),
                        },
                      ]}
                      rows={loyalty.byDay}
                      rowKey={(row) => row.date}
                      defaultSort={{ key: "day", direction: "desc" }}
                      currency={currency}
                      rowNoun={["day", "days"]}
                    />
                  )}
                </SectionCard>

                <SectionCard
                  icon="users"
                  tone="violet"
                  title="Who holds points"
                  description="Biggest balances first, today"
                  actions={canExport && <CsvButton busy={exporting === "holders"} onClick={() => exportAll("holders")} />}
                  bodyClassName="stack"
                >
                  {loyalty.holders.items.length === 0 ? (
                    <p className="muted small">No guest holds any points.</p>
                  ) : (
                    <>
                      <ol className="crm-holders" start={holdersOffset + 1}>
                        {loyalty.holders.items.map((row, index) => (
                          <li key={row.id}>
                            <span className="crm-holder-rank">{holdersOffset + index + 1}</span>
                            <span className="crm-holder-name">
                              <strong>{row.name}</strong>
                              <span className="muted small">
                                {[row.mobileDisplay, row.lastVisit ? `last visit ${shortDate(row.lastVisit)}` : "never visited"]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            </span>
                            <span className="crm-holder-points">
                              <strong>{count(row.points)}</strong>
                              <span className="muted small">{money(row.value, currency)}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                      <Pager
                        total={loyalty.holders.total}
                        limit={HOLDERS_PAGE}
                        offset={holdersOffset}
                        onPage={setHoldersOffset}
                        what="guests"
                      />
                    </>
                  )}
                </SectionCard>
              </div>
            </>
          )}
        </section>
      )}

      {canSeeSales && (
        <section className="stack" aria-labelledby="crm-sales-heading">
          <ReportHead
            id="crm-sales-heading"
            icon="money"
            tone="success"
            title="Sales by guest"
            description="Bills in these dates, on the business day they were raised, void bills left out."
          />

          <ErrorMessage message={salesError} />

          {!sales ? (
            !salesError && <Loading />
          ) : (
            <>
              <div className="stat-grid">
                <StatTile
                  icon="users"
                  tone="success"
                  label="From guests in the book"
                  value={money(sales.totals.guestSales, currency)}
                  note={`${sales.totals.guestShare}% of ${money(sales.totals.sales, currency)} · ${count(sales.totals.guestBills)} bills`}
                />
                <StatTile
                  icon="user"
                  tone="neutral"
                  label="Walk-ins"
                  value={money(sales.totals.walkInSales, currency)}
                  note={`${count(sales.totals.walkInBills)} bills with no guest attached`}
                />
                <StatTile icon="calendar" tone="info" label="Guests who came" value={count(sales.totals.guests)} note="In these dates" />
                <StatTile
                  icon="money"
                  tone="primary"
                  label="Spend per guest"
                  value={roundedMoney(sales.totals.guests ? sales.totals.guestSales / sales.totals.guests : 0, currency)}
                  note="Guest sales ÷ guests who came"
                />
              </div>

              <SectionCard
                icon="list"
                title="Guests by sales"
                description={
                  <>
                    <span className="crm-desk-only">Click a column name to sort. </span>Tags show who the guest is at a
                    glance.
                  </>
                }
                actions={canExport && <CsvButton busy={exporting === "sales"} onClick={() => exportAll("sales")} label="Export CSV" />}
                className="crm-list"
                flush
              >
                <DataGrid
                  id="crm-guest-sales"
                  caption="Guests by sales"
                  columns={[
                    {
                      key: "name",
                      header: "Guest",
                      value: (row) => row.name,
                      mobile: "title",
                      render: (row) => (
                        <>
                          <strong>{row.name}</strong>
                          {row.tags.slice(0, 2).map((tag) => (
                            <span key={tag} className={`crm-tag crm-tag-${tag} crm-tag-after`}>
                              {tagLabel(tag)}
                            </span>
                          ))}
                          <div className="muted small">{[row.companyName, row.mobileDisplay].filter(Boolean).join(" · ")}</div>
                        </>
                      ),
                    },
                    { key: "visits", header: "Visits", type: "number", value: (row) => row.visits, mobile: "show" },
                    { key: "bills", header: "Bills", type: "number", value: (row) => row.bills },
                    {
                      key: "spend",
                      header: "Sales",
                      type: "money",
                      value: (row) => row.spend,
                      mobile: "show",
                      render: (row) => <strong>{money(row.spend, currency)}</strong>,
                    },
                    {
                      key: "average",
                      header: "Per visit",
                      type: "money",
                      value: (row) => row.average,
                      mobile: "show",
                      render: (row) => roundedMoney(row.average, currency),
                    },
                    {
                      key: "pointsValue",
                      header: "Paid with points",
                      type: "money",
                      value: (row) => row.pointsValue || null,
                      sortable: false,
                    },
                    {
                      key: "lastVisit",
                      header: "Last bill",
                      type: "date",
                      value: (row) => row.lastVisit,
                      mobile: "show",
                      render: (row) => <span className="nowrap small">{shortDate(row.lastVisit)}</span>,
                    },
                  ]}
                  rows={sales.items}
                  rowKey={(row) => row.id}
                  empty="No bill in these dates was for a guest in the book."
                  emptyIcon="users"
                  emptyHint="Attach the guest at the till (search their mobile) and their bills show here."
                  currency={currency}
                  rowNoun={["guest", "guests"]}
                  search={false}
                  // The API pages and sorts. Its CSV (in the card's heading) is
                  // the server's export, on the activity log.
                  server={{
                    total: sales.total,
                    page: Math.floor(salesOffset / salesLimit) + 1,
                    pageSize: salesLimit,
                    sort: { key: salesSort.key, direction: salesSort.ascending ? "asc" : "desc" },
                    onChange: changeSales,
                  }}
                />
              </SectionCard>
            </>
          )}
        </section>
      )}
    </div>
  );
}
