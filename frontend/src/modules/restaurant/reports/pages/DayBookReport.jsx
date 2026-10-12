import { useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState } from "../../../../components/Feedback";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import Icon from "../../../../components/Icon";
import { count, moneyExact } from "../../../../services/format";
import { downloadCsv } from "../../../../services/csv";
import { dayBookCsv, ledgerCsv } from "./reportCsv";
import { dayAndDate, plural } from "./reportFormat";

// The accountant's day book: every sale, receipt, refund, expense, supplier
// bill and payment as a double-entry voucher, ready for Tally. Each voucher
// balances (debits = credits) and the file says so before it is downloaded.
const TYPE_TONES = {
  Sales: "badge-active",
  Receipt: "badge-info",
  "Credit Note": "badge-warning",
  Payment: "badge-neutral",
  Purchase: "badge-primary",
  "Debit Note": "badge-warning",
  Journal: "badge-neutral",
};

const PAGE = 60;

// "1 receipt", "12 receipts".
const TYPE_WORDS = {
  Sales: ["sales voucher", "sales vouchers"],
  Receipt: ["receipt", "receipts"],
  "Credit Note": ["credit note", "credit notes"],
  Payment: ["payment", "payments"],
  Purchase: ["purchase", "purchases"],
  "Debit Note": ["debit note", "debit notes"],
  Journal: ["journal", "journals"],
};

const typeCount = ({ type, count: number }) => {
  const words = TYPE_WORDS[type] || [type.toLowerCase(), type.toLowerCase()];
  return `${count(number)} ${number === 1 ? words[0] : words[1]}`;
};

// The ledgers the book posts to, and the Tally group to create each under.
// Column lists live outside the component, so their identity never changes.
const LEDGER_COLUMNS = [
  { key: "ledger", header: "Ledger", mobile: "title", filter: "text", value: (row) => row.ledger },
  {
    key: "group",
    header: "Create it under",
    mobile: "subtitle",
    filter: "select",
    value: (row) => row.group,
    render: (row) => <span className="muted">{row.group}</span>,
  },
];

// One voucher's debit and credit lines. A blank side stays blank (the grid
// shows a muted dash), as a voucher is written.
const entryColumns = [
  { key: "ledger", header: "Ledger", mobile: "title", value: (entry) => entry.ledger },
  { key: "debit", header: "Debit", type: "money", exact: true, mobile: "show", value: (entry) => entry.debit || null },
  { key: "credit", header: "Credit", type: "money", exact: true, mobile: "show", value: (entry) => entry.credit || null },
];

