// Prove It! — server (Phase 4: rooms + reconnection)
// Serves the static game files AND runs the Socket.IO realtime layer on one port.
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const engine = require("./game-engine");
const analytics = require("./stats"); // persistent game history (Turso); separate from the in-memory `stats` counters
const CATEGORY_GROUPS = require("./categories.js");
const ALL_GROUPS = Object.keys(CATEGORY_GROUPS);
const DEFAULT_GROUPS = ALL_GROUPS.filter((k) => !CATEGORY_GROUPS[k].defaultOff); // Secret starts off
const CAT_SIZES = {}; // category name -> # of answers (for "coverage" / least-explored report)
const CAT_ITEMS = {}; // category name -> [canonical display names] (for the never-named report)
const CAT_GROUP = {}; // category name -> its group
for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) for (const c of grp.cats) {
  CAT_SIZES[c.name] = c.items.length;
  CAT_ITEMS[c.name] = c.items.map((it) => (Array.isArray(it) ? it[0] : it));
  CAT_GROUP[c.name] = gname;
}
// Hour of day (0–23) in US Eastern, DST-aware; falls back to UTC if ICU/tz data is missing.
function easternHour(ts) {
  try { return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(ts))) % 24; }
  catch { return new Date(ts).getUTCHours(); }
}
function easternTime(ts) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ts)); }
  catch { return new Date(ts).toISOString().slice(0, 16).replace("T", " "); }
}
function easternFull(ts) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium" }).format(new Date(ts)) + " ET"; }
  catch { return new Date(ts).toISOString(); }
}
function easternDay(ts) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts)); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
}
const fmtHour12 = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const TIMERS = [15, 30, 45, 60];
const TARGETS = [3, 5, 10]; // plus null = endless

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: "16kb" })); // for the single-player /track beacon

// Persist game/round events for the admin board (fire-and-forget; no-ops if Turso isn't set).
engine.setReporter((room, type, extra) => {
  try {
    const gid = room.game?.gid || null;
    if (type === "round") {
      analytics.recordRound({ code: room.code, category: extra.category, grp: extra.grp,
        winner_id: extra.winnerId, winner_name: extra.winnerName, claim: extra.claim, proven: extra.proven, at: Date.now(), gid });
    } else if (type === "answer") {
      analytics.recordAnswer({ code: room.code, category: extra.category, grp: extra.grp, display: extra.display, offList: extra.offList, at: Date.now(), gid, player: extra.player });
    } else if (type === "event") {
      analytics.recordEvent(extra.type, room.code, extra.detail, "mp", gid);
    } else if (type === "end") {
      const g = room.game; if (!g) return;
      const [a, b] = g.order;
      analytics.recordGame({ code: room.code,
        p1_id: a, p1_name: g.names[a], p1_score: g.scores[a] || 0,
        p2_id: b, p2_name: g.names[b], p2_score: g.scores[b] || 0,
        winner_id: extra.winnerId || null, winner_name: extra.winnerId ? g.names[extra.winnerId] : null,
        groups: (g.groups || []).join(","), timer: g.timer, target: g.target === Infinity ? "endless" : String(g.target),
        rounds: g.round, reason: extra.reason || "win",
        started_at: g.startedAt || null, ended_at: Date.now(), duration_ms: g.startedAt ? Date.now() - g.startedAt : null, gid: g.gid || null });
    }
  } catch (e) { console.error("reporter:", e.message); }
});

// Single-page app: multiplayer + solo share one document (index.html).
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ---------- owner-only live dashboard (gated by the OWNER_KEY secret) ----------
// Reads server state directly — an INVISIBLE peek (doesn't join as a spectator).
//   /admin?key=YOUR_KEY        → live HTML dashboard (auto-refreshes)
//   /admin?key=YOUR_KEY&json=1 → raw JSON
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function gamePeek(room) {
  const g = room.game;
  if (!g) return null;
  const nameOf = (id) => g.names[id] || "?";
  const proven = (g.proven || []).map((id) => { const e = (g.current.entries || []).find((x) => x.id === id); return e ? e.display : "?"; });
  return {
    phase: g.phase, round: g.round,
    category: g.current ? `${g.current.group} — ${g.current.name}` : "?",
    claim: g.claim, target: g.target === Infinity ? "∞" : g.target,
    turn: nameOf(g.turnId),
    scores: g.order.map((id) => `${nameOf(id)}: ${g.scores[id] || 0}`).join("   ·   "),
    proven, granted: g.granted || [], pending: g.pending ? [...g.pending.values()].map((p) => p.text) : [],
    paused: !!g.paused, intermission: !!g.intermission,
  };
}
// Everyone currently connected (live, from socket state — not the DB).
function liveSessions() {
  const out = [];
  for (const s of io.sockets.sockets.values()) {
    const ss = s.data.session; if (!ss) continue;
    out.push({ connectedAt: ss.connectedAt, device: ss.device, name: ss.name,
      room: s.data.roomCode || null, role: s.data.spectator ? "spectator" : (s.data.roomCode ? "player" : "browsing") });
  }
  return out.sort((a, b) => a.connectedAt - b.connectedAt);
}
function adminData() {
  return [...rooms.values()].map((room) => ({
    code: room.code,
    status: room.game ? "playing" : "waiting",
    createdAt: room.createdAt || null, lastActivityAt: room.lastActivityAt || null,
    players: [...room.players.values()].map((p) => ({ name: p.name, connected: p.connected, host: p.id === room.hostId })),
    spectators: room.spectators ? room.spectators.size : 0,
    game: gamePeek(room),
  }));
}
function fmtDur(ms) {
  if (ms == null) return "?";
  const s = Math.floor(ms / 1000); if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60); return h + "h " + (m % 60) + "m";
}
function ownerOk(req) { const key = req.query.key || req.get("x-owner-key"); return process.env.OWNER_KEY && key === process.env.OWNER_KEY; }

