// Installing the app on a phone, tablet or computer (docs/ADMIN_GUIDE.md ›
// Install the app). Chrome, Edge and Samsung Internet offer it themselves:
// their offer (beforeinstallprompt) is kept from the moment the app starts
// (main.jsx imports this first), so a menu item can show it when the person
// asks. Safari on an iPhone or iPad has no such offer: there the app shows
// the steps instead: Share, then Add to Home Screen. An app already running
// installed offers nothing.

const listeners = new Set();
let offer = null;
let installedNow = false;

// An iPhone or iPad (iPadOS says it is a Mac, with a touch screen).
export const isIosDevice = ({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) =>
  /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);

// Running as an installed app, not in a browser tab.
export const isStandalone = ({ displayStandalone = false, navigatorStandalone = false } = {}) => Boolean(displayStandalone || navigatorStandalone);

// What to offer: "prompt" (the browser's own install), "ios" (the Home
// Screen steps), or null (installed already, or nothing to offer here).
export const installOffer = ({ canPrompt, standalone, ios, installed }) => {
  if (standalone || installed) {
    return null;
  }

  if (canPrompt) {
    return "prompt";
  }

  return ios ? "ios" : null;
};

const environment = () => {
  if (typeof window === "undefined") {
    return { canPrompt: false, standalone: false, ios: false, installed: false };
  }

  return {
    canPrompt: Boolean(offer),
    standalone: isStandalone({
      displayStandalone: window.matchMedia?.("(display-mode: standalone)").matches || window.matchMedia?.("(display-mode: fullscreen)").matches,
      navigatorStandalone: window.navigator.standalone === true,
    }),
    ios: isIosDevice({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }),
    installed: installedNow,
  };
};

export const installState = () => {
  const env = environment();
  return { ...env, offer: installOffer(env) };
};

const emit = () => {
  const state = installState();
  listeners.forEach((listener) => listener(state));
};

export const subscribeInstall = (listener) => {
  listeners.add(listener);
  listener(installState());
  return () => listeners.delete(listener);
};

// The browser's own install, from a tap. "accepted", "dismissed" or "unavailable".
export const promptInstall = async () => {
  if (!offer) {
    return "unavailable";
  }

  const asked = offer;
  offer = null;
  emit();

  try {
    await asked.prompt();
    const choice = await asked.userChoice;
    return choice?.outcome || "dismissed";
  } catch {
    return "unavailable";
  }
};

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // The app offers it from its own menus, where it helps, not as a banner.
    event.preventDefault();
    offer = event;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    offer = null;
    installedNow = true;
    emit();
  });
}
