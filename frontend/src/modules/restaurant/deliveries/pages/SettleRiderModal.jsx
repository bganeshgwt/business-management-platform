import { useEffect, useMemo, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "../../../../components/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { moneyExact } from "../../../../services/format";
import { dayMonth } from "../../../../services/dates";
import { getRiderSettlement, settleRider, settleRiderWriteOff } from "../services/delivery.service";

const paise = (value) => Math.round(Number(value || 0) * 100);

// "Settle cash" for one rider back from his runs (SW-A-19). His delivered,
// unpaid bills are listed with what each still owes; the cashier marks the
// ones the guest paid by UPI at the door, counts the cash and saves: every
// bill is paid in one step, in today's business day. A shortfall is kept as
// owed by the rider, or written off by a manager, with a reason.
export default function SettleRiderModal({ rider, currency, onClose, onDone }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [lines, setLines] = useState([]);
  const [counted, setCounted] = useState("");
  const [action, setAction] = useState("owed");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getRiderSettlement(rider.id)
      .then((result) => {
        setData(result);
        setLines(result.bills.map((bill) => ({ ...bill, take: true, method: "cash", upiRef: "" })));
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [rider.id]);

  const taken = lines.filter((line) => line.take);
  const cashExpected = taken.filter((line) => line.method === "cash").reduce((sum, line) => sum + paise(line.due), 0);
  const upiAmount = taken.filter((line) => line.method === "upi").reduce((sum, line) => sum + paise(line.due), 0);
  const countedPaise = counted === "" ? null : paise(counted);
  const shortfall = countedPaise === null ? 0 : cashExpected - countedPaise;
  const over = countedPaise !== null && countedPaise > cashExpected;

  const setLine = (billId, field, value) =>
    setLines((all) => all.map((line) => (line.billId === billId ? { ...line, [field]: value } : line)));

  const columns = useMemo(
    () => [
      {
        key: "take",
        header: "Settle",
        label: "Settle this bill",
        value: (line) => (line.take ? 1 : 0),
        render: (line, ctx) => (
          <input
            type="checkbox"
            aria-label={ctx.label}
            checked={line.take}
            onChange={(event) => setLine(line.billId, "take", event.target.checked)}
          />
        ),
      },
      {
        key: "bill",
        header: "Bill",
        value: (line) => line.billNumber,
        render: (line) => (
          <span className="srm-bill">
            <strong>{line.billNumber}</strong>
            <span className="muted small">
              {line.orderNumber}
              {line.customerName ? ` · ${line.customerName}` : ""}
            </span>
          </span>
        ),
      },
      {
        key: "delivered",
        header: "Delivered",
        value: (line) => line.businessDate,
        render: (line) => (line.deliveredAt ? dayMonth(line.deliveredAt) : "—"),
      },
      { key: "due", header: "To collect", type: "money", exact: true, value: (line) => line.due, total: "sum" },
      {
        key: "method",
        header: "Guest paid by",
        value: (line) => line.method,
        render: (line) => (
          <span className="srm-method">
            <span className="segmented" role="radiogroup" aria-label={`${line.billNumber} paid by`}>
              {["cash", "upi"].map((method) => (
                <button
                  key={method}
                  type="button"
                  role="radio"
                  aria-checked={line.method === method}
                  className={`segment ${line.method === method ? "is-active" : ""}`}
                  onClick={() => setLine(line.billId, "method", method)}
                  disabled={!line.take}
                >
                  {method === "cash" ? "Cash" : "UPI"}
                </button>
              ))}
            </span>
            {line.method === "upi" && line.take && (
              <input
                className="srm-ref"
                value={line.upiRef}
                onChange={(event) => setLine(line.billId, "upiRef", event.target.value)}
                maxLength={60}
                placeholder="UPI ref (optional)"
                aria-label={`${line.billNumber} UPI reference`}
              />
            )}
          </span>
        ),
      },
    ],
    []
  );

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      bills: taken.map((line) => ({ billId: line.billId, method: line.method, upiRef: line.upiRef.trim() || null })),
      cashHanded: (countedPaise ?? 0) / 100,
      shortfallReason: shortfall > 0 ? reason.trim() : null,
    };

    try {
      const result =
        shortfall > 0 && action === "write_off"
          ? await withApproval(
              (headers) => settleRiderWriteOff(rider.id, payload, headers),
              `Write off ${moneyExact(shortfall / 100, currency)} short from ${rider.name}`,
              { permission: "deliveries.write_off_shortfall", scope: { amount: shortfall / 100 } }
            )
          : await settleRider(rider.id, payload);
      onDone(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
      setSaving(false);
    }
  };

  const ready =
    taken.length > 0 &&
    countedPaise !== null &&
    !over &&
    (shortfall <= 0 || reason.trim().length > 0);

  return (
    <Modal
      title={`Settle cash · ${rider.name}`}
      description="Pay his delivered bills in one go: tick what the guest paid by UPI, count the cash he hands in."
      icon="wallet"
      onClose={onClose}
      width={820}
    >
      {!data && !error && <Loading label="Finding his bills…" />}
      {data && (
        <form className="stack srm" onSubmit={save}>
          {data.unbilled.length > 0 && (
            <p className="alert alert-notice">
              {data.unbilled.length === 1 ? "One delivery is" : `${data.unbilled.length} deliveries are`} not billed
              yet ({data.unbilled.map((order) => order.orderNumber).join(", ")}). Bill {data.unbilled.length === 1 ? "it" : "them"}{" "}
              in Bills first to settle {data.unbilled.length === 1 ? "it" : "them"} here.
            </p>
          )}

          {lines.length === 0 ? (
            <p className="muted">Nothing to settle: every bill {rider.name} delivered is paid.</p>
          ) : (
            <>
              <DataGrid
                variant="editor"
                caption={`${rider.name}'s delivered bills`}
                columns={columns}
                rows={lines}
                rowKey={(line) => line.billId}
                currency={currency}
                rowNoun={["bill", "bills"]}
              />

              <div className="srm-sum">
                <div>
                  <span className="muted small">Cash bills</span>
                  <strong>{moneyExact(cashExpected / 100, currency)}</strong>
                </div>
                <div>
                  <span className="muted small">Paid by UPI</span>
                  <strong>{moneyExact(upiAmount / 100, currency)}</strong>
                </div>
                <label className="field srm-counted">
                  <span>Cash handed in *</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={counted}
                    onChange={(event) => setCounted(event.target.value)}
                    placeholder={String(cashExpected / 100)}
                    required
                  />
                </label>
              </div>

              {over && (
                <p className="alert">
                  That is more than the cash bills come to. Count again, or check which bills were paid by UPI.
                </p>
              )}

              {shortfall > 0 && !over && (
                <div className="srm-short">
                  <p className="srm-short-head">
                    <Icon name="alert" size={16} /> {rider.name} is {moneyExact(shortfall / 100, currency)} short.
                  </p>
                  <div className="segmented" role="radiogroup" aria-label="What happens to the shortfall">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={action === "owed"}
                      className={`segment ${action === "owed" ? "is-active" : ""}`}
                      onClick={() => setAction("owed")}
                    >
                      He owes it
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={action === "write_off"}
                      className={`segment ${action === "write_off" ? "is-active" : ""}`}
                      onClick={() => setAction("write_off")}
                    >
                      Write it off (manager)
                    </button>
                  </div>
                  <label className="field">
                    <span>Why? *</span>
                    <input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={200}
                      placeholder="Gave change from his own pocket, a guest paid short…"
                    />
                  </label>
                  <p className="muted small">
                    {action === "owed"
                      ? "It stays on the Rider cash list until he hands it over."
                      : "Writing it off needs a manager; without that permission a manager approves with their PIN."}
                  </p>
                </div>
              )}
            </>
          )}

          <ErrorMessage message={error} />

          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Close
            </button>
            {lines.length > 0 && (
              <button type="submit" className="button" disabled={!ready || saving}>
                {saving ? "Settling…" : `Settle ${taken.length} ${taken.length === 1 ? "bill" : "bills"}`}
              </button>
            )}
          </div>
        </form>
      )}
      {!data && error && <ErrorMessage message={error} />}
    </Modal>
  );
}
