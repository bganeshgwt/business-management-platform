import AddonChoiceRules from "@bmp/ui/menu/AddonChoiceRules";
import {choiceError} from "@bmp/shared/menu/addonChoices";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { moneyExact } from "@bmp/shared/format";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import ActionMenu from "../../../../components/ActionMenu";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { toast } from "../../../../services/toast";
import { listCategories, listProducts, listVariants, listProductModifiers, listModifiers } from "../../menu/services/menu.service";
import { listTables } from "../../tables/services/table.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getCustomerHistory } from "../../crm/services/crm.service";
import {
  createOrder,
  fireOrderCourse,
  getOrder,
  getServiceDay,
  getServiceSettings,
  listJoinedTables,
  listOffers,
  listOrders,
  listSaleOutlets,
  unjoinOrderTable,
  updateOrderItems,
} from "../services/order.service";
import { createBill, getBill, listBills } from "../../billing/services/bill.service";
import { getErrorMessage, outletStorage, uploadUrl } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { printCountedBill } from "../services/billPrint";
import { getOrderTickets, recordTicketPrint } from "../../kitchen/services/kitchen.service";
import { printKot } from "../../../../services/kot";
import { listChannels, updateDelivery } from "../../deliveries/services/delivery.service";
import { getTableRequestSummary } from "../services/tableRequest.service";
import { getReservationBoard } from "../../reservations/services/reservation.service";
import { getAvailability, soldOutKey } from "../../menu/services/availability.service";
import ComboChoicePicker from '@bmp/ui/menu/ComboChoicePicker';
import {comboError,comboParts} from '@bmp/shared/menu/comboChoices';
import { dishByCode, searchDishes } from "../services/posSearch";
import { clearDraft, draftKey, loadDraft, saveDraft } from "../services/posDraft";
import { ticketsToPrint, withNote } from "../services/posKot";
import { printChangeSlips } from "../services/kotSlips";
import { repriceCart } from "../services/posPricing";
import { heldSentence, heldText, joinedTableMap, sourceForChannel, tablesText } from "../../../../services/floorTables";
import {
  CANCEL_REASONS,
  RUNNING_LIMIT,
  addLine,
  buildItems,
  cancellationGroups,
  cartFromOrder,
  cartTotal,
  headerChanges,
  headerOf,
  isDirty,
  lineTotalOf,
  offerKey,
  pendingCancellations,
  rebaseCart,
  rebaseHeader,
  stepLine,
  takenOffEarlier,
  unitPriceFor,
} from "../services/orderCart";
import useAuth from "../../../../hooks/useAuth";
import { elapsed, minutesSince, LINGERING_MINUTES } from "@bmp/shared/dates";
import TableGrid from "./TableGrid";
import MoveDialog from "./MoveDialog";
import GuestBox from "./GuestBox";
import DeliveryFields from "./DeliveryFields";
import DeliveryChargeLine from "./DeliveryChargeLine";
import WeighDialog from "./WeighDialog";
import { listBrands } from "../../menu/services/brand.service";
import "../../menu/styles/brands.css";
import { EMPTY_DELIVERY, deliveryOf, deliveryPayload, sameDelivery } from "../services/posDelivery";
import { DishAvailability, SoldOutPanel } from "./SoldOutControls";
import BillModal from "./BillModal";
import "../styles/orders.css";
import "../styles/pos.css";

// Where a new order starts for each format until the service settings load
// (a café's counter and a bakery take parcels; a cloud kitchen delivers).
const FORMAT_START = { cafe: "takeaway", bakery: "takeaway", cloud_kitchen: "delivery" };

const ORDER_TYPES = [
  { value: "dine_in", label: "Dine-in", icon: "utensils" },
  { value: "takeaway", label: "Takeaway", icon: "box" },
  { value: "delivery", label: "Delivery", icon: "scooter" },
];

// How far the kitchen has got with a line, in the words a waiter uses.
const STAGE_WORDS = {
  pending: "Sent to kitchen",
  preparing: "Cooking",
  ready: "Ready",
  served: "Served",
};

// A saved dish of a course held back until someone presses Fire.
const isHeld = (line) => Boolean(line.holdCourse);

// How far the kitchen had got with a dish being taken off, in words.
const KITCHEN_STAGE_WORDS = {
  new: "not started",
  cooking: "cooking",
  ready: "ready at the pass",
};

// The captain's screen: a phone held in one hand at the table.
const PHONE = "(max-width: 600px)";

const timeOf = (value) =>
  value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

