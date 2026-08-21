"use strict";
// Merging two visitors' leaderboard entries into one, at the SQL level.
//
// A merge rewrites visitor_id in place, and the moment two visitors' rows share one id, nothing
// else in the schema remembers which of them a row came from. So the snapshot taken before the
// update is the only thing that makes it undoable, and it has to be written from the pre-update
// state — the same read-before-write property the rename tool needs, with a worse failure mode,
// because a merge moves rows the owner never looked at.
//
// Loaded against a fake @libsql/client/web for the reasons given in test/stats-rename.test.js.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const LIBSQL = require.resolve("@libsql/client/web");
const STATS = require.resolve("../server/stats.js");

let log = [];        // every statement, in order
let batches = [];    // every client.batch() call (undo restores row-by-row through one)
let selects = [];
let throwOn = [];

function fakeClient() {
  const respond = (sql, args) => {
    log.push({ sql: String(sql).replace(/\s+/g, " ").trim(), args: args || [] });
    if (throwOn.some((f) => String(sql).includes(f))) return Promise.reject(new Error("connection reset"));
    const hit = selects.find((s) => String(sql).includes(s.match));
    return Promise.resolve({
      rows: hit && hit.rows ? hit.rows : [],
      rowsAffected: hit && hit.rowsAffected != null ? hit.rowsAffected : 1,
    });
  };
  return {
    execute: (arg) => (typeof arg === "string" ? respond(arg, null) : respond(arg.sql, arg.args)),
    batch: (stmts) => {
      // init()'s schema batch is a plain string array; the undo path passes {sql,args} objects.
      if (Array.isArray(stmts) && stmts.length && typeof stmts[0] === "object") {
        batches.push(stmts);
        for (const s of stmts) log.push({ sql: String(s.sql).replace(/\s+/g, " ").trim(), args: s.args || [] });
        if (throwOn.some((f) => stmts.some((s) => String(s.sql).includes(f)))) return Promise.reject(new Error("connection reset"));
      }
      return Promise.resolve([]);
    },
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

beforeEach(() => { log = []; batches = []; selects = []; throwOn = []; });

const MOVING = "SELECT id, visitor_id, name FROM challenge_results WHERE visitor_id=?";
const moving = (rows) => selects.push({ match: MOVING, rows });
const auditRow = (row) => selects.push({ match: "SELECT id, snapshot, undone_at FROM merge_audit", rows: row ? [row] : [] });
const stmts = (frag) => log.filter((e) => e.sql.includes(frag));
const only = (frag) => { const m = stmts(frag); assert.equal(m.length, 1, `expected exactly one ${frag}, got ${m.length}`); return m[0]; };

describe("server/stats.js — mergeVisitors", () => {
  test("the schema keeps a per-merge snapshot of the rows it moved", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "server", "stats.js"), "utf8");
    assert.match(src, /CREATE TABLE IF NOT EXISTS merge_audit/);
    assert.match(src, /snapshot TEXT/);
    assert.match(src, /undone_at INTEGER/);
  });

  test("it reassigns the folded-in visitor's rows to the kept visitor", async () => {
    moving([{ id: 1, visitor_id: "v-b", name: "diddy kong" }, { id: 2, visitor_id: "v-b", name: "diddy kong" }]);
    const out = await analytics.mergeVisitors({ keep: "v-a", from: "v-b" });
    assert.equal(out.ok, true);
    const upd = only("UPDATE challenge_results SET visitor_id=?");
    assert.match(upd.sql, /WHERE visitor_id=\?$/);
    assert.deepEqual(upd.args, ["v-a", "v-b"]);
  });

  test("only the folded-in side is touched — the kept visitor's own rows are never rewritten", async () => {
    moving([{ id: 1, visitor_id: "v-b", name: "x" }]);
    await analytics.mergeVisitors({ keep: "v-a", from: "v-b" });
    // Both the snapshot read and the update must be keyed on the SOURCE. Getting this backwards
    // would move the kept player's entries onto the one being folded away.
    assert.deepEqual(only(MOVING).args, ["v-b"]);
    assert.equal(only("UPDATE challenge_results SET visitor_id=?").args[1], "v-b");
  });

  test("a name, when given, is applied to the moved rows in the same statement", async () => {
    moving([{ id: 1, visitor_id: "v-b", name: "diddy kong" }]);
    const out = await analytics.mergeVisitors({ keep: "v-a", from: "v-b", name: "jayden" });
    const upd = only("UPDATE challenge_results SET visitor_id=?, name=?");
    assert.deepEqual(upd.args, ["v-a", "jayden", "v-b"]);
    assert.equal(out.renamed, "jayden");
  });

  test("no name means the names they already have are left alone", async () => {
    for (const name of [null, undefined, "", "   "]) {
      log = []; selects = [];
      moving([{ id: 1, visitor_id: "v-b", name: "diddy kong" }]);
      const out = await analytics.mergeVisitors({ keep: "v-a", from: "v-b", name });
      assert.equal(out.renamed, null, JSON.stringify(name));
      assert.equal(stmts("SET visitor_id=?, name=?").length, 0, "must not rewrite the name");
      assert.equal(stmts("SET visitor_id=? WHERE").length, 1);
    }
  });

  test("the snapshot is read before the update, and records each row's original owner and name", async () => {
    moving([{ id: 7, visitor_id: "v-b", name: "diddy kong" }, { id: 9, visitor_id: "v-b", name: "doodooblud" }]);
    await analytics.mergeVisitors({ keep: "v-a", from: "v-b", name: "jayden" });
    const iRead = log.findIndex((e) => e.sql.startsWith("SELECT id, visitor_id, name FROM challenge_results"));
    const iUpd = log.findIndex((e) => e.sql.startsWith("UPDATE challenge_results SET visitor_id"));
    assert.ok(iRead >= 0 && iUpd > iRead, "the snapshot read must precede the update");
    const snap = JSON.parse(only("INSERT INTO merge_audit").args[4]);
    assert.deepEqual(snap, [{ i: 7, v: "v-b", n: "diddy kong" }, { i: 9, v: "v-b", n: "doodooblud" }]);
  });

  test("the audit row records both sides, the count and any rename", async () => {
    moving([{ id: 1, visitor_id: "v-b", name: "x" }]);
    selects.push({ match: "UPDATE challenge_results SET visitor_id=?, name=?", rowsAffected: 4 });
    const out = await analytics.mergeVisitors({ keep: "v-a", from: "v-b", name: "jayden", by: "admin" });
    const a = only("INSERT INTO merge_audit");
    assert.equal(a.args[1], "v-a", "keep_visitor");
    assert.equal(a.args[2], "v-b", "from_visitor");
    assert.equal(a.args[3], 4, "rows");
    assert.equal(a.args[5], "jayden", "renamed");
    assert.equal(a.args[6], "admin", "by_who");
    assert.equal(out.rows, 4);
  });

  test("merging a player into themselves is refused, not quietly turned into a bulk rename", async () => {
    // With a name supplied, `keep === from` would be UPDATE ... SET name=? WHERE visitor_id=? —
    // a rename, recorded in the merge history as if two players had been combined.
    for (const [keep, from] of [["v-a", "v-a"], ["  v-a  ", "v-a"], ["v-a", " v-a "]]) {
      log = [];
      const out = await analytics.mergeVisitors({ keep, from, name: "jayden" });
      assert.equal(out.ok, false, `${keep} / ${from}`);
      assert.equal(out.reason, "same");
      assert.equal(log.length, 0, "nothing should be read or written");
    }
  });

  test("a missing side is refused before anything is read", async () => {
    for (const args of [{ keep: "", from: "v-b" }, { keep: "v-a", from: "" }, {}, { keep: null, from: null }, { keep: "  ", from: "v-b" }]) {
      log = [];
      const out = await analytics.mergeVisitors(args);
      assert.equal(out.ok, false, JSON.stringify(args));
      assert.equal(out.reason, "missing");
      assert.equal(log.length, 0);
    }
  });

  test("a source with no entries is refused rather than recorded as an empty merge", async () => {
    const out = await analytics.mergeVisitors({ keep: "v-a", from: "v-b" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "nothing-to-merge");
    assert.equal(stmts("UPDATE challenge_results").length, 0);
    assert.equal(stmts("INSERT INTO merge_audit").length, 0);
  });

  test("an implausibly large source is refused rather than writing an unbounded snapshot", async () => {
    moving(Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, visitor_id: "v-b", name: "x" })));
    const out = await analytics.mergeVisitors({ keep: "v-a", from: "v-b" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "too-many");
    assert.equal(out.found, 2001);
    assert.equal(stmts("UPDATE challenge_results").length, 0, "and nothing is moved");
  });

  test("a failed update writes no audit row claiming the merge happened", async () => {
    moving([{ id: 1, visitor_id: "v-b", name: "x" }]);
    throwOn = ["UPDATE challenge_results SET visitor_id"];
    const out = await analytics.mergeVisitors({ keep: "v-a", from: "v-b" });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "write-failed");
    assert.equal(stmts("INSERT INTO merge_audit").length, 0);
  });

  test("a failed audit write doesn't hide the merge that did land", async () => {
    // Worse than a missing history row would be reporting failure for rows that really did move:
    // the owner would merge again.
    moving([{ id: 1, visitor_id: "v-b", name: "x" }]);
    throwOn = ["INSERT INTO merge_audit"];
    const out = await analytics.mergeVisitors({ keep: "v-a", from: "v-b" });
    assert.equal(out.ok, true);
    assert.equal(stmts("UPDATE challenge_results SET visitor_id").length, 1);
  });
});

