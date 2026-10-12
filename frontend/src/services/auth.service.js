import api from "./api";

const RESTAURANT_CODE_KEY = "rmp_restaurant_code";

// The restaurant code this device last signed in to, so staff signing in with
// their employee code do not have to type it every time.
export const rememberedRestaurantCode = () => {
  try {
    return localStorage.getItem(RESTAURANT_CODE_KEY) || "";
  } catch {
    return "";
  }
};

export const rememberRestaurantCode = (code) => {
  try {
    if (code) {
      localStorage.setItem(RESTAURANT_CODE_KEY, code);
    }
  } catch {
    // Nothing to remember it in.
  }
};

// --- Remembered device -------------------------------------------------------
//
// After a good password the server gives this browser a device token for that
// person. Shown again at sign-in, it lets the person in even while their
// account is locked by someone else guessing their password elsewhere (the
// device keeps its own count of wrong passwords). A shared till holds one per
// person who has signed in on it, so all of them are sent: the server only
// uses the one that belongs to the account being signed in to.
const DEVICES_KEY = "rmp_devices";
const MAX_DEVICES = 20;

const readDevices = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEVICES_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const deviceTokens = () => Object.values(readDevices()).filter((token) => typeof token === "string");

const rememberDevice = (userId, token) => {
  if (!userId || !token) {
    return;
  }

  try {
    const devices = readDevices();
    delete devices[userId];
    // Newest last; the oldest are dropped past MAX_DEVICES.
    const entries = [...Object.entries(devices), [String(userId), token]].slice(-MAX_DEVICES);
    localStorage.setItem(DEVICES_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Nothing to remember it in: this browser simply is not remembered.
  }
};

// Sign in with an email, a mobile number, or a staff code (with the
// restaurant's code beside it).
export const loginRequest = async (identifier, password, restaurantCode) => {
  const response = await api.post("/auth/login", {
    identifier,
    password,
    ...(restaurantCode ? { restaurantCode } : {}),
    deviceTokens: deviceTokens(),
  });
  const data = response.data.data;

  rememberDevice(data.user && data.user.id, data.deviceToken);
  return data;
};

export const getCurrentUser = async () => {
  const response = await api.get("/auth/me");
  return response.data.data;
};

export const updateProfile = async (payload) =>
  (await api.put("/auth/me", payload)).data.data;

// Returns { token } for this device: every other session has ended.
// This browser stays remembered; every other device is forgotten.
export const changePassword = async (currentPassword, newPassword) =>
  (await api.post("/auth/change-password", { currentPassword, newPassword, deviceTokens: deviceTokens() })).data;

export const signOutOtherDevices = async () =>
  (await api.post("/auth/sign-out-others", { deviceTokens: deviceTokens() })).data;

export const getMySignIns = async () => (await api.get("/auth/me/sign-ins")).data.data;

// Personal PIN: approvals and the shared till.
export const setMyPin = async (password, pin, confirmPin) =>
  (await api.put("/auth/me/pin", { password, pin, confirmPin })).data;
// Removing your PIN needs your password, as setting one does.
export const clearMyPin = async (password) => (await api.delete("/auth/me/pin", { data: { password } })).data;

// The shared till
export const listTillUsers = async () => (await api.get("/auth/till-users")).data.data;
export const pinLogin = async (userId, pin) =>
  (await api.post("/auth/pin-login", { userId, pin, deviceTokens: deviceTokens() })).data.data;
export const unlockTill = async (payload) => (await api.post("/auth/unlock", payload)).data.data;

// Manager approval
// With a scope ({ billId, amount }), the answer also carries the server's own
// words and figures for the prompt: the ones the approval is tied to.
export const listApprovers = async (permission, scope = null) =>
  (
    await api.get("/auth/approvers", {
      params: { permission, scope: scope ? JSON.stringify(scope) : undefined },
    })
  ).data.data;
export const requestApprovalToken = async (payload) =>
  (await api.post("/auth/approvals", payload)).data.data;

// --- Two-step sign-in ---------------------------------------------------------
//
// With two-step on, /auth/login answers { twoFactor: { step, challengeToken } }
// instead of a session. The code (or a recovery code) then completes it.
export const completeTwoFactorLogin = async ({ challengeToken, code, recoveryCode, trustDevice }) => {
  const response = await api.post("/auth/login/two-factor", {
    challengeToken,
    ...(recoveryCode ? { recoveryCode } : { code }),
    trustDevice: Boolean(trustDevice),
    deviceTokens: deviceTokens(),
  });
  const data = response.data.data;

  rememberDevice(data.user && data.user.id, data.deviceToken);
  return data;
};

// A role that needs two-step, not yet set up: straight after the password.
export const beginLoginTwoFactorSetup = async (challengeToken) =>
  (await api.post("/auth/login/two-factor/setup", { challengeToken })).data.data;

export const finishLoginTwoFactorSetup = async ({ challengeToken, code, trustDevice }) => {
  const response = await api.post("/auth/login/two-factor/enable", {
    challengeToken,
    code,
    trustDevice: Boolean(trustDevice),
    deviceTokens: deviceTokens(),
  });
  const data = response.data.data;

  rememberDevice(data.user && data.user.id, data.deviceToken);
  return data;
};

// My profile: on, off, recovery codes.
export const getTwoFactorStatus = async () => (await api.get("/auth/two-factor")).data.data;
export const startTwoFactorSetup = async (password) =>
  (await api.post("/auth/two-factor/setup", { password })).data.data;
export const enableTwoFactor = async (code) =>
  (await api.post("/auth/two-factor/enable", { code, deviceTokens: deviceTokens() })).data;
export const disableTwoFactor = async ({ password, code, recoveryCode }) =>
  (await api.post("/auth/two-factor/disable", { password, ...(recoveryCode ? { recoveryCode } : { code }) })).data;
export const makeNewRecoveryCodes = async (password) =>
  (await api.post("/auth/two-factor/recovery-codes", { password })).data;

// --- My work: your own shifts, attendance, leave and payslips ------------------
export const getMyWork = async () => (await api.get("/auth/me/work")).data.data;
export const getMyPayslip = async (id) => (await api.get(`/auth/me/payslips/${id}`)).data.data;
