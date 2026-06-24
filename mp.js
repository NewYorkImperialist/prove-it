// Prove It! — multiplayer client (Phase 2: rooms + live duel)
const $ = (id) => document.getElementById(id);
const socket = io();

// Keep the in-game layout sized to the *visible* viewport so the mobile keyboard
// (opened for chat/answers) shrinks the feed instead of hiding the header & input bar.
function setAppHeight() {
  const vv = window.visualViewport;
  const h = (vv && vv.height) || window.innerHeight;
  const top = (vv && vv.offsetTop) || 0; // iOS shifts the visible area down when the keyboard opens
  const s = document.documentElement.style;
  s.setProperty("--app-height", h + "px");
  s.setProperty("--app-top", top + "px");
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", setAppHeight);
  window.visualViewport.addEventListener("scroll", setAppHeight);
}
window.addEventListener("resize", setAppHeight);
window.addEventListener("orientationchange", setAppHeight);
setAppHeight();

let iAmHost = false;
let gs = null; // latest game state snapshot
let lastSendAt = 0; // client-side answer cooldown

// Identity survives a REFRESH (so we reconnect), but a fresh/duplicated tab gets a
// brand-new identity — otherwise two tabs in one browser would fight over one slot.
function genPid() { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }
const navEntry = performance.getEntriesByType("navigation")[0];
const isReload = !!navEntry && navEntry.type === "reload";
let playerId = (isReload && sessionStorage.getItem("pid")) || genPid();
sessionStorage.setItem("pid", playerId);
let myId = playerId;
let myRoom = isReload ? (sessionStorage.getItem("room") || null) : null;
let isSpectator = isReload && sessionStorage.getItem("spectator") === "1";
let prevPlayers = null; // last known player count, for the "someone joined" chime
if (!isReload) { sessionStorage.removeItem("room"); sessionStorage.removeItem("spectator"); }
function setRoom(code) {
  myRoom = code;
  if (code) sessionStorage.setItem("room", code);
  else { sessionStorage.removeItem("room"); sessionStorage.removeItem("spectator"); isSpectator = false; prevPlayers = null; }
}
function setSpectator(on) { isSpectator = on; on ? sessionStorage.setItem("spectator", "1") : sessionStorage.removeItem("spectator"); }

// Remember the player's name across visits, and accept ?room=CODE invite links.
const savedName = localStorage.getItem("pi_name");
if (savedName) $("name").value = savedName;
function rememberName(n) { if (n) localStorage.setItem("pi_name", n); }
const inviteCode = (new URLSearchParams(location.search).get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
if (inviteCode) $("joinCode").value = inviteCode;
let triedInvite = false;
// ?spectate=CODE → watch a room directly (used by the owner /admin dashboard links)
const spectateParam = (new URLSearchParams(location.search).get("spectate") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
function doSpectate(code) {
  socket.emit("spectateRoom", { code, name: nameValue(), playerId }, (res) => {
    if (!res?.ok) { show("home"); $("homeErr").textContent = res?.error || "Could not spectate."; return; }
    myId = res.you; setRoom(res.code); setSpectator(true); rememberName(nameValue()); show(res.inGame ? "game" : "room");
    history.replaceState({}, "", location.pathname);
  });
}

// 👻 ?ghost=CODE&key=OWNER_KEY → INVISIBLE owner watch (admin dashboard "ghost" link).
// Re-runs on every connect (param stays in the URL across reloads) so the ghost never
// accidentally falls back to a visible spectator on refresh.
const ghostParam = (new URLSearchParams(location.search).get("ghost") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
const ghostKey = new URLSearchParams(location.search).get("key") || "";
let isGhost = false;
function doGhost() {
  socket.emit("ghostWatch", { code: ghostParam, key: ghostKey }, (res) => {
    if (!res?.ok) { show("home"); $("homeErr").textContent = res?.error || "Could not ghost-watch."; return; }
    isGhost = true; isSpectator = true; myId = res.you; show(res.inGame ? "game" : "room");
  });
}

// ---------- owner crown 👑 (secret, key-gated server-side) ----------
// Become the owner once by visiting  ?crown=YOUR_SECRET_KEY  (use ?crown=off to revoke).
// The key is stored locally and validated by the server on every toggle, so it stays exclusive.
const crownParam = new URLSearchParams(location.search).get("crown");
if (crownParam != null) {
  if (crownParam === "off") { localStorage.removeItem("ownerKey"); localStorage.removeItem("crownOn"); }
  else { localStorage.setItem("ownerKey", crownParam); localStorage.setItem("crownOn", "1"); }
  const u = new URL(location.href); u.searchParams.delete("crown"); history.replaceState({}, "", u.pathname + u.search);
}
const ownerKey = () => localStorage.getItem("ownerKey");
const crownOn = () => localStorage.getItem("crownOn") === "1";
function updateCrownUI() {
  const has = !!ownerKey();
  $("crownLobby").classList.toggle("hidden", !has);
  $("crownGame").classList.toggle("hidden", !has);
  $("crownLobby").textContent = "👑 Crown: " + (crownOn() ? "on" : "off");
  $("crownGame").classList.toggle("on", crownOn());
}
function applyCrown() { if (ownerKey()) socket.emit("setCrown", { on: crownOn(), key: ownerKey() }); }
function toggleCrown() {
  if (!ownerKey()) return;
  localStorage.setItem("crownOn", crownOn() ? "0" : "1");
  updateCrownUI();
  applyCrown();
}
$("crownLobby").onclick = toggleCrown;
$("crownGame").onclick = toggleCrown;
updateCrownUI();

function maybeAutoJoinInvite() {
  if (triedInvite || !inviteCode || myRoom) return;
  triedInvite = true;
  socket.emit("joinRoom", { code: inviteCode, name: nameValue(), playerId }, (res) => {
    if (!res?.ok) return; // room gone/full → leave them on home with the code prefilled
    myId = res.you; setRoom(res.code); rememberName(nameValue()); show("room"); applyCrown();
    history.replaceState({}, "", location.pathname); // clean URL so a refresh resumes normally
  });
}

// ---------- sound effects (synthesized with Web Audio — no audio files) ----------
let audioCtx = null;
let muted = localStorage.getItem("muted") === "1";
function actx() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
// Browsers block audio until a user gesture — resume the context on the first interaction.
["click", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, () => actx(), { once: true }));
function tone(freq, dur, { type = "sine", gain = 0.2, delay = 0, sweep = 0 } = {}) {
  if (muted) return;
  const ctx = actx(); if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, t0);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + dur + 0.03);
}
const sfx = {
  tick:    () => tone(820, 0.05, { type: "square", gain: 0.07 }),
  tickHot: () => tone(1280, 0.07, { type: "square", gain: 0.11 }),
  ding:    () => { tone(880, 0.12, { gain: 0.2 }); tone(1320, 0.16, { gain: 0.14, delay: 0.05 }); },
  buzz:    () => tone(170, 0.22, { type: "sawtooth", gain: 0.16, sweep: -70 }),
  pop:     () => tone(520, 0.07, { type: "triangle", gain: 0.11 }),
  roundWin:  () => [523, 659, 784].forEach((f, i) => tone(f, 0.18, { type: "triangle", gain: 0.16, delay: i * 0.08 })),
  roundLose: () => [392, 311].forEach((f, i) => tone(f, 0.24, { gain: 0.16, delay: i * 0.11 })),
  fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: "square", gain: 0.15, delay: i * 0.12 })),
  sparkle: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.14, { type: "triangle", gain: 0.14, delay: i * 0.06 })),
  join: () => { tone(587, 0.1, { type: "triangle", gain: 0.16 }); tone(880, 0.15, { type: "triangle", gain: 0.16, delay: 0.09 }); },
};
function setMuted(m) {
  muted = m; localStorage.setItem("muted", m ? "1" : "0");
  $("muteBtn").textContent = m ? "Muted" : "Sound";
  $("muteBtn").title = m ? "Sound off" : "Sound on";
}
$("muteBtn").onclick = () => { setMuted(!muted); if (!muted) sfx.pop(); };
setMuted(muted);

