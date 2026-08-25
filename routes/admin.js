"use strict";
// Owner-only live dashboard (gated by the OWNER_KEY secret). Reads server state directly — an
// INVISIBLE peek (doesn't join as a spectator).
//   /admin?key=YOUR_KEY        → live HTML dashboard (auto-refreshes)
//   /admin?key=YOUR_KEY&json=1 → raw JSON
const express = require("express");
const analytics = require("../server/stats"); // persistent game history (Turso)
const SITE = require("../lib/site-config");
const { ownerOk } = require("../lib/owner-auth.js");
const { FLY_COST, projectCost } = require("../lib/cost-guard.js");
const { esc, easternHour, easternTime, easternFull, easternDay, fmtHour12, fmtDur, fmtMs, bar, tbl } = require("../lib/html.js");
const { CAT_SIZES, CAT_ITEMS, CAT_GROUP } = require("../lib/category-data.js");
const { cleanName } = require("../lib/name-filter.js");

const DASH = SITE.adminDashboard;

// ── One page shell for every admin page ──────────────────────────────────────────────────────────
// The dashboard is Express-rendered HTML rather than part of the Next app, so nothing hands it a
// <head>. Each of the ten sub-pages used to carry its own hand-copied <style> and then open
// straight into <body> with no <head> at all — no charset, and crucially no viewport meta, so
// every one of them rendered at desktop width on a phone and had to be pinch-zoomed to read.
//
// The ten copies had also drifted: cell padding existed in three different values, `.dim` was
// redeclared eight times, and the sticky table header had only ever reached four of the seven
// pages that have a table. So there is one stylesheet now, and a page passes only the rules that
// are genuinely its own.
const ADMIN_CSS = `
  :root{color-scheme:dark} *{box-sizing:border-box}
  body{margin:0;background:${DASH.themeColor};color:#e8ecf4;font:14px/1.5 system-ui,sans-serif;padding:20px;
    padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right));
    padding-bottom:max(20px,env(safe-area-inset-bottom));-webkit-text-size-adjust:100%}
  a{color:${DASH.accent};text-decoration:none} a:hover{text-decoration:underline}
  h1{font-size:20px;margin:0 0 4px} h2{font-size:17px;margin:26px 0 4px}
  h3{font-size:13px;margin:14px 0 6px;color:#c6ccda}
  .sub{color:#8a92a6;font-size:13px;margin:0 0 16px} .dim{color:#8a92a6} b{color:#fff}
  .nav{margin:0 0 14px;font-size:13px} .nav a{margin-right:12px;display:inline-block;padding:4px 0}
  /* A wide table gets its own scroller rather than stretching the page: on a phone the page
     scrolling sideways moves the headings off-screen too, which loses your place entirely. */
  .tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{border-collapse:collapse;font-size:13px;width:100%}
  th{text-align:left;color:#8a92a6;font-weight:600;border-bottom:1px solid #262b38;padding:6px 9px;
    position:sticky;top:0;background:${DASH.themeColor};white-space:nowrap}
  td{padding:6px 9px;border-bottom:1px solid #1c2029;vertical-align:top;color:#dfe4ee}
  tr:hover td{background:#141823} td a{color:${DASH.accent}}
  td.t{color:#8a92a6;white-space:nowrap;font-variant-numeric:tabular-nums;width:1%}
  /* Semantic colour utilities. Every one of these was redeclared on most of the ten pages. */
  .big{color:#3ecf8e;font-weight:700} .tot{font-weight:800;color:#ffd34d} .rm{color:#e5484d;font-weight:700}
  .ok{color:#3ecf8e} .miss{color:#e5484d} .dup{color:#ffb454}
  .sp{color:#ffb454} .mp{color:#3ecf8e} .mode{font-weight:700}
  .rk{color:#8a92a6;width:22px} .sc{text-align:right;font-weight:800;color:#ffd34d}
  .bar{display:inline-block;height:8px;border-radius:2px;background:#3ecf8e;vertical-align:middle}
  .low .bar{background:#e5484d} .mid .bar{background:#ffb454}
  .tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:20px;background:#1c2230;color:#c6ccda}
  .chips span{display:inline-block;background:#1c2029;border:1px solid #2a3040;border-radius:6px;padding:2px 7px;margin:3px;font-size:12px}
  .meta{background:#141823;border:1px solid #262b38;border-radius:10px;padding:12px 14px;margin:0 0 18px;font-size:13px}
  .meta b{color:#fff}
  .card{background:#171a23;border:1px solid #262b38;border-radius:12px;padding:14px}
  .cat{background:#171a23;border:1px solid #262b38;border-radius:12px;padding:12px 14px}
  .cathd{font-weight:700;margin-bottom:8px} .cathd .dim{font-weight:400}
  input{background:#141823;border:1px solid #2a3040;border-radius:8px;color:#e8ecf4;padding:8px 11px;font-size:14px;max-width:100%}
  button{background:${DASH.accent};border:0;border-radius:8px;color:#08130d;font-weight:700;padding:9px 14px;cursor:pointer;font-size:13px}
  /* These three grids asked for a 300-340px minimum track. On a 320px phone the content box is
     ~296px, so the track was wider than its container and the whole page scrolled sideways.
     min() clamps the track to the container and the overflow goes away. */
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr))}
  .cols{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr))}
  .cats{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))}
  @media (max-width:700px){
    body{padding:12px;padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right))}
    h1{font-size:18px} h2{font-size:16px;margin:20px 0 4px}
    table{font-size:12px} th,td{padding:5px 6px}
    .grid,.cols,.cats{grid-template-columns:1fr;gap:10px}
    /* Tap targets: these are the actions, and as bare 13px links they were well under 40px. */
    .nav a,.watch,.close,.announce a.preset{padding:8px 2px;display:inline-block}
  }
`;

// The main dashboard's own rules — the room cards and the control panels, which no other page has.
const DASH_CSS = `
  .stats{color:#c6ccda;margin:0 0 18px;font-size:13px} .stats b{color:#ffd34d}
  .card.playing{border-color:#2e7d52}
  .hd{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
  .code{font-weight:900;font-size:22px;letter-spacing:3px;color:#ffd34d}
  .badge{font-size:12px;color:#8a92a6}
  .watch{margin-left:auto;color:${DASH.accent};font-weight:700;font-size:13px}
  .close{color:#e5484d;font-weight:700;font-size:13px}
  .g{font-size:13px;color:#c6ccda;margin:3px 0} .g.players{color:#fff;font-weight:600}
  .g.meta{color:#6b7382;font-size:12px;background:none;border:0;border-radius:0;padding:0;margin:3px 0}
  .g.pend{color:#ffb454}
  .pills{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
  .pill{background:#171a23;border:1px solid #262b38;border-radius:20px;padding:5px 12px;font-size:12px;color:#c6ccda}
  .announce{background:#171a23;border:1px solid #262b38;border-radius:12px;padding:12px 14px;margin:0 0 18px}
  .announce form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .announce input{flex:1;min-width:180px}
  .announce a.preset{background:#3a2030;color:#ffb4b4;border-radius:8px;padding:8px 12px;font-size:13px;font-weight:700;display:inline-block}
  .announce .lbl{font-size:12px;color:#8a92a6;margin-right:4px}
  /* The eight drill-down links. As stacked bold-blue sentences they were the largest block on the
     phone layout and buried the room cards under it; as tiles they read as the menu they are, and
     the description drops to secondary weight instead of competing with the title. */
  .tools{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));margin:0 0 20px}
  .tools a{display:block;background:#171a23;border:1px solid #262b38;border-radius:10px;padding:10px 12px}
  .tools a:hover{border-color:${DASH.accent};text-decoration:none}
  .tools b{display:block;color:#dfe4ee;font-size:13px;font-weight:700}
  .tools span{display:block;color:#8a92a6;font-size:12px;line-height:1.35;margin-top:1px}
  /* One bar per recorded probe, oldest on the left. They flex rather than sit at a fixed width so
     forty-eight of them fit a 320px phone as readily as a desktop. */
  .ups{display:flex;gap:2px;align-items:stretch;margin:8px 0 0;height:18px}
  .ups i{flex:1 1 0;min-width:2px;border-radius:2px}
`;

