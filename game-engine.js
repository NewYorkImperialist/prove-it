// Prove It! — server-side duel engine (Phase 2)
// One match lives on room.game. The server is authoritative: it owns the turn
// state machine, the clocks, and answer validation. Clients send intents and
// render the broadcast snapshots.
const CATEGORY_GROUPS = require("./categories.js");

const OPEN_MS = 20_000;       // time to open with a number
const TURN_MS = 10_000;       // time to raise / call Prove It!
const ROUNDOVER_MS = 4_500;   // pause between rounds
const JUDGE_MS_PER = 5_000;   // forced end-of-round ruling: seconds per remaining off-list answer
const ANSWER_COOLDOWN_MS = 350; // min gap between a prover's submissions (anti-spam)
const MAX_PENDING = 6;          // max off-list answers awaiting a ruling at once
const MAX_OFFLIST = 15;         // max off-list answers a prover can queue per round
const DEFAULTS = { timer: 30, target: 5, autoAdvance: true }; // prove seconds, points to win, auto next round

// Optional analytics hook — server.js sets this to persist game/round events. No-op by default.
let report = () => {};
function setReporter(fn) { report = typeof fn === "function" ? fn : () => {}; }

// ---------- matching helpers (mirror the client) ----------
function norm(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}
function buildCategory(cat, group, emoji) {
  return {
    name: cat.name, group, emoji, exact: !!cat.exact,
    entries: cat.items.map((item, id) => {
      const names = Array.isArray(item) ? item : [item];
      return { id, display: names[0], aliases: names.map(norm) };
    }),
  };
}
function resolve(cat, value) {
  const q = norm(value);
  return cat.entries.find((e) => e.aliases.includes(q)) || null;
}
function buildPool(settings) {
  const groups = settings?.groups?.length ? settings.groups : Object.keys(CATEGORY_GROUPS);
  return groups.flatMap((k) =>
    (CATEGORY_GROUPS[k]?.cats || []).map((c) => buildCategory(c, k, CATEGORY_GROUPS[k].emoji)));
}

// ---------- small utilities ----------
const other = (g, id) => g.order.find((x) => x !== id);
const total = (g) => g.proven.length + (g.granted ? g.granted.length : 0) + (g.bonus || 0); // listed + opponent-granted + bonus
function clearTimer(room) {
  if (room.game?.timeout) { clearTimeout(room.game.timeout); room.game.timeout = null; }
}
function setTimer(room, ms, fn, { deadline = true } = {}) {
  clearTimer(room);
  const g = room.game;
  g.timerFn = fn; g.timerMs = ms; g.timerDeadline = deadline; // remembered so a paused timer can resume
  g.deadline = deadline ? Date.now() + ms : null;
  g.timeout = setTimeout(() => { g.timeout = null; fn(); }, ms);
}

// Freeze the clock when a player drops; resume re-arms it with the time that was left.
function pauseGame(io, room) {
  const g = room.game;
  if (!g || g.paused) return;
  if (g.timeout) {
    g.pausedRemaining = g.deadline ? Math.max(500, g.deadline - Date.now()) : g.timerMs;
    clearTimeout(g.timeout); g.timeout = null;
  } else {
    g.pausedRemaining = null;
  }
  g.deadline = null; g.paused = true;
  emit(io, room);
}
function resumeGame(io, room) {
  const g = room.game;
  if (!g) return;
  if (g.paused) {
    g.paused = false;
    // don't re-arm the clock if the players intentionally paused between rounds
    if (g.timerFn && !g.intermission) setTimer(room, g.pausedRemaining ?? g.timerMs ?? 2000, g.timerFn, { deadline: g.timerDeadline !== false });
  }
  emit(io, room); // push current state to (re)connected clients
}