// ---------- theme (amber default ⇄ cyan), persisted ----------
function setFavicon(t) {
  const rect = t === "cyan" ? "5cd6e0" : "f5a623";
  const fg = t === "cyan" ? "04232a" : "241500";
  const link = document.getElementById("favicon");
  if (link) link.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='8' y='8' width='84' height='84' rx='20' fill='%23${rect}'/><text x='50' y='50' font-size='64' text-anchor='middle' dominant-baseline='central' fill='%23${fg}'>◎</text></svg>`;
}
function setTheme(t) {
  document.body.classList.toggle("t-cyan", t === "cyan");
  localStorage.setItem("theme", t);
  document.querySelectorAll("[data-theme]").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
  setFavicon(t);
}
document.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.theme)));
setTheme(localStorage.getItem("theme") || "amber");

// ---------- connection indicator + auto-resume ----------
// Two indicators: the floating one (lobby) and the sidebar one (in game).
let pingMs = null, connOk = false;
function connectedLabel() { return pingMs == null ? "connected" : `connected · ${pingMs}ms`; }
function setConn(text, cls) {
  connOk = cls === "ok";
  $("conn").textContent = text; $("conn").className = "conn " + cls;
  $("connSide").textContent = text; $("connSide").className = "conn-side " + cls;
}
function measureLatency() {
  if (!socket.connected) return;
  const t0 = performance.now();
  socket.emit("latencyPing", () => {
    pingMs = Math.max(1, Math.round(performance.now() - t0));
    if (connOk) setConn(connectedLabel(), "ok");
  });
}
setInterval(measureLatency, 4000);

// Persistent anonymous visitor id (survives across visits) + timezone/locale → owner analytics.
const VISITOR_ID = (() => {
  try { let v = localStorage.getItem("pi_visitor"); if (!v) { v = "v-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); localStorage.setItem("pi_visitor", v); } return v; }
  catch { return null; }
})();
function sendClientMeta() {
  try { socket.emit("clientMeta", { visitorId: VISITOR_ID, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language }); } catch (e) {}
}

socket.on("connect", () => {
  setConn("connected", "ok");
  measureLatency();
  sendClientMeta();
  if (ghostParam) { doGhost(); return; } // invisible owner watch takes priority
  if (myRoom && isSpectator) {
    socket.emit("spectateRoom", { code: myRoom, name: nameValue(), playerId }, (res) => {
      if (!res?.ok) { setRoom(null); show("home"); }
      else { myId = res.you; show(res.inGame ? "game" : "room"); }
    });
  } else if (myRoom) {
    socket.emit("resume", { code: myRoom, playerId }, (res) => {
      if (!res?.ok) { setRoom(null); show("home"); maybeAutoJoinInvite(); } // room gone → back to start
      else applyCrown();
    });
  } else if (spectateParam) {
    doSpectate(spectateParam);
  } else {
    maybeAutoJoinInvite();
  }
});
socket.on("disconnect", () => setConn("reconnecting…", "bad"));
socket.on("connect_error", () => setConn("connection error", "bad"));
socket.on("opponentStatus", ({ connected, name }) => {
  if (connected) flashStatus(`${name} reconnected.`);
});

// ---------- admin broadcast banner (e.g. pre-deploy heads-up) ----------
socket.on("announce", ({ text }) => {
  const el = $("announce");
  el.textContent = text + "   (tap to dismiss)";
  el.classList.remove("hidden");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add("hidden"), 45000);
});
$("announce").onclick = () => $("announce").classList.add("hidden");

// ---------- live "online" count (social proof in the lobby/home) ----------
let onlineCount = 0;
socket.on("presence", ({ online }) => { onlineCount = online || 0; updateOnline(); });
function updateOnline() {
  $("online").textContent = onlineCount + " online";
  const inGame = !$("game").classList.contains("hidden");
  $("online").classList.toggle("hidden", inGame || onlineCount <= 0); // shown on home/lobby only
}

// ---------- screens ----------
function show(which) {
  for (const id of ["home", "room", "game"]) $(id).classList.toggle("hidden", id !== which);
  $("conn").style.display = which === "game" ? "none" : ""; // sidebar shows it during the game
  if (which !== "game") { $("mpCatMenu").style.display = "none"; $("mpSettingsMenu").style.display = "none"; }
  updateOnline();
}

// ---------- home actions ----------
const nameValue = () => $("name").value.trim();

$("createBtn").onclick = () => {
  $("homeErr").textContent = "";
  socket.emit("createRoom", { name: nameValue(), playerId }, (res) => {
    if (!res?.ok) return ($("homeErr").textContent = res?.error || "Could not create room.");
    myId = res.you; setRoom(res.code); rememberName(nameValue()); show("room"); applyCrown();
  });
};
$("joinBtn").onclick = () => {
  const code = $("joinCode").value.trim().toUpperCase();
  $("homeErr").textContent = "";
  if (code.length < 4) return ($("homeErr").textContent = "Enter the 4-letter room code.");
  socket.emit("joinRoom", { code, name: nameValue(), playerId }, (res) => {
    if (!res?.ok) return ($("homeErr").textContent = (res?.error || "Could not join room.") + " (tap Spectate to watch)");
    myId = res.you; setRoom(res.code); rememberName(nameValue()); show("room"); applyCrown();
  });
};
$("spectateBtn").onclick = () => {
  const code = $("joinCode").value.trim().toUpperCase();
  $("homeErr").textContent = "";
  if (code.length < 4) return ($("homeErr").textContent = "Enter the room code to spectate.");
  socket.emit("spectateRoom", { code, name: nameValue(), playerId }, (res) => {
    if (!res?.ok) return ($("homeErr").textContent = res?.error || "Could not spectate.");
    myId = res.you; setRoom(res.code); setSpectator(true); rememberName(nameValue()); show(res.inGame ? "game" : "room");
  });
};
$("spBtn").onclick = () => {
  try { socket.emit("enterSingleplayer"); } catch (e) {}  // tell the server this visit went single-player
  setTimeout(() => { location.href = "index.html"; }, 90); // small delay so the emit flushes before we navigate
};
$("name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("createBtn").click(); });
$("name").addEventListener("change", () => rememberName(nameValue()));
$("joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });

// ---------- copy code / invite link ----------
function copyText(str) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(str).catch(() => fallbackCopy(str));
  return fallbackCopy(str);
}
function fallbackCopy(str) {
  const t = document.createElement("textarea");
  t.value = str; t.style.position = "fixed"; t.style.opacity = "0";
  document.body.appendChild(t); t.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(t);
  return Promise.resolve();
}
function flashHint(msg) {
  const h = $("codeHint"); h.textContent = msg;
  clearTimeout(flashHint._t); flashHint._t = setTimeout(() => { h.textContent = "tap the code to copy"; }, 1400);
}
$("roomCode").onclick = () => { if (myRoom) copyText(myRoom).then(() => flashHint("✓ Code copied!")); };
$("copyInvite").onclick = () => {
  if (!myRoom) return;
  copyText(location.origin + location.pathname + "?room=" + myRoom).then(() => {
    const b = $("copyInvite"), orig = "Copy invite link";
    b.textContent = "✓ Invite link copied!";
    clearTimeout(b._t); b._t = setTimeout(() => { b.textContent = orig; }, 1500);
  });
};
// Rename yourself in the lobby (commits on blur / Enter).
$("lobbyName").addEventListener("change", () => {
  const n = $("lobbyName").value.trim();
  rememberName(n);
  socket.emit("setName", { name: n });
});
$("lobbyName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("lobbyName").blur(); });

// ---------- waiting room ----------
$("startBtn").onclick = () => socket.emit("startMatch", {}, (r) => { if (!r?.ok) $("roomStatus").textContent = r?.error || "Could not start."; });
$("leaveBtn").onclick = () => { socket.emit("leaveRoom"); setRoom(null); show("home"); };

const AV = ["var(--accent)", "#8a9aa0"];
socket.on("roomState", (room) => {
  // chime when someone new joins (baseline silently on the first state so you don't hear your own arrival)
  if (prevPlayers !== null && room.players.length > prevPlayers) sfx.join();
  prevPlayers = room.players.length;
  iAmHost = room.hostId === myId;
  if (room.status === "waiting") show("room");
  $("roomCode").textContent = room.code;
  const me = room.players.find((p) => p.id === myId);
  if (me && document.activeElement !== $("lobbyName")) $("lobbyName").value = me.name; // reflect current name, don't clobber typing
  const list = $("players");
  list.innerHTML = "";
  room.players.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "player";
    const tag = p.connected === false ? ' <span style="color:var(--bad)">(reconnecting…)</span>' : (p.isHost ? '<span class="tag">HOST</span>' : "");
    div.innerHTML = `<div class="avatar" style="background:${AV[i % AV.length]};color:var(--markfg)">${p.name[0].toUpperCase()}</div>
      <div class="name">${p.name}${p.crown ? '<span class="crown">👑</span>' : ""}${p.id === myId ? " (you)" : ""}</div>${tag}`;
    list.appendChild(div);
  });
  if (room.players.length < 2) {
    const div = document.createElement("div");
    div.className = "player empty";
    div.innerHTML = `<div class="avatar" style="background:#2a2f3e">?</div><div class="name">waiting for opponent…</div>`;
    list.appendChild(div);
  }
  const specs = room.spectators || [];
  $("watchers").classList.toggle("hidden", specs.length === 0);
  if (specs.length) $("watchers").textContent = `${specs.length} watching — ${specs.map((s) => s.name).join(", ")}`;

  const canStart = iAmHost && room.players.length >= 2;
  $("startBtn").classList.toggle("hidden", !iAmHost);
  $("startBtn").disabled = !canStart;
  $("roomStatus").textContent = isSpectator ? "You're spectating — waiting for the host to start…"
    : iAmHost ? (canStart ? "" : "Waiting for a second player…") : "Waiting for the host to start…";

  buildLobbySettings();
  syncSettings(room.settings);
});

// ---------- room settings (host configures before starting) ----------
const TIMERS = [15, 30, 45, 60];
const WINS = [3, 5, 10, "∞"]; // ∞ → null (endless)
let builtSettings = false;
let curSettings = null;

function buildLobbySettings() {
  if (builtSettings) return;
  builtSettings = true;
  const checks = $("catChecks");
  Object.entries(CATEGORY_GROUPS).forEach(([key, g]) => {
    const label = document.createElement("label");
    label.className = "check";
    label.innerHTML = `<input type="checkbox" value="${key}"><span class="emoji">${g.emoji}</span><span>${key}</span>`;
    label.querySelector("input").addEventListener("change", onCatChange);
    checks.appendChild(label);
  });
  TIMERS.forEach((s) => {
    const b = document.createElement("button");
    b.textContent = s + "s"; b.dataset.timer = s;
    b.onclick = () => iAmHost && socket.emit("setSettings", { timer: s });
    $("timerSeg").appendChild(b);
  });
  WINS.forEach((w) => {
    const b = document.createElement("button");
    b.textContent = w; b.dataset.win = w;
    b.onclick = () => iAmHost && socket.emit("setSettings", { target: w === "∞" ? null : w });
    $("winSeg").appendChild(b);
  });
  $("advanceSeg").querySelectorAll("button").forEach((b) => {
    b.onclick = () => iAmHost && socket.emit("setSettings", { autoAdvance: b.dataset.auto === "1" });
  });
}

function onCatChange() {
  if (!iAmHost) return;
  const checked = [...$("catChecks").querySelectorAll("input:checked")].map((i) => i.value);
  if (!checked.length) return syncSettings(curSettings); // never allow zero → revert
  socket.emit("setSettings", { groups: checked });
}

function syncSettings(s) {
  if (!s) return;
  curSettings = s;
  $("catChecks").querySelectorAll("input").forEach((i) => {
    i.checked = s.groups.includes(i.value);
    i.parentElement.classList.toggle("on", i.checked);
  });
  $("timerSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.timer === s.timer));
  $("winSeg").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", b.dataset.win === "∞" ? s.target == null : +b.dataset.win === s.target));
  $("advanceSeg").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", (b.dataset.auto === "1") === (s.autoAdvance !== false)));
  $("settings").classList.toggle("locked", !iAmHost);
  $("lockNote").classList.toggle("hidden", iAmHost);
}

// ---------- game ----------
socket.on("gameStarted", () => { $("feed").innerHTML = ""; show("game"); });

socket.on("log", ({ by, name, text, kind }) => {
  if (kind === "ok") sfx.ding(); else if (kind === "bad") sfx.buzz(); else if (kind === "pending") sfx.pop();
  const feed = $("feed");
  const side = by === "system" ? "system" : by === myId ? "me" : "them";
  if (name && side !== "system") {
    const s = document.createElement("div");
    s.className = "sender " + (side === "me" ? "right" : "left");
    s.textContent = name;
    feed.appendChild(s);
  }
  const m = document.createElement("div");
  m.className = "msg " + side + (kind ? " " + kind : "");
  m.textContent = text;
  feed.appendChild(m);
  feed.scrollTop = feed.scrollHeight;
});

socket.on("chat", ({ id, name, text, spectator }) => {
  $("typing").classList.add("hidden"); $("typing").textContent = ""; // they sent it → no longer typing
  const feed = $("feed");
  const div = document.createElement("div");
  div.className = "chat" + (id === myId ? " mine" : "");
  const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = (spectator ? "" : "") + name + ": ";
  const tx = document.createElement("span"); tx.textContent = text; // textContent → no HTML injection
  div.appendChild(nm); div.appendChild(tx);
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
});

socket.on("opponentLeft", ({ name }) => {
  gs = null;
  alert(`${name} left the game.`);
  show("room");
});

socket.on("roomClosed", () => {
  gs = null; setRoom(null);
  show("home");
  $("homeErr").textContent = "This room was closed.";
});

let prevPhase = null, prevTurnMine = false;
socket.on("gameState", (state) => {
  const phaseChanged = state.phase !== prevPhase;
  const turnMine = state.turnId === myId && !state.paused &&
    (state.phase === "proving" || state.phase === "opening" || state.phase === "bidding");
  gs = state; render();
  if (phaseChanged) {
    if (state.phase === "matchover") sfx.fanfare();
    else if (state.phase === "roundover" && prevPhase) sfx[(state.lastResult && state.lastResult.winnerId === myId) ? "roundWin" : "roundLose"]();
    prevPhase = state.phase;
  }
  if (turnMine && !prevTurnMine) sfx.pop(); // a soft cue when it becomes your turn
  prevTurnMine = turnMine;
});

// 🎯 Easter egg: someone answered "Prove It!" in the Video Games round → +5 + a party for everyone.
function partyCrowns() { document.querySelectorAll(".crown").forEach((el) => { el.classList.remove("party"); void el.offsetWidth; el.classList.add("party"); }); }
function oilRain() {
  for (let i = 0; i < 44; i++) {
    const d = document.createElement("div");
    d.className = "oil-drop";
    d.textContent = "🛢️";
    d.style.left = Math.random() * 100 + "vw";
    d.style.fontSize = (22 + Math.random() * 28) + "px";
    const dur = 2 + Math.random() * 2.6;
    d.style.animation = `oilFall ${dur}s linear ${Math.random() * 0.9}s forwards`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), (dur + 1.2) * 1000);
  }
}
socket.on("easterEgg", ({ name, phrase, fx }) => {
  if (fx === "oil") { oilRain(); sfx.sparkle(); flashStatus(`${name} said "${phrase}" — oil incoming!`); return; }
  confettiBurst();
  sfx.sparkle();
  if (fx === "crown") {
    // the crown lives in the sidebar, which re-renders when the +5 lands — fire the shake on a few
    // timers so it runs on the freshly-rendered crown after those renders settle.
    [0, 160, 360, 620].forEach((d) => setTimeout(partyCrowns, d));
  } else {
    const el = $("mpLogo"); el.classList.remove("party"); void el.offsetWidth; el.classList.add("party"); // "Prove It!" → the logo
  }
  flashStatus(`${name} said "${phrase || "the magic words"}" — +5 bonus points!`);
});
$("mpLogo").addEventListener("animationend", () => $("mpLogo").classList.remove("party"));

// Self-contained canvas confetti — no libraries. Bursts from the top-center and rains down.
function confettiBurst() {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999";
  canvas.width = innerWidth; canvas.height = innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const colors = ["#ffd34d", "#3ecf8e", "#5b8cff", "#e5484d", "#b06bff", "#ff8c42"];
  const parts = Array.from({ length: 180 }, () => ({
    x: canvas.width / 2 + (Math.random() - 0.5) * 240,
    y: canvas.height / 3 + (Math.random() - 0.5) * 60,
    vx: (Math.random() - 0.5) * 14, vy: Math.random() * -13 - 3,
    size: 6 + Math.random() * 7, color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frame++;
    let alive = false;
    for (const p of parts) {
      p.vy += 0.32; p.x += p.vx; p.y += p.vy; p.rot += p.vr; // gravity + drift
      if (p.y < canvas.height + 30) alive = true;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - frame / 170); ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (alive && frame < 170) requestAnimationFrame(tick);
    else canvas.remove();
  })();
}

function render() {
  if (!gs) return;
  show("game");
  const me = gs.players.find((p) => p.id === myId) || gs.players[0];
  const opp = gs.players.find((p) => p.id !== myId) || gs.players[1];
  const nameOf = (id) => (gs.players.find((p) => p.id === id) || {}).name || "?";

  $("gRoom").textContent = (myRoom ? "Room " + myRoom : "") + (gs.spectators ? "  ·  " + gs.spectators + " watching" : "");
  $("specBadge").classList.toggle("hidden", !isSpectator);
  if (isSpectator) $("specBadge").textContent = isGhost ? "Ghost" : "Spectating";

  // sidebar players (you first), with turn highlight
  const sidePlayers = $("sidePlayers");
  sidePlayers.innerHTML = "";
  const colors = ["var(--accent)", "#8a9aa0"];
  const live = gs.phase !== "roundover" && gs.phase !== "matchover" && !gs.paused;
  [me, opp].forEach((p, i) => {
    if (!p) return;
    const d = document.createElement("div");
    d.className = "player" + (live && gs.turnId === p.id ? " turn" : "");
    d.innerHTML = `<div class="avatar" style="background:${colors[i]};color:var(--markfg)">${p.name[0].toUpperCase()}</div>
      <div class="name">${p.name}${p.crown ? '<span class="crown">👑</span>' : ""}</div><div class="pts">${gs.scores[p.id] ?? 0}</div>`;
    sidePlayers.appendChild(d);
  });

  // banner
  $("catLabel").textContent = `${gs.category.emoji} ${gs.category.group}`;
  $("catName").textContent = gs.category.name;
  $("claimLine").textContent = gs.claim ? `Standing claim: ${gs.claim} (${nameOf(gs.holderId)})` : "";

  $("mpCatBtn").style.display = iAmHost ? "inline-block" : "none"; // host can switch categories
  if ($("mpCatMenu").style.display !== "none") syncCatMenu();
  if ($("mpSettingsMenu").style.display !== "none") syncSettingsMenu();

  const input = $("input"), sendBtn = $("send"), actions = $("actions"), status = $("gstatus");
  actions.innerHTML = "";
  status.className = "";
  let enable = false, placeholder = "Type / to chat…", statusText = "";
  const myTurn = gs.turnId === myId;

  // Auto mode (fires on turn/phase transitions): when I need to act, drop to ANSWER mode;
  // while my opponent is the one guessing, drop me into CHAT mode (I can't answer, only chat).
  const actKey = gs.phase + ":" + myTurn;
  if (!isSpectator && actKey !== prevActKey) {
    const myActiveTurn = myTurn && (gs.phase === "opening" || gs.phase === "bidding" || gs.phase === "proving");
    if (myActiveTurn) { if (chatMode) exitChat(true); }            // my move → ANSWER mode
    else if (gs.phase === "proving" && !myTurn && !chatMode) enterChatNoFocus(); // they guess → CHAT
  }
  prevActKey = actKey;

  if (gs.phase === "opening") {
    if (myTurn) { enable = true; placeholder = "Your turn — type a number to open!"; statusText = "You're opening — how many can you name?"; }
    else statusText = `Waiting for ${nameOf(gs.turnId)} to open…`;
  } else if (gs.phase === "bidding") {
    if (myTurn) {
      placeholder = `Raise higher than ${gs.claim}, or…`;
      enable = true;
      addBtn(actions, `Raise to ${gs.claim + 1}`, "raise", () => socket.emit("raise", {}, ackErr));
      addBtn(actions, "Prove It!", "danger", () => socket.emit("proveIt", {}, ackErr));
    } else statusText = `${nameOf(gs.turnId)} is deciding — raise or call Prove It!`;
  } else if (gs.phase === "proving") {
    // (proving handled below)
  }

  // Either player can propose skipping the category before the duel starts.
  if (gs.phase === "opening" || gs.phase === "bidding") {
    addBtn(actions, gs.skipVotes ? `Skip category (${gs.skipVotes}/2)` : "Skip category", "", () => socket.emit("voteSkip"));
  }

  if (gs.phase === "proving") {
    if (myTurn) {
      enable = true; placeholder = `Name a ${gs.category.name}…`;
      addBtn(actions, "Give up", "danger", () => socket.emit("giveUp"));
      statusText = `Proving ${gs.proven}/${gs.claim}${gs.wpm ? ` · ${gs.wpm} wpm` : ""}`;
    } else {
      statusText = `${nameOf(gs.turnId)} is proving… (${gs.proven}/${gs.claim}${gs.wpm ? ` · ${gs.wpm} wpm` : ""})`;
    }
  } else if (gs.phase === "judging") {
    statusText = gs.challengerId === myId
      ? "Time! Rule on the remaining off-list answers."
      : `${nameOf(gs.holderId)}'s off-list answers are being ruled on…`;
  } else if (gs.phase === "roundover") {
    if (gs.intermission) {
      // Waiting for a player to advance (auto-advance off, or paused).
      statusText = gs.autoAdvance ? "Paused — press P or tap for the next round" : "Press P or tap for the next round";
      addBtn(actions, "Next round (P)", "again", () => socket.emit("nextRound"));
    } else {
      statusText = "Next round coming up…";
      addBtn(actions, "Pause", "", () => socket.emit("pauseRound"));
    }
    if (gs.target == null) // endless → let either player vote to end the whole game
      addBtn(actions, gs.endVotes ? `End game (${gs.endVotes}/2)` : "End game", "danger", () => socket.emit("voteEnd"));
  } else if (gs.phase === "matchover") {
    statusText = gs.matchWinnerId ? `${nameOf(gs.matchWinnerId)} wins the match!` : "Game over — it's a tie!";
    if (iAmHost) addBtn(actions, "Play again", "again", () => socket.emit("rematch", {}, ackErr));
    addBtn(actions, "Leave", "danger", () => { socket.emit("leaveRoom"); setRoom(null); show("home"); });
  }

  // Spectators watch read-only: no game buttons, input is chat-only.
  if (isSpectator) {
    actions.innerHTML = "";
    enable = false;
    placeholder = isGhost ? "Ghost mode — you're invisible (can't chat)" : "Say something… (you're spectating)";
    if (gs.phase === "matchover") addBtn(actions, "Stop watching", "danger", () => { socket.emit("leaveRoom"); setRoom(null); show("home"); });
  }

  // Frozen while an opponent is reconnecting — overrides all controls.
  if (gs.paused) {
    $("gpending").innerHTML = "";
    actions.innerHTML = "";
    input.disabled = false; sendBtn.disabled = false; // chat still works while frozen
    if (!chatMode) input.placeholder = "Paused — type / to chat…";
    status.textContent = "Opponent disconnected — waiting up to 30s for them to reconnect…";
    return;
  }

  renderPending();

  // input is always usable so chat works any time; game actions are gated in gameSend
  input.disabled = false;
  sendBtn.disabled = false;
  if (isGhost) { input.disabled = true; sendBtn.disabled = true; } // a ghost can't type — staying invisible
  if (!chatMode) { // don't disturb the box while composing a chat message
    input.placeholder = placeholder;
    if (enable && !isGhost) input.focus();
  }
  $("inputbar").classList.toggle("answer-mode", enable && !chatMode); // amber "✏️ ANSWER" cue
  status.textContent = statusText;

  // Unmissable cue for whoever's opening: red glow on the box + a shake when it becomes their turn.
  const iAmOpening = gs.phase === "opening" && gs.turnId === myId && !chatMode;
  input.classList.toggle("opening-cue", iAmOpening);
  if (iAmOpening && !wasMyOpen) shakeInput();
  wasMyOpen = iAmOpening;
}
let wasMyOpen = false;
let prevActKey = null;

