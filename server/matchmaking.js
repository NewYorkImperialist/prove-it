"use strict";
// Quick-match queue for the "Challenge Race" mode. Ephemeral/in-memory (resets on restart,
// same philosophy as rooms.js's own `rooms` Map) — players waiting for an auto-paired race
// are batched together with a short grace window so 3+ players can land in the same race
// instead of always defaulting to a 1v1, then dropped into a freshly created race room.
//
// v1 scope: no category filter (always DEFAULT_GROUPS) — quick-match only has to solve
// "how many people are waiting", not a bucketed matching problem.

const MIN_TO_START = 2;
const MAX_TO_START = 6;
const DEFAULT_GRACE_MS = 8000;

// deps: { newRoom, attach, broadcast, cleanName, uniqueName, nameRejected, DEFAULT_GROUPS } — all from
// rooms.js's closure, so a quick-match name goes through exactly the same trim/cap/profanity
// gate as a name typed into a room code (this module used to clean names with its own copy of
// the trim-and-truncate, which meant the filter didn't apply here).
// graceMs is overridable (tests use a tiny value instead of waiting out the real 8s window).
function createMatchmaking({ newRoom, attach, broadcast, cleanName, uniqueName, nameRejected, DEFAULT_GROUPS, graceMs = DEFAULT_GRACE_MS }) {
  let queue = []; // [{ playerId, socket, name }]
  let timer = null;
  let startsAt = null; // when the armed batch pops (null = no countdown running)

  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } startsAt = null; }

  // Everyone in the queue hears about every change to it. Anything less lies: a third player
  // used to join in silence (arm() bailed out because a timer already existed, so nobody's
  // "2 waiting" ever updated), and a queue that SHRANK below the minimum left the last player
  // reading "starting in 8s…" forever with no timer behind it.
  function broadcastStatus() {
    // startsInMs is a snapshot the client formats once; startsAt is the absolute deadline, so a
    // client that wants to tick the countdown honestly can (hooks/useMultiplayer.js still reads
    // only startsInMs — ticking it is a client-side change).
    const payload = { waiting: queue.length, startsInMs: startsAt ? Math.max(0, startsAt - Date.now()) : null, startsAt };
    for (const e of queue) e.socket.emit("quickMatchStatus", payload);
  }

  function arm() {
    if (!timer) {
      startsAt = Date.now() + graceMs;
      timer = setTimeout(popBatch, graceMs);
      if (timer.unref) timer.unref();
    }
    broadcastStatus(); // armed just now or already armed, the queue changed either way
  }

  function popBatch() {
    clearTimer();
    if (queue.length < MIN_TO_START) return broadcastStatus(); // someone left during the grace window — keep waiting, countdown off
    const batch = queue.splice(0, MAX_TO_START);
    const host = batch[0];
    const room = newRoom({
      mode: "race", hostId: host.playerId, hostName: host.name, socketId: host.socket.id,
      settings: { groups: [...DEFAULT_GROUPS], timer: 45, format: 5, suddenDeath: false, maxPlayers: MAX_TO_START, increment: 0 },
    });
    attach(room, host.socket, host.playerId);
    // uniqueName, not e.name: a batch is exactly where two people who never typed a name meet,
    // and "Jayden Lin fanboy" twice on one scoreboard is unreadable for both of them.
    for (const e of batch.slice(1)) {
      room.players.set(e.playerId, { id: e.playerId, name: uniqueName(room, e.name, e.playerId), socketId: e.socket.id, connected: true });
      attach(room, e.socket, e.playerId);
    }
    broadcast(room);
    for (const e of batch) e.socket.emit("quickMatchFound", { code: room.code, you: e.playerId });
    if (queue.length >= MIN_TO_START) arm(); // leftover players beyond MAX_TO_START start their own batch
    else if (queue.length) broadcastStatus(); // …or find out they're back to waiting for one more
  }

  function join(socket, { name, playerId } = {}, ack) {
    const bad = nameRejected(name);
    if (bad) return ack?.({ ok: false, error: bad }); // before leave(), so a refusal can't drop them out of the queue they're already in
    const pid = playerId || (Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6));
    leave(socket); // no duplicate queue entries for the same socket
    queue.push({ playerId: pid, socket, name: cleanName(name) });
    ack?.({ ok: true, queued: true, you: pid });
    if (queue.length >= MIN_TO_START) arm(); else broadcastStatus();
    if (queue.length >= MAX_TO_START) popBatch();
  }

  function leave(socket) {
    const before = queue.length;
    queue = queue.filter((e) => e.socket !== socket);
    if (queue.length === before) return; // wasn't queued (leave() is also called on every disconnect)
    if (queue.length < MIN_TO_START) clearTimer(); // nobody left to start against → cancel the countdown
    broadcastStatus(); // and say so, whether the countdown survived or not
  }

  return { join, leave };
}

module.exports = { createMatchmaking };
