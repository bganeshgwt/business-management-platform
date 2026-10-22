// What the Profit & loss food cost (on the "Stock used" basis) is made of,
// part by part, each part opening the screen that lists it. Shown on Profit &
// loss and on Dish profitability, so the two food costs can be set side by
// side: Dish profitability is only the first part (stock the bills took).
//
// breakdown: the report's foodCostBreakdown ({ sold, soldWithoutBill,
// production, kitchenIssues, manual, other, wastage, used, total }).
// production (ingredients made into prepared items) is not part of the food
// cost; it is a quiet note, counted when the prepared items are used.

import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import "./food-cost-strip.css";

const query = (params) =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

export default function FoodCostStrip({ breakdown, from, to, currency, title = "What the food cost is made of" }) {
  if (!breakdown) {
    return null;
  }

  const range = { from, to };
  const parts = [
    {
      key: "sold",
      label: "Sold via recipes",
      amount: breakdown.sold,
      to: `/reports?${query({ tab: "consumption", ...range })}`,
      title: "Stock the bills' recipes took (Stock consumption)",
      always: true,
    },
    {
      key: "kitchen",
      label: "Kitchen issues",
      amount: breakdown.kitchenIssues,
      to: `/inventory/stock?${query({ type: "consumption", ...range })}`,
      title: "Stock issued to the kitchen in bulk",
    },
    {
      key: "manual",
      label: "Manual stock out",
      amount: breakdown.manual,
      to: `/inventory/stock?${query({ type: "consumption", ...range })}`,
      title: "Stock out marked “Issued to the kitchen” by hand on Items & stock",
    },
    {
      key: "other",
      label: "Other use",
      amount: breakdown.other,
      to: `/inventory/stock?${query({ type: "consumption", ...range })}`,
    },
    {
      key: "wastage",
      label: "Wastage",
      amount: breakdown.wastage,
      to: `/inventory/insights?${query({ tab: "wastage", ...range })}`,
      title: "Thrown away, less entries undone",
      always: true,
    },
  ].filter((part) => part.always || Math.abs(part.amount) >= 0.005);

  return (
    <section className="report-scope tone-info food-cost-strip" aria-label={title}>
      <Icon name="info" size={16} />
      <span className="fcs-body">
        {/* Each part is one unit that never breaks inside; the line breaks
            between parts, so a long sum wraps instead of running off the card. */}
        <span className="fcs-line">
          <strong className="fcs-title">{title}:</strong>
          {parts.map((part, index) => (
            <span key={part.key} className="fcs-part">
              {index > 0 && <span className="fcs-op" aria-hidden="true">+</span>}
              <Link to={part.to} title={part.title}>
                {part.label} {money(part.amount, currency)}
              </Link>
            </span>
          ))}
          <span className="fcs-part fcs-total">
            <span className="fcs-op" aria-hidden="true">=</span>
            <strong>Profit &amp; loss food cost {money(breakdown.total, currency)}</strong>
          </span>
        </span>
        {breakdown.production > 0.005 && (
          <span className="muted fcs-note">
            <Link
              to={`/inventory/items?${query({ tab: "production", prodFrom: from, prodTo: to })}`}
              title="Production batches in these dates"
            >
              {money(breakdown.production, currency)} moved into prepared items
            </Link>{" "}
            — counted when those are sold or written off.
          </span>
        )}
        {breakdown.soldWithoutBill > 0.005 && (
          <span className="fcs-note">
            Of the {money(breakdown.sold, currency)} sold, {money(breakdown.soldWithoutBill, currency)} is stock marked as
            taken by a bill that cannot be found, so no dish shows it.
          </span>
        )}
      </span>
    </section>
  );
}
