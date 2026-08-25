// Prove It! — optional persistent analytics (Turso / libSQL).
// Pure-JS web client (no native module). Everything is fire-and-forget and fully
// guarded: if TURSO_URL isn't set (or the DB is unreachable), the whole module
// quietly no-ops and the game/admin board keep working.
let client = null;
const url = process.env.TURSO_URL;
const authToken = process.env.TURSO_TOKEN;
if (url) {
  try {
    const { createClient } = require("@libsql/client/web");
    client = createClient({ url, authToken });
  } catch (e) {
    console.error("📊 stats: client init failed —", e.message);
  }
}
async function init() {
  if (!client) { console.log("📊 stats: disabled (no TURSO_URL set)"); return; }
  try {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT,
        p1_id TEXT, p1_name TEXT, p1_score INTEGER,
        p2_id TEXT, p2_name TEXT, p2_score INTEGER,
        winner_id TEXT, winner_name TEXT,
        groups TEXT, timer INTEGER, target TEXT,
        rounds INTEGER, reason TEXT,
        started_at INTEGER, ended_at INTEGER, duration_ms INTEGER)`,
      `CREATE TABLE IF NOT EXISTS rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_code TEXT,
        category TEXT, grp TEXT, winner_id TEXT, winner_name TEXT,
        claim INTEGER, proven INTEGER, at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game_code TEXT,
        category TEXT, grp TEXT, display TEXT, off_list INTEGER, at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, code TEXT, detail TEXT, at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, connected_at INTEGER, disconnected_at INTEGER, duration_ms INTEGER,
        device TEXT, played INTEGER, joined INTEGER, spectated INTEGER, name TEXT, reason TEXT)`,
      `CREATE TABLE IF NOT EXISTS chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT, code TEXT, name TEXT, text TEXT, at INTEGER, spectator INTEGER, mode TEXT DEFAULT 'mp')`,
      `CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY, type TEXT, genre TEXT, rounds TEXT, by_name TEXT, created_at INTEGER, timer INTEGER DEFAULT 45)`,
      `CREATE TABLE IF NOT EXISTS challenge_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id TEXT, name TEXT, visitor_id TEXT, scores TEXT, total INTEGER, at INTEGER, wpms TEXT, crown INTEGER DEFAULT 0)`,
      // egress accounting per UTC day (bytes sent + request count) → the admin cost projection
      `CREATE TABLE IF NOT EXISTS bandwidth (day TEXT PRIMARY KEY, bytes INTEGER DEFAULT 0, reqs INTEGER DEFAULT 0)`,
      // tiny key/value store (used by the cost guard to remember a per-cycle budget override across restarts)
      `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
      // Every rename of a leaderboard entry, with the name it had before. renameResults overwrites
      // `name` in place, so without this the previous name is gone from the database entirely — the
      // one destructive edit here that isn't a DELETE, and the only one with nothing to restore from.
      // `rows` is how many entries that one rename rewrote, so a visitor-wide rename is legible as
      // one action rather than as an unexplained batch.
      `CREATE TABLE IF NOT EXISTS name_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, scope TEXT, row_id INTEGER,
        visitor_id TEXT, old_name TEXT, new_name TEXT, rows INTEGER, by_who TEXT)`,
      // Every merge of two visitors' leaderboard entries. `snapshot` is the (id, visitor_id, name)
      // of every row the merge moved, which is what makes it undoable: the merge rewrites
      // visitor_id in place, and once two visitors' rows share an id nothing else in the schema
      // remembers which of them a row came from. undone_at marks a merge that has been rolled back
      // rather than deleting the record of it.
      `CREATE TABLE IF NOT EXISTS merge_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, keep_visitor TEXT, from_visitor TEXT,
        rows INTEGER, snapshot TEXT, renamed TEXT, by_who TEXT, undone_at INTEGER)`,
      // crown is set per-run (behind OWNER_KEY), not per-browser, so the same visitor_id can end
      // up with a mix of crowned and un-crowned rows — the owner's own crown toggle was off for
      // some of their plays. That isn't two players (mergeVisitors refuses a same-id "merge"); it's
      // one visitor's flag needing correcting across their history. `crowned` is the direction
      // (1 = crowned, 0 = un-crowned), so the same audit trail covers either.
      `CREATE TABLE IF NOT EXISTS crown_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, visitor_id TEXT, crowned INTEGER,
        rows INTEGER, by_who TEXT)`,
      // Reachability, written by scripts/probe.js from OUTSIDE this process (see the uptime
      // workflow). It is the one table this server never writes to itself, and deliberately so:
      // a dashboard running inside the app can report anything except that the app was gone.
      `CREATE TABLE IF NOT EXISTS uptime (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, ok INTEGER, status INTEGER, ms INTEGER, err TEXT)`,
      // one row per player per completed "Challenge Race" match (mode='race' games in `games`) —
      // a separate child table rather than widening `games` with p3_id..p6_id-style columns,
      // since a race can have 2-8 players.
      `CREATE TABLE IF NOT EXISTS race_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT, player_id TEXT, name TEXT,
        round_wins INTEGER, final_rank INTEGER, at INTEGER)`,
    ], "write");
    // migrate existing tables: mode (mp/sp) + difficulty. ALTER fails harmlessly if the column already exists.
    for (const [t, c] of [["games", "mode TEXT DEFAULT 'mp'"], ["games", "difficulty TEXT"], ["rounds", "mode TEXT DEFAULT 'mp'"],
      ["rounds", "difficulty TEXT"], ["answers", "mode TEXT DEFAULT 'mp'"], ["events", "mode TEXT DEFAULT 'mp'"], ["sessions", "mode TEXT DEFAULT 'mp'"],
      ["sessions", "singleplayer INTEGER DEFAULT 0"],
      ["games", "gid TEXT"], ["rounds", "gid TEXT"], ["answers", "gid TEXT"], ["answers", "player TEXT"], ["events", "gid TEXT"],
      ["sessions", "ip TEXT"], ["sessions", "visitor_id TEXT"], ["sessions", "tz TEXT"], ["sessions", "locale TEXT"], ["sessions", "geo TEXT"],
      // referral tracking: ref_source is the canonical channel label (lib/referral.js), referrer the
      // raw header it was derived from — kept so a mislabelled channel can be re-derived later.
      ["sessions", "ref_source TEXT"], ["sessions", "referrer TEXT"],
      ["challenges", "timer INTEGER DEFAULT 45"], ["challenge_results", "wpms TEXT"], ["challenge_results", "crown INTEGER DEFAULT 0"],
      ["challenge_results", "gid TEXT"], ["challenge_results", "times TEXT"], ["challenge_results", "mode TEXT"], ["answers", "verdict TEXT"],
      // Challenge Race additions: format (bo3/bo5/endless) + sudden-death flag + player count on `games`;
      // tie/tiebreaker flags on `rounds` (duel rows just leave these 0/NULL).
      ["games", "format TEXT"], ["games", "sudden_death INTEGER DEFAULT 0"], ["games", "player_count INTEGER"],
      ["rounds", "tie INTEGER DEFAULT 0"], ["rounds", "tiebreaker INTEGER DEFAULT 0"],
      // merge_audit gained a second kind of merge (by display name, not by visitor). `kind` tells
      // them apart and the two labels are what the history shows — a name merge's "sides" are names,
      // and keep_visitor/from_visitor can't hold those meaningfully.
      ["merge_audit", "kind TEXT DEFAULT 'visitor'"], ["merge_audit", "keep_label TEXT"], ["merge_audit", "from_label TEXT"]]) { // gid→guesses; times[]=speed; mode=solo/daily/link (keeps solo boards separate); verdict=ok/miss/dup
      try { await client.execute(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch (e) { /* column already exists */ }
    }
    // The result endpoint now reads a run's own guesses back to verify the score it claims, keyed on
    // gid, on every submission. Without an index that is a full scan of every answer ever typed.
    try { await client.execute(`CREATE INDEX IF NOT EXISTS idx_answers_gid ON answers(gid)`); } catch (e) {}
    // one-time backfill: tag pre-`mode` challenge_results so old solo scores stay on the geography boards.
    // daily rows (`d-%`) → 'daily'; everything else untagged → 'solo'. Idempotent (only touches NULL).
    try { await client.execute(`UPDATE challenge_results SET mode='daily' WHERE mode IS NULL AND challenge_id LIKE 'd-%'`); } catch (e) {}
    try { await client.execute(`UPDATE challenge_results SET mode='solo'  WHERE mode IS NULL`); } catch (e) {}
    // Sessions that predate referral tracking are 'unknown', NOT 'direct': claiming a visit from
    // before the column existed had no referrer would quietly inflate the direct channel forever.
    // Idempotent — every session written from now on carries a label, so this only ever touches
    // old rows (and the odd socket that connected without a browser sending clientMeta).
    try { await client.execute(`UPDATE sessions SET ref_source='unknown' WHERE ref_source IS NULL`); } catch (e) {}
    console.log("📊 stats: connected to Turso ✓");
  } catch (e) {
    console.error("📊 stats: schema init failed —", e.message);
    client = null; // give up so reads/writes no-op rather than throw
  }
}
init();

