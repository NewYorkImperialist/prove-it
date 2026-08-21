"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const engine = require("../server/game-engine.js");
const analytics = require("../server/stats.js"); // no TURSO_URL in the test env — every write is a silent no-op
const { CATEGORY_GROUPS, DEFAULT_GROUPS } = require("../lib/category-data.js");
const { createRooms, PING_OPTIONS, GRACE_MS } = require("../server/rooms.js");

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
// Poll rather than sleep-then-assert: these tests share a machine with three other suites, and a
// fixed wait that's generous on an idle box is a coin flip under load. Fails with the real reason
// (the last predicate result) rather than a bare timeout.
async function waitUntil(fn, { timeout = 4000, step = 20, what = "condition" } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await sleep(step);
  }
}

// Like emit(), but resolves with null if the server never answers. The bugs below were all
// "the server said nothing at all", which `await emit()` can only express by hanging forever.
function emitOrNull(socket, event, payload, ms = 300) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.emit(event, payload, (r) => { clearTimeout(t); resolve(r); });
  });
}
function trackEvent(socket, event) {
  const box = { all: [] };
  socket.on(event, (payload) => box.all.push(payload));
  return box;
}
// A throwaway server + rooms instance, for the two things the shared harness above can't express:
// its own Socket.IO options, and its own analytics double. Torn down before it returns.
async function withOwnServer({ socketOptions, analytics: analyticsDouble } = {}, fn) {
  const httpServer2 = http.createServer(express());
  const io2 = new Server(httpServer2, socketOptions);
  const api = createRooms({ io: io2, engine, analytics: analyticsDouble || analytics, CATEGORY_GROUPS, DEFAULT_GROUPS });
  await new Promise((resolve) => httpServer2.listen(0, resolve));
  const port2 = httpServer2.address().port;
  const opened = [];
  // reconnection: false — these tests assert on what the SERVER saw, so a client quietly
  // reconnecting mid-assertion would make them flaky.
  const open = () => new Promise((resolve) => {
    const s = ioClient(`http://localhost:${port2}`, { transports: ["websocket"], reconnection: false });
    opened.push(s);
    s.on("connect", () => resolve(s));
  });
  try {
    return await fn({ api, open });
  } finally {
    api.closeAllRooms();
    opened.forEach((c) => c.close());
    await new Promise((resolve) => httpServer2.close(resolve));
  }
}
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

  test("startMatch refuses to restart a match that's already running", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    await emit(a, "startMatch", {});
    const game = roomsApi.rooms.get(created.code).game;

    const again = await emit(a, "startMatch", {});
    assert.equal(again.ok, false);
    assert.match(again.error, /already in progress/);
    // Restarting would have thrown away everyone's scores mid-round AND left the discarded
    // game's timers firing against the replacement — one open-timeout scoring twice.
    assert.equal(roomsApi.rooms.get(created.code).game, game, "the live game object must survive");
  });

  test("startMatch won't start against a player who is mid-reconnect", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    b.close(); // Bob drops, but keeps his seat for the grace window
    await sleep(80);

    const res = await emit(a, "startMatch", {});
    assert.equal(res.ok, false);
    assert.match(res.error, /reconnect/);
    assert.ok(!roomsApi.rooms.get(created.code).game, "no match should have been dealt");
  });

  test("a gameplay intent sent while paused is refused out loud, not silently dropped", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    await emit(a, "startMatch", {});
    b.close(); // Bob drops → the game pauses, but the phase and turn are untouched
    await sleep(80);
    assert.equal(roomsApi.rooms.get(created.code).game.paused, true);

    // The client still classifies typing as an answer here, so an unacked drop cleared the
    // input and sent the text nowhere. The ack is what lets the UI say why.
    const res = await emit(a, "answer", { text: "norway" });
    assert.equal(res.ok, false);
    assert.match(res.error, /paused/);
  });

  // Every button action used to be emitted with no ack callback at all, so the paused refusal
  // above — and every engine refusal — was invisible: you pressed the button, nothing happened,
  // and there was no way to tell a declined intent from a room that had gone deaf.
  test("a button action sent while paused is refused out loud too, not just typed answers", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    await emit(a, "startMatch", {});
    b.close();
    await sleep(80);
    assert.equal(roomsApi.rooms.get(created.code).game.paused, true);
    for (const ev of ["voteSkip", "giveUp", "nextRound", "judge", "voteEnd"]) {
      const res = await emit(a, ev, {});
      assert.equal(res.ok, false, `${ev} answered ok while paused`);
      assert.match(res.error, /paused/, `${ev} didn't say why`);
    }
  });

  test("a spectator pressing a game button is told why, not ignored", async () => {
    const a = await connect(), b = await connect(), spec = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    await emit(spec, "spectateRoom", { code: created.code, name: "Watcher" });
    await emit(a, "startMatch", {});
    await sleep(50);
    const res = await emitOrNull(spec, "voteSkip", {});
    assert.ok(res, "the server said nothing at all — the same dead button the acks exist to fix");
    assert.equal(res.ok, false);
    assert.match(res.error, /spectator/i);
  });

  test("pressing a game button with no game running is answered too", async () => {
    const a = await connect();
    await emit(a, "createRoom", { name: "Alice" }); // in a room, but nothing started
    const res = await emitOrNull(a, "nextRound", {});
    assert.ok(res, "silence again");
    assert.equal(res.ok, false);
    assert.match(res.error, /no game/i);
  });

  test("an action the engine turns down comes back with the reason", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    await emit(a, "startMatch", {});
    await sleep(50);
    const g = roomsApi.rooms.get(created.code).game;
    assert.equal(g.phase, "opening"); // nothing to advance, nothing to pause, nobody proving

    const next = await emit(a, "nextRound", {});
    assert.equal(next.ok, false);
    assert.match(next.error, /round isn't over/i);

    const gaveUp = await emit(a, "giveUp", {});
    assert.equal(gaveUp.ok, false);
    assert.match(gaveUp.error, /give up/i);

    // The opener isn't the challenger yet, so ruling on answers isn't theirs to do.
    const judged = await emit(a, "judge", { answerId: "nope", accept: true });
    assert.equal(judged.ok, false);
    assert.match(judged.error, /challenger/i);
  });

  test("a vote the server accepted acks ok, and voting twice says so", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    await emit(a, "startMatch", {});
    await sleep(50);
    const first = await emit(a, "voteSkip", {});
    assert.equal(first.ok, true, "a vote that was counted has to ack ok, or the UI can't tell");
    const second = await emit(a, "voteSkip", {});
    assert.equal(second.ok, false);
    assert.match(second.error, /already voted/i);
  });

  test("asking to spectate a room you hold a seat in resumes you as a PLAYER, not a spectator", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });

    // Same playerId as a seated player. The client keys its read-only spectator UI off this
    // ack's `spectator` flag, so saying "true" here would leave a real player unable to play.
    // With the seat token, as the real client sends (it stores whatever the join ack returned).
    const res = await emit(b, "spectateRoom", { code: created.code, name: "Bob", playerId: joined.you, seat: joined.seat });
    assert.equal(res.ok, true);
    assert.notEqual(res.spectator, true, "a seated player must never be acked as a spectator");
    const room = roomsApi.rooms.get(created.code);
    assert.equal(room.spectators.size, 0, "and must not be moved into the spectator list");
  });

  test("each disconnected player gets their own forfeit countdown", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    a.close(); b.close();
    await sleep(120);
    // A single room-wide timer meant the second disconnect cancelled the first player's
    // countdown, so that player kept their seat forever and the room stayed paused.
    const room = roomsApi.rooms.get(created.code);
    assert.equal(room.players.size, 2, "both seats are still held during the grace window");
    assert.equal(room.graceTimeouts.size, 2, "both players must be counting down, not just the last one");
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

// Multiplayer names used to go through a LOCAL cleanName that only trimmed and truncated, so the
// obscenity filter in lib/name-filter.js — applied to leaderboard names since forever — didn't
// cover the name that sits in the roster, in every chat line and in the owner's feed. These join
// paths all ack with an `error` the client already renders next to the name field, so the name is
// refused outright rather than silently swapped for something the player didn't choose.
describe("rooms.js — display names go through the profanity filter", () => {
  test("createRoom refuses a blocked name instead of seating it", async () => {
    const a = await connect();
    const before = roomsApi.rooms.size;
    const res = await emit(a, "createRoom", { name: "fuck you" });
    assert.equal(res.ok, false);
    assert.match(res.error, /isn't allowed/);
    assert.equal(roomsApi.rooms.size, before, "no room should have been created");
  });

  test("joinRoom refuses a blocked name and leaves the roster alone", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const res = await emit(b, "joinRoom", { code: created.code, name: "n1gg4" });
    assert.equal(res.ok, false);
    assert.match(res.error, /isn't allowed/);
    assert.equal(roomsApi.rooms.get(created.code).players.size, 1);
  });

  test("spectateRoom refuses a blocked name too", async () => {
    const a = await connect(), spec = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const res = await emit(spec, "spectateRoom", { code: created.code, name: "fuck you" });
    assert.equal(res.ok, false);
    assert.match(res.error, /isn't allowed/);
    assert.equal(roomsApi.rooms.get(created.code).spectators.size, 0);
  });

  test("setName refuses a blocked rename, and the old name stands", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const res = await emitOrNull(b, "setName", { name: "n i g g a" });
    assert.equal(res.ok, false);
    assert.match(res.error, /isn't allowed/);
    assert.equal(roomsApi.rooms.get(created.code).players.get(joined.you).name, "Bob");
  });

  test("an ordinary name is still accepted, trimmed, and capped at 20 characters", async () => {
    const a = await connect();
    const created = await emit(a, "createRoom", { name: "   Scunthorpe Sam is a very long name   " });
    assert.equal(created.ok, true); // "Scunthorpe" is exactly the innocuous-substring case the filter whitelists
    const me = [...roomsApi.rooms.get(created.code).players.values()][0];
    assert.equal(me.name, "Scunthorpe Sam is a ");
    assert.equal(me.name.length, 20);
  });

  test("reclaiming a seat is never name-checked — a stale name in storage can't lock you out", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    // The name check has to sit AFTER the resume branch: a client re-sends whatever name it has
    // in storage on every reconnect, and refusing that would strand a seated player mid-match.
    const again = await emit(b, "joinRoom", { code: created.code, name: "fuck you", playerId: joined.you, seat: joined.seat });
    assert.equal(again.ok, true);
    assert.equal(roomsApi.rooms.get(created.code).players.get(joined.you).name, "Bob");
  });
});

// Two guests who never typed a name both used to arrive as the blank-name fallback, leaving the
// roster, every chat line and the whole game log with two identical players — neither of them
// able to find their own score.
describe("rooms.js — display names are unique within a room", () => {
  test("a second blank name is suffixed instead of colliding", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "", mode: "race" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "" });
    assert.equal(joined.ok, true);
    const players = [...roomsApi.rooms.get(created.code).players.values()].map((p) => p.name);
    assert.equal(new Set(players).size, 2, `both players ended up named the same: ${players.join(" / ")}`);
    assert.match(players[1], /2$/);
  });

  test("a deliberate duplicate is suffixed too, and stays inside the name cap", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alexandrina Victoria", mode: "race" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Alexandrina Victoria" });
    assert.equal(joined.ok, true);
    const players = [...roomsApi.rooms.get(created.code).players.values()].map((p) => p.name);
    assert.equal(new Set(players).size, 2);
    for (const n of players) assert.ok(n.length <= 20, `"${n}" is ${n.length} chars, past the 20-char cap`);
  });

  test("a spectator can't take a name a player is already using", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const spec = await emit(b, "spectateRoom", { code: created.code, name: "Alice" });
    assert.equal(spec.ok, true);
    const room = roomsApi.rooms.get(created.code);
    assert.equal(room.players.get(created.you).name, "Alice");
    assert.notEqual(room.spectators.get(spec.you).name, "Alice");
  });

  test("renaming yourself onto someone else's name is suffixed, not allowed to collide", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const renamed = await emit(b, "setName", { name: "Alice" });
    assert.equal(renamed.ok, true);
    assert.notEqual(renamed.name, "Alice");
    assert.equal(roomsApi.rooms.get(created.code).players.get(joined.you).name, renamed.name);
  });

  test("keeping your own name on a rename isn't treated as a collision with yourself", async () => {
    const a = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const renamed = await emit(a, "setName", { name: "Alice" });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.name, "Alice", "renaming to the name you already hold must not suffix it");
    assert.equal(roomsApi.rooms.get(created.code).players.get(created.you).name, "Alice");
  });
});

