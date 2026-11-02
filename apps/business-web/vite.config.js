import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const inRepo = (path) => fileURLToPath(new URL(path, import.meta.url));

// The service worker's build (public/sw.js, docs/ARCHITECTURE.md › The
// service worker). After a production build, the line of sw.js that names
// the build gets this build's id, every file the worker keeps a copy of (the
// app page, the built scripts and styles, the icons and manifests) and the
// API's address. The id is a hash of all of it, so every new build is a new
// worker with a cache of its own, and an unchanged build is the same worker.
// Development never runs the worker (src/services/offline/serviceWorker.js).
const BUILD_LINE = /^self\.__BMP_BUILD__ = .*;$/m;
const WORKER_FILES = new Set(["sw.js", "sw-rules.js"]);
// The installable apps' icons are fetched by the browser when the app is
// installed; only the two a notification shows are kept for offline.
const KEPT_ICONS = new Set(["icons/captain-192.png", "icons/badge-96.png"]);

const filesUnder = (dir, base = dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });

function serviceWorkerBuild({ apiBase }) {
  let outDir = null;
  let bundled = [];

  return {
    name: "bmp-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    generateBundle(options, bundle) {
      bundled = Object.keys(bundle).filter((name) => !name.endsWith(".map"));
    },
    closeBundle() {
      const worker = path.join(outDir, "sw.js");

      if (!fs.existsSync(worker)) {
        return;
      }

      const files = [...new Set([...bundled, ...filesUnder(outDir)])]
        .filter((name) => !WORKER_FILES.has(name) && !name.endsWith(".map") && name !== "index.html")
        .filter((name) => !name.startsWith("icons/") || KEPT_ICONS.has(name))
        .sort();
      const hash = createHash("sha256");

      for (const name of ["index.html", ...files, "sw-rules.js"]) {
        const file = path.join(outDir, name);
        hash.update(name);
        if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
      }

      const build = { id: hash.digest("hex").slice(0, 16), files: ["/index.html", ...files.map((name) => `/${name}`)], api: apiBase };
      const source = fs.readFileSync(worker, "utf8");

      if (!BUILD_LINE.test(source)) {
        throw new Error("public/sw.js has lost the line that names its build (self.__BMP_BUILD__ = …;).");
      }

      fs.writeFileSync(worker, source.replace(BUILD_LINE, `self.__BMP_BUILD__ = ${JSON.stringify(build)};`));
    },
  };
}

// Is it a web address the guests' site can live at?
const isWebAddress = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

// The staff app. The two addresses it needs come from .env (.env.example
// explains them). Without the API every screen calls nowhere; without the
// guests' site's address QR codes and shared links would open the staff app
// instead (an old frontend/.env has no such line). So the server and the
// build refuse to start, with a sentence instead.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, "VITE_");
  const problems = [];
  const guestSite = env.VITE_CUSTOMER_WEB_URL;

  if (!env.VITE_API_BASE_URL) {
    problems.push("VITE_API_BASE_URL (the API, e.g. http://localhost:5010/api)");
  } else if (!isWebAddress(env.VITE_API_BASE_URL) && !env.VITE_API_BASE_URL.startsWith("/")) {
    // Every call, and the service worker's build line, would name nowhere.
    // Git Bash turns a /api typed on its command line into a Windows path
    // (C:/Program Files/Git/api).
    const fromGitBash = /^[A-Za-z]:[\\/]/.test(env.VITE_API_BASE_URL);
    problems.push(
      `VITE_API_BASE_URL (a web address, or a path such as /api, not "${env.VITE_API_BASE_URL}"${
        fromGitBash ? ": Git Bash made that of /api, so set MSYS_NO_PATHCONV=1 or put it in .env" : ""
      })`
    );
  }

  if (!guestSite || (guestSite !== "same-origin" && !isWebAddress(guestSite))) {
    problems.push('VITE_CUSTOMER_WEB_URL (the guests\' site, e.g. http://localhost:5174, or "same-origin" when one domain serves both apps)');
  }

  if (problems.length) {
    throw new Error(`Set ${problems.join(" and ")} in apps/business-web/.env or the environment.`);
  }

  // `vite preview` (a production build tried on this computer) forwards the
  // API and the uploaded pictures to PREVIEW_API_ORIGIN when it is set, as
  // one address serves both in production (docs/GO_LIVE.md › One address).
  // The browser tests try the built service worker that way.
  const previewApi = process.env.PREVIEW_API_ORIGIN;

  return {
    plugins: [react(), serviceWorkerBuild({ apiBase: env.VITE_API_BASE_URL })],
    preview: previewApi ? { proxy: { "/api": previewApi, "/uploads": previewApi } } : {},
    server: {
      // Always 5173: the guests' site is on 5174 and the API allows this address.
      port: 5173,
      strictPort: true,
      // The development server shows files from this app, the shared packages
      // and the installed libraries only: never the rest of the repository
      // (backend/.local holds backups and other machine-local files).
      fs: { allow: [here, inRepo("../../packages"), inRepo("../../node_modules")] },
    },
  };
});
