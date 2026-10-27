import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import useAuth from "../hooks/useAuth";
import useMotionScope from "../hooks/useMotionScope";
import useSidebarMotion from "../hooks/useSidebarMotion";
import usePresence from "../hooks/usePresence";
// Starts watching when screens finish loading before the first page asks
// for its data, so a figure that arrives is never mistaken for a figure that
// changed (components/arrival.js, used by LiveValue).
import "../components/arrival";
import OutletSwitcher from "../components/OutletSwitcher";
import BusinessSwitcher from "../components/BusinessSwitcher";
import BusinessLocationSwitcher from "../components/BusinessLocationSwitcher";
import BusinessProvider from "../context/BusinessProvider";
import useBusiness from "../hooks/useBusiness";
import { businessMenu, businessPath, homeLanding, isRestaurantStaff } from "../services/businessNav";
import { restaurantMenu } from '../services/restaurantWorkspace';
import RestaurantWorkspaceNav from '../components/RestaurantWorkspaceNav';
import NavIcon from "../components/NavIcon";
import Icon, { BrandMark } from "@bmp/ui/Icon";
import NotificationBell from "../components/NotificationBell";
import { businessFeed } from "../services/businessNotifications";
import LockScreen from "../components/LockScreen";
import QuickAccess from "../components/QuickAccess";
import { quickAccessKey } from "../services/navigationPreferences";
import { pageAccent } from "../services/pageAccent";
import { ScreenLoading } from "../components/Feedback";
import { featuresAllow } from "../services/features";
import "../styles/access.css";
import { formatLabel } from "../services/restaurantFormats";

const PINNED_KEY = "rmp_nav_pinned";

// Sections the user has chosen to keep open on top of the one they are in.
// Remembered per browser, so a manager who lives in Reports does not reopen it
// every morning. Nothing remembered means only the current section shows —
// eight or so links instead of thirty-one.
const readPinned = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(PINNED_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
};

