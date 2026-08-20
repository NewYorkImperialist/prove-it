"use strict";
// The adaptive share button, on every surface that has one. It is ONE control that changes what
// it does: an OS share sheet where the browser has one (phones, Safari), the clipboard where it
// doesn't. Three things here can only be seen in a real browser, and all three were wrong or
// impossible before:
//   • what the sheet is actually handed — the link belongs in `url`, and a payload that also ends
//     with the link makes the platform post the URL twice;
//   • what cancelling the sheet does — an AbortError is a decision, not a failure, so the button
//     has to go back to resting with no confirmation and no error;
//   • what a refused clipboard says — useCopied threw copyText's boolean away, so a locked-down
//     browser told the player the link was on their clipboard when nothing was.
//
// This file is the first in the repo to stub a browser API. It's done with page.addInitScript, so
// navigator.share exists (or doesn't) before the app's first paint — the labels are decided in a
// mount effect, and seeding after load would race it. Shares and clipboard writes are recorded
// onto window.__shared / window.__copied and read back with page.evaluate.
//
// The two solo screens that carry the same button (ReadySection, DoneSection) are NOT here: both
// sit behind a created run, and there is no database in CI, so /challenge and /daily both fail
// before either screen can be reached. Their share payloads come from lib/browser/daily.js and
// the hook, which are covered by test/share.test.js and by the two surfaces below.
const { test, expect } = require("@playwright/test");
const { todayEastern } = require("../lib/format.js");

// Every label the button can show, so a rename can't quietly leave a test passing against copy
// nobody sees any more.
const LB_REST = "Share your score & invite friends";
const LB_COPIED = "Copied — send it to a friend!";
const LB_SHARED = "Shared!";
const LB_FAILED = /Couldn't copy your invite/;
const INVITE_SHARE = "Share invite link";
const INVITE_COPY = "Copy invite link";
const INVITE_SHARED = "✓ Invite sent!";
const INVITE_COPIED = "✓ Invite link copied!";
const INVITE_FAILED = /Couldn't copy the link/;
const CODE_REST = "tap the code to copy";
const CODE_COPIED = "✓ Code copied!";
const CODE_FAILED = /couldn't copy/;

// One locator per control that matches it in every state it can be in, so a test can watch a
// label change rather than losing track of the element when it does.
const anyOf = (...labels) => new RegExp(labels.map((l) => (l instanceof RegExp ? l.source : l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("|"));
const shareButton = (page) => page.getByRole("button", { name: anyOf(LB_REST, LB_COPIED, LB_SHARED) });
const inviteButton = (page) => page.getByRole("button", { name: /invite/i });
const roomCode = (page) => page.locator("div[title='Click to copy']");
const codeHint = (page) => page.getByText(anyOf(CODE_REST, CODE_COPIED, CODE_FAILED));

const shared = (page) => page.evaluate(() => window.__shared);
const copied = (page) => page.evaluate(() => window.__copied);

// `share`: "ok" | "abort" | "none" — a sheet that accepts, one the player backs out of, or a
// browser with no sheet at all (which is what desktop Chrome and Firefox really are).
// `clipboard`: "ok" | "blocked" — blocked has to refuse BOTH paths in lib/browser/clipboard.js,
// the async API and the execCommand fallback, and the fallback only reports failure by throwing.
async function seed(page, { daily = null, share = "none", clipboard = "ok" } = {}) {
  await page.addInitScript(
    ([daily, share, clipboard]) => {
      try {
        if (daily) {
          window.localStorage.setItem("daily_last", daily.date);
          window.localStorage.setItem("daily_score", daily.score);
        } else {
          window.localStorage.removeItem("daily_last");
          window.localStorage.removeItem("daily_score");
        }
      } catch { /* private mode — the app copes, so the test should too */ }

      window.__shared = [];
      window.__copied = [];
      if (share === "none") {
        delete navigator.share;
        delete navigator.canShare;
      } else {
        navigator.share = (data) => {
          window.__shared.push(data);
          if (share !== "abort") return Promise.resolve();
          const err = new Error("cancelled");
          err.name = "AbortError"; // exactly what a real sheet rejects with on dismissal
          return Promise.reject(err);
        };
        navigator.canShare = () => true;
      }

      const writeText = (str) => {
        if (clipboard === "blocked") return Promise.reject(new Error("blocked by policy"));
        window.__copied.push(str);
        return Promise.resolve();
      };
      try {
        Object.defineProperty(navigator, "clipboard", { configurable: true, get: () => ({ writeText }) });
      } catch { /* if it can't be replaced the assertions on __copied will say so */ }
      if (clipboard === "blocked") {
        document.execCommand = () => { throw new Error("blocked by policy"); };
      }
    },
    [daily, share, clipboard],
  );
}

// React's handlers are not attached when the server HTML first paints, and on the first page load
// of a run that gap is wide enough to swallow a whole click: the menu button is right there and
// pressing it does nothing. The connection dot only reaches "connected" from a mount effect, so
// it is proof the client is live — and the multiplayer flow below needs that socket anyway.
const ready = (page) => expect(page.getByText(/\bconnected\b/).first()).toBeVisible();

// The laurel modal's share button only exists on the Daily tab once you've played today, which
// is a localStorage fact (daily_last / daily_score) — no run and no database needed.
async function openLeaderboard(page, opts = {}) {
  await seed(page, { daily: { date: todayEastern(), score: "42" }, ...opts });
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Leaderboards" }).click();
  await expect(shareButton(page)).toBeVisible();
}

async function openWaitingRoom(page, opts = {}) {
  await seed(page, opts);
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: /Live Multiplayer/ }).click();
  await page.locator("#mpName").fill("Tester");
  await page.getByRole("button", { name: "Create a room" }).click();
  await expect(page.getByText("Waiting room")).toBeVisible();
}

