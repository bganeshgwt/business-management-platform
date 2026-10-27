const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const config = require("../../../config/env");
const userRepository = require("../repositories/user.repository");
const twoFactorRepository = require("../repositories/twoFactor.repository");
const twoFactorService = require("./twoFactor.service");
const timeclockRepository = require("../../restaurant/staff/repositories/timeclock.repository");
const { isWeakPin, safeZone } = require("../../restaurant/staff/services/timeclock.service");
const { logFor } = require("../../../utils/audit");
const AppError = require("../../../utils/AppError");

// Compared against when the login is unknown, so a missing user takes as long
// as a wrong password and response time does not reveal which logins exist.
// The same cost used when a manager creates an account, so every hash in the
// table is equally expensive to attack.
const BCRYPT_ROUNDS = 12;
const PIN_ROUNDS = 10;

const DUMMY_PASSWORD_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

const WRONG_LOGIN = "That sign-in is not right. Check the email, mobile or staff code and the password.";

const toProfile = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  mobile: user.mobile,
  restaurantId: user.restaurant_id,
  restaurantName: user.restaurant_name,
  restaurantCode: user.restaurant_code || null,
  // restaurant, cafe, bakery or cloud_kitchen: the words and the POS's start.
  restaurantFormat: user.restaurant_format || "restaurant",
  outletId: user.outlet_id,
  outletName: user.outlet_name || null,
  employeeId: user.employee_id || null,
  employeeCode: user.employee_code || null,
  roles: user.roles,
  roleNames: user.role_names,
  permissions: user.permissions,
  // Restaurant features switched on for the restaurant (Settings -> Features).
  features: user.features || [],
  hasPin: Boolean(user.pin_set_at),
  // On or off only: the secret behind it is never sent anywhere.
  twoFactorEnabled: Boolean(user.two_factor_enabled_at),
  // Someone else set the password (a new login, a reset): the person chooses
  // their own before anything else (authenticate refuses every other route).
  passwordChangeRequired: Boolean(user.password_must_change),
  // Minutes a shared till may sit untouched before it locks. 0 = never.
  idleLockMinutes: Number(user.idle_lock_minutes || 0),
});

// --- Identifying the person ----------------------------------------------

// "+91 98480 11101", "098480-11101", "9848011101" -> "9848011101". null when
// it is not an Indian-style ten-digit mobile.
const mobileDigits = (value) => {
  const digits = String(value || "").replace(/[\s()+-]/g, "");

  if (!/^\d+$/.test(digits)) {
    return null;
  }

  if (digits.length === 10) {
    return digits;
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    return digits.slice(1);
  }

  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }

  return null;
};

// What was typed in the sign-in box: an email, a mobile number, or an
// employee code (which needs the restaurant code beside it).
const classify = (identifier) => {
  const value = String(identifier || "").trim();

  if (value.includes("@")) {
    return { kind: "email", value };
  }

  const mobile = mobileDigits(value);

  if (mobile) {
    return { kind: "mobile", value: mobile };
  }

  return { kind: "code", value: value.toUpperCase() };
};

// Every login the typed identifier could mean. An email or a staff code with
// its restaurant code is one login at most. A mobile number is unique inside
// one restaurant only, so a number can be a login at two restaurants (someone
// who works at both, or a number another restaurant registered): sign-in then
// checks the password against each, and only asks for the restaurant code
// when the password is right for more than one of them.
const findLoginCandidates = async ({ kind, value }, restaurantCode) => {
  if (kind === "email") {
    const user = await userRepository.findByEmail(value);
    return user ? [user] : [];
  }

  if (kind === "mobile") {
    return userRepository.findByMobile(value, restaurantCode);
  }

  if (!restaurantCode) {
    throw new AppError(400, "To sign in with a staff code, also enter your business code", {
      reason: "restaurant_code_required",
    });
  }

  const user = await userRepository.findByEmployeeCode(restaurantCode, value);
  return user ? [user] : [];
};

// --- Remembered devices ------------------------------------------------------
//
// After a good password, the browser is given a random device token (kept in
// its local storage) and the server keeps only its SHA-256. Signing in again
// from that browser shows the token: the device is remembered for that
// account, and its tries are counted on the device, not on the account. So
// five wrong passwords typed by a stranger lock the account for everyone
// else, while the owner's own phone and the restaurant's till still get in.
// A remembered device that types five wrong passwords itself is locked in
// turn, so a stolen device token guesses no faster than anyone.

const DEVICE_DAYS = 120;
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

const hashDevice = (token) => crypto.createHash("sha256").update(token).digest("hex");

// The device tokens a request carries (a shared till may hold one per person
// who signed in on it), as hashes. Anything malformed is ignored.
const deviceHashes = (tokens) =>
  (Array.isArray(tokens) ? tokens : [])
    .filter((token) => typeof token === "string" && DEVICE_TOKEN_PATTERN.test(token))
    .slice(0, 20)
    .map(hashDevice);

// --- Tokens ----------------------------------------------------------------

// The token version (tv) ties a token to the password it was issued under:
// changing or resetting the password, or "sign out everywhere", bumps the
// version and every older token stops working. Each token has a random id
// (jti), so two sign-ins in the same second are still two sessions (a till
// switch's PIN proof is good only in the session it was given to).
const issueToken = (user, tokenVersion) =>
  jwt.sign(
    { restaurantId: user.restaurant_id ?? user.restaurantId ?? null, tv: tokenVersion ?? user.token_version ?? 0 },
    config.jwt.secret,
    { subject: String(user.id), expiresIn: config.jwt.expiresIn, jwtid: crypto.randomBytes(12).toString("base64url") }
  );

