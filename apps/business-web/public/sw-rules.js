/* The staff app's service worker rules (docs/ARCHITECTURE.md › The service
   worker): which way each request is answered, the cache names, and what a
   push notification shows. public/sw.js loads this file with importScripts;
   tests/service-worker.test.js runs the same file on its own. A plain script,
   no modules, so every browser's service worker can load it. */
(function (scope) {
  "use strict";

  var SHELL_PREFIX = "bmp-shell-";
  var UPLOADS_CACHE = "bmp-uploads";
  // Pictures kept for a screen opened offline: the most recent this many, and
  // none larger than this (a product photo is far smaller).
  var UPLOADS_MAX_ENTRIES = 200;
  var UPLOADS_MAX_BYTES = 3 * 1024 * 1024;
  // A page that takes longer than this to come from the server is opened
  // from this device's copy of the app instead (a patchy connection).
  var NAVIGATION_TIMEOUT_MS = 3500;
  // The guests' pages, when one address serves both apps (GO_LIVE › One
  // address): never the staff app's to answer.
  var GUEST_PAGE = /^\/(order|online|book|privacy-notice|shop|appointments|account)(\/|$)/;
  var GUEST_FILES = /^\/guest-assets\//;
  // Built files whose names carry their content's hash.
  var HASHED_ASSET = /^\/assets\//;
  // The worker's own files.
  var OWN_FILES = /^\/(sw|sw-rules)\.js$/;

  var parse = function (url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };

  // The API's address as the app was built with it (VITE_API_BASE_URL: an
  // address, or /api on the app's own), and the uploaded files beside it.
  var apiOf = function (apiBase, origin) {
    var api = parse(String(apiBase || "/api").replace(/\/+$/, ""), origin);
    if (!api) {
      return null;
    }
    return {
      origin: api.origin,
      path: api.pathname.replace(/\/+$/, ""),
      uploads: api.pathname.replace(/\/+$/, "").replace(/\/api$/, "") + "/uploads",
    };
  };

  var under = function (pathname, prefix) {
    return pathname === prefix || pathname.indexOf(prefix + "/") === 0;
  };

  /* How a request is answered:
       none      not by the worker: the browser asks the network as always
                 (the API, anything not a GET, other sites, the guests' pages)
       navigate  a page of the app: the network first, this device's copy of
                 the app when there is none (or it takes too long)
       asset     a built file: this device's copy first (its name changes
                 with its content)
       uploads   an uploaded picture: the copy at once, refreshed behind
       static    the app's other files (icons, manifests): as uploads
     `request`: { url, method, mode }; `context`: { origin, apiBase }. */
  var strategyFor = function (request, context) {
    var url = parse(request.url);
    var api = apiOf(context.apiBase, context.origin);
    if (!url || String(request.method || "GET").toUpperCase() !== "GET") {
      return "none";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "none";
    }
    // The API is never kept, whoever asks for it.
    if (api && url.origin === api.origin && under(url.pathname, api.path)) {
      return "none";
    }
    if (api && url.origin === api.origin && under(url.pathname, api.uploads)) {
      return "uploads";
    }
    if (url.origin !== context.origin) {
      return "none";
    }
    if (under(url.pathname, "/api") || OWN_FILES.test(url.pathname)) {
      return "none";
    }
    if (GUEST_PAGE.test(url.pathname) || GUEST_FILES.test(url.pathname)) {
      return "none";
    }
    if (request.mode === "navigate") {
      return "navigate";
    }
    if (under(url.pathname, "/uploads")) {
      return "uploads";
    }
    if (HASHED_ASSET.test(url.pathname)) {
      return "asset";
    }
    return "static";
  };

  var shellCacheName = function (buildId) {
    return SHELL_PREFIX + buildId;
  };

  /* The caches to delete once a build's worker takes over: every app copy
     but its own and the one before it, whose files a tab still open on the
     old version may yet ask for. `names` in the order they were made. */
  var cachesToDelete = function (names, current) {
    var shells = names.filter(function (name) {
      return name.indexOf(SHELL_PREFIX) === 0 && name !== current;
    });
    var previous = shells.length ? shells[shells.length - 1] : null;
    return shells.filter(function (name) {
      return name !== previous;
    });
  };

  // The pictures to drop, oldest first, to keep at most UPLOADS_MAX_ENTRIES.
  var uploadsToDrop = function (keys, max) {
    var limit = typeof max === "number" ? max : UPLOADS_MAX_ENTRIES;
    return keys.length > limit ? keys.slice(0, keys.length - limit) : [];
  };

  // Whether a picture's answer may be kept: a whole, readable answer of a
  // sensible size (never an opaque one, whose size the browser hides).
  var keepable = function (response) {
    if (!response || response.status !== 200 || response.type === "opaque") {
      return false;
    }
    var size = Number(response.headers && response.headers.get ? response.headers.get("content-length") : NaN);
    return !(size > UPLOADS_MAX_BYTES);
  };

  /* A push notification, from the server's message ({ title, body, url,
     tag }). Each is shown, always: a browser drops the subscription of a
     site whose pushes show nothing. Tagged per table, a newer alert at a
     table replaces the one before; while the captain app is open in front
     of the person (`visibleCaptain`), it shows quietly, since the app
     itself chimes. Only an address of the app itself is opened from it. */
  var notificationFor = function (data, context) {
    var message = data && typeof data === "object" ? data : {};
    var origin = context.origin;
    var target = parse(typeof message.url === "string" ? message.url : "/captain", origin);
    var url = target && target.origin === origin ? target.pathname + target.search : "/captain";
    var tag = typeof message.tag === "string" && message.tag ? message.tag.slice(0, 64) : "";
    var options = {
      body: typeof message.body === "string" ? message.body.slice(0, 240) : "",
      icon: "/icons/captain-192.png",
      badge: "/icons/badge-96.png",
      data: { url: url },
      timestamp: Date.parse(message.at) || context.now || Date.now(),
      silent: Boolean(context.visibleCaptain),
    };
    if (tag) {
      options.tag = tag;
      options.renotify = !context.visibleCaptain;
    }
    return {
      title: typeof message.title === "string" && message.title ? message.title.slice(0, 120) : "Captain app",
      options: options,
    };
  };

  // Whether a window shows the captain app in front of the person.
  var isVisibleCaptain = function (client, origin) {
    var url = parse(client && client.url);
    return Boolean(url && url.origin === origin && under(url.pathname, "/captain") && client.visibilityState === "visible" && client.focused !== false);
  };

  // The window to bring forward for a notification: one of the app's on the
  // same workspace (the captain app), else any of the app's.
  var windowFor = function (clients, target, origin) {
    var path = (parse(target, origin) || { pathname: "/" }).pathname;
    var workspace = "/" + (path.split("/")[1] || "");
    var mine = clients.filter(function (client) {
      var url = parse(client.url);
      return url && url.origin === origin && !GUEST_PAGE.test(url.pathname);
    });
    var same = mine.filter(function (client) {
      return under(parse(client.url).pathname, workspace);
    });
    return same[0] || mine[0] || null;
  };

  scope.BMP_SW_RULES = {
    SHELL_PREFIX: SHELL_PREFIX,
    UPLOADS_CACHE: UPLOADS_CACHE,
    UPLOADS_MAX_ENTRIES: UPLOADS_MAX_ENTRIES,
    UPLOADS_MAX_BYTES: UPLOADS_MAX_BYTES,
    NAVIGATION_TIMEOUT_MS: NAVIGATION_TIMEOUT_MS,
    strategyFor: strategyFor,
    shellCacheName: shellCacheName,
    cachesToDelete: cachesToDelete,
    uploadsToDrop: uploadsToDrop,
    keepable: keepable,
    notificationFor: notificationFor,
    isVisibleCaptain: isVisibleCaptain,
    windowFor: windowFor,
  };
})(typeof self !== "undefined" ? self : globalThis);
