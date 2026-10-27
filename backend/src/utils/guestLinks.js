const config = require("../config/env");

// Every link the API builds to a guest's page (the guests' site: a table's
// /order/<token>, online ordering's /online/<token>, booking's /book/<token>,
// and the status pages under them) starts here: at the restaurant's own guest
// web address when it has set one (Service settings › Guest web address),
// otherwise at the guests' site's own address (GUEST_WEB_URL). Never
// a host typed into the code. null when neither is known: a developer's
// machine without GUEST_WEB_URL, where the staff app builds the link from its
// own setting instead.
const guestBaseUrl = (ownAddress = null) => String(ownAddress || config.guestWebUrl || "").replace(/\/+$/, "") || null;

// path: the page's own path, starting with a slash (/book/<token>).
const guestPageUrl = (path, ownAddress = null) => {
  const base = guestBaseUrl(ownAddress);
  return base ? `${base}${path}` : null;
};

module.exports = { guestBaseUrl, guestPageUrl };
