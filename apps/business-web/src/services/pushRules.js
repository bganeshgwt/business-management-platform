// The rules of this device's alerts on a closed phone (services/push.js),
// kept free of the browser and the API so they are tested on their own.

// What the switch can say, in order: the server has no keys; not in this
// build (development runs no service worker); an iPhone or iPad not running
// the Home Screen app; a browser with no push; notifications blocked; the
// browser's question still open; on; off.
export const pushStatus = ({ serverKey, production, secure, hasWorker, hasPush, hasNotification, ios, standalone, permission, subscribed, asking }) => {
  if (serverKey === undefined) return "checking";
  if (serverKey === null) return "off-server";
  if (!production) return "development";
  if (ios && !standalone) return "ios-install";
  if (!secure || !hasWorker || !hasPush || !hasNotification) return "unsupported";
  if (permission === "denied") return "denied";
  if (asking) return "asking";
  return subscribed && permission === "granted" ? "on" : "off";
};

// The server's public key as the browser wants it (the bytes of the point).
export const keyBytes = (base64url) => {
  const text = String(base64url).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(text.padEnd(text.length + ((4 - (text.length % 4)) % 4), "="));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
};