function addBtn(parent, label, cls, onClick) {
  const b = document.createElement("button");
  b.textContent = label; b.className = cls; b.onclick = onClick;
  parent.appendChild(b);
}

// Off-list answers awaiting a ruling. The challenger (judge) sees Accept/Reject
// + Reject-all; the prover just sees they're pending.
function judgeRow(box, p) {
  const row = document.createElement("div");
  row.className = "prow";
  row.innerHTML = `<span class="ptext">${p.text}</span>`;
  const acc = document.createElement("button");
  acc.className = "acc"; acc.textContent = "✓ Accept";
  acc.onclick = () => socket.emit("judge", { answerId: p.id, accept: true });
  const rej = document.createElement("button");
  rej.className = "rej"; rej.textContent = "✗ Reject";
  rej.onclick = () => socket.emit("judge", { answerId: p.id, accept: false });
  row.appendChild(acc); row.appendChild(rej);
  box.appendChild(row);
}
function rejectAllBtn(box, label) {
  const all = document.createElement("button");
  all.className = "rejall"; all.textContent = label;
  all.onclick = () => socket.emit("rejectAll");
  box.appendChild(all);
}
function note(box, text) {
  const n = document.createElement("div");
  n.className = "pnote"; n.textContent = text;
  box.appendChild(n);
}

