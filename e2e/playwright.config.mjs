// The browser tests of both web apps, in one run with one set of test data:
// the staff app's (apps/business-web/tests/browser) and the guests' site's
// (apps/customer-web/tests/browser). Playwright starts both apps' Vite dev
// servers on their test ports; the global set-up then makes a database of
// the run's own, starts the API on it and fills it (global-setup.mjs), and
// takes it all away again afterwards. Run with `npm run test:browser`.
import { defineConfig } from "@playwright/test";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { HOST, PORTS, URLS } from "./servers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITE = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");

// Specs that read these addresses find the test servers, never a developer's own.
process.env.E2E_BASE_URL = URLS.staff;
process.env.E2E_CUSTOMER_URL = URLS.guests;
process.env.E2E_API_URL = URLS.api;

// An app's Vite dev server, not a build: specs load the apps' own /src
// modules into the page. It is always started fresh (never one already
// running), and its addresses come from here: VITE_* variables in the
// environment win over the app's .env.
const devServer = (app, port, env) => ({
  name: app,
  command: `"${process.execPath}" "${VITE}" --port ${port} --strictPort --host ${HOST}`,
  cwd: path.join(ROOT, "apps", app),
  url: `http://${HOST}:${port}`,
  reuseExistingServer: false,
  timeout: 120_000,
  env,
});

export default defineConfig({
  globalSetup: "./global-setup.mjs",
  outputDir: path.join(ROOT, "test-results"),
  // One at a time: the specs share one restaurant and its businesses.
  workers: 1,
  reporter: "list",
  use: {
    // Windows can use the installed Edge; elsewhere install Playwright Chromium.
    channel: process.env.E2E_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "staff",
      testDir: path.join(ROOT, "apps", "business-web", "tests", "browser"),
      timeout: 180_000,
      use: { baseURL: URLS.staff },
    },
    {
      name: "guests",
      testDir: path.join(ROOT, "apps", "customer-web", "tests", "browser"),
      timeout: 60_000,
      use: { baseURL: URLS.guests },
    },
  ],
  webServer: [
    devServer("business-web", PORTS.staff, { VITE_API_BASE_URL: URLS.api, VITE_CUSTOMER_WEB_URL: URLS.guests }),
    devServer("customer-web", PORTS.guests, { VITE_API_BASE_URL: URLS.api }),
  ],
});
