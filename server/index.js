// Prove It! — server (Phase 4: rooms + reconnection)
// Runs the Next.js app AND the Socket.IO realtime layer on one port: Express owns the JSON
// API, the owner dashboard and the crawler-facing share stub; everything else falls through
// to Next's request handler (which also serves public/ and the client bundle).
const http = require("http");
const express = require("express");
const next = require("next");
const { Server } = require("socket.io");
const engine = require("./game-engine");
const raceEngine = require("./race-engine"); // the live "Challenge Race" mode (see rooms.js's room.mode branch)
const analytics = require("./stats"); // persistent game history (Turso); separate from the in-memory `stats` counters
const SITE = require("../lib/site-config"); // single source of truth for titles/meta tags/credit link — see that file
const { CATEGORY_GROUPS, DEFAULT_GROUPS } = require("../lib/category-data.js");
const { ownerOk } = require("../lib/owner-auth.js");
const { createCostGuard } = require("../lib/cost-guard.js");
const { createChallengeRouter } = require("../routes/challenge.js");
const { createAdminRouter } = require("../routes/admin.js");
const { createRooms, PING_OPTIONS } = require("./rooms.js");
const { publishLiveState } = require("./live-state.js");

const app = express();
// Nothing gains from advertising the framework to a scanner.
app.disable("x-powered-by");
const server = http.createServer(app);
const io = new Server(server, PING_OPTIONS); // heartbeat tuned so a silent drop is seen in seconds — see rooms.js
app.use(express.json({ limit: "16kb" })); // for /challenge and cost-override JSON bodies

const costGuard = createCostGuard({ analytics, SITE, ownerOk });
app.use(costGuard.egressMiddleware); // tally bytes sent per response, for the admin cost projection

// Two response headers worth having everywhere, and one that matters specifically for /admin.
//
// The owner key travels in the query string of every dashboard URL, so document.referrer on any
// same-origin navigation OUT of the dashboard carries it. That is not hypothetical here: the
// dashboard's own "ghost watch" link opens /?ghost=CODE&key=SECRET in a new tab, where
// lib/browser/referrer.js snapshots the referrer and SocketProvider sends it to be persisted in
// sessions.referrer — so the admin key was being written into the analytics table in plaintext.
// no-referrer on /admin* stops the key leaving the page at all.
app.use((req, res, next) => {
  res.set("x-content-type-options", "nosniff");
  if (req.path.startsWith("/admin")) {
    res.set("referrer-policy", "no-referrer");
    // And it must not sit in a shared cache either, for the same reason.
    res.set("cache-control", "private, no-store");
  }
  next();
});

const { rooms, stats, serverStartedAt, getOnline, isLockdown, setLockdown, closeRoom, closeAllRooms } =
  createRooms({ io, engine, raceEngine, analytics, CATEGORY_GROUPS, DEFAULT_GROUPS });

// Hand the live handles to the Next-rendered admin pages. They cannot require their way to this
// state — a second createRooms() would give them an empty Map and a dashboard that quietly reports
// an idle server. See server/live-state.js.
publishLiveState({ io, costGuard, rooms, stats, serverStartedAt, getOnline, isLockdown, setLockdown, closeRoom, closeAllRooms });

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
        rounds: g.round, reason: extra.reason || "win", mode: "mp",
        started_at: g.startedAt || null, ended_at: Date.now(), duration_ms: g.startedAt ? Date.now() - g.startedAt : null, gid: g.gid || null });
    }
  } catch (e) { console.error("reporter:", e.message); }
});

// Same idea, for Challenge Race matches (room.mode === "race") — see race-engine.js.
raceEngine.setReporter((room, type, extra) => {
  try {
    const gid = room.game?.gid || null;
    if (type === "round") {
      analytics.recordRound({ code: room.code, category: extra.category, grp: extra.grp,
        winner_id: extra.winnerId, winner_name: extra.winnerName, claim: extra.claim, proven: extra.proven, at: Date.now(), gid, mode: "race",
        tie: extra.tie, tiebreaker: extra.tiebreaker });
    } else if (type === "answer") {
      analytics.recordAnswer({ code: room.code, category: extra.category, grp: extra.grp, display: extra.display, offList: false, at: Date.now(), gid, player: extra.player, mode: "race" });
    } else if (type === "event") {
      analytics.recordEvent(extra.type, room.code, extra.detail, "race", gid);
    } else if (type === "end") {
      const g = room.game; if (!g) return;
      analytics.recordGame({ code: room.code,
        winner_id: extra.winnerId || null, winner_name: extra.winnerId ? g.names[extra.winnerId] : null,
        groups: (g.groups || []).join(","), timer: g.timer, format: g.format == null ? "endless" : `bo${g.format}`,
        sudden_death: g.suddenDeath ? 1 : 0, player_count: g.order.length,
        rounds: g.round, reason: extra.reason || "win", mode: "race",
        started_at: g.startedAt || null, ended_at: Date.now(), duration_ms: g.startedAt ? Date.now() - g.startedAt : null, gid: g.gid || null });
      const ranked = [...g.order].sort((a, b) => (g.roundWins[b] || 0) - (g.roundWins[a] || 0));
      analytics.recordRacePlayers(g.gid, g.order.map((id) => ({ id, name: g.names[id], roundWins: g.roundWins[id] || 0, finalRank: ranked.indexOf(id) + 1 })));
    }
  } catch (e) { console.error("race reporter:", e.message); }
});

// Owner-only live dashboard (gated by the OWNER_KEY secret) — see routes/admin.js.
app.use(createAdminRouter({ io, costGuard, rooms, stats, serverStartedAt, getOnline, isLockdown, setLockdown, closeRoom, closeAllRooms }));

// Async challenges, the daily challenge, and the /challenge.html share-link stub — see routes/challenge.js.
app.use(createChallengeRouter({ isLockdown }));

// Everything else is the app itself: Next serves the pages, the client bundle and public/.
// Its build output is content-hashed, so it manages its own cache headers.
const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev });
const handleNext = nextApp.getRequestHandler();
app.use((req, res) => handleNext(req, res));

const PORT = process.env.PORT || 3000;
nextApp.prepare().then(() => {
  server.listen(PORT, () => {
    console.log(`🎯 Prove It! server running at http://localhost:${PORT}`);
  });
}).catch((e) => {
  console.error("next: failed to start:", e);
  process.exit(1);
});
