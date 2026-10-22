import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { today } from "@bmp/shared/dates";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import { ErrorMessage } from "../../../../components/Feedback";
import { getBill, getDaySummary, listBills, listCorrections, listCreditNotes } from "../../billing/services/bill.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money, moneyExact } from "@bmp/shared/format";
import { printCreditNote } from "../services/receipt";
import { orderTypeLabel, paymentMethodLabel } from "../../../../services/labels";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import BillModal from "./BillModal";
import { MoneyTabs } from "../../business-day/pages/moneyUi";
import "../../../../styles/billing.css";

const STATUS = {
  unpaid: { label: "Unpaid", tone: "warning" },
  partial: { label: "Part paid", tone: "info" },
  paid: { label: "Paid", tone: "active" },
  void: { label: "Void", tone: "inactive" },
};


const timeOf = (value) =>
  value ? new Date(value).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A business date as the bill shows it: 23 Sep 2026.
const dateText = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));

  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}` : "";
};

export default function BillsPage() {
  const { hasPermission } = useAuth();
  const canSeeSales = hasPermission("sales.view");
  // Without takings or payments (a captain): today's bills only, and no
  // payment details (the server enforces both).
  const todayOnly = !canSeeSales && !hasPermission("payments.manage");

  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useQueryFilter("tab", "bills");
  const [statusFilter, setStatusFilter] = useQueryFilter("status");
  const [search, setSearch] = useQueryFilter("search");
  const [fromParam, setFrom] = useQueryFilter("from");
  const [toParam, setTo] = useQueryFilter("to");
  // ?order= from another screen (a delivery, an order): that order's bills.
  // A number is the order's id; anything else is searched for.
  const orderParam = params.get("order") || "";
  // The list opens on today's bills; older ones are a date pick away. A search,
  // a status or a link to one order looks across every day instead.
  const acrossDays = Boolean(search || statusFilter || orderParam);
  const from = fromParam || (acrossDays ? "" : today());
  const to = toParam || (acrossDays ? "" : today());
  const orderId = /^\d+$/.test(orderParam) ? orderParam : "";

  const [bills, setBills] = useState([]);
  const [total, setTotal] = useState(0);
  const [notes, setNotes] = useState([]);
  const [notesTotal, setNotesTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [settings, setSettings] = useState(null);
  const [currency, setCurrency] = useState("₹");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState(search);
  const [viewing, setViewing] = useState(null);
  // Real paging (the API pages): page and rows per page of each list.
  const [billPage, setBillPage] = useState(() => ({ page: 1, pageSize: rememberedPageSize("bills", 25) }));
  const [notePage, setNotePage] = useState(() => ({ page: 1, pageSize: rememberedPageSize("credit-notes", 25) }));
  const [fixPage, setFixPage] = useState(() => ({ page: 1, pageSize: rememberedPageSize("payment-corrections", 25) }));
  const [corrections, setCorrections] = useState(null);
  const canSeeCorrections = canSeeSales && hasPermission("audit.view");
  // A new search, status or dates starts every list at its first page.
  const firstPages = () => {
    setBillPage((current) => ({ ...current, page: 1 }));
    setNotePage((current) => ({ ...current, page: 1 }));
    setFixPage((current) => ({ ...current, page: 1 }));
  };

  const effectiveSearch = search || (orderParam && !orderId ? orderParam : "");

  const load = useCallback(
    () =>
      listBills({
        status: statusFilter || undefined,
        search: effectiveSearch || undefined,
        from: from || undefined,
        to: to || undefined,
        orderId: orderId || undefined,
        page: billPage.page,
        pageSize: billPage.pageSize,
      })
        .then((page) => {
          setBills(page.items);
          setTotal(page.total);
          setError("");
          return page;
        })
        .catch((err) => {
          setError(getErrorMessage(err));
          return null;
        })
        .finally(() => setLoading(false)),
    [statusFilter, effectiveSearch, from, to, orderId, billPage]
  );

  const loadNotes = useCallback(
    () =>
      listCreditNotes({ from: from || undefined, to: to || undefined, page: notePage.page, pageSize: notePage.pageSize })
        .then((page) => {
          setNotes(page.items);
          setNotesTotal(page.total);
        })
        .catch((err) => setError(getErrorMessage(err))),
    [from, to, notePage]
  );

  const loadCorrections = useCallback(
    () =>
      listCorrections({ from: from || undefined, to: to || undefined, page: fixPage.page, pageSize: fixPage.pageSize })
        .then(setCorrections)
        .catch((err) => {
          setCorrections({ items: [], total: 0, totalAmount: 0 });
          setError(getErrorMessage(err));
        }),
    [from, to, fixPage]
  );

  const loadSummary = useCallback(
    () =>
      // The outlet in the top bar's own business day; with All outlets, every
      // day open in the restaurant (each outlet trades its own), added up.
      canSeeSales
        ? getDaySummary({ scope: "restaurant" })
            .then(setSummary)
            .catch(() => setSummary(null))
        : Promise.resolve(),
    [canSeeSales]
  );

  useEffect(() => {
    if (tab === "credit-notes") {
      loadNotes();
      return;
    }

    if (tab === "corrections") {
      loadCorrections();
      return;
    }

    load().then((page) => {
      // Arriving for one order with one bill: open it straight away.
      if (page && orderId && page.items.length === 1) {
        getBill(page.items[0].id)
          .then(setViewing)
          .catch((err) => setError(getErrorMessage(err)));
      }
    });
  }, [tab, load, loadNotes, loadCorrections, orderId]);

  useEffect(() => {
    loadSummary();

    getSettings()
      .then((loaded) => {
        setSettings(loaded);
        setCurrency(loaded.currencySymbol);
      })
      .catch(() => undefined);
  }, [loadSummary]);

  // ?bill=<id> opens that bill.
  const billParam = params.get("bill");

  useEffect(() => {
    if (billParam && /^\d+$/.test(billParam)) {
      getBill(billParam)
        .then(setViewing)
        .catch((err) => setError(getErrorMessage(err)));
    }
  }, [billParam]);

  const open = (id) => {
    setError("");
    getBill(id)
      .then(setViewing)
      .catch((err) => setError(getErrorMessage(err)));
  };

  const close = () => {
    setViewing(null);

    if (billParam) {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("bill");
          return next;
        },
        { replace: true }
      );
    }
  };

  const changed = (updated) => {
    setViewing(updated);
    load();
    loadSummary();
  };

  const clearOrder = () =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("order");
        return next;
      },
      { replace: true }
    );

  const submitSearch = (event) => {
    event.preventDefault();
    firstPages();
    setSearch(typed.trim());
  };

  const printNote = (row) =>
    getBill(row.billId)
      .then((bill) => {
        const note = bill.creditNotes.find((one) => one.id === row.id);
        printCreditNote(bill, note, { settings, currency });
      })
      .catch((err) => setError(getErrorMessage(err)));

  const m = (value) => moneyExact(value, currency);

  // Which days the figures are: one outlet's own day, or (All outlets) every
  // day open, each counter trading its own.
  const days = (summary && summary.days) || [];
  const dayNames = days.map((day) => day.outletName || "Main counter");
  const dayDates = [...new Set(days.map((day) => day.businessDate))];
  const scopeText =
    days.length === 0
      ? ""
      : days.length === 1
        ? `${dayNames[0]}'s business day · ${dateText(days[0].businessDate)}`
        : `${days.length} business days open · ${dayNames.join(", ")}${
            dayDates.length === 1 ? ` · ${dateText(dayDates[0])}` : ""
          }`;

  const tiles = summary && (
    <>
      {!summary.dayOpen && (
        <div className="alert alert-notice bills-day-alert">
          No business day is open, so there are no takings to show. Open the day under Business day; bills from earlier
          days are still listed below.
        </div>
      )}
      {summary.dayOpen && scopeText && days.length <= 2 && (
        <p className="small muted" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <Icon name="calendar" size={14} /> {scopeText}
          {days.length > 1 ? " — added up. Pick an outlet at the top for its own day." : ""}
        </p>
      )}
      {/* Many counters open: one line, the names on request. */}
      {summary.dayOpen && days.length > 2 && (
        <details className="bills-days small muted">
          <summary>
            <Icon name="calendar" size={14} /> {days.length} counters' business days, added up — which?
          </summary>
          <p>
            {days.map((day) => `${day.outletName || "Main counter"} (${dateText(day.businessDate)})`).join(", ")}. Pick
            an outlet at the top for its own day.
          </p>
        </details>
      )}
      {summary.dayOpen && (
        <div className="stat-grid">
          <StatTile
            icon="receipt"
            tone="primary"
            label="Sales · business day"
            value={money(summary.salesTotal, currency)}
            note={`${summary.billCount} bill${summary.billCount === 1 ? "" : "s"}${summary.complimentaryCount ? ` · ${summary.complimentaryCount} no-charge` : ""}`}
          />
          <StatTile
            icon="wallet"
            tone="success"
            label="Collected · business day"
            value={money(summary.collected, currency)}
            note={
              summary.duesCollected > 0
                ? `${money(summary.duesCollected, currency)} of it from earlier days' dues`
                : "Money taken in this business day"
            }
          />
          <StatTile
            icon="clock"
            tone="warning"
            label="Still to collect"
            value={money(summary.dueNow, currency)}
            note={
              summary.onAccount > 0
                ? `Plus ${money(summary.onAccount, currency)} put on accounts (Dues & accounts)`
                : "On today's bills not yet paid"
            }
            onClick={() => {
              firstPages();
              setStatusFilter("unpaid,partial");
            }}
          />
          <StatTile
            icon="percent"
            tone="info"
            label="Discounts given"
            value={money(summary.discounts, currency)}
            note="Coupons, till discounts and points"
          />
          <StatTile
            icon="undo"
            tone="danger"
            label="Refunded · business day"
            value={money(summary.refunded, currency)}
            note={
              summary.cashRefunded > 0
                ? `${money(summary.cashRefunded, currency)} of it in cash`
                : "Cash, card and UPI together"
            }
            onClick={() => setTab("credit-notes")}
          />
        </div>
      )}
      {summary.dayOpen && summary.byMethod.length > 0 && (
        <div className="bills-methods" aria-label="Collected today by method">
          <span className="bills-methods-label">Collected by</span>
          {summary.byMethod.map((row) => (
            <span key={row.paymentMethod} className="bills-method">
              <Icon
                name={row.paymentMethod === "cash" ? "cash" : row.paymentMethod === "card" ? "card" : "wallet"}
                size={14}
              />
              {paymentMethodLabel(row.paymentMethod)} <strong>{money(row.amount, currency)}</strong>
              {row.tips > 0 ? <span className="bill-tip">+ {money(row.tips, currency)} tips</span> : null}
            </span>
          ))}
          {/* Named tenders (Pluxee, Sodexo…): the first three, the rest folded. */}
          {(summary.byType || []).slice(0, 3).map((row) => (
            <span key={`t${row.paymentTypeId}`} className="bills-method is-type">
              {row.paymentTypeName} <strong>{money(row.amount, currency)}</strong>
            </span>
          ))}
          {(summary.byType || []).length > 3 && (
            <details className="bills-more-tenders">
              <summary>{summary.byType.length - 3} more tenders</summary>
              <span className="bills-more-list">
                {summary.byType.slice(3).map((row) => (
                  <span key={`t${row.paymentTypeId}`} className="bills-method is-type">
                    {row.paymentTypeName} <strong>{money(row.amount, currency)}</strong>
                  </span>
                ))}
              </span>
            </details>
          )}
          {summary.advancesTaken > 0 && (
            <span className="bills-method is-type" title="Paid ahead and held for guests: not sales until used on a bill">
              Advances taken <strong>{money(summary.advancesTaken, currency)}</strong>
            </span>
          )}
        </div>
      )}
    </>
  );

  // Bills list: the API pages (page / pageSize), so the grid does too.
  const billColumns = [
      {
        key: "bill",
        header: "Bill",
        value: (bill) => bill.billNumber,
        mobile: "title",
        pin: true,
        render: (bill) => (
          <span className="nowrap">
            <span className="mono bills-number">{bill.billNumber}</span>
            <span className="bills-flags">
              {bill.isComplimentary && <span className="badge badge-primary">No charge</span>}
              {bill.buyer && <span className="badge badge-info">B2B</span>}
              {bill.creditedAmount > 0 && <span className="badge badge-danger">Credit note</span>}
              {bill.accountCustomerId && bill.billStatus !== "paid" && <span className="badge badge-warning">On account</span>}
            </span>
          </span>
        ),
      },
      {
        key: "date",
        header: "Date",
        type: "date",
        value: (bill) => bill.businessDate,
        mobile: "show",
        render: (bill) => (
          <span className="bills-when">
            <span>{dateText(bill.businessDate)}</span>
            <span className="small">{timeOf(bill.billedAt)}</span>
          </span>
        ),
      },
      {
        key: "order",
        header: "Order",
        value: (bill) => bill.orderNumber,
        mobile: "show",
        render: (bill) => (
          <span className="bills-who">
            <span className="mono small">{bill.orderNumber}</span>
            <span className="small muted">
              {orderTypeLabel(bill.orderType)}
              {bill.tableNo ? ` · ${bill.tableNo}` : ""}
            </span>
          </span>
        ),
      },
      {
        key: "guest",
        header: "Guest",
        value: (bill) => bill.customerName || bill.accountName || "",
        render: (bill) => (
          <span className="bills-who">
            <span>{bill.customerName || bill.accountName || "—"}</span>
            {bill.accountCustomerId && bill.accountName && bill.accountName !== bill.customerName ? (
              <span className="small muted">Account: {bill.accountName}</span>
            ) : (
              bill.customerMobile && <span className="small muted">{bill.customerMobile}</span>
            )}
          </span>
        ),
      },
      {
        key: "total",
        header: "Total",
        type: "money",
        exact: true,
        value: (bill) => bill.totalAmount,
        mobile: "show",
        render: (bill) => <strong>{m(bill.totalAmount)}</strong>,
      },
      { key: "paid", header: "Paid", type: "money", exact: true, value: (bill) => bill.paidAmount - bill.refundedAmount },
      {
        key: "due",
        header: "Due",
        type: "money",
        exact: true,
        value: (bill) => (bill.billStatus === "void" ? null : bill.dueAmount),
        mobile: "show",
        render: (bill) =>
          bill.billStatus === "void" ? (
            <span className="muted">—</span>
          ) : (
            <span className={bill.dueAmount > 0 ? "bills-due" : ""}>{m(bill.dueAmount)}</span>
          ),
      },
      {
        key: "status",
        header: "Status",
        type: "status",
        value: (bill) => bill.billStatus,
        mobile: "subtitle",
        render: (bill) => {
          const status = STATUS[bill.billStatus] || STATUS.unpaid;
          return (
            <span className={`badge badge-${status.tone} status-badge`}>
              <span className="badge-dot" />
              {status.label}
            </span>
          );
        },
      },
      {
        key: "printed",
        header: "Printed",
        type: "number",
        value: (bill) => bill.printCount,
        render: (bill) => (
          <span className={`bills-print ${bill.printCount > 1 ? "is-reprinted" : ""}`}>
            {bill.printCount > 0 ? `${bill.printCount}×` : "—"}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        label: "Actions",
        type: "actions",
        render: (bill) => (
          <button type="button" className="link-button" onClick={() => open(bill.id)}>
            Open
          </button>
        ),
      },
  ];

  const billsList = (
    <SectionCard
      icon="list"
      title="Bills"
      description="Newest first. Search by bill or order number, the guest's name or their mobile."
      flush
    >
      <div className="bills-toolbar money-filterbar">
        <form className="filters" onSubmit={submitSearch}>
          <label className="field bills-search">
            <span>Search</span>
            <span className="bills-search-row">
              <span className="input-with-icon">
                <Icon name="search" size={17} className="input-icon" />
                <input
                  type="search"
                  value={typed}
                  placeholder="Bill no, order no, guest, mobile"
                  onChange={(event) => {
                    setTyped(event.target.value);

                    if (!event.target.value) {
                      setSearch("");
                    }
                  }}
                />
              </span>
              <button type="submit" className="button button-secondary">
                Search
              </button>
            </span>
          </label>
          <label className="field">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) => {
                firstPages();
                setStatusFilter(event.target.value);
              }}
            >
              <option value="">All</option>
              <option value="unpaid,partial">Still to collect</option>
              {Object.entries(STATUS).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {!todayOnly && (
            <DateRangeFilter
              from={from}
              to={to}
              label="bill dates"
              anchor={summary && summary.businessDate ? summary.businessDate : undefined}
              onChange={(range) => {
                firstPages();
                setFrom(range.from);
                setTo(range.to);
              }}
            />
          )}
        </form>

        {todayOnly && (
          <div className="alert alert-info">
            Today&apos;s bills only. How each bill was paid is for the cashier and the manager.
          </div>
        )}

        {orderParam && (
          <div className="alert alert-info">
            Showing the bills of order {orderId ? `#${orderId}` : orderParam}.{" "}
            <button type="button" className="link-button" onClick={clearOrder}>
              Show all bills
            </button>
          </div>
        )}
      </div>

      <DataGrid
        id="bills"
        caption="Bills"
        columns={billColumns}
        rows={bills}
        rowKey={(bill) => bill.id}
        loading={loading}
        error={bills.length === 0 ? error : ""}
        onRetry={() => load()}
        currency={currency}
        rowNoun={["bill", "bills"]}
        search={false}
        server={{
          total,
          page: billPage.page,
          pageSize: billPage.pageSize,
          onChange: ({ page, pageSize }) =>
            setBillPage((current) => ({ page: pageSize !== current.pageSize ? 1 : page, pageSize })),
        }}
        empty={search || from || to || statusFilter || orderParam ? "No bill matches." : "No bills yet."}
        emptyHint={
          search || from || to || statusFilter || orderParam
            ? "Try another search or wider dates."
            : "Bills appear here as the POS raises them."
        }
        emptyIcon="receipt"
        rowClassName={(bill) => (bill.billStatus === "void" ? "dg-tone-muted" : "")}
        exportName="bills"
      />
    </SectionCard>
  );

  const noteColumns = [
    { key: "number", header: "Credit note", value: (row) => row.number, mobile: "title", pin: true, render: (row) => <span className="mono nowrap">{row.number}</span> },
    {
      key: "date",
      header: "Date",
      type: "date",
      value: (row) => row.businessDate,
      mobile: "show",
      render: (row) => (
        <span className="bills-when">
          <span>{dateText(row.businessDate)}</span>
          <span className="small">{timeOf(row.issuedAt)}</span>
        </span>
      ),
    },
    {
      key: "bill",
      header: "Bill",
      value: (row) => row.billNumber,
      mobile: "show",
      render: (row) => (
        <button type="button" className="link-button mono" onClick={() => open(row.billId)}>
          {row.billNumber}
        </button>
      ),
    },
    {
      key: "kind",
      header: "What",
      type: "status",
      value: (row) => row.kind,
      mobile: "subtitle",
      render: (row) => (
        <span className={`badge ${row.kind === "return" ? "badge-warning" : "badge-danger"}`}>
          {row.kind === "return" ? "Dishes returned" : "Refund"}
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      value: (row) => row.reason,
      render: (row) => (
        <span className="bills-who">
          <span>{row.reason}</span>
          {row.createdByName && <span className="small muted">by {row.createdByName}</span>}
        </span>
      ),
    },
    { key: "method", header: "Paid back", value: (row) => paymentMethodLabel(row.refundMethod) },
    { key: "value", header: "Value", type: "money", exact: true, value: (row) => row.taxableValue },
    { key: "gst", header: "GST", type: "money", exact: true, value: (row) => row.taxAmount },
    {
      key: "total",
      header: "Total",
      type: "money",
      exact: true,
      value: (row) => row.totalAmount,
      mobile: "show",
      render: (row) => <strong>{m(row.totalAmount)}</strong>,
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) => (
        <button type="button" className="button button-ghost button-sm" onClick={() => printNote(row)}>
          <Icon name="print" size={14} /> Print
        </button>
      ),
    },
  ];

  const notesList = (
    <SectionCard
      icon="undo"
      tone="danger"
      title="Credit notes"
      description="Money given back against a sale. Each one takes its value and GST off the period it was issued in."
      flush
    >
      <DataGrid
        id="credit-notes"
        caption="Credit notes"
        columns={noteColumns}
        rows={notes}
        rowKey={(row) => row.id}
        currency={currency}
        rowNoun={["credit note", "credit notes"]}
        search={false}
        toolbar={
          <DateRangeFilter
            from={from}
            to={to}
            label="credit note dates"
            anchor={summary && summary.businessDate ? summary.businessDate : undefined}
            onChange={(range) => {
              firstPages();
              setFrom(range.from);
              setTo(range.to);
            }}
          />
        }
        server={{
          total: notesTotal,
          page: notePage.page,
          pageSize: notePage.pageSize,
          onChange: ({ page, pageSize }) =>
            setNotePage((current) => ({ page: pageSize !== current.pageSize ? 1 : page, pageSize })),
        }}
        empty="No credit notes in this period."
        emptyHint="A refund on a settled bill issues one: open the bill and choose Refund."
        emptyIcon="undo"
        exportName="credit-notes"
      />
    </SectionCard>
  );

  // Payments whose method was corrected (SW-B-02), for the owner's checks.
  const correctionColumns = [
    { key: "bill", header: "Bill", value: (row) => row.billNumber, mobile: "title", pin: true, render: (row) => (
      <button type="button" className="link-button mono" onClick={() => open(row.billId)}>
        {row.billNumber}
      </button>
    ) },
    { key: "when", header: "When", type: "datetime", value: (row) => row.correctedAt, mobile: "show" },
    { key: "amount", header: "Amount", type: "money", exact: true, total: "sum", value: (row) => row.amount, mobile: "show" },
    {
      key: "change",
      header: "Changed",
      value: (row) => `${paymentMethodLabel(row.oldMethod)} → ${paymentMethodLabel(row.newMethod)}`,
      mobile: "subtitle",
      render: (row) => (
        <span className="nowrap">
          {paymentMethodLabel(row.oldMethod)}
          {row.oldTypeName ? ` (${row.oldTypeName})` : ""} → <strong>{paymentMethodLabel(row.newMethod)}</strong>
          {row.newTypeName ? ` (${row.newTypeName})` : ""}
        </span>
      ),
    },
    { key: "reference", header: "Reference", value: (row) => row.newReference || "", defaultHidden: true },
    { key: "reason", header: "Reason", value: (row) => row.reason },
    {
      key: "who",
      header: "By",
      value: (row) => row.correctedBy,
      mobile: "show",
      render: (row) => (
        <span className="bills-who">
          <span>{row.correctedBy}</span>
          {row.approvedBy && <span className="small muted">approved by {row.approvedBy}</span>}
        </span>
      ),
    },
  ];

  const correctionsList = (
    <SectionCard
      icon="edit"
      tone="warning"
      title="Payment corrections"
      description="Payments whose method was changed after they were taken (keyed as cash, paid by UPI), with who did it and who approved it. Only the method changes; the bill and its GST stay as they were."
      flush
    >
      <DataGrid
        id="payment-corrections"
        caption="Payment corrections"
        columns={correctionColumns}
        rows={corrections ? corrections.items : []}
        rowKey={(row) => row.id}
        loading={corrections === null}
        currency={currency}
        rowNoun={["correction", "corrections"]}
        search={false}
        toolbar={
          <DateRangeFilter
            from={from}
            to={to}
            label="correction dates"
            anchor={summary && summary.businessDate ? summary.businessDate : undefined}
            onChange={(range) => {
              firstPages();
              setFrom(range.from);
              setTo(range.to);
            }}
          />
        }
        server={{
          total: corrections ? corrections.total : 0,
          page: fixPage.page,
          pageSize: fixPage.pageSize,
          totals: corrections ? { amount: corrections.totalAmount } : undefined,
          onChange: ({ page, pageSize }) =>
            setFixPage((current) => ({ page: pageSize !== current.pageSize ? 1 : page, pageSize })),
        }}
        empty="No payment was corrected in these dates."
        emptyHint="Open a bill and press Correct beside a payment taken the wrong way."
        emptyIcon="check"
        exportName="payment-corrections"
      />
    </SectionCard>
  );

  return (
    <div className="stack">
      <PageHeader
        icon="receipt"
        title="Bills & payments"
        description="Every bill, what is still to collect, refunds and credit notes. Open a bill to take payment, reprint it or give money back."
      />

      {canSeeSales && (
        <MoneyTabs
          label="Show"
          active={["credit-notes", "corrections"].includes(tab) ? tab : "bills"}
          onChange={setTab}
          tabs={[
            { key: "bills", label: "Bills", icon: "receipt", count: tab === "bills" && !loading && total > 0 ? count(total) : undefined },
            { key: "credit-notes", label: "Credit notes", icon: "undo", count: tab === "credit-notes" ? count(notesTotal) : undefined },
            ...(canSeeCorrections
              ? [{ key: "corrections", label: "Payment corrections", icon: "edit", count: tab === "corrections" && corrections ? count(corrections.total) : undefined }]
              : []),
          ]}
        />
      )}

      <ErrorMessage message={error} />

      {tiles}

      {tab === "credit-notes" && canSeeSales ? notesList : tab === "corrections" && canSeeCorrections ? correctionsList : billsList}

      {viewing && (
        <BillModal
          key={viewing.id}
          bill={viewing}
          onBill={changed}
          onClose={close}
          settings={settings}
          currency={currency}
          mode="bills"
        />
      )}
    </div>
  );
}
