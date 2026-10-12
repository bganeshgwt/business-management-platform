import DataGrid from "../../../../../components/DataGrid/DataGrid";
import { listBills } from "../../../billing/services/bill.service";
import { count, money } from "../../../../../services/format";
import { paymentMethodLabel } from "../../../../../services/labels";
import { PanelFacts, PanelMessage } from "./panelKit";
import { useBillDialog } from "./useBillDialog";
import { errorText, usePaging, usePanelQuery } from "./panelData";

const STATUS = {
  unpaid: { label: "Unpaid", tone: "warning" },
  partial: { label: "Part paid", tone: "info" },
  paid: { label: "Paid", tone: "success" },
  void: { label: "Void", tone: "neutral" },
};

const TYPE = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };

const statusBadge = (status) => {
  const known = STATUS[status] || { label: status, tone: "neutral" };
  return (
    <span className={`badge badge-${known.tone} status-badge`}>
      <span className="badge-dot" aria-hidden="true" />
      {known.label}
    </span>
  );
};

// The business days the dashboard's "today" is made of: the open day(s) it
// added up, or — with none open — the business date itself.
const todayScope = (data) => {
  const ids = (data.openDays || []).map((day) => day.businessDayId).filter(Boolean);

  return data.dayOpen && ids.length > 0
    ? { businessDays: ids.join(",") }
    : { from: data.businessDate, to: data.businessDate };
};

const billColumns = ({ showDue, actions }) => [
  {
    key: "bill",
    header: "Bill",
    value: (bill) => bill.billNumber,
    mobile: "title",
    render: (bill) => (
      <span className="panel-cell-stack">
        <strong>{bill.billNumber}</strong>
        <span className="muted">{bill.orderNumber}</span>
      </span>
    ),
  },
  { key: "at", header: "Billed", type: "datetime", value: (bill) => bill.billedAt, mobile: "subtitle" },
  {
    key: "where",
    header: "Type",
    value: (bill) => (bill.tableNo ? `Table ${bill.tableNo}` : TYPE[bill.orderType] || bill.orderType),
    mobile: "show",
  },
  {
    key: "guest",
    header: "Guest",
    value: (bill) => bill.accountName || bill.customerName || "",
    defaultHidden: !showDue,
  },
  { key: "status", header: "Status", value: (bill) => bill.billStatus, render: (bill) => statusBadge(bill.billStatus), mobile: "show" },
  { key: "total", header: "Total", type: "money", exact: true, value: (bill) => bill.totalAmount, mobile: "show" },
  showDue && { key: "due", header: "To collect", type: "money", exact: true, value: (bill) => bill.dueAmount, mobile: "show" },
  actions && { key: "actions", header: "", label: "Actions", type: "actions", render: actions },
];

