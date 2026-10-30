const authorize = require("../../../../middlewares/authorize");
const resolveOutlet = require("../../../../middlewares/resolveOutlet");
const reportOutlet = require("../../../../middlewares/reportOutlet");
const reportController = require("./report.controller");
const notificationController = require("../../notifications/controllers/notification.controller");
const tableController = require("../../tables/controllers/table.controller");
const reservationController = require("../../reservations/controllers/reservation.controller");
const tableRequestController = require("../../orders/controllers/tableRequest.controller");
const deliveryController = require("../../deliveries/controllers/delivery.controller");
const timeclockController = require("../../staff/controllers/timeclock.controller");
const inventoryInsightController = require("../../inventory/controllers/inventoryInsight.controller");
const guestInsightController = require("../../crm/controllers/guestInsight.controller");
const logbookController = require("../../logbook/controllers/logbook.controller");
const dashboardCache = require("../../../../utils/dashboardCache");

// The dashboard's live blocks in one answer.
//
// The dashboard used to ask each module on its own — the floor, the kitchen,
// bookings, table requests, deliveries, the time clock, stock, guests,
// birthdays, the bell and the log book: eleven requests from every device every 30 seconds.
// Here they are read in one go, by the very same code their own screens use:
// each block runs its route's own permission check, its own outlet rule and its
// own handler, so this answer can never show more than the person could read
// block by block. A block the person may not read is simply not in the answer
// (it is never read); a block that fails says why and the others still arrive.
//
// Each entry: the route's middleware chain, then its handler, exactly as the
// module's router mounts them.
const BLOCKS = {
  alerts: { chain: [notificationController.list] },
  tables: { perm: "tables.view", chain: [resolveOutlet, tableController.listTables] },
  // The kitchen block lives under /reports, so it reads the outlet the way a
  // report does (a closed outlet's history can be read).
  kitchen: { perm: "kds.view", feature: ["kitchen_display"], chain: [reportOutlet, reportController.kitchenLive] },
  reservations: { perm: "reservations.view", feature: ["reservations"], chain: [resolveOutlet, reservationController.board] },
  // Every restaurant's: its waiters ask for bills from the captain app. The
  // guests' orders and calls are in it only while QR ordering or the online
  // ordering page is on (the inbox's own summary).
  requests: { perm: "orders.view", chain: [resolveOutlet, tableRequestController.summary] },
  deliveries: { perm: "orders.view", feature: ["deliveries"], chain: [resolveOutlet, deliveryController.summary] },
  staff: { perm: "staff.clock", feature: ["staff_payroll"], chain: [timeclockController.board] },
  stock: { perm: "inventory.view", feature: ["stock_recipes"], chain: [resolveOutlet, inventoryInsightController.summary] },
  guests: { perm: "customers.view", feature: ["guests"], chain: [guestInsightController.summary] },
  // Soonest first, so today's are at the top of the first page.
  birthdays: {
    perm: "customers.view",
    feature: ["guests"],
    params: { key: "birthdays" },
    query: { limit: "50" },
    chain: [guestInsightController.segment],
  },
  // The log book's open follow-ups and what is new since the person last read.
  logbook: { perm: "logbook.view", chain: [logbookController.handover] },
};

const BLOCK_KEYS = Object.keys(BLOCKS);

// A response that only catches what a handler sends.
const captureResponse = (onEnd) => {
  const res = {
    statusCode: 200,
    headersSent: false,
    locals: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
    on() {
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      onEnd();
      return this;
    },
    send(body) {
      return this.json(body);
    },
    end() {
      this.headersSent = true;
      onEnd();
      return this;
    },
  };

  return res;
};

// Runs one block's chain on a request of its own (its own query, params and
// outlet; the same signed-in person and headers). Resolves with the handler's
// answer, or rejects with the error the block's own route would have given.
const runBlock = (req, block) =>
  new Promise((resolve, reject) => {
    const child = Object.create(req);
    Object.defineProperty(child, "query", { value: { ...(block.query || {}) }, writable: true, enumerable: true });
    child.params = { ...(block.params || {}) };
    child.outletId = undefined;
    child.outletPinned = undefined;

    let settled = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };

    const res = captureResponse(() => finish(resolve, res));
    const chain = [...(block.perm ? [authorize(block.perm)] : []), ...block.chain];

    const step = (index) => {
      if (settled) {
        return;
      }

      if (index >= chain.length) {
        finish(reject, new Error("The block ended without an answer"));
        return;
      }

      let movedOn = false;
      const next = (error) => {
        movedOn = true;

        if (error) {
          finish(reject, error);
        } else {
          step(index + 1);
        }
      };

      try {
        const result = chain[index](child, res, next);

        if (result && typeof result.then === "function") {
          result.then(
            () => {
              if (!movedOn && !settled) {
                finish(reject, new Error("The block ended without an answer"));
              }
            },
            (error) => finish(reject, error)
          );
        }
      } catch (error) {
        finish(reject, error);
      }
    };

    step(0);
  });

const readBlocks = (value) => {
  if (value === undefined || value === null || value === "") {
    return BLOCK_KEYS;
  }

  const asked = String(value)
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  // Unknown names are ignored rather than refused: an older screen asking for
  // a block that has since been renamed still gets the rest.
  return [...new Set(asked.filter((key) => BLOCK_KEYS.includes(key)))];
};

const can = (req, permission) => (req.user.permissions || []).includes(permission);

// A block of a restaurant feature switched off (Settings -> Features) is not
// read at all, like a block the person may not read: its key is simply not in
// the answer, so its cards and panels stay away. `feature` is a list of which
// any one will do.
const featureOn = (req, block) => !block.feature || block.feature.some((code) => (req.user.features || []).includes(code));

const readLive = async (req, keys) => {
  const blocks = {};

  await Promise.all(
    keys.map(async (key) => {
      try {
        const res = await runBlock(req, BLOCKS[key]);
        const body = res.body || {};

        blocks[key] =
          res.statusCode >= 400 || body.success === false
            ? { error: body.message || "This could not be read just now", status: res.statusCode }
            : { data: body.data };
      } catch (error) {
        const status = error.statusCode || error.status || 500;

        blocks[key] = {
          error: status >= 500 ? "This could not be read just now" : error.message,
          status,
        };

        if (status >= 500) {
          console.error(`Dashboard live block "${key}" failed:`, error);
        }
      }
    })
  );

  return { serverTime: new Date().toISOString(), blocks };
};

// GET /reports/dashboard/live?blocks=tables,kitchen,...
// Kept for 15 seconds per person, outlet and set of blocks, and thrown away at
// once by any write for the restaurant (see utils/dashboardCache.js). The key
// is the person, not only the restaurant: the bell is personal.
const live = async (req, res) => {
  const keys = readBlocks(req.query.blocks).filter(
    (key) => (!BLOCKS[key].perm || can(req, BLOCKS[key].perm)) && featureOn(req, BLOCKS[key])
  );
  const outletAsked = req.get("X-Outlet-Id") || "";
  // The blocks asked already follow the features switched on, so a switch
  // changes the key and never serves a cached answer from before it.
  const cacheKey = `live|${req.user.id}|${outletAsked}|${req.user.outletId || ""}|${keys.join(",")}`;

  const data = await dashboardCache.remember(req.user.restaurantId, cacheKey, () => readLive(req, keys));

  res.json({ success: true, data });
};

module.exports = { live };
