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
    ], "write");
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
    `INSERT INTO games (code,p1_id,p1_name,p1_score,p2_id,p2_name,p2_score,winner_id,winner_name,groups,timer,target,rounds,reason,started_at,ended_at,duration_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [g.code, g.p1_id, g.p1_name, g.p1_score, g.p2_id, g.p2_name, g.p2_score, g.winner_id, g.winner_name,
     g.groups, g.timer, g.target, g.rounds, g.reason, g.started_at, g.ended_at, g.duration_ms]
  );
}
function recordRound(r) {
  fire(`INSERT INTO rounds (game_code,category,grp,winner_id,winner_name,claim,proven,at) VALUES (?,?,?,?,?,?,?,?)`,
    [r.code, r.category, r.grp, r.winner_id, r.winner_name, r.claim, r.proven, r.at]);
}
function recordAnswer(a) {
  fire(`INSERT INTO answers (game_code,category,grp,display,off_list,at) VALUES (?,?,?,?,?,?)`,
    [a.code, a.category, a.grp, a.display, a.offList ? 1 : 0, a.at]);
}
function recordEvent(type, code, detail) {
  fire(`INSERT INTO events (type,code,detail,at) VALUES (?,?,?,?)`, [type, code || null, detail || null, Date.now()]);
}

async function q(sql, args) { if (!client) return []; try { return (await client.execute(args ? { sql, args } : sql)).rows; } catch (e) { console.error("📊 stats read:", e.message); return []; } }
const one = async (sql, args) => (await q(sql, args))[0] || null;

async function summary() {
  if (!client) return null;
  const tot = await one(`SELECT COUNT(*) games, COALESCE(SUM(rounds),0) rounds, COALESCE(AVG(duration_ms),0) avgdur FROM games`);
  const pl = await one(`SELECT COUNT(*) n FROM (SELECT p1_id id FROM games UNION SELECT p2_id FROM games)`);
  const eggs = await one(`SELECT COUNT(*) n FROM events WHERE type='easterEgg'`);
  return {
    games: tot ? Number(tot.games) : 0,
    rounds: tot ? Number(tot.rounds) : 0,
    avgDurationMs: tot ? Number(tot.avgdur) : 0,
    players: pl ? Number(pl.n) : 0,
    categories: await q(`SELECT grp, category, COUNT(*) plays, AVG(claim) avg_claim,
        AVG(CAST(proven AS REAL)/NULLIF(claim,0)) avg_ratio
      FROM rounds GROUP BY grp, category ORDER BY plays DESC LIMIT 30`),
    perDay: await q(`SELECT date(started_at/1000,'unixepoch') day, COUNT(*) n FROM games GROUP BY day ORDER BY day DESC LIMIT 14`),
    hourly: await q(`SELECT CAST(strftime('%H', started_at/1000, 'unixepoch') AS INTEGER) hr, COUNT(*) n FROM games GROUP BY hr`),
    reasons: await q(`SELECT reason, COUNT(*) n FROM games GROUP BY reason ORDER BY n DESC`),
    features: await q(`SELECT type, COUNT(*) n FROM events GROUP BY type ORDER BY n DESC`),
    topAnswers: await q(`SELECT category, display, COUNT(*) n FROM answers GROUP BY category, display ORDER BY n DESC LIMIT 25`),
    namedPerCat: await q(`SELECT category, COUNT(DISTINCT display) c FROM answers WHERE off_list=0 GROUP BY category`),
    superlatives: {
      longestGame: await one(`SELECT code,p1_name,p2_name,duration_ms FROM games WHERE duration_ms IS NOT NULL ORDER BY duration_ms DESC LIMIT 1`),
      mostRounds: await one(`SELECT code,p1_name,p2_name,rounds FROM games ORDER BY rounds DESC LIMIT 1`),
      highestClaim: await one(`SELECT category,grp,winner_name,claim FROM rounds ORDER BY claim DESC LIMIT 1`),
      easterEggs: eggs ? Number(eggs.n) : 0,
    },
    recent: await q(`SELECT code,p1_name,p2_name,p1_score,p2_score,winner_name,groups,rounds,reason,duration_ms,ended_at
      FROM games ORDER BY id DESC LIMIT 15`),
  };
}

module.exports = { enabled, recordGame, recordRound, recordAnswer, recordEvent, summary };
