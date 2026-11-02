const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const AppError = require('../../../utils/AppError');
const config = require('../../../config/env');
const repo = require('../repositories/push.repository');
const webPush = require('./webPush');

// A phone's alerts while the app is closed: the server's public key, saving
// and removing a phone's subscription, a renewed subscription moving over,
// and a test alert (API.md › Alerts on a closed phone). Nothing here logs.

const PURPOSES = ['captain'];
const OFF = 'Alerts on a closed phone are not set up on this server.';
const GONE = 'This phone\'s alerts address has stopped working. Turn alerts on again on this phone.';

const fail = (message, status = 400, details) => {
  throw new AppError(status, message, details);
};

const assertOn = () => {
  if (!config.push) fail(OFF, 404, { reason: 'push_off' });
};

// The session a request is signed in with: the login's token version and
// when the session ends (authenticate has checked the token).
const sessionOf = (token) => {
  const payload = jwt.decode(String(token || '')) || {};
  return { tokenVersion: Number(payload.tv || 0), endsAt: payload.exp ? new Date(payload.exp * 1000) : null };
};

// The subscription a browser made, as PushSubscription.toJSON() gives it.
const readSubscription = (value) => {
  const sub = value && typeof value === 'object' ? value : null;
  if (!sub) fail('Send the subscription this browser made: its endpoint and keys.');
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint.trim() : '';
  const where = webPush.endpointProblem(endpoint, { allowLocal: config.isTest });
  if (where) fail(where);
  const keys = sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
  const problem = webPush.keysProblem({ p256dh: keys.p256dh, auth: keys.auth });
  if (problem) fail(problem);
  return { endpoint, p256dh: String(keys.p256dh).trim(), auth: String(keys.auth).trim() };
};

const readEndpoint = (value) => {
  const endpoint = typeof value === 'string' ? value.trim() : '';
  if (!endpoint || endpoint.length > 2048) fail('Send the endpoint of this phone\'s subscription.');
  return endpoint;
};

const view = (row) => ({
  purpose: row.purpose,
  outletId: row.outlet_id ? Number(row.outlet_id) : null,
  allTables: Boolean(row.all_tables),
  watchingSince: row.watching_since,
  sessionEndsAt: row.session_ends_at,
  lastSuccessAt: row.last_success_at || null,
  createdAt: row.created_at,
});

const publicKey = () => {
  assertOn();
  return { publicKey: config.push.publicKey };
};

// Saves this phone's subscription for the person signed in, for the outlet
// they work in (resolveOutlet) and All tables or their own. The same phone
// saved again updates it: the app saves it again when it opens, when the
// session is renewed and when the person changes what they follow, so the
// server always alerts the person now holding the phone, for their session.
const subscribe = async (user, { body = {}, token, outletId = null, userAgent = '' }) => {
  assertOn();
  if (!user.restaurantId) fail('Alerts on a closed phone are for a restaurant\'s captains.', 403);
  const purpose = body.purpose === undefined ? 'captain' : body.purpose;
  if (!PURPOSES.includes(purpose)) fail('What the alerts are for must be captain.');
  if (body.allTables !== undefined && typeof body.allTables !== 'boolean') fail('All tables must be true or false.');
  const subscription = readSubscription(body.subscription);
  const session = sessionOf(token);
  if (!session.endsAt) fail('Your session has ended. Please sign in again.', 401);
  const row = await repo.save(repo.pool, {
    userId: user.id,
    purpose,
    restaurantId: user.restaurantId,
    outletId: outletId || null,
    allTables: Boolean(body.allTables),
    ...subscription,
    userAgent: String(userAgent || '').slice(0, 300) || null,
    tokenVersion: session.tokenVersion,
    sessionEndsAt: session.endsAt,
  });
  if (!row) fail(GONE, 409, { reason: 'subscription_gone' });
  return { created: Boolean(row.created), subscription: view(row) };
};

// Removes this phone's subscription: alerts switched off, or the person
// signing out. Answers whether there was one.
const unsubscribe = async (user, { endpoint }) => {
  const removed = await repo.remove(repo.pool, readEndpoint(endpoint), { userId: user.id, restaurantId: user.restaurantId });
  return { removed: Boolean(removed) };
};

// The browser renewed a subscription by itself (the service worker's
// pushsubscriptionchange, often while the app is closed and nobody is
// signed in): the old address and its secret prove it is the same phone.
const renew = async ({ oldEndpoint, oldAuth, subscription }) => {
  assertOn();
  const old = await repo.findByEndpoint(repo.pool, readEndpoint(oldEndpoint));
  const given = Buffer.from(String(oldAuth || ''));
  const kept = Buffer.from(String(old?.auth || ''));
  if (!old || old.disabled_at || kept.length === 0 || given.length !== kept.length || !crypto.timingSafeEqual(given, kept)) {
    fail('No phone with that subscription is getting alerts.', 404);
  }
  const next = readSubscription(subscription);
  if (next.endpoint !== old.endpoint && (await repo.findByEndpoint(repo.pool, next.endpoint))) {
    fail('That subscription is already saved.', 409);
  }
  const moved = await repo.move(repo.pool, old.id, next);
  if (!moved) fail(GONE, 409, { reason: 'subscription_gone' });
  return { renewed: true };
};

// A test alert to the person's own phone (this one: its endpoint).
const test = async (user, { endpoint }) => {
  assertOn();
  const row = await repo.findByEndpoint(repo.pool, readEndpoint(endpoint));
  if (!row || String(row.user_id) !== String(user.id)) fail('Alerts are not on for you on this phone. Turn them on first.', 404);
  if (row.disabled_at) fail(GONE, 409, { reason: 'subscription_gone' });
  const { createDispatcher } = require('./captainPush');
  const result = await createDispatcher().test({ id: row.id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth });
  if (result.status === 'gone') fail(GONE, 409, { reason: 'subscription_gone' });
  if (result.status !== 'sent') {
    fail('The phone\'s push service did not take the alert just now. Check the phone is online, then try again.', 502, { reason: 'push_failed' });
  }
  return { sent: true };
};

module.exports = { PURPOSES, publicKey, subscribe, unsubscribe, renew, test, sessionOf };
