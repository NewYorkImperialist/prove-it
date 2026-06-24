// Prove It! — async "beat my run" challenge mode (accountless, link-based).
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---- theme + favicon (match the rest of the app) ----
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

// ---- mobile viewport (keyboard shrinks the feed, doesn't shift content) ----
function setAppHeight() {
  const vv = window.visualViewport;
  const h = (vv && vv.height) || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", h + "px");
}
if (window.visualViewport) { window.visualViewport.addEventListener("resize", setAppHeight); window.visualViewport.addEventListener("scroll", setAppHeight); }
window.addEventListener("resize", setAppHeight); window.addEventListener("orientationchange", setAppHeight); setAppHeight();

// ---- category data (reuses CATEGORY_GROUPS from categories.js) ----
function norm(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " "); }
function buildCat(cat, group, emoji) {
  return { name: cat.name, group, emoji, entries: cat.items.map((it, id) => { const names = Array.isArray(it) ? it : [it]; return { id, display: names[0], aliases: names.map(norm) }; }) };
}
// (norm strips combining diacritics via NFD + the ̀-ͯ range above.)
const CATS = [];
for (const [g, v] of Object.entries(CATEGORY_GROUPS)) { if (v.defaultOff) continue; for (const c of v.cats) CATS.push(buildCat(c, g, v.emoji)); }
const findCat = (name) => CATS.find((c) => c.name === name) || null;
const randomCat = () => CATS[Math.floor(Math.random() * CATS.length)];

// ---- challenge params (?cat=&n=&by=&t=) ----
const params = new URLSearchParams(location.search);
const chCat = params.get("cat"), chN = parseInt(params.get("n"), 10), chBy = (params.get("by") || "").slice(0, 24), chT = parseInt(params.get("t"), 10);
const isChallenge = !!(chCat && Number.isFinite(chN));

// ---- state ----
let timer = 60, current = null, target = null, byName = "";
const named = new Set(); let count = 0, tid = null, timeLeft = 0;
let myName = (() => { try { return localStorage.getItem("ch_name") || ""; } catch (e) { return ""; } })();

function buildSelect() {
  const sel = $("catSel"); sel.innerHTML = "";
  const groups = {};
  CATS.forEach((c) => { (groups[c.group] = groups[c.group] || []).push(c); });
  Object.keys(groups).forEach((g) => {
    const og = document.createElement("optgroup"); og.label = g;
    groups[g].forEach((o) => { const opt = document.createElement("option"); opt.value = o.name; opt.textContent = `${o.emoji} ${o.name}`; og.appendChild(opt); });
    sel.appendChild(og);
  });
}
function buildTimeSeg(selected) {
  const seg = $("timeSeg"); seg.innerHTML = "";
  [30, 60, 90].forEach((s) => {
    const b = document.createElement("button"); b.textContent = s + "s"; if (s === selected) b.classList.add("on");
    b.onclick = () => { [...seg.children].forEach((c) => c.classList.remove("on")); b.classList.add("on"); timer = s; };
    seg.appendChild(b);
  });
}
function initIntro() {
  buildSelect();
  if (isChallenge) {
    timer = (chT === 30 || chT === 60 || chT === 90) ? chT : 60;
    target = chN; byName = chBy || "A friend";
    const c = findCat(chCat);
    $("challengerBox").hidden = false; $("challengerBox").className = "challenger";
    $("challengerBox").innerHTML = `💪 <b>${esc(byName)}</b> named <b>${chN}</b> ${esc(chCat)}${chT ? ` in ${chT}s` : ""}. Can you beat it?`;
    $("introTitle").textContent = "⚡ You've been challenged!";
    $("pickWrap").hidden = true;
    if (c) { current = c; $("introSub").textContent = `Name as many ${chCat} as you can before the clock runs out.`; $("startBtn").hidden = false; $("surpriseBtn").hidden = true; }
    else { current = null; $("introSub").textContent = `That category isn't available anymore — try a random one instead.`; $("startBtn").hidden = true; $("surpriseBtn").hidden = false; }
  } else {
    timer = 60; buildTimeSeg(60); $("startBtn").hidden = false;
  }
}

