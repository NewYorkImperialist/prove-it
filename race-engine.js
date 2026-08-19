// Prove It! · server-side "Challenge Race" engine
// 2+ players get the same category at once (a live version of solo/daily challenge).
//
// CLOCKS ARE PER PLAYER. Everyone starts a round with the same `timer`, but the increment is a
// personal chess clock: a correct answer extends only the answerer's own clock, so a player on a
// hot streak keeps going while the others' clocks run down. When your clock expires you're done
// for the round and you wait — the round itself only ends once EVERY active player's clock has
// expired (see sweepClocks/allClocksDone). Every clock is capped, though (MAX_CLOCK_FACTOR), so
// one hot streak can't leave the rest of the room waiting for minutes.
//
// The server is authoritative: it owns those clocks and all answer validation. Live state
// broadcasts to the room ONLY ever expose each player's running COUNT (never their actual
// answers) — the full per-player answer/miss list only goes out via "raceReveal", which cannot
// fire until every clock is done, so nobody can read an opponent's answers while still racing.
// A round's result isn't final the moment the last clock runs out, though: there's a review
// window where players can approve each other's missed/off-list answers (see handleApproveMiss),
// and only finalizeRound() locks in who actually won the round.
const CATEGORY_GROUPS = require("./data/categories.js");
const { norm, resolve, buildPool } = require("./lib/answer-matching.js");

const COUNTDOWN_MS = 3_000;   // 3-2-1-GO before each round's timer starts
const REVIEW_MS = 15_000;     // window to approve missed/off-list answers, only when there's something to review
const RESULT_MS = 5_000;      // pause showing the round's final result before the next round starts
const MAX_MISSES = 25;        // per player per round — anti-spam cap on tracked wrong answers
const MAX_CLOCK_FACTOR = 2;   // a round clock can never grow past this × the room's base timer
const DEFAULTS = { timer: 45, format: 5, suddenDeath: false, increment: 0 }; // format: 3|5|null(endless); increment: bonus seconds per correct answer

// Optional analytics hook · server.js sets this to persist match/round events. No-op by default.
let report = () => {};
function setReporter(fn) { report = typeof fn === "function" ? fn : () => {}; }

// ---------- timer plumbing (mirrors game-engine.js's setTimer/clearTimer/pause/resume) ----------
function clearTimer(room) {
  if (room.game?.timeout) { clearTimeout(room.game.timeout); room.game.timeout = null; }
}
function setTimer(room, ms, fn, { deadline = true } = {}) {
  clearTimer(room);
  const g = room.game;
  g.timerFn = fn; g.timerMs = ms; g.timerDeadline = deadline;
  g.deadline = deadline ? Date.now() + ms : null;
  g.timeout = setTimeout(() => { g.timeout = null; fn(); }, ms);
  if (g.timeout.unref) g.timeout.unref();
}
// ---------- per-player round clocks ----------
// Each active player has their own deadline in g.deadlines. One timeout is armed at a time, for
// whichever still-racing clock expires next; sweepClocks() then retires the players it finds
// expired and re-arms for the next one.
const stillRacing = (g, id) => g.activeIds.has(id) && !g.doneIds.has(id);
const allClocksDone = (g) => ![...g.activeIds].some((id) => !g.doneIds.has(id));
// The last clock standing — what spectators (and anyone whose own clock is gone) count down to.
function latestDeadline(g) {
  let latest = null;
  for (const id of g.activeIds) {
    const dl = g.deadlines[id];
    if (dl != null && (latest == null || dl > latest)) latest = dl;
  }
  return latest;
}

// Pay the increment onto one player's clock. The bonus is personal but not unlimited: left
// unbounded, a strong player on a 200-item category at +5s an answer adds a quarter of an hour to
// their own clock while everyone else sits watching a spent timer, and vote-skip can't rescue
// them because it needs the runaway player's own vote too. So a clock can never be pushed past
// g.clockCeiling (MAX_CLOCK_FACTOR × the base timer, measured from the round's start), which caps
// the whole round — and therefore the longest anyone has to wait — at a knowable length.
// Returns true when the ceiling swallowed some or all of the bonus.
function extendClock(g, id) {
  const wanted = (g.deadlines[id] || Date.now()) + g.increment * 1000;
  if (g.clockCeiling == null) { g.deadlines[id] = wanted; return false; } // pre-ceiling state (or a test fixture)
  g.deadlines[id] = Math.min(wanted, g.clockCeiling);
  return g.deadlines[id] < wanted;
}

