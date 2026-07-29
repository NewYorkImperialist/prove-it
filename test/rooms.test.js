"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const engine = require("../game-engine.js");
const analytics = require("../stats.js"); // no TURSO_URL in the test env — every write is a silent no-op
const { CATEGORY_GROUPS, DEFAULT_GROUPS } = require("../lib/category-data.js");
const { createRooms } = require("../rooms.js");

// Real Socket.IO client <-> server over a loopback TCP port — this is the same shape of check
// as the manual smoke test used earlier to verify the server.js extraction, now checked in CI.
let httpServer, roomsApi, port;
const clients = [];

before(() => {
  return new Promise((resolve) => {
    const app = express();
    httpServer = http.createServer(app);
    const io = new Server(httpServer);
    roomsApi = createRooms({ io, engine, analytics, CATEGORY_GROUPS, DEFAULT_GROUPS });
    httpServer.listen(0, () => { port = httpServer.address().port; resolve(); });
  });
});

after(() => {
  roomsApi.closeAllRooms(); // clean up any rooms/timers left behind by individual tests
  clients.forEach((c) => c.close());
  return new Promise((resolve) => httpServer.close(resolve));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// createRoom/joinRoom broadcast "roomState" as a side effect of their own handler, so a `once`
// listener registered right after one action can race with — and catch — that action's own
// broadcast instead of the next one. Track the latest broadcast continuously instead.
function trackRoomState(socket) {
  const box = { current: null };
  socket.on("roomState", (rs) => { box.current = rs; });
  return box;
}

describe("rooms.js — lobby lifecycle", () => {
  test("createRoom makes the creator the host of a fresh room", async () => {
    const a = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    assert.equal(created.ok, true);
    assert.match(created.code, /^[A-Z0-9]{4}$/);
    assert.ok(roomsApi.rooms.has(created.code));
    const room = roomsApi.rooms.get(created.code);
    assert.equal(room.hostId, created.you);
    assert.equal(room.players.size, 1);
  });

  test("joinRoom seats a second player and broadcasts the updated roster", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const tracked = trackRoomState(a);
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    assert.equal(joined.ok, true);
    await sleep(50);
    assert.equal(tracked.current.players.length, 2);
    assert.ok(tracked.current.players.some((p) => p.name === "Bob" && !p.isHost));
  });

  test("a third player is rejected once the room is full", async () => {
    const a = await connect(), b = await connect(), c = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const rejected = await emit(c, "joinRoom", { code: created.code, name: "Carl" });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /full/);
  });

  test("joinRoom with an unknown code fails cleanly", async () => {
    const a = await connect();
    const res = await emit(a, "joinRoom", { code: "ZZZZ", name: "Ghost" });
    assert.equal(res.ok, false);
    assert.match(res.error, /No room/);
  });

  test("setName mid-lobby updates the roster everyone sees", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    await sleep(50); // let joinRoom's own broadcast settle before watching for setName's
    const tracked = trackRoomState(a);
    b.emit("setName", { name: "Bobby" });
    await sleep(50);
    const bobby = tracked.current.players.find((p) => p.id === joined.you);
    assert.equal(bobby.name, "Bobby");
  });

  test("spectateRoom joins as a non-player who can't start the match", async () => {
    const a = await connect(), spec = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const res = await emit(spec, "spectateRoom", { code: created.code, name: "Watcher" });
    assert.equal(res.ok, true);
    assert.equal(res.spectator, true);
    const room = roomsApi.rooms.get(created.code);
    assert.equal(room.players.size, 1);
    assert.equal(room.spectators.size, 1);
  });

  test("startMatch requires two players and only the host may call it", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const tooFew = await emit(a, "startMatch", {});
    assert.equal(tooFew.ok, false);
    assert.match(tooFew.error, /Need 2 players/);

    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const notHost = await emit(b, "startMatch", {});
    assert.equal(notHost.ok, false);
    assert.match(notHost.error, /host/);

    const started = await emit(a, "startMatch", {});
    assert.equal(started.ok, true);
    assert.ok(roomsApi.rooms.get(created.code).game, "room.game should be populated once the match starts");
  });

  test("leaveRoom frees the slot so someone else can take it, and empties the room when everyone leaves", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    b.emit("leaveRoom");
    await sleep(50);
    assert.equal(roomsApi.rooms.get(created.code).players.size, 1);
    a.emit("leaveRoom");
    await sleep(50);
    assert.ok(!roomsApi.rooms.has(created.code), "room should be deleted once its last player leaves");
  });

  test("lockdown blocks new rooms from being created", async () => {
    roomsApi.setLockdown(true);
    try {
      const a = await connect();
      const res = await emit(a, "createRoom", { name: "Alice" });
      assert.equal(res.ok, false);
      assert.match(res.error, /maintenance/);
    } finally {
      roomsApi.setLockdown(false);
    }
  });
});

describe("rooms.js — presence + owner tools", () => {
  test("getOnline tracks connect/disconnect", async () => {
    const before2 = roomsApi.getOnline();
    const a = await connect();
    await sleep(20);
    assert.equal(roomsApi.getOnline(), before2 + 1);
    a.close();
    await sleep(50);
    assert.equal(roomsApi.getOnline(), before2);
  });

  test("closeRoom evicts everyone and deletes the room", async () => {
    const a = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const closedPromise = waitFor(a, "roomClosed");
    const ok = roomsApi.closeRoom(created.code);
    assert.equal(ok, true);
    await closedPromise;
    assert.ok(!roomsApi.rooms.has(created.code));
  });
});
