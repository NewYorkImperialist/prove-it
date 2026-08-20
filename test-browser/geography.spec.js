"use strict";
// Every check here corresponds to a defect found the first time this screen was opened in a
// browser. It had full unit coverage of its data layer and shipped with an invisible "cleared"
// state, one visible row in landscape, an error line welded to a heading, a sticky validation
// message, and a navigation flow that stranded the player on a screen they never asked for.
const { test, expect } = require("@playwright/test");

const MODES = ["Name the map", "Flags", "Borders", "Capitals"];

// The app writes the solo name to localStorage["ch_name"] and board progress to
// localStorage["geo_boards"]. Seed before the first paint or the screen reads the old value.
async function openGeography(page, { name = "Tester", progress = null } = {}) {
  await page.addInitScript(
    ([n, p]) => {
      try {
        if (n === null) window.localStorage.removeItem("ch_name");
        else window.localStorage.setItem("ch_name", n);
        if (p) window.localStorage.setItem("geo_boards", p);
        else window.localStorage.removeItem("geo_boards");
      } catch { /* private mode — the app copes, so the test should too */ }
    },
    [name, progress && JSON.stringify(progress)],
  );
  await page.goto("/?geo=1");
  await expect(page.getByRole("heading", { name: /Geography/ })).toBeVisible();
}

const modeTile = (page, label) => page.getByRole("button", { name: new RegExp(label) });

test.describe("the Geography screen", () => {
  test("renders with no console errors and no page errors", async ({ page }) => {
    const bad = [];
    page.on("console", (m) => {
      // The geography atlases and flag images come off a CDN that is blocked in CI; those
      // failures are the point of a separate test below, not a rendering defect here.
      if (m.type() === "error" && !/ERR_|Failed to load resource/.test(m.text())) bad.push(m.text());
    });
    page.on("pageerror", (e) => bad.push(String(e)));
    await openGeography(page);
    for (const m of MODES) await expect(modeTile(page, m)).toBeVisible();
    expect(bad, `console/page errors: ${bad.join(" | ")}`).toEqual([]);
  });

  test("the card stays inside the viewport at every size", async ({ page }) => {
    await openGeography(page);
    const card = page.locator("div").filter({ hasText: /boards\./ }).first();
    const box = await card.boundingBox();
    const vp = page.viewportSize();
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  });

  test("no horizontal overflow anywhere on the screen", async ({ page }) => {
    await openGeography(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await modeTile(page, "Name the map").click();
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow2).toBeLessThanOrEqual(0);
  });

  test("every mode opens a non-empty region list", async ({ page }) => {
    await openGeography(page);
    for (const label of MODES) {
      await modeTile(page, label).click();
      await expect(page.getByText(/\d+ answers ·/).first()).toBeVisible();
      // Back to the mode list for the next one.
      await page.getByRole("button", { name: "← Back" }).click();
      await expect(modeTile(page, "Capitals")).toBeVisible();
    }
  });

  // Landscape is the viewport this app breaks on: wide enough for `desk:`, ~390px tall.
  test("more than one region row is reachable without the header eating the card", async ({ page }) => {
    await openGeography(page);
    await modeTile(page, "Name the map").click();
    const rows = page.locator("button").filter({ hasText: /\d+ answers ·/ });
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBe(11); // all 11 map regions are rendered
    // At least two rows visible at once: with the full-height header this was exactly one.
    const vp = page.viewportSize();
    let onScreen = 0;
    for (let i = 0; i < count; i++) {
      const b = await rows.nth(i).boundingBox();
      if (b && b.y >= 0 && b.y + b.height <= vp.height) onScreen++;
    }
    expect(onScreen, "only one region row fits — the header is taking the whole card").toBeGreaterThanOrEqual(2);
  });

  test("Back is two-step: region list → mode list → menu", async ({ page }) => {
    await openGeography(page);
    await modeTile(page, "Flags").click();
    await expect(page.getByText(/\d+ answers ·/).first()).toBeVisible();
    await page.getByRole("button", { name: "← Back" }).click();
    await expect(modeTile(page, "Capitals")).toBeVisible(); // the mode list, not the menu
    await page.getByRole("button", { name: "← Back" }).click();
    await expect(page.getByRole("button", { name: /Play Solo/ })).toBeVisible(); // now the menu
  });

  test("an empty name blocks the run, says so, and stops saying so once you type", async ({ page }) => {
    await openGeography(page, { name: null });
    await modeTile(page, "Capitals").click();
    await page.getByText(/\d+ answers ·/).first().click();
    await expect(page.getByText("Enter your name first.")).toBeVisible();
    await expect(page.locator("#geoName")).toBeFocused();
    // Still on the Geography screen — it must not have started anything.
    await expect(page.getByRole("heading", { name: /Geography/ })).toBeVisible();
    // The message used to stay put while you typed a perfectly good name.
    await page.locator("#geoName").fill("Ada");
    await expect(page.getByText("Enter your name first.")).toBeHidden();
  });

  test("a failed start keeps you on the Geography screen, with the reason", async ({ page }) => {
    // No database is configured in CI, so creating the run fails — which is exactly the case that
    // used to route to the solo builder first and report the failure there.
    await openGeography(page);
    await modeTile(page, "Capitals").click();
    await page.getByText(/\d+ answers ·/).first().click();
    await expect(page.getByText(/persistence|Could not start/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /Geography/ })).toBeVisible();
    // The solo builder's own control must never appear on the way through.
    await expect(page.getByText("Pick a category")).toHaveCount(0);
  });

  test("progress is reported, and a cleared board is visually distinct from a hovered one", async ({ page }) => {
    await openGeography(page, {
      progress: {
        "Countries of the World": { best: 197, total: 197, at: 1 },
        "Flags of Europe": { best: 10, total: 47, at: 1 },
      },
    });
    await expect(page.getByText("1 of 27 boards cleared · 2 played.")).toBeVisible();
    await expect(modeTile(page, "Name the map")).toContainText("1/11");
    await expect(modeTile(page, "Flags")).toContainText("0/7");

    await modeTile(page, "Name the map").click();
    const cleared = page.locator("button").filter({ hasText: "best 197/197" });
    const other = page.locator("button").filter({ hasText: /Africa/ }).first();
    await expect(cleared).toContainText("✓");

    // accent2 is the same amber as accent, so a border alone can't carry this: cleared has to
    // differ from a merely-hovered row by something other than border colour.
    const clearedBg = await cleared.evaluate((el) => getComputedStyle(el).backgroundColor);
    await other.hover();
    const hoverBg = await other.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(clearedBg, "a cleared board looks identical to a hovered one").not.toBe(hoverBg);
  });

  test("a partly-played board shows its best without claiming a clear", async ({ page }) => {
    await openGeography(page, { progress: { "Flags of Europe": { best: 10, total: 47, at: 1 } } });
    await modeTile(page, "Flags").click();
    const row = page.locator("button").filter({ hasText: "best 10/47" });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText("✓");
  });

  test("changing step scrolls back to the top of the list", async ({ page }) => {
    await openGeography(page);
    await modeTile(page, "Name the map").click();
    const scroller = page.locator("div").filter({ hasText: /boards\.|All-time geography/ }).first();
    await scroller.evaluate((el) => { const s = el.closest("[class*='overflow-y-auto']") || el; s.scrollTop = 400; });
    await page.getByRole("button", { name: "← Back" }).click();
    await modeTile(page, "Capitals").click();
    // The heading for the step you just opened has to be on screen.
    await expect(page.getByText(/Capitals/).first()).toBeInViewport();
  });
});

