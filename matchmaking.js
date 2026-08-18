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

// deps: { newRoom, attach, broadcast, DEFAULT_GROUPS } — all from rooms.js's closure.
// graceMs is overridable (tests use a tiny value instead of waiting out the real 8s window).
function createMatchmaking({ newRoom, attach, broadcast, DEFAULT_GROUPS, graceMs = DEFAULT_GRACE_MS }) {
  let queue = []; // [{ playerId, socket, name }]
  let timer = null;

  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

  function broadcastStatus(startsAt) {
    const payload = { waiting: queue.length, startsInMs: startsAt ? Math.max(0, startsAt - Date.now()) : null };
    for (const e of queue) e.socket.emit("quickMatchStatus", payload);
  }

  function arm() {
    if (timer) return;
    const startsAt = Date.now() + graceMs;
    broadcastStatus(startsAt);
    timer = setTimeout(popBatch, graceMs);
    if (timer.unref) timer.unref();
  }

  function popBatch() {
    clearTimer();
    if (queue.length < MIN_TO_START) return; // someone left during the grace window — keep waiting
    const batch = queue.splice(0, MAX_TO_START);
    const host = batch[0];
    const room = newRoom({
      mode: "race", hostId: host.playerId, hostName: host.name, socketId: host.socket.id,
      settings: { groups: [...DEFAULT_GROUPS], timer: 45, format: 5, suddenDeath: false, maxPlayers: MAX_TO_START },
    });
    attach(room, host.socket, host.playerId);
    for (const e of batch.slice(1)) {
      room.players.set(e.playerId, { id: e.playerId, name: e.name, socketId: e.socket.id, connected: true });
      attach(room, e.socket, e.playerId);
    }
    broadcast(room);
    for (const e of batch) e.socket.emit("quickMatchFound", { code: room.code, you: e.playerId });
    if (queue.length >= MIN_TO_START) arm(); // leftover players beyond MAX_TO_START start their own batch
  }

  function join(socket, { name, playerId } = {}, ack) {
    const pid = playerId || (Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6));
    leave(socket); // no duplicate queue entries for the same socket
    const cleanedName = String(name || "").trim().slice(0, 20) || "Jayden Lin fanboy";
    queue.push({ playerId: pid, socket, name: cleanedName });
    ack?.({ ok: true, queued: true, you: pid });
    if (queue.length >= MIN_TO_START) arm(); else broadcastStatus(null);
    if (queue.length >= MAX_TO_START) popBatch();
  }

  function leave(socket) {
    const before = queue.length;
    queue = queue.filter((e) => e.socket !== socket);
    if (queue.length !== before && queue.length < MIN_TO_START) clearTimer();
  }

  return { join, leave };
}

module.exports = { createMatchmaking };
