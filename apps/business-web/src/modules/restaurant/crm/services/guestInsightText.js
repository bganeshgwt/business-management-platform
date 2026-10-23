// The sentences and spreadsheet cells the Guest insights page puts together.
//
// Kept out of the page, and free of React, the network and every import, so
// the exact code the page runs can also be run in plain Node by the module's
// tests. A "1 guests", a sentence with a hole where a date should be, or a
// formula slipping into a CSV is caught there rather than by a guest.

const COUNT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "1 guest", "2 guests", "1,240 guests".
export const plural = (value, one, many) => `${COUNT.format(Number(value || 0))} ${Number(value) === 1 ? one : many}`;

// "24 Sep", or "24 Sep 2025" when it is not this year. By hand, because
// en-IN spells September "Sept" and nowhere else in the app does.
export const shortDate = (iso, today) => {
  if (!iso) {
    return "—";
  }

  const [year, month, day] = iso.split("-").map(Number);
  const sameYear = today && iso.slice(0, 4) === today.slice(0, 4);

  return `${day} ${MONTHS[month - 1]}${sameYear ? "" : ` ${year}`}`;
};

// --- In the house now ---------------------------------------------------------

// What the in-house card says about a guest's history. Their table's running
// order is already a visit, so one visit means this is their first — "First
// visit" says that, where "1 visits · ₹0 lifetime" read as a fault. Spend and
// "usually has" are only worth saying once there is an earlier visit behind
// them: on a first visit the "usual" is just what is on the table now.
export const inHouseHistory = (guest) => {
  if (Number(guest.visits) <= 1) {
    return { visits: "First visit", showSpend: false, showFavourite: false };
  }

  return {
    visits: plural(guest.visits, "visit", "visits"),
    showSpend: Number(guest.lifetimeSpend) > 0,
    showFavourite: true,
  };
};

// --- empty lists ----------------------------------------------------------------

const agoText = (days) => {
  if (days <= 0) {
    return "today";
  }

  return days === 1 ? "yesterday" : `${COUNT.format(days)} days ago`;
};

// The At risk / lapsed list with nobody on it, said for the reason it is
// empty. A restaurant with no orders at all has no first day of history to
// name, so that case gets its own words instead of "starts on —".
export const lapsedEmpty = ({ history, rules, today }) => {
  const quiet = rules.lapsedQuietDays;

  if (!history || !history.startsOn) {
    return {
      message: "No visits recorded yet.",
      hint: `A guest counts as lapsed after ${quiet} quiet days, so this list fills in as the restaurant trades.`,
    };
  }

  if (history.days < quiet) {
    // history.days counts the first day itself, so a history that began
    // today is one day long and zero days old.
    return {
      message: "Nobody can have lapsed yet.",
      hint: `Visit history here starts on ${shortDate(history.startsOn, today)} — ${agoText(
        history.days - 1
      )}. A guest counts as lapsed after ${quiet} quiet days, so this list fills in as the restaurant keeps trading.`,
    };
  }

  return {
    message: "Nobody has lapsed.",
    hint: `Every guest with ${rules.lapsedMinVisits} or more visits has been back within ${quiet} days.`,
  };
};

// --- taking a list out ----------------------------------------------------------

// What Export and Copy will take, said before either is pressed: what the
// screen shows — the guests matching the search when there is one, else the
// whole list — every page of it, including rows not drawn yet. `canCopy`
// false: the person has Export only (copying mobiles needs the right to see
// guests' contact details), so the sentence names Export alone.
export const exportScope = ({ search, matching, onList, drawn, canCopy = true }) => {
  const beyond = (total) => (Number.isFinite(drawn) && total > drawn ? ", including those not shown yet" : "");
  const what = canCopy ? "Export and Copy take" : "Export takes";

  return search
    ? `${what} the ${plural(matching, "guest", "guests")} matching “${search}”${beyond(
        matching
      )}. Clear the search to take the whole list.`
    : `${what} the whole list: ${plural(onList, "guest", "guests")}${beyond(onList)}.`;
};

// The count is left out while the search's rows are still loading.
export const exportButtonLabel = ({ search, matching }) => {
  if (!search) {
    return "Export CSV";
  }

  return matching === null || matching === undefined ? "Export matching" : `Export ${COUNT.format(matching)} matching`;
};

export const copyButtonLabel = ({ search }) => (search ? "Copy their mobiles" : "Copy mobiles");

// "12 guests from Regulars", or "3 guests matching “pri” from Regulars".
export const exportedWhat = (data) =>
  `${plural(data.total, "guest", "guests")}${data.search ? ` matching “${data.search}”` : ""} from ${data.segment.label}`;

// A spreadsheet runs a cell that starts with = + - or @ (or a tab or a
// carriage return) as a formula, so a guest who gave their name as
// =HYPERLINK("…") would run code on the manager's laptop. Such a cell gets a
// leading apostrophe, which Excel and Google Sheets both read as "this is
// text". Numbers pass through untouched.
//
// services/csv.js toCsv, shared by every export in the app, only quotes
// cells; this guard is applied here, to this page's cells, before they reach
// it.
const spreadsheetSafe = (value) => {
  if (typeof value !== "string") {
    return value;
  }

  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
};

// A mobile as its last ten digits — no +91, leading 0 or spaces — the same
// key the screen matches ratings and complaints to guests on. It is the
// column a WhatsApp or SMS tool can take as it is, and one Excel neither
// reads as a formula nor strips a zero from. Blank when fewer than ten digits
// were typed: that is not a number anyone can message.
const tenDigitMobile = (mobile) => {
  const digits = String(mobile || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
};

// The rows of the CSV for an export, header first, every cell made safe. For
// someone who may not see guests' contact details the server sends each
// mobile and email masked ("XXXXXX3210"), as the guest book's export does:
// the masked form goes in, and the 10-digit column stays blank.
export const guestListSheet = (data) => [
  [
    "Name",
    "Mobile",
    "Mobile (10 digits)",
    "Email",
    "Visits",
    "Visits in last 60 days",
    "First visit",
    "Last visit",
    `Lifetime spend (${data.currency})`,
    `Average per visit (${data.currency})`,
    "Points",
    "Date of birth",
    "Why",
  ],
  ...data.items.map((guest) =>
    [
      guest.name,
      guest.mobile || guest.mobileMasked || "",
      tenDigitMobile(guest.mobile),
      guest.email || guest.emailMasked || "",
      guest.visits,
      guest.visits60,
      guest.firstVisitDate || "",
      guest.lastVisitDate || "",
      Number(guest.lifetimeSpend).toFixed(2),
      Number(guest.averageSpend).toFixed(2),
      guest.points,
      guest.dateOfBirth || "",
      guest.reason || "",
    ].map(spreadsheetSafe)
  ),
];

// "guests-regulars-2026-09-24.csv", or "guests-regulars-matching-pri-….csv".
export const guestListFilename = (data) => {
  const matching = data.search
    ? `-matching-${String(data.search)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "search"}`
    : "";

  return `guests-${data.segment.key}${matching}-${data.today}.csv`;
};
