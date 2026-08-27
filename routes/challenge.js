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
const { CATEGORY_GROUPS, CAT_SIZES, CAT_ITEMS, ALL_ROUND_NAMES } = require("../lib/category-data.js");
const { cleanName, isBlocked } = require("../lib/name-filter.js");
const { MODES, allBoards } = require("../lib/geo-boards.js");
const { recommendedTime } = require("../lib/solo-catalog.js"); // per-category round length, for the pace cap
// The SAME resolver multiplayer scores with. Solo and multiplayer share category names and
// leaderboards, so an answer that counts in one has to count in the other — and a second copy of
// the matching rules here would be the thing that eventually disagreed with the client.
const { buildCategory, resolve } = require("../lib/answer-matching.js");
const { crownOk } = require("../lib/owner-auth.js");
// One notion of "the caller", shared with the admin gate's failed-attempt throttle — two subtly
// different ones would mean a limit that looks enforced and isn't. See lib/caller-ip.js.
const { callerIp } = require("../lib/caller-ip.js");

const newChallengeId = () => Math.random().toString(36).slice(2, 9); // 7-char url-safe id

// ── Rate limits for the unauthenticated writes ───────────────────────────────────────────────
// Every write in this file is unauthenticated, and has to be: the whole game is playable with no
// sign-up. That also makes each one replayable from the network tab, which is exactly what
// happened — a run of 999/999/999 with no keystrokes behind it, posted straight to the API.
//
// A fixed window per IP per endpoint, in memory. Deliberately not a dependency and deliberately
// not shared across machines: one process is all this app runs (see fly.toml), and a limiter that
// forgets everything on restart is still the difference between a script writing thousands of rows
// and one writing a few dozen. Finishing a genuine run takes at least the round timer, so a real
// player never comes close.
//
// This bounds volume, not honesty. The checks that decide whether a *single* score is believable
// are the two ceilings in the result route below.
const SUBMIT_WINDOW_MS = 60_000;
// Per-endpoint budgets, generous enough that a real player never meets one. A finished run posts
// one result, one rename at most, and one guess batch per round — so the numbers below are several
// runs a minute, while still turning "thousands of junk rows a minute" into a few dozen.
//
// Separate buckets per endpoint rather than one shared counter: a shared one lets a flood against
// the cheapest endpoint lock a real player out of saving their run, which would turn a nuisance
// into an outage.
//
// `read` covers the public leaderboard GETs. They are not writes and cannot corrupt anything, but
// they are the biggest responses the app serves, so an unbounded scraper is a bandwidth bill (the
// cost guard watches egress, and tier two pauses the whole site) rather than a data problem. There
// is no way to stop a determined reader — the boards are public, the browser fetches them, and any
// token that gated them would have to ship to that browser — so this bounds the rate, not the
// access. A player opening the leaderboard modal repeatedly is nowhere near 120/min.
const LIMITS = { result: 20, rename: 20, create: 20, guesses: 60, read: 120 };
const buckets = new Map(); // "purpose|ip" → { count, resetAt }
const BUCKETS_MAX_KEYS = 5000; // hard ceiling, not just a sweep threshold — see submitAllowed

function submitAllowed(req, purpose = "result") {
  const key = `${purpose}|${callerIp(req)}`;
  const now = Date.now();
  const e = buckets.get(key);
  if (!e || now > e.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + SUBMIT_WINDOW_MS });
    // Sweep, then a hard ceiling. The sweep alone only drops EXPIRED entries, so with more live
    // callers than the threshold the map grows without limit and every new key pays an O(size)
    // walk — and an IPv6 client has a whole /64 of free addresses to spend on making that happen.
    if (buckets.size > BUCKETS_MAX_KEYS) {
      for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
      if (buckets.size > BUCKETS_MAX_KEYS) {
        const byExpiry = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
        for (const [k] of byExpiry.slice(0, buckets.size - BUCKETS_MAX_KEYS)) buckets.delete(k);
      }
    }
    return true;
  }
  e.count += 1;
  return e.count <= (LIMITS[purpose] || 20);
}

