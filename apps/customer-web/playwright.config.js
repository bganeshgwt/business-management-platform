import { defineConfig } from "@playwright/test";
import process from "node:process";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_CUSTOMER_URL || "http://localhost:5174",
    // Windows can use the installed Edge; elsewhere install Playwright Chromium.
    channel: process.env.E2E_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    headless: true,
    trace: "off",
    screenshot: "only-on-failure",
  },
});
