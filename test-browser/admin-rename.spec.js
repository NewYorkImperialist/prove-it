"use strict";
// The rename control on /admin/leaderboards, driven in a real browser.
//
// It needs a browser because the whole control IS client-side script: a delegated click handler that
// runs prompt(), then confirm() to pick the scope, then builds the URL. node:test can assert that
// markup and that script are in the response body — it cannot say whether clicking the link asks the
// right question, or whether a name with an apostrophe in it still produces a working link. A
// leaderboard name is player-supplied text, and the previous version of the neighbouring remove link
// interpolated one straight into an inline onclick, where a single quote broke the handler.
//
// The shared webServer has no TURSO_URL, so /admin/leaderboards there early-returns "Persistence not
// configured" and has no rows on it at all. So this spec mounts the real admin router in-process
// against a stubbed analytics module and serves it on its own ephemeral port. The HTML and the
// script under test are the production ones; only the rows behind them are fixtures.
const { test, expect } = require("@playwright/test");
const express = require("express");
const { createAdminRouter } = require("../routes/admin.js");
const analytics = require("../server/stats.js");

const K = "test-owner-key";
process.env.OWNER_KEY = K;

// What the browser's rename navigation actually reached, asserted from this process.
let renames = [];
let rows = [];
let audit = [];
let server, origin, saved;

const entry = (over = {}) => ({
  id: 42, challenge_id: "d-20260820", name: "doodooblud", visitor_id: "v-abcdef123456",
  total: 2997, at: Date.now(), type: "daily", genre: null, ...over,
});

