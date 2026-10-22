// Where the guests' site lives (apps/customer-web): table QR ordering, online
// ordering and table booking. Every guest link the staff screens build or
// print starts from here when the restaurant has not set a guest web address
// of its own (Service settings).
//
// VITE_CUSTOMER_WEB_URL is that site's address (http://localhost:5174 in
// development), or "same-origin" when one domain serves both apps (its server
// sends /order, /online and /book to the guest site). The build refuses a
// value that is neither (vite.config.js). Read as a browser would, so
// "http://LOCALHOST:5174/" and "http://localhost:5174" are the same site.
export const customerWebOrigin = () => {
  const configured = String(import.meta.env?.VITE_CUSTOMER_WEB_URL || "").trim();

  if (configured && configured !== "same-origin") {
    try {
      const url = new URL(configured);

      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.origin;
      }
    } catch {
      // Not an address: this screen's own, as below.
    }
  }

  return window.location.origin;
};