export default function DayBookReport({ data, currency }) {
  const [open, setOpen] = useState(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const [showLedgers, setShowLedgers] = useState(false);
  const balanced = data.totals.unbalanced === 0 && data.totals.debit === data.totals.credit;

  const toggle = (key) =>
    setOpen((current) => {
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });

  const file = (suffix) => `${suffix}-${data.from}-to-${data.to}${data.outletName ? `-${data.outletName}` : ""}.csv`;

  return (
    <div className="stack">
      <SectionCard
        icon="book"
        title="Day book for your accountant"
        description={`Vouchers a Tally operator can import: sales by day (one per invoice for company guests and for bills on a guest's account, to their own ledger), receipts by payment method, refunds as credit notes, expenses${
          data.purchasesIncluded ? ", supplier bills and payments" : ""
        }${data.salariesIncluded ? ", and salaries paid" : ""}.`}
        actions={
          <div className="report-actions">
            <button
              type="button"
              className="button button-secondary button-sm"
              disabled={data.ledgers.length === 0}
              onClick={() => downloadCsv(ledgerCsv(data), file("ledgers"))}
            >
              <Icon name="list" size={15} /> Ledger list (CSV)
            </button>
            <button
              type="button"
              className="button button-sm"
              disabled={data.vouchers.length === 0}
              onClick={() => downloadCsv(dayBookCsv(data), file("day-book"))}
            >
              <Icon name="download" size={15} /> Download day book (CSV)
            </button>
          </div>
        }
      >
        <div className="stack">
          <div className="stat-grid">
            <StatTile
              size="sm"
              icon="copy"
              tone="info"
              label="Vouchers"
              value={count(data.totals.vouchers)}
              note={data.totals.byType.map(typeCount).join(" · ") || "none"}
            />
            <StatTile
              size="sm"
              icon={balanced ? "check-circle" : "alert-circle"}
              tone={balanced ? "success" : "danger"}
              label="Debits = credits"
              value={moneyExact(data.totals.debit, currency)}
              note={
                <span className={balanced ? "text-success" : "text-danger"}>
                  {balanced
                    ? "✓ every voucher balances"
                    : `${plural(data.totals.unbalanced, "voucher does", "vouchers do")} not balance`}
                </span>
              }
            />
            <StatTile size="sm" icon="layers" label="Ledgers used" value={count(data.ledgers.length)}>
              <button type="button" className="link-button small report-tile-link" onClick={() => setShowLedgers(!showLedgers)}>
                {showLedgers ? "Hide the list" : "See which, and their Tally groups"}
              </button>
            </StatTile>
          </div>

          {/* What this book leaves out: a partial book must never be posted
              to Tally as the whole one. */}
          {(data.notes || []).length > 0 && (
            <div className="alert alert-notice">
              {data.notes.map((note) => (
                <p key={note} className="small">
                  {note}
                </p>
              ))}
            </div>
          )}

          {showLedgers && (
            <DataGrid
              id="day-book-ledgers"
              caption="Ledgers used, with their Tally groups"
              columns={LEDGER_COLUMNS}
              rows={data.ledgers}
              rowKey={(row) => row.ledger}
              empty="No ledgers in this period."
              emptyIcon="layers"
              exportName="day-book-ledgers"
              rowNoun={["ledger", "ledgers"]}
            />
          )}
        </div>
      </SectionCard>

      <SectionCard
        icon="list"
        tone="neutral"
        title="Vouchers"
        description="Open a voucher to see its debit and credit lines."
        flush
      >
        {data.vouchers.length === 0 ? (
          <EmptyState
            icon="book"
            message="Nothing to post in this period."
            hint="Sales, receipts, refunds and expenses in the range appear here as vouchers."
          />
        ) : (
          <ul className="voucher-list">
            {data.vouchers.slice(0, shown).map((voucher, index) => {
              const key = `${voucher.type}-${voucher.number}-${index}`;
              const isOpen = open.has(key);

              return (
                <li key={key} className={`voucher ${isOpen ? "is-open" : ""}`}>
                  <button type="button" className="voucher-head" aria-expanded={isOpen} onClick={() => toggle(key)}>
                    <span className="voucher-date nowrap">{dayAndDate(voucher.date)}</span>
                    <span className={`badge ${TYPE_TONES[voucher.type] || "badge-neutral"}`}>{voucher.type}</span>
                    <span className="voucher-body">
                      <span className="mono small">
                        {voucher.number}
                        {voucher.reference && <span className="muted"> · their no. {voucher.reference}</span>}
                      </span>
                      <span className="voucher-party">{voucher.party}</span>
                      <span className="muted small voucher-narration">{voucher.narration}</span>
                    </span>
                    <span className="voucher-amount nowrap">{moneyExact(voucher.amount, currency)}</span>
                    <span className="voucher-toggle" aria-hidden="true">
                      <Icon name={isOpen ? "chevron-up" : "chevron-down"} size={16} />
                    </span>
                  </button>

                  {isOpen && (
                    <div className="table-wrap voucher-entries">
                      {/* Every voucher's lines share one remembered layout:
                          the same three columns each time. A few lines, so
                          no export of their own (the day book download has
                          them). */}
                      <DataGrid
                        id="day-book-voucher-entries"
                        caption={`${voucher.type} ${voucher.number}: debit and credit lines`}
                        columns={entryColumns}
                        rows={voucher.entries}
                        rowKey={(entry) => entry.ledger}
                        variant="compact"
                        pageSize={false}
                        currency={currency}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {data.vouchers.length > shown && (
          <div className="report-more report-card-foot">
            <span className="muted small">
              Showing {count(shown)} of {count(data.vouchers.length)} vouchers — the download has all of them.
            </span>
            <button type="button" className="button button-secondary button-sm" onClick={() => setShown(shown + PAGE * 4)}>
              Show more
            </button>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