// Manual intermission pause — only valid between rounds while auto-advance is on.
function handlePauseRound(io, room, socket) {
  const g = room.game;
  if (!g || g.phase !== "roundover" || g.intermission || !g.autoAdvance) return;
  clearTimer(room); // cancel the auto-advance to the next round
  g.intermission = true;
  log(io, room, "system", null, `${g.names[socket.data.playerId]} paused the game.`);
  report(room, "event", { type: "pause" });
  emit(io, room);
}
// Either player advances to the next round (manual auto-advance-off mode, or resume from pause).
function handleNextRound(io, room, socket) {
  const g = room.game;
  if (!g || g.phase !== "roundover") return;
  beginRound(io, room);
}
// Vote to end the whole match — endless mode only, needs both players to agree.
function handleVoteEnd(io, room, socket) {
  const g = room.game;
  if (!g || g.target !== Infinity || g.phase === "matchover") return; // endless only
  const pid = socket.data.playerId;
  if (!g.endVotes) g.endVotes = new Set();
  if (g.endVotes.has(pid)) return; // one vote per player
  g.endVotes.add(pid);
  if (g.endVotes.size >= 2) {
    const [a, b] = g.order;
    const sa = g.scores[a] || 0, sb = g.scores[b] || 0;
    if (sa === sb) { // ended by mutual vote with a tied score
      clearTimer(room);
      g.phase = "matchover"; g.deadline = null; g.matchWinnerId = null;
      log(io, room, "system", null, `Game ended by vote — it's a tie! (${sa}–${sb})`);
      return emit(io, room);
    }
    return matchOver(io, room, sa > sb ? a : b, "vote-end");
  }
  // first vote → pause any auto-advance so the other player can respond
  if (g.phase === "roundover" && g.autoAdvance && !g.intermission) { clearTimer(room); g.intermission = true; }
  log(io, room, "system", null, `${g.names[pid]} wants to end the game (1/2).`);
  emit(io, room);
}

// Vote to skip the current category — needs both players to agree. Only before the duel starts.
function handleVoteSkip(io, room, socket) {
  const g = room.game;
  if (!g || (g.phase !== "opening" && g.phase !== "bidding")) return;
  const pid = socket.data.playerId;
  if (!g.skipVotes) g.skipVotes = new Set();
  if (g.skipVotes.has(pid)) return; // one vote per player
  g.skipVotes.add(pid);
  if (g.skipVotes.size >= 2) {
    log(io, room, "system", null, "Both players skipped — new category.");
    report(room, "event", { type: "categorySkipped", detail: g.current.name });
    return beginRound(io, room); // fresh category, no points awarded
  }
  log(io, room, "system", null, `${g.names[pid]} wants to skip this category (1/2).`);
  emit(io, room);
}

// ---------- emit ----------
function snapshot(room) {
  const g = room.game;
  return {
    phase: g.phase, round: g.round,
    category: { name: g.current.name, group: g.current.group, emoji: g.current.emoji, size: g.current.entries.length },
    claim: g.claim, holderId: g.holderId, turnId: g.turnId, challengerId: g.challengerId || null, deadline: g.deadline || null,
    proven: g.proven ? total(g) : 0,
    wpm: g.wpm || 0, // live typing speed of whoever's proving (chars/5 over time since first answer)
    pending: g.pending ? [...g.pending.values()].map((p) => ({ id: p.id, text: p.text })) : [],
    judgeActive: g.judgeActive ? { id: g.judgeActive.id, text: g.judgeActive.text } : null,
    judgeRemaining: g.judgeQueue ? g.judgeQueue.length : 0,
    scores: g.scores, target: g.target === Infinity ? null : g.target, timer: g.timer,
    players: g.order.map((id) => ({ id, name: g.names[id], crown: !!room.players.get(id)?.crown })),
    spectators: room.spectators ? room.spectators.size : 0,
    lastResult: g.lastResult || null,
    matchWinnerId: g.matchWinnerId || null,
    paused: !!g.paused,
    intermission: !!g.intermission,
    autoAdvance: g.autoAdvance !== false,
    skipVotes: g.skipVotes ? g.skipVotes.size : 0,
    endVotes: g.endVotes ? g.endVotes.size : 0,
    groups: g.groups || [],
  };
}
function emit(io, room) { io.to(room.code).emit("gameState", snapshot(room)); }
function log(io, room, by, name, text, kind) { io.to(room.code).emit("log", { by, name, text, kind: kind || null }); }

// ---------- lifecycle ----------
function startMatch(io, room) {
  const order = [...room.players.keys()];
  const names = Object.fromEntries([...room.players.values()].map((p) => [p.id, p.name]));
  const s = { ...DEFAULTS, ...(room.settings || {}) };
  room.game = {
    order, names, pool: buildPool(room.settings), groups: (room.settings?.groups || []).slice(),
    scores: { [order[0]]: 0, [order[1]]: 0 },
    timer: s.timer, target: s.target == null ? Infinity : s.target, // null settings → endless
    autoAdvance: s.autoAdvance !== false, skipVotes: new Set(),
    round: 0, usedNames: [], lastCatName: null,
    claim: 0, holderId: null, turnId: null, proven: [], current: null,
    phase: "starting", deadline: null, timeout: null,
    lastResult: null, matchWinnerId: null, challengerId: null,
    startedAt: Date.now(),
    gid: "g-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7), // unique per match (threads rounds/answers/chat together)
  };
  io.to(room.code).emit("gameStarted", { players: snapshot.length });
  beginRound(io, room);
}

