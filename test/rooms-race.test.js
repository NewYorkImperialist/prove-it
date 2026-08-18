"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const engine = require("../game-engine.js");
const raceEngine = require("../race-engine.js");
const analytics = require("../stats.js"); // no TURSO_URL in the test env — every write is a silent no-op
const { CATEGORY_GROUPS, DEFAULT_GROUPS } = require("../lib/category-data.js");
const { createRooms } = require("../rooms.js");

// Real Socket.IO client <-> server over a loopback TCP port, mirroring test/rooms.test.js's
// approach — but exercising the "race" mode (room.mode === "race") end to end.
let httpServer, roomsApi, port;
const clients = [];
let realLog;

before(() => {
  // Same reason as test/rooms.test.js: rooms.js's per-connection logging interleaved with the
  // test runner's serialized IPC stream can corrupt it and fail the whole file spuriously.
  realLog = console.log;
  console.log = () => {};
  return new Promise((resolve) => {
    const app = express();
    httpServer = http.createServer(app);
    const io = new Server(httpServer);
    roomsApi = createRooms({ io, engine, raceEngine, analytics, CATEGORY_GROUPS, DEFAULT_GROUPS, quickMatchGraceMs: 60 });
    httpServer.listen(0, () => { port = httpServer.address().port; resolve(); });
  });
});

after(() => {
  roomsApi.closeAllRooms();
  clients.forEach((c) => c.close());
  return new Promise((resolve) => httpServer.close(() => { console.log = realLog; resolve(); }));
});

function connect() {
  return new Promise((resolve) => {
    const s = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
    clients.push(s);
    s.on("connect", () => resolve(s));
  });
}
function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}
function trackEvent(socket, event) {
  const box = { current: null, all: [] };
  socket.on(event, (payload) => { box.current = payload; box.all.push(payload); });
  return box;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("rooms.js — race mode lifecycle", () => {
  test("creating a race room with 3 players and starting it works end to end", async () => {
    const a = await connect(), b = await connect(), c = await connect();
    const created = await emit(a, "createRoom", { name: "Alice", mode: "race", raceSettings: { timer: 15, format: 3, suddenDeath: false } });
    assert.equal(created.ok, true);
    assert.equal(created.mode, "race");
    const code = created.code;

    const joinedB = await emit(b, "joinRoom", { code, name: "Bob" });
    assert.equal(joinedB.ok, true);
    const joinedC = await emit(c, "joinRoom", { code, name: "Cleo" });
    assert.equal(joinedC.ok, true);

    const raceState = trackEvent(a, "raceState");
    const startedEvent = waitFor(a, "raceGameStarted"); // register BEFORE triggering it — see test/rooms.test.js's own note on this race
    const startedAck = await emit(a, "startMatch", {});
    assert.equal(startedAck.ok, true);
    await startedEvent;
    await sleep(50);
    assert.ok(raceState.current, "should have received at least one raceState broadcast");
    assert.equal(raceState.current.liveScores.length, 3);

    // score-only invariant: no raceState broadcast should ever leak an actual answer's text.
    for (const s of raceState.all) assert.equal(JSON.stringify(s).match(/["']got["']/), null);
  });

  test("a duel-only event (voteEnd) is silently ignored in a race room instead of corrupting its state", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice", mode: "race", raceSettings: { timer: 10, format: null } });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const startedEvent = waitFor(a, "raceGameStarted");
    await emit(a, "startMatch", {});
    await startedEvent;
    await sleep(30);

    const matchOver = trackEvent(a, "raceMatchOver");
    a.emit("voteEnd", {}); // a duel-mode-only event; withDuelGame should refuse to dispatch it here
    b.emit("voteEnd", {});
    await sleep(50);
    assert.equal(matchOver.current, null, "the duel handler must not have ended this race match");
  });

  test("raceAnswer never reveals the matched item's text back over the live channel", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice", mode: "race" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const raceState = trackEvent(a, "raceState");
    const startedEvent = waitFor(a, "raceGameStarted");
    await emit(a, "startMatch", {});
    await startedEvent;
    await sleep(30);
    const ack = await emit(a, "raceAnswer", { text: "nonsense-guess-unlikely-to-match" });
    assert.equal(ack.accepted, false); // whatever the live category is, this text shouldn't match anything
    await sleep(30);
    for (const s of raceState.all) assert.equal(JSON.stringify(s).includes("nonsense-guess"), false);
  });
});

describe("rooms.js — quick match", () => {
  test("two players queueing for quick-match land in the same race room", async () => {
    const a = await connect(), b = await connect();
    const foundA = waitFor(a, "quickMatchFound");
    const foundB = waitFor(b, "quickMatchFound");
    const ackA = await emit(a, "quickMatchJoin", { name: "Alice" });
    assert.equal(ackA.queued, true);
    await emit(b, "quickMatchJoin", { name: "Bob" });
    // MIN_TO_START (2) is reached immediately, but matchmaking.js still waits out its grace
    // window before popping the batch — allow generous headroom for that in a test.
    const [a1, b1] = await Promise.all([foundA, foundB]);
    assert.equal(a1.code, b1.code);
  });
});
