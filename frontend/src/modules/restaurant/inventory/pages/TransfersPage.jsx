import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import ActionMenu from "../../../../components/ActionMenu";
import StatTile from "../../../../components/StatTile";
import LiveValue from "../../../../components/LiveValue";
import SuccessCheck from "../../../../components/SuccessCheck";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import "../styles/stock-pro.css";
import useAuth from "../../../../hooks/useAuth";
import useShake from "../../../../hooks/useShake";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import {
  cancelTransfer,
  closeIndent,
  createIndent,
  fulfilIndent,
  getIndent,
  getStockSettings,
  getTransfer,
  listIndents,
  listInventoryItems,
  listStores,
  listTransfers,
  receiveTransfer,
  sendTransfer,
  withdrawIndent,
} from "../services/inventory.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { monthStart, today } from "../../../../services/dates";
import { count, money, moneyExact } from "../../../../services/format";
import { Chip, ReasonDialog, Tabs } from "./stockUi";
import { niceDate, qty } from "./stockFormat";
import { printTransfer } from "./transferDocument";
import "../../../../styles/stock.css";
import "../../../../styles/backoffice-sweep.css";

// Stock moving between a restaurant's own stores (sweep SW-B-11).
//
// A transfer note carries many items from one store to another on one
// numbered challan, valued at cost. With "the receiving store confirms"
// switched on (Stock & purchasing settings) the note travels "in transit":
// the stock has left the sender and lands at the receiver only when they
// count what came off the van; anything short or damaged is written off
// there with a reason. An indent is an outlet asking for stock; the store
// asked sends it in one go or in parts, and both sides see where it stands.

const TRANSFER_STATUS = {
  in_transit: { label: "In transit", tone: "warning" },
  received: { label: "Received", tone: "success" },
  cancelled: { label: "Called back", tone: "muted" },
};

const INDENT_STATUS = {
  requested: { label: "Asked for", tone: "info" },
  part_sent: { label: "Part sent", tone: "warning" },
  sent: { label: "Sent", tone: "success" },
  closed: { label: "Closed", tone: "violet" },
  cancelled: { label: "Withdrawn", tone: "muted" },
};

const SHORT_REASONS = [
  { value: "short", label: "Short (did not come)" },
  { value: "damaged", label: "Damaged" },
  { value: "spoiled", label: "Spoiled" },
];

const storeKey = (outletId) => (outletId ? String(outletId) : "main");
const round3 = (value) => Math.round(Number(value || 0) * 1000) / 1000;

const blankLine = () => ({ key: Math.random().toString(36).slice(2), itemId: "", quantity: "" });

