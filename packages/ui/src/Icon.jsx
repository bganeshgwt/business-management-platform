// The general icon set for the screens themselves: tiles, section headings,
// buttons, empty states, statuses.
//
// NavIcon draws the sidebar and is checked against the menu one mark per link;
// this is the open set everything else picks from. Same rules: a 24 grid,
// stroked in currentColor so an icon takes the colour of whatever it sits in
// (a red alert, an orange tile, a muted table cell) with no second rule, and
// hidden from screen readers unless it is given a `title` — the words beside
// it already say what it means.
//
//   <Icon name="money" />                 18 px, decorative
//   <Icon name="alert" size={16} />
//   <Icon name="trash" title="Delete" />  announced, for an icon-only button
//   <Icon name={look.icon} fallback="store" />  a name from data, with a stand-in

const PATHS = {
  // --- money ---
  money: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  rupee: <path d="M6 4h12M6 9h12M9 4c4.5 0 6 2 6 5s-2 5-6 5H6l8 7" />,
  receipt: (
    <>
      <path d="M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2Z" />
      <path d="M9 7h6M9 11h6M9 15h4" />
    </>
  ),
  card: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h4" />
    </>
  ),
  cash: (
    <>
      <rect x="2" y="7" width="20" height="12" rx="2" />
      <circle cx="12" cy="13" r="2.5" />
      <path d="M5 4h14" />
    </>
  ),
  // Money paid out to run the business (the same drawing as the menu's).
  expenses: (
    <>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M2 10h20" />
      <circle cx="17" cy="15" r="1.5" />
    </>
  ),
  wallet: (
    <>
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
      <path d="M17 14h.01" />
    </>
  ),
  percent: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </>
  ),
  tag: (
    <>
      <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  gift: (
    <>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 16v-4M12 16V8M17 16v-7" />
    </>
  ),
  "trend-up": (
    <>
      <path d="m22 7-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </>
  ),
  "trend-down": (
    <>
      <path d="m22 17-8.5-8.5-5 5L2 7" />
      <path d="M16 17h6v-6" />
    </>
  ),
  pie: (
    <>
      <path d="M21 12A9 9 0 1 1 12 3v9Z" />
      <path d="M15 3.5A9 9 0 0 1 20.5 9H15Z" />
    </>
  ),

  // --- people ---
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0" />
      <path d="M16 3.5a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3" />
    </>
  ),
  "user-plus": (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6" />
    </>
  ),
  chef: (
    <>
      <path d="M7 14a4 4 0 0 1-.8-7.9A5 5 0 0 1 12 3a5 5 0 0 1 5.8 3.1A4 4 0 0 1 17 14" />
      <path d="M7 14h10v6H7Z" />
      <path d="M10 17h4" />
    </>
  ),
  heart: <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" />,
  star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z" />,
  smile: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
    </>
  ),
  frown: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M16 16s-1.5-2-4-2-4 2-4 2M9 9h.01M15 9h.01" />
    </>
  ),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
  phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />,
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </>
  ),

  // --- time ---
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="14" r="8" />
      <path d="M10 2h4M12 14l3-3M12 6V2" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l4 2" />
    </>
  ),

  // --- status ---
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  "alert-circle": (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6M9 9l6 6" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  unlock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.8-1.2" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3 13.8 8.2 19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
      <path d="M19 3v4M17 5h4M5 17v4M3 19h4" />
    </>
  ),
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9Z" />,
  fire: <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4.1 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.2 1.6 1.3 2.8 2.5 2.8Z" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M14.1 14.1a3 3 0 0 1-4.2-4.2M2 2l20 20" />
    </>
  ),

  // --- actions ---
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  filter: <path d="M22 3H2l8 9.5V19l4 2v-8.5Z" />,
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5M12 15V3" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5M12 3v12" />
    </>
  ),
  print: (
    <>
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5M3 21v-5h5" />
    </>
  ),
  undo: (
    <>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
    </>
  ),
  external: (
    <>
      <path d="M15 3h6v6M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  "more-vertical": (
    <>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  settings: (
    <>
      <path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  sliders: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
  login: (
    <>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="m10 17 5-5-5-5M15 12H3" />
    </>
  ),
  switch: (
    <>
      <path d="m16 3 4 4-4 4M20 7H4" />
      <path d="m8 21-4-4 4-4M4 17h16" />
    </>
  ),

  // --- arrows ---
  "chevron-up": <path d="m18 15-6-6-6 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "chevrons-up-down": <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />,
  "arrow-up": <path d="M12 19V5M5 12l7-7 7 7" />,
  "arrow-down": <path d="M12 5v14M19 12l-7 7-7-7" />,
  "arrow-left": <path d="M19 12H5M12 19l-7-7 7-7" />,
  "arrow-right": <path d="M5 12h14M12 5l7 7-7 7" />,

  // --- the restaurant ---
  utensils: (
    <>
      <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20" />
      <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
    </>
  ),
  coffee: (
    <>
      <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
      <path d="M6 2v2M10 2v2M14 2v2" />
    </>
  ),
  cloche: (
    <>
      <path d="M4 17a8 8 0 0 1 16 0" />
      <path d="M2 17h20M12 9V7.5M10.5 7h3M3.5 20h17" />
    </>
  ),
  table: (
    <>
      <path d="M3 9h18M5 9v11M19 9v11M3 5h18v4H3Z" />
      <path d="M9 14h6" />
    </>
  ),
  truck: (
    <>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.6a1 1 0 0 0-.2-.6l-3.5-4.4A1 1 0 0 0 17.5 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </>
  ),
  scooter: (
    <>
      <circle cx="6" cy="17" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M8.5 17h7M15 7h2l1 5v2.5M4 12h7l2 5" />
    </>
  ),
  box: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7Z" />
      <path d="M3.3 7 12 12l8.7-5M12 22V12" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 10 5-10 5L2 7Z" />
      <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
    </>
  ),
  leaf: (
    <>
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" />
      <path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12" />
    </>
  ),
  qr: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3ZM20 14v.01M14 20h.01M17 20h4v-3" />
    </>
  ),
  "map-pin": (
    <>
      <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>
  ),
  store: (
    <>
      <path d="M3 9 4.5 4h15L21 9" />
      <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M5 12v9h14v-9" />
      <path d="M10 21v-5h4v5" />
    </>
  ),
  home: (
    <>
      <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M9 22V12h6v10" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </>
  ),
  clipboard: (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5Z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
    </>
  ),
  scale: (
    <>
      <path d="M12 3v18M7 21h10M5 7h14" />
      <path d="m5 7-3 7a3 3 0 0 0 6 0Zm14 0-3 7a3 3 0 0 0 6 0Z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  // --- business types and kinds (Platform › Business types picks from these) ---
  basket: (
    <>
      <path d="M2 10h20" />
      <path d="m4 10 1.8 8.4A2 2 0 0 0 7.8 20h8.4a2 2 0 0 0 2-1.6L20 10" />
      <path d="m8 10 2.5-6h3L16 10M12 13.5v3M9 13.5l.4 3M15 13.5l-.4 3" />
    </>
  ),
  cart: (
    <>
      <path d="M2 3h2.5l2.7 11.4a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 1.9-1.5L21 7H5.6" />
      <circle cx="9.5" cy="20" r="1.5" />
      <circle cx="17.5" cy="20" r="1.5" />
    </>
  ),
  fish: (
    <>
      <path d="M6.5 12c2.5-3.6 6-5.5 9.5-5.5 3 0 5.2 1.9 6 5.5-.8 3.6-3 5.5-6 5.5-3.5 0-7-1.9-9.5-5.5Z" />
      <path d="M6.5 12 2 8v8ZM18 11h.01" />
    </>
  ),
  shirt: <path d="M9 3 4.5 5 2 9.5l3.5 1.8L6 10.5V21h12V10.5l.5.8L22 9.5 19.5 5 15 3a3 3 0 0 1-6 0Z" />,
  smartphone: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  pill: (
    <>
      <path d="M10.5 20.5a5 5 0 0 1-7-7l7-7a5 5 0 0 1 7 7Z" />
      <path d="m7 10 7 7" />
    </>
  ),
  glasses: (
    <>
      <circle cx="6" cy="15" r="4" />
      <circle cx="18" cy="15" r="4" />
      <path d="M10 14.5a2 2 0 0 1 4 0M2 15l1.5-8H6M22 15l-1.5-8H18" />
    </>
  ),
  gem: (
    <>
      <path d="M6 3h12l4 6-10 12L2 9Z" />
      <path d="M2 9h20M10 3 8 9l4 12 4-12-2-6" />
    </>
  ),
  hammer: (
    <>
      <path d="m10.5 6.5 4-4 7 7-4 4Z" />
      <path d="M14 10 3.5 20.5" />
    </>
  ),
  sprout: (
    <>
      <path d="M12 21v-9M7 21h10" />
      <path d="M12 13c0-4-3-6.5-8-6.5 0 4 3 6.5 8 6.5ZM12 11.5c0-4.5 3-7.5 8-7.5 0 4.5-3 7.5-8 7.5Z" />
    </>
  ),
  wrench: (
    <>
      <path d="M15 10.5 5.2 20.3a1.7 1.7 0 0 1-2.5-2.5L12.5 8" />
      <path d="M12.5 8a5 5 0 0 1 6.7-5.8L16 5.4l.6 2 2 .6 3.2-3.2A5 5 0 0 1 15 10.5" />
    </>
  ),
  fuel: (
    <>
      <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M7 8h4" />
      <path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8.5L18 5.5" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.1 8.1 19 19M8.1 15.9 19 5" />
    </>
  ),
  stethoscope: (
    <>
      <path d="M4 3v5a4 4 0 0 0 8 0V3M3 3h2M11 3h2" />
      <path d="M8 12v2.5a5.5 5.5 0 0 0 11 0V13" />
      <circle cx="19" cy="11" r="2" />
    </>
  ),
  dumbbell: (
    <>
      <path d="M9 12h6" />
      <rect x="6" y="6" width="3" height="12" rx="1" />
      <rect x="15" y="6" width="3" height="12" rx="1" />
      <rect x="3" y="9" width="3" height="6" rx="1" />
      <rect x="18" y="9" width="3" height="6" rx="1" />
    </>
  ),
  hanger: (
    <>
      <path d="M10 5a2 2 0 1 1 2 2v1.5" />
      <path d="M12 8.5 3.3 15.3A1.5 1.5 0 0 0 4.2 18h15.6a1.5 1.5 0 0 0 .9-2.7Z" />
    </>
  ),
  bed: (
    <>
      <path d="M2 20V6M2 16h20M22 20v-6a3 3 0 0 0-3-3h-9v5" />
      <circle cx="6.5" cy="12.5" r="1.8" />
    </>
  ),
  lotus: (
    <>
      <path d="M12 20c-2.4-2-3.5-4.5-3.5-7.5S10 7 12 5c2 2 3.5 4.5 3.5 7.5S14.4 18 12 20Z" />
      <path d="M12 20c-3.6 0-6.6-1.6-8.5-4.6 1.8-.8 3.8-1 5.6-.6M12 20c3.6 0 6.6-1.6 8.5-4.6-1.8-.8-3.8-1-5.6-.6" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  graduation: (
    <>
      <path d="M22 9 12 4 2 9l10 5Z" />
      <path d="M6 11v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5M22 9v6" />
    </>
  ),
  medal: (
    <>
      <path d="M8.5 2 11 9.2M15.5 2 13 9.2" />
      <circle cx="12" cy="15" r="6" />
      <path d="m12 12.4.8 1.7 1.8.2-1.3 1.3.3 1.8-1.6-.9-1.6.9.3-1.8-1.3-1.3 1.8-.2Z" />
    </>
  ),
  tooth: <path d="M12 5.5C10.5 4 8.8 3.5 7 3.5 4.5 3.5 3 5.5 3 8c0 3 1.2 4.5 1.7 7.5.4 2.6.9 5.5 2.6 5.5 1.6 0 1.9-2.6 2.3-4.5.3-1.3.8-2 2.4-2s2.1.7 2.4 2c.4 1.9.7 4.5 2.3 4.5 1.7 0 2.2-2.9 2.6-5.5.5-3 1.7-4.5 1.7-7.5 0-2.5-1.5-4.5-4-4.5-1.8 0-3.5.5-5 2Z" />,
  flask: (
    <>
      <path d="M9 3h6M10 3v6.5L4.6 18.2A1.8 1.8 0 0 0 6.1 21h11.8a1.8 1.8 0 0 0 1.5-2.8L14 9.5V3" />
      <path d="M7 15h10" />
    </>
  ),
  comb: (
    <>
      <path d="M3 6h18v4H3Z" />
      <path d="M5 10v8M8 10v6M11 10v8M14 10v6M17 10v8M20 10v5" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M16 9h3a1 1 0 0 1 1 1v11M2 21h20" />
      <path d="M8 7h1M11 7h1M8 11h1M11 11h1M8 15h1M11 15h1M10 21v-2" />
    </>
  ),
  washer: (
    <>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <circle cx="12" cy="13" r="5" />
      <path d="M7.5 5.5h.01M10.5 5.5h.01M9.5 13.5c.8-.7 1.7-.7 2.5 0s1.7.7 2.5 0" />
    </>
  ),
  iron: (
    <>
      <path d="M3 17a8 7 0 0 1 8-7h8a2 2 0 0 1 2 2v5Z" />
      <path d="M11 10V6.5a1.5 1.5 0 0 1 1.5-1.5h5a1.5 1.5 0 0 1 1.5 1.5V10" />
      <path d="M8 20.5h.01M12 20.5h.01M16 20.5h.01" />
    </>
  ),
  car: (
    <>
      <path d="M5 17H3a1 1 0 0 1-1-1v-3.4a2 2 0 0 1 .6-1.4L5 9l1.8-3.6A2 2 0 0 1 8.6 4.3h6.8a2 2 0 0 1 1.8 1.1L19 9l2.4 2.2a2 2 0 0 1 .6 1.4V16a1 1 0 0 1-1 1h-2M9 17h6M5 9h14" />
      <circle cx="7" cy="17" r="2" />
      <circle cx="17" cy="17" r="2" />
    </>
  ),
  tent: (
    <>
      <path d="M3 20 12 4l9 16Z" />
      <path d="m9.5 20 2.5-5 2.5 5M2 20h20" />
    </>
  ),
};

// An unknown name draws nothing rather than throwing: a typo costs an icon,
// never the page. `fallback` names one to draw instead (an icon set in data,
// such as a business type's, that this version does not have yet).
export default function Icon({ name, fallback, size = 18, strokeWidth = 2, title, className = "", style }) {
  const path = PATHS[name] || (fallback ? PATHS[fallback] : undefined);

  if (!path) {
    return null;
  }

  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : "true"}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {path}
    </svg>
  );
}

// The product's mark: a plate under a cloche, white on the brand orange. Used
// in the top bar, on the sign-in page and on the lock screen, so the product
// looks like one thing wherever someone meets it.
export function BrandMark({ size = 34, className = "" }) {
  return (
    <span className={`brand-mark ${className}`.trim()} style={{ "--mark-size": `${size}px` }} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="60%"
        height="60%"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {PATHS.cloche}
      </svg>
    </span>
  );
}