// `k` is the already-url-encoded owner key. It has to travel into the manifest link: every /admin
// route is gated on that key, so an installed app whose start_url lacked it would launch straight
// into a 404. See the note on `pwaAdmin` in lib/site-config.js.
//
// `refresh` turns on the self-reload the live dashboard wants. It replaces a <meta http-equiv=
// "refresh">, which also threw the page back to the top every 60 seconds — on a phone that meant
// anything below the fold was unreadable, because you could never stay scrolled to it.
const adminHead = ({ k, title = "", css = "", refresh = 0 }) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title ? `${esc(title)} · ${DASH.title}` : DASH.title}</title>
<link rel="manifest" href="/admin/manifest.webmanifest?key=${k}">
<meta name="theme-color" content="${DASH.themeColor}">
<link rel="icon" href="/admin-icon-192.png">
<link rel="apple-touch-icon" href="/admin-apple-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${SITE.pwaAdmin.shortName}">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<style>${ADMIN_CSS}${css}</style>${refresh ? `
<script>
(function(){
  try{
    var y=sessionStorage.getItem("adminY");
    if(y)addEventListener("load",function(){scrollTo(0,+y)});
    addEventListener("beforeunload",function(){sessionStorage.setItem("adminY",String(scrollY))});
  }catch(e){}
  setTimeout(function(){location.reload()},${refresh * 1000});
})();
</script>` : ""}
</head><body>`;

function gamePeek(room) {
  const g = room.game;
  if (!g) return null;
  const nameOf = (id) => g.names[id] || "?";
  const proven = (g.proven || []).map((id) => { const e = (g.current.entries || []).find((x) => x.id === id); return e ? e.display : "?"; });
  return {
    mode: "duel", phase: g.phase, round: g.round,
    category: g.current ? `${g.current.group} — ${g.current.name}` : "?",
    claim: g.claim, target: g.target === Infinity ? "∞" : g.target,
    turn: nameOf(g.turnId),
    scores: g.order.map((id) => `${nameOf(id)}: ${g.scores[id] || 0}`).join("   ·   "),
    proven, granted: (g.granted || []).map((gr) => gr.text), pending: g.pending ? [...g.pending.values()].map((p) => p.text) : [],
    paused: !!g.paused, intermission: !!g.intermission,
  };
}
// Same idea for a "Challenge Race" room (room.mode === "race") — a very different shape of
// game state (see race-engine.js), so it gets its own peek rather than being squeezed into
// gamePeek()'s duel-specific fields.
function racePeek(room) {
  const g = room.game;
  if (!g) return null;
  const nameOf = (id) => g.names[id] || "?";
  return {
    mode: "race", phase: g.phase, round: g.round,
    category: g.current ? `${g.current.group} — ${g.current.name}` : "?",
    format: g.format == null ? "endless" : `bo${g.format}`, suddenDeath: !!g.suddenDeath, isTiebreaker: !!g.isTiebreaker,
    roundWins: g.order.map((id) => `${nameOf(id)}: ${g.roundWins[id] || 0}`).join("   ·   "),
    liveScores: [...g.activeIds].map((id) => `${nameOf(id)}: ${g.liveScores[id] || 0}`).join("   ·   "),
    left: g.leftPlayers ? [...g.leftPlayers].map(nameOf) : [],
    paused: !!g.paused,
  };
}
function anyGamePeek(room) { return room.mode === "race" ? racePeek(room) : gamePeek(room); }
function runLabel(r) {
  if (String(r.challenge_id || "").startsWith("d-")) return `daily ${String(r.challenge_id).replace(/^d-/, "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}`;
  let rounds = []; try { rounds = JSON.parse(r.rounds || "[]"); } catch (e) {}
  if (rounds.length === 1) return esc(rounds[0]);
  if (r.type === "genre" && r.genre) return `${esc(r.genre)} · ${rounds.length}r`;
  return `${rounds.length} rounds`;
}

// io: the Socket.IO server. costGuard: lib/cost-guard.js's createCostGuard() instance.
// rooms/stats/serverStartedAt/getOnline/isLockdown/setLockdown/closeRoom/closeAllRooms: rooms.js's createRooms() instance.
function createAdminRouter({ io, costGuard, rooms, stats, serverStartedAt, getOnline, isLockdown, setLockdown, closeRoom, closeAllRooms }) {
  const router = express.Router();

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
      mode: room.mode || "duel",
      game: anyGamePeek(room),
    }));
  }
  // Top-of-page at-a-glance health check — meant to answer "is it the server, the DB, or my own
  // network?" in one look, without digging into the cost/bandwidth section further down.
  // Reachability, as measured from outside this process by scripts/probe.js. Everything else on
  // this dashboard is the server describing itself, which means it can never account for the one
  // period you most want explained afterwards — the stretch when it wasn't running.
  function uptimeHtml(up, now) {
    if (!up) return "";
    if (!up.last) {
      return `<div class="announce"><span class="lbl">📡 Uptime:</span> no probe has recorded anything yet.
        The <b>Uptime</b> workflow writes here every 5 minutes once OWNER_KEY, TURSO_URL and TURSO_TOKEN
        are set as repository secrets — see .github/workflows/uptime.yml.</div>`;
    }
    // Probes, not wall-clock: a scheduled runner can be late or skipped, so "23 of 24 answered" is
    // a claim this data supports where "99.6% of the last day" would quietly overstate it.
    const win = (w) => w.probes
      ? `<b>${w.up}</b>/${w.probes} probes${w.pct != null ? ` · ${w.pct >= 99.95 ? "100" : w.pct.toFixed(1)}%` : ""}${w.down ? ` · <span style="color:#e5484d">${w.down} down</span>` : ""}`
      : "<span class=\"dim\">no probes yet</span>";
    const age = fmtDur(now - up.last.at);
    const state = up.last.ok
      ? `🟢 <b>Reachable</b> <span class="dim">(${up.last.ms}ms, checked ${age} ago)</span>`
      : `🔴 <b style="color:#e5484d">UNREACHABLE</b> <span class="dim">(last checked ${age} ago)</span>`;
    // Oldest to newest, so it reads left-to-right like every other timeline here.
    const bars = up.recent.slice().reverse().map((r) =>
      `<i style="background:${r.ok ? "#3ecf8e" : "#e5484d"}" title="${easternFull(r.at)} · ${r.ok ? `up, ${r.ms}ms` : esc(r.err || "down")}"></i>`).join("");
    const fail = up.lastFail
      ? `Last failure ${fmtDur(now - up.lastFail.at)} ago — <span class="dim">${easternFull(up.lastFail.at)} · ${esc(up.lastFail.err || "no reason recorded")}</span>`
      : `<span class="dim">No failure on record.</span>`;
    return `
      <div class="announce"${up.last.ok ? "" : ' style="border-color:#e5484d;background:#2a1618"'}>
        <span class="lbl">📡 Uptime (measured from outside):</span> ${state}
        <div class="g" style="margin-top:6px">Last 24h: ${win(up.day)}${up.day.avgMs ? ` · avg ${up.day.avgMs}ms` : ""} &nbsp;·&nbsp; Last 7d: ${win(up.week)}</div>
        <div class="g meta">${fail}</div>
        <div class="ups">${bars}</div>
      </div>`;
  }

  function siteHealthHtml(dbPing, now, k) {
    const { coldTripped, hardTripped } = costGuard.getState();
    const site = isLockdown()
      ? { dot: "🔴", label: "MAINTENANCE MODE", detail: "you turned this on — players are blocked until you turn it back off" }
      : hardTripped
      ? { dot: "🔴", label: "PAUSED (cost cap)", detail: "players are getting the \"resting for the month\" page, not the real site — this is why the site can look \"down\" while /admin still works" }
      : coldTripped
      ? { dot: "🟡", label: "COLD-START MODE", detail: "machine scales to zero when idle — first visitor after a quiet spell waits ~1-3s" }
      : { dot: "🟢", label: "Serving normally", detail: "no maintenance mode, no cost-cap pause" };
    const db = !dbPing.configured
      ? { dot: "⚪", label: "Not configured", detail: "TURSO_URL/TURSO_TOKEN not set — history/leaderboards are off, but the game itself is unaffected" }
      : dbPing.ok
      ? { dot: "🟢", label: `Connected (${dbPing.ms}ms)`, detail: "" }
      : { dot: "🔴", label: "UNREACHABLE", detail: esc(dbPing.error || "query failed") };
    const upMs = now - serverStartedAt;
    const freshRestart = upMs < 5 * 60000; // booted in the last 5 minutes — worth flagging as a possible clue
    return `
      <div class="pills" style="margin-bottom:14px">
        <span class="pill">🧑‍💻 Your connection: <span id="myConn">checking…</span></span>
        <span class="pill">🌐 Website: ${site.dot} <b>${site.label}</b></span>
        <span class="pill">🗄️ Database: ${db.dot} <b>${db.label}</b></span>
        <span class="pill">🖥️ Server up: <b>${fmtDur(upMs)}</b>${freshRestart ? " ⚠️ restarted recently" : ""}</span>
        <span class="pill">🔌 Live connections: <b>${getOnline()}</b></span>
      </div>
      ${site.detail || db.detail ? `<p class="sub" style="margin:-8px 0 14px">${site.detail ? `🌐 ${site.detail}` : ""}${site.detail && db.detail ? " · " : ""}${db.detail ? `🗄️ ${db.detail}` : ""}</p>` : ""}
      <script>
        // Client-side check, independent of this page's own 60s reload — so a dropped connection
        // shows up immediately instead of waiting for the next full refresh (or looking identical
        // to "the server is down" when it's actually just this device's network).
        (function () {
          var el = document.getElementById("myConn");
          function paint(html) { el.innerHTML = html; }
          function check() {
            if (!navigator.onLine) { paint("🔴 <b>Offline</b> — your browser reports no network"); return; }
            var start = performance.now();
            fetch("/admin/ping?key=${k}", { cache: "no-store" }).then(function (r) {
              if (!r.ok) throw new Error("bad status");
              var ms = Math.round(performance.now() - start);
              paint(ms > 800 ? "🟡 <b>Slow</b> (" + ms + "ms to reach the server)" : "🟢 <b>Connected</b> (" + ms + "ms)");
            }).catch(function () { paint("🔴 <b>Can't reach the server</b> from this browser right now"); });
          }
          check();
          setInterval(check, 10000);
          window.addEventListener("online", check);
          window.addEventListener("offline", check);
        })();
      </script>`;
  }
  function costHtml(bw, now, k) {
    if (!bw) return "";
    const { coldTripped, hardTripped, coldError, costOverrideMonth } = costGuard.getState();
    const p = projectCost(bw, now);
    const color = p.projTotal >= FLY_COST.stopThreshold ? "#e5484d" : p.projTotal >= FLY_COST.coldThreshold ? "#ffb454" : "#3ecf8e";
    const fmtGB = (x) => x >= 1 ? x.toFixed(2) + " GB" : (x * 1000).toFixed(1) + " MB";
    const dayMax = Math.max(1, ...bw.perDay.map((r) => Number(r.bytes) || 0));
    const dayRows = bw.perDay.map((r) => `<tr><td>${esc(r.day)}</td><td>${bar(Number(r.bytes) || 0, dayMax)} ${fmtGB((Number(r.bytes) || 0) / 1e9)}</td><td>${Number(r.reqs) || 0}</td></tr>`).join("");
    const overridden = costOverrideMonth === p.month;
    const overrideLink = `<a class="preset" style="background:#1d3a26;color:#8ef0b4" href="/admin/cost-override?key=${k}&on=1" onclick="return confirm('Keep the game fully LIVE (always-on, no traffic pause) for the rest of this billing cycle and accept going over \\$${FLY_COST.stopThreshold}? The auto caps won\\'t fire again until next month.')">▶ Override — keep live this cycle</a>`;
    const coldErrHtml = coldError ? `<br><span style="color:#e5484d;font-size:12px">⚠ couldn't apply: ${esc(coldError)} — check FLY_API_TOKEN / FLY_APP_NAME</span>` : "";
    const guard = hardTripped
      ? `<div class="announce" style="border-color:#e5484d;background:#2a1618"><b style="color:#e5484d">● AUTO COST-CAP TRIPPED</b> — projected $${p.projTotal.toFixed(2)} ≥ $${FLY_COST.stopThreshold.toFixed(2)}. Heavy traffic is paused (visitors see a "resting for the month" page) to cap egress. Clears next cycle. ${overrideLink}</div>`
      : overridden
      ? `<div class="announce" style="border-color:#ffb454"><b style="color:#ffb454">⚠ Auto cost-cap OVERRIDDEN for ${esc(p.month)}</b> — it won't revert to cold starts or pause the game this cycle even past $${FLY_COST.stopThreshold.toFixed(2)}. <a class="preset" href="/admin/cost-override?key=${k}&on=0">Re-arm the cap</a></div>`
      : coldTripped
      ? `<div class="announce" style="border-color:#ffb454"><b style="color:#ffb454">● COLD-START MODE</b> — projected $${p.projTotal.toFixed(2)} ≥ $${FLY_COST.coldThreshold.toFixed(2)}. The machine reverted to scale-to-zero to cut compute cost (visitors may see a ~1-3s cold start on the next request after idle). Game stays fully live. Escalates to a full pause at $${FLY_COST.stopThreshold.toFixed(2)}.${coldErrHtml} ${overrideLink}</div>`
      : `<div class="announce" style="border-color:#2e7d52"><b style="color:#8ef0b4">● Auto cost-cap armed</b> — at $${FLY_COST.coldThreshold.toFixed(2)} projected, the machine reverts to scale-to-zero (cold starts); at $${FLY_COST.stopThreshold.toFixed(2)} it also pauses heavy traffic. Both clear automatically next cycle. No action needed from you.</div>`;
    return `
      <h2>💸 Cost & bandwidth <span style="font-size:12px;color:#8a92a6;font-weight:400">— projected from this cycle's egress</span></h2>
      ${guard}
      <div class="pills">
        <span class="pill">📈 Projected month-end: <b style="color:${color};font-size:15px">$${p.projTotal.toFixed(2)}</b> <span style="color:#8a92a6">/ $${FLY_COST.coldThreshold.toFixed(2)} cold · $${FLY_COST.stopThreshold.toFixed(2)} stop</span></span>
        <span class="pill">🖥 Compute (always-on): <b>$${FLY_COST.computePerMo.toFixed(2)}</b>/mo fixed</span>
        <span class="pill">🌐 Egress this cycle: <b>${fmtGB(p.gb)}</b> → proj <b>${fmtGB(p.projGB)}</b> ≈ <b>$${p.egressProj.toFixed(2)}</b></span>
        <span class="pill">💵 Accrued so far: <b>$${p.soFar.toFixed(2)}</b> · ${bw.monthReqs} reqs</span>
      </div>
      <p class="stats" style="font-size:12px;color:#6b7382;margin:-6px 0 10px">Estimated rates (shared-cpu-1x 256MB ≈ $${FLY_COST.computePerMo}/mo, egress ≈ $${FLY_COST.egressPerGB}/GB — confirm current Fly pricing). Compute assumes always-on; once in cold-start mode actual compute cost is likely lower than shown. Map atlases load from a CDN, so they don't count. Extra machines / volumes aren't included.</p>
      <div class="cols"><div><h3>🌐 Egress per day (UTC)</h3>${tbl(["Day", "Bytes sent", "Reqs"], dayRows, 3)}</div></div>`;
  }
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
    // Where visitors come from. `(h.referrals || [])` is not defensive decoration: summary() is
    // absent entirely with no Turso configured, and referral labels only exist for sessions
    // recorded since the columns were added.
    const refs = h.referrals || [];
    const refMax = Math.max(1, ...refs.map((r) => num(r.n)));
    // Sessions get the bar (matching the hour histogram next door); played is the column that
    // actually answers "does this channel deliver players", so it carries the conversion rate.
    const refRows = refs.map((r) => `<tr><td>${esc(r.source)}</td><td>${bar(num(r.n), refMax)} ${num(r.n)}</td><td>${num(r.visitors)}</td><td>${num(r.played)}${num(r.n) ? ` <span style="color:#8a92a6">(${Math.round(num(r.played) / num(r.n) * 100)}%)</span>` : ""}</td></tr>`).join("");
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
        <div><h3>🌐 Where visitors come from</h3>${tbl(["Channel", "Sessions", "Visitors", "Played"], refRows, 4)}</div>
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

  // Trivial round-trip target for the dashboard's "Your connection" client-side check — no DB, no
  // room data, as cheap as a request can be so it's a clean measure of the browser↔server hop alone.
  router.get("/admin", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const now = Date.now();
    const list = adminData();
    if (req.query.json) {
      const hist = analytics.enabled() ? await analytics.summary().catch(() => null) : null;
      const bw = analytics.enabled() ? await analytics.bandwidthStats().catch(() => null) : null;
      const dbPing = await analytics.ping().catch(() => ({ configured: false, ok: false }));
      const up = analytics.enabled() ? await analytics.uptimeStats().catch(() => null) : null;
      // `uptimeMs` is how long THIS process has been up; `uptime` is what an outside prober saw,
      // which is the only one of the two that can describe a period the process wasn't running.
      return res.json({ now, uptimeMs: now - serverStartedAt, online: getOnline(), stats, history: hist, bandwidth: bw, roomCount: list.length, rooms: list, db: dbPing, uptime: up, costGuard: costGuard.getState(), lockdown: isLockdown() });
    }
    const hist = analytics.enabled() ? await analytics.summary().catch(() => null) : null;
    const bw = analytics.enabled() ? await analytics.bandwidthStats().catch(() => null) : null;
    const dbPing = await analytics.ping().catch(() => ({ configured: false, ok: false }));
    const up = analytics.enabled() ? await analytics.uptimeStats().catch(() => null) : null;
    const playing = list.filter((r) => r.status === "playing").length;
    const k = encodeURIComponent(req.query.key || "");
    const card = (r) => {
      const ps = r.players.map((p) => `${esc(p.name)}${p.host ? " 👑" : ""}${p.connected === false ? " (reconnecting…)" : ""}`).join(" vs ") || "—";
      const g = r.game;
      const gameHtml = !g ? `<div class="g">In the waiting room.</div>`
        : g.mode === "race" ? `
        <div class="g"><b>${esc(g.category)}</b> · round ${g.round} · phase <b>${esc(g.phase)}</b>${g.paused ? " · ⏸ paused" : ""}${g.isTiebreaker ? " · 🔥 sudden death" : ""}</div>
        <div class="g">Format: ${esc(g.format)}${g.suddenDeath ? " (sudden death on)" : ""}</div>
        <div class="g">Round wins: ${esc(g.roundWins)}</div>
        <div class="g">Live scores: ${esc(g.liveScores)}</div>
        ${g.left.length ? `<div class="g">Left the race: ${esc(g.left.join(", "))}</div>` : ""}
      ` : `
        <div class="g"><b>${esc(g.category)}</b> · round ${g.round} · phase <b>${esc(g.phase)}</b>${g.paused ? " · ⏸ paused" : ""}</div>
        <div class="g">Score: ${esc(g.scores)} &nbsp; (first to ${esc(g.target)})</div>
        <div class="g">Claim: <b>${g.claim}</b> · current turn: <b>${esc(g.turn)}</b></div>
        <div class="g">Proven (${g.proven.length}): ${g.proven.length ? esc(g.proven.join(", ")) : "—"}</div>
        ${g.granted.length ? `<div class="g">Granted off-list: ${esc(g.granted.join(", "))}</div>` : ""}
        ${g.pending.length ? `<div class="g pend">Awaiting ruling: ${esc(g.pending.join(", "))}</div>` : ""}
      `;
      return `<div class="card ${r.status}">
        <div class="hd"><span class="code">${esc(r.code)}</span><span class="badge">${r.status === "playing" ? "🟢 playing" : "🟡 lobby"}</span><span class="badge">${r.mode === "race" ? "🏁 race" : "⚔️ duel"}</span>
          <a class="watch" href="/?ghost=${encodeURIComponent(r.code)}&key=${k}" target="_blank">👻 ghost</a>
          <a class="watch" href="/?spectate=${encodeURIComponent(r.code)}" target="_blank">👀 watch</a>
          <a class="close" href="/admin/close?key=${k}&code=${encodeURIComponent(r.code)}" onclick="return confirm('Close room ${esc(r.code)}? This kicks everyone out.')">✕ close</a></div>
        <div class="g players">${ps} &nbsp;·&nbsp; 👀 ${r.spectators}</div>
        <div class="g meta">age ${fmtDur(now - r.createdAt)} · idle ${fmtDur(now - r.lastActivityAt)}</div>
        ${gameHtml}
      </div>`;
    };
    res.set("content-type", "text/html").send(`${adminHead({ k, css: DASH_CSS, refresh: 60 })}
      <h1>${SITE.adminDashboard.heading}</h1>
      <p class="sub">🟢 <b style="color:#3ecf8e">${getOnline()}</b> online · ${list.length} room${list.length === 1 ? "" : "s"} · ${playing} in a game · auto-refreshes every 60s · ${easternFull(now)}</p>
      ${siteHealthHtml(dbPing, now, k)}
      ${uptimeHtml(up, now)}
      <p class="stats">Since restart (${fmtDur(now - serverStartedAt)} ago): <b>${stats.roomsCreated}</b> rooms created · <b>${stats.gamesStarted}</b> games started · peak <b>${stats.peakRooms}</b> concurrent rooms</p>
      ${costHtml(bw, now, k)}
      <div class="announce">
        <form action="/admin/announce" method="get">
          <span class="lbl">📢 Broadcast to all games:</span>
          <input type="hidden" name="key" value="${k}"><input name="msg" maxlength="200" placeholder="Type a message to every player…" autocomplete="off">
          <button>Send</button>
          <a class="preset" href="/admin/announce?key=${k}&msg=${encodeURIComponent("⚠️ Server updating in ~1 minute — finish your round!")}">⚠️ 1-min restart</a>
          <a class="preset" href="/admin/announce?key=${k}&msg=${encodeURIComponent("⚠️ Server updating in ~5 minutes — wrap up soon!")}">⚠️ 5-min restart</a>
        </form>
      </div>
      <div class="announce" style="${isLockdown() ? "border-color:#e5484d;background:#2a1618" : ""}">
        <span class="lbl">🔌 Server control:</span>
        <a class="preset" href="/admin/killall?key=${k}" onclick="return confirm('End ALL active games right now and kick everyone?')">🛑 End all games now</a>
        ${isLockdown()
          ? `<b style="color:#e5484d">● MAINTENANCE MODE — game is DOWN</b> <a class="preset" style="background:#1d3a26;color:#8ef0b4" href="/admin/lockdown?key=${k}&on=0">✅ Bring the game back ON</a>`
          : `<a class="preset" style="background:#3a2030;color:#ffb4b4" href="/admin/lockdown?key=${k}&on=1" onclick="return confirm('Take the game DOWN for maintenance? Kicks everyone, ends all games, and blocks new games (solo + multiplayer) until you toggle it back on.')">🔧 Take game down (maintenance)</a>`}
      </div>
      <div class="tools">${[
        ["health", "🩺 Category health", "which answers never get named"],
        ["games", "🎞 Game history", "drill into any past game — every guess, chat and exact timestamp"],
        ["chat", "💬 All chat", "every message across the whole server, searchable"],
        ["leaderboards", "🏆 Leaderboards", "moderate entries — rename or remove junk and abusive names"],
        ["merge", "🔗 Merge players", "one person showing up twice? fold their entries into one"],
        ["category-leaderboards", "🥇 Category leaderboards", "per-category top solo scores, before they go public"],
        ["runs", "🏃 Solo & daily runs", "drill into any run — every hit, miss and repeat"],
        ["sessions", "🕒 Recent sessions", "every visit — arrival, stay, device, location, timezone"],
        ["visitors", "🧭 Visitors", "repeat visitors, IP, location and timezone"],
      ].map(([slug, name, desc]) => `<a href="/admin/${slug}?key=${k}"><b>${name}</b><span>${desc}</span></a>`).join("")}</div>
      <div class="grid">${list.length ? list.map(card).join("") : '<p class="sub">No active rooms right now.</p>'}</div>
      ${(() => { const live = liveSessions(); return `<h2>🌐 Live connections (${live.length})</h2>${tbl(["Connected for", "Name", "Doing", "Device"],
        live.map((s) => `<tr><td>${fmtDur(now - s.connectedAt)}</td><td>${esc(s.name || "—")}</td><td>${s.role}${s.room ? " · " + esc(s.room) : ""}</td><td>${s.device}</td></tr>`).join(""), 4)}`; })()}
      ${histHtml(hist, k)}
      </body></html>`);
  });

  // Category health: per-category coverage, and the "never-named" answer list (which entries nobody ever gets).
  router.get("/admin/health", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const head = adminHead({ k, title: "Category health" });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Category health</h1><p class="sub">Persistence not configured.</p></body>`);
    const named = new Map();
    (await analytics.namedDisplays().catch(() => [])).forEach((r) => { if (!named.has(r.category)) named.set(r.category, new Set()); named.get(r.category).add(r.display); });
    const cat = String(req.query.cat || "");

    if (cat && CAT_ITEMS[cat]) { // single-category drill-down: the never-named list
      const set = named.get(cat) || new Set();
      const never = CAT_ITEMS[cat].filter((d) => !set.has(d));
      const got = CAT_ITEMS[cat].filter((d) => set.has(d));
      return res.set("content-type", "text/html").send(`${head}${back}
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
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>🩺 Category health</h1>
      <p class="sub">Coverage = share of a category's answers that have been named at least once. Low coverage may mean the category is too obscure, mis-spelled, or just under-played. Click one to see exactly which answers never get named.</p>
      <div class="tw"><table><tr><th>Category</th><th>Group</th><th>Named</th><th>Coverage</th></tr>${tr}</table></div>
      </body>`);
  });

  // Owner closes a room (kicks everyone, clears timers). Redirects back to the dashboard.
  // 🎞 Game history — list of every finished game (mp + sp), newest first.
  router.get("/admin/games", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const num = (x) => Number(x || 0);
    const head = adminHead({ k, title: "Game history" });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Game history</h1><p class="sub">Persistence not configured.</p></body>`);
    const games = await analytics.gamesList(100).catch(() => []);
    const rows = games.map((g) => {
      const mode = g.mode === "sp" ? `<span class="mode sp">🤖 solo</span>` : `<span class="mode mp">🆚 mp</span>`;
      const score = `${esc(g.p1_name || "?")} <b>${num(g.p1_score)}–${num(g.p2_score)}</b> ${esc(g.p2_name || "?")}`;
      const link = g.gid ? `<a href="/admin/game?key=${k}&gid=${encodeURIComponent(g.gid)}">open →</a>` : `<span style="color:#566">— (older game)</span>`;
      return `<tr><td>${easternFull(num(g.started_at || g.ended_at))}</td><td>${mode}</td><td>${score}</td><td>${esc(g.winner_name || "tie")}</td><td>${num(g.rounds)}</td><td>${esc(g.difficulty || "")}</td><td>${fmtMs(num(g.duration_ms))}</td><td>${link}</td></tr>`;
    }).join("");
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>🎞 Game history</h1>
      <p class="sub">Every finished game, newest first. Click <b>open →</b> to replay the full timeline — every guess, chat message, and exact timestamp. (Only games played after this feature shipped have a timeline.)</p>
      <div class="tw"><table><tr><th>When (ET)</th><th>Mode</th><th>Score</th><th>Winner</th><th>Rounds</th><th>Diff</th><th>Length</th><th></th></tr>${rows}</table></div>
      </body>`);
  });

  // 🔎 Single game — full chronological timeline: rounds, every answer (who/what/when), chat, events.
  router.get("/admin/game", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const num = (x) => Number(x || 0);
    const clock = (ts) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(ts)); } catch { return ""; } };
    const head = adminHead({ k, title: "Game", css: `
      tr.round td{background:#16203a} tr.chat td{background:#1a1726} tr.event td{color:#8a92a6}
    ` });
    const back = `<a href="/admin/games?key=${k}">← back to game history</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Game</h1><p class="sub">Persistence not configured.</p></body>`);
    const d = await analytics.gameDetail(String(req.query.gid || "")).catch(() => null);
    if (!d || !d.game) return res.set("content-type", "text/html").send(`${head}${back}<h1>Game not found</h1><p class="sub">No game with that id (only games played after this feature shipped have a timeline).</p></body>`);
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
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>${esc(g.p1_name || "?")} ${num(g.p1_score)}–${num(g.p2_score)} ${esc(g.p2_name || "?")}</h1>
      <p class="sub">${mode} · winner: <b>${esc(g.winner_name || "tie")}</b> (${esc(g.reason || "")})</p>
      <div class="meta">
        <div>🕐 Started <b>${easternFull(num(g.started_at))}</b> · ended <b>${easternFull(num(g.ended_at))}</b> · lasted <b>${fmtMs(num(g.duration_ms))}</b></div>
        <div>🎚 ${num(g.rounds)} rounds · timer ${esc(String(g.timer))}s · first to ${esc(String(g.target))}${g.difficulty ? ` · bot: <b>${esc(g.difficulty)}</b>` : ""}</div>
        <div>🗂 Categories enabled: <span class="dim">${esc(g.groups || "—")}</span></div>
      </div>
      <div class="tw"><table>${tl}</table></div>
      </body>`);
  });

  // 💬 Server-wide chat feed (newest first) with a name/keyword search.
  router.get("/admin/chat", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const num = (x) => Number(x || 0);
    const search = String(req.query.q || "").slice(0, 60);
    const head = adminHead({ k, title: "All chat" });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>All chat</h1><p class="sub">Persistence not configured.</p></body>`);
    const rows = (await analytics.allChat(300, search).catch(() => [])).map((c) =>
      `<tr><td class="t">${easternFull(num(c.at))}</td><td><b>${esc(c.name || "?")}${c.spectator ? " 👀" : ""}</b> <span class="dim">${c.gid ? `<a href="/admin/game?key=${k}&gid=${encodeURIComponent(c.gid)}">${esc(c.code || "")}</a>` : esc(c.code || "lobby")}</span></td><td>${esc(c.text || "")}</td></tr>`).join("");
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>💬 All chat</h1>
      <p class="sub">Every chat message across the whole server, newest first. Click a room code to open that game's full timeline.</p>
      <form method="get"><input type="hidden" name="key" value="${k}"><input name="q" placeholder="search name or message…" value="${esc(search)}" autofocus><button>Search</button>${search ? ` <a href="/admin/chat?key=${k}">clear</a>` : ""}</form>
      <div class="tw"><table>${rows || `<tr><td class="dim">No messages${search ? " match that search" : " yet"}.</td></tr>`}</table></div>
      </body>`);
  });

  // 🧭 Visitors — repeat-visitor rollup keyed by the persistent anonymous device id.
  router.get("/admin/visitors", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const num = (x) => Number(x || 0);
    const head = adminHead({ k, title: "Visitors" });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Visitors</h1><p class="sub">Persistence not configured.</p></body>`);
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
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>🧭 Visitors</h1>
      <p class="sub">Grouped by a persistent anonymous device id (localStorage). <b>${repeat}</b> of ${list.length} have visited more than once. Names are self-entered and unverified; IP/location come from the network.</p>
      <div class="tw"><table><tr><th>Visits</th><th>Names used</th><th>Location</th><th>IP</th><th>Device</th><th>Played/Joined</th><th>First seen</th><th>Last seen</th></tr>${rows || `<tr><td class="dim" colspan="8">No visitors recorded yet.</td></tr>`}</table></div>
      </body>`);
  });

  // Full recent-sessions log: every visit with all the detail we capture (newest first).
  router.get("/admin/sessions", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const num = (x) => Number(x || 0);
    const n = Math.min(2000, Math.max(50, parseInt(req.query.n, 10) || 300));
    const head = adminHead({ k, title: "Recent sessions" });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Sessions</h1><p class="sub">Persistence not configured.</p></body>`);
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
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>🕒 Recent sessions</h1>
      <p class="sub">Every visit, newest first — arrival time, how long they stayed, what they did, device, location/IP, timezone & locale. Showing <b>${list.length}</b> · <b>${repeatVisitors}</b> repeat visitors in this window.</p>
      <p class="nav">Show: <a href="/admin/sessions?key=${k}&n=100">100</a><a href="/admin/sessions?key=${k}&n=300">300</a><a href="/admin/sessions?key=${k}&n=1000">1000</a> · <a href="/admin/visitors?key=${k}">group by visitor →</a></p>
      <div class="tw"><table><tr><th>Arrived (ET)</th><th>Stayed</th><th>Did</th><th>Name</th><th>Device</th><th>Location / IP</th><th>TZ / Locale</th><th>Visitor</th></tr>${rows || `<tr><td class="dim" colspan="8">No sessions recorded yet.</td></tr>`}</table></div>
      </body>`);
  });

  // Leaderboard moderation: list recent entries, each with a one-click remove and a rename
  // (for junk/abusive self-entered names). Rename exists because removal is the blunt instrument —
  // a real score under an unusable name shouldn't have to be thrown away to clean up the board.
  //
  // Both actions are plain GET links with a confirm(), which is the convention here for a reason:
  // server/index.js mounts only express.json(), so a <form method="post"> body would arrive
  // unparsed. The key travels in the query string like every other /admin link.
  const LB_CSS = `
  .rn{color:#7aa2ff;font-weight:700} td.act{white-space:nowrap} td.act a{margin-right:10px}
  .aud{font-size:12px} .aud .was{color:#8a92a6;text-decoration:line-through}
`;
  router.get("/admin/leaderboards", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const num = (x) => Number(x || 0);
    const head = adminHead({ k, title: "Leaderboards", css: LB_CSS });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Leaderboards</h1><p class="sub">Persistence not configured.</p></body>`);
    const [list, audit] = await Promise.all([
      analytics.recentResults(300).catch(() => []),
      analytics.nameAuditList(25).catch(() => []),
    ]);
    const label = (r) => String(r.challenge_id || "").startsWith("d-")
      ? `<span class="tag">daily</span> ${esc(String(r.challenge_id).replace(/^d-/, "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"))}`
      : `<span class="tag">${esc(r.type || "challenge")}</span> ${esc(r.genre || r.challenge_id || "")}`;
    // The name and visitor id go into data-* attributes rather than into an inline onclick: a name
    // is player-supplied text, and hand-escaping it for a JS string literal nested inside an HTML
    // attribute is how an apostrophe (or a quote) breaks the handler for every row on the page.
    // esc() covers the attribute; the script reads the value back as data, never as code.
    const rows = list.map((r) => `<tr>
        <td class="dim">${easternTime(num(r.at))}</td>
        <td>${label(r)}</td>
        <td><b>${esc(r.name || "?")}</b><br><span class="dim" style="font-size:11px">${esc(String(r.visitor_id || "").slice(0, 12))}</span></td>
        <td class="tot">${num(r.total)}</td>
        <td class="act">
          <a class="rn" href="#" data-id="${num(r.id)}" data-name="${esc(r.name || "")}" data-v="${esc(String(r.visitor_id || "").slice(0, 12))}" data-has-v="${r.visitor_id ? 1 : 0}">✎ rename</a>
          <a class="rm" href="/admin/result-delete?key=${k}&id=${num(r.id)}" data-del="${esc(r.name || "?")}" data-tot="${num(r.total)}">✕ remove</a>
        </td>
      </tr>`).join("");
    const auditRows = audit.map((a) => `<tr>
        <td class="dim">${easternTime(num(a.at))}</td>
        <td><span class="was">${esc(a.old_name || "(blank)")}</span> → <b>${esc(a.new_name || "")}</b></td>
        <td class="dim">${a.scope === "visitor" ? `all of ${esc(String(a.visitor_id || "").slice(0, 12))}` : `row ${num(a.row_id)}`}</td>
        <td class="dim">${num(a.rows)} ${num(a.rows) === 1 ? "entry" : "entries"}</td>
      </tr>`).join("");
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>🏆 Leaderboard entries</h1>
      <p class="sub">Newest ${list.length} entries across daily + link challenges. <b>Rename</b> keeps the score and changes only the
        displayed name; <b>remove</b> deletes the entry permanently. A rename offers to cover every entry that visitor ever
        submitted, on every board — and is logged below with the name it replaced, so it can be put back.</p>
      <div class="tw"><table><tr><th>When (ET)</th><th>Board</th><th>Name</th><th>Score</th><th></th></tr>${rows || `<tr><td class="dim" colspan="5">No entries yet.</td></tr>`}</table></div>
      <h2>Rename history</h2>
      <p class="sub">The last ${audit.length} renames made from here. Renaming overwrites the name in place, so this is the only
        record of what it used to be. Note that separate entries renamed to the same name stay separate rows on the public
        boards — only the 👑 crown merges them.</p>
      <div class="tw"><table class="aud"><tr><th>When (ET)</th><th>Change</th><th>Scope</th><th>Affected</th></tr>${auditRows || `<tr><td class="dim" colspan="4">No renames yet.</td></tr>`}</table></div>
      <script>
      (function(){
        var K = ${JSON.stringify(String(req.query.key || ""))};
        document.addEventListener("click", function(e){
          var rn = e.target.closest && e.target.closest("a.rn");
          if (rn) {
            e.preventDefault();
            var was = rn.dataset.name || "";
            var to = prompt("Rename \\u201c" + (was || "(blank)") + "\\u201d to:", was);
            if (to === null) return;
            to = to.trim();
            if (!to || to === was) return;
            // Cancel is the narrow option on purpose: dismissing a scope prompt should do the
            // smaller thing, never the bulk one.
            var wide = rn.dataset.hasV === "1" && confirm(
              "Rename EVERY entry by visitor " + rn.dataset.v + " to \\u201c" + to + "\\u201d?\\n\\n" +
              "OK = all of their entries, on every board.\\nCancel = only this one entry.");
            location.href = "/admin/result-rename?key=" + encodeURIComponent(K)
              + "&id=" + encodeURIComponent(rn.dataset.id)
              + "&to=" + encodeURIComponent(to)
              + "&scope=" + (wide ? "visitor" : "row");
            return;
          }
          var rm = e.target.closest && e.target.closest("a.rm");
          if (rm && !confirm("Remove " + rm.dataset.del + " (" + rm.dataset.tot + ") from this leaderboard?")) e.preventDefault();
        });
      })();
      </script>
      </body>`);
  });
  router.get("/admin/result-delete", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const rowId = parseInt(req.query.id, 10);
    if (rowId && analytics.enabled()) await analytics.deleteResult(rowId).catch(() => {});
    res.redirect(`/admin/leaderboards?key=${encodeURIComponent(req.query.key || "")}`);
  });
  // Rename an entry (or every entry by the same visitor). Owner-gated, so unlike the player's own
  // rename in routes/challenge.js this needs no proof of identity — which is exactly why
  // analytics.adminRename writes an audit row carrying the previous name.
  router.get("/admin/result-rename", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const rowId = parseInt(req.query.id, 10);
    // Same trim/cap/profanity gate a player's own name goes through, so a name typed here can't
    // land in a column a normal submission could never produce. cleanName() substitutes "Anon"
    // for a blocked name rather than refusing — for a moderation tool that is the right direction.
    const to = cleanName(String(req.query.to || "").slice(0, 24));
    const scope = req.query.scope === "visitor" ? "visitor" : "row";
    if (rowId && analytics.enabled()) {
      await analytics.adminRename({ rowId, scope, name: to, by: "admin" }).catch(() => {});
    }
    res.redirect(`/admin/leaderboards?key=${k}`);
  });

  // ── Merge two players into one ────────────────────────────────────────────────────────────────
  // There are no accounts: a player on the boards IS a visitor_id, minted per browser. So one
  // person is two entries as soon as they play on their phone and their laptop, and a third after
  // clearing site data. Merging reassigns one visitor's entries to another, which is the key the
  // boards group by — renaming can't do it, because since the crown fix a shared display name
  // confers nothing.
  //
  // A real <form method="get"> here rather than the prompt()/confirm() pattern the rename uses: this
  // takes two identities plus an optional name, and picking two things out of a list of visitors is
  // not something a sequence of prompts can do well. GET because only express.json() is mounted
  // (server/index.js), so a POST body would arrive unparsed.
  const MERGE_CSS = `
  .mf{background:#151822;border:1px solid #262b38;border-radius:12px;padding:14px;margin:0 0 18px}
  .mf label{display:block;font-size:12px;color:#8a92a6;margin:10px 0 4px;font-weight:600}
  .mf select,.mf input{width:100%;background:#0e1016;color:#e8ecf4;border:1px solid #2e3444;
    border-radius:8px;padding:9px 10px;font:14px/1.3 system-ui,sans-serif;min-height:40px}
  .mf button{margin-top:14px;width:100%;min-height:44px;background:${DASH.accent};color:#0b0d12;
    border:0;border-radius:8px;font:700 15px system-ui,sans-serif;cursor:pointer}
  .mf button:disabled{opacity:.45;cursor:not-allowed}
  .mf .hint{color:#8a92a6;font-size:12px;margin:6px 0 0}
  /* Side by side once there is room; stacked on a phone, where two selects in a row would each be
     too narrow to read a visitor label in. */
  .mpair{display:grid;gap:10px}
  @media (min-width:641px){.mpair{grid-template-columns:1fr 1fr;gap:14px}}
  .undone{color:#8a92a6}
  .rn{color:#7aa2ff;font-weight:700} .aud{font-size:12px}
`;
  // One <option> label has to carry everything needed to tell two visitors apart: what they have
  // called themselves, how many entries they have, their best score and when they last played.
  const visitorLabel = (v) => {
    const names = String(v.names || "").split(",").filter(Boolean);
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
    const n = Number(v.entries || 0);
    return `${v.crown ? "👑 " : ""}${shown || "(no name)"} — ${n} ${n === 1 ? "entry" : "entries"}, best ${Number(v.best || 0)}, last ${easternDay(Number(v.last_at || 0))} · ${String(v.visitor_id || "").slice(0, 12)}`;
  };
  // A name's option has to answer the one question that decides whether merging it is safe: how many
  // separate browsers are using it. One means it is a person; several means either their own devices
  // or two different people, and only the owner can tell which.
  const nameLabel = (n) => {
    const e = Number(n.entries || 0), v = Number(n.visitors || 0);
    return `${n.crown ? "👑 " : ""}${n.name} — ${e} ${e === 1 ? "entry" : "entries"} from ${v} ${v === 1 ? "browser" : "browsers"}, best ${Number(n.best || 0)}, last ${easternDay(Number(n.last_at || 0))}`;
  };
  router.get("/admin/merge", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const head = adminHead({ k, title: "Merge players", css: MERGE_CSS });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Merge players</h1><p class="sub">Persistence not configured.</p></body>`);
    const [people, history, names, crownHistory] = await Promise.all([
      analytics.resultVisitors(200).catch(() => []),
      analytics.mergeAuditList(25).catch(() => []),
      analytics.resultNames(300).catch(() => []),
      analytics.crownAuditList(25).catch(() => []),
    ]);
    // `done` reports the outcome of the merge that redirected back here. Without it the page looks
    // identical whether the merge moved forty entries or was refused, which for an operation this
    // destructive is not good enough.
    const done = (() => {
      const r = String(req.query.done || "");
      if (!r) return "";
      const n = parseInt(req.query.n, 10) || 0;
      const msg = {
        merged: `✅ Merged — ${n} ${n === 1 ? "entry" : "entries"} moved. The boards now show them as one player.`,
        "merged-names": `✅ Merged — ${n} ${n === 1 ? "entry" : "entries"} now belong to one player under one name.`,
        undone: `↩️ Put back — ${n} ${n === 1 ? "entry" : "entries"} returned to the player they came from.`,
        crowned: `✅ Crowned — ${n} ${n === 1 ? "entry" : "entries"} now show with 👑, same as the rest of that player's history.`,
        same: "⚠️ Nothing done: those are the same player. Pick two different ones.",
        "same-name": "⚠️ Nothing done: those are the same name. Pick two different ones.",
        missing: "⚠️ Nothing done: pick a player on both sides.",
        "missing-name": "⚠️ Nothing done: pick a name on both sides.",
        "nothing-to-merge": "⚠️ Nothing done: that player has no entries to move.",
        "nothing-to-crown": "⚠️ Nothing done: that player is already crowned everywhere.",
        "too-many": "⚠️ Nothing done: that player has more entries than one merge will move at once.",
        "already-undone": "⚠️ Nothing done: that merge has already been put back.",
        "not-found": "⚠️ Nothing done: no record of that merge.",
        "no-snapshot": "⚠️ Can't put that one back — it has no record of which entries moved.",
        "write-failed": "⚠️ The database refused the write. Nothing changed; try again.",
      }[r] || "⚠️ Nothing done.";
      const bad = !["merged", "merged-names", "undone", "crowned"].includes(r);
      return `<p class="sub" style="color:${bad ? "#ffb4b4" : "#8ef0b4"};font-weight:600">${esc(msg)}</p>`;
    })();
    const options = people.map((v) => `<option value="${esc(v.visitor_id)}">${esc(visitorLabel(v))}</option>`).join("");
    // `data-visitors` is read by the form script to warn when a name covers more than one player.
    const nameOptions = names.map((n) => `<option value="${esc(n.name)}" data-visitors="${Number(n.visitors || 0)}">${esc(nameLabel(n))}</option>`).join("");
    const histRows = history.map((h) => {
      const byName = h.kind === "name";
      // Older rows predate `kind`/the labels and only ever recorded visitor ids, so fall back to
      // those rather than rendering a blank cell for every merge made before this feature existed.
      const from = byName ? (h.from_label || "?") : String(h.from_label || h.from_visitor || "").slice(0, 12);
      const keep = byName ? (h.keep_label || "?") : String(h.keep_label || h.keep_visitor || "").slice(0, 12);
      return `<tr${h.undone_at ? ' class="undone"' : ""}>
        <td class="dim">${easternTime(Number(h.at || 0))}</td>
        <td><span class="tag">${byName ? "name" : "player"}</span> ${esc(from)} → <b>${esc(keep)}</b>${!byName && h.renamed ? `<br><span class="dim" style="font-size:11px">renamed to ${esc(h.renamed)}</span>` : ""}</td>
        <td class="dim">${Number(h.rows || 0)}</td>
        <td>${h.undone_at
          ? `<span class="dim">put back ${easternTime(Number(h.undone_at))}</span>`
          : `<a class="rn" href="/admin/merge-undo?key=${k}&id=${Number(h.id)}" onclick="return confirm('Put this merge back? Every entry it moved returns to the player and name it came from.')">↩️ put back</a>`}</td>
      </tr>`;
    }).join("");
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>🔗 Merge duplicates into one</h1>
      <p class="sub">This game has no accounts — a player on the leaderboards is a browser. The same person on their
        phone and their laptop is two entries, and a third after they clear site data. Merging puts their entries on one
        player, so the boards count them once and show their best.</p>
      ${done}

      <h2>By name</h2>
      <p class="sub">For the duplicate you actually see: two names on a board that are obviously one person
        (<b>jayden</b> and <b>Jayden</b>). Every entry under both names ends up on one player under the name you keep —
        including when a name spans several browsers, which by player would be one merge each.</p>
      <form class="mf" action="/admin/merge-names" method="get" id="nf">
        <input type="hidden" name="key" value="${k}">
        <div class="mpair">
          <div>
            <label for="keepName">Keep this name</label>
            <select id="keepName" name="keepName" required><option value="">— pick one —</option>${nameOptions}</select>
          </div>
          <div>
            <label for="fromName">…and fold this name into it</label>
            <select id="fromName" name="fromName" required><option value="">— pick one —</option>${nameOptions}</select>
          </div>
        </div>
        <button type="submit">Merge these two names</button>
        <p class="hint" id="nwarn" style="display:none;color:#ffb454"></p>
        <p class="hint">Case matters here, deliberately — <b>jayden</b> and <b>Jayden</b> being separate options is what
          lets you merge them. Each option says how many browsers use that name; if it is more than one, all of them are
          being treated as the same person.</p>
      </form>

      <h2>By player</h2>
      <p class="sub">When the duplicates share a name already, or have none, and you need to say exactly which two
        browsers are one person.</p>
      <form class="mf" action="/admin/merge-do" method="get" id="mf">
        <input type="hidden" name="key" value="${k}">
        <div class="mpair">
          <div>
            <label for="keep">Keep this player</label>
            <select id="keep" name="keep" required><option value="">— pick one —</option>${options}</select>
          </div>
          <div>
            <label for="from">…and fold this one into them</label>
            <select id="from" name="from" required><option value="">— pick one —</option>${options}</select>
          </div>
        </div>
        <label for="name">Name for the merged entries <span class="dim">(optional)</span></label>
        <input id="name" name="name" maxlength="24" placeholder="leave blank to keep the names they already have" autocomplete="off">
        <button type="submit">Merge these two</button>
        <p class="hint">Only leaderboard entries move. The visit log under Sessions and Visitors is left exactly as it
          was — it is the record of who actually came from where, and rewriting it would make it useless as one.</p>
        <p class="hint">The person whose entries were folded in loses their own <b>(you)</b> marker on the boards: their
          browser still holds the id you merged away from. Playing again re-creates it as a new player.</p>
      </form>

      <h2>Fix a split crown</h2>
      <p class="sub">Crown is set per-run — whether OWNER_KEY was live in the browser the moment that run finished —
        not per-browser, so the owner's own device can end up with some runs crowned and some not (the toggle was off
        for a session). That isn't two players — it's one visitor_id already, so merging above refuses it — this just
        corrects the flag across everything that player has ever played.</p>
      <form class="mf" action="/admin/crown-visitor" method="get" id="cf">
        <input type="hidden" name="key" value="${k}">
        <label for="cvisitor">This player</label>
        <select id="cvisitor" name="visitorId" required><option value="">— pick one —</option>${options}</select>
        <button type="submit">Crown every run of theirs</button>
        <p class="hint">Only rows that aren't already crowned change. Their whole history collapses into the one
          crowned entry on every board, same as it would if every run had been crowned from the start.</p>
      </form>
      ${crownHistory.length ? `<div class="tw"><table class="aud"><tr><th>When (ET)</th><th>Player</th><th>Entries</th></tr>${crownHistory.map((h) => `<tr>
        <td class="dim">${easternTime(Number(h.at || 0))}</td>
        <td>${h.crowned ? "👑 crowned" : "un-crowned"} ${esc(String(h.visitor_id || "").slice(0, 12))}</td>
        <td class="dim">${Number(h.rows || 0)}</td>
      </tr>`).join("")}</table></div>` : ""}

      <h2>Merge history</h2>
      <p class="sub">Each merge records every entry it moved, so it can be put back under the name and player it had.
        ${history.length ? "" : "Nothing merged yet."}</p>
      <div class="tw"><table class="aud"><tr><th>When (ET)</th><th>Merge</th><th>Entries</th><th></th></tr>${histRows || `<tr><td class="dim" colspan="4">No merges yet.</td></tr>`}</table></div>
      <script>
      (function(){
        var nf = document.getElementById("nf"), nk = document.getElementById("keepName"), nfrom = document.getElementById("fromName");
        var nbtn = nf.querySelector("button"), nwarn = document.getElementById("nwarn");
        function opt(sel){ return sel.selectedIndex > 0 ? sel.options[sel.selectedIndex] : null; }
        function browsers(sel){ var o = opt(sel); return o ? (parseInt(o.dataset.visitors, 10) || 0) : 0; }
        function nsync(){
          // Exact comparison, matching the server: "jayden" and "Jayden" are DIFFERENT options here,
          // and that is the whole point — refusing them as "the same" would block the common case.
          var same = nk.value && nk.value === nfrom.value;
          nbtn.disabled = !nk.value || !nfrom.value || same;
          nbtn.textContent = same ? "Pick two different names" : "Merge these two names";
          // The unfixable risk, surfaced rather than designed away: nothing in the data can tell one
          // person on three browsers apart from three people who picked the same name.
          var n = browsers(nk) + browsers(nfrom);
          if (!nbtn.disabled && n > 2) {
            nwarn.textContent = "⚠ These two names cover " + n + " browsers between them. All of them will become one player — if any of them is somebody else, their scores merge into this one too.";
            nwarn.style.display = "";
          } else { nwarn.style.display = "none"; }
        }
        nk.addEventListener("change", nsync); nfrom.addEventListener("change", nsync); nsync();
        nf.addEventListener("submit", function(e){
          if (nbtn.disabled) { e.preventDefault(); return; }
          var n = browsers(nk) + browsers(nfrom);
          var msg = "Put every entry named\\n\\n  " + nfrom.value + "\\n\\nunder\\n\\n  " + nk.value + "\\n\\nas one player?"
            + (n > 2 ? "\\n\\nThis covers " + n + " different browsers. If they are not all the same person, their scores merge too." : "")
            + "\\n\\nYou can put this back afterwards.";
          if (!confirm(msg)) e.preventDefault();
        });

        var f = document.getElementById("mf"), keep = document.getElementById("keep"), from = document.getElementById("from");
        var btn = f.querySelector("button");
        function label(sel){ return sel.selectedIndex > 0 ? sel.options[sel.selectedIndex].text : ""; }
        // Merging a player into themselves would silently become a bulk rename — a different
        // operation with a different history entry. Refuse it in the form as well as on the server.
        function sync(){
          var same = keep.value && keep.value === from.value;
          btn.disabled = !keep.value || !from.value || same;
          btn.textContent = same ? "Pick two different players" : "Merge these two";
        }
        keep.addEventListener("change", sync); from.addEventListener("change", sync); sync();
        f.addEventListener("submit", function(e){
          if (btn.disabled) { e.preventDefault(); return; }
          if (!confirm("Fold\\n\\n  " + label(from) + "\\n\\ninto\\n\\n  " + label(keep) + "\\n\\n?\\n\\nEvery leaderboard entry of the first becomes the second's. You can put this back afterwards.")) e.preventDefault();
        });

        var cf = document.getElementById("cf"), cvisitor = document.getElementById("cvisitor");
        cf.addEventListener("submit", function(e){
          if (!cvisitor.value) { e.preventDefault(); return; }
          if (!confirm("Crown every run " + label(cvisitor) + " has played?\\n\\nAnything of theirs not already crowned joins the rest of their history in the single crowned entry on every board.")) e.preventDefault();
        });
      })();
      </script>
      </body>`);
  });
  router.get("/admin/merge-do", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    // A blank name means "leave the names alone", so it must not become cleanName()'s "Anon".
    const raw = String(req.query.name || "").slice(0, 24).trim();
    const name = raw ? cleanName(raw) : null;
    const out = await analytics.mergeVisitors({ keep: req.query.keep, from: req.query.from, name, by: "admin" })
      .catch(() => ({ ok: false, reason: "write-failed", rows: 0 }));
    const q2 = out.ok ? `done=merged&n=${out.rows}` : `done=${encodeURIComponent(out.reason || "")}`;
    res.redirect(`/admin/merge?key=${k}&${q2}`);
  });
  // Merge by display name. Distinct reasons from merge-do's so the page can say which picker was
  // refused — "pick two different players" under the name form would just be confusing.
  router.get("/admin/merge-names", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const out = await analytics.mergeNames({ keepName: req.query.keepName, fromName: req.query.fromName, by: "admin" })
      .catch(() => ({ ok: false, reason: "write-failed", rows: 0 }));
    const reason = { same: "same-name", missing: "missing-name" }[out.reason] || out.reason || "";
    const q2 = out.ok ? `done=merged-names&n=${out.rows}` : `done=${encodeURIComponent(reason)}`;
    res.redirect(`/admin/merge?key=${k}&${q2}`);
  });
  router.get("/admin/merge-undo", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const out = await analytics.undoMerge(req.query.id, "admin").catch(() => ({ ok: false, reason: "write-failed", rows: 0 }));
    const q2 = out.ok ? `done=undone&n=${out.rows}` : `done=${encodeURIComponent(out.reason || "")}`;
    res.redirect(`/admin/merge?key=${k}&${q2}`);
  });
  // Crowns every un-crowned run a visitor has ever played — see crownVisitorRows()'s comment for
  // why this is a different problem than the merges above (same visitor_id both "sides").
  router.get("/admin/crown-visitor", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const out = await analytics.crownVisitorRows({ visitorId: req.query.visitorId, on: true, by: "admin" })
      .catch(() => ({ ok: false, reason: "write-failed", rows: 0 }));
    const q2 = out.ok ? `done=crowned&n=${out.rows}` : `done=${encodeURIComponent(out.reason || "")}`;
    res.redirect(`/admin/merge?key=${k}&${q2}`);
  });

  // Private per-category leaderboards (not public yet — watching how solo play unfolds).
  router.get("/admin/category-leaderboards", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const head = adminHead({ k, title: "Category leaderboards" });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Category leaderboards</h1><p class="sub">Persistence not configured.</p></body>`);
    const cats = await analytics.categoryLeaderboards(10).catch(() => []);
    const totalRuns = cats.reduce((a, c) => a + c.runs, 0);
    const blocks = cats.map((c) => `<div class="cat">
        <div class="cathd">${esc(c.category)} <span class="dim">· ${c.runs} run${c.runs !== 1 ? "s" : ""} · ${c.players} player${c.players !== 1 ? "s" : ""}</span></div>
        <div class="tw"><table>${c.top.map((p, i) => `<tr><td class="rk">${i + 1}</td><td>${esc(p.name || "?")}</td><td class="sc">${p.score}</td></tr>`).join("")}</table></div>
      </div>`).join("");
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>🥇 Category leaderboards <span class="dim" style="font-size:13px">(admin-only)</span></h1>
      <p class="sub">Each player's best score per category across all solo / daily / link runs — <b>${cats.length}</b> categories played, <b>${totalRuns}</b> total category-runs. Busiest first. Not public yet; this is to see how it unfolds.</p>
      <div class="cats">${blocks || `<p class="dim">No solo runs recorded yet.</p>`}</div>
      </body>`);
  });

  // Solo + daily run history — list of individual runs, each drillable to the exact guesses.
  router.get("/admin/runs", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const num = (x) => Number(x || 0);
    const head = adminHead({ k, title: "Solo & daily runs" });
    const back = `<a href="/admin?key=${k}">← back to dashboard</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Solo & daily runs</h1><p class="sub">Persistence not configured.</p></body>`);
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
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>🏃 Solo & daily runs</h1>
      <p class="sub">Each individual run, newest first. Click "see guesses" to replay every word someone typed (runs played after this shipped have a guess log).</p>
      <div class="tw"><table><tr><th>When (ET)</th><th>Puzzle</th><th>Player</th><th>Score</th><th></th></tr>${rows || `<tr><td class="dim" colspan="5">No runs recorded yet.</td></tr>`}</table></div>
      </body>`);
  });
  router.get("/admin/run", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const k = encodeURIComponent(req.query.key || "");
    const num = (x) => Number(x || 0);
    const clock = (ts) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(ts)); } catch (e) { return ""; } };
    const head = adminHead({ k, title: "Run", css: `
      tr.cat td{background:#16203a;font-weight:700}
    ` });
    const back = `<a href="/admin/runs?key=${k}">← back to runs</a>`;
    if (!analytics.enabled()) return res.set("content-type", "text/html").send(`${head}${back}<h1>Run</h1><p class="sub">Persistence not configured.</p></body>`);
    const d = await analytics.soloRunDetail(String(req.query.gid || "")).catch(() => null);
    if (!d || !d.result) return res.set("content-type", "text/html").send(`${head}${back}<h1>Run not found</h1><p class="sub">No run with that id (only runs played after this feature shipped have a guess log).</p></body>`);
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
    res.set("content-type", "text/html").send(`${head}${back}
      <h1>${esc(r.name || "?")} — ${num(r.total)} named</h1>
      <p class="sub">${isDaily ? "daily" : (r.type || "solo")} · ${easternFull(num(r.at))}</p>
      <div class="meta">
        <div>🎯 Total <b>${num(r.total)}</b> · per round: <b>${esc(scores.join(", ") || "—")}</b></div>
        <div>⌨️ Guesses logged: <b>${d.answers.length}</b> · <span class="ok">${okN} hit</span> · <span class="miss">${missN} missed</span> · <span class="dup">${dupN} repeat</span></div>
        <div class="dim">visitor ${esc(String(r.visitor_id || "—").slice(0, 16))} · gid ${esc(String(req.query.gid || ""))}</div>
      </div>
      <div class="tw"><table>${tl}</table></div>
      </body>`);
  });

  router.get("/admin/close", (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const code = String(req.query.code || "").toUpperCase().trim();
    closeRoom(code);
    res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
  });

  // Kill switch: end every active game right now (one-shot).
  router.get("/admin/killall", (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const n = closeAllRooms();
    io.emit("announce", { text: "🛑 The server was reset — all games ended." });
    console.log(`🛑 owner ended ALL games (${n} rooms)`);
    res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
  });
  // Maintenance mode: take the game fully down (kick everyone, block new games) until toggled back on.
  router.get("/admin/lockdown", (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    setLockdown(req.query.on === "1");
    if (isLockdown()) { closeAllRooms(); io.emit("announce", { text: "🔧 The game is down for maintenance — back soon." }); console.log("🔒 LOCKDOWN ON — new games blocked"); }
    else { io.emit("announce", { text: "✅ Back online — the game is up!" }); console.log("🔓 lockdown OFF — game back up"); }
    res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
  });
  // The dashboard's own web app manifest, so it installs to a home screen as its own app rather
  // than sharing the game's. Different name, and a different icon — scripts/make-icons.js draws
  // the same target with a blue stripe beside it so the two tiles can't be confused.
  //
  // An explicit `id` matters here: without one a browser derives the app's identity from
  // start_url, which carries the owner key — so rotating that key would orphan the installed app
  // and silently install a second copy. Pinning id to "/admin" keeps it one app across a rotation.

  // Owner broadcasts a banner message to EVERY connected client (e.g. a pre-deploy heads-up).
  router.get("/admin/announce", (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const text = String(req.query.msg || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (text) { io.emit("announce", { text }); console.log(`📢 announce: ${text}`); }
    res.redirect("/admin?key=" + encodeURIComponent(req.query.key || ""));
  });

  return router;
}

module.exports = { createAdminRouter };
