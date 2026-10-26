const authService = require("../services/auth.service");
const approvalService = require("../services/approval.service");
const myWorkService = require("../../restaurant/staff/services/myWork.service");
const AppError = require("../../../utils/AppError");
const v = require("../../../utils/validate");
const { logAction, logFor } = require("../../../utils/audit");

const clientIp = require("../../../utils/clientIp");

const metaOf = (req) => ({ ip: clientIp(req), userAgent: req.get("user-agent") || null });

const PIN_PATTERN = /^\d{4,6}$/;

// A PIN arrives as text so a leading zero survives ("0472" is not 472).
const readPin = (value, field = "PIN") => {
  if (value === undefined || value === null || value === "") {
    throw new AppError(400, `Enter the ${field}`);
  }

  if (typeof value !== "string" || !PIN_PATTERN.test(value)) {
    throw new AppError(400, `The ${field} must be 4 to 6 digits`);
  }

  return value;
};

// Staff sign in with whatever they have: an email, a mobile number, or their
// employee code with the restaurant's code. `email` is still accepted, so
// older screens and scripts keep working.
const login = async (req, res) => {
  const body = req.body || {};
  const identifier = typeof body.identifier === "string" ? body.identifier : body.email;
  const { password } = body;

  if (typeof identifier !== "string" || typeof password !== "string" || !identifier.trim() || !password) {
    throw new AppError(400, "Enter your email, mobile or staff code, and your password");
  }

  // bcrypt only uses the first 72 bytes; longer input is almost certainly not a real password.
  if (identifier.length > 150 || password.length > 72) {
    throw new AppError(401, "That sign-in is not right. Check the email, mobile or staff code and the password.");
  }

  const result = await authService.login(
    {
      identifier: identifier.trim(),
      password,
      restaurantCode: v.optionalString(body.restaurantCode, "Restaurant code", 30),
      // This browser's remembered-device tokens (see auth.service).
      deviceTokens: body.deviceTokens,
    },
    metaOf(req)
  );

  // With two-step sign-in on, the right password gives no session yet: the
  // answer says which step comes next (the code, or setting it up).
  res.json({
    success: true,
    message: result.twoFactor ? result.twoFactor.message : "Login successful",
    data: result,
  });
};

// --- Two-step sign-in ---------------------------------------------------------

const CODE_PATTERN = /^\d{6}$/;

// "123 456" and "123-456" are typed as often as "123456".
const readCode = (value, { required = true } = {}) => {
  const text = typeof value === "string" || typeof value === "number" ? String(value).replace(/[\s-]/g, "") : "";

  if (!text) {
    if (required) {
      throw new AppError(400, "Enter the 6-digit code from your authenticator app");
    }

    return null;
  }

  if (!CODE_PATTERN.test(text)) {
    throw new AppError(400, "The code is the 6 digits your authenticator app shows");
  }

  return text;
};

const readRecoveryCode = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || value.length > 20) {
    throw new AppError(400, "A recovery code looks like ABCDE-FGHJK");
  }

  return value;
};

const readChallengeToken = (value) => {
  if (typeof value !== "string" || !value || value.length > 2000) {
    throw new AppError(401, "That sign-in took too long. Enter your password again.", { reason: "challenge_expired" });
  }

  return value;
};

// The code (or a recovery code) after the password.
const loginTwoFactor = async (req, res) => {
  const body = req.body || {};
  const recoveryCode = readRecoveryCode(body.recoveryCode);
  const result = await authService.completeTwoFactor(
    {
      challengeToken: readChallengeToken(body.challengeToken),
      code: recoveryCode ? null : readCode(body.code),
      recoveryCode,
      trustDevice: body.trustDevice === true,
    },
    metaOf(req)
  );

  if (recoveryCode) {
    // A recovery code is what a lost or broken phone looks like: worth a line
    // the owner can find later.
    logFor(
      { restaurantId: result.user.restaurantId, userId: result.user.id, userName: result.user.name },
      "use_recovery_code",
      "two_factor",
      { id: result.user.id, label: result.user.name, details: { codesLeft: result.recoveryCodesLeft } }
    );
  }

  res.json({ success: true, message: "Login successful", data: result });
};

// Setting two-step up straight after the password, when the role needs it.
const loginTwoFactorSetup = async (req, res) => {
  const body = req.body || {};

  res.json({
    success: true,
    data: await authService.beginLoginSetup({ challengeToken: readChallengeToken(body.challengeToken) }),
  });
};

