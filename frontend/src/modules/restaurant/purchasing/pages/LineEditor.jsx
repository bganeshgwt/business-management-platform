import Icon from "../../../../components/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { money, moneyExact } from "../../../../services/format";
import { GST_RATES, priceText, qty, unitMoney } from "../../inventory/pages/stockFormat";
import { EMPTY_LINE, buyingUnit, packOf, priceLine } from "./lineMath";

// A key for each line that survives edits. Lines have no id of their own (a
// new one is a copy of EMPTY_LINE, and the order or bill keeps them in plain
// arrays), and keying rows by position would move the box being typed in
// when a line above it is removed. A line object gets a key the first time
// it is drawn; the copy made when it changes inherits it (keepKey).
const lineKeys = new WeakMap();
let lastLineKey = 0;

const lineKey = (line) => {
  if (!lineKeys.has(line)) {
    lastLineKey += 1;
    lineKeys.set(line, `line-${lastLineKey}`);
  }

  return lineKeys.get(line);
};

const keepKey = (from, to) => {
  lineKeys.set(to, lineKey(from));
  return to;
};

// The lines of an order or a supplier bill: item, the pack it comes in (or
// the item's own unit), quantity and price — plus GST and goods turned away
// for a bill. One editor for both, so an order and a bill read the same way.
export default function LineEditor({
  lines,
  onChange,
  items,
  currency,
  withTax = false,
  withRejects = false,
  pricesIncludeTax = false,
  priceHint = true,
}) {
  const byId = new Map(items.map((item) => [String(item.id), item]));

  // A changed line is a new object; it keeps its line's key, so the row (and
  // the box being typed in) stays put.
  const change = (index, patch) =>
    onChange(lines.map((line, position) => (position === index ? keepKey(line, { ...line, ...patch }) : line)));

  // Picking an item (or a pack) starts the price from what it last cost,
  // which is right more often than an empty box. A cost per ml keeps its
  // decimals: ₹0.14333333, not ₹0.14, or 15,000 ml comes to ₹2,100.
  const pick = (index, value) => {
    const item = byId.get(value);
    const suggested = priceHint && item && item.lastCost !== null ? priceText(item.lastCost) : "";

    change(index, { inventoryItemId: value, packId: "", unitPrice: lines[index].unitPrice || suggested });
  };

  const pickPack = (index, value) => {
    const line = lines[index];
    const item = byId.get(String(line.inventoryItemId));
    const pack = packOf(item, value);
    const unitCost = item && item.lastCost !== null ? item.lastCost : null;

    change(index, {
      packId: value,
      unitPrice:
        priceHint && unitCost !== null
          ? String(Math.round(unitCost * (pack ? pack.size : 1) * 100) / 100)
          : line.unitPrice,
    });
  };

  const used = new Set(lines.map((line) => `${line.inventoryItemId}`));
  const priced = (line) => priceLine(withTax ? line : { ...line, taxRate: 0 }, pricesIncludeTax);

  // ctx.index is the line's place in `lines` (an editor never sorts), so
  // every change goes to the line it was typed on.
  const columns = [
    {
      key: "item",
      header: "Item",
      value: (line) => (byId.get(String(line.inventoryItemId)) || {}).name || "",
      minWidth: 200,
      render: (line, ctx) => {
        const item = byId.get(String(line.inventoryItemId));

        return (
          <>
            <select
              value={line.inventoryItemId}
              onChange={(event) => pick(ctx.index, event.target.value)}
              aria-label={ctx.label}
              required
            >
              <option value="">Select item</option>
              {items.map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  disabled={used.has(String(option.id)) && String(option.id) !== String(line.inventoryItemId)}
                >
                  {option.name} ({option.unitShortName})
                </option>
              ))}
            </select>
            {withRejects && (
              <>
                <label className="field">
                  Batch / lot
                  <input
                    maxLength={100}
                    value={line.batchNumber || ""}
                    onChange={(event) => change(ctx.index, { batchNumber: event.target.value })}
                  />
                </label>
                <label className="field">
                  Expiry
                  <input
                    type="date"
                    value={line.expiryDate || ""}
                    onChange={(event) => change(ctx.index, { expiryDate: event.target.value })}
                  />
                </label>
              </>
            )}
            {item && item.lastCost !== null && (
              <span className="stk-line-note">
                Last cost {unitMoney(item.lastCost, currency)}/{item.unitShortName}
                {item.currentStock !== undefined && item.currentStock !== null
                  ? ` · ${qty(item.currentStock, item.unitShortName)} in stock`
                  : ""}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: "pack",
      header: "Bought in",
      value: (line) => line.packId,
      width: 140,
      render: (line, ctx) => {
        const item = byId.get(String(line.inventoryItemId));
        const pack = packOf(item, line.packId);
        const base = pack ? Number(line.quantity || 0) * pack.size : Number(line.quantity || 0);

        return (
          <>
            <select
              value={line.packId}
              onChange={(event) => pickPack(ctx.index, event.target.value)}
              aria-label={ctx.label}
              disabled={!item || item.packs.length === 0}
            >
              <option value="">{item ? item.unitShortName : "—"}</option>
              {(item ? item.packs : []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({qty(option.size, item.unitShortName)})
                </option>
              ))}
            </select>
            {pack && line.quantity && <span className="stk-line-note">= {qty(base, item.unitShortName)}</span>}
          </>
        );
      },
    },
    {
      key: "quantity",
      header: withRejects ? "Accepted" : "Quantity",
      type: "number",
      value: (line) => Number(line.quantity) || 0,
      width: 104,
      render: (line, ctx) => (
        <input
          type="number"
          min={withRejects ? "0" : "0.001"}
          step="0.001"
          value={line.quantity}
          onChange={(event) => change(ctx.index, { quantity: event.target.value })}
          aria-label={`Quantity in ${buyingUnit(byId.get(String(line.inventoryItemId)), line.packId)}, line ${ctx.serial}`}
          required={!withRejects}
        />
      ),
    },
    withRejects && {
      key: "rejected",
      header: "Turned away",
      type: "number",
      value: (line) => Number(line.rejectedQuantity) || 0,
      width: 120,
      render: (line, ctx) => (
        <>
          <input
            type="number"
            min="0"
            step="0.001"
            value={line.rejectedQuantity}
            onChange={(event) => change(ctx.index, { rejectedQuantity: event.target.value })}
            aria-label={`Quantity turned away, line ${ctx.serial}`}
            placeholder="0"
          />
          {Number(line.rejectedQuantity) > 0 && (
            <input
              value={line.rejectionReason}
              onChange={(event) => change(ctx.index, { rejectionReason: event.target.value })}
              placeholder="Why? (damaged, short weight)"
              aria-label={`Why it was turned away, line ${ctx.serial}`}
              maxLength={150}
              required
              style={{ marginTop: 4, textAlign: "left" }}
            />
          )}
        </>
      ),
    },
    {
      key: "price",
      header: pricesIncludeTax ? "Price incl. GST" : "Price",
      type: "number",
      value: (line) => Number(line.unitPrice) || 0,
      width: 126,
      render: (line, ctx) => {
        const unit = buyingUnit(byId.get(String(line.inventoryItemId)), line.packId);

        return (
          <>
            {/* Any number of decimals: a price per ml or per egg is a
                fraction of a paisa, and the server keeps eight. */}
            <input
              type="number"
              min="0"
              step="any"
              value={line.unitPrice}
              onChange={(event) => change(ctx.index, { unitPrice: event.target.value })}
              aria-label={`Price per ${unit}, line ${ctx.serial}`}
              required
            />
            <span className="stk-line-note">per {unit || "unit"}</span>
          </>
        );
      },
    },
    withTax && {
      key: "gst",
      header: "GST",
      type: "number",
      value: (line) => Number(line.taxRate) || 0,
      width: 90,
      render: (line, ctx) => (
        <select
          value={line.taxRate}
          onChange={(event) => change(ctx.index, { taxRate: event.target.value })}
          aria-label={ctx.label}
        >
          {GST_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate}%
            </option>
          ))}
        </select>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      type: "money",
      width: 110,
      value: (line) => priced(line).amount,
      render: (line) => {
        const amounts = priced(line);

        return (
          <>
            {money(amounts.amount, currency)}
            {withTax && amounts.tax > 0 && (
              <span className="stk-line-note">GST {moneyExact(amounts.tax, currency)}</span>
            )}
          </>
        );
      },
    },
    {
      key: "remove",
      header: "",
      label: "Remove",
      type: "actions",
      render: (line, ctx) =>
        lines.length > 1 ? (
          <button
            type="button"
            className="stk-remove"
            aria-label={`Remove line ${ctx.serial}`}
            onClick={() => onChange(lines.filter((unused, i) => i !== ctx.index))}
          >
            <Icon name="x" size={16} />
          </button>
        ) : null,
    },
  ];

  return (
    <div className="stk-lines stack">
      {/* The form works out the order or bill total under the lines (GST,
          round off, the server's own rounding), so the grid adds none. */}
      <DataGrid variant="editor" caption="Lines" columns={columns} rows={lines} rowKey={lineKey} currency={currency} />
      <div>
        <button
          type="button"
          className="button button-secondary button-sm"
          onClick={() => onChange([...lines, { ...EMPTY_LINE }])}
        >
          <Icon name="plus" size={15} /> Add line
        </button>
      </div>
    </div>
  );
}
