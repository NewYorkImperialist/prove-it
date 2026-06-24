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
        id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id TEXT, name TEXT, visitor_id TEXT, scores TEXT, total INTEGER, at INTEGER)`,
    ], "write");
    // migrate existing tables: mode (mp/sp) + difficulty. ALTER fails harmlessly if the column already exists.
    for (const [t, c] of [["games", "mode TEXT DEFAULT 'mp'"], ["games", "difficulty TEXT"], ["rounds", "mode TEXT DEFAULT 'mp'"],
      ["rounds", "difficulty TEXT"], ["answers", "mode TEXT DEFAULT 'mp'"], ["events", "mode TEXT DEFAULT 'mp'"], ["sessions", "mode TEXT DEFAULT 'mp'"],
      ["sessions", "singleplayer INTEGER DEFAULT 0"],
      ["games", "gid TEXT"], ["rounds", "gid TEXT"], ["answers", "gid TEXT"], ["answers", "player TEXT"], ["events", "gid TEXT"],
      ["sessions", "ip TEXT"], ["sessions", "visitor_id TEXT"], ["sessions", "tz TEXT"], ["sessions", "locale TEXT"], ["sessions", "geo TEXT"],
      ["challenges", "timer INTEGER DEFAULT 45"]]) {
      try { await client.execute(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch (e) { /* column already exists */ }
    }
    console.log("📊 stats: connected to Turso ✓");
  } catch (e) {
    console.error("📊 stats: schema init failed —", e.message);
    client = null; // give up so reads/writes no-op rather than throw
  }
}
init();

const enabled = () => !!client;
const fire = (sql, args) => { if (client) client.execute({ sql, args }).catch((e) => console.error("📊 stats write:", e.message)); };

function recordGame(g) {
  fire(
    `INSERT INTO games (code,p1_id,p1_name,p1_score,p2_id,p2_name,p2_score,winner_id,winner_name,groups,timer,target,rounds,reason,started_at,ended_at,duration_ms,mode,difficulty,gid)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [g.code, g.p1_id, g.p1_name, g.p1_score, g.p2_id, g.p2_name, g.p2_score, g.winner_id, g.winner_name,
     g.groups, g.timer, g.target, g.rounds, g.reason, g.started_at, g.ended_at, g.duration_ms, g.mode || "mp", g.difficulty || null, g.gid || null]
  );
}
function recordRound(r) {
  fire(`INSERT INTO rounds (game_code,category,grp,winner_id,winner_name,claim,proven,at,mode,difficulty,gid) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [r.code, r.category, r.grp, r.winner_id, r.winner_name, r.claim, r.proven, r.at, r.mode || "mp", r.difficulty || null, r.gid || null]);
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
  fire(`INSERT INTO sessions (connected_at,disconnected_at,duration_ms,device,played,joined,spectated,name,reason,mode,singleplayer,ip,visitor_id,tz,locale,geo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [s.connected_at, s.disconnected_at, s.duration_ms, s.device, s.played ? 1 : 0, s.joined ? 1 : 0, s.spectated ? 1 : 0, s.name || null, s.reason || null, s.mode || "mp", s.singleplayer ? 1 : 0,
     s.ip || null, s.visitor_id || null, s.tz || null, s.locale || null, s.geo || null]);
}

async function q(sql, args) { if (!client) return []; try { return (await client.execute(args ? { sql, args } : sql)).rows; } catch (e) { console.error("📊 stats read:", e.message); return []; } }
const one = async (sql, args) => (await q(sql, args))[0] || null;

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
    recent: await q(`SELECT code,p1_name,p2_name,p1_score,p2_score,winner_name,groups,rounds,reason,duration_ms,ended_at
      FROM games WHERE mode='mp' ORDER BY id DESC LIMIT 15`),
    skips: await q(`SELECT detail category, COUNT(*) n FROM events WHERE type='categorySkipped' AND detail IS NOT NULL GROUP BY detail ORDER BY n DESC LIMIT 25`),
    sessions: await sessionStats(),
    sp: await spStats(),
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

// ---- async challenges (link-based, with a shared per-challenge leaderboard) ----
async function createChallenge(c) {
  if (!client) return false;
  try {
    await client.execute({ sql: `INSERT INTO challenges (id,type,genre,rounds,by_name,created_at,timer) VALUES (?,?,?,?,?,?,?)`,
      args: [c.id, c.type, c.genre || null, JSON.stringify(c.rounds || []), c.by || null, Date.now(), c.timer || 45] });
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
    await client.execute({ sql: `INSERT INTO challenge_results (challenge_id,name,visitor_id,scores,total,at) VALUES (?,?,?,?,?,?)`,
      args: [x.challenge_id, x.name || "Anon", x.visitor_id || null, JSON.stringify(x.scores || []), x.total || 0, Date.now()] });
    return true;
  } catch (e) { console.error("📊 challenge result:", e.message); return false; }
}
async function getChallengeResults(id) {
  const rows = await q(`SELECT name, visitor_id, scores, total, at FROM challenge_results WHERE challenge_id=? ORDER BY total DESC, at ASC`, [id]);
  return rows.map((r) => { try { r.scores = JSON.parse(r.scores || "[]"); } catch { r.scores = []; } return r; });
}

module.exports = { enabled, recordGame, recordRound, recordAnswer, recordEvent, recordChat, recordSession, summary, namedDisplays, gamesList, gameDetail, allChat, visitors, createChallenge, getChallenge, addChallengeResult, getChallengeResults };
