import { useCallback, useEffect, useState } from "react";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getPurchaseRegister } from "../services/purchase.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money, moneyExact } from "@bmp/shared/format";
import { monthStart, today } from "@bmp/shared/dates";
import { downloadCsv } from "../../../../services/csv";
import { escapeHtml, printDocument } from "../../../../services/print";
import { Tile } from "../../inventory/pages/stockUi";
import { niceDate } from "../../inventory/pages/stockFormat";

// The purchase register the accountant asks for at month end: every supplier
// bill with the supplier's GSTIN, the bill number, taxable value and GST split
// into CGST and SGST (or IGST from another state), then the debit notes for
// goods sent back.
export default function PurchaseRegisterPanel({ suppliers, currency, restaurantName }) {
  const [range, setRange] = useState({ from: monthStart(), to: today() });
  const [supplierId, setSupplierId] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      getPurchaseRegister({ from: range.from, to: range.to, supplierId: supplierId || undefined })
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [range, supplierId]
  );

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () =>
    downloadCsv(
      [
        ["Purchase register", `${range.from} to ${range.to}`],
        [],
        ["Bill date", "Bill number", "GRN", "Supplier", "Supplier GSTIN", "PO", "Payment", "Taxable value", "CGST", "SGST", "IGST", "Total GST", "Round off", "Bill total"],
        ...data.rows.map((row) => [
          row.billDate,
          row.billNumber || "",
          row.receiptNumber,
          row.supplierName,
          row.supplierGstin || "",
          row.poNumber || "",
          row.paymentMode === "paid" ? "Paid" : "Credit",
          row.taxable,
          row.cgst,
          row.sgst,
          row.igst,
          row.tax,
          row.roundOff,
          row.total,
        ]),
        ["Total", "", "", "", "", "", "", data.totals.taxable, data.totals.cgst, data.totals.sgst, data.totals.igst, data.totals.tax, "", data.totals.total],
        [],
        ["Debit notes (goods returned)"],
        ["Date", "Return", "Against bill", "Supplier", "Supplier GSTIN", "Reason", "Taxable value", "CGST", "SGST", "IGST", "Total GST", "Total"],
        ...data.returns.map((row) => [
          row.returnDate,
          row.returnNumber,
          row.againstBill || "",
          row.supplierName,
          row.supplierGstin || "",
          row.reason,
          row.taxable,
          row.cgst,
          row.sgst,
          row.igst,
          row.tax,
          row.total,
        ]),
        [],
        ["GST rate", "Taxable value", "GST"],
        ...data.byRate.map((row) => [`${row.rate}%`, row.taxable, row.tax]),
      ],
      `purchase-register-${range.from}-to-${range.to}.csv`
    );

  // A bill carries CGST + SGST or IGST, not both: the tax that is nil on a
  // bill shows as a dash. The totals row adds up every bill shown.
  const taxCell = (amount) => (amount !== 0 ? moneyExact(amount, currency) : <span className="dg-blank">—</span>);
  const billColumns = [
    {
      key: "date",
      pin: true,
      header: "Bill date",
      type: "date",
      value: (row) => row.billDate,
      width: 120,
      mobile: "show",
      render: (row) => <span className="nowrap">{niceDate(row.billDate)}</span>,
    },
    {
      key: "number",
      header: "Bill no.",
      value: (row) => row.billNumber || "",
      csv: (row) => row.billNumber || "",
      mobile: "subtitle",
      render: (row) => (
        <span className="bo-cell-stack">
          {row.billNumber ? <span>{row.billNumber}</span> : <span className="muted">No bill number</span>}
          <span className="muted small mono">
            {row.receiptNumber}
            {row.poNumber ? ` · ${row.poNumber}` : ""}
          </span>
        </span>
      ),
    },
    { key: "grn", header: "GRN", value: (row) => row.receiptNumber, defaultHidden: true },
    {
      key: "supplier",
      header: "Supplier · GSTIN",
      value: (row) => row.supplierName,
      mobile: "title",
      render: (row) => (
        <span className="bo-cell-stack">
          <strong>{row.supplierName}</strong>
          <span className="muted small mono">{row.supplierGstin || "Unregistered"}</span>
        </span>
      ),
    },
    { key: "taxable", header: "Taxable", type: "money", exact: true, value: (row) => row.taxable, total: "sum", mobile: "show" },
    { key: "cgst", header: "CGST", type: "money", exact: true, value: (row) => row.cgst, total: "sum", mobile: "show", render: (row) => taxCell(row.cgst) },
    { key: "sgst", header: "SGST", type: "money", exact: true, value: (row) => row.sgst, total: "sum", mobile: "show", render: (row) => taxCell(row.sgst) },
    { key: "igst", header: "IGST", type: "money", exact: true, value: (row) => row.igst, total: "sum", mobile: "show", render: (row) => taxCell(row.igst) },
    {
      key: "total",
      header: "Total",
      type: "money",
      exact: true,
      value: (row) => row.total,
      total: "sum",
      mobile: "show",
      render: (row) => <strong>{moneyExact(row.total, currency)}</strong>,
    },
  ];

  const rateColumns = [
    { key: "rate", header: "Rate", type: "percent", value: (row) => row.rate, render: (row) => `${row.rate}%` },
    { key: "taxable", header: "Taxable value", type: "money", exact: true, value: (row) => row.taxable, total: "sum" },
    { key: "tax", header: "GST", type: "money", exact: true, value: (row) => row.tax, total: "sum" },
  ];

  const returnColumns = [
    {
      key: "number",
      header: "Return",
      value: (row) => row.returnNumber,
      mobile: "title",
      render: (row) => (
        <span className="bo-cell-stack">
          <span className="mono">{row.returnNumber}</span>
          <span className="muted small">
            {niceDate(row.returnDate)}
            {row.againstBill ? ` · bill ${row.againstBill}` : ""}
          </span>
        </span>
      ),
    },
    { key: "supplier", header: "Supplier", value: (row) => row.supplierName, mobile: "subtitle" },
    { key: "tax", header: "GST", type: "money", exact: true, value: (row) => row.tax, total: "sum" },
    { key: "total", header: "Total", type: "money", exact: true, value: (row) => row.total, total: "sum" },
  ];

  const print = () =>
    printDocument({
      title: `Purchase register ${range.from} to ${range.to}`,
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 11px; color: #111; }
        h1 { font-size: 16px; margin: 0 0 4px; }
        h2 { font-size: 13px; margin: 14px 0 4px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid #ccc; padding: 4px 5px; text-align: left; }
        th { background: #f2f2f2; font-size: 10px; }
        .r { text-align: right; }
        tfoot td { font-weight: 700; border-top: 2px solid #333; }`,
      body: `
        <h1>Purchase register — ${escapeHtml(niceDate(range.from))} to ${escapeHtml(niceDate(range.to))}</h1>
        <div>${escapeHtml(restaurantName || "")}${data.restaurantGstin ? ` · GSTIN ${escapeHtml(data.restaurantGstin)}` : ""}</div>
        <table>
          <thead><tr><th>Date</th><th>Bill no.</th><th>Supplier</th><th>GSTIN</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">IGST</th><th class="r">Total</th></tr></thead>
          <tbody>${data.rows
            .map(
              (row) => `<tr><td>${escapeHtml(row.billDate)}</td><td>${escapeHtml(row.billNumber || row.receiptNumber)}</td><td>${escapeHtml(row.supplierName)}</td><td>${escapeHtml(row.supplierGstin || "—")}</td><td class="r">${moneyExact(row.taxable, "")}</td><td class="r">${moneyExact(row.cgst, "")}</td><td class="r">${moneyExact(row.sgst, "")}</td><td class="r">${moneyExact(row.igst, "")}</td><td class="r">${moneyExact(row.total, "")}</td></tr>`
            )
            .join("")}</tbody>
          <tfoot><tr><td colspan="4">Total (${data.totals.count} bills)</td><td class="r">${moneyExact(data.totals.taxable, "")}</td><td class="r">${moneyExact(data.totals.cgst, "")}</td><td class="r">${moneyExact(data.totals.sgst, "")}</td><td class="r">${moneyExact(data.totals.igst, "")}</td><td class="r">${moneyExact(data.totals.total, "")}</td></tr></tfoot>
        </table>
        ${
          data.returns.length
            ? `<h2>Debit notes</h2><table><thead><tr><th>Date</th><th>Return</th><th>Supplier</th><th class="r">Taxable</th><th class="r">GST</th><th class="r">Total</th></tr></thead><tbody>${data.returns
                .map(
                  (row) => `<tr><td>${escapeHtml(row.returnDate)}</td><td>${escapeHtml(row.returnNumber)}</td><td>${escapeHtml(row.supplierName)}</td><td class="r">${moneyExact(row.taxable, "")}</td><td class="r">${moneyExact(row.tax, "")}</td><td class="r">${moneyExact(row.total, "")}</td></tr>`
                )
                .join("")}</tbody></table>`
            : ""
        }`,
    });

  return (
    <div className="stack">
      <ErrorMessage message={error} />

      <div className="stk-intro">
        <p>
          The register your accountant asks for at month end: every supplier bill with its GSTIN and the GST
          split, then the debit notes for goods sent back.
        </p>
        <div className="stk-actions">
          <button type="button" className="button button-secondary" onClick={print} disabled={!data || data.rows.length === 0}>
            <Icon name="print" size={16} /> Print
          </button>
          <button type="button" className="button button-secondary" onClick={exportCsv} disabled={!data || data.rows.length === 0}>
            <Icon name="download" size={16} /> Export CSV
          </button>
        </div>
      </div>

      <div className="card stk-filter-card">
        <div className="filters">
          <div className="stk-daterange">
            <DateRangeFilter from={range.from} to={range.to} onChange={setRange} label="register period" />
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
        </div>
      </div>

        {!data ? (
          <Loading />
        ) : (
          <>
            <div className="stat-grid">
              <Tile
                icon="receipt"
                label="Bills"
                value={count(data.totals.count)}
                note={`${count(data.returnTotals.count)} debit note${data.returnTotals.count === 1 ? "" : "s"}`}
              />
              <Tile icon="wallet" label="Taxable value" value={money(data.totals.taxable, currency)} note="before GST" />
              <Tile
                icon="percent"
                tone="info"
                label="GST on purchases"
                value={money(data.totals.tax, currency)}
                note={`CGST ${money(data.totals.cgst, currency)} · SGST ${money(data.totals.sgst, currency)} · IGST ${money(data.totals.igst, currency)}`}
              />
              <Tile
                icon="scale"
                tone="primary"
                label="Net purchases"
                value={money(data.net.total, currency)}
                note={`after ${money(data.returnTotals.total, currency)} returned`}
              />
            </div>

            {data.taxSplitAssumed && (
              <div className="alert alert-info">
                <span>
                  Your own GSTIN is not in the settings, so GST is shown as CGST + SGST for every supplier. Add it
                  under Restaurant settings and suppliers from another state show as IGST.
                </span>
              </div>
            )}

            <SectionCard
              icon="book"
              title="Supplier bills"
              description="One line per bill, in date order, with the tax split the way the GST return wants it."
              flush
            >
            {/* Every bill in the period, client-paged. The Export CSV above is
                the accountant's file (bills, debit notes and GST by rate in
                one), so the grid adds no export of its own. */}
            <DataGrid
              id="purchase-register-bills"
              caption="Supplier bills in the purchase register"
              columns={billColumns}
              rows={data.rows}
              rowKey={(row) => row.id}
              empty="No supplier bills in this period."
              emptyIcon="book"
              emptyHint="Bills entered under Purchase bills, or received against an order, show here."
              rowNoun={["bill", "bills"]}
              currency={currency}
            />
            </SectionCard>

            <div className="two-column">
              <SectionCard icon="percent" tone="info" title="GST by rate" flush>
                {/* One row per GST rate (a handful at most): no paging. */}
                <DataGrid
                  id="purchase-register-rates"
                  caption="GST by rate"
                  columns={rateColumns}
                  rows={data.byRate}
                  rowKey={(row) => row.rate}
                  variant="compact"
                  cardsBelow={400}
                  pageSize={false}
                  empty="No GST in this period."
                  rowNoun={["rate", "rates"]}
                  currency={currency}
                />
              </SectionCard>
              <SectionCard icon="undo" tone="warning" title="Debit notes" description="Goods sent back to suppliers." flush>
                <DataGrid
                  id="purchase-register-returns"
                  caption="Debit notes"
                  columns={returnColumns}
                  rows={data.returns}
                  rowKey={(row) => row.id}
                  variant="compact"
                  cardsBelow={400}
                  empty="No returns in this period."
                  emptyIcon="undo"
                  rowNoun={["debit note", "debit notes"]}
                  currency={currency}
                />
              </SectionCard>
            </div>
          </>
        )}
    </div>
  );
}
