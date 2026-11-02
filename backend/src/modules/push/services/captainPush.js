const config = require('../../../config/env');
const pool = require('../../../config/database');
const repo = require('../repositories/push.repository');
const webPush = require('./webPush');
const moments = require('./captainMoments');

// Alerts on a closed phone for the captain app (ARCHITECTURE.md › Alerts on
// a closed phone). The dispatcher hears every committed change the live
// updates hear (liveHub.onChange): a table request or a kitchen ticket that
// changed. It reads what the change means as the captain app would
// (captainMoments.js): a call or QR order waiting, food at the pass; finds
// the phones that would chime for it, by each person's permissions, outlet,
// captain section and shift now; claims the moment for each phone
// (push_deliveries, so with several API processes only one sends); and sends
// each claimed phone one short notification through its push service.
//
// A push service answering 404 or 410 has dropped the phone's address: the
// subscription is switched off at once. One that is busy or unreachable is
// tried once more a few seconds later; the open app's own list stays the
// truth either way. Nothing is logged but counts: never an address or a key.

const AREAS = new Set(['table_request', 'kot']);
const RETRY_MS = 4000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const idOf = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const createDispatcher = ({ db = pool, send = webPush.send, keys = null, now = () => Date.now(), retryMs = RETRY_MS } = {}) => {
  let signing = null;
  const running = new Map();

  const keysOf = () => {
    const settings = keys || config.push;
    if (!settings) return null;
    if (!signing || signing.settings !== settings) signing = { settings, keys: webPush.readKeys(settings) };
    return signing.keys;
  };

  // What a change means: a moment, or null.
  const momentOf = async (restaurantId, area, id) => {
    if (area === 'table_request') {
      const row = await one(db,
        `SELECT r.id, r.request_type, r.status, r.table_id, r.outlet_id, r.channel, r.created_by, r.created_at, r.item_count, r.order_id,
                t.table_no, o.name AS outlet_name
         FROM table_requests r
         JOIN dining_tables t ON t.id = r.table_id
         LEFT JOIN outlets o ON o.id = t.outlet_id
         WHERE r.restaurant_id = $1 AND r.id = $2`, [restaurantId, id]);
      return moments.requestMoment(row);
    }
    // Food at the pass, read as the captain app reads it (GET /kitchen/pass).
    const kitchen = require('../../restaurant/kitchen/services/kitchen.service');
    const { tickets } = await kitchen.pass(restaurantId, null);
    const ticket = tickets.find((each) => Number(each.id) === id);
    if (!ticket) return null;
    const place = await one(db,
      `SELECT k.outlet_id AS ticket_outlet_id, ord.table_id, t.table_no, o.name AS outlet_name
       FROM kots k JOIN orders ord ON ord.id = k.order_id
       LEFT JOIN dining_tables t ON t.id = ord.table_id
       LEFT JOIN outlets o ON o.id = t.outlet_id
       WHERE k.restaurant_id = $1 AND k.id = $2`, [restaurantId, id]);
    if (!place || !place.table_id) return null;
    return moments.foodMoment(ticket,
      { ticketOutletId: place.ticket_outlet_id, tableId: place.table_id, tableNo: place.table_no, outletName: place.outlet_name },
      tickets.filter((each) => String(each.orderId) === String(ticket.orderId)));
  };

  // One phone, one message; once more after a moment when the push service
  // was busy or out of reach.
  const deliver = async (sub, note, attempt = 1) => {
    const signingKeys = keysOf();
    if (!signingKeys) return 'off';
    const result = await send({ keys: signingKeys, subscription: sub, payload: note.payload, ttl: note.ttl, urgency: note.urgency, topic: note.topic });
    if (result.ok) {
      await repo.delivered(db, sub.id);
      return 'sent';
    }
    if (result.gone) {
      await repo.gone(db, sub.id, `push service ${result.status}`);
      return 'gone';
    }
    await repo.failed(db, sub.id);
    if (attempt === 1 && (result.status === 0 || result.status === 429 || result.status >= 500)) {
      const wait = Math.min(60000, result.retryAfter ? result.retryAfter * 1000 : retryMs);
      await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
      return deliver(sub, note, 2);
    }
    return 'failed';
  };

  const work = async (restaurantId, area, id) => {
    if (!(await repo.anyActive(db, restaurantId))) return [];
    const moment = await momentOf(restaurantId, area, id);
    if (!moment) return [];
    const subs = await repo.listActive(db, restaurantId, 'captain');
    if (!subs.length) return [];

    const features = new Set((await one(db, 'SELECT restaurant_features($1) AS features', [restaurantId])).features || []);
    const tables = new Map((await db.query("SELECT id, outlet_id FROM dining_tables WHERE restaurant_id = $1 AND status = 'active'", [restaurantId]))
      .rows.map((row) => [String(row.id), { outletId: row.outlet_id ? String(row.outlet_id) : null }]));
    // Each table's captain today, as GET /tables gives it for the outlet the person works in.
    const sections = require('../../restaurant/tables/services/captainSection.service');
    const byOutlet = new Map();
    for (const outletId of new Set(subs.map((sub) => (sub.outlet_id ? String(sub.outlet_id) : null)))) {
      const map = await sections.captainsToday(restaurantId, outletId ? Number(outletId) : null);
      byOutlet.set(outletId, new Map([...map].map(([tableId, captain]) => [String(tableId), String(captain.userId)])));
    }

    const at = now();
    const note = moments.message(moment);
    const sends = [];
    for (const row of subs) {
      const sub = {
        id: row.id, userId: String(row.user_id), outletId: row.outlet_id ? String(row.outlet_id) : null, allTables: row.all_tables,
        permissions: row.permissions, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth,
        lastPunch: row.last_punch ? { type: row.last_punch, at: row.last_punch_at, clockInAt: row.clock_in_at } : null,
      };
      if (!moments.receives(sub, moment, { features, tables, captainOf: (outletId) => byOutlet.get(outletId || null), now: at })) continue;
      const fresh = moments.freshKeys(moment, { since: row.watching_since, now: at });
      if (!fresh.length) continue;
      // Only the process whose claim goes in sends.
      const claimed = await repo.claim(db, row.id, fresh);
      if (claimed.length) sends.push(deliver(sub, note));
    }
    return Promise.all(sends);
  };

  // One change. Changes to the same row are handled one at a time: one
  // arriving meanwhile has it read once more after.
  const handle = async (note) => {
    const restaurantId = idOf(note && note.restaurant);
    const id = idOf(note && note.id);
    if (!restaurantId || !id || !AREAS.has(note.area) || !keysOf()) return [];
    const key = `${restaurantId}:${note.area}:${id}`;
    const busy = running.get(key);
    if (busy) {
      busy.again = true;
      return busy.promise;
    }
    const entry = { again: false, promise: null };
    entry.promise = (async () => {
      const results = [];
      try {
        do {
          entry.again = false;
          results.push(...(await work(restaurantId, note.area, id)));
        } while (entry.again);
      } finally {
        running.delete(key);
      }
      return results;
    })();
    running.set(key, entry);
    return entry.promise;
  };

  // A test alert to one person's own phone.
  const test = async (sub) => {
    const signingKeys = keysOf();
    if (!signingKeys) return { status: 'off' };
    const result = await send({ keys: signingKeys, subscription: sub, ...moments.testMessage() });
    if (result.ok) await repo.delivered(db, sub.id);
    else if (result.gone) await repo.gone(db, sub.id, `push service ${result.status}`);
    else await repo.failed(db, sub.id);
    return { status: result.ok ? 'sent' : result.gone ? 'gone' : 'failed', code: result.status };
  };

  return { handle, test, momentOf };
};

const one = async (db, sql, values) => (await db.query(sql, values)).rows[0] || null;

// The process's own dispatcher, started by server.js with the live updates:
// it hears every change, and prunes old deliveries and dropped phones hourly.
let started = null;

const start = (hub = require('../../live/services/liveHub')) => {
  if (started || !config.push) return started;
  const dispatcher = createDispatcher();
  const stopListening = hub.onChange((note) => {
    dispatcher.handle(note).catch((error) => console.warn(`Alerts on a closed phone: a change could not be sent (${error.message}).`));
  });
  const prune = () => repo.prune(pool).catch(() => undefined);
  const first = setTimeout(prune, 60000);
  const timer = setInterval(prune, PRUNE_EVERY_MS);
  first.unref();
  timer.unref();
  started = {
    dispatcher,
    stop: () => {
      stopListening();
      clearTimeout(first);
      clearInterval(timer);
      started = null;
    },
  };
  return started;
};

const stop = () => started && started.stop();

module.exports = { createDispatcher, start, stop };
