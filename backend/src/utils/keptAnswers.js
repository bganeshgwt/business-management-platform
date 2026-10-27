// Whether this process keeps answers between requests. The bell's answer cache
// (notifications/index.js) and the standing behind an owner's GST thresholds
// (modules/gst-thresholds/services/standingCache.js) follow this one switch:
// NOTIFICATIONS_CACHE=off keeps nothing; under NODE_ENV=test nothing is kept
// unless NOTIFICATIONS_CACHE=on, so a test that changes data and asks again
// sees the change at once.
function keptAnswersOn(env = process.env) {
  const setting = String(env.NOTIFICATIONS_CACHE || "").trim().toLowerCase();

  if (setting === "off") {
    return false;
  }

  return setting === "on" || String(env.NODE_ENV || "").trim().toLowerCase() !== "test";
}

module.exports = { keptAnswersOn };
