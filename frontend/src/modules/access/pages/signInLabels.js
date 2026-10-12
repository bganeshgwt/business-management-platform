import { dateTime } from "../../../services/format";
// Words for the sign-in history, shared by My profile and Users.

export const SIGN_IN_METHODS = {
  password: "Password",
  pin: "PIN at a shared till",
  unlock: "Unlocked a till",
  two_factor: "Two-step code",
  recovery_code: "Recovery code",
};

export const SIGN_IN_OUTCOMES = {
  success: { label: "Signed in", tone: "badge-active" },
  wrong_password: { label: "Wrong password", tone: "badge-warning" },
  wrong_pin: { label: "Wrong PIN", tone: "badge-warning" },
  locked: { label: "Blocked — locked", tone: "badge-danger" },
  inactive: { label: "Blocked — account off", tone: "badge-danger" },
  code_needed: { label: "Password right — code asked", tone: "badge-neutral" },
  setup_needed: { label: "Password right — sent to set up two-step", tone: "badge-neutral" },
  wrong_code: { label: "Wrong two-step code", tone: "badge-warning" },
  two_factor_device: { label: "Blocked — two-step not passed on this till", tone: "badge-danger" },
};

// How the second step went, on a sign-in that got that far.
export const TWO_FACTOR_WORDS = {
  passed: "Two-step passed",
  failed: "Two-step failed",
  recovery_code: "Two-step: recovery code used",
  trusted_device: "Two-step skipped: trusted device",
  set_up: "Two-step set up now",
};

// "Chrome on Windows" from a browser's user-agent string: enough to tell the
// office PC from the counter tablet, without showing the raw string.
export const deviceOf = (userAgent) => {
  const text = String(userAgent || "");

  if (!text) {
    return "—";
  }

  const browser = /Edg\//.test(text)
    ? "Edge"
    : /OPR\//.test(text)
      ? "Opera"
      : /Chrome\//.test(text)
        ? "Chrome"
        : /Firefox\//.test(text)
          ? "Firefox"
          : /Safari\//.test(text)
            ? "Safari"
            : /node|axios|curl/i.test(text)
              ? "A script"
              : "A browser";

  const system = /Android/.test(text)
    ? "Android"
    : /iPhone|iPad/.test(text)
      ? "iPhone / iPad"
      : /Windows/.test(text)
        ? "Windows"
        : /Mac OS X/.test(text)
          ? "Mac"
          : /Linux/.test(text)
            ? "Linux"
            : "";

  return system ? `${browser} on ${system}` : browser;
};

// "::ffff:192.168.1.20" -> "192.168.1.20"; the server's own loopback reads as
// "this server" rather than "::1".
export const addressOf = (ip) => {
  const text = String(ip || "").replace(/^::ffff:/, "");

  if (!text) {
    return "";
  }

  return ["::1", "127.0.0.1"].includes(text) ? "same machine as the server" : text;
};

export const whenOf = (value) => dateTime(value);
