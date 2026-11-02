import { moneyExact, timeOnly } from "@bmp/shared/format";

// How the salesperson app writes money and times: rupees with paise (a
// salesperson reads exact figures to a shop owner), a time of day.
export const money = (value) => moneyExact(Number(value || 0));
export const timeOf = (at) => (at ? timeOnly(at) : "");