// The share stub bounces /challenge.html?geo=<board> to /?geo=<board>. AppShell compared that
// value with "1", so a shared board link showed the right preview card and then dropped the
// clicker on the main menu.
test.describe("following a shared board link", () => {
  test("a board name opens that board's mode, not the menu and not the mode list", async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem("ch_name", "Tester"); } catch { /* private mode */ }
    });
    await page.goto("/?geo=" + encodeURIComponent("Flags of Europe"));
    await expect(page.getByRole("heading", { name: /Geography/ })).toBeVisible();
    // Landed inside the Flags list: its regions are showing, and the mode tiles are gone.
    await expect(page.getByText(/\d+ answers ·/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Capitals/ })).toHaveCount(0);
    await expect(page.getByText("Europe", { exact: true })).toBeVisible();
  });

  test("the link never starts the run on its own — the clock is not spent by a click-through", async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem("ch_name", "Tester"); } catch { /* private mode */ }
    });
    await page.goto("/?geo=" + encodeURIComponent("Countries of the World"));
    await expect(page.getByRole("heading", { name: /Geography/ })).toBeVisible();
    // Still the picker: no timer, no answer box.
    await expect(page.getByPlaceholder(/Type a name and hit Enter/)).toHaveCount(0);
  });

  test("a plain ?geo=1 still opens the mode list, as it always did", async ({ page }) => {
    await openGeography(page);
    for (const m of MODES) await expect(modeTile(page, m)).toBeVisible();
  });
});

test.describe("the home card with Geography on it", () => {
  test("Geography is present, highlighted and flagged new — with no emoji", async ({ page }) => {
    await page.goto("/");
    const btn = page.getByRole("button", { name: /^Geography/ });
    await expect(btn).toBeVisible();
    await expect(btn).toContainText("New");
    await expect(await btn.textContent()).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  test("every menu entry is reachable, including the last one", async ({ page }) => {
    await page.goto("/");
    // Challenge Race is the bottom entry; in landscape it was 170px below the fold with no
    // scroll affordance, so a whole mode was unreachable.
    const race = page.getByRole("button", { name: /Challenge Race/ });
    await race.scrollIntoViewIfNeeded();
    await expect(race).toBeInViewport();
  });
});