const enabled = () => !!client;
const fire = (sql, args) => { if (client) client.execute({ sql, args }).catch((e) => console.error("📊 stats write:", e.message)); };

// ---- uptime, recorded from outside ----
// Unlike every other write here this one is awaited: the caller is scripts/probe.js, a process that
// exits the moment it returns, so a fire-and-forget insert would be dropped before it left.
// Resolves false rather than throwing — a probe that can't reach the database is not a crash, and
// it is also the one outage this table can never record (see the note in the probe script).
async function recordProbe({ ok, status, ms, err }) {
  if (!client) return false;
  try {
    await client.execute({
      sql: `INSERT INTO uptime (at, ok, status, ms, err) VALUES (?,?,?,?,?)`,
      args: [Date.now(), ok ? 1 : 0, Number(status) || 0, Math.max(0, Math.round(Number(ms) || 0)), err ? String(err).slice(0, 200) : null],
    });
    return true;
  } catch (e) {
    console.error("📊 probe write:", e.message);
    return false;
  }
}

// Keep the table bounded: at one probe every five minutes this is ~8.6k rows a month, and nothing
// reads past the retention window. Awaited for the same reason as the insert.
async function pruneProbes(days = 30) {
  if (!client) return 0;
  try {
    const r = await client.execute({ sql: `DELETE FROM uptime WHERE at < ?`, args: [Date.now() - days * 864e5] });
    return Number(r.rowsAffected) || 0;
  } catch (e) { return 0; }
}

// What the dashboard's uptime panel reads. Windows are counted in probes rather than in wall-clock
// time on purpose: a scheduled runner can be late or skipped, so "23 of 24 probes succeeded" is a
// claim the data supports, where "99.6% of the last hour" would not be.
async function uptimeStats() {
  const now = Date.now();
  const win = async (sinceMs) => {
    const r = await one(`SELECT COUNT(*) n, COALESCE(SUM(ok),0) up, COALESCE(AVG(ms),0) ms FROM uptime WHERE at >= ?`, [now - sinceMs]);
    const n = Number(r?.n) || 0, up = Number(r?.up) || 0;
    return { probes: n, up, down: n - up, pct: n ? (up / n) * 100 : null, avgMs: Math.round(Number(r?.ms) || 0) };
  };
  const [day, week] = await Promise.all([win(864e5), win(7 * 864e5)]);
  const recent = await q(`SELECT at, ok, status, ms, err FROM uptime ORDER BY at DESC LIMIT 48`);
  const lastFail = await one(`SELECT at, status, err FROM uptime WHERE ok=0 ORDER BY at DESC LIMIT 1`);
  const last = recent[0] || null;
  return {
    // `last` is null when nothing has ever probed — which is different from "it is down", and the
    // panel has to say so rather than showing a red dot for a probe that never ran.
    last: last ? { at: Number(last.at), ok: !!Number(last.ok), status: Number(last.status), ms: Number(last.ms) } : null,
    day, week,
    lastFail: lastFail ? { at: Number(lastFail.at), status: Number(lastFail.status), err: lastFail.err } : null,
    recent: recent.map((r) => ({ at: Number(r.at), ok: !!Number(r.ok), status: Number(r.status), ms: Number(r.ms), err: r.err })),
  };
}