function armRoundClock(io, room) {
  const g = room.game;
  if (g.phase !== "live" || g.paused) return;
  let next = null;
  for (const id of g.activeIds) {
    if (!stillRacing(g, id)) continue;
    const dl = g.deadlines[id];
    if (dl != null && (next == null || dl < next)) next = dl;
  }
  if (next == null) return endLiveRound(io, room); // nobody is still racing
  setTimer(room, Math.max(0, next - Date.now()), () => sweepClocks(io, room), { deadline: false });
  g.deadline = latestDeadline(g); // set after setTimer, which clears it when deadline:false
}

// Retire every player whose clock has run out, then either end the round or wait for the rest.
function sweepClocks(io, room) {
  const g = room.game;
  if (!g || g.phase !== "live") return;
  const cutoff = Date.now() + 50; // a few ms of slack so a clock doesn't need a second pass
  const retired = [];
  for (const id of g.activeIds) {
    if (!stillRacing(g, id)) continue;
    if ((g.deadlines[id] ?? 0) <= cutoff) {
      g.doneIds.add(id);
      delete g.deadlines[id]; // g.deadlines holds only clocks that are still running
      retired.push(id);
    }
  }
  // With no increment every clock expires together, so only announce the wait once we know
  // there's actually someone left to wait for.
  if (allClocksDone(g)) return endLiveRound(io, room);
  // Says who the room is now waiting on — no scores, no answers.
  for (const id of retired) log(io, room, "system", null, `${g.names[id]}'s time is up · waiting for the rest.`);
  if (retired.length) emit(io, room);
  armRoundClock(io, room);
}
function pauseGame(io, room) {
  const g = room.game;
  if (!g || g.paused) return;
  if (g.phase === "live") {
    // Freeze every clock individually, so nobody loses (or gains) time over the outage.
    g.pausedClocks = {};
    for (const id of g.activeIds) {
      if (!stillRacing(g, id)) continue;
      g.pausedClocks[id] = Math.max(500, (g.deadlines[id] ?? 0) - Date.now());
    }
    // The ceiling is an absolute time too, so it has to ride out the outage with the clocks it
    // caps — otherwise a long pause silently eats everyone's remaining bonus.
    g.pausedCeiling = g.clockCeiling == null ? null : Math.max(0, g.clockCeiling - Date.now());
    g.pausedRemaining = null;
  } else if (g.timeout) {
    g.pausedRemaining = g.deadline ? Math.max(500, g.deadline - Date.now()) : g.timerMs;
  } else {
    g.pausedRemaining = null;
  }
  if (g.timeout) { clearTimeout(g.timeout); g.timeout = null; }
  g.deadline = null; g.paused = true;
  emit(io, room);
}
function resumeGame(io, room) {
  const g = room.game;
  if (!g) return;
  if (g.paused) {
    g.paused = false;
    if (g.phase === "live") {
      const now = Date.now();
      for (const [id, ms] of Object.entries(g.pausedClocks || {})) g.deadlines[id] = now + ms;
      if (g.pausedCeiling != null) g.clockCeiling = now + g.pausedCeiling;
      g.pausedClocks = null; g.pausedCeiling = null;
      armRoundClock(io, room);
      return emit(io, room);
    }
    if (g.timerFn) setTimer(room, g.pausedRemaining ?? g.timerMs ?? 2000, g.timerFn, { deadline: g.timerDeadline !== false });
  }
  emit(io, room);
}