function beginRound(io, room) {
  const g = room.game;
  g.round++;
  let avail = g.pool.filter((c) => !g.usedNames.includes(c.name));
  if (!avail.length) { g.usedNames = []; avail = g.pool.filter((c) => c.name !== g.lastCatName); if (!avail.length) avail = g.pool; }
  const c = avail[Math.floor(Math.random() * avail.length)];
  g.usedNames.push(c.name); g.lastCatName = c.name; g.current = c;
  g.claim = 0; g.holderId = null; g.proven = []; g.lastResult = null; g.challengerId = null;
  g.intermission = false; g.skipVotes = new Set(); g.endVotes = new Set();

  const opener = g.order[(g.round - 1) % 2];
  g.turnId = opener; g.phase = "opening";
  log(io, room, "system", null, `Round ${g.round} · ${c.group}: ${c.name}`);
  log(io, room, "system", null, `${g.names[opener]} opens — how many ${c.name} can you name?`);
  setTimer(room, OPEN_MS, () => roundOver(io, room, other(g, opener), `${g.names[opener]} didn't open in time`));
  emit(io, room);
}

function handleOpen(io, room, socket, n, ack) {
  const g = room.game;
  if (!g || g.phase !== "opening" || socket.data.playerId !== g.turnId) return ack?.({ ok: false });
  const size = g.current.entries.length;
  if (!Number.isInteger(n) || n < 1) return ack?.({ ok: false, error: "Enter a whole number ≥ 1." });
  if (n > size) return ack?.({ ok: false, error: g.current.exact ? `There are only ${size} ${g.current.name}.` : `That's too many — try a smaller number.` });
  g.claim = n; g.holderId = socket.data.playerId;
  log(io, room, socket.data.playerId, g.names[socket.data.playerId], `I can name ${n}.`);
  passBidTurn(io, room, other(g, socket.data.playerId));
  ack?.({ ok: true });
}

function handleRaise(io, room, socket, toN, ack) {
  const g = room.game;
  if (!g || g.phase !== "bidding" || socket.data.playerId !== g.turnId) return ack?.({ ok: false });
  const size = g.current.entries.length;
  const next = Number.isInteger(toN) ? toN : g.claim + 1;
  if (next <= g.claim) return ack?.({ ok: false, error: `You have to go higher than ${g.claim}.` });
  if (next > size) return ack?.({ ok: false, error: g.current.exact ? `There are only ${size} ${g.current.name}.` : `That's too many — try a smaller number.` });
  g.claim = next; g.holderId = socket.data.playerId;
  log(io, room, socket.data.playerId, g.names[socket.data.playerId], `Make it ${next}.`);
  passBidTurn(io, room, other(g, socket.data.playerId));
  ack?.({ ok: true });
}

function passBidTurn(io, room, toId) {
  const g = room.game;
  g.turnId = toId; g.phase = "bidding";
  setTimer(room, TURN_MS, () => startProving(io, room, g.turnId)); // stalling = you call Prove It!
  emit(io, room);
}

function handleProveIt(io, room, socket, ack) {
  const g = room.game;
  if (!g || g.phase !== "bidding" || socket.data.playerId !== g.turnId) return ack?.({ ok: false });
  ack?.({ ok: true });
  startProving(io, room, socket.data.playerId);
}

function startProving(io, room, challengerId) {
  const g = room.game;
  const proverId = g.holderId;
  g.phase = "proving"; g.turnId = proverId; g.challengerId = challengerId;
  g.proven = []; g.granted = []; g.pending = new Map(); g.answerSeq = 0; g.lastAnswerAt = 0;
  g.judgeQueue = []; g.judgeActive = null; g.offListCount = 0; g.bonus = 0;
  g.wpmChars = 0; g.wpmStart = 0; g.wpm = 0; // typing-speed tracking for the prover
  log(io, room, challengerId, g.names[challengerId], `Prove it! ${g.names[proverId]}, name ${g.claim}.`);
  setTimer(room, g.timer * 1000, () => onProveTimeout(io, room));
  emit(io, room);
}