function recordGame(g) {
  fire(
    `INSERT INTO games (code,p1_id,p1_name,p1_score,p2_id,p2_name,p2_score,winner_id,winner_name,groups,timer,target,rounds,reason,started_at,ended_at,duration_ms,mode,difficulty,gid,format,sudden_death,player_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [g.code, g.p1_id || null, g.p1_name || null, g.p1_score ?? null, g.p2_id || null, g.p2_name || null, g.p2_score ?? null, g.winner_id, g.winner_name,
     g.groups, g.timer, g.target ?? null, g.rounds, g.reason, g.started_at, g.ended_at, g.duration_ms, g.mode || "mp", g.difficulty || null, g.gid || null,
     g.format || null, g.sudden_death || 0, g.player_count || null]
  );
}
function recordRound(r) {
  fire(`INSERT INTO rounds (game_code,category,grp,winner_id,winner_name,claim,proven,at,mode,difficulty,gid,tie,tiebreaker) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [r.code, r.category, r.grp, r.winner_id, r.winner_name, r.claim, r.proven, r.at, r.mode || "mp", r.difficulty || null, r.gid || null, r.tie ? 1 : 0, r.tiebreaker ? 1 : 0]);
}
// One row per player in a completed Challenge Race match — see the race_players table comment above.
function recordRacePlayers(gid, players) {
  if (!gid || !Array.isArray(players)) return;
  for (const p of players) {
    fire(`INSERT INTO race_players (gid,player_id,name,round_wins,final_rank,at) VALUES (?,?,?,?,?,?)`,
      [gid, p.id, p.name, p.roundWins || 0, p.finalRank || null, Date.now()]);
  }
}
function recordAnswer(a) {
  fire(`INSERT INTO answers (game_code,category,grp,display,off_list,at,mode,gid,player) VALUES (?,?,?,?,?,?,?,?,?)`,
    [a.code, a.category, a.grp, a.display, a.offList ? 1 : 0, a.at, a.mode || "mp", a.gid || null, a.player || null]);
}
function recordEvent(type, code, detail, mode, gid) {
  fire(`INSERT INTO events (type,code,detail,at,mode,gid) VALUES (?,?,?,?,?,?)`, [type, code || null, detail || null, Date.now(), mode || "mp", gid || null]);
}
function recordChat(c) {
  fire(`INSERT INTO chat (gid,code,name,text,at,spectator,mode) VALUES (?,?,?,?,?,?,?)`,
    [c.gid || null, c.code || null, c.name || null, c.text || null, c.at || Date.now(), c.spectator ? 1 : 0, c.mode || "mp"]);
}
function recordSession(s) {
  fire(`INSERT INTO sessions (connected_at,disconnected_at,duration_ms,device,played,joined,spectated,name,reason,mode,singleplayer,ip,visitor_id,tz,locale,geo,ref_source,referrer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [s.connected_at, s.disconnected_at, s.duration_ms, s.device, s.played ? 1 : 0, s.joined ? 1 : 0, s.spectated ? 1 : 0, s.name || null, s.reason || null, s.mode || "mp", s.singleplayer ? 1 : 0,
     s.ip || null, s.visitor_id || null, s.tz || null, s.locale || null, s.geo || null, s.ref_source || null, s.referrer || null]);
}

async function q(sql, args) { if (!client) return []; try { return (await client.execute(args ? { sql, args } : sql)).rows; } catch (e) { console.error("📊 stats read:", e.message); return []; } }
const one = async (sql, args) => (await q(sql, args))[0] || null;

// Live DB health check for the admin dashboard — a real round-trip query (not just "is the client
// object configured"), so a Turso outage shows up even though everything else fails silently/no-ops.
async function ping() {
  if (!client) return { configured: false, ok: false };
  const start = Date.now();
  try { await client.execute("SELECT 1"); return { configured: true, ok: true, ms: Date.now() - start }; }
  catch (e) { return { configured: true, ok: false, error: e.message, ms: Date.now() - start }; }
}

async function summary() {
  if (!client) return null;
  // "All-time history" totals are MULTIPLAYER duels; single-player gets its own block. Content metrics (categories/answers/skips) pool both.
  const tot = await one(`SELECT COUNT(*) games, COALESCE(SUM(rounds),0) rounds, COALESCE(AVG(duration_ms),0) avgdur FROM games WHERE mode='mp'`);
  const pl = await one(`SELECT COUNT(*) n FROM (SELECT p1_id id FROM games WHERE mode='mp' UNION SELECT p2_id FROM games WHERE mode='mp')`);
  const eggs = await one(`SELECT COUNT(*) n FROM events WHERE type='easterEgg'`);
  return {
    games: tot ? Number(tot.games) : 0,
    rounds: tot ? Number(tot.rounds) : 0,
    avgDurationMs: tot ? Number(tot.avgdur) : 0,
    players: pl ? Number(pl.n) : 0,
    categories: await q(`SELECT grp, category, COUNT(*) plays, AVG(claim) avg_claim,
        AVG(CAST(proven AS REAL)/NULLIF(claim,0)) avg_ratio
      FROM rounds GROUP BY grp, category ORDER BY plays DESC LIMIT 30`),
    perDay: await q(`SELECT date(started_at/1000,'unixepoch') day, COUNT(*) n FROM games WHERE mode='mp' GROUP BY day ORDER BY day DESC LIMIT 14`),
    startedTimes: (await q(`SELECT started_at FROM games WHERE mode='mp' AND started_at IS NOT NULL ORDER BY id DESC LIMIT 5000`)).map((r) => Number(r.started_at)),
    reasons: await q(`SELECT reason, COUNT(*) n FROM games WHERE mode='mp' GROUP BY reason ORDER BY n DESC`),
    features: await q(`SELECT type, COUNT(*) n FROM events GROUP BY type ORDER BY n DESC`),
    topAnswers: await q(`SELECT category, display, COUNT(*) n FROM answers GROUP BY category, display ORDER BY n DESC LIMIT 25`),
    namedPerCat: await q(`SELECT category, COUNT(DISTINCT display) c FROM answers WHERE off_list=0 GROUP BY category`),
    superlatives: {
      longestGame: await one(`SELECT code,p1_name,p2_name,duration_ms FROM games WHERE mode='mp' AND duration_ms IS NOT NULL ORDER BY duration_ms DESC LIMIT 1`),
      mostRounds: await one(`SELECT code,p1_name,p2_name,rounds FROM games WHERE mode='mp' ORDER BY rounds DESC LIMIT 1`),
      highestClaim: await one(`SELECT category,grp,winner_name,claim FROM rounds ORDER BY claim DESC LIMIT 1`),
      easterEggs: eggs ? Number(eggs.n) : 0,
    },
    recent: await q(`SELECT code,gid,p1_name,p2_name,p1_score,p2_score,winner_name,groups,rounds,reason,duration_ms,ended_at
      FROM games WHERE mode='mp' ORDER BY id DESC LIMIT 15`),
    skips: await q(`SELECT detail category, COUNT(*) n FROM events WHERE type='categorySkipped' AND detail IS NOT NULL GROUP BY detail ORDER BY n DESC LIMIT 25`),
    referrals: await referralStats(),
    sessions: await sessionStats(),
    solo: await soloStats(),
    daily: await dailyStats(),
    sp: await spStats(),
  };
}
// Daily-challenge analytics: overall + per-day participation.
async function dailyStats() {
  const agg = await one(`SELECT COUNT(*) n, COUNT(DISTINCT COALESCE(visitor_id,name)) players, COALESCE(AVG(total),0) avg, COALESCE(MAX(total),0) best, COUNT(DISTINCT challenge_id) days FROM challenge_results WHERE challenge_id LIKE 'd-%'`);
  // per day: plays, unique players, avg, top score + who got it (SQLite returns name from the MAX(total) row)
  const perDay = await q(`SELECT challenge_id, COUNT(*) plays, COUNT(DISTINCT COALESCE(visitor_id,name)) players, COALESCE(AVG(total),0) avg, MAX(total) top, name
    FROM challenge_results WHERE challenge_id LIKE 'd-%' GROUP BY challenge_id ORDER BY challenge_id DESC LIMIT 21`);
  return {
    plays: agg ? Number(agg.n) : 0, players: agg ? Number(agg.players) : 0,
    avg: agg ? Number(agg.avg) : 0, best: agg ? Number(agg.best) : 0, days: agg ? Number(agg.days) : 0,
    perDay,
  };
}

// Solo play = challenge runs (every solo sprint is a DB-backed, shareable challenge).
async function soloStats() {
  // "solo" = non-daily challenge runs (Quick play / choose / link challenges). Daily has its own block.
  const ch = await one(`SELECT COUNT(*) n FROM challenges WHERE id NOT LIKE 'd-%'`);
  const rs = await one(`SELECT COUNT(*) n, COUNT(DISTINCT COALESCE(visitor_id,name)) players, COALESCE(AVG(total),0) avg, COALESCE(MAX(total),0) best FROM challenge_results WHERE challenge_id NOT LIKE 'd-%'`);
  const recent = await q(`SELECT r.name, r.total, r.at, r.crown, c.rounds, c.genre, c.type
    FROM challenge_results r LEFT JOIN challenges c ON c.id = r.challenge_id
    WHERE r.challenge_id NOT LIKE 'd-%' ORDER BY r.id DESC LIMIT 20`);
  recent.forEach((x) => { try { x.rounds = JSON.parse(x.rounds || "[]"); } catch { x.rounds = []; } });
  // most-played single-category solo runs (uses SQLite JSON functions on the challenge's rounds)
  let topCats = [];
  try {
    topCats = await q(`SELECT json_extract(c.rounds,'$[0]') cat, COUNT(*) plays, COUNT(DISTINCT COALESCE(r.visitor_id,r.name)) players, COALESCE(AVG(r.total),0) avg, COALESCE(MAX(r.total),0) top
      FROM challenge_results r JOIN challenges c ON c.id = r.challenge_id
      WHERE r.challenge_id NOT LIKE 'd-%' AND json_array_length(c.rounds) = 1 AND json_extract(c.rounds,'$[0]') IS NOT NULL
      GROUP BY cat ORDER BY plays DESC, players DESC LIMIT 25`);
  } catch (e) { /* JSON funcs unavailable → skip the breakdown */ }
  return {
    challenges: ch ? Number(ch.n) : 0,
    plays: rs ? Number(rs.n) : 0,
    players: rs ? Number(rs.players) : 0,
    avg: rs ? Number(rs.avg) : 0,
    best: rs ? Number(rs.best) : 0,
    recent, topCats,
    perDay: await q(`SELECT date(at/1000,'unixepoch') day, COUNT(*) n FROM challenge_results WHERE challenge_id NOT LIKE 'd-%' GROUP BY day ORDER BY day DESC LIMIT 14`),
  };
}

async function spStats() {
  const g = await one(`SELECT COUNT(*) n, COALESCE(SUM(winner_name='You'),0) wins, COALESCE(SUM(winner_name='Bot'),0) losses FROM games WHERE mode='sp'`);
  const r = await one(`SELECT COUNT(*) n FROM rounds WHERE mode='sp'`);
  const s = await one(`SELECT COUNT(*) n, COALESCE(AVG(duration_ms),0) avg, COALESCE(SUM(played),0) played FROM sessions WHERE mode='sp' AND duration_ms IS NOT NULL`);
  return {
    games: g ? Number(g.n) : 0, wins: g ? Number(g.wins) : 0, losses: g ? Number(g.losses) : 0,
    rounds: r ? Number(r.n) : 0,
    sessions: s ? Number(s.n) : 0, avgMs: s ? Number(s.avg) : 0, played: s ? Number(s.played) : 0,
    byDifficulty: await q(`SELECT COALESCE(difficulty,'?') difficulty, COUNT(*) n, COALESCE(SUM(winner_name='You'),0) wins FROM games WHERE mode='sp' GROUP BY difficulty ORDER BY n DESC`),
    topCategories: await q(`SELECT grp, category, COUNT(*) plays FROM rounds WHERE mode='sp' GROUP BY grp,category ORDER BY plays DESC LIMIT 15`),
  };
}

// Where visitors come from, per channel (lib/referral.js labels them on the way in).
//
// Deliberately NOT filtered to mode='mp' like the other session queries: a channel that only ever
// sends solo players is still a channel that works, and splitting the answer by game mode would
// make the table useless for the question it exists to answer.
//
// Sessions alone would be the misleading number — "reddit: 12" says nothing about whether those 12
// bounced. `played` counts a visit where someone actually played SOMETHING (a duel or a solo/daily
// run, hence the OR on singleplayer), and `visitors` de-duplicates one person reconnecting five
// times, which one deploy or one flaky phone connection is enough to cause.
async function referralStats() {
  return q(`SELECT COALESCE(NULLIF(ref_source,''),'unknown') source, COUNT(*) n,
      COUNT(DISTINCT COALESCE(visitor_id, id)) visitors,
      COALESCE(SUM(played=1 OR singleplayer=1),0) played
    FROM sessions GROUP BY source ORDER BY n DESC, source LIMIT 25`);
}

async function sessionStats() {
  const agg = await one(`SELECT COUNT(*) n, COALESCE(AVG(duration_ms),0) avg, COALESCE(SUM(played),0) played, COALESCE(SUM(joined),0) joined, COALESCE(SUM(singleplayer),0) singleplayer FROM sessions WHERE mode='mp' AND duration_ms IS NOT NULL`);
  const b = await one(`SELECT
      COALESCE(SUM(duration_ms<30000),0) bounce,
      COALESCE(SUM(duration_ms>=30000 AND duration_ms<120000),0) short,
      COALESCE(SUM(duration_ms>=120000 AND duration_ms<600000),0) med,
      COALESCE(SUM(duration_ms>=600000),0) long
    FROM sessions WHERE mode='mp' AND duration_ms IS NOT NULL`);
  return {
    total: agg ? Number(agg.n) : 0,
    avgMs: agg ? Number(agg.avg) : 0,
    played: agg ? Number(agg.played) : 0,
    joined: agg ? Number(agg.joined) : 0,
    singleplayer: agg ? Number(agg.singleplayer) : 0,
    buckets: { bounce: Number(b?.bounce || 0), short: Number(b?.short || 0), med: Number(b?.med || 0), long: Number(b?.long || 0) },
    devices: await q(`SELECT device, COUNT(*) n, AVG(duration_ms) avg FROM sessions WHERE mode='mp' AND duration_ms IS NOT NULL GROUP BY device`),
    times: (await q(`SELECT connected_at FROM sessions WHERE mode='mp' ORDER BY id DESC LIMIT 5000`)).map((r) => Number(r.connected_at)),
    recent: await q(`SELECT connected_at, duration_ms, device, played, joined, spectated, name, singleplayer, ip, geo, tz, visitor_id FROM sessions WHERE mode='mp' ORDER BY id DESC LIMIT 20`),
  };
}

// Distinct on-list answers ever named, per category (for the category-health / never-named report).
async function namedDisplays() {
  return q(`SELECT DISTINCT category, display FROM answers WHERE off_list=0`);
}

// ---- per-game forensics (admin drill-in) ----
// Recent finished games, newest first. Each has a gid to drill into.
async function gamesList(limit = 60) {
  return q(`SELECT id, gid, code, mode, p1_name, p1_score, p2_name, p2_score, winner_name, reason,
    groups, timer, target, rounds, difficulty, started_at, ended_at, duration_ms
    FROM games ORDER BY id DESC LIMIT ?`, [limit]);
}
// Everything tied to one game instance (by gid): meta + rounds + answers + chat + events.
async function gameDetail(gid) {
  if (!gid) return null;
  const game = await one(`SELECT * FROM games WHERE gid=? ORDER BY id DESC LIMIT 1`, [gid]);
  return {
    game,
    rounds: await q(`SELECT category, grp, winner_name, claim, proven, at FROM rounds WHERE gid=? ORDER BY at ASC, id ASC`, [gid]),
    answers: await q(`SELECT category, grp, display, off_list, player, at FROM answers WHERE gid=? ORDER BY at ASC, id ASC`, [gid]),
    chat: await q(`SELECT name, text, spectator, at FROM chat WHERE gid=? ORDER BY at ASC, id ASC`, [gid]),
    events: await q(`SELECT type, detail, at FROM events WHERE gid=? ORDER BY at ASC, id ASC`, [gid]),
  };
}

// Server-wide chat feed (newest first), with optional name/text search.
async function allChat(limit = 200, search = "") {
  const s = String(search || "").trim();
  if (s) {
    const like = "%" + s + "%";
    return q(`SELECT name, text, code, gid, spectator, at, mode FROM chat WHERE text LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT ?`, [like, like, limit]);
  }
  return q(`SELECT name, text, code, gid, spectator, at, mode FROM chat ORDER BY id DESC LIMIT ?`, [limit]);
}
// Repeat-visitor rollup, keyed by the persistent anonymous visitor id.
async function visitors(limit = 100) {
  return q(`SELECT visitor_id,
      COUNT(*) visits,
      MIN(connected_at) first_seen, MAX(connected_at) last_seen,
      COALESCE(SUM(played),0) played, COALESCE(SUM(joined),0) joined,
      MAX(geo) geo, MAX(tz) tz, MAX(ip) ip, MAX(device) device,
      GROUP_CONCAT(DISTINCT name) names
    FROM sessions WHERE visitor_id IS NOT NULL GROUP BY visitor_id ORDER BY visits DESC, last_seen DESC LIMIT ?`, [limit]);
}

// Full recent-sessions feed (every visit, newest first) with all the per-visit detail.
async function sessionsList(limit = 300) {
  return q(`SELECT connected_at, duration_ms, device, played, joined, spectated, name, singleplayer, ip, geo, tz, locale, visitor_id, mode, reason
            FROM sessions ORDER BY id DESC LIMIT ?`, [limit]);
}

// The creator's display NAME, from the newest crowned run. Display only — it decides what the
// merged crowned entry is labelled when several crowned rows disagree, and nothing else. It must
// never decide WHICH rows are the creator's: see the note on isCreator below.
async function getCreatorName() {
  const r = await one(`SELECT name FROM challenge_results WHERE crown=1 ORDER BY id DESC LIMIT 1`);
  return r ? r.name : null;
}
// The name half of a board grouping key. Trimmed and lowercased so "jayden" and "Jayden " from one
// device are still one entry — this is a grouping key, NOT an identity check: a shared name confers
// nothing on its own (see isCreator below), it only has to stop trivial spacing/case differences
// from splitting a real player in two.
const nameKey = (s) => String(s == null ? "" : s).trim().toLowerCase();

// Collapse rows [{name, visitor_id, score, at, crown, ...}] into a ranked board: one entry per
// visitor+name, with every crowned row merged into a single crowned entry.
function collapseBoard(rows, limit = 50, forcedName) {
  const crownRow = rows.find((r) => r.crown);
  const creatorDisplay = crownRow ? crownRow.name : (forcedName || null);
  const tv = (t) => (t == null || !(t > 0)) ? Infinity : Number(t); // no full-clear time → ranks last on a score tie
  const beats = (a, b) => a.score !== b.score ? a.score > b.score : tv(a.time) < tv(b.time); // higher score, else faster clear
  const best = {};
  for (const r of rows) {
    if (!(Number(r.score) > 0)) continue;
    // crown=1 ONLY. This used to also treat any row whose display name equalled the creator's as
    // the creator's own, which made a free-text field into a privilege: posting a keyless score
    // under that name rendered it with the 👑 and, being merged into __creator__, replaced the
    // creator's entry when it scored higher. crown is set only behind OWNER_KEY; a name is typed
    // by anyone. lib/leaderboard.js does the same on the client — these two must not drift, or a
    // board disagrees with itself about who someone is.
    const isCreator = !!r.crown;
    // visitor_id AND name, not visitor_id alone. Grouping on the id by itself made an injected row
    // REPLACE a real player rather than sit beside them: POST /challenge/:id/result takes visitorId
    // straight from the body and cannot verify it, and this loop keeps the best row per group along
    // with THAT row's name — so one submission under someone else's id, scoring higher, became their
    // public entry, under the submitter's chosen text. Their own score vanished from the board.
    //
    // Every board published visitor_id for every row until it was removed, so those ids are already
    // copied and cannot be rotated (they live in each player's localStorage). Not trusting the id on
    // write is the real answer and needs a per-device secret this game has nowhere to keep; until
    // then, this bounds the damage to "a stranger can add a row", which an endpoint with no accounts
    // can't prevent anyway.
    //
    // A legitimate player's rows always agree on name: renameResults rewrites every row a visitor
    // owns in one statement, so a rename keeps them grouped. The cost is that someone who typed a
    // different name on a later run without renaming shows as two entries instead of one — visible,
    // honest, and fixable from /admin/merge either way round.
    const key = isCreator ? "__creator__" : `${r.visitor_id || ""} ${nameKey(r.name)}`;
    const cand = { name: isCreator ? (creatorDisplay || r.name) : r.name, visitor_id: r.visitor_id, score: Number(r.score), time: (r.time != null && r.time > 0) ? Number(r.time) : null, at: Number(r.at), crown: isCreator ? 1 : 0, challenge_id: r.challenge_id };
    if (!best[key] || beats(cand, best[key])) best[key] = cand;
  }
  return Object.values(best).sort((a, b) => (b.score - a.score) || (tv(a.time) - tv(b.time)) || (a.at - b.at)).slice(0, limit);
}
// All-time daily high scores: each player's best single-day total across every daily puzzle.
async function dailyAllTime(limit = 50) {
  const rows = await q(`SELECT name, visitor_id, total score, at, crown, challenge_id FROM challenge_results WHERE challenge_id LIKE 'd-%'`);
  return collapseBoard(rows, limit, await getCreatorName());
}

// ---- egress accounting (feeds the admin cost projection) ----
const utcDay = (ts) => new Date(ts || Date.now()).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
// Add a flushed batch of served bytes / requests to today's row (server accumulates in memory, flushes here).
function addBandwidth(bytes, reqs) {
  fire(`INSERT INTO bandwidth (day,bytes,reqs) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET bytes=bytes+excluded.bytes, reqs=reqs+excluded.reqs`,
    [utcDay(), Math.round(bytes) || 0, Math.round(reqs) || 0]);
}
// Per-day egress (last 35 days) + this-calendar-month totals, for the dashboard's spend forecast.
async function bandwidthStats() {
  const perDay = await q(`SELECT day, bytes, reqs FROM bandwidth ORDER BY day DESC LIMIT 35`);
  const month = utcDay().slice(0, 7); // YYYY-MM
  const m = await one(`SELECT COALESCE(SUM(bytes),0) bytes, COALESCE(SUM(reqs),0) reqs FROM bandwidth WHERE day LIKE ?`, [month + "%"]);
  return { perDay, monthBytes: Number(m.bytes) || 0, monthReqs: Number(m.reqs) || 0 };
}
// ---- tiny key/value store ----
async function kvGet(k) { const r = await one(`SELECT v FROM kv WHERE k=?`, [k]); return r ? r.v : null; }
function kvSet(k, v) { fire(`INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, [k, v == null ? null : String(v)]); }

