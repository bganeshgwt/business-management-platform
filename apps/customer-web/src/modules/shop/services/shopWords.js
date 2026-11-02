import { useEffect, useState } from "react";

// The online shop's words and clocks, shared by its pages (no React components here).

// What GuestShell adds to the card's seller details for a shop selling online.
export const sellerExtras = (seller) => (seller ? { customerCare: seller.customerCare, grievance: seller.grievance, fssai: seller.fssai } : null);

// Re-renders every so often, for clocks that count down.
export function useNow(everyMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

// "in 12 min", "in 1 h 5 min", "now".
export function inWords(at, now) {
  const minutes = Math.round((new Date(at).getTime() - now) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

const addDay = (date, days) => {
  const [year, month, day] = String(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

// "Today", "Tomorrow" or "Thu 5 Nov" for "2026-11-05".
export function dayWords(date, today) {
  if (date === today) return "Today";
  if (date === addDay(today, 1)) return "Tomorrow";
  const [year, month, day] = String(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

// "10:00" → "10 am", "17:30" → "5:30 pm".
export function timeWords(time) {
  const [hours, minutes] = String(time).split(":").map(Number);
  return `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""} ${hours < 12 ? "am" : "pm"}`;
}

// The business's date today, from the browser's clock in India's time.
export const todayInIndia = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// What to do with an item that has run out: the order's choice, and a line's own.
export const SUBSTITUTIONS = [
  ["remove", "Remove it", "Leave it out; you pay nothing for it."],
  ["similar", "Replace with something similar", "The shop packs a similar item. If it costs more, you are asked first."],
  ["call", "Call me", "The shop calls you before it packs anything else in its place."],
];
