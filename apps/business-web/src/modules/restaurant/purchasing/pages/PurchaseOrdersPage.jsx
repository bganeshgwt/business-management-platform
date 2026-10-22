import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SearchPicker from "../../../../components/SearchPicker";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  approvePurchaseOrder,
  createPurchaseOrder,
  deletePurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  sendBackPurchaseOrder,
  setPurchaseOrderStatus,
  updatePurchaseOrder,
} from "../services/purchase.service";
import { withApproval } from "../../../../services/approval";
import { listSuppliers } from "../services/supplier.service";
import { getStockSettings, listInventoryItems, listStores } from "../../inventory/services/inventory.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { dayMonth, monthStart, today } from "@bmp/shared/dates";
import { count, money, moneyExact } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { Chip, ReasonDialog, Tabs } from "../../inventory/pages/stockUi";
import { PO_STATUS, niceDate, priceText, qty, unitMoney } from "../../inventory/pages/stockFormat";
import LineEditor from "./LineEditor";
import ReceiveGoodsModal from "./ReceiveGoodsModal";
import PurchaseBillModal from "./PurchaseBillModal";
import PurchaseBillsPanel from "./PurchaseBillsPanel";
import PurchaseRegisterPanel from "./PurchaseRegisterPanel";
import { EMPTY_LINE, billTotals } from "./lineMath";
import { mailLink, orderMessage, printPurchaseOrder, whatsappLink } from "./poDocument";
import "../../../../styles/stock.css";
import "../../../../styles/backoffice-sweep.css";
import "../styles/purchasing-pro.css";

const orderedText = (line) =>
  line.packName && line.packQuantity
    ? `${qty(line.packQuantity)} × ${line.packName}`
    : qty(line.quantity, line.unitShortName);

