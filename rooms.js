"use strict";
// Multiplayer room state + the Socket.IO connection/event wiring. A room is:
//   code -> { code, hostId, status, settings, players: Map<playerId, {id,name,socketId,connected}>,
//             graceTimeouts: Map<playerId, Timeout> }
// Identity is the stable playerId (the client keeps it in sessionStorage), NOT the
// socket id — so a reconnect with a new socket re-claims the same player slot.

const { createMatchmaking } = require("./matchmaking.js");

const TIMERS = [15, 30, 45, 60];
const TARGETS = [3, 5, 10]; // plus null = endless (duel mode's win target)
const FORMATS = [3, 5, null]; // best-of-3 / best-of-5 / endless (race mode's round-win target)
const isValidIncrement = (n) => Number.isInteger(n) && n >= 0 && n <= 30; // bonus seconds per correct answer
const MAX_PLAYERS = 2; // the 1v1 duel is always exactly 2
const MAX_RACE_PLAYERS = 8; // race rooms allow a small group
const MIN_RACE_PLAYERS = 2;
const GRACE_MS = 30000; // time to reconnect before forfeiting

// ---- client IP + rough geolocation (owner-only analytics) ----
function clientIp(headers, fallback) {
  const h = headers || {};
  const xff = (h["x-forwarded-for"] || "").split(",")[0].trim();
  return (h["fly-client-ip"] || xff || fallback || "").replace(/^::ffff:/, "").trim() || null;
}
const geoCache = new Map(); // ip -> "City, Region, Country" (null = looked up, unknown)
async function geoLookup(ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|::1|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return null; // skip local/private
  if (geoCache.has(ip)) return geoCache.get(ip);
  if (typeof fetch !== "function") return null;
  let out = null;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j && j.success) out = [j.city, j.region, j.country].filter(Boolean).join(", ") || j.country || null;
  } catch { /* network/timeout → leave unknown */ }
  geoCache.set(ip, out);
  return out;
}
const deviceOf = (socket) => (/Mobile|Android|iPhone|iPad|iPod/i.test(socket.handshake.headers["user-agent"] || "") ? "mobile" : "desktop");