const sessionOf = (token) => {
  const payload = jwt.decode(token);
  return payload && payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
};

// Throws if the user, or the restaurant they belong to, may not use the system.
// `status` lets a signed-in request answer 401 — which every screen treats as
// "signed out" — while the sign-in form keeps its 403.
const assertUserCanAccess = (user, status = 403) => {
  if (user.status !== "active") {
    throw new AppError(status, "Your account is not active. Ask your manager.", { reason: "account_inactive" });
  }

  if (user.restaurant_id && user.restaurant_status !== "active") {
    throw new AppError(status, "Your restaurant is not active", { reason: "restaurant_inactive" });
  }
};

// "9:28 pm" on the restaurant's own clock: the server may keep UTC, and a
// cashier in Kolkata told "locked until 3:58 pm" at 9:13 pm would be lost.
const zoneOf = async (restaurantId) =>
  restaurantId ? safeZone(await timeclockRepository.findTimezone(restaurantId)) : "Asia/Kolkata";

const lockedUntilText = (until, zone = "Asia/Kolkata") =>
  new Date(until).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: zone });

// A lock in force, or every try in this window already taken by attempts
// still being checked (a burst of guesses): refused either way, and nothing is
// compared.
// `cause` names what locked it when that is known: "passwords" right after
// the fifth wrong password, "codes" after the fifth wrong two-step code. An
// account found already locked may have been locked by either (the count is
// shared), so it is not blamed on the password the person just typed.
const LOCK_CAUSES = {
  passwords: "Too many wrong passwords",
  codes: "Too many wrong two-step codes",
  either: "Too many wrong sign-in tries (passwords or two-step codes)",
};

const accountLocked = (until, zone, cause = "either") =>
  until
    ? new AppError(
        423,
        `${LOCK_CAUSES[cause] || LOCK_CAUSES.either}. This account is locked until ${lockedUntilText(
          until,
          zone
        )}. A phone or till you have signed in on before still lets you in, or ask your manager to unlock it under Users.`,
        { reason: "account_locked", lockedUntil: new Date(until).toISOString() }
      )
    : new AppError(429, "Too many sign-in attempts for this account at once. Wait a minute and try again.", {
        reason: "too_many_attempts",
      });

// A remembered device that typed five wrong passwords itself.
const deviceLocked = (until, zone, cause = "either") =>
  until
    ? new AppError(
        423,
        `${LOCK_CAUSES[cause] || LOCK_CAUSES.either} on this device. Try again after ${lockedUntilText(
          until,
          zone
        )}, or ask your manager to unlock the account under Users.`,
        { reason: "device_locked", lockedUntil: new Date(until).toISOString() }
      )
    : accountLocked(null);

// Locked while typing two-step codes. The password was right, so the words
// must not say it was wrong: it was the codes (or, when the lock was already
// in force, the account's tries as a whole).
const codeLocked = (until, zone, { device = false, byCodes = true } = {}) =>
  until
    ? new AppError(
        423,
        `${byCodes ? "Too many wrong two-step codes" : "Too many wrong sign-in tries (passwords or two-step codes)"}${
          device ? " on this device" : ""
        }. This account is locked until ${lockedUntilText(
          until,
          zone
        )}. Check the time on your phone is set automatically, then try again after that, or ask your manager to unlock it under Users.`,
        { reason: device ? "device_locked" : "account_locked", lockedUntil: new Date(until).toISOString() }
      )
    : accountLocked(null);

const isFuture = (value) => Boolean(value && new Date(value) > new Date());

// --- Sign-in ---------------------------------------------------------------

