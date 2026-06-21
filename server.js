// Prove It! — server (Phase 4: rooms + reconnection)
// Serves the static game files AND runs the Socket.IO realtime layer on one port.
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const engine = require("./game-engine");
const CATEGORY_GROUPS = require("./categories.js");
const ALL_GROUPS = Object.keys(CATEGORY_GROUPS);
const DEFAULT_GROUPS = ALL_GROUPS.filter((k) => !CATEGORY_GROUPS[k].defaultOff); // Secret starts off
const TIMERS = [15, 30, 45, 60];
const TARGETS = [3, 5, 10]; // plus null = endless

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Default page is Multiplayer; single-player lives at /index.html.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "mp.html")));
app.use(express.static(path.join(__dirname)));

// ---------- Rooms ----------
// code -> { code, hostId, status, settings, players: Map<playerId, {id,name,socketId,connected}>, graceTimeout }
// Identity is the stable playerId (the client keeps it in sessionStorage), NOT the
// socket id — so a reconnect with a new socket re-claims the same player slot.
const rooms = new Map();
const MAX_PLAYERS = 2;
const GRACE_MS = 30000; // time to reconnect before forfeiting

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
    code: room.code, hostId: room.hostId, status: room.status, settings: room.settings,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, isHost: p.id === room.hostId, connected: p.connected,
    })),
  };
}
function broadcast(room) { io.to(room.code).emit("roomState", roomState(room)); }

function attach(room, socket, playerId) {
  const p = room.players.get(playerId);
  p.socketId = socket.id; p.connected = true;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = playerId;
}

// Full removal (explicit leave, or grace expiry).
function removePlayer(room, playerId) {
  const wasInGame = !!room.game;
  room.players.delete(playerId);
  if (room.graceTimeout) { clearTimeout(room.graceTimeout); room.graceTimeout = null; }
  if (room.players.size === 0) {
    if (room.game?.timeout) clearTimeout(room.game.timeout);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === playerId) room.hostId = [...room.players.keys()][0];
  if (wasInGame) engine.endGameForLeaver(io, room, playerId);
  broadcast(room);
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode, pid = socket.data.playerId;
  socket.data.roomCode = null;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  socket.leave(code);
  if (room.players.has(pid)) removePlayer(room, pid);
}

