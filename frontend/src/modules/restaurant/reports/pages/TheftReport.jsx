import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { count, money } from "../../../../services/format";
import { paymentMethodLabel } from "../../../../services/labels";
import { clockTime, dayAndDate, plural } from "./reportFormat";

// Theft control: everything that takes money or food out of the system after
// it went in, by the person who did it and the manager who allowed it. The
// classic fiddles — serve, take cash, delete the dish; void a paid bill;
// reprint a bill to reuse it; a big discount to a friend — each have a list.
// Stock written off is the same question asked of the store: who wrote off
// what, and who approved it (REQ-THEFT-WRITEOFFS).
const DISCOUNT_LINES = [10, 15, 20, 25, 30, 50];

const LISTS = [
  { key: "voids", label: "Voids", icon: "x-circle", tone: "danger", about: "Bills cancelled after they were raised, with the reason given." },
  { key: "removed", label: "Dishes off after KOT", icon: "utensils", tone: "warning", about: "Dishes taken off an order after the kitchen had the ticket." },
  { key: "refunds", label: "Refunds", icon: "undo", tone: "info", about: "Money handed back on a bill, and how." },
  { key: "discounts", label: "Large discounts", icon: "percent", tone: "warning", about: "Bills with a discount at or above the line chosen in By staff member." },
  { key: "reprints", label: "Reprints", icon: "print", tone: "neutral", about: "Bills printed more than once. Three prints or more is marked." },
  { key: "cashShort", label: "Cash short", icon: "cash", tone: "danger", about: "Business days whose drawer count came up short at close." },
  { key: "corrections", label: "Payment corrections", icon: "refresh", tone: "warning", about: "Payments whose method was changed after they were taken (cash written up as UPI or card is how cash leaves a drawer), with who changed it and who approved it." },
  { key: "writeoffs", label: "Write-offs & approvals", icon: "trash", tone: "warning", about: "Stock and dishes written off, by the person who logged them, and every write-off or order over the approval limit with who approved it." },
];

const STAGES = { new: "not started", cooking: "cooking", ready: "ready", served: "served" };

const REASONS = {
  guest_changed_mind: "Guest changed their mind",
  wrong_order: "Wrong order",
  delay: "Took too long",
  quality: "Quality complaint",
  other: "Other",
};

const OUTCOME = {
  asked: { label: "Asked for approval", badge: "badge-warning" },
  approved: { label: "Approved", badge: "badge-success" },
  sent_back: { label: "Sent back", badge: "badge-danger" },
};

// "UPI · Paytm": the method, and the owner-named payment type when there is one.
const methodText = (method, typeName) => `${paymentMethodLabel(method)}${typeName ? ` · ${typeName}` : ""}`;

function Who({ name, approvedBy }) {
  return (
    <>
      {name || "—"}
      {approvedBy && <div className="muted small">approved by {approvedBy}</div>}
    </>
  );
}

// A count with the money behind it, or a dash when there is none.
function CountMoney({ number, value, currency, note, unit }) {
  if (!number) {
    return <span className="muted">—</span>;
  }

  return (
    <span className="nowrap">
      {unit ? plural(number, unit[0], unit[1]) : count(number)}
      <div className="muted small">{money(value, currency)}</div>
      {note && <div className="small text-danger">{note}</div>}
    </span>
  );
}

const Dot = ({ tone, children }) => (
  <span className={`badge ${tone} status-badge`}>
    <span className="badge-dot" aria-hidden="true" />
    {children}
  </span>
);

// The server lists the latest few hundred of each; the counts above are of
// every one. Said under the list when it was cut.
const shownOf = (rows, total) =>
  rows.length < total ? (
    <p className="muted small report-card-foot">
      The latest {count(rows.length)} of {count(total)} are listed; the counts above include every one.
    </p>
  ) : null;