// Password sign-in by email, mobile or staff code.
//
// Five tries in fifteen minutes, then that account locks for fifteen minutes
// (an admin can unlock it sooner). The try is counted BEFORE the password is
// compared, so a burst of parallel guesses gets five checks at most (see the
// lockout counters in user.repository). A remembered device counts its tries
// on itself instead (see above). Every attempt against a real account is
// written to that person's sign-in history, and a lockout to the activity log.
const login = async ({ identifier, password, restaurantCode, deviceTokens }, meta = {}) => {
  const candidates = await findLoginCandidates(classify(identifier), restaurantCode);

  if (candidates.length === 0) {
    // Same cost as a real check, so the response time does not tell which
    // logins exist.
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    throw new AppError(401, WRONG_LOGIN);
  }

  const hashes = deviceHashes(deviceTokens);

  // Take a place in each candidate's count (the device's, when this device
  // is remembered for them), then compare only where a place was given.
  const tries = [];

  for (const user of candidates) {
    const device = await userRepository.findTrustedDevice(user.id, hashes);
    const slot = device
      ? await userRepository.reserveDeviceAttempt(device.id, config.accountLock)
      : await userRepository.reserveLoginAttempt(user.id, config.accountLock);

    tries.push({ user, device, slot, match: false });
  }

  for (const attempt of tries) {
    if (attempt.slot.allowed) {
      attempt.match = await bcrypt.compare(password, attempt.user.password_hash);
    }
  }

  const historyOf = (attempt) => ({
    restaurantId: attempt.user.restaurant_id,
    userId: attempt.user.id,
    method: "password",
    identifier,
    ip: meta.ip,
    userAgent: meta.userAgent,
    trustedDevice: Boolean(attempt.device),
  });

  // A place taken on a login the password turned out not to be for (a mobile
  // shared by two logins) is handed back: that try was not against them.
  const release = async (attempt) => {
    if (!attempt.slot.allowed) {
      return;
    }

    if (attempt.device) {
      await userRepository.releaseDeviceAttempt(attempt.device.id);
    } else {
      await userRepository.releaseLoginAttempt(attempt.user.id);
    }
  };

  const matched = tries.filter((attempt) => attempt.match);

  if (matched.length > 0) {
    let chosen = matched[0];

    if (matched.length > 1) {
      // The same password at two restaurants. One of them switched off
      // leaves one choice; otherwise the restaurant code decides, because
      // guessing would sign the person in to the wrong restaurant. Only
      // someone who knows the password ever gets this far.
      const usable = matched.filter(
        (attempt) =>
          attempt.user.status === "active" &&
          (!attempt.user.restaurant_id || attempt.user.restaurant_status === "active")
      );

      if (usable.length !== 1) {
        for (const attempt of tries) {
          await release(attempt);
        }

        throw new AppError(
          400,
          "This mobile number signs in to more than one business. Enter your business code as well.",
          { reason: "restaurant_code_required" }
        );
      }

      chosen = usable[0];
    }

    for (const attempt of tries) {
      if (attempt !== chosen) {
        await release(attempt);
      }
    }

    return afterPassword(chosen, historyOf(chosen), meta);
  }

  // Nothing matched: every try counts against its login (or device), and
  // the one that used the last place sets the lock.
  let lockError = null;

  for (const attempt of tries) {
    const history = historyOf(attempt);

    if (!attempt.slot.allowed) {
      await userRepository.recordSignIn({ ...history, outcome: "locked" });

      if (!lockError) {
        const zone = await zoneOf(attempt.user.restaurant_id);
        lockError = attempt.device
          ? deviceLocked(attempt.slot.lockedUntil, zone)
          : accountLocked(attempt.slot.lockedUntil, zone);
      }

      continue;
    }

    const miss = attempt.device
      ? await userRepository.recordDeviceMiss(attempt.device.id, attempt.slot.place, config.accountLock)
      : await userRepository.recordLoginMiss(attempt.user.id, attempt.slot.place, config.accountLock);

    await userRepository.recordSignIn({ ...history, outcome: "wrong_password" });

    if (miss.justLocked) {
      logFor(
        { restaurantId: attempt.user.restaurant_id, userId: attempt.user.id, userName: attempt.user.name },
        "lock",
        attempt.device ? "user_device" : "user",
        {
          id: attempt.user.id,
          label: attempt.user.name,
          details: {
            reason: attempt.device
              ? `${config.accountLock.attempts} wrong passwords on a remembered device`
              : `${config.accountLock.attempts} wrong passwords`,
            lockedUntil: miss.lockedUntil,
          },
        }
      );

      if (!lockError) {
        const zone = await zoneOf(attempt.user.restaurant_id);
        lockError = attempt.device
          ? deviceLocked(miss.lockedUntil, zone, "passwords")
          : accountLocked(miss.lockedUntil, zone, "passwords");
      }
    }
  }

  if (lockError) {
    throw lockError;
  }

  throw new AppError(401, WRONG_LOGIN);
};

// The password was right. With two-step on (or required by the person's
// role), no session yet: a short ticket comes back and the code is asked for.
// The password's try stays counted until the code is right as well, so
// someone who knows the password still gets only five guesses at the code
// before the account locks, however often they retype the password.
//
// A device trusted for 30 days skips the code. An account that may not sign
// in at all is refused as before, without being asked for a code first.
const afterPassword = async (attempt, history, meta) => {
  const { user, device } = attempt;
  const canEnter =
    user.status === "active" && (!user.restaurant_id || user.restaurant_status === "active");

  if (canEnter) {
    const state = await twoFactorService.stateOf(user.id);

    if (state.enabled && device && isFuture(device.two_factor_trusted_until)) {
      return completeSignIn(attempt, { ...history, twoFactor: "trusted_device" }, meta);
    }

    if (state.enabled || state.required) {
      const step = state.enabled ? "code" : "setup";

      await userRepository.recordSignIn({ ...history, outcome: step === "code" ? "code_needed" : "setup_needed" });

      return {
        twoFactor: twoFactorService.issueChallenge(user, {
          step,
          deviceId: device ? device.id : null,
          tokenVersion: user.token_version,
        }),
      };
    }
  }

  return completeSignIn(attempt, history, meta);
};