// Clock ran out. If off-list answers are still unruled, force the opponent to
// rule on them (5s each, default reject) before the round resolves.
function onProveTimeout(io, room) {
  const g = room.game;
  // Nothing pending, or even accepting all of it can't reach the goal → no ruling needed.
  if (g.pending.size === 0 || total(g) + g.pending.size < g.claim) {
    return roundOver(io, room, g.challengerId, "Time's up");
  }
  g.phase = "judging"; g.turnId = g.challengerId;
  g.judgeQueue = [...g.pending.values()];
  log(io, room, "system", null, `Time! ${g.names[g.challengerId]} must rule on ${g.judgeQueue.length} off-list answer(s) — 5s each.`);
  presentNextJudgment(io, room);
}

// Show the next off-list answer for a forced ruling (one at a time, 5s each, default reject).
function presentNextJudgment(io, room) {
  const g = room.game;
  if (total(g) >= g.claim) return roundOver(io, room, g.holderId, "Proved it!"); // already enough → done
  if (!g.judgeQueue || g.judgeQueue.length === 0) return finalizeJudging(io, room);
  g.judgeActive = g.judgeQueue[0];
  setTimer(room, JUDGE_MS_PER, () => {
    const a = g.judgeActive;
    g.pending.delete(a.id); g.judgeQueue.shift(); g.judgeActive = null;
    log(io, room, "system", null, `No ruling — "${a.text}" rejected.`, "bad");
    presentNextJudgment(io, room);
  });
  emit(io, room);
}

function handleAnswer(io, room, socket, text, ack) {
  const g = room.game;
  if (!g || g.phase !== "proving" || socket.data.playerId !== g.turnId) return;
  const now = Date.now();
  if (g.lastAnswerAt && now - g.lastAnswerAt < ANSWER_COOLDOWN_MS) return ack?.({ ok: false, reason: "cooldown" });
  g.lastAnswerAt = now;
  // live typing speed (prover): chars/5 over time since their first answer this round
  g.wpmChars = (g.wpmChars || 0) + String(text || "").trim().length;
  if (!g.wpmStart) g.wpmStart = now;
  g.wpm = Math.round((g.wpmChars / 5) / Math.max(1 / 60, (now - g.wpmStart) / 60000));
  const me = g.names[socket.data.playerId];

  // 🇮🇱 Troll easter egg: on US Presidents, "Benjamin Netanyahu" is worth +50 toward the claim.
  if (g.current.name === "US Presidents" && ["benjamin netanyahu", "netanyahu", "bibi"].includes(norm(text))) {
    g.bonus = (g.bonus || 0) + 50;
    log(io, room, socket.data.playerId, me, `Benjamin Netanyahu ✓✓✓ +50! (${total(g)}/${g.claim})`, "ok");
    if (total(g) >= g.claim) { ack?.({ ok: true }); return roundOver(io, room, socket.data.playerId, "Nailed it!"); }
    ack?.({ ok: true });
    return emit(io, room);
  }

  const entry = resolve(g.current, text);

  if (entry) {
    if (g.proven.includes(entry.id)) {
      log(io, room, socket.data.playerId, me, `already got ${entry.display}`, "bad");
    } else {
      g.proven.push(entry.id);
      log(io, room, socket.data.playerId, me, `${entry.display} ✓ (${total(g)}/${g.claim})`, "ok");
      report(room, "answer", { category: g.current.name, grp: g.current.group, display: entry.display, offList: false, player: me });
      // 🛢️ Strait of Hormuz → rain oil barrels (no points, just chaos).
      if (g.current.name === "Seas and Oceans" && entry.display === "Strait of Hormuz") {
        io.to(room.code).emit("easterEgg", { name: me, phrase: entry.display, fx: "oil" });
      }
      // 🎯 Easter eggs: special answers = +5 bonus points + a party (just for fun).
      const isEgg = (g.current.name === "Video Games" && entry.display === "Prove It!")
                 || (g.current.name === "Famous Mathematicians" && entry.display === "Jayden Lin");
      if (isEgg) {
        report(room, "event", { type: "easterEgg", detail: entry.display });
        const pid = socket.data.playerId;
        g.scores[pid] = (g.scores[pid] || 0) + 5;
        log(io, room, "system", null, `${me} said the magic words — +5 bonus points!`);
        // fx: "logo" → the Prove It! logo reacts; "crown" → the creator's crown reacts.
        io.to(room.code).emit("easterEgg", { name: me, phrase: entry.display, fx: entry.display === "Jayden Lin" ? "crown" : "logo" });
        // The bonus can win the match outright (it's only otherwise checked at round end).
        if (g.target !== Infinity && g.scores[pid] >= g.target) { ack?.({ ok: true }); return matchOver(io, room, pid); }
      }
      if (total(g) >= g.claim) { ack?.({ ok: true }); return roundOver(io, room, socket.data.playerId, "Nailed it!"); }
    }
    ack?.({ ok: true });
    return emit(io, room);
  }

  // ----- off-list answer → opponent rules (with spam caps) -----
  const q = norm(text);
  if (g.granted.includes(q) || [...g.pending.values()].some((p) => p.q === q)) {
    log(io, room, socket.data.playerId, me, `${text} — already counted/awaiting`, "bad");
    ack?.({ ok: true });
    return emit(io, room);
  }
  if (g.pending.size >= MAX_PENDING) {
    return ack?.({ ok: false, reason: "pending" }); // bounce; resubmit once a slot frees
  }
  if (g.offListCount >= MAX_OFFLIST) {
    log(io, room, socket.data.playerId, me, `${text} ✗ too many off-list guesses this round`, "bad");
    ack?.({ ok: false, reason: "roundcap" });
    return emit(io, room);
  }
  const id = ++g.answerSeq;
  g.pending.set(id, { id, text, q });
  g.offListCount++;
  log(io, room, socket.data.playerId, me, `${text} — not on my list, opponent decides`, "pending");
  ack?.({ ok: true });
  emit(io, room);
}

