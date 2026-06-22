// Prove It! — multiplayer client (Phase 2: rooms + live duel)
const $ = (id) => document.getElementById(id);
const socket = io();

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
if (!isReload) sessionStorage.removeItem("room");
function setRoom(code) { myRoom = code; code ? sessionStorage.setItem("room", code) : sessionStorage.removeItem("room"); }

// Remember the player's name across visits, and accept ?room=CODE invite links.
const savedName = localStorage.getItem("pi_name");
if (savedName) $("name").value = savedName;
function rememberName(n) { if (n) localStorage.setItem("pi_name", n); }
const inviteCode = (new URLSearchParams(location.search).get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
if (inviteCode) $("joinCode").value = inviteCode;
let triedInvite = false;

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

// ---------- connection indicator + auto-resume ----------
// Two indicators: the floating one (lobby) and the sidebar one (in game).
function setConn(text, cls) {
  $("conn").textContent = text; $("conn").className = "conn " + cls;
  $("connSide").textContent = text; $("connSide").className = "conn-side " + cls;
}
socket.on("connect", () => {
  setConn("connected", "ok");
  if (myRoom) {
    socket.emit("resume", { code: myRoom, playerId }, (res) => {
      if (!res?.ok) { setRoom(null); show("home"); maybeAutoJoinInvite(); } // room gone → back to start
      else applyCrown();
    });
  } else {
    maybeAutoJoinInvite();
  }
});
socket.on("disconnect", () => setConn("reconnecting…", "bad"));
socket.on("connect_error", () => setConn("connection error", "bad"));
socket.on("opponentStatus", ({ connected, name }) => {
  if (connected) flashStatus(`${name} reconnected.`);
});

// ---------- screens ----------
function show(which) {
  for (const id of ["home", "room", "game"]) $(id).classList.toggle("hidden", id !== which);
  $("conn").style.display = which === "game" ? "none" : ""; // sidebar shows it during the game
  if (which !== "game") $("mpCatMenu").style.display = "none";
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
    if (!res?.ok) return ($("homeErr").textContent = res?.error || "Could not join room.");
    myId = res.you; setRoom(res.code); rememberName(nameValue()); show("room"); applyCrown();
  });
};
$("spBtn").onclick = () => { location.href = "index.html"; };
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
    const b = $("copyInvite"), orig = "🔗 Copy invite link";
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

const AV = ["#2f5fd0", "#7a4dd6"];
socket.on("roomState", (room) => {
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
    div.innerHTML = `<div class="avatar" style="background:${AV[i % AV.length]}">${p.name[0].toUpperCase()}</div>
      <div class="name">${p.name}${p.crown ? '<span class="crown" title="Creator">👑</span>' : ""}${p.id === myId ? " (you)" : ""}</div>${tag}`;
    list.appendChild(div);
  });
  if (room.players.length < 2) {
    const div = document.createElement("div");
    div.className = "player empty";
    div.innerHTML = `<div class="avatar" style="background:#2a2f3e">?</div><div class="name">waiting for opponent…</div>`;
    list.appendChild(div);
  }
  const canStart = iAmHost && room.players.length >= 2;
  $("startBtn").classList.toggle("hidden", !iAmHost);
  $("startBtn").disabled = !canStart;
  $("roomStatus").textContent = iAmHost ? (canStart ? "" : "Waiting for a second player…") : "Waiting for the host to start…";

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