// The sign-in is complete: the count starts again, the account must still be
// allowed in, and the device is remembered (or kept remembered). A new
// device's token is returned once, for the browser to keep.
//
// `twoFactor.passed` marks this device as one where the person passed
// two-step (a shared till then lets them switch in with their PIN), and
// `twoFactor.trustDays` trusts it for that long.
const completeSignIn = async ({ user, device }, history, meta, twoFactor = null) => {
  if (device) {
    await userRepository.recordDeviceHit(device.id);
  } else {
    await userRepository.recordLoginHit(user.id);
  }

  try {
    assertUserCanAccess(user);
  } catch (error) {
    await userRepository.recordSignIn({ ...history, outcome: "inactive" });
    throw error;
  }

  await userRepository.updateLastLogin(user.id);
  await userRepository.recordSignIn({ ...history, outcome: "success" });

  let deviceToken = null;
  let deviceId = device ? device.id : null;

  if (device) {
    await userRepository.touchDevice(device.id, DEVICE_DAYS);
  } else {
    deviceToken = crypto.randomBytes(32).toString("base64url");
    deviceId = await userRepository.rememberDevice({
      userId: user.id,
      restaurantId: user.restaurant_id,
      tokenHash: hashDevice(deviceToken),
      userAgent: meta.userAgent,
      days: DEVICE_DAYS,
    });
  }

  if (twoFactor && twoFactor.passed && deviceId) {
    await twoFactorRepository.markDevicePassed(deviceId, user.id, twoFactor.trustDays || 0);
  }

  const token = issueToken(user);
  const profile = await userRepository.findProfileById(user.id);

  return {
    token,
    expiresAt: sessionOf(token),
    user: toProfile(profile),
    ...(deviceToken ? { deviceToken } : {}),
  };
};

// --- Two-step sign-in: the code after the password ------------------------------

// The person and device a sign-in ticket names, still as they were: the same
// token version (no password change or "sign out everywhere" since), the
// device still remembered for them.
const challengeTarget = async (challengeToken, step) => {
  const challenge = twoFactorService.readChallenge(challengeToken, step);
  const user = await userRepository.findLoginById(challenge.userId);

  if (!user || Number(user.token_version || 0) !== challenge.tokenVersion) {
    throw new AppError(401, "That sign-in is no longer valid. Enter your password again.", {
      reason: "challenge_expired",
    });
  }

  // Each ticket works once: after the sign-in it led to, sending it again
  // (from a screen's history, a copied request) gets nothing.
  if (await twoFactorService.isTicketSpent(challenge)) {
    throw new AppError(409, "That sign-in has already been used. Enter your password again.", {
      reason: "challenge_used",
    });
  }

  const device = challenge.deviceId ? await twoFactorRepository.findDevice(challenge.deviceId, user.id) : null;

  return { challenge, user, device };
};

// Marks the ticket used just before a session is handed out. Two requests
// racing with the same ticket: only one gets past here.
const spendChallenge = async (challenge) => {
  if (!(await twoFactorService.spendTicket(challenge))) {
    throw new AppError(409, "That sign-in has already been used. Enter your password again.", {
      reason: "challenge_used",
    });
  }
};

// Setting up at sign-in is only for someone who has not got two-step yet. Once
// it is on, a set-up ticket (even an unused one from a second tab) must not
// put another phone on the account: the person signs in with their code.
const assertSetupStillOpen = async (user) => {
  const state = await twoFactorService.stateOf(user.id);

  if (state.enabled) {
    throw new AppError(
      409,
      "Two-step sign-in is already set up for this account. Enter your password again, then the code from your authenticator app.",
      { reason: "challenge_used" }
    );
  }
};

// A code typed at sign-in takes a place in the same five-tries count as the
// password did (the remembered device's own count when the password came from
// one), before it is compared.
const reserveCodeTry = async (user, device, history) => {
  const slot = device
    ? await userRepository.reserveDeviceAttempt(device.id, config.accountLock)
    : await userRepository.reserveLoginAttempt(user.id, config.accountLock);

  if (!slot.allowed) {
    await userRepository.recordSignIn({ ...history, outcome: "locked", twoFactor: "failed" });
    const zone = await zoneOf(user.restaurant_id);
    throw codeLocked(slot.lockedUntil, zone, { device: Boolean(device), byCodes: false });
  }

  return slot;
};

// A wrong code: counted, written to the history, and the try that used the
// last place locks the account (or the device) as a wrong password does.
const refuseCode = async (user, device, slot, history, message) => {
  const miss = device
    ? await userRepository.recordDeviceMiss(device.id, slot.place, config.accountLock)
    : await userRepository.recordLoginMiss(user.id, slot.place, config.accountLock);

  await userRepository.recordSignIn({ ...history, outcome: "wrong_code", twoFactor: "failed" });

  if (miss.justLocked) {
    logFor({ restaurantId: user.restaurant_id, userId: user.id, userName: user.name }, "lock", "user", {
      id: user.id,
      label: user.name,
      details: { reason: `${config.accountLock.attempts} wrong two-step codes`, lockedUntil: miss.lockedUntil },
    });

    const zone = await zoneOf(user.restaurant_id);
    throw codeLocked(miss.lockedUntil, zone, { device: Boolean(device) });
  }

  throw new AppError(400, message, { reason: "wrong_code", attemptsLeft: miss.attemptsLeft });
};

const codeHistory = (user, device, method, meta) => ({
  restaurantId: user.restaurant_id,
  userId: user.id,
  method,
  identifier: null,
  ip: meta.ip,
  userAgent: meta.userAgent,
  trustedDevice: Boolean(device),
});