// Per-category leaderboards (admin-only, private): every challenge round is "player named N in category C".
// Unpacks each result's parallel scores[]/rounds[] arrays in JS (small dataset), dedupes to each player's
// best per category, and returns categories busiest-first.
async function categoryLeaderboards(topN = 10) {
  const chs = await q(`SELECT id, rounds FROM challenges`);
  const roundsById = {};
  for (const c of chs) { try { roundsById[c.id] = JSON.parse(c.rounds || "[]"); } catch (e) { roundsById[c.id] = []; } }
  const results = await q(`SELECT challenge_id, name, visitor_id, scores, at FROM challenge_results`);
  const byCat = {};
  for (const r of results) {
    const rounds = roundsById[r.challenge_id]; if (!rounds || !rounds.length) continue;
    let scores; try { scores = JSON.parse(r.scores || "[]"); } catch (e) { scores = []; }
    rounds.forEach((cat, i) => {
      const sc = Number(scores[i]) || 0; if (sc <= 0) return;
      (byCat[cat] = byCat[cat] || []).push({ name: r.name, visitor_id: r.visitor_id, score: sc, at: Number(r.at) });
    });
  }
  const out = [];
  for (const [cat, entries] of Object.entries(byCat)) {
    const best = {};
    for (const e of entries) { const key = e.visitor_id || ("name:" + e.name); if (!best[key] || e.score > best[key].score) best[key] = e; }
    const players = Object.values(best).sort((a, b) => b.score - a.score || a.at - b.at);
    out.push({ category: cat, runs: entries.length, players: players.length, top: players.slice(0, topN) });
  }
  out.sort((a, b) => b.runs - a.runs || b.players - a.players);
  return out;
}

