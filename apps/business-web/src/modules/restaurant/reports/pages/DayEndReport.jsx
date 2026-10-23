import { BarList } from "../../../../components/Charts";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState } from "../../../../components/Feedback";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import SuccessCheck from "../../../../components/SuccessCheck";
import Icon from "@bmp/ui/Icon";
import useAuth from "../../../../hooks/useAuth";
import { count, money, moneyExact } from "@bmp/shared/format";
import { orderTypeLabel, paymentMethodLabel } from "../../../../services/labels";
import { printZReport } from "./zReport";
import { dayAndDate, plural, shortDate, signed } from "./reportFormat";
// The money screens' statement lines (.bill-totals) for the sheet.
import "../../../../styles/billing.css";

const n = (value) => Number(value || 0);
import "../styles/branch-reports.css";

// "matches", "₹120.00 short", "₹40.00 over" — in words as well as colour.
const difference = (variance, currency) =>
  variance === null || variance === undefined ? (
    <span className="muted">—</span>
  ) : (
    <strong className={variance === 0 ? "text-success" : "text-danger"}>
      {variance === 0 ? "matches" : `${moneyExact(Math.abs(variance), currency)} ${variance > 0 ? "over" : "short"}`}
    </strong>
  );

// One line per counter's drawer: each counter trades its own business day and
// counts its own cash. Every figure shows on the phone card too — a cashier
// signs for all of them. Expenses and supplier cash paid from the till are
// left out when no drawer had any (as on the one-drawer sheet), so the rest
// fits on one screen.
const drawerColumns = (currency, manyDates, drawers) => [
  {
    key: "counter",
    header: "Counter",
    mobile: "title",
    value: (drawer) => drawer.label,
    render: (drawer) => (
      <>
        <strong>{drawer.label}</strong>
        <span className="muted small"> · {drawer.dayStatus === "open" ? "open" : "closed"}</span>
        {manyDates && drawer.businessDate && <span className="dayend-drawer-date">{dayAndDate(drawer.businessDate)}</span>}
        {/* The counter's bill numbers sit under its name, so the figures
            beside it fit on one screen without scrolling sideways. */}
        {drawer.firstBill && (
          <span className="dayend-drawer-date mono">
            {drawer.firstBill === drawer.lastBill ? drawer.firstBill : `${drawer.firstBill} – ${drawer.lastBill}`}
          </span>
        )}
      </>
    ),
  },
  { key: "bills", header: "Bills", type: "number", mobile: "show", value: (drawer) => drawer.billCount },
  ...[
    ["openingCash", "Opening"],
    ["cashSales", "+ Cash sales"],
    ["cashTips", "+ Cash tips", true],
    ["cashRefunds", "− Refunds"],
    ["cashExpenses", "− Expenses", true],
    ["supplierCash", "− To suppliers", true],
    ["riderShortfall", "− Rider short", true],
    ["riderRepaid", "+ Rider repaid", true],
    ["cashAdvances", "+ Advances in cash", true],
    ["cashAdvancesReturned", "− Advances handed back", true],
  ]
    .filter(([key, , dropWhenNone]) => !dropWhenNone || drawers.some((drawer) => Number(drawer[key] || 0) !== 0))
    .map(([key, header]) => ({
    key,
    header,
    type: "money",
    exact: true,
    mobile: "show",
    render: (drawer) => moneyExact(drawer[key], currency),
  })),
  {
    key: "expectedCash",
    header: "Expected",
    type: "money",
    exact: true,
    mobile: "show",
    render: (drawer) => <strong>{moneyExact(drawer.expectedCash, currency)}</strong>,
  },
  {
    key: "closingCash",
    header: "Counted",
    type: "money",
    exact: true,
    mobile: "show",
    render: (drawer) =>
      drawer.closingCash === null ? <span className="muted">not closed</span> : moneyExact(drawer.closingCash, currency),
  },
  {
    key: "variance",
    header: "Difference",
    type: "money",
    exact: true,
    mobile: "show",
    render: (drawer) => difference(drawer.variance, currency),
  },
];

