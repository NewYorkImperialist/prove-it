// Prove It! — async multi-round challenges with a shared per-challenge leaderboard.
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
let perRound = 45; // seconds per round — chosen by the host, then locked so every run is comparable

// ---- theme + favicon ----
function setFavicon(t) {
  const rect = t === "cyan" ? "5cd6e0" : "f5a623", fg = t === "cyan" ? "04232a" : "241500";
  const l = $("favicon"); if (l) l.href = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='8' y='8' width='84' height='84' rx='20' fill='%23${rect}'/><text x='50' y='50' font-size='64' text-anchor='middle' dominant-baseline='central' fill='%23${fg}'>◎</text></svg>`;
}
function setTheme(t) {
  document.body.classList.toggle("t-cyan", t === "cyan");
  try { localStorage.setItem("theme", t); } catch (e) {}
  document.querySelectorAll("[data-theme]").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
  setFavicon(t);
}
document.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.theme)));
setTheme((() => { try { return localStorage.getItem("theme") || "amber"; } catch (e) { return "amber"; } })());

// ---- mobile viewport ----
function setAppHeight() { const vv = window.visualViewport; document.documentElement.style.setProperty("--app-height", ((vv && vv.height) || window.innerHeight) + "px"); }
if (window.visualViewport) { window.visualViewport.addEventListener("resize", setAppHeight); window.visualViewport.addEventListener("scroll", setAppHeight); }
window.addEventListener("resize", setAppHeight); window.addEventListener("orientationchange", setAppHeight); setAppHeight();

// ---- category data ----
function norm(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " "); }
function buildCat(cat, group, emoji) { return { name: cat.name, group, emoji, entries: cat.items.map((it, id) => { const n = Array.isArray(it) ? it : [it]; return { id, display: n[0], aliases: n.map(norm) }; }) }; }
const CATS = []; const GENRES = [];
for (const [g, v] of Object.entries(CATEGORY_GROUPS)) { if (v.defaultOff) continue; GENRES.push(g); for (const c of v.cats) CATS.push(buildCat(c, g, v.emoji)); }
const findCat = (name) => CATS.find((c) => c.name === name) || null;
// Troll / too-small categories make bad sprints → flagged "non-sprint" (excluded from genre mode, allowed in custom).
const TROLL = new Set(["Things the Nyan Cat Says", "Counting Numbers", "Nobel Peace Prize Loser", "People in the Epstein Files", "Italian Brainrot", "Cities Mistaken for Australia's Capital", "Seasons of the Year", "Months of the Year"]);
const nonSprint = (cat) => TROLL.has(cat.name) || cat.entries.length < 12;
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---- identity ----
const VISITOR_ID = (() => { try { let v = localStorage.getItem("pi_visitor"); if (!v) { v = "v-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); localStorage.setItem("pi_visitor", v); } return v; } catch (e) { return null; } })();
let myName = (() => { try { return localStorage.getItem("ch_name") || ""; } catch (e) { return ""; } })();
function rememberName(n) { myName = n; try { localStorage.setItem("ch_name", n); } catch (e) {} }

// ---- net helpers ----
async function postJSON(url, body) { try { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return await r.json(); } catch (e) { return { ok: false }; } }
async function getJSON(url) { try { return await (await fetch(url)).json(); } catch (e) { return { ok: false }; } }

// ---- state ----
const params = new URLSearchParams(location.search);
let challengeId = params.get("id");
let def = null;            // { id, rounds:[names], by, type, genre }
let roundCats = [], roundScores = [], cur = 0;
let mode = "genre", numRounds = 5;
let named = new Set(), count = 0, tid = null, timeLeft = 0;
let rChars = 0, rT0 = 0, roundWpm = []; // live typing-speed tracking (chars since first keystroke)
function liveWpm() { return rT0 ? Math.round((rChars / 5) / Math.max(1 / 60, (Date.now() - rT0) / 60000)) : 0; }
function showWpm() { $("wpm").textContent = rT0 ? liveWpm() + " wpm" : ""; }

function show(sec) { ["create", "join", "sprint", "between", "done"].forEach((s) => { $(s).hidden = s !== sec; }); }

// ============ CREATE ============
function buildGenreSelect() { const sel = $("genreSel"); sel.innerHTML = ""; GENRES.forEach((g) => { const o = document.createElement("option"); o.value = g; const em = (CATS.find((c) => c.group === g) || {}).emoji || ""; o.textContent = `${em} ${g}`; sel.appendChild(o); }); }
function catOptions(selectedName) {
  const groups = {}; CATS.forEach((c) => { (groups[c.group] = groups[c.group] || []).push(c); });
  const sel = document.createElement("select");
  Object.keys(groups).forEach((g) => { const og = document.createElement("optgroup"); og.label = g; groups[g].forEach((c) => { const o = document.createElement("option"); o.value = c.name; o.textContent = `${c.name}${nonSprint(c) ? " — non-sprint" : ""}`; if (c.name === selectedName) o.selected = true; og.appendChild(o); }); sel.appendChild(og); });
  return sel;
}
function buildCustomRounds() {
  const wrap = $("customRounds"); wrap.innerHTML = "";
  const sprintable = shuffle(CATS.filter((c) => !nonSprint(c)));
  for (let i = 0; i < numRounds; i++) {
    const row = document.createElement("div"); row.className = "crow";
    const num = document.createElement("div"); num.className = "num"; num.textContent = `Question ${i + 1}`;
    const sel = catOptions((sprintable[i] || CATS[0]).name); sel.dataset.round = i;
    row.appendChild(num); row.appendChild(sel); wrap.appendChild(row);
  }
}
function buildRoundsSeg() {
  const seg = $("roundsSeg"); seg.innerHTML = "";
  [1, 3, 5, 10].forEach((n) => { const b = document.createElement("button"); b.textContent = n; if (n === numRounds) b.classList.add("on"); b.onclick = () => { numRounds = n; [...seg.children].forEach((c) => c.classList.remove("on")); b.classList.add("on"); if (mode === "custom") buildCustomRounds(); }; seg.appendChild(b); });
}
function buildTimeSeg() {
  const seg = $("timeSeg"); seg.innerHTML = "";
  [20, 30, 45, 60, 90].forEach((s) => { const b = document.createElement("button"); b.textContent = s + "s"; if (s === perRound) b.classList.add("on"); b.onclick = () => { perRound = s; [...seg.children].forEach((c) => c.classList.remove("on")); b.classList.add("on"); }; seg.appendChild(b); });
}
function setMode(m) {
  mode = m;
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("genreWrap").hidden = m !== "genre"; $("customWrap").hidden = m !== "custom";
  if (m === "custom") buildCustomRounds();
}
function pickGenreRounds(genre, n) {
  let pool = shuffle(CATS.filter((c) => c.group === genre && !nonSprint(c)));
  if (!pool.length) pool = shuffle(CATS.filter((c) => c.group === genre));
  const out = [];
  while (out.length < n && pool.length) { out.push(...pool); }       // repeat-fill if the genre is small
  return out.slice(0, n).map((c) => c.name);
}
async function createChallenge() {
  $("createErr").textContent = "";
  const by = $("byName").value.trim().slice(0, 20) || "A friend"; rememberName(by);
  let rounds;
  if (mode === "genre") rounds = pickGenreRounds($("genreSel").value, numRounds);
  else rounds = [...$("customRounds").querySelectorAll("select")].map((s) => s.value);
  rounds = rounds.filter(Boolean);
  if (!rounds.length) { $("createErr").textContent = "Pick at least one category."; return; }
  $("createBtn").disabled = true; $("createBtn").textContent = "Creating…";
  const res = await postJSON("/challenge", { type: mode, genre: mode === "genre" ? $("genreSel").value : "", rounds, by, timer: perRound });
  $("createBtn").disabled = false; $("createBtn").textContent = "Create & play";
  if (!res.ok) { $("createErr").textContent = res.error || "Could not create challenge."; return; }
  challengeId = res.id; def = { id: res.id, rounds, by, type: mode };
  history.replaceState({}, "", `challenge.html?id=${challengeId}`);
  startPlaying(by);
}

// ============ PLAY ============
function startPlaying(playerName) {
  rememberName(playerName);
  roundCats = def.rounds.map(findCat).filter(Boolean);
  if (!roundCats.length) { show("create"); $("createErr").textContent = "This challenge's categories are unavailable."; return; }
  roundScores = []; cur = 0;
  startRound(0);
}
function startRound(i) {
  cur = i; named = new Set(); count = 0; rChars = 0; rT0 = 0;
  show("sprint"); $("wpm").textContent = "";
  const cat = roundCats[i];
  const pips = $("roundpips"); pips.innerHTML = "";
  roundCats.forEach((_, j) => { const s = document.createElement("span"); s.className = j < i ? "done" : j === i ? "cur" : ""; pips.appendChild(s); });
  $("sprintGroup").textContent = `Round ${i + 1} of ${roundCats.length} · ${cat.emoji} ${cat.group}`;
  $("sprintCat").textContent = cat.name;
  $("count").textContent = "0"; $("chips").innerHTML = ""; $("cmsg").textContent = "";
  $("cinput").value = ""; $("cinput").disabled = false; $("cinput").focus();
  timeLeft = perRound; $("timer").textContent = timeLeft; $("timer").classList.remove("low");
  clearInterval(tid);
  tid = setInterval(() => { timeLeft--; $("timer").textContent = Math.max(0, timeLeft); showWpm(); if (timeLeft <= 10) $("timer").classList.add("low"); if (timeLeft <= 0) endRound(); }, 1000);
}
function submit(q) {
  rChars += q.length; if (!rT0) rT0 = Date.now(); showWpm(); // typing-speed accounting (all submissions count)
  const cat = roundCats[cur];
  const m = cat.entries.find((e) => e.aliases.includes(norm(q)));
  if (!m) { flash("✗ not on the list"); return; }
  if (named.has(m.id)) { flash("already got that one"); return; }
  named.add(m.id); count++; $("count").textContent = count; $("cmsg").textContent = "";
  const sp = document.createElement("span"); sp.textContent = m.display; $("chips").prepend(sp);
}
function flash(msg) { $("cmsg").textContent = msg; const i = $("cinput"); i.classList.remove("shake"); void i.offsetWidth; i.classList.add("shake"); }
function endRound() {
  clearInterval(tid); $("cinput").disabled = true;
  roundScores[cur] = count; roundWpm[cur] = liveWpm();
  const last = cur + 1 >= roundCats.length;
  show("between");
  $("betweenLabel").textContent = `Round ${cur + 1} of ${roundCats.length} done`;
  $("betweenCount").textContent = count;
  $("betweenCat").textContent = `${roundCats[cur].name} — ${roundWpm[cur]} wpm · running total ${roundScores.reduce((a, n) => a + n, 0)}`;
  $("nextBtn").textContent = last ? "See results & leaderboard →" : "Next round →";
}
$("nextBtn").onclick = () => { if (cur + 1 >= roundCats.length) finish(); else startRound(cur + 1); };

// ============ FINISH + LEADERBOARD ============
async function finish() {
  const total = roundScores.reduce((a, n) => a + n, 0);
  const avgWpm = roundWpm.length ? Math.round(roundWpm.reduce((a, n) => a + n, 0) / roundWpm.length) : 0;
  show("done");
  $("shareUrl").value = challengeUrl();
  $("doneVerdict").innerHTML = "Your run is in!"; $("doneVerdict").className = "verdict win";
  $("doneTotal").parentElement.hidden = false;
  $("doneTotal").textContent = total;
  $("doneSub").textContent = `You named ${total} across ${roundCats.length} rounds at ${avgWpm} wpm avg. Send the link to friends — same questions, same leaderboard.`;
  await postJSON(`/challenge/${challengeId}/result`, { name: myName, scores: roundScores, wpms: roundWpm, visitorId: VISITOR_ID });
  renderLeaderboard($("lbWrap"));
}
async function renderLeaderboard(el) {
  el.innerHTML = `<p class="lb-note">Loading leaderboard…</p>`;
  const data = await getJSON(`/challenge/${challengeId}/results`);
  if (!data.ok) { el.innerHTML = `<p class="lb-note">Couldn't load the leaderboard.</p>`; return; }
  const rounds = data.rounds || [];
  // best run per visitor (fallback: per name)
  const best = new Map();
  (data.results || []).forEach((r) => { const key = r.visitor_id || ("name:" + r.name); const prev = best.get(key); if (!prev || r.total > prev.total) best.set(key, r); });
  const players = [...best.values()].sort((a, b) => b.total - a.total);
  if (!players.length) { el.innerHTML = `<p class="lb-note">No one has played yet — be the first!</p>`; return; }
  const colMax = rounds.map((_, i) => Math.max(...players.map((p) => p.scores[i] || 0)));
  const head = `<tr><th>#</th><th>Player</th>${rounds.map((_, i) => `<th title="${esc(rounds[i])}">R${i + 1}</th>`).join("")}<th>Total</th></tr>`;
  const body = players.map((p, idx) => {
    const mine = p.visitor_id && p.visitor_id === VISITOR_ID;
    const cells = rounds.map((_, i) => { const v = p.scores[i] || 0; return `<td class="${v === colMax[i] && v > 0 ? "hi" : ""}">${v}</td>`; }).join("");
    return `<tr class="${mine ? "me" : ""}"><td>${idx + 1}</td><td>${esc(p.name)}${mine ? " (you)" : ""}</td>${cells}<td class="tot">${p.total}</td></tr>`;
  }).join("");
  // typing speed (WPM): per-round + average
  const wpmOf = (p) => Array.isArray(p.wpms) ? p.wpms : [];
  const avgWpm = (p) => { const w = wpmOf(p).filter((n) => n > 0); return w.length ? Math.round(w.reduce((a, n) => a + n, 0) / w.length) : 0; };
  const wpmMax = rounds.map((_, i) => Math.max(0, ...players.map((p) => wpmOf(p)[i] || 0)));
  const anyWpm = players.some((p) => wpmOf(p).some((n) => n > 0));
  const wpmHead = `<tr><th>Player</th>${rounds.map((_, i) => `<th title="${esc(rounds[i])}">R${i + 1}</th>`).join("")}<th>Avg</th></tr>`;
  const wpmBody = players.map((p) => {
    const mine = p.visitor_id && p.visitor_id === VISITOR_ID;
    const cells = rounds.map((_, i) => { const v = wpmOf(p)[i] || 0; return `<td class="${v === wpmMax[i] && v > 0 ? "hi" : ""}">${v || "—"}</td>`; }).join("");
    return `<tr class="${mine ? "me" : ""}"><td>${esc(p.name)}${mine ? " (you)" : ""}</td>${cells}<td class="tot">${avgWpm(p)}</td></tr>`;
  }).join("");
  const legend = rounds.map((r, i) => `R${i + 1} ${esc(r)}`).join(" · ");
  const qWinners = rounds.map((r, i) => { const w = players.find((p) => (p.scores[i] || 0) === colMax[i] && colMax[i] > 0); return w ? `<b>R${i + 1}</b> ${esc(w.name)} (${colMax[i]})` : null; }).filter(Boolean).join(" · ");
  el.innerHTML = `<table class="lb">${head}${body}</table>
    <p class="lb-note"><b>${esc(players[0].name)}</b> leads with ${players[0].total} · ${players.length} player${players.length > 1 ? "s" : ""}.</p>
    <p class="lb-note">Question winners: ${qWinners || "—"}</p>
    ${anyWpm ? `<p class="lb-note" style="margin-top:14px;color:var(--text)"><b>Typing speed (WPM)</b></p><table class="lb">${wpmHead}${wpmBody}</table>` : ""}
    <p class="lb-note" style="opacity:.7;margin-top:12px">${legend}</p>`;
}

