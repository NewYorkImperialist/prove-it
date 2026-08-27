"use strict";
// The admin gate had no limit on wrong guesses at all. Twenty-three routes called ownerOk(), a wrong
// key cost the caller one 404, and nothing counted, slowed or recorded it.
//
// That is bad anywhere and worse here, because the repo is public: an attacker reads exactly how the
// check works, what header it accepts, and that nothing is watching — and can then guess as fast as
// the network allows, indefinitely, in silence.
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { ownerOk, adminAuthFailures, resetAdminThrottle, FAIL_MAX } = require("../lib/owner-auth.js");

// A request as Express hands it over: query, plus get() for headers.
const req = (key, ip = "1.2.3.4", header) => ({
  query: key === undefined ? {} : { key },
  ip,
  get: (h) => (h === "fly-client-ip" ? ip : h === "x-owner-key" ? header : undefined),
});

let saved;
beforeEach(() => { saved = process.env.OWNER_KEY; process.env.OWNER_KEY = "the-real-key"; resetAdminThrottle(); });
afterEach(() => { if (saved === undefined) delete process.env.OWNER_KEY; else process.env.OWNER_KEY = saved; resetAdminThrottle(); });

describe("lib/owner-auth.js — guessing the admin key is throttled", () => {
  test("a run of wrong guesses is cut off", async () => {
    for (let i = 0; i < FAIL_MAX; i++) assert.equal(ownerOk(req(`guess-${i}`)), false, `guess ${i}`);
    // Past the budget the gate stops even considering the key.
    assert.equal(ownerOk(req("guess-again")), false);
    assert.equal(adminAuthFailures().blockedNow, 1);
  });

  test("and the REAL key is refused too once the budget is spent — no free retry after a run", async () => {
    // If a blocked caller could still get in by finally guessing right, the throttle would only be
    // slowing the guessing down by nothing at all.
    for (let i = 0; i <= FAIL_MAX; i++) ownerOk(req(`guess-${i}`));
    assert.equal(ownerOk(req("the-real-key")), false, "blocked means blocked, for the window");
  });

  test("the block is per address, so nobody can lock the owner out of their own dashboard", async () => {
    // A global counter would turn "someone guessed wrong eight times" into a denial of service
    // against the one person who needs the page.
    for (let i = 0; i <= FAIL_MAX; i++) ownerOk(req(`guess-${i}`, "9.9.9.9"));
    assert.equal(ownerOk(req("the-real-key", "1.2.3.4")), true, "a different caller is unaffected");
  });

  test("getting it right clears the counter, so a typo doesn't leave the owner near a block", async () => {
    for (let i = 0; i < FAIL_MAX - 1; i++) ownerOk(req("wrong", "5.5.5.5"));
    assert.equal(ownerOk(req("the-real-key", "5.5.5.5")), true);
    // The budget is full again.
    for (let i = 0; i < FAIL_MAX - 1; i++) assert.equal(ownerOk(req("wrong", "5.5.5.5")), false);
    assert.equal(ownerOk(req("the-real-key", "5.5.5.5")), true);
  });

  test("a blocked caller is told nothing — same false as a wrong key", async () => {
    // Every route turns this into the same 404. Anything that distinguished "throttled" from "wrong"
    // would confirm the path exists and that the key matters, which is what the 404 exists to hide.
    for (let i = 0; i <= FAIL_MAX; i++) ownerOk(req("wrong", "7.7.7.7"));
    assert.equal(ownerOk(req("wrong", "7.7.7.7")), false);
    assert.equal(ownerOk(req("also-wrong", "7.7.7.7")), false);
  });

  test("the header route into the gate is throttled too, not just ?key=", async () => {
    for (let i = 0; i <= FAIL_MAX; i++) ownerOk(req(undefined, "8.8.8.8", `guess-${i}`));
    assert.equal(ownerOk(req(undefined, "8.8.8.8", "the-real-key")), false);
  });

  test("attempts are recorded, so a guessing run is visible and not merely blocked", async () => {
    // A quiet block is still an incident nobody hears about.
    for (let i = 0; i < 3; i++) ownerOk(req("wrong", "4.4.4.4"));
    const f = adminAuthFailures();
    assert.equal(f.total, 3);
    assert.equal(f.recent.length, 3);
    assert.equal(f.recent[0].ip, "4.4.4.4");
    assert.equal(typeof f.recent[0].at, "number");
    assert.equal(f.max, FAIL_MAX);
  });

  test("a successful sign-in is not logged as an attempt", async () => {
    ownerOk(req("the-real-key"));
    assert.equal(adminAuthFailures().total, 0);
  });

  test("the report hands out copies, not the live log", async () => {
    ownerOk(req("wrong"));
    const a = adminAuthFailures();
    a.recent[0].ip = "mutated";
    assert.equal(adminAuthFailures().recent[0].ip, "1.2.3.4");
  });

  test("the log is bounded, so a long guessing run can't grow memory without limit", async () => {
    for (let i = 0; i < 500; i++) ownerOk(req("wrong", `10.0.0.${i % 250}`));
    const f = adminAuthFailures(1000);
    assert.ok(f.recent.length <= 200, `kept ${f.recent.length}`);
  });

  test("with no OWNER_KEY set, nothing opens and attempts still count", async () => {
    delete process.env.OWNER_KEY;
    assert.equal(ownerOk(req("")), false);
    assert.equal(ownerOk(req("anything")), false);
    assert.ok(adminAuthFailures().total >= 2);
  });
});

