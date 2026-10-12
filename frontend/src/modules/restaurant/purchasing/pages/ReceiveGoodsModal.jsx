import { useState } from "react";
import Modal from "../../../../components/Modal";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage } from "../../../../components/Feedback";
import { receivePurchaseOrder } from "../services/purchase.service";
import { getErrorMessage } from "../../../../services/api";
import { money, moneyExact } from "../../../../services/format";
import { today } from "../../../../services/dates";
import { GST_RATES, PAYMENT_METHODS, priceText, qty, unitMoney } from "../../inventory/pages/stockFormat";
import { billTotals, priceLine, round2 } from "./lineMath";

const round3 = (value) => Math.round(Number(value) * 1000) / 1000;

// Goods arriving against an order, checked at the back door: what came in,
// what was turned away and why, the supplier's bill number and the price they
// actually charged. Everything outstanding starts filled in — the usual case
// is "it all came" — so the person receiving only changes what differs.
export default function ReceiveGoodsModal({ order, currency, canPay, onClose, onReceived }) {
  const open = order.items.filter((line) => line.outstandingQuantity > 0);

  const [header, setHeader] = useState({
    billNumber: "",
    billDate: today(),
    receivedDate: today(),
    pricesIncludeTax: false,
    billTotal: "",
    notes: "",
  });
  const [payment, setPayment] = useState({ mode: "credit", method: "cash", fromTill: false });
  const [lines, setLines] = useState(() =>
    open.map((line) => {
      const inPacks = line.packSize !== null;
      const outstandingIn = inPacks ? round3(line.outstandingQuantity / line.packSize) : line.outstandingQuantity;

      return {
        itemId: line.id,
        accepted: String(outstandingIn),
        rejected: "",
        reason: "",
        // The order's price as it is, decimals and all (₹0.14333333 a ml
        // from Waste & reorder), so "Receive goods" works without retyping.
        price: priceText(inPacks && line.packPrice !== null ? line.packPrice : line.unitPrice),
        taxRate: "0",
      };
    })
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const byId = new Map(order.items.map((line) => [line.id, line]));
  const change = (index, patch) =>
    setLines(lines.map((line, position) => (position === index ? { ...line, ...patch } : line)));

  const asBill = lines.map((line) => ({
    quantity: line.accepted,
    unitPrice: line.price,
    taxRate: line.taxRate,
    inPacks: byId.get(line.itemId).packSize !== null,
  }));
  // Turned away is part of what came for the order: no more than was still
  // due on the line (the server refuses more, naming the item).
  const outstandingIn = (source) =>
    source.packSize !== null ? round3(source.outstandingQuantity / source.packSize) : source.outstandingQuantity;
  const overRejected = (line) => Number(line.rejected || 0) > outstandingIn(byId.get(line.itemId)) + 0.0005;
  const anyOverRejected = lines.some(overRejected);
  const totals = billTotals(asBill, header.pricesIncludeTax);
  const typedTotal = header.billTotal === "" ? null : Number(header.billTotal);
  const difference = typedTotal === null ? 0 : round2(typedTotal - totals.total);

  const setAll = (fill) =>
    setLines(
      lines.map((line) => {
        const source = byId.get(line.itemId);
        const outstandingIn =
          source.packSize !== null ? round3(source.outstandingQuantity / source.packSize) : source.outstandingQuantity;

        return { ...line, accepted: fill ? String(outstandingIn) : "0" };
      })
    );

  // One line per item still to come: what arrived, what was turned away
  // (and why), the price the bill charged and its GST. ctx.index is the
  // line's place in `lines` (an editor never sorts or pages).
  const sourceOf = (line) => byId.get(line.itemId);
  const unitOf = (source) => (source.packSize !== null ? source.packName : source.unitShortName);
  const lineColumns = [
    {
      key: "item",
      header: "Item",
      value: (line) => sourceOf(line).itemName,
      minWidth: 200,
      render: (line, ctx) => {
        const source = sourceOf(line);
        const inPacks = source.packSize !== null;

        return (
          <>
            <strong>{source.itemName}</strong>
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
            <span className="stk-line-note">
              Ordered {inPacks ? `${qty(source.packQuantity)} × ${source.packName}` : qty(source.quantity, source.unitShortName)}
              {source.receivedQuantity > 0 ? ` · ${qty(source.receivedQuantity, source.unitShortName)} already in` : ""}
            </span>
          </>
        );
      },
    },
    {
      key: "due",
      header: "Still to come",
      type: "number",
      value: (line) => outstandingIn(sourceOf(line)),
      width: 110,
      render: (line) => {
        const source = sourceOf(line);

        return source.packSize !== null
          ? `${qty(round3(source.outstandingQuantity / source.packSize))} ${source.packName}`
          : qty(source.outstandingQuantity, source.unitShortName);
      },
    },
    {
      key: "accepted",
      header: "Accepted",
      type: "number",
      value: (line) => Number(line.accepted) || 0,
      width: 104,
      render: (line, ctx) => {
        const source = sourceOf(line);

        return (
          <>
            <input
              type="number"
              min="0"
              step="0.001"
              value={line.accepted}
              onChange={(event) => change(ctx.index, { accepted: event.target.value })}
              aria-label={`${source.itemName} accepted, in ${unitOf(source)}`}
            />
            <span className="stk-line-note">{unitOf(source)}</span>
          </>
        );
      },
    },
    {
      key: "rejected",
      header: "Turned away",
      type: "number",
      value: (line) => Number(line.rejected) || 0,
      width: 120,
      render: (line, ctx) => {
        const source = sourceOf(line);

        return (
          <>
            <input
              type="number"
              min="0"
              step="0.001"
              value={line.rejected}
              placeholder="0"
              onChange={(event) => change(ctx.index, { rejected: event.target.value })}
              aria-label={`${source.itemName} turned away`}
              aria-invalid={overRejected(line) || undefined}
            />
            {overRejected(line) && (
              <span className="stk-line-warn">
                More than the {qty(outstandingIn(source))} {unitOf(source)} still due
              </span>
            )}
            {Number(line.rejected) > 0 && (
              <input
                value={line.reason}
                onChange={(event) => change(ctx.index, { reason: event.target.value })}
                placeholder="Why?"
                aria-label={`Why ${source.itemName} was turned away`}
                maxLength={150}
                required
                style={{ marginTop: 4, textAlign: "left" }}
              />
            )}
          </>
        );
      },
    },
    {
      key: "price",
      header: header.pricesIncludeTax ? "Billed incl. GST" : "Billed price",
      type: "number",
      value: (line) => Number(line.price) || 0,
      width: 126,
      render: (line, ctx) => {
        const source = sourceOf(line);
        const listed = source.packSize !== null && source.packPrice !== null ? source.packPrice : source.unitPrice;
        const priceChanged = Number(line.price) !== Number(listed);

        return (
          <>
            <input
              type="number"
              min="0"
              step="any"
              value={line.price}
              onChange={(event) => change(ctx.index, { price: event.target.value })}
              aria-label={`${source.itemName} billed price per ${unitOf(source)}`}
            />
            <span className={`stk-line-note ${priceChanged ? "stk-var-short" : ""}`}>
              {priceChanged ? `Ordered at ${unitMoney(listed, currency)}` : `per ${unitOf(source)}`}
            </span>
          </>
        );
      },
    },
    {
      key: "gst",
      header: "GST",
      type: "number",
      value: (line) => Number(line.taxRate) || 0,
      width: 90,
      render: (line, ctx) => (
        <select
          value={line.taxRate}
          onChange={(event) => change(ctx.index, { taxRate: event.target.value })}
          aria-label={`${sourceOf(line).itemName} GST rate`}
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
      value: (line) => priceLine(asBill[lines.indexOf(line)], header.pricesIncludeTax).amount,
      render: (line, ctx) => money(priceLine(asBill[ctx.index], header.pricesIncludeTax).amount, currency),
    },
  ];

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);

    try {
      const received = await receivePurchaseOrder(order.id, {
        billNumber: header.billNumber || null,
        billDate: header.billDate,
        receivedDate: header.receivedDate,
        pricesIncludeTax: header.pricesIncludeTax,
        billTotal: typedTotal,
        notes: header.notes || null,
        paymentMode: payment.mode,
        paymentMethod: payment.method,
        paidFromTill: payment.mode === "paid" && payment.method === "cash" && payment.fromTill,
        lines: lines
          .filter((line) => Number(line.accepted || 0) > 0 || Number(line.rejected || 0) > 0)
          .map((line) => ({
            itemId: line.itemId,
            quantity: Number(line.accepted || 0),
            rejectedQuantity: Number(line.rejected || 0),
            rejectionReason: line.reason || null,
            unitPrice: Number(line.price || 0),
            taxRate: Number(line.taxRate || 0),
            batchNumber: line.batchNumber || null,
            expiryDate: line.expiryDate || null,
          })),
      });

      onReceived(received);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Receive goods — ${order.poNumber} · ${order.supplierName}`}
      description="Type what arrived against the supplier's bill. Stock goes up, and the supplier is owed the bill."
      icon="truck"
      onClose={onClose}
      width={1000}
    >
      <form className="stack stk-scope" onSubmit={submit}>
        <ErrorMessage message={error} />

        {/* Raised for an outlet that has closed since: nothing can go on its
            shelf, so the goods are received into the main store. */}
        {order.outletClosed && (
          <div className="alert alert-notice" role="note">
            This order was raised for <strong>{order.storeName}</strong>, which is now closed. These goods will go
            into the <strong>main store</strong>.
          </div>
        )}

        <div className="form-grid">
          <label className="field">
            <span>Supplier's bill number</span>
            <input
              value={header.billNumber}
              onChange={(event) => setHeader({ ...header, billNumber: event.target.value })}
              placeholder="As printed on their bill"
              maxLength={50}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Bill date</span>
            <input
              type="date"
              value={header.billDate}
              max={today()}
              onChange={(event) => setHeader({ ...header, billDate: event.target.value })}
              required
            />
          </label>
          <label className="field">
            <span>Received on</span>
            <input
              type="date"
              value={header.receivedDate}
              min={header.billDate}
              max={today()}
              onChange={(event) => setHeader({ ...header, receivedDate: event.target.value })}
              required
            />
          </label>
          <label className="checkbox" style={{ alignSelf: "end" }}>
            <input
              type="checkbox"
              checked={header.pricesIncludeTax}
              onChange={(event) => setHeader({ ...header, pricesIncludeTax: event.target.checked })}
            />
            <span>Prices on the bill include GST</span>
          </label>
        </div>

        <div className="stk-actions">
          <span className="muted small">Filled in with everything still to come. Change what differs.</span>
          <button type="button" className="link-button" onClick={() => setAll(true)}>
            All as ordered
          </button>
          <button type="button" className="link-button" onClick={() => setAll(false)}>
            Clear
          </button>
        </div>

        <div className="stk-lines">
          {/* The bill's taxable value, GST and total are worked out below the
              lines (as the server does), so the grid adds no totals of its own. */}
          <DataGrid
            variant="editor"
            caption={`Lines arriving against ${order.poNumber}`}
            columns={lineColumns}
            rows={lines}
            rowKey={(line) => line.itemId}
            currency={currency}
          />
        </div>

        <div className="stk-foot">
          <div className="stack" style={{ flex: "1 1 320px" }}>
            <div className="field">
              <span>Payment</span>
              <div className="stk-choice" role="radiogroup" aria-label="Payment">
                <label>
                  <input
                    type="radio"
                    name="receive-payment"
                    checked={payment.mode === "credit"}
                    onChange={() => setPayment({ ...payment, mode: "credit" })}
                  />
                  On credit
                </label>
                {canPay && (
                  <label>
                    <input
                      type="radio"
                      name="receive-payment"
                      checked={payment.mode === "paid"}
                      onChange={() => setPayment({ ...payment, mode: "paid" })}
                    />
                    Paid on delivery
                  </label>
                )}
              </div>
            </div>
            {payment.mode === "paid" && (
              <div className="stk-toolbar">
                <label className="field">
                  <span>Paid by</span>
                  <select value={payment.method} onChange={(event) => setPayment({ ...payment, method: event.target.value })}>
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method.value} value={method.value}>
                        {method.label}
                      </option>
                    ))}
                  </select>
                </label>
                {payment.method === "cash" && (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={payment.fromTill}
                      onChange={(event) => setPayment({ ...payment, fromTill: event.target.checked })}
                    />
                    <span>Cash taken from the till</span>
                  </label>
                )}
                {payment.method === "cash" && payment.fromTill && (
                  <small className="muted" style={{ flexBasis: "100%" }}>
                    Listed under Supplier accounts as paid from the till today, for the day-end cash count.
                  </small>
                )}
              </div>
            )}
            <label className="field">
              <span>Notes</span>
              <input value={header.notes} onChange={(event) => setHeader({ ...header, notes: event.target.value })} />
            </label>
          </div>

          <div className="stack" style={{ flex: "0 1 300px" }}>
            <dl className="stk-totals">
              <dt>Taxable value</dt>
              <dd>{moneyExact(totals.taxable, currency)}</dd>
              <dt>GST</dt>
              <dd>{moneyExact(totals.tax, currency)}</dd>
              <dt className="is-grand">Bill total</dt>
              <dd className="is-grand">{moneyExact(totals.total, currency)}</dd>
            </dl>
            <label className="field">
              <span>Total printed on the bill</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={header.billTotal}
                onChange={(event) => setHeader({ ...header, billTotal: event.target.value })}
                placeholder="Optional check"
              />
              {typedTotal !== null && (
                <span className={`stk-match ${Math.abs(difference) <= 1 ? "is-ok" : "is-off"}`}>
                  {Math.abs(difference) <= 1
                    ? difference === 0
                      ? "Matches the lines"
                      : `Matches, round off ${moneyExact(difference, currency)}`
                    : `Off by ${moneyExact(difference, currency)} — check the lines`}
                </span>
              )}
            </label>
          </div>
        </div>

        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="button"
            disabled={saving || anyOverRejected}
            title={anyOverRejected ? "More is turned away than was still due on a line" : undefined}
          >
            {saving ? "Saving…" : "Receive goods"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