// ---------- emit ----------
function snapshot(room) {
  const g = room.game;
  return {
    phase: g.phase, round: g.round,
    category: g.current ? { name: g.current.name, group: g.current.group, emoji: g.current.emoji, size: g.current.entries.length } : null,
    // deadline = the LAST clock still running (what a spectator counts down to); each player
    // reads their own out of `deadlines`. Same information the running counts already carry.
    deadline: g.deadline || null, deadlines: { ...g.deadlines }, timer: g.timer, increment: g.increment || 0,
    clockCap: g.timer * MAX_CLOCK_FACTOR, // longest a single clock (so, a whole round) can run
    format: g.format, winsNeeded: g.winsNeeded, suddenDeath: !!g.suddenDeath, isTiebreaker: !!g.isTiebreaker,
    roundWins: g.order.map((id) => ({ id, name: g.names[id], wins: g.roundWins[id] || 0, active: g.activeIds.has(id) })),
    // score-only: a running count per player, NEVER the actual items they've named — that's
    // only ever sent once, in the "raceReveal" event, after the round's timer has ended.
    liveScores: g.order.map((id) => ({ id, name: g.names[id], score: g.activeIds.has(id) ? (g.liveScores[id] || 0) : null,
      active: g.activeIds.has(id), done: g.doneIds.has(id) })),
    // Whose clock has already expired this round — the rest of the room is waiting on the others.
    racing: [...g.activeIds].filter((id) => !g.doneIds.has(id)).length,
    matchWinnerId: g.matchWinnerId || null,
    paused: !!g.paused,
    endVotes: g.endVotes ? g.endVotes.size : 0,
    skipVotes: g.skipVotes ? g.skipVotes.size : 0,
    groups: g.groups || [],
    spectators: room.spectators ? room.spectators.size : 0,
  };
}
function emit(io, room) { io.to(room.code).emit("raceState", snapshot(room)); }
function log(io, room, by, name, text, kind) { io.to(room.code).emit("raceLog", { by, name, text, kind: kind || null }); }

// ---------- lifecycle ----------
function startMatch(io, room) {
  const order = [...room.players.keys()];
  const names = Object.fromEntries([...room.players.values()].map((p) => [p.id, p.name]));
  const s = { ...DEFAULTS, ...(room.settings || {}) };
  const format = s.format === 5 ? 5 : s.format === null ? null : 3; // only 3 | 5 | null are valid
  room.game = {
    order, names, activeIds: new Set(order), leftPlayers: new Set(),
    pool: buildPool(room.settings), groups: (room.settings?.groups || []).slice(),
    format, winsNeeded: format == null ? null : Math.ceil(format / 2), // bo3→2, bo5→3, endless→null
    suddenDeath: !!s.suddenDeath, tiebreakerCandidates: null,
    timer: s.timer || 30, increment: Number.isFinite(s.increment) ? Math.max(0, Math.min(30, s.increment)) : 0,
    roundWins: Object.fromEntries(order.map((id) => [id, 0])),
    round: 0, isTiebreaker: false, usedNames: [], lastCatName: null,
    current: null, phase: "starting", deadline: null, timeout: null,
    deadlines: {}, doneIds: new Set(), pausedClocks: null, // per-player round clocks
    clockCeiling: null, pausedCeiling: null, // set per round in startLiveRound; caps the increment
    answers: {}, liveScores: {}, misses: {}, missSeq: 0, lastReveal: null, matchWinnerId: null,
    paused: false, endVotes: new Set(), skipVotes: new Set(),
    startedAt: Date.now(),
    gid: "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
  };
  io.to(room.code).emit("raceGameStarted", {});
  beginRound(io, room);
}

function beginRound(io, room, opts = {}) {
  const g = room.game;
  g.round++;
  g.isTiebreaker = !!opts.tiebreaker;
  if (!opts.tiebreaker) g.tiebreakerCandidates = null;
  let avail = g.pool.filter((c) => !g.usedNames.includes(c.name));
  if (!avail.length) { g.usedNames = []; avail = g.pool.filter((c) => c.name !== g.lastCatName); if (!avail.length) avail = g.pool; }
  const c = avail[Math.floor(Math.random() * avail.length)];
  g.usedNames.push(c.name); g.lastCatName = c.name; g.current = c;
  g.answers = {}; g.liveScores = {}; g.misses = {}; g.missSeq = 0;
  g.endVotes = new Set(); // votes are a per-round intent check, not sticky across rounds
  g.skipVotes = new Set();
  g.deadlines = {}; g.doneIds = new Set(); g.pausedClocks = null;
  g.clockCeiling = null; g.pausedCeiling = null;
  for (const id of g.activeIds) { g.answers[id] = new Map(); g.liveScores[id] = 0; g.misses[id] = []; }
  g.phase = "countdown";
  log(io, room, "system", null, g.isTiebreaker ? `Sudden death! Round ${g.round} · ${c.group}: ${c.name}` : `Round ${g.round} · ${c.group}: ${c.name}`);
  setTimer(room, COUNTDOWN_MS, () => startLiveRound(io, room));
  emit(io, room);
}

