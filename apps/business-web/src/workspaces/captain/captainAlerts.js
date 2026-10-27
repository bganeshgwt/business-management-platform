// The captain app's alerts: the phone vibrates and chimes when a guest calls
// or food reaches the pass at the captain's tables, once the waiter has
// switched alerts on (a tap, which is also what lets a browser play sound).
// Where a browser cannot vibrate (an iPhone) the chime alone sounds; where it
// cannot play sound, nothing does, and the badges and the message still show.
// The choice is kept on this device.
import { playChime, unlockChime } from "../../services/kot";

const KEY = "rmp_captain_alerts";

export const alertsWanted = () => {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};

export const rememberAlerts = (on) => {
  try {
    if (on) {
      localStorage.setItem(KEY, "on");
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {
    // Storage blocked: the switch still works until the page reloads.
  }
};

export const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

// Called from a tap: the browser lets the page play sound from then on.
export const prepareAlerts = () => {
  try {
    unlockChime();
  } catch {
    // No sound on this browser: the phone still buzzes where it can.
  }
};

// Two short buzzes and the chime.
export const ring = () => {
  try {
    if (canVibrate()) {
      navigator.vibrate([180, 90, 180]);
    }
  } catch {
    // A browser that refuses to vibrate here: the chime still sounds.
  }

  try {
    playChime();
  } catch {
    // No sound on this browser: the message on the screen still shows.
  }
};