// Lines of items and quantities, for a note or an indent.
function LineRows({ lines, setLines, items, stockLabel }) {
  const update = (key, field, value) => setLines(lines.map((line) => (line.key === key ? { ...line, [field]: value } : line)));
  const used = new Set(lines.map((line) => String(line.itemId)));

  return (
    <div className="bo-lines">
      {lines.map((line, index) => {
        const item = items.find((entry) => String(entry.id) === String(line.itemId));

        return (
          <div className="bo-line motion-item" key={line.key}>
            <label className="field">
              <span>{index === 0 ? "Item" : <span className="sr-only">Item</span>}</span>
              <select value={line.itemId} onChange={(event) => update(line.key, "itemId", event.target.value)}>
                <option value="">Pick an item…</option>
                {items
                  .filter((entry) => String(entry.id) === String(line.itemId) || !used.has(String(entry.id)))
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field bo-line-qty">
              <span>{index === 0 ? `Quantity${item ? ` (${item.unitShortName})` : ""}` : <span className="sr-only">Quantity</span>}</span>
              <input
                type="number"
                min="0"
                step="0.001"
                inputMode="decimal"
                value={line.quantity}
                onChange={(event) => update(line.key, "quantity", event.target.value)}
                placeholder="0"
              />
            </label>
            <span className="bo-line-note muted small">{item && stockLabel ? stockLabel(item) : ""}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Remove this line"
              onClick={() => setLines(lines.length > 1 ? lines.filter((entry) => entry.key !== line.key) : [blankLine()])}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        );
      })}
      <button type="button" className="link-button bo-add-line" onClick={() => setLines([...lines, blankLine()])}>
        <Icon name="plus" size={15} /> Add another item
      </button>
    </div>
  );
}

export default function TransfersPage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission("inventory.manage");
  const canIndent = canManage || hasPermission("inventory.indent");
  const pinned = Boolean(user && user.outletId);

  const [tab, setTabParam] = useQueryFilter("tab", "notes");
  const [openId] = useQueryFilter("open");
  // The lists open on this month's notes and indents with the dates in sight;
  // a status ("In transit", "Asked for") looks across every date instead, so
  // a note still on the road from last month is never hidden by the dates.
  const [statusFilter, setStatusFilter] = useQueryFilter("status");
  const [fromParam, setFrom] = useQueryFilter("from");
  const [toParam, setTo] = useQueryFilter("to");
  const acrossDays = Boolean(statusFilter);
  const from = fromParam || (acrossDays ? "" : monthStart());
  const to = toParam || (acrossDays ? "" : today());
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  const [version, setVersion] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  // What is still pending whatever its date: notes on the road, indents
  // waiting. The figures and tab counts come from these.
  const [pending, setPending] = useState(null);
  const [transfers, setTransfers] = useState(null);
  const [indents, setIndents] = useState(null);
  const [stores, setStores] = useState([]);
  // Whether the stores list has arrived, so a one-store kitchen is not shown
  // the "set up a second store" card for a moment on every visit.
  const [storesLoaded, setStoresLoaded] = useState(false);
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState(null);
  const [profile, setProfile] = useState({ gstNumber: null, currency: "₹" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [celebrate, setCelebrate] = useState(null);

  const [viewing, setViewing] = useState(null);
  const [composing, setComposing] = useState(null); // { from, to, lines, vehicle, notes }
  const [receiving, setReceiving] = useState(null); // { transfer, lines, note }
  const [calling, setCalling] = useState(null);
  const [indentView, setIndentView] = useState(null);
  const [asking, setAsking] = useState(null); // { outlet, supply, neededBy, notes, lines }
  const [sending, setSending] = useState(null); // { indent, lines, vehicle }
  const [closing, setClosing] = useState(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [formRef, shake] = useShake();

  const loadPending = useCallback(() => {
    Promise.all([listTransfers({ status: "in_transit", limit: 500 }), listIndents({ status: "requested,part_sent", limit: 500 })])
      .then(([transferList, indentList]) => setPending({ transfers: transferList.items, indents: indentList.items }))
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  // One page of the open tab, from the server.
  useEffect(() => {
    const params = {
      status: statusFilter || undefined,
      from: from || undefined,
      to: to || undefined,
      limit: paging.pageSize,
      offset: (paging.page - 1) * paging.pageSize,
    };
    const request = tab === "indents" ? listIndents(params) : listTransfers(params);

    request
      .then((data) => {
        if (tab === "indents") {
          setIndents(data);
        } else {
          setTransfers(data);
        }

        setListError("");
      })
      .catch((err) => setListError(getErrorMessage(err)))
      .finally(() => setListLoading(false));
  }, [tab, statusFilter, from, to, paging, version]);

  // After a note is sent, received or called back: the figures and the page.
  const load = () => {
    loadPending();
    setListLoading(true);
    setVersion((value) => value + 1);
  };

  // Another tab, another set of statuses: back to page 1 with none picked.
  const setTab = (next) => {
    if (next === tab) {
      return;
    }

    setListLoading(true);
    setStatusFilter("");
    setPaging((current) => ({ ...current, page: 1 }));
    setTabParam(next);
  };

  const changeFilter = (apply) => {
    setListLoading(true);
    setPaging((current) => ({ ...current, page: 1 }));
    apply();
  };

  useEffect(() => {
    loadPending();
    listStores()
      .then(setStores)
      .catch(() => setStores([]))
      .finally(() => setStoresLoaded(true));
    listInventoryItems({})
      .then((rows) => setItems(rows.filter((row) => row.status === "active")))
      .catch(() => setItems([]));
    getStockSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
    getSettings()
      .then((data) => setProfile({ gstNumber: data.gstNumber || null, currency: data.currencySymbol || "₹" }))
      .catch(() => undefined);
  }, [loadPending]);

  // A note named in the address (the bell's link): open it.
  useEffect(() => {
    if (!openId) {
      return;
    }

    getTransfer(openId)
      .then(setViewing)
      .catch(() => undefined);
  }, [openId]);

  const currency = profile.currency;

  // Stores stock can be sent from (the main store, outlets with their own
  // shelf) and to (any open outlet, and the main store). Someone tied to an
  // outlet works from their own store, and can send back to the main store.
  const holding = stores.filter((store) => !store.outletId || store.ownStore);
  const destinations = useMemo(() => {
    const list = stores.filter((store) => !store.outletId || (store.status === "active" && store.ownStore));

    if (pinned && !list.some((store) => !store.outletId)) {
      list.push({ outletId: null, name: "Main store", ownStore: true, status: "active" });
    }

    return list;
  }, [stores, pinned]);
  const myStore = pinned && holding.length === 1 ? holding[0] : null;
  const outletStores = stores.filter((store) => store.outletId && store.ownStore && store.status === "active");

  const twoStep = Boolean(settings && settings.transferReceiptRequired);
  const transferItems = (transfers && transfers.items) || [];
  const indentItems = (indents && indents.items) || [];
  const inTransit = pending ? pending.transfers : [];
  const toReceive = inTransit.filter((row) => !myStore || storeKey(row.toOutletId) === storeKey(myStore.outletId));
  const openIndents = pending ? pending.indents : [];
  const indentsToSend = openIndents.filter((row) => !myStore || storeKey(row.supplyOutletId) === storeKey(myStore.outletId));
  const transitValue = inTransit.reduce((sum, row) => sum + row.sentValue, 0);
  // One store and nothing on the move: there is nothing to transfer between,
  // so the page is one card saying how to get a second store, not empty tiles
  // and an empty list.
  const oneStoreOnly =
    storesLoaded && !pinned && destinations.length < 2 && pending !== null && inTransit.length === 0 && openIndents.length === 0;
  const activeOutlets = stores.filter((store) => store.outletId && store.status === "active");

  const note = (message) => {
    setSuccess(message);
    setError("");
  };

  const fail = (err) => {
    setFormError(getErrorMessage(err));
    shake();
  };

  const showError = (err) => setError(getErrorMessage(err));

  const linesFrom = (lines) =>
    lines
      .filter((line) => line.itemId && Number(line.quantity) > 0)
      .map((line) => ({ inventoryItemId: Number(line.itemId), quantity: Number(line.quantity) }));

  // --- a new note
  const startNote = () => {
    setFormError("");
    const from = myStore ? storeKey(myStore.outletId) : "main";
    const to = destinations.find((store) => storeKey(store.outletId) !== from);
    setComposing({ from, to: to ? storeKey(to.outletId) : "", lines: [blankLine()], vehicle: "", notes: "" });
  };

  const saveNote = async (event) => {
    event.preventDefault();
    const lines = linesFrom(composing.lines);

    if (lines.length === 0) {
      setFormError("Add at least one item and how much of it is going.");
      shake();
      return;
    }

    if (composing.from === composing.to) {
      setFormError("Stock has to go to a different store from the one it leaves.");
      shake();
      return;
    }

    setBusy(true);
    setFormError("");

    try {
      const result = await sendTransfer({
        fromOutletId: composing.from === "main" ? null : Number(composing.from),
        toOutletId: composing.to === "main" ? null : Number(composing.to),
        lines,
        vehicle: composing.vehicle || null,
        notes: composing.notes || null,
      });
      setComposing(null);
      setViewing(result.data);
      note(result.message);
      load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  // --- receiving
  const startReceive = (transfer) => {
    setFormError("");
    setReceiving({
      transfer,
      note: "",
      lines: transfer.lines.map((line) => ({ ...line, received: String(line.quantity), reason: "", why: "" })),
    });
  };

  // One field of one line on the "what arrived" sheet.
  const setReceivedLine = (id, field, value) =>
    setReceiving((current) => ({
      ...current,
      lines: current.lines.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry)),
    }));

  const saveReceive = async (event) => {
    event.preventDefault();
    const short = receiving.lines.find((line) => Number(line.received) < line.quantity && !line.reason);

    if (short) {
      setFormError(`${short.itemName} came short: say whether it was short, damaged or spoiled.`);
      shake();
      return;
    }

    setBusy(true);
    setFormError("");

    try {
      const result = await receiveTransfer(receiving.transfer.id, {
        note: receiving.note || null,
        lines: receiving.lines.map((line) => ({
          lineId: line.id,
          receivedQuantity: Number(line.received || 0),
          shortfallReason: Number(line.received) < line.quantity ? line.reason : null,
          shortfallNote: line.why || null,
        })),
      });
      setReceiving(null);
      setViewing(result.data);
      setCelebrate(result.data.id);
      note(result.message);
      load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  // --- indents
  const startIndent = () => {
    setFormError("");
    const outlet = myStore && myStore.outletId ? String(myStore.outletId) : outletStores[0] ? String(outletStores[0].outletId) : "";
    setAsking({ outlet, supply: "main", neededBy: "", notes: "", lines: [blankLine()] });
  };

  const saveIndent = async (event) => {
    event.preventDefault();
    const lines = linesFrom(asking.lines);

    if (!asking.outlet) {
      setFormError("Pick the outlet asking for stock.");
      shake();
      return;
    }

    if (lines.length === 0) {
      setFormError("Add at least one item and how much is needed.");
      shake();
      return;
    }

    setBusy(true);
    setFormError("");

    try {
      const result = await createIndent({
        outletId: Number(asking.outlet),
        supplyOutletId: asking.supply === "main" ? null : Number(asking.supply),
        neededBy: asking.neededBy || null,
        notes: asking.notes || null,
        lines,
      });
      setAsking(null);
      setTab("indents");
      setIndentView(result.data);
      note(result.message);
      load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const openIndent = async (row) => {
    try {
      setIndentView(await getIndent(row.id));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const startSend = (indent) => {
    setFormError("");
    setSending({
      indent,
      vehicle: "",
      lines: indent.lines
        .filter((line) => line.stillToSend > 0)
        .map((line) => ({
          ...line,
          send: String(round3(Math.max(0, Math.min(line.stillToSend, line.supplyStock)))),
        })),
    });
  };

  const saveSend = async (event) => {
    event.preventDefault();
    const lines = sending.lines
      .filter((line) => Number(line.send) > 0)
      .map((line) => ({ inventoryItemId: line.inventoryItemId, quantity: Number(line.send) }));

    if (lines.length === 0) {
      setFormError("Enter how much of at least one item is going.");
      shake();
      return;
    }

    setBusy(true);
    setFormError("");

    try {
      const result = await fulfilIndent(sending.indent.id, { lines, vehicle: sending.vehicle || null });
      setSending(null);
      setIndentView(null);
      setViewing(result.data);
      note(result.message);
      load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const tabs = [
    { key: "notes", label: "Transfer notes", short: "Notes", icon: "truck", count: inTransit.length || null },
    { key: "indents", label: "Indents", icon: "clipboard", count: openIndents.length || null },
  ];

  const loading = pending === null;

  const transferColumns = [
    {
      key: "note",
      header: "Note",
      value: (row) => row.transferNumber,
      pin: true,
      mobile: "title",
      width: 150,
      render: (row) => (
        <span className="bo-cell-stack">
          <button type="button" className="link-button mono" onClick={() => getTransfer(row.id).then(setViewing).catch(showError)}>
            {row.transferNumber}
          </button>
          <span className="muted small">
            {niceDate(row.transferDate)}
            {row.indentNumber ? ` · ${row.indentNumber}` : ""}
          </span>
        </span>
      ),
      csv: (row) => row.transferNumber,
    },
    { key: "date", header: "Date", type: "date", value: (row) => row.transferDate, defaultHidden: true },
    {
      key: "route",
      header: "From → to",
      value: (row) => `${row.fromName} → ${row.toName}`,
      render: (row) => (
        <span className="bo-cell-stack">
          <span className="bo-route">
            {row.fromName} <Icon name="arrow-right" size={14} /> {row.toName}
          </span>
          {row.vehicle && <span className="muted small">{row.vehicle}</span>}
        </span>
      ),
      mobile: "subtitle",
    },
    { key: "items", header: "Items", type: "number", value: (row) => row.lineCount, mobile: "show", width: 90 },
    {
      key: "value",
      header: "Value at cost",
      type: "money",
      exact: true,
      value: (row) => row.sentValue,
      render: (row) => (
        <span className="bo-cell-stack">
          <span className="nowrap">{moneyExact(row.sentValue, currency)}</span>
          {row.shortfallValue > 0 && <span className="small bo-short">−{moneyExact(row.shortfallValue, currency)} short</span>}
        </span>
      ),
      mobile: "show",
      width: 150,
    },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (row) => (TRANSFER_STATUS[row.status] || { label: row.status }).label,
      render: (row) => {
        const status = TRANSFER_STATUS[row.status] || { label: row.status, tone: "muted" };
        return <Chip tone={status.tone}>{status.label}</Chip>;
      },
      mobile: "show",
      width: 140,
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) => {
        const mine = !myStore || storeKey(row.toOutletId) === storeKey(myStore.outletId);

        return (
          <ActionMenu
            label={`More for ${row.transferNumber}`}
            items={[
              { label: "Open", icon: "eye", onClick: () => getTransfer(row.id).then(setViewing).catch(showError) },
              ...(row.status === "in_transit" && canManage && mine
                ? [{ label: "Confirm what arrived", icon: "check", onClick: () => getTransfer(row.id).then(startReceive).catch(showError) }]
                : []),
              ...(row.status === "in_transit" && canManage
                ? [{ label: "Call it back", icon: "undo", danger: true, onClick: () => setCalling(row) }]
                : []),
            ]}
          />
        );
      },
    },
  ];

  const indentColumns = [
    {
      key: "indent",
      header: "Indent",
      value: (row) => row.indentNumber,
      pin: true,
      mobile: "title",
      width: 150,
      render: (row) => (
        <span className="bo-cell-stack">
          <button type="button" className="link-button mono" onClick={() => openIndent(row)}>
            {row.indentNumber}
          </button>
          <span className="muted small">{niceDate(String(row.createdAt).slice(0, 10))}</span>
        </span>
      ),
      csv: (row) => row.indentNumber,
    },
    {
      key: "route",
      header: "Asked by ← from",
      value: (row) => `${row.outletName} ← ${row.supplyName}`,
      render: (row) => (
        <span className="bo-cell-stack">
          <span className="bo-route">
            {row.outletName} <Icon name="arrow-left" size={14} /> {row.supplyName}
          </span>
          {row.createdByName && <span className="muted small">{row.createdByName}</span>}
        </span>
      ),
      mobile: "subtitle",
    },
    {
      key: "needed",
      header: "Needed by",
      type: "date",
      value: (row) => row.neededBy,
      render: (row) => (row.neededBy ? niceDate(row.neededBy) : <span className="muted">—</span>),
      mobile: "show",
      width: 130,
    },
    {
      key: "items",
      header: "Items",
      type: "number",
      value: (row) => row.lineCount,
      render: (row) => {
        const open = ["requested", "part_sent"].includes(row.status);

        return (
          <span className="bo-cell-stack">
            <span>{count(row.lineCount)}</span>
            {open && row.openLines !== undefined && row.openLines < row.lineCount && (
              <span className="muted small">{count(row.openLines)} still to come</span>
            )}
          </span>
        );
      },
      mobile: "show",
      width: 110,
    },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (row) => (INDENT_STATUS[row.status] || { label: row.status }).label,
      render: (row) => {
        const status = INDENT_STATUS[row.status] || { label: row.status, tone: "muted" };
        return <Chip tone={status.tone}>{status.label}</Chip>;
      },
      mobile: "show",
      width: 130,
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) => {
        const open = ["requested", "part_sent"].includes(row.status);
        const supplier = !myStore || storeKey(row.supplyOutletId) === storeKey(myStore.outletId);

        return (
          <ActionMenu
            label={`More for ${row.indentNumber}`}
            items={[
              { label: "Open", icon: "eye", onClick: () => openIndent(row) },
              ...(open && canManage && supplier
                ? [
                    { label: "Send stock", icon: "truck", onClick: () => getIndent(row.id).then(startSend).catch(showError) },
                    { label: "Close the rest", icon: "x-circle", onClick: () => setClosing({ row, kind: "close" }) },
                  ]
                : []),
              ...(row.status === "requested" && canIndent
                ? [{ label: "Withdraw", icon: "undo", danger: true, onClick: () => setClosing({ row, kind: "withdraw" }) }]
                : []),
            ]}
          />
        );
      },
    },
  ];

  const statuses = tab === "indents" ? INDENT_STATUS : TRANSFER_STATUS;
  const listFilters = (
    <div className="stk-filterbar filters">
      <label className="field">
        <span>Status</span>
        <select value={statusFilter} onChange={(event) => changeFilter(() => setStatusFilter(event.target.value))}>
          <option value="">All</option>
          {tab === "indents" && <option value="requested,part_sent">Still waiting</option>}
          {Object.entries(statuses).map(([value, status]) => (
            <option key={value} value={value}>
              {status.label}
            </option>
          ))}
        </select>
      </label>
      <DateRangeFilter
        from={from}
        to={to}
        label={tab === "indents" ? "indent dates" : "note dates"}
        onChange={(range) =>
          changeFilter(() => {
            setFrom(range.from);
            setTo(range.to);
          })
        }
      />
    </div>
  );
  const acrossNote = acrossDays && !fromParam && !toParam && (
    <p className="muted small bo-across">
      Showing every date for this status.{" "}
      <button
        type="button"
        className="link-button"
        onClick={() =>
          changeFilter(() => {
            setFrom(monthStart());
            setTo(today());
          })
        }
      >
        This month only
      </button>
    </p>
  );
  const serverPaging = (data) => ({
    total: data ? data.total : 0,
    page: paging.page,
    pageSize: paging.pageSize,
    onChange: ({ page, pageSize }) => {
      setListLoading(true);
      setPaging({ page: pageSize !== paging.pageSize ? 1 : page, pageSize });
    },
  });

  return (
    <div className="stack stk-page bo-page">
      <PageHeader
        icon="truck"
        title="Transfers & indents"
        description="Send stock between your stores on one numbered challan, and let outlets ask the main store for what they need."
        action={
          <div className="stk-actions">
            {canIndent && (
              <button type="button" className="button button-secondary" onClick={startIndent} disabled={!pinned && outletStores.length === 0}>
                <Icon name="clipboard" size={16} /> Ask for stock
              </button>
            )}
            {canManage && (
              <button type="button" className="button" onClick={startNote} disabled={destinations.length < 2}>
                <Icon name="truck" size={16} /> New transfer note
              </button>
            )}
          </div>
        }
      />

      {oneStoreOnly ? (
        <section className="card stk-one-store">
          <EmptyState
            icon="truck"
            message="Transfers need a second store"
            hint={
              activeOutlets.length > 0
                ? `Everything is kept in the main store today. Let an outlet keep its own stock (${activeOutlets
                    .slice(0, 2)
                    .map((store) => store.name)
                    .join(", ")}${activeOutlets.length > 2 ? "…" : ""}) and you can send it stock on a numbered challan, and it can ask for stock with an indent.`
                : "Everything is kept in the main store. Add an outlet (a branch or a central kitchen) that keeps its own stock, and you can send stock between them on a numbered challan."
            }
            action={
              activeOutlets.length > 0 ? (
                <Link className="button" to="/inventory/items?stores=true">
                  <Icon name="store" size={16} /> Set up a second store
                </Link>
              ) : (
                <Link className="button" to="/restaurant/outlets">
                  <Icon name="store" size={16} /> Add an outlet
                </Link>
              )
            }
          />
        </section>
      ) : (
      <>
      <div className="stat-grid">
        <StatTile
          icon="truck"
          tone={inTransit.length ? "warning" : "neutral"}
          label="On the road"
          value={money(transitValue, currency)}
          note={inTransit.length ? `${count(inTransit.length)} note${inTransit.length === 1 ? "" : "s"} in transit` : "Nothing in transit"}
        />
        <StatTile
          icon="box"
          tone={toReceive.length ? "info" : "neutral"}
          label={myStore ? `Coming to ${myStore.name}` : "Waiting to be received"}
          value={count(toReceive.length)}
          note={twoStep ? "The receiving store confirms what arrived" : "Stock lands as soon as it is sent"}
        />
        <StatTile
          icon="clipboard"
          tone={indentsToSend.length ? "primary" : "neutral"}
          label="Indents to send"
          value={count(indentsToSend.length)}
          note={openIndents.length ? `${count(openIndents.length)} open across your stores` : "No outlet is waiting"}
        />
      </div>

      {destinations.length < 2 && !loading && (
        <div className="alert alert-notice">
          Transfers need a second store. Turn on "keeps its own stock" for an outlet under{" "}
          <Link to="/inventory/items">Items &amp; stock → Stores</Link>.
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Transfer sections" />
      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {loading ? (
        <Loading />
      ) : tab === "notes" ? (
        <SectionCard
          flush
          icon="truck"
          title="Transfer notes"
          description={
            twoStep
              ? "Stock leaves the sending store at dispatch and lands when the receiving store confirms what arrived."
              : "Stock leaves one store and lands at the other the moment a note is sent. Settings can make the receiving store confirm."
          }
        >
          {listFilters}
          {acrossNote}
          <DataGrid
            id="transfer-notes"
            caption="Transfer notes"
            columns={transferColumns}
            rows={transferItems}
            rowKey={(row) => row.id}
            loading={listLoading}
            error={listError}
            onRetry={load}
            empty={acrossDays ? "No note with this status." : "No transfer notes in these dates."}
            emptyIcon="truck"
            emptyHint="Send the evening's supplies to a branch on one note: every item, its quantity and its value at cost."
            rowClassName={(row) => (row.status === "in_transit" ? "dg-tone-warning" : row.status === "cancelled" ? "dg-tone-muted" : "")}
            server={serverPaging(transfers)}
            exportName="transfer-notes"
          />
        </SectionCard>
      ) : (
        <SectionCard
          flush
          icon="clipboard"
          title="Indents"
          description="An outlet asks for stock; the store asked sends it on a transfer note, in one go or in parts."
        >
          {listFilters}
          {acrossNote}
          <DataGrid
            id="stock-indents"
            caption="Indents"
            columns={indentColumns}
            rows={indentItems}
            rowKey={(row) => row.id}
            loading={listLoading}
            error={listError}
            onRetry={load}
            empty={acrossDays ? "No indent with this status." : "No indents in these dates."}
            emptyIcon="clipboard"
            emptyHint="A branch kitchen asks the main store for tomorrow's paneer, gravy base and rice here, instead of on the phone."
            emptyAction={
              canIndent ? (
                <button type="button" className="button button-secondary" onClick={startIndent}>
                  Ask for stock
                </button>
              ) : null
            }
            rowClassName={(row) => (["requested", "part_sent"].includes(row.status) ? "dg-tone-warning" : row.status === "cancelled" ? "dg-tone-muted" : "")}
            server={serverPaging(indents)}
            exportName="stock-indents"
          />
        </SectionCard>
      )}
      </>
      )}

      {/* ------------------------------------------------------------ a note */}
      {viewing && (
        <Modal
          title={`${viewing.transferNumber} · ${viewing.fromName} → ${viewing.toName}`}
          description={`${niceDate(viewing.transferDate)}${viewing.dispatchedByName ? ` · sent by ${viewing.dispatchedByName}` : ""}${viewing.indentNumber ? ` · against ${viewing.indentNumber}` : ""}`}
          icon="truck"
          width={760}
          onClose={() => {
            setViewing(null);
            setCelebrate(null);
          }}
          footer={
            <>
              <button type="button" className="button button-secondary" onClick={() => printTransfer(viewing, { restaurantName: user.restaurantName, gstNumber: profile.gstNumber, currency, paper: "80mm" })}>
                <Icon name="print" size={15} /> 80 mm
              </button>
              <button type="button" className="button button-secondary" onClick={() => printTransfer(viewing, { restaurantName: user.restaurantName, gstNumber: profile.gstNumber, currency, paper: "a4" })}>
                <Icon name="print" size={15} /> Print challan (A4)
              </button>
              {viewing.status === "in_transit" && canManage && (!myStore || storeKey(viewing.toOutletId) === storeKey(myStore.outletId)) && (
                <button type="button" className="button" onClick={() => startReceive(viewing)}>
                  <Icon name="check" size={15} /> Confirm what arrived
                </button>
              )}
            </>
          }
        >
          <div className="stack">
            {celebrate === viewing.id && (
              <div className="bo-celebrate">
                <SuccessCheck size={40} label="Received" />
                <span>Received at {viewing.toName}.</span>
              </div>
            )}
            <div className="bo-facts">
              <span>
                <span className="muted small">Status</span>
                <Chip tone={(TRANSFER_STATUS[viewing.status] || {}).tone}>{(TRANSFER_STATUS[viewing.status] || {}).label}</Chip>
              </span>
              <span>
                <span className="muted small">Value at cost</span>
                <strong>
                  <LiveValue value={viewing.sentValue}>{moneyExact(viewing.sentValue, currency)}</LiveValue>
                </strong>
              </span>
              {viewing.status === "received" && (
                <span>
                  <span className="muted small">Arrived</span>
                  <strong>{moneyExact(viewing.receivedValue || 0, currency)}</strong>
                </span>
              )}
              {viewing.shortfallValue > 0 && (
                <span>
                  <span className="muted small">Written off on arrival</span>
                  <strong className="bo-short">{moneyExact(viewing.shortfallValue, currency)}</strong>
                </span>
              )}
              {viewing.vehicle && (
                <span>
                  <span className="muted small">Vehicle / driver</span>
                  <strong>{viewing.vehicle}</strong>
                </span>
              )}
            </div>
            <DataGrid
              id="transfer-note-lines"
              caption={`Lines on ${viewing.transferNumber}`}
              variant="compact"
              pageSize={false}
              currency={currency}
              rowNoun={["line", "lines"]}
              rows={viewing.lines}
              rowKey={(line) => line.id}
              columns={[
                {
                  key: "item",
                  header: "Item",
                  value: (line) => line.itemName,
                  mobile: "title",
                  render: (line) => (
                    <>
                      {line.itemName}
                      {line.batches > 0 && <div className="muted small">{line.batches} batch{line.batches === 1 ? "" : "es"}, first to expire first</div>}
                    </>
                  ),
                },
                { key: "sent", header: "Sent", type: "number", value: (line) => line.quantity, render: (line) => <span className="nowrap">{qty(line.quantity, line.unit)}</span> },
                { key: "unitCost", header: "Cost / unit", type: "money", exact: true, value: (line) => line.unitCost },
                { key: "value", header: "Value", type: "money", exact: true, value: (line) => line.value, total: "sum" },
                viewing.status === "received" && {
                  key: "arrived",
                  header: "Arrived",
                  type: "number",
                  value: (line) => line.receivedQuantity,
                  render: (line) => (
                    <>
                      <span className="nowrap">{qty(line.receivedQuantity, line.unit)}</span>
                      {line.shortfallQuantity > 0 && (
                        <div className="small bo-short">
                          {qty(line.shortfallQuantity, line.unit)} {line.shortfallReason}
                          {line.shortfallNote ? ` · ${line.shortfallNote}` : ""}
                        </div>
                      )}
                    </>
                  ),
                },
              ]}
            />
            {viewing.notes && <p className="muted">Notes: {viewing.notes}</p>}
            {viewing.receiptNote && <p className="muted">On arrival: {viewing.receiptNote}</p>}
            {viewing.cancelReason && <p className="muted">Called back: {viewing.cancelReason}</p>}
          </div>
        </Modal>
      )}

      {/* ------------------------------------------------------- a new note */}
      {composing && (
        <Modal
          title="New transfer note"
          description="Every item on one numbered challan, valued at cost. Batches go first to expire first."
          icon="truck"
          width={720}
          onClose={() => !busy && setComposing(null)}
        >
          <form className="stack" onSubmit={saveNote} ref={formRef}>
            <ErrorMessage message={formError} />
            <div className="form-grid">
              <label className="field">
                <span>From</span>
                <select value={composing.from} onChange={(event) => setComposing({ ...composing, from: event.target.value })} disabled={Boolean(myStore)}>
                  {holding.map((store) => (
                    <option key={storeKey(store.outletId)} value={storeKey(store.outletId)}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>To</span>
                <select value={composing.to} onChange={(event) => setComposing({ ...composing, to: event.target.value })}>
                  {destinations
                    .filter((store) => storeKey(store.outletId) !== composing.from)
                    .map((store) => (
                      <option key={storeKey(store.outletId)} value={storeKey(store.outletId)}>
                        {store.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <LineRows
              lines={composing.lines}
              setLines={(lines) => setComposing({ ...composing, lines })}
              items={items}
              stockLabel={(item) => `${qty(item.currentStock, item.unitShortName)} on hand`}
            />
            <div className="form-grid">
              <label className="field">
                <span>Vehicle or driver (optional)</span>
                <input value={composing.vehicle} maxLength={60} onChange={(event) => setComposing({ ...composing, vehicle: event.target.value })} placeholder="TS09 EX 4521 · Raju" />
              </label>
              <label className="field">
                <span>Notes (optional)</span>
                <input value={composing.notes} maxLength={500} onChange={(event) => setComposing({ ...composing, notes: event.target.value })} placeholder="For Saturday's party order" />
              </label>
            </div>
            <p className="muted small">
              {twoStep
                ? "The stock leaves this store now and shows as in transit until the receiving store confirms what arrived."
                : "The stock leaves this store and lands at the other one as soon as the note is sent."}
            </p>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setComposing(null)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={busy}>
                {busy ? "Sending…" : "Send note"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ----------------------------------------------------- receiving */}
      {receiving && (
        <Modal
          title={`Confirm what arrived · ${receiving.transfer.transferNumber}`}
          description={`From ${receiving.transfer.fromName}. Count what came off the van; anything short or damaged is written off here with its reason.`}
          icon="check"
          width={760}
          onClose={() => !busy && setReceiving(null)}
        >
          <form className="stack" onSubmit={saveReceive} ref={formRef}>
            <ErrorMessage message={formError} />
            <DataGrid
              variant="editor"
              caption={`What arrived on ${receiving.transfer.transferNumber}`}
              rows={receiving.lines}
              rowKey={(line) => line.id}
              rowClassName={(line) => (Number(line.received) < line.quantity ? "dg-tone-warning" : "")}
              columns={[
                { key: "item", header: "Item", value: (line) => line.itemName, mobile: "title" },
                { key: "sent", header: "Sent", type: "number", value: (line) => line.quantity, render: (line) => <span className="nowrap">{qty(line.quantity, line.unit)}</span> },
                {
                  key: "arrived",
                  header: "Arrived",
                  type: "number",
                  value: (line) => Number(line.received) || 0,
                  render: (line) => (
                    <input
                      type="number"
                      min="0"
                      max={line.quantity}
                      step="0.001"
                      inputMode="decimal"
                      aria-label={`${line.itemName} arrived (${line.unit})`}
                      value={line.received}
                      onChange={(event) => setReceivedLine(line.id, "received", event.target.value)}
                    />
                  ),
                },
                {
                  key: "why",
                  header: "If short: why",
                  minWidth: 180,
                  value: (line) => line.reason,
                  render: (line) =>
                    Number(line.received) < line.quantity ? (
                      <div className="bo-why">
                        <select value={line.reason} onChange={(event) => setReceivedLine(line.id, "reason", event.target.value)} aria-label={`Why ${line.itemName} was short`}>
                          <option value="">Pick…</option>
                          {SHORT_REASONS.map((reason) => (
                            <option key={reason.value} value={reason.value}>
                              {reason.label}
                            </option>
                          ))}
                        </select>
                        <input value={line.why} maxLength={200} onChange={(event) => setReceivedLine(line.id, "why", event.target.value)} placeholder="Note (optional)" aria-label={`Note on ${line.itemName}`} />
                      </div>
                    ) : (
                      <span className="muted small">All arrived</span>
                    ),
                },
              ]}
            />
            <label className="field">
              <span>Note (optional)</span>
              <input value={receiving.note} maxLength={500} onChange={(event) => setReceiving({ ...receiving, note: event.target.value })} placeholder="Checked by the store keeper at 7:40pm" />
            </label>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setReceiving(null)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={busy}>
                {busy ? "Saving…" : "Confirm"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {calling && (
        <ReasonDialog
          title={`Call back ${calling.transferNumber}?`}
          message={`The stock goes back to ${calling.fromName} as if it never left.`}
          label="Why it is being called back"
          placeholder="Sent to the wrong branch"
          confirmLabel="Call it back"
          onCancel={() => setCalling(null)}
          onConfirm={async (reason) => {
            const result = await cancelTransfer(calling.id, reason);
            setCalling(null);
            note(result.message);
            load();
          }}
        />
      )}

      {/* --------------------------------------------------------- indents */}
      {indentView && (
        <Modal
          title={`${indentView.indentNumber} · ${indentView.outletName} asks ${indentView.supplyName}`}
          description={`${indentView.createdByName ? `Asked by ${indentView.createdByName}` : "Asked"}${indentView.neededBy ? ` · needed by ${niceDate(indentView.neededBy)}` : ""}`}
          icon="clipboard"
          width={760}
          onClose={() => setIndentView(null)}
          footer={
            ["requested", "part_sent"].includes(indentView.status) && canManage && (!myStore || storeKey(indentView.supplyOutletId) === storeKey(myStore.outletId)) ? (
              <button type="button" className="button" onClick={() => startSend(indentView)}>
                <Icon name="truck" size={15} /> Send stock
              </button>
            ) : null
          }
        >
          <div className="stack">
            <div className="bo-facts">
              <span>
                <span className="muted small">Status</span>
                <Chip tone={(INDENT_STATUS[indentView.status] || {}).tone}>{(INDENT_STATUS[indentView.status] || {}).label}</Chip>
              </span>
              {indentView.closedReason && (
                <span>
                  <span className="muted small">{indentView.status === "cancelled" ? "Withdrawn" : "Closed"}</span>
                  <strong>{indentView.closedReason}</strong>
                </span>
              )}
            </div>
            <DataGrid
              id="indent-lines"
              caption={`Lines on ${indentView.indentNumber}`}
              variant="compact"
              pageSize={false}
              rowNoun={["line", "lines"]}
              rows={indentView.lines}
              rowKey={(line) => line.id}
              columns={[
                {
                  key: "item",
                  header: "Item",
                  value: (line) => line.itemName,
                  mobile: "title",
                  render: (line) => (
                    <>
                      {line.itemName}
                      {line.note && <div className="muted small">{line.note}</div>}
                    </>
                  ),
                },
                { key: "asked", header: "Asked", type: "number", value: (line) => line.quantity, render: (line) => <span className="nowrap">{qty(line.quantity, line.unit)}</span> },
                { key: "sent", header: "Sent", type: "number", value: (line) => line.sentQuantity, render: (line) => <span className="nowrap">{qty(line.sentQuantity, line.unit)}</span> },
                { key: "arrived", header: "Arrived", type: "number", value: (line) => line.receivedQuantity, render: (line) => <span className="nowrap">{qty(line.receivedQuantity, line.unit)}</span> },
                {
                  key: "toSend",
                  header: "Still to send",
                  type: "number",
                  // Nothing left to send reads as the grid's muted dash.
                  value: (line) => (line.stillToSend > 0 ? line.stillToSend : null),
                  render: (line) => (line.stillToSend > 0 ? <span className="nowrap">{qty(line.stillToSend, line.unit)}</span> : <span className="muted">—</span>),
                },
              ]}
            />
            {indentView.transfers.length > 0 && (
              <div className="bo-chips">
                <span className="muted small">Sent on:</span>
                {indentView.transfers.map((transfer) => (
                  <button key={transfer.id} type="button" className="chip-button" onClick={() => getTransfer(transfer.id).then(setViewing).catch(showError)}>
                    {transfer.transferNumber} · {(TRANSFER_STATUS[transfer.status] || {}).label}
                  </button>
                ))}
              </div>
            )}
            {indentView.notes && <p className="muted">Notes: {indentView.notes}</p>}
          </div>
        </Modal>
      )}

      {asking && (
        <Modal
          title="Ask for stock"
          description="An indent tells the store asked what this outlet needs. They send it on a transfer note, all at once or in parts."
          icon="clipboard"
          width={720}
          onClose={() => !busy && setAsking(null)}
        >
          <form className="stack" onSubmit={saveIndent} ref={formRef}>
            <ErrorMessage message={formError} />
            <div className="form-grid">
              <label className="field">
                <span>For</span>
                <select value={asking.outlet} onChange={(event) => setAsking({ ...asking, outlet: event.target.value })} disabled={Boolean(myStore && myStore.outletId)}>
                  {(myStore && myStore.outletId ? [myStore] : outletStores).map((store) => (
                    <option key={store.outletId} value={String(store.outletId)}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Ask</span>
                <select value={asking.supply} onChange={(event) => setAsking({ ...asking, supply: event.target.value })}>
                  <option value="main">Main store</option>
                  {outletStores
                    .filter((store) => String(store.outletId) !== asking.outlet)
                    .map((store) => (
                      <option key={store.outletId} value={String(store.outletId)}>
                        {store.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Needed by (optional)</span>
                <input type="date" value={asking.neededBy} onChange={(event) => setAsking({ ...asking, neededBy: event.target.value })} />
              </label>
            </div>
            <LineRows lines={asking.lines} setLines={(lines) => setAsking({ ...asking, lines })} items={items} />
            <label className="field">
              <span>Notes (optional)</span>
              <input value={asking.notes} maxLength={500} onChange={(event) => setAsking({ ...asking, notes: event.target.value })} placeholder="For Sunday brunch" />
            </label>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setAsking(null)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={busy}>
                {busy ? "Sending…" : "Send indent"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {sending && (
        <Modal
          title={`Send stock for ${sending.indent.indentNumber}`}
          description={`To ${sending.indent.outletName}. Send what you have now; the rest stays on the indent until it is sent or closed.`}
          icon="truck"
          width={720}
          onClose={() => !busy && setSending(null)}
        >
          <form className="stack" onSubmit={saveSend} ref={formRef}>
            <ErrorMessage message={formError} />
            <DataGrid
              variant="editor"
              caption={`Stock to send for ${sending.indent.indentNumber}`}
              rows={sending.lines}
              rowKey={(line) => line.id}
              columns={[
                { key: "item", header: "Item", value: (line) => line.itemName, mobile: "title" },
                { key: "toSend", header: "Still to send", type: "number", value: (line) => line.stillToSend, render: (line) => <span className="nowrap">{qty(line.stillToSend, line.unit)}</span> },
                {
                  key: "supply",
                  header: `In ${sending.indent.supplyName}`,
                  type: "number",
                  value: (line) => line.supplyStock,
                  render: (line) => <span className={`nowrap ${line.supplyStock < line.stillToSend ? "bo-short" : ""}`}>{qty(line.supplyStock, line.unit)}</span>,
                },
                {
                  key: "send",
                  header: "Send now",
                  type: "number",
                  value: (line) => Number(line.send) || 0,
                  render: (line) => (
                    <input
                      type="number"
                      min="0"
                      max={line.stillToSend}
                      step="0.001"
                      inputMode="decimal"
                      aria-label={`${line.itemName} to send (${line.unit})`}
                      value={line.send}
                      onChange={(event) =>
                        setSending((current) => ({
                          ...current,
                          lines: current.lines.map((entry) => (entry.id === line.id ? { ...entry, send: event.target.value } : entry)),
                        }))
                      }
                    />
                  ),
                },
              ]}
            />
            <label className="field">
              <span>Vehicle or driver (optional)</span>
              <input value={sending.vehicle} maxLength={60} onChange={(event) => setSending({ ...sending, vehicle: event.target.value })} />
            </label>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setSending(null)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={busy}>
                {busy ? "Sending…" : "Send on a transfer note"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {closing && (
        <ReasonDialog
          title={closing.kind === "close" ? `Close ${closing.row.indentNumber}?` : `Withdraw ${closing.row.indentNumber}?`}
          message={
            closing.kind === "close"
              ? "What has been sent stays sent; the rest will not come. Both stores see it closed with your reason."
              : "Nothing has been sent yet, so the indent is simply taken back."
          }
          label={closing.kind === "close" ? "Why the rest is not coming" : "Why (optional)"}
          placeholder={closing.kind === "close" ? "Out of stock at the main store until Monday" : "Asked by mistake"}
          confirmLabel={closing.kind === "close" ? "Close it" : "Withdraw"}
          onCancel={() => setClosing(null)}
          onConfirm={async (reason) => {
            const result = closing.kind === "close" ? await closeIndent(closing.row.id, reason) : await withdrawIndent(closing.row.id, reason);
            setClosing(null);
            setIndentView(null);
            note(result.message);
            load();
          }}
        />
      )}
    </div>
  );
}