function startLiveRound(io, room) {
  const g = room.game;
  g.phase = "live";
  const now = Date.now();
  const start = now + g.timer * 1000;
  g.doneIds = new Set();
  g.deadlines = Object.fromEntries([...g.activeIds].map((id) => [id, start])); // same start for all
  g.clockCeiling = now + g.timer * 1000 * MAX_CLOCK_FACTOR; // no increment may push a clock past this
  g.pausedCeiling = null;
  armRoundClock(io, room);
  emit(io, room);
}

// Snapshot of everyone's current answers/misses, used for both the initial (non-final) reveal
// and every subsequent update as misses get approved or the round gets finalized.
function currentPerPlayer(room) {
  const g = room.game;
  return [...g.activeIds].map((id) => {
    const mine = g.answers[id] || new Map();
    return {
      id, name: g.names[id], score: g.liveScores[id] || 0,
      got: [...mine.values()].map((v) => v.display),
      misses: (g.misses[id] || []).map((m) => ({ id: m.id, text: m.text })),
      missedCount: Math.max(0, g.current.entries.length - mine.size),
    };
  });
}

// Round timer ran out. Doesn't declare a winner yet — first there's a review window (only if
// anyone had off-list misses) where other players can approve one another's wrong answers,
// which can still change who won the round. See finalizeRound() for the actual scoring.
function endLiveRound(io, room) {
  clearTimer(room);
  const g = room.game;
  // Every clock is spent, so this is the first moment anyone's answers may leave the server.
  for (const id of g.activeIds) g.doneIds.add(id);
  g.deadlines = {}; g.clockCeiling = null; g.pausedCeiling = null;
  g.lastReveal = {
    round: g.round, category: { name: g.current.name, group: g.current.group, emoji: g.current.emoji },
    perPlayer: currentPerPlayer(room), final: false, roundWinnerIds: [], tie: false, suddenDeathTriggered: false,
  };
  io.to(room.code).emit("raceReveal", g.lastReveal);
  g.phase = "roundover"; g.deadline = null;
  emit(io, room);
  const hasMisses = [...g.activeIds].some((id) => (g.misses[id] || []).length > 0);
  if (hasMisses) setTimer(room, REVIEW_MS, () => finalizeRound(io, room));
  else finalizeRound(io, room); // nothing to review — go straight to the result
}

// Any OTHER active player can approve one of your missed/off-list answers during the review
// window (e.g. "Nowray" for "Norway") — first approval counts, mirrors the duel mode's
// single-judge model. Only valid before the round's result is finalized.
function handleApproveMiss(io, room, socket, targetId, missId) {
  const g = room.game;
  if (!g || g.phase !== "roundover" || g.lastReveal?.final) return;
  const approverId = socket.data.playerId;
  if (!approverId || approverId === targetId || !g.activeIds.has(approverId) || !g.activeIds.has(targetId)) return;
  const list = g.misses[targetId] || [];
  const idx = list.findIndex((m) => m.id === missId);
  if (idx === -1) return;
  const [miss] = list.splice(idx, 1);
  const mine = g.answers[targetId] || (g.answers[targetId] = new Map());
  mine.set(`approved:${miss.id}`, { display: miss.text, at: Date.now() }); // string key — never collides with a real entry id
  g.liveScores[targetId] = (g.liveScores[targetId] || 0) + 1;
  log(io, room, approverId, g.names[approverId], `approved "${miss.text}" for ${g.names[targetId]}`, "ok");
  report(room, "answer", { category: g.current.name, grp: g.current.group, display: miss.text, offList: true, player: g.names[targetId] });
  g.lastReveal = { ...g.lastReveal, perPlayer: currentPerPlayer(room) };
  io.to(room.code).emit("raceReveal", g.lastReveal);
  emit(io, room); // liveScores changed — refresh the score-only broadcast too
}

