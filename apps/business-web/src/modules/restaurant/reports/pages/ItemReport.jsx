// Items tab of the Reports screen: item and add-on sales, menu performance.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import { BarList } from "../../../../components/Charts";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { plural } from "./reportFormat";

export default function ItemReport({ data, currency }) {
  const totals = data.itemTotals;
  const columns = useMemo(
    () => [
      { key: "item", header: "Item", value: (row) => row.itemName, mobile: "title", className: "report-strong", filter: "text" },
      { key: "category", header: "Category", value: (row) => row.categoryName, mobile: "subtitle", filter: "select" },
      { key: "qty", header: "Qty", type: "number", value: (row) => row.quantity, total: "sum", mobile: "show" },
      { key: "net", header: "Net", type: "money", value: (row) => row.netSales, total: "sum", mobile: "show" },
      { key: "tax", header: "Tax", type: "money", value: (row) => row.tax, total: "sum" },
      { key: "gross", header: "Gross", type: "money", value: (row) => row.grossSales, total: "sum", mobile: "show" },
    ],
    []
  );

  return (
    <div className="stack">
      <SectionCard icon="layers" title="By category" description="What each menu category took, tax included, and how many were sold.">
        <BarList
          rows={data.categories.map((row) => ({
            label: row.categoryName,
            value: row.grossSales,
            sub: `${row.quantity} sold`,
          }))}
          currency={currency}
        />
      </SectionCard>

      <MenuPerformance rows={data.menu} currency={currency} />

      <SectionCard
        icon="list"
        tone="neutral"
        title="Item-wise sales"
        description={`${plural(totals.lines, "dish or size", "dishes and sizes")} · every one is in the export`}
        flush
      >
        <DataGrid
          id="report-items"
          caption="Item-wise sales"
          columns={columns}
          rows={data.items}
          rowKey={(row, index) => `${index}-${row.itemName}-${row.categoryName}`}
          empty="Nothing was sold in this period."
          emptyHint="Pick a longer range above, or a day the restaurant traded."
          emptyIcon="utensils"
          defaultSort={{ key: "gross", direction: "desc" }}
          exportName="item-sales"
          currency={currency}
          rowNoun={["line", "lines"]}
        />
      </SectionCard>

      <AddonsCard rows={data.addons || []} currency={currency} />
    </div>
  );
}