// The second step: a six-digit code, or a recovery code. `trustDevice` skips
// the code on this browser for 30 days.
const completeTwoFactor = async ({ challengeToken, code, recoveryCode, trustDevice }, meta = {}) => {
  const { challenge, user, device } = await challengeTarget(challengeToken, "code");
  const method = recoveryCode ? "recovery_code" : "two_factor";
  const history = codeHistory(user, device, method, meta);
  const slot = await reserveCodeTry(user, device, history);
  const result = await twoFactorService.checkAny(user.id, { code, recoveryCode });

  if (!result.ok) {
    await refuseCode(
      user,
      device,
      slot,
      history,
      recoveryCode
        ? "That recovery code is not right, or it has been used already. Each code works once."
        : twoFactorService.refusalOf(result)
    );
  }

  await spendChallenge(challenge);

  const session = await completeSignIn(
    { user, device },
    { ...history, twoFactor: method === "recovery_code" ? "recovery_code" : "passed" },
    meta,
    { passed: true, trustDays: trustDevice ? twoFactorService.TRUST_DAYS : 0 }
  );

  const state = await twoFactorService.stateOf(user.id);

  return {
    ...session,
    ...(method === "recovery_code" ? { recoveryCodesLeft: state.recoveryCodesLeft } : {}),
  };
};

// Someone whose role needs two-step, and who has not set it up, does it right
// after the password: a new secret for their phone ...
const beginLoginSetup = async ({ challengeToken }) => {
  const { user } = await challengeTarget(challengeToken, "setup");
  await assertSetupStillOpen(user);
  return twoFactorService.beginSetup(user);
};

// ... then the first code from the app switches it on and signs them in. The
// ten recovery codes come back once, with the session.
const finishLoginSetup = async ({ challengeToken, code, trustDevice }, meta = {}) => {
  const { challenge, user, device } = await challengeTarget(challengeToken, "setup");
  await assertSetupStillOpen(user);
  const history = codeHistory(user, device, "two_factor", meta);
  const slot = await reserveCodeTry(user, device, history);
  const result = await twoFactorService.confirmSetup(user, code);

  if (!result.ok) {
    await refuseCode(
      user,
      device,
      slot,
      history,
      "That code is not right. Type the 6 digits your authenticator app shows for this account now."
    );
  }

  await spendChallenge(challenge);

  const session = await completeSignIn(
    { user, device },
    { ...history, twoFactor: "set_up" },
    meta,
    { passed: true, trustDays: trustDevice ? twoFactorService.TRUST_DAYS : 0 }
  );

  logFor({ restaurantId: user.restaurant_id, userId: user.id, userName: user.name }, "enable", "two_factor", {
    id: user.id,
    label: user.name,
    details: { during: "sign-in", requiredByRole: true },
  });

  return { ...session, recoveryCodes: result.recoveryCodes };
};

// Called on every protected request: the token only proves who the user is,
// while status, roles and permissions are always read fresh from the database.
// A token from before the last password change is refused.
const getUserFromToken = async (token) => {
  let payload;

  try {
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ["HS256"] });
  } catch {
    throw new AppError(401, "Your session has ended. Please sign in again.");
  }

  const user = await userRepository.findProfileById(payload.sub);

  if (!user) {
    throw new AppError(401, "Your session has ended. Please sign in again.");
  }

  // A switched-off account says so, rather than blaming the password.
  assertUserCanAccess(user, 401);

  // Tokens issued before versions existed carry none and count as version 0.
  if (Number(payload.tv || 0) !== Number(user.token_version || 0)) {
    throw new AppError(401, "You were signed out because the password changed or all sessions were ended. Please sign in again.", {
      reason: "session_revoked",
    });
  }

  return toProfile(user);
};

// Sliding session: while someone is working the screen swaps its token for a
// fresh one, so nobody is signed out in the middle of dinner service. A
// revoked or expired token cannot be refreshed (authenticate refuses it first).
const refresh = async (user) => {
  const current = await userRepository.findCredentialsById(user.id);
  const token = issueToken({ id: user.id, restaurantId: user.restaurantId }, current.token_version);

  return { token, expiresAt: sessionOf(token) };
};

// "Sign out everywhere else": every other device's session ends on its next
// request, and every other remembered device is forgotten; this one gets a
// fresh token, stays remembered and carries on.
const signOutOtherSessions = async (user, deviceTokens = []) => {
  const version = await userRepository.bumpTokenVersion(user.id);
  await userRepository.restampDevice(user.id, deviceHashes(deviceTokens));
  // "Trust this device for 30 days" ends everywhere, this device included.
  await twoFactorRepository.endDeviceTrust(user.id);
  const token = issueToken({ id: user.id, restaurantId: user.restaurantId }, version);

  return { token, expiresAt: sessionOf(token) };
};

// Checks the signed-in person's own password: changing it, setting or
// removing their PIN, unlocking a till without a PIN. Each try counts towards
// the same five-in-fifteen-minutes lockout as signing in, and is counted
// before the compare, like sign-in.
const verifyOwnPassword = async (user, password, wrongMessage) => {
  const credentials = await userRepository.findCredentialsById(user.id);

  if (!credentials) {
    throw new AppError(401, "Your session has ended. Please sign in again.");
  }

  const slot = await userRepository.reserveLoginAttempt(user.id, config.accountLock);

  if (!slot.allowed) {
    throw accountLocked(slot.lockedUntil, await zoneOf(user.restaurantId));
  }

  if (!(await bcrypt.compare(String(password || ""), credentials.password_hash))) {
    const miss = await userRepository.recordLoginMiss(user.id, slot.place, config.accountLock);

    if (miss.justLocked) {
      logFor({ restaurantId: user.restaurantId, userId: user.id, userName: user.name }, "lock", "user", {
        id: user.id,
        label: user.name,
        details: { reason: `${config.accountLock.attempts} wrong passwords`, lockedUntil: miss.lockedUntil },
      });

      throw accountLocked(miss.lockedUntil, await zoneOf(user.restaurantId), "passwords");
    }

    throw new AppError(400, wrongMessage, { reason: "wrong_password", attemptsLeft: miss.attemptsLeft });
  }

  await userRepository.recordLoginHit(user.id);
  return credentials;
};

