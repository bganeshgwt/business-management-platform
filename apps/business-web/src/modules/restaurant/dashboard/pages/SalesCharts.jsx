import { useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import { BarList } from "../../../../components/Charts";
import { count } from "@bmp/shared/format";
import { plural } from "../../reports/pages/reportFormat";

// The day's trading for someone who does not see sales: what is moving and
// the orders taken, counted rather than priced. (With sales, TradingToday
// draws the whole day.)

// Both ends of the day's selling.
//
// The best five is the half a kitchen already knows. What it cannot see is
// what is barely moving — the dish prepped every morning for two orders, the
// stock going off in the fridge behind it. That half is where money leaks.
//
// The slow bars are scaled against the day's best seller rather than against
// each other, so a dish that took ₹31 next to one that took ₹1,680 is drawn as
// the sliver it is. Without sales.view the dishes are ranked and drawn by
// plates, not money: a kitchen needs to know what is moving, not what it took.
export function ItemsTodayCard({ items, currency, canSeeReports, byPlates }) {
  const [view, setView] = useState("top");

  const measure = (row) => (byPlates ? row.quantity : row.grossSales);
  const best = items.topItems.length > 0 ? measure(items.topItems[0]) : 0;
  const rows = view === "top" ? items.topItems : items.lowItems;

  return (
    <SectionCard
      icon="utensils"
      tone="success"
      title="Items sold"
      description={
        items.soldLines > 0
          ? `${plural(items.soldLines, "dish", "dishes")} sold so far`
          : "What is selling, and what is not"
      }
      className="dash-chart-card"
    >
      {items.soldLines === 0 ? (
        <p className="muted small">Nothing sold in this business day yet.</p>
      ) : (
        <>
          <div className="segmented dash-items-switch" role="radiogroup" aria-label="Items sold this business day">
            <button
              type="button"
              className={`segment ${view === "top" ? "is-active" : ""}`}
              role="radio"
              aria-checked={view === "top"}
              onClick={() => setView("top")}
            >
              Best sellers
            </button>
            <button
              type="button"
              className={`segment ${view === "low" ? "is-active" : ""}`}
              role="radio"
              aria-checked={view === "low"}
              onClick={() => setView("low")}
            >
              Slowest
            </button>
          </div>

          <BarList
            rows={rows.map((row) => ({
              label: row.itemName,
              value: measure(row),
              sub: byPlates ? undefined : `${count(row.quantity)} sold`,
            }))}
            currency={currency}
            format={byPlates ? (value) => `${count(value)} sold` : undefined}
            scale={view === "low" ? best : undefined}
          />

          {/* Ten dishes cannot have five best and five different worst, and a
              card that quietly shows the same list twice is worse than one
              that says so. */}
          {view === "low" && items.soldLines <= 10 && (
            <p className="muted small cash-position">
              Only {items.soldLines === 1 ? "one dish has" : `${count(items.soldLines)} dishes have`} sold in this business day,
              so this is much the same list read backwards.
            </p>
          )}

          {/* The dishes that sold nothing at all never appear in either list,
              because a list of what sold cannot contain what did not. */}
          {items.unsoldToday > 0 && (
            <p className="muted small cash-position">
              {count(items.unsoldToday)} {items.unsoldToday === 1 ? "dish has" : "dishes have"} not sold at all
              in this business day. {canSeeReports && <Link to="/reports?tab=items">See which</Link>}
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}

// Orders by type, counted rather than priced, for someone who may not see
// takings.
export function OrdersTodayCard({ covers }) {
  return (
    <SectionCard
      icon="receipt"
      tone="info"
      title="Orders taken"
      description={`${plural(covers.orders, "order", "orders")} taken`}
      className="dash-chart-card"
    >
      <BarList
        rows={[
          { label: "Dine-in", value: covers.dineIn },
          { label: "Takeaway", value: covers.takeaway },
          { label: "Delivery", value: covers.delivery },
        ].filter((row) => row.value > 0)}
        format={(value) => plural(value, "order", "orders")}
        empty="No orders taken in this business day yet."
      />
    </SectionCard>
  );
}
