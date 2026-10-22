import { useState } from "react";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import { createPurchaseBill } from "../services/purchase.service";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import { moneyExact } from "@bmp/shared/format";
import { today } from "@bmp/shared/dates";
import { PAYMENT_METHODS, niceDate } from "../../inventory/pages/stockFormat";
import LineEditor from "./LineEditor";
import { EMPTY_LINE, billTotals, round2 } from "./lineMath";

const addDays = (date, days) => {
  const at = new Date(`${date}T00:00:00`);
  at.setDate(at.getDate() + days);
  return at.toLocaleDateString("en-CA");
};

// A supplier's bill with no purchase order behind it — the morning's
// vegetables, the meat, the milk. Stock comes in at the billed price and the
// supplier is owed for it, or it is paid there and then.
export default function PurchaseBillModal({ suppliers, items, stores, currency, canPay, onClose, onSaved }) {
  const holding = stores.filter((store) => !store.outletId || store.ownStore);
  const current = outletStorage.get();
  const startStore = holding.find((store) => String(store.outletId) === String(current));

  const [form, setForm] = useState({
    supplierId: suppliers[0] ? String(suppliers[0].id) : "",
    billNumber: "",
    billDate: today(),
    receivedDate: today(),
    store: startStore ? String(startStore.outletId) : "main",
    pricesIncludeTax: false,
    billTotal: "",
    notes: "",
  });
  const [payment, setPayment] = useState({ mode: "credit", method: "cash", fromTill: false, reference: "" });
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const supplier = suppliers.find((row) => String(row.id) === String(form.supplierId));
  const filled = lines.filter((line) => line.inventoryItemId && (Number(line.quantity) > 0 || Number(line.rejectedQuantity) > 0));
  const totals = billTotals(filled, form.pricesIncludeTax);
  const typedTotal = form.billTotal === "" ? null : Number(form.billTotal);
  const difference = typedTotal === null ? 0 : round2(typedTotal - totals.total);
  const creditDays = supplier && supplier.creditDays !== null ? supplier.creditDays : 0;

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);

    try {
      const bill = await createPurchaseBill({
        supplierId: Number(form.supplierId),
        billNumber: form.billNumber || null,
        billDate: form.billDate,
        receivedDate: form.receivedDate,
        outletId: form.store === "main" ? null : Number(form.store),
        pricesIncludeTax: form.pricesIncludeTax,
        billTotal: typedTotal,
        notes: form.notes || null,
        paymentMode: payment.mode,
        paymentMethod: payment.method,
        paidFromTill: payment.mode === "paid" && payment.method === "cash" && payment.fromTill,
        paymentReference: payment.reference || null,
        lines: filled.map((line) => ({
          inventoryItemId: Number(line.inventoryItemId),
          packId: line.packId ? Number(line.packId) : null,
          quantity: Number(line.quantity || 0),
          rejectedQuantity: Number(line.rejectedQuantity || 0),
          rejectionReason: line.rejectionReason || null,
          unitPrice: Number(line.unitPrice || 0),
          taxRate: Number(line.taxRate || 0),
            batchNumber: line.batchNumber || null,
            expiryDate: line.expiryDate || null,
        })),
      });

      onSaved(bill);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Enter a purchase bill"
      description="For goods bought without a purchase order: the daily vegetables, meat, fish and milk."
      icon="receipt"
      onClose={onClose}
      width={1040}
    >
      <form className="stack stk-scope" onSubmit={submit}>
        <ErrorMessage message={error} />

        <p className="muted small">
          Stock goes up at the price on the bill, GST included, and the supplier is owed the bill total.
        </p>

        <div className="form-grid">
          <label className="field">
            <span>Supplier</span>
            <select
              value={form.supplierId}
              onChange={(event) => setForm({ ...form, supplierId: event.target.value })}
              required
            >
              {suppliers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
            {supplier && (
              <small className="muted">
                {supplier.gstNumber ? `GSTIN ${supplier.gstNumber}` : "No GSTIN on record"} ·{" "}
                {creditDays > 0 ? `${creditDays} days credit` : "cash on delivery"}
              </small>
            )}
          </label>
          <label className="field">
            <span>Bill number</span>
            <input
              value={form.billNumber}
              onChange={(event) => setForm({ ...form, billNumber: event.target.value })}
              placeholder="As printed on the bill"
              maxLength={50}
            />
          </label>
          <label className="field">
            <span>Bill date</span>
            <input
              type="date"
              value={form.billDate}
              max={today()}
              onChange={(event) =>
                setForm({
                  ...form,
                  billDate: event.target.value,
                  receivedDate: form.receivedDate < event.target.value ? event.target.value : form.receivedDate,
                })
              }
              required
            />
          </label>
          <label className="field">
            <span>Received on</span>
            <input
              type="date"
              value={form.receivedDate}
              min={form.billDate}
              max={today()}
              onChange={(event) => setForm({ ...form, receivedDate: event.target.value })}
              required
            />
          </label>
          {holding.length > 1 && (
            <label className="field">
              <span>Goods go to</span>
              <select value={form.store} onChange={(event) => setForm({ ...form, store: event.target.value })}>
                {holding.map((store) => (
                  <option key={store.outletId || "main"} value={store.outletId ? String(store.outletId) : "main"}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="checkbox" style={{ alignSelf: "end" }}>
            <input
              type="checkbox"
              checked={form.pricesIncludeTax}
              onChange={(event) => setForm({ ...form, pricesIncludeTax: event.target.checked })}
            />
            <span>Prices on the bill include GST</span>
          </label>
        </div>

        <LineEditor
          lines={lines}
          onChange={setLines}
          items={items}
          currency={currency}
          withTax
          withRejects
          pricesIncludeTax={form.pricesIncludeTax}
          priceHint={false}
        />

        <div className="stk-foot">
          <div className="stack" style={{ flex: "1 1 320px" }}>
            <div className="field">
              <span>Payment</span>
              <div className="stk-choice" role="radiogroup" aria-label="Payment">
                <label>
                  <input
                    type="radio"
                    name="bill-payment"
                    checked={payment.mode === "credit"}
                    onChange={() => setPayment({ ...payment, mode: "credit" })}
                  />
                  On credit{creditDays > 0 ? ` — due ${niceDate(addDays(form.billDate, creditDays))}` : " — due now"}
                </label>
                {canPay && (
                  <label>
                    <input
                      type="radio"
                      name="bill-payment"
                      checked={payment.mode === "paid"}
                      onChange={() => setPayment({ ...payment, mode: "paid" })}
                    />
                    Paid now
                  </label>
                )}
              </div>
              {!canPay && <small className="muted">Paying suppliers needs the Pay suppliers permission.</small>}
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
                {payment.method === "cash" ? (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={payment.fromTill}
                      onChange={(event) => setPayment({ ...payment, fromTill: event.target.checked })}
                    />
                    <span>Cash taken from the till</span>
                    {payment.fromTill && (
                      <small className="muted"> — listed under Supplier accounts as paid from the till today</small>
                    )}
                  </label>
                ) : (
                  <label className="field">
                    <span>Reference</span>
                    <input
                      value={payment.reference}
                      onChange={(event) => setPayment({ ...payment, reference: event.target.value })}
                      placeholder="UPI / NEFT ref"
                      maxLength={50}
                    />
                  </label>
                )}
              </div>
            )}
            <label className="field">
              <span>Notes</span>
              <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
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
                value={form.billTotal}
                onChange={(event) => setForm({ ...form, billTotal: event.target.value })}
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
          <button type="submit" className="button" disabled={saving || filled.length === 0}>
            {saving ? "Saving…" : "Save bill and add stock"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
