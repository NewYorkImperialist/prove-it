// Prove It! — server (Phase 4: rooms + reconnection)
// Serves the static game files AND runs the Socket.IO realtime layer on one port.
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const engine = require("./game-engine");
const analytics = require("./stats"); // persistent game history (Turso); separate from the in-memory `stats` counters
const SITE = require("./site-config"); // single source of truth for titles/meta tags/credit link — see that file
const { CATEGORY_GROUPS, DEFAULT_GROUPS } = require("./lib/category-data.js");
const { ownerOk } = require("./lib/owner-auth.js");
const { createCostGuard } = require("./lib/cost-guard.js");
const { render, siteVars } = require("./lib/render.js");
const { createChallengeRouter } = require("./routes/challenge.js");
const { createAdminRouter } = require("./routes/admin.js");
const { createRooms } = require("./rooms.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: "16kb" })); // for /challenge and cost-override JSON bodies

const costGuard = createCostGuard({ analytics, SITE, ownerOk });
app.use(costGuard.egressMiddleware); // tally bytes sent per response, for the admin cost projection

const { rooms, stats, serverStartedAt, getOnline, isLockdown, setLockdown, closeRoom, closeAllRooms } =
  createRooms({ io, engine, analytics, CATEGORY_GROUPS, DEFAULT_GROUPS });

// When the cost cap is tripped, serve a tiny "paused for the month" page instead of the heavy
// HTML/JS bundle — see lib/cost-guard.js. Small API responses and /admin keep working.
app.use(costGuard.budgetGateMiddleware);
// Owner override: keep the game live for the rest of THIS billing cycle even past the caps (?on=1), or re-arm it (?on=0).
app.get("/admin/cost-override", costGuard.costOverrideRoute);

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

// Single-page app: multiplayer + solo share one document (index.html). Templated (not sendFile)
// so its title/meta tags/credit link render from site-config.js instead of being hardcoded here.
let indexTemplate = null;
app.get("/", (req, res) => {
  try {
    if (!indexTemplate || process.env.NODE_ENV !== "production") indexTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    const html = render(indexTemplate, { ...siteVars, TITLE: SITE.home.title, DESCRIPTION: SITE.home.description,
      OG_TITLE: SITE.home.ogTitle, OG_DESCRIPTION: SITE.home.ogDescription, TWITTER_DESCRIPTION: SITE.home.twitterDescription });
    res.set("content-type", "text/html").send(html);
  } catch (e) { res.sendFile(path.join(__dirname, "public", "index.html")); }
});

// Owner-only live dashboard (gated by the OWNER_KEY secret) — see routes/admin.js.
app.use(createAdminRouter({ io, costGuard, rooms, stats, serverStartedAt, getOnline, isLockdown, setLockdown, closeRoom, closeAllRooms }));

// Async challenges, the daily challenge, and the /challenge.html share-link stub — see routes/challenge.js.
app.use(createChallengeRouter({ isLockdown }));

// Always revalidate HTML/JS so the inlined CSS + game logic are never served stale
// (matters because we push UI tweaks frequently and the link is shared publicly).
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/\.(html|js)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  },
}));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎯 Prove It! server running at http://localhost:${PORT}`);
});
