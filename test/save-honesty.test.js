"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Solo has told the player a run was saved when it wasn't twice now — 0d5d2be fixed the server
// half, 1a96a76 fixed the daily half, and the conflicted merge 5c1a257 silently reverted the
// second one while leaving its producer and that producer's explanatory comment in place.
//
// The screens involved are React with no DOM in this harness, and DoneSection sits behind a
// created run that CI has no database for, so — like test/styles.test.js does for Tailwind
// variants and test/leaderboard.test.js does for the board SQL — these read the sources as text.
// A source guard is a weak test in general, but it is exactly strong enough for the failure that
// actually happens here: someone resolving a conflict drops the branch that reports the error.
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("a failed save is never silent", () => {
  test("submitDailyResult still returns the reason it failed", () => {
    // The producer half. If this stops returning an error, the consumer below has nothing to show.
    const daily = read("lib/browser/daily.js");
    assert.match(daily, /if \(!res\.ok\) return \{ ok: false, error:/,
      "submitDailyResult must report a failed write, not swallow it");
  });

  test("DoneSection's Add me / Update surfaces a failed write", () => {
    // The consumer half, and the one that regressed. The daily is the only mode whose score never
    // goes through useSolo's retry path (finish() returns early for it) and the "couldn't save"
    // banner is gated on !d.daily — so this branch is the ONLY place a daily failure can surface.
    const done = read("components/solo/DoneSection.jsx");
    const addMe = done.slice(done.indexOf("const addMe"), done.indexOf("return (", done.indexOf("const addMe")));
    assert.ok(addMe.includes("res.blocked"), "sanity: found the right function");
    assert.match(addMe, /setNameErr\(res\.error \|\|/,
      "addMe must report a failed submit — without this the button settles back to 'Add me' and " +
      "the streak line goes on claiming the run was banked");
  });

  test("renameRun reads the server's answer instead of always claiming success", () => {
    const solo = read("hooks/useSolo.js");
    // Widened from 900: this reads source rather than behaviour, so any comment added inside the
    // function can push the assertion out of the window and fail a check that is still true.
    const fn = solo.slice(solo.indexOf("const renameRun"), solo.indexOf("const renameRun") + 1600);
    assert.match(fn, /const res = await postJSON\("\/challenge\/rename"/,
      "renameRun must keep the POST result");
    assert.match(fn, /if \(!res\.ok\) return \{ ok: false, error:/,
      "renameRun returned { ok: true } unconditionally, so Update reported success either way");
  });

  test("the server still distinguishes 'no database' from 'the write failed'", () => {
    // 69b2fe3: no persistence configured is not a failed write, or the client's retry loop turns
    // a fork with no database into 15s of retrying and then 'check your connection' every run.
    const ch = read("routes/challenge.js");
    assert.match(ch, /res\.json\(\{ ok: true, stored: false \}\)/);
    assert.match(ch, /res\.status\(503\)\.json\(\{ ok: false, error: "Could not save your run/);
  });
});