describe("server/stats.js — undoMerge", () => {
  const snapOf = (rows) => JSON.stringify(rows);

  test("every row in the snapshot goes back to the visitor and name it had", async () => {
    auditRow({ id: 3, snapshot: snapOf([{ i: 7, v: "v-b", n: "diddy kong" }, { i: 9, v: "v-b", n: "doodooblud" }]), undone_at: null });
    const out = await analytics.undoMerge(3);
    assert.equal(out.ok, true);
    assert.equal(out.rows, 2);
    assert.equal(batches.length, 1, "restored in one batch");
    assert.deepEqual(batches[0].map((s) => s.args), [["v-b", "diddy kong", 7], ["v-b", "doodooblud", 9]]);
    for (const s of batches[0]) assert.match(s.sql, /UPDATE challenge_results SET visitor_id=\?, name=\? WHERE id=\?/);
  });

  test("the merge is marked undone only after the restore actually landed", async () => {
    auditRow({ id: 3, snapshot: snapOf([{ i: 7, v: "v-b", n: "x" }]), undone_at: null });
    await analytics.undoMerge(3, "admin");
    const iRestore = log.findIndex((e) => e.sql.startsWith("UPDATE challenge_results SET visitor_id=?, name=? WHERE id=?"));
    const iMark = log.findIndex((e) => e.sql.startsWith("UPDATE merge_audit SET undone_at=?"));
    assert.ok(iRestore >= 0 && iMark > iRestore, "marking it undone first would hide the only record able to fix it");
  });

  test("a failed restore leaves the merge NOT marked undone, so it can be retried", async () => {
    auditRow({ id: 3, snapshot: snapOf([{ i: 7, v: "v-b", n: "x" }]), undone_at: null });
    throwOn = ["UPDATE challenge_results SET visitor_id=?, name=? WHERE id=?"];
    const out = await analytics.undoMerge(3);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "write-failed");
    assert.equal(stmts("UPDATE merge_audit SET undone_at").length, 0);
  });

  test("undoing twice is refused rather than restoring stale rows over newer ones", async () => {
    // The rows may have been merged again since. Replaying an old snapshot would undo that too.
    auditRow({ id: 3, snapshot: snapOf([{ i: 7, v: "v-b", n: "x" }]), undone_at: 123456 });
    const out = await analytics.undoMerge(3);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "already-undone");
    assert.equal(batches.length, 0);
  });

  test("an unknown merge id restores nothing", async () => {
    const out = await analytics.undoMerge(999);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not-found");
    assert.equal(batches.length, 0);
  });

  test("a missing id is refused before anything is read", async () => {
    for (const id of [undefined, null, 0, "", "abc"]) {
      log = [];
      const out = await analytics.undoMerge(id);
      assert.equal(out.ok, false, String(id));
      assert.equal(out.reason, "missing");
      assert.equal(log.length, 0);
    }
  });

  test("an unreadable or empty snapshot is reported, not silently treated as success", async () => {
    for (const snapshot of ["", "[]", "not json", null, '{"not":"an array"}']) {
      log = []; batches = []; selects = [];
      auditRow({ id: 3, snapshot, undone_at: null });
      const out = await analytics.undoMerge(3);
      assert.equal(out.ok, false, JSON.stringify(snapshot));
      assert.equal(out.reason, "no-snapshot");
      assert.equal(batches.length, 0);
    }
  });
});

