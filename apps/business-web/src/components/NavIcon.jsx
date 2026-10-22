// One small mark per menu entry.
//
// The sidebar carries thirty-one links in twelve sections, and without icons
// every one is the same shape: you have to read the words to find anything,
// every time. A mark gives the eye something to aim at, so "Bills" stops being
// the fourth line of text and becomes the card.
//
// Drawn here rather than pulled from an icon package: thirty-odd outlines at a
// couple of paths each cost about a kilobyte, against tens of kilobytes and a
// dependency for a set where we would use one icon in twenty.
//
// Everything is stroked in currentColor, so an icon takes the colour of the
// link it sits in — including the accent when that link is the page you are
// on — with no second rule to keep in step.

const PATHS = {
  // --- overview ---
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),

  // --- service ---
  pos: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <rect x="7" y="6" width="10" height="4" rx="1" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
    </>
  ),
  orders: (
    <>
      <path d="M6 2h12a1 1 0 0 1 1 1v18l-3-2-3 2-3-2-3 2V3a1 1 0 0 1 1-1Z" />
      <path d="M9 7h6M9 11h6" />
    </>
  ),
  // A carry bag with a tick: the order is packed and ready to collect.
  pickup: (
    <>
      <path d="M5 8h14l-1 12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
      <path d="m9.5 14.5 1.8 1.8 3.2-3.3" />
    </>
  ),
  // Toggles: how the floor works — courses, service charge, KOT routing.
  serviceSettings: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="3.5" />
      <circle cx="16.5" cy="7.5" r="1.8" />
      <rect x="3" y="13" width="18" height="7" rx="3.5" />
      <circle cx="7.5" cy="16.5" r="1.8" />
    </>
  ),
  bills: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h4" />
    </>
  ),
  // An account book with a clock: what guests and companies owe, and for how long.
  dues: (
    <>
      <path d="M5 3h10a2 2 0 0 1 2 2v5" />
      <path d="M5 3v18h8" />
      <path d="M8 8h6M8 12h4" />
      <circle cx="17.5" cy="17.5" r="4" />
      <path d="M17.5 15.5v2l1.5 1" />
    </>
  ),
  // A chef's hat: the kitchen's own screen.
  kitchen: (
    <>
      <path d="M7 14a4 4 0 0 1-.8-7.9A5 5 0 0 1 12 3a5 5 0 0 1 5.8 3.1A4 4 0 0 1 17 14" />
      <path d="M7 14h10v6H7Z" />
      <path d="M10 17h4" />
    </>
  ),
  // A service bell: a table asking for something.
  tableRequests: (
    <>
      <path d="M4 17a8 8 0 0 1 16 0Z" />
      <path d="M2 20h20M12 6V4M10 4h4" />
    </>
  ),
  // A booking register with a ribbon marker.
  reservations: (
    <>
      <path d="M5 3h12a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2Z" />
      <path d="M5 19a2 2 0 0 1 2-2h12" />
      <path d="M13 3v7l2-1.5 2 1.5V3" />
    </>
  ),
  // A scooter: the order leaving the building.
  deliveries: (
    <>
      <circle cx="6" cy="17" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M8.5 17h7M15 7h2l1 5v2.5M4 12h7l2 5" />
    </>
  ),

  // --- restaurant ---
  profile: (
    <>
      <path d="M3 9l1.5-5h15L21 9" />
      <path d="M4 9v11h16V9" />
      <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
    </>
  ),
  outlets: (
    <>
      <path d="M4 21V7l8-4 8 4v14" />
      <path d="M10 21v-6h4v6" />
    </>
  ),
  hours: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </>
  ),

  // --- menu ---
  categories: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </>
  ),
  products: (
    <>
      <path d="M3 12h18a9 9 0 0 1-18 0Z" />
      <path d="M3 20h18" />
      <path d="M12 3v3M9 5v1M15 5v1" />
    </>
  ),
  modifiers: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="18" r="2" />
    </>
  ),
  tax: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="7.5" cy="7.5" r="2.5" />
      <circle cx="16.5" cy="16.5" r="2.5" />
    </>
  ),
  happyHour: (
    <>
      <path d="M5 4h14l-7 8Z" />
      <path d="M12 12v7M8 19h8" />
    </>
  ),

  // --- tables ---
  floors: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </>
  ),
  tables: (
    <>
      <ellipse cx="12" cy="9" rx="8" ry="4" />
      <path d="M12 13v8M8 21h8" />
    </>
  ),

  // --- inventory ---
  stock: (
    <>
      <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5Z" />
      <path d="M3 7.5 12 12l9-4.5M12 12v9" />
    </>
  ),
  movements: (
    <>
      <path d="M7 4v13M7 20l-3-3M7 20l3-3" />
      <path d="M17 20V7M17 4l-3 3M17 4l3 3" />
    </>
  ),
  // Two stores with stock passing between them: one outlet's shelf to another's.
  transfers: (
    <>
      <rect x="2" y="9" width="6" height="10" rx="1" />
      <rect x="16" y="9" width="6" height="10" rx="1" />
      <path d="M10 11h4M12.5 9.5 14 11l-1.5 1.5" />
      <path d="M14 16h-4M11.5 14.5 10 16l1.5 1.5" />
      <path d="M2 9l3-4 3 4M16 9l3-4 3 4" />
    </>
  ),
  // A ruler: units of measure and how many go in a pack (Business Admin).
  units: (
    <>
      <rect x="2.5" y="8" width="19" height="8" rx="1.5" />
      <path d="M6.5 8v3M10.5 8v4M14.5 8v3M18.5 8v4" />
    </>
  ),
  // A clipboard with a tick: a stock count sheet.
  counts: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3h6v1" />
      <path d="m9 13 2 2 4-4" />
    </>
  ),
  // A hash: invoice and document numbering.
  numbering: <path d="M9 4 7 20M17 4l-2 16M4.5 9h15M3.5 15h15" />,
  // A map pin: the business's shops and warehouses.
  locations: (
    <>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  // Sliders: the rules stock and purchasing follow (units, par levels, approvals).
  sliders: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  // A bin with a downward trend: what was thrown away, and what to buy.
  inventoryInsights: (
    <>
      <path d="M4 7h16M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),

  // --- purchasing ---
  suppliers: (
    <>
      <path d="M2 7h11v9H2Z" />
      <path d="M13 10h4l3 3v3h-7Z" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  purchaseOrders: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 3h6v3H9Z" />
      <path d="M9 12h6M9 16h4" />
    </>
  ),
  returns: (
    <>
      <path d="M3 10h13a5 5 0 0 1 0 10h-6" />
      <path d="M3 10l4-4M3 10l4 4" />
    </>
  ),

  // --- customers ---
  customers: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 6a3 3 0 0 1 0 6M17 20a6 6 0 0 0-2-4.5" />
    </>
  ),
  feedback: (
    <>
      <path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6.1-5.3-3-5.3 3 1.1-6.1L3.4 9.4l6-.8Z" />
    </>
  ),
  complaints: (
    <>
      <path d="M12 3 2 20h20Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  // A target: guests grouped so the right ones can be reached.
  guestInsights: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),

  // --- operations ---
  businessDay: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </>
  ),
  discounts: (
    <>
      <path d="M20.6 12.6 12 21.2 2.8 12V3h9l8.6 8.6a1 1 0 0 1 0 1Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  expenses: (
    <>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M2 10h20" />
      <circle cx="17" cy="15" r="1.5" />
    </>
  ),

  // --- staff ---
  employees: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  shifts: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  attendance: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="m9 15 2 2 4-4" />
    </>
  ),
  // A stopwatch: the moment someone clocked in.
  timeclock: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5M10 2h4M12 2v3M19 6l1.5-1.5" />
    </>
  ),
  payroll: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  // A tip jar with a coin going in.
  tips: (
    <>
      <path d="M8 7h8M9 7V4h6v3M8 7c-2 1.6-3 3.5-3 6v5a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-5c0-2.5-1-4.4-3-6" />
      <circle cx="12" cy="15" r="2.5" />
    </>
  ),
  // A spiral-bound notebook: what one shift writes for the next.
  logbook: (
    <>
      <rect x="5" y="3" width="15" height="18" rx="2" />
      <path d="M3 7h4M3 12h4M3 17h4M10 8h6M10 12h6M10 16h3" />
    </>
  ),
  // A staff badge: your own shifts, attendance and payslips.
  mywork: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <circle cx="12" cy="10" r="2.5" />
      <path d="M8 17a4 4 0 0 1 8 0M10 3v2h4V3" />
    </>
  ),

  // --- reports ---
  reports: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  activity: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
      <path d="M3 12a9 9 0 0 1 .6-3" />
    </>
  ),

  // --- users & access ---
  users: (
    <>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M3 20a7 7 0 0 1 14 0" />
      <path d="M18 8.5h3M19.5 7v3" />
    </>
  ),
  roles: (
    <>
      <path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),

  // --- platform ---
  // A globe: every restaurant on the platform.
  platform: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </>
  ),

  // --- business types (pro pass): their own marks instead of borrowed ones ---
  loyalty: (
    <>
      <path d="M12 2 14.9 8.3 21.8 9 16.6 13.6 18.2 20.4 12 16.9 5.8 20.4 7.4 13.6 2.2 9 9.1 8.3Z" />
    </>
  ),
  package: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5Z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </>
  ),
  priceList: (
    <>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
      <path d="M7.5 7.5h.01" />
    </>
  ),
  collection: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  repair: (
    <>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z" />
    </>
  ),
  warranty: (
    <>
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),

  // --- tasks, issues & projects ---
  // A checklist: ticks beside lines.
  tasks: (
    <>
      <path d="m4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" />
      <path d="M11 6h9M11 12h9M11 18h6" />
    </>
  ),
  // Three columns of cards.
  board: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="11" rx="1" />
      <rect x="17" y="4" width="4" height="7" rx="1" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4M8 14h2M14 14h2M8 17h2" />
    </>
  ),
  // A warning triangle.
  issues: (
    <>
      <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  // A flag on a pole: a goal to reach.
  projects: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </>
  ),
  // A clipboard.
  templates: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3" />
    </>
  ),
  // Arrows going round.
  recurring: (
    <>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
};

export default function NavIcon({ name }) {
  const shape = PATHS[name];

  if (!shape) {
    return null;
  }

  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      // The label is right beside it; a screen reader should not hear both.
      aria-hidden="true"
      focusable="false"
    >
      {shape}
    </svg>
  );
}
