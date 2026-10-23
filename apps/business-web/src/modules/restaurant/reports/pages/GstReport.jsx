import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { EmptyState, ErrorMessage } from "../../../../components/Feedback";
import { clearBillRecipient, setBillRecipient } from "../services/report.service";
import { getErrorMessage } from "../../../../services/api";
import { count, moneyExact } from "@bmp/shared/format";
import { downloadCsv } from "../../../../services/csv";
import { orderTypeLabel } from "../../../../services/labels";
import useShake from "../../../../hooks/useShake";
import { gstinHint, tidyGstin } from "../../../../services/guestBook";
import { gstCsv } from "./reportCsv";
import "../styles/branch-reports.css";
import { fullDate, plural, ratePercent } from "./reportFormat";

// The GST filing pack: what an accountant needs to file GSTR-1 for the
// period without rebuilding it bill by bill. Every figure is the bills' own,
// to the paisa, and the pack checks itself against them (see "Checks").
const SECTIONS = [
  { key: "summary", label: "Summary" },
  { key: "register", label: "Sales register" },
  { key: "b2b", label: "B2B" },
  { key: "b2c", label: "B2C" },
  { key: "hsn", label: "HSN / SAC" },
  { key: "credit", label: "Credit notes" },
  { key: "advances", label: "Advances (11A/11B)" },
  { key: "documents", label: "Documents" },
];

// A deduction reads "−₹3,868.40", the way an accountant writes it.
const signed = (value, currency) =>
  value < 0 ? `−${moneyExact(-value, currency)}` : moneyExact(value, currency);

// Every table of the pack is a data grid (components/DataGrid). Money is in
// the restaurant's own currency and to the paisa; each section keeps its own
// GST-format download (the file the accountant uploads), so the grids carry
// no second export of their own.

// Added in paise, so a column of ₹0.10s ties out to the bills to the paisa.
// `pick` is a field name, or a function reading the figure from a row.
const sumOf = (rows, pick) =>
  rows.reduce((sum, row) => sum + Math.round(Number((typeof pick === "function" ? pick(row) : row[pick]) || 0) * 100), 0) /
  100;

const TAX_KEYS = ["taxableValue", "cgst", "sgst", "cess", "taxAmount"];

// The four GST money columns, in the order the return lists them. Cess is
// left off the screen when nothing in the pack carried any (the summary says
// so under its table); the downloaded files always keep the column.
// `folded`: on the long bill-by-bill lists (the register, the credit notes)
// the CGST, SGST and cess columns start hidden, so a line fits the screen
// with its taxable value, total tax and value; "Columns" shows them again
// (remembered for the viewer).
const taxColumns = (split, currency, cess = true, folded = false) =>
  [
    { key: "taxableValue", header: "Taxable value", mobile: "show" },
    split && { key: "cgst", header: "CGST", defaultHidden: folded },
    split && { key: "sgst", header: "SGST", defaultHidden: folded },
    cess && { key: "cess", header: "Cess", defaultHidden: folded },
    { key: "taxAmount", header: "Total tax", mobile: "show" },
  ]
    .filter(Boolean)
    .map((column) => ({
      ...column,
      type: "money",
      exact: true,
      // Added up by the grid itself (in paise, over the rows on show) where
      // a grid has no totals band of its own; a grid with its own band keeps it.
      total: "sum",
      render: (row) => signed(row[column.key], currency),
    }));

// A line of GST figures for a totals band, from a row of figures.
const taxFigures = (row, currency, keys = TAX_KEYS) =>
  Object.fromEntries(keys.map((key) => [key, signed(row[key] || 0, currency)]));

// The same, added up over the rows on show.
const taxSums = (rows, currency, keys = TAX_KEYS) =>
  Object.fromEntries(keys.map((key) => [key, signed(sumOf(rows, key), currency)]));

// The totals band under a grid: one row per line on a wide screen, one summary
// card per line on a phone. `lines(rows)` gets the rows that pass the search
// and filters, and returns [{ label, values: { columnKey: text } }]. A line's
// figures follow the columns on show (a hidden column hides its total too),
// and its words sit in the first column on show that has no figure.
const totalsFooter = (lines) => (ctx) => {
  const list = ctx.rows.length > 0 ? lines(ctx.rows).filter(Boolean) : [];

  if (list.length === 0) {
    return null;
  }

  if (ctx.cards) {
    return list.map((line) => (
      <div key={line.label} className="dg-card dg-card-total" role="group" aria-label={line.label}>
        <p className="dg-card-title">{line.label}</p>
        <dl className="dg-card-fields">
          {ctx.columns
            .filter((column) => line.values[column.key] !== undefined)
            .map((column) => (
              <div key={column.key} className={`dg-card-field align-${column.align}`}>
                <dt>{column.label}</dt>
                <dd>{line.values[column.key]}</dd>
              </div>
            ))}
        </dl>
      </div>
    ));
  }

  return list.map((line) => {
    const labelAt = ctx.columns.findIndex((column) => line.values[column.key] === undefined && column.type !== "actions");

    return (
      <tr key={line.label} className="dg-total-row">
        {Array.from({ length: ctx.leading }, (_, at) => (
          <td key={`lead-${at}`} />
        ))}
        {ctx.columns.map((column, at) =>
          at === labelAt ? (
            <th key={column.key} scope="row" className="dg-total-label">
              {line.label}
            </th>
          ) : (
            <td key={column.key} className={`align-${column.align} type-${column.type}`}>
              {line.values[column.key] ?? null}
            </td>
          )
        )}
      </tr>
    );
  });
};

