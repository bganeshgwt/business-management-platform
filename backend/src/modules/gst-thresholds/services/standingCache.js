const { keptAnswersOn } = require('../../../utils/keptAnswers');

// The standing of a business's PAN (gstThresholds.service.js standingOf), kept
// for five minutes in this process.
//
// Every screen's bell asks for it every 20 to 60 seconds, and a catalogue's
// card asks too, and each answer adds up two financial years of every business
// under the PAN. The answer depends on the business only, never on who asks:
// the PAN masked or in full, the sums and the links are shaped for each person
// outside it. So one answer serves everyone: two asking at the same moment
// share one reading, and an answer is kept for five minutes. Recording or
// clearing a PAN, and an owner changing their warning level, throw every kept
// answer away; anything else (a sale, a GSTIN changed in a business's settings,
// a new owner) shows within the five minutes. Kept answers follow the bell's
// switch (utils/keptAnswers.js): NOTIFICATIONS_CACHE=off keeps none, and under
// NODE_ENV=test none is kept unless NOTIFICATIONS_CACHE=on. Each API process
// keeps its own.
const KEEP_MS = 5 * 60 * 1000;
// A safety cap: one answer a business, and a memory with no limit is a leak.
const MAX_KEPT = 5000;

const kept = new Map();
// Bumped by clear(): a reading that started before it is not kept.
let generation = 0;

function sweep(now) {
  for (const [key, entry] of kept) if (!entry.pending && entry.expires <= now) kept.delete(key);
  // Still too many: the oldest go first (a Map keeps the order they came in).
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
}

// The kept answer for `key` while it is fresh; else `read()` once, its answer
// shared by whoever asks meanwhile. A failed reading is never kept. `clock`
// (milliseconds now) is for tests.
function remember(key, read, clock = Date.now) {
  if (!keptAnswersOn()) return read();
  const found = kept.get(key);
  if (found && found.generation === generation) {
    if (found.pending) return found.pending;
    if (found.expires > clock()) return Promise.resolve(found.value);
  }
  const entry = { generation, pending: null, value: undefined, expires: 0 };
  entry.pending = Promise.resolve().then(read).then((value) => {
    entry.pending = null;
    if (kept.get(key) === entry && entry.generation === generation) {
      entry.value = value;
      entry.expires = clock() + KEEP_MS;
    } else if (kept.get(key) === entry) {
      kept.delete(key);
    }
    return value;
  }, (error) => {
    if (kept.get(key) === entry) kept.delete(key);
    throw error;
  });
  kept.set(key, entry);
  if (kept.size > MAX_KEPT) sweep(clock());
  return entry.pending;
}

// Something any standing may rest on has changed: nothing kept is handed out again.
function clear() {
  generation += 1;
  kept.clear();
}

module.exports = { remember, clear, size: () => kept.size, KEEP_MS, MAX_KEPT };
