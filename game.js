/* ============================================================================
 * Prove It! — game logic
 * Loaded after categories.js (which defines CATEGORY_GROUPS) and after the DOM.
 *
 * Round flow (single-player vs. a folding bot):
 *   opening  → question shown; you have 10s to open with a number
 *   (timeout)→ no claim made = forfeit
 *   proving  → bot immediately calls "Prove it!"; back up your claim before the clock
 *   over     → point awarded; press Next round
 * ========================================================================== */

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const feed = $("feed"), input = $("input"), sendBtn = $("send"), actions = $("actions");
const timerEl = $("timer"), catNameEl = $("catName"), claimLineEl = $("claimLine");

// ---------- Game state ----------
let state = "idle";        // idle | opening | proving | over ("thinking" = brief transition)
let enabledGroups = [];    // selected group keys
let timerLength = 30;      // prove-phase length (seconds), chosen on the lobby
let targetScore = 5;       // first to this many points wins the match
let pool = [];             // built categories from the enabled groups
let current = null;        // current category { name, entries }
let claim = 0;             // the current standing claim ("I can name N")
let holder = null;         // "me" | "bot" — who made the standing claim
let botMax = 0;            // how many the bot can actually name this round (its secret skill)
let scoreMe = 0, scoreBot = 0;
let timerId = null, timeLeft = 0;      // prove-phase countdown
let reactId = null, reactLeft = 0;     // 10s timer for your turn (open / raise / call)
let proven = [];           // canonical entry ids correctly named this round
let lastCatName = null;    // last category, to avoid an immediate repeat after a reset
let usedNames = [];        // categories already played this match (no repeats until exhausted)
let difficulty = "medium"; // bot difficulty: easy | medium | hard

// Bot difficulty presets. botMax = how many it can actually name (its bluff ceiling);
// raiseUnder = chance it raises (vs makes you prove) when it's still within its skill;
// raiseBluff = chance it bluffs a raise past its skill; ceiling = how far past skill it'll bluff.
const DIFF = {
  easy:   { lo: 3, hi: 6,  raiseUnder: 0.30, raiseBluff: 0.05, ceiling: 1 },
  medium: { lo: 5, hi: 12, raiseUnder: 0.45, raiseBluff: 0.15, ceiling: 2 },
  hard:   { lo: 9, hi: 16, raiseUnder: 0.62, raiseBluff: 0.28, ceiling: 3 },
};

// ---------- sound effects (synthesized; shares the mute setting with multiplayer) ----------
let audioCtx = null;
let muted = localStorage.getItem("muted") === "1";
function actx() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
["click", "keydown", "touchstart"].forEach(ev => document.addEventListener(ev, () => actx(), { once: true }));
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
  roundWin:  () => [523, 659, 784].forEach((f, i) => tone(f, 0.18, { type: "triangle", gain: 0.16, delay: i * 0.08 })),
  roundLose: () => [392, 311].forEach((f, i) => tone(f, 0.24, { gain: 0.16, delay: i * 0.11 })),
  fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: "square", gain: 0.15, delay: i * 0.12 })),
  sparkle: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.14, { type: "triangle", gain: 0.14, delay: i * 0.06 })),
};
function setMuted(m) {
  muted = m; localStorage.setItem("muted", m ? "1" : "0");
  $("muteBtn").textContent = m ? "🔇" : "🔊";
  $("muteBtn").title = m ? "Sound off" : "Sound on";
}
// (Easter eggs are intentionally multiplayer-only — discover them there. 😏)

// Red glow + a shake on the answer box when it's your turn to open.
function openingCue(on) {
  input.classList.toggle("opening-cue", on);
  if (on) { input.classList.remove("shake"); void input.offsetWidth; input.classList.add("shake"); }
}

