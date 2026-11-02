/* The staff app's service worker (docs/ARCHITECTURE.md › The service worker).
   Hand-written, no library. Registered by production builds only
   (src/services/offline/serviceWorker.js); development never runs one.

   - Install: keeps a copy of this build's files (the app shell, the built
     scripts and styles, icons and manifests) in a cache of its own, reusing
     what an earlier copy already holds (a file's name changes with its
     content), so an update downloads only what changed.
   - Waiting: a new build's worker waits until someone presses Reload on the
     app's "A new version is ready" bar. It never reloads a screen itself.
   - Activate: drops the copies of builds before the last one.
   - Fetch (sw-rules.js decides which): pages from the network, else this
     copy of the app; built files from the copy; uploaded pictures from the
     copy, refreshed behind; the API never.
   - Push: shows the captain app's alert, and opens it when tapped.

   The build writes this build's id, its files and the API's address into the
   line below (vite.config.js › serviceWorkerBuild); as written here it is a
   placeholder that never reaches a browser. */
self.__BMP_BUILD__ = { id: "development", files: [], api: "/api" };

self.importScripts("/sw-rules.js");

var RULES = self.BMP_SW_RULES;
var BUILD = self.__BMP_BUILD__;
var SHELL = RULES.shellCacheName(BUILD.id);
var ORIGIN = self.location.origin;
var APP_PAGE = "/index.html";
// A kept file is the same file whoever asks: a script the page loads sends
// its origin, the copy made at install did not, and an answer that varies by
// origin (Vary: Origin) would otherwise never match its own copy.
var ANY = { ignoreVary: true };

// --- Install: this build's copy -------------------------------------------------

var copyFile = function (cache, url) {
  // A built file of the same name in an earlier copy is the same file (its
  // name carries its content's hash); the app page, the manifests and icons
  // keep their names, so they are fetched afresh.
  return caches.match(url, ANY).then(function (kept) {
    if (kept && url.indexOf("/assets/") === 0) {
      return cache.put(url, kept);
    }
    return fetch(new Request(url, { cache: "reload", credentials: "same-origin" })).then(function (response) {
      if (!response.ok) {
        throw new Error("Could not keep " + url + " (" + response.status + ")");
      }
      return cache.put(url, response);
    });
  });
};

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (cache) {
      var files = BUILD.files.slice();
      // Six at a time, as a browser asks a server.
      var next = function () {
        var file = files.shift();
        return file ? copyFile(cache, file).then(next) : Promise.resolve();
      };
      return Promise.all([next(), next(), next(), next(), next(), next()]);
    })
  );
});

// --- Activate: the old copies go -----------------------------------------------

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(RULES.cachesToDelete(names, SHELL).map(function (name) {
          return caches.delete(name);
        }));
      })
      .then(function () {
        // A page asks the network while the worker starts, not after.
        return self.registration.navigationPreload ? self.registration.navigationPreload.enable().catch(function () {}) : null;
      })
      .then(function () {
        // The first worker looks after the pages already open, so they work offline at once.
        return self.clients.claim();
      })
  );
});

// Reload pressed on the app's bar: this worker takes over.
self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "BUILD" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ id: BUILD.id });
  }
});

// --- Fetch -------------------------------------------------------------------------

var OFFLINE_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>Offline</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;" +
  "background:#edf1f6;color:#202d40}main{max-width:26rem;padding:24px;text-align:center}button{font:inherit;padding:10px 18px;" +
  "border-radius:10px;border:0;background:#08796b;color:#fff}</style></head><body><main><h1>You're offline</h1><p>This device has no copy " +
  "of the app yet. Connect to the internet and open it once; after that it opens without a connection.</p>" +
  '<button onclick="location.reload()">Try again</button></main></body></html>';