describe("rooms.js — chat rate limiting", () => {
  test("a message dropped by the rate limit tells the sender, and only the sender", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const heard = trackEvent(b, "chat");
    const myLogs = trackEvent(a, "log");
    const otherLogs = trackEvent(b, "log");

    const first = await emitOrNull(a, "chat", { text: "one" });
    assert.deepEqual(first, { ok: true });
    const second = await emitOrNull(a, "chat", { text: "two" }); // well inside the 400ms gap
    // Dropping this silently looked exactly like the room going deaf: the client cleared the
    // input and the text reached nobody, with no ack and no message back.
    assert.notEqual(second, null, "the server has to answer, even to refuse");
    assert.equal(second.ok, false);
    assert.match(second.error, /too fast/);
    await sleep(60);
    assert.deepEqual(heard.all.map((m) => m.text), ["one"], "the dropped message must not reach the room");
    assert.ok(myLogs.all.some((l) => /wasn't sent/.test(l.text)), "the sender is told, in their own feed");
    assert.equal(otherLogs.all.length, 0, "and nobody else is");
  });

  test("a blank message doesn't stamp the rate-limit clock and eat the next real one", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const heard = trackEvent(b, "chat");
    a.emit("chat", { text: "   " }); // whitespace only → nothing to send
    await sleep(30);
    a.emit("chat", { text: "hello" }); // …and this used to be swallowed by the blank one's stamp
    await sleep(80);
    assert.deepEqual(heard.all.map((m) => m.text), ["hello"]);
  });
});