// Where an order is, in the words a waiter would use. A table number already
// carries its own letter in this restaurant (C2, F1, T4), so it is printed as
// it is stored; tables pushed together read "T4 + T5".
const orderWhere = (order) => {
  if (order.tableNo) {
    return `Table ${tablesText(order)}`;
  }

  if (order.customerName) {
    return order.customerName;
  }

  return order.orderType === "delivery" ? "Delivery" : "Takeaway";
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const readSession = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

// Bookings due at the host stand within the hour (or up to half an hour late
// and not seated yet), from the reservations board.
const arrivingSoon = (board) => {
  if (!board || !board.isToday) {
    return [];
  }

  const minutesOf = (hhmm) => {
    const [hours, minutes] = String(hhmm || "").split(":").map(Number);
    return hours * 60 + minutes;
  };

  return (board.bookings || []).filter((booking) => {
    if (!["booked", "confirmed"].includes(booking.status)) {
      return false;
    }

    const until = minutesOf(booking.startTime) - board.nowMinutes;

    return until >= -30 && until <= 60;
  });
};

// The cart holds only ids and quantities; the server prices every line. The
// prices shown are worked out exactly the way the server works them out,
// from the same happy-hour prices, so what the screen says is what the bill
// says.
export default function PosPage() {
  // The receipt prints the restaurant name from the signed-in session, so the
  // user has to be read here and not merely assumed.
  const { hasPermission, hasFeature, user } = useAuth();
  const canBill = hasPermission("billing.manage");
  // Restaurant features (Settings -> Features): with Guests off there is no
  // guest box, with Deliveries off no Delivery order type, and so on.
  const guestsOn = hasFeature("guests");
  const deliveriesOn = hasFeature("deliveries");
  // The kinds of order this POS takes (Service settings: a cloud kitchen
  // takes no dine-in) and the one a new order starts on.
  const [posSetup, setPosSetup] = useState(null);
  const startType = posSetup?.defaultOrderType || FORMAT_START[user.restaurantFormat] || "dine_in";
  const orderTypes = ORDER_TYPES.filter((type) => (type.value !== "delivery" || deliveriesOn) && (!posSetup || posSetup.posOrderTypes.includes(type.value)));
  const dineInOn = orderTypes.some((type) => type.value === "dine_in");
  const [weighing, setWeighing] = useState(null);
  // Brands (one kitchen, several names): the brand a new order is taken
  // under; the menu shows that brand's categories and the shared ones.
  const brandsOn = hasFeature("brands");
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState("");
  useEffect(() => {
    if (!brandsOn) return;
    listBrands().then((rows) => {
      const selling = rows.filter((row) => row.status === "active");
      setBrands(selling);
      setBrandId((current) => current || (selling[0] ? String(selling[0].id) : ""));
    }).catch(() => undefined);
  }, [brandsOn]);
  const canCancelAfterKot = hasPermission("orders.cancel_after_kot");
  // Only staff who may read the guest book find a regular by name; everyone
  // who takes orders finds one by the mobile typed at the till.
  const canSeeGuests = guestsOn && hasPermission("customers.view");
  const canSwitchDishes = hasPermission("menu.availability");
  const canPrintKot = hasPermission("kot.manage") || hasPermission("kds.view");
  const canManageDelivery = hasPermission("orders.manage");
  const canSeeRequests = hasPermission("orders.view") && (hasFeature("qr_ordering") || hasFeature("online_ordering"));
  const canSeeBookings = hasPermission("reservations.view") && hasFeature("reservations");

  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [modifiers, setModifiers] = useState([]);
  const [tables, setTables] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  // Running orders taken on an earlier business day (not on the strip).
  const [earlierOpen, setEarlierOpen] = useState(0);
  // The Still running strip: one line until opened (remembered on this till),
  // so the order and its dishes keep the height. Filter: tables or others.
  const [stripOpen, setStripOpen] = useState(() => {
    try {
      return localStorage.getItem("rmp_pos_strip") === "open";
    } catch {
      return false;
    }
  });
  const [stripKind, setStripKind] = useState("all");
  const toggleStrip = () =>
    setStripOpen((value) => {
      try {
        localStorage.setItem("rmp_pos_strip", value ? "closed" : "open");
      } catch {
        // A blocked storage only means it is not remembered.
      }
      return !value;
    });
  // Tables joined to a party still here, billed parties included.
  const [joins, setJoins] = useState([]);
  const [openTotal, setOpenTotal] = useState(0);
  // Counted over every open order, not only those on the strip:
  // { onTables, other, amount }.
  const [openSummary, setOpenSummary] = useState(null);
  // Happy-hour prices running now at this till's outlet, per dish and size.
  const [offers, setOffers] = useState(() => new Map());
  const [currency, setCurrency] = useState("₹");
  const [taxMode, setTaxMode] = useState("exclusive");
  const [settings, setSettings] = useState(null);
  // true, false, or null while it is not known yet. Only a day known to be
  // closed stops the buttons; the server refuses an order without one anyway.
  const [dayOpen, setDayOpen] = useState(null);
  // The open business day's date: a guest's birthday "today" is the
  // restaurant's today, also after midnight on a late night.
  const [businessDate, setBusinessDate] = useState(null);
  // Tonight's sold-out list (GET /availability).
  const [availability, setAvailability] = useState(null);
  const [channels, setChannels] = useState([]);
  // Waiting at the door and at the tables: QR orders to accept, bookings due.
  const [badges, setBadges] = useState({ qrOrders: 0, calls: 0, arriving: [] });

  const [categoryId, setCategoryId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // "ORD-1185 saved · 2 KOTs printed" shows as a toast in the corner rather
  // than a banner pushing the till down; a note added a moment later
  // ("… KOT printed") updates the same toast.
  useEffect(() => {
    if (success) {
      toast.success(success, { id: "pos-success" });
    }
  }, [success]);
  const [notice, setNotice] = useState("");
  // The running order a refused "new order" is about, so the refusal can
  // offer to open it.
  const [busyOrder, setBusyOrder] = useState(null);

  const [cart, setCart] = useState([]);
  const [orderType, setOrderType] = useState(() => FORMAT_START[user.restaurantFormat] || "dine_in");

  // Deliveries switched off while a delivery was being started (a draft, or
  // the switch changed under this till): a new order falls back to takeaway.
  useEffect(() => {
    if (!deliveriesOn && orderType === "delivery") {
      setOrderType("takeaway");
    }
  }, [deliveriesOn, orderType]);
  const [tableId, setTableId] = useState("");
  // The till said "seat them anyway" on a table held for a booking.
  const [overrideHold, setOverrideHold] = useState(false);
  const [guestCount, setGuestCount] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerMobile, setCustomerMobile] = useState("");
  // The guest-book entry on the order: found from the mobile, or picked by name.
  const [customer, setCustomer] = useState(null);
  const [orderNotes, setOrderNotes] = useState("");
  const [delivery, setDelivery] = useState(EMPTY_DELIVERY);
  const [seenDelivery, setSeenDelivery] = useState(EMPTY_DELIVERY);
  const [editingOrder, setEditingOrder] = useState(null);
  // A billed order is closed to changes (the server refuses them): the screen
  // offers only its bill, never "Save changes" or a KOT that cannot be saved.
  const orderBilled = Boolean(editingOrder && editingOrder.orderStatus === "billed");
  // The order's own details (guests, note, guest) as this screen last SHOWED
  // them: when it opened the order, refreshed it or saved it. What the waiter
  // changed is worked out against this, never against a fresher copy of the
  // order, so a note another till wrote is never taken for one the waiter
  // deleted.
  const [seenHeader, setSeenHeader] = useState(() => headerOf(null));
  const [saving, setSaving] = useState(false);

  // Dishes tapped whose sizes and add-ons are still being read, before they
  // reach the cart. Placing or saving the order waits for them: a dish tapped
  // a moment before "Place order" used to be left off the order without a
  // word (the order went with the cart as it was before the tap landed).
  const [pendingPicks, setPendingPicks] = useState(0);
  // The same count, read at the moment Place order is pressed: a press that
  // lands before the screen has redrawn still sees a dish on its way.
  const pickingNow = useRef(0);

  // Choosing a size or add-ons before the item goes into the cart.
  const [picking, setPicking] = useState(null);
  const [pickVariantId, setPickVariantId] = useState("");
  const [pickModifierIds, setPickModifierIds] = useState([]);
  const [pickComboSelections,setPickComboSelections]=useState([]);
  const [pickQuantity, setPickQuantity] = useState(1);
  const [pickNotes, setPickNotes] = useState("");

  // Taking off dishes the kitchen already has: the reason asked for before
  // saving, and what to do once it is given.
  const [cancelPrompt, setCancelPrompt] = useState(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNote, setCancelNote] = useState("");

  // The floor: choosing a table, a table held for a booking, moving guests.
  const [tablePicker, setTablePicker] = useState(false);
  const [heldConfirm, setHeldConfirm] = useState(null);
  const [moveDialog, setMoveDialog] = useState(null);
  const [unjoining, setUnjoining] = useState(null);
  const [dishSwitch, setDishSwitch] = useState(null);
  // "Mark sold out" mode: only then does each dish show its sold-out switch,
  // so a rushed tap beside + never takes a dish off sale.
  const [soldOutMode, setSoldOutMode] = useState(false);
  const [soldOutPanel, setSoldOutPanel] = useState(false);

  // The phone layout: a captain at the table.
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(PHONE).matches : false
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  // Which outlet this sale is for. Every sale belongs to an outlet once the
  // restaurant trades through outlets: its bill, its GST, its cash drawer and
  // its reports are that outlet's. Staff tied to an outlet are always in it,
  // and a table's order takes the table's outlet; but with "All outlets"
  // chosen, a takeaway (or an order on a table that belongs to no outlet)
  // would be filed under no outlet at all. The till asks first — anyone who
  // takes orders and is not tied to one outlet, cashiers and captains
  // included (they have no outlet switcher at the top, so the till's own
  // "Sale at" is where they set and change it).
  const mayPickOutlet = !user.outletId && hasPermission("orders.create");
  const hasTopSwitcher = hasPermission("outlets.view");
  const storedOutlet = outletStorage.get() || "";
  const [activeOutlets, setActiveOutlets] = useState([]);

  // Sizes of each dish, once read, so plus on a saved line can price one
  // more of it without asking the server again.
  const variantCache = useRef(new Map());
  // The KOTs an order had before a "Save & print KOT", so only the new ones print.
  const printBefore = useRef(null);

  // The bill open in the bill dialog (BillModal): payment, coupon, points,
  // discounts and prints all happen there, on this one bill.
  const [bill, setBill] = useState(null);

  // Arriving from the floor plan: ?order= resumes that table's order, ?table=
  // starts a new one on an empty table. Handled once, then cleared out of the
  // address bar so a reload does not re-open an order the user has moved on
  // from.
  const [params, setParams] = useSearchParams();
  const arrivedFor = useRef(false);

  // The unsaved cart, kept for this person on this till (services/posDraft).
  const storageKey = draftKey(user);
  const restoredFor = useRef(null);
  const restoring = useRef(false);

  // Ages the "sitting 40m" labels and refreshes the happy-hour prices, so a
  // window that opens at four is on the screen by one minute past.
  const [now, setNow] = useState(() => Date.now());

  // The happy-hour prices of the place this order will be charged: the order
  // open on the screen (its own outlet), or the table a new dine-in order is
  // for (with "All outlets" selected, a table's order is charged at the
  // table's outlet). Read again whenever that changes, and every dish not
  // yet saved is priced again with them (services/posPricing), so the price
  // on the screen is the price on the bill. An answer for a table the till
  // has already moved on from is dropped.
  const chosenTable = tables.find((table) => String(table.id) === String(tableId)) || null;
  // The main counter (no outlet) is a selling point of its own: with "All
  // outlets" chosen, a parcel is the main counter's sale while its business
  // day is open (dayOpen is the main counter's day then). Only when the main
  // counter is not trading must the sale name one of the outlets.
  const needsOutlet =
    mayPickOutlet &&
    !outletStorage.get() &&
    activeOutlets.length > 0 &&
    !editingOrder &&
    cart.length > 0 &&
    dayOpen === false &&
    (orderType !== "dine_in" || Boolean(chosenTable && !chosenTable.outletId));

  const pricingOrderId = editingOrder ? editingOrder.id : null;
  const pricingTableId = !editingOrder && orderType === "dine_in" && tableId ? tableId : null;
  const offersAsked = useRef(0);

  useEffect(() => {
    if (!mayPickOutlet) {
      return;
    }

    listSaleOutlets()
      .then(setActiveOutlets)
      .catch(() => setActiveOutlets([]));
  }, [mayPickOutlet]);

  // Working at the chosen outlet from now on, exactly as the switcher at the
  // top does it (the page reloads; the unsaved cart is kept by posDraft).
  // Choosing "All outlets" again is only offered to someone without that
  // switcher, who has no other way back.
  const chooseOutlet = (value) => {
    if (String(value || "") === String(storedOutlet)) {
      return;
    }

    if (value) {
      outletStorage.set(value);
    } else {
      outletStorage.clear();
    }

    window.location.reload();
  };

  // "Sale at", one line under the order type: shown when the sale needs an
  // outlet picked, and always to someone without the switcher at the top once
  // the restaurant has outlets, so they can see and change where they sell.
  // Before, a box in the order's foot asked, and on a 1440 × 900 till it
  // squeezed the order's dishes almost out of view.
  const outletRow =
    mayPickOutlet && activeOutlets.length > 0 && !editingOrder && (needsOutlet || !hasTopSwitcher) ? (
      <label
        className={`pos-outlet-row ${needsOutlet ? "is-needed" : ""}`}
        title="Every bill belongs to an outlet: its GST, its cash drawer and its reports are that outlet's."
      >
        <span className="pos-outlet-label">
          <Icon name="store" size={15} />
          Sale at
        </span>
        <select
          aria-label="Outlet for this sale"
          value={activeOutlets.some((outlet) => String(outlet.id) === String(storedOutlet)) ? storedOutlet : ""}
          onChange={(event) => chooseOutlet(event.target.value)}
        >
          <option value="" disabled={needsOutlet}>
            {needsOutlet ? "Choose the outlet…" : "Main counter"}
          </option>
          {activeOutlets.map((outlet) => (
            <option key={outlet.id} value={outlet.id}>
              {outlet.name}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  const loadOffers = useCallback(() => {
    offersAsked.current += 1;
    const asked = offersAsked.current;

    return listOffers({ orderId: pricingOrderId, tableId: pricingTableId, orderType, channelId: orderType === "delivery" ? delivery.channelId : null })
      .then((rows) => {
        if (asked !== offersAsked.current) {
          return;
        }

        const next = new Map(rows.map((row) => [offerKey(row.productId, row.productVariantId), row]));

        setOffers(next);
        setCart((current) => repriceCart(current, next));
      })
      .catch(() => undefined);
  }, [pricingOrderId, pricingTableId, orderType, delivery.channelId]);

  const loadAvailability = useCallback(
    () =>
      getAvailability()
        .then(setAvailability)
        .catch(() => undefined),
    []
  );

  const loadBadges = useCallback(() => {
    const requests = canSeeRequests ? getTableRequestSummary().catch(() => null) : Promise.resolve(null);
    const bookings = canSeeBookings ? getReservationBoard().catch(() => null) : Promise.resolve(null);

    return Promise.all([requests, bookings]).then(([summary, board]) =>
      setBadges({
        qrOrders: summary ? summary.pendingOrders : 0,
        calls: summary ? summary.unansweredCalls : 0,
        arriving: arrivingSoon(board),
      })
    );
  }, [canSeeRequests, canSeeBookings]);

  useEffect(() => {
    if (!window.matchMedia) {
      return undefined;
    }

    const query = window.matchMedia(PHONE);
    const follow = (event) => setCompact(event.matches);

    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60000);

    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const refresh = setInterval(() => {
      loadOffers();
      loadAvailability();
      loadBadges();
    }, 60000);

    return () => clearInterval(refresh);
  }, [loadOffers, loadAvailability, loadBadges]);

  // Every open order, not the first fifty: a big hall with its takeaways can
  // have more, and a table that drops off this strip is a table forgotten. So
  // every running table comes first, then the newest takeaways; and the
  // counts in the heading are over every open order, not the ones shown.
  //
  // With them, every table joined to a party: read on its own because a
  // party whose bill is printed is not "open" any more, yet still sits at
  // both tables until it pays.
  const loadOpenOrders = useCallback(
    () =>
      Promise.all([
        // Today's: the live screens show the business day being traded. An
        // order left open from an earlier day is counted (earlierOpen) and
        // dealt with from the dashboard's "Earlier days" list.
        listOrders({ status: "open", limit: RUNNING_LIMIT, sort: "tables_first", age: "today" })
          .then((page) => {
            setOpenOrders(page.items);
            setOpenTotal(page.total);
            setOpenSummary(page.summary || null);
          })
          .catch(() => {
            setOpenOrders([]);
            setOpenTotal(0);
            setOpenSummary(null);
          }),
        listOrders({ status: "open", limit: 1, age: "earlier" })
          .then((page) => setEarlierOpen(page.total))
          .catch(() => setEarlierOpen(0)),
        listJoinedTables()
          .then((rows) => setJoins(rows))
          .catch(() => setJoins([])),
      ]),
    []
  );

  const refreshTables = () =>
    listTables()
      .then((rows) => setTables(rows.filter((row) => row.status === "active")))
      .catch(() => undefined);

  useEffect(() => {
    Promise.all([listCategories(), listProducts({ status: "active" }), listModifiers(), listTables()])
      .then(([categoryRows, productRows, modifierRows, tableRows]) => {
        setCategories(categoryRows.filter((row) => row.status === "active"));
        setProducts(productRows);
        setModifiers(modifierRows.filter((row) => row.status === "active"));
        setTables(tableRows.filter((row) => row.status === "active"));
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));

    getSettings()
      .then((loaded) => {
        setSettings(loaded);
        setCurrency(loaded.currencySymbol);
        setTaxMode(loaded.taxMode);
      })
      .catch(() => undefined);

    getServiceSettings()
      .then((loaded) => {
        setPosSetup({ posOrderTypes: loaded.posOrderTypes || ["dine_in", "takeaway", "delivery"], defaultOrderType: loaded.defaultOrderType || "dine_in" });
        // A fresh till starts on the format's kind of order; one already
        // holding an order (a draft, a table opened) keeps its own.
        setOrderType((current) => ((loaded.posOrderTypes || []).includes(current) ? current : loaded.defaultOrderType || current));
      })
      .catch(() => undefined);

    // Read through the orders API, which every order-taker may read. The
    // business-day screen's own endpoint needs business_day.view, which a
    // captain does not have.
    getServiceDay()
      .then((data) => {
        setDayOpen(Boolean(data.current));
        setBusinessDate(data.current ? data.current.businessDate : null);
      })
      .catch(() => undefined);

    listChannels()
      .then((rows) => setChannels(rows.filter((row) => row.status === "active")))
      .catch(() => undefined);

    loadOpenOrders();
    loadAvailability();
    loadBadges();
  }, [loadOpenOrders, loadAvailability, loadBadges]);

  // On opening, and whenever the order or table the prices are for changes.
  useEffect(() => {
    loadOffers();
  }, [loadOffers]);

  // Runs after the tables have loaded, so the picked table is one the screen
  // actually has.
  useEffect(() => {
    if (loading || arrivedFor.current) {
      return;
    }

    const orderId = params.get("order");
    const table = params.get("table");
    // ?bill=1 (the dashboard's "Bill"): straight on to the bill dialog.
    const toBill = params.get("bill") === "1";

    if (!orderId && !table) {
      return;
    }

    arrivedFor.current = true;

    if (orderId) {
      resumeOrder({ id: Number(orderId) }).then((order) => {
        if (order && toBill && canBill && ["open", "billed"].includes(order.orderStatus)) {
          openBill(order);
        }
      });
    } else {
      Promise.resolve().then(() => {
        setOrderType("dine_in");
        setTableId(table);
      });
    }

    setParams(new URLSearchParams(), { replace: true });
    // resumeOrder is recreated on every render and is only wanted once here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, params, setParams]);

  // A dish in a category that is switched off (breakfast after 11) is not on
  // sale, so it is not on the till either — "All" included.
  const brandCategories = useMemo(
    () => (brandId ? categories.filter((row) => !row.brandId || String(row.brandId) === brandId) : categories),
    [categories, brandId]
  );
  const liveCategoryIds = useMemo(() => new Set(brandCategories.map((row) => row.id)), [brandCategories]);
  const liveProducts = useMemo(
    () => products.filter((product) => liveCategoryIds.has(product.categoryId)),
    [products, liveCategoryIds]
  );

  // Name or short code, best match first (services/posSearch).
  const visibleProducts = useMemo(
    () =>
      searchDishes(
        liveProducts.filter((product) => !categoryId || String(product.categoryId) === categoryId),
        search
      ),
    [liveProducts, categoryId, search]
  );

  const soldOut = useMemo(
    () => new Set((availability ? availability.items : []).map((item) => soldOutKey(item.productId, item.productVariantId))),
    [availability]
  );
  const soldOutCount = availability ? availability.items.length + availability.switchedOff.length : 0;
  const joinedBy = useMemo(() => joinedTableMap(joins), [joins]);

  const dirty = isDirty(cart);
  const total = useMemo(() => cartTotal(cart, taxMode), [cart, taxMode]);
  const toCancel = useMemo(() => pendingCancellations(cart, taxMode), [cart, taxMode]);
  const cancelledEarlier = useMemo(() => takenOffEarlier(editingOrder), [editingOrder]);
  const newCount = cart.filter((line) => !line.saved).reduce((sum, line) => sum + line.quantity, 0);
  const lineCount = cart.filter((line) => line.quantity > 0).reduce((sum, line) => sum + line.quantity, 0);

  // The order's own details as the boxes hold them now.
  const currentHeader = {
    guestCount,
    notes: orderNotes,
    customerId: guestsOn && customer ? customer.id : null,
    customerName,
    customerMobile,
  };

  // The details the waiter changed on this screen, and only those, each with
  // what the screen showed (`seen`), so the server can refuse to overwrite
  // one another device changed meanwhile.
  const headerEdits = editingOrder ? headerChanges(seenHeader, currentHeader) : {};
  const headerChanged = Object.keys(headerEdits).length > 0;
  const deliveryChanged =
    Boolean(editingOrder) && editingOrder.orderType === "delivery" && canManageDelivery && !sameDelivery(delivery, seenDelivery);
  const unsaved = dirty || headerChanged || deliveryChanged;

  const currentTable = tables.find((table) => String(table.id) === String(tableId)) || null;
  const channel = channels.find((one) => String(one.id) === String(delivery.channelId)) || null;

  // Puts an order on the screen: the order, and its own details in the boxes.
  // With keepEdits (a fresher copy arriving while the waiter may be typing),
  // a detail the waiter is changing keeps the waiter's words; every other box
  // shows the order as it now is. Either way what the order says becomes what
  // this screen has seen. The cart is set by the caller.
  const showOrder = (order, { keepEdits = false } = {}) => {
    const fresh = headerOf(order);
    const next = keepEdits ? rebaseHeader(seenHeader, currentHeader, fresh) : fresh;
    const guestId = next.customerId;

    setEditingOrder(order);
    setSeenHeader(fresh);
    setGuestCount(next.guestCount);
    setOrderNotes(next.notes);
    setCustomerName(next.customerName);
    setCustomerMobile(next.customerMobile);
    setCustomer((shown) => {
      if (!guestId) {
        return null;
      }

      return shown && shown.id === guestId
        ? shown
        : { id: guestId, name: next.customerName || "Guest", mobile: next.customerMobile || null, loyaltyPoints: 0 };
    });

    if (!keepEdits) {
      setDelivery(deliveryOf(order));
    }

    setSeenDelivery(deliveryOf(order));

    if (guestId && canSeeGuests && guestId !== currentHeader.customerId) {
      // The points balance matters at billing time, so read the real one.
      getCustomerHistory(guestId)
        .then((history) => setCustomer((shown) => (shown && shown.id === guestId ? { ...shown, ...history.customer } : shown)))
        .catch(() => undefined);
    }

    return next;
  };

  // An open table on this screen keeps up with the floor while nobody here is
  // changing it: the kitchen's progress, a dish another till or a guest's QR
  // order added, a dish a manager took off, a note or a guest another device
  // put on it.
  useEffect(() => {
    if (!editingOrder || unsaved || saving) {
      return undefined;
    }

    let current = true;
    const refresh = setInterval(() => {
      getOrder(editingOrder.id)
        .then((fresh) => {
          if (current && fresh.orderStatus === "open") {
            showOrder(fresh, { keepEdits: true });
            setCart(cartFromOrder(fresh));
          }
        })
        .catch(() => undefined);
    }, 30000);

    return () => {
      current = false;
      clearInterval(refresh);
    };
    // showOrder is recreated on every render; the refresh is re-armed
    // whenever the order, or whether it is being changed, changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingOrder, unsaved, saving]);

  // ------------------------------------------------------------ the unsaved cart
  //
  // Kept per person in this tab (services/posDraft) whenever it changes, and
  // brought back when the same person signs in again on this till: a session
  // that ran out mid-order no longer loses eight dishes for table five.
  useEffect(() => {
    if (loading || !storageKey || restoredFor.current === storageKey) {
      return;
    }

    restoredFor.current = storageKey;

    const storage = readSession();
    const draft = loadDraft(storage, storageKey);

    if (!draft) {
      return;
    }

    restoring.current = true;

    const applyNew = () => {
      setOrderType(draft.orderType || "dine_in");
      setTableId(draft.tableId || "");
      setOverrideHold(Boolean(draft.overrideHold));
      setGuestCount(draft.guestCount || "");
      setCustomerName(draft.customerName || "");
      setCustomerMobile(draft.customerMobile || "");
      setCustomer(draft.customer || null);
      setOrderNotes(draft.orderNotes || "");
      setDelivery(draft.delivery || EMPTY_DELIVERY);
      setCart(draft.cart || []);
      setNotice("Your unsaved order is back, as you left it. Place it, or press New order to start again.");
    };

    const restore = draft.editingOrderId
      ? getOrder(draft.editingOrderId).then((fresh) => {
          if (fresh.orderStatus !== "open") {
            clearDraft(storage, storageKey);
            setNotice(`${fresh.orderNumber} was ${fresh.orderStatus} while you were away, so your unsaved changes to it were dropped.`);
            return;
          }

          // The order as it is now, with this screen's unsaved dishes and
          // typed details laid over it, exactly as after a clash with
          // another device.
          const freshHeader = headerOf(fresh);
          const boxes = rebaseHeader(draft.seenHeader || freshHeader, draft.header || freshHeader, freshHeader);

          setEditingOrder(fresh);
          setSeenHeader(freshHeader);
          setOrderType(fresh.orderType);
          setTableId(fresh.tableId ? String(fresh.tableId) : "");
          setGuestCount(boxes.guestCount);
          setOrderNotes(boxes.notes);
          setCustomerName(boxes.customerName);
          setCustomerMobile(boxes.customerMobile);
          setCustomer(boxes.customerId ? draft.customer || { id: boxes.customerId, name: boxes.customerName || "Guest", loyaltyPoints: 0 } : null);
          setSeenDelivery(deliveryOf(fresh));
          setDelivery(draft.delivery || deliveryOf(fresh));
          setCart(rebaseCart(fresh, draft.cart || []).cart);
          setNotice(`Your unsaved changes to ${fresh.orderNumber} are back. Check them and save.`);
        })
      : Promise.resolve().then(applyNew);

    restore
      .catch(() => clearDraft(storage, storageKey))
      .finally(() => {
        restoring.current = false;
      });
  }, [loading, storageKey]);

  useEffect(() => {
    if (!storageKey || restoredFor.current !== storageKey || restoring.current) {
      return;
    }

    saveDraft(readSession(), storageKey, {
      orderType,
      tableId,
      overrideHold,
      guestCount,
      customerName,
      customerMobile,
      customer,
      orderNotes,
      delivery,
      cart,
      editingOrderId: editingOrder ? editingOrder.id : null,
      seenHeader,
      header: currentHeader,
      headerChanged: headerChanged || deliveryChanged,
    });
    // currentHeader is rebuilt from the boxes on every render; the boxes are
    // the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, orderType, tableId, overrideHold, guestCount, customerName, customerMobile, customer, orderNotes, delivery, cart, editingOrder, seenHeader]);

  const resetCart = () => {
    setCart([]);
    setEditingOrder(null);
    setSeenHeader(headerOf(null));
    setTableId("");
    setOverrideHold(false);
    setGuestCount("");
    setCustomerName("");
    setCustomerMobile("");
    setCustomer(null);
    setOrderNotes("");
    setDelivery(EMPTY_DELIVERY);
    setSeenDelivery(EMPTY_DELIVERY);
    setOrderType(startType);
    setBusyOrder(null);
    setSheetOpen(false);
    setNotice("");
    clearDraft(readSession(), storageKey);
  };

  const variantsOf = useCallback(async (productId) => {
    if (!variantCache.current.has(productId)) {
      variantCache.current.set(productId, await listVariants(productId));
    }

    return variantCache.current.get(productId);
  }, []);

  const unavailable = (product) => offers.get(offerKey(product.id, null))?.isAvailable === false || !product.isAvailable || soldOut.has(soldOutKey(product.id, null));

  // Products with sizes or add-ons open a chooser; simple ones go straight in.
  const pickProduct = async (product) => {
    if (orderBilled) {
      setError("This order is billed. To add or change dishes, void its bill in Bills first.");
      return;
    }
    setError("");

    if (unavailable(product)) {
      setError(`${product.name}: ${offers.get(offerKey(product.id,null))?.unavailableReason || 'sold out'}`);
      return;
    }

    if (product.soldBy === "weight") {
      setWeighing(product);
      return;
    }

    pickingNow.current += 1;
    setPendingPicks((count) => count + 1);

    try {
      const [variants, productModifierIds] = await Promise.all([
        variantsOf(product.id),
        listProductModifiers(product.id),
      ]);

      const activeVariants = variants.filter((variant) => variant.status === "active");
      const onSale = activeVariants.filter((variant) => !soldOut.has(soldOutKey(product.id, variant.id)));
      const allowedModifiers = modifiers.filter((modifier) =>
        productModifierIds.includes(modifier.id)
      );

      if (activeVariants.length === 0 && allowedModifiers.length === 0 && !(product.addonGroups||[]).length && !(product.comboChoiceGroups||[]).length) {
        addToCart(product, null, [], 1, "");
        return;
      }

      const defaultVariant = onSale.find((variant) => variant.isDefault) || onSale[0];

      setPickVariantId(defaultVariant ? String(defaultVariant.id) : "");
      setPickModifierIds([]);
      setPickComboSelections([]);
      setPickQuantity(1);
      setPickNotes("");
      setPicking({ product, variants: activeVariants, modifiers: allowedModifiers });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      pickingNow.current = Math.max(0, pickingNow.current - 1);
      setPendingPicks((count) => Math.max(0, count - 1));
    }
  };

  const addToCart = (product, variant, chosenModifiers, quantity, notes, comboSelections=[]) => {
    const selectedModifiers=chosenModifiers.filter(m=>m.id!==null);
    const packagingCharge=Number(offers?.get(offerKey(product.id,variant?variant.id:null))?.packagingCharge||0);
    if(packagingCharge>0)selectedModifiers.push({id:null,name:'Packaging',price:packagingCharge});
    for(const part of comboParts(product.comboChoiceGroups,comboSelections))selectedModifiers.push({id:null,name:`${part.groupName}: ${part.name}${part.variantName?` (${part.variantName})`:''} ×${part.quantity}`,price:part.extraPrice});
    const modifierTotal = selectedModifiers.reduce((sum, modifier) => sum + Number(modifier.price), 0);
    // A happy-hour price is for this dish in this size, exactly as the server
    // charges it. Add-ons are still on top.
    const { unitPrice, offer } = unitPriceFor(product, variant, offers);

    setCart((current) =>
      addLine(current, {
        productId: product.id,
        productVariantId: variant ? variant.id : null,
        notes: notes || "",
        modifiers: selectedModifiers.map((modifier) => ({
          id: modifier.id,
          name: modifier.name,
          price: Number(modifier.price),
        })),
        name: product.name,
        variantName: variant ? variant.name : null,
        quantity,
        unitPrice,
        soldBy: product.soldBy || "unit",
        // The menu price in this size, to fall back on when a happy-hour
        // price stops applying (services/posPricing).
        menuPrice: unitPriceFor(product, variant, null).unitPrice,
        modifierTotal,
        taxPercentage: settings?.documentType==='bill_of_supply'?0:product.taxPercentage,
        priceIncludesTax: (product.taxMode && product.taxMode!=='default'?product.taxMode:taxMode)==='inclusive',
        comboSelections,
        priceWindowName: offer ? offer.windowName : null,
        // Coursing is not offered at the till: every dish goes to the
        // kitchen when the order is sent.
        courseNo: 1,
        courseName: null,
        holdCourse: false,
      })
    );
  };

  // "Repeat" on one of a regular's last orders (SW-A-18): the same dishes,
  // sizes and add-ons go into the cart at today's prices. A dish no longer
  // on the menu, sold out, in a size no longer sold, or a combo whose
  // choices must be picked again is skipped, and the cashier is told which.
  const repeatOrder = async (past) => {
    setError("");
    const skipped = [];
    let added = 0;

    pickingNow.current += 1;
    setPendingPicks((count) => count + 1);

    try {
      for (const item of past.items) {
        const label = `${item.name}${item.variantName ? ` (${item.variantName})` : ""}`;
        const product = products.find((row) => row.id === item.productId);

        if (!product) {
          skipped.push(`${label}: no longer on the menu`);
          continue;
        }

        if (item.hasComboChoices || (product.comboChoiceGroups || []).length > 0) {
          skipped.push(`${label}: pick its choices again`);
          continue;
        }

        if (unavailable(product)) {
          skipped.push(`${label}: sold out`);
          continue;
        }

        let variant = null;

        if (item.productVariantId) {
          variant =
            (await variantsOf(product.id)).find((row) => row.id === item.productVariantId && row.status === "active") || null;

          if (!variant) {
            skipped.push(`${label}: that size is no longer sold`);
            continue;
          }

          if (soldOut.has(soldOutKey(product.id, variant.id))) {
            skipped.push(`${label}: sold out`);
            continue;
          }
        }

        const chosen = (item.modifierIds || [])
          .map((id) => modifiers.find((modifier) => modifier.id === id && modifier.status !== "inactive"))
          .filter(Boolean);

        if (chosen.length < (item.modifierIds || []).length) {
          skipped.push(`an add-on on ${label}: no longer offered`);
        }

        addToCart(product, variant, chosen, item.quantity, item.notes || "");
        added += 1;
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      pickingNow.current = Math.max(0, pickingNow.current - 1);
      setPendingPicks((count) => Math.max(0, count - 1));
    }

    setNotice(
      [
        added > 0
          ? `${past.orderNumber} repeated: ${added} ${added === 1 ? "dish" : "dishes"} added at today's prices.`
          : `Nothing from ${past.orderNumber} could be added.`,
        skipped.length > 0 ? `Skipped ${skipped.join("; ")}.` : null,
      ]
        .filter(Boolean)
        .join(" ")
    );
  };

  const confirmPick = () => {
    const invalid=choiceError(picking.product.addonGroups,pickModifierIds)||comboError(picking.product.comboChoiceGroups,pickComboSelections);
    if(invalid){setError(invalid);return;}
    const variant = picking.variants.find((row) => String(row.id) === pickVariantId) || null;
    const chosen = picking.modifiers.filter((modifier) => pickModifierIds.includes(modifier.id));

    addToCart(picking.product, variant, chosen, Number(pickQuantity), pickNotes,pickComboSelections);
    setPicking(null);
  };

  // One more of a dish already on the order: a new line at today's price, on
  // its own KOT, never a change to the line the kitchen already has.
  const addMoreOf = async (line) => {
    if (orderBilled) {
      setError("This order is billed. To add or change dishes, void its bill in Bills first.");
      return;
    }
    const product = products.find((row) => row.id === line.productId);
    if(product?.comboChoiceGroups?.length){await pickProduct(product);return;}

    if (!product) {
      setError(`${line.name} is no longer on the menu`);
      return;
    }

    if (unavailable(product) || (line.productVariantId && soldOut.has(soldOutKey(product.id, line.productVariantId)))) {
      setError(`${line.name}${line.variantName ? ` (${line.variantName})` : ""} is sold out`);
      return;
    }

    pickingNow.current += 1;
    setPendingPicks((count) => count + 1);

    try {
      const variant = line.productVariantId
        ? (await variantsOf(product.id)).find((row) => row.id === line.productVariantId) || null
        : null;

      addToCart(product, variant, line.modifiers, 1, line.notes);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      pickingNow.current = Math.max(0, pickingNow.current - 1);
      setPendingPicks((count) => Math.max(0, count - 1));
    }
  };

  // A line sold by weight (kg): its own flag, or its dish's when the line came
  // back from a saved order.
  const weighedLine = (line) => line.soldBy === "weight" || products.find((one) => one.id === line.productId)?.soldBy === "weight";

  const changeQuantity = (line, delta) => {
    if (orderBilled) {
      setError("This order is billed. To add or change dishes, void its bill in Bills first.");
      return;
    }
    const next = stepLine(cart, line.key, delta);

    if (next === null) {
      addMoreOf(line);
      return;
    }

    setCart(next);
  };

  const header = () => ({
    guestCount: guestCount ? Number(guestCount) : null,
    customerId: guestsOn && customer ? customer.id : null,
    customerName: customerName || null,
    customerMobile: customerMobile || null,
    notes: orderNotes || null,
  });

  // The saved order is the truth: what the waiter changed is in it, and so is
  // whatever another device changed that this screen did not touch. Every box
  // shows it, so the next save starts from what is really on the order.
  const afterSave = (saved) => {
    showOrder(saved);
    setCart(cartFromOrder(saved));
    setNotice("");
    loadOpenOrders();
    refreshTables();
  };

  const dishesText = (dishes) => dishes.map((dish) => `${dish.quantity} × ${dish.name}`).join(", ");

  const takenCount = (saved) =>
    saved && saved.changes && saved.changes.cancelled ? saved.changes.cancelled.filter((row) => row.afterKot).length : 0;

  // Saves a change to the running order: only what the waiter changed.
  //
  // Someone who may take a dish the kitchen has off does it in one save. For
  // anyone else each such dish is saved on its own first, with its own
  // manager approval, so the manager is shown and approves exactly one dish
  // at a time ("Take off 1 × Paneer Tikka on ORD-0412"); then the rest.
  // Throws with `settledIds` (the lines already saved) when it stops part of
  // the way through.
  const saveChanges = async (reason) => {
    const reasonFields = reason ? { cancelReason: reason.code, cancelNote: reason.note || undefined } : {};
    const groups = canCancelAfterKot ? [] : cancellationGroups(cart, taxMode);
    const separately = groups.length > 1 ? groups : [];
    const settledIds = new Set();
    let saved = editingOrder;
    let taken = 0;

    try {
      for (const group of separately) {
        saved = await withApproval(
          (headers) => updateOrderItems(editingOrder.id, { items: group.items, ...reasonFields }, headers),
          `Take off ${dishesText(group.dishes)} on ${editingOrder.orderNumber}`
        );
        taken += takenCount(saved);
        group.items.forEach((item) => settledIds.add(item.id));
      }

      const rest = buildItems(cart).filter((item) => !item.id || !settledIds.has(item.id));
      const fields = headerEdits;

      if (rest.length > 0 || Object.keys(fields).length > 0) {
        const cancelling = pendingCancellations(cart, taxMode).filter((dish) => !settledIds.has(dish.id));

        saved = await withApproval(
          (headers) => updateOrderItems(editingOrder.id, { ...fields, items: rest, ...reasonFields }, headers),
          cancelling.length
            ? `Take off ${dishesText(cancelling)} on ${editingOrder.orderNumber}`
            : `Save ${editingOrder.orderNumber}`
        );
        taken += takenCount(saved);
      }
    } catch (error) {
      error.settledIds = settledIds;
      throw error;
    }

    return { saved, taken };
  };

  // Another device changed the order since this screen read it, and the
  // server refused rather than let either undo the other. The order is read
  // again; the dishes this screen was adding stay in the cart, and so does
  // any reduction whose line nobody else touched.
  const reloadAfterConflict = async (message, settledIds = new Set()) => {
    try {
      const fresh = await getOrder(editingOrder.id);
      const base = cart.map((line) => (settledIds.has(line.id) ? { ...line, quantity: line.savedQuantity } : line));
      const rebased = rebaseCart(fresh, base);
      const shown = showOrder(fresh, { keepEdits: true });
      const keptDetails = Object.keys(headerChanges(headerOf(fresh), shown)).length > 0;
      const kept = [
        rebased.cart.some((line) => !line.saved) && "the dishes you were adding are still in the cart",
        keptDetails && "what you typed is still in the boxes",
      ].filter(Boolean);

      setCart(rebased.cart);
      loadOpenOrders();
      setError(`${message} The order is reloaded as it is now${kept.length ? `; ${kept.join(", and ")}` : ""}.`);
    } catch {
      setError(message);
    }
  };

  // Where a delivery is going, saved onto the order after it is placed (or
  // changed). The order is already safe if this fails; the message says so.
  const saveDelivery = async (saved) => {
    if (saved.orderType !== "delivery" || !canManageDelivery) {
      return { saved, problem: null };
    }

    const payload = deliveryPayload(delivery);
    const anything = Object.values(payload).some((value) => value !== null);

    if (!anything && !editingOrder) {
      return { saved, problem: null };
    }

    if (editingOrder && sameDelivery(delivery, seenDelivery)) {
      return { saved, problem: null };
    }

    try {
      await updateDelivery(saved.id, payload);
      // Read again for the delivery details; what the save said about the
      // guest stays with it.
      return {
        saved: { ...(await getOrder(saved.id)), guestAdded: saved.guestAdded, guestNotice: saved.guestNotice },
        problem: null,
      };
    } catch (err) {
      return { saved, problem: `${saved.orderNumber} is saved, but its delivery details were not: ${getErrorMessage(err)}` };
    }
  };

  // Saves the order: a new one whole, a running one as only what changed.
  // Taking off a dish the kitchen already has first asks why; `reason` is
  // that answer. Returns the saved order, or null when nothing was saved.
  const saveOrder = async (reason = null, then = "save", hold = overrideHold) => {
    setError("");
    setBusyOrder(null);

    if (pendingPicks > 0 || pickingNow.current > 0) {
      setError("A dish you just tapped is still being added. Wait a moment, then press again.");
      return null;
    }

    if (needsOutlet) {
      setError("Pick the outlet this sale is for first.");
      return null;
    }

    const cancelling = editingOrder ? pendingCancellations(cart, taxMode) : [];

    if (cancelling.length > 0 && !reason) {
      setCancelReason("");
      setCancelNote("");
      setCancelPrompt({ dishes: cancelling, then });
      return null;
    }

    setSaving(true);

    try {
      let saved;
      let taken = 0;

      if (editingOrder) {
        if (dirty || headerChanged) {
          ({ saved, taken } = await saveChanges(reason));
        } else {
          saved = editingOrder;
        }
      } else {
        saved = await createOrder({
          orderType,
          channelId: orderType === "delivery" && delivery.channelId ? Number(delivery.channelId) : null,
          brandId: brandsOn && brandId ? Number(brandId) : null,
          tableId: orderType === "dine_in" && tableId ? Number(tableId) : null,
          overrideHold: orderType === "dine_in" ? hold : false,
          // Where the order came from: a delivery channel, the captain's
          // phone, or the counter.
          source: orderType === "delivery" ? sourceForChannel(channel) : compact ? "captain" : "pos",
          ...header(),
          items: buildItems(cart),
        });
      }

      const delivered = await saveDelivery(saved);

      saved = delivered.saved;

      setSuccess(
        [
          `${saved.orderNumber} saved`,
          // The parcel's token, for the guest's slip and the pickup screen.
          saved.tokenNo ? `Token ${saved.tokenNo}` : null,
          moneyExact(saved.totalAmount, currency),
          taken ? `${plural(taken, "dish", "dishes")} cancelled` : null,
          saved.guestAdded ? `${saved.guestAdded.name} added to the guest book` : saved.guestNotice || null,
        ]
          .filter(Boolean)
          .join(" · ")
      );

      if (delivered.problem) {
        setError(delivered.problem);
      }

      afterSave(saved);
      setSheetOpen(false);

      if (then === "print") {
        await printNewTickets(saved);
      }

      // A dish taken off a ticket the kitchen holds on paper: its CANCEL slip
      // prints now, whatever the button was.
      if (editingOrder) {
        await printSlipsFor([saved.id]);
      }

      return saved;
    } catch (err) {
      const details = err.response?.data?.data || {};
      const settledIds = err.settledIds || new Set();
      // Part of the change went through (a dish approved before the manager
      // said no to the next): the screen must show the order as it now is.
      const partly = settledIds.size > 0;

      if (err.approvalCancelled) {
        const message = partly
          ? "The dishes the manager approved are off; nothing else was changed, because the next approval was cancelled."
          : "Nothing was changed: the manager's approval was cancelled.";

        if (partly) {
          await reloadAfterConflict(message, settledIds);
        } else {
          setError(message);
        }
      } else if (details.reason === "cancel_reason_required") {
        // The kitchen took the dish while the waiter was editing.
        setCancelPrompt({
          dishes: details.dishes.map((dish) => ({ ...dish, name: dish.itemName })),
          then,
        });
      } else if (details.reason === "table_held") {
        // Booked since the table was chosen: the same question as choosing it.
        setHeldConfirm({ message: getErrorMessage(err), then, retry: true });
      } else if (details.reason === "sold_out") {
        loadAvailability();
        setError(getErrorMessage(err));
      } else if (details.reason === "table_busy") {
        setBusyOrder({ id: details.orderId, orderNumber: details.orderNumber });
        setError(getErrorMessage(err));
      } else if (["order_changed", "stale_order"].includes(details.reason) && editingOrder) {
        await reloadAfterConflict(getErrorMessage(err), settledIds);
      } else if (partly) {
        await reloadAfterConflict(getErrorMessage(err), settledIds);
      } else {
        setError(getErrorMessage(err));
      }

      return null;
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------ KOTs

  // A change the kitchen may be cooking from paper for (a dish taken off, the
  // party moved to another table) prints its CANCEL or TABLE CHANGED slip on
  // this till at once (services/kotSlips). Only tickets that were printed and
  // are not yet served get one, and each slip prints once.
  const printSlipsFor = async (orderIds) => {
    const result = await printChangeSlips(orderIds, {
      restaurantName: user.restaurantName,
      paperWidth: settings && settings.printPaperWidth ? settings.printPaperWidth : "80mm",
    });

    if (result.note) {
      setSuccess((shown) => withNote(shown, result.note));
    }

    if (result.problem) {
      setError(result.problem);
    }
  };

  const ticketIds = async (orderId) => {
    try {
      return new Set((await getOrderTickets(orderId)).map((ticket) => ticket.id));
    } catch {
      return new Set();
    }
  };

  // Prints new KOTs: after a save, the ones that save cut; with nothing to
  // save, every one nobody has printed yet (services/posKot ticketsToPrint).
  // One slip per station, the way the pass reads them. Each is counted as
  // printed, so a second print of the same ticket says REPRINT on the paper.
  const printNewTickets = async (saved) => {
    const before = printBefore.current;

    printBefore.current = null;

    try {
      const tickets = await getOrderTickets(saved.id);
      const fresh = ticketsToPrint(tickets, before);

      if (fresh.length === 0) {
        setSuccess((shown) =>
          withNote(
            shown,
            before
              ? "nothing new for the kitchen to print"
              : `every KOT of ${saved.orderNumber} has been printed already, nothing new to print`
          )
        );
        return;
      }

      for (const ticket of fresh) {
        let stamped = ticket;

        try {
          stamped = await recordTicketPrint(ticket.id);
        } catch {
          // Printed all the same; the count is only a record.
        }

        printKot(stamped, {
          restaurantName: user.restaurantName,
          paperWidth: settings && settings.printPaperWidth ? settings.printPaperWidth : "80mm",
        });
      }

      setSuccess((shown) =>
        withNote(shown, `${plural(fresh.length, "KOT", "KOTs")} printed (${fresh.map((ticket) => ticket.kotNo).join(", ")})`)
      );
    } catch (err) {
      setError(`${before ? "Saved, but the" : "The"} KOT could not be printed: ${getErrorMessage(err)}`);
    }
  };

  const saveAndPrint = async () => {
    setError("");

    if (editingOrder && !unsaved) {
      // Nothing to save: print what the kitchen has not had on paper yet.
      setSuccess("");
      printBefore.current = null;
      await printNewTickets(editingOrder);
      // And any change slip of the order nobody printed yet.
      await printSlipsFor([editingOrder.id]);
      return;
    }

    printBefore.current = editingOrder ? await ticketIds(editingOrder.id) : new Set();
    await saveOrder(null, "print");
  };

  // ------------------------------------------------------------ the floor

  const resumeOrder = async (summary) => {
    setError("");
    setBusyOrder(null);

    try {
      const order = await getOrder(summary.id);

      showOrder(order);
      setOrderType(order.orderType);
      if (order.brandId) setBrandId(String(order.brandId));
      setTableId(order.tableId ? String(order.tableId) : "");
      setOverrideHold(false);
      setNotice("");
      // Live lines only: a dish that was cancelled is never back in the cart.
      setCart(cartFromOrder(order));
      setTablePicker(false);
      return order;
    } catch (err) {
      setError(getErrorMessage(err));
      return null;
    }
  };

  // A table tapped for a new order. A table with guests opens their order; a
  // table held for a booking asks first.
  const chooseTable = (table, info) => {
    if (info.orderId) {
      resumeOrder({ id: info.orderId });
      return;
    }

    if (info.state === "held") {
      setHeldConfirm({
        table,
        message: `Table ${table.tableNo} is ${heldSentence(info.booking)}. Seat this party there anyway?`,
      });
      return;
    }

    setTableId(String(table.id));
    setOverrideHold(false);
    setTablePicker(false);
  };

  const confirmHeld = async () => {
    const confirm = heldConfirm;

    setHeldConfirm(null);
    setOverrideHold(true);

    if (confirm.table) {
      setTableId(String(confirm.table.id));
      setTablePicker(false);
    }

    if (confirm.retry) {
      const saved = await saveOrder(null, confirm.then || "save", true);

      if (saved && confirm.then === "bill") {
        await openBill(saved);
      }
    }
  };

  const afterMove = (data, message) => {
    const next = data.mode === "dishes" && data.from ? data.from : data.order;

    setMoveDialog(null);
    setSuccess(message);
    setError("");
    // The kitchen's paper tickets now cook for another table.
    printSlipsFor([data.order && data.order.id, data.from && data.from.id, data.toOrderId, data.fromOrderId]);

    if (next && next.orderStatus === "open") {
      showOrder(next);
      setCart(cartFromOrder(next));
      setTableId(next.tableId ? String(next.tableId) : "");
    } else {
      resetCart();
    }

    loadOpenOrders();
    refreshTables();
  };

  const unjoin = async () => {
    const table = unjoining;

    setUnjoining(null);
    setSaving(true);

    try {
      const result = await unjoinOrderTable(editingOrder.id, table.tableId);

      setSuccess(result.message);
      showOrder(result.data.order);
      setCart(cartFromOrder(result.data.order));
      loadOpenOrders();
      refreshTables();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------ billing

  // The bill of an order: raised now, or — for an order already billed (a
  // table waiting to pay) — the one it already has. Coupons, points, a till
  // discount, service charge and payment are then done on that same bill in
  // the bill dialog, which never voids a bill to change it.
  const openBill = async (order) => {
    setError("");
    setSaving(true);

    try {
      let opened = null;

      if (order.orderStatus === "billed") {
        const page = await listBills({ orderId: order.id, status: "unpaid,partial" });

        if (page.items.length > 0) {
          opened = await getBill(page.items[0].id);
        }
      }

      setBill(opened || (await createBill({ orderId: order.id })));
      // On a phone the order sheet steps aside: the bill takes the screen.
      setSheetOpen(false);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Saving and billing in one step, because that is how a counter works. Any
  // change on the screen is saved first, so the bill is always what the
  // screen shows.
  const startBilling = async () => {
    const order = editingOrder && !unsaved ? editingOrder : await saveOrder(null, "bill");

    if (order) {
      await openBill(order);
    }
  };

  // The reason is given: save, and carry on to the bill (or the KOT printer)
  // if that is where the waiter was going.
  const confirmCancellation = async () => {
    const prompt = cancelPrompt;

    setCancelPrompt(null);

    const saved = await saveOrder({ code: cancelReason, note: cancelNote.trim() }, prompt.then);

    if (saved && prompt.then === "bill") {
      await openBill(saved);
    }
  };

  // A change on the bill. Points spent or given back change the guest's
  // balance, so the guest shown is read again.
  const billChanged = (updated) => {
    const before = bill;

    setBill(updated);

    if (customer && canSeeGuests && before && updated.loyaltyPointsUsed !== before.loyaltyPointsUsed) {
      getCustomerHistory(customer.id)
        .then((history) => setCustomer((shown) => ({ ...shown, ...history.customer })))
        .catch(() => undefined);
    }
  };

  // Settled: the table is free again. The counter's receipt prints by itself
  // when the settings say so — counted like every print, and only when the
  // bill was never printed: a guest who already holds it needs no second copy.
  const billSettled = async (settled) => {
    setSuccess(`${settled.billNumber} settled · ${moneyExact(settled.totalAmount, currency)}`);
    loadOpenOrders();
    refreshTables();

    if (settings && settings.autoPrintBill && !settled.isComplimentary && Number(settled.printCount || 0) === 0) {
      try {
        setBill(await printCountedBill(settled, { settings, currency }));
      } catch (err) {
        setError(getErrorMessage(err));
      }
    }
  };

  const closeBill = () => {
    setBill(null);

    if (bill && bill.billStatus === "paid") {
      resetCart();
    }
  };

  if (loading) {
    return <Loading />;
  }

  // Over every open order, not only the ones on the strip.
  const shownTables = openOrders.filter((order) => order.tableNo).length;
  const runningTables = openSummary ? openSummary.onTables : shownTables;
  const runningOther = openSummary ? openSummary.other : openOrders.length - shownTables;
  const onTheFloor = openSummary
    ? openSummary.amount
    : openOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
  const cancelTotal = cancelPrompt ? cancelPrompt.dishes.reduce((sum, dish) => sum + (dish.amount || 0), 0) : 0;
  const needTable = compact && orderType === "dine_in" && !tableId && !editingOrder;
  const onTable = editingOrder && editingOrder.tableId;
  const canMove = Boolean(onTable) && ["open", "billed"].includes(editingOrder.orderStatus);

  // ------------------------------------------------------------ pieces of the screen

  const badgeLinks = (
    <div className="pos-badges">
      {badges.qrOrders > 0 && (
        <Link to="/table-requests" className="pos-badge pos-badge-qr">
          <Icon name="qr" size={15} />
          <span>
            <strong>{badges.qrOrders}</strong> QR {badges.qrOrders === 1 ? "order" : "orders"} waiting
          </span>
        </Link>
      )}
      {badges.calls > 0 && (
        <Link to="/table-requests" className="pos-badge pos-badge-call">
          <Icon name="bell" size={15} />
          <span>
            <strong>{badges.calls}</strong> {badges.calls === 1 ? "table" : "tables"} calling
          </span>
        </Link>
      )}
      {badges.arriving.length > 0 && (
        <Link
          to="/reservations"
          className="pos-badge pos-badge-booking"
          title={badges.arriving.map((booking) => `${booking.startTime} ${booking.guestName} (${booking.partySize})${booking.tableNo ? ` on ${booking.tableNo}` : ""}`).join("\n")}
        >
          <Icon name="calendar" size={15} />
          <span>
            <strong>{badges.arriving.length}</strong> {badges.arriving.length === 1 ? "booking" : "bookings"} due soon
          </span>
        </Link>
      )}
      <button type="button" className={`pos-badge pos-badge-soldout ${soldOutCount > 0 ? "has-items" : ""}`} onClick={() => setSoldOutPanel(true)}>
        <Icon name="ban" size={15} />
        {soldOutCount > 0 ? (
          <span>
            <strong>{soldOutCount}</strong> sold out
          </span>
        ) : (
          <span>Nothing sold out</span>
        )}
      </button>
      {canSwitchDishes && (
        <button
          type="button"
          className={`pos-badge pos-badge-mode ${soldOutMode ? "is-on" : ""}`}
          aria-pressed={soldOutMode}
          onClick={() => setSoldOutMode((value) => !value)}
          title="Show a sold-out switch on every dish"
        >
          <Icon name="edit" size={15} />
          <span>{soldOutMode ? "Done marking" : "Mark sold out"}</span>
        </button>
      )}
    </div>
  );

  const stripOrders = openOrders.filter((order) =>
    stripKind === "tables" ? Boolean(order.tableNo) : stripKind === "other" ? !order.tableNo : true
  );
  const topActions = (
    <span className="pos-strip-actions">
      {badgeLinks}
      <button type="button" className="button button-secondary button-sm" onClick={resetCart}>
        <Icon name="plus" size={15} />
        New order
      </button>
    </span>
  );
  const runningStrip = (openOrders.length > 0 || earlierOpen > 0) && (
    <section className={`running-strip ${stripOpen ? "is-open" : "is-folded"}`}>
      <div className="running-head">
        <button
          type="button"
          className="pos-strip-title pos-strip-toggle"
          onClick={toggleStrip}
          aria-expanded={stripOpen}
          title={stripOpen ? "Fold the running orders into one line" : "Show every running order"}
        >
          <span className="pos-strip-icon" aria-hidden="true">
            <Icon name="activity" size={17} />
          </span>
          <h2>Still running</h2>
          <Icon name={stripOpen ? "chevron-up" : "chevron-down"} size={16} />
        </button>
        <span className="pos-strip-counts">
          <span className="pos-count">
            <Icon name="table" size={14} />
            {plural(runningTables, "table", "tables")}
          </span>
          {runningOther > 0 && (
            <span className="pos-count">
              <Icon name="box" size={14} />
              {runningOther} takeaway &amp; delivery
            </span>
          )}
          <span className="pos-count is-money">
            <Icon name="wallet" size={14} />
            {moneyExact(onTheFloor, currency)} on the floor
          </span>
          {earlierOpen > 0 && (
            <Link className="pos-count is-earlier" to="/?panel=running.earlier" title="Bill or cancel them">
              <Icon name="alert" size={14} />
              {earlierOpen} from earlier days
            </Link>
          )}
        </span>
        {!compact && topActions}
      </div>

      {stripOpen && openOrders.length > 0 && (
        <div className="segmented pos-strip-kinds" role="radiogroup" aria-label="Which running orders">
          {[
            ["all", "All"],
            ["tables", "Tables"],
            ["other", "Takeaway & delivery"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={stripKind === key}
              className={`segment ${stripKind === key ? "is-active" : ""}`}
              onClick={() => setStripKind(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {stripOpen && openTotal > openOrders.length && (
        <p className="muted small oc-running-more">
          {shownTables >= runningTables
            ? `Every running table is here, with the newest ${openOrders.length - shownTables} of ${runningOther} takeaway & delivery orders.`
            : `Showing ${openOrders.length} of ${openTotal} open orders.`}{" "}
          The rest are under Orders → Open.
        </p>
      )}

      {stripOpen && (
      <ul className="open-orders">
        {stripOrders.map((order) => {
          const sitting = order.placedAt ? minutesSince(order.placedAt, now) : 0;

          return (
            <li key={order.id}>
              <button
                type="button"
                className={`open-order ${sitting >= LINGERING_MINUTES ? "is-lingering" : ""} ${
                  editingOrder && editingOrder.id === order.id ? "oc-open-order-current" : ""
                }`}
                onClick={() => resumeOrder(order)}
              >
                <span className="open-order-where">
                  {order.tokenNo && !order.tableNo ? `#${order.tokenNo} · ` : ""}
                  {orderWhere(order)}
                </span>
                <span className="open-order-money">{moneyExact(order.totalAmount, currency)}</span>
                <span className="open-order-ref">
                  <Icon name="clock" size={12} />
                  {order.placedAt ? elapsed(order.placedAt, now) : order.orderNumber}
                  {order.dishCount || order.itemCount
                    ? ` · ${plural(order.dishCount || order.itemCount, "dish", "dishes")}`
                    : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      )}
    </section>
  );

  const brandBar = brandsOn && brands.length > 0 && (
    <div className="pos-brands" role="radiogroup" aria-label="Brand this order is for">
      {brands.map((brand) => (
        <button key={brand.id} type="button" role="radio" aria-checked={brandId === String(brand.id)} disabled={Boolean(editingOrder)}
          className={`pos-brand ${brandId === String(brand.id) ? "is-on" : ""}`} style={{ "--brand-color": brand.color || undefined }}
          onClick={() => { setBrandId(String(brand.id)); setCategoryId(""); }}>
          <span className="br-dot" style={{ background: brand.color || "var(--primary)" }} aria-hidden="true" />{brand.name}
        </button>
      ))}
    </div>
  );

  const categoryTabs = (
    <>
    {brandBar}
    <div className="pos-cat-tabs" role="tablist" aria-label="Menu categories">
      <button type="button" role="tab" aria-selected={!categoryId} className={`pos-cat-tab ${!categoryId ? "is-active" : ""}`} onClick={() => setCategoryId("")}>
        All
      </button>
      {brandCategories.map((category) => (
        <button
          type="button"
          role="tab"
          key={category.id}
          aria-selected={categoryId === String(category.id)}
          className={`pos-cat-tab ${categoryId === String(category.id) ? "is-active" : ""}`}
          onClick={() => setCategoryId(String(category.id))}
        >
          {category.name}
        </button>
      ))}
    </div>
    </>
  );

  const searchBox = (
    <label className="field pos-search">
      <span className="sr-only">Find a dish</span>
      <span className="input-with-icon">
        <Icon name="search" size={18} className="input-icon" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            // A short code and Enter puts the dish straight on the order.
            if (event.key === "Enter") {
              event.preventDefault();
              const found = dishByCode(liveProducts, search) || (visibleProducts.length === 1 ? visibleProducts[0] : null);

              if (found) {
                pickProduct(found);
                setSearch("");
              }
            }
          }}
          type="search"
          placeholder={compact ? "Dish name or code" : "Dish name or code (PT01), Enter to add"}
          aria-label="Find a dish by name or short code"
        />
      </span>
    </label>
  );

  const inCart = (productId) =>
    cart.filter((line) => !line.saved && line.productId === productId).reduce((sum, line) => sum + line.quantity, 0);

  const soldOutModeBar = canSwitchDishes && soldOutMode && (
    <div className="alert alert-notice pos-soldout-mode" role="status">
      <span>
        <Icon name="ban" size={15} /> Tap <Icon name="ban" size={13} /> on a dish to mark it sold out (or back on sale).
      </span>
      <button type="button" className="button button-sm" onClick={() => setSoldOutMode(false)}>
        Done
      </button>
    </div>
  );

  const dishCards = (
    <div className={`${compact ? "pos-dish-list" : "product-grid pos-dish-grid"} ${soldOutMode ? "is-soldout-mode" : ""}`}>
      {visibleProducts.map((product) => {
        const { unitPrice, offer } = unitPriceFor(product, null, offers);
        const todayOut = soldOut.has(soldOutKey(product.id, null));
        const out = unavailable(product) || todayOut;
        const sizesOut = (availability ? availability.items : []).filter(
          (item) => item.productId === product.id && item.productVariantId
        );
        const count = inCart(product.id);

        return (
          <div className={`pos-dish ${out ? "is-out" : ""} ${count > 0 ? "is-in-order" : ""}`} key={product.id}>
            <button
              type="button"
              className={`product-card pos-dish-button ${out ? "sold-out" : ""}`}
              onClick={() => pickProduct(product)}
              disabled={out}
            >
              {product.imagePath && !compact && (
                <img className="product-photo" src={uploadUrl(product.imagePath)} alt="" loading="lazy" />
              )}
              <span className="pos-dish-name">
                <span
                  className={`pos-food pos-food-${product.foodType}`}
                  title={product.foodType === "veg" ? "Veg" : product.foodType === "egg" ? "Egg" : product.foodType === "non_veg" ? "Non-veg" : undefined}
                  aria-hidden="true"
                />
                <span className="product-name" title={product.name}>{product.name}</span>
              </span>
              <span className="product-price">
                <span className="pos-dish-price">{moneyExact(unitPrice, currency)}{product.soldBy === "weight" && <small>/kg</small>}</span>
                {offer && <s className="muted was-price">{moneyExact(product.price, currency)}</s>}
                {product.code && <span className="pos-dish-code">{product.code}</span>}
              </span>
              {(offer || out || sizesOut.length > 0 || (!compact && count > 0)) && (
                <span className="pos-dish-tags">
                  {offer && <span className="oc-offer-tag">{offer.windowName}</span>}
                  {out && <span className="pos-out-tag">{todayOut ? "Sold out today" : "Switched off"}</span>}
                  {!out && sizesOut.length > 0 && (
                    <span className="pos-out-tag is-partial">{sizesOut.map((item) => item.variantName).join(", ")} sold out</span>
                  )}
                  {!compact && count > 0 && <span className="pos-dish-count">{count} in order</span>}
                </span>
              )}
              {compact && !out && (
                <span className="pos-dish-add" aria-hidden="true">
                  {count > 0 ? count : <Icon name="plus" size={18} />}
                </span>
              )}
            </button>
            {canSwitchDishes && soldOutMode && (
              <button
                type="button"
                className={`pos-dish-switch ${out ? "is-out" : ""}`}
                onClick={() => setDishSwitch(product)}
                aria-label={out ? `Put ${product.name} back on sale` : `Mark ${product.name} sold out`}
                title={out ? "Back on sale" : "Sold out today"}
              >
                <Icon name="ban" size={15} />
              </button>
            )}
          </div>
        );
      })}
      {visibleProducts.length === 0 && (
        <div className="pos-no-dish">
          <EmptyState
            icon="search"
            message={search.trim() ? `No dish is called or coded "${search.trim()}".` : "No dishes in this category."}
            hint={search.trim() ? "Check the spelling, or type the dish's short code." : "Pick another category, or All."}
          />
        </div>
      )}
    </div>
  );

  const tableField =
    orderType === "dine_in" &&
    (editingOrder ? (
      <div className="pos-where">
        <div className="pos-where-head">
          <span className="pos-where-icon" aria-hidden="true">
            <Icon name="table" size={18} />
          </span>
          <span className="pos-where-text">
            <span className="pos-where-table">Table {tablesText(editingOrder) || "—"}</span>
            <span className="muted small pos-where-order">
              {editingOrder.orderNumber}
              <span className={`pos-saved-dot ${unsaved ? "is-unsaved" : ""}`} aria-hidden="true" />
              {unsaved ? "Unsaved changes" : "Saved"}
            </span>
          </span>
          {editingOrder.orderStatus === "billed" && (
            <span className="badge badge-warning status-badge">
              <span className="badge-dot" />
              Billed
            </span>
          )}
          {/* Moving guests or dishes is rare next to adding food: one menu,
              so the dishes keep the height of the order card. */}
          {canMove && (
            <span className="pos-where-menu">
              <ActionMenu
                label="Move or join tables"
                items={[
                  { label: "Move to another table", icon: "switch", disabled: unsaved || saving, onClick: () => setMoveDialog("table") },
                  ...(editingOrder.orderStatus === "open"
                    ? [
                        { label: "Join a table", icon: "link", disabled: unsaved || saving, onClick: () => setMoveDialog("join") },
                        {
                          label: "Move dishes to another table",
                          icon: "arrow-right",
                          disabled: unsaved || saving || cart.length === 0,
                          onClick: () => setMoveDialog("dishes"),
                        },
                      ]
                    : []),
                  ...(editingOrder.joinedTables || []).map((table) => ({
                    label: `Unjoin ${table.tableNo}`,
                    icon: "x",
                    disabled: saving,
                    onClick: () => setUnjoining(table),
                  })),
                ]}
              />
            </span>
          )}
        </div>
        {canMove && unsaved && <p className="muted small pos-where-hint">Save your changes before moving guests or dishes.</p>}
      </div>
    ) : (
      <div className="pos-where">
        <span className="pos-where-label">Table</span>
        <button type="button" className={`pos-table-choice ${tableId ? "is-chosen" : ""}`} onClick={() => setTablePicker(true)}>
          <span className="pos-table-choice-icon" aria-hidden="true">
            <Icon name="table" size={20} />
          </span>
          <span className="pos-table-choice-text">
            {currentTable ? (
              <>
                <strong>Table {currentTable.tableNo}</strong>
                <span className="muted small">
                  {currentTable.capacity} seats
                  {overrideHold && currentTable.booking ? ` · ${heldText(currentTable.booking)}` : ""}
                </span>
              </>
            ) : (
              <>
                <strong>Choose a table</strong>
                <span className="muted small">Tap to see the room</span>
              </>
            )}
          </span>
          <span className="pos-table-choice-go" aria-hidden="true">
            {currentTable ? "Change" : <Icon name="chevron-right" size={18} />}
          </span>
        </button>
      </div>
    ));

  // The order, in two parts: what scrolls (who it is for, and the dishes),
  // and what never does (the total and the buttons that send it). On the
  // till the second part is pinned to the foot of the order card, and on the
  // captain's phone to the foot of the order sheet, so the main action is
  // always on the screen however long the order grows.
  const cartBody = (
    <>
      <div className="segmented pos-order-type" role="radiogroup" aria-label="Order type">
        {orderTypes.map((type) => (
          <button
            type="button"
            key={type.value}
            role="radio"
            aria-checked={orderType === type.value}
            className={`segment ${orderType === type.value ? "is-active" : ""}`}
            onClick={() => setOrderType(type.value)}
            disabled={Boolean(editingOrder) && orderType !== type.value}
          >
            <Icon name={type.icon} size={16} />
            {type.label}
          </button>
        ))}
      </div>

      {outletRow}

      {orderType === "dine_in" && (
        <div className={`pos-where-row ${editingOrder ? "is-editing" : ""}`}>
          {tableField}
          <label className="field pos-guests">
            <span>Guests</span>
            <input type="number" min="1" inputMode="numeric" value={guestCount} onChange={(event) => setGuestCount(event.target.value)} />
          </label>
        </div>
      )}

      <div className="pos-lines-head">
        {editingOrder && orderType === "dine_in" ? null : editingOrder ? (
          <div className="oc-editing">
            <span>
              Editing <strong>{editingOrder.orderNumber}</strong>
              {editingOrder.tableNo ? ` · Table ${tablesText(editingOrder)}` : ""}
            </span>
            <span className={`badge status-badge ${unsaved ? "badge-warning" : "badge-success"}`}>
              <span className="badge-dot" />
              {unsaved ? "Unsaved changes" : "Everything is saved"}
            </span>
          </div>
        ) : (
          <div className="oc-editing is-new">
            <span>
              <strong>New order</strong>
            </span>
            {lineCount > 0 && <span className="muted small">{plural(lineCount, "dish", "dishes")}</span>}
          </div>
        )}
      </div>

      <div className="cart-lines">
        {cart.length === 0 ? (
          <div className="pos-cart-empty">
            <span className="pos-cart-empty-icon" aria-hidden="true">
              <Icon name="utensils" size={22} />
            </span>
            <p>{editingOrder ? "Nothing on this order yet. Tap a dish to add it." : "Tap a dish to add it."}</p>
            <p className="muted small">Or type a dish's code in the search and press Enter.</p>
          </div>
        ) : (
          cart.map((line) => {
            const reducing = line.saved && line.quantity < line.savedQuantity;
            const gone = line.saved && line.quantity === 0;
            const kitchenHas = line.saved && line.kitchenQuantity > 0;

            return (
              <div className={`cart-line oc-cart-line ${gone ? "is-gone" : ""} ${line.saved ? "" : "is-new"}`} key={line.key}>
                <div className="oc-line-body">
                  <strong className="oc-line-name">{line.name}</strong>
                  {line.variantName && <span className="muted"> · {line.variantName}</span>}
                  {line.modifiers.length > 0 && (
                    <div className="muted small">{line.modifiers.map((modifier) => modifier.name).join(", ")}</div>
                  )}
                  {line.notes && <div className="muted small">Note: {line.notes}</div>}
                  <div className="oc-line-meta">
                    {line.saved && isHeld(line) ? (
                      // Held back, not sent: the kitchen has nothing until
                      // someone presses Fire. Never "Sent to kitchen".
                      <>
                        <span className="oc-chip oc-chip-held" title="Not sent to the kitchen until Fire is pressed">
                          Held · not sent
                        </span>
                        <span className="muted small">Course {line.courseNo || 1} · press Fire</span>
                      </>
                    ) : line.saved ? (
                      <>
                        <span className={`oc-chip oc-chip-${line.itemStatus}`}>{STAGE_WORDS[line.itemStatus] || "Saved"}</span>
                        <span className="muted small">{timeOf(line.createdAt)}</span>
                      </>
                    ) : (
                      <span className="oc-chip oc-chip-new">New</span>
                    )}
                    {line.priceWindowName && <span className="oc-offer-tag">{line.priceWindowName}</span>}
                    {reducing && (
                      <span className={`oc-chip ${kitchenHas ? "oc-chip-cancel" : "oc-chip-remove"}`}>
                        {gone ? "Taking off" : `−${line.savedQuantity - line.quantity}`}
                        {kitchenHas ? " · kitchen has it" : ""}
                      </span>
                    )}
                  </div>
                </div>

                <div className={`qty-controls ${weighedLine(line) ? "is-weight" : ""}`}>
                  <button type="button" onClick={() => changeQuantity(line, weighedLine(line) ? -0.05 : -1)} aria-label={weighedLine(line) ? `50 g less ${line.name}` : `One less ${line.name}`} disabled={line.quantity <= 0}>
                    <Icon name="minus" size={16} />
                  </button>
                  <span>{weighedLine(line) ? `${line.quantity} kg` : line.quantity}</span>
                  <button type="button" onClick={() => changeQuantity(line, weighedLine(line) ? 0.05 : 1)} aria-label={weighedLine(line) ? `50 g more ${line.name}` : `One more ${line.name}`}>
                    <Icon name="plus" size={16} />
                  </button>
                </div>

                <span className="line-total">{moneyExact(lineTotalOf(line, taxMode), currency)}</span>
              </div>
            );
          })
        )}
      </div>

      {/* Whole dishes and part of a dish alike: "2 of 3 naan came off"
          is exactly what the guest will ask about at the bill. */}
      {cancelledEarlier.length > 0 && (
        <p className="muted small oc-cancelled-note">
          Taken off earlier:{" "}
          {cancelledEarlier
            .map((row) => `${row.name} ×${row.quantity}${row.left > 0 ? ` (${row.left} still on)` : ""}`)
            .join(", ")}
        </p>
      )}

      {toCancel.length > 0 && (
        <p className="alert alert-notice oc-cancel-hint" role="status">
          The kitchen already has {dishesText(toCancel)}. Saving asks why it is coming off
          {canCancelAfterKot
            ? "."
            : toCancel.length > 1 && new Set(toCancel.map((dish) => dish.name)).size > 1
              ? ", and a manager's PIN for each dish."
              : ", and a manager's PIN."}
        </p>
      )}

      {/* Who it is for and anything to note, under the dishes: at the
          rush the dishes are what the eye looks for first. */}
      <div className="pos-details stack">
        {orderType === "delivery" &&
          (canManageDelivery ? (
            <DeliveryFields channels={channels} value={delivery} onChange={setDelivery} guest={customer} />
          ) : (
            <p className="muted small pos-delivery-note">
              <Icon name="info" size={15} />
              The address and rider are added on the Deliveries board by the counter.
            </p>
          ))}

        {guestsOn ? (
          <GuestBox
            customer={customer}
            setCustomer={setCustomer}
            customerName={customerName}
            setCustomerName={setCustomerName}
            customerMobile={customerMobile}
            setCustomerMobile={setCustomerMobile}
            loyaltyOn={Boolean(settings && settings.loyaltyEnabled && hasFeature("guest_loyalty"))}
            canSearchByName={canSeeGuests}
            nameLabel={orderType === "dine_in" ? "Guest name" : "Name"}
            businessDate={businessDate}
            onRepeat={editingOrder ? null : repeatOrder}
          />
        ) : (
          orderType === "delivery" && (
            // Guests switched off: a delivery still needs who to hand it to.
            // Kept on this order only; nobody is looked up or added.
            <div className="form-grid">
              <label className="field">
                <span>Name</span>
                <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} maxLength={150} />
              </label>
              <label className="field">
                <span>Mobile</span>
                <input value={customerMobile} onChange={(event) => setCustomerMobile(event.target.value)} inputMode="tel" maxLength={20} />
              </label>
            </div>
          )
        )}

        <label className="field">
          <span>Order notes</span>
          <input value={orderNotes} onChange={(event) => setOrderNotes(event.target.value)} placeholder="No onion, birthday table, pack separately…" />
        </label>

        {/* Orders saved earlier with a held course can still be fired. */}
        {editingOrder && cart.some((line) => line.saved && line.holdCourse) && (
          <div className="pos-fire-row">
            {[...new Set(cart.filter((line) => line.saved && line.holdCourse).map((line) => line.courseNo))].map((number) => (
              <button key={number} type="button" className="button button-secondary" onClick={async () => {
                try { afterSave(await fireOrderCourse(editingOrder.id, number)); setSuccess(`Course ${number} sent to the kitchen`); }
                catch (err) { setError(getErrorMessage(err)); }
              }}>Fire course {number}</button>
            ))}
          </div>
        )}
      </div>
    </>
  );

  const cartFoot = (
    <div className="pos-cart-foot">
      {orderType === "delivery" && (
        <DeliveryChargeLine
          channels={channels}
          channelId={delivery.channelId}
          foodTotal={total}
          savedOrder={editingOrder}
          changed={dirty || deliveryChanged}
          currency={currency}
          onSaved={(order, message) => {
            afterSave(order);
            setSuccess(message);
          }}
        />
      )}
      <div className="cart-total">
        <span>{editingOrder && !dirty ? "Order total" : editingOrder ? "New total" : "Estimated total"}</span>
        <strong>{moneyExact(total, currency)}</strong>
      </div>

      {/* The refusal belongs where the action was taken, not at the top of a
          page the cashier scrolled a screen and a half past. */}
      <ErrorMessage message={error} />

      {busyOrder && (
        <button type="button" className="chip-button oc-open-busy" onClick={() => resumeOrder(busyOrder)}>
          Open {busyOrder.orderNumber}
        </button>
      )}

      {orderType === "dine_in" && !tableId && !editingOrder && cart.length > 0 && (
        <p className="alert alert-notice" role="status">
          Choose a table before placing this order.
        </p>
      )}

      {orderBilled ? (
        <div className="pos-billed">
          <p className="alert alert-notice" role="status">
            <Icon name="lock" size={16} />
            <span>
              {editingOrder.orderNumber} is billed, so its dishes can no longer be changed. To change it, void the bill
              in Bills first.
            </span>
          </p>
          <div className="form-actions pos-actions">
            {canBill && (
              <button type="button" className="button button-lg pos-action pos-action-bill" onClick={() => openBill(editingOrder)}>
                <Icon name="receipt" size={18} />
                Open bill & take payment
              </button>
            )}
          </div>
        </div>
      ) : (
      <div className="form-actions pos-actions">
        <button
          type="button"
          className={`button ${canBill ? "button-secondary" : ""} pos-action`}
          onClick={() => saveOrder()}
          disabled={saving || pendingPicks > 0 || needsOutlet || dayOpen === false || (editingOrder ? !unsaved : cart.length === 0)}
        >
          <Icon name="check" size={17} />
          {saving
            ? "Saving…"
            : pendingPicks > 0
              ? "Adding dish…"
              : editingOrder
                ? "Save changes"
                : needsOutlet
                  ? "Pick the outlet"
                  : compact
                    ? "Send"
                    : "Place order"}
        </button>

        {canPrintKot && (
          <button
            type="button"
            className="button button-secondary pos-action"
            onClick={saveAndPrint}
            disabled={saving || pendingPicks > 0 || needsOutlet || dayOpen === false || (editingOrder ? false : cart.length === 0)}
            title={
              editingOrder && !unsaved
                ? "Print this order's KOTs that have not been printed yet"
                : "Save, then print the new KOTs for the kitchen"
            }
          >
            <Icon name="print" size={17} />
            {editingOrder && !unsaved ? "Print new KOTs" : "Save & print KOT"}
          </button>
        )}

        {canBill && (
          <button
            type="button"
            className="button button-lg pos-action pos-action-bill"
            onClick={startBilling}
            disabled={saving || pendingPicks > 0 || needsOutlet || dayOpen === false || cart.every((line) => line.quantity === 0)}
          >
            <Icon name="receipt" size={18} />
            {editingOrder && unsaved ? "Save & bill" : "Bill & pay"}
          </button>
        )}
      </div>
      )}
    </div>
  );

  // ------------------------------------------------------------ the page

  return (
    <div className={`stack pos-page ${compact ? "is-compact" : ""}`}>
      {compact ? (
        <PageHeader
          icon="receipt"
          title="POS"
          action={
            <div className="pos-head-actions">
              <button type="button" className="button button-secondary" onClick={resetCart}>
                <Icon name="plus" size={16} />
                New order
              </button>
            </div>
          }
        />
      ) : (
        // One slim bar instead of a page header plus a running strip: the
        // running orders on the left, the counter's own buttons on the right.
        runningStrip || (
          <section className="running-strip is-folded pos-topbar-empty">
            <div className="running-head">
              <span className="pos-strip-title">
                <span className="pos-strip-icon" aria-hidden="true">
                  <Icon name="receipt" size={17} />
                </span>
                <h1>POS</h1>
              </span>
              <span className="muted small">No orders running</span>
              {topActions}
            </div>
          </section>
        )
      )}

      {compact && badgeLinks}

      {!compact && <ErrorMessage message={error} />}
      {notice && (
        <div className="alert alert-notice pos-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="button button-secondary button-sm" onClick={() => setNotice("")}>
            OK
          </button>
        </div>
      )}

      {dayOpen === false && (
        <div className="alert">
          {needsOutlet
            ? "The main counter's business day is not open. Choose the outlet this sale is for under Sale at, or open the main counter's day under Operations → Business day."
            : "No business day is open. Open it under Operations → Business day before taking orders."}
        </div>
      )}

      {needTable ? (
        // The captain's first screen: the room. A free table starts an order,
        // a table with guests opens theirs.
        <section className="card stack pos-table-step">
          <div className="segmented pos-order-type" role="radiogroup" aria-label="Order type">
            {orderTypes.map((type) => (
              <button
                type="button"
                key={type.value}
                role="radio"
                aria-checked={orderType === type.value}
                className={`segment ${orderType === type.value ? "is-active" : ""}`}
                onClick={() => setOrderType(type.value)}
              >
                <Icon name={type.icon} size={16} />
                {type.label}
              </button>
            ))}
          </div>
          <p className="muted small pos-step-hint">Tap a free table to start, or a table with guests to add to their order.</p>
          <ErrorMessage message={error} />
          <TableGrid tables={tables} joinedBy={joinedBy} now={now} currency={currency} choose={chooseTable} reasonOff={(table, info) => (info.state === "off" ? "Out of service" : null)} compact myUserId={user ? user.id : null} />
          {openOrders.some((order) => !order.tableNo) && (
            <div className="stack pos-other-running">
              <h3>
                <Icon name="box" size={16} />
                Takeaway &amp; delivery running
              </h3>
              <ul className="open-orders">
                {openOrders
                  .filter((order) => !order.tableNo)
                  .map((order) => (
                    <li key={order.id}>
                      <button type="button" className="open-order" onClick={() => resumeOrder(order)}>
                        <span className="open-order-where">{orderWhere(order)}</span>
                        <span className="open-order-money">{moneyExact(order.totalAmount, currency)}</span>
                        <span className="open-order-ref">{order.orderNumber}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <>

          {compact && (
            <div className="pos-compact-where">
              <span className="pos-compact-icon" aria-hidden="true">
                <Icon name={orderType === "dine_in" ? "table" : orderType === "delivery" ? "scooter" : "box"} size={18} />
              </span>
              <div className="pos-compact-text">
                <strong>
                  {orderType === "dine_in"
                    ? `Table ${editingOrder ? tablesText(editingOrder) : currentTable ? currentTable.tableNo : ""}`
                    : orderType === "delivery"
                      ? "Delivery"
                      : "Takeaway"}
                </strong>
                <span className="muted small">
                  {editingOrder ? editingOrder.orderNumber : "New order"}
                  {guestCount ? ` · ${plural(Number(guestCount), "guest", "guests")}` : ""}
                </span>
              </div>
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => {
                  if (editingOrder) {
                    resetCart();
                  } else if (orderType === "dine_in") {
                    setTableId("");
                  } else {
                    setOrderType(dineInOn ? "dine_in" : startType);
                  }
                }}
              >
                {editingOrder ? "Tables" : "Change"}
              </button>
            </div>
          )}

          <div className="pos-layout">
            <section className="card stack pos-menu">
              {searchBox}
              {categoryTabs}
              {soldOutModeBar}
              {dishCards}
            </section>

            {!compact && (
              <section className="card pos-cart" aria-label="The order">
                <div className="pos-cart-body stack">{cartBody}</div>
                {cartFoot}
              </section>
            )}
          </div>

          {compact && (
            // Everything the captain needs next, on the thumb: what is on the
            // order and the button that sends it.
            <div className="pos-captain-bar">
              {/* A refused Send is said here, on the thumb, not at the top of
                  a menu the captain has scrolled past. */}
              {error && !sheetOpen && (
                <div className="pos-captain-error" role="alert">
                  {error}
                  {busyOrder && (
                    <button type="button" className="link-button" onClick={() => resumeOrder(busyOrder)}>
                      Open {busyOrder.orderNumber}
                    </button>
                  )}
                </div>
              )}
              <button type="button" className="pos-captain-view" onClick={() => setSheetOpen(true)}>
                <span className="pos-captain-count">{lineCount}</span>
                <span className="pos-captain-text">
                  <strong>View order</strong>
                  <span className="muted small">
                    {moneyExact(total, currency)}
                    {newCount > 0 ? ` · ${newCount} new` : ""}
                  </span>
                </span>
                <Icon name="chevron-up" size={18} />
              </button>
              <button
                type="button"
                className="button button-lg pos-captain-send"
                onClick={() =>
                  // With "All outlets" chosen the outlet is asked for in the
                  // order sheet: Send opens it there.
                  needsOutlet
                    ? setSheetOpen(true)
                    : orderType === "dine_in" && !tableId && !editingOrder
                      ? setTablePicker(true)
                      : saveOrder()
                }
                disabled={saving || pendingPicks > 0 || dayOpen === false || (editingOrder ? !unsaved : cart.length === 0)}
              >
                <Icon name="check" size={18} />
                {saving ? "Sending…" : pendingPicks > 0 ? "Adding…" : needsOutlet ? "Pick outlet" : "Send"}
              </button>
            </div>
          )}
        </>
      )}

      {compact && sheetOpen && (
        <div className="pos-sheet" role="dialog" aria-modal="true" aria-label="The order">
          <div className="pos-sheet-head">
            <button type="button" className="button button-ghost button-sm pos-sheet-back" onClick={() => setSheetOpen(false)} aria-label="Back to the menu">
              <Icon name="chevron-left" size={18} />
              Menu
            </button>
            <strong>
              {editingOrder
                ? `${orderWhere(editingOrder)} · ${editingOrder.orderNumber}`
                : orderType === "dine_in" && currentTable
                  ? `Table ${currentTable.tableNo} · new order`
                  : "New order"}
            </strong>
          </div>
          <div className="pos-sheet-body stack">{cartBody}</div>
          {cartFoot}
        </div>
      )}

      {tablePicker && (
        <Modal
          title="Choose a table"
          icon="table"
          description="A free table starts this order. A table with guests opens their order instead. A table held for a booking asks before it is given away."
          onClose={() => setTablePicker(false)}
          width={860}
        >
          <TableGrid
            tables={tables}
            joinedBy={joinedBy}
            now={now}
            currency={currency}
            choose={chooseTable}
            reasonOff={(table, info) => (info.state === "off" ? "Out of service" : null)}
            selectedId={currentTable ? currentTable.id : null}
            myUserId={user ? user.id : null}
          />
        </Modal>
      )}

      {heldConfirm && (
        <Modal title="This table is held for a booking" icon="calendar" onClose={() => setHeldConfirm(null)} width={460}>
          <div className="stack">
            <p>{heldConfirm.message}</p>
            <p className="muted small">If they arrive while this party is still here, the host will need another table for them.</p>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setHeldConfirm(null)}>
                Choose another table
              </button>
              <button type="button" className="button" onClick={confirmHeld}>
                Seat them here anyway
              </button>
            </div>
          </div>
        </Modal>
      )}

      {moveDialog && editingOrder && (
        <MoveDialog
          mode={moveDialog}
          order={editingOrder}
          tables={tables}
          joinedBy={joinedBy}
          now={now}
          currency={currency}
          taxMode={taxMode}
          onClose={() => setMoveDialog(null)}
          onDone={afterMove}
        />
      )}

      {unjoining && editingOrder && (
        <Modal title={`Unjoin table ${unjoining.tableNo}?`} icon="link" onClose={() => setUnjoining(null)} width={440}>
          <div className="stack">
            <p>
              Table {unjoining.tableNo} stops being part of {editingOrder.orderNumber} and is free for the next party.
              The dishes stay on the order.
            </p>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setUnjoining(null)}>
                Keep it joined
              </button>
              <button type="button" className="button" onClick={unjoin}>
                Unjoin {unjoining.tableNo}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {dishSwitch && (
        <DishAvailability
          product={dishSwitch}
          soldOut={soldOut}
          loadVariants={variantsOf}
          onClose={() => setDishSwitch(null)}
          onChanged={(list, message) => {
            setDishSwitch(null);
            setSuccess(message);

            if (list) {
              setAvailability(list);
            } else {
              loadAvailability();
              listProducts({ status: "active" }).then(setProducts).catch(() => undefined);
            }
          }}
        />
      )}

      {soldOutPanel && (
        <SoldOutPanel
          availability={availability}
          canSwitch={canSwitchDishes}
          onClose={() => setSoldOutPanel(false)}
          onChanged={(list, message) => {
            setSuccess(message);
            setAvailability(list);
          }}
        />
      )}

      {weighing && (
        <WeighDialog product={weighing} unitPrice={unitPriceFor(weighing, null, offers).unitPrice} currency={currency} onClose={() => setWeighing(null)}
          onAdd={(kg) => { addToCart(weighing, null, [], kg, ""); setWeighing(null); }} />
      )}
      {picking && (
        <Modal
          title={picking.product.name}
          icon="utensils"
          description={
            picking.product.comboChoiceGroups?.length
              ? "Choose your combo items, then add them to the order."
              : picking.variants.length > 0 && picking.modifiers.length > 0
              ? "Choose the size and any add-ons, then add it to the order."
              : picking.variants.length > 0
                ? "Choose the size, then add it to the order."
                : "Pick any add-ons, then add it to the order."
          }
          onClose={() => setPicking(null)}
          width={520}
        >
          <div className="form-grid">
            {picking.variants.length > 0 && (
              <label className="field field-wide">
                <span>Size</span>
                <select value={pickVariantId} onChange={(event) => setPickVariantId(event.target.value)}>
                  <option value="">
                    Regular ({moneyExact(unitPriceFor(picking.product, null, offers).unitPrice, currency)})
                  </option>
                  {picking.variants.map((variant) => {
                    const priced = unitPriceFor(picking.product, variant, offers);
                    const out = soldOut.has(soldOutKey(picking.product.id, variant.id));

                    return (
                      <option key={variant.id} value={variant.id} disabled={out}>
                        {variant.name} — {moneyExact(priced.unitPrice, currency)}
                        {priced.offer ? ` (${priced.offer.windowName})` : ""}
                        {out ? " · sold out today" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}

            {Number(offers?.get(offerKey(picking.product.id,pickVariantId||null))?.packagingCharge||0)>0&&<p>Packaging: {moneyExact(Number(offers.get(offerKey(picking.product.id,pickVariantId||null)).packagingCharge),currency)} per item, added automatically.</p>}
            <ComboChoicePicker groups={picking.product.comboChoiceGroups} value={pickComboSelections} onChange={setPickComboSelections} currency={currency}/>
            {picking.modifiers.length > 0 && (
              <fieldset className="field field-wide pos-pick-addons">
                <legend>Add-ons</legend>
                <AddonChoiceRules groups={picking.product.addonGroups} selectedIds={pickModifierIds} modifiers={picking.modifiers}/>
                <div className="checkbox-grid">
                  {picking.modifiers.map((modifier) => (
                    <label className={`checkbox pos-addon ${pickModifierIds.includes(modifier.id) ? "is-on" : ""}`} key={modifier.id}>
                      <input
                        type="checkbox"
                        checked={pickModifierIds.includes(modifier.id)}
                        onChange={() =>
                          setPickModifierIds(
                            pickModifierIds.includes(modifier.id)
                              ? pickModifierIds.filter((id) => id !== modifier.id)
                              : [...pickModifierIds, modifier.id]
                          )
                        }
                      />
                      <span>
                        {modifier.name} <small className="muted">+{moneyExact(modifier.price, currency)}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <label className="field">
              <span>Quantity</span>
              <input type="number" min="1" value={pickQuantity} onChange={(event) => setPickQuantity(event.target.value)} />
            </label>

            <label className="field">
              <span>Note for the kitchen</span>
              <input value={pickNotes} onChange={(event) => setPickNotes(event.target.value)} placeholder="Less spicy" />
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setPicking(null)}>
                Cancel
              </button>
              <button type="button" className="button" onClick={confirmPick} disabled={!(Number(pickQuantity) > 0) || Boolean(choiceError(picking.product.addonGroups,pickModifierIds)) || Boolean(comboError(picking.product.comboChoiceGroups,pickComboSelections))}>
                <Icon name="plus" size={16} />
                Add to order
              </button>
            </div>
          </div>
        </Modal>
      )}

      {cancelPrompt && (
        <Modal
          title="Take off dishes the kitchen has?"
          icon="alert"
          description="These are already on a KOT, so the kitchen may have started them."
          onClose={() => setCancelPrompt(null)}
          width={540}
        >
          <div className="stack oc-cancel-prompt">
            <p className="muted small">
              Taking them off is recorded against your name
              {canCancelAfterKot
                ? ""
                : new Set(cancelPrompt.dishes.map((dish) => dish.name)).size > 1
                  ? " and needs a manager's PIN for each dish"
                  : " and needs a manager's PIN"}
              , and shows on the owner's cancellation report.
            </p>

            <ul className="oc-cancel-list">
              {cancelPrompt.dishes.map((dish) => (
                <li key={dish.key || dish.itemId}>
                  <span>
                    <strong>
                      {dish.quantity} × {dish.name}
                    </strong>
                    {dish.variantName ? <span className="muted"> · {dish.variantName}</span> : null}
                  </span>
                  <span className="oc-cancel-meta">
                    {dish.kitchenStage && (
                      <span className={`oc-chip oc-chip-stage-${dish.kitchenStage}`}>
                        {dish.kitchenStage === "served"
                          ? "Already served"
                          : `Kitchen: ${KITCHEN_STAGE_WORDS[dish.kitchenStage] || dish.kitchenStage}`}
                      </span>
                    )}
                    <span className="nowrap">{moneyExact(dish.amount || 0, currency)}</span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="field">
              <span>Why? *</span>
              <div className="oc-reasons" role="radiogroup" aria-label="Reason">
                {CANCEL_REASONS.map((reason) => (
                  <button
                    type="button"
                    key={reason.code}
                    role="radio"
                    aria-checked={cancelReason === reason.code}
                    className={`chip-button oc-reason ${cancelReason === reason.code ? "is-active" : ""}`}
                    onClick={() => setCancelReason(reason.code)}
                  >
                    {reason.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="field">
              <span>Note {cancelReason === "other" ? "*" : "(optional)"}</span>
              <input
                value={cancelNote}
                onChange={(event) => setCancelNote(event.target.value)}
                maxLength={200}
                placeholder={cancelReason === "other" ? "What happened?" : "Too salty, sent back cold…"}
              />
            </label>

            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setCancelPrompt(null)}>
                Keep them
              </button>
              <button
                type="button"
                className="button button-danger"
                onClick={confirmCancellation}
                disabled={!cancelReason || (cancelReason === "other" && !cancelNote.trim())}
              >
                <Icon name="trash" size={16} />
                Take off · {moneyExact(cancelTotal, currency)}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {bill && (
        <BillModal
          key={bill.id}
          bill={bill}
          onBill={billChanged}
          onClose={closeBill}
          settings={settings}
          currency={currency}
          mode="pos"
          customer={customer}
          onPaid={billSettled}
        />
      )}
    </div>
  );
}
