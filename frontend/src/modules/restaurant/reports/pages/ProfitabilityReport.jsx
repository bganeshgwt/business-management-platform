// Dish profitability tab of the Reports screen.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import Icon from "../../../../components/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { count, moneyExact } from "../../../../services/format";
import FoodCostStrip from "./FoodCostStrip";

// Dish profitability (SW-B-15): what each dish and size sold before GST, what
// its ingredients cost (the stock its bills really took, at that day's cost),
// the food cost % and what is left. Nothing of it goes on the dashboard.
export default function ProfitabilityReport({ data, currency }) {
  const totals = data.totals;
  const columns = useMemo(
    () => [
      {
        key: "dish",
        header: "Dish",
        value: (row) => (row.variantName ? `${row.itemName} (${row.variantName})` : row.itemName),
        mobile: "title",
        className: "report-strong",
        filter: "text",
        render: (row) => (
          <>
            {row.itemName}
            {row.variantName && <span className="muted"> ({row.variantName})</span>}
            {!row.hasRecipe && (
              <span className="badge badge-warning status-badge report-badge-gap">
                <span className="badge-dot" aria-hidden="true" />
                no recipe
              </span>
            )}
          </>
        ),
      },
      { key: "qty", header: "Sold", type: "number", value: (row) => row.quantity, total: "sum", mobile: "show" },
      { key: "sales", header: "Sales before GST", type: "money", exact: true, value: (row) => row.sales, total: "sum", mobile: "show" },
      { key: "portion", header: "Cost a plate", type: "money", exact: true, value: (row) => row.costPerPortion },
      { key: "cost", header: "Food cost", type: "money", exact: true, value: (row) => row.foodCost, total: "sum", mobile: "show" },
      {
        key: "percent",
        header: "Food cost %",
        type: "percent",
        value: (row) => row.foodCostPercent,
        render: (row) =>
          row.foodCostPercent === null ? (
            <span className="muted">—</span>
          ) : (
            <span className={row.foodCostPercent > 40 ? "text-danger" : ""}>{row.foodCostPercent}%</span>
          ),
        mobile: "show",
      },
      { key: "perPlate", header: "Left a plate", type: "money", exact: true, value: (row) => row.contributionPerPortion },
      {
        key: "contribution",
        header: "Left in all",
        type: "money",
        exact: true,
        value: (row) => row.contribution,
        render: (row) => <strong>{moneyExact(row.contribution, currency)}</strong>,
        total: "sum",
        mobile: "show",
      },
    ],
    [currency]
  );

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatTile size="sm" icon="rupee" tone="primary" label="Sales before GST" money={totals.sales} currency={currency} />
        <StatTile
          size="sm"
          icon="utensils"
          tone="warning"
          label="Food cost"
          money={totals.foodCost}
          currency={currency}
          note={totals.foodCostPercent === null ? undefined : `${totals.foodCostPercent}% of sales`}
        />
        <StatTile size="sm" icon="wallet" tone="success" label="Left after food" money={totals.contribution} currency={currency} />
        <StatTile
          size="sm"
          icon="alert"
          tone={totals.withoutRecipe ? "danger" : "neutral"}
          label="Dishes with no recipe"
          value={count(totals.withoutRecipe)}
          note={totals.withoutRecipe ? "their food cost reads ₹0 until one is added" : "every dish sold has a recipe"}
        />
      </div>

      <p className="report-scope tone-info">
        <Icon name="info" size={16} />
        <span>
          Food cost here is only the stock these bills took out through their recipes, at the cost it had that day; a
          bill&apos;s stock is shared between its dishes by their recipes. It is one part of the food cost in Profit
          &amp; loss, which also counts production, kitchen issues, stock taken out by hand and wastage (below).
          {totals.unmatched > 0 &&
            ` ${moneyExact(totals.unmatched, currency)} of stock went on bills whose dishes have no recipe to share it by; it is in the total food cost.`}{" "}
          {totals.withoutRecipe > 0 ? (
            <>
              <Link to="/menu/products?show=norecipe">
                {count(totals.withoutRecipe)} {totals.withoutRecipe === 1 ? "dish has" : "dishes have"} no recipe
              </Link>{" "}
              — add them for a true figure.
            </>
          ) : null}
        </span>
      </p>

      <FoodCostStrip
        breakdown={data.foodCostBreakdown}
        from={data.from}
        to={data.to}
        currency={currency}
        title="How it sits in Profit & loss"
      />

      <SectionCard icon="chart" title="Dish by dish" description="Sorted by what each dish leaves after its ingredients." flush>
        <DataGrid
          id="report-dish-profit"
          caption="Dish profitability"
          columns={columns}
          rows={data.dishes}
          rowKey={(row) => `${row.productId || row.itemName}-${row.variantId || ""}`}
          rowClassName={(row) => (row.hasRecipe ? "" : "dg-tone-warning")}
          empty="Nothing was sold in this period."
          emptyHint="Pick a longer range above."
          emptyIcon="utensils"
          defaultSort={{ key: "contribution", direction: "desc" }}
          exportName="dish-profitability"
          currency={currency}
          rowNoun={["dish", "dishes"]}
        />
      </SectionCard>
    </div>
  );
}