// Add-ons sold: how many plates carried each add-on and what it
// added, in the range and at the outlet picked. Free ones are counted: how
// often "no onion" or a free dip is asked for is worth knowing too.
function AddonsCard({ rows, currency }) {
  const columns = useMemo(
    () => [
      {
        key: "addon",
        header: "Add-on",
        value: (row) => row.addonName,
        mobile: "title",
        className: "report-strong",
        render: (row) => (
          <>
            {row.addonName}
            {row.free && <span className="badge badge-neutral report-badge-gap">free</span>}
          </>
        ),
      },
      { key: "qty", header: "Plates with it", type: "number", value: (row) => row.quantity, total: "sum", mobile: "show" },
      { key: "bills", header: "Bills", type: "number", value: (row) => row.billCount, mobile: "show" },
      { key: "value", header: "Value sold", type: "money", value: (row) => row.value, total: "sum", mobile: "show" },
    ],
    []
  );

  return (
    <SectionCard
      icon="plus"
      tone="success"
      title="Add-ons"
      description="Each add-on on the bills of these dates: plates that carried it and what it added (menu price, before any bill discount)."
      flush
    >
      <DataGrid
        id="report-addons"
        caption="Add-ons sold"
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.modifierId || "x"}-${row.addonName}`}
        empty="No add-ons were sold in this period."
        emptyHint="Add-ons are set up under Menu → Modifiers."
        emptyIcon="plus"
        defaultSort={{ key: "value", direction: "desc" }}
        exportName="addon-sales"
        currency={currency}
        rowNoun={["add-on", "add-ons"]}
      />
    </SectionCard>
  );
}

// Menu engineering, in the plainest form the data supports.
//
// "Top selling" is the easy half and every till prints it. The half that pays
// for itself is the other one: a dish nobody ordered still earns its place on
// the menu, in the fridge and in the kitchen's head, and costs money to keep
// there. The item report could never show it — it counts what was sold, so a
// dish that sold nothing has no row to count.
//
// Ranking by money and ranking by plates disagree on purpose: mineral water
// sells ninety-nine times and earns very little, and a manager needs to be
// able to ask both questions.
const MENU_VIEWS = [
  { key: "top", label: "Top selling" },
  { key: "low", label: "Low selling" },
  { key: "none", label: "Not sold" },
];

function MenuPerformance({ rows, currency }) {
  const [view, setView] = useState("top");

  const total = rows.reduce((sum, row) => sum + row.grossSales, 0);
  const sold = rows.filter((row) => row.quantity > 0);
  const unsold = rows.filter((row) => row.quantity === 0);
  const source = view === "none" ? unsold : sold;

  const columns = useMemo(
    () => [
      {
        key: "item",
        header: "Item",
        value: (row) => row.itemName,
        mobile: "title",
        className: "report-strong",
        render: (row) => (
          <>
            {row.itemName}
            {!row.isAvailable && <span className="badge badge-inactive report-badge-gap">Off the menu</span>}
          </>
        ),
      },
      { key: "category", header: "Category", value: (row) => row.categoryName, mobile: "subtitle", filter: "select" },
      view !== "none" && { key: "quantity", header: "Plates", type: "number", value: (row) => row.quantity, mobile: "show" },
      view !== "none" && { key: "orders", header: "Orders", type: "number", value: (row) => row.orderCount },
      view !== "none" && { key: "revenue", header: "Revenue", type: "money", value: (row) => row.grossSales, mobile: "show" },
      view !== "none" && {
        key: "share",
        header: "Share",
        type: "percent",
        value: (row) => (total > 0 ? Math.round((row.grossSales / total) * 100) : null),
      },
      {
        key: "last",
        header: "Last sold",
        type: "number",
        // Never sold sorts as the stalest thing on the menu, not the freshest.
        value: (row) => row.daysSinceSold ?? 99999,
        render: (row) => <LastSold days={row.daysSinceSold} />,
        csv: (row) => (row.daysSinceSold === null ? "never" : row.daysSinceSold),
        mobile: "show",
      },
    ],
    [view, total]
  );

  return (
    <SectionCard
      icon="star"
      tone="success"
      title="Menu performance"
      description={`${sold.length} of ${plural(rows.length, "dish", "dishes")} sold${
        unsold.length > 0 ? ` · ${unsold.length} sold nothing` : ""
      }`}
      flush
    >
      <DataGrid
        key={view}
        id={`report-menu-${view}`}
        caption="Menu performance"
        columns={columns}
        rows={source}
        rowKey={(row) => row.productId}
        defaultSort={
          view === "top"
            ? { key: "revenue", direction: "desc" }
            : view === "low"
              ? { key: "revenue", direction: "asc" }
              : { key: "last", direction: "desc" }
        }
        empty={
          view === "none" ? "Every dish on the menu sold at least once. That is a tight menu." : "Nothing was sold in this period."
        }
        emptyIcon={view === "none" ? "check-circle" : "utensils"}
        exportName={`menu-${view === "none" ? "not-sold" : view === "low" ? "low-selling" : "top-selling"}`}
        currency={currency}
        rowNoun={["dish", "dishes"]}
        toolbar={
          <div className="segmented" role="radiogroup" aria-label="Menu performance view">
            {MENU_VIEWS.map((option) => (
              <button
                type="button"
                key={option.key}
                className={`segment ${view === option.key ? "is-active" : ""}`}
                role="radio"
                aria-checked={view === option.key}
                onClick={() => setView(option.key)}
              >
                {option.label}
                {option.key === "none" && unsold.length > 0 && ` (${unsold.length})`}
              </button>
            ))}
          </div>
        }
      />

      {view === "none" && unsold.length > 0 && (
        <p className="muted small report-card-foot">
          A dish that sells nothing still takes up stock, prep and a line on the menu.{" "}
          <Link to="/menu/products">Review the menu</Link> — mark it unavailable, or drop it.
        </p>
      )}
    </SectionCard>
  );
}

// How long since anyone ordered it. "Never" is the one worth colouring.
function LastSold({ days }) {
  if (days === null) {
    return (
      <span className="badge badge-danger status-badge">
        <span className="badge-dot" aria-hidden="true" />
        Never sold
      </span>
    );
  }

  if (days === 0) {
    return <span>Today</span>;
  }

  if (days === 1) {
    return <span>Yesterday</span>;
  }

  return <span className={days >= 30 ? "text-danger" : ""}>{days} days ago</span>;
}
