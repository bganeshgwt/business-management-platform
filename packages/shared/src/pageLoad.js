// A page whose code fails to load. Both apps load each page's code the first
// time it is opened. When a new version goes live while a tab is open, the
// old version's files are gone, so the next page opened fails to load: a
// reload fetches the new version and fixes it. When the load fails again (no
// network, a broken file), reloading would loop, so the page says so instead.
// The apps' PageLoadBoundary (@bmp/ui) uses these two rules.

// The marker kept in the browser tab's sessionStorage: { address, at }.
export const RELOAD_MARK = "bmp.pageLoadReload";
// A reload for the same address this long ago is a new failure, not a loop.
export const RELOAD_WINDOW_MS = 5 * 60 * 1000;

// Is this error a page's code that could not be fetched? The browsers word it
// differently; Vite says it of a page's stylesheet.
const FAILED_LOAD = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

export function isFailedPageLoad(error) {
  const text = `${error?.name || ""} ${error?.message || error || ""}`;
  return FAILED_LOAD.some((pattern) => pattern.test(text)) || error?.name === "ChunkLoadError";
}

// What to do after a failed load at this address: "reload" the first time
// (and remember it), "message" when this tab already reloaded for it lately,
// or when the tab cannot remember (sessionStorage refused or missing), since a
// reload might then go round for ever.
export function afterFailedLoad(storage, address, now = Date.now()) {
  try {
    const saved = JSON.parse(storage.getItem(RELOAD_MARK) || "null");

    if (saved && saved.address === address && now - saved.at >= 0 && now - saved.at < RELOAD_WINDOW_MS) {
      return "message";
    }

    storage.setItem(RELOAD_MARK, JSON.stringify({ address, at: now }));
    return "reload";
  } catch {
    return "message";
  }
}