// Each link names the permission it needs, so staff only see what they can open.
// `also` is a second permission the page needs as well (payroll is staff
// management AND salaries). `permissionAny` lists permissions of which one is
// enough (pre-orders: the counter's orders.view, or the kitchen's kds.view
// for the bake list).
const NAV_SECTIONS = [
  {
    title: "Overview",
    links: [
      { to: "/", label: "Dashboard", icon: "dashboard", end: true },
      // Your own shifts and payslips: only for a login linked to a staff record.
      { to: "/my-work", label: "My work", icon: "mywork", staffRecord: true, feature: "staff_payroll" },
    ],
  },
  {
    title: "Service",
    links: [
      { to: "/pos", label: "POS", icon: "pos", permission: "orders.create" },
      // The waiters' phone screen, around their own tables (workspaces/captain).
      { to: "/captain", label: "Captain app", icon: "captain", permission: "orders.create", notFormats: ["cloud_kitchen", "bakery"] },
      { to: "/orders", label: "Orders", icon: "orders", permission: "orders.view" },
      { to: "/bills", label: "Bills & payments", icon: "bills", permission: "orders.view" },
      { to: "/dues", label: "Dues & accounts", icon: "dues", permission: "sales.view" },
      { to: "/kitchen", label: "Kitchen display", icon: "kitchen", permission: "kds.view", feature: "kitchen_display" },
      { to: "/table-requests", label: "Table requests", icon: "tableRequests", permission: "orders.view", featureAny: ["qr_ordering", "online_ordering"] },
      { to: "/reservations", label: "Reservations", icon: "reservations", permission: "reservations.view", feature: "reservations" },
      { to: "/deliveries", label: "Deliveries", icon: "deliveries", permission: "orders.view", feature: "deliveries" },
      { to: "/preorders", label: "Pre-orders & cakes", icon: "reservations", permissionAny: ["orders.view", "kds.view"], feature: "preorders" },
      { to: "/collection", label: "Pickup screen", icon: "pickup", permission: "orders.collection" },
      { to: "/service/settings", label: "Service settings", icon: "serviceSettings", permission: "orders.manage" },
    ],
  },
  {
    title: "Restaurant",
    links: [
      { to: "/restaurant/profile", label: "Profile", icon: "profile", permission: "restaurant.settings.view" },
      { to: "/restaurant/outlets", label: "Outlets", icon: "outlets", permission: "outlets.view" },
      { to: "/restaurant/hours", label: "Business hours", icon: "hours", permission: "restaurant.settings.view" },
      { to: "/restaurant/settings", label: "Settings", icon: "settings", permission: "restaurant.settings.view" },
      { to: "/restaurant/features", label: "Features", icon: "sliders", permission: "restaurant.settings.view" },
      // Personal data (modules/personal-data, shared with Business Admin): requests, breaches, the privacy notice.
      { to: "/privacy", label: "Personal data", icon: "privacy", permission: "privacy.view" },
    ],
  },
  {
    title: "Menu",
    links: [
      { to: "/menu/brands", label: "Brands", icon: "outlets", permission: "orders.view", feature: "brands" },
      { to: "/menu/categories", label: "Categories", icon: "categories", permission: "menu.view" },
      { to: "/menu/products", label: "Products", icon: "products", permission: "menu.view" },
      { to: "/menu/modifiers", label: "Modifiers", icon: "modifiers", permission: "menu.view" },
      { to: "/menu/tax-rates", label: "Tax rates", icon: "tax", permission: "menu.view" },
      { to: "/menu/tax-changes", label: "GST rate changes", icon: "calendar", permission: "menu.view" },
      { to: "/menu/happy-hour", label: "Happy hour", icon: "happyHour", permission: "menu.view" },
    ],
  },
  {
    title: "Tables",
    links: [
      { to: "/tables/floors", label: "Floors & areas", icon: "floors", permission: "tables.view", notFormats: ["cloud_kitchen", "bakery"] },
      { to: "/tables", label: "Tables & QR", icon: "tables", permission: "tables.view", end: true, notFormats: ["cloud_kitchen", "bakery"] },
    ],
  },
  {
    title: "Inventory",
    links: [
      { to: "/inventory/items", label: "Items & stock", icon: "stock", permission: "inventory.view", feature: "stock_recipes" },
      { to: "/inventory/stock", label: "Stock movements", icon: "movements", permission: "inventory.view", feature: "stock_recipes" },
      { to: "/inventory/insights", label: "Waste & reorder", icon: "inventoryInsights", permission: "inventory.view", feature: "stock_recipes" },
      { to: "/inventory/day-end", label: "Day-end unsold", icon: "inventoryInsights", permission: "inventory.view", feature: "stock_recipes", formats: ["bakery", "cafe"] },
      { to: "/inventory/transfers", label: "Transfers & indents", icon: "transfers", permission: "inventory.view", feature: "stock_recipes" },
      { to: "/inventory/settings", label: "Stock & purchasing settings", icon: "sliders", permission: "inventory.view", feature: "stock_recipes" },
    ],
  },
  {
    title: "Purchasing",
    links: [
      { to: "/purchasing/suppliers", label: "Suppliers", icon: "suppliers", permission: "suppliers.view", feature: "stock_recipes" },
      { to: "/purchasing/orders", label: "Purchase orders", icon: "purchaseOrders", permission: "purchasing.view", feature: "stock_recipes" },
      { to: "/purchasing/accounts", label: "Returns & payments", icon: "returns", permission: "purchasing.view", feature: "stock_recipes" },
    ],
  },
  {
    title: "Customers",
    links: [
      { to: "/crm/customers", label: "Customers", icon: "customers", permission: "customers.view", feature: "guests" },
      { to: "/crm/feedback", label: "Feedback", icon: "feedback", permission: "feedback.view", feature: "guests" },
      { to: "/crm/complaints", label: "Complaints", icon: "complaints", permission: "feedback.view", feature: "guests" },
      { to: "/crm/insights", label: "Guest insights", icon: "guestInsights", permission: "customers.view", feature: "guests" },
    ],
  },
  {
    title: "Operations",
    links: [
      { to: "/business-day", label: "Business day", icon: "businessDay", permission: "business_day.view" },
      { to: "/logbook", label: "Log book", icon: "logbook", permission: "logbook.view" },
      { to: "/discounts", label: "Discounts & offers", icon: "discounts", permission: "discounts.view" },
      { to: "/expenses", label: "Expenses", icon: "expenses", permission: "expenses.view" },
    ],
  },
  {
    // Tasks, issues & projects (modules/tasks). My tasks needs no permission.
    title: "Tasks",
    links: [
      { to: "/tasks", label: "My tasks", icon: "tasks", feature: "tasks", end: true },
      { to: "/tasks/board", label: "Team board", icon: "board", permission: "tasks.view", feature: "tasks" },
      { to: "/tasks/calendar", label: "Task calendar", icon: "calendar", feature: "tasks" },
      { to: "/tasks/issues", label: "Issues", icon: "issues", feature: "issues" },
      { to: "/tasks/projects", label: "Projects", icon: "projects", feature: "projects" },
      { to: "/tasks/templates", label: "Templates", icon: "templates", permission: "tasks.create", feature: "tasks" },
      { to: "/tasks/recurring", label: "Recurring tasks", icon: "recurring", permission: "tasks.view", feature: "tasks" },
      { to: "/tasks/reports", label: "Task reports", icon: "reports", permission: "tasks.view", feature: "tasks" },
    ],
  },
  {
    title: "Staff",
    links: [
      { to: "/staff", label: "Employees", icon: "employees", permission: "staff.view", end: true, feature: "staff_payroll" },
      { to: "/staff/shifts", label: "Shifts & roster", icon: "shifts", permission: "staff.view", feature: "staff_payroll" },
      { to: "/staff/attendance", label: "Attendance", icon: "attendance", permission: "staff.view", feature: "staff_payroll" },
      { to: "/staff/timeclock", label: "Time clock", icon: "timeclock", permission: "staff.clock", feature: "staff_payroll" },
      { to: "/staff/payroll", label: "Payroll", icon: "payroll", permission: "staff.manage", also: "staff.salaries", feature: "staff_payroll" },
      { to: "/staff/tips", label: "Tips", icon: "tips", permission: "staff.salaries", feature: ["tips", "staff_payroll"] },
    ],
  },
  {
    title: "Reports",
    links: [
      { to: "/reports", label: "Reports", icon: "reports", permission: "reports.view" },
      { to: "/activity-log", label: "Activity log", icon: "activity", permission: "audit.view" },
    ],
  },
  {
    title: "Users & access",
    links: [
      { to: "/users", label: "Users", icon: "users", permission: "users.view", end: true },
      { to: "/roles", label: "Roles & permissions", icon: "roles", permission: "roles.view" },
    ],
  },
  {
    title: "Platform",
    links: [
      { to: "/platform/restaurants", label: "Restaurants", icon: "platform", permission: "platform.restaurants.manage" },
      { to: "/platform/businesses", label: "Businesses", icon: "store", permission: "platform.restaurants.manage" },
    ],
  },
];