function renderPending() {
  const box = $("gpending");
  box.innerHTML = "";
  const amJudge = gs.challengerId === myId;

  if (gs.phase === "proving") {
    // live judging — the whole pending list at once
    const pending = gs.pending || [];
    if (!pending.length) return;
    if (amJudge) {
      pending.forEach((p) => judgeRow(box, p));
      if (pending.length > 1) rejectAllBtn(box, "Reject all");
    } else {
      note(box, `Off-list, waiting on opponent: ${pending.map((p) => p.text).join(", ")}`);
    }
  } else if (gs.phase === "judging") {
    // forced ruling — one at a time
    const a = gs.judgeActive;
    if (!a) return;
    if (amJudge) {
      judgeRow(box, a);
      if (gs.judgeRemaining > 1) rejectAllBtn(box, `Reject remaining (${gs.judgeRemaining})`);
    } else {
      note(box, `Opponent ruling: “${a.text}” (${gs.judgeRemaining} left)`);
    }
  }
}
function ackErr(r) { if (r && !r.ok && r.error) flashStatus(r.error); }
function flashStatus(msg) { const s = $("gstatus"); s.textContent = msg; s.className = "err"; }

// ---------- input send (context depends on phase) ----------
function gameSend() {
  if (isGhost) { $("input").value = ""; return; } // ghosts are silent — no chat, no actions
  if (isSpectator) { // spectators can only chat
    const msg = $("input").value.trim();
    $("input").value = "";
    if (chatMode) exitChat();
    if (msg) socket.emit("chat", { text: msg });
    return;
  }
  if (chatMode) { // we're in chat mode — send the message, no "/" needed
    const msg = $("input").value.trim();
    $("input").value = "";  // clear first so exitChat saves an empty draft
    exitChat();
    if (msg) socket.emit("chat", { text: msg });
    return;
  }
  const raw = $("input").value.trim();
  if (!raw) return;
  if (raw[0] === "/") { // fallback: a "/"-prefixed message is chat
    const msg = raw.slice(1).trim();
    $("input").value = "";
    if (msg) socket.emit("chat", { text: msg });
    return;
  }
  if (!gs || gs.turnId !== myId) return; // game actions require it to be your turn
  if (gs.phase === "opening") {
    const n = parseInt(raw, 10);
    if (isNaN(n)) return flashStatus("Type a number.");
    $("input").value = ""; socket.emit("open", { n }, ackErr);
  } else if (gs.phase === "bidding") {
    const n = parseInt(raw, 10);
    if (isNaN(n)) return flashStatus("Type a higher number, or use the buttons.");
    $("input").value = ""; socket.emit("raise", { toN: n }, ackErr);
  } else if (gs.phase === "proving") {
    const now = Date.now();
    if (now - lastSendAt < 350) { shakeInput(); flashStatus("Slow down!"); return; } // typed too fast
    lastSendAt = now;
    $("input").value = "";
    socket.emit("answer", { text: raw }, (res) => {
      if (res && !res.ok) {
        shakeInput();
        if (res.reason === "pending") { $("input").value = raw; flashStatus("Hold on — your opponent still has answers to rule."); }
        else if (res.reason === "roundcap") flashStatus("Too many off-list guesses this round.");
        else flashStatus("Slow down!");
      }
    });
  }
}