// Review window closed (or there was nothing to review) — now the round's result is locked in.
function finalizeRound(io, room) {
  clearTimer(room);
  const g = room.game;
  // In a sudden-death round, everyone plays again, but only the players who were tied
  // for the top spot last round decide the tiebreaker (v1 simplification — see plan).
  const pool = (g.isTiebreaker && g.tiebreakerCandidates)
    ? [...g.tiebreakerCandidates].filter((id) => g.activeIds.has(id))
    : [...g.activeIds];
  let maxScore = 0;
  for (const id of pool) maxScore = Math.max(maxScore, g.liveScores[id] || 0);
  const topScorers = pool.filter((id) => (g.liveScores[id] || 0) === maxScore);

  let roundWinnerIds = [], tie = false, suddenDeathTriggered = false;
  if (pool.length === 1) {
    roundWinnerIds = pool; g.roundWins[pool[0]] = (g.roundWins[pool[0]] || 0) + 1;
    g.isTiebreaker = false; g.tiebreakerCandidates = null;
  } else if (topScorers.length === 1) {
    roundWinnerIds = topScorers; g.roundWins[topScorers[0]] = (g.roundWins[topScorers[0]] || 0) + 1;
    g.isTiebreaker = false; g.tiebreakerCandidates = null;
  } else {
    tie = true;
    if (g.suddenDeath) { suddenDeathTriggered = true; g.tiebreakerCandidates = new Set(topScorers); }
    else { g.isTiebreaker = false; g.tiebreakerCandidates = null; }
  }

  g.lastReveal = { ...g.lastReveal, perPlayer: currentPerPlayer(room), final: true, roundWinnerIds, tie, suddenDeathTriggered };
  const winnerNames = roundWinnerIds.map((id) => g.names[id]).join(", ");
  log(io, room, "system", null, roundWinnerIds.length
    ? `${winnerNames} ${roundWinnerIds.length > 1 ? "win" : "wins"} the round with ${maxScore}!`
    : (suddenDeathTriggered ? `Tied at ${maxScore} — sudden death!` : `Tied at ${maxScore} — round is a draw.`));
  report(room, "round", { category: g.current.name, grp: g.current.group,
    winnerId: roundWinnerIds[0] || null, winnerName: winnerNames || null, claim: null, proven: maxScore,
    tie, tiebreaker: suddenDeathTriggered });
  io.to(room.code).emit("raceReveal", g.lastReveal);
  emit(io, room);

  const leaderId = g.winsNeeded != null ? g.order.find((id) => (g.roundWins[id] || 0) >= g.winsNeeded) : null;
  if (!suddenDeathTriggered && leaderId) {
    setTimer(room, RESULT_MS, () => matchOver(io, room, leaderId, "target"), { deadline: false });
  } else if (g.activeIds.size >= 2) {
    setTimer(room, RESULT_MS, () => beginRound(io, room, { tiebreaker: suddenDeathTriggered }), { deadline: false });
  } else {
    // everyone else already left mid-round — the sole remaining player wins by forfeit.
    const sole = [...g.activeIds][0] || null;
    setTimer(room, RESULT_MS, () => matchOver(io, room, sole, "forfeit"), { deadline: false });
  }
}

