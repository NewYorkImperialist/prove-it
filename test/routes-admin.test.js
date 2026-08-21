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
      "/admin/sessions", "/admin/leaderboards", "/admin/category-leaderboards", "/admin/runs", "/admin/merge",
      // The two that MUTATE a leaderboard entry. They take their arguments in the query string
      // (server/index.js mounts only express.json()), so they are reachable by a plain link —
      // which is exactly why an unkeyed one must not do anything.
      "/admin/result-delete?id=42", "/admin/result-rename?id=42&to=jayden"]) {
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
    "/admin/runs", "/admin/run", "/admin/merge"];

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

// Renaming an entry is the owner's alternative to deleting it — a real score under an unusable name
// shouldn't have to be thrown away to clean up a board. Unlike the player's own rename in
// routes/challenge.js it needs no proof of identity, because it is gated on OWNER_KEY instead; that
// is precisely why the scope it runs at, and the record it leaves, both have to be right.
describe("routes/admin.js — renaming a leaderboard entry", () => {
  const K = "test-owner-key";
  let realEnabled, realRecent, realRename, realAudit;
  before(() => {
    realEnabled = analytics.enabled; realRecent = analytics.recentResults;
    realRename = analytics.adminRename; realAudit = analytics.nameAuditList;
  });
  after(() => {
    analytics.enabled = realEnabled; analytics.recentResults = realRecent;
    analytics.adminRename = realRename; analytics.nameAuditList = realAudit;
  });

  let calls;
  const withData = ({ results = [], audit = [] } = {}) => {
    calls = [];
    analytics.enabled = () => true;
    analytics.recentResults = async () => results;
    analytics.nameAuditList = async () => audit;
    analytics.adminRename = async (args) => { calls.push(args); return { ok: true, rows: 1, from: "old", to: args.name, scope: args.scope }; };
  };
  const entry = (over = {}) => ({ id: 42, challenge_id: "d-20260820", name: "doodooblud", visitor_id: "v-abcdef123456", total: 2997, at: Date.now(), type: "daily", genre: null, ...over });

  test("the route 404s without the owner key, and renames nothing", async () => {
    withData();
    const { app } = buildApp();
    for (const url of ["/admin/result-rename?id=42&to=jayden", "/admin/result-rename?key=nope&id=42&to=jayden"]) {
      const res = await request(app).get(url);
      assert.equal(res.status, 404, url);
    }
    assert.deepEqual(calls, [], "a refused request must not reach the data layer");
  });

  test("a rename passes the row, the scope and the new name through, then returns to the board", async () => {
    withData();
    const { app } = buildApp();
    const res = await request(app).get(`/admin/result-rename?key=${K}&id=42&to=jayden&scope=visitor`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/admin/leaderboards?key=${K}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].rowId, 42);
    assert.equal(calls[0].name, "jayden");
    assert.equal(calls[0].scope, "visitor");
  });

  test("only the literal scope=visitor asks for the bulk rename", async () => {
    // Anything else — absent, misspelled, a truthy-looking string — must take the single row.
    // Guessing wide from a malformed parameter would rewrite every entry a visitor ever made.
    withData();
    const { app } = buildApp();
    for (const q of ["", "&scope=", "&scope=row", "&scope=all", "&scope=1", "&scope=true", "&scope=VISITOR"]) {
      calls.length = 0;
      await request(app).get(`/admin/result-rename?key=${K}&id=42&to=jayden${q}`);
      assert.equal(calls[0].scope, "row", `scope from "${q}"`);
    }
  });

  test("the new name goes through the same profanity filter a player's own name does", async () => {
    // An owner-gated route still must not be able to put a string in that column which no ordinary
    // submission could produce — the boards are public either way.
    withData();
    const { app } = buildApp();
    await request(app).get(`/admin/result-rename?key=${K}&id=42&to=${encodeURIComponent("f" + "uck you")}`);
    assert.equal(calls[0].name, "Anon");
  });

  test("the new name is capped at the same 24 characters as a submitted one", async () => {
    withData();
    const { app } = buildApp();
    await request(app).get(`/admin/result-rename?key=${K}&id=42&to=${"j".repeat(80)}`);
    assert.equal(calls[0].name.length, 24);
  });

  test("a missing row id renames nothing rather than guessing one", async () => {
    withData();
    const { app } = buildApp();
    for (const q of ["", "&id=", "&id=0", "&id=abc"]) {
      calls.length = 0;
      const res = await request(app).get(`/admin/result-rename?key=${K}&to=jayden${q}`);
      assert.equal(res.status, 302, `id "${q}"`);
      assert.deepEqual(calls, [], `id "${q}" must not reach the data layer`);
    }
  });

  test("a data-layer failure still lands the owner back on the board instead of a 500", async () => {
    withData();
    analytics.adminRename = async () => { throw new Error("connection reset"); };
    const { app } = buildApp();
    const res = await request(app).get(`/admin/result-rename?key=${K}&id=42&to=jayden`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/admin/leaderboards?key=${K}`);
  });

  test("with persistence off the route redirects rather than pretending it worked elsewhere", async () => {
    analytics.enabled = () => false;
    calls = [];
    analytics.adminRename = async (a) => { calls.push(a); return { ok: true, rows: 1 }; };
    const { app } = buildApp();
    const res = await request(app).get(`/admin/result-rename?key=${K}&id=42&to=jayden`);
    assert.equal(res.status, 302);
    assert.deepEqual(calls, []);
  });

  test("the board offers a rename beside the remove, carrying the row's id and current name", async () => {
    withData({ results: [entry()] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/leaderboards?key=${K}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /class="rn"/);
    assert.match(res.text, /data-id="42"/);
    assert.match(res.text, /data-name="doodooblud"/);
    assert.match(res.text, /data-has-v="1"/);
    assert.match(res.text, /result-delete\?key=test-owner-key&id=42/, "remove must still be there");
  });

  test("an entry with no visitor_id doesn't offer the visitor-wide scope", async () => {
    withData({ results: [entry({ visitor_id: null })] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/leaderboards?key=${K}`);
    assert.match(res.text, /data-has-v="0"/);
  });

  test("the rename history shows the name each rename replaced", async () => {
    // The whole point of the audit table: renameResults overwrites `name` in place, so this page is
    // the only place the previous name still exists.
    withData({ audit: [{ at: Date.now(), scope: "visitor", row_id: 42, visitor_id: "v-abcdef123456", old_name: "THE ONE ABOVE ALL", new_name: "jayden", rows: 4, by_who: "admin" }] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/leaderboards?key=${K}`);
    assert.match(res.text, /Rename history/);
    assert.match(res.text, /THE ONE ABOVE ALL/);
    assert.match(res.text, /jayden/);
    assert.match(res.text, /4 entries/);
    assert.match(res.text, /all of v-abcdef123/, "and which scope it ran at");
  });

  test("an empty history says so rather than looking like a missing panel", async () => {
    withData({ results: [entry()] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/leaderboards?key=${K}`);
    assert.match(res.text, /No renames yet/);
  });

  test("a name containing a quote or markup can't break the row's handlers or inject script", async () => {
    // Names are player-supplied. The old remove link built a JS string literal inside an HTML
    // attribute out of one, which an apostrophe alone was enough to break.
    withData({
      results: [entry({ name: `" onmouseover="alert(1)` }), entry({ id: 43, name: "<script>alert(2)</script>" }), entry({ id: 44, name: "it's me" })],
      audit: [{ at: Date.now(), scope: "row", row_id: 42, visitor_id: "v-a", old_name: "<script>alert(3)</script>", new_name: "jayden", rows: 1, by_who: "admin" }],
    });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/leaderboards?key=${K}`);
    assert.equal(res.text.includes(`onmouseover="alert(1)`), false);
    assert.equal(res.text.includes("<script>alert(2)"), false);
    assert.equal(res.text.includes("<script>alert(3)"), false);
    assert.match(res.text, /&quot; onmouseover/);
    assert.match(res.text, /it&#39;s me|it's me/, "an apostrophe is fine inside a double-quoted attribute");
  });

  test("the row's name is read as data, never built into an inline onclick", async () => {
    withData({ results: [entry({ name: "it's me" })] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/leaderboards?key=${K}`);
    const row = res.text.slice(res.text.indexOf('class="rn"'));
    assert.equal(row.slice(0, row.indexOf("</td>")).includes("onclick"), false);
  });
});

// Merging two visitors is the one admin action that rewrites rows the owner never looked at — they
// pick two identities out of a dropdown, and everything under the second one moves. So the route's
// job is to pass exactly what was picked and to report what actually happened, including when
// nothing did: a page that looks identical after a refused merge and after a forty-row one is not
// good enough for an operation this destructive.
describe("routes/admin.js — merging two players", () => {
  const K = "test-owner-key";
  let realEnabled, realVisitors, realMerge, realUndo, realHistory, realNames, realMergeNames;
  before(() => {
    realEnabled = analytics.enabled; realVisitors = analytics.resultVisitors;
    realMerge = analytics.mergeVisitors; realUndo = analytics.undoMerge; realHistory = analytics.mergeAuditList;
    realNames = analytics.resultNames; realMergeNames = analytics.mergeNames;
  });
  after(() => {
    analytics.enabled = realEnabled; analytics.resultVisitors = realVisitors;
    analytics.mergeVisitors = realMerge; analytics.undoMerge = realUndo; analytics.mergeAuditList = realHistory;
    analytics.resultNames = realNames; analytics.mergeNames = realMergeNames;
  });

  let merges, undos, nameMerges, result;
  const withData = ({ people = [], history = [], names = [] } = {}) => {
    merges = []; undos = []; nameMerges = [];
    result = { ok: true, rows: 3 };
    analytics.enabled = () => true;
    analytics.resultVisitors = async () => people;
    analytics.resultNames = async () => names;
    analytics.mergeAuditList = async () => history;
    analytics.mergeVisitors = async (a) => { merges.push(a); return result; };
    analytics.mergeNames = async (a) => { nameMerges.push(a); return result; };
    analytics.undoMerge = async (id, by) => { undos.push({ id, by }); return result; };
  };
  const nameRow = (over = {}) => ({ name: "jayden", entries: 4, visitors: 1, best: 2997, first_at: Date.now() - 864e5, last_at: Date.now(), crown: 0, ...over });
  const person = (over = {}) => ({ visitor_id: "v-abcdef123456", entries: 4, best: 2997, first_at: Date.now() - 864e5, last_at: Date.now(), crown: 0, names: "doodooblud,diddy kong", ...over });

  test("both merge routes 404 without the owner key, and merge nothing", async () => {
    withData();
    const { app } = buildApp();
    for (const url of ["/admin/merge-do?keep=v-a&from=v-b", "/admin/merge-do?key=nope&keep=v-a&from=v-b",
      "/admin/merge-undo?id=3", "/admin/merge-undo?key=nope&id=3"]) {
      assert.equal((await request(app).get(url)).status, 404, url);
    }
    assert.deepEqual(merges, []);
    assert.deepEqual(undos, []);
  });

  test("the picker offers every visitor with an entry, on both sides", async () => {
    withData({ people: [person(), person({ visitor_id: "v-second", names: "claude code" })] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /name="keep"/);
    assert.match(res.text, /name="from"/);
    assert.match(res.text, /name="visitorId"/); // the "fix a split crown" picker reuses the same option list
    // Three selects (keep, from, and the crown-fix picker) × two visitors.
    assert.equal((res.text.match(/<option value="v-abcdef123456"/g) || []).length, 3);
    assert.equal((res.text.match(/<option value="v-second"/g) || []).length, 3);
  });

  test("each option says enough to tell two visitors apart", async () => {
    withData({ people: [person({ crown: 1 })] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.match(res.text, /doodooblud, diddy kong/, "the names they have used");
    assert.match(res.text, /4 entries/);
    assert.match(res.text, /best 2997/);
    assert.match(res.text, /v-abcdef123/, "and a stable id, since two people can share a name");
    assert.match(res.text, /👑/, "the crowned visitor is marked — merging that one away is a bigger deal");
  });

  test("a picked pair is passed through exactly as picked", async () => {
    withData({ people: [person()] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge-do?key=${K}&keep=v-a&from=v-b`);
    assert.equal(res.status, 302);
    assert.equal(merges.length, 1);
    assert.equal(merges[0].keep, "v-a");
    assert.equal(merges[0].from, "v-b");
  });

  test("an optional name goes through the same filter and cap as any other name", async () => {
    withData();
    const { app } = buildApp();
    await request(app).get(`/admin/merge-do?key=${K}&keep=v-a&from=v-b&name=${"j".repeat(80)}`);
    assert.equal(merges[0].name.length, 24);
    merges.length = 0;
    await request(app).get(`/admin/merge-do?key=${K}&keep=v-a&from=v-b&name=${encodeURIComponent("f" + "uck you")}`);
    assert.equal(merges[0].name, "Anon");
  });

  test("a blank name means leave the names alone — not rename everything to Anon", async () => {
    // cleanName("") is "Anon", so passing it straight through would silently retitle every entry
    // the merge touched.
    withData();
    const { app } = buildApp();
    for (const q of ["", "&name=", "&name=%20%20"]) {
      merges.length = 0;
      await request(app).get(`/admin/merge-do?key=${K}&keep=v-a&from=v-b${q}`);
      assert.equal(merges[0].name, null, `name from "${q}"`);
    }
  });

  test("a successful merge says how many entries moved", async () => {
    withData({ people: [person()] });
    result = { ok: true, rows: 7 };
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge-do?key=${K}&keep=v-a&from=v-b`);
    assert.match(res.headers.location, /done=merged&n=7/);
    const page = await request(app).get(res.headers.location.replace(/^\//, "/"));
    assert.match(page.text, /7 entries moved/);
  });

  test("every refusal reason gets its own explanation instead of a silent reload", async () => {
    withData({ people: [person()] });
    const { app } = buildApp();
    const expected = {
      same: /same player/i,
      missing: /pick a player on both sides/i,
      "nothing-to-merge": /no entries to move/i,
      "too-many": /more entries than one merge/i,
      "write-failed": /database refused/i,
    };
    for (const [reason, re] of Object.entries(expected)) {
      result = { ok: false, reason, rows: 0 };
      const res = await request(app).get(`/admin/merge-do?key=${K}&keep=v-a&from=v-b`);
      assert.match(res.headers.location, new RegExp(`done=${reason.replace(/-/g, "-")}`), reason);
      const page = await request(app).get(`/admin/merge?key=${K}&done=${encodeURIComponent(reason)}`);
      assert.match(page.text, re, reason);
    }
  });

  test("a thrown data-layer error is reported, not turned into a 500", async () => {
    withData({ people: [person()] });
    analytics.mergeVisitors = async () => { throw new Error("connection reset"); };
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge-do?key=${K}&keep=v-a&from=v-b`);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /done=write-failed/);
  });

  test("an unknown outcome still says nothing was done rather than implying success", async () => {
    withData({ people: [person()] });
    const { app } = buildApp();
    const page = await request(app).get(`/admin/merge?key=${K}&done=something-new`);
    assert.match(page.text, /Nothing done/);
  });

  test("the history offers a put-back per merge, and marks the ones already put back", async () => {
    withData({ history: [
      { id: 3, at: Date.now(), keep_visitor: "v-a", from_visitor: "v-b", rows: 4, renamed: "jayden", by_who: "admin", undone_at: null },
      { id: 2, at: Date.now() - 6e4, keep_visitor: "v-c", from_visitor: "v-d", rows: 1, renamed: null, by_who: "admin", undone_at: Date.now() },
    ] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.match(res.text, /merge-undo\?key=test-owner-key&id=3/);
    assert.equal(res.text.includes("id=2"), false, "an already-undone merge must not offer it again");
    assert.match(res.text, /put back/);
    assert.match(res.text, /renamed to jayden/);
  });

  test("a put-back passes the merge id through and reports the restored count", async () => {
    withData();
    result = { ok: true, rows: 4 };
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge-undo?key=${K}&id=3`);
    assert.deepEqual(undos, [{ id: "3", by: "admin" }]);
    assert.match(res.headers.location, /done=undone&n=4/);
    const page = await request(app).get(`/admin/merge?key=${K}&done=undone&n=4`);
    assert.match(page.text, /4 entries returned/);
  });

  test("a refused put-back explains why", async () => {
    withData();
    const { app } = buildApp();
    for (const [reason, re] of Object.entries({ "already-undone": /already been put back/i, "not-found": /no record of that merge/i, "no-snapshot": /no record of which entries moved/i })) {
      result = { ok: false, reason, rows: 0 };
      const res = await request(app).get(`/admin/merge-undo?key=${K}&id=3`);
      assert.match(res.headers.location, new RegExp(`done=${reason}`));
      const page = await request(app).get(`/admin/merge?key=${K}&done=${reason}`);
      assert.match(page.text, re, reason);
    }
  });

  test("the page says which records a merge does NOT touch", async () => {
    // The visit log keeps its own visitor_id. Rewriting it would tidy /admin/visitors and destroy
    // the record of who actually visited from where — the owner has to know which they are getting.
    withData({ people: [person()] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.match(res.text, /Only leaderboard entries move/);
    assert.match(res.text, /visit log/i);
    assert.match(res.text, /\(you\)/, "and that the folded-in player loses their own marker");
  });

  test("with persistence off the page says so instead of offering an empty picker", async () => {
    analytics.enabled = () => false;
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Persistence not configured/);
    assert.equal(res.text.includes('name="keep"'), false);
  });

  test("a hostile visitor name or id can't inject markup into the picker or the history", async () => {
    withData({
      people: [person({ names: '<script>alert(1)</script>', visitor_id: '"><script>alert(2)</script>' })],
      history: [{ id: 3, at: Date.now(), keep_visitor: '"><img src=x>', from_visitor: "v-b", rows: 1, renamed: "<script>alert(3)</script>", by_who: "admin", undone_at: null }],
    });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    for (const bad of ["<script>alert(1)", "<script>alert(2)", "<script>alert(3)", '<img src=x>']) {
      assert.equal(res.text.includes(bad), false, bad);
    }
    assert.match(res.text, /&lt;script&gt;/);
  });

  test("the name picker offers every name on a board, on both sides", async () => {
    withData({ names: [nameRow(), nameRow({ name: "Jayden", entries: 2, visitors: 1 })] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.match(res.text, /name="keepName"/);
    assert.match(res.text, /name="fromName"/);
    assert.equal((res.text.match(/<option value="jayden"/g) || []).length, 2);
    assert.equal((res.text.match(/<option value="Jayden"/g) || []).length, 2);
  });

  test("a name option says how many browsers use it — the only safety signal there is", async () => {
    // Nothing in the data distinguishes one person on three browsers from three people who picked
    // the same name, so the count is what lets the owner make that call.
    withData({ names: [nameRow({ visitors: 3, entries: 9, best: 61 })] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.match(res.text, /9 entries from 3 browsers/);
    assert.match(res.text, /best 61/);
    assert.match(res.text, /data-visitors="3"/, "and the script needs it to warn on submit");
  });

  test("a picked pair of names is passed through exactly as picked", async () => {
    withData({ names: [nameRow()] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge-names?key=${K}&keepName=jayden&fromName=Jayden`);
    assert.equal(res.status, 302);
    assert.equal(nameMerges.length, 1);
    assert.equal(nameMerges[0].keepName, "jayden");
    assert.equal(nameMerges[0].fromName, "Jayden");
  });

  test("case is preserved on the way through, since that is often the whole difference", async () => {
    withData();
    const { app } = buildApp();
    await request(app).get(`/admin/merge-names?key=${K}&keepName=jayden&fromName=JAYDEN`);
    assert.equal(nameMerges[0].keepName, "jayden");
    assert.equal(nameMerges[0].fromName, "JAYDEN");
  });

  test("the name route 404s without the owner key, and merges nothing", async () => {
    withData();
    const { app } = buildApp();
    for (const url of ["/admin/merge-names?keepName=a&fromName=b", "/admin/merge-names?key=nope&keepName=a&fromName=b"]) {
      assert.equal((await request(app).get(url)).status, 404, url);
    }
    assert.deepEqual(nameMerges, []);
  });

  test("a successful name merge reports its own outcome, not the visitor one's", async () => {
    withData({ names: [nameRow()] });
    result = { ok: true, rows: 9 };
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge-names?key=${K}&keepName=jayden&fromName=Jayden`);
    assert.match(res.headers.location, /done=merged-names&n=9/);
    const page = await request(app).get(`/admin/merge?key=${K}&done=merged-names&n=9`);
    assert.match(page.text, /9 entries now belong to one player under one name/);
  });

  test("its refusals say NAME, so the message matches the picker that was used", async () => {
    // "pick two different players" under the name form would just be confusing.
    withData({ names: [nameRow()] });
    const { app } = buildApp();
    for (const [reason, mapped, re] of [["same", "same-name", /same name/i], ["missing", "missing-name", /pick a name on both sides/i]]) {
      result = { ok: false, reason, rows: 0 };
      const res = await request(app).get(`/admin/merge-names?key=${K}&keepName=a&fromName=b`);
      assert.match(res.headers.location, new RegExp(`done=${mapped}`), reason);
      const page = await request(app).get(`/admin/merge?key=${K}&done=${mapped}`);
      assert.match(page.text, re, reason);
    }
  });

  test("shared refusal reasons keep their shared wording", async () => {
    withData({ names: [nameRow()] });
    const { app } = buildApp();
    for (const reason of ["nothing-to-merge", "too-many", "write-failed"]) {
      result = { ok: false, reason, rows: 0 };
      const res = await request(app).get(`/admin/merge-names?key=${K}&keepName=a&fromName=b`);
      assert.match(res.headers.location, new RegExp(`done=${reason}`), reason);
    }
  });

  test("a thrown error in the name merge is reported, not a 500", async () => {
    withData({ names: [nameRow()] });
    analytics.mergeNames = async () => { throw new Error("connection reset"); };
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge-names?key=${K}&keepName=a&fromName=b`);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /done=write-failed/);
  });

  test("the history says which kind each merge was", async () => {
    withData({ history: [
      { id: 4, at: Date.now(), kind: "name", keep_visitor: "v-a", from_visitor: null, keep_label: "jayden", from_label: "Jayden", rows: 9, renamed: "jayden", by_who: "admin", undone_at: null },
      { id: 3, at: Date.now() - 6e4, kind: "visitor", keep_visitor: "v-aaaaaaaaaaaa", from_visitor: "v-bbbbbbbbbbbb", keep_label: "v-aaaaaaaaaaaa", from_label: "v-bbbbbbbbbbbb", rows: 4, renamed: null, by_who: "admin", undone_at: null },
    ] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.match(res.text, /<span class="tag">name<\/span> Jayden → <b>jayden<\/b>/);
    assert.match(res.text, /<span class="tag">player<\/span>/);
    assert.match(res.text, /merge-undo\?key=test-owner-key&id=4/, "a name merge is undoable too");
  });

  test("a merge recorded before this feature existed still renders, from its visitor ids", async () => {
    // Rows written by the previous version have no kind and no labels.
    withData({ history: [{ id: 1, at: Date.now(), kind: null, keep_visitor: "v-aaaaaaaaaaaa", from_visitor: "v-bbbbbbbbbbbb", keep_label: null, from_label: null, rows: 2, renamed: null, by_who: "admin", undone_at: null }] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    // Both ids are shown truncated to 12 characters, as elsewhere on the page.
    assert.match(res.text, /v-bbbbbbbbbb\b/);
    assert.match(res.text, /v-aaaaaaaaaa\b/);
    assert.match(res.text, /<span class="tag">player<\/span>/);
  });

  test("the page explains that case matters, since that is the commonest duplicate", async () => {
    withData({ names: [nameRow()] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.match(res.text, /Case matters/i);
  });

  test("a hostile display name can't inject markup into the name picker", async () => {
    withData({ names: [nameRow({ name: '"><script>alert(9)</script>' })] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.equal(res.text.includes("<script>alert(9)"), false);
    assert.match(res.text, /&lt;script&gt;/);
  });

  test("the form is a GET, since only express.json() is mounted to parse a body", async () => {
    withData({ people: [person()] });
    const { app } = buildApp();
    const res = await request(app).get(`/admin/merge?key=${K}`);
    assert.match(res.text, /<form class="mf" action="\/admin\/merge-do" method="get"/);
    assert.match(res.text, /<input type="hidden" name="key"/);
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