// Public per-category leaderboard: each player's best score for one category across all runs
// (solo/daily/link). Deduped per visitor; all crowned rows collapse to a single creator entry.
async function categoryLeaderboard(catName, limit = 50) {
  const chs = await q(`SELECT id, rounds, timer FROM challenges`);
  const roundsById = {}, timerById = {};
  for (const c of chs) { try { roundsById[c.id] = JSON.parse(c.rounds || "[]"); } catch (e) { roundsById[c.id] = []; } timerById[c.id] = c.timer; }
  // Geography boards count solo-map plays (mode='solo') AND shared friend-link plays (mode='link')
  // that used the "recommended time per round" setting (timer===0) — i.e. the same per-category
  // timing a direct solo play always uses, so it's still an apples-to-apples comparison. A link with
  // a custom fixed timer is excluded (it could be way longer/shorter than the category's standard
  // length). Live-multiplayer lives in the separate `games` table and never reached here.
  const results = await q(`SELECT challenge_id, name, visitor_id, scores, times, at, crown, mode FROM challenge_results WHERE mode='solo' OR mode='link'`);
  const rows = [];
  for (const r of results) {
    if (r.mode === "link" && timerById[r.challenge_id] !== 0) continue; // not the recommended-time setting
    const rounds = roundsById[r.challenge_id]; if (!rounds || !rounds.length) continue;
    let scores = [], times = []; try { scores = JSON.parse(r.scores || "[]"); } catch (e) {} try { times = JSON.parse(r.times || "[]"); } catch (e) {}
    let sc = 0, tm = null; // best score for this category + its completion time
    rounds.forEach((cn, i) => { if (cn === catName) { const s = Number(scores[i]) || 0; if (s > sc) { sc = s; tm = times[i] != null ? Number(times[i]) : null; } } });
    if (sc > 0) rows.push({ name: r.name, visitor_id: r.visitor_id, score: sc, time: tm, at: Number(r.at), crown: r.crown });
  }
  return collapseBoard(rows, limit, await getCreatorName());
}

// GOAT board: ONE overall ranking across every geography category. Same eligibility as the
// per-category boards below: solo runs, plus shared-link runs that used the recommended time
// (see the WHERE clause) — the daily has its own board and never lands here.
// The score rewards volume, and speed only ever helps, never hurts:
//   • each answer you name is worth 1 base point (so a lucky 1-answer run stays tiny — speed can't inflate it)
//   • on a FULL clear we know how long it took, so those points get a speed bonus: 1× using the whole
//     recommended time (no penalty for a leisurely pace — a full clear is a full clear), up to 2× for
//     clearing well under it. The reference pace is that CATEGORY's own recommended-time ÷ its item
//     count, not one flat number, so a tight category (few seconds/item allotted) and a loose one (many
//     seconds/item) both score a plain full clear as 1×, not one of them as an automatic bonus or penalty.
//   • a player's points in a category = their single best play; GOAT total = the sum across all categories
// → to top it you need to name a lot, across many categories — going fast on top of that pads the total,
// but taking your time on a full clear never costs you the points you already earned by finishing it.
async function geoGoat(limit = 50) {
  const CATEGORY_GROUPS = require("../data/categories.js");
  const { FLAG_CAT_NAMES, FLAG_SOURCE } = require("../lib/flags.js");
  const { BORDER_CAT_NAMES, BORDER_SOURCE, NO_POLYGON } = require("../lib/borders.js");
  const { RECOMMENDED_TIME } = require("../lib/solo-catalog.js");
  const { norm } = require("../lib/solo-matching.js");
  const geoCats = new Map(); // geography category name → total item count
  if (CATEGORY_GROUPS.Geography) for (const c of CATEGORY_GROUPS.Geography.cats) geoCats.set(c.name, (c.items || []).length);
  // Flags/Borders quizzes aren't real categories.js entries (see lib/flags.js, lib/borders.js),
  // but they're geography knowledge same as the rest of this board, so they count toward it too
  // — same item count as the "Countries in ..." category they share entries with (minus the
  // couple of countries a Borders quiz has no drawable shape for).
  for (const [baseName, flagName] of FLAG_SOURCE) if (geoCats.has(baseName)) geoCats.set(flagName, geoCats.get(baseName));
  for (const [baseName, borderName] of BORDER_SOURCE) {
    if (!geoCats.has(baseName)) continue;
    const base = CATEGORY_GROUPS.Geography.cats.find((c) => c.name === baseName);
    const n = (base.items || []).filter((it) => !NO_POLYGON.has(norm(Array.isArray(it) ? it[0] : it))).length;
    geoCats.set(borderName, n);
  }
  for (const name of [...FLAG_CAT_NAMES, ...BORDER_CAT_NAMES]) if (!geoCats.has(name)) geoCats.set(name, 0); // never divide by zero below
  const refPaceFor = (cat) => (RECOMMENDED_TIME[cat] || 45) / (geoCats.get(cat) || 1); // seconds/answer at a plain full clear
  const chs = await q(`SELECT id, rounds, timer FROM challenges`);
  const roundsById = {}, timerById = {};
  for (const c of chs) { try { roundsById[c.id] = JSON.parse(c.rounds || "[]"); } catch (e) { roundsById[c.id] = []; } timerById[c.id] = c.timer; }
  // Same solo+link (recommended-timer-only) eligibility as categoryLeaderboard() above.
  const results = await q(`SELECT challenge_id, name, visitor_id, scores, times, crown, mode FROM challenge_results WHERE mode='solo' OR mode='link'`);
  const creator = (await getCreatorName()) || null; // what to LABEL the merged crowned entry — not who it is
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const players = new Map(); // key → { name, visitor_id, crown, best: Map<cat, points> }
  for (const r of results) {
    if (r.mode === "link" && timerById[r.challenge_id] !== 0) continue; // not the recommended-time setting
    const rounds = roundsById[r.challenge_id]; if (!rounds || !rounds.length) continue;
    let scores = [], times = []; try { scores = JSON.parse(r.scores || "[]"); } catch (e) {} try { times = JSON.parse(r.times || "[]"); } catch (e) {}
    const isCreator = !!r.crown; // crown=1 only — see the note in collapseBoard()
    // visitor_id + name, matching collapseBoard — an injected row must not be able to replace a real
    // player's entry here either. GOAT is the board where it would matter most: it aggregates a
    // visitor's best per category across their whole history, so a takeover inherits all of it.
    const key = isCreator ? "__creator__" : `${r.visitor_id || ""} ${nameKey(r.name)}`;
    let p = players.get(key);
    if (!p) { p = { name: isCreator ? (creator || r.name) : r.name, visitor_id: isCreator ? null : r.visitor_id, crown: isCreator ? 1 : 0, best: new Map() }; players.set(key, p); }
    rounds.forEach((cat, i) => {
      if (!geoCats.has(cat)) return;
      const s = Number(scores[i]) || 0; if (s <= 0) return;
      const t = (times[i] != null && Number(times[i]) > 0) ? Number(times[i]) : null; // seconds — set only on a full clear
      const mult = t ? clamp(refPaceFor(cat) / (t / s), 1.0, 2.0) : 1.0;
      const pts = s * mult;
      if (pts > (p.best.get(cat) || 0)) p.best.set(cat, pts);
    });
  }
  const rows = [];
  for (const p of players.values()) {
    if (!p.best.size) continue;
    let goat = 0; for (const v of p.best.values()) goat += v;
    rows.push({ name: p.name, visitor_id: p.visitor_id, crown: p.crown, goat: Math.round(goat), cats: p.best.size });
  }
  rows.sort((a, b) => b.goat - a.goat || b.cats - a.cats);
  return rows.slice(0, limit);
}

