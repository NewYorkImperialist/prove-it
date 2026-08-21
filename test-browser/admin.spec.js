"use strict";
// The owner dashboard, driven in a real browser at the same three viewports as the game.
//
// It needs its own spec because it is the part of this app a browser had never rendered under
// test: every one of its eleven pages was Express-built HTML that opened straight into <body>
// with no <head> at all, so none of them declared a viewport and all of them came up at desktop
// width on a phone. The unit tests can assert the tag is in the markup; only a browser can say
// the page actually fits on the screen.
const { test, expect } = require("@playwright/test");

const K = "test-owner-key";
const PAGES = ["/admin", "/admin/health", "/admin/games", "/admin/chat", "/admin/visitors",
  "/admin/sessions", "/admin/leaderboards", "/admin/category-leaderboards", "/admin/runs"];

const url = (p) => `${p}?key=${K}`;

test.describe("the owner dashboard", () => {
  test("no page scrolls sideways at any viewport", async ({ page }) => {
    for (const p of PAGES) {
      await page.goto(url(p));
      const { sw, cw } = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      // The three card grids used to ask for a 300-340px minimum track, which is wider than a
      // 320px phone's content box — so the whole page scrolled sideways and the headings left
      // the screen with it.
      expect(sw, `${p} overflows horizontally`).toBeLessThanOrEqual(cw + 1);
    }
  });

  test("no page logs a console error or throws", async ({ page }) => {
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
    for (const p of PAGES) await page.goto(url(p));
    expect(errs).toEqual([]);
  });

  test("every page is installable: viewport, manifest and theme colour", async ({ page }) => {
    for (const p of PAGES) {
      await page.goto(url(p));
      await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /width=device-width/);
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /\/admin\/manifest\.webmanifest/);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0e1016");
    }
  });

  test("the manifest the pages point at is real, and names a separate app from the game", async ({ page, request }) => {
    await page.goto(url("/admin"));
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    const res = await request.get(href);
    expect(res.status()).toBe(200);
    const m = await res.json();
    expect(m.name).toBe("Prove It! Admin");
    expect(m.id).toBe("/admin");
    // A distinct icon set is the point: two identical tiles on a home screen would be unusable.
    for (const i of m.icons) expect(i.src).toMatch(/^\/admin-icon-/);
  });

  test("the drill-down links are tiles you can actually hit, and they go where they say", async ({ page }) => {
    await page.goto(url("/admin"));
    const tiles = page.locator(".tools a");
    await expect(tiles).toHaveCount(8);
    // As bare 13px links these were well under a comfortable tap target, and on a phone they
    // stacked into one wall of bold blue text taller than the rest of the page put together.
    for (let i = 0; i < 8; i++) {
      const box = await tiles.nth(i).boundingBox();
      expect(box.height, "tap target too short").toBeGreaterThanOrEqual(36);
    }
    await tiles.first().click();
    await expect(page).toHaveURL(/\/admin\/health/);
    await expect(page.locator("h1")).toContainText("Category health");
  });

  test("a wide table scrolls inside its own box, not by dragging the page", async ({ page }) => {
    // The dashboard, not /admin/sessions: with no database that page early-returns "Persistence
    // not configured" and has no table on it at all. The live-connections table is always there.
    await page.goto(url("/admin"));
    await expect(page.locator(".tw").first()).toBeVisible();
    // The page itself must stay put; only the table's own scroller may move.
    const { sw, cw } = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(sw).toBeLessThanOrEqual(cw + 1);
  });

  test("an unauthenticated visitor sees nothing, on any page", async ({ page }) => {
    for (const p of PAGES) {
      const res = await page.goto(p);
      expect(res.status(), `${p} leaked without a key`).toBe(404);
    }
  });
});