describe("the throttle is inside the gate, not bolted onto one router", () => {
  const fs = require("fs");
  const path = require("path");
  const ROOT = path.join(__dirname, "..");

  // Two gates now. ownerOk is the key check every admin surface shares; ownerAction is ownerOk plus
  // "does this request look like a person clicking a link", and only the routes that CHANGE
  // something use it. Both run the same throttled comparison, so either satisfies this test's
  // original question — that no admin route can be added without one.
  const GATE = /owner(Ok\(req\)|Action\(req, res\))/g;

  test("every admin surface funnels through the key check, so none of them can miss it", () => {
    // Express routes, the Next pages' guard, and cost-override — which is registered in
    // server/index.js OUTSIDE the admin router and would have been the one a middleware-based
    // throttle forgot.
    assert.match(fs.readFileSync(path.join(ROOT, "app/admin/guard.js"), "utf8"), /ownerOk/);
    assert.match(fs.readFileSync(path.join(ROOT, "lib/cost-guard.js"), "utf8"), GATE);
    const admin = fs.readFileSync(path.join(ROOT, "routes/admin.js"), "utf8");
    const routes = [...admin.matchAll(/router\.get\("(\/admin[^"]*)"/g)].map((m) => m[1]);
    assert.ok(routes.length > 15, `expected the full admin surface, found ${routes.length}`);
    const gates = (admin.match(GATE) || []).length;
    assert.ok(gates >= routes.length, `${routes.length} routes but only ${gates} gate calls`);
  });

  // The dashboard's write actions are plain links, so they are GET routes — and Express answers
  // HEAD on a GET route by running the handler and discarding the body. `curl -I /admin/killall`
  // therefore ended every live game. Same shape for anything that merely FETCHES a keyed URL: a
  // chat app unfurling a pasted dashboard link, a browser prefetching, a scanner following a
  // redirect. ownerAction refuses all of those; ownerOk alone does not.
  test("every route that changes something uses the stricter gate", () => {
    const admin = fs.readFileSync(path.join(ROOT, "routes/admin.js"), "utf8");
    const WRITES = ["result-delete", "result-rename", "merge-do", "merge-names", "merge-undo",
      "crown-visitor", "close", "killall", "lockdown", "announce"];
    for (const name of WRITES) {
      const at = admin.indexOf(`router.get("/admin/${name}"`);
      assert.notEqual(at, -1, `no route for /admin/${name}`);
      const head = admin.slice(at, at + 220);
      assert.match(head, /ownerAction\(req, res\)/, `/admin/${name} must use the write gate`);
    }
    // …and cost-override, which lives outside this router entirely.
    assert.match(fs.readFileSync(path.join(ROOT, "lib/cost-guard.js"), "utf8"), /ownerAction\(req, res\)/);
  });

  test("the write gate refuses HEAD, prefetches and non-navigations", () => {
    const { ownerAction } = require("../lib/owner-auth.js");
    const saved = process.env.OWNER_KEY;
    process.env.OWNER_KEY = "admin-secret";
    const call = (method, headers = {}) => {
      resetAdminThrottle();
      const sent = {};
      const res = { status(c) { sent.code = c; return this; }, send(b) { sent.body = b; return this; } };
      const req = { method, path: "/admin/killall", query: { key: "admin-secret" },
        get: (h) => headers[h.toLowerCase()] };
      return { allowed: ownerAction(req, res), sent };
    };
    try {
      assert.equal(call("GET").allowed, true, "a plain link click still works");
      assert.equal(call("GET", { "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" }).allowed, true);
      assert.equal(call("HEAD").allowed, false, "curl -I must not fire the kill switch");
      assert.equal(call("GET", { "sec-purpose": "prefetch;prerender" }).allowed, false);
      assert.equal(call("GET", { purpose: "prefetch" }).allowed, false);
      assert.equal(call("GET", { "x-purpose": "preview" }).allowed, false);
      assert.equal(call("GET", { "sec-fetch-mode": "no-cors" }).allowed, false, "an unfurler fetch");
      assert.equal(call("GET", { "sec-fetch-mode": "cors" }).allowed, false);
      assert.equal(call("GET", { "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" }).allowed, false);
      // A wrong key is still a 404, never a 405 — the refusal must not confirm the path exists.
      resetAdminThrottle();
      const sent = {};
      const res = { status(c) { sent.code = c; return this; }, send(b) { sent.body = b; return this; } };
      assert.equal(ownerAction({ method: "GET", path: "/admin/killall", query: { key: "nope" }, get: () => undefined }, res), false);
      assert.equal(sent.code, 404);
    } finally {
      if (saved === undefined) delete process.env.OWNER_KEY; else process.env.OWNER_KEY = saved;
      resetAdminThrottle();
    }
  });

  test("one notion of the caller is shared with the write limiter", () => {
    // Two different ideas of "the same caller" would mean a limit that looks enforced and isn't.
    for (const f of ["lib/owner-auth.js", "routes/challenge.js"]) {
      assert.match(fs.readFileSync(path.join(ROOT, f), "utf8"), /require\(".*caller-ip\.js"\)/, f);
    }
  });
});