// A tab CLOSE sends a close frame and is noticed in ~200ms, so every test above sees the pause
// machinery work. A silent network drop — the case the 30s grace exists for — is only noticed by
// the heartbeat, and Socket.IO's defaults (25s + 20s) left both players staring at a smoothly
// ticking clock for up to 45 seconds.
describe("rooms.js — heartbeat tuning", () => {
  test("a dead connection is noticed in seconds, well inside the reconnect grace", () => {
    const worstCase = PING_OPTIONS.pingInterval + PING_OPTIONS.pingTimeout;
    assert.ok(worstCase <= 12000, `detection worst case should be seconds, got ${worstCase}ms`);
    assert.ok(worstCase < GRACE_MS / 2, "and must leave most of the grace window for actually reconnecting");
    // The other direction matters too: a pingTimeout tight enough to trip on a brief mobile
    // stall would pause a live match (and, at worst, spend someone's grace window) over nothing.
    assert.ok(PING_OPTIONS.pingTimeout >= 4000, "but must tolerate a normal few-second hiccup");
  });

  test("the entrypoint actually hands those settings to the Socket.IO server", () => {
    // server/index.js boots Next, so it can't be required here — but the wiring is the whole fix.
    const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
    assert.match(src, /new Server\(server,\s*PING_OPTIONS\)/);
  });

  test("a silently dropped client is caught by the heartbeat and pauses the match", async () => {
    // A mechanism test, not a regression guard: what it pins down is that the pause/grace
    // machinery is reached by the ping timeout AT ALL, which is why the numbers asserted above are
    // what decide how fast a real drop shows. Its own server, because the real PING_OPTIONS would
    // mean waiting up to 10s here.
    //
    // 60/150 rather than 40/40. Detection is still sub-second, but the suite shares a machine with
    // twenty others: a 40ms timeout is shorter than an ordinary event-loop stall under that load,
    // so the server would time out the IDLE client too and the interleaving stopped matching what
    // this test asserts. It failed exactly that way in CI, and locally only at --test-concurrency=2.
    await withOwnServer({ socketOptions: { pingInterval: 60, pingTimeout: 150 } }, async ({ api, open }) => {
      const a = await open(), b = await open();
      const created = await emit(a, "createRoom", { name: "Alice" });
      const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
      await emit(a, "startMatch", {});
      const room = api.rooms.get(created.code);
      assert.equal(!!room.game.paused, false);

      // Dead air, not a close frame: the socket stays open, the client simply stops reading, so
      // it never answers a ping. This is the drop a phone in a tunnel actually produces.
      b.io.engine.transport.ws.pause();
      // Poll every consequence rather than asserting it on a fixed tick — they land in separate
      // turns of the loop, and which one you observe first isn't something to depend on.
      await waitUntil(() => room.game && room.game.paused, { what: "the heartbeat to notice the dead socket" });
      await waitUntil(() => room.players.get(joined.you) && !room.players.get(joined.you).connected,
        { what: "the dropped player to be marked offline" });
      assert.equal(room.players.has(joined.you), true, "…and the seat is still held for the grace window");
    });
  });
});