test.beforeAll(async () => {
  saved = { enabled: analytics.enabled, recentResults: analytics.recentResults, adminRename: analytics.adminRename, nameAuditList: analytics.nameAuditList };
  analytics.enabled = () => true;
  analytics.recentResults = async () => rows;
  analytics.nameAuditList = async () => audit;
  analytics.adminRename = async (args) => { renames.push(args); return { ok: true, rows: 1, from: "old", to: args.name, scope: args.scope }; };

  const app = express();
  app.use(createAdminRouter({
    io: { sockets: { sockets: new Map() }, emit: () => {} },
    costGuard: { getState: () => ({ coldTripped: false, hardTripped: false, coldError: null, costOverrideMonth: null }) },
    rooms: new Map(),
    stats: { roomsCreated: 0, gamesStarted: 0, peakRooms: 0 },
    serverStartedAt: Date.now(),
    getOnline: () => 0,
    isLockdown: () => false,
    setLockdown: () => {},
    closeRoom: () => false,
    closeAllRooms: () => 0,
  }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  Object.assign(analytics, saved);
  if (server) await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => { renames = []; rows = [entry()]; audit = []; });

const board = (page) => page.goto(`${origin}/admin/leaderboards?key=${K}`);

// prompt() and confirm() are dismissed automatically unless something handles them, so every
// answer the browser gives has to be scripted here.
function answer(page, { name, wide = null } = {}) {
  const asked = [];
  page.on("dialog", (d) => {
    asked.push({ type: d.type(), message: d.message() });
    if (d.type() === "prompt") return name === null ? d.dismiss() : d.accept(name);
    if (d.type() === "confirm") return wide ? d.accept() : d.dismiss();
    return d.dismiss();
  });
  return asked;
}

test.describe("renaming a leaderboard entry from the dashboard", () => {
  test("the rename prompt is seeded with the name the entry has now", async ({ page }) => {
    const asked = answer(page, { name: "jayden", wide: false });
    await board(page);
    await page.locator("a.rn").first().click();
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked[0].type).toBe("prompt");
    // Seeded, so correcting a name is an edit rather than retyping it from scratch — and so the
    // owner can see exactly which entry they are about to change.
    expect(asked[0].message).toContain("doodooblud");
    expect(await page.locator("a.rn").first().getAttribute("data-name")).toBe("doodooblud");
  });

  test("answering both prompts renames just that entry and comes back to the board", async ({ page }) => {
    answer(page, { name: "jayden", wide: false });
    await board(page);
    await page.locator("a.rn").first().click();
    await page.waitForURL(/\/admin\/leaderboards/);
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({ rowId: 42, name: "jayden", scope: "row" });
    await expect(page.locator("h1")).toContainText("Leaderboard entries");
  });

  test("accepting the second prompt is what asks for every entry by that visitor", async ({ page }) => {
    const asked = answer(page, { name: "jayden", wide: true });
    await board(page);
    await page.locator("a.rn").first().click();
    await page.waitForURL(/\/admin\/leaderboards/);
    // The scope question has to name the consequence out loud — this is the one click here that
    // rewrites rows the owner never looked at.
    const confirmed = asked.find((a) => a.type === "confirm");
    expect(confirmed.message).toContain("EVERY");
    expect(confirmed.message).toContain("v-abcdef123");
    expect(renames[0]).toMatchObject({ rowId: 42, name: "jayden", scope: "visitor" });
  });

  test("dismissing the scope question does the small thing, not the bulk one", async ({ page }) => {
    answer(page, { name: "jayden", wide: false });
    await board(page);
    await page.locator("a.rn").first().click();
    await page.waitForURL(/\/admin\/leaderboards/);
    expect(renames[0].scope).toBe("row");
  });

  test("cancelling the name prompt renames nothing and stays put", async ({ page }) => {
    const asked = answer(page, { name: null });
    await board(page);
    const before = page.url();
    await page.locator("a.rn").first().click();
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    await page.waitForTimeout(150);
    expect(renames).toEqual([]);
    expect(page.url()).toBe(before);
    // And it must not have gone on to ask about scope — that would read as if the rename were
    // still happening.
    expect(asked.filter((a) => a.type === "confirm")).toEqual([]);
  });

  test("an empty or unchanged name is treated as cancelling, not as a rename to blank", async ({ page }) => {
    // One listener for the whole loop: registering a second would race the first for the same
    // dialog, and Playwright rejects the loser.
    let typed = "";
    page.on("dialog", (d) => (d.type() === "prompt" ? d.accept(typed) : d.dismiss()));
    for (const next of ["", "   ", "doodooblud", "  doodooblud  "]) {
      typed = next;
      await board(page);
      await page.locator("a.rn").first().click();
      await page.waitForTimeout(200);
      expect(renames, `typed "${next}"`).toEqual([]);
    }
  });

  test("a name with an apostrophe in it still produces a working rename", async ({ page }) => {
    // The failure this guards: the old remove link built a JS string literal inside an HTML
    // attribute out of the row's name, so one apostrophe broke the handler for the whole page.
    rows = [entry({ name: "it's me" })];
    const asked = answer(page, { name: "jayden", wide: false });
    await board(page);
    await page.locator("a.rn").first().click();
    await page.waitForURL(/\/admin\/leaderboards/);
    expect(asked[0].message).toContain("it's me");
    expect(renames[0]).toMatchObject({ rowId: 42, name: "jayden" });
  });

  test("a name containing markup can't run as script", async ({ page }) => {
    rows = [entry({ name: '"><img src=x onerror="window.__pwned=1">' })];
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    answer(page, { name: "jayden", wide: false });
    await board(page);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    await page.locator("a.rn").first().click();
    await page.waitForURL(/\/admin\/leaderboards/);
    expect(renames[0].name).toBe("jayden");
    expect(errs).toEqual([]);
  });

  test("the name goes into the URL encoded, so spaces and symbols survive it", async ({ page }) => {
    answer(page, { name: "Jayden & Co #1", wide: false });
    await board(page);
    await page.locator("a.rn").first().click();
    await page.waitForURL(/\/admin\/leaderboards/);
    // A raw & would have truncated the name at the query-string boundary and dropped the scope.
    expect(renames[0].name).toBe("Jayden & Co #1");
    expect(renames[0].scope).toBe("row");
  });

  test("an entry with no visitor_id skips the scope question entirely", async ({ page }) => {
    // There is no bulk scope to offer, and asking a question whose answer is ignored is worse
    // than not asking.
    rows = [entry({ visitor_id: null })];
    const asked = answer(page, { name: "jayden", wide: true });
    await board(page);
    await page.locator("a.rn").first().click();
    await page.waitForURL(/\/admin\/leaderboards/);
    expect(asked.filter((a) => a.type === "confirm")).toEqual([]);
    expect(renames[0].scope).toBe("row");
  });

  test("the remove link next to it still confirms, and cancelling it does nothing", async ({ page }) => {
    const asked = answer(page, {});
    await board(page);
    const before = page.url();
    await page.locator("a.rm").first().click();
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked[0].message).toContain("doodooblud");
    await page.waitForTimeout(150);
    expect(page.url()).toBe(before);
  });

  test("both controls are reachable on a phone without the row scrolling the page sideways", async ({ page }) => {
    rows = [entry(), entry({ id: 43, name: "diddy kong" }), entry({ id: 44, name: "claude code" })];
    await board(page);
    await expect(page.locator("a.rn")).toHaveCount(3);
    for (const cls of ["a.rn", "a.rm"]) {
      const box = await page.locator(cls).first().boundingBox();
      expect(box, `${cls} has no box`).not.toBeNull();
      expect(box.width, `${cls} is not hittable`).toBeGreaterThan(8);
    }
    // The wide row lives in the table's own .tw scroller; the page itself must not move.
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw).toBeLessThanOrEqual(cw + 1);
  });

  test("the rename history shows what a name used to be", async ({ page }) => {
    audit = [{ at: Date.now(), scope: "visitor", row_id: 42, visitor_id: "v-abcdef123456", old_name: "THE ONE ABOVE ALL", new_name: "jayden", rows: 4, by_who: "admin" }];
    await board(page);
    await expect(page.getByText("Rename history")).toBeVisible();
    await expect(page.getByText("THE ONE ABOVE ALL")).toBeVisible();
    await expect(page.getByText("4 entries")).toBeVisible();
  });

  test("the page logs no console error", async ({ page }) => {
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
    audit = [{ at: Date.now(), scope: "row", row_id: 42, visitor_id: "v-a", old_name: "x", new_name: "jayden", rows: 1, by_who: "admin" }];
    await board(page);
    expect(errs).toEqual([]);
  });
});