export default function TheftReport({ data, currency, discountPercent, onDiscountPercent, range }) {
  const [list, setList] = useState("voids");
  const s = data.summary;
  const tz = data.timezone;
  const shownList = LISTS.find((option) => option.key === list);
  const writeoffs = data.writeoffs || null;

  const staffColumns = useMemo(
    () => [
      { key: "name", header: "Staff member", value: (r) => r.userName, mobile: "title", pin: true, className: "report-strong" },
      {
        key: "exposure",
        header: "Money at stake",
        type: "money",
        value: (r) => r.exposure,
        render: (r) => <strong>{money(r.exposure, currency)}</strong>,
        total: "sum",
        mobile: "show",
      },
      {
        key: "voids",
        header: "Voids",
        type: "number",
        value: (r) => r.voids.count,
        render: (r) => <CountMoney number={r.voids.count} value={r.voids.value} currency={currency} />,
        total: "sum",
        mobile: "show",
      },
      {
        key: "removed",
        header: "Off after KOT",
        type: "number",
        value: (r) => r.removedAfterKot.count,
        render: (r) => (
          <CountMoney
            number={r.removedAfterKot.count}
            value={r.removedAfterKot.value}
            currency={currency}
            note={r.removedAfterKot.served ? `${r.removedAfterKot.served} served` : null}
          />
        ),
        total: "sum",
        mobile: "show",
      },
      {
        key: "refunds",
        header: "Refunds",
        type: "number",
        value: (r) => r.refunds.count,
        render: (r) => <CountMoney number={r.refunds.count} value={r.refunds.value} currency={currency} />,
        total: "sum",
      },
      {
        key: "discounts",
        header: "Large discounts",
        type: "number",
        value: (r) => r.discounts.count,
        render: (r) => <CountMoney number={r.discounts.count} value={r.discounts.value} currency={currency} />,
        total: "sum",
      },
      {
        key: "reprints",
        header: "Reprints",
        type: "number",
        value: (r) => r.reprints.bills,
        render: (r) => (r.reprints.bills ? plural(r.reprints.bills, "bill", "bills") : <span className="muted">—</span>),
        total: "sum",
      },
      {
        key: "cashShort",
        header: "Cash short",
        type: "money",
        value: (r) => r.cashShort.amount,
        render: (r) => (
          <CountMoney number={r.cashShort.days} value={r.cashShort.amount} currency={currency} unit={["day", "days"]} />
        ),
        total: "sum",
      },
    ],
    [currency]
  );

  const voidColumns = useMemo(
    () => [
      {
        key: "bill",
        header: "Bill",
        value: (r) => r.billNumber,
        mobile: "title",
        render: (r) => (
          <span className="nowrap">
            <span className="mono">{r.billNumber}</span>
            <div className="muted small">{dayAndDate(r.businessDate)}</div>
          </span>
        ),
      },
      { key: "amount", header: "Value", type: "money", value: (r) => r.amount, total: "sum", mobile: "show" },
      {
        key: "reason",
        header: "Reason",
        value: (r) => r.reason || "",
        render: (r) => (
          <>
            {r.reason || "—"}
            {r.afterClose && (
              <div>
                <Dot tone="badge-danger">after the day was closed</Dot>
              </div>
            )}
          </>
        ),
        mobile: "show",
      },
      { key: "by", header: "Voided by", value: (r) => r.byName || "", render: (r) => <Who name={r.byName} approvedBy={r.approvedBy} />, filter: "select", mobile: "show" },
      {
        key: "at",
        header: "When",
        type: "datetime",
        value: (row) => row.voidedAt,
        // On the restaurant's own clock, not the browser's.
        render: (row) => <span className="small nowrap">{clockTime(row.voidedAt, data.timezone)}</span>,
        mobile: "subtitle",
      },
    ],
    [data.timezone]
  );

  const removedColumns = useMemo(
    () => [
      {
        key: "dish",
        header: "Dish",
        value: (r) => r.itemName,
        mobile: "title",
        render: (r) => (
          <>
            {r.itemName} ×{r.quantity}
            <div className="muted small">
              <span className="mono">{r.orderNumber}</span>
              {/* The order was cancelled after its bill was voided: the money
                  is the void's, counted once there, so it is left out of the
                  totals here. */}
              {r.coveredByVoid && (
                <>
                  {" "}
                  · <span className="badge badge-inactive">part of void {r.voidedBill}</span>
                </>
              )}
            </div>
          </>
        ),
      },
      {
        key: "amount",
        header: "Value",
        type: "money",
        // Counted under voids when covered by one: out of the total here.
        value: (r) => (r.coveredByVoid ? 0 : r.amount),
        render: (r) =>
          r.coveredByVoid ? (
            <span className="muted" title="Counted under voids">
              ({money(r.amount, currency)})
            </span>
          ) : (
            money(r.amount, currency)
          ),
        total: "sum",
        mobile: "show",
      },
      {
        key: "stage",
        header: "Kitchen had it",
        type: "status",
        value: (r) => STAGES[r.kitchenStage] || "sent",
        render: (r) => (
          <Dot tone={r.kitchenStage === "served" ? "badge-danger" : r.kitchenStage === "ready" ? "badge-warning" : "badge-neutral"}>
            {STAGES[r.kitchenStage] || "sent"}
          </Dot>
        ),
        filter: "select",
        mobile: "show",
      },
      { key: "reason", header: "Reason", value: (r) => r.reasonNote || REASONS[r.reasonCode] || "" },
      { key: "by", header: "Taken off by", value: (r) => r.byName || "", render: (r) => <Who name={r.byName} approvedBy={r.approvedBy} />, filter: "select", mobile: "show" },
      { key: "at", header: "When", type: "datetime", value: (r) => r.removedAt, render: (r) => <span className="small nowrap">{clockTime(r.removedAt, tz)}</span>, mobile: "subtitle" },
    ],
    [currency, tz]
  );

  const refundColumns = useMemo(
    () => [
      { key: "bill", header: "Bill", value: (r) => r.billNumber, className: "mono", mobile: "title" },
      { key: "amount", header: "Refunded", type: "money", value: (r) => r.amount, total: "sum", mobile: "show" },
      { key: "method", header: "How", value: (r) => r.method, filter: "select", mobile: "show" },
      { key: "reason", header: "Reason", value: (r) => r.reason || "" },
      { key: "by", header: "By", value: (r) => r.byName || "", render: (r) => <Who name={r.byName} approvedBy={r.approvedBy} />, filter: "select", mobile: "show" },
      { key: "at", header: "When", type: "datetime", value: (r) => r.refundedAt, render: (r) => <span className="small nowrap">{clockTime(r.refundedAt, tz)}</span>, mobile: "subtitle" },
    ],
    [tz]
  );

  const discountColumns = useMemo(
    () => [
      {
        key: "bill",
        header: "Bill",
        value: (r) => r.billNumber,
        mobile: "title",
        render: (r) => (
          <span className="nowrap">
            <span className="mono">{r.billNumber}</span>
            <div className="muted small">{clockTime(r.billedAt, tz)}</div>
          </span>
        ),
      },
      { key: "subtotal", header: "Bill before discount", type: "money", value: (r) => r.subtotal, total: "sum", mobile: "show" },
      {
        key: "amount",
        header: "Discount",
        type: "money",
        value: (r) => r.amount,
        render: (r) => (
          <span className="nowrap">
            {money(r.amount, currency)}
            <div className="muted small">{r.percent}%</div>
          </span>
        ),
        total: "sum",
        mobile: "show",
      },
      { key: "code", header: "Coupon", value: (r) => r.code || "", render: (r) => (r.code ? <span className="mono">{r.code}</span> : <span className="muted">none (manual)</span>) },
      { key: "by", header: "Billed by", value: (r) => r.byName || "", filter: "select", mobile: "show" },
    ],
    [currency, tz]
  );

  const reprintColumns = useMemo(
    () => [
      {
        key: "bill",
        header: "Bill",
        value: (r) => r.billNumber,
        mobile: "title",
        render: (r) => (
          <span className="mono nowrap">
            {r.billNumber}
            {r.billStatus === "void" && (
              <>
                {" "}
                <Dot tone="badge-danger">void</Dot>
              </>
            )}
          </span>
        ),
      },
      { key: "amount", header: "Value", type: "money", value: (r) => r.amount, mobile: "show" },
      {
        key: "prints",
        header: "Printed",
        type: "number",
        value: (r) => r.printCount,
        render: (r) => <span className={r.printCount >= 3 ? "badge badge-warning" : ""}>{r.printCount} times</span>,
        mobile: "show",
      },
      { key: "by", header: "Last printed by", value: (r) => r.byName || "", render: (r) => <Who name={r.byName} approvedBy={r.approvedBy} />, filter: "select" },
      { key: "at", header: "Last printed", type: "datetime", value: (r) => r.lastPrintedAt, render: (r) => <span className="small nowrap">{clockTime(r.lastPrintedAt, tz)}</span>, mobile: "subtitle" },
    ],
    [tz]
  );

  const correctionColumns = useMemo(
    () => [
      {
        key: "bill",
        header: "Bill",
        value: (r) => r.billNumber,
        mobile: "title",
        render: (r) => (
          <span className="nowrap">
            <span className="mono">{r.billNumber}</span>
            <div className="muted small">{dayAndDate(r.businessDate)}</div>
          </span>
        ),
      },
      { key: "amount", header: "Amount", type: "money", value: (r) => r.amount, total: "sum", mobile: "show" },
      {
        key: "change",
        header: "Changed",
        value: (r) => `${methodText(r.oldMethod, r.oldTypeName)} → ${methodText(r.newMethod, r.newTypeName)}`,
        render: (r) => (
          <span className={r.oldMethod === "cash" && r.newMethod !== "cash" ? "text-danger" : ""}>
            {methodText(r.oldMethod, r.oldTypeName)} → {methodText(r.newMethod, r.newTypeName)}
          </span>
        ),
        filter: "text",
        mobile: "subtitle",
      },
      { key: "reason", header: "Reason", value: (r) => r.reason || "", mobile: "show" },
      { key: "by", header: "Changed by", value: (r) => r.byName || "", render: (r) => <Who name={r.byName} approvedBy={r.approvedBy} />, filter: "select", mobile: "show" },
      {
        key: "at",
        header: "When",
        type: "datetime",
        value: (r) => r.correctedAt,
        render: (r) => <span className="small nowrap">{clockTime(r.correctedAt, tz)}</span>,
      },
    ],
    [tz]
  );

  const shortColumns = useMemo(
    () => [
      { key: "day", header: "Business day", type: "date", value: (r) => r.businessDate, render: (r) => <span className="nowrap">{dayAndDate(r.businessDate)}</span>, mobile: "title" },
      { key: "drawer", header: "Drawer", value: (r) => r.outletName || "Main counter", filter: "select", mobile: "subtitle" },
      { key: "expected", header: "Expected", type: "money", value: (r) => r.expected, total: "sum" },
      { key: "counted", header: "Counted", type: "money", value: (r) => r.counted, total: "sum" },
      {
        key: "short",
        header: "Short",
        type: "money",
        value: (r) => -r.difference,
        render: (r) => <span className="text-danger nowrap">{money(-r.difference, currency)}</span>,
        total: "sum",
        mobile: "show",
      },
      {
        key: "by",
        header: "Closed by",
        value: (r) => r.byName || "",
        render: (r) => (
          <>
            {r.byName}
            <div className="muted small">{clockTime(r.closedAt, tz)}</div>
          </>
        ),
        mobile: "show",
      },
    ],
    [currency, tz]
  );

  const wastePeopleColumns = useMemo(
    () => [
      { key: "name", header: "Person", value: (r) => r.userName, mobile: "title", pin: true },
      { key: "itemValue", header: "Items at cost", type: "money", value: (r) => r.items.value, total: "sum", mobile: "show" },
      { key: "dishValue", header: "Dishes at cost", type: "money", value: (r) => r.dishes.value, total: "sum", mobile: "show" },
      {
        key: "total",
        header: "Total written off",
        type: "money",
        value: (r) => r.total,
        render: (r) => <strong>{money(r.total, currency)}</strong>,
        total: "sum",
        mobile: "show",
      },
      {
        key: "overLimit",
        header: "Over the limit",
        type: "number",
        value: (r) => r.overLimit,
        render: (r) => (r.overLimit > 0 ? <span className="badge badge-warning">{count(r.overLimit)}</span> : <span className="muted">0</span>),
        total: "sum",
        mobile: "show",
      },
    ],
    [currency]
  );

  const largeColumns = useMemo(
    () => [
      { key: "what", header: "What", value: (r) => r.what, mobile: "title", render: (r) => (<><strong>{r.what}</strong>{r.kind && <div className="muted small">{r.kind}{r.store ? ` · ${r.store}` : ""}</div>}</>) },
      { key: "value", header: "Value", type: "money", exact: true, value: (r) => r.value, total: "sum", mobile: "show" },
      { key: "loggedBy", header: "Logged by", value: (r) => r.loggedBy || "", filter: "select", mobile: "show" },
      {
        key: "approvedBy",
        header: "Approved by",
        value: (r) => r.approvedBy || "",
        render: (r) => (r.approvedBy ? <><strong>{r.approvedBy}</strong><div className="muted small">manager&apos;s PIN</div></> : <span className="muted">own right</span>),
        mobile: "show",
      },
      { key: "at", header: "When", type: "datetime", value: (r) => r.at, mobile: "subtitle" },
    ],
    []
  );

  const orderColumns = useMemo(
    () => [
      {
        key: "po",
        header: "Order",
        value: (r) => r.poNumber,
        mobile: "title",
        render: (r) =>
          r.orderId ? (
            <Link className="mono nowrap" to={`/purchasing/orders?open=${r.orderId}`}>
              {r.poNumber}
            </Link>
          ) : (
            <span className="mono">{r.poNumber}</span>
          ),
      },
      { key: "supplier", header: "Supplier", value: (r) => r.supplier || "", mobile: "show" },
      { key: "total", header: "Order total", type: "money", exact: true, value: (r) => r.total, mobile: "show" },
      {
        key: "outcome",
        header: "What happened",
        type: "status",
        value: (r) => (OUTCOME[r.outcome] || { label: r.outcome }).label,
        render: (r) => {
          const outcome = OUTCOME[r.outcome] || { label: r.outcome, badge: "badge-neutral" };
          return <Dot tone={outcome.badge}>{outcome.label}</Dot>;
        },
        filter: "select",
        mobile: "subtitle",
      },
      { key: "by", header: "By", value: (r) => (r.outcome === "approved" ? r.approvedBy || r.by : r.by) || "", mobile: "show" },
      { key: "at", header: "When", type: "datetime", value: (r) => r.at },
    ],
    []
  );

  const common = { currency, search: true };

  return (
    <div className="stack">
      {/* Each figure opens its own list below. */}
      <div className="stat-grid theft-tiles report-tiles-3">
        <StatTile icon="x-circle" tone="danger" label="Bills voided" value={count(s.voids.count)} note={money(s.voids.value, currency)} onClick={() => setList("voids")} className={list === "voids" ? "is-selected" : ""} />
        <StatTile
          icon="utensils"
          tone="warning"
          label="Dishes off after KOT"
          value={count(s.removedAfterKot.count)}
          note={`${money(s.removedAfterKot.value, currency)}${
            s.removedAfterKot.served > 0 ? ` · ${count(s.removedAfterKot.served)} already served` : ""
          }${s.removedAfterKot.coveredByVoid > 0 ? ` · ${count(s.removedAfterKot.coveredByVoid)} more on voided bills` : ""}`}
          onClick={() => setList("removed")}
          className={list === "removed" ? "is-selected" : ""}
        />
        <StatTile icon="undo" tone="info" label="Refunds" value={count(s.refunds.count)} note={money(s.refunds.value, currency)} onClick={() => setList("refunds")} className={list === "refunds" ? "is-selected" : ""} />
        <StatTile icon="percent" tone="warning" label="Large discounts" value={count(s.discounts.count)} note={`${money(s.discounts.value, currency)} given away`} onClick={() => setList("discounts")} className={list === "discounts" ? "is-selected" : ""} />
        <StatTile icon="print" label="Bills reprinted" value={count(s.reprints.bills)} note={`${count(s.reprints.prints)} extra prints`} onClick={() => setList("reprints")} className={list === "reprints" ? "is-selected" : ""} />
        <StatTile icon="cash" tone="danger" label="Days closed short" value={count(s.cashShort.days)} note={`${money(s.cashShort.amount, currency)} missing`} onClick={() => setList("cashShort")} className={list === "cashShort" ? "is-selected" : ""} />
        {s.corrections && (
          <StatTile
            icon="refresh"
            tone={s.corrections.fromCash ? "danger" : "warning"}
            label="Payments corrected"
            value={count(s.corrections.count)}
            note={
              s.corrections.fromCash
                ? `${plural(s.corrections.fromCash, "was cash", "were cash")} written up as something else`
                : money(s.corrections.value, currency)
            }
            onClick={() => setList("corrections")}
            className={list === "corrections" ? "is-selected" : ""}
          />
        )}
        {writeoffs && (
          <StatTile
            icon="trash"
            tone={writeoffs.summary.largeWriteoffs.count ? "danger" : "warning"}
            label="Stock written off"
            value={money(writeoffs.summary.wastage.value + writeoffs.summary.dishes.value, currency)}
            note={
              writeoffs.summary.largeWriteoffs.count
                ? `${plural(writeoffs.summary.largeWriteoffs.count, "write-off", "write-offs")} over the limit`
                : "nothing over the approval limit"
            }
            onClick={() => setList("writeoffs")}
            className={list === "writeoffs" ? "is-selected" : ""}
          />
        )}
      </div>

      <SectionCard
        icon="users"
        title="By staff member"
        description="Sorted by the money at stake. Voids and refunds are charged to the person who did them; discounts to the cashier who billed; dishes to whoever took them off."
        actions={
          <label className="field theft-threshold">
            <span>Large discount from</span>
            <select value={discountPercent} onChange={(event) => onDiscountPercent(Number(event.target.value))}>
              {DISCOUNT_LINES.map((value) => (
                <option key={value} value={value}>
                  {value}% of the bill
                </option>
              ))}
            </select>
            <small className="muted">or {money(data.thresholds.discountAmount, currency)} on any bill</small>
          </label>
        }
        flush
      >
        <DataGrid
          id="theft-staff"
          caption="Theft control by staff member"
          columns={staffColumns}
          rows={data.staff}
          rowKey={(r) => `${r.userId || "none"}-${r.userName}`}
          empty="Nothing to look at in this period — no voids, refunds, large discounts, reprints or dishes taken off."
          emptyHint="A clean period. Pick a longer range to look further back."
          emptyIcon="check-circle"
          defaultSort={{ key: "exposure", direction: "desc" }}
          exportName="theft-by-staff"
          rowNoun={["person", "people"]}
          {...common}
        />
      </SectionCard>

      <div className="segmented report-sections" role="tablist" aria-label="Details">
        {LISTS.filter((option) => option.key !== "writeoffs" || writeoffs || data.writeoffsNote).map((option) => (
          <button
            type="button"
            key={option.key}
            role="tab"
            aria-selected={list === option.key}
            className={`segment ${list === option.key ? "is-active" : ""}`}
            onClick={() => setList(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <SectionCard icon={shownList.icon} tone={shownList.tone} title={shownList.label} description={shownList.about} flush>
        {list === "voids" && (
          <>
            <DataGrid id="theft-voids" caption="Voided bills" columns={voidColumns} rows={data.voids} rowKey={(r) => r.billId} empty="No bills were voided." emptyIcon="check-circle" defaultSort={{ key: "at", direction: "desc" }} exportName="theft-voids" rowNoun={["bill", "bills"]} {...common} />
            {shownOf(data.voids, s.voids.count)}
          </>
        )}

        {list === "removed" && (
          <>
            <DataGrid
              id="theft-removed"
              caption="Dishes taken off after the kitchen had them"
              columns={removedColumns}
              rows={data.removed}
              rowKey={(r) => r.id}
              rowClassName={(r) => (r.coveredByVoid ? "dg-tone-muted" : "")}
              empty="No dish was taken off an order after the kitchen had it."
              emptyIcon="check-circle"
              defaultSort={{ key: "at", direction: "desc" }}
              exportName="theft-dishes-off-after-kot"
              rowNoun={["dish", "dishes"]}
              {...common}
            />
            {shownOf(data.removed, s.removedAfterKot.count + (s.removedAfterKot.coveredByVoid || 0))}
            {s.removedAfterKot.coveredByVoid > 0 && (
              <p className="muted small report-card-foot">
                Dishes marked <em>part of void</em> were taken off when an order was cancelled after its bill had been
                voided. That money is counted once, under Voids, and left out of the totals here.
              </p>
            )}
          </>
        )}

        {list === "refunds" && (
          <>
            <DataGrid id="theft-refunds" caption="Refunds" columns={refundColumns} rows={data.refunds} rowKey={(r) => r.refundId} empty="No refunds were given." emptyIcon="check-circle" defaultSort={{ key: "at", direction: "desc" }} exportName="theft-refunds" rowNoun={["refund", "refunds"]} {...common} />
            {shownOf(data.refunds, s.refunds.count)}
          </>
        )}

        {list === "discounts" && (
          <>
            <DataGrid
              id="theft-discounts"
              caption="Large discounts"
              columns={discountColumns}
              rows={data.discounts}
              rowKey={(r) => r.billId}
              empty={`No discount of ${discountPercent}% or more, or ${money(data.thresholds.discountAmount, currency)} or more, was given.`}
              emptyIcon="check-circle"
              defaultSort={{ key: "amount", direction: "desc" }}
              exportName="theft-large-discounts"
              rowNoun={["bill", "bills"]}
              {...common}
            />
            {shownOf(data.discounts, s.discounts.count)}
          </>
        )}

        {list === "reprints" && (
          <>
            <DataGrid id="theft-reprints" caption="Bills printed more than once" columns={reprintColumns} rows={data.reprints} rowKey={(r) => r.billId} empty="No bill was printed more than once." emptyIcon="check-circle" defaultSort={{ key: "prints", direction: "desc" }} exportName="theft-reprints" rowNoun={["bill", "bills"]} {...common} />
            {shownOf(data.reprints, s.reprints.bills)}
          </>
        )}

        {list === "cashShort" &&
          (data.cashShortNote ? (
            <p className="muted report-card-foot">{data.cashShortNote}</p>
          ) : (
            <DataGrid id="theft-cash-short" caption="Days closed short" columns={shortColumns} rows={data.cashShort} rowKey={(r) => r.businessDayId} empty="Every day closed in this period had the cash it should." emptyIcon="check-circle" defaultSort={{ key: "day", direction: "desc" }} exportName="theft-cash-short" rowNoun={["day", "days"]} {...common} />
          ))}

        {list === "corrections" && (
          <>
            <DataGrid
              id="theft-payment-corrections"
              caption="Payment corrections"
              columns={correctionColumns}
              rows={data.corrections || []}
              rowKey={(r) => r.id}
              rowClassName={(r) => (r.oldMethod === "cash" && r.newMethod !== "cash" ? "dg-tone-warning" : "")}
              empty="No payment's method was changed in this period."
              emptyIcon="check-circle"
              defaultSort={{ key: "at", direction: "desc" }}
              exportName="theft-payment-corrections"
              rowNoun={["correction", "corrections"]}
              {...common}
            />
            {shownOf(data.corrections || [], (s.corrections || { count: 0 }).count)}
          </>
        )}

        {list === "writeoffs" &&
          (!writeoffs ? (
            <p className="muted report-card-foot">{data.writeoffsNote || "Write-offs could not be read just now."}</p>
          ) : (
            <div className="stack theft-writeoffs">
              <p className="muted small report-card-foot">
                {writeoffs.store ? `${writeoffs.store.name} store only. ` : ""}
                Waste logged by each person at cost, items and whole dishes; entries someone reversed are left out.{" "}
                {writeoffs.summary.purchaseApprovals.asked + writeoffs.summary.purchaseApprovals.approved + writeoffs.summary.purchaseApprovals.sentBack > 0 &&
                  `Large purchase orders: ${count(writeoffs.summary.purchaseApprovals.approved)} approved, ${count(writeoffs.summary.purchaseApprovals.asked)} waiting, ${count(writeoffs.summary.purchaseApprovals.sentBack)} sent back. `}
                <Link to={`/inventory/insights?tab=control${range ? `&from=${range.from}&to=${range.to}` : ""}`}>
                  Open the full write-off control
                </Link>
              </p>
              <DataGrid
                id="theft-writeoff-people"
                caption="Stock written off by person"
                columns={wastePeopleColumns}
                rows={writeoffs.byPerson}
                rowKey={(r) => `${r.userId}`}
                empty="Nothing written off in these dates."
                emptyIcon="trash"
                defaultSort={{ key: "total", direction: "desc" }}
                exportName="theft-writeoffs-by-person"
                rowNoun={["person", "people"]}
                {...common}
              />
              <h3 className="theft-sub">Write-offs over the approval limit</h3>
              <DataGrid
                id="theft-writeoff-large"
                caption="Write-offs over the approval limit"
                columns={largeColumns}
                rows={writeoffs.largeWriteoffs}
                rowKey={(r) => r.id}
                empty="No write-off went over the limit in these dates."
                emptyIcon="shield"
                defaultSort={{ key: "at", direction: "desc" }}
                exportName="theft-writeoffs-over-limit"
                rowNoun={["write-off", "write-offs"]}
                {...common}
              />
              <h3 className="theft-sub">Large purchase orders</h3>
              <DataGrid
                id="theft-po-approvals"
                caption="Large purchase orders and their approvals"
                columns={orderColumns}
                rows={writeoffs.purchaseApprovals}
                rowKey={(r) => r.id}
                empty="No order went over the approval limit in these dates."
                emptyIcon="clipboard"
                defaultSort={{ key: "at", direction: "desc" }}
                exportName="theft-po-approvals"
                rowNoun={["order", "orders"]}
                {...common}
              />
            </div>
          ))}
      </SectionCard>
    </div>
  );
}
