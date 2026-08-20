"use strict";
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createMatchmaking } = require("../server/matchmaking.js");
const { isBlocked } = require("../lib/name-filter.js");

beforeEach((t) => { t.mock.timers.enable({ apis: ["setTimeout"] }); });

// Fake socket: just enough for matchmaking.js to call .emit(event, payload) and use identity
// (=== comparisons) for leave()/dedup.
function fakeSocket(id) {
  const events = [];
  return { id, events, emit(event, payload) { events.push({ event, payload }); } };
}

function makeDeps() {
  const rooms = [];
  const attached = [];
  // Seats the host, exactly as rooms.js's newRoom does — otherwise uniqueName below sees an
  // empty roster and the collision this dep exists to prevent can never happen in a test.
  const newRoom = ({ mode, hostId, hostName, socketId, settings }) => {
    const room = { code: `R${rooms.length}`, mode, hostId, hostName, socketId, settings, players: new Map() };
    room.players.set(hostId, { id: hostId, name: cleanName(hostName), socketId, connected: true });
    rooms.push(room);
    return room;
  };
  const attach = (room, socket, playerId) => { attached.push({ room: room.code, playerId, socketId: socket.id }); };
  const broadcast = () => {};
  // rooms.js injects its own name gate (trim + 20 cap + the shared profanity filter); the same
  // pair of functions is what the real server passes in.
  const cleanName = (n) => String(n || "").trim().slice(0, 20) || "Jayden Lin fanboy";
  const nameRejected = (n) => (isBlocked(cleanName(n)) ? "That name isn't allowed — pick a different one." : null);
  const uniqueName = (room, n, selfPid) => {
    const base = cleanName(n);
    const taken = new Set([...room.players.values()].filter((p) => p.id !== selfPid).map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) { const c = `${base.slice(0, 17).trim()} ${i}`; if (!taken.has(c)) return c; }
    return base;
  };
  return { rooms, attached, newRoom, attach, broadcast, cleanName, uniqueName, nameRejected, DEFAULT_GROUPS: ["Geography"] };
}

// Every quickMatchStatus a socket has been sent, oldest first.
const statuses = (s) => s.events.filter((e) => e.event === "quickMatchStatus").map((e) => e.payload);
const lastStatus = (s) => statuses(s).slice(-1)[0] || null;