// Changing your own password always proves you know the current one, even
// though you are already logged in: a borrowed, unlocked screen should not be
// enough to lock the real owner out. Every other session ends; this device
// gets a fresh session so the person who changed it is not signed out too.
//
// It is also how someone whose password was set by someone else (a new
// login, a reset) chooses their own at their next sign-in, and the only
// change that clears the must-change mark. The new password must differ from
// the one it replaces, compared with the stored hash as well as the typed
// text, since bcrypt reads only a password's first 72 bytes.
const changeOwnPassword = async (user, currentPassword, newPassword, deviceTokens = []) => {
  const given = user.passwordChangeRequired;
  const credentials = await verifyOwnPassword(
    user,
    currentPassword,
    given ? "The password you were given is not right" : "Your current password is not right"
  );

  if (currentPassword === newPassword || (await bcrypt.compare(newPassword, credentials.password_hash))) {
    throw new AppError(
      400,
      given ? "Choose a password of your own, not the one you were given" : "The new password must be different from the current one"
    );
  }

  const updated = await userRepository.updateOwnPassword(
    user.id,
    credentials.password_hash,
    await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  );

  // Changed by another request since it was checked (a second tap, a reset).
  if (!updated) {
    throw new AppError(409, "Your password was changed a moment ago, so this one was not saved. Sign in again.", {
      reason: "password_changed",
    });
  }

  // Other devices are forgotten with the version bump; this one stays, but
  // its 30-day two-step trust ends like everyone else's.
  await userRepository.restampDevice(user.id, deviceHashes(deviceTokens));
  await twoFactorRepository.endDeviceTrust(user.id);
  const token = issueToken({ id: user.id, restaurantId: user.restaurantId }, updated.token_version);

  return { token, expiresAt: sessionOf(token), user: toProfile(await userRepository.findProfileById(user.id)) };
};

const updateOwnProfile = async (userId, data, restaurantId = null) => {
  let mobile = data.mobile;

  if (mobile) {
    const digits = mobileDigits(mobile);

    if (!digits) {
      throw new AppError(400, "Enter the mobile as a 10-digit number");
    }

    const clash = await userRepository.findMobileClash(digits, userId, restaurantId);

    if (clash) {
      throw new AppError(409, "Another login already uses this mobile number");
    }

    mobile = digits;
  }

  const current = await userRepository.findProfileById(userId);

  // A login with no email signs in by mobile, so the mobile cannot be removed.
  if (!mobile && current && !current.email) {
    throw new AppError(400, "You sign in with your mobile number, so it cannot be left empty");
  }

  await userRepository.updateOwnProfile(userId, { ...data, mobile });

  return toProfile(await userRepository.findProfileById(userId));
};

// --- Personal PIN ----------------------------------------------------------

// The rules every personal PIN follows, whoever sets it.
const assertGoodPin = (pin, mobile) => {
  if (typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
    throw new AppError(400, "The PIN must be 4 to 6 digits");
  }

  if (isWeakPin(pin)) {
    throw new AppError(
      400,
      "That PIN is too easy to guess. Avoid runs like 1234 and repeats like 1111 — pick digits that mean nothing to anyone else."
    );
  }

  const digits = String(mobile || "").replace(/\D/g, "");

  if (digits.length >= pin.length && digits.endsWith(pin)) {
    throw new AppError(400, "That PIN is the end of the mobile number, which colleagues know. Pick different digits.");
  }
};

const hashPin = (pin) => bcrypt.hash(pin, PIN_ROUNDS);

// Setting your own PIN needs your password: a PIN approves voids and opens a
// shared till, so someone at an unlocked screen must not be able to set one.
const setOwnPin = async (user, password, pin) => {
  assertGoodPin(pin, user.mobile);
  await verifyOwnPassword(user, password, "Your password is not right");

  await userRepository.setPin(user.id, await hashPin(pin), user.id);

  return toProfile(await userRepository.findProfileById(user.id));
};

// Removing it needs the password too: someone at an unlocked screen must not
// be able to take a manager's PIN away (and with it their approvals).
const clearOwnPin = async (user, password) => {
  await verifyOwnPassword(user, password, "Your password is not right");
  await userRepository.clearPin(user.id, user.id);
  return toProfile(await userRepository.findProfileById(user.id));
};

const pinLocked = (name, until, zone) =>
  until
    ? new AppError(
        423,
        `${name}'s PIN is locked after too many wrong tries. Try again after ${lockedUntilText(
          until,
          zone
        )}, or ask an admin to unlock it under Users.`,
        { reason: "pin_locked", lockedUntil: new Date(until).toISOString() }
      )
    : new AppError(429, `Too many PIN tries for ${name} at once. Wait a minute and try again.`, {
        reason: "too_many_attempts",
      });

