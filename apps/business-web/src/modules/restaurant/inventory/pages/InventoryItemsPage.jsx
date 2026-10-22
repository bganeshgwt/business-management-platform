import BatchStockPanel from "./BatchStockPanel";
import ProductionPanel from "./ProductionPanel";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import ActionMenu from "../../../../components/ActionMenu";
import { count } from "@bmp/shared/format";
import { daysAgo } from "@bmp/shared/dates";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import {
  createInventoryItem,
  createUnit,
  deleteInventoryItem,
  deleteUnit,
  listInventoryItems,
  listStores,
  listUnits,
  setOutletOwnStore,
  stockIn,
  stockOut,
  transferStock,
  getStockBalances,
  updateInventoryItem,
  updateUnit,
} from "../services/inventory.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter, { useQueryFlag } from "../../../../hooks/useQueryFilter";
import { Chip, Tabs, Tile } from "./stockUi";
import { qty, storesWorthListing, unitMoney } from "./stockFormat";
import StockCountPanel from "./StockCountPanel";
import ClosingStockPanel from "./ClosingStockPanel";
import WasteReasonMark from "./WasteReasonMark";
import SheetImportModal from "./SheetImportModal";
import { getStockImportGuide, importStockItems } from "../services/inventory.service";
import { withApproval } from "../../../../services/approval";
import StatTile from "../../../../components/StatTile";
import "../../../../styles/stock.css";
import "../styles/stock-pro.css";
import { BusinessDateChip } from "../../business-day/pages/StaleDay";
import SearchPicker from "../../../../components/SearchPicker";
import { listSuppliers } from "../../purchasing/services/supplier.service";

const EMPTY_ITEM = {
  name: "",
  code: "",
  unitId: "",
  category: "",
  storageArea: "",
  reorderLevel: 0,
  openingStock: "",
  openingCost: "",
  status: "active",
  itemType: "raw",
  packs: [],
  preferredSupplier: null,
};

const EMPTY_UNIT = { name: "", shortName: "", status: "active" };
const EMPTY_MOVE = {
  batchNumber: "",
  expiryDate: "",
  quantity: "",
  unitCost: "",
  reason: "",
  notes: "",
  transactionType: "adjustment",
  wasteReason: "",
  store: "main",
};

// Why stock was thrown away: the same list the Waste & reorder page logs
// against (the server checks it), so waste written off here adds up by
// reason there instead of showing as "Not given".
const WASTE_REASONS = [
  { key: "spoiled", label: "Spoiled", hint: "Went off in storage — cream turned sour" },
  { key: "expired", label: "Expired", hint: "Past its use-by date" },
  { key: "overcooked", label: "Overcooked / burnt", hint: "Burnt batch of gravy" },
  { key: "dropped", label: "Dropped / spilled", hint: "Tray dropped at the pass" },
  { key: "returned", label: "Returned by guest", hint: "Sent back — too salty" },
  { key: "over_prepped", label: "Over-prepped", hint: "Prepped for 80, served 50" },
  { key: "other", label: "Other", hint: "Say what happened" },
];

// What a stock list is actually for: is there enough left? A column of
// identical "Active" badges answered a question nobody asked.
function StockLevel({ item }) {
  if (item.stockHidden) {
    return <Chip tone="info">Being counted</Chip>;
  }

  // On the list of one outlet's store: an item that store has never stocked
  // is not missing from it.
  if (item.keptHere === false) {
    return (
      <Chip tone="neutral" title="This store has never held this item. + In adds its first stock here.">
        Not kept here
      </Chip>
    );
  }

  if (item.currentStock < 0) {
    return (
      <Chip tone="danger" title="More went out than the books show came in: count it.">
        Below zero · count it
      </Chip>
    );
  }

  if (item.currentStock <= 0) {
    return <Chip tone="danger">Out of stock</Chip>;
  }

  if (item.isLow) {
    const short = Math.round((item.reorderLevel - item.currentStock) * 100) / 100;

    // One badge and one short line beside it ("Low · 4 kg short"), so a row
    // stays one line high and a screen holds a useful number of items.
    return (
      <Chip tone="warning" title={short > 0 ? `${qty(short, item.unitShortName)} below the reorder level` : undefined}>
        {short > 0 ? `Low · ${qty(short, item.unitShortName)} short` : "Low"}
      </Chip>
    );
  }

  return <Chip tone="success">In stock</Chip>;
}