export default function PurchaseOrdersPage() {
  const { hasPermission, user } = useAuth();
  const canManage = hasPermission("purchasing.manage");
  const canReceive = hasPermission("purchasing.receive");
  const canPay = hasPermission("purchasing.pay");
  // Approving an order over the limit: the right itself, or a buyer who asks
  // a manager standing there for their PIN (the server binds it to the order).
  const canApprove = hasPermission("purchasing.approve");
  const canDecide = canApprove || canManage;
  const [tab, setTab] = useQueryFilter("tab", "orders");

  const [orders, setOrders] = useState([]);
  // Every order still open, whatever its date, for the tiles: "Waiting for
  // delivery" means all of them, not only this month's.
  const [openOrders, setOpenOrders] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [items, setItems] = useState([]);
  // Whether the supplier and item lists have come back (each true once it
  // loaded), so "add a supplier and an item first" is never shown while
  // they are still on their way.
  const [suppliersLoaded, setSuppliersLoaded] = useState(false);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [stores, setStores] = useState([]);
  const [currency, setCurrency] = useState("₹");
  const [gstNumber, setGstNumber] = useState(null);
  const [statusFilter, setStatusFilter] = useQueryFilter("status");
  const [supplierFilter, setSupplierFilter] = useQueryFilter("supplier");
  const [search, setSearch] = useState("");
  const [fromParam, setFrom] = useQueryFilter("from");
  const [toParam, setTo] = useQueryFilter("to");
  const [limits, setLimits] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [success, setSuccess] = useState("");

  const [editor, setEditor] = useState(null); // { id?, form, lines }
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [viewing, setViewing] = useState(null);
  const [receiving, setReceiving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [billing, setBilling] = useState(false);
  const [billsKey, setBillsKey] = useState(0);
  // Waste & reorder links to the draft it just made with ?open=<id>. The
  // order opens as the page arrives, and the id is then taken out of the
  // address, so closing the order does not open it again on the next render.
  const [openParam, setOpenParam] = useQueryFilter("open");
  // The list opens on this month's orders, with the dates in sight; older
  // ones are a date pick away. A status (the bell's "waiting for approval",
  // "waiting for delivery") or a search looks across every date instead, so
  // an order raised last month and still open is never hidden by the dates.
  const acrossDays = Boolean(statusFilter || search.trim());
  const from = fromParam || (acrossDays ? "" : monthStart());
  const to = toParam || (acrossDays ? "" : today());
  const [sendingBack, setSendingBack] = useState(false);
  const [approveNote, setApproveNote] = useState("");

  const load = useCallback(
    () =>
      listPurchaseOrders({
        status: statusFilter || undefined,
        supplierId: supplierFilter || undefined,
        search: search.trim() || undefined,
        from: from || undefined,
        to: to || undefined,
      })
        .then((rows) => {
          setOrders(rows);
          setLoadError("");
        })
        .catch((err) => setLoadError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [statusFilter, supplierFilter, search, from, to]
  );

  const loadOpen = useCallback(
    () =>
      listPurchaseOrders({ status: "draft,pending_approval,ordered,partial" })
        .then(setOpenOrders)
        .catch(() => setOpenOrders([])),
    []
  );

  // Again whenever the list is read again (after a save, a receipt…).
  useEffect(() => {
    loadOpen();
  }, [loadOpen, orders]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!openParam) {
      return;
    }

    getPurchaseOrder(openParam)
      .then((order) => {
        setTab("orders");
        setViewing(order);
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setOpenParam(""));
  }, [openParam, setOpenParam, setTab]);

  const loadItems = useCallback(
    () =>
      listInventoryItems()
        .then((rows) => {
          setItems(rows.filter((row) => row.status === "active"));
          setItemsLoaded(true);
        })
        .catch(() => setItems([])),
    []
  );

  useEffect(() => {
    listSuppliers()
      .then((rows) => {
        setSuppliers(rows.filter((row) => row.status === "active"));
        setSuppliersLoaded(true);
      })
      .catch(() => setSuppliers([]));

    loadItems();

    listStores()
      .then(setStores)
      .catch(() => setStores([]));

    getSettings()
      .then((settings) => {
        setCurrency(settings.currencySymbol);
        setGstNumber(settings.gstNumber || null);
      })
      .catch(() => undefined);

    // The approval limit, so the order screen can say "over the ₹50,000
    // limit" before anyone presses Mark as ordered.
    getStockSettings()
      .then(setLimits)
      .catch(() => setLimits(null));
  }, [loadItems]);

  const openNew = () => {
    setEditor({
      form: {
        supplierId: suppliers[0] ? String(suppliers[0].id) : "",
        orderDate: today(),
        expectedDate: "",
        notes: "",
      },
      lines: [{ ...EMPTY_LINE }],
    });
    setFormError("");
  };

  const openEdit = (order) => {
    setEditor({
      id: order.id,
      poNumber: order.poNumber,
      form: {
        supplierId: String(order.supplierId),
        orderDate: order.orderDate,
        expectedDate: order.expectedDate || "",
        notes: order.notes || "",
      },
      lines: order.items.map((line) => ({
        ...EMPTY_LINE,
        inventoryItemId: String(line.inventoryItemId),
        packId: line.packId ? String(line.packId) : "",
        quantity: String(line.packId && line.packQuantity ? line.packQuantity : line.quantity),
        unitPrice: priceText(line.packId && line.packPrice !== null ? line.packPrice : line.unitPrice),
      })),
    });
    setViewing(null);
    setFormError("");
  };

  const saveOrder = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      supplierId: Number(editor.form.supplierId),
      orderDate: editor.form.orderDate,
      expectedDate: editor.form.expectedDate || null,
      notes: editor.form.notes || null,
      poStatus: "draft",
      items: editor.lines
        .filter((line) => line.inventoryItemId && Number(line.quantity) > 0)
        .map((line) => ({
          inventoryItemId: Number(line.inventoryItemId),
          packId: line.packId ? Number(line.packId) : null,
          quantity: Number(line.quantity),
          unitPrice: Number(line.unitPrice || 0),
        })),
    };

    try {
      if (editor.id) {
        const saved = await updatePurchaseOrder(editor.id, payload);
        setSuccess(`${saved.poNumber} updated`);
        setViewing(saved);
      } else {
        const saved = await createPurchaseOrder(payload);
        setSuccess(`${saved.poNumber} saved as a draft`);
        setViewing(saved);
      }

      setEditor(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openOrder = async (order) => {
    setFormError("");

    try {
      setViewing(await getPurchaseOrder(order.id));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const changeStatus = async (status, reason) => {
    setSaving(true);
    setFormError("");

    try {
      const order = await setPurchaseOrderStatus(viewing.id, status, reason);
      setViewing(order);
      setSuccess(
        order.approvalStep === "requested"
          ? `${viewing.poNumber} is over the ${money(order.approvalLimit, currency)} approval limit, so it is waiting for approval before it goes to the supplier`
          : status === "closed"
            ? `${viewing.poNumber} closed short — the rest is no longer expected`
            : status === "draft"
              ? `${viewing.poNumber} taken back to draft — change it and send it again`
              : `${viewing.poNumber} ${status === "ordered" ? "marked as ordered" : "cancelled"}`
      );
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // The approver's yes. Someone without "Approve purchase orders" is asked for
  // a manager's PIN, tied to this order and its total.
  const approveOrder = async () => {
    setSaving(true);
    setFormError("");

    try {
      const result = await withApproval(
        (headers) => approvePurchaseOrder(viewing.id, approveNote.trim() || null, headers),
        `Approve ${viewing.poNumber} — ${moneyExact(viewing.totalAmount, currency)}`,
        { permission: "purchasing.approve", scope: { purchaseOrderId: viewing.id, amount: viewing.totalAmount } }
      );
      setViewing(result.data);
      setApproveNote("");
      setSuccess(result.message);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const sendBackOrder = async (note) => {
    const result = await withApproval(
      (headers) => sendBackPurchaseOrder(viewing.id, note, headers),
      `Send back ${viewing.poNumber}`,
      { permission: "purchasing.approve", scope: { purchaseOrderId: viewing.id, amount: viewing.totalAmount } }
    );
    setViewing(result.data);
    setSendingBack(false);
    setSuccess(result.message);
    load();
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deletePurchaseOrder(deleting.id);
      setSuccess(`Draft ${deleting.poNumber} deleted`);
      setDeleting(null);
      setViewing(null);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const docContext = { restaurantName: user.restaurantName, gstNumber, currency };
  const counts = openOrders.reduce((acc, order) => ({ ...acc, [order.poStatus]: (acc[order.poStatus] || 0) + 1 }), {});
  const awaiting = openOrders.filter((order) => ["ordered", "partial"].includes(order.poStatus));
  const waitingApproval = openOrders.filter((order) => order.poStatus === "pending_approval");
  const waitingApprovalValue = waitingApproval.reduce((sum, order) => sum + order.totalAmount, 0);
  const poLimit =
    limits && limits.poApprovalLimit !== null && limits.poApprovalLimit !== undefined ? limits.poApprovalLimit : null;
  const late = awaiting.filter((order) => order.expectedDate && order.expectedDate < today());
  const awaitingValue = awaiting.reduce((sum, order) => sum + order.totalAmount - (order.billedAmount || 0), 0);

  const isLateOrder = (order) =>
    ["ordered", "partial"].includes(order.poStatus) && order.expectedDate && order.expectedDate < today();

  // The list as a grid: S.No., sort by any heading, page through, export.
  // A row opens the order; Delete stays on drafts only.
  const orderColumns = [
    {
      key: "number",
      header: "Order",
      value: (order) => order.poNumber,
      mobile: "title",
      pin: true,
      render: (order) => (
        <>
          <strong className="mono">{order.poNumber}</strong>
          {order.outletId && (
            <div className="muted small">
              {order.storeName}
              {order.outletClosed ? " · closed" : ""}
            </div>
          )}
        </>
      ),
    },
    { key: "supplier", header: "Supplier", value: (order) => order.supplierName, mobile: "subtitle", filter: "select" },
    {
      key: "ordered",
      header: "Ordered",
      type: "date",
      value: (order) => order.orderDate,
      render: (order) => <span className="nowrap">{niceDate(order.orderDate)}</span>,
      mobile: "show",
      width: 130,
    },
    {
      key: "expected",
      header: "Expected",
      type: "date",
      width: 130,
      value: (order) => order.expectedDate,
      render: (order) => (
        <>
          <span className="nowrap">{order.expectedDate ? niceDate(order.expectedDate) : "—"}</span>
          {isLateOrder(order) && (
            <div>
              <Chip tone="danger">Late</Chip>
            </div>
          )}
        </>
      ),
      mobile: "show",
    },
    { key: "lines", header: "Lines", type: "number", value: (order) => order.itemCount, mobile: "hide", width: 110 },
    {
      key: "total",
      header: "Total",
      type: "money",
      value: (order) => order.totalAmount,
      total: "sum",
      render: (order) => (
        <>
          {money(order.totalAmount, currency)}
          {order.billedAmount > 0 && <div className="muted small">{money(order.billedAmount, currency)} billed</div>}
        </>
      ),
      mobile: "show",
    },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (order) => (PO_STATUS[order.poStatus] || { label: order.poStatus }).label,
      filter: "select",
      render: (order) => {
        const status = PO_STATUS[order.poStatus] || { label: order.poStatus };

        return (
          <>
            <Chip tone={status.tone}>{status.label}</Chip>
            {order.poStatus === "pending_approval" && order.approval.requestedByName && (
              <div className="muted small">asked by {order.approval.requestedByName}</div>
            )}
            {order.poStatus === "draft" && order.approval.rejectedAt && (
              <div className="small bo-sent-back">sent back</div>
            )}
          </>
        );
      },
      mobile: "show",
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (order) => (
        <span className="row-actions">
          <button type="button" className="link-button" onClick={() => openOrder(order)}>
            Open
          </button>
          {canManage && order.poStatus === "draft" && (
            <button type="button" className="link-button danger" onClick={() => setDeleting(order)}>
              Delete
            </button>
          )}
        </span>
      ),
    },
  ];

  const lineColumns = [
    {
      key: "item",
      header: "Item",
      value: (line) => line.itemName,
      mobile: "title",
      render: (line) => <strong>{line.itemName}</strong>,
    },
    {
      key: "ordered",
      header: "Ordered",
      type: "number",
      value: (line) => line.quantity,
      render: (line) => (
        <>
          {orderedText(line)}
          {line.packName && <div className="muted small">{qty(line.quantity, line.unitShortName)}</div>}
        </>
      ),
    },
    {
      key: "received",
      header: "Received",
      type: "number",
      value: (line) => line.receivedQuantity,
      render: (line) => (
        <>
          {qty(line.receivedQuantity, line.unitShortName)}
          {line.outstandingQuantity > 0 && viewing && !["closed", "cancelled"].includes(viewing.poStatus) && (
            <div className="muted small">{qty(line.outstandingQuantity, line.unitShortName)} to come</div>
          )}
        </>
      ),
    },
    {
      key: "rate",
      header: "Rate",
      type: "money",
      value: (line) => (line.packName && line.packPrice !== null ? line.packPrice : line.unitPrice),
      render: (line) =>
        line.packName && line.packPrice !== null
          ? `${moneyExact(line.packPrice, currency)}/${line.packName}`
          : `${unitMoney(line.unitPrice, currency)}/${line.unitShortName}`,
    },
    { key: "amount", header: "Amount", type: "money", exact: true, value: (line) => line.amount },
  ];

  const editorTotals = editor ? billTotals(editor.lines.map((line) => ({ ...line, taxRate: 0 })), false) : null;

  // A tile shows that status across every date: the list follows it.
  const showStatus = (status) => {
    setFrom("");
    setTo("");
    setStatusFilter(status);
  };
  const isShowing = (status) => statusFilter === status && !fromParam && !toParam;
  // Why "New order" / "Enter a purchase bill" cannot be used yet.
  const blockedWhy =
    suppliersLoaded && suppliers.length === 0
      ? "Add a supplier first (Purchasing, Suppliers)."
      : itemsLoaded && items.length === 0
        ? "Add a stock item first (Inventory, Items & stock)."
        : !suppliersLoaded || !itemsLoaded
          ? "Loading suppliers and items…"
          : "";

  const tabs = [
    { key: "orders", label: "Purchase orders", short: "Orders", icon: "clipboard" },
    { key: "bills", label: "Purchase bills", short: "Bills", icon: "receipt" },
    { key: "register", label: "Purchase register", short: "Register", icon: "book" },
  ];

  return (
    <div className="stack stk-page">
      <PageHeader
        icon="clipboard"
        title="Purchase orders & bills"
        description="Order from suppliers, receive the goods against their bill, and enter bills for anything bought without an order."
        action={
          <div className="stk-actions">
            {canReceive && (
              <button
                type="button"
                className={canManage ? "button button-secondary" : "button"}
                onClick={() => setBilling(true)}
                disabled={suppliers.length === 0 || items.length === 0}
                title={blockedWhy || undefined}
              >
                <Icon name="receipt" size={16} /> Enter a purchase bill
              </button>
            )}
            {canManage && (
              <button
                type="button"
                className="button"
                onClick={openNew}
                disabled={suppliers.length === 0 || items.length === 0}
                title={blockedWhy || undefined}
              >
                <Icon name="plus" size={16} /> New order
              </button>
            )}
          </div>
        }
      />

      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Purchasing sections" />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {suppliersLoaded && itemsLoaded && (suppliers.length === 0 || items.length === 0) && !loading && (
        <div className="alert">{blockedWhy}</div>
      )}

      {tab === "bills" && (
        <PurchaseBillsPanel
          suppliers={suppliers}
          currency={currency}
          canReceive={canReceive}
          refreshKey={billsKey}
          onChanged={() => {
            load();
            loadItems();
          }}
          restaurantName={user.restaurantName}
        />
      )}

      {tab === "register" && (
        <PurchaseRegisterPanel suppliers={suppliers} currency={currency} restaurantName={user.restaurantName} />
      )}

      {tab === "orders" && (
        <>
          <div className="stat-grid">
            <StatTile
              icon="edit"
              tone="neutral"
              label="Drafts"
              value={count(counts.draft || 0)}
              note="not sent yet · any date"
              onClick={() => showStatus("draft")}
              className={isShowing("draft") ? "is-picked" : ""}
            />
            {(poLimit !== null || waitingApproval.length > 0) && (
              <StatTile
                icon="shield"
                label="Waiting for approval"
                value={count(waitingApproval.length)}
                tone={waitingApproval.length ? "warning" : "neutral"}
                note={
                  waitingApproval.length
                    ? `${money(waitingApprovalValue, currency)} not sent yet`
                    : poLimit !== null
                      ? `orders over ${money(poLimit, currency)} wait here`
                      : "nothing waiting"
                }
                onClick={() => showStatus("pending_approval")}
                className={isShowing("pending_approval") ? "is-picked" : ""}
              />
            )}
            <StatTile
              icon="truck"
              label="Waiting for delivery"
              value={count(awaiting.length)}
              tone={awaiting.length ? "info" : "neutral"}
              note={awaiting.length ? `${money(awaitingValue, currency)} still to come` : "nothing on order"}
              onClick={() => showStatus("ordered,partial")}
              className={isShowing("ordered,partial") ? "is-picked" : ""}
            />
            <StatTile
              icon="clock"
              label="Late"
              value={count(late.length)}
              tone={late.length ? "danger" : "neutral"}
              note={late.length ? "past the expected date" : "all on time"}
              onClick={() => showStatus("ordered,partial")}
            />
            <StatTile
              icon="layers"
              label="Part received"
              value={count(counts.partial || 0)}
              tone={counts.partial ? "warning" : "neutral"}
              note="receive the rest or close short"
              onClick={() => showStatus("partial")}
              className={isShowing("partial") ? "is-picked" : ""}
            />
          </div>

          <SectionCard
            icon="list"
            title="Orders"
            description="Open an order to send it, receive what arrived, or print it."
            actions={<span className="stk-count">{orders.length === 1 ? "1 order" : `${count(orders.length)} orders`}</span>}
            flush
          >
            <div className="stk-filterbar filters">
              <label className="field">
                <span>Status</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="">All</option>
                  <option value="ordered,partial">Waiting for delivery</option>
                  {Object.entries(PO_STATUS).map(([value, status]) => (
                    <option key={value} value={value}>
                      {status.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <SearchPicker
                  label="Supplier"
                  value={suppliers.find((row) => String(row.id) === String(supplierFilter)) || null}
                  onChange={(row) => setSupplierFilter(row ? String(row.id) : "")}
                  options={suppliers}
                  getKey={(row) => row.id}
                  getLabel={(row) => row.name}
                  getKeywords={(row) => `${row.code || ""} ${row.gstNumber || ""}`}
                  placeholder="All suppliers"
                  emptyText="No supplier has that name"
                />
              </div>
              <label className="field">
                <span>Find</span>
                <span className="input-with-icon">
                  <Icon name="search" size={17} className="input-icon" />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="PO number or supplier"
                  />
                </span>
              </label>
              <DateRangeFilter
                from={from}
                to={to}
                label="order dates"
                onChange={(range) => {
                  setFrom(range.from);
                  setTo(range.to);
                }}
              />
            </div>
            {acrossDays && !fromParam && !toParam && (
              <p className="muted small bo-across">
                Showing every date{statusFilter ? " for this status" : " for this search"}.{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setFrom(monthStart());
                    setTo(today());
                  }}
                >
                  This month only
                </button>
              </p>
            )}

            <DataGrid
              id="purchase-orders"
              currency={currency}
              caption="Purchase orders"
              columns={orderColumns}
              rows={orders}
              rowKey={(order) => order.id}
              loading={loading}
              error={loadError}
              onRetry={load}
              empty="No purchase orders match."
              emptyIcon="clipboard"
              emptyHint={
                acrossDays
                  ? "Nothing with this status or search on any date."
                  : "None in these dates. Pick older dates, or raise one here or from Waste & reorder's suggestions."
              }
              emptyAction={
                canManage &&
                suppliers.length > 0 && (
                  <button type="button" className="button" onClick={openNew}>
                    <Icon name="plus" size={16} /> New order
                  </button>
                )
              }
              onRowClick={openOrder}
              rowClassName={(order) =>
                order.poStatus === "cancelled"
                  ? "dg-tone-muted"
                  : order.poStatus === "pending_approval"
                    ? "dg-tone-warning"
                    : isLateOrder(order)
                      ? "dg-tone-danger"
                      : ""
              }
              search={false}
              exportName="purchase-orders"
            />
          </SectionCard>
        </>
      )}

      {editor && (
        <Modal
          title={editor.id ? `Edit draft ${editor.poNumber}` : "New purchase order"}
          description="Saved as a draft. Mark it as ordered when it goes to the supplier."
          icon={editor.id ? "edit" : "clipboard"}
          onClose={() => setEditor(null)}
          width={980}
        >
          <form className="stack stk-scope" onSubmit={saveOrder}>
            <ErrorMessage message={formError} />

            <div className="form-grid">
              <label className="field">
                <span>Supplier</span>
                <select
                  value={editor.form.supplierId}
                  onChange={(event) => setEditor({ ...editor, form: { ...editor.form, supplierId: event.target.value } })}
                  required
                >
                  {suppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Order date</span>
                <input
                  type="date"
                  value={editor.form.orderDate}
                  onChange={(event) => setEditor({ ...editor, form: { ...editor.form, orderDate: event.target.value } })}
                  required
                />
              </label>

              <label className="field">
                <span>Expected by</span>
                <input
                  type="date"
                  value={editor.form.expectedDate}
                  min={editor.form.orderDate}
                  onChange={(event) => setEditor({ ...editor, form: { ...editor.form, expectedDate: event.target.value } })}
                />
              </label>

              <label className="field">
                <span>Notes for the supplier</span>
                <input
                  value={editor.form.notes}
                  onChange={(event) => setEditor({ ...editor, form: { ...editor.form, notes: event.target.value } })}
                  placeholder="Deliver before 10 am"
                />
              </label>
            </div>

            <LineEditor
              lines={editor.lines}
              onChange={(lines) => setEditor({ ...editor, lines })}
              items={items}
              currency={currency}
            />

            <div className="stk-foot">
              <p className="muted small">Prices before GST — the bill's GST is entered when the goods arrive.</p>
              <dl className="stk-totals">
                <dt className="is-grand">Order total</dt>
                <dd className="is-grand">{moneyExact(editorTotals.total, currency)}</dd>
              </dl>
            </div>

            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setEditor(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : editor.id ? "Save changes" : "Save draft"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && !receiving && !editor && (
        <Modal
          title={`${viewing.poNumber} — ${viewing.supplierName}`}
          description={`Ordered ${niceDate(viewing.orderDate)} · ${moneyExact(viewing.totalAmount, currency)} before GST`}
          icon="clipboard"
          onClose={() => setViewing(null)}
          width={860}
          footer={
            <>
              {/* What ends the order sits apart at the left, away from the
                  everyday Receive goods. */}
              {canManage && ["draft", "ordered", "pending_approval"].includes(viewing.poStatus) && (
                <button
                  type="button"
                  className="button button-secondary stk-foot-start"
                  onClick={() => changeStatus("cancelled")}
                  disabled={saving}
                >
                  <Icon name="x-circle" size={16} /> Cancel order
                </button>
              )}

              {canManage && viewing.poStatus === "partial" && (
                <button
                  type="button"
                  className="button button-secondary stk-foot-start"
                  onClick={() => setClosing(true)}
                  disabled={saving}
                >
                  Close short
                </button>
              )}

              <button
                type="button"
                className="button button-secondary"
                onClick={() => printPurchaseOrder(viewing, docContext)}
              >
                <Icon name="print" size={16} /> {viewing.poStatus === "draft" ? "Print draft" : "Print / PDF"}
              </button>
              {/* Only an order that has gone to the supplier is sent to them:
                  not a draft, and not one still waiting for approval. */}
              {viewing.poStatus !== "pending_approval" &&
                viewing.poStatus !== "draft" && whatsappLink(viewing.supplierMobile, orderMessage(viewing, docContext)) && (
                <a
                  className="button button-secondary"
                  href={whatsappLink(viewing.supplierMobile, orderMessage(viewing, docContext))}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="message" size={16} /> Send on WhatsApp
                </a>
              )}
              {viewing.poStatus !== "pending_approval" &&
                viewing.poStatus !== "draft" &&
                mailLink(viewing.supplierEmail, `Purchase order ${viewing.poNumber}`, orderMessage(viewing, docContext)) && (
                <a
                  className="button button-secondary"
                  href={mailLink(viewing.supplierEmail, `Purchase order ${viewing.poNumber}`, orderMessage(viewing, docContext))}
                >
                  <Icon name="mail" size={16} /> Email
                </a>
              )}

              {canManage && viewing.poStatus === "draft" && (
                <button type="button" className="button button-secondary" onClick={() => openEdit(viewing)}>
                  <Icon name="edit" size={16} /> Edit
                </button>
              )}

              {canManage && viewing.poStatus === "draft" && (
                <button type="button" className="button" onClick={() => changeStatus("ordered")} disabled={saving}>
                  {poLimit !== null && viewing.totalAmount > poLimit && !canApprove ? "Send for approval" : "Mark as ordered"}
                </button>
              )}

              {canManage && viewing.poStatus === "pending_approval" && !canApprove && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => changeStatus("draft")}
                  disabled={saving}
                  title="Take it back to change it; it asks for approval again when sent"
                >
                  <Icon name="undo" size={16} /> Take back to change
                </button>
              )}

              {canDecide && viewing.poStatus === "pending_approval" && (
                <>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setSendingBack(true)}
                    disabled={saving}
                  >
                    <Icon name="undo" size={16} /> Send back
                  </button>
                  <button type="button" className="button" onClick={approveOrder} disabled={saving}>
                    <Icon name="check" size={16} /> {saving ? "Approving…" : "Approve and send"}
                  </button>
                </>
              )}

              {canReceive && ["ordered", "partial"].includes(viewing.poStatus) && (
                <button type="button" className="button" onClick={() => setReceiving(true)}>
                  <Icon name="truck" size={16} /> Receive goods
                </button>
              )}
            </>
          }
        >
          <div className="stack stk-scope">
            <ErrorMessage message={formError} />

            <div className="stk-actions">
              <Chip tone={(PO_STATUS[viewing.poStatus] || {}).tone}>{(PO_STATUS[viewing.poStatus] || {}).label}</Chip>
              {viewing.closedReason && viewing.poStatus === "closed" && (
                <span className="muted small">Closed short: {viewing.closedReason}</span>
              )}
            </div>

            <dl className="details">
              <dt>Ordered</dt>
              <dd>
                {niceDate(viewing.orderDate)}
                {viewing.createdByName ? ` by ${viewing.createdByName}` : ""}
              </dd>
              <dt>Expected</dt>
              <dd>{viewing.expectedDate ? niceDate(viewing.expectedDate) : "—"}</dd>
              <dt>Deliver to</dt>
              <dd>
                {viewing.storeName}
                {/* Closed since the order was raised: what still arrives goes to the main store. */}
                {viewing.outletClosed && ["ordered", "partial"].includes(viewing.poStatus) && (
                  <div className="muted small">Outlet closed — goods still due will go into the main store</div>
                )}
              </dd>
              <dt>Supplier</dt>
              <dd>
                {viewing.supplierName}
                {viewing.supplierMobile ? ` · ${viewing.supplierMobile}` : ""}
              </dd>
              {viewing.notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{viewing.notes}</dd>
                </>
              )}
              {viewing.approval.approvedAt && (
                <>
                  <dt>Approved</dt>
                  <dd>
                    {viewing.approval.approvedByName || "—"} · {dayMonth(viewing.approval.approvedAt, { time: true })}
                    {viewing.approval.approvedAmount !== null &&
                      ` · for ${moneyExact(viewing.approval.approvedAmount, currency)}`}
                    {viewing.approval.note && <div className="muted small">“{viewing.approval.note}”</div>}
                  </dd>
                </>
              )}
            </dl>

            {viewing.poStatus === "pending_approval" && (
              <div className="bo-approval-box" data-motion-item>
                <span className="bo-approval-mark" aria-hidden="true">
                  <Icon name="shield" size={18} />
                </span>
                <div className="bo-approval-body">
                  <strong>Waiting for approval</strong>
                  <p className="muted small">
                    {moneyExact(viewing.totalAmount, currency)}
                    {poLimit !== null ? ` is over the ${money(poLimit, currency)} limit` : " is over the approval limit"}
                    {viewing.approval.requestedByName ? ` · asked by ${viewing.approval.requestedByName}` : ""}
                    {viewing.approval.requestedAt ? ` · ${dayMonth(viewing.approval.requestedAt, { time: true })}` : ""}. It
                    goes to the supplier once approved; sending it back returns it to the buyer as a draft with your note.
                  </p>
                  {canDecide && (
                    <label className="field bo-approval-note">
                      <span>
                        Note with the approval <small className="muted">(optional, printed on the order)</small>
                      </span>
                      <input
                        value={approveNote}
                        onChange={(event) => setApproveNote(event.target.value)}
                        maxLength={300}
                        placeholder="e.g. OK for the wedding on Saturday"
                      />
                    </label>
                  )}
                </div>
              </div>
            )}

            {viewing.poStatus === "draft" && viewing.approval.rejectedAt && (
              <div className="alert bo-sent-back-note">
                <Icon name="undo" size={16} />
                <span>
                  Sent back by {viewing.approval.rejectedByName || "an approver"} on{" "}
                  {dayMonth(viewing.approval.rejectedAt, { time: true })}: “{viewing.approval.rejectionNote}”. Change the
                  order and send it again.
                </span>
              </div>
            )}

            <DataGrid
              id="purchase-order-lines"
              currency={currency}
              caption={`Lines on ${viewing.poNumber}`}
              columns={lineColumns}
              rows={viewing.items}
              rowKey={(line) => line.id}
              variant="compact"
              pageSize={false}
            />

            <div className="stk-foot">
              <p className="muted small">
                {viewing.items.length === 1 ? "1 line" : `${viewing.items.length} lines`} · prices before GST
              </p>
              <dl className="stk-totals">
                <dt className="is-grand">Order total</dt>
                <dd className="is-grand">{moneyExact(viewing.totalAmount, currency)}</dd>
              </dl>
            </div>

            {viewing.receipts.length > 0 && (
              <div className="stack">
                <h3 className="stk-subhead">Deliveries</h3>
                <div className="stk-actions">
                  {viewing.receipts.map((receipt) => (
                    <Chip key={receipt.id} tone={receipt.status === "void" ? "danger" : "success"}>
                      {receipt.receiptNumber}
                      {receipt.billNumber ? ` · bill ${receipt.billNumber}` : ""} · {niceDate(receipt.receivedDate)} ·{" "}
                      {moneyExact(receipt.totalAmount, currency)}
                      {receipt.status === "void" ? " (voided)" : ""}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            {viewing.poStatus === "draft" && (
              <div className="alert alert-info">
                <span>
                  A draft has not gone to the supplier yet. Mark it as ordered to send it on WhatsApp or by email; a
                  printed draft says DRAFT across it.
                </span>
              </div>
            )}

          </div>
        </Modal>
      )}

      {receiving && viewing && (
        <ReceiveGoodsModal
          order={viewing}
          currency={currency}
          canPay={canPay}
          onClose={() => setReceiving(false)}
          onReceived={(order) => {
            setReceiving(false);
            setViewing(order);
            setSuccess(
              `Goods received on ${order.poNumber} and stock updated${order.storeNote ? `. ${order.storeNote}` : ""}`
            );
            setBillsKey((key) => key + 1);
            load();
            loadItems();
          }}
        />
      )}

      {sendingBack && viewing && (
        <ReasonDialog
          title={`Send ${viewing.poNumber} back?`}
          message="It goes back to the buyer as a draft with your note, so they can change it and send it again. Nothing goes to the supplier."
          label="Why it is being sent back"
          placeholder="e.g. Order half — the other half next week"
          confirmLabel="Send back"
          danger={false}
          onCancel={() => setSendingBack(false)}
          onConfirm={sendBackOrder}
        />
      )}

      {closing && viewing && (
        <ReasonDialog
          title={`Close ${viewing.poNumber} short?`}
          message="What arrived stays on record and the supplier is owed only for that. The rest is no longer expected, so it stops showing as on order and in late alerts."
          label="Why the rest is not coming"
          placeholder="Supplier out of stock, will not send the rest"
          confirmLabel="Close short"
          danger={false}
          onCancel={() => setClosing(false)}
          onConfirm={async (reason) => {
            await changeStatus("closed", reason);
            setClosing(false);
          }}
        />
      )}

      {billing && (
        <PurchaseBillModal
          suppliers={suppliers}
          items={items}
          stores={stores}
          currency={currency}
          canPay={canPay}
          onClose={() => setBilling(false)}
          onSaved={(bill) => {
            setBilling(false);
            setSuccess(`${bill.receiptNumber} saved — ${moneyExact(bill.totalAmount, currency)} from ${bill.supplierName}, stock added`);
            setBillsKey((key) => key + 1);
            setTab("bills");
            loadItems();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete draft ${deleting.poNumber}?`}
          message="The draft is removed. Orders already sent to a supplier are cancelled instead, so they stay on record."
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
