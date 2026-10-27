// A web address that guests' links start with: a restaurant's own guest web
// address (Service settings), or the guests' site's own (GUEST_WEB_URL). One
// reading for both: http or https, a host, at most a path in front of the
// guest's page (/order/<token>), no query, fragment or login, and no trailing
// slash. "order.myrestaurant.in" is read as https://order.myrestaurant.in.
// Plain functions: config/env.js reads its setting with them before anything
// else loads.

const MAX_LENGTH = 200;

// { address } (null for an empty value), or { problem }: too_long,
// not_an_address, not_http or extra (a query, fragment or login).
function readWebAddress(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();

  if (!text) {
    return { address: null };
  }

  if (text.length > MAX_LENGTH) {
    return { problem: "too_long" };
  }

  let url;

  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { problem: "not_an_address" };
  }

  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    return { problem: "not_http" };
  }

  if (url.search || url.hash || url.username || url.password) {
    return { problem: "extra" };
  }

  return { address: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

// Addresses a guest's phone on mobile data cannot open: this computer, and
// the private ranges a shop-floor network hands out (as the staff app warns
// before printing QR codes).
function isLocalAddress(address) {
  let host;

  try {
    host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }

  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  );
}

module.exports = { MAX_LENGTH, readWebAddress, isLocalAddress };
