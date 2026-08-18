"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { createAdminRouter } = require("../routes/admin.js");

process.env.OWNER_KEY = "test-owner-key";

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

describe("routes/admin.js — category health", () => {
  test("lists categories with no persistence configured", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/admin/health?key=test-owner-key");
    assert.equal(res.status, 200);
    assert.match(res.text, /Persistence not configured/);
  });
});