// Sales today, Bills, Orders today: the bills behind the three tiles — every
// bill of today's business day(s), voided ones left out (they are not sales).
export function TodayBillsPanel({ ctx, mode }) {
  const { data, currency, hasPermission } = ctx;
  const paging = usePaging();
  const scope = todayScope(data);
  const params = {
    status: "unpaid,partial,paid",
    ...scope,
    ...(data.outletId ? { outletId: data.outletId } : {}),
    page: paging.page,
    pageSize: paging.pageSize,
  };
  const query = usePanelQuery("today-bills", params, () => listBills(params), { keepPrevious: true });
  const bills = useBillDialog();
  const canOpen = hasPermission("orders.view");
  const page = query.data;

  return (
    <>
      <PanelFacts
        items={[
          { label: "Sales", value: money(data.netSales, currency) },
          { label: "Bills", value: count(data.billCount) },
          { label: "Average bill", value: money(data.averageBill, currency) },
          data.covers && data.covers.perHead > 0 && { label: "A head, dine-in", value: money(data.covers.perHead, currency) },
        ]}
      />
      {mode === "orders" && data.covers && (
        <PanelFacts
          items={[
            { label: "Dine-in", value: `${money(data.covers.dineInSales, currency)} · ${count(data.covers.dineIn)}` },
            { label: "Takeaway", value: `${money(data.covers.takeawaySales, currency)} · ${count(data.covers.takeaway)}` },
            { label: "Delivery", value: `${money(data.covers.deliverySales, currency)} · ${count(data.covers.delivery)}` },
          ]}
        />
      )}
      {mode === "sales" && data.byMethod && data.byMethod.length > 0 && (
        <PanelFacts
          items={data.byMethod.slice(0, 4).map((row) => ({
            label: `Taken by ${paymentMethodLabel(row.paymentMethod)}`,
            value: money(row.amount, currency),
          }))}
        />
      )}
      {page && page.todayOnly && (
        <p className="panel-note">Your role sees bills of the business day open now only.</p>
      )}
      <PanelMessage message={bills.error} tone="error" onDismiss={bills.clearError} />
      <DataGrid
        id="dash-panel-today-bills"
        caption="Bills of this business day"
        variant="compact"
        columns={billColumns({
          showDue: false,
          // A bill still owed says what it is for: Take payment (as on
          // Unpaid bills), for someone who may take one.
          actions: canOpen
            ? (bill) => {
                const owed = ["unpaid", "partial"].includes(bill.billStatus) && hasPermission("payments.manage");

                return (
                  <button
                    type="button"
                    className={`button button-sm ${owed ? "" : "button-secondary"}`}
                    onClick={() => bills.open(bill.id)}
                  >
                    {owed ? "Take payment" : "Open"}
                  </button>
                );
              }
            : null,
        })}
        rows={page ? page.items : []}
        loading={!page && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty="No bills yet in this business day"
        emptyIcon="receipt"
        currency={currency}
        rowNoun={["bill", "bills"]}
        server={{ total: page ? page.total : 0, page: paging.page, pageSize: paging.pageSize, onChange: paging.onChange }}
      />
      {bills.dialog}
    </>
  );
}

// Unpaid bills (at the till) or bills on a guest's or company's account:
// every one still owed, on any day. "Take payment" opens the bill dialog.
export function OwedBillsPanel({ ctx, account }) {
  const { data, currency, hasPermission } = ctx;
  const paging = usePaging();
  const params = {
    status: "unpaid,partial",
    account,
    ...(data.outletId ? { outletId: data.outletId } : {}),
    page: paging.page,
    pageSize: paging.pageSize,
  };
  const query = usePanelQuery(`owed-${account}`, params, () => listBills(params), { keepPrevious: true });
  const bills = useBillDialog();
  const canPay = hasPermission("payments.manage");
  const page = query.data;
  const figure = account === "only" ? data.onAccount : data.unpaid;

  return (
    <>
      <PanelFacts
        items={[
          { label: account === "only" ? "Bills on account" : "Bills unpaid", value: count(figure ? figure.count : 0), tone: account === "only" ? null : "danger" },
          ctx.canSeeSales && figure && figure.due !== undefined && { label: "Still to collect", value: money(figure.due, currency) },
        ]}
      />
      {page && page.todayOnly && (
        <p className="panel-note">Your role sees bills of the business day open now only; older unpaid bills are on the Bills screen for a manager.</p>
      )}
      <PanelMessage message={bills.error} tone="error" onDismiss={bills.clearError} />
      <DataGrid
        id={`dash-panel-owed-${account}`}
        caption={account === "only" ? "Bills on account" : "Unpaid bills"}
        variant="compact"
        columns={billColumns({
          showDue: true,
          actions: (bill) => (
            <button
              type="button"
              className={`button button-sm ${canPay ? "" : "button-secondary"}`}
              onClick={() => bills.open(bill.id)}
            >
              {canPay ? "Take payment" : "Open"}
            </button>
          ),
        })}
        rows={page ? page.items : []}
        loading={!page && query.isLoading}
        error={errorText(query)}
        onRetry={() => query.refetch()}
        empty="Nothing left to collect"
        emptyIcon="check-circle"
        currency={currency}
        rowNoun={["bill", "bills"]}
        rowClassName={(bill) => (bill.billStatus === "unpaid" ? "dg-tone-warning" : "")}
        server={{ total: page ? page.total : 0, page: paging.page, pageSize: paging.pageSize, onChange: paging.onChange }}
      />
      {bills.dialog}
    </>
  );
}