// Shared guard for the public read endpoints. Returns true when it has already answered the request.
function readLimited(req, res) {
  if (submitAllowed(req, "read")) return false;
  res.status(429).json({ ok: false, error: "Too many requests — try again in a minute." });
  return true;
}

// The most a human could type in `seconds`, generously. A four-letter answer plus Enter is about
// five keystrokes, so even a 100-wpm typist naming the shortest possible answers tops out near
// 1.6 per second; 3/s is roughly double that, so no real player will ever meet it.
//
// This complements the category-size cap rather than replacing it, and which one binds depends on
// the round: on a 30-second daily round the pace cap is the tighter of the two, while on a
// 15-minute geography board the category's own answer count is.
const PACE_PER_SECOND = 3;

// The third ceiling, and the one that actually bites: a round's score has to be consistent with the
// typing speed the SAME payload reports for it.
//
// The pace and size caps together still let a fabricated run claim a perfect clear of every
// category. `http POST … scores:='[999,999,999]' wpms:='[0,0,0]'` on a 30-second daily stored
// 49/62/51 — every answer in all three categories, from a run that reports typing nothing at all.
// A cap is only as good as its units, and "answers per second" is not a thing a payload can be
// checked against; characters are.
//
// wpm × 5 = characters per minute (the standard definition of a word for typing speed), so a round
// of `seconds` at the claimed wpm accounts for a computable number of keystrokes. Divided by the
// shortest plausible answer this yields the most answers that typing could have produced.
//
// The divisor is measured from each category's OWN answers rather than being a magic number, because
// a flat one is either useless or unfair: at 2 chars ("generously short") a claimed 60 wpm still
// buys a perfect clear of every category, and at the mean it would reject a real player who happened
// to name only the short answers.
//
// The 10th percentile of the category's answer lengths is the honest middle. It cannot reject a real
// run — 90% of that category's answers are longer, so any real set of N answers types at least this
// much — while a claimed full clear has to come with a plausible wpm to survive. Greek Gods is the
// worked example: p10 is 4 chars, so clearing all 51 needs ≳72 claimed wpm, whereas actually typing
// all 51 (mean 6.0 chars) needs ~122 wpm sustained. The ceiling therefore sits below every genuine
// clear and above every fabricated one that doesn't also fake its typing speed.
//
// FREE_ANSWERS absorbs the client's own under-reporting: hooks/useSolo.js clears the answer box
// programmatically, so it loses roughly the first character of every answer, and liveWpm() returns 0
// outright for a round whose typing was never sampled. Without the allowance a real one- or
// two-answer round would be rejected.
const FREE_ANSWERS = 6;
const FALLBACK_CHARS = 4; // categories with no item list of their own (flags/borders quizzes)
const MAX_HUMAN_WPM = 300; // matches MAX_WPM in hooks/useSolo.js — past this it was pasted, not typed
const CAT_MIN_CHARS = {};
for (const [cat, items] of Object.entries(CAT_ITEMS)) {
  const lens = (items || []).map((it) => String(Array.isArray(it) ? it[0] : it).length).sort((a, b) => a - b);
  if (lens.length) CAT_MIN_CHARS[cat] = Math.max(3, lens[Math.floor(lens.length * 0.1)]);
}
const typedCeiling = (wpm, seconds, category) => {
  const chars = Math.max(0, Math.min(MAX_HUMAN_WPM, wpm)) * 5 * Math.max(1, seconds) / 60;
  return Math.floor(chars / (CAT_MIN_CHARS[category] || FALLBACK_CHARS)) + FREE_ANSWERS;
};

// A category by name, with its aliases resolved, for scoring a run's submitted answers server-side.
// Built on demand and cached: there are 282 categories and a submission touches at most a handful,
// so building them all at boot would be wasted work on every deploy.
//
// Returns null for a name with no plain item list — the flag and border quizzes are synthesised
// rather than being categories.js entries (see lib/flags.js / lib/borders.js), so there is nothing
// to check an answer against and verification is skipped for them.
//
// The name is checked against the known set BEFORE anything is cached. It wasn't, and the only
// caller feeds it `answers.category`, which POST /challenge/:id/guesses writes with a bare
// .slice(0, 80) — never validated the way POST /challenge validates its rounds. So every novel
// 80-character string a stranger submitted became a permanent entry in this map AND cost a scan of
// all 282 categories to discover it was nothing. One rejected key per guess batch, sixty batches a
// minute, forever. One membership test bounds the map at the 282 real names and bounds the
// `category` column with it.
const builtCats = new Map();
function builtCategory(name) {
  if (builtCats.has(name)) return builtCats.get(name);
  if (!ALL_ROUND_NAMES.has(name)) return null;
  let built = null;
  for (const [key, grp] of Object.entries(CATEGORY_GROUPS)) {
    const c = (grp.cats || []).find((x) => x.name === name);
    if (c && Array.isArray(c.items) && c.items.length) { built = buildCategory(c, key, grp.emoji); break; }
  }
  builtCats.set(name, built);
  return built;
}