describe("matchmaking queue", () => {
  test("a single queued player doesn't get matched yet", () => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1");
    let ack; mm.join(s1, { name: "Alice" }, (r) => (ack = r));
    assert.equal(ack.queued, true);
    assert.equal(deps.rooms.length, 0);
    assert.ok(s1.events.some((e) => e.event === "quickMatchStatus"));
  });

  test("two players reaching the minimum starts the grace countdown, then pops into one race room", (t) => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1"), s2 = fakeSocket("s2");
    mm.join(s1, { name: "Alice" }, () => {});
    mm.join(s2, { name: "Bob" }, () => {});
    assert.equal(deps.rooms.length, 0); // still in the grace window
    t.mock.timers.tick(50);
    assert.equal(deps.rooms.length, 1);
    assert.equal(deps.rooms[0].mode, "race");
    const found1 = s1.events.find((e) => e.event === "quickMatchFound");
    const found2 = s2.events.find((e) => e.event === "quickMatchFound");
    assert.ok(found1 && found2);
    assert.equal(found1.payload.code, found2.payload.code);
    assert.equal(deps.attached.length, 2); // both players attached to the new room
  });

  test("a player leaving during the grace window cancels the countdown below the minimum", (t) => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1"), s2 = fakeSocket("s2");
    mm.join(s1, {}, () => {});
    mm.join(s2, {}, () => {});
    mm.leave(s2);
    t.mock.timers.tick(50);
    assert.equal(deps.rooms.length, 0, "should not pop a batch below the minimum");
  });

  test("reaching the max batch size pops immediately without waiting out the grace window", () => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    for (let i = 0; i < 6; i++) mm.join(fakeSocket(`s${i}`), { name: `P${i}` }, () => {});
    assert.equal(deps.rooms.length, 1);
    assert.equal(deps.attached.length, 6);
  });

  // The status line is the ONLY thing a queued player has to look at, so every change to the
  // queue has to reach everyone in it — silence reads as a stuck queue.
  test("a third player joining updates the count for the players already waiting", () => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1"), s2 = fakeSocket("s2"), s3 = fakeSocket("s3");
    mm.join(s1, { name: "Alice" }, () => {});
    mm.join(s2, { name: "Bob" }, () => {});
    assert.equal(lastStatus(s1).waiting, 2);
    mm.join(s3, { name: "Cleo" }, () => {});
    // arm() used to bail out because the batch timer already existed, so the third player was
    // invisible: A and B kept reading "2 waiting" and C saw only its own local placeholder.
    assert.equal(lastStatus(s1).waiting, 3);
    assert.equal(lastStatus(s2).waiting, 3);
    assert.equal(lastStatus(s3).waiting, 3);
  });

  test("the last player left in the queue is told the countdown was cancelled", () => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1"), s2 = fakeSocket("s2");
    mm.join(s1, { name: "Alice" }, () => {});
    mm.join(s2, { name: "Bob" }, () => {});
    assert.ok(lastStatus(s1).startsInMs != null, "the countdown is on with two waiting");
    mm.leave(s2);
    // leave() cleared the batch timer and said nothing, so Alice sat on "2 waiting · starting in
    // 8s…" forever with no armed timer behind it.
    assert.equal(lastStatus(s1).waiting, 1);
    assert.equal(lastStatus(s1).startsInMs, null);
  });

  test("a leaving socket that was never queued doesn't spam the queue with a status", () => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1"), stranger = fakeSocket("s9");
    mm.join(s1, { name: "Alice" }, () => {});
    const before = statuses(s1).length;
    mm.leave(stranger); // rooms.js calls leave() on every disconnect, queued or not
    assert.equal(statuses(s1).length, before);
  });

  test("an armed countdown is broadcast as an absolute deadline as well as a remaining time", () => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 5000 });
    const s1 = fakeSocket("s1"), s2 = fakeSocket("s2");
    mm.join(s1, {}, () => {});
    mm.join(s2, {}, () => {});
    const st = lastStatus(s1);
    // startsInMs is a snapshot the client formats once and never ticks; startsAt lets a client
    // count down honestly instead.
    assert.ok(st.startsInMs > 4000 && st.startsInMs <= 5000);
    assert.ok(st.startsAt >= Date.now() + 4000);
  });

  test("two nameless players in one batch don't both become the blank-name fallback", (t) => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1"), s2 = fakeSocket("s2");
    mm.join(s1, {}, () => {});
    mm.join(s2, {}, () => {});
    t.mock.timers.tick(50);
    const names = [...deps.rooms[0].players.values()].map((p) => p.name);
    assert.equal(names.length, 2);
    assert.equal(new Set(names).size, 2, `a quick-match batch seated two players called the same thing: ${names.join(" / ")}`);
  });

  test("a profane display name is refused rather than quietly queued", () => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1");
    let ack; mm.join(s1, { name: "fucking idiot" }, (r) => (ack = r));
    assert.equal(ack.ok, false);
    assert.match(ack.error, /isn't allowed/);
    assert.equal(statuses(s1).length, 0, "and they're not in the queue at all");
  });

  test("joining twice with the same socket doesn't create a duplicate queue entry", (t) => {
    const deps = makeDeps();
    const mm = createMatchmaking({ ...deps, graceMs: 50 });
    const s1 = fakeSocket("s1"), s2 = fakeSocket("s2");
    mm.join(s1, { name: "Alice" }, () => {});
    mm.join(s1, { name: "Alice again" }, () => {}); // re-join before matching — should replace, not duplicate
    mm.join(s2, { name: "Bob" }, () => {});
    t.mock.timers.tick(50);
    assert.equal(deps.rooms.length, 1);
    assert.equal(deps.attached.length, 2); // not 3
  });
});
