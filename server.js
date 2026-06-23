// Prove It! — server (Phase 4: rooms + reconnection)
// Serves the static game files AND runs the Socket.IO realtime layer on one port.
const path = require("path");
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
const TIMERS = [15, 30, 45, 60];
const TARGETS = [3, 5, 10]; // plus null = endless

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Persist game/round events for the admin board (fire-and-forget; no-ops if Turso isn't set).
engine.setReporter((room, type, extra) => {
  try {
    if (type === "round") {
      analytics.recordRound({ code: room.code, category: extra.category, grp: extra.grp,
        winner_id: extra.winnerId, winner_name: extra.winnerName, claim: extra.claim, proven: extra.proven, at: Date.now() });
    } else if (type === "answer") {
      analytics.recordAnswer({ code: room.code, category: extra.category, grp: extra.grp, display: extra.display, offList: extra.offList, at: Date.now() });
    } else if (type === "event") {
      analytics.recordEvent(extra.type, room.code, extra.detail);
    } else if (type === "end") {
      const g = room.game; if (!g) return;
      const [a, b] = g.order;
      analytics.recordGame({ code: room.code,
        p1_id: a, p1_name: g.names[a], p1_score: g.scores[a] || 0,
        p2_id: b, p2_name: g.names[b], p2_score: g.scores[b] || 0,
        winner_id: extra.winnerId || null, winner_name: extra.winnerId ? g.names[extra.winnerId] : null,
        groups: (g.groups || []).join(","), timer: g.timer, target: g.target === Infinity ? "endless" : String(g.target),
        rounds: g.round, reason: extra.reason || "win",
        started_at: g.startedAt || null, ended_at: Date.now(), duration_ms: g.startedAt ? Date.now() - g.startedAt : null });
    }
  } catch (e) { console.error("reporter:", e.message); }
});

// Default page is Multiplayer; single-player lives at /index.html.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "mp.html")));

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
  const rec = h.recent.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.p1_name)} ${num(r.p1_score)}–${num(r.p2_score)} ${esc(r.p2_name)}</td><td>${esc(r.winner_name || "tie")}</td><td>${num(r.rounds)}r</td><td>${esc(r.reason)}</td><td>${fmtMs(num(r.duration_ms))}</td></tr>`).join("");
  const s = h.superlatives;
  const sup = [
    s.longestGame ? `Longest game: <b>${fmtMs(num(s.longestGame.duration_ms))}</b> (${esc(s.longestGame.p1_name)} vs ${esc(s.longestGame.p2_name)})` : "",
    s.mostRounds ? `Most rounds: <b>${num(s.mostRounds.rounds)}</b> (${esc(s.mostRounds.p1_name)} vs ${esc(s.mostRounds.p2_name)})` : "",
    s.highestClaim ? `Highest claim: <b>${num(s.highestClaim.claim)}</b> — ${esc(s.highestClaim.category)} by ${esc(s.highestClaim.winner_name || "?")}` : "",
    `🎯 Easter eggs triggered: <b>${s.easterEggs}</b>`,
  ].filter(Boolean).map((x) => `<span class="pill">${x}</span>`).join("");
  return `
    <h2>All-time history</h2>
    <p class="stats"><b>${h.games}</b> games · <b>${h.rounds}</b> rounds · <b>${h.players}</b> unique players · avg game <b>${fmtMs(h.avgDurationMs)}</b></p>
    <div class="pills">${sup}</div>
    <div class="cols">
      <div><h3>🗂 Categories — plays · claim · solve%</h3>${tbl(["Category", "Plays", "Claim", "Solve%"], cat, 4)}</div>
      <div><h3>🔍 Least-explored categories</h3>${tbl(["Category", "Named", "Coverage"], cov, 3)}</div>
      <div><h3>💬 Most-named answers</h3>${tbl(["Answer", "Category", "×"], ta, 3)}</div>
      <div><h3>🕐 When people play (Eastern)</h3>${tbl(["Hour", "Games"], hourRows, 2)}</div>
      <div><h3>✨ Feature usage</h3>${tbl(["Event", "Count"], feat, 2)}</div>
      <div><h3>🏁 How games ended</h3>${tbl(["Reason", "Count"], reasons, 2)}</div>
      <div><h3>📅 Games per day</h3>${tbl(["Day", "Games"], day, 2)}</div>
      <div><h3>🕑 Recent games</h3>${tbl(["Code", "Result", "Winner", "Rds", "End", "Len"], rec, 6)}</div>
    </div>`;
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
        <a class="watch" href="/?spectate=${encodeURIComponent(r.code)}" target="_blank">👀 watch</a>
        <a class="close" href="/admin/close?key=${k}&code=${encodeURIComponent(r.code)}" onclick="return confirm('Close room ${esc(r.code)}? This kicks everyone out.')">✕ close</a></div>
      <div class="g players">${ps} &nbsp;·&nbsp; 👀 ${r.spectators}</div>
      <div class="g meta">age ${fmtDur(now - r.createdAt)} · idle ${fmtDur(now - r.lastActivityAt)}</div>
      ${gameHtml}
    </div>`;
  };
  res.set("content-type", "text/html").send(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="4">
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
    <p class="sub">🟢 <b style="color:#3ecf8e">${online}</b> online · ${list.length} room${list.length === 1 ? "" : "s"} · ${playing} in a game · auto-refreshes every 4s · ${new Date().toISOString()}</p>
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
    <p style="margin:0 0 16px"><a href="/admin/health?key=${k}" style="color:#5b8cff;text-decoration:none;font-weight:700">🩺 Category health → which answers never get named</a></p>
    <div class="grid">${list.length ? list.map(card).join("") : '<p class="sub">No active rooms right now.</p>'}</div>
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
app.get("/admin/close", (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const code = String(req.query.code || "").toUpperCase().trim();
  closeRoom(code);
  res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
});

// Owner broadcasts a banner message to EVERY connected client (e.g. a pre-deploy heads-up).
app.get("/admin/announce", (req, res) => {
  if (!ownerOk(req)) return res.status(404).send("Not found");
  const text = String(req.query.msg || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (text) { io.emit("announce", { text }); console.log(`📢 announce: ${text}`); }
  res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
});

app.use(express.static(path.join(__dirname)));

// ---------- Rooms ----------
// code -> { code, hostId, status, settings, players: Map<playerId, {id,name,socketId,connected}>, graceTimeout }
// Identity is the stable playerId (the client keeps it in sessionStorage), NOT the
// socket id — so a reconnect with a new socket re-claims the same player slot.
const rooms = new Map();
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

io.on("connection", (socket) => {
  console.log(`✅ connected: ${socket.id}`);
  online++; broadcastPresence();

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
    console.log(`👀 spectating room ${code}`);
    ack?.({ ok: true, code, you: pid, spectator: true, inGame: !!room.game });
    broadcast(room);
    if (room.game) engine.resync(io, room); // push current game state to the new spectator
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
    if (msg) io.to(room.code).emit("chat", { id: p.id, name: p.name, text: msg, spectator: !room.players.has(p.id) });
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
    online = Math.max(0, online - 1); broadcastPresence();
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