function startSprint(cat) {
  current = cat;
  named.clear(); count = 0;
  $("intro").hidden = true; $("result").hidden = true; $("sprint").hidden = false;
  $("sprintCat").textContent = cat.name; $("sprintGroup").textContent = `${cat.emoji} ${cat.group}`;
  $("count").textContent = "0"; $("chips").innerHTML = ""; $("cmsg").textContent = "";
  $("target").textContent = target != null ? `/ beat ${target}` : "";
  $("cinput").value = ""; $("cinput").disabled = false; $("cinput").focus();
  timeLeft = timer; $("timer").textContent = timeLeft; $("timer").classList.remove("low");
  clearInterval(tid);
  tid = setInterval(() => { timeLeft--; $("timer").textContent = Math.max(0, timeLeft); if (timeLeft <= 10) $("timer").classList.add("low"); if (timeLeft <= 0) endSprint(); }, 1000);
}
function submit(q) {
  const m = current.entries.find((e) => e.aliases.includes(norm(q)));
  if (!m) { flash("✗ not on the list"); return; }
  if (named.has(m.id)) { flash("already got that one"); return; }
  named.add(m.id); count++; $("count").textContent = count; $("cmsg").textContent = "";
  const sp = document.createElement("span"); sp.textContent = m.display; $("chips").prepend(sp);
}
function flash(msg) { $("cmsg").textContent = msg; const i = $("cinput"); i.classList.remove("shake"); void i.offsetWidth; i.classList.add("shake"); }
function endSprint() {
  clearInterval(tid); $("cinput").disabled = true;
  $("sprint").hidden = true; $("result").hidden = false;
  $("finalCount").textContent = count;
  if (target != null) {
    if (count > target) { $("verdict").innerHTML = `🏆 You beat ${esc(byName)}!`; $("verdict").className = "verdict win"; }
    else if (count === target) { $("verdict").innerHTML = `🤝 Dead tie with ${esc(byName)} — ${count} each!`; $("verdict").className = "verdict"; }
    else { $("verdict").innerHTML = `😤 ${esc(byName)} got ${target}. So close!`; $("verdict").className = "verdict lose"; }
    $("resultSub").textContent = `You named ${count} ${current.name} in ${timer}s. Now send YOUR score and keep the chain going.`;
  } else {
    $("verdict").innerHTML = `Nice run!`; $("verdict").className = "verdict win";
    $("resultSub").textContent = `You named ${count} ${current.name} in ${timer}s. Challenge a friend to beat it.`;
  }
  $("nameInput").value = myName;
  track();
}

function shareLink() {
  myName = $("nameInput").value.trim().slice(0, 20) || "A friend";
  try { localStorage.setItem("ch_name", myName); } catch (e) {}
  const url = `${location.origin}/challenge.html?cat=${encodeURIComponent(current.name)}&n=${count}&by=${encodeURIComponent(myName)}&t=${timer}`;
  const text = `I named ${count} ${current.name} on Prove It! Can you beat me?`;
  if (navigator.share) { navigator.share({ title: "Prove It! Challenge", text, url }).catch(() => {}); }
  else if (navigator.clipboard) { navigator.clipboard.writeText(`${text} ${url}`).then(() => { $("shareBtn").textContent = "✅ Link copied — paste it to a friend!"; }).catch(() => prompt("Copy this challenge link:", `${text} ${url}`)); }
  else { prompt("Copy this challenge link:", `${text} ${url}`); }
}

function track() {
  try { fetch("/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "challenge", category: current.name, grp: current.group, score: count, target: target, received: isChallenge, timer }), keepalive: true }).catch(() => {}); } catch (e) {}
}

$("cinput").addEventListener("keydown", (e) => { if (e.key !== "Enter") return; const q = $("cinput").value.trim(); $("cinput").value = ""; if (q) submit(q); });
$("startBtn").onclick = () => startSprint(current || findCat($("catSel").value) || randomCat());
$("surpriseBtn").onclick = () => startSprint(randomCat());
$("againBtn").onclick = () => startSprint(current);
$("newCatBtn").onclick = () => {
  target = null; byName = ""; current = null;
  $("challengerBox").hidden = true; $("introTitle").textContent = "⚡ Friend Challenge";
  $("introSub").textContent = "Pick a category and name as many as you can before the clock runs out.";
  $("pickWrap").hidden = false; $("surpriseBtn").hidden = true; $("startBtn").hidden = false;
  $("result").hidden = true; $("intro").hidden = false; buildTimeSeg(timer);
};
$("shareBtn").onclick = shareLink;

initIntro();
