import { QueryClient } from "@tanstack/react-query";
import { outletStorage, tokenStorage } from "./api";

// One memory for answers the app reads again and again (the dashboard, its live
// blocks, the restaurant's settings). Leaving a screen no longer throws its
// figures away: coming back shows the last ones at once, and they are read
// again in the background only when they are older than 30 seconds.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      // Kept for ten minutes after the last screen using them closes.
      gcTime: 10 * 60 * 1000,
      retry: 1,
      // Screens that need a refresh on return to the tab ask for it themselves.
      refetchOnWindowFocus: false,
      // Always ask, whatever the browser says about being online: a till's
      // browser can wrongly report "offline" (some kiosks and headless
      // browsers do), and a paused read would leave the screen loading
      // forever. A failed read says so on screen, as before.
      networkMode: "always",
    },
  },
});

// Who and where this answer is for: the signed-in person, their restaurant and
// the outlet picked on this device. Part of every key, so after a switch of
// user (the shared till) or of outlet nothing read for the last one is shown.
export const sessionScope = () => {
  const token = tokenStorage.get();
  let who = "signed-out";

  if (token) {
    try {
      const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "=")));
      who = `${payload.sub}:${payload.restaurantId ?? ""}`;
    } catch {
      who = "unknown";
    }
  }

  return [who, outletStorage.get() || "all"];
};

// The session ended (expired, signed out elsewhere): nothing read for it stays.
if (typeof window !== "undefined") {
  window.addEventListener("auth:logout", () => queryClient.clear());
}
