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

// ---------- Setup / lobby ----------
function buildSetup() {
  const checks = $("catChecks");
  checks.innerHTML = "";
  Object.entries(CATEGORY_GROUPS).forEach(([key, g]) => {
    const label = document.createElement("label");
    label.className = "check on";
    label.innerHTML = `<input type="checkbox" value="${key}" checked>
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
  usedNames = [];
  $("scoreMe").textContent = "0";
  $("scoreBot").textContent = "0";
  feed.innerHTML = "";
  input.disabled = false; sendBtn.disabled = false;
  $("endBtn").style.display = "inline-block";
  const goal = targetScore === Infinity ? "endless" : `first to ${targetScore}`;
  add(`Game on! Categories: ${enabledGroups.join(", ")}. Timer: ${timerLength}s · ${goal}.`, "system");
  add("Open with a number — then we trade raises. Either of us can call Prove It!; whoever made the last claim has to back it up. Careful, I bluff. 😏", "bot", "Bot");
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
  catNameEl.textContent = "—";
  $("catLabel").textContent = "Category";
  claimLineEl.textContent = "";
  $("overlay").style.display = "grid";
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

  // The bot secretly "knows" this many (5–12, capped to the list) — its bluff ceiling.
  botMax = Math.min(c.entries.length, 5 + Math.floor(Math.random() * 8));

  catNameEl.textContent = c.name;
  $("catLabel").textContent = `${c.emoji} ${c.group}`;
  claimLineEl.textContent = "";
  add(`New round — ${c.group}: ${c.name}`, "system");
  add(`How many ${c.name} can you name? You've got 10s to open with a number.`, "bot", "Bot");
  setActions([]);
  setTurn("me");
  input.placeholder = "Type a number to open…";
  input.focus();
  startTurnTimer();  // your reaction clock starts as soon as the question lands
}

// You open the bidding with a number → hand the turn to the bot.
function open(n) {
  if (state !== "opening") return;
  clearInterval(reactId);
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
  claimLineEl.textContent = `Standing claim: ${claim} — ${holder === "me" ? "You" : "Bot"}`;
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
    setTurn("bot");
    add("Too slow — no claim made. 😎", "bot", "Bot");
    endRound(false, "You didn't react in time —", { skipCount: true });
  } else if (state === "myturn") {
    add("(time's up — you call it)", "system");
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
  // The bot is challenge-happy: even when it could safely raise, it often
  // calls your bluff instead. Only a small chance to bluff past its own skill.
  let wantRaise;
  if (claim < botMax) {
    wantRaise = Math.random() < 0.45;            // 55% chance it makes YOU prove it
  } else {
    wantRaise = Math.random() < 0.15 && claim < botMax + 2;  // rare bluff beyond its skill
  }
  if (canRaise && wantRaise) {
    claim += 1;
    holder = "bot";
    add(`Make it ${claim}.`, "bot", "Bot");
    setClaimLine();
    myTurn();
  } else {
    add(`Prove it! 😏 Name ${claim} — clock's running.`, "bot", "Bot");
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
      endRound(false, `Bot named ${claim}/${claim}.`, { skipCount: true });
    } else {
      add("…uh, that's all I've got. 😬", "bot");
      endRound(true, `Bot only managed ${botMax}/${claim}.`, { skipCount: true });
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
    add(`${p} ✗ not on my list`, "bad", "You");
  } else if (proven.includes(entry.id)) {
    add(`"${p}" — already counted (${entry.display})`, "bad", "You");
  } else {
    proven.push(entry.id);
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
  setActions([]);
  setTurn(null);
  input.disabled = true; sendBtn.disabled = true;
  $("endBtn").style.display = "none";
  let title;
  if (scoreMe > scoreBot) title = "🏆 You win!";
  else if (scoreBot > scoreMe) title = "🤖 Bot wins!";
  else title = "🤝 It's a tie!";
  const goal = targetScore === Infinity ? "endless" : `first to ${targetScore}`;
  $("winTitle").textContent = title;
  $("winScore").textContent = `Final — You ${scoreMe} · Bot ${scoreBot} (${goal})`;
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
      rejectInput(raw, "Enter a whole number ≥ 1 to open.");
    } else if (n > max) {
      rejectInput(raw, current.exact
        ? `Easy 😅 — there are only ${max} ${current.name}. Try again.`
        : `That's a lot of ${current.name}! Try a smaller number.`);
    } else {
      open(n);
    }
  } else if (state === "myturn") {
    const n = parseInt(raw, 10);
    const max = current.entries.length;
    if (isNaN(n)) {
      rejectInput(raw, "Type a higher number to raise, or use the buttons.");
    } else if (n <= claim) {
      rejectInput(raw, `You have to raise above ${claim}.`);
    } else if (n > max) {
      rejectInput(raw, current.exact
        ? `Easy 😅 — there are only ${max} ${current.name}. Try again.`
        : `That's a lot of ${current.name}! Try a smaller number.`);
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
$("startBtn").onclick = startGame;
$("logo").onclick = returnToMenu;
$("againBtn").onclick = beginMatch;
$("lobbyBtn").onclick = () => { $("winOverlay").style.display = "none"; returnToMenu(); };
$("endBtn").onclick = endMatch;