io.on("connection", (socket) => {
  console.log(`✅ connected: ${socket.id}`);

  function doResume(room, pid, ack) {
    attach(room, socket, pid);
    if (room.graceTimeout) { clearTimeout(room.graceTimeout); room.graceTimeout = null; }
    io.to(room.code).emit("opponentStatus", { connected: true, name: room.players.get(pid).name });
    ack?.({ ok: true, code: room.code, you: pid, inGame: !!room.game });
    broadcast(room);
    if (room.game) engine.resumeGame(io, room); // unpause + push gameState
  }

  socket.on("createRoom", ({ name, playerId } = {}, ack) => {
    leaveCurrentRoom(socket);
    const code = makeCode();
    const pid = playerId || genId();
    const room = { code, hostId: pid, status: "waiting",
      settings: { groups: [...DEFAULT_GROUPS], timer: 30, target: 5 },
      players: new Map(), graceTimeout: null };
    room.players.set(pid, { id: pid, name: cleanName(name), socketId: socket.id, connected: true });
    rooms.set(code, room);
    attach(room, socket, pid);
    console.log(`🏠 room ${code} created`);
    ack?.({ ok: true, code, you: pid });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name, playerId } = {}, ack) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: "No room with that code." });
    const pid = playerId || genId();
    if (room.players.has(pid)) return doResume(room, pid, ack); // rejoining your own slot
    if (room.players.size >= MAX_PLAYERS) return ack?.({ ok: false, error: "That room is full." });
    if (room.status !== "waiting") return ack?.({ ok: false, error: "That game already started." });
    leaveCurrentRoom(socket);
    room.players.set(pid, { id: pid, name: cleanName(name), socketId: socket.id, connected: true });
    attach(room, socket, pid);
    console.log(`➕ joined room ${code}`);
    ack?.({ ok: true, code, you: pid });
    broadcast(room);
  });

  // Reconnect to an existing slot (after refresh / network drop).
  socket.on("resume", ({ code, playerId } = {}, ack) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || !playerId || !room.players.has(playerId)) return ack?.({ ok: false });
    console.log(`🔄 resumed room ${code}`);
    doResume(room, playerId, ack);
  });

  // Host configures the room before starting.
  socket.on("setSettings", ({ groups, timer, target } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId || room.status !== "waiting") return;
    const s = room.settings;
    if (Array.isArray(groups)) {
      const valid = groups.filter((k) => CATEGORY_GROUPS[k]);
      if (valid.length) s.groups = valid; // never allow zero
    }
    if (TIMERS.includes(timer)) s.timer = timer;
    if (target === null || TARGETS.includes(target)) s.target = target;
    broadcast(room);
  });

  // Host changes categories mid-match (applies next round).
  socket.on("setGroups", ({ groups } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game || room.hostId !== socket.data.playerId) return;
    engine.setGroups(io, room, groups);
  });

  socket.on("startMatch", (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack?.({ ok: false, error: "You're not in a room." });
    if (room.hostId !== socket.data.playerId) return ack?.({ ok: false, error: "Only the host can start." });
    if (room.players.size < MAX_PLAYERS) return ack?.({ ok: false, error: "Need 2 players to start." });
    room.status = "started";
    console.log(`▶️ room ${room.code} started`);
    ack?.({ ok: true });
    engine.startMatch(io, room);
  });

  // ---------- gameplay intents (ignored while paused; engine validates the rest) ----------
  const withGame = (fn) => (...args) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && room.game && !room.game.paused) fn(room, ...args);
  };
  socket.on("open", withGame((room, { n } = {}, ack) => engine.handleOpen(io, room, socket, n, ack)));
  socket.on("raise", withGame((room, { toN } = {}, ack) => engine.handleRaise(io, room, socket, toN, ack)));
  socket.on("proveIt", withGame((room, _p, ack) => engine.handleProveIt(io, room, socket, ack)));
  socket.on("answer", withGame((room, { text } = {}, ack) => engine.handleAnswer(io, room, socket, text, ack)));
  socket.on("judge", withGame((room, { answerId, accept } = {}) => engine.handleJudge(io, room, socket, { answerId, accept })));
  socket.on("rejectAll", withGame((room) => engine.handleRejectAll(io, room, socket)));
  socket.on("giveUp", withGame((room) => engine.handleGiveUp(io, room, socket)));
  socket.on("pauseRound", withGame((room) => engine.handlePauseRound(io, room, socket)));
  socket.on("resumeRound", withGame((room) => engine.handleResumeRound(io, room, socket)));

  // Chat — works any time you're in a room (lightly rate-limited; rendered separately from game messages).
  socket.on("chat", ({ text } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.data.playerId);
    if (!p) return;
    const now = Date.now();
    if (p.lastChatAt && now - p.lastChatAt < 400) return;
    p.lastChatAt = now;
    const msg = String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (msg) io.to(room.code).emit("chat", { id: p.id, name: p.name, text: msg });
  });
  socket.on("rematch", (_p, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (room) engine.handleRematch(io, room, socket, ack);
  });

  socket.on("leaveRoom", () => leaveCurrentRoom(socket));

  // Disconnect ≠ leave: hold the slot, pause the game, give them GRACE_MS to return.
  socket.on("disconnect", (reason) => {
    console.log(`👋 disconnected: ${socket.id} (${reason})`);
    const code = socket.data.roomCode, pid = socket.data.playerId;
    if (!code) return;
    const room = rooms.get(code);
    const p = room?.players.get(pid);
    if (!p || p.socketId !== socket.id) return; // stale socket, ignore
    p.connected = false; p.socketId = null;
    if (room.game) engine.pauseGame(io, room);
    io.to(code).emit("opponentStatus", { connected: false, name: p.name, graceMs: GRACE_MS });
    broadcast(room);
    if (room.graceTimeout) clearTimeout(room.graceTimeout);
    room.graceTimeout = setTimeout(() => { room.graceTimeout = null; removePlayer(room, pid); }, GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎯 Prove It! server running at http://localhost:${PORT}`);
});
