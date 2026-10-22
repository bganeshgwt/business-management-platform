import { useMemo } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { moneyExact } from "@bmp/shared/format";
import FoodCostStrip from "./FoodCostStrip";

// Did we make money? Sales before GST, less the food, the running costs and
// the staff — month by month across the range, with the total beside it.
const BASES = [
  {
    key: "consumption",
    label: "Stock used",
    hint: "ingredients sales took out of stock, plus wastage, at cost",
    explain: "the ingredients sales took out of stock, plus wastage, at cost",
  },
  {
    key: "purchases",
    label: "Supplier bills",
    hint: "what was bought, less returns — for a kitchen that keeps little stock",
    explain: "what was bought from suppliers, less returns",
  },
];

const SECTION_TITLES = {
  revenue: "Revenue",
  foodCost: "Cost of food",
  expenses: "Running expenses",
  payroll: "Staff",
  // One outlet picked: rent, power, head-office staff and the main store's
  // issues are recorded for the whole restaurant and shared out by sales.
  shared: "Share of restaurant-wide costs",
};

// "−100.02%": a negative margin with a real minus sign, like the money beside it.
const percent = (value) =>
  value === null || value === undefined ? "—" : value < 0 ? `−${-value}%` : `${value}%`;

// The same to the paisa, for the statement itself.
const figureExact = (value, currency) =>
  value < 0 ? `−${moneyExact(-value, currency)}` : moneyExact(value, currency);

