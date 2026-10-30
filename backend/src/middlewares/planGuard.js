const AppError = require("../utils/AppError");

// An ended business is read-only (paid plans). Everything in it can still be
// seen, printed and exported; nothing can be added or changed until it pays.
// Nothing is ever deleted. authenticate runs this on every signed-in request,
// so no route can forget it.
//
// The business a request acts on: the id of /api/businesses/:id/… (and of the
// routers mounted before /businesses with the same shape), read from the path
// the request is routed on and as the routes read it, however it is written;
// otherwise, for someone tied to a restaurant, their restaurant's business;
// otherwise none.
// Reads are never checked. A write costs one query (a restaurant's state is
// already in the signed-in profile, read with it).

const database = () => require("../config/database");

const MESSAGE = "This business's plan has ended. You can still see and export everything; renew in Your plan to add or change anything.";
const GUESTS_REFUSED = "This restaurant isn't taking orders online right now.";
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Writes an ended business may still make. method "*" is any write method.
const ALWAYS_ALLOWED = [
  // Signing in and the session; the person's own profile, password, PIN and
  // two-step sign-in; a manager's PIN approval (what it approves is checked on its own).
  { method: "*", pattern: /^\/api\/auth\//i },
  // Your plan: renewing is how the business comes back.
  { method: "*", pattern: /^\/api\/plan(\/|$)/i },
  { method: "*", pattern: /^\/api\/businesses\/\d+\/plan(\/|$)/i },
  // Adding another business of one's own; opening one (it remembers the last opened).
  { method: "POST", pattern: /^\/api\/businesses\/?$/i },
  { method: "POST", pattern: /^\/api\/businesses\/\d+\/open\/?$/i },
  // Marking the bell's notifications read.
  { method: "POST", pattern: /^\/api\/notifications\/(read|unread|read-all)\/?$/i },
  // Personal-data requests: a guest's or a customer's rights are honoured whatever the plan.
  { method: "*", pattern: /^\/api\/privacy(\/|$)/i },
  { method: "*", pattern: /^\/api\/businesses\/\d+\/privacy(\/|$)/i },
  // The platform console (the super admin's own).
  { method: "*", pattern: /^\/api\/users\/platform(\/|$)/i },
  // Requests sent as POST that only print or preview, read from the routes. A
  // preview that runs the action and rolls it back, or that applies changes
  // due first (quotes, tax change previews, close checks), counts as a write.
  //   restaurant/billing/routes/bill.routes.js:132 — print or reprint a bill (the print is counted)
  { method: "POST", pattern: /^\/api\/bills\/\d+\/print\/?$/i },
  //   restaurant/billing/routes/bill.routes.js:53 — what a bill's discount or charge change would come to
  { method: "POST", pattern: /^\/api\/bills\/\d+\/adjust\/check\/?$/i },
  //   restaurant/kitchen/routes/kitchen.routes.js:57 — print a kitchen ticket (KOT)
  { method: "POST", pattern: /^\/api\/kitchen\/kots\/\d+\/print\/?$/i },
  //   restaurant/kitchen/routes/kitchen.routes.js:66 — print a change slip (cancelled dish, table moved)
  { method: "POST", pattern: /^\/api\/kitchen\/slips\/\d+\/print\/?$/i },
  //   restaurant/setup/routes/restaurant.routes.js:32 — what switching a feature would do
  { method: "POST", pattern: /^\/api\/restaurants\/current\/features\/[a-z_]+\/preview\/?$/i },
  //   restaurant/staff/routes/tip.routes.js:20 — how tips would be shared out
  { method: "POST", pattern: /^\/api\/staff\/tips\/preview\/?$/i },
  //   business/agri/routes/businessAgri.routes.js:124 and :125 — the counter's licence and sale checks
  { method: "POST", pattern: /^\/api\/businesses\/\d+\/agri\/(licence|counter)-check\/?$/i },
  //   business/hardware/routes/businessHardware.routes.js:84 — a material calculator's workings
  { method: "POST", pattern: /^\/api\/businesses\/\d+\/hardware\/calculate\/?$/i },
  //   business/health/routes/businessHealth.routes.js:96 — a prescription's drug warnings
  { method: "POST", pattern: /^\/api\/businesses\/\d+\/clinic\/visits\/\d+\/prescription-check\/?$/i },
  //   business/jewellery/routes/businessJewellery.routes.js:98 and :154 — a jewellery bill and an old gold purchase as they would be
  { method: "POST", pattern: /^\/api\/businesses\/\d+\/jewellery\/(bills|old-gold)\/preview\/?$/i },
];

const allowed = (method, path) => ALWAYS_ALLOWED.some((rule) => (rule.method === "*" || rule.method === method) && rule.pattern.test(path));

// The path the request is routed on, without its query: an absolute-form
// target ("http://host/api/…") is routed on its own path too.
const pathOf = (req) => {
  try {
    return new URL(String(req.originalUrl || req.url || "/"), "http://localhost").pathname;
  } catch {
    return "/";
  }
};

// A path segment read as the routes read an id: Express decodes it, and
// validate.requiredId takes it as a number, so "5.0", "+5", "%35", "0x5",
// "5e0" and " 5" are all 5. null when it is not one (the route refuses it).
const idOf = (segment) => {
  let text;

  try {
    text = decodeURIComponent(segment);
  } catch {
    return null;
  }

  const id = text.trim() ? Number(text) : NaN;
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
};

// The path with every id written plainly, so the rules match however an id
// is written: /api/businesses/5.0/plan is Your plan of business 5.
const plainPath = (path) =>
  path
    .split("/")
    .map((segment) => {
      const id = idOf(segment);
      return id === null ? segment : String(id);
    })
    .join("/");

// The platform's own super admin: no restaurant, and the platform's permission.
const isSuperAdmin = (user) => Boolean(user && !user.restaurantId && (user.permissions || []).includes("platform.restaurants.manage"));

const refused = (businessId) => new AppError(402, MESSAGE, { reason: "plan_ended", businessId: Number(businessId) });

// Throws 402 plan_ended for a write to an ended business.
const assertWritable = async (req) => {
  if (!WRITES.has(req.method) || !req.user || isSuperAdmin(req.user)) {
    return;
  }

  const path = plainPath(pathOf(req));

  if (allowed(req.method, path)) {
    return;
  }

  const inBusiness = /^\/api\/businesses\/([^/]+)/i.exec(path);
  const businessId = inBusiness ? idOf(inBusiness[1]) : null;

  if (businessId) {
    const { rows } = await database().query("SELECT state FROM business_plan_state($1)", [businessId]);

    if (rows[0] && rows[0].state === "ended") {
      throw refused(businessId);
    }

    return;
  }

  // Someone tied to a restaurant: their restaurant's business, as their profile has it.
  if (req.user.restaurantId && req.user.plan && req.user.plan.state === "ended") {
    throw refused(req.user.plan.businessId);
  }
};

// The guests' own pages (table QR ordering, the online ordering page, online
// booking) take nothing for a restaurant whose business has ended or is
// switched off.
const assertTakingOrders = async (restaurantId) => {
  const { rows } = await database().query(
    "SELECT s.state FROM businesses b CROSS JOIN LATERAL business_plan_state(b.id) s WHERE b.legacy_restaurant_id = $1",
    [restaurantId]
  );

  if (rows[0] && ["ended", "off"].includes(rows[0].state)) {
    throw new AppError(409, GUESTS_REFUSED, { reason: "not_taking_orders" });
  }
};

module.exports = { ALWAYS_ALLOWED, MESSAGE, assertWritable, assertTakingOrders };
