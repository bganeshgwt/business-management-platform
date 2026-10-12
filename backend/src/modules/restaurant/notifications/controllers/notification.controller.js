const notificationService = require("../services/notification.service");
const registry = require("../../../../notifications");
const AppError = require("../../../../utils/AppError");
const v = require("../../../../utils/validate");

// Enough for "mark everything on this screen" many times over; a request
// with more is not a person clicking.
const MAX_IDS = 500;
// "Mark all read" sends every id the screen holds. Each provider sends at
// most 100, so even a bell fed by every module stays under this.
const MAX_SHOWN_IDS = 2000;
const MAX_ID_LENGTH = registry.MAX_ID_LENGTH;

// Marking read is not audited: it changes what one person's own bell looks
// like and nothing else, and a log line per click would bury the entries a
// manager actually goes to the activity log for.
const readIds = (value, { max = MAX_IDS, field = "Alert ids" } = {}) => {
  const ids = v.requiredArray(value, field);

  if (ids.length === 0) {
    throw new AppError(400, "Choose at least one alert");
  }

  if (ids.length > max) {
    throw new AppError(400, `At most ${max} alerts can be marked at once`);
  }

  const clean = ids.map((id) => {
    if (typeof id !== "string" || !id.trim() || id.trim().length > MAX_ID_LENGTH) {
      throw new AppError(400, `Each alert id must be text of up to ${MAX_ID_LENGTH} characters`);
    }

    // The shape every provider's ids have: "stock:out:12". This also keeps a
    // NUL or other control character from reaching the database.
    if (!registry.keyOf(id.trim())) {
      throw new AppError(
        400,
        'Alert ids look like "stock:out:12", in plain text — refresh the list and try again'
      );
    }

    return id.trim();
  });

  // Duplicates would make the upsert touch the same row twice, which
  // PostgreSQL refuses.
  return [...new Set(clean)];
};

const list = async (req, res) => {
  res.json({ success: true, data: await notificationService.listForUser(req.user) });
};

const markRead = async (req, res) => {
  const data = await notificationService.markRead(req.user, readIds((req.body || {}).ids));

  res.json({
    success: true,
    message:
      data.ids.length > 0
        ? "Marked as read"
        : "That has already been dealt with — it is no longer in your notifications",
    data,
  });
};

const markUnread = async (req, res) => {
  const data = await notificationService.markUnread(req.user, readIds((req.body || {}).ids));

  res.json({ success: true, message: "Marked as unread", data });
};

// `ids`, when sent, are the alerts the screen was showing: only those are
// marked, so anything newer stays unread.
const markAllRead = async (req, res) => {
  const body = req.body || {};
  const shown =
    body.ids === undefined ? null : readIds(body.ids, { max: MAX_SHOWN_IDS, field: "Shown alert ids" });
  const data = await notificationService.markAllRead(req.user, shown);

  res.json({
    success: true,
    message:
      data.marked === 0
        ? "Nothing new to mark as read"
        : data.marked === 1
          ? "1 alert marked as read"
          : `${data.marked} alerts marked as read`,
    data,
  });
};

module.exports = {
  list,
  markRead,
  markUnread,
  markAllRead,
};