// "N went to single-player" on the owner dashboard is driven entirely by this one event.
describe("rooms.js — single-player session tagging", () => {
  test("enterSingleplayer tags the session, and the tag reaches the analytics write", async () => {
    const sessions = [];
    await withOwnServer({ analytics: { ...analytics, recordSession: (s) => sessions.push(s) } }, async ({ open }) => {
      const solo = await open();
      solo.emit("enterSingleplayer");
      await sleep(50);
      solo.close();
      await sleep(80);
      const [rec] = sessions;
      assert.ok(rec, "a session should have been recorded on disconnect");
      assert.equal(rec.singleplayer, true);
      assert.equal(rec.joined, false); // they never took a seat — this is the visit that used to be mis-tagged "browsed"
    });
  });

  test("a visitor who never leaves the lobby is not tagged as single-player", async () => {
    const sessions = [];
    await withOwnServer({ analytics: { ...analytics, recordSession: (s) => sessions.push(s) } }, async ({ open }) => {
      const browser = await open();
      await sleep(30);
      browser.close();
      await sleep(80);
      assert.equal(sessions.length, 1);
      assert.ok(!sessions[0].singleplayer);
    });
  });
});

// A seat used to be claimable by anyone who knew its playerId — and roomState broadcasts every
// player's id to everyone in the room, spectators included. So: watch a room, read the roster,
// emit `resume` with someone else's id, and you held their seat. Their chat identity, the host's
// authority if they were host, and `leaveRoom` made THEM forfeit their own match.
describe("rooms.js — a seat can only be reclaimed by whoever holds it", () => {
  test("the join ack hands back a seat token, and roomState never carries it", async () => {
    const a = await connect(), b = await connect();
    const seen = trackRoomState(a);
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    assert.equal(typeof created.seat, "string");
    assert.ok(created.seat.length >= 24);
    assert.notEqual(created.seat, joined.seat, "each seat gets its own");
    // The broadcast is the reason this has to be a secret at all.
    await sleep(80);
    for (const p of seen.current.players) {
      assert.equal(p.token, undefined, "roomState must never publish a seat token");
      assert.equal(JSON.stringify(p).includes(created.seat), false);
    }
  });

  test("resume without the token is refused", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const attacker = await connect();
    // Exactly the published information: the room code and the victim's playerId.
    const stolen = await emit(attacker, "resume", { code: created.code, playerId: joined.you });
    assert.equal(stolen.ok, false, "a playerId alone must not reclaim a seat");
    // The victim's seat still points at the victim's socket.
    const seat = roomsApi.rooms.get(created.code).players.get(joined.you);
    assert.equal(seat.socketId, b.id);
    assert.notEqual(seat.socketId, attacker.id);
  });

  test("resume with a wrong or another seat's token is refused", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const attacker = await connect();
    for (const guess of ["", "x", created.seat, "z".repeat(32)]) {
      const res = await emit(attacker, "resume", { code: created.code, playerId: joined.you, seat: guess });
      assert.equal(res.ok, false, `token ${JSON.stringify(guess.slice(0, 8))} must not work`);
    }
    assert.equal(roomsApi.rooms.get(created.code).players.get(joined.you).socketId, b.id);
  });

  test("the real owner still reconnects into their own seat", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    b.close();
    await sleep(120);
    const back = await connect();
    const res = await emit(back, "resume", { code: created.code, playerId: joined.you, seat: joined.seat });
    assert.equal(res.ok, true);
    assert.equal(res.you, joined.you);
    assert.equal(roomsApi.rooms.get(created.code).players.get(joined.you).socketId, back.id);
  });

  test("claiming a seated id without its token gets a NEW seat, not that one", async () => {
    // Falling through rather than refusing: an honest client that lost its token should still get
    // into a room it can see, and it must not land on top of the seat it can't prove is its own.
    // A race room, because a duel caps at two and the fall-through needs a free seat to land in.
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice", mode: "race" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const attacker = await connect();
    const res = await emit(attacker, "joinRoom", { code: created.code, name: "Eve", playerId: joined.you });
    assert.equal(res.ok, true);
    assert.notEqual(res.you, joined.you, "must not be handed the seat it claimed");
    assert.equal(roomsApi.rooms.get(created.code).players.get(joined.you).socketId, b.id, "victim keeps their seat");
  });

  test("a spectator claiming a seated id just spectates", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const attacker = await connect();
    const res = await emit(attacker, "spectateRoom", { code: created.code, name: "Eve", playerId: joined.you });
    assert.equal(res.ok, true);
    assert.equal(res.spectator, true, "no token means no seat");
    assert.equal(roomsApi.rooms.get(created.code).players.get(joined.you).socketId, b.id);
  });

  test("one socket never holds seats in two rooms at once", async () => {
    // The invariant behind the doResume fix. doResume never called leaveCurrentRoom, so a socket
    // that resumed into another room kept its old seat forever — the room was never released and
    // never reaped, and it still advertised a "connected" host nobody could play against.
    const a = await connect(), b = await connect();
    const first = await emit(a, "createRoom", { name: "Alice" });
    const second = await emit(b, "createRoom", { name: "Bob", mode: "race" });
    const moved = await emit(a, "joinRoom", { code: second.code, name: "Alice" });
    assert.equal(moved.ok, true);
    assert.equal(roomsApi.rooms.has(first.code), false, "the room left behind is released, not orphaned");
    const rooms = [...roomsApi.rooms.values()].filter((r) => [...r.players.values()].some((p) => p.socketId === a.id));
    assert.equal(rooms.length, 1, "exactly one room holds this socket");
    assert.equal(rooms[0].code, second.code);
  });
});

