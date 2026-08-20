"use strict";
// Async challenges (multi-round links with a shared leaderboard) + the daily challenge, which is
// just a challenge with a fixed, date-derived id so everyone plays the same puzzle each day.
const path = require("path");
const fs = require("fs");
const express = require("express");
const analytics = require("../server/stats"); // persistent game history (Turso)
const SITE = require("../lib/site-config");
const { render, siteVars } = require("../lib/render.js");
const { easternDay } = require("../lib/html.js");
const { CATEGORY_GROUPS, CAT_SIZES, ALL_ROUND_NAMES } = require("../lib/category-data.js");
const { cleanName, isBlocked } = require("../lib/name-filter.js");
const { MODES, allBoards } = require("../lib/geo-boards.js");
const { bragLine } = require("../lib/og-card.js");

const newChallengeId = () => Math.random().toString(36).slice(2, 9); // 7-char url-safe id

// ---------- Daily challenge ----------
const DAILY_TROLL = new Set(["Things the Nyan Cat Says", "Counting Numbers", "Nobel Peace Prize Loser", "People in the Epstein Files", "Italian Brainrot", "Cities Mistaken for Australia's Capital", "Seasons of the Year", "Months of the Year"]);
const DAILY_POOL = [];
for (const grp of Object.values(CATEGORY_GROUPS)) {
  if (grp.defaultOff) continue;
  for (const c of grp.cats) if (!DAILY_TROLL.has(c.name) && (CAT_SIZES[c.name] || 0) >= 14) DAILY_POOL.push(c.name);
}
DAILY_POOL.sort(); // stable order so the seeded pick is identical across server restarts
// Deterministic PRNG (xmur3 seed + mulberry32) so a given date always yields the same puzzle.
function seededRng(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function dailyRounds(date, n = 3) {
  const rng = seededRng("proveit-daily-" + date), pool = DAILY_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}
const DAILY_TIMER = 30;
const dailyId = (date) => "d-" + date.replace(/-/g, ""); // e.g. d-20260624 (10 chars, within the 12-char id slice)

// The title/description crawlers (Discord/iMessage/Reddit/Twitter) show for a share link. Pure, so
// the copy is testable without a database — every solo "Quick play" and "Pick a category → Play" run
// is a ONE-round challenge, and its link is the most-shared artifact in the game, so the singular
// cases here are the common ones, not the edge ones: "1 rounds" and "more than 1 US States" were
// both reachable from the button most players press first.
// The challenger's best single-round score and which round it came from ("17 Countries in Europe").
// Prefer the creator's own runs; fall back to everyone's if their name isn't on the board yet.
// Split out of challengePreview because the share CARD (lib/og-card.js) needs the same two numbers
// as pixels, and re-deriving them beside the copy is how the picture and the title drift apart.
function bestRound(by, results) {
  const all = results || [];
  const mine = all.filter((r) => (r.name || "").trim().toLowerCase() === String(by).trim().toLowerCase());
  const pool = mine.length ? mine : all;
  let best = null; // { score, idx }
  for (const r of pool) (r.scores || []).forEach((s, i) => { s = Number(s) || 0; if (s > 0 && (!best || s > best.score)) best = { score: s, idx: i }; });
  return best;
}

function challengePreview({ by, type, genre, rounds, results }) {
  rounds = rounds || [];
  const n = rounds.length;
  const roundWord = `${n} round${n === 1 ? "" : "s"}`;
  const what = type === "genre" && genre ? `${roundWord} of ${genre}` : roundWord;
  const best = bestRound(by, results);
  return {
    // The ⚡ is the title's own, not the card's: a crawler renders it as text next to the picture,
    // and satori has no emoji font (see app/og.png/route.js), so bragLine() stays plain.
    title: `⚡ ${bragLine({ by, score: best ? best.score : null, category: best ? rounds[best.idx] : "" })}`,
    desc: `${what}. Name as many as you can before the clock runs out, then try to beat the leaderboard. No sign-up, just click and play.`,
  };
}

// ---------- Share-link shapes ----------
// The 27 geography boards, indexed for validating a ?geo= board name. `region` and `mode` on each
// row are regionLabel()/modeOf() output, so the copy below reads them rather than re-deriving them.
const GEO_BOARDS = new Map(allBoards().map((b) => [b.name.toLowerCase(), b]));
const GEO_MODES = new Map(MODES.map((m) => [m.key, m]));
const GEO_COUNT = GEO_BOARDS.size;

// A repeated param (?geo=a&geo=b) arrives as an array, and String(["a","b"]) is "a,b" — which would
// then fail every validity check for a reason nobody could read. Take the first value instead.
const firstParam = (v) => String((Array.isArray(v) ? v[0] : v) ?? "");

// isLockdown: the owner maintenance kill-switch, from rooms.js's createRooms() instance.
function createChallengeRouter({ isLockdown }) {
  const router = express.Router();

  // Client-side pre-check so the UI can reject a bad name before submitting it, instead of
  // silently swapping it for "Anon" server-side (that swap still happens as a backstop below).
  router.get("/name-check", (req, res) => {
    res.json({ ok: !isBlocked(req.query.name) });
  });

  router.post("/challenge", async (req, res) => {
    const b = req.body || {};
    if (isLockdown()) return res.json({ ok: false, error: "The game is down for maintenance — check back soon." });
    if (!analytics.enabled()) return res.json({ ok: false, error: "Challenges need persistence (not configured)." });
    const type = b.type === "custom" ? "custom" : "genre";
    const rounds = (Array.isArray(b.rounds) ? b.rounds : []).filter((n) => ALL_ROUND_NAMES.has(n)).slice(0, 10);
    if (rounds.length < 1) return res.json({ ok: false, error: "Pick at least one valid category." });
    const tt = parseInt(b.timer, 10); const timer = tt === 0 ? 0 : ((tt >= 5 && tt <= 1800) ? tt : 45); // 0 = recommended per round; else 5s–30min
    const id = newChallengeId();
    const ok = await analytics.createChallenge({ id, type, genre: String(b.genre || "").slice(0, 40), rounds, by: cleanName(String(b.by || "A friend").slice(0, 24)), timer });
    res.json(ok ? { ok: true, id } : { ok: false, error: "Could not save challenge." });
  });
  router.get("/challenge/:id", async (req, res) => {
    if (!analytics.enabled()) return res.json({ ok: false });
    const c = await analytics.getChallenge(String(req.params.id).slice(0, 12)).catch(() => null);
    if (!c) return res.json({ ok: false });
    res.json({ ok: true, id: c.id, type: c.type, genre: c.genre, rounds: c.rounds, by: c.by_name, timer: c.timer == null ? 45 : c.timer });
  });
  router.post("/challenge/:id/result", async (req, res) => {
    // No database configured is not a failed write, and the client now retries + warns on ok:false
    // — which turned a deployment (or a local dev run) with no persistence into 15s of retrying
    // followed by "check your connection" after every single run. `stored: false` says the run was
    // accepted and there was simply nowhere to keep it.
    if (!analytics.enabled()) return res.json({ ok: true, stored: false });
    const id = String(req.params.id).slice(0, 12);
    const c = await analytics.getChallenge(id).catch(() => null);
    if (!c) return res.json({ ok: false });
    const b = req.body || {};
    const scores = (Array.isArray(b.scores) ? b.scores : []).map((n) => Math.max(0, Math.min(999, parseInt(n, 10) || 0))).slice(0, c.rounds.length);
    const wpms = (Array.isArray(b.wpms) ? b.wpms : []).map((n) => Math.max(0, Math.min(9999, parseInt(n, 10) || 0))).slice(0, c.rounds.length);
    // seconds-to-complete per round (null when not fully completed) — for speed ranking on maxed boards
    const times = (Array.isArray(b.times) ? b.times : []).map((n) => { const t = parseInt(n, 10); return t > 0 ? Math.min(3600, t) : null; }).slice(0, c.rounds.length);
    const total = scores.reduce((a, n) => a + n, 0);
    const crown = !!(process.env.OWNER_KEY && b.ownerKey === process.env.OWNER_KEY); // creator crown (server-validated)
    const gid = String(b.gid || "").slice(0, 40); // links this run to its captured guesses
    // play origin — keeps the solo-map geography boards separate from daily/shared-link plays.
    const mode = id.startsWith("d-") ? "daily" : (["solo", "link"].includes(b.mode) ? b.mode : "solo");
    // Report what the write actually did. Hardcoding ok:true here made the client's whole
    // retry-and-keep-it-on-the-device path (hooks/useSolo.js trySaveResult) unreachable for the
    // one failure it was built for: addChallengeResult returns false on a DB error rather than
    // throwing, so a run that never reached the leaderboard was still announced as saved.
    const saved = await analytics.addChallengeResult({ challenge_id: id, name: cleanName(String(b.name || "Anon").slice(0, 24)), visitor_id: String(b.visitorId || "").slice(0, 40), scores, total, wpms, times, crown, gid, mode }).catch(() => false);
    if (!saved) return res.status(503).json({ ok: false, error: "Could not save your run — try again in a moment." });
    res.json({ ok: true });
  });
  // Rename a player's leaderboard entries everywhere (all challenges/days). Owner key → also renames
  // every crowned row so the creator's name stays consistent across devices.
  router.post("/challenge/rename", async (req, res) => {
    if (!analytics.enabled()) return res.json({ ok: false });
    const b = req.body || {};
    const rawName = String(b.name || "").slice(0, 24).trim();
    if (!rawName) return res.json({ ok: false });
    const name = cleanName(rawName);
    const visitorId = String(b.visitorId || "").slice(0, 40) || null;
    const crownAll = !!(process.env.OWNER_KEY && b.ownerKey === process.env.OWNER_KEY);
    if (!visitorId && !crownAll) return res.json({ ok: false });
    const updated = await analytics.renameResults({ name, visitorId, crownAll }).catch(() => 0);
    res.json({ ok: true, updated });
  });
  // Exact guesses for one round of a solo/daily run (every Enter press: ok / miss / dup).
  router.post("/challenge/:id/guesses", async (req, res) => {
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
    analytics.recordSoloGuesses({ gid, challengeId: id, category: String(b.category || "").slice(0, 80), name: cleanName(String(b.name || "").slice(0, 24)), mode: id.startsWith("d-") ? "daily" : "solo", guesses });
    res.json({ ok: true });
  });
  router.get("/challenge/:id/results", async (req, res) => {
    if (!analytics.enabled()) return res.json({ ok: false });
    const id = String(req.params.id).slice(0, 12);
    const c = await analytics.getChallenge(id).catch(() => null);
    if (!c) return res.json({ ok: false });
    res.json({ ok: true, rounds: c.rounds, by: c.by_name, creator: await analytics.getCreatorName().catch(() => null), results: await analytics.getChallengeResults(id).catch(() => []) });
  });

  router.get("/daily", async (req, res) => {
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
  router.get("/category-leaderboard", async (req, res) => {
    if (!analytics.enabled()) return res.json({ ok: false });
    const name = String(req.query.name || "").slice(0, 60);
    if (!ALL_ROUND_NAMES.has(name)) return res.json({ ok: false });
    const results = await analytics.categoryLeaderboard(name, 50).catch(() => []);
    res.json({ ok: true, name, results });
  });
  // All-time daily high scores (across every day's puzzle).
  router.get("/daily/alltime", async (req, res) => {
    if (!analytics.enabled()) return res.json({ ok: false });
    const rows = await analytics.dailyAllTime(50).catch(() => []);
    res.json({ ok: true, results: rows });
  });
  // GOAT board — one overall geography ranking (points blend volume + speed across every category).
  router.get("/geo-goat", async (req, res) => {
    if (!analytics.enabled()) return res.json({ ok: false });
    const rows = await analytics.geoGoat(50).catch(() => []);
    res.json({ ok: true, results: rows });
  });

  // Share-link stub, templated from site-config.js's `challenge` defaults. Crawlers
  // (Discord/iMessage/Reddit/Twitter) don't run JS, so the meta tags rendered here are the entire
  // preview; real browsers run the script at the bottom of the template and are bounced into the
  // app at /?<same query string>. Three shapes get a bespoke preview and a generated card:
  //
  //   ?id=<challengeId>   a challenge or the daily — the challenger's name + score-to-beat
  //   ?geo=<boardName>    one of the 27 geography boards
  //   ?room=<CODE>        a live multiplayer invite
  //
  // Anything else falls through to the static defaults, which is also the DB-off path: with no
  // persistence there is no score to quote, and quoting one we made up would be worse than generic.
  router.get("/challenge.html", async (req, res, next) => {
    const a = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const vars = { ...siteVars, TITLE: SITE.challenge.title, DESCRIPTION: SITE.challenge.description,
      OG_TITLE: SITE.challenge.ogTitle, OG_DESCRIPTION: SITE.challenge.ogDescription };
    // One place that writes the preview, so a new shape can't ship with (say) og:title set and
    // twitter:title still saying "Prove It! · the bluffing word game".
    const preview = ({ title, desc, kind, facts, search }) => {
      vars.TITLE = vars.OG_TITLE = vars.TWITTER_TITLE = a(title);
      vars.DESCRIPTION = vars.OG_DESCRIPTION = vars.TWITTER_DESCRIPTION = a(desc);
      vars.OG_IMAGE = a(`${SITE.ogImage.url}?v=${SITE.ogImage.v}`);
      vars.OG_IMAGE_ALT = a(SITE.ogImage.alt);
      // og:url is the canonical page, which is the app the bounce script lands on — not this stub.
      // Rebuilt from the values we validated rather than echoed from req.url, so nothing a stranger
      // put in the query string can end up being presented as our own canonical address.
      vars.OG_URL = a(SITE.url + search);
    };

    const id = firstParam(req.query.id).slice(0, 12);
    // ?by= is the sharer's own name. The daily has no single "creator" (it's the same puzzle for
    // everyone, auto-created by whoever plays first each day, hence by_name === "Daily"), so for a
    // daily link whoever is SHARING it is who "says" the challenge in the preview.
    const rawBy = firstParam(req.query.by).trim().slice(0, 24);
    const sharedBy = rawBy ? cleanName(rawBy) : "";
    const geo = firstParam(req.query.geo).trim().slice(0, 60);
    const room = firstParam(req.query.room).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);

    // An ?id= link stays an ?id= link even with no database behind it (the app gives it priority
    // too — see the deepLink ref in components/AppShell.jsx), so this branch is chosen on the param
    // being present, not on our being able to fill it in.
    if (id) {
      const c = analytics.enabled() ? await analytics.getChallenge(id).catch(() => null) : null;
      if (c) {
        const results = await analytics.getChallengeResults(id).catch(() => []);
        const daily = id.startsWith("d-");
        const by = (daily && sharedBy) || c.by_name || "A friend";
        const { title, desc } = challengePreview({ by, type: c.type, genre: c.genre, rounds: c.rounds, results });
        const best = bestRound(by, results);
        preview({
          title, desc,
          kind: daily ? "daily" : "challenge",
          facts: {
            by, score: best ? best.score : null, category: best ? (c.rounds || [])[best.idx] : "",
            rounds: c.rounds, timer: c.timer, sub: c.type === "genre" ? c.genre : "",
          },
          search: `?id=${encodeURIComponent(id)}${daily && sharedBy ? `&by=${encodeURIComponent(sharedBy)}` : ""}`,
        });
      }
    } else if (geo) {
      // ?geo=1 is the app's own "open the Geography screen" deep link, so an unrecognised value is
      // the normal case here, not an error — it gets the card for the whole geography section.
      const board = GEO_BOARDS.get(geo.toLowerCase());
      const mode = board ? GEO_MODES.get(board.mode) : null;
      preview(board ? {
        title: `⚡ Can you name all ${board.answers} ${board.name}?`,
        desc: `${mode ? mode.blurb + " " : ""}${board.region} · every board keeps its own leaderboard, so there's a score to beat on this one. No sign-up, just click and play.`,
        kind: "geo", facts: { board: board.name },
        search: `?geo=${encodeURIComponent(board.name)}`,
      } : {
        title: `⚡ ${GEO_COUNT} geography boards on Prove It!`,
        desc: `Name the map, the flags, the borders or the capitals — ${GEO_COUNT} boards, each with its own leaderboard and one overall ranking. No sign-up, just click and play.`,
        kind: "geo", facts: {},
        search: "?geo=1",
      });
    } else if (room) {
      preview({
        title: sharedBy ? `⚡ ${sharedBy} wants to play you on Prove It!` : `⚡ Join my Prove It! room · ${room}`,
        desc: `Head-to-head: brag how many you can name, then back it up against the clock — or call the bluff. Room code ${room}. No sign-up, just click and play.`,
        kind: "room", facts: { code: room, by: sharedBy },
        search: `?room=${encodeURIComponent(room)}${sharedBy ? `&by=${encodeURIComponent(sharedBy)}` : ""}`,
      });
    }

    let template;
    try { template = fs.readFileSync(path.join(__dirname, "..", "templates", "challenge.html"), "utf8"); } catch (e) { return next(); }
    res.set("content-type", "text/html").set("cache-control", "no-cache").send(render(template, vars));
  });

  return router;
}

module.exports = { createChallengeRouter, challengePreview };