// The opponent (challenger) rules on an off-list answer — works live during the
// round and during the forced end-of-round click-through.
function handleJudge(io, room, socket, { answerId, accept } = {}) {
  const g = room.game;
  if (!g || socket.data.playerId !== g.challengerId) return;
  if (g.phase === "proving") {
    // live ruling: judge any pending answer
    const p = g.pending.get(answerId);
    if (!p) return;
    applyRuling(io, room, p, accept);
    if (total(g) >= g.claim) return roundOver(io, room, g.holderId, "Proved it!");
    emit(io, room);
  } else if (g.phase === "judging") {
    // forced end-of-round ruling: only the active (front-of-queue) answer
    const a = g.judgeActive;
    if (!a || a.id !== answerId) return;
    clearTimer(room);
    applyRuling(io, room, a, accept);
    g.judgeQueue.shift(); g.judgeActive = null;
    presentNextJudgment(io, room);
  }
}

// Reject everything still pending in one tap (kills end-of-round spam).
function handleRejectAll(io, room, socket) {
  const g = room.game;
  if (!g || socket.data.playerId !== g.challengerId) return;
  if (g.phase === "proving") {
    if (g.pending.size === 0) return;
    const n = g.pending.size; g.pending.clear();
    log(io, room, socket.data.playerId, g.names[socket.data.playerId], `rejected all (${n})`, "bad");
    emit(io, room);
  } else if (g.phase === "judging") {
    clearTimer(room);
    const n = g.judgeQueue.length;
    g.pending.clear(); g.judgeQueue = []; g.judgeActive = null;
    if (n) log(io, room, socket.data.playerId, g.names[socket.data.playerId], `rejected all (${n})`, "bad");
    finalizeJudging(io, room);
  }
}

function applyRuling(io, room, p, accept) {
  const g = room.game;
  g.pending.delete(p.id);
  if (accept) {
    g.granted.push(p.q);
    log(io, room, g.challengerId, g.names[g.challengerId], `accepted "${p.text}" ✓ (${total(g)}/${g.claim})`, "ok");
    report(room, "answer", { category: g.current.name, grp: g.current.group, display: p.text, offList: true, player: g.names[g.holderId] });
  } else {
    log(io, room, g.challengerId, g.names[g.challengerId], `rejected "${p.text}"`, "bad");
    report(room, "event", { type: "rejected", detail: `${p.text} (by ${g.names[g.challengerId]})` });
  }
}

function finalizeJudging(io, room) {
  // reached only when the prover is still short → the challenger takes it
  roundOver(io, room, room.game.challengerId, "Time's up");
}