function shakeInput() {
  const i = $("input");
  i.classList.remove("shake");
  void i.offsetWidth; // restart animation
  i.classList.add("shake");
}
$("input").addEventListener("animationend", () => $("input").classList.remove("shake"));
$("send").onclick = gameSend;
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") gameSend();
  else if (e.key === "Escape" && chatMode) exitChat();
});

// ---------- chat mode (press "/" or tap 💬 to turn the box into a chat box) ----------
let chatMode = false;
let chatDraft = "";          // unsent message, preserved across Esc / "/" toggles
function enterChat() {
  chatMode = true;
  $("inputbar").classList.add("chat-mode");
  $("input").value = chatDraft;          // restore any saved draft
  $("input").placeholder = "Message…  (Enter to send, Esc or / to close)";
  $("input").focus();
  if (chatDraft) signalTyping();         // resume the typing indicator if there's a draft
}
function exitChat(silent) {
  chatDraft = $("input").value;          // keep the draft so re-opening restores it
  chatMode = false;
  stopTyping();
  $("inputbar").classList.remove("chat-mode");
  $("input").value = "";
  if (!silent && gs) render(); // restore the normal game placeholder/state
}
// Enter chat mode without grabbing focus (so auto-switching the opponent into chat
// during the opponent's guessing turn doesn't pop their keyboard unprompted).
function enterChatNoFocus() {
  chatMode = true;
  $("inputbar").classList.add("chat-mode");
  $("input").value = chatDraft;
  $("input").placeholder = "Message…  (Enter to send, Esc or / to close)";
}
function toggleChat() { chatMode ? exitChat() : enterChat(); }
$("chatToggle").onclick = toggleChat;

