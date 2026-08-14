"use strict";
// Owner-only live dashboard (gated by the OWNER_KEY secret). Reads server state directly — an
// INVISIBLE peek (doesn't join as a spectator).
//   /admin?key=YOUR_KEY        → live HTML dashboard (auto-refreshes)
//   /admin?key=YOUR_KEY&json=1 → raw JSON
const express = require("express");
const analytics = require("../stats"); // persistent game history (Turso)
const SITE = require("../site-config");
const { ownerOk } = require("../lib/owner-auth.js");
const { FLY_COST, projectCost } = require("../lib/cost-guard.js");
const { esc, easternHour, easternTime, easternFull, easternDay, fmtHour12, fmtDur, fmtMs, bar, tbl } = require("../lib/html.js");
const { CAT_SIZES, CAT_ITEMS, CAT_GROUP } = require("../lib/category-data.js");

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
      game: gamePeek(room),
    }));
  }
  // Top-of-page at-a-glance health check — meant to answer "is it the server, the DB, or my own
  // network?" in one look, without digging into the cost/bandwidth section further down.
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

  // Trivial round-trip target for the dashboard's "Your connection" client-side check — no DB, no
  // room data, as cheap as a request can be so it's a clean measure of the browser↔server hop alone.
  router.get("/admin/ping", (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    res.json({ ok: true, now: Date.now() });
  });

  router.get("/admin", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const now = Date.now();
    const list = adminData();
    if (req.query.json) {
      const hist = analytics.enabled() ? await analytics.summary().catch(() => null) : null;
      const bw = analytics.enabled() ? await analytics.bandwidthStats().catch(() => null) : null;
      const dbPing = await analytics.ping().catch(() => ({ configured: false, ok: false }));
      return res.json({ now, uptimeMs: now - serverStartedAt, online: getOnline(), stats, history: hist, bandwidth: bw, roomCount: list.length, rooms: list, db: dbPing, costGuard: costGuard.getState(), lockdown: isLockdown() });
    }
    const hist = analytics.enabled() ? await analytics.summary().catch(() => null) : null;
    const bw = analytics.enabled() ? await analytics.bandwidthStats().catch(() => null) : null;
    const dbPing = await analytics.ping().catch(() => ({ configured: false, ok: false }));
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
      <meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
      <title>${SITE.adminDashboard.title}</title><style>
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
      <body><h1>${SITE.adminDashboard.heading}</h1>
      <p class="sub">🟢 <b style="color:#3ecf8e">${getOnline()}</b> online · ${list.length} room${list.length === 1 ? "" : "s"} · ${playing} in a game · auto-refreshes every 60s · ${easternFull(now)}</p>
      ${siteHealthHtml(dbPing, now, k)}
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
  router.get("/admin/health", async (req, res) => {
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
  router.get("/admin/games", async (req, res) => {
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
  router.get("/admin/game", async (req, res) => {
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
  router.get("/admin/chat", async (req, res) => {
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
  router.get("/admin/visitors", async (req, res) => {
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
  router.get("/admin/sessions", async (req, res) => {
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
  router.get("/admin/leaderboards", async (req, res) => {
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
  router.get("/admin/result-delete", async (req, res) => {
    if (!ownerOk(req)) return res.status(404).send("Not found");
    const rowId = parseInt(req.query.id, 10);
    if (rowId && analytics.enabled()) await analytics.deleteResult(rowId).catch(() => {});
    res.redirect(`/admin/leaderboards?key=${encodeURIComponent(req.query.key || "")}`);
  });

  // Private per-category leaderboards (not public yet — watching how solo play unfolds).
  router.get("/admin/category-leaderboards", async (req, res) => {
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
  router.get("/admin/runs", async (req, res) => {
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
  router.get("/admin/run", async (req, res) => {
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