function fmtMs(ms) { return ms ? fmtDur(ms) : "—"; }

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
function bar(n, max) { const w = max ? Math.round((n / max) * 100) : 0; return `<span style="display:inline-block;height:9px;width:${w}%;min-width:${n ? 3 : 0}px;background:#5b8cff;border-radius:2px;vertical-align:middle"></span>`; }
const tbl = (head, rows, cols) => `<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows || `<tr><td colspan=${cols}>—</td></tr>`}</table>`;
function histHtml(h, k) {
  if (!h) return `<p class="stats" style="margin-top:22px">📦 Historical stats off — set <b>TURSO_URL</b> / <b>TURSO_TOKEN</b> to persist game history.</p>`;
  const num = (x) => Number(x || 0);
  const cat = h.categories.map((r) => `<tr><td>${esc(r.grp)} — ${esc(r.category)}</td><td>${num(r.plays)}</td><td>${r.avg_claim ? num(r.avg_claim).toFixed(1) : "—"}</td><td>${r.avg_ratio != null ? Math.round(num(r.avg_ratio) * 100) + "%" : "—"}</td></tr>`).join("");
  const cov = h.namedPerCat.map((r) => ({ cat: r.category, c: num(r.c), total: CAT_SIZES[r.category] || 0 })).filter((x) => x.total)
    .map((x) => ({ ...x, pct: x.c / x.total })).sort((a, b) => a.pct - b.pct).slice(0, 15)
    .map((x) => `<tr><td>${esc(x.cat)}</td><td>${x.c}/${x.total}</td><td>${Math.round(x.pct * 100)}%</td></tr>`).join("");
  const ta = h.topAnswers.map((r) => `<tr><td>${esc(r.display)}</td><td>${esc(r.category)}</td><td>${num(r.n)}</td></tr>`).join("");
  const hours = Array.from({ length: 24 }, () => 0); (h.startedTimes || []).forEach((ts) => { hours[easternHour(ts)]++; });
  const hmax = Math.max(1, ...hours);
  const hourRows = hours.map((n, i) => `<tr><td>${String(i).padStart(2, "0")}h</td><td>${bar(n, hmax)} ${n || ""}</td></tr>`).join("");
  const feat = h.features.map((r) => `<tr><td>${esc(r.type)}</td><td>${num(r.n)}</td></tr>`).join("");
  const reasons = h.reasons.map((r) => `<tr><td>${esc(r.reason)}</td><td>${num(r.n)}</td></tr>`).join("");
  const day = h.perDay.map((r) => `<tr><td>${esc(r.day)}</td><td>${num(r.n)}</td></tr>`).join("");
  const rec = h.recent.map((r) => `<tr><td class="dim">${easternTime(num(r.ended_at))}</td><td>${r.gid ? `<a href="/admin/game?key=${k}&gid=${encodeURIComponent(r.gid)}">${esc(r.code)} →</a>` : esc(r.code)}</td><td>${esc(r.p1_name)} ${num(r.p1_score)}–${num(r.p2_score)} ${esc(r.p2_name)}</td><td>${esc(r.winner_name || "tie")}</td><td>${num(r.rounds)}r</td><td>${esc(r.reason)}</td><td>${fmtMs(num(r.duration_ms))}</td></tr>`).join("");
  const ses = h.sessions || {};
  const dev = (ses.devices || []).map((d) => `<tr><td>${esc(d.device)}</td><td>${num(d.n)}</td><td>${fmtMs(num(d.avg))}</td></tr>`).join("");
  const sesRecent = (ses.recent || []).map((r) => `<tr><td>${easternTime(num(r.connected_at))}</td><td>${fmtMs(num(r.duration_ms))}</td><td>${esc(r.device)}</td><td>${esc(r.geo || r.tz || "—")}${r.ip ? `<br><span style="color:#566;font-size:11px">${esc(r.ip)}</span>` : ""}</td><td>${r.singleplayer ? "🕹️ singleplayer" : r.played ? "🎮 played" : r.spectated ? "👀 watched" : r.joined ? "lobby" : "browsed"}</td></tr>`).join("");
  const b = ses.buckets || {};
  // sessions per day + busiest hour, in Eastern; plus the browse-and-leave drop-off
  const stimes = ses.times || [];
  const sHours = Array.from({ length: 24 }, () => 0); stimes.forEach((ts) => { sHours[easternHour(ts)]++; });
  const peakH = sHours.some((n) => n) ? sHours.indexOf(Math.max(...sHours)) : null;
  const sDay = {}; stimes.forEach((ts) => { const d = easternDay(ts); sDay[d] = (sDay[d] || 0) + 1; });
  const sDayRows = Object.keys(sDay).sort().reverse().slice(0, 14).map((d) => `<tr><td>${d}</td><td>${sDay[d]}</td></tr>`).join("");
  const browseOnly = num(ses.total) - num(ses.joined);
  const browsePct = ses.total ? Math.round(browseOnly / num(ses.total) * 100) : 0;
  const s = h.superlatives;
  const sup = [
    s.longestGame ? `Longest game: <b>${fmtMs(num(s.longestGame.duration_ms))}</b> (${esc(s.longestGame.p1_name)} vs ${esc(s.longestGame.p2_name)})` : "",
    s.mostRounds ? `Most rounds: <b>${num(s.mostRounds.rounds)}</b> (${esc(s.mostRounds.p1_name)} vs ${esc(s.mostRounds.p2_name)})` : "",
    s.highestClaim ? `Highest claim: <b>${num(s.highestClaim.claim)}</b> — ${esc(s.highestClaim.category)} by ${esc(s.highestClaim.winner_name || "?")}` : "",
    `🎯 Easter eggs triggered: <b>${s.easterEggs}</b>`,
  ].filter(Boolean).map((x) => `<span class="pill">${x}</span>`).join("");
  const skips = (h.skips || []).map((r) => `<tr><td>${esc(r.category)}</td><td>${num(r.n)}</td></tr>`).join("");
  const sp = h.sp || {};
  const solo = h.solo || {};
  const daily = h.daily || {};
  const soloRecent = (solo.recent || []).map((r) => { const cat = (r.rounds && r.rounds.length === 1) ? r.rounds[0] : (r.genre ? r.genre + " · " + (r.rounds || []).length + "r" : (r.rounds || []).length + "r"); return `<tr><td>${easternTime(num(r.at))}</td><td>${esc(r.name || "?")}${r.crown ? " 👑" : ""}</td><td>${esc(cat)}</td><td>${num(r.total)}</td></tr>`; }).join("");
  const soloDay = (solo.perDay || []).map((r) => `<tr><td>${esc(r.day)}</td><td>${num(r.n)}</td></tr>`).join("");
  const soloCats = (solo.topCats || []).map((r) => `<tr><td>${esc(r.cat)}</td><td>${num(r.plays)}</td><td>${num(r.players)}</td><td>${num(r.avg).toFixed(1)}</td><td>${num(r.top)}</td></tr>`).join("");
  const dDay = (c) => String(c || "").replace(/^d-/, "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  const dailyDayRows = (daily.perDay || []).map((r) => `<tr><td>${dDay(r.challenge_id)}</td><td>${num(r.plays)}</td><td>${num(r.players)}</td><td>${num(r.avg).toFixed(1)}</td><td><b>${num(r.top)}</b> ${esc(r.name || "?")}</td></tr>`).join("");
  return `
    <h2>All-time history</h2>
    <p class="stats"><b>${h.games}</b> games · <b>${h.rounds}</b> rounds · <b>${h.players}</b> unique players · avg game <b>${fmtMs(h.avgDurationMs)}</b></p>
    <div class="pills">${sup}</div>
    <h3>🧑‍💻 Sessions (visits) — when people arrive & how long they stay</h3>
    <p class="stats"><b>${ses.total || 0}</b> sessions · avg stay <b>${fmtMs(ses.avgMs)}</b> · <b>${ses.played || 0}</b> played a game · <b>${ses.joined || 0}</b> entered a room · <b>${ses.singleplayer || 0}</b> went to single-player ·
      engagement: ${num(b.bounce)} bounced (&lt;30s) · ${num(b.short)} short (&lt;2m) · ${num(b.med)} medium (&lt;10m) · ${num(b.long)} long (10m+)</p>
    <div class="pills">
      <span class="pill">🚪 <b>${browseOnly}</b> browsed &amp; left without joining (<b>${browsePct}%</b> of visits)</span>
      ${peakH != null ? `<span class="pill">⏰ Busiest hour: <b>${fmtHour12(peakH)} ET</b> (${sHours[peakH]} sessions)</span>` : ""}
    </div>
    <div class="cols">
      <div><h3>📱 Device</h3>${tbl(["Device", "Sessions", "Avg stay"], dev, 3)}</div>
      <div><h3>📈 Sessions per day (Eastern)</h3>${tbl(["Day", "Sessions"], sDayRows, 2)}</div>
      <div><h3>🕒 Recent sessions (Eastern) · <a href="/admin/sessions?key=${k}">see all →</a></h3>${tbl(["Arrived", "Stayed", "Device", "Location / IP", "Did"], sesRecent, 5)}</div>
    </div>
    <div class="cols">
      <div><h3>🗂 Categories — plays · claim · solve%</h3>${tbl(["Category", "Plays", "Claim", "Solve%"], cat, 4)}</div>
      <div><h3>🔍 Least-explored categories</h3>${tbl(["Category", "Named", "Coverage"], cov, 3)}</div>
      <div><h3>💬 Most-named answers</h3>${tbl(["Answer", "Category", "×"], ta, 3)}</div>
      <div><h3>🕐 When people play (Eastern)</h3>${tbl(["Hour", "Games"], hourRows, 2)}</div>
      <div><h3>✨ Feature usage</h3>${tbl(["Event", "Count"], feat, 2)}</div>
      <div><h3>🔁 Most-skipped categories</h3>${tbl(["Category", "Skips"], skips, 2)}</div>
      <div><h3>🏁 How games ended</h3>${tbl(["Reason", "Count"], reasons, 2)}</div>
      <div><h3>📅 Games per day</h3>${tbl(["Day", "Games"], day, 2)}</div>
      <div><h3>🕑 Recent games</h3>${tbl(["When", "Code", "Result", "Winner", "Rds", "End", "Len"], rec, 7)}</div>
    </div>
    <h2>🏃 Solo runs</h2>
    <p class="stats"><b>${solo.plays || 0}</b> runs · <b>${solo.players || 0}</b> players · <b>${solo.challenges || 0}</b> challenges created · avg <b>${num(solo.avg).toFixed(1)}</b> · best <b>${solo.best || 0}</b> · <a href="/admin/runs?key=${k}" style="color:#5b8cff">every run + guesses →</a></p>
    <div class="cols">
      <div><h3>🗂 Most-played solo categories</h3>${tbl(["Category", "Runs", "Players", "Avg", "Best"], soloCats, 5)}</div>
      <div><h3>🕒 Recent solo runs (Eastern)</h3>${tbl(["When", "Player", "Category", "Score"], soloRecent, 4)}</div>
      <div><h3>📅 Solo runs per day</h3>${tbl(["Day", "Runs"], soloDay, 2)}</div>
    </div>
    <h2>🗓 Daily challenge</h2>
    <p class="stats"><b>${daily.plays || 0}</b> plays · <b>${daily.players || 0}</b> players · <b>${daily.days || 0}</b> days run · avg <b>${num(daily.avg).toFixed(1)}</b> · best ever <b>${daily.best || 0}</b></p>
    <div class="cols">
      <div><h3>📆 Each day — plays · players · avg · top scorer</h3>${tbl(["Date", "Plays", "Players", "Avg", "Top"], dailyDayRows, 5)}</div>
    </div>
    <h2 style="opacity:.6">🤖 Single-player vs bot — retired</h2>
    <p class="stats" style="opacity:.6">Historical only (the bot mode was retired). <b>${sp.games || 0}</b> games · <b>${sp.rounds || 0}</b> rounds.</p>`;
}

app.get("/admin", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const now = Date.now();
  const list = adminData();
  if (req.query.json) {
    const hist = analytics.enabled() ? await analytics.summary().catch(() => null) : null;
    return res.json({ now, uptimeMs: now - serverStartedAt, online, stats, history: hist, roomCount: list.length, rooms: list });
  }
  const hist = analytics.enabled() ? await analytics.summary().catch(() => null) : null;
  const playing = list.filter((r) => r.status === "playing").length;
  const k = encodeURIComponent(req.query.key || "");
  const card = (r) => {
    const ps = r.players.map((p) => `${esc(p.name)}${p.host ? " 👑" : ""}${p.connected === false ? " (reconnecting…)" : ""}`).join(" vs ") || "—";
    const g = r.game;
    const gameHtml = g ? `
      <div class="g"><b>${esc(g.category)}</b> · round ${g.round} · phase <b>${esc(g.phase)}</b>${g.paused ? " · ⏸ paused" : ""}</div>
      <div class="g">Score: ${esc(g.scores)} &nbsp; (first to ${esc(g.target)})</div>
      <div class="g">Claim: <b>${g.claim}</b> · current turn: <b>${esc(g.turn)}</b></div>
      <div class="g">Proven (${g.proven.length}): ${g.proven.length ? esc(g.proven.join(", ")) : "—"}</div>
      ${g.granted.length ? `<div class="g">Granted off-list: ${esc(g.granted.join(", "))}</div>` : ""}
      ${g.pending.length ? `<div class="g pend">Awaiting ruling: ${esc(g.pending.join(", "))}</div>` : ""}
    ` : `<div class="g">In the waiting room.</div>`;
    return `<div class="card ${r.status}">
      <div class="hd"><span class="code">${esc(r.code)}</span><span class="badge">${r.status === "playing" ? "🟢 playing" : "🟡 lobby"}</span>
        <a class="watch" href="/?ghost=${encodeURIComponent(r.code)}&key=${k}" target="_blank">👻 ghost</a>
        <a class="watch" href="/?spectate=${encodeURIComponent(r.code)}" target="_blank">👀 watch</a>
        <a class="close" href="/admin/close?key=${k}&code=${encodeURIComponent(r.code)}" onclick="return confirm('Close room ${esc(r.code)}? This kicks everyone out.')">✕ close</a></div>
      <div class="g players">${ps} &nbsp;·&nbsp; 👀 ${r.spectators}</div>
      <div class="g meta">age ${fmtDur(now - r.createdAt)} · idle ${fmtDur(now - r.lastActivityAt)}</div>
      ${gameHtml}
    </div>`;
  };
  res.set("content-type", "text/html").send(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15">
    <title>Prove It! — server</title><style>
    body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;margin:0 0 6px;font-size:13px}
    .stats{color:#c6ccda;margin:0 0 18px;font-size:13px} .stats b{color:#ffd34d}
    .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
    .card{background:#171a23;border:1px solid #262b38;border-radius:12px;padding:14px}
    .card.playing{border-color:#2e7d52} .hd{display:flex;align-items:center;gap:10px;margin-bottom:8px}
    .code{font-weight:900;font-size:22px;letter-spacing:3px;color:#ffd34d}
    .badge{font-size:12px;color:#8a92a6} .watch{margin-left:auto;color:#5b8cff;text-decoration:none;font-weight:700;font-size:13px}
    .close{color:#e5484d;text-decoration:none;font-weight:700;font-size:13px} .watch:hover,.close:hover{text-decoration:underline}
    .g{font-size:13px;color:#c6ccda;margin:3px 0} .g.players{color:#fff;font-weight:600} .g.meta{color:#6b7382;font-size:12px}
    .g.pend{color:#ffb454} b{color:#fff}
    h2{font-size:17px;margin:26px 0 4px} h3{font-size:13px;margin:14px 0 6px;color:#c6ccda}
    .cols{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
    table{width:100%;border-collapse:collapse;font-size:12px} th{text-align:left;color:#8a92a6;font-weight:600;border-bottom:1px solid #262b38;padding:4px 6px}
    td{padding:4px 6px;border-bottom:1px solid #1c2029;color:#dfe4ee} td a{color:#5b8cff;text-decoration:none} td a:hover{text-decoration:underline}
    .pills{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px} .pill{background:#171a23;border:1px solid #262b38;border-radius:20px;padding:5px 12px;font-size:12px;color:#c6ccda}
    .announce{background:#171a23;border:1px solid #262b38;border-radius:12px;padding:12px 14px;margin:0 0 18px}
    .announce form{display:flex;gap:8px;flex-wrap:wrap;align-items:center} .announce input{flex:1;min-width:180px;background:#0e1016;border:1px solid #2a3040;border-radius:8px;color:#fff;padding:8px 10px;font-size:13px}
    .announce button,.announce a.preset{background:#2a3040;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none}
    .announce a.preset{background:#3a2030;color:#ffb4b4} .announce .lbl{font-size:12px;color:#8a92a6;margin-right:4px}</style></head>
    <body><h1>🎯 Prove It! — live server</h1>
    <p class="sub">🟢 <b style="color:#3ecf8e">${online}</b> online · ${list.length} room${list.length === 1 ? "" : "s"} · ${playing} in a game · auto-refreshes every 4s · ${easternFull(now)}</p>
    <p class="stats">Since restart (${fmtDur(now - serverStartedAt)} ago): <b>${stats.roomsCreated}</b> rooms created · <b>${stats.gamesStarted}</b> games started · peak <b>${stats.peakRooms}</b> concurrent rooms</p>
    <div class="announce">
      <form action="/admin/announce" method="get">
        <span class="lbl">📢 Broadcast to all games:</span>
        <input type="hidden" name="key" value="${k}"><input name="msg" maxlength="200" placeholder="Type a message to every player…" autocomplete="off">
        <button>Send</button>
        <a class="preset" href="/admin/announce?key=${k}&msg=${encodeURIComponent("⚠️ Server updating in ~1 minute — finish your round!")}">⚠️ 1-min restart</a>
        <a class="preset" href="/admin/announce?key=${k}&msg=${encodeURIComponent("⚠️ Server updating in ~5 minutes — wrap up soon!")}">⚠️ 5-min restart</a>
      </form>
    </div>
    <div class="announce" style="${lockdown ? "border-color:#e5484d;background:#2a1618" : ""}">
      <span class="lbl">🔌 Server control:</span>
      <a class="preset" href="/admin/killall?key=${k}" onclick="return confirm('End ALL active games right now and kick everyone?')">🛑 End all games now</a>
      ${lockdown
        ? `<b style="color:#e5484d">● MAINTENANCE MODE — game is DOWN</b> <a class="preset" style="background:#1d3a26;color:#8ef0b4" href="/admin/lockdown?key=${k}&on=0">✅ Bring the game back ON</a>`
        : `<a class="preset" style="background:#3a2030;color:#ffb4b4" href="/admin/lockdown?key=${k}&on=1" onclick="return confirm('Take the game DOWN for maintenance? Kicks everyone, ends all games, and blocks new games (solo + multiplayer) until you toggle it back on.')">🔧 Take game down (maintenance)</a>`}
    </div>
    <p style="margin:0 0 16px"><a href="/admin/health?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">🩺 Category health → which answers never get named</a></p>
    <p style="margin:0 0 16px"><a href="/admin/games?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">🎞 Game history → drill into any past game: every guess, chat, and exact timestamp</a></p>
    <p style="margin:0 0 16px"><a href="/admin/chat?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">💬 All chat → every message across the whole server (searchable)</a></p>
    <p style="margin:0 0 16px"><a href="/admin/leaderboards?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">🏆 Leaderboards → moderate entries: remove junk/abusive names from any board</a></p>
    <p style="margin:0 0 16px"><a href="/admin/category-leaderboards?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">🥇 Category leaderboards (admin-only) → per-category top solo scores, watching before public</a></p>
    <p style="margin:0 0 16px"><a href="/admin/runs?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">🏃 Solo & daily runs → drill into any run: every exact guess (hits, misses, repeats)</a></p>
    <p style="margin:0 0 16px"><a href="/admin/sessions?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">🕒 Recent sessions → every visit in full: arrival, stay, device, location/IP, timezone</a></p>
    <p style="margin:0 0 16px"><a href="/admin/visitors?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">🧭 Visitors → repeat visitors, IP, location & timezone</a></p>
    <div class="grid">${list.length ? list.map(card).join("") : '<p class="sub">No active rooms right now.</p>'}</div>
    ${(() => { const live = liveSessions(); return `<h2>🌐 Live connections (${live.length})</h2>${tbl(["Connected for", "Name", "Doing", "Device"],
      live.map((s) => `<tr><td>${fmtDur(now - s.connectedAt)}</td><td>${esc(s.name || "—")}</td><td>${s.role}${s.room ? " · " + esc(s.room) : ""}</td><td>${s.device}</td></tr>`).join(""), 4)}`; })()}
    ${histHtml(hist, k)}
    </body></html>`);
});

// Category health: per-category coverage, and the "never-named" answer list (which entries nobody ever gets).
app.get("/admin/health", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    table{border-collapse:collapse;font-size:12px;width:100%;max-width:760px} th{text-align:left;color:#8a92a6;border-bottom:1px solid #262b38;padding:5px 8px}
    td{padding:5px 8px;border-bottom:1px solid #1c2029} .bar{display:inline-block;height:8px;border-radius:2px;background:#3ecf8e;vertical-align:middle}
    .low .bar{background:#e5484d} .mid .bar{background:#ffb454} .chips span{display:inline-block;background:#1c2029;border:1px solid #2a3040;border-radius:6px;padding:2px 7px;margin:3px;font-size:12px}</style>`;
  const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Category health</h1><p class="sub">Persistence not configured.</p></body>`);
  const named = new Map();
  (await analytics.namedDisplays().catch(() => [])).forEach((r) => { if (!named.has(r.category)) named.set(r.category, new Set()); named.get(r.category).add(r.display); });
  const cat = String(req.query.cat || "");

  if (cat && CAT_ITEMS[cat]) { // single-category drill-down: the never-named list
    const set = named.get(cat) || new Set();
    const never = CAT_ITEMS[cat].filter((d) => !set.has(d));
    const got = CAT_ITEMS[cat].filter((d) => set.has(d));
    return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
      <h1>${esc(CAT_GROUP[cat] || "")} — ${esc(cat)}</h1>
      <p class="sub">${got.length}/${CAT_ITEMS[cat].length} answers named at least once (${Math.round(got.length / CAT_ITEMS[cat].length * 100)}% coverage).</p>
      <h3>🚫 Never named (${never.length})</h3><div class="chips">${never.map((d) => `<span>${esc(d)}</span>`).join("") || "— all named! —"}</div>
      <h3 style="margin-top:18px">✅ Named (${got.length})</h3><div class="chips" style="opacity:.7">${got.map((d) => `<span>${esc(d)}</span>`).join("") || "—"}</div>
      </body>`);
  }

  // overview: every category by coverage (least-explored first)
  const rows = Object.keys(CAT_ITEMS).map((c) => {
    const total = CAT_ITEMS[c].length, n = (named.get(c) ? [...named.get(c)].filter((d) => CAT_ITEMS[c].includes(d)).length : 0);
    return { c, grp: CAT_GROUP[c], total, n, pct: total ? n / total : 0 };
  }).sort((a, b) => a.pct - b.pct);
  const tr = rows.map((r) => {
    const cls = r.pct < 0.25 ? "low" : r.pct < 0.6 ? "mid" : "";
    return `<tr class="${cls}"><td><a href="/admin/health?key=${k}&cat=${encodeURIComponent(r.c)}">${esc(r.c)}</a></td><td>${esc(r.grp)}</td><td>${r.n}/${r.total}</td><td><span class="bar" style="width:${Math.round(r.pct * 80)}px"></span> ${Math.round(r.pct * 100)}%</td></tr>`;
  }).join("");
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>🩺 Category health</h1>
    <p class="sub">Coverage = share of a category's answers that have been named at least once. Low coverage may mean the category is too obscure, mis-spelled, or just under-played. Click one to see exactly which answers never get named.</p>
    <table><tr><th>Category</th><th>Group</th><th>Named</th><th>Coverage</th></tr>${tr}</table>
    </body>`);
});

// Owner closes a room (kicks everyone, clears timers). Redirects back to the dashboard.
// 🎞 Game history — list of every finished game (mp + sp), newest first.
app.get("/admin/games", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const num = (x) => Number(x || 0);
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    table{border-collapse:collapse;font-size:13px;width:100%;max-width:980px} th{text-align:left;color:#8a92a6;border-bottom:1px solid #262b38;padding:6px 9px}
    td{padding:6px 9px;border-bottom:1px solid #1c2029;vertical-align:top} tr:hover td{background:#141823} .mode{font-weight:700} .sp{color:#ffb454} .mp{color:#3ecf8e}</style>`;
  const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Game history</h1><p class="sub">Persistence not configured.</p></body>`);
  const games = await analytics.gamesList(100).catch(() => []);
  const rows = games.map((g) => {
    const mode = g.mode === "sp" ? `<span class="mode sp">🤖 solo</span>` : `<span class="mode mp">🆚 mp</span>`;
    const score = `${esc(g.p1_name || "?")} <b>${num(g.p1_score)}–${num(g.p2_score)}</b> ${esc(g.p2_name || "?")}`;
    const link = g.gid ? `<a href="/admin/game?key=${k}&gid=${encodeURIComponent(g.gid)}">open →</a>` : `<span style="color:#566">— (older game)</span>`;
    return `<tr><td>${easternFull(num(g.started_at || g.ended_at))}</td><td>${mode}</td><td>${score}</td><td>${esc(g.winner_name || "tie")}</td><td>${num(g.rounds)}</td><td>${esc(g.difficulty || "")}</td><td>${fmtMs(num(g.duration_ms))}</td><td>${link}</td></tr>`;
  }).join("");
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>🎞 Game history</h1>
    <p class="sub">Every finished game, newest first. Click <b>open →</b> to replay the full timeline — every guess, chat message, and exact timestamp. (Only games played after this feature shipped have a timeline.)</p>
    <table><tr><th>When (ET)</th><th>Mode</th><th>Score</th><th>Winner</th><th>Rounds</th><th>Diff</th><th>Length</th><th></th></tr>${rows}</table>
    </body>`);
});

// 🔎 Single game — full chronological timeline: rounds, every answer (who/what/when), chat, events.
app.get("/admin/game", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const num = (x) => Number(x || 0);
  const clock = (ts) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(ts)); } catch { return ""; } };
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    .meta{background:#141823;border:1px solid #262b38;border-radius:10px;padding:12px 14px;max-width:820px;margin:0 0 18px;font-size:13px}
    .meta b{color:#fff} table{border-collapse:collapse;font-size:13px;width:100%;max-width:820px} td{padding:5px 9px;border-bottom:1px solid #1c2029;vertical-align:top}
    td.t{color:#8a92a6;white-space:nowrap;font-variant-numeric:tabular-nums;width:1%} .dim{color:#8a92a6} tr.round td{background:#16203a} tr.chat td{background:#1a1726} tr.event td{color:#8a92a6}</style>`;
  const back = `<a href="/admin/games?key=${k}">← back to game history</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Game</h1><p class="sub">Persistence not configured.</p></body>`);
  const d = await analytics.gameDetail(String(req.query.gid || "")).catch(() => null);
  if (!d || !d.game) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Game not found</h1><p class="sub">No game with that id (only games played after this feature shipped have a timeline).</p></body>`);
  const g = d.game;
  const items = [];
  d.rounds.forEach((r) => items.push({ at: num(r.at), kind: "round", html: `🎯 <b>Round</b> — ${esc(r.grp || "")}: <b>${esc(r.category || "?")}</b> · claimed ${num(r.claim)} · <b>${esc(r.winner_name || "?")}</b> won it (${num(r.proven)}/${num(r.claim)})` }));
  d.answers.forEach((a) => items.push({ at: num(a.at), kind: "answer", html: `${a.off_list ? "➕" : "✅"} <b>${esc(a.player || "?")}</b> named <b>${esc(a.display)}</b> <span class="dim">(${esc(a.category || "")}${a.off_list ? " · off-list, accepted" : ""})</span>` }));
  d.chat.forEach((c) => items.push({ at: num(c.at), kind: "chat", html: `💬 <b>${esc(c.name || "?")}${c.spectator ? " 👀" : ""}</b>: ${esc(c.text || "")}` }));
  d.events.forEach((e) => items.push({ at: num(e.at), kind: "event", html: `⚙️ ${esc(e.type || "")}${e.detail ? ": " + esc(e.detail) : ""}` }));
  items.sort((a, b) => a.at - b.at);
  const tl = items.length
    ? items.map((it) => `<tr class="${it.kind}"><td class="t">${clock(it.at)}</td><td>${it.html}</td></tr>`).join("")
    : `<tr><td colspan="2" class="dim">No timeline rows recorded for this game.</td></tr>`;
  const mode = g.mode === "sp" ? "🤖 single-player" : "🆚 multiplayer";
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>${esc(g.p1_name || "?")} ${num(g.p1_score)}–${num(g.p2_score)} ${esc(g.p2_name || "?")}</h1>
    <p class="sub">${mode} · winner: <b>${esc(g.winner_name || "tie")}</b> (${esc(g.reason || "")})</p>
    <div class="meta">
      <div>🕐 Started <b>${easternFull(num(g.started_at))}</b> · ended <b>${easternFull(num(g.ended_at))}</b> · lasted <b>${fmtMs(num(g.duration_ms))}</b></div>
      <div>🎚 ${num(g.rounds)} rounds · timer ${esc(String(g.timer))}s · first to ${esc(String(g.target))}${g.difficulty ? ` · bot: <b>${esc(g.difficulty)}</b>` : ""}</div>
      <div>🗂 Categories enabled: <span class="dim">${esc(g.groups || "—")}</span></div>
    </div>
    <table>${tl}</table>
    </body>`);
});

// 💬 Server-wide chat feed (newest first) with a name/keyword search.
app.get("/admin/chat", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const num = (x) => Number(x || 0);
  const search = String(req.query.q || "").slice(0, 60);
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 14px}
    input{background:#141823;border:1px solid #2a3040;border-radius:8px;color:#e8ecf4;padding:8px 11px;font-size:14px;width:240px} button{background:#5b8cff;border:0;border-radius:8px;color:#08130d;font-weight:700;padding:8px 14px;cursor:pointer;margin-left:6px}
    table{border-collapse:collapse;font-size:13px;width:100%;max-width:900px;margin-top:14px} td{padding:5px 9px;border-bottom:1px solid #1c2029;vertical-align:top} td.t{color:#8a92a6;white-space:nowrap;font-variant-numeric:tabular-nums} .dim{color:#8a92a6}</style>`;
  const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>All chat</h1><p class="sub">Persistence not configured.</p></body>`);
  const rows = (await analytics.allChat(300, search).catch(() => [])).map((c) =>
    `<tr><td class="t">${easternFull(num(c.at))}</td><td><b>${esc(c.name || "?")}${c.spectator ? " 👀" : ""}</b> <span class="dim">${c.gid ? `<a href="/admin/game?key=${k}&gid=${encodeURIComponent(c.gid)}">${esc(c.code || "")}</a>` : esc(c.code || "lobby")}</span></td><td>${esc(c.text || "")}</td></tr>`).join("");
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>💬 All chat</h1>
    <p class="sub">Every chat message across the whole server, newest first. Click a room code to open that game's full timeline.</p>
    <form method="get"><input type="hidden" name="key" value="${k}"><input name="q" placeholder="search name or message…" value="${esc(search)}" autofocus><button>Search</button>${search ? ` <a href="/admin/chat?key=${k}">clear</a>` : ""}</form>
    <table>${rows || `<tr><td class="dim">No messages${search ? " match that search" : " yet"}.</td></tr>`}</table>
    </body>`);
});

// 🧭 Visitors — repeat-visitor rollup keyed by the persistent anonymous device id.
app.get("/admin/visitors", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const num = (x) => Number(x || 0);
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    table{border-collapse:collapse;font-size:13px;width:100%;max-width:1040px} th{text-align:left;color:#8a92a6;border-bottom:1px solid #262b38;padding:6px 9px} td{padding:6px 9px;border-bottom:1px solid #1c2029;vertical-align:top}
    tr:hover td{background:#141823} .big{color:#3ecf8e;font-weight:700} .dim{color:#8a92a6}</style>`;
  const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Visitors</h1><p class="sub">Persistence not configured.</p></body>`);
  const list = await analytics.visitors(150).catch(() => []);
  const repeat = list.filter((v) => num(v.visits) > 1).length;
  const rows = list.map((v) => `<tr>
      <td>${num(v.visits) > 1 ? `<span class="big">↩︎ ${num(v.visits)}</span>` : num(v.visits)}</td>
      <td>${esc(v.names || "—")}</td>
      <td>${esc(v.geo || v.tz || "—")}</td>
      <td class="dim">${esc(v.ip || "—")}</td>
      <td>${esc(v.device || "")}</td>
      <td>${num(v.played)}🎮 ${num(v.joined)}🚪</td>
      <td class="dim">${easternFull(num(v.first_seen))}</td>
      <td class="dim">${easternFull(num(v.last_seen))}</td>
    </tr>`).join("");
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>🧭 Visitors</h1>
    <p class="sub">Grouped by a persistent anonymous device id (localStorage). <b>${repeat}</b> of ${list.length} have visited more than once. Names are self-entered and unverified; IP/location come from the network.</p>
    <table><tr><th>Visits</th><th>Names used</th><th>Location</th><th>IP</th><th>Device</th><th>Played/Joined</th><th>First seen</th><th>Last seen</th></tr>${rows || `<tr><td class="dim" colspan="8">No visitors recorded yet.</td></tr>`}</table>
    </body>`);
});

// Full recent-sessions log: every visit with all the detail we capture (newest first).
app.get("/admin/sessions", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const num = (x) => Number(x || 0);
  const n = Math.min(2000, Math.max(50, parseInt(req.query.n, 10) || 300));
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    table{border-collapse:collapse;font-size:13px;width:100%} th{text-align:left;color:#8a92a6;border-bottom:1px solid #262b38;padding:6px 9px;position:sticky;top:0;background:#0e1016} td{padding:6px 9px;border-bottom:1px solid #1c2029;vertical-align:top}
    tr:hover td{background:#141823} .big{color:#3ecf8e;font-weight:700} .dim{color:#8a92a6} .tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:20px;background:#1c2230;color:#c6ccda}
    .nav{margin:0 0 14px;font-size:13px} .nav a{margin-right:12px}</style>`;
  const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Sessions</h1><p class="sub">Persistence not configured.</p></body>`);
  const list = await analytics.sessionsList(n).catch(() => []);
  // repeat indicator: how many times this visitor shows up within the fetched window
  const seen = {}; list.forEach((r) => { if (r.visitor_id) seen[r.visitor_id] = (seen[r.visitor_id] || 0) + 1; });
  const did = (r) => r.singleplayer ? '<span class="tag">🕹️ solo</span>' : num(r.played) ? '<span class="tag">🎮 played</span>'
    : num(r.spectated) ? '<span class="tag">👀 watched</span>' : num(r.joined) ? '<span class="tag">🚪 lobby</span>' : '<span class="dim">browsed</span>';
  const rows = list.map((r) => {
    const vid = r.visitor_id ? esc(String(r.visitor_id).slice(0, 10)) : "—";
    const rep = r.visitor_id && seen[r.visitor_id] > 1 ? ` <span class="big">↩︎${seen[r.visitor_id]}</span>` : "";
    return `<tr>
      <td class="dim">${easternFull(num(r.connected_at))}</td>
      <td>${r.duration_ms != null ? fmtMs(num(r.duration_ms)) : '<span class="dim">live/—</span>'}</td>
      <td>${did(r)}</td>
      <td>${esc(r.name || "—")}</td>
      <td>${esc(r.device || "—")}<br><span class="dim" style="font-size:11px">${esc(r.mode || "")}</span></td>
      <td>${esc(r.geo || "—")}<br><span class="dim" style="font-size:11px">${esc(r.ip || "")}</span></td>
      <td class="dim">${esc(r.tz || "—")}${r.locale ? "<br>" + esc(r.locale) : ""}</td>
      <td class="dim" style="font-size:11px">${vid}${rep}</td>
    </tr>`;
  }).join("");
  const repeatVisitors = Object.values(seen).filter((c) => c > 1).length;
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>🕒 Recent sessions</h1>
    <p class="sub">Every visit, newest first — arrival time, how long they stayed, what they did, device, location/IP, timezone & locale. Showing <b>${list.length}</b> · <b>${repeatVisitors}</b> repeat visitors in this window.</p>
    <p class="nav">Show: <a href="/admin/sessions?key=${k}&n=100">100</a><a href="/admin/sessions?key=${k}&n=300">300</a><a href="/admin/sessions?key=${k}&n=1000">1000</a> · <a href="/admin/visitors?key=${k}">group by visitor →</a></p>
    <table><tr><th>Arrived (ET)</th><th>Stayed</th><th>Did</th><th>Name</th><th>Device</th><th>Location / IP</th><th>TZ / Locale</th><th>Visitor</th></tr>${rows || `<tr><td class="dim" colspan="8">No sessions recorded yet.</td></tr>`}</table>
    </body>`);
});

// Leaderboard moderation: list recent entries with a one-click remove (for junk/abusive names).
app.get("/admin/leaderboards", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const num = (x) => Number(x || 0);
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    table{border-collapse:collapse;font-size:13px;width:100%} th{text-align:left;color:#8a92a6;border-bottom:1px solid #262b38;padding:6px 9px;position:sticky;top:0;background:#0e1016} td{padding:6px 9px;border-bottom:1px solid #1c2029;vertical-align:top}
    tr:hover td{background:#141823} .dim{color:#8a92a6} .tot{font-weight:800;color:#ffd34d} .rm{color:#e5484d;font-weight:700} .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:20px;background:#1c2230;color:#c6ccda}</style>`;
  const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Leaderboards</h1><p class="sub">Persistence not configured.</p></body>`);
  const list = await analytics.recentResults(300).catch(() => []);
  const label = (r) => String(r.challenge_id || "").startsWith("d-")
    ? `<span class="tag">daily</span> ${esc(String(r.challenge_id).replace(/^d-/, "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"))}`
    : `<span class="tag">${esc(r.type || "challenge")}</span> ${esc(r.genre || r.challenge_id || "")}`;
  const rows = list.map((r) => `<tr>
      <td class="dim">${easternTime(num(r.at))}</td>
      <td>${label(r)}</td>
      <td><b>${esc(r.name || "?")}</b><br><span class="dim" style="font-size:11px">${esc(String(r.visitor_id || "").slice(0, 12))}</span></td>
      <td class="tot">${num(r.total)}</td>
      <td><a class="rm" href="/admin/result-delete?key=${k}&id=${num(r.id)}" onclick="return confirm('Remove ${esc((r.name || '?').replace(/'/g, ''))} (${num(r.total)}) from this leaderboard?')">✕ remove</a></td>
    </tr>`).join("");
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>🏆 Leaderboard entries</h1>
    <p class="sub">Newest ${list.length} entries across daily + link challenges. Remove junk or abusive self-entered names. This deletes one entry permanently.</p>
    <table><tr><th>When (ET)</th><th>Board</th><th>Name</th><th>Score</th><th></th></tr>${rows || `<tr><td class="dim" colspan="5">No entries yet.</td></tr>`}</table>
    </body>`);
});
app.get("/admin/result-delete", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const rowId = parseInt(req.query.id, 10);
  if (rowId && analytics.enabled()) await analytics.deleteResult(rowId).catch(() => {});
  res.redirect(`/admin/leaderboards?key=${encodeURIComponent(req.query.key || "")}`);
});

// Private per-category leaderboards (not public yet — watching how solo play unfolds).
app.get("/admin/category-leaderboards", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    .cats{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
    .cat{background:#171a23;border:1px solid #262b38;border-radius:12px;padding:12px 14px}
    .cathd{font-weight:700;margin-bottom:8px} .cathd .dim{font-weight:400}
    .dim{color:#8a92a6} table{width:100%;border-collapse:collapse;font-size:13px} td{padding:3px 6px;border-bottom:1px solid #1c2029}
    .rk{color:#8a92a6;width:22px} .sc{text-align:right;font-weight:800;color:#ffd34d}</style>`;
  const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Category leaderboards</h1><p class="sub">Persistence not configured.</p></body>`);
  const cats = await analytics.categoryLeaderboards(10).catch(() => []);
  const totalRuns = cats.reduce((a, c) => a + c.runs, 0);
  const blocks = cats.map((c) => `<div class="cat">
      <div class="cathd">${esc(c.category)} <span class="dim">· ${c.runs} run${c.runs !== 1 ? "s" : ""} · ${c.players} player${c.players !== 1 ? "s" : ""}</span></div>
      <table>${c.top.map((p, i) => `<tr><td class="rk">${i + 1}</td><td>${esc(p.name || "?")}</td><td class="sc">${p.score}</td></tr>`).join("")}</table>
    </div>`).join("");
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>🥇 Category leaderboards <span class="dim" style="font-size:13px">(admin-only)</span></h1>
    <p class="sub">Each player's best score per category across all solo / daily / link runs — <b>${cats.length}</b> categories played, <b>${totalRuns}</b> total category-runs. Busiest first. Not public yet; this is to see how it unfolds.</p>
    <div class="cats">${blocks || `<p class="dim">No solo runs recorded yet.</p>`}</div>
    </body>`);
});

// Solo + daily run history — list of individual runs, each drillable to the exact guesses.
function runLabel(r) {
  if (String(r.challenge_id || "").startsWith("d-")) return `daily ${String(r.challenge_id).replace(/^d-/, "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}`;
  let rounds = []; try { rounds = JSON.parse(r.rounds || "[]"); } catch (e) {}
  if (rounds.length === 1) return esc(rounds[0]);
  if (r.type === "genre" && r.genre) return `${esc(r.genre)} · ${rounds.length}r`;
  return `${rounds.length} rounds`;
}
app.get("/admin/runs", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const num = (x) => Number(x || 0);
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    table{border-collapse:collapse;font-size:13px;width:100%} th{text-align:left;color:#8a92a6;border-bottom:1px solid #262b38;padding:6px 9px;position:sticky;top:0;background:#0e1016} td{padding:6px 9px;border-bottom:1px solid #1c2029;vertical-align:top}
    tr:hover td{background:#141823} .dim{color:#8a92a6} .tot{font-weight:800;color:#ffd34d} .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:20px;background:#1c2230;color:#c6ccda}</style>`;
  const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Solo & daily runs</h1><p class="sub">Persistence not configured.</p></body>`);
  const list = await analytics.soloRunsList(150).catch(() => []);
  const rows = list.map((r) => {
    const isDaily = String(r.challenge_id || "").startsWith("d-");
    return `<tr>
      <td class="dim">${easternTime(num(r.at))}</td>
      <td><span class="tag">${isDaily ? "daily" : (r.type || "solo")}</span> ${runLabel(r)}</td>
      <td><b>${esc(r.name || "?")}</b><br><span class="dim" style="font-size:11px">${esc(String(r.visitor_id || "").slice(0, 12))}</span></td>
      <td class="tot">${num(r.total)}</td>
      <td>${r.gid ? `<a href="/admin/run?key=${k}&gid=${encodeURIComponent(r.gid)}">see guesses →</a>` : `<span class="dim">—</span>`}</td>
    </tr>`;
  }).join("");
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>🏃 Solo & daily runs</h1>
    <p class="sub">Each individual run, newest first. Click "see guesses" to replay every word someone typed (runs played after this shipped have a guess log).</p>
    <table><tr><th>When (ET)</th><th>Puzzle</th><th>Player</th><th>Score</th><th></th></tr>${rows || `<tr><td class="dim" colspan="5">No runs recorded yet.</td></tr>`}</table>
    </body>`);
});
app.get("/admin/run", async (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const k = encodeURIComponent(req.query.key || "");
  const num = (x) => Number(x || 0);
  const clock = (ts) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(ts)); } catch (e) { return ""; } };
  const style = `<style>body{margin:0;background:#0e1016;color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px}
    a{color:#5b8cff;text-decoration:none} a:hover{text-decoration:underline} h1{font-size:20px;margin:0 0 4px} .sub{color:#8a92a6;font-size:13px;margin:0 0 16px}
    .meta{background:#141823;border:1px solid #262b38;border-radius:10px;padding:12px 14px;max-width:760px;margin:0 0 18px;font-size:13px} .meta b{color:#fff}
    table{border-collapse:collapse;font-size:13px;width:100%;max-width:760px} td{padding:5px 9px;border-bottom:1px solid #1c2029;vertical-align:top}
    td.t{color:#8a92a6;white-space:nowrap;font-variant-numeric:tabular-nums;width:1%} .dim{color:#8a92a6} tr.cat td{background:#16203a;font-weight:700} .ok{color:#3ecf8e} .miss{color:#e5484d} .dup{color:#ffb454}</style>`;
  const back = `<a href="/admin/runs?key=${k}">← back to runs</a>`;
  if (!analytics.enabled()) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Run</h1><p class="sub">Persistence not configured.</p></body>`);
  const d = await analytics.soloRunDetail(String(req.query.gid || "")).catch(() => null);
  if (!d || !d.result) return res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}<h1>Run not found</h1><p class="sub">No run with that id (only runs played after this feature shipped have a guess log).</p></body>`);
  const r = d.result;
  let scores = []; try { scores = JSON.parse(r.scores || "[]"); } catch (e) {}
  const isDaily = String(r.challenge_id || "").startsWith("d-");
  const items = [];
  let lastCat = null;
  d.answers.forEach((a) => {
    if (a.category !== lastCat) { items.push({ at: num(a.at), cat: true, html: `🗂 <b>${esc(a.category || "?")}</b>` }); lastCat = a.category; }
    const mark = a.verdict === "ok" ? `<span class="ok">✓</span>` : a.verdict === "dup" ? `<span class="dup">⟳ dup</span>` : `<span class="miss">✗</span>`;
    items.push({ at: num(a.at), html: `${mark} ${esc(a.display || "")}` });
  });
  const tl = d.answers.length
    ? items.map((it) => `<tr class="${it.cat ? "cat" : ""}"><td class="t">${it.cat ? "" : clock(it.at)}</td><td>${it.html}</td></tr>`).join("")
    : `<tr><td colspan="2" class="dim">No guesses were logged for this run.</td></tr>`;
  const okN = d.answers.filter((a) => a.verdict === "ok").length;
  const missN = d.answers.filter((a) => a.verdict === "miss").length;
  const dupN = d.answers.filter((a) => a.verdict === "dup").length;
  res.set("content-type", "text/html").send(`<!doctype html>${style}<body>${back}
    <h1>${esc(r.name || "?")} — ${num(r.total)} named</h1>
    <p class="sub">${isDaily ? "daily" : (r.type || "solo")} · ${easternFull(num(r.at))}</p>
    <div class="meta">
      <div>🎯 Total <b>${num(r.total)}</b> · per round: <b>${esc(scores.join(", ") || "—")}</b></div>
      <div>⌨️ Guesses logged: <b>${d.answers.length}</b> · <span class="ok">${okN} hit</span> · <span class="miss">${missN} missed</span> · <span class="dup">${dupN} repeat</span></div>
      <div class="dim">visitor ${esc(String(r.visitor_id || "—").slice(0, 16))} · gid ${esc(String(req.query.gid || ""))}</div>
    </div>
    <table>${tl}</table>
    </body>`);
});

app.get("/admin/close", (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const code = String(req.query.code || "").toUpperCase().trim();
  closeRoom(code);
  res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
});

// Kill switch: end every active game right now (one-shot).
app.get("/admin/killall", (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const n = closeAllRooms();
  io.emit("announce", { text: "🛑 The server was reset — all games ended." });
  console.log(`🛑 owner ended ALL games (${n} rooms)`);
  res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
});
// Maintenance mode: take the game fully down (kick everyone, block new games) until toggled back on.
app.get("/admin/lockdown", (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  lockdown = req.query.on === "1";
  if (lockdown) { closeAllRooms(); io.emit("announce", { text: "🔧 The game is down for maintenance — back soon." }); console.log("🔒 LOCKDOWN ON — new games blocked"); }
  else { io.emit("announce", { text: "✅ Back online — the game is up!" }); console.log("🔓 lockdown OFF — game back up"); }
  res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
});
// Owner broadcasts a banner message to EVERY connected client (e.g. a pre-deploy heads-up).
app.get("/admin/announce", (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const text = String(req.query.msg || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (text) { io.emit("announce", { text }); console.log(`📢 announce: ${text}`); }
  res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
});

// Single-player phones home here (no socket). Public, fire-and-forget, validated + size-capped.
app.post("/track", async (req, res) => {
  res.json({ ok: true });
  if (!analytics.enabled()) return;
  const e = req.body || {};
  const str = (v, n = 60) => (typeof v === "string" ? v.slice(0, n) : null);
  const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const device = /Mobile|Android|iPhone|iPad|iPod/i.test(req.get("user-agent") || "") ? "mobile" : "desktop";
  const now = Date.now();
  try {
    const gid = str(e.gid, 40);
    if (e.type === "spRound") {
      analytics.recordRound({ code: "SP", category: str(e.category), grp: str(e.grp), winner_id: e.won ? "you" : "bot",
        winner_name: e.won ? "You" : "Bot", claim: int(e.claim), proven: int(e.proven), at: now, mode: "sp", difficulty: str(e.difficulty, 10), gid });
      if (Array.isArray(e.answers)) e.answers.slice(0, 50).forEach((d) =>
        analytics.recordAnswer({ code: "SP", category: str(e.category), grp: str(e.grp), display: str(d), offList: false, at: now, mode: "sp", gid, player: "You" }));
    } else if (e.type === "challenge") {
      analytics.recordEvent("challenge", "CH", `${str(e.category, 40)} · named ${int(e.score)}${e.received ? ` (vs ${int(e.target)})` : ""} · ${int(e.timer)}s`, "ch");
    } else if (e.type === "spSkip") {
      analytics.recordEvent("categorySkipped", "SP", str(e.category), "sp", gid);
    } else if (e.type === "spGame") {
      const result = str(e.result, 8); // "win" | "loss" | "tie"
      analytics.recordGame({ code: "SP", p1_id: "you", p1_name: "You", p1_score: int(e.scoreMe), p2_id: "bot", p2_name: "Bot", p2_score: int(e.scoreBot),
        winner_id: result === "win" ? "you" : result === "loss" ? "bot" : null, winner_name: result === "win" ? "You" : result === "loss" ? "Bot" : null,
        groups: str(e.groups, 200), timer: int(e.timer), target: str(e.target, 10), rounds: int(e.rounds), reason: result,
        started_at: int(e.startedAt), ended_at: now, duration_ms: int(e.durationMs), mode: "sp", difficulty: str(e.difficulty, 10), gid });
    } else if (e.type === "spSession") {
      const dur = int(e.durationMs) || 0;
      const ip = clientIp(req.headers, req.socket && req.socket.remoteAddress);
      const geo = await geoLookup(ip);
      analytics.recordSession({ connected_at: now - dur, disconnected_at: now, duration_ms: dur, device, played: !!e.played, joined: false, spectated: false, name: "SP", reason: "sp", mode: "sp",
        ip, geo, visitor_id: str(e.visitorId, 40), tz: str(e.tz, 40), locale: str(e.lang, 20) });
    }
  } catch (err) { /* ignore bad payloads */ }
});

// ---------- async challenges (multi-round + shared leaderboard) ----------
const ALL_CAT_NAMES = new Set();
for (const v of Object.values(CATEGORY_GROUPS)) for (const c of v.cats) ALL_CAT_NAMES.add(c.name);
const newChallengeId = () => Math.random().toString(36).slice(2, 9); // 7-char url-safe id

app.post("/challenge", async (req, res) => {
  const b = req.body || {};
  if (lockdown) return res.json({ ok: false, error: "The game is down for maintenance — check back soon." });
  if (!analytics.enabled()) return res.json({ ok: false, error: "Challenges need persistence (not configured)." });
  const type = b.type === "custom" ? "custom" : "genre";
  const rounds = (Array.isArray(b.rounds) ? b.rounds : []).filter((n) => ALL_CAT_NAMES.has(n)).slice(0, 10);
  if (rounds.length < 1) return res.json({ ok: false, error: "Pick at least one valid category." });
  const tt = parseInt(b.timer, 10); const timer = (tt >= 5 && tt <= 1800) ? tt : 45; // any custom length, 5s–30min
  const id = newChallengeId();
  const ok = await analytics.createChallenge({ id, type, genre: String(b.genre || "").slice(0, 40), rounds, by: String(b.by || "A friend").slice(0, 24), timer });
  res.json(ok ? { ok: true, id } : { ok: false, error: "Could not save challenge." });
});
app.get("/challenge/:id", async (req, res) => {
  if (!analytics.enabled()) return res.json({ ok: false });
  const c = await analytics.getChallenge(String(req.params.id).slice(0, 12)).catch(() => null);
  if (!c) return res.json({ ok: false });
  res.json({ ok: true, id: c.id, type: c.type, genre: c.genre, rounds: c.rounds, by: c.by_name, timer: c.timer || 45 });
});
app.post("/challenge/:id/result", async (req, res) => {
  if (!analytics.enabled()) return res.json({ ok: false });
  const id = String(req.params.id).slice(0, 12);
  const c = await analytics.getChallenge(id).catch(() => null);
  if (!c) return res.json({ ok: false });
  const b = req.body || {};
  const scores = (Array.isArray(b.scores) ? b.scores : []).map((n) => Math.max(0, Math.min(999, parseInt(n, 10) || 0))).slice(0, c.rounds.length);
  const wpms = (Array.isArray(b.wpms) ? b.wpms : []).map((n) => Math.max(0, Math.min(9999, parseInt(n, 10) || 0))).slice(0, c.rounds.length);
  const total = scores.reduce((a, n) => a + n, 0);
  const crown = !!(process.env.OWNER_KEY && b.ownerKey === process.env.OWNER_KEY); // creator crown (server-validated)
  const gid = String(b.gid || "").slice(0, 40); // links this run to its captured guesses
  await analytics.addChallengeResult({ challenge_id: id, name: String(b.name || "Anon").slice(0, 24), visitor_id: String(b.visitorId || "").slice(0, 40), scores, total, wpms, crown, gid });
  res.json({ ok: true });
});
// Rename a player's leaderboard entries everywhere (all challenges/days). Owner key → also renames
// every crowned row so the creator's name stays consistent across devices.
app.post("/challenge/rename", async (req, res) => {
  if (!analytics.enabled()) return res.json({ ok: false });
  const b = req.body || {};
  const name = String(b.name || "").slice(0, 24).trim();
  if (!name) return res.json({ ok: false });
  const visitorId = String(b.visitorId || "").slice(0, 40) || null;
  const crownAll = !!(process.env.OWNER_KEY && b.ownerKey === process.env.OWNER_KEY);
  if (!visitorId && !crownAll) return res.json({ ok: false });
  const updated = await analytics.renameResults({ name, visitorId, crownAll }).catch(() => 0);
  res.json({ ok: true, updated });
});
// Exact guesses for one round of a solo/daily run (every Enter press: ok / miss / dup).
app.post("/challenge/:id/guesses", async (req, res) => {
  if (!analytics.enabled()) return res.json({ ok: false });
  const id = String(req.params.id).slice(0, 12);
  const c = await analytics.getChallenge(id).catch(() => null);
  if (!c) return res.json({ ok: false });
  const b = req.body || {};
  const gid = String(b.gid || "").slice(0, 40);
  if (!gid) return res.json({ ok: false });
  const guesses = (Array.isArray(b.guesses) ? b.guesses : []).slice(0, 200).map((g) => ({
    display: String(g.display || "").slice(0, 80),
    verdict: ["ok", "miss", "dup"].includes(g.verdict) ? g.verdict : null,
    at: Math.max(0, parseInt(g.at, 10) || Date.now()),
  }));
  analytics.recordSoloGuesses({ gid, challengeId: id, category: String(b.category || "").slice(0, 80), name: String(b.name || "").slice(0, 24), mode: id.startsWith("d-") ? "daily" : "solo", guesses });
  res.json({ ok: true });
});
app.get("/challenge/:id/results", async (req, res) => {
  if (!analytics.enabled()) return res.json({ ok: false });
  const id = String(req.params.id).slice(0, 12);
  const c = await analytics.getChallenge(id).catch(() => null);
  if (!c) return res.json({ ok: false });
  res.json({ ok: true, rounds: c.rounds, by: c.by_name, creator: await analytics.getCreatorName().catch(() => null), results: await analytics.getChallengeResults(id).catch(() => []) });
});

// ---------- Daily challenge ----------
// One shared puzzle per (Eastern) day that everyone plays, with the same arcade leaderboard
// as link challenges. A daily is just a challenge with a fixed, short, date-derived id.
const DAILY_TROLL = new Set(["Things the Nyan Cat Says", "Counting Numbers", "Nobel Peace Prize Loser", "People in the Epstein Files", "Italian Brainrot", "Cities Mistaken for Australia's Capital", "Seasons of the Year", "Months of the Year"]);
const DAILY_POOL = [];
for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
  if (grp.defaultOff) continue;
  for (const c of grp.cats) if (!DAILY_TROLL.has(c.name) && (CAT_SIZES[c.name] || 0) >= 14) DAILY_POOL.push(c.name);
}
DAILY_POOL.sort(); // stable order so the seeded pick is identical across server restarts
// Deterministic PRNG (xmur3 seed + mulberry32) so a given date always yields the same puzzle.
function seededRng(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h ^= h >>> 16) >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function dailyRounds(date, n = 3) {
  const rng = seededRng("proveit-daily-" + date), pool = DAILY_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}
const DAILY_TIMER = 30;
const dailyId = (date) => "d-" + date.replace(/-/g, ""); // e.g. d-20260624 (10 chars, within the 12-char id slice)

app.get("/daily", async (req, res) => {
  if (!analytics.enabled()) return res.json({ ok: false, error: "Daily needs persistence (not configured)." });
  const date = easternDay(Date.now());
  const id = dailyId(date);
  let c = await analytics.getChallenge(id).catch(() => null);
  if (!c) { // first player of the day creates it (deterministic rounds → races are harmless)
    await analytics.createChallenge({ id, type: "daily", genre: "", rounds: dailyRounds(date, 3), by: "Daily", timer: DAILY_TIMER }).catch(() => {});
    c = await analytics.getChallenge(id).catch(() => null);
  }
  if (!c) return res.json({ ok: false, error: "Could not load today's daily." });
  const results = await analytics.getChallengeResults(id).catch(() => []);
  res.json({ ok: true, id, date, rounds: c.rounds, timer: c.timer || DAILY_TIMER, players: results.length });
});
// Public per-category leaderboard (each geography "question" gets its own board).
app.get("/category-leaderboard", async (req, res) => {
  if (!analytics.enabled()) return res.json({ ok: false });
  const name = String(req.query.name || "").slice(0, 60);
  if (!ALL_CAT_NAMES.has(name)) return res.json({ ok: false });
  const results = await analytics.categoryLeaderboard(name, 50).catch(() => []);
  res.json({ ok: true, name, results });
});
// All-time daily high scores (across every day's puzzle).
app.get("/daily/alltime", async (req, res) => {
  if (!analytics.enabled()) return res.json({ ok: false });
  const rows = await analytics.dailyAllTime(50).catch(() => []);
  res.json({ ok: true, results: rows });
});

// Dynamic social preview for a shared challenge link (?id=…). Crawlers (Discord/iMessage/
// Reddit/Twitter) don't run JS, so we inject the challenger's name + score-to-beat into the
// OG meta tags server-side. No id → fall through to the static challenge.html.
app.get("/challenge.html", async (req, res, next) => {
  const id = String(req.query.id || "").slice(0, 12);
  if (!id || !analytics.enabled()) return next();
  const c = await analytics.getChallenge(id).catch(() => null);
  if (!c) return next();
  const results = await analytics.getChallengeResults(id).catch(() => []);
  const by = c.by_name || "A friend";
  const rounds = c.rounds || [];
  const nRounds = rounds.length;
  const what = c.type === "genre" && c.genre ? `${nRounds} rounds of ${c.genre}` : `${nRounds} rounds`;
  // Pick the challenger's best single-round score + that round's category ("17 Countries in Europe").
  // Prefer the creator's own runs; fall back to everyone's if their name isn't on the board yet.
  const mine = results.filter((r) => (r.name || "").trim().toLowerCase() === by.trim().toLowerCase());
  const pool = mine.length ? mine : results;
  let best = null; // { score, idx }
  for (const r of pool) (r.scores || []).forEach((s, i) => { s = Number(s) || 0; if (s > 0 && (!best || s > best.score)) best = { score: s, idx: i }; });
  const title = (best && rounds[best.idx])
    ? `⚡ ${by} says you can't name more than ${best.score} ${rounds[best.idx]}`
    : `⚡ ${by} challenged you on Prove It!`;
  const desc = `${what}. Name as many as you can before the clock runs out, then try to beat the leaderboard. No sign-up, just click and play.`;
  let html;
  try { html = fs.readFileSync(path.join(__dirname, "challenge.html"), "utf8"); } catch (e) { return next(); }
  const a = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  html = html
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${a(title)}">`)
    .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${a(desc)}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${a(title)}</title>`);
  res.set("content-type", "text/html").set("cache-control", "no-cache").send(html);
});

// Always revalidate HTML/JS so the inlined CSS + game logic are never served stale
// (matters because we push UI tweaks frequently and the link is shared publicly).
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (/\.(html|js)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  },
}));

// ---------- Rooms ----------
// code -> { code, hostId, status, settings, players: Map<playerId, {id,name,socketId,connected}>, graceTimeout }
// Identity is the stable playerId (the client keeps it in sessionStorage), NOT the
// socket id — so a reconnect with a new socket re-claims the same player slot.
const rooms = new Map();
let lockdown = false; // owner maintenance kill-switch: blocks new games until toggled back on
const MAX_PLAYERS = 2;
const GRACE_MS = 30000; // time to reconnect before forfeiting
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
    code: room.code, hostId: room.hostId, status: room.status, settings: room.settings,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, isHost: p.id === room.hostId, connected: p.connected, crown: !!p.crown,
    })),
    spectators: room.spectators ? [...room.spectators.values()].map((s) => ({ id: s.id, name: s.name })) : [],
  };
}
function broadcast(room) { touch(room); io.to(room.code).emit("roomState", roomState(room)); }

function attach(room, socket, playerId) {
  const p = room.players.get(playerId);
  p.socketId = socket.id; p.connected = true;
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = playerId;
  if (socket.data.session) { socket.data.session.joined = true; socket.data.session.name = p.name; }
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

// Owner-forced room shutdown: tell everyone, drop timers, evict sockets, delete the room.
function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return false;
  if (room.game?.timeout) clearTimeout(room.game.timeout);
  if (room.graceTimeout) clearTimeout(room.graceTimeout);
  rooms.delete(code);             // remove first: any reconnect-resume will now fail → client lands home
  io.to(code).emit("roomClosed"); // clean clients leave with a message…
  // …then hard-evict everyone once the message flushes (covers any stale/cached client too)
  setTimeout(() => io.in(code).disconnectSockets(true), 150);
  console.log(`🛑 room ${code} closed by owner`);
  return true;
}

function closeAllRooms() { let n = 0; for (const code of [...rooms.keys()]) if (closeRoom(code)) n++; return n; }
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

const deviceOf = (socket) => (/Mobile|Android|iPhone|iPad|iPod/i.test(socket.handshake.headers["user-agent"] || "") ? "mobile" : "desktop");

io.on("connection", (socket) => {
  console.log(`✅ connected: ${socket.id}`);
  online++; broadcastPresence();
  socket.on("latencyPing", (ack) => { if (typeof ack === "function") ack(); }); // RTT probe for the client's "X ms" indicator
  socket.on("enterSingleplayer", () => { if (socket.data.session) socket.data.session.singleplayer = true; }); // they left the lobby to play the bot
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
    if (room.graceTimeout) { clearTimeout(room.graceTimeout); room.graceTimeout = null; }
    io.to(room.code).emit("opponentStatus", { connected: true, name: room.players.get(pid).name });
    ack?.({ ok: true, code: room.code, you: pid, inGame: !!room.game });
    broadcast(room);
    if (room.game) engine.resumeGame(io, room); // unpause + push gameState
  }

  socket.on("createRoom", ({ name, playerId } = {}, ack) => {
    if (lockdown) return ack?.({ ok: false, error: "The game is down for maintenance — check back soon." });
    leaveCurrentRoom(socket);
    const code = makeCode();
    const pid = playerId || genId();
    const now = Date.now();
    const room = { code, hostId: pid, status: "waiting",
      settings: { groups: [...DEFAULT_GROUPS], timer: 30, target: 5, autoAdvance: true },
      players: new Map(), spectators: new Map(), graceTimeout: null, createdAt: now, lastActivityAt: now };
    room.players.set(pid, { id: pid, name: cleanName(name), socketId: socket.id, connected: true });
    rooms.set(code, room);
    stats.roomsCreated++; stats.peakRooms = Math.max(stats.peakRooms, rooms.size);
    attach(room, socket, pid);
    console.log(`🏠 room ${code} created`);
    ack?.({ ok: true, code, you: pid });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name, playerId } = {}, ack) => {
    if (lockdown) return ack?.({ ok: false, error: "The game is down for maintenance — check back soon." });
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

  // Join a room as a read-only spectator (watch the duel; can chat but can't play).
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
    ack?.({ ok: true, code, you: pid, spectator: true, inGame: !!room.game });
    broadcast(room);
    if (room.game) engine.resync(io, room); // push current game state to the new spectator
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
    if (room.game) engine.resync(io, room);     // current game state (re-broadcast is idempotent for players)
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
    engine.resync(io, room); // refresh in-game name labels too
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
    if (room.game) engine.resync(io, room); // refresh in-game name labels
  });

  // Host configures the room — before starting (all settings) and mid-game (timer/target/auto).
  socket.on("setSettings", ({ groups, timer, target, autoAdvance } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId) return;
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
    broadcast(room);
    if (inGame && room.game) engine.applyLiveSettings(io, room, patch); // apply to the live match
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
    stats.gamesStarted++;
    for (const pl of room.players.values()) { const sk = io.sockets.sockets.get(pl.socketId); if (sk?.data?.session) sk.data.session.played = true; }
    console.log(`▶️ room ${room.code} started`);
    ack?.({ ok: true });
    engine.startMatch(io, room);
  });

  // ---------- gameplay intents (ignored while paused; engine validates the rest) ----------
  // Game actions are players-only — spectators (not in room.players) are silently ignored.
  const withGame = (fn) => (...args) => {
    const room = rooms.get(socket.data.roomCode);
    if (room && room.game && !room.game.paused && room.players.has(socket.data.playerId)) { touch(room); fn(room, ...args); }
  };
  socket.on("open", withGame((room, { n } = {}, ack) => engine.handleOpen(io, room, socket, n, ack)));
  socket.on("raise", withGame((room, { toN } = {}, ack) => engine.handleRaise(io, room, socket, toN, ack)));
  socket.on("proveIt", withGame((room, _p, ack) => engine.handleProveIt(io, room, socket, ack)));
  socket.on("answer", withGame((room, { text } = {}, ack) => engine.handleAnswer(io, room, socket, text, ack)));
  socket.on("judge", withGame((room, { answerId, accept } = {}) => engine.handleJudge(io, room, socket, { answerId, accept })));
  socket.on("rejectAll", withGame((room) => engine.handleRejectAll(io, room, socket)));
  socket.on("giveUp", withGame((room) => engine.handleGiveUp(io, room, socket)));
  socket.on("pauseRound", withGame((room) => engine.handlePauseRound(io, room, socket)));
  socket.on("nextRound", withGame((room) => engine.handleNextRound(io, room, socket)));
  socket.on("voteSkip", withGame((room) => engine.handleVoteSkip(io, room, socket)));
  socket.on("voteEnd", withGame((room) => engine.handleVoteEnd(io, room, socket)));

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
    if (room) engine.handleRematch(io, room, socket, ack);
  });

  socket.on("leaveRoom", () => leaveCurrentRoom(socket));

  // Disconnect ≠ leave: hold the slot, pause the game, give them GRACE_MS to return.
  socket.on("disconnect", (reason) => {
    console.log(`👋 disconnected: ${socket.id} (${reason})`);
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