// ---------- typing indicator ----------
let typingActive = false, typingTimer = null, typingHideTimer = null;
function signalTyping() {
  if (!chatMode) return;
  if (!typingActive) { typingActive = true; socket.emit("typing", { typing: true }); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1500); // idle → stop
}
function stopTyping() {
  clearTimeout(typingTimer);
  if (typingActive) { typingActive = false; socket.emit("typing", { typing: false }); }
}
$("input").addEventListener("input", () => { if (chatMode) signalTyping(); });
socket.on("typing", ({ name, typing }) => {
  const el = $("typing");
  clearTimeout(typingHideTimer);
  if (!typing) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.textContent = `${name} is typing`;
  for (let i = 0; i < 3; i++) {
    const d = document.createElement("span");
    d.className = "dot"; d.textContent = "."; d.style.animationDelay = i * 0.2 + "s";
    el.appendChild(d);
  }
  el.classList.remove("hidden");
  typingHideTimer = setTimeout(() => { el.classList.add("hidden"); el.textContent = ""; }, 4000); // safety auto-hide
});

// "/" anywhere in a game toggles chat on/off (saving the draft); ignores a half-typed game entry.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/") return;
  if ($("game").classList.contains("hidden")) return;
  if (chatMode) { e.preventDefault(); exitChat(); return; } // "/" closes chat, keeping the draft
  const inp = $("input");
  if (document.activeElement === inp && inp.value.trim() !== "") return; // don't clobber a half-typed answer
  e.preventDefault();
  enterChat();
});