socket.on("chat", ({ id, name, text }) => {
  $("typing").classList.add("hidden"); $("typing").textContent = ""; // they sent it → no longer typing
  const feed = $("feed");
  const div = document.createElement("div");
  div.className = "chat" + (id === myId ? " mine" : "");
  const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = name + ": ";
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

socket.on("gameState", (state) => { gs = state; render(); });

// 🎯 Easter egg: someone answered "Prove It!" in the Video Games round → +5 + a party for everyone.
socket.on("easterEgg", ({ name, phrase, fx }) => {
  confettiBurst();
  const restart = (el) => { if (!el) return; el.classList.remove("party"); void el.offsetWidth; el.classList.add("party"); };
  if (fx === "crown") document.querySelectorAll(".crown").forEach(restart); // "Jayden Lin" → only the crown reacts
  else restart($("mpLogo"));                                                // "Prove It!" → only the logo reacts
  flashStatus(`🎯 ${name} said "${phrase || "the magic words"}" — +5 bonus points!`);
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

  $("gRoom").textContent = myRoom ? "Room " + myRoom : "";

  // sidebar players (you first), with turn highlight
  const sidePlayers = $("sidePlayers");
  sidePlayers.innerHTML = "";
  const colors = ["#2f5fd0", "#7a4dd6"];
  const live = gs.phase !== "roundover" && gs.phase !== "matchover" && !gs.paused;
  [me, opp].forEach((p, i) => {
    if (!p) return;
    const d = document.createElement("div");
    d.className = "player" + (live && gs.turnId === p.id ? " turn" : "");
    d.innerHTML = `<div class="avatar" style="background:${colors[i]}">${p.name[0].toUpperCase()}</div>
      <div class="name">${p.name}${p.crown ? '<span class="crown" title="Creator">👑</span>' : ""}</div><div class="pts">${gs.scores[p.id] ?? 0}</div>`;
    sidePlayers.appendChild(d);
  });

  // banner
  $("catLabel").textContent = `${gs.category.emoji} ${gs.category.group}`;
  $("catName").textContent = gs.category.name;
  $("claimLine").textContent = gs.claim ? `Standing claim: ${gs.claim} (${nameOf(gs.holderId)})` : "";

  $("mpCatBtn").style.display = iAmHost ? "inline-block" : "none"; // host can switch categories
  if ($("mpCatMenu").style.display !== "none") syncCatMenu();

  const input = $("input"), sendBtn = $("send"), actions = $("actions"), status = $("gstatus");
  actions.innerHTML = "";
  status.className = "";
  let enable = false, placeholder = "Type / to chat…", statusText = "";
  const myTurn = gs.turnId === myId;

  if (gs.phase === "opening") {
    if (myTurn) { enable = true; placeholder = "👉 Your turn — type a number to open!"; statusText = "👉 You're opening — how many can you name?"; }
    else statusText = `Waiting for ${nameOf(gs.turnId)} to open…`;
  } else if (gs.phase === "bidding") {
    if (myTurn) {
      placeholder = `Raise higher than ${gs.claim}, or…`;
      enable = true;
      addBtn(actions, `⬆️ Raise to ${gs.claim + 1}`, "raise", () => socket.emit("raise", {}, ackErr));
      addBtn(actions, "🗣️ Prove It!", "danger", () => socket.emit("proveIt", {}, ackErr));
    } else statusText = `${nameOf(gs.turnId)} is deciding — raise or call Prove It!`;
  } else if (gs.phase === "proving") {
    // (proving handled below)
  }

  // Either player can propose skipping the category before the duel starts.
  if (gs.phase === "opening" || gs.phase === "bidding") {
    addBtn(actions, gs.skipVotes ? `🔁 Skip category (${gs.skipVotes}/2)` : "🔁 Skip category", "", () => socket.emit("voteSkip"));
  }

  if (gs.phase === "proving") {
    if (myTurn) {
      enable = true; placeholder = `Name a ${gs.category.name}…`;
      addBtn(actions, "🏳️ Give up", "danger", () => socket.emit("giveUp"));
      statusText = `Proving ${gs.proven}/${gs.claim}`;
    } else {
      statusText = `${nameOf(gs.turnId)} is proving… (${gs.proven}/${gs.claim})`;
    }
  } else if (gs.phase === "judging") {
    statusText = gs.challengerId === myId
      ? "⏰ Time! Rule on the remaining off-list answers."
      : `${nameOf(gs.holderId)}'s off-list answers are being ruled on…`;
  } else if (gs.phase === "roundover") {
    if (gs.intermission) {
      // Waiting for a player to advance (auto-advance off, or paused).
      statusText = gs.autoAdvance ? "⏸ Paused — press P or tap for the next round" : "Press P or tap for the next round";
      addBtn(actions, "▶️ Next round (P)", "again", () => socket.emit("nextRound"));
    } else {
      statusText = "Next round coming up…";
      addBtn(actions, "⏸ Pause", "", () => socket.emit("pauseRound"));
    }
  } else if (gs.phase === "matchover") {
    statusText = `🏆 ${nameOf(gs.matchWinnerId)} wins the match!`;
    if (iAmHost) addBtn(actions, "🔁 Play again", "again", () => socket.emit("rematch", {}, ackErr));
    addBtn(actions, "🏠 Leave", "danger", () => { socket.emit("leaveRoom"); setRoom(null); show("home"); });
  }

  // Frozen while an opponent is reconnecting — overrides all controls.
  if (gs.paused) {
    $("gpending").innerHTML = "";
    actions.innerHTML = "";
    input.disabled = false; sendBtn.disabled = false; // chat still works while frozen
    if (!chatMode) input.placeholder = "Paused — type / to chat…";
    status.textContent = "⏸ Opponent disconnected — waiting up to 30s for them to reconnect…";
    return;
  }

  renderPending();

  // input is always usable so chat works any time; game actions are gated in gameSend
  input.disabled = false;
  sendBtn.disabled = false;
  if (!chatMode) { // don't disturb the box while composing a chat message
    input.placeholder = placeholder;
    if (enable) input.focus();
  }
  status.textContent = statusText;

  // Unmissable cue for whoever's opening: red glow on the box + a shake when it becomes their turn.
  const iAmOpening = gs.phase === "opening" && gs.turnId === myId && !chatMode;
  input.classList.toggle("opening-cue", iAmOpening);
  if (iAmOpening && !wasMyOpen) shakeInput();
  wasMyOpen = iAmOpening;
}
let wasMyOpen = false;

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
      note(box, `⏳ Off-list, waiting on opponent: ${pending.map((p) => p.text).join(", ")}`);
    }
  } else if (gs.phase === "judging") {
    // forced ruling — one at a time
    const a = gs.judgeActive;
    if (!a) return;
    if (amJudge) {
      judgeRow(box, a);
      if (gs.judgeRemaining > 1) rejectAllBtn(box, `Reject remaining (${gs.judgeRemaining})`);
    } else {
      note(box, `⏰ Opponent ruling: “${a.text}” (${gs.judgeRemaining} left)`);
    }
  }
}
function ackErr(r) { if (r && !r.ok && r.error) flashStatus(r.error); }
function flashStatus(msg) { const s = $("gstatus"); s.textContent = msg; s.className = "err"; }

// ---------- input send (context depends on phase) ----------
function gameSend() {
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
function exitChat() {
  chatDraft = $("input").value;          // keep the draft so re-opening restores it
  chatMode = false;
  stopTyping();
  $("inputbar").classList.remove("chat-mode");
  $("input").value = "";
  if (gs) render(); // restore the normal game placeholder/state
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

// ---------- server-driven timer (render the countdown from the deadline) ----------
setInterval(() => {
  const t = $("timer");
  if (!gs || !gs.deadline || gs.paused) { t.textContent = ""; t.classList.remove("danger"); return; }
  const left = Math.max(0, Math.ceil((gs.deadline - Date.now()) / 1000));
  t.textContent = "⏱ " + left + "s";
  const danger = gs.phase === "proving" ? left <= 10 : left <= 3;
  t.classList.toggle("danger", danger);
}, 250);
