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
let realLog;

before(() => {
  // rooms.js narrates every connect/join/start/disconnect to stdout. Dozens of those lines
  // interleaved with the test runner's own serialized IPC stream is enough to corrupt it
  // ("Unable to deserialize cloned data"), which shows up as a phantom failure of the whole
  // file. Errors still go to console.error, so a real problem is never swallowed.
  realLog = console.log;
  console.log = () => {};
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

// The owner's invisible watch. The contract is stronger than "spectator with a flag": a ghost is
// registered in NO roster, which is what makes it invisible and — as a free consequence — unable
// to chat, since the chat handler has nobody to attribute a message to.
describe("rooms.js — owner ghost watch", () => {
  // ghostWatch reads process.env.OWNER_KEY at call time, so each test can set its own.
  async function withOwnerKey(key, fn) {
    const prev = process.env.OWNER_KEY;
    if (key === null) delete process.env.OWNER_KEY;
    else process.env.OWNER_KEY = key;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.OWNER_KEY;
      else process.env.OWNER_KEY = prev;
    }
  }

  test("refuses to ghost with no owner key configured, or with the wrong key", async () => {
    const a = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });

    await withOwnerKey(null, async () => {
      const g = await connect();
      const res = await emit(g, "ghostWatch", { code: created.code, key: "anything" });
      assert.equal(res.ok, false); // nothing to authorise against
    });
    await withOwnerKey("right-key", async () => {
      const g = await connect();
      const res = await emit(g, "ghostWatch", { code: created.code, key: "wrong-key" });
      assert.equal(res.ok, false);
      assert.match(res.error, /Not authorized/);
    });
  });

  test("refuses a room code that doesn't exist", async () => {
    await withOwnerKey("k", async () => {
      const g = await connect();
      const res = await emit(g, "ghostWatch", { code: "ZZZZ", key: "k" });
      assert.equal(res.ok, false);
      assert.match(res.error, /No room/);
    });
  });

  test("a ghost appears in neither roster, and the players' own view is untouched", async () => {
    await withOwnerKey("k", async () => {
      const a = await connect();
      const created = await emit(a, "createRoom", { name: "Alice" });
      const tracked = trackRoomState(a);
      await sleep(30);
      const before = JSON.stringify(tracked.current);

      const g = await connect();
      const res = await emit(g, "ghostWatch", { code: created.code, key: "k" });
      assert.equal(res.ok, true);
      assert.equal(res.ghost, true);
      await sleep(50);

      const room = roomsApi.rooms.get(created.code);
      assert.equal(room.players.size, 1, "a ghost must not become a player");
      assert.equal(room.spectators.size, 0, "a ghost must not become a watcher either");
      assert.equal(JSON.stringify(tracked.current), before, "the players' room state must not change");
    });
  });

  test("a normal spectator IS listed — the control proving the ghost's absence is real", async () => {
    await withOwnerKey("k", async () => {
      const a = await connect();
      const created = await emit(a, "createRoom", { name: "Alice" });

      const g = await connect();
      await emit(g, "ghostWatch", { code: created.code, key: "k" });
      const spec = await connect();
      await emit(spec, "spectateRoom", { code: created.code, name: "Watcher" });
      await sleep(50);

      const room = roomsApi.rooms.get(created.code);
      assert.equal(room.spectators.size, 1); // the spectator, and only the spectator
      assert.deepEqual([...room.spectators.values()].map((s) => s.name), ["Watcher"]);
    });
  });

  test("a ghost stays out of the online count, and uncounts itself only once", async () => {
    await withOwnerKey("k", async () => {
      const a = await connect();
      const created = await emit(a, "createRoom", { name: "Alice" });
      await sleep(30);
      const before = roomsApi.getOnline();

      const g = await connect();
      await sleep(30);
      assert.equal(roomsApi.getOnline(), before + 1, "a fresh socket counts until it identifies itself");

      await emit(g, "ghostWatch", { code: created.code, key: "k" });
      await sleep(30);
      assert.equal(roomsApi.getOnline(), before, "ghosting removes it from the count");

      await emit(g, "ghostWatch", { code: created.code, key: "k" }); // re-ghost (e.g. a reconnect)
      await sleep(30);
      assert.equal(roomsApi.getOnline(), before, "and never double-decrements");
    });
  });

  test("a ghost is handed the room's current state the moment it arrives", async () => {
    await withOwnerKey("k", async () => {
      const a = await connect();
      const created = await emit(a, "createRoom", { name: "Alice" });
      const g = await connect();
      const stateP = waitFor(g, "roomState");
      const res = await emit(g, "ghostWatch", { code: created.code, key: "k" });
      assert.equal(res.inGame, false); // still in the lobby
      const rs = await stateP;
      assert.equal(rs.code, created.code);
      assert.deepEqual(rs.players.map((p) => p.name), ["Alice"]);
    });
  });

  test("a ghost cannot chat — being in no roster, there's nobody to attribute a message to", async () => {
    await withOwnerKey("k", async () => {
      const a = await connect();
      const created = await emit(a, "createRoom", { name: "Alice" });
      const g = await connect();
      await emit(g, "ghostWatch", { code: created.code, key: "k" });

      let heard = null;
      a.on("chat", (m) => { heard = m; });
      g.emit("chat", { text: "boo" });
      await sleep(120);
      assert.equal(heard, null, "a ghost's chat must never reach the room");
    });
  });
});