// "P" between rounds advances to the next round (when auto-advance is off, or paused).
document.addEventListener("keydown", (e) => {
  if (e.key !== "p" && e.key !== "P") return;
  if (chatMode || $("game").classList.contains("hidden")) return;
  if (document.activeElement === $("input") && $("input").value.trim() !== "") return; // not while typing
  if (!gs || gs.phase !== "roundover" || !gs.intermission || gs.paused) return;
  e.preventDefault();
  socket.emit("nextRound");
});
$("mpLeave").onclick = () => { socket.emit("leaveRoom"); setRoom(null); show("home"); };

// Logo (top-left) → confirm before leaving a game.
$("mpLogo").onclick = () => $("confirmOverlay").classList.remove("hidden");
$("cfReturn").onclick = () => $("confirmOverlay").classList.add("hidden");
$("cfForfeit").onclick = () => {
  $("confirmOverlay").classList.add("hidden");
  socket.emit("leaveRoom"); setRoom(null); show("home");
};

// ---------- in-game category switcher (host only; applies next round) ----------
let builtCatMenu = false;
function buildCatMenu() {
  if (builtCatMenu) return;
  builtCatMenu = true;
  const box = $("mpCatMenuChecks");
  Object.entries(CATEGORY_GROUPS).forEach(([key, g]) => {
    const label = document.createElement("label");
    label.className = "check";
    label.innerHTML = `<input type="checkbox" value="${key}"><span class="emoji">${g.emoji}</span><span>${key}</span>`;
    label.querySelector("input").addEventListener("change", () => {
      const checked = [...box.querySelectorAll("input:checked")].map((i) => i.value);
      if (!checked.length) return syncCatMenu(); // keep ≥1
      socket.emit("setGroups", { groups: checked });
    });
    box.appendChild(label);
  });
}
function syncCatMenu() {
  const groups = (gs && gs.groups) || [];
  $("mpCatMenuChecks").querySelectorAll("input").forEach((i) => {
    i.checked = groups.includes(i.value);
    i.parentElement.classList.toggle("on", i.checked);
  });
}
$("mpCatBtn").onclick = (e) => {
  e.stopPropagation();
  const m = $("mpCatMenu");
  if (m.style.display !== "none") { m.style.display = "none"; return; }
  buildCatMenu(); syncCatMenu(); m.style.display = "block";
};
document.addEventListener("click", (e) => {
  const m = $("mpCatMenu");
  if (m.style.display !== "none" && !m.contains(e.target) && e.target !== $("mpCatBtn")) m.style.display = "none";
});

