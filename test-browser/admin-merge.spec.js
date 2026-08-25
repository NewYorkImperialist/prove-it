"use strict";
// The merge-players form, driven in a real browser.
//
// Two things here only a browser can check. The form has client-side logic — the submit button
// enables only once two different visitors are picked, and relabels itself when they are the same —
// and it is two full-width <select>s plus a text input, which is the widest control set on any admin
// page and the most likely to overflow a 320px phone.
//
// Like admin-rename.spec.js this mounts the real admin router in-process against a stubbed analytics
// module, because the shared webServer has no TURSO_URL and the merge page early-returns
// "Persistence not configured" with no form on it at all.
const { test, expect } = require("@playwright/test");
const express = require("express");
const { createAdminRouter } = require("../routes/admin.js");
const analytics = require("../server/stats.js");

const K = "test-owner-key";
process.env.OWNER_KEY = K;

let merges = [];
let nameMerges = [];
let undos = [];
let people = [];
let names = [];
let history = [];
let result = { ok: true, rows: 3 };
let server, origin, saved;

const person = (over = {}) => ({
  visitor_id: "v-aaaaaaaaaaaa", entries: 4, best: 2997,
  first_at: Date.now() - 864e5, last_at: Date.now(), crown: 0, names: "doodooblud", ...over,
});

