"use strict";
// Who a leaderboard row BELONGS to, decided server-side.
//
// The two public boards the server collapses itself — dailyAllTime and geoGoat — used to treat any
// row whose display name equalled the creator's as one of the creator's own rows: it merged into the
// single __creator__ entry and rendered with the 👑. A display name is free text that anybody can
// submit with a keyless score, and `crown` is set only behind OWNER_KEY, so that rule turned a text
// field into a privilege — post a high score under the creator's name and it replaced the creator's
// public entry.
//
// lib/leaderboard.js (the client's copy of the same collapse) was fixed to crown-only; these two
// server-side copies were not, and nothing covered them because they need a database. Hence the fake
// @libsql/client/web — the point is to pin the ownership rule, not the SQL.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const LIBSQL = require.resolve("@libsql/client/web");
const STATS = require.resolve("../server/stats.js");

// SQL fragment → rows to answer with.
let tables = [];

function fakeClient() {
  const respond = (sql) => {
    const hit = tables.find((t) => String(sql).includes(t.match));
    return Promise.resolve({ rows: hit ? hit.rows : [], rowsAffected: 0 });
  };
  return {
    execute: (arg) => respond(typeof arg === "string" ? arg : arg.sql),
    batch: () => Promise.resolve([]),
  };
}

let analytics, realLog, realError, savedLibsql;