function DownloadButton({ data, section, label }) {
  return (
    <button
      type="button"
      className="button button-secondary button-sm report-download"
      onClick={() => {
        const file = gstCsv(data, section);
        downloadCsv(file.rows, file.name);
      }}
    >
      <Icon name="download" size={15} />
      {label || "Download CSV"}
    </button>
  );
}

// Who files under a registration: "Main counter, Cafe Corner".
const countersOf = (registration) =>
  registration.counters.length > 0 ? registration.counters.join(", ") : "No documents in this period";

export default function GstReport({ data, currency, canMarkB2b, onChanged, onRegistration }) {
  const [section, setSection] = useState("summary");
  const split = data.gstSplit;
  // Any cess on an invoice or a credit note of the pack.
  const cess = Boolean(data.registerTotals.cess || data.creditNotes.totals.cess);
  // Each GST registration files its own GSTR-1. A branch registered on its
  // own is never filed under the restaurant's number: the pack is one
  // registration's, picked here when there is more than one.
  const registrations = data.registrations || [];
  const several = registrations.length > 1;

  return (
    <div className="stack">
      <div className="gst-top">
        <SectionCard
          icon="file"
          title={several ? "The GST registration this pack is for" : "Your GST registration"}
          description={
            several
              ? `This restaurant files ${registrations.length} GST returns, one for each registration. This pack is one of them.`
              : "The number this pack is filed under."
          }
        >
          <div className="gst-identity">
            <div className="gst-identity-main">
              <span className="gst-identity-label">GSTIN</span>
              <strong className={`mono gst-number ${data.gstNumber ? "" : "is-missing"}`}>
                {data.gstNumber || "Not set"}
              </strong>
              <span className="muted small">
                {data.state ? `${data.state} · ` : ""}place of supply {data.placeOfSupply}
              </span>
            </div>
            <p className="gst-identity-note muted small">
              A restaurant supplies where the food is served, so every sale is CGST + SGST — never
              IGST, even to a company registered in another state.
              {!data.gstNumber && (
                <>
                  {" "}
                  <Link to="/restaurant/settings">Add your GSTIN in Settings</Link>.
                </>
              )}
            </p>
          </div>

          {several && (
            <div className="gst-registrations">
              <p className="gst-registrations-note muted small">
                Pick the registration to file. Its invoices and credit notes are the only ones in this pack.
              </p>
              <div className="gst-registration-list" role="radiogroup" aria-label="GST registration">
                {registrations.map((registration) => (
                  <button
                    type="button"
                    key={registration.gstin || "none"}
                    role="radio"
                    aria-checked={registration.selected}
                    className={`gst-registration ${registration.selected ? "is-active" : ""}`}
                    onClick={() => !registration.selected && onRegistration && onRegistration(registration.gstin || "none")}
                  >
                    <span className="gst-registration-number">
                      {registration.gstin || "No GSTIN set"}
                      {registration.isRestaurant ? " · restaurant" : ""}
                    </span>
                    <span className="gst-registration-who">
                      {countersOf(registration)} · {plural(registration.invoiceCount, "invoice", "invoices")}
                      {registration.creditNoteCount > 0
                        ? `, ${plural(registration.creditNoteCount, "credit note", "credit notes")}`
                        : ""}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard
          icon={data.checks.every((check) => check.ok) ? "check-circle" : "alert-circle"}
          tone={data.checks.every((check) => check.ok) ? "success" : "danger"}
          title="Checks against the bills"
          description="The pack is added up again from the bills; each line says whether it agrees."
        >
          <ul className="report-checks" aria-label="Checks">
            {data.checks.map((check) => (
              <li key={check.key} className={check.ok ? "is-ok" : "is-off"}>
                <span aria-hidden="true">
                  <Icon name={check.ok ? "check" : "x"} size={13} strokeWidth={3} />
                </span>
                <span>
                  <span className="sr-only">{check.ok ? "Passed: " : "Failed: "}</span>
                  {check.label}
                  <span className="muted small"> — {check.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      {data.warnings.length > 0 && (
        <ul className="report-warnings">
          {data.warnings.map((warning) => (
            <li key={warning} className="alert alert-notice">
              {warning}
            </li>
          ))}
        </ul>
      )}

      <div className="stat-grid">
        <StatTile
          icon="receipt"
          tone="info"
          label="Invoices"
          value={count(data.registerTotals.invoices)}
          note={
            data.registerTotals.cancelled > 0
              ? `${count(data.registerTotals.cancelled)} cancelled, listed apart`
              : "none cancelled"
          }
        />
        <StatTile
          icon="rupee"
          label="Taxable value"
          value={moneyExact(data.registerTotals.taxableValue, currency)}
          note="service charge included"
        />
        <StatTile
          icon="percent"
          label="GST on the invoices"
          value={moneyExact(data.registerTotals.taxAmount, currency)}
          note={
            split
              ? `CGST ${moneyExact(data.registerTotals.cgst, currency)} + SGST ${moneyExact(data.registerTotals.sgst, currency)}${
                  data.registerTotals.cess ? ` + cess ${moneyExact(data.registerTotals.cess, currency)}` : ""
                }`
              : undefined
          }
        />
        <StatTile
          icon="undo"
          tone="warning"
          label="Less credit notes"
          value={moneyExact(data.creditNotes.totals.taxAmount, currency)}
          note={plural(data.creditNotes.totals.count, "credit note", "credit notes")}
        />
        <StatTile
          icon="scale"
          tone="primary"
          label="Net GST for the period"
          value={moneyExact(data.net.taxAmount, currency)}
          note={`on ${moneyExact(data.net.taxableValue, currency)}`}
        />
      </div>

      <div className="segmented report-sections" role="tablist" aria-label="GST filing pack">
        {SECTIONS.map((option) => (
          <button
            type="button"
            key={option.key}
            role="tab"
            aria-selected={section === option.key}
            className={`segment ${section === option.key ? "is-active" : ""}`}
            onClick={() => setSection(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {section === "summary" && <Summary data={data} currency={currency} split={split} cess={cess} />}
      {section === "register" && (
        <Register data={data} currency={currency} split={split} cess={cess} canMarkB2b={canMarkB2b} onChanged={onChanged} />
      )}
      {section === "b2b" && <B2b data={data} currency={currency} split={split} cess={cess} />}
      {section === "b2c" && <B2c data={data} currency={currency} split={split} cess={cess} />}
      {section === "hsn" && <Hsn data={data} currency={currency} split={split} cess={cess} />}
      {section === "credit" && <CreditNotes data={data} currency={currency} split={split} cess={cess} />}
      {section === "advances" && <Advances data={data} currency={currency} />}
      {section === "documents" && <Documents data={data} />}
    </div>
  );
}

// GSTR-1 tables 11A and 11B. An advance or deposit is
// taxed when it is received, not when the bill is raised: 11A is what was
// received in the period and not yet billed in it (tax due now), 11B what
// was received earlier and used on this period's bills (that tax is taken
// back, the bill carries it). Worked out at the restaurant's food rate from
// the advances themselves (GET /bills/advances/gst).
function Advances({ data, currency }) {
  const advances = data.advances;

  if (!advances) {
    return (
      <div className="card">
        <EmptyState
          icon="wallet"
          message="Advances are filed with the restaurant's own registration."
          hint="Pick the restaurant's own GSTIN (and All outlets) to see tables 11A and 11B."
        />
      </div>
    );
  }

  const rows = [
    { key: "11A", table: "11A (1)", what: "Advances received in the period, not billed in it: tax due now", ...advances.table11A },
    { key: "11B", table: "11B (1)", what: "Advances received earlier, used on this period's bills: tax adjusted", ...advances.table11B },
  ];
  const columns = [
    { key: "table", header: "Table", mobile: "title", value: (row) => row.table, render: (row) => <strong>{row.table}</strong> },
    { key: "what", header: "What it is", mobile: "subtitle", value: (row) => row.what },
    { key: "gross", header: "Advance (with GST)", type: "money", exact: true, mobile: "show", value: (row) => row.gross },
    { key: "taxable", header: "Taxable value", type: "money", exact: true, mobile: "show", value: (row) => row.taxable },
    { key: "cgst", header: "CGST", type: "money", exact: true, mobile: "show", value: (row) => row.cgst },
    { key: "sgst", header: "SGST", type: "money", exact: true, mobile: "show", value: (row) => row.sgst },
  ];

  return (
    <SectionCard
      icon="wallet"
      tone="info"
      title="Advances received and adjusted"
      description={`${plural(advances.receivedCount, "advance", "advances")} received in the period (${moneyExact(advances.received, currency)}), ${moneyExact(advances.usedSamePeriod, currency)} of it used on bills in the same period. Rate ${advances.rate}%, place of supply your own state.`}
      flush
    >
      <DataGrid
        id="gst-advances"
        caption="GSTR-1 tables 11A and 11B"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        variant="compact"
        pageSize={false}
        currency={currency}
      />
    </SectionCard>
  );
}

// GSTR-1 at a glance: each table's totals, the credit notes against them, and
// what is left.
function Summary({ data, currency, split, cess }) {
  const nil = data.nilExempt.reduce((sum, row) => sum + row.nilRatedOrExempt, 0);
  const rows = [
    {
      key: "b2b",
      label: "B2B invoices (to registered buyers)",
      count: data.b2b.summary.reduce((sum, row) => sum + row.invoiceCount, 0),
      ...data.b2b.totals,
    },
    { key: "b2c", label: "B2C (to consumers), by rate", count: null, ...data.b2c.totals },
    { key: "nil", label: "Nil rated / exempt (0%)", count: null, taxableValue: nil, cgst: 0, sgst: 0, cess: 0, taxAmount: 0 },
  ];

  if (data.untaxedServiceCharge > 0) {
    rows.push({
      key: "sc",
      label: "Service charge billed without GST",
      count: null,
      taxableValue: data.untaxedServiceCharge,
      cgst: 0,
      sgst: 0,
      cess: 0,
      taxAmount: 0,
      flag: true,
    });
  }

  const credit = data.creditNotes.totals;
  const columns = [
    {
      key: "label",
      header: "Table",
      mobile: "title",
      sortable: false,
      render: (row) => (
        <>
          {row.label}
          {row.flag && (
            <>
              {" "}
              <span className="badge badge-warning status-badge">
                <span className="badge-dot" aria-hidden="true" />
                check with your accountant
              </span>
            </>
          )}
        </>
      ),
    },
    {
      key: "count",
      header: "Invoices",
      type: "number",
      sortable: false,
      render: (row) => (row.count === null ? "—" : count(row.count)),
    },
    ...taxColumns(split, currency, cess).map((column) => ({ ...column, sortable: false })),
  ];

  // The return's own arithmetic under the tables: what was invoiced, the
  // credit notes against it, and what is left to file.
  const footer = totalsFooter(() => [
    {
      label: "Invoices in the period",
      values: { count: count(data.registerTotals.invoices), ...taxFigures(data.registerTotals, currency) },
    },
    {
      label: "Less credit notes",
      values: {
        count: count(credit.count),
        ...taxFigures(
          {
            taxableValue: -credit.taxableValue,
            cgst: -credit.cgst,
            sgst: -credit.sgst,
            cess: -credit.cess,
            taxAmount: -credit.taxAmount,
          },
          currency
        ),
      },
    },
    { label: "Net for the period", values: taxFigures(data.net, currency) },
  ]);

  return (
    <SectionCard
      icon="clipboard"
      title="GSTR-1 summary"
      description="Each table of the return, the credit notes against them, and what is left to file."
      actions={<DownloadButton data={data} section="summary" />}
      flush
    >
      {/* The return's tables in the return's order: sorting them would only
          scramble a statement that reads top to bottom. */}
      <DataGrid
        id="gst-summary"
        caption="GSTR-1 summary"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        variant="compact"
        pageSize={false}
        currency={currency}
        footer={footer}
      />
      <p className="muted small report-card-foot">
        {data.registerTotals.cess
          ? "Cess is filed in its own column, never inside CGST or SGST. "
          : "Cess: no cess is charged on any bill, so it is nil throughout (the tables here leave its column out; the downloads keep it). "}
        Round-off (
        {data.registerTotals.roundOff < 0
          ? `−${moneyExact(-data.registerTotals.roundOff, currency)}`
          : moneyExact(data.registerTotals.roundOff, currency)}
        ) is part of the invoice value, not of the taxable value.
      </p>
    </SectionCard>
  );
}

const REGISTER_FILTERS = [
  { key: "all", label: "All" },
  { key: "b2b", label: "B2B only" },
  { key: "cancelled", label: "Cancelled" },
];

// A cancelled invoice stays in the series at nil value.
const valueOf = (row) => (row.status === "cancelled" ? 0 : row.invoiceValue);

function Register({ data, currency, split, cess, canMarkB2b, onChanged }) {
  const [filter, setFilter] = useState("all");
  const [marking, setMarking] = useState(null);

  // The switch above the grid picks which invoices; the grid's own search
  // box then finds one by number, GSTIN or buyer.
  const rows = useMemo(
    () =>
      data.register.filter((row) => {
        if (filter === "b2b") {
          return Boolean(row.recipientGstin);
        }

        return filter === "cancelled" ? row.status === "cancelled" : true;
      }),
    [data.register, filter]
  );

  // Built once per view: the register can run to thousands of invoices, and
  // a new column list makes the grid read every row again.
  const columns = useMemo(() => [
    {
      key: "invoice",
      header: "Invoice",
      mobile: "title",
      value: (row) => row.invoiceNumber,
      // The badge goes under the number when the column is narrow, rather
      // than widening the register past the screen.
      render: (row) => (
        <>
          <span className="mono nowrap">{row.invoiceNumber}</span>
          {row.status === "cancelled" && (
            <>
              {" "}
              <span className="badge badge-danger status-badge" title={row.reason || ""}>
                <span className="badge-dot" aria-hidden="true" />
                Cancelled
              </span>
            </>
          )}
          <span className="muted small gst-cell-line">{orderTypeLabel(row.orderType)}</span>
        </>
      ),
    },
    {
      key: "date",
      header: "Date",
      type: "date",
      mobile: "subtitle",
      value: (row) => row.invoiceDate,
      render: (row) => fullDate(row.invoiceDate),
    },
    {
      key: "buyer",
      header: "Buyer (B2B)",
      minWidth: 170,
      mobile: "show",
      value: (row) => (row.recipientGstin ? `${row.recipientGstin} ${row.recipientName || ""}` : "Consumer (B2C)"),
      render: (row) => (
        <>
          {row.recipientGstin ? (
            <>
              <span className="mono">{row.recipientGstin}</span>
              <span className="small gst-cell-line">{row.recipientName}</span>
            </>
          ) : (
            <span className="muted small">Consumer (B2C)</span>
          )}
          {canMarkB2b && row.status !== "cancelled" && (
            <span className="gst-cell-line">
              <button type="button" className="link-button small" onClick={() => setMarking(row)}>
                {row.recipientGstin ? "Change" : "Add buyer's GSTIN"}
              </button>
            </span>
          )}
        </>
      ),
    },
    ...taxColumns(split, currency, cess, true),
    {
      key: "invoiceValue",
      header: "Invoice value",
      type: "money",
      exact: true,
      mobile: "show",
      value: valueOf,
      render: (row) =>
        row.status === "cancelled" ? (
          <span className="muted small" title="What the bill said before it was voided">
            was {moneyExact(row.voidedValue, currency)}
          </span>
        ) : (
          moneyExact(row.invoiceValue, currency)
        ),
    },
  ], [split, cess, currency, canMarkB2b]);

  // Over the invoices on show: the switch and the search narrow it, and a
  // cancelled invoice counts at nil, as in the return.
  const footer = totalsFooter((shown) => {
    // Said as the pack's own count does: invoices, and the cancelled numbers
    // listed apart (at nil value).
    const cancelled = shown.filter((row) => row.status === "cancelled").length;

    return [
      {
        label: `Total · ${plural(shown.length - cancelled, "invoice", "invoices")}${
          cancelled > 0 ? `, ${count(cancelled)} cancelled` : ""
        }`,
        values: { ...taxSums(shown, currency), invoiceValue: signed(sumOf(shown, valueOf), currency) },
      },
    ];
  });

  return (
    <SectionCard
      icon="list"
      tone="info"
      title="Sales register"
      description="Every invoice number in the period, bill by bill. Cancelled (voided) invoices stay in the list at nil value, so the number series has no holes."
      actions={<DownloadButton data={data} section="register" />}
      flush
    >
      <DataGrid
        id="gst-register"
        caption="Sales register"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.billId}
        search="Invoice no, GSTIN or buyer"
        toolbar={
          <div className="segmented" role="radiogroup" aria-label="Which invoices">
            {REGISTER_FILTERS.map((option) => (
              <button
                type="button"
                key={option.key}
                role="radio"
                aria-checked={filter === option.key}
                className={`segment ${filter === option.key ? "is-active" : ""}`}
                onClick={() => setFilter(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
        empty={
          filter === "b2b"
            ? "No B2B invoices in this period."
            : filter === "cancelled"
              ? "No invoice was cancelled in this period."
              : "No invoices in this period."
        }
        emptyIcon="receipt"
        emptyHint={filter === "all" ? undefined : "Pick All above to see every invoice in the period."}
        rowClassName={(row) => (row.status === "cancelled" ? "dg-tone-muted" : "")}
        currency={currency}
        footer={footer}
      />

      {marking && (
        <RecipientDialog
          row={marking}
          onClose={() => setMarking(null)}
          onSaved={() => {
            setMarking(null);
            onChanged();
          }}
        />
      )}
    </SectionCard>
  );
}

// Writing a company guest's GSTIN on an invoice, so it files under B2B.
function RecipientDialog({ row, onClose, onSaved }) {
  const [gstin, setGstin] = useState(row.recipientSource === "bill" ? row.recipientGstin : "");
  const [legalName, setLegalName] = useState(row.recipientSource === "bill" ? row.recipientName : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // A wrong GSTIN (a wrong check character, a mistyped state code) shakes the
  // field beside the words of the refusal. It is checked here first, the same
  // way the server checks it, so a typo is refused before anything is sent;
  // the server still has the last word.
  const [gstinRef, shakeGstin] = useShake();
  const hint = gstinHint(gstin);

  const save = async (event) => {
    event.preventDefault();
    setError("");

    if (hint && !hint.ok) {
      setError(`The buyer's GSTIN is not right yet. ${hint.text}.`);
      shakeGstin();
      return;
    }

    setSaving(true);

    try {
      await setBillRecipient(row.billId, { gstin: tidyGstin(gstin), legalName });
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
      shakeGstin();
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError("");

    try {
      await clearBillRecipient(row.billId);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`B2B invoice — ${row.invoiceNumber}`}
      description="Put a registered buyer's GSTIN on this invoice, so it files under B2B."
      icon="file"
      onClose={onClose}
    >
      <form className="form-grid" onSubmit={save}>
        <ErrorMessage message={error} />

        <p className="alert alert-info field-wide">
          The buyer claims input tax credit only if their GSTIN on the invoice is exactly right. It is
          checked here, character by character. Reprint the bill for the guest after saving. What you enter is
          for this invoice only: a GSTIN added to the guest&apos;s record later never changes it.
        </p>

        <label className="field" ref={gstinRef}>
          <span>Buyer&apos;s GSTIN</span>
          <input
            value={gstin}
            onChange={(event) => setGstin(event.target.value.toUpperCase())}
            placeholder="27AAPFU0939F1ZV"
            maxLength={20}
            className="mono"
            required
            autoFocus
            aria-invalid={hint && !hint.ok ? true : undefined}
          />
          {hint && <small className={hint.ok ? "gst-hint-ok" : "gst-hint-bad"}>{hint.text}</small>}
        </label>

        <label className="field">
          <span>Registered name</span>
          <input
            value={legalName}
            onChange={(event) => setLegalName(event.target.value)}
            placeholder="As on the GST certificate"
            maxLength={150}
            required
          />
        </label>

        <div className="form-actions field-wide">
          {row.recipientSource === "bill" && (
            <button type="button" className="button button-ghost report-dialog-aside" onClick={clear} disabled={saving}>
              <Icon name="trash" size={16} /> Remove GSTIN
            </button>
          )}
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function B2b({ data, currency, split, cess }) {
  if (data.b2b.invoices.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon="users"
          message="No B2B invoices in this period."
          hint="A bill is a B2B invoice when it is raised for a guest whose record carries a GSTIN, or when you add the buyer's GSTIN to it in the Sales register."
        />
      </div>
    );
  }

  const buyerColumns = [
    { key: "gstin", header: "GSTIN", mobile: "title", render: (row) => <span className="mono nowrap">{row.gstin}</span> },
    {
      key: "buyer",
      header: "Buyer",
      mobile: "subtitle",
      value: (row) => row.recipientName,
      render: (row) => (
        <>
          {row.recipientName}
          <span className="muted small gst-cell-line">{row.state}</span>
        </>
      ),
    },
    { key: "invoiceCount", header: "Invoices", type: "number", mobile: "show", total: "sum" },
    {
      key: "invoiceValue",
      header: "Invoice value",
      type: "money",
      exact: true,
      mobile: "show",
      total: "sum",
      render: (row) => moneyExact(row.invoiceValue, currency),
    },
    ...taxColumns(split, currency, cess),
  ];

  const invoiceColumns = [
    {
      key: "invoice",
      header: "Invoice",
      mobile: "title",
      value: (row) => row.invoiceNumber,
      render: (row) => (
        <span className="nowrap">
          <span className="mono">{row.invoiceNumber}</span>
          <span className="muted small gst-cell-line">{fullDate(row.invoiceDate)}</span>
        </span>
      ),
    },
    { key: "gstin", header: "GSTIN", mobile: "subtitle", render: (row) => <span className="mono nowrap">{row.gstin}</span> },
    {
      key: "rate",
      header: "Rate",
      type: "percent",
      mobile: "show",
      render: (row) => (
        <>
          {ratePercent(row.rate)}
          {row.cessRate > 0 && <span className="muted small gst-cell-line">+ {ratePercent(row.cessRate)} cess</span>}
          {row.isServiceCharge && <span className="muted small gst-cell-line">service charge</span>}
        </>
      ),
    },
    ...taxColumns(split, currency, cess),
  ];

  return (
    <div className="stack">
      <SectionCard
        icon="users"
        title="By buyer (GSTIN)"
        description="Registered buyers who can claim input tax credit on these invoices."
        actions={<DownloadButton data={data} section="b2b" label="Download B2B (CSV)" />}
        flush
      >
        <DataGrid
          id="gst-b2b-buyers"
          caption="B2B invoices by buyer"
          columns={buyerColumns}
          rows={data.b2b.summary}
          rowKey={(row) => row.gstin}
          variant="compact"
          currency={currency}
          rowNoun={["buyer", "buyers"]}
        />
      </SectionCard>

      <SectionCard
        icon="receipt"
        tone="neutral"
        title="Invoice by invoice"
        description="One line per invoice and tax rate, as the return lists them."
        flush
      >
        <DataGrid
          id="gst-b2b-invoices"
          caption="B2B invoices, one line per invoice and rate"
          columns={invoiceColumns}
          rows={data.b2b.invoices}
          rowKey={(row, index) => `${row.invoiceNumber}-${row.rate}-${index}`}
          search="Invoice no or GSTIN"
          currency={currency}
          rowNoun={["line", "lines"]}
        />
      </SectionCard>
    </div>
  );
}

function B2c({ data, currency, split, cess }) {
  const rateColumns = [
    {
      key: "rate",
      header: "Rate",
      type: "percent",
      mobile: "title",
      render: (row) => ratePercent(row.rate),
    },
    ...taxColumns(split, currency, cess),
  ];

  const nilColumns = [
    { key: "description", header: "Supplies", mobile: "title" },
    {
      key: "nilRatedOrExempt",
      header: "Nil rated or exempt",
      type: "money",
      exact: true,
      render: (row) => moneyExact(row.nilRatedOrExempt, currency),
    },
    { key: "nonGst", header: "Non-GST", type: "money", exact: true, render: (row) => moneyExact(row.nonGst, currency) },
  ];

  return (
    <div className="stack">
      <SectionCard
        icon="users"
        tone="info"
        title="B2C (others), by rate"
        description={`Place of supply: ${data.placeOfSupply} · intra-state`}
        actions={<DownloadButton data={data} section="b2c" label="Download B2CS (CSV)" />}
        flush
      >
        <DataGrid
          id="gst-b2c"
          caption="B2C sales by rate"
          columns={rateColumns}
          rows={data.b2c.rows}
          rowKey={(row) => row.rate}
          variant="compact"
          pageSize={false}
          empty="No taxable sales to consumers in this period."
          emptyIcon="receipt"
          currency={currency}
          footer={totalsFooter(() => [{ label: "Total", values: taxFigures(data.b2c.totals, currency) }])}
        />
      </SectionCard>

      <SectionCard
        icon="leaf"
        tone="success"
        title="Nil rated and exempt"
        description="Sales at 0% GST, reported apart from the taxable ones."
        flush
      >
        <DataGrid
          id="gst-nil-exempt"
          caption="Nil rated and exempt sales"
          columns={nilColumns}
          rows={data.nilExempt}
          rowKey={(row) => row.supply}
          variant="compact"
          pageSize={false}
          empty="No 0% sales in this period."
          emptyIcon="leaf"
          currency={currency}
        />
      </SectionCard>
    </div>
  );
}

function Hsn({ data, currency, split, cess }) {
  const groups = [
    { key: "b2b", label: "To registered buyers (B2B)" },
    { key: "b2c", label: "To consumers (B2C)" },
  ]
    .map((group) => ({ ...group, rows: data.hsn.rows.filter((row) => row.supply === group.key) }))
    .filter((group) => group.rows.length > 0);

  const columns = [
    {
      key: "hsnCode",
      header: "HSN / SAC",
      mobile: "title",
      render: (row) =>
        row.hsnCode === "—" ? (
          <span className="badge badge-warning status-badge">
            <span className="badge-dot" aria-hidden="true" />
            missing
          </span>
        ) : (
          <span className="mono nowrap">{row.hsnCode}</span>
        ),
    },
    { key: "description", header: "Description", mobile: "subtitle", render: (row) => row.description || "—" },
    { key: "uqc", header: "UQC" },
    {
      key: "quantity",
      header: "Qty",
      type: "number",
      value: (row) => (row.uqc === "NA" ? null : row.quantity),
      render: (row) => (row.uqc === "NA" ? "—" : count(row.quantity)),
    },
    {
      key: "rate",
      header: "Rate",
      type: "percent",
      mobile: "show",
      render: (row) => (
        <span className="nowrap">
          {ratePercent(row.rate)}
          {row.cessRate > 0 && <span className="muted small gst-cell-line">+ {ratePercent(row.cessRate)} cess</span>}
        </span>
      ),
    },
    {
      key: "totalValue",
      header: "Total value",
      type: "money",
      exact: true,
      mobile: "show",
      total: "sum",
      render: (row) => moneyExact(row.totalValue, currency),
    },
    ...taxColumns(split, currency, cess),
  ];

  if (groups.length === 0) {
    return (
      <SectionCard
        icon="tag"
        title="HSN / SAC summary"
        description="Split B2B and B2C, as the return now asks. Services (codes starting 99) carry no quantity."
        actions={<DownloadButton data={data} section="hsn" label="Download HSN (CSV)" />}
      >
        <EmptyState icon="tag" message="No sales in this period." />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      icon="tag"
      title="HSN / SAC summary"
      description="Split B2B and B2C, as the return now asks. Services (codes starting 99) carry no quantity."
      actions={<DownloadButton data={data} section="hsn" label="Download HSN (CSV)" />}
      flush
    >
      {/* One grid for each half of the return, its name in the grid's own
          heading row. */}
      {groups.map((group) => (
        <DataGrid
          key={group.key}
          id={`gst-hsn-${group.key}`}
          caption={`HSN / SAC summary — ${group.label}`}
          columns={columns}
          rows={group.rows}
          rowKey={(row) => `${row.hsnCode}-${row.rate}-${row.cessRate || 0}`}
          variant="compact"
          toolbar={<h3 className="report-subhead">{group.label}</h3>}
          className="gst-hsn-grid"
          currency={currency}
          rowNoun={["line", "lines"]}
        />
      ))}
    </SectionCard>
  );
}

function CreditNotes({ data, currency, split, cess }) {
  const { rows } = data.creditNotes;

  const columns = useMemo(
    () => [
      {
        key: "creditNote",
        header: "Credit note",
        mobile: "title",
        value: (row) => row.creditNoteNumber || "Refund",
        render: (row) => (
          <span className="nowrap">
            <span className="mono">{row.creditNoteNumber || "Refund"}</span>
            <span className="muted small gst-cell-line">{fullDate(row.noteDate)}</span>
            {row.estimated && <span className="badge badge-warning">Old refund · GST worked out</span>}
          </span>
        ),
      },
      {
        key: "invoice",
        header: "Against invoice",
        mobile: "subtitle",
        value: (row) => `${row.invoiceNumber} ${row.recipientGstin || ""}`.trim(),
        render: (row) => (
          <span className="nowrap">
            <span className="mono">{row.invoiceNumber}</span>
            <span className="muted small gst-cell-line">{fullDate(row.invoiceDate)}</span>
            {row.recipientGstin && <span className="small mono gst-cell-line">{row.recipientGstin}</span>}
          </span>
        ),
      },
      {
        key: "reason",
        header: "Reason",
        value: (row) => row.reason || "",
        render: (row) => (
          <>
            {row.reason || "—"}
            <span className="muted small gst-cell-line">
              {row.refundMethod}
              {row.refundedBy ? ` · ${row.refundedBy}` : ""}
            </span>
          </>
        ),
      },
      ...taxColumns(split, currency, cess, true),
      {
        key: "noteValue",
        header: "Note value",
        label: "Credit note value",
        type: "money",
        exact: true,
        mobile: "show",
        total: "sum",
        render: (row) => moneyExact(row.noteValue, currency),
      },
    ],
    [split, cess, currency]
  );

  return (
    <SectionCard
      icon="undo"
      tone="warning"
      title="Credit notes"
      description="Money given back against a sale, with exactly the GST each credit note took off. Each is set against its own invoice and reduces the period it was issued in. A part payment handed back on a bill not yet settled is not a credit note."
      actions={<DownloadButton data={data} section="credit" label="Download credit notes (CSV)" />}
      flush
    >
      <DataGrid
        id="gst-credit-notes"
        caption="Credit notes"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.refundId}
        search="Credit note, invoice or reason"
        empty="No credit notes were issued in this period."
        emptyHint="Nothing to set against the invoices."
        emptyIcon="undo"
        currency={currency}
        rowNoun={["credit note", "credit notes"]}
      />
    </SectionCard>
  );
}

function Documents({ data }) {
  const columns = [
    {
      key: "kind",
      header: "Document",
      mobile: "title",
      value: (row) => (row.kind === "credit_note" ? "Credit notes" : "Invoices"),
    },
    { key: "series", header: "Series", mobile: "subtitle", render: (row) => <span className="mono">{row.series}</span> },
    { key: "fromNumber", header: "From", render: (row) => <span className="mono nowrap">{row.fromNumber || "—"}</span> },
    { key: "toNumber", header: "To", render: (row) => <span className="mono nowrap">{row.toNumber || "—"}</span> },
    { key: "totalIssued", header: "Total issued", type: "number", mobile: "show" },
    { key: "cancelled", header: "Cancelled", type: "number", mobile: "show" },
    { key: "netIssued", header: "Net issued", type: "number", mobile: "show" },
    {
      key: "missingNumbers",
      header: "Not in this pack",
      label: "Numbers not in this pack",
      type: "number",
      mobile: "show",
      render: (row) =>
        row.missingNumbers > 0 ? (
          <span className="badge badge-warning" title="Numbers inside the range that belong to another period or outlet">
            {count(row.missingNumbers)}
          </span>
        ) : (
          "0"
        ),
    },
  ];

  return (
    <SectionCard
      icon="copy"
      tone="neutral"
      title="Documents issued"
      description="Each invoice series and each credit-note series of the period (a branch numbers its own of both), with voided invoices counted as cancelled."
      actions={<DownloadButton data={data} section="documents" label="Download (CSV)" />}
      flush
    >
      <DataGrid
        id="gst-documents"
        caption="Documents issued"
        columns={columns}
        rows={data.documents}
        rowKey={(row) => `${row.kind || "invoice"}-${row.series}`}
        variant="compact"
        pageSize={false}
        empty="No invoices in this period."
        emptyIcon="copy"
      />

      {data.documents.some((row) => row.missingNumbers > 0) && (
        <p className="muted small report-card-foot">
          Some numbers inside a range are not in this pack: documents of a neighbouring business day (a night that ran
          past midnight), of another outlet sharing the series, or numbers skipped. Worth a look before filing.
        </p>
      )}
    </SectionCard>
  );
}
