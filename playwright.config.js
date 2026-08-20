"use strict";
// Browser tests. These exist because the rest of the suite is node:test with no DOM, which is
// exactly how the Geography screen shipped having never been rendered — its data layer was unit
// tested and every visual and navigation defect in it went unnoticed until someone opened a
// browser. Run them with `npm run test:browser`; `npm test` stays node-only and fast.
//
// The container has Chromium pre-installed and PLAYWRIGHT_BROWSERS_PATH pointing at it, so there
// is no browser download step. If a version bump ever breaks that lookup, set
// launchOptions.executablePath to /opt/pw-browsers/chromium rather than downloading one.
const { defineConfig, devices } = require("@playwright/test");

const PORT = process.env.PW_PORT || 3100;

// The pre-installed Chromium is a fixed build, and @playwright/test's own version expects a
// different one — so point at the binary that's actually here rather than downloading one. Falls
// back to Playwright's own lookup if the path isn't present (a normal dev machine).
const fs = require("fs");
const CHROMIUM = "/opt/pw-browsers/chromium";
const launchOptions = fs.existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {};

module.exports = defineConfig({
  testDir: "./test-browser",
  // The server is shared and the app keeps state in localStorage, so parallel workers would fight
  // over it. These are quick; one worker is fine.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions, viewport: { width: 1280, height: 900 } } },
    // The two that actually catch things: the narrowest phone, and a landscape phone — wide enough
    // to match `desk:` but only ~390px tall, which is where this app's layouts break.
    { name: "phone-320", use: { ...devices["Desktop Chrome"], launchOptions, viewport: { width: 320, height: 568 } } },
    { name: "phone-landscape", use: { ...devices["Desktop Chrome"], launchOptions, viewport: { width: 844, height: 390 } } },
  ],
  webServer: {
    // Production build, not dev: dev-mode overlays and double-rendering hide real problems.
    command: `PORT=${PORT} NODE_ENV=production node server/index.js`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