function handleGiveUp(io, room, socket) {
  const g = room.game;
  if (!g || g.phase !== "proving" || socket.data.playerId !== g.turnId) return;
  roundOver(io, room, g.challengerId, `${g.names[socket.data.playerId]} gave up`);
}

function roundOver(io, room, winnerId, reason) {
  clearTimer(room);
  const g = room.game;
  g.scores[winnerId] = (g.scores[winnerId] || 0) + 1;
  g.phase = "roundover"; g.deadline = null;
  g.lastResult = { winnerId, winnerName: g.names[winnerId], reason, claim: g.claim, proven: g.proven.length };
  g.intermission = false;
  log(io, room, "system", null, `${reason} — point ${g.names[winnerId]} (${g.scores[g.order[0]]}–${g.scores[g.order[1]]})`);
  report(room, "round", { winnerId, winnerName: g.names[winnerId], category: g.current.name, grp: g.current.group, claim: g.claim, proven: total(g) });
  if (g.target !== Infinity && g.scores[winnerId] >= g.target) return matchOver(io, room, winnerId);
  if (g.autoAdvance) {
    setTimer(room, ROUNDOVER_MS, () => beginRound(io, room), { deadline: false });
  } else {
    g.intermission = true; // auto-advance off → wait for a player to press P / tap Next round
  }
  emit(io, room);
}

function matchOver(io, room, winnerId, reason) {
  clearTimer(room);
  const g = room.game;
  g.phase = "matchover"; g.deadline = null; g.matchWinnerId = winnerId;
  log(io, room, "system", null, winnerId ? `${g.names[winnerId]} wins the match! (${g.scores[g.order[0]]}–${g.scores[g.order[1]]})` : "Match over.");
  report(room, "end", { winnerId, reason: reason || "win" });
  emit(io, room);
}

function handleRematch(io, room, socket, ack) {
  if (room.hostId !== socket.data.playerId) return ack?.({ ok: false, error: "Only the host can restart." });
  if (room.players.size < 2) return ack?.({ ok: false, error: "Need 2 players." });
  ack?.({ ok: true });
  startMatch(io, room);
}

// Host tweaked timer / win target / auto-advance mid-match. Applies going forward.
function applyLiveSettings(io, room, { timer, target, autoAdvance } = {}) {
  const g = room.game;
  if (!g) return;
  if (typeof timer === "number") g.timer = timer;
  if (target !== undefined) g.target = target == null ? Infinity : target;
  if (typeof autoAdvance === "boolean") g.autoAdvance = autoAdvance;
  log(io, room, "system", null, "Host updated the game settings.");
  // lowering the win target may already decide the match
  if (g.phase !== "matchover" && g.target !== Infinity) {
    const leader = g.order.find((id) => (g.scores[id] || 0) >= g.target);
    if (leader) return matchOver(io, room, leader, "target-changed");
  }
  emit(io, room);
}

// Host changed categories during a match → rebuild the pool for upcoming rounds.
function setGroups(io, room, groups) {
  if (!room.game) return;
  const valid = (groups || []).filter((k) => CATEGORY_GROUPS[k]);
  if (!valid.length) return;
  room.game.pool = buildPool({ groups: valid });
  room.game.groups = valid;
  room.settings = { ...(room.settings || {}), groups: valid };
  log(io, room, "system", null, "Categories updated — applies next round.");
  emit(io, room); // push the new groups so menus/state reflect it
}

// A player left mid-match: stop the clocks and tell whoever remains.
function endGameForLeaver(io, room, leaverId) {
  if (!room.game) return;
  clearTimer(room);
  const g = room.game;
  const name = g.names[leaverId] || "Your opponent";
  report(room, "end", { winnerId: other(g, leaverId), reason: "forfeit" }); // the player who stayed wins by forfeit
  room.game = null;
  room.status = "waiting";
  io.to(room.code).emit("opponentLeft", { name });
}

module.exports = {
  startMatch, handleOpen, handleRaise, handleProveIt, handleAnswer, handleJudge, handleRejectAll, handleGiveUp, handleRematch, endGameForLeaver, pauseGame, resumeGame, setGroups, applyLiveSettings, handlePauseRound, handleNextRound, handleVoteSkip, handleVoteEnd, setReporter,
  resync: (io, room) => { if (room.game) emit(io, room); },
};