// Where a link actually goes for this person, or null when it should not show.
// A link of a restaurant feature switched off (Settings -> Features) is gone
// from the menu, and so from quick access, until it is switched back on.
const resolveLink = (link, hasPermission, user, hasFeature) => {
  if (link.permission && !hasPermission(link.permission)) {
    return null;
  }

  if (link.permissionAny && !link.permissionAny.some((code) => hasPermission(code))) {
    return null;
  }

  if ((link.feature || link.featureAny) && !featuresAllow(link, hasFeature)) {
    return null;
  }

  if (link.staffRecord && !user.employeeId) {
    return null;
  }

  // Some screens belong to a format: a bakery's day-end count; a cloud
  // kitchen has no tables.
  const format = user.restaurantFormat || "restaurant";

  if ((link.formats && !link.formats.includes(format)) || (link.notFormats && link.notFormats.includes(format))) {
    return null;
  }

  if (link.also && !hasPermission(link.also)) {
    return null;
  }

  return link;
};

const initials = (name) =>
  String(name || "")
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

// The main layout serves the whole Business Admin: the restaurant screens of
// the signed-in restaurant, and every other business opened from the
// switcher (/business-admin/<id>/…). Which menu shows follows the URL.
export default function AppLayout() {
  return (
    <BusinessProvider>
      <HomeGate>
        <AppShell />
      </HomeGate>
    </BusinessProvider>
  );
}

