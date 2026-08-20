"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createAdminRouter } = require("../routes/admin.js");
const analytics = require("../server/stats.js"); // the same module object admin.js holds — patchable per test

process.env.OWNER_KEY = "test-owner-key";

// The lockdown and end-all-games routes narrate themselves to stdout ("🔒 LOCKDOWN ON — new games
// blocked"), and stats.js announces itself on load. Interleaved with the test runner's own
// serialized IPC stream that is enough to corrupt it, which surfaces as this whole FILE failing
// with no failing test inside it — the same trap test/rooms.test.js documents. Errors still go to
// console.error, so a real problem is never swallowed.
let realLog;
before(() => { realLog = console.log; console.log = () => {}; });
after(() => { console.log = realLog; });

// analytics.enabled() is false throughout (no TURSO_URL in the test environment) — these tests
// cover routing + owner-key auth gating, not the Turso-backed report content.
function buildApp({ lockdown = false } = {}) {
  let lockdownFlag = lockdown;
  const rooms = new Map();
  const deps = {
    io: { sockets: { sockets: new Map() }, emit: () => {} },
    costGuard: { getState: () => ({ coldTripped: false, hardTripped: false, coldError: null, costOverrideMonth: null }) },
    rooms,
    stats: { roomsCreated: 0, gamesStarted: 0, peakRooms: 0 },
    serverStartedAt: Date.now(),
    getOnline: () => 0,
    isLockdown: () => lockdownFlag,
    setLockdown: (v) => { lockdownFlag = v; },
    closeRoom: () => false,
    closeAllRooms: () => 0,
  };
  const app = express();
  app.use(createAdminRouter(deps));
  return { app, rooms };
}

describe("routes/admin.js — owner-key auth gate", () => {
  // Referral tracking added no route of its own on purpose (it rides the clientMeta socket emit
  // instead of an unauthenticated analytics POST), so this list is still the complete surface.
  test("every /admin* route 404s with no key", async () => {
    const { app } = buildApp();
    for (const path of ["/admin", "/admin/ping", "/admin/health", "/admin/games", "/admin/chat", "/admin/visitors",
      "/admin/sessions", "/admin/leaderboards", "/admin/category-leaderboards", "/admin/runs"]) {
      const res = await request(app).get(path);
      assert.equal(res.status, 404, path);
    }
  });

  test("every /admin* route 404s with the wrong key", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=nope");
    assert.equal(res.status, 404);
  });

  test("the dashboard renders for the correct key", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=test-owner-key");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
  });

  test("?json=1 returns machine-readable state instead of HTML", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=test-owner-key&json=1");
    assert.equal(res.status, 200);
    assert.equal(res.body.online, 0);
    assert.equal(res.body.roomCount, 0);
  });

  test("GET /admin/ping is a cheap, owner-gated round-trip target for the client-side connection check", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/admin/ping?key=test-owner-key");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.now, "number");
  });

  test("?json=1 reports DB and cost-guard health even with persistence off", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=test-owner-key&json=1");
    assert.equal(res.body.db.configured, false);
    assert.equal(res.body.db.ok, false);
    assert.equal(res.body.costGuard.hardTripped, false);
    assert.equal(res.body.lockdown, false);
  });

  test("the HTML dashboard's site-health panel reflects a cost-cap pause", async () => {
    const rooms = new Map();
    const deps = {
      io: { sockets: { sockets: new Map() }, emit: () => {} },
      costGuard: { getState: () => ({ coldTripped: false, hardTripped: true, coldError: null, costOverrideMonth: null }) },
      rooms, stats: { roomsCreated: 0, gamesStarted: 0, peakRooms: 0 }, serverStartedAt: Date.now(),
      getOnline: () => 0, isLockdown: () => false, setLockdown: () => {}, closeRoom: () => false, closeAllRooms: () => 0,
    };
    const app = express();
    app.use(createAdminRouter(deps));
    const res = await request(app).get("/admin?key=test-owner-key");
    assert.match(res.text, /PAUSED \(cost cap\)/);
  });
});

describe("routes/admin.js — server controls", () => {
  test("lockdown toggles and is reflected on the dashboard", async () => {
    const { app } = buildApp();
    const on = await request(app).get("/admin/lockdown?key=test-owner-key&on=1");
    assert.equal(on.status, 302);
    const dash = await request(app).get("/admin?key=test-owner-key");
    assert.match(dash.text, /MAINTENANCE MODE/);
  });

  test("killall and announce redirect back to the dashboard", async () => {
    const { app } = buildApp();
    const killall = await request(app).get("/admin/killall?key=test-owner-key");
    assert.equal(killall.status, 302);
    assert.match(killall.headers.location, /^\/admin\?key=/);
    const announce = await request(app).get("/admin/announce?key=test-owner-key&msg=hello");
    assert.equal(announce.status, 302);
  });
});

