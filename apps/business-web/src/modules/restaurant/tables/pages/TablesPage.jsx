import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import PageHeader from "../../../../components/PageHeader";
import LiveIndicator from "../../../../components/LiveIndicator";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatusBadge from "../../../../components/StatusBadge";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import { EmptyState, ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import {
  createTable,
  deleteTable,
  getFloorSettings,
  listAreas,
  listFloors,
  getQrSettings,
  listTables,
  markTableReady,
  regenerateTableQr,
  updateTable,
} from "../services/table.service";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import { listOutlets } from "../../../../services/outlet.service";
import { printDocument } from "../../../../services/print";
import useAuth from "../../../../hooks/useAuth";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { Link } from "react-router-dom";
import { count, dateShort, money } from "@bmp/shared/format";
import { useBillDialog } from "../../dashboard/pages/panels/useBillDialog";
import { elapsed } from "@bmp/shared/dates";
import QrSheetDialog from "./QrSheetDialog";
import CaptainPlanModal from "./CaptainPlanModal";
import { ADDRESS_WARNINGS, addressProblem, buildQrSheet, guestBase, guestOrderUrl } from "../../../../services/qrSheet";
import { customerWebOrigin } from "../../../../services/customerWeb";
import "../../../../styles/reservations.css";
import "../styles/tables.css";

const EMPTY = { floorId: "", areaId: "", outletId: "", tableNo: "", capacity: 4, status: "active" };

// What a table is actually doing, which is not the same as the status column.
//
// `table_status` says a table is occupied; it cannot say whether the guests
// just sat down, are waiting for the bill, or have paid and are collecting
// their coats. Those want different things from different people, so the
// server works the state out from the live order, its bill, the last
// settlement and the reservations book, and sends it as `floorState`.
const TABLE_STATES = [
  { key: "free", label: "Free", hint: "ready to seat" },
  { key: "running", label: "Running", hint: "ordering or eating" },
  { key: "printed", label: "Bill printed", hint: "waiting to pay" },
  { key: "paid", label: "Paid", hint: "guests still seated" },
  { key: "reserved", label: "Reserved", hint: "held for a booking" },
  { key: "cleaning", label: "Cleaning", hint: "being reset" },
  { key: "out_of_service", label: "Out of service", hint: "not in use" },
];

const STATE_LABEL = Object.fromEntries(TABLE_STATES.map((state) => [state.key, state.label]));

const tableState = (table) => table.floorState || "free";

// The state said in words on the card itself: the colour is the quick read
// from across the room, the word is what a new waiter needs.
function StateTag({ state }) {
  return (
    <span className="fp-state">
      <span className="fp-state-dot" aria-hidden="true" />
      {STATE_LABEL[state]}
    </span>
  );
}

// Guests at the table, whatever stage the bill is at.
const IN_USE = new Set(["running", "printed", "paid"]);

// The state filter. "In use" is what the dashboard's "tables busy" tile
// counts and links here with (?status=occupied); "available" is the old
// word for Free, kept so an old link still lands somewhere sensible.
const FILTERS = [
  { value: "occupied", label: "In use (any stage)" },
  ...TABLE_STATES.map((state) => ({ value: state.key, label: state.label })),
];

const matchesFilter = (table, filter) => {
  const state = tableState(table);

  if (filter === "occupied") {
    return IN_USE.has(state) || table.tableStatus === "occupied";
  }

  if (filter === "available") {
    return state === "free";
  }

  return state === filter;
};

// Why a table cannot be seated, in the words the manager used to close it.
const offReason = (table) => {
  if (table.outOfServiceReason === "floor") {
    return `${table.floorName} is closed`;
  }

  if (table.outOfServiceReason === "area") {
    return `${table.areaName} is closed`;
  }

  return "Switched off";
};

// "19:30" -> "7:30 pm", the way the host says it.
const bookingTime = (time) => {
  const [hours, minutes] = time.split(":").map(Number);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return `${twelve}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
};

// "Reserved 7:30 pm · Priya · 4" — the first name is what the host calls out.
const bookingLine = (booking) =>
  `${bookingTime(booking.startTime)} · ${booking.guestName.split(" ")[0]} · ${booking.partySize}`;

const bookingLink = (booking) => `/reservations?date=${booking.date}&booking=${booking.id}`;

// The address a table's code opens: the restaurant's guest ordering web
// address (Service settings), or else the guest site's own (services/customerWeb.js).
const qrUrlFor = (qrSettings) => (token) =>
  guestOrderUrl(guestBase(qrSettings ? qrSettings.guestWebAddress : null, customerWebOrigin()), token);

// The money line on a table with guests at it: what they have run up, what
// is left to pay once the bill is out, and how long they have been sitting.
function LiveLine({ table, now }) {
  const live = table.live;
  const state = tableState(table);
  const sitting = <span className="muted"> · {elapsed(live.placedAt, now)}</span>;

  if (state === "paid") {
    return (
      <span>
        <strong>{money(live.billTotal ?? live.orderTotal, "₹")}</strong>
        <span className="muted"> settled</span>
        {sitting}
      </span>
    );
  }

  if (state === "printed") {
    const partPaid = live.billDue !== null && live.billDue < live.billTotal;

    return (
      <span>
        <strong>{money(partPaid ? live.billDue : (live.billTotal ?? live.orderTotal), "₹")}</strong>
        <span className="muted">{partPaid ? " still due" : " to pay"}</span>
        {sitting}
      </span>
    );
  }

  // Billed for part of the order (one guest paid for their share, or the
  // starters were billed) and still eating the rest.
  const partBilled = live.billId && live.unbilledQuantity > 0;

  return (
    <span>
      <strong>{money(live.orderTotal, "₹")}</strong>
      {partBilled && (
        <span className="muted">
          {" "}
          · {money(live.billTotal - (live.billDue || 0), "₹")} paid, more to bill
        </span>
      )}
      {sitting}
    </span>
  );
}

// The floor, drawn as the floor. Grouped the way the room is actually laid
// out — by floor, then by area — because "A/C" and "Terrace" are how staff
// talk about it, and a flat alphabetical list of sixteen table numbers is not
// something anybody can match to a room at a glance.
// `tables` are the ones shown (after the State filter); `allTables` the
// whole floor. The legend and each group's chips always describe the whole
// room: with "Out of service" chosen, the Ground Floor is still twelve
// tables of which one is out of service, not "1 table · all out of service".
function FloorPlan({ tables, allTables = tables, cardProps, foldClosed = true }) {
  const [showClosed, setShowClosed] = useState(false);
  const counts = TABLE_STATES.map((state) => ({
    ...state,
    count: allTables.filter((table) => tableState(table) === state.key).length,
  }));
  const wholeGroup = (group) =>
    allTables.filter((table) => table.floorName === group.floor && (table.areaName || "Main") === group.area);

  // floor -> area -> tables, in the order the kitchen would walk them.
  const groups = [];

  for (const table of tables) {
    const floor = table.floorName;
    const area = table.areaName || "Main";
    let group = groups.find((item) => item.floor === floor && item.area === area);

    if (!group) {
      group = { floor, area, tables: [] };
      groups.push(group);
    }

    group.tables.push(table);
  }

  // A floor or area with every table out of service is folded into one line
  // (the monsoon terrace, a closed test floor), and floors with tables to
  // seat come first: the live floor opens on tables that can take a party.
  const isClosed = (group) => wholeGroup(group).every((table) => tableState(table) === "out_of_service");
  const open = groups.filter((group) => !isClosed(group));
  const closed = foldClosed ? groups.filter(isClosed) : [];
  const drawn = foldClosed ? (showClosed ? [...open, ...closed] : open) : groups;
  const closedTables = closed.reduce((sum, group) => sum + group.tables.length, 0);

  return (
    <div className="stack">
      {/* A colour with no key is a decoration. */}
      <ul className="legend">
        {counts.map((state) => (
          <li key={state.key} className={`legend-item state-${state.key}`}>
            <span className="legend-swatch" aria-hidden="true" />
            <span className="legend-label">{state.label}</span>
            <span className="legend-count">{state.count}</span>
          </li>
        ))}
      </ul>

      {drawn.map((group) => {
        const whole = wholeGroup(group);
        const off = whole.filter((table) => tableState(table) === "out_of_service").length;
        const shown = group.tables.length;

        return (
          <div key={`${group.floor}-${group.area}`} className="floor-group">
            <h3 className="floor-group-name">
              <Icon name="layers" size={14} className="fp-group-icon" />
              {group.floor}
              {group.area !== "Main" && <span className="fp-group-area"> · {group.area}</span>}
              <span className="fp-group-count">
                {shown < whole.length ? `${shown} of ${whole.length}` : whole.length}{" "}
                {whole.length === 1 ? "table" : "tables"}
              </span>
              {off > 0 && (
                <span className="fp-group-off">
                  {off === whole.length ? "all out of service" : `${off} out of service`}
                </span>
              )}
            </h3>

            <div className="floor-grid">
              {group.tables.map((table) => (
                <TableCard key={table.id} table={table} {...cardProps} />
              ))}
            </div>
          </div>
        );
      })}

      {closed.length > 0 && (
        <p className="fp-closed-line">
          <Icon name="ban" size={14} />
          <span>
            Closed: {closed.map((group) => (group.area !== "Main" ? `${group.floor} · ${group.area}` : group.floor)).slice(0, 3).join(", ")}
            {closed.length > 3 ? ` and ${closed.length - 3} more` : ""} ({count(closedTables)}{" "}
            {closedTables === 1 ? "table" : "tables"}, all out of service)
          </span>
          <button type="button" className="link-button small" onClick={() => setShowClosed((value) => !value)}>
            {showClosed ? "Hide them" : "Show them"}
          </button>
        </p>
      )}
    </div>
  );
}

function TableCard({ table, now, onQr, onReady, onEdit, onPay, readying, canBook, canReady, canManage, canSetUp }) {
  const state = tableState(table);
  const { live, booking, turn } = table;
  const seats = (
    <span className="floor-table-seats">
      {live && live.guestCount ? `${live.guestCount} of ` : ""}
      {table.capacity} seats
    </span>
  );

  let main;

  if (state === "out_of_service") {
    // Never a way to seat anyone: no link to the till, no booking to seat.
    // A manager gets the way to switch it back on instead.
    const body = (
      <>
        <span className="floor-table-no">{table.tableNo}</span>
        {seats}
        <span className="floor-table-live">
          <StateTag state={state} />
          <span className="fp-off-reason">{offReason(table)}</span>
        </span>
      </>
    );

    if (canSetUp && canSetUp(table) && table.outOfServiceReason === "table") {
      main = (
        <button
          type="button"
          className="floor-table-main fp-main-button"
          onClick={() => onEdit(table)}
          title="Edit this table to switch it back on"
        >
          {body}
        </button>
      );
    } else if (canManage) {
      main = (
        <Link className="floor-table-main" to="/tables/floors" title="Open Floors & areas">
          {body}
        </Link>
      );
    } else {
      main = <div className="floor-table-main">{body}</div>;
    }
  } else if (state === "cleaning") {
    // Not a link: the table is not ready for anyone yet. The way on is the
    // button underneath, pressed by whoever reset it.
    main = (
      <div className="floor-table-main">
        <span className="floor-table-no">{table.tableNo}</span>
        {seats}
        <span className="floor-table-live">
          <StateTag state={state} />
          {turn ? (
            <>
              <strong>
                {/* Under a minute reads "just now", never "0m ago". */}
                {now - new Date(turn.settledAt).getTime() < 60000
                  ? "Settled just now"
                  : `Settled ${elapsed(turn.settledAt, now)} ago`}
              </strong>
              <span className="fp-turn-left">
                {turn.minutesLeft > 0 ? `Free by itself in ${turn.minutesLeft} min` : "Free any moment"}
              </span>
            </>
          ) : (
            <strong>Being reset</strong>
          )}
          {booking && <span className="floor-table-next">Next: {bookingLine(booking)}</span>}
        </span>
      </div>
    );
  } else {
    // A busy table opens its own order; an empty one starts a new one there.
    // A table held for a booking opens the booking instead, so the party is
    // seated against it and the book knows they arrived — starting a POS
    // order there directly would leave them showing as late.
    const to = live
      ? `/pos?order=${live.orderId}`
      : booking && canBook
        ? bookingLink(booking)
        : `/pos?table=${table.id}`;

    main = (
      <Link className="floor-table-main" to={to}>
        <span className="floor-table-no">{table.tableNo}</span>
        {seats}

        {live ? (
          <span className="floor-table-live">
            <StateTag state={state} />
            <LiveLine table={table} now={now} />
            {live.earlierDay && <span className="fp-earlier">Left open since {dateShort(live.placedAt)}: bill or cancel</span>}
            {state === "paid" && <span className="fp-paid-note">Guests still seated</span>}
            {/* Still eating, and the next party is due: the table to turn. */}
            {booking && <span className="floor-table-next">Next: {bookingLine(booking)}</span>}
            {/* Switched off while a party is still here: let them finish,
                then nobody else sits down. */}
            {!table.inService && <span className="fp-off-after">Out of service after this party</span>}
          </span>
        ) : booking ? (
          <span className="floor-table-live">
            <StateTag state={state} />
            <span className="floor-table-booking">{bookingLine(booking)}</span>
          </span>
        ) : (
          <span className="floor-table-live">
            <StateTag state={state} />
            <span className="muted">{TABLE_STATES.find((item) => item.key === state).hint}</span>
          </span>
        )}
      </Link>
    );
  }

  return (
    <div className={`floor-table state-${state} ${live && live.earlierDay ? "is-earlier" : ""}`}>
      {main}

      {/* A booking on a table nobody can sit at is the host's problem now,
          not at 7:30 when the party is standing at the door. */}
      {state === "out_of_service" && booking && (
        <p className="fp-off-booking">
          Booked {bookingLine(booking)}.{" "}
          {canBook ? <Link to={bookingLink(booking)}>Move it</Link> : "Move it to another table."}
        </p>
      )}

      {/* The bill is out: take the money right here, in the same bill
          dialog the Bills screen uses. */}
      {state === "printed" && onPay && live && live.billId && (
        <button type="button" className="fp-ready fp-pay" onClick={() => onPay(table)}>
          Take payment
        </button>
      )}

      {state === "cleaning" && canReady && (
        <button
          type="button"
          className="fp-ready"
          onClick={() => onReady(table)}
          disabled={readying === table.id}
        >
          {readying === table.id ? "Marking…" : "Mark ready"}
        </button>
      )}

      {onQr && (
        <button
          type="button"
          className="floor-table-qr"
          onClick={() => onQr(table)}
          aria-label={`QR code for table ${table.tableNo}`}
          title="QR code"
        >
          <Icon name="qr" size={14} />
        </button>
      )}
    </div>
  );
}

export default function TablesPage() {
  const { user, hasPermission, hasFeature } = useAuth();
  const canManage = hasPermission("tables.manage");
  // Table QR codes are QR table ordering; captains' tables are Captain
  // sections (Settings -> Features).
  const qrOn = hasFeature("qr_ordering");
  const captainsOn = hasFeature("captain_sections");
  // The outlet this person works in: tied to it, or the switcher on it. Its
  // floor plan shows its own tables and those shared by every outlet, and
  // only its own are set up from here; a shared table is set up with All
  // outlets (the server refuses the rest the same way).
  const workingOutlet = user.outletId || outletStorage.get() || null;
  const pinned = Boolean(user.outletId);
  const canSetUp = (table) =>
    canManage && (!workingOutlet || String(table.outletId || "") === String(workingOutlet));
  // The restaurant's outlets, for the table form's Outlet field (owners and
  // managers who may see outlets; staff tied to one outlet use their own).
  const [outlets, setOutlets] = useState([]);
  // Resetting a table is floor work: whoever takes orders can say it is ready.
  const canReady = canManage || hasPermission("orders.create");
  // Taking a payment on a table whose bill is out (BillModal, as on Bills).
  const loadRef = useRef(null);
  const bills = useBillDialog(() => loadRef.current && loadRef.current());

  const [tables, setTables] = useState([]);
  const [floors, setFloors] = useState([]);
  const [areas, setAreas] = useState([]);
  const [floorFilter, setFloorFilter] = useQueryFilter("floor");
  // The dashboard's "2/16 tables busy" links here with this set, so the page
  // shows the two it counted rather than all sixteen.
  const [statusFilter, setStatusFilter] = useQueryFilter("status");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const [qrTable, setQrTable] = useState(null);
  const [qrImage, setQrImage] = useState("");
  // The guest pages' web address, name and logo every code is printed with,
  // and "Print QR codes" (also opened by a link here with ?print=qr).
  const [qrSettings, setQrSettings] = useState(null);
  const [sheetFilter, setSheetFilter] = useQueryFilter("print");
  const [planOpen, setPlanOpen] = useState(false);
  const qrUrl = qrUrlFor(qrSettings);
  const qrProblem = addressProblem(qrSettings ? qrSettings.guestWebAddress : null, customerWebOrigin());

  const [readying, setReadying] = useState(null);
  const [settings, setSettings] = useState(null);

  // The floor is what most people open this page for; the list is for whoever
  // is adding a table or printing a QR code.
  const [view, setView] = useQueryFilter("view", "floor");
  // Only used to age the "seated 40m ago" labels, so once a minute is plenty.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60000);

    return () => clearInterval(tick);
  }, []);

  const load = useCallback(
    () =>
      listTables({ floorId: floorFilter || undefined })
        .then(setTables)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [floorFilter]
  );

  useEffect(() => {
    loadRef.current = load;
    load();
  }, [load]);

  // The floor is a live board: a table settled at the till turns to Cleaning
  // on the host's screen within a second, without anyone pressing refresh
  // (live updates). As a safety net it also reads itself every minute while
  // the page is on screen; a hidden tab reads nothing.
  const live = useLiveRefresh({ restaurant: true }, ["table", "order", "reservation", "bill"], load);

  // The filter uses the same states the floor plan colours, so "Reserved"
  // also means held for a booking due within the hour, and "Free" never
  // includes a table that is out of service or still being reset.
  const visible = statusFilter ? tables.filter((table) => matchesFilter(table, statusFilter)) : tables;

  // Free tables are counted only among those that can take a party at all.
  // The same states as the legend, so the two never disagree: a table
  // switched off while a party finishes still counts as in use until they go.
  const freeCount = tables.filter((table) => tableState(table) === "free").length;
  const offCount = tables.filter((table) => tableState(table) === "out_of_service").length;
  const inServiceCount = tables.length - offCount;

  useEffect(() => {
    Promise.all([listFloors(), listAreas()])
      .then(([floorRows, areaRows]) => {
        setFloors(floorRows);
        setAreas(areaRows);
      })
      .catch((err) => setError(getErrorMessage(err)));

    getFloorSettings()
      .then(setSettings)
      .catch(() => setSettings(null));

    if (qrOn) {
      getQrSettings()
        .then(setQrSettings)
        .catch(() => setQrSettings({ guestWebAddress: null, restaurantName: user.restaurantName || "", logoPath: null }));
    }
  }, [user.restaurantName, qrOn]);

  const canSeeOutlets = hasPermission("outlets.view");

  useEffect(() => {
    if (!canManage || pinned || !canSeeOutlets) {
      return;
    }

    listOutlets()
      .then(setOutlets)
      .catch(() => setOutlets([]));
  }, [canManage, pinned, canSeeOutlets]);

  const outletName = (id) => {
    if (!id) {
      return "";
    }

    if (pinned && String(id) === String(user.outletId)) {
      return user.outletName || "your outlet";
    }

    const found = outlets.find((outlet) => String(outlet.id) === String(id));

    return found ? found.name : "this outlet";
  };

  // Draws the QR code as an image whenever a table's QR is opened. The image is
  // cleared when the dialog closes, not here, so nothing is set during render.
  useEffect(() => {
    if (!qrTable) {
      return;
    }

    QRCode.toDataURL(qrUrlFor(qrSettings)(qrTable.qrToken), { width: 320, margin: 1 })
      .then(setQrImage)
      .catch(() => setQrImage(""));
  }, [qrTable, qrSettings]);

  const closeQr = () => {
    setQrTable(null);
    setQrImage("");
  };

  const areasForFloor = (floorId) =>
    areas.filter((area) => String(area.floorId) === String(floorId));

  const openNew = () => {
    setForm({ ...EMPTY, floorId: floors[0] ? String(floors[0].id) : "" });
    setFormError("");
    setEditing({});
  };

  const openEdit = (table) => {
    setForm({
      floorId: String(table.floorId),
      areaId: table.areaId ? String(table.areaId) : "",
      outletId: table.outletId ? String(table.outletId) : "",
      tableNo: table.tableNo,
      capacity: table.capacity,
      status: table.status,
    });
    setFormError("");
    setEditing(table);
  };

  const change = (field) => (event) => {
    const value = event.target.value;

    // Changing the floor clears the area, because areas belong to one floor.
    setForm(field === "floorId" ? { ...form, floorId: value, areaId: "" } : { ...form, [field]: value });
  };

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const payload = {
      floorId: Number(form.floorId),
      areaId: form.areaId ? Number(form.areaId) : null,
      tableNo: form.tableNo,
      capacity: Number(form.capacity),
      status: form.status,
    };

    // Working in one outlet, the table is that outlet's. For the whole
    // restaurant the Outlet field says whose it is (or shared); without the
    // field, an edit leaves the table's outlet as it is.
    if (workingOutlet) {
      payload.outletId = Number(workingOutlet);
    } else if (outlets.length > 0) {
      payload.outletId = form.outletId ? Number(form.outletId) : null;
    }

    try {
      if (editing.id) {
        await updateTable(editing.id, payload);
        setSuccess("Table updated");
      } else {
        await createTable(payload);
        setSuccess("Table created");
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async () => {
    setSaving(true);

    try {
      const updated = await regenerateTableQr(qrTable.id);
      setQrTable(updated);
      setTables(tables.map((row) => (row.id === updated.id ? updated : row)));
      setSuccess(`New QR code for table ${updated.tableNo}. Reprint it.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // One table's code as a folded table tent: the same card as the sheets
  // ("Print QR codes"), with the restaurant's name and logo.
  const printQr = async () => {
    try {
      const sheet = await buildQrSheet({
        tables: [qrTable],
        layoutKey: "tent",
        base: guestBase(qrSettings ? qrSettings.guestWebAddress : null, customerWebOrigin()),
        restaurantName: (qrSettings && qrSettings.restaurantName) || user.restaurantName || "",
        logoUrl: qrSettings && qrSettings.logoPath ? qrSettings.logoPath : "",
      });

      printDocument({ title: `Table ${qrTable.tableNo}`, styles: sheet.styles, body: sheet.body });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  // One tap from whoever reset the table. The table drops straight back into
  // the floor as Free (or Reserved, when a booking is due).
  const markReady = async (table) => {
    setReadying(table.id);
    setError("");

    try {
      const updated = await markTableReady(table.id);
      setTables((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      setSuccess(`Table ${updated.tableNo} is ready to seat`);
    } catch (err) {
      setError(getErrorMessage(err));
      load();
    } finally {
      setReadying(null);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteTable(deleting.id);
      setDeleting(null);
      setSuccess("Table deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  // The figures along the top, counted over every table on the chosen floor
  // (not the state filter), so they always describe the whole room. Each
  // one is also the quickest way to filter the plan down to those tables.
  const stateCount = (key) => tables.filter((table) => tableState(table) === key).length;
  const runningCount = stateCount("running");
  const printedCount = stateCount("printed");
  const paidCount = stateCount("paid");
  const inUseCount = runningCount + printedCount + paidCount;
  const reservedCount = stateCount("reserved");
  const cleaningCount = stateCount("cleaning");
  const toggleFilter = (value) => setStatusFilter(statusFilter === value ? "" : value);
  const tileClass = (value) => (statusFilter === value ? "fp-tile-on" : "");

  const addButton = canManage && (
    <button type="button" className="button" onClick={openNew} disabled={floors.length === 0}>
      <Icon name="plus" size={16} /> Add table
    </button>
  );

  const viewSwitch = (
    <div className="segmented" role="radiogroup" aria-label="Table view">
      <button
        type="button"
        className={`segment ${view === "floor" ? "is-active" : ""}`}
        role="radio"
        aria-checked={view === "floor"}
        onClick={() => setView("floor")}
      >
        <Icon name="grid" size={15} /> Floor
      </button>
      <button
        type="button"
        className={`segment ${view === "list" ? "is-active" : ""}`}
        role="radio"
        aria-checked={view === "list"}
        onClick={() => setView("list")}
      >
        <Icon name="list" size={15} /> List
      </button>
    </div>
  );

  return (
    <div className="stack fp-page">
      {bills.dialog}
      <PageHeader
        icon="table"
        title="Tables"
        description="The live floor: who is seated, who is waiting to pay, and which tables are free."
        action={
          <>
            <LiveIndicator status={live} />
            {captainsOn && (
              <button type="button" className="button button-secondary" onClick={() => setPlanOpen(true)}>
                <Icon name="users" size={16} /> Captain sections
              </button>
            )}
            {qrOn && (
              <button type="button" className="button button-secondary" onClick={() => setSheetFilter("qr")}>
                <Icon name="qr" size={16} /> Print QR codes
              </button>
            )}
            {canManage && (
              <Link className="button button-secondary" to="/tables/floors">
                <Icon name="layers" size={16} /> Floors & areas
              </Link>
            )}
            {addButton}
          </>
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {floors.length === 0 && !loading && (
        <div className="alert">Add a floor first; every table belongs to one.</div>
      )}

      {!loading && tables.length > 0 && (
        <div className="stat-grid fp-tiles">
          <StatTile
            icon="check-circle"
            tone="success"
            label="Free now"
            value={count(freeCount)}
            of={` of ${count(inServiceCount)}`}
            note={offCount > 0 ? `${count(offCount)} out of service` : "ready to seat"}
            onClick={() => toggleFilter("free")}
            className={tileClass("free")}
            title="Show only free tables"
          />
          <StatTile
            icon="users"
            tone="info"
            label="Guests seated"
            value={count(inUseCount)}
            note={`${count(runningCount)} eating · ${count(paidCount)} paid, still seated`}
            onClick={() => toggleFilter("occupied")}
            className={tileClass("occupied")}
            title="Show every table with guests at it"
          />
          <StatTile
            icon="receipt"
            tone="warning"
            label="Waiting to pay"
            value={count(printedCount)}
            note="bill printed"
            onClick={() => toggleFilter("printed")}
            className={tileClass("printed")}
            title="Show tables whose bill is out"
          />
          <StatTile
            icon="calendar"
            tone="violet"
            label="Reserved"
            value={count(reservedCount)}
            note="held for a booking"
            onClick={() => toggleFilter("reserved")}
            className={tileClass("reserved")}
            title="Show tables held for a booking"
          />
          <StatTile
            icon="sparkles"
            tone="neutral"
            label="Cleaning"
            value={count(cleaningCount)}
            note="being reset after a bill"
            onClick={() => toggleFilter("cleaning")}
            className={tileClass("cleaning")}
            title="Show tables being reset"
          />
        </div>
      )}

      <SectionCard
        icon={view === "floor" ? "grid" : "list"}
        title={view === "floor" ? "Floor plan" : "All tables"}
        description={
          view === "floor"
            ? "Tap a free table to start an order there, or a busy one to open its order."
            : "Every table with its QR code. Edit a table to move it or switch it off."
        }
        actions={viewSwitch}
        className="fp-board"
      >
        <div className="filters">
          <label className="field">
            <span>Floor</span>
            <select value={floorFilter} onChange={(event) => setFloorFilter(event.target.value)}>
              <option value="">All floors</option>
              {floors.map((floor) => (
                <option key={floor.id} value={floor.id}>
                  {floor.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>State</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">Any state</option>
              {FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
          </label>

          <p className="filters-summary muted small">
            {statusFilter
              ? `${visible.length} of ${tables.length} ${tables.length === 1 ? "table" : "tables"}`
              : `${freeCount} free of ${inServiceCount} in service`}
            {!statusFilter && offCount > 0 && ` · ${offCount} out of service`}
            {statusFilter && (
              <>
                {" · "}
                <button type="button" className="link-button" onClick={() => setStatusFilter("")}>
                  Show all
                </button>
              </>
            )}
          </p>
        </div>

        {loading ? (
          <Loading />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="table"
            message={statusFilter ? "No tables in that state right now" : "No tables yet"}
            hint={
              statusFilter
                ? "Clear the state filter to see the whole floor."
                : "Tables are what the floor plan draws, and what a dine-in order is attached to."
            }
            action={
              statusFilter ? (
                <button type="button" className="button button-secondary" onClick={() => setStatusFilter("")}>
                  Show every table
                </button>
              ) : (
                canManage &&
                floors.length > 0 && (
                  <button type="button" className="button" onClick={openNew}>
                    <Icon name="plus" size={16} /> Add the first table
                  </button>
                )
              )
            }
          />
        ) : view === "floor" ? (
          <>
            <FloorPlan
              tables={visible}
              allTables={tables}
              foldClosed={!statusFilter}
              cardProps={{
                now,
                onQr: qrOn ? setQrTable : null,
                onReady: markReady,
                onEdit: openEdit,
                onPay: hasPermission("payments.manage") ? (table) => bills.open(table.live.billId) : null,
                readying,
                canBook: hasPermission("reservations.view") && hasFeature("reservations"),
                canReady,
                canManage,
                canSetUp,
              }}
            />
            {settings && (
              <p className="fp-turn-note muted small">
                <Icon name="timer" size={15} />
                <span>
                  {settings.cleaningMinutes > 0
                    ? `After a bill is settled the table shows Cleaning for ${settings.cleaningMinutes} min, or until someone taps Mark ready. `
                    : "The cleaning hold is off: a table is free as soon as its bill is settled. "}
                  {canManage && <Link to="/tables/floors#turnover">Change</Link>}
                </span>
              </p>
            )}
          </>
        ) : (
          <DataGrid
            id="tables-list"
            caption="Tables"
            rows={visible}
            rowKey={(table) => table.id}
            rowClassName={(table) => (table.inService ? "" : "dg-tone-muted")}
            rowNoun={["table", "tables"]}
            exportName="tables"
            columns={[
              {
                key: "table",
                header: "Table",
                value: (table) => table.tableNo,
                mobile: "title",
                render: (table) => (
                  <span className="fp-name">
                    {table.tableNo}
                    {/* For the whole restaurant, whose table it is. */}
                    {!workingOutlet && outlets.length > 0 && (
                      <span className={`fp-outlet-tag ${table.outletId ? "" : "is-shared"}`}>
                        {table.outletId ? outletName(table.outletId) : "Shared"}
                      </span>
                    )}
                  </span>
                ),
              },
              { key: "floor", header: "Floor", value: (table) => table.floorName, filter: "select", mobile: "subtitle" },
              { key: "area", header: "Area", value: (table) => table.areaName || "", filter: "select" },
              { key: "seats", header: "Seats", type: "number", value: (table) => table.capacity, total: "sum", mobile: "show" },
              {
                key: "now",
                header: "Right now",
                value: (table) => STATE_LABEL[tableState(table)],
                filter: "select",
                mobile: "show",
                render: (table) => (
                  <span className={`fp-chip state-${tableState(table)}`}>
                    <span className="legend-swatch" aria-hidden="true" />
                    {STATE_LABEL[tableState(table)]}
                  </span>
                ),
              },
              ...(captainsOn
                ? [
                    {
                      key: "captain",
                      header: "Captain today",
                      value: (table) => (table.captain ? table.captain.userName : ""),
                      filter: "select",
                    },
                  ]
                : []),
              {
                key: "service",
                header: "In service",
                value: (table) => (table.inService ? table.status : offReason(table)),
                render: (table) =>
                  table.inService ? (
                    <StatusBadge status={table.status} />
                  ) : (
                    <span className="badge badge-inactive status-badge">
                      <span className="badge-dot" aria-hidden="true" />
                      {offReason(table)}
                    </span>
                  ),
              },
              {
                key: "actions",
                header: "",
                label: "Actions",
                type: "actions",
                render: (table) => (
                  <div className="row-actions">
                      {tableState(table) === "cleaning" && canReady && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => markReady(table)}
                          disabled={readying === table.id}
                        >
                          Mark ready
                        </button>
                      )}
                      {qrOn && (
                        <button type="button" className="chip-button" onClick={() => setQrTable(table)}>
                          <Icon name="qr" size={14} /> QR code
                        </button>
                      )}
                      {canSetUp(table) && (
                        <>
                          <button type="button" className="chip-button" onClick={() => openEdit(table)}>
                            <Icon name="edit" size={14} /> Edit
                          </button>
                          <ActionMenu
                            label={`More actions for table ${table.tableNo}`}
                            items={[
                              {
                                label: "Delete",
                                icon: "trash",
                                danger: true,
                                onClick: () => setDeleting(table),
                              },
                            ]}
                          />
                        </>
                      )}
                      {/* Working in one outlet, a table every outlet shares
                          is set up for the whole restaurant. */}
                      {canManage && !canSetUp(table) && (
                        <span
                          className="muted small fp-shared-note"
                          title={
                            pinned
                              ? "Shared by every outlet: the owner, or a manager who works across outlets, sets it up."
                              : "Shared by every outlet: switch the top bar to All outlets to set it up."
                          }
                        >
                          Shared by all outlets
                        </span>
                      )}
                    </div>
                ),
              },
            ]}
          />
        )}
      </SectionCard>

      {editing && (
        <Modal
          title={editing.id ? `Edit table ${editing.tableNo}` : "Add table"}
          description="Where it stands and how many it seats. The floor plan groups tables by floor, then area."
          icon="table"
          onClose={() => setEditing(null)}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <label className="field">
              <span>Table number *</span>
              <input value={form.tableNo} onChange={change("tableNo")} required autoFocus maxLength={20} />
            </label>

            <label className="field">
              <span>Seats *</span>
              <input
                type="number"
                min="1"
                max="100"
                value={form.capacity}
                onChange={change("capacity")}
                required
              />
            </label>

            <label className="field">
              <span>Floor *</span>
              <select value={form.floorId} onChange={change("floorId")} required>
                {floors.map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    {floor.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Area</span>
              <select value={form.areaId} onChange={change("areaId")}>
                <option value="">No area</option>
                {areasForFloor(form.floorId).map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Whose table it is. Working in one outlet it is that outlet's;
                for the whole restaurant it is picked here (or shared). */}
            {workingOutlet ? (
              <p className="field field-wide fp-outlet-fixed">
                <span>Outlet</span>
                <strong>{outletName(workingOutlet)}</strong>
                <small className="muted">
                  {editing.id ? "This table belongs to" : "A table added here belongs to"} the outlet you are
                  working in. Tables of other outlets, and tables shared by every outlet, are set up{" "}
                  {pinned ? "by the owner or a manager who works across outlets." : "with All outlets picked at the top."}
                </small>
              </p>
            ) : (
              outlets.length > 0 && (
                <label className="field field-wide">
                  <span>Outlet</span>
                  <select value={form.outletId} onChange={change("outletId")}>
                    <option value="">Shared by every outlet</option>
                    {outlets
                      .filter((outlet) => outlet.status === "active" || String(outlet.id) === String(form.outletId))
                      .map((outlet) => (
                        <option key={outlet.id} value={outlet.id}>
                          {outlet.name}
                          {outlet.status === "active" ? "" : " (closed)"}
                        </option>
                      ))}
                  </select>
                  <small className="muted">
                    An outlet's tables are seated and rung up by its own staff only. A shared table can be used by
                    every outlet.
                  </small>
                </label>
              )
            )}

            <label className="field field-wide">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active: in service</option>
                <option value="inactive">Inactive: out of service</option>
              </select>
              <small className="muted">
                An inactive table stays on the floor plan, greyed out, and is never offered for
                seating. Use it for a broken table or a section closed for the season.
              </small>
            </label>

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

      {qrTable && (
        <Modal
          title={`QR code — table ${qrTable.tableNo}`}
          description="Print it and stand it on the table."
          icon="qr"
          onClose={closeQr}
          width={440}
        >
          <div className="qr-box fp-qr-box">
            <div className="fp-qr-frame">
              {qrImage ? <img src={qrImage} alt={`QR code for table ${qrTable.tableNo}`} /> : <Loading />}
            </div>
            <p className="muted small mono fp-qr-url">{qrUrl(qrTable.qrToken)}</p>
            {qrProblem && (
              <p className={`alert ${qrProblem === "local" ? "alert-danger" : "alert-notice"} fp-qr-warning`} role="alert">
                {ADDRESS_WARNINGS[qrProblem]}
              </p>
            )}
            <p className="muted small">
              Guests scan it to open this table's menu, send an order and call a waiter. Regenerate
              only when a printed card goes missing: the old code stops working at once.
            </p>
          </div>

          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={closeQr}>
              Close
            </button>
            {canSetUp(qrTable) && (
              <button type="button" className="button button-secondary" onClick={regenerate} disabled={saving}>
                Regenerate
              </button>
            )}
            <button type="button" className="button" onClick={printQr} disabled={!qrImage}>
              Print
            </button>
          </div>
        </Modal>
      )}

      {planOpen && (
        <CaptainPlanModal
          floors={floors}
          areas={areas}
          tables={tables}
          canManage={canManage}
          onClose={() => setPlanOpen(false)}
        />
      )}

      {sheetFilter === "qr" && (
        <QrSheetDialog
          floors={floors}
          areas={areas}
          qrSettings={qrSettings}
          canSetAddress={canManage}
          onClose={() => setSheetFilter("")}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete table"
          message={`Delete table "${deleting.tableNo}"? Its QR code will stop working. A table that has ever had an order cannot be deleted; set it to Inactive instead.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