// Recent leaderboard entries across all challenges (for owner moderation), each with its row id.
async function recentResults(limit = 300) {
  return q(`SELECT cr.id, cr.challenge_id, cr.name, cr.visitor_id, cr.total, cr.at, c.type, c.genre
            FROM challenge_results cr LEFT JOIN challenges c ON c.id = cr.challenge_id
            ORDER BY cr.id DESC LIMIT ?`, [limit]);
}
// Does this run id belong to this visitor? The rename below rewrites every row a visitor owns, so
// something has to prove the caller IS that visitor — and `visitor_id` cannot be that proof,
// because every public leaderboard response publishes it for every row (see getChallengeResults,
// dailyAllTime, categoryLeaderboard, geoGoat). Anyone could read a board and rename a stranger.
//
// `gid` is the run id the client mints per run. It is never included in any player-facing
// response, so possessing one is evidence of having actually played a run as that visitor. Weaker
// than a real account, which this game deliberately doesn't have — but it is a secret rather than
// a public label, which is the property that matters here.
async function gidOwnedBy(gid, visitorId) {
  if (!client || !gid || !visitorId) return false;
  const r = await one(`SELECT 1 ok FROM challenge_results WHERE gid=? AND visitor_id=? LIMIT 1`, [gid, visitorId]);
  return !!r;
}

// Rename a player's leaderboard entries everywhere (across all challenges/days). Renames the
// visitor's rows; when crownAll is set (verified owner key) also renames every crowned row, so the
// creator's name stays consistent across devices.
//
// Callers must have established ownership first — see gidOwnedBy and the route in
// routes/challenge.js. This function trusts what it is handed.
async function renameResults({ name, visitorId, crownAll }) {
  if (!client) return 0;
  let n = 0;
  try {
    if (visitorId) { const r = await client.execute({ sql: `UPDATE challenge_results SET name=? WHERE visitor_id=?`, args: [name, visitorId] }); n += r.rowsAffected || 0; }
    if (crownAll) { const r = await client.execute({ sql: `UPDATE challenge_results SET name=? WHERE crown=1`, args: [name] }); n += r.rowsAffected || 0; }
  } catch (e) { console.error("📊 rename:", e.message); }
  return n;
}
// ---- owner-side rename (admin moderation) ----
// Distinct from renameResults above, which is the *player's* own "update my name" path and is gated
// on proving they own the identity (gidOwnedBy). This one is gated on OWNER_KEY at the route and can
// therefore rewrite anybody's entry — so it is the one that has to leave a record, and it writes the
// audit row itself rather than trusting a caller to remember.
//
// scope is a deliberate choice at the call site, not an inference:
//   "row"     → this one entry
//   "visitor" → every entry that visitor ever submitted, on every board
// A "rename every row that happens to share this display name" scope is intentionally absent: two
// unrelated players can pick the same name, and that scope would silently rewrite the innocent one.
async function adminRename({ rowId, scope = "row", name, by = null }) {
  if (!client) return { ok: false, rows: 0, reason: "off" };
  const id = parseInt(rowId, 10);
  if (!id) return { ok: false, rows: 0, reason: "no-row" };
  const to = String(name == null ? "" : name).trim();
  if (!to) return { ok: false, rows: 0, reason: "no-name" };
  const row = await one(`SELECT id, name, visitor_id FROM challenge_results WHERE id=?`, [id]);
  if (!row) return { ok: false, rows: 0, reason: "not-found" };
  // Read the old name BEFORE the update, or the audit row records the new name as the old one.
  const from = row.name == null ? "" : String(row.name);
  const visitorId = row.visitor_id ? String(row.visitor_id) : null;
  // Fall back to the single row when the entry has no visitor_id at all (rows predating the column,
  // and anonymous submissions): a visitor-wide rename keyed on NULL would match every such row.
  const wide = scope === "visitor" && !!visitorId;
  const rows = await (async () => {
    const sql = wide
      ? `UPDATE challenge_results SET name=? WHERE visitor_id=?`
      : `UPDATE challenge_results SET name=? WHERE id=?`;
    try {
      const r = await client.execute({ sql, args: [to, wide ? visitorId : id] });
      return Number(r.rowsAffected) || 0;
    } catch (e) {
      console.error("📊 admin rename:", e.message);
      return null; // distinct from 0: the write failed, rather than matching nothing
    }
  })();
  if (rows == null) return { ok: false, rows: 0, reason: "write-failed" };
  // Awaited, not fire()'d: the whole point is that the old name survives the update, and a
  // fire-and-forget insert can lose the race with a process restart.
  try {
    await client.execute({
      sql: `INSERT INTO name_audit (at, scope, row_id, visitor_id, old_name, new_name, rows, by_who) VALUES (?,?,?,?,?,?,?,?)`,
      args: [Date.now(), wide ? "visitor" : "row", id, visitorId, from, to, rows, by ? String(by).slice(0, 60) : null],
    });
  } catch (e) { console.error("📊 rename audit:", e.message); }
  return { ok: true, rows, from, to, scope: wide ? "visitor" : "row", visitorId };
}

// ---- merging two visitors into one ----
// There are no accounts in this game: a player's identity on the boards is `visitor_id`, minted in
// localStorage per browser (lib/browser/storage.js). So the same person playing on their phone and
// their laptop is two "players", and clearing site data makes a third. Merging is reassigning one
// visitor's leaderboard rows to another, which is exactly what collapseBoard()/geoGoat group by —
// so after a merge the boards show one entry instead of two.
//
// Renaming cannot do this. Since the crown fix, two rows sharing a display name confer nothing on
// each other; they stay two entries. visitor_id is the only thing that joins rows into a player.
//
// Deliberately limited to `challenge_results`. `sessions` also carries visitor_id, and rewriting it
// there would tidy /admin/visitors — but those rows are the record of who actually visited from
// where and when, and rewriting history to make a report look neater is how a report stops being
// evidence. The boards are the thing being merged; the visit log is left alone.
const MERGE_ROW_CAP = 2000; // refuse rather than write an unbounded snapshot blob

