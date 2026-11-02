// What the shared guest pieces say, without React (tests/guest-shared.test.js
// checks them): times, "open now", a business's initials, call and map links.

const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

// "21:00" → "9:00 pm", "00:30" → "12:30 am", the way Indian shops write it.
export function clockLabel(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || ""));

  if (!match) {
    return "";
  }

  const hours = Number(match[1]);
  const suffix = hours < 12 ? "am" : "pm";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;

  return `${twelve}:${match[2]} ${suffix}`;
}

// The band's line about the hours, from a business card's `hours`
// ({ known, openNow, closesAt, opensAt: { in, day, time } }): { open, text },
// or null when the hours are not known.
export function openLine(hours) {
  if (!hours || !hours.known) {
    return null;
  }

  if (hours.openNow) {
    return { open: true, text: hours.closesAt ? `Open now · closes ${clockLabel(hours.closesAt)}` : "Open now" };
  }

  const next = hours.opensAt;

  if (!next) {
    return { open: false, text: "Closed" };
  }

  const when = next.in === 0 ? "" : next.in === 1 ? "tomorrow " : `${DAY_NAMES[next.day] || next.day} `;

  return { open: false, text: `Closed · opens ${when}at ${clockLabel(next.time)}` };
}

// One or two letters for a business with no logo: "Shine Unisex Salon" → "SU".
export const initials = (name) =>
  String(name || "")
    .split(/\s+/)
    .filter((word) => /\p{L}|\d/u.test(word))
    .slice(0, 2)
    .map((word) => [...word][0].toUpperCase())
    .join("");

// A phone number to call, as tel: wants it (digits and a leading +).
export const telHref = (phone) => {
  const digits = String(phone || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return digits.replace(/\D/g, "").length >= 6 ? `tel:${digits}` : null;
};

// Directions in Google Maps from a business card's name and address (no maps
// account is needed for a search link).
export function mapsHref(card) {
  const location = (card && card.location) || {};
  const parts = [card && card.name, location.address, location.city, location.postalCode].filter(Boolean);

  return location.address || location.city ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(", "))}` : null;
}

// The seller details a guest page's footer shows: the card's, with what the
// page itself adds (a shop's customer care and grievance officer, a food
// shop's FSSAI licence), each only when present.
export function sellerLines(card, extra = {}) {
  const seller = { ...((card && card.seller) || {}), ...Object.fromEntries(Object.entries(extra || {}).filter(([, value]) => value)) };
  const lines = [];
  const contact = (person) => [person && person.phone, person && person.email].filter(Boolean).join(", ");

  if (seller.legalName) lines.push({ label: "Sold by", value: seller.legalName });
  if (seller.address) lines.push({ label: "Address", value: seller.address });
  if (seller.gstin) lines.push({ label: "GSTIN", value: seller.gstin });
  if (seller.fssai) lines.push({ label: "FSSAI licence", value: seller.fssai });
  if (seller.customerCare && contact(seller.customerCare)) lines.push({ label: "Customer care", value: contact(seller.customerCare) });

  if (seller.grievance && seller.grievance.name) {
    const who = [seller.grievance.name, seller.grievance.designation].filter(Boolean).join(", ");
    lines.push({ label: "Grievance officer", value: [who, contact(seller.grievance)].filter(Boolean).join(" · ") });
  }

  return lines;
}
