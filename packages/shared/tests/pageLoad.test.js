import { test } from "node:test";
import assert from "node:assert/strict";

import { afterFailedLoad, isFailedPageLoad, RELOAD_MARK, RELOAD_WINDOW_MS } from "@bmp/shared/pageLoad";

// A page whose code fails to load (@bmp/shared/pageLoad, used by @bmp/ui's
// PageLoadBoundary): reload once by itself, then say so, and never loop.

// A sessionStorage stand-in; `refuse` makes every call throw, as a browser
// with storage blocked does.
const memoryStorage = ({ refuse = false } = {}) => {
  const items = new Map();
  return {
    items,
    getItem(key) {
      if (refuse) throw new Error("The operation is insecure.");
      return items.has(key) ? items.get(key) : null;
    },
    setItem(key, value) {
      if (refuse) throw new Error("The operation is insecure.");
      items.set(key, String(value));
    },
  };
};

test("a page's code that could not be fetched is told from any other error", () => {
  assert.equal(isFailedPageLoad(new TypeError("Failed to fetch dynamically imported module: http://shop.example/assets/DocumentsPage-Ab12.js")), true);
  assert.equal(isFailedPageLoad(new TypeError("error loading dynamically imported module: http://shop.example/assets/x.js")), true);
  assert.equal(isFailedPageLoad(new TypeError("Importing a module script failed.")), true);
  assert.equal(isFailedPageLoad(new Error("Unable to preload CSS for /assets/DocumentsPage-Cd34.css")), true);
  assert.equal(isFailedPageLoad(Object.assign(new Error("Loading chunk 12 failed."), { name: "ChunkLoadError" })), true);

  assert.equal(isFailedPageLoad(new TypeError("Cannot read properties of undefined (reading 'name')")), false);
  assert.equal(isFailedPageLoad(new Error("Request failed with status code 500")), false);
  assert.equal(isFailedPageLoad(null), false);
  assert.equal(isFailedPageLoad(undefined), false);
});

test("the first failure at an address reloads, the next one says so", () => {
  const storage = memoryStorage();
  const now = Date.parse("2026-10-29T10:00:00Z");

  assert.equal(afterFailedLoad(storage, "/business-admin/7/documents", now), "reload");
  assert.deepEqual(JSON.parse(storage.items.get(RELOAD_MARK)), { address: "/business-admin/7/documents", at: now });

  // The reloaded page fails again: a message, not another reload.
  assert.equal(afterFailedLoad(storage, "/business-admin/7/documents", now + 2_000), "message");
  assert.equal(afterFailedLoad(storage, "/business-admin/7/documents", now + 4_000), "message");
});

test("another address, or a failure long after the reload, reloads again", () => {
  const storage = memoryStorage();
  const now = Date.parse("2026-10-29T10:00:00Z");

  assert.equal(afterFailedLoad(storage, "/orders", now), "reload");
  // A different page failing in the same tab is a failure of its own.
  assert.equal(afterFailedLoad(storage, "/menu/products", now + 1_000), "reload");
  // The address with a query is another address.
  assert.equal(afterFailedLoad(storage, "/menu/products?tab=combos", now + 2_000), "reload");

  // The same page an hour later (another new version gone live) reloads again.
  assert.equal(afterFailedLoad(storage, "/menu/products?tab=combos", now + 2_000 + RELOAD_WINDOW_MS), "reload");
  assert.equal(afterFailedLoad(storage, "/menu/products?tab=combos", now + 3_000 + RELOAD_WINDOW_MS), "message");
});

test("a tab that cannot remember never reloads by itself", () => {
  // Storage blocked, missing, or holding something unreadable.
  assert.equal(afterFailedLoad(memoryStorage({ refuse: true }), "/orders"), "message");
  assert.equal(afterFailedLoad(null, "/orders"), "message");
  assert.equal(afterFailedLoad(undefined, "/orders"), "message");

  const garbled = memoryStorage();
  garbled.items.set(RELOAD_MARK, "{not json");
  assert.equal(afterFailedLoad(garbled, "/orders"), "message");
});

test("a clock that went backwards does not count as a recent reload", () => {
  const storage = memoryStorage();
  const now = Date.parse("2026-10-29T10:00:00Z");

  assert.equal(afterFailedLoad(storage, "/orders", now), "reload");
  assert.equal(afterFailedLoad(storage, "/orders", now - 60_000), "reload");
});
