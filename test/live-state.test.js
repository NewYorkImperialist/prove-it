"use strict";
// The bridge that lets the Next-rendered admin pages see the Express server's live memory.
//
// The failure this module exists to prevent is specific and nasty: a Next server component that
// required server/rooms.js would call createRooms() again and get its own brand-new, permanently
// empty Map. The dashboard would then render a completely plausible page reporting nobody online,
// no rooms, nothing wrong — while the real server was busy. A silently wrong status page is worse
// than a broken one, which is why liveState() throws instead of returning a default.
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { publishLiveState, liveState, hasLiveState } = require("../server/live-state.js");

// The module keeps state on globalThis, so each test has to start from a known place.
const KEY = Symbol.for("proveit.liveState");
let saved;
beforeEach(() => { saved = globalThis[KEY]; delete globalThis[KEY]; });
afterEach(() => { if (saved === undefined) delete globalThis[KEY]; else globalThis[KEY] = saved; });

describe("server/live-state.js", () => {
  test("what the server publishes is what the admin pages read", () => {
    const rooms = new Map([["ABCD", { code: "ABCD" }]]);
    publishLiveState({ rooms, getOnline: () => 3 });
    assert.equal(liveState().rooms, rooms, "the same Map, not a copy — the dashboard reads it live");
    assert.equal(liveState().getOnline(), 3);
  });

  test("it hands back the SAME object, so later mutations are visible", () => {
    // The dashboard renders per request and the rooms Map is mutated by socket handlers in between.
    // A snapshot would go stale the moment anyone joined a room.
    const rooms = new Map();
    publishLiveState({ rooms });
    rooms.set("WXYZ", { code: "WXYZ" });
    assert.equal(liveState().rooms.size, 1);
    assert.ok(liveState().rooms.has("WXYZ"));
  });

  test("reading before the server has published THROWS, rather than reporting an empty server", () => {
    // The whole point. An empty dashboard is a lie; an error is a bug report.
    assert.equal(hasLiveState(), false);
    assert.throws(() => liveState(), /live server state is not published/);
  });

  test("the error says what to do about it", () => {
    // Whoever hits this will be looking at a stack trace in a deploy log, not at this file.
    try {
      liveState();
      assert.fail("should have thrown");
    } catch (e) {
      assert.match(e.message, /publishLiveState/, "names the function that was not called");
      assert.match(e.message, /server\/index\.js/, "and where it should have been called from");
    }
  });

  test("publishing again replaces it, so a restart in one process doesn't serve stale handles", () => {
    publishLiveState({ rooms: new Map([["OLD", {}]]) });
    publishLiveState({ rooms: new Map([["NEW", {}]]) });
    assert.ok(liveState().rooms.has("NEW"));
    assert.equal(liveState().rooms.has("OLD"), false);
  });

  test("the global key is a registered Symbol, not a string property", () => {
    // Symbol.for so both sides of the module boundary resolve the same key, and so nothing can
    // collide with it by naming a global — or stumble over it in an Object.keys(globalThis) dump.
    publishLiveState({ ok: true });
    assert.equal(Object.keys(globalThis).includes("proveit.liveState"), false);
    assert.equal(globalThis[Symbol.for("proveit.liveState")].ok, true);
  });
});

describe("server/index.js publishes everything the admin surface needs", () => {
  const fs = require("fs");
  const path = require("path");
  const ROOT = path.join(__dirname, "..");

  test("the publish call carries every handle the Express admin router takes", () => {
    // routes/admin.js's dependency list is the definition of "what the dashboard needs". While the
    // port is in progress the two must stay in step, or a ported page loses a capability with no
    // error — createAdminRouter would just receive undefined.
    const index = fs.readFileSync(path.join(ROOT, "server/index.js"), "utf8");
    const admin = fs.readFileSync(path.join(ROOT, "routes/admin.js"), "utf8");
    const sig = admin.match(/function createAdminRouter\(\{([^}]*)\}\)/);
    assert.ok(sig, "could not find createAdminRouter's signature");
    const needed = sig[1].split(",").map((s) => s.trim()).filter(Boolean);
    const call = index.match(/publishLiveState\(\{([^}]*)\}\)/);
    assert.ok(call, "server/index.js must call publishLiveState");
    const published = call[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const n of needed) assert.ok(published.includes(n), `publishLiveState is missing ${n}`);
  });

  test("it publishes before the Next handler is wired up", () => {
    // Next's request handler is what renders the admin pages, so the bridge has to exist first.
    const index = fs.readFileSync(path.join(ROOT, "server/index.js"), "utf8");
    const pub = index.indexOf("publishLiveState({");
    const nextUse = index.indexOf("handleNext(req, res)");
    assert.ok(pub > 0, "no publishLiveState call");
    assert.ok(nextUse > pub, "Next is handling requests before the live state is published");
  });
});
