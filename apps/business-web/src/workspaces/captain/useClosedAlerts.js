import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "../../services/api";
import { toast } from "../../services/toast";
import {
  alertsWanted,
  deviceSubscription,
  environment,
  pushStatus,
  sendTestAlert,
  serverKey,
  turnOff,
  turnOn,
} from "../../services/push";

// What the switch says for each state (services/push.js pushStatus).
export const PUSH_WORDS = {
  checking: "Checking whether this phone can get alerts…",
  "off-server": "Alerts on a closed phone are not set up on this server.",
  development: "Alerts on a closed phone work in the app as installed from the live server, not in this development copy.",
  "ios-install": "On an iPhone or iPad, alerts work in the app on your Home Screen. Add it there first, then open it from its icon and turn alerts on.",
  unsupported: "This browser cannot show alerts while the app is closed. Use Chrome on Android, or Safari on an iPhone with the app on the Home Screen.",
  denied: "Notifications are blocked for this app. Allow them in the browser's settings for this site (the mark beside the address, then Notifications, Allow), then turn alerts on.",
  asking: "Allow notifications when your phone asks. If no question shows, tap the mark beside the address, then Notifications, Allow.",
  on: "On. Guests' calls and food ready at your tables reach this phone even when the app is closed.",
  off: "Off. Turn on to hear of calls and food ready at your tables while the app is closed.",
};

// This phone's alerts when the app is closed: { status, on, off, test, busy }.
export default function useClosedAlerts(user, { allTables } = {}) {
  const [key, setKey] = useState(undefined);
  const [subscribed, setSubscribed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [looks, setLooks] = useState(0);

  // The server's key and this device's subscription, read again after each change.
  useEffect(() => {
    let alive = true;

    Promise.all([serverKey().catch(() => undefined), deviceSubscription()]).then(([found, held]) => {
      if (alive) {
        setKey(found);
        setSubscribed(Boolean(held) && alertsWanted(user.id));
      }
    });

    return () => {
      alive = false;
    };
  }, [user.id, looks]);

  const look = useCallback(() => setLooks((n) => n + 1), []);

  const env = environment();
  const status = pushStatus({ serverKey: key, ...env, subscribed, asking });

  const on = async () => {
    setBusy(true);
    setProblem("");

    try {
      const outcome = await turnOn(user, {
        allTables,
        onAnswer: (answer) => {
          setAsking(false);
          look();
          if (answer === "on") toast.success("Alerts are on for this phone.");
        },
      });
      setAsking(outcome === "asking");
      look();

      if (outcome === "on") {
        toast.success("Alerts are on for this phone.");
      }
    } catch (error) {
      setProblem(error.response ? getErrorMessage(error) : error.message || "Alerts could not be turned on. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const off = async () => {
    setBusy(true);
    setProblem("");

    try {
      setAsking(false);
      await turnOff(user);
      look();
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setProblem("");

    try {
      const answer = await sendTestAlert();
      toast.success(answer.message || "A test alert is on its way to this phone.");
    } catch (error) {
      setProblem(error.response ? getErrorMessage(error) : error.message);
      look();
    } finally {
      setBusy(false);
    }
  };

  return { status, on, off, test, busy, problem, refresh: look };
}
