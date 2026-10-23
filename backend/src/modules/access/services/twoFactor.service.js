const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const twoFactorRepository = require("../repositories/twoFactor.repository");
const roleRepository = require("../repositories/role.repository");
const totp = require("../../../utils/totp");
const AppError = require("../../../utils/AppError");

// Two-step sign-in: the six-digit code from an authenticator app after the
// password. This file holds the codes, the recovery codes and the short
// "password was right, now the code" ticket; auth.service decides when sign-in
// asks for them.

// The name an authenticator app shows beside the code. Only new enrolments
// carry it: an existing enrolment keeps the name it was set up with, and the
// codes themselves never depend on it, so changing it signs nobody out.
const ISSUER = "Business Management Platform";
const RECOVERY_CODE_COUNT = 10;
// Long enough to find the phone and open the app; short enough that a ticket
// left on a shared screen is soon worthless.
const CHALLENGE_MINUTES = 10;
// "Trust this device for 30 days".
const TRUST_DAYS = 30;

const STATE_WORDS = {
  code: "Enter the 6-digit code from your authenticator app",
  setup: "Your role needs two-step sign-in. Set it up now with an authenticator app on your phone.",
};

// --- The ticket between the password and the code ------------------------------
//
// Signed with its own key (not the session key), so it can never be used as a
// session. It names the person, the token version they signed in under (a
// password change meanwhile voids it) and the remembered device the password
// was typed on, if any, whose own count of wrong tries the code step uses.
//
// Each ticket has its own id and works once: the step that hands out a
// session marks it used (see auth.service), so a ticket copied off a screen
// or out of a browser's history is worthless after the real sign-in.

const issueChallenge = (user, { step, deviceId = null, tokenVersion = 0 }) => {
  const token = jwt.sign(
    { purpose: `two_factor_${step}`, tv: tokenVersion, did: deviceId || null },
    totp.challengeKey(),
    {
      subject: String(user.id),
      expiresIn: `${CHALLENGE_MINUTES}m`,
      algorithm: "HS256",
      jwtid: crypto.randomUUID(),
    }
  );

  return {
    step,
    challengeToken: token,
    expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60000).toISOString(),
    message: STATE_WORDS[step],
    trustDays: TRUST_DAYS,
    user: { name: user.name },
  };
};

const readChallenge = (token, step) => {
  let payload;

  try {
    payload = jwt.verify(String(token || ""), totp.challengeKey(), { algorithms: ["HS256"] });
  } catch {
    throw new AppError(401, "That sign-in took too long. Enter your password again.", { reason: "challenge_expired" });
  }

  // A ticket without an id comes from before tickets worked once; it is
  // treated like an expired one (the person types the password again).
  if (!payload.jti) {
    throw new AppError(401, "That sign-in took too long. Enter your password again.", { reason: "challenge_expired" });
  }

  const allowed = Array.isArray(step) ? step : [step];

  if (!allowed.map((name) => `two_factor_${name}`).includes(payload.purpose)) {
    throw new AppError(400, "That sign-in step does not match. Enter your password again.", {
      reason: "challenge_mismatch",
    });
  }

  return {
    userId: Number(payload.sub),
    tokenVersion: Number(payload.tv || 0),
    deviceId: payload.did || null,
    step: payload.purpose.replace("two_factor_", ""),
    ticketId: String(payload.jti),
    expiresAt: new Date(Number(payload.exp) * 1000),
  };
};

// --- State ------------------------------------------------------------------------

const stateOf = async (userId) => {
  const row = await twoFactorRepository.findState(userId);

  if (!row) {
    return { enabled: false, required: false, enabledAt: null, recoveryCodesLeft: 0 };
  }

  return {
    enabled: Boolean(row.two_factor_enabled_at),
    enabledAt: row.two_factor_enabled_at,
    required: Boolean(row.required),
    recoveryCodesLeft: Number(row.recovery_codes_left || 0),
    setupStarted: Boolean(row.two_factor_pending_at),
  };
};

// --- Setting it up --------------------------------------------------------------------

const ALREADY_ON =
  "Two-step sign-in is already on for this account. To move it to a new phone, turn it off on My profile (password and a current code) and set it up again.";

// A new secret, kept as "pending" until the first code from the app proves
// the phone has it. This is the only time the secret leaves the server: as a
// QR code and as the key to type, for the person setting up their own phone.
// Never while two-step is on: a second phone must not be lined up behind the
// one in use.
const beginSetup = async (user) => {
  const secret = totp.newSecret();

  if (!(await twoFactorRepository.savePending(user.id, totp.encryptSecret(secret)))) {
    throw new AppError(409, ALREADY_ON, { reason: "already_enabled" });
  }

  const account = user.email || user.mobile || user.name;

  return {
    otpauthUrl: totp.otpauthUrl({ secret, account, issuer: ISSUER }),
    secret: totp.typedKey(secret),
    account,
    issuer: ISSUER,
  };
};

// Ten codes, and what is kept of them: their salted hashes and the salt.
const makeRecoveryCodes = async () => {
  const codes = new Set();

  while (codes.size < RECOVERY_CODE_COUNT) {
    codes.add(totp.newRecoveryCode());
  }

  const salt = totp.newRecoverySalt();
  const hashes = await Promise.all([...codes].map((code) => totp.hashRecoveryCodeWithSalt(code, salt)));

  return { codes: [...codes], hashes, salt };
};

const WRONG_CODE = "That code is not right. Check the 6 digits in your authenticator app and try again.";