var appPage = function () {
  return caches.open(SHELL).then(function (cache) {
    return cache.match(APP_PAGE, ANY);
  }).then(function (page) {
    return page || caches.match(APP_PAGE, ANY);
  }).then(function (page) {
    return page || new Response(OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  });
};

var navigate = function (event) {
  var network = Promise.resolve(event.preloadResponse).then(function (preloaded) {
    return preloaded || fetch(event.request);
  });
  var timeout = new Promise(function (resolve, reject) {
    setTimeout(function () {
      reject(new Error("slow"));
    }, RULES.NAVIGATION_TIMEOUT_MS);
  });
  // The network's page when it comes in time (never kept: it may be a newer
  // build than this copy); else this copy of the app.
  return Promise.race([network, timeout]).catch(function () {
    return appPage();
  });
};

var asset = function (request) {
  return caches.match(request, ANY).then(function (kept) {
    return (
      kept ||
      fetch(request).then(function (response) {
        if (response.ok && response.type === "basic") {
          var copy = response.clone();
          caches.open(SHELL).then(function (cache) {
            return cache.put(request, copy);
          });
        }
        return response;
      })
    );
  });
};

var trimUploads = function (cache) {
  return cache.keys().then(function (keys) {
    return Promise.all(RULES.uploadsToDrop(keys).map(function (key) {
      return cache.delete(key);
    }));
  });
};

// The copy at once, refreshed behind; the network when there is none.
var keptAndRefreshed = function (event, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(event.request, ANY).then(function (kept) {
      var fresh = fetch(event.request)
        .then(function (response) {
          if (RULES.keepable(response)) {
            var copy = response.clone();
            event.waitUntil(cache.put(event.request, copy).then(function () {
              return cacheName === RULES.UPLOADS_CACHE ? trimUploads(cache) : null;
            }));
          }
          return response;
        })
        .catch(function (error) {
          if (kept) {
            return kept;
          }
          throw error;
        });
      if (kept) {
        event.waitUntil(fresh.catch(function () {}));
        return kept;
      }
      return fresh;
    });
  });
};

self.addEventListener("fetch", function (event) {
  var request = event.request;
  var strategy = RULES.strategyFor({ url: request.url, method: request.method, mode: request.mode }, { origin: ORIGIN, apiBase: BUILD.api });
  if (strategy === "navigate") {
    event.respondWith(navigate(event));
  } else if (strategy === "asset") {
    event.respondWith(asset(request));
  } else if (strategy === "uploads") {
    event.respondWith(keptAndRefreshed(event, RULES.UPLOADS_CACHE));
  } else if (strategy === "static") {
    event.respondWith(keptAndRefreshed(event, SHELL));
  }
  // "none": not answered here; the browser asks the network as always.
});

// --- Push: the captain app's alerts ---------------------------------------------------

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (windows) {
        var visibleCaptain = windows.some(function (client) {
          return RULES.isVisibleCaptain(client, ORIGIN);
        });
        var note = RULES.notificationFor(data, { origin: ORIGIN, visibleCaptain: visibleCaptain, now: Date.now() });
        return self.registration.showNotification(note.title, note.options);
      })
  );
});

self.addEventListener("notificationclick", function (event) {
  var target = (event.notification.data && event.notification.data.url) || "/captain";
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      var open = RULES.windowFor(windows, target, ORIGIN);
      if (open) {
        // The app moves to the screen itself, keeping what is on it.
        open.postMessage({ type: "bmp:open", url: target });
        return open.focus ? open.focus() : open;
      }
      return self.clients.openWindow(target);
    })
  );
});

// The browser renewed this phone's subscription by itself: the server moves
// the phone's alerts to the new one (the old address and its secret prove
// it is the same phone). If that fails, the app saves it when next opened.
self.addEventListener("pushsubscriptionchange", function (event) {
  var old = event.oldSubscription ? event.oldSubscription.toJSON() : null;
  var renewed = event.newSubscription
    ? Promise.resolve(event.newSubscription)
    : event.oldSubscription
      ? self.registration.pushManager.subscribe(event.oldSubscription.options)
      : Promise.resolve(null);
  event.waitUntil(
    renewed
      .then(function (subscription) {
        if (!subscription || !old || !old.keys) {
          return null;
        }
        var api = String(BUILD.api || "/api").replace(/\/+$/, "");
        return fetch(api + "/push/subscriptions/renew", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldEndpoint: old.endpoint, oldAuth: old.keys.auth, subscription: subscription.toJSON() }),
        });
      })
      .catch(function () {})
  );
});
