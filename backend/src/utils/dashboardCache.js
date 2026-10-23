// A short memory for the dashboard's answers.
//
// Every device in a restaurant shows the dashboard and asks again every 30
// seconds; three tills, the manager's phone and the owner at home ask the same
// questions of the same day. The answer is about twenty queries. For 15 seconds
// it is kept and handed back as it is — but only until something changes the
// day: any write that succeeds for the restaurant (a bill, a payment, a refund,
// an order, a kitchen ticket, an expense, the business day opening or closing)
// throws that restaurant's answers away at once, so money on the dashboard is
// never older than the last thing that happened.
//
// Kept in this process's memory. Each key starts with the restaurant, and the
// rest of the key is everything the answer depends on (the outlet, what the
// person may see), so one restaurant's figures can never answer another's
// question. Running more than one API process would give each its own memory;
// the 15-second limit is then the most any answer can lag.
const TTL_MS = 15000;
// A safety cap: the keys are few (restaurants × outlets × kinds of viewer), but
// a memory with no limit is a leak waiting for an unusual day.
const MAX_ENTRIES = 5000;

const entries = new Map();
// Bumped every time a restaurant's answers are thrown away. A reading that
// started before a write and finishes after it carries the older number and is
// not kept: the next person to ask gets a fresh one.
const generations = new Map();
let globalGeneration = 0;

const generationOf = (restaurantId) => `${globalGeneration}:${generations.get(String(restaurantId)) || 0}`;

const prune = () => {
  const now = Date.now();

  for (const [key, entry] of entries) {
    if (entry.expires <= now && !entry.pending) {
      entries.delete(key);
    }
  }

  // Still too many: drop the oldest (a Map keeps insertion order).
  while (entries.size > MAX_ENTRIES) {
    entries.delete(entries.keys().next().value);
  }
};

// The kept answer for `key` while it is fresh; otherwise `compute()` once —
// two devices asking at the same moment share the one reading rather than
// running it twice. A failed reading is never kept.
const remember = async (restaurantId, key, compute, ttl = TTL_MS) => {
  const fullKey = `${restaurantId}|${key}`;
  const now = Date.now();
  const found = entries.get(fullKey);

  if (found && found.generation === generationOf(restaurantId)) {
    if (found.pending) {
      return found.pending;
    }

    if (found.expires > now) {
      found.hits += 1;
      return found.value;
    }
  }

  const generation = generationOf(restaurantId);
  const entry = { generation, pending: null, value: undefined, expires: 0, hits: 0 };

  entry.pending = Promise.resolve()
    .then(compute)
    .then(
      (value) => {
        entry.pending = null;

        if (generationOf(restaurantId) === generation && entries.get(fullKey) === entry) {
          entry.value = value;
          entry.expires = Date.now() + ttl;
        } else if (entries.get(fullKey) === entry) {
          entries.delete(fullKey);
        }

        return value;
      },
      (error) => {
        if (entries.get(fullKey) === entry) {
          entries.delete(fullKey);
        }

        throw error;
      }
    );

  entries.set(fullKey, entry);

  if (entries.size > MAX_ENTRIES) {
    prune();
  }

  return entry.pending;
};

// Something changed for this restaurant: nothing kept for it may be handed
// out again.
const invalidate = (restaurantId) => {
  const id = String(restaurantId);
  generations.set(id, (generations.get(id) || 0) + 1);

  for (const key of entries.keys()) {
    if (key.startsWith(`${id}|`)) {
      entries.delete(key);
    }
  }
};

// A change whose restaurant the request does not name (a guest ordering from
// the table's QR code, an online order arriving): everything is thrown away.
// Rare and cheap — the next look simply reads again.
const invalidateAll = () => {
  globalGeneration += 1;
  entries.clear();
};

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Mounted once in app.js, before the routes. After any write that succeeded,
// the restaurant it was for loses its kept answers. Waiting for the response
// to finish means the write has been committed by then; a reading running at
// that moment is caught by the generation check above.
const clearOnWrite = (req, res, next) => {
  if (WRITES.has(req.method)) {
    res.on("finish", () => {
      if (res.statusCode >= 400) {
        return;
      }

      const restaurantId = req.user && req.user.restaurantId;

      if (restaurantId) {
        invalidate(restaurantId);
      } else {
        invalidateAll();
      }

      // The bell keeps some slow back-office answers for a few seconds
      // (notifications/index.js, cacheSeconds): a write starts it afresh, so a
      // purchase order sent for approval or a bill voided shows at once.
      // Required here, not at the top, to keep the two modules independent.
      try {
        require("../notifications").invalidate(restaurantId || undefined);
      } catch {
        // The bell has no cache to clear (or failed to load): nothing to do.
      }
    });
  }

  next();
};

module.exports = { remember, clearOnWrite };