// ============ JOIN (opened a ?id= link) ============
async function initJoin() {
  show("join");
  $("joinInfo").innerHTML = "Loading challenge…";
  def = null;
  const c = await getJSON(`/challenge/${challengeId}`);
  if (!c.ok) { show("create"); $("createErr").textContent = "That challenge link is invalid or expired — build a new one."; initCreate(); return; }
  def = { id: c.id, rounds: c.rounds || [], by: c.by, type: c.type, genre: c.genre, timer: c.timer || 45 };
  perRound = def.timer;
  $("joinInfo").innerHTML = `<b>${esc(def.by || "A friend")}</b> challenges you — <b>${def.rounds.length}</b> rounds${def.genre ? ` of <b>${esc(def.genre)}</b>` : ""}, <b>${def.timer}s</b> each. Beat the leaderboard!`;
  $("joinRounds").innerHTML = def.rounds.map((n, i) => { const cat = findCat(n); const ns = cat && nonSprint(cat); return `<li><span>R${i + 1} · ${esc(n)}</span>${ns ? `<span class="badge-ns">non-sprint</span>` : ""}</li>`; }).join("");
  $("joinName").value = myName;
}
$("joinStart").onclick = () => { const n = $("joinName").value.trim().slice(0, 20) || "Anon"; startPlaying(n); };
$("joinLB").onclick = async () => {
  let box = $("joinLBWrap");
  if (!box) { box = document.createElement("div"); box.id = "joinLBWrap"; box.style.marginTop = "16px"; $("join").appendChild(box); }
  renderLeaderboard(box);
};

