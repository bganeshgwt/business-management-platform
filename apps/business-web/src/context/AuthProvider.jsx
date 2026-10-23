import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthContext } from "./auth-context";
import { outletStorage, tokenStorage } from "../services/api";
import { getCurrentUser, loginRequest, rememberRestaurantCode } from "../services/auth.service";
import { setApprovalPermissions } from "../services/approval";
import LogbookHandoverNotice from "../modules/restaurant/logbook/pages/LogbookHandoverNotice";

const LOCK_KEY = "rmp_locked";

// Activity that counts as "someone is using this till".
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];

const readFlag = (key) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const writeFlag = (key, on) => {
  try {
    if (on) {
      localStorage.setItem(key, "1");
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: the lock still works until the page reloads.
  }
};

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => Boolean(tokenStorage.get()));
  // A locked till keeps its session but shows only the lock screen. The flag
  // is kept on the device so reloading the page does not open it again.
  const [locked, setLocked] = useState(() => Boolean(tokenStorage.get()) && readFlag(LOCK_KEY));
  const [signedOutReason, setSignedOutReason] = useState("");
  // Counts sign-ins made on this screen (password, two-step, a PIN taking
  // over the till). A reload is not a sign-in, so it stays 0 then.
  const [signIns, setSignIns] = useState(0);
  const lastActivity = useRef(0);

  // A user tied to one outlet never sends an outlet choice: a value left on
  // this device by someone else would only be refused by the server.
  const adopt = useCallback((next) => {
    if (next?.outletId) {
      outletStorage.clear();
    }

    if (next?.restaurantCode) {
      rememberRestaurantCode(next.restaurantCode);
    }

    setUser(next);
  }, []);

  // On page load, turn a saved token back into a user (or drop it if it is no longer valid).
  useEffect(() => {
    if (!tokenStorage.get()) {
      return;
    }

    getCurrentUser()
      .then(adopt)
      .catch(() => tokenStorage.clear())
      .finally(() => setLoading(false));
  }, [adopt]);

  // api.js fires this when a request meets a switched-off feature, and the
  // Features screen after a switch: the profile (and its feature list) is
  // read again, at most once every few seconds.
  const featuresReadAt = useRef(0);
  useEffect(() => {
    const reload = () => {
      if (!tokenStorage.get() || Date.now() - featuresReadAt.current < 3000) {
        return;
      }

      featuresReadAt.current = Date.now();
      getCurrentUser().then(adopt).catch(() => {});
    };

    window.addEventListener("features:changed", reload);
    return () => window.removeEventListener("features:changed", reload);
  }, [adopt]);

  // api.js fires this when the server rejects the token: expired, the password
  // changed, "sign out everywhere", or the account was switched off.
  useEffect(() => {
    const handleLogout = (event) => {
      setUser(null);
      setLocked(false);
      writeFlag(LOCK_KEY, false);
      setSignedOutReason(event?.detail?.reason || "");
    };

    window.addEventListener("auth:logout", handleLogout);
    return () => window.removeEventListener("auth:logout", handleLogout);
  }, []);

  // A finished sign-in (password, and the two-step code when it was asked
  // for): the session starts on this device.
  const acceptSession = useCallback(
    (result) => {
      tokenStorage.set(result.token);
      // A new sign-in starts with no outlet chosen, so nothing is carried over
      // from whoever used this browser last.
      outletStorage.clear();
      writeFlag(LOCK_KEY, false);
      setLocked(false);
      setSignedOutReason("");
      adopt(result.user);
      setSignIns((n) => n + 1);
    },
    [adopt]
  );

  // With two-step sign-in on, a right password is not a session yet: the
  // answer carries { twoFactor } and the sign-in screen asks for the code.
  const login = useCallback(
    async (identifier, password, restaurantCode) => {
      const result = await loginRequest(identifier, password, restaurantCode);

      if (result.twoFactor) {
        return result;
      }

      acceptSession(result);
      return result;
    },
    [acceptSession]
  );

  const logout = useCallback(() => {
    tokenStorage.clear();
    outletStorage.clear();
    writeFlag(LOCK_KEY, false);
    setLocked(false);
    setUser(null);
  }, []);

  // Used by the profile page after saving, so the header shows the new name
  // without a round trip through the login screen.
  const refreshUser = useCallback((next) => adopt(next), [adopt]);

  // After a password change or "sign out other devices" the server hands this
  // device a fresh token, because every older one has just stopped working.
  const replaceToken = useCallback((token) => {
    if (token) {
      tokenStorage.set(token);
    }
  }, []);

  // --- The shared till --------------------------------------------------

  const lock = useCallback(() => {
    writeFlag(LOCK_KEY, true);
    setLocked(true);
  }, []);

  const unlock = useCallback(() => {
    writeFlag(LOCK_KEY, false);
    lastActivity.current = Date.now();
    setLocked(false);
  }, []);

  // Someone else took over the till with their PIN.
  const switchUser = useCallback(
    (result) => {
      tokenStorage.set(result.token);
      outletStorage.clear();
      writeFlag(LOCK_KEY, false);
      lastActivity.current = Date.now();
      setLocked(false);
      adopt(result.user);
      setSignIns((n) => n + 1);
    },
    [adopt]
  );

  // Locks the till after the restaurant's idle time (Users → Till lock). Any
  // touch, click or key counts as activity.
  const idleMinutes = user?.idleLockMinutes || 0;

  useEffect(() => {
    if (!user || idleMinutes <= 0) {
      return undefined;
    }

    lastActivity.current = Date.now();
    const touch = () => {
      lastActivity.current = Date.now();
    };

    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, touch, { passive: true }));

    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= idleMinutes * 60000) {
        writeFlag(LOCK_KEY, true);
        setLocked(true);
      }
    }, 10000);

    return () => {
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, touch));
      window.clearInterval(timer);
    };
  }, [user, idleMinutes]);

  // The approval prompt asks up front when the person plainly lacks a
  // permission, so it needs to know what they hold.
  useEffect(() => {
    setApprovalPermissions(user ? user.permissions : null);
  }, [user]);

  const hasPermission = useCallback(
    (permission) => Boolean(user?.permissions.includes(permission)),
    [user],
  );

  // A restaurant feature switched on in Settings -> Features (guests, loyalty,
  // reservations, deliveries, ...). The server refuses a switched-off
  // feature's requests too; this only keeps its screens and buttons away.
  const hasFeature = useCallback(
    (code) => Boolean(user?.restaurantId && Array.isArray(user.features) && user.features.includes(code)),
    [user],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      acceptSession,
      logout,
      hasPermission,
      hasFeature,
      refreshUser,
      replaceToken,
      locked: Boolean(user) && locked,
      lock,
      unlock,
      switchUser,
      signedOutReason,
    }),
    [user, loading, login, acceptSession, logout, hasPermission, hasFeature, refreshUser, replaceToken, locked, lock, unlock, switchUser, signedOutReason],
  );

  // Someone who keeps the log book, just signed in: what the last shift
  // handed over that they have not read (see LogbookHandoverNotice).
  const showHandover =
    signIns > 0 && Boolean(user?.restaurantId) && !locked && Boolean(user?.permissions.includes("logbook.view"));

  return (
    <AuthContext.Provider value={value}>
      {children}
      {showHandover && <LogbookHandoverNotice key={`${user.id}-${signIns}`} />}
    </AuthContext.Provider>
  );
}
