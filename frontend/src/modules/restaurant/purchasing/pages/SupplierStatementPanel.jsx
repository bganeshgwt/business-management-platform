import { useCallback, useEffect, useState } from "react";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getSupplierStatement } from "../services/purchaseReturn.service";
import { getErrorMessage } from "../../../../services/api";
import { moneyExact } from "../../../../services/format";
import { daysAgo, today } from "../../../../services/dates";
import { downloadCsv } from "../../../../services/csv";
import { escapeHtml, printDocument } from "../../../../services/print";
import { Chip, Tile } from "../../inventory/pages/stockUi";
import { niceDate, signedMoney } from "../../inventory/pages/stockFormat";

const TYPE_WORDS = { bill: "Bill", return: "Return", payment: "Payment" };
const TYPE_TONES = { bill: "info", return: "warning", payment: "success" };

// One supplier's account the way they would send it: what was owed before
// the period, every bill, return and payment with the balance after each, and
// the bills still open with how late they are.
export default function SupplierStatementPanel({ suppliers, supplierId, onSupplierChange, currency, restaurantName }) {
  const [range, setRange] = useState({ from: daysAgo(89), to: today() });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!supplierId) {
      return Promise.resolve();
    }

    return getSupplierStatement({ supplierId, from: range.from, to: range.to })
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, [supplierId, range]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () =>
    downloadCsv(
      [
        [`Statement — ${data.supplier.name}`, `${range.from} to ${range.to}`],
        ["Opening balance", "", "", "", "", "", data.openingBalance],
        ["Date", "Type", "Number", "Reference", "Due", "Billed", "Paid / returned", "Balance", "Status"],
        ...data.entries.map((entry) => [
          entry.date,
          TYPE_WORDS[entry.type],
          entry.number,
          entry.reference || "",
          entry.dueDate || "",
          entry.billed || "",
          entry.settled || "",
          entry.balance,
          entry.status === "void" ? `Voided: ${entry.voidReason}` : "",
        ]),
        ["Closing balance", "", "", "", "", data.totals.billed, data.totals.settled, data.closingBalance],
      ],
      `statement-${data.supplier.name.replace(/\W+/g, "-")}-${range.to}.csv`
    );

  // The statement's columns. None sorts: each row's balance is the running
  // balance after that entry in date order, and re-sorting by amount or
  // reference would put balances next to each other that never followed one
  // another. (Moving to page 2 keeps the order, so paging is fine.)
  const statementColumns = [
    {
      key: "date",
      pin: true,
      header: "Date",
      type: "date",
      value: (entry) => entry.date,
      sortable: false,
      width: 110,
      mobile: "subtitle",
      render: (entry) => <span className="nowrap">{niceDate(entry.date)}</span>,
    },
    {
      key: "entry",
      header: "Entry",
      value: (entry) => `${TYPE_WORDS[entry.type]} ${entry.number}`,
      csv: (entry) => `${TYPE_WORDS[entry.type]}${entry.status === "void" ? " (voided)" : ""} ${entry.number}`,
      sortable: false,
      mobile: "title",
      render: (entry) => (
        <span className="bo-cell-stack">
          <span>
            <Chip tone={entry.status === "void" ? "muted" : TYPE_TONES[entry.type]}>
              {TYPE_WORDS[entry.type]}
              {entry.status === "void" ? " · voided" : ""}
            </Chip>
          </span>
          <span className="muted small mono">{entry.number}</span>
        </span>
      ),
    },
    {
      key: "reference",
      header: "Reference",
      value: (entry) => entry.reference || "",
      sortable: false,
      mobile: "show",
      render: (entry) => (
        <span className="bo-cell-stack small">
          <span>{entry.reference || "—"}</span>
          {entry.dueDate && <span className="muted">due {niceDate(entry.dueDate)}</span>}
          {entry.status === "void" && entry.voidReason && <span className="muted">{entry.voidReason}</span>}
        </span>
      ),
    },
    {
      key: "billed",
      header: "Billed",
      type: "money",
      exact: true,
      value: (entry) => entry.billed || null,
      sortable: false,
      mobile: "show",
    },
    {
      key: "settled",
      header: "Paid / returned",
      type: "money",
      exact: true,
      value: (entry) => entry.settled || null,
      sortable: false,
      mobile: "show",
    },
    {
      key: "balance",
      header: "Balance owed",
      type: "money",
      exact: true,
      value: (entry) => entry.balance,
      sortable: false,
      mobile: "show",
      render: (entry) => signedMoney(entry.balance, currency, true),
    },
  ];

  // The foot of the ledger: the period's billed and settled sums and the
  // balance owed at its end, from the server (as before), under whichever
  // columns are on show.
  const statementFooter = (ctx) => {
    const label = `Balance owed at ${niceDate(range.to)}`;
    const figures = {
      billed: moneyExact(data.totals.billed, currency),
      settled: moneyExact(data.totals.settled, currency),
      balance: signedMoney(data.closingBalance, currency, true),
    };

    const firstFigure = ctx.columns.findIndex((column) => figures[column.key]);
    const labelSpan = firstFigure > 0 ? firstFigure : 1;

    if (ctx.cards) {
      return (
        <div className="dg-card dg-card-total" role="group" aria-label={label}>
          <p className="dg-card-title">{label}</p>
          <dl className="dg-card-fields">
            {ctx.columns
              .filter((column) => figures[column.key])
              .map((column) => (
                <div key={column.key} className="dg-card-field align-right">
                  <dt>{column.label}</dt>
                  <dd>{figures[column.key]}</dd>
                </div>
              ))}
          </dl>
        </div>
      );
    }

    return (
      <tr className="dg-total-row">
        {Array.from({ length: ctx.leading }, (unused, at) => (
          <td key={`lead-${at}`} />
        ))}
        {/* The label spans the columns before the first figure. */}
        <th scope="row" className="dg-total-label" colSpan={labelSpan}>
          {label}
        </th>
        {ctx.columns.slice(labelSpan).map((column) => (
          <td key={column.key} className={figures[column.key] ? "align-right" : ""}>
            {figures[column.key] || null}
          </td>
        ))}
      </tr>
    );
  };

  const openBillColumns = [
    {
      key: "bill",
      header: "Bill",
      value: (bill) => bill.billNumber || bill.receiptNumber,
      mobile: "title",
      render: (bill) => (
        <span className="bo-cell-stack">
          <strong className={bill.billNumber ? "" : "mono"}>{bill.billNumber || bill.receiptNumber}</strong>
          {bill.billNumber ? (
            <span className="muted small mono">{bill.receiptNumber}</span>
          ) : (
            <span className="muted small stk-no-bill-no">no bill number</span>
          )}
        </span>
      ),
    },
    { key: "billed", header: "Billed", type: "date", value: (bill) => bill.billDate, mobile: "show", render: (bill) => <span className="nowrap">{niceDate(bill.billDate)}</span> },
    { key: "due", header: "Due", type: "date", value: (bill) => bill.dueDate, mobile: "show", render: (bill) => <span className="nowrap">{niceDate(bill.dueDate)}</span> },
    { key: "total", header: "Bill total", type: "money", exact: true, value: (bill) => bill.total, total: "sum", mobile: "show" },
    {
      key: "open",
      header: "Still open",
      type: "money",
      exact: true,
      value: (bill) => bill.open,
      total: "sum",
      mobile: "show",
      render: (bill) => <strong>{moneyExact(bill.open, currency)}</strong>,
    },
    {
      key: "when",
      header: "When",
      type: "number",
      align: "left",
      value: (bill) => (bill.daysLate > 0 ? bill.daysLate : -bill.daysToDue),
      csv: (bill) => (bill.daysLate > 0 ? `${bill.daysLate} days late` : bill.daysToDue === 0 ? "Due today" : `Due in ${bill.daysToDue} days`),
      mobile: "subtitle",
      render: (bill) =>
        bill.daysLate > 0 ? (
          <Chip tone={bill.daysLate > 60 ? "danger" : "warning"}>{bill.daysLate} days late</Chip>
        ) : (
          <Chip tone="success">{bill.daysToDue === 0 ? "Due today" : `Due in ${bill.daysToDue} days`}</Chip>
        ),
    },
  ];

  const print = () =>
    printDocument({
      title: `Statement ${data.supplier.name}`,
      styles: `
        body { font-family: system-ui, sans-serif; font-size: 12px; color: #111; }
        h1 { font-size: 17px; margin: 0 0 4px; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        th, td { border-bottom: 1px solid #ccc; padding: 4px 6px; text-align: left; }
        th { background: #f2f2f2; font-size: 11px; }
        .r { text-align: right; }
        .void td { color: #888; text-decoration: line-through; }
        tfoot td { font-weight: 700; border-top: 2px solid #333; }`,
      body: `
        <h1>Statement of account — ${escapeHtml(data.supplier.name)}</h1>
        <div>${escapeHtml(restaurantName || "")} · ${escapeHtml(niceDate(range.from))} to ${escapeHtml(niceDate(range.to))}${data.supplier.gstNumber ? ` · supplier GSTIN ${escapeHtml(data.supplier.gstNumber)}` : ""}</div>
        <table>
          <thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th class="r">Billed</th><th class="r">Paid / returned</th><th class="r">Balance</th></tr></thead>
          <tbody>
            <tr><td colspan="5">Opening balance</td><td class="r">${signedMoney(data.openingBalance, currency, true)}</td></tr>
            ${data.entries
              .map(
                (entry) => `<tr class="${entry.status === "void" ? "void" : ""}"><td>${escapeHtml(entry.date)}</td><td>${escapeHtml(TYPE_WORDS[entry.type])} ${escapeHtml(entry.number)}</td><td>${escapeHtml(entry.reference || "")}</td><td class="r">${entry.billed ? moneyExact(entry.billed, "") : ""}</td><td class="r">${entry.settled ? moneyExact(entry.settled, "") : ""}</td><td class="r">${signedMoney(entry.balance, "", true)}</td></tr>`
              )
              .join("")}
          </tbody>
          <tfoot><tr><td colspan="5">Balance owed</td><td class="r">${signedMoney(data.closingBalance, currency, true)}</td></tr></tfoot>
        </table>`,
    });

  return (
    <div className="stack">
      <ErrorMessage message={error} />

      <div className="card stk-filter-card">
        <div className="filters">
          <label className="field stk-supplier-pick">
            <span>Supplier</span>
            <select value={supplierId || ""} onChange={(event) => onSupplierChange(event.target.value)}>
              <option value="">Choose a supplier</option>
              {suppliers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <div className="stk-daterange">
            <DateRangeFilter from={range.from} to={range.to} onChange={setRange} label="statement period" />
          </div>
        </div>
      </div>

        {!supplierId ? (
          <div className="card">
            <EmptyState
              icon="file"
              message="Pick a supplier to see their account."
              hint="Every bill, return and payment, with the balance after each."
            />
          </div>
        ) : !data ? (
          <Loading />
        ) : (
          <>
            <div className="stk-section-title stk-statement-head">
              <div>
                <h2>{data.supplier.name}</h2>
                <p className="muted small">
                  {data.supplier.creditDays !== null && data.supplier.creditDays !== undefined
                    ? `${data.supplier.creditDays} days credit`
                    : "No credit terms set — bills fall due on the bill date"}
                  {data.supplier.paymentTerms && !data.supplier.paymentTerms.includes(`${data.supplier.creditDays} day`)
                    ? ` · ${data.supplier.paymentTerms}`
                    : ""}
                  {data.supplier.gstNumber ? ` · GSTIN ${data.supplier.gstNumber}` : ""}
                  {data.supplier.mobile ? ` · ${data.supplier.mobile}` : ""}
                </p>
              </div>
              <div className="stk-actions">
                <button type="button" className="button button-secondary" onClick={print}>
                  <Icon name="print" size={16} /> Print
                </button>
                <button type="button" className="button button-secondary" onClick={exportCsv}>
                  <Icon name="download" size={16} /> Export CSV
                </button>
              </div>
            </div>

            <div className="stat-grid">
              <Tile
                icon="history"
                label="Owed at the start"
                value={signedMoney(data.openingBalance, currency, true)}
                note={niceDate(range.from)}
              />
              <Tile icon="receipt" label="Billed in the period" value={moneyExact(data.totals.billed, currency)} />
              <Tile icon="check-circle" label="Paid and returned" value={moneyExact(data.totals.settled, currency)} tone="success" />
              <Tile
                icon="wallet"
                label={data.closingBalance < 0 ? "Advance with them" : "Owed now"}
                value={moneyExact(Math.abs(data.closingBalance), currency)}
                tone={data.closingBalance > 0 ? "danger" : "info"}
                note={`end of ${niceDate(range.to)}`}
              />
            </div>

            <SectionCard
              icon="file"
              title="Statement"
              description="Every bill, return and payment in the period, with what was owed after each."
              flush
            >
            {/* A running ledger: the balance on each row is what was owed
                after that entry, in date order, as the server worked it out.
                So the rows keep that order (no column sorts, no search or
                filters to drop rows out of it), the opening balance sits above
                and the closing balance below; paging only splits the ledger.
                Its export is the Export CSV above, which carries the opening
                and closing balances too. */}
            <DataGrid
              id="supplier-statement"
              caption={`Statement of account, ${data.supplier.name}`}
              columns={statementColumns}
              rows={data.entries}
              rowKey={(entry) => `${entry.type}-${entry.id}`}
              empty="Nothing in this period."
              emptyIcon="file"
              rowClassName={(entry) => (entry.status === "void" ? "dg-tone-muted" : "")}
              search={false}
              rowNoun={["entry", "entries"]}
              currency={currency}
              toolbar={
                <span className="small">
                  Opening balance at {niceDate(range.from)}:{" "}
                  <strong>{signedMoney(data.openingBalance, currency, true)}</strong>
                </span>
              }
              footer={statementFooter}
            />
            </SectionCard>

            <SectionCard
              icon="clock"
              tone="warning"
              title="Bills still open today"
              description="Oldest first: what to pay next."
              flush
            >
              {data.openBills.length === 0 ? (
                <p className="muted small stk-pad">
                  {data.advance > 0
                    ? `Nothing open — ${moneyExact(data.advance, currency)} paid in advance.`
                    : "Every bill is settled."}
                </p>
              ) : (
                <DataGrid
                  id="supplier-open-bills"
                  caption={`Bills still open with ${data.supplier.name}`}
                  columns={openBillColumns}
                  rows={data.openBills}
                  rowKey={(bill) => bill.id}
                  rowClassName={(bill) => (bill.daysLate > 60 ? "dg-tone-danger" : "")}
                  rowNoun={["bill", "bills"]}
                  currency={currency}
                  exportName={`open-bills-${data.supplier.name.replace(/\W+/g, "-")}`}
                />
              )}
            </SectionCard>
          </>
        )}
    </div>
  );
}