function handleAnswer(io, room, socket, text, ack) {
  const g = room.game;
  const pid = socket.data.playerId;
  if (!g || g.phase !== "live" || !g.activeIds.has(pid)) return ack?.({ ok: true, accepted: false });
  // Your own clock is what gates you — the others may still be racing long after yours is gone.
  if (g.doneIds.has(pid)) return ack?.({ ok: true, accepted: false, outOfTime: true });
  if ((g.deadlines[pid] ?? 0) < Date.now()) return ack?.({ ok: true, accepted: false, outOfTime: true });
  const entry = resolve(g.current, text);
  if (!entry) {
    // Not recognized — logged as a miss so it can be approved by someone else after the round
    // ends (e.g. a typo/alternate spelling the category's alias list doesn't cover), rather than
    // silently discarded. Deduped per player so repeated garbage doesn't clutter the review list.
    const q = norm(text);
    if (!q) return ack?.({ ok: true, accepted: false });
    const mine = g.misses[pid] || (g.misses[pid] = []);
    if (mine.some((m) => m.q === q)) return ack?.({ ok: true, accepted: false });
    if (mine.length < MAX_MISSES) mine.push({ id: ++g.missSeq, text: String(text).trim().slice(0, 60), q });
    return ack?.({ ok: true, accepted: false });
  }
  const mine = g.answers[pid] || (g.answers[pid] = new Map());
  if (mine.has(entry.id)) return ack?.({ ok: true, accepted: false, alreadyHad: true, display: entry.display });
  mine.set(entry.id, { display: entry.display, at: Date.now() });
  g.liveScores[pid] = (g.liveScores[pid] || 0) + 1;
  report(room, "answer", { category: g.current.name, grp: g.current.group, display: entry.display, offList: false, player: g.names[pid] });
  // Personal chess-clock bonus: extends only the answerer's own clock, never anyone else's, and
  // never past this round's ceiling. Hitting the ceiling is told to the answerer alone (in the
  // ack) rather than logged to the room — how fast someone is scoring isn't the room's business
  // until the reveal.
  let clockMaxed = false;
  if (g.increment) {
    clockMaxed = extendClock(g, pid);
    armRoundClock(io, room); // the next expiry (and the last one) may have moved
  }
  ack?.({ ok: true, accepted: true, display: entry.display, clockMaxed });
  emit(io, room); // score-only broadcast — the matched item's name never leaves the server here
}

// Vote to throw this round's category away and deal another. Unlike the duel — where a skip is
// only offered before anyone has answered — a race can skip during the countdown OR mid-round,
// because a bad category (a troll list, or one nobody knows) is often only obvious once you're
// staring at it. It needs EVERY active player, including anyone whose clock has already run out,
// so there's no way to use it to dodge a round you're losing.
function handleVoteSkip(io, room, socket) {
  const g = room.game;
  if (!g || (g.phase !== "countdown" && g.phase !== "live")) return;
  const pid = socket.data.playerId;
  if (!g.activeIds.has(pid)) return; // players only — not spectators, not anyone who left
  if (!g.skipVotes) g.skipVotes = new Set();
  if (g.skipVotes.has(pid)) return; // one vote each
  g.skipVotes.add(pid);

  if (g.skipVotes.size >= g.activeIds.size) {
    clearTimer(room);
    log(io, room, "system", null, `Everyone skipped ${g.current.name} · new category.`);
    report(room, "event", { type: "categorySkipped", detail: g.current.name });
    // The skipped round never happened: rewind the counter so the replacement keeps its number
    // and a best-of-N match isn't quietly shortened.
    g.round--;
    return beginRound(io, room, { tiebreaker: g.isTiebreaker });
  }
  log(io, room, "system", null, `${g.names[pid]} wants to skip this category (${g.skipVotes.size}/${g.activeIds.size}).`);
  emit(io, room);
}

// Vote to end an endless-format match early · needs every active player to agree.
function handleVoteEnd(io, room, socket) {
  const g = room.game;
  if (!g || g.winsNeeded != null || g.phase === "matchover") return; // endless only
  const pid = socket.data.playerId;
  if (!g.activeIds.has(pid)) return;
  if (!g.endVotes) g.endVotes = new Set();
  if (g.endVotes.has(pid)) return;
  g.endVotes.add(pid);
  if (g.endVotes.size >= g.activeIds.size) {
    let best = -1, winners = [];
    for (const id of g.activeIds) {
      const w = g.roundWins[id] || 0;
      if (w > best) { best = w; winners = [id]; } else if (w === best) winners.push(id);
    }
    clearTimer(room);
    if (winners.length === 1) return matchOver(io, room, winners[0], "vote-end");
    g.phase = "matchover"; g.deadline = null; g.matchWinnerId = null;
    log(io, room, "system", null, "Game ended by vote · it's a tie!");
    report(room, "end", { winnerId: null, reason: "vote-end" });
    return emit(io, room);
  }
  log(io, room, "system", null, `${g.names[pid]} wants to end the game (${g.endVotes.size}/${g.activeIds.size}).`);
  emit(io, room);
}