// Checks a person's PIN. The try is counted before the compare, so however
// many arrive together, at most five are ever checked before the PIN locks.
const checkPin = async (row, pin) => {
  if (!row.pin_hash) {
    throw new AppError(409, `${row.name} has not set a PIN yet. They can set one under My profile.`, {
      reason: "no_pin",
    });
  }

  const slot = await userRepository.reservePinAttempt(row.id, config.accountLock);

  if (!slot.allowed) {
    throw pinLocked(row.name, slot.lockedUntil, await zoneOf(row.restaurant_id));
  }

  if (typeof pin !== "string" || !(await bcrypt.compare(pin, row.pin_hash))) {
    const miss = await userRepository.recordPinMiss(row.id, slot.place, config.accountLock);

    if (miss.justLocked) {
      logFor({ restaurantId: row.restaurant_id, userId: row.id, userName: row.name }, "lock", "user_pin", {
        id: row.id,
        label: row.name,
        details: { reason: `${config.accountLock.attempts} wrong PINs at a till`, lockedUntil: miss.lockedUntil },
      });

      throw pinLocked(row.name, miss.lockedUntil, await zoneOf(row.restaurant_id));
    }

    throw new AppError(
      400,
      `That PIN is not right. ${miss.attemptsLeft} tr${miss.attemptsLeft === 1 ? "y" : "ies"} left.`,
      { reason: "wrong_pin", attemptsLeft: miss.attemptsLeft }
    );
  }

  await userRepository.recordPinHit(row.id);
};

// Quick switch on a shared till: someone taps their name and types their PIN,
// and the till carries on as them. Only works from a till that is already
// signed in to the same restaurant — a PIN alone never gets anyone in from
// outside.
const pinLogin = async (currentUser, { userId, pin, deviceTokens }, meta = {}) => {
  if (!currentUser.restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  const row = await userRepository.findPinById(userId);

  // Another restaurant's user behaves exactly like one that does not exist.
  if (!row || Number(row.restaurant_id) !== Number(currentUser.restaurantId)) {
    throw new AppError(404, "That person is not set up on this till");
  }

  return switchToRow(currentUser, row, { pin, deviceTokens }, meta);
};

// The PIN switch itself, once the caller has decided this person may take
// over this till (the restaurant's own staff above; a business's members at
// its counter, modules/business/core/services/businessCounter.service.js).
// Every rule is the same either way: account lock, two-step device, the PIN's
// own five-try lock, and the sign-in history.
const switchToRow = async (currentUser, row, { pin, deviceTokens }, meta = {}) => {
  const history = {
    restaurantId: row.restaurant_id,
    userId: row.id,
    method: "pin",
    identifier: `Till of ${currentUser.name}`,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };

  try {
    assertUserCanAccess(row);

    // An account locked after wrong passwords is locked however the person
    // tries to come in, switching to it on a till with the PIN included —
    // unless this till is a device they have signed in on with their password
    // before: someone guessing their password elsewhere must not stop them
    // taking over their own till (the PIN has its own five-try lock).
    if (
      isFuture(row.login_locked_until) &&
      !(await userRepository.findTrustedDevice(row.id, deviceHashes(deviceTokens)))
    ) {
      throw new AppError(
        423,
        `${row.name}'s account is locked after too many wrong passwords until ${lockedUntilText(
          row.login_locked_until,
          await zoneOf(row.restaurant_id)
        )}. An admin can unlock it under Users, or ${row.name} can sign in with the password on a device they have used before.`,
        { reason: "account_locked", lockedUntil: new Date(row.login_locked_until).toISOString() }
      );
    }

    // Someone with two-step on (or whose role needs it) can be switched to
    // by PIN only on a device where they have passed two-step before: a PIN
    // is four digits a colleague may have seen, and must not get round the
    // code.
    const twoStep = await twoFactorService.stateOf(row.id);

    if (
      (twoStep.enabled || twoStep.required) &&
      !(twoStep.enabled && (await twoFactorRepository.findPassedDevice(row.id, deviceHashes(deviceTokens))))
    ) {
      throw new AppError(
        403,
        twoStep.enabled
          ? `${row.name} uses two-step sign-in and has not passed it on this till yet. They sign in here once with their password and code; after that their PIN works on this till.`
          : `${row.name}'s role needs two-step sign-in, which they have not set up yet. They sign in once with their password to set it up.`,
        { reason: "two_factor_device" }
      );
    }

    await checkPin(row, pin);
  } catch (error) {
    const reason = error.details && error.details.reason;
    await userRepository.recordSignIn({
      ...history,
      outcome: ["pin_locked", "account_locked", "too_many_attempts"].includes(reason)
        ? "locked"
        : reason === "wrong_pin"
          ? "wrong_pin"
          : reason === "two_factor_device"
            ? "two_factor_device"
            : "inactive",
    });
    throw error;
  }

  await userRepository.updateLastLogin(row.id);
  await userRepository.recordSignIn({ ...history, outcome: "success" });

  const full = await userRepository.findProfileById(row.id);
  const token = issueToken(full);

  return { token, expiresAt: sessionOf(token), user: toProfile(full) };
};

// Unlocking your own locked till: your PIN, or your password if you have no
// PIN yet. Nothing about the session changes; the screen simply opens again.
const unlock = async (user, { pin, password }, meta = {}) => {
  const history = {
    restaurantId: user.restaurantId,
    userId: user.id,
    method: "unlock",
    identifier: null,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };

  if (pin) {
    const row = await userRepository.findPinById(user.id);

    try {
      await checkPin(row, pin);
    } catch (error) {
      const reason = error.details && error.details.reason;
      await userRepository.recordSignIn({
        ...history,
        outcome: ["pin_locked", "too_many_attempts"].includes(reason) ? "locked" : "wrong_pin",
      });
      throw error;
    }
  } else {
    try {
      await verifyOwnPassword(user, password, "That password is not right");
    } catch (error) {
      const reason = error.details && error.details.reason;
      await userRepository.recordSignIn({
        ...history,
        outcome: reason === "wrong_password" ? "wrong_password" : "locked",
      });
      throw error;
    }
  }

  await userRepository.recordSignIn({ ...history, outcome: "success" });

  return { unlocked: true };
};

// Who can take over this till: everyone active in the restaurant with a PIN.
const tillUsers = async (user) => {
  if (!user.restaurantId) {
    return [];
  }

  const rows = await userRepository.findTillUsers(user.restaurantId);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    roleNames: row.role_names,
    outletId: row.outlet_id,
    locked: isFuture(row.pin_locked_until),
  }));
};

