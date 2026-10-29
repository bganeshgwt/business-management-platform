import { dayMonth } from "@bmp/shared/dates";

// What a GST rate change screen says, in a shop's words or a restaurant's.

export const WORDS = {
  shop: { item: "item", items: "items", Item: "Item", Items: "Items", rate: "slab", Rate: "GST slab", rates: "slabs", catalogue: "catalogue" },
  menu: { item: "dish", items: "dishes", Item: "Dish", Items: "Dishes", rate: "tax rate", Rate: "Tax rate", rates: "tax rates", catalogue: "menu" },
};

// A change as a whole: some of it still to come, in force, refused on its
// date by the database (every item it named), or all cancelled.
export const STATES = {
  scheduled: { label: "Scheduled", tone: "info" },
  in_force: { label: "In force", tone: "success" },
  refused: { label: "Refused", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
// One item in a change.
export const STATUSES = {
  scheduled: { label: "Scheduled", tone: "info" },
  applied: { label: "In force", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  refused: { label: "Refused", tone: "danger" },
};

export const onDate = (date) => dayMonth(String(date || "").slice(0, 10), { year: true });
export const rateText = (rate) => (rate === null || rate === undefined || rate === "" ? "" : `${Number(rate)}%`);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const keepsWords = (keeps) => (keeps === "net" ? "Part before GST kept" : "Total kept");

// A YYYY-MM-DD date moved by whole days.
export function addDays(date, days) {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
// The next 1 April after `today`: the day GST rates change each year.
export function nextApril(today) {
  const year = Number(String(today).slice(0, 4));
  const april = `${year}-04-01`;
  return april > today ? april : `${year + 1}-04-01`;
}

// A notification's list as pasted or read from a CSV file: one HSN / SAC code
// and its new rate a line, separated by a comma, a tab, a semicolon or spaces
// ("1905 31 00   5%", "4820,12", "9963\t18 %"). A code is written with or
// without spaces and dots; a line that is not a code and a rate (a heading,
// a note) is skipped and named, so nothing is dropped unseen. The server
// checks every line again.
export function readCodeList(text) {
  const lines = [];
  const skipped = [];
  String(text || "").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/).forEach((raw, index) => {
    const row = raw.trim().replace(/\s+%/g, "%");
    if (!row) return;
    const cells = /[,\t;]/.test(row) ? row.split(/[,\t;]/).map((cell) => cell.replace(/^"|"$/g, "").trim()).filter(Boolean)
      : (() => { const at = row.search(/\s+\S+$/); return at > 0 ? [row.slice(0, at), row.slice(at).trim()] : [row]; })();
    const code = String(cells[0] || "").replace(/[\s.]/g, "");
    const rate = String(cells[cells.length - 1] || "").replace(/\s|%/g, "");
    if (cells.length < 2 || !/^\d{4,8}$/.test(code) || !/^\d{1,3}(\.\d{1,2})?$/.test(rate)) skipped.push({ line: index + 1, text: row.slice(0, 80) });
    else lines.push({ code, rate });
  });
  return { lines, skipped };
}

// A rate kept in settings, as the screen names it, and what it holds.
export const SETTING_WORDS = {
  fashion_price: { title: "GST by price", name: "GST by price", help: "Clothing and footwear pay GST by the value of each piece: the lower rate up to the price per piece, the higher above it." },
  lodging_slabs: { title: "Room-night slabs", name: "the room-night slabs", help: "A room night at or below the limit is billed at the lower slab, one above it at the higher." },
  restaurant_default: { title: "Default GST rate", name: "the default GST rate", help: "Your usual rate: the GST of advances is worked out at the rate of the day each was received." },
};

// What an open quotation or sales order says while a GST rate change to come moves its items.
export const NOTICE_RULE = "A quotation billed after the date asks to be revised first; a sales order is invoiced at the rate of its invoice's day.";
export function noticeText(notice) {
  return `From ${onDate(notice.startsOn)} ${notice.items.length === 1 ? "this item moves" : "these items move"} from ${rateText(notice.from)} to ${rateText(notice.to)}: ${notice.items.join(", ")}.`;
}