function matchOver(io, room, winnerId, reason) {
  clearTimer(room);
  const g = room.game;
  g.phase = "matchover"; g.deadline = null; g.matchWinnerId = winnerId || null;
  log(io, room, "system", null, winnerId ? `${g.names[winnerId]} wins the match!` : "Match over.");
  report(room, "end", { winnerId: winnerId || null, reason: reason || "win" });
  io.to(room.code).emit("raceMatchOver", {
    winnerId: winnerId || null,
    roundWins: g.order.map((id) => ({ id, name: g.names[id], wins: g.roundWins[id] || 0 })),
    reason: reason || "win",
  });
  emit(io, room);
}

// A player left mid-match. Unlike the 1v1 duel, a race with 3+ players keeps going for
// whoever's left — only dropping to a single remaining player ends it (by forfeit).
function playerLeftMatch(io, room, leaverId) {
  const g = room.game;
  if (!g || g.phase === "matchover") return;
  if (!g.activeIds.has(leaverId)) return;
  g.activeIds.delete(leaverId);
  if (!g.leftPlayers) g.leftPlayers = new Set();
  g.leftPlayers.add(leaverId);
  if (g.tiebreakerCandidates) g.tiebreakerCandidates.delete(leaverId);
  log(io, room, "system", null, `${g.names[leaverId] || "A player"} left the race.`);
  if (g.activeIds.size <= 1 && g.phase !== "roundover") {
    // mid-round with only one player left — end it now rather than waiting on the clock.
    clearTimer(room);
    return matchOver(io, room, [...g.activeIds][0] || null, "forfeit");
  }
  // They may have been the last clock the others were waiting on.
  if (g.phase === "live" && !g.paused) {
    if (allClocksDone(g)) return endLiveRound(io, room);
    armRoundClock(io, room);
  }
  emit(io, room);
}

// Host tweaked timer / categories mid-match. Format/sudden-death are locked once started.
function applyLiveSettings(io, room, { timer, groups, increment } = {}) {
  const g = room.game;
  if (!g) return;
  if (typeof timer === "number") g.timer = timer;
  if (typeof increment === "number") g.increment = Math.max(0, Math.min(30, increment));
  if (Array.isArray(groups) && groups.length) {
    const valid = groups.filter((k) => CATEGORY_GROUPS[k]);
    if (valid.length) { g.pool = buildPool({ groups: valid }); g.groups = valid; room.settings = { ...(room.settings || {}), groups: valid }; }
  }
  log(io, room, "system", null, "Host updated the game settings.");
  emit(io, room);
}

function setGroups(io, room, groups) {
  if (!room.game) return;
  const valid = (groups || []).filter((k) => CATEGORY_GROUPS[k]);
  if (!valid.length) return;
  room.game.pool = buildPool({ groups: valid });
  room.game.groups = valid;
  room.settings = { ...(room.settings || {}), groups: valid };
  log(io, room, "system", null, "Categories updated · applies next round.");
  emit(io, room);
}

function handleRematch(io, room, socket, ack) {
  if (room.hostId !== socket.data.playerId) return ack?.({ ok: false, error: "Only the host can restart." });
  if (room.players.size < 2) return ack?.({ ok: false, error: "Need at least 2 players." });
  ack?.({ ok: true });
  startMatch(io, room);
}

module.exports = {
  startMatch, beginRound, startLiveRound, endLiveRound, sweepClocks, finalizeRound,
  handleAnswer, handleApproveMiss, handleVoteEnd, handleVoteSkip, playerLeftMatch,
  pauseGame, resumeGame, applyLiveSettings, setGroups, setReporter, handleRematch,
  resync: (io, room) => { if (room.game) emit(io, room); },
};