const mySignIns = async (user) => {
  const rows = await userRepository.findSignIns(user.id, 20);
  return rows.map((row) => ({
    id: row.id,
    method: row.method,
    outcome: row.outcome,
    identifier: row.identifier,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    trustedDevice: Boolean(row.trusted_device),
    twoFactor: row.two_factor || null,
    createdAt: row.created_at,
  }));
};

// --- Two-step sign-in on My profile -----------------------------------------------

const twoFactorStatus = async (user) => {
  const state = await twoFactorService.stateOf(user.id);

  return {
    enabled: state.enabled,
    enabledAt: state.enabledAt,
    required: state.required,
    recoveryCodesLeft: state.recoveryCodesLeft,
    trustedDevices: state.enabled ? await twoFactorRepository.countTrustedDevices(user.id) : 0,
    trustDays: twoFactorService.TRUST_DAYS,
  };
};

// Starting needs the password: someone at an unlocked screen must not be
// able to tie the owner's account to their own phone.
const startTwoFactorSetup = async (user, password) => {
  await verifyOwnPassword(user, password, "Your password is not right");

  if (user.twoFactorEnabled) {
    throw new AppError(
      409,
      "Two-step sign-in is already on. To move it to a new phone, turn it off (password and a current code) and set it up again.",
      { reason: "already_enabled" }
    );
  }

  return twoFactorService.beginSetup({ ...user, restaurant_id: user.restaurantId });
};

// The first code from the app switches it on; this device counts as one
// where two-step was passed.
const enableTwoFactor = async (user, code, deviceTokens = []) => {
  if (user.twoFactorEnabled) {
    throw new AppError(
      409,
      "Two-step sign-in is already on. To move it to a new phone, turn it off (password and a current code) and set it up again.",
      { reason: "already_enabled" }
    );
  }

  const result = await twoFactorService.confirmSetup(user, code);

  if (!result.ok) {
    throw new AppError(400, "That code is not right. Type the 6 digits the app shows for this account now.", {
      reason: "wrong_code",
    });
  }

  const device = await userRepository.findTrustedDevice(user.id, deviceHashes(deviceTokens));

  if (device) {
    await twoFactorRepository.markDevicePassed(device.id, user.id, 0);
  }

  return { recoveryCodes: result.recoveryCodes };
};

// A code or recovery code typed while signed in (turning two-step off):
// counted like a wrong password, before it is compared.
const verifyOwnCode = async (user, { code, recoveryCode }) => {
  const slot = await userRepository.reserveLoginAttempt(user.id, config.accountLock);

  if (!slot.allowed) {
    throw accountLocked(slot.lockedUntil, await zoneOf(user.restaurantId));
  }

  const result = await twoFactorService.checkAny(user.id, { code, recoveryCode });

  if (!result.ok) {
    const miss = await userRepository.recordLoginMiss(user.id, slot.place, config.accountLock);

    if (miss.justLocked) {
      throw accountLocked(miss.lockedUntil, await zoneOf(user.restaurantId), "codes");
    }

    throw new AppError(
      400,
      recoveryCode ? "That recovery code is not right, or it has been used already." : twoFactorService.refusalOf(result),
      { reason: "wrong_code", attemptsLeft: miss.attemptsLeft }
    );
  }

  await userRepository.recordLoginHit(user.id);
};

// Turning it off needs the password and a current code (or a recovery code,
// for a phone that is lost).
const disableTwoFactor = async (user, { password, code, recoveryCode }) => {
  if (!user.twoFactorEnabled) {
    throw new AppError(409, "Two-step sign-in is already off");
  }

  await verifyOwnPassword(user, password, "Your password is not right");
  await verifyOwnCode(user, { code, recoveryCode });
  await twoFactorRepository.disable(user.id);

  return twoFactorStatus(user);
};

const newRecoveryCodes = async (user, password) => {
  if (!user.twoFactorEnabled) {
    throw new AppError(409, "Turn on two-step sign-in first");
  }

  await verifyOwnPassword(user, password, "Your password is not right");
  return { recoveryCodes: await twoFactorService.newRecoveryCodes(user) };
};

module.exports = {
  BCRYPT_ROUNDS,
  mobileDigits,
  assertGoodPin,
  hashPin,
  login,
  getUserFromToken,
  refresh,
  signOutOtherSessions,
  changeOwnPassword,
  updateOwnProfile,
  setOwnPin,
  clearOwnPin,
  pinLogin,
  switchToRow,
  checkPin,
  unlock,
  tillUsers,
  mySignIns,
  completeTwoFactor,
  beginLoginSetup,
  finishLoginSetup,
  twoFactorStatus,
  startTwoFactorSetup,
  enableTwoFactor,
  disableTwoFactor,
  newRecoveryCodes,
};