describe("server/stats.js — the merge picker's visitor list", () => {
  test("it groups leaderboard entries by visitor, busiest first", async () => {
    await analytics.resultVisitors(200);
    const s = only("FROM challenge_results WHERE visitor_id IS NOT NULL");
    assert.match(s.sql, /GROUP BY visitor_id/);
    assert.match(s.sql, /ORDER BY entries DESC, last_at DESC/);
    // Names, count, best and dates are what tell two visitors apart in a dropdown.
    for (const f of ["GROUP_CONCAT(DISTINCT name) names", "COUNT(*) entries", "MAX(total) best", "MAX(at) last_at", "MAX(crown) crown"]) {
      assert.ok(s.sql.includes(f), `missing ${f}`);
    }
  });

  test("rows with no visitor_id are left out — they are not a mergeable identity", async () => {
    await analytics.resultVisitors(200);
    assert.match(only("FROM challenge_results WHERE visitor_id IS NOT NULL").sql, /visitor_id IS NOT NULL AND visitor_id <> ''/);
  });

  test("the limit is clamped", async () => {
    for (const [asked, want] of [[200, 200], [0, 200], [-1, 1], [99999, 1000], ["abc", 200], [undefined, 200]]) {
      log = [];
      await analytics.resultVisitors(asked);
      assert.equal(only("FROM challenge_results WHERE visitor_id IS NOT NULL").args[0], want, `limit ${asked}`);
    }
  });

  test("mergeAuditList reads newest first and carries what an undo needs", async () => {
    await analytics.mergeAuditList(25);
    const s = only("FROM merge_audit ORDER BY");
    assert.match(s.sql, /ORDER BY id DESC LIMIT \?/);
    for (const f of ["id", "keep_visitor", "from_visitor", "rows", "undone_at"]) assert.ok(s.sql.includes(f), `missing ${f}`);
  });
});

describe("server/stats.js — merging with persistence off", () => {
  test("every merge entry point no-ops rather than throwing", async () => {
    const saved = require.cache[STATS];
    delete require.cache[STATS];
    const prevUrl = process.env.TURSO_URL;
    delete process.env.TURSO_URL;
    const realL = console.log; console.log = () => {};
    try {
      const off = require(STATS);
      assert.deepEqual(await off.mergeVisitors({ keep: "v-a", from: "v-b" }), { ok: false, rows: 0, reason: "off" });
      assert.deepEqual(await off.undoMerge(1), { ok: false, rows: 0, reason: "off" });
      assert.deepEqual(await off.resultVisitors(10), []);
      assert.deepEqual(await off.mergeAuditList(10), []);
    } finally {
      console.log = realL;
      if (prevUrl) process.env.TURSO_URL = prevUrl;
      delete require.cache[STATS];
      require.cache[STATS] = saved;
    }
  });
});