// Every board used to hand each row's real `visitor_id` to every client. That turned a private
// handle into a public one, and /challenge/rename trusted it as proof of ownership — so reading a
// board was enough to learn the identifier needed to rewrite a stranger's entries.
//
// The client only ever needed two things from it: "is this row mine" (for the (you) marker and the
// amber tint) and a stable key to collapse one player's several runs into their best. So it gets
// exactly those: a boolean, and a token that is only an ordinal within THIS response. The token is
// useless anywhere else, which is the whole point — nothing a caller reads here can be replayed to
// a write endpoint.
function publicRows(rows, me) {
  const keys = new Map();
  return (rows || []).map((r) => {
    const vid = r.visitor_id || null;
    if (vid && !keys.has(vid)) keys.set(vid, "v" + keys.size);
    const out = { ...r, mine: !!vid && !!me && vid === me, vkey: vid ? keys.get(vid) : null };
    delete out.visitor_id;
    return out;
  });
}

// The caller names itself so the server can mark its own rows. Worth being clear about what this
// is and isn't: it's a hint for display, never authorisation. Claiming someone else's id here buys
// nothing but a misplaced "(you)" on your own screen.
const callerId = (req) => String(req.query.me || "").slice(0, 40);

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
function bestRound(by, results) {
  const all = results || [];
  const mine = all.filter((r) => (r.name || "").trim().toLowerCase() === String(by).trim().toLowerCase());
  const pool = mine.length ? mine : all;
  let best = null; // { score, idx }
  for (const r of pool) (r.scores || []).forEach((s, i) => { s = Number(s) || 0; if (s > 0 && (!best || s > best.score)) best = { score: s, idx: i }; });
  return best;
}

// The one sentence a share link exists for. Category names are plural ("US States"), so a score of
// 1 can't be dropped straight in front of one — it needs a counted noun of its own.
//
// This lived in lib/og-card.js, alongside a generated share-card PNG drawn per link. That feature
// was switched off (the cards weren't good enough to keep) and the module is gone; bragLine was the
// only part of it still reachable.
function bragLine({ by, score, category }) {
  const who = by || "A friend";
  if (!category || !(score > 0)) return `${who} challenged you on Prove It!`;
  return score === 1
    ? `${who} says you can't name more than 1 answer in ${category}`
    : `${who} says you can't name more than ${score} ${category}`;
}

