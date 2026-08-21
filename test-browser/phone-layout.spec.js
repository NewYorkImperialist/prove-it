"use strict";
// Five defects a phone playtest turned up, each of which the node suite could never have caught:
// they are all "this element resolved to the wrong height" or "this element is past the fold",
// which needs a real layout engine at a real viewport. Playwright runs this file at all three
// project viewports, and the landscape phone (844x390) is the one that earns its keep — wide
// enough to match `desk:` while being only ~390px tall, which is where these broke.
const { test, expect } = require("@playwright/test");

// Creating a run POSTs /challenge, which needs a database CI doesn't have. Stub only that; every
// other request goes to the real server.
async function stubRunCreation(page) {
  await page.route("**/challenge", (r) => (r.request().method() === "POST"
    ? r.fulfill({ json: { ok: true, id: "spec01" } })
    : r.continue()));
  await page.route("**/challenge/*/result", (r) => r.fulfill({ json: { ok: true } }));
  await page.route("**/challenge/*/guesses", (r) => r.fulfill({ json: { ok: true } }));
}

// Into a live round via the Geography screen, which is the shortest path to both a picture board
// and a map board. A "GO!" countdown sits between Start and the round, hence waiting on the input.
async function startBoard(page, mode) {
  await stubRunCreation(page);
  await page.addInitScript(() => { try { localStorage.setItem("ch_name", "Tester"); } catch { /* private mode */ } });
  await page.goto("/?geo=1");
  await page.getByRole("button", { name: new RegExp(mode) }).click();
  await page.getByText(/\d+ answers ·/).first().click();
  await page.getByRole("button", { name: /^Start$/ }).click();
  await page.waitForSelector('input[placeholder*="Type"]', { timeout: 20000 });
}

const inViewport = async (page, locator) => {
  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  return box !== null && box.y >= -1 && box.y + box.height <= vp.height + 1;
};

test.describe("the home menu fits the screen", () => {
  test("every mode is reachable without scrolling, and so is the credit line", async ({ page }) => {
    // At 844x390 the card held 527px of content in a 357px window: "Live Multiplayer" was sliced
    // through, "Challenge Race" and the credit line were gone, and the only hint was a 2px
    // scrollbar gutter. They go two-up on a short screen now.
    await page.goto("/");
    for (const name of [/Play Solo/, /Daily Challenge/, /Geography/, /Live Multiplayer/, /Challenge Race/]) {
      const b = page.getByRole("button", { name });
      await expect(b).toBeVisible();
      expect(await inViewport(page, b), `${name} is past the fold`).toBe(true);
    }
    await expect(page.getByText(/Created by/)).toBeVisible();
  });

  test("the card has nothing hidden inside its own scroller", async ({ page }) => {
    await page.goto("/");
    const hidden = await page.evaluate(() => {
      const card = document.querySelector('[class*="overflow-y-auto"]');
      return card ? card.scrollHeight - card.clientHeight : 0;
    });
    // A little slack: a few px of rounding is not a hidden button.
    expect(hidden, "content is hidden below the card's own scroll").toBeLessThan(24);
  });
});

test.describe("a picture round keeps its board and its input", () => {
  test("the flag grid has real height, and the box you type into is still on screen", async ({ page }) => {
    await startBoard(page, "Flags");
    const grid = page.locator('[class*="grid-cols-4"]').first();
    const h = await grid.evaluate((n) => n.clientHeight);
    // Measured 27px of a 534px grid before the floor: one sliced row of a 47-flag board, with no
    // way to tell which flag was highlighted. A floor tall enough for a row of tiles is the fix,
    // and it is safe precisely because FlagBoard scrolls the highlighted tile into view.
    expect(h, "the flag grid collapsed").toBeGreaterThanOrEqual(88);
    // …and the floor must not push the input off the bottom, which is the other half of the trade.
    expect(await inViewport(page, page.locator('input[placeholder*="Type"]')), "input pushed off-screen").toBe(true);
  });
});

test.describe("a map round shows what you have already named", () => {
  test("the chip row survives, with chips in it", async ({ page }) => {
    await startBoard(page, "Name the map");
    const input = page.locator('input[placeholder*="Type"]');
    for (const ans of ["France", "Japan", "Brazil", "Kenya"]) {
      await input.fill(ans);
      await input.press("Enter");
    }
    const chips = page.locator('[class*="flex-wrap"][class*="gap-1.5"]').first();
    await expect(chips.locator("span").first()).toBeVisible();
    const h = await chips.evaluate((n) => n.clientHeight);
    // This is a flex child of a `h-full flex-col` section, so once the map claimed its own floor
    // there was nothing left to give and flex-shrink took this row to exactly 0px — measured at
    // both phone viewports with a dozen chips inside it. `shrink-0` is the fix.
    expect(h, "the chip row was shrunk out of existence").toBeGreaterThan(12);
  });

  test("the answer feedback line stays on screen when the box is focused", async ({ page }) => {
    await startBoard(page, "Name the map");
    const input = page.locator('input[placeholder*="Type"]');
    await input.focus();
    // The input's own onFocus scrolls itself into view with block:"end", which aligned its bottom
    // edge to the viewport's and put this line exactly one row past it — so "✗ not on the list"
    // was never once visible, and every tap of the box pushed it out again. scroll-mb reserves it.
    await page.waitForTimeout(900);
    const msg = page.locator('[class*="min-h-[18px]"]').first();
    expect(await inViewport(page, msg), "the feedback line is below the fold").toBe(true);
  });
});

test.describe("the solo builder explains why you landed on it", () => {
  test("a dead challenge link says so, in view", async ({ page }) => {
    // Measured at y=568 in a 568px viewport and y=554 in a 390px one: the card looked like an
    // ordinary "Play solo" screen and the tap looked like it had done nothing at all.
    await page.goto("/?id=deadlink-does-not-exist");
    const err = page.getByText(/invalid or expired|needs persistence|Could not/i).first();
    await expect(err).toBeVisible({ timeout: 10000 });
    // Polled rather than measured once: the fix scrolls this into view with behavior:"smooth", so
    // a single read right after it appears catches the animation mid-flight and reports a false
    // failure. What matters is that it ends up on screen, not which frame it got there on.
    await expect.poll(() => inViewport(page, err), {
      message: "the reason never scrolled into view",
      timeout: 5000,
    }).toBe(true);
  });
});