function initCreate() {
  show("create");
  buildRoundsSeg(); buildTimeSeg(); buildGenreSelect(); setMode("genre");
  $("byName").value = myName;
}

// ---- wire ----
$("cinput").addEventListener("keydown", (e) => { if (e.key !== "Enter") return; const q = $("cinput").value.trim(); $("cinput").value = ""; if (q) submit(q); });
document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("createBtn").onclick = createChallenge;
function challengeUrl() { return `${location.origin}/challenge.html?id=${challengeId}`; }
$("shareBtn").onclick = () => {
  const url = challengeUrl();
  $("shareUrl").value = url; $("shareUrl").focus(); $("shareUrl").select();
  const ok = () => { $("shareBtn").textContent = "Copied! Paste it to a friend"; setTimeout(() => { $("shareBtn").textContent = "Copy challenge link"; }, 2500); };
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok).catch(() => { try { document.execCommand("copy"); ok(); } catch (e) {} });
  else { try { document.execCommand("copy"); ok(); } catch (e) {} }
};
$("refreshLB").onclick = () => renderLeaderboard($("lbWrap"));
$("newChallenge").onclick = () => { location.href = "challenge.html"; };

// top-of-page → back to the beginning (fresh build screen)
function backToStart() { location.href = "challenge.html"; }
$("chHome").onclick = backToStart;
$("chNew").onclick = backToStart;

// ---- boot ----
if (challengeId) initJoin(); else initCreate();