const loginTwoFactorEnable = async (req, res) => {
  const body = req.body || {};
  const result = await authService.finishLoginSetup(
    {
      challengeToken: readChallengeToken(body.challengeToken),
      code: readCode(body.code),
      trustDevice: body.trustDevice === true,
    },
    metaOf(req)
  );

  res.json({
    success: true,
    message: "Two-step sign-in is on. Keep your recovery codes somewhere safe.",
    data: result,
  });
};

const twoFactorStatus = async (req, res) => {
  res.json({ success: true, data: await authService.twoFactorStatus(req.user) });
};

const readOwnPassword = (body, words = "Enter your password") => {
  if (typeof body.password !== "string" || !body.password) {
    throw new AppError(400, words);
  }

  return body.password;
};

// Shows the QR code and the key to type, once. Needs the password.
const startTwoFactor = async (req, res) => {
  const body = req.body || {};

  res.json({
    success: true,
    data: await authService.startTwoFactorSetup(req.user, readOwnPassword(body, "Enter your password to set up two-step sign-in")),
  });
};

const enableTwoFactor = async (req, res) => {
  const body = req.body || {};
  const result = await authService.enableTwoFactor(req.user, readCode(body.code), body.deviceTokens);

  logAction(req, "enable", "two_factor", { id: req.user.id, label: req.user.name });

  res.json({
    success: true,
    message: "Two-step sign-in is on. Save your recovery codes now: they are shown only once.",
    data: result,
  });
};

const disableTwoFactor = async (req, res) => {
  const body = req.body || {};
  const recoveryCode = readRecoveryCode(body.recoveryCode);
  const status = await authService.disableTwoFactor(req.user, {
    password: readOwnPassword(body, "Enter your password to turn two-step sign-in off"),
    code: recoveryCode ? null : readCode(body.code),
    recoveryCode,
  });

  logAction(req, "disable", "two_factor", {
    id: req.user.id,
    label: req.user.name,
    details: { with: recoveryCode ? "recovery code" : "authenticator code" },
  });

  res.json({ success: true, message: "Two-step sign-in is off", data: status });
};

const newRecoveryCodes = async (req, res) => {
  const body = req.body || {};
  const result = await authService.newRecoveryCodes(req.user, readOwnPassword(body, "Enter your password to make new recovery codes"));

  logAction(req, "renew_codes", "two_factor", { id: req.user.id, label: req.user.name });

  res.json({
    success: true,
    message: "New recovery codes made. The old ones no longer work.",
    data: result,
  });
};

const me = (req, res) => {
  res.json({
    success: true,
    data: req.user,
  });
};

// Anyone can change their own name and mobile; email stays fixed because it is
// the login, and roles are a manager's business.
const updateMe = async (req, res) => {
  const body = req.body || {};

  const profile = await authService.updateOwnProfile(
    req.user.id,
    {
      name: v.requiredString(body.name, "Name", 150),
      mobile: v.optionalString(body.mobile, "Mobile", 20),
    },
    req.user.restaurantId
  );

  logAction(req, "update", "profile", { id: req.user.id });

  res.json({ success: true, message: "Profile saved", data: profile });
};

const changePassword = async (req, res) => {
  const body = req.body || {};
  const currentPassword = body.currentPassword;

  if (typeof currentPassword !== "string" || !currentPassword) {
    throw new AppError(400, "Enter your current password");
  }

  const newPassword = v.requiredPassword(body.newPassword, "New password");
  // A password someone else set, replaced by the person's own at sign-in.
  const given = req.user.passwordChangeRequired;

  const session = await authService.changeOwnPassword(req.user, currentPassword, newPassword, body.deviceTokens);

  // The password itself is never written to the log, only that it changed.
  logAction(req, "password_change", "user", {
    id: req.user.id,
    label: req.user.name,
    details: { otherSessionsEnded: true, ...(given ? { replacedGivenPassword: true } : {}) },
  });

  res.json({
    success: true,
    message: given
      ? "Your own password is set. Sign in with it from now on."
      : "Password changed. You were signed out on every other device, and they are no longer remembered.",
    data: session,
  });
};

// The screen swaps its token for a fresh one while someone is working.
const refresh = async (req, res) => {
  res.json({ success: true, data: await authService.refresh(req.user) });
};

const signOutOthers = async (req, res) => {
  const session = await authService.signOutOtherSessions(req.user, (req.body || {}).deviceTokens);

  logAction(req, "sign_out_everywhere", "user", { id: req.user.id, label: req.user.name });

  res.json({ success: true, message: "Signed out on every other device", data: session });
};