// `rematch` used to check only host + player count, so it bypassed every guard startMatch has: a
// host losing 0-4 could emit it and wipe the scoreboard, it left room.status out of step with a
// running game (which then let an outsider joinRoom into a live race), and it could start against
// a player who was mid-reconnect — the exact case startMatch refuses.
describe("rooms.js — rematch clears the same bar as starting a match", () => {
  async function startedDuel() {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });
    const started = await emit(a, "startMatch");
    assert.equal(started.ok, true);
    return { a, b, created, joined, room: roomsApi.rooms.get(created.code) };
  }

  test("a host cannot restart a match that is still running", async () => {
    const { a, room } = await startedDuel();
    room.game.scores = { ...room.game.scores };
    const res = await emit(a, "rematch");
    assert.equal(res.ok, false);
    assert.match(res.error, /Finish this match first/i);
  });

  test("a losing host cannot wipe the scoreboard", async () => {
    const { a, room, created, joined } = await startedDuel();
    // Host behind 1-4.
    room.game.scores[created.you] = 1;
    room.game.scores[joined.you] = 4;
    const res = await emit(a, "rematch");
    assert.equal(res.ok, false);
    assert.equal(room.game.scores[joined.you], 4, "the leader's score survives");
    assert.equal(room.game.scores[created.you], 1);
  });

  test("a finished match can be restarted", async () => {
    const { a, room } = await startedDuel();
    room.game.phase = "matchover";
    const res = await emit(a, "rematch");
    assert.equal(res.ok, true);
    assert.equal(room.status, "started");
  });

  test("a rematch waits for a disconnected player, like starting does", async () => {
    const { a, b, room } = await startedDuel();
    room.game.phase = "matchover";
    b.close();
    await sleep(140);
    const res = await emit(a, "rematch");
    assert.equal(res.ok, false);
    assert.match(res.error, /reconnect/i);
  });

  test("only the host may rematch", async () => {
    const { b, room } = await startedDuel();
    room.game.phase = "matchover";
    const res = await emit(b, "rematch");
    assert.equal(res.ok, false);
    assert.match(res.error, /host/i);
  });

  test("a socket in no room gets a clean refusal rather than silence", async () => {
    const c = await connect();
    const res = await emit(c, "rematch");
    assert.equal(res.ok, false);
    assert.match(res.error, /not in a room/i);
  });
});