// The home address (/) is the restaurant's screen only for someone who stays
// there. Until their businesses are known, it shows the shared loading screen
// with no header or menu; someone it sends on to a business goes straight
// there, so the restaurant's header and dashboard never show for a moment
// first: staff with no restaurant role (here), and restaurant staff arriving
// back at a shop they used last (BusinessProvider, as the list arrives).
function HomeGate({ children }) {
  const { user, hasPermission } = useAuth();
  const { pathname } = useLocation();
  const { directory, directoryError } = useBusiness();
  if (pathname !== "/") {
    return children;
  }
  const target = homeLanding({
    restaurantStaff: isRestaurantStaff(user),
    platform: !user.restaurantId && hasPermission("platform.restaurants.manage"),
    directory,
    failed: Boolean(directoryError),
  });
  if (target === "wait") {
    return <ScreenLoading label="Opening your business…" />;
  }
  // The move is a transition: the loading screen stays until the business shows.
  return target ? <><ScreenLoading label="Opening your business…" /><Navigate to={target} replace /></> : children;
}

function AppShell() {
  const { user, logout, hasPermission, hasFeature, locked, lock } = useAuth();
  const { pathname } = useLocation();
  const business = useBusiness();
  const businessMode = business.inBusinessAdmin;
  // The business chooser (/business-admin), and the owner's GST thresholds
  // across their businesses beside it, stand on their own: no restaurant
  // menu, outlet switcher or restaurant bell around them.
  const chooser = pathname === "/business-admin" || pathname === "/business-admin/gst-thresholds";
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [pinned, setPinned] = useState(readPinned);
  const [filter, setFilter] = useState("");
  const accountRef = useRef(null);
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const sidebarRef = useRef(null);
  // A closing menu stays a moment to slide or fade out; meanwhile it is inert
  // and takes no clicks, so nothing waits for it.
  const drawer = usePresence(menuOpen, 200);
  const account = usePresence(accountOpen, 130);

  // A platform account (no restaurant) runs the platform, nothing inside a
  // restaurant: it sees only the platform's own pages.
  const { businessId, context: businessContext, can, has } = business;
  // The bell of the open business; the restaurant keeps its own.
  const bellFeed = useMemo(() => (businessMode && businessId ? businessFeed(businessId, user.id) : null), [businessMode, businessId, user.id]);
  const availableSections = useMemo(() => {
    if (businessMode) {
      return businessContext ? businessMenu(businessId, businessContext.business.business_type, can, has) : [];
    }
    const resolved = NAV_SECTIONS.filter((section) => user.restaurantId || section.title === "Platform").map((section) => ({
      ...section,
      links: section.links
        .map((link) => resolveLink(link, hasPermission, user, hasFeature))
        .filter(Boolean),
    })).filter((section) => section.links.length > 0);
    return user.restaurantId ? restaurantMenu(resolved) : resolved;
  }, [businessMode, businessContext, businessId, can, has, hasPermission, hasFeature, user]);

  // The menu shows each area once; quick access and "Jump to…" reach every page
  // inside it (a business area's pages, a restaurant area's related pages).
  const everyPage = useMemo(() => availableSections.map((section) => {
    const seen = new Set();
    return { ...section, links: section.links.flatMap((link) => link.pages || link.related || [link])
      .filter((link) => !seen.has(link.to) && seen.add(link.to)) };
  }), [availableSections]);

  const sections = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return availableSections;
    return everyPage.map(section => ({
      ...section,
      links: section.links.filter(link => link.label.toLowerCase().includes(term)),
    })).filter(section => section.links.length > 0);
  }, [availableSections, everyPage, filter]);

  // The section holding the page you are on is never folded away, so you can
  // always see where you are.
  const openSection = useMemo(() => {
    const match = availableSections.find((section) =>
      section.links.some((link) =>
        (link.end ? pathname === link.to : pathname === link.to || pathname.startsWith(`${link.to}/`))
        || link.related?.some((item) => pathname === item.to || item.to !== '/' && pathname.startsWith(`${item.to}/`))
        || (businessMode && link.activeSections?.some((name) => name && (pathname === businessPath(businessId, name) || pathname.startsWith(`${businessPath(businessId, name)}/`))))
      )
    );

    // A page with no menu entry of its own — the profile page, say — would
    // otherwise leave every section folded and the menu looking empty, so the
    // first section stands in.
    return match ? match.title : availableSections[0]?.title;
  }, [pathname, businessMode, businessId, availableSections]);

  useEffect(() => {
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
    } catch {
      // A browser with storage blocked just forgets between visits.
    }
  }, [pinned]);

  // The account menu closes on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!accountOpen) {
      return undefined;
    }

    const onPointer = (event) => {
      // The outlet picker's list is drawn on <body>, outside the menu.
      if (event.target instanceof Element && event.target.closest(".search-picker-list")) {
        return;
      }

      if (accountRef.current && !accountRef.current.contains(event.target)) {
        setAccountOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setAccountOpen(false);
      }
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);

  // Motion for every screen (hooks/useMotionScope.js): the page area fades
  // and rises in on a route change, new content cascades in, and the pill of
  // a tab bar or segmented control slides to the new choice.
  useMotionScope(scrollRef, contentRef, `${user.id}:${pathname}`);

  // The menu's groups glide open and shut, and the active marker slides to
  // the page you moved to.
  useSidebarMotion(sidebarRef, { pathname, layoutKey: `${pinned.join("|")}:${drawer.mounted}`, filter });

  // A new page starts at its top, not wherever the last one was scrolled to.
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [pathname]);

  const toggleSection = (title) =>
    setPinned((current) =>
      current.includes(title) ? current.filter((name) => name !== title) : [...current, title]
    );

  // Inside a business, the person's role in that business (their membership).
  const roleText = businessMode && businessContext?.role?.name
    ? businessContext.role.name
    : (user.roleNames || user.roles || []).join(", ");

  const lockNow = () => {
    setAccountOpen(false);
    lock();
  };

  // A till is a restaurant word; a shop, a salon or a wholesaler locks the screen.
  const tillWord = !businessMode || business.current?.business_type === "restaurant";
  const lockLabel = tillWord ? "Lock the till" : "Lock screen";

  return (
    <div className={`app-shell ${chooser ? "is-chooser" : ""}`.trim()} data-accent={pageAccent(pathname)}>
      {/* The first thing Tab reaches: straight past the header and the menu. */}
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        scrollRef.current?.focus();
      }}>
        Skip to content
      </a>
      {/* data-layout says whose header this is (a business's, the business
          chooser's, or the restaurant's own); the browser tests watch it. */}
      <header className="topbar" data-layout={businessMode ? "business" : chooser ? "chooser" : "restaurant"}>
        <button
          type="button"
          className="icon-button menu-toggle topbar-icon-button"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
        >
          <Icon name={menuOpen ? "x" : "menu"} size={20} />
        </button>

        {/* The product's mark and the restaurant it is signed in to, leading
            home. On a phone the restaurant name is what gives way (it ends in
            an ellipsis) before any control does. */}
        {businessMode ? (
          <Link to={businessPath(businessId)} className="brand" aria-label={`${business.current?.name || "Business Admin"} — overview`}>
            <BrandMark size={34} />
            <span className="brand-text">
              <span className="brand-name">{business.current?.name || "Business Admin"}</span>
              <span className="brand-restaurant">
                {business.current?.type_name ? `${business.current.type_name} · Business Admin` : "Business Admin"}
              </span>
            </span>
          </Link>
        ) : chooser ? (
          <span className="brand">
            <BrandMark size={34} />
            <span className="brand-text">
              <span className="brand-name">Business Admin</span>
              <span className="brand-restaurant">{pathname === "/business-admin" ? "Choose a business to open" : "Across your businesses"}</span>
            </span>
          </span>
        ) : (
          <Link to="/" className="brand" aria-label={`${user.restaurantName || "Business Admin"} — dashboard`}>
            <BrandMark size={34} />
            <span className="brand-text">
              <span className="brand-name">{user.restaurantName || "Business Admin"}</span>
              <span className="brand-restaurant">
                {[user.outletName, user.restaurantFormat && user.restaurantFormat !== "restaurant" ? formatLabel(user.restaurantFormat) : null].filter(Boolean).join(" · ") || "Business Admin"}
              </span>
            </span>
          </Link>
        )}

        <div className="user-menu">
          <BusinessSwitcher />
          {!businessMode && !chooser && <OutletSwitcher className="acc-outlet-wide" />}
          {businessMode && <BusinessLocationSwitcher className="acc-outlet-wide" />}
          {!businessMode && !chooser && <NotificationBell />}
          {bellFeed && <NotificationBell key={businessId} feed={bellFeed} />}

          <button
            type="button"
            className="icon-button acc-lock-button"
            onClick={lockNow}
            title={`${lockLabel}, or let someone else sign in with their PIN`}
            aria-label={lockLabel}
          >
            <Icon name="lock" size={19} />
          </button>

          <div className="acc-account" ref={accountRef}>
            <button
              type="button"
              className={`acc-account-button ${accountOpen ? "is-open" : ""}`}
              onClick={() => setAccountOpen(!accountOpen)}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              aria-label={`Account menu for ${user.name}`}
            >
              <span className="acc-avatar" aria-hidden="true">
                {initials(user.name)}
              </span>
              <span className="acc-account-text">
                <span className="acc-account-name">{user.name}</span>
                <small>{roleText}</small>
              </span>
              <Icon name="chevron-down" size={14} strokeWidth={2.5} className="acc-caret" />
            </button>

            {account.mounted && (
              <div
                className={`acc-account-menu ${account.leaving ? "is-leaving" : ""}`}
                role="menu"
                aria-hidden={account.leaving || undefined}
                inert={account.leaving || undefined}
              >
                <div className="acc-account-head">
                  <span className="acc-avatar acc-avatar-md" aria-hidden="true">
                    {initials(user.name)}
                  </span>
                  <span className="acc-account-head-text">
                    <strong>{user.name}</strong>
                    <span className="muted small">{roleText}</span>
                    {user.outletName && <span className="muted small">Works at {user.outletName}</span>}
                  </span>
                </div>

                {!businessMode && <OutletSwitcher className="acc-outlet-narrow" />}
                {businessMode && <BusinessLocationSwitcher className="acc-outlet-narrow" />}

                <Link role="menuitem" className="acc-menu-item" to="/profile" onClick={() => setAccountOpen(false)}>
                  <Icon name="user" size={17} />
                  <span>
                    My profile, password &amp; PIN
                    <small>Sign-in devices and sign out everywhere</small>
                  </span>
                </Link>
                <button type="button" role="menuitem" className="acc-menu-item" onClick={lockNow}>
                  <Icon name="switch" size={17} />
                  <span>
                    {tillWord ? "Lock till / switch user" : "Lock screen / switch user"}
                    <small>Staff carry on with their own PIN</small>
                  </span>
                </button>
                <div className="acc-menu-separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="acc-menu-item acc-menu-danger"
                  onClick={() => {
                    setAccountOpen(false);
                    logout();
                  }}
                >
                  <Icon name="logout" size={17} />
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="app-body">
        <aside
          ref={sidebarRef}
          className={`sidebar ${drawer.mounted ? "open" : ""} ${drawer.leaving ? "is-closing" : ""}`}
          aria-hidden={drawer.leaving || undefined}
          inert={drawer.leaving || undefined}
        >
          <div className="nav-search">
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Jump to…"
              aria-label="Filter the menu"
            />
          </div>

          {/* Pinned pages: the restaurant's own set, and one per business. */}
          <QuickAccess
            key={`${quickAccessKey(user)}:${businessMode ? businessId : ""}`}
            user={user}
            scope={businessMode ? `business:${businessId}` : undefined}
            sections={everyPage}
            locked={locked}
            onNavigate={() => { setMenuOpen(false); setFilter(""); }}
          />

          <nav className={`nav-sections ${filter.trim() ? "is-filtering" : ""}`} aria-label="All pages">
            {sections.map((section) => {
              // A search shows everything it matched; otherwise a section is
              // open if it is the one you are in, or you pinned it open.
              // A business's own menu is short enough to show whole.
              const isOpen =
                businessMode ||
                filter.trim() !== "" ||
                section.title === openSection ||
                pinned.includes(section.title);

              return (
                <div
                  className="nav-section"
                  key={section.title}
                  data-section={section.title}
                  data-accent={pageAccent(section.links[0].to)}
                >
                  <button
                    type="button"
                    className={`nav-title ${section.title === openSection ? "is-current" : ""}`}
                    onClick={() => toggleSection(section.title)}
                    aria-expanded={isOpen}
                    disabled={businessMode || section.title === openSection || filter.trim() !== ""}
                  >
                    <span>{section.title}</span>
                    {!businessMode && <svg
                      className={`nav-caret ${isOpen ? "is-open" : ""}`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>}
                  </button>

                  {isOpen &&
                    section.links.map((link) => (
                      <NavLink
                        key={link.to}
                        to={link.to}
                        end={link.end}
                        className={({ isActive }) => `nav-link${isActive || link.related?.some(item => pathname === item.to || item.to !== '/' && pathname.startsWith(`${item.to}/`)) || (businessMode && link.activeSections?.some((name) => name && (pathname === businessPath(businessId, name) || pathname.startsWith(`${businessPath(businessId, name)}/`)))) ? ' active' : ''}`}
                        data-accent={pageAccent(link.to)}
                        onClick={() => setMenuOpen(false)}
                      >
                        <NavIcon name={link.icon} />
                        <span className="nav-label">{link.label}</span>
                      </NavLink>
                    ))}
                </div>
              );
            })}

            {sections.length === 0 && <p className="muted small nav-empty">Nothing matches.</p>}
          </nav>
        </aside>

        {/* On a phone the open menu sits over the page; the dimmed page behind
            it closes the menu when tapped, as a phone's menus do. */}
        {drawer.mounted && (
          <div
            className={`sidebar-scrim ${drawer.leaving ? "is-leaving" : ""}`}
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* The scrolling is done by this wrapper, so the scrollbar sits at the
            edge of the screen while the page itself stays centred. Keyed by
            the person, so when someone else takes over a shared till every
            page starts fresh instead of showing the last person's half-typed
            order; and by the business, so opening another one (a shop from
            the restaurant) draws its header at once with the loading screen,
            instead of keeping the last business's screen, header and all,
            while the new one's screens load (the router moves in a
            transition, which keeps a screen already shown until the next is
            ready, but shows a new one's loading screen). */}
        <main className="content-scroll" ref={scrollRef} id="main-content" tabIndex={-1}>
          <div className="content" key={`${user.id}:${businessMode ? `business:${businessId}` : chooser ? "chooser" : "restaurant"}`} ref={contentRef}>
            <Suspense fallback={<ScreenLoading />}>
              {!businessMode && user.restaurantId && <RestaurantWorkspaceNav sections={availableSections} pathname={pathname} />}
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>

      {locked && <LockScreen />}
    </div>
  );
}