const mySignIns = async (req, res) => {
  res.json({ success: true, data: await authService.mySignIns(req.user) });
};

const setMyPin = async (req, res) => {
  const body = req.body || {};
  const pin = readPin(body.pin);

  if (body.confirmPin !== undefined && body.confirmPin !== pin) {
    throw new AppError(400, "The two PINs do not match");
  }

  const hadPin = req.user.hasPin;
  const profile = await authService.setOwnPin(req.user, body.password, pin);

  logAction(req, hadPin ? "reset" : "create", "user_pin", { id: req.user.id, label: req.user.name });

  res.json({ success: true, message: hadPin ? "PIN changed" : "PIN set", data: profile });
};

// Your password is needed to remove your PIN, as it is to set one.
const clearMyPin = async (req, res) => {
  const password = req.body?.password;

  if (typeof password !== "string" || !password) {
    throw new AppError(400, "Enter your password to remove your PIN");
  }

  const profile = await authService.clearOwnPin(req.user, password);

  logAction(req, "delete", "user_pin", { id: req.user.id, label: req.user.name });

  res.json({ success: true, message: "PIN removed", data: profile });
};

const tillUsers = async (req, res) => {
  res.json({ success: true, data: await authService.tillUsers(req.user) });
};

const pinLogin = async (req, res) => {
  const body = req.body || {};
  const result = await authService.pinLogin(
    req.user,
    { userId: v.requiredId(body.userId, "Person"), pin: readPin(body.pin), deviceTokens: body.deviceTokens },
    metaOf(req)
  );

  res.json({ success: true, message: `Signed in as ${result.user.name}`, data: result });
};

const unlock = async (req, res) => {
  const body = req.body || {};
  const input = body.pin !== undefined && body.pin !== null && body.pin !== ""
    ? { pin: readPin(body.pin) }
    : { password: v.requiredString(body.password, "Password", 72) };

  res.json({ success: true, data: await authService.unlock(req.user, input, metaOf(req)) });
};

// What an approval is for, as the screen sends it: an object in a POST body,
// or JSON text in the query string of GET /approvers.
const readScope = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    if (value.length > 500) {
      throw new AppError(400, "What is being approved could not be read. Close the prompt and try again.");
    }

    try {
      return JSON.parse(value);
    } catch {
      throw new AppError(400, "What is being approved could not be read. Close the prompt and try again.");
    }
  }

  return value;
};

const approvers = async (req, res) => {
  const permission = v.requiredString(req.query.permission, "Permission", 100);

  res.json({
    success: true,
    data: await approvalService.listApprovers(req.user, permission, readScope(req.query.scope)),
  });
};

// A manager at the till approves one action for the person signed in.
const approve = async (req, res) => {
  const body = req.body || {};

  const result = await approvalService.approve(
    req.user,
    {
      permission: v.requiredString(body.permission, "Permission", 100),
      pin: readPin(body.pin, "manager's PIN"),
      approverId: v.optionalNumber(body.approverId, "Approver", { min: 1 }),
      method: v.optionalString(body.method, "Method", 10),
      url: v.optionalString(body.url, "Request", 200),
      scope: readScope(body.scope),
      label: v.optionalString(body.label, "What it is for", 200),
      note: v.optionalString(body.note, "Note", 200),
    },
    metaOf(req)
  );

  res.status(201).json({
    success: true,
    message: `Approved by ${result.approver.name}`,
    data: result,
  });
};

// --- My work: your own shifts, attendance, leave and payslips ---

const myWork = async (req, res) => {
  res.json({ success: true, data: await myWorkService.overview(req.user) });
};

const myPayslip = async (req, res) => {
  res.json({ success: true, data: await myWorkService.payslip(req.user, v.requiredId(req.params.id, "Payslip")) });
};

module.exports = {
  myWork,
  myPayslip,
  login,
  loginTwoFactor,
  loginTwoFactorSetup,
  loginTwoFactorEnable,
  twoFactorStatus,
  startTwoFactor,
  enableTwoFactor,
  disableTwoFactor,
  newRecoveryCodes,
  me,
  updateMe,
  changePassword,
  refresh,
  signOutOthers,
  mySignIns,
  setMyPin,
  clearMyPin,
  tillUsers,
  pinLogin,
  unlock,
  approvers,
  approve,
};
