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

  test("asking to spectate a room you hold a seat in resumes you as a PLAYER, not a spectator", async () => {
    const a = await connect(), b = await connect();
    const created = await emit(a, "createRoom", { name: "Alice" });
    const joined = await emit(b, "joinRoom", { code: created.code, name: "Bob" });

    // Same playerId as a seated player. The client keys its read-only spectator UI off this
    // ack's `spectator` flag, so saying "true" here would leave a real player unable to play.
    const res = await emit(b, "spectateRoom", { code: created.code, name: "Bob", playerId: joined.you });
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
    const again = await emit(b, "joinRoom", { code: created.code, name: "fuck you", playerId: joined.you });
    assert.equal(again.ok, true);
    assert.equal(roomsApi.rooms.get(created.code).players.get(joined.you).name, "Bob");
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
    // Its own server with a tiny heartbeat: the real PING_OPTIONS would mean waiting up to 10s.
    // What this pins down is that the pause/grace machinery is reached by the ping timeout at
    // all — which is why the numbers asserted above are what decide how fast a real drop shows.
    await withOwnServer({ socketOptions: { pingInterval: 40, pingTimeout: 40 } }, async ({ api, open }) => {
      const a = await open(), b = await open();
      const created = await emit(a, "createRoom", { name: "Alice" });
      await emit(b, "joinRoom", { code: created.code, name: "Bob" });
      await emit(a, "startMatch", {});
      const room = api.rooms.get(created.code);
      assert.equal(!!room.game.paused, false);

      // Dead air, not a close frame: the socket stays open, the client simply stops reading, so
      // it never answers a ping. This is the drop a phone in a tunnel actually produces.
      b.io.engine.transport.ws.pause();
      await waitUntil(() => room.game.paused, { what: "the heartbeat to notice the dead socket" });
      assert.equal(room.game.paused, true, "the heartbeat has to be what notices");
      assert.equal(room.players.get([...room.players.keys()][1]).connected, false);
      assert.equal(room.players.size, 2, "…and the seat is still held for the grace window");
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