// "All drawers" under the counters: the sheet's own totals, to the paisa.
const drawersFooter = (data, currency) => (ctx) => {
  const values = {
    bills: count(data.billCount),
    openingCash: moneyExact(data.openingCash, currency),
    cashSales: moneyExact(data.cashSales, currency),
    cashRefunds: moneyExact(data.cashRefunds, currency),
    cashExpenses: moneyExact(data.cashExpenses, currency),
    supplierCash: moneyExact(data.supplierCash, currency),
    cashTips: moneyExact(data.cashTips, currency),
    riderShortfall: moneyExact(data.riderShortfall, currency),
    riderRepaid: moneyExact(data.riderRepaid, currency),
    cashAdvances: moneyExact(data.cashAdvances, currency),
    cashAdvancesReturned: moneyExact(data.cashAdvancesReturned, currency),
    expectedCash: moneyExact(data.expectedCash, currency),
    closingCash: data.closingCash === null ? <span className="muted">not all closed</span> : moneyExact(data.closingCash, currency),
    variance: difference(data.variance, currency),
  };
  const shown = ctx.columns.filter((column) => values[column.key] !== undefined);

  if (ctx.cards) {
    return (
      <div className="dg-card dg-card-total" role="group" aria-label="All drawers">
        <p className="dg-card-title">All drawers</p>
        <dl className="dg-card-fields">
          {shown.map((column) => (
            <div key={column.key} className="dg-card-field align-right">
              <dt>{column.label}</dt>
              <dd>{values[column.key]}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  return (
    <tr className="dg-total-row">
      {Array.from({ length: ctx.leading }, (_, at) => (
        <td key={`lead-${at}`} />
      ))}
      {ctx.columns.map((column) =>
        values[column.key] === undefined ? (
          <th key={column.key} scope="row" className="dg-total-label">
            All drawers
          </th>
        ) : (
          <td key={column.key} className={`align-${column.align} type-${column.type}`}>
            {values[column.key]}
          </td>
        )
      )}
    </tr>
  );
};

// The day-end sheet a manager signs, and the Z report printed from it on the
// receipt printer.
export default function DayEndReport(props) {
  // A date nobody traded on: said plainly, with the nearest traded days.
  if (props.data && props.data.noDay) {
    return <NoDayOn data={props.data} onPickDate={props.onPickDate} />;
  }

  return <DayEndSheet {...props} />;
}

function NoDayOn({ data, onPickDate }) {
  const dates = data.nearestDates || [];

  return (
    <div className="card">
      <EmptyState
        icon="calendar"
        message={data.message || "No business day was opened on this date."}
        hint={dates.length > 0 ? "Read one of the nearest days that were traded:" : "Pick another date above."}
      />
      {dates.length > 0 && onPickDate && (
        <div className="report-open-chips" style={{ justifyContent: "center", paddingBottom: "var(--space-5)" }}>
          {dates.map((date) => (
            <button type="button" key={date} className="chip-button" onClick={() => onPickDate(date)}>
              {dayAndDate(date)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DayEndSheet({ data, currency, settings, restaurantName, printedBy }) {
  const { hasFeature } = useAuth();
  const print = () => printZReport(data, { settings, currency, restaurantName, printedBy });
  const isOpen = data.dayStatus === "open";
  // Every counter's drawer on the sheet: one for an outlet's own day; the
  // main counter's and each outlet's for All outlets.
  const drawers = data.drawers || [];
  // All outlets with no date picked adds up the days being traded, and a
  // counter left open on an older date is on its own date: each drawer then
  // says which date it is.
  const dates = Array.isArray(data.businessDates) && data.businessDates.length > 0 ? data.businessDates : [data.businessDate];
  const manyDates = dates.length > 1;
  // The drawer's verdict, said in words as well as colour.
  const drawerTone =
    data.variance === null || data.variance === undefined ? "neutral" : data.variance === 0 ? "success" : "danger";
  // A closed day whose count matched to the rupee: the moment worth a mark.
  const closedClean = !isOpen && data.wholeDrawer && data.variance === 0;

  return (
    <div className="stack">
      <SectionCard
        icon="clipboard"
        title={
          <>
            Day end — {manyDates ? `open days, ${dates.map((date) => shortDate(date)).join(" and ")}` : dayAndDate(data.businessDate)}{" "}
            <span className={`badge status-badge ${isOpen ? "badge-active" : "badge-inactive"}`}>
              <span className="badge-dot" aria-hidden="true" />
              {isOpen ? "still open" : "closed"}
            </span>
          </>
        }
        description={
          drawers.length > 1
            ? `All outlets · ${drawers.map((drawer) => drawer.label).join(", ")}`
            : `Opened by ${data.openedByName || "—"}${data.closedByName ? ` · closed by ${data.closedByName}` : ""}${
                data.outletName ? ` · ${data.outletName} only` : ""
              }`
        }
        actions={
          <button type="button" className="button" onClick={print}>
            <Icon name="print" size={16} />
            {isOpen ? "Print X report" : "Print Z report"}
          </button>
        }
      >
        <div className="stack">
          <p className="report-scope tone-info">
            <Icon name="info" size={16} />
            <span>
              {isOpen
                ? "The day is still trading, so the printout is an X report: the figures so far. Print the Z report after closing the day."
                : `Prints on the receipt printer at ${settings?.printPaperWidth || "80mm"} (Settings → Printing), with lines for the cashier and manager to sign.`}
            </span>
          </p>

          <div className="stat-grid">
            <StatTile size="sm" icon="rupee" tone="primary" label="Net sales" value={moneyExact(data.netSales, currency)} />
            <StatTile
              size="sm"
              icon="receipt"
              tone="info"
              label="Bills"
              value={count(data.billCount)}
              note={
                data.firstBill
                  ? `${data.firstBill} to ${data.lastBill}`
                  : drawers.length > 1
                    ? `at ${drawers.length} counters`
                    : undefined
              }
            />
            <StatTile
              size="sm"
              icon="users"
              tone="violet"
              label="Covers (dine-in)"
              value={count(data.covers)}
              note={data.perHead ? `${money(data.perHead, currency)} a head` : undefined}
            />
            {data.wholeDrawer && (
              <StatTile
                size="sm"
                icon="cash"
                tone={drawerTone}
                label="Expected in drawer"
                value={moneyExact(data.expectedCash, currency)}
                note={
                  drawerTone === "neutral"
                    ? "not counted yet"
                    : data.variance === 0
                      ? "count matches"
                      : `${data.variance > 0 ? "+" : ""}${moneyExact(data.variance, currency)} ${data.variance > 0 ? "over" : "short"}`
                }
              />
            )}
          </div>

          <div className="two-column report-pair">
            <div className="report-sheet">
              <h3 className="report-subhead">Sales</h3>
              <dl className="details bill-totals report-statement">
                <dt>Bills</dt>
                <dd>
                  {count(data.billCount)}
                  {data.firstBill && (
                    <span className="muted small">
                      {" "}
                      · {data.firstBill} to {data.lastBill}
                    </span>
                  )}
                </dd>
                <dt>Gross sales (before tax)</dt>
                <dd>{moneyExact(data.grossSales, currency)}</dd>
                <dt>Discounts</dt>
                <dd>−{moneyExact(data.discounts, currency)}</dd>
                {data.serviceCharge > 0 && (
                  <>
                    <dt>Service charge</dt>
                    <dd>{moneyExact(data.serviceCharge, currency)}</dd>
                  </>
                )}
                {data.gstSplit ? (
                  <>
                    <dt>CGST</dt>
                    <dd>{moneyExact(data.cgst, currency)}</dd>
                    <dt>SGST</dt>
                    <dd>{moneyExact(data.sgst, currency)}</dd>
                    {data.cess > 0 && (
                      <>
                        <dt>Cess</dt>
                        <dd>{moneyExact(data.cess, currency)}</dd>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <dt>Tax</dt>
                    <dd>{moneyExact(data.tax, currency)}</dd>
                  </>
                )}
                <dt>Round off</dt>
                <dd>{signed(data.roundOff, (value) => moneyExact(value, currency))}</dd>
                <dt className="is-total">
                  <strong>Net sales</strong>
                </dt>
                <dd className="is-total">
                  <strong>{moneyExact(data.netSales, currency)}</strong>
                </dd>
              </dl>
            </div>

            <div className="report-sheet">
              <h3 className="report-subhead">Guests, refunds and voids</h3>
              <dl className="details bill-totals report-statement">
                <dt>Covers (dine-in)</dt>
                <dd>{count(data.covers)}</dd>
                <dt>Per head (dine-in)</dt>
                <dd>{data.perHead ? money(data.perHead, currency) : "—"}</dd>
                <dt>Refunds</dt>
                <dd>
                  {moneyExact(data.totalRefunds, currency)} <span className="muted small">({count(data.refundCount)})</span>
                </dd>
                <dt>Voided bills</dt>
                <dd>
                  {moneyExact(data.voidValue, currency)} <span className="muted small">({count(data.voidCount)})</span>
                </dd>
                <dt>Cancelled orders</dt>
                <dd>
                  {moneyExact(data.cancelledValue, currency)}{" "}
                  <span className="muted small">({count(data.cancelledOrders)})</span>
                </dd>
                <dt>Approved expenses</dt>
                <dd>{moneyExact(data.totalExpenses, currency)}</dd>
              </dl>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        icon="cash"
        tone="success"
        title={drawers.length > 1 ? `Cash drawers (${drawers.length})` : "Cash drawer"}
        description={
          !data.wholeDrawer
            ? "Cash taken and refunded at this outlet."
            : drawers.length > 1
              ? manyDates
                ? "Each counter trades its own business day, on its own date, and counts its own drawer."
                : "Each counter trades its own business day and counts its own drawer."
              : "What the drawer should hold at close, and what was counted."
        }
      >
        {closedClean && (
          <p className="dayend-verdict">
            <SuccessCheck size={28} label="Day closed, the count matches" />
            Day closed — the count matches to the rupee.
          </p>
        )}
        {data.wholeDrawer && drawers.length > 1 ? (
          <DataGrid
            id="dayend-drawers"
            caption="Cash drawers"
            columns={drawerColumns(currency, manyDates, drawers)}
            rows={drawers}
            rowKey={(drawer) => drawer.businessDayId}
            variant="compact"
            pageSize={false}
            rowClassName={(drawer) =>
              drawer.variance === null || drawer.variance === undefined || drawer.variance === 0
                ? ""
                : drawer.variance < 0
                  ? "dg-tone-danger"
                  : "dg-tone-warning"
            }
            footer={drawersFooter(data, currency)}
          />
        ) : data.wholeDrawer ? (
          <dl className="details bill-totals report-statement report-drawer">
            <dt>Opening cash</dt>
            <dd>{moneyExact(data.openingCash, currency)}</dd>
            <dt>+ Cash sales</dt>
            <dd>{moneyExact(data.cashSales, currency)}</dd>
            {data.cashTips > 0 && (
              <>
                <dt>+ Tips given in cash</dt>
                <dd>{moneyExact(data.cashTips, currency)}</dd>
              </>
            )}
            <dt>− Cash refunds</dt>
            <dd>{moneyExact(data.cashRefunds, currency)}</dd>
            <dt>− Cash expenses</dt>
            <dd>{moneyExact(data.cashExpenses, currency)}</dd>
            {data.supplierCash > 0 && (
              <>
                <dt>− Paid to suppliers from the till</dt>
                <dd>{moneyExact(data.supplierCash, currency)}</dd>
              </>
            )}
            {data.riderShortfall > 0 && (
              <>
                <dt>− Riders short on settlement</dt>
                <dd>{moneyExact(data.riderShortfall, currency)}</dd>
              </>
            )}
            {data.riderRepaid > 0 && (
              <>
                <dt>+ Rider shortfalls handed over</dt>
                <dd>{moneyExact(data.riderRepaid, currency)}</dd>
              </>
            )}
            {data.cashAdvances > 0 && (
              <>
                <dt>+ Advances and deposits taken in cash</dt>
                <dd>{moneyExact(data.cashAdvances, currency)}</dd>
              </>
            )}
            {data.cashAdvancesReturned > 0 && (
              <>
                <dt>− Advances handed back in cash</dt>
                <dd>{moneyExact(data.cashAdvancesReturned, currency)}</dd>
              </>
            )}
            <dt className="is-total">
              <strong>Expected in drawer</strong>
            </dt>
            <dd className="is-total">
              <strong>{moneyExact(data.expectedCash, currency)}</strong>
            </dd>
            <dt>Counted at close</dt>
            <dd>{data.closingCash === null ? "Not closed yet" : moneyExact(data.closingCash, currency)}</dd>
            {data.variance !== null && (
              <>
                <dt>
                  <strong>Difference</strong>
                </dt>
                <dd>
                  <strong className={data.variance === 0 ? "text-success" : "text-danger"}>
                    {data.variance > 0 ? "+" : ""}
                    {moneyExact(data.variance, currency)}
                    {data.variance === 0 ? " — matches" : data.variance > 0 ? " over" : " short"}
                  </strong>
                </dd>
              </>
            )}
          </dl>
        ) : (
          <div className="stack">
            <dl className="details bill-totals report-statement report-drawer">
              <dt>Cash taken at this outlet</dt>
              <dd>{moneyExact(data.cashSales, currency)}</dd>
              <dt>Cash refunded here</dt>
              <dd>{moneyExact(data.cashRefunds, currency)}</dd>
            </dl>
            <p className="muted small">
              This outlet traded on the main counter&apos;s business day, so its cash is in the main counter&apos;s
              drawer. Pick All outlets at the top to see that drawer and its count.
            </p>
          </div>
        )}
      </SectionCard>

      <div className="two-column report-pair">
        <SectionCard icon="card" tone="info" title="Collected by method" description="Payments taken on the day.">
          {data.byMethod.length === 0 ? (
            <EmptyState icon="card" message="Nothing collected yet." />
          ) : (
            <BarList
              rows={data.byMethod.map((row) => ({
                label: paymentMethodLabel(row.paymentMethod),
                value: row.amount,
              }))}
              currency={currency}
            />
          )}
        </SectionCard>

        <SectionCard icon="utensils" title="By order type" description="Net sales for each kind of order.">
          {data.byOrderType.length === 0 ? (
            <EmptyState icon="utensils" message="Nothing billed yet." />
          ) : (
            <BarList
              rows={data.byOrderType.map((row) => ({
                label: orderTypeLabel(row.orderType),
                value: row.netSales,
                sub: plural(row.billCount, "bill", "bills"),
              }))}
              currency={currency}
            />
          )}
        </SectionCard>
      </div>

      {/* Tips and rider cash are the Tips and Deliveries features: a day
          from before one was switched off still shows what it took. */}
      {(hasFeature("tips") || n(data.tips && data.tips.total) > 0 || hasFeature("deliveries") || n(data.riderCash) > 0) && (
        <div className="two-column report-pair">
          {(hasFeature("tips") || n(data.tips && data.tips.total) > 0) && <TipsCard data={data} currency={currency} />}
          {(hasFeature("deliveries") || n(data.riderCash) > 0 || n(data.riderShortfall) > 0) && <RidersCard data={data} currency={currency} />}
        </div>
      )}

      <NotesCard data={data} />
    </div>
  );
}

// Tips collected, by how they were given. They are on
// top of the payments: never in the sales, the GST or the P&L. Cash tips are
// in the drawer until they are shared out.
function TipsCard({ data, currency }) {
  const tips = data.tips || { total: 0, count: 0, byMethod: [] };

  return (
    <SectionCard
      icon="heart"
      tone="success"
      title="Tips collected"
      description="Given on top of the bills. Not in sales, GST or the P&L."
    >
      {tips.total === 0 ? (
        <EmptyState icon="heart" message="No tips were given on this day." />
      ) : (
        <dl className="details bill-totals report-statement">
          {tips.byMethod.map((row) => (
            <TipLine key={row.paymentMethod} row={row} currency={currency} />
          ))}
          <dt className="is-total">
            <strong>Tips in all</strong>
          </dt>
          <dd className="is-total">
            <strong>{moneyExact(tips.total, currency)}</strong>
          </dd>
        </dl>
      )}
      {data.cashTips > 0 && (
        <p className="muted small">
          {moneyExact(data.cashTips, currency)} of it is cash, counted in the drawer until the tips are shared out.
        </p>
      )}
    </SectionCard>
  );
}

function TipLine({ row, currency }) {
  return (
    <>
      <dt>
        {paymentMethodLabel(row.paymentMethod)} <span className="muted small">({count(row.count)})</span>
      </dt>
      <dd>{moneyExact(row.amount, currency)}</dd>
    </>
  );
}

// Riders' cash: what riders handed in when their bills
// were settled, what they did not (off the drawer, kept as owed or written
// off), owed shortfalls handed over on the day, and what riders still owe.
function RidersCard({ data, currency }) {
  const owe = data.ridersOwe || { count: 0, amount: 0, riders: 0 };
  const any = data.riderCash > 0 || data.riderShortfall > 0 || data.riderRepaid > 0 || owe.amount > 0;

  return (
    <SectionCard icon="scooter" tone="warning" title="Rider cash" description="Cash riders brought back from deliveries.">
      {!any ? (
        <EmptyState icon="scooter" message="No rider settled cash on this day, and no rider owes anything." />
      ) : (
        <dl className="details bill-totals report-statement">
          <dt>Handed in on settlement</dt>
          <dd>
            {moneyExact(data.riderCash, currency)} <span className="muted small">(in cash sales)</span>
          </dd>
          <dt>− Short on settlement</dt>
          <dd className={data.riderShortfall > 0 ? "text-danger" : undefined}>{moneyExact(data.riderShortfall, currency)}</dd>
          <dt>+ Shortfalls handed over</dt>
          <dd>{moneyExact(data.riderRepaid, currency)}</dd>
          <dt className="is-total">
            <strong>Riders still owe</strong>
          </dt>
          <dd className="is-total">
            <strong className={owe.amount > 0 ? "text-danger" : undefined}>{moneyExact(owe.amount, currency)}</strong>
            {owe.amount > 0 && (
              <span className="muted small">
                {" "}
                · {plural(owe.riders, "rider", "riders")}, {plural(owe.count, "settlement", "settlements")}
              </span>
            )}
          </dd>
        </dl>
      )}
    </SectionCard>
  );
}

const LOG_WORDS = { maintenance: "Maintenance", guest: "Guests", stock: "Stock", staff: "Staff", other: "Other" };

// The day's notes: each counter's opening and closing note, kept
// apart with who wrote them, and the shift log book's entries for the day.
function NotesCard({ data }) {
  const notes = data.notes || [];
  const logbook = data.logbook || [];
  const time = (at) =>
    at
      ? new Date(at).toLocaleTimeString("en-IN", { timeZone: data.timezone || undefined, hour: "numeric", minute: "2-digit" })
      : "";

  if (notes.length === 0 && logbook.length === 0) {
    return null;
  }

  return (
    <SectionCard icon="book" title="Notes for the day" description="What the opener, the closer and each shift wrote down.">
      <ul className="dayend-notes">
        {notes.map((note) => (
          <li key={note.businessDayId}>
            {notes.length > 1 && <strong className="dayend-notes-counter">{note.label}</strong>}
            {note.openingNotes && (
              <p>
                <span className="badge badge-neutral">Opening</span> <span className="pre-line">{note.openingNotes}</span>
                <span className="muted small">
                  {" "}
                  — {note.openedByName || "—"}, {time(note.openedAt)}
                </span>
              </p>
            )}
            {note.closingNotes && (
              <p>
                <span className="badge badge-neutral">Closing</span> <span className="pre-line">{note.closingNotes}</span>
                <span className="muted small">
                  {" "}
                  — {note.closedByName || "—"}, {time(note.closedAt)}
                </span>
              </p>
            )}
          </li>
        ))}
        {logbook.map((entry) => (
          <li key={`log-${entry.id}`}>
            <p>
              <span className="badge badge-info">{LOG_WORDS[entry.category] || "Log book"}</span> {entry.body}
              <span className="muted small">
                {" "}
                — {entry.byName || "—"}, {time(entry.at)}
                {entry.outletName ? ` · ${entry.outletName}` : ""}
                {entry.followUp ? (entry.closed ? " · follow-up closed" : " · follow-up open") : ""}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

