const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Every login a test makes has a password someone else set: a row the test
// inserts, or a login a manager or the platform makes through the API. Its
// first sign-in therefore leads to choosing a password of its own before
// anything else answers (POST /auth/change-password; every other route says
// 403 password_change_required). signIn does that once for each login, with a
// fresh password, and remembers it: signing in again with the password the
// test gave uses the login's own instead, as its person would. The passwords
// stay in this test process's memory.

const own = new Map();
const keyOf = (base, identifier) => `${base} ${String(identifier).trim().toLowerCase()}`;

async function post(base, route, body, token) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// The password a login signs in with now: its own when signIn chose one for
// the password the test gave, else that password. For the routes that ask
// for the person's own password (a PIN, two-step set-up, a change).
const passwordOf = (base, identifier, given) => {
  const known = own.get(keyOf(base, identifier));
  return known && known.given === given ? known.password : given;
};

// A session whose password someone else set comes back after the login has
// chosen its own (every other session of it ended); any other answer, such as
// a two-step challenge, comes back as it is. `given` is the password the
// session was signed in with. Tests that finish two-step sign-in themselves
// pass the session it gives here.
async function chooseOwnPassword(base, identifier, given, session) {
  if (!session || !session.user || !session.user.passwordChangeRequired) return session;
  const password = `Own-${crypto.randomBytes(12).toString('base64url')}`;
  const changed = await post(base, '/auth/change-password', { currentPassword: given, newPassword: password }, session.token);
  assert.equal(changed.status, 200, `${identifier} could not choose a password of their own: ${changed.body.message}`);
  own.set(keyOf(base, identifier), { given, password });
  return { ...session, ...changed.body.data };
}

// Signs in as a login a test made, with the password the test gave it, and
// returns the session (or the two-step challenge); null when the sign-in is
// refused.
async function signIn(base, identifier, given) {
  const answer = await post(base, '/auth/login', { identifier, password: passwordOf(base, identifier, given) });
  if (answer.status !== 200) return null;
  return chooseOwnPassword(base, identifier, given, answer.body.data);
}

module.exports = { signIn, chooseOwnPassword, passwordOf };
