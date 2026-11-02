// Online booking's words and links, without React (tests/online-booking.test.js
// checks them): why a request waits, what each kind of business calls its
// people, the booking link's address and the text to share it with.

import { customerWebOrigin } from "../../../../services/customerWeb.js";

// Why a request waits for the desk.
export const REASONS = {
  confirm: { label: "Confirms each booking", hint: "The link asks the desk to accept every booking." },
  no_shows: { label: "Missed visits before", hint: "This mobile missed two or more bookings in 90 days." },
  deposit: { label: "Deposit to take", hint: "The salon takes a deposit: call the guest and take it as you accept." },
  advance: { label: "Advance to check", hint: "The guest paid the advance by UPI: find the UTR in your UPI or bank app, then accept." },
};

// A booking's status as the desk reads it.
export const STATUS = {
  requested: { label: "Waiting for you", tone: "warning" },
  booked: { label: "Booked", tone: "info" },
  completed: { label: "Done", tone: "success" },
  no_show: { label: "No-show", tone: "warning" },
  declined: { label: "Declined", tone: "danger" },
  expired: { label: "Not answered in time", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "inactive" },
};

// What each kind of business calls the people guests book.
export function peopleWord(type, plural = false) {
  const words = {
    salon: ["stylist", "stylists"], healthcare: ["doctor", "doctors"], optical: ["optometrist", "optometrists"],
    garage: ["bay or mechanic", "bays and mechanics"], memberships: ["trainer", "trainers"], electronics: ["technician", "technicians"],
  }[type] || ["person", "people"];
  return words[plural ? 1 : 0];
}

// The booking link's address: the server's (it knows the guest web address),
// else the guests' site this staff app is set up with.
export const linkAddress = (link) => link?.url || (link?.token ? `${customerWebOrigin().replace(/\/+$/, "")}/appointments/${link.token}` : "");

// A ready WhatsApp message to share the link (the person sends it from their own WhatsApp).
export function shareText(name, type, url) {
  const what = { salon: "your salon appointment", healthcare: "an appointment with our doctors", optical: "your eye test", garage: "your vehicle's service",
    memberships: "a free trial session", electronics: "your service visit" }[type] || "your appointment";
  return `Book ${what} at ${name} online, any time: ${url}`;
}

// "₹1,200.50", Indian grouping.
export const rupees = (value) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

// "in 3 h 20 min", "in 12 min", "now": how long the desk has to answer.
export function answerWithin(iso, nowMs = Date.now()) {
  const minutes = Math.round((new Date(iso).getTime() - nowMs) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours >= 24 ? `in ${Math.round(hours / 24)} d` : `in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

// The reminder the desk sends the day before, from its own WhatsApp.
export function reminderText(row, businessName, timeZone) {
  const at = new Date(row.starts_at);
  const day = at.toLocaleDateString("en-IN", { timeZone, weekday: "long", day: "numeric", month: "short" });
  const time = at.toLocaleTimeString("en-IN", { timeZone, hour: "numeric", minute: "2-digit" });
  const first = String(row.booker_name || "").trim().split(/\s+/)[0] || "";
  return `Hi ${first}, a reminder of your ${row.services} with ${row.resource_name} at ${businessName} tomorrow, ${day} at ${time}. Reply here if you need to change it.`;
}

// The poster to print: an A5 page with the business's name (and logo), the QR
// and the address. `escape` makes text safe for the page.
export function posterHtml({ name, logoUrl, qr, url, place, type, escape }) {
  const line = { salon: "Book your next visit online", healthcare: "Book your doctor's appointment online", optical: "Book your eye test online",
    garage: "Book your vehicle's service online", memberships: "Book a free trial online", electronics: "Book a service visit online" }[type] || "Book online";
  return `<section class="poster">
    ${logoUrl ? `<img class="logo" src="${escape(logoUrl)}" alt="" />` : ""}
    <p class="name">${escape(name)}</p>
    ${place ? `<p class="place">${escape(place)}</p>` : ""}
    <p class="line">${escape(line)}</p>
    <img class="code" src="${qr}" alt="" />
    <p class="hint">Scan with your phone's camera</p>
    <p class="url">${escape(url)}</p>
  </section>`;
}
export const POSTER_STYLES = `
  @page { size: A5; margin: 10mm; }
  body { font-family: system-ui, "Segoe UI", sans-serif; color: #111; margin: 0; }
  p { margin: 0; }
  .poster { box-sizing: border-box; height: 188mm; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4mm;
    border: 1px solid #ccc; border-radius: 6mm; padding: 10mm; text-align: center; }
  .logo { max-height: 22mm; max-width: 60mm; object-fit: contain; }
  .name { font-size: 26px; font-weight: 800; }
  .place { font-size: 14px; color: #444; }
  .line { font-size: 18px; font-weight: 700; margin-top: 2mm; }
  .code { width: 80mm; height: 80mm; }
  .hint { font-size: 13px; color: #333; }
  .url { font-size: 10px; color: #666; word-break: break-all; }
`;
