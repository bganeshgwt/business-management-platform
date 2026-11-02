import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthContext } from "./auth-context";
import { outletStorage, tokenPayload, tokenStorage } from "../services/api";
import { getCurrentUser, loginRequest, rememberRestaurantCode } from "../services/auth.service";
import { setApprovalPermissions } from "../services/approval";
import { closeLive } from "../services/live";
import { confirmAction } from "../services/confirm";
import { clearCopiesFor, readProfileCopy, saveProfileCopy } from "../services/offline/offlineCopies";
import { isOfflineCapable } from "../services/offline/offlineScreens";
import { subscribeOnline } from "../services/offline/online";
import { outbox, setOutboxPerson } from "../services/offline/outboxStore";
import { stopAlertsOnThisDevice, syncAlerts } from "../services/push";
import LogbookHandoverNotice from "../modules/restaurant/logbook/pages/LogbookHandoverNotice";
import PinChangePrompt from "../components/PinChangePrompt";
import SessionPrompt from "../components/SessionPrompt";

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

// Whoever may open the captain app gets its alerts on a closed phone back on
// this device after signing in, when they had them on (services/push.js).
const captainAlertsFor = (user) =>
  Boolean(user?.restaurantId && user.permissions?.includes("orders.create") && Array.isArray(user.features) && user.features.includes("captain_app"));

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

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
  // Who was signed in when the session ended (signed out, or ended by the
  // server). The sign-in page sends only that same person back to the page
  // they were on; anyone else starts at their own home page.
  const currentUserId = useRef(null);
  const [previousUserId, setPreviousUserId] = useState(null);
  // Opened with no network from this device's copy of the profile (offline
  // boot): the screens that work offline open, the others say they need the
  // network, until the server answers again.
  const [offline, setOffline] = useState(false);
  // A session kept on this device, with no copy to open from and no server
  // to ask: the app says it needs the network to start, and stays signed in.
  const [unreachable, setUnreachable] = useState(false);
  // The server ended the session while a screen that works offline was open:
  // the person signs in again over it (SessionPrompt).
  const [sessionEnded, setSessionEnded] = useState(null);

  // A user tied to one outlet never sends an outlet choice: a value left on
  // this device by someone else would only be refused by the server.
  // `copy`: the profile came from this device's copy, not the server.
  const adopt = useCallback((next, { copy = false } = {}) => {
    if (next?.outletId) {
      outletStorage.clear();
    }

    if (next?.restaurantCode) {
      rememberRestaurantCode(next.restaurantCode);
    }

    currentUserId.current = next?.id ?? null;
    setUser(next);
    setOffline(Boolean(next) && copy);
    setUnreachable(false);
    setOutboxPerson(next);

    if (next && !copy) {
      saveProfileCopy(next);
    }
  }, []);

  // On page load, turn a saved token back into a user. Only the server
  // saying the session is over ends it: with no answer at all (no network,
  // the server down) the person opens from this device's copy of their
  // profile, or is told the app needs the network to start, still signed in.
  const boot = useCallback(() => {
    let current = true;

    // A network that hangs rather than fails is no answer either.
    getCurrentUser({ timeout: 15000 })
      .then((profile) => current && adopt(profile))
      .catch(async (error) => {
        const status = error.response?.status;

        if (status === 401 || status === 403 || status === 404) {
          tokenStorage.clear();
          return;
        }

        const copy = await readProfileCopy(tokenPayload(tokenStorage.get() || "")?.sub);

        if (!current) {
          return;
        }

        if (copy) {
          adopt(copy.value, { copy: true });
        } else {
          setUnreachable(true);
        }
      })
      .finally(() => current && setLoading(false));

    return () => {
      current = false;
    };
  }, [adopt]);

  useEffect(() => {
    if (!tokenStorage.get()) {
      return undefined;
    }

    return boot();
  }, [boot]);

  // Opened offline: as soon as the server answers again, the profile is read
  // afresh and every screen opens as usual.
  useEffect(() => {
    if (!offline && !unreachable) {
      return undefined;
    }

    let asking = false;
    const ask = () => {
      if (asking || !tokenStorage.get()) {
        return;
      }

      asking = true;
      getCurrentUser()
        .then((profile) => adopt(profile))
        .catch(() => undefined)
        .finally(() => {
          asking = false;
        });
    };
    const timer = window.setInterval(ask, 20000);
    const stop = subscribeOnline((state) => state.online && ask());

    return () => {
      window.clearInterval(timer);
      stop();
    };
  }, [offline, unreachable, adopt]);

  // Alerts on a closed phone come back on this device for someone who had
  // them on; a renewed session is handed to the server too, so they carry on.
  useEffect(() => {
    if (!user || offline || !captainAlertsFor(user)) {
      return undefined;
    }

    syncAlerts(user);
    const renewed = () => syncAlerts(user);
    window.addEventListener("auth:token", renewed);
    return () => window.removeEventListener("auth:token", renewed);
  }, [user, offline]);

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
    // The server refused a request because this session must choose its own
    // PIN first (a till switched to it with a PIN someone else set): the
    // profile read again says so, and the prompt opens.
    window.addEventListener("pin:required", reload);
    return () => {
      window.removeEventListener("features:changed", reload);
      window.removeEventListener("pin:required", reload);
    };
  }, [adopt]);

  // api.js fires this when the server rejects the token: expired, the password
  // changed, "sign out everywhere", or the account was switched off.
  useEffect(() => {
    const handleLogout = (event) => {
      // On a screen that works offline (the captain app, the till) the person
      // signs in again over it: the screen stays as it is, and whatever waits
      // to be sent is kept (SessionPrompt).
      if (currentUserId.current && isOfflineCapable(window.location.pathname)) {
        closeLive();
        setSessionEnded({ reason: event?.detail?.reason || "" });
        return;
      }

      setSessionEnded(null);
      setPreviousUserId(currentUserId.current);
      currentUserId.current = null;
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
      setSessionEnded(null);
      adopt(result.user);
      setSignIns((n) => n + 1);
    },
    [adopt]
  );

  // Signed in again over the screen (SessionPrompt): the same person, the
  // same outlet and screen; what waited for the sign-in goes now.
  const resumeSession = useCallback(
    (result) => {
      tokenStorage.set(result.token);
      setSessionEnded(null);
      adopt(result.user);
      window.dispatchEvent(new CustomEvent("auth:token"));
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

  // Signing out. Anything made on this device that has not reached the
  // server is named first, since signing out deletes it; then this device's
  // alerts stop, and this person's offline copies go with the session.
  const logout = useCallback(async () => {
    const leaving = currentUserId.current;
    const waiting = leaving ? outbox.pending(leaving) : [];

    if (waiting.length > 0) {
      const sure = await confirmAction({
        title: `Sign out with ${plural(waiting.length, "change", "changes")} not sent?`,
        message: (
          <>
            <p>{waiting.length === 1 ? "This has" : "These have"} not reached the server yet, and signing out deletes {waiting.length === 1 ? "it" : "them"} from this device:</p>
            <ul>
              {waiting.slice(0, 6).map((item) => <li key={item.id}>{item.label}</li>)}
              {waiting.length > 6 && <li>and {waiting.length - 6} more</li>}
            </ul>
            <p>To send {waiting.length === 1 ? "it" : "them"}, stay signed in until the connection is back.</p>
          </>
        ),
        confirmLabel: "Sign out and delete",
        cancelLabel: "Stay signed in",
      });

      if (!sure) {
        return false;
      }
    }

    // The screens' live streams end with the session.
    closeLive();
    await stopAlertsOnThisDevice().catch(() => undefined);
    tokenStorage.clear();
    outletStorage.clear();
    writeFlag(LOCK_KEY, false);
    setLocked(false);
    setSessionEnded(null);
    setOffline(false);
    setOutboxPerson(null);
    setPreviousUserId(leaving);
    currentUserId.current = null;
    setUser(null);

    if (leaving) {
      await outbox.clearFor(leaving);
      await clearCopiesFor(leaving);
    }

    return true;
  }, []);

  // Used by the profile page after saving, so the header shows the new name
  // without a round trip through the login screen.
  const refreshUser = useCallback((next) => adopt(next), [adopt]);

  // After a password change or "sign out other devices" the server hands this
  // device a fresh token, because every older one has just stopped working.
  const replaceToken = useCallback((token) => {
    if (token) {
      tokenStorage.set(token);
      window.dispatchEvent(new CustomEvent("auth:token"));
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
      // The live streams were the last person's: the screens open their own,
      // and this device's alerts stop being theirs.
      if (result.user?.id !== currentUserId.current) {
        closeLive();
        stopAlertsOnThisDevice().catch(() => undefined);
      }
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
      previousUserId,
      offline,
      unreachable,
      retryStart: boot,
      sessionEnded,
    }),
    [user, loading, login, acceptSession, logout, hasPermission, hasFeature, refreshUser, replaceToken, locked, lock, unlock, switchUser, signedOutReason, previousUserId, offline, unreachable, boot, sessionEnded],
  );

  // A shared till switched to this person with a PIN someone else set: they
  // choose their own before anything else, in place of the app, as the server
  // answers nothing else meanwhile; the screens then open afresh as them.
  const choosePin = Boolean(user?.pinChangeRequired) && !user?.passwordChangeRequired;

  // Someone who keeps the log book, just signed in: what the last shift
  // handed over that they have not read (see LogbookHandoverNotice). Not
  // before they have chosen their own password or PIN, when nothing else opens.
  const showHandover =
    signIns > 0 &&
    Boolean(user?.restaurantId) &&
    !locked &&
    !user?.passwordChangeRequired &&
    !user?.pinChangeRequired &&
    Boolean(user?.permissions.includes("logbook.view"));

  return (
    <AuthContext.Provider value={value}>
      {choosePin ? <PinChangePrompt /> : children}
      {showHandover && <LogbookHandoverNotice key={`${user.id}-${signIns}`} />}
      {sessionEnded && user && (
        <SessionPrompt
          user={user}
          reason={sessionEnded.reason}
          onSignedIn={resumeSession}
          onSignOut={() => logout()}
          onUseSignInPage={() => {
            // The sign-in page sends this same person back to this screen.
            setSessionEnded(null);
            setPreviousUserId(currentUserId.current);
            currentUserId.current = null;
            setUser(null);
          }}
        />
      )}
    </AuthContext.Provider>
  );
}
