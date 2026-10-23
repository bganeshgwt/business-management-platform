import { useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../../components/DataGrid/DataGrid";
import { getReorderPlan } from "../../../inventory/services/inventoryInsight.service";
import { listInventoryItems } from "../../../inventory/services/inventory.service";
import { listComplaints } from "../../../crm/services/crm.service";
import { listExpenses, setExpenseStatus } from "../../../expenses/services/expense.service";
import { listPurchaseOrders } from "../../../purchasing/services/purchase.service";
import { getErrorMessage } from "../../../../../services/api";
import { count, money } from "@bmp/shared/format";
import { PanelFacts, PanelMessage } from "./panelKit";
import { errorText, refreshDashboard, usePanelQuery } from "./panelData";

const badge = (label, tone) => (
  <span className={`badge badge-${tone} status-badge`}>
    <span className="badge-dot" aria-hidden="true" />
    {label}
  </span>
);

const qty = (value, unit) =>
  `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ""}`;

// ------------------------------------------------------------------ stock

const STOCK = {
  out: ["Out", "danger"],
  critical: ["Critical", "warning"],
  low: ["Low", "info"],
  ok: ["OK", "success"],
};

// The Stock card's figures, from the same reorder plan (7 days ahead): out at
// zero, critical under two days of cover, low at or under the reorder level
// or short of the week, to order where a quantity is suggested.
export function StockPanel({ ctx, view }) {
  const { currency } = ctx;
  const query = usePanelQuery("reorder", 7, () => getReorderPlan(7));
  const plan = query.data || null;
  const items = plan ? plan.items : [];
  const rows =
    view === "order"
      ? items.filter((item) => Number(item.suggestedQuantity) > 0)
      : items.filter((item) => item.status === (view || "out"));
  const summary = plan ? plan.summary : null;

  return (
    <>
      {summary && (
        <PanelFacts
          items={[
            { label: "Out", value: count(summary.out), tone: summary.out > 0 ? "danger" : null },
            { label: "Critical", value: count(summary.critical), tone: summary.critical > 0 ? "warning" : null },
            { label: "Low", value: count(summary.low) },
            { label: "To order", value: count(summary.toOrder) },
          ]}
        />
      )}
      <DataGrid
        id={`dash-panel-stock-${view || "out"}`}
        caption="Stock items"
        variant="compact"
        columns={[
          {
            key: "item",
            header: "Item",
            value: (item) => item.name,
            mobile: "title",
            render: (item) => (
              <span className="panel-cell-stack">
                <strong>{item.name}</strong>
                <span className="muted">{item.category || ""}</span>
              </span>
            ),
          },
          {
            key: "stock",
            header: "In stock",
            type: "number",
            value: (item) => item.currentStock,
            render: (item) => qty(item.currentStock, item.unit),
            mobile: "show",
          },
          {
            key: "reorder",
            header: "Reorder at",
            type: "number",
            value: (item) => item.reorderLevel,
            render: (item) => qty(item.reorderLevel, item.unit),
            mobile: "show",
          },
          {
            key: "cover",
            header: "Days left",
            type: "number",
            value: (item) =>
              item.daysOfCover === null || item.daysOfCover === undefined ? null : Number(item.daysOfCover),
          },
          {
            key: "status",
            header: "Status",
            value: (item) => item.status,
            render: (item) => badge(...(STOCK[item.status] || [item.status, "neutral"])),
            mobile: "subtitle",
          },
          {
            key: "suggest",
            header: "Suggested order",
            type: "number",
            defaultHidden: view !== "order",
            value: (item) => Number(item.suggestedQuantity) || null,
            render: (item) => (Number(item.suggestedQuantity) > 0 ? qty(item.suggestedQuantity, item.unit) : "—"),
          },
          {
            key: "supplier",
            header: "Supplier",
            value: (item) => (item.supplier ? item.supplier.name : ""),
            defaultHidden: true,
          },
        ]}
        rows={rows}
        rowKey={(item) => item.id}
        loading={!plan && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty="Nothing in this list"
        emptyIcon="box"
        currency={currency}
        rowNoun={["item", "items"]}
      />
    </>
  );
}

// Items running low: active, at or below their own reorder level (the whole
// restaurant's stock, as the dashboard counts it).
export function LowStockPanel() {
  const query = usePanelQuery("low-stock", null, () => listInventoryItems({ lowOnly: true }));
  const items = query.data || null;

  return (
    <DataGrid
      id="dash-panel-low-stock"
      caption="Items running low"
      variant="compact"
      columns={[
        { key: "item", header: "Item", value: (item) => item.name, mobile: "title" },
        { key: "category", header: "Category", value: (item) => item.category || "", mobile: "subtitle" },
        {
          key: "stock",
          header: "In stock",
          type: "number",
          value: (item) => item.currentStock,
          render: (item) => qty(item.currentStock, item.unitShortName || item.unitName),
          mobile: "show",
        },
        {
          key: "reorder",
          header: "Reorder level",
          type: "number",
          value: (item) => item.reorderLevel,
          render: (item) => qty(item.reorderLevel, item.unitShortName || item.unitName),
          mobile: "show",
        },
        {
          key: "short",
          header: "Short by",
          type: "number",
          value: (item) => Math.max(0, Number(item.reorderLevel || 0) - Number(item.currentStock || 0)),
          render: (item) =>
            qty(
              Math.max(0, Number(item.reorderLevel || 0) - Number(item.currentStock || 0)),
              item.unitShortName || item.unitName,
            ),
        },
        { key: "area", header: "Kept in", value: (item) => item.storageArea || "", defaultHidden: true },
      ]}
      rows={items || []}
      rowKey={(item) => item.id}
      rowClassName={(item) => (Number(item.currentStock) <= 0 ? "dg-tone-danger" : "")}
      loading={!items && query.isLoading}
      error={errorText(query)}
      onRetry={() => query.refetch()}
      empty="Nothing is at or below its reorder level"
      emptyIcon="box"
      rowNoun={["item", "items"]}
    />
  );
}

// ------------------------------------------------------------------ complaints

const PRIORITY = { high: ["High", "danger"], medium: ["Medium", "warning"], low: ["Low", "neutral"] };
const COMPLAINT = {
  open: ["Open", "warning"],
  in_progress: ["In progress", "info"],
  resolved: ["Resolved", "success"],
  closed: ["Closed", "neutral"],
};

// Complaints still open or being worked on. A row opens the complaint here.
export function ComplaintsPanel({ ctx }) {
  const params = {
    status: "open,in_progress",
    limit: 200,
    ...(ctx.data.outletId ? { outletId: ctx.data.outletId } : {}),
  };
  const query = usePanelQuery("complaints", params, () => listComplaints(params));
  const [openId, setOpenId] = useState(null);
  const page = query.data || null;
  const items = page ? page.items : [];
  const chosen = items.find((item) => item.id === openId) || null;

  return (
    <>
      {chosen && (
        <article
          className="card"
          style={{ padding: 16, display: "grid", gap: 8 }}
          aria-label={`Complaint: ${chosen.subject}`}
          ref={(node) => node && node.scrollIntoView({ block: "nearest" })}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "1.02rem" }}>{chosen.subject}</strong>
            {badge(...(COMPLAINT[chosen.complaintStatus] || [chosen.complaintStatus, "neutral"]))}
            {badge(
              `${(PRIORITY[chosen.priority] || [chosen.priority])[0]} priority`,
              (PRIORITY[chosen.priority] || [null, "neutral"])[1],
            )}
            <button
              type="button"
              className="link-button small"
              style={{ marginLeft: "auto" }}
              onClick={() => setOpenId(null)}
            >
              Back to the list
            </button>
          </div>
          {chosen.description && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{chosen.description}</p>}
          <PanelFacts
            items={[
              { label: "Guest", value: chosen.customerName || "—" },
              chosen.customerMobile && { label: "Mobile", value: chosen.customerMobile },
              {
                label: "Raised",
                value: new Date(chosen.createdAt).toLocaleString("en-IN", {
                  day: "numeric",
                  month: "short",
                  hour: "numeric",
                  minute: "2-digit",
                }),
              },
              { label: "With", value: chosen.assignedToName || "Nobody yet" },
              chosen.billNumber && { label: "Bill", value: chosen.billNumber },
              chosen.category && { label: "About", value: String(chosen.category).replace(/_/g, " ") },
            ]}
          />
          <div>
            <Link className="button button-secondary button-sm" to="/crm/complaints?status=open,in_progress">
              Work on it in Complaints
            </Link>
          </div>
        </article>
      )}
      {!chosen && (
        <DataGrid
          id="dash-panel-complaints"
          caption="Open complaints"
          variant="compact"
          columns={[
            {
              key: "subject",
              header: "Complaint",
              value: (item) => item.subject,
              mobile: "title",
              render: (item) => (
                <span className="panel-cell-stack">
                  <strong>{item.subject}</strong>
                  <span className="muted">{item.customerName || "Guest"}</span>
                </span>
              ),
            },
            {
              key: "priority",
              header: "Priority",
              value: (item) => item.priority,
              render: (item) => badge(...(PRIORITY[item.priority] || [item.priority, "neutral"])),
              mobile: "subtitle",
            },
            {
              key: "status",
              header: "Status",
              value: (item) => item.complaintStatus,
              render: (item) => badge(...(COMPLAINT[item.complaintStatus] || [item.complaintStatus, "neutral"])),
              mobile: "show",
            },
            { key: "with", header: "With", value: (item) => item.assignedToName || "", mobile: "show" },
            { key: "at", header: "Raised", type: "date", value: (item) => item.createdAt },
          ]}
          rows={items}
          rowKey={(item) => item.id}
          onRowClick={(item) => setOpenId(item.id)}
          loading={!page && query.isLoading}
          error={errorText(query)}
          onRetry={() => query.refetch()}
          empty="No complaint is open"
          emptyIcon="check-circle"
          rowNoun={["complaint", "complaints"]}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ expenses

const PAID_BY = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  other: "Other",
};
const paidBy = (mode) => PAID_BY[mode] || String(mode || "").replace(/_/g, " ");

// Expenses waiting for approval, any date. Approve and Reject as on the
// Expenses screen (expenses.manage): an expense with its paper bill attached
// is reviewed there, where the bill is shown first; one paid from a drawer
// that is already counted can only be rejected; petty cash from a drawer is
// changed on the drawer.
export function ExpensesPanel({ ctx }) {
  const { currency, hasPermission } = ctx;
  const query = usePanelQuery("expenses-pending", null, () =>
    listExpenses({ status: "pending", page: 1, pageSize: 100 }),
  );
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const canManage = hasPermission("expenses.manage");
  const page = query.data || null;

  const decide = async (expense, status) => {
    setBusy(expense.id);
    setMessage(null);

    try {
      await setExpenseStatus(expense.id, status);
      setMessage({ tone: "success", text: `${money(expense.amount, currency)} ${expense.categoryName} ${status}.` });
      await refreshDashboard();
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const actions = (expense) => {
    if (busy === expense.id) {
      return <span className="muted small">Saving…</span>;
    }

    if (expense.fromDrawer) {
      return <span className="muted small">On the drawer</span>;
    }

    if (expense.attachmentCount > 0) {
      return (
        <Link className="button button-secondary button-sm" to="/expenses?status=pending">
          Review bill
        </Link>
      );
    }

    const locked = expense.drawerClosed && expense.paymentMode === "cash";

    return (
      <span className="panel-row-actions">
        {/* Cash from a drawer already counted: approving would change a closed
            count, so it can only be rejected. Said, so the missing Approve is not a puzzle. */}
        {locked && (
          <span className="muted small panel-row-note" title="Paid in cash from a drawer that is already counted and closed. Approving would change that count, so it can only be rejected.">
            Drawer counted
          </span>
        )}
        {!locked && (
          <button type="button" className="button button-sm" onClick={() => decide(expense, "approved")}>
            Approve
          </button>
        )}
        <button type="button" className="button button-secondary button-sm" onClick={() => decide(expense, "rejected")}>
          Reject
        </button>
      </span>
    );
  };

  return (
    <>
      {page && (
        <PanelFacts
          items={[
            { label: "Waiting", value: count(page.total) },
            page.summary && {
              label: "Amount waiting",
              value: money(page.summary.waitingTotal ?? page.summary.pendingTotal, currency),
            },
          ]}
        />
      )}
      <PanelMessage
        message={message && message.text}
        tone={message && message.tone}
        onDismiss={() => setMessage(null)}
      />
      <DataGrid
        id="dash-panel-expenses"
        caption="Expenses waiting for approval"
        variant="compact"
        columns={[
          {
            key: "category",
            header: "Expense",
            value: (expense) => expense.categoryName,
            mobile: "title",
            render: (expense) => (
              <span className="panel-cell-stack">
                <strong>{expense.categoryName}</strong>
                <span className="muted">
                  {[expense.supplierName, expense.notes].filter(Boolean).join(" · ") ||
                    expense.outletName ||
                    "Shared restaurant expense"}
                </span>
              </span>
            ),
          },
          { key: "date", header: "Date", type: "date", value: (expense) => expense.expenseDate, mobile: "subtitle" },
          {
            key: "mode",
            header: "Paid by",
            value: (expense) => expense.paymentMode,
            render: (expense) => paidBy(expense.paymentMode),
          },
          { key: "by", header: "Entered by", value: (expense) => expense.createdByName || "", defaultHidden: true },
          {
            key: "amount",
            header: "Amount",
            type: "money",
            exact: true,
            value: (expense) => expense.amount,
            mobile: "show",
          },
          canManage && { key: "actions", header: "", label: "Actions", type: "actions", render: actions },
        ]}
        rows={page ? page.items : []}
        rowKey={(expense) => expense.id}
        loading={!page && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty="Nothing is waiting for approval"
        emptyIcon="check-circle"
        currency={currency}
        rowNoun={["expense", "expenses"]}
      />
      {page && page.total > page.items.length && (
        <p className="panel-note">
          Showing the newest {count(page.items.length)} of {count(page.total)} — the rest are on the Expenses screen.
        </p>
      )}
    </>
  );
}

// ------------------------------------------------------------------ purchasing

// Purchase orders sent to a supplier and not fully received (ordered or
// part received), for the outlet chosen or all.
export function PurchaseOrdersPanel({ ctx }) {
  const { currency, data } = ctx;
  const query = usePanelQuery("po-due", null, () => listPurchaseOrders({ status: "ordered,partial" }));
  const all = query.data || null;
  const rows = all ? (data.outletId ? all.filter((po) => Number(po.outletId) === Number(data.outletId)) : all) : [];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: data.timezone });

  return (
    <DataGrid
      id="dash-panel-po-due"
      caption="Deliveries due from suppliers"
      variant="compact"
      columns={[
        { key: "po", header: "Order", value: (po) => po.poNumber, mobile: "title" },
        { key: "supplier", header: "Supplier", value: (po) => po.supplierName, mobile: "subtitle" },
        { key: "expected", header: "Expected", type: "date", value: (po) => po.expectedDate, mobile: "show" },
        {
          key: "status",
          header: "Status",
          value: (po) => po.poStatus,
          render: (po) => (po.poStatus === "partial" ? badge("Part received", "info") : badge("Ordered", "warning")),
          mobile: "show",
        },
        { key: "store", header: "For", value: (po) => po.storeName || "", defaultHidden: !data.outletId },
        { key: "total", header: "Value", type: "money", value: (po) => po.totalAmount },
      ]}
      rows={rows}
      rowKey={(po) => po.id}
      rowClassName={(po) => (po.expectedDate && String(po.expectedDate).slice(0, 10) < today ? "dg-tone-danger" : "")}
      defaultSort={{ key: "expected", direction: "asc" }}
      loading={!all && query.isLoading}
      error={errorText(query)}
      onRetry={() => query.refetch()}
      empty="No delivery is due"
      emptyIcon="truck"
      currency={currency}
      rowNoun={["order", "orders"]}
    />
  );
}
