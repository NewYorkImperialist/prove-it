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

// The dashboard installs as its own app, separate from the game. Its manifest can't come from
// app/manifest.js the way the game's does — /admin is Express-rendered, outside the Next app — so
// it's a route, and being a route it needs the same owner gate as everything else here.
describe("routes/admin.js — the installable dashboard", () => {
  const K = "test-owner-key";

  test("the manifest is owner-gated like every other /admin route", async () => {
    const { app } = buildApp();
    assert.equal((await request(app).get("/admin/manifest.webmanifest")).status, 404);
    assert.equal((await request(app).get("/admin/manifest.webmanifest?key=nope")).status, 404);
  });

  test("it describes a separate app from the game, with its own name and icons", async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/admin/manifest.webmanifest?key=${K}`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/manifest\+json/);
    const m = JSON.parse(res.text);
    assert.equal(m.name, "Prove It! Admin");
    assert.equal(m.short_name, "PI Admin");
    assert.equal(m.display, "standalone");
    assert.equal(m.scope, "/admin");
    // Every icon is an admin-* variant: pointing at the game's icons would put two identical
    // tiles on the home screen, which is the whole reason the dev stripe exists.
    assert.ok(m.icons.length >= 4);
    for (const i of m.icons) assert.match(i.src, /^\/admin-icon-/, i.src);
    // Android won't offer to install without a 512 maskable; a themed home screen needs the
    // monochrome layer or the tile ignores the user's wallpaper setting.
    const purposes = m.icons.map((i) => i.purpose);
    assert.ok(purposes.includes("maskable"), "needs a maskable icon");
    assert.ok(purposes.includes("monochrome"), "needs a monochrome icon");
  });

  test("start_url carries the owner key, or the installed app would launch into a 404", async () => {
    const { app } = buildApp();
    const m = JSON.parse((await request(app).get(`/admin/manifest.webmanifest?key=${K}`)).text);
    assert.equal(m.start_url, `/admin?key=${K}`);
    // …which is exactly why it must never be cached anywhere shared.
    const res = await request(app).get(`/admin/manifest.webmanifest?key=${K}`);
    assert.match(res.headers["cache-control"], /no-store/);
    assert.match(res.headers["cache-control"], /private/);
  });

  test("id is pinned, so rotating the owner key doesn't orphan the installed app", async () => {
    // Without an explicit id a browser derives app identity from start_url — which carries the
    // key — so changing the key would silently install a second copy alongside the first.
    const { app } = buildApp();
    const m = JSON.parse((await request(app).get(`/admin/manifest.webmanifest?key=${K}`)).text);
    assert.equal(m.id, "/admin");
    assert.equal(m.id.includes(K), false, "the app id must not embed the key");
  });
});

// Every one of these pages used to open straight into <body> with no <head> at all: no charset and
// no viewport meta, so on a phone they rendered at desktop width and had to be pinch-zoomed. They
// share one shell now, and this is the guard that a new page can't go back to hand-rolling it.
describe("routes/admin.js — every page is mobile-ready and installable", () => {
  const K = "test-owner-key";
  const PAGES = ["/admin", "/admin/health", "/admin/games", "/admin/game", "/admin/chat",
    "/admin/visitors", "/admin/sessions", "/admin/leaderboards", "/admin/category-leaderboards",
    "/admin/runs", "/admin/run"];

  test("each page declares the viewport, so none of them render at desktop width on a phone", async () => {
    const { app } = buildApp();
    for (const path of PAGES) {
      const res = await request(app).get(`${path}?key=${K}`);
      assert.equal(res.status, 200, path);
      assert.match(res.text, /<meta name="viewport" content="width=device-width/, path);
      assert.match(res.text, /<meta charset="utf-8">/, path);
    }
  });

  test("each page links the manifest and sets the theme colour, so any of them can be installed", async () => {
    const { app } = buildApp();
    for (const path of PAGES) {
      const res = await request(app).get(`${path}?key=${K}`);
      assert.match(res.text, /<link rel="manifest" href="\/admin\/manifest\.webmanifest\?key=/, path);
      assert.match(res.text, /<meta name="theme-color" content="#0e1016">/, path);
      assert.match(res.text, /apple-touch-icon" href="\/admin-apple-icon\.png"/, path);
      assert.ok(res.text.startsWith("<!doctype html><html lang=\"en\">"), path);
    }
  });

  test("the shared stylesheet clamps the grids, so a 320px phone gets no sideways scroll", async () => {
    // These three grids asked for a 300-340px minimum track, which is wider than a 320px phone's
    // content box — the track overflowed its container and the whole page scrolled sideways.
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}`);
    for (const cls of ["grid", "cols", "cats"]) {
      assert.match(res.text, new RegExp(`\\.${cls}\\{display:grid;[^}]*minmax\\(min\\(`), cls);
    }
  });

  test("the table header sticks on every table page, not just the four that had it", async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/admin/sessions?key=${K}`);
    assert.match(res.text, /th\{[^}]*position:sticky/);
    // Wide tables scroll inside their own box rather than dragging the page's headings off-screen.
    assert.match(res.text, /\.tw\{overflow-x:auto/);
  });

  test("no page leaks an unrendered template reference", async () => {
    const { app } = buildApp();
    for (const path of PAGES) {
      const res = await request(app).get(`${path}?key=${K}`);
      assert.equal(res.text.includes("${"), false, `${path} leaked a template placeholder`);
      assert.equal(res.text.includes("[object Object]"), false, path);
    }
  });
});

// Reachability measured from outside the process (scripts/probe.js writes it; the uptime workflow
// runs it). This is the only panel on the dashboard whose data the server didn't produce, and the
// only one that can describe a stretch when the server wasn't running at all — so the states that
// matter are "nothing has ever probed" versus "a probe says down", which must not look alike.
describe("routes/admin.js — the uptime panel", () => {
  const K = "test-owner-key";
  let realEnabled, realUptime;
  before(() => { realEnabled = analytics.enabled; realUptime = analytics.uptimeStats; });
  after(() => { analytics.enabled = realEnabled; analytics.uptimeStats = realUptime; });
  const withUptime = (up) => { analytics.enabled = () => true; analytics.uptimeStats = async () => up; };

  const probes = (n, ok = true) => Array.from({ length: n }, (_, i) => ({ at: Date.now() - i * 3e5, ok, status: ok ? 200 : 0, ms: 120, err: ok ? null : "timeout" }));
  const shaped = (over = {}) => ({
    last: { at: Date.now() - 6e4, ok: true, status: 200, ms: 120 },
    day: { probes: 24, up: 24, down: 0, pct: 100, avgMs: 118 },
    week: { probes: 168, up: 167, down: 1, pct: 99.4, avgMs: 121 },
    lastFail: null,
    recent: probes(12),
    ...over,
  });

  test("with no persistence the panel is absent rather than empty", async () => {
    analytics.enabled = realEnabled; analytics.uptimeStats = realUptime;
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}`);
    assert.equal(res.status, 200);
    assert.equal(res.text.includes("Uptime (measured from outside)"), false);
  });

  test("nothing probed yet says so — it must not read as an outage", async () => {
    // A red dot here would be a lie: no probe having run is not the same as the site being down,
    // and confusing the two is exactly the kind of thing this dashboard has done before.
    withUptime({ last: null, day: { probes: 0, up: 0, down: 0, pct: null, avgMs: 0 }, week: { probes: 0, up: 0, down: 0, pct: null, avgMs: 0 }, lastFail: null, recent: [] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}`);
    assert.match(res.text, /no probe has recorded anything yet/);
    // Scoped to this panel: the database-health panel above it legitimately shows a red dot in
    // this environment, and asserting against the whole page just catches that instead.
    const i = res.text.indexOf("📡 Uptime");
    const panel = res.text.slice(i, res.text.indexOf("</div>", i));
    assert.equal(panel.includes("UNREACHABLE"), false);
    assert.equal(panel.includes("🔴"), false);
    assert.equal(panel.includes("🟢"), false, "nor should it claim reachable");
  });

  test("a healthy last probe reports reachable, with its latency and age", async () => {
    withUptime(shaped());
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}`);
    assert.match(res.text, /Uptime \(measured from outside\)/);
    assert.match(res.text, /Reachable/);
    assert.match(res.text, /120ms/);
    assert.equal(res.text.includes("UNREACHABLE"), false);
  });

  test("a failed last probe is loud, and the panel turns red", async () => {
    withUptime(shaped({
      last: { at: Date.now() - 6e4, ok: false, status: 0, ms: 15000 },
      day: { probes: 24, up: 20, down: 4, pct: 83.3, avgMs: 400 },
      lastFail: { at: Date.now() - 6e4, status: 0, err: "timeout after 15000ms" },
      recent: probes(6, false),
    }));
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}`);
    assert.match(res.text, /UNREACHABLE/);
    assert.match(res.text, /border-color:#e5484d/, "the panel should read as an alarm");
    assert.match(res.text, /timeout after 15000ms/);
    assert.match(res.text, /4 down/);
  });

  test("counts are reported as probes answered, not as a share of wall-clock time", async () => {
    // A scheduled runner can be late or skipped, so "23/24 probes" is a claim the rows support
    // where "99.6% of the last day" would quietly overstate what was actually measured.
    withUptime(shaped({ day: { probes: 24, up: 23, down: 1, pct: 95.8, avgMs: 130 } }));
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}`);
    assert.match(res.text, /<b>23<\/b>\/24 probes/);
  });

  test("one bar per recorded probe", async () => {
    withUptime(shaped({ recent: probes(9) }));
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}`);
    const strip = res.text.slice(res.text.indexOf('<div class="ups">'));
    assert.equal((strip.slice(0, strip.indexOf("</div>")).match(/<i /g) || []).length, 9);
  });

  test("a hostile error string from the probe row can't inject markup", async () => {
    // err is written by a process outside this app, so it is not trusted input here.
    withUptime(shaped({
      last: { at: Date.now(), ok: false, status: 0, ms: 1 },
      lastFail: { at: Date.now(), status: 0, err: '<script>alert(1)</script>' },
      recent: [{ at: Date.now(), ok: false, status: 0, ms: 1, err: '"><script>alert(2)</script>' }],
    }));
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}`);
    assert.equal(res.text.includes("<script>alert(1)"), false);
    assert.equal(res.text.includes("<script>alert(2)"), false);
    assert.match(res.text, /&lt;script&gt;/);
  });

  test("?json=1 exposes the outside view alongside this process's own uptime", async () => {
    withUptime(shaped());
    const { app } = buildApp();
    const res = await request(app).get(`/admin?key=${K}&json=1`);
    assert.equal(typeof res.body.uptimeMs, "number", "this process's own uptime");
    assert.equal(res.body.uptime.day.probes, 24, "and what an outside prober saw");
  });
});

