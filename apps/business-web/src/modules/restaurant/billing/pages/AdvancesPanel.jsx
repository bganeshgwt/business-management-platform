import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import { getAdvance, getAdvanceGst, listAdvances, refundAdvance, takeAdvance } from "../services/bill.service";
import { searchGuests } from "../../crm/services/crm.service";
import { listPaymentTypes } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { moneyExact } from "@bmp/shared/format";
import { dayMonth } from "@bmp/shared/dates";
import { escapeHtml, printDocument } from "../../../../services/print";
import { BILL_PAYMENT_OPTIONS, paymentMethodLabel } from "../../../../services/labels";
import useAuth from "../../../../hooks/useAuth";
import { Status } from "../../business-day/pages/moneyUi";

// Advances and deposits: money a guest or a company pays
// ahead — a birthday party's deposit, half of a bulk order — held for them
// and used on the final bill ("Advance" when taking the payment). It is not a
// sale when it comes in: sales and GST count it on the bill it is used on.
// What is not used can be handed back, with a reason and a manager's say-so.

const STATUS = {
  held: { tone: "active", label: "Held" },
  part_used: { tone: "info", label: "Part used" },
  closed: { tone: "neutral", label: "Used up" },
};

export default function AdvancesPanel({ currency, heldTotal, onChanged }) {
  const { hasPermission } = useAuth();
  const canTake = hasPermission("payments.manage");

  const [show, setShow] = useState("held");
  const [range, setRange] = useState({ from: "", to: "" });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => rememberedPageSize("advances", 25));
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [taking, setTaking] = useState(false);
  const [opened, setOpened] = useState(null);
  const [types, setTypes] = useState([]);

  const mx = useCallback((value) => moneyExact(value, currency), [currency]);

  useEffect(() => {
    const params =
      show === "held"
        ? { status: "held", page, pageSize, search: search || undefined }
        : { status: "all", from: range.from || undefined, to: range.to || undefined, page, pageSize, search: search || undefined };

    listAdvances(params)
      .then((loaded) => {
        setData(loaded);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [show, range, search, page, pageSize, reload]);

  useEffect(() => {
    listPaymentTypes()
      .then((rows) => setTypes(rows.filter((row) => row.status === "active")))
      .catch(() => setTypes([]));
  }, []);

  const changed = (message) => {
    setNotice(message);
    setReload((count) => count + 1);
    if (onChanged) {
      onChanged();
    }
  };

  const columns = useMemo(
    () => [
      {
        key: "receipt",
        header: "Receipt",
        value: (row) => row.receiptNumber,
        mobile: "title",
        pin: true,
        render: (row) => <span className="mono nowrap">{row.receiptNumber}</span>,
      },
      { key: "date", header: "Received", type: "date", value: (row) => row.businessDate, mobile: "show" },
      {
        key: "guest",
        header: "Guest or company",
        value: (row) => row.customerName,
        mobile: "show",
        render: (row) => (
          <span className="dues-name">
            <strong>{row.customerName}</strong>
            {row.customerMobile ? <span className="muted small">{row.customerMobile}</span> : null}
          </span>
        ),
      },
      {
        key: "purpose",
        header: "For",
        value: (row) => row.purpose,
        render: (row) =>
          row.purpose || row.reservationDate ? (
            <span className="small">
              {row.purpose || "Booking"}
              {row.reservationDate ? <span className="muted"> · booking {dayMonth(row.reservationDate)}</span> : null}
            </span>
          ) : (
            <span className="muted">—</span>
          ),
      },
      {
        key: "method",
        header: "Paid by",
        value: (row) => row.paymentMethod,
        filter: "select",
        filterOptions: BILL_PAYMENT_OPTIONS,
        render: (row) => `${paymentMethodLabel(row.paymentMethod)}${row.paymentTypeName ? ` · ${row.paymentTypeName}` : ""}`,
      },
      { key: "amount", header: "Amount", type: "money", exact: true, total: "sum", value: (row) => row.amount },
      { key: "used", header: "Used on bills", type: "money", exact: true, total: "sum", value: (row) => row.usedAmount || null },
      { key: "back", header: "Handed back", type: "money", exact: true, total: "sum", value: (row) => row.refundedAmount || null, defaultHidden: true },
      {
        key: "held",
        header: "Held",
        type: "money",
        exact: true,
        total: "sum",
        value: (row) => row.heldAmount,
        mobile: "show",
        render: (row) => (row.heldAmount > 0 ? <strong className="dues-advance">{mx(row.heldAmount)}</strong> : <span className="muted">—</span>),
      },
      {
        key: "status",
        header: "Status",
        type: "status",
        value: (row) => row.status,
        mobile: "subtitle",
        render: (row) => <Status tone={(STATUS[row.status] || STATUS.held).tone}>{(STATUS[row.status] || STATUS.held).label}</Status>,
      },
    ],
    [mx]
  );

  const toolbar = (
    <>
      <div className="segmented" role="radiogroup" aria-label="Which advances">
        {[
          ["held", "Still held"],
          ["all", "Received in dates"],
        ].map(([key, label]) => (
          <button
            type="button"
            key={key}
            role="radio"
            aria-checked={show === key}
            className={`segment ${show === key ? "is-active" : ""}`}
            onClick={() => {
              setShow(key);
              setPage(1);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {show === "all" && (
        <DateRangeFilter
          from={range.from}
          to={range.to}
          onChange={(next) => {
            setRange(next);
            setPage(1);
          }}
          label="dates received"
        />
      )}
    </>
  );

  return (
    <>
      <SuccessMessage message={notice} />
      <div className="stat-grid">
        <StatTile icon="wallet" tone="success" label="Held for guests" value={mx(heldTotal)} note="Paid ahead, not used yet" />
        <StatTile
          icon="receipt"
          tone="primary"
          label={show === "held" ? "Advances still held" : "Received in these dates"}
          value={data ? String(data.total) : "…"}
          note={data ? `${mx(data.totals.amount)} taken · ${mx(data.totals.used)} used on bills` : ""}
        />
      </div>

      <SectionCard
        icon="wallet"
        tone="success"
        title="Advances and deposits"
        description="Taken ahead for a party, a bulk order or a booking. Not a sale yet: it becomes one on the bill it pays (pick Advance when taking the payment)."
        actions={
          canTake && (
            <button type="button" className="button" onClick={() => setTaking(true)}>
              <Icon name="plus" size={16} /> Take an advance
            </button>
          )
        }
        flush
      >
        <DataGrid
          id="advances"
          caption="Advances and deposits"
          columns={columns}
          rows={data ? data.items : []}
          rowKey={(row) => row.id}
          loading={!data && !error}
          error={error}
          onRetry={() => setReload((count) => count + 1)}
          currency={currency}
          rowNoun={["advance", "advances"]}
          toolbar={toolbar}
          onRowClick={(row) => setOpened(row.id)}
          search={{
            value: search,
            placeholder: "Receipt, guest, company or mobile",
            onChange: (value) => {
              setSearch(value);
              setPage(1);
            },
          }}
          server={{
            total: data ? data.total : 0,
            page,
            pageSize,
            totals: data ? { amount: data.totals.amount, used: data.totals.used, back: data.totals.refunded, held: data.totals.held } : undefined,
            onChange: ({ page: nextPage, pageSize: nextSize }) => {
              setPageSize(nextSize);
              setPage(nextSize !== pageSize ? 1 : nextPage);
            },
          }}
          empty={show === "held" ? "No advances are held right now." : "No advances were taken in these dates."}
          emptyHint="Take one when a guest pays ahead for a party, a bulk order or a booking."
          emptyIcon="wallet"
          rowClassName={(row) => (row.status === "closed" ? "dg-tone-muted" : "")}
          exportName="advances"
        />
      </SectionCard>

      <AdvanceGst currency={currency} />

      {taking && (
        <TakeAdvance
          currency={currency}
          types={types}
          onClose={() => setTaking(false)}
          onTaken={(advance, message) => {
            setTaking(false);
            changed(message);
            setOpened(advance.id);
          }}
        />
      )}
      {opened && (
        <AdvanceDetail
          id={opened}
          currency={currency}
          types={types}
          onClose={() => setOpened(null)}
          onChanged={changed}
        />
      )}
    </>
  );
}

// GSTR-1 tables 11A and 11B: advances received and not invoiced in the
// period, and earlier advances invoiced in it — at the restaurant's usual rate.
function AdvanceGst({ currency }) {
  const [range, setRange] = useState({ from: "", to: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const mx = (value) => moneyExact(value, currency);

  useEffect(() => {
    getAdvanceGst({ from: range.from || undefined, to: range.to || undefined })
      .then((loaded) => {
        setData(loaded);
        setError("");
        setRange((current) => (current.from ? current : { from: loaded.from, to: loaded.to }));
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [range.from, range.to]);

  return (
    <SectionCard
      icon="percent"
      tone="neutral"
      title="For the GST return"
      description={`Advances in GSTR-1 tables 11A and 11B, worked out at your usual rate${data ? ` (${data.rate}%)` : ""}. Give these to your accountant with the GST filing pack.`}
    >
      <div className="filters">
        <DateRangeFilter from={range.from} to={range.to} onChange={setRange} label="return period" />
      </div>
      <ErrorMessage message={error} />
      {!data ? (
        <Loading label="Working out the figures…" />
      ) : (
        <div className="stack advance-gst">
          <DataGrid
            id="advance-gst"
            caption="Advances for GSTR-1 tables 11A and 11B"
            variant="compact"
            pageSize={false}
            currency={currency}
            rowNoun={["line", "lines"]}
            rows={[
              { key: "11A", label: "11A · Received, not yet billed", ...data.table11A },
              { key: "11B", label: "11B · Billed this period, received earlier", ...data.table11B },
            ]}
            rowKey={(line) => line.key}
            columns={[
              { key: "label", header: "Table", value: (line) => line.label, mobile: "title" },
              { key: "gross", header: "Advance", type: "money", exact: true, value: (line) => line.gross, mobile: "show" },
              { key: "taxable", header: "Taxable value", type: "money", exact: true, value: (line) => line.taxable, mobile: "show" },
              { key: "cgst", header: "CGST", type: "money", exact: true, value: (line) => line.cgst, mobile: "show" },
              { key: "sgst", header: "SGST", type: "money", exact: true, value: (line) => line.sgst, mobile: "show" },
            ]}
          />
          <p className="muted small">
            {data.receivedCount} advance{data.receivedCount === 1 ? "" : "s"} received ({mx(data.received)}); {mx(data.usedSamePeriod)} of
            it was billed in the same period, so it is on the invoices instead.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

// Taking an advance: who, how much, how, and what it is for.
// The till's "Take advance" on a pickup order (takeaway ordered ahead): the
// order's guest is chosen already and the advance remembers the order, so its
// bill offers it first.
export function TakeOrderAdvance({ order, currency, onClose, onTaken }) {
  const [types, setTypes] = useState([]);

  useEffect(() => {
    listPaymentTypes()
      .then((rows) => setTypes(rows.filter((row) => row.status === "active")))
      .catch(() => setTypes([]));
  }, []);

  return <TakeAdvance currency={currency} types={types} order={order} onClose={onClose} onTaken={onTaken} />;
}

function TakeAdvance({ currency, types, order = null, onClose, onTaken }) {
  const [guest, setGuest] = useState(() =>
    order && order.customerId ? { id: order.customerId, name: order.customerName || "Guest", mobile: order.customerMobile || "" } : null
  );
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [form, setForm] = useState({
    amount: "",
    method: "cash",
    typeId: "",
    reference: "",
    purpose: order ? `Pickup order ${order.orderNumber}` : "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (guest || query.trim().length < 2) {
      return undefined;
    }

    const timer = setTimeout(() => {
      searchGuests(query.trim(), 8)
        .then((found) => setMatches(found.items || found.rows || []))
        .catch((err) => setError(getErrorMessage(err)));
    }, 250);

    return () => clearTimeout(timer);
  }, [query, guest]);

  const typesHere = types.filter((type) => type.paymentMethod === form.method);
  const chosenType = typesHere.find((type) => String(type.id) === String(form.typeId)) || null;

  const save = (event) => {
    event.preventDefault();

    if (!guest) {
      setError("Choose the guest or company first");
      return;
    }

    setBusy(true);
    setError("");
    takeAdvance({
      customerId: guest.id,
      amount: Number(form.amount),
      paymentMethod: form.method,
      paymentTypeId: form.typeId ? Number(form.typeId) : null,
      transactionRef: form.reference.trim() || null,
      purpose: form.purpose.trim() || null,
      orderId: order ? order.id : undefined,
    })
      .then((result) => onTaken(result.data, result.message))
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title={order ? `Advance on ${order.orderNumber}` : "Take an advance"}
      description={
        order
          ? "Money paid now for a pickup order. It goes into today's drawer (cash) and comes off this order's bill when the guest collects it."
          : "Money paid ahead and held for the guest. It goes into today's drawer (cash) and is used on their bill later."
      }
      icon="wallet"
      onClose={onClose}
      width={560}
    >
      <form className="stack" onSubmit={save}>
        <ErrorMessage message={error} />
        <div className="field">
          <span>Guest or company *</span>
          {guest ? (
            <div className="dues-picked">
              <span>
                <strong>{guest.companyName || guest.name}</strong>
                {guest.mobile ? <span className="muted small"> · {guest.mobile}</span> : null}
              </span>
              {!(order && order.customerId) && (
                <button type="button" className="button button-ghost button-sm" onClick={() => setGuest(null)}>
                  Change
                </button>
              )}
            </div>
          ) : (
            <>
              <input
                type="search"
                value={query}
                autoFocus
                placeholder="Search the guest book: name, company or mobile"
                onChange={(event) => setQuery(event.target.value)}
              />
              {matches.length > 0 && (
                <ul className="dues-matches">
                  {matches.map((row) => (
                    <li key={row.id}>
                      <button type="button" onClick={() => setGuest(row)}>
                        <strong>{row.companyName || row.name}</strong>
                        <span className="muted small">
                          {row.companyName ? `${row.name} · ` : ""}
                          {row.mobile || ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <small className="muted">Not in the guest book yet? Add them under Guests first.</small>
            </>
          )}
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Amount ({currency}) *</span>
            <input
              type="number"
              min="1"
              step="1"
              required
              value={form.amount}
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Paid by *</span>
            <select value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value, typeId: "" })}>
              {BILL_PAYMENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {typesHere.length > 0 && (
            <label className="field">
              <span>Type</span>
              <select value={form.typeId} onChange={(event) => setForm({ ...form, typeId: event.target.value })}>
                <option value="">None</option>
                {typesHere.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {form.method !== "cash" && (
            <label className="field">
              <span>Reference{chosenType && chosenType.needsReference ? " *" : ""}</span>
              <input
                value={form.reference}
                maxLength={100}
                placeholder="UTR / slip / cheque no."
                required={Boolean(chosenType && chosenType.needsReference)}
                onChange={(event) => setForm({ ...form, reference: event.target.value })}
              />
            </label>
          )}
          <label className="field field-wide">
            <span>What it is for</span>
            <input
              value={form.purpose}
              maxLength={200}
              placeholder="Birthday party, Sat 12 Oct, 40 guests"
              onChange={(event) => setForm({ ...form, purpose: event.target.value })}
            />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy || !guest || !(Number(form.amount) > 0)}>
            {busy ? "Saving…" : `Take ${moneyExact(Number(form.amount) || 0, currency)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The receipt for an advance, for the guest to keep.
const printReceipt = (advance, currency) => {
  const mx = (value) => escapeHtml(moneyExact(value, currency));

  printDocument({
    title: advance.receiptNumber,
    styles: `
      body { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; width: 272px; margin: 0 auto; color: #000; }
      @page { margin: 4mm; }
      .c { text-align: center; } .b { font-weight: bold; } .big { font-size: 15px; }
      table { width: 100%; border-collapse: collapse; margin-top: 6px; border-top: 1px dashed #000; }
      td { padding: 2px 0; vertical-align: top; } .r { text-align: right; }
    `,
    body: `
      <div class="c b big">${escapeHtml(advance.seller.name || "")}</div>
      ${advance.seller.address ? `<div class="c">${escapeHtml(advance.seller.address)}</div>` : ""}
      ${advance.seller.gstin ? `<div class="c">GSTIN: ${escapeHtml(advance.seller.gstin)}</div>` : ""}
      <div class="c b" style="margin-top:6px">ADVANCE RECEIPT</div>
      <table>
        <tr><td>Receipt no.</td><td class="r">${escapeHtml(advance.receiptNumber)}</td></tr>
        <tr><td>Date</td><td class="r">${escapeHtml(dayMonth(advance.receivedAt, { year: true, time: true }))}</td></tr>
        <tr><td>Received from</td><td class="r">${escapeHtml(advance.customerName)}</td></tr>
        ${advance.purpose ? `<tr><td>For</td><td class="r">${escapeHtml(advance.purpose)}</td></tr>` : ""}
        <tr><td>Paid by</td><td class="r">${escapeHtml(advance.methodLabel)}${advance.paymentTypeName ? ` · ${escapeHtml(advance.paymentTypeName)}` : ""}</td></tr>
        ${advance.transactionRef ? `<tr><td>Reference</td><td class="r">${escapeHtml(advance.transactionRef)}</td></tr>` : ""}
      </table>
      <table>
        <tr class="b"><td>AMOUNT RECEIVED</td><td class="r big">${mx(advance.amount)}</td></tr>
        ${advance.usedAmount ? `<tr><td>Used on bills</td><td class="r">${mx(advance.usedAmount)}</td></tr>` : ""}
        ${advance.refundedAmount ? `<tr><td>Handed back</td><td class="r">${mx(advance.refundedAmount)}</td></tr>` : ""}
        <tr><td>Held for you</td><td class="r">${mx(advance.heldAmount)}</td></tr>
      </table>
      <div class="c" style="margin-top:8px">Bring this receipt; the amount is taken off your final bill.</div>
      <div class="c" style="margin-top:4px">Received by ${escapeHtml(advance.createdByName || "")}</div>
      ${advance.seller.privacyLine ? `<div class="c" style="margin-top:4px">${escapeHtml(advance.seller.privacyLine)}</div>` : ""}
    `,
  });
};

// One advance: where it went, its receipt, and handing back what is left.
function AdvanceDetail({ id, currency, types, onClose, onChanged }) {
  const { hasPermission } = useAuth();
  const canHandBack = hasPermission("payments.manage");
  const [advance, setAdvance] = useState(null);
  const [error, setError] = useState("");
  const [back, setBack] = useState(null);
  const [busy, setBusy] = useState(false);
  const mx = (value) => moneyExact(value, currency);

  useEffect(() => {
    getAdvance(id)
      .then(setAdvance)
      .catch((err) => setError(getErrorMessage(err)));
  }, [id]);

  const handBack = (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const payload = {
      amount: Number(back.amount),
      refundMethod: back.method,
      paymentTypeId: back.typeId ? Number(back.typeId) : null,
      transactionRef: back.reference.trim() || null,
      reason: back.reason.trim(),
    };

    // Checked by the server first (how much it holds, the reason); a cashier
    // is then asked for a manager's PIN tied to this advance and this much.
    withApproval((headers) => refundAdvance(id, payload, headers), `Hand back ${mx(payload.amount)} of ${advance.receiptNumber}`)
      .then((result) => {
        setAdvance(result.data);
        setBack(null);
        onChanged(result.message);
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title={advance ? `Advance ${advance.receiptNumber}` : "Advance"}
      description={advance ? `${advance.customerName}${advance.purpose ? ` · ${advance.purpose}` : ""}` : ""}
      icon="wallet"
      onClose={onClose}
      width={640}
      footer={
        advance ? (
          <button type="button" className="button button-secondary" onClick={() => printReceipt(advance, currency)}>
            <Icon name="print" size={16} /> Print receipt
          </button>
        ) : null
      }
    >
      <div className="stack">
        <ErrorMessage message={error} />
        {!advance ? (
          !error && <Loading label="Reading the advance…" />
        ) : (
          <>
            <div className="dues-statement-head">
              <span>
                Received <strong>{mx(advance.amount)}</strong>
              </span>
              <span>
                Used <strong>{mx(advance.usedAmount)}</strong>
              </span>
              <span>
                Handed back <strong>{mx(advance.refundedAmount)}</strong>
              </span>
              <span>
                Held <strong className="dues-advance">{mx(advance.heldAmount)}</strong>
              </span>
            </div>
            <p className="small muted">
              {dayMonth(advance.receivedAt, { year: true, time: true })} · {advance.methodLabel}
              {advance.paymentTypeName ? ` · ${advance.paymentTypeName}` : ""}
              {advance.transactionRef ? ` · ${advance.transactionRef}` : ""}
              {advance.outletName ? ` · ${advance.outletName}` : ""}
              {advance.createdByName ? ` · taken by ${advance.createdByName}` : ""}
            </p>

            {(advance.usedOn.length > 0 || advance.refunds.length > 0) && (
              <div className="bill-history">
                <h3>Where it went</h3>
                <ul>
                  {advance.usedOn.map((use) => (
                    <li key={`u${use.paymentId}`}>
                      <span>
                        <Icon name="receipt" size={14} /> Paid{" "}
                        <Link to={`/bills?bill=${use.billId}`} className="mono">
                          {use.billNumber}
                        </Link>
                        {use.putBack > 0 ? <span className="muted small"> · {mx(use.putBack)} put back</span> : null}
                      </span>
                      <strong>{mx(use.amount)}</strong>
                    </li>
                  ))}
                  {advance.refunds.map((row) => (
                    <li key={`r${row.id}`} className="is-refund">
                      <span>
                        <Icon name="undo" size={14} /> Handed back by {row.methodLabel}
                        <span className="muted small">
                          {" "}
                          · {row.reason} · {row.createdByName}
                          {row.approvedByName ? `, approved by ${row.approvedByName}` : ""}
                        </span>
                      </span>
                      <strong>−{mx(row.amount)}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {canHandBack && advance.heldAmount > 0 && !back && (
              <div className="form-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() =>
                    setBack({ amount: String(advance.heldAmount), method: advance.paymentMethod, typeId: "", reference: "", reason: "" })
                  }
                >
                  <Icon name="undo" size={16} /> Hand back
                </button>
              </div>
            )}

            {back && (
              <form className="bill-panel" onSubmit={handBack}>
                <p className="small">
                  <strong>Hand back what is not used.</strong>{" "}
                  {hasPermission("advances.refund") ? "" : "A manager approves it with their PIN."}
                </p>
                <div className="form-grid">
                  <label className="field">
                    <span>Amount *</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      max={advance.heldAmount}
                      value={back.amount}
                      onChange={(event) => setBack({ ...back, amount: event.target.value })}
                      required
                    />
                    <small className="muted">Up to {mx(advance.heldAmount)}</small>
                  </label>
                  <label className="field">
                    <span>Paid back by *</span>
                    <select value={back.method} onChange={(event) => setBack({ ...back, method: event.target.value, typeId: "" })}>
                      {BILL_PAYMENT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {types.some((type) => type.paymentMethod === back.method) && (
                    <label className="field">
                      <span>Type</span>
                      <select value={back.typeId} onChange={(event) => setBack({ ...back, typeId: event.target.value })}>
                        <option value="">None</option>
                        {types
                          .filter((type) => type.paymentMethod === back.method)
                          .map((type) => (
                            <option key={type.id} value={type.id}>
                              {type.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {back.method !== "cash" && (
                    <label className="field">
                      <span>Reference</span>
                      <input value={back.reference} maxLength={100} onChange={(event) => setBack({ ...back, reference: event.target.value })} />
                    </label>
                  )}
                  <label className="field field-wide">
                    <span>Reason *</span>
                    <input
                      value={back.reason}
                      maxLength={200}
                      placeholder="Party cancelled"
                      onChange={(event) => setBack({ ...back, reason: event.target.value })}
                      required
                    />
                  </label>
                </div>
                <div className="bill-panel-row bill-panel-end">
                  <button type="button" className="button button-ghost button-sm" onClick={() => setBack(null)} disabled={busy}>
                    Cancel
                  </button>
                  <button type="submit" className="button button-sm" disabled={busy || !back.reason.trim() || !(Number(back.amount) > 0)}>
                    {busy ? "Saving…" : `Hand back ${mx(Number(back.amount) || 0)}`}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
