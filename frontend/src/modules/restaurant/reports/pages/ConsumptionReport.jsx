// Stock consumption tab of the Reports screen.

import { useMemo } from "react";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";

// Stock bought, used and wasted, busiest first; every item is paged through.
export default function ConsumptionReport({ data, currency }) {
  const columns = useMemo(
    () => [
      { key: "item", header: "Item", value: (row) => row.itemName, mobile: "title", className: "report-strong", filter: "text" },
      {
        key: "purchased",
        header: "Purchased",
        type: "number",
        value: (row) => row.purchased,
        render: (row) => `${row.purchased} ${row.unitShortName}`,
      },
      { key: "purchaseValue", header: "Purchase value", type: "money", value: (row) => row.purchaseValue, total: "sum", mobile: "show" },
      {
        key: "consumed",
        header: "Used",
        type: "number",
        value: (row) => row.consumed,
        render: (row) => `${row.consumed} ${row.unitShortName}`,
        mobile: "show",
      },
      { key: "consumedValue", header: "Used value", type: "money", value: (row) => row.consumedValue, total: "sum", mobile: "show" },
      {
        key: "wasted",
        header: "Wasted",
        type: "number",
        value: (row) => row.wasted,
        render: (row) => <span className={row.wasted > 0 ? "text-danger" : ""}>{`${row.wasted} ${row.unitShortName}`}</span>,
      },
      { key: "wastedValue", header: "Waste value", type: "money", value: (row) => row.wastedValue, total: "sum", mobile: "show" },
      {
        key: "stock",
        header: "In stock",
        type: "number",
        value: (row) => row.currentStock,
        render: (row) => (
          <span className={row.currentStock < 0 ? "text-danger" : ""}>{`${row.currentStock} ${row.unitShortName}`}</span>
        ),
      },
    ],
    []
  );

  return (
    <SectionCard
      icon="box"
      tone="info"
      title="Stock movement in this period"
      description="Used is what sales and kitchen issues took out, less what voided bills put back. Valued at each item's latest cost."
      flush
    >
      <DataGrid
        id="report-consumption"
        caption="Stock movement"
        columns={columns}
        rows={data.rows}
        rowKey={(row) => row.itemName}
        empty="No stock moved in this period."
        emptyHint="Stock moves when it is bought, sold through a recipe, issued to the kitchen or written off."
        emptyIcon="box"
        exportName="stock-consumption"
        currency={currency}
        rowNoun={["item", "items"]}
      />
    </SectionCard>
  );
}