// io: the Socket.IO server. engine: game-engine.js (the 1v1 duel). raceEngine: race-engine.js
// (the live "Challenge Race" mode — room.mode distinguishes which engine owns room.game).
// analytics: stats.js (persistent history). CATEGORY_GROUPS/DEFAULT_GROUPS: lib/category-data.js.
function createRooms({ io, engine, raceEngine, analytics, CATEGORY_GROUPS, DEFAULT_GROUPS, quickMatchGraceMs }) {
  const rooms = new Map();
  const engineFor = (room) => (room.mode === "race" ? raceEngine : engine);
  const capFor = (room) => (room.mode === "race" ? (room.settings?.maxPlayers || MAX_RACE_PLAYERS) : MAX_PLAYERS);
  const minFor = (room) => (room.mode === "race" ? MIN_RACE_PLAYERS : MAX_PLAYERS);
  let lockdown = false; // owner maintenance kill-switch: blocks new games until toggled back on
  const serverStartedAt = Date.now();
  const stats = { roomsCreated: 0, gamesStarted: 0, peakRooms: 0 }; // resets on server restart (no DB)
  function touch(room) { if (room) room.lastActivityAt = Date.now(); } // mark recent activity for the idle clock
  let online = 0; // live count of connected clients (people with the site open)
  function broadcastPresence() { io.emit("presence", { online }); }

  function makeCode() {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let code;
    do {
      code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    } while (rooms.has(code));
    return code;
  }
  function genId() {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  }
  function cleanName(name) {
    return String(name || "").trim().slice(0, 20) || "Jayden Lin fanboy";
  }

  function roomState(room) {
    return {
      code: room.code, hostId: room.hostId, status: room.status, mode: room.mode, settings: room.settings,
      players: [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, isHost: p.id === room.hostId, connected: p.connected, crown: !!p.crown,
      })),
      spectators: room.spectators ? [...room.spectators.values()].map((s) => ({ id: s.id, name: s.name })) : [],
    };
  }
  function broadcast(room) { touch(room); io.to(room.code).emit("roomState", roomState(room)); }

  // Shared room construction, used both by the explicit "create room" flow and by
  // matchmaking.js's auto-paired quick-match flow — one place builds the room object.
  function newRoom({ mode, hostId, hostName, socketId, settings }) {
    const isRace = mode === "race";
    const code = makeCode();
    const now = Date.now();
    const room = { code, hostId, status: "waiting", mode: isRace ? "race" : "duel",
      settings: settings || (isRace
        ? { groups: [...DEFAULT_GROUPS], timer: 45, format: 5, suddenDeath: false, maxPlayers: MAX_RACE_PLAYERS, increment: 0 }
        : { groups: [...DEFAULT_GROUPS], timer: 30, target: 5, autoAdvance: true, increment: 0 }),
      players: new Map(), spectators: new Map(), graceTimeouts: new Map(), createdAt: now, lastActivityAt: now };
    room.players.set(hostId, { id: hostId, name: cleanName(hostName), socketId, connected: true });
    rooms.set(code, room);
    stats.roomsCreated++; stats.peakRooms = Math.max(stats.peakRooms, rooms.size);
    return room;
  }

  function attach(room, socket, playerId) {
    const p = room.players.get(playerId);
    p.socketId = socket.id; p.connected = true;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    if (socket.data.session) { socket.data.session.joined = true; socket.data.session.name = p.name; }
  }

  // Is every seated player currently online? (A paused match may only resume once they all are.)
  const allConnected = (room) => [...room.players.values()].every((p) => p.connected);

  // Full removal (explicit leave, or grace expiry).
  function removePlayer(room, playerId) {
    const wasInGame = !!room.game;
    room.players.delete(playerId);
    // Only this player's countdown — anyone else who is mid-reconnect keeps their own.
    clearTimeout(room.graceTimeouts?.get(playerId));
    room.graceTimeouts?.delete(playerId);
    if (room.players.size === 0) {
      if (room.game?.timeout) clearTimeout(room.game.timeout);
      for (const t of room.graceTimeouts?.values() || []) clearTimeout(t);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === playerId) room.hostId = [...room.players.keys()][0];
    // Race matches keep going with whoever's left (only dropping to 1 player ends it by
    // forfeit); the 1v1 duel has no such concept — any departure ends it immediately.
    if (wasInGame) { if (room.mode === "race") raceEngine.playerLeftMatch(io, room, playerId); else engine.endGameForLeaver(io, room, playerId); }
    broadcast(room);
  }

  // Owner-forced room shutdown: tell everyone, drop timers, evict sockets, delete the room.
  function closeRoom(code) {
    const room = rooms.get(code);
    if (!room) return false;
    if (room.game?.timeout) clearTimeout(room.game.timeout);
    for (const t of room.graceTimeouts?.values() || []) clearTimeout(t);
    rooms.delete(code);             // remove first: any reconnect-resume will now fail → client lands home
    io.to(code).emit("roomClosed"); // clean clients leave with a message…
    // …then hard-evict everyone once the message flushes (covers any stale/cached client too)
    setTimeout(() => io.in(code).disconnectSockets(true), 150);
    console.log(`🛑 room ${code} closed by owner`);
    return true;
  }

  function closeAllRooms() { let n = 0; for (const code of [...rooms.keys()]) if (closeRoom(code)) n++; return n; }
  // Quick-match queue for the race mode — pairs/batches waiting players into a fresh race
  // room. Lives in its own module (matchmaking.js) but is tightly coupled to this closure's
  // room-creation/attach/broadcast primitives, so it's instantiated here rather than injected
  // from server.js the way engine/raceEngine are.
  const matchmaking = createMatchmaking({ newRoom, attach, broadcast, DEFAULT_GROUPS, graceMs: quickMatchGraceMs });

  function leaveCurrentRoom(socket) {
    const code = socket.data.roomCode, pid = socket.data.playerId;
    socket.data.roomCode = null;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    socket.leave(code);
    if (room.players.has(pid)) removePlayer(room, pid);
    else if (room.spectators?.has(pid)) { room.spectators.delete(pid); broadcast(room); }
  }

  io.on("connection", (socket) => {
    console.log(`✅ connected: ${socket.id}`);
    online++; broadcastPresence();
    socket.on("latencyPing", (ack) => { if (typeof ack === "function") ack(); }); // RTT probe for the client's "X ms" indicator
    socket.on("enterSingleplayer", () => { if (socket.data.session) socket.data.session.singleplayer = true; }); // they left the lobby for Solo/Daily
    const ip = clientIp(socket.handshake.headers, socket.handshake.address);
    socket.data.session = { connectedAt: Date.now(), device: deviceOf(socket), joined: false, spectated: false, played: false, name: null, ip, visitor_id: null, tz: null, locale: null, geo: null };
    geoLookup(ip).then((g) => { if (socket.data.session) socket.data.session.geo = g; }); // async; resolved well before disconnect
    // Client reports its persistent visitor id + timezone/locale right after connecting.
    socket.on("clientMeta", (m = {}) => {
      const ss = socket.data.session; if (!ss) return;
      if (m.visitorId) ss.visitor_id = String(m.visitorId).slice(0, 40);
      if (m.tz) ss.tz = String(m.tz).slice(0, 40);
      if (m.locale) ss.locale = String(m.locale).slice(0, 20);
    });

    function doResume(room, pid, ack) {
      attach(room, socket, pid);
      // They're back — cancel their own forfeit countdown, not another player's.
      clearTimeout(room.graceTimeouts?.get(pid));
      room.graceTimeouts?.delete(pid);
      io.to(room.code).emit("opponentStatus", { connected: true, name: room.players.get(pid).name });
      ack?.({ ok: true, code: room.code, you: pid, inGame: !!room.game, mode: room.mode });
      broadcast(room);
      // Unpause only once EVERYONE is back: with a per-player grace timer two players can be
      // away at the same time, and the first one to return must not restart the other's clock.
      if (room.game) {
        if (allConnected(room)) engineFor(room).resumeGame(io, room); // unpause + push game state
        else engineFor(room).resync(io, room); // still waiting on someone — just catch them up
      }
    }

    // mode: "duel" (default) or "race". raceSettings: {groups, timer, format, suddenDeath, maxPlayers, increment} — ignored for duel rooms.
    socket.on("createRoom", ({ name, playerId, mode, raceSettings } = {}, ack) => {
      if (lockdown) return ack?.({ ok: false, error: "The game is down for maintenance — check back soon." });
      leaveCurrentRoom(socket);
      const pid = playerId || genId();
      const isRace = mode === "race";
      const settings = isRace ? {
        groups: (raceSettings?.groups?.length ? raceSettings.groups.filter((k) => CATEGORY_GROUPS[k]) : null) || [...DEFAULT_GROUPS],
        timer: TIMERS.includes(raceSettings?.timer) ? raceSettings.timer : 45,
        format: FORMATS.includes(raceSettings?.format) ? raceSettings.format : 5,
        suddenDeath: !!raceSettings?.suddenDeath,
        maxPlayers: Number.isInteger(raceSettings?.maxPlayers) ? Math.min(MAX_RACE_PLAYERS, Math.max(MIN_RACE_PLAYERS, raceSettings.maxPlayers)) : MAX_RACE_PLAYERS,
        increment: isValidIncrement(raceSettings?.increment) ? raceSettings.increment : 0,
      } : undefined;
      const room = newRoom({ mode, hostId: pid, hostName: name, socketId: socket.id, settings });
      attach(room, socket, pid);
      console.log(`🏠 room ${room.code} created (${room.mode})`);
      ack?.({ ok: true, code: room.code, you: pid, mode: room.mode });
      broadcast(room);
    });

    socket.on("joinRoom", ({ code, name, playerId } = {}, ack) => {
      if (lockdown) return ack?.({ ok: false, error: "The game is down for maintenance — check back soon." });
      code = String(code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return ack?.({ ok: false, error: "No room with that code." });
      const pid = playerId || genId();
      if (room.players.has(pid)) return doResume(room, pid, ack); // rejoining your own slot
      if (room.players.size >= capFor(room)) return ack?.({ ok: false, error: "That room is full." });
      if (room.status !== "waiting") return ack?.({ ok: false, error: "That game already started." });
      leaveCurrentRoom(socket);
      room.players.set(pid, { id: pid, name: cleanName(name), socketId: socket.id, connected: true });
      attach(room, socket, pid);
      console.log(`➕ joined room ${code}`);
      ack?.({ ok: true, code, you: pid, mode: room.mode });
      broadcast(room);
    });

    // Quick-match: queue for the race mode and get auto-paired/batched into a fresh room.
    socket.on("quickMatchJoin", (payload = {}, ack) => {
      if (lockdown) return ack?.({ ok: false, error: "The game is down for maintenance — check back soon." });
      leaveCurrentRoom(socket);
      matchmaking.join(socket, payload, ack);
    });
    socket.on("quickMatchLeave", (_p, ack) => { matchmaking.leave(socket); ack?.({ ok: true }); });

    // Join a room as a read-only spectator (watch the game; can chat but can't play).
    socket.on("spectateRoom", ({ code, name, playerId } = {}, ack) => {
      if (lockdown) return ack?.({ ok: false, error: "The game is down for maintenance — check back soon." });
      code = String(code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return ack?.({ ok: false, error: "No room with that code." });
      const pid = playerId || genId();
      if (room.players.has(pid)) return doResume(room, pid, ack); // they're actually a player → resume their slot
      leaveCurrentRoom(socket);
      if (!room.spectators) room.spectators = new Map();
      room.spectators.set(pid, { id: pid, name: cleanName(name), socketId: socket.id });
      socket.join(code);
      socket.data.roomCode = code; socket.data.playerId = pid; socket.data.spectator = true;
      if (socket.data.session) { socket.data.session.spectated = true; socket.data.session.name = cleanName(name); }
      console.log(`👀 spectating room ${code}`);
      ack?.({ ok: true, code, you: pid, spectator: true, inGame: !!room.game, mode: room.mode });
      broadcast(room);
      if (room.game) engineFor(room).resync(io, room); // push current game state to the new spectator
    });

    // 👻 Owner-only INVISIBLE watch: joins the room's broadcast feed without ever appearing
    // in the players/spectators list, the online count, chat, or typing. Gated by OWNER_KEY.
    socket.on("ghostWatch", ({ code, key } = {}, ack) => {
      if (!process.env.OWNER_KEY || key !== process.env.OWNER_KEY) return ack?.({ ok: false, error: "Not authorized." });
      code = String(code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return ack?.({ ok: false, error: "No room with that code." });
      leaveCurrentRoom(socket);
      socket.join(code); // receive all future roomState/gameState/chat broadcasts…
      socket.data.roomCode = code; socket.data.playerId = genId(); socket.data.spectator = true; socket.data.ghost = true;
      if (!socket.data.ghostUncounted) { socket.data.ghostUncounted = true; online = Math.max(0, online - 1); broadcastPresence(); } // …but stay out of the online count
      console.log(`👻 ghost-watching room ${code}`);
      ack?.({ ok: true, code, you: socket.data.playerId, ghost: true, inGame: !!room.game });
      socket.emit("roomState", roomState(room));  // current lobby/players, to the ghost only
      if (room.game) engineFor(room).resync(io, room); // current game state (re-broadcast is idempotent for players)
    });

    // Reconnect to an existing slot (after refresh / network drop).
    socket.on("resume", ({ code, playerId } = {}, ack) => {
      code = String(code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room || !playerId || !room.players.has(playerId)) return ack?.({ ok: false });
      console.log(`🔄 resumed room ${code}`);
      doResume(room, playerId, ack);
    });

    // Owner-only vanity crown 👑. Gated by a server-side secret (OWNER_KEY, set as a Fly secret —
    // never in the repo). Nobody can crown themselves without the key, so it stays exclusive.
    socket.on("setCrown", ({ on, key } = {}) => {
      const room = rooms.get(socket.data.roomCode);
      const p = room?.players.get(socket.data.playerId);
      if (!p) return;
      if (!process.env.OWNER_KEY || key !== process.env.OWNER_KEY) return; // wrong/absent key → ignored
      p.crown = !!on;
      broadcast(room);
      engineFor(room).resync(io, room); // refresh in-game name labels too
    });

    // Change your display name — works in the lobby AND mid-game.
    socket.on("setName", ({ name } = {}) => {
      const room = rooms.get(socket.data.roomCode);
      const p = room?.players.get(socket.data.playerId) || room?.spectators?.get(socket.data.playerId);
      if (!p) return;
      p.name = cleanName(name);
      if (socket.data.session) socket.data.session.name = p.name;
      if (room.game && room.game.names && room.players.has(socket.data.playerId)) room.game.names[socket.data.playerId] = p.name;
      broadcast(room);
      if (room.game) engineFor(room).resync(io, room); // refresh in-game name labels
    });

    // Host configures the DUEL room — before starting (all settings) and mid-game (timer/target/auto).
    socket.on("setSettings", ({ groups, timer, target, autoAdvance, increment } = {}) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.mode === "race" || room.hostId !== socket.data.playerId) return; // race rooms use raceSetSettings
      const s = room.settings;
      const inGame = room.status !== "waiting";
      if (!inGame && Array.isArray(groups)) { // categories changed mid-game go through setGroups instead
        const valid = groups.filter((k) => CATEGORY_GROUPS[k]);
        if (valid.length) s.groups = valid; // never allow zero
      }
      const patch = {};
      if (TIMERS.includes(timer)) { s.timer = timer; patch.timer = timer; }
      if (target === null || TARGETS.includes(target)) { s.target = target; patch.target = target; }
      if (typeof autoAdvance === "boolean") { s.autoAdvance = autoAdvance; patch.autoAdvance = autoAdvance; }
      if (isValidIncrement(increment)) { s.increment = increment; patch.increment = increment; }
      broadcast(room);
      if (inGame && room.game) engine.applyLiveSettings(io, room, patch); // apply to the live match
    });

    // Host configures the RACE room — format/suddenDeath lock once the match starts; groups/timer stay live-adjustable.
    socket.on("raceSetSettings", ({ groups, timer, format, suddenDeath, increment } = {}) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.mode !== "race" || room.hostId !== socket.data.playerId) return;
      const s = room.settings;
      const inGame = room.status !== "waiting";
      if (!inGame) {
        if (Array.isArray(groups)) { const valid = groups.filter((k) => CATEGORY_GROUPS[k]); if (valid.length) s.groups = valid; }
        if (FORMATS.includes(format)) s.format = format;
        if (typeof suddenDeath === "boolean") s.suddenDeath = suddenDeath;
      }
      const patch = {};
      if (TIMERS.includes(timer)) { s.timer = timer; patch.timer = timer; }
      if (isValidIncrement(increment)) { s.increment = increment; patch.increment = increment; }
      if (inGame && Array.isArray(groups)) { const valid = groups.filter((k) => CATEGORY_GROUPS[k]); if (valid.length) patch.groups = valid; }
      broadcast(room);
      if (inGame && room.game) raceEngine.applyLiveSettings(io, room, patch);
    });

    // Host changes categories mid-match (applies next round).
    socket.on("setGroups", ({ groups } = {}) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !room.game || room.hostId !== socket.data.playerId) return;
      engineFor(room).setGroups(io, room, groups);
    });

    socket.on("startMatch", (_payload, ack) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room) return ack?.({ ok: false, error: "You're not in a room." });
      if (room.hostId !== socket.data.playerId) return ack?.({ ok: false, error: "Only the host can start." });
      if (room.players.size < minFor(room)) return ack?.({ ok: false, error: room.mode === "race" ? "Need at least 2 players to start." : "Need 2 players to start." });
      // A match already in progress is not restartable: starting over would throw away everyone's
      // scores mid-round, and the discarded game's timers would keep firing against the new one.
      // Use "rematch" once it's over instead.
      if (room.game || room.status === "started") return ack?.({ ok: false, error: "That game is already in progress." });
      // Don't start against someone who is mid-reconnect — the match would run unpaused with a
      // player who can't see it, then forfeit the moment their grace window expired.
      for (const pl of room.players.values()) {
        if (!pl.connected) return ack?.({ ok: false, error: `Waiting for ${pl.name} to reconnect…` });
      }
      room.status = "started";
      stats.gamesStarted++;
      for (const pl of room.players.values()) { const sk = io.sockets.sockets.get(pl.socketId); if (sk?.data?.session) sk.data.session.played = true; }
      console.log(`▶️ room ${room.code} started (${room.mode})`);
      ack?.({ ok: true });
      engineFor(room).startMatch(io, room);
    });

    // ---------- gameplay intents (ignored while paused; engine validates the rest) ----------
    // Game actions are players-only — spectators (not in room.players) are silently ignored.
    // Duel/race events are further gated by mode so, e.g., a stray "voteEnd" from a duel client
    // can never reach a race room's game state (their shapes aren't compatible).
    // A paused game drops the intent — but it has to SAY so. Pause leaves the phase and turn
    // untouched, so the client still classifies typing as an answer; dropping it without an ack
    // meant the input cleared, the error branch never ran, and the text reached nobody.
    const withGame = (fn) => (...args) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !room.game || !room.players.has(socket.data.playerId)) return;
      if (room.game.paused) {
        const ack = args[args.length - 1];
        if (typeof ack === "function") ack({ ok: false, error: "The game is paused — press / to chat instead." });
        return;
      }
      touch(room);
      fn(room, ...args);
    };
    const withDuelGame = (fn) => withGame((room, ...args) => { if (room.mode !== "race") fn(room, ...args); });
    const withRaceGame = (fn) => withGame((room, ...args) => { if (room.mode === "race") fn(room, ...args); });
    socket.on("open", withDuelGame((room, { n } = {}, ack) => engine.handleOpen(io, room, socket, n, ack)));
    socket.on("raise", withDuelGame((room, { toN } = {}, ack) => engine.handleRaise(io, room, socket, toN, ack)));
    socket.on("proveIt", withDuelGame((room, _p, ack) => engine.handleProveIt(io, room, socket, ack)));
    socket.on("answer", withDuelGame((room, { text } = {}, ack) => engine.handleAnswer(io, room, socket, text, ack)));
    socket.on("judge", withDuelGame((room, { answerId, accept } = {}) => engine.handleJudge(io, room, socket, { answerId, accept })));
    socket.on("rejectAll", withDuelGame((room) => engine.handleRejectAll(io, room, socket)));
    socket.on("revokeGrant", withDuelGame((room, { grantId } = {}) => engine.handleRevokeGrant(io, room, socket, grantId)));
    socket.on("giveUp", withDuelGame((room) => engine.handleGiveUp(io, room, socket)));
    socket.on("pauseRound", withDuelGame((room) => engine.handlePauseRound(io, room, socket)));
    socket.on("nextRound", withDuelGame((room) => engine.handleNextRound(io, room, socket)));
    socket.on("voteSkip", withGame((room) => engineFor(room).handleVoteSkip(io, room, socket))); // both modes
    socket.on("voteEnd", withDuelGame((room) => engine.handleVoteEnd(io, room, socket)));
    socket.on("raceAnswer", withRaceGame((room, { text } = {}, ack) => raceEngine.handleAnswer(io, room, socket, text, ack)));
    socket.on("raceApproveMiss", withRaceGame((room, { targetId, missId } = {}) => raceEngine.handleApproveMiss(io, room, socket, targetId, missId)));
    socket.on("raceVoteEnd", withRaceGame((room) => raceEngine.handleVoteEnd(io, room, socket)));

    // Chat — works any time you're in a room (lightly rate-limited; rendered separately from game messages).
    socket.on("chat", ({ text } = {}) => {
      const room = rooms.get(socket.data.roomCode);
      const p = room?.players.get(socket.data.playerId) || room?.spectators?.get(socket.data.playerId);
      if (!p) return;
      const now = Date.now();
      if (p.lastChatAt && now - p.lastChatAt < 400) return;
      p.lastChatAt = now;
      const msg = String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (msg) {
        const spectator = !room.players.has(p.id);
        io.to(room.code).emit("chat", { id: p.id, name: p.name, text: msg, spectator });
        analytics.recordChat({ gid: room.game?.gid, code: room.code, name: p.name, text: msg, at: Date.now(), spectator, mode: "mp" });
      }
    });

    // Typing indicator — relayed to the rest of the room (not echoed back to the sender).
    socket.on("typing", ({ typing } = {}) => {
      const room = rooms.get(socket.data.roomCode);
      const p = room?.players.get(socket.data.playerId);
      if (!p) return;
      socket.to(room.code).emit("typing", { id: p.id, name: p.name, typing: !!typing });
    });
    socket.on("rematch", (_p, ack) => {
      const room = rooms.get(socket.data.roomCode);
      if (room) engineFor(room).handleRematch(io, room, socket, ack);
    });

    socket.on("leaveRoom", () => leaveCurrentRoom(socket));

    // Disconnect ≠ leave: hold the slot, pause the game, give them GRACE_MS to return.
    socket.on("disconnect", (reason) => {
      console.log(`👋 disconnected: ${socket.id} (${reason})`);
      matchmaking.leave(socket); // no-op if they weren't queued
      if (!socket.data.ghostUncounted) { online = Math.max(0, online - 1); broadcastPresence(); } // ghosts were already uncounted
      const sess = socket.data.session; // log the whole visit (records nothing if persistence is off)
      if (sess) { const end = Date.now(); analytics.recordSession({ connected_at: sess.connectedAt, disconnected_at: end, duration_ms: end - sess.connectedAt, device: sess.device, played: sess.played, joined: sess.joined, spectated: sess.spectated, name: sess.name, reason, singleplayer: sess.singleplayer, ip: sess.ip, visitor_id: sess.visitor_id, tz: sess.tz, locale: sess.locale, geo: sess.geo }); }
      const code = socket.data.roomCode, pid = socket.data.playerId;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;
      if (room.spectators?.has(pid)) { room.spectators.delete(pid); broadcast(room); return; } // spectator left
      const p = room.players.get(pid);
      if (!p || p.socketId !== socket.id) return; // stale socket, ignore
      p.connected = false; p.socketId = null;
      if (room.game) engineFor(room).pauseGame(io, room);
      io.to(code).emit("opponentStatus", { connected: false, name: p.name, graceMs: GRACE_MS });
      broadcast(room);
      // One timer PER PLAYER: a single room-wide timer meant a second disconnect cancelled the
      // first player's countdown, so they kept their seat forever and the room stayed paused.
      if (!room.graceTimeouts) room.graceTimeouts = new Map();
      clearTimeout(room.graceTimeouts.get(pid));
      room.graceTimeouts.set(pid, setTimeout(() => { room.graceTimeouts.delete(pid); removePlayer(room, pid); }, GRACE_MS));
    });
  });

  return {
    rooms,
    stats,
    serverStartedAt,
    getOnline: () => online,
    isLockdown: () => lockdown,
    setLockdown: (v) => { lockdown = !!v; },
    closeRoom,
    closeAllRooms,
  };
}

module.exports = { createRooms };
