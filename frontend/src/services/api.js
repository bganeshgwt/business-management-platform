import axios from "axios";
import {
  CAPTURE_HEADER,
  currentApprovalLabel,
  hasApprovalHandler,
  isApprovalRequired,
  requestApproval,
} from "./approval";

const TOKEN_KEY = "rmp_token";
const OUTLET_KEY = "rmp_outlet";

// Storage can be blocked (a private window, a locked-down tablet). The app
// still works then; it just forgets the session when the tab closes.
const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key, value) => {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // Nothing to do: see above.
  }
};

export const tokenStorage = {
  get: () => read(TOKEN_KEY),
  set: (token) => write(TOKEN_KEY, token),
  clear: () => write(TOKEN_KEY, null),
};

// Which outlet the user is working in. Remembered on this device only: the
// server checks on every request that the outlet is really theirs, so a stale
// or edited value can do nothing except be rejected.
export const outletStorage = {
  get: () => read(OUTLET_KEY),
  set: (id) => write(OUTLET_KEY, id ? String(id) : null),
  clear: () => write(OUTLET_KEY, null),
};

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
});

// Uploaded images are served beside the API, not under it: the base URL ends
// in /api, so that last segment is dropped to reach them.
export const uploadUrl = (relativePath) =>
  relativePath
    ? `${String(import.meta.env.VITE_API_BASE_URL).replace(/\/api\/?$/, "")}/uploads/${relativePath}`
    : null;

// Send the saved token with every request.
api.interceptors.request.use((config) => {
  // withApproval asking which request a call makes, before a manager approves
  // it: the request is stopped here and never sent (see services/approval.js).
  const headers = config.headers || {};
  const capture = typeof headers.has === "function" ? headers.has(CAPTURE_HEADER) : Boolean(headers[CAPTURE_HEADER]);

  if (capture) {
    const stop = new Error("Request captured for a manager's approval");
    stop.approvalCapture = { method: config.method, url: config.url };
    throw stop;
  }

  const token = tokenStorage.get();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  const outlet = outletStorage.get();

  if (outlet) {
    config.headers["X-Outlet-Id"] = outlet;
  }

  return config;
});

// --- Sliding session -------------------------------------------------------
//
// A token lives a fixed time (8 hours by default). While someone is working,
// the token is swapped for a fresh one once it is past half its life, so a
// 12-hour shift is never cut off in the middle of service. A till nobody
// touches simply lets it run out.

const payloadOf = (token) => {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")));
  } catch {
    return null;
  }
};

let refreshing = null;

const refreshIfOld = () => {
  const token = tokenStorage.get();

  if (!token || refreshing) {
    return;
  }

  const payload = payloadOf(token);

  if (!payload || !payload.exp || !payload.iat) {
    return;
  }

  const now = Date.now() / 1000;

  if (now - payload.iat < (payload.exp - payload.iat) / 2 || now >= payload.exp) {
    return;
  }

  refreshing = api
    .post("/auth/refresh", null, { skipRefresh: true })
    .then((response) => {
      // Only if nobody signed in as someone else meanwhile.
      if (tokenStorage.get() === token) {
        tokenStorage.set(response.data.data.token);
      }
    })
    .catch(() => undefined)
    .finally(() => {
      refreshing = null;
    });
};

// Tell the rest of the app the session is over.
const signalLogout = (reason) => {
  tokenStorage.clear();
  outletStorage.clear();
  window.dispatchEvent(new CustomEvent("auth:logout", { detail: { reason } }));
};

api.interceptors.response.use(
  (response) => {
    if (!response.config?.skipRefresh) {
      refreshIfOld();
    }

    return response;
  },
  async (error) => {
    const { config } = error;
    const status = error.response?.status;

    // A 401 on a request that carried a token means the session has ended:
    // expired, the password was changed or reset, "sign out everywhere", or
    // the account was deactivated. Every screen then goes to sign-in.
    if (status === 401 && config?.headers?.Authorization) {
      signalLogout(error.response?.data?.message);
      return Promise.reject(error);
    }

    // A restaurant feature was switched off (Settings -> Features) since this
    // screen loaded its profile: tell the app, which reloads the profile so
    // the feature's menu entries and buttons go away.
    if (status === 403 && error.response?.data?.data?.reason === "feature_off") {
      window.dispatchEvent(new CustomEvent("features:changed"));
    }

    // A manager's approval is needed: open the PIN dialog, then send the same
    // request again with the one-time token. Once only — a refused token the
    // second time round is shown as the error it is.
    //
    // The refusal says what the request would do (details.scope: this bill,
    // this amount), read by the server off the request itself. The prompt
    // shows those figures and the approval is tied to them, so even a screen
    // that never says what it is doing gets an approval for exactly that.
    if (isApprovalRequired(error) && config && !config.approvalRetried && hasApprovalHandler()) {
      const details = error.response.data.data;
      const token = await requestApproval({
        permission: details.permission,
        action: details.action,
        label: currentApprovalLabel(),
        method: config.method,
        url: config.url,
        scope: details.scope || null,
        invalid: details.reason === "approval_invalid",
        message: details.reason === "approval_invalid" ? error.response.data.message : null,
      });

      error.approvalHandled = true;

      if (!token) {
        error.approvalCancelled = true;
        return Promise.reject(error);
      }

      config.approvalRetried = true;
      config.headers["X-Approval-Token"] = token;

      return api.request(config);
    }

    if (isApprovalRequired(error) && config?.approvalRetried) {
      error.approvalHandled = true;
    }

    return Promise.reject(error);
  },
);

export const getErrorMessage = (error) =>
  error.response?.data?.message || "Cannot reach the server. Please check that the API is running.";

export default api;