// Confirms the pending secret with a code and switches two-step on. Returns
// the ten recovery codes, shown once. Refused while two-step is already on
// (the database refuses it too, in the statement that switches it on).
const confirmSetup = async (user, code) => {
  const state = await stateOf(user.id);

  if (state.enabled) {
    throw new AppError(409, ALREADY_ON, { reason: "already_enabled" });
  }

  const row = await twoFactorRepository.findSecret(user.id);

  if (!row || !row.two_factor_pending) {
    throw new AppError(409, "Start setting up two-step sign-in again: scan the new QR code first.", {
      reason: "no_setup",
    });
  }

  const secret = totp.decryptSecret(row.two_factor_pending);
  const step = secret ? totp.matchStep(secret, code) : null;

  if (step === null) {
    return { ok: false };
  }

  const { codes, hashes, salt } = await makeRecoveryCodes();
  const enabled = await twoFactorRepository.enable(
    user.id,
    user.restaurantId ?? user.restaurant_id ?? null,
    step,
    hashes,
    salt
  );

  if (!enabled) {
    throw new AppError(409, "Start setting up two-step sign-in again: scan the new QR code first.", {
      reason: "no_setup",
    });
  }

  return { ok: true, recoveryCodes: codes };
};

// --- Checking a code ---------------------------------------------------------------------

// A six-digit code: right, inside the 30 seconds either side, and for a step
// later than the last one used (the same code never works twice).
const checkCode = async (userId, code) => {
  const row = await twoFactorRepository.findSecret(userId);

  if (!row || !row.two_factor_secret) {
    return { ok: false, reason: "not_enabled" };
  }

  const secret = totp.decryptSecret(row.two_factor_secret);

  if (!secret) {
    return { ok: false, reason: "unreadable" };
  }

  const step = totp.matchStep(secret, code);

  if (step === null) {
    return { ok: false, reason: "wrong_code" };
  }

  if (!(await twoFactorRepository.spendStep(userId, step))) {
    return { ok: false, reason: "reused" };
  }

  return { ok: true, step };
};

// A recovery code: the salted hash for a set made since salted codes (no
// server key involved, so it works even after the server's keys changed),
// the older keyed hash for a set made before.
const checkRecoveryCode = async (userId, code) => {
  const clean = totp.normaliseRecoveryCode(code);

  if (clean.length !== 10) {
    return { ok: false, reason: "wrong_code" };
  }

  const salt = await twoFactorRepository.findRecoverySalt(userId);
  const hash = salt ? await totp.hashRecoveryCodeWithSalt(clean, salt) : totp.hashRecoveryCode(clean);

  return (await twoFactorRepository.spendRecoveryCode(userId, hash))
    ? { ok: true }
    : { ok: false, reason: "wrong_code" };
};

// What a refused code is told, in words.
const refusalOf = (result) => {
  if (result.reason === "reused") {
    return "That code has just been used. Wait for the next code in your authenticator app (it changes every 30 seconds).";
  }

  // The stored secret cannot be read with the server's current key (its
  // TWO_FACTOR_KEY, or JWT_SECRET when that is not set, was changed). No code
  // from the app can work, so the person is told the way back in at once.
  if (result.reason === "unreadable") {
    return "This server can no longer read your two-step key, so codes from your app cannot be checked. Sign in with one of your recovery codes, then set two-step up again on My profile, or ask an admin to reset your two-step under Users.";
  }

  return WRONG_CODE;
};

// A six-digit code, or a recovery code ("ABCDE-FGHJK"), as one check.
const checkAny = async (userId, { code, recoveryCode }) => {
  if (recoveryCode) {
    const result = await checkRecoveryCode(userId, recoveryCode);
    return { ...result, method: "recovery_code" };
  }

  const result = await checkCode(userId, code);
  return { ...result, method: "two_factor" };
};

const newRecoveryCodes = async (user) => {
  const { codes, hashes, salt } = await makeRecoveryCodes();
  await twoFactorRepository.newCodes(user.id, user.restaurantId ?? null, hashes, salt);
  return codes;
};

// --- Tickets ---------------------------------------------------------------------------

const isTicketSpent = (challenge) => twoFactorRepository.isTicketSpent(challenge.ticketId);

const spendTicket = (challenge) =>
  twoFactorRepository.spendTicket(challenge.ticketId, challenge.userId, challenge.expiresAt);

// --- Roles that must use it -----------------------------------------------------------------

const requiredRoles = async (restaurantId) =>
  (await twoFactorRepository.findRequiredRoles(restaurantId)).map((row) => ({
    id: row.role_id,
    name: row.name,
    code: row.code,
  }));

// Any active role this restaurant may give (its own or a shared system one),
// never the platform's Super Admin.
const saveRequiredRoles = async (restaurantId, roleIds, userId) => {
  const unique = [...new Set(roleIds.map(Number))];

  if (unique.length > 0) {
    const allowed = await roleRepository.findAssignableIds(restaurantId, unique);

    if (allowed.length !== unique.length) {
      throw new AppError(400, "One or more of the chosen roles are not available in this restaurant");
    }
  }

  const before = await requiredRoles(restaurantId);
  await twoFactorRepository.saveRequiredRoles(restaurantId, unique, userId);

  return { before, after: await requiredRoles(restaurantId) };
};

module.exports = {
  TRUST_DAYS,
  issueChallenge,
  readChallenge,
  stateOf,
  beginSetup,
  confirmSetup,
  checkAny,
  refusalOf,
  newRecoveryCodes,
  isTicketSpent,
  spendTicket,
  requiredRoles,
  saveRequiredRoles,
};