test.beforeAll(async () => {
  saved = {
    enabled: analytics.enabled, resultVisitors: analytics.resultVisitors,
    mergeVisitors: analytics.mergeVisitors, undoMerge: analytics.undoMerge, mergeAuditList: analytics.mergeAuditList,
    resultNames: analytics.resultNames, mergeNames: analytics.mergeNames,
  };
  analytics.enabled = () => true;
  analytics.resultVisitors = async () => people;
  analytics.resultNames = async () => names;
  analytics.mergeNames = async (a) => { nameMerges.push(a); return result; };
  analytics.mergeAuditList = async () => history;
  analytics.mergeVisitors = async (a) => { merges.push(a); return result; };
  analytics.undoMerge = async (id, by) => { undos.push({ id, by }); return result; };

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

const nameRow = (over = {}) => ({ name: "jayden", entries: 4, visitors: 1, best: 2997, first_at: Date.now() - 864e5, last_at: Date.now(), crown: 0, ...over });

test.beforeEach(() => {
  merges = []; nameMerges = []; undos = []; history = [];
  names = [
    nameRow({ name: "jayden", visitors: 1, entries: 4 }),
    nameRow({ name: "Jayden", visitors: 1, entries: 2, best: 41 }),
    nameRow({ name: "diddy kong", visitors: 3, entries: 9, best: 61 }),
  ];
  result = { ok: true, rows: 3 };
  people = [
    person({ visitor_id: "v-aaaaaaaaaaaa", names: "doodooblud" }),
    person({ visitor_id: "v-bbbbbbbbbbbb", names: "diddy kong", entries: 2, best: 41 }),
    person({ visitor_id: "v-cccccccccccc", names: "claude code", entries: 1, best: 12 }),
  ];
});

const merge = (page) => page.goto(`${origin}/admin/merge?key=${K}`);
const accept = (page) => page.on("dialog", (d) => d.accept());

test.describe("the merge-players form", () => {
  test("the button is dead until two different players are picked", async ({ page }) => {
    await merge(page);
    const btn = page.locator("#mf button");
    await expect(btn).toBeDisabled();
    await page.selectOption("#keep", "v-aaaaaaaaaaaa");
    await expect(btn, "one side is not enough").toBeDisabled();
    await page.selectOption("#from", "v-bbbbbbbbbbbb");
    await expect(btn).toBeEnabled();
  });

  test("picking the same player on both sides says so instead of merging", async ({ page }) => {
    // keep === from with a name would become a plain bulk rename, filed in the merge history as if
    // two players had been combined.
    await merge(page);
    await page.selectOption("#keep", "v-aaaaaaaaaaaa");
    await page.selectOption("#from", "v-aaaaaaaaaaaa");
    const btn = page.locator("#mf button");
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveText("Pick two different players");
    // And it recovers when they change one.
    await page.selectOption("#from", "v-bbbbbbbbbbbb");
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveText("Merge these two");
  });

  test("submitting confirms first, naming both players", async ({ page }) => {
    const asked = [];
    page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
    await merge(page);
    await page.selectOption("#keep", "v-aaaaaaaaaaaa");
    await page.selectOption("#from", "v-bbbbbbbbbbbb");
    await page.locator("#mf button").click();
    await page.waitForURL(/done=merged/);
    expect(asked).toHaveLength(1);
    // Which one is being folded away is the part that matters, so both labels have to be in it.
    expect(asked[0]).toContain("diddy kong");
    expect(asked[0]).toContain("doodooblud");
    expect(merges[0]).toMatchObject({ keep: "v-aaaaaaaaaaaa", from: "v-bbbbbbbbbbbb" });
  });

  test("cancelling the confirm merges nothing", async ({ page }) => {
    page.on("dialog", (d) => d.dismiss());
    await merge(page);
    await page.selectOption("#keep", "v-aaaaaaaaaaaa");
    await page.selectOption("#from", "v-bbbbbbbbbbbb");
    await page.locator("#mf button").click();
    await page.waitForTimeout(200);
    expect(merges).toEqual([]);
    expect(page.url()).not.toContain("done=");
  });

  test("the optional name rides along with the merge", async ({ page }) => {
    accept(page);
    await merge(page);
    await page.selectOption("#keep", "v-aaaaaaaaaaaa");
    await page.selectOption("#from", "v-bbbbbbbbbbbb");
    await page.fill("#name", "jayden");
    await page.locator("#mf button").click();
    await page.waitForURL(/done=merged/);
    expect(merges[0].name).toBe("jayden");
  });

  test("leaving the name blank keeps the names they already have", async ({ page }) => {
    accept(page);
    await merge(page);
    await page.selectOption("#keep", "v-aaaaaaaaaaaa");
    await page.selectOption("#from", "v-bbbbbbbbbbbb");
    await page.locator("#mf button").click();
    await page.waitForURL(/done=merged/);
    expect(merges[0].name).toBeNull();
  });

  test("the outcome is reported on the page it lands back on", async ({ page }) => {
    accept(page);
    result = { ok: true, rows: 7 };
    await merge(page);
    await page.selectOption("#keep", "v-aaaaaaaaaaaa");
    await page.selectOption("#from", "v-bbbbbbbbbbbb");
    await page.locator("#mf button").click();
    await page.waitForURL(/done=merged/);
    await expect(page.getByText("7 entries moved")).toBeVisible();
  });

  test("a refused merge is visible too, not a silent reload", async ({ page }) => {
    accept(page);
    result = { ok: false, reason: "nothing-to-merge", rows: 0 };
    await merge(page);
    await page.selectOption("#keep", "v-aaaaaaaaaaaa");
    await page.selectOption("#from", "v-bbbbbbbbbbbb");
    await page.locator("#mf button").click();
    await page.waitForURL(/done=nothing-to-merge/);
    await expect(page.getByText(/no entries to move/i)).toBeVisible();
  });

  test("a merge can be put back from the history", async ({ page }) => {
    history = [{ id: 3, at: Date.now(), keep_visitor: "v-aaaaaaaaaaaa", from_visitor: "v-bbbbbbbbbbbb", rows: 4, renamed: "jayden", by_who: "admin", undone_at: null }];
    result = { ok: true, rows: 4 };
    const asked = [];
    page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
    await merge(page);
    await page.locator("a.rn").first().click();
    await page.waitForURL(/done=undone/);
    expect(asked[0]).toMatch(/put this merge back/i);
    expect(undos).toEqual([{ id: "3", by: "admin" }]);
    await expect(page.getByText("4 entries returned")).toBeVisible();
  });

  test("cancelling a put-back leaves the merge alone", async ({ page }) => {
    history = [{ id: 3, at: Date.now(), keep_visitor: "v-a", from_visitor: "v-b", rows: 4, renamed: null, by_who: "admin", undone_at: null }];
    page.on("dialog", (d) => d.dismiss());
    await merge(page);
    await page.locator("a.rn").first().click();
    await page.waitForTimeout(200);
    expect(undos).toEqual([]);
  });

  test("an already-undone merge offers no put-back link", async ({ page }) => {
    history = [{ id: 2, at: Date.now(), keep_visitor: "v-a", from_visitor: "v-b", rows: 1, renamed: null, by_who: "admin", undone_at: Date.now() }];
    await merge(page);
    await expect(page.locator("a.rn")).toHaveCount(0);
    await expect(page.getByText(/put back/).first()).toBeVisible();
  });

  test("the whole form fits the viewport, with tappable controls", async ({ page }) => {
    await merge(page);
    // Two selects, a text input and a button: the widest control set on any admin page.
    for (const sel of ["#keep", "#from", "#name", "#mf button"]) {
      const box = await page.locator(sel).boundingBox();
      expect(box, `${sel} has no box`).not.toBeNull();
      expect(box.height, `${sel} is too short to tap`).toBeGreaterThanOrEqual(38);
      const cw = await page.evaluate(() => document.documentElement.clientWidth);
      expect(box.x + box.width, `${sel} runs off the right edge`).toBeLessThanOrEqual(cw + 1);
    }
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw, "the page scrolls sideways").toBeLessThanOrEqual(cw + 1);
  });

  test("the two pickers are labelled so it is clear which one survives", async ({ page }) => {
    // Getting these the wrong way round is the one mistake here that loses the wrong player's id,
    // so the labels do real work.
    await merge(page);
    await expect(page.locator('label[for="keep"]')).toContainText(/keep/i);
    await expect(page.locator('label[for="from"]')).toContainText(/fold this one into them/i);
  });

  test("the page logs no console error", async ({ page }) => {
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
    history = [{ id: 3, at: Date.now(), keep_visitor: "v-a", from_visitor: "v-b", rows: 4, renamed: "jayden", by_who: "admin", undone_at: null }];
    await merge(page);
    expect(errs).toEqual([]);
  });

  test("with no visitors yet the form is present but unusable, rather than misleading", async ({ page }) => {
    people = [];
    await merge(page);
    await expect(page.locator("#mf button")).toBeDisabled();
    await expect(page.getByText("No merges yet")).toBeVisible();
  });
});

// Merging by NAME is the picker an owner reaches for, because the duplicate they see is two names on
// a board. It carries a risk the visitor picker does not: a name is not an identity, so one name can
// cover several browsers, and nothing in the data says whether that is one person on three devices
// or three people who picked the same word. The form's whole job is to make that visible before the
// click, which is behaviour only a browser can check.
test.describe("the merge-by-name form", () => {
  test("the button is dead until two different names are picked", async ({ page }) => {
    await merge(page);
    const btn = page.locator("#nf button");
    await expect(btn).toBeDisabled();
    await page.selectOption("#keepName", "jayden");
    await expect(btn).toBeDisabled();
    await page.selectOption("#fromName", "Jayden");
    await expect(btn).toBeEnabled();
  });

  test("case-different names are two options, and merging them is allowed", async ({ page }) => {
    // This is the commonest duplicate there is. A form that treated them as "the same name" would
    // refuse exactly the case it exists for.
    accept(page);
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "Jayden");
    await expect(page.locator("#nf button")).toBeEnabled();
    await page.locator("#nf button").click();
    await page.waitForURL(/done=merged-names/);
    expect(nameMerges[0]).toMatchObject({ keepName: "jayden", fromName: "Jayden" });
  });

  test("the identical name on both sides says so instead of merging", async ({ page }) => {
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "jayden");
    const btn = page.locator("#nf button");
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveText("Pick two different names");
    await page.selectOption("#fromName", "Jayden");
    await expect(btn).toBeEnabled();
  });

  test("two single-browser names carry no warning", async ({ page }) => {
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "Jayden");
    await expect(page.locator("#nwarn")).toBeHidden();
  });

  test("a name covering several browsers warns before the click, with the count", async ({ page }) => {
    // "diddy kong" spans 3 browsers, so this merge fuses 4 identities. If any of them is somebody
    // else, their scores merge too — and that is unrecoverable except through the put-back.
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "diddy kong");
    const warn = page.locator("#nwarn");
    await expect(warn).toBeVisible();
    await expect(warn).toContainText("4 browsers");
    await expect(warn).toContainText(/if any of them is somebody else/i);
  });

  test("the warning clears again when the risky name is deselected", async ({ page }) => {
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "diddy kong");
    await expect(page.locator("#nwarn")).toBeVisible();
    await page.selectOption("#fromName", "Jayden");
    await expect(page.locator("#nwarn")).toBeHidden();
  });

  test("the confirm repeats the browser count when there is one to repeat", async ({ page }) => {
    const asked = [];
    page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "diddy kong");
    await page.locator("#nf button").click();
    await page.waitForURL(/done=merged-names/);
    expect(asked[0]).toContain("jayden");
    expect(asked[0]).toContain("diddy kong");
    expect(asked[0]).toContain("4 different browsers");
  });

  test("cancelling the confirm merges nothing", async ({ page }) => {
    page.on("dialog", (d) => d.dismiss());
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "Jayden");
    await page.locator("#nf button").click();
    await page.waitForTimeout(200);
    expect(nameMerges).toEqual([]);
    expect(page.url()).not.toContain("done=");
  });

  test("the outcome is reported, and distinguishes itself from a by-player merge", async ({ page }) => {
    accept(page);
    result = { ok: true, rows: 9 };
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "Jayden");
    await page.locator("#nf button").click();
    await page.waitForURL(/done=merged-names/);
    await expect(page.getByText("9 entries now belong to one player under one name")).toBeVisible();
  });

  test("a refused name merge names the right picker", async ({ page }) => {
    accept(page);
    result = { ok: false, reason: "same", rows: 0 };
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "Jayden");
    await page.locator("#nf button").click();
    await page.waitForURL(/done=same-name/);
    await expect(page.getByText(/same name/i)).toBeVisible();
  });

  test("the two forms are independent — using one leaves the other alone", async ({ page }) => {
    accept(page);
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "Jayden");
    await page.locator("#nf button").click();
    await page.waitForURL(/done=merged-names/);
    expect(merges, "the by-player merge must not have fired").toEqual([]);
    expect(nameMerges).toHaveLength(1);
  });

  test("both forms fit the viewport, with tappable controls", async ({ page }) => {
    await merge(page);
    for (const sel of ["#keepName", "#fromName", "#nf button", "#keep", "#from", "#mf button"]) {
      const box = await page.locator(sel).boundingBox();
      expect(box, `${sel} has no box`).not.toBeNull();
      expect(box.height, `${sel} is too short to tap`).toBeGreaterThanOrEqual(38);
    }
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(sw, "the page scrolls sideways").toBeLessThanOrEqual(cw + 1);
  });

  test("a name merge shows up in the history as a name merge, and can be put back", async ({ page }) => {
    history = [{ id: 4, at: Date.now(), kind: "name", keep_visitor: "v-a", from_visitor: null, keep_label: "jayden", from_label: "Jayden", rows: 9, renamed: "jayden", by_who: "admin", undone_at: null }];
    result = { ok: true, rows: 9 };
    page.on("dialog", (d) => d.accept());
    await merge(page);
    await expect(page.getByText("name").first()).toBeVisible();
    await page.locator("a.rn").first().click();
    await page.waitForURL(/done=undone/);
    expect(undos).toEqual([{ id: "4", by: "admin" }]);
  });

  test("the page logs no console error with both forms on it", async ({ page }) => {
    const errs = [];
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
    history = [{ id: 4, at: Date.now(), kind: "name", keep_visitor: "v-a", from_visitor: null, keep_label: "jayden", from_label: "Jayden", rows: 9, renamed: "jayden", by_who: "admin", undone_at: null }];
    await merge(page);
    await page.selectOption("#keepName", "jayden");
    await page.selectOption("#fromName", "diddy kong");
    expect(errs).toEqual([]);
  });

  test("with no names yet the form is present but unusable", async ({ page }) => {
    names = [];
    await merge(page);
    await expect(page.locator("#nf button")).toBeDisabled();
  });
});