describe("routes/admin.js — gamePeek rendering", () => {
  // Regression test: game-engine.js's g.granted holds {id,text,q} objects (so a specific grant
  // can be revoked — see handleRevokeGrant), not bare strings. The dashboard must render the
  // text, not "[object Object]".
  test("a duel room's granted off-list answers render as readable text, not [object Object]", async () => {
    const { app, rooms } = buildApp();
    rooms.set("ABCD", {
      code: "ABCD", status: "started", createdAt: Date.now(), lastActivityAt: Date.now(),
      players: new Map([["p1", { id: "p1", name: "Alice", connected: true }], ["p2", { id: "p2", name: "Bob", connected: true }]]),
      spectators: new Map(),
      game: {
        phase: "proving", round: 1, current: { name: "Test Cat", group: "Testing", entries: [] },
        order: ["p1", "p2"], names: { p1: "Alice", p2: "Bob" },
        claim: 5, target: 5, turnId: "p1", scores: { p1: 0, p2: 0 },
        proven: [], granted: [{ id: 1, text: "Nowray", q: "nowray" }], pending: new Map(),
        paused: false, intermission: false,
      },
    });
    const dash = await request(app).get("/admin?key=test-owner-key");
    assert.equal(dash.status, 200);
    assert.match(dash.text, /Granted off-list: Nowray/);
    assert.equal(dash.text.includes("[object Object]"), false);
  });
});

// The referral panel ("🌐 Where visitors come from") is the only part of the dashboard fed by a
// column that didn't exist for most of the sessions table's life, so it gets rendered three ways:
// no persistence at all (the CI/fork default), persistence on but the query returning nothing, and
// real rows. summary() is stubbed on the stats module object — admin.js requires it directly rather
// than taking it as a dependency, and it looks each function up at call time.
describe("routes/admin.js — referral sources panel", () => {
  // histHtml() reads several of these unguarded, so a stub has to be summary()-shaped, not minimal.
  const emptyHistory = () => ({
    games: 0, rounds: 0, avgDurationMs: 0, players: 0,
    categories: [], perDay: [], startedTimes: [], reasons: [], features: [], topAnswers: [], namedPerCat: [],
    superlatives: { longestGame: null, mostRounds: null, highestClaim: null, easterEggs: 0 },
    recent: [], skips: [], sessions: {}, solo: {}, daily: {}, sp: {},
  });
  let realEnabled, realSummary;
  before(() => { realEnabled = analytics.enabled; realSummary = analytics.summary; });
  after(() => { analytics.enabled = realEnabled; analytics.summary = realSummary; });
  const withHistory = (history) => { analytics.enabled = () => true; analytics.summary = async () => history; };

  test("no persistence configured: the dashboard still renders and just says history is off", async () => {
    analytics.enabled = realEnabled; analytics.summary = realSummary;
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=test-owner-key");
    assert.equal(res.status, 200);
    assert.match(res.text, /Historical stats off/);
    assert.equal(res.text.includes("Where visitors come from"), false);
  });

  test("persistence on but no referral data: the panel renders empty instead of throwing", async () => {
    // `referrals` is absent from the object entirely — exactly what an older summary() or a failed
    // sub-query looks like, and the case `(h.referrals || [])` exists for.
    withHistory(emptyHistory());
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=test-owner-key");
    assert.equal(res.status, 200);
    assert.match(res.text, /Where visitors come from/);
    withHistory({ ...emptyHistory(), referrals: [] });
    const res2 = await request(app).get("/admin?key=test-owner-key");
    assert.equal(res2.status, 200);
    assert.match(res2.text, /Where visitors come from/);
  });

  test("channels render with sessions, visitors and a played conversion rate", async () => {
    // BigInt-ish counts are what libSQL actually hands back, so the stub uses them: Number()-ing
    // them is why histHtml has its local num() helper.
    withHistory({ ...emptyHistory(), referrals: [
      { source: "reddit", n: 10n, visitors: 8n, played: 5n },
      { source: "direct", n: 4n, visitors: 4n, played: 0n },
    ] });
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=test-owner-key");
    assert.equal(res.status, 200);
    assert.match(res.text, /<td>reddit<\/td>/);
    assert.match(res.text, /<td>direct<\/td>/);
    assert.match(res.text, /5 <span style="color:#8a92a6">\(50%\)<\/span>/); // 5 of 10 reddit sessions played
    assert.match(res.text, /0 <span style="color:#8a92a6">\(0%\)<\/span>/);
  });

  test("a zero-session row can't divide by zero, and a hostile channel label is escaped", async () => {
    withHistory({ ...emptyHistory(), referrals: [
      { source: "<script>alert(1)</script>", n: 0, visitors: 0, played: 0 },
      { source: null, n: null, visitors: null, played: null },
    ] });
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=test-owner-key");
    assert.equal(res.status, 200);
    assert.equal(res.text.includes("<script>alert(1)</script>"), false);
    assert.match(res.text, /&lt;script&gt;/);
    assert.equal(/NaN|Infinity/.test(res.text), false);
  });

  test("?json=1 exposes the same referral rows for ad-hoc digging", async () => {
    withHistory({ ...emptyHistory(), referrals: [{ source: "hackernews", n: 3, visitors: 3, played: 2 }] });
    const { app } = buildApp();
    const res = await request(app).get("/admin?key=test-owner-key&json=1");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.history.referrals, [{ source: "hackernews", n: 3, visitors: 3, played: 2 }]);
  });
});

describe("routes/admin.js — category health", () => {
  test("lists categories with no persistence configured", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/admin/health?key=test-owner-key");
    assert.equal(res.status, 200);
    assert.match(res.text, /Persistence not configured/);
  });
});