// Every visitor with at least one leaderboard entry, for the admin merge picker. Grouped from
// challenge_results rather than sessions: these are the identities that actually appear on a board.
async function resultVisitors(limit = 200) {
  return q(`SELECT visitor_id,
      COUNT(*) entries, MAX(total) best, MIN(at) first_at, MAX(at) last_at,
      MAX(crown) crown, GROUP_CONCAT(DISTINCT name) names
    FROM challenge_results WHERE visitor_id IS NOT NULL AND visitor_id <> ''
    GROUP BY visitor_id ORDER BY entries DESC, last_at DESC LIMIT ?`,
  [Math.max(1, Math.min(1000, parseInt(limit, 10) || 200))]);
}

// Fold `from`'s entries into `keep`. `name`, if given, is applied to the moved rows as well, since
// merging two identities that display different names and leaving both on one entry's history is
// rarely what the owner meant.
async function mergeVisitors({ keep, from, name = null, by = null }) {
  if (!client) return { ok: false, rows: 0, reason: "off" };
  const to = String(keep || "").trim();
  const src = String(from || "").trim();
  if (!to || !src) return { ok: false, rows: 0, reason: "missing" };
  // Not a no-op — a self-merge with a rename would silently become a bulk rename, which is a
  // different operation with a different audit trail.
  if (to === src) return { ok: false, rows: 0, reason: "same" };
  const newName = name == null ? null : String(name).trim() || null;
  // Snapshot BEFORE the update: once both sides share one visitor_id, which rows came from `src`
  // is unrecoverable, so this is the only chance to record it.
  const moving = await q(`SELECT id, visitor_id, name FROM challenge_results WHERE visitor_id=?`, [src]);
  if (!moving.length) return { ok: false, rows: 0, reason: "nothing-to-merge" };
  if (moving.length > MERGE_ROW_CAP) return { ok: false, rows: 0, reason: "too-many", found: moving.length };
  const snapshot = JSON.stringify(moving.map((r) => ({ i: Number(r.id), v: r.visitor_id, n: r.name })));
  const rows = await (async () => {
    try {
      const r = newName
        ? await client.execute({ sql: `UPDATE challenge_results SET visitor_id=?, name=? WHERE visitor_id=?`, args: [to, newName, src] })
        : await client.execute({ sql: `UPDATE challenge_results SET visitor_id=? WHERE visitor_id=?`, args: [to, src] });
      return Number(r.rowsAffected) || 0;
    } catch (e) {
      console.error("📊 merge visitors:", e.message);
      return null;
    }
  })();
  if (rows == null) return { ok: false, rows: 0, reason: "write-failed" };
  try {
    await client.execute({
      sql: `INSERT INTO merge_audit (at, kind, keep_visitor, from_visitor, keep_label, from_label, rows, snapshot, renamed, by_who, undone_at) VALUES (?,'visitor',?,?,?,?,?,?,?,?,NULL)`,
      args: [Date.now(), to, src, to, src, rows, snapshot, newName, by ? String(by).slice(0, 60) : null],
    });
  } catch (e) { console.error("📊 merge audit:", e.message); }
  return { ok: true, rows, keep: to, from: src, renamed: newName };
}

// ---- fixing a split crown ----
// Crown is decided per-submission (whether OWNER_KEY was live in the browser at the moment that
// run finished), not per-visitor, so the owner's own device can end up with a mix of crowned and
// un-crowned rows — mergeVisitors can't fix this, since both sides are already the same
// visitor_id. This just corrects the flag across everything one visitor has ever played.
async function crownVisitorRows({ visitorId, on = true, by = null }) {
  if (!client) return { ok: false, rows: 0, reason: "off" };
  const vid = String(visitorId || "").trim();
  if (!vid) return { ok: false, rows: 0, reason: "missing" };
  const want = on ? 1 : 0;
  const rows = await (async () => {
    try {
      const r = await client.execute({ sql: `UPDATE challenge_results SET crown=? WHERE visitor_id=? AND crown=?`, args: [want, vid, want ? 0 : 1] });
      return Number(r.rowsAffected) || 0;
    } catch (e) {
      console.error("📊 crown visitor:", e.message);
      return null;
    }
  })();
  if (rows == null) return { ok: false, rows: 0, reason: "write-failed" };
  if (rows === 0) return { ok: false, rows: 0, reason: "nothing-to-crown" };
  try {
    await client.execute({
      sql: `INSERT INTO crown_audit (at, visitor_id, crowned, rows, by_who) VALUES (?,?,?,?,?)`,
      args: [Date.now(), vid, want, rows, by ? String(by).slice(0, 60) : null],
    });
  } catch (e) { console.error("📊 crown audit:", e.message); }
  return { ok: true, rows, visitorId: vid, crowned: !!want };
}
async function crownAuditList(limit = 25) {
  return q(`SELECT id, at, visitor_id, crowned, rows, by_who FROM crown_audit ORDER BY id DESC LIMIT ?`,
    [Math.max(1, Math.min(200, parseInt(limit, 10) || 25))]);
}

// ---- merging two display NAMES into one ----
// The duplicate an owner actually sees is two names, not two ids: "jayden" and "Jayden" side by side
// on a board, obviously one person. mergeVisitors can fix that a pair at a time, but a name is not
// an identity — one name can span several visitor_ids (a phone, a laptop, a cleared cache), and each
// of those is a separate merge. This does the whole thing in one action.
//
// Merging names has to move visitor_id too, not just rewrite `name`. collapseBoard()/geoGoat group by
// visitor_id, so two rows that merely share a name stay two entries — which is the exact complaint
// this is meant to fix. So every row under both names ends up on ONE canonical visitor_id.
//
// The risk, stated plainly because it cannot be designed away: if two genuinely different people
// picked the same display name, this fuses them into one player and their scores become one score.
// Nothing in the data can distinguish that case from the intended one. resultNames() therefore
// reports how many distinct visitors each name covers, so the picker can show it and the admin page
// can warn before a name covering several is merged.
async function resultNames(limit = 300) {
  return q(`SELECT name,
      COUNT(*) entries, COUNT(DISTINCT visitor_id) visitors, MAX(total) best,
      MIN(at) first_at, MAX(at) last_at, MAX(crown) crown
    FROM challenge_results WHERE name IS NOT NULL AND name <> ''
    GROUP BY name ORDER BY entries DESC, last_at DESC LIMIT ?`,
  [Math.max(1, Math.min(1000, parseInt(limit, 10) || 300))]);
}

async function mergeNames({ keepName, fromName, by = null }) {
  if (!client) return { ok: false, rows: 0, reason: "off" };
  const keep = String(keepName || "").trim();
  const drop = String(fromName || "").trim();
  if (!keep || !drop) return { ok: false, rows: 0, reason: "missing" };
  // Compared exactly, not case-insensitively: "jayden" vs "Jayden" being DIFFERENT options is what
  // makes them mergeable here, so treating them as the same would refuse the commonest case.
  if (keep === drop) return { ok: false, rows: 0, reason: "same" };
  // Snapshot both sides before anything moves — the keep side included, because its rows may be
  // getting a new visitor_id too, and an undo has to put those back as well.
  const moving = await q(
    `SELECT id, visitor_id, name FROM challenge_results WHERE name=? OR name=? ORDER BY total DESC, at DESC`,
    [keep, drop]);
  if (!moving.length) return { ok: false, rows: 0, reason: "nothing-to-merge" };
  if (moving.length > MERGE_ROW_CAP) return { ok: false, rows: 0, reason: "too-many", found: moving.length };
  // Canonical id: prefer one already used by the name being KEPT (its highest-scoring row, since the
  // query is ordered by total), then any id on either side. Synthesised only if neither side has one
  // at all — rows predating the visitor_id column. Inventing an id for those is safe precisely
  // because they never matched a real device: it groups them without taking anything from anyone.
  const canonical =
    moving.find((r) => r.name === keep && r.visitor_id)?.visitor_id ||
    moving.find((r) => r.visitor_id)?.visitor_id ||
    "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const snapshot = JSON.stringify(moving.map((r) => ({ i: Number(r.id), v: r.visitor_id, n: r.name })));
  const rows = await (async () => {
    try {
      const r = await client.execute({
        sql: `UPDATE challenge_results SET visitor_id=?, name=? WHERE name=? OR name=?`,
        args: [canonical, keep, keep, drop],
      });
      return Number(r.rowsAffected) || 0;
    } catch (e) {
      console.error("📊 merge names:", e.message);
      return null;
    }
  })();
  if (rows == null) return { ok: false, rows: 0, reason: "write-failed" };
  try {
    await client.execute({
      sql: `INSERT INTO merge_audit (at, kind, keep_visitor, from_visitor, keep_label, from_label, rows, snapshot, renamed, by_who, undone_at) VALUES (?,'name',?,NULL,?,?,?,?,?,?,NULL)`,
      args: [Date.now(), canonical, keep, drop, rows, snapshot, keep, by ? String(by).slice(0, 60) : null],
    });
  } catch (e) { console.error("📊 merge names audit:", e.message); }
  return { ok: true, rows, keep, from: drop, visitorId: canonical };
}