export default function InventoryItemsPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const canManage = hasPermission("inventory.manage");
  const [tab, setTab] = useQueryFilter("tab", "items");

  const [items, setItems] = useState([]);
  const [units, setUnits] = useState([]);
  const [stores, setStores] = useState([]);
  const [currency, setCurrency] = useState("₹");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useQueryFilter("category");
  const [area, setArea] = useQueryFilter("area");
  // A flag in the address bar, so "3 items are low" on the dashboard opens
  // the list already showing only those three.
  const [lowOnly, setLowOnly] = useQueryFlag("low");
  // Items taken out of use stay off the list (and out of every count above
  // it) until someone asks for them.
  const [showRetired, setShowRetired] = useQueryFlag("retired");
  // For someone tied to one outlet: the items their store keeps, unless they
  // ask for every item the restaurant buys (or search for one by name).
  const [everyItem, setEveryItem] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Active suppliers for "Usually ordered from" on the item form.
  const canSeeSuppliers = hasPermission("suppliers.view");
  const [suppliers, setSuppliers] = useState([]);
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_ITEM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const [importOpen, setImportOpen] = useState(false);
  const [unitsOpen, setUnitsOpen] = useState(false);
  // ?stores=true (from Transfers: "Set up a second store") opens the Stores
  // dialog as the page arrives.
  const [storesAsked, setStoresAsked] = useQueryFlag("stores");
  const [storesOpen, setStoresOpenState] = useState(storesAsked);
  const setStoresOpen = (open) => {
    setStoresOpenState(open);

    if (!open && storesAsked) {
      setStoresAsked(false);
    }
  };
  const [unitForm, setUnitForm] = useState(EMPTY_UNIT);
  const [editingUnitId, setEditingUnitId] = useState(null);

  const [movement, setMovement] = useState(null); // { item, direction: "in" | "out" }
  const [moveForm, setMoveForm] = useState(EMPTY_MOVE);

  // Moving stock between the main store and an outlet.
  const [transfer, setTransfer] = useState(null);
  const [balances, setBalances] = useState([]);
  const [transferForm, setTransferForm] = useState({
    fromOutletId: "",
    toOutletId: "",
    quantity: "",
    reason: "",
  });

  // The search the rows on screen answer, set with them, so a list for one
  // store does not flash the whole item list while a search is on its way.
  const [loadedSearch, setLoadedSearch] = useState("");

  const load = useCallback(() => {
    const term = search.trim();

    return listInventoryItems({ search: term || undefined, lowOnly: lowOnly || undefined })
      .then((rows) => {
        setItems(rows);
        setLoadedSearch(term);
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [search, lowOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const loadUnits = useCallback(
    () =>
      listUnits()
        .then(setUnits)
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  const loadStores = useCallback(
    () =>
      listStores()
        .then(setStores)
        .catch(() => setStores([])),
    []
  );

  useEffect(() => {
    loadUnits();
    loadStores();
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);

    if (canSeeSuppliers) {
      listSuppliers()
        .then((rows) => setSuppliers(rows.filter((row) => row.status === "active")))
        .catch(() => setSuppliers([]));
    }
  }, [loadUnits, loadStores, canSeeSuppliers]);

  // Places that hold stock: the main store and outlets with a shelf of their own.
  const holdingStores = stores.filter((store) => !store.outletId || store.ownStore);
  // Where stock may be put: a closed outlet takes nothing new (the server
  // refuses it), though its stock can still be taken off or moved back.
  const openStores = holdingStores.filter((store) => !store.outletId || store.status === "active");
  const storeLabel = (store) => (store.outletId && store.status !== "active" ? `${store.name} (closed)` : store.name);
  // Stock out as wastage asks why, as the Waste & reorder log does.
  const wasteOut = Boolean(movement) && movement.direction === "out" && moveForm.transactionType === "wastage";
  // Open outlets stock can be sent to. Read from the stores list (stock
  // permission) rather than the outlets screen's own list, which the people
  // who count stock are not allowed to open.
  const outlets = stores
    .filter((store) => store.outletId && store.status === "active")
    .map((store) => ({ id: store.outletId, name: store.name }));
  const multiStore = holdingStores.length > 1;

  // Where a hand-entered movement lands by default: the outlet being worked
  // in, when it keeps its own stock.
  const defaultStore = () => {
    const current = outletStorage.get();
    const store = openStores.find((row) => String(row.outletId) === String(current));

    return store ? String(store.outletId) : "main";
  };

  const categories = useMemo(
    () => [...new Set(items.map((item) => item.category).filter(Boolean))].sort(),
    [items]
  );
  const areas = useMemo(
    () => [...new Set(items.map((item) => item.storageArea).filter(Boolean))].sort(),
    [items]
  );

  const openTransfer = async (item) => {
    setFormError("");
    setTransferForm({ fromOutletId: "", toOutletId: "", quantity: "", reason: "" });

    try {
      setBalances(await getStockBalances(item.id));
      setTransfer(item);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const saveTransfer = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      await transferStock({
        inventoryItemId: transfer.id,
        fromOutletId: transferForm.fromOutletId ? Number(transferForm.fromOutletId) : null,
        toOutletId: transferForm.toOutletId ? Number(transferForm.toOutletId) : null,
        quantity: Number(transferForm.quantity),
        reason: transferForm.reason || null,
      });

      setTransfer(null);
      setSuccess(`Stock moved for ${transfer.name}`);
      load();
      loadStores();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const changePack = (index, field, value) =>
    setForm({
      ...form,
      packs: form.packs.map((pack, position) => (position === index ? { ...pack, [field]: value } : pack)),
    });

  const saveItem = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      name: form.name,
      code: form.code || null,
      unitId: Number(form.unitId),
      category: form.category || null,
      storageArea: form.storageArea || null,
      reorderLevel: Number(form.reorderLevel || 0),
      status: form.status,
      itemType: form.itemType,
      // Only from someone who sees the supplier field; others leave it as it is.
      ...(canSeeSuppliers ? { preferredSupplierId: form.preferredSupplier ? Number(form.preferredSupplier.id) : null } : {}),
      packs: form.packs
        .filter((pack) => pack.name.trim() && Number(pack.size) > 0)
        .map((pack) => ({ ...(pack.id ? { id: pack.id } : {}), name: pack.name.trim(), size: Number(pack.size) })),
    };

    try {
      if (editing.id) {
        await updateInventoryItem(editing.id, payload);
        setSuccess("Item updated");
      } else {
        await createInventoryItem({
          ...payload,
          openingStock: Number(form.openingStock || 0),
          openingCost: form.openingCost ? Number(form.openingCost) : null,
        });
        setSuccess("Item created");
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveUnit = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      if (editingUnitId) {
        await updateUnit(editingUnitId, unitForm);
      } else {
        await createUnit(unitForm);
      }

      setUnitForm(EMPTY_UNIT);
      setEditingUnitId(null);
      loadUnits();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const removeUnit = async (unit) => {
    setFormError("");

    try {
      await deleteUnit(unit.id);
      loadUnits();
    } catch (err) {
      setFormError(getErrorMessage(err));
    }
  };

  const toggleStore = async (store) => {
    setFormError("");

    try {
      const result = await setOutletOwnStore(store.outletId, !store.ownStore);
      setSuccess(result.message);
      loadStores();
    } catch (err) {
      setFormError(getErrorMessage(err));
    }
  };

  // Stock in and stock out share one dialog; the direction decides which API is called.
  const saveMovement = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      inventoryItemId: movement.item.id,
      quantity: Number(moveForm.quantity),
      reason: moveForm.reason || null,
      notes: moveForm.notes || null,
      outletId: moveForm.store === "main" ? null : Number(moveForm.store),
    };

    const wastage = movement.direction === "out" && moveForm.transactionType === "wastage";

    try {
      if (movement.direction === "in") {
        await stockIn({ ...payload, batchNumber: moveForm.batchNumber, expiryDate: moveForm.expiryDate, unitCost: moveForm.unitCost ? Number(moveForm.unitCost) : null });
        setSuccess(`Stock added to ${movement.item.name}`);
      } else {
        // Over the write-off limit (Stock & purchasing settings) a manager's
        // PIN is asked for, tied to this item, quantity and value.
        await withApproval(
          (headers) =>
            stockOut(
              {
                ...payload,
                transactionType: moveForm.transactionType,
                ...(wastage ? { wasteReason: moveForm.wasteReason } : {}),
              },
              headers
            ),
          `Take ${qty(payload.quantity, movement.item.unitShortName)} of ${movement.item.name} out of stock`
        );
        const why = WASTE_REASONS.find((reason) => reason.key === moveForm.wasteReason);

        setSuccess(
          wastage && why
            ? `${movement.item.name} written off as ${why.label.toLowerCase()} — it shows on Waste & reorder`
            : `Stock removed from ${movement.item.name}`
        );
      }

      setMovement(null);
      load();
    } catch (err) {
      if (!err.approvalCancelled) {
        setFormError(getErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteInventoryItem(deleting.id);
      setDeleting(null);
      setSuccess("Item deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  // The server marks each item with keptHere when the list is one store's
  // (someone tied to one outlet): its figures are that store's.
  const oneStore = items.some((item) => item.keptHere !== undefined);
  const storeName = oneStore && stores.length === 1 ? stores[0].name : "your store";
  const searching = loadedSearch !== "";
  // What the Items tab counts: the items this store keeps, or — searching,
  // or asking for every item — everything the list holds.
  const keptCount = oneStore && !searching && !everyItem ? items.filter((item) => item.keptHere).length : items.length;

  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (!oneStore || everyItem || searching || item.keptHere) &&
          (showRetired || item.status === "active") &&
          (!category || item.category === category) &&
          (!area || (area === "none" ? !item.storageArea : item.storageArea === area))
      ),
    [items, category, area, oneStore, everyItem, searching, showRetired]
  );

  const shown = visible.filter((item) => !item.stockHidden);
  const hiddenCount = visible.length - shown.length;
  const retiredCount = items.filter((item) => item.status !== "active").length;
  // Running low and out of stock are about what to buy: a retired item is
  // never one, even with "Show retired items" ticked.
  const lowCount = shown.filter((item) => item.status === "active" && item.isLow && item.currentStock > 0).length;
  const outCount = shown.filter(
    (item) => item.keptHere !== false && item.currentStock <= 0 && item.status === "active"
  ).length;

  // What the shelves are worth, which is the question an owner asks about a
  // stock list and which this page could not answer.
  const stockValue = shown.reduce(
    (sum, item) => sum + (item.currentStock <= 0 ? 0 : (item.averageCost ?? item.lastCost ?? 0) * item.currentStock),
    0
  );

  // The stock list. The columns you would actually sort by are the name,
  // what is left, its worth and how short it is (Stock level sorts the most
  // urgent first: how far below the reorder level).
  const costOf = (item) => item.averageCost ?? item.lastCost ?? null;
  const itemColumns = [
    {
      key: "name",
      header: "Item",
      value: (item) => item.name,
      mobile: "title",
      pin: true,
      render: (item) => (
        <>
          <strong>{item.name}</strong>
          {/* Active is the norm, so only a retired item says so. */}
          {item.status !== "active" && <span className="badge badge-neutral stk-retired-tag">Retired</span>}
          {item.code && <div className="muted small mono">{item.code}</div>}
          {item.packs.length > 0 && (
            <div>
              {item.packs.map((pack) => (
                <span key={pack.id} className="stk-pack" title="Bought in this pack">
                  {pack.name} = {qty(pack.size, item.unitShortName)}
                </span>
              ))}
            </div>
          )}
        </>
      ),
    },
    {
      key: "category",
      // The storage area reads under the category.
      header: "Category",
      width: 128,
      value: (item) => item.category,
      csv: (item) => [item.category, item.storageArea].filter(Boolean).join(" · "),
      // On a phone a card with no category or area leaves the line out.
      mobile: "subtitle",
      render: (item, ctx) =>
        item.category || item.storageArea ? (
          <span className="muted small">
            {item.category || "—"}
            {item.storageArea && <div className="muted small">{item.storageArea}</div>}
          </span>
        ) : ctx.card ? null : (
          <span className="muted">—</span>
        ),
    },
    {
      key: "stock",
      header: "In stock",
      type: "number",
      value: (item) => (item.stockHidden ? null : item.currentStock),
      mobile: "show",
      render: (item) =>
        item.stockHidden ? (
          <span className="muted" title="Hidden while the item is on a blind count">
            —
          </span>
        ) : (
          <strong className={item.keptHere === false ? "muted" : item.currentStock <= 0 ? "text-danger" : ""}>
            {qty(item.currentStock, item.unitShortName)}
          </strong>
        ),
    },
    {
      key: "reorder",
      header: "Reorder at",
      type: "number",
      value: (item) => item.reorderLevel,
      mobile: "hide",
      render: (item) => qty(item.reorderLevel, item.unitShortName),
    },
    {
      key: "cost",
      header: "Average cost",
      type: "money",
      value: costOf,
      mobile: "show",
      render: (item) => (costOf(item) == null ? <span className="muted">—</span> : <span className="small">{`${unitMoney(costOf(item), currency)}/${item.unitShortName}`}</span>),
    },
    {
      key: "value",
      header: "Value",
      type: "money",
      value: (item) => (item.lastCost === null || item.stockHidden || item.currentStock <= 0 ? null : costOf(item) * item.currentStock),
      total: "sum",
      mobile: "hide",
    },
    {
      key: "level",
      header: "Stock level",
      align: "left",
      width: 196,
      value: (item) => (item.stockHidden ? null : (item.currentStock ?? 0) - item.reorderLevel),
      csv: (item) =>
        item.stockHidden
          ? "Being counted"
          : item.keptHere === false
            ? "Not kept here"
            : item.currentStock <= 0
              ? "Out of stock"
              : item.isLow
                ? `Low${item.reorderLevel > item.currentStock ? ` · ${Math.round((item.reorderLevel - item.currentStock) * 1000) / 1000} ${item.unitShortName} short` : ""}`
                : "In stock",
      mobile: "show",
      render: (item) => <StockLevel item={item} />,
    },
    canManage && {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (item) => (
        <div className="row-actions">
          {/* The stock moves are the everyday work of this page,
              so they stay in reach. Editing and deleting an item
              are rare, and go behind the menu. */}
          <button
            type="button"
            className="chip-button"
            onClick={() => {
              setMoveForm({ ...EMPTY_MOVE, store: defaultStore() });
              setFormError("");
              setMovement({ item, direction: "in" });
            }}
            title={`Add stock of ${item.name}`}
          >
            <Icon name="plus" size={14} /> In
          </button>
          <button
            type="button"
            className="chip-button"
            onClick={() => {
              setMoveForm({ ...EMPTY_MOVE, store: defaultStore() });
              setFormError("");
              setMovement({ item, direction: "out" });
            }}
            title={`Take ${item.name} out of stock`}
          >
            <Icon name="minus" size={14} /> Out
          </button>

          <ActionMenu
            label={`More actions for ${item.name}`}
            items={[
              ...(outlets.length > 0 ? [{ label: "Move stock", icon: "truck", onClick: () => openTransfer(item) }] : []),
              {
                label: "Edit item",
                icon: "edit",
                onClick: () => {
                  setForm({
                    name: item.name,
                    code: item.code || "",
                    unitId: String(item.unitId),
                    category: item.category || "",
                    storageArea: item.storageArea || "",
                    reorderLevel: item.reorderLevel,
                    openingStock: "",
                    openingCost: "",
                    status: item.status,
                    itemType: item.itemType || "raw",
                    packs: item.packs.map((pack) => ({ ...pack, size: String(pack.size) })),
                    preferredSupplier: item.preferredSupplierId
                      ? { id: item.preferredSupplierId, name: item.preferredSupplierName || "Chosen supplier" }
                      : null,
                  });
                  setFormError("");
                  setEditing(item);
                },
              },
              {
                label: "Stock movements",
                icon: "history",
                onClick: () => {
                  // One item's history: the last 30 days, the dates in sight.
                  navigate(`/inventory/stock?item=${item.id}&from=${daysAgo(29)}`);
                },
              },
              { separator: true },
              {
                label: "Delete item",
                icon: "trash",
                danger: true,
                onClick: () => setDeleting(item),
              },
            ]}
          />
        </div>
      ),
    },
  ];

  const tabs = [
    {
      key: "items",
      label: "Items",
      icon: "box",
      // The items in use (retired ones are counted on their own tick box).
      count: keptCount ? count(items.filter((item) => item.status === "active" && (item.keptHere !== false || !oneStore || everyItem)).length) : null,
    },
    { key: "counts", label: "Stock counts", icon: "clipboard" },
    { key: "batches", label: "Batches & expiry", icon: "calendar" },
    { key: "production", label: "Production", icon: "box" },
    { key: "closing", label: "Closing stock", icon: "calendar" },
  ];

  const selectedUnit = units.find((unit) => String(unit.id) === String(form.unitId));

  return (
    <div className="stack stk-page">
      <PageHeader
        icon="box"
        title="Items & stock"
        description="Everything the kitchen buys and keeps: what is on the shelf, what is running low, and what it is worth."
        action={
          <div className="stk-actions">
            {multiStore || outlets.length > 0 ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setStoresOpen(true);
                  setFormError("");
                }}
              >
                <Icon name="store" size={16} /> Stores
              </button>
            ) : null}
            {canManage && (
              <>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setUnitsOpen(true);
                    setFormError("");
                  }}
                >
                  <Icon name="scale" size={16} /> Units
                </button>
                <button type="button" className="button button-secondary" onClick={() => setImportOpen(true)}>
                  <Icon name="upload" size={16} /> Import
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setForm({ ...EMPTY_ITEM, unitId: units[0] ? String(units[0].id) : "" });
                    setFormError("");
                    setEditing({});
                  }}
                  disabled={units.length === 0}
                >
                  <Icon name="plus" size={16} /> Add item
                </button>
              </>
            )}
          </div>
        }
      />

      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Stock sections" />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {tab === "counts" && <StockCountPanel stores={stores} currency={currency} />}

      {tab === "batches" && <BatchStockPanel stores={stores} currency={currency} />}
      {tab === "production" && (
        <ProductionPanel
          items={items}
          currency={currency}
          canManage={canManage}
          onAddPrepared={
            units.length > 0
              ? () => {
                  setForm({ ...EMPTY_ITEM, itemType: "prepared", unitId: String(units[0].id) });
                  setFormError("");
                  setEditing({});
                }
              : undefined
          }
        />
      )}

      {tab === "closing" && <ClosingStockPanel stores={stores} currency={currency} />}

      {tab === "items" && (
        <>
          {units.length === 0 && !loading && (
            <div className="alert">Add a unit first (kg, litre, piece); every item needs one.</div>
          )}

          {/* Until the list arrives the tiles say so, rather than "0 items"
              and "nothing below reorder level" — false comfort on a slow line. */}
          <div className="stat-grid">
            <Tile
              icon="box"
              label="Items"
              value={loading ? "—" : count(visible.length)}
              note={
                loading
                  ? "loading…"
                  : category || area
                    ? "matching the filter"
                    : oneStore && !everyItem && !searching
                      ? `kept at ${storeName}`
                      : "on the list"
              }
            />
            <Tile
              icon="trend-down"
              label="Running low"
              value={loading ? "—" : count(lowCount)}
              tone={!loading && lowCount > 0 ? "warning" : undefined}
              note={loading ? "loading…" : lowCount > 0 ? "at or below reorder level" : "nothing below reorder level"}
            />
            <Tile
              icon="alert-circle"
              label="Out of stock"
              value={loading ? "—" : count(outCount)}
              tone={!loading && outCount > 0 ? "danger" : undefined}
              note={loading ? "loading…" : outCount > 0 ? "count them or order now" : "every active item in stock"}
            />
            {/* Whole rupees in the tile; the rows below keep the paise. */}
            <StatTile
              icon="wallet"
              tone="primary"
              label="On the shelves"
              money={stockValue}
              currency={currency}
              loading={loading}
              note={loading ? "loading…" : oneStore ? `at ${storeName}` : "at average cost"}
            />
          </div>

          {hiddenCount > 0 && (
            <div className="alert alert-info">
              <span>
                {hiddenCount === 1 ? "1 item is" : `${hiddenCount} items are`} on a blind stock count, so the figures
                are hidden until a manager posts it. Count what is on the shelf.
              </span>
            </div>
          )}

          {lowCount + outCount > 0 && (
            <div className="alert alert-notice">
              <span>
                {lowCount + outCount === 1 ? "1 item needs" : `${lowCount + outCount} items need`} ordering.{" "}
                <Link to="/inventory/insights?tab=reorder">See reorder suggestions</Link> or{" "}
                <Link to="/purchasing/orders">raise a purchase order</Link>.
              </span>
            </div>
          )}

          <SectionCard
            icon="list"
            title="Stock list"
            description={
              // Only people who can change stock have + In, − Out and the ⋯
              // menu; the others are not told about buttons they do not have.
              canManage
                ? "+ In and − Out are for stock that did not come on a supplier's bill. The ⋯ menu edits an item or shows its history."
                : "What is on the shelf, what it is worth, and how close each item is to its reorder level."
            }
            actions={<span className="stk-count">{visible.length === 1 ? "1 item" : `${count(visible.length)} items`}</span>}
            flush
          >
            <div className="stk-filterbar filters">
              <label className="field">
                <span>Search</span>
                <span className="input-with-icon">
                  <Icon name="search" size={17} className="input-icon" />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Item name or code"
                  />
                </span>
              </label>

              <div className="field">
                <SearchPicker
                  label="Category"
                  value={category || null}
                  onChange={(name) => setCategory(name || "")}
                  options={categories}
                  getKey={(name) => name}
                  getLabel={(name) => name}
                  placeholder="All categories"
                  emptyText="No category has that name"
                />
              </div>

              <label className="field">
                <span>Storage area</span>
                <select value={area} onChange={(event) => setArea(event.target.value)}>
                  <option value="">Everywhere</option>
                  {areas.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value="none">Not set</option>
                </select>
              </label>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={lowOnly}
                  onChange={(event) => setLowOnly(event.target.checked)}
                />
                <span>Low stock only</span>
              </label>

              {(retiredCount > 0 || showRetired) && (
                <label className="checkbox" title="Items set to Inactive: kept for their history, not bought any more">
                  <input
                    type="checkbox"
                    checked={showRetired}
                    onChange={(event) => setShowRetired(event.target.checked)}
                  />
                  <span>Show retired items{retiredCount > 0 ? ` (${count(retiredCount)})` : ""}</span>
                </label>
              )}

              {oneStore && (
                <label className="checkbox" title="Items this store has never held, to add the first stock of one">
                  <input
                    type="checkbox"
                    checked={everyItem}
                    onChange={(event) => setEveryItem(event.target.checked)}
                  />
                  <span>Items not kept here too</span>
                </label>
              )}
            </div>

            <DataGrid
              id="stock-items"
              caption="Stock list"
              columns={itemColumns}
              rows={visible}
              rowKey={(item) => item.id}
              loading={loading}
              empty={oneStore && !everyItem && !searching && keptCount === 0 ? `${storeName} holds no items yet.` : "No items match."}
              emptyIcon="box"
              emptyHint={
                oneStore && !everyItem && !searching && keptCount === 0
                  ? "Tick “Items not kept here too” to add the first stock of an item, or enter a supplier bill."
                  : search || category || area || lowOnly
                    ? "Clear a filter to see more."
                    : !showRetired && retiredCount > 0 && items.length > 0
                      ? "Only retired items are left — tick “Show retired items” to see them."
                    : "Add the raw materials you buy and use."
              }
              // Alphabetical to begin with, which is how someone looks for a named item.
              defaultSort={{ key: "name", direction: "asc" }}
              // The search box above asks the server; the grid does not search again.
              search={false}
              currency={currency}
              rowNoun={["item", "items"]}
              exportName="stock-items"
            />
          </SectionCard>
        </>
      )}

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : "Add item"}
          description="Something the kitchen buys and keeps on a shelf, counted in one unit."
          icon={editing.id ? "edit" : "box"}
          onClose={() => setEditing(null)}
          width={660}
        >
          <form className="form-grid" onSubmit={saveItem}>
            <ErrorMessage message={formError} />

            <p className="section-heading field-wide">What it is</p>

            <label className="field">
              <span>Name *</span>
              <input value={form.name} onChange={change("name")} required autoFocus maxLength={150} />
            </label>

            <label className="field">
              <span>Code</span>
              <input value={form.code} onChange={change("code")} maxLength={30} />
            </label>

            <label className="field">
              <span>Unit it is used in *</span>
              <select value={form.unitId} onChange={change("unitId")} required>
                {units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name} ({unit.shortName})
                  </option>
                ))}
              </select>
              <small className="muted">
                {editing.id
                  ? "Fixed once stock or a recipe uses it — add a pack below instead."
                  : "The unit recipes and counts use: ml, g, kg, piece."}
              </small>
            </label>

            <label className="field">
              <span>Reorder level</span>
              <input
                type="number"
                min="0"
                step="0.001"
                value={form.reorderLevel}
                onChange={change("reorderLevel")}
              />
              <small className="muted">Warn when stock falls to this level</small>
            </label>

            <p className="section-heading field-wide">Where it lives</p>

            <label className="field">
              <span>Category</span>
              <input
                value={form.category}
                onChange={change("category")}
                placeholder="Dairy, Vegetables, Packaging"
                list="stk-categories"
              />
              <datalist id="stk-categories">
                {categories.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>

            <label className="field">
              <span>Storage area</span>
              <input
                value={form.storageArea}
                onChange={change("storageArea")}
                placeholder="Walk-in cooler, Dry store, Freezer"
                list="stk-areas"
                maxLength={50}
              />
              <datalist id="stk-areas">
                {areas.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <small className="muted">Count sheets follow the walk through the store</small>
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>

            <label className="field">
              <span>Item type</span>
              <select value={form.itemType} onChange={change("itemType")}>
                <option value="raw">Raw / purchased</option>
                <option value="prepared">Prepared / sub-recipe</option>
              </select>
              <small className="muted">Prepared items are made in the Production tab.</small>
            </label>

            {/* Who it is ordered from: Reorder groups it under this supplier
                (otherwise under whoever it was last bought from). */}
            {canSeeSuppliers && (
              <SearchPicker
                label="Usually ordered from (optional)"
                className="field-wide"
                value={form.preferredSupplier}
                onChange={(supplier) => setForm({ ...form, preferredSupplier: supplier })}
                options={suppliers}
                getLabel={(supplier) => supplier.name}
                getDescription={(supplier) => supplier.mobile || ""}
                placeholder="Whoever it was last bought from"
                emptyText="No active supplier by that name"
                hint="Reorder suggestions for this item go to this supplier."
              />
            )}

            <fieldset className="field field-wide stk-lines stk-packs">
              <legend className="section-heading">Packs it is bought in</legend>
              <p className="muted small">
                A supplier sells oil by the 15 L tin and eggs by the tray: add the pack once and orders,
                bills and counts can use it — stock stays in {selectedUnit ? selectedUnit.shortName : "the item's unit"}.
              </p>
              {form.packs.length > 0 && (
                <DataGrid
                  variant="editor"
                  caption="Packs it is bought in"
                  cardsBelow={400}
                  rowNoun={["pack", "packs"]}
                  rows={form.packs}
                  rowKey={(pack) => pack.id || pack.key}
                  columns={[
                    {
                      key: "name",
                      header: "Pack name",
                      value: (pack) => pack.name,
                      mobile: "title",
                      render: (pack, ctx) => (
                        <input
                          value={pack.name}
                          onChange={(event) => changePack(ctx.index, "name", event.target.value)}
                          placeholder="Tin, Tray, Crate"
                          maxLength={40}
                          aria-label={`Pack name, line ${ctx.serial}`}
                        />
                      ),
                    },
                    {
                      key: "size",
                      header: `Holds (${selectedUnit ? selectedUnit.shortName : "units"})`,
                      type: "number",
                      value: (pack) => Number(pack.size) || 0,
                      render: (pack, ctx) => (
                        <input
                          type="number"
                          min="0.0001"
                          step="0.0001"
                          value={pack.size}
                          onChange={(event) => changePack(ctx.index, "size", event.target.value)}
                          aria-label={`How much one pack holds, line ${ctx.serial}`}
                        />
                      ),
                    },
                    {
                      key: "remove",
                      header: "",
                      label: "Remove",
                      type: "actions",
                      render: (pack, ctx) => (
                        <button
                          type="button"
                          className="stk-remove"
                          aria-label={`Remove ${pack.name || "pack"}`}
                          onClick={() => setForm({ ...form, packs: form.packs.filter((unused, i) => i !== ctx.index) })}
                        >
                          <Icon name="x" size={16} />
                        </button>
                      ),
                    },
                  ]}
                />
              )}
              <div>
                <button
                  type="button"
                  className="button button-secondary button-sm"
                  onClick={() => setForm({ ...form, packs: [...form.packs, { key: `new-${Date.now()}-${form.packs.length}`, name: "", size: "" }] })}
                >
                  <Icon name="plus" size={15} /> Add a pack
                </button>
              </div>
            </fieldset>

            {!editing.id && (
              <>
                <p className="section-heading field-wide">What is on the shelf today</p>

                <label className="field">
                  <span>Opening stock</span>
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    value={form.openingStock}
                    onChange={change("openingStock")}
                    placeholder="0"
                  />
                </label>

                <label className="field">
                  <span>Cost per unit ({currency})</span>
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={form.openingCost}
                    onChange={change("openingCost")}
                  />
                </label>
              </>
            )}

            {editing.id && (
              <p className="muted small field-wide">
                Stock changes through purchase bills, counts and stock in / out, so every unit has a record.
              </p>
            )}

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {movement && (
        <Modal
          title={`${movement.direction === "in" ? "Stock in" : "Stock out"} — ${movement.item.name}`}
          description={
            movement.direction === "in"
              ? "Add stock that did not come on a supplier's bill."
              : "Take stock off the shelf: wastage, an adjustment, or issued to the kitchen."
          }
          icon={movement.direction === "in" ? "plus" : "minus"}
          onClose={() => setMovement(null)}
          width={520}
        >
          <form className="form-grid stk-scope" onSubmit={saveMovement}>
            <ErrorMessage message={formError} />

            <p className="stk-now field-wide">
              <span className="muted">In stock now</span>
              <strong>{qty(movement.item.currentStock, movement.item.unitShortName)}</strong>
            </p>

            {/* The day this movement is filed under; amber when the open
                business day is an old one still left open. */}
            {hasPermission("business_day.view") && (
              <div className="field-wide">
                <BusinessDateChip />
              </div>
            )}

            {movement.direction === "in" && (
              <div className="alert alert-info field-wide">
                <span>
                  A delivery from a supplier goes in as a{" "}
                  <Link to="/purchasing/orders?tab=bills">purchase bill</Link>, so the supplier is owed for it
                  and it shows in the purchase register. Use this for anything else — stock found, sent back
                  by the kitchen.
                </span>
              </div>
            )}

            {multiStore && (
              <label className="field">
                <span>Store</span>
                <select
                  value={moveForm.store}
                  onChange={(event) => setMoveForm({ ...moveForm, store: event.target.value })}
                >
                  {(movement.direction === "in" ? openStores : holdingStores).map((store) => (
                    <option key={store.outletId || "main"} value={store.outletId ? String(store.outletId) : "main"}>
                      {storeLabel(store)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="field">
              <span>Quantity ({movement.item.unitShortName}) *</span>
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={moveForm.quantity}
                onChange={(event) => setMoveForm({ ...moveForm, quantity: event.target.value })}
                required
                autoFocus
              />
            </label>

            {movement.direction === "in" && <>
              <label className="field"><span>Batch / lot number</span><input maxLength={100} value={moveForm.batchNumber} onChange={e=>setMoveForm({...moveForm,batchNumber:e.target.value})}/></label>
              <label className="field"><span>Expiry date</span><input type="date" value={moveForm.expiryDate} onChange={e=>setMoveForm({...moveForm,expiryDate:e.target.value})}/></label>
            </>}
            {movement.direction === "in" ? (
              <label className="field">
                <span>Cost per {movement.item.unitShortName} ({currency})</span>
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={moveForm.unitCost}
                  onChange={(event) => setMoveForm({ ...moveForm, unitCost: event.target.value })}
                />
              </label>
            ) : (
              <label className="field">
                <span>Reason type</span>
                <select
                  value={moveForm.transactionType}
                  onChange={(event) =>
                    setMoveForm({ ...moveForm, transactionType: event.target.value })
                  }
                >
                  <option value="adjustment">Adjustment</option>
                  <option value="wastage">Wastage / spoilage</option>
                  <option value="consumption">Issued to the kitchen</option>
                </select>
              </label>
            )}

            {wasteOut && (
              <fieldset className="field field-wide stk-waste-why">
                <legend>Why was it thrown away? *</legend>
                <div className="stk-waste-reasons" role="radiogroup" aria-label="Why it was thrown away">
                  {WASTE_REASONS.map((option) => (
                    <button
                      type="button"
                      key={option.key}
                      role="radio"
                      aria-checked={moveForm.wasteReason === option.key}
                      className={`chip-button stk-waste-reason ${moveForm.wasteReason === option.key ? "is-on" : ""}`}
                      onClick={() => setMoveForm({ ...moveForm, wasteReason: option.key })}
                    >
                      <WasteReasonMark reason={option.key} size={14} />
                      {option.label}
                    </button>
                  ))}
                </div>
                <small className="muted">
                  The same reasons as <Link to="/inventory/insights">Waste &amp; reorder</Link>, where this entry
                  shows and adds up with the kitchen&apos;s waste log.
                </small>
              </fieldset>
            )}

            <label className="field field-wide">
              <span>{wasteOut ? (moveForm.wasteReason === "other" ? "What happened *" : "What happened") : "Reason"}</span>
              <input
                value={moveForm.reason}
                onChange={(event) => setMoveForm({ ...moveForm, reason: event.target.value })}
                required={wasteOut && moveForm.wasteReason === "other"}
                maxLength={150}
                placeholder={
                  wasteOut
                    ? (WASTE_REASONS.find((option) => option.key === moveForm.wasteReason) || {
                        hint: "Optional — helps whoever reads this next week",
                      }).hint
                    : movement.direction === "in"
                      ? "Found in the back store"
                      : "Counted short on the shelf"
                }
              />
            </label>

            <label className="field field-wide">
              <span>Notes</span>
              <textarea
                rows={2}
                value={moveForm.notes}
                onChange={(event) => setMoveForm({ ...moveForm, notes: event.target.value })}
              />
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setMovement(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className="button"
                disabled={saving || (wasteOut && !moveForm.wasteReason)}
                title={wasteOut && !moveForm.wasteReason ? "Pick why it was thrown away" : undefined}
              >
                {saving ? "Saving…" : wasteOut ? "Write off" : "Save movement"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {transfer && (
        <Modal
          title={`Move stock — ${transfer.name}`}
          description="Send stock between the main store and an outlet that keeps its own."
          icon="truck"
          onClose={() => setTransfer(null)}
          width={560}
        >
          <form className="form-grid" onSubmit={saveTransfer}>
            <ErrorMessage message={formError} />

            <div className="field-wide">
              <p className="muted small">Held right now:</p>
              <ul className="stk-balances">
                {balances.length === 0 && <li className="muted">Nothing anywhere</li>}
                {balances.map((row) => (
                  <li key={row.outletId || "main"}>
                    <span className="muted">{row.outletName}</span>
                    <strong>{qty(row.quantity, transfer.unitShortName)}</strong>
                  </li>
                ))}
              </ul>
            </div>

            <label className="field">
              <span>From</span>
              <select
                value={transferForm.fromOutletId}
                onChange={(event) =>
                  setTransferForm({ ...transferForm, fromOutletId: event.target.value })
                }
              >
                <option value="">Main store</option>
                {holdingStores
                  .filter((store) => store.outletId)
                  .map((store) => (
                    <option key={store.outletId} value={store.outletId}>
                      {storeLabel(store)}
                    </option>
                  ))}
              </select>
            </label>

            <label className="field">
              <span>To</span>
              <select
                value={transferForm.toOutletId}
                onChange={(event) =>
                  setTransferForm({ ...transferForm, toOutletId: event.target.value })
                }
              >
                <option value="">Main store</option>
                {outlets.map((outlet) => (
                  <option key={outlet.id} value={outlet.id}>
                    {outlet.name}
                  </option>
                ))}
              </select>
            </label>

            {transferForm.toOutletId &&
              !holdingStores.some((store) => String(store.outletId) === String(transferForm.toOutletId)) && (
                <div className="alert alert-notice field-wide">
                  <span>
                    This outlet sells from the main store today. Moving stock there gives it a shelf of its own:
                    from then on its sales and counts use that shelf.
                  </span>
                </div>
              )}

            <label className="field">
              <span>Quantity ({transfer.unitShortName}) *</span>
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={transferForm.quantity}
                onChange={(event) =>
                  setTransferForm({ ...transferForm, quantity: event.target.value })
                }
                required
                autoFocus
              />
            </label>

            <label className="field">
              <span>Reason</span>
              <input
                value={transferForm.reason}
                onChange={(event) => setTransferForm({ ...transferForm, reason: event.target.value })}
                placeholder="Short at the branch tonight"
              />
            </label>

            <p className="muted small field-wide">
              Sending several items, or want the branch to confirm what arrived? Use a{" "}
              <Link to="/inventory/transfers">transfer note</Link> — one numbered challan for all of it. An outlet asking
              for stock raises an indent there.
            </p>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setTransfer(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Move stock"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {storesOpen && (
        <Modal
          title="Where stock is kept"
          description="The main store and every outlet, with what each holds."
          icon="store"
          onClose={() => setStoresOpen(false)}
          width={700}
        >
          <div className="stack stk-scope">
            <ErrorMessage message={formError} />
            <p className="muted small">
              An outlet either keeps its own stock — deliveries and transfers go onto its shelf and its sales
              come off it — or sells from the main store, like a counter in the same building.
            </p>
            {stores.some((store) => store.stockHidden) && (
              <div className="alert alert-info">
                <span>
                  The figures below leave out {stores[0].hiddenCount === 1 ? "1 item" : `${stores[0].hiddenCount} items`}{" "}
                  being counted blind, until a manager posts the count.
                </span>
              </div>
            )}
            {/* On a phone each store is a small card, so the worth and the
                own-stock switch are not cut off at the edge. */}
            <DataGrid
              id="stock-stores"
              caption="Where stock is kept"
              variant="compact"
              pageSize={false}
              currency={currency}
              rowNoun={["store", "stores"]}
              rows={storesWorthListing(stores)}
              rowKey={(store) => store.outletId || "main"}
              rowClassName={(store) => (store.status !== "active" ? "dg-tone-muted" : "")}
              columns={[
                {
                  key: "store",
                  header: "Store",
                  value: (store) => store.name,
                  mobile: "title",
                  render: (store) => (
                    <>
                      <strong>{store.name}</strong>
                      {store.status !== "active" && (
                        <div className="small stk-var-short">Outlet closed — move this stock back to the main store</div>
                      )}
                    </>
                  ),
                },
                { key: "items", header: "Items held", type: "number", value: (store) => store.itemsHeld, mobile: "show" },
                { key: "worth", header: "Worth", type: "money", value: (store) => store.stockValue, total: "sum", mobile: "show" },
                {
                  key: "stock",
                  header: "Stock",
                  mobile: "show",
                  value: (store) => (!store.outletId ? "main" : store.ownStore ? "own" : "shared"),
                  render: (store) =>
                    !store.outletId ? (
                      <Chip tone="success">Main store</Chip>
                    ) : canManage ? (
                      <label className="checkbox" style={{ whiteSpace: "nowrap" }}>
                        <input
                          type="checkbox"
                          checked={store.ownStore}
                          onChange={() => toggleStore(store)}
                          disabled={store.status !== "active" && !store.ownStore}
                        />
                        <span>{store.ownStore ? "Keeps its own stock" : "Sells from main store"}</span>
                      </label>
                    ) : (
                      <Chip tone={store.ownStore ? "info" : "muted"}>{store.ownStore ? "Own stock" : "Main store"}</Chip>
                    ),
                },
              ]}
            />
          </div>
        </Modal>
      )}

      {unitsOpen && (
        <Modal
          title="Units of measure"
          description="What stock is counted in: kg, litre, piece. Every item uses one."
          icon="scale"
          onClose={() => setUnitsOpen(false)}
          width={520}
        >
          <div className="stack stk-scope">
            <ErrorMessage message={formError} />

            {units.length > 0 && (
              <DataGrid
                id="stock-units"
                caption="Units of measure"
                variant="compact"
                // The dialog is narrow; cards only on a phone.
                cardsBelow={400}
                pageSize={false}
                rowNoun={["unit", "units"]}
                rows={units}
                rowKey={(unit) => unit.id}
                columns={[
                  { key: "name", header: "Name", width: 140, value: (unit) => unit.name, mobile: "title" },
                  { key: "short", header: "Short", width: 84, value: (unit) => unit.shortName, render: (unit) => <span className="mono">{unit.shortName}</span> },
                  { key: "items", header: "Items", type: "number", width: 84, value: (unit) => unit.itemCount },
                  canManage && {
                    key: "actions",
                    header: "",
                    label: "Actions",
                    type: "actions",
                    render: (unit) => (
                      <div className="row-actions">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            setUnitForm({
                              name: unit.name,
                              shortName: unit.shortName,
                              status: unit.status,
                            });
                            setEditingUnitId(unit.id);
                          }}
                        >
                          Edit
                        </button>
                        <button type="button" className="link-button danger" onClick={() => removeUnit(unit)}>
                          Delete
                        </button>
                      </div>
                    ),
                  },
                ]}
              />
            )}

            {canManage && (
              <form className="inline-form stk-unit-form" onSubmit={saveUnit}>
                <input
                  placeholder="Kilogram"
                  value={unitForm.name}
                  onChange={(event) => setUnitForm({ ...unitForm, name: event.target.value })}
                  required
                  maxLength={50}
                />
                <input
                  placeholder="kg"
                  value={unitForm.shortName}
                  onChange={(event) => setUnitForm({ ...unitForm, shortName: event.target.value })}
                  required
                  maxLength={10}
                />
                <button type="submit" className="button" disabled={saving}>
                  {editingUnitId ? "Update unit" : (
                    <>
                      <Icon name="plus" size={16} /> Add unit
                    </>
                  )}
                </button>
                {editingUnitId && (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setUnitForm(EMPTY_UNIT);
                      setEditingUnitId(null);
                    }}
                  >
                    Cancel
                  </button>
                )}
              </form>
            )}
          </div>
        </Modal>
      )}

      {importOpen && (
        <SheetImportModal
          title="Import stock items from a spreadsheet"
          description="Add new items and update existing ones — units, packs, reorder levels and opening stock — after seeing every change."
          noun="item"
          nounPlural="items"
          sampleName="stock-items-sample.csv"
          loadGuide={getStockImportGuide}
          runImport={importStockItems}
          lead="An item is found by its code, then its name. Opening stock goes in once, as an 'opening' movement at the cost given, so the average cost starts right; a batch and expiry can go with it."
          promises={[
            {
              title: "Opening stock is added once.",
              text: "An item that already has stock on the books keeps it; correct it with a stock count instead.",
            },
          ]}
          extraTiles={(check) =>
            check.opening ? (
              <StatTile
                size="sm"
                icon="box"
                tone="primary"
                label="Opening stock"
                money={check.opening.value}
                currency={currency}
                note={`${count(check.opening.items)} item${check.opening.items === 1 ? "" : "s"}`}
              />
            ) : null
          }
          onClose={() => setImportOpen(false)}
          onImported={(message) => {
            setImportOpen(false);
            setSuccess(message);
            load();
            loadStores();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete item"
          message={`Delete "${deleting.name}"? Items with stock history or used in recipes cannot be deleted — set them inactive instead.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