// ---------- single-player analytics (phones home to /track; silently no-ops if the server isn't recording) ----------
const spLoadedAt = Date.now();
let spPlayed = false, sessionSent = false, matchStart = 0, roundsPlayed = 0;
function track(type, data) {
  try { fetch("/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...data }), keepalive: true }).catch(() => {}); } catch {}
}
function sendSpSession() {
  if (sessionSent) return; sessionSent = true;
  const body = JSON.stringify({ type: "spSession", durationMs: Date.now() - spLoadedAt, played: spPlayed });
  try { navigator.sendBeacon("/track", new Blob([body], { type: "application/json" })); } catch { track("spSession", { durationMs: Date.now() - spLoadedAt, played: spPlayed }); }
}
addEventListener("pagehide", sendSpSession);

// ---------- Setup / lobby ----------
function buildSetup() {
  const checks = $("catChecks");
  checks.innerHTML = "";
  Object.entries(CATEGORY_GROUPS).forEach(([key, g]) => {
    const on = !g.defaultOff; // some groups (e.g. Secret) start unchecked
    const label = document.createElement("label");
    label.className = "check" + (on ? " on" : "");
    label.innerHTML = `<input type="checkbox" value="${key}" ${on ? "checked" : ""}>
      <span class="emoji">${g.emoji}</span><span>${key}</span>`;
    const cb = label.querySelector("input");
    cb.addEventListener("change", () => {
      label.classList.toggle("on", cb.checked);
      validateStart();
    });
    checks.appendChild(label);
  });

  const seg = $("timerSeg");
  seg.innerHTML = "";
  [15, 30, 45, 60].forEach(sec => {
    const b = document.createElement("button");
    b.textContent = sec + "s";
    if (sec === 30) b.classList.add("on");
    b.onclick = () => {
      [...seg.children].forEach(c => c.classList.remove("on"));
      b.classList.add("on");
      timerLength = sec;
    };
    seg.appendChild(b);
  });

  const win = $("winSeg");
  win.innerHTML = "";
  [3, 5, 10, Infinity].forEach(n => {
    const b = document.createElement("button");
    b.textContent = n === Infinity ? "∞" : n;
    if (n === targetScore) b.classList.add("on");
    b.onclick = () => {
      [...win.children].forEach(c => c.classList.remove("on"));
      b.classList.add("on");
      targetScore = n;
    };
    win.appendChild(b);
  });

  const diff = $("diffSeg");
  diff.innerHTML = "";
  [["easy", "😌 Easy"], ["medium", "🙂 Medium"], ["hard", "😤 Hard"]].forEach(([key, label]) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (key === difficulty) b.classList.add("on");
    b.onclick = () => {
      [...diff.children].forEach(c => c.classList.remove("on"));
      b.classList.add("on");
      difficulty = key;
    };
    diff.appendChild(b);
  });
}

function validateStart() {
  const any = [...document.querySelectorAll("#catChecks input:checked")].length > 0;
  $("startBtn").disabled = !any;
}

// Read the lobby selections, then kick off a fresh match.
function startGame() {
  enabledGroups = [...document.querySelectorAll("#catChecks input:checked")].map(c => c.value);
  pool = enabledGroups.flatMap(k =>
    CATEGORY_GROUPS[k].cats.map(c => buildCategory(c, k, CATEGORY_GROUPS[k].emoji)));
  beginMatch();
}

// Reset scores + feed and start playing (used by Start and Play Again).
function beginMatch() {
  $("overlay").style.display = "none";
  $("winOverlay").style.display = "none";
  scoreMe = 0; scoreBot = 0;
  spPlayed = true; matchStart = Date.now(); roundsPlayed = 0;
  usedNames = [];
  $("scoreMe").textContent = "0";
  $("scoreBot").textContent = "0";
  feed.innerHTML = "";
  input.disabled = false; sendBtn.disabled = false;
  $("endBtn").style.display = "inline-block";
  $("catBtn").style.display = "inline-block";
  const goal = targetScore === Infinity ? "endless" : `first to ${targetScore}`;
  add(`Game on! Categories: ${enabledGroups.join(", ")}. Timer: ${timerLength}s · ${goal}.`, "system");
  add("Throw out a number to start. We go back and forth raising till someone calls it, then you back it up. Fair warning, I bluff. 😏", "bot", "Bot");
  setTimeout(newRound, 500);
}

// Top-left logo → return to the lobby/setup screen.
function returnToMenu() {
  clearInterval(timerId);
  clearInterval(reactId);
  state = "idle";
  timerEl.textContent = "";
  timerEl.classList.remove("danger");
  setActions([]);
  setTurn(null);
  input.disabled = true; sendBtn.disabled = true; input.value = "";
  $("endBtn").style.display = "none";
  $("catBtn").style.display = "none";
  toggleCatMenu(false);
  catNameEl.textContent = "—";
  $("catLabel").textContent = "Category";
  claimLineEl.textContent = "";
  $("overlay").style.display = "grid";
}

// ---------- In-game category switcher (top-bar dropdown) ----------
function buildCatMenu() {
  const box = $("catMenuChecks");
  box.innerHTML = "";
  Object.entries(CATEGORY_GROUPS).forEach(([key, g]) => {
    const on = enabledGroups.includes(key);
    const label = document.createElement("label");
    label.className = "check" + (on ? " on" : "");
    label.innerHTML = `<input type="checkbox" value="${key}" ${on ? "checked" : ""}>
      <span class="emoji">${g.emoji}</span><span>${key}</span>`;
    const cb = label.querySelector("input");
    cb.addEventListener("change", () => {
      if (![...box.querySelectorAll("input:checked")].length) { cb.checked = true; return; }  // keep ≥1
      label.classList.toggle("on", cb.checked);
      applyCatMenu();
    });
    box.appendChild(label);
  });
}

// Rebuild the pool from the menu selection — takes effect from the next round.
function applyCatMenu() {
  enabledGroups = [...$("catMenuChecks").querySelectorAll("input:checked")].map(c => c.value);
  pool = enabledGroups.flatMap(k => CATEGORY_GROUPS[k].cats.map(c => buildCategory(c, k, CATEGORY_GROUPS[k].emoji)));
}

function toggleCatMenu(show) {
  const m = $("catMenu");
  const open = show === undefined ? m.style.display === "none" : show;
  if (open) { buildCatMenu(); m.style.display = "block"; }
  else { m.style.display = "none"; }
}

// ---------- Feed / UI helpers ----------
function add(text, cls, sender) {
  if (sender) {
    const s = document.createElement("div");
    s.className = "sender " + (["me", "ok", "bad"].includes(cls) ? "right" : "left");
    s.textContent = sender;
    feed.appendChild(s);
  }
  const m = document.createElement("div");
  m.className = "msg " + cls;
  m.textContent = text;
  feed.appendChild(m);
  scrollFeed();
}

// Pin the chat to the newest message (now + after layout settles).
function scrollFeed() {
  feed.scrollTop = feed.scrollHeight;
  requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

// Pick a random line (keeps the bot's chatter from sounding canned).
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function setActions(btns) {
  actions.innerHTML = "";
  btns.forEach(b => {
    const el = document.createElement("button");
    el.textContent = b.label;
    if (b.cls) el.className = b.cls;
    el.onclick = b.onClick;
    actions.appendChild(el);
  });
}

function setTurn(who) {
  $("pMe").classList.toggle("turn", who === "me");
  $("pBot").classList.toggle("turn", who === "bot");
}

// Lowercase, strip accents/diacritics (so "mbappe" matches "Mbappé"), and collapse spaces.
function norm(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Expand a raw category into canonical entries: { id, display, aliases:[normalized] }.
function buildCategory(cat, group, emoji) {
  return {
    name: cat.name,
    group,               // broad genre this category belongs to (e.g. "Geography")
    emoji,               // that genre's emoji
    exact: !!cat.exact,  // true = finite list (US States); we may disclose the count on over-claim
    entries: cat.items.map((item, id) => {
      const names = Array.isArray(item) ? item : [item];
      return { id, display: names[0], aliases: names.map(norm) };
    }),
  };
}

// Resolve a typed answer to its canonical entry (or null if it's not in the category).
function resolve(cat, value) {
  const q = norm(value);
  return cat.entries.find(e => e.aliases.includes(q)) || null;
}

// ---------- Round flow ----------
function newRound() {
  state = "opening";
  claim = 0;
  holder = null;
  proven = [];

  // Pick a category not yet used this match. If every one has been played,
  // reset the pool (but try not to immediately repeat the last category).
  let avail = pool.filter(c => !usedNames.includes(c.name));
  if (avail.length === 0) {
    usedNames = [];
    avail = pool.filter(c => c.name !== lastCatName);
    if (avail.length === 0) avail = pool;  // only one category available
  }
  const c = avail[Math.floor(Math.random() * avail.length)];
  usedNames.push(c.name);
  lastCatName = c.name;
  current = c;

  // The bot secretly "knows" this many (range set by difficulty, capped to the list) — its bluff ceiling.
  const d = DIFF[difficulty] || DIFF.medium;
  botMax = Math.min(c.entries.length, d.lo + Math.floor(Math.random() * (d.hi - d.lo + 1)));

  catNameEl.textContent = c.name;
  $("catLabel").textContent = `${c.emoji} ${c.group}`;
  claimLineEl.textContent = "";
  add(`New round · ${c.group}: ${c.name}`, "system");
  add(pick([
    `${c.name}. How many you got?`,
    `Alright, ${c.name}. How many can you name?`,
    `${c.name}. Give me a number.`,
  ]), "bot", "Bot");
  setActions([{ label: "🔁 Skip category", onClick: skipCategory }]);
  setTurn("me");
  input.placeholder = "Type a number to open…";
  input.focus();
  openingCue(true);  // unmissable "your turn to open" cue
  startTurnTimer();  // your reaction clock starts as soon as the question lands
}

// Don't like the category? Skip it (only before you open) → fresh category, no points.
function skipCategory() {
  if (state !== "opening") return;
  clearInterval(reactId);
  openingCue(false);
  track("spSkip", { category: current.name });
  add("Skipped — new category.", "system");
  newRound();
}

// You open the bidding with a number → hand the turn to the bot.
function open(n) {
  if (state !== "opening") return;
  clearInterval(reactId);
  openingCue(false);
  claim = n;
  holder = "me";
  add(`I can name ${n}.`, "me", "You");
  setClaimLine();
  botTurn();
}

// You raise the standing claim by one → hand the turn to the bot.
function raiseToNext() {
  if (state !== "myturn") return;
  clearInterval(reactId);
  claim += 1;
  holder = "me";
  add(`Make it ${claim}.`, "me", "You");
  setClaimLine();
  botTurn();
}

// You call "Prove it!" on the bot → the bot must back up its standing claim.
function humanChallengeBot() {
  if (state !== "myturn") return;
  clearInterval(reactId);
  setActions([]);
  timerEl.textContent = "";
  add("Prove it!", "me", "You");
  botProve();
}

function setClaimLine() {
  claimLineEl.textContent = `Standing claim: ${claim} (${holder === "me" ? "You" : "Bot"})`;
}

// ---------- 10s turn timer (drives your opening + your raise turns) ----------
function startTurnTimer() {
  reactLeft = 10;
  updateTurnTimer();
  clearInterval(reactId);
  reactId = setInterval(() => {
    reactLeft--;
    updateTurnTimer();
    if (reactLeft <= 0) onTurnTimeout();
  }, 1000);
}

function updateTurnTimer() {
  if (state !== "opening" && state !== "myturn") return;
  timerEl.textContent = `⏱ ${reactLeft}s to act`;
  timerEl.classList.toggle("danger", reactLeft <= 3);
}

function onTurnTimeout() {
  clearInterval(reactId);
  if (state === "opening") {
    state = "thinking";
    timerEl.textContent = "";
    openingCue(false);
    setTurn("bot");
    add("Too slow. 😎", "bot", "Bot");
    endRound(false, "Ran out of time.", { skipCount: true });
  } else if (state === "myturn") {
    add("(time's up, you call it)", "system");
    humanChallengeBot();  // stalling = you challenge the bot's claim
  }
}

// ---------- Bot's turn: raise the player back, or call their bluff ----------
function botTurn() {
  state = "botturn";
  setActions([]);
  setTurn("bot");
  timerEl.textContent = "";
  setTimeout(botDecide, 900 + Math.random() * 700);  // a beat of "thinking"
}

function botDecide() {
  if (state !== "botturn") return;  // match may have ended during the delay
  const size = current.entries.length;
  const canRaise = claim + 1 <= size;
  const d = DIFF[difficulty] || DIFF.medium;
  // The bot is challenge-happy: even when it could safely raise, it often
  // calls your bluff instead. Higher difficulty raises more and bluffs further.
  let wantRaise;
  if (claim < botMax) {
    wantRaise = Math.random() < d.raiseUnder;
  } else {
    wantRaise = Math.random() < d.raiseBluff && claim < botMax + d.ceiling;  // bluff beyond its skill
  }
  if (canRaise && wantRaise) {
    claim += 1;
    holder = "bot";
    add(pick([`${claim}.`, `Make it ${claim}.`, `Easy. ${claim}.`, `Pfft. ${claim}.`, `${claim}, then.`]), "bot", "Bot");
    setClaimLine();
    myTurn();
  } else {
    add(pick([
      `Prove it. Let's see all ${claim}. 😏`,
      `Yeah right, prove it.`,
      `Doubt it. Name ${claim}.`,
      `No chance you've got ${claim}. Go on.`,
      `Prove it then. ${claim}, let's hear em.`,
    ]), "bot", "Bot");
    startProving();  // you must back up your standing claim
  }
}

// ---------- Your turn: raise again or challenge the bot ----------
function myTurn() {
  state = "myturn";
  setTurn("me");
  const acts = [];
  if (claim + 1 <= current.entries.length) {
    acts.push({ label: `⬆️ Raise to ${claim + 1}`, cls: "raise", onClick: raiseToNext });
  }
  acts.push({ label: "🗣️ Prove It!", cls: "danger", onClick: humanChallengeBot });
  setActions(acts);
  input.placeholder = "Raise, type a higher number, or call Prove It!";
  input.focus();
  startTurnTimer();
}

// ---------- The bot backs up its claim, naming them one at a time (or chokes) ----------
function botProve() {
  state = "botproving";
  setTurn("bot");
  const success = claim <= botMax;
  const names = current.entries.slice(0, success ? claim : botMax).map(e => e.display);
  let i = 0;
  const tick = () => {
    if (state !== "botproving") return;  // match may have ended mid-recital
    if (i < names.length) {
      add(`${names[i]} ✓ (${i + 1}/${claim})`, "bot", i === 0 ? "Bot" : null);
      i++;
      setTimeout(tick, 550);
    } else if (success) {
      endRound(false, pick(["Told you.", "All day.", `That's ${claim}.`]), { skipCount: true });
    } else {
      add(pick(["uh… that's all I got. 😬", "wait, hold on… nope. 😬", "ok I might've oversold that."]), "bot");
      endRound(true, `Only got ${botMax} of ${claim}.`, { skipCount: true });
    }
  };
  setTimeout(tick, 700);
}

function startProving() {
  if (state === "gameover" || state === "over") return;  // guard against late calls
  state = "proving";
  proven = [];
  timeLeft = timerLength;
  setTurn("me");
  setActions([{ label: "🏳️ Give up", cls: "danger", onClick: giveUp }]);
  input.placeholder = `Name a ${current.name}…`;
  input.focus();
  updateTimer();
  timerId = setInterval(() => {
    timeLeft--;
    updateTimer();
    if (timeLeft > 0 && timeLeft <= 5) (timeLeft <= 3 ? sfx.tickHot : sfx.tick)();  // tense final seconds
    if (timeLeft <= 0) endRound(false, "Time's up!");
  }, 1000);
}

function updateTimer() {
  if (state === "proving") {
    timerEl.textContent = `⏱ ${timeLeft}s · ${proven.length}/${claim}`;
    timerEl.classList.toggle("danger", timeLeft <= 10);
  } else {
    timerEl.textContent = "";
    timerEl.classList.remove("danger");
  }
}

// One answer per submission — type each out individually and hit Enter.
function submitAnswer(p) {
  if (state !== "proving") return;
  const entry = resolve(current, p);
  if (!entry) {
    sfx.buzz();
    add(`${p} ✗ not on my list`, "bad", "You");
  } else if (proven.includes(entry.id)) {
    sfx.buzz();
    add(`already got ${entry.display}`, "bad", "You");
  } else {
    proven.push(entry.id);
    sfx.ding();
    add(`${entry.display} ✓ (${proven.length}/${claim})`, "ok", "You");
    if (proven.length >= claim) { endRound(true, "Nailed it!"); return; }
  }
  updateTimer();
}

function giveUp() { if (state === "proving") endRound(false, "You folded."); }

// Bounce a rejected entry: keep the typed value, flash a message, shake the box.
function rejectInput(raw, msg) {
  input.value = raw;
  add(msg, "system");
  input.classList.remove("shake");
  void input.offsetWidth;  // force reflow so the animation restarts every time
  input.classList.add("shake");
  input.focus();
}

function endRound(won, reason, opts = {}) {
  if (state === "over") return;
  clearInterval(timerId);
  clearInterval(reactId);
  state = "over";
  updateTimer();
  setTurn(null);
  (won ? sfx.roundWin : sfx.roundLose)();
  const count = opts.skipCount ? "" : ` ${proven.length}/${claim}.`;
  if (won) {
    scoreMe++;
    add(`${reason}${count} 🎉 Point for you!`, "bot", "Bot");
  } else {
    scoreBot++;
    add(`${reason}${count} Point for me. 😎`, "bot", "Bot");
  }
  $("scoreMe").textContent = scoreMe;
  $("scoreBot").textContent = scoreBot;
  claimLineEl.textContent = "";
  roundsPlayed++;
  track("spRound", { category: current.name, grp: current.group, difficulty, won, claim,
    proven: proven.length, answers: proven.map(id => (current.entries.find(e => e.id === id) || {}).display).filter(Boolean) });
  if (scoreMe >= targetScore || scoreBot >= targetScore) {
    setTimeout(showWin, 900);  // let the final-point message land first
    return;
  }
  setActions([{ label: "▶️ Next round (Enter)", onClick: newRound }]);
  input.placeholder = "Press Enter for the next round…";
  input.focus();  // so Enter advances to the next round
}

// End the current match early (e.g. endless mode) → resolve by score.
function endMatch() {
  clearInterval(timerId);
  clearInterval(reactId);
  showWin();
}

// Match over → show the win screen. Winner is whoever has more points (ties allowed).
function showWin() {
  state = "gameover";
  sfx.fanfare();
  const result = scoreMe > scoreBot ? "win" : scoreBot > scoreMe ? "loss" : "tie";
  track("spGame", { difficulty, scoreMe, scoreBot, result, rounds: roundsPlayed, durationMs: matchStart ? Date.now() - matchStart : null,
    groups: enabledGroups.join(","), timer: timerLength, target: targetScore === Infinity ? "endless" : String(targetScore) });
  setActions([]);
  setTurn(null);
  input.disabled = true; sendBtn.disabled = true;
  $("endBtn").style.display = "none";
  $("catBtn").style.display = "none";
  toggleCatMenu(false);
  let title;
  if (scoreMe > scoreBot) title = "🏆 You win!";
  else if (scoreBot > scoreMe) title = "🤖 Bot wins!";
  else title = "🤝 It's a tie!";
  $("winTitle").textContent = title;
  $("winScore").textContent = `Final score: You ${scoreMe}, Bot ${scoreBot}`;
  $("winOverlay").style.display = "grid";
}

// ---------- Input handling ----------
function handleInput() {
  if (state === "over") { newRound(); return; }  // Enter / Send advances to the next round
  const raw = input.value.trim();
  if (!raw) return;
  input.value = "";
  if (state === "opening") {
    const n = parseInt(raw, 10);
    const max = current.entries.length;
    if (isNaN(n) || n < 1) {
      rejectInput(raw, "Gotta be a number (1 or more).");
    } else if (n > max) {
      rejectInput(raw, current.exact
        ? `Easy 😅 there's only ${max} ${current.name}. Try again.`
        : `That's a lot of ${current.name}. Try a smaller number.`);
    } else {
      open(n);
    }
  } else if (state === "myturn") {
    const n = parseInt(raw, 10);
    const max = current.entries.length;
    if (isNaN(n)) {
      rejectInput(raw, "Type a higher number, or use the buttons.");
    } else if (n <= claim) {
      rejectInput(raw, `You gotta go higher than ${claim}.`);
    } else if (n > max) {
      rejectInput(raw, current.exact
        ? `Easy 😅 there's only ${max} ${current.name}. Try again.`
        : `That's a lot of ${current.name}. Try a smaller number.`);
    } else {
      clearInterval(reactId);
      claim = n; holder = "me";
      add(`Make it ${n}.`, "me", "You");
      setClaimLine();
      botTurn();
    }
  } else if (state === "proving") {
    submitAnswer(raw);
  } else {
    add("Use the buttons to continue.", "system");
  }
}

sendBtn.onclick = handleInput;
input.addEventListener("keydown", e => { if (e.key === "Enter") handleInput(); });
input.addEventListener("animationend", () => input.classList.remove("shake"));

// ---------- Boot ----------
buildSetup();
$("muteBtn").onclick = () => setMuted(!muted);
setMuted(muted);
$("startBtn").onclick = startGame;
$("logo").onclick = returnToMenu;
$("againBtn").onclick = beginMatch;
$("lobbyBtn").onclick = () => { $("winOverlay").style.display = "none"; returnToMenu(); };
$("endBtn").onclick = endMatch;
$("catBtn").onclick = (e) => { e.stopPropagation(); toggleCatMenu(); };
document.addEventListener("click", (e) => {
  const m = $("catMenu");
  if (m.style.display !== "none" && !m.contains(e.target) && e.target !== $("catBtn")) toggleCatMenu(false);
});