test.describe("sharing your daily score from the laurel modal", () => {
  test("the sheet gets a title, a message and the link as three separate fields", async ({ page }) => {
    await openLeaderboard(page, { share: "ok" });
    await shareButton(page).click();
    const calls = await shared(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("Prove It!");
    expect(calls[0].text).toContain("I named 42");
    // The whole reason dailyInvite was split: a sheet handed the URL inside `text` as well as in
    // `url` posts the link twice, once in the message and once appended by the platform.
    expect(calls[0].text).not.toContain("http");
    expect(calls[0].url).toMatch(/\/challenge\.html\?id=d-\d{8}$/);
    await expect(shareButton(page)).toHaveText(LB_SHARED);
  });

  test("a share is never confirmed as a copy — nothing went on the clipboard", async ({ page }) => {
    await openLeaderboard(page, { share: "ok" });
    await shareButton(page).click();
    await expect(shareButton(page)).toHaveText(LB_SHARED);
    expect(await copied(page)).toEqual([]);
  });

  test("backing out of the sheet leaves the button resting, with no error and no sneaky copy", async ({ page }) => {
    await openLeaderboard(page, { share: "abort" });
    await shareButton(page).click();
    expect(await shared(page)).toHaveLength(1); // the sheet did open
    await expect(shareButton(page)).toHaveText(LB_REST);
    await expect(page.getByText(LB_FAILED)).toHaveCount(0);
    // Falling back to the clipboard here would be second-guessing a decision the player made.
    expect(await copied(page)).toEqual([]);
  });

  test("with no share sheet the button copies one pasteable string, link and all", async ({ page }) => {
    await openLeaderboard(page, { share: "none" });
    await shareButton(page).click();
    await expect(shareButton(page)).toHaveText(LB_COPIED);
    expect(await shared(page)).toEqual([]);
    // Pasted into a chat there is no `url` field to fall back on, so this one string has to carry
    // the link — and a label for it, or the message is a bare URL.
    const [text] = await copied(page);
    expect(text).toMatch(/I named 42 .*Think you can beat me\? Play today's daily: http.*\/challenge\.html\?id=d-\d{8}$/);
  });

  test("a browser that refuses the clipboard says so instead of claiming Copied!", async ({ page }) => {
    // The bug this replaced: copyText's boolean was discarded, so the label flipped to a
    // confirmation regardless and the player pasted nothing into a chat.
    await openLeaderboard(page, { share: "none", clipboard: "blocked" });
    await shareButton(page).click();
    await expect(page.getByText(LB_FAILED)).toBeVisible();
    await expect(shareButton(page)).toHaveText(LB_REST);
    await expect(shareButton(page)).not.toHaveText(LB_COPIED);
  });
});

test.describe("sharing a multiplayer room invite", () => {
  test("the invite says share where there is a sheet, and hands it the link on its own", async ({ page }) => {
    await openWaitingRoom(page, { share: "ok" });
    await expect(inviteButton(page)).toHaveText(INVITE_SHARE);
    await inviteButton(page).click();
    const calls = await shared(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/Join my Prove It! room — code [A-Z0-9]{4}\.$/);
    expect(calls[0].url).toMatch(/\?room=[A-Z0-9]{4}$/);
    await expect(inviteButton(page)).toHaveText(INVITE_SHARED);
  });

  test("without a sheet it stays the copy button it always was, with the bare link", async ({ page }) => {
    await openWaitingRoom(page, { share: "none" });
    await expect(inviteButton(page)).toHaveText(INVITE_COPY);
    await inviteButton(page).click();
    await expect(inviteButton(page)).toHaveText(INVITE_COPIED);
    const [text] = await copied(page);
    expect(text).toMatch(/^http.*\?room=[A-Z0-9]{4}$/);
  });

  test("a refused clipboard points at the code instead of claiming the link is copied", async ({ page }) => {
    await openWaitingRoom(page, { share: "none", clipboard: "blocked" });
    await inviteButton(page).click();
    await expect(page.getByText(INVITE_FAILED)).toBeVisible();
    await expect(inviteButton(page)).toHaveText(INVITE_COPY);
    // The failure line is the one row this screen gains, and only while it has something to say:
    // at 320 it must not push the card sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("tapping the room code never opens a share sheet — four characters are not a payload", async ({ page }) => {
    await openWaitingRoom(page, { share: "ok" });
    await expect(codeHint(page)).toHaveText(CODE_REST);
    await roomCode(page).click();
    await expect(codeHint(page)).toHaveText(CODE_COPIED);
    expect(await shared(page)).toEqual([]); // a sheet was available and deliberately not used
    expect(await copied(page)).toEqual([await roomCode(page).textContent()]);
  });

  test("a refused clipboard doesn't tell you the code is copied either", async ({ page }) => {
    await openWaitingRoom(page, { share: "ok", clipboard: "blocked" });
    await roomCode(page).click();
    await expect(codeHint(page)).toHaveText(CODE_FAILED);
  });
});
