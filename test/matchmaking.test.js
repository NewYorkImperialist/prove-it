"use strict";
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createMatchmaking } = require("../server/matchmaking.js");

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
  const newRoom = ({ mode, hostId, hostName, socketId, settings }) => {
    const room = { code: `R${rooms.length}`, mode, hostId, hostName, socketId, settings, players: new Map() };
    rooms.push(room);
    return room;
  };
  const attach = (room, socket, playerId) => { attached.push({ room: room.code, playerId, socketId: socket.id }); };
  const broadcast = () => {};
  return { rooms, attached, newRoom, attach, broadcast, DEFAULT_GROUPS: ["Geography"] };
}

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