// ---------- in-game settings menu (name for everyone; timer/win/auto for the host) ----------
let builtSettingsMenu = false;
function buildSettingsMenu() {
  if (builtSettingsMenu) return;
  builtSettingsMenu = true;
  TIMERS.forEach((s) => {
    const b = document.createElement("button"); b.textContent = s + "s"; b.dataset.timer = s;
    b.onclick = () => iAmHost && socket.emit("setSettings", { timer: s });
    $("gTimerSeg").appendChild(b);
  });
  WINS.forEach((w) => {
    const b = document.createElement("button"); b.textContent = w; b.dataset.win = w;
    b.onclick = () => iAmHost && socket.emit("setSettings", { target: w === "∞" ? null : w });
    $("gWinSeg").appendChild(b);
  });
  $("gAdvanceSeg").querySelectorAll("button").forEach((b) => {
    b.onclick = () => iAmHost && socket.emit("setSettings", { autoAdvance: b.dataset.auto === "1" });
  });
}
function syncSettingsMenu() {
  if (!gs) return;
  $("gHostSettings").style.display = iAmHost ? "" : "none";
  $("gTimerSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.timer === gs.timer));
  $("gWinSeg").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", b.dataset.win === "∞" ? gs.target == null : +b.dataset.win === gs.target));
  $("gAdvanceSeg").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", (b.dataset.auto === "1") === (gs.autoAdvance !== false)));
  if (document.activeElement !== $("gName")) {
    const me = gs.players.find((p) => p.id === myId);
    if (me) $("gName").value = me.name;
  }
}
$("mpSettingsBtn").onclick = (e) => {
  e.stopPropagation();
  const m = $("mpSettingsMenu");
  if (m.style.display !== "none") { m.style.display = "none"; return; }
  $("mpCatMenu").style.display = "none"; // don't stack the two menus
  buildSettingsMenu(); syncSettingsMenu(); m.style.display = "block";
};
$("gNameSave").onclick = () => {
  const n = $("gName").value.trim();
  if (n) { socket.emit("setName", { name: n }); rememberName(n); }
};
$("gName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("gNameSave").click(); });
document.addEventListener("click", (e) => {
  const m = $("mpSettingsMenu");
  if (m.style.display !== "none" && !m.contains(e.target) && e.target !== $("mpSettingsBtn")) m.style.display = "none";
});

// ---------- server-driven timer (render the countdown from the deadline) ----------
setInterval(() => {
  const t = $("timer");
  if (!gs || !gs.deadline || gs.paused) { t.textContent = ""; t.classList.remove("danger"); return; }
  const left = Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000));
  t.textContent = left + "s";
  const danger = gs.phase === "proving" ? left <= 10 : left <= 3;
  t.classList.toggle("danger", danger);
  // audio: tick the final 5 seconds (hotter in the last 3)
  if (left <= 5 && left >= 1 && left !== lastTickSec) { lastTickSec = left; (left <= 3 ? sfx.tickHot : sfx.tick)(); }
  else if (left > 5) lastTickSec = null;
}, 250);
let lastTickSec = null;