export default function ProfitLossReport({ data, currency, basis, onBasis }) {
  const find = (key) => data.lines.find((line) => line.key === key);
  const netRevenue = find("netRevenue");
  const foodCost = find("foodCost");
  const grossProfit = find("grossProfit");
  const expenses = find("totalExpenses");
  const payroll = find("payroll");
  const sharedCosts = find("sharedCosts");
  const bottom = find("netProfit");
  const hasExpenses =
    data.lines.some((line) => line.section === "expenses" && line.kind === "item") ||
    Boolean(sharedCosts && sharedCosts.amount !== 0);
  const showMonths = data.months.length > 1;
  const basisHint = BASES.find((option) => option.key === basis);
  // Six figures sit three to a row, seven four to a row: never one left alone.
  const tileCount = 5 + (sharedCosts ? 1 : 0) + (payroll ? 1 : 0);
  const tileClass = tileCount === 6 ? "report-tiles-3" : tileCount > 6 ? "report-tiles-4" : "";
  // The statement's lines in statement order, each knowing whether it opens
  // its section (the section's name is shown on that first line only).
  const rows = useMemo(
    () =>
      data.lines.map((line, index) => ({
        ...line,
        opensSection: index === 0 || data.lines[index - 1].section !== line.section,
      })),
    [data.lines]
  );

  // A statement reads top to bottom: no column sorts, filters or searches,
  // so the order is always the statement's. Money to the paisa, a deduction
  // with a real minus sign ("−₹3,868.40"), in the restaurant's currency.
  const columns = useMemo(() => {
    const strong = (line, text) => (line.kind === "item" ? text : <strong>{text}</strong>);

    return [
      {
        key: "section",
        header: "Section",
        pin: true,
        sortable: false,
        filter: "none",
        mobile: "subtitle",
        value: (line) => SECTION_TITLES[line.section] || "",
        render: (line) =>
          line.opensSection && SECTION_TITLES[line.section] ? (
            <strong className="small">{SECTION_TITLES[line.section]}</strong>
          ) : null,
      },
      {
        key: "line",
        header: "Line",
        pin: true,
        sortable: false,
        filter: "none",
        mobile: "title",
        value: (line) => line.label,
        render: (line) => (
          <>
            {strong(line, line.label)}
            {line.hint && <div className="muted small">{line.hint}</div>}
          </>
        ),
      },
      ...(showMonths
        ? data.months.map((month, index) => ({
            key: `month-${month.key}`,
            header: (
              <>
                {month.label}
                {month.partial && <div className="muted small">part month</div>}
              </>
            ),
            label: month.partial ? `${month.label} (part month)` : month.label,
            type: "money",
            exact: true,
            sortable: false,
            filter: "none",
            value: (line) => line.byMonth[index],
          }))
        : []),
      {
        key: "amount",
        header: showMonths ? "Total" : "Amount",
        type: "money",
        exact: true,
        sortable: false,
        filter: "none",
        mobile: "show",
        value: (line) => line.amount,
        render: (line) => strong(line, figureExact(line.amount, currency)),
      },
    ];
  }, [data.months, showMonths, currency]);

  return (
    <div className="stack">
      {/* The one choice on this report, and why it matters, above the figures
          it changes. */}
      <div className="card pl-basis-bar">
        <div className="pl-basis-text">
          <strong>Before GST</strong>
          <span className="muted small">
            The tax collected on sales is the government&apos;s money, not income.
            {basisHint ? ` Cost of food here is ${basisHint.explain}.` : ""}
          </span>
        </div>
        <div className="field pl-basis">
          <span>Cost of food from</span>
          <div className="segmented" role="radiogroup" aria-label="Cost of food from">
            {BASES.map((option) => (
              <button
                type="button"
                key={option.key}
                role="radio"
                aria-checked={basis === option.key}
                title={option.hint}
                className={`segment ${basis === option.key ? "is-active" : ""}`}
                onClick={() => onBasis(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {basis === "consumption" && data.foodCostBreakdown && (
        <FoodCostStrip breakdown={data.foodCostBreakdown} from={data.from} to={data.to} currency={currency} />
      )}

      <div className={`stat-grid ${tileClass}`}>
        <StatTile
          icon="rupee"
          tone="primary"
          label="Net revenue"
          money={netRevenue.amount}
          currency={currency}
          note="after discounts and refunds"
        />
        <StatTile
          icon="utensils"
          tone="warning"
          label="Cost of food"
          money={foodCost.amount}
          currency={currency}
          note={`${percent(data.ratios.foodCostPercent)} of revenue`}
        />
        <StatTile
          icon="trend-up"
          tone="success"
          label="Gross profit"
          money={grossProfit.amount}
          currency={currency}
          note={`${percent(data.ratios.grossMarginPercent)} margin`}
        />
        <StatTile
          icon="wallet"
          label={data.shared ? "Own expenses" : "Expenses"}
          money={expenses.amount}
          currency={currency}
          note={`${percent(data.ratios.expensesPercent)} of revenue`}
        />
        {sharedCosts && (
          <StatTile
            icon="store"
            tone="violet"
            label="Share of restaurant-wide costs"
            money={sharedCosts.amount}
          currency={currency}
            note={`${data.shared.carriedPercent}% of them · shared by sales, month by month`}
          />
        )}
        {payroll && (
          <StatTile
            icon="users"
            tone="info"
            label="Salaries"
            money={payroll.amount}
          currency={currency}
            note={`${percent(data.ratios.payrollPercent)} of revenue`}
          />
        )}
        <StatTile
          icon={bottom.amount < 0 ? "trend-down" : "trend-up"}
          tone={bottom.amount < 0 ? "danger" : "success"}
          className={`pl-bottom ${bottom.amount < 0 ? "is-loss" : "is-profit"}`}
          label={bottom.label}
          money={bottom.amount}
          currency={currency}
          note={`${bottom.amount < 0 ? "a loss" : "a profit"} · ${percent(data.ratios.netMarginPercent)} of revenue`}
        />
      </div>

      {/* Said above the statement: sales taken with "All outlets" picked
          are in no outlet's P&L, which is why the outlets do not add up. */}
      {(data.warnings || []).length > 0 && (
        <div className="alert alert-notice">
          {data.warnings.map((warning) => (
            <p key={warning} className="small">
              {warning}
            </p>
          ))}
        </div>
      )}

      <SectionCard
        icon="scale"
        title="Profit & loss statement"
        description={
          showMonths
            ? "Line by line, month by month, with the total on the right."
            : "Line by line: what came in, what it cost, and what is left."
        }
        flush
      >
        {/* S.No. stays on (the owner's rule): it numbers the statement's
            lines, so "line 12" can be pointed at on a call. Subtotals are in
            bold; the result lines (gross profit, contribution, net profit)
            are tinted green for a profit, red for a loss. */}
        <DataGrid
          id="report-profit-loss"
          caption="Profit and loss statement"
          columns={columns}
          rows={rows}
          rowKey={(line) => line.key}
          pageSize={false}
          search={false}
          exportName="profit-and-loss"
          currency={currency}
          rowClassName={(line) =>
            line.kind === "total" ? (line.amount < 0 ? "dg-tone-danger" : "dg-tone-success") : ""
          }
        />

        {(!hasExpenses || data.notes.length > 0) && (
          <div className="report-card-foot stack-sm">
            {!hasExpenses && (
              <p className="muted small">
                No approved expenses in this period.{" "}
                <Link to="/expenses">Record rent, power and the rest in Expenses</Link> so they come off here.
              </p>
            )}

            <ul className="report-notes">
              {data.notes.map((note) => (
                <li key={note} className="muted small">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