// Put a merge back: every row named in the snapshot returns to the visitor_id and name it had.
// Row-by-row rather than one UPDATE, because the rows are only identifiable individually now —
// their visitor_id is the one they were merged INTO, shared with rows that were always there.
async function undoMerge(auditId, by = null) {
  if (!client) return { ok: false, rows: 0, reason: "off" };
  const id = parseInt(auditId, 10);
  if (!id) return { ok: false, rows: 0, reason: "missing" };
  const rec = await one(`SELECT id, snapshot, undone_at FROM merge_audit WHERE id=?`, [id]);
  if (!rec) return { ok: false, rows: 0, reason: "not-found" };
  if (rec.undone_at) return { ok: false, rows: 0, reason: "already-undone" };
  const snap = (() => { try { return JSON.parse(rec.snapshot || "[]"); } catch (e) { return []; } })();
  if (!Array.isArray(snap) || !snap.length) return { ok: false, rows: 0, reason: "no-snapshot" };
  try {
    await client.batch(snap.map((r) => ({
      sql: `UPDATE challenge_results SET visitor_id=?, name=? WHERE id=?`,
      args: [r.v, r.n, Number(r.i)],
    })), "write");
  } catch (e) {
    console.error("📊 undo merge:", e.message);
    return { ok: false, rows: 0, reason: "write-failed" };
  }
  // Only after the restore actually landed: a merge marked undone that wasn't would hide the one
  // record able to put it right.
  try {
    await client.execute({ sql: `UPDATE merge_audit SET undone_at=?, by_who=COALESCE(?,by_who) WHERE id=?`, args: [Date.now(), by ? String(by).slice(0, 60) : null, id] });
  } catch (e) { console.error("📊 undo merge mark:", e.message); }
  return { ok: true, rows: snap.length };
}

// The merge history, newest first. Carries enough to undo each one (and whether it already was).
async function mergeAuditList(limit = 25) {
  return q(`SELECT id, at, kind, keep_visitor, from_visitor, keep_label, from_label, rows, renamed, by_who, undone_at
            FROM merge_audit ORDER BY id DESC LIMIT ?`, [Math.max(1, Math.min(200, parseInt(limit, 10) || 25))]);
}

// The rename history, newest first — what makes an owner rename undoable.
async function nameAuditList(limit = 25) {
  return q(`SELECT at, scope, row_id, visitor_id, old_name, new_name, rows, by_who
            FROM name_audit ORDER BY id DESC LIMIT ?`, [Math.max(1, Math.min(200, parseInt(limit, 10) || 25))]);
}

// Delete a single leaderboard entry by its row id (owner moderation).
async function deleteResult(rowId) {
  if (!client) return 0;
  try { const r = await client.execute({ sql: `DELETE FROM challenge_results WHERE id=?`, args: [rowId] }); return r.rowsAffected || 0; }
  catch (e) { console.error("📊 delete result:", e.message); return 0; }
}

// ---- async challenges (link-based, with a shared per-challenge leaderboard) ----
async function createChallenge(c) {
  if (!client) return false;
  try {
    await client.execute({ sql: `INSERT INTO challenges (id,type,genre,rounds,by_name,created_at,timer) VALUES (?,?,?,?,?,?,?)`,
      args: [c.id, c.type, c.genre || null, JSON.stringify(c.rounds || []), c.by || null, Date.now(), c.timer == null ? 45 : c.timer] });
    return true;
  } catch (e) { console.error("📊 challenge create:", e.message); return false; }
}
async function getChallenge(id) {
  const r = await one(`SELECT id, type, genre, rounds, by_name, created_at, timer FROM challenges WHERE id=?`, [id]);
  if (!r) return null;
  try { r.rounds = JSON.parse(r.rounds || "[]"); } catch { r.rounds = []; }
  return r;
}
async function addChallengeResult(x) {
  if (!client) return false;
  try {
    await client.execute({ sql: `INSERT INTO challenge_results (challenge_id,name,visitor_id,scores,total,at,wpms,crown,gid,times,mode) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [x.challenge_id, x.name || "Anon", x.visitor_id || null, JSON.stringify(x.scores || []), x.total || 0, Date.now(), JSON.stringify(x.wpms || []), x.crown ? 1 : 0, x.gid || null, JSON.stringify(x.times || []), x.mode || "solo"] });
    return true;
  } catch (e) { console.error("📊 challenge result:", e.message); return false; }
}
// Store the exact guesses from one round of a solo/daily run (every Enter press: ok / miss / dup).
function recordSoloGuesses(d) {
  if (!client) return;
  for (const g of (d.guesses || [])) {
    fire(`INSERT INTO answers (game_code,category,grp,display,off_list,at,mode,gid,player,verdict) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [d.challengeId || null, d.category || null, null, String(g.display || "").slice(0, 80), 0, Number(g.at) || Date.now(), d.mode || "solo", d.gid || null, d.name || null, g.verdict || null]);
  }
}
// Every DISTINCT answer a run actually submitted, per category. This is what lets the result
// endpoint score a run server-side instead of believing the number the client sends: the guesses
// were posted round by round while the run was being played, so a claimed score can be checked
// against the answers that were typed to earn it.
//
// `verdict` is deliberately NOT read. The client decides ok/miss/dup, so trusting it here would
// just move the same unverified number one field to the left — routes/challenge.js re-matches each
// display against the category's real answer list itself.
async function runGuesses(gid) {
  if (!gid) return [];
  return q(`SELECT DISTINCT category, display FROM answers WHERE gid=?`, [String(gid).slice(0, 40)]);
}

// Recent solo/daily runs (one row per finished run) with its challenge meta + gid for drill-in.
async function soloRunsList(limit = 120) {
  return q(`SELECT cr.id, cr.gid, cr.challenge_id, cr.name, cr.visitor_id, cr.scores, cr.total, cr.at, c.type, c.genre, c.rounds
            FROM challenge_results cr LEFT JOIN challenges c ON c.id = cr.challenge_id
            ORDER BY cr.id DESC LIMIT ?`, [limit]);
}
// Everything for one solo/daily run (by gid): the result row, its challenge, and every guess in order.
async function soloRunDetail(gid) {
  if (!gid) return null;
  const result = await one(`SELECT cr.*, c.type, c.genre, c.rounds, c.timer FROM challenge_results cr LEFT JOIN challenges c ON c.id = cr.challenge_id WHERE cr.gid=? ORDER BY cr.id DESC LIMIT 1`, [gid]);
  const answers = await q(`SELECT category, display, verdict, at FROM answers WHERE gid=? ORDER BY at ASC, id ASC`, [gid]);
  return { result, answers };
}
async function getChallengeResults(id) {
  const rows = await q(`SELECT name, visitor_id, scores, total, at, wpms, crown, times FROM challenge_results WHERE challenge_id=? ORDER BY total DESC, at ASC`, [id]);
  return rows.map((r) => { try { r.scores = JSON.parse(r.scores || "[]"); } catch { r.scores = []; } try { r.wpms = JSON.parse(r.wpms || "[]"); } catch { r.wpms = []; } try { r.times = JSON.parse(r.times || "[]"); } catch { r.times = []; } return r; });
}

module.exports = { enabled, ping, recordGame, recordRound, recordAnswer, recordEvent, recordChat, recordSession, recordRacePlayers, summary, namedDisplays, gamesList, gameDetail, allChat, visitors, sessionsList, createChallenge, getChallenge, addChallengeResult, getChallengeResults, dailyAllTime, recentResults, deleteResult, categoryLeaderboards, recordSoloGuesses, runGuesses, soloRunsList, soloRunDetail, renameResults, categoryLeaderboard, getCreatorName, geoGoat, addBandwidth, bandwidthStats, kvGet, kvSet, recordProbe, pruneProbes, uptimeStats, gidOwnedBy, adminRename, nameAuditList, resultVisitors, mergeVisitors, undoMerge, mergeAuditList, resultNames, mergeNames, crownVisitorRows, crownAuditList };
