import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import TruncationNotice from "../../../../components/TruncationNotice";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import { getPurchaseBill, listPurchaseBills, purchaseBillFiles, voidPurchaseBill } from "../services/purchase.service";
import AttachmentsModal from "../../expenses/pages/AttachmentsModal";
import { getErrorMessage } from "../../../../services/api";
import { money, moneyExact } from "../../../../services/format";
import { daysAgo, today } from "../../../../services/dates";
import { escapeHtml, printDocument } from "../../../../services/print";
import { Chip, ReasonDialog, Tile } from "../../inventory/pages/stockUi";
import { methodLabel, niceDate, qty, unitMoney } from "../../inventory/pages/stockFormat";
import { withApproval } from "../../../../services/approval";

// Every delivery that came in with a supplier's bill — against an order or
// without one — as the store and the accountant see it.
export default function PurchaseBillsPanel({ suppliers, currency, canReceive, refreshKey, onChanged, restaurantName }) {
  const [range, setRange] = useState({ from: daysAgo(29), to: today() });
  const [supplierId, setSupplierId] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("posted");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [viewing, setViewing] = useState(null);
  const [voiding, setVoiding] = useState(false);
  // The bill whose paper copy (photos, PDFs) is open, SW-B-09.
  const [filesOf, setFilesOf] = useState(null);
  const filesId = filesOf ? filesOf.id : null;
  const billFiles = useMemo(() => (filesId ? purchaseBillFiles(filesId) : null), [filesId]);

  const load = useCallback(
    () =>
      listPurchaseBills({
        from: range.from,
        to: range.to,
        supplierId: supplierId || undefined,
        kind: kind || undefined,
        status: status || undefined,
        search: search.trim() || undefined,
        limit: 500,
      })
        .then((result) => {
          setPage(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [range, supplierId, kind, status, search]
  );

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const open = async (bill) => {
    try {
      setViewing(await getPurchaseBill(bill.id));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const bills = page ? page.items : [];
  const live = bills.filter((bill) => bill.status === "posted");
  const total = live.reduce((sum, bill) => sum + bill.totalAmount, 0);
  const tax = live.reduce((sum, bill) => sum + bill.taxAmount, 0);
  const onCredit = live.filter((bill) => bill.paymentMode === "credit").reduce((sum, bill) => sum + bill.totalAmount, 0);
  const direct = live.filter((bill) => bill.kind === "direct").length;

  const retry = () => {
    setError("");
    load();
  };

  // A voided bill stays listed, struck through; its money counts as nothing
  // in the totals row (as in the tiles), while the export keeps its figures.
  const standing = (bill, amount) => (bill.status === "void" ? 0 : amount);
  const struck = (bill) => (bill.status === "void" ? "bo-struck" : "");

  const billColumns = [
    {
      key: "bill",
      width: 150,
      header: "Bill",
      value: (bill) => bill.billNumber || bill.receiptNumber,
      pin: true,
      mobile: "title",
      render: (bill) => (
        <span className="bo-cell-stack">
          {/* A bill entered without the supplier's number is named by its
              goods receipt instead. */}
          <strong className={bill.billNumber ? "" : "mono"}>{bill.billNumber || bill.receiptNumber}</strong>
          {bill.billNumber ? (
            <span className="muted small mono">{bill.receiptNumber}</span>
          ) : (
            <span className="muted small stk-no-bill-no">no bill number</span>
          )}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      type: "date",
      value: (bill) => bill.billDate,
      width: 120,
      mobile: "show",
      render: (bill) => <span className="nowrap">{niceDate(bill.billDate)}</span>,
    },
    {
      key: "supplier",
      header: "Supplier",
      value: (bill) => bill.supplierName,
      mobile: "subtitle",
      render: (bill) => (
        <span className="bo-cell-stack">
          <span>{bill.supplierName}</span>
          {bill.supplierGstin && <span className="muted small mono">{bill.supplierGstin}</span>}
        </span>
      ),
    },
    {
      key: "came",
      header: "Came in",
      value: (bill) => bill.poNumber || "Direct",
      mobile: "show",
      render: (bill) => (
        <span className="bo-cell-stack">
          {bill.poNumber ? <span className="mono">{bill.poNumber}</span> : <span className="muted">Direct</span>}
          {bill.hasRejections && (
            <span>
              <Chip tone="warning">Some turned away</Chip>
            </span>
          )}
        </span>
      ),
    },
    {
      key: "taxable",
      header: "Taxable",
      type: "money",
      exact: true,
      value: (bill) => standing(bill, bill.taxableAmount),
      csv: (bill) => bill.taxableAmount,
      total: "sum",
      mobile: "hide",
      render: (bill) => <span className={struck(bill)}>{moneyExact(bill.taxableAmount, currency)}</span>,
    },
    {
      key: "gst",
      header: "GST",
      type: "money",
      exact: true,
      value: (bill) => standing(bill, bill.taxAmount),
      csv: (bill) => bill.taxAmount,
      total: "sum",
      mobile: "hide",
      render: (bill) => <span className={struck(bill)}>{moneyExact(bill.taxAmount, currency)}</span>,
    },
    {
      key: "total",
      header: "Total",
      type: "money",
      exact: true,
      value: (bill) => standing(bill, bill.totalAmount),
      csv: (bill) => bill.totalAmount,
      total: "sum",
      mobile: "show",
      render: (bill) => <strong className={struck(bill)}>{moneyExact(bill.totalAmount, currency)}</strong>,
    },
    {
      key: "payment",
      header: "Payment",
      type: "status",
      value: (bill) => (bill.status === "void" ? "void" : bill.paymentMode),
      csv: (bill) =>
        bill.status === "void" ? "Voided" : bill.paymentMode === "paid" ? "Paid on delivery" : `Credit, due ${bill.dueDate || ""}`,
      filter: "select",
      filterOptions: [
        { value: "paid", label: "Paid on delivery" },
        { value: "credit", label: "On credit" },
        { value: "void", label: "Voided" },
      ],
      mobile: "show",
      render: (bill) =>
        bill.status === "void" ? (
          <Chip tone="danger">Voided</Chip>
        ) : bill.paymentMode === "paid" ? (
          <Chip tone="success">Paid on delivery</Chip>
        ) : (
          <Chip tone="info">Credit · due {niceDate(bill.dueDate)}</Chip>
        ),
    },
    {
      key: "actions",
      header: "",
      label: "Open",
      type: "actions",
      render: (bill) => (
        <span className="row-actions">
          {/* The paperclip: the supplier's paper bill, photographed or as a PDF. */}
          <button
            type="button"
            className="link-button att-clip"
            onClick={() => setFilesOf(bill)}
            aria-label={`Paper bill for ${bill.billNumber || bill.receiptNumber}: ${bill.attachmentCount || 0} files`}
            title={bill.attachmentCount ? "Open the paper bill" : "Attach the paper bill"}
          >
            <Icon name="file" size={14} />
            {bill.attachmentCount ? bill.attachmentCount : <span className="muted">+</span>}
          </button>
          <button type="button" className="link-button" onClick={() => open(bill)}>
            Open
          </button>
        </span>
      ),
    },
  ];

  // The lines of the bill being read, in the dialog.
  const lineColumns = [
    {
      key: "item",
      header: "Item",
      value: (line) => line.itemName,
      mobile: "title",
      render: (line) => (
        <span className="bo-cell-stack">
          <strong>{line.itemName}</strong>
          {line.returnedQuantity > 0 && (
            <span className="muted small">{qty(line.returnedQuantity, line.unitShortName)} returned since</span>
          )}
        </span>
      ),
    },
    {
      key: "billed",
      mobile: "show",
      header: "Billed",
      type: "number",
      value: (line) => line.billQuantity,
      render: (line) => (
        <span className="bo-cell-stack">
          <span>{line.packName ? `${qty(line.billQuantity)} × ${line.packName}` : qty(line.billQuantity, line.unitShortName)}</span>
          {line.packName && <span className="muted small">{qty(line.quantity, line.unitShortName)}</span>}
        </span>
      ),
    },
    {
      key: "rejected",
      mobile: "show",
      header: "Turned away",
      type: "number",
      value: (line) => (line.rejectedQuantity > 0 ? line.rejectedQuantity : null),
      render: (line) =>
        line.rejectedQuantity > 0 ? (
          <span className="bo-cell-stack">
            <span className="stk-var-short">{qty(line.rejectedQuantity, line.packName || line.unitShortName)}</span>
            <span className="muted small">{line.rejectionReason}</span>
          </span>
        ) : (
          <span className="dg-blank">—</span>
        ),
    },
    {
      key: "rate",
      mobile: "show",
      header: "Rate",
      type: "money",
      value: (line) => line.unitPrice,
      render: (line) => unitMoney(line.unitPrice, currency),
    },
    { key: "gst", header: "GST", type: "percent", mobile: "show", value: (line) => line.taxRate, render: (line) => `${line.taxRate}%` },
    { key: "amount", header: "Amount", type: "money", exact: true, mobile: "show", value: (line) => line.amount },
    {
      key: "cost",
      mobile: "show",
      header: "Cost on shelf",
      type: "money",
      value: (line) => (line.quantity > 0 ? line.unitCost : null),
      render: (line) => (line.quantity > 0 ? `${unitMoney(line.unitCost, currency)}/${line.unitShortName}` : <span className="dg-blank">—</span>),
    },
  ];

  const printBill = (bill) =>
    printDocument({
      title: `${bill.receiptNumber} ${bill.supplierName}`,
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; }
        h1 { font-size: 17px; margin: 0 0 4px; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        th, td { border-bottom: 1px solid #ccc; padding: 5px 6px; text-align: left; }
        th { background: #f2f2f2; font-size: 11px; }
        .r { text-align: right; }
        tfoot td { font-weight: 700; }`,
      body: `
        <h1>Goods received ${escapeHtml(bill.receiptNumber)}</h1>
        <div>${escapeHtml(restaurantName || "")} · ${escapeHtml(bill.storeName)}</div>
        <div>Supplier: <strong>${escapeHtml(bill.supplierName)}</strong>${bill.supplierGstin ? ` · GSTIN ${escapeHtml(bill.supplierGstin)}` : ""}</div>
        <div>Bill ${escapeHtml(bill.billNumber || "—")} dated ${escapeHtml(niceDate(bill.billDate))} · received ${escapeHtml(niceDate(bill.receivedDate))}${bill.poNumber ? ` · against ${escapeHtml(bill.poNumber)}` : ""}</div>
        <table>
          <thead><tr><th>Item</th><th class="r">Billed</th><th class="r">Turned away</th><th class="r">Rate</th><th class="r">GST</th><th class="r">Amount</th></tr></thead>
          <tbody>${bill.lines
            .map(
              (line) => `<tr><td>${escapeHtml(line.itemName)}</td><td class="r">${line.packName ? `${qty(line.billQuantity)} × ${escapeHtml(line.packName)}` : qty(line.billQuantity, line.unitShortName)}</td><td class="r">${line.rejectedQuantity > 0 ? `${qty(line.rejectedQuantity)} (${escapeHtml(line.rejectionReason || "")})` : "—"}</td><td class="r">${unitMoney(line.unitPrice, "")}</td><td class="r">${line.taxRate}%</td><td class="r">${moneyExact(line.amount, "")}</td></tr>`
            )
            .join("")}</tbody>
          <tfoot>
            <tr><td colspan="5">Taxable value</td><td class="r">${moneyExact(bill.taxableAmount, currency)}</td></tr>
            <tr><td colspan="5">GST</td><td class="r">${moneyExact(bill.taxAmount, currency)}</td></tr>
            ${bill.roundOff ? `<tr><td colspan="5">Round off</td><td class="r">${moneyExact(bill.roundOff, currency)}</td></tr>` : ""}
            <tr><td colspan="5">Total</td><td class="r">${moneyExact(bill.totalAmount, currency)}</td></tr>
          </tfoot>
        </table>
        <p>Received by: ____________________</p>`,
    });

  return (
    <div className="stack">
      {/* A list that never loaded says so inside the grid, with Try again. */}
      <ErrorMessage message={page ? error : ""} />
      <SuccessMessage message={success} />

      <div className="card stk-filter-card">
        <div className="filters">
          <div className="stk-daterange">
            <DateRangeFilter from={range.from} to={range.to} onChange={setRange} label="bill dates" />
          </div>
          <label className="field">
            <span>Supplier</span>
            <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">All suppliers</option>
              {suppliers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Came in</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">All bills</option>
              <option value="po">Against a purchase order</option>
              <option value="direct">Without an order</option>
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="posted">Standing</option>
              <option value="void">Voided</option>
              <option value="">All</option>
            </select>
          </label>
          <label className="field">
            <span>Find</span>
            <span className="input-with-icon">
              <Icon name="search" size={17} className="input-icon" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Bill no, GRN, supplier"
              />
            </span>
          </label>
        </div>
      </div>

      {page && (
        <div className="stat-grid">
          <Tile icon="receipt" label="Bills" value={live.length} note={`${direct} without an order`} />
          <Tile icon="wallet" tone="primary" label="Bought" value={money(total, currency)} note="bill totals, GST included" />
          <Tile icon="percent" label="GST on bills" value={money(tax, currency)} note="input tax on these bills" />
          <Tile
            icon="calendar"
            label="On credit"
            value={money(onCredit, currency)}
            tone={onCredit > 0 ? "warning" : undefined}
            note={`${money(total - onCredit, currency)} paid on delivery`}
          />
        </div>
      )}

      {page && <TruncationNotice shown={bills.length} total={page.total} what="bills" />}

      <SectionCard
        icon="receipt"
        title="Bills"
        description="Every delivery that came with a supplier's bill, against an order or without one."
        flush
      >
        {/* The API filters by date, supplier, kind, status and the Find box
            above (up to 500 bills); the grid pages, sorts and exports them. */}
        <DataGrid
          id="purchase-bills"
          caption="Purchase bills"
          columns={billColumns}
          rows={bills}
          rowKey={(bill) => bill.id}
          loading={!page && !error}
          error={page ? "" : error}
          onRetry={retry}
          empty="No purchase bills in this period."
          emptyIcon="receipt"
          emptyHint="Enter the morning's vegetable and meat bills here, and receive goods against purchase orders."
          onRowClick={open}
          rowClassName={(bill) => (bill.status === "void" ? "dg-tone-muted" : "")}
          search={false}
          rowNoun={["bill", "bills"]}
          currency={currency}
          exportName="purchase-bills"
        />
      </SectionCard>

      {filesOf && (
        <AttachmentsModal
          title={`Paper bill — ${filesOf.billNumber || filesOf.receiptNumber}`}
          description={`${filesOf.supplierName || ""}${filesOf.status === "void" ? " · voided bill: its files are kept" : ""}`}
          files={billFiles}
          canEdit={canReceive}
          onClose={() => setFilesOf(null)}
          onChanged={() => load()}
        />
      )}

      {viewing && (
        <Modal
          title={`${viewing.billNumber ? `Bill ${viewing.billNumber}` : viewing.receiptNumber} — ${viewing.supplierName}`}
          description={`${viewing.receiptNumber} · dated ${niceDate(viewing.billDate)} · ${moneyExact(viewing.totalAmount, currency)}`}
          icon="receipt"
          onClose={() => setViewing(null)}
          width={880}
          footer={
            <>
              {canReceive && viewing.status === "posted" && (
                <button type="button" className="button button-danger stk-foot-start" onClick={() => setVoiding(true)}>
                  <Icon name="ban" size={16} /> Void bill
                </button>
              )}
              <button type="button" className="button button-secondary" onClick={() => printBill(viewing)}>
                <Icon name="print" size={16} /> Print
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setFilesOf(viewing);
                  setViewing(null);
                }}
              >
                <Icon name="file" size={16} /> Paper bill{viewing.attachmentCount ? ` (${viewing.attachmentCount})` : ""}
              </button>
              {viewing.status === "posted" && (
                <Link className="button button-secondary" to={`/purchasing/accounts?tab=returns&bill=${viewing.id}`}>
                  <Icon name="undo" size={16} /> Return goods
                </Link>
              )}
              <button type="button" className="button button-secondary" onClick={() => setViewing(null)}>
                Close
              </button>
            </>
          }
        >
          <div className="stack stk-scope">
            {viewing.status === "void" && (
              <div className="alert">
                Voided {viewing.voidedAt ? new Date(viewing.voidedAt).toLocaleString("en-IN") : ""} by{" "}
                {viewing.voidedByName || "—"}: {viewing.voidReason}
              </div>
            )}
            <dl className="details">
              <dt>Goods receipt</dt>
              <dd className="mono">{viewing.receiptNumber}</dd>
              <dt>Bill</dt>
              <dd>
                {viewing.billNumber || "No number on it"} · dated {niceDate(viewing.billDate)} · received{" "}
                {niceDate(viewing.receivedDate)}
              </dd>
              <dt>Against</dt>
              <dd>{viewing.poNumber || "No purchase order (direct purchase)"}</dd>
              <dt>Went to</dt>
              <dd>{viewing.storeName}</dd>
              <dt>Payment</dt>
              <dd>
                {viewing.paymentMode === "paid"
                  ? "Paid on delivery"
                  : `On credit, due ${niceDate(viewing.dueDate)}`}
              </dd>
              <dt>Entered by</dt>
              <dd>{viewing.createdByName || "—"}</dd>
              {viewing.notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{viewing.notes}</dd>
                </>
              )}
            </dl>

            {/* On a phone each line is a small card, so the rate, GST and
                amount are never cut off at the edge of the dialog. */}
            <DataGrid
              id="purchase-bill-lines"
              caption={`Lines on ${viewing.receiptNumber}`}
              columns={lineColumns}
              rows={viewing.lines}
              rowKey={(line) => line.id}
              variant="compact"
              pageSize={false}
              currency={currency}
            />

            <div className="stk-foot">
              <p className="muted small">
                {viewing.lines.length === 1 ? "1 line" : `${viewing.lines.length} lines`}
              </p>
              <dl className="stk-totals">
                <dt>Taxable value</dt>
                <dd>{moneyExact(viewing.taxableAmount, currency)}</dd>
                <dt>GST</dt>
                <dd>{moneyExact(viewing.taxAmount, currency)}</dd>
                {viewing.roundOff ? (
                  <>
                    <dt>Round off</dt>
                    <dd>{moneyExact(viewing.roundOff, currency)}</dd>
                  </>
                ) : null}
                <dt className="is-grand">Bill total</dt>
                <dd className="is-grand">{moneyExact(viewing.totalAmount, currency)}</dd>
              </dl>
            </div>

            {(viewing.payments.length > 0 || viewing.returns.length > 0) && (
              <div className="stk-actions">
                {viewing.payments.map((payment) => (
                  <Chip key={`p${payment.id}`} tone={payment.status === "void" ? "danger" : "success"}>
                    {methodLabel(payment.paymentMethod)} {moneyExact(payment.amount, currency)}
                    {payment.paidFromTill ? " from the till" : ""}
                    {payment.status === "void" ? " (voided)" : ""}
                  </Chip>
                ))}
                {viewing.returns.map((ret) => (
                  <Chip key={`r${ret.id}`} tone={ret.status === "void" ? "muted" : "warning"}>
                    Return {ret.returnNumber} {moneyExact(ret.totalAmount, currency)}
                    {ret.status === "void" ? " (voided)" : ""}
                  </Chip>
                ))}
              </div>
            )}

          </div>
        </Modal>
      )}

      {voiding && viewing && (
        <ReasonDialog
          title={`Void ${viewing.receiptNumber}?`}
          message={`Its stock goes back out${viewing.poNumber ? `, ${viewing.poNumber} counts it as not arrived` : ""}, any payment made with it is voided and the items go back to their earlier cost. The bill stays on record, struck through.${
            viewing.payments.some((payment) => payment.status === "posted")
              ? " It was paid, so voiding it needs someone who can pay suppliers — a manager may be asked for their PIN."
              : ""
          }`}
          placeholder="Entered twice by mistake"
          confirmLabel="Void bill"
          onCancel={() => setVoiding(false)}
          onConfirm={async (reason) => {
            // A paid bill needs the pay-suppliers right. Someone without it
            // is asked for a manager's PIN first, so no request is sent only
            // to be refused; an unpaid bill needs no approval at all.
            const payment = viewing.payments.find((row) => row.status === "posted");
            const bill = await withApproval(
              (headers) => voidPurchaseBill(viewing.id, reason, headers),
              `Void ${viewing.receiptNumber}${viewing.billNumber ? ` (bill ${viewing.billNumber})` : ""}${
                payment ? `, paid ${moneyExact(payment.amount, currency)} by ${methodLabel(payment.paymentMethod)}` : ""
              }`,
              payment ? { permission: "purchasing.pay", action: "void a bill that has been paid" } : {}
            );
            setVoiding(false);
            setViewing(bill);
            setSuccess(`${bill.receiptNumber} voided`);
            load();
            if (onChanged) {
              onChanged();
            }
          }}
        />
      )}
    </div>
  );
}
