const registry = require("../../../../notifications");
const notificationRepository = require("../repositories/notification.repository");
const AppError = require("../../../../utils/AppError");

const RANK = { critical: 0, warning: 1, info: 2 };

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const emptyCounts = () => ({ critical: 0, warning: 0, info: 0 });

const tally = (items) => {
  const counts = emptyCounts();
  items.forEach((item) => {
    counts[item.severity] += 1;
  });
  return counts;
};

// Worst first, and within the same severity the newest first: what just went
// wrong is more likely to be fixable than what has been wrong all afternoon.
const bySeverityThenNewest = (a, b) =>
  RANK[a.severity] - RANK[b.severity] || b.at.localeCompare(a.at) || a.id.localeCompare(b.id);

const respond = (items, sources, now) => {
  const sorted = [...items].sort(bySeverityThenNewest);
  const unread = sorted.filter((item) => !item.read);

  return {
    items: sorted,
    unreadCount: unread.length,
    counts: tally(sorted),
    unreadCounts: tally(unread),
    sources,
    generatedAt: now.toISOString(),
  };
};

// Which of these live alerts this person has read.
//
// An ordinary alert is read if they marked it. A summary ("6 more bills
// unpaid") is read if they marked it AND every row behind it now was already
// behind it then: a bill being paid leaves it read, a new bill joining it
// makes it news. Along the way:
//   - marks of alerts that have ended are forgotten, so the same problem
//     coming back later arrives unread (only for providers that answered —
//     one that failed has not said its alerts ended);
//   - a read summary that now stands for fewer rows remembers only those, so
//     a row that was fixed and then goes wrong again is news too.
//
// Returns the alerts with `read`, without their members, which stay here.
const readState = async (user, alerts, sources) => {
  const ids = alerts.map((alert) => alert.id);
  const answered = sources.filter((source) => source.status === "ok").map((source) => source.key);

  const [marks] = await Promise.all([
    notificationRepository.findReads(user.restaurantId, user.id, ids),
    notificationRepository.forgetEnded(user.restaurantId, user.id, answered, ids),
  ]);

  const seenBy = new Map(marks.map((mark) => [mark.alert_id, mark.seen_members]));
  const updates = [];

  const items = alerts.map(({ members, ...alert }) => {
    let read = seenBy.has(alert.id);

    if (read && members) {
      const seen = seenBy.get(alert.id);

      if (seen === null) {
        // Read before it was a summary: what it holds now is what was seen.
        updates.push({ id: alert.id, members });
      } else {
        const known = new Set(seen);
        read = members.every((member) => known.has(member));

        if (read && members.length < known.size) {
          updates.push({ id: alert.id, members });
        }
      }
    }

    return { ...alert, read };
  });

  await notificationRepository.rememberMembers(user.restaurantId, user.id, updates);

  return items;
};

// Everything in the bell for this person, with what they have already read.
//
// A platform admin belongs to no restaurant and has nothing to be told about,
// so they get an empty bell rather than an error on every screen.
const listForUser = async (user) => {
  const now = new Date();

  if (!user.restaurantId) {
    return {
      items: [],
      unreadCount: 0,
      counts: emptyCounts(),
      unreadCounts: emptyCounts(),
      sources: [],
      generatedAt: now.toISOString(),
    };
  }

  const { alerts, sources } = await registry.collect({
    restaurantId: user.restaurantId,
    permissions: user.permissions || [],
    now,
    outletId: user.outletId || null,
    features: user.features,
  });

  return respond(await readState(user, alerts, sources), sources, now);
};

// Marks these alerts read — only those that are live for this person now.
//
// Asking the alerts' own providers first does three things: a read mark is
// never stored for something that was never in this person's bell (so the
// table cannot be filled with made-up ids), a summary's mark records the rows
// it holds at this moment, and a mark for an alert that cleared a second ago
// is quietly skipped rather than kept for a month.
const markRead = async (user, ids) => {
  requireRestaurantId(user.restaurantId);

  const permissions = user.permissions || [];
  const keys = new Set(await registry.permittedKeys(permissions, user.features));
  const mine = ids.filter((id) => keys.has(registry.keyOf(id)));

  if (mine.length === 0) {
    throw new AppError(
      400,
      ids.length === 1
        ? "That alert is not one of your notifications — refresh the list and try again"
        : "None of these alerts are among your notifications — refresh the list and try again"
    );
  }

  const { alerts } = await registry.collect({
    restaurantId: user.restaurantId,
    permissions,
    only: [...new Set(mine.map(registry.keyOf))],
    outletId: user.outletId || null,
    features: user.features,
    // What is live this moment, not a kept answer.
    fresh: true,
  });

  const live = new Map(alerts.map((alert) => [alert.id, alert]));
  const marks = mine
    .filter((id) => live.has(id))
    .map((id) => ({ id, members: live.get(id).members || null }));

  await notificationRepository.markRead(user.restaurantId, user.id, marks);
  await notificationRepository.pruneOld(user.restaurantId, user.id);

  const marked = new Set(marks.map((mark) => mark.id));

  return { ids: [...marked], skipped: ids.filter((id) => !marked.has(id)), read: true };
};

// Unread is only ever a delete of this person's own marks, so it needs no
// check that the alert is live: removing a mark that is not there is a no-op.
const markUnread = async (user, ids) => {
  requireRestaurantId(user.restaurantId);

  await notificationRepository.markUnread(user.restaurantId, user.id, ids);

  return { ids, read: false };
};

// "Mark all read" marks what the person was shown: the screen sends the ids
// in its list. Anything that has turned up since its last poll — a guest's
// QR order a few seconds ago — is left unread, so the badge counts it rather
// than it arriving already read. Ids that have ended since are skipped.
//
// Without `shownIds` (a caller that has no list of its own) it marks
// everything live for this person at this moment.
//
// The answer is the whole list as it now stands, so the screen can show it
// straight away, newcomers and all.
const markAllRead = async (user, shownIds = null) => {
  requireRestaurantId(user.restaurantId);

  const now = new Date();
  const { alerts, sources } = await registry.collect({
    restaurantId: user.restaurantId,
    permissions: user.permissions || [],
    now,
    outletId: user.outletId || null,
    features: user.features,
    fresh: true,
  });

  const membersOf = new Map(alerts.map((alert) => [alert.id, alert.members || null]));
  const items = await readState(user, alerts, sources);
  const shown = shownIds ? new Set(shownIds) : null;
  const toMark = items.filter((item) => !item.read && (!shown || shown.has(item.id)));

  await notificationRepository.markRead(
    user.restaurantId,
    user.id,
    toMark.map((item) => ({ id: item.id, members: membersOf.get(item.id) }))
  );
  await notificationRepository.pruneOld(user.restaurantId, user.id);

  const marked = new Set(toMark.map((item) => item.id));

  return {
    ...respond(
      items.map((item) => (marked.has(item.id) ? { ...item, read: true } : item)),
      sources,
      now
    ),
    marked: marked.size,
  };
};

module.exports = {
  listForUser,
  markRead,
  markUnread,
  markAllRead,
};