function challengePreview({ by, type, genre, rounds, results }) {
  rounds = rounds || [];
  const n = rounds.length;
  const roundWord = `${n} round${n === 1 ? "" : "s"}`;
  const what = type === "genre" && genre ? `${roundWord} of ${genre}` : roundWord;
  const best = bestRound(by, results);
  return {
    // The ⚡ belongs to the title, not to bragLine(): a crawler renders it as text beside the
    // picture, and the picture is the one static card now.
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
  // Bounded and rate-limited, because this was the cheapest denial-of-service in the app. It had no
  // limiter and — alone among every name path here, which all cap at 20-24 characters — no length
  // cap either, so `req.query.name` went to the obscenity matcher at whatever size a header would
  // carry. Measured: 24 chars is 0.045ms, 16,000 chars is 3.97ms, and the matcher is ~250 patterns
  // run over the whole input. A few dozen 16KB GETs a second from one keep-alive connection eats a
  // shared-cpu-1x slice, and everything else in the process starves with it — socket heartbeats,
  // round timers, the Next handler. The budget page wouldn't stop it either; that gate only covers
  // the HTML and JS.
  router.get("/name-check", (req, res) => {
    if (readLimited(req, res)) return;
    res.json({ ok: !isBlocked(String(req.query.name || "").slice(0, 24)) });
  });

  router.post("/challenge", async (req, res) => {
    const b = req.body || {};
    if (isLockdown()) return res.json({ ok: false, error: "The game is down for maintenance — check back soon." });
    if (!submitAllowed(req, "create")) return res.json({ ok: false, error: "Too many challenges — try again in a minute." });
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
    // Maintenance mode has to stop writes, not just new games. It didn't: isLockdown() was checked
    // on POST /challenge alone, so flipping the switch during an incident closed every room, said
    // "the game is down", and left this endpoint — the one actually being abused — wide open.
    if (isLockdown()) return res.status(503).json({ ok: false, error: "The game is down for maintenance — your run wasn't saved." });
    if (!submitAllowed(req, "result")) return res.status(429).json({ ok: false, error: "Too many submissions — slow down and try again in a minute." });
    // No database configured is not a failed write, and the client now retries + warns on ok:false
    // — which turned a deployment (or a local dev run) with no persistence into 15s of retrying
    // followed by "check your connection" after every single run. `stored: false` says the run was
    // accepted and there was simply nowhere to keep it.
    if (!analytics.enabled()) return res.json({ ok: true, stored: false });
    const id = String(req.params.id).slice(0, 12);
    const c = await analytics.getChallenge(id).catch(() => null);
    if (!c) return res.json({ ok: false });
    const b = req.body || {};
    const gid = String(b.gid || "").slice(0, 40); // links this run to its captured guesses
    // ── The score the server can prove ────────────────────────────────────────────────────────────
    // Every other ceiling below bounds how absurd a fabricated number may be. This one asks a
    // different question: which answers did this run actually submit?
    //
    // The client posts its guesses round by round while the run is being played
    // (hooks/useSolo.js), so by the time the result arrives the server already holds the answers
    // that were typed. Re-matching those against the category's real answer list with the same
    // resolver multiplayer uses gives a score the server derived rather than one it was handed —
    // so faking a score now means submitting genuinely correct answers, which is playing the game.
    //
    // Applied only per category the server HAS guesses for. The guess POST is fire-and-forget and
    // the last round's insert can still be in flight when the result lands, so a missing category
    // falls through to the ceilings below rather than zeroing a real player's round. A run whose
    // guesses were logged is capped at exactly the score those guesses earn, which for an honest
    // player is the score they already claimed.
    const provenPerCat = new Map(); // category name → Set of entry ids genuinely answered
    if (gid) {
      for (const g of await analytics.runGuesses(gid).catch(() => [])) {
        const cat = builtCategory(g.category);
        if (!cat) continue; // flag/border quizzes aren't plain categories — no list to check against
        const hit = resolve(cat, g.display);
        if (!hit) continue;
        if (!provenPerCat.has(g.category)) provenPerCat.set(g.category, new Set());
        provenPerCat.get(g.category).add(hit.id);
      }
    }
    // Two independent ceilings, and a round's score has to clear both.
    //
    // 1. It cannot exceed the number of answers the category actually has. The old cap was a flat
    //    999 for every category, so a 47-flag board would happily accept 999 — which is how a
    //    fabricated 999/999/999 reached the top of the daily board. CAT_SIZES is the same table the
    //    daily pool is built from, so this is the real answer count rather than a guess.
    // 2. It cannot exceed what a human could physically type in the time the round allowed. Without
    //    this, 197 answers in a 30-second round still passes — absurd, but within the size cap.
    // 3. It cannot exceed what the payload's OWN reported typing speed accounts for. 1 and 2 together
    //    still allowed a perfect clear of every category from a run reporting zero keystrokes, which
    //    is what a fabricated submission actually looks like — see typedCeiling above.
    //
    // A round's length is the challenge's own `timer`, or the category's recommended time when the
    // challenge was created with timer:0 ("recommended per round"). Both come from the server's own
    // tables, never from the payload, so neither can be inflated by the caller. Only the wpm in 3 is
    // caller-supplied, which is why it is clamped to a human maximum before it is trusted to raise
    // anything — claiming 9999 wpm used to be free.
    const wpms = (Array.isArray(b.wpms) ? b.wpms : []).slice(0, c.rounds.length)
      .map((n) => Math.max(0, Math.min(MAX_HUMAN_WPM, parseInt(n, 10) || 0)));
    const roundCap = (i) => {
      const name = (c.rounds || [])[i];
      const size = CAT_SIZES[name];
      const seconds = c.timer > 0 ? c.timer : recommendedTime(name);
      const byPace = Math.ceil(Math.max(1, seconds) * PACE_PER_SECOND);
      const bySize = Number.isFinite(size) && size > 0 ? size : 999;
      const byTyping = typedCeiling(wpms[i] || 0, seconds, name);
      // The proven score, where there is one, is not a "ceiling" in the same sense as the other
      // three — it is the answer. It only appears as a Math.min term because a category the server
      // has no guesses for must not be capped at zero.
      const proven = provenPerCat.has(name) ? provenPerCat.get(name).size : Infinity;
      return Math.min(bySize, byPace, byTyping, proven);
    };
    // Slice before mapping so each score still lines up with its own round — mapping first and
    // slicing after would cap score[i] against the wrong category on an over-long payload.
    const scores = (Array.isArray(b.scores) ? b.scores : []).slice(0, c.rounds.length)
      .map((n, i) => Math.max(0, Math.min(roundCap(i), parseInt(n, 10) || 0)));
    // seconds-to-complete per round (null when not fully completed) — for speed ranking on maxed boards
    const times = (Array.isArray(b.times) ? b.times : []).map((n) => { const t = parseInt(n, 10); return t > 0 ? Math.min(3600, t) : null; }).slice(0, c.rounds.length);
    const total = scores.reduce((a, n) => a + n, 0);
    // Only ASK when a key was actually sent. It used to ask unconditionally, and almost nobody
    // sends one — so every ordinary run counted as a failed key check. Two things broke:
    //
    //   • the attack log filled with players. It holds 200 entries and exists so a guessing run is
    //     something the owner can SEE; at the 20 submissions a minute this endpoint allows, a
    //     stranger could keep it 100% noise for nothing, and the one detection signal was gone.
    //   • every player's address accumulated failures, so nine crownless runs inside the window
    //     put that address over FAIL_MAX — and the block covers /admin from the same address.
    const crown = b.ownerKey ? crownOk(b.ownerKey, callerIp(req)) : false; // see lib/owner-auth.js
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
  //
  // This used to take a `visitorId` and nothing else. That was a hole, and a bad one: every public
  // leaderboard response publishes `visitor_id` for every row, so anyone could read a board, take a
  // stranger's id, and rewrite every entry that person had ever made — including the owner's. The
  // id names *whose* rows these are; it was never evidence of *being* them.
  //
  // A caller must now also present a `gid` — a run id that appears in no player-facing response —
  // belonging to that same visitor. Possessing one means having actually played a run on that
  // device. Note the gid only authorises; the rename still covers all of that visitor's rows, so a
  // player whose older rows predate gids just needs one recent run to fix everything.
  router.post("/challenge/rename", async (req, res) => {
    if (!analytics.enabled()) return res.json({ ok: false });
    if (isLockdown()) return res.status(503).json({ ok: false, error: "The game is down for maintenance." });
    if (!submitAllowed(req, "rename")) return res.status(429).json({ ok: false, error: "Too many requests — try again in a minute." });
    const b = req.body || {};
    const rawName = String(b.name || "").slice(0, 24).trim();
    if (!rawName) return res.json({ ok: false });
    const name = cleanName(rawName);
    const visitorId = String(b.visitorId || "").slice(0, 40) || null;
    const gid = String(b.gid || "").slice(0, 40) || null;
    // This endpoint does NOT accept an owner key, and that removal is the point.
    //
    // It used to take one, to offer the owner a "rename every crowned row at once" branch. Which
    // meant this unauthenticated, public endpoint answered a yes/no question about OWNER_KEY: post
    // `{name:"x", ownerKey:GUESS}` with no visitorId and a wrong key returned {ok:false} while the
    // right key returned {ok:true}. That is a clean boolean oracle for the admin secret — and it
    // sidestepped the failed-attempt throttle in lib/owner-auth.js entirely, because that throttle
    // hangs off ownerOk(req) and this called the request-less ownerKeyOk(). The only thing in its way
    // was a 20/min limit keyed on fly-client-ip, a header the caller sets.
    //
    // Throttling it harder would have made guessing slower. Deleting the branch makes the question
    // unaskable, which is the difference between a speed bump and a fix. The capability is not lost:
    // /admin/leaderboards has a rename with a visitor-wide scope, behind the real gate, with an audit
    // trail this never had.
    if (!visitorId) return res.json({ ok: false });
    // Everyone has to prove the rows are theirs. There is no longer an exception.
    if (!(await analytics.gidOwnedBy(gid, visitorId).catch(() => false))) {
      return res.status(403).json({ ok: false, error: "Couldn't verify that run — play a round on this device first." });
    }
    const updated = await analytics.renameResults({ name, visitorId, crownAll: false }).catch(() => 0);
    res.json({ ok: true, updated });
  });
  // Exact guesses for one round of a solo/daily run (every Enter press: ok / miss / dup).
  router.post("/challenge/:id/guesses", async (req, res) => {
    if (!analytics.enabled()) return res.json({ ok: false });
    if (isLockdown()) return res.json({ ok: false });
    if (!submitAllowed(req, "guesses")) return res.json({ ok: false });
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
    if (readLimited(req, res)) return;
    if (!analytics.enabled()) return res.json({ ok: false });
    const id = String(req.params.id).slice(0, 12);
    const c = await analytics.getChallenge(id).catch(() => null);
    if (!c) return res.json({ ok: false });
    const rows = await analytics.getChallengeResults(id).catch(() => []);
    res.json({ ok: true, rounds: c.rounds, by: c.by_name, creator: await analytics.getCreatorName().catch(() => null), results: publicRows(rows, callerId(req)) });
  });

  router.get("/daily", async (req, res) => {
    if (readLimited(req, res)) return;
    if (!analytics.enabled()) return res.json({ ok: false, error: "Daily needs persistence (not configured)." });
    const date = easternDay(Date.now());
    const id = dailyId(date);
    let c = await analytics.getChallenge(id).catch(() => null);
    if (!c) { // first player of the day creates it (deterministic rounds → races are harmless)
      await analytics.createChallenge({ id, type: "daily", genre: "", rounds: dailyRounds(date, 3), by: "Daily", timer: DAILY_TIMER }).catch(() => {});
      c = await analytics.getChallenge(id).catch(() => null);
    }
    if (!c) return res.json({ ok: false, error: "Could not load today's daily." });
    // COUNT(*), not the whole board — the only thing this response wants is the number.
    const players = await analytics.countChallengeResults(id).catch(() => 0);
    res.json({ ok: true, id, date, rounds: c.rounds, timer: c.timer || DAILY_TIMER, players });
  });
  // Public per-category leaderboard (each geography "question" gets its own board).
  router.get("/category-leaderboard", async (req, res) => {
    if (readLimited(req, res)) return;
    if (!analytics.enabled()) return res.json({ ok: false });
    const name = String(req.query.name || "").slice(0, 60);
    if (!ALL_ROUND_NAMES.has(name)) return res.json({ ok: false });
    const results = await analytics.categoryLeaderboard(name, 50).catch(() => []);
    res.json({ ok: true, name, results: publicRows(results, callerId(req)) });
  });
  // All-time daily high scores (across every day's puzzle).
  router.get("/daily/alltime", async (req, res) => {
    if (readLimited(req, res)) return;
    if (!analytics.enabled()) return res.json({ ok: false });
    const rows = await analytics.dailyAllTime(50).catch(() => []);
    res.json({ ok: true, results: publicRows(rows, callerId(req)) });
  });
  // GOAT board — one overall geography ranking (points blend volume + speed across every category).
  router.get("/geo-goat", async (req, res) => {
    if (readLimited(req, res)) return;
    if (!analytics.enabled()) return res.json({ ok: false });
    const rows = await analytics.geoGoat(50).catch(() => []);
    res.json({ ok: true, results: publicRows(rows, callerId(req)) });
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
