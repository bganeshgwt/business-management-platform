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
