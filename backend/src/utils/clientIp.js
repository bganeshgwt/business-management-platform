const config = require("../config/env");

// The address a request really came from.
//
// Behind a hosting proxy or load balancer every request reaches the API from
// the proxy's own address, so the per-address sign-in limit would be shared
// by every restaurant on the platform and the sign-in history would show the
// proxy for everyone. TRUST_PROXY (config/env.js) says how many proxies sit in
// front of the API; the client is then read from X-Forwarded-For, counting
// that many hops back from the connection, exactly as Express's own
// "trust proxy" hop count does. Entries further left than that were written
// by the client and are ignored, so a forged header cannot pick an address.
//
// When the app itself is set to trust the proxy (app.set("trust proxy")),
// Express has already worked this out as req.ip, and that is used.
const clientIp = (req) => {
  const socketIp = (req.socket && req.socket.remoteAddress) || req.ip || null;
  const hops = config.trustProxy;

  if (!hops || (req.app && req.app.get("trust proxy"))) {
    return req.ip || socketIp;
  }

  const forwarded = String(req.get("x-forwarded-for") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .reverse();
  const chain = [socketIp, ...forwarded];

  return chain[Math.min(hops, chain.length - 1)] || socketIp;
};

module.exports = clientIp;