// The owner key travels in the query string of every dashboard URL, so document.referrer on a
// same-origin navigation out of the dashboard carries it. That is not hypothetical: the dashboard's
// own ghost-watch link opens /?ghost=CODE&key=SECRET, where lib/browser/referrer.js snapshots the
// referrer and it ends up persisted in sessions.referrer — the admin key, in plaintext, in the
// analytics table. These headers are set in server/index.js, so this checks the source rather than
// a live response: the admin router is mounted under that middleware in production.
describe("the admin surface doesn't leak its own key", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");

  test("every /admin response is no-referrer, so the key can't ride out in a referrer", () => {
    assert.match(src, /referrer-policy["']?,\s*["']no-referrer/);
    assert.match(src, /req\.path\.startsWith\(["']\/admin["']\)/);
  });

  test("and is never cached anywhere shared", () => {
    assert.match(src, /cache-control["']?,\s*["']private, no-store/);
  });

  test("the framework isn't advertised", () => {
    assert.match(src, /app\.disable\(["']x-powered-by["']\)/);
  });

  test("nosniff is set for everything, not just /admin", () => {
    const guard = src.slice(src.indexOf("x-content-type-options"));
    const adminOnly = guard.indexOf("startsWith(\"/admin\")");
    const nosniff = src.indexOf("x-content-type-options");
    assert.ok(nosniff < src.indexOf("startsWith(\"/admin\")"), "nosniff must be outside the /admin branch");
    assert.ok(adminOnly > 0);
  });
});