before(async () => {
  realLog = console.log; console.log = () => {};
  realError = console.error; console.error = () => {};
  savedLibsql = require.cache[LIBSQL];
  require.cache[LIBSQL] = { id: LIBSQL, filename: LIBSQL, loaded: true, exports: { createClient: () => fakeClient() } };
  process.env.TURSO_URL = "libsql://fake.test";
  delete require.cache[STATS];
  analytics = require(STATS);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

after(() => {
  delete process.env.TURSO_URL;
  delete require.cache[STATS];
  if (savedLibsql) require.cache[LIBSQL] = savedLibsql; else delete require.cache[LIBSQL];
  require(STATS);
  console.log = realLog; console.error = realError;
});

beforeEach(() => { tables = []; });

const dailyRows = (rows) => tables.push({ match: "WHERE challenge_id LIKE 'd-%'", rows });
const crownName = (name) => tables.push({ match: "WHERE crown=1 ORDER BY id DESC", rows: name == null ? [] : [{ name }] });
const row = (over = {}) => ({ name: "someone", visitor_id: "v-1", score: 10, at: 1, crown: 0, challenge_id: "d-20260820", ...over });

describe("server/stats.js — dailyAllTime decides identity by crown, never by name", () => {
  test("a keyless row sharing the creator's name is its own entry, with no crown", async () => {
    // The attack this closes: 2997 posted under "jayden" used to BE jayden's entry.
    crownName("jayden");
    dailyRows([
      row({ name: "jayden", visitor_id: "v-owner", score: 45, crown: 1 }),
      row({ name: "jayden", visitor_id: "v-attacker", score: 2997, crown: 0 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 2, "the impostor must not be folded into the creator's entry");
    const top = board[0];
    assert.equal(top.score, 2997);
    assert.equal(top.crown, 0, "and must not render with the crown");
    assert.equal(top.visitor_id, "v-attacker");
    const owner = board.find((e) => e.crown === 1);
    assert.equal(owner.score, 45, "the creator's own score is still their own");
  });

  test("a name matched case- and whitespace-insensitively is still not the creator", async () => {
    // The old rule normalised both sides before comparing, so these all used to hit.
    crownName("jayden");
    dailyRows([
      row({ name: "jayden", visitor_id: "v-owner", score: 45, crown: 1 }),
      row({ name: "JAYDEN", visitor_id: "v-a", score: 100 }),
      row({ name: "  Jayden  ", visitor_id: "v-b", score: 90 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 3);
    assert.equal(board.filter((e) => e.crown === 1).length, 1);
  });

  test("every crowned row still merges into one entry, keeping the best score", async () => {
    // The feature the rule existed for: the owner playing on several devices is one line.
    crownName("jayden");
    dailyRows([
      row({ name: "jayden", visitor_id: "v-phone", score: 30, crown: 1 }),
      row({ name: "jayden", visitor_id: "v-laptop", score: 52, crown: 1 }),
      row({ name: "jayden", visitor_id: "v-tablet", score: 41, crown: 1 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 1);
    assert.equal(board[0].score, 52);
    assert.equal(board[0].crown, 1);
  });

  test("the crowned entry is labelled from the crowned row, not from a same-named stranger", async () => {
    crownName("jayden");
    dailyRows([
      row({ name: "jayden the goat", visitor_id: "v-owner", score: 45, crown: 1 }),
      row({ name: "jayden", visitor_id: "v-a", score: 10 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.find((e) => e.crown === 1).name, "jayden the goat");
  });

  test("two entries under the same name are two rows, one per visitor", async () => {
    // Which is what makes an admin MERGE (reassigning visitor_id) the only way to combine them —
    // renaming alone cannot, now that a shared name confers nothing.
    crownName(null);
    dailyRows([
      row({ name: "jayden", visitor_id: "v-a", score: 30 }),
      row({ name: "jayden", visitor_id: "v-b", score: 40 }),
      row({ name: "jayden", visitor_id: "v-c", score: 20 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 3);
    assert.deepEqual(board.map((e) => e.score), [40, 30, 20]);
  });

  test("rows sharing a visitor_id collapse to that visitor's best", async () => {
    crownName(null);
    dailyRows([
      row({ visitor_id: "v-a", score: 30, challenge_id: "d-20260819" }),
      row({ visitor_id: "v-a", score: 55, challenge_id: "d-20260820" }),
      row({ visitor_id: "v-b", score: 40 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 2);
    assert.equal(board[0].score, 55);
  });

  test("rows with no visitor_id fall back to grouping by name", async () => {
    // Pre-visitor_id rows are real and still on the board; they must not all become one player.
    crownName(null);
    dailyRows([
      row({ name: "alice", visitor_id: null, score: 30 }),
      row({ name: "alice", visitor_id: null, score: 44 }),
      row({ name: "bob", visitor_id: null, score: 20 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 2);
    assert.equal(board[0].score, 44);
  });

  test("a zero or missing score is left off the board entirely", async () => {
    crownName(null);
    dailyRows([row({ visitor_id: "v-a", score: 0 }), row({ visitor_id: "v-b", score: null }), row({ visitor_id: "v-c", score: 5 })]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 1);
    assert.equal(board[0].visitor_id, "v-c");
  });

  test("with no crowned row anywhere, nothing on the board is crowned", async () => {
    crownName(null);
    dailyRows([row({ name: "jayden", visitor_id: "v-a", score: 50 })]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board[0].crown, 0);
  });
});

describe("server/stats.js — geoGoat decides identity by crown too", () => {
  // geoGoat scores per geography category rather than per day, so it needs a challenge whose rounds
  // are a real Geography category. "Countries of the World" is one, and timer=0 is the
  // recommended-time setting the board requires.
  const geoTables = (results) => {
    tables.push({ match: "SELECT id, rounds, timer FROM challenges", rows: [{ id: "c1", rounds: JSON.stringify(["Countries of the World"]), timer: 0 }] });
    tables.push({ match: "WHERE mode='solo' OR mode='link'", rows: results });
  };
  const geoRow = (over = {}) => ({ challenge_id: "c1", name: "someone", visitor_id: "v-1", scores: "[20]", times: null, crown: 0, mode: "solo", ...over });

  test("a stranger using the creator's name gets their own row, uncrowned", async () => {
    crownName("jayden");
    geoTables([
      geoRow({ name: "jayden", visitor_id: "v-owner", scores: "[30]", crown: 1 }),
      geoRow({ name: "jayden", visitor_id: "v-attacker", scores: "[190]" }),
    ]);
    const board = await analytics.geoGoat(50);
    assert.equal(board.length, 2);
    const impostor = board.find((e) => e.visitor_id === "v-attacker");
    assert.ok(impostor, "the impostor is a separate entry");
    assert.equal(impostor.crown, 0);
  });

  test("the creator's own crowned devices still merge into one crowned entry", async () => {
    crownName("jayden");
    geoTables([
      geoRow({ name: "jayden", visitor_id: "v-phone", scores: "[30]", crown: 1 }),
      geoRow({ name: "jayden", visitor_id: "v-laptop", scores: "[60]", crown: 1 }),
    ]);
    const board = await analytics.geoGoat(50);
    const crowned = board.filter((e) => e.crown === 1);
    assert.equal(crowned.length, 1);
  });

  test("two same-named visitors stay two entries here as well", async () => {
    crownName(null);
    geoTables([
      geoRow({ name: "jayden", visitor_id: "v-a", scores: "[30]" }),
      geoRow({ name: "jayden", visitor_id: "v-b", scores: "[40]" }),
    ]);
    const board = await analytics.geoGoat(50);
    assert.equal(board.length, 2);
  });
});

// Grouping. A board groups by visitor_id AND name, not by visitor_id alone.
//
// POST /challenge/:id/result takes `visitorId` straight from the body and cannot verify it — there
// are no accounts, and every board published visitor_id for every row until it was removed, so those
// ids are already copied and cannot be rotated (they live in each player's localStorage). Grouping on
// the id alone meant one submission under someone else's id did not sit BESIDE them: this loop keeps
// the best row per group along with that row's name, so a higher score REPLACED their public entry,
// wearing the submitter's chosen text, and their own score vanished.
//
// This does not stop a stranger adding a row — an endpoint with no accounts can't. It stops them
// taking over an existing player.
describe("server/stats.js — an injected row can't replace a real player's entry", () => {
  test("a row under someone else's visitor_id appears alongside them, not instead of them", async () => {
    crownName(null);
    dailyRows([
      row({ name: "jayden", visitor_id: "v-jayden", score: 45 }),
      row({ name: "THE INEVITABLE", visitor_id: "v-jayden", score: 162 }),
      row({ name: "someone else", visitor_id: "v-other", score: 30 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 3, "the impostor must not have absorbed jayden's entry");
    const mine = board.find((e) => e.name === "jayden");
    assert.ok(mine, "jayden's own row must still be on the board");
    assert.equal(mine.score, 45);
  });

  test("one player's own repeat runs still collapse to their best", async () => {
    // The feature the grouping exists for. Same id, same name → one entry.
    crownName(null);
    dailyRows([
      row({ name: "jayden", visitor_id: "v-jayden", score: 30, challenge_id: "d-20260819" }),
      row({ name: "jayden", visitor_id: "v-jayden", score: 45, challenge_id: "d-20260820" }),
      row({ name: "jayden", visitor_id: "v-jayden", score: 22, challenge_id: "d-20260818" }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 1);
    assert.equal(board[0].score, 45);
  });

  test("case and padding differences in a name don't split a real player in two", async () => {
    // The name half is a grouping key, not an identity check — it only has to survive the client
    // storing "jayden " once and "Jayden" another time.
    crownName(null);
    dailyRows([
      row({ name: "jayden", visitor_id: "v-jayden", score: 30 }),
      row({ name: "Jayden ", visitor_id: "v-jayden", score: 45 }),
      row({ name: " JAYDEN", visitor_id: "v-jayden", score: 20 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 1);
    assert.equal(board[0].score, 45);
  });

  test("a rename keeps a player grouped, because renameResults rewrites all their rows", async () => {
    // renameResults is a single UPDATE over every row a visitor owns, so after a rename their rows
    // agree on name again. This is what makes name part of the key safe.
    crownName(null);
    dailyRows([
      row({ name: "new name", visitor_id: "v-jayden", score: 30, challenge_id: "d-20260819" }),
      row({ name: "new name", visitor_id: "v-jayden", score: 45, challenge_id: "d-20260820" }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 1);
    assert.equal(board[0].score, 45);
  });

  test("two different people who picked the same name are still two entries", async () => {
    crownName(null);
    dailyRows([
      row({ name: "jayden", visitor_id: "v-a", score: 40 }),
      row({ name: "jayden", visitor_id: "v-b", score: 30 }),
    ]);
    const board = await analytics.dailyAllTime(50);
    assert.equal(board.length, 2);
  });

  test("geoGoat groups the same way — it is the board a takeover would inherit most from", async () => {
    // GOAT aggregates a visitor's best per category across their whole history.
    crownName(null);
    tables.push({ match: "SELECT id, rounds, timer FROM challenges", rows: [{ id: "c1", rounds: JSON.stringify(["Countries of the World"]), timer: 0 }] });
    tables.push({ match: "WHERE mode='solo' OR mode='link'", rows: [
      { challenge_id: "c1", name: "jayden", visitor_id: "v-jayden", scores: "[30]", times: null, crown: 0, mode: "solo" },
      { challenge_id: "c1", name: "THE INEVITABLE", visitor_id: "v-jayden", scores: "[190]", times: null, crown: 0, mode: "solo" },
    ] });
    const board = await analytics.geoGoat(50);
    assert.equal(board.length, 2, "jayden's own GOAT standing must survive");
    assert.ok(board.some((e) => e.name === "jayden"));
  });

  test("the client's copy of the collapse uses the same key shape", () => {
    // Three implementations of one rule (collapseBoard, geoGoat, lib/leaderboard.js). If they drift,
    // a board disagrees with itself about who someone is — which is how the crown bug survived.
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "lib", "leaderboard.js"), "utf8");
    assert.match(src, /r\.vkey \|\| ""/, "keyed on the visitor token…");
    assert.match(src, /trim\(\)\.toLowerCase\(\)/, "…paired with the normalised name");
  });
});
